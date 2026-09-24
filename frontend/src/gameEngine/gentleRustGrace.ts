// frontend/src/gameEngine/gentleRustGrace.ts
//
// Which Operating Turn a Gentle Rust reprieve is owed, and which reprieves the current turn may spend (GR-1,
// DN 1699); and which owned copies no reprieve covers, the only ones a sale or a Diesel trade-in may move (GR-2,
// DN 1700, at the end of this file).
//
// ==================================================================
//  DESIGN NOTE 1699 (GR-1): THE GRACE TURN BEGINS AFTER THE DOOM
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` (rev 2, owner spec review SR-1 ... SR-6), clauses
// GR-S9, GR-S15, GR-S16, GR-S17, GR-S18, GR-S19, GR-S22, GR-S23. Where an older note in `sandboxSession.ts`
// (#906, #906a, #1001) describes the death as "the end of the corporation's turn", this note supersedes it.
//
// THE ENTITLEMENT IS ONE OPERATING TURN THAT BEGINS AFTER THE TRAIN BECAME DOOMED -- a turn, not a guaranteed
// run (GR-S17). "Its next turn" can only mean a turn that has not started yet when the doom happens: a turn
// already under way when the phase changes was not granted by the reprieve, it was simply in progress. So:
//   (A) a rival triggers the rust before this corporation has operated in the round -> its later turn in the
//       SAME round is the grace turn;
//   (B) a rival triggers it after this corporation operated -> its next turn in a LATER round;
//   (C) the corporation triggers it itself, buying the phase-changing train in its own Buy Trains step -> its
//       CURRENT turn began before the doom, so it is not the grace turn; the trains survive the turn's end
//       and are owed the corporation's NEXT turn;
//   (D) the self-trigger ends the Operating Round set -> they survive the Stock Round to that next turn;
//   (E) a one-corporation round is no different -- leaving the round does not spend a reprieve whose turn
//       has not begun.
// (A), (B), (D)-for-rivals and (E)-for-older-marks were already right before GR-1. (C), and (D)/(E) for the
// buyer's own trains, were the defect IG-A: both turn-end fallbacks expired every mark of the outgoing
// corporation, including marks written by its own Buy Trains step a moment earlier.
//
// WHY THE SELF-TRIGGER CANNOT EXPIRE IN THE SAME TURN. The normal destruction point is the end of Run Routes
// (the cursor entering Dividends, #1102), and a self-trigger happens at Buy Trains, AFTER that point: the
// doomed train has had no opportunity to operate since it was doomed. Expiring it at this turn's end -- the
// fallback -- would turn the reprieve into an immediate rust that merely waits for the End Turn button.
//
// ------------------------------------------------------------------
//  THE REPRESENTATION: ONE TURN-SCOPED LIST, `pending_rust_doomed_this_turn`
// ------------------------------------------------------------------
// A corporation's marks (`pending_rust_trains`, a multiset by model, #1032) fall into exactly two groups:
//   - marks written while this corporation's own turn was in progress (only possible for the corporation
//     that is operating: it is the one buying), which are owed its NEXT turn; and
//   - every other mark, which is owed the corporation's current turn if it is operating, or its next turn if
//     it is not.
// The second group needs no record. Every mark written before a turn began is spent by the end of that turn
// (at Run Routes, or by the fallback), so a mark still standing when a turn starts is by construction owed
// THAT turn -- however many phase changes wrote it (GR-S25) and however many rounds or Stock Rounds passed.
// Only the first group has to be remembered, and only until the turn it was written in ends. So:
//   * `applyPhaseChange` appends a newly written mark to `pending_rust_doomed_this_turn` as well, when -- and
//     only when -- the corporation it marks is the one whose Operating Turn is in progress;
//   * the Run Routes expiry and both turn-end fallbacks spend only `graceTurnReprieves` (the marks MINUS that
//     list, multiset);
//   * when the corporation's turn ends (a turn change, or leaving the Operating Round -- the same two
//     boundaries the fallback already used), the list is dropped: its marks are now owed the next turn.
// Sub-multiset invariant: `pending_rust_doomed_this_turn` <= `pending_rust_trains` <= `owned_trains`.
//
// WHY THIS IS SUFFICIENT AND REPLAY-DETERMINISTIC. The list is written and cleared only by the reducer, from
// the logged message and the board's own Operating cursor (`operatingCorporationId`, the lookup every other
// gate uses) -- no UI state, no clock, no narration. Undo rebuilds by replaying the log, and replay applies the
// same messages to the same boards, so it writes and clears the same list at the same entries. It needs no
// train-instance identity: like the marks themselves it is a multiset of models, and every reader walks it by
// multiset. It survives an OR-set boundary because the boundary IS the turn end that drops it -- a mark written
// in the last turn of a set is plain `pending_rust_trains` through the Stock Round, owed the corporation's first
// turn of the next set. And it composes with repeated phase applications: `applyPhaseChange` only appends for a
// train it newly marks, so a re-applied tier (#1032) adds nothing to either list.
// ABSENT, NOT EMPTY, when there is nothing to say (#232): the field exists only between a self-trigger and the
// end of that turn, so no board outside that window -- and no board of any standard game -- carries it.
//
// ------------------------------------------------------------------
//  EXEMPT FROM THE TRAIN LIMIT != ABSENT FROM THE FLEET (SR-1, SR-2)
// ------------------------------------------------------------------
// A reprieved train stays in `owned_trains`. It does not occupy a train-limit slot -- that is the capacity
// question, answered only by `countableTrainCount` (#1034) and its callers (purchase gates, the Buy-Trains
// auto-skip, the excess-discard obligation, capacity displays). It DOES count as a train the corporation owns
// -- the trainlessness / forced-purchase question (`trainObligationFor`, `emergencyFundingFor`, the End-Turn
// gate, the route roster), which every reader answers from raw `owned_trains`. The two are separate predicates
// on purpose; the capacity count must never be reused as "owns a train". One purpose of the variant is to
// buffer a corporation from an emergency purchase the moment its trains rust (SR-3).
//
// WHY A FORCED PURCHASE CAN START ONLY AFTER ACTUAL DESTRUCTION. Until the reprieved trains leave `owned_trains`
// the corporation owns trains, so rulebook 6.6.2 has nothing to say about it. They leave at the end of Run
// Routes in the qualifying turn, which is before that turn's Buy Trains step; if nothing else is left, the
// ordinary obligation is then evaluated at Buy Trains exactly as for any trainless corporation. There is no
// Gentle Rust purchase rule, and none is needed: the ordinary rule applies once ownership actually reaches zero.

import { operatingCorporationId } from "./dividendGate";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

type Reprieved = Pick<PublicCompanyState, "pending_rust_trains" | "pending_rust_doomed_this_turn">;

/** The corporation whose Operating Turn is in progress, or `null` (no Operating Round, or a cursor the board
 *  cannot resolve). The same lookup every gate uses (`operatingCorporationId`); guarded for a board that has
 *  no queue at all, which a partial state handed to `applyPhaseChange` may be. */
export function corporationInItsTurn(state: GameStateResponse): number | null {
  if (state.active_operating_order == null) return null;
  return operatingCorporationId(state);
}

/** The marks written during the corporation's own current Operating Turn -- owed its NEXT turn, never this
 *  one. Empty for every corporation outside the window between a self-trigger and the end of that turn. */
export function reprievesDoomedThisTurn(company: Reprieved): readonly string[] {
  return company.pending_rust_doomed_this_turn ?? [];
}

/** The marks this corporation's current (or, when it is not operating, next) Operating Turn is the qualifying
 *  grace turn for: every mark except those written during its own turn in progress. Multiset: two marked
 *  2-trains of which one was doomed this turn leave exactly one here. */
export function graceTurnReprieves(company: Reprieved): string[] {
  const owed = [...(company.pending_rust_trains ?? [])];
  for (const model of reprievesDoomedThisTurn(company)) {
    const at = owed.indexOf(model);
    if (at >= 0) owed.splice(at, 1);
  }
  return owed;
}

// ==================================================================
//  DESIGN NOTE 1700 (GR-2): A REPRIEVED TRAIN STAYS WHERE THE RUST FOUND IT
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` rev 2, owner rulings SR-7 (a)-(c) -- OD-GR-1 and
// OD-GR-2 -- clauses GR-S3, GR-S12, GR-S13, GR-S24.
//   OD-GR-1: a pending-rust / reprieved train MAY NOT BE SOLD OR OTHERWISE TRANSFERRED to another corporation.
//            Its reprieve belongs to the corporation that owned it at the rust event; it stays there through its
//            qualifying grace turn and is then removed. The mark never follows a train to a buyer.
//   OD-GR-2: a reprieved train MAY NOT BE A DIESEL TRADE-IN -- neither at the $800 exchange nor at the Level
//            Playing Field's $750. It gives no credit and never reaches the Bank Pool through an exchange.
// Both are the one principle of SR-7 (c): a reprieved train may not escape or monetize its destruction by
// changing hands. Before GR-2 both transactions were open (probes P6, P9): the buyer received an unmarked,
// permanent train, the seller kept an orphan mark, and a traded-in doomed 4 entered the pool and was bought
// back in phase D -- the variant's delay turned into an exemption.
//
// THE PROHIBITION IS TRANSACTION-SPECIFIC, NOT A CHANGE OF STATUS. A reprieved train is still owned, still in
// `owned_trains`, still routeable on its grace turn and still keeps its corporation from being trainless
// (DN 1699 above). GR-2 does not make it inactive, hide it, or take it out of any other reader; it answers one
// narrow question for the two authorities that move a train OUT of a corporation by a player's choice --
// `trainSaleRefusal` (#1592: proposal, answer and settlement, and through it the Blood Price's `isCarcosanSale`)
// and `dieselExchangeRefusal` / `exchangeableTrains` (#1303: the reducer's gate and arm, the REFUSED line, the
// panel). Those two ask it here, so the sale and the exchange cannot disagree about which copy is free.
//
// IDENTICAL MODELS ARE A MULTISET, NOT A MODEL-LEVEL FREEZE. The marks are models, not train identities (#1032),
// and a corporation can own several copies of one model. "It has a reprieved 4" does not mean "no 4 may move":
//     owned ["4","4"], marks ["4"]  -> one reprieved 4, one ordinary 4 -> exactly ONE 4 may leave;
//     owned ["4","4","4"], marks ["4","4"] -> exactly one;   owned ["4"], marks ["4"] -> none.
// So the question is a count -- owned copies of the model MINUS marked copies of it -- never
// `pending_rust_trains.includes(model)`, which would freeze every ordinary copy beside a reprieved one.
//
// THE TRANSACTION TAKES AN ORDINARY COPY AND LEAVES EVERY MARK AT HOME. Neither arm needs changing: each takes
// one copy of the model out of `owned_trains` and touches no mark, and with no identity that is exactly "an
// ordinary copy left". Owned 2 / marked 1 becomes owned 1 / marked 1 -- the copy that stayed is the reprieved
// one, still at its corporation, still owed its grace turn; the buyer (or the Bank Pool) receives an unmarked
// train because an unmarked train is what left. The guard is what keeps that true: a transaction is admitted
// only while owned > marked, so after it owned >= marked still holds and the sub-multiset invariant
//     pending_rust_doomed_this_turn <= pending_rust_trains <= owned_trains
// survives every accepted sale and exchange, and a refused one returns the board unchanged.
//
// WHY `pending_rust_doomed_this_turn` IS NOT SUBTRACTED. It is a SUBSET of `pending_rust_trains` (DN 1699): the
// marks written in the corporation's own turn, recorded a second time only so the grace clock knows which turn
// they are owed. A reprieved train is reprieved whichever turn it is owed. Subtracting both lists would count a
// self-doomed copy twice and freeze an ordinary copy beside it (owned ["4","4"], marks ["4"], doomed-this-turn
// ["4"] has ONE free 4, not none).
//
// WHY THE FIRST-D ORDINARY TRADE-IN STAYS LEGAL. Legality is judged on the board BEFORE the purchase. A 4 traded
// in for the very first Diesel is an ordinary, unmarked train on that board: the rust it would suffer has not
// happened, because the Diesel that causes it has not yet been bought. The exchange arm takes it out before the
// phase turns (#1303) and the rust sweep that follows marks only the 4s still owned. Nothing here looks ahead to
// the phase change; a question asked of marks can only see rusts that have already occurred.
//
// NOT HERE: the excess discard (a reprieved train occupies no slot and is never a choice -- `countableTrainsOf`,
// SR-8, unchanged), and the Yellow Sign's cheapest-train removal (OD-GR-3, deferred to Unpredictable Revenue
// certification). This is not a general "may this train move" rule, and neither of those is decided by it.

/** A fleet and its marks, as `PublicCompanyState` carries them (either may be absent, #232). */
type Fleet = { owned_trains?: readonly string[] | null; pending_rust_trains?: readonly string[] | null };

const copiesIn = (list: readonly string[] | null | undefined, model: string): number =>
  (list ?? []).reduce((count, entry) => (entry === model ? count + 1 : count), 0);

/** How many copies of `model` the corporation owns that NO Gentle Rust mark covers: owned copies minus marked
 *  copies, by multiplicity, never below zero (a surplus mark cannot manufacture a free train). These are the
 *  copies a sale (OD-GR-1) or a Diesel trade-in (OD-GR-2) may move. `pending_rust_doomed_this_turn` is already
 *  inside the marks and is not subtracted again (DN 1700). */
export function unreprievedCopiesOf(company: Fleet, model: string): number {
  return Math.max(0, copiesIn(company.owned_trains, model) - copiesIn(company.pending_rust_trains, model));
}

/** Whether the corporation owns `model` ONLY as reprieved copies: at least one copy, none of them free. The
 *  case a transaction authority refuses with the Gentle Rust sentence rather than "does not own". */
export function ownsOnlyReprievedCopiesOf(company: Fleet, model: string): boolean {
  return copiesIn(company.owned_trains, model) > 0 && unreprievedCopiesOf(company, model) === 0;
}

/** The fleet with every reprieved copy taken out: roster order, one entry per train. Each mark spends one
 *  matching train, earliest first -- the order the chips assign "Final Run" in (`TrainBadges`, #1004) -- so the
 *  copies left are the ones the chips show as ordinary. `owned ["4","4","5"]`, marks `["4"]` -> `["4","5"]`. */
export function unreprievedTrains(company: Fleet): string[] {
  const marks = [...(company.pending_rust_trains ?? [])];
  const free: string[] = [];
  for (const model of company.owned_trains ?? []) {
    const at = marks.indexOf(model);
    if (at >= 0) marks.splice(at, 1);
    else free.push(model);
  }
  return free;
}
