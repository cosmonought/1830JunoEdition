// frontend/src/components/hexBoardData.ts
//
// PHASE 2 of the HexGridRenderer monolith split: the 1830 board itself, as
// data -- every hex and its terrain, the landmarks and their printed track,
// gray hexes, off-board terminals and era tiers, impassable borders, OO hexes,
// palettes, terrain fees, and the small pure lookups over them.
//
// Extracted second because it is the next leaf up: it depends on exactly one
// thing outside itself. Leaf-first extraction is what kept every step free of
// circular imports.
//
// SOURCING. Almost every table was verbatim-sourced from tobymao/18xx's
// g_1830/map.rb and cross-checked against the Rust constants. The comments
// travel WITH the data deliberately: a coordinate table with no provenance is
// unauditable, and several entries exist because an earlier pass got them wrong.
//
// IMPORT DIRECTION IS ONE-WAY. See docs/ai_architecture/hex_tile_math.md

import type { TileColorTier } from "./hexTileCatalog";
// TYPE-ONLY, erased at runtime, so the one-way import direction (TileGraphics -> hexBoardData) holds.
import type { PrintedArtwork } from "./TileGraphics";

// The three landmarks at their VERIFIED real coordinates; the backend was later aligned to these. displayName is a cosmetic nameplate override only -- name stays structural, so it does not ripple into the lookups keyed on it.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #78
export interface LandmarkHex { name: string; displayName?: string; q: number; r: number; label: string }

const STANDARD_LANDMARK_HEXES: ReadonlyArray<LandmarkHex> = [
  { name: "New York", displayName: "New York & Newark", q: 6, r: 6, label: "G19" },
  { name: "Boston", q: 9, r: 4, label: "E23" },
  { name: "Baltimore", q: 3, r: 8, label: "I15" },
];

/** Each landmark's authentic printed track, translated by the verified reflection formula. REVERTED from a claimed IDENTITY mapping that put New York's stub on "G21", a hex that does not exist -- the same red flag that caught the ORIGINAL bug. Reflection is its own inverse, so re-applying it recovers the verified values exactly.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #29 */
const STANDARD_LANDMARK_TRACKS: Readonly<Record<string, ReadonlyArray<{ edges: readonly number[] }>>> = {
  "New York": [{ edges: [1] }, { edges: [4] }],
  Boston: [{ edges: [1, 5] }],
  Baltimore: [{ edges: [0, 4] }],
};

/** Tile fill is per-ERA, not per-terrain: keyed on terrain, tiles of one era painted different colours because of what was printed on them, and #57 sits on nearly every city hex. Real cardboard is one stock colour per era. #152 separated the tiers on hue AND lightness; #161 specifies the canonical palette. Green and Brown sit at 1.47:1 luminance and are separated almost entirely by hue -- recorded because no decision here depends on telling them apart by eye.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #161 */
export const ERA_TILE_FILL: Readonly<Record<TileColorTier, string>> = {
  // Unified with `PRINTED_HEX_FILL.Yellow` below -- see its own note. A
  // preprinted yellow hex and a laid yellow tile are the same tier and must
  // be the same colour; they were `#e8d488` and `#f0d9a0`, which read as two
  // different kinds of yellow sitting next to each other.
  Yellow: "#FDE900",
  Green: "#71BF44",
  Brown: "#CB7745",
  /* #1312: a LAID gray tile, kept a step lighter and cooler than `PRINTED_HEX_FILL.Gray` (#8a8f94) so a
     player can still tell a permanent preprint from a tile that was laid this game. */
  Gray: "#A9AEB4",
};

/* One named track ink. #153 split it per tier when Brown was dark enough that near-black measured ~1.6:1; #161's lighter canonical Brown made dark ink correct on all three again. THE TABLE STAYS even though the values agree -- it is what makes "ink is a function of the tier" structural, and it caught the problem the last time a fill moved.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #473 */
export const STANDARD_TRACK_INK = "#1a1a1a";

export const TILE_TRACK_INK: Readonly<Record<TileColorTier, string>> = {
  // 13.9:1 on Yellow, 7.7:1 on Green, 5.2:1 on Brown -- comfortably past the 3:1 a thick graphical line needs.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #161
  Yellow: STANDARD_TRACK_INK,
  Green: STANDARD_TRACK_INK,
  Brown: STANDARD_TRACK_INK,
  Gray: STANDARD_TRACK_INK, // 9.6:1 on #A9AEB4
};

/** The track ink for a tile whose tier is unknown -- an id missing from the
 *  catalog mirror. Matches the historic default, so every existing
 *  non-tile track call (preprinted gray hexes, landmark stubs, off-board
 *  stubs) is byte-identical to before. */
export const DEFAULT_TRACK_INK = "#2b2b2b";

/* TERRAIN_FILL deleted: it mapped each terrain to its own tile background and was the direct cause of the reported colour drift. Unlaid BOARD hexes were never its business.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #122 */


/** Each rim is a darkened form of its OWN fill, so the edge bounds the tile rather than reading as a separate colour laid over it -- tuned against the fill because neighbouring hexes are themselves tiles far more often than empty board.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #161 */
export const COLOR_TIER_STROKE: Readonly<Record<TileColorTier, string>> = {
  Yellow: "#7a6a00",
  Green: "#2f5e1a",
  Brown: "#5c2f13",
  Gray: "#4a4e52", // the same rim the preprinted gray hex uses: a gray tile is the board's own colour, darkened
};

/* ------------------------------------------------------------------ */
/* Static board background -- see design note #6                      */
/* ------------------------------------------------------------------ */

export type BoardHexType = "Plain" | "Mountain" | "River" | "RedOffboard";

export interface BoardHex {
  /** The hex's real 1830 board coordinate label (e.g. `"G19"`) -- included
   *  purely so this array can be independently cross-checked against the
   *  sources cited in design note #6. Not used for rendering. */
  label: string;
  q: number;
  r: number;
  type: BoardHexType;
  /** printedColor overrides the fill WITHOUT changing type, so a hex can be both a pre-printed yellow city AND a River with its icon and cost label -- both are true on the real board simultaneously.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #12 */
  printedColor?: PrintedHexColor;
  /** Blank WHITE hexes carrying a preprinted town designation, verbatim-sourced. Distinct from the gray hexes' town markers, which have FIXED starting track. Kept in lockstep with the backend's own list.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #12 */
  townDesignation?: "single" | "double";
  /** Blank white hexes with a preprinted single-city marker, independently re-derived three times against the raw source. Deliberately NOT gray entries: the source has no path data for any of them, so this draws a marker and no track. Two of the request's own specifics were not applied -- B16 is Ottawa, F24 is Mansfield.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #35 */
  cityDesignation?: boolean;
  /** Design note #1300: a printed build cost that is not the terrain's standard one (1830+'s K7 mountain at $80). */
  feeOverride?: number;
  /** Design note #1301: THE BOARD SHIPS WITH THIS CATALOG TILE PRINTED ON THE HEX, upgradeable like a laid
   *  one (1830+'s green #24 at H12). Realised as a `MapTileEntry` flagged `printed` in the game's INITIAL
   *  grid (`initialGridFor`), so legality, routing, drawing and slot counts all see an ordinary tile and
   *  only the tray (`tileSupply`) has to know it never came out of the tray. Distinct from `printedColor`,
   *  which is a fixed preprint (gray) or a landmark's own yellow. */
  printedTile?: { tileId: number; orientation: number };
  /** Design note #1302: A CORPORATION'S HERALD PRINTED ON A HEX THAT IS NOT A CITY (1830+'s PRR at H12).
   *  For that corporation alone it is a home station: a route may start there, a network grows from it, a
   *  route through it may count it for `revenue` (or not -- the owner chooses), and no home token is ever
   *  placed for it. For everyone else the hex is whatever its tile says. It consumes no station token. */
  herald?: { companyId: number; revenue: number };
  /** Design note #1320: A RED AREA THAT IS A TOWN. The Level Playing Field turns five red off-board areas into
   *  "warehouses": still red, still paying the printed off-board figure, but every stub meets at a small town
   *  in the centre and a route runs THROUGH rather than ending there. The hex keeps `type: "RedOffboard"` so
   *  it stays unbuildable and keeps its nameplate and value badge; this flag is what `isOffboardTerminal` and
   *  `isRouteTerminusHex` read to stop treating it as a terminus. The hex also carries a `grayHexes` entry
   *  (marker `"town"`) and printed artwork, which is what makes it classify, route and draw as a town. */
  warehouse?: boolean;
  /** Design note #1320: A PRINTED VALUE THAT RISES WITH THE ERA on a hex that is not a red area (Coal River,
   *  L8: $40 Yellow, $60 Brown). Read by `hexValueForEra` ahead of the flat `startValueOverride`. */
  revenueTiers?: OffboardRevenueTiers;
}

/** The fixed preprint colours. `Gray` is cardstock, `Yellow` a landmark's own tile, `Coal` the Level
 *  Playing Field's Coal River hex (#1320). */
export type PrintedHexColor = "Gray" | "Yellow" | "Coal";

/** All 93 real hexes listed explicitly rather than generated per-row: the board's outline is genuinely non-convex, and row A simply has no A13 or A15.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #6 */
const STANDARD_HEXES: readonly BoardHex[] = [
  // Row A
  { label: "A9", q: 4, r: 0, type: "RedOffboard" }, // Canadian West
  { label: "A11", q: 5, r: 0, type: "RedOffboard" }, // Canadian West
  // A13/A15 are the real board's own gap (row A has no hex at columns 13/15
  // -- see design note #18) -- deliberately absent, not filled with any
  // decorative hex; that gap renders as the plain charcoal workspace
  // background, same as everywhere else outside the authentic 93-hex
  // footprint.
  { label: "A17", q: 8, r: 0, type: "Plain", printedColor: "Gray" }, // pure connector, no city
  { label: "A19", q: 9, r: 0, type: "Plain", printedColor: "Gray" }, // Montreal
  // Row B
  { label: "B10", q: 4, r: 1, type: "Plain", cityDesignation: true }, // Barrie
  { label: "B12", q: 5, r: 1, type: "Plain" },
  { label: "B14", q: 6, r: 1, type: "Plain" },
  // Ottawa -- NOT "Barrington" (see design note #34: verified three times
  // independently against the real sourced HEXES data, which names this
  // hex Ottawa; "Barrington" doesn't match any name in the source).
  { label: "B16", q: 7, r: 1, type: "Plain", cityDesignation: true },
  { label: "B18", q: 8, r: 1, type: "River" },
  { label: "B20", q: 9, r: 1, type: "Plain", townDesignation: "single" }, // Burlington
  { label: "B22", q: 10, r: 1, type: "Plain" },
  { label: "B24", q: 11, r: 1, type: "RedOffboard" }, // Maritime Provinces
  // Row C
  { label: "C7", q: 2, r: 2, type: "Plain" },
  { label: "C9", q: 3, r: 2, type: "Plain" },
  { label: "C11", q: 4, r: 2, type: "Plain" },
  { label: "C13", q: 5, r: 2, type: "Plain" },
  { label: "C15", q: 6, r: 2, type: "Plain", printedColor: "Gray" }, // Kingston
  { label: "C17", q: 7, r: 2, type: "Mountain" },
  { label: "C19", q: 8, r: 2, type: "River" },
  { label: "C21", q: 9, r: 2, type: "Mountain" },
  { label: "C23", q: 10, r: 2, type: "Plain" },
  // Row D
  { label: "D2", q: -1, r: 3, type: "Plain", printedColor: "Gray" }, // Lansing
  { label: "D4", q: 0, r: 3, type: "Plain", townDesignation: "single" }, // Flint
  { label: "D6", q: 1, r: 3, type: "River" },
  { label: "D8", q: 2, r: 3, type: "Plain" },
  { label: "D10", q: 3, r: 3, type: "River", printedColor: "Yellow" }, // Hamilton & Toronto (OO)
  { label: "D12", q: 4, r: 3, type: "Plain" },
  { label: "D14", q: 5, r: 3, type: "Plain", printedColor: "Gray" }, // Rochester
  { label: "D16", q: 6, r: 3, type: "Plain" },
  { label: "D18", q: 7, r: 3, type: "Plain" },
  { label: "D20", q: 8, r: 3, type: "Plain" },
  { label: "D22", q: 9, r: 3, type: "Mountain" },
  { label: "D24", q: 10, r: 3, type: "Plain", printedColor: "Gray" }, // pure connector, no city
  // Row E
  { label: "E3", q: -1, r: 4, type: "Plain" },
  { label: "E5", q: 0, r: 4, type: "River", printedColor: "Yellow" }, // Detroit & Windsor (OO)
  { label: "E7", q: 1, r: 4, type: "Plain", townDesignation: "single" }, // London
  { label: "E9", q: 2, r: 4, type: "Plain", printedColor: "Gray" }, // pure connector, no city
  { label: "E11", q: 3, r: 4, type: "Plain", printedColor: "Yellow" }, // Dunkirk & Buffalo (OO)
  { label: "E13", q: 4, r: 4, type: "Plain" },
  { label: "E15", q: 5, r: 4, type: "Plain" },
  { label: "E17", q: 6, r: 4, type: "Mountain" },
  { label: "E19", q: 7, r: 4, type: "Plain", cityDesignation: true }, // Albany -- a real, blank ($0) printed city (see NAMED_HEX_LABELS/HEX_START_VALUE_OVERRIDE); IS NYC's home as of design note #44's house rule (NYC/Albany, NNH now G19 -- see STATION_HOME_HEXES)
  { label: "E21", q: 8, r: 4, type: "Mountain" },
  { label: "E23", q: 9, r: 4, type: "Plain", printedColor: "Yellow" }, // Boston -- see LANDMARK_HEXES
  // Row F
  { label: "F2", q: -2, r: 5, type: "RedOffboard" }, // Chicago
  { label: "F4", q: -1, r: 5, type: "River", cityDesignation: true }, // Toledo
  { label: "F6", q: 0, r: 5, type: "Plain", printedColor: "Gray" }, // Cleveland
  { label: "F8", q: 1, r: 5, type: "Plain" },
  { label: "F10", q: 2, r: 5, type: "Plain", townDesignation: "single" }, // Erie
  { label: "F12", q: 3, r: 5, type: "Plain" },
  { label: "F14", q: 4, r: 5, type: "Plain" },
  // Scranton -- a missed city, added as the same blank-hex-plus-terrain pattern Toledo already established, Mountain rather than River.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #123
  { label: "F16", q: 5, r: 5, type: "Mountain", cityDesignation: true }, // Scranton
  { label: "F18", q: 6, r: 5, type: "Plain" },
  { label: "F20", q: 7, r: 5, type: "Plain", townDesignation: "double" }, // New Haven & Hartford
  { label: "F22", q: 8, r: 5, type: "River", cityDesignation: true }, // Providence
  // Mansfield -- kept as-is; NOT renamed to "River Falls" (see design note
  // #34: verified against the real sourced HEXES/LOCATION_NAMES data, which
  // names this hex Mansfield; "River Falls" doesn't match any name in the
  // source, and this exact "Mansfield" name was already independently
  // sourced and confirmed in an earlier pass -- see `GRAY_HEXES`' own F24
  // comment above and `NAMED_HEX_LABELS` below).
  { label: "F24", q: 9, r: 5, type: "Plain", printedColor: "Gray" }, // Mansfield
  // Row G
  { label: "G3", q: -2, r: 6, type: "Plain" },
  { label: "G5", q: -1, r: 6, type: "Plain" },
  { label: "G7", q: 0, r: 6, type: "Plain", townDesignation: "double" }, // Akron & Canton
  { label: "G9", q: 1, r: 6, type: "Plain" },
  { label: "G11", q: 2, r: 6, type: "Plain" },
  { label: "G13", q: 3, r: 6, type: "Mountain" },
  { label: "G15", q: 4, r: 6, type: "Mountain" },
  { label: "G17", q: 5, r: 6, type: "Plain", townDesignation: "double" }, // Reading & Allentown
  { label: "G19", q: 6, r: 6, type: "River", printedColor: "Yellow" }, // New York -- see LANDMARK_HEXES; RECLASSIFIED River by design note #71 (real 1830's own printed G19: `upgrade=cost:80,terrain:water`)
  // Row H
  { label: "H2", q: -3, r: 7, type: "Plain" },
  { label: "H4", q: -2, r: 7, type: "Plain", cityDesignation: true }, // Columbus
  { label: "H6", q: -1, r: 7, type: "Plain" },
  { label: "H8", q: 0, r: 7, type: "Plain" },
  { label: "H10", q: 1, r: 7, type: "Plain", cityDesignation: true }, // Pittsburgh
  { label: "H12", q: 2, r: 7, type: "Plain", printedColor: "Gray" }, // Altoona
  { label: "H14", q: 3, r: 7, type: "Plain" },
  { label: "H16", q: 4, r: 7, type: "Plain", cityDesignation: true }, // Lancaster
  { label: "H18", q: 5, r: 7, type: "Plain", printedColor: "Yellow" }, // Philadelphia & Trenton (OO)
  // Row I
  { label: "I1", q: -4, r: 8, type: "RedOffboard" }, // Gulf
  { label: "I3", q: -3, r: 8, type: "Plain" },
  { label: "I5", q: -2, r: 8, type: "Plain" },
  { label: "I7", q: -1, r: 8, type: "Plain" },
  { label: "I9", q: 0, r: 8, type: "Plain" },
  { label: "I11", q: 1, r: 8, type: "Mountain" },
  { label: "I13", q: 2, r: 8, type: "Plain" },
  { label: "I15", q: 3, r: 8, type: "Plain", printedColor: "Yellow" }, // Baltimore -- see LANDMARK_HEXES
  { label: "I17", q: 4, r: 8, type: "River" },
  { label: "I19", q: 5, r: 8, type: "Plain", printedColor: "Gray" }, // Atlantic City
  // Row J
  { label: "J2", q: -4, r: 9, type: "RedOffboard" }, // Gulf
  { label: "J4", q: -3, r: 9, type: "Plain" },
  { label: "J6", q: -2, r: 9, type: "Plain" },
  { label: "J8", q: -1, r: 9, type: "Plain" },
  { label: "J10", q: 0, r: 9, type: "Mountain" },
  { label: "J12", q: 1, r: 9, type: "Mountain" },
  { label: "J14", q: 2, r: 9, type: "River", cityDesignation: true }, // Washington
  // Row K
  { label: "K13", q: 1, r: 10, type: "RedOffboard" }, // Deep South
  { label: "K15", q: 2, r: 10, type: "Plain", printedColor: "Gray" }, // Richmond
];

/** Each off-board zone spans two hexes sharing one revenue value; labelling both is more honest than picking one arbitrarily to omit.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #6 */
const STANDARD_OFFBOARD_LABELS: Readonly<Record<string, string>> = {
  F2: "Chicago",
  A9: "Canadian West",
  A11: "Canadian West",
  J2: "Gulf",
  I1: "Gulf",
  K13: "Deep South",
  B24: "Maritime Provinces",
};

/** Each off-board hex's pre-printed track stubs -- see design note #10 for
 *  the source and the edge-translation formula/verification. Edge numbers
 *  are this file's own convention (design note #1). */
const STANDARD_OFFBOARD_TRACKS: Readonly<Record<string, readonly number[]>> = {
  F2: [0, 1, 5], // Chicago -- real neighbors F4, E3, G3
  A9: [5], // Canadian West (1/2) -- real neighbor B10
  A11: [4, 5], // Canadian West (2/2) -- real neighbors B10, B12
  I1: [0], // Gulf (1/2) -- real neighbor I3
  J2: [0, 1], // Gulf (2/2) -- real neighbors J4, I3
  K13: [1, 2], // Deep South -- real neighbors J14, J12
  B24: [3, 4], // Maritime Provinces -- real neighbors B22, C23
};

/** Gulf's two hexes read as one merged region: the shared interior edge's stroke is suppressed and one centred nameplate replaces two. Derived from axial adjacency and cross-checked against the tracks table's own real-neighbour comments, which land on the same shared edge from both sides.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #26 */
const GULF_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  I1: 5,
  J2: 2,
};

/** The identical technique for Canadian West. Real off-board hexes carry NO printed path connecting the halves of a zone, so this seam is purely geometric and derived from adjacency rather than from source path data.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #26 */
const CANADIAN_WEST_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  A9: 0,
  A11: 3,
};

/** Each destination's real printed Yellow/Brown revenue; there is no separate Green tier printed on the board. Structured as numeric tiers rather than a formatted string, since era-adaptive rendering needs the numbers.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #11 */
export interface OffboardRevenueTiers {
  yellow: number;
  brown: number;
}

const STANDARD_OFFBOARD_REVENUE: Readonly<Record<string, OffboardRevenueTiers>> = {
  Chicago: { yellow: 40, brown: 70 },
  "Canadian West": { yellow: 30, brown: 50 },
  Gulf: { yellow: 30, brown: 60 },
  "Deep South": { yellow: 30, brown: 40 },
  "Maritime Provinces": { yellow: 20, brown: 30 },
};

/** Yellow keeps applying through Green -- there is no distinct printed Green value -- and Brown takes over once reached.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #15 */
export function offboardValueForEra(tiers: OffboardRevenueTiers, era: TileColorTier): number {
  // #1312: the board prints no Gray value; the Gray era keeps paying the Brown figure.
  return era === "Brown" || era === "Gray" ? tiers.brown : tiers.yellow;
}

/** The real printed terrain costs, now the actual ENFORCED figure: terrain is charged as a HEX property, paid once on first build and free on every later upgrade. That closed both halves of the old exploit. The veil alphas live here for the same reason every other board colour does. #420: 0.22 was a dimming nobody could see -- 22% of near-black over near-black is a few RGB points.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #472 */
export const LAY_TRACK_DIM_ALPHA = 0.55;

/* 0.42 -> 0.55, plus a SECOND, harder veil as its own constant rather than a multiplier: the base answers "where may I build" (a survey, so every legal hex stays comparable), the focus answers "what am I deciding right now". Deliberately not opaque even at 0.82 -- the board must stay visible enough to judge a tile against its neighbours.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #472 */
export const LAY_TRACK_FOCUS_DIM_ALPHA = 0.82;
/* Design note #1092: neutralised with the rest of the app. At 55-82% alpha over the board this is a
   0.8 L* change -- invisible in play -- and taken only so the one veil in the app is not the one place
   still mixing a blue cast into everything beneath it. */
export const LAY_TRACK_DIM_INK = "#080808";
/** The ring on a buildable hex. Green, matching the tile picker's own
 *  confirm affordance (`fabConfirm`), so "you may act here" is one colour
 *  across the board and the ring that appears when you click it. */
export const LAY_TRACK_HIGHLIGHT_INK = "#4ade80";

/* A LEGALITY CUE IS NOT A LIVERY. Deriving the glow from the placing corporation's colour collides with a board that also uses colour by era -- roughly a third of the roster hides the one cue the player needs. White, because "may I click here" has nothing to do with who is asking, and identity is already carried twice over.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #561 */
export const STATION_PLACEMENT_HIGHLIGHT_INK = "#ffffff";

export const RIVER_BUILD_FEE = 80;

/** Real 1830's printed mountain build fee, in.
 *  Mirrors `hexmap::MOUNTAIN_BUILD_FEE` exactly. */
export const MOUNTAIN_BUILD_FEE = 120;

/** A direct mirror of hexmap::terrain_build_fee, BY COORDINATE rather than by rendering category -- keying on a display type meant the two models could disagree about any hex whose category and terrain membership diverged. THE SPEC DOCUMENT IS WRONG: the contract charges 80/120, which is also what the board prints.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #136 */
export function terrainBuildFeeAt(q: number, r: number): number {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (!hex) return 0;
  // Design note #1300: 1830+'s Huntington (K7) is a $80 mountain. The override is a HEX property, like the fee itself.
  if (hex.feeOverride !== undefined) return hex.feeOverride;
  if (hex.type === "River") return RIVER_BUILD_FEE;
  if (hex.type === "Mountain") return MOUNTAIN_BUILD_FEE;
  return 0;
}

export const BOARD_HEX_FILL: Readonly<Record<BoardHexType, string>> = {
  Plain: "#33402f", // muted gray/green empty land
  // Mountain/River now use the SAME land fill as Plain -- see design note
  // #9: both are real BUILDABLE terrain in 1830, communicated by an icon
  // (drawMountainIcon/drawRiverIcon) rather than a solid non-land fill
  // that used to visually read as an impassable obstacle.
  Mountain: "#33402f",
  River: "#33402f",
  RedOffboard: "#7a2020", // red off-board revenue terminal
};

export const BOARD_HEX_STROKE: Readonly<Record<BoardHexType, string>> = {
  Plain: "#5c6a52",
  Mountain: "#5c6a52",
  River: "#5c6a52",
  RedOffboard: "#4a1414",
};

/* ------------------------------------------------------------------ */
/* Pre-printed gray & yellow hexes -- see design note #12              */
/* ------------------------------------------------------------------ */

/** Overrides the ordinary fill/stroke for any hex carrying a printedColor, approximating the real board's gray cardstock and starting yellow tile.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #12 */
export const PRINTED_HEX_FILL: Readonly<Record<PrintedHexColor, string>> = {
  Gray: "#8a8f94",
  // THE SAME VALUE as the Yellow era fill, not a near-match: both paint the same claim and differed only because they were tuned in separate passes. Written as a literal rather than a reference to keep this table import-cycle-free.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #152
  Yellow: "#FDE900",
  // #1320: Coal River. A dark slate, a shade off the cardstock gray so it reads as its own kind of hex.
  Coal: "#4b4f55",
};
export const PRINTED_HEX_STROKE: Readonly<Record<PrintedHexColor, string>> = {
  Gray: "#4a4e52",
  Yellow: "#7a6a00",
  Coal: "#23262a",
};

/** Every entry REVERTED by re-applying the verified reflection formula -- the identity pass put Montreal's stub on "A21", running the track off the board's eastern edge. Two gray hexes have a real "some trains skip this stop" bypass path; only Altoona's is drawn.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #29 */
export interface GrayHexTrack {
  edges: readonly number[];
  marker: "city" | "town" | "none";
  /** Altoona's real bypass, reinstated because it was asked for by name. Rochester has the identical bypass in the source and is deliberately NOT given one -- flagged rather than silently matched.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #29 */
  bypass?: boolean;
  /** Design note #1301: station slots on a gray city that has more than one (1830+'s Montreal and Norfolk).
   *  The printed artwork's marker carries the same figure for the renderer; this is for the rules. */
  slots?: number;
}

const STANDARD_GRAY_HEXES: Readonly<Record<string, GrayHexTrack>> = {
  D2: { edges: [0, 5], marker: "city" }, // Lansing -- was [4, 5]
  F6: { edges: [4, 5], marker: "city" }, // Cleveland -- was [0, 5]
  E9: { edges: [1, 2], marker: "none" }, // pure connector, no city -- was [2, 3]
  H12: { edges: [0, 3], marker: "city", bypass: true }, // Altoona (main line 0/3, real bypass fork reinstated -- see `bypass` doc comment) -- was [1, 4]
  D14: { edges: [0, 3, 4], marker: "city" }, // Rochester -- was [0, 1, 4]
  C15: { edges: [1, 3], marker: "town" }, // Kingston -- {1, 3} is its own reflection, unchanged
  K15: { edges: [2], marker: "city" }, // Richmond (dead-end stub) -- edge 2 is its own reflection, unchanged
  A17: { edges: [4, 5], marker: "none" }, // pure connector, no city -- was [0, 5]
  A19: { edges: [4, 5], marker: "city" }, // Montreal -- was [0, 5]; old edge 0/E pointed at nonexistent "A21"
  I19: { edges: [2, 3], marker: "town" }, // Atlantic City -- was [1, 2]
  F24: { edges: [2, 3], marker: "town" }, // Mansfield -- was [1, 2]
  D24: { edges: [3, 4], marker: "none" }, // pure connector, no city -- was [0, 1]
};

/** A drawing-only mirror of the backend's enforcement table. Unlike the backend, which lists BOTH hexes' edge so it can reject a lay from either side, this only needs to draw the line once. Edge indices independently cross-checked against the backend's identical derivation.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #38 */
export interface ImpassableBorder { q: number; r: number; edge: number; label: string }

const STANDARD_IMPASSABLE_BORDER_EDGES: ReadonlyArray<ImpassableBorder> = [
  { q: 1, r: 4, edge: 5, label: "E7 / F8" },
  { q: 4, r: 3, edge: 2, label: "D12 / C11" },
  { q: 4, r: 3, edge: 1, label: "D12 / C13" },
  { q: 7, r: 2, edge: 2, label: "C17 / B16" },
];

/** Two separately revenue-earning cities on one hex with NO connecting track at all -- verbatim-confirmed that none of the four has a path entry. Players must upgrade past the starting tile to connect them.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #12 */
const STANDARD_YELLOW_OO_HEXES: ReadonlySet<string> = new Set(["E5", "D10", "E11", "H18"]);

/** Display names sourced verbatim; three real hexes have printed track but no city or town and are intentionally absent. F24 is "Fall River" -- a deliberate house-rule cosmetic override, explicitly contrasted in the same request with B16's authentic "Ottawa", unlike an earlier ask framed as factual and correctly declined.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #39 */
const STANDARD_NAMED_HEX_LABELS: Readonly<Record<string, string>> = {
  D2: "Lansing",
  F6: "Cleveland",
  H12: "Altoona",
  D14: "Rochester",
  C15: "Kingston",
  K15: "Richmond",
  A19: "Montreal",
  I19: "Atlantic City",
  F24: "Fall River", // custom override of the real board name "Mansfield" -- see doc comment above
  E5: "Detroit & Windsor",
  D10: "Hamilton & Toronto",
  E11: "Dunkirk & Buffalo",
  H18: "Philadelphia & Trenton",
  E7: "London",
  B20: "Burlington",
  D4: "Flint",
  F10: "Erie",
  G7: "Akron & Canton",
  G17: "Reading & Allentown",
  F20: "New Haven & Hartford",
  F4: "Toledo",
  F22: "Providence",
  H10: "Pittsburgh",
  H4: "Columbus",
  // Reverted to bare "Washington": the longer form extended off the hex, and the fix requested was specifically to drop the suffix rather than relocate the nameplate.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #106
  J14: "Washington",
  H16: "Lancaster",
  B16: "Ottawa",
  B10: "Barrie",
  E19: "Albany",
  F16: "Scranton", // design note #123 -- missed city, added
};

/** Per-hex value overrides, independently re-derived twice against the raw source. Two factual corrections: F6 is Cleveland, not Chicago (an unrelated off-board hex on its own era-tiered system); and the request's "8 city hubs" list named nine, including a Town hex already correctly valued. Altoona is a real $10 CITY -- the value was right, the Town reclassification was not.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #35 */
const STANDARD_HEX_START_VALUE_OVERRIDE: Readonly<Record<string, number>> = {
  G19: 40, // New York
  E23: 30, // Boston
  I15: 30, // Baltimore
  A19: 40, // Montreal
  F6: 30, // Cleveland -- NOT "Chicago" (see doc comment above)
  H12: 10, // Altoona -- real City (NOT a Town), real sourced $10, not the generic $20 -- backend module doc comment #20
  E5: 0, // Detroit & Windsor (OO)
  D10: 0, // Hamilton & Toronto (OO)
  E11: 0, // Dunkirk & Buffalo (OO)
  H18: 0, // Philadelphia & Trenton (OO)
  F4: 0, // Toledo
  F22: 0, // Providence
  H10: 0, // Pittsburgh
  H4: 0, // Columbus
  J14: 0, // Washington
  H16: 0, // Lancaster
  B16: 0, // Ottawa
  B10: 0, // Barrie
  E19: 0, // Albany -- real source string is a bare 'city' entry (re-verified against
  // tobymao/18xx g_1830/map.rb this pass), no `revenue:` figure at all -- same blank-city
  // category as the eight cityDesignation hexes above, not a printed-value city like
  // Cleveland/Boston/Baltimore. See design note #42 for the full Rail Map Overhaul writeup.
  F16: 0, // Scranton -- design note #123, same blank-city ($0) category as the rest above
};

/* ==================================================================
 *  DESIGN NOTE 1300: THE BOARD IS A VALUE, AND ONE BOARD IS IN EFFECT
 * ==================================================================
 *
 * REQUESTED: the 1830+ expansion -- rows L and M, Chattanooga, Norfolk, a green preprint at Altoona -- as a
 * Waiting Room variant. Until now every table above was a module constant, imported by name into seventeen
 * modules, and there was no such thing as "which board". Two shapes were on the table:
 *
 *   THREAD A `board` ARGUMENT THROUGH EVERY HELPER. Honest, and about a hundred call sites deep -- every
 *   `archetypeForHex`, `liveEdgesForHex`, `isBoardHex`, `printedArtwork` and their callers in the renderer,
 *   the reducer, the route tracer and the token rules. A diff of that size is where regressions hide.
 *
 *   ONE BOARD IN EFFECT, SET BY THE STATE. `BoardDefinition` bundles the tables; the names every module
 *   already imports become LIVE BINDINGS (`export let`) that mirror the board in effect; and the reducer --
 *   the one authority -- activates the board its state names before it runs an arm, restoring the previous
 *   one after. ES module bindings are live, so `import { STATIC_BOARD_HEXES }` reads the board in effect at
 *   the moment it is read, with no call site changed.
 *
 * THE SECOND SHAPE, AND WHY IT IS SAFE HERE. The reducer is synchronous and pure; the server dispatches one
 * action at a time on one thread; nothing reads a board table across an `await`. `withBoard` is a scoped
 * override with a `finally`, not a switch somebody flips and forgets, and the state is its only input --
 * so a room on 1830+ and a room on 1830 in the same server process cannot see each other's board. The
 * browser shell has exactly one game in view and activates that game's board before it renders.
 *
 * THE HAZARD IS A CACHE BUILT AT MODULE LOAD. `new Set(STATIC_BOARD_HEXES.map(...))` at top level captures
 * one board forever. Every such derivation now goes through `boardMemo`, which keys its cache on the board
 * object -- so a lookup stays O(1) and a board switch cannot serve the other board's answer. A source-scan
 * test (`boardInEffect.test.ts`) refuses any new top-level derivation. */

export type BoardId = "standard" | "expanded" | "lpf";

/** Design note #1320: a home station a board adds beyond the eight in `STATION_HOME_HEXES`. */
export interface BoardHomeStation {
  companyId: number;
  q: number;
  r: number;
  label: string;
  /** Design note #1325: `false` when other corporations MAY take this city before the owner sits down (the
   *  Level Playing Field's C&O at Cleveland). Absent means the reservation blocks, as every printed one does.
   *  A board entry with a printed entry's `companyId` and `label` REPLACES it, which is how a printed
   *  reservation is loosened. */
  enforced?: boolean;
}

/** What each station token costs by placement ordinal. Index 0 is the home token. */
export interface StationTokenSchedule {
  home: number;
  second: number;
  later: number;
}

export interface BoardDefinition {
  id: BoardId;
  /** The hexes, terrain, and printed designations. */
  hexes: readonly BoardHex[];
  landmarks: ReadonlyArray<LandmarkHex>;
  landmarkTracks: Readonly<Record<string, ReadonlyArray<{ edges: readonly number[] }>>>;
  offboardLabels: Readonly<Record<string, string>>;
  offboardTracks: Readonly<Record<string, readonly number[]>>;
  /** The shared interior edge of a two-hex red zone, from each hex's side. */
  offboardHiddenEdges: Readonly<Record<string, number>>;
  offboardRevenue: Readonly<Record<string, OffboardRevenueTiers>>;
  grayHexes: Readonly<Record<string, GrayHexTrack>>;
  impassableBorderEdges: ReadonlyArray<ImpassableBorder>;
  yellowOoHexes: ReadonlySet<string>;
  /** Design note #1317: yellow two-city hexes printed TO rather than OO -- Toronto on the expanded board. A TO
   *  hex is still in `yellowOoHexes` (it IS a printed double city, drawn and tokened like one); what the code
   *  changes is which tiles may go on it: the "TO" family only. Empty on the standard board. */
  torontoHexes: ReadonlySet<string>;
  namedHexLabels: Readonly<Record<string, string>>;
  startValueOverride: Readonly<Record<string, number>>;
  /** Printed track and markers this board draws differently from (or in addition to) 1830's authored art.
   *  Merged over the base catalog by `TileGraphics.printedCatalog`. */
  printedArtwork?: Readonly<Record<string, PrintedArtwork>>;
  /** Design note #1320: home stations for corporations that exist only on this board (PMQ, N&W). Read
   *  through `stationHomeHexes()` in `hexContractTypes.ts` beside the eight printed ones. */
  homeStations?: ReadonlyArray<BoardHomeStation>;
  /** Design note #1320: the token price schedule this board plays with. Absent means 1830's $0/$40/$100. */
  stationTokenSchedule?: StationTokenSchedule;
  /** Design note #1288: where a hex's nameplate and value badge sit, when the centred block does not fit the
   *  hex's own art. Keyed by label; slots are `hexGeometry`'s thirteen (1-6 edge midpoints clockwise from
   *  top-right, 7-12 corners clockwise from the top point). `stack` splits a two-word name over two lines.
   *  Absent means the pass's own default placement. */
  plateLayout?: Readonly<Record<string, PlateLayout>>;
}

/** Design note #1288: one hex's nameplate placement. */
export interface PlateLayout {
  badge?: number;
  name?: number;
  stack?: boolean;
  /** Screen pixels to pull the name toward the centre from its slot, for a plate that clips at a point. */
  nameInset?: number;
  /** Degrees clockwise to turn the name about its anchor -- to lay it parallel to an edge. */
  nameRotateDeg?: number;
}

/** 1830 as printed (with this project's standing house rules -- Albany, Fall River). */
export const STANDARD_BOARD: BoardDefinition = {
  id: "standard",
  hexes: STANDARD_HEXES,
  landmarks: STANDARD_LANDMARK_HEXES,
  landmarkTracks: STANDARD_LANDMARK_TRACKS,
  offboardLabels: STANDARD_OFFBOARD_LABELS,
  offboardTracks: STANDARD_OFFBOARD_TRACKS,
  offboardHiddenEdges: { ...GULF_HIDDEN_EDGE, ...CANADIAN_WEST_HIDDEN_EDGE },
  offboardRevenue: STANDARD_OFFBOARD_REVENUE,
  grayHexes: STANDARD_GRAY_HEXES,
  impassableBorderEdges: STANDARD_IMPASSABLE_BORDER_EDGES,
  yellowOoHexes: STANDARD_YELLOW_OO_HEXES,
  torontoHexes: new Set<string>(),
  namedHexLabels: STANDARD_NAMED_HEX_LABELS,
  startValueOverride: STANDARD_HEX_START_VALUE_OVERRIDE,
};

let boardNow: BoardDefinition = STANDARD_BOARD;

/* THE LIVE BINDINGS. Every name below is what the rest of the app imports; each mirrors `boardNow`. They are
   `let` so `activateBoard` can move them, and exported so an importer sees the move. Nothing outside this
   module can assign them -- an imported binding is read-only at the import site. */
export let LANDMARK_HEXES: ReadonlyArray<LandmarkHex> = boardNow.landmarks;
export let LANDMARK_TRACKS: Readonly<Record<string, ReadonlyArray<{ edges: readonly number[] }>>> =
  boardNow.landmarkTracks;
export let STATIC_BOARD_HEXES: readonly BoardHex[] = boardNow.hexes;
export let OFFBOARD_LABELS: Readonly<Record<string, string>> = boardNow.offboardLabels;
export let OFFBOARD_TRACKS: Readonly<Record<string, readonly number[]>> = boardNow.offboardTracks;
export let OFFBOARD_HIDDEN_EDGES: Readonly<Record<string, number>> = boardNow.offboardHiddenEdges;
export let OFFBOARD_REVENUE: Readonly<Record<string, OffboardRevenueTiers>> = boardNow.offboardRevenue;
export let GRAY_HEXES: Readonly<Record<string, GrayHexTrack>> = boardNow.grayHexes;
export let IMPASSABLE_BORDER_EDGES: ReadonlyArray<ImpassableBorder> = boardNow.impassableBorderEdges;
export let YELLOW_OO_HEXES: ReadonlySet<string> = boardNow.yellowOoHexes;
export let TO_HEXES: ReadonlySet<string> = boardNow.torontoHexes;
export let NAMED_HEX_LABELS: Readonly<Record<string, string>> = boardNow.namedHexLabels;
export let HEX_START_VALUE_OVERRIDE: Readonly<Record<string, number>> = boardNow.startValueOverride;
/** Design note #1288: per-hex nameplate placement on the board in effect. */
export let PLATE_LAYOUT: Readonly<Record<string, PlateLayout>> = boardNow.plateLayout ?? {};

/** The board every table above currently describes. */
export function boardInEffect(): BoardDefinition {
  return boardNow;
}

/** Make `board` the one in effect. The shell calls this once per game; the reducer prefers `withBoard`. */
export function activateBoard(board: BoardDefinition): void {
  if (board === boardNow) return;
  boardNow = board;
  LANDMARK_HEXES = board.landmarks;
  LANDMARK_TRACKS = board.landmarkTracks;
  STATIC_BOARD_HEXES = board.hexes;
  OFFBOARD_LABELS = board.offboardLabels;
  OFFBOARD_TRACKS = board.offboardTracks;
  OFFBOARD_HIDDEN_EDGES = board.offboardHiddenEdges;
  OFFBOARD_REVENUE = board.offboardRevenue;
  GRAY_HEXES = board.grayHexes;
  IMPASSABLE_BORDER_EDGES = board.impassableBorderEdges;
  YELLOW_OO_HEXES = board.yellowOoHexes;
  TO_HEXES = board.torontoHexes;
  NAMED_HEX_LABELS = board.namedHexLabels;
  HEX_START_VALUE_OVERRIDE = board.startValueOverride;
  PLATE_LAYOUT = board.plateLayout ?? {};
}

/** Run `fn` with `board` in effect, then put the previous board back -- whatever `fn` does. */
export function withBoard<T>(board: BoardDefinition, fn: () => T): T {
  const previous = boardNow;
  activateBoard(board);
  try {
    return fn();
  } finally {
    activateBoard(previous);
  }
}

/** Design note #1302: the herald printed on `label`, if any, on the board in effect. */
export function heraldAt(label: string): { companyId: number; revenue: number } | null {
  return heraldsByLabel().get(label) ?? null;
}

/** Design note #1302: the hex carrying `companyId`'s herald, if the board in effect prints one. */
export function heraldHexFor(companyId: number): BoardHex | null {
  return heraldsByCompany().get(companyId) ?? null;
}

/** Design note #1320: whether `label` is a warehouse -- a red area that is a pass-through town -- on the board
 *  in effect. Every reader that must stop treating a red area as a terminus asks this one predicate. */
export function isWarehouseHex(label: string): boolean {
  return warehouseLabels().has(label);
}

const warehouseLabels = boardMemo(
  (board) => new Set(board.hexes.filter((hex) => hex.warehouse === true).map((hex) => hex.label)),
);

const heraldsByLabel = boardMemo(
  (board) =>
    new Map(
      board.hexes.flatMap((hex) => (hex.herald ? [[hex.label, hex.herald] as const] : [])),
    ),
);
const heraldsByCompany = boardMemo(
  (board) =>
    new Map(board.hexes.flatMap((hex) => (hex.herald ? [[hex.herald.companyId, hex] as const] : []))),
);

/** A derivation over the board, cached per board object. Replaces every `const X = new Set(STATIC_BOARD_HEXES...)`
 *  at module scope, which would capture whichever board was in effect when the module loaded. */
export function boardMemo<T>(build: (board: BoardDefinition) => T): () => T {
  const cache = new WeakMap<BoardDefinition, T>();
  return () => {
    const cached = cache.get(boardNow);
    if (cached !== undefined) return cached;
    const built = build(boardNow);
    cache.set(boardNow, built);
    return built;
  };
}
