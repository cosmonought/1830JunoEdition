// frontend/src/utils/clockProtocol.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: THE TABLE CLOCK ON THE WIRE (`RoomView.clock`) AND ITS ROOM OPS
// ==================================================================
//
// PURE: types, constants and the copy the owner fixed -- no socket, no storage, no window. The SERVER owns the clock
// (`server/src/rooms/clock/`): it times the human who owes the next required decision (`clockResponsibility.ts`), keeps
// the durable clock record inside the game's own serialization, decides overdue / cure / finality / foreclosure, and
// projects this view into every `RoomView` (optional and additive: absent before a table has a clock and from an
// older server). The browser only PRESENTS it.
//
// THE POLICY (owner, 2026-10-06; escrow 2.1.0 / financial protocol 4):
//   Live         20:00 per REQUIRED action (never per turn); an accepted action refreshes the allowance of whoever owes
//                the next one. A valid inter-player offer that puts its proposer in a waiting state (a train offer,
//                and -- owner, 2026-10-06 -- every other offer that suspends the proposer's own required action)
//                gives the recipient a distinct 10:00 to respond (never an overdue timer) and freezes the proposer's
//                clock -- but only within the action's FREEZE BUDGET (owner, 2026-10-07): each fresh Live
//                required-action episode includes at most 10 minutes TOTAL of optional inter-player offer freeze
//                protection; once it is used up, further offers stay legal but the proposer's clock keeps running
//                (`trade.proposerFreezeMs`, `freezeBudgetMs`). Accepted, rejected, expired, countered or withdrawn, a
//                proposer still owing the same decision resumes its remainder, less any wait beyond the budget; nothing
//                renews the budget but a new episode. Two declines
//                (rejections or expiries) per direction per ROUND INSTANCE (each operating sub-round -- OR 2.1 and
//                OR 2.2 are separate -- or Stock Round instance), Live only. No count of offers and no history
//                length ever limits them. Timed Async: an offer's proposer's deadline keeps running (`running`). At 20:00 the seat is OVERDUE: the first and second may cure until
//                30:00; the N-1 foreclosure vote only decides the minute-30 outcome (neutral timeout annulment
//                otherwise); the third expiry forecloses at once (challengeable money). Voluntary pause and resume:
//                unanimous. A server continuity break while the game is still playable: SYSTEM PAUSE, unanimous
//                resume, outage time never charged. Once the game has ended (a remedy sealed), there is nothing to
//                resume: the sealed remedy is carried on without any vote.
//   Timed Async  12 h / 24 h / 2 d / 3 d / 7 d per required action, fixed at the deal; expiry is OVERDUE only (no money
//                moves, no grace timer); the other N-1 may unanimously propose neutral annulment or foreclosure. Offers
//                follow the ordinary responsibility model: no 10:00 response timer, no decline limit.
//   No-deadline  no clock, no overdue; it ends by completion, unanimous annulment or the exceptional review.
//
// WHAT THE BROWSER MAY BELIEVE. The numbers are the server's, computed at `serverNow`. The browser counts on from them
// with a MONOTONIC delta since it received the view, never by comparing its own wall clock with the server's; a tab
// that is not current shows no figure. Eligibility for any remedy is decided by the server and the chain -- never by
// this countdown.

import type { RequiredDecisionKind } from "../gameEngine/clockResponsibility";

/** The table's deadline class (fixed once play begins). */
export type ClockDeadlineClass = "live" | "async-pace" | "no-deadline";

/** Timed Async paces the host may choose (seconds): 12 h, 24 h, 2 d, 3 d, 7 d -- escrow 2.1.0's `ASYNC_PACES_SECS`. */
export const CLOCK_ASYNC_PACES_SECS: readonly number[] = Object.freeze([43_200, 86_400, 172_800, 259_200, 604_800]);
export const CLOCK_LIVE_ACTION_MS = 20 * 60_000;
export const CLOCK_LIVE_CURE_MS = 10 * 60_000;
export const CLOCK_LIVE_TRADE_MS = 10 * 60_000;
export const CLOCK_LIVE_DECLINES_PER_ROUND_INSTANCE = 2;
export const CLOCK_LIVE_FREE_OVERDUES = 2;

/** One countdown as the server computed it at `serverNow`. */
export interface ClockTimerView {
  readonly remainingMs: number;
  /** Counting down now (false: frozen -- a train offer, a pause, a system pause). */
  readonly running: boolean;
}

export type ClockTableState =
  /** Before play: the deadline class may still change (host). */
  | "setup"
  /** The responsible human's clock (or Async allowance, or no deadline) runs. */
  | "running"
  /** Live: a train offer awaits its answer (the proposer's clock is paused). */
  | "trade"
  /** A seat is OVERDUE (Live: interrupted until cure or minute 30; Async: until cure or N-1 remedy). */
  | "overdue"
  /** Unanimously paused by the players. */
  | "paused"
  /** Paused by the server because its continuity was interrupted; unanimous resume. */
  | "system-paused"
  /** Gameplay ended (the game's own end, or a remedy). */
  | "ended";

export type ClockEndKind =
  | "game-end"
  | "room-closed"
  | "live-timeout-annul"
  | "live-foreclosure"
  | "live-strike3-foreclosure"
  | "async-annul"
  | "async-foreclosure"
  | "annulled"
  | "escrow-ended";

export type ClockProposalKind = "foreclose" | "annul";

export interface ClockProposalView {
  readonly id: number;
  readonly kind: ClockProposalKind;
  readonly by: string;
  readonly yes: readonly string[];
  readonly no: readonly string[];
  /** The non-defaulting seats whose YES is needed (N-1). */
  readonly needed: readonly string[];
  /** Every N-1 YES is in (Live: the minute-30 outcome is foreclosure unless the seat cures first). */
  readonly complete: boolean;
}

export interface ClockOverdueView {
  readonly seat: string;
  /** Live: the seat's ordinary overdue count (1, 2 or 3); Async: 0. */
  readonly strike: number;
  readonly epoch: number;
  readonly overdueAt: number;
  /** The stalled log position and its hash (what an N-1 REMEDY-APPROVE binds, with the epoch and the overdue moment). */
  readonly logLen: number;
  readonly logHash: string;
  /** Live strikes 1-2: the time left to the minute-30 finality (frozen while paused). Absent for Async (no automatic
   *  outcome) and for a third strike (no cure window). */
  readonly finality: ClockTimerView | null;
  /** Live strikes 1-2: what happens at finality if the seat does not cure (`foreclosure` only with complete N-1). */
  readonly outcomeIfUncured: "timeout-annul" | "foreclosure" | null;
  /** The decision the seat must make to cure (what it owes). */
  readonly cure: RequiredDecisionKind;
  readonly proposal: ClockProposalView | null;
}

export interface ClockPauseView {
  readonly paused: boolean;
  /** A pending unanimous request (pause, or resume), or `null`. */
  readonly request: { readonly kind: "pause" | "resume"; readonly id: number; readonly by: string; readonly yes: readonly string[]; readonly needed: readonly string[] } | null;
}

/** Money tables: the sealed remedy decision's progress, and (N-1 remedies) the seats whose approvals were not valid at
 *  the decision's own final moment -- the sealed decision is then held unchanged for an owner decision (never
 *  converted, never re-voted). An approval valid at that moment lands however late (owner ruling, 2026-10-07). */
export interface ClockRemedyView {
  readonly kind: number;
  readonly status: string;
  readonly stale: readonly string[];
  readonly overdue: Pick<ClockOverdueView, "seat" | "strike" | "epoch" | "overdueAt" | "logLen" | "logHash">;
}

export interface ClockSystemPauseView {
  readonly since: number;
  /** The last instant the server could prove it was in continuous control (the timers shown are as of then). */
  readonly preservedAt: number;
  readonly yes: readonly string[];
  readonly needed: readonly string[];
}

export interface RoomClockView {
  readonly v: 2;
  readonly deadline: ClockDeadlineClass;
  readonly paceSecs: number | null;
  readonly policyFrozen: boolean;
  readonly money: boolean;
  readonly state: ClockTableState;
  /** The server's clock when it computed this view (ms). */
  readonly serverNow: number;
  readonly revision: number;
  /** Who owes the next required decision (the server's derivation), or `null`. */
  readonly responsible: { readonly seat: string; readonly kind: RequiredDecisionKind } | null;
  /** The responsible human's ordinary clock (Live 20:00 or the Async pace); `null`: No-deadline, a trade (see
   *  `trade`), or nobody responsible. */
  readonly action: ClockTimerView | null;
  /** Live: an offer awaiting its answer on the 10:00 response timer (a train offer, or any offer that suspends its
   *  proposer's own required action). */
  readonly trade: {
    readonly proposer: string;
    readonly recipient: string;
    readonly respond: ClockTimerView;
    /** The proposer's own action clock as of `serverNow`: frozen while its episode's freeze budget lasts, then counting
     *  down with the response timer (owner ruling, 2026-10-07). */
    readonly proposerRemainingMs: number;
    /** The proposer's optional-offer freeze budget left as of `serverNow` (absent from an older server: treat as frozen). */
    readonly proposerFreezeMs?: number;
    /** The offer's kind (absent: a train offer). */
    readonly kind?: "train" | "private" | "trade" | "funding";
  } | null;
  /** LIVE: the responsible seat's optional-offer FREEZE BUDGET left in this required-action episode (at most 10:00 in
   *  all, across every qualifying offer, renewed only by a new episode); `null` / absent otherwise. */
  readonly freezeBudgetMs?: number | null;
  /** TIMED ASYNC: a seat whose required action an offer suspended -- its own deadline keeps RUNNING while the offer is
   *  answered (owner, 2026-10-07: optional negotiation never refreshes, nor stops, an Async deadline). Absent or empty
   *  otherwise (a Live proposer's clock is frozen: `trade.proposerRemainingMs`). */
  readonly running?: readonly { readonly seat: string; readonly remainingMs: number }[];
  readonly overdue: ClockOverdueView | null;
  /** Live: each seat's ordinary overdue count in this game. */
  readonly strikes: Readonly<Record<string, number>>;
  readonly pause: ClockPauseView;
  readonly system: ClockSystemPauseView | null;
  readonly ended: { readonly kind: ClockEndKind; readonly at: number; readonly seat: string | null } | null;
  /** Money tables: the financial remedy's progress (the chain decides the money). */
  readonly remedy: ClockRemedyView | null;
  /** Live: the offer declines of the current ROUND INSTANCE (this operating sub-round -- OR 2.1 and OR 2.2 are two --
   *  or this Stock Round), per direction (Async keeps none). */
  readonly declines: readonly { readonly from: string; readonly to: string; readonly count: number }[];
  /** A free table's unanimous annulment in progress (a money table's runs through its escrow). */
  readonly annul: { readonly yes: readonly string[]; readonly needed: readonly string[] } | null;
  /** No-deadline money tables: the players who acknowledged the no-deadline lock before their ante. */
  readonly noDeadlineAcks: readonly string[];
  /** The seated players (unanimity is over these). */
  readonly seats: readonly string[];
}

/* ---- room ops (closed bodies; `messageSchema.ts` checks every one) ---- */

export const CLOCK_OPS = Object.freeze({
  /** Host, before play: the deadline class (`live` tables are always Live). */
  policy: "clock-policy",
  /** Any seated player: request a unanimous pause / resume, or answer the standing request. */
  pause: "clock-pause",
  /** Any seated player: vote to resume after a system pause. */
  systemResume: "clock-sysresume",
  /** A non-defaulting seated player: propose an N-1 remedy against the overdue seat. */
  propose: "clock-propose",
  /** A non-defaulting seated player: YES / NO on the standing proposal (money YES carries a REMEDY-APPROVE). */
  vote: "clock-vote",
  /** A free table's unanimous neutral annulment (a money table annuls through its escrow). */
  annul: "clock-annul",
  /** No-deadline money tables: acknowledge the indefinite-lock disclosure before the ante. */
  ackNoDeadline: "clock-ack",
} as const);

/** The owner's No-deadline disclosure, shown conspicuously before the ante (and persisted per player per table). */
export const NO_DEADLINE_DISCLOSURE =
  "This game has no action deadline. If it does not finish and all players do not agree to annul it, your escrowed funds may remain locked indefinitely.";

/** The owner's train-offer limit copy (never misconduct, never punishment). */
export const declinesReachedSentence = (recipientName: string): string => `${recipientName} has declined two train offers from you this operating round.`;

/** The owner's system-pause copy. */
export const SYSTEM_PAUSE_SENTENCE = "Game paused because server continuity was interrupted.";
export const SYSTEM_PAUSE_RESUME_SENTENCE = "All players must agree to resume.";

/** The owner's second-strike warning. */
export const STRIKE_TWO_WARNING = "Next action-clock expiry results in automatic foreclosure.";

/** Refusal codes the clock gate answers a submit or a room op with. */
export const CLOCK_REFUSAL = Object.freeze({
  paused: "clock-paused",
  systemPaused: "clock-system-paused",
  interrupted: "clock-interrupted",
  ended: "clock-ended",
  declines: "trade-declines",
  undoFence: "undo-fenced",
  stale: "clock-stale",
  unavailable: "clock-unavailable",
} as const);
