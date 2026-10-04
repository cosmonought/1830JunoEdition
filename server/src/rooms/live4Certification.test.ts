// server/src/rooms/live4Certification.test.ts
//
// ==================================================================
//  LIVE-4 L4-7: THE FINAL CERTIFICATION -- RUNTIME BEHAVIOUR AND PERSISTED BYTES, ACROSS EVERY SLICE
// ==================================================================
//
// L4-1..L4-6 pinned their own halves; the integration pinned the seams between them. This suite attacks the combined
// system where a slice's own tests cannot reach, and pins the two defects L4-7 found and repaired. Sections are numbered
// here; the brief's section each one answers is named beside it.
//
//   §1 PINS               the versions and the two keys no LIVE-4 slice may move.
//   §2 RACE (brief §4)    chain facts turning verified-conflicting while gameplay is queued, admitted or in flight. The
//                         exact boundary is the actor queue's: a move queued BEFORE the contradiction was recorded may
//                         still commit (already admitted), and nothing downstream acts on it with money; a move queued
//                         after it is refused -- on EVERY resident game (L4-7 fix: the continuation review is queued on
//                         all of them at once, not one after another), and that review is never dropped behind a slow
//                         task (L4-7 fix, R6). A money job already running when the contradiction lands signs at most its
//                         one intent; the relayer's admission re-asks the verdict, so that intent is never attempted on
//                         chain, and the owner holds the game (R5).
//   §3 RESTART (brief §9) a verified deployment conflict outlives the process: the owner writes its hold the moment the
//                         facts are learned (L4-7 fix: the chain-facts listener, not the next sweep), superseding a weaker
//                         hold (L4-7 fix: the one exception to "the first hold stands"), and a restarted pool that has not
//                         read the chain yet does not continue a game held for a deployment conflict (L4-7 fix: the
//                         canonical verdict reads that hold while the run has no chain facts for the deployment).
//   §4 PRECEDENCE (§5)    several unreadable artifacts: the session and the money seam may name different first reasons,
//                         always the same class, never a write, deterministic within each; the operator is not told it
//                         is a defect.
//   §5 KEY (§6)           one capability per process: banner, ops/status.json, sessions, money serving, client verdicts
//                         and gamesDoctor agree on the key; BUILD_ID moves none of it; a real axis moves it.
//   §6 EDGE (§7)          the announcement is parsed once per connection, by the canonical parser; the local proxy keeps
//                         `/gs` query strings; an edge that strips them turns a current tab into a legacy one.
//   §7 MATRIX (§8)        stored games of every class, over file stores: the operator (read-only), the game server and the
//                         settlement coordinator as start.ts assembles them (its chain-facts listener, startup walk and
//                         sweeps; no escrow backend -- the escrow service's own seams are R3-R5's and L4-4's suites), a
//                         restart -- bytes hashed before and after, every write named; §7b the verified conflict's release
//                         path, end to end.
//   §8 RESTART/RECONNECT (§9) a derived answer never becomes a hold across a restart, a retried move is not a second one,
//                         the legacy wire keeps exact-build behaviour, and a conflict never disappears because a browser
//                         reconnects or the process restarts.

import { strict as assert } from "assert";
import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { describe, test } from "node:test";

import { createFileLogStore } from "../fileLogStore";
import { serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import type { GameServerOptions } from "../gameServer";
import { createContinuationWiring, listenForChainFacts } from "../continuationWiring";
import { thisDeploymentCapability } from "../deploymentCapability";
import { compatibilityDescriptor } from "../compatibilityDescriptor";
import { createFileFinancialGameStore, createMemoryFinancialGameStore, financialDirectory, type MemoryFinancialGameStore } from "../escrow/financialGameStore";
import { currentMoneyContinuation } from "../escrow/moneyContinuation";
import { FINANCIAL_VERSION, missingRecordPlaceholder, newFinancialRecord, transitionFinancial, type FinancialDeploymentPin, type FinancialGameRecord } from "../escrow/moneyLifecycle";
import { createMoneyServing, servingCapability, type MoneyServing } from "../escrow/moneyServing";
import { createSettlementCoordinator } from "../escrow/settlementCoordinator";
import { serverPrefixReplay } from "../escrow/settlementEvidence";
import { CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, GAME_A, PIN, T0, WALLETS, makeWorld, move, play, startedGame } from "../escrow/escrow3bSupport";
import { readVerifiedChainFacts, type ChainFactsRead } from "../escrow/juno/chainFacts";
import { QUERY } from "../escrow/juno/junoContract";
import { createJunoRest, JunoRpcError, type HttpTransport } from "../escrow/juno/junoRest";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet } from "../escrow/escrow4Support";
import { artifactClassesOnDisk, inspectContinuation, inspectMoney, releaseMoneyHold, withLock } from "../tools/gamesDoctor";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/settlementAppraisal";
import { ACCEPTED_CLIENT_PROTOCOLS, CLIENT_PROTOCOL_VERSION, FINANCIAL_PROTOCOL_VERSION, HOSTED_PROTOCOL_VERSION } from "../../../frontend/src/gameEngine/protocolVersions";
import { GAME_CONTINUATION_FORMAT, gameIdentityOfEntries, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import { NO_MONEY_DRAIN_MS, type ContinuationVerdict, type FormatFact, type PoolServingState } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { compatibilityKey, deploymentCapability, deploymentKey, DEPLOYMENT_CAPABILITY_FORMAT } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import * as clientCompatibility from "../../../frontend/src/gameEngine/compat/clientCompatibility";
import { CLIENT_ANSWER_CLOSE_CODE } from "../../../frontend/src/utils/clientAnswers";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { MONEY_TABLE_FORMAT, mintGameId, type GameRecord } from "./gameRecord";
import { createFileHoldStore } from "./holdStore";
import { createFileRecordStore, createMemoryRecordStore } from "./recordStore";
import { sealOf, type TerminalSeal } from "./lifecycle";
import { ALICE, BOB, BUILD, BUY, Client, controlledStore, probeSession, quietConsole, seededRecord, startServer, stopServer, storedLog, until, type Frame, type SeenEntry } from "./testSupport";
import { TASK_DEADLINE_MS } from "./gameActor";

quietConsole();

const quiet = { warn: () => undefined };
const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), "utf8");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const why = (verdict: ContinuationVerdict): string => (verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The keys L4-3 pinned and every later pass kept. */
/* Route v12 R12-2 moved both keys on the rules axis alone (rules 12; LIVE-4 certified dc1-68c4b829… / dc1-43086498… on 11),
   and R12-3 moved them again by certifying 12 for settlement (R12-2's were dc1-ade748b9… / dc1-eb48b18e…). Phase 3 W3-K
   moved them once more, on the rules axis alone (rules 13 reading [13], settlement still [10, 11, 12]; R12-3's were
   dc1-41eb96a7… / dc1-63af8114…), and Phase 3's dedicated v13 certification moved them by certifying 13 alone
   (settlement [10, 11, 12, 13]; W3-K's were dc1-390107d5… / dc1-d01c50c4…). */
const KEY_NO_ESCROW = "dc1-e8d0b4792a7ba07e67199ad2";
const KEY_FIXTURE_PIN = "dc1-32fcc4967978e78f10874490";

const OTHER_CHECKSUM = "ab".repeat(32);
const PIN_B: FinancialDeploymentPin = Object.freeze({ ...PIN, contract_address: WALLETS[2] });
const PIN_TYPO: FinancialDeploymentPin = Object.freeze({ ...PIN, denom: "ujunoy" });
const KEY_A = deploymentKey(PIN);
const DEALT: GameIdentityFacts = { kind: "dealt", gci: { format: GAME_CONTINUATION_FORMAT, rules_engine_version: RULES_ENGINE_VERSION, hosted_protocol: HOSTED_PROTOCOL_VERSION } };
const chainRead = (checksum: string, denom: string) => ({ kind: "read" as const, key: KEY_A, facts: { code_checksum: checksum, denom }, read_at: T0 });
/** A current (protocol 1) tab's announcement, on another build than the server's. */
const TAB = `cp=${CLIENT_PROTOCOL_VERSION}&cr=${RULES_ENGINE_VERSION}&cb=tab-other-build`;

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `l4-7-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** Every file (SHA-256, size, mtime) and directory under `dir`. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(at, entry.name);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        out[`${relative}/`] = "directory";
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out[relative] = `${sha(fs.readFileSync(full))} ${stat.size} ${stat.mtimeMs}`;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** The paths whose bytes differ between two snapshots (added, removed or changed), sorted. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

function termsOf(pin: FinancialDeploymentPin) {
  return { format: MONEY_TABLE_FORMAT, backend: pin.backend, chain_id: pin.chain_id, network_class: pin.network_class, contract_address: pin.contract_address, code_checksum: pin.code_checksum, denom: pin.denom, symbol: "JUNOX", exponent: 6, ante_gross: "1010000", mode: "live" };
}

/** A dealt money GameRecord (record_schema 2) whose terms name `pin`, seated ALICE (host) and BOB. */
function moneyRecord(gameId: string, pin: FinancialDeploymentPin): GameRecord {
  const seeded = seededRecord([ALICE, BOB], { dealt: true, gameId, now: T0 });
  return { ...seeded, record_schema: 2, money: termsOf(pin), policy: { ...(seeded as unknown as { policy: object }).policy, host_undo: "none" }, exact_players: 2, rules_engine_version: RULES_ENGINE_VERSION } as unknown as GameRecord;
}

function dealtFin(gameId: string, pin: FinancialDeploymentPin): FinancialGameRecord {
  const moved = transitionFinancial(newFinancialRecord(gameId, currentMoneyContinuation(), T0, pin), { kind: "dealt", at: T0 + 1 });
  assert.equal(moved.kind, "moved");
  return (moved as { next: FinancialGameRecord }).next;
}

function heldFin(record: FinancialGameRecord, code: "binding-mismatch" | "journal-ahead" | "continuation-incompatible", detail: string): FinancialGameRecord {
  const moved = transitionFinancial(record, { kind: "hold", at: T0 + 5, code, detail });
  assert.equal(moved.kind, "moved");
  return (moved as { next: FinancialGameRecord }).next;
}

/** A settlement coordinator and continuation wiring over one financial store, as `start.ts` assembles them. */
function poolIndex(store: MemoryFinancialGameStore, serving: MoneyServing) {
  return createSettlementCoordinator({
    store,
    replay: serverPrefixReplay(BUILD),
    now: () => T0 + 10,
    warn: () => undefined,
    serving,
    schedule: () => ({ cancel: () => undefined }),
  });
}

/**
 * A money pool as `start.ts` assembles one -- the money serving (one capability, one chain-facts runtime), the
 * settlement coordinator over the financial store (the session's money index), the game server judging with that
 * capability and runtime, and the chain-facts listener that re-asks every resident verdict -- over `games` dealt money
 * tables (ALICE, BOB; BOB on turn) whose append a test can hold.
 */
async function moneyPool(games: number, options: { readonly facts?: "agree" | "none"; readonly held?: "binding-mismatch" | "journal-ahead" } = {}) {
  const records = createMemoryRecordStore();
  const logs = controlledStore();
  const fin = createMemoryFinancialGameStore();
  const ids: string[] = [];
  for (let n = 0; n < games; n += 1) {
    const gameId = mintGameId();
    ids.push(gameId);
    assert.equal((await records.put(moneyRecord(gameId, PIN), null)).kind, "committed");
    logs.logs.set(gameId, storedLog(1));
    const dealt = dealtFin(gameId, PIN);
    fin.records.set(gameId, options.held === undefined ? dealt : heldFin(dealt, options.held, `${options.held === "binding-mismatch" ? "deployment-conflict" : "journal"}: recorded by the owning pool before the restart`));
  }
  const serving = createMoneyServing({ capability: thisDeploymentCapability([PIN]) });
  if ((options.facts ?? "agree") === "agree") serving.recordChainFacts(chainRead(CANONICAL_CHECKSUM, PIN.denom));
  const coordinator = poolIndex(fin, serving);
  await coordinator.load();
  const { server, port } = await startServer({ records, store: logs.store, capability: serving.capability, runtime: serving.runtime(), moneyFacts: coordinator });
  /* start.ts's chain-facts listener, the production function: every resident verdict re-asked, and the owner's conflict
     holds written at once. `held()`: every hold it started has been written (or found written). */
  const listener = listenForChainFacts({ onChainFacts: (next) => serving.onChainFacts(next), lifecycle: server.lifecycle, settlement: coordinator });
  await server.lifecycle.ready;
  return { server, port, logs, fin, serving, coordinator, ids, records, held: () => listener.settled() };
}

/** A protocol-1 tab seated as `claim`, subscribed to `gameId`; its hello's answer. */
async function tabAt(port: number, claim: string, gameId: string): Promise<{ client: Client; answer: Frame }> {
  const client = await Client.open(port, claim, TAB);
  client.hello(gameId);
  const answer = await client.next((f) => f.kind === "catch-up" || f.kind === "incompatible" || f.kind === "error" || f.kind === "reload", `the hello to ${gameId}`);
  return { client, answer };
}

const lastIndex = (answer: Frame): number => {
  const entries = answer.entries as SeenEntry[];
  return entries[entries.length - 1].index;
};

/* ================================================================================================= */
/* §1. The pins                                                                                       */
/* ================================================================================================= */

describe("LIVE-4 L4-7 §1: the certified identity -- no version or key moved (but for Route v12 R12-2's rules bump, R12-3's certification, W3-K's v13 and the v13 certification)", () => {
  test("rules 13 (reads [13]; 11 / [11] at L4-7, 12 / [12] until W3-K); settlement [10, 11, 12, 13] ([10, 11] at L4-7, 13 by the v13 certification); hosted 1; financial 3; client 1 accepting [0, 1]; money GameRecords schema 2; the two pinned keys", () => {
    assert.equal(RULES_ENGINE_VERSION, 13);
    assert.deepEqual([...SUPPORTED_RULES_ENGINE_VERSIONS], [13]);
    assert.deepEqual([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS], [10, 11, 12, 13]);
    assert.equal(HOSTED_PROTOCOL_VERSION, 1);
    assert.equal(FINANCIAL_PROTOCOL_VERSION, 3);
    assert.equal(CLIENT_PROTOCOL_VERSION, 1);
    assert.deepEqual([...ACCEPTED_CLIENT_PROTOCOLS], [0, 1]);
    assert.equal((moneyRecord(mintGameId(), PIN) as unknown as { record_schema: number }).record_schema, 2);
    assert.match(source("server/src/rooms/gameRecord.ts"), /record_schema: 1 \| 2;/);
    assert.equal(compatibilityKey(thisDeploymentCapability([])), KEY_NO_ESCROW);
    assert.equal(compatibilityKey(thisDeploymentCapability([PIN])), KEY_FIXTURE_PIN);
  });
});

/* ================================================================================================= */
/* §2 (brief §4). The race: a verified contradiction vs queued, admitted and in-flight gameplay        */
/* ================================================================================================= */

describe("LIVE-4 L4-7 §2: a verified contradiction against queued gameplay -- the exact boundary", () => {
  test("R0, one game: a move queued BEFORE the contradiction commits (already admitted); a move that arrives after it is refused; nothing else is written", async () => {
    const pool = await moneyPool(1);
    try {
      const [gameId] = pool.ids;
      const bob = await tabAt(pool.port, BOB, gameId);
      const alice = await tabAt(pool.port, ALICE, gameId);
      assert.deepEqual([bob.answer.kind, alice.answer.kind], ["catch-up", "catch-up"]);
      const start = pool.logs.log(gameId).length;
      /* 1. Admitted: BOB's move is speculated on the actor and waits for its durable append. */
      pool.logs.control.holdAppends = true;
      bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "admitted" });
      const inFlight = await pool.logs.nextHeldAppend();
      /* 2. The chain reports other code at verification grade: recorded, announced, and every resident game's
            continuation review is queued in the same step -- behind the in-flight move, ahead of anything later. */
      pool.serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
      /* 3. A move that arrives after the contradiction is known (the seat on turn after BOB's move). */
      pool.logs.control.holdAppends = false;
      alice.client.submit(BUY, { baseIndex: lastIndex(bob.answer) + 1, submissionId: "late" });
      /* 4. The in-flight move reaches its commit. */
      inFlight.release();
      const admitted = await bob.client.answerTo("admitted");
      const late = await alice.client.answerTo("late");
      assert.equal(admitted.kind, "applied", "already admitted: it completes, and the log stays canonical");
      assert.deepEqual([late.kind, late.why], ["incompatible", "conflict/deployment-conflict"], "queued after the contradiction: refused");
      assert.equal(pool.logs.log(gameId).length, start + 1, "exactly the admitted move was appended");
      assert.equal(pool.logs.calls.appendLog, 1);
      const actor = await pool.server.rooms.actorFor(gameId);
      assert.equal(actor?.view.incompatible !== null, true, "the resident game is stopped (no reload)");
      /* The money side: the owner wrote the conflict's canonical hold at once (the listener, no sweep) -- and nothing else. */
      await pool.held();
      const record = pool.fin.records.get(gameId) as FinancialGameRecord;
      assert.deepEqual([record.phase, record.hold?.code], ["held", "binding-mismatch"]);
      assert.equal(pool.fin.writes.count, 1, "the hold is the one financial write");
    } finally {
      await stopServer(pool.server);
    }
  });

  test("R1, two games (the L4-7 fix): a move ARRIVING after the contradiction on a game later in the review is refused -- the review is queued on every resident game at once, not behind another game's queue", async () => {
    const pool = await moneyPool(2);
    try {
      const [g1, g2] = pool.ids;
      const b1 = await tabAt(pool.port, BOB, g1);
      const b2 = await tabAt(pool.port, BOB, g2);
      assert.deepEqual([b1.answer.kind, b2.answer.kind], ["catch-up", "catch-up"]);
      /* g1's queue is busy: a move there waits for its append, so g1's review waits behind it. */
      pool.logs.control.holdAppends = true;
      b1.client.submit(BUY, { baseIndex: lastIndex(b1.answer), submissionId: "g1-admitted" });
      const g1Append = await pool.logs.nextHeldAppend();
      pool.serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
      pool.logs.control.holdAppends = false;
      /* Before L4-7 the room host queued g2's review only after g1's had run, so this move -- sent after the process
         knew -- was applied on g2. */
      b2.client.submit(BUY, { baseIndex: lastIndex(b2.answer), submissionId: "g2-late" });
      const late = await b2.client.answerTo("g2-late");
      assert.deepEqual([late.kind, late.why], ["incompatible", "conflict/deployment-conflict"]);
      assert.equal(pool.logs.log(g2).length, 2, "not one entry on the second game");
      g1Append.release();
      assert.equal((await b1.client.answerTo("g1-admitted")).kind, "applied", "the first game's admitted move completes");
      const [a1, a2] = [await pool.server.rooms.actorFor(g1), await pool.server.rooms.actorFor(g2)];
      await until(() => a1?.view.incompatible !== null && a2?.view.incompatible !== null, "both games stopped");
      await pool.held();
      assert.deepEqual([g1, g2].map((id) => (pool.fin.records.get(id) as FinancialGameRecord).hold?.code), ["binding-mismatch", "binding-mismatch"], "each held by its owner at once");
      assert.equal(pool.fin.writes.count, 2, "one hold per game, nothing else");
      /* By source: the continuation review is queued synchronously on every resident game. */
      const host = code(source("server/src/rooms/roomHost.ts"));
      assert.match(host, /if \(options\.continuation === true\) return reviewContinuationNow\(\);/);
      assert.match(host, /function reviewContinuationNow\(\): Promise<number> \{[\s\S]*?deps\.games\.forEach\?\.\(\(game\) => \{[\s\S]*?queued\.push\(\s*game\.reviewServing\(\{ continuation: true \}\)/);
    } finally {
      await stopServer(pool.server);
    }
  });

  test("R2, a newly loaded session after the contradiction (in the same process) is refused at its load -- nothing interpreted, nothing written", async () => {
    const pool = await moneyPool(2);
    try {
      const [resident, cold] = pool.ids;
      const bob = await tabAt(pool.port, BOB, resident);
      assert.equal(bob.answer.kind, "catch-up");
      pool.serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
      const late = await tabAt(pool.port, ALICE, cold);
      assert.deepEqual([late.answer.kind, late.answer.why], ["incompatible", "conflict/deployment-conflict"], "the cold game's first load asks the verdict with this run's facts");
      late.client.submit(BUY, { baseIndex: 1, submissionId: "cold" });
      const refused = await late.client.answerTo("cold");
      assert.ok(refused.kind === "incompatible" || (refused.kind === "refused" && refused.code === "wrong-state"), JSON.stringify(refused));
      assert.equal(pool.logs.log(cold).length, 2);
      await pool.held();
      assert.equal(pool.fin.writes.count, 2, "each game's owner hold -- nothing interpreted, nothing else written");
    } finally {
      await stopServer(pool.server);
    }
  });

  test("R3, the money consequence: a round boundary committed AFTER the contradiction is recorded prepares no checkpoint -- the owner holds the game (binding-mismatch), and that hold is the only financial write", async () => {
    /* The control first: the same schedule with the chain agreeing checkpoints the Stock Round (the boundary is real). */
    for (const contradicted of [false, true]) {
      const world = makeWorld();
      await startedGame(world, GAME_A);
      const session = play(world, GAME_A, 0);
      await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_prepared !== null);
      /* To the last move of the private auction's phase: every private bought, the B&O parred. */
      while (session.state.private_companies.some((p) => p.owner === null || p.owner === undefined)) play(world, GAME_A, 1, session);
      const bo = session.state.private_companies.find((p) => p.private_id === 6);
      if (bo?.owner) move(world, GAME_A, session, bo.owner, { SetBoPar: { player: bo.owner, par_value: "100" } });
      await world.service.idle();
      const checkpoints = async () => (await world.intents.listGame(GAME_A)).filter((intent) => intent.op.kind === "checkpoint").length;
      const before = await checkpoints();
      const record = await world.financial.load(GAME_A);
      assert.ok(record !== null && record.phase === "in-progress");
      const transitions = record.transitions.length;
      const version = record.record_version;
      if (contradicted) {
        world.chain.reportedChecksum = OTHER_CHECKSUM;
        assert.equal((await world.service.refreshChainFacts()).kind, "read");
      }
      /* The boundary move lands (the in-flight commit, announced to the money seam exactly as the room host does). */
      move(world, GAME_A, session, session.state.player_addresses[0], { OpenStockRound: {} });
      await world.service.idle();
      await world.service.sweepChain();
      await world.service.idle();
      const after = await world.financial.load(GAME_A);
      assert.ok(after !== null);
      if (!contradicted) {
        assert.equal(await checkpoints(), before + 1, "control: the Stock Round boundary IS a checkpoint position");
        continue;
      }
      assert.equal(await checkpoints(), before, "no checkpoint is prepared for a position committed after the contradiction");
      assert.deepEqual([after.phase, after.hold?.code], ["held", "binding-mismatch"], "the owner holds it under the canonical code");
      assert.equal(after.record_version, version + 1, "exactly one financial write: the hold");
      assert.deepEqual(after.transitions.slice(transitions).map((line) => line.why), ["hold: binding-mismatch"]);
      assert.equal(after.chain.checkpoint_prepared?.log_len, record.chain.checkpoint_prepared?.log_len, "no checkpoint position moved");
    }
  });

  test("R5, the money job's own boundary: a contradiction recorded INSIDE a checkpoint job (after its verdict, during its chain reads) -- the one intent in flight may be signed, but the relayer's admission re-asks the verdict: it is never attempted on chain, and the owner holds the game", async () => {
    const world = makeWorld();
    await startedGame(world, GAME_A);
    const session = play(world, GAME_A, 0);
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_prepared !== null);
    while (session.state.private_companies.some((p) => p.owner === null || p.owner === undefined)) play(world, GAME_A, 1, session);
    const bo = session.state.private_companies.find((p) => p.private_id === 6);
    if (bo?.owner) move(world, GAME_A, session, bo.owner, { SetBoPar: { player: bo.owner, par_value: "100" } });
    await world.service.idle();
    await world.drive(async () => (await world.intents.listGame(GAME_A)).every((intent) => intent.status === "confirmed" || intent.status === "superseded"));
    const before = new Set((await world.intents.listGame(GAME_A)).map((intent) => intent.intent_id));
    /* Arm: the next time the job reads the chain game (after `servingOf` + `mayAct` said continue, before it signs),
       the contract starts reporting other code and a verification-grade read records it. */
    const smart = world.chain.smart.bind(world.chain);
    let armed = true;
    let fired = 0;
    world.chain.smart = async (contract: string, query: string) => {
      if (armed && /"game"/.test(query)) {
        armed = false;
        fired += 1;
        world.chain.reportedChecksum = OTHER_CHECKSUM;
        assert.equal((await world.service.refreshChainFacts()).kind, "read");
      }
      return smart(contract, query);
    };
    /* The Stock Round boundary lands: its checkpoint job runs with the verdict it asked first. */
    move(world, GAME_A, session, session.state.player_addresses[0], { OpenStockRound: {} });
    await world.service.idle();
    assert.equal(fired, 1, "the contradiction landed inside the job");
    const created = (await world.intents.listGame(GAME_A)).filter((intent) => !before.has(intent.intent_id));
    assert.deepEqual(created.map((intent) => intent.op.kind), ["checkpoint"], "exactly the one intent that was in flight -- its verdict was asked before the contradiction -- signed and written");
    /* The relayer's passes: the admission asks the verdict again -- the conflict -- and the owner holds the game. */
    for (let pass = 0; pass < 3; pass += 1) {
      await world.relayer.pass();
      await world.service.idle();
    }
    await world.service.sweepChain();
    await world.service.idle();
    const after = await world.financial.load(GAME_A);
    assert.deepEqual([after?.phase, after?.hold?.code], ["held", "binding-mismatch"], "the owner holds it under the canonical code");
    for (const intent of (await world.intents.listGame(GAME_A)).filter((entry) => !before.has(entry.intent_id))) {
      assert.deepEqual([intent.attempts.length, intent.confirmation], [0, null], "never attempted on chain");
    }
  });

  test("R6, the review is never dropped (review F3): a commit ahead of it that outlasts the task deadline does not expire it -- the move sent after the contradiction is still refused, the game still stops", async () => {
    const pool = await moneyPool(1);
    try {
      const [gameId] = pool.ids;
      const bob = await tabAt(pool.port, BOB, gameId);
      const alice = await tabAt(pool.port, ALICE, gameId);
      pool.logs.control.holdAppends = true;
      bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "slow" });
      const slow = await pool.logs.nextHeldAppend();
      pool.serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
      /* The commit ahead of the review takes longer than TASK_DEADLINE_MS: the clock moves on while it is held. */
      const realNow = Date.now;
      Date.now = () => realNow() + TASK_DEADLINE_MS + 1_000;
      try {
        pool.logs.control.holdAppends = false;
        slow.release();
        assert.equal((await bob.client.answerTo("slow")).kind, "applied", "admitted before the contradiction: it completes");
        alice.client.submit(BUY, { baseIndex: lastIndex(bob.answer) + 1, submissionId: "late" });
        const late = await alice.client.answerTo("late");
        assert.deepEqual([late.kind, late.why], ["incompatible", "conflict/deployment-conflict"], "the review ran: the late move is refused");
      } finally {
        Date.now = realNow;
      }
      const actor = await pool.server.rooms.actorFor(gameId);
      assert.notEqual(actor?.view.incompatible, null, "stopped");
      assert.equal(pool.logs.log(gameId).length, 3, "exactly the admitted move was appended");
      /* By source: the continuation review is ESSENTIAL -- never refused for a full queue, never expired. */
      const actorSource = code(source("server/src/rooms/gameActor.ts"));
      assert.match(actorSource, /\{ quiet: true, \.\.\.\(options\.continuation === true \? \{ essential: true \} : \{\}\) \}/);
      assert.match(actorSource, /if \(options\.essential !== true && this\.queued\.size >= ACTOR_QUEUE_BOUND\)/);
      assert.match(actorSource, /deadlineAt: options\.essential === true \? Number\.POSITIVE_INFINITY :/);
    } finally {
      await stopServer(pool.server);
    }
  });

  test("R4, end to end (ESCROW-4 world): a move in flight on a funded, started table lands after the contradiction; the move sent after it is refused; the owner holds; no chain intent is created for anything after the contradiction", async () => {
    const logs = controlledStore();
    const world = await moneyServer({ store: logs.store });
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const hostWallet = testWallet("host");
      const hostKey = testConsentKey("host");
      const hostLink = await linkWallet(host, table.gameId, hostWallet, hostKey);
      assert.equal(hostLink.status, 200, hostLink.text);
      await hostCreates(world, host, table.gameId, hostWallet, hostKey, hostLink.body?.ticket as string);
      await world.observe();
      const jo = await player(world, "Jo");
      assert.equal((await jo.client.op({ type: "join", code: table.code, takeSeat: true })).ok, true);
      const joWallet = testWallet("jo");
      const joKey = testConsentKey("jo");
      const joLink = await linkWallet(jo, table.gameId, joWallet, joKey);
      await joinerFunds(world, jo, table.gameId, joWallet, joKey, joLink.body?.ticket as string);
      await world.observe();
      assert.equal((await host.client.op({ type: "start-game" }, table.gameId)).ok, true);
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
      await world.service.idle();
      const actor = await world.server.rooms.actorFor(table.gameId);
      assert.ok(actor !== null);
      /* Both seats subscribed; the seat on turn and the other one. */
      const seen: Record<string, number> = {};
      for (const who of [host, jo]) {
        who.client.hello(table.gameId);
        seen[who.name] = lastIndex(await who.client.next((f: Frame) => f.kind === "catch-up", "a catch-up"));
      }
      const onTurn = (() => {
        const replayed = probeSession("r4");
        replayed.restore(actor.view.entries);
        return replayed.state.player_addresses[0] === world.server.rooms.moneyPort.recordOf(table.gameId)?.seats[0].player_id ? host : jo;
      })();
      const other = onTurn === host ? jo : host;
      const intentsBefore = (await world.intents.listGame(table.gameId)).map((intent) => intent.intent_id).sort();
      const finBefore = await world.financial.load(table.gameId);
      assert.ok(finBefore !== null);
      /* In flight: the seat on turn buys; its append is held. */
      logs.control.holdAppends = true;
      onTurn.client.submit(BUY, { baseIndex: seen[onTurn.name], submissionId: "in-flight" });
      const append = await logs.nextHeldAppend();
      world.chain.reportedChecksum = OTHER_CHECKSUM;
      assert.equal((await world.service.refreshChainFacts()).kind, "read");
      logs.control.holdAppends = false;
      other.client.submit(BUY, { baseIndex: seen[other.name] + 1, submissionId: "after" });
      append.release();
      assert.equal((await onTurn.client.answerTo("in-flight")).kind, "applied", "admitted before: it completes");
      const after = await other.client.answerTo("after");
      assert.deepEqual([after.kind, after.why], ["incompatible", "conflict/deployment-conflict"], "sent after: refused");
      await until(() => actor.view.incompatible !== null, "the resident session stops");
      await world.service.sweepChain();
      await world.service.idle();
      const fin = await world.financial.load(table.gameId);
      assert.deepEqual([fin?.phase, fin?.hold?.code], ["held", "binding-mismatch"]);
      assert.deepEqual(fin?.transitions.slice(finBefore.transitions.length).map((line) => line.why), ["hold: binding-mismatch"], "the only financial transition after the contradiction");
      assert.deepEqual((await world.intents.listGame(table.gameId)).map((intent) => intent.intent_id).sort(), intentsBefore, "no chain intent was created after the contradiction");
      assert.equal(logs.log(table.gameId).length, actor.view.entries.length, "the durable log is the committed view: canonical, one move after the record");
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* §3 (brief §3C, §9). A verified conflict survives a restart (the L4-7 fix)                          */
/* ================================================================================================= */

describe("LIVE-4 L4-7 §3: a verified deployment conflict's durable hold outlives the process's chain facts", () => {
  test("the canonical verdict, pure: held binding-mismatch with no chain facts this run is deployment-unverified (derived); a read that contradicts is the conflict; a read that agrees continues; another hold code, or a pool that does not serve the deployment, is unaffected -- and a verified conflict supersedes a weaker hold, so it is always recorded under that code", () => {
    const store = createMemoryFinancialGameStore();
    const gameId = mintGameId();
    const held = heldFin(dealtFin(gameId, PIN), "binding-mismatch", "deployment-conflict: before the restart");
    store.records.set(gameId, held);
    const judge = (serves: FinancialDeploymentPin, read: ReturnType<typeof chainRead> | null, record: FinancialGameRecord = held): string => {
      const serving = createMoneyServing({ capability: thisDeploymentCapability([serves]) });
      if (read !== null) serving.recordChainFacts(read);
      return why(serving.decide({ fin: "current", record, identity: DEALT }).verdict);
    };
    assert.equal(judge(PIN, null), "not-continued/deployment-unverified", "a restart that has not read the chain: not continued, and nothing written for it");
    assert.equal(judge(PIN, chainRead(OTHER_CHECKSUM, PIN.denom)), "conflict/deployment-conflict", "read, and still contradicted: the conflict again");
    assert.equal(judge(PIN, chainRead(CANONICAL_CHECKSUM, PIN.denom)), "continues", "read, and agreeing: continued (the money stays held until an operator's release)");
    assert.equal(judge(PIN_B, null), "not-continued/deployment-unavailable", "a pool that does not serve the game's escrow says so first, as before");
    const journal = heldFin(dealtFin(gameId, PIN), "journal-ahead", "the journal is ahead");
    assert.equal(judge(PIN, null, journal), "continues", "any other hold code: unchanged (gameplay continues while signing waits)");
    assert.equal(judge(PIN, chainRead(OTHER_CHECKSUM, PIN.denom), journal), "conflict/deployment-conflict");
    assert.equal(judge(PIN, null, dealtFin(gameId, PIN)), "continues", "not held: unchanged (the chain unread is no reason to stop a game)");
    /* The lifecycle: the owner's VERIFIED deployment-conflict hold supersedes a weaker hold (the one exception to "the
       first hold stands"), keeping the phase the game was held from and the first hold's evidence in its detail. */
    const conflictHold = { kind: "hold" as const, at: T0 + 9, code: "binding-mismatch" as const, detail: "deployment-conflict: the chain reports other code" };
    const superseded = transitionFinancial(journal, { ...conflictHold, verifiedConflict: true });
    assert.equal(superseded.kind, "moved");
    const next = (superseded as { next: FinancialGameRecord }).next;
    assert.deepEqual([next.phase, next.hold?.code, next.hold?.from, next.record_version], ["held", "binding-mismatch", journal.hold?.from, journal.record_version + 1]);
    assert.match(next.hold?.detail ?? "", /superseding journal-ahead: the journal is ahead/);
    assert.equal(next.transitions.at(-1)?.why, "hold: binding-mismatch (supersedes journal-ahead)");
    assert.equal(judge(PIN, null, next), "not-continued/deployment-unverified", "and the next run without chain facts reads it");
    assert.equal(transitionFinancial(journal, conflictHold).kind, "same", "any other hold event: the first hold stands");
    assert.equal(transitionFinancial(next, { ...conflictHold, verifiedConflict: true }).kind, "same", "a conflict already recorded: nothing more");
    assert.equal(transitionFinancial(missingRecordPlaceholder(gameId, T0, "test"), { ...conflictHold, verifiedConflict: true }).kind, "same", "the missing-record placeholder is never superseded");
  });

  test("a restarted pool that has not read the chain: the held game is not served (hello, submit), nothing is written; once the chain is read, a contradiction is the conflict again and agreement continues a newly loaded game -- the hold untouched throughout", async () => {
    const pool = await moneyPool(3, { facts: "none", held: "binding-mismatch" });
    try {
      const [early, contradictedLater, agreedLater] = pool.ids;
      const finBefore = [...pool.fin.records.entries()].map(([id, record]) => `${id}:${(record as FinancialGameRecord).record_version}:${(record as FinancialGameRecord).phase}`).sort();
      /* Before any verification-grade read this run. */
      const bob = await tabAt(pool.port, BOB, early);
      assert.deepEqual([bob.answer.kind, bob.answer.why], ["incompatible", "deployment-unverified"], "not continued until the chain is read -- never played on a stale 'continues'");
      bob.client.submit(BUY, { baseIndex: 1, submissionId: "pre-read" });
      const refused = await bob.client.answerTo("pre-read");
      assert.ok(refused.kind === "incompatible" || (refused.kind === "refused" && refused.code === "wrong-state"), JSON.stringify(refused));
      assert.equal(pool.logs.log(early).length, 2, "no move reached the log");
      /* The same pool's wiring and money seam give the same class for it (one canonical verdict). */
      assert.equal(why(pool.server.lifecycle.continuation.verdictOf(early, DEALT)), "not-continued/deployment-unverified");
      assert.equal(why(pool.serving.decide({ fin: "current", record: pool.fin.records.get(early) as FinancialGameRecord, identity: DEALT }).verdict), "not-continued/deployment-unverified");
      /* The chain is read and still contradicts the binding: a game loaded now is the conflict. */
      pool.serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
      const late = await tabAt(pool.port, ALICE, contradictedLater);
      assert.deepEqual([late.answer.kind, late.answer.why], ["incompatible", "conflict/deployment-conflict"]);
      /* The chain is read again and now AGREES: a game loaded now is continued (its money stays held). */
      pool.serving.recordChainFacts(chainRead(CANONICAL_CHECKSUM, PIN.denom));
      const agreed = await tabAt(pool.port, BOB, agreedLater);
      assert.equal(agreed.answer.kind, "catch-up", "continued: the facts no longer contradict it");
      agreed.client.submit(BUY, { baseIndex: lastIndex(agreed.answer), submissionId: "agreed" });
      assert.equal((await agreed.client.answerTo("agreed")).kind, "applied");
      /* No financial record was written by any of it: the holds stand exactly as the owning pool wrote them. */
      assert.equal(pool.fin.writes.count, 0);
      assert.deepEqual([...pool.fin.records.entries()].map(([id, record]) => `${id}:${(record as FinancialGameRecord).record_version}:${(record as FinancialGameRecord).phase}`).sort(), finBefore);
    } finally {
      await stopServer(pool.server);
    }
  });

  test("another hold (journal-ahead) with the chain unread: the game is played exactly as before L4-7 -- the rule is the deployment conflict's alone; an agreeing read writes nothing", async () => {
    const pool = await moneyPool(1, { facts: "none", held: "journal-ahead" });
    try {
      const [gameId] = pool.ids;
      const bob = await tabAt(pool.port, BOB, gameId);
      assert.equal(bob.answer.kind, "catch-up");
      bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "journal" });
      assert.equal((await bob.client.answerTo("journal")).kind, "applied");
      pool.serving.recordChainFacts(chainRead(CANONICAL_CHECKSUM, PIN.denom));
      await pool.held();
      assert.equal(pool.fin.writes.count, 0, "no conflict: the listener writes nothing, the first hold stands");
    } finally {
      await stopServer(pool.server);
    }
  });

  test("on disk, as an operator sees it after the restart: gamesDoctor continuation and money agree (deployment-unverified, no DISAGREES), a release needs a verification-grade read, and the one that agrees releases it -- nothing else written", () =>
    withDir("held-restart", async (dir) => {
      const gameId = mintGameId();
      fs.mkdirSync(path.join(dir, "games"), { recursive: true });
      fs.writeFileSync(path.join(dir, "games", `${gameId}.json`), `${JSON.stringify(moneyRecord(gameId, PIN))}\n`);
      fs.writeFileSync(path.join(dir, `${gameId}.log.jsonl`), storedLog(2).map((entry) => serializeBatch([entry])).join(""));
      fs.mkdirSync(financialDirectory(dir), { recursive: true });
      fs.writeFileSync(path.join(financialDirectory(dir), `${gameId}.json`), `${JSON.stringify(heldFin(dealtFin(gameId, PIN), "binding-mismatch", "deployment-conflict: recorded before the restart"))}\n`);
      const before = snapshot(dir);
      const unread = createMoneyServing({ capability: servingCapability([PIN]) });
      const report = await inspectContinuation(dir, { serving: unread });
      const game = report.games.find((entry) => entry.gameId === gameId);
      assert.deepEqual([game?.class, game?.money_seam?.class, game?.money_seam?.agrees, game?.money_seam?.same_reason], ["not-continued/deployment-unverified", "deployment-unverified", true, true]);
      const money = await inspectMoney(dir, gameId, { serving: unread });
      assert.deepEqual([money.games[0].class, money.games[0].phase, money.games[0].hold?.code], ["deployment-unverified", "held", "binding-mismatch"]);
      assert.deepEqual(snapshot(dir), before, "inspection wrote nothing");
      const ops = createMemoryOpsRecorder();
      const release = (serving: MoneyServing) => withLock(dir, (lock) => releaseMoneyHold(dir, gameId, "the contract at A reports the bound code again", { lock, ops, serving }));
      const refused = (await release(unread)) as { ok: boolean; reason?: string };
      assert.equal(refused.ok, false);
      assert.match(refused.reason ?? "", /released only against a verification-grade chain read/);
      const contradicted = createMoneyServing({ capability: servingCapability([PIN]) });
      contradicted.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
      assert.match(((await release(contradicted)) as { reason?: string }).reason ?? "", /conflict: deployment-conflict/);
      assert.deepEqual(snapshot(dir), before, "a refused release writes nothing");
      const agreeing = createMoneyServing({ capability: servingCapability([PIN]) });
      agreeing.recordChainFacts(chainRead(CANONICAL_CHECKSUM, PIN.denom));
      assert.deepEqual(await release(agreeing), { ok: true, to: "in-progress" });
      assert.deepEqual(changed(before, snapshot(dir)), [`games/money/${gameId}.json`], "the release writes the financial record, and only it");
      assert.equal((await createFileFinancialGameStore(dir, quiet).load(gameId))?.phase, "in-progress");
    }));
});

describe("LIVE-4 L4-7 §3b: a verified conflict learned while running is durable at once (review F1, F2)", () => {
  const servingWith = async (plan: ChainPlan) => {
    const serving = createMoneyServing({ capability: servingCapability([PIN]) });
    await readChain(serving, plan);
    return serving;
  };

  test("the owner writes the canonical hold from the chain-facts listener itself -- no sweep, no money job -- so a restart right after, whose tabs say hello before the chain is read, does not continue the game", () =>
    withDir("runtime-conflict", async (dir) => {
      const gameId = moneyGame({ fin: "fresh" })(dir);
      const serving = await servingWith("agree");
      const first = await fileServer(dir, serving);
      try {
        const bob = await tabAt(first.port, BOB, gameId);
        bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "before" });
        assert.equal((await bob.client.answerTo("before")).kind, "applied");
        const beforeHold = snapshot(dir);
        serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
        await first.held();
        assert.deepEqual(changed(beforeHold, snapshot(dir)), [`games/money/${gameId}.json`], "the owner's hold, from the listener -- and nothing else");
        const record = await createFileFinancialGameStore(dir, quiet).load(gameId);
        assert.deepEqual([record?.phase, record?.hold?.code], ["held", "binding-mismatch"]);
      } finally {
        await stopServer(first.server);
      }
      const afterFirst = snapshot(dir);
      const second = await fileServer(dir, await servingWith("none"), {}, { walk: false });
      try {
        const tab = await tabAt(second.port, BOB, gameId);
        assert.deepEqual([tab.answer.kind, tab.answer.why], ["incompatible", "deployment-unverified"], "not continued until the chain is read");
        tab.client.submit(BUY, { baseIndex: 2, submissionId: "after-restart" });
        const refused = await tab.client.answerTo("after-restart");
        assert.ok(refused.kind === "incompatible" || (refused.kind === "refused" && refused.code === "wrong-state"), JSON.stringify(refused));
      } finally {
        await stopServer(second.server);
      }
      assert.deepEqual(changed(afterFirst, snapshot(dir)), [], "the restart wrote nothing");
      /* By source: production assembles the same listener this harness uses (`listenForChainFacts`), with its settlement
         coordinator, and a clean stop waits for the holds it started. */
      const start = code(source("server/src/start.ts"));
      assert.match(start, /chainFactsListener = listenForChainFacts\(\{ onChainFacts: \(listener\) => serving\.onChainFacts\(listener\), lifecycle: server\.lifecycle, settlement \}\);/);
      assert.match(start, /chainFactsListener\?\.settled\(\)/);
      assert.equal((start.match(/serving\.onChainFacts\(/g) ?? []).length, 1, "no second listener");
    }));

  test("a game already held for another reason (journal-ahead) when the contradiction is learned: the owner's verified-conflict hold supersedes it (one write, the first hold named in it) -- so a restart with the chain unread does not continue it; read again, it is the conflict", () =>
    withDir("first-hold", async (dir) => {
      const gameId = moneyGame({ fin: (id) => heldFin(freshDealtFin(id), "journal-ahead", "the journal is ahead") })(dir);
      const serving = await servingWith("agree");
      const first = await fileServer(dir, serving);
      const start = snapshot(dir);
      try {
        const bob = await tabAt(first.port, BOB, gameId);
        assert.equal(bob.answer.kind, "catch-up", "journal-ahead: played while signing waits");
        serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
        await first.held();
        const alice = await tabAt(first.port, ALICE, gameId);
        assert.deepEqual([alice.answer.kind, alice.answer.why], ["incompatible", "conflict/deployment-conflict"]);
      } finally {
        await stopServer(first.server);
      }
      assert.deepEqual(changed(start, snapshot(dir)), [`games/money/${gameId}.json`], "the one write: the superseding hold");
      const record = await createFileFinancialGameStore(dir, quiet).load(gameId);
      assert.deepEqual([record?.phase, record?.hold?.code, record?.hold?.from], ["held", "binding-mismatch", "in-progress"]);
      assert.match(record?.hold?.detail ?? "", /superseding journal-ahead/);
      const afterFirst = snapshot(dir);
      for (const [plan, expected] of [
        ["none", "not-continued/deployment-unverified"],
        ["contradict-code", "conflict/deployment-conflict"],
      ] as const) {
        const again = await fileServer(dir, await servingWith(plan), {}, { walk: false });
        try {
          assert.equal(await helloClass(again.port, gameId), expected, `restarted, the chain ${plan === "none" ? "unread" : "read and contradicting"}`);
          await again.held();
        } finally {
          await stopServer(again.server);
        }
      }
      assert.deepEqual(changed(afterFirst, snapshot(dir)), [], "no restart wrote anything");
    }));
});

/* ================================================================================================= */
/* §4 (brief §5). Several unreadable artifacts: the same class, another first reason, never a write    */
/* ================================================================================================= */

/** A NEWER build's complete log record (N-3), appended after the durable prefix. */
const NEWER_LOG_LINE = `${JSON.stringify({ format: "gs-log", schema: 2, index: 3, entry: { id: "n1", payload: "{}" } })}\n`;
const logText = (entries: readonly ServerLogEntry[]) => entries.map((entry) => serializeBatch([entry])).join("");

function writeMoneyGameOnDisk(dir: string, gameId: string, over: { readonly log?: string; readonly fin?: string | null; readonly intents?: "newer" | "corrupt"; readonly tickets?: string }): void {
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  fs.writeFileSync(path.join(dir, "games", `${gameId}.json`), `${JSON.stringify(moneyRecord(gameId, PIN))}\n`);
  fs.writeFileSync(path.join(dir, `${gameId}.log.jsonl`), over.log ?? logText(storedLog(2)));
  if (over.fin !== null) {
    fs.mkdirSync(financialDirectory(dir), { recursive: true });
    fs.writeFileSync(path.join(financialDirectory(dir), `${gameId}.json`), over.fin ?? `${JSON.stringify(dealtFin(gameId, PIN))}\n`);
  }
  if (over.intents !== undefined) {
    const intents = path.join(dir, "games", "chain-intents", gameId);
    fs.mkdirSync(intents, { recursive: true });
    const body = over.intents === "newer" ? `${JSON.stringify({ format: "gs-chain-intent", schema: 2, game_id: gameId, intent_id: "f".repeat(64) })}\n` : "{\"format\":\"gs-chain-intent\",\"sch";
    fs.writeFileSync(path.join(intents, `${"f".repeat(64)}.json`), body);
  }
  if (over.tickets !== undefined) {
    fs.mkdirSync(path.join(dir, "games", "wallet-tickets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "games", "wallet-tickets", `${gameId}.json`), over.tickets);
  }
}

/** A server over FILE stores, as `start.ts` assembles one (the money serving's capability and runtime, the settlement
 *  coordinator over the file financial store as the money index, the escrow service's read-only artifact classes). */
async function fileServer(dir: string, serving: MoneyServing, over: Partial<GameServerOptions> = {}, options: { readonly walk?: boolean } = {}) {
  const coordinator = createSettlementCoordinator({
    store: createFileFinancialGameStore(dir, quiet),
    replay: serverPrefixReplay(BUILD),
    now: () => Date.now(),
    warn: () => undefined,
    serving,
    readDeal: async (gameId) => (await import("../escrow/dealIdentity")).dealIdentityOnDisk(dir, gameId),
    readLogFormat: async (gameId) => (await import("../escrow/dealIdentity")).logFormatOnDisk(dir, gameId),
    artifactFormats: (gameId, record) => artifactClassesOnDisk(dir, serving, gameId, record),
    schedule: () => ({ cancel: () => undefined }),
  });
  await coordinator.load();
  const started = await startServer({
    store: createFileLogStore(dir, quiet),
    records: createFileRecordStore(dir, quiet),
    holds: createFileHoldStore(dir, quiet),
    capability: serving.capability,
    runtime: serving.runtime(),
    moneyFacts: coordinator,
    settlement: coordinator,
    ...over,
  } as Partial<GameServerOptions>);
  /* start.ts's chain-facts listener, the production function (every resident verdict re-asked; the owner's conflict holds
     written at once). */
  const listener = listenForChainFacts({ onChainFacts: (next) => serving.onChainFacts(next), lifecycle: started.server.lifecycle, settlement: coordinator });
  await started.server.lifecycle.ready;
  /* start.ts's startup walk, as it runs it (after the escrow backend's first verification): the settlement
     reconciliation, then one liveness sweep at once. `walk: false` is a restart whose tabs said hello first. */
  if (options.walk !== false) {
    await coordinator.reconcileAtStartup({ financialGameIds: started.server.lifecycle.financialGameIds(), loadGame: started.server.lifecycle.loadGame });
    await coordinator.sweepLiveness(started.server.lifecycle.financialRecords());
  }
  return { ...started, coordinator, held: () => listener.settled() };
}

/** The session's answer to a protocol-1 hello: `continues` (a catch-up) or `<kind>/<why>` / `error/<code>`. */
async function helloClass(port: number, gameId: string, claim: string = BOB): Promise<string> {
  const { client, answer } = await tabAt(port, claim, gameId);
  await client.close();
  if (answer.kind === "catch-up") return "continues";
  if (answer.kind === "incompatible") {
    const reason = String(answer.why);
    return reason.startsWith("conflict/") ? reason : `not-continued/${reason}`;
  }
  return `${answer.kind}/${String(answer.code ?? answer.why)}`;
}

describe("LIVE-4 L4-7 §4: precedence when several artifacts are unreadable", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly over: Parameters<typeof writeMoneyGameOnDisk>[2]; readonly session: string; readonly money: string }> = [
    { name: "a newer build's log + a damaged financial record", over: { log: logText(storedLog(2)) + NEWER_LOG_LINE, fin: JSON.stringify(dealtFin("g_x", PIN)).slice(0, 60) }, session: "not-continued/newer-format", money: "malformed" },
    { name: "a newer build's log + an older financial record", over: { log: logText(storedLog(2)) + NEWER_LOG_LINE, fin: "older" }, session: "not-continued/newer-format", money: "older-format" },
    { name: "a newer build's log + a newer financial record", over: { log: logText(storedLog(2)) + NEWER_LOG_LINE, fin: "newer" }, session: "not-continued/newer-format", money: "newer-format" },
    { name: "newer chain intents + a damaged ticket ledger", over: { intents: "newer", tickets: "{\"format\":\"gs-wallet-tickets\",\"ver" }, session: "not-continued/newer-format", money: "newer-format" },
    { name: "corrupt chain intents + a damaged financial record", over: { intents: "corrupt", fin: JSON.stringify(dealtFin("g_x", PIN)).slice(0, 60) }, session: "not-continued/malformed", money: "malformed" },
  ];
  for (const c of cases) {
    test(`${c.name}: the session says ${c.session}, the money seam ${c.money} -- both not continued, deterministic, nothing written, and the operator is not told it is a defect`, () =>
      withDir("precedence", async (dir) => {
        const gameId = mintGameId();
        const fin = c.over.fin === "older" ? `${JSON.stringify({ ...dealtFin(gameId, PIN), version: FINANCIAL_VERSION - 1 })}\n` : c.over.fin === "newer" ? `${JSON.stringify({ ...dealtFin(gameId, PIN), version: FINANCIAL_VERSION + 1 })}\n` : c.over.fin;
        writeMoneyGameOnDisk(dir, gameId, { ...c.over, fin });
        const before = snapshot(dir);
        const serving = createMoneyServing({ capability: servingCapability([PIN]) });
        serving.recordChainFacts(chainRead(CANONICAL_CHECKSUM, PIN.denom));
        /* The operator's view, twice (deterministic), and the CLI's words. */
        const first = (await inspectContinuation(dir, { serving })).games.find((entry) => entry.gameId === gameId);
        const second = (await inspectContinuation(dir, { serving })).games.find((entry) => entry.gameId === gameId);
        assert.deepEqual(first, second, "the same answer every time");
        assert.equal(first?.class, c.session, "the session verdict (formats in artifact order: record, log, fin, tickets, intents)");
        assert.equal(first?.money_seam?.class, c.money, "the money seam (an unreadable financial record stops it before the log)");
        assert.equal(first?.money_seam?.agrees, true, "the same class of answer");
        assert.equal(first?.money_seam?.same_reason, `not-continued/${c.money}` === c.session);
        /* A running server (the session, at its load) and the coordinator's own seams over the same files. */
        const { server, port, coordinator } = await fileServer(dir, serving);
        try {
          assert.equal(await helloClass(port, gameId), c.session, "a real hello answers the session verdict");
          assert.equal(await helloClass(port, gameId), c.session, "and again");
          await coordinator.sweepLiveness([moneyRecord(gameId, PIN)]);
          const entries = storedLog(2);
          coordinator.onGameplayClosed({ gameId, record: moneyRecord(gameId, PIN), seal: sealOf(entries, true) as TerminalSeal, recovered: true, entries });
          await coordinator.drain();
          const decided = coordinator.moneyServingOf(gameId, DEALT);
          assert.ok(decided === undefined || decided.verdict.kind === "not-continued", "never continued, never a conflict");
        } finally {
          await stopServer(server);
        }
        assert.deepEqual(snapshot(dir), before, "not one byte, by any seam");
      }));
  }
});

/* ================================================================================================= */
/* §5 (brief §6). One capability per process: every consumer agrees on the key; BUILD_ID moves none    */
/* ================================================================================================= */

const START = path.join(__dirname, "..", "start.js");
const GAMES_DOCTOR = path.join(__dirname, "..", "tools", "gamesDoctor.js");

/** A development escrow configuration for the fixture pin, with development key files (the test secrets). */
function devEscrowConfig(dir: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const support = require("../escrow/escrow3bSupport") as typeof import("../escrow/escrow3bSupport");
  const keys = path.join(dir, "keys");
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(keys, "relayer.key"), support.RELAYER_SECRET.toString("hex"));
  fs.writeFileSync(path.join(keys, "settlement.key"), support.SETTLEMENT_SECRET.toString("hex"));
  fs.writeFileSync(path.join(keys, "admission.key"), support.ADMISSION_SECRET.toString("hex"));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { publicKeyOf } = require("../escrow/juno/secp256k1") as typeof import("../escrow/juno/secp256k1");
  const config = {
    format: "18COSMOS/JUNO-BACKEND/v2",
    chain_id: support.CHAIN_ID,
    network_class: "testnet",
    rest_endpoints: ["https://rest.invalid"],
    contract_address: support.CONTRACT,
    code_checksum: CANONICAL_CHECKSUM,
    wasm_admin: null,
    denom: "ujunox",
    asset_symbol: "JUNOX",
    relayer: { address: support.RELAYER_ADDRESS, signer: { kind: "development", key_file: path.join(keys, "relayer.key") } },
    settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(support.SETTLEMENT_SECRET).toString("hex"), signer: { kind: "development", key_file: path.join(keys, "settlement.key") } },
    admission_key: { public_key_hex: support.ADMISSION_PUBKEY, signer: { kind: "development", key_file: path.join(keys, "admission.key") } },
    trust: { operators: [support.RELAYER_ADDRESS], resolvers: [support.RELAYER_ADDRESS], min_challenge_window_secs: "60", min_liveness_window_secs: "3600", min_resolver_timeout_secs: "3600" },
    journal_dir: path.join(dir, "journal"),
    dev_signer: "allow-unprotected-testnet-key",
    request_timeout_ms: 1000,
  };
  const file = path.join(dir, "juno-config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

/** The operator environment a spawned tool sees: this process's, WITHOUT any variable that would outrank the flags a test
 *  passes (`start.ts` and gamesDoctor read `PORT`, `DATA_DIR`, `BUILD_ID`, `GS_MODE`, `ESCROW_JUNO_CONFIG` and
 *  `ESCROW_MONEY_TABLES` before their flags), plus `extra`. */
function operatorEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["PORT", "DATA_DIR", "BUILD_ID", "GS_MODE", "ESCROW_JUNO_CONFIG", "ESCROW_MONEY_TABLES"]) delete env[name];
  return { ...env, ...extra };
}

/** Start the compiled server as an operator does; resolves with its banner once the compatibility key is printed. */
async function startedProcess(data: string, env: Record<string, string>): Promise<{ child: ChildProcess; banner: string }> {
  const child = spawn(process.execPath, [START, "--mode", "development", "--data", data, "--port", "0"], { env: operatorEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  let banner = "";
  child.stdout?.on("data", (chunk) => (banner += String(chunk)));
  child.stderr?.on("data", (chunk) => (banner += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (!/compatibility key dc1-[0-9a-f]{24}/.test(banner)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill("SIGKILL");
      throw new Error(`the server did not print its key: ${banner.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, banner };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function statusKey(data: string): Promise<{ key: string; build: string }> {
  const file = path.join(data, "ops", "status.json");
  await until(() => {
    try {
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { compatibility?: unknown }).compatibility !== undefined;
    } catch {
      return false;
    }
  }, "ops/status.json with the compatibility block", 15_000);
  const status = JSON.parse(fs.readFileSync(file, "utf8")) as { compatibility: { compatibility_key: string; diagnostics: { build_id: string } } };
  return { key: status.compatibility.compatibility_key, build: status.compatibility.diagnostics.build_id };
}

function doctor(args: readonly string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require("child_process") as typeof import("child_process");
  const run = spawnSync(process.execPath, [GAMES_DOCTOR, ...args], { encoding: "utf8", env: operatorEnv(env) });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("LIVE-4 L4-7 §5: one capability, one key -- banner, ops/status.json, gamesDoctor, the money serving, sessions and client verdicts", () => {
  test("two real server processes per configuration (BUILD_ID a / b): banner = status = gamesDoctor compat, the same key across builds; the configured escrow deployment is a real axis and moves it", () =>
    withDir("processes", async (root) => {
      const configFile = devEscrowConfig(root);
      const seen: Array<{ config: string; build: string; banner: string; status: string; statusBuild: string; doctor: string }> = [];
      for (const config of ["none", "fixture-pin"] as const) {
        for (const build of ["cert-build-a", "cert-build-b"]) {
          const data = fs.mkdtempSync(path.join(root, `data-${config}-${build}-`));
          const env: Record<string, string> = { BUILD_ID: build, ...(config === "fixture-pin" ? { ESCROW_JUNO_CONFIG: configFile } : {}) };
          const { child, banner } = await startedProcess(data, env);
          try {
            const status = await statusKey(data);
            const ran = doctor(["compat", "--data", data, ...(config === "fixture-pin" ? ["--escrow-config", configFile] : []), "--build", build]);
            assert.equal(ran.status, 0, `gamesDoctor compat: ${ran.stderr}`);
            const tool = JSON.parse(ran.stdout) as { compatibility_key: string; diagnostics: { build_id: string } };
            assert.equal(tool.diagnostics.build_id, build, "gamesDoctor shows the build it was told, as a diagnostic");
            seen.push({ config, build, banner: (/compatibility key (dc1-[0-9a-f]{24})/.exec(banner) as RegExpExecArray)[1], status: status.key, statusBuild: status.build, doctor: tool.compatibility_key });
            assert.match(banner, new RegExp(`build "${build}" is diagnostic only`));
          } finally {
            await stopProcess(child);
          }
        }
      }
      for (const run of seen) {
        const expected = run.config === "none" ? KEY_NO_ESCROW : KEY_FIXTURE_PIN;
        assert.deepEqual([run.banner, run.status, run.doctor], [expected, expected, expected], `${run.config} / ${run.build}: banner, ops/status.json and gamesDoctor compat name one key`);
        assert.equal(run.statusBuild, run.build, "the build is shown, as a diagnostic");
      }
      assert.notEqual(KEY_NO_ESCROW, KEY_FIXTURE_PIN, "serving an escrow deployment is a semantic axis: it moves the key");
    }));

  test("in one process: the game server's capability (sessions and client verdicts) IS the money serving's; both key to the fixture pin; the status snapshot says the same key", async () => {
    const world = await moneyServer();
    try {
      assert.equal(world.server.lifecycle.capability, world.server.lifecycle.continuation.capability, "the wiring's validated capability is the one the server exposes");
      assert.equal(compatibilityKey(world.server.lifecycle.capability), compatibilityKey(world.service.serving.capability));
      assert.equal(compatibilityKey(world.service.serving.capability), KEY_FIXTURE_PIN);
      /* The client verdict is judged against `continuation.capability` (source pins, the two call sites), and the
         sessions ask the wiring's verdict (`continuation.sessionFor`) -- no second capability is constructed. */
      const server = code(source("server/src/gameServer.ts"));
      assert.match(server, /clientVerdict\(client, continuation\.capability, null\)/);
      assert.match(server, /clientVerdict\(client\.announcement, continuation\.capability, pin\)/);
      assert.match(server, /continuation: continuation\.sessionFor\(gameId\)/);
      assert.equal((server.match(/thisDeploymentCapability\(/g) ?? []).length, 1, "the one other construction: the no-escrow default when no capability is given");
      assert.match(server, /capability: options\.capability \?\? thisDeploymentCapability\(\[\]\)/);
      assert.equal(/thisDeploymentCapability\(/.test(code(source("server/src/start.ts"))), false, "start.ts constructs none");
      const described = compatibilityDescriptor(world.server.lifecycle.capability, { build_id: "whatever" });
      assert.equal(described.compatibility_key, KEY_FIXTURE_PIN);
    } finally {
      await world.close();
    }
  });

  test("every semantic axis moves the key; no diagnostic does (a build id cannot even be expressed in the capability)", () => {
    const base = thisDeploymentCapability([PIN]);
    const key = compatibilityKey(base);
    const moved = [
      { ...base, rules: { ...base.rules, current: 13, supported: [12, 13] } },
      { ...base, rules: { ...base.rules, certified: [11] } },
      { ...base, hosted_protocols: [1, 2] },
      { ...base, financial_protocols: [3, 4] },
      { ...base, client_protocols: [1] },
      { ...base, escrow_deployments: [] as never[], financial_protocols: [] as number[] },
      { ...base, escrow_abi_checksums: [...base.escrow_abi_checksums, "cd".repeat(32)] },
    ];
    for (const variant of moved) assert.notEqual(compatibilityKey(deploymentCapability(variant as typeof base)), key, JSON.stringify(variant).slice(0, 120));
    assert.throws(() => compatibilityKey({ ...base, build_id: "x" } as unknown as typeof base), /unknown field "build_id"/);
    assert.equal(compatibilityDescriptor(base, { build_id: "a" }).compatibility_key, compatibilityDescriptor(base, { build_id: "b" }).compatibility_key);
    /* A protocol-1 client: a different cb is the same answer; the capability's client protocols decide. */
    const announce = (cb: string) => clientCompatibility.parseClientAnnouncement({ cp: "1", cr: String(RULES_ENGINE_VERSION), cb });
    assert.deepEqual(clientCompatibility.clientVerdict(announce("a"), base, RULES_ENGINE_VERSION), clientCompatibility.clientVerdict(announce("b"), base, RULES_ENGINE_VERSION));
    assert.deepEqual(clientCompatibility.clientVerdict(announce("a"), base, RULES_ENGINE_VERSION), { kind: "ok" });
    assert.equal(DEPLOYMENT_CAPABILITY_FORMAT, "18COSMOS/DEPLOYMENT-CAPABILITY/v1");
  });
});

/* ================================================================================================= */
/* §6 (brief §7). The announcement at the edge: parsed once, by the one parser; the query must survive  */
/* ================================================================================================= */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

/** A seeded no-money game on disk (ALICE, BOB; dealt on another build than the server's), BOB on turn. */
function noMoneyGameOnDisk(dir: string, over: { readonly log?: (entries: ServerLogEntry[]) => ServerLogEntry[]; readonly tail?: string; readonly record?: (record: GameRecord) => unknown; readonly recordText?: string; readonly deal?: Record<string, unknown>; readonly rewrite?: (text: string) => string } = {}): string {
  const gameId = mintGameId();
  const base = storedLog(1).map((entry, at) => {
    if (at !== 0) return entry;
    const payload = JSON.parse(entry.payload) as { SetupGame: Record<string, unknown> };
    return { ...entry, payload: JSON.stringify({ SetupGame: { ...payload.SetupGame, build: "a-dealing-build", ...(over.deal ?? {}) } }) };
  });
  const log = over.log ? over.log(base) : base;
  const pin = (JSON.parse(log[0].payload) as { SetupGame: { rules_engine_version?: unknown } }).SetupGame.rules_engine_version;
  const record: GameRecord = { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: typeof pin === "number" ? pin : null, started_at: log[0].at ?? Date.now() } as GameRecord;
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  fs.writeFileSync(path.join(dir, "games", `${gameId}.json`), over.recordText ?? `${JSON.stringify(over.record ? over.record(record) : record)}\n`);
  const text = logText(log) + (over.tail ?? "");
  fs.writeFileSync(path.join(dir, `${gameId}.log.jsonl`), over.rewrite ? over.rewrite(text) : text);
  return gameId;
}

/** Spawn `server/playtest-proxy.js` in front of the game server. */
async function playtestProxy(gamePort: number): Promise<{ port: number; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, "server", "playtest-proxy.js")], { env: { ...process.env, PROXY_PORT: String(port), GAME_PORT: String(gamePort), APP_PORT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stdout?.on("data", (chunk) => (said += String(chunk)));
  await until(() => said.includes("playtest proxy on"), "the playtest proxy", 10_000);
  return { port, child };
}

/** An edge that FORWARDS THE PATH BUT DROPS THE QUERY (all but `dev_claim`): the failure mode LIVE-5 must not ship. */
function strippingEdge(gamePort: number): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://edge");
    const kept = new URLSearchParams();
    for (const claim of url.searchParams.getAll("dev_claim")) kept.append("dev_claim", claim);
    const upstream = net.connect(gamePort, "127.0.0.1", () => {
      const headers = Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`])).join("\r\n");
      upstream.write(`${req.method} ${url.pathname}?${kept.toString()} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((done) => server.close(() => done())) })));
}

/** A development tab through an edge: `/gs` with its claim and (optionally) its announcement on the URL. */
async function tabThrough(port: number, claim: string, announcement: string | null): Promise<Client> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebSocket } = require("ws") as typeof import("ws");
  const url = `ws://127.0.0.1:${port}/gs?dev_claim=${encodeURIComponent(claim)}${announcement === null ? "" : `&${announcement}`}`;
  const socket = new WebSocket(url, { origin: "http://localhost:3000" });
  return (Client as unknown as { connect(socket: unknown, claim: string): Promise<Client> }).connect(socket, claim);
}

describe("LIVE-4 L4-7 §6: the client announcement at the edge", () => {
  test("the server reads each connection's announcement exactly once, with the canonical parser -- whatever the socket then says", async () => {
    const original = clientCompatibility.parseClientAnnouncement;
    let calls = 0;
    (clientCompatibility as { parseClientAnnouncement: typeof original }).parseClientAnnouncement = (raw) => {
      calls += 1;
      return original(raw);
    };
    try {
      await withDir("parse-once", async (dir) => {
        const gameId = noMoneyGameOnDisk(dir);
        const { server, port } = await startServer({ store: createFileLogStore(dir, quiet), records: createFileRecordStore(dir, quiet), holds: createFileHoldStore(dir, quiet) } as Partial<GameServerOptions>);
        try {
          await server.lifecycle.ready;
          const tabs = [await Client.open(port, BOB, TAB), await Client.open(port, ALICE, TAB), await Client.open(port, ALICE)];
          for (const tab of tabs) {
            tab.hello(gameId);
            await tab.next((f) => f.kind === "catch-up", "a catch-up");
            tab.roomHello(gameId);
            tab.hello(gameId);
            tab.send({ kind: "rooms-watch", watch: true });
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(calls, 3, "three connections, three parses -- never one per frame");
          for (const tab of tabs) await tab.close();
        } finally {
          await stopServer(server);
        }
      });
    } finally {
      (clientCompatibility as { parseClientAnnouncement: typeof original }).parseClientAnnouncement = original;
    }
    assert.match(code(source("server/src/identity/authenticateUpgrade.ts")), /const announcement = parseClientAnnouncement\(rawClientAnnouncementOf\(query\)\);/);
  });

  test("LIVE-5's edge requirement, demonstrated: the playtest proxy keeps `/gs` query strings (a protocol-1 tab on another build plays); an edge that strips them turns the same tab into a legacy one (build-skew)", () =>
    withDir("edge", async (dir) => {
      const gameId = noMoneyGameOnDisk(dir);
      const { server, port } = await startServer({ store: createFileLogStore(dir, quiet), records: createFileRecordStore(dir, quiet), holds: createFileHoldStore(dir, quiet) } as Partial<GameServerOptions>);
      const proxy = await playtestProxy(port);
      const stripping = await strippingEdge(port);
      try {
        await server.lifecycle.ready;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { isGame } = require(path.join(REPO, "server", "playtest-proxy.js")) as { isGame(url: string): boolean };
        assert.equal(isGame(`/gs?dev_claim=x&${TAB}`), true, "the proxy routes `/gs` with its query to the game server");
        const through = await tabThrough(proxy.port, BOB, TAB);
        through.hello(gameId);
        const caught = await through.next((f) => f.kind === "catch-up" || f.kind === "incompatible", "the hello through the proxy");
        assert.equal(caught.kind, "catch-up");
        through.submit(BUY, { baseIndex: lastIndex(caught), submissionId: "proxied", build: "tab-other-build" });
        assert.equal((await through.answerTo("proxied")).kind, "applied", "the announcement arrived: judged as protocol 1, its build never compared");
        await through.close();
        const stripped = await tabThrough(stripping.port, ALICE, TAB);
        stripped.hello(gameId);
        const seen = await stripped.next((f) => f.kind === "catch-up", "the hello through the stripping edge");
        stripped.submit(BUY, { baseIndex: lastIndex(seen), submissionId: "stripped", build: "tab-other-build" });
        const answer = await stripped.answerTo("stripped");
        assert.equal(answer.kind, "build-skew", "the same tab, its query stripped, reads as protocol 0: every rolling deploy would look like build skew");
        assert.equal(stripped.frames.some((f) => f.kind === "reload" || f.kind === "route"), false);
        await stripped.close();
        /* The requirement is written down where LIVE-5 will read it. */
        assert.match(source("LIVE4_COMPATIBILITY_MODEL.md"), /HARD REQUIREMENT — the edge must preserve the query string on `\/gs\*`/);
        assert.match(source("PROJECT_CANONICAL_CONTEXT.md"), /The edge in front of the game server must forward `\/gs\*` query strings unchanged/);
      } finally {
        proxy.child.kill("SIGTERM");
        await stripping.close();
        await stopServer(server);
      }
    }));
});

/* ================================================================================================= */
/* §7 (brief §8). Stored data: every class, served, swept, inspected and restarted -- bytes hashed     */
/* ================================================================================================= */

/** What one Juno REST node answers to the five reads of a verification-grade read. */
interface NodeAnswer {
  readonly checksum?: string;
  readonly denom?: string;
  readonly down?: boolean;
}

/** What a run reads from the chain before it serves: nothing, a read that agrees with the binding, one that contradicts
 *  it (code or denom), or a REAL verification-grade read over configured endpoints answering as given. */
type ChainPlan = "none" | "agree" | "contradict-code" | "contradict-denom" | { readonly endpoints: Readonly<Record<string, NodeAnswer>> };

const ENDPOINT_A = "https://a.example";
const ENDPOINT_B = "https://b.example";

/** L4-4's verification-grade read (`readVerifiedChainFacts` over `createJunoRest`), against nodes answering as given. */
async function endpointRead(answers: Readonly<Record<string, NodeAnswer>>): Promise<ChainFactsRead> {
  const response = (await makeWorld().chain.smart(CONTRACT, QUERY.config())) as { readonly config: Record<string, unknown> };
  const http: HttpTransport = async (request) => {
    const base = Object.keys(answers).find((prefix) => request.url.startsWith(prefix));
    if (base === undefined) throw new JunoRpcError("unavailable", "no such node");
    const node = answers[base];
    if (node.down === true) throw new JunoRpcError("unavailable", "the node is down");
    const route = request.url.slice(base.length);
    const ok = (json: unknown) => ({ status: 200, text: JSON.stringify(json) });
    if (route === "/cosmos/base/tendermint/v1beta1/node_info") return ok({ default_node_info: { network: CHAIN_ID } });
    if (route === "/cosmos/base/tendermint/v1beta1/syncing") return ok({ syncing: false });
    if (route === `/cosmwasm/wasm/v1/contract/${CONTRACT}`) return ok({ address: CONTRACT, contract_info: { code_id: "4242" } });
    if (route === "/cosmwasm/wasm/v1/code-info/4242") return ok({ checksum: node.checksum ?? CANONICAL_CHECKSUM });
    if (route.startsWith(`/cosmwasm/wasm/v1/contract/${CONTRACT}/smart/`)) return ok({ data: { ...response, config: { ...response.config, denom: node.denom ?? PIN.denom } } });
    return { status: 404, text: JSON.stringify({ code: 5, message: "not found" }) };
  };
  const rest = createJunoRest({ endpoints: Object.keys(answers), expectedChainId: CHAIN_ID, allowInsecureLocalHttp: false, timeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxCodeBytes: 1024 }, http);
  return readVerifiedChainFacts(PIN, rest, () => T0);
}

/** Record what `plan` reads into `serving` exactly as the escrow service does (`recordChainFacts`); the read's kind. */
async function readChain(serving: MoneyServing, plan: ChainPlan): Promise<string> {
  if (plan === "none") return "none";
  const read: ChainFactsRead =
    plan === "agree"
      ? chainRead(CANONICAL_CHECKSUM, PIN.denom)
      : plan === "contradict-code"
        ? chainRead(OTHER_CHECKSUM, PIN.denom)
        : plan === "contradict-denom"
          ? chainRead(CANONICAL_CHECKSUM, "uother")
          : await endpointRead(plan.endpoints);
  serving.recordChainFacts(read);
  return read.kind;
}

interface StoredCase {
  readonly name: string;
  /** Writes the game's files; returns its id. */
  readonly setup: (dir: string) => string;
  /** The escrow deployments the pool serves (none: a pool with no escrow configured). */
  readonly serves?: readonly FinancialDeploymentPin[];
  readonly chain?: ChainPlan;
  /** What the restarted process reads (default: the same as the first). */
  readonly restartChain?: ChainPlan;
  readonly pool?: PoolServingState;
  /** gamesDoctor continuation's class, and (money) the money seam's own class. */
  readonly doctor: string;
  readonly seam?: string;
  /** A current (protocol 1, another build) tab's hello on the first boot, and after the restart (default: the same). */
  readonly hello: string;
  readonly helloAfterRestart?: string;
  /** BOB (on turn) moves once after the hello: the game is not only listed, it is played. */
  readonly play?: boolean;
  /** Every path the FIRST boot changes (`{id}` = the game id; a directory ends in `/`); the restart must change none. */
  readonly writes: readonly string[];
  /** gamesDoctor's "the log is DAMAGED" flag (default false). */
  readonly damagedLog?: boolean;
  /** What the first boot's writes must say (run after it, before the restart). */
  readonly check?: (dir: string, gameId: string) => Promise<void> | void;
}

const LOG = "{id}.log.jsonl";
const FIN = "games/money/{id}.json";

/** A money table on disk (ALICE host, BOB on turn): the money GameRecord, a one-move log, and what `over` says. */
function moneyGame(over: Omit<Parameters<typeof writeMoneyGameOnDisk>[2], "fin"> & { readonly fin?: "dealt" | "fresh" | "missing" | "newer" | "older" | "unreadable" | FinancialGameRecord | ((gameId: string) => FinancialGameRecord) } = {}) {
  return (dir: string): string => {
    const gameId = mintGameId();
    const fin =
      over.fin === undefined || over.fin === "dealt"
        ? undefined
        : over.fin === "fresh"
          ? `${JSON.stringify(freshDealtFin(gameId))}\n`
          : over.fin === "missing"
          ? null
          : over.fin === "newer"
            ? `${JSON.stringify({ ...dealtFin(gameId, PIN), version: FINANCIAL_VERSION + 1 })}\n`
            : over.fin === "older"
              ? `${JSON.stringify({ ...dealtFin(gameId, PIN), version: FINANCIAL_VERSION - 1 })}\n`
              : over.fin === "unreadable"
                ? JSON.stringify(dealtFin(gameId, PIN)).slice(0, 60)
                : `${JSON.stringify(typeof over.fin === "function" ? over.fin(gameId) : over.fin)}\n`;
    writeMoneyGameOnDisk(dir, gameId, { log: logText(storedLog(1)), ...over, fin });
    return gameId;
  };
}

/** A dealt financial record whose last gameplay is NOW (the fixture's `dealtFin` is dated T0, long past the liveness
 *  notice period, so a pool that continues it moves it to `liveness` at its first sweep -- a lifecycle write). */
function freshDealtFin(gameId: string): FinancialGameRecord {
  const now = Date.now();
  const moved = transitionFinancial(newFinancialRecord(gameId, currentMoneyContinuation(), now - 1, PIN), { kind: "dealt", at: now });
  assert.equal(moved.kind, "moved");
  return (moved as { next: FinancialGameRecord }).next;
}

/** A financial-protocol-2 ticket ledger (every grant ESCROW-3B's shape): an earlier build's, `older-unread`. */
function olderTicketLedger(gameId: string): string {
  const grant = { format: "gs-wallet-ticket", game_id: gameId, player_id: "p-bob", epoch: 1, wallet: WALLETS[1], ticket: "a".repeat(64), issued_at: T0, issued_under: { principal_id: "pr", family_id: "fa", recovery_selector: "rs" }, revoked_at: null, revoke_reason: null, frozen_at: null };
  return `${JSON.stringify({ format: "gs-wallet-tickets", version: 1, game_id: gameId, document: { frozen_at: null, grants: [grant] } })}\n`;
}

async function runStoredCase(c: StoredCase): Promise<void> {
  await withDir("stored", async (dir) => {
    const gameId = c.setup(dir);
    const servingFor = async (plan: ChainPlan | undefined): Promise<MoneyServing> => {
      const serving = createMoneyServing({ capability: servingCapability([...(c.serves ?? [])]) });
      await readChain(serving, plan ?? "none");
      return serving;
    };
    const over: Partial<GameServerOptions> = c.pool !== undefined ? { pool: () => c.pool as PoolServingState } : {};
    const before = snapshot(dir);

    /* 1. The operator, read-only, before any server. */
    const seen = (await inspectContinuation(dir, { serving: await servingFor(c.chain) })).games.find((game) => game.gameId === gameId);
    assert.equal(seen?.class, c.doctor, "gamesDoctor continuation");
    assert.equal(seen?.damaged_log, c.damagedLog ?? false, "gamesDoctor's damaged-log flag");
    if (c.seam !== undefined) {
      assert.equal(seen?.money_seam?.class, c.seam, "the money seam's own class");
      assert.equal(seen?.money_seam?.agrees, true, "the same class of answer as the session");
    }
    assert.deepEqual(snapshot(dir), before, "gamesDoctor continuation wrote nothing");

    /* 2. A server as start.ts assembles one (its startup walk included); a current tab from another build; a move. */
    const first = await fileServer(dir, await servingFor(c.chain), over);
    try {
      assert.equal(await helloClass(first.port, gameId), c.hello, "the hello");
      if (c.play === true) {
        const { client, answer } = await tabAt(first.port, BOB, gameId);
        client.submit(BUY, { baseIndex: lastIndex(answer), submissionId: "played" });
        assert.equal((await client.answerTo("played")).kind, "applied", "continued: played");
        await client.close();
      }
      await first.coordinator.sweepLiveness(first.server.lifecycle.financialRecords());
      await first.coordinator.drain();
      assert.equal(await helloClass(first.port, gameId, ALICE), c.hello, "a second tab (the other seat) gets the same answer");
    } finally {
      await stopServer(first.server);
    }
    const afterFirst = snapshot(dir);
    const written = changed(before, afterFirst);
    const shown = written.filter((p) => !p.endsWith("/") && !p.endsWith(".log.jsonl") && fs.existsSync(path.join(dir, p))).map((p) => `${p}: ${fs.readFileSync(path.join(dir, p), "utf8").slice(0, 1500)}`);
    assert.deepEqual(written, [...c.writes].map((p) => p.split("{id}").join(gameId)).sort(), `exactly these paths were written\n${shown.join("\n")}`);
    await c.check?.(dir, gameId);

    /* 3. The restart: a new process (nothing remembered but the disk), the same configuration. */
    const second = await fileServer(dir, await servingFor(c.restartChain ?? c.chain), over);
    try {
      assert.equal(await helloClass(second.port, gameId), c.helloAfterRestart ?? c.hello, "the hello after the restart");
      await second.coordinator.sweepLiveness(second.server.lifecycle.financialRecords());
      await second.coordinator.drain();
    } finally {
      await stopServer(second.server);
    }
    assert.deepEqual(changed(afterFirst, snapshot(dir)), [], "the restart wrote nothing: no derived answer became a hold, no hold was written twice");
  });
}

describe("LIVE-4 L4-7 §7: the stored-data matrix -- every class over file stores, the operator, a server, its sweeps and a restart; bytes hashed", () => {
  const HOUR = 60 * 60 * 1000;
  const noMoney: readonly StoredCase[] = [
    { name: "no money: current (dealt on this build)", setup: (dir) => noMoneyGameOnDisk(dir, { deal: { build: BUILD } }), doctor: "continues", hello: "continues", play: true, writes: [LOG] },
    { name: "no money: dealt on another build (a protocol-1 tab on a third build)", setup: (dir) => noMoneyGameOnDisk(dir), doctor: "continues", hello: "continues", play: true, writes: [LOG] },
    { name: "no money: an older rules pin (10) this pool does not play", setup: (dir) => noMoneyGameOnDisk(dir, { deal: { rules_engine_version: 10 } }), doctor: "not-continued/rules-not-supported", hello: "not-continued/rules-not-supported", writes: [] },
    /* Route v12 R12-2 made 12 this build's own engine and W3-K made it 13, so "newer" is read off the engine: the next
       version, which this build neither plays nor certifies (a stale constant, not a certification change). */
    { name: `no money: a newer rules pin (${RULES_ENGINE_VERSION + 1})`, setup: (dir) => noMoneyGameOnDisk(dir, { deal: { rules_engine_version: RULES_ENGINE_VERSION + 1 } }), doctor: "not-continued/rules-not-supported", hello: "not-continued/rules-not-supported", writes: [] },
    { name: "no money: an unsupported hosted protocol (2)", setup: (dir) => noMoneyGameOnDisk(dir, { deal: { hosted_protocol: 2 } }), doctor: "not-continued/hosted-protocol", hello: "not-continued/hosted-protocol", writes: [] },
    /* A GameRecord this build cannot read authorizes nobody (LIVE-3C): a hello is `not-found`, exactly as for no game.
       A newer schema is derived (discovery: incompatible record-schema-newer, nothing written); damage is held once. */
    { name: "no money: a newer GameRecord (record_schema 3)", setup: (dir) => noMoneyGameOnDisk(dir, { record: (record) => ({ ...record, record_schema: 3 }) }), doctor: "record-newer-format", hello: "error/not-found", writes: [] },
    { name: "no money: a newer build's complete log record at the end (N-3)", setup: (dir) => noMoneyGameOnDisk(dir, { tail: NEWER_LOG_LINE }), doctor: "not-continued/newer-format", hello: "not-continued/newer-format", writes: [] },
    { name: "no money: a malformed GameRecord (damage: held once, durably)", setup: (dir) => noMoneyGameOnDisk(dir, { recordText: "{\"record_schema\":1," }), doctor: "record-malformed", hello: "error/not-found", writes: ["games/holds/", "games/holds/{id}.json"] },
    {
      name: "no money: a malformed log (damage before the end: held once, durably)",
      /* LIVE-3B's shape (fileLogStore test 8): a line that is not an entry, with a whole later batch after it that cannot
         be the batch in flight -- acknowledged history behind damage. */
      setup: (dir) =>
        noMoneyGameOnDisk(dir, {
          log: () => storedLog(3),
          rewrite: (text) =>
            text
              .split("\n")
              .map((line, at) => (at === 2 ? "this line is not a log record" : line))
              .join("\n"),
        }),
      doctor: "continues",
      damagedLog: true,
      hello: "error/held",
      writes: ["games/holds/", "games/holds/{id}.json"],
    },
    { name: "no money: a torn tail (an incomplete last line) -- recovered by truncation, then played", setup: (dir) => noMoneyGameOnDisk(dir, { tail: "{\"format\":\"gs-log\",\"sch" }), doctor: "continues", hello: "continues", play: true, writes: [LOG] },
    { name: "no money: a draining pool, before its drain deadline", setup: (dir) => noMoneyGameOnDisk(dir), pool: { role: "draining", flipped_at: Date.now() - HOUR }, doctor: "continues", hello: "continues", play: true, writes: [LOG] },
    { name: "no money: a draining pool, after its drain deadline", setup: (dir) => noMoneyGameOnDisk(dir), pool: { role: "draining", flipped_at: Date.now() - NO_MONEY_DRAIN_MS - HOUR }, doctor: "continues", hello: "not-continued/drain-expired", writes: [] },
  ];
  const money: readonly StoredCase[] = [
    { name: "money: current, the chain read and agreeing", setup: moneyGame({ fin: "fresh" }), serves: [PIN], chain: "agree", doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
    {
      name: "money: current but idle past the liveness notice period -- the owner's lifecycle moves on (the one write; the same stale record is never touched where the game is not continued)",
      setup: moneyGame(),
      serves: [PIN],
      chain: "agree",
      doctor: "continues",
      seam: "continued",
      hello: "continues",
      writes: [FIN],
      check: async (dir, gameId) => {
        const record = await createFileFinancialGameStore(dir, quiet).load(gameId);
        assert.deepEqual([record?.phase, record?.hold, record?.transitions.at(-1)?.why], ["liveness", null, "no gameplay for the liveness notice period"], "a lifecycle transition, never a hold");
      },
    },
    { name: "money: another deployment (this pool serves another contract)", setup: moneyGame(), serves: [PIN_B], chain: "none", doctor: "not-continued/deployment-unavailable", seam: "deployment-unavailable", hello: "not-continued/deployment-unavailable", writes: [] },
    { name: "money: a configuration typo (the denom), the chain unread", setup: moneyGame(), serves: [PIN_TYPO], chain: "none", doctor: "not-continued/deployment-unverified", seam: "deployment-unverified", hello: "not-continued/deployment-unverified", writes: [] },
    { name: "money: a configuration typo, the chain read and agreeing with the GAME", setup: moneyGame(), serves: [PIN_TYPO], chain: "agree", doctor: "not-continued/deployment-unverified", seam: "deployment-unverified", hello: "not-continued/deployment-unverified", writes: [] },
    { name: "money: the chain unavailable (nothing read this run)", setup: moneyGame({ fin: "fresh" }), serves: [PIN], chain: "none", doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
    { name: "money: one endpoint unavailable, the other reporting OTHER code (never one failover answer)", setup: moneyGame({ fin: "fresh" }), serves: [PIN], chain: { endpoints: { [ENDPOINT_A]: { checksum: OTHER_CHECKSUM }, [ENDPOINT_B]: { down: true } } }, doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
    { name: "money: the endpoints disagree about the code", setup: moneyGame({ fin: "fresh" }), serves: [PIN], chain: { endpoints: { [ENDPOINT_A]: { checksum: OTHER_CHECKSUM }, [ENDPOINT_B]: {} } }, doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
    { name: "money: both endpoints agree and contradict the code -- a verified checksum conflict; restarted with the chain unread", setup: moneyGame(), serves: [PIN], chain: { endpoints: { [ENDPOINT_A]: { checksum: OTHER_CHECKSUM }, [ENDPOINT_B]: { checksum: OTHER_CHECKSUM } } }, restartChain: "none", doctor: "conflict/deployment-conflict", seam: "conflict", hello: "conflict/deployment-conflict", helloAfterRestart: "not-continued/deployment-unverified", writes: [FIN] },
    { name: "money: a verified denom conflict; restarted with the chain read again", setup: moneyGame(), serves: [PIN], chain: "contradict-denom", doctor: "conflict/deployment-conflict", seam: "conflict", hello: "conflict/deployment-conflict", writes: [FIN] },
    { name: "money: the financial record missing (the owner writes ESCROW-3A's placeholder, once)", setup: moneyGame({ fin: "missing" }), serves: [PIN], chain: "agree", doctor: "conflict/financial-record-missing", seam: "conflict", hello: "conflict/financial-record-missing", helloAfterRestart: "not-continued/malformed", writes: ["games/money/", FIN] },
    { name: "money: a newer financial record", setup: moneyGame({ fin: "newer" }), serves: [PIN], chain: "agree", doctor: "not-continued/newer-format", seam: "newer-format", hello: "not-continued/newer-format", writes: [] },
    { name: "money: an older financial record", setup: moneyGame({ fin: "older" }), serves: [PIN], chain: "agree", doctor: "not-continued/older-format", seam: "older-format", hello: "not-continued/older-format", writes: [] },
    { name: "money: an unreadable financial record", setup: moneyGame({ fin: "unreadable" }), serves: [PIN], chain: "agree", doctor: "not-continued/malformed", seam: "malformed", hello: "not-continued/malformed", writes: [] },
    { name: "money: a newer build's chain intents", setup: moneyGame({ intents: "newer" }), serves: [PIN], chain: "agree", doctor: "not-continued/newer-format", seam: "newer-format", hello: "not-continued/newer-format", writes: [] },
    { name: "money: corrupt chain intents", setup: moneyGame({ intents: "corrupt" }), serves: [PIN], chain: "agree", doctor: "not-continued/malformed", seam: "malformed", hello: "not-continued/malformed", writes: [] },
    { name: "money: an older (financial protocol 2) ticket ledger", setup: (dir) => { const gameId = moneyGame()(dir); fs.mkdirSync(path.join(dir, "games", "wallet-tickets"), { recursive: true }); fs.writeFileSync(path.join(dir, "games", "wallet-tickets", `${gameId}.json`), olderTicketLedger(gameId)); return gameId; }, serves: [PIN], chain: "agree", doctor: "not-continued/older-format", seam: "older-format", hello: "not-continued/older-format", writes: [] },
    { name: "money: a current ticket ledger", setup: (dir) => { const gameId = moneyGame({ fin: "fresh" })(dir); fs.mkdirSync(path.join(dir, "games", "wallet-tickets"), { recursive: true }); fs.writeFileSync(path.join(dir, "games", "wallet-tickets", `${gameId}.json`), `${JSON.stringify({ format: "gs-wallet-tickets", version: 1, game_id: gameId, document: { frozen_at: null, grants: [] } })}\n`); return gameId; }, serves: [PIN], chain: "agree", doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
    { name: "money: held (journal-ahead) -- gameplay continues while signing waits", setup: moneyGame({ fin: (gameId) => heldFin(dealtFin(gameId, PIN), "journal-ahead", "the journal is ahead") }), serves: [PIN], chain: "agree", doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
    { name: "money: held (journal-ahead), the chain unread -- still played (the restart rule is the deployment conflict's alone)", setup: moneyGame({ fin: (gameId) => heldFin(freshDealtFin(gameId), "journal-ahead", "the journal is ahead") }), serves: [PIN], chain: "none", doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
    { name: "money: held for a deployment conflict, the chain unread (L4-7)", setup: moneyGame({ fin: (gameId) => heldFin(dealtFin(gameId, PIN), "binding-mismatch", "deployment-conflict: before the restart") }), serves: [PIN], chain: "none", doctor: "not-continued/deployment-unverified", seam: "deployment-unverified", hello: "not-continued/deployment-unverified", writes: [] },
    { name: "money: a draining pool long after its flip (money is never timed out)", setup: moneyGame({ fin: "fresh" }), serves: [PIN], chain: "agree", pool: { role: "draining", flipped_at: Date.now() - NO_MONEY_DRAIN_MS - HOUR }, doctor: "continues", seam: "continued", hello: "continues", play: true, writes: [LOG] },
  ];
  for (const c of [...noMoney, ...money]) test(c.name, () => runStoredCase(c));
});

/* ================================================================================================= */
/* §7b. The conflict release path, end to end: the owner holds; the operator releases; play resumes    */
/* ================================================================================================= */

describe("LIVE-4 L4-7 §7b: a verified conflict's release path, end to end over file stores", () => {
  test("the owner holds (one write); every release that is not backed by an agreeing verification-grade read is refused and writes nothing; the agreeing one releases (one write); the next process continues and plays the game", () =>
    withDir("release", async (dir) => {
      const gameId = moneyGame({ fin: "fresh" })(dir);
      const servingWith = async (plan: ChainPlan) => {
        const serving = createMoneyServing({ capability: servingCapability([PIN]) });
        await readChain(serving, plan);
        return serving;
      };
      const start = snapshot(dir);
      /* 1. The chain contradicts the binding at verification grade: the owner holds it. */
      const first = await fileServer(dir, await servingWith("contradict-code"));
      try {
        assert.equal(await helloClass(first.port, gameId), "conflict/deployment-conflict");
      } finally {
        await stopServer(first.server);
      }
      const held = snapshot(dir);
      assert.deepEqual(changed(start, held), [`games/money/${gameId}.json`], "the hold, and nothing else");
      const record = await createFileFinancialGameStore(dir, quiet).load(gameId);
      assert.deepEqual([record?.phase, record?.hold?.code], ["held", "binding-mismatch"]);
      /* 2. The operator (server stopped): refused without a read, refused against a read that still contradicts. */
      const ops = createMemoryOpsRecorder();
      const release = async (plan: ChainPlan) => withLock(dir, async (lock) => releaseMoneyHold(dir, gameId, "the contract reports the bound code again", { lock, ops, serving: await servingWith(plan) }));
      for (const plan of ["none", "contradict-code", "contradict-denom", { endpoints: { [ENDPOINT_A]: {}, [ENDPOINT_B]: { down: true } } }] as const) {
        const refused = (await release(plan)) as { ok: boolean; reason?: string };
        assert.equal(refused.ok, false, JSON.stringify(plan));
      }
      assert.deepEqual(snapshot(dir), held, "every refused release wrote nothing");
      /* 3. A verification-grade read over both endpoints that agrees with the binding: released. */
      assert.deepEqual(await release({ endpoints: { [ENDPOINT_A]: {}, [ENDPOINT_B]: {} } }), { ok: true, to: "in-progress" });
      const released = snapshot(dir);
      assert.deepEqual(changed(held, released), [`games/money/${gameId}.json`], "the release writes the financial record, and only it");
      /* 4. The next process, the chain agreeing: continued and played. */
      const second = await fileServer(dir, await servingWith("agree"));
      try {
        const bob = await tabAt(second.port, BOB, gameId);
        assert.equal(bob.answer.kind, "catch-up");
        bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "after-release" });
        assert.equal((await bob.client.answerTo("after-release")).kind, "applied");
        await bob.client.close();
      } finally {
        await stopServer(second.server);
      }
      assert.deepEqual(changed(released, snapshot(dir)), [`${gameId}.log.jsonl`], "played: the move, and nothing else");
    }));
});

describe("LIVE-4 L4-7 §7c: a superseded hold's release", () => {
  test("a journal-ahead hold superseded by a verified conflict is released only against an agreeing verification-grade read -- refused without one and against a contradicting one, nothing written -- and the release returns the game to the phase it was first held from", () =>
    withDir("release-superseded", async (dir) => {
      const gameId = mintGameId();
      const journal = heldFin(freshDealtFin(gameId), "journal-ahead", "the journal is ahead");
      const superseded = transitionFinancial(journal, { kind: "hold", at: Date.now(), code: "binding-mismatch", detail: "deployment-conflict: the chain reports other code", verifiedConflict: true });
      assert.equal(superseded.kind, "moved");
      writeMoneyGameOnDisk(dir, gameId, { log: logText(storedLog(1)), fin: `${JSON.stringify((superseded as { next: FinancialGameRecord }).next)}\n` });
      const before = snapshot(dir);
      const ops = createMemoryOpsRecorder();
      const release = async (plan: ChainPlan) => {
        const serving = createMoneyServing({ capability: servingCapability([PIN]) });
        await readChain(serving, plan);
        return (await withLock(dir, (lock) => releaseMoneyHold(dir, gameId, "the contract reports the bound code again", { lock, ops, serving }))) as { ok: boolean; reason?: string; to?: string };
      };
      const unread = await release("none");
      assert.equal(unread.ok, false);
      assert.match(unread.reason ?? "", /released only against a verification-grade chain read/);
      const contradicted = await release("contradict-code");
      assert.deepEqual([contradicted.ok, /conflict: deployment-conflict/.test(contradicted.reason ?? "")], [false, true]);
      assert.deepEqual(snapshot(dir), before, "every refused release wrote nothing");
      assert.deepEqual(await release({ endpoints: { [ENDPOINT_A]: {}, [ENDPOINT_B]: {} } }), { ok: true, to: "in-progress" });
      assert.deepEqual(changed(before, snapshot(dir)), [`games/money/${gameId}.json`]);
      const audit = ops.lines.find((line) => line.event === "money.released" && line.game_id === gameId);
      assert.deepEqual([audit?.code, audit?.superseded], ["binding-mismatch", "journal-ahead"], "one decision lifts both holds, and the audit names both");
      /* Only the deployment-conflict code supersedes, whoever passes the flag. */
      assert.equal(transitionFinancial(journal, { kind: "hold", at: Date.now(), code: "seal-conflict", detail: "x", verifiedConflict: true }).kind, "same");
    }));
});

/* ================================================================================================= */
/* §8 (brief §9). Restart and reconnect: no derived answer becomes a hold; no conflict disappears      */
/* ================================================================================================= */

const noLive4Frame = (frames: readonly Frame[]) => frames.filter((frame) => frame.kind === "reload" || frame.kind === "route").map((frame) => frame.kind);

describe("LIVE-4 L4-7 §8: the restart and reconnect matrix", () => {
  test("no money, over file stores: a reconnect and a restart change no answer; a move retried after the restart is not a second move; the legacy wire keeps exact-build behaviour throughout (never reload, route or 4426); a reload fixes only what a reload can", () =>
    withDir("reconnect", async (dir) => {
      const gameId = noMoneyGameOnDisk(dir); // dealt on another build; BOB on turn
      const logFile = path.join(dir, `${gameId}.log.jsonl`);
      const noMoney = () => createMoneyServing({ capability: servingCapability([]) });
      const legacy: Client[] = [];
      let beforeRetry = -1;
      const first = await fileServer(dir, noMoney());
      try {
        /* A protocol-1 tab on another build moves. */
        const bob = await tabAt(first.port, BOB, gameId);
        assert.equal(bob.answer.kind, "catch-up");
        bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "bob-1", build: "tab-other-build" });
        assert.equal((await bob.client.answerTo("bob-1")).kind, "applied");
        /* A browser reconnect: a new socket; the history is the same history. */
        await bob.client.close();
        const reconnected = await tabAt(first.port, BOB, gameId);
        assert.deepEqual([reconnected.answer.kind, lastIndex(reconnected.answer)], ["catch-up", 2]);
        await reconnected.client.close();
        /* The legacy wire (protocol 0): a stale bundle's submit is build-skew; this build's own bundle plays. */
        const stale = await Client.open(first.port, ALICE);
        legacy.push(stale);
        stale.hello(gameId);
        const staleSeen = await stale.next((f) => f.kind === "catch-up", "the legacy catch-up");
        stale.submit(BUY, { baseIndex: lastIndex(staleSeen), submissionId: "stale-1", build: "an-older-bundle" });
        assert.equal((await stale.answerTo("stale-1")).kind, "build-skew", "protocol 0: the exact-build comparison, as before LIVE-4");
        const current = await Client.open(first.port, ALICE);
        legacy.push(current);
        current.hello(gameId);
        const currentSeen = await current.next((f) => f.kind === "catch-up", "the legacy catch-up");
        current.submit(BUY, { baseIndex: lastIndex(currentSeen), submissionId: "alice-1" });
        assert.equal((await current.answerTo("alice-1")).kind, "applied", "protocol 0 on this build's own bundle plays");
        /* A reload fixes what a reload can: a protocol-1 tab that lacks the game's rules is told `reload` (and 4426);
           the reloaded bundle's tab (this release's announcement) plays. */
        const lacking = await Client.open(first.port, BOB, clientCompatibility.clientAnnouncementQuery(1, [10], "an-old-bundle"));
        lacking.hello(gameId);
        assert.equal(await lacking.closed, CLIENT_ANSWER_CLOSE_CODE);
        assert.deepEqual(lacking.frames.map((f) => [f.kind, f.code]), [["reload", "client-rules"]]);
        /* ADMISSION, then the process stops before the tab trusts anything more: the move is applied (the durable
           append is the commit point, the answer only news). */
        const bob2 = await tabAt(first.port, BOB, gameId);
        beforeRetry = lastIndex(bob2.answer);
        bob2.client.submit(BUY, { baseIndex: beforeRetry, submissionId: "bob-2", build: "tab-other-build" });
        assert.equal((await bob2.client.answerTo("bob-2")).kind, "applied");
      } finally {
        await stopServer(first.server);
      }
      const logAfterFirst = fs.readFileSync(logFile);
      const afterFirst = snapshot(dir);
      assert.deepEqual(noLive4Frame(legacy.flatMap((client) => client.frames)), [], "the legacy wire saw no LIVE-4 frame");

      /* THE RESTART. */
      const second = await fileServer(dir, noMoney());
      try {
        /* BOB's browser reconnects and RETRIES the move it never saw answered: a catch-up that contains it. */
        const bob = await tabAt(second.port, BOB, gameId);
        bob.client.submit(BUY, { baseIndex: beforeRetry, submissionId: "bob-2", build: "tab-other-build" });
        const retried = await bob.client.answerTo("bob-2");
        assert.equal(retried.kind, "catch-up", "a retry is not a second move");
        assert.equal((retried.entries as SeenEntry[]).filter((entry) => entry.submission_id === "bob-2").length, 1, "the retry learns its move landed");
        await bob.client.close();
        /* The stale legacy bundle after the restart: still build-skew; still no LIVE-4 frame; its socket stays open. */
        const stale = await Client.open(second.port, ALICE);
        stale.hello(gameId);
        const seen = await stale.next((f) => f.kind === "catch-up", "the legacy catch-up");
        stale.submit(BUY, { baseIndex: lastIndex(seen), submissionId: "stale-2", build: "an-older-bundle" });
        assert.equal((await stale.answerTo("stale-2")).kind, "build-skew");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(stale.open, true, "never closed 4426");
        assert.deepEqual(noLive4Frame(stale.frames), []);
        await stale.close();
        /* The reload answer is the same after the restart (deterministic; the client bounds its own retries). */
        const lacking = await Client.open(second.port, BOB, clientCompatibility.clientAnnouncementQuery(1, [10], "an-old-bundle"));
        lacking.hello(gameId);
        assert.equal(await lacking.closed, CLIENT_ANSWER_CLOSE_CODE);
        assert.deepEqual(lacking.frames.map((f) => [f.kind, f.code]), [["reload", "client-rules"]]);
      } finally {
        await stopServer(second.server);
      }
      assert.ok(fs.readFileSync(logFile).equals(logAfterFirst), "the retried move was not appended again");
      assert.deepEqual(changed(afterFirst, snapshot(dir)), [], "the restart wrote nothing");
      assert.equal(fs.existsSync(path.join(dir, "games", "holds")), false, "no hold anywhere");
    }));

  test("money, derived answers across reconnects and restarts: a configuration typo (not continued) writes nothing, so the restart with the corrected configuration continues and plays the game; a protocol-1 tab is told `incompatible` -- never reload or route -- and the legacy wire no LIVE-4 frame", () =>
    withDir("derived-restart", async (dir) => {
      const gameId = moneyGame({ fin: "fresh" })(dir);
      const before = snapshot(dir);
      const typo = createMoneyServing({ capability: servingCapability([PIN_TYPO]) });
      await readChain(typo, "agree");
      const first = await fileServer(dir, typo);
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const tab = await tabAt(first.port, BOB, gameId);
          assert.deepEqual([tab.answer.kind, tab.answer.why], ["incompatible", "deployment-unverified"], `reconnect ${attempt}`);
          tab.client.submit(BUY, { baseIndex: 1, submissionId: `typo-${attempt}` });
          const refused = await tab.client.answerTo(`typo-${attempt}`);
          assert.ok(refused.kind === "incompatible" || (refused.kind === "refused" && refused.code === "wrong-state"), JSON.stringify(refused));
          assert.deepEqual(noLive4Frame(tab.client.frames), [], "never reload or route: a reload cannot fix a deployment");
          await tab.client.close();
        }
        const legacyTab = await Client.open(first.port, ALICE);
        legacyTab.hello(gameId);
        const answer = await legacyTab.next((f) => f.kind === "incompatible" || f.kind === "catch-up" || f.kind === "error", "the legacy hello");
        assert.equal(answer.kind, "incompatible");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual([noLive4Frame(legacyTab.frames), legacyTab.open], [[], true], "protocol 0: no LIVE-4 frame, never 4426");
        await legacyTab.close();
      } finally {
        await stopServer(first.server);
      }
      assert.deepEqual(snapshot(dir), before, "derived: not one byte across three reconnects and the sweeps");
      /* The restart with the corrected configuration: nothing was held, so the game simply continues. */
      const fixed = createMoneyServing({ capability: servingCapability([PIN]) });
      await readChain(fixed, "agree");
      const second = await fileServer(dir, fixed);
      try {
        const bob = await tabAt(second.port, BOB, gameId);
        assert.equal(bob.answer.kind, "catch-up");
        bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "fixed" });
        assert.equal((await bob.client.answerTo("fixed")).kind, "applied");
        await bob.client.close();
      } finally {
        await stopServer(second.server);
      }
      assert.deepEqual(changed(before, snapshot(dir)), [`${gameId}.log.jsonl`]);
    }));

  test("money, a verified conflict: it survives every reconnect (resident and new sockets), and every restart -- with the chain unread (deployment-unverified, the L4-7 rule) and read again (the conflict) -- with exactly one financial write in all of it", () =>
    withDir("conflict-restart", async (dir) => {
      const gameId = moneyGame({ fin: "fresh" })(dir);
      const servingWith = async (plan: ChainPlan) => {
        const serving = createMoneyServing({ capability: servingCapability([PIN]) });
        await readChain(serving, plan);
        return serving;
      };
      const start = snapshot(dir);
      /* Boot 1: played, then contradicted while resident. */
      const firstServing = await servingWith("agree");
      const first = await fileServer(dir, firstServing);
      try {
        const bob = await tabAt(first.port, BOB, gameId);
        bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer), submissionId: "before" });
        assert.equal((await bob.client.answerTo("before")).kind, "applied");
        const actor = await first.server.rooms.actorFor(gameId);
        firstServing.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
        await until(() => actor?.view.incompatible !== null, "the resident session stops");
        /* The tab that was connected is refused; a reconnect does not reopen play; nor does the other seat. */
        bob.client.submit(BUY, { baseIndex: lastIndex(bob.answer) + 1, submissionId: "resident" });
        assert.deepEqual([(await bob.client.answerTo("resident")).kind], ["incompatible"]);
        await bob.client.close();
        for (const claim of [BOB, ALICE, BOB]) {
          const tab = await tabAt(first.port, claim, gameId);
          assert.deepEqual([tab.answer.kind, tab.answer.why], ["incompatible", "conflict/deployment-conflict"], `a reconnect by ${claim}`);
          await tab.client.close();
        }
        /* No sweep and no money job ran: the owner's hold was written by the chain-facts listener itself. */
        await first.held();
      } finally {
        await stopServer(first.server);
      }
      const afterFirst = snapshot(dir);
      assert.deepEqual(changed(start, afterFirst), [`${gameId}.log.jsonl`, `games/money/${gameId}.json`], "the move before, and the owner's hold");
      assert.deepEqual([(await createFileFinancialGameStore(dir, quiet).load(gameId))?.hold?.code], ["binding-mismatch"]);
      /* Boot 2: the chain unread (unreachable after the restart), and its tabs say hello before any startup walk. Not
         continued -- derived -- across reconnects. */
      const second = await fileServer(dir, await servingWith("none"), {}, { walk: false });
      try {
        for (const claim of [BOB, ALICE]) {
          const tab = await tabAt(second.port, claim, gameId);
          assert.deepEqual([tab.answer.kind, tab.answer.why], ["incompatible", "deployment-unverified"], `after the restart, ${claim}`);
          await tab.client.close();
        }
      } finally {
        await stopServer(second.server);
      }
      /* Boot 3: the chain read again, still contradicting: the conflict, and no second hold. */
      const third = await fileServer(dir, await servingWith({ endpoints: { [ENDPOINT_A]: { checksum: OTHER_CHECKSUM }, [ENDPOINT_B]: { checksum: OTHER_CHECKSUM } } }));
      try {
        const tab = await tabAt(third.port, BOB, gameId);
        assert.deepEqual([tab.answer.kind, tab.answer.why], ["incompatible", "conflict/deployment-conflict"]);
        await tab.client.close();
      } finally {
        await stopServer(third.server);
      }
      assert.deepEqual(changed(afterFirst, snapshot(dir)), [], "two restarts and every reconnect: not one byte more");
    }));
});
