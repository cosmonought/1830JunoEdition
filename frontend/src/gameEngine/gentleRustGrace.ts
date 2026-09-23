// frontend/src/gameEngine/gentleRustGrace.ts
//
// Which Operating Turn a Gentle Rust reprieve is owed, and which reprieves the current turn may spend.
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
