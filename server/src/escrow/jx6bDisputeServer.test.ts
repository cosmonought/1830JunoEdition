// server/src/escrow/jx6bDisputeServer.test.ts
//
// ==================================================================
//  JX-6B: THE SERVER THROUGH A DISPUTE, ON THE OFFLINE CHAIN
// ==================================================================
//
// The escrow's dispute paths (`contracts/escrow/src/execute/dispute.rs`) move money only by a seat's Challenge, the
// game's resolver, or a seat's resolver-timeout exit -- never by this server. What the server owes them is truthful
// bookkeeping, and that is what these tests pin:
//
//   * the financial record goes `disputed` at the first DISPUTED observation -- from `settleable`, and also from
//     `intent-prepared` when Settle and the Challenge both landed between two observations;
//   * nothing is signed or broadcast for a disputed game, across restarts; a Finalize never lands on it;
//   * the record closes with the chain's own route (resolver Uphold / Replace / Annul, the resolver timeout);
//   * a Finalize intent is CONFIRMED only when Finalize itself ended the escrow on its settlement (route `finalized`);
//     every other terminal route supersedes it (unnecessary, never "done").
//
// The fake chain (`juno/fakeJunoChain.ts`) models Challenge with its bond, the resolver's three outcomes and the
// DISPUTED arm of LivenessSettle as the contract decides them; the server reads them through the production parser.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ALICE, BUILD, PASS, quietConsole } from "../rooms/testSupport";
import { sealOf } from "../rooms/lifecycle";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { createSettlementCoordinator } from "./settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
import type { ChainIntentRecord } from "./chainIntents";
import { transitionFinancial, type FinancialGameRecord } from "./moneyLifecycle";
import { makeWorld, move, passRound, play, startedGame, toStockRound, GAME_A, type World } from "./escrow3bSupport";

quietConsole();

const WINDOW = 900;
const RESOLVER_TIMEOUT = 7200;
const RESOLVER = "juno1resolver"; // escrow3bSupport's fake-chain resolver

/** The real replay of the sealed prefix, with GameEnd (bank broken) grafted on. */
const endedReplay: PrefixReplay = (prefix) => {
  const real = serverPrefixReplay(BUILD)(prefix);
  if (!real.ok) return real;
  return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true } as GameStateResponse };
};

async function seal(world: World, gameId: string): Promise<void> {
  const entries = world.logs.get(gameId) ?? [];
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
}

const intentsOf = (world: World): Promise<ChainIntentRecord[]> => world.intents.listGame(GAME_A);
const finalizesOf = async (world: World) => (await intentsOf(world)).filter((intent) => intent.op.kind === "finalize");
const attemptsOf = async (world: World) => (await intentsOf(world)).flatMap((intent) => intent.attempts).length;
const phaseOf = async (world: World) => (await world.financial.load(GAME_A))?.phase;
const gameOf = (world: World, chainGameId: string) => world.chain.games.get(Number(chainGameId))!;

/** A money game played to its sealed terminal intent on the offline chain (900 s window, 1 JUNOX-style bond floor). */
async function sealedGame(): Promise<{ world: World; chainGameId: string }> {
  const world = makeWorld({ replay: endedReplay, challengeWindowSecs: WINDOW, resolverTimeoutSecs: RESOLVER_TIMEOUT, bondBps: 5000, bondFloor: "1000000" });
  const chainGameId = await startedGame(world, GAME_A);
  const session = play(world, GAME_A, 0);
  await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed !== null);
  toStockRound(world, GAME_A, session);
  await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed?.log_len === session.entries.length);
  passRound(world, GAME_A, session);
  move(world, GAME_A, session, ALICE, PASS);
  await world.service.idle();
  await seal(world, GAME_A);
  return { world, chainGameId };
}

/** ...then observed SETTLEABLE: the record is `settleable` and its Finalize intent waits for the window. */
async function settleableGame(): Promise<{ world: World; chainGameId: string }> {
  const { world, chainGameId } = await sealedGame();
  await world.drive(async () => (await phaseOf(world)) === "settleable");
  assert.equal(gameOf(world, chainGameId).state, "settleable");
  return { world, chainGameId };
}

/** Observation passes without the relayer's block production racing the test (60 s per pass). */
async function observe(world: World, rounds: number, seconds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await world.service.sweepChain();
    await world.relayer.pass();
    await world.service.idle();
    world.chain.produceBlock(seconds);
    world.clock.now += seconds * 1000;
  }
}

/** A Finalize waiting for the window is deferred to the window's end (`retry.next_at`, server clock): move the server
 *  clock past it so the relayer looks at the intent again (the chain's time is the test's to move). */
const due = (world: World) => {
  world.clock.now += (WINDOW + 60) * 1000;
};

/** One relayer pass (and the service's reaction) with no time moving. */
async function onePass(world: World): Promise<void> {
  await world.relayer.pass();
  await world.service.idle();
}

describe("JX-6B: a disputed game in the financial record", () => {
  test("A. a Challenge observed from settleable: disputed; the pending Finalize is superseded, never sent or confirmed", async () => {
    const { world, chainGameId } = await settleableGame();
    const [finalize] = await finalizesOf(world);
    assert.ok(finalize !== undefined && finalize.status === "pending", "the Finalize intent waits for the window");
    const game = gameOf(world, chainGameId);
    assert.deepEqual(world.chain.challenge(chainGameId, game.seats[1].wallet), { ok: true });
    assert.equal(game.dispute?.bond, "1000000", "the frozen bond: max(floor, 50% of the net ante)");

    await observe(world, 30); // well past the 900 s window
    assert.equal(await phaseOf(world), "disputed");
    assert.equal(game.state, "disputed");
    assert.equal(game.outcome, null, "nothing was paid out of DISPUTED");
    const [after] = await finalizesOf(world);
    assert.equal(after.status, "superseded");
    assert.match(after.superseded?.why ?? "", /DISPUTED/);
    assert.equal(after.attempts.length, 0, "no Finalize was ever signed");
  });

  test("B. the race: Settle and a Challenge both land before the server observes SETTLEABLE -- the first observation records disputed", async () => {
    const { world, chainGameId } = await sealedGame();
    /* Drive only until the Settle is on chain (the relayer's own confirmation), then challenge before any observation. */
    await world.drive(async () => gameOf(world, chainGameId).state === "settleable");
    assert.equal(await phaseOf(world), "intent-prepared", "the server has not observed SETTLEABLE yet");
    assert.deepEqual(world.chain.challenge(chainGameId, gameOf(world, chainGameId).seats[0].wallet), { ok: true });

    await world.service.sweepChain();
    await world.service.idle();
    const record = await world.financial.load(GAME_A);
    assert.equal(record?.phase, "disputed", "DISPUTED proves a stored settlement: the record follows it from intent-prepared");
    assert.equal(record?.chain.settle_confirmed, null, "nothing about the settlement is invented");
    assert.deepEqual(record?.transitions.at(-1)?.to, "disputed");
    assert.equal((await finalizesOf(world)).length, 0, "no Finalize was ever created for a game the server never saw settleable");

    /* Restart while disputed: no signature, no broadcast, still disputed. */
    const attempts = await attemptsOf(world);
    const broadcasts = world.chain.broadcasts.length;
    await world.restart();
    await observe(world, 10);
    assert.equal(await phaseOf(world), "disputed");
    assert.equal(await attemptsOf(world), attempts);
    assert.equal(world.chain.broadcasts.length, broadcasts, "a restart broadcasts nothing for a disputed game");

    /* The resolver timeout, then a restart: the record closes with the chain's route. */
    world.chain.produceBlock(RESOLVER_TIMEOUT);
    assert.deepEqual(world.chain.resolverTimeoutExit(chainGameId, gameOf(world, chainGameId).seats[1].wallet), { ok: true });
    await world.restart();
    await observe(world, 3);
    const closed = await world.financial.load(GAME_A);
    assert.equal(closed?.phase, "closed");
    assert.deepEqual(closed?.chain_outcome && { state: closed.chain_outcome.state, route: closed.chain_outcome.route }, { state: "SETTLED", route: "resolver_timeout_payout" });
    assert.equal(await attemptsOf(world), attempts, "the server signed nothing for any of it");
  });

  test("B'. a restart BEFORE the first observation of the race: the load observes DISPUTED and records it", async () => {
    const { world, chainGameId } = await sealedGame();
    await world.drive(async () => gameOf(world, chainGameId).state === "settleable");
    assert.equal(await phaseOf(world), "intent-prepared");
    world.chain.challenge(chainGameId, gameOf(world, chainGameId).seats[1].wallet);
    const attempts = await attemptsOf(world);
    await world.restart();
    await observe(world, 3);
    assert.equal(await phaseOf(world), "disputed");
    assert.equal(await attemptsOf(world), attempts, "the resumed intent-prepared record signs nothing over a disputed escrow");
  });

  test("C. DISPUTED survives a restart: nothing signed, no Finalize broadcast, still disputed", async () => {
    const { world, chainGameId } = await settleableGame();
    world.chain.challenge(chainGameId, gameOf(world, chainGameId).seats[1].wallet);
    await observe(world, 3);
    assert.equal(await phaseOf(world), "disputed");
    const attempts = await attemptsOf(world);
    const broadcasts = world.chain.broadcasts.length;
    for (let i = 0; i < 2; i += 1) {
      await world.restart();
      await observe(world, 20); // past the window each time
      assert.equal(await phaseOf(world), "disputed");
    }
    assert.equal(await attemptsOf(world), attempts);
    assert.equal(world.chain.broadcasts.length, broadcasts);
    assert.ok((await finalizesOf(world)).every((intent) => intent.status !== "confirmed" && intent.attempts.length === 0));
  });

  test("the transition rules: disputed from settleable or intent-prepared only; every other phase waits for the chain's close", () => {
    const base = { phase: "settleable" } as unknown as FinancialGameRecord;
    for (const phase of ["settleable", "intent-prepared"] as const) {
      const decided = transitionFinancial({ ...base, phase, transitions: [] } as unknown as FinancialGameRecord, { kind: "chain-disputed", at: 1 });
      assert.equal(decided.kind, "moved", phase);
      if (decided.kind === "moved") assert.equal(decided.next.phase, "disputed");
    }
    for (const phase of ["disputed", "closed"] as const) assert.equal(transitionFinancial({ ...base, phase } as unknown as FinancialGameRecord, { kind: "chain-disputed", at: 1 }).kind, "same", phase);
    for (const phase of ["funding", "in-progress", "liveness", "terminal-eligible", "held", "cancelled"] as const) {
      assert.equal(transitionFinancial({ ...base, phase } as unknown as FinancialGameRecord, { kind: "chain-disputed", at: 1 }).kind, "refused", phase);
    }
  });
});

describe("JX-6B: the resolver's routes close the record; a pending Finalize is never counted as executed", () => {
  /** Challenge and the decision land in the same block, before the relayer looks again: its Finalize intent is still
   *  pending when the escrow is already terminal by another route. */
  async function decided(decide: (world: World, chainGameId: string) => void): Promise<{ world: World; finalize: ChainIntentRecord; record: FinancialGameRecord | null }> {
    const { world, chainGameId } = await settleableGame();
    const [pending] = await finalizesOf(world);
    assert.equal(pending?.status, "pending");
    assert.deepEqual(world.chain.challenge(chainGameId, gameOf(world, chainGameId).seats[1].wallet), { ok: true });
    decide(world, chainGameId);
    due(world);
    await onePass(world);
    await observe(world, 2);
    const finalize = (await finalizesOf(world)).find((intent) => intent.intent_id === pending.intent_id)!;
    return { world, finalize, record: await world.financial.load(GAME_A) };
  }
  const notExecuted = (finalize: ChainIntentRecord, route: RegExp) => {
    assert.equal(finalize.status, "superseded", "unnecessary, not done");
    assert.equal(finalize.confirmation, null, "never recorded as executed");
    assert.match(finalize.superseded?.why ?? "", route);
    assert.equal(finalize.attempts.length, 0);
  };

  test("D. resolver Uphold: SETTLED resolver_uphold; the bond joined the pool; FIN closed; Finalize superseded", async () => {
    const { world, finalize, record } = await decided((w, id) => assert.deepEqual(w.chain.resolve(id, RESOLVER, { uphold: {} }), { ok: true }));
    notExecuted(finalize, /resolver_uphold/);
    assert.deepEqual(record?.chain_outcome && { state: record.chain_outcome.state, route: record.chain_outcome.route }, { state: "SETTLED", route: "resolver_uphold" });
    assert.equal(record?.phase, "closed");
    const outcome = world.chain.games.values().next().value!.outcome!;
    assert.equal(outcome.bond_to_pool, "1000000");
  });

  test("E. resolver Replace: SETTLED resolver_replace on a ResolverCorrection; the bond returned; Finalize superseded", async () => {
    const { world, finalize, record } = await decided((w, id) => assert.deepEqual(w.chain.resolve(id, RESOLVER, { replace: { settlement_weights: ["1", "1"] } }), { ok: true }));
    notExecuted(finalize, /resolver_replace/);
    assert.equal(record?.chain_outcome?.route, "resolver_replace");
    assert.equal(record?.phase, "closed");
    const game = world.chain.games.values().next().value!;
    assert.equal(game.settlement?.source, "resolver_replacement");
    assert.equal(game.settlement?.payload.reason, 5);
    assert.equal(game.outcome?.bond_returned, "1000000");
  });

  test("F. resolver Annul: ANNULLED resolver_annul; FIN closed; Finalize superseded", async () => {
    const { finalize, record } = await decided((w, id) => assert.deepEqual(w.chain.resolve(id, RESOLVER, { annul: {} }), { ok: true }));
    notExecuted(finalize, /ANNULLED/);
    assert.deepEqual(record?.chain_outcome && { state: record.chain_outcome.state, route: record.chain_outcome.route }, { state: "ANNULLED", route: "resolver_annul" });
    assert.equal(record?.phase, "closed");
  });

  test("G. resolver timeout payout: SETTLED resolver_timeout_payout; FIN closed; Finalize superseded", async () => {
    const { finalize, record } = await decided((w, id) => {
      w.chain.produceBlock(RESOLVER_TIMEOUT);
      assert.deepEqual(w.chain.resolverTimeoutExit(id, w.chain.games.get(Number(id))!.seats[0].wallet), { ok: true });
    });
    notExecuted(finalize, /resolver_timeout_payout/);
    assert.equal(record?.chain_outcome?.route, "resolver_timeout_payout");
    assert.equal(record?.phase, "closed");
  });

  test("H. resolver timeout refund (the settlement key compromised, no trusted checkpoint): CANCELLED; FIN closed; Finalize superseded", async () => {
    const { finalize, record } = await decided((w, id) => {
      for (const key of w.chain.signerKeys) key.compromised = true;
      w.chain.produceBlock(RESOLVER_TIMEOUT);
      assert.deepEqual(w.chain.resolverTimeoutExit(id, w.chain.games.get(Number(id))!.seats[0].wallet), { ok: true });
    });
    notExecuted(finalize, /CANCELLED/);
    assert.deepEqual(record?.chain_outcome && { state: record.chain_outcome.state, route: record.chain_outcome.route }, { state: "CANCELLED", route: "resolver_timeout_refund" });
    assert.equal(record?.phase, "closed");
  });

  test("the fake contract refuses what the escrow refuses: another resolver, a second Challenge, a wrong bond, an early timeout exit, a non-seat", async () => {
    const { world, chainGameId } = await settleableGame();
    const seat = gameOf(world, chainGameId).seats[1].wallet;
    assert.equal(world.chain.challenge(chainGameId, seat, { bond: "999999" }).ok, false);
    assert.equal(world.chain.challenge(chainGameId, "juno1outsider").ok, false);
    assert.equal(world.chain.resolve(chainGameId, RESOLVER, { uphold: {} }).ok, false, "no dispute yet");
    assert.deepEqual(world.chain.challenge(chainGameId, seat), { ok: true });
    assert.equal(world.chain.challenge(chainGameId, seat).ok, false, "one Challenge per game");
    assert.equal(world.chain.resolve(chainGameId, "juno1admin", { uphold: {} }).ok, false);
    world.chain.produceBlock(RESOLVER_TIMEOUT - 1);
    assert.equal(world.chain.resolverTimeoutExit(chainGameId, seat).ok, false, "7199 s");
    world.chain.produceBlock(1);
    assert.equal(world.chain.resolverTimeoutExit(chainGameId, "juno1outsider").ok, false);
    assert.deepEqual(world.chain.resolverTimeoutExit(chainGameId, seat), { ok: true }, "7200 s");
  });
});

describe("JX-6B: the Finalize intent's effect, state by state", () => {
  async function pendingFinalize(): Promise<{ world: World; chainGameId: string; finalize: ChainIntentRecord }> {
    const { world, chainGameId } = await settleableGame();
    const [finalize] = await finalizesOf(world);
    assert.equal(finalize?.status, "pending");
    return { world, chainGameId, finalize };
  }
  const reread = async (world: World, intent: ChainIntentRecord) => (await world.intents.load(GAME_A, intent.intent_id))!;
  /** The escrow made terminal by `route` on its stored settlement (what another actor's transaction leaves behind). */
  const terminal = (world: World, chainGameId: string, state: string, route: string) =>
    world.chain.forceState(chainGameId, { state, outcome: { route, at: world.chain.time, amounts: ["1000000", "1000000"], dust: "0" } });

  test("1. SETTLEABLE, window open: waiting -- not done, nothing signed", async () => {
    const { world, finalize } = await pendingFinalize();
    await onePass(world);
    const now = await reread(world, finalize);
    assert.equal(now.status, "pending");
    assert.equal(now.attempts.length, 0);
    assert.equal(now.confirmation, null);
  });

  test("2. SETTLEABLE, window closed: eligible -- it is sent, included, and confirmed by its transaction", async () => {
    const { world, finalize } = await pendingFinalize();
    world.chain.produceBlock(WINDOW + 1);
    due(world);
    await world.drive(async () => (await phaseOf(world)) === "closed", 40);
    const now = await reread(world, finalize);
    assert.equal(now.status, "confirmed");
    assert.equal(now.confirmation?.how, "tx");
    assert.equal((await world.financial.load(GAME_A))?.chain_outcome?.route, "finalized");
  });

  test("3. DISPUTED: never sent; superseded", async () => {
    const { world, chainGameId, finalize } = await pendingFinalize();
    world.chain.challenge(chainGameId, gameOf(world, chainGameId).seats[1].wallet);
    world.chain.produceBlock(WINDOW + 1); // even with the window long closed
    due(world);
    await onePass(world);
    const now = await reread(world, finalize);
    assert.equal(now.status, "superseded");
    assert.equal(now.attempts.length, 0);
    assert.match(now.superseded?.why ?? "", /DISPUTED/);
  });

  test("4. SETTLED by `finalized` on its own settlement: DONE (confirmed from chain state)", async () => {
    const { world, chainGameId, finalize } = await pendingFinalize();
    terminal(world, chainGameId, "settled", "finalized");
    due(world);
    await onePass(world);
    const now = await reread(world, finalize);
    assert.equal(now.status, "confirmed");
    assert.equal(now.confirmation?.how, "chain-state");
  });

  for (const [state, route, label] of [
    ["settled", "consent_completed", "5"],
    ["settled", "resolver_uphold", "6"],
    ["settled", "resolver_replace", "7"],
    ["settled", "resolver_timeout_payout", "8"],
    ["settled", "settleable_timeout_payout", "8b"],
    ["annulled", "resolver_annul", "9"],
    ["annulled", "annul_by_consent", "9b"],
    ["cancelled", "resolver_timeout_refund", "10"],
  ] as const) {
    test(`${label}. ${state.toUpperCase()} by \`${route}\`: NOT done -- superseded, no confirmation`, async () => {
      const { world, chainGameId, finalize } = await pendingFinalize();
      terminal(world, chainGameId, state, route);
      due(world);
      await onePass(world);
      const now = await reread(world, finalize);
      assert.equal(now.status, "superseded", route);
      assert.equal(now.confirmation, null);
      assert.equal(now.attempts.length, 0);
      if (state === "settled") assert.match(now.superseded?.why ?? "", new RegExp(`settled by ${route}`));
      await observe(world, 1);
      assert.equal((await world.financial.load(GAME_A))?.chain_outcome?.route, route, "the record closes with the chain's own route");
    });
  }

  test("11. SETTLED by `finalized` on ANOTHER settlement than the intent's: not this Finalize -- superseded", async () => {
    const { world, chainGameId, finalize } = await pendingFinalize();
    const game = gameOf(world, chainGameId);
    game.settlement = { ...game.settlement!, payload: { ...game.settlement!.payload, seq: "2", payload_digest: "ab".repeat(32) } }; // a promoted checkpoint, say
    terminal(world, chainGameId, "settled", "finalized");
    due(world);
    await onePass(world);
    const now = await reread(world, finalize);
    assert.equal(now.status, "superseded");
    assert.equal(now.confirmation, null);
  });

  test("12. SETTLEABLE again on ANOTHER stored settlement: this intent is moot (it never Finalizes a settlement it was not made for)", async () => {
    const { world, chainGameId, finalize } = await pendingFinalize();
    const game = gameOf(world, chainGameId);
    game.settlement = { ...game.settlement!, payload: { ...game.settlement!.payload, seq: "2", payload_digest: "ab".repeat(32) } };
    world.chain.produceBlock(WINDOW + 1);
    due(world);
    await onePass(world);
    const now = await reread(world, finalize);
    assert.equal(now.status, "superseded");
    assert.equal(now.attempts.length, 0, "nothing was signed");
    assert.match(now.superseded?.why ?? "", /no longer seq/);
  });
});
