// frontend/src/components/tileTrayPlus.ts
//
// The Project 18XX+ tray -- design note #1311. The request, verbatim: "The following tiles and tile counts
// may be used as a variant supply for an 1830+ game. Any unlisted tiles remain as they are."
//
// So this is the standard tray with the listed counts written over it. A listed tile that is not in the
// standard tray (every `plusOnly` catalog entry) is added at its catalog count, which IS the listed count.

import { TILE_CATALOG } from "./hexTileCatalog";
import { STANDARD_TRAY, type TileTray } from "./tileTray";

/* ==================================================================
    DESIGN NOTE 1629 (Slice 9.3, S9-15): THIS LIST IS TOTALS, AND #63's TOTAL WAS THE "+1"
   ==================================================================

   EVERY NUMBER HERE IS THE WHOLE 1830+ SUPPLY, because the map below is `counts.set` -- REPLACEMENT, not
   addition. That is deliberate and it is what the request's "tile counts ... as a variant supply" means, and
   every other row reads correctly under it: T-09 prints #59 as `2 +1` and this list says 3, #14 as `2 +2` and
   this list says 4, #9 as `7 +5` and this list says 12.

   #63 DID NOT. T-09 prints `3 +1` -- three Classic copies plus one more -- so the 1830+ total is FOUR, and
   this row said 1: the "+1" column transcribed into a slot that means the total, which under replacement
   semantics DELETED the three Classic copies instead of adding a fourth. Stage 9.1 measured the effect: the
   expanded tray really did hold one #63 where the rulebook holds four.

   THE CORRECTION IS DIRECT COMPONENT EVIDENCE, not an inference from a count column. The official errata's
   correction tile sheet instructs "40 value added to 1830+ side of ALL FOUR C15 tiles" -- C15 is #63's Lookout
   identifier -- so the physical sheet carries four. (The same errata item is about the tile's VALUE, 50 -> 40,
   which this catalog already honours at `revenue: 40`; it does not touch the count, and the count is wrong for
   its own separate reason.)

   PHYSICAL SUPPLY FIRST, SCENARIO REMOVALS AFTER. #63 is on no removal list -- not T-01's S-1.0 Ⓓ list, not
   S-1.1 ❻, not `LPF_TRAY_REMOVALS` -- and the errata sheet's roundels print Ⓑ Ⓓ Ⓖ Ⓡ on C15, so it is a
   Scenario-D component that Scenario D keeps. Correcting the supply here therefore carries through to both
   derived trays untouched: published Scenario D and the Level Playing Field both hold four. Fixing it in a
   tray reader instead of here would have left the two derived trays and `tileSupply`'s arithmetic reading the
   wrong physical count. */

/** The eight standard tiles whose counts the expansion changes -- TOTALS, see #1629. */
const RECOUNTED: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [8, 13],
  [7, 7],
  [57, 6],
  [14, 4],
  [15, 4],
  [59, 3],
  [63, 4],
];

export const PLUS_TRAY: TileTray = {
  id: "plus",
  counts: (() => {
    const counts = new Map(STANDARD_TRAY.counts);
    RECOUNTED.forEach(([tileId, quantity]) => counts.set(tileId, quantity));
    TILE_CATALOG.filter((entry) => entry.plusOnly === true).forEach((entry) =>
      counts.set(entry.tileId, entry.quantity),
    );
    return counts;
  })(),
};
