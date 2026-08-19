// frontend/src/utils/passedSeats.ts
//
// WHO HAS PASSED SINCE SOMEBODY LAST ACTED.
//
// ===================================================================
//  DESIGN NOTE 610: DERIVED, NOT RECORDED
// ===================================================================
//
// INSTRUCTED: "when a player passes in the Stock or Auction round, what if
// we stamped a 'PASSED' over their player name in the action bar?" -- with
// the reservation that new players might read it as a permanent withdrawal,
// and the mitigation: "if we remove the stamp on the player's next turn that
// might mitigate it."
//
// THE MITIGATION IS NOT AN EXTRA RULE, IT IS THE DEFINITION. The state
// already carries `consecutive_passes`, which resets to zero the moment any
// seat does something other than pass. So "the passes since the last real
// action" is a window that slides forward on its own, and the stamp clearing
// on a player's next turn is what falls out of reading it -- there is nothing
// to expire, nothing to time out, and no way for a stale stamp to survive an
// action that should have cleared it.
//
// WHICH IS WHY THIS IS DERIVED RATHER THAN TRACKED. The alternative is a set
// of "who has passed" in component state, fed by watching the log. That
// duplicates a fact the reducer already owns, and the copy would be wrong in
// exactly the cases that matter: a late-joining client, a refresh mid-round,
// an undo. This function is a pure read of state every client already has,
// so five browsers cannot disagree about who passed.
//
// ===================================================================
//  DESIGN NOTE 610a: WALKING BACKWARDS IS SOUND, AND HAS ONE LIMIT
// ===================================================================
//
// Seats act in a fixed rotation, so N consecutive passes ending at seat `i`
// means seats `i-1, i-2, ... i-N` passed, wrapping. That is exact for the
// Stock Round and for the main waterfall rotation.
//
// IT IS NOT EXACT INSIDE A MINI-AUCTION, where only the contesting seats
// take turns -- walking back through the full roster would step over seats
// that were never asked and stamp them. Callers pass `enabled: false` there
// rather than this function guessing, because whether a subset rotation is
// running is the caller's fact, not this module's.

const EMPTY: ReadonlySet<number> = new Set<number>();

/** Seats that have passed since the last non-pass action, as indices into
 *  the seating order. Empty whenever nothing should be stamped. */
export function passedSeatIndices({
  seatCount,
  activeIndex,
  consecutivePasses,
  enabled = true,
}: {
  seatCount: number;
  /** The seat on turn now. `-1` when nobody is, which is honest during the
   *  moment a round turns over. */
  activeIndex: number;
  consecutivePasses: number;
  /** Design note #610a: `false` suppresses the whole answer -- a mini-auction
   *  rotates over a subset and this walk does not model that. */
  enabled?: boolean;
}): ReadonlySet<number> {
  if (!enabled) return EMPTY;
  if (seatCount <= 0) return EMPTY;
  if (activeIndex < 0 || activeIndex >= seatCount) return EMPTY;
  if (consecutivePasses <= 0) return EMPTY;

  /* Capped at `seatCount - 1`, which is not a defensive clamp but a rule.
     A full rotation of passes ENDS the round, so a count at or above the
     seat total is a state the bar is about to stop rendering -- and without
     the cap the walk would lap and stamp the seat that is currently on turn,
     which is the one seat that provably has not passed yet. */
  const marked = Math.min(consecutivePasses, seatCount - 1);
  const seats = new Set<number>();
  for (let step = 1; step <= marked; step += 1) {
    // `% n` then `+ n` then `% n` again: JavaScript's remainder keeps the
    // sign of the dividend, so the naive `(activeIndex - step) % seatCount`
    // goes negative as soon as the walk wraps past seat zero.
    seats.add((((activeIndex - step) % seatCount) + seatCount) % seatCount);
  }
  return seats;
}
