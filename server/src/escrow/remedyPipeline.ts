// server/src/escrow/remedyPipeline.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS (FP4): CLOCK DECISION -> SEALED EVIDENCE -> DEDICATED SIGNATURE -> FP4 INTENT -> CHAIN
// ==================================================================
//
// The clock (`rooms/clock/`) decides a remedy INSIDE the game's serialization and seals it -- kind, defaulting seat,
// strike, overdue epoch, the stalled log position and its hash, the allowance, the overdue and final moments, the N-1
// approvals and the clock-evidence hash -- in its DURABLE record (written before anything here runs). This module turns a
// sealed decision into escrow 2.1.0's `SubmitRemedy`, and refuses (FAIL CLOSED) unless every precondition holds:
//
//   1. a DEDICATED REMEDY signer is configured (`remedySigner.ts`; the settlement signer never substitutes);
//   2. the escrow is verified and the game bound, served by this pool and not held (`EscrowService.remedyContext`);
//   3. the chain is read by QUORUM -- the game, the REMEDY key registry entry (registered, active, this server's key)
//      and the latest block time (`attested_at` is never later than the quorum's earliest head; FP4's fence waits on it);
//   4. the decision still applies on chain: IN_PROGRESS under `timed_remedy_v1` with the funded allowance, no remedy
//      accepted yet, and the trusted sequence not past the stalled position (a checkpoint past it means play went on);
//   5. the attestation is built ONLY from the sealed decision (no wall clock: `overdue_at` / `final_at` are the sealed
//      moments in whole seconds, rounded up; `attested_at` is the quorum block time, never earlier than `final_at`;
//      `expires_at` one hour later), signed, verified again (`remedyChainIntent`), and written as ONE durable FP4 intent
//      behind the per-game fence (`prepareRemedyIntent`: one open remedy intent per game, idempotent, restart-safe).
//
//   0. before any of it, the SEALED decision itself is revalidated (`sealedRemedyProblem`): its evidence document folds
//      to the sealed `evidence_hash`, ends with the `remedy-sealed` event that names exactly this decision (kind, seat,
//      strike, epoch, stalled position and hash, allowance, overdue and final moments, approvals) and the strike
//      ledger's head; an FP4 intent counts as this decision's only if it carries that same evidence hash.
//
// The relayer then submits it, but only on the clock lane's word (`EscrowServiceDeps.remedyGate`, the controller's
// `remedyGate`): only for an ENDED game's sealed decision, never from an authority that is not the clock's current one,
// never while a unanimous annulment of the game is open. A sealed remedy is never gated by a player vote (the owner's
// ruling, policy correction 2026-10-06: a system pause protects only a game that is still playable). An attestation that
// expired before it landed is attested AGAIN for the same decision (`attestations` counts them) -- the protocol's own
// recovery (a fresh `attested_at`, the same decision digest, the same `final_at`). Owner ruling (2026-10-07): the N-1
// vote decided the outcome at finality, so escrow 2.1.0 judges every seat approval AT THE ATTESTED `final_at` -- its
// horizon after `final_at`, its signature under the key the seat held then (the contract's own `consent_key_at`
// query, read by quorum once the chain has a block past `final_at`) -- never at the block time it lands: a later horizon, a later key rotation, an outage or a late relay revoke
// nothing. Before the seal, a lapsed approval or a moved key still voids a YES (the vote-time checks; Live: once more at
// finality, `staleApprovals` at the final moment). A sealed N-1 decision whose approvals were NOT valid at its own
// `final_at` (a race the pre-seal checks could not see) is NEVER converted into another outcome and never put to a new
// vote: it stays sealed and held (`unlandable`), and needs an owner decision.
// NO payout is computed here or in any browser: the contract's `foreclosure_split` decides every amount.

import {
  LIVE_CURE_WINDOW_SECS,
  MAX_REMEDY_TTL_SECS,
  remedyApproveDigestV1,
  type RemedyAttestationV1,
  type RemedyKindByte,
} from "../../../frontend/src/gameEngine/escrow/junoRemedyV1";
import type { ClockRemedy, RemedyKind, RemedyStatus } from "../rooms/clock/clockRecord";
import { evidenceHashOf, ledgerHeadOf, signatureDigest } from "../rooms/clock/clockEvidence";
import { isLiveAttempt, type ChainIntentRecord } from "./chainIntents";
import type { EscrowService, RemedyChainContext } from "./escrowService";
import { remedyChainIntent, RemedyIntentError } from "./juno/remedyIntents";
import type { RemedySigner } from "./juno/remedySigner";
import { verifyDigest } from "./juno/secp256k1";

/** The outcome of one attempt to carry a sealed remedy to the chain. */
export interface RemedyAttempt {
  readonly status: RemedyStatus;
  readonly detail: string | null;
  /** A new attestation was signed and its intent written. */
  readonly attested: boolean;
  /** An N-1 remedy (2, 4, 5): the seats whose approvals were not valid at the decision's own `final_at` (a horizon at
   *  or before it, or the seat's consent key replaced at or before it). The sealed decision is held as it is
   *  (`remedyBlocked`): owner decision required. */
  readonly unlandable?: readonly string[];
}

/** What the clock asks of the money side. */
export interface RemedyPort {
  /** Whether remedies can be attested at all here (a configured REMEDY signer). */
  readonly configured: boolean;
  /** Carry the sealed remedy toward the chain (attest + FP4 intent), or say why not now / not ever. */
  attest(gameId: string, remedy: ClockRemedy): Promise<RemedyAttempt>;
  /** Where the sealed remedy stands on chain, from its FP4 intents (`open`: one is pending / in flight). */
  progress(gameId: string, remedy: ClockRemedy): Promise<"none" | "open" | "confirmed" | "dead">;
  /** A seat's REMEDY-APPROVE for an overdue instance: `null` when it verifies under the seat's CURRENT consent key (a
   *  quorum chain read) and its horizon is acceptable, else why not. */
  verifyApproval(gameId: string, input: ApprovalCheck): Promise<string | null>;
  /** The seats among `approvals` whose REMEDY-APPROVE does not verify under the consent key their seat holds (one quorum
   *  read; `null`: the chain could not be read in time). `atSecs`: judge under the key each seat held at that moment
   *  (Live finality: the attested final second -- a rotation after it moves nothing); absent: the CURRENT key. */
  staleApprovals(gameId: string, facts: ApprovalFacts, approvals: readonly { readonly seat: string; readonly approveUntil: number; readonly signature: string }[], options?: { readonly atSecs?: number; readonly timeoutMs?: number }): Promise<readonly string[] | null>;
  /** The chain seat of each player (the frozen roster), for the clock's money view. */
  chainSeats(gameId: string): Promise<Readonly<Record<string, number>> | null>;
  /** Post a fencing checkpoint (a cure ended an overdue instance). */
  fence(gameId: string): void;
  /** Whether a unanimous annulment intent is open for the game. */
  annulOpen(gameId: string): Promise<boolean>;
  /** The chain's Start time (seconds) of a bound money game, read by quorum within `timeoutMs` (`null`: unknown now). */
  startedAtSecs(gameId: string, timeoutMs?: number): Promise<number | null>;
}

/** The overdue instance (and remedy kind) an approval binds to. */
export type ApprovalFacts = Pick<ApprovalCheck, "remedy" | "defaultingSeat" | "strike" | "epoch" | "logLen" | "logHash" | "overdueMs">;

export interface ApprovalCheck {
  readonly remedy: RemedyKind;
  readonly defaultingSeat: string;
  readonly approvingSeat: string;
  readonly strike: number;
  readonly epoch: number;
  readonly logLen: number;
  readonly logHash: string;
  readonly overdueMs: number;
  /** Seconds. */
  readonly approveUntil: number;
  readonly signature: string;
  /** Live: the earliest the remedy can be final (ms) -- an approval must outlive it. */
  readonly finalNotBeforeMs: number;
  readonly nowMs: number;
}

/** Live approvals must outlive minute 30 as it stands (strictly beyond the attested final second: an approval valid at
 *  finality decides it -- owner ruling, 2026-10-07; no relay margin is needed, the contract judges it at `final_at`)
 *  and may not reach further than `LIVE_APPROVAL_MAX_SECS`. */
export const LIVE_APPROVAL_MAX_SECS = 6 * 60 * 60;
/** Async approvals: at least an hour of life, at most 30 days. */
export const ASYNC_APPROVAL_MIN_SECS = 60 * 60;
export const ASYNC_APPROVAL_MAX_SECS = 30 * 24 * 60 * 60;

/** Whole seconds, rounded UP (an attested moment is never earlier than the fact). Integer arithmetic only. */
export const secsUp = (ms: number): bigint => (BigInt(ms) + BigInt(999)) / BigInt(1000);

/** The attestation's time fields from the sealed decision (no wall clock). */
export function remedyTimes(remedy: Pick<ClockRemedy, "kind" | "overdue_ms" | "final_ms">): { readonly overdueAt: bigint; readonly finalAt: bigint } {
  const overdueAt = secsUp(remedy.overdue_ms);
  const raw = secsUp(remedy.final_ms);
  if (remedy.kind === 3) return { overdueAt, finalAt: overdueAt };
  if (remedy.kind === 1 || remedy.kind === 2) {
    const floor = overdueAt + BigInt(LIVE_CURE_WINDOW_SECS);
    return { overdueAt, finalAt: raw > floor ? raw : floor };
  }
  return { overdueAt, finalAt: raw > overdueAt ? raw : overdueAt };
}

export interface RemedyPipelineDeps {
  readonly service: Pick<EscrowService, "remedyContext" | "prepareRemedy" | "intentsOf" | "fenceCheckpoint" | "annulOpen">;
  /** `null`: no remedy key configured -- every remedy is refused (fail closed). */
  readonly signer: RemedySigner | null;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly audit?: (event: string, fields: Record<string, unknown>) => void;
}

/** Whether an FP4 intent is an attestation of THIS sealed decision: the same remedy, overdue instance and final moment,
 *  and the same sealed evidence hash (read from the signed message it carries). */
export function intentCarriesDecision(intent: ChainIntentRecord, remedy: ClockRemedy): boolean {
  if (intent.op.kind !== "remedy" || intent.op.remedy !== remedy.kind || intent.op.overdue_epoch !== String(remedy.epoch) || intent.op.log_len !== String(remedy.log_len) || intent.op.strike !== remedy.strike) return false;
  if (intent.op.final_at !== remedyTimes(remedy).finalAt.toString()) return false;
  try {
    const msg = JSON.parse(intent.msg_json) as { submit_remedy?: { attestation?: { evidence_hash?: unknown } } };
    return msg.submit_remedy?.attestation?.evidence_hash === remedy.evidence_hash;
  } catch {
    return false;
  }
}
const matches = intentCarriesDecision;

/** Whether a sealed remedy is exactly what its evidence proves (`null`), or why not. Pure; no chain read. The document
 *  must fold to the sealed `evidence_hash`, end with the `remedy-sealed` event naming this decision field by field, and
 *  carry the strike ledger whose head that event signs. A record that fails this is never attested (fail closed). */
export function sealedRemedyProblem(gameId: string, remedy: ClockRemedy): string | null {
  const doc = remedy.evidence;
  if (doc.game_id !== gameId) return "the sealed evidence names another game";
  let head: string;
  let ledgerHead: string;
  try {
    head = evidenceHashOf(doc);
    ledgerHead = ledgerHeadOf(doc);
  } catch {
    return "the sealed evidence cannot be folded";
  }
  if (head !== remedy.evidence_hash) return "the sealed evidence does not fold to the sealed evidence hash";
  const last = doc.events[doc.events.length - 1];
  if (last === undefined || last.kind !== "remedy-sealed") return "the sealed evidence does not end with its seal";
  const f = last.f as Record<string, unknown>;
  const approvals = remedy.approvals.map((a) => `${a.seat}:${a.approve_until}:${signatureDigest(a.signature)}`);
  const named = Array.isArray(f.approvals) ? (f.approvals as unknown[]) : null;
  if (
    f.remedy !== remedy.kind ||
    f.seat !== remedy.seat ||
    f.strike !== remedy.strike ||
    f.epoch !== remedy.epoch ||
    f.log_len !== remedy.log_len ||
    f.log_hash !== remedy.log_hash ||
    f.allowance_secs !== remedy.allowance_secs ||
    f.overdue_ms !== remedy.overdue_ms ||
    f.final_ms !== remedy.final_ms ||
    last.at !== remedy.final_ms ||
    named === null ||
    named.length !== approvals.length ||
    !named.every((value, i) => value === approvals[i])
  ) {
    return "the sealed evidence's seal does not name this decision";
  }
  if (f.ledger_head !== ledgerHead) return "the sealed evidence's strike ledger does not match its seal";
  return null;
}

function progressOf(intents: readonly ChainIntentRecord[]): "none" | "open" | "confirmed" | "dead" {
  if (intents.some((intent) => intent.status === "confirmed")) return "confirmed";
  if (intents.some((intent) => intent.status === "pending" || intent.status === "in-flight" || (intent.status === "held" && intent.attempts.some(isLiveAttempt)))) return "open";
  return intents.length === 0 ? "none" : "dead";
}

/** The consent key chain seat `approving` holds now (`atSecs` null) or held at `atSecs` -- the chain's own answer
 *  (`consent_key_at`), read into the context for exactly that second; anything else names no key (fail closed). */
function seatKeyAt(ctx: RemedyChainContext, approving: number, atSecs: bigint | null): string | undefined {
  if (atSecs === null) return ctx.consentPubkeys[approving];
  if (ctx.consentKeysAt === null || ctx.consentKeysAt.atSecs !== atSecs) return undefined;
  return ctx.consentKeysAt.keys[approving];
}

/** The chain's answer for a past second is final only once a block LATER than that second exists: block times only
 *  increase, so no rotation still to come can be stamped at or before it (CometBFT's block time trails real time). */
const POLL_MS = 1_000;

/** Whether a seat's REMEDY-APPROVE verifies under the key its chain seat holds now (`atSecs` null) or held at `atSecs`. */
function approvalVerifies(ctx: RemedyChainContext, remedy: Pick<ClockRemedy, "kind" | "strike" | "epoch" | "log_len" | "log_hash" | "overdue_ms">, defaulting: number, approving: number, approveUntil: number, signature: string, atSecs: bigint | null): boolean {
  const key = seatKeyAt(ctx, approving, atSecs);
  if (typeof key !== "string" || !/^0[23][0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/.test(signature)) return false;
  try {
    const digest = remedyApproveDigestV1(
      {
        domain: ctx.domain,
        chain_game_id: BigInt(ctx.chainGameId),
        remedy: remedy.kind as RemedyKindByte,
        defaulting_seat: defaulting,
        strike: remedy.strike,
        overdue_epoch: BigInt(remedy.epoch),
        log_len: BigInt(remedy.log_len),
        log_hash: remedy.log_hash,
        overdue_at: secsUp(remedy.overdue_ms),
      },
      BigInt(approveUntil),
      approving,
    );
    return verifyDigest(Buffer.from(key, "hex"), Buffer.from(digest, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

export function createRemedyPipeline(deps: RemedyPipelineDeps): RemedyPort {
  const audit = (event: string, fields: Record<string, unknown>) => deps.audit?.(event, fields);

  /** The bound game read by quorum; `withKey`: also this server's REMEDY key registry entry (an attestation needs it;
   *  an approval check does not -- it is skipped to keep a vote's chain reads few). */
  async function context(gameId: string, withKey = true, keysAtSecs: bigint | null = null): Promise<RemedyChainContext | { readonly refused: string }> {
    const ctx = await deps.service.remedyContext(gameId, withKey ? (deps.signer?.remedyKeyId ?? null) : null, keysAtSecs);
    if ("ok" in ctx && ctx.ok === false) return { refused: `${ctx.code}: ${ctx.detail}` };
    return ctx as RemedyChainContext;
  }

  /** The seats' keys AT `atSecs`, read only once the chain has a block later than that second (at most `attempts`
   *  probes, `POLL_MS` apart, while `live()`): a read whose game state starts after such a block was seen. `null`:
   *  unreadable, or not yet final when the attempts ran out. */
  async function conclusiveContext(gameId: string, atSecs: bigint, attempts: number, live: () => boolean): Promise<RemedyChainContext | null> {
    for (let attempt = 0; attempt < attempts && live(); attempt += 1) {
      const probe = await context(gameId, false);
      if ("refused" in probe) return null;
      if (BigInt(probe.blockTimeSecs) > atSecs) {
        const read = await context(gameId, false, atSecs);
        return "refused" in read ? null : read;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return null;
  }

  return {
    configured: deps.signer !== null,

    async attest(gameId, remedy) {
      const signer = deps.signer;
      if (signer === null) return { status: "refused", detail: "no dedicated REMEDY key is configured on this server: no remedy is attested (fail closed)", attested: false };
      /* The sealed decision is revalidated first, every time (a restart, a takeover, a retry): exactly what its evidence
         proves, or nothing is carried on. */
      const sealedProblem = sealedRemedyProblem(gameId, remedy);
      if (sealedProblem !== null) return { status: "refused", detail: `${sealedProblem}: nothing is attested (fail closed)`, attested: false };
      /* What the FP4 intents already say comes first: a confirmed or in-flight attestation needs no new chain read. */
      const intents = (await deps.service.intentsOf(gameId)).filter((intent) => matches(intent, remedy));
      const progress = progressOf(intents);
      if (progress === "confirmed") return { status: "confirmed", detail: null, attested: false };
      if (progress === "open") return { status: "submitted", detail: null, attested: false };
      /* An N-1 decision's approvals are judged under the keys the seats held at its final second (the chain's answer). */
      const judgedAt = remedy.approvals.length > 0 ? remedyTimes(remedy).finalAt : null;
      const found = await context(gameId, true, judgedAt);
      if ("refused" in found) return { status: remedy.status === "submitted" ? "submitted" : "refused", detail: found.refused, attested: false };
      const ctx = found;
      if (judgedAt !== null && BigInt(ctx.blockTimeSecs) <= judgedAt) {
        /* No block past the final second yet: the keys held then are not final on chain. Carried on at the next attempt. */
        return { status: remedy.status === "submitted" ? "submitted" : "sealed", detail: `waiting for a block past the decision's final second ${judgedAt} (the chain is at ${ctx.blockTimeSecs})`, attested: false };
      }
      if (ctx.remedyKey === null || !ctx.remedyKey.active || ctx.remedyKey.pubkey !== signer.publicKeyHex) {
        return { status: "refused", detail: `the chain's REMEDY key ${signer.remedyKeyId} is not this server's active key: nothing is attested`, attested: false };
      }
      if (ctx.remedy !== null) {
        /* A remedy is on chain: ours (one of this decision's attestations, by its digest) or another's. */
        const chainDigest = ctx.remedy.remedyDigest;
        const ours = intents.some((intent) => intent.op.kind === "remedy" && intent.op.remedy_digest === chainDigest);
        return ours ? { status: "confirmed", detail: null, attested: false } : { status: "superseded", detail: `another remedy (${ctx.remedy.kind}) is on chain`, attested: false };
      }
      if (ctx.state !== "IN_PROGRESS") return { status: "superseded", detail: `the escrow is ${ctx.state}: the game ended another way`, attested: false };
      if (ctx.policy !== "timed_remedy_v1") return { status: "refused", detail: `the escrow's exit policy is ${String(ctx.policy)}, which has no timed remedies`, attested: false };
      if (ctx.allowanceSecs !== remedy.allowance_secs) return { status: "refused", detail: `the escrow was funded with a ${ctx.allowanceSecs} s allowance; the clock's is ${remedy.allowance_secs} s`, attested: false };
      if (ctx.trustedSeq >= BigInt(remedy.log_len) * BigInt(2) + BigInt(1)) return { status: "superseded", detail: "a checkpoint past the stalled position is trusted on chain (play went on)", attested: false };
      const defaulting = ctx.seatOf[remedy.seat];
      if (defaulting === undefined) return { status: "refused", detail: "the defaulting player is not in the frozen roster", attested: false };
      const { overdueAt, finalAt } = remedyTimes(remedy);
      const floor = ctx.startedAtSecs + BigInt(remedy.allowance_secs);
      if (overdueAt < floor) return { status: "refused", detail: `the clock's overdue (${overdueAt}) precedes the chain's first allowance after Start (${floor}): never attested`, attested: false };
      const block = BigInt(ctx.blockTimeSecs);
      const attestedAt = block > finalAt ? block : finalAt;
      const expiresAt = attestedAt + BigInt(MAX_REMEDY_TTL_SECS);
      const approvals: Array<{ seat_index: number; approve_until: bigint; signature: string }> = [];
      const invalid: string[] = [];
      for (const approval of remedy.approvals) {
        const seat = ctx.seatOf[approval.seat];
        if (seat === undefined) return { status: "refused", detail: `an approving player (${approval.seat}) is not in the frozen roster`, attested: false };
        /* Checked HERE, before anything is signed, exactly as escrow 2.1.0 judges it: AT THE DECISION'S OWN final_at (owner
           ruling, 2026-10-07) -- its horizon after final_at, its signature under the key the seat held then. A horizon
           that passed since, or a key the seat replaced after final_at, changes nothing; the attestation time and the
           block time play no part. */
        if (BigInt(approval.approve_until) <= finalAt || !approvalVerifies(ctx, remedy, defaulting, seat, approval.approve_until, approval.signature, finalAt)) invalid.push(approval.seat);
        approvals.push({ seat_index: seat, approve_until: BigInt(approval.approve_until), signature: approval.signature });
      }
      if (invalid.length > 0) {
        /* An approval that was not valid at the decision's own final_at can never land (the contract judges it there),
           and the sealed decision is never converted or re-voted: it is held as it is -- owner decision required. */
        return {
          status: "refused",
          detail: "owner decision required: the sealed decision's seat approvals were not valid at its own final_at on escrow 2.1.0 (a horizon at or before it, or a consent key replaced at or before it); it is held unchanged -- never converted, never re-voted",
          attested: false,
          unlandable: [...invalid].sort(),
        };
      }
      const attestation: RemedyAttestationV1 = {
        version: 1,
        domain: ctx.domain,
        chain_game_id: BigInt(ctx.chainGameId),
        remedy: remedy.kind as RemedyKindByte,
        defaulting_seat: defaulting,
        strike: remedy.strike,
        overdue_epoch: BigInt(remedy.epoch),
        log_len: BigInt(remedy.log_len),
        log_hash: remedy.log_hash,
        allowance_secs: BigInt(remedy.allowance_secs),
        overdue_at: overdueAt,
        final_at: finalAt,
        attested_at: attestedAt,
        expires_at: expiresAt,
        evidence_hash: remedy.evidence_hash,
        remedy_key_id: signer.remedyKeyId,
      };
      let candidate: ChainIntentRecord;
      try {
        const signed = await signer.sign(attestation);
        candidate = remedyChainIntent({
          game_id: gameId,
          instance: ctx.instance,
          attestation,
          signature: signed.signature_hex,
          remedy_pubkey: signer.publicKeyHex,
          consent_pubkeys: ctx.consentPubkeys,
          ...(ctx.consentKeysAt !== null ? { approval_keys: ctx.consentKeysAt.keys } : {}),
          started_at: ctx.startedAtSecs,
          approvals,
          now: deps.now(),
        });
      } catch (error) {
        const why = error instanceof RemedyIntentError ? error.message : `the remedy could not be signed (${error instanceof Error ? error.message : String(error)})`;
        return { status: "refused", detail: why.slice(0, 400), attested: false };
      }
      const outcome = await deps.service.prepareRemedy(gameId, candidate, ctx.blockTimeSecs);
      if (outcome.kind === "created" || outcome.kind === "exists") {
        audit("clock.remedy-intent", { game_id: gameId, remedy: remedy.kind, epoch: remedy.epoch, strike: remedy.strike, log_len: remedy.log_len, attested_at: attestedAt.toString(), intent_id: outcome.record.intent_id, created: outcome.kind === "created" });
        return { status: "submitted", detail: null, attested: outcome.kind === "created" };
      }
      return { status: remedy.status === "submitted" ? "submitted" : "sealed", detail: outcome.kind === "hold" ? outcome.why : outcome.detail, attested: false };
    },

    async progress(gameId, remedy) {
      return progressOf((await deps.service.intentsOf(gameId)).filter((intent) => matches(intent, remedy)));
    },

    async verifyApproval(gameId, input) {
      if (!/^[0-9a-f]{128}$/.test(input.signature)) return "the approval is not a 64-byte signature";
      if (!Number.isSafeInteger(input.approveUntil) || input.approveUntil <= 0) return "the approval's horizon is not a time";
      const nowSecs = Math.floor(input.nowMs / 1000);
      const live = input.remedy <= 3;
      if (live) {
        /* The clock's own rule (`clockModel.ts` finality): strictly beyond the attested final second. */
        const finalSecs = Math.max(Number(secsUp(input.finalNotBeforeMs)), Number(secsUp(input.overdueMs)) + LIVE_CURE_WINDOW_SECS);
        if (input.approveUntil <= finalSecs) return `a Live approval must last beyond ${finalSecs} (minute 30 as it stands)`;
        if (input.approveUntil > Number(secsUp(input.overdueMs)) + LIVE_APPROVAL_MAX_SECS) return "a Live approval may not reach more than six hours past the overdue";
      } else {
        if (input.approveUntil < nowSecs + ASYNC_APPROVAL_MIN_SECS) return "an Async approval must last at least an hour";
        if (input.approveUntil > nowSecs + ASYNC_APPROVAL_MAX_SECS) return "an Async approval may not reach more than 30 days ahead";
      }
      const found = await context(gameId, false);
      if ("refused" in found) return `the escrow cannot be read now (${found.refused})`;
      const ctx = found;
      const defaulting = ctx.seatOf[input.defaultingSeat];
      const approving = ctx.seatOf[input.approvingSeat];
      if (defaulting === undefined || approving === undefined) return "a player is not in the frozen roster";
      if (approving === defaulting) return "the defaulting seat cannot approve a remedy against itself";
      /* A YES before the seal: the seat's CURRENT key (a key it replaced no longer approves anything new). */
      const key = ctx.consentPubkeys[approving];
      if (typeof key !== "string" || !/^0[23][0-9a-f]{64}$/.test(key)) return "the approving seat has no consent key on chain";
      const digest = remedyApproveDigestV1(
        {
          domain: ctx.domain,
          chain_game_id: BigInt(ctx.chainGameId),
          remedy: input.remedy as RemedyKindByte,
          defaulting_seat: defaulting,
          strike: input.strike,
          overdue_epoch: BigInt(input.epoch),
          log_len: BigInt(input.logLen),
          log_hash: input.logHash,
          overdue_at: secsUp(input.overdueMs),
        },
        BigInt(input.approveUntil),
        approving,
      );
      if (!verifyDigest(Buffer.from(key, "hex"), Buffer.from(digest, "hex"), Buffer.from(input.signature, "hex"))) return "the approval does not verify under your seat's current consent key (for this overdue and horizon)";
      return null;
    },

    async staleApprovals(gameId, facts, approvals, options = {}) {
      if (approvals.length === 0) return [];
      const atSecs = options.atSecs === undefined ? null : BigInt(options.atSecs);
      const timeoutMs = options.timeoutMs ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let running = true;
      let found: RemedyChainContext | null;
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        });
        /* At a past second: only a conclusive answer (a block later than it exists) is an answer. Now: current keys. */
        const read = atSecs === null ? context(gameId, false).then((ctx) => ("refused" in ctx ? null : ctx)) : conclusiveContext(gameId, atSecs, Math.max(1, Math.ceil(timeoutMs / POLL_MS)), () => running);
        found = await Promise.race([read, timeout]);
      } catch {
        found = null;
      } finally {
        running = false;
        if (timer !== null) clearTimeout(timer);
      }
      if (found === null) return null;
      const ctx = found;
      const defaulting = ctx.seatOf[facts.defaultingSeat];
      const decision = { kind: facts.remedy, strike: facts.strike, epoch: facts.epoch, log_len: facts.logLen, log_hash: facts.logHash, overdue_ms: facts.overdueMs };
      const stale: string[] = [];
      for (const approval of approvals) {
        const approving = ctx.seatOf[approval.seat];
        if (defaulting === undefined || approving === undefined || approving === defaulting || !approvalVerifies(ctx, decision, defaulting, approving, approval.approveUntil, approval.signature, atSecs)) stale.push(approval.seat);
      }
      return stale.sort();
    },

    async chainSeats(gameId) {
      const found = await context(gameId);
      return "refused" in found ? null : found.seatOf;
    },

    fence(gameId) {
      deps.service.fenceCheckpoint(gameId);
    },

    annulOpen(gameId) {
      return deps.service.annulOpen(gameId);
    },

    async startedAtSecs(gameId, timeoutMs = 5_000) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const found = await Promise.race([deps.service.remedyContext(gameId, null), timeout]);
        if (found === null || ("ok" in found && found.ok === false)) return null;
        const secs = (found as RemedyChainContext).startedAtSecs;
        return secs > BigInt(0) && secs <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(secs) : null;
      } catch {
        return null;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
  };
}
