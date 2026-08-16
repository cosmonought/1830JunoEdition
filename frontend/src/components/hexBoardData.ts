// frontend/src/components/hexBoardData.ts
//
// PHASE 2 of the `HexGridRenderer.tsx` monolith extraction.
//
// WHAT THIS IS. The 1830 board itself, as data: every hex and its terrain,
// the three landmark cities and their pre-printed track, the gray hexes, the
// off-board revenue terminals and their era tiers, the impassable borders,
// the OO hexes, the display palettes, and the small pure lookups over them
// (`offboardValueForEra`, `terrainBuildFeeAt`).
//
// No canvas, no React, no DOM. Every export is either a literal table or a
// pure function of one.
//
// WHY THIS BOUNDARY, AND WHY SECOND. Phase 1 took the tile catalog because it
// was a leaf -- nothing in the file it depended on. This is the next leaf up:
// the board data depends on exactly ONE thing outside itself,
// `TileColorTier`, which Phase 1 already moved. Extracting strictly
// leaf-first is what keeps every step free of circular imports, and it is why
// geometry (which reads these tables) and the canvas primitives (which read
// geometry) come after rather than before.
//
// SOURCING. Almost every table here was verbatim-sourced from
// `tobymao/18xx`'s `g_1830/map.rb` and cross-checked against the Rust
// backend's own constants -- see the individual doc comments, and the
// numbered design notes in `./HexGridRenderer.design-notes.md`, for which
// entries were corrected and why. The comments travel WITH the data
// deliberately: a coordinate table with no provenance is unauditable, and
// several of these entries exist because an earlier pass got them wrong.
//
// IMPORT DIRECTION IS ONE-WAY. This module must never import from
// `HexGridRenderer.tsx`. If something here appears to need something there,
// the dependency is pointing the wrong way.

import type { TileColorTier } from "./hexTileCatalog";

/** The three reserved 1830 landmark cities, at their VERIFIED REAL board
 *  coordinates (New York = G19, Boston = E23, Baltimore = I15 -- see design
 *  note #6 for sources and the coordinate transform). CROSS-FILE
 *  CONSISTENCY: RESOLVED -- `hexmap::LANDMARK_HEXES` in the Rust backend was
 *  updated to these same real coordinates (New York `(6, 6)`, Boston
 *  `(9, 4)`, Baltimore `(3, 8)`); this file's coordinates were the source of
 *  truth that pass aligned the backend to. */
// Design note #78: `displayName` is an OPTIONAL cosmetic override for the
// on-canvas nameplate ONLY -- `name` itself stays "New York" (structural,
// used as `LANDMARK_TRACKS`'s lookup key, and by every other place in this
// file that keys off a landmark's real name) so this doesn't ripple into
// `liveEdgesForHex`/`archetypeForHex`/etc. New York's real printed tile
// covers two cities, "New York & Newark" -- `displayName` lets the
// nameplate pass show that full name (and, since it contains " & ", pick
// up the SAME stacked two-line format the OO/double-town passes already
// use for other double-city names) without touching the structural key.
export const LANDMARK_HEXES: ReadonlyArray<{ name: string; displayName?: string; q: number; r: number; label: string }> = [
  { name: "New York", displayName: "New York & Newark", q: 6, r: 6, label: "G19" },
  { name: "Boston", q: 9, r: 4, label: "E23" },
  { name: "Baltimore", q: 3, r: 8, label: "I15" },
];

/** Each landmark's authentic, fixed starting track -- see design note #6b
 *  for the sourced 18xx.games tile-definition strings and the compass-edge
 *  translation method. Each segment is an independent path with its own
 *  station: New York is modeled as TWO one-edge stub segments (its
 *  signature "one hex, two disconnected stations" design), while Boston and
 *  Baltimore are each a single two-edge through-route with one shared
 *  station. Edge numbers here are this file's own convention (design note
 *  #1: 0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE), already translated from the
 *  source engine's differently-numbered edges. */
/** REVERTED (this pass, item 3 -- see design note #29 for the full
 *  investigation). The structural calibration pass's "CORRECTED... direct
 *  IDENTITY" edit below this comment (edges `[3]`/`[0]` for New York, `[3,
 *  5]` for Boston) put New York's edge-0/E stub at axial `(7, 6)` -- label
 *  "G21", which does not exist in `STATIC_BOARD_HEXES` at all (row G's real
 *  hexes stop at G19, New York itself) -- the same "points at a nonexistent
 *  hex" red flag design note #6b's own reflection derivation was built to
 *  catch, now catching the identity claim instead. Reflection is its own
 *  inverse, so re-applying the ORIGINAL, design-note-#6b-verified formula
 *  (`our_edge = ((4 - their_edge) % 6 + 6) % 6`) to the identity pass's
 *  edge values exactly recovers the values this file had before that pass:
 *  New York back to `[1]`/`[4]` (edge 1/NE -> F20 "New Haven & Hartford",
 *  edge 4/SW -> H18 "Philadelphia & Trenton" -- both real, named,
 *  already-modeled hexes in this same file, per design note #6b), Boston
 *  back to `[1, 5]`, Baltimore unchanged at `[0, 4]` (that set is its own
 *  reflection either way, per the identity pass's own correct observation).
 */
export const LANDMARK_TRACKS: Readonly<Record<string, ReadonlyArray<{ edges: readonly number[] }>>> = {
  "New York": [{ edges: [1] }, { edges: [4] }],
  Boston: [{ edges: [1, 5] }],
  Baltimore: [{ edges: [0, 4] }],
};

/** THE tile background colour, by era tier -- design note #122.
 *
 *  One constant per era, full stop. Previously a laid tile's fill came from
 *  `TERRAIN_FILL` below, which is keyed on TERRAIN, so tiles of the same era
 *  painted different colours purely because of what was printed on them: a
 *  plain #9 came out `#f4ecd8`, a town #4 `#f0d9a0`, and the yellow city #57
 *  `#e8d9c0`. #57 sits on nearly every city hex on the board, so the single
 *  most-placed tile in the game was also the most visibly off-tray. Real
 *  1830 cardboard is one stock colour per era; the artwork on top varies,
 *  the card does not.
 *
 *  A second source of divergence went with it: the board loop used to
 *  override the fill to `PRINTED_HEX_FILL.Yellow` for any hex whose static
 *  entry was `printedColor: "Yellow"` (the landmarks and the four OO hexes),
 *  so an upgraded Green or Brown tile on one of those hexes kept painting
 *  yellow forever. Era now wins everywhere, which is also what tells a
 *  player at a glance that a hex has actually been upgraded.
 *
 *  Gray and Red are NOT here on purpose: they are properties of preprinted
 *  BOARD hexes, not of layable tile stock, and keep their own
 *  `BOARD_HEX_FILL`/`PRINTED_HEX_FILL` entries. `TileColorTier` has exactly
 *  three members and this map is total over them. */
/* ===================================================================
 *  DESIGN NOTE 152: THE THREE TIERS MUST BE TELLABLE APART AT A GLANCE
 * ===================================================================
 *
 * The old set was Yellow `#f0d9a0`, Green `#c9e0b4`, Brown `#d8bc9a` --
 * three desaturated pastels within a few points of each other. Yellow and
 * Brown in particular (`#f0d9a0` vs `#d8bc9a`) differ by about as much as
 * two shades of the same beige, which on a board where the tier IS the
 * information -- which era a hex has reached, and therefore what may be
 * laid on it next -- is the one distinction that must never be subtle.
 *
 * Yellow is now a real saturated yellow and Brown a real brown, so the
 * three tiers separate on HUE and LIGHTNESS at once rather than on a few
 * points of warmth.
 *
 * GREEN IS DELIBERATELY UNCHANGED. It was never part of the reported
 * confusion, it already separates cleanly from both new values, and
 * restyling it would be an unrequested change to a third of the board.
 */
/* ===================================================================
 *  DESIGN NOTE 161: THE CANONICAL 1830 PALETTE
 * ===================================================================
 *
 * These are the physical game's own three tile colours, specified directly
 * rather than approximated. They supersede design note #152's set, which
 * was chosen to solve a narrower problem (Yellow and Brown were nearly
 * indistinguishable) and picked plausible values rather than the real ones.
 *
 * Green moves for the first time here. #152 deliberately left it alone
 * because it was not part of that confusion; this note is a full palette
 * specification, so all three change together and the earlier reasoning no
 * longer applies.
 *
 * ONE MEASUREMENT WORTH KNOWING, since it is not fixable by choosing
 * better values: Green and Brown sit at a 1.47:1 LUMINANCE ratio and are
 * separated almost entirely by hue. For a red-green colourblind viewer
 * those two tiers are close to indistinguishable by fill alone. The tier is
 * also carried by the rim colours below, by the tile number in the picker,
 * and by the fact that a hex's available upgrades are filtered to its tier
 * -- so no decision in this app depends on telling those two fills apart by
 * eye. Recorded because it is a real property of the canonical colours, not
 * something introduced here.
 */
export const ERA_TILE_FILL: Readonly<Record<TileColorTier, string>> = {
  // Unified with `PRINTED_HEX_FILL.Yellow` below -- see its own note. A
  // preprinted yellow hex and a laid yellow tile are the same tier and must
  // be the same colour; they were `#e8d488` and `#f0d9a0`, which read as two
  // different kinds of yellow sitting next to each other.
  Yellow: "#FDE900",
  Green: "#71BF44",
  Brown: "#CB7745",
};

/* ===================================================================
 *  DESIGN NOTE 153: TRACK INK IS PER-TIER, AND HAS TO BE
 * ===================================================================
 *
 * Every tile in this renderer strokes its track `#2b2b2b`, near-black. That
 * is correct on the two light tiers and unreadable on the new Brown:
 * `#2b2b2b` on `#713f12` is roughly a 1.6:1 contrast ratio, which is below
 * the threshold at which a thin line is visible at all. Darkening Brown
 * without moving the ink would have traded one confusion (which tier is
 * this?) for a worse one (where does the track go?).
 *
 * So the ink follows the tier. Warm off-white on Brown lands near 7:1,
 * comfortably legible, and reads as the same drawn line rather than as a
 * different kind of track.
 *
 * Only the TRACK moves. Station circles are white discs with their own dark
 * rim and gain contrast on a dark tile; dit markers never appear on Brown
 * (no Brown tile carries `SmallTown`/`DoubleTown` terrain); revenue badges
 * paint their own background.
 */
export const TILE_TRACK_INK: Readonly<Record<TileColorTier, string>> = {
  // Design note #161 UNIFIED THESE AGAIN, and the reason is worth keeping.
  //
  // #153 split the ink per tier because Brown was then `#713f12`, dark
  // enough that near-black track on it measured ~1.6:1 and effectively
  // disappeared. The canonical Brown `#CB7745` is a much lighter clay, so
  // dark ink is correct on all three again: 13.9:1 on Yellow, 7.7:1 on
  // Green, 5.2:1 on Brown -- comfortably past the 3:1 a thick graphical
  // line needs, on every tier.
  //
  // THE TABLE STAYS even though all three values now agree. It is what
  // makes "ink is a function of the tier" a structural fact rather than a
  // coincidence, and it is the thing that caught the problem the last time
  // a fill moved. A future palette change edits one table instead of
  // hunting `strokeStyle` literals through the renderer.
  //
  // Slightly deeper than the old `#2b2b2b` (the non-tile default below),
  // which buys Brown a full contrast step for free.
  Yellow: "#1a1a1a",
  Green: "#1a1a1a",
  Brown: "#1a1a1a",
};

/** The track ink for a tile whose tier is unknown -- an id missing from the
 *  catalog mirror. Matches the historic default, so every existing
 *  non-tile track call (preprinted gray hexes, landmark stubs, off-board
 *  stubs) is byte-identical to before. */
export const DEFAULT_TRACK_INK = "#2b2b2b";

/* Design note #122 deleted `TERRAIN_FILL` from here. It mapped each
   TerrainType to its own tile background, and was the direct cause of the
   reported colour drift: same era, different card colour, depending on what
   was printed on the tile. `ERA_TILE_FILL` above replaced its last three
   call sites (board loop, ghost preview, picker thumbnail) and nothing else
   referenced it. Unlaid BOARD hexes were never its business -- those have
   always used `BOARD_HEX_FILL`/`PRINTED_HEX_FILL`, which are untouched. */


/** The rim around a laid tile. Design note #161: each is a darkened form of
 *  its own fill, so the edge reads as that tile's own outline rather than as
 *  a separate colour laid over it.
 *
 *  Tuned against the FILL rather than against the board, because the rim's
 *  job is to bound the tile: neighbouring hexes are themselves tiles far
 *  more often than they are empty board, so a rim tuned for the dark
 *  backdrop would be the wrong choice everywhere the board is actually
 *  built up. Yellow lands at 4.3:1 on its own fill, Green 3.4:1, Brown
 *  3.4:1 -- all past the 3:1 a graphical boundary needs. */
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
  /** Set on hexes that are pre-printed GRAY (fixed, non-upgradeable) or
   *  pre-printed YELLOW (a real starting yellow tile, not a blank buildable
   *  hex) on the real board -- see design note #12 and `GRAY_HEXES`/
   *  `YELLOW_OO_HEXES` below. Overrides `BOARD_HEX_FILL[type]`'s fill/
   *  stroke (via `PRINTED_HEX_FILL`/`PRINTED_HEX_STROKE`) without changing
   *  `type` itself, so a hex like E5 can be BOTH a pre-printed yellow city
   *  AND a River (still gets its river icon/cost label -- both are true on
   *  the real board simultaneously). Undefined on ordinary blank/buildable
   *  hexes, which keep rendering exactly as before this pass. */
  printedColor?: "Gray" | "Yellow";
  /** Item 1 (structural calibration pass, Map Content Completion): set on
   *  the real board's ordinary WHITE (buildable, no printed track) hexes
   *  that nonetheless carry a preprinted Town/Double-Town DESIGNATION --
   *  verbatim-sourced from `tobymao/18xx`'s `g_1830/map.rb` `HEXES` `white:`
   *  section (`town=revenue:0` / `town=revenue:0;town=revenue:0` entries).
   *  `"single"`: London (E7), Burlington (B20), Flint (D4), Erie (F10) --
   *  four hexes, matching the real sourced count of preprinted Single-Town
   *  hexes. `"double"`: Akron & Canton (G7), Reading & Allentown (G17), New
   *  Haven & Hartford (F20) -- three hexes, matching the real sourced count
   *  of preprinted Double-Town hexes. Distinct from `GRAY_HEXES`'s
   *  `marker: "town"` entries (C15/I19/F24), which are real pre-printed GRAY
   *  hexes with FIXED starting track, not blank buildable hexes -- kept in
   *  lockstep with the Rust backend's `hexmap::TOWN_DESIGNATED_HEXES`
   *  (module doc comment #16), which enforces the matching on-chain
   *  placement rule. Undefined on every other hex. */
  townDesignation?: "single" | "double";
  /** Design note #34/item 2 ("Complete 1830 Baseline City Database"): the
   *  city-marker counterpart to `townDesignation` above -- set on ordinary
   *  WHITE (buildable, no printed track) hexes that carry a preprinted
   *  single-city marker on the real board, verbatim-sourced (and
   *  independently re-derived three times against the raw source text) from
   *  `tobymao/18xx`'s `g_1830/map.rb` `HEXES` `white:` section's plain
   *  `city=revenue:0` / `city` entries: Toledo (F4), Providence (F22),
   *  Pittsburgh (H10), Columbus (H4), Washington (J14), Lancaster (H16),
   *  Ottawa (B16), and Barrie (B10). Deliberately NOT modeled as a
   *  `GRAY_HEXES` entry: the real source has no `path=` data at all for any
   *  of these eight hexes (unlike an actual `GRAY_HEXES` city, which prints
   *  real fixed track), so -- exactly like `townDesignation` -- this draws
   *  only a placement-guide marker (`drawStationCircle`, no track), NOT
   *  real pre-printed track. UNLIKE `townDesignation`'s SmallTown/DoubleTown
   *  value, though, this DOES get the flat `MajorCityHub` ($20) pre-tile
   *  route value/badge, matching `townDesignation`'s own already-established
   *  precedent (added after design note #26/item 5's original city/town
   *  badge pass) of giving every printed destination marker -- including
   *  ordinary blank designated hexes with no real track yet -- a flat
   *  placeholder value, plus this item's own explicit "$20 base track
   *  value" ask. See design note #34 for the two corrections this uncovered
   *  (B16 is really Ottawa, not "Barrington"; F24 is really Mansfield, not
   *  "River Falls"). Undefined on every other hex. */
  cityDesignation?: boolean;
}

/** The complete, real 93-hex 1830 board -- see design note #6 for sources
 *  and the row-letter/column-number -> axial `(q, r)` transform this array
 *  was generated from. Unlike the previous illustrative pass, this is NOT
 *  a per-row `[qMin, qMax]` span generator: the real board's outline is
 *  genuinely non-convex (e.g. row A has a gap between columns 11 and 17 --
 *  hexes A13/A15 simply don't exist), so every one of the 93 real hexes is
 *  listed explicitly rather than approximated by a range. */
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
  // Scranton -- missed city, added by design note #123. Same
  // `cityDesignation: true` pattern as F4/Toledo (a blank, no-real-track
  // hex with a terrain type), the one existing precedent for a printed
  // terrain type PLUS a city marker together -- Toledo's is River
  // ("water"), this one is Mountain, the requested analog.
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

/** Off-board revenue terminal display names, keyed by real board label --
 *  see design note #6. `A9`/`I1` are the real board's auxiliary "hidden"
 *  continuation hexes for the Canadian West / Gulf zones respectively (each
 *  off-board zone spans two hexes on the physical board and shares one
 *  revenue value between them); labeling both with their zone's name is
 *  more honest than picking one arbitrarily to omit. */
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

/** Design note #26/item 3: the Gulf off-board zone's two hexes (I1/J2, both
 *  labeled "Gulf" above) are drawn as one visually merged region -- their
 *  shared interior edge's border stroke is suppressed (see `drawHexEdges`
 *  below) and they get a single centered nameplate instead of two. `I1`
 *  sits at `(q, r)` and `J2` at `(q, r + 1)` (edge index 5's direction, per
 *  `edgeAngleRad`'s `(dq, dr) = (0, +1)` neighbor -- confirmed against
 *  `OFFBOARD_TRACKS`'s own "real neighbor I3" comments above, which land on
 *  the same shared edge from both sides: I1's remaining live edge 0 points
 *  at I3, and J2's edge 1 also points at I3), so I1's edge 5 / J2's edge 2
 *  is the one shared interior edge to hide. */
export const GULF_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  I1: 5,
  J2: 2,
};

/** Item 9 (structural calibration pass, Merge Canadian West): applies the
 *  identical technique `GULF_HIDDEN_EDGE` above already established to the
 *  Canadian West off-board zone's own two hexes (A9/A11, both labeled
 *  "Canadian West" in `OFFBOARD_LABELS`) -- their shared interior edge's
 *  border stroke suppressed, one merged nameplate instead of two. `A9` sits
 *  at `(q, r) = (4, 0)` and `A11` at `(q, r) = (5, 0)`, a `(dq, dr) = (+1,
 *  0)` neighbor pair -- edge index 0 per `edgeAngleRad`'s convention -- so
 *  A9's edge 0 (facing A11) and A11's opposite edge 3 (facing A9) are the
 *  one shared interior edge to hide on each side. Real off-board terminal
 *  hexes carry no printed path connecting the two halves of a zone at all
 *  (they're a permanently-fixed, unbuildable revenue box, not track a
 *  Protocol lays) -- `OFFBOARD_TRACKS`'s own A9/A11 entries are each hex's
 *  stub toward its real neighboring PLAYABLE hex (B10/B12), a completely
 *  separate edge from this purely geometric shared-border seam, so this
 *  hidden-edge pair is derived straight from axial adjacency, the same way
 *  `GULF_HIDDEN_EDGE` was cross-checked, rather than from any `path=`
 *  source data. */
export const CANADIAN_WEST_HIDDEN_EDGE: Readonly<Record<string, number>> = {
  A9: 0,
  A11: 3,
};

/** Each off-board destination's real printed Yellow/Brown revenue -- see
 *  design note #11 for the source and why there's no separate Green tier
 *  printed on the physical board. Keyed by the same display name
 *  `OFFBOARD_LABELS` uses. Restructured from a single display string into
 *  numeric tiers for design note #15/item 4: era-adaptive rendering needs
 *  the actual numbers, not a pre-formatted "$40/$70" string, to pick out
 *  just the currently-active era's value. */
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

/** Resolves `tiers` to the single value that applies at `era` -- see design
 *  note #15. Real 1830 off-board boxes only ever print two numbers (see
 *  design note #11): the "Yellow" figure keeps applying through the Green
 *  era too (there's no distinct printed Green value), and the "Brown"
 *  figure takes over once Brown is reached. */
export function offboardValueForEra(tiers: OffboardRevenueTiers, era: TileColorTier): number {
  return era === "Brown" ? tiers.brown : tiers.yellow;
}

/** Representative build cost for each buildable-but-costly terrain type --
 *  the real 1830 printed terrain costs (see design note #9).
 *
 *  PROMOTED (design note #118, backend Audit G-5/G-10): these two figures are
 *  no longer merely a legibility label that happened to sit next to the real
 *  number. Terrain is now charged as a HEX property, exactly as real 1830
 *  charges it -- `hexmap::execute_lay_tile` reads the fee from
 *  `terrain_build_fee(q, r)` ($80 river / $120 mountain / $0 clear land),
 *  paid once when a hex is first built on and free on every later colour
 *  upgrade. Every entry in `hexmap::TILE_CATALOG` now carries a `0` cost
 *  field, and the invented "river"/"mountain pass" tile artwork that used to
 *  carry the charge (old internal ids 4, 5, 12) is deleted. That closed both
 *  halves of the old exploit: laying an ordinary plain tile onto a real
 *  river or mountain hex used to be free, and laying the invented mountain
 *  artwork onto flat grassland used to charge $80 for nothing. So what this
 *  table shows is now the actual enforced figure for the hex beneath it.
 *
 *  Design note #94: `$` dropped from both values, per direct request --
 *  the red box itself (design note #68) already unambiguously marks this
 *  as a cost figure, so the bare number reads cleanly on its own. Feeds
 *  BOTH render paths (the plain-hex box and `drawTerrainCompoundBadge`)
 *  unchanged, since both just render whatever string this constant holds. */
/** Real 1830's printed water/river build fee, in.
 *  Mirrors `hexmap::RIVER_BUILD_FEE` exactly. */
/* ==================================================================
 *  DESIGN NOTE 223: THE LAY TRACK VEIL'S THREE VALUES
 * ==================================================================
 *
 * `HexGridRenderer` dims every hex the acting corporation cannot build on
 * during the Lay Track sub-phase. These are its constants, here rather than
 * inline in the draw pass for the same reason every other board colour is:
 * a value used once today is a value copied twice tomorrow.
 *
 * THE ALPHA IS THE WHOLE DESIGN DECISION. 0.55 is deliberately a veil rather
 * than a blackout: a player judging whether to extend north still needs to
 * READ the dimmed board -- where the cities are, which hexes already carry
 * track, where the mountains are -- because that is what makes the choice
 * between the lit hexes. 18xx.games dims to roughly this depth for the same
 * reason. Opaque would turn a highlight into a blindfold.
 *
 * The ink is the board's own deep navy rather than neutral black, so the
 * veil reads as the map receding rather than as a grey sheet over it.

/* ==================================================================
 *  THE LAY TRACK VEIL: DELETED, THEN RESTORED ASYMMETRICALLY
 * ==================================================================
 *
 * These were deleted by `HexGridRenderer.tsx` design note #367 and brought
 * back by #377. That note carries the reasoning; the short version is that
 * #367 was right about one of its two objections and the remedy for it was
 * a CONDITION, not a deletion -- the veil now applies to the player whose
 * turn it is and to nobody else.
 *
 * THE ALPHA IS THE OTHER HALF OF THE FIX. It was 0.55: more than half the
 * board's light gone, which is what turned a legitimate emphasis into the
 * map being taken away. At 0.22 a veiled hex still reads as cardboard --
 * its colour, its track and its tokens all survive -- and the glow on the
 * legal set has something to be brighter THAN.
 *
 * The deletion note warned that "a dimming constant sitting in the board
 * palette is a standing invitation to reintroduce a global overlay". That
 * risk is real and is answered where it can be: the renderer cannot dim
 * without `layFocus.dim`, which only the shell sets, and only from
 * `isMyTurn`. */
export const LAY_TRACK_DIM_ALPHA = 0.22;
export const LAY_TRACK_DIM_INK = "#070b14";
/** The ring on a buildable hex. Green, matching the tile picker's own
 *  confirm affordance (`fabConfirm`), so "you may act here" is one colour
 *  across the board and the ring that appears when you click it. */
export const LAY_TRACK_HIGHLIGHT_INK = "#4ade80";

export const RIVER_BUILD_FEE = 80;

/** Real 1830's printed mountain build fee, in.
 *  Mirrors `hexmap::MOUNTAIN_BUILD_FEE` exactly. */
export const MOUNTAIN_BUILD_FEE = 120;

/** What laying track on hex `(q, r)` costs in terrain fees -- design note
 *  #136 (F-2).
 *
 *  A DIRECT MIRROR of `hexmap::terrain_build_fee(q, r)`, structured the same
 *  way it is: look the hex up in the river set, then the mountain set, then
 *  charge nothing. `0` for ordinary clear ground, which is a real answer, not
 *  a missing one.
 *
 *  WHY BY COORDINATE RATHER THAN BY TERRAIN TYPE. This used to be a
 *  `Record<BoardHexType, string>` keyed on the hex's `type` field, which made
 *  the fee a property of a rendering CATEGORY. In real 1830 -- and in the
 *  contract since backend G-10 -- terrain cost is a property of the HEX:
 *  `hexmap::terrain_build_fee` takes `(q, r)` and consults
 *  `RIVER_HEXES`/`MOUNTAIN_HEXES`. Keying on a display type meant the two
 *  models could disagree about any hex whose rendering category and terrain
 *  membership ever diverged, and it made the frontend's number look like a
 *  UI constant rather than a mirrored contract value.
 *
 *  THE FIGURES ARE THE CONTRACT'S, AND THE SPEC DOCUMENT IS WRONG.
 *  `AUDIT_PART2_FRONTEND.md`'s F-2 records the spec as saying "$20 River /
 *  $80 Mountain". That is not real 1830 and not what this contract charges:
 *  `hexmap::RIVER_BUILD_FEE = 80` and `hexmap::MOUNTAIN_BUILD_FEE = 120`,
 *  which is also what the physical board prints. The renderer already showed
 *  $80/$120; the reconciliation needed was to the SPEC, not to the code, and
 *  the resolution is that the contract is the authority. These constants are
 *  named after their backend counterparts so the correspondence is checkable
 *  by grep rather than by memory.
 *
 *  STILL A MIRROR, and worth being honest about: no query surfaces
 *  `terrain_build_fee`, so this cannot read the figure off the chain the way
 *  `MapTileEntry.revenue` now does for tile revenue. If terrain fees ever
 *  become player-visible in a way that affects a decision beyond a label,
 *  they should be surfaced on a query and read from there. */
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

/** Overrides `BOARD_HEX_FILL`/`BOARD_HEX_STROKE` on any `BoardHex` carrying
 *  a `printedColor` -- see design note #12 and the `BoardHex.printedColor`
 *  doc comment. `Gray` approximates the real board's pre-printed gray tile
 *  cardstock; `Yellow` approximates a real starting yellow tile (matching
 *  `COLOR_TIER_STROKE.Yellow`'s gold stroke used for laid yellow tiles
 *  elsewhere in this file, for visual consistency). */
export const PRINTED_HEX_FILL: Readonly<Record<"Gray" | "Yellow", string>> = {
  Gray: "#8a8f94",
  // Design note #152: THE SAME VALUE as `ERA_TILE_FILL.Yellow`, not a
  // near-match. These two paint the same claim -- "this hex is at the
  // Yellow tier" -- and differed only because they were tuned in separate
  // passes. Written as the literal rather than referencing `ERA_TILE_FILL`
  // so this table stays a plain lookup with no import cycle; the note is
  // what keeps them together, and the sandbox legality filter's
  // `PREPRINTED_TIER_BY_LABEL` already treats them as one tier.
  Yellow: "#FDE900",
};
export const PRINTED_HEX_STROKE: Readonly<Record<"Gray" | "Yellow", string>> = {
  Gray: "#4a4e52",
  Yellow: "#7a6a00",
};

/** One pre-printed gray hex's fixed track + city/town marker -- see design
 *  note #12 for the source (`tobymao/18xx`'s `HEXES` `gray:` block).
 *  REVERTED (this pass, item 3 -- see design note #29). The structural
 *  calibration pass's "CORRECTED... direct IDENTITY" edit (edges kept as
 *  the source engine's own raw numbers) put Montreal's (A19) edge-0/E stub
 *  at axial `(10, 0)` -- label "A21", which does not exist in
 *  `STATIC_BOARD_HEXES` at all (row A's real hexes stop at A19, Montreal
 *  itself) -- literally running that track off the printed board's own
 *  eastern edge. Since the identity bug applied to this whole table (not
 *  just the named cities), and reflection is its own inverse, every entry
 *  below is reverted by re-applying the ORIGINAL, design-note-#6b-verified
 *  formula (`our_edge = ((4 - their_edge) % 6 + 6) % 6`) to the identity
 *  pass's stored values -- each entry's own comment shows the before (last
 *  pass) -> after (this pass, reverted) edges. `marker`/interior comments
 *  are otherwise unchanged: `path=a:N,b:_0` is a stub from edge `N` into
 *  the hex's own station node; `path=a:N,b:M` with no `_0` is a bare
 *  through-connector with no station at all -- the `E9`/`A17`/`D24`
 *  "none"-marker hexes. `marker` selects which station glyph
 *  `drawPrintedTrack` paints: `"city"` (large white station circle), `"town"`
 *  (small dark dit marker), or `"none"` (no passenger stop). Two gray hexes
 *  (H12 Altoona, D14 Rochester) have a third real path in the source that
 *  bypasses their own city circle entirely (a real 1830 "some trains skip
 *  this stop" rule) -- simplified away here, same as this file's other
 *  "track rendering is this component's own convention" simplifications
 *  (design note #3): the city's own through-connection is still drawn, just
 *  not the separate bypass-only path. */
export interface GrayHexTrack {
  edges: readonly number[];
  marker: "city" | "town" | "none";
  /** Item (Precise Geometric Track Calibration pass): the real source has a
   *  THIRD path for this hex -- `path=a:1,b:4` for Altoona (18xx.games edge
   *  numbering) -- that connects the same two edges as the main line but
   *  does NOT touch the `_0` city node (`b:_0` is absent from that specific
   *  path entry), i.e. a real 1830 "some trains skip this stop" bypass.
   *  Translated via this file's own `our_edge = ((4 - their_edge) % 6 + 6) %
   *  6` formula (design note #6b), edges 1/4 land on this file's edges
   *  3/0 -- the SAME pair as `edges` below for H12, just drawn as a second,
   *  separate curve that visibly loops clear of the station circle instead
   *  of passing through it. Previously simplified away (see design note #12
   *  doc comment above); reinstated here since it was asked for by name.
   *  Rochester (D14) has the identical real bypass in the source and is
   *  NOT given one here -- out of scope for this pass, flagged rather than
   *  silently matched. */
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

/** Fixed set of board-edge crossings across which track may never be built
 *  (design note #38) -- the frontend's drawing-only mirror of the backend's
 *  `hexmap::IMPASSABLE_HEX_EDGES` (module doc comment #22), which enforces
 *  the actual placement legality; this table exists purely so `draw()` can
 *  paint a thick red bar across each blocked crossing. Each entry is one
 *  representative `(q, r, edge)` per border -- unlike the backend's table,
 *  which lists BOTH hexes' own edge (since it needs to reject a lay attempt
 *  from either side), this only needs to draw the line once, so only one
 *  side of each border is listed here. `q`/`r` match `STATIC_BOARD_HEXES`'
 *  own entries for that label exactly (E7 `{q:1,r:4}`, D12 `{q:4,r:3}`, C17
 *  `{q:7,r:2}`); `edge` is this file's own 0-5 convention (`edgeAngleRad`),
 *  independently cross-checked against the backend's identical derivation
 *  from `HEX_NEIGHBOR_OFFSETS`. */
export const IMPASSABLE_BORDER_EDGES: ReadonlyArray<{ q: number; r: number; edge: number; label: string }> = [
  { q: 1, r: 4, edge: 5, label: "E7 / F8" },
  { q: 4, r: 3, edge: 2, label: "D12 / C11" },
  { q: 4, r: 3, edge: 1, label: "D12 / C13" },
  { q: 7, r: 2, edge: 2, label: "C17 / B16" },
];

/** Pre-printed YELLOW "OO" double-city hexes -- two real, separately
 *  revenue-earning cities sharing one hex, printed with NO connecting track
 *  between them at all (verbatim-confirmed: none of these four hexes' real
 *  tile-definition strings contain a `path=` entry) -- players must
 *  eventually upgrade past this starting tile to actually connect the two
 *  stations. `drawOOCityMarkers` renders exactly that: two independent
 *  station circles, no track. `hasWaterCost` hexes (Detroit & Windsor,
 *  Hamilton & Toronto) also carry a real `$80` water upgrade cost --
 *  already modeled by this file's existing River terrain/icon/cost-label
 *  system (see `BoardHex.printedColor`'s doc comment: these hexes keep
 *  `type: "River"` alongside `printedColor: "Yellow"`), so no separate
 *  field is needed here for that. */
export const YELLOW_OO_HEXES: ReadonlySet<string> = new Set(["E5", "D10", "E11", "H18"]);

/** Display names for every named gray/yellow-OO hex -- see design note #12.
 *  Sourced verbatim from `tobymao/18xx`'s `LOCATION_NAMES` table. E9, A17,
 *  and D24 are intentionally absent: they're real hexes with real
 *  pre-printed track (see `GRAY_HEXES` above) but no city/town at all, and
 *  `LOCATION_NAMES` itself has no entry for them either.
 *
 *  Item 1 (structural calibration pass, Map Content Completion) adds the
 *  seven ordinary white Town/Double-Town-designated hexes' names too (see
 *  `BoardHex.townDesignation`'s doc comment for the source and the exact
 *  4 Single-Town / 3 Double-Town split).
 *
 *  Design note #34/item 2 adds the eight ordinary white single-city-
 *  designated hexes' names too (see `BoardHex.cityDesignation`'s doc
 *  comment for the source) -- Toledo/Providence/Pittsburgh/Columbus/
 *  Washington/Lancaster/Barrie, plus Ottawa (B16, corrected from an earlier
 *  pass's own suggested "Barrington", which doesn't match the source; see
 *  design note #34).
 *
 *  F24 below is "Fall River", NOT the real board's own "Mansfield" name --
 *  design note #36/item 3 explicitly asked for this as "our preferred
 *  title" (contrasted, in that same request, with B16's explicitly
 *  "authentic rulebook name" Ottawa), i.e. a deliberate house-rule cosmetic
 *  override, not a claim that "Fall River" is what the sourced 18xx data
 *  actually says -- unlike an EARLIER pass's "River Falls" ask, which WAS
 *  framed as factual and was correctly declined (design note #34) since it
 *  didn't match the source. This one is honored as-given: the real board
 *  name is still "Mansfield" (`GRAY_HEXES`' own F24 entry/comment, and
 *  `hexmap.rs`'s `TOWN_DESIGNATED_HEXES`, are both left saying so in their
 *  own comments for the historical record), but the display name here is
 *  now the requested custom override. */
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
  // Design note #106: reverted to the bare "Washington" -- reported the
  // longer "Washington, D.C." (design note #47's own explicit request,
  // above) extends off the hex, and the fix requested was specifically to
  // drop "D.C." rather than relocate the nameplate to a different slot
  // ("To make absolutely sure there's room, let's remove 'DC' from the
  // nameplate").
  J14: "Washington",
  H16: "Lancaster",
  B16: "Ottawa",
  B10: "Barrie",
  E19: "Albany",
  F16: "Scranton", // design note #123 -- missed city, added
};

/** Design note #35/items 2-3 ("Accurate 1830 Base Value Corrections" /
 *  "Zero-Value for Preprinted OO, Gray, and Landmark Additions"): per-hex
 *  overrides to the flat `terrainBaseValue("MajorCityHub") = $20` this file
 *  otherwise uses uniformly for every city-marker hex, keyed by real board
 *  label. Consulted by `hexRouteValue` (tooltip) and the value-badge drawing
 *  passes below BEFORE their existing flat-by-terrain fallback, so any hex
 *  NOT listed here (Lansing D2, Rochester D14, Richmond K15 -- three of the
 *  `GRAY_HEXES` city markers with no individually-sourced figure verified
 *  yet -- plus every `townDesignation` hex) is completely unaffected, still
 *  flat $20/$10 as before. Altoona H12 WAS one of these four originally,
 *  but a later pass (Rigid Global Gray-Hex Lockout, backend `hexmap.rs`
 *  module doc comment #20) independently sourced its real figure at $10 --
 *  see that entry below, and the FACTUAL CORRECTION paragraph after this
 *  one for the paired Town-reclassification claim that same pass rejected.
 *
 *  SOURCE VERIFICATION (independently re-derived twice against the raw
 *  `tobymao/18xx` `g_1830/map.rb` source text this file has cited
 *  throughout -- design notes #6/#12/#34): New York's real printed starting
 *  track is `'city=revenue:40;city=revenue:40;...'` (two $40 stations --
 *  this file's own `LANDMARK_TRACKS` doc comment already cited this exact
 *  string, just never wired it into the value-badge system before now),
 *  Boston is `'city=revenue:30;...'`, Baltimore is `'city=revenue:30;...'`,
 *  Montreal (A19) is `'city=revenue:40;...'`. FACTUAL CORRECTION: this
 *  item's own request labeled F6 "Chicago" -- F6 is real, verified Cleveland
 *  (`'city=revenue:30;...'`, confirmed against the same source's
 *  `LOCATION_NAMES` table too); Chicago is the real off-board hex F2, a
 *  completely different hex already modeled by `OFFBOARD_LABELS`/
 *  `OFFBOARD_REVENUE` on its own, era-tiered value system. Applied
 *  Cleveland's real $30 at F6, not a "Chicago" entry that would have been
 *  meaningless (F6 isn't Chicago, and Chicago already has its own value
 *  system this table doesn't touch).
 *
 *  The four `YELLOW_OO_HEXES` (design note #12) are ALSO independently
 *  confirmed at real `$0`: their source strings are
 *  `'city=revenue:0;city=revenue:0;label=OO;...'` -- both stations on EVERY
 *  one of these four hexes are printed with an explicit `revenue:0`, not
 *  merely an unspecified/default value, so `$0` here is the hex's genuine
 *  printed value, not an approximation. The eight `cityDesignation` hexes
 *  (design note #34) were already independently confirmed at `$0` last pass
 *  (bare `city`/`city=revenue:0` entries, no revenue figure at all) --
 *  restated here as the single source of truth the badge/tooltip code
 *  actually reads, superseding design note #34's own decision to show a
 *  flat $20 there (that decision predates this more precise source read).
 *
 *  FACTUAL CORRECTION (count): this item's own list of "8 newly injected
 *  city hubs" actually named nine hexes, including "River Falls F24" --
 *  F24 is NOT one of design note #34's eight `cityDesignation` hexes at
 *  all; it's Mansfield, a `GRAY_HEXES` `marker: "town"` hex (a real
 *  pre-printed Single-Town, `SmallTown` terrain, already correctly valued
 *  at its own flat $10 town rate since design note #12, long before design
 *  note #34's city-hub pass existed). Zeroing it out here would have
 *  silently overwritten an already-correct, independently-sourced $10 with
 *  an inapplicable city-hub $0 override. F24 is deliberately absent from
 *  this table; the eight hexes below are the real, complete
 *  `cityDesignation` set. B16 is, again, really Ottawa, not "Barrington"
 *  (design note #34) -- restated rather than silently re-applied.
 *
 *  ALTOONA (H12) CORRECTION (Rigid Global Gray-Hex Lockout pass): a request
 *  asked to reclassify Altoona from `MajorCityHub`/City to a Town, citing
 *  a paired $10 value. Independently re-verified TWICE against the real
 *  `tobymao/18xx` `g_1830/map.rb` source: H12's actual entry is
 *  `'city=revenue:10,loc:2.5;path=a:1,b:_0;path=a:4,b:_0;path=a:1,b:4'` --
 *  an explicit `city=` entry, not `town=`. Altoona genuinely IS a City on
 *  the real board; the $10 VALUE is correct (cities aren't always $20 --
 *  Cleveland/Boston/Baltimore above are real $30 cities, for the same
 *  reason), but the Town reclassification is not. Applied here as a value
 *  override only -- `GRAY_HEXES.H12`'s `marker: "city"` stays unchanged
 *  (white station circle, not a dark town dit), and no `TerrainType`
 *  changes on the backend either (`hexmap.rs` module doc comment #20). */
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
