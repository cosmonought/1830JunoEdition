// frontend/src/utils/roundLabel.ts
//
/* ==================================================================
 *  DESIGN NOTE 659: WHICH ROUND AN ENTRY BELONGS TO
 * ==================================================================
 *
 * REPORTED: "it labels the last action of OR 1.1 as the first action of SR2,
 * i.e., it printed '[SR2] PRR passed Buy Trains.' This should read [OR1.1]
 * and then a second entry for [SR2] Announcing the stock round and who has
 * Priority Deal."
 *
 * Moved out of `App.tsx` to be tested. The function itself is unchanged and
 * was never wrong -- what was wrong is which STATE it was asked about, and
 * that is a distinction a 10,000-line component cannot hold a test for.
 *
 * THE RULE, now that it has somewhere to be written down:
 *
 *   An ACTION is tagged with the round it was taken in -- `before`.
 *   An ANNOUNCEMENT is tagged with the round it announces -- `after`.
 *
 * Every round-closing action makes those two different, and it is the only
 * time they differ, which is why this went unnoticed until a game reached the
 * end of an Operating Round with somebody reading the log.
 *
 * Design note #643 had already been here once. It replaced a ref read with
 * `roundLabelFor(after)`, correctly reasoning that "on a replay the ref is
 * the present and the action is the past" -- and then took the wrong end of
 * the action. `after` is the state the action RESOLVED TO. For every action
 * but one that is the same round it happened in, so the fix looked complete
 * and was 99% right, which is the hardest kind of wrong to see.
 */

import type { GameStateResponse } from "./gameState";

/** The short round tag the activity log and the ticker stamp on an entry.
 *
 *  `Auction`, `SR2`, `OR 3.1`. The Operating Round's suffix is dropped when
 *  `sub_round_index` is 0, which is the state between rounds -- design note
 *  #621 zeroes it on close and `beginOperatingRound` stamps it back to 1. */
export function roundLabelFor(state: GameStateResponse | null | undefined): string | null {
  if (!state) return null;
  if (state.current_round_type === "WaterfallAuction") return "Auction";
  if (state.current_round_type === "StockRound") return `SR${state.macro_round_number}`;
  const suffix = state.sub_round_index > 0 ? `.${state.sub_round_index}` : "";
  return `OR ${state.macro_round_number}${suffix}`;
}
