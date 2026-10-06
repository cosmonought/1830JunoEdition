// server/src/escrow/escrow3bAdversarial.test.ts
//
// ==================================================================
//  ESCROW-3B (brief §24): THE ADVERSARIAL MATRIX -- CRASHES, SEQUENCES, NODES, CHECKPOINTS, SETTLEMENT, TICKETS
// ==================================================================
//
// Each case drives the production service and relayer over the offline chain (`juno/fakeJunoChain.ts`) and asserts the
// invariant that matters: a crash at any boundary restarts without a semantically different transaction or a second
// financial action; the account sequence never drifts; a node's silence or nonsense decides nothing; a checkpoint is a
// committed position, once; a settlement is exactly the persisted intent or the game is held.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ALICE, BOB, BUILD, PASS, quietConsole } from "../rooms/testSupport";
import { sealOf } from "../rooms/lifecycle";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { createSettlementCoordinator } from "./settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
import { createFileChainIntentStore, createMemoryChainIntentStore, isLiveAttempt, type ChainIntentRecord } from "./chainIntents";
import { createFileFinancialGameStore, createMemoryFinancialGameStore } from "./financialGameStore";
import { createMemorySigningJournal, openFileSigningJournal } from "./signingJournal";
import { createFileWalletTicketStore, WalletTicketStoreUnreadableError } from "./walletTicketFileStore";
import { createWalletTicketLedger } from "./walletTickets";
import { newFinancialRecord, transitionFinancial, type FinancialGameRecord } from "./moneyLifecycle";
import { currentMoneyContinuation } from "./moneyContinuation";
import { isCheckpointPosition, roundKeyOf } from "./checkpointPolicy";
import { inspectMoney } from "../tools/gamesDoctor";
import { parseJunoBackendConfig, verifyJunoDeployment, checkSignerIdentities, JunoConfigError, CANONICAL_JUNO_ESCROW_CHECKSUMS } from "./juno/junoConfig";
import { createJunoRest, JunoRpcError, type HttpTransport } from "./juno/junoRest";
import { publicKeyOf } from "./juno/secp256k1";
import {
  ADMISSION_PUBKEY,
  ADMISSION_SECRET,
  CANONICAL_CHECKSUM,
  HISTORICAL_1_0_0_CHECKSUM,
  CHAIN_ID,
  CONTRACT,
  GAME_A,
  GAME_B,
  PIN,
  RELAYER_ADDRESS,
  RELAYER_SECRET,
  SETTLEMENT_SECRET,
  VARIANTS,
  WALLETS,
  fundedGame,
  makeWorld,
  move,
  passRound,
  play,
  settlementKeyConfig,
  startedGame,
  toStockRound,
  type World,
} from "./escrow3bSupport";

quietConsole();

const endedReplay =
  (graft: Record<string, unknown> = {}): PrefixReplay =>
  (prefix) => {
    const real = serverPrefixReplay(BUILD)(prefix);
    if (!real.ok) return real;
    return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true, ...graft } as GameStateResponse };
  };

const intentsOf = (world: World, gameId: string) => world.intents.listGame(gameId);
const attemptsOf = async (world: World, gameId: string) => (await intentsOf(world, gameId)).flatMap((intent) => intent.attempts);
const liveCount = async (world: World) => {
  let n = 0;
  for (const gameId of await world.intents.games()) n += (await attemptsOf(world, gameId)).filter(isLiveAttempt).length;
  return n;
};
const fin = (world: World, gameId: string = GAME_A) => world.financial.load(gameId) as Promise<FinancialGameRecord>;

/** A started game (Start confirmed) and its deal checkpoint confirmed. */
async function dealt(world: World, gameId: string = GAME_A) {
  await startedGame(world, gameId);
  const session = play(world, gameId, 0);
  await world.drive(async () => (await fin(world, gameId)).chain.checkpoint_confirmed !== null);
  return session;
}

async function sealIt(world: World, gameId: string, entries: readonly ServerLogEntry[] = world.logs.get(gameId) ?? []): Promise<void> {
  const coordinator = createSettlementCoordinator({
    store: world.financial,
    replay: world.replay,
    isFinancial: () => true,
    serving: world.service.serving,
    now: () => world.clock.now,
    warn: (line) => world.warnings.push(line),
    schedule: () => ({ cancel: () => undefined }),
    onIntentPrepared: (id) => world.service.onIntentPrepared(id),
  });
  coordinator.onGameplayClosed({ gameId, record: { game_id: gameId, money: null, started_at: world.clock.now } as never, seal: sealOf(entries, true)!, recovered: false, entries });
  await coordinator.drain();
  await world.service.idle();
}

/** Start intent created, nothing submitted yet. */
async function startIntent(world: World, gameId: string = GAME_A): Promise<ChainIntentRecord> {
  assert.ok((await world.service.createMoneyGame(gameId)).ok);
  const chainGameId = await fundedGame(world, gameId);
  assert.ok((await world.service.bindChainGame(gameId, chainGameId, VARIANTS)).ok);
  const started = await world.service.requestStart(gameId, [{ player_id: ALICE }, { player_id: BOB }]);
  assert.ok(started.ok);
  return (await intentsOf(world, gameId)).find((intent) => intent.op.kind === "start")!;
}

/* ================================================================================================= */

describe("§24 durable side effects: a crash at any boundary never makes a second, different transaction", () => {
  test("crash BEFORE the attempt is persisted: the signed bytes never leave; the next pass signs again and lands once", async () => {
    const world = makeWorld();
    await startIntent(world);
    (world.intents as ReturnType<typeof createMemoryChainIntentStore>).failNext.push("definite");
    await world.relayer.pass();
    assert.equal(world.chain.broadcasts.length, 0, "nothing was broadcast");
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.sequence, BigInt(0));
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const attempts = await attemptsOf(world, GAME_A);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].phase, "included-success");
  });

  test("crash AFTER the intent, before any signature: the restarted relayer finds and submits it", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.restart();
    await world.drive(async () => (await fin(world)).chain.started !== null);
    assert.equal((await attemptsOf(world, GAME_A)).length, 1);
  });

  test("crash AFTER signing, before the broadcast reached a node: the SAME bytes are rebroadcast (same hash), once", async () => {
    const world = makeWorld();
    await startIntent(world);
    world.chain.dropNextBroadcast = 1;
    await world.relayer.pass();
    const [signed] = await attemptsOf(world, GAME_A);
    assert.equal(signed.phase, "signed");
    assert.equal(world.chain.mempool.length, 0);
    await world.restart();
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const attempts = await attemptsOf(world, GAME_A);
    assert.equal(attempts.length, 1, "no fresh 'equivalent' transaction was built");
    assert.equal(attempts[0].tx_hash, signed.tx_hash);
    assert.equal(world.chain.txIndex.get(signed.tx_hash)?.code, 0);
  });

  test("a LOST broadcast answer (the tx is in the mempool): observed on chain, never re-signed", async () => {
    const world = makeWorld();
    await startIntent(world);
    world.chain.loseNextBroadcastAnswer = 1;
    await world.relayer.pass();
    assert.equal(world.chain.mempool.length, 1);
    await world.drive(async () => (await fin(world)).chain.started !== null);
    assert.equal((await attemptsOf(world, GAME_A)).length, 1);
  });

  test("crash AFTER inclusion, before the local advance: the restart confirms it by hash", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.relayer.pass();
    world.chain.produceBlock();
    const [attempt] = await attemptsOf(world, GAME_A);
    assert.equal(world.chain.txIndex.get(attempt.tx_hash)?.code, 0, "on chain");
    await world.restart();
    await world.service.idle();
    /* The restart's Start reconciliation reads the chain first: the escrow shows this roster started (permanent). */
    assert.notEqual((await fin(world)).chain.started, null, "the chain's truth, before any relayer pass");
    await world.drive(async () => (await intentsOf(world, GAME_A))[0].status === "confirmed", 5, false);
    const [after] = await attemptsOf(world, GAME_A);
    assert.equal(after.phase, "included-success");
    assert.equal((await attemptsOf(world, GAME_A)).length, 1);
  });

  test("the same worker invoked twice at once: one transaction", async () => {
    const world = makeWorld();
    await startIntent(world);
    await Promise.all([world.relayer.pass(), world.relayer.pass(), world.relayer.pass()]);
    assert.equal((await attemptsOf(world, GAME_A)).length, 1);
    assert.equal(world.chain.broadcasts.length, 1);
  });

  test("restart with NO tx index at all: the spent sequence and the contract's own state confirm it (no re-sign)", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.relayer.pass();
    world.chain.produceBlock();
    world.chain.indexDisabled = true;
    world.chain.sequenceIndexDisabled = true;
    await world.restart();
    await world.drive(async () => (await fin(world)).chain.started !== null && (await intentsOf(world, GAME_A))[0].status === "confirmed", 5, false);
    const intent = (await intentsOf(world, GAME_A))[0];
    assert.equal(intent.status, "confirmed");
    assert.equal(intent.confirmation?.how, "chain-state");
    assert.equal(intent.attempts.length, 1);
    assert.equal(intent.attempts[0].phase, "consumed", "its sequence was spent; no node could say by whom -- the contract said the effect is there");
  });
});

describe("§24 Cosmos sequencing: one live attempt, the sequence always the chain's", () => {
  test("two games submit concurrently: N lands, then N+1 is signed -- never two live, never a drifted sequence", async () => {
    const world = makeWorld();
    await startIntent(world, GAME_A);
    await startIntent(world, GAME_B);
    await world.relayer.pass();
    assert.equal(await liveCount(world), 1, "the second waits for the first");
    let max = 0;
    await world.drive(async () => {
      max = Math.max(max, await liveCount(world));
      return (await fin(world, GAME_A)).chain.started !== null && (await fin(world, GAME_B)).chain.started !== null;
    });
    assert.ok(max <= 1);
    const a = (await attemptsOf(world, GAME_A))[0];
    const b = (await attemptsOf(world, GAME_B))[0];
    assert.deepEqual([Number(a.sequence), Number(b.sequence)].sort(), [0, 1]);
  });

  test("the key used elsewhere (sequence mismatch): the attempt is proven dead by the identified consumer, then re-signed", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.relayer.pass(); // attempt at sequence 0, in the mempool
    const external = world.chain.consumeSequenceExternally(RELAYER_ADDRESS); // someone else's tx used sequence 0
    world.chain.produceBlock(); // ours is dropped: its sequence is spent
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const attempts = await attemptsOf(world, GAME_A);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].phase, "dead");
    assert.deepEqual(attempts[0].death && { kind: attempts[0].death.kind, by: (attempts[0].death as { consumed_by_tx?: string }).consumed_by_tx }, { kind: "sequence-consumed", by: external });
    assert.equal(attempts[1].sequence, "1", "the next attempt signs at the chain's sequence");
  });

  test("an attempt that never lands expires: dead only ABOVE its timeout height with the sequence unchanged", async () => {
    const world = makeWorld({ timeoutBlocks: 3 });
    await startIntent(world);
    await world.relayer.pass();
    world.chain.mempool.length = 0; // lost from every mempool (never included)
    world.chain.produceBlock();
    await world.relayer.pass();
    assert.equal((await attemptsOf(world, GAME_A))[0].phase !== "dead", true, "not dead before the timeout: rebroadcast instead");
    world.chain.mempool.length = 0;
    for (let n = 0; n < 5; n += 1) world.chain.produceBlock();
    world.chain.mempool.length = 0;
    await world.relayer.pass();
    const [first] = await attemptsOf(world, GAME_A);
    assert.equal(first.phase, "dead");
    assert.equal(first.death?.kind, "expiry-passed");
    await world.drive(async () => (await fin(world)).chain.started !== null);
    assert.equal((await attemptsOf(world, GAME_A))[1].sequence, "0", "the dead attempt's sequence is reused (it was never spent)");
  });

  test("a malformed account answer decides nothing: nothing is signed until the chain answers properly", async () => {
    const world = makeWorld();
    await startIntent(world);
    world.chain.malformedNextAccount = 1;
    await world.relayer.pass();
    assert.equal((await attemptsOf(world, GAME_A)).length, 0);
    await world.drive(async () => (await fin(world)).chain.started !== null);
    assert.equal((await attemptsOf(world, GAME_A)).length, 1);
  });

  test("a transaction rejected ON CHAIN (paused between simulation and inclusion) is a known failure, waited out, then re-signed", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const session = await dealt(world);
    play(world, GAME_A, 1, session); // one more committed move inside the auction (not a boundary)
    await sealIt(world, GAME_A);
    /* The terminal checkpoint lands first (Checkpoint works while paused); pause just as the Settle is broadcast. */
    await world.drive(async () => (await intentsOf(world, GAME_A)).some((i) => i.op.kind === "settle" && i.attempts.length === 1));
    world.chain.paused = true;
    world.chain.produceBlock();
    await world.relayer.pass();
    const settle = (await intentsOf(world, GAME_A)).find((i) => i.op.kind === "settle")!;
    assert.equal(settle.attempts[0].phase, "included-failure");
    assert.equal(settle.attempts[0].error?.code, "PAUSED");
    await world.relayer.pass();
    assert.equal((await intentsOf(world, GAME_A)).find((i) => i.op.kind === "settle")!.attempts.length, 1, "no new attempt while paused");
    world.chain.paused = false;
    world.clock.now += 60_000;
    await world.drive(async () => (await fin(world)).phase === "settleable");
    const after = (await intentsOf(world, GAME_A)).find((i) => i.op.kind === "settle")!;
    assert.equal(after.attempts.length, 2);
    assert.equal(after.attempts[1].phase, "included-success");
  });

  test("the same signed bytes twice: the node answers 'already in cache' and nothing changes", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.relayer.pass();
    world.clock.now += 5_000;
    await world.relayer.pass(); // rebroadcast (the mempool still holds it)
    const [attempt] = await attemptsOf(world, GAME_A);
    assert.equal(attempt.broadcasts, 2);
    assert.equal(attempt.broadcast?.code, 19);
    assert.equal(world.chain.mempool.length, 1);
  });
});

describe("§24 RPC: silence, nonsense and the wrong network decide nothing", () => {
  test("an unavailable node: the live attempt stays live; nothing is signed or declared dead", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.relayer.pass();
    world.chain.unavailable = true;
    for (let n = 0; n < 3; n += 1) await world.relayer.pass();
    const [attempt] = await attemptsOf(world, GAME_A);
    assert.ok(isLiveAttempt(attempt));
    world.chain.unavailable = false;
    await world.drive(async () => (await fin(world)).chain.started !== null);
    assert.equal((await attemptsOf(world, GAME_A)).length, 1);
  });

  test("a node on another chain: the relayer signs nothing, and verification refuses the deployment", async () => {
    const world = makeWorld();
    await startIntent(world);
    world.chain.wrongChainId = "juno-1";
    await world.relayer.pass();
    assert.equal((await attemptsOf(world, GAME_A)).length, 0);
    assert.ok(world.relayer.status().last_error?.includes("juno-1"));
  });

  test("an absurd gas answer fails closed: never a transaction -- and a Start that can therefore never happen releases its freeze", async () => {
    const world = makeWorld();
    await startIntent(world);
    world.chain.simulateGasOverride = "99999999999";
    await world.relayer.pass();
    await world.service.idle();
    const [intent] = await intentsOf(world, GAME_A);
    assert.equal(intent.attempts.length, 0, "nothing was signed");
    /* Held by the relayer (gas refused); with nothing signed and the escrow showing no Start, the chain PROVES this
       freeze's Start never happened: the freeze is released (the table is not stranded), the Start slot closed. */
    assert.equal(intent.status, "superseded");
    assert.match(intent.superseded?.why ?? "", /released/);
    assert.equal((await fin(world)).phase, "funding");
    assert.equal((await fin(world)).roster, null);
    assert.equal((await fin(world)).hold, null);
  });

  test("a tx not found by hash, later found: nothing is decided while it may still land", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.relayer.pass();
    world.chain.indexDisabled = true;
    await world.relayer.pass(); // not found, sequence unchanged, below timeout: wait (rebroadcast)
    assert.ok(isLiveAttempt((await attemptsOf(world, GAME_A))[0]));
    world.chain.produceBlock();
    world.chain.indexDisabled = false;
    await world.drive(async () => (await fin(world)).chain.started !== null, 5, false);
    assert.equal((await attemptsOf(world, GAME_A))[0].phase, "included-success");
  });

  test("the REST client: malformed JSON, oversize bodies, wrong chain, redirects and plain http are refused", async () => {
    const answers: Record<string, { status: number; text: string }> = {};
    const http: HttpTransport = async (request) => {
      const found = Object.entries(answers).find(([suffix]) => request.url.endsWith(suffix));
      if (found === undefined) throw new JunoRpcError("unavailable", "no route");
      if (found[1].text.length > request.maxBytes) throw new JunoRpcError("too-large", "big");
      return found[1];
    };
    const rest = createJunoRest({ endpoints: ["https://rpc.example"], expectedChainId: CHAIN_ID, allowInsecureLocalHttp: false, timeoutMs: 1000, maxResponseBytes: 1000, maxCodeBytes: 1000 }, http);
    answers["/node_info"] = { status: 200, text: JSON.stringify({ default_node_info: { network: CHAIN_ID } }) };
    answers["/blocks/latest"] = { status: 200, text: "{not json" };
    await assert.rejects(() => rest.latestBlock(), (error: unknown) => error instanceof JunoRpcError && error.kind === "malformed");
    answers["/blocks/latest"] = { status: 200, text: JSON.stringify({ block: { header: { chain_id: "juno-1", height: "5", time: "2026-01-01T00:00:00Z" } } }) };
    await assert.rejects(() => rest.latestBlock(), (error: unknown) => error instanceof JunoRpcError && error.kind === "wrong-chain");
    answers["/blocks/latest"] = { status: 200, text: "x".repeat(5000) };
    await assert.rejects(() => rest.latestBlock(), (error: unknown) => error instanceof JunoRpcError && error.kind === "too-large");
    answers[`/txs/${"A".repeat(64)}`] = { status: 404, text: JSON.stringify({ code: 5, message: "tx not found" }) };
    assert.equal(await rest.tx("A".repeat(64)), null, "not found is an answer about that node, never a death");
    assert.throws(() => createJunoRest({ endpoints: ["http://rpc.example"], expectedChainId: CHAIN_ID, allowInsecureLocalHttp: true, timeoutMs: 1, maxResponseBytes: 1, maxCodeBytes: 1 }, http), /not https/);
    assert.throws(() => createJunoRest({ endpoints: ["https://user:pw@rpc.example"], expectedChainId: CHAIN_ID, allowInsecureLocalHttp: false, timeoutMs: 1, maxResponseBytes: 1, maxCodeBytes: 1 }, http), /credentials/);
    assert.doesNotThrow(() => createJunoRest({ endpoints: ["http://127.0.0.1:1317"], expectedChainId: CHAIN_ID, allowInsecureLocalHttp: true, timeoutMs: 1, maxResponseBytes: 1, maxCodeBytes: 1 }, http));
  });
});

describe("§24 checkpoints: committed positions, once, the newest winning", () => {
  test("the deal, each completed round, the seal -- never a turn; a duplicate signal is the same slot", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const session = await dealt(world);
    const count = async () => (await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint").length;
    assert.equal(await count(), 1);
    const entries = world.logs.get(GAME_A)!;
    world.service.onGameplayCommitted({ gameId: GAME_A, entries, board: session.state as GameStateResponse });
    world.service.onGameplayCommitted({ gameId: GAME_A, entries, board: session.state as GameStateResponse });
    await world.service.idle();
    assert.equal(await count(), 1, "the same committed position again is nothing new");
    toStockRound(world, GAME_A, session);
    await world.service.idle();
    assert.equal(await count(), 2);
  });

  test("several boundaries while the chain is unreachable become ONE checkpoint at the newest position", async () => {
    const world = makeWorld();
    const session = await dealt(world);
    toStockRound(world, GAME_A, session);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === session.entries.length);
    world.chain.unavailable = true;
    passRound(world, GAME_A, session);
    passRound(world, GAME_A, session);
    passRound(world, GAME_A, session);
    await world.service.idle();
    world.chain.unavailable = false;
    await world.service.sweepChain(); // a stalled game makes no new commit: the sweep retries the newest position
    await world.service.idle();
    const checkpoints = (await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint");
    assert.equal(checkpoints.length, 3, "deal, Stock Round 1, and ONE for the three boundaries missed");
    assert.equal(checkpoints[2].op.kind === "checkpoint" && checkpoints[2].op.log_len, session.entries.length);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === session.entries.length);
  });

  test("a boundary crossed just before a crash, with no move after it, is checkpointed at the next load", async () => {
    const world = makeWorld();
    const session = await dealt(world);
    world.chain.unavailable = true; // the checkpoint job cannot run before the crash
    toStockRound(world, GAME_A, session);
    await world.service.idle();
    assert.equal((await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint").length, 1);
    /* The crash: the boundary committed, its checkpoint never prepared. */
    await world.restart();
    world.chain.unavailable = false;
    const entries = world.logs.get(GAME_A)!;
    world.service.onGameplayCommitted({ gameId: GAME_A, entries, board: session.state as GameStateResponse }); // the room host's load seam
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === session.entries.length);
  });

  test("a pending checkpoint survives a restart and lands; a newer one supersedes an older one not yet signed", async () => {
    const world = makeWorld();
    const session = await dealt(world);
    toStockRound(world, GAME_A, session);
    await world.service.idle();
    passRound(world, GAME_A, session);
    await world.service.idle();
    const pending = (await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint" && i.status === "pending");
    assert.equal(pending.length, 2);
    await world.restart();
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === session.entries.length);
    const all = (await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint");
    const older = all.find((i) => i.intent_id === pending[0].intent_id)!;
    assert.equal(older.status, "superseded");
    assert.equal(older.attempts.length, 0, "a superseded checkpoint was never signed");
  });

  test("the seal while a checkpoint is pending: the older checkpoint yields, the terminal checkpoint (2L) precedes the Settle (2L+1)", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const session = await dealt(world);
    toStockRound(world, GAME_A, session);
    move(world, GAME_A, session, ALICE, PASS); // inside Stock Round 1 (not a boundary)
    await sealIt(world, GAME_A);
    await world.drive(async () => (await fin(world)).phase === "settleable");
    const intents = await intentsOf(world, GAME_A);
    const L = session.entries.length;
    const terminal = intents.find((i) => i.op.kind === "checkpoint" && i.op.log_len === L)!;
    const settle = intents.find((i) => i.op.kind === "settle")!;
    assert.equal(terminal.status, "confirmed");
    assert.ok(Number(terminal.attempts[0].sequence) < Number(settle.attempts[settle.attempts.length - 1].sequence), "the checkpoint landed first");
    const game = world.chain.games.get(1)!;
    assert.equal(game.checkpoints.get(1)?.payload.seq, String(2 * L));
    assert.deepEqual(game.checkpoints.get(1)?.payload.settlement_weights, game.settlement?.payload.settlement_weights, "a liveness exit would pay exactly the terminal appraisal");
  });

  test("trailing CloseRoom markers change nothing a settlement signs", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const session = await dealt(world);
    play(world, GAME_A, 1, session); // one more committed move inside the auction (not a boundary)
    const entries = [...world.logs.get(GAME_A)!];
    const last = entries[entries.length - 1];
    for (let n = 0; n < 3; n += 1) entries.push({ ...last, index: last.index + 1 + n, id: `close-${n}`, payload: JSON.stringify({ CloseRoom: {} }), at: (last.at ?? 0) + n + 1 } as ServerLogEntry);
    world.logs.set(GAME_A, entries);
    await sealIt(world, GAME_A, entries);
    const settle = (await intentsOf(world, GAME_A)).find((i) => i.op.kind === "settle")!;
    assert.equal(settle.op.kind === "settle" && settle.op.log_len, session.entries.length);
  });

  test("Delayed Auction boundaries are round changes (the auction entered or left mid-game); a turn is not", () => {
    const board = (type: string, macro: number, sub: number) => ({ current_round_type: type, macro_round_number: macro, sub_round_index: sub }) as GameStateResponse;
    assert.equal(isCheckpointPosition(roundKeyOf(board("StockRound", 2, 0)), board("WaterfallAuction", 2, 0)), true, "SR -> the delayed auction");
    assert.equal(isCheckpointPosition(roundKeyOf(board("WaterfallAuction", 2, 0)), board("StockRound", 2, 0)), true, "the auction -> SR");
    assert.equal(isCheckpointPosition(roundKeyOf(board("OperatingRound", 2, 0)), board("OperatingRound", 2, 1)), true, "OR 1 -> OR 2");
    assert.equal(isCheckpointPosition(roundKeyOf(board("OperatingRound", 2, 1)), board("StockRound", 3, 0)), true);
    assert.equal(isCheckpointPosition(roundKeyOf(board("StockRound", 3, 0)), board("StockRound", 3, 0)), false, "a turn within the round");
    assert.equal(isCheckpointPosition(null, board("WaterfallAuction", 1, 0)), true, "the deal");
  });
});

describe("§24 settlement: exactly the persisted intent, or the game is held", () => {
  test("this build's rules settle (the happy path); a money game on an older or newer pin is never signed here -- not continued, nothing written (LIVE-4 L4-4)", async () => {
    /* Written on a v11 server as [10, 12]; Route v12 R12-2 made this server v12 (and R12-3 certified 12 for settlement), so
       the pins were 11 and 13; Phase 3 W3-K made this server v13 (and the v13 certification certified 13), so the newer
       pin is read off the engine. */
    for (const pin of [11, RULES_ENGINE_VERSION + 1]) {
      const world = makeWorld({ replay: endedReplay({ rules_engine_version: pin }) });
      const session = await dealt(world);
      play(world, GAME_A, 1, session);
      /* A game whose money identity names another rules version: this pool does not play it, so it is NOT CONTINUED
         here -- derived, never a durable hold (L4-4 step -1; before LIVE-4 it was held continuation-incompatible after
         the deal and the seal were written, F-L4-3). Its record is left exactly as it was, and nothing is signed. */
      const record = await fin(world);
      await world.financial.put({ ...record, continuation: { ...record.continuation!, rules_engine_version: pin }, record_version: record.record_version + 1 }, record.record_version);
      const before = JSON.stringify(await fin(world));
      await sealIt(world, GAME_A);
      assert.equal(JSON.stringify(await fin(world)), before, `v${pin}: the financial record is untouched (no seal, no hold)`);
      assert.equal((await intentsOf(world, GAME_A)).some((i) => i.op.kind === "settle"), false, `v${pin}: nothing signed`);
      assert.ok(world.ops.lines.some((line) => line.event === "money.not-continued" && line.game_id === GAME_A && line.why === "rules-not-supported"), `v${pin}: noticed`);
    }
    /* And even past the continuation check, an uncertified board (the next engine; 12 was, until R12-3, and 13, until the
       v13 certification) never builds: the settlement job holds it. */
    const uncertified = RULES_ENGINE_VERSION + 1;
    const world = makeWorld({ replay: endedReplay({ rules_engine_version: uncertified }) });
    const session = await dealt(world);
    play(world, GAME_A, 1, session);
    const record = await fin(world);
    const sealed = transitionFinancial(record, { kind: "sealed", at: 1, log_len: session.entries.length, sealed_at: 1 });
    const next = (sealed as { next: FinancialGameRecord }).next;
    const evidence = { format: "18COSMOS/SETTLEMENT-EVIDENCE/v1", game_id: GAME_A, log_len: session.entries.length, sealed_at: 1, log_hash: "00".repeat(32), appraisal_log_len: session.entries.length, appraisal_state_hash: "00".repeat(32), rules_engine_version: uncertified, terminal_reason: "BankBroken", players: [ALICE, BOB], totals: { [ALICE]: "1", [BOB]: "1" } } as const;
    const prepared = (transitionFinancial(next, { kind: "prepared", at: 2, evidence }) as { next: FinancialGameRecord }).next;
    await world.financial.put({ ...prepared, record_version: record.record_version + 1 }, record.record_version);
    world.service.onIntentPrepared(GAME_A);
    await world.service.idle();
    assert.equal((await fin(world)).hold?.code, "evidence-mismatch");
    assert.equal((await intentsOf(world, GAME_A)).some((i) => i.op.kind === "settle"), false);
  });

  test("a persisted intent that disagrees with a fresh derivation HOLDS: nothing is signed, nothing repaired", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const session = await dealt(world);
    play(world, GAME_A, 1, session); // one more committed move inside the auction (not a boundary)
    world.relayer.stop();
    const tamperedReplay = world.replay;
    /* The coordinator derives the intent; then the durable record is tampered with before the service reads it. */
    world.replay = (prefix) => tamperedReplay(prefix);
    const coordinator = createSettlementCoordinator({ store: world.financial, replay: world.replay, isFinancial: () => true, serving: world.service.serving, now: () => world.clock.now, warn: () => undefined, schedule: () => ({ cancel: () => undefined }) });
    const entries = world.logs.get(GAME_A)!;
    coordinator.onGameplayClosed({ gameId: GAME_A, record: { game_id: GAME_A, money: null, started_at: 1 } as never, seal: sealOf(entries, true)!, recovered: false, entries });
    await coordinator.drain();
    const record = await fin(world);
    assert.equal(record.phase, "intent-prepared");
    const intent = { ...record.intent!, appraisal_state_hash: "00".repeat(32) };
    assert.equal((await world.financial.put({ ...record, intent, record_version: record.record_version + 1 }, record.record_version)).kind, "committed");
    const reservedBefore = (await world.journal.reservations()).length;
    world.service.onIntentPrepared(GAME_A);
    await world.service.idle();
    const held = await fin(world);
    assert.equal(held.phase, "held");
    assert.equal(held.hold?.code, "evidence-mismatch");
    assert.equal((await intentsOf(world, GAME_A)).some((i) => i.op.kind === "settle"), false);
    assert.equal((await world.journal.reservations()).length, reservedBefore, "nothing was signed");
  });

  test("the chain already settled it another way: the Settle is superseded, never signed; the record closes", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const session = await dealt(world);
    play(world, GAME_A, 1, session); // one more committed move inside the auction (not a boundary)
    world.chain.forceState("1", { state: "settled", outcome: { route: "liveness_refund", at: 1, amounts: ["1000000", "1000000"], dust: "0" } });
    await sealIt(world, GAME_A);
    await world.drive(async () => (await fin(world)).phase === "closed");
    const settle = (await intentsOf(world, GAME_A)).find((i) => i.op.kind === "settle");
    assert.ok(settle === undefined || (settle.status === "superseded" && settle.attempts.length === 0));
    assert.deepEqual({ state: (await fin(world)).chain_outcome?.state, route: (await fin(world)).chain_outcome?.route }, { state: "SETTLED", route: "liveness_refund" });
  });

  test("a transport failure after a successful Settle: confirmed by hash, never re-signed", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const session = await dealt(world);
    play(world, GAME_A, 1, session); // one more committed move inside the auction (not a boundary)
    await sealIt(world, GAME_A);
    await world.drive(async () => (await intentsOf(world, GAME_A)).find((i) => i.op.kind === "checkpoint" && i.op.log_len === session.entries.length)?.status === "confirmed").catch(async (error) => {
      throw new Error(`${String(error)} L=${session.entries.length} ${JSON.stringify((await intentsOf(world, GAME_A)).map((i) => [i.op.kind, "log_len" in i.op ? i.op.log_len : null, i.status, i.attempts.map((a) => a.phase), i.hold, i.superseded]))} ${(await fin(world)).phase} ${JSON.stringify((await fin(world)).hold)}`);
    });
    world.chain.loseNextBroadcastAnswer = 1;
    await world.drive(async () => (await fin(world)).phase === "settleable").catch(async (error) => {
      throw new Error(`${String(error)} ${JSON.stringify((await intentsOf(world, GAME_A)).map((i) => [i.op.kind, i.status, i.attempts.map((a) => a.phase), i.hold, i.superseded]))} ${(await fin(world)).phase} ${JSON.stringify((await fin(world)).hold)}`);
    });
    const settle = (await intentsOf(world, GAME_A)).find((i) => i.op.kind === "settle")!;
    assert.equal(settle.attempts.length, 1);
    assert.equal(settle.confirmation?.how, "tx");
  });

  test("GNOLAND-1 F1: a journal AHEAD of the durable log (a restored store) holds the game instead of signing", async () => {
    const world = makeWorld();
    const session = await dealt(world);
    const record = await fin(world);
    const { escrowInstanceKey } = await import("../../../frontend/src/gameEngine/escrow/escrowModel");
    await world.journal.reserveSettlement({ instance: escrowInstanceKey(record.binding!.escrow!), seq: String(2 * (session.entries.length + 50)), signer_key_id: 1, digest: { codec: "18JUNO/v1", purpose: "settle", hex: "ab".repeat(32) } });
    toStockRound(world, GAME_A, session);
    await world.service.idle();
    const held = await fin(world);
    assert.equal(held.phase, "held");
    assert.equal(held.hold?.code, "journal-ahead");
  });
});

describe("§5 / §16 the binding and the roster are write-once and pinned", () => {
  test("LIVE-4 T-8: a restart configured for another contract does NOT hold the pinned game -- it is not continued there, nothing is written, and nothing is signed", async () => {
    const world = makeWorld();
    const session = await dealt(world);
    const before = JSON.stringify(await fin(world));
    const intentsBefore = JSON.stringify(await intentsOf(world, GAME_A));
    /* Before LIVE-4 this server durably held every open game on contract A (binding-mismatch, F-L4-2): availability read
       as a contradiction. Now contract A is simply not served here -- derived, routed, paged, untouched. */
    world.pin = { ...PIN, contract_address: WALLETS[2] };
    await world.restart();
    assert.equal(JSON.stringify(await fin(world)), before, "the financial record is untouched: no hold");
    toStockRound(world, GAME_A, session);
    await world.service.idle();
    await world.relayer.pass();
    await world.service.idle();
    assert.equal(JSON.stringify(await intentsOf(world, GAME_A)), intentsBefore, "no intent written, deferred or held");
    assert.equal(JSON.stringify(await fin(world)), before, "gameplay commits move nothing either");
    assert.ok(world.ops.lines.some((line) => line.event === "money.not-continued" && line.game_id === GAME_A && line.why === "deployment-unavailable"));
  });

  test("a second, different chain game or roster is a hold (binding-conflict), never an overwrite", () => {
    const base = newFinancialRecord(GAME_A, currentMoneyContinuation(), 1, PIN);
    const escrow = { binding_schema: 2, backend: "juno-cosmwasm", codec: "18JUNO/v1", network: { chain_id: CHAIN_ID, network_class: "testnet" }, deployment: { kind: "juno-cosmwasm", contract_address: CONTRACT, code_id: "1", code_checksum: CANONICAL_CHECKSUM, contract_name: "x", contract_version: "1.0.0", admin: null }, chain_game_id: "1", custody: { kind: "contract-ledger" }, asset: { denom: "ujunox", exponent: 6, symbol: "JUNOX" }, terms: { ante_gross: "10", ante_net: "9", max_players: 2, mode: 0 }, commitments: { rules_engine_version: 11, variants_digest: "00".repeat(32) }, bound_at: 1 } as never;
    const bound = transitionFinancial(base, { kind: "bound", at: 2, escrow });
    assert.equal(bound.kind, "moved");
    const next = (bound as { next: FinancialGameRecord }).next;
    assert.equal(transitionFinancial(next, { kind: "bound", at: 3, escrow }).kind, "same");
    const other = transitionFinancial(next, { kind: "bound", at: 3, escrow: { ...(escrow as object), chain_game_id: "2" } as never });
    assert.equal(other.kind === "moved" && other.next.hold?.code, "binding-conflict");
    const elsewhere = transitionFinancial(base, { kind: "bound", at: 2, escrow: { ...(escrow as object), deployment: { ...(escrow as { deployment: object }).deployment, contract_address: "juno1x" } } as never });
    assert.equal(elsewhere.kind === "moved" && elsewhere.next.hold?.code, "binding-mismatch");
    assert.equal(transitionFinancial(next, { kind: "deployment-pinned", at: 4, deployment: { ...PIN, denom: "ujuno" } }).kind === "moved", true, "another denom pinned later is a hold");
  });

  test("the roster freezes once: the ledger stops issuing, and the room host's seam says so", async () => {
    const world = makeWorld();
    await startIntent(world);
    assert.equal(world.service.isRosterFrozen(GAME_A), true);
    const issued = await world.ledger.issue({ binding: { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT }, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[2], context: { principalId: "pr_0", familyId: "sf_0", recoverySelector: "rk_0" }, reauthorized: true });
    assert.deepEqual(issued, { ok: false, refusal: "frozen" });
    assert.equal((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok, true, "a repeat is the same freeze and the same start slot");
    assert.equal((await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "start").length, 1);
  });
});

describe("§14 / §15 the file-backed wallet-ticket ledger", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "escrow3b-tickets-"));
  const context = (n: number) => ({ principalId: `pr_${n}`, familyId: `sf_${n}`, recoverySelector: `rk_${n}` });
  const binding = { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT };

  test("freeze then restart: the frozen ledger survives; issuing stays closed; the frozen tickets still stand", async () => {
    const data = dir();
    let standing = true;
    const ledgerOver = () => createWalletTicketLedger({ store: createFileWalletTicketStore(data), standing: () => (standing ? { kind: "standing" } : { kind: "ended", why: "family" }), holdsSeat: () => true, now: () => 5 });
    const first = ledgerOver();
    const issued = await first.issue({ binding, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[0], context: context(0), reauthorized: true });
    assert.ok(issued.ok);
    assert.equal(await first.freeze(GAME_A), "committed");
    standing = false; // a sign-out AFTER the freeze
    const second = ledgerOver();
    assert.equal((await second.lookupOf(GAME_A))(ALICE, WALLETS[0]), (issued as { ticket: string }).ticket, "a frozen claim is not un-bound by a later security event");
    assert.deepEqual(await second.issue({ binding, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[1], context: context(0), reauthorized: true }), { ok: false, refusal: "security-context-ended" });
    standing = true;
    assert.deepEqual(await second.issue({ binding, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[1], context: context(0), reauthorized: true }), { ok: false, refusal: "frozen" });
    const text = fs.readFileSync(path.join(data, "games", "wallet-tickets", `${GAME_A}.json`), "utf8");
    assert.equal(text.includes("secret"), false);
  });

  test("a security event BEFORE the freeze: the ticket stops standing, is recorded as revoked, and adopts nothing", async () => {
    const data = dir();
    let standing = true;
    const ledger = createWalletTicketLedger({ store: createFileWalletTicketStore(data), standing: () => (standing ? { kind: "standing" } : { kind: "ended", why: "family" }), holdsSeat: () => true, now: () => 5 });
    const issued = await ledger.issue({ binding, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[0], context: context(0), reauthorized: true });
    standing = false;
    assert.equal((await ledger.lookupOf(GAME_A))(ALICE, WALLETS[0]), "", "derived: ended even before any event is recorded");
    assert.deepEqual(await ledger.gamesOfPrincipal("pr_0"), [GAME_A]);
    assert.equal(await ledger.revokeForSecurityEvent(GAME_A), 1);
    const doc = (await createFileWalletTicketStore(data).load(GAME_A)).document;
    assert.equal(doc.grants[0].revoke_reason, "security-event");
    assert.ok(issued.ok);
  });

  test("a stale epoch never stands; concurrent issues cannot both land; a corrupt ledger refuses everything", async () => {
    const data = dir();
    const ledger = createWalletTicketLedger({ store: createFileWalletTicketStore(data), standing: () => ({ kind: "standing" }), holdsSeat: () => true, now: () => 5 });
    const one = await ledger.issue({ binding, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[0], context: context(0), reauthorized: true });
    const two = await ledger.issue({ binding, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[0], context: context(0), reauthorized: true });
    assert.ok(one.ok && two.ok && two.epoch === 2);
    assert.notEqual((one as { ticket: string }).ticket, (two as { ticket: string }).ticket);
    const lookup = await ledger.lookupOf(GAME_A);
    assert.equal(lookup(ALICE, WALLETS[0]), (two as { ticket: string }).ticket, "only the newest epoch stands");
    const racing = await Promise.all([0, 1, 2].map(() => ledger.issue({ binding, gameId: GAME_A, playerId: BOB, wallet: WALLETS[1], context: context(1), reauthorized: true })));
    const doc = (await createFileWalletTicketStore(data).load(GAME_A)).document;
    assert.equal(doc.grants.filter((grant) => grant.player_id === BOB && grant.revoked_at === null).length, 1, "one outstanding ticket per seat");
    assert.ok(racing.some((result) => result.ok));
    fs.writeFileSync(path.join(data, "games", "wallet-tickets", `${GAME_A}.json`), "{\"format\":\"gs-wallet-tickets\",\"version\":3");
    await assert.rejects(() => ledger.lookupOf(GAME_A), WalletTicketStoreUnreadableError);
    await assert.rejects(() => ledger.issue({ binding, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[0], context: context(0), reauthorized: true }), WalletTicketStoreUnreadableError);
  });
});

describe("§20 configuration safety and §23 the operator view", () => {
  const good = (over: Record<string, unknown> = {}) => ({
    format: "18COSMOS/JUNO-BACKEND/v2",
    chain_id: CHAIN_ID,
    network_class: "testnet",
    rest_endpoints: ["https://rest.example"],
    contract_address: CONTRACT,
    code_checksum: CANONICAL_CHECKSUM,
    wasm_admin: null,
    denom: "ujunox",
    asset_symbol: "JUNOX",
    relayer: { address: RELAYER_ADDRESS, signer: { kind: "development", key_file: "/keys/relayer.key" } },
    settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "development", key_file: "/keys/settlement.key" } },
    admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/admission.key" } },
    trust: { operators: [RELAYER_ADDRESS], resolvers: [RELAYER_ADDRESS], min_challenge_window_secs: "60", min_liveness_window_secs: "3600", min_resolver_timeout_secs: "3600" },
    journal_dir: "/journal",
    dev_signer: "allow-unprotected-testnet-key",
    ...over,
  });

  test("the static checks: every pin and every production refusal", () => {
    const dev = { serverMode: "development" as const, dataDir: "/data" };
    const prod = { serverMode: "production" as const, dataDir: "/data" };
    assert.equal(parseJunoBackendConfig(good(), dev).chainId, CHAIN_ID);
    const problems = (raw: unknown, context: { serverMode: "development" | "production"; dataDir: string } = dev) => {
      try {
        parseJunoBackendConfig(raw, context);
        return [];
      } catch (error) {
        assert.ok(error instanceof JunoConfigError);
        return (error as JunoConfigError).problems.join(" | ");
      }
    };
    assert.match(String(problems(good(), prod)), /development signer is refused in production/);
    assert.match(String(problems(good({ code_checksum: "11".repeat(32) }))), /canonical escrow wasm/);
    assert.match(String(problems(good({ journal_dir: "/data/journal" }), prod)), /OUTSIDE the data directory/);
    assert.match(String(problems(good({ rest_endpoint: "x" }))), /unknown field rest_endpoint/);
    assert.match(String(problems(good({ chain_id: "juno-1" }))), /mainnet chain/);
    assert.match(String(problems(good({ network_class: "mainnet", chain_id: "juno-1" }))), /two independent rest_endpoints/);
    assert.match(String(problems(good({ rest_endpoints: ["http://rest.example"] }))), /not https/);
    assert.match(String(problems(good({ dev_signer: undefined }))), /dev_signer/);
    assert.match(String(problems(good({ gas: { max_gas: "99999999999" } }))), /max gas/);
    assert.deepEqual(CANONICAL_JUNO_ESCROW_CHECKSUMS, [CANONICAL_CHECKSUM]);
    /* ESCROW-JOIN: the escrow 1.0.0 artifact (its Join seated any payer) is refused by name; the admission key is
       required, its own key, and configured by the v2 format only. */
    assert.match(String(problems(good({ code_checksum: HISTORICAL_1_0_0_CHECKSUM }))), /historical escrow 1\.0\.0 artifact/);
    assert.match(String(problems(good({ format: "18COSMOS/JUNO-BACKEND/v1" }))), /format must be 18COSMOS\/JUNO-BACKEND\/v2/);
    assert.match(String(problems(good({ admission_key: undefined }))), /admission_key is required/);
    assert.match(String(problems(good({ admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/settlement.key" } } }))), /admission key and the settlement key must be different keys/);
    assert.match(String(problems(good({ admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/relayer.key" } } }))), /admission key and the relayer key must be different keys/);
    assert.match(String(problems(good({ admission_key: { public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "development", key_file: "/keys/admission.key" } } }))), /admission key and the settlement key must be different keys/);
    assert.match(String(problems(good({ admission_key: { public_key_hex: ADMISSION_PUBKEY.toUpperCase(), signer: { kind: "development", key_file: "/keys/admission.key" } } }))), /admission_key.public_key_hex/);
    assert.match(String(problems(good({ admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/admission.key" }, ttl_secs: 7200 } }))), /ttl_secs must be 120..1800/);
    assert.match(String(problems(good({ admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/admission.key" }, expiry: 1 } }))), /unknown field admission_key.expiry/);
    assert.match(String(problems(good({ admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/admission.key" } } }), prod)), /admission_key: a development signer is refused in production/);
    assert.equal(parseJunoBackendConfig(good(), dev).admissionKey.ttlSecs, 600);
    const parsed = parseJunoBackendConfig(good(), dev);
    const admission = publicKeyOf(ADMISSION_SECRET);
    assert.throws(() => checkSignerIdentities(parsed, publicKeyOf(SETTLEMENT_SECRET), publicKeyOf(SETTLEMENT_SECRET), settlementKeyConfig(), admission), /relayer key controls/);
    assert.throws(() => checkSignerIdentities(parsed, publicKeyOf(RELAYER_SECRET), publicKeyOf(SETTLEMENT_SECRET), settlementKeyConfig(), publicKeyOf(RELAYER_SECRET)), /not the configured admission public key/);
    assert.doesNotThrow(() => checkSignerIdentities(parsed, publicKeyOf(RELAYER_SECRET), publicKeyOf(SETTLEMENT_SECRET), settlementKeyConfig(), admission));
  });

  test("the online checks: verified on the configured chain; another operator, a foreign active key, another code refuse", async () => {
    const world = makeWorld();
    const config = parseJunoBackendConfig(good({ trust: { operators: [RELAYER_ADDRESS], resolvers: ["juno1resolver"].length ? [RELAYER_ADDRESS] : [], min_challenge_window_secs: "60", min_liveness_window_secs: "60", min_resolver_timeout_secs: "60" } }), { serverMode: "development", dataDir: "/data" });
    const trusted = { ...config, trust: { ...config.trust, resolvers: ["juno1resolver"] } };
    assert.equal((await verifyJunoDeployment(trusted, world.chain)).kind, "verified");
    assert.equal((await verifyJunoDeployment({ ...trusted, relayer: { ...trusted.relayer, address: WALLETS[0] } }, world.chain)).kind, "mismatch");
    world.chain.signerKeys.push({ key_id: 2, pubkey: publicKeyOf(RELAYER_SECRET).toString("hex"), retired: false, compromised: false });
    const foreign = await verifyJunoDeployment(trusted, world.chain);
    assert.equal(foreign.kind, "mismatch");
    assert.match((foreign as unknown as { problems: string[] }).problems.join(" "), /active keys this server does not hold/);
    world.chain.signerKeys.pop();
    assert.equal((await verifyJunoDeployment({ ...trusted, codeChecksums: ["22".repeat(32)] }, world.chain)).kind, "mismatch");
    /* ESCROW-JOIN: a contract that verifies another admission key (a rotation this server was not told about, or a
       deployment made for another server) refuses; so does a contract version other than 2.0.0. */
    world.chain.admissionPubkey = publicKeyOf(RELAYER_SECRET).toString("hex");
    const otherKey = await verifyJunoDeployment(trusted, world.chain);
    assert.equal(otherKey.kind, "mismatch");
    assert.match((otherKey as unknown as { problems: string[] }).problems.join(" "), /join-admission key/);
    world.chain.admissionPubkey = ADMISSION_PUBKEY;
    assert.equal((await verifyJunoDeployment(trusted, world.chain)).kind, "verified");
    world.chain.unavailable = true;
    assert.equal((await verifyJunoDeployment(trusted, world.chain)).kind, "unavailable");
  });

  test("gamesDoctor money: the binding, the continuation, the chain progress and each intent's evidence, from the files", async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3b-doctor-"));
    const world = makeWorld({ financial: createFileFinancialGameStore(data), intents: createFileChainIntentStore(data), journal: await openFileSigningJournal(path.join(data, "..", `${path.basename(data)}-journal`)) });
    const session = await dealt(world);
    toStockRound(world, GAME_A, session);
    await world.service.idle();
    await world.relayer.pass(); // one attempt in flight
    const money = await inspectMoney(data);
    assert.equal(money.games.length, 1);
    const game = money.games[0];
    assert.equal(game.phase, "in-progress");
    assert.equal(game.binding?.chain_game_id, "1");
    assert.equal(game.continuation?.financial_protocol, 3, "ESCROW-4: financial protocol 3 (the v3 ticket grants, relayed consent/annul, W-13, the money GameRecord)");
    assert.ok(game.roster !== null && game.chain?.started_height !== null);
    const evidence = game.intents.map((intent) => `${intent.op}:${intent.evidence}`);
    assert.ok(evidence.includes("start:confirmed"));
    assert.ok(evidence.includes("checkpoint:attempted, outcome unknown"), evidence.join(", "));
    assert.equal(JSON.stringify(money).includes("pr_"), false, "no principal id");
    assert.equal(fs.existsSync(path.join(data, "games", "chain-intents")), true);
  });
});

describe("§16 the money deal and §15 identity's security events", () => {
  test("the money roster source deals only on a chain that started with exactly the frozen roster", async () => {
    const world = makeWorld();
    await startIntent(world);
    const record = { game_id: GAME_A, seats: [{ player_id: ALICE }, { player_id: BOB }], variants: VARIANTS } as never;
    const ctx = { shuffle: <T>(items: readonly T[]) => [...items], now: 1 };
    const before = await world.service.rosterSource.plan(record, ctx);
    assert.equal("refusal" in before && before.reason, "The escrow has not started this game yet.");
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const plan = await world.service.rosterSource.plan(record, ctx);
    assert.ok(!("refusal" in plan), JSON.stringify(plan));
    /* A chain that shows another seat (a wallet swapped after the freeze) is never dealt. (A seat's own wallet with
       another ticket is: `escrow3bReversibleStart.test.ts`.) */
    world.chain.games.get(1)!.seats[1].wallet = WALLETS[2];
    const moved = await world.service.rosterSource.plan(record, ctx);
    assert.equal("refusal" in moved && moved.reason, "The escrow's roster changed after it was frozen.");
    const extra = await world.service.rosterSource.plan({ ...(record as object), seats: [{ player_id: ALICE }, { player_id: BOB }, { player_id: "p-carol" }] } as never, ctx);
    assert.ok("refusal" in extra);
  });

  test("identity's security events end unfrozen tickets (recorded), and a restart never restores their standing", async () => {
    const { IdentityService } = await import("../identity/sessions");
    const { createMemoryIdentityStore } = await import("../identity/store");
    const { readSessionCookie } = await import("../identity/cookies");
    const { createAccountWith, keplrAccount } = await import("../testSupport/authorizationWallets");
    const identity = await IdentityService.open(createMemoryIdentityStore(), { policy: { passwordKdf: { logN: 10, r: 1, p: 1 } } });
    const T = 1_760_000_000_000;
    const readOf = (setCookie: string) => readSessionCookie(setCookie.split(";")[0]);
    const boot = await identity.bootstrap({ kind: "none" }, false, T);
    /* PHASE 3 FINAL: an account (username, password, Authorization Wallet); "Confirm it's you" is the password. */
    const created = await createAccountWith(identity, readOf((boot as { setCookie: string }).setCookie), { username: "ann", password: "correct horse battery", displayName: "Ann", wallet: keplrAccount("escrow3b/ann") }, T);
    assert.equal(created.kind, "ok", JSON.stringify(created));
    const laptop = readOf((created as { setCookie: string }).setCookie);
    assert.equal((await identity.reauthenticateWithPassword(laptop, "correct horse battery", T + 1)).kind, "ok");
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3b-identity-"));
    const ledgerOver = () =>
      createWalletTicketLedger({ store: createFileWalletTicketStore(data), standing: (context) => identity.securityStanding(context), holdsSeat: () => true, now: () => T + 2 });
    const ledger = ledgerOver();
    const events: string[] = [];
    identity.setHooks({
      onSecurityEvent: (event) => {
        events.push(event.kind);
        void ledger.gamesOfPrincipal(event.principalId).then((games) => Promise.all(games.map((gameId) => ledger.revokeForSecurityEvent(gameId))));
      },
    });
    const context = identity.securityContextOf(laptop, T + 2)!;
    const issued = await ledger.issue({ binding: { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT }, gameId: GAME_A, playerId: ALICE, wallet: WALLETS[0], context, reauthorized: identity.hasSensitiveAuth(laptop, T + 2) });
    assert.ok(issued.ok, JSON.stringify(issued));
    assert.equal((await ledger.lookupOf(GAME_A))(ALICE, WALLETS[0]), (issued as { ticket: string }).ticket);
    const sessionId = laptop.kind === "session" ? laptop.sessionId : "";
    await identity.revoke(sessionId, "logout", T + 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.includes("family-revoked"));
    const doc = (await createFileWalletTicketStore(data).load(GAME_A)).document;
    assert.equal(doc.grants[0].revoke_reason, "security-event", "the event was recorded against the ticket");
    assert.equal((await ledgerOver().lookupOf(GAME_A))(ALICE, WALLETS[0]), "", "after a restart the ticket still does not stand");
  });
});
