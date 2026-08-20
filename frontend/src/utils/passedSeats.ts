// Who has passed since somebody last acted.
//
// Design note #610: DERIVED, NOT RECORDED. State already carries
// `consecutive_passes`, which resets the moment any seat does something other
// than pass -- so "the passes since the last real action" is a window that
// slides forward on its own, and the stamp clearing on a player's next turn
// falls out of reading it. Nothing to expire, nothing to time out. A tracked set
// in component state would be wrong in exactly the cases that matter: a
// late-joining client, a refresh mid-round, an undo.
//
// Design note #610a: seats act in a fixed rotation, so N consecutive passes
// ending at seat `i` means seats `i-1 ... i-N` passed, wrapping -- exact for the
// Stock Round and the main waterfall rotation. NOT exact inside a mini-auction,
// where only contesting seats take turns; callers pass `enabled: false` there,
// because whether a subset rotation is running is the caller's fact.
//
// See docs/ai_architecture/state_machine.md, passedSeats.ts #610 / #610a.

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

  /* Capped at `seatCount - 1`, which is not a defensive clamp but a rule. A full
     rotation of passes ENDS the round, so a count at or above the seat total is a
     state the bar is about to stop rendering -- and without the cap the walk would
     lap and stamp the seat currently on turn, the one seat that provably has not
     passed yet. */
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
