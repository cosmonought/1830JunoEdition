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
 *  SCOPE: ALL 46 entries of `TILE_CATALOG` -- every city, town and plain
 *  connector, in every colour tier. There is no procedural fallback left for
 *  a real tile to reach; see design note #208 below for what closing the
 *  gap fixed, and design note #209 in `hexCanvasPrimitives.ts` for the
 *  algorithmic branches that were deleted rather than left unreachable.
 *
 *  The drift tripwire for this is `TILE_CATALOG_SIZE` in `hexTileCatalog.ts`
 *  and the dev-only assertion beneath it: a tile added to the catalog
 *  without artwork here renders as an explicit "unknown tile" placeholder,
 *  which is loud, rather than as a plausible-looking guess, which is not. */
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

  /* ==================================================================
   *  DESIGN NOTE 208: THE PLAIN CONNECTORS JOIN THE CATALOG
   * ==================================================================
   *
   * The 24 entries below close the catalog's original SCOPE decision, which
   * read: "Plain connector track (#7/#8/#9, #16-#29, #39-#47, #70) is
   * deliberately absent -- it carries no revenue centre, nothing about it was
   * wrong, and it keeps using the existing renderer."
   *
   * Two of those three clauses were mistaken, and the third was the trap.
   *
   * "NOTHING ABOUT IT WAS WRONG" -- it was. `drawTrackPath`'s procedural
   * branches key off the flat `connections` BITMASK, which for a plain tile
   * says only "these edges are live" and never which pairs route together.
   * With three or more live edges the renderer therefore fanned every edge
   * into the hex centre. #28 (edges 0/4/5) and #29 (edges 0/1/2) both came
   * out as a three-armed Y of straight radial spokes -- identical to each
   * other in shape, and neither resembling the tile. They are in fact mirror
   * images of one another and each is a GENTLE and a SHARP curve forking off
   * a shared edge: two smooth curves, no straight lines, no junction at the
   * middle of the hex. The bitmask cannot express that and no function of it
   * can recover it.
   *
   * "IT CARRIES NO REVENUE CENTRE" -- true, and irrelevant. The catalog is
   * not about markers; it is about the track being ART rather than a guess.
   *
   * "IT KEEPS USING THE EXISTING RENDERER" -- this is the trap. Plain
   * connectors are the most-laid tiles in 1830 by a wide margin, so
   * "everything except the connectors" meant, in practice, that most of the
   * board was drawn by the procedural path the catalog exists to retire. The
   * catalog now covers all 46 entries in `TILE_CATALOG`, and `drawTrackPath`
   * has had its algorithmic branches removed outright rather than left as an
   * unreachable fallback -- see design note #209 there.
   *
   * EVERY PATH BELOW IS ONE OF THE THREE CANONICAL PRIMITIVES named at the
   * top of this file, taken between the exact edge pairs
   * `TILE_CATALOG[n].paths` declares. Nothing here is a new shape: #7 is the
   * same sharp arc #3 draws, #8 the same gentle #58 draws, #9 the same
   * straight #57 draws. That is the point -- the tray prints one vocabulary,
   * and a connector is a city tile with the city left off.
   *
   * WHERE TWO PATHS SHARE AN EDGE (#23-#29, #39-#47, #70) both curves are
   * drawn in full from that shared edge midpoint. They overlap for the first
   * fraction of their length and then diverge, which is exactly how the
   * cardboard prints a fork -- not a Y-junction meeting at a node.
   */

  /* #7 -- sharp 0-1 */
  7: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
    ],
    markers: [],
  },
  /* #8 -- gentle 0-2 */
  8: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
    ],
    markers: [],
  },
  /* #9 -- straight 0-3 */
  9: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
    ],
    markers: [],
  },
  /* #16 -- gentle 0-2 + gentle 1-3, the two crossing green plains */
  16: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0",
    ],
    markers: [],
  },
  /* #18 -- straight 0-3 + sharp 1-2 */
  18: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 C 0.240563 -0.416667 -0.240563 -0.416667 -0.433013 -0.75",
    ],
    markers: [],
  },
  /* #19 -- straight 0-3 + gentle 2-4 */
  19: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M -0.433013 -0.75 C -0.165064 -0.285898 -0.165064 0.285898 -0.433013 0.75",
    ],
    markers: [],
  },
  /* #20 -- two straights crossing at centre */
  20: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 L -0.433013 0.75",
    ],
    markers: [],
  },
  /* #23 -- straight 0-3 + gentle 0-4, forking off edge 0 */
  23: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
    ],
    markers: [],
  },
  /* #24 -- straight 0-3 + gentle 0-2. The mirror of #23. */
  24: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
    ],
    markers: [],
  },
  /* #25 -- gentle 0-2 + gentle 0-4, a symmetric fork off edge 0 */
  25: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
    ],
    markers: [],
  },
  /* #26 -- straight 0-3 + sharp 0-5 */
  26: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.481125 0 0.240563 0.416667 0.433013 0.75",
    ],
    markers: [],
  },
  /* #27 -- straight 0-3 + sharp 0-1. The mirror of #26. */
  27: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
    ],
    markers: [],
  },
  /* #28 -- gentle 0-4 + sharp 0-5.
     REPORTED BUG, and the clearest case for this whole note. #28 and #29
     have DIFFERENT edge sets (0/4/5 versus 0/1/2) and identical shapes under
     reflection, and the procedural renderer drew both as the same three
     straight spokes into the hex centre -- so the two tiles were literally
     indistinguishable on the board and neither looked like itself. Both are
     a gentle and a sharp curve forking off edge 0, mirrored across the
     horizontal axis: edge 1 <-> edge 5, edge 2 <-> edge 4, edge 0 fixed.
     Compare the two entries directly -- every y coordinate is negated and
     nothing else changes. */
  28: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
      "M 0.866025 0 C 0.481125 0 0.240563 0.416667 0.433013 0.75",
    ],
    markers: [],
  },
  /* #29 -- gentle 0-2 + sharp 0-1. The exact reflection of #28. */
  29: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
    ],
    markers: [],
  },
  /* #39 -- sharp 0-1 + gentle 0-2 + sharp 1-2 */
  39: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.433013 -0.75 C 0.240563 -0.416667 -0.240563 -0.416667 -0.433013 -0.75",
    ],
    markers: [],
  },
  /* #40 -- three gentles, 0-2 + 0-4 + 2-4: the symmetric brown triangle */
  40: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
      "M -0.433013 -0.75 C -0.165064 -0.285898 -0.165064 0.285898 -0.433013 0.75",
    ],
    markers: [],
  },
  /* #41 -- sharp 0-1 + straight 0-3 + gentle 1-3 */
  41: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0",
    ],
    markers: [],
  },
  /* #42 -- sharp 0-5 + straight 0-3 + gentle 3-5. The mirror of #41. */
  42: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 0.416667 0.433013 0.75",
      "M 0.866025 0 L -0.866025 0",
      "M -0.866025 0 C -0.330127 0 0.165064 0.285898 0.433013 0.75",
    ],
    markers: [],
  },
  /* #43 -- gentle 0-2 + straight 0-3 + sharp 1-2 + gentle 1-3 */
  43: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 C 0.240563 -0.416667 -0.240563 -0.416667 -0.433013 -0.75",
      "M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0",
    ],
    markers: [],
  },
  /* #44 -- sharp 0-1 + straight 0-3 + straight 1-4 + sharp 3-4 */
  44: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
      "M 0.866025 0 L -0.866025 0",
      "M 0.433013 -0.75 L -0.433013 0.75",
      "M -0.866025 0 C -0.481125 0 -0.240563 0.416667 -0.433013 0.75",
    ],
    markers: [],
  },
  /* #45 -- straight 0-3 + gentle 0-4 + sharp 2-3 + gentle 2-4 */
  45: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
      "M -0.433013 -0.75 C -0.240563 -0.416667 -0.481125 0 -0.866025 0",
      "M -0.433013 -0.75 C -0.165064 -0.285898 -0.165064 0.285898 -0.433013 0.75",
    ],
    markers: [],
  },
  /* #46 -- gentle 0-2 + straight 0-3 + gentle 2-4 + sharp 3-4 */
  46: {
    tracks: [
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.866025 0 L -0.866025 0",
      "M -0.433013 -0.75 C -0.165064 -0.285898 -0.165064 0.285898 -0.433013 0.75",
      "M -0.866025 0 C -0.481125 0 -0.240563 0.416667 -0.433013 0.75",
    ],
    markers: [],
  },
  /* #47 -- straight 0-3 + gentle 0-4 + gentle 1-3 + straight 1-4 */
  47: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75",
      "M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0",
      "M 0.433013 -0.75 L -0.433013 0.75",
    ],
    markers: [],
  },
  /* #70 -- sharp 0-1 + gentle 0-2 + gentle 1-3 + sharp 2-3 */
  70: {
    tracks: [
      "M 0.866025 0 C 0.481125 0 0.240563 -0.416667 0.433013 -0.75",
      "M 0.866025 0 C 0.330127 0 -0.165064 -0.285898 -0.433013 -0.75",
      "M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0",
      "M -0.433013 -0.75 C -0.240563 -0.416667 -0.481125 0 -0.866025 0",
    ],
    markers: [],
  },
};

/* ==================================================================
 *  DESIGN NOTE 210: THE PREPRINTED HEXES ARE ARTWORK TOO
 * ==================================================================
 *
 * The twelve gray hexes, the three landmark cities and the off-board
 * terminals carry track that is printed on the BOARD rather than on a tile,
 * and they were the last procedural holdout: `drawPrintedTrack` drew every
 * one of them as two half-segments meeting at the hex centre.
 *
 * That construction produces a HARD ANGLE by definition, and worse, it is
 * not even a curve. `bezierTrackSegment(edgeMidpoint -> centre,
 * inwardNormal, null)` places its first control point on the inward normal
 * -- which points exactly at the centre -- and its second on the chord back
 * toward the start. Both are collinear with the straight edge-to-centre
 * line, so the Bezier degenerates to that line. Cleveland's 60-degree pair
 * therefore rendered as a sharp V through the middle of the hex, and it
 * looked wrong beside a laid tile drawn from real artwork one hex over.
 *
 * These are now authored the same way tiles are: literal `d` strings in the
 * same unit-hex space, using the same three canonical primitives, with the
 * city or town marker on the curve's own apex exactly as the tile catalog
 * places its markers. A gray hex and a laid tile that connect the same two
 * edges now draw the SAME shape, which is the property the board needs
 * across a colour step and never had across a board/tile step.
 *
 * NOT ROTATABLE, and that is why they are a separate table rather than
 * entries in `TILE_GRAPHICS_CATALOG`. A preprinted hex has one fixed
 * orientation baked into the board -- `GRAY_HEXES` stores absolute edge
 * numbers, not a base set plus a rotation -- so there is no orientation to
 * apply and no `paths`/`connections` bitmask to stay in sync with.
 *
 * THE EDGE SETS ARE NOT RESTATED HERE. They live in `hexBoardData`'s
 * `GRAY_HEXES`/`LANDMARK_TRACKS`/`OFFBOARD_TRACKS`, which is what
 * `liveEdgesForHex` reads for connectivity and legality. Duplicating them
 * would create exactly the drift this file's tile half already guards
 * against, so the renderer asserts the two agree by construction: it looks
 * this table up by the same label the edge tables are keyed on, and falls
 * back to the placeholder if a hex has track but no artwork.
 */

/** One preprinted hex's artwork. Same shape as `TileArtwork` minus anything
 *  orientation-dependent -- see design note #210. */
export interface PrintedArtwork {
  /** Literal SVG path data, unit-hex space. `M`/`L`/`C` only. */
  tracks: readonly string[];
  /** The revenue centre printed on it, or `undefined` for a bare connector
   *  hex (E9, A17, D24 -- the three gray hexes with no station at all). */
  marker?: TileArtworkMarker;
}

/** Preprinted board artwork, keyed by hex label.
 *
 *  Every entry's edge set matches `hexBoardData`'s own table for that label,
 *  and every marker sits on its own track's apex:
 *
 *    SHARP pair  -> apex is half way out to the shared corner (0.5 * corner)
 *    GENTLE pair -> apex is 0.232051 along the bisector of the two edges
 *    STRAIGHT    -> apex is the hex centre
 *
 *  the same three rules the tile catalog's markers follow. */
export const PRINTED_GRAPHICS_CATALOG: Readonly<Record<string, PrintedArtwork>> = {
  /* ---- Gray preprinted hexes (`GRAY_HEXES`) ---- */

  /** Lansing -- sharp 0-5, city on the apex. */
  D2: {
    tracks: ["M 0.866025 0 C 0.481125 0 0.240563 0.416667 0.433013 0.75"],
    marker: { kind: "city", at: { x: 0.433013, y: 0.25 } },
  },
  /** Cleveland -- sharp 4-5. The 60-degree pair that read as a V. */
  F6: {
    tracks: ["M -0.433013 0.75 C -0.240563 0.416667 0.240563 0.416667 0.433013 0.75"],
    marker: { kind: "city", at: { x: 0, y: 0.5 } },
  },
  /** A bare connector -- sharp 1-2, no station. */
  E9: {
    tracks: ["M 0.433013 -0.75 C 0.240563 -0.416667 -0.240563 -0.416667 -0.433013 -0.75"],
  },
  /** Altoona -- straight 0-3 through the city, PLUS the real "some trains
   *  skip this stop" bypass fork (`GrayHexTrack.bypass`), authored here as
   *  the wide arc it is on the board rather than derived at draw time. It
   *  bows clear of the station circle and stays inside the hex. */
  H12: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.433013 -0.55 -0.433013 -0.55 -0.866025 0",
    ],
    marker: { kind: "city", at: { x: 0, y: 0 } },
  },
  /** Rochester -- straight 0-3 through the city, with a curved spur in from
   *  edge 4. The spur enters its edge on the normal and eases into the
   *  station rather than meeting the main line as a straight radial spoke. */
  D14: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M -0.433013 0.75 C -0.240563 0.416667 -0.130526 0.226134 0 0",
    ],
    marker: { kind: "city", at: { x: 0, y: 0 } },
  },
  /** Kingston -- gentle 1-3, town on the apex. */
  C15: {
    tracks: ["M 0.433013 -0.75 C 0.165064 -0.285898 -0.330127 0 -0.866025 0"],
    marker: { kind: "town", at: { x: -0.116025, y: -0.200962 } },
  },
  /** Richmond -- a genuine dead-end stub into a terminal city. One edge, so
   *  there is no curve to draw: a single straight run from edge 2 to the
   *  station. Straight is not the same failure as a V -- there is no
   *  junction and no angle, which is what the board prints. */
  K15: {
    tracks: ["M -0.433013 -0.75 L 0 0"],
    marker: { kind: "city", at: { x: 0, y: 0 } },
  },
  /** A bare connector -- sharp 4-5, no station. */
  A17: {
    tracks: ["M -0.433013 0.75 C -0.240563 0.416667 0.240563 0.416667 0.433013 0.75"],
  },
  /** Montreal -- sharp 4-5, city on the apex. */
  A19: {
    tracks: ["M -0.433013 0.75 C -0.240563 0.416667 0.240563 0.416667 0.433013 0.75"],
    marker: { kind: "city", at: { x: 0, y: 0.5 } },
  },
  /** Atlantic City -- sharp 2-3, town on the apex. */
  I19: {
    tracks: ["M -0.433013 -0.75 C -0.240563 -0.416667 -0.481125 0 -0.866025 0"],
    marker: { kind: "town", at: { x: -0.433013, y: -0.25 } },
  },
  /** Mansfield -- sharp 2-3, town on the apex. */
  F24: {
    tracks: ["M -0.433013 -0.75 C -0.240563 -0.416667 -0.481125 0 -0.866025 0"],
    marker: { kind: "town", at: { x: -0.433013, y: -0.25 } },
  },
  /** A bare connector -- sharp 3-4, no station. */
  D24: {
    tracks: ["M -0.866025 0 C -0.481125 0 -0.240563 0.416667 -0.433013 0.75"],
  },

  /* ---- Landmark cities (`LANDMARK_TRACKS`) ---- */

  /** Boston -- gentle 1-5, city on the apex. */
  E23: {
    tracks: ["M 0.433013 -0.75 C 0.165064 -0.285898 0.165064 0.285898 0.433013 0.75"],
    marker: { kind: "city", at: { x: 0.232051, y: 0 } },
  },
  /** Baltimore -- gentle 0-4, city on the apex. */
  I15: {
    tracks: ["M 0.866025 0 C 0.330127 0 -0.165064 0.285898 -0.433013 0.75"],
    marker: { kind: "city", at: { x: 0.116025, y: 0.200962 } },
  },
};

/** New York's two independent stubs, which need their own entry because the
 *  hex carries TWO stations rather than one -- `PrintedArtwork.marker` is
 *  singular by design, since every other preprinted hex has at most one.
 *
 *  Same shape as the "OO" tile #59: two terminal spurs that never meet, each
 *  capped by its own station. The edges (1 and 4) are `LANDMARK_TRACKS`'s
 *  own, and each stub runs from its edge midpoint to the station that caps
 *  it -- straight, because a terminal spur is straight on the board. */
export const NEW_YORK_PRINTED_ARTWORK: {
  tracks: readonly string[];
  markers: readonly TileArtworkMarker[];
} = {
  tracks: [
    "M 0.433013 -0.75 L 0.216506 -0.375",
    "M -0.433013 0.75 L -0.216506 0.375",
  ],
  markers: [
    { kind: "city", at: { x: 0.216506, y: -0.375 } },
    { kind: "city", at: { x: -0.216506, y: 0.375 } },
  ],
};

/** `Path2D` objects for a preprinted hex, built once. `undefined` when the
 *  label carries no authored artwork, which the renderer treats exactly as
 *  it treats an unknown tile id. */
const PRINTED_PATH_CACHE = new Map<string, readonly Path2D[]>();

/* ==================================================================
 *  DESIGN NOTE 229: NEW YORK IS A PREPRINTED HEX LIKE ANY OTHER
 * ==================================================================
 *
 * G19 is authored in `NEW_YORK_PRINTED_ARTWORK` rather than in
 * `PRINTED_GRAPHICS_CATALOG`, because it prints TWO stations and
 * `PrintedArtwork.marker` is singular. That split is right for the DATA and
 * was silently wrong for every LOOKUP over it: `printedArtworkPaths`,
 * `printedArtworkEdgePairs` and the interior-end cache all indexed the
 * catalog, missed G19, and returned nothing for it.
 *
 * The consequence was invisible until the route glow started resolving
 * individual rails: a train stopping at New York resolved no path at all, so
 * the busiest hex on the board highlighted NOTHING. The previous whole-hex
 * behaviour had masked it by lighting both spurs -- one bug covering
 * another, which is why fixing the first exposed the second.
 *
 * `printedTracksFor` is the single place that knows about the exception, so
 * every lookup over printed artwork sees the same set of hexes.
 */
function printedTracksFor(label: string): readonly string[] | undefined {
  if (label === "G19") return NEW_YORK_PRINTED_ARTWORK.tracks;
  return PRINTED_GRAPHICS_CATALOG[label]?.tracks;
}

/** Every revenue centre printed on `label`, as a list.
 *
 *  The MARKER half of design note #229's exception. `PrintedArtwork.marker`
 *  is singular and New York's is a pair, so a caller that wants "the
 *  markers on this hex" has to know about the split -- and the whole point
 *  of `printedTracksFor` is that it should not have to. Same shape as that
 *  function, one hex further on.
 *
 *  Empty for a bare connector hex (E9, A17, D24), which prints track and no
 *  station at all. */
export function printedMarkersFor(label: string): readonly TileArtworkMarker[] {
  if (label === "G19") return NEW_YORK_PRINTED_ARTWORK.markers;
  const marker = PRINTED_GRAPHICS_CATALOG[label]?.marker;
  return marker ? [marker] : [];
}

export function printedArtworkPaths(label: string): readonly Path2D[] | undefined {
  const cached = PRINTED_PATH_CACHE.get(label);
  if (cached) return cached;
  const tracks = printedTracksFor(label);
  if (!tracks) return undefined;
  const built = tracks.map((d) => new Path2D(d));
  PRINTED_PATH_CACHE.set(label, built);
  return built;
}

export function printedArtwork(label: string): PrintedArtwork | undefined {
  return PRINTED_GRAPHICS_CATALOG[label];
}

/** New York's stubs as `Path2D`, cached under a key no hex label can
 *  collide with. */
const NEW_YORK_CACHE_KEY = "__new_york__";

export function newYorkPrintedPaths(): readonly Path2D[] {
  const cached = PRINTED_PATH_CACHE.get(NEW_YORK_CACHE_KEY);
  if (cached) return cached;
  const built = NEW_YORK_PRINTED_ARTWORK.tracks.map((d) => new Path2D(d));
  PRINTED_PATH_CACHE.set(NEW_YORK_CACHE_KEY, built);
  return built;
}

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

/** A station marker's radius as a fraction of the (possibly shrunk) marker
 *  size. Matches `drawStationCircle`/`drawStationTokenMarker`'s own `0.22`,
 *  which is the figure the whole board's city circles are drawn at. */
export const STATION_RADIUS_RATIO = 0.22;

/** The slot ring's radius, as a fraction of the station radius.
 *
 *  This was a bare `0.86` literal inside `drawStationPill`, which draws
 *  "the printed circles the wooden tokens drop into". Extracted so the
 *  token that drops in can read the same number as the circle it drops
 *  into -- the same reason `PILL_SLOT_SPACING` is shared. */
export const SLOT_RING_RATIO = 0.86;

/** How much a docked token is inset inside its slot ring -- design note
 *  #151.
 *
 *  A token filled to exactly the ring radius covers the ring, and since the
 *  token carries its own outline CENTRED on its radius -- so half of it
 *  spills outward -- filling to the ring would actually paint over it
 *  entirely. A two-slot pill would then render as two flat discs with no
 *  visible socket, and an empty slot beside a filled one would share no
 *  geometry with it.
 *
 *  DESIGN NOTE 487 CHANGED WHAT THAT OUTLINE MEASURES. It was
 *  `max(2, size * 0.05)` -- an absolute width, which is why this inset had
 *  to be generous enough to swallow the worst case. It is now
 *  `radius * STATION_TOKEN_RING_WIDTH_RATIO`, so the spill is a fixed
 *  fraction of the token and 0.84 clears it at every radius rather than
 *  only at the largest. The figure is unchanged: it was already sufficient,
 *  and loosening it now would move every docked token on the board for no
 *  reported reason.
 *
 *  0.84 leaves that outline room to land just inside the ring, so the ring
 *  survives as a thin collar: what a wooden token sitting in a printed
 *  circle actually looks like.
 *
 *  Applied ONLY to artwork-derived docking (see `tileCityTokenRadius`).
 *  The preprinted/fallback path keeps its exact `size * 0.22`, which design
 *  note #36 deliberately matched to the big white city circles. */
export const TOKEN_DOCK_INSET = 0.84;

/** The marker-size shrink a multi-marker tile takes.
 *
 *  Extracted so `tileCitySlotPoints` (which places tokens) and
 *  `tileCityTokenRadius` (which sizes them) cannot disagree -- the exact
 *  hazard `PILL_SLOT_SPACING`'s own note describes, one field over. */
function markerSizeFor(art: TileArtwork, size: number): number {
  return art.markers.length > 1 ? size * 0.85 : size;
}

/** The radius a token should be drawn at when docked into one of this
 *  tile's city slots, or `undefined` for a tile with no hand-authored
 *  artwork (whose caller should keep the legacy per-hex radius).
 *
 *  WHY THIS EXISTS: `drawStationTokenMarker` hardcoded `size * 0.22`, where
 *  `size` is the HEX size. On any multi-marker tile the slot rings are
 *  drawn at `size * 0.85 * 0.22` instead, so the token came out ~18% wider
 *  than the circle it was supposedly sitting in -- overflowing the pill on
 *  every OO tile and on New York, which is precisely the "centering across
 *  the entire pill" symptom rather than docking into a slot. The position
 *  was already right (`tileCitySlotPoints`); only the size was not. */
export function tileCityTokenRadius(tileId: number, size: number): number | undefined {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return undefined;
  // marker size -> station radius -> the ring inside it -> inset for the
  // token's own outline. Every factor is the shared constant the pill
  // renderer uses for the same step.
  return markerSizeFor(art, size) * STATION_RADIUS_RATIO * SLOT_RING_RATIO * TOKEN_DOCK_INSET;
}

/** `Path2D` is immutable once built and the catalog never changes, so each
 *  tile's paths are parsed from their `d` strings exactly once per session
 *  rather than on every frame of every hex. */
const PATH_CACHE = new Map<number, readonly Path2D[]>();

/* ===================================================================
 *  DESIGN NOTE 154: WHICH EDGES EACH AUTHORED PATH CONNECTS
 * ===================================================================
 *
 * The route overlay wants to trace a train's path along the REAL rails, not
 * along a generic curve through the middle of each hex. To do that it has
 * to know, for a given tile at a given rotation, which of its `tracks`
 * paths runs between the edge the train entered by and the edge it leaves
 * by.
 *
 * That mapping is not stored anywhere. `TileArtwork.tracks` is raw SVG, and
 * `TileCatalogEntry.paths` -- which IS edge-pair data -- is populated for
 * only five tiles (its own doc comment explains why).
 *
 * It does not need to be stored, because it is derivable. Every authored
 * path begins and ends on the hex boundary at an edge midpoint (the
 * catalog's own design note: "points (or dead-ends in the interior, for
 * #59's terminal spurs)"). So reading the first and last coordinate pair
 * out of the `d` string and matching each against the six known edge
 * midpoints recovers the pair exactly -- no second data table to keep in
 * sync with the artwork, which is the failure mode a hand-written mapping
 * would have.
 *
 * The interior dead-ends are why this returns `null` per path rather than
 * assuming success: #59's spurs genuinely terminate mid-hex and belong to
 * no edge. A `null` entry simply means "the overlay falls back to its
 * generic curve here", which is the old behaviour and always safe.
 *
 * Parsed once per tile and cached, like `tileArtworkPaths` -- the catalog
 * is immutable, so this is a fixed function of the tile id.
 */
const EDGE_PAIR_CACHE = new Map<number, readonly (readonly [number | null, number | null] | null)[]>();

/** Unit-space midpoint of edge `i`, matching `hexGeometry`'s
 *  `edgeAngleRad` (`-60 * i`) and an apothem of `sqrt(3)/2`. Recomputed
 *  here rather than imported to keep this module free of a dependency on
 *  the canvas geometry helpers -- the two are asserted equal by the
 *  round-trip check in the overlay harness. */
function unitEdgeMidpoint(edge: number): { x: number; y: number } {
  const apothem = Math.sqrt(3) / 2;
  const angle = (-60 * edge * Math.PI) / 180;
  return { x: apothem * Math.cos(angle), y: apothem * Math.sin(angle) };
}

/** Every numeric literal in an SVG `d` string, in order. The catalog uses
 *  only `M`/`L`/`C`, all of which take plain `x y` pairs, so the first two
 *  numbers are the start point and the last two are the end point. */
function pathEndpoints(d: string): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
  const nums = d.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  return {
    start: { x: Number(nums[0]), y: Number(nums[1]) },
    end: { x: Number(nums[nums.length - 2]), y: Number(nums[nums.length - 1]) },
  };
}

/** The edge a boundary point sits on, or `null` for an interior dead-end.
 *  The tolerance is generous relative to the spacing between edge midpoints
 *  (which are ~0.87 apart in unit space), so this cannot mis-assign. */
function edgeAtPoint(point: { x: number; y: number }): number | null {
  for (let edge = 0; edge < 6; edge += 1) {
    const mid = unitEdgeMidpoint(edge);
    if (Math.hypot(point.x - mid.x, point.y - mid.y) < 0.08) return edge;
  }
  return null;
}

/** For each of this tile's `tracks` paths, the BASE (unrotated) edge each
 *  END lands on -- `null` for an end that stops in the tile's interior.
 *
 *  THE `null` IS LOAD-BEARING, not a failure. A multi-spoke city hub
 *  (#14, #15, #53, #61, #63) authors its track as N separate SPOKES, each
 *  running from one edge to the city at the centre: `M 0.866025 0 L 0 0`.
 *  Half of every such path legitimately has no edge. Collapsing those to a
 *  single `null` -- as a first cut of this function did -- threw away
 *  exactly the information needed to trace a route THROUGH a hub, which is
 *  where routes actually stop. #59's terminal spurs are the same shape. */
export function tileArtworkEdgePairs(
  tileId: number,
): readonly (readonly [number | null, number | null] | null)[] {
  const cached = EDGE_PAIR_CACHE.get(tileId);
  if (cached) return cached;
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return [];
  const pairs = art.tracks.map((d) => {
    const ends = pathEndpoints(d);
    if (!ends) return null;
    return [edgeAtPoint(ends.start), edgeAtPoint(ends.end)] as const;
  });
  EDGE_PAIR_CACHE.set(tileId, pairs);
  return pairs;
}

/** Indices into `tileArtworkPaths(tileId)` of the authored rail(s) a train
 *  crossing from `entryEdge` to `exitEdge` actually runs along, at this
 *  `orientation`.
 *
 *  Two shapes, because the catalog authors two shapes:
 *
 *    THROUGH TILE -- one path with both ends on edges. Returns that one
 *    path. Curves, straights, and the crossing tiles.
 *
 *    HUB -- N spokes meeting at the centre. Returns the TWO spokes the
 *    train uses, entry and exit. Stroking both traces edge -> city -> edge,
 *    which is the route the train really takes and lands on the drawn
 *    artwork rather than near it.
 *
 *  Empty when neither shape matches (no artwork, or a pair this tile does
 *  not connect) -- the caller falls back to its generic curve, which is
 *  always safe and is what every tile did before this existed.
 *
 *  Order-insensitive: a train may run either way along the same rail. */
export function artworkPathsForTraversal(
  tileId: number,
  orientation: number,
  entryEdge: number,
  exitEdge: number,
): number[] {
  return pathsForTraversal(
    tileArtworkEdgePairs(tileId),
    interiorEndsForTile(tileId),
    ((orientation % 6) + 6) % 6,
    entryEdge,
    exitEdge,
  );
}

/* ==================================================================
 *  DESIGN NOTE 217: TWO SPOKES ARE ONLY A ROUTE IF THEY MEET
 * ==================================================================
 *
 * The spoke-joining rule below exists for HUBS: #14, #15, #53, #61, #63 and
 * every gray city author their track as N separate arms running from an edge
 * to the station at the middle, so tracing a train through one means
 * stroking the arm it came in on and the arm it leaves by.
 *
 * Applied blindly, that rule also fires on the tiles it must not: #59 (the
 * green "OO") and New York's preprinted hex author TERMINAL SPURS -- two
 * arms that stop at two DIFFERENT stations and never touch. Their edge pairs
 * look identical to a hub's from the outside (one end on an edge, one end in
 * the interior), so a player chaining a route through such a hex -- which
 * the builder permits, since it only checks hex adjacency -- would have had
 * both spurs lit as though a train ran between them. The tile's whole point
 * is that it cannot.
 *
 * So the join now requires the two arms' INTERIOR ENDPOINTS TO COINCIDE. A
 * hub's arms all end at the same station and pass; a spur pair ends at two
 * separated stations and is refused, falling through to the whole-hex trace,
 * which draws the two spurs with the gap between them visible -- an honest
 * picture of a hex the train cannot cross.
 *
 * Comparison is in BASE (unrotated) space, which is sound because
 * orientation is a rigid rotation about the hex centre: two points that
 * coincide before it coincide after it.
 */
const INTERIOR_END_CACHE = new Map<string, readonly ({ x: number; y: number } | null)[]>();

/** Per authored path, the endpoint that does NOT sit on a hex edge -- a
 *  station or a spur terminus -- or `null` for a through-path with both ends
 *  on edges. */
function interiorEnds(
  cacheKey: string,
  tracks: readonly string[],
): readonly ({ x: number; y: number } | null)[] {
  const cached = INTERIOR_END_CACHE.get(cacheKey);
  if (cached) return cached;
  const built = tracks.map((d) => {
    const ends = pathEndpoints(d);
    if (!ends) return null;
    if (edgeAtPoint(ends.start) === null) return ends.start;
    if (edgeAtPoint(ends.end) === null) return ends.end;
    return null;
  });
  INTERIOR_END_CACHE.set(cacheKey, built);
  return built;
}

function interiorEndsForTile(tileId: number): readonly ({ x: number; y: number } | null)[] {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return [];
  return interiorEnds(`tile:${tileId}`, art.tracks);
}

function interiorEndsForPrinted(label: string): readonly ({ x: number; y: number } | null)[] {
  // Design note #229: `printedTracksFor`, not the catalog directly.
  const tracks = printedTracksFor(label);
  if (!tracks) return [];
  return interiorEnds(`printed:${label}`, tracks);
}

/** The shared body of `artworkPathsForTraversal` and its preprinted
 *  counterpart -- design note #215.
 *
 *  `rot` is the rotation to apply to each authored edge before matching.
 *  Tiles pass their orientation; a preprinted hex passes `0`, because the
 *  board's printed track has one fixed facing and `GRAY_HEXES` already
 *  stores absolute edge numbers. */
function pathsForTraversal(
  pairs: readonly (readonly [number | null, number | null] | null)[],
  /** Design note #217: where each spoke ends inside the hex, so two spokes
   *  are only joined when they genuinely meet. */
  interior: readonly ({ x: number; y: number } | null)[],
  rot: number,
  entryEdge: number,
  exitEdge: number,
): number[] {
  // The artwork is authored in base space and the renderer rotates the
  // canvas, so each edge rotates with it by the same step.
  const rotate = (edge: number | null) => (edge === null ? null : (edge + rot) % 6);

  let entrySpoke: number | undefined;
  let exitSpoke: number | undefined;

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (!pair) continue;
    const a = rotate(pair[0]);
    const b = rotate(pair[1]);

    if (a !== null && b !== null) {
      if ((a === entryEdge && b === exitEdge) || (a === exitEdge && b === entryEdge)) {
        return [index];
      }
      continue;
    }
    // A spoke: exactly one end on an edge.
    const edge = a ?? b;
    if (edge === null) continue;
    if (edge === entryEdge && entrySpoke === undefined) entrySpoke = index;
    else if (edge === exitEdge && exitSpoke === undefined) exitSpoke = index;
  }

  if (entrySpoke !== undefined && exitSpoke !== undefined) {
    // Design note #217: a hub, or two spurs that never touch?
    const a = interior[entrySpoke];
    const b = interior[exitSpoke];
    const meet = a != null && b != null && Math.hypot(a.x - b.x, a.y - b.y) < 0.02;
    if (meet) return [entrySpoke, exitSpoke];
  }
  return [];
}

/* ==================================================================
 *  DESIGN NOTE 215: PREPRINTED HEXES CAN BE TRAVERSED PRECISELY TOO
 * ==================================================================
 *
 * `artworkPathsForTraversal` lets the route overlay stroke the ONE authored
 * rail a train runs along inside a laid tile. Preprinted hexes had no
 * equivalent, so the overlay could only trace a gray hex's rails WHOLESALE
 * -- correct in shape, but on a hex with a branch it lit up track the train
 * does not use.
 *
 * That gap existed because the printed artwork is a different table with a
 * different key. The matching LOGIC is identical, so it is now shared: a
 * through-path is one entry with both ends on edges; a junction is two
 * spokes meeting at the station. The only difference is the rotation, which
 * for a preprinted hex is always zero.
 */
const PRINTED_EDGE_PAIR_CACHE = new Map<
  string,
  readonly (readonly [number | null, number | null] | null)[]
>();

/** Per authored path on preprinted hex `label`, the edge each END lands on.
 *  `null` for an end that stops in the hex's interior -- a station, or one
 *  of New York's terminal spurs. */
export function printedArtworkEdgePairs(
  label: string,
): readonly (readonly [number | null, number | null] | null)[] {
  const cached = PRINTED_EDGE_PAIR_CACHE.get(label);
  if (cached) return cached;
  // Design note #229: `printedTracksFor`, not the catalog directly.
  const tracks = printedTracksFor(label);
  if (!tracks) return [];
  const pairs = tracks.map((d) => {
    const ends = pathEndpoints(d);
    if (!ends) return null;
    return [edgeAtPoint(ends.start), edgeAtPoint(ends.end)] as const;
  });
  PRINTED_EDGE_PAIR_CACHE.set(label, pairs);
  return pairs;
}

/** Indices into `printedArtworkPaths(label)` of the rail(s) a train crossing
 *  from `entryEdge` to `exitEdge` runs along. Empty when this hex does not
 *  connect that pair, in which case the caller should fall back to tracing
 *  the whole hex rather than inventing a segment. */
export function printedPathsForTraversal(
  label: string,
  entryEdge: number,
  exitEdge: number,
): number[] {
  return pathsForTraversal(
    printedArtworkEdgePairs(label),
    interiorEndsForPrinted(label),
    0,
    entryEdge,
    exitEdge,
  );
}

/* ==================================================================
 *  DESIGN NOTE 225: A ROUTE'S ENDPOINT USES ONE RAIL, NOT THE HEX
 * ==================================================================
 *
 * A route's two ENDPOINTS have only one edge each -- there is no
 * entry-to-exit pair to resolve, because the train arrives and stops. The
 * overlay handled that by tracing every rail on the hex, which is wrong in
 * exactly the way the report describes:
 *
 *   NEW YORK (G19) prints TWO physically disconnected spurs. A train ending
 *   at the NE station lit BOTH, so the map claimed the corporation ran to a
 *   city it never reached. The same applies to #59 and to every crossing
 *   tile, whose two straights never touch.
 *
 * The train came in along the rail that TOUCHES the edge it entered by, so
 * that is the rail to light and the only one. This returns it.
 *
 * WHEN SEVERAL PATHS SHARE AN EDGE the first is taken, and it is worth
 * saying why that is not a coin-flip in practice: the tiles that fork off a
 * shared edge (#23-#29, #39-#47, #70) are all PLAIN CONNECTORS with no
 * revenue centre, and a route only ever ENDS at a revenue centre. So an
 * endpoint hex has at most one authored path per edge, and the ambiguous
 * case is unreachable by a well-formed route.
 */
function pathsTouchingEdge(
  pairs: readonly (readonly [number | null, number | null] | null)[],
  rot: number,
  edge: number,
): number[] {
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (!pair) continue;
    const a = pair[0] === null ? null : (pair[0] + rot) % 6;
    const b = pair[1] === null ? null : (pair[1] + rot) % 6;
    if (a === edge || b === edge) return [index];
  }
  return [];
}

/* ==================================================================
 *  DESIGN NOTE 244: A TRAIN STOPS AT THE STATION, NOT PAST IT
 * ==================================================================
 *
 * REPORTED BUG: route lines draw straight through cities and towns.
 *
 * They did, on the route's two ENDPOINTS. Design note #225 resolved an
 * endpoint to the whole authored rail meeting the entry edge -- which is the
 * right rail, and on a through-tile it is the WHOLE rail. Enter #57 (the
 * yellow city, a straight through a central station) from the east and the
 * glow ran east edge -> city -> west edge, claiming the train continued out
 * the far side of a city it terminates in.
 *
 * Hub tiles were already correct by accident of how they are authored: their
 * spokes run edge -> centre and stop there, so `artworkPathsForEdge` returns
 * a rail that already ends at the station. The bug is confined to rails that
 * PASS a revenue centre rather than ending at one -- #57's straight, the
 * town tiles, the OO cities on straights, and every preprinted gray hex
 * whose city sits on the curve's apex.
 *
 * So the terminal rail is CUT at the marker. `Path2D` cannot be partially
 * stroked, so the cut happens on the `d` string before the path is built:
 * find the point on the curve nearest the marker, split there, keep the half
 * the train arrived on.
 *
 * SPLITTING IS EXACT, not approximated. Every authored path is a single
 * segment -- one `L` or one `C` after the `M` -- so a line splits by
 * interpolation and a cubic by de Casteljau, both of which produce a curve
 * that lies exactly on the original. The only estimated quantity is WHERE
 * the marker sits along it, found by sampling; being a pixel off along a
 * curve the glow is already tracing is invisible, whereas a re-derived
 * approximation of the curve itself would not be.
 *
 * A MARKER THAT IS NOT ON THIS RAIL LEAVES IT WHOLE. #55's two straights
 * cross, so each carries one town and not the other; the tolerance below
 * rejects the far one and that rail is stroked full length -- which is
 * correct, because a train crossing #55 really does pass straight through.
 */

type Segment =
  | { kind: "line"; p0: Point; p1: Point }
  | { kind: "cubic"; p0: Point; c1: Point; c2: Point; p1: Point };

interface Point {
  x: number;
  y: number;
}

/** Every authored path is one `M` plus one `L` or `C` -- see design note
 *  #244. Returns `null` for anything else, which leaves the rail whole. */
function parseSegment(d: string): Segment | null {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (d.includes(" L ") && n.length === 4) {
    return { kind: "line", p0: { x: n[0], y: n[1] }, p1: { x: n[2], y: n[3] } };
  }
  if (d.includes(" C ") && n.length === 8) {
    return {
      kind: "cubic",
      p0: { x: n[0], y: n[1] },
      c1: { x: n[2], y: n[3] },
      c2: { x: n[4], y: n[5] },
      p1: { x: n[6], y: n[7] },
    };
  }
  return null;
}

function pointAt(segment: Segment, t: number): Point {
  if (segment.kind === "line") {
    return {
      x: segment.p0.x + (segment.p1.x - segment.p0.x) * t,
      y: segment.p0.y + (segment.p1.y - segment.p0.y) * t,
    };
  }
  const u = 1 - t;
  const { p0, c1, c2, p1 } = segment;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

/** The parameter of the point on `segment` nearest `target`, or `null` when
 *  the curve never comes close enough for the marker to be ON it. */
function parameterNearest(segment: Segment, target: Point): number | null {
  const SAMPLES = 256;
  /** Generous relative to the ~0.87 spacing of edge midpoints, tight enough
   *  to reject the other arm of a crossing tile. */
  const TOLERANCE = 0.12;
  let bestT: number | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = i / SAMPLES;
    const point = pointAt(segment, t);
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestT = t;
    }
  }
  return bestDistance <= TOLERANCE ? bestT : null;
}

const f = (v: number) => Number(v.toFixed(6));

/** `d` for the portion of `segment` on one side of `t`. De Casteljau for a
 *  cubic, plain interpolation for a line -- both exact. */
function segmentSlice(segment: Segment, t: number, keepStart: boolean): string {
  if (segment.kind === "line") {
    const cut = pointAt(segment, t);
    const [a, b] = keepStart ? [segment.p0, cut] : [cut, segment.p1];
    return `M ${f(a.x)} ${f(a.y)} L ${f(b.x)} ${f(b.y)}`;
  }
  const { p0, c1, c2, p1 } = segment;
  const lerp = (a: Point, b: Point): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const a1 = lerp(p0, c1);
  const a2 = lerp(c1, c2);
  const a3 = lerp(c2, p1);
  const b1 = lerp(a1, a2);
  const b2 = lerp(a2, a3);
  const cut = lerp(b1, b2);
  const [s, k1, k2, e] = keepStart ? [p0, a1, b1, cut] : [cut, b2, a3, p1];
  return `M ${f(s.x)} ${f(s.y)} C ${f(k1.x)} ${f(k1.y)} ${f(k2.x)} ${f(k2.y)} ${f(e.x)} ${f(e.y)}`;
}

/* ==================================================================
 *  DESIGN NOTE 277: THE RAIL STOPS AT THE STATION WALL, NOT ITS CENTRE
 * ==================================================================
 *
 * REPORTED: a route ending at a city draws its spline through the tile to
 * the hex edge.
 *
 * Design note #244 already cut the terminal rail -- at the marker's CENTRE
 * POINT. Design note #267 then punched a clip hole at the marker's outer
 * radius, so on screen the line did appear to stop at the circle. Two
 * things were still wrong, and both are about the difference between
 * hiding a line and not drawing it:
 *
 *   THE GLOW LEAKED. Design note #268 strokes a shadowed pass under the
 *   crisp one, and a shadow blooms outward from wherever its source is. A
 *   source running to the marker's centre blooms symmetrically, so colour
 *   bled out all the way around the token no matter how the clip was set --
 *   the clip removes the STROKE inside the hole, not the glow the stroke
 *   casts before it gets there. That halo around the station is the
 *   "sloppy" part of the report.
 *
 *   A PILL IS NOT A CIRCLE. A 2-slot city is a capsule, and cutting at its
 *   centre leaves the rail crossing half the capsule -- under one of the
 *   two tokens -- before the clip catches it.
 *
 * So the cut moves to the PERIMETER. The rail is walked from the end being
 * kept and sliced at the first parameter that reaches the marker's outer
 * edge, which for a pill means the capsule's edge rather than a circle's.
 *
 * DISTANCE IS MEASURED TO THE MARKER'S SPINE, which is what makes one
 * formula cover both shapes: a 1-slot city's spine is a point and the
 * locus at distance `r` is a circle; a pill's spine is the segment between
 * its two end circles and the locus at distance `r` is exactly the capsule
 * outline `drawStationPill` draws. No branch, no second radius.
 */

/** Station geometry in UNIT-HEX space, mirroring `drawStationCircle` and
 *  `drawStationPill` -- which draw at `size * 0.22` with a ring stroke of
 *  `size * 0.06` straddling it, and shrink to 85% on a tile carrying more
 *  than one marker.
 *
 *  These MUST track those two functions. A radius smaller than the drawn
 *  circle leaves a sliver of route colour inside the station; larger leaves
 *  a gap between the rail and the circle it should touch. */
const MARKER_UNIT_RADIUS = 0.22;
const MARKER_UNIT_RING = 0.06;
const MULTI_MARKER_SCALE = 0.85;

/** Distance from `point` to a marker's spine -- the point itself for a
 *  1-slot city, the segment between the end circles for a pill. */
function distanceToMarkerSpine(
  point: Point,
  marker: TileArtworkMarker,
  scale: number,
): number {
  const centre = marker.at;
  const slots = marker.slots ?? 1;
  if (slots <= 1) return Math.hypot(point.x - centre.x, point.y - centre.y);

  // `PILL_SLOT_SPACING * radius` between slot centres, along `angle` --
  // the same construction `drawStationPill` uses for its cap circles.
  const half = (PILL_SLOT_SPACING * MARKER_UNIT_RADIUS * scale * (slots - 1)) / 2;
  const radians = ((marker.angle ?? 0) * Math.PI) / 180;
  const dx = Math.cos(radians) * half;
  const dy = Math.sin(radians) * half;
  const a = { x: centre.x - dx, y: centre.y - dy };
  const b = { x: centre.x + dx, y: centre.y + dy };

  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  // Clamped projection: past either end, the nearest point IS that end,
  // which is what gives the capsule its rounded caps.
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq),
  );
  return Math.hypot(point.x - (a.x + abx * t), point.y - (a.y + aby * t));
}

/** The rail `d`, cut where it meets whichever authored marker lies on it.
 *  Returns the original when no marker does -- design notes #244/#277. */
function railTruncatedAtMarker(
  d: string,
  markers: readonly TileArtworkMarker[],
  keepStart: boolean,
): string {
  const segment = parseSegment(d);
  if (!segment) return d;
  // Design note #277: a tile carrying several markers draws them smaller,
  // so the perimeter this cuts at has to shrink with them.
  const scale = markers.length > 1 ? MULTI_MARKER_SCALE : 1;
  const outerRadius = (MARKER_UNIT_RADIUS + MARKER_UNIT_RING / 2) * scale;

  for (const marker of markers) {
    /* ONLY that the marker is on this rail at all. Design note #244 also
       skipped markers sitting at t=0 or t=1, on the reasoning that a marker
       at an END cuts nothing off -- true of a CENTRE cut and false of a
       perimeter one, and it exempted the single largest group of city
       tiles. Every hub (#14, #15, #53, #61, #63 ...) authors its rails as
       spokes running edge -> centre, so its marker is at t=1 by
       construction: 23 of the board's 53 city-tile edges took that branch
       and drew the full spoke into the middle of the station. */
    if (parameterNearest(segment, marker.at) === null) continue;

    /* Walk from the END BEING KEPT toward the marker and stop on its
       perimeter. Sampling rather than solving: the crossing of a cubic with
       a capsule has no clean closed form, the curve is short, and 256 steps
       over a unit hex resolves to well under a screen pixel at any zoom
       this board reaches. */
    const SAMPLES = 256;
    let cut: number | null = null;
    for (let i = 0; i <= SAMPLES; i += 1) {
      // From t=0 forward when keeping the start, from t=1 backward when
      // keeping the end -- so "first contact" is always the near side of
      // the station rather than the far one.
      const sample = keepStart ? i / SAMPLES : 1 - i / SAMPLES;
      if (distanceToMarkerSpine(pointAt(segment, sample), marker, scale) <= outerRadius) {
        cut = sample;
        break;
      }
    }

    /* No contact means the marker is near this rail but not on it -- leave
       the rail whole and let another marker (or none) claim it.

       A cut at the very end being KEPT means the rail begins inside the
       station, so there is nothing to draw between the edge and the wall.
       Emitting a zero-length path there would be worse than emitting
       nothing, because `lineCap: "round"` renders it as a dot floating on
       the station. */
    if (cut === null) continue;
    const keptLength = keepStart ? cut : 1 - cut;
    if (keptLength < 0.02) return "";
    return segmentSlice(segment, cut, keepStart);
  }
  return d;
}

const TERMINAL_CACHE = new Map<string, Path2D | null>();

/** The rail meeting `edge`, cut at its revenue centre -- what a route's
 *  ENDPOINT should stroke. `null` when this hex has no rail on that edge. */
export function terminalRailAtEdge(
  tileId: number,
  orientation: number,
  edge: number,
): Path2D | null {
  const rot = ((orientation % 6) + 6) % 6;
  const indices = artworkPathsForEdge(tileId, orientation, edge);
  if (indices.length === 0) return null;
  const index = indices[0];
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return null;

  const pair = tileArtworkEdgePairs(tileId)[index];
  const startEdge = pair && pair[0] !== null ? (pair[0] + rot) % 6 : null;
  const keepStart = startEdge === edge;

  const key = `tile:${tileId}:${index}:${keepStart}`;
  const cached = TERMINAL_CACHE.get(key);
  if (cached !== undefined) return cached;
  const built = new Path2D(railTruncatedAtMarker(art.tracks[index], art.markers, keepStart));
  TERMINAL_CACHE.set(key, built);
  return built;
}

/** The preprinted counterpart -- New York included, via `printedTracksFor`. */
export function printedTerminalRailAtEdge(label: string, edge: number): Path2D | null {
  const indices = printedPathsForEdge(label, edge);
  if (indices.length === 0) return null;
  const index = indices[0];
  const tracks = printedTracksFor(label);
  if (!tracks) return null;

  const pair = printedArtworkEdgePairs(label)[index];
  const keepStart = pair ? pair[0] === edge : true;

  const key = `printed:${label}:${index}:${keepStart}`;
  const cached = TERMINAL_CACHE.get(key);
  if (cached !== undefined) return cached;

  const markers =
    label === "G19"
      ? NEW_YORK_PRINTED_ARTWORK.markers
      : PRINTED_GRAPHICS_CATALOG[label]?.marker
        ? [PRINTED_GRAPHICS_CATALOG[label].marker!]
        : [];
  const built = new Path2D(railTruncatedAtMarker(tracks[index], markers, keepStart));
  TERMINAL_CACHE.set(key, built);
  return built;
}

/** The authored rail on `tileId` that meets `edge` -- design note #225. */
export function artworkPathsForEdge(
  tileId: number,
  orientation: number,
  edge: number,
): number[] {
  return pathsTouchingEdge(tileArtworkEdgePairs(tileId), ((orientation % 6) + 6) % 6, edge);
}

/** The authored rail on preprinted hex `label` that meets `edge`. */
export function printedPathsForEdge(label: string, edge: number): number[] {
  return pathsTouchingEdge(printedArtworkEdgePairs(label), 0, edge);
}

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
  // multi-marker tile shrinks to 0.85. Now shared with
  // `tileCityTokenRadius` via `markerSizeFor` rather than restated here,
  // so the slot POSITIONS and the token SIZE cannot drift apart -- they are
  // the same measurement of the same circle.
  const markerSize = markerSizeFor(art, size);
  const radius = markerSize * STATION_RADIUS_RATIO;
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
