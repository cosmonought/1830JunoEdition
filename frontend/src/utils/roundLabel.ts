// Design note #659: which round a log entry belongs to.
//
// REPORTED: the last action of OR 1.1 was labelled "[SR2] PRR passed Buy
// Trains." Moved out of `App.tsx` to be tested -- the function was never wrong,
// what was wrong is which STATE it was asked about, and that is a distinction a
// 10,000-line component cannot hold a test for.
//
// THE RULE: an ACTION is tagged with the round it was taken in (`before`); an
// ANNOUNCEMENT is tagged with the round it announces (`after`). Every
// round-closing action makes those two different, and it is the only time they
// differ.
//
// Design note #643 had already been here once, correctly replacing a ref read
// with `roundLabelFor(after)` -- and then taking the wrong end of the action.
// `after` is the state the action RESOLVED TO, which for every action but one is
// the same round it happened in, so the fix looked complete and was 99% right.
//
// See docs/ai_architecture/state_machine.md, roundLabel.ts #659.

import type { GameStateResponse } from "./gameState";

/** The short round tag the activity log and the ticker stamp on an entry:
 *  `Auction`, `SR2`, `OR 3.1`. The Operating Round's suffix is dropped when
 *  `sub_round_index` is 0, which is the state between rounds -- design note #621
 *  zeroes it on close and `beginOperatingRound` stamps it back to 1. */
export function roundLabelFor(state: GameStateResponse | null | undefined): string | null {
  if (!state) return null;
  if (state.current_round_type === "WaterfallAuction") return "Auction";
  if (state.current_round_type === "StockRound") return `SR${state.macro_round_number}`;
  const suffix = state.sub_round_index > 0 ? `.${state.sub_round_index}` : "";
  return `OR ${state.macro_round_number}${suffix}`;
}
