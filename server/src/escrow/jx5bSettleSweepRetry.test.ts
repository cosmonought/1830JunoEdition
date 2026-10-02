// server/src/escrow/jx5bSettleSweepRetry.test.ts
//
// ==================================================================
//  JX-5B: A TRANSIENTLY FAILED TERMINAL SETTLE JOB IS RETRIED BY THE PERIODIC CHAIN SWEEP -- WITHOUT DUPLICATE WORK
// ==================================================================
//
// Before JX-5B, `settleJob` ran only from the coordinator's `onIntentPrepared` and from `load()`. A transient failure
// before the Settle intent was durably written (the settlement key unavailable, a chain read, the intent store) left
// the financial record at `intent-prepared` with no Settle until the process restarted. JX-5B: `sweepChain` re-offers
// `settleJob` for an `intent-prepared` game through the SAME per-game queue, after the game's ordinary chain
// observation. Every case below drives the production service, journal and relayer over the offline chain, and counts
// what the settlement key was asked to sign, what the journal reserved and which intents (and relay-queue entries) exist.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ALICE, BUILD, PASS, quietConsole } from "../rooms/testSupport";
import { sealOf } from "../rooms/lifecycle";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { escrowInstanceKey } from "../../../frontend/src/gameEngine/escrow/escrowModel";
import { createSettlementCoordinator } from "./settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
import { createMemoryChainIntentStore, type ChainIntentRecord, type ChainIntentStore } from "./chainIntents";
import { createMemorySigningJournal } from "./signingJournal";
import { createMemoryFinancialGameStore, type FinancialGameStore } from "./financialGameStore";
import { transitionFinancial, type FinancialGameRecord } from "./moneyLifecycle";
import { SignerError, type DigestSigner } from "./juno/signer";
import { GAME_A, PIN, WALLETS, makeWorld, play, startedGame, toStockRound, type World } from "./escrow3bSupport";

quietConsole();

const endedReplay: PrefixReplay = (prefix) => {
  const real = serverPrefixReplay(BUILD)(prefix);
  if (!real.ok) return real;
  return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true } as GameStateResponse };
};

/* ------------------------------------------------------------------ */
/* Instruments                                                         */
/* ------------------------------------------------------------------ */

type KmsStep = "ok" | "down" | "lost";

/** The settlement key, wrapped: every digest it is asked for, how many signatures it really made, how many were in
 *  flight at once, an optional gate that holds a call, and a plan for the next calls (else `mode`). `down`: refused
 *  before any signature (a throttle); `lost`: the signature WAS made, its answer lost (`signatureMayExist`). */
function controllableKms() {
  const state = {
    mode: "ok" as KmsStep,
    plan: [] as KmsStep[],
    asked: [] as string[],
    signed: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    gate: null as Promise<void> | null,
  };
  const wrap = (inner: DigestSigner): DigestSigner => ({
    kind: inner.kind,
    label: inner.label,
    publicKey: inner.publicKey,
    async sign(digest) {
      const hex = Buffer.from(digest).toString("hex");
      state.asked.push(hex);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.gate !== null) await state.gate;
        const step = state.plan.length > 0 ? (state.plan.shift() as KmsStep) : state.mode;
        if (step === "down") throw new SignerError("unavailable", "KMS Sign failed: ThrottlingException (test)", { signatureMayExist: false });
        const signature = await inner.sign(digest);
        state.signed.push(hex);
        if (step === "lost") throw new SignerError("unavailable", "KMS Sign: the answer was lost (test)", { signatureMayExist: true });
        return signature;
      } finally {
        state.inFlight -= 1;
      }
    },
  });
  return { state, wrap };
}

/** The memory intent store WITH its relay queue (as the DynamoDB store keeps `RELAYQ#`), whose `create` of a Settle
 *  intent can be made to fail (a store outage after the payload was signed). */
function faultyIntents() {
  const inner = createMemoryChainIntentStore({ relayQueue: true });
  const faults = { settleCreateFailures: 0, settleCreates: 0 };
  const store: ChainIntentStore = {
    ...inner,
    async create(record: ChainIntentRecord) {
      if (record.op.kind === "settle") {
        faults.settleCreates += 1;
        if (faults.settleCreateFailures > 0) {
          faults.settleCreateFailures -= 1;
          return { kind: "failed" as const, detail: "the intent store refused the write (test)" };
        }
      }
      return inner.create(record);
    },
  };
  return { store, inner, faults };
}

/** The memory financial store, counting its reads (a test waits until the sweep has read a record). */
function countedFinancial() {
  const inner = createMemoryFinancialGameStore();
  const counter = { loads: 0 };
  const store: FinancialGameStore = {
    ...inner,
    async load(gameId: string) {
      counter.loads += 1;
      return inner.load(gameId);
    },
  };
  return { store, counter };
}

function harness() {
  const kms = controllableKms();
  const intents = faultyIntents();
  const financial = countedFinancial();
  const journal = createMemorySigningJournal(() => Date.now());
  const world = makeWorld({ replay: endedReplay, wrapSettlementKey: kms.wrap, intents: intents.store, journal, financial: financial.store });
  return { world, kms, intents, journal, financial };
}

/** Macrotask turns until `done()` (bounded): lets queued promise chains reach a known point. */
async function waitFor(done: () => boolean, turns = 2000): Promise<void> {
  for (let i = 0; i < turns && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), "the awaited point was reached");
}

const fin = (world: World) => world.financial.load(GAME_A) as Promise<FinancialGameRecord>;
const intentsOf = (world: World) => world.intents.listGame(GAME_A);
const settles = async (world: World) => (await intentsOf(world)).filter((i) => i.op.kind === "settle");
const checkpointsAt = async (world: World, logLen: number) => (await intentsOf(world)).filter((i) => i.op.kind === "checkpoint" && i.op.log_len === logLen);

/** A started game, dealt, its deal checkpoint confirmed, one more move inside the auction (not a boundary). */
async function played(world: World) {
  await startedGame(world, GAME_A);
  const session = play(world, GAME_A, 0);
  await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed !== null);
  play(world, GAME_A, 1, session);
  await world.service.idle();
  return session;
}

/** The seal, through ESCROW-3A's coordinator, which calls `onIntentPrepared` (the initial Settle attempt). */
async function seal(world: World): Promise<number> {
  const entries = world.logs.get(GAME_A) ?? [];
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
  coordinator.onGameplayClosed({ gameId: GAME_A, record: { game_id: GAME_A, money: null, started_at: world.clock.now } as never, seal: sealOf(entries, true)!, recovered: false, entries });
  await coordinator.drain();
  await world.service.idle();
  return entries.length;
}

/** Relayer passes and blocks WITHOUT any sweep (nothing but the relayer and the chain move). */
async function passesOnly(world: World, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await world.relayer.pass();
    await world.service.idle();
    world.chain.produceBlock();
    world.clock.now += 6_000;
  }
}

async function sweep(world: World): Promise<void> {
  await world.service.sweepChain();
  await world.service.idle();
}

async function reservationsAt(world: World, journal: ReturnType<typeof createMemorySigningJournal>, seq: number) {
  const instance = escrowInstanceKey((await fin(world)).binding!.escrow!);
  return (await journal.reservations(instance)).filter((r) => r.seq === String(seq));
}

/** The Settle signature failed transiently at the seal: intent-prepared, no Settle, no hold. Returns L. */
async function stuck(h: ReturnType<typeof harness>): Promise<number> {
  await played(h.world);
  h.kms.state.mode = "down";
  const L = await seal(h.world);
  const record = await fin(h.world);
  assert.equal(record.phase, "intent-prepared");
  assert.equal(record.hold, null);
  assert.equal((await settles(h.world)).length, 0);
  assert.ok(h.world.warnings.some((line) => line.includes("the settlement for") && line.includes("failed")), "the initial settleJob failed (logged)");
  return L;
}

/* ------------------------------------------------------------------ */

describe("JX-5B: the chain sweep retries a transiently failed terminal Settle job", () => {
  test("1. a KMS outage during the Settle signature: no restart -- the next sweep writes ONE Settle and the game settles", async () => {
    const h = harness();
    const L = await stuck(h);
    /* The defect: nothing but a restart re-ran settleJob. With the key back and the relayer and chain moving, still no Settle. */
    h.kms.state.mode = "ok";
    await passesOnly(h.world, 3);
    assert.equal((await fin(h.world)).phase, "intent-prepared");
    assert.equal((await settles(h.world)).length, 0, "relayer passes alone never re-run the Settle job");
    /* The periodic sweep. */
    await sweep(h.world);
    const written = await settles(h.world);
    assert.equal(written.length, 1, "one Settle intent");
    assert.equal(written[0].op.kind === "settle" && written[0].op.seq, String(2 * L + 1));
    assert.equal((await checkpointsAt(h.world, L)).length, 1, "the terminal checkpoint (2L) too");
    /* The ordinary flow continues: SETTLEABLE, then Finalize after the window, then closed. */
    await h.world.drive(async () => (await fin(h.world)).phase === "settleable");
    await h.world.drive(async () => (await fin(h.world)).phase === "closed", 60);
    assert.deepEqual({ state: (await fin(h.world)).chain_outcome?.state, route: (await fin(h.world)).chain_outcome?.route }, { state: "SETTLED", route: "finalized" });
    assert.equal(h.intents.inner.queue.size, 0, "RELAYQ empty at the end");
  });

  test("2. a KMS outage across several sweeps: never a hold, no state damage, one reservation per slot; recovery at the first sweep after it ends", async () => {
    const h = harness();
    const L = await stuck(h);
    const askedAtStuck = h.kms.state.asked.length;
    const signedAtStuck = h.kms.state.signed.length;
    for (let i = 0; i < 4; i += 1) {
      await sweep(h.world);
      await passesOnly(h.world, 1);
      const record = await fin(h.world);
      assert.equal(record.phase, "intent-prepared", `sweep ${i}: still waiting`);
      assert.equal(record.hold, null, `sweep ${i}: an unavailable key is never a hold`);
      assert.equal((await settles(h.world)).length, 0);
    }
    assert.ok(h.kms.state.asked.length > askedAtStuck, "each sweep did retry");
    assert.equal(h.kms.state.signed.length, signedAtStuck, "nothing was signed while the key was down");
    assert.equal((await reservationsAt(h.world, h.journal, 2 * L)).length, 1, "the terminal checkpoint's digest reserved ONCE across every retry");
    h.kms.state.mode = "ok";
    await sweep(h.world);
    assert.equal((await settles(h.world)).length, 1);
    assert.equal((await reservationsAt(h.world, h.journal, 2 * L + 1)).length, 1);
    await h.world.drive(async () => (await fin(h.world)).phase === "settleable");
  });

  test("3 / E. intents.create fails AFTER the Settle payload was signed: the sweep re-signs the SAME digest and exactly one durable Settle results", async () => {
    const h = harness();
    await played(h.world);
    h.intents.faults.settleCreateFailures = 1;
    const L = await seal(h.world);
    assert.equal((await fin(h.world)).phase, "intent-prepared");
    assert.equal((await settles(h.world)).length, 0, "no Settle intent was written");
    assert.equal((await checkpointsAt(h.world, L)).length, 1, "the terminal checkpoint was");
    const reserved = await reservationsAt(h.world, h.journal, 2 * L + 1);
    assert.equal(reserved.length, 1, "the Settle digest was reserved before its signature");
    const settleDigest = reserved[0].digest_hex;
    assert.equal(h.kms.state.signed.filter((d) => d === settleDigest).length, 1, "and it was signed once");
    await sweep(h.world);
    const written = await settles(h.world);
    assert.equal(written.length, 1, "exactly one durable Settle intent");
    assert.equal(written[0].op.kind === "settle" && written[0].op.settle_digest, settleDigest, "the same payload digest");
    assert.equal(h.kms.state.signed.filter((d) => d === settleDigest).length, 2, "a second ECDSA signature of the SAME reserved digest");
    assert.equal((await reservationsAt(h.world, h.journal, 2 * L + 1)).length, 1, "still one reservation");
    assert.equal(h.intents.faults.settleCreates, 2);
    await h.world.drive(async () => (await fin(h.world)).phase === "settleable");
  });

  test("4 / B. the Settle intent already exists: repeated sweeps never ask the key again, never write a second intent or relay-queue entry", async () => {
    const h = harness();
    await played(h.world);
    const L = await seal(h.world);
    assert.equal((await settles(h.world)).length, 1);
    assert.equal((await fin(h.world)).phase, "intent-prepared", "not yet observed on chain (no relayer pass)");
    const asked = h.kms.state.asked.length;
    const intents = JSON.stringify(await intentsOf(h.world));
    const queue = JSON.stringify([...h.intents.inner.queue.entries()].sort());
    const reservations = (await h.journal.reservations()).length;
    for (let i = 0; i < 3; i += 1) await sweep(h.world);
    assert.equal(h.kms.state.asked.length, asked, "no settlement KMS Sign");
    assert.equal(JSON.stringify(await intentsOf(h.world)), intents, "no intent written or rewritten");
    assert.equal(JSON.stringify([...h.intents.inner.queue.entries()].sort()), queue, "no RELAYQ entry added");
    assert.equal((await h.journal.reservations()).length, reservations, "no journal reservation");
    assert.equal(h.intents.faults.settleCreates, 1);
    await h.world.drive(async () => (await fin(h.world)).phase === "settleable");
    void L;
  });

  test("5 / C + D. the terminal checkpoint exists, the Settle signature's answer was LOST: the checkpoint is never re-signed; the Settle recovers once", async () => {
    const h = harness();
    await played(h.world);
    h.kms.state.plan = ["ok", "lost"]; // the terminal checkpoint signs; the Settle is signed but its answer is lost
    const L = await seal(h.world);
    const checkpoint = (await checkpointsAt(h.world, L))[0];
    assert.ok(checkpoint !== undefined && checkpoint.op.kind === "checkpoint");
    const checkpointDigest = checkpoint.op.kind === "checkpoint" ? checkpoint.op.settle_digest : "";
    assert.equal((await settles(h.world)).length, 0);
    const reserved = (await reservationsAt(h.world, h.journal, 2 * L + 1))[0];
    assert.equal(h.kms.state.signed.filter((d) => d === reserved.digest_hex).length, 1, "a signature exists, its answer lost");
    await sweep(h.world);
    await sweep(h.world);
    assert.equal(h.kms.state.asked.filter((d) => d === checkpointDigest).length, 1, "the checkpoint is never re-signed");
    assert.equal((await checkpointsAt(h.world, L)).length, 1);
    const written = await settles(h.world);
    assert.equal(written.length, 1);
    assert.equal(written[0].op.kind === "settle" && written[0].op.settle_digest, reserved.digest_hex, "the reserved digest is unchanged");
    assert.equal((await reservationsAt(h.world, h.journal, 2 * L + 1)).length, 1);
    /* The fresh signature is a valid one: the offline chain verifies it on the Settle. */
    await h.world.drive(async () => (await fin(h.world)).phase === "settleable");
  });

  test("6. the financial record leaves intent-prepared while the sweep's retry waits in the game's queue: the retry re-reads and does nothing", async () => {
    const h = harness();
    await stuck(h);
    let release: () => void = () => undefined;
    h.kms.state.gate = new Promise<void>((resolve) => (release = resolve));
    h.kms.state.plan = ["down"]; // the call held at the gate will fail when released
    h.kms.state.mode = "ok";
    h.world.service.onIntentPrepared(GAME_A); // an in-flight Settle job, held inside the settlement key
    await waitFor(() => h.kms.state.inFlight === 1);
    const loads = h.financial.counter.loads;
    const sweeping = h.world.service.sweepChain(); // it reads the record (intent-prepared); its jobs queue behind the held one
    await waitFor(() => h.financial.counter.loads > loads);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.kms.state.inFlight, 1, "the first job is still held");
    /* The record moves while the retry is queued (an operator hold, here). */
    const record = await fin(h.world);
    const held = transitionFinancial(record, { kind: "hold", at: h.world.clock.now, code: "chain-intent-held", detail: "JX-5B test: moved while queued" });
    assert.equal(held.kind, "moved");
    assert.equal((await h.world.financial.put((held as { next: FinancialGameRecord }).next, record.record_version)).kind, "committed");
    const askedBefore = h.kms.state.asked.length;
    h.kms.state.gate = null;
    release();
    await sweeping;
    await h.world.service.idle();
    assert.equal(h.kms.state.asked.length, askedBefore, "the queued retry asked the key nothing");
    assert.equal((await settles(h.world)).length, 0);
    assert.equal((await fin(h.world)).phase, "held");
  });

  test("7. two sweeps close together: the per-game queue serializes them -- one Settle job at a time, one signature per slot", async () => {
    const h = harness();
    const L = await stuck(h);
    let release: () => void = () => undefined;
    h.kms.state.gate = new Promise<void>((resolve) => (release = resolve));
    h.kms.state.mode = "ok";
    const asked = h.kms.state.asked.length;
    h.kms.state.maxInFlight = 0;
    const a = h.world.service.sweepChain();
    const b = h.world.service.sweepChain();
    await waitFor(() => h.kms.state.inFlight === 1); // one sweep's Settle job is inside the key; the other's waits
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.kms.state.inFlight, 1);
    h.kms.state.gate = null;
    release();
    await Promise.all([a, b]);
    await h.world.service.idle();
    assert.equal(h.kms.state.maxInFlight, 1, "never two settlement signatures at once");
    const newly = h.kms.state.asked.slice(asked);
    assert.equal(newly.length, 2, "the terminal checkpoint and the Settle, each once");
    assert.equal(new Set(newly).size, 2);
    assert.equal((await settles(h.world)).length, 1);
    assert.equal((await checkpointsAt(h.world, L)).length, 1);
  });

  test("8. restart recovery is unchanged: the load re-runs the Settle job with no sweep", async () => {
    const h = harness();
    await stuck(h);
    h.kms.state.mode = "ok";
    const summary = await h.world.restart();
    await h.world.service.idle();
    assert.equal(summary.resumed, 1);
    assert.equal((await settles(h.world)).length, 1);
    await h.world.drive(async () => (await fin(h.world)).phase === "settleable");
  });

  test("F. the game already moved on chain: the sweep's observation closes the record first; the retry signs nothing", async () => {
    const h = harness();
    const L = await stuck(h);
    h.world.chain.forceState("1", { state: "settled", outcome: { route: "liveness_refund", at: 1, amounts: ["1000000", "1000000"], dust: "0" } });
    h.kms.state.mode = "ok";
    const asked = h.kms.state.asked.length;
    await sweep(h.world);
    const record = await fin(h.world);
    assert.equal(record.phase, "closed");
    assert.deepEqual({ state: record.chain_outcome?.state, route: record.chain_outcome?.route }, { state: "SETTLED", route: "liveness_refund" });
    assert.equal(h.kms.state.asked.length, asked, "no settlement signature for a game the chain already ended");
    assert.equal((await settles(h.world)).length, 0);
    assert.equal((await reservationsAt(h.world, h.journal, 2 * L + 1)).length, 0, "no reservation of a Settle the chain no longer needs");
    await sweep(h.world);
    assert.equal(h.kms.state.asked.length, asked, "a closed game is never re-offered");
  });

  test("G. a game this pool does not serve (another contract configured): the sweep re-offers nothing that signs", async () => {
    const h = harness();
    await stuck(h);
    h.world.pin = { ...PIN, contract_address: WALLETS[2] };
    await h.world.restart();
    h.kms.state.mode = "ok";
    const asked = h.kms.state.asked.length;
    const before = JSON.stringify(await fin(h.world));
    await sweep(h.world);
    assert.equal(h.kms.state.asked.length, asked, "nothing signed");
    assert.equal((await settles(h.world)).length, 0);
    assert.equal(JSON.stringify(await fin(h.world)), before, "the record is untouched (not continued here, never held)");
  });

  test("journal first-writer-wins: a competing terminal digest already reserved at the Settle slot HOLDS the game; no sweep ever signs around it", async () => {
    const h = harness();
    await played(h.world);
    const L = (h.world.logs.get(GAME_A) ?? []).length;
    const instance = escrowInstanceKey((await fin(h.world)).binding!.escrow!);
    const competing = { codec: "18JUNO/v1" as const, purpose: "settle" as const, hex: "cd".repeat(32) };
    assert.equal((await h.journal.reserveSettlement({ instance, seq: String(2 * L + 1), signer_key_id: 1, digest: competing })).kind, "reserved");
    assert.equal((await h.journal.reserveSettlement({ instance, seq: String(2 * L + 1), signer_key_id: 1, digest: competing })).kind, "same", "the same digest again is the same reservation");
    await seal(h.world);
    const record = await fin(h.world);
    assert.equal(record.phase, "held");
    assert.equal(record.hold?.code, "journal-ahead");
    const asked = h.kms.state.asked.length;
    await sweep(h.world);
    await sweep(h.world);
    assert.equal(h.kms.state.asked.length, asked, "a held game is never re-offered to the key");
    assert.equal((await settles(h.world)).length, 0);
    const reservations = await reservationsAt(h.world, h.journal, 2 * L + 1);
    assert.deepEqual(reservations.map((r) => r.digest_hex), [competing.hex], "the first writer still owns the slot");
  });

  test("checkpoint non-regression: a failed GameEnd-boundary checkpoint (retrySnapshot) and a failed Settle recover together on one sweep -- each slot signed once", async () => {
    const h = harness();
    await startedGame(h.world, GAME_A);
    const session = play(h.world, GAME_A, 0);
    await h.world.drive(async () => (await fin(h.world)).chain.checkpoint_confirmed !== null);
    h.kms.state.mode = "down";
    toStockRound(h.world, GAME_A, session); // the auction -> Stock Round boundary; its checkpoint job fails
    await h.world.service.idle();
    /* The game's last committed batch, on the board the sealed prefix replays to (GameEnd): the GameEnd boundary.
       Its checkpoint also fails (the key is down) and is kept for the sweep (`retrySnapshot`). */
    const answer = session.submit({ actor: ALICE, build: BUILD, msg: PASS as never, baseIndex: session.nextIndex - 1, submissionId: "jx5b-last" });
    assert.equal(answer.kind, "applied");
    const entries = Object.freeze(session.entries.map((entry) => Object.freeze({ ...entry })));
    h.world.logs.set(GAME_A, [...entries]);
    h.world.service.onGameplayCommitted({ gameId: GAME_A, entries, board: { ...(session.state as GameStateResponse), current_round_type: "GameEnd", bank_broken: true } as GameStateResponse });
    await h.world.service.idle();
    const L = await seal(h.world);
    assert.equal(L, entries.length);
    assert.equal((await fin(h.world)).phase, "intent-prepared");
    assert.equal((await checkpointsAt(h.world, L)).length, 0);
    const terminalReservation = await reservationsAt(h.world, h.journal, 2 * L);
    assert.equal(terminalReservation.length, 1, "the GameEnd boundary and the terminal checkpoint are ONE slot, one digest");
    h.kms.state.mode = "ok";
    await sweep(h.world);
    assert.equal((await settles(h.world)).length, 1, "the Settle recovered");
    assert.equal((await checkpointsAt(h.world, L)).length, 1, "the terminal checkpoint exists once (written by the checkpoint retry or the Settle job, never both)");
    assert.equal(h.kms.state.signed.filter((d) => d === terminalReservation[0].digest_hex).length, 1, "the 2L digest was signed exactly once");
    await h.world.drive(async () => (await fin(h.world)).phase === "settleable");
    await h.world.drive(async () => (await fin(h.world)).phase === "closed", 60);
    for (const intent of await intentsOf(h.world)) assert.ok(intent.status === "confirmed" || intent.status === "superseded", `${intent.op.kind} ${intent.status}`);
    assert.equal(h.intents.inner.queue.size, 0);
  });
});
