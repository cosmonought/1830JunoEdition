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
//   4. the gate: only the clock's current authority relays; after a restart a sealed (terminal) remedy is carried on
//      with NO system pause and NO player vote (owner, 2026-10-06), and an attestation that expired during the outage
//      is attested AGAIN for the same decision;
//   5. N-1 approvals: a seat's REMEDY-APPROVE verifies under its CURRENT consent key for exactly that overdue and
//      horizon; a horizon not beyond minute 30 (or a self-approval, or a wrong key) is refused; SEALED APPROVAL
//      FINALITY (owner ruling, 2026-10-07): a sealed decision's approvals are judged at its own final_at -- one valid
//      then lands after its horizon passed or its seat rotated, attested again with the same decision; one that ended
//      or was re-keyed at or before final_at is held unchanged (owner decision required) -- never converted, re-voted;
//   5b. the sealed decision is revalidated against its own evidence before anything is signed;
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
import { createRemedyPipeline, intentCarriesDecision, remedyTimes, secsUp, sealedRemedyProblem, type RemedyPort } from "./remedyPipeline";
import { foldEvidence, signatureDigest, type ClockEvidenceEvent } from "../rooms/clock/clockEvidence";
import { CLOCK_REMEDY_SWEEP_MS } from "../rooms/clock/clockController";
import type { ClockStore } from "../rooms/clock/clockStore";
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

const PREV_HEAD = "a1".repeat(32);
const LEDGER_FROM = "b2".repeat(32);

/** The decision sealed WITH its evidence, as the clock seals it: a window ending with the `remedy-sealed` event that
 *  names exactly this decision, folded to the sealed evidence hash. */
function withEvidence(r: ClockRemedy): ClockRemedy {
  const seal: ClockEvidenceEvent = {
    seq: 7,
    kind: "remedy-sealed",
    at: r.final_ms,
    f: {
      remedy: r.kind,
      seat: r.seat,
      strike: r.strike,
      epoch: r.epoch,
      log_len: r.log_len,
      log_hash: r.log_hash,
      allowance_secs: r.allowance_secs,
      overdue_ms: r.overdue_ms,
      final_ms: r.final_ms,
      approvals: r.approvals.map((a) => `${a.seat}:${a.approve_until}:${signatureDigest(a.signature)}`),
      replaces: r.replaces,
      ledger_head: LEDGER_FROM,
    },
  };
  return { ...r, evidence: { format: "18COSMOS/CLOCK-EVIDENCE/v1", game_id: GAME_A, prev_head: PREV_HEAD, events: [seal], truncated: false, ledger: { from: LEDGER_FROM, events: [] } }, evidence_hash: foldEvidence(PREV_HEAD, [seal]) };
}

/** The clock's sealed Live decision for the chain game (ALICE = seat 0 defaulting unless told). */
function sealed(world: World, chainGameId: string, kind: 1 | 2 | 3, over: Partial<ClockRemedy> = {}): ClockRemedy {
  return withEvidence(sealedFacts(world, chainGameId, kind, over));
}

function sealedFacts(world: World, chainGameId: string, kind: 1 | 2 | 3, over: Partial<ClockRemedy> = {}): ClockRemedy {
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
    evidence: { format: "18COSMOS/CLOCK-EVIDENCE/v1", game_id: GAME_A, prev_head: "00".repeat(32), events: [], truncated: false, ledger: { from: "00".repeat(32), events: [] } },
    evidence_hash: "ef".repeat(32),
    sealed_at: overdueMs + LIVE_CURE_MS,
    status: "sealed",
    detail: null,
    attestations: 0,
    replaces: null,
    stale: [],
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
    /* Valid AT minute 30 decides it (owner ruling, 2026-10-07): strictly beyond the final second, no relay margin. */
    const edge = Number(secsUp(finalNotBefore));
    assert.match((await check(BOB, edge, signed(1, edge))) ?? "", /must last beyond/);
    assert.equal(await check(BOB, edge + 1, signed(1, edge + 1)), null);
    const short = Number(secsUp(finalNotBefore)) + 30;
    assert.equal(await check(BOB, short, signed(1, short)), null, "half a minute past minute 30 is enough");
    const far = Number(secsUp(remedy.overdue_ms)) + 7 * 3600;
    assert.match((await check(BOB, far, signed(1, far))) ?? "", /six hours/);
    assert.match((await check(ALICE, until, signed(0, until))) ?? "", /cannot approve a remedy against itself/);
    assert.equal(await check(BOB, until, "zz"), "the approval is not a 64-byte signature");
  });

  test("SEALED APPROVAL FINALITY: a Live foreclosure whose approval was valid at final_at lands after its horizon passed; one whose approval ended AT final_at is held unchanged (owner decision required) -- never converted to the neutral annulment", async () => {
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
    /* Ended AT the final second: never valid at finality (the clock would not have sealed it; a race it could not see). */
    const lapsed = await port.attest(GAME_A, withEvidence({ ...base, approvals: [approval(finalSecs)] }));
    assert.equal(lapsed.status, "refused");
    assert.deepEqual(lapsed.unlandable, [BOB], "the seat whose approval was not valid at final_at");
    assert.match(lapsed.detail ?? "", /owner decision required/);
    assert.match(lapsed.detail ?? "", /not valid at its own final_at/);
    assert.equal("fallback" in lapsed, false, "no neutral fallback exists any more");
    assert.deepEqual(await remedyIntents(world), [], "nothing signed, nothing converted");
    /* Valid at final_at, its horizon already PAST at the attestation and block time: the same decision lands. */
    const valid = withEvidence({ ...base, approvals: [approval(finalSecs + 5)] });
    assert.ok(world.chain.time > finalSecs + 5);
    const good = await port.attest(GAME_A, valid);
    assert.deepEqual([good.status, good.attested], ["submitted", true], JSON.stringify(good));
    const [intent] = await remedyIntents(world);
    assert.equal(intent.op.kind === "remedy" ? intent.op.usable_until : null, intent.op.kind === "remedy" ? intent.op.expires_at : "?", "only the attestation's expiry bounds the intent");
    await world.drive(async () => (await port.progress(GAME_A, valid)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).remedy?.kind, "live_foreclose");
  });
});

describe("FP4 remedy pipeline: approvals are re-checked under the consent key each seat held AT final_at before anything is signed", () => {
  test("a key replaced at or before final_at: the sealed decision (Live or Async N-1) is held unchanged with the seat named; staleApprovals finds them in one read", async () => {
    const { world, chainGameId } = await liveWorld();
    const port = pipeline(world);
    const g = gameOf(world, chainGameId);
    const base = sealed(world, chainGameId, 2);
    const finalSecs = Number(remedyTimes(base).finalAt);
    const signedBy = (kind: number, secret: Buffer, until: number) =>
      signDigest(
        secret,
        Buffer.from(
          remedyApproveDigestV1(
            { domain: g.domain, chain_game_id: BigInt(chainGameId), remedy: kind as RemedyKindByte, defaulting_seat: 0, strike: base.strike, overdue_epoch: BigInt(1), log_len: BigInt(1), log_hash: base.log_hash, overdue_at: secsUp(base.overdue_ms) },
            BigInt(until),
            1,
          ),
          "hex",
        ),
      ).toString("hex");
    const until = finalSecs + 3_600;
    /* Signed under a key the chain no longer holds for BOB's seat (the seat rotated its consent key since). */
    const moved = { seat: BOB, approve_until: until, signature: signedBy(2, sha("an earlier consent key"), until) };
    advanceTo(world, finalSecs + 10);
    const live = await port.attest(GAME_A, withEvidence({ ...base, approvals: [moved] }));
    assert.deepEqual([live.status, live.unlandable], ["refused", [BOB]]);
    assert.deepEqual(await remedyIntents(world), [], "nothing was signed");
    /* The same check for an N-1 annulment (the pipeline's own branch; the decision's other facts as sealed). */
    const asyncMoved = { seat: BOB, approve_until: until, signature: signedBy(4, sha("an earlier consent key"), until) };
    const n1 = await port.attest(GAME_A, withEvidence({ ...base, kind: 4, strike: 0, approvals: [asyncMoved] }));
    assert.deepEqual([n1.status, n1.unlandable], ["refused", [BOB]], JSON.stringify(n1));
    assert.deepEqual(await remedyIntents(world), []);
    const facts = { remedy: 2 as const, defaultingSeat: ALICE, strike: base.strike, epoch: 1, logLen: 1, logHash: base.log_hash, overdueMs: base.overdue_ms };
    assert.deepEqual(await port.staleApprovals(GAME_A, facts, [{ seat: BOB, approveUntil: until, signature: moved.signature }]), [BOB]);
    assert.deepEqual(await port.staleApprovals(GAME_A, facts, [{ seat: BOB, approveUntil: until, signature: signedBy(2, seatSecret(1), until) }]), []);
  });

  test("SEALED APPROVAL FINALITY: a seat that rotates AFTER final_at revokes nothing (the same decision lands); one that rotated AT or before final_at voids its old approval (held); staleApprovals judges at the moment asked", async () => {
    const signedBy = (world: World, chainGameId: string, base: ClockRemedy, secret: Buffer, until: number) =>
      signDigest(
        secret,
        Buffer.from(
          remedyApproveDigestV1(
            { domain: gameOf(world, chainGameId).domain, chain_game_id: BigInt(chainGameId), remedy: 2, defaulting_seat: 0, strike: base.strike, overdue_epoch: BigInt(1), log_len: BigInt(1), log_hash: base.log_hash, overdue_at: secsUp(base.overdue_ms) },
            BigInt(until),
            1,
          ),
          "hex",
        ),
      ).toString("hex");
    const rotate = (world: World, chainGameId: string, label: string) => {
      const seats = (world.chain.games.get(Number(chainGameId)) as unknown as { seats: { wallet: string }[] }).seats;
      const done = world.chain.setConsentKey(chainGameId, seats[1].wallet, publicKeyOf(sha(label)).toString("hex"));
      assert.equal(done.ok, true, JSON.stringify(done));
    };
    /* AFTER final_at: BOB rotates a minute after minute 30; his approval, signed under the key he held then, lands. */
    {
      const { world, chainGameId } = await liveWorld();
      const port = pipeline(world);
      const base = sealed(world, chainGameId, 2);
      const finalSecs = Number(remedyTimes(base).finalAt);
      const until = finalSecs + 600;
      const approval = { seat: BOB, approve_until: until, signature: signedBy(world, chainGameId, base, seatSecret(1), until) };
      advanceTo(world, finalSecs + 60);
      rotate(world, chainGameId, "bob-after-final");
      const facts = { remedy: 2 as const, defaultingSeat: ALICE, strike: base.strike, epoch: 1, logLen: 1, logHash: base.log_hash, overdueMs: base.overdue_ms };
      const pair = [{ seat: BOB, approveUntil: until, signature: approval.signature }];
      assert.deepEqual(await port.staleApprovals(GAME_A, facts, pair), [BOB], "under the CURRENT key (a new vote): replaced");
      assert.deepEqual(await port.staleApprovals(GAME_A, facts, pair, { atSecs: finalSecs }), [], "at final_at: the key he held then");
      advanceTo(world, until + 3_600);
      const decision = withEvidence({ ...base, approvals: [approval] });
      const good = await port.attest(GAME_A, decision);
      assert.deepEqual([good.status, good.attested], ["submitted", true], JSON.stringify(good));
      await world.drive(async () => (await port.progress(GAME_A, decision)) === "confirmed");
      assert.equal(gameOf(world, chainGameId).remedy?.kind, "live_foreclose");
    }
    /* AT final_at (the same second): the old key's approval is void -- held, never converted. */
    {
      const { world, chainGameId } = await liveWorld();
      const port = pipeline(world);
      const base = sealed(world, chainGameId, 2);
      const finalSecs = Number(remedyTimes(base).finalAt);
      const until = finalSecs + 600;
      const approval = { seat: BOB, approve_until: until, signature: signedBy(world, chainGameId, base, seatSecret(1), until) };
      advanceTo(world, finalSecs);
      rotate(world, chainGameId, "bob-at-final");
      const facts = { remedy: 2 as const, defaultingSeat: ALICE, strike: base.strike, epoch: 1, logLen: 1, logHash: base.log_hash, overdueMs: base.overdue_ms };
      const pair = [{ seat: BOB, approveUntil: until, signature: approval.signature }];
      /* No block past the final second yet: the chain's answer is not final -- no answer (never a guess). */
      assert.equal(await port.staleApprovals(GAME_A, facts, pair, { atSecs: finalSecs, timeoutMs: 1_500 }), null);
      advanceTo(world, finalSecs + 1);
      /* A node that does not say which height it read at is no answer about the state after the final second (a lagging
         node could miss a rotation stamped at or before it): unread, never a guess. */
      world.chain.heightsHidden = true;
      assert.equal(await port.staleApprovals(GAME_A, facts, pair, { atSecs: finalSecs, timeoutMs: 1_500 }), null);
      world.chain.heightsHidden = false;
      assert.deepEqual(await port.staleApprovals(GAME_A, facts, pair, { atSecs: finalSecs }), [BOB]);
      advanceTo(world, finalSecs + 10);
      const held = await port.attest(GAME_A, withEvidence({ ...base, approvals: [approval] }));
      assert.deepEqual([held.status, held.unlandable], ["refused", [BOB]], JSON.stringify(held));
      assert.deepEqual(await remedyIntents(world), [], "nothing was signed");
    }
  });
});

describe("FP4 remedy pipeline: the SEALED decision is revalidated against its own evidence before anything is signed", () => {
  test("tampered evidence, a field its seal does not name, or another game's evidence: refused (fail closed), nothing written; an intent carrying another evidence hash is not this decision", async () => {
    const { world, chainGameId } = await liveWorld();
    const port = pipeline(world);
    const good = sealed(world, chainGameId, 1);
    assert.equal(sealedRemedyProblem(GAME_A, good), null);
    const cases: Array<[string, ClockRemedy, RegExp]> = [
      ["another evidence hash", { ...good, evidence_hash: "cd".repeat(32) }, /does not fold to the sealed evidence hash/],
      ["a stalled position the seal does not name", { ...good, log_len: 2 }, /does not name this decision/],
      ["a later final moment", { ...good, final_ms: good.final_ms + 60_000 }, /does not name this decision/],
      ["another defaulting seat", { ...good, seat: BOB }, /does not name this decision/],
      ["an added approval", { ...good, approvals: [{ seat: BOB, approve_until: 9_999_999_999, signature: "11".repeat(64) }] }, /does not name this decision/],
      ["no seal at the end", { ...good, evidence: { ...good.evidence, events: [] }, evidence_hash: PREV_HEAD }, /does not end with its seal/],
      ["another game's evidence", { ...good, evidence: { ...good.evidence, game_id: "g_other" } }, /names another game/],
      ["a ledger the seal does not sign", { ...good, evidence: { ...good.evidence, ledger: { from: "c3".repeat(32), events: [] } } }, /strike ledger does not match/],
    ];
    for (const [name, remedy, why] of cases) {
      const attempt = await port.attest(GAME_A, remedy);
      assert.equal(attempt.status, "refused", name);
      assert.match(attempt.detail ?? "", why, name);
      assert.match(attempt.detail ?? "", /nothing is attested \(fail closed\)/, name);
    }
    assert.deepEqual(await remedyIntents(world), [], "nothing was ever signed");
    const first = await port.attest(GAME_A, good);
    assert.deepEqual([first.status, first.attested], ["submitted", true]);
    const [intent] = await remedyIntents(world);
    assert.equal(intentCarriesDecision(intent, good), true);
    const other = withEvidence({ ...good, log_hash: "cd".repeat(32) });
    assert.equal(intentCarriesDecision(intent, { ...other, log_hash: good.log_hash }), false, "the same instance with another evidence hash is another decision");
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
  const store: ClockStore = createMemoryClockStore();
  let serves = true;
  const make = (authority: string) => createClockController({
    store,
    authority,
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
    /* A process that no longer serves the game (another took it over) runs no task for it -- the pool's own fence. */
    runOn: (_g, _l, task) => (serves ? serial(() => task(game, tx)).then(() => true) : Promise.resolve(false)),
    onChange: () => undefined,
    serving: () => serves,
    closeOffer: async () => ({ ok: false, why: "no offers here" }),
    remedy: () => port,
    moneyStartedAtSecs: async () => gameOf(world, chainGameId).started_at,
  });
  let clock = make("auth-1");
  /* As `clockWiring.ts` wires it: the escrow's changes reach the CURRENT clock (a remedy intent's end included). */
  world.service.onChange((gameId) => clock.moneyChanged(gameId));
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    get clock() {
      return clock;
    },
    /** The server / AWS restart: this process and its timers are gone; a NEW authority serves the same store, the same
     *  game log and the same chain. */
    restart(authority: string) {
      clock.close();
      pending.clear();
      clock = make(authority);
    },
    /** Whether this process serves the game (a stale actor, taken over, does not). */
    serving(flag: boolean) {
      serves = flag;
    },
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

  test("the gate: only the clock's CURRENT authority relays; after a takeover the SAME sealed remedy is carried on with NO system pause and NO player vote", async () => {
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
    table.serving(false);
    const verdict = await table.clock.remedyGate(GAME_A, intents[0]);
    assert.equal(verdict.kind, "wait");
    assert.match((verdict as { why: string }).why, /not the table clock's current authority/);
    const relayer = (await import("./escrow3bSupport")).RELAYER_ADDRESS;
    const sequence = (world.chain.accounts.get(relayer) as { sequence: bigint }).sequence;
    for (let round = 0; round < 3; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
    }
    assert.equal((world.chain.accounts.get(relayer) as { sequence: bigint }).sequence, sequence, "nothing relayed on another authority's word (a stale actor cannot carry or alter it)");
    assert.equal(table.store.load !== undefined && (await table.store.load(GAME_A))?.authority, "auth-other", "the stale actor wrote nothing");
    /* This process serves the table again and adopts it (a load: a continuity break). The game has ENDED and its remedy
       is sealed: there is no gameplay to resume, so there is NO system pause and no vote -- the same decision is carried
       on. */
    table.serving(true);
    await table.serial(() => table.clock.op(table.game, table.tx, { type: "clock-ack", seat: ALICE }).then(() => undefined));
    const adopted = table.record()!;
    assert.equal(adopted.system, null, "no SYSTEM PAUSE after a terminal seal");
    assert.equal(adopted.authority, "auth-1");
    assert.deepEqual(adopted.remedy?.evidence_hash, remedy.evidence_hash, "the same sealed decision");
    assert.equal((await table.clock.remedyGate(GAME_A, intents[0])).kind, "ok", "relayed without any player's resume");
    const resume = await table.serial(() => table.clock.op(table.game, table.tx, { type: "clock-sysresume", seat: ALICE, since: null }));
    assert.equal(resume.ok, false, "there is nothing to vote on");
    await world.drive(async () => (await table.port.progress(GAME_A, remedy)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).state, "annulled");
  });

  test("POST-TERMINAL OUTAGE: the attestation expires during an AWS/server outage; after the restart the SAME decision is attested AGAIN automatically (no vote, no change) and lands", async () => {
    let gate: NonNullable<WorldOptions["remedyGate"]> = async () => ({ kind: "wait", why: "not bound yet" });
    const { world, chainGameId } = await liveWorld({ remedyGate: (g, i) => gate(g, i) });
    const table = moneyTable(world, chainGameId);
    gate = (g, i) => table.clock.remedyGate(g, i);
    await table.deal();
    const started = gameOf(world, chainGameId).started_at;
    await table.advance(started * 1000 + LIVE_ACTION_MS + LIVE_CURE_MS - world.clock.now);
    const sealedRecord = table.record()!;
    const remedy = sealedRecord.remedy!;
    assert.deepEqual([sealedRecord.phase, remedy.kind, remedy.attestations], ["ended", 1, 1]);
    const [first] = await remedyIntents(world);
    /* The outage: nothing runs for two hours (the attestation's one-hour bearer life passes, unrelayed). */
    advanceTo(world, world.chain.time + 2 * 3_600);
    /* The restart: a new authority, the same store, log and chain. NOBODY opens the table: the relayer finds the
       expired attestation, the escrow tells the clock, and the clock loads the table and carries the remedy on. */
    table.restart("auth-2");
    table.clock.startSweep();
    for (let round = 0; round < 24 && (await table.port.progress(GAME_A, remedy)) !== "confirmed"; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
      await world.service.idle();
      await table.advance(CLOCK_REMEDY_SWEEP_MS);
    }
    assert.equal(await table.port.progress(GAME_A, remedy), "confirmed");
    const adopted = table.record()!;
    assert.deepEqual([adopted.authority, adopted.system, adopted.phase], ["auth-2", null, "ended"], "no system pause, nothing to resume, no player asked");
    const all = await remedyIntents(world);
    assert.equal(all.length, 2, "the expired attestation, and ONE re-attestation");
    const second = all.find((intent) => intent.intent_id !== first.intent_id)!;
    const op = (intent: typeof first) => intent.op as { decision: string; expires_at: string; remedy: number; final_at: string };
    assert.equal(op(second).decision, op(first).decision, "the SAME decision digest (the evidence hash included)");
    assert.equal(op(second).remedy, 1, "never converted");
    assert.equal(op(second).final_at, op(first).final_at);
    assert.ok(BigInt(op(second).expires_at) > BigInt(op(first).expires_at), "only the attestation's time-dependent part is new");
    assert.equal(intentCarriesDecision(second, remedy), true);
    const after = table.record()!;
    assert.deepEqual([after.remedy?.kind, after.remedy?.evidence_hash, after.remedy?.final_ms, after.remedy?.attestations, after.ended?.kind], [1, remedy.evidence_hash, remedy.final_ms, 2, "live-timeout-annul"]);
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
