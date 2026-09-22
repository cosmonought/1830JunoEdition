// frontend/src/components/routeSignalGeometry.ts
//
// ==================================================================
//  TRAIN ROUTE PULSE / REVENUE BADGE ANIMATION -- GEOMETRY ONLY
// ==================================================================
//
// Everything in this file is pure: no canvas context, no React, no game rules. It answers three questions a
// painter can then act on -- "where along this route is a given elapsed distance", "which of this route's
// hexes are the ones that actually pay", and "when several routes' revenue arrivals land on the same
// rendered badge, which single reaction (if any) should that badge show right now" -- and nothing here
// decides revenue, legality, or what gets drawn.
//
// WHY RE-PARSE RATHER THAN REUSE `drawRouteOverlays`'S Path2D OBJECTS: a Path2D is opaque to the Canvas API --
// there is no standard point-at-length query, so a traveling signal cannot be sampled from one. The AUTHORED
// data underneath every Path2D `drawRouteOverlays` strokes is a plain SVG `d` string, and every string in the
// catalog (`TileGraphics.ts`'s `TILE_GRAPHICS_CATALOG` / `printedCatalog()`) is exactly one of:
//   "M x0 y0 L x1 y1"                              -- a straight rail
//   "M x0 y0 C cx1 cy1 cx2 cy2 x1 y1"               -- one cubic Bezier
// (verified by scanning every authored track in the catalog). So this module re-parses those same strings --
// the same source of truth `tileArtworkPaths`/`printedArtworkPaths` build their Path2D caches from -- into a
// form that can be sampled at an arbitrary point, instead of inventing a parallel drawing system. The hex
// walk below (entry/exit edge resolution, hub two-spoke handling, terminal truncation, Altoona's `variant`)
// deliberately mirrors `drawRouteOverlays`'s own walk in `hexCanvasPrimitives.ts`, calling the SAME exported
// selection functions (`artworkPathsForTraversal`, `printedPathsForEdge`, `railTruncatedAtMarker`, ...) so the
// two can never select a different rail for the same hex.

import { axialToPixel, boardHexLabel, HEX_NEIGHBOR_OFFSETS } from "./hexGeometry";
import {
  artworkPathsForEdge,
  artworkPathsForTraversal,
  printedArtworkEdgePairs,
  printedMarkersFor,
  printedPathsForEdge,
  printedPathsForTraversal,
  printedTracksFor,
  printedTraversalVariants,
  railTruncatedAtMarker,
  tileArtwork,
  tileArtworkEdgePairs,
  type TileArtworkMarker,
} from "./TileGraphics";
import type { RouteOverlay } from "./hexCanvasPrimitives";

/* ------------------------------------------------------------------ */
/* Local-space (unit-hex) curve primitives                            */
/* ------------------------------------------------------------------ */

interface LocalPoint {
  x: number;
  y: number;
}

type Primitive =
  | { kind: "line"; p0: LocalPoint; p1: LocalPoint }
  | { kind: "cubic"; p0: LocalPoint; c1: LocalPoint; c2: LocalPoint; p1: LocalPoint };

/** Parses one authored `d` string into a single primitive. The catalog is closed and every entry has been
 *  scanned to be exactly "M x y L x y" or "M x y C x1 y1 x2 y2 x3 y3" -- a `C` with fewer than 8 numbers, or
 *  neither shape, returns `null` rather than guessing, which the caller treats as "nothing to animate here"
 *  (the base route line still draws normally; only the signal/badge flourish sits this hex out). */
function parseUnitPath(d: string): Primitive | null {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!nums) return null;
  if (d.includes("C") && nums.length >= 8) {
    return {
      kind: "cubic",
      p0: { x: nums[0], y: nums[1] },
      c1: { x: nums[2], y: nums[3] },
      c2: { x: nums[4], y: nums[5] },
      p1: { x: nums[6], y: nums[7] },
    };
  }
  if (nums.length >= 4) {
    return {
      kind: "line",
      p0: { x: nums[0], y: nums[1] },
      p1: { x: nums[nums.length - 2], y: nums[nums.length - 1] },
    };
  }
  return null;
}

function reversePrimitive(p: Primitive): Primitive {
  return p.kind === "line"
    ? { kind: "line", p0: p.p1, p1: p.p0 }
    : { kind: "cubic", p0: p.p1, c1: p.c2, c2: p.c1, p1: p.p0 };
}

function sampleUnitPrimitive(p: Primitive, t: number): LocalPoint {
  if (p.kind === "line") {
    return { x: p.p0.x + (p.p1.x - p.p0.x) * t, y: p.p0.y + (p.p1.y - p.p0.y) * t };
  }
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return {
    x: uu * u * p.p0.x + 3 * uu * t * p.c1.x + 3 * u * tt * p.c2.x + tt * t * p.p1.x,
    y: uu * u * p.p0.y + 3 * uu * t * p.c1.y + 3 * u * tt * p.c2.y + tt * t * p.p1.y,
  };
}

/** 16 samples is plenty for a curve spanning at most ~1 hex-radius of unit space -- the length error against
 *  a much finer subdivision is well under a board pixel at any zoom this app renders at. */
const LENGTH_SAMPLES = 16;

function unitPrimitiveLength(p: Primitive): number {
  let total = 0;
  let prev = sampleUnitPrimitive(p, 0);
  for (let i = 1; i <= LENGTH_SAMPLES; i += 1) {
    const point = sampleUnitPrimitive(p, i / LENGTH_SAMPLES);
    total += Math.hypot(point.x - prev.x, point.y - prev.y);
    prev = point;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Per-hex primitive selection -- mirrors drawRouteOverlays's own walk */
/* ------------------------------------------------------------------ */

type EdgePairs = readonly (readonly [number | null, number | null] | null)[];

/** Whether authored path `index`'s FIRST point (the `d` string's "M x y") sits on `edge`, once the tile's
 *  own rotation is applied -- the identical rotation every caller of `tileArtworkEdgePairs`/
 *  `printedArtworkEdgePairs` already applies (`(pairEdge + rot) % 6`). A path with no pair entry orients
 *  forward, since there is nothing to judge it against. */
function firstPointOnEdge(pairs: EdgePairs, index: number, rot: number, edge: number): boolean {
  const pair = pairs[index];
  if (!pair) return true;
  const a = pair[0] === null ? null : (pair[0] + rot) % 6;
  return a === edge;
}

interface HexPrimitives {
  /** Orientation step (0-5) for a laid tile; always 0 for a preprinted hex -- same convention
   *  `drawRouteOverlays` reads off `laid.orientation` / passes 0 for printed artwork. */
  rot: number;
  /** One (through-connector, terminal) or two (a hub's entry + exit spokes) primitives, already oriented so
   *  walking each forward from `p0`/`c1`-side to `p1` and then on to the next primitive travels this hex in
   *  the route's own entry-to-exit direction. */
  primitives: Primitive[];
  /** Arc-length offset, from the FIRST primitive's own start, to this hex's revenue marker (its real
   *  station/town position along the rail) -- `null` for an endpoint (already truncated exactly at the
   *  marker at build time below, so its own full length already lands there) or a through hex whose
   *  traversed rail carries no marker at all (a plain connector with no revenue stop of its own). See
   *  `markerSegmentOffset`. */
  markerOffset: number | null;
}

/** Arc length from `d`'s OWN oriented start (its raw t=0 if `reversed` is false, its raw t=1 if `reversed`
 *  is true) to the point on it nearest one of `markers`' own positions -- `null` if none of `markers` lies
 *  on this specific rail. Reuses `railTruncatedAtMarker`'s own nearest-point search verbatim (same
 *  `keepStart` semantics: forward-from-0 keeps the start, backward-from-1 keeps the end), so a travelling
 *  signal's arrival point can never disagree with where a terminus already truncates for the same marker.
 *  Correctness audit, 2026-09-20 (design note 29): added because `matchRevenueStopsToPath` previously used
 *  a segment's own FULL length as its "arrival" distance for every hex, which is only correct for a route
 *  ENDING at that hex (already truncated at the marker below); for a route passing THROUGH a revenue
 *  centre, the full length lands at the hex's far edge, not at its own printed marker -- exactly the
 *  "generic per-hex position" the flourish's brief ruled out. */
function markerArcOffset(d: string, markers: readonly TileArtworkMarker[], reversed: boolean): number | null {
  if (markers.length === 0) return null;
  const sliceD = railTruncatedAtMarker(d, markers, !reversed);
  if (sliceD === d || sliceD === "") return null;
  const prim = parseUnitPath(sliceD);
  return prim ? unitPrimitiveLength(prim) : null;
}

/** Walks a hex's own primitives IN TRAVERSAL ORDER (one for a plain through-connector or terminus, two for
 *  a hub's entry + exit spokes) and returns the arc-length offset, from the first primitive's own start, to
 *  whichever one of them actually carries one of `markers` -- `null` if none does (a plain connector hex
 *  with no revenue stop of its own). A hub's two spokes both meet at the same physical interior point, so
 *  checking the entry spoke first and only falling back to the exit spoke mirrors
 *  `railTruncatedAtMarker`'s own first-match convention rather than risking a double count. */
function markerSegmentOffset(
  entries: ReadonlyArray<{ d: string; reversed: boolean }>,
  markers: readonly TileArtworkMarker[],
): number | null {
  let precedingLength = 0;
  for (const entry of entries) {
    const offset = markerArcOffset(entry.d, markers, entry.reversed);
    if (offset !== null) return precedingLength + offset;
    const prim = parseUnitPath(entry.d);
    precedingLength += prim ? unitPrimitiveLength(prim) : 0;
  }
  return null;
}

/** The same four-way branch `drawRouteOverlays` runs per hex (laid endpoint / laid through / printed
 *  endpoint / printed through), returning ORIENTED primitives instead of stroking them. `null` means this
 *  hex contributed nothing this module can animate (unauthored tile, artwork miss, or a genuinely disconnected
 *  waypoint) -- the caller drops the hex from the signal track and the base route line is unaffected. */
function primitivesForHex(
  entryEdge: number | null,
  exitEdge: number | null,
  laid: { tile_id: number; orientation: number } | undefined,
  printedLabel: string | undefined,
  variant: number | undefined,
): HexPrimitives | null {
  const terminalEdge = entryEdge ?? exitEdge;
  const isEndpoint = entryEdge === null || exitEdge === null;
  if (terminalEdge === null) return null;

  if (laid) {
    const rot = ((laid.orientation % 6) + 6) % 6;
    const art = tileArtwork(laid.tile_id);
    if (!art) return null;
    const pairs = tileArtworkEdgePairs(laid.tile_id);

    if (isEndpoint) {
      const indices = artworkPathsForEdge(laid.tile_id, laid.orientation, terminalEdge);
      if (indices.length === 0 || !art.tracks[indices[0]]) return null;
      const index = indices[0];
      const pair = pairs[index];
      const startEdge = pair && pair[0] !== null ? (pair[0] + rot) % 6 : null;
      const keepStart = startEdge === terminalEdge;
      const truncated = railTruncatedAtMarker(art.tracks[index], art.markers, keepStart);
      const prim = parseUnitPath(truncated);
      if (!prim) return null;
      // `keepStart` true means the truncated string's OWN start is the untouched edge point -- already
      // oriented edge -> interior, which is the arrival direction a terminus always animates. `markerOffset`
      // is `null` (the fallback `length` applies): this primitive is ALREADY cut exactly at the marker, so
      // its own full length already IS the arrival distance -- nothing more to compute.
      return { rot, primitives: [keepStart ? prim : reversePrimitive(prim)], markerOffset: null };
    }

    const indices = artworkPathsForTraversal(laid.tile_id, laid.orientation, entryEdge!, exitEdge!);
    if (indices.length === 0 || !indices.every((i) => art.tracks[i])) return null;
    if (indices.length === 2) {
      const [entryIndex, exitIndex] = indices;
      const rawEntry = parseUnitPath(art.tracks[entryIndex]);
      const rawExit = parseUnitPath(art.tracks[exitIndex]);
      if (!rawEntry || !rawExit) return null;
      // Entry spoke: oriented edge(entryEdge) -> interior. Exit spoke: oriented interior -> edge(exitEdge),
      // which is the OPPOSITE test -- its own edge end sits at `p1`, not `p0`, when unreversed is correct.
      const entryReversed = !firstPointOnEdge(pairs, entryIndex, rot, entryEdge!);
      const exitReversed = firstPointOnEdge(pairs, exitIndex, rot, exitEdge!);
      return {
        rot,
        primitives: [entryReversed ? reversePrimitive(rawEntry) : rawEntry, exitReversed ? reversePrimitive(rawExit) : rawExit],
        markerOffset: markerSegmentOffset(
          [
            { d: art.tracks[entryIndex], reversed: entryReversed },
            { d: art.tracks[exitIndex], reversed: exitReversed },
          ],
          art.markers,
        ),
      };
    }
    const raw = parseUnitPath(art.tracks[indices[0]]);
    if (!raw) return null;
    const singleReversed = !firstPointOnEdge(pairs, indices[0], rot, entryEdge!);
    return {
      rot,
      primitives: [singleReversed ? reversePrimitive(raw) : raw],
      markerOffset: markerSegmentOffset([{ d: art.tracks[indices[0]], reversed: singleReversed }], art.markers),
    };
  }

  if (printedLabel !== undefined) {
    const tracks = printedTracksFor(printedLabel);
    if (!tracks) return null;
    const pairs = printedArtworkEdgePairs(printedLabel);

    if (isEndpoint) {
      const indices = printedPathsForEdge(printedLabel, terminalEdge);
      if (indices.length === 0 || !tracks[indices[0]]) return null;
      const index = indices[0];
      const pair = pairs[index];
      const keepStart = pair ? pair[0] === terminalEdge : true;
      const truncated = railTruncatedAtMarker(tracks[index], printedMarkersFor(printedLabel), keepStart);
      const prim = parseUnitPath(truncated);
      if (!prim) return null;
      return { rot: 0, primitives: [keepStart ? prim : reversePrimitive(prim)], markerOffset: null };
    }

    const indices =
      (variant !== undefined ? printedTraversalVariants(printedLabel, entryEdge!, exitEdge!)[variant] : undefined) ??
      printedPathsForTraversal(printedLabel, entryEdge!, exitEdge!);
    if (indices.length === 0 || !indices.every((i) => tracks[i])) return null;
    if (indices.length === 2) {
      const [entryIndex, exitIndex] = indices;
      const rawEntry = parseUnitPath(tracks[entryIndex]);
      const rawExit = parseUnitPath(tracks[exitIndex]);
      if (!rawEntry || !rawExit) return null;
      const printedMarkers = printedMarkersFor(printedLabel);
      const entryReversed = !firstPointOnEdge(pairs, entryIndex, 0, entryEdge!);
      const exitReversed = firstPointOnEdge(pairs, exitIndex, 0, exitEdge!);
      return {
        rot: 0,
        primitives: [entryReversed ? reversePrimitive(rawEntry) : rawEntry, exitReversed ? reversePrimitive(rawExit) : rawExit],
        markerOffset: markerSegmentOffset(
          [
            { d: tracks[entryIndex], reversed: entryReversed },
            { d: tracks[exitIndex], reversed: exitReversed },
          ],
          printedMarkers,
        ),
      };
    }
    const raw = parseUnitPath(tracks[indices[0]]);
    if (!raw) return null;
    const singleReversed = !firstPointOnEdge(pairs, indices[0], 0, entryEdge!);
    return {
      rot: 0,
      primitives: [singleReversed ? reversePrimitive(raw) : raw],
      markerOffset: markerSegmentOffset(
        [{ d: tracks[indices[0]], reversed: singleReversed }],
        printedMarkersFor(printedLabel),
      ),
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* The assembled, sampleable track                                    */
/* ------------------------------------------------------------------ */

interface TrackPrimitive {
  prim: Primitive;
  length: number;
}

export interface RouteSignalSegment {
  /** Index into the overlay's own `hexes` array -- the join key back to `revenueEvents` below and to
   *  whatever else a caller wants to correlate against the route's own data. */
  hexIndex: number;
  q: number;
  r: number;
  /** Orientation step 0-5 (0 for preprinted artwork), applied the same way `drawRouteOverlays` rotates the
   *  canvas: `angle = -60 * rot` degrees. */
  rot: number;
  primitives: TrackPrimitive[];
  /** Cumulative unit-hex-space length at the START of this segment. */
  cumulativeStart: number;
  length: number;
  /** Arc-length offset from this segment's own start to the point on its own rail nearest this hex's
   *  revenue marker (its real printed station/town position) -- equal to `length` (the segment's own far
   *  end) when no marker was found on the traversed rail, which is exactly right for a plain connector hex
   *  with no revenue stop of its own, and also happens to already be exactly right for a route ENDING at
   *  this hex (see `markerOffset`'s own doc comment on `HexPrimitives`). Added by the 2026-09-20 correctness
   *  audit (design note 29) so `matchRevenueStopsToPath` can place a revenue event at the actual revenue
   *  centre instead of always the segment's far edge. */
  arrivalOffset: number;
}

export interface RouteRevenueEvent {
  hexIndex: number;
  /** Cumulative unit-hex-space distance at which the signal reaches this stop. */
  atDistance: number;
  value: number;
}

export interface RouteSignalTrack {
  segments: readonly RouteSignalSegment[];
  /** Total length in unit-hex-space -- SCALE-INVARIANT (board pixels = this times the current hex `size`,
   *  applied only at sample time), so this track need not be rebuilt on pan/zoom/resize. Rebuilt only when
   *  the route's own hex sequence, tile artwork, or orientation changes. */
  totalLength: number;
  revenueEvents: readonly RouteRevenueEvent[];
}

/** `tilesAt`/`printedLabelAt`: the identical callbacks `drawRouteOverlays` takes, so a caller building both
 *  in the same draw pass supplies the same two closures to each.
 *  `revenueStops`: this train's own `SandboxRouteBreakdown.stops` (hex label + printed value, in path
 *  order, already deduplicated per-city by the authoritative pricer) -- optional, since a route with no
 *  breakdown yet (nothing drafted) still gets a travelling signal with no revenue events to pulse. */
export function buildRouteSignalTrack(
  overlay: Pick<RouteOverlay, "hexes" | "variants">,
  tilesAt: (q: number, r: number) => { tile_id: number; orientation: number } | undefined,
  printedLabelAt: (q: number, r: number) => string | undefined,
  revenueStops?: ReadonlyArray<{ hex: string; value: number }>,
): RouteSignalTrack | null {
  if (overlay.hexes.length < 2) return null;

  const segments: RouteSignalSegment[] = [];
  const hexLabels: (string | null)[] = [];
  let cumulative = 0;

  for (let index = 0; index < overlay.hexes.length; index += 1) {
    const [q, r] = overlay.hexes[index];
    hexLabels.push(boardHexLabel(q, r));

    const edgeToward = (target: [number, number] | undefined): number | null => {
      if (!target) return null;
      const found = HEX_NEIGHBOR_OFFSETS.findIndex(([dq, dr]) => q + dq === target[0] && r + dr === target[1]);
      return found < 0 ? null : found;
    };
    const entryEdge = edgeToward(overlay.hexes[index - 1]);
    const exitEdge = edgeToward(overlay.hexes[index + 1]);
    if (entryEdge === null && exitEdge === null) continue;

    const laid = tilesAt(q, r);
    const printedLabel = printedLabelAt(q, r);
    const built = primitivesForHex(entryEdge, exitEdge, laid, printedLabel, overlay.variants?.[index]);
    if (!built) continue;

    const trackPrimitives = built.primitives.map((prim) => ({ prim, length: unitPrimitiveLength(prim) }));
    const segLength = trackPrimitives.reduce((sum, p) => sum + p.length, 0);
    if (segLength <= 0) continue;
    segments.push({
      hexIndex: index,
      q,
      r,
      rot: built.rot,
      primitives: trackPrimitives,
      cumulativeStart: cumulative,
      length: segLength,
      arrivalOffset: built.markerOffset ?? segLength,
    });
    cumulative += segLength;
  }

  if (segments.length === 0 || cumulative <= 0) return null;

  const revenueEvents = revenueStops ? matchRevenueStopsToPath(hexLabels, revenueStops, segments) : [];

  return { segments, totalLength: cumulative, revenueEvents };
}

/** Sequential two-pointer match: `stops` is, by construction (`sandboxRouteBreakdown` walks the same path in
 *  the same order, pushing at most one stop per path index), a left-to-right SUBSEQUENCE of `hexLabels` --
 *  so advancing a single stop pointer as `hexLabels` is walked in order assigns each stop to the exact path
 *  index it came from, including a hex visited twice for two different cities (design note #1318): each
 *  occurrence in `hexLabels` claims the next unclaimed stop with a matching label, in order, rather than
 *  collapsing both onto one badge event. No tile-ID or hex-label special-casing -- this reads only the
 *  authoritative breakdown's own order. */
/** Exported for its own direct test coverage -- see the header comment above the call site for why the
 *  sequential-match approach is correct without any tile-ID or hex-label special-casing. */
export function matchRevenueStopsToPath(
  hexLabels: readonly (string | null)[],
  stops: ReadonlyArray<{ hex: string; value: number }>,
  segments: readonly Pick<RouteSignalSegment, "hexIndex" | "cumulativeStart" | "arrivalOffset">[],
): RouteRevenueEvent[] {
  const events: RouteRevenueEvent[] = [];
  let stopPointer = 0;
  const segmentByHexIndex = new Map(segments.map((s) => [s.hexIndex, s] as const));
  for (let index = 0; index < hexLabels.length && stopPointer < stops.length; index += 1) {
    const label = hexLabels[index];
    if (label === null) continue;
    if (label !== stops[stopPointer].hex) continue;
    const segment = segmentByHexIndex.get(index);
    if (segment) {
      // The arrival point is this hex's own MARKER -- its real printed station/town position along the
      // rail (`arrivalOffset`, design note 29) -- not merely the end of the hex's own primitives, which for
      // a route passing THROUGH a revenue centre (rather than terminating on it) sits at the far edge, well
      // past where the marker itself is drawn.
      events.push({
        hexIndex: index,
        atDistance: segment.cumulativeStart + segment.arrivalOffset,
        value: stops[stopPointer].value,
      });
    }
    stopPointer += 1;
  }
  return events;
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

/** A point on the track's OWN unit-hex curve, in board pixels at the given `size` -- the only place `size`
 *  (and therefore pan/zoom/resize) enters this module. `distance` is taken modulo `totalLength`, so a caller
 *  animating a loop need not wrap it first. */
export function pointOnRouteTrack(
  track: RouteSignalTrack,
  distance: number,
  size: number,
): { x: number; y: number } | null {
  if (track.totalLength <= 0 || track.segments.length === 0) return null;
  const target = ((distance % track.totalLength) + track.totalLength) % track.totalLength;

  let segment = track.segments[track.segments.length - 1];
  for (const candidate of track.segments) {
    if (target < candidate.cumulativeStart + candidate.length) {
      segment = candidate;
      break;
    }
  }

  const local = target - segment.cumulativeStart;
  let chosen = segment.primitives[segment.primitives.length - 1];
  let acc = 0;
  for (const entry of segment.primitives) {
    if (local < acc + entry.length || entry === segment.primitives[segment.primitives.length - 1]) {
      chosen = entry;
      break;
    }
    acc += entry.length;
  }
  const t = chosen.length > 0 ? Math.max(0, Math.min(1, (local - acc) / chosen.length)) : 0;
  const localPoint = sampleUnitPrimitive(chosen.prim, t);

  const center = axialToPixel(segment.q, segment.r, size);
  const angle = (-60 * segment.rot * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const sx = localPoint.x * size;
  const sy = localPoint.y * size;
  return { x: center.x + (sx * cos - sy * sin), y: center.y + (sx * sin + sy * cos) };
}

/* ------------------------------------------------------------------ */
/* Revenue-badge hit reaction                                          */
/* ------------------------------------------------------------------ */
//
// SUPERSEDES two earlier designs in turn: first the persistent route-coloured badge-border system (formerly
// `BadgePerimeterShare` / `allocateBadgePerimeter` here), then the colour-flush interior tint that replaced
// it (`BadgeHitVisual { color, whiteMix }`, `BADGE_HIT_MAX_TINT_SOLO/_COINCIDENCE`, `BADGE_HIT_NEUTRAL_COLOR`
// -- all retired). Design decision (VISUAL_FLOURISH_BACKLOG.md, VF-2 finalize pass): a visual-prototype
// comparison found the badge reads better as a brief PHYSICAL reaction -- a scale-only mechanical pop -- than
// as any kind of colour change. The route highlight remains the ONLY carrier of route/revenue identity; the
// badge's own reaction carries no colour input at all, solo or coincidence alike.
//
// Everything below is still pure geometry/timing -- no colour math, no canvas. `badgePopScale` derives the
// badge's current scale from a `BadgeHitReaction` and is itself pure arithmetic (a smoothstep-eased
// attack/overshoot/settle curve); the actual drawing -- applying that scale as a canvas transform centred on
// the badge -- stays in `hexCanvasPrimitives.ts` where the rest of the drawing lives.

/** How close together two revenue arrivals at the SAME rendered badge have to land, in real elapsed
 *  milliseconds, to be treated as one coincidence rather than two independent hits (rule set item 7). A
 *  named, concrete constant rather than an inline number so it can be tuned in one place; the value itself
 *  is a genuine playtest variable (target range 100-150ms) -- see VISUAL_FLOURISH_BACKLOG.md. */
export const BADGE_HIT_COINCIDENCE_WINDOW_MS = 120;

/** One route's candidate arrival at a given rendered badge, in the same "distance travelled along this
 *  route's own track" terms the travelling-signal draw loop already computes -- NOT wall-clock time. Wall
 *  time only enters via `mostRecentArrivalMs`, so nothing here has to reason about two different routes'
 *  loop periods directly. A route that reaches the same rendered badge more than once per loop (rule set
 *  item 9) contributes one candidate per `atDistance`, not one per train -- each occurrence is independent
 *  and can coincide with, or stay clear of, any other occurrence on any route. */
export interface BadgeHitCandidate {
  /** This candidate's own route's total loop length, in the same unit-hex-space `RouteSignalTrack.totalLength`
   *  is expressed in -- needed to fold `atDistance` into the correct cycle relative to `distanceNow`. */
  readonly totalLength: number;
  /** Distance-along-track the signal head has travelled so far (`elapsedSec * speed`), UNWRAPPED -- may
   *  exceed `totalLength` many times over; this function takes it modulo `totalLength` itself. */
  readonly distanceNow: number;
  /** Distance-along-track at which the revenue marker sits (`RouteRevenueEvent.atDistance`). */
  readonly atDistance: number;
}

/** The most recent moment (real elapsed ms before "now") `candidate`'s travelling signal passed its own
 *  revenue marker, given the route's own loop length and constant travel speed. This is an EXACT reframing
 *  of the existing modular "time since arrival" computation
 *  (`((distanceNow - atDistance) % totalLength + totalLength) % totalLength) / speed`) from distance units
 *  into an absolute real-time offset from "now" -- same value, different units -- so that two candidates on
 *  routes with different loop periods can be compared with ordinary subtraction instead of by reasoning
 *  about two independent modular clocks. This is also what makes loop wrap-around "just work" (rule set item
 *  8) with no special case: an arrival just before one route's loop boundary and another just after a
 *  different route's own boundary are both already expressed as plain elapsed real time before `nowMs`, so
 *  a coincidence-window comparison never needs to know either loop wrapped at all. Returns `null` only for a
 *  degenerate route (no length, or a non-positive speed). */
export function mostRecentArrivalMs(
  candidate: Pick<BadgeHitCandidate, "totalLength" | "distanceNow" | "atDistance">,
  speedUnitsPerSec: number,
): number | null {
  if (candidate.totalLength <= 0 || speedUnitsPerSec <= 0) return null;
  const sinceUnits =
    (((candidate.distanceNow - candidate.atDistance) % candidate.totalLength) + candidate.totalLength) %
    candidate.totalLength;
  return (sinceUnits / speedUnitsPerSec) * 1000;
}

/** What a rendered badge should show right now (VF-2 finalize pass: scale-only mechanical pop -- see
 *  `badgePopScale` below). `"solo"` is a single revenue arrival; `"coincidence"` is two or more arrivals at
 *  this same rendered badge within `BADGE_HIT_COINCIDENCE_WINDOW_MS` of each other, collapsed into ONE
 *  stronger pop rather than two overlapping ones -- never distinguished by colour, since the badge carries no
 *  colour at all any more. `sinceMs` (real elapsed ms since the driving arrival) is what `badgePopScale` turns
 *  into the pop's current scale. */
export interface BadgeHitReaction {
  readonly kind: "solo" | "coincidence";
  readonly sinceMs: number;
}

/** Which reaction (if any) a rendered badge should show right now, given every route's candidate arrival at
 *  it. The most recently arrived candidate always drives the reaction (VF-2 finalize: a solo pop); if any
 *  OTHER candidate arrived within `BADGE_HIT_COINCIDENCE_WINDOW_MS` of the driving one, they collapse into a
 *  single, STRONGER `"coincidence"` pop instead of two overlapping ones -- this applies identically whether
 *  the coincident candidates are different routes or the same route hitting the same badge twice in close
 *  succession, since the check only ever compares arrival times, never train identity, never colour. Returns
 *  `null` once the most recent arrival is older than `pulseDurationMs` (nothing left to show) or when
 *  `candidates` is empty. */
export function selectBadgeHitReaction(
  candidates: readonly BadgeHitCandidate[],
  speedUnitsPerSec: number,
  pulseDurationMs: number,
): BadgeHitReaction | null {
  const arrivals = candidates
    .map((candidate) => ({ candidate, sinceMs: mostRecentArrivalMs(candidate, speedUnitsPerSec) }))
    .filter((entry): entry is { candidate: BadgeHitCandidate; sinceMs: number } => entry.sinceMs !== null)
    .sort((a, b) => a.sinceMs - b.sinceMs);

  if (arrivals.length === 0) return null;
  const driving = arrivals[0];
  if (driving.sinceMs >= pulseDurationMs) return null;

  const coincident = arrivals.some(
    (entry) =>
      entry !== driving && Math.abs(entry.sinceMs - driving.sinceMs) <= BADGE_HIT_COINCIDENCE_WINDOW_MS,
  );

  return coincident
    ? { kind: "coincidence", sinceMs: driving.sinceMs }
    : { kind: "solo", sinceMs: driving.sinceMs };
}

/* ------------------------------------------------------------------ */
/* Revenue-badge hit reaction -- scale-only mechanical pop (VF-2 finalize) */
/* ------------------------------------------------------------------ */
//
// Pure timing/easing math, no canvas: `badgePopScale` turns a `BadgeHitReaction` into the badge's current
// scale (1 = resting size). The caller (`hexCanvasPrimitives.ts`'s `drawValueBadgeAt`) applies that scale as
// a canvas transform centred on the badge's own centre -- fill, border and text scale together as one
// printed object, never independently.
//
// Every constant below is a genuine playtest variable (VISUAL_FLOURISH_BACKLOG.md: "whether 111%/117% feel
// right at runtime", "whether 260ms feels appropriately connected to signal speed", "whether the undershoot
// is perceptible/helpful") -- these are the values the approved visual-prototype comparison used, not final
// art direction tuned against real play.

/** Real elapsed ms from a driving arrival to the pop's peak scale. */
export const BADGE_POP_ATTACK_MS = 60;
/** Real elapsed ms from a driving arrival to the small opposite-direction undershoot past rest. */
export const BADGE_POP_OVERSHOOT_MS = 130;
/** Real elapsed ms from a driving arrival to fully back at rest (scale 1). */
export const BADGE_POP_SETTLE_MS = 260;
/** Peak scale for a SOLO hit (one arrival, nothing else within the coincidence window). */
export const BADGE_POP_PEAK_SOLO = 1.11;
/** The small opposite-direction undershoot a SOLO pop settles through on its way back to rest. */
export const BADGE_POP_UNDERSHOOT_SOLO = 0.985;
/** Peak scale for a COINCIDENCE hit -- modestly stronger than solo (rule set item 7's "modestly stronger ...
 *  so it still feels distinct" carries over unchanged from the retired tint design, applied to scale now
 *  instead of colour). */
export const BADGE_POP_PEAK_COINCIDENCE = 1.17;
/** The small opposite-direction undershoot a COINCIDENCE pop settles through on its way back to rest. */
export const BADGE_POP_UNDERSHOOT_COINCIDENCE = 0.975;

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** The badge's current scale (1 = resting size) `sinceMs` after `reaction`'s driving arrival --
 *  attack (rest -> peak) -> overshoot (peak -> a small undershoot past rest) -> settle (undershoot -> rest),
 *  each phase smoothstep-eased. `reaction` `null` (nothing arrived, or `selectBadgeHitReaction` has already
 *  returned `null` because the arrival fully decayed) always returns 1 -- the ordinary resting badge. No
 *  rotation, no translation, no colour: scale is the only thing this ever changes. */
export function badgePopScale(reaction: BadgeHitReaction | null): number {
  if (!reaction) return 1;
  const peak = reaction.kind === "solo" ? BADGE_POP_PEAK_SOLO : BADGE_POP_PEAK_COINCIDENCE;
  const undershoot = reaction.kind === "solo" ? BADGE_POP_UNDERSHOOT_SOLO : BADGE_POP_UNDERSHOOT_COINCIDENCE;
  const sinceMs = reaction.sinceMs;
  if (sinceMs < 0) return 1;
  if (sinceMs <= BADGE_POP_ATTACK_MS) {
    return 1 + (peak - 1) * smoothstep(sinceMs / BADGE_POP_ATTACK_MS);
  }
  if (sinceMs <= BADGE_POP_OVERSHOOT_MS) {
    const t = smoothstep((sinceMs - BADGE_POP_ATTACK_MS) / (BADGE_POP_OVERSHOOT_MS - BADGE_POP_ATTACK_MS));
    return peak + (undershoot - peak) * t;
  }
  if (sinceMs <= BADGE_POP_SETTLE_MS) {
    const t = smoothstep((sinceMs - BADGE_POP_OVERSHOOT_MS) / (BADGE_POP_SETTLE_MS - BADGE_POP_OVERSHOOT_MS));
    return undershoot + (1 - undershoot) * t;
  }
  return 1;
}
