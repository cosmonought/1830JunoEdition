// frontend/src/styles/routeLivery.ts
//
// One colour per train, for the routes it runs.
//
// ===================================================================
//  DESIGN NOTE 494: THE COLOUR WAS THE CORPORATION'S, NOT THE TRAIN'S
// ===================================================================
//
// REPORTED: when several routes start at the same city or overlap, they are
// visually indistinguishable on the map.
//
// They were identical, and the cause is one line in `App.manualRouteOverlay`:
//
//     const color = glowColorFor(stationTickerColor(actingProtocolId));
//
// declared ONCE, outside the loop that builds the overlays, and handed to
// every train. So a corporation running three trains drew three routes in
// exactly the same colour -- and where they shared a city or a stretch of
// rail there was nothing to tell them apart, because there was nothing
// different about them.
//
// `RouteOverlay.color`'s own doc comment has claimed the opposite the whole
// time: "One distinct colour per train, so overlapping routes stay tellable
// apart -- which is the entire point of drawing more than one." That is the
// requirement, stated correctly, next to a field that was never given a
// distinct value. Design note #373 then built a highlight mechanism on top
// and said the colours "were always per-train (design note #254), which is
// what makes the connection RECOVERABLE" -- reasoning from a property the
// data did not have.
//
// ===================================================================
//  DESIGN NOTE 494a: WHY NOT THE CORPORATION'S LIVERY
// ===================================================================
//
// Losing the corporate colour here costs nothing, and that is worth stating
// because it looks like a regression.
//
// Exactly one corporation operates at a time. Every route on the board
// during Run Routes belongs to it, so coloring them all in its livery
// encodes a fact that is already true of everything on screen -- and spends
// the only visual channel available on it. The trains are the thing that
// differs, so the trains are what the colour should say.
//
// The corporate association does not disappear: `StationTokenRow`, the
// action bar's corporation badge and every token on the map are all still in
// livery, and the routes emanate from that corporation's own tokens.
//
// ===================================================================
//  DESIGN NOTE 494b: PICKED FOR SEPARATION, NOT FOR PRETTINESS
// ===================================================================
//
// Six hues, spread around the wheel rather than sampled from a gradient, so
// adjacent entries are far apart and not merely different. A 1830
// corporation holds at most four trains (four through Phases 2-3, three in
// Phase 4, two from Phase 5), so four is the real ceiling and six is
// headroom -- the index wraps rather than running out.
//
// ALL SIX ARE LIGHT. The board is dark and the route line is a third of the
// rail's width (design note #268 in `hexCanvasPrimitives.ts`), so a dark hue
// would vanish into the track ink it is drawn inside. That is the same
// constraint `glowColorFor` was applied for; these are chosen above the
// threshold instead of lifted to it, which keeps the hue rather than washing
// it toward white.
//
// THEY ARE NOT THE CORPORATION PALETTE, and must not be merged with it.
// `corporationLivery.ts` answers "which company is this"; this answers
// "which of one company's trains is this". A shared table would make the two
// questions look like one, and the first thing to go would be the
// separation guarantee below -- the corporate eight are chosen for brand
// fidelity, and three of them are close enough to each other that TD-1's
// contrast audit had to be done by hand.

/** Distinct route inks, indexed by a corporation's train index.
 *
 *  THE SIXTH ENTRY WAS ORANGE (`#fb923c`) AND FAILED ITS OWN HARNESS. It sat
 *  51 units from amber in RGB -- under the 60 the pairwise test demands, and
 *  the closest pair in the table by a wide margin. Two warm yellows on a thin
 *  line at low zoom is the exact indistinguishability this palette exists to
 *  fix, reintroduced at the far end of it.
 *
 *  Lime replaces it because that is where the gap actually was. Ordering the
 *  other five by hue -- amber 43, green 142, azure 199, violet 258, magenta
 *  330 -- leaves 99 degrees between amber and green and under 75 everywhere
 *  else, so the sixth hue belongs in the middle of that span. It is a
 *  measured slot rather than a colour that looked free. */
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
 *  WRAPS rather than returning a fallback. A corporation cannot legally hold
 *  more trains than the palette has entries, so the modulo is unreachable in
 *  a real game -- but a wrap keeps every route coloured if the rules ever
 *  change or a chain reports an over-limit roster, where a single fallback
 *  colour would make two trains identical again, which is the bug this file
 *  exists to fix.
 *
 *  A NEGATIVE OR NON-INTEGER INDEX takes entry 0 rather than throwing: this
 *  is a rendering decision, and no colour at all is worse than the first
 *  one. */
export function routeTrainColor(trainIndex: number): string {
  if (!Number.isFinite(trainIndex) || trainIndex < 0) return ROUTE_TRAIN_COLORS[0];
  return ROUTE_TRAIN_COLORS[Math.floor(trainIndex) % ROUTE_TRAIN_COLORS.length];
}

/* ===================================================================
 *  DESIGN NOTE 495: THE HIGHLIGHT HAD BOTH ENDS AND NO MIDDLE
 * ===================================================================
 *
 * REPORTED (as part of the same item): clicking a train chip should
 * highlight only that train's route and dim the others.
 *
 * Every piece of that already existed and none of them were joined.
 * `drawRouteOverlays` has honoured `emphasis` since design note #373 -- a
 * 2.2x pen for `primary`, 0.32 alpha for `muted`, a 1.6x glow -- and
 * `highlightedTrainIndex` has been raised by the planner rows and the train
 * chips for just as long. `App.manualRouteOverlay` built the overlays
 * between them and never set the field, so hovering a chip lit its own row
 * and the map did not move.
 *
 * A pure function rather than a ternary inside the memo, for the reason
 * `marketMoveDirection` is one: the interesting case is invisible from the
 * call site. `null` must mean "nothing is highlighted, draw everything
 * normally" and NOT "highlight nothing, mute everything" -- the second
 * dims the entire board whenever the pointer leaves the panel, which is
 * most of the time.
 */
export type RouteEmphasisChoice = "normal" | "primary" | "muted";

export function routeEmphasisFor(
  trainIndex: number,
  highlightedTrainIndex: number | null,
): RouteEmphasisChoice {
  if (highlightedTrainIndex === null) return "normal";
  return trainIndex === highlightedTrainIndex ? "primary" : "muted";
}
