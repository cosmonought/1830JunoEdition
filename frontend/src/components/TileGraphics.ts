/* TileGraphics.ts -- HARDCODED 18xx TILE ARTWORK ("Art, not Math").
   
   Every entry is a literal, hand-authored SVG path string. No procedural curve
   generation anywhere, and none is permitted: a tile in this catalog renders
   from its `d` strings and nothing else.

   ONE EXEMPTION, NAMED RATHER THAN QUIETLY TAKEN. Design note #895 generates the seven red off-board hexes'
   stubs from `OFFBOARD_TRACKS`. It is not a curve -- every one is a straight radial line whose only variables
   are which edge and how far in -- and the rule above exists to stop plausible-looking shapes being invented
   from memory, which a straight line between two points already fixed by the board cannot do. What it buys is
   that the generated rail and the drawn stub cannot drift apart, which is the whole of the bug #895 fixes.
   A CURVE STILL GETS TYPED OUT. If a future off-board hex needs a bend, it goes in the catalog by hand.
   
   UNIT HEX. Origin at centre, +x east, +y SOUTH, circumradius 1, pointy-top.
   Every path starts and ends EXACTLY on an edge midpoint (or dead-ends in the
   interior, for #59's spurs), with its endpoint tangent EXACTLY along that
   edge's inward normal -- track must meet its neighbour square across the
   boundary or the map visibly kinks at every seam.
   
   THREE CANONICAL PRIMITIVES (straight / gentle / sharp), each a true circular
   arc transcribed as the cubic that reproduces it. Markers sit on their own
   curve's apex; where two would collide the MARKER slides, never the geometry.
   
   Orientation is a rigid rotation. Revenue is chain data, not artwork.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #131 */

import { OFFBOARD_TRACKS } from "./hexBoardData";

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
  /** slots > 1 draws a PILL rather than a circle. Not decoration: on real cardboard the elongated station is the only thing telling a player the city can be shared, and a 2-slot city drawn as a circle actively misinforms them.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #133 */
  slots?: number;
  /** The pill's long axis in base tile space. On a curve it is that curve's TANGENT so the pill lies along the track; on a radial hub there is no single tangent, so it bisects the widest gap between spokes and sits BETWEEN the arms.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #133 */
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

/** ALL 46 entries -- there is no procedural fallback left for a real tile to reach. The drift tripwire is the catalog size assertion: a tile added without artwork renders as an explicit placeholder, which is loud, rather than a plausible guess, which is not.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #208 */
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
  /* NON-INTERSECTION IS STRUCTURAL, not tuning: the two arcs are radius 0.5 about opposite corners, so one spans x >= 0.366 and the other x <= -0.366 -- a 0.73-wide corridor neither can enter, at any orientation.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #133 */
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
  /* These two tracks genuinely DO cross, and station B was parked exactly on the crossing. The track is correct and unchanged; the STATION moved, per the rule that markers move around geometry.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #123 */
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

  /* THE PLAIN CONNECTORS JOIN THE CATALOG. "Nothing about it was wrong" was false -- #28 and #29 have different edge sets and drew as the same three-spoke Y. "It keeps using the existing renderer" was the trap: connectors are the most-laid tiles in the game, so that meant most of the board.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #208 */

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
  /* The clearest case for the whole note: #28 and #29 are mirror images across the horizontal axis, and the procedural renderer drew both as the same three straight spokes -- literally indistinguishable, and neither looking like itself.
     See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #208 */
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

/* THE PREPRINTED HEXES ARE ARTWORK TOO. The old half-segment construction DEGENERATES -- both control points collinear with the edge-to-centre line -- so Cleveland's 60-degree pair rendered as a sharp V. NOT ROTATABLE, which is why this is a separate table: a preprinted hex has one facing baked into the board.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #210 */

/** One preprinted hex's artwork. Same shape as `TileArtwork` minus anything
 *  orientation-dependent -- see design note #210. */
export interface PrintedArtwork {
  /** Literal SVG path data, unit-hex space. `M`/`L`/`C` only. */
  tracks: readonly string[];
  /** The revenue centre printed on it, or `undefined` for a bare connector
   *  hex (E9, A17, D24 -- the three gray hexes with no station at all). */
  marker?: TileArtworkMarker;
  /** Design note #737: indices into `tracks` that DO NOT touch `marker` -- a bypass.
   *
   *  DECLARED, NOT DERIVED. Whether a bezier passes through the marker's point is answerable by sampling the
   *  curve, and that answer would be a tolerance argument on every tile in the catalog forever. One hex in
   *  1830 has a bypass; naming it is honest and checkable, and a wrong entry is visible in a diff.
   *
   *  A HEX WITH NO MARKER NEEDS NO ENTRY: nothing to bypass. */
  bypassTracks?: readonly number[];
}

/* ==================================================================
 *  DESIGN NOTE 895: THE RED AREAS HAD NO RAILS TO COLOUR
 * ==================================================================
 *
 * REPORTED: the red off-board segments are not coloured when a route runs onto them.
 *
 * AND THE OVERLAY WAS RIGHT TO DRAW NOTHING, which is why this is a data fix rather than a drawing one.
 * `drawRouteOverlays` strokes a preprinted hex by looking up its authored rails; every off-board hex returned
 * nothing:
 *
 *   printedArtworkEdgePairs("F2")  ->  []     (and A9, A11, I1, J2, K13, B24 alike)
 *
 * The red areas were drawn by `drawOffboardTrack`, which strokes straight onto the canvas from
 * `OFFBOARD_TRACKS` and authors no `Path2D` anybody else can find. So the base board showed track and the
 * route overlay had no geometry to trace over it. Two surfaces answering one question two ways -- this
 * codebase's second-commonest bug shape, and here the second surface was answering "there is no track".
 *
 * GENERATED FROM `OFFBOARD_TRACKS` RATHER THAN TYPED OUT. The edge list is already authoritative and already
 * verified against the real board; retyping seven hexes' stubs into this catalog would create a second list to
 * keep in step, which is the very thing being fixed. A hex added to `OFFBOARD_TRACKS` gets its colourable rail
 * for free.
 *
 * THE SHAFT, NOT THE ARROWHEAD. An off-board stub is drawn as a shaft plus a filled arrowhead, and only the
 * shaft is a stroked line. The generated rail is exactly the shaft, so the colour lands ON the drawn track
 * rather than beside it or past it, and the black arrowhead survives as what it is -- the marker that says
 * "the board ends here". `drawOffboardTrack` now derives its own shaft from these same two fractions, so the
 * pair cannot drift.
 *
 * NO MARKER, DELIBERATELY. An off-board area's revenue comes from its era table rather than from a circle on
 * the hex, and `traversalSegments` refuses to cross one before it ever consults this catalog (#484). These
 * entries exist to be DRAWN and are inert to routing. */

/** How far in from the edge the off-board arrow points, as a fraction of the edge-to-centre distance. */
export const OFFBOARD_STUB_TIP_FRACTION = 0.52;
/** Where the shaft stops and the arrowhead begins, in the same fraction. `TIP_FRACTION` plus the head's own
 *  length divided by the apothem -- precomputed because this file has no geometry imports and must not grow
 *  any: it is the one leaf in the rendering chain and everything else depends on it staying that way. */
export const OFFBOARD_STUB_SHAFT_END_FRACTION = 0.7509401;

/** The six edge midpoints in the unit-hex space this catalog is authored in. */
const UNIT_EDGE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0.866025, 0],
  [0.433013, -0.75],
  [-0.433013, -0.75],
  [-0.866025, 0],
  [-0.433013, 0.75],
  [0.433013, 0.75],
];

const round = (n: number) => Number(n.toFixed(6));

const OFFBOARD_STUB_ARTWORK: Readonly<Record<string, PrintedArtwork>> = Object.fromEntries(
  Object.entries(OFFBOARD_TRACKS).map(([label, edges]) => [
    label,
    {
      tracks: edges.map((edge) => {
        const [x, y] = UNIT_EDGE_POINTS[edge];
        const f = OFFBOARD_STUB_SHAFT_END_FRACTION;
        return `M ${round(x)} ${round(y)} L ${round(x * f)} ${round(y * f)}`;
      }),
    },
  ]),
);

/** Every entry's edge set matches hexBoardData's own table for that label, and every marker sits on its own track's apex -- the same three rules the tile catalog's markers follow.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #210 */
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
  /* ==================================================================
   *  DESIGN NOTE 737: ALTOONA'S BYPASS IS DRAWN AND UNREACHABLE
   * ==================================================================
   *
   * REPORTED: "The preprinted gray on Altoona (H12) has unusual track curvature ... (a) I don't think this
   * preprinted gray ever got updated to the canonical art version ... (b) it does not seem to be functional
   * for actual routing: there seems to be no way to get a train to use the bypass around Altoona's measly $10
   * revenue center."
   *
   * (b) IS CONFIRMED BY MEASUREMENT, not by reading. Probed against the shipped engine:
   *
   *   printedArtworkEdgePairs("H12")            -> [[0,3],[0,3]]     two tracks, same two edges
   *   printedPathsForTraversal("H12", 0, 3)     -> [0]               only the first is ever offered
   *   traversalSegments(grid, 2, 7, 0, 3)       -> rail #0 only
   *
   * So the bypass exists in the artwork and does not exist to the router. `pathsForTraversal` collapses
   * alternatives to the first match -- deliberately, and #225 says why: "When several paths share an edge the
   * first is taken, and that is not a coin flip: the forking tiles are all plain connectors, and a route only
   * ever ENDS at a revenue centre." That reasoning is sound for every OTHER forking tile and false here,
   * because H12 is the one hex where the two paths differ in what they PAY.
   *
   * AND FIXING THAT ALONE WOULD NOT BE ENOUGH, which is the part worth recording. Revenue is computed by
   * `sandboxRouteBreakdown` from a list of HEX LABELS -- `{ hex, city_node? }` -- and priced with
   * `hexStopValue(mapGrid, stop.hex, era)`. A route's representation has nowhere to say "I crossed H12 without
   * stopping at Altoona", so even a tracer that found the bypass would price it identically to the through
   * route. The bypass is not merely unrouted; it is inexpressible.
   *
   * WHAT A REAL FIX NEEDS, in the order the dependencies fall:
   *   1. `pathsForTraversal` stops collapsing alternatives, and `stubsForTransit` learns that a multi-element
   *      result may be ALTERNATIVES rather than a chain -- it currently reads index 0 as "entry rail" and the
   *      last as "exit rail", which is only true of a chain.
   *   2. `TracedHex` carries which traversal was taken, beside the `city_node` it already carries.
   *   3. `sandboxRouteBreakdown` honours it: a hex crossed by a path that touches no marker pays nothing and
   *      costs no stop.
   *   4. The route tracer branches on the alternatives, and the manual planner offers the choice.
   *
   * #731'S EDGE KEYS ALREADY COVER THE COLLISION HALF, which is worth noting because it is the one piece that
   * needs no work: both H12 paths cross edges 0 and 3, so two trains cannot take one each -- correctly, since
   * on cardboard they share the same two stubs of track at the hex border.
   *
   * (a) IS SEPARATE AND NOT FIXED HERE. The curve below is this project's approximation, not the canonical
   * artwork, and replacing it needs the real geometry rather than a guess -- the last time a plausible-looking
   * substitution was made from memory in this codebase (#724's slot claim) it was wrong. The two tracks and
   * their edge pairs are right; what is unverified is the SHAPE of the bow.
   *
   * See docs/ai_architecture/hex_tile_math.md, TileGraphics.ts #737. */
  H12: {
    tracks: [
      "M 0.866025 0 L -0.866025 0",
      "M 0.866025 0 C 0.433013 -0.55 -0.433013 -0.55 -0.866025 0",
    ],
    marker: { kind: "city", at: { x: 0, y: 0 } },
    /* Design note #737: track 1 is the bow. It leaves edge 0 and rejoins edge 3 without ever reaching the
       centre, where the station sits -- which is the whole reason Altoona has it. Track 0 runs straight
       through (0, 0) and stops. */
    bypassTracks: [1],
  },
  /** Rochester -- straight 0-3 through the city, with a curved spur in from
   *  edge 4. The spur enters its edge on the normal and eases into the
   *  station rather than meeting the main line as a straight radial spoke. */
  /* ==================================================================
   *  DESIGN NOTE 894: ROCHESTER IS THREE SPOKES, NOT A LINE PLUS A STUB
   * ==================================================================
   *
   * REPORTED: the route marker cuts off at D14.
   *
   * IT WAS NOT A DRAWING BUG. `traversalsFrom` at D14 returned 0<->3 AND NOTHING ELSE -- a train arriving on
   * edge 4 had no way out of Rochester and no way in, so the whole third arm of the hex was unroutable:
   *
   *   printedArtworkEdgePairs("D14")        -> [[0,3],[4,null]]
   *   traversalsFrom(grid, 5, 3, 4)         -> []
   *
   * AND THE CAUSE IS IN `pathVariantsForTraversal`, which joins two rails through the interior only when BOTH
   * are SPOKES -- "exactly one end on an edge". The straight rail had both ends on edges, so it was never a
   * spoke, so the edge-4 spoke had nothing to meet. The hub test was right; the artwork was lying to it.
   *
   * WHAT THE BOARD ACTUALLY SHOWS is a city with three rails running into it. The old first entry drew ONE
   * line straight across, passing through the marker's point without ever declaring that it touches the
   * marker -- a shape indistinguishable from Rochester on screen and a different hex to the router. Split at
   * the city, the two halves are collinear and share the endpoint, so the render is pixel-identical and the
   * join falls out of the rule that was already there.
   *
   * THIS IS WHY THE #244 CUT LOOKED RIGHT TOO: a train terminating at D14 traced the whole straight rail and
   * was trimmed back to the marker at draw time. Now the rail it traces ENDS at the marker, so the trim has
   * nothing left to do -- the same picture, arrived at honestly.
   *
   * NO OTHER PREPRINTED HEX HAS THIS SHAPE. Every other entry is either a single edge-to-edge rail with its
   * marker sitting beside the track, or spokes that already meet -- checked across the whole catalog rather
   * than assumed, which is what `printedArtworkEdgePairs` makes cheap to do. */
  D14: {
    tracks: [
      "M 0.866025 0 L 0 0",
      "M -0.866025 0 L 0 0",
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

  /* ---- Red off-board areas (`OFFBOARD_TRACKS`) -- design note #895 ---- */
  ...OFFBOARD_STUB_ARTWORK,
};

/** New York needs its own entry because the hex carries TWO stations and the singular marker field cannot express that. Same shape as #59: two terminal spurs that never meet, each capped by its own station.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #229 */
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

/* The DATA split was right and every LOOKUP over it was silently wrong: G19 was missed, so a train stopping at New York resolved no path at all and the busiest hex on the board highlighted NOTHING. printedTracksFor is the single place that knows about the exception.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #229 */
function printedTracksFor(label: string): readonly string[] | undefined {
  if (label === "G19") return NEW_YORK_PRINTED_ARTWORK.tracks;
  return PRINTED_GRAPHICS_CATALOG[label]?.tracks;
}

/** The MARKER half of the same exception -- a caller wanting "the markers on this hex" should not have to know about the split. Empty for a bare connector hex, which prints track and no station.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #229 */
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

/** NOT 2 (exactly-tangent circles): real cardboard overlaps slightly, and at a full 2 the pill on #63 grows long enough to reach its own track arms. Shared by the function that draws and the one that places -- different constants means tokens drift off their own rings.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #151 */
export const PILL_SLOT_SPACING = 1.6;

/** A station marker's radius as a fraction of the (possibly shrunk) marker
 *  size. Matches `drawStationCircle`/`drawStationTokenMarker`'s own `0.22`,
 *  which is the figure the whole board's city circles are drawn at. */
export const STATION_RADIUS_RATIO = 0.22;

/** Extracted from a bare literal so the token that drops in reads the same number as the circle it drops into.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #151 */
export const SLOT_RING_RATIO = 0.86;

/* Design note #699: TOKEN_DOCK_INSET (0.84) DELETED. It existed so the station circle survived as a thin
   collar around a docked token, which #487 argued for. REPORTED since: "I find the collar distracting: the
   station tokens already have a colour and font, and adding a third border/colour around them makes it busy.
   Rather than having the collar peek out, let's give the tokens that much space to be larger, to fill the
   slot."
   A token now fills its ring exactly. That does NOT leave it edgeless -- the token draws its own outline in
   `STATION_TOKEN_RING`, landing where the circle's outline was. Removing the inset stops drawing two edges,
   it does not stop drawing one. */

/** The marker size a tile's artwork is drawn at, and therefore the size any token docking into it must read.
 *
 *  Design note #699: THE SHRINK IS ABOUT PILLS, NOT ABOUT MARKER COUNT.
 *
 *  REPORTED: "I understand why station tokens need to shrink a little when placing on a dual-station city. But
 *  I noticed the NNH shrinks on the green upgrade to G19 even though that is still a single-station city. It
 *  is almost difficult to read that it is NNH's token at the size it has shrunk to."
 *
 *  Exactly right. The old rule was `markers.length > 1`, and tile #54 -- New York's green -- is TWO ONE-SLOT
 *  CITIES. Both shrank for having company on the TILE rather than company in the CITY. Stacked with the ring
 *  ratio and the dock inset it took NNH from 0.220 of the hex to 0.135: 39% of its radius and 63% of its area,
 *  on an upgrade that shared nothing.
 *
 *  AND IT RAN BACKWARDS. Tile #63 is a genuine 2-slot city carrying ONE marker, so it escaped the shrink and
 *  drew a LARGER token (0.159) than #54's unshared one. The rule was not merely imprecise, it was
 *  anti-correlated with what a player reads it as meaning.
 *
 *  The shrink's real job is keeping two PILLS from crowding, which is #62 and only #62. Plain circles never
 *  needed it: across the whole catalog the tightest pair of one-slot cities (#66) still clears by 0.06
 *  unit-hex at full size, and #54's clears by 0.43.
 *
 *  EXPORTED, and taking markers rather than a `TileArtwork`, because this rule had been written out THREE more
 *  times as literals -- `hexCanvasPrimitives` restates it for the catalog pass, again as a bare `size * 0.85`
 *  for New York's printed hex, and a FOURTH figure (`size * 0.75`) for the preprinted OO hexes -- while the
 *  tokens read a fifth. Four statements of one idea, none of them agreeing. */
export function markerSizeFor(markers: readonly TileArtworkMarker[], size: number): number {
  if (markers.length <= 1) return size;
  return markers.some((marker) => (marker.slots ?? 1) > 1) ? size * 0.85 : size;
}

/** The radius a station token is drawn at, given the artwork it lands in.
 *
 *  Design note #699: ONE FUNCTION, because the alternative is what was here -- a docked radius on laid tiles,
 *  a legacy `size * 0.22` on preprinted ones, and no relationship between the two. That gap is the second half
 *  of the same report: "B&O's second station has a border around it that B&O's home station does not. Is this
 *  a style for all non-home station markers? If so I would say all station markers need to be identical."
 *
 *  IT IS NOT A HOME STYLE. Nothing in the renderer knows which token is a home. B&O's home sits on PREPRINTED
 *  Baltimore, which had no docking radius and fell back to `size * 0.22` -- exactly its circle's radius, so it
 *  painted the circle out. Its second token sits on a LAID tile, docked and inset, leaving the circle showing
 *  as a ring. One primitive, two radii, chosen by whether a tile happened to be laid there.
 *
 *  `SLOT_RING_RATIO` belongs to a PILL and only a pill: `drawStationPill` draws an inner ring per slot for a
 *  token to sit in, and `drawStationCircle` draws no such ring. Insetting a lone circle's token from a ring
 *  that is not there was the second over-shrink stacked on the first. */
export function stationTokenRadius(
  markers: readonly TileArtworkMarker[],
  cityIndex: number,
  size: number,
): number | undefined {
  const city = markers.filter((marker) => marker.kind === "city")[cityIndex];
  if (!city) return undefined;
  const radius = markerSizeFor(markers, size) * STATION_RADIUS_RATIO;
  return (city.slots ?? 1) > 1 ? radius * SLOT_RING_RATIO : radius;
}

/** The hardcoded hex-relative radius made a token ~18% wider than the ring it was supposedly sitting in, overflowing the pill on every OO tile -- which is the "centring across the entire pill" symptom. The position was already right; only the size was not.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #151 */
export function tileCityTokenRadius(
  tileId: number,
  size: number,
  /* Design note #699: WHICH city. Defaulted rather than required, so a caller with only one answer keeps
     working -- but a tile can carry a shared city beside an unshared one, and those take different radii.
     Answering per-TILE was a rounding of the question. */
  cityIndex = 0,
): number | undefined {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return undefined;
  return stationTokenRadius(art.markers, cityIndex, size);
}

/** `Path2D` is immutable once built and the catalog never changes, so each
 *  tile's paths are parsed from their `d` strings exactly once per session
 *  rather than on every frame of every hex. */
const PATH_CACHE = new Map<number, readonly Path2D[]>();

/* Derivable rather than stored: every authored path begins and ends on an edge midpoint, so reading the first and last coordinate pair out of the `d` string recovers the pair exactly -- no second table to keep in sync, which is the failure mode a hand-written mapping would have.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #154 */
const EDGE_PAIR_CACHE = new Map<number, readonly (readonly [number | null, number | null] | null)[]>();

/** Recomputed rather than imported to keep this module free of a dependency on the canvas geometry helpers; the two are asserted equal by the overlay harness.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #154 */
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

/** THE null IS LOAD-BEARING. A multi-spoke hub authors N separate spokes running edge -> centre, so half of every such path legitimately has no edge -- collapsing them threw away exactly what is needed to trace a route THROUGH a hub, which is where routes actually stop.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #154 */
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

/** Two shapes because the catalog authors two: a through-tile returns its one path; a HUB returns the TWO spokes the train uses, so stroking both traces edge -> city -> edge. Order-insensitive -- a train may run either way along one rail.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #154 */
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

/* TWO SPOKES ARE ONLY A ROUTE IF THEY MEET. Applied blindly the hub rule also fires on terminal SPURS, whose edge pairs look identical from outside -- so a route chained through New York lit both disconnected stubs. The join now requires the interior endpoints to coincide, compared in base space (a rigid rotation preserves coincidence).
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #217 */
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

/** Shared body: tiles pass their orientation, a preprinted hex passes 0, because the board's printed track has one fixed facing and stores absolute edge numbers.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #215 */
/** Every DISTINCT way through the hex from `entryEdge` to `exitEdge`, each as a chain of rail indices.
 *
 *  Design note #737: `pathsForTraversal` below returns the FIRST way and #225 explains why that was right --
 *  "the forking tiles are all plain connectors, and a route only ever ENDS at a revenue centre". True of every
 *  tile but H12, where the two ways differ in what they PAY. So the collapse stays the default and this is the
 *  function that sees alternatives; nothing that does not care about revenue has to change.
 *
 *  ORDERED, and the order is the authored one: variant 0 is whatever `pathsForTraversal` would have returned,
 *  so a caller that takes the first is unchanged. */
function pathVariantsForTraversal(
  pairs: readonly (readonly [number | null, number | null] | null)[],
  interior: readonly ({ x: number; y: number } | null)[],
  rot: number,
  entryEdge: number,
  exitEdge: number,
): number[][] {
  const rotate = (edge: number | null) => (edge === null ? null : (edge + rot) % 6);
  const variants: number[][] = [];

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (!pair) continue;
    const a = rotate(pair[0]);
    const b = rotate(pair[1]);
    if (a === null || b === null) continue;
    if ((a === entryEdge && b === exitEdge) || (a === exitEdge && b === entryEdge)) {
      variants.push([index]);
    }
  }

  /* THE SPOKE-PAIR CASE IS NOT ENUMERATED, deliberately. A hub joins one entry spoke to one exit spoke and
     `pathsForTraversal` picks the first of each; there is no 1830 hex where two DIFFERENT spoke pairings join
     the same two edges with different revenue, so enumerating them would invent choices a player cannot use.
     Falling through to the single answer keeps hubs exactly as they were. */
  if (variants.length === 0) {
    const single = pathsForTraversal(pairs, interior, rot, entryEdge, exitEdge);
    if (single.length > 0) variants.push(single);
  }
  return variants;
}

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

/* Preprinted hexes had no per-rail traversal, so the overlay traced a gray hex's rails WHOLESALE -- correct in shape, and on a branching hex it lit track the train does not use. The matching logic is identical, so it is shared.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #215 */
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
/** Design note #737: every way through preprinted hex `label`, not just the first. */
export function printedTraversalVariants(
  label: string,
  entryEdge: number,
  exitEdge: number,
): number[][] {
  return pathVariantsForTraversal(
    printedArtworkEdgePairs(label),
    interiorEndsForPrinted(label),
    0,
    entryEdge,
    exitEdge,
  );
}

/** Whether rail chain `chain` on preprinted hex `label` avoids the printed revenue centre.
 *
 *  Design note #737: A CHAIN IS A BYPASS ONLY IF EVERY RAIL IN IT IS. A hub crossing that used one bypass
 *  spoke and one ordinary spoke would still reach the station, so "some" would be the wrong quantifier -- and
 *  the case does not arise today only because no hex has both. */
export function printedChainBypassesCentre(label: string, chain: readonly number[]): boolean {
  const art = printedArtwork(label);
  if (!art?.marker) return false;
  const bypass = art.bypassTracks ?? [];
  if (bypass.length === 0 || chain.length === 0) return false;
  return chain.every((index) => bypass.includes(index));
}

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

/* A route's ENDPOINT has only one edge -- the train arrives and stops. Tracing every rail lit both of New York's disconnected spurs, claiming a run to a city never reached. When several paths share an edge the first is taken, and that is not a coin flip: the forking tiles are all plain connectors, and a route only ever ENDS at a revenue centre.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #225 */
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

/* A TRAIN STOPS AT THE STATION, NOT PAST IT. Path2D cannot be partially stroked, so the cut happens on the `d` string before the path is built. SPLITTING IS EXACT: one segment per path, so a line interpolates and a cubic splits by de Casteljau. Only WHERE the marker sits is sampled, and a pixel along a curve already being traced is invisible.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #244 */

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

/* THE RAIL STOPS AT THE STATION WALL, NOT ITS CENTRE. The glow LEAKED -- a shadow blooms outward from its source, and the clip removes the stroke inside the hole, not the glow it casts getting there. And a PILL IS NOT A CIRCLE. Distance is measured to the marker's SPINE, which is what makes one formula cover both shapes with no branch and no second radius.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #277 */

/** Unit-space station geometry mirroring the two drawing functions. These MUST track them: smaller leaves a sliver of route colour inside the station, larger leaves a gap between the rail and the circle it should touch.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #277 */
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
    /* Only that the marker is ON this rail. #244 also skipped markers at t=0 or t=1 -- true of a CENTRE cut and false of a perimeter one, and it exempted the largest group of city tiles, since every hub's marker is at t=1 by construction.
       See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #277 */
    if (parameterNearest(segment, marker.at) === null) continue;

    /* Sampling rather than solving: the crossing of a cubic with a capsule has no clean closed form, the curve is short, and 256 steps resolve to well under a screen pixel at any zoom.
       See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #277 */
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

    /* No contact means the marker is near but not on this rail -- leave it whole. A cut at the very end being kept would emit a zero-length path, which round line caps render as a dot floating on the station.
       See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #277 */
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

/** THE single source of truth for city position on a laid tile, and what stationMarkerPoint must consult: the artwork's circle is per-tile, not the fixed diagonal twoNodePositions returns.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #133 */
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

/** MUST stay equal to hexmap::tile_city_slot_counts -- that is the authority, this is the mirror. Separate because the renderer needs the count before any chain round-trip; a drift shows as a pill with more or fewer rings than the contract will let companies fill.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #134 */
export function tileCitySlotCounts(tileId: number): number[] {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!art) return [];
  return art.markers.filter((m) => m.kind === "city").map((m) => m.slots ?? 1);
}

/** One point per slot at the SAME spacing the pill places its cap circles, from the shared constant. Returns [] for an unknown tile or out-of-range index, NEVER a guessed point.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #134 */
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

  // Marker size matches the artwork renderer's own multi-marker shrink, shared through one helper rather than restated -- slot POSITIONS and token SIZE are the same measurement of the same circle.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #151
  const markerSize = markerSizeFor(art.markers, size);
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
