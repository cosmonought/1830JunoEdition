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
//
// ESCROW-3B: WHAT THE CHAIN SAYS, AFTER THE INTENT (the chain wins; every one of these is an OBSERVATION of a confirmed
// chain fact -- the transactions themselves live in durable chain intents, `chainIntents.ts`, one per slot, persisted
// before any byte is broadcast):
//
//   settleable         the terminal Settle is ON CHAIN (confirmed by a chain read): the escrow is SETTLEABLE, its
//                      challenge window open. Seats may consent (ESCROW-4) or challenge; the relayer Finalizes after the
//                      window.
//   disputed           a seat challenged the stored settlement: the resolver's (never the server's) decision.
//   closed             the escrow is TERMINAL on chain (SETTLED / ANNULLED / CANCELLED), by whatever route -- Finalize,
//                      consent, the resolver, a liveness exit, an annul. `chain_outcome` records the route; nothing more
//                      is ever submitted for this game. Reachable from any dealt phase: the chain can end a game that
//                      gameplay has not (a stall's liveness exit), and gameplay is never rewritten to match.
//
// THE MONEY BINDING (brief §5) rides in the same record and is WRITE-ONCE, in two steps that can never redirect funds:
//   deployment         pinned when the money game is created, before any ticket or deposit can exist: backend, codec,
//                      chain id, network class, contract address, code checksum, denomination. A deployment that later
//                      disagrees (another chain, contract, checksum or denom configured) is REFUSED for this game.
//   escrow             the chain game, bound once from a chain read (`EscrowBindingV2`: chain_game_id, terms, the rules
//                      and variants commitments), and required to match the pinned deployment.
//   roster             the frozen financial roster (`EscrowRosterFreeze`): chain seat -> player_id -> payout wallet,
//                      written in the start-intent task; from then on no seat can change for this game -- PROVISIONALLY
//                      until the chain confirms Start, PERMANENTLY after. A freeze is released (`roster-released`) only
//                      when the chain PROVES that freeze's Start can never happen (its Start intent is terminal with no
//                      live attempt, and the escrow, read at or above every attempt's resolution height, shows no Start):
//                      the table returns to its pre-Start funded state and a later freeze is a new `roster_epoch`.
// Any second, DIFFERENT value for a written step is a HOLD (`binding-conflict`), never an overwrite.
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
import type { EscrowBindingV2, EscrowRosterFreeze } from "../../../frontend/src/gameEngine/escrow/escrowModel";

export const FINANCIAL_FORMAT = "gs-financial-game";
/** ESCROW-3B: version 2 adds the money binding, the frozen roster, chain progress and the chain outcome. */
export const FINANCIAL_VERSION = 2;

export type FinancialPhase =
  | "funding"
  | "in-progress"
  | "liveness"
  | "terminal-eligible"
  | "intent-prepared"
  | "settleable"
  | "disputed"
  | "closed"
  | "held"
  | "cancelled";
export const FINANCIAL_PHASES: readonly FinancialPhase[] = Object.freeze([
  "funding",
  "in-progress",
  "liveness",
  "terminal-eligible",
  "intent-prepared",
  "settleable",
  "disputed",
  "closed",
  "held",
  "cancelled",
]);
/** Phases after the deal (nothing the server does refunds anyone from here). */
export const DEALT_PHASES: readonly FinancialPhase[] = Object.freeze(["in-progress", "liveness", "terminal-eligible", "intent-prepared", "settleable", "disputed", "closed"]);

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
  | "game-held"
  /** ESCROW-3B: a write-once binding step (deployment, chain game, roster) was offered a DIFFERENT value. */
  | "binding-conflict"
  /** ESCROW-3B: this deployment's chain configuration is not the one the game is bound to (fail closed). */
  | "binding-mismatch"
  /** ESCROW-3B: the chain shows something the server did not do for this game (another payload at a signed slot, another
   *  roster, another domain). The chain wins; the operator (or the resolver) decides. */
  | "chain-inconsistent"
  /** ESCROW-3B: a chain intent could not proceed and needs an operator (a never-retry refusal, absurd gas, a budget spent). */
  | "chain-intent-held"
  /** ESCROW-3B (GNOLAND-1 F1): the signing journal or the chain is AHEAD of the durable log (a restored store): the server
   *  never re-signs a different history at a signed seq. */
  | "journal-ahead"
  /** ESCROW-3B (brief §13): the persisted terminal intent and a fresh derivation from the sealed prefix disagree. */
  | "evidence-mismatch";

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

/** ESCROW-3B: the deployment a money game is pinned to at creation (brief §5). Chain-read facts, never a caller's claim. */
export interface FinancialDeploymentPin {
  readonly backend: EscrowBindingV2["backend"];
  readonly codec: EscrowBindingV2["codec"];
  readonly chain_id: string;
  readonly network_class: EscrowBindingV2["network"]["network_class"];
  readonly contract_address: string;
  readonly code_checksum: string;
  readonly denom: string;
}

/** ESCROW-3B: the money binding (write-once, step by step). */
export interface FinancialBinding {
  readonly format: typeof MONEY_BINDING_FORMAT;
  readonly deployment: FinancialDeploymentPin;
  /** The chain game (GNOLAND-1 EscrowBindingV2), bound once from a chain read; null until the creator's CreateGame lands. */
  readonly escrow: EscrowBindingV2 | null;
}

export const MONEY_BINDING_FORMAT = "18COSMOS/MONEY-BINDING/v1";

/** ESCROW-3B: confirmed chain facts the lifecycle has observed (pointers for the operator; the chain stays the truth). */
export interface FinancialChainProgress {
  /** Start confirmed on chain: the height it was seen at and the domain the chain froze (== roster.expected_domain). */
  readonly started: { readonly height: string; readonly domain: string; readonly at: number } | null;
  /** The newest checkpoint the server prepared (a durable intent), and the newest one the chain confirmed. */
  readonly checkpoint_prepared: { readonly seq: string; readonly log_len: number; readonly round_key: string; readonly intent_id: string } | null;
  readonly checkpoint_confirmed: { readonly seq: string; readonly log_len: number; readonly at: number } | null;
  /** The terminal Settle, once confirmed on chain. */
  readonly settle_confirmed: { readonly seq: string; readonly window_end_secs: string; readonly at: number } | null;
}

export const NO_CHAIN_PROGRESS: FinancialChainProgress = Object.freeze({ started: null, checkpoint_prepared: null, checkpoint_confirmed: null, settle_confirmed: null });

/** ESCROW-3B: how the escrow ended on chain (`closed`). */
export interface FinancialChainOutcome {
  readonly state: "SETTLED" | "ANNULLED" | "CANCELLED";
  readonly route: string;
  readonly observed_at: number;
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
  /** ESCROW-3B: the money binding (null only on a placeholder, or a record created before its deployment was pinned). */
  readonly binding: FinancialBinding | null;
  /** ESCROW-3B: the frozen financial roster (in the start-intent task; released only on a proven Start failure). */
  readonly roster: EscrowRosterFreeze | null;
  /** ESCROW-3B: how many rosters were ever frozen for this game (the current one, if any, is this epoch); each epoch has
   *  its own Start slot (`chainIntents.ts` `startInstanceOf`). 0: never frozen. */
  readonly roster_epoch: number;
  readonly chain: FinancialChainProgress;
  readonly chain_outcome: FinancialChainOutcome | null;
}

export const MAX_TRANSITIONS = 64;
/** No gameplay for this long moves an in-progress money game to `liveness` (a notice for the operator and ESCROW-3B's
 *  checkpoint relayer; the chain's own liveness window decides any exit). */
export const LIVENESS_NOTICE_MS = 24 * 60 * 60 * 1000;

/** ESCROW-3B's checkpoint obligation (what makes a stall pay by appraisal, not by refund) -- implemented by
 *  `checkpointPolicy.ts` (which boundaries qualify) and `escrowService.ts` (one durable intent per boundary). */
export const CHECKPOINT_POLICY = Object.freeze({
  atDeal: true,
  atEveryCompletedRoundBoundary: true,
  /** ESCROW-3B: the seal is the last boundary: a checkpoint at `seal.log_len` (seq 2L) precedes the Settle (2L+1), so
   *  a liveness exit while Settle cannot land (a pause) still pays exactly the terminal appraisal. */
  atTerminalSeal: true,
  /** Post newer checkpoints before the contract's liveness window closes (ESCROW-2.1 residual: a plain LivenessSettle
   *  can land before one that carries a newer checkpoint). Checkpoints are posted as soon as the relayer can: gameplay
   *  never waits for them, and a newer one supersedes an older one not yet signed. */
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
  "binding-conflict",
  "binding-mismatch",
  "chain-inconsistent",
  "chain-intent-held",
  "journal-ahead",
  "evidence-mismatch",
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

export function newFinancialRecord(gameId: string, continuation: MoneyContinuationIdentity | null, now: number, deployment: FinancialDeploymentPin | null = null): FinancialGameRecord {
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
    binding: deployment === null ? null : { format: MONEY_BINDING_FORMAT, deployment, escrow: null },
    roster: null,
    roster_epoch: 0,
    chain: NO_CHAIN_PROGRESS,
    chain_outcome: null,
  };
}

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

const RECORD_KEYS = ["format", "version", "game_id", "record_version", "phase", "continuation", "created_at", "updated_at", "last_activity_at", "terminal", "intent", "hold", "transitions", "binding", "roster", "roster_epoch", "chain", "chain_outcome"];
const CHAIN_KEYS = ["started", "checkpoint_prepared", "checkpoint_confirmed", "settle_confirmed"];
const PIN_KEYS = ["backend", "codec", "chain_id", "network_class", "contract_address", "code_checksum", "denom"];
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
    (value.phase === "held") === (hold !== null) &&
    (value.binding === null ||
      (isObject(value.binding) &&
        exact(value.binding, ["format", "deployment", "escrow"]) &&
        value.binding.format === MONEY_BINDING_FORMAT &&
        isObject(value.binding.deployment) &&
        exact(value.binding.deployment, PIN_KEYS) &&
        PIN_KEYS.every((key) => typeof (value.binding as { deployment: Record<string, unknown> }).deployment[key] === "string") &&
        (value.binding.escrow === null || isObject(value.binding.escrow)))) &&
    (value.roster === null || (isObject(value.roster) && Array.isArray(value.roster.roster) && typeof value.roster.roster_hash === "string" && typeof value.roster.expected_domain === "string")) &&
    (value.roster === null || (isObject(value.binding) && value.binding.escrow !== null)) &&
    Number.isSafeInteger(value.roster_epoch) &&
    (value.roster_epoch as number) >= 0 &&
    (value.roster === null || (value.roster_epoch as number) >= 1) &&
    isObject(value.chain) &&
    exact(value.chain, CHAIN_KEYS) &&
    (value.chain_outcome === null || (isObject(value.chain_outcome) && typeof value.chain_outcome.state === "string" && typeof value.chain_outcome.route === "string")) &&
    (value.phase !== "closed" || value.chain_outcome !== null)
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
  /** Something only an operator may resolve. `verifiedConflict` (LIVE-4 L4-7): this is the OWNER'S hold for a deployment
   *  conflict concluded from a verification-grade chain read -- the one hold that is not dropped when the record is held
   *  already (it supersedes any weaker hold: see `held`). */
  | { readonly kind: "hold"; readonly at: number; readonly code: FinancialHoldCode; readonly detail: string; readonly verifiedConflict?: true }
  /** The offline operator tool, after verification (never a server path). `dealt`: the game's GameRecord says it was
   *  dealt (a game dealt while held never resumes at `funding`). */
  | { readonly kind: "operator-release"; readonly at: number; readonly note: string; readonly dealt?: boolean }
  /** A host cancelling before the deal. */
  | { readonly kind: "cancel-before-deal"; readonly at: number }
  /** Anything that would refund, cancel or abandon a DEALT game -- always refused; here so the refusal is pinned. */
  | { readonly kind: "host-abandon" | "timeout-refund" | "seat-transfer"; readonly at: number }
  /* ---- ESCROW-3B: the money binding, step by step (write-once) ---- */
  | { readonly kind: "deployment-pinned"; readonly at: number; readonly deployment: FinancialDeploymentPin }
  | { readonly kind: "bound"; readonly at: number; readonly escrow: EscrowBindingV2 }
  | { readonly kind: "roster-frozen"; readonly at: number; readonly freeze: EscrowRosterFreeze }
  /** The chain PROVED this epoch's Start can never happen (never a timer, an RPC failure or an unknown outcome). */
  | { readonly kind: "roster-released"; readonly at: number; readonly epoch: number; readonly roster_hash: string; readonly why: string }
  /* ---- ESCROW-3B: confirmed chain observations (the chain wins) ---- */
  | { readonly kind: "chain-started"; readonly at: number; readonly height: string; readonly domain: string }
  | { readonly kind: "checkpoint-prepared"; readonly at: number; readonly seq: string; readonly log_len: number; readonly round_key: string; readonly intent_id: string }
  | { readonly kind: "checkpoint-confirmed"; readonly at: number; readonly seq: string; readonly log_len: number }
  | { readonly kind: "chain-settleable"; readonly at: number; readonly seq: string; readonly window_end_secs: string }
  | { readonly kind: "chain-disputed"; readonly at: number }
  | { readonly kind: "chain-closed"; readonly at: number; readonly state: FinancialChainOutcome["state"]; readonly route: string };

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

const held = (record: FinancialGameRecord, at: number, code: FinancialHoldCode, detail: string, verifiedConflict = false): FinancialTransition => {
  if (record.phase === "held") {
    /* LIVE-4 (L4-7): THE ONE EXCEPTION TO "THE FIRST HOLD STANDS". The chain's facts live for one run, and the durable
       record of a verified deployment conflict is its `binding-mismatch` hold, which the next run reads while it has not
       read the chain (`continuationVerdict` step 7). A record held already, for anything but that or the missing-record
       placeholder, would otherwise keep the conflict nowhere -- so the owner's verified-conflict hold supersedes it,
       keeping the phase it was held from and naming the first hold in its detail (and in the transition line). */
    const first = record.hold;
    if (verifiedConflict && code === "binding-mismatch" && first !== null && first.code !== code && first.code !== "financial-record-missing") {
      return moved(record, "held", at, `hold: ${code} (supersedes ${first.code})`, {
        hold: { code, detail: `${detail} -- superseding ${first.code}: ${first.detail}`.slice(0, 500), at, from: first.from },
      });
    }
    return { kind: "same" }; // the FIRST hold stands (its evidence is what the game looked like)
  }
  if (record.phase === "cancelled") return { kind: "refused", reason: "a cancelled table has nothing to hold" };
  return moved(record, "held", at, `hold: ${code}`, { hold: { code, detail: detail.slice(0, 500), at, from: record.phase } });
};

/** A write that changes fields but not the phase (no transition line). */
const patched = (record: FinancialGameRecord, at: number, patch: Partial<FinancialGameRecord>): FinancialTransition => ({
  kind: "moved",
  next: { ...record, ...patch, record_version: record.record_version + 1, updated_at: at },
});

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
      if (DEALT_PHASES.includes(record.phase) || record.terminal !== null) return { kind: "same" };
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
      if (record.phase === "held" || record.phase === "closed") {
        /* A held game's seal is still recorded (it is a fact of the log), but it stays held. ESCROW-3B: so is a game whose
           escrow the chain already closed (a liveness exit or an annul while play went on): nothing more is submitted. */
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
      return held(record, at, event.code, event.detail, event.verifiedConflict === true);
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
    /* ---------------- ESCROW-3B: the binding, write-once ---------------- */
    case "deployment-pinned": {
      if (record.binding !== null) return sameJson(record.binding.deployment, event.deployment) ? { kind: "same" } : held(record, at, "binding-conflict", "a second, different deployment was offered for this money game");
      if (record.phase !== "funding") return { kind: "refused", reason: "a deployment is pinned only when the money game is created" };
      return patched(record, at, { binding: { format: MONEY_BINDING_FORMAT, deployment: event.deployment, escrow: null } });
    }
    case "bound": {
      if (record.binding === null) return { kind: "refused", reason: "no deployment is pinned" };
      if (record.binding.escrow !== null) return sameJson(record.binding.escrow, event.escrow) ? { kind: "same" } : held(record, at, "binding-conflict", "a second, different chain game was offered for this money game");
      const pin = record.binding.deployment;
      const e = event.escrow;
      const deployment = e.deployment as { kind: string; contract_address?: string; code_checksum?: string };
      const agrees =
        e.backend === pin.backend &&
        e.codec === pin.codec &&
        e.network.chain_id === pin.chain_id &&
        e.network.network_class === pin.network_class &&
        deployment.kind === pin.backend &&
        deployment.contract_address === pin.contract_address &&
        deployment.code_checksum === pin.code_checksum &&
        e.asset.denom === pin.denom;
      if (!agrees) return held(record, at, "binding-mismatch", "the chain game is not on the deployment this money game is pinned to");
      if (record.phase !== "funding") return { kind: "refused", reason: "a chain game is bound only before the deal" };
      return patched(record, at, { binding: { ...record.binding, escrow: e } });
    }
    case "roster-frozen": {
      if (record.roster !== null) return sameJson(record.roster, event.freeze) ? { kind: "same" } : held(record, at, "binding-conflict", "a second, different financial roster was offered");
      if (record.binding?.escrow === null || record.binding === null) return { kind: "refused", reason: "no chain game is bound" };
      if (record.phase !== "funding" || record.chain.started !== null) return { kind: "refused", reason: "the roster freezes before the deal" };
      const epoch = record.roster_epoch + 1;
      return moved(record, "funding", at, `roster frozen (epoch ${epoch}, ${event.freeze.roster.length} seats); the Start is prepared`, { roster: event.freeze, roster_epoch: epoch });
    }
    case "roster-released": {
      /* Idempotent after a crash: this epoch's freeze is already released. */
      if (record.roster === null) return event.epoch === record.roster_epoch && record.phase === "funding" ? { kind: "same" } : { kind: "refused", reason: "no roster is frozen" };
      if (record.phase !== "funding" || record.chain.started !== null) return { kind: "refused", reason: "a Start the chain confirmed makes the freeze permanent" };
      if (event.epoch !== record.roster_epoch || event.roster_hash !== record.roster.roster_hash) return { kind: "refused", reason: `the release names epoch ${event.epoch}; the frozen roster is epoch ${record.roster_epoch}` };
      return moved(record, "funding", at, `roster released (epoch ${event.epoch}): ${event.why}`.slice(0, 300), { roster: null });
    }
    /* ---------------- ESCROW-3B: chain observations ---------------- */
    case "chain-started": {
      if (record.roster === null) return { kind: "refused", reason: "no roster is frozen" };
      if (event.domain !== record.roster.expected_domain) return held(record, at, "chain-inconsistent", "the chain froze a domain that is not the frozen roster's");
      if (record.chain.started !== null) return record.chain.started.domain === event.domain ? { kind: "same" } : held(record, at, "chain-inconsistent", "the chain reports a second start");
      return patched(record, at, { chain: { ...record.chain, started: { height: event.height, domain: event.domain, at } } });
    }
    case "checkpoint-prepared": {
      const current = record.chain.checkpoint_prepared;
      if (current !== null && BigInt(current.seq) >= BigInt(event.seq)) return { kind: "same" };
      return patched(record, at, { chain: { ...record.chain, checkpoint_prepared: { seq: event.seq, log_len: event.log_len, round_key: event.round_key, intent_id: event.intent_id } } });
    }
    case "checkpoint-confirmed": {
      const current = record.chain.checkpoint_confirmed;
      if (current !== null && BigInt(current.seq) >= BigInt(event.seq)) return { kind: "same" };
      return patched(record, at, { chain: { ...record.chain, checkpoint_confirmed: { seq: event.seq, log_len: event.log_len, at } } });
    }
    case "chain-settleable": {
      if (record.phase === "settleable" || record.phase === "disputed" || record.phase === "closed") return { kind: "same" };
      if (record.phase !== "intent-prepared") return { kind: "refused", reason: `a ${record.phase} game has no settlement to confirm` };
      return moved(record, "settleable", at, `the terminal settlement (seq ${event.seq}) is on chain; its challenge window is open`, {
        chain: { ...record.chain, settle_confirmed: { seq: event.seq, window_end_secs: event.window_end_secs, at } },
      });
    }
    case "chain-disputed":
      if (record.phase === "disputed" || record.phase === "closed") return { kind: "same" };
      if (record.phase !== "settleable") return { kind: "refused", reason: `a ${record.phase} game has no stored settlement to dispute` };
      return moved(record, "disputed", at, "a seat challenged the stored settlement (the resolver decides)");
    case "chain-closed": {
      if (record.phase === "closed") return { kind: "same" };
      if (record.phase === "cancelled") return { kind: "same" };
      if (record.phase === "funding" && record.chain.started === null) {
        /* Before Start the table's own lifecycle speaks (cancel-before-deal); the chain's refunds are its own. */
        return event.state === "CANCELLED" ? moved(record, "cancelled", at, `the escrow was cancelled on chain before the deal (${event.route})`) : { kind: "same" };
      }
      /* ESCROW-3B (review 2 #3): an escrow that STARTED is closed by the chain whatever the table did (a started game
         that was never dealt, then refunded by a liveness exit or annulled, is closed -- never left funding forever). */
      const outcome: FinancialChainOutcome = { state: event.state, route: event.route, observed_at: at };
      if (record.phase === "held") return { kind: "moved", next: { ...record, chain_outcome: outcome, record_version: record.record_version + 1, updated_at: at } };
      return moved(record, "closed", at, `the escrow is ${event.state} on chain (${event.route})`, { chain_outcome: outcome });
    }
    default:
      return { kind: "refused", reason: "unknown event" };
  }
}

/* ------------------------------------------------------------------ */
/* What the server may do, by phase (the policy ESCROW-3B/4 consume)   */
/* ------------------------------------------------------------------ */

export type MoneyAction =
  | "finalize"
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
  const post = (DEALT_PHASES.includes(phase) && phase !== "closed") || phase === "held";
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
      return phase === "in-progress" || phase === "liveness" || phase === "terminal-eligible" || phase === "intent-prepared"
        ? { allowed: true, means: "ESCROW-3B posts a signed checkpoint (the deal, each completed round boundary, the terminal seal)" }
        : { allowed: false, means: "checkpoints are posted while the escrow is in progress" };
    case "finalize":
      return phase === "settleable" ? { allowed: true, means: "after the challenge window, the relayer Finalizes: the stored settlement pays out" } : { allowed: false, means: "only a stored, unchallenged settlement is finalized" };
    case "annul-by-consent":
      /* ESCROW-4 (preflight A-8): the contract verifies each seat's CONSENT KEY over ANNUL(domain, trusted_seq), not its wallet. */
      return { allowed: post, means: "every seat's consent key signs; net antes return (unanimity: no single player can force it)" };
    case "liveness-settle":
      return { allowed: post, means: "a seat's wallet may exit after the contract's window: the best trusted checkpoint is promoted (a refund only if none was ever posted)" };
    case "server-refund":
    case "seat-transfer":
      return { allowed: false, means: action === "seat-transfer" ? "there is no seat transfer or rebind primitive" : POST_DEAL_REFUSAL };
    default:
      return { allowed: false, means: "unknown action" };
  }
}
