// frontend/src/components/tileTrayLpf.ts
//
// The Level Playing Field tray -- design note #1320.
//
// The request: "Start with the 1830+ expanded tray, but explicitly remove the following quantities: #5 (2),
// #6 (2), #592 (2), #61 (2)." So this is `PLUS_TRAY` with those counts taken off. A count that reaches zero
// leaves the tray entirely rather than sitting at 0 -- `inTray` answers "is this tile in this game", and a
// tile with nothing to lay is not.
//
// #810 and #882 were also named for removal (1 each) and are NOT coded: neither is in the catalog or the 18XX+
// tray today, so there is nothing to take away. If they are ever added, the LPF removal is added with them.

import { PLUS_TRAY } from "./tileTrayPlus";
import type { TileTray } from "./tileTray";

/** `[tileId, quantity removed]`, the request's own figures. */
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
