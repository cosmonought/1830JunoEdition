// One colour per train, for the routes it runs.
//
// Design note #494: `App.manualRouteOverlay` declared `const color` ONCE outside
// the loop, so a corporation running three trains drew three routes in exactly
// the same colour. `RouteOverlay.color`'s own doc comment had claimed "one
// distinct colour per train" the whole time, and #373 built a highlight
// mechanism on top of a property the data did not have.
//
// Design note #494a: losing the corporate colour costs nothing -- exactly one
// corporation operates at a time, so its livery encodes a fact already true of
// everything on screen and spends the only channel available on it. The
// association survives on the tokens, the badge and `StationTokenRow`.
//
// Design note #494b: six hues spread around the wheel, all LIGHT (the route line
// is a third of the rail's width, `hexCanvasPrimitives.ts #268`, so a dark hue
// vanishes into the ink it is drawn inside). A corporation holds at most four
// trains, so six is headroom. NOT the corporation palette and not to be merged
// with it -- that answers "which company", this answers "which of its trains".
//
// See docs/ai_architecture/routing_pathfinding.md, routeLivery.ts #494.

/** Distinct route inks, indexed by a corporation's train index.
 *
 *  THE SIXTH ENTRY WAS ORANGE (`#fb923c`) AND FAILED ITS OWN HARNESS: 51 units
 *  from amber in RGB, under the 60 the pairwise test demands and the closest pair
 *  in the table by a wide margin -- two warm yellows on a thin line at low zoom,
 *  the exact indistinguishability this palette exists to fix.
 *
 *  Lime replaces it because that is where the gap was. By hue -- amber 43, green
 *  142, azure 199, violet 258, magenta 330 -- there are 99 degrees between amber
 *  and green and under 75 everywhere else. A measured slot, not a free colour. */
export const ROUTE_TRAIN_COLORS: readonly string[] = [
  "#38bdf8", // azure
  "#fbbf24", // amber
  "#4ade80", // green
  "#f472b6", // magenta
  "#84cc16", // lime
  "#a78bfa", // violet
];

/** The route ink for a train, by its index in `owned_trains`.
 *
 *  WRAPS rather than returning a fallback. A corporation cannot legally hold more
 *  trains than the palette has entries, so the modulo is unreachable in a real
 *  game -- but a single fallback colour would make two trains identical again,
 *  which is the bug this file exists to fix. A negative or non-integer index
 *  takes entry 0 rather than throwing: no colour at all is worse than the first. */
export function routeTrainColor(trainIndex: number): string {
  if (!Number.isFinite(trainIndex) || trainIndex < 0) return ROUTE_TRAIN_COLORS[0];
  return ROUTE_TRAIN_COLORS[Math.floor(trainIndex) % ROUTE_TRAIN_COLORS.length];
}

/* Design note #495: every piece of the click-to-highlight existed and none were
   joined. `drawRouteOverlays` has honoured `emphasis` since #373 and the planner
   rows and chips have raised `highlightedTrainIndex` for just as long;
   `App.manualRouteOverlay` built the overlays between them and never set it.

   A pure function rather than a ternary in the memo, because the interesting
   case is invisible from the call site: `null` must mean "nothing is
   highlighted, draw everything normally" and NOT "highlight nothing, mute
   everything", which would dim the whole board whenever the pointer leaves. */
export type RouteEmphasisChoice = "normal" | "primary" | "muted";

export function routeEmphasisFor(
  trainIndex: number,
  highlightedTrainIndex: number | null,
): RouteEmphasisChoice {
  if (highlightedTrainIndex === null) return "normal";
  return trainIndex === highlightedTrainIndex ? "primary" : "muted";
}
