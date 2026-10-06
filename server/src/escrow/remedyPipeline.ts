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
// The relayer then submits it, but only on the clock lane's word (`EscrowServiceDeps.remedyGate`, the controller's
// `remedyGate`): never during a SYSTEM PAUSE, never from an authority that is not the clock's current one, never while a
// unanimous annulment of the game is open (it supersedes the non-final remedy). An attestation that expired before it
// landed is attested AGAIN for the same decision (`attestations` counts them); a Live foreclosure whose approvals lapsed
// is replaced by the neutral timeout annulment (the clock seals that fallback; FP4's fence makes it wait until the
// earlier attestation can no longer land). NO payout is computed here or in any browser: the contract's
// `foreclosure_split` decides every amount.

import {
  LIVE_CURE_WINDOW_SECS,
  MAX_REMEDY_TTL_SECS,
  remedyApproveDigestV1,
  type RemedyAttestationV1,
  type RemedyKindByte,
} from "../../../frontend/src/gameEngine/escrow/junoRemedyV1";
import type { ClockRemedy, RemedyKind, RemedyStatus } from "../rooms/clock/clockRecord";
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
  /** Live foreclosure only: its approvals can no longer land -- the clock should seal the neutral fallback. */
  readonly fallback?: boolean;
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
  /** The chain seat of each player (the frozen roster), for the clock's money view. */
  chainSeats(gameId: string): Promise<Readonly<Record<string, number>> | null>;
  /** Post a fencing checkpoint (a cure ended an overdue instance). */
  fence(gameId: string): void;
  /** Whether a unanimous annulment intent is open for the game. */
  annulOpen(gameId: string): Promise<boolean>;
}

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

/** Live approvals must outlive finality by this much (seconds) and may not reach further than `LIVE_APPROVAL_MAX_SECS`. */
export const APPROVAL_MARGIN_SECS = 120;
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

const matches = (intent: ChainIntentRecord, remedy: ClockRemedy): boolean =>
  intent.op.kind === "remedy" && intent.op.remedy === remedy.kind && intent.op.overdue_epoch === String(remedy.epoch) && intent.op.log_len === String(remedy.log_len) && intent.op.strike === remedy.strike;

export function createRemedyPipeline(deps: RemedyPipelineDeps): RemedyPort {
  const audit = (event: string, fields: Record<string, unknown>) => deps.audit?.(event, fields);

  async function context(gameId: string): Promise<RemedyChainContext | { readonly refused: string }> {
    const ctx = await deps.service.remedyContext(gameId, deps.signer?.remedyKeyId ?? null);
    if ("ok" in ctx && ctx.ok === false) return { refused: `${ctx.code}: ${ctx.detail}` };
    return ctx as RemedyChainContext;
  }

  return {
    configured: deps.signer !== null,

    async attest(gameId, remedy) {
      const signer = deps.signer;
      if (signer === null) return { status: "refused", detail: "no dedicated REMEDY key is configured on this server: no remedy is attested (fail closed)", attested: false };
      const found = await context(gameId);
      if ("refused" in found) return { status: remedy.status === "submitted" ? "submitted" : "refused", detail: found.refused, attested: false };
      const ctx = found;
      if (ctx.remedyKey === null || !ctx.remedyKey.active || ctx.remedyKey.pubkey !== signer.publicKeyHex) {
        return { status: "refused", detail: `the chain's REMEDY key ${signer.remedyKeyId} is not this server's active key: nothing is attested`, attested: false };
      }
      const progress = await this.progress(gameId, remedy);
      if (progress === "confirmed") return { status: "confirmed", detail: null, attested: false };
      if (progress === "open") return { status: "submitted", detail: null, attested: false };
      if (ctx.remedy !== null) return { status: "superseded", detail: `another remedy (${ctx.remedy.kind}) is on chain`, attested: false };
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
      for (const approval of remedy.approvals) {
        const seat = ctx.seatOf[approval.seat];
        if (seat === undefined) return { status: "refused", detail: `an approving player (${approval.seat}) is not in the frozen roster`, attested: false };
        approvals.push({ seat_index: seat, approve_until: BigInt(approval.approve_until), signature: approval.signature });
      }
      /* An approval whose horizon is at or before the attestation time could never land with it. */
      if (approvals.some((approval) => approval.approve_until <= attestedAt)) {
        return remedy.kind === 2
          ? { status: "refused", detail: "an approval of the foreclosure lapsed before it could land: the neutral timeout annulment replaces it", attested: false, fallback: true }
          : { status: "refused", detail: "an approval lapsed before the remedy could land: the seats must approve again", attested: false };
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
      const intents = (await deps.service.intentsOf(gameId)).filter((intent) => matches(intent, remedy));
      if (intents.some((intent) => intent.status === "confirmed")) return "confirmed";
      if (intents.some((intent) => intent.status === "pending" || intent.status === "in-flight" || (intent.status === "held" && intent.attempts.some(isLiveAttempt)))) return "open";
      return intents.length === 0 ? "none" : "dead";
    },

    async verifyApproval(gameId, input) {
      if (!/^[0-9a-f]{128}$/.test(input.signature)) return "the approval is not a 64-byte signature";
      if (!Number.isSafeInteger(input.approveUntil) || input.approveUntil <= 0) return "the approval's horizon is not a time";
      const nowSecs = Math.floor(input.nowMs / 1000);
      const live = input.remedy <= 3;
      if (live) {
        const minimum = Number(secsUp(input.finalNotBeforeMs)) + APPROVAL_MARGIN_SECS;
        if (input.approveUntil < minimum) return `a Live approval must last until at least ${minimum} (finality plus ${APPROVAL_MARGIN_SECS} s)`;
        if (input.approveUntil > Number(secsUp(input.overdueMs)) + LIVE_APPROVAL_MAX_SECS) return "a Live approval may not reach more than six hours past the overdue";
      } else {
        if (input.approveUntil < nowSecs + ASYNC_APPROVAL_MIN_SECS) return "an Async approval must last at least an hour";
        if (input.approveUntil > nowSecs + ASYNC_APPROVAL_MAX_SECS) return "an Async approval may not reach more than 30 days ahead";
      }
      const found = await context(gameId);
      if ("refused" in found) return `the escrow cannot be read now (${found.refused})`;
      const ctx = found;
      const defaulting = ctx.seatOf[input.defaultingSeat];
      const approving = ctx.seatOf[input.approvingSeat];
      if (defaulting === undefined || approving === undefined) return "a player is not in the frozen roster";
      if (approving === defaulting) return "the defaulting seat cannot approve a remedy against itself";
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
  };
}
