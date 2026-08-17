// frontend/src/components/hexCanvasPrimitives.ts
//
// PHASE 4 -- the final step of the `HexGridRenderer.tsx` monolith extraction.
//
// WHAT THIS IS. Every function that PAINTS. The boundary is mechanical and
// unusually clean: with two deliberate exceptions noted below, everything here
// takes a `CanvasRenderingContext2D` and returns nothing, and nothing here
// knows what React is.
//
//   - primitives: `drawHexPath`, `withHexClip`, `bezierTrackSegment`,
//     `fillRoundedRect`, `fillTextWithHalo`, `fitFontSize`;
//   - track: `drawTrackPath`, `drawHardcodedTileArtwork`,
//     `drawDoubleTownRoute`, `drawLandmarkTrack`, `drawOffboardTrack`,
//     `drawPrintedTrack`, `drawRouteOverlays`;
//   - markers: `drawStationCircle`, `drawStationPill`, `drawDitMarker`,
//     `drawStationTokenMarker`, `drawOOCityMarkers`;
//   - badges and labels: `drawValueBadge`, `drawRestrictionBadge`,
//     `drawTerrainCompoundBadge`, `drawHexNameLabel`, `drawStackedNameLabel`,
//     `drawOffboardTooltip`, `drawBoardMarginLabels`;
//   - terrain art: `drawMountainIcon`, `drawRiverIcon`, `drawTerrainIcon`.
//
// NO REACT. Verified mechanically before extraction: zero occurrences of
// `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef` or `React` in
// this entire block. That is what makes it a utility module rather than a
// second component -- these functions can be called from a worker, a test, or
// an offscreen canvas with no renderer in sight.
//
// THE TWO NON-CTX EXCEPTIONS, both deliberate:
//   - `stationMarkerPoint` and `twoCityStationPoints` compute WHERE a station
//     marker goes. They look like geometry, but they exist to keep the token
//     and the circle it sits on in lockstep, and both callers are here. Split
//     across files, the two could drift -- which is exactly the bug design
//     note #56 fixed.
//   - `DOUBLE_TOWN_ROUTES` is artwork data (which arm each town's dit sits
//     on), consumed only by `drawDoubleTownRoute`.
//
// `RouteOverlay` moved here too. It is a public prop of `HexGridRenderer`, but
// `drawRouteOverlays` is its only consumer -- so it lives with the drawing
// code and the renderer re-exports it, keeping `App.tsx`'s import path intact.
//
// IMPORT DIRECTION IS ONE-WAY: never import from `HexGridRenderer.tsx`. This
// is the top of the dependency stack -- it reads geometry, board data, the
// tile catalog, the contract mirrors and the hardcoded artwork, and nothing
// reads it except the component itself.

import {
  COLOR_TIER_STROKE,
  DEFAULT_TRACK_INK,
  STANDARD_TRACK_INK,
  TILE_TRACK_INK,
  LANDMARK_HEXES,
  STATIC_BOARD_HEXES,
  YELLOW_OO_HEXES,
  type OffboardRevenueTiers,
} from "./hexBoardData";
import {
  HEX_NEIGHBOR_OFFSETS,
  HEX_SLOT_FORCE,
  MARGIN_LABEL_BACKGROUND_PADDING_PX,
  MARGIN_LABEL_EXTRA_INSET_PX,
  axialToPixel,
  claimHexSlotForced,
  claimHexSlotPreferring,
  cornerAngleRad,
  deadEdgesAt,
  edgeAngleRad,
  hexBlockedSlots,
  hexSlotDirection,
  marginLabelFontSize,
  marginLabelReserve,
  pointOnCircle,
  resolveSlotOverride,
  slotsBlockedByEdges,
  terrainBaseValue,
  twoNodePositions,
  withSlotReserve,
  type HexArchetype,
} from "./hexGeometry";
import {
  TILE_CATALOG,
  type TerrainType,
  type TileCatalogEntry,
  type TileColorTier,
} from "./hexTileCatalog";
import {
  STATION_TOKEN_RING,
  STATION_TOKEN_RING_WIDTH_RATIO,
  bestContrastTextColor,
  type MapGridResponse,
  type MapTileEntry,
} from "./hexContractTypes";
// `TILE_CATALOG_BY_ID` was imported for design note #216's deleted fallback,
// which re-derived a tile's connecting segment from `TileCatalogEntry.paths`.
// The glow reads authored artwork now and never consults the catalog.
import {
  NEW_YORK_PRINTED_ARTWORK,
  PILL_SLOT_SPACING,
  SLOT_RING_RATIO,
  TILE_GRAPHICS_CATALOG,
  printedMarkersFor,
  artworkPathsForEdge,
  artworkPathsForTraversal,
  newYorkPrintedPaths,
  printedArtwork,
  printedArtworkPaths,
  printedPathsForEdge,
  printedTerminalRailAtEdge,
  printedPathsForTraversal,
  terminalRailAtEdge,
  tileArtworkPaths,
  tileCityAnchors,
  tileMarkerPoints,
} from "./TileGraphics";

/** One train's traced route, for the map overlay -- design note #137 (F-1). */
export interface RouteOverlay {
  /** Short label for the train running this route, e.g. `"3-Train"`. Drawn
   *  nowhere by this component today; carried so a future legend, tooltip or
   *  hover-highlight has it without a second plumbing pass. */
  trainLabel: string;
  /** CSS colour for this route's stroke. One distinct colour per train, so
   *  overlapping routes stay tellable apart -- which is the entire point of
   *  drawing more than one. */
  color: string;
  /** The hexes this route runs through, IN ORDER. Consecutive entries must be
   *  adjacent; a non-adjacent pair is skipped rather than drawn as a straight
   *  line across the board (see `drawRouteOverlays`). */
  hexes: Array<[number, number]>;
  /* ==================================================================
   *  DESIGN NOTE 373: ONE ROUTE IS THE ONE BEING LOOKED AT
   * ==================================================================
   *
   * REPORTED: there is no visual connection between a route path on the
   * map, its train chip on the corporation card, and its row in the Route
   * Planner.
   *
   * Three surfaces describing one thing, and nothing tying them together --
   * so with three trains drafted, working out which coloured line belongs
   * to which row meant matching colours by eye across two panels. The
   * colours were always per-train (design note #254), which is what makes
   * the connection RECOVERABLE; it was never made.
   *
   * `trainIndex` is the join key. It is the same index the Route Planner
   * rows and the train chips are keyed on, so a single number held in
   * `App.tsx` is enough for all three to agree -- no id scheme, no
   * registry, and nothing that can drift because there is only one value.
   *
   * `emphasis` is what this overlay should do about it:
   *
   *   "normal"    nothing is highlighted; draw as always.
   *   "primary"   this is the one. Heavier and brighter.
   *   "muted"     something else is. Fade back so the primary reads.
   *
   * Computed by the CALLER rather than derived here from a highlighted
   * index, because `drawRouteOverlays` is also used by callers that have no
   * concept of a cursor, and a second optional parameter to every one of
   * them would be plumbing for a state they do not have. */
  trainIndex?: number;
  emphasis?: RouteEmphasis;
}

export type RouteEmphasis = "normal" | "primary" | "muted";

export const EMPTY_ROUTE_OVERLAYS: readonly RouteOverlay[] = [];

/* `TrackTraceStyle` and `applyTrace` are DELETED -- design note #226.
 *
 * Design note #195 introduced them so the route glow could re-run each track
 * renderer stroke-only, in blue, and so guarantee the highlight used the
 * exact same Bezier geometry as the rails. That guarantee still holds and is
 * now structural rather than mechanical: the glow strokes the very same
 * `Path2D` objects out of `TILE_GRAPHICS_CATALOG` and
 * `PRINTED_GRAPHICS_CATALOG` that the renderers stroke, so there is nothing
 * left to keep in step.
 *
 * What the trace mode could not express is WHICH rail. It re-ran a whole
 * hex, so it lit every path on it -- and since both endpoints of every route
 * went through it, that was most routes. Replacing it with a per-path
 * lookup is what fixes New York lighting both of its disconnected spurs.
 */



/* ------------------------------------------------------------------ */
/* Drawing helpers                                                    */
/* ------------------------------------------------------------------ */

/** Traces (but doesn't fill/stroke) the six-cornered hex outline centered
 *  at `center`, ready for the caller to `ctx.fill()`/`ctx.stroke()`. */
export function drawHexPath(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const corner = pointOnCircle(center, size, cornerAngleRad(i));
    if (i === 0) {
      ctx.moveTo(corner.x, corner.y);
    } else {
      ctx.lineTo(corner.x, corner.y);
    }
  }
  ctx.closePath();
}

/** Rail Map Overhaul (design note #42): runs `draw` with the canvas clipped
 *  to hex `(center, size)`'s own 6-vertex polygon (`drawHexPath`) for its
 *  entire duration -- the "Hex Boundary Clipping Mask" requirement, so
 *  whatever `draw` paints (a track spline, a terrain icon) can never bleed
 *  past this hex's own border into a neighboring hex, even if a curve's
 *  control point ends up slightly outside the hex's apothem. `ctx.save()`/
 *  `ctx.clip()`/`ctx.restore()`, exactly as the requirement names it --
 *  `save`/`restore` scope the clip region to just this one call, so it never
 *  leaks into whatever the next hex's own pass draws. */
export function withHexClip(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  draw: () => void,
): void {
  ctx.save();
  drawHexPath(ctx, center, size);
  ctx.clip();
  draw();
  ctx.restore();
}

/** Rail Map Overhaul (design note #42): the unit vector pointing from hex
 *  edge `edgeIndex`'s own midpoint straight toward hex center -- i.e. that
 *  edge's own INWARD face-normal. `edgeAngleRad(edgeIndex)` already gives
 *  the OUTWARD direction from center to the edge midpoint (see
 *  `edgePoint`'s own use of it throughout this file), so the inward normal
 *  is just that angle plus 180 degrees. Used by `bezierTrackSegment` below
 *  to satisfy the "Perpendicular Edge Normals" requirement: a track
 *  endpoint sitting on a real hex edge gets its Bezier control point
 *  projected along exactly this direction, so the curve's tangent AT that
 *  edge is perpendicular to the edge itself (a true 90-degree crossing),
 *  regardless of which direction the curve bends once inside the hex. */
export function edgeInwardNormal(edgeIndex: number): { x: number; y: number } {
  const angle = edgeAngleRad(edgeIndex) + Math.PI;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/** Rail Map Overhaul (design note #42): strokes one cubic-Bezier track
 *  curve from `from` to `to` via `ctx.bezierCurveTo` -- the "Smooth Bezier
 *  Track Splines" / "City Connector Curves" requirement, replacing this
 *  file's previous `quadraticCurveTo`-based track curves throughout.
 *
 *  `fromNormal`/`toNormal` are each endpoint's own `edgeInwardNormal` when
 *  that endpoint sits on a real hex edge, or `null` when it's a hex-center
 *  station node (which has no single face to be perpendicular to). Each
 *  provided normal projects that endpoint's own Bezier control point
 *  INWARD along the edge's own normal by `hexSize * controlFraction`
 *  (25%-35% of the hex radius, per the same requirement -- default `0.3`)
 *  -- since a cubic Bezier's tangent at each endpoint points directly at
 *  its own adjacent control point, this guarantees the curve crosses that
 *  edge perpendicular to it, satisfying "every track touching a hex face
 *  must enter/exit at a 90-degree normal angle" exactly. An endpoint with
 *  no normal (a hex-center station) falls back to the straight from->to
 *  chord direction instead, so the curve still eases smoothly through the
 *  shared station node -- "sweep gracefully through station nodes without
 *  sharp hairpin kinks or V-angles" -- rather than kinking at a
 *  zero-length control point. */
export function bezierTrackSegment(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  hexSize: number,
  fromNormal: { x: number; y: number } | null,
  toNormal: { x: number; y: number } | null,
  controlFraction = 0.3,
): void {
  const reach = hexSize * controlFraction;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const n1 = fromNormal ?? { x: dx / len, y: dy / len };
  const n2 = toNormal ?? { x: -dx / len, y: -dy / len };
  const cp1 = { x: from.x + n1.x * reach, y: from.y + n1.y * reach };
  const cp2 = { x: to.x + n2.x * reach, y: to.y + n2.y * reach };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, to.x, to.y);
  ctx.stroke();
}

/** Strokes only SOME of a hex's six border edges -- design note #26/item 3.
 *  Edge `i` runs from corner `i` to corner `(i + 1) % 6` (matching
 *  `cornerAngleRad`'s own doc comment). Unlike `drawHexPath` (one closed
 *  6-sided path, always all-or-nothing), each included edge here is its own
 *  independent 2-point subpath, so a caller can omit exactly one shared
 *  edge (e.g. the Gulf I1/J2 interior seam) while still drawing the other
 *  five normally. */
export function drawHexEdges(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  excludeEdges: ReadonlySet<number>,
): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    if (excludeEdges.has(i)) continue;
    const a = pointOnCircle(center, size, cornerAngleRad(i));
    const b = pointOnCircle(center, size, cornerAngleRad((i + 1) % 6));
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

/** Strokes a single thick red bar across hex `(q, r)`'s edge `edge` --
 *  `IMPASSABLE_BORDER_EDGES`' own visual marker (design note #38) for a
 *  board crossing track may never be built over. Deliberately its own
 *  standalone stroke call (sets and restores its own `strokeStyle`/
 *  `lineWidth`/`lineCap`, like `drawLandmarkTrack`'s own per-segment style
 *  reset) rather than reusing `drawHexEdges`' multi-edge/shared-style API,
 *  since this always draws exactly one edge with its own fixed heavy red
 *  style, independent of whatever track style is active around it.
 *
 *  Rail Map Overhaul (design note #42): recolored to the requested crisp
 *  `#E53E3E` (was a duller `#c0392b`) and clamped to a literal 3px-4px
 *  width -- `Math.min(4, Math.max(3, size * 0.1))`, replacing the old
 *  unclamped `Math.max(5, size * 0.16)` floor, which read wider than an
 *  ordinary barrier bar at most hex sizes and had no upper bound at all.
 *  Drawn flush along the shared edge's own two corner vertices (`a`/`b`
 *  below, straight off `cornerAngleRad`) -- exactly `IMPASSABLE_BORDER_EDGES`'
 *  own edge, not a separately-computed/offset line -- so at this reduced
 *  width it sits flush on the hex border without visibly overshooting
 *  either corner. */
export function drawImpassableBorderEdge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  edge: number,
): void {
  const a = pointOnCircle(center, size, cornerAngleRad(edge));
  const b = pointOnCircle(center, size, cornerAngleRad((edge + 1) % 6));
  ctx.save();
  ctx.strokeStyle = "#E53E3E";
  ctx.lineWidth = Math.min(4, Math.max(3, size * 0.1));
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

/** Decodes `entry`'s base connection bitmask against `orientation` (via
 *  `rotateConnections`, bit-for-bit identical to
 *  `hexmap::rotate_connections`) and draws the resulting track path -- see
 *  design note #3 for the edge-pairing convention this uses. */
/** Design note #52: the two station points for a genuine two-city tile
 *  (`NewYorkHub`, `DoubleCityHub`) -- shared by both the per-city
 *  track-curve rendering in `drawTrackPath` and that same function's own
 *  station-circle placement just below, so a laid tile's track and circles
 *  can never drift apart from each other. Index order matches
 *  `TileCatalogEntry.cityGroups`' own order (city A first, city B second).
 *  Returns `[center, center]` for anything else -- defensive; `cityGroups`
 *  is only ever set on these two terrain kinds.
 *
 *  Design note #56: `NewYorkHub` previously used its own stale, non-
 *  diagonal "side-by-side" formula (`center.x ± size * 0.28`, `center.y`
 *  unchanged) -- left over from before the Universal Canvas Layout Engine
 *  and never updated to the shared diagonal convention, and itself an
 *  unrelated left/right inversion risk on top of the reported
 *  `stationMarkerPoint` bug. New York's real `cityGroups` (city A = edges
 *  E+NE, city B = edges NW+W, see `hexmap.rs`) sit on the right and left
 *  halves of the hex respectively, which the canonical Top-Right/NE
 *  (`+doubleNodeOffset`) vs. Bottom-Left/SW (`-doubleNodeOffset`) diagonal
 *  nodes both satisfy and directionally match -- so `NewYorkHub` now merges
 *  into the exact same branch as `DoubleCityHub`, giving every laid
 *  two-city tile (New York and all four OO variants) identical Node
 *  0/Node 1 coordinates and zero per-terrain-name geometry divergence. */
export function twoCityStationPoints(
  terrain: TerrainType,
  center: { x: number; y: number },
  size: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  if (terrain === "DoubleCityHub" || terrain === "NewYorkHub") {
    return twoNodePositions(center, size);
  }
  return [center, center];
}

/* ------------------------------------------------------------------ */
/* Canonical double-town artwork -- design note #121                    */
/* ------------------------------------------------------------------ */

/** How one town's track runs across the tile, and where its dit sits.
 *  BASE (pre-rotation) edge numbers, same space as `TileCatalogEntry`'s
 *  `connections`/`paths`. */
export interface DoubleTownRoute {
  /** The two hex edges this town's track joins. */
  edges: readonly [number, number];
  /** Where to put this town's marker.
   *
   *  `"midpoint"` evaluates the drawn track at its own halfway point, so
   *  the dit is guaranteed to sit ON the track whatever shape it took --
   *  which for a straight is hex centre, and for a curve is the middle of
   *  the arc.
   *
   *  `"alongTrack"` exists solely for #55, whose two tracks are BOTH
   *  straights and therefore both have their midpoint at dead centre. It
   *  slides each dit out along its own straight by `fraction` of the
   *  apothem, toward `towardEdge`. Because it moves the MARKER rather than
   *  the track, the X stays perfectly straight. */
  /** Where this town's marker sits, as the parameter `t` along its OWN
   *  drawn track: `0` is the `edges[0]` end, `1` is the `edges[1]` end,
   *  `0.5` is the middle. Design note #123.
   *
   *  Superseded a `"midpoint"` rule that put every dit at `t = 0.5`. That
   *  is exactly the wrong place on these tiles: the middle of a track is
   *  where the OTHER track crosses it. On #69 the gentle curve's midpoint
   *  landed precisely on the straight, so its dit sat on the intersection
   *  and read as a blob rather than a town. Pushing each dit out along its
   *  own arm is also what the printed tiles do -- the circles sit clear of
   *  the crossing, toward the edges. */
  ditAt: number;
}

/** The five real 1830 double-town tiles, drawn explicitly rather than
 *  derived -- design note #121.
 *
 *  There are exactly five of these in the whole game and there will never
 *  be a sixth, so an explicit table beats a general algorithm: it is
 *  readable as "this is what #55 looks like", it cannot produce a surprise
 *  on some orientation nobody tested, and each entry can be checked against
 *  a photograph of the physical tile.
 *
 *  Shape per entry, by edge separation (`d = min(|a-b|, 6-|a-b|)`):
 *    #1  {0,4} + {1,3} -- two gentle curves (d=2, d=2)
 *    #2  {0,3} + {1,2} -- straight + sharp curve (d=3, d=1)
 *    #55 {0,3} + {1,4} -- two straights: the X (d=3, d=3)
 *    #56 {0,2} + {1,3} -- two gentle curves (d=2, d=2)
 *    #69 {0,3} + {2,4} -- straight + gentle curve (d=3, d=2)
 *
 *  `edges` duplicates `hexmap::TILE_CATALOG`'s path data on purpose, so
 *  this table reads standalone. The dev-mode assertion under
 *  `TILE_CATALOG_BY_ID` cross-checks the two, so the duplication cannot
 *  silently drift. */
export const DOUBLE_TOWN_ROUTES: Readonly<Record<number, readonly DoubleTownRoute[]>> = {
  1: [
    { edges: [0, 4], ditAt: 0.80 },
    { edges: [1, 3], ditAt: 0.20 },
  ],
  2: [
    { edges: [0, 3], ditAt: 0.80 },
    { edges: [1, 2], ditAt: 0.20 },
  ],
  // #55 -- the X. Both arms are straights, so their midpoints coincide at
  // the crossing; the two dits go out along opposite arms instead. The
  // TRACK is still drawn dead straight, which is the whole point.
  55: [
    { edges: [0, 3], ditAt: 0.20 },
    { edges: [1, 4], ditAt: 0.80 },
  ],
  56: [
    { edges: [0, 2], ditAt: 0.20 },
    { edges: [1, 3], ditAt: 0.80 },
  ],
  // #69 -- the tile that prompted design note #123. Its gentle curve
  // crosses the straight at the straight's own midpoint, so `t = 0.5` put
  // one dit squarely on the intersection. Both are now off it.
  69: [
    { edges: [0, 3], ditAt: 0.38 },
    { edges: [2, 4], ditAt: 0.20 },
  ],
};

// Drift tripwire for the table above (design note #121). `DOUBLE_TOWN_ROUTES`
// restates each double-town's edge pairs so it reads standalone, which makes
// it a second copy of data `TILE_CATALOG` already holds. This is what stops
// the two silently diverging: if the backend ever re-sources a tile's
// pairing, the artwork table has to move with it, or that tile keeps
// rendering the old shape while every other consumer uses the new one.
// Dev-only, never throws.
if (process.env.NODE_ENV !== "production") {
  const normalize = (pairs: ReadonlyArray<readonly [number, number]>) =>
    JSON.stringify(
      pairs.map(([a, b]) => (a <= b ? [a, b] : [b, a])).sort((x, y) => x[0] - y[0] || x[1] - y[1]),
    );
  for (const entry of TILE_CATALOG) {
    const routes = DOUBLE_TOWN_ROUTES[entry.tileId];
    if (entry.terrain === "DoubleTown" && !routes) {
      // eslint-disable-next-line no-console
      console.warn(
        `[HexGridRenderer] DoubleTown tile #${entry.tileId} has no DOUBLE_TOWN_ROUTES entry -- ` +
          "it will fall through to the generic multi-spur fan. Add its canonical artwork.",
      );
      continue;
    }
    if (!routes || !entry.paths) continue;
    const fromTable = normalize(routes.map((route) => route.edges));
    const fromCatalog = normalize(entry.paths);
    if (fromTable !== fromCatalog) {
      // eslint-disable-next-line no-console
      console.warn(
        `[HexGridRenderer] DoubleTown tile #${entry.tileId} artwork/catalog mismatch: ` +
          `DOUBLE_TOWN_ROUTES says ${fromTable}, TILE_CATALOG says ${fromCatalog}.`,
      );
    }
  }
}

/** Draws one double-town track between two edges and returns the point
 *  halfway along whatever it drew -- design note #121.
 *
 *  Two shapes, chosen by how far apart the edges are:
 *
 *  OPPOSITE edges (`d === 3`) get a literal `lineTo`. Not a Bezier that
 *  happens to look straight -- an actual straight segment, so #55's X can
 *  never bow by a fraction of a pixel. Its halfway point is hex centre.
 *
 *  Anything else gets ONE cubic Bezier whose control points sit on each
 *  endpoint's own inward normal, `hexSize * 0.3` in. That is the file's
 *  existing `bezierTrackSegment` reach, and it is deliberately gentle: the
 *  tangent leaves each edge perpendicular, as real printed track does, and
 *  the curve then flows to the other edge without being dragged toward any
 *  intermediate node. A 60-degree pair reads as a tight corner curve and a
 *  120-degree pair as a shallow bow, purely from the geometry -- no
 *  per-shape fudging. */
export function drawDoubleTownRoute(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  apothem: number,
  edgeA: number,
  edgeB: number,
): (t: number) => { x: number; y: number } {
  const from = pointOnCircle(center, apothem, edgeAngleRad(edgeA));
  const to = pointOnCircle(center, apothem, edgeAngleRad(edgeB));
  const separation = Math.min(Math.abs(edgeA - edgeB), 6 - Math.abs(edgeA - edgeB));

  if (separation === 3) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    // Straight line: plain linear interpolation, exact.
    return (t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }

  const reach = size * 0.3;
  const normalA = edgeInwardNormal(edgeA);
  const normalB = edgeInwardNormal(edgeB);
  const cp1 = { x: from.x + normalA.x * reach, y: from.y + normalA.y * reach };
  const cp2 = { x: to.x + normalB.x * reach, y: to.y + normalB.y * reach };

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, to.x, to.y);
  ctx.stroke();

  // The standard cubic basis, evaluated on the curve JUST DRAWN -- an exact
  // point on it, not an approximation, so a dit placed at any `t` can never
  // drift off its own track. Design note #123 needs arbitrary `t`, not just
  // the midpoint, to push each town clear of where the other track crosses.
  return (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * from.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * to.y,
    };
  };
}

/** True when `paths` are pairwise edge-DISJOINT, i.e. the tile carries
 *  several independent runs of track rather than one shared junction --
 *  design note #122.
 *
 *  This is the whole basis for choosing a rendering, and it is read off the
 *  catalog rather than guessed. A junction tile's path list names every
 *  through-route across a shared node: #14 lists all six pairs among its
 *  four edges, #63 all fifteen among its six, #39 all three among its
 *  three. Drawing those as separate curves would be spaghetti -- they mean
 *  "everything meets in the middle", which is exactly the fan. A disjoint
 *  list means the opposite: #16's `[[0,2],[1,3]]` is two tracks that never
 *  touch, and fanning them into one node invents a connection the tile does
 *  not have. */
export function pathsAreDisjoint(paths: ReadonlyArray<readonly [number, number]>): boolean {
  const seen = new Set<number>();
  for (const [a, b] of paths) {
    if (a === b) return false; // terminal spur -- handled by `cityGroups`
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a);
    seen.add(b);
  }
  return paths.length > 0;
}

/* `drawTileMarkers` is DELETED -- design note #209.
 *
 * It placed a tile's station circle or town dit by TERRAIN TYPE alone:
 * `MajorCityHub` got a circle at the hex centre, `DoubleTown` two dits on a
 * fixed diagonal, and so on. That is the marker half of the same guess the
 * track half was making -- terrain says what KIND of revenue centre a tile
 * carries and cannot say WHERE the cardboard prints it, which is why a
 * two-city tile ended up with a station in the empty half of the hex (the
 * failure this file's own design note #133 records).
 *
 * Every marker now comes from `TileArtwork.markers`, authored beside the
 * track it sits on, and `drawHardcodedTileArtwork` draws it. With
 * `drawTrackPath`'s procedural branches gone this function had no callers
 * left, and an exported procedural marker placer sitting next to an artwork
 * catalog is an invitation to reintroduce exactly the drift the catalog
 * exists to prevent. */

/* Design note #126 deleted `drawRevenueBadge` from here -- the bespoke
   white disc the picker drew for itself. It clashed with the board's own
   shape-coded `drawValueBadge` art, which was the reported bug. Both
   surfaces now go through `drawValueBadgeAt`, the single extracted
   implementation, so a value is identical in the tray and on the map. */


/* ------------------------------------------------------------------ */
/* Design note #131: HARDCODED ARTWORK INTERCEPT                       */
/* ------------------------------------------------------------------ */

/** Draws `tileId` from its hand-authored `TILE_GRAPHICS_CATALOG` entry and
 *  returns `true`, or returns `false` if this tile has no explicit artwork
 *  and the caller should fall through to its procedural path.
 *
 *  THIS IS THE "ART, NOT MATH" BOUNDARY. Everything below the `return true`
 *  is literal `Path2D` playback of a hand-written `d` string. No control
 *  point is computed here, no offset is derived, `bezierTrackSegment` and
 *  `edgeInwardNormal` are never reached for a catalogued tile. Adding a
 *  tile to `TILE_GRAPHICS_CATALOG` is therefore the whole mechanism for
 *  taking it off procedural generation -- there is no second switch to flip
 *  and no way for the two renderers to disagree about one tile, because
 *  only one of them ever runs.
 *
 *  ORIENTATION is a rigid `ctx.rotate` about the hex centre -- the tile is
 *  turned, exactly as cardboard is turned. `-60 * orientation` degrees
 *  matches `edgeAngleRad`'s own `-60 * i` convention, so base edge `i`
 *  lands on live edge `(i + orientation) % 6`, agreeing with
 *  `rotateConnections` by construction rather than by coincidence.
 *
 *  TRACK IS STROKED BEFORE MARKERS, always, and markers are drawn OUTSIDE
 *  the rotated/scaled transform in plain board pixels. Two reasons, both
 *  load-bearing: a crossing arm (#55/#68's two straights meet at centre)
 *  must never be stroked over a station it passes, and a circle drawn under
 *  `ctx.scale(size, size)` would take its stroke width from the transform
 *  and stop matching every other marker on the board. */
export function drawHardcodedTileArtwork(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  tileId: number,
  orientation: number,
  /** Design note #153: the tile tier's track ink. Defaults to the historic
   *  near-black, so any caller that does not know the tier renders exactly
   *  as before rather than being forced to guess one. */
  ink: string = DEFAULT_TRACK_INK,
): boolean {
  const paths = tileArtworkPaths(tileId);
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!paths || !art) return false;

  const rot = ((orientation % 6) + 6) % 6;

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate((-60 * rot * Math.PI) / 180);
  ctx.scale(size, size);
  ctx.strokeStyle = ink;
  // The catalog is authored in unit-hex space, so the transform scales the
  // pen too -- divide back out to land on the SAME on-screen stroke width
  // (`max(3, size * 0.12)`) every other track in this file uses.
  ctx.lineWidth = Math.max(3, size * 0.12) / size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of paths) {
    ctx.stroke(path);
  }
  ctx.restore();

  // Markers, in board pixels, at their own explicit per-tile coordinates.
  // A two-node tile shrinks its marker exactly as the old `cityGroups`
  // branch did (`size * 0.85`), so a tile moving onto this renderer keeps
  // the marker size players already know.
  const markerSize = art.markers.length > 1 ? size * 0.85 : size;
  const points = tileMarkerPoints(tileId, orientation, center, size);
  art.markers.forEach((marker, index) => {
    const point = points[index];
    if (!point) return;
    if (marker.kind === "town") {
      // A town is a stop, never a station -- it has no slots and can never
      // take a token, so it is always the plain dot.
      drawDitMarker(ctx, point, markerSize);
      return;
    }
    const slots = marker.slots ?? 1;
    if (slots > 1) {
      // Design note #133: the tile's own rotation is folded into the pill
      // axis HERE rather than inside `drawStationPill`, because the marker
      // pass runs in unrotated board pixels -- `-60 * rot` is the same
      // convention `ctx.rotate` used for the track above, so the pill turns
      // with the track it sits on.
      drawStationPill(ctx, point, markerSize, slots, (marker.angle ?? 0) - 60 * rot);
    } else {
      drawStationCircle(ctx, point, markerSize);
    }
  });

  return true;
}

export function drawTrackPath(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  entry: TileCatalogEntry,
  orientation: number,
  /** Design note #124: draw the tile's own revenue disc. Default `true`, so
   *  every isolated rendering of a tile (picker thumbnails, the rotation
   *  preview) carries its value. The main BOARD loop passes `false`: laid
   *  hexes already get a value badge from this file's own long-standing
   *  `drawValueBadge` pass, which is placement-aware and knows about
   *  off-board tiers and per-hex overrides. Drawing both would stamp two
   *  different numbers on the same hex. */
  showRevenue = true,
  /** Design note #132: the chain's own `MapTileEntry.revenue` for this
   *  tile, when the caller has a laid tile to read it from. `undefined` for
   *  a tray thumbnail of a tile that isn't on the board yet, which falls
   *  back to the terrain bucket -- the one place that fallback is still
   *  correct, since there is no chain record to disagree with. */
  revenueOverride?: number,
  /** Design note #486: draw the tile's own "B"/"NY"/"OO" restriction label.
   *  Same gate, and for the same reason, as `showRevenue` above: the main
   *  BOARD loop passes `false` because `drawRestrictionBadge` already labels
   *  the hex, and on the board a restricted tile can only ever sit on the
   *  hex that carries the matching badge. Default `true` for every isolated
   *  rendering, which has no hex badge to duplicate. */
  showRestriction = true,
): void {
  // ==== Design note #131: hardcoded artwork wins, unconditionally. ====
  // FIRST statement in the function, ahead of `rotateConnections`/
  // `liveEdges` and every procedural branch below, so a catalogued tile
  // cannot reach them even by accident. The overlays pass still runs --
  // that is the revenue badge and the "B"/"NY"/"OO" restriction label,
  // neither of which is track art.
  // Design note #153: the tier decides the ink. `entry.color` is already in
  // hand here, which is why this is the layer that resolves it -- the
  // artwork renderer below takes a colour rather than looking one up, so it
  // stays a pure drawing primitive.
  const trackInk = TILE_TRACK_INK[entry.color] ?? DEFAULT_TRACK_INK;

  if (drawHardcodedTileArtwork(ctx, center, size, entry.tileId, orientation, trackInk)) {
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride, showRestriction);
    return;
  }

  /* ==================================================================
   *  DESIGN NOTE 209: THERE IS NO PROCEDURAL BRANCH ANY MORE
   * ==================================================================
   *
   * Everything that used to stand here -- the `DoubleTown` route table, the
   * disjoint-paths renderer, the `cityGroups` two-station branch, the
   * two-live-edge shortcut and the fan-to-centre spoke fallback -- has been
   * deleted rather than left behind an unreachable guard.
   *
   * WHY DELETED AND NOT KEPT AS A FALLBACK. Every one of those branches read
   * the flat `connections` BITMASK, which records which edges are live and
   * cannot record which pairs route together. That is not a limitation of
   * the code, it is a limitation of the data, and it is why #28 (edges
   * 0/4/5) and #29 (edges 0/1/2) both came out as the same three-armed Y of
   * straight radial spokes: from a bitmask alone there is nothing else they
   * could have come out as. A fallback that is guaranteed to be wrong
   * whenever it runs is not a safety net; it is a silent renderer of
   * plausible-looking fiction, and leaving it in place means the next tile
   * added without artwork looks fine and is not.
   *
   * `TILE_GRAPHICS_CATALOG` now covers all 46 entries of `TILE_CATALOG`
   * (design note #208 there), so the artwork branch above is the only path a
   * real tile takes. An id with no artwork gets the explicit placeholder
   * below -- a dashed outline and the tile number, which is legible as "this
   * build does not know this tile" and cannot be mistaken for track.
   *
   * WHAT STILL RUNS. `drawTileOverlays` -- the revenue badge and the
   * "B"/"NY"/"OO" restriction label -- because neither is track art, and the
   * artwork branch already calls it on its own way out. */
  drawUnknownTilePlaceholder(ctx, center, size, entry.tileId);
  drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride, showRestriction);
}

/* ------------------------------------------------------------------ */
/* Traced route overlay -- design note #137 (F-1)                       */
/* ------------------------------------------------------------------ */

/** Draws every traced train route as a wide translucent ribbon following the
 *  real track geometry.
 *
 *  GEOMETRY, and why it is not just a polyline between hex centres: each hop
 *  is drawn as two `bezierTrackSegment` halves -- centre to the shared edge
 *  midpoint, then that midpoint to the next hex's centre -- the exact same
 *  primitive, with the exact same perpendicular-entry normals, that
 *  `drawTrackPath` uses for real track. A straight centre-to-centre line
 *  would visibly cut the corner on every curve and drift off the rails it is
 *  meant to be highlighting.
 *
 *  STROKE. Wide (`size * 0.30`, roughly 2.5x a track spline's own
 *  `size * 0.12`), round-capped and round-joined, at 55% alpha. Translucent
 *  rather than opaque so the track beneath stays legible through it -- an
 *  opaque ribbon would hide exactly the thing it is pointing at -- and so two
 *  routes sharing a hex show their overlap instead of the later one simply
 *  winning.
 *
 *  NON-ADJACENT PAIRS ARE SKIPPED, not drawn. A caller can hand over a
 *  partially-built route whose ends are not yet connected (the manual route
 *  builder does exactly that, as the player clicks hexes). Drawing a straight
 *  line across the board between two distant hexes would assert a connection
 *  that does not exist; skipping the segment shows the pieces that ARE real
 *  and leaves the gap visible, which is the honest rendering of an incomplete
 *  route.
 *
 *  Restores every context field it touches, so the passes after it are
 *  unaffected. */
/* `HexRailSpec` and `traceHexRails` are DELETED -- design note #226.
 *
 * They existed to re-run a hex's own renderer stroke-only, so the glow could
 * highlight every rail on a hex it could not resolve a single segment for.
 * With endpoints resolved by `artworkPathsForEdge` there is no such hex left,
 * and the mechanism's only remaining effect would be to light track the train
 * never ran on -- which is the bug it is being removed for. The `trace`
 * parameter it threaded through the four track renderers went with it.
 */

/* ==================================================================
 *  DESIGN NOTE 267: THE ROUTE STOPS AT THE CITY WALL
 * ==================================================================
 *
 * REPORTED: the route marker "sloppily runs over the top of station
 * tokens". It did, and the reason is structural rather than a stray few
 * pixels: the route is stroked along the tile's AUTHORED RAIL, and an
 * authored rail runs straight through the middle of the city it serves.
 * The station circle is painted on top of that rail by a later pass. So a
 * route through a city was, by construction, a coloured line drawn across
 * whatever tokens were sitting in it.
 *
 * The fix is a hole rather than a shortened line. Trimming the path would
 * mean re-deriving where each authored curve enters and leaves each marker
 * -- per tile, per rotation, per slot count -- which is the class of
 * arithmetic design note #216 deleted for being wrong more often than the
 * artwork it replaced. Instead the marker's own outline becomes a clip
 * exclusion, and the stroke simply does not land inside it.
 *
 * That gives the asked-for behaviour for free and exactly: the line stops
 * at the border radius of the city marker and RESTARTS where the rail
 * leaves it, because it is one unbroken stroke with a bite taken out.
 * Curves, pills, rotations and multi-city tiles all fall out of the same
 * rule with no per-case geometry.
 *
 * THE SHAPES MIRROR THE MARKER PASS EXACTLY, and must: the radii here are
 * read from the same `0.22`/`PILL_SLOT_SPACING` constants
 * `drawStationCircle` and `drawStationPill` draw with, plus half the ring
 * stroke, so the hole is the marker's OUTER edge rather than a guess near
 * it. A drift between the two shows up as a sliver of route colour around
 * a token, which is the bug this fixes in miniature.
 *
 * TOWNS ARE NOT MASKED. A dit is a small filled dot the route legitimately
 * runs through -- it holds no token, so there is nothing to cover, and
 * punching a hole for it would break the line for no reason.
 */
interface CityMask {
  cx: number;
  cy: number;
  radius: number;
  /** Centre-to-centre distance between the capsule's two end circles. `0`
   *  for a 1-slot city, which is then just a circle. */
  span: number;
  angleRad: number;
}

/** The token-bearing markers on one hex, as board-pixel capsule outlines. */
function cityMasksForHex(
  laid: { tile_id: number; orientation: number } | undefined,
  printedLabel: string | undefined,
  center: { x: number; y: number },
  size: number,
): CityMask[] {
  const masks: CityMask[] = [];

  /** `drawStationCircle`/`drawStationPill`'s outer edge: the marker radius
   *  plus half the ring stroke that straddles it. */
  const outerRadius = (markerSize: number) =>
    markerSize * 0.22 + Math.max(2, markerSize * 0.06) / 2;

  if (laid) {
    const art = TILE_GRAPHICS_CATALOG[laid.tile_id];
    if (art) {
      const rot = ((laid.orientation % 6) + 6) % 6;
      // Same shrink `drawHardcodedTileArtwork` applies to a two-node tile.
      const markerSize = art.markers.length > 1 ? size * 0.85 : size;
      const radius = outerRadius(markerSize);
      const points = tileMarkerPoints(laid.tile_id, laid.orientation, center, size);
      art.markers.forEach((marker, index) => {
        const point = points[index];
        if (!point || marker.kind !== "city") return;
        const slots = marker.slots ?? 1;
        masks.push({
          cx: point.x,
          cy: point.y,
          radius,
          span: PILL_SLOT_SPACING * (markerSize * 0.22) * (slots - 1),
          // The tile's rotation folds into the axis here, exactly as the
          // marker pass folds it in -- see `drawStationPill`'s `angleDeg`.
          angleRad: (((marker.angle ?? 0) - 60 * rot) * Math.PI) / 180,
        });
      });
    }
  }

  if (printedLabel !== undefined) {
    // Design note #229: `printedMarkersFor` so New York's PAIR is covered
    // rather than only the hexes whose marker happens to be singular.
    for (const marker of printedMarkersFor(printedLabel)) {
      if (marker.kind !== "city") continue;
      masks.push({
        cx: center.x + size * marker.at.x,
        cy: center.y + size * marker.at.y,
        radius: outerRadius(size),
        // Every preprinted city on this board is 1-slot; a pill would need
        // the marker pass to draw one too, and it does not.
        span: 0,
        angleRad: 0,
      });
    }
  }

  return masks;
}

/** Clips `ctx` to everything EXCEPT the given markers. Caller saves and
 *  restores. */
function clipOutsideCityMasks(ctx: CanvasRenderingContext2D, masks: readonly CityMask[]): void {
  if (masks.length === 0) return;
  ctx.beginPath();
  /* The universe, then the holes. With `"evenodd"` a point inside one of
     the marker outlines has crossing number 2 and falls outside the clip;
     everywhere else has 1 and survives. The rect is deliberately absurd
     rather than measured -- it only has to contain the board, and the
     canvas has already clipped to itself. */
  ctx.rect(-1e6, -1e6, 2e6, 2e6);
  for (const mask of masks) {
    if (mask.span === 0) {
      ctx.moveTo(mask.cx + mask.radius, mask.cy);
      ctx.arc(mask.cx, mask.cy, mask.radius, 0, Math.PI * 2);
      continue;
    }
    /* A capsule, built the same way `drawStationPill` builds its outline:
       two half-circles joined by the implicit `lineTo` between them. Rotated
       by hand rather than with a transform, because a transform here would
       also move the `rect` above and the other masks with it. */
    const half = mask.span / 2;
    const cos = Math.cos(mask.angleRad);
    const sin = Math.sin(mask.angleRad);
    const end = (offset: number) => ({
      x: mask.cx + offset * cos,
      y: mask.cy + offset * sin,
    });
    const left = end(-half);
    const right = end(half);
    ctx.moveTo(left.x + mask.radius * Math.cos(mask.angleRad + Math.PI / 2),
               left.y + mask.radius * Math.sin(mask.angleRad + Math.PI / 2));
    ctx.arc(left.x, left.y, mask.radius, mask.angleRad + Math.PI / 2, mask.angleRad + Math.PI * 1.5);
    ctx.arc(right.x, right.y, mask.radius, mask.angleRad + Math.PI * 1.5, mask.angleRad + Math.PI / 2);
    ctx.closePath();
  }
  ctx.clip("evenodd");
}

/* ==================================================================
 *  DESIGN NOTE 380: THE HIT TEST IS THE GEOMETRY, NOT THE HEX
 * ==================================================================
 *
 * REPORTED: route hover relies on hex overlap, so two trains sharing a hex
 * abort the highlight rather than resolving it.
 *
 * `HexGridRenderer` design note #374 chose that shape and defended it:
 * "pixel-perfect proximity would mean re-deriving every authored `Path2D`
 * under its transform and running `isPointInStroke` per frame, for a gain
 * the player cannot see: routes run along rails, and a rail occupies its
 * hex." The premise was right and the conclusion was wrong. The gain is
 * exactly the case that note ALSO had to special-case -- a shared hex --
 * and it is not rare, it is the position that makes route colours worth
 * having at all.
 *
 * THE COST WAS OVERSTATED TOO. Nothing needs re-deriving per frame. Every
 * route stroke already passes through ONE function (`strokePaths` below)
 * which knows both the authored path and the exact transform it is drawn
 * under, so the flattened geometry is a by-product of the draw that already
 * happened. It is built once per repaint, not once per pointer move.
 *
 * WHAT IS RETURNED is one `Path2D` per train, in BOARD pixels -- the space
 * after the per-hex translate/rotate/scale and before the view's pan/zoom.
 * That is the space `size` is measured in, so the caller strokes it at
 * `routeHitWidth` and applies only the view transform. Flattening at draw
 * time rather than storing (path, matrix) pairs means the hit test is one
 * `isPointInStroke` per train rather than one per hex per train.
 *
 * `DOMMatrix` IS REQUIRED and is checked for. `Path2D.addPath` takes a
 * matrix and there is no way to compose a transform into a path without
 * one; where it is missing (an old engine, a test environment) the map
 * comes back empty and the caller keeps its hex-grained behaviour rather
 * than losing hover entirely.
 */
/* ==================================================================
 *  DESIGN NOTE 380: HOW WIDE A ROUTE IS TO A POINTER
 * ==================================================================
 *
 * The drawn route is exactly a third of the rail (design note #268), which
 * at ordinary zoom is two or three pixels -- a target no hand can hit and
 * no trackpad can hold. This multiplies the pen for the HIT TEST only; the
 * painted line is untouched.
 *
 * A WIDER PEN, not a search radius. Stroke width grows perpendicular to
 * the curve wherever it goes, so a tolerance expressed this way follows
 * the bend; a radius around the pointer would also catch a route running
 * parallel a few pixels away, which is exactly the discrimination this
 * whole change exists to gain.
 *
 * 4x lands the target near 10px at the default hex size, which is the
 * usual floor for a pointer affordance, and stays proportional at every
 * zoom because the underlying width already is. */
export const ROUTE_HIT_TOLERANCE = 4;

export interface RouteHitPaths {
  /** Flattened board-space stroke geometry, by `trainIndex`. */
  paths: Map<number, Path2D>;
  /** The width those paths were drawn at, in board pixels. The caller must
   *  stroke-test at this or wider -- a hairline is unhittable. */
  routeWidth: number;
}

export function drawRouteOverlays(
  ctx: CanvasRenderingContext2D,
  size: number,
  overlays: readonly RouteOverlay[],
  /** Design note #155: the laid tiles, so the ribbon can follow each hex's
   *  REAL authored rails instead of a generic curve through its middle.
   *  Optional -- omitted, every hex falls back to the generic curve, which
   *  is exactly the previous behaviour. */
  tilesAt?: (q: number, r: number) => { tile_id: number; orientation: number } | undefined,
  /** Design note #215: the preprinted hex label at `(q, r)`, so the glow can
   *  pick the ONE printed rail a train runs along instead of lighting up
   *  every rail on the hex. `undefined` for a hex with no printed track. */
  printedLabelAt?: (q: number, r: number) => string | undefined,
): RouteHitPaths {
  /* Design note #380: accumulated as the routes are drawn. Declared before
     the early return so the shape of the result never depends on whether
     there was anything to draw. */
  const hitPaths = new Map<number, Path2D>();
  const canFlatten = typeof DOMMatrix !== "undefined";

  if (overlays.length === 0) return { paths: hitPaths, routeWidth: Math.max(3, size * 0.12) / 3 };

  /* `apothem` is GONE with design note #216's fallbacks. It existed only to
     place edge midpoints for the two re-derived curves, and nothing in this
     function computes a coordinate any more -- every stroke is an authored
     `Path2D` under a translate/rotate/scale. */

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  /* ==================================================================
   *  DESIGN NOTE 255: A THIN SOLID LINE ON THE RAIL
   * ==================================================================
   *
   * This has now been three things, and the third is the one that was asked
   * for. Worth recording the whole arc, because each step was a reaction to
   * the previous one overshooting:
   *
   *   1. AN OPAQUE BAR at `size * 0.17` -- wider than the `0.12` rail, so it
   *      replaced the track artwork rather than marking it.
   *   2. A TRANSLUCENT HALO (design note #245) -- two wide low-alpha passes
   *      with a heavy shadow. It stopped covering the rail and started
   *      muddying it: translucent colour over hand-authored artwork tints
   *      everything it crosses without ever reading as a definite line.
   *   3. THIS. A solid line, THINNER than the rail, drawn on top of it.
   *
   * The third works because of the width relationship rather than in spite
   * of it. At 55% of the rail's width the track's own dark ink remains
   * visible on both sides of the route line, so the artwork still reads as
   * track while the line reads as a route drawn along it -- the way a
   * highlighted route looks on a physical board, a coloured thread laid in
   * the groove rather than a wash over the tile.
   *
   * THE COLOUR IS THE CORPORATION'S, supplied per overlay -- see design note
   * #254 in `App.tsx`.
   *
   * ==================================================================
   *  DESIGN NOTE 268: A THIRD OF THE RAIL, WITH A REAL GLOW
   * ==================================================================
   *
   * Two revisions to the above, both reported, and the second reverses a
   * decision this note argued for -- so it is worth being straight about
   * why rather than quietly editing the history.
   *
   * WIDTH: 55% -> exactly one THIRD of the rail. 55% left the rail's ink
   * showing as two thin slivers, which is enough to prove the track is
   * still there and not enough to read as track. At a third the route
   * unambiguously sits IN the groove rather than filling it.
   *
   * THE SHADOW COMES BACK. Design note #255 removed it, and the reasoning
   * was sound for the line it was describing: a soft edge on a wide bar
   * costs definition, and the bar was the problem. It does not follow for a
   * line a third the width of the rail. A hairline of flat colour on a dark
   * board is hard to pick out at low zoom and reads as an artefact rather
   * than as a deliberate mark -- the glow is what makes a thin line
   * legible, not what blurs a thick one.
   *
   * So the stroke is TWO PASSES over the same authored path:
   *
   *   1. GLOW  -- the same path, same width, with `shadowBlur`. Canvas
   *      blooms a shadow symmetrically around what it draws, so a thin
   *      stroke with a wide blur is a halo with nothing solid in it.
   *   2. CORE  -- the same path again, shadow off, fully opaque. This is
   *      the crisp line; it lands exactly on top of the halo's centre.
   *
   * Two passes rather than one shadowed stroke because a single pass gives
   * a line whose own edges are soft. Drawing the core again over the glow
   * keeps design note #255's crispness AND adds the halo around it, which
   * is the combination asked for.
   *
   * The blur scales with `size` so the halo is the same relative weight at
   * every zoom, rather than a fixed pixel bloom that swamps the board when
   * zoomed out and vanishes when zoomed in.
   */
  const railWidth = Math.max(3, size * 0.12);
  /* Exactly a third. No `Math.max` floor: `railWidth` is itself floored at
     3, so this cannot go below 1px, and a floor here would silently break
     the stated ratio at small zooms -- which is the number that was asked
     for. */
  const baseRouteWidth = railWidth / 3;
  const glowBlur = Math.max(4, size * 0.18);

  for (const overlay of overlays) {
    if (overlay.hexes.length < 2) continue;
    ctx.strokeStyle = overlay.color;

    /* Design note #373: the emphasis, applied as WIDTH and ALPHA rather
       than as a different colour. The colour is the route's identity --
       changing it to signal a hover would break the very correspondence
       this feature exists to make visible. Width and opacity say "this
       one" without saying "a different one".

       The muted pass stays fully drawn rather than being skipped: a route
       that vanishes while you hover its neighbour is worse than one that
       recedes, because the player loses the comparison they were making. */
    const emphasis: RouteEmphasis = overlay.emphasis ?? "normal";
    const widthScale = emphasis === "primary" ? 2.2 : 1;
    const alpha = emphasis === "muted" ? 0.32 : 1;

    /* Design note #380: this train's flattened geometry, filled in by
       `strokePaths` as each hex is drawn. Keyed on `trainIndex` because
       that is the join the whole cross-highlight runs on (design note
       #373); an overlay without one cannot be hovered to any purpose and
       is not collected. */
    const hitPath =
      canFlatten && overlay.trainIndex !== undefined ? new Path2D() : null;
    if (hitPath && overlay.trainIndex !== undefined) {
      hitPaths.set(overlay.trainIndex, hitPath);
    }

    // Walk HEXES, not pairs. The old loop drew each hop as two half-curves
    // (centre -> crossing, crossing -> next centre), which meant one hex's
    // two halves were produced by two different iterations and neither knew
    // the other's edge. Tracing a real rail needs BOTH of a hex's edges at
    // once -- that is what identifies which authored path the train is on --
    // so the iteration is now per hex, with the entry and exit edges in hand
    // together.
    for (let index = 0; index < overlay.hexes.length; index += 1) {
      const [q, r] = overlay.hexes[index];
      const center = axialToPixel(q, r, size);

      const edgeToward = (target: [number, number] | undefined): number | null => {
        if (!target) return null;
        const found = HEX_NEIGHBOR_OFFSETS.findIndex(
          ([dq, dr]) => q + dq === target[0] && r + dr === target[1],
        );
        return found < 0 ? null : found;
      };

      const entryEdge = edgeToward(overlay.hexes[index - 1]);
      const exitEdge = edgeToward(overlay.hexes[index + 1]);
      // Not adjacent to either neighbour: nothing honest to draw. Skipped
      // rather than bridged with a straight line across the board, which is
      // the long-standing behaviour this preserves.
      if (entryEdge === null && exitEdge === null) continue;

      /* ================================================================
       *  DESIGN NOTE 216: THE GLOW IS `Path2D`, ALL THE WAY DOWN
       * ================================================================
       *
       * Two procedural fallbacks used to sit below this branch and both are
       * now deleted. They are worth naming, because the second was the
       * reported "straight lines to the hex centre" outright:
       *
       *   FALLBACK A re-derived a tile's connecting segment with
       *   `drawDoubleTownRoute` whenever the artwork lookup missed. It
       *   missed constantly, because the catalog covered 22 of 46 tiles.
       *   It now covers all 46, so a laid tile's rail is ALWAYS an authored
       *   `Path2D` and there is nothing left to re-derive.
       *
       *   FALLBACK B drew two `bezierTrackSegment` half-curves, edge to
       *   centre and centre to edge. That construction is a straight line by
       *   arithmetic, not by accident: the first control point goes out
       *   along the edge's inward normal, which points exactly at the
       *   centre, and the second goes back along the chord -- both collinear
       *   with the straight edge-to-centre segment, so the cubic degenerates.
       *   A two-hex route was two of those meeting at a shared edge: one
       *   straight bar spanning two hex centres, which is precisely the
       *   symptom. Deleting it is the fix; there is no "and also make it
       *   curve" version of that code, because the shape it wanted never
       *   existed as a curve.
       *
       * WHAT REMAINS IS ONE RULE, applied four ways: stroke the authored
       * `Path2D` the train actually ran along, and nothing else.
       *
       * DESIGN NOTE 226 removed the last exception. A third branch used to
       * re-run the whole hex's renderer, lighting every rail on it. That was
       * reached by both ENDPOINTS of every route -- they have one edge each,
       * so there was no traversal to resolve -- which made it the common
       * case rather than a fallback, and it produced the reported bug
       * directly: New York prints TWO physically disconnected spurs, so a
       * train stopping at one lit both and the map claimed a run to a city
       * the corporation never reached. Every crossing tile (#20, #55, #68)
       * had the same problem in miniature.
       *
       * An endpoint is not ambiguous, though. The train came in along the
       * rail that TOUCHES the edge it entered by, so that rail is the answer
       * -- `artworkPathsForEdge` (design note #225) returns it.
       *
       *   1. LAID TILE, both edges     -> the traversed rail(s).
       *   2. PREPRINTED HEX, both edges -> the same, printed catalog.
       *   3. LAID TILE, one edge        -> the rail meeting that edge.
       *   4. PREPRINTED HEX, one edge   -> the same, printed catalog.
       *
       * NOTHING MATCHES, NOTHING IS DRAWN. A hex whose track does not
       * connect the edges the player chained through has no rail to
       * highlight, and inventing one is the class of claim this whole family
       * of notes exists to remove. The gap in the ribbon is the honest
       * rendering of a route that does not join up. */

      const laid = tilesAt?.(q, r);
      const printedLabel = printedLabelAt?.(q, r);

      /** Strokes authored paths under the transform their renderer uses --
       *  glow then core, design note #268. `rot` is 0 for preprinted
       *  artwork, which has one fixed facing. */
      const strokePaths = (paths: readonly Path2D[], rot: number) => {
        /* Design note #380: the hit geometry is composed from the SAME
           three transforms the stroke below applies, in the same order --
           translate to the hex centre, rotate the tile's facing, scale out
           of unit-hex space. Built here rather than recomputed later so
           the two can never describe different curves; if the draw moves,
           this moves with it because it reads the same `center`, `rot` and
           `size`.

           The city-mask clip is NOT applied. It punches holes where station
           tokens sit so the ribbon does not paint over them -- a painting
           concern. A route still RUNS through the city it stops at, and a
           player hovering the middle of a station means that route. */
        if (hitPath) {
          const matrix = new DOMMatrix()
            .translate(center.x, center.y)
            .rotate(rot === 0 ? 0 : (-60 * rot))
            .scale(size);
          for (const path of paths) hitPath.addPath(path, matrix);
        }

        ctx.save();
        // Design note #267: the city markers on THIS hex become holes, so
        // neither the glow nor the core lands on a station token. Set
        // before the transform below, because the masks are already in
        // board pixels.
        clipOutsideCityMasks(ctx, cityMasksForHex(laid, printedLabel, center, size));
        ctx.translate(center.x, center.y);
        if (rot !== 0) ctx.rotate((-60 * rot * Math.PI) / 180);
        ctx.scale(size, size);
        // The catalog is authored in unit-hex space, so the transform scales
        // the pen too -- divide back out to land on the same on-screen width
        // at every zoom.
        // Design note #373: the emphasis scales the pen, not the colour.
        ctx.lineWidth = (baseRouteWidth * widthScale) / size;
        ctx.globalAlpha = alpha;

        // Design note #268, pass 1: the halo. `shadowBlur` is in board
        // pixels and is NOT affected by the transform's scale, so it is set
        // raw rather than divided back out like the pen width.
        // Design note #373: a primary route's halo grows with it, which is
        // what makes it read as lit rather than merely thicker.
        ctx.shadowBlur = emphasis === "primary" ? glowBlur * 1.6 : glowBlur;
        ctx.shadowColor = overlay.color;
        for (const path of paths) ctx.stroke(path);

        // Pass 2: the crisp core, on top of its own halo.
        ctx.shadowBlur = 0;
        ctx.shadowColor = "transparent";
        for (const path of paths) ctx.stroke(path);
        ctx.restore();
      };
      const strokeAuthored = (paths: readonly Path2D[], indices: number[], rot: number) =>
        strokePaths(
          indices.map((index) => paths[index]),
          rot,
        );

      const terminalEdge = entryEdge ?? exitEdge;
      const isEndpoint = entryEdge === null || exitEdge === null;

      // ---- 1 & 3: a laid tile. ----
      if (laid) {
        const rot = ((laid.orientation % 6) + 6) % 6;

        /* Design note #244: an ENDPOINT stops at the station.
           A through-tile's rail passes its revenue centre and carries on out
           the far edge; a train that terminates here does not. The terminal
           rail is the same authored curve, cut at the marker. */
        if (isEndpoint && terminalEdge !== null) {
          const rail = terminalRailAtEdge(laid.tile_id, laid.orientation, terminalEdge);
          if (rail) {
            strokePaths([rail], rot);
            continue;
          }
        }

        // A through hex: one path for a through tile, TWO for a hub (entry
        // spoke + exit spoke, tracing edge -> city -> edge). See
        // `artworkPathsForTraversal`.
        const indices =
          entryEdge !== null && exitEdge !== null
            ? artworkPathsForTraversal(laid.tile_id, laid.orientation, entryEdge, exitEdge)
            : artworkPathsForEdge(laid.tile_id, laid.orientation, terminalEdge!);
        const paths = indices.length > 0 ? tileArtworkPaths(laid.tile_id) : undefined;
        if (paths && indices.every((index) => paths[index])) {
          strokeAuthored(paths, indices, rot);
          continue;
        }
      }

      // ---- 2 & 4: a preprinted hex -- design notes #215 and #225. ----
      if (printedLabel !== undefined) {
        // Design note #244: same cut for a preprinted city, whose station
        // sits on its curve's apex rather than at a rail's end.
        if (isEndpoint && terminalEdge !== null) {
          const rail = printedTerminalRailAtEdge(printedLabel, terminalEdge);
          if (rail) {
            strokePaths([rail], 0);
            continue;
          }
        }

        const indices =
          entryEdge !== null && exitEdge !== null
            ? printedPathsForTraversal(printedLabel, entryEdge, exitEdge)
            : printedPathsForEdge(printedLabel, terminalEdge!);
        const paths = indices.length > 0 ? printedArtworkPaths(printedLabel) : undefined;
        if (paths && indices.every((index) => paths[index])) {
          strokeAuthored(paths, indices, 0);
          continue;
        }
      }
    }
  }

  ctx.restore();
  // Design note #380: the width the caller must stroke-test at, in the same
  // board pixels the paths are expressed in.
  return { paths: hitPaths, routeWidth: baseRouteWidth };
}

/** The pan/zoom the board was drawn under. Structural, so the hit test can
 *  be called with a plain object rather than the renderer's view state. */
export interface RouteHitView {
  panX: number;
  panY: number;
  zoom: number;
}

/**
 * Which route's LINE is under `(cssX, cssY)`, or `null` for none.
 *
 * ==================================================================
 *  DESIGN NOTE 381: THE HIT TEST LIVES WITH THE DRAW
 * ==================================================================
 *
 * This began inside `HexGridRenderer`'s pointer handler, which is where a
 * pointer handler's logic belongs -- until you try to test it, and find
 * that reaching it means mounting a React component around a real canvas
 * to synthesise a `PointerEvent`. Nothing here needs any of that: it needs
 * a context, some paths, a point and a view.
 *
 * MORE IMPORTANTLY, THE CORRECTNESS ARGUMENT IS ABOUT THE DRAW. Every line
 * below exists to mirror something `drawRouteOverlays` did -- its
 * transform, its pen width, its caps and joins. Two functions in one file
 * that must agree can be read together; the same pair 1,600 lines apart in
 * different modules drift, and the drift is invisible because a hit test
 * that is subtly wrong still returns plausible answers.
 *
 * `isPointInStroke` IS ASYMMETRIC, and this is the whole difficulty. The
 * PATH is transformed by the current matrix; the POINT is read in the
 * canvas's own bitmap space, explicitly unaffected by that matrix. Since
 * the renderer sizes its backing store at `width * dpr`, that bitmap space
 * is device pixels, so:
 *
 *   - the matrix is rebuilt as `dpr` then pan then zoom, exactly the order
 *     the draw applies them, and
 *   - the CSS-pixel point is multiplied INTO device pixels.
 *
 * Doing one without the other is worse than doing neither. With neither,
 * both spaces are CSS pixels and the test is merely un-scaled -- correct at
 * 1x. With one, they disagree by exactly `dpr` on every HiDPI screen.
 *
 * THE PEN IS WIDENED, NOT THE SEARCH. `isPointInStroke` measures against
 * `lineWidth`/`lineCap`/`lineJoin`, so a test at the default 1px would miss
 * a line drawn at 4. The route is deliberately a third of the rail (design
 * note #268), which is a target no hand can hit, so it is tested at
 * `ROUTE_HIT_TOLERANCE` times its drawn width. Widening the pen keeps the
 * tolerance perpendicular to the curve, which is what a player means by
 * "near the line"; a radius search around the point would also catch
 * anything running alongside it.
 *
 * FIRST HIT WINS. Two routes are indistinguishable here only if they run
 * the SAME rail, where there is no answer to prefer -- unlike design note
 * #374's hex test, which gave up whenever two routes merely shared a tile.
 * That case is now answered, and it is the one this exists for.
 */
export function hitTestRoutes(
  ctx: CanvasRenderingContext2D,
  hit: RouteHitPaths,
  cssX: number,
  cssY: number,
  view: RouteHitView,
  dpr: number,
): number | null {
  if (hit.paths.size === 0) return null;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);
  ctx.lineWidth = hit.routeWidth * ROUTE_HIT_TOLERANCE;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Into the bitmap space the point is read in -- see above.
  const deviceX = cssX * dpr;
  const deviceY = cssY * dpr;

  let found: number | null = null;
  hit.paths.forEach((path: Path2D, trainIndex: number) => {
    if (found === null && ctx.isPointInStroke(path, deviceX, deviceY)) {
      found = trainIndex;
    }
  });
  ctx.restore();
  return found;
}

/** GENERIC PLACEHOLDER ARTWORK for a `tile_id` that isn't in this file's
 *  `TILE_CATALOG` mirror (design note #118, requirement 3).
 *
 *  Both render paths that decode a laid tile -- the main board loop in
 *  `draw()` and `TilePreviewThumbnail` -- previously handled an unknown id
 *  by printing a bare red `#N?` string on a flat grey hex. That was safe
 *  (it never threw), but it degraded to something the player can't act on:
 *  the tile-picker carousel in `TileSelectionPopup.tsx` offers whatever
 *  `GetLegalTilePlacements` returns, verbatim and unfiltered (that
 *  component's own design note #4), so an id this mirror hasn't caught up
 *  to yet is still a fully legal, clickable, submittable choice -- just an
 *  unrecognisable one.
 *
 *  This draws a neutral but READABLE stand-in instead: a dashed neutral
 *  outline marking it as provisional, plus the tile number. It deliberately
 *  does NOT guess at track geometry -- there is no bitmask to decode, and a
 *  fabricated path would be worse than an honest blank, since the player
 *  would have no way to tell it apart from real artwork.
 *
 *  Callers must have already filled/stroked the hex body. Never throws;
 *  takes no catalog lookup. */
export function drawUnknownTilePlaceholder(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  tileId: number,
): void {
  ctx.save();

  ctx.beginPath();
  ctx.arc(center.x, center.y, size * 0.46, 0, Math.PI * 2);
  ctx.setLineDash([size * 0.16, size * 0.12]);
  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = Math.max(1.5, size * 0.06);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#4a4a4a";
  ctx.font = `${Math.max(9, Math.round(size * 0.34))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`#${tileId}`, center.x, center.y);

  ctx.restore();
}

/** A large 1830-style station circle: white fill, dark outline -- used for
 *  `MajorCityHub` laid tiles and every landmark's pre-printed station (see
 *  design notes #3b/#6b). */
export function drawStationCircle(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, size * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.stroke();
}

/** A MULTI-SLOT city station -- design note #133.
 *
 *  Real 18xx cardboard draws a city that can hold N tokens as an elongated
 *  oval ("pill"), N circles wide, not as a bigger circle. That shape is
 *  load-bearing information: it is the only thing on the tile that tells a
 *  player a second company can still build into this city. A 2-slot city
 *  rendered as a plain circle -- which is what every city on this board did
 *  before this pass -- reads as "full", and misleads the player about a
 *  decision they are actively making.
 *
 *  Geometry is two half-circles of the SAME `size * 0.22` radius
 *  `drawStationCircle` uses, joined by straight sides. Consecutive
 *  `ctx.arc` calls inside one path auto-connect with an implicit `lineTo`,
 *  so the sides come for free and the outline is a single closed path --
 *  which matters, because it means one `fill()` and one `stroke()` with no
 *  seam where the two ends meet.
 *
 *  SPACING: centre-to-centre `1.6 * r`, not the `2 * r` that would place two
 *  exactly-tangent circles. Real cardboard overlaps its slot circles
 *  slightly, and at a full `2 * r` the pill on #63 (six radial spokes)
 *  grows long enough to reach its own track arms.
 *
 *  `angleDeg` is the long axis in BOARD space -- the caller has already
 *  folded in the tile's orientation. Markers are drawn outside the
 *  artwork's rotated/scaled transform (see `drawHardcodedTileArtwork`), so
 *  without this a rotated tile would keep a stubbornly horizontal pill
 *  sitting across its own track. */
export function drawStationPill(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
  slots: number,
  angleDeg: number,
): void {
  const radius = size * 0.22;
  const spacing = PILL_SLOT_SPACING * radius;
  const span = spacing * (slots - 1);

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate((angleDeg * Math.PI) / 180);

  // ---- 1. The outer capsule. ----
  ctx.beginPath();
  ctx.arc(-span / 2, 0, radius, Math.PI / 2, Math.PI * 1.5);
  ctx.arc(span / 2, 0, radius, Math.PI * 1.5, Math.PI / 2);
  ctx.closePath();

  // Identical fill/stroke to `drawStationCircle` -- a 1-slot and a 2-slot
  // city must read as the same KIND of object, differing only in length.
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.stroke();

  // ---- 2. The slot rings. ----
  // One thin circle per slot, INSIDE the capsule, at the exact centres
  // `tileCitySlotPoints` will place tokens on. This is what makes the pill
  // countable: the outline alone says "this city is bigger", the rings say
  // "it holds exactly two". On real cardboard these are the printed circles
  // the wooden tokens drop into.
  //
  // Drawn at roughly HALF the capsule's own stroke weight and never filled,
  // so they read as an internal division of one station rather than as two
  // separate stations that happen to touch -- the distinction matters most
  // on #62, where two genuinely separate 2-slot cities sit on one tile and
  // must not be confusable with one 4-slot city.
  ctx.lineWidth = Math.max(1, size * 0.03);
  for (let slot = 0; slot < slots; slot += 1) {
    const offset = -span / 2 + spacing * slot;
    ctx.beginPath();
    // Design note #151: `SLOT_RING_RATIO`, not a literal. The token that
    // docks here reads the same constant (`tileCityTokenRadius`), so the
    // ring and its occupant are the same circle by construction.
    ctx.arc(offset, 0, radius * SLOT_RING_RATIO, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

/** A small 1830-style town/dit stop marker (design note #59: Lightweight
 *  Solid Black Dot Primitive; radius tuned up by design notes #60 then
 *  #61): a plain solid black filled dot, NO stroke/outline/border and NO
 *  station-container styling of any kind -- a small town sits directly on
 *  or along the track spline as a simple mark, never a buildable city
 *  station hub. Radius `size * 0.14` (design note #61: a second
 *  visual-feedback pass, still too small at #60's `size * 0.112` -- settled
 *  on the same `0.14` MAGNITUDE `drawDitMarker` used before #59, just
 *  without that version's `#141414` fill or `#d8d8d8` ring stroke; ~64% of
 *  `drawStationCircle`'s own `size * 0.22` white city-circle radius, still
 *  visibly smaller than a city station so towns stay distinct at a
 *  glance). Positioning math is UNCHANGED (every call site still passes
 *  the exact same point/size arguments it always has -- see design notes
 *  #54/#55/#58 for that layout); this remains a primitive-styling-only
 *  change, used everywhere a town/dit marker is drawn in this file:
 *  `drawTrackPath`'s laid SmallTown/DoubleTown tiles, `drawPrintedTrack`'s
 *  pre-printed gray-hex towns, and the blank Town/Double-Town-designated
 *  hexes' own marker pass in `draw()`. */
export function drawDitMarker(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, size * 0.14, 0, Math.PI * 2);
  ctx.fillStyle = "#000000";
  ctx.fill();
}

/** Maps each value-badge-bearing terrain to its badge SHAPE (design note
 *  #62: Shape-Based Revenue Badge Iconography) -- REPLACES the old
 *  `VALUE_BADGE_COLOR` color-coded palette (SmallTown/DoubleTown amber vs.
 *  MajorCityHub/DoubleCityHub crimson). Every revenue badge on the board
 *  uses the SAME solid white fill/dark-navy stroke (see `drawBadgeShape`).
 *
 *  ALL-SQUARE, design note #65: town badges were originally diamonds (the
 *  town-vs-city distinction color used to carry, moved to shape); reported
 *  the diamond's inherent taper -- `badgeRadiusForLabel`'s own doc comment
 *  derives why a diamond needs `halfWidth + halfHeight` of radius just to
 *  clear a text corner, structurally larger than the square's
 *  `max(halfWidth, halfHeight)` -- was taking up too much room. Every
 *  terrain now maps to `"square"`; the board's shape-based iconography
 *  simplifies to: white circles = city stations, small black dots = towns,
 *  white squares = every revenue badge (city, town, and off-board alike).
 *  `"diamond"` stays a valid `drawBadgeShape`/`badgeRadiusForLabel` option
 *  (dead code, not deleted) in case a future pass wants shape-coding back. */
/** Design note #288: the two landmark hub terrains are here so an upgraded
 *  G19 or E23 has a shape like every other city. Square, because that is
 *  what every city on this board draws -- the field is kept because design
 *  note #62's shape coding is a real axis even where it currently has one
 *  value. */
export type ValueBadgeTerrain =
  | "SmallTown"
  | "DoubleTown"
  | "MajorCityHub"
  | "DoubleCityHub"
  | "NewYorkHub"
  | "BostonHub";

export const VALUE_BADGE_SHAPE: Readonly<Record<ValueBadgeTerrain, "square" | "diamond">> = {
  SmallTown: "square",
  DoubleTown: "square",
  MajorCityHub: "square",
  DoubleCityHub: "square",
  NewYorkHub: "square",
  BostonHub: "square",
};

/** Draws a revenue-badge shape (design note #62): a solid white
 *  (`#FFFFFF`) fill with a `#1E293B` dark-navy stroke, `lineWidth = 1.5` --
 *  the literal, board-wide-uniform styling every revenue badge uses now,
 *  replacing the old per-terrain color-coded circle fills. `"square"` for
 *  city hub and off-board revenue, `"diamond"` (a square rotated 45
 *  degrees, same corner-to-center reach as a circle of the same `radius`,
 *  so it fits the exact same footprint the old circle badge did) for town
 *  revenue. The square's half-side is `radius * Math.SQRT1_2` -- sized so
 *  its OWN farthest corner sits at exactly `radius` from center, the same
 *  maximum reach as the circle it replaces and the diamond drawn alongside
 *  it, so none of `drawValueBadge`'s own corner-placement/bleed-safety
 *  math (its own doc comment's "farthest reach stays safely inside the hex
 *  boundary" analysis) needs to change for the new shapes to stay just as
 *  safe as the circle was. */
export function drawBadgeShape(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  radius: number,
  shape: "square" | "diamond",
): void {
  ctx.beginPath();
  if (shape === "square") {
    const half = radius * Math.SQRT1_2;
    ctx.rect(center.x - half, center.y - half, half * 2, half * 2);
  } else {
    ctx.moveTo(center.x, center.y - radius);
    ctx.lineTo(center.x + radius, center.y);
    ctx.lineTo(center.x, center.y + radius);
    ctx.lineTo(center.x - radius, center.y);
    ctx.closePath();
  }
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.strokeStyle = "#1E293B";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Computes the SMALLEST `drawBadgeShape` radius that fully contains
 *  `label` (already measured via `ctx.measureText` under the caller's own
 *  bold font) with `paddingX`/`paddingY` clearance on every side, for the
 *  given `shape` -- design note #63 (Text-Driven Badge Sizing): previously
 *  `drawValueBadge` fixed the badge's radius first and shrank the font
 *  down (as low as 5px) to whatever fit inside it, which clipped/crowded
 *  longer values; this inverts that relationship, sizing the badge AROUND
 *  a fixed, always-legible bold font instead, the same "measure text, size
 *  the box around it" approach `drawLabelWithBackground` already uses
 *  elsewhere in this file for nameplate shield boxes.
 *
 *  For `"square"`: a square of half-side `h` needs `h >= textWidth/2 +
 *  paddingX` AND `h >= textHeight/2 + paddingY` (its sides are axis-
 *  aligned, so width and height clearance are independent) -- solved for
 *  the `radius` `drawBadgeShape` itself expects (`half = radius *
 *  Math.SQRT1_2`, see that function's own doc comment) by dividing back
 *  through `Math.SQRT1_2`.
 *
 *  For `"diamond"`: a diamond of radius `r` (vertices at `(±r, 0)`/`(0,
 *  ±r)`) has boundary `|x| + |y| = r`, so the widest the diamond gets AT
 *  the text's own vertical extent (`y = textHeight / 2` from center) is
 *  `|x| = r - textHeight / 2` -- solved for `r` so that half-width still
 *  clears `textWidth / 2 + paddingX` at that same height:
 *  `r = textWidth / 2 + paddingX + textHeight / 2 + paddingY`. */
export function badgeRadiusForLabel(
  metrics: TextMetrics,
  fontSizePx: number,
  shape: "square" | "diamond",
  paddingX: number,
  paddingY: number,
  minRadius: number,
): number {
  const textWidth = metrics.width;
  const ascent = metrics.actualBoundingBoxAscent ?? fontSizePx * 0.75;
  const descent = metrics.actualBoundingBoxDescent ?? fontSizePx * 0.25;
  const textHeight = ascent + descent;
  const neededRadius =
    shape === "square"
      ? Math.max(textWidth / 2 + paddingX, textHeight / 2 + paddingY) / Math.SQRT1_2
      : textWidth / 2 + paddingX + (textHeight / 2 + paddingY);
  return Math.max(minRadius, neededRadius);
}

/** Design note #70 (13-Slot Perimeter Anchor System): the four CORNER slots
 *  `drawValueBadge` ever places a badge at, in PREFERENCE ORDER, expressed
 *  as slot numbers in the shared `hexSlotPoint`/`hexSlotDirection` numbering
 *  (7-12 = corner vertices; see that system's own doc comment). SUPERSEDES
 *  the old file-local `BADGE_CORNERS` array (dx/dy + bespoke `guardEdges`
 *  pairs) -- same four corners, same preference order (both lower corners
 *  first, since every name-label pass in this file draws in the hex's UPPER
 *  area, so neither lower corner ever collides with a name; the two upper
 *  corners as a last resort), but now resolved through the shared
 *  `hexBlockedSlots`/`pickHexSlot` engine instead of a private tiered
 *  search, so this badge and every other label/nameplate/badge in the file
 *  agree on the same slot geometry and the same live/dead-edge blocking
 *  rules. Slot 11 = Lower-Left, 9 = Lower-Right, 12 = Upper-Left,
 *  8 = Upper-Right -- see `drawValueBadge`'s own doc comment for the full
 *  tier ordering this preference list feeds into. */
// Design note #76: appends the two FAR-side edge slots (6/NW, 5/W) as an
// explicit early fallback, ahead of `extendSlotPreference`'s purely neutral
// ascending tail -- reported (G19): even after cross-pass claiming (#72)
// gave every element a mathematically distinct slot, the revenue badge's
// own four corner preferences were all blocked/claimed on a hex as crowded
// as G19, so it fell all the way to the neutral fallback's ascending order,
// which handed back slot 2 (0 degrees) -- angularly RIGHT NEXT TO the
// terrain icon (slot 3, 60 degrees) and terrain-cost label (slot 9, 30
// degrees) it was trying to avoid. Distinct slots, but not distinct enough
// for four real UI elements' own visual footprint at that radius. 6 and 5
// sit on the OPPOSITE side of the hex from that icon/cost cluster, so a
// badge forced past its own corners lands somewhere genuinely clear instead
// of merely technically-unclaimed.
export const BADGE_SLOT_PREFERENCE: readonly number[] = [11, 9, 12, 8, 6, 5, 2, 3];

/** Draws one small, crisp city/town value badge (design note #26/item 5,
 *  constrained by item 7 of the structural calibration pass; ADAPTIVE
 *  PLACEMENT follow-up below, generalized by design note #39; shape/color
 *  REPLACED by design note #62) -- `terrainBaseValue`'s flat $ value for
 *  `terrain`, in a solid white, dark-navy-stroked badge shape-coded via
 *  `VALUE_BADGE_SHAPE` (square for city hubs, diamond for towns -- see
 *  `drawBadgeShape`'s own doc comment). Offset toward whichever of the
 *  hex's four corners (never hex center, where the track/station marker
 *  already sits) is actually free of both printed track and a name label,
 *  so the badge never collides with either.
 *
 *  ADAPTIVE PLACEMENT (reported: the previous single fixed upper-right
 *  corner routinely collided with this file's own city-name labels, which
 *  moved into that same upper area in an earlier pass -- worst on G19/New
 *  York, where the upper-right corner is ALSO exactly where its real
 *  printed NE track stub runs, stacking the badge on top of the track, the
 *  station circle, AND the name all at once). Tries each of `BADGE_CORNERS`
 *  in preference order across four tiers, most-preferred first:
 *
 *   1. No `guardEdges` overlap with `liveEdges` AT ALL, AND at least one
 *      `guardEdges` entry is a permanently dead edge (`deadEdgesAt(q, r)`,
 *      design note #39) -- both no current track collision risk AND a
 *      structural guarantee no FUTURE track can ever appear there either.
 *   2. At least one `guardEdges` entry is dead, even if the other currently
 *      has live track -- reported: I15/Baltimore's real edge-0/edge-4
 *      through-route blocks BOTH lower corners under tier 3 below (edge 4
 *      guards lower-left, edge 0 guards lower-right), forcing the badge
 *      into upper-left, which collides with Baltimore's own name label --
 *      even though edge 0's neighbor (I17) is a real hex, edge 5 (lower-
 *      right's OTHER guard) points off the board's actual footprint
 *      entirely and can NEVER carry track from either side, so lower-right
 *      is preferred here over sitting in the name-colliding upper area.
 *   3. No `guardEdges` overlap with `liveEdges` -- this hex's own actual
 *      printed/laid track, in whichever edge-index form the caller already
 *      has on hand (`GRAY_HEXES`' `.edges`, `LANDMARK_TRACKS`' segments
 *      flattened, or a laid tile's `connections` mask run through
 *      `liveEdges()`/`rotateConnections()`). The original (pre-#39)
 *      adaptive-placement tier, unchanged for every hex with no dead edge
 *      at all (the overwhelming majority of the board, where tiers 1-2
 *      never match anything and this is reached first).
 *   4. Nothing above matched (every corner collides with live track, none
 *      of it against a dead edge) -- falls back to the first candidate
 *      (lower-left) anyway, the closest a four-corner model can get without
 *      a full per-hex custom-angle system, and still strictly no worse than
 *      the old always-upper-right placement.
 *
 *  `liveEdges` and `deadEdgesAt(q, r)` both empty -- an OO hex, a blank
 *  city/town designation, or any other interior hex with no real track to
 *  dodge and no board-edge boundary nearby -- skips straight to tier 3,
 *  i.e. exactly the plain "move it to the bottom-left" fallback for every
 *  hex with nothing to actively avoid or exploit.
 *
 *  Item 7 CONSTRAINT FIX (still governs the offset magnitude, unchanged by
 *  the corner becoming adaptive): the previous offset (`0.52`/`0.52`,
 *  radius `0.22`) placed the badge's farthest edge at `~0.955 * size` from
 *  hex center along its 45-degree diagonal -- but a pointy-top hex's own
 *  boundary at that diagonal (`cornerAngleRad`'s corners sit at 30/90/etc,
 *  so 45 degrees falls mid-edge, apothem-adjacent) is only `~0.897 * size`
 *  out, meaning the badge visibly bled past the hex's own border into the
 *  neighboring hex. The `0.44 * size` magnitude below is UNCHANGED and
 *  still keeps the badge's nearest edge clear of the `size * 0.22`-radius
 *  station circle at hex center, at every candidate slot alike.
 *
 *  Design note #70 (13-Slot Perimeter Anchor System): the DIRECTION that
 *  magnitude is applied along is no longer the old fixed 45-degree diagonal
 *  (`{dx: ±1, dy: ±1}`, unit-normalized implicitly by being applied to both
 *  axes) -- it's now `hexSlotDirection(slot)`, the true unit vector toward
 *  whichever real corner vertex (`cornerAngleRad`) the chosen slot names
 *  (30/150/210/330 degrees for the four badge corners, not 45/135/225/315).
 *  Since `0.44 * size` sits well inside even the nearest hex boundary
 *  point (the `~0.866 * size` apothem), this is safe at every one of the
 *  four true corner angles, not just the old diagonal approximation --
 *  see the module-level 13-Slot Perimeter Anchor System doc comment for
 *  the full slot numbering this and every other label/badge pass now
 *  shares.
 *
 *  HONEST CAVEAT (design note #63: Text-Driven Badge Sizing): the
 *  `~0.80 * size` farthest-reach bound above described the OLD fixed-
 *  radius badge; the radius is now sized around its own measured label
 *  text (`badgeRadiusForLabel`) instead of a flat constant, so a longer
 *  printed value (more digits) now produces a proportionally larger badge
 *  than a shorter one at the same hex. Every real value on this board
 *  today (`terrainBaseValue`'s flat $10/$20/$40 and every
 *  `HEX_START_VALUE_OVERRIDE` figure) is at most 2-3 digits and still
 *  comfortably clears this same boundary margin in practice -- flagged
 *  here rather than silently assumed, since it's no longer a fixed,
 *  independently-provable bound the way the old constant-radius one was. */
export function drawValueBadge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  // Design note #39: this hex's own axial coordinates, needed to look up
  // `deadEdgesAt(q, r)` -- `center` alone (a pixel position) can't recover
  // these, and every existing call site already has them on hand (they're
  // how `center` itself was computed via `axialToPixel`).
  q: number,
  r: number,
  /* Design note #288 (`HexGridRenderer.tsx`): the two LANDMARK hub terrains
     join the union. They were excluded because the landmark badge pass was
     meant to catch them first, and design note #133 later made that pass
     yield to a laid tile -- which left an upgraded G19 or E23 with no badge
     at all. `terrainBaseValue` already answers for both. */
  terrain: ValueBadgeTerrain,
  size: number,
  // Design note #35/items 2-3: an explicit $ figure that overrides
  // `terrainBaseValue(terrain)`'s flat default, for the specific named hexes
  // `HEX_START_VALUE_OVERRIDE` gives a real, sourced, non-$20/$10 value --
  // `terrain` is still passed and still drives `VALUE_BADGE_SHAPE` (design
  // note #62), so an overridden badge keeps the same square/diamond shape
  // as every other badge of its terrain, just with a different printed
  // number. Omit (or pass a hex's own $0 override -- callers check for that
  // BEFORE calling this
  // function and skip the call entirely instead, see design note #35) to
  // keep the previous flat-by-terrain behavior unchanged.
  valueOverride?: number,
  // ADAPTIVE PLACEMENT: this hex's own live track edges, if the caller has
  // them on hand -- see `BADGE_CORNERS`'s doc comment. Omitted/empty means
  // "no track to dodge," which (absent a dead edge too) resolves to the
  // lower-left corner.
  liveEdges: readonly number[] = [],
  // Design note #72: shared cross-pass claiming ledger (see
  // `claimHexSlot`'s own doc comment) -- this is the LAST of the four
  // slot-picking passes to run each render (icon, restriction badge,
  // terrain-cost label, then this one), so on a crowded hex it's the one
  // most likely to need its fallback tail; without this, it independently
  // picked the exact same corner the terrain-cost label had already
  // claimed on New York/G19 (the bug this whole design note fixes).
  claimedHexSlots: Map<string, Set<number>> = new Map(),
): void {
  const value = valueOverride ?? terrainBaseValue(terrain);
  // Design note #70: same four-tier dead/live-edge preference as before,
  // now resolved via the shared 13-slot engine -- `slotsBlockedByEdges`
  // marks a corner slot BLOCKED whenever either of its two guard edges
  // (the same pairing `BADGE_CORNERS`' `guardEdges` used to hand-encode,
  // now derived generically by `cornerSlotGuardEdges`) carries live track,
  // and `pickHexSlot` runs the identical tier search: prefer a slot that's
  // both unblocked AND dead-edge-adjacent, then any dead-edge-adjacent slot
  // even if blocked, then any unblocked slot, then the first preference.
  // Design note #72: now via `claimHexSlot`, so this badge also avoids
  // whatever the icon/restriction/cost-label passes already claimed on
  // this same hex this render.
  const blocked = slotsBlockedByEdges(liveEdges, false);
  const dead = slotsBlockedByEdges(deadEdgesAt(q, r), false);
  const revenueForce = HEX_SLOT_FORCE[`${q},${r}`]?.revenue;
  const revenueOverride = resolveSlotOverride(q, r, "revenue");
  const revenuePreference = withSlotReserve(q, r, "revenue", BADGE_SLOT_PREFERENCE);
  const slot =
    revenueForce !== undefined
      ? claimHexSlotForced(claimedHexSlots, q, r, revenueForce)
      : claimHexSlotPreferring(claimedHexSlots, q, r, revenueOverride, revenuePreference, blocked, dead);
  const direction = hexSlotDirection(slot);
  // Design note #109: magnitude INCREASED again, to `0.65` (was `0.55` per
  // #108, `0.38` per #107, `0.44` originally), direct follow-up request.
  // HONEST MARGIN CHECK, same two boundary shapes #108 checked: at a
  // CORNER slot (boundary = full `size`) there's still `size * 0.19` of
  // clearance past this file's own documented worst-case badge radius
  // (`badgeRadiusForLabel` keeps even a 3-digit value under `size * 0.16`,
  // reaching `size * 0.81`). At an EDGE slot, though (boundary = `apothem`
  // = `size * 0.866`), that same worst-case reach leaves only
  // `size * 0.056` of clearance -- noticeably tighter than #108's `0.156`,
  // and a badge printing a genuinely wide value at that exact slot could
  // start to visually crowd (though not yet mathematically cross) the hex
  // boundary there. Implemented as requested; flagging this narrowing
  // margin rather than silently accepting it, in case a future request
  // pushes this further still and actually crosses it.
  const REVENUE_BADGE_OFFSET = 0.65;
  const badgeCenter = {
    x: center.x + direction.x * size * REVENUE_BADGE_OFFSET,
    y: center.y + direction.y * size * REVENUE_BADGE_OFFSET,
  };

  // Design note #63: Text-Driven Badge Sizing + Bold Text -- fixed bold
  // font first (no more shrink-to-fit down to a barely-legible 5px), badge
  // shape sized around the MEASURED text afterward via
  // `badgeRadiusForLabel`, so the number always has clear, non-clipped
  // room inside its own badge regardless of how many digits it has.
  // TIGHTENED by design note #64: reported too large/loose after #63 --
  // font dropped 1pt, padding tightened to this file's own established
  // 2px "tight shield box" convention, and the floor dropped to a small
  // flat safety minimum instead of the old fixed-badge-era radius (which
  // was silently dominating over the text-fit calculation for every short
  // 2-digit value, defeating the whole point of sizing to the text).
  // Font dropped ANOTHER 1pt by design note #65 (now -2pt off the original
  // #63 baseline), alongside that same pass's all-square shape switch.
  // Design note #66: `$` prefix DROPPED from the printed label -- the
  // white square shape already unambiguously reads as "revenue value" on
  // its own (per #62's board-wide shape iconography), so the symbol was
  // redundant; dropping it also leaves more of the tightly-fit square for
  // the digits themselves. Font bumped back up 1pt (now -1pt net off the
  // #63 baseline, not -2) alongside this change.
  drawValueBadgeAt(ctx, badgeCenter, size, terrain, value);
}

/** THE revenue badge artwork -- design note #126.
 *
 *  Extracted VERBATIM from `drawValueBadge` so the board and the tile picker
 *  cannot render a value differently. That was the whole bug: the picker had
 *  its own white disc, its own font and its own stroke, reading as a
 *  different object from the board's shape-coded badge sitting inches away
 *  in the same window. There is now exactly one implementation of what a
 *  value looks like, and both callers go through it.
 *
 *  What stayed behind in `drawValueBadge` is PLACEMENT, not art -- the
 *  13-slot search, dead-edge avoidance and per-hex overrides all need a
 *  board position (`q`/`r`) and a live `mapGrid`, none of which an isolated
 *  tray thumbnail has. The caller decides WHERE; this decides WHAT.
 *
 *  `terrain` still drives `VALUE_BADGE_SHAPE` (design note #62's shape-coded
 *  iconography), which is why it is passed rather than just a number. */
export function drawValueBadgeAt(
  ctx: CanvasRenderingContext2D,
  badgeCenter: { x: number; y: number },
  size: number,
  terrain: ValueBadgeTerrain,
  value: number,
): void {
  const label = `${value}`;
  const fontSizePx = Math.max(9, size * 0.2) - 1;
  ctx.font = `bold ${fontSizePx}px ${FONT_FAMILY_STACK}`;
  const shape = VALUE_BADGE_SHAPE[terrain];
  const badgeRadius = badgeRadiusForLabel(ctx.measureText(label), fontSizePx, shape, 2, 1.5, 5);

  // Design note #62: solid white fill/dark-navy stroke, shape-coded by
  // terrain (square for MajorCityHub/DoubleCityHub, diamond for
  // SmallTown/DoubleTown) -- REPLACES the old per-terrain color-coded
  // circle fill (`VALUE_BADGE_COLOR`).
  drawBadgeShape(ctx, badgeCenter, badgeRadius, shape);

  // Bold black text -- no halo/stroke needed (unlike the old white-on-
  // color-fill text, black-on-white already has full contrast on its own).
  ctx.fillStyle = "#000000";
  ctx.font = `bold ${fontSizePx}px ${FONT_FAMILY_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, badgeCenter.x, badgeCenter.y);
}

/** The per-tile overlay pass: revenue badge, then restriction label --
 *  design notes #126/#127.
 *
 *  One place so all three `drawTrackPath` exits (double-town, disjoint-path,
 *  fan) get identical treatment instead of each remembering to draw both.
 *
 *  `showRevenue` is false from the main BOARD loop only: laid hexes already
 *  get a badge from `drawValueBadge`'s own placement-aware pass, which knows
 *  about off-board tiers and per-hex value overrides, so drawing here too
 *  would stamp two numbers on one hex.
 *
 * ==================================================================
 *  DESIGN NOTE 486: THE SAME ARGUMENT APPLIES TO THE RESTRICTION LABEL
 * ==================================================================
 *
 * REPORTED: upgrading an OO tile from yellow to green puts TWO "OO" markers
 * on the tile.
 *
 * It did, and the paragraph this note replaces is why. It read: "The
 * restriction label is NOT gated the same way -- `drawRestrictionBadge`
 * labels the HEX (and only the nine real B/NY/OO hexes), whereas this labels
 * the TILE, which is a different statement: it tells you what the piece in
 * your hand is restricted to, which is exactly what the tray needs and what
 * the board's hex badge cannot say."
 *
 * Every clause of that is true, and the conclusion still does not follow.
 * The two statements differ where the tile and the hex can differ -- IN THE
 * TRAY, where a piece is in the player's hand and sits on no hex at all. On
 * the BOARD they cannot differ, because 1830 only permits an OO tile to be
 * laid on an OO hex: that is what the restriction restricts. So on every
 * board hex that can ever show a tile-level label, the hex-level badge is
 * already saying the identical thing, one slot away.
 *
 * The result was two "OO"s -- `drawRestrictionBadge`'s at the upper-left
 * corner (slot 12) and this one due north -- close enough to read as a
 * rendering fault rather than as two different claims. The bug is not
 * specific to OO or to green: it fires for all nine restricted tiles, so
 * #54/#62 double "NY" on New York and #53/#61 double "B" on Boston and
 * Baltimore in exactly the same way. Only OO was reported because its
 * upgrade is the one players perform most.
 *
 * SO IT IS GATED EXACTLY LIKE `showRevenue`, for exactly the reason
 * `showRevenue` is: the board has a placement-aware pass that owns this mark
 * for the hex, and a second unaware one stamps a duplicate. Default `true`,
 * so the tray, the picker carousel and the isolated thumbnails -- every
 * caller with no hex underneath it and no hex badge to collide with -- are
 * unchanged and keep the label they genuinely need. */
export function drawTileOverlays(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  entry: TileCatalogEntry,
  showRevenue: boolean,
  /** Design note #132: the chain's `MapTileEntry.revenue` for this tile.
   *  When present it REPLACES `terrainBaseValue` outright -- including when
   *  it is `0`, which is a real answer meaning "this tile earns nothing"
   *  and correctly suppresses the badge. Only `undefined` (a contract that
   *  predates Audit G-11, or a tray thumbnail with no chain record) falls
   *  back to the terrain bucket. */
  revenueOverride?: number,
  /** Design note #486: draw the tile's own "B"/"NY"/"OO" label. `false` from
   *  the main BOARD loop and its ghost preview, where `drawRestrictionBadge`
   *  already labels the hex; `true` everywhere else. */
  showRestriction = true,
): void {
  if (showRevenue) {
    const badgeTerrain = valueBadgeTerrainFor(entry.terrain);
    // Design note #135: THE precedence chain for what a badge prints, most
    // authoritative first.
    //
    //   1. `revenueOverride` -- the chain's own `MapTileEntry.revenue` for a
    //      tile actually laid on the board. Only the board pass has one.
    //   2. `entry.revenue` -- this file's mirror of `hexmap::TILE_CATALOG`'s
    //      printed figure. THIS is what the tile picker and offline mode
    //      resolve to: a tray thumbnail has no chain record because the tile
    //      is not on the board yet, and offline there is no chain at all.
    //   3. `terrainBaseValue` -- the flat per-terrain bucket, now a genuine
    //      last resort. It is reached only by plain connector track (which
    //      correctly buckets to `0` and draws no badge) or by a tile id
    //      missing from the mirror.
    //
    // `??` throughout, deliberately, NOT `||`. A revenue of `0` is a
    // legitimate answer at every level and must beat the level below it;
    // `||` treats it as absent and falls through to exactly the wrong number
    // this chain exists to stop printing.
    const value = revenueOverride ?? entry.revenue ?? terrainBaseValue(entry.terrain);
    if (badgeTerrain && value > 0) {
      // Same offset convention as `drawValueBadge`'s own slot placement
      // (`REVENUE_BADGE_OFFSET`), pointed south-east -- a tray thumbnail has
      // no board neighbours to dodge, so it takes a fixed, predictable
      // corner instead of running the 13-slot search.
      const badgeCenter = { x: center.x + size * 0.46, y: center.y + size * 0.5 };
      drawValueBadgeAt(ctx, badgeCenter, size, badgeTerrain, value);
    }
  }

  const label = showRestriction ? restrictionLabelFor(entry.terrain) : null;
  if (label) {
    // Design note #129: the SAME `RESTRICTION_BADGE_OFFSET` distance the
    // board uses (0.65 of hex size from centre), pointed due north. A tray
    // thumbnail has no neighbours or dead edges to dodge, so it takes a
    // fixed, predictable slot rather than running the board's 13-slot
    // search -- but the distance, font, colour and background-less styling
    // all come from the shared renderer, not from here.
    const badgeCenter = { x: center.x, y: center.y - size * 0.65 };
    drawRestrictionBadgeAt(ctx, badgeCenter, size, label);
  }
}

/** Maps a tile's real terrain onto the four badge-shape buckets
 *  `VALUE_BADGE_SHAPE` defines -- design note #126. `BostonHub` is a
 *  single-station city and `NewYorkHub` a two-station one, exactly as
 *  `archetypeForTerrain` already classifies them, so they borrow those
 *  buckets rather than inventing two more shapes for the same kind of
 *  revenue centre. `null` for terrain with no revenue at all, which is the
 *  signal to draw no badge. */
export function valueBadgeTerrainFor(
  terrain: TerrainType,
): "SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub" | null {
  switch (terrain) {
    case "SmallTown":
      return "SmallTown";
    case "DoubleTown":
      return "DoubleTown";
    case "MajorCityHub":
    case "BostonHub":
      return "MajorCityHub";
    case "DoubleCityHub":
    case "NewYorkHub":
      return "DoubleCityHub";
    default:
      return null;
  }
}

/** The "B" / "NY" / "OO" restriction label a tile carries, or `null` --
 *  design note #127.
 *
 *  Derived from terrain rather than stored as a new catalog column, because
 *  here the two are the same fact: `hexmap.rs` defines `BostonHub`/
 *  `NewYorkHub`/`DoubleCityHub` precisely AS "the artwork legal only at the
 *  B / NY / OO labelled hexes" (module doc comments #18/#26/#27). A `label`
 *  column would be a second copy of something the terrain already says, free
 *  to drift out of sync with it.
 *
 *  NOTE on the tiles named in the request: #57, #63 and #45 do NOT carry a
 *  label. #57 is the ordinary yellow city every plain-city hex starts from,
 *  #63 the ordinary brown city, #45 an ordinary brown plain -- none is
 *  restricted to particular hexes in real 1830, and labelling them would
 *  tell the player something untrue about where they may be laid. The TEN
 *  that really are label-restricted: #53/#61 (B), #54/#62 (NY),
 *  #59/#64/#65/#66/#67/#68 (OO).
 *
 *  (That count read "nine" until design note #486's harness counted the
 *  list rather than the prose: 2 + 2 + 6. The enumeration was right the
 *  whole time and only the number in front of it was wrong, which is why it
 *  survived -- nobody reading for WHICH tiles had reason to re-add them.
 *  `tilePreviewMarkers.test.ts` now pins the count, so the two cannot part
 *  company again.) */
export function restrictionLabelFor(terrain: TerrainType): "B" | "NY" | "OO" | null {
  switch (terrain) {
    case "BostonHub":
      return "B";
    case "NewYorkHub":
      return "NY";
    case "DoubleCityHub":
      return "OO";
    default:
      return null;
  }
}

/* Design note #129 deleted `drawTileRestrictionLabel` from here -- the
   bespoke white-pill label the picker drew for itself. It did not match the
   board, which draws these as plain bold black text with NO background
   (design note #47 removed the background from them deliberately). The tile
   pipeline now calls `drawRestrictionBadgeAt`, the single extracted
   implementation the board's own badge also goes through. */


/** Canonical Tile Upgrade Restrictions (design note #47, mirroring
 *  `hexmap.rs` module doc comment #26): draws one small, high-contrast "B"
 *  / "NY" / "OO" restriction badge at the hex's own upper-left CORNER
 *  (the literal geometric vertex, via `cornerAngleRad`/`pointOnCircle`,
 *  pulled in slightly so it doesn't sit on the border line itself) -- a
 *  fixed corner (unlike `drawValueBadge`'s own adaptive `BADGE_CORNERS`
 *  search), since this file's own three restricted hexes' printed track is
 *  already known and fixed: Boston's `LANDMARK_TRACKS` (`edges: [1, 5]`,
 *  NE-to-SE) and New York's (`edges: [1]`/`edges: [4]`, NE/SW stubs) both
 *  keep the upper-left corner clear, and the four OO hexes have no printed
 *  track at all (`OO_DESIGNATED_HEXES`' real source entries carry no
 *  `path=` data) -- so one consistent corner works for all three restricted
 *  kinds, giving players one predictable place to look rather than a
 *  per-hex adaptive one.
 *
 *  Deliberately placed at the true corner (`apothem * 0.85` out from
 *  center), NOT `drawValueBadge`'s own `size * 0.65` mid-radius "corner"
 *  zone (design note #109, was `0.44`, then briefly `0.38`, then `0.55`) --
 *  Boston and New York both also carry a real, non-zero
 *  `HEX_START_VALUE_OVERRIDE` value badge (design note #35) that renders
 *  unconditionally (not gated on tile-laid state the way this badge is),
 *  and that badge's own `BADGE_CORNERS` search can independently resolve
 *  to upper-left too. Sharing the same mid-radius zone risked a genuine
 *  overlap between the two badges on the exact two hexes this feature
 *  targets; sitting further out, in the hex's actual corner margin, keeps
 *  this badge in a visually distinct band regardless of which corner the
 *  value badge picks -- true to the request's own "upper corner/margin"
 *  wording besides. HONEST CAVEAT, not silently assumed away: on the four
 *  OO hexes specifically, corner 3 sits fairly close underneath the
 *  stacked two-line OO name pass above it (both land in a similar upper-
 *  left-ish band) -- close but not a hard, verified overlap; flagged here
 *  since this badge is new and untested in the live renderer, rather than
 *  claimed collision-free without having actually measured it on screen.
 *

 *  Purely informational: this badge carries no enforcement of its own (the
 *  backend's `legal_tile_placements` query is the single source of truth
 *  the tile picker already reflects automatically, `hexmap.rs` module doc
 *  comment #26's own closing paragraph) -- deliberately NOT gated by the
 *  `showCityNames` toggle (design note #42), since this is a rules/
 *  legality marker, not a city name; callers gate it on `!hexHasLaidTile`
 *  instead, matching the request's own explicit "before tiles are laid"
 *  framing -- once the correct restricted tile is actually laid, the
 *  restriction has been satisfied and re-showing the badge would be
 *  redundant, the same physical-board-parity reasoning nameplate
 *  suppression already uses. */
/** Restriction Labels (design note #49's plain-text/persistence reversals
 *  of #47 still stand -- see that note's own text below for the history;
 *  design note #55's Universal Canvas Layout Engine changed two things on
 *  top of it, and design note #69 REMOVES the shield box #55 itself added):
 *  - Shield box REMOVED (design note #69): reported, the badge's own tight
 *    tier-colored `drawLabelWithBackground` box (added by #55, reversing
 *    #49's original "no background pill/box" call) made "B"/"NY"/"OO" read
 *    as sitting on a distinct plate rather than printed directly on the
 *    hex/tile -- exactly what a real 1830 tile's own upgrade-restriction
 *    lettering looks like (plain ink straight on the printed tile face, no
 *    box). `background: false` (the same escape hatch
 *    `drawBoardMarginLabels` already uses) skips the box entirely; `text`
 *    now paints directly over whatever terrain/tier fill is under it.
 *  - Text un-bolded and sized up 1pt (design note #69, same pass): `"bold"`
 *    -> `undefined` (no weight override), base/min font `10`/`7` ->
 *    `11`/`8`.
 *  - Corner choice was ARCHETYPE-driven (unchanged from #55 through #104):
 *    a SingleCity hex's nameplate occupied the upper-left wedge
 *    (`singleNodeNameplateAnchor`), so its restriction badge (`archetype
 *    !== "DoubleCity"`) moved to the TOP-RIGHT wedge instead, clear of both
 *    the nameplate and the single center-locked station node, while a
 *    DoubleCity hex (nameplate dead-center, station nodes on the
 *    top-right/bottom-left diagonal) kept the UPPER-LEFT wedge, the
 *    ORIGINAL fixed corner from #47/#49 -- so the two archetypes preferred
 *    OPPOSITE corners of each other. Design note #105 UNIFIES this, per
 *    direct request: now that nameplates prefer center/top/bottom instead
 *    of upper-left (#105's own `NAMEPLATE_SLOT_PREFERENCE` change), the
 *    archetype-driven split this paragraph describes no longer reflects a
 *    real collision-avoidance need -- both archetypes now share the SAME
 *    preference (`RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY` ===
 *    `RESTRICTION_SLOT_PREFERENCE_OTHER`, Upper-Left then Upper-Right then
 *    every edge), left as two separately named constants only so a future
 *    pass CAN diverge them again without disturbing this function's own
 *    call site. */
// Design note #70: restriction-badge corner preference lists, expressed as
// 13-slot corner-slot numbers -- DoubleCity keeps its original fixed corner
// (slot 12/upper-left, `cornerIndex 3`) FIRST, SingleCity/other keeps slot
// 8/upper-right (`cornerIndex 1`) FIRST, exactly matching the old fixed
// literals below both preference lists. Unlike the old code, a genuine
// fallback now exists if that first-preference corner is ever blocked by
// live track: the opposite upper corner next, then both lower corners.
// Design note #76: same far-side-fallback reasoning as `BADGE_SLOT_PREFERENCE`
// just above -- if a DoubleCity hex is crowded enough that even slot 12
// (this list's own strong first preference, and the one G19 itself always
// gets in practice) is somehow unavailable, the fallback should still favor
// the far side over drifting into whatever near-side cluster the terrain
// icon/cost label are using.
//
// Design note #105: UNIFIED and REORDERED, per direct request -- both
// archetypes now lead with (what the request calls) "Vertex 5" and
// "Vertex 1", this system's own slot 12 (Upper-Left corner) and slot 8
// (Upper-Right corner) respectively (DoubleCity's list already led with
// exactly these two, unchanged; SingleCity/other's is reordered to match),
// THEN all six edge midpoints ("check edges"), in ascending slot order --
// reachable for the first time now that `drawRestrictionBadge` below no
// longer restricts its fallback pool to `CORNER_SLOTS` (see that function's
// own doc comment). `extendSlotPreference`'s default full-1-12 pool still
// appends the remaining, non-preferred corners as the final, least-likely
// fallback tail automatically -- no need to hand-list them here.
export const RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY: readonly number[] = [12, 8, 1, 2, 3, 4, 5, 6];
export const RESTRICTION_SLOT_PREFERENCE_OTHER: readonly number[] = [12, 8, 1, 2, 3, 4, 5, 6];

export function drawRestrictionBadge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  text: "B" | "NY" | "OO",
  archetype: HexArchetype,
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  // Design note #72: shared cross-pass claiming ledger (see
  // `claimHexSlot`'s own doc comment) -- lets this badge avoid whichever
  // slot the terrain icon/cost-label/revenue-badge passes already claimed
  // on this same hex this render, instead of every pass picking
  // independently and possibly landing on the exact same corner.
  claimedHexSlots: Map<string, Set<number>>,
): void {
  const restrictionOverride = resolveSlotOverride(q, r, "restriction");
  const preference = withSlotReserve(
    q,
    r,
    "restriction",
    archetype === "DoubleCity" ? RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY : RESTRICTION_SLOT_PREFERENCE_OTHER,
  );
  const blocked = hexBlockedSlots(mapGrid, q, r);
  const dead = slotsBlockedByEdges(deadEdgesAt(q, r), false);
  // Design note #105: no longer passes `CORNER_SLOTS` as the fallback
  // pool -- per direct request ("prefer Vertex 5 and 1, then check
  // edges"), this badge can now genuinely land on an edge midpoint, so its
  // fallback tail needs access to every slot (the default full 1-12
  // pool), not just corners. `badgeCenter` below is generalized to match
  // (via `hexSlotDirection`, which already handles edge slots correctly),
  // so there's no longer a rendering-path reason to exclude edges either.
  const slot = claimHexSlotPreferring(claimedHexSlots, q, r, restrictionOverride, preference, blocked, dead);
  // Design note #105: generalized from the old corner-only
  // `cornerAngleRad(CORNER_SLOT_TO_CORNER_INDEX[slot - 7])` formula to
  // `hexSlotDirection(slot)`, which resolves the correct true angle for
  // EITHER a corner slot or an edge slot -- the same helper every other
  // slot-based placement in this file already uses.
  // Design note #125: offset CHANGED from `apothem * 0.7` (~0.606 * size)
  // to a flat `size * 0.65`, per direct request to match the revenue
  // badge's own `REVENUE_BADGE_OFFSET` (design note #109) and the compound
  // terrain icon+cost badge's own `COMPOUND_BADGE_OFFSET` (design note
  // #122) -- all three badge types now share the exact same `0.65`
  // magnitude, measured the exact same way (straight `size * 0.65` along
  // `hexSlotDirection(slot)`, not an apothem-relative fraction), so a
  // restriction badge sitting on the same slot a revenue/terrain badge
  // could otherwise claim lands at the identical radius they would have.
  // Still safely inside the hex boundary at any of the 12 perimeter
  // angles (an edge midpoint, the nearest boundary point, sits at the full
  // apothem, ~0.866 * size, well outside this radius).
  const RESTRICTION_BADGE_OFFSET = 0.65;
  const direction = hexSlotDirection(slot);
  const badgeCenter = {
    x: center.x + direction.x * size * RESTRICTION_BADGE_OFFSET,
    y: center.y + direction.y * size * RESTRICTION_BADGE_OFFSET,
  };

  // Design note #124: base font dropped 2pt (11 -> 9), per direct request,
  // and switched to bold (was unweighted, the empty `""` fourth argument)
  // -- same "base drops, `fitFontSize`'s own `minFontSizePx` floor (8)
  // stays put" convention this file's other badges use for a plain point
  // drop (e.g. `drawTerrainCompoundBadge`'s own design note #92/#95/#99).
  drawRestrictionBadgeAt(ctx, badgeCenter, size, text);
}

/** THE restriction-label artwork -- design note #129.
 *
 *  Extracted VERBATIM from `drawRestrictionBadge` above, for the same reason
 *  design note #126 extracted `drawValueBadgeAt`: the tile picker had grown
 *  its own label renderer, and it did not match. Mine drew a white rounded
 *  pill with a dark outline; the board draws plain bold black text on no
 *  background at all -- design note #47's own reversal, which deliberately
 *  removed a background from these badges. Two labels in one window, styled
 *  as different objects.
 *
 *  `drawRestrictionBadge` keeps everything above this line, which is all
 *  PLACEMENT: the 13-slot search, `hexBlockedSlots`, dead-edge avoidance and
 *  the cross-pass claiming ledger, none of which an isolated tray thumbnail
 *  can supply (they need `mapGrid`, `q`, `r`). The caller decides WHERE;
 *  this decides WHAT, and there is now exactly one answer to that. */
export function drawRestrictionBadgeAt(
  ctx: CanvasRenderingContext2D,
  badgeCenter: { x: number; y: number },
  size: number,
  text: "B" | "NY" | "OO",
): void {
  ctx.font = fitFontSize(ctx, text, 9, size * 0.5, 8, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000000";
  drawLabelWithBackground(ctx, text, badgeCenter, { background: false });
}

/* ==================================================================
 *  DESIGN NOTE 318: THE PRIVATE COMPANY RESERVATION BADGE
 * ==================================================================
 *
 * REPORTED: nothing on the map shows that a hex is reserved by a private
 * company. See `utils/privateReservations.ts` design note #0 for why the
 * text-only version was not enough, and design note #1 for when this
 * clears.
 *
 * IT IS DELIBERATELY NOT A `drawRestrictionBadge`. The "B"/"NY"/"OO" badges
 * are PRINTED ON THE CARDBOARD -- permanent properties of the hex, part of
 * the board's own artwork. A reservation is a temporary game-state fact
 * that comes and goes with a company, so it is drawn in its own key: a gold
 * padlock rather than the board's black serif letters.
 *
 * THE LOCK IS DRAWN, NOT TYPED. `🔒` renders as a colour emoji on some
 * platforms, a hollow glyph on others and a tofu box where the font is
 * missing, and this file's whole doctrine is authored artwork over whatever
 * the font stack happens to supply. Two paths -- a shackle arc and a body
 * -- are three lines of code and identical everywhere.
 *
 * ===================================================================
 *  DESIGN NOTE 364: THE FIRST VERSION LOOKED LIKE A BUTTON
 * ===================================================================
 *
 * REPORTED: the badges are too large, overflow into neighbouring hexes,
 * and read as clickable because of the pill background.
 *
 * All three came from one decision. The first cut drew a filled, stroked,
 * drop-shadowed pill so the badge would read as a PIECE SITTING ON the
 * board rather than as printed artwork -- and a filled rounded rectangle
 * with a border and a shadow is exactly the visual vocabulary of a button.
 * The pill also set the size: it had to be wide enough for "C&SL" plus a
 * lock plus padding, which on a 42px hex is most of the hex's width, and
 * at the smaller zooms it ran into the neighbours.
 *
 * The plate is gone entirely. What remains is a lock and two or three
 * letters, drawn with a dark halo so they stay legible over any tile
 * colour without needing a background to sit on -- the same technique the
 * board's own nameplates use. Roughly 40% of the former footprint.
 *
 * THE AMPERSAND GOES TOO. "CSL" and "DH" are the same identifiers minus a
 * character that costs width and adds nothing at this size: nobody reads
 * a two-letter mark on a hex corner as a company name they need punctuated.
 *
 * THE POSITIONS ARE PINNED, not claimed. Every other badge in this file
 * negotiates for a slot through `claimHexSlotPreferring`, which is right
 * when several passes compete for one hex. There are exactly two of these,
 * on two known hexes, and both were given a specific home: B20's at the
 * BOTTOM VERTEX (slot 10), F16's on the BOTTOM-LEFT EDGE (slot 4). A
 * negotiated slot could have put either back over a neighbour, which is
 * the bug. The caller supplies the slot.
 */
export function drawReservationBadgeAt(
  ctx: CanvasRenderingContext2D,
  badgeCenter: { x: number; y: number },
  size: number,
  /** The private's initials, e.g. `"CSL"`. No ampersand -- design note #364. */
  initials: string,
): void {
  // Design note #364: markedly smaller than the pill version, and it shrinks
  // with the hex rather than holding a minimum a plate would have needed.
  const scale = Math.max(0.5, Math.min(1, size / 42));
  const fontPx = Math.max(6, Math.round(7.5 * scale));
  ctx.save();
  ctx.font = `bold ${fontPx}px ${FONT_FAMILY_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const lockW = fontPx * 0.62;
  const gap = fontPx * 0.28;
  const textW = ctx.measureText(initials).width;
  // Centred on the point the caller gave us, so a slot direction puts the
  // whole mark where it was aimed rather than its left edge.
  const startX = badgeCenter.x - (lockW + gap + textW) / 2;

  /* No plate. A dark halo under both the glyph and the text is what keeps
     them readable over yellow track, green cardboard or a red off-board --
     the same trick the nameplate pass uses, and it costs no footprint. */
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.shadowBlur = Math.max(2, 3 * scale);

  // The padlock: shackle arc above a body rectangle.
  const bodyH = fontPx * 0.55;
  const bodyY = badgeCenter.y - bodyH * 0.1;
  const shackleR = lockW * 0.3;
  ctx.strokeStyle = "#f0d074";
  ctx.lineWidth = Math.max(0.9, 1 * scale);
  ctx.beginPath();
  ctx.arc(startX + lockW / 2, bodyY, shackleR, Math.PI, 0);
  ctx.stroke();
  ctx.fillStyle = "#f0d074";
  ctx.beginPath();
  ctx.rect(startX + lockW * 0.12, bodyY, lockW * 0.76, bodyH);
  ctx.fill();

  ctx.fillStyle = "#f7ead0";
  ctx.fillText(initials, startX + lockW + gap, badgeCenter.y + fontPx * 0.05);
  ctx.restore();
}

/**
 * Places and draws a reservation badge on `(q, r)`.
 *
 * Design note #364: `slot` is REQUIRED and comes from the caller. These two
 * badges have fixed homes chosen so neither can reach a neighbouring hex,
 * and a negotiated slot is what let the first version wander.
 */
export function drawReservationBadge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  initials: string,
  slot: number,
): void {
  /* 0.62 rather than the 0.65 every other badge uses: a vertex slot already
     sits at the full corner radius, and the mark is centred on the point
     rather than starting there, so a hair further in keeps its outer end
     inside the hex boundary. */
  const direction = hexSlotDirection(slot);
  drawReservationBadgeAt(
    ctx,
    {
      x: center.x + direction.x * size * 0.62,
      y: center.y + direction.y * size * 0.62,
    },
    size,
    initials,
  );
}

/** Draws a landmark's authentic, fixed starting track -- design note #211.
 *
 *  Boston and Baltimore are ordinary single-station preprinted hexes and go
 *  through `drawPrintedTrack` above on their own labels. NEW YORK is the one
 *  exception in the whole board: it prints TWO physically independent
 *  stations on one hex, which `PrintedArtwork.marker` (singular) cannot
 *  express, so it has its own catalog entry and its own two-marker branch
 *  here.
 *
 *  The two stub endpoints are the artwork's, not `twoNodePositions`'. That
 *  shared NE/SW diagonal was a fixed guess about where two stations sit
 *  regardless of which edges the track actually runs from -- the same thing
 *  design note #133 corrected for laid tiles -- and New York's stubs come
 *  off edges 1 and 4, so the authored endpoints and the diagonal happen to
 *  agree in direction while disagreeing in distance. Reading the artwork
 *  means the station is on its own rail by construction rather than by
 *  coincidence. */
export function drawLandmarkTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  /** The landmark's hex label. */
  label: string,
): boolean {
  // Boston (E23) and Baltimore (I15) are in the ordinary printed catalog.
  if (label !== "G19") return drawPrintedTrack(ctx, center, size, label);

  const paths = newYorkPrintedPaths();

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(size, size);
  ctx.strokeStyle = DEFAULT_TRACK_INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(3, size * 0.12) / size;
  for (const path of paths) ctx.stroke(path);
  ctx.restore();

  for (const marker of NEW_YORK_PRINTED_ARTWORK.markers) {
    drawStationCircle(
      ctx,
      { x: center.x + size * marker.at.x, y: center.y + size * marker.at.y },
      size * 0.85,
    );
  }
  return true;
}

/** Draws an off-board hex's pre-printed track stubs -- see `OFFBOARD_TRACKS`
 *  and design note #10. A short stub from each live edge partway toward the
 *  hex's center, deliberately with NO station circle (unlike
 *  `drawLandmarkTrack` above) -- an off-board hex is a revenue destination,
 *  not a real station a train can dwell at.
 *
 *  ==================================================================
 *   DESIGN NOTE 473: THE INK, AND THE ARROWHEAD
 *  ==================================================================
 *
 *  REPORTED: the track on red off-board hexes does not match the track
 *  colour used on ordinary tiles, and its ends are blunt stubs rather than
 *  the tapered arrows 1830 prints.
 *
 *  THE INK. This hardcoded `"#2b2b2b"` -- the historic `DEFAULT_TRACK_INK`.
 *  Design note #161 then deepened tile track to `#1a1a1a` across all three
 *  tiers, and `DEFAULT_TRACK_INK` was left where it was precisely so that
 *  "every existing non-tile track call ... is byte-identical to before".
 *  That was the right call for gray hexes and landmark stubs, which sit on
 *  pale printed stock. It is the wrong one here: a red off-board hex
 *  connects directly to laid tiles, and the seam between `#2b2b2b` and
 *  `#1a1a1a` falls exactly on the edge a player traces a route across. It
 *  now reads `STANDARD_TRACK_INK`, the same value the tier table carries.
 *
 *  THE ARROWHEAD IS THE CANONICAL ART. On a real 1830 board an off-board
 *  connection is drawn as a track that TAPERS to a point -- it is the
 *  visual statement that the route leaves the map here rather than
 *  continuing to a station. A blunt round cap says the opposite: it looks
 *  like a piece of track that was cut off, which is how an unfinished
 *  rendering looks rather than how a terminus looks.
 *
 *  DRAWN AS A FILLED TRIANGLE ON A SHORTENED STUB, not as a stroke trick.
 *  Tapering a stroke would need a variable-width path; a stub that stops
 *  short with a triangle on its inner end is the same silhouette, is
 *  trivially correct at every zoom, and keeps the curve itself the same
 *  `bezierTrackSegment` every other track in this file draws. */
export function drawOffboardTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  edges: readonly number[],
): void {
  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));

  const lineWidth = Math.max(3, size * 0.12);
  ctx.strokeStyle = STANDARD_TRACK_INK;
  ctx.fillStyle = STANDARD_TRACK_INK;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";

  /* How far in the stub runs, and how much of that the head occupies. The
     shaft stops where the head begins so the round cap is never visible
     past the point -- a cap poking out of an arrowhead is the blunt end
     this replaces, just smaller. */
  const TIP_FRACTION = 0.52;
  const HEAD_LENGTH = size * 0.20;

  // Rail Map Overhaul (design note #42): each stub is a
  // perpendicular-entering Bezier curve (`bezierTrackSegment`) rather than a
  // straight `lineTo`, matching every other track-drawing function here.
  for (const edge of edges) {
    const edgeEnd = edgePoint(edge);

    // The point the arrow aims at, on the line from the edge to the centre.
    const tip = {
      x: center.x + (edgeEnd.x - center.x) * TIP_FRACTION,
      y: center.y + (edgeEnd.y - center.y) * TIP_FRACTION,
    };

    // Unit vector along the stub, pointing INWARD (edge -> tip).
    const dx = tip.x - edgeEnd.x;
    const dy = tip.y - edgeEnd.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    // The shaft ends where the head starts.
    const shaftEnd = {
      x: tip.x - ux * HEAD_LENGTH,
      y: tip.y - uy * HEAD_LENGTH,
    };
    bezierTrackSegment(ctx, edgeEnd, shaftEnd, size, edgeInwardNormal(edge), null);

    /* The head. Half-width matches the shaft so the taper starts flush with
       it rather than stepping out -- an arrow wider than its own track
       reads as a separate glyph sitting on the end. */
    const half = lineWidth * 0.95;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(shaftEnd.x - uy * half, shaftEnd.y + ux * half);
    ctx.lineTo(shaftEnd.x + uy * half, shaftEnd.y - ux * half);
    ctx.closePath();
    ctx.fill();
  }
}

/* ==================================================================
 *  DESIGN NOTE 211: PREPRINTED TRACK IS DRAWN, NOT DERIVED
 * ==================================================================
 *
 * This function used to take an EDGE SET and build a shape from it: one
 * `lineTo` for an opposite pair, two `bezierTrackSegment` halves meeting at
 * the hex centre for anything else, N radial spokes for three or more. Every
 * one of those is the algorithmic construction the tile half of this
 * renderer has already retired (design note #209), and on preprinted hexes
 * it was worse than on tiles, because the half-curve degenerates:
 * `bezierTrackSegment(edgeMidpoint -> centre, inwardNormal, null)` puts both
 * control points on the straight line between its endpoints, so the "curve"
 * is a straight radial. Cleveland's 60-degree pair therefore drew as a hard
 * V through the middle of the hex.
 *
 * It now renders `PRINTED_GRAPHICS_CATALOG[label]` -- literal `d` strings in
 * the same unit-hex space, the same three canonical primitives, the marker
 * on the curve's own apex. A gray hex connecting edges 0 and 2 and a laid
 * #8 connecting edges 0 and 2 are now the same drawn shape, which they
 * always should have been and never were.
 *
 * THE BYPASS IS ARTWORK NOW TOO. Altoona's "some trains skip this stop"
 * fork was a run of control-point arithmetic here, bowed off the chord by a
 * tuned `size * 0.8`. It is one more path string in the catalog entry.
 *
 * A label with no catalog entry draws nothing and returns `false`, so the
 * caller can fall back to the explicit placeholder rather than this
 * inventing a shape for a hex the artwork does not know.
 */
export function drawPrintedTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  /** The hex label -- `GRAY_HEXES`/`LANDMARK_TRACKS`' own key, and the key
   *  `PRINTED_GRAPHICS_CATALOG` is authored against. */
  label: string,
): boolean {
  const art = printedArtwork(label);
  const paths = printedArtworkPaths(label);
  if (!art || !paths) return false;

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.scale(size, size);
  ctx.strokeStyle = DEFAULT_TRACK_INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // The catalog is authored in unit-hex space, so the transform scales the
  // pen too -- divide back out to land on the SAME on-screen stroke width
  // every other track in this file uses. Identical to
  // `drawHardcodedTileArtwork`'s own handling, for the same reason.
  ctx.lineWidth = Math.max(3, size * 0.12) / size;
  for (const path of paths) ctx.stroke(path);
  ctx.restore();

  if (art.marker) {
    const point = {
      x: center.x + size * art.marker.at.x,
      y: center.y + size * art.marker.at.y,
    };
    if (art.marker.kind === "city") drawStationCircle(ctx, point, size);
    // Item 8 ("Distinct Dark Small Towns"): dark dit marker, not a white
    // circle -- see `drawDitMarker`'s own doc comment.
    else drawDitMarker(ctx, point, size);
  }
  return true;
}

/** Draws a pre-printed yellow "OO" double-city hex's two independent
 *  station circles -- see `YELLOW_OO_HEXES` and design note #12, geometry
 *  REPLACED by design note #49 (diagonal top-right/bottom-left, was
 *  left/right), offset formula UNIFIED into `doubleNodeOffset` by design
 *  note #55, and routed through the single shared `twoNodePositions` tuple
 *  helper by design note #58 (see that function's own doc comment). Real
 *  source data for these four hexes has no `path=` entry at all (no
 *  printed track connecting the two cities), so this deliberately draws NO
 *  line between them -- just two smaller station circles (`drawStationCircle`
 *  at a reduced size so both fit without overlapping). */
export function drawOOCityMarkers(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
): void {
  const [node0, node1] = twoNodePositions(center, size);
  drawStationCircle(ctx, node0, size * 0.75); // index 0: top-right
  drawStationCircle(ctx, node1, size * 0.75); // index 1: bottom-left
}

/** Station Tokens (design note #36; extended by design note #44; geometry
 *  updated by design note #49; REWRITTEN by design note #55's Universal
 *  Canvas Layout Engine; NODE-INDEX INVERSION FIXED by design note #56):
 *  resolves the pixel point a Station Token marker at `(q, r)` should
 *  actually be drawn at -- true hex center for every ordinary single-node
 *  hex, but offset onto one of the two station nodes for any
 *  DoubleCity-archetype hex (see design note #36's own "board geometry
 *  special case" paragraph for why: two off-center circles mean a marker
 *  drawn at raw center would float visibly between both instead of sitting
 *  on either).
 *
 *  Design note #55 REMOVED the previous `hex.label === "G19"` literal
 *  string check (the Universal Layout Engine's own explicit prohibition on
 *  hardcoded per-hex identity branches) and replaced it with a STRUCTURAL
 *  one: is this hex a `LANDMARK_HEXES` entry whose own `LANDMARK_TRACKS`
 *  data has two independent one-edge stub segments (today, only New York --
 *  but any future landmark with the same real "two disconnected stations"
 *  printed-track shape would classify identically, with no code change
 *  here)? That structural check itself was correct and is unchanged.
 *
 *  Design note #56 FIXES a node-index inversion #55 introduced: the
 *  landmark branch anchored on `landmarkSegments[1]` (the SECOND/SW
 *  segment) for EVERY landmark-hosted token, which put New York's home
 *  token (NNH/"NYNH", `STATION_HOME_HEXES`) on the Bottom-Left/Southwest
 *  circle instead of its canonical Top-Right/Northeast one. Per the
 *  canonical rule shared by every 2-station archetype (`G19`, the four OO
 *  hexes, every double-town): Node Index 0 = Top-Right/Northeast =
 *  `center + doubleNodeOffset`; Node Index 1 = Bottom-Left/Southwest =
 *  `center - doubleNodeOffset`. `LANDMARK_TRACKS["New York"]`'s own segment
 *  ORDER already encodes this (`segments[0]` = edge 1/NE = Node 0;
 *  `segments[1]` = edge 4/SW = Node 1) -- the bug was reading index `[1]`
 *  unconditionally instead of the FIRST segment for the "assigned to node
 *  0" case. Rather than keep two independently-computed "close but not
 *  exact" approximations of the same two points (this function's old
 *  edge-interpolated 50%-to-center formula vs. `drawLandmarkTrack`'s own,
 *  which could drift apart pixel-for-pixel), both now anchor on the exact
 *  same literal `doubleNodeOffset` coordinates every other `DoubleCity`
 *  hex uses -- the request's explicit "without being swapped or offset"
 *  requirement, read as: no hex-specific custom offset, full literal
 *  unification. Every `DoubleCity`-archetype hex (`G19` included) now
 *  shares the exact same two node coordinates and the exact same Node
 *  0/Node 1 convention, with zero per-hex-name branching. */
export function stationMarkerPoint(
  q: number,
  r: number,
  size: number,
  /** Design note #131: the tile actually laid on this hex, if any.
   *
   *  REQUIRED for correctness on any two-city hex once that hex holds a
   *  catalogued tile. `twoNodePositions` below returns a FIXED NE/SW
   *  diagonal that knows nothing about the tile's track, while the artwork
   *  puts each station on its own curve -- for #62 both cities sit in the
   *  upper half, nowhere near the SW node. Passing the laid tile keeps the
   *  token on the circle the player can see; omitting it leaves the old
   *  behaviour for an unlaid, still-blank designated hex, which is the one
   *  case where there is no artwork to follow. */
  laidTile?: MapTileEntry,
  /* ==================================================================
   *  DESIGN NOTE 459: WHICH OF THE TWO PREPRINTED CIRCLES
   * ==================================================================
   *
   * Which city on this hex the token belongs to, when the chain has said
   * (`tokenCityIndex`). Only consulted on the UNLAID preprinted-OO branch
   * below -- a laid tile has real artwork and `tileCityAnchors` already
   * follows it.
   *
   * That branch hardcoded index 1, the bottom-left circle, because before
   * `station_tokens` carried a city index there was nothing else it could
   * do. There is now, and leaving the hardcode meant a token placed in the
   * north-east city was drawn in the south-west one -- which is half of why
   * the upper-right node looked broken (see `cityIndexAtPoint`'s own note
   * for the other half).
   *
   * `undefined` KEEPS THE OLD BEHAVIOUR, deliberately. A pre-G-12 chain
   * reports no city index, and bottom-left is where those tokens have
   * always been drawn -- changing it for them would move existing tokens on
   * boards this cannot ask about. */
  cityIndex?: number,
): { x: number; y: number } {
  const center = axialToPixel(q, r, size);

  if (laidTile) {
    const anchors = tileCityAnchors(laidTile.tile_id, laidTile.orientation, center, size);
    if (anchors.length > 0) {
      // Index choice is UNCHANGED from the logic below -- OO hexes take the
      // second station, New York the first -- so this moves where a token
      // is drawn without changing which city it is understood to occupy.
      const hexHere = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
      if (hexHere && YELLOW_OO_HEXES.has(hexHere.label)) return anchors[1] ?? anchors[0];
      if (LANDMARK_HEXES.some((entry) => entry.q === q && entry.r === r)) return anchors[0];
      return anchors[0];
    }
  }

  const hex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
  if (hex && YELLOW_OO_HEXES.has(hex.label)) {
    /* Both circles come from the same `twoNodePositions` tuple
       `drawOOCityMarkers` draws from (design note #58), so a token cannot
       land anywhere the board has not drawn a station.

       Design note #459: the CITY decides which, when it is known. Index 1 --
       bottom-left -- remains the answer for a chain that does not report
       one, which is the behaviour every existing board was drawn with. */
    const nodes = twoNodePositions(center, size);
    return cityIndex === undefined ? nodes[1] : (nodes[cityIndex] ?? nodes[1]);
  }

  /* ==================================================================
   *  DESIGN NOTE 221: THE PREPRINTED STATION MOVED; THE TOKEN DID NOT
   * ==================================================================
   *
   * REPORTED BUG: station tokens and reservation markers have "drifted" off
   * the station nodes.
   *
   * This is a regression from design note #210/#211, and the drift is exact
   * rather than approximate. Preprinted hexes used to draw their city circle
   * at the hex CENTRE unconditionally, because `drawPrintedTrack` built its
   * track as two half-segments meeting there. Now that they render from
   * authored artwork, each city sits where the cardboard prints it -- on its
   * own curve's apex. Cleveland's circle is half a hex radius south of
   * centre, Montreal's likewise, Boston's is east of it, Baltimore's
   * south-east, Kingston's town north-west.
   *
   * The ARTWORK moved and this function did not, so it went on returning
   * `center` and every token landed on empty tile fill beside its own
   * circle. The same `return center` also fed the muted reservation markers
   * for unfloated companies, which is why both drifted together.
   *
   * The fix is the same one design note #133 applied to laid tiles: read the
   * position off the artwork instead of restating a guess about it. A hex
   * with authored printed artwork now reports ITS marker's point, so the
   * token sits in the circle by construction rather than by two independent
   * computations happening to agree.
   *
   * NEW YORK is separate because it prints TWO stations, which
   * `PrintedArtwork.marker` (singular) cannot express -- it keeps its own
   * catalog entry, and Node Index 0 is its canonical Top-Right/NE station,
   * the same convention every other two-station archetype uses (design note
   * #56).
   */
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  const label = hex?.label ?? landmark?.label;

  if (label === "G19") {
    const first = NEW_YORK_PRINTED_ARTWORK.markers[0];
    return { x: center.x + size * first.at.x, y: center.y + size * first.at.y };
  }

  if (label !== undefined) {
    const printed = printedArtwork(label);
    if (printed?.marker) {
      return {
        x: center.x + size * printed.marker.at.x,
        y: center.y + size * printed.marker.at.y,
      };
    }
  }

  return center;
}

/** Draws one Station Token marker -- see design note #36, extended by
 *  design notes #45, #46, and #48. Sized to match `drawStationCircle`'s own
 *  `size * 0.22` radius exactly (the explicit "sized to match the large
 *  white city circles" ask), drawn ON TOP of whichever plain station circle
 *  already sits at this point. `muted` (true for a not-yet-floated
 *  corporation's preprinted home marker, false for any real placed token)
 *  swaps a solid dark-navy fill for the corporation's own solid `color`, so
 *  "reserved, not yet active" reads unmistakably differently from "an
 *  actual live token" at a glance. `ticker` is fit inside via the same
 *  `fitFontSize` helper every other in-canvas label in this file already
 *  uses (design note #46: floored at a minimum 9px here specifically, see
 *  that call's own comment), with a thin `strokeText` edge (design note
 *  #46: thinned down from #45's original `lineWidth = 2`, which was
 *  reported as choking small letterforms) painted first. Every real call
 *  site guarantees a non-empty `ticker` for every one of the 8
 *  `STATION_HOME_HEXES` entries (design note #45 / `stationTickerLabel`'s
 *  fallback) -- the `if (!ticker) return;` guard below is kept only as a
 *  defensive no-op for any future caller that doesn't, not because any
 *  current call site can hit it. */
export function drawStationTokenMarker(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
  ticker: string,
  color: string,
  muted: boolean,
  /** Design note #151: the DOCKING radius, when this token is being placed
   *  into a specific slot of a laid tile's city pill
   *  (`tileCityTokenRadius`). Omit for the preprinted/fallback path, which
   *  keeps the legacy `size * 0.22` that design note #36 matched to the
   *  large white city circles.
   *
   *  Optional rather than required so every existing call site is
   *  unchanged, and so a caller with no artwork to measure cannot be forced
   *  to invent a figure. */
  radiusOverride?: number,
): void {
  const radius = radiusOverride ?? size * 0.22;

  // Design note #116: reserved/unfloated badges REVERSED from #46/#48's
  // solid-opaque-navy-plus-full-brand-ring treatment (which read as
  // deliberately as bold and "real" as an actual floated token) to a
  // heavily grayed-out, semi-transparent one instead -- direct request,
  // "show players that the station is reserved but not currently blocking
  // routes." Two changes, applied together: the fill drops from the dark
  // navy `#1E293B` to a neutral mid-gray (`#9CA3AF`, matching this file's
  // established muted/disabled tone elsewhere), and the ENTIRE muted badge
  // (fill, ring, and ticker text alike) now draws at a reduced
  // `globalAlpha` instead of full opacity -- "heavily grayed out... or
  // transparent... or something similar" was read as "combine both," since
  // gray alone can still look like a solid, present token, while adding
  // transparency on top makes it unmistakably a ghost/preview rather than
  // an active piece on the board. The ring KEEPS previewing the
  // corporation's own brand `color` (design note #48's own useful idea,
  // "which color it'll turn once floated") -- just faded along with
  // everything else now, rather than standing out at full strength while
  // the fill and text are grayed. Floated tokens are completely untouched:
  // this whole treatment is gated on `muted`.
  const badgeFill = muted ? "#9CA3AF" : color;
  const MUTED_ALPHA = 0.45;

  ctx.save();
  if (muted) ctx.globalAlpha = MUTED_ALPHA;

  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = badgeFill;
  ctx.fill();

  // UNFLOATED (design note #48, tone updated by #116 above): the ring is the
  // corporation's own brand `color`, at a fixed, un-scaled `1.75px` --
  // deliberately NOT `size`-scaled like most of this file's other stroke
  // widths, so it reads as a thin, consistent ring at every zoom level.
  //
  // FLOATED: charcoal, not the board's cream. Design note #234 in
  // `hexContractTypes.ts` has the full reasoning -- a near-white ring around
  // a small disc, inside a white city circle, with white lettering on it,
  // removed the contrast in the one place it was needed.
  ctx.strokeStyle = muted ? color : STATION_TOKEN_RING;
  /* Design note #487: scaled off the TOKEN's radius, not the hex's size.
     This was `Math.max(2, size * 0.05)` -- one absolute width for tokens
     drawn at three different radii, so a docked token wore a collar half
     again as heavy as a preprinted one and stopped looking like the same
     piece. The ratio reproduces the old width exactly at the legacy
     `size * 0.22` radius.

     THE FLOOR DROPS FROM 2 TO 1 and has to: a 2px floor is the same bug in
     miniature, reasserting an absolute width the moment a token is small
     enough for it to matter. 1px is the thinnest a canvas can honestly
     draw, and the device-pixel-ratio transform this canvas already applies
     keeps it from disappearing on a retina display.

     `muted` keeps its own fixed 1.75. That badge is a RESERVATION preview
     rather than a token (design note #116), it is only ever drawn at the
     preprinted radius, and it is deliberately un-scaled so it reads the
     same at every zoom. */
  ctx.lineWidth = muted ? 1.75 : Math.max(1, radius * STATION_TOKEN_RING_WIDTH_RATIO);
  ctx.stroke();

  if (!ticker) {
    ctx.restore();
    return;
  }

  // Crisp Token Typography (design note #46): explicit system-sans font
  // stack (the request's own literal wording), and a 9px floor -- passed as
  // `fitFontSize`'s own `minFontSizePx` argument for THIS call site only,
  // not by changing `fitFontSize` itself, which seven other call sites
  // across this file share with their own independently-tuned minimums (as
  // low as 5px, for the tightest off-board value badges) that a shared
  // global floor would silently override and likely overflow.
  /* ==================================================================
   *  DESIGN NOTE 513: FOUR LETTERS DO NOT FIT A THREE-LETTER DISC
   * ==================================================================
   *
   * REPORTED: four-letter acronyms like "ERIE" spill over the token's disc.
   *
   * `fitFontSize` shrinks until the text fits `maxWidth` -- but it FLOORS at
   * its `minFontSizePx`, returning that size even when it does not fit
   * (see its own loop: the `while` exits and the floor is returned
   * unmeasured). Design note #46 set that floor to 9px for legibility, which
   * is right for "PRR" and wrong for "ERIE": at the token's ordinary radius
   * the four-letter string needs less than 9px to stay inside, so the floor
   * hands back a size that overflows.
   *
   * Six of 1830's eight tickers are three characters or fewer. ERIE and NNH
   * are the outliers, and ERIE is the one that actually overflows -- which
   * is why this survived: the disc is correctly sized for the common case.
   *
   * TWO CHANGES, and the second is what makes the first safe. The available
   * width drops for a long ticker, because the disc is a CIRCLE: a chord
   * near its centre is at its widest, and text set edge-to-edge across that
   * chord touches the rim it is supposed to sit inside. And the floor drops
   * with it, so `fitFontSize` is allowed to reach a size that genuinely
   * fits instead of bottoming out above one.
   *
   * SCALED, NOT SPECIAL-CASED. The threshold is a length rather than a list
   * of tickers, so a future corporation with a long acronym is handled by
   * the same rule rather than by someone remembering to add it. */
  const longTicker = ticker.length > 3;
  const textWidth = radius * (longTicker ? 1.45 : 1.7);
  const floorPx = longTicker ? 7 : 9;
  ctx.font = fitFontSize(ctx, ticker, 11, textWidth, floorPx, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Crisp Token Typography (design note #46): whichever of pure white/pure
  // black actually contrasts better against THIS badge's own fill, computed
  // per-badge via `bestContrastTextColor` rather than one fixed color
  // asserted for every corporate ticker -- see that function's own doc
  // comment for the honest caveat that a few of `STATION_TICKER_COLORS`'s
  // own established brand colors (e.g. NYC's blue, ~4.9:1 best-case) don't
  // reach the literal 7:1 AAA threshold against EITHER pure color alone;
  // this is the best available flat-fill contrast without altering that
  // shared brand palette, which is out of scope here.
  const textColor = bestContrastTextColor(badgeFill);
  const haloColor = textColor === "#FFFFFF" ? "#000000" : "#FFFFFF";

  // Crisp Token Typography (design note #46): CORRECTS design note #45's
  // `lineWidth = 2` halo, reported as choking small letterforms (filling in
  // the counters of "B&O"/"B&M"/"C&O"'s tight glyphs) at this badge's small
  // `radius = size * 0.22`. Thinned to the requested `0.5` maximum and
  // recolored to the OPPOSITE of `textColor` (so it reads as a thin
  // contrast-boosting edge against the badge fill, not a thick outline
  // fighting the glyph fill) -- still painted BEFORE `fillText`, same
  // ordering #45 established.
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = haloColor;
  ctx.strokeText(ticker, point.x, point.y);
  ctx.restore();

  ctx.fillStyle = textColor;
  ctx.fillText(ticker, point.x, point.y);
  ctx.restore();
}

/** A small brown twin-peak mountain icon -- see design note #9. Drawn on a
 *  Mountain hex's now-standard land fill so the terrain reads as
 *  "buildable, at a cost" rather than the previous pass's solid-brown
 *  fill, which looked like a permanent obstacle. Two overlapping triangles
 *  (a smaller back peak, then a slightly larger front peak painted on top)
 *  read as a small mountain range rather than a single, less legible
 *  triangle.
 *
 *  Rail Map Overhaul (design note #42): scaled down ~30% (`size * 0.7`) from
 *  the hex's own radius, per that item's explicit "de-cluttering" ask -- the
 *  icon still anchors at the same `center`, just occupies visibly less of
 *  the hex, leaving more clearance for the track spline / cost label sharing
 *  the same tile.
 *
 *  Design note #87: `colorOverride`, when given, replaces both peaks' own
 *  fill AND stroke with one flat color -- used by `drawTerrainCompoundBadge`
 *  to render this icon in WHITE (matching its adjoined cost text) so it
 *  stays legible against that badge's solid red fill, where the icon's
 *  usual brown two-tone would be low-contrast. Omitted (the standalone
 *  terrain-icon pass), the normal brown two-tone renders unchanged. */
export function drawMountainIcon(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  colorOverride?: string,
): void {
  // Design note #101: `iconSize` bumped `size*0.7 -> size*0.875` (+25%),
  // per direct request -- every other dimension in this function (`w`,
  // `h`, `cx` offset, `cy` offset) is derived from `iconSize`, so this one
  // change scales the whole icon uniformly.
  // Design note #102: bumped another 30%, `size*0.875 -> size*1.1375`, per
  // direct follow-up request (same uniform-scale mechanism).
  const iconSize = size * 1.1375;
  const drawPeak = (offsetX: number, scale: number, fill: string) => {
    const w = iconSize * 0.5 * scale;
    const h = iconSize * 0.42 * scale;
    const cx = center.x + offsetX;
    const cy = center.y + iconSize * 0.06;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + h / 2);
    ctx.lineTo(cx, cy - h / 2);
    ctx.lineTo(cx + w / 2, cy + h / 2);
    ctx.closePath();
    ctx.fillStyle = colorOverride ?? fill;
    ctx.fill();
    ctx.strokeStyle = colorOverride ?? "#3a2818";
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  drawPeak(iconSize * 0.22, 0.7, "#5a3f28"); // smaller back peak, drawn first
  drawPeak(-iconSize * 0.05, 1, "#6b4a2f"); // main peak, painted on top
}

/** A blue water-wave icon across a buildable River hex -- see design note
 *  #9. Replaces a prior pass's solid-blue fill, which visually read as
 *  impassable water rather than buildable terrain.
 *
 *  Rail Map Overhaul (design note #42): scaled down ~30% (`size * 0.7`),
 *  matching `drawMountainIcon`'s identical treatment above, for the same
 *  de-cluttering reason.
 *
 *  Design note #86 REDESIGN: TWO thin, stacked parallel strands (was ONE,
 *  thicker curve) -- more legible as a "water" cartographic symbol, per
 *  direct request. Design note #88 FOLLOW-UP, per direct feedback on #86's
 *  first pass: (a) stroke width bumped back up 25% off #86's own value
 *  (`* 0.25` -> `* 0.3125` off the original pre-#86 formula) -- #86 alone
 *  read too thin; (b) the two strands pulled further apart (`iconSize *
 *  0.09` -> `* 0.16`); (c) RESHAPED from one gentle two-arc S-curve (read
 *  as a single river channel) to a proper tilde-style wave -- THREE
 *  alternating crests/troughs across the same overall width, the standard
 *  nautical-chart "water" glyph, via `drawWaveStrand` below -- rather than
 *  a shape a caller has to squint at to not read as "a river," per that
 *  same feedback. Design note #90 FOLLOW-UP: a third crest added (now
 *  THREE crests/two troughs total) within that same overall width and
 *  amplitude, per direct request -- later reverted (see #98 below), the
 *  "third wave" turning out to mean a third STRAND, not a third crest.
 *
 *  Design note #98 FOLLOW-UP: THREE stacked strands (was two) -- per
 *  clarified direct request, "a third wave" meant a third parallel line in
 *  the SAME shape as the existing two, not a third crest crammed into one
 *  line (#90/#96's approach, both reverted). `drawWaveStrand` itself is
 *  back to its original #90 shape (5 segments/three crests, two troughs);
 *  #95's amplitude bump (`0.16 -> 0.24`) is kept, unrelated to this
 *  strand-count question. The three strands sit at `-strandOffset`, `0`,
 *  `+strandOffset` -- same `strandOffset` gap between each ADJACENT pair
 *  as the old two-strand layout had between its only pair, just extended
 *  to a third line.
 *
 *  Design note #100 FOLLOW-UP: #98's third strand REMOVED, back to two,
 *  per direct request -- and `strandOffset` widened `0.16 -> 0.20` for
 *  slightly more separation between the two remaining strands.
 *
 *  `colorOverride` (design note #87): lets a caller render this icon in a
 *  single flat color instead of its normal blue -- unused by
 *  `drawTerrainCompoundBadge` as of design note #88 (that badge now draws
 *  the icon in its ordinary color, perched above the badge's red box
 *  rather than inside it), but left in place as a general-purpose escape
 *  hatch for any future caller that DOES need a flat override. */
export function drawRiverIcon(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  colorOverride?: string,
): void {
  const iconSize = size * 0.7;
  const halfW = iconSize * 0.68;
  // Design note #88: `* 0.3125` = the original pre-#86 formula's `* 0.25`
  // (#86's own -75% cut) times #88's own further `* 1.25` (+25% back up).
  const lineWidth = Math.max(3, iconSize * 0.14) * 0.3125;
  // Design note #100: bumped `0.16 -> 0.20` -- slightly more separation
  // between the two strands, per direct request, on top of reverting back
  // to two strands (#98's third strand removed).
  const strandOffset = iconSize * 0.2;
  // Design note #95: amplitude bumped `0.16 -> 0.24` -- #90's third crest
  // was mathematically present but too subtle to read at this icon's
  // small on-screen size (each crest's actual visual excursion is only
  // HALF `amplitude`, per a quadratic Bezier's own midpoint math -- see
  // `TERRAIN_ICON_SIZE_RATIO`'s doc comment), so five tightly-packed
  // segments at the old amplitude blurred into what still looked like the
  // old two-crest shape. Note this also grows the icon's own bounding
  // height, so `TERRAIN_ICON_SIZE_RATIO.River.height` below is updated to
  // match (width ratio is unaffected -- amplitude doesn't change `halfW`).
  const amplitude = iconSize * 0.24;
  const drawStrand = (dy: number) => {
    drawWaveStrand(ctx, center.x - halfW, center.x + halfW, center.y + dy, amplitude);
  };
  ctx.strokeStyle = colorOverride ?? "#3a7bbf";
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Design note #100: back to TWO strands (#98's third strand removed,
  // per direct request) at the widened `strandOffset` above.
  drawStrand(-strandOffset / 2);
  drawStrand(strandOffset / 2);
}

/** Design note #90 (segment count reverted here by design note #98):
 *  strokes ONE tilde-style wave -- THREE crests and two troughs (a rise, a
 *  fall, a rise, a fall, a rise) spanning `[startX, endX]` at vertical
 *  center `baseY`, each hump `amplitude` tall -- the standard
 *  nautical-chart "water" glyph. Design note #96 had briefly changed this
 *  to an EVEN 6-segment count (three full cycles) chasing a "still only
 *  reads as two waves" report -- that report turned out to mean something
 *  different (see #98): not "this one line needs a clearer third crest,"
 *  but "draw a THIRD PARALLEL LINE in this same shape" (`drawRiverIcon`
 *  briefly stroked three stacked strands instead of two -- since reverted
 *  back to two by design note #100, per direct follow-up request). This
 *  function is reverted back to its original 5-segment/#90 shape
 *  accordingly; the "third wave" attempt is now abandoned entirely (back
 *  to two strands, just spaced slightly further apart, #100). Assumes the
 *  caller has already set `ctx.strokeStyle`/`lineWidth`/`lineCap`/
 *  `lineJoin`; only builds and strokes the path. Shared by
 *  `drawRiverIcon`'s two stacked strands -- which is in turn shared by
 *  BOTH render paths, the standalone icon (Layer 1, simple hexes) and
 *  `drawTerrainCompoundBadge`'s perched icon (complex hexes) -- so any
 *  change here reaches both automatically, no
 *  separate per-call-site edit needed. */
export function drawWaveStrand(
  ctx: CanvasRenderingContext2D,
  startX: number,
  endX: number,
  baseY: number,
  amplitude: number,
): void {
  const width = endX - startX;
  const segments = 5; // three crests, two troughs (design note #90/#98)
  const segment = width / segments;
  ctx.beginPath();
  ctx.moveTo(startX, baseY);
  for (let i = 0; i < segments; i++) {
    const direction = i % 2 === 0 ? -1 : 1; // even segments crest up, odd segments crest down
    const midX = startX + segment * (i + 0.5);
    const endSegX = startX + segment * (i + 1);
    ctx.quadraticCurveTo(midX, baseY + amplitude * direction, endSegX, baseY);
  }
  ctx.stroke();
}

/** Design note #87: shared Mountain/River icon dispatcher -- lets a caller
 *  (the compound badge below) pick the right icon function by `terrainType`
 *  without its own `hex.type === "Mountain" ? ... : ...` branch. */
export function drawTerrainIcon(
  ctx: CanvasRenderingContext2D,
  terrainType: "Mountain" | "River",
  center: { x: number; y: number },
  size: number,
  colorOverride?: string,
): void {
  if (terrainType === "Mountain") {
    drawMountainIcon(ctx, center, size, colorOverride);
  } else {
    drawRiverIcon(ctx, center, size, colorOverride);
  }
}

/** Design note #89: exact rendered WIDTH/HEIGHT-to-`size`-argument ratios
 *  for `drawRiverIcon`/`drawMountainIcon`, derived directly from each
 *  function's own geometry (both scale linearly with their `size`
 *  argument, so one fixed ratio suffices) -- lets `drawTerrainCompoundBadge`
 *  size its icon to an EXACT target WIDTH (matching the red cost box's own
 *  width, per direct request) while still knowing exactly how tall that
 *  produces it, for the block's own vertical layout.
 *   - River: `iconSize = size*0.7`; the two wave strands span
 *     `iconSize*0.68*2` horizontally -> width ratio `0.7*1.36 = 0.952`
 *     (unaffected by strand count/spacing -- both strands share the same
 *     `halfW`). Each strand's own crest/trough excursion is HALF its
 *     control-point `amplitude` (a quadratic Bezier's midpoint value is
 *     `0.5 *` control-offset, not the full offset) -- `amplitude*0.5` on
 *     each side of its own baseline, `amplitude` total per strand;
 *     combined with the gap between the two strands' own baselines, total
 *     vertical span = `strandOffset + amplitude`. Design note #100: back
 *     to two strands (#98's third removed) with `strandOffset` widened
 *     `iconSize*0.16 -> iconSize*0.20` -- span is now `iconSize*(0.20 +
 *     0.24) = iconSize*0.44` -> height ratio `0.7*0.44 = 0.308` (was
 *     `0.392` for three strands, `0.28` for the original narrower
 *     two-strand spacing).
 *   - Mountain: `iconSize = size*1.1375` (design note #101: `size*0.7 ->
 *     size*0.875`, +25%; design note #102: `size*0.875 -> size*1.1375`,
 *     another +30% per direct follow-up request). Bounding WIDTH is the
 *     back (offset) peak's own right edge, the icon's rightmost point
 *     overall -> width ratio `1.1375*0.695 = 0.7905625`. Bounding HEIGHT
 *     is the larger main peak's own full triangle height (the smaller
 *     back peak shares the same vertical center and sits entirely inside
 *     the main peak's taller span) -> height ratio `1.1375*0.42 =
 *     0.47775`. */
export const TERRAIN_ICON_SIZE_RATIO: Readonly<Record<"Mountain" | "River", { width: number; height: number }>> = {
  River: { width: 0.952, height: 0.308 },
  Mountain: { width: 0.7905625, height: 0.47775 },
};

/** Design note #87/#88: a compound badge adjoining a shrunken terrain icon
 *  with its build-cost figure as ONE unit -- REPLACES the standalone icon
 *  (Layer 1, the terrain-icon pass) plus separately-positioned cost box
 *  (Layer 4, this pass) for any "complex" hex -- one with a city, town, or
 *  real track (`isComplexHex` at both call sites) -- per explicit request.
 *
 *  Design note #88 REVISES #87's original layout: the icon no longer sits
 *  INSIDE the red cost box (icon left, text right, shared fill) -- per
 *  direct feedback, it now perches directly ABOVE the box instead, in its
 *  own ordinary terrain color (no `colorOverride`; it's no longer on the
 *  red fill, so it no longer needs a white override for contrast), tightly
 *  adjoined (a small fixed gap) so the two pieces still read as one
 *  combined unit. The box itself is back to holding ONLY the cost text,
 *  same red fill design note #68 established. Both pieces lay out as a
 *  vertically stacked block, centered on `anchor` (the SAME "combined
 *  block centered on one point" pattern design note #78c uses for the
 *  off-board nameplate+revenue block) -- so `anchor` still marks the ONE
 *  slot this whole badge claims, not either piece individually.
 *
 *  Design note #89: the icon is now sized to match the red box's own WIDTH
 *  EXACTLY, per direct request -- REPLACING #87/#88's "shrink to the cost
 *  text's cap-HEIGHT" rule, which left the icon's width essentially
 *  unrelated to the box underneath it. `TERRAIN_ICON_SIZE_RATIO` supplies
 *  the exact `size` argument that produces that target width (and the
 *  height that same `size` produces, for this function's own vertical
 *  layout) -- see that constant's own doc comment for the derivation.
 *  `anchor` is the ALREADY-RESOLVED single slot position the caller
 *  claimed for this whole badge -- unlike the old two-piece rendering (one
 *  slot for the icon, a second for the cost), this is ONE claim for ONE
 *  combined visual unit. */
// Design note #121: shrinks the ENTIRE compound badge (icon + cost box
// together, as one unit) by 35%, per direct request. Applied to the three
// inputs the whole badge's geometry derives from -- base font size,
// padding, and the icon/box gap -- rather than to `boxWidth`/`iconSize`
// themselves, since those are already CALCULATED from these inputs a few
// lines down; scaling the inputs once here lets that existing math do the
// rest (a smaller font -> smaller `textMetrics` -> smaller `boxWidth` ->
// (via `TERRAIN_ICON_SIZE_RATIO`) a smaller `iconSize` too, automatically,
// with no separate icon-specific scale needed). `minFontSizePx` scales
// alongside the base so the floor `fitFontSize` degrades to under a tight
// `maxWidthPx` shrinks proportionally rather than staying at the old,
// now-oversized-relative-to-everything-else floor.
export const COMPOUND_BADGE_SHRINK = 0.65;

export function drawTerrainCompoundBadge(
  ctx: CanvasRenderingContext2D,
  terrainType: "Mountain" | "River",
  costLabel: string,
  anchor: { x: number; y: number },
  maxWidthPx: number,
): void {
  // Design note #92: base font dropped 1pt (9 -> 8), same as the plain-hex
  // cost box, layered on top of #91's tightened box padding (kept, not
  // reverted) -- per direct request, both changes now apply together.
  // Design note #95: raised back 1pt (base `9`) now that the `$` prefix is
  // gone (#94), same as the plain-hex box.
  // Design note #99: raised another 1pt (base `10`), per direct request,
  // same as the plain-hex box.
  // Design note #121: base/floor both scaled by `COMPOUND_BADGE_SHRINK`
  // (10 -> 6.5, 6 -> 3.9) -- see that note above for why scaling the font
  // input is enough to shrink the whole badge.
  ctx.font = fitFontSize(
    ctx,
    costLabel,
    10 * COMPOUND_BADGE_SHRINK,
    maxWidthPx,
    6 * COMPOUND_BADGE_SHRINK,
    "bold",
  );
  const textMetrics = ctx.measureText(costLabel);
  const parsedFontSize = parseInt(ctx.font, 10) || 9;
  const textAscent = textMetrics.actualBoundingBoxAscent ?? parsedFontSize * 0.75;
  const textDescent = textMetrics.actualBoundingBoxDescent ?? parsedFontSize * 0.25;
  const textHeight = textAscent + textDescent;

  // Design note #91 REVERTED (design note #97): padding tried tightened
  // 3/2 -> 1/1, but per direct follow-up request this box is reverted
  // back to its original 3/2 padding, same as the plain-hex cost box.
  // Design note #121: both scaled by `COMPOUND_BADGE_SHRINK` (3 -> 1.95,
  // 2 -> 1.3), same 35% shrink as the font above.
  const paddingX = 3 * COMPOUND_BADGE_SHRINK;
  const paddingY = 2 * COMPOUND_BADGE_SHRINK;
  const boxHeight = textHeight + paddingY * 2;
  const boxWidth = textMetrics.width + paddingX * 2;

  // Design note #89: icon sized so its own rendered width equals `boxWidth`
  // exactly, perched directly above the box with a small gap between the
  // icon's own (resulting) bottom and the box's own top.
  const ratio = TERRAIN_ICON_SIZE_RATIO[terrainType];
  const iconSize = boxWidth / ratio.width;
  const iconRenderedHeight = iconSize * ratio.height;
  // Design note #93: widened 1.5 -> 3, per direct request -- the icon and
  // the red box were reading as directly touching; still small enough
  // that the two pieces read as one combined unit, not two separate ones.
  // Design note #121: scaled by `COMPOUND_BADGE_SHRINK` (3 -> 1.95), same
  // 35% shrink, so the gap stays visually proportional to the
  // now-smaller icon and box rather than reading as relatively wider.
  const iconGap = 3 * COMPOUND_BADGE_SHRINK;

  const totalHeight = iconRenderedHeight + iconGap + boxHeight;
  const blockTop = anchor.y - totalHeight / 2;

  const iconCenter = { x: anchor.x, y: blockTop + iconRenderedHeight / 2 };
  drawTerrainIcon(ctx, terrainType, iconCenter, iconSize);

  const boxY = blockTop + iconRenderedHeight + iconGap;
  const boxX = anchor.x - boxWidth / 2;
  const radius = Math.min(2, boxHeight / 2, boxWidth / 2);

  // Design note #68: same solid red this file's terrain-cost box has
  // always used -- now holds ONLY the cost text (design note #88 moved the
  // icon out of it, to perch above instead).
  fillRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, radius, "#E53E3E");

  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(costLabel, anchor.x, boxY + boxHeight / 2);
}

/** Rail Map Overhaul (design note #42): paints a dark, translucent
 *  `strokeText` halo directly behind `text`, THEN the actual `fillText` on
 *  top -- the "Text Stroke Outline / Halos" requirement, so a label reads
 *  crisply at any zoom level even where it sits over a busy hex fill/track
 *  crossing rather than `drawLabelWithBackground`'s own solid contrast box.
 *  `lineJoin = "round"` keeps the halo from spiking at sharp glyph corners.
 *  Assumes the caller has already set `ctx.font`/`ctx.textAlign`/
 *  `ctx.textBaseline` (identical assumption to `drawLabelWithBackground`
 *  below, which this is a standalone sibling of for the handful of direct
 *  `ctx.fillText` call sites that don't go through that function's own
 *  background-box path). */
export function fillTextWithHalo(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
  ctx.lineWidth = 3;
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

/** Design note #84: fills a rounded rectangle -- extracted, behavior-
 *  identical, from `drawLabelWithBackground`'s own inline box-drawing block
 *  below (still used there) so `drawStackedNameLabel` can paint ONE shared
 *  box spanning two lines of text without duplicating this path-building
 *  logic a second time. */
export function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
  radius: number,
  fillStyle: string,
): void {
  ctx.save();
  // Item 8 (Track-Under-Text Layer Masking): the background plate itself
  // never carries a drop shadow, even when the caller has `ctx.shadowColor`/
  // `shadowBlur` set for text drawn just below -- scoped to just this rect
  // fill via save/restore.
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(boxX + radius, boxY);
  ctx.arcTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + boxHeight, radius);
  ctx.arcTo(boxX + boxWidth, boxY + boxHeight, boxX, boxY + boxHeight, radius);
  ctx.arcTo(boxX, boxY + boxHeight, boxX, boxY, radius);
  ctx.arcTo(boxX, boxY, boxX + boxWidth, boxY, radius);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Draws `text` centered at `point`, first painting a small translucent
 *  rounded-rectangle background sized to the actual measured text -- see
 *  design note #6c. This is what stops a legibly-sized label (per
 *  `fitFontSize`) from still visually colliding with a track stroke or
 *  another hex's fill/outline drawn underneath it. Assumes the caller has
 *  already set `ctx.font`/`ctx.fillStyle`(text color)/`ctx.textAlign`/
 *  `ctx.textBaseline` -- both call sites below set `textAlign`/`textBaseline`
 *  to `"center"`/`"middle"`, which this box-centering logic assumes.
 *
 *  `strokeHalo` (design note #42): also run `text` through
 *  `fillTextWithHalo`'s dark stroke-outline pass instead of a plain
 *  `ctx.fillText` -- belt-and-suspenders legibility on top of the
 *  background box above (or the ONLY legibility aid at all for the one
 *  caller, `drawBoardMarginLabels`, that sets `background: false` and
 *  floats its text with no box whatsoever). Default `false` so every
 *  existing call site's rendering is unchanged unless it opts in. */
export function drawLabelWithBackground(
  ctx: CanvasRenderingContext2D,
  text: string,
  point: { x: number; y: number },
  options?: {
    paddingX?: number;
    paddingY?: number;
    fillStyle?: string;
    background?: boolean;
    strokeHalo?: boolean;
    /** Design note #51: overrides the box's corner rounding, otherwise
     *  `Math.min(6, boxHeight / 2, boxWidth / 2)` below. Every existing
     *  caller omits this and keeps that default; `drawHexNameLabel`'s new
     *  "18xx-Style Text Background Shield Box" passes a near-zero value for
     *  a genuinely RECTANGULAR box, per that request's own explicit
     *  wording, rather than the soft pill-like rounding every other caller
     *  still uses. */
    cornerRadiusPx?: number;
  },
): void {
  const paddingX = options?.paddingX ?? 4;
  const paddingY = options?.paddingY ?? 2;

  // `background` (design note #30/item 2) -- `false` skips the rounded-rect
  // contrast box entirely and just paints `text` directly, for the one
  // caller (`drawBoardMarginLabels`) that explicitly wants its labels
  // floating with no boxed frame around them. Every other call site omits
  // this option and keeps the box (default `true`), unchanged.
  if (options?.background ?? true) {
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    // Some canvas implementations only populate `width`, not the
    // bounding-box ascent/descent metrics -- fall back to a font-size-derived
    // estimate (parsed off the already-set `ctx.font` string) so the box is
    // still reasonably sized either way.
    const parsedFontSize = parseInt(ctx.font, 10) || 12;
    const ascent = metrics.actualBoundingBoxAscent ?? parsedFontSize * 0.75;
    const descent = metrics.actualBoundingBoxDescent ?? parsedFontSize * 0.25;
    const textHeight = ascent + descent;

    const boxWidth = textWidth + paddingX * 2;
    const boxHeight = textHeight + paddingY * 2;
    const boxX = point.x - boxWidth / 2;
    const boxY = point.y - boxHeight / 2;

    const radius = options?.cornerRadiusPx ?? Math.min(6, boxHeight / 2, boxWidth / 2);
    fillRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, radius, options?.fillStyle ?? "rgba(255, 255, 255, 0.72)");
  }

  // `ctx.fillStyle` here is whatever the caller set before calling this
  // function -- untouched by the `ctx.save()`/`ctx.restore()` pair above,
  // which only scoped the background box's own fill color.
  if (options?.strokeHalo) {
    fillTextWithHalo(ctx, text, point.x, point.y);
  } else {
    ctx.fillText(text, point.x, point.y);
  }
}

/** Measures `text` at `baseFontSizePx` and shrinks it (in 1px steps, down to
 *  `minFontSizePx`) until `ctx.measureText` confirms it fits within
 *  `maxWidthPx` -- see design note #3b. Returns the CSS font string to
 *  assign to `ctx.font`, at whichever size it settled on. `fontWeight` is
 *  the CSS font-weight/style prefix (e.g. `"bold"`, or `""` for normal).
 *
 *  Crisp Token Typography (design note #46): the font-family stack is now
 *  the explicit `system-ui, -apple-system, sans-serif` requested (was a
 *  bare `sans-serif`) -- applied here, for every one of this file's eight
 *  `fitFontSize` call sites at once, since a font-family substitution
 *  (unlike a shared size floor) carries no per-caller layout risk: it only
 *  swaps which real typeface the browser resolves a generic sans-serif
 *  request to, never changes measured glyph widths enough to threaten any
 *  caller's own `maxWidthPx` fit. Scoped to `fitFontSize` itself, not
 *  applied to this file's small number of OTHER, unrelated hardcoded
 *  `ctx.font = "...sans-serif"` strings outside this helper (e.g. the stock
 *  ticker panel's row/title fonts) -- those weren't part of this request
 *  and are left untouched rather than swept up incidentally. */
export const FONT_FAMILY_STACK = "system-ui, -apple-system, sans-serif";

export function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  baseFontSizePx: number,
  maxWidthPx: number,
  minFontSizePx: number,
  fontWeight: string,
): string {
  const prefix = fontWeight ? `${fontWeight} ` : "";
  let fontSize = baseFontSizePx;
  while (fontSize > minFontSizePx) {
    const candidate = `${prefix}${fontSize}px ${FONT_FAMILY_STACK}`;
    ctx.font = candidate;
    if (ctx.measureText(text).width <= maxWidthPx) {
      return candidate;
    }
    fontSize -= 1;
  }
  return `${prefix}${minFontSizePx}px ${FONT_FAMILY_STACK}`;
}

/** Standardized City Nameplate Typography (design note #50), REVISED by
 *  design note #51's "18xx-Style Text Background Shield Box". Shared by
 *  every name-label call site in `draw()` -- landmark names, gray/OO hex
 *  names, and the two independent halves of a split dual-city OO/
 *  double-town label -- so all of them read identically.
 *
 *  #50's own reversal of the OLDER "Muted Base Text with Hover Glow"
 *  styling (item 7) still stands on its main points: no glow/shadow, no
 *  translucent color, solid `#000000` text in both hover states -- see
 *  #50's own doc comment (this function's history, left in place) for that
 *  reasoning. #51 partially reverses ONE piece of it, though: #50 also
 *  removed the background box ENTIRELY (a bare `ctx.fillText`, nothing
 *  drawn behind it) -- #51 restores a box, but a functionally different one
 *  from the OLD pre-#50 pill: tight (2.5px padding, near this request's
 *  requested 2px-3px), genuinely RECTANGULAR (a near-zero `cornerRadiusPx`,
 *  not `drawLabelWithBackground`'s default soft rounding), ZERO stroke
 *  (`drawLabelWithBackground`'s box was always stroke-free to begin with --
 *  see that function's own body), and filled to nearly MATCH the
 *  surrounding hex rather than stand out as a floating dark plate -- see
 *  `boxFill` below. Purpose per the request: block a track spline from
 *  visually cutting through a letterform where it passes under the text,
 *  not to draw attention to the label as a UI element the way the OLD pill
 *  did.
 *
 *  `boxFill`: the caller-supplied color the box should ~match. Precise
 *  per-hex fill matching (reading back whatever `TERRAIN_FILL`/
 *  `PRINTED_HEX_FILL` entry actually painted that exact hex) was considered
 *  and rejected as unnecessary complexity for a purely functional occlusion
 *  box -- the request's own wording offers "match the hex background fill
 *  (OR soft pale yellow ... on yellow OO hexes)" as two acceptable
 *  alternatives, not one strict requirement. Call sites instead pass one of
 *  two constants below: `NAMEPLATE_BOX_FILL_YELLOW` for the two hex
 *  categories that are ACTUALLY printed yellow (landmarks, OO hexes --
 *  `PRINTED_HEX_FILL.Yellow`-filled per the "Unify All Board Yellow Shades"
 *  pass), `NAMEPLATE_BOX_FILL_DEFAULT` for every other nameplate (gray/
 *  named single-city hexes, double-town hexes), a warm cream close to this
 *  file's own `TERRAIN_FILL`/`BOARD_HEX_FILL.Plain` family so it reads as
 *  "part of the tile" rather than a mismatched patch.
 *
 *  `NAMEPLATE_FONT_SIZE_PX`/`NAMEPLATE_FONT_MIN_PX` (module-level constants,
 *  just below, UNCHANGED by #51): a genuinely narrow, near-fixed band --
 *  was base 10/min 6 at rest and base 13/min 7 on hover pre-#50, a swing of
 *  more than 2x end to end across this file's ~32 real city/town names.
 *  `fitFontSize` only ever actually shrinks below `NAMEPLATE_FONT_SIZE_PX`
 *  for the small handful of outlier long single-line names ("Washington,
 *  D.C.", "Atlantic City") -- every other name (now including every OO/
 *  double-town half, split onto its own line by the stacking passes below)
 *  renders at the exact same size. A truly zero-tolerance fixed size (no
 *  shrink band at all) was considered and rejected: those two outlier
 *  names would then visibly overflow their own hex's width at default
 *  zoom, which is a worse legibility defect than the (now much narrower)
 *  size band this keeps instead.
 *
 *  Weight (design note #51): ALWAYS bold now, matching the request's own
 *  "bold, high-contrast sans-serif" wording -- was bold-on-hover/
 *  normal-at-rest (#50). Hover no longer changes anything about this
 *  label's own rendering at all; the box/text are now identical in both
 *  states. `FONT_FAMILY_STACK` (design note #46, `system-ui, -apple-system,
 *  sans-serif`) is kept rather than swapped for the request's own literal
 *  `system-ui, sans-serif` example -- a strict superset fallback chain, not
 *  a deviation from it. */
// Design note #78: bumped 10/8 -> 11/9 as part of standardizing EVERY
// nameplate on the board (previously the off-board zone pass had its own
// independent 10/6 literals) onto one shared, crisp size band -- see that
// design note's own top-of-file entry for the full before/after.
// Design note #80: reported too large at 11/9 -- dropped 4pt to 7/5.
// Design note #81: 7pt tried next-smallest at 8/6, per direct feedback --
// same shared band, still applied uniformly board-wide (on-board and
// off-board nameplates alike, per #78/#79).
export const NAMEPLATE_FONT_SIZE_PX = 8;
export const NAMEPLATE_FONT_MIN_PX = 6;
/** Design note #51: `lineHeight = 1.05 * fontSize`, per the request's own
 *  explicit formula -- each stacked line offsets `NAMEPLATE_LINE_HEIGHT_PX
 *  / 2` above/below true center, so consecutive line centers sit exactly
 *  one `lineHeight` apart. Derived from `NAMEPLATE_FONT_SIZE_PX` (not
 *  `hexSize`, unlike the OLD `hexSize * 0.19`/`0.24` offsets it replaces)
 *  so the stack's own compactness tracks the now-fixed font size rather
 *  than the hex's zoom-dependent pixel size. */
export const NAMEPLATE_LINE_HEIGHT_PX = NAMEPLATE_FONT_SIZE_PX * 1.05;
/** Design note #54 ("High-Contrast Light Shield Boxes"), REPLACING #51's
 *  two-constant scheme (`NAMEPLATE_BOX_FILL_YELLOW`/`_DEFAULT`) with a
 *  three-way, explicitly tier-matched set -- see `nameplateBoxFillFor`'s own
 *  doc comment for exactly which hex/tile state maps to which constant.
 *  `NAMEPLATE_BOX_FILL_YELLOW` (`#FEF08A`) is unchanged from #51. The other
 *  two are new: `NAMEPLATE_BOX_FILL_GREEN` (`#DCFCE7`, pale mint) for a laid
 *  Green tile, and `NAMEPLATE_BOX_FILL_SLATE` (`#F1F5F9`, light pale slate)
 *  for a laid Brown tile, a real GRAY preprinted hex, or any other ordinary
 *  hex -- retiring the old flat cream `NAMEPLATE_BOX_FILL_DEFAULT`
 *  (`#f4ecd8`) that used to cover all three of those cases identically. */
// Design note #78's tier-matched nameplate fills were removed alongside
// `nameplateBoxFillFor`, their only consumer -- the note above records what
// they were (#FEF08A yellow / #DCFCE7 mint / #F1F5F9 slate) if the
// tier-matched scheme is ever revived.
/** Design note #78: REPLACES the tier-color-matched `NAMEPLATE_BOX_FILL_*`
 *  scheme above (still defined, just no longer wired into `drawHexNameLabel`)
 *  with one flat semi-transparent white shield for every nameplate on the
 *  board, on-board and off-board alike -- so a track spline underneath
 *  stays softly visible through the box at rest, and the box (not the
 *  underlying tile color) is what changes on hover, going fully opaque so a
 *  hovered name is unambiguously the most readable element on that hex.
 *  Design note #82: opacity dropped 0.75 -> 0.55 (20 points more
 *  transparent), per direct request -- hover still goes fully opaque
 *  (`_HOVERED`, unchanged), so the at-rest/hover contrast is now wider. */
export const NAMEPLATE_SHIELD_FILL = "rgba(255, 255, 255, 0.55)";
export const NAMEPLATE_SHIELD_FILL_HOVERED = "rgba(255, 255, 255, 1.0)";

/** Design note #54: resolves the tier-matched shield-box fill for the
 *  nameplate at `(q, r)` -- a laid tile's REAL current color when one
 *  exists (via `TILE_CATALOG_BY_ID`, the same lookup the laid-tile fill/
 *  stroke pass above uses), or the hex's own static printed category
 *  (`STATIC_BOARD_HEXES.printedColor`) when nothing has been laid there
 *  yet. Yellow tile / printed-Yellow hex (landmarks, OO hexes before their
 *  own first lay) -> `NAMEPLATE_BOX_FILL_YELLOW`; Green tile ->
 *  `NAMEPLATE_BOX_FILL_GREEN`; Brown tile, a real GRAY preprinted hex
 *  (`printedColor: "Gray"`), or any other ordinary hex with no printed
 *  color at all (a bare white city/town-designated hex) ->
 *  `NAMEPLATE_BOX_FILL_SLATE` -- the request's own "Brown / Gray /
 *  Off-Board Hexes" grouping. Every existing `drawHexNameLabel` call site
 *  is still gated by `hexHasLaidTile`'s Dynamic City Nameplate Suppression
 *  (design note #47), so the laid-tile branch below is not reachable
 *  through any of today's four call sites -- kept fully wired anyway (a
 *  real lookup, not a stub) so this helper is complete and correct on its
 *  own terms rather than silently dropping the Green case. */
export function drawHexNameLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  point: { x: number; y: number },
  maxWidthPx: number,
  isHovered: boolean,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Design note #78: REGULAR weight now (was always `"bold"` since #51) --
  // `isHovered` still doesn't affect sizing/weight, only which shield-box
  // fill is used just below.
  ctx.font = fitFontSize(ctx, text, NAMEPLATE_FONT_SIZE_PX, maxWidthPx, NAMEPLATE_FONT_MIN_PX, "");
  // Design note #78: flat semi-transparent white shield at rest, fully
  // opaque on hover (REPLACING #54's tier-color-matched `boxFill` param) --
  // tight (2px padding, 2px corner radius, genuinely rectangular, never
  // stroked) box shape unchanged from #54/#51. Solid `#000000` text,
  // unchanged.
  ctx.fillStyle = "#000000";
  drawLabelWithBackground(ctx, text, point, {
    paddingX: 2,
    paddingY: 2,
    fillStyle: isHovered ? NAMEPLATE_SHIELD_FILL_HOVERED : NAMEPLATE_SHIELD_FILL,
    cornerRadiusPx: 2,
  });
  ctx.restore();
}

/** Design note #84: draws a two-line "A" over "B" nameplate (every #83
 *  ampersand/"Maritime Provinces" wrap case) with ONE shared background
 *  shield spanning BOTH lines, instead of each line independently calling
 *  `drawHexNameLabel` and painting its own box. Reported: two of #82's
 *  0.55-alpha boxes, stacked directly above/below each other with only
 *  `NAMEPLATE_LINE_HEIGHT_PX` between their centers, overlapped in the
 *  shared band between the two lines -- alpha compositing then made that
 *  overlapped strip visibly darker than the rest of the shield, a seam
 *  right where the two lines meet. Unioning both lines' padded boxes into
 *  ONE rect, filled once via `fillRoundedRect`, removes the seam entirely
 *  regardless of the two lines' relative widths. Both lines also render at
 *  one SHARED font size -- the smaller of each line's own independent
 *  `fitFontSize` result -- so a length mismatch between the two words
 *  can't produce a visible size mismatch either. `center` is the same
 *  point every existing two-line call site already computed as the
 *  midpoint between its two lines (`center.y -/+ NAMEPLATE_LINE_HEIGHT_PX
 *  / 2`) -- this function derives that same split internally, so callers
 *  just pass the shared center they already had. */
export function drawStackedNameLabel(
  ctx: CanvasRenderingContext2D,
  lines: readonly [string, string],
  center: { x: number; y: number },
  maxWidthPx: number,
  isHovered: boolean,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const font0 = fitFontSize(ctx, lines[0], NAMEPLATE_FONT_SIZE_PX, maxWidthPx, NAMEPLATE_FONT_MIN_PX, "");
  const size0 = parseInt(font0, 10) || NAMEPLATE_FONT_MIN_PX;
  const font1 = fitFontSize(ctx, lines[1], NAMEPLATE_FONT_SIZE_PX, maxWidthPx, NAMEPLATE_FONT_MIN_PX, "");
  const size1 = parseInt(font1, 10) || NAMEPLATE_FONT_MIN_PX;
  const sharedSize = Math.min(size0, size1);
  ctx.font = `${sharedSize}px ${FONT_FAMILY_STACK}`;

  const lineOffset = NAMEPLATE_LINE_HEIGHT_PX / 2;
  const point0 = { x: center.x, y: center.y - lineOffset };
  const point1 = { x: center.x, y: center.y + lineOffset };

  const metrics0 = ctx.measureText(lines[0]);
  const metrics1 = ctx.measureText(lines[1]);
  const ascent0 = metrics0.actualBoundingBoxAscent ?? sharedSize * 0.75;
  const descent1 = metrics1.actualBoundingBoxDescent ?? sharedSize * 0.25;

  const paddingX = 2;
  const paddingY = 2;
  const boxWidth = Math.max(metrics0.width, metrics1.width) + paddingX * 2;
  const boxTop = point0.y - ascent0 - paddingY;
  const boxBottom = point1.y + descent1 + paddingY;
  const boxHeight = boxBottom - boxTop;
  const boxX = center.x - boxWidth / 2;
  const radius = Math.min(2, boxHeight / 2, boxWidth / 2);

  fillRoundedRect(
    ctx,
    boxX,
    boxTop,
    boxWidth,
    boxHeight,
    radius,
    isHovered ? NAMEPLATE_SHIELD_FILL_HOVERED : NAMEPLATE_SHIELD_FILL,
  );

  ctx.fillStyle = "#000000";
  ctx.fillText(lines[0], point0.x, point0.y);
  ctx.fillText(lines[1], point1.x, point1.y);
  ctx.restore();
}

/** Design note #79: draws a single-node hex's nameplate at `anchor`, with a
 *  much more generous `maxLineWidthPx` (from the call site, matching the
 *  off-board pass's own `hexFlatWidth * 0.92`, up from #78's tight `0.55`)
 *  so long single-line names (Atlantic City, Fall River, Washington, D.C.,
 *  Providence, Rochester, Kingston, Cleveland, Columbus, Lancaster,
 *  Baltimore) no longer need to shrink via `fitFontSize` the way they did
 *  under #78's tighter budget -- exactly the "different font size from the
 *  other nameplates" bug #78 was supposed to eliminate but didn't. The
 *  hex's own clip mask (`withHexClip`, #53) is the real safety net for any
 *  name that somehow still doesn't fit.
 *
 *  Design note #83 REMOVES this function's own #79-era "wrap a multi-word
 *  name at its first space" behavior: per explicit rule, a single-node
 *  hex's nameplate NEVER wraps (none of the single-node names -- gray/
 *  named hexes, Boston, Baltimore -- contain an ampersand, and none of
 *  them is the one named exception, Maritime Provinces, which is an
 *  off-board zone handled by `drawOffboardNameplate` instead). Kept as a
 *  thin, explicitly-named wrapper (rather than inlining `drawHexNameLabel`
 *  at both call sites) so a future single-node exception, if one is ever
 *  added, has one obvious place to go. */
export function drawSingleNodeNameplate(
  ctx: CanvasRenderingContext2D,
  name: string,
  anchor: { x: number; y: number },
  maxLineWidthPx: number,
  isHovered: boolean,
): void {
  drawHexNameLabel(ctx, name, anchor, maxLineWidthPx, isHovered);
}

/** Design note #83: the board-wide nameplate-wrap rule -- a nameplate
 *  breaks onto two stacked lines ONLY when it names two separate cities
 *  via an ampersand ("A & B" -- the OO/double-town/landmark-DoubleCity
 *  passes' own existing `.split(" & ")` calls already implement this), with
 *  ONE named exception: "Maritime Provinces", too long for its single hex
 *  on one line despite naming only one place. Every OTHER off-board zone
 *  name ("Chicago", "Gulf", "Canadian West", "Deep South") stays a single
 *  line now, reversing #47's old "every multi-word name wraps" default. */
export function offboardNameplateLines(offboardName: string): readonly string[] {
  if (offboardName === "Maritime Provinces") {
    const spaceIndex = offboardName.indexOf(" ");
    return [offboardName.slice(0, spaceIndex), offboardName.slice(spaceIndex + 1)];
  }
  return [offboardName];
}

/** Floating "canvas tooltip card" showing an off-board zone's full
 *  Yellow -> Green -> Brown revenue progression -- see design note #15/
 *  item 4. Drawn in the SAME world-space transform as everything else in
 *  `draw()` (so it pans/zooms with the board exactly like every other
 *  on-canvas label here, matching this file's existing convention rather
 *  than adding a second, screen-space-fixed overlay system), anchored just
 *  outside the hovered hex's own center so the card never covers the hex
 *  it's describing. Each row gets a small color-coded dot matching
 *  `COLOR_TIER_STROKE`, and the row matching `currentEra` is bolded/in white
 *  (a separate green "ACTIVE" label used to repeat that same emphasis a
 *  second time and was removed per feedback -- the bold/white treatment
 *  alone is enough) -- the same value already rendered directly inside the
 *  hex (see the off-board label pass in `draw()`), shown here alongside
 *  its Yellow/Green/Brown context.
 *
 *  ADAPTIVE QUADRANT (follow-up to design note #15/item 4): a fixed
 *  "always above-right" anchor used to clip off the visible canvas for
 *  off-board zones that sit near the board's top or right edge --
 *  Canadian West (top-center) and Maritime Provinces (top-right) both had
 *  no room above/right of their hex for the card to render into, so it
 *  rendered off-frame and was never visible. `preferLeft`/`preferBelow`
 *  (computed by the caller from the hovered hex's position relative to
 *  the board's own center, via `boardContentBounds`) flip the card to
 *  whichever side of the hex actually points back toward the board's
 *  interior, so it always has room. This is deliberately NOT a blanket
 *  "always below-left" flip: Gulf (bottom-left) and Deep South
 *  (bottom-center) already render correctly with the original above-right
 *  anchor precisely because they sit in the opposite corner from Canadian
 *  West/Maritime -- forcing them to below-left too would just move the
 *  clipping problem to the bottom edge instead of fixing it. */
export function drawOffboardTooltip(
  ctx: CanvasRenderingContext2D,
  anchor: { x: number; y: number },
  hexSize: number,
  zoneName: string,
  tiers: OffboardRevenueTiers,
  currentEra: TileColorTier,
  preferLeft: boolean,
  preferBelow: boolean,
): void {
  // Green shares the Yellow-printed figure -- see `offboardValueForEra`'s
  // own doc comment for why there's no distinct third number.
  const rows: ReadonlyArray<{ label: TileColorTier; value: number }> = [
    { label: "Yellow", value: tiers.yellow },
    { label: "Green", value: tiers.yellow },
    { label: "Brown", value: tiers.brown },
  ];

  const paddingX = 10;
  const paddingY = 8;
  const rowHeight = 16;
  const titleFont = "bold 12px sans-serif";
  const rowFont = "11px sans-serif";

  ctx.font = titleFont;
  const titleWidth = ctx.measureText(zoneName).width;
  ctx.font = rowFont;
  let maxRowWidth = 0;
  for (const row of rows) {
    maxRowWidth = Math.max(maxRowWidth, ctx.measureText(`${row.label}: $${row.value}`).width + 16);
  }
  const cardWidth = Math.max(titleWidth, maxRowWidth) + paddingX * 2;
  const cardHeight = paddingY * 2 + 18 + rows.length * rowHeight;

  const cardX = preferLeft ? anchor.x - hexSize * 0.7 - cardWidth : anchor.x + hexSize * 0.7;
  const cardY = preferBelow ? anchor.y + hexSize * 0.9 : anchor.y - hexSize * 0.9 - cardHeight;

  ctx.save();
  ctx.fillStyle = "rgba(18, 20, 26, 0.94)";
  ctx.strokeStyle = "#3a3f4b";
  ctx.lineWidth = 1.5;
  const radius = 8;
  ctx.beginPath();
  ctx.moveTo(cardX + radius, cardY);
  ctx.arcTo(cardX + cardWidth, cardY, cardX + cardWidth, cardY + cardHeight, radius);
  ctx.arcTo(cardX + cardWidth, cardY + cardHeight, cardX, cardY + cardHeight, radius);
  ctx.arcTo(cardX, cardY + cardHeight, cardX, cardY, radius);
  ctx.arcTo(cardX, cardY, cardX + cardWidth, cardY, radius);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f4ecd8";
  ctx.font = titleFont;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(zoneName, cardX + paddingX, cardY + paddingY);

  let rowY = cardY + paddingY + 18;
  for (const row of rows) {
    const isActive = row.label === currentEra;

    ctx.fillStyle = COLOR_TIER_STROKE[row.label];
    ctx.beginPath();
    ctx.arc(cardX + paddingX + 4, rowY + rowHeight / 2, 4, 0, Math.PI * 2);
    ctx.fill();

    // The bold/white treatment above already marks the active era on its
    // own; the separate green "ACTIVE" label used to repeat that same
    // information a second time, so it's been removed per feedback.
    ctx.fillStyle = isActive ? "#ffffff" : "#b8bcc4";
    ctx.font = isActive ? "bold 11px sans-serif" : rowFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${row.label}: $${row.value}`, cardX + paddingX + 14, rowY + rowHeight / 2);

    rowY += rowHeight;
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Board margin labels -- see design note #16                         */
/* ------------------------------------------------------------------ */

/** Parses the real printed column number out of a board hex's own `label`
 *  (e.g. `"G19"` -> `19`) -- see design note #16. */
export function parseColumnNumber(label: string): number | null {
  const match = /^[A-Z]+(\d+)$/.exec(label);
  return match ? Number(match[1]) : null;
}

/** Real board row letters, one per axial row index `r` -- row A (`r = 0`)
 *  through row K (`r = 10`), matching every real hex `label` in
 *  `STATIC_BOARD_HEXES` exactly (see design note #6's row-letter/column-
 *  number -> axial transform, which this is the direct inverse of for the
 *  row half). */
export function rowLetterForR(r: number): string {
  return String.fromCharCode(65 + r);
}

/** Computes where to stamp each row's letter (left/right margins) and each
 *  column's number (top/bottom margins) -- see design note #16. Built
 *  directly off the real `STATIC_BOARD_HEXES` data (not a generated
 *  rectangle): a label only ever appears for a real row/column of the
 *  authentic 93-hex board. Per design note #1's pointy-top axial geometry,
 *  a fixed axial row `r` always shares one pixel `y` regardless of `q`, and
 *  a fixed real column number always shares one pixel `x` regardless of
 *  which row it's read from (`x = hexSize * sqrt(3) * (columnNumber - 1) /
 *  2`, independent of `r`, by substituting `q = (columnNumber - 1 - r) / 2`
 *  into `axialToPixel`) -- which is exactly why the physical board's
 *  rows/columns print as straight horizontal/vertical lines in the first
 *  place. This function re-derives both purely from `axialToPixel` itself
 *  (not that hand-expanded formula), so it can never drift out of sync with
 *  design note #1's own conversion.
 *
 *  CROSS-AXIS POSITIONING (design note #25 -- restores what design note #24
 *  had temporarily dropped): this function computes BOTH axes again -- each
 *  row's `y` / column's `x` (the axis that has to line up with actual hex
 *  rows/columns) AND each row's `leftX`/`rightX` / column's `topY`/`bottomY`
 *  (how far out from the board's own real extent the label floats,
 *  STRAIGHTENED to one shared value per side -- see below). Design note #24
 *  briefly dropped the latter when labels were a DOM overlay pinned to the
 *  canvas's own literal pixel edges; now that labels are drawn NATIVELY on
 *  the canvas instead (design note #25), that DOM-edge anchor no longer
 *  exists, so the cross-axis position has to come from real board geometry
 *  again, exactly like it did before design note #20.
 *
 *  STRAIGHTENED margins (design note #16/#17): every row's left-margin
 *  label used to sit at that row's OWN real leftmost hex -- correct
 *  per-row, but visually staircased/jagged overall, since the board's
 *  ragged ends (e.g. row A only spans columns 9-19, no column-3 hex) put
 *  each row's real leftmost hex at a different x. `leftX`/`rightX` are ONE
 *  shared value for every row -- the min/max across the ENTIRE board, not
 *  just that row -- so every row-letter label lines up on a single straight
 *  vertical line at each margin, matching how a real printed board's
 *  row-letter gutter is one straight column of text, not a jagged one.
 *  `topY`/`bottomY` are straightened the identical way across every
 *  column. */
export function computeBoardMarginLabels(
  ctx: CanvasRenderingContext2D,
  hexSize: number,
  fontSize: number,
): {
  rows: Array<{ letter: string; y: number; leftX: number; rightX: number }>;
  columns: Array<{ columnNumber: number; x: number; topY: number; bottomY: number }>;
} {
  const rowY = new Map<number, number>();
  const colX = new Map<number, number>();
  let boardMinX = Infinity;
  let boardMaxX = -Infinity;
  let boardMinY = Infinity;
  let boardMaxY = -Infinity;

  for (const hex of STATIC_BOARD_HEXES) {
    const { x, y } = axialToPixel(hex.q, hex.r, hexSize);
    boardMinX = Math.min(boardMinX, x);
    boardMaxX = Math.max(boardMaxX, x);
    boardMinY = Math.min(boardMinY, y);
    boardMaxY = Math.max(boardMaxY, y);

    if (!rowY.has(hex.r)) rowY.set(hex.r, y);

    const columnNumber = parseColumnNumber(hex.label);
    if (columnNumber === null) continue;
    if (!colX.has(columnNumber)) colX.set(columnNumber, x);
  }

  // ITEM 2 FIX (this pass, "Inset Canvas Drawing for Margins" -- see design
  // note #28). The structural calibration pass's `hexSize * 0.93` inset
  // only ever cleared the OUTERMOST HEX's own silhouette against the
  // camera's `hexEdgePadding = hexSize` visible boundary -- it never
  // accounted for a drawn label's own rendered box (this label's text plus
  // `drawLabelWithBackground`'s own background padding) extending further
  // still, past that anchor point, in the direction the label reads. A
  // 2-character column number, or the background box's own padding, could
  // each eat into -- and exceed -- the old inset's remaining ~0.07 *
  // hexSize of clearance, silently slicing the label exactly as this item
  // reports. This measures the actual widest row-letter and column-number
  // label this board will ever draw, using the SAME font
  // `drawBoardMarginLabels` sets on `ctx` before calling this (a real
  // rendered size, not a guessed constant), and folds that half-extent plus
  // the background padding into a single safety offset applied to every
  // margin, so each label's own drawn box -- not just its anchor point --
  // stays inside the camera's visible boundary.
  // must match `boardContentBounds`'s own camera-fit padding exactly (see
  // its "Camera Padding Must Reserve Room For Margin Labels" comment) --
  // both derive the SAME `hexSize + marginLabelReserve(hexSize)` total, or
  // this function's labels end up placed outside the camera's actual
  // visible boundary (clipped) or inside it with less room than the camera
  // reserved (back to overlapping the outermost hex).
  const hexEdgePadding = hexSize + marginLabelReserve(hexSize);
  const rowLetterStrings = Array.from(rowY.keys()).map(rowLetterForR);
  const columnNumberStrings = Array.from(colX.keys()).map(String);
  // ITEM (this pass, "Vertical Margin Label Clearance"): row letters sit to
  // the LEFT/RIGHT of the board, so the dimension that determines whether
  // their drawn box clears the outermost hex is the label's WIDTH (how far
  // it extends back toward the board horizontally). Column numbers sit
  // ABOVE/BELOW the board, so the dimension that matters for THEM is the
  // label's HEIGHT (how far it extends back toward the board vertically) --
  // a different quantity, not interchangeable with width. The previous
  // version measured only `.width` for every label (row letters AND column
  // numbers combined) and reused that single value for both the horizontal
  // AND vertical safety offsets. That happened to work for the row letters
  // (width is exactly what they need) but understated the true clearance
  // column numbers need whenever a label's rendered height exceeds its
  // rendered width (typical for digit glyphs), letting the top/bottom
  // column-number row sit on top of the outermost hexes -- exactly the
  // reported bug ("top and bottom rows... does not encroach on the side").
  const rowLabelWidth = rowLetterStrings.reduce(
    (max, label) => Math.max(max, ctx.measureText(label).width),
    0,
  );
  const columnLabelMetrics = columnNumberStrings.map((label) => ctx.measureText(label));
  // `actualBoundingBoxAscent`/`actualBoundingBoxDescent` give the label's
  // real rendered extent above/below the anchor point, relative to
  // `drawBoardMarginLabels`'s `ctx.textBaseline = "middle"` -- the correct
  // vertical analogue of `.width`. Some canvas backends don't populate
  // these (older engines, some headless polyfills), so fall back to
  // `fontSize` (a reasonable glyph-height estimate) when either is missing
  // or non-finite.
  const columnLabelHeight = columnLabelMetrics.reduce((max, metrics) => {
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const height =
      Number.isFinite(ascent) && Number.isFinite(descent) ? ascent + descent : fontSize;
    return Math.max(max, height);
  }, 0);
  // `drawLabelWithBackground`'s own default `paddingX` -- the larger of its
  // two default paddings, used here as a single conservative margin.
  // Aliased from the shared module-level constant (see its doc comment) so
  // this can never silently drift out of sync with `boardContentBounds`'s
  // own `marginLabelReserve` budget, which is built from the same value.
  const BACKGROUND_PADDING_PX = MARGIN_LABEL_BACKGROUND_PADDING_PX;
  // Design note #36/item 2 ("Inset Margin Label Drawings"): an EXTRA
  // clearance budget on top of `BACKGROUND_PADDING_PX` above. Before this,
  // the safety offset placed a label's rendered edge only
  // `BACKGROUND_PADDING_PX` (4 world-space units) inside the camera's own
  // exact visible boundary (`boardContentBounds`'s `hexEdgePadding`) --
  // razor-thin, and at typical zoom levels that's only a handful of real
  // screen pixels of clearance, easily read as "sliced off by the pane
  // borders" from any small additional discrepancy (canvas backing-store
  // rounding, a scrollbar narrowing the measured width after the last
  // `ResizeObserver` tick, etc.) -- exactly this item's complaint. This
  // constant does NOT touch `hexEdgePadding`/`boardContentBounds` itself
  // (design note #26 deliberately kept that a tight, non-padded fit, per an
  // earlier item's own "remove any large hardcoded pixel padding"
  // instruction) -- it just claims a bit more of that SAME existing budget
  // for the label specifically, pulling the label further in from the
  // exact edge without reintroducing extra camera padding around the board.
  // Aliased from the shared module-level constant (see its doc comment) for
  // the same reason as `BACKGROUND_PADDING_PX` above.
  const EXTRA_MARGIN_INSET_PX = MARGIN_LABEL_EXTRA_INSET_PX;
  // VERIFICATION PASS (this pass, item 2): uses the SAME `fontSize` value
  // `drawBoardMarginLabels` actually draws with (`Math.max(11, hexSize *
  // 0.3)`, floored at 11px), not a re-derived `hexSize * 0.3` missing that
  // floor -- at a small enough `hexSize` the floor dominates, and the
  // un-floored version would have understated the label's real rendered
  // (and therefore its real half-extent) size.
  //
  // Two independent half-extents now, one per axis (see the width-vs-height
  // comment above `rowLabelWidth`): the X half-extent (from row-letter
  // WIDTH) governs the left/right offset, and the Y half-extent (from
  // column-number HEIGHT) governs the top/bottom offset. Each is still
  // floored at `fontSize / 2` as a conservative minimum, matching the prior
  // behavior's floor.
  const maxLabelHalfExtentX = Math.max(rowLabelWidth, fontSize) / 2;
  const maxLabelHalfExtentY = Math.max(columnLabelHeight, fontSize) / 2;
  const labelSafetyOffsetX = Math.max(
    0,
    hexEdgePadding - (maxLabelHalfExtentX + BACKGROUND_PADDING_PX + EXTRA_MARGIN_INSET_PX),
  );
  const labelSafetyOffsetY = Math.max(
    0,
    hexEdgePadding - (maxLabelHalfExtentY + BACKGROUND_PADDING_PX + EXTRA_MARGIN_INSET_PX),
  );
  const leftX = boardMinX - labelSafetyOffsetX;
  const rightX = boardMaxX + labelSafetyOffsetX;
  const topY = boardMinY - labelSafetyOffsetY;
  const bottomY = boardMaxY + labelSafetyOffsetY;

  const rows = Array.from(rowY.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([r, y]) => ({
      letter: rowLetterForR(r),
      y,
      leftX,
      rightX,
    }));
  const columns = Array.from(colX.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([columnNumber, x]) => ({
      columnNumber,
      x,
      topY,
      bottomY,
    }));

  return { rows, columns };
}

/** Row-letter (A-K) / column-number (1-24) board margin labels -- drawn
 *  NATIVELY inside the canvas via `ctx.fillText` (design note #25; corrects
 *  design note #20's DOM-overlay detour). Called from `draw()` INSIDE that
 *  function's own `ctx.translate(view.panX, view.panY)` /
 *  `ctx.scale(view.zoom, view.zoom)` world-space transform (the exact same
 *  transform every hex/track/other label in this file already draws
 *  through) -- so these labels automatically pan, zoom, scale, and stay
 *  aligned with their corresponding hex rows/columns in real time, using
 *  the live `view` (not a locked baseline), simply because they're drawn
 *  through the same pixel math as everything else on the board. No separate
 *  screen-space projection, DOM position, or "tracking" computation of any
 *  kind is needed -- alignment falls out of using one shared coordinate
 *  transform for the whole canvas. Drawn LAST in `draw()`'s world-space
 *  pass (matching design note #16's original ordering), through the same
 *  safe-contrast `drawLabelWithBackground` convention as every other label
 *  in this file. */
export function drawBoardMarginLabels(ctx: CanvasRenderingContext2D, hexSize: number): void {
  // Shared with `marginLabelReserve` (see its doc comment) so the camera's
  // reserved padding and the font actually drawn here can never drift out
  // of sync.
  const fontSize = marginLabelFontSize(hexSize);
  // Set BEFORE calling `computeBoardMarginLabels` (design note #28/item 2):
  // it measures label widths via `ctx.measureText`, which needs this exact
  // font already applied to `ctx` to return an accurate size.
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Design note #30/item 2: was `#1a2e1f`, a dark green chosen back when
  // this text always sat on `drawLabelWithBackground`'s own translucent
  // WHITE box (`rgba(255, 255, 255, 0.72)`) -- against that light box, a
  // dark ink color was the correct, legible choice. These labels sit
  // outside the board's hex footprint, over this component's own solid
  // dark-charcoal workspace fill (`#141414`, design note #18); now that the
  // box is removed below (`background: false`) so the letters/numbers float
  // directly on that charcoal, `#1a2e1f`-on-`#141414` would be almost
  // unreadable (dark-on-near-black, no contrast at all) -- the exact
  // opposite of legible. Switched to a bright off-white so the labels stay
  // clearly readable with nothing behind them, matching the light-on-dark
  // convention this file already uses elsewhere for text over dark fills
  // (e.g. the off-board nameplate's `#ffe0e0`).
  ctx.fillStyle = "#f0f0f0";

  const { rows, columns } = computeBoardMarginLabels(ctx, hexSize, fontSize);

  // Design note #30/item 2 ("Transparent Coordinate Margin Fills"):
  // `background: false` skips `drawLabelWithBackground`'s rounded-rect
  // contrast box entirely -- these are the ONLY labels in this file drawn
  // that way; every other label (city/landmark names, cost labels,
  // off-board nameplates, era-tier cards) keeps its box per design note
  // #6c, since those sit over varied/busy hex fills and track strokes where
  // a contrast box still earns its keep. The margin band sits over one
  // uniform solid color (the charcoal workspace fill), so a background box
  // there was only ever adding an "ugly block outline frame" with no
  // legibility benefit -- the brightened text color above supplies the
  // needed contrast on its own.
  // Rail Map Overhaul (design note #42): these labels have no background
  // box at all (`background: false`, above) -- `strokeHalo: true` gives them
  // their own dark outline instead, so they stay crisp at any zoom level
  // over whatever happens to sit behind them (charcoal workspace fill, or a
  // hex fill/track once panned close to the board edge).
  for (const row of rows) {
    drawLabelWithBackground(ctx, row.letter, { x: row.leftX, y: row.y }, { background: false, strokeHalo: true });
    drawLabelWithBackground(ctx, row.letter, { x: row.rightX, y: row.y }, { background: false, strokeHalo: true });
  }
  for (const column of columns) {
    const label = String(column.columnNumber);
    drawLabelWithBackground(ctx, label, { x: column.x, y: column.topY }, { background: false, strokeHalo: true });
    drawLabelWithBackground(ctx, label, { x: column.x, y: column.bottomY }, { background: false, strokeHalo: true });
  }
}
