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

// The three landmarks at their VERIFIED real coordinates; the backend was later aligned to these. displayName is a cosmetic nameplate override only -- name stays structural, so it does not ripple into the lookups keyed on it.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #78
export const LANDMARK_HEXES: ReadonlyArray<{ name: string; displayName?: string; q: number; r: number; label: string }> = [
  { name: "New York", displayName: "New York & Newark", q: 6, r: 6, label: "G19" },
  { name: "Boston", q: 9, r: 4, label: "E23" },
  { name: "Baltimore", q: 3, r: 8, label: "I15" },
];

/** Each landmark's authentic printed track, translated by the verified reflection formula. REVERTED from a claimed IDENTITY mapping that put New York's stub on "G21", a hex that does not exist -- the same red flag that caught the ORIGINAL bug. Reflection is its own inverse, so re-applying it recovers the verified values exactly.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #29 */
export const LANDMARK_TRACKS: Readonly<Record<string, ReadonlyArray<{ edges: readonly number[] }>>> = {
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
  printedColor?: "Gray" | "Yellow";
  /** Blank WHITE hexes carrying a preprinted town designation, verbatim-sourced. Distinct from the gray hexes' town markers, which have FIXED starting track. Kept in lockstep with the backend's own list.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #12 */
  townDesignation?: "single" | "double";
  /** Blank white hexes with a preprinted single-city marker, independently re-derived three times against the raw source. Deliberately NOT gray entries: the source has no path data for any of them, so this draws a marker and no track. Two of the request's own specifics were not applied -- B16 is Ottawa, F24 is Mansfield.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #35 */
  cityDesignation?: boolean;
}

/** All 93 real hexes listed explicitly rather than generated per-row: the board's outline is genuinely non-convex, and row A simply has no A13 or A15.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #6 */
export const STATIC_BOARD_HEXES: readonly BoardHex[] = [
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
export const OFFBOARD_LABELS: Readonly<Record<string, string>> = {
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
export const OFFBOARD_TRACKS: Readonly<Record<string, readonly number[]>> = {
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
export const GULF_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  I1: 5,
  J2: 2,
};

/** The identical technique for Canadian West. Real off-board hexes carry NO printed path connecting the halves of a zone, so this seam is purely geometric and derived from adjacency rather than from source path data.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #26 */
export const CANADIAN_WEST_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  A9: 0,
  A11: 3,
};

/** Each destination's real printed Yellow/Brown revenue; there is no separate Green tier printed on the board. Structured as numeric tiers rather than a formatted string, since era-adaptive rendering needs the numbers.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #11 */
export interface OffboardRevenueTiers {
  yellow: number;
  brown: number;
}

export const OFFBOARD_REVENUE: Readonly<Record<string, OffboardRevenueTiers>> = {
  Chicago: { yellow: 40, brown: 70 },
  "Canadian West": { yellow: 30, brown: 50 },
  Gulf: { yellow: 30, brown: 60 },
  "Deep South": { yellow: 30, brown: 40 },
  "Maritime Provinces": { yellow: 20, brown: 30 },
};

/** Yellow keeps applying through Green -- there is no distinct printed Green value -- and Brown takes over once reached.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #15 */
export function offboardValueForEra(tiers: OffboardRevenueTiers, era: TileColorTier): number {
  return era === "Brown" ? tiers.brown : tiers.yellow;
}

/** The real printed terrain costs, now the actual ENFORCED figure: terrain is charged as a HEX property, paid once on first build and free on every later upgrade. That closed both halves of the old exploit. The veil alphas live here for the same reason every other board colour does. #420: 0.22 was a dimming nobody could see -- 22% of near-black over near-black is a few RGB points.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #472 */
export const LAY_TRACK_DIM_ALPHA = 0.55;

/* 0.42 -> 0.55, plus a SECOND, harder veil as its own constant rather than a multiplier: the base answers "where may I build" (a survey, so every legal hex stays comparable), the focus answers "what am I deciding right now". Deliberately not opaque even at 0.82 -- the board must stay visible enough to judge a tile against its neighbours.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #472 */
export const LAY_TRACK_FOCUS_DIM_ALPHA = 0.82;
export const LAY_TRACK_DIM_INK = "#070b14";
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
export const PRINTED_HEX_FILL: Readonly<Record<"Gray" | "Yellow", string>> = {
  Gray: "#8a8f94",
  // THE SAME VALUE as the Yellow era fill, not a near-match: both paint the same claim and differed only because they were tuned in separate passes. Written as a literal rather than a reference to keep this table import-cycle-free.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #152
  Yellow: "#FDE900",
};
export const PRINTED_HEX_STROKE: Readonly<Record<"Gray" | "Yellow", string>> = {
  Gray: "#4a4e52",
  Yellow: "#7a6a00",
};

/** Every entry REVERTED by re-applying the verified reflection formula -- the identity pass put Montreal's stub on "A21", running the track off the board's eastern edge. Two gray hexes have a real "some trains skip this stop" bypass path; only Altoona's is drawn.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #29 */
export interface GrayHexTrack {
  edges: readonly number[];
  marker: "city" | "town" | "none";
  /** Altoona's real bypass, reinstated because it was asked for by name. Rochester has the identical bypass in the source and is deliberately NOT given one -- flagged rather than silently matched.
   *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #29 */
  bypass?: boolean;
}

export const GRAY_HEXES: Readonly<Record<string, GrayHexTrack>> = {
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
export const IMPASSABLE_BORDER_EDGES: ReadonlyArray<{ q: number; r: number; edge: number; label: string }> = [
  { q: 1, r: 4, edge: 5, label: "E7 / F8" },
  { q: 4, r: 3, edge: 2, label: "D12 / C11" },
  { q: 4, r: 3, edge: 1, label: "D12 / C13" },
  { q: 7, r: 2, edge: 2, label: "C17 / B16" },
];

/** Two separately revenue-earning cities on one hex with NO connecting track at all -- verbatim-confirmed that none of the four has a path entry. Players must upgrade past the starting tile to connect them.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #12 */
export const YELLOW_OO_HEXES: ReadonlySet<string> = new Set(["E5", "D10", "E11", "H18"]);

/** Display names sourced verbatim; three real hexes have printed track but no city or town and are intentionally absent. F24 is "Fall River" -- a deliberate house-rule cosmetic override, explicitly contrasted in the same request with B16's authentic "Ottawa", unlike an earlier ask framed as factual and correctly declined.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #39 */
export const NAMED_HEX_LABELS: Readonly<Record<string, string>> = {
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
export const HEX_START_VALUE_OVERRIDE: Readonly<Record<string, number>> = {
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
