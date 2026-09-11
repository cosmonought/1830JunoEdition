// frontend/src/components/tileTrayLpf.ts
//
// The Level Playing Field tray -- design note #1320.
//
// The request: "Start with the 1830+ expanded tray, but explicitly remove the following quantities: #5 (2),
// #6 (2), #592 (2), #61 (2)." So this is `PLUS_TRAY` with those counts taken off. A count that reaches zero
// leaves the tray entirely rather than sitting at 0 -- `inTray` answers "is this tile in this game", and a
// tile with nothing to lay is not.
//
// #810 and #882 (Toronto's green and brown) came out under #1385's restated list and go BACK under #1395:
// D10 is printed TO and takes only the TO family, so a tray without them left Toronto a hex that never
// upgrades or connects to anything.

import { PLUS_TRAY } from "./tileTrayPlus";
import type { TileTray } from "./tileTray";

/** `[tileId, quantity removed]`, the request's own figures. */
/* ==================================================================
    DESIGN NOTE 1385: THE BROWN B IN A TRAY WITH NO #61
   ==================================================================
   REPORTED (LPF playtest): "what happened to the brown B tile upgrades? it is stuck on green", and the
   ruling: "B tiles should upgrade to 61, 884, 997." RESTATED IN THE SAME BREATH, the removal list: "two 5,
   two 6, one 810, one 882, two 592, two 61" -- #1320's list with the two tiles the catalog does not carry
   named too. So 592 and 61 stay OUT of this tray (the 18XX+ tray holds exactly two of each, and two are
   removed), and the brown B on the Level Playing Field is 884 or 997. Both were typed as ordinary brown
   cities, which a B hex's label restriction refuses; the catalog retypes them `BostonHub`, and the green B
   (53) offers them. 810 and 882 (Toronto) are in the 18XX+ tray now and come out as listed.

   ==================================================================
    DESIGN NOTE 1395: TORONTO GETS ITS TILES BACK
   ==================================================================
   REPORTED (LPF playtest): "When clicking the preprinted Toronto (TO) hex, the tileselector does not pop up
   at all, indicating it has no upgrades. I think that is the correct LPF rule, but it means TO is a hex that
   never upgrades or connects to anything. Let's restore the TO tiles for our LPF variant's tile set."

   THE SELECTOR WAS RIGHT AND THE TRAY WAS WRONG. D10 is printed TO (#1317), and a TO hex takes only the
   TorontoHub family -- #810 green, #882 brown -- so with both removed the hex had no legal candidate and the
   selector, correctly, showed nothing. #1385's list named them because the printed Level Playing Field
   removes them, but a Toronto that can never be built through is a dead corner of the map; the variant
   keeps one of each. The four other removals stand. */
export const LPF_TRAY_REMOVALS: ReadonlyArray<readonly [number, number]> = [
  [5, 2],
  [6, 2],
  [592, 2],
  [61, 2],
];

export const LPF_TRAY: TileTray = {
  id: "lpf",
  counts: (() => {
    const counts = new Map(PLUS_TRAY.counts);
    LPF_TRAY_REMOVALS.forEach(([tileId, removed]) => {
      const have = counts.get(tileId);
      if (have === undefined) return;
      const left = have - removed;
      if (left > 0) counts.set(tileId, left);
      else counts.delete(tileId);
    });
    return counts;
  })(),
};
