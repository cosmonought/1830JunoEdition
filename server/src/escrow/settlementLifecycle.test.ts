// server/src/escrow/settlementLifecycle.test.ts
//
// ==================================================================
//  ESCROW-3A (brief §4-§8, §15): THE MONEY-GAME LIFECYCLE -- SEALED PREFIX, DURABLE INTENT, CRASH-SAFE DISCOVERY,
//  ABANDONMENT POLICY, CONTINUATION COMPATIBILITY
// ==================================================================
//
// Money games are disabled, so every financial path here runs through a financial predicate the test supplies (the
// production predicate is `record.money !== null`, false for every record). A whole game played to GameEnd is not a
// fixture, so the room host is told a game ended by LIVE-3C's own test seam (`faults.boardEnded`), and the evidence
// replay grafts the terminal fields onto the REAL replayed board (as SET-0A grafted its terminal cases) -- everything
// else is the production path: the host's seal, the at-least-once seam, the sealed prefix, the certified appraiser,
// the file stores.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore, type LogStore } from "../fileLogStore";
import type { GameServerOptions } from "../gameServer";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import { createFileHoldStore } from "../rooms/holdStore";
import { createFileRecordStore } from "../rooms/recordStore";
import { sealedPrefix, sealOf, SealedPrefixError, type TerminalSeal } from "../rooms/lifecycle";
import { ALICE, BOB, BUILD, BUY, Client, openGame, probeSession, quietConsole, startServer, stopServer, storedLog } from "../rooms/testSupport";
import { logHash } from "../../../frontend/src/gameEngine/logHash";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import type { RoomSession, ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { createFileFinancialGameStore, createMemoryFinancialGameStore, type FinancialGameStore } from "./financialGameStore";
import {
  currentMoneyContinuation,
  moneyContinuationVerdict,
  THIS_DEPLOYMENT,
  type MoneyContinuationIdentity,
  type MoneyIndexEntry,
} from "./moneyContinuation";
import { isFinancialGameRecord, missingRecordPlaceholder, moneyActionPolicy, newFinancialRecord, POST_DEAL_REFUSAL, transitionFinancial, type FinancialDeploymentPin, type FinancialGameRecord } from "./moneyLifecycle";
import { createSettlementCoordinator, type SettlementCoordinator } from "./settlementCoordinator";
import { prepareTerminalEvidence, serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
/* LIVE-4 (L4-2): the canonical continuation wiring the room host gives every session. */
import { createContinuationWiring } from "../continuationWiring";
import { createMoneyServing, type MoneyServing } from "./moneyServing";
import { thisDeploymentCapability } from "../deploymentCapability";
import { MONEY_TABLE_FORMAT, type GameRecord } from "../rooms/gameRecord";
import { PIN } from "./escrow3bSupport";

quietConsole();

const T0 = 1_760_000_000_000;
const quiet = { warn: () => undefined };

/* ---------------------------------------------------------------------------
    Fixtures
   --------------------------------------------------------------------------- */

/** A real stored game (the deal and `buys` purchases), then `closes` CloseRoom markers after it. */
function history(buys: number, closes = 0): ServerLogEntry[] {
  const entries = storedLog(buys);
  const out = [...entries];
  for (let n = 0; n < closes; n += 1) {
    const last = out[out.length - 1];
    out.push({ ...last, index: last.index + 1, id: `close-${n}`, actor: ALICE, payload: JSON.stringify({ CloseRoom: {} }), at: (last.at ?? 0) + 1 } as ServerLogEntry);
  }
  return out;
}

/** The server's replay of the sealed prefix, with the terminal fields grafted on (a stored game that truly reaches
 *  GameEnd needs a whole game played): the board is the real replayed one in every other field. */
const graftedReplay =
  (graft: Partial<GameStateResponse> & Record<string, unknown> = {}): PrefixReplay =>
  (prefix) => {
    const real = serverPrefixReplay(BUILD)(prefix);
    if (!real.ok) return real;
    return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true, ...graft } as GameStateResponse };
  };

const sealAt = (entries: readonly ServerLogEntry[]): TerminalSeal => sealOf(entries, true) as TerminalSeal;

/** LIVE-4 (L4-4): every money game is pinned to its escrow deployment (ESCROW-3B's fixture pin), and the coordinator
 *  serves that deployment -- step -1 continues exactly these games. (L4-2's tests name another pin, or none, explicitly.) */
function inProgress(gameId: string, continuation: MoneyContinuationIdentity = currentMoneyContinuation(), deployment: FinancialDeploymentPin | null = PIN): FinancialGameRecord {
  const created = newFinancialRecord(gameId, continuation, T0, deployment);
  const dealt = transitionFinancial(created, { kind: "dealt", at: T0 + 1 });
  assert.equal(dealt.kind, "moved");
  return (dealt as { next: FinancialGameRecord }).next;
}

async function seedFinancial(store: FinancialGameStore, record: FinancialGameRecord): Promise<void> {
  const created = newFinancialRecord(record.game_id, record.continuation, record.created_at, record.binding?.deployment ?? null);
  assert.equal((await store.create(created)).outcome.kind, "committed");
  if (record.record_version > 1) assert.equal((await store.put(record, 1)).kind, "committed");
}

const GAME = "g_0000000000000000000000000w";
/** A money GameRecord's terms name the deployment its money is in (ESCROW-4): who owns a game whose financial record
 *  is missing (L4-4). */
const TERMS = { format: MONEY_TABLE_FORMAT, backend: PIN.backend, chain_id: PIN.chain_id, network_class: PIN.network_class, contract_address: PIN.contract_address, code_checksum: PIN.code_checksum, denom: PIN.denom, symbol: "JUNOX", exponent: 6, ante_gross: "1010000", mode: "live" };
const recordOf = (gameId: string, startedAt: number | null = T0 + 1) => ({ game_id: gameId, money: TERMS, started_at: startedAt }) as never;
const serving = (): MoneyServing => createMoneyServing({ capability: thisDeploymentCapability([PIN]) });

function coordinatorOver(store: FinancialGameStore, replay: PrefixReplay = graftedReplay(), financial = new Set([GAME])): SettlementCoordinator {
  return createSettlementCoordinator({
    store,
    replay,
    isFinancial: (record) => financial.has(record.game_id),
    now: () => T0 + 10_000,
    warn: () => undefined,
    schedule: () => ({ cancel: () => undefined }), // the test drains by hand
    serving: serving(),
  });
}

const announce = (c: SettlementCoordinator, entries: readonly ServerLogEntry[], recovered = false, gameId = GAME) =>
  c.onGameplayClosed({ gameId, record: recordOf(gameId), seal: sealAt(entries), recovered, entries });

/* ================================================================================================= */
/* 1. The sealed prefix                                                                              */
/* ================================================================================================= */

describe("ESCROW-3A §5: the sealed prefix is exactly log[0 .. seal.log_len)", () => {
  test("trailing CloseRoom markers are excluded; the prefix is a frozen copy; the seal is re-derived", () => {
    const entries = history(3, 4);
    const seal = sealAt(entries);
    assert.equal(seal.log_len, 4, "the deal and three purchases");
    const sealed = sealedPrefix(entries, seal);
    assert.equal(sealed.prefix.length, 4);
    assert.equal(sealed.trailingCloseRooms, 4);
    assert.ok(Object.isFrozen(sealed.prefix) && Object.isFrozen(sealed.prefix[0]));
    assert.deepEqual(sealed.prefix.map((e) => e.index), [0, 1, 2, 3]);
    assert.equal(logHash(sealed.prefix), logHash(entries, 4));
    assert.notEqual(logHash(entries), logHash(entries, 4), "the whole log's hash moved with the markers; the prefix's did not");
  });

  test("refusals: a seal that is not this history's, gameplay after the seal, a gap, an out-of-range seal", () => {
    const entries = history(3, 1);
    const seal = sealAt(entries);
    const code = (run: () => unknown) => {
      try {
        run();
        return "OK";
      } catch (error) {
        assert.ok(error instanceof SealedPrefixError);
        return (error as SealedPrefixError).code;
      }
    };
    assert.equal(code(() => sealedPrefix(entries, { ...seal, log_len: 3 })), "post-seal-gameplay");
    assert.equal(code(() => sealedPrefix(entries.slice(0, 4), { ...seal, log_len: 4 })), "OK");
    assert.equal(code(() => sealedPrefix(entries, { ...seal, log_len: 99 })), "seal-out-of-range");
    assert.equal(code(() => sealedPrefix(entries, { ...seal, log_len: 0 })), "seal-out-of-range");
    const gap = [...entries.slice(0, 2), { ...entries[3], index: 5 }];
    assert.equal(code(() => sealedPrefix(gap, { log_len: 3, at: 0 })), "not-contiguous");
    const moveAfter = [...entries, { ...entries[1], index: entries.length, id: "late-move" }];
    assert.equal(code(() => sealedPrefix(moveAfter, seal)), "post-seal-gameplay", "a move after the seal");
    /* A seal that swallows a CloseRoom: everything after it is a marker, but the history is sealed earlier. */
    const twoCloses = history(3, 2);
    assert.equal(code(() => sealedPrefix(twoCloses, { log_len: 5, at: 0 })), "seal-mismatch");
  });
});

/* ================================================================================================= */
/* 2. The evidence                                                                                   */
/* ================================================================================================= */

describe("ESCROW-3A §5: terminal evidence is derived from the sealed prefix alone", () => {
  test("one CloseRoom or ten change nothing: log_hash, appraisal_state_hash, totals, pin", () => {
    const bare = history(3, 0);
    const outcomes = [0, 1, 10].map((closes) => prepareTerminalEvidence({ gameId: GAME, entries: history(3, closes), seal: sealAt(bare), replay: graftedReplay() }));
    for (const outcome of outcomes) assert.equal(outcome.ok, true);
    const [a, b, c] = outcomes.map((o) => (o as { evidence: unknown }).evidence);
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
    const evidence = a as { log_len: number; log_hash: string; appraisal_log_len: number; rules_engine_version: number; terminal_reason: string; players: string[]; totals: Record<string, string> };
    assert.equal(evidence.log_hash, logHash(bare));
    assert.equal(evidence.appraisal_log_len, evidence.log_len);
    assert.equal(evidence.rules_engine_version, RULES_ENGINE_VERSION);
    assert.equal(evidence.terminal_reason, "BankBroken");
    assert.deepEqual(Object.keys(evidence.totals).sort(), [ALICE, BOB].sort());
    assert.ok(!JSON.stringify(evidence).match(/pr_|pf_|se_|sf_/), "no identity id in the evidence");
  });

  test("v10, v11, v12 and v13 pins all settle (certified; 12 since Route v12 R12-3, 13 since the v13 certification); the next engine is held rules-not-certified; a board that is not terminal, or that the appraiser refuses, is held", () => {
    const entries = history(3);
    const seal = sealAt(entries);
    for (const pin of [10, 11, 12, 13]) assert.equal(prepareTerminalEvidence({ gameId: GAME, entries, seal, replay: graftedReplay({ rules_engine_version: pin }) }).ok, true, `pin ${pin}`);
    const next = prepareTerminalEvidence({ gameId: GAME, entries, seal, replay: graftedReplay({ rules_engine_version: RULES_ENGINE_VERSION + 1 }) });
    assert.deepEqual([next.ok, (next as { code: string }).code], [false, "rules-not-certified"]);
    const notEnded = prepareTerminalEvidence({ gameId: GAME, entries, seal, replay: graftedReplay({ current_round_type: "StockRound" } as never) });
    assert.equal((notEnded as { code: string }).code, "board-not-terminal");
    const noReason = prepareTerminalEvidence({ gameId: GAME, entries, seal, replay: graftedReplay({ bank_broken: false } as never) });
    assert.equal((noReason as { code: string }).code, "board-not-terminal");
    const corrupt = prepareTerminalEvidence({ gameId: GAME, entries, seal, replay: (prefix) => {
      const real = graftedReplay()(prefix) as { ok: true; board: GameStateResponse };
      return { ok: true, board: { ...real.board, player_cash: real.board.player_cash.map((row, at) => (at === 0 ? { ...row, cash_vgp: "-5" } : row)) } as GameStateResponse };
    } });
    assert.equal((corrupt as { code: string }).code, "appraisal-refused");
    const bankrupt = prepareTerminalEvidence({ gameId: GAME, entries, seal, replay: graftedReplay({ bank_broken: false, bankrupt_president: BOB } as never) });
    assert.equal((bankrupt as { evidence: { terminal_reason: string } }).evidence.terminal_reason, "Bankruptcy");
    const unreplayable = prepareTerminalEvidence({ gameId: GAME, entries, seal, replay: () => ({ ok: false, reason: "a payload the engine cannot apply" }) });
    assert.equal((unreplayable as { code: string }).code, "replay-failed");
  });
});

/* ================================================================================================= */
/* 3. The transition table and the policy                                                           */
/* ================================================================================================= */

describe("ESCROW-3A §7: the lifecycle table -- no post-deal refund, no abandon, one terminal history per game", () => {
  test("pre-deal: cancel refunds by the contract's rules; post-deal: cancel, abandon, timeout refund and seat transfer are refused", () => {
    const funding = newFinancialRecord(GAME, currentMoneyContinuation(), T0);
    assert.equal(transitionFinancial(funding, { kind: "cancel-before-deal", at: T0 + 1 }).kind, "moved");
    const dealt = inProgress(GAME);
    for (const kind of ["cancel-before-deal", "host-abandon", "timeout-refund", "seat-transfer"] as const) {
      assert.deepEqual(transitionFinancial(dealt, { kind, at: T0 + 2 }), { kind: "refused", reason: POST_DEAL_REFUSAL }, kind);
    }
    assert.equal(moneyActionPolicy("in-progress", "server-refund").allowed, false);
    assert.equal(moneyActionPolicy("liveness", "host-cancel").allowed, false);
    assert.equal(moneyActionPolicy("funding", "seat-withdraw").allowed, true);
    assert.equal(moneyActionPolicy("in-progress", "seat-withdraw").allowed, false);
    assert.match(moneyActionPolicy("in-progress", "leave-table").means, /unsubscribe only/);
    assert.match(moneyActionPolicy("liveness", "liveness-settle").means, /best trusted checkpoint/);
    assert.equal(moneyActionPolicy("held", "seat-transfer").allowed, false);
  });

  test("a quiet game becomes `liveness` -- a state, not a refund -- and resumes on activity; the seal is recorded once and repeats are `same`", () => {
    const dealt = inProgress(GAME);
    assert.equal(transitionFinancial(dealt, { kind: "inactivity-check", at: T0 + 1000 }).kind, "same");
    const quiet = transitionFinancial(dealt, { kind: "inactivity-check", at: T0 + 25 * 3600_000 });
    assert.equal(quiet.kind, "moved");
    const liveness = (quiet as { next: FinancialGameRecord }).next;
    assert.equal(liveness.phase, "liveness");
    assert.equal((transitionFinancial(liveness, { kind: "activity", at: T0 + 26 * 3600_000 }) as { next: FinancialGameRecord }).next.phase, "in-progress");
    const sealed = (transitionFinancial(liveness, { kind: "sealed", at: T0 + 27 * 3600_000, log_len: 9, sealed_at: T0 }) as { next: FinancialGameRecord }).next;
    assert.deepEqual([sealed.phase, sealed.terminal?.log_len], ["terminal-eligible", 9]);
    assert.equal(transitionFinancial(sealed, { kind: "sealed", at: T0 + 1, log_len: 9, sealed_at: T0 }).kind, "same");
    const conflict = (transitionFinancial(sealed, { kind: "sealed", at: T0 + 2, log_len: 10, sealed_at: T0 }) as { next: FinancialGameRecord }).next;
    assert.deepEqual([conflict.phase, conflict.hold?.code, conflict.hold?.from], ["held", "seal-conflict", "terminal-eligible"]);
    assert.equal(transitionFinancial(conflict, { kind: "hold", at: T0 + 3, code: "replay-failed", detail: "x" }).kind, "same", "the first hold stands");
    const released = transitionFinancial(conflict, { kind: "operator-release", at: T0 + 4, note: "verified" });
    assert.equal((released as { next: FinancialGameRecord }).next.phase, "terminal-eligible");
    assert.equal(transitionFinancial(conflict, { kind: "operator-release", at: T0 + 4, note: "  " }).kind, "refused");
  });
});

/* ================================================================================================= */
/* 4. The coordinator: idempotent, retried, crash-safe                                               */
/* ================================================================================================= */

describe("ESCROW-3A §4, §6: the settlement coordinator converges on one durable intent per (gameId, seal.log_len)", () => {
  test("the seam announced 2x and 10x (both flavours): one sealed transition, one prepared intent, nothing duplicated", async () => {
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, inProgress(GAME));
    const c = coordinatorOver(store);
    const entries = history(3, 2);
    for (let n = 0; n < 10; n += 1) announce(c, entries, n % 2 === 1);
    assert.equal(c.pending(), 1, "ten announcements of one terminal history are one job");
    await c.drain();
    const record = (await store.load(GAME))!;
    assert.equal(record.phase, "intent-prepared");
    assert.equal(record.terminal?.log_len, 4);
    assert.equal(record.intent?.log_hash, logHash(entries, 4));
    const version = record.record_version;
    for (let n = 0; n < 10; n += 1) announce(c, entries, true);
    await c.drain();
    assert.equal((await store.load(GAME))!.record_version, version, "a repeat writes nothing");
    assert.deepEqual([c.stats.sealed, c.stats.prepared], [1, 1]);
  });

  test("trailing CloseRoom markers: announcing the history with 0, 1 or 10 of them converges on one intent with one log hash", async () => {
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, inProgress(GAME));
    const c = coordinatorOver(store);
    for (const closes of [0, 1, 10]) {
      announce(c, history(3, closes), closes > 0);
      await c.drain();
    }
    const record = (await store.load(GAME))!;
    assert.deepEqual([record.phase, record.intent?.log_hash, record.intent?.log_len], ["intent-prepared", logHash(history(3)), 4]);
    assert.equal(c.stats.prepared, 1);
  });

  test("a failed store write is retried from the durable record, and a throwing replay too", async () => {
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, inProgress(GAME));
    let throws = 1;
    const c = coordinatorOver(store, (prefix) => {
      if (throws-- > 0) throw new Error("a transient fault inside the replay");
      return graftedReplay()(prefix);
    });
    store.failNext.push("definite");
    announce(c, history(3));
    await c.drain();
    assert.equal((await store.load(GAME))!.phase, "in-progress", "the definite failure wrote nothing");
    assert.equal(c.pending(), 1);
    await c.drain(); // sealed; the replay throws: retried
    assert.equal((await store.load(GAME))!.phase, "terminal-eligible");
    await c.drain();
    assert.equal((await store.load(GAME))!.phase, "intent-prepared");
    assert.equal(c.pending(), 0);
    assert.ok(c.stats.retries >= 2);
  });

  test("the same gameId sealed at another log_len HOLDS (two histories), and the held record keeps the first", async () => {
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, inProgress(GAME));
    const c = coordinatorOver(store);
    announce(c, history(3));
    await c.drain();
    announce(c, history(5));
    await c.drain();
    const record = (await store.load(GAME))!;
    assert.deepEqual([record.phase, record.hold?.code, record.terminal?.log_len, record.intent?.log_len], ["held", "seal-conflict", 4, 4]);
  });

  test("a non-financial game writes nothing; a money game with no financial record is held for the operator, never guessed at", async () => {
    const store = createMemoryFinancialGameStore();
    const c = coordinatorOver(store, graftedReplay(), new Set(["g_1111111111111111111111111w"]));
    announce(c, history(3)); // GAME is not financial here
    await c.drain();
    assert.equal(store.records.size, 0);
    announce(c, history(3), false, "g_1111111111111111111111111w");
    await c.drain();
    const missing = (await store.load("g_1111111111111111111111111w"))!;
    assert.deepEqual([missing.phase, missing.hold?.code], ["held", "financial-record-missing"]);
  });

  test("review #1: a missing record's placeholder is written ONCE, already held, with NO continuation -- nothing continues on it and it is never released", async () => {
    const ID = "g_1111111111111111111111111w";
    const store = createMemoryFinancialGameStore();
    const c = coordinatorOver(store, graftedReplay(), new Set([ID]));
    announce(c, history(3), false, ID);
    await c.drain();
    const placeholder = (await store.load(ID))!;
    /* One create, ALREADY held (v1: there is no unheld version of it) -- by the OWNER only (L4-4: the GameRecord's money
       terms name the deployment this coordinator serves), and nothing more: the placeholder is the conflict's canonical
       hold, and step -1 continues nothing on it (so no seal is written onto it either). */
    assert.deepEqual(
      [placeholder.record_version, placeholder.phase, placeholder.continuation, placeholder.hold?.from, placeholder.terminal?.log_len],
      [1, "held", null, "in-progress", undefined],
    );
    assert.deepEqual(placeholder.transitions.map((line) => line.to), ["held"], "never funding, never unheld");
    assert.ok(isFinancialGameRecord(placeholder));
    assert.equal(isFinancialGameRecord({ ...placeholder, hold: { ...placeholder.hold, code: "replay-failed" } }), false, "no continuation is readable only on the placeholder");
    assert.equal(c.continuationOf(ID), undefined);
    /* LIVE-4 (L4-2): the index says what it is -- the held placeholder -- and the canonical verdict never continues a
       game on its account (ESCROW-3A's build-keyed policy, which said "no" only across builds, is retired). */
    assert.deepEqual(c.factsOf(ID), { kind: "placeholder" }, "the index knows the placeholder as such: nothing continues on its account");
    assert.equal(transitionFinancial(placeholder, { kind: "operator-release", at: T0 + 5, note: "looks fine", dealt: true }).kind, "refused");
    announce(c, history(3), true, ID);
    await c.drain();
    assert.equal((await store.load(ID))!.record_version, placeholder.record_version, "a re-announced seal writes nothing");
    assert.equal((await store.load(ID))!.phase, "held");
    assert.equal(missingRecordPlaceholder(ID, T0, "x").phase, "held");
  });

  test("review #3: a record still at FUNDING whose game was dealt and sealed moves dealt -> sealed -> prepared (never a seal-conflict)", async () => {
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, newFinancialRecord(GAME, currentMoneyContinuation(), T0, PIN));
    const c = coordinatorOver(store);
    announce(c, history(3));
    await c.drain();
    const record = (await store.load(GAME))!;
    assert.equal(record.phase, "intent-prepared");
    assert.deepEqual(record.transitions.map((line) => line.to), ["in-progress", "terminal-eligible", "intent-prepared"]);
    assert.equal(record.transitions[0].at, T0 + 1, "the deal's time is the GameRecord's log-implied started_at");
  });

  test("review #3: the startup walk loads a FUNDING record's game, and the sweep derives the deal from the GameRecord", async () => {
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, newFinancialRecord(GAME, currentMoneyContinuation(), T0, PIN));
    const c = coordinatorOver(store);
    const loads: string[] = [];
    const report = await c.reconcileAtStartup({ financialGameIds: [], loadGame: async (id) => void loads.push(id) });
    assert.deepEqual([report.loaded, loads], [1, [GAME]]);
    await c.sweepLiveness([{ game_id: GAME, money: null, started_at: null, last_activity_at: T0 } as never]);
    assert.equal((await store.load(GAME))!.phase, "funding", "not dealt: nothing moves");
    await c.sweepLiveness([{ game_id: GAME, money: null, started_at: T0 + 7, last_activity_at: T0 + 9 } as never]);
    const dealt = (await store.load(GAME))!;
    assert.deepEqual([dealt.phase, dealt.last_activity_at], ["in-progress", T0 + 9]);
    assert.equal(moneyActionPolicy(dealt.phase, "host-cancel").allowed, false, "the post-deal refusals now apply");
  });

  test("review #2: a release after the seal was recorded resumes at terminal-eligible, so the intent IS prepared", async () => {
    const store = createMemoryFinancialGameStore();
    const c = coordinatorOver(store, graftedReplay());
    const held = (transitionFinancial(inProgress(GAME), { kind: "hold", at: T0 + 2, code: "sealed-prefix-refused", detail: "x" }) as { next: FinancialGameRecord }).next;
    const withSeal = (transitionFinancial(held, { kind: "sealed", at: T0 + 3, log_len: 4, sealed_at: T0 }) as { next: FinancialGameRecord }).next;
    assert.deepEqual([withSeal.phase, withSeal.terminal?.log_len], ["held", 4]);
    const released = (transitionFinancial(withSeal, { kind: "operator-release", at: T0 + 4, note: "the log was repaired", dealt: true }) as { next: FinancialGameRecord }).next;
    assert.equal(released.phase, "terminal-eligible");
    store.records.set(GAME, released);
    announce(c, history(3), true);
    await c.drain();
    assert.equal((await store.load(GAME))!.phase, "intent-prepared");
    /* A hold from funding, released after the GameRecord says the game was dealt: in-progress, never funding. */
    const fundingHold = (transitionFinancial(newFinancialRecord(GAME, currentMoneyContinuation(), T0), { kind: "hold", at: T0 + 1, code: "game-held", detail: "x" }) as { next: FinancialGameRecord }).next;
    assert.equal((transitionFinancial(fundingHold, { kind: "operator-release", at: T0 + 2, note: "ok", dealt: true }) as { next: FinancialGameRecord }).next.phase, "in-progress");
    assert.equal((transitionFinancial(fundingHold, { kind: "operator-release", at: T0 + 2, note: "ok", dealt: false }) as { next: FinancialGameRecord }).next.phase, "funding");
  });

  test("review #8: a new seal is not left behind a failing job's backoff -- the pass is brought forward", async () => {
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, inProgress(GAME));
    const scheduled: number[] = [];
    const runs: Array<() => void> = [];
    let cancelled = 0;
    const c = createSettlementCoordinator({
      store,
      replay: graftedReplay(),
      isFinancial: () => true,
      now: () => T0 + 10_000,
      warn: () => undefined,
      serving: serving(),
      retryMs: 60_000,
      schedule: (run, ms) => {
        scheduled.push(ms);
        runs.push(run);
        return { cancel: () => void (cancelled += 1) };
      },
    });
    store.failNext.push("definite");
    announce(c, history(3));
    runs[0](); // the kick(0) fires: the pass fails and schedules its 60 s retry
    await c.drain();
    assert.deepEqual(scheduled, [0, 60_000]);
    announce(c, history(3), false, "g_2222222222222222222222222w");
    assert.deepEqual(scheduled, [0, 60_000, 0], "the new seal asks for a pass now");
    assert.equal(cancelled, 1, "the later retry timer was replaced by the sooner pass");
    c.stop();
  });

  test("an uncertified board holds; an incompatible continuation is NOT CONTINUED (L4-4: nothing written); v10, v11, v12 and v13 boards all prepare", async () => {
    // Route v12 R12-3 certified 12 and Phase 3's dedicated v13 certification certified 13; the next engine is the uncertified pin now.
    const uncertified = RULES_ENGINE_VERSION + 1;
    for (const [pin, expected] of [[10, "intent-prepared"], [11, "intent-prepared"], [12, "intent-prepared"], [13, "intent-prepared"], [uncertified, "held"]] as const) {
      const store = createMemoryFinancialGameStore();
      await seedFinancial(store, inProgress(GAME));
      const c = coordinatorOver(store, graftedReplay({ rules_engine_version: pin }));
      announce(c, history(3));
      await c.drain();
      const record = (await store.load(GAME))!;
      assert.equal(record.phase, expected, `pin ${pin}`);
      if (pin === uncertified) assert.equal(record.hold?.code, "rules-not-certified");
    }
    /* A money identity this pool does not continue (another hosted protocol): step -1 decides it BEFORE the seal is
       written, so nothing is -- no seal, no durable continuation-incompatible hold (F-L4-3); the pool that speaks
       hosted protocol 99 seals it. */
    const store = createMemoryFinancialGameStore();
    await seedFinancial(store, inProgress(GAME, { ...currentMoneyContinuation(), hosted_protocol: 99 }));
    const before = JSON.stringify(await store.load(GAME));
    const writes = store.writes.count;
    const c = coordinatorOver(store);
    announce(c, history(3));
    await c.drain();
    assert.equal(JSON.stringify(await store.load(GAME)), before);
    assert.equal(store.writes.count, writes, "no write at all");
    assert.equal(c.pending(), 0, "the job is not this pool's: dropped, not retried");
  });

  test("restart: crash after GameEnd before the intent, and crash after the intent -- the startup walk converges on one intent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-restart-"));
    try {
      const entries = history(3, 1);
      /* Crash after GameEnd, before the intent: the financial record is still in-progress; nobody reopens the game. */
      await seedFinancial(createFileFinancialGameStore(dir, quiet), inProgress(GAME));
      const loads: string[] = [];
      const restart = () => coordinatorOver(createFileFinancialGameStore(dir, quiet));
      const first = restart();
      await first.load();
      const report = await first.reconcileAtStartup({
        financialGameIds: [GAME],
        /* The host's load: it reconciles the completed game and announces its seal again (recovered). */
        loadGame: async (gameId) => {
          loads.push(gameId);
          announce(first, entries, true, gameId);
        },
      });
      assert.deepEqual([report.financialGames, report.loaded, report.alreadyPrepared], [1, 1, 0]);
      const prepared = (await createFileFinancialGameStore(dir, quiet).load(GAME))!;
      assert.equal(prepared.phase, "intent-prepared");
      /* Crash after the intent was written (before anything answered): the next start finds it and loads nothing. */
      const second = restart();
      const again = await second.reconcileAtStartup({ financialGameIds: [GAME], loadGame: async (gameId) => void loads.push(gameId) });
      assert.deepEqual([again.loaded, again.alreadyPrepared], [0, 1]);
      assert.deepEqual(loads, [GAME], "the prepared game was not loaded again");
      /* ... and if its seal is announced anyway (a player opens it), nothing is written. */
      announce(second, entries, true);
      await second.drain();
      assert.equal((await createFileFinancialGameStore(dir, quiet).load(GAME))!.record_version, prepared.record_version);
      assert.equal(second.continuationOf(GAME)?.rules_engine_version, RULES_ENGINE_VERSION);
      assert.ok(fs.existsSync(path.join(dir, "games", "money", `${GAME}.json`)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================================================= */
/* 5. Through the real room host                                                                     */
/* ================================================================================================= */

describe("ESCROW-3A §6: through the room host -- a crash before the intent, a restart nobody reconnects to", () => {
  test("the game ends while no settlement code runs (a crash before the intent); a restart nobody reconnects to loads it, prepares the intent from the seal, and a later open writes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-host-"));
    try {
      const targets = new Map<string, number>();
      const financial = new Set<string>();
      const faults = { boardEnded: (gameId: string, session: RoomSession) => (targets.get(gameId) ?? Infinity) <= session.entries.length };
      const bootWith = async (coordinator: SettlementCoordinator | null) => {
        const store: LogStore = createFileLogStore(dir, quiet);
        const over: Partial<GameServerOptions> = {
          store,
          records: createFileRecordStore(dir, quiet),
          holds: createFileHoldStore(dir, quiet),
          ops: createMemoryOpsRecorder(),
          faults,
          /* LIVE-4 (L4-2): this pool serves the game's escrow (the fixture deployment), and -- with the coordinator --
             the settlement index supplies the game's money facts, which every rebuild of its session judges. */
          capability: thisDeploymentCapability([PIN]),
          ...(coordinator ? { settlement: coordinator, moneyFacts: coordinator } : {}),
        };
        const booted = await startServer(over);
        await booted.server.lifecycle.ready;
        return booted;
      };
      const makeCoordinator = () =>
        createSettlementCoordinator({
          store: createFileFinancialGameStore(dir, quiet),
          replay: (prefix) => graftedReplay()(prefix),
          isFinancial: (record) => financial.has(record.game_id),
          now: () => Date.now(),
          warn: () => undefined,
          serving: serving(),
        });
      /* Boot 1 WITHOUT the coordinator: the game completes while no settlement code runs -- the crash-before-intent. */
      let booted = await bootWith(null);
      const { gameId } = await openGame(booted.port, ALICE, [BOB]);
      financial.add(gameId);
      /* LIVE-4 (L4-2): a financial-protocol-3 record is bound to its deployment from creation (`createMoneyGame`); the
         canonical verdict reads one without a pin as malformed, so this record carries the fixture pin. */
      await seedFinancial(createFileFinancialGameStore(dir, quiet), inProgress(gameId, currentMoneyContinuation(), PIN));
      targets.set(gameId, 3);
      const alice = await Client.open(booted.port, ALICE);
      const bob = await Client.open(booted.port, BOB);
      alice.hello(gameId);
      bob.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      await bob.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy-1" });
      assert.equal((await alice.answerTo("buy-1")).kind, "applied");
      bob.submit(BUY, { baseIndex: 1, submissionId: "buy-2" });
      assert.equal((await bob.answerTo("buy-2")).kind, "applied");
      for (let tries = 0; tries < 400; tries += 1) {
        const record = JSON.parse(fs.readFileSync(path.join(dir, "games", `${gameId}.json`), "utf8")) as { status: string };
        if (record.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      /* (A CloseRoom after the seal needs a board the REDUCER has ended; this game ends by the test seam, so the
         trailing-marker case is pinned on real CloseRoom entries in §1/§2 and on the coordinator's own path in §4.) */
      await Promise.all([alice.close(), bob.close()]);
      await stopServer(booted.server);
      const logged = await createFileLogStore(dir, quiet).loadLog(gameId);
      assert.equal((await createFileFinancialGameStore(dir, quiet).load(gameId))!.phase, "in-progress", "nothing settled: the coordinator was not running");

      /* Boot 2 WITH the coordinator; NOBODY reconnects: the startup walk loads the money game itself. */
      const coordinator = makeCoordinator();
      await coordinator.load();
      booted = await bootWith(coordinator);
      try {
        const report = await coordinator.reconcileAtStartup({ financialGameIds: booted.server.lifecycle.financialGameIds(), loadGame: booted.server.lifecycle.loadGame });
        assert.equal(report.loaded, 1);
        for (let tries = 0; tries < 400 && (await createFileFinancialGameStore(dir, quiet).load(gameId))!.phase !== "intent-prepared"; tries += 1) {
          await coordinator.drain();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const record = (await createFileFinancialGameStore(dir, quiet).load(gameId))!;
        assert.equal(record.phase, "intent-prepared");
        const seal = sealOf(logged, true)!;
        assert.equal(record.terminal?.log_len, seal.log_len);
        assert.equal(record.intent?.log_hash, logHash(logged, seal.log_len), "the evidence hashes the sealed prefix");
        assert.equal(record.intent?.appraisal_log_len, seal.log_len);
        /* A player now opens the game: the seal is announced again; nothing is written. */
        const version = record.record_version;
        const back = await Client.open(booted.port, BOB);
        back.hello(gameId);
        await back.next((f) => f.kind === "catch-up");
        await back.close();
        await coordinator.drain();
        assert.equal((await createFileFinancialGameStore(dir, quiet).load(gameId))!.record_version, version);
      } finally {
        coordinator.stop();
        await stopServer(booted.server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================================================= */
/* 6. Money-game continuation compatibility                                                          */
/* ================================================================================================= */

describe("ESCROW-3A §8: a funded game continues across builds only under a compatible identity; everything else fails closed", () => {
  test("the verdict: equal identity continues; another rules pin, protocol or codec, a malformed identity, or an uncertified pin does not", () => {
    const current = currentMoneyContinuation();
    assert.deepEqual(moneyContinuationVerdict(current), { continues: true });
    assert.equal((moneyContinuationVerdict({ ...current, rules_engine_version: 10 }) as { why: string }).why, "rules-not-supported", "a v10 game on a v12 server: never reinterpreted");
    assert.equal((moneyContinuationVerdict({ ...current, rules_engine_version: 11 }) as { why: string }).why, "rules-not-supported", "a v11 game on a v12 server: never reinterpreted");
    assert.equal((moneyContinuationVerdict({ ...current, rules_engine_version: RULES_ENGINE_VERSION + 1 }) as { why: string }).why, "rules-not-supported", "a newer game on this server");
    assert.equal((moneyContinuationVerdict(current, { ...THIS_DEPLOYMENT, certifiedRules: [10] }) as { why: string }).why, "rules-not-certified");
    assert.equal((moneyContinuationVerdict({ ...current, hosted_protocol: 2 }) as { why: string }).why, "hosted-protocol");
    assert.equal((moneyContinuationVerdict({ ...current, financial_protocol: current.financial_protocol + 1 }) as { why: string }).why, "financial-protocol");
    assert.equal((moneyContinuationVerdict({ ...current, settlement_codec: "18GNO/v1" }) as { why: string }).why, "settlement-codec");
    assert.equal((moneyContinuationVerdict({ ...current, git: "abc" }) as { why: string }).why, "malformed");
    /* A NEWER server that silently reinterprets: it plays the next engine and settles it too, but the game's protocol is 1
       and its own is 2 -- refused. (Written with 12 before Route v12 R12-2 made 12 this build's own engine, then 13 until
       W3-K made 13 this build's own; read off the engine now.) */
    const newer = RULES_ENGINE_VERSION + 1;
    assert.equal((moneyContinuationVerdict(current, { ...THIS_DEPLOYMENT, supportedRules: [newer], certifiedRules: [10, 11, 12, 13, newer], hostedProtocol: 2 }) as { why: string }).why, "rules-not-supported");
  });

  /* LIVE-4 (L4-2): ESCROW-3A's build-keyed seam (`continuesDealtBuild` / `continuationPolicyOf`) was asked only for a
     game dealt on ANOTHER build. Its successor is the canonical verdict over the settlement index's money facts, asked
     at every rebuild on EVERY build -- the two tests below replace the two that pinned the old seam. */
  test("LIVE-4 (L4-2): the RoomSession judges a funded game's money facts on every build -- continued where its identity and escrow are served, not continued (derived, nothing appended) where they are not", () => {
    const ID = "g_1111111111111111111111111w";
    const current = currentMoneyContinuation();
    const OTHER_CONTRACT = "juno1qg5ega6dykkxc307y25pecuufrjkxkaggkkxh7nad0vhyhtuhw3sqaa3c5";
    const dealtOn = (build: string) =>
      storedLog(0).map((entry) => {
        const payload = JSON.parse(entry.payload) as { SetupGame?: Record<string, unknown> };
        return payload.SetupGame ? { ...entry, payload: JSON.stringify({ SetupGame: { ...payload.SetupGame, build } }) } : entry;
      });
    const cases: Array<[string, MoneyIndexEntry | undefined, string | null]> = [
      ["its identity and its escrow are this pool's", { kind: "record", mci: current, deployment: PIN }, null],
      ["another financial protocol", { kind: "record", mci: { ...current, financial_protocol: 7 }, deployment: PIN }, "financial-protocol"],
      ["its escrow is a contract this pool does not serve", { kind: "record", mci: current, deployment: { ...PIN, contract_address: OTHER_CONTRACT } }, "deployment-unavailable"],
      ["its money identity names a hosted protocol this pool does not read", { kind: "record", mci: { ...current, hosted_protocol: 2 }, deployment: PIN }, "hosted-protocol"],
      ["the held placeholder", { kind: "placeholder" }, "malformed"],
      ["no financial record at all", undefined, "conflict/financial-record-missing"],
    ];
    for (const build of [BUILD, "an-older-build"]) {
      for (const [label, facts, why] of cases) {
        const wiring = createContinuationWiring({
          capability: thisDeploymentCapability([PIN]),
          policy: { legacyLogs: "refuse" },
          moneyFacts: { factsOf: (gameId) => (gameId === ID ? facts : undefined), refresh: async () => undefined },
          recordOf: () => ({ money: { format: "money-terms" } }) as unknown as GameRecord,
          now: () => Date.now(),
        });
        const session = probeSession(`cont-${label}`, wiring.sessionFor(ID));
        session.restore(dealtOn(build));
        const answer = session.submit({ actor: ALICE, build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: `cont-${label}` });
        if (why === null) {
          assert.equal(answer.kind, "applied", `${build}: ${label}`);
          continue;
        }
        assert.deepEqual([answer.kind, (answer as { why?: string }).why], ["incompatible", why], `${build}: ${label}`);
        assert.equal(session.entries.length, 1, `${build}: ${label} -- nothing appended`);
        assert.equal(session.incompatible?.why, why, `${build}: ${label} -- the session itself is held (derived)`);
      }
    }
  });

  test("LIVE-4 (L4-2): the settlement coordinator is the money facts' index -- identity and pin, the placeholder, an unreadable record; `refresh` reads a new record in", async () => {
    const store = createMemoryFinancialGameStore();
    const bound = newFinancialRecord("g_bound", currentMoneyContinuation(), T0, PIN);
    const unbound = newFinancialRecord("g_unbound", { ...currentMoneyContinuation(), financial_protocol: 7 }, T0);
    assert.equal((await store.create(bound)).outcome.kind, "committed");
    assert.equal((await store.create(unbound)).outcome.kind, "committed");
    store.records.set("g_broken", "unreadable");
    const c = coordinatorOver(store);
    assert.equal(c.factsOf("g_bound"), undefined, "nothing is known before the load");
    await c.load();
    assert.deepEqual(c.factsOf("g_bound"), { kind: "record", mci: currentMoneyContinuation(), deployment: PIN });
    assert.deepEqual(c.factsOf("g_unbound"), { kind: "record", mci: { ...currentMoneyContinuation(), financial_protocol: 7 }, deployment: null });
    assert.equal(c.factsOf("g_broken")?.kind, "unreadable");
    assert.equal(c.factsOf("g_none"), undefined);
    /* A money table created after the load (the escrow service writes its record first): unknown until refreshed. */
    assert.equal((await store.create(newFinancialRecord("g_new", currentMoneyContinuation(), T0, PIN))).outcome.kind, "committed");
    assert.equal(c.factsOf("g_new"), undefined);
    await c.refresh("g_new");
    assert.deepEqual(c.factsOf("g_new"), { kind: "record", mci: currentMoneyContinuation(), deployment: PIN });
    /* A record already known keeps what was read of it when a later read fails (identity and pin are write-once). */
    store.records.set("g_new", "unreadable");
    await c.refresh("g_new");
    assert.equal(c.factsOf("g_new")?.kind, "record");
    /* The index only reads: no record was written by any of it. */
    assert.equal(store.writes.count, 3);
  });
});
