// frontend/src/utils/mhQueuedExchange.ts
//
// ==================================================================
//  PHASE 3 W2-E (U-35 iv, K-17; owner ruling OD-3): A QUEUED M&H EXCHANGE IS NOT AN EXECUTED ONE
// ==================================================================
//
// REPORTED (K-17): a queued M&H exchange was narrated as executed -- "...exchanged the M&H... The private company
// closes." -- while the board still showed the M&H open and owned. Nothing in the UI read `pending_mh_exchange`.
//
// OWNER RULING OD-3:
//   - the log says REQUESTED when `pending_mh_exchange` is created;
//   - the log says EXECUTED only when the exchange actually occurs (at once on the owner's own Stock Round turn,
//     or later, when the reducer settles the queued request at a between-turns boundary);
//   - the M&H's table and power indicator stay visibly pending while it is queued;
//   - the requester is told it is queued;
//   - a request that later becomes impossible gets one generic, truthful line. The engine is NOT changed to
//     record a forensic cancellation reason.
//
// THE STATE AUTHORITY IS `pending_mh_exchange` (gameState.ts, design note #1630; written by
// `withPendingMhExchange`, cleared by `settleMhExchange`). Everything here is a READ of that record and of the two
// boards either side of an action -- the same "two settled states, one comparison" shape `describeFloat` uses.
// No rule is restated: whether a request is legal, executes now or queues, and whether it survives settlement are
// all `mohawkExchange.ts`'s questions, asked by the reducer, and this module only reports which answer the board
// shows.
//
// W1-C IS PRESERVED BY CONSTRUCTION. The source named in every sentence is the pile recorded on the request (the
// owner's choice, ruling R2); nothing here picks, defaults or substitutes a pile, and the legality of a NEW request
// is still `mhExchangeRequestRefusal`'s alone (through `mhExchangeRequestFor`).

import type { GameStateResponse, PendingMhExchange } from "../gameEngine/gameState";
import { privateAcronym } from "./privateCatalog";
import { exchangeSourceLabel } from "./privatePowerFlow";

/* ==================================================================
    PHASE 3 W3-J (AUD-25.10 (d)): THE M&H STATUS SAYS "REQUESTED", NOT "QUEUED"
   ==================================================================
   "Queued" meant two things on one screen: these M&H status lines ("is queued, not executed") and the W3-I link
   note (`LINK_QUEUED_NOTE`, "Queued — will send on reconnect." -- a press waiting for a socket). OD-3's vocabulary
   for the M&H is "requested" / "executed" with a generic "expired", so the toast, the marker / chip sentence and the
   REQUESTED log line now say "requested, not executed yet" and keep their meaning (the turn-boundary condition, the
   nothing-reserved clause) and the generic expiry word for word. The link note is the one "Queued" status line.
   Rules Reference copy and the private catalogue's rules text are rules, not status, and are not changed here. The
   module and function names keep "queued": they are code, not copy. */

/** OD-3's generic cancellation line. Deliberately carries no reason: the engine retires an impossible request
 *  without recording why (design note #1630e), and a guessed reason would be a second rules engine. */
export const MH_EXCHANGE_EXPIRED_SENTENCE = "M&H exchange request expired before it could execute.";

type NameFor = (address: string) => string;

/** The standing request, or `null`. Absent and `null` mean the same thing (#232; gameState.ts). */
export function pendingMhExchangeOf(state: GameStateResponse | null | undefined): PendingMhExchange | null {
  return state?.pending_mh_exchange ?? null;
}

function privateName(state: GameStateResponse | null | undefined, privateId: number): string {
  return state?.private_companies.find((row) => row.private_id === privateId)?.name ?? "private company";
}

function tickerOf(state: GameStateResponse | null | undefined, companyId: number): string {
  return state?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ?? `Corporation #${companyId}`;
}

function heldPercent(state: GameStateResponse | null | undefined, companyId: number, player: string): number {
  const company = state?.public_companies.find((entry) => entry.company_id === companyId);
  return (company?.player_holdings ?? [])
    .filter((entry) => entry.player === player)
    .reduce((sum, entry) => sum + entry.percentage, 0);
}

function isClosed(state: GameStateResponse | null | undefined, privateId: number): boolean {
  return state?.private_companies.find((row) => row.private_id === privateId)?.closed === true;
}

/** "a 10% share of NYC from the IPO" -- the pile is the REQUEST's, never inferred (R2). */
function exchangeClause(state: GameStateResponse | null | undefined, pending: PendingMhExchange): string {
  return `the ${privateName(state, pending.private_id)} for a 10% share of ${tickerOf(state, pending.company_id)} from the ${exchangeSourceLabel(pending.source)}`;
}

/** The REQUESTED line: the request was recorded and nothing else happened. */
export function mhExchangeRequestedSentence(
  state: GameStateResponse | null | undefined,
  pending: PendingMhExchange,
  nameFor: NameFor,
): string {
  return (
    `M&H exchange REQUESTED — ${nameFor(pending.player)} asked to exchange ${exchangeClause(state, pending)}. ` +
    "It is requested, not executed yet — it executes at the next turn boundary only if it is still legal then."
  );
}

/** The EXECUTED line: the certificate moved and the M&H closed. One sentence for both the immediate exchange and
 *  a queued one that settled, so the two read identically. */
export function mhExchangeExecutedSentence(
  state: GameStateResponse | null | undefined,
  pending: PendingMhExchange,
  nameFor: NameFor,
): string {
  return (
    `M&H exchange EXECUTED — ${nameFor(pending.player)} exchanged ${exchangeClause(state, pending)}. ` +
    "The private company closes."
  );
}

/** What a dispatched `ExchangePrivate` (M&H, not the C&A's `keep_open` grant) did, read from the two boards.
 *
 *  - `requested`: the action CREATED `pending_mh_exchange` for this player and private (it was absent before);
 *  - `executed`: the M&H was open before and is closed after -- the exchange happened in this action;
 *  - `unknown`: neither -- a refused request (the board is unchanged), or a caller with no after-board (the
 *    retired live-chain path). The caller then states only that a request was made. */
export type MhExchangeDispatchOutcome = "requested" | "executed" | "unknown";

export function mhExchangeDispatchOutcome(
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
  request: { private_id: number; player: string },
): MhExchangeDispatchOutcome {
  if (!after) return "unknown";
  const created = pendingMhExchangeOf(after);
  if (
    pendingMhExchangeOf(before) === null &&
    created !== null &&
    created.player === request.player &&
    created.private_id === request.private_id
  ) {
    return "requested";
  }
  if (!isClosed(before, request.private_id) && isClosed(after, request.private_id)) return "executed";
  return "unknown";
}

/** How a standing request left the board in this action, or `null` when none was settled here.
 *
 *  A request is settled when `pending_mh_exchange` stood BEFORE the action and is gone AFTER it (the reducer's
 *  `settleMhExchange` clears it whether it executes or retires). It EXECUTED when the requester's holding in the
 *  named corporation rose by the exchanged 10% and the M&H closed; otherwise it was RETIRED -- the chosen pile
 *  emptied, the M&H closed with the first 5-train or changed hands, a limit now binds -- and OD-3 says to report
 *  that generically rather than guess which. A `RevertTo` never reaches a caller of this (the shell returns before
 *  narrating it), so an undo past a request is not misread as an expiry. */
export type MhSettlementOutcome =
  | { kind: "executed"; pending: PendingMhExchange }
  | { kind: "expired"; pending: PendingMhExchange };

export function mhSettlementOutcome(
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
): MhSettlementOutcome | null {
  const pending = pendingMhExchangeOf(before);
  if (pending === null || !after || pendingMhExchangeOf(after) !== null) return null;
  const closedHere = !isClosed(before, pending.private_id) && isClosed(after, pending.private_id);
  const received =
    heldPercent(after, pending.company_id, pending.player) - heldPercent(before, pending.company_id, pending.player) >= 10;
  return closedHere && received ? { kind: "executed", pending } : { kind: "expired", pending };
}

/** The Activity Log line for a settlement, or `null`. */
export function mhSettlementSentence(
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
  nameFor: NameFor,
): string | null {
  const outcome = mhSettlementOutcome(before, after);
  if (outcome === null) return null;
  return outcome.kind === "executed"
    ? mhExchangeExecutedSentence(before, outcome.pending, nameFor)
    : `${nameFor(outcome.pending.player)}'s ${MH_EXCHANGE_EXPIRED_SENTENCE}`;
}

/** The requester's acknowledgement, when THIS action queued THEIR request; otherwise `null`. */
export function mhQueuedAcknowledgement(
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
  viewerAddress: string | null | undefined,
): string | null {
  if (!viewerAddress) return null;
  const created = pendingMhExchangeOf(after);
  if (created === null || pendingMhExchangeOf(before) !== null || created.player !== viewerAddress) return null;
  return (
    `Your M&H exchange request (a 10% ${tickerOf(after, created.company_id)} share from the ` +
    `${exchangeSourceLabel(created.source)}) is requested, not executed yet. It executes at the next turn boundary only ` +
    "if it is still legal then; nothing is reserved until it does."
  );
}

/** What every surface shows while a request stands: a short marker and the sentence behind it. */
export interface PendingMhExchangeView {
  privateId: number;
  requester: string;
  /** For the private's row on the table: a few words. */
  marker: string;
  /** The full sentence, for a title and for the power chip's blocked reason. */
  sentence: string;
  /** The power chip's label while the request stands. */
  chipLabel: string;
}

export function pendingMhExchangeView(
  state: GameStateResponse | null | undefined,
  nameFor: NameFor,
): PendingMhExchangeView | null {
  const pending = pendingMhExchangeOf(state);
  if (pending === null) return null;
  const acronym = privateAcronym(pending.private_id) ?? "MH";
  return {
    privateId: pending.private_id,
    requester: pending.player,
    marker: "Exchange requested — pending",
    sentence:
      `${nameFor(pending.player)} has requested to exchange ${exchangeClause(state, pending)}. ` +
      "Requested, not executed yet — it executes at the next turn boundary only if it is still legal then.",
    chipLabel: `${acronym} exchange pending`,
  };
}

/** The power chips with the M&H's shown as pending while a request stands. Greyed with the pending sentence:
 *  a second request would be refused by `mhExchangeRequestRefusal` ("already pending"), so the chip says why
 *  before the click rather than after it. Other chips, and every chip when nothing is pending, are untouched. */
export function withPendingMhExchangeChip<T extends { abilityKey: string; chipLabel: string }>(
  offers: readonly T[],
  view: PendingMhExchangeView | null,
): readonly (T & { blockedReason?: string | null })[] {
  if (view === null) return offers;
  return offers.map((offer): T & { blockedReason?: string | null } =>
    offer.abilityKey === "mh-exchange"
      ? { ...offer, chipLabel: view.chipLabel, blockedReason: view.sentence }
      : offer,
  );
}
