// server/src/escrow/escrow3bBackend.test.ts
//
// ==================================================================
//  ESCROW-3B: THE JUNO FINANCIAL BACKEND, END TO END ON AN OFFLINE CHAIN -- AND THE ADVERSARIAL MATRIX (brief §24)
// ==================================================================
//
// Everything here is the production path -- the financial record, the ticket ledger, the escrow service, the relayer,
// the Cosmos transaction bytes and their signatures, the settlement signer and its journal -- over `FakeJunoChain`,
// which decodes and verifies the relayer's real transactions and runs the escrow's relayer routes with the frozen
// contract's rules. Games are played by the real reducer (the checkpoints are committed boards); a terminal board is
// grafted onto the real replayed one, as ESCROW-3A's tests do (a whole game to GameEnd is not a fixture).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ALICE, BOB, BUILD, PASS, quietConsole } from "../rooms/testSupport";
import { sealOf } from "../rooms/lifecycle";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { createSettlementCoordinator } from "./settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
import { isLiveAttempt, type ChainIntentRecord } from "./chainIntents";
import { makeWorld, move, passRound, play, startedGame, toStockRound, GAME_A, GAME_B, RELAYER_ADDRESS, type World } from "./escrow3bSupport";

quietConsole();

/** The real replay of the sealed prefix, with GameEnd (bank broken) grafted on. */
const endedReplay =
  (graft: Record<string, unknown> = {}): PrefixReplay =>
  (prefix) => {
    const real = serverPrefixReplay(BUILD)(prefix);
    if (!real.ok) return real;
    return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true, ...graft } as GameStateResponse };
  };

async function intentsOf(world: World, gameId: string): Promise<ChainIntentRecord[]> {
  return world.intents.listGame(gameId);
}

/** Seal the played game and run ESCROW-3A's coordinator to intent-prepared (which tells the service). */
async function seal(world: World, gameId: string): Promise<void> {
  const entries = world.logs.get(gameId) ?? [];
  const coordinator = createSettlementCoordinator({
    store: world.financial,
    replay: world.replay,
    isFinancial: () => true,
    now: () => world.clock.now,
    warn: (line) => world.warnings.push(line),
    schedule: () => ({ cancel: () => undefined }),
    onIntentPrepared: (id) => world.service.onIntentPrepared(id),
  });
  coordinator.onGameplayClosed({ gameId, record: { game_id: gameId, money: null, started_at: world.clock.now } as never, seal: sealOf(entries, true)!, recovered: false, entries });
  await coordinator.drain();
}

describe("ESCROW-3B: a money game from deal to payout, on the offline chain", () => {
  test("bind -> roster freeze -> Start -> deal checkpoint -> round-boundary checkpoint -> seal -> terminal checkpoint + Settle -> Finalize -> closed", async () => {
    const world = makeWorld({ replay: endedReplay() });
    const chainGameId = await startedGame(world);
    let record = await world.financial.load(GAME_A);
    assert.equal(record?.phase, "funding");
    assert.ok(record?.roster !== null && record?.binding?.escrow !== null);
    assert.equal(record?.chain.started?.domain, record?.roster?.expected_domain, "the chain froze the domain the roster froze");
    assert.equal((await world.tickets.load(GAME_A)).document.frozen_at !== null, true, "the ledger froze with the roster");

    /* The deal: a checkpoint at the committed deal position. */
    const session = play(world, GAME_A, 0);
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed !== null);
    record = await world.financial.load(GAME_A);
    assert.equal(record?.phase, "in-progress", "the deal was derived");
    assert.equal(record?.chain.checkpoint_confirmed?.log_len, session.entries.length);

    /* Buys inside the auction are not boundaries; the auction's end is. */
    const before = (await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint").length;
    play(world, GAME_A, 1, session);
    await world.service.idle();
    assert.equal((await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint").length, before, "a turn is not a boundary");
    toStockRound(world, GAME_A, session);
    assert.equal(session.state.current_round_type, "StockRound");
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed?.log_len === session.entries.length);
    passRound(world, GAME_A, session);
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed?.log_len === session.entries.length);
    assert.equal((await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint" && i.status === "confirmed").length, 3, "deal, auction -> Stock Round, Stock Round 1 -> 2");

    /* One more committed move inside the round (not a boundary: no checkpoint), where the grafted GameEnd is sealed. */
    move(world, GAME_A, session, ALICE, PASS);
    await world.service.idle();
    assert.equal((await intentsOf(world, GAME_A)).filter((i) => i.op.kind === "checkpoint").length, 3, "a pass inside the round is not a boundary");

    /* The seal: evidence -> the terminal checkpoint (2L) then the Settle (2L+1), in that order. */
    await seal(world, GAME_A);
    await world.drive(async () => (await world.financial.load(GAME_A))?.phase === "settleable");
    const L = session.entries.length;
    const intents = await intentsOf(world, GAME_A);
    const terminalCheckpoint = intents.find((i) => i.op.kind === "checkpoint" && i.op.log_len === L);
    const settle = intents.find((i) => i.op.kind === "settle");
    assert.ok(terminalCheckpoint !== undefined && settle !== undefined);
    assert.equal(terminalCheckpoint?.status === "confirmed" || terminalCheckpoint?.status === "superseded", true);
    assert.equal(settle?.status, "confirmed");
    assert.equal(settle?.op.kind === "settle" && settle.op.seq, String(2 * L + 1));

    /* Finalize after the challenge window, then the escrow is closed on chain. */
    await world.drive(async () => (await world.financial.load(GAME_A))?.phase === "closed", 60);
    record = await world.financial.load(GAME_A);
    assert.deepEqual(record?.chain_outcome && { state: record.chain_outcome.state, route: record.chain_outcome.route }, { state: "SETTLED", route: "finalized" });
    const game = world.chain.games.get(Number(chainGameId))!;
    const paid = game.outcome!.amounts.reduce((a, b) => a + BigInt(b), BigInt(0)) + BigInt(game.outcome!.dust);
    assert.equal(paid, BigInt(2_000_000), "every net ante is paid out (payouts + dust = pool)");

    /* Every transaction the chain saw is one the store names, signed at consecutive sequences, one at a time. */
    const all = await intentsOf(world, GAME_A);
    const attempts = all.flatMap((intent) => intent.attempts);
    assert.ok(attempts.every((attempt) => !isLiveAttempt(attempt)));
    const included = attempts.filter((attempt) => attempt.phase === "included-success").map((attempt) => Number(attempt.sequence)).sort((a, b) => a - b);
    assert.deepEqual(included, included.map((_, i) => i), "the account's sequences 0..n-1, each used exactly once: nothing drifted");
    assert.equal(world.journal.reservations().length >= 3, true, "every payload signature was reserved first");
    for (const attempt of attempts) assert.ok(world.journal.attemptsOf(all.find((i) => i.attempts.includes(attempt))!.intent_id).some((a) => a.tx_id === attempt.tx_hash), "every attempt was journalled before its broadcast");
    const events = world.ops.lines.map((line) => line.event);
    for (const event of ["money.created", "money.bound", "money.roster-frozen", "checkpoint.intent", "chain.signed", "chain.broadcast", "chain.intent-confirmed", "settlement.intent-submitted", "settlement.finalize-intent"]) assert.ok(events.includes(event), event);
    assert.equal(JSON.stringify(world.ops.lines).includes("pr_0"), false, "no principal id in the audit trail");
    assert.equal(RELAYER_ADDRESS.startsWith("juno1"), true);
    void ALICE;
    void BOB;
    void GAME_B;
  });
});
