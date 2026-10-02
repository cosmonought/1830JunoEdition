// server/src/escrow/p5IntCrossSlice.test.ts
//
// ==================================================================
//  P5-INT-1: WHERE THE PRESERVED PHASE-5 SLICES MEET -- JX-5B x JX-6B, JX-5B x JX-2B, JX-2B x COST-1
// ==================================================================
//
// Each slice proved its own behaviour on its own branch. On the integration branch they now run together, and three
// seams are new:
//
//   * JX-5B's chain sweep re-offers `settleJob` for an `intent-prepared` record AFTER the observation, from the record
//     it read BEFORE it -- while JX-6B lets that very observation move `intent-prepared` to `disputed`. The re-offered
//     job must re-read the record and do nothing: no settlement signature, no journal slot, no intent.
//   * JX-2B holds a Settle whose submission the chain refused for the relayer ACCOUNT (sdk/5) -- one signature, a page,
//     never re-sent or re-signed -- while JX-5B's sweep keeps re-offering the game's Settle job. The retry must find the
//     existing intent (no second settlement signature, no second intent) and must not make the relayer sign again; after
//     the correction and a restart the same intent lands.
//   * COST-1's single-host metric profile must surface JX-2B's immediate page: `RelayerPaging` (= the relayer's
//     `paging.paged`, awsRuntime) counts as one HostHealthProblems problem.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ALICE, BUILD, PASS, quietConsole } from "../rooms/testSupport";
import { sealOf } from "../rooms/lifecycle";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { createSettlementCoordinator } from "./settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
import type { ChainIntentRecord } from "./chainIntents";
import type { DigestSigner } from "./juno/signer";
import { RELAYER_ADDRESS, makeWorld, move, passRound, play, startedGame, toStockRound, GAME_A, type World } from "./escrow3bSupport";
import { singleHostDerived, type MetricRecord } from "../aws/runtime/runtimeMetrics";

quietConsole();

const WINDOW = 900;

const endedReplay: PrefixReplay = (prefix) => {
  const real = serverPrefixReplay(BUILD)(prefix);
  if (!real.ok) return real;
  return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true } as GameStateResponse };
};

/** The settlement key, counted: every digest it was asked to sign. */
function countedSettlementKey() {
  const asked: string[] = [];
  const wrap = (inner: DigestSigner): DigestSigner => ({
    kind: inner.kind,
    label: inner.label,
    publicKey: inner.publicKey,
    async sign(digest) {
      asked.push(Buffer.from(digest).toString("hex"));
      return inner.sign(digest);
    },
  });
  return { asked, wrap };
}

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

/** A money game played to its sealed terminal intent on the offline chain (the JX-6B shape). */
async function sealedGame(key: ReturnType<typeof countedSettlementKey>): Promise<{ world: World; chainGameId: string }> {
  const world = makeWorld({ replay: endedReplay, challengeWindowSecs: WINDOW, resolverTimeoutSecs: 7200, bondBps: 5000, bondFloor: "1000000", wrapSettlementKey: key.wrap });
  const chainGameId = await startedGame(world, GAME_A);
  const session = play(world, GAME_A, 0);
  await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed !== null);
  toStockRound(world, GAME_A, session);
  await world.drive(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed?.log_len === session.entries.length);
  passRound(world, GAME_A, session);
  move(world, GAME_A, session, ALICE, PASS);
  await world.service.idle();
  await seal(world, GAME_A);
  await world.service.idle();
  return { world, chainGameId };
}

const intentsOf = (world: World): Promise<ChainIntentRecord[]> => world.intents.listGame(GAME_A);
const settlesOf = async (world: World) => (await intentsOf(world)).filter((intent) => intent.op.kind === "settle");
const phaseOf = async (world: World) => (await world.financial.load(GAME_A))?.phase;
const gameOf = (world: World, chainGameId: string) => world.chain.games.get(Number(chainGameId))!;

describe("P5-INT-1: JX-5B's sweep retry meets JX-6B's disputed observation", () => {
  test("Settle and a Challenge land before any observation: the sweep records disputed and its re-offered Settle job signs nothing", async () => {
    const key = countedSettlementKey();
    const { world, chainGameId } = await sealedGame(key);
    await world.drive(async () => gameOf(world, chainGameId).state === "settleable");
    assert.equal(await phaseOf(world), "intent-prepared", "the server has not observed SETTLEABLE yet (the JX-5B retry condition holds)");
    assert.deepEqual(world.chain.challenge(chainGameId, gameOf(world, chainGameId).seats[0].wallet), { ok: true });

    const asked = key.asked.length;
    const intents = (await intentsOf(world)).length;
    const attempts = (await intentsOf(world)).flatMap((intent) => intent.attempts).length;
    for (let i = 0; i < 3; i += 1) {
      await world.service.sweepChain(); // the observation (JX-6B: -> disputed), then the re-offered settleJob (JX-5B)
      await world.service.idle();
      await world.relayer.pass();
      await world.service.idle();
    }
    assert.equal(await phaseOf(world), "disputed");
    assert.equal(key.asked.length, asked, "the re-offered Settle job re-read a disputed record: no settlement signature");
    assert.equal((await intentsOf(world)).length, intents, "no new intent (no Finalize for a game never seen settleable, no second Settle)");
    assert.equal((await intentsOf(world)).flatMap((intent) => intent.attempts).length, attempts, "nothing new signed or broadcast");
    assert.equal((await settlesOf(world)).length, 1);
  });
});

describe("P5-INT-1: JX-2B's account refusal meets JX-5B's sweep retry and COST-1's single-host health", () => {
  test("a Settle refused for insufficient funds: signed once, paged at once, never re-signed by the sweep retries; lands after funding + restart", async () => {
    const key = countedSettlementKey();
    const { world, chainGameId } = await sealedGame(key);
    const [settle] = await settlesOf(world);
    assert.ok(settle !== undefined && settle.attempts.length === 0, "the Settle intent exists and has not been sent yet");
    const settlementSigns = key.asked.length;

    /* The relayer account cannot pay the fee: the ante deducts nothing and CheckTx answers sdk/5. */
    const before = new Set((await intentsOf(world)).flatMap((intent) => intent.attempts.map((a) => `${intent.intent_id}/${a.tx_hash}`)));
    const account = world.chain.accounts.get(RELAYER_ADDRESS)!;
    const funded = account.balance;
    account.balance = BigInt(0);

    for (let i = 0; i < 6; i += 1) {
      await world.relayer.pass();
      await world.service.idle();
      await world.service.sweepChain(); // JX-5B re-offers settleJob: the record is still intent-prepared
      await world.service.idle();
      world.chain.produceBlock(60);
      world.clock.now += 60_000;
    }
    assert.equal(await phaseOf(world), "intent-prepared");
    assert.equal(key.asked.length, settlementSigns, "the sweep retries found the existing Settle intent: no second settlement signature");
    const settles = await settlesOf(world);
    assert.equal(settles.length, 1, "one Settle intent");
    /* The relayer signed exactly ONE transaction on the refused account (the first pending intent it sent -- the terminal
       checkpoint or the Settle), and nothing else after the refusal, whatever the sweeps re-offered. */
    const all = await intentsOf(world);
    const sentSince = all.flatMap((intent) => intent.attempts.filter((a) => !before.has(`${intent.intent_id}/${a.tx_hash}`)).map(() => intent));
    assert.equal(sentSince.length, 1, "JX-2B: one refused submission, never re-sent or re-signed (nothing new signed on the account)");
    assert.ok(settles[0].attempts.length <= 1, "the Settle was signed at most once");
    assert.ok(all.every((intent) => intent.status !== "held"), "an account refusal is a wait + page, never a hold");

    const paging = world.relayer.status().paging;
    assert.ok(paging.paged >= 1 && paging.conditions.some((c) => c.condition === "submission-refused" && c.paged), "submission-refused paged at once");

    /* COST-1: the single host's one health series counts that page (awsRuntime: RelayerPaging = paging.paged). */
    const tick: MetricRecord = { event: "task-status", metrics: { Ready: 1, PoolWriterConfirmed: 1, Standby: 0, Primary: 1, RelayerUsable: 1, EscrowActive: 1, RelayerPaging: paging.paged, RestoreUnverifiedGames: 0, KmsSigns: 1 } };
    assert.equal(singleHostDerived({ ...tick, metrics: { ...tick.metrics, RelayerPaging: 0 } }).HostHealthProblems, 0, "the same tick without the page is healthy");
    assert.equal(singleHostDerived(tick).HostHealthProblems, 1, "the page is exactly one standing problem on the single host");

    /* The operator funds the account and restarts the relayer: the SAME intent lands; the settlement key signs nothing new. */
    account.balance = funded;
    await world.restart();
    await world.drive(async () => (await phaseOf(world)) === "settleable");
    assert.equal(gameOf(world, chainGameId).state, "settleable");
    const after = await settlesOf(world);
    assert.equal(after.length, 1);
    assert.equal(after[0].intent_id, settles[0].intent_id, "the same Settle intent");
    assert.equal(key.asked.length, settlementSigns, "no settlement signature for any of it");
  });
});
