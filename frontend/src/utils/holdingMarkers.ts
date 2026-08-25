// frontend/src/utils/holdingMarkers.ts
//
// The one-word annotation on a shareholder's figure: "max", "tied", or nothing.
//
// ==================================================================
//  DESIGN NOTE 791: TWO MARKERS, AND THEY CANNOT COLLIDE
// ==================================================================
//
// REPORTED: "You can include a 'tied' for this case, e.g., '4 (50% tied)' and '5 (50% tied)'. There should
// never be a case where max and tied both need to be printed, so just make sure the column spacing can
// handle the extra character."
//
// THE "NEVER BOTH" IS ARITHMETIC, NOT A CONVENTION, which is why it lives here as a function rather than as a
// comment somebody has to trust. "Max" needs a holding at or above the 60% cap; "tied" needs another player
// holding the same amount. Two players at 60% is 120% of a 100% corporation. The two markers are mutually
// exclusive by construction, and `holdingMarker` returns ONE string rather than a set, so a caller cannot
// print both even if the arithmetic were ever wrong.
//
// TIED FOR CONTROL, NOT TIED ANYWHERE. The report says "tied for control of a corporation", and that is the
// narrower and better reading: a 10%/10% tie between two minor holders is not a contest and marking it would
// be noise on a card that already carries four figures per row. So the marker goes on the LARGEST holding
// when more than one player shares it -- the position that holds or threatens the presidency.
//
// AND IT IS THE FACT #790 LOST. That note stopped the roster reordering itself on a tie, because a moving row
// said "the presidency changed hands" when the rules say a challenger must EXCEED the incumbent. The old
// arrangement was signalling something real with the wrong instrument; this is the right instrument.

import type { PriceZone } from "./sharePurchase";
import { atHoldingCap } from "./sharePurchase";

/** Just enough of a holding to judge it. Structural so the card, the ledger and a test can all pass what
 *  they have rather than a `RosterHolding` none of them share. */
export interface MarkableHolding {
  percentage: number;
}

/** Whether this holding is level with the largest, and not alone there.
 *
 *  READS THE WHOLE ROSTER, deliberately: "tied" is a fact about a holding's RELATION to the others, and a
 *  predicate that took only the one figure could not answer it. That is also why this is not a field on the
 *  holding -- it would have to be recomputed whenever anybody else's stake moved. */
export function tiedForControl(
  percentage: number,
  holdings: readonly MarkableHolding[],
): boolean {
  if (percentage <= 0) return false;
  const largest = holdings.reduce((top, entry) => Math.max(top, entry.percentage), 0);
  if (percentage !== largest) return false;
  return holdings.filter((entry) => entry.percentage === largest).length > 1;
}

/** The word to print after the percentage, or `null` for the ordinary case.
 *
 *  ONE STRING, NOT A SET. The report's "there should never be a case where max and tied both need to be
 *  printed" is true by arithmetic -- see the note above -- and this signature makes it true by type as well,
 *  so a future zone rule that broke the arithmetic would produce a wrong marker rather than a broken cell.
 *
 *  MAX FIRST, because if the impossible ever happened it is the more binding fact: "tied" describes a
 *  contest, "max" describes a door that is shut. */
export function holdingMarker(
  percentage: number,
  zone: PriceZone,
  holdings: readonly MarkableHolding[],
): "max" | "tied" | null {
  if (atHoldingCap(percentage, zone)) return "max";
  if (tiedForControl(percentage, holdings)) return "tied";
  return null;
}

/** The longest cell this can produce, for whoever is sizing the column.
 *
 *  DERIVED RATHER THAN ASSERTED, because the report asked specifically to "make sure the column spacing can
 *  handle the extra character" and the honest answer is that it does not need to: "tied" is one letter longer
 *  than "max", and a tie CANNOT occur above 50% -- two players sharing the largest holding is at most 50%
 *  each. So the widest tied cell is `4 (50% tied)` and the widest capped cell is `9 (100% max)`, both twelve
 *  characters. The letterforms differ, which is a reason to leave a little slack rather than to re-measure. */
export const WIDEST_MARKED_CELLS: readonly string[] = ["9 (100% max)", "4 (50% tied)"];
