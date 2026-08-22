// frontend/src/components/hexCanvasPrimitives.ts
//
// PHASE 4 of the HexGridRenderer monolith split: every function that PAINTS.
// The boundary is mechanical -- with two noted exceptions everything here takes
// a CanvasRenderingContext2D and returns nothing, and nothing knows what React
// is. Verified mechanically before extraction: zero hook or React references.
//
// The two non-ctx exceptions are deliberate: stationMarkerPoint and
// twoCityStationPoints exist to keep a token and the circle it sits on in
// lockstep, and DOUBLE_TOWN_ROUTES is artwork data with one consumer.
//
// IMPORT DIRECTION IS ONE-WAY: never import from HexGridRenderer.tsx.
// See docs/ai_architecture/hex_tile_math.md

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
  STATION_RADIUS_RATIO,
  markerSizeFor,
  stationTokenRadius,
  tileCityTokenRadius,
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
  /* trainIndex is the join key the map, the planner rows and the train chips all share -- one number in App.tsx, no id scheme, nothing that can drift. emphasis is computed by the CALLER, since callers with no cursor exist.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #373 */
  trainIndex?: number;
  emphasis?: RouteEmphasis;
}

export type RouteEmphasis = "normal" | "primary" | "muted";

export const EMPTY_ROUTE_OVERLAYS: readonly RouteOverlay[] = [];

/* TrackTraceStyle/applyTrace DELETED: the glow now strokes the very same Path2D objects the renderers stroke, so the guarantee is structural rather than mechanical. What trace mode could not express is WHICH rail.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #226 */



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

/** Runs draw with the canvas clipped to this hex's own polygon, so a curve's control point cannot bleed past the border. save/clip/restore scopes it to one call.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #42 */
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

/** The inward face-normal of an edge -- edgeAngleRad gives the outward direction, so this is that plus 180 degrees. Used to make a track spline cross its edge perpendicular.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #42 */
export function edgeInwardNormal(edgeIndex: number): { x: number; y: number } {
  const angle = edgeAngleRad(edgeIndex) + Math.PI;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/** A cubic Bezier's tangent at an endpoint points at its adjacent control point, so projecting each control point along its edge's inward normal guarantees a true 90-degree crossing. A hex-centre node has no single face, so it falls back to the chord.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #42 */
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

/** Strokes only SOME of a hex's six borders, each its own 2-point subpath -- unlike drawHexPath's single closed all-or-nothing path -- so a caller can omit one shared seam.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #26 */
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

/** Recoloured to crisp #E53E3E and clamped to a literal 3-4px; the old unclamped max(5, size*0.16) read wider than an ordinary bar at most hex sizes and had no upper bound.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #42 */
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

/** twoCityStationPoints is shared by the track curve and the circle placement, so a laid tile's track and circles cannot drift. NewYorkHub merged into the DoubleCityHub branch -- its own stale side-by-side formula predated the layout engine.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #56 */
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
  /** The dit sits at a parameter along its OWN drawn track. A flat midpoint rule is exactly wrong on these tiles: the middle of a track is where the OTHER track crosses it.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #123 */
  ditAt: number;
}

/** The five real double-town tiles, drawn EXPLICITLY: there will never be a sixth, so a table beats an algorithm -- it reads as "this is what #55 looks like" and each entry can be checked against a photograph.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #121 */
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

// Drift tripwire: DOUBLE_TOWN_ROUTES restates edge pairs TILE_CATALOG already holds, so if the backend re-sources a pairing the artwork must move with it. Dev-only, never throws.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #121
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

/** Opposite edges take a literal lineTo -- not a Bezier that happens to look straight -- so #55's X cannot bow by a pixel. Everything else takes ONE cubic at the file's standard 0.3 reach, with no per-shape fudging.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #121 */
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

/** Disjoint paths mean independent runs; a shared list means "everything meets in the middle", which is the fan. Read off the catalog rather than guessed.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #122 */
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

/* drawTileMarkers DELETED: it placed a marker by TERRAIN alone, which is the marker half of the same guess -- terrain says what KIND of centre a tile carries and cannot say WHERE the cardboard prints it.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #209 */

/* drawRevenueBadge deleted from here -- the picker's bespoke white disc clashed with the board's shape-coded art. Both surfaces now go through one extracted implementation.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #126 */


/* ------------------------------------------------------------------ */
/* Design note #131: HARDCODED ARTWORK INTERCEPT                       */
/* ------------------------------------------------------------------ */

/** THE "ART, NOT MATH" BOUNDARY. Below the return true is literal Path2D playback: no control point computed, no offset derived. Orientation is a rigid rotation about the centre. Track strokes BEFORE markers, and markers draw outside the scaled transform -- a scaled circle would take its stroke width from the transform.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #131 */
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

  /* Markers, in board pixels, at their own explicit per-tile coordinates.
     Design note #699: the shared `markerSizeFor`, not a restated literal. This copy read
     `art.markers.length > 1`, which shrank two ONE-SLOT cities for keeping each other company -- and the
     token pass read its own copy of the same wrong rule, which is how NNH lost 39% of its radius on an
     upgrade that shared nothing. */
  const markerSize = markerSizeFor(art.markers, size);
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
      // The tile's rotation is folded into the pill axis HERE, because the marker pass runs in unrotated board pixels -- so the pill turns with the track it sits on.
      // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #133
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
  /** Default true so every isolated rendering carries its value; the BOARD loop passes false, because drawValueBadge's placement-aware pass already owns that hex and two numbers would be stamped on one hex.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #124 */
  showRevenue = true,
  /** The chain's own revenue when the caller has a laid tile; undefined for a tray thumbnail falls back to the terrain bucket -- the one place that fallback is still correct.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #132 */
  revenueOverride?: number,
  /** Same gate and same reason as showRevenue: on the board a restricted tile can only sit on the hex carrying the matching badge, so a tile-level label is a duplicate one slot away.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #486 */
  showRestriction = true,
): void {
  // Hardcoded artwork wins unconditionally -- FIRST statement, so a catalogued tile cannot reach a procedural branch even by accident. #153: the tier decides the ink, resolved here because entry.color is in hand.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #131
  const trackInk = TILE_TRACK_INK[entry.color] ?? DEFAULT_TRACK_INK;

  if (drawHardcodedTileArtwork(ctx, center, size, entry.tileId, orientation, trackInk)) {
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride, showRestriction);
    return;
  }

  /* There is no procedural branch any more. Every deleted branch read the flat bitmask, which CANNOT record which pairs route together -- a limitation of the DATA. A fallback guaranteed wrong whenever it runs is not a safety net, it is a silent renderer of plausible fiction.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #209 */
  drawUnknownTilePlaceholder(ctx, center, size, entry.tileId);
  drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride, showRestriction);
}

/* ------------------------------------------------------------------ */
/* Traced route overlay -- design note #137 (F-1)                       */
/* ------------------------------------------------------------------ */

/** Each hop is two bezierTrackSegment halves through the shared edge midpoint, the same primitive with the same normals real track uses -- a straight centre-to-centre line would cut every corner. Non-adjacent pairs are SKIPPED: the visible gap is the honest rendering of an incomplete route.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #137 */

/* THE ROUTE STOPS AT THE CITY WALL. An authored rail runs through the middle of the city it serves, so a route through a city was by construction a line across whatever tokens sat in it. The fix is a HOLE, not a shortened line -- the marker's own outline becomes a clip exclusion. Towns are not masked: a dit holds no token.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #267 */
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
  /* With evenodd, a point inside a marker outline has crossing number 2 and falls outside the clip. The universe rect is deliberately absurd rather than measured.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #267 */
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

/* Flattened hit geometry is a BY-PRODUCT of the draw that already happened, built once per repaint. Returned in BOARD pixels. DOMMatrix is required and checked for; missing, the caller keeps hex-grained hover. The PEN is widened, not the search, so tolerance follows the bend.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #380 */
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
  /* Three attempts, each a reaction to the last overshooting: an opaque bar wider than the rail, a translucent halo that muddied it, then a solid line THINNER than the rail. #268: one third, and the shadow comes back -- a hairline of flat colour reads as an artefact, so TWO passes, glow then crisp core.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #268 */
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

    /* Emphasis as WIDTH and ALPHA, never colour -- the colour is the route's identity. The muted pass stays fully drawn: a route that vanishes while you hover its neighbour loses the comparison you were making.
       See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #373 */
    const emphasis: RouteEmphasis = overlay.emphasis ?? "normal";
    const widthScale = emphasis === "primary" ? 2.2 : 1;
    const alpha = emphasis === "muted" ? 0.32 : 1;

    /* Keyed on trainIndex, the join the whole cross-highlight runs on; an overlay without one cannot be hovered to any purpose.
       See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #380 */
    const hitPath =
      canFlatten && overlay.trainIndex !== undefined ? new Path2D() : null;
    if (hitPath && overlay.trainIndex !== undefined) {
      hitPaths.set(overlay.trainIndex, hitPath);
    }

    // Walk HEXES, not pairs: tracing a real rail needs BOTH of a hex's edges at once, and the old loop produced them in two different iterations.
    // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #226
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

      /* The glow is Path2D all the way down. Fallback B was a straight line BY ARITHMETIC -- both control points collinear with the edge-to-centre segment, so the cubic degenerates. #226 removed the last exception: an endpoint is not ambiguous, so artworkPathsForEdge answers it. Nothing matches, nothing is drawn.
         See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #216 */

      const laid = tilesAt?.(q, r);
      const printedLabel = printedLabelAt?.(q, r);

      /** Strokes authored paths under the transform their renderer uses --
       *  glow then core, design note #268. `rot` is 0 for preprinted
       *  artwork, which has one fixed facing. */
      const strokePaths = (paths: readonly Path2D[], rot: number) => {
        /* Hit geometry composed from the SAME three transforms in the same order as the stroke below, built here so the two cannot describe different curves. The city mask is NOT applied: a route still RUNS through the city it stops at.
           See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #380 */
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

        // shadowBlur is in board pixels and unaffected by scale, so it is set raw rather than divided out. A primary route's halo grows with it, which is what makes it read as lit.
        // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #268
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

/** The hit test lives WITH the draw: every line mirrors something drawRouteOverlays did, and the same pair 1,600 lines apart drifts invisibly. isPointInStroke is ASYMMETRIC -- the path takes the matrix, the point is read in device pixels -- and doing one without the other is worse than doing neither.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #381 */
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

/** Readable provisional artwork for an unknown id: a dashed outline and the number. Deliberately does NOT guess at track geometry -- a fabricated path is worse than an honest blank, since the player could not tell it from real artwork.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #118 */
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

/** A multi-slot city is a PILL, and that shape is load-bearing: it is the only thing on the tile saying a second company can still build in. Spacing is 1.6r, not tangent 2r -- real cardboard overlaps, and at 2r the pill on #63 reaches its own track arms.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #133 */
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

  // The slot rings make the pill COUNTABLE. Drawn at half the capsule's weight and never filled, so two 2-slot cities on #62 cannot be confused with one 4-slot city.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #133
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

/** A plain solid black dot, no stroke, no station-container styling: a town sits on the track as a mark, never a buildable hub. Radius settled at the same magnitude used before #59's rewrite.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #61 */
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

/** ALL SQUARE. A diamond needs radius halfWidth+halfHeight to clear a text corner because its boundary tapers on every side -- structurally larger than a square's, which no padding tuning fixes. diamond stays a valid option, unused.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #65 */
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

/** One uniform white fill with a navy stroke; the city/town distinction moves from COLOUR to SHAPE. The square's half-side is radius*SQRT1_2, so its farthest corner sits at exactly radius -- the same reach as the circle it replaces.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #62 */
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

/** Sizes the badge AROUND measured text instead of shrinking the font into a fixed radius. The diamond derivation is why #65 dropped it: its boundary |x|+|y|=r means the widest it gets at the text's own height is r - textHeight/2.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #63 */
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

// The four corner slots in preference order, both lower first since every name pass draws in the upper area. #76 appends the two FAR-side edges ahead of the neutral tail -- on a hex as crowded as G19 the neutral fallback handed back a slot angularly adjacent to the cluster it was avoiding.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #76
export const BADGE_SLOT_PREFERENCE: readonly number[] = [11, 9, 12, 8, 6, 5, 2, 3];

/** Four tiers: unblocked AND dead-edge-adjacent, then dead-edge-adjacent anyway, then simply unblocked, then the first candidate. A dead edge can NEVER carry track from either side, which is a permanently stronger guarantee than "not currently live".
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #39 */
export function drawValueBadge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  // Design note #39: this hex's own axial coordinates, needed to look up
  // `deadEdgesAt(q, r)` -- `center` alone (a pixel position) can't recover
  // these, and every existing call site already has them on hand (they're
  // how `center` itself was computed via `axialToPixel`).
  q: number,
  r: number,
  /* The two landmark hub terrains join the union: they were excluded because the landmark pass was meant to catch them first, and #133 later made that pass yield.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #288 */
  terrain: ValueBadgeTerrain,
  size: number,
  // An explicit override replaces the flat terrain default; terrain still drives the SHAPE, so an overridden badge keeps its square. Callers check for a $0 override BEFORE calling and skip entirely.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #35
  valueOverride?: number,
  // ADAPTIVE PLACEMENT: this hex's own live track edges, if the caller has
  // them on hand -- see `BADGE_CORNERS`'s doc comment. Omitted/empty means
  // "no track to dodge," which (absent a dead edge too) resolves to the
  // lower-left corner.
  liveEdges: readonly number[] = [],
  // The LAST of the four slot-picking passes, so on a crowded hex it is the one most likely to need its fallback tail -- without the ledger it picked the exact corner the cost label had already claimed.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #72
  claimedHexSlots: Map<string, Set<number>> = new Map(),
): void {
  const value = valueOverride ?? terrainBaseValue(terrain);
  // The same four-tier dead/live-edge search, now via the shared engine: slotsBlockedByEdges marks a corner blocked when either guard edge carries live track, derived generically rather than hand-encoded.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #70
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
  // 0.44 -> 0.38 -> 0.55 -> 0.65. HONEST MARGIN CHECK: at a corner slot 0.19 of clearance remains past the worst-case badge radius; at an EDGE slot only 0.056 -- noticeably tighter, flagged rather than silently accepted.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #109
  const REVENUE_BADGE_OFFSET = 0.65;
  const badgeCenter = {
    x: center.x + direction.x * size * REVENUE_BADGE_OFFSET,
    y: center.y + direction.y * size * REVENUE_BADGE_OFFSET,
  };

  // Bold font fixed first, shape sized to the measured text; padding tightened to the file's 2px convention and the floor dropped to a flat safety minimum, which was silently dominating for every 2-digit value. The $ prefix is dropped -- the white square already reads as revenue.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #66
  drawValueBadgeAt(ctx, badgeCenter, size, terrain, value);
}

/** THE revenue badge artwork, extracted VERBATIM so the board and the picker cannot render a value differently. What stayed behind is PLACEMENT, not art: the caller decides WHERE, this decides WHAT.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #126 */
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

/** The per-tile overlay pass, in one place so all exits get identical treatment. #486: the tile-level restriction label is gated exactly like showRevenue -- on the board a tile and its hex CANNOT differ, because 1830 only permits an OO tile on an OO hex.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #486 */
export function drawTileOverlays(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  entry: TileCatalogEntry,
  showRevenue: boolean,
  /** When present the chain's revenue REPLACES the terrain bucket outright, INCLUDING when it is 0 -- a real answer meaning the tile earns nothing. Only undefined falls back.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #132 */
  revenueOverride?: number,
  /** Design note #486: draw the tile's own "B"/"NY"/"OO" label. `false` from
   *  the main BOARD loop and its ghost preview, where `drawRestrictionBadge`
   *  already labels the hex; `true` everywhere else. */
  showRestriction = true,
): void {
  if (showRevenue) {
    const badgeTerrain = valueBadgeTerrainFor(entry.terrain);
    // The precedence chain: chain revenue, then the catalog mirror, then the flat terrain bucket. ?? throughout, deliberately NOT || -- a revenue of 0 is legitimate at every level and must beat the level below.
    // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #135
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
    // The same offset distance the board uses, pointed due north. A tray thumbnail has no neighbours or dead edges to dodge, so it takes a fixed slot -- but distance, font and styling all come from the shared renderer.
    // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #129
    const badgeCenter = { x: center.x, y: center.y - size * 0.65 };
    drawRestrictionBadgeAt(ctx, badgeCenter, size, label);
  }
}

/** BostonHub and NewYorkHub borrow the single/double-city buckets archetypeForTerrain already assigns rather than inventing two more shapes for the same kind of revenue centre.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #126 */
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

/** Derived from terrain rather than stored as a catalog column, because here the two are the same fact -- a label column would be a second copy free to drift. #57/#63/#45 carry NO label; labelling them would say something untrue about where they may be laid.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #127 */
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

/* drawTileRestrictionLabel deleted -- the picker's bespoke white pill did not match the board, which draws these as plain bold black on nothing.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #129 */


// A FIXED corner rather than an adaptive search: the restricted hexes' printed track is known, so one predictable place beats a per-hex answer. Placed further out than the revenue badge's mid-radius zone, since both can resolve to upper-left. #69 removed the shield box; #105 unified both archetypes' preference and let them reach edge slots.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #105
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
  // The shared claiming ledger, so this badge avoids whatever the icon, cost-label and revenue passes already claimed on this hex.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #72
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
  // No longer restricted to CORNER_SLOTS: this badge can now genuinely land on an edge midpoint, so its fallback tail needs the full pool.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #105
  const slot = claimHexSlotPreferring(claimedHexSlots, q, r, restrictionOverride, preference, blocked, dead);
  // Generalised from the corner-only formula to hexSlotDirection, which resolves either. Offset is a flat size*0.65 -- the same magnitude, measured the same way, as the revenue and compound badges, so badges on the same slot land at the identical radius.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #125
  const RESTRICTION_BADGE_OFFSET = 0.65;
  const direction = hexSlotDirection(slot);
  const badgeCenter = {
    x: center.x + direction.x * size * RESTRICTION_BADGE_OFFSET,
    y: center.y + direction.y * size * RESTRICTION_BADGE_OFFSET,
  };

  // Base font dropped 2pt and switched to bold; the fitFontSize floor stays put, the same convention this file's other badges use for a plain point drop.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #124
  drawRestrictionBadgeAt(ctx, badgeCenter, size, text);
}

/** THE restriction-label artwork, extracted VERBATIM for the same reason drawValueBadgeAt was: two labels in one window styled as different objects. Placement stays behind -- it needs mapGrid and (q,r), which a tray thumbnail cannot supply.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #129 */
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

/* Deliberately NOT a restriction badge: those are printed on the cardboard, permanent properties of the hex.
   This is temporary game state, so it is drawn in its own key. The mark is DRAWN, not typed: an emoji is a
   colour glyph, a hollow outline or a tofu box depending on the platform. #364 removed the pill, which was the
   visual vocabulary of a button and set the oversized footprint.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #364

   Design note #714: A STAR, NOT A PADLOCK -- THE HEXES ARE NOT LOCKED.

   REPORTED: "We placed locks on the DH (F16) and CSL (B20) hexes, but these hexes are actually not locked by
   the private companies: any corporation can build on those hexes following the usual rules, it's only that
   the owning corporations of DH or CSL get their special power."

   THE GLYPH STATED THE OPPOSITE OF THE RULE. Both privates grant their owner a BONUS on their hex -- a free
   tile lay, and for the D&H a free lay plus a station -- and neither stops anybody else building there under
   the ordinary rules. A padlock is the one symbol that cannot mean "you get something extra here".

   AND THE MODULE'S OWN NOTE BELIEVED IT: `privateReservations.ts` #0 justifies the badge because otherwise
   "a player discovers the block by having a placement refused". There is no block to discover. The badge is
   still worth having for the reason that note gives one clause earlier -- the power is stated in three places
   and none of them is on screen while a president chooses where to lay track -- but it is an OPPORTUNITY the
   owner should not miss, not a wall everyone else should avoid.

   THE STAR IS FIVE-POINTED AND FILLED, at the same weight the padlock was: this is a swap of meaning, not of
   prominence, and the mark's size and slot were settled by #364 against a real overflow bug. */
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

  const markW = fontPx * 0.62;
  const gap = fontPx * 0.28;
  const textW = ctx.measureText(initials).width;
  // Centred on the point the caller gave us, so a slot direction puts the
  // whole mark where it was aimed rather than its left edge.
  const startX = badgeCenter.x - (markW + gap + textW) / 2;

  /* No plate. A dark halo under both the glyph and the text is what keeps
     them readable over yellow track, green cardboard or a red off-board --
     the same trick the nameplate pass uses, and it costs no footprint. */
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.shadowBlur = Math.max(2, 3 * scale);

  /* Design note #714: the five-pointed star, plotted rather than typed for the reason above. Ten vertices
     alternating between an outer and an inner radius -- the standard construction, starting at the top so the
     point sits upright at every scale. */
  const outer = markW * 0.5;
  const inner = outer * 0.42;
  const cx = startX + markW / 2;
  const cy = badgeCenter.y + fontPx * 0.05;
  ctx.fillStyle = "#f0d074";
  ctx.beginPath();
  for (let point = 0; point < 10; point += 1) {
    const radius = point % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (point * Math.PI) / 5;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    if (point === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#f7ead0";
  ctx.fillText(initials, startX + markW + gap, badgeCenter.y + fontPx * 0.05);
  ctx.restore();
}

/** slot is REQUIRED and comes from the caller: these two badges have fixed homes chosen so neither can reach a neighbour, and a negotiated slot is what let the first version wander.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #364 */
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

/** Boston and Baltimore are ordinary preprinted hexes; NEW YORK is the one exception on the board, printing TWO independent stations that a singular marker field cannot express. The stub endpoints are the ARTWORK's, so the station is on its own rail by construction rather than by coincidence.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #211 */
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

  // Design note #699: third statement of the shrink, this one a bare literal. G19's two printed cities are
  // both one-slot, so under the corrected rule they draw at full size -- and NNH's token no longer changes
  // size when the green tile lands on top of them.
  const printedMarkerSize = markerSizeFor(NEW_YORK_PRINTED_ARTWORK.markers, size);
  for (const marker of NEW_YORK_PRINTED_ARTWORK.markers) {
    drawStationCircle(
      ctx,
      { x: center.x + size * marker.at.x, y: center.y + size * marker.at.y },
      printedMarkerSize,
    );
  }
  return true;
}

/** Off-board stubs take STANDARD_TRACK_INK, not the historic default -- the seam between the two fell exactly on the edge a player traces a route across. THE ARROWHEAD IS THE CANONICAL ART: a blunt cap looks like track that was cut off. Drawn as a filled triangle on a shortened stub, not a stroke trick.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #473 */
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

/* Preprinted track is DRAWN, not derived. The old construction degenerated: both control points sat on the straight edge-to-centre line, so Cleveland's 60-degree pair rendered as a hard V. A gray hex and a laid tile connecting the same edges now draw the SAME shape.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #211 */
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

/** Two independent station circles and NO connecting line -- the real source has no path entry for these four hexes at all, which is their signature feature.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #58 */
export function drawOOCityMarkers(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
): void {
  const [node0, node1] = twoNodePositions(center, size);
  /* Design note #699: FULL SIZE, was `size * 0.75` -- a fourth figure for the shrink, and the one furthest
     from any geometry: these two nodes sit 1.0 hex apart, WIDER than the 0.866 of tile #54, and were drawn
     smaller. It also left the token bigger than its own circle here, since the fallback radius was a flat
     `size * 0.22` against a circle drawn at 0.165. Both circles now match every other unshared city. */
  drawStationCircle(ctx, node0, size); // index 0: top-right
  drawStationCircle(ctx, node1, size); // index 1: bottom-left
}

/** The radius a token drawn by `stationMarkerPoint`'s fallback should take.
 *
 *  Design note #699: THE POINT AND THE RADIUS ARE ONE QUESTION. Its sibling above resolves WHERE a token goes
 *  on a hex the tile catalog cannot describe; every branch it walks also determines how big the circle it is
 *  landing in was drawn. Answering only the first half is what left B&O's home token painting over the printed
 *  circle underneath it while its second token sat neatly inside one. Branch for branch, in the same order. */
export function stationMarkerRadius(
  q: number,
  r: number,
  size: number,
  laidTile?: MapTileEntry,
  cityIndex?: number,
): number | undefined {
  if (laidTile) {
    const radius = tileCityTokenRadius(laidTile.tile_id, size, cityIndex ?? 0);
    if (radius !== undefined) return radius;
  }

  const hex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  // The preprinted OO pair: two one-slot circles at the full marker size, as drawn just above.
  if (hex && YELLOW_OO_HEXES.has(hex.label)) return size * STATION_RADIUS_RATIO;

  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  const label = hex?.label ?? landmark?.label;
  if (label === undefined) return undefined;

  // `printedMarkersFor` already folds New York's exception in, so this needs no G19 branch of its own.
  return stationTokenRadius(printedMarkersFor(label), cityIndex ?? 0, size);
}

/* ASK THE MARKER where the home slot is, rather than adding a second table of home city indices -- this codebase's recurring bug is exactly one fact in two places. NEAREST rather than an index handed across: the two functions compute in the same space by different routes.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #584 */
export function homeCityIndexAt(
  nodes: ReadonlyArray<{ x: number; y: number }>,
  markerPoint: { x: number; y: number },
): number | null {
  if (nodes.length === 0) return null;
  let best = 0;
  let bestDistance = Infinity;
  nodes.forEach((node, index) => {
    const distance = Math.hypot(node.x - markerPoint.x, node.y - markerPoint.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Node 0 = Top-Right/NE = centre + offset; Node 1 = Bottom-Left/SW = centre - offset, universally. #55 removed the last hex-name literal by asking whether a landmark's OWN track data has two stub segments; #56 fixed an index inversion that put New York's home token on the wrong circle.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #56 */
export function stationMarkerPoint(
  q: number,
  r: number,
  size: number,
  /** The laid tile is REQUIRED for correctness on a two-city hex: the fixed diagonal knows nothing about the tile's track, and for #62 both cities sit in the upper half, nowhere near the SW node.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #131 */
  laidTile?: MapTileEntry,
  /* Which of the two preprinted circles, when the chain has said. undefined KEEPS the old bottom-left behaviour deliberately -- changing it would move existing tokens on boards this cannot ask about.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #459 */
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
    /* Both circles come from the same twoNodePositions tuple drawOOCityMarkers draws from, so a token cannot land where the board has not drawn a station.
       See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #58 */
    const nodes = twoNodePositions(center, size);
    return cityIndex === undefined ? nodes[1] : (nodes[cityIndex] ?? nodes[1]);
  }

  /* THE PREPRINTED STATION MOVED; THE TOKEN DID NOT. Once these hexes render from authored artwork each city sits where the cardboard prints it, and this went on returning centre -- so every token landed on empty fill beside its own circle, reservation markers included.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #221 */
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

/** Sized to match drawStationCircle's radius exactly, drawn on top of whichever circle is already there. muted swaps the fill so "reserved" reads unmistakably differently from a live token. The empty-ticker guard is defensive only -- every real call site guarantees one.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #46 */
export function drawStationTokenMarker(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
  ticker: string,
  color: string,
  muted: boolean,
  /** The DOCKING radius for a token placed into a laid tile's slot. Optional rather than required, so no caller with nothing to measure is forced to invent a figure.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #151 */
  radiusOverride?: number,
): void {
  const radius = radiusOverride ?? size * 0.22;

  // Reserved badges REVERSED from solid navy to neutral gray AND reduced alpha -- "grayed out or transparent" read as combine both, since gray alone can still look like a present token. The ring keeps previewing the brand colour, just faded with everything else.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #116
  const badgeFill = muted ? "#9CA3AF" : color;
  const MUTED_ALPHA = 0.45;

  ctx.save();
  if (muted) ctx.globalAlpha = MUTED_ALPHA;

  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = badgeFill;
  ctx.fill();

  // The unfloated ring is the corporation's own brand colour at a fixed 1.75px, deliberately NOT size-scaled: a constant thin ring reads clean at every zoom where a scaled one balloons.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #48
  ctx.strokeStyle = muted ? color : STATION_TOKEN_RING;
  /* Scaled off the TOKEN's radius, not the hex's size -- one absolute width for three different radii made a docked token wear a collar half again as heavy. The floor drops 2 -> 1 and has to: a 2px floor is the same bug in miniature.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #487 */
  ctx.lineWidth = muted ? 1.75 : Math.max(1, radius * STATION_TOKEN_RING_WIDTH_RATIO);
  ctx.stroke();

  if (!ticker) {
    ctx.restore();
    return;
  }

  // A DISC IS NOT A BOX. Text in a circle gets the chord at the top of the letterforms, 2*sqrt(r^2-(h/2)^2), not the diameter -- about 15.5px against the 15.7px the old flat ratio handed out, over by a hair on every three-letter ticker. It ITERATES, because available width depends on glyph height depends on font size. #513's longTicker special case is gone with it.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #564
  ctx.font = fitTokenFontSize(ctx, ticker, radius, ctx.lineWidth);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Whichever of pure white/black actually contrasts better against THIS fill, computed per badge rather than asserted once -- see the honest caveat that several brand colours cannot reach AAA against either.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #46
  const textColor = bestContrastTextColor(badgeFill);
  const haloColor = textColor === "#FFFFFF" ? "#000000" : "#FFFFFF";

  // Thinned from #45's lineWidth 2, which choked tight letterform counters at this radius, and recoloured to the OPPOSITE of the text so a black halo behind black text does not do nothing.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #46
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

/** Two overlapping triangles read as a range rather than one less legible peak. colorOverride renders it flat white for the compound badge's red plate, where the usual brown two-tone would be low-contrast.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #87 */
export function drawMountainIcon(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  colorOverride?: string,
): void {
  // iconSize bumped 0.7 -> 0.875 (+25%) -> 1.1375 (+30%); every other dimension derives from it, so one change scales the whole icon uniformly.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #102
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

/** Seven passes: one curve -> two thin strands -> a tilde wave -> a third crest -> three strands -> back to two, spaced wider. "A third wave" turned out to mean a third parallel STRAND, not a third crest -- #90 and #96 both approached the wrong problem.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #100 */
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
  // Amplitude bumped because each crest's visual excursion is only HALF its control-point amplitude (a quadratic Bezier's midpoint value), so five tight segments blurred into the old two-crest shape. This grows the bounding height, so the ratio table is updated to match.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #95
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

/** Back to the original 5-segment shape: the segment-count chase was answering the wrong report. Assumes the caller has set stroke style; shared by BOTH render paths, so one change reaches the standalone icon and the compound badge.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #98 */
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

/** Exact width/height-to-size ratios, derived from each function's own geometry (both scale linearly, so one ratio suffices) -- lets the compound badge size its icon to an EXACT target width while knowing the height that produces.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #89 */
export const TERRAIN_ICON_SIZE_RATIO: Readonly<Record<"Mountain" | "River", { width: number; height: number }>> = {
  River: { width: 0.952, height: 0.308 },
  Mountain: { width: 0.7905625, height: 0.47775 },
};

// ONE compound [icon+cost] unit replacing the standalone icon plus separate cost box. #88: the icon perches ABOVE the box in its own colour rather than sitting inside it. #89: sized to match the box's width exactly. #121 scales the INPUTS by 35%, letting the existing math do the rest.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #89
export const COMPOUND_BADGE_SHRINK = 0.65;

export function drawTerrainCompoundBadge(
  ctx: CanvasRenderingContext2D,
  terrainType: "Mountain" | "River",
  costLabel: string,
  anchor: { x: number; y: number },
  maxWidthPx: number,
): void {
  // Font history 9 -> 8 -> 9 -> 10, then base and floor both scaled by the compound shrink.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #121
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

  // #91's tightened padding was REVERTED; the font drop stays as the sizing fix instead. Both then scaled by the compound shrink.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #97
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
  // Gap widened 1.5 -> 3 (the pieces read as touching), then scaled by the shrink so it stays proportional rather than reading relatively wider.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #121
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

/** A dark translucent strokeText halo painted before the fill, so a label reads crisply over a busy hex fill where a contrast box is not wanted. Round lineJoin keeps it from spiking at sharp glyph corners.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #42 */
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

/** fillRoundedRect extracted behaviour-identically from drawLabelWithBackground so drawStackedNameLabel can paint ONE shared box across two lines without duplicating the path building.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #84 */
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

/** Paints a translucent rounded rect sized to the MEASURED text before drawing it -- fitFontSize alone does not stop a legibly-sized label colliding with a track stroke. strokeHalo is belt-and-suspenders, or the only aid for the one caller drawing with no box at all.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #6 */
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
    /** cornerRadiusPx overrides the default rounding; every existing caller omits it, and the nameplate shield passes 1 for a genuinely rectangular box.
     *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #51 */
    cornerRadiusPx?: number;
  },
): void {
  const paddingX = options?.paddingX ?? 4;
  const paddingY = options?.paddingY ?? 2;

  // background:false skips the contrast box entirely, for the one caller whose labels sit over a single uniform fill where a box was never earning its keep.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #33
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


/* Solves for a size that FITS rather than returning an unmeasured floor. The ring is inside the budget too -- stroked ON the circle, so half eats into the interior, and it is the corporation's own colour, which is why the symptom reads as blending as often as clipping.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #564 */
export function tokenTextChordWidth(
  radius: number,
  ringWidth: number,
  fontPx: number,
): number {
  /* Cap height, near enough, for a bold sans at this size -- the letters are
     all capitals, so the ascender is the whole story and the descender never
     appears. Half of it is the offset from the centre line at which the
     chord has to be measured. */
  const halfTextHeight = fontPx * 0.72 * 0.5;
  // The ring is stroked ON the circle, so half of it is interior.
  const inner = radius - ringWidth / 2;
  if (inner <= halfTextHeight) return 0;
  const chord = 2 * Math.sqrt(inner * inner - halfTextHeight * halfTextHeight);
  /* A hair of air, so a glyph's side bearing does not sit flush against the
     ring. Proportional rather than absolute -- an absolute pad is the same
     class of mistake as an absolute width. */
  return chord * 0.92;
}

/** The largest font size at which `text` fits inside a token disc, walking
 *  down from `maxPx`. Returns `minPx` when nothing fits, same contract as
 *  `fitFontSize` -- but every size above it has been measured against the
 *  chord for THAT size rather than against one fixed width. */
export function fitTokenFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  radius: number,
  ringWidth: number,
  maxPx = 11,
  minPx = 6,
): string {
  for (let fontPx = maxPx; fontPx >= minPx; fontPx -= 1) {
    const candidate = `bold ${fontPx}px ${FONT_FAMILY_STACK}`;
    ctx.font = candidate;
    if (ctx.measureText(text).width <= tokenTextChordWidth(radius, ringWidth, fontPx)) {
      return candidate;
    }
  }
  return `bold ${minPx}px ${FONT_FAMILY_STACK}`;
}

/** Shrinks in 1px steps until measureText confirms it fits. The explicit system-sans stack is applied HERE for all eight call sites at once -- safe precisely because a family swap, unlike a size floor, carries no per-caller layout risk.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #46 */
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

// Shared by every name-label call site so all read identically. History: strip everything (#50) -> box back for track occlusion (#51) -> stripped again once real sparse bitmasks landed (#53) -> back tier-matched (#54) -> one flat translucent white, opaque on hover (#78). Font 10/8 -> 11/9 -> 7/5 -> 8/6.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #78
export const NAMEPLATE_FONT_SIZE_PX = 8;
export const NAMEPLATE_FONT_MIN_PX = 6;
/** lineHeight = 1.05 * fontSize, derived from the FONT rather than hexSize -- so stacked lines stay a constant distance apart on screen at every zoom instead of drifting wider as the board zooms in.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #51 */
export const NAMEPLATE_LINE_HEIGHT_PX = NAMEPLATE_FONT_SIZE_PX * 1.05;
/** The tier-matched fills are left DEFINED but unwired, per this file's convention of keeping a superseded constant as a documented record. #78 replaced them with one flat white; #82 dropped it to 0.55 alpha, hover still opaque.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #82 */
export const NAMEPLATE_SHIELD_FILL = "rgba(255, 255, 255, 0.55)";
export const NAMEPLATE_SHIELD_FILL_HOVERED = "rgba(255, 255, 255, 1.0)";

/** Resolves the tier-matched fill from a laid tile's REAL colour or the hex's printed category. Kept fully wired -- a real lookup, not a stub -- so the Green branch is complete rather than an unreachable gap, even though nameplate suppression means no call site reaches it today.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #54 */
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
  // Flat semi-transparent white at rest, fully opaque on hover; the tight rectangular box shape is unchanged.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #78
  ctx.fillStyle = "#000000";
  drawLabelWithBackground(ctx, text, point, {
    paddingX: 2,
    paddingY: 2,
    fillStyle: isHovered ? NAMEPLATE_SHIELD_FILL_HOVERED : NAMEPLATE_SHIELD_FILL,
    cornerRadiusPx: 2,
  });
  ctx.restore();
}

/** ONE shared shield spanning both lines: two 0.55-alpha boxes stacked with only a line-height between their centres composited into a visibly darker seam. Both lines also take one shared font size, so a length mismatch cannot produce a size mismatch.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #84 */
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

/** A single-node nameplate NEVER wraps -- none of these names carries an ampersand and none is the one named exception. Kept as a thin named wrapper so a future exception has one obvious place to go.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #83 */
export function drawSingleNodeNameplate(
  ctx: CanvasRenderingContext2D,
  name: string,
  anchor: { x: number; y: number },
  maxLineWidthPx: number,
  isHovered: boolean,
): void {
  drawHexNameLabel(ctx, name, anchor, maxLineWidthPx, isHovered);
}

/** The board-wide wrap rule: two cities joined by an ampersand, plus "Maritime Provinces". Reverses #79's and #47's "any multi-word name wraps" defaults.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #83 */
export function offboardNameplateLines(offboardName: string): readonly string[] {
  if (offboardName === "Maritime Provinces") {
    const spaceIndex = offboardName.indexOf(" ");
    return [offboardName.slice(0, spaceIndex), offboardName.slice(spaceIndex + 1)];
  }
  return [offboardName];
}

/** Drawn in the SAME world-space transform as everything else, so it pans and zooms with the board rather than needing a second screen-space overlay. ADAPTIVE QUADRANT flips toward whichever side points back at the board's interior -- deliberately not a blanket flip, which would move the clipping to the other edge.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #15 */
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

/** Row letters A-K, the direct inverse of the row half of the coordinate transform.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #6 */
export function rowLetterForR(r: number): string {
  return String.fromCharCode(65 + r);
}

/** Re-derived purely from axialToPixel rather than a hand-expanded formula, so it cannot drift from the coordinate convention. Both axes are computed again (#24 dropped one while labels were a DOM overlay). Margins are STRAIGHTENED to one shared line per side -- the board's ragged ends would otherwise staircase the gutter.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #25 */
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

  // Measures the actual widest label with the exact font the drawing pass sets -- a real rendered size, not a guessed constant. Must match boardContentBounds' own padding total, or labels land outside the visible boundary or overlap the outermost hex.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #28
  const hexEdgePadding = hexSize + marginLabelReserve(hexSize);
  const rowLetterStrings = Array.from(rowY.keys()).map(rowLetterForR);
  const columnNumberStrings = Array.from(colX.keys()).map(String);
  // Width and height are NOT interchangeable: row letters sit left/right so their WIDTH governs clearance, column numbers sit above/below so their HEIGHT does. Measuring width for both understated the column numbers.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #28
  const rowLabelWidth = rowLetterStrings.reduce(
    (max, label) => Math.max(max, ctx.measureText(label).width),
    0,
  );
  const columnLabelMetrics = columnNumberStrings.map((label) => ctx.measureText(label));
  // actualBoundingBoxAscent/Descent give the real vertical extent relative to a middle baseline; some backends do not populate them, so fall back to fontSize.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #28
  const columnLabelHeight = columnLabelMetrics.reduce((max, metrics) => {
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const height =
      Number.isFinite(ascent) && Number.isFinite(descent) ? ascent + descent : fontSize;
    return Math.max(max, height);
  }, 0);
  // Aliased from the shared module constant so it cannot drift from marginLabelReserve's own budget, which is built from the same value.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #28
  const BACKGROUND_PADDING_PX = MARGIN_LABEL_BACKGROUND_PADDING_PX;
  // An extra clearance budget on top of the background padding: 4 world units of slack is a handful of screen pixels at typical zoom, easily read as clipping. This claims more of the SAME existing budget rather than adding camera padding.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #36
  const EXTRA_MARGIN_INSET_PX = MARGIN_LABEL_EXTRA_INSET_PX;
  // Uses the ACTUAL floored fontSize the drawing pass sets, not a re-derived un-floored value -- at small hex sizes the floor dominates and the un-floored version understates the label's real size.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #31
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

/** Drawn NATIVELY inside draw()'s own world-space transform, so alignment falls out of using one shared coordinate transform -- no DOM position, no projection, no tracking computation of any kind.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #25 */
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
  // Was a dark green chosen for a translucent white box; against the charcoal workspace with the box removed that would be almost unreadable, the exact opposite of legible.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #33
  ctx.fillStyle = "#f0f0f0";

  const { rows, columns } = computeBoardMarginLabels(ctx, hexSize, fontSize);

  // The ONLY labels drawn with background:false -- every other label sits over busy hex art where a contrast box earns its keep. strokeHalo supplies the contrast instead.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #33
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
