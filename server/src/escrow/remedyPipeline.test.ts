// server/src/escrow/remedyPipeline.test.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS (FP4): THE CLOCK'S DECISION -> THE DEDICATED REMEDY SIGNATURE -> ONE FP4 INTENT -> THE CHAIN
// ==================================================================
//
// Over the offline chain (escrow 2.1.0 semantics) and the real escrow service and relayer (`escrow3bSupport.ts`):
//
//   1. FAIL CLOSED: no REMEDY key configured -> every remedy refused (the settlement signer never substitutes); a key
//      the chain does not hold (or holds retired) -> refused; a chain that cannot be read by QUORUM -> refused, nothing
//      written; an overdue earlier than the chain's first allowance after Start -> never attested;
//   2. the attestation's times come only from the sealed decision and the quorum block time (no wall clock), in whole
//      seconds rounded up (integers only), the Live finality floor and the strike-3 rule applied;
//   3. ONE intent per decision: a second attempt is idempotent (`exists`), a restart finds it, and the chain is
//      confirmed once; the clock's sealed remedy is carried to a closed money game through the controller's own gate;
//   4. the gate: only the clock's current authority relays; a sealed decision survives a restart without any vote;
//   5. N-1 approvals: a seat's REMEDY-APPROVE verifies under its CURRENT consent key for exactly that overdue and
//      horizon; a horizon too short (or a self-approval, or a wrong key) is refused; a Live foreclosure whose approvals
//      lapsed falls back to the neutral timeout annulment;
//   6. the async bind: an async chain game is bound only under the table's recorded deadline (the same pace, or none).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";

import { remedyApproveDigestV1, type RemedyKindByte } from "../../../frontend/src/gameEngine/escrow/junoRemedyV1";
import { RoomSession } from "../../../frontend/src/utils/roomSession";
import { DEFAULT_SANDBOX_SCENARIO, sandboxReplayProviders, sandboxScenario, sandboxScenarioState, sandboxWaterfallState, waterfallForRoster, withEmptyRoster } from "../../../frontend/src/gameEngine";
import { ALICE, BOB, BUILD, SETUP } from "../rooms/testSupport";
import type { GameActor, Tx } from "../rooms/gameActor";
import { createClockController } from "../rooms/clock/clockController";
import { createMemoryClockStore } from "../rooms/clock/clockStore";
import type { ClockRemedy } from "../rooms/clock/clockRecord";
import { LIVE_ACTION_MS, LIVE_CURE_MS } from "../rooms/clock/clockRecord";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import { publicKeyOf, signDigest } from "./juno/secp256k1";
import { deterministicTestRemedySigner } from "./juno/remedySigner";
import { createRemedyPipeline, remedyTimes, secsUp, type RemedyPort } from "./remedyPipeline";
import { CHAIN_ID, CONTRACT, GAME_A, VARIANTS, fundedGame, makeWorld, startedGame, type World, type WorldOptions } from "./escrow3bSupport";

const sha = (label: string) => createHash("sha256").update(label).digest();
const REMEDY_SECRET = sha("18JUNO/TEST/remedy/1");
const REMEDY_PUB = publicKeyOf(REMEDY_SECRET).toString("hex");
const OTHER_SECRET = sha("18JUNO/TEST/remedy/other");
const seatSecret = (seat: number) => sha(`consent-${seat}`);
const OPEN_GATE: NonNullable<WorldOptions["remedyGate"]> = async () => ({ kind: "ok" });

interface FakeChainGame {
  state: string;
  started_at: number;
  domain: string;
  remedy: { kind: string; remedy_digest: string } | null;
  outcome: { route: string; amounts: string[] } | null;
}
const gameOf = (world: World, chainGameId: string) => world.chain.games.get(Number(chainGameId)) as unknown as FakeChainGame;

async function liveWorld(options: WorldOptions = {}): Promise<{ world: World; chainGameId: string }> {
  const world = makeWorld({ remedyKeys: [REMEDY_PUB], remedyGate: OPEN_GATE, ...options });
  const chainGameId = await startedGame(world, GAME_A, { live_action_clock: {} });
  return { world, chainGameId };
}

/** The clock's sealed Live decision for the chain game (ALICE = seat 0 defaulting unless told). */
function sealed(world: World, chainGameId: string, kind: 1 | 2 | 3, over: Partial<ClockRemedy> = {}): ClockRemedy {
  const started = gameOf(world, chainGameId).started_at;
  const overdueMs = (started + 1_200) * 1000 + 250; // a sub-second overdue moment: rounded UP on the wire
  return {
    kind,
    seat: ALICE,
    strike: kind === 3 ? 3 : 1,
    epoch: 1,
    log_len: 1,
    log_hash: "ab".repeat(32),
    allowance_secs: 1_200,
    overdue_ms: overdueMs,
    final_ms: kind === 3 ? overdueMs : overdueMs + LIVE_CURE_MS,
    approvals: [],
    evidence: { format: "18COSMOS/CLOCK-EVIDENCE/v1", game_id: GAME_A, prev_head: "00".repeat(32), events: [], truncated: false },
    evidence_hash: "ef".repeat(32),
    sealed_at: overdueMs + LIVE_CURE_MS,
    status: "sealed",
    detail: null,
    attestations: 0,
    replaces: null,
    ...over,
  };
}

function pipeline(world: World, signer = deterministicTestRemedySigner(1, REMEDY_SECRET)): RemedyPort {
  return createRemedyPipeline({ service: world.service, signer, now: () => world.clock.now, warn: () => undefined });
}

/** Chain and server clock move together. */
function advanceTo(world: World, secs: number): void {
  const delta = secs - world.chain.time;
  if (delta <= 0) return;
  world.chain.time = secs;
  world.clock.now += delta * 1000;
}

const remedyIntents = async (world: World) => (await world.intents.listGame(GAME_A)).filter((intent) => intent.op.kind === "remedy");

describe("FP4 remedy pipeline: fail closed", () => {
  test("no REMEDY key configured: every remedy is refused, nothing is written (the settlement signer never substitutes)", async () => {
    const { world, chainGameId } = await liveWorld();
    const port = createRemedyPipeline({ service: world.service, signer: null, now: () => world.clock.now, warn: () => undefined });
    assert.equal(port.configured, false);
    const attempt = await port.attest(GAME_A, sealed(world, chainGameId, 1));
    assert.equal(attempt.status, "refused");
    assert.match(attempt.detail ?? "", /no dedicated REMEDY key/);
    assert.deepEqual(await remedyIntents(world), []);
  });

  test("a key the chain does not hold as this server's active REMEDY key: refused, nothing written", async () => {
    const { world, chainGameId } = await liveWorld();
    const wrong = await pipeline(world, deterministicTestRemedySigner(1, OTHER_SECRET)).attest(GAME_A, sealed(world, chainGameId, 1));
    assert.equal(wrong.status, "refused");
    assert.match(wrong.detail ?? "", /not this server's active key/);
    const unregistered = await pipeline(world, deterministicTestRemedySigner(2, REMEDY_SECRET)).attest(GAME_A, sealed(world, chainGameId, 1));
    assert.equal(unregistered.status, "refused");
    assert.deepEqual(await remedyIntents(world), []);
  });

  test("the chain cannot be read by quorum: refused (nothing attested on one node's word); an overdue before the chain's first allowance is never attested", async () => {
    const { world, chainGameId } = await liveWorld();
    world.chain.quorumDisagrees = true;
    const split = await pipeline(world).attest(GAME_A, sealed(world, chainGameId, 1));
    assert.equal(split.status, "refused");
    assert.match(split.detail ?? "", /quorum/);
    world.chain.quorumDisagrees = false;
    const started = gameOf(world, chainGameId).started_at;
    const early = await pipeline(world).attest(GAME_A, sealed(world, chainGameId, 1, { overdue_ms: (started + 1_000) * 1000, final_ms: (started + 1_600) * 1000 }));
    assert.equal(early.status, "refused");
    assert.match(early.detail ?? "", /precedes the chain's first allowance/);
    assert.deepEqual(await remedyIntents(world), []);
  });
});

describe("FP4 remedy pipeline: the attestation's times and the one intent", () => {
  test("times from the sealed decision only, whole seconds rounded UP; Live finality floor; strike 3 final at overdue", () => {
    assert.equal(secsUp(1_000), BigInt(1));
    assert.equal(secsUp(1_001), BigInt(2));
    assert.equal(secsUp(0), BigInt(0));
    const base = { overdue_ms: 1_000_000_250, final_ms: 1_000_000_250 + 599_000 };
    assert.deepEqual(remedyTimes({ kind: 1, ...base }), { overdueAt: BigInt(1_000_001), finalAt: BigInt(1_000_601) }, "never earlier than overdue + 600 s");
    assert.deepEqual(remedyTimes({ kind: 3, ...base }), { overdueAt: BigInt(1_000_001), finalAt: BigInt(1_000_001) });
    assert.deepEqual(remedyTimes({ kind: 4, overdue_ms: 5_000, final_ms: 4_000 }), { overdueAt: BigInt(5), finalAt: BigInt(5) });
  });

  test("a sealed Live timeout annulment: ONE intent (idempotent), relayed once the chain reaches finality, confirmed; the money game closes", async () => {
    const { world, chainGameId } = await liveWorld();
    const port = pipeline(world);
    const remedy = sealed(world, chainGameId, 1);
    const first = await port.attest(GAME_A, remedy);
    assert.deepEqual([first.status, first.attested], ["submitted", true], JSON.stringify(first));
    const again = await port.attest(GAME_A, { ...remedy, status: "submitted" });
    assert.deepEqual([again.status, again.attested], ["submitted", false], "the same decision is never attested twice while open");
    const intents = await remedyIntents(world);
    assert.equal(intents.length, 1);
    const op = intents[0].op as { remedy: number; overdue_epoch: string; log_len: string; strike: number };
    assert.deepEqual([op.remedy, op.overdue_epoch, op.log_len, op.strike], [1, "1", "1", 1]);
    assert.equal(await port.progress(GAME_A, remedy), "open");
    advanceTo(world, Number(remedyTimes(remedy).finalAt) + 1);
    await world.drive(async () => (await port.progress(GAME_A, remedy)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).state, "annulled");
    assert.equal(gameOf(world, chainGameId).outcome?.route, "remedy_timeout_annul");
    await world.drive(async () => (await world.financial.load(GAME_A))?.phase === "closed");
    const after = await port.attest(GAME_A, remedy);
    assert.equal(after.status, "confirmed", "nothing after the decision landed");
    await world.restart();
    assert.equal((await remedyIntents(world)).length, 1, "a restart finds the one intent; nothing new is written");
  });
});

describe("FP4 remedy pipeline: N-1 approvals", () => {
  test("a REMEDY-APPROVE verifies under the seat's current consent key for exactly that overdue and horizon; the rest are refused", async () => {
    const { world, chainGameId } = await liveWorld();
    const port = pipeline(world);
    const remedy = sealed(world, chainGameId, 2);
    const g = gameOf(world, chainGameId);
    const finalNotBefore = remedy.overdue_ms + LIVE_CURE_MS;
    const until = Number(secsUp(finalNotBefore)) + 3_600;
    const digest = (seat: number, approveUntil: number, over: { log_len?: number } = {}) =>
      remedyApproveDigestV1(
        { domain: g.domain, chain_game_id: BigInt(chainGameId), remedy: 2 as RemedyKindByte, defaulting_seat: 0, strike: 1, overdue_epoch: BigInt(1), log_len: BigInt(over.log_len ?? 1), log_hash: remedy.log_hash, overdue_at: secsUp(remedy.overdue_ms) },
        BigInt(approveUntil),
        seat,
      );
    const signed = (seat: number, approveUntil: number, secret = seatSecret(seat), over: { log_len?: number } = {}) => signDigest(secret, Buffer.from(digest(seat, approveUntil, over), "hex")).toString("hex");
    const check = (approvingSeat: string, approveUntil: number, signature: string) =>
      port.verifyApproval(GAME_A, { remedy: 2, defaultingSeat: ALICE, approvingSeat, strike: 1, epoch: 1, logLen: 1, logHash: remedy.log_hash, overdueMs: remedy.overdue_ms, approveUntil, signature, finalNotBeforeMs: finalNotBefore, nowMs: world.clock.now });
    assert.equal(await check(BOB, until, signed(1, until)), null, "a valid approval");
    assert.match((await check(BOB, until, signed(1, until, seatSecret(2)))) ?? "", /does not verify under your seat's current consent key/);
    assert.match((await check(BOB, until, signed(1, until, seatSecret(1), { log_len: 2 }))) ?? "", /does not verify/, "bound to the exact overdue instance");
    const short = Number(secsUp(finalNotBefore)) + 30;
    assert.match((await check(BOB, short, signed(1, short))) ?? "", /must last until at least/);
    const far = Number(secsUp(remedy.overdue_ms)) + 7 * 3600;
    assert.match((await check(BOB, far, signed(1, far))) ?? "", /six hours/);
    assert.match((await check(ALICE, until, signed(0, until))) ?? "", /cannot approve a remedy against itself/);
    assert.equal(await check(BOB, until, "zz"), "the approval is not a 64-byte signature");
  });

  test("a Live foreclosure with a valid N-1 approval is attested with it; one whose approval lapsed falls back to the neutral annulment", async () => {
    const { world, chainGameId } = await liveWorld();
    const port = pipeline(world);
    const g = gameOf(world, chainGameId);
    const base = sealed(world, chainGameId, 2);
    const finalSecs = Number(remedyTimes(base).finalAt);
    const approval = (until: number) => ({
      seat: BOB,
      approve_until: until,
      signature: signDigest(
        seatSecret(1),
        Buffer.from(
          remedyApproveDigestV1(
            { domain: g.domain, chain_game_id: BigInt(chainGameId), remedy: 2, defaulting_seat: 0, strike: 1, overdue_epoch: BigInt(1), log_len: BigInt(1), log_hash: base.log_hash, overdue_at: secsUp(base.overdue_ms) },
            BigInt(until),
            1,
          ),
          "hex",
        ),
      ).toString("hex"),
    });
    advanceTo(world, finalSecs + 10);
    const lapsed = await port.attest(GAME_A, { ...base, approvals: [approval(finalSecs + 5)] });
    assert.equal(lapsed.status, "refused");
    assert.equal(lapsed.fallback, true, "the neutral timeout annulment replaces it");
    assert.deepEqual(await remedyIntents(world), []);
    const good = await port.attest(GAME_A, { ...base, approvals: [approval(finalSecs + 3_600)] });
    assert.deepEqual([good.status, good.attested], ["submitted", true], JSON.stringify(good));
    await world.drive(async () => (await port.progress(GAME_A, base)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).remedy?.kind, "live_foreclose");
  });
});

/* ==================================================================
    THE CLOCK, THE PIPELINE AND THE CHAIN TOGETHER
   ================================================================== */

/** A money table's clock controller over the world: the real controller, a memory store, controlled time tied to the
 *  world's server clock and the chain's block time, and the remedy port bound late. */
function moneyTable(world: World, chainGameId: string, signer = deterministicTestRemedySigner(1, REMEDY_SECRET)) {
  let n = 0;
  const session = new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `m-${(n += 1)}`,
    now: () => world.clock.now,
  });
  const game = {
    gameId: GAME_A,
    get view() {
      return { entries: session.entries, record: { variants: { mode: "live" }, money: { mode: "live" } } };
    },
  } as unknown as GameActor;
  const tx = { session } as unknown as Tx;
  const pending = new Map<number, { at: number; fire: () => void }>();
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };
  const port = createRemedyPipeline({ service: world.service, signer, now: () => world.clock.now, warn: () => undefined });
  const store = createMemoryClockStore();
  const clock = createClockController({
    store,
    authority: "auth-1",
    now: () => world.clock.now,
    timers: {
      set(fire, ms) {
        seq += 1;
        pending.set(seq, { at: world.clock.now + Math.max(0, ms), fire });
        return seq;
      },
      clear(handle) {
        pending.delete(handle as number);
      },
    },
    ops: createMemoryOpsRecorder(),
    warn: () => undefined,
    runOn: (_g, _l, task) => serial(() => task(game, tx)).then(() => true),
    onChange: () => undefined,
    serving: () => true,
    closeOffer: async () => ({ ok: false, why: "no offers here" }),
    remedy: () => port,
    moneyStartedAtSecs: async () => gameOf(world, chainGameId).started_at,
  });
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    clock,
    port,
    store,
    async deal() {
      assert.equal((await clock.createMoneyPolicy(GAME_A, "live", null)).ok, true);
      const start = session.entries.length;
      session.submit({ actor: ALICE, build: BUILD, msg: SETUP as never, baseIndex: -1, submissionId: "deal" });
      const batch = session.entries.slice(start);
      await serial(() => clock.afterCommit(game, { gate: { ok: true, now: world.clock.now, before: null, cls: "deal", revertTarget: null }, actor: ALICE, batch, board: session.state }));
    },
    /** Server time (and the chain's block time with it) moves; every clock timer it passes fires in order. */
    async advance(ms: number) {
      const target = world.clock.now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        world.clock.now = Math.max(world.clock.now, due[1].at);
        world.chain.time = Math.max(world.chain.time, Math.floor(world.clock.now / 1000));
        due[1].fire();
        await settle();
      }
      world.clock.now = target;
      world.chain.time = Math.max(world.chain.time, Math.floor(target / 1000));
      await settle();
      await serial(async () => undefined);
      await clock.settled(GAME_A);
    },
    record: () => clock.recordOf(GAME_A),
    serial,
    game,
    tx,
  };
}

describe("FP4 end to end: the table clock's decision reaches the chain, and only on the clock's word", () => {
  test("Live: no cure by 30:00 -> the clock seals the neutral timeout annulment -> ONE attested intent -> confirmed on chain -> the money game closes", async () => {
    let gate: NonNullable<WorldOptions["remedyGate"]> = async () => ({ kind: "wait", why: "not bound yet" });
    const { world, chainGameId } = await liveWorld({ remedyGate: (g, i) => gate(g, i) });
    const table = moneyTable(world, chainGameId);
    gate = (g, i) => table.clock.remedyGate(g, i);
    await table.deal();
    const started = gameOf(world, chainGameId).started_at;
    assert.equal(table.record()?.obligation?.began_at, started * 1000, "the first obligation never starts before the chain's Start");
    const toOverdue = started * 1000 + LIVE_ACTION_MS - world.clock.now;
    await table.advance(toOverdue + LIVE_CURE_MS);
    const record = table.record();
    assert.equal(record?.ended?.kind, "live-timeout-annul");
    assert.equal(record?.remedy?.kind, 1);
    assert.equal(record?.remedy?.overdue_ms, started * 1000 + LIVE_ACTION_MS);
    await world.drive(async () => (await table.port.progress(GAME_A, table.record()!.remedy!)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).state, "annulled");
    assert.equal((await remedyIntents(world)).length, 1);
    await world.drive(async () => (await world.financial.load(GAME_A))?.phase === "closed");
  });

  test("the gate: only the clock's CURRENT authority relays (a takeover's record waits until this process adopts it); a restart releases a sealed decision without any vote", async () => {
    let gate: NonNullable<WorldOptions["remedyGate"]> = async () => ({ kind: "wait", why: "not bound yet" });
    const { world, chainGameId } = await liveWorld({ remedyGate: (g, i) => gate(g, i) });
    const table = moneyTable(world, chainGameId);
    gate = (g, i) => table.clock.remedyGate(g, i);
    await table.deal();
    const started = gameOf(world, chainGameId).started_at;
    await table.advance(started * 1000 + LIVE_ACTION_MS + LIVE_CURE_MS - world.clock.now);
    const remedy = table.record()!.remedy!;
    const intents = await remedyIntents(world);
    assert.equal(intents.length, 1);
    /* Another process took the table's clock over (its write is the stored record): this one no longer relays it. */
    const sealedRecord = table.record()!;
    await table.store.save({ ...sealedRecord, authority: "auth-other", revision: sealedRecord.revision + 1 }, sealedRecord.revision);
    table.clock.drop(GAME_A);
    const verdict = await table.clock.remedyGate(GAME_A, intents[0]);
    assert.equal(verdict.kind, "wait");
    assert.match((verdict as { why: string }).why, /not the table clock's current authority/);
    const relayer = (await import("./escrow3bSupport")).RELAYER_ADDRESS;
    const sequence = (world.chain.accounts.get(relayer) as { sequence: bigint }).sequence;
    for (let round = 0; round < 3; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
    }
    assert.equal((world.chain.accounts.get(relayer) as { sequence: bigint }).sequence, sequence, "nothing relayed on another authority's word");
    /* This process adopts the table (a load: a continuity break): the ENDED game is not paused -- its sealed decision is
       released with no vote (a defaulter cannot hold its own remedy hostage), and never re-decided. */
    await table.serial(() => table.clock.op(table.game, table.tx, { type: "clock-ack", seat: ALICE }).then(() => undefined));
    const adopted = table.record()!;
    assert.equal(adopted.system, null);
    assert.equal(adopted.authority, "auth-1");
    assert.deepEqual(adopted.remedy?.evidence_hash, remedy.evidence_hash);
    assert.equal((await table.clock.remedyGate(GAME_A, intents[0])).kind, "ok");
    await world.drive(async () => (await table.port.progress(GAME_A, remedy)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).state, "annulled");
  });
});

describe("Async money tables bind only under the table's recorded deadline", () => {
  test("the same pace binds; another pace, Live or an unrecorded table is refused; No-deadline binds a no_deadline game only", async () => {
    const cases: Array<[string, { deadline: "live" | "async-pace" | "no-deadline"; paceSecs: number | null } | null, Parameters<typeof fundedGame>[3], boolean, RegExp | null]> = [
      ["same pace", { deadline: "async-pace", paceSecs: 86_400 }, { async_pace: { allowance_secs: 86_400 } }, true, null],
      ["other pace", { deadline: "async-pace", paceSecs: 43_200 }, { async_pace: { allowance_secs: 86_400 } }, false, /not the table's 43200 s/],
      ["unrecorded", null, { async_pace: { allowance_secs: 86_400 } }, false, /not recorded for this table/],
      ["no-deadline", { deadline: "no-deadline", paceSecs: null }, { no_deadline: {} }, true, null],
      ["no-deadline table, paced game", { deadline: "no-deadline", paceSecs: null }, { async_pace: { allowance_secs: 86_400 } }, false, /no action deadline/],
      ["paced table, no_deadline game", { deadline: "async-pace", paceSecs: 86_400 }, { no_deadline: {} }, false, /not the table's 86400 s/],
    ];
    for (const [name, table, deadline, ok, why] of cases) {
      const world = makeWorld({ remedyKeys: [REMEDY_PUB], remedyGate: OPEN_GATE, tableDeadline: async () => table });
      assert.ok((await world.service.createMoneyGame(GAME_A)).ok, name);
      const chainGameId = await fundedGame(world, GAME_A, undefined, deadline);
      const bound = await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS);
      assert.equal(bound.ok, ok, `${name}: ${JSON.stringify(bound)}`);
      if (why !== null) assert.match((bound as { detail: string }).detail, why, name);
    }
    /* A Live chain game under a table recorded as async: refused. */
    const world = makeWorld({ remedyKeys: [REMEDY_PUB], remedyGate: OPEN_GATE, tableDeadline: async () => ({ deadline: "async-pace", paceSecs: 86_400 }) });
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    const live = await fundedGame(world, GAME_A, undefined, { live_action_clock: {} });
    const refused = await world.service.bindChainGame(GAME_A, live, VARIANTS);
    assert.equal(refused.ok, false);
    assert.equal(CHAIN_ID.length > 0 && CONTRACT.length > 0, true);
  });
});
