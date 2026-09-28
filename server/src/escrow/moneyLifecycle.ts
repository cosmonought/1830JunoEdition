// server/src/escrow/moneyLifecycle.ts
//
// ==================================================================
//  ESCROW-3A (brief §4, §7): A FUNDED GAME'S LOCAL LIFECYCLE -- ONE DURABLE RECORD, ONE PURE TRANSITION TABLE
// ==================================================================
//
// The gameplay authority is unchanged: the sealed log decides who won. This is the SERVER'S money bookkeeping beside it
// -- what a funded game is waiting for, and what the server may and may not do about its money at each point -- kept as
// one durable record per money game (`games/money/<game_id>.json`, `financialGameStore.ts`) and moved only by the pure
// `transitionFinancial` below, so every writer (the settlement seam, the startup reconciliation, the operator tool) makes
// the same decision from the same facts, and a repeated observation converges instead of duplicating.
//
// THE PHASES (ESCROW-3B extends the chain-side ones -- signing, broadcast, inclusion -- after `intent-prepared`):
//
//   funding            created, not dealt. The escrow is FUNDING/FUNDED on chain; a seat may still `Withdraw` its net
//                      deposit and the creator may `Cancel` (anyone after the funding deadline): the contract's
//                      pre-Start refund semantics are the ordinary ones here.
//   in-progress        dealt. The chain is IN_PROGRESS (the deal follows the chain's Start). From here NOTHING the server
//                      does refunds anyone: no host cancel, no "abandon" -- leaving the browser, losing a device or a
//                      session, or going quiet changes no ownership and no money.
//   liveness           in-progress, but no gameplay for `LIVENESS_NOTICE_MS`: a FINANCIAL LIVENESS state, not a refund.
//                      Gameplay may resume (-> in-progress). The only exits are the contract's: the game's end (Settle),
//                      unanimous `AnnulByConsent`, or the on-chain `LivenessSettle` after the contract's own window --
//                      which PROMOTES THE BEST TRUSTED CHECKPOINT, so a stalling player is paid what the board said at the
//                      last checkpoint, never more (ESCROW-3B's obligation: a signed checkpoint at the deal and at every
//                      completed round boundary; `CHECKPOINT_POLICY`).
//   terminal-eligible  the log is SEALED: `(game_id, seal.log_len)` is recorded, once, forever. The same seal seen again
//                      (the seam is at least once) changes nothing; ANOTHER `log_len` for the same game is a conflict and
//                      HOLDS the game -- it can only mean two histories.
//   intent-prepared    the settlement evidence is derived from exactly the sealed prefix (`settlementEvidence.ts`) and
//                      recorded: log hash, appraisal state hash, the certified pin, the appraisal. ESCROW-3B signs and
//                      submits from here. Nothing about it is invented: no transaction, no hash from a chain.
//   held               operator attention: a seal conflict, an uncertified rules pin, a board the appraiser refuses, a
//                      history that does not replay here, an incompatible deployment. The money stays with the frozen
//                      game and its history; no ordinary path edits history or pretends the game never started. Only
//                      the offline operator tool lifts it, after the same verification the load runs, back to the phase
//                      it was held from -- or FURTHER when the facts moved on while it was held: a game whose seal was
//                      recorded resumes at terminal-eligible (so its intent is prepared), and a game the GameRecord says
//                      was dealt never resumes at funding. A MISSING financial record is never guessed at: a placeholder
//                      is written already held, with NO continuation identity (so no deployment continues the game across
//                      builds on its account), and it is never released -- the operator restores the original record.
//   cancelled          pre-deal only: the table was cancelled before the deal (the contract refunds by its own rules).
//
// NOT HERE (and deliberately refused by the table): a post-deal refund, a host abandon, a timeout refund, a seat
// transfer. Forfeit and Clemency stay `REASON_NOT_SUPPORTED` (ESCROW-3c).

import type { TerminalSettlementEvidence } from "./settlementEvidence";
import { isMoneyContinuationIdentity, type MoneyContinuationIdentity } from "./moneyContinuation";

export const FINANCIAL_FORMAT = "gs-financial-game";
export const FINANCIAL_VERSION = 1;

export type FinancialPhase = "funding" | "in-progress" | "liveness" | "terminal-eligible" | "intent-prepared" | "held" | "cancelled";
export const FINANCIAL_PHASES: readonly FinancialPhase[] = Object.freeze(["funding", "in-progress", "liveness", "terminal-eligible", "intent-prepared", "held", "cancelled"]);

/** Why a money game is held (operator-facing; players see the ordinary held sentence). */
export type FinancialHoldCode =
  /** The same game sealed at two different lengths: two histories. */
  | "seal-conflict"
  /** Evidence prepared twice with different content for one seal. */
  | "evidence-conflict"
  /** The sealed history cannot be sliced (not contiguous, gameplay after the seal, a seal that is not the history's). */
  | "sealed-prefix-refused"
  /** The sealed prefix does not replay on this deployment. */
  | "replay-failed"
  /** The sealed board is not a terminal board a settlement reason fits. */
  | "board-not-terminal"
  /** The board's rules pin is not settlement-certified here. */
  | "rules-not-certified"
  /** The certified appraiser refuses the sealed board. */
  | "appraisal-refused"
  /** This deployment may not continue this game (`moneyContinuation.ts`). */
  | "continuation-incompatible"
  /** A money GameRecord with no financial record (ESCROW-3B writes both together; its absence is never guessed at). */
  | "financial-record-missing"
  /** The game itself is held (its log or record), so its money is too. */
  | "game-held";

export interface FinancialHold {
  readonly code: FinancialHoldCode;
  /** Operator-facing; never a principal, profile, session or family id; never sent to a client. */
  readonly detail: string;
  readonly at: number;
  /** The phase it was held from: an operator release returns there (and only after verification). */
  readonly from: Exclude<FinancialPhase, "held">;
}

/** THE SETTLEMENT IDENTITY: one terminal history per game, forever. */
export interface TerminalNote {
  readonly log_len: number;
  readonly sealed_at: number;
  readonly noted_at: number;
}

export interface FinancialTransitionLine {
  readonly from: FinancialPhase;
  readonly to: FinancialPhase;
  readonly at: number;
  readonly why: string;
}

export interface FinancialGameRecord {
  readonly format: typeof FINANCIAL_FORMAT;
  readonly version: typeof FINANCIAL_VERSION;
  readonly game_id: string;
  /** OCC: +1 per committed transition (LIVE-5: `ConditionExpression record_version = :expected`). */
  readonly record_version: number;
  readonly phase: FinancialPhase;
  /** Frozen at creation: which deployments may continue this game (`moneyContinuation.ts`). `null` only on the held
   *  placeholder written for a MISSING record (`missingRecordPlaceholder`): unknown, so nothing continues on it. */
  readonly continuation: MoneyContinuationIdentity | null;
  readonly created_at: number;
  readonly updated_at: number;
  /** The last gameplay activity the lifecycle saw (liveness is measured from it). */
  readonly last_activity_at: number | null;
  readonly terminal: TerminalNote | null;
  readonly intent: TerminalSettlementEvidence | null;
  readonly hold: FinancialHold | null;
  /** Every transition, oldest first (bounded by `MAX_TRANSITIONS`; the oldest are dropped past it). */
  readonly transitions: readonly FinancialTransitionLine[];
}

export const MAX_TRANSITIONS = 64;
/** No gameplay for this long moves an in-progress money game to `liveness` (a notice for the operator and ESCROW-3B's
 *  checkpoint relayer; the chain's own liveness window decides any exit). */
export const LIVENESS_NOTICE_MS = 24 * 60 * 60 * 1000;

/** ESCROW-3B's checkpoint obligation (what makes a stall pay by appraisal, not by refund). */
export const CHECKPOINT_POLICY = Object.freeze({
  atDeal: true,
  atEveryCompletedRoundBoundary: true,
  /** Post newer checkpoints before the contract's liveness window closes (ESCROW-2.1 residual: a plain LivenessSettle
   *  can land before one that carries a newer checkpoint). */
  beforeLivenessWindowCloses: true,
});

/** Every hold code, for the strict shape check. */
export const FINANCIAL_HOLD_CODES: readonly FinancialHoldCode[] = Object.freeze([
  "seal-conflict",
  "evidence-conflict",
  "sealed-prefix-refused",
  "replay-failed",
  "board-not-terminal",
  "rules-not-certified",
  "appraisal-refused",
  "continuation-incompatible",
  "financial-record-missing",
  "game-held",
]);

/** A money GameRecord with no financial record: ONE create writes this, already held (never a `funding` record that a
 *  crash between two writes could leave unheld). No continuation identity is invented; `from` is the post-deal phase,
 *  so nothing that reads it offers a pre-deal refund -- and it is never released (`operator-release` refuses it). */
export function missingRecordPlaceholder(gameId: string, now: number, detail: string): FinancialGameRecord {
  return {
    ...newFinancialRecord(gameId, null, now),
    phase: "held",
    hold: { code: "financial-record-missing", detail: detail.slice(0, 500), at: now, from: "in-progress" },
    transitions: [{ from: "in-progress", to: "held", at: now, why: "hold: financial-record-missing (placeholder; the original record was not found)" }],
  };
}

export function newFinancialRecord(gameId: string, continuation: MoneyContinuationIdentity | null, now: number): FinancialGameRecord {
  return {
    format: FINANCIAL_FORMAT,
    version: FINANCIAL_VERSION,
    game_id: gameId,
    record_version: 1,
    phase: "funding",
    continuation,
    created_at: now,
    updated_at: now,
    last_activity_at: null,
    terminal: null,
    intent: null,
    hold: null,
    transitions: [],
  };
}

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

const RECORD_KEYS = ["format", "version", "game_id", "record_version", "phase", "continuation", "created_at", "updated_at", "last_activity_at", "terminal", "intent", "hold", "transitions"];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const time = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value);

/** A stored financial record is exactly this shape, or it is unreadable (never guessed at). */
export function isFinancialGameRecord(value: unknown): value is FinancialGameRecord {
  if (!isObject(value) || !exact(value, RECORD_KEYS)) return false;
  const terminal = value.terminal;
  const hold = value.hold;
  return (
    value.format === FINANCIAL_FORMAT &&
    value.version === FINANCIAL_VERSION &&
    typeof value.game_id === "string" &&
    Number.isSafeInteger(value.record_version) &&
    (value.record_version as number) >= 1 &&
    (FINANCIAL_PHASES as readonly unknown[]).includes(value.phase) &&
    (isMoneyContinuationIdentity(value.continuation) ||
      (value.continuation === null && value.phase === "held" && isObject(hold) && hold.code === "financial-record-missing")) &&
    time(value.created_at) &&
    time(value.updated_at) &&
    (value.last_activity_at === null || time(value.last_activity_at)) &&
    (terminal === null || (isObject(terminal) && exact(terminal, ["log_len", "sealed_at", "noted_at"]) && Number.isSafeInteger(terminal.log_len) && (terminal.log_len as number) >= 1 && time(terminal.sealed_at) && time(terminal.noted_at))) &&
    (value.intent === null || isObject(value.intent)) &&
    (hold === null || (isObject(hold) && exact(hold, ["code", "detail", "at", "from"]) && (FINANCIAL_HOLD_CODES as readonly unknown[]).includes(hold.code) && typeof hold.detail === "string" && time(hold.at) && (FINANCIAL_PHASES as readonly unknown[]).includes(hold.from) && hold.from !== "held")) &&
    Array.isArray(value.transitions) &&
    (value.phase === "held") === (hold !== null)
  );
}

/* ------------------------------------------------------------------ */
/* The transition table                                                */
/* ------------------------------------------------------------------ */

export type FinancialEvent =
  /** The deal committed (after the chain's Start). */
  | { readonly kind: "dealt"; readonly at: number }
  /** Gameplay was committed. */
  | { readonly kind: "activity"; readonly at: number }
  /** A periodic look at a quiet game. */
  | { readonly kind: "inactivity-check"; readonly at: number; readonly noticeMs?: number }
  /** The terminal seal, observed (at least once). */
  | { readonly kind: "sealed"; readonly at: number; readonly log_len: number; readonly sealed_at: number }
  /** Evidence derived from the sealed prefix. */
  | { readonly kind: "prepared"; readonly at: number; readonly evidence: TerminalSettlementEvidence }
  /** Something only an operator may resolve. */
  | { readonly kind: "hold"; readonly at: number; readonly code: FinancialHoldCode; readonly detail: string }
  /** The offline operator tool, after verification (never a server path). `dealt`: the game's GameRecord says it was
   *  dealt (a game dealt while held never resumes at `funding`). */
  | { readonly kind: "operator-release"; readonly at: number; readonly note: string; readonly dealt?: boolean }
  /** A host cancelling before the deal. */
  | { readonly kind: "cancel-before-deal"; readonly at: number }
  /** Anything that would refund, cancel or abandon a DEALT game -- always refused; here so the refusal is pinned. */
  | { readonly kind: "host-abandon" | "timeout-refund" | "seat-transfer"; readonly at: number };

export type FinancialTransition =
  | { readonly kind: "moved"; readonly next: FinancialGameRecord }
  /** Nothing to write: the record already says this (an at-least-once repeat converges here). */
  | { readonly kind: "same" }
  | { readonly kind: "refused"; readonly reason: string };

/** Sentences for the refusals a player or host could meet (ESCROW-3B/4 surface them). */
export const POST_DEAL_REFUSAL = "A funded game that has been dealt cannot be cancelled, abandoned or refunded by the server; it ends by play, by every seat agreeing to annul it, or by the escrow's own liveness rule.";

const moved = (record: FinancialGameRecord, to: FinancialPhase, at: number, why: string, patch: Partial<FinancialGameRecord> = {}): FinancialTransition => {
  const line: FinancialTransitionLine = { from: record.phase, to, at, why };
  const transitions = [...record.transitions, line].slice(-MAX_TRANSITIONS);
  return { kind: "moved", next: { ...record, ...patch, phase: to, record_version: record.record_version + 1, updated_at: at, transitions } };
};

const held = (record: FinancialGameRecord, at: number, code: FinancialHoldCode, detail: string): FinancialTransition => {
  if (record.phase === "held") return { kind: "same" }; // the FIRST hold stands (its evidence is what the game looked like)
  if (record.phase === "cancelled") return { kind: "refused", reason: "a cancelled table has nothing to hold" };
  return moved(record, "held", at, `hold: ${code}`, { hold: { code, detail: detail.slice(0, 500), at, from: record.phase } });
};

/** Same evidence (the at-least-once repeat), or different (two derivations of one seal: a hold). */
function sameEvidence(a: TerminalSettlementEvidence, b: TerminalSettlementEvidence): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The one place a money game's lifecycle moves. Pure. */
export function transitionFinancial(record: FinancialGameRecord, event: FinancialEvent): FinancialTransition {
  const at = event.at;
  switch (event.kind) {
    case "dealt":
      if (record.phase === "funding") return moved(record, "in-progress", at, "dealt", { last_activity_at: at });
      if (record.phase === "in-progress" || record.phase === "liveness" || record.terminal !== null) return { kind: "same" };
      return { kind: "refused", reason: `a ${record.phase} game is not dealt now` };
    case "activity":
      if (record.phase === "in-progress") return at > (record.last_activity_at ?? 0) ? { kind: "moved", next: { ...record, last_activity_at: at, updated_at: at, record_version: record.record_version + 1 } } : { kind: "same" };
      if (record.phase === "liveness") return moved(record, "in-progress", at, "gameplay resumed", { last_activity_at: at });
      return { kind: "same" };
    case "inactivity-check": {
      if (record.phase !== "in-progress") return { kind: "same" };
      const quietSince = record.last_activity_at ?? record.updated_at;
      return at - quietSince >= (event.noticeMs ?? LIVENESS_NOTICE_MS) ? moved(record, "liveness", at, "no gameplay for the liveness notice period") : { kind: "same" };
    }
    case "sealed": {
      if (record.terminal !== null) {
        if (record.terminal.log_len === event.log_len) return { kind: "same" }; // the same terminal history, seen again
        return held(record, at, "seal-conflict", `sealed at ${record.terminal.log_len}, now seen sealed at ${event.log_len}`);
      }
      if (record.phase === "in-progress" || record.phase === "liveness") {
        return moved(record, "terminal-eligible", at, `sealed at log_len ${event.log_len}`, { terminal: { log_len: event.log_len, sealed_at: event.sealed_at, noted_at: at } });
      }
      if (record.phase === "held") {
        /* A held game's seal is still recorded (it is a fact of the log), but it stays held. */
        return { kind: "moved", next: { ...record, terminal: { log_len: event.log_len, sealed_at: event.sealed_at, noted_at: at }, record_version: record.record_version + 1, updated_at: at } };
      }
      return held(record, at, "seal-conflict", `a ${record.phase} money game reported sealed at ${event.log_len}`);
    }
    case "prepared": {
      if (record.terminal === null) return { kind: "refused", reason: "no seal is recorded" };
      if (event.evidence.log_len !== record.terminal.log_len) {
        return held(record, at, "evidence-conflict", `evidence for log_len ${event.evidence.log_len}, the seal is ${record.terminal.log_len}`);
      }
      if (record.phase === "terminal-eligible") return moved(record, "intent-prepared", at, "settlement evidence prepared from the sealed prefix", { intent: event.evidence });
      if (record.phase === "intent-prepared" && record.intent !== null) {
        return sameEvidence(record.intent, event.evidence) ? { kind: "same" } : held(record, at, "evidence-conflict", "a second derivation of the same seal differs");
      }
      return { kind: "same" };
    }
    case "hold":
      return held(record, at, event.code, event.detail);
    case "operator-release": {
      if (record.phase !== "held" || record.hold === null) return { kind: "refused", reason: "not held" };
      if (record.hold.code === "financial-record-missing" || record.continuation === null) {
        return { kind: "refused", reason: "a placeholder for a missing financial record is never released: stop the server and restore the original record" };
      }
      const note = event.note.trim();
      if (note.length === 0 || note.length > 500) return { kind: "refused", reason: "a release needs a note (1-500 characters)" };
      const from = record.hold.from;
      /* The facts may have moved on while it was held: a recorded seal resumes at terminal-eligible (a seal implies the
         deal), a dealt game never resumes at funding. */
      const to: FinancialPhase =
        record.terminal !== null && (from === "funding" || from === "in-progress" || from === "liveness")
          ? "terminal-eligible"
          : from === "funding" && event.dealt === true
            ? "in-progress"
            : from;
      return moved(record, to, at, `operator release: ${note}`, { hold: null, ...(to === "in-progress" && from === "funding" ? { last_activity_at: at } : {}) });
    }
    case "cancel-before-deal":
      if (record.phase === "funding") return moved(record, "cancelled", at, "cancelled before the deal (the escrow refunds by its own pre-Start rules)");
      if (record.phase === "cancelled") return { kind: "same" };
      return { kind: "refused", reason: POST_DEAL_REFUSAL };
    case "host-abandon":
    case "timeout-refund":
    case "seat-transfer":
      return { kind: "refused", reason: record.phase === "funding" && event.kind !== "seat-transfer" ? "before the deal a table is cancelled, not abandoned (cancel-before-deal)" : POST_DEAL_REFUSAL };
    default:
      return { kind: "refused", reason: "unknown event" };
  }
}

/* ------------------------------------------------------------------ */
/* What the server may do, by phase (the policy ESCROW-3B/4 consume)   */
/* ------------------------------------------------------------------ */

export type MoneyAction =
  | "host-cancel"
  | "seat-withdraw"
  | "leave-table"
  | "host-transfer"
  | "settle"
  | "post-checkpoint"
  | "annul-by-consent"
  | "liveness-settle"
  | "server-refund"
  | "seat-transfer";

/** Whether an action is open to a money game in a phase, and what it means there. Pure; the chain actions are the
 *  PLAYERS' (their wallets sign them) or the relayer's (ESCROW-3B); the server never refunds by itself. */
export function moneyActionPolicy(phase: FinancialPhase, action: MoneyAction): { readonly allowed: boolean; readonly means: string } {
  const post = phase === "in-progress" || phase === "liveness" || phase === "terminal-eligible" || phase === "intent-prepared" || phase === "held";
  switch (action) {
    case "host-cancel":
      return phase === "funding" ? { allowed: true, means: "the table closes; the escrow's Cancel refunds every net deposit" } : { allowed: false, means: POST_DEAL_REFUSAL };
    case "seat-withdraw":
      return phase === "funding" ? { allowed: true, means: "the seat's wallet Withdraws its net deposit (pre-Start)" } : { allowed: false, means: "after Start no seat can withdraw (contract)" };
    case "leave-table":
      return phase === "funding"
        ? { allowed: true, means: "the seat is released; its deposit is withdrawn by its wallet" }
        : { allowed: post, means: "unsubscribe only: the seat, its principal, its player_id and its money are unchanged" };
    case "host-transfer":
      return { allowed: phase !== "cancelled", means: "the host role moves; no money moves" };
    case "settle":
      return phase === "intent-prepared" ? { allowed: true, means: "ESCROW-3B signs and submits the prepared terminal payload" } : { allowed: false, means: "only a prepared terminal intent settles" };
    case "post-checkpoint":
      return phase === "in-progress" || phase === "liveness" ? { allowed: true, means: "ESCROW-3B posts a signed round-boundary checkpoint" } : { allowed: false, means: "checkpoints are posted while play is open" };
    case "annul-by-consent":
      return { allowed: post, means: "every seat's wallet signs; net antes return (unanimity: no single player can force it)" };
    case "liveness-settle":
      return { allowed: post, means: "a seat's wallet may exit after the contract's window: the best trusted checkpoint is promoted (a refund only if none was ever posted)" };
    case "server-refund":
    case "seat-transfer":
      return { allowed: false, means: action === "seat-transfer" ? "there is no seat transfer or rebind primitive" : POST_DEAL_REFUSAL };
    default:
      return { allowed: false, means: "unknown action" };
  }
}
