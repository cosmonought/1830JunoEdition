/* ==================================================================== *
 *  TileGraphics.ts -- HARDCODED 18xx TILE ARTWORK ("Art, not Math")
 * ==================================================================== *
 *
 *  Design note #131: EXPLICIT ARTWORK CATALOG.
 *
 *  Every entry below is a literal, hand-authored SVG path string. There is
 *  no procedural curve generation anywhere in this file and none is
 *  permitted: `bezierTrackSegment`, `edgeInwardNormal`, `drawDoubleTownRoute`
 *  and the whole algorithmic-offset family in `HexGridRenderer.tsx` are
 *  BYPASSED for every tile listed here. A tile in this catalog renders from
 *  its `d` strings and nothing else.
 *
 *  ---- COORDINATE SPACE ----------------------------------------------
 *
 *  Unit hex. Origin at hex centre, +x east, +y SOUTH (canvas convention,
 *  y grows downward), circumradius exactly 1. The renderer scales by the
 *  live `hexSize` and translates to the hex centre; nothing here needs to
 *  know the pixel size.
 *
 *  POINTY-TOP hexes, matching `axialToPixel`. Edge `i` sits at angle
 *  `-60 * i` degrees (`edgeAngleRad`), at the apothem `sqrt(3)/2`:
 *
 *      edge 0  E  ( 0.866025,  0       )   inward normal (-1,  0       )
 *      edge 1  NE ( 0.433013, -0.75    )                 (-0.5, 0.866025)
 *      edge 2  NW (-0.433013, -0.75    )                 ( 0.5, 0.866025)
 *      edge 3  W  (-0.866025,  0       )                 ( 1,   0       )
 *      edge 4  SW (-0.433013,  0.75    )                 ( 0.5,-0.866025)
 *      edge 5  SE ( 0.433013,  0.75    )                 (-0.5,-0.866025)
 *
 *  Every path in this file starts and ends EXACTLY on one of those six
 *  points (or dead-ends in the interior, for #59's terminal spurs), and
 *  every endpoint tangent is EXACTLY along that edge's inward normal. That
 *  is not a stylistic preference -- track has to meet its neighbour square
 *  across the hex boundary or the rail map visibly kinks at every seam.
 *
 *  ---- THE THREE CANONICAL PRIMITIVES --------------------------------
 *
 *  Real 1830 cardboard draws exactly three track shapes. Each is a true
 *  circular arc, transcribed here as the cubic Bezier that reproduces it
 *  (control-point length `k*r` with `k = 4/3 * tan(theta/4)`):
 *
 *    STRAIGHT  (opposite edges, |da| = 3)
 *      A literal `L`. Passes through hex centre.
 *
 *    GENTLE    (|da| = 2, e.g. 0-2)
 *      Arc of radius 1.5R centred on the far neighbouring hex's corner;
 *      60deg sweep; control length 0.535898. Closest approach to hex
 *      centre 0.232051 -- the shallow sweep on real cardboard.
 *
 *    SHARP     (|da| = 1, e.g. 0-1)
 *      Arc of radius 0.5R centred on the hex CORNER the two edges share;
 *      120deg sweep; control length 0.384900. Closest approach to hex
 *      centre 0.5 -- it hugs the corner, well clear of the middle.
 *
 *  A city or town marker on a curve sits at that curve's apex, which is
 *  where the cardboard prints it. Where two revenue centres would collide
 *  (tiles #2, #55, #56, #67, #68, #69 -- straights crossing at centre, or
 *  two near-parallel gentles), the marker slides ALONG ITS OWN TRACK until
 *  it is clear. Design note #123's rule, restated and now global: the
 *  markers move around the geometry, the geometry never moves around the
 *  markers.
 *
 *  ---- MULTI-CITY TILES ----------------------------------------------
 *
 *  #54/#62 ("NY"), #59/#64/#65/#66/#67/#68 ("OO") carry TWO physically
 *  independent stations. Each city's track is its own separate path and
 *  each city's marker sits on its OWN path. They share no node and no
 *  fan-to-centre hub. This is what the shared `twoNodePositions` diagonal
 *  got wrong: it planted both stations on a fixed NE/SW diagonal regardless
 *  of where the tile's track actually runs, which for #62 (live edges
 *  0/1/2/3, all in the upper half) dropped a station in the empty southern
 *  half of the hex, touching nothing.
 *
 *  Cross-check, per tile, against the 18xx source strings recorded in
 *  `hexmap::TILE_CATALOG`:
 *    #66  `city=revenue:50;city=revenue:50,loc:1.5` -- city A unlocated
 *         (hex centre, on the 0-3 straight), city B at loc 1.5 = the corner
 *         shared by edges 1 and 2. Reproduced exactly: (0,0) and (0,-0.5).
 *    #64  `city=revenue:50;city=revenue:50,loc:3.5` -- loc 3.5 = the corner
 *         shared by edges 3 and 4. Reproduced: (-0.433013, 0.25).
 *    #65  `loc:2.5` = corner shared by edges 2 and 3. Reproduced:
 *         (-0.433013, -0.25).
 *
 *  ---- ROTATION -------------------------------------------------------
 *
 *  Orientation is a RIGID ROTATION of this artwork about the hex centre --
 *  `ctx.rotate` on the already-built `Path2D`, exactly as a physical tile is
 *  turned on the board. The path data itself is never recomputed, offset or
 *  re-derived per orientation. Base edge `i` lands on live edge
 *  `(i + orientation) % 6`, which is what `rotateConnections` already does
 *  to the bitmask, so track and legality stay in agreement by construction.
 *
 *  ---- REVENUE --------------------------------------------------------
 *
 *  Not in this file, deliberately. Revenue is chain data, not artwork:
 *  it comes from `msg::MapTileEntry::revenue` (`hexmap::tile_base_value`,
 *  Audit G-11) and is rendered by `HexGridRenderer.tsx`'s badge pass. See
 *  design note #132 there.
 * ==================================================================== */

/** A revenue centre printed on a tile, in unit-hex coordinates. */
export interface TileArtworkMarker {
  /** `"city"` -> white station circle (token-bearing). `"town"` -> solid
   *  black dit. Same two primitives `drawStationCircle`/`drawDitMarker`
   *  already draw everywhere else on the board. */
  kind: "city" | "town";
  /** Unit-hex position. GUARANTEED to lie on one of this tile's own
   *  `tracks`, and (design note #133) guaranteed NOT to lie on a point
   *  where two of this tile's tracks cross. */
  at: { readonly x: number; readonly y: number };
  /** How many station tokens this city holds. Sourced per-tile from the
   *  18xx `slots:N` field recorded in `hexmap::TILE_CATALOG`'s comments;
   *  absent means `slots:1`, which is how 18xx itself defaults it.
   *
   *  Design note #133: `> 1` makes the renderer draw a PILL (elongated
   *  oval) instead of a circle. That is not decoration -- on real cardboard
   *  the elongated station is the only thing that tells a player this city
   *  can be shared, and a 2-slot city drawn as a plain circle actively
   *  misinforms them about whether a second company can still build in.
   *
   *  The four multi-slot cities in this catalog, all `slots:2`:
   *    #14, #15  `city=revenue:30,slots:2`
   *    #62       `city=revenue:80,slots:2` x2 -- BOTH New York stations
   *    #63       `city=revenue:40,slots:2`
   *  Every other city here is genuinely 1-slot, including #61's "B" and
   *  both of #54's New York stations -- checked against their own recorded
   *  source strings rather than assumed from the hub's importance. */
  slots?: number;
  /** The pill's long axis, in DEGREES, in base (unrotated) tile space.
   *  Ignored when `slots` is 1 -- a circle has no axis.
   *
   *  Where the city sits on a curve this is that curve's TANGENT at the
   *  marker, so the pill lies along the track like printed cardboard rather
   *  than cutting across it. Where the city is a central hub fed by radial
   *  spokes (#14/#15/#63) there is no single tangent, so the axis is set to
   *  bisect the widest gap between spokes -- the pill then sits BETWEEN the
   *  track arms instead of swallowing two of them. */
  angle?: number;
}

/** One tile's complete hand-authored artwork. */
export interface TileArtwork {
  /** Literal SVG path data, unit-hex space. `M`/`L`/`C` only. */
  tracks: readonly string[];
  /** Every revenue centre, in the SAME index order as this tile's
   *  `cityGroups` / backend `paths`, so `city_index` from a station-token
   *  record indexes straight in with no re-sorting. */
  markers: readonly TileArtworkMarker[];
}

/** THE hardcoded artwork table. Keyed on real 1830 tray number.
 *
 *  SCOPE: every Green and Brown CITY/TOWN tile, plus the Yellow tiles they
 *  upgrade from (so a hex never shows hand-drawn art next to procedural art
 *  across a colour step). Plain connector track (#7/#8/#9, #16-#29,
 *  #39-#47, #70) is deliberately absent -- it carries no revenue centre,
 *  nothing about it was wrong, and it keeps using the existing renderer. */
export const TILE_GRAPHICS_CATALOG: Readonly<Record<number, TileArtwork>> = {
  /* #1 -- two gentle curves, one town on each */
  1: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
      "M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0",
    ],
    markers: [
      { kind: "town", at: { x: 0.116025, y: 0.200962 } },
      { kind: "town", at: { x: -0.116025, y: -0.200962 } },
    ],
  },
  /* #2 -- straight + sharp; straight's town slid clear of the sharp */
  2: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 C 0.240563 -0.416667 -0.240563 -0.416667 -0.433013 -0.75",
    ],
    markers: [
      { kind: "town", at: { x: 0.28, y: 0 } },
      { kind: "town", at: { x: 0, y: -0.5 } },
    ],
  },
  /* #3 -- sharp curve, town on the apex */
  3: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
    ],
    markers: [
      { kind: "town", at: { x: 0.433013, y: -0.25 } },
    ],
  },
  /* #4 -- straight, town at centre */
  4: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
    ],
    markers: [
      { kind: "town", at: { x: 0, y: 0 } },
    ],
  },
  /* #14 -- green city, four radial spokes into one 2-slot station.
     Spokes at 0/-60/180/120 deg; the widest gaps are centred on the 60/240
     axis, so the pill lies there and touches none of them. */
  14: {
    tracks: [
      "M 0.866025 0 L 0 0",
      "M 0.433013 -0.75 L 0 0",
      "M -0.866025 0 L 0 0",
      "M -0.433013 0.75 L 0 0",
    ],
    markers: [
      { kind: "city", at: { x: 0, y: 0 }, slots: 2, angle: 60 },
    ],
  },
  /* #15 -- green city, four radial spokes into one 2-slot station.
     Spokes at 0/-60/-120/180 deg; widest gaps sit on the 90/270 axis. */
  15: {
    tracks: [
      "M 0.866025 0 L 0 0",
      "M 0.433013 -0.75 L 0 0",
      "M -0.433013 -0.75 L 0 0",
      "M -0.866025 0 L 0 0",
    ],
    markers: [
      { kind: "city", at: { x: 0, y: 0 }, slots: 2, angle: 90 },
    ],
  },
  /* #53 -- "B" green -- three radial spokes into one station */
  53: {
    tracks: [
      "M 0.866025 0 L 0 0",
      "M -0.433013 -0.75 L 0 0",
      "M -0.433013 0.75 L 0 0",
    ],
    markers: [
      { kind: "city", at: { x: 0, y: 0 } },
    ],
  },
  /* #54 -- "NY" green -- TWO separate sharp curves, one station on each, no shared node */
  54: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
      "M -0.433013 -0.75 C -0.240563 -0.416667 -0.481125 0 -0.866025 0",
    ],
    markers: [
      { kind: "city", at: { x: 0.433013, y: -0.25 } },
      { kind: "city", at: { x: -0.433013, y: -0.25 } },
    ],
  },
  /* #55 -- two straights crossing at centre; towns pushed out along their own arms */
  55: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 L -0.433013 0.75",
    ],
    markers: [
      { kind: "town", at: { x: 0.35, y: 0 } },
      { kind: "town", at: { x: -0.175, y: 0.303109 } },
    ],
  },
  /* #56 -- two near-parallel gentles; towns staggered along t so they never collide */
  56: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0",
    ],
    markers: [
      { kind: "town", at: { x: 0.32629, y: -0.10045 } },
      { kind: "town", at: { x: -0.32629, y: -0.10045 } },
    ],
  },
  /* #57 -- THE yellow city -- straight through one central station */
  57: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
    ],
    markers: [
      { kind: "city", at: { x: 0, y: 0 } },
    ],
  },
  /* #58 -- gentle curve, town on the apex */
  58: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
    ],
    markers: [
      { kind: "town", at: { x: 0.116025, y: -0.200962 } },
    ],
  },
  /* #59 -- "OO" green -- two TERMINAL spurs that never meet; a station caps each */
  59: {
    tracks: [
      "M 0.866025 0 L 0.42 0",
      "M -0.433013 -0.75 L -0.21 -0.363731",
    ],
    markers: [
      { kind: "city", at: { x: 0.42, y: 0 } },
      { kind: "city", at: { x: -0.21, y: -0.363731 } },
    ],
  },
  /* #61 -- "B" brown -- four radial spokes into one station */
  61: {
    tracks: [
      "M 0.866025 0 L 0 0",
      "M -0.433013 -0.75 L 0 0",
      "M -0.866025 0 L 0 0",
      "M -0.433013 0.75 L 0 0",
    ],
    markers: [
      { kind: "city", at: { x: 0, y: 0 } },
    ],
  },
  /* #62 -- "NY" brown -- TWO separate sharp curves, a 2-slot station on each.
     NON-INTERSECTION IS STRUCTURAL, not a tuning: track A is the arc of
     radius 0.5 about corner 1 (0.866025, -0.5), track B the arc of radius
     0.5 about corner 3 (-0.866025, -0.5). Arc A therefore spans
     x >= 0.366025 and arc B spans x <= -0.366025 -- a 0.73-wide corridor
     down the middle that neither can enter. They cannot cross at any
     orientation, and each station sits on its OWN arc's apex.
     Pill axes are each arc's tangent at that apex (+/-60 deg off horizontal),
     so the station lies ALONG its track rather than across it. */
  62: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
      "M -0.433013 -0.75 C -0.240563 -0.416667 -0.481125 0 -0.866025 0",
    ],
    markers: [
      { kind: "city", at: { x: 0.433013, y: -0.25 }, slots: 2, angle: 60 },
      { kind: "city", at: { x: -0.433013, y: -0.25 }, slots: 2, angle: 120 },
    ],
  },
  /* #63 -- brown city, six radial spokes into one 2-slot station.
     Spokes every 60 deg, so every gap midpoint is 30 deg off one; the pill
     takes the 30/210 axis and threads between two arms. */
  63: {
    tracks: [
      "M 0.866025 0 L 0 0",
      "M 0.433013 -0.75 L 0 0",
      "M -0.433013 -0.75 L 0 0",
      "M -0.866025 0 L 0 0",
      "M -0.433013 0.75 L 0 0",
      "M 0.433013 0.75 L 0 0",
    ],
    markers: [
      { kind: "city", at: { x: 0, y: 0 }, slots: 2, angle: 30 },
    ],
  },
  /* #64 -- "OO" brown -- gentle 0-2 + sharp 3-4, one station on each */
  64: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M -0.866025 0 C -0.481125 0 -0.240563 0.416667 -0.433013 0.75",
    ],
    markers: [
      { kind: "city", at: { x: 0.116025, y: -0.200962 } },
      { kind: "city", at: { x: -0.433013, y: 0.25 } },
    ],
  },
  /* #65 -- "OO" brown -- gentle 0-4 + sharp 2-3, one station on each */
  65: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
      "M -0.433013 -0.75 C -0.240563 -0.416667 -0.481125 0 -0.866025 0",
    ],
    markers: [
      { kind: "city", at: { x: 0.116025, y: 0.200962 } },
      { kind: "city", at: { x: -0.433013, y: -0.25 } },
    ],
  },
  /* #66 -- "OO" brown -- straight 0-3 (centre station) + sharp 1-2 */
  66: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 C 0.240563 -0.416667 -0.240563 -0.416667 -0.433013 -0.75",
    ],
    markers: [
      { kind: "city", at: { x: 0, y: 0 } },
      { kind: "city", at: { x: 0, y: -0.5 } },
    ],
  },
  /* #67 -- "OO" brown -- straight 0-3 + gentle 2-4.
     BUG FIX (design note #133, reported): these two tracks genuinely DO
     cross -- the gentle 2-4 arc's apex is (-0.232051, 0), which is a point
     on the 0-3 straight -- and station B was parked exactly on that
     crossing, which read as one station on a four-way junction instead of
     two stations on two tracks. The track is correct and unchanged; the
     STATION moved, per design note #123's rule. Station B now sits at
     t = 0.28 along its own gentle curve, 0.34 clear of the straight
     (station half-height 0.187 + track half-width 0.06 = 0.247), and 0.75
     from station A. */
  67: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M -0.433013 -0.75 C -0.165064 -0.285898 -0.165064 0.285898 -0.433013 0.75",
    ],
    markers: [
      { kind: "city", at: { x: 0.4, y: 0 } },
      { kind: "city", at: { x: -0.270957, y: -0.339547 } },
    ],
  },
  /* #68 -- "OO" brown -- two straights crossing at centre; stations pushed out along their own arms */
  68: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 L -0.433013 0.75",
    ],
    markers: [
      { kind: "city", at: { x: 0.38, y: 0 } },
      { kind: "city", at: { x: -0.19, y: 0.32909 } },
    ],
  },
  /* #69 -- straight + gentle sharing the centre; straight's town slid east */
  69: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M -0.433013 -0.75 C -0.165064 -0.285898 -0.165064 0.285898 -0.433013 0.75",
    ],
    markers: [
      { kind: "town", at: { x: 0.3, y: 0 } },
      { kind: "town", at: { x: -0.270957, y: -0.339547 } },
    ],
  },
};

/** Rotation by `-60 * orientation` degrees, written out rather than
 *  computed -- the six values a hex tile can possibly take. Index is
 *  `orientation`; `[cos, sin]`. */
const ROTATION: readonly (readonly [number, number])[] = [
  [1, 0],           // 0deg
  [0.5, -0.866025], // -60deg
  [-0.5, -0.866025],// -120deg
  [-1, 0],          // -180deg
  [-0.5, 0.866025], // -240deg
  [0.5, 0.866025],  // -300deg
];

/** Centre-to-centre spacing of a pill's slot circles, as a multiple of the
 *  station radius. NOT `2` (exactly-tangent circles): real cardboard
 *  overlaps them slightly, and at a full `2` the pill on #63 -- six radial
 *  spokes -- grows long enough to reach its own track arms.
 *
 *  Shared by `drawStationPill` (which places the end caps and the slot
 *  rings) and `tileCitySlotPoints` (which places the tokens that sit in
 *  them). If these two ever read different constants, tokens drift off their
 *  own rings, which is exactly the class of bug this file exists to stop. */
export const PILL_SLOT_SPACING = 1.6;

/** `Path2D` is immutable once built and the catalog never changes, so each
 *  tile's paths are parsed from their `d` strings exactly once per session
 *  rather than on every frame of every hex. */
const PATH_CACHE = new Map<number, readonly Path2D[]>();

export function tileArtwork(tileId: number): TileArtwork | undefined {
  return TILE_GRAPHICS_CATALOG[tileId];
}

/** Whether `tileId` has hand-authored artwork -- i.e. whether the renderer
 *  must bypass its procedural path entirely for this tile. */
export function hasTileArtwork(tileId: number): boolean {
  return Object.prototype.hasOwnProperty.call(TILE_GRAPHICS_CATALOG, tileId);
}

/** This tile's `Path2D` objects, built once from the literal `d` strings.
 *  Unit-hex space -- the caller supplies the transform. */
export function tileArtworkPaths(tileId: number): readonly Path2D[] | undefined {
  const cached = PATH_CACHE.get(tileId);
  if (cached) return cached;
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return undefined;
  const built = art.tracks.map((d) => new Path2D(d));
  PATH_CACHE.set(tileId, built);
  return built;
}

/** Where this tile's revenue centres land in BOARD pixels, after
 *  orientation.
 *
 *  This is the single source of truth for city position on a laid tile, and
 *  it is what `stationMarkerPoint` must consult: a company's station token
 *  has to sit on the same circle the artwork drew, and the artwork's circle
 *  is per-tile, not the fixed NE/SW diagonal `twoNodePositions` returns.
 *  `cityIndex` is the backend `city_index` -- same order as `cityGroups`. */
export function tileMarkerPoints(
  tileId: number,
  orientation: number,
  center: { x: number; y: number },
  size: number,
): { x: number; y: number }[] {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return [];
  const [cos, sin] = ROTATION[((orientation % 6) + 6) % 6];
  return art.markers.map((marker) => ({
    x: center.x + size * (marker.at.x * cos - marker.at.y * sin),
    y: center.y + size * (marker.at.x * sin + marker.at.y * cos),
  }));
}

/** One tile's city anchors only (towns excluded) -- the CENTRE of each
 *  city's marker. Index is `city_index`, matching the backend's
 *  `hexmap::tile_city_slot_counts` and `station_tokens`. Empty for a tile
 *  with no city. */
export function tileCityAnchors(
  tileId: number,
  orientation: number,
  center: { x: number; y: number },
  size: number,
): { x: number; y: number }[] {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return [];
  const points = tileMarkerPoints(tileId, orientation, center, size);
  return points.filter((_, index) => art.markers[index].kind === "city");
}

/** How many token slots each city on this tile has, by `city_index`.
 *
 *  MUST stay equal to `hexmap::tile_city_slot_counts` in the contract --
 *  that is the authority, this is the mirror. They are separate because the
 *  renderer needs the count before any chain round-trip (to draw the pill at
 *  all), while the contract needs it to enforce capacity. A drift shows up
 *  as a pill with more or fewer slot rings than the contract will let
 *  companies fill. */
export function tileCitySlotCounts(tileId: number): number[] {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return [];
  return art.markers.filter((m) => m.kind === "city").map((m) => m.slots ?? 1);
}

/** The individual TOKEN SLOT positions inside one city, in board pixels --
 *  design note #134.
 *
 *  A 1-slot city returns its single centre point, so a caller can use this
 *  uniformly without special-casing. A multi-slot city returns one point per
 *  slot, evenly spaced along the pill's long axis, at the SAME `1.6 * r`
 *  spacing `drawStationPill` places its cap circles -- which is why both
 *  read that constant from `PILL_SLOT_SPACING` rather than each carrying
 *  their own copy. A token drawn at slot `k` lands exactly on the ring the
 *  pill drew for slot `k`.
 *
 *  Returns `[]` for an unknown tile or an out-of-range `cityIndex`, never a
 *  guessed point -- a caller that gets nothing back should fall back to the
 *  hex centre rather than render a token somewhere arbitrary. */
export function tileCitySlotPoints(
  tileId: number,
  cityIndex: number,
  orientation: number,
  center: { x: number; y: number },
  size: number,
): { x: number; y: number }[] {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return [];
  const cities = art.markers
    .map((marker, index) => ({ marker, index }))
    .filter((entry) => entry.marker.kind === "city");
  const city = cities[cityIndex];
  if (!city) return [];

  const anchor = tileMarkerPoints(tileId, orientation, center, size)[city.index];
  if (!anchor) return [];

  const slots = city.marker.slots ?? 1;
  if (slots <= 1) return [anchor];

  // Marker size matches `drawHardcodedTileArtwork`'s own rule exactly: a
  // multi-marker tile shrinks to 0.85. Duplicated deliberately rather than
  // threaded through -- this function is called from the token pass, which
  // has no access to that local, and the two are asserted equal by the
  // slot-alignment check in `assertTileGraphicsIntegrity`.
  const markerSize = art.markers.length > 1 ? size * 0.85 : size;
  const radius = markerSize * 0.22;
  const spacing = PILL_SLOT_SPACING * radius;
  const span = spacing * (slots - 1);

  // The pill's axis is authored in BASE tile space, so it turns with the
  // tile -- the same `ROTATION` entry the artwork itself takes, applied to
  // the axis unit vector rather than re-deriving an angle in board space.
  const [cos, sin] = ROTATION[((orientation % 6) + 6) % 6];
  const baseAngle = ((city.marker.angle ?? 0) * Math.PI) / 180;
  const ax = Math.cos(baseAngle);
  const ay = Math.sin(baseAngle);
  const axis = { x: ax * cos - ay * sin, y: ax * sin + ay * cos };

  return Array.from({ length: slots }, (_, slot) => {
    const offset = -span / 2 + spacing * slot;
    return { x: anchor.x + axis.x * offset, y: anchor.y + axis.y * offset };
  });
}
