// frontend/src/components/HexGridRenderer.tsx
//
// Milestone 3: the 2D Canvas Graphics Engine's hex-map layer.
//
// ===================================================================
//  THE DESIGN NOTES FOR THIS FILE LIVE IN
//      ./HexGridRenderer.design-notes.md
// ===================================================================
//
// That document holds the full numbered design-note history this header used
// to carry inline -- ~3,180 lines of it, 26% of this file, all of it sitting
// above the first `import`. Every `design note #N` reference in this file and
// elsewhere in the codebase resolves to an entry there, under its original
// number.
//
// Moved rather than deleted (monolith split, Phase 0): the notes are the
// record of WHY this renderer is shaped the way it is, and several of them
// document bugs that are easy to reintroduce. They are worth more in a file
// you can read as prose than as a wall a code reader has to scroll past.
//
// NEW DESIGN NOTES GO IN THAT FILE, not back here.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PILL_SLOT_SPACING,
  TILE_GRAPHICS_CATALOG,
  tileArtworkPaths,
  tileCityAnchors,
  tileCitySlotPoints,
  tileMarkerPoints,
} from "./TileGraphics";
// Monolith split, Phase 1. Imported under their own names because this file's
// own code refers to them unqualified throughout; the matching
// `export ... from` re-export further down keeps them on this module's public
// surface for `App.tsx` / `TileSelectionPopup.tsx`. A re-export creates no
// local binding, so the two statements do not collide.
//
// MUST live here, at the top, not beside that re-export: ESLint's
// `import/first` requires every `import` to precede all other statements, and
// this file's first statement is ~3,300 lines below its own header comment,
// which makes "next to the thing it relates to" and "at the top" look like
// the same place when they are not.
import {
  TILE_CATALOG,
  TILE_CATALOG_BY_ID,
  type TerrainType,
  type TileCatalogEntry,
  type TileColorTier,
} from "./hexTileCatalog";
import {
  BOARD_HEX_FILL,
  BOARD_HEX_STROKE,
  CANADIAN_WEST_HIDDEN_EDGE,
  COLOR_TIER_STROKE,
  ERA_TILE_FILL,
  GRAY_HEXES,
  GULF_HIDDEN_EDGE,
  HEX_START_VALUE_OVERRIDE,
  IMPASSABLE_BORDER_EDGES,
  LANDMARK_HEXES,
  LANDMARK_TRACKS,
  NAMED_HEX_LABELS,
  OFFBOARD_LABELS,
  OFFBOARD_REVENUE,
  OFFBOARD_TRACKS,
  PRINTED_HEX_FILL,
  PRINTED_HEX_STROKE,
  STATIC_BOARD_HEXES,
  YELLOW_OO_HEXES,
  offboardValueForEra,
  terrainBuildFeeAt,
  type OffboardRevenueTiers,
} from "./hexBoardData";

/* ------------------------------------------------------------------ */
/* Contract data mirrors -- see design note #2                        */
/* ------------------------------------------------------------------ */

/** Mirrors `msg.rs`'s `MapTileEntry` exactly -- one laid hex tile. */
export interface MapTileEntry {
  q: number;
  r: number;
  tile_id: number;
  orientation: number;
  /** This tile's DISCRETE track segments as BASE (pre-rotation) edge pairs
   *  -- `msg::MapTileEntry::paths`, resolved contract-side through
   *  `hexmap::effective_base_tile_paths` (design note #119).
   *
   *  Each `[a, b]` is one continuous run of track between edges `a` and
   *  `b`; `a === b` is a terminal spur that enters at `a` and dead-ends.
   *  Apply `orientation` yourself, the same as for a catalog entry's
   *  `connections` -- `rotatePaths` below does it.
   *
   *  OPTIONAL on purpose, and the optionality is not decorative: this
   *  component renders against whatever a deployed contract actually
   *  returns, and a contract built before this field existed simply omits
   *  the key. `pathsForTile` treats `undefined` and `[]` identically and
   *  falls back to the local `TILE_CATALOG` mirror, so an older chain
   *  renders exactly as it did before rather than throwing. */
  paths?: ReadonlyArray<readonly [number, number]> | null;
  /** Design note #132: THIS TILE'S PRINTED REVENUE, straight off the chain
   *  -- `msg::MapTileEntry::revenue` (`hexmap::tile_base_value`, Audit
   *  G-11). The single authority for what a stop on this hex pays.
   *
   *  Typed `string | number` because the backend field is `Uint128`, and
   *  cosmwasm-std serialises `Uint128` as a JSON **string** (`"90"`), not a
   *  number -- it has to, since a `u128` overflows an IEEE-754 double past
   *  2^53. Reading this as `entry.revenue` and expecting arithmetic to work
   *  is the trap; `chainTileRevenue` below parses it in exactly one place.
   *  `number` is accepted too so a hand-built fixture or a future
   *  narrower-typed field needs no change here.
   *
   *  OPTIONAL for the same backwards-compatibility reason as `paths` above:
   *  a contract built before Audit G-11 simply omits the key, and
   *  `chainTileRevenue` returns `undefined` so the caller falls back to the
   *  old terrain bucket rather than printing `NaN` or `$0`.
   *
   *  NOT to be re-derived from `terrain`. That is what this replaces, and
   *  it was wrong for most city tiles: `terrainBaseValue` is a flat
   *  per-bucket lookup, but real 1830 prints revenue on the TILE. #62 and
   *  #64 are both two-city brown artwork and print different figures; the
   *  whole Green/Brown city ladder (#14/#15 at $30, #63 at $40) collapsed
   *  to one bucket value under the old model. */
  revenue?: string | number | null;
  landmark: string | null;
}

/** Design note #132: parses `MapTileEntry.revenue` -- the chain's own
 *  `Uint128`, which arrives as a JSON string -- into a number, or
 *  `undefined` if this contract predates the field.
 *
 *  `undefined` and `0` are DIFFERENT answers and callers must not conflate
 *  them: `0` is a real figure (plain connector track earns nothing, and the
 *  badge should be suppressed), `undefined` means "this chain never told
 *  us" (fall back to the terrain bucket). */
function chainTileRevenue(tile: MapTileEntry): number | undefined {
  const raw = tile.revenue;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Mirrors `msg.rs`'s `MapGridResponse` exactly -- `QueryMsg::GetMapGrid`'s
 *  response shape. */
export interface MapGridResponse {
  game_id: number;
  tiles: MapTileEntry[];
}

/** Structural shape this component needs from a chain query client --
 *  matches both `CosmWasmClient` and `SigningCosmWasmClient` from
 *  `@cosmjs/cosmwasm-stargate` without importing that package into this
 *  otherwise wallet-agnostic file (see design note #7). Any object with a
 *  compatible `queryContractSmart` (App.tsx's already-connected
 *  `SigningCosmWasmClient` included) satisfies this. */
export interface QueryCapableClient {
  queryContractSmart(contractAddress: string, queryMsg: Record<string, unknown>): Promise<unknown>;
}

/** Station Tokens (design note #36): a hand-kept SUBSET mirror of
 *  `utils/gameState.ts`'s `PublicCompanyState` -- only the fields this
 *  component's Station Token rendering pass actually needs, re-declared
 *  locally rather than imported (see design note #36 for why). Every
 *  field here is a direct, same-name, same-shape copy of its
 *  `PublicCompanyState`/`msg.rs::PublicCompanyState` counterpart. */
export interface StationTokenCompany {
  company_id: number;
  ticker: string;
  is_floated: boolean;
  /** `(q, r)` pairs, home hex first (if granted) -- mirrors
   *  `PublicCompanyState.station_token_hexes` exactly. */
  station_token_hexes: Array<[number, number]>;
  /** Design note #134: the SAME tokens as `station_token_hexes`, but as
   *  `(q, r, city_index)` -- mirrors `PublicCompanyState.station_tokens`
   *  (backend Audit G-12).
   *
   *  A hex is not a city. New York (#54/#62) and every OO tile
   *  (#59/#64-#68) carry two separate cities on one hex, and `(q, r)` alone
   *  cannot say which one holds this company's token -- which is why
   *  `stationMarkerPoint` used to guess from the hex label and drop tokens
   *  on the wrong half of a two-city tile.
   *
   *  OPTIONAL: a contract predating G-12 omits it, and `tokenCityIndex`
   *  below falls back to the old heuristic rather than throwing. An empty
   *  array alongside a non-empty `station_token_hexes` means "this chain
   *  doesn't know", never "no tokens". */
  station_tokens?: Array<[number, number, number]> | null;
}

/** Which city on `(q, r)` holds `company`'s token -- design note #134.
 *
 *  Prefers the chain's own answer. Returns `undefined` when the chain has
 *  not told us, which is a DIFFERENT answer from `0` and must stay
 *  distinguishable: the caller falls back to `stationMarkerPoint`'s legacy
 *  per-hex heuristic rather than asserting city 0 and confidently drawing a
 *  token in the wrong station. */
function tokenCityIndex(
  company: StationTokenCompany,
  q: number,
  r: number,
): number | undefined {
  const entry = company.station_tokens?.find(([tq, tr]) => tq === q && tr === r);
  return entry ? entry[2] : undefined;
}

/** Station Tokens (design note #36; REASSIGNED by design note #44's house
 *  rule): a local mirror of `hexmap::CORPORATION_HOME_HEX` -- all eight core
 *  corporations' preprinted home hex, sourced from this same file's own
 *  `LANDMARK_HEXES`/`GRAY_HEXES`/`YELLOW_OO_HEXES` entries above exactly the
 *  way the backend constant's own doc comment describes deriving it. As of
 *  design note #44 (mirroring `hexmap.rs` module doc comment #25's backend
 *  house rule), NYC (company_id 2) is reassigned to Albany (E19) and NNH
 *  (company_id 7, "NYNH") -- previously omitted for having no assigned home
 *  -- takes over the New York (G19) hex NYC vacated. This is a deliberate
 *  departure from real 1830 (where NYC's home is G19), requested three
 *  times, explicitly, by the same requester who owns this custom board. */
const STATION_HOME_HEXES: ReadonlyArray<{
  companyId: number;
  q: number;
  r: number;
  label: string;
}> = [
  { companyId: 1, q: 2, r: 7, label: "H12" }, // PRR -> Altoona
  { companyId: 2, q: 7, r: 4, label: "E19" }, // NYC -> Albany (house rule, design note #44)
  { companyId: 3, q: 9, r: 0, label: "A19" }, // CPR -> Montreal
  { companyId: 4, q: 3, r: 8, label: "I15" }, // B&O -> Baltimore
  { companyId: 5, q: 0, r: 5, label: "F6" }, // C&O -> Cleveland
  { companyId: 6, q: 3, r: 4, label: "E11" }, // ERIE -> Dunkirk & Buffalo (shared OO hex)
  { companyId: 7, q: 6, r: 6, label: "G19" }, // NNH ("NYNH") -> New York (house rule, design note #44)
  { companyId: 8, q: 9, r: 4, label: "E23" }, // B&M -> Boston
];

/** Station Tokens (design note #36): a small, deliberately DUPLICATED copy
 *  of `StockMarketRenderer.tsx`'s own `TICKER_COLORS` -- same values, same
 *  `company_id` keys. See design note #36 for why this is copied rather
 *  than imported. */
const STATION_TICKER_COLORS: Readonly<Record<number, string>> = {
  1: "#c0392b", // PRR
  2: "#2980b9", // NYC
  3: "#8e44ad", // CPR
  4: "#27ae60", // B&O
  5: "#d68910", // C&O
  6: "#16a085", // ERIE
  7: "#b03a2e", // NNH
  8: "#34495e", // B&M
};
const STATION_FALLBACK_TICKER_COLOR = "#5a6270";

function stationTickerColor(companyId: number): string {
  return STATION_TICKER_COLORS[companyId] ?? STATION_FALLBACK_TICKER_COLOR;
}

/** Corporate Acronym Overlay guarantee (design note #45): a small,
 *  deliberately DUPLICATED copy of `public_company.rs`'s own
 *  `CORE_PUBLIC_COMPANIES` real on-chain tickers (same values, same
 *  `company_id` keys, same "copy, don't import" reasoning as
 *  `STATION_TICKER_COLORS` above). Exists so a RESERVED/unfloated home
 *  station badge can always draw its acronym even before `publicCompanies`
 *  has loaded (or ever loads) real data for that company -- see the muted
 *  drawing pass below, which now prefers a live `company.ticker` when
 *  present but falls back to this static table instead of an empty string.
 *  Company 7's real ticker is `NNH`, not `NYNH` -- `public_company.rs`'s
 *  `CORE_PUBLIC_COMPANIES` (`(7, "NNH")`) is the single source of truth;
 *  "NYNH" is this project's own established colloquial name for the real
 *  New York, New Haven & Hartford railroad the request refers to (see
 *  design note #36's own note on this), not a second, different on-chain
 *  ticker -- using "NNH" here keeps this placeholder text identical to
 *  what `company.ticker` will actually show once the corporation floats,
 *  so the badge's acronym never visibly changes/flickers at that moment. */
const STATION_TICKER_LABELS: Readonly<Record<number, string>> = {
  1: "PRR",
  2: "NYC",
  3: "CPR",
  4: "B&O",
  5: "C&O",
  6: "ERIE",
  7: "NNH",
  8: "B&M",
};

function stationTickerLabel(companyId: number): string {
  return STATION_TICKER_LABELS[companyId] ?? "";
}

/** Crisp Token Typography (design note #46): WCAG relative luminance of a
 *  `#rrggbb` hex color -- the standard sRGB-to-linear formula, used below to
 *  pick whichever of pure white/pure black actually contrasts better
 *  against a given badge fill, rather than assuming one fixed choice works
 *  for every corporate color. */
function relativeLuminance(hex: string): number {
  const toLinear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLinear(parseInt(hex.slice(1, 3), 16));
  const g = toLinear(parseInt(hex.slice(3, 5), 16));
  const b = toLinear(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Crisp Token Typography (design note #46): returns whichever of pure
 *  white (`#FFFFFF`) or pure black (`#000000`) has the higher WCAG contrast
 *  ratio against `backgroundHex`, per the standard
 *  `(lighter + 0.05) / (darker + 0.05)` formula. See design note #46 for
 *  why this is picked dynamically per badge rather than one color asserted
 *  for every corporate ticker color -- several of `STATION_TICKER_COLORS`'s
 *  own established brand colors (duplicated from `StockMarketRenderer.tsx`,
 *  out of scope to re-tune here) don't actually reach the 7:1 AAA threshold
 *  against EITHER pure color alone; this always returns the better of the
 *  two available options, which is the closest a flat single-color badge
 *  fill can get without changing the brand palette itself. */
function bestContrastTextColor(backgroundHex: string): string {
  const bgLuminance = relativeLuminance(backgroundHex);
  const contrastWithWhite = 1.05 / (bgLuminance + 0.05);
  const contrastWithBlack = (bgLuminance + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? "#FFFFFF" : "#000000";
}

/** Mirrors `msg.rs`'s `LegalTilePlacement` exactly. */
export interface LegalTilePlacement {
  tile_id: number;
  orientation: number;
}

/** Mirrors `msg.rs`'s `LegalTilePlacementsResponse` exactly --
 *  `QueryMsg::GetLegalTilePlacements`'s response shape. */
export interface LegalTilePlacementsResponse {
  game_id: number;
  protocol_id: number;
  q: number;
  r: number;
  hex_label: string;
  placements: LegalTilePlacement[];
}

/** Discriminated union describing the click interceptor's in-flight/settled
 *  query state (see design note #7) -- reported to the host app via
 *  `onHexClickQuery` so `App.tsx` can decide when/where to render
 *  `<TileSelectionPopup />`. */
export type HexClickQueryState =
  | {
      status: "loading";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
    }
  | {
      status: "success";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      response: LegalTilePlacementsResponse;
    }
  | {
      status: "error";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      message: string;
    }
  /** Design note #120: no chain client is wired up, so
   *  `GetLegalTilePlacements` was never called and `placements` below came
   *  from the LOCAL `TILE_CATALOG` mirror, not from the contract.
   *
   *  A separate status rather than a flag on `"success"` on purpose. These
   *  placements are NOT contract-validated: they are era-gated and nothing
   *  more -- no connectivity check, no terrain reservation, no tile-tray
   *  depletion, no upgrade-color step. Folding them into `"success"` would
   *  let any existing or future consumer treat unvalidated data as
   *  authoritative simply by not knowing to check a flag, whereas a distinct
   *  variant makes the exhaustiveness checker point at every site that has
   *  to decide. Consumers MUST surface this to the player as provisional and
   *  MUST NOT dispatch a `LayTile` from it. */
  | {
      status: "offline";
      q: number;
      r: number;
      hexLabel: string;
      clientX: number;
      clientY: number;
      placements: LegalTilePlacement[];
    };

/** `DoubleTown` (item 1/2, structural calibration pass): a single hex
 *  printing TWO independent town stops -- Akron & Canton (G7), Reading &
 *  Allentown (G17), New Haven & Hartford (F20) on the real board. Mirrors
 *  `state::TerrainType::DoubleTown` in the Rust backend exactly.
 *
 *  `DoubleCityHub` (Tile Selection Catalog verification pass): the same
 *  "two stops, one hex" pattern as `DoubleTown`, but for the four
 *  preprinted OO double-city hexes (`YELLOW_OO_HEXES`) instead of an
 *  ordinary town. Mirrors `state::TerrainType::DoubleCityHub` exactly --
 *  see `hexmap.rs` module doc comment #18 for the full backend enforcement
 *  this terrain now drives (an OO hex can only ever be upgraded with this
 *  terrain's tile, never plain `MajorCityHub`). */
/* ------------------------------------------------------------------ */
/* Tile catalog -- EXTRACTED (monolith split, Phase 1)                  */
/* ------------------------------------------------------------------ */
//
// `TerrainType`, `TileColorTier`, `TileCatalogEntry`, the 46-entry
// `TILE_CATALOG` mirror of `hexmap::TILE_CATALOG`, `TILE_CATALOG_BY_ID` and
// both dev-only drift tripwires now live in `./hexTileCatalog`.
//
// Re-exported here rather than merely imported, because these are part of
// this component's PUBLIC surface -- `App.tsx` and `TileSelectionPopup.tsx`
// both import `TerrainType`/`TileCatalogEntry` from this module today. A
// re-export keeps every existing import path working, so the extraction is
// invisible to consumers and can be verified as a pure move: no call site
// changed, and `tsc` proves the graph still resolves.
//
// The matching `import` of the same names is at the TOP of this file, not
// here -- `import/first`. Only these `export ... from` statements may sit in
// the module body.
export type { TerrainType, TileColorTier, TileCatalogEntry } from "./hexTileCatalog";
export { TILE_CATALOG_SIZE, TILE_CATALOG_BY_ID } from "./hexTileCatalog";

/* ------------------------------------------------------------------ */
/* Board data -- EXTRACTED (monolith split, Phase 2)                    */
/* ------------------------------------------------------------------ */
//
// Every static table describing the 1830 board -- hexes, landmarks, gray
// hexes, off-board terminals, palettes, terrain fees -- now lives in
// `./hexBoardData`, along with the pure lookups over them. The `import` is at
// the TOP of this file, not here: `import/first` requires every import to
// precede all other statements.


/* ------------------------------------------------------------------ */
/* Hex geometry (pointy-top axial) -- see design note #1              */
/* ------------------------------------------------------------------ */

/** Pointy-top axial `(q, r)` -> pixel center, standard conversion. */
function axialToPixel(q: number, r: number, size: number): { x: number; y: number } {
  return {
    x: size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    y: size * (1.5 * r),
  };
}

/** Edge `i`'s direction angle, in radians, from a tile's center -- see
 *  design note #1 for why this is `-60 * i`, not `+60 * i`. */
function edgeAngleRad(edgeIndex: number): number {
  return (-60 * edgeIndex * Math.PI) / 180;
}

/** Hexagon corner `i`'s direction angle, in radians -- offset 30deg ahead
 *  of edge `i`'s own angle, so corner `i` and corner `(i + 1) % 6` flank
 *  edge `i` on either side. */
function cornerAngleRad(cornerIndex: number): number {
  return ((30 - 60 * cornerIndex) * Math.PI) / 180;
}

function pointOnCircle(
  center: { x: number; y: number },
  radius: number,
  angleRad: number,
): { x: number; y: number } {
  return {
    x: center.x + radius * Math.cos(angleRad),
    y: center.y + radius * Math.sin(angleRad),
  };
}

/** Axial-coordinate neighbor offsets, indexed by edge (0-5) -- byte-for-byte
 *  the same six deltas as the backend's `hexmap::HEX_NEIGHBOR_OFFSETS`
 *  (design note #1's own source for `edgeAngleRad`'s `-60 * i` derivation),
 *  finally given its own named constant here rather than staying implicit.
 *  Edge `i` on a tile at `(q, r)` touches the tile at `(q +
 *  HEX_NEIGHBOR_OFFSETS[i][0], r + HEX_NEIGHBOR_OFFSETS[i][1])`. */
const HEX_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Whether ANY real board hex -- landmark, ordinary track/blank hex, or
 *  off-board revenue terminal -- is defined at `(q, r)`. `LANDMARK_HEXES`
 *  and `STATIC_BOARD_HEXES` together are this file's complete 93-hex board
 *  (an off-board hex like Chicago is still a `STATIC_BOARD_HEXES` entry,
 *  just one `OFFBOARD_LABELS` also names -- very much a place real track
 *  points AT, so it counts as "exists" here, unlike a coordinate with no
 *  entry in either table at all, which is genuinely empty canvas space
 *  outside the board's actual footprint). Used by `deadEdgesAt` below. */
function boardHexExistsAt(q: number, r: number): boolean {
  return (
    LANDMARK_HEXES.some((l) => l.q === q && l.r === r) ||
    STATIC_BOARD_HEXES.some((h) => h.q === q && h.r === r)
  );
}

/** Design note #39: edges of hex `(q, r)` whose neighboring coordinate
 *  isn't a real board hex at all (see `boardHexExistsAt`) -- e.g. Baltimore
 *  (I15)'s edge 5 (SE), which points off the printed board's actual
 *  footprint entirely, unlike its edges 0/E (toward I17) and 4/SW (toward
 *  J14, Washington), both real neighboring hexes a route could eventually
 *  extend through. An edge in this set can NEVER carry live track from
 *  either side, for any tile, ever -- there's nothing there to build a
 *  connecting tile on -- making it a strictly stronger, permanent
 *  guarantee than "not currently live." `drawValueBadge` uses this to
 *  prefer parking a badge next to a permanently dead edge over one that's
 *  merely not live *yet* (module doc comment on `BADGE_CORNERS` has the
 *  full reasoning, including why this generalizes past landmarks to every
 *  gray-hex/laid-tile badge too). */
function deadEdgesAt(q: number, r: number): number[] {
  const dead: number[] = [];
  for (let edge = 0; edge < 6; edge++) {
    const [dq, dr] = HEX_NEIGHBOR_OFFSETS[edge];
    if (!boardHexExistsAt(q + dq, r + dr)) dead.push(edge);
  }
  return dead;
}

/* ------------------------------------------------------------------ */
/* Margin label sizing -- shared between the camera fit and the label */
/* placement itself (see design note re: "Vertical Margin Label       */
/* Clearance" / the follow-up "Camera Padding Must Reserve Room For   */
/* Margin Labels" pass)                                               */
/* ------------------------------------------------------------------ */
//
// `boardContentBounds` (the camera's own fit/pan/zoom bounds, computed as a
// plain `useMemo` with no canvas context available yet) and
// `computeBoardMarginLabels` (the exact per-label placement, computed later
// WITH a real `ctx` to call `measureText`) both need to agree on how much
// extra room, beyond each edge hex's own true rendered corner, is reserved
// for the row/column labels drawn just outside the board. If the camera
// reserves less than the label placement actually needs, labels get
// clipped off the visible canvas; if the camera reserves less than the
// hex's own corner-to-label distance, labels render ON TOP of the
// outermost hex instead of outside it (the original bug report). A prior
// pass (design note #26) tightened `boardContentBounds`'s padding to
// exactly `hexSize` -- precisely the hex's own center-to-corner radius,
// with ZERO slack left over for anything drawn beyond that corner. That
// was fine for hiding excess dead space around the board, but it silently
// left no room at all for margin labels, which is the deeper reason
// column-number labels (whose necessary clearance sits right at that
// zero-slack corner point, see the comment on `computeBoardMarginLabels`'s
// Y-axis budget) kept overlapping the top/bottom hexes even after the
// width-vs-height measurement bug was fixed. This constant/helper pair
// restores a SMALL, proportional (not a large flat pixel constant)
// reservation sized off `hexSize`/`fontSize` alone, so both call sites can
// derive the identical value without either one needing a canvas context.
export const MARGIN_LABEL_BACKGROUND_PADDING_PX = 4;
export const MARGIN_LABEL_EXTRA_INSET_PX = 8;

/** The exact font size `drawBoardMarginLabels` renders margin labels at --
 *  a single shared formula so nothing else has to re-derive or guess it. */
function marginLabelFontSize(hexSize: number): number {
  return Math.max(11, hexSize * 0.3);
}

/** How much extra room, beyond a hex's own true center-to-corner radius
 *  (`hexSize`), the camera must additionally reserve so a margin label can
 *  be drawn just outside that corner without being clipped by the
 *  camera's own edge. This is an ESTIMATE (no canvas context is available
 *  where `boardContentBounds` needs it) -- `computeBoardMarginLabels`
 *  still does its own exact `ctx.measureText` pass for the real placement;
 *  this only has to be generous enough that the exact pass never needs
 *  more room than the camera already set aside. Two-character column
 *  numbers ("10" .. "22") are the widest/tallest labels this board ever
 *  draws, so a `1.4x` multiplier on the font size comfortably covers a
 *  bold sans-serif digit pair's rendered box in either dimension, without
 *  hardcoding an absolute pixel value disconnected from `hexSize`. */
function marginLabelReserve(hexSize: number): number {
  const fontSize = marginLabelFontSize(hexSize);
  return fontSize * 1.4 + MARGIN_LABEL_BACKGROUND_PADDING_PX + MARGIN_LABEL_EXTRA_INSET_PX;
}

/** Rotates a 6-bit edge bitmask by `orientation` steps (0-5) -- a direct
 *  TypeScript port of `hexmap::rotate_connections`, kept bit-for-bit
 *  identical so a laid tile's actual on-screen edges always match what
 *  the contract itself considers "live" at that orientation. */
function rotateConnections(mask: number, orientation: number): number {
  const o = ((orientation % 6) + 6) % 6;
  const m = mask & 0b111111;
  if (o === 0) return m;
  return ((m << o) | (m >> (6 - o))) & 0b111111;
}

/* Design note #121 removed `rotatePaths` and `pathsForTile` from here.
   Both existed only to feed the generalized double-town renderer that
   `DOUBLE_TOWN_ROUTES` replaced: `rotatePaths` turned catalog edge pairs
   into rotated ones, and `pathsForTile` picked query data over the mirror.
   The explicit artwork table keys on `tileId` and rotates its own two edges
   inline, so neither had a caller left. `msg::MapTileEntry::paths` is still
   populated by the contract and still mirrored on `TileCatalogEntry.paths`
   -- the mirror now feeds the drift tripwire beside that table -- but this
   renderer no longer reads the per-tile query value for artwork. */

/** Every `(tile_id, orientation)` pairing in the LOCAL catalog mirror --
 *  design note #120's offline fallback for the tile picker, used only when
 *  no chain client is wired up.
 *
 *  Design note #125: this no longer filters by era. It used to return only
 *  the tiers a room in `currentEra` had unlocked, which meant a fresh
 *  offline session showed the twelve Yellow tiles and nothing else, with no
 *  way to reach the other thirty-four -- the player was stuck looking at one
 *  tray. Offline mode exists to INSPECT the catalog, and `TileSelectionPopup`
 *  now has era tabs to browse it, so the filtering moved there where it is a
 *  view control the player can change rather than a wall.
 *
 *  This does not weaken any rule, because it was never enforcing one. The
 *  result carries no legality claim of any kind: no era lock, no track
 *  connectivity, no landmark/OO/"B"/"NY" reservation, no upgrade colour
 *  step, no tray depletion. That is why it goes out under the `"offline"`
 *  status the UI must label as provisional and must not dispatch from --
 *  reimplementing `hexmap::legal_tile_placements` here would create a second
 *  copy of the rules to drift out of sync, the exact hazard
 *  `TileSelectionPopup`'s design note #4 exists to prevent.
 *
 *  All six orientations are offered for every tile, since without the
 *  contract there is no basis for excluding any of them. */
function localCatalogPlacements(): LegalTilePlacement[] {
  const placements: LegalTilePlacement[] = [];
  for (const entry of TILE_CATALOG) {
    for (let orientation = 0; orientation < 6; orientation++) {
      placements.push({ tile_id: entry.tileId, orientation });
    }
  }
  return placements;
}

function liveEdges(mask: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i < 6; i++) {
    if (mask & (1 << i)) edges.push(i);
  }
  return edges;
}

/** Inverse of `axialToPixel` for pointy-top axial hexes, followed by cube
 *  rounding -- the standard redblobgames algorithm. `x`/`y` must already be
 *  in the hex layer's own untransformed coordinate space (i.e. with the
 *  canvas's pan/zoom already divided out by the caller -- see
 *  `handlePointerUp` below, which undoes `draw()`'s own
 *  `ctx.translate`/`ctx.scale` before calling this). */
function pixelToAxial(x: number, y: number, size: number): { q: number; r: number } {
  const qFrac = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const rFrac = ((2 / 3) * y) / size;
  return axialRound(qFrac, rFrac);
}

/** Standard cube-coordinate rounding: converts fractional axial `(q, r)` to
 *  cube `(x, y, z)` with `x + y + z === 0`, rounds each axis independently,
 *  then re-derives whichever axis had the largest rounding error from the
 *  other two so the zero-sum invariant still holds -- the textbook
 *  "which hex is under this pixel" hit-testing algorithm. */
function axialRound(qFrac: number, rFrac: number): { q: number; r: number } {
  const xFrac = qFrac;
  const zFrac = rFrac;
  const yFrac = -xFrac - zFrac;

  let x = Math.round(xFrac);
  let y = Math.round(yFrac);
  let z = Math.round(zFrac);

  const xDiff = Math.abs(x - xFrac);
  const yDiff = Math.abs(y - yFrac);
  const zDiff = Math.abs(z - zFrac);

  if (xDiff > yDiff && xDiff > zDiff) {
    x = -y - z;
  } else if (yDiff > zDiff) {
    y = -x - z;
  } else {
    z = -x - y;
  }

  return { q: x, r: z };
}

/** Dynamic City Nameplate Suppression (design note #47): true once a real
 *  tile (any color -- Yellow, Green, or Brown) has actually been laid at
 *  `(q, r)`. Physical-board parity: in real 1830, laying a tile physically
 *  covers the hex's preprinted city name -- every preprinted-name drawing
 *  pass below now skips its text once this is true, matching that. Shares
 *  the exact `mapGrid.tiles.find((t) => t.q === q && t.r === r)` lookup
 *  this file's OTHER `mapGrid`-aware passes already use (the laid-tile fill
 *  pass, the click interceptor's own `laidTile` lookup) rather than a new
 *  pattern. Deliberately NOT applied to `drawOffboardNameplate`'s zone
 *  names -- an off-board hex can never receive a laid tile at all (Off-
 *  Board Reservation, `hexmap.rs` module doc comment #14), so that check
 *  would always be false there anyway; nor to the value-badge pass further
 *  below, which this request's own "text plate" wording didn't ask to
 *  change. */
function hexHasLaidTile(mapGrid: MapGridResponse, q: number, r: number): boolean {
  return mapGrid.tiles.some((tile) => tile.q === q && tile.r === r);
}

/** ================================================================
 *  UNIVERSAL CANVAS LAYOUT ENGINE (design note #55)
 *  ================================================================
 *  Every hex's station-node/nameplate/badge placement is derived from ONE
 *  shared classifier, `archetypeForHex`, rather than one-off per-hex-name
 *  branches scattered across the file. The rule this section enforces: NO
 *  rendering code may ever branch on a specific hex's `label`/`name`/`q,r`
 *  literal (e.g. `hex.label === "G19"`, `name === "Boston"`) to decide
 *  WHERE something gets drawn -- only on STRUCTURAL tile/terrain data that
 *  would classify identically for any other hex with the same real
 *  properties. Genuine per-hex DATA (a city's own name string, a
 *  landmark's own real sourced printed-track edges in `LANDMARK_TRACKS`,
 *  which tile artwork is legal where) is not itself a "hack" -- every board
 *  game inherently has per-hex facts -- so those tables stay untouched;
 *  what changes is that no PLACEMENT FORMULA is keyed off hex identity
 *  anymore, only off which of the four archetypes below a hex's REAL
 *  current tile/terrain data resolves to. */
export type HexArchetype = "SingleCity" | "DoubleCity" | "SingleTown" | "DoubleTown" | "Plain";

/** Structural terrain -> archetype mapping -- every `TerrainType` maps to
 *  exactly one archetype, purely by what KIND of city/town it draws (one
 *  station node vs two), never by which specific tile id or hex it is.
 *  `MajorCityHub`/`BostonHub` share "SingleCity" because they both draw
 *  exactly one station node (Boston's own hub artwork just happens to also
 *  carry the "B" label restriction, a legality concern unrelated to
 *  layout); `DoubleCityHub`/`NewYorkHub` share "DoubleCity" for the
 *  identical reason on the two-node side. */
function archetypeForTerrain(terrain: TerrainType): HexArchetype {
  switch (terrain) {
    case "MajorCityHub":
    case "BostonHub":
      return "SingleCity";
    case "DoubleCityHub":
    case "NewYorkHub":
      return "DoubleCity";
    case "SmallTown":
      return "SingleTown";
    case "DoubleTown":
      return "DoubleTown";
    default:
      return "Plain";
  }
}

/** Classifies hex `(q, r)` into its rendering archetype. A laid tile's REAL
 *  current terrain wins when one exists (via `TILE_CATALOG_BY_ID`, the same
 *  lookup every other laid-tile-aware pass in this file already uses);
 *  otherwise falls back to the hex's own static pre-printed category --
 *  OO membership, town designation, city designation, or a real GRAY hex's
 *  marker kind. Every branch here reads a STRUCTURAL field (a Set
 *  membership test, an enum tag, an array length) rather than comparing a
 *  name/label string, so adding a new hex to any of the underlying data
 *  tables classifies correctly with zero changes to this function. */
function archetypeForHex(mapGrid: MapGridResponse, q: number, r: number): HexArchetype {
  const laidTile = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry) return archetypeForTerrain(catalogEntry.terrain);
  }
  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  if (boardHex) {
    if (YELLOW_OO_HEXES.has(boardHex.label)) return "DoubleCity";
    if (boardHex.townDesignation === "double") return "DoubleTown";
    if (boardHex.townDesignation === "single") return "SingleTown";
    if (boardHex.cityDesignation) return "SingleCity";
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack?.marker === "city") return "SingleCity";
    if (grayTrack?.marker === "town") return "SingleTown";
  }
  // A landmark's un-laid archetype is read off the STRUCTURE of its own
  // real printed track (`LANDMARK_TRACKS`, design note #6b's sourced data):
  // two independent one-edge stub segments means two independent stations
  // (New York's real "one hex, two disconnected stations" design) --
  // "DoubleCity" -- while any other segment count means one shared station
  // -- "SingleCity". This is a STRUCTURAL read (segment count), not a name
  // check: a hypothetical future landmark would classify correctly the
  // same way without touching this function, purely from how many
  // segments ITS OWN `LANDMARK_TRACKS` entry happens to have.
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    const segments = LANDMARK_TRACKS[landmark.name] ?? [];
    return segments.length >= 2 ? "DoubleCity" : "SingleCity";
  }
  return "Plain";
}

/* ------------------------------------------------------------------ */
/* 13-Slot Perimeter Anchor System (design note #70)                  */
/* ------------------------------------------------------------------ */
//
// A single pointy-topped-hex coordinate system every label/badge placement
// pass in this file resolves its anchor point through, instead of each
// pass hand-deriving its own corner/edge math (the old `BADGE_CORNERS`
// tiered search, the fixed-literal corner in `drawRestrictionBadge`, the
// fixed lower-third offset for terrain cost labels, the fixed upper-left
// `singleNodeNameplateAnchor`). Thirteen slots per hex:
//   - Slot 0: hex center.
//   - Slots 1-6: the six EDGE MIDPOINTS, in clockwise order starting from
//     Top-Right (NE): Top-Right, Right, Bottom-Right, Bottom-Left, Left,
//     Top-Left. "Right"/"Left" (slots 2/5) are the two VERTICAL edges --
//     this file's hexes are already pointy-topped (see `axialToPixel`/
//     `edgeAngleRad`/`cornerAngleRad`'s own geometry: edge 0/E and edge
//     3/W sit at screen-horizontal, corner 2 and corner 5 sit at true
//     screen-top/bottom -- unchanged by this pass, just made explicit
//     here as this system's own documented baseline).
//   - Slots 7-12: the six CORNER VERTICES, in clockwise order starting
//     from the Top Point: Top Point, Upper-Right, Lower-Right, Bottom
//     Point, Lower-Left, Upper-Left.
// `EDGE_SLOT_TO_EDGE_INDEX`/`CORNER_SLOT_TO_CORNER_INDEX` below are the
// fixed permutation tables translating this slot numbering onto the
// file's own pre-existing `edgeAngleRad`/`cornerAngleRad` index
// conventions (0=E/1=NE/2=NW/3=W/4=SW/5=SE for edges; corner `i` at
// `(30 - 60*i)` degrees) -- verified by hand against every one of
// `BADGE_CORNERS`' four existing `guardEdges` entries before this system
// replaced it (see `drawValueBadge`'s own call site below).
//
// SCOPE: this system positions LABELS/BADGES ONLY -- nameplates, tile
// upgrade-restriction badges, terrain cost labels, and revenue badges.
// It does NOT touch backend state rules or station/token node coordinates
// (`stationMarkerPoint`, `twoNodePositions`, `doubleNodeOffset`,
// `drawBadgeShape`'s own shape geometry) -- those keep their own existing,
// independently-tuned formulas, entirely untouched by this pass.

const EDGE_SLOT_TO_EDGE_INDEX: readonly number[] = [1, 0, 5, 4, 3, 2];
// slot 1 = Top-Right (edge 1/NE)      slot 4 = Bottom-Left (edge 4/SW)
// slot 2 = Right/Vertical (edge 0/E)  slot 5 = Left/Vertical (edge 3/W)
// slot 3 = Bottom-Right (edge 5/SE)   slot 6 = Top-Left (edge 2/NW)

const CORNER_SLOT_TO_CORNER_INDEX: readonly number[] = [2, 1, 0, 5, 4, 3];
// slot 7 = Top Point (corner 2)       slot 10 = Bottom Point (corner 5)
// slot 8 = Upper-Right (corner 1)     slot 11 = Lower-Left (corner 4)
// slot 9 = Lower-Right (corner 0)     slot 12 = Upper-Left (corner 3)

/** The actual pixel point for `slot` (0-12) -- slot 0 at raw `center`,
 *  slots 1-6 at `apothem` distance (an edge midpoint), slots 7-12 at the
 *  full `size` corner-vertex distance. Most label passes DON'T draw
 *  exactly here (a revenue badge still uses its own tuned `size * 0.65`
 *  mid-radius offset -- design note #109, was `0.44`, then briefly `0.38`,
 *  then `0.55` -- a nameplate its own `-0.25/-0.35` wedge, etc. -- see
 *  each call site) -- this gives the raw geometric reference point; `hexSlotDirection`
 *  gives just the unit direction for callers that want to scale it
 *  themselves. */
function hexSlotPoint(center: { x: number; y: number }, size: number, slot: number): { x: number; y: number } {
  if (slot === 0) return center;
  if (slot >= 1 && slot <= 6) {
    const apothem = size * (Math.sqrt(3) / 2);
    return pointOnCircle(center, apothem, edgeAngleRad(EDGE_SLOT_TO_EDGE_INDEX[slot - 1]));
  }
  return pointOnCircle(center, size, cornerAngleRad(CORNER_SLOT_TO_CORNER_INDEX[slot - 7]));
}

/** The unit direction vector for `slot` (0-12) -- `{x:0,y:0}` for slot 0
 *  (center has no direction), otherwise `hexSlotPoint` evaluated at
 *  `size=1` around the origin. Lets a caller keep its own existing
 *  magnitude/offset convention (e.g. `drawValueBadge`'s `size * 0.65`
 *  mid-radius (design note #109, was `0.44`, then briefly `0.38`, then
 *  `0.55`), `singleNodeNameplateAnchor`'s `-0.25/-0.35` wedge) while
 *  still picking WHICH of the 13 directions to use via this system's
 *  occupancy-aware slot selection. */
function hexSlotDirection(slot: number): { x: number; y: number } {
  if (slot === 0) return { x: 0, y: 0 };
  return hexSlotPoint({ x: 0, y: 0 }, 1, slot);
}

/** The two edge indices (this file's own 0-5 convention) that flank corner
 *  slot `slot` (7-12) -- e.g. corner slot 12 (Upper-Left, corner index 3)
 *  is flanked by edge 2 (NW) and edge 3 (W). Verified against every one of
 *  the old `BADGE_CORNERS` table's four `guardEdges` entries before that
 *  table was replaced by this system (lower-left -> `[3,4]`, lower-right
 *  -> `[5,0]`, upper-left -> `[2,3]`, upper-right -> `[1,0]`, all
 *  reproduced exactly by `(cornerIndex + 5) % 6, cornerIndex`). */
function cornerSlotGuardEdges(slot: number): readonly [number, number] {
  const cornerIndex = CORNER_SLOT_TO_CORNER_INDEX[slot - 7];
  return [(cornerIndex + 5) % 6, cornerIndex];
}

/** Which of the 13 slots does `edgeIndices` (this file's own 0-5
 *  convention -- either a hex's real LIVE track edges, or, reused for the
 *  "prefer a permanently dead edge" tier below, its `deadEdgesAt` edges)
 *  make unusable: an edge-midpoint slot (1-6) is unusable if that exact
 *  edge is in the set; a corner slot (7-12) is unusable if EITHER of its
 *  two `cornerSlotGuardEdges` is (a curve between adjacent live edges
 *  bows toward the corner between them). `centerBlocked` marks slot 0
 *  directly -- computed by the caller (`hexBlockedSlots` below) from
 *  archetype + live-edge occupancy, not from this function, since "is the
 *  center occupied" isn't a pure function of an edge set the way the
 *  other 12 slots are (see that function's own doc comment). */
function slotsBlockedByEdges(edgeIndices: readonly number[], centerBlocked: boolean): Set<number> {
  const blocked = new Set<number>();
  if (centerBlocked) blocked.add(0);
  const edgeSet = new Set(edgeIndices);
  for (let slot = 1; slot <= 6; slot++) {
    if (edgeSet.has(EDGE_SLOT_TO_EDGE_INDEX[slot - 1])) blocked.add(slot);
  }
  for (let slot = 7; slot <= 12; slot++) {
    const [a, b] = cornerSlotGuardEdges(slot);
    if (edgeSet.has(a) || edgeSet.has(b)) blocked.add(slot);
  }
  return blocked;
}

/** This hex's real, structural live track edges (this file's own 0-5
 *  convention), from whichever real source actually applies -- a laid
 *  tile's own rotated `connections` mask, a real `GRAY_HEXES`/
 *  `OFFBOARD_TRACKS` printed-track entry, or a landmark's `LANDMARK_TRACKS`
 *  segments flattened -- mirroring `archetypeForHex`'s own exact
 *  fallback order so the two functions always agree on which hex they're
 *  describing. Empty for a hex with no real track at all (a blank
 *  designation, or an unlaid Mountain/River terrain hex). */
function liveEdgesForHex(mapGrid: MapGridResponse, q: number, r: number): number[] {
  const laidTile = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry) return liveEdges(rotateConnections(catalogEntry.connections, laidTile.orientation));
  }
  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  if (boardHex) {
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack) return [...grayTrack.edges];
    const offboardEdges = OFFBOARD_TRACKS[boardHex.label];
    if (offboardEdges) return [...offboardEdges];
  }
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    const segments = LANDMARK_TRACKS[landmark.name] ?? [];
    return segments.flatMap((segment) => [...segment.edges]);
  }
  return [];
}

/** The full blocked-slot set for hex `(q, r)` -- Requirement 3's "mark
 *  Slot 0 BLOCKED if a track spline or single-city station circle
 *  occupies (0,0); mark perimeter slots near active track BLOCKED"
 *  evaluated for real. Center is occupied by a `SingleCity`/`SingleTown`
 *  archetype's own always-central station/dit circle (`drawStationCircle`/
 *  `drawDitMarker` both draw AT `center` for these two archetypes,
 *  unconditionally), OR by ordinary track passing through it (any hex
 *  with live edges that ISN'T `DoubleCity`/`DoubleTown` -- those two
 *  archetypes route their track to their own off-center station nodes
 *  instead, by construction, see `twoCityStationPoints`'s and design note
 *  #52's own "wrong to fan through one shared center point" reasoning --
 *  so a `DoubleCity`/`DoubleTown` hex's center is NEVER occupied,
 *  regardless of how many live edges it has, which is exactly why every
 *  OO/G19/double-town nameplate already renders dead-center). */
function hexBlockedSlots(mapGrid: MapGridResponse, q: number, r: number): Set<number> {
  const archetype = archetypeForHex(mapGrid, q, r);
  const edges = liveEdgesForHex(mapGrid, q, r);
  const isDoubleArchetype = archetype === "DoubleCity" || archetype === "DoubleTown";
  const centerBlocked =
    archetype === "SingleCity" || archetype === "SingleTown" || (edges.length > 0 && !isDoubleArchetype);
  return slotsBlockedByEdges(edges, centerBlocked);
}

/** Design note #104: each perimeter slot (1-12) sits at a fixed 30-degree
 *  increment around the hex -- edge slots at 0/60/120/180/240/300, corner
 *  slots at 30/90/150/210/270/330 (hand-derived from `hexSlotDirection`'s
 *  own `edgeAngleRad`/`cornerAngleRad` calls: `EDGE_SLOT_TO_EDGE_INDEX`/
 *  `CORNER_SLOT_TO_CORNER_INDEX` resolve to exactly this alternating
 *  edge/corner/edge/corner sequence, verified by hand for all twelve before
 *  writing this table). Slot 0 (center) has no angle -- it's a genuinely
 *  distinct location, not a point on the perimeter, so it's `undefined`
 *  here and always treated as angularly compatible with everything below. */
const SLOT_ANGLE_DEG: readonly (number | undefined)[] = [
  undefined, // slot 0: center
  300, // slot 1 (edge, NE)
  0, // slot 2 (edge, E)
  60, // slot 3 (edge, SE)
  120, // slot 4 (edge, SW)
  180, // slot 5 (edge, W)
  240, // slot 6 (edge, NW)
  270, // slot 7 (corner, Top Point)
  330, // slot 8 (corner, Upper-Right)
  30, // slot 9 (corner, Lower-Right)
  90, // slot 10 (corner, Bottom Point)
  150, // slot 11 (corner, Lower-Left)
  210, // slot 12 (corner, Upper-Left)
];

/** Design note #104: the minimum angular separation (degrees) this file now
 *  enforces between two claimed slots on the SAME hex, per explicit
 *  request -- e.g. Slot 10 (Bottom Point, 90 deg) and Slot 9 (Lower-Right
 *  corner, 30 deg) are only 60 deg apart and read as visually crowded
 *  together; Slot 10 and Slot 7 (Top Point, 270 deg, exactly opposite) or
 *  Slot 1 (edge, 300 deg, 150 deg away) read as cleanly separated. */
const MIN_SLOT_ANGULAR_SEPARATION_DEG = 120;

/** The shortest angular distance (0-180 degrees) between perimeter slots
 *  `a` and `b`. Slot 0 (center) has no angle (`SLOT_ANGLE_DEG[0]` is
 *  `undefined`) and is always treated as maximally separated from
 *  everything -- it's a distinct location, not a competing point on the
 *  same 30-degree ring, so it never counts as "crowding" a perimeter
 *  slot or vice versa. */
function slotAngularSeparationDeg(a: number, b: number): number {
  const angleA = SLOT_ANGLE_DEG[a];
  const angleB = SLOT_ANGLE_DEG[b];
  if (angleA === undefined || angleB === undefined) return 180;
  const diff = Math.abs(angleA - angleB) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Design note #104: which perimeter slots (1-12) are angularly too close
 *  (< `MIN_SLOT_ANGULAR_SEPARATION_DEG`) to any slot already in
 *  `claimedSlots` on this same hex -- i.e., slots that AREN'T literally
 *  already taken (`claimHexSlot`'s own exact-slot check already prevents
 *  that) but would still visually crowd an already-placed nameplate/badge/
 *  icon. Consulted by `pickHexSlot` as an extra soft-avoid layer, on top
 *  of (not replacing) the real track/claim blocking it already does. Slot
 *  0 (center) is never returned here (it doesn't compete with perimeter
 *  slots -- see `slotAngularSeparationDeg`) and an empty `claimedSlots`
 *  (the overwhelming majority of hexes -- at most one or two features)
 *  yields an empty result, so this is a no-op until a hex is genuinely
 *  crowded enough to have multiple claims already on it. */
function angularConflictSlots(claimedSlots: ReadonlySet<number>): Set<number> {
  const conflicts = new Set<number>();
  // `forEach`, not `for...of` -- iterating a `Set` directly requires
  // `--downlevelIteration`/an ES2015+ target, which this project's `es5`
  // target doesn't have (`tsc` TS2802), same reasoning `claimHexSlot`
  // itself already documents at its own `combinedBlocked` construction.
  claimedSlots.forEach((claimedSlot) => {
    if (claimedSlot === 0) return;
    for (let slot = 1; slot <= 12; slot++) {
      if (slotAngularSeparationDeg(slot, claimedSlot) < MIN_SLOT_ANGULAR_SEPARATION_DEG) {
        conflicts.add(slot);
      }
    }
  });
  return conflicts;
}

/** Runs the real 6-tier preference search (see `pickHexSlot`'s own doc
 *  comment for the tier list) STRICTLY within `candidates`, in the order
 *  given, returning `undefined` if nothing in `candidates` is even open.
 *  Factored out by design note #106 so `pickHexSlot` can run this once
 *  against a caller's real, curated preference list and only fall through
 *  to a second, separate run against the "no real preference" fallback
 *  tail if EVERY candidate in the real list is unusable -- see that design
 *  note for why the two lists must never be searched as one flat scan. */
function pickFromCandidates(
  candidates: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  angularConflict: ReadonlySet<number>,
): number | undefined {
  const softBlocked = new Set<number>();
  blockedSlots.forEach((s) => softBlocked.add(s));
  angularConflict.forEach((s) => softBlocked.add(s));
  return (
    candidates.find((slot) => !softBlocked.has(slot) && deadEdgeSlots.has(slot)) ??
    candidates.find((slot) => deadEdgeSlots.has(slot) && !angularConflict.has(slot)) ??
    candidates.find((slot) => !softBlocked.has(slot)) ??
    candidates.find((slot) => !blockedSlots.has(slot) && deadEdgeSlots.has(slot)) ??
    candidates.find((slot) => deadEdgeSlots.has(slot)) ??
    candidates.find((slot) => !blockedSlots.has(slot))
  );
}

/** Picks the best slot from `candidateSlots` (a caller-supplied preference
 *  order -- e.g. corners-only for a badge, or every slot for a nameplate)
 *  using the same 4-tier preference `drawValueBadge`'s old bespoke
 *  `BADGE_CORNERS` search used (design note #39's "prefer a permanently
 *  dead edge over a merely not-currently-live one" reasoning, generalized
 *  past just badges to every slot-based placement in the file):
 *   1. Open AND adjacent to a permanently dead edge (`deadEdgeSlots`) --
 *      both no current collision risk AND a structural guarantee no
 *      FUTURE track can ever appear there either.
 *   2. Adjacent to a dead edge even if currently blocked by something
 *      else (a name label, say) -- still permanently track-safe.
 *   3. Simply open (not in `blockedSlots`).
 *   4. Nothing matched -- the first candidate anyway, the closest this
 *      model can get without full custom per-hex placement.
 *
 *  Design note #104: `angularConflict` (this same hex's already-claimed
 *  slots run through `angularConflictSlots` -- see that function's own doc
 *  comment) is folded into tiers 1-3 as an EXTRA soft-avoid layer, tried
 *  FIRST: a slot within `MIN_SLOT_ANGULAR_SEPARATION_DEG` of an existing
 *  claim on this hex is treated the same as a blocked one for this first
 *  pass, so two features on the same crowded hex land genuinely spread out
 *  rather than merely non-overlapping. If NO candidate can satisfy both
 *  real-collision-avoidance and angular separation at once, this
 *  degrades to the original (pre-#104) 4-tier search below, ignoring
 *  angular spacing -- a genuinely packed hex still gets a real,
 *  collision-avoiding slot rather than none; angular crowding there is
 *  the lesser evil.
 *
 *  Design note #106: reported via D6 -- a blank hex with a plain terrain
 *  cost badge and NOTHING blocking its actual first-choice preference
 *  (Vertex 3/slot10) still rendered at Edge 5/slot6 instead. Root cause:
 *  `claimHexSlot` used to pre-merge the caller's real preference list with
 *  `extendSlotPreference`'s "no real preference, last resort" fallback
 *  tail into ONE combined list before calling this function, and tiers 1-2
 *  above (the dead-edge tiers) scanned that WHOLE combined list -- so a
 *  low-priority fallback-tail slot that merely happened to sit next to a
 *  dead edge could leapfrog a genuinely open, actually-preferred PRIMARY
 *  slot that had no dead-edge adjacency of its own. `candidateSlots` here
 *  is now ONLY the caller's real preference list (never pre-extended);
 *  `fallbackTail` is searched, with this exact same tier order, ONLY once
 *  every entry in `candidateSlots` has been tried and failed -- so the
 *  fallback tail can never outrank an available primary-preference slot,
 *  dead-edge-adjacent or not. */
function pickHexSlot(
  candidateSlots: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  angularConflict: ReadonlySet<number> = new Set(),
  fallbackTail: readonly number[] = [],
): number {
  return (
    pickFromCandidates(candidateSlots, blockedSlots, deadEdgeSlots, angularConflict) ??
    pickFromCandidates(fallbackTail, blockedSlots, deadEdgeSlots, angularConflict) ??
    candidateSlots[0]
  );
}

/** Design note #72: computes a feature's own short, hand-picked preference
 *  order (e.g. `BADGE_SLOT_PREFERENCE`'s four corners) a fallback TAIL --
 *  every OTHER slot in `pool` (default: all twelve non-center slots, 1-12)
 *  not already in `primary`, in a fixed ascending order -- so `pickHexSlot`
 *  always has somewhere else to look once a hex's own few "ideal"
 *  candidates are all blocked or already claimed by another feature,
 *  rather than falling all the way through to its own last-tier "first
 *  candidate anyway" and silently drawing on top of live track (or, post-
 *  `claimHexSlot`, on top of another label). Order among the fallback tail
 *  doesn't encode any real preference -- by the time a search reaches it,
 *  every genuinely-preferred slot is already unavailable, so any
 *  remaining open one is an equally acceptable last resort. A caller whose
 *  rendering only knows how to place at a CORNER passes `CORNER_SLOTS` as
 *  `pool` so its fallback tail can never hand back an edge slot it can't
 *  actually draw at.
 *
 *  Design note #105: `drawRestrictionBadge` was this constant's one real
 *  consumer (it used to index `CORNER_SLOT_TO_CORNER_INDEX[slot - 7]` and
 *  had no edge-slot rendering path) -- now generalized to render at ANY
 *  slot via `hexSlotDirection` (per direct request, "then check edges"),
 *  so it no longer passes this pool and nothing else in the file does
 *  either. Left defined, unused, rather than deleted -- this file's own
 *  established convention (see `nameplateBoxFillFor`/`NAMEPLATE_BOX_FILL_*`,
 *  design note #78a) for a constant a past pass needed but a later one
 *  superseded, kept as a documented historical record instead of a silent
 *  deletion.
 *
 *  Design note #106: RENAMED conceptually (kept the same identifier, one
 *  call site) from "extend the primary list with a tail" to "compute the
 *  tail by itself" -- returns ONLY the fallback slots now, not
 *  `[...primary, ...rest]`. `claimHexSlot` used to hand `pickHexSlot` the
 *  pre-concatenated result of this function; now it hands `pickHexSlot`
 *  the caller's real `candidateSlots` and this function's tail as two
 *  SEPARATE arguments -- see `pickHexSlot`'s own design note #106 comment
 *  for why keeping them apart matters. */
function extendSlotPreference(
  primary: readonly number[],
  pool: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
): readonly number[] {
  const rest: number[] = [];
  for (const slot of pool) {
    if (!primary.includes(slot)) rest.push(slot);
  }
  return rest;
}

/** Design note #72: CROSS-PASS SLOT CLAIMING. Reported via screenshot: on
 *  New York (G19), the revenue badge, the terrain-cost label, and the
 *  terrain icon all rendered stacked on top of each other at the same
 *  corner. Root cause -- every label/badge/icon pass in the file called
 *  `pickHexSlot` independently, each blind to what any OTHER pass had
 *  already drawn on the SAME hex; harmless as long as no two passes' own
 *  preference lists ever favored the same slot, but G19's two real stub
 *  track edges block four of its six corners, leaving only two open --
 *  and the badge, cost-label, and icon passes all independently picked
 *  the SAME one of those two.
 *
 *  `claimed` is one `Map<"q,r", Set<slot>>` a caller creates ONCE per
 *  render and threads through every slot-picking pass for that render
 *  (icon, restriction badge, terrain-cost label, value badge) in their
 *  existing draw order. Each call here unions its own hex's
 *  already-claimed slots into `blockedSlots` before picking (so it never
 *  re-picks a slot a prior pass already used on this same hex), then
 *  records whichever slot it lands on so the NEXT pass avoids it too.
 *  Combined with `extendSlotPreference`, a pass whose own short preference
 *  list is entirely taken falls through to any other still-open slot on
 *  the hex rather than colliding -- the common case (a hex with only one
 *  or two of these features) is completely unaffected, since `claimed`
 *  starts empty for every hex and only a genuinely crowded landmark hex
 *  like G19 ever reaches the fallback tail.
 *
 *  Design note #104: now ALSO computes `angularConflictSlots(alreadyClaimed)`
 *  and passes it through to `pickHexSlot` as that function's new
 *  `angularConflict` parameter -- so a hex with multiple claims doesn't
 *  just avoid re-picking the exact same slot (this function's original
 *  job), it also steers new claims at least `MIN_SLOT_ANGULAR_SEPARATION_DEG`
 *  away from every slot already claimed on that same hex, with the same
 *  graceful degrade `pickHexSlot` itself documents.
 *
 *  Design note #106: no longer pre-merges `candidateSlots` with its
 *  fallback tail before calling `pickHexSlot` -- passes them as two
 *  separate arguments instead, so `pickHexSlot` can search the real
 *  preference list to exhaustion before ever touching the tail. See
 *  `pickHexSlot`'s own design note #106 comment for the bug this fixes. */
function claimHexSlot(
  claimed: Map<string, Set<number>>,
  q: number,
  r: number,
  candidateSlots: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  // Design note #72: restricts the fallback tail (see `extendSlotPreference`)
  // to a specific pool of slots -- pass `CORNER_SLOTS` for a caller that can
  // only ever render at a corner. Defaults to every non-center slot.
  pool?: readonly number[],
): number {
  const key = `${q},${r}`;
  const alreadyClaimed = claimed.get(key) ?? new Set<number>();
  // Built via `forEach`, not `[...blockedSlots, ...alreadyClaimed]` --
  // spreading a `Set` requires `--downlevelIteration`/an ES2015+ target,
  // which this project's `es5` target doesn't have (`tsc` TS2802).
  const combinedBlocked = new Set<number>();
  blockedSlots.forEach((s) => combinedBlocked.add(s));
  alreadyClaimed.forEach((s) => combinedBlocked.add(s));
  const angularConflict = angularConflictSlots(alreadyClaimed);
  const fallbackTail = extendSlotPreference(candidateSlots, pool);
  const slot = pickHexSlot(candidateSlots, combinedBlocked, deadEdgeSlots, angularConflict, fallbackTail);
  alreadyClaimed.add(slot);
  claimed.set(key, alreadyClaimed);
  return slot;
}

/** Design note #106: per-hex EXPLICIT slot overrides for the small set of
 *  named hexes where a direct request asked for a specific canonical
 *  18xx.games-style vertex/edge for one particular claim pass, rather than
 *  a change to that pass's board-wide generic preference order (which
 *  would ripple into every other hex sharing that pass, most of which
 *  weren't reported as wrong). Keyed by `"q,r"` -- this file's own
 *  established axial-coordinate map-key convention, already used
 *  identically by `claimed` itself just above -- then by which of the four
 *  claim passes (`nameplate`/`terrain`/`revenue`/`restriction`) the
 *  override applies to. Consulted via `withSlotOverride` below, which
 *  PREPENDS the override slot onto that pass's own normal preference list
 *  rather than replacing it outright -- so the override is only ever tried
 *  FIRST, and still runs through `claimHexSlot`'s full normal
 *  blocked/dead-edge/angular-conflict/already-claimed-on-this-hex safety
 *  checks (and therefore still has the pass's own real preference list, in
 *  its own order, as a graceful fallback tail if the requested slot turns
 *  out to be genuinely occupied by real printed track or a higher-priority
 *  claim). A hex/pass pair absent here is entirely unaffected.
 *
 *  F6 (Cleveland, 0,5) / A19 (Montreal, 9,0): revenue badge -> Edge 1/slot2
 *  -- reported sitting on Vertex 5 (F6, overlapping the nameplate) and
 *  drifting onto the track spline (A19) despite ample open space, with a
 *  guess that Edge 2/slot3 would be clear. HAND-VERIFIED against
 *  `GRAY_HEXES`' real edges for both (`{ edges: [4, 5] }` for each): slot3
 *  is actually BLOCKED (its guard edge is internal edge 5, one of these two
 *  hexes' own real live edges) -- placing the badge there would put it
 *  directly on top of the real printed track spline, the exact problem
 *  being reported, not a fix for it. Edge 1/slot2 is the nearest slot
 *  that's both a genuine EDGE (matching the request's own "Edge N"
 *  framing) and fully clear of `{4, 5}`'s two guard-edge pairs, and sits
 *  90 degrees from the nameplate's own slot7/Top claim -- the widest
 *  angular separation actually achievable here, since every slot in the
 *  bottom half of both hexes (3/4/9/10/11) is real-track-blocked.
 *  `BADGE_SLOT_PREFERENCE` only ever offers corners plus two FAR edges
 *  (design note #76), which doesn't include either Edge 1 or Edge 2.
 *  H12 (Altoona, 2,7): nameplate -> Vertex 3/slot10 (was sitting on the
 *  PRR reservation marker's curved track spline at its old corner) AND
 *  revenue badge -> Vertex 0/slot7 (the two were reported interfering with
 *  each other once the nameplate moved) -- both HAND-VERIFIED clear of
 *  Altoona's real `{ edges: [0, 3] }`.
 *  J14 (Washington, 2,9): nameplate -> Vertex 0/slot7, terrain icon+cost
 *  badge -> Vertex 2/slot9 (design note #110) -- both trivially achievable,
 *  Washington has no real printed track at all (a blank `cityDesignation`
 *  hex, same as Providence below).
 *  I15 (Baltimore, 3,8): nameplate -> Vertex 0/slot7 (design note #110,
 *  achievable, clear of Baltimore's real `{ edges: [0, 4] }`), revenue
 *  badge -> Vertex 2/slot9 (HAND-VERIFIED blocked -- Vertex 2's guard edge
 *  0 is one of Baltimore's own two real live edges -- degrades to its own
 *  normal order, landing at Edge 2/slot3 once the nameplate's Vertex 0
 *  claim also angularly rules out the two corners nearer it), restriction
 *  badge ("B") -> Edge 4/slot5 (HAND-VERIFIED open; angularly conflicts
 *  with both the nameplate and revenue badge's own claims by this point,
 *  but real-collision-avoidance still holds and the degrade search finds
 *  it anyway).
 *  G19 (New York, 6,6): terrain icon+cost badge -> Vertex 2/slot9 (design
 *  note #110 CORRECTION -- New York DOES have a real terrain badge here,
 *  see design note #71; an earlier pass incorrectly concluded otherwise by
 *  only checking `LANDMARK_HEXES`, missing that `STATIC_BOARD_HEXES` ALSO
 *  carries a separate `q:6,r:6` entry, `{ type: "River", printedColor:
 *  "Yellow" }`, specifically for this). Revenue badge -> Edge 4/slot5,
 *  restriction badge -> Edge 5/slot6 (design note #114 -- both HAND-
 *  VERIFIED genuinely open: neither slot's guard edge is one of New York's
 *  two real live edges, `{ edges: [1, 4] }`, so both resolve directly with
 *  no degrade needed, unlike the Vertex 1/Vertex 5 corners #106/#110 tried
 *  first). No `nameplate` entry: a DoubleCityHub nameplate
 *  already always renders dead-center by this file's own existing,
 *  unrelated design (see `doubleNodeNameplateAnchor`/its callers, and note
 *  it doesn't even call `claimHexSlot` -- it draws straight at `center`),
 *  matching the requested "nameplate is center" as-is.
 *  F22 (Providence, 8,5): nameplate -> Vertex 0/slot7, terrain icon+cost
 *  badge -> Vertex 2/slot9 -- both trivially achievable, Providence has no
 *  real printed track at all (a blank `cityDesignation` hex).
 *  E23 (Boston, 9,4): nameplate -> Vertex 3/slot10 (HAND-VERIFIED blocked
 *  by Boston's real SE stub, edge 5 -- degrades to Vertex 4/slot11, the
 *  nearest open corner; per direct request, acknowledged as unavoidable --
 *  "this nameplate will intersect something no matter where it is"),
 *  revenue badge -> Vertex 5/slot12 (design note #110: CHANGED from the
 *  originally-requested Vertex 0/slot7, which is also blocked -- by
 *  Boston's real NE stub, edge 1 -- to the newly-requested Vertex 5, which
 *  IS open; see `HEX_SLOT_RESERVE` for why the nameplate's own fallback
 *  search doesn't grab this slot first despite running earlier). No
 *  `restriction` entry anymore (design note #110 removed it) -- the "B"
 *  badge's own explicit Vertex 5 request from the PRIOR pass is superseded
 *  by this pass's revenue badge now wanting that exact slot instead;
 *  restriction has no override of its own this round and simply takes
 *  whatever its normal preference order resolves to once nameplate/revenue
 *  have claimed theirs (Edge 1/slot2 today).
 *  H18 (Philadelphia & Trenton, 5,7): restriction badge ("OO") -> Vertex
 *  5/slot12 (design note #112) -- the ONE `YELLOW_OO_HEXES` entry that
 *  actually needed this: H18 is the only one of the four bordering the
 *  board's own edge (one real dead edge, its east side), and that dead
 *  edge's two guard corners are Vertex 1/slot8 and Vertex 2/slot9 --
 *  `RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY`'s own tier 1 (design note
 *  #39/#70's "prefer a dead edge" rule) matched Vertex 1 before ever
 *  reaching Vertex 5 (first in the list, genuinely open, but not itself
 *  dead-edge-adjacent) -- the SAME leapfrog bug #111 fixed for explicit
 *  overrides, this time surfacing in the plain, non-override preference
 *  list on a hex whose geometry happens to trigger it. The other three OO
 *  hexes (E5, D10, E11) are all fully interior with zero dead edges, so
 *  their tier 1 never matches anything and they fall straight to tier 3's
 *  first-genuinely-open-slot check, landing on Vertex 5 correctly without
 *  needing an override at all -- confirmed by hand for all three before
 *  concluding H18 was the outlier, not a board-wide bug.
 *  B10 (Barrie, 4,1): nameplate -> Vertex 0/slot7 (design note #119) --
 *  reported rendering at Vertex 5/slot12 instead (this blank
 *  `cityDesignation` hex's normal preference-list default, same shape as
 *  Washington/Providence before THEIR nameplate overrides above); Vertex
 *  0/slot7 is trivially open, no real printed track on this hex at all.
 *  G19 (New York, 6,6): revenue badge and restriction badge SWAPPED
 *  (design note #120) -- previously `{ revenue: 5, terrain: 9,
 *  restriction: 6 }` per design note #114 (revenue at Edge 4/slot5,
 *  restriction at Edge 5/slot6); now `{ revenue: 6, terrain: 9,
 *  restriction: 5 }`, putting revenue at Edge 5/slot6 and restriction at
 *  Edge 4/slot5 -- the same two already-verified-open slots from #114,
 *  just trading which badge sits in which.
 *  F16 (Scranton, 5,5): nameplate -> Vertex 0/slot7, terrain icon+cost
 *  badge -> Vertex 2/slot9 (design note #123, per explicit request) --
 *  both HAND-VERIFIED open: F16 has no real printed track (a blank
 *  `cityDesignation` hex, same shape as Toledo/Providence/Washington
 *  above), so neither slot's guard edge can ever be blocked by real
 *  track here. */
const HEX_SLOT_OVERRIDE: Readonly<
  Record<string, { nameplate?: number; terrain?: number; revenue?: number; restriction?: number }>
> = {
  "0,5": { revenue: 2 }, // F6 Cleveland
  "9,0": { revenue: 2 }, // A19 Montreal
  "2,7": { nameplate: 10, revenue: 7 }, // H12 Altoona
  "2,9": { nameplate: 7, terrain: 9 }, // J14 Washington
  "3,8": { nameplate: 7, revenue: 9, restriction: 5 }, // I15 Baltimore
  "6,6": { revenue: 6, terrain: 9, restriction: 5 }, // G19 New York (design note #120 -- swapped from #114's revenue:5/restriction:6)
  "8,5": { nameplate: 7, terrain: 9 }, // F22 Providence
  "9,4": { revenue: 12, nameplate: 10 }, // E23 Boston
  "5,7": { restriction: 12 }, // H18 Philadelphia & Trenton (design note #112)
  "4,1": { nameplate: 7 }, // B10 Barrie (design note #119)
  "5,5": { nameplate: 7, terrain: 9 }, // F16 Scranton (design note #123)
};

/** Design note #111 SUPERSEDED THIS FUNCTION -- see that note and
 *  `claimHexSlotPreferring` below for why. Left defined, unused, per this
 *  file's own "don't delete superseded constants" convention: prepending
 *  the override onto `preference` and running the RESULT through
 *  `pickHexSlot`'s normal tiered search let a LATER, merely dead-edge-
 *  adjacent slot elsewhere in that same list leapfrog the override itself
 *  whenever the override slot wasn't also dead-edge-adjacent -- the exact
 *  D6 bug design note #106 fixed for the primary-list/fallback-tail split,
 *  re-appearing one level up, inside a single already-combined list. */
/** Design note #111: looks up `HEX_SLOT_OVERRIDE` for `(q, r)`/`pass`,
 *  returning `undefined` if there's no override OR if the override's own
 *  slot is `HEX_SLOT_RESERVE`d for a DIFFERENT pass on this same hex (an
 *  override should never fight a reservation -- see that table's own doc
 *  comment for why the reservation exists in the first place). Paired with
 *  `claimHexSlotPreferring`, NOT `withSlotOverride` above -- see that
 *  function's own doc comment for why prepending onto a preference list
 *  and running it through the normal tiered search was the wrong shape for
 *  an EXPLICIT, deliberate placement. */
function resolveSlotOverride(
  q: number,
  r: number,
  pass: "nameplate" | "terrain" | "revenue" | "restriction",
): number | undefined {
  const override = HEX_SLOT_OVERRIDE[`${q},${r}`]?.[pass];
  if (override === undefined) return undefined;
  const reserve = HEX_SLOT_RESERVE[`${q},${r}`];
  if (reserve && reserve.for !== pass && reserve.slot === override) return undefined;
  return override;
}

/** Design note #111: an EXPLICIT per-hex override (`HEX_SLOT_OVERRIDE`) is
 *  a deliberate, specific placement decision -- it should be honored
 *  whenever the slot is actually usable, and give way ONLY to a genuine
 *  collision (real printed track, or another pass that already claimed it
 *  this render), never to the normal preference-list tiers' OWN "prefer a
 *  permanently dead edge" heuristic (design note #39/#70), which exists to
 *  break ties among a list of otherwise-equally-acceptable candidates, not
 *  to outrank a slot the caller specifically asked for. Tries `preferredSlot`
 *  directly (bypassing `pickHexSlot`'s tiers and even angular-conflict
 *  soft-avoidance entirely -- an explicit request should win a mere
 *  angular-crowding tiebreak too); only falls through to the ordinary
 *  `claimHexSlot`/`pickHexSlot` tiered search over `candidateSlots` (the
 *  pass's own UNMODIFIED normal preference list, not prepended with
 *  anything) if `preferredSlot` is missing or genuinely blocked/claimed.
 *  Reported (J14/Washington): the override system's old shape
 *  (`withSlotOverride`, prepend-then-tier-search) let the nameplate's
 *  override (Vertex 0/slot7, genuinely open) lose to Vertex 1/slot8 purely
 *  because slot8 happened to sit next to Washington's one real dead edge
 *  (its own east board-boundary edge) -- exactly reproducing D6's original
 *  bug one level up. */
function claimHexSlotPreferring(
  claimed: Map<string, Set<number>>,
  q: number,
  r: number,
  preferredSlot: number | undefined,
  candidateSlots: readonly number[],
  blockedSlots: ReadonlySet<number>,
  deadEdgeSlots: ReadonlySet<number>,
  pool?: readonly number[],
): number {
  if (preferredSlot !== undefined) {
    const key = `${q},${r}`;
    const alreadyClaimed = claimed.get(key) ?? new Set<number>();
    if (!blockedSlots.has(preferredSlot) && !alreadyClaimed.has(preferredSlot)) {
      alreadyClaimed.add(preferredSlot);
      claimed.set(key, alreadyClaimed);
      return preferredSlot;
    }
  }
  return claimHexSlot(claimed, q, r, candidateSlots, blockedSlots, deadEdgeSlots, pool);
}

/** Design note #113: an EXPERIMENTAL, unconditional per-hex/per-pass slot
 *  force -- unlike `HEX_SLOT_OVERRIDE` (honored unless a real collision
 *  makes it genuinely unusable), a `HEX_SLOT_FORCE` entry always wins, no
 *  exceptions: no real-track-blocked check, no already-claimed-on-this-hex
 *  check, nothing. Exists specifically for "put it here so I can see how it
 *  looks, I don't care what it overlaps" requests, where the whole point is
 *  to bypass this file's collision-avoidance machinery on purpose rather
 *  than have it silently substitute a "safer" slot. Still RECORDS the claim
 *  in `claimedHexSlots` (so any OTHER pass on the same hex that doesn't
 *  have its own force still tries to avoid this slot, even though this
 *  pass itself doesn't care) -- only this one pass's own collision check is
 *  skipped, not every other pass's.
 *
 *  Kept as a SEPARATE table (rather than, say, an "ignoreCollisions" flag
 *  added onto `HEX_SLOT_OVERRIDE`) so the two stay visually and
 *  semantically distinct in this file -- an override is still a real,
 *  collision-respecting placement decision; a force is a deliberate,
 *  temporary "show me anyway" probe.
 *
 *  Design note #114: G19's own entry REMOVED -- the Vertex 1 force
 *  (revenue badge directly on New York's real NE track stub) was a one-off
 *  "let me see it" probe, and having seen it ("I see it is a problem
 *  there"), the follow-up moved on to a genuinely different, non-colliding
 *  pair of slots (Edge 4/Edge 5) via ordinary `HEX_SLOT_OVERRIDE` entries
 *  instead -- no force needed there, since both are actually open.
 *
 *  Design note #115: E23/Boston's nameplate FORCED to Vertex 3/slot10 --
 *  direct request, explicitly accepting the collision with Boston's own
 *  real SE track stub (`LANDMARK_TRACKS["Boston"]`'s `edges: [1, 5]`,
 *  guarded by edge 5) that's made this slot genuinely unusable for the
 *  nameplate ever since it was first requested back in design note #106
 *  (where it degraded to Vertex 4) -- the user's own suspicion that this
 *  was the dead-edge tier rule (design note #111/#112's bug) rather than a
 *  genuine track collision was checked and ruled out: Vertex 3's two guard
 *  edges are 4 and 5, and edge 5 IS one of Boston's two real live edges,
 *  so this was always a real collision, not a leapfrog bug -- forcing
 *  through it is the correct tool here, not another bug fix. */
const HEX_SLOT_FORCE: Readonly<
  Record<string, { nameplate?: number; terrain?: number; revenue?: number; restriction?: number }>
> = {
  "9,4": { nameplate: 10 }, // E23 Boston -- forced to Vertex 3, ignoring its real SE track stub
};

function claimHexSlotForced(claimed: Map<string, Set<number>>, q: number, r: number, slot: number): number {
  const key = `${q},${r}`;
  const alreadyClaimed = claimed.get(key) ?? new Set<number>();
  alreadyClaimed.add(slot);
  claimed.set(key, alreadyClaimed);
  return slot;
}

/** Design note #106: on a hex where ONE claim pass has a genuinely
 *  achievable explicit override on a slot, but an EARLIER-running pass
 *  (per the fixed nameplate > terrain > revenue > restriction order) would
 *  otherwise reach that same slot in its own graceful-degrade fallback
 *  search first -- it has no way to know a LATER pass has its own explicit
 *  claim on it. `HEX_SLOT_RESERVE` names the one slot on a hex that's
 *  reserved for one specific pass; `withSlotReserve` (used by every pass
 *  EXCEPT the reserved one) filters that slot out of its own candidate
 *  list entirely, so it's forced past it to its own next-best fallback
 *  instead of claiming it first purely by going first.
 *
 *  Design note #110: G19/New York added -- once New York's terrain badge
 *  correction (see `HEX_SLOT_OVERRIDE`'s own doc comment) claims Vertex
 *  2/slot9, the revenue badge's own fallback search (its requested Vertex
 *  1 being blocked) would otherwise land on Vertex 5/slot12 next -- exactly
 *  where the restriction badge's own explicit override needs to go.
 *  E23/Boston's own entry REPOINTED from `restriction` to `revenue`: the
 *  revenue badge's request changed (this same pass) from Vertex 0 (blocked)
 *  to Vertex 5 -- now revenue is the pass with the achievable claim on that
 *  slot, and it's the nameplate (running before it) whose own fallback
 *  search would otherwise reach Vertex 5 first and needs to be steered
 *  around it instead.
 *
 *  Design note #114: G19's own entry REMOVED -- its revenue and
 *  restriction badges moved to Edge 4/slot5 and Edge 5/slot6 respectively,
 *  neither of which any OTHER pass's own fallback search on this hex would
 *  ever reach (terrain's claim at Vertex 2/slot9 doesn't compete with
 *  either), so nothing needs steering away from them anymore. */
const HEX_SLOT_RESERVE: Readonly<
  Record<string, { for: "nameplate" | "terrain" | "revenue" | "restriction"; slot: number }>
> = {
  "9,4": { for: "revenue", slot: 12 }, // E23 Boston -- reserves Vertex 5 for the revenue badge
};

function withSlotReserve(
  q: number,
  r: number,
  pass: "nameplate" | "terrain" | "revenue" | "restriction",
  preference: readonly number[],
): readonly number[] {
  const reserve = HEX_SLOT_RESERVE[`${q},${r}`];
  if (!reserve || reserve.for === pass) return preference;
  return preference.filter((slot) => slot !== reserve.slot);
}

/** Archetype B/DoubleTown shared TWO-NODE offset (ORIGIN design note #55,
 *  magnitude/direction UPDATED from #54's `ooCityMarkerOffset`; node index
 *  convention fixed by #56; sole remaining outlier folded in by #57;
 *  REPLACED WHOLESALE by design note #73 -- see that note for why). THE ONE
 *  canonical coordinate helper for every two-node hex on the board. Node
 *  Index 0 = `center + this offset`; Node Index 1 = `center - this offset`,
 *  universally.
 *
 *  Design note #73: reported via a real 18xx.games reference screenshot of
 *  G19 -- the two node positions were sitting at roughly a hex VERTEX
 *  (#55's `(+0.43, -0.25)` diagonal resolves to an angle of -30.17 degrees,
 *  0.17 degrees off this file's own corner-1/`cornerAngleRad(1)` exactly),
 *  when the real board (and the user's own explicit instruction) puts each
 *  node on an EDGE MIDPOINT instead -- this file's edge 1 (NE, the user's
 *  own "Edge 0") for node 0, and edge 4 (SW, the user's own "Edge 3") for
 *  node 1. Edges 1 and 4 are exactly opposite (180 degrees apart:
 *  `edgeAngleRad(1) = -60`, `edgeAngleRad(4) = 120`), so a single delta
 *  vector applied as `center + delta`/`center - delta` still works exactly
 *  as before -- only the vector's own direction and magnitude changed, not
 *  `twoNodePositions`' `±` structure below.
 *
 *  MAGNITUDE: the true edge-1 midpoint sits at the full apothem
 *  (`size * sqrt(3)/2`, ~0.866 * size) from center -- placing a node's
 *  station circle (`drawStationCircle`'s own `size * 0.22` radius) exactly
 *  there would let roughly `0.22 * size` of it bleed straight through the
 *  hex's own printed border into the neighboring hex.
 *
 *  Design note #77: FURTHER pulled in, from #73's original `size * 0.58` to
 *  `size * 0.50`. Reported: at `0.58`, the station circle sat close enough
 *  to the edge (`0.58 + 0.22 = 0.80` against the `0.866` boundary, a bare
 *  `0.066 * size` clearance) that the short real track stub connecting the
 *  edge to the station -- the very thing this offset exists to keep
 *  visible, on G19 and any other double-node hex with real printed track --
 *  was nearly invisible. At `0.50`: `0.50 + 0.22 = 0.72`, a `0.146 * size`
 *  clearance, well over double the visible stub length, while the station
 *  is still unambiguously anchored to its own edge's midpoint (unchanged
 *  direction, only the distance out from center moved).
 *
 *  BOARD-WIDE, same as before: every double-node hex calls this exact
 *  function for its station-circle/town-dot coordinates -- the preprinted
 *  New York (G19) landmark (`stationMarkerPoint`/`drawLandmarkTrack`,
 *  design note #56 -- New York's real printed stub track terminates AT
 *  these coordinates, not at some independently-derived approximation of
 *  them), every unlaid OO hex (`drawOOCityMarkers`), every laid
 *  OO/`DoubleCityHub` tile #59/#64-#68 (`twoCityStationPoints`), every
 *  unlaid double-town-designated hex's dit markers, and every laid
 *  `DoubleTown` tile #6's dit markers. Every one of these moves together,
 *  by construction -- there is no per-hex override anywhere in the file.
 *  Kept as the low-level `(x, y)` delta primitive that `twoNodePositions`
 *  (design note #58, directly below) builds on -- every actual call site
 *  goes through `twoNodePositions` instead of hand-writing `center ±
 *  offset` itself. */
function doubleNodeOffset(size: number): { x: number; y: number } {
  const magnitude = size * 0.5;
  return pointOnCircle({ x: 0, y: 0 }, magnitude, edgeAngleRad(1));
}

/** THE single shared 2-node coordinate helper (design note #58) for every
 *  double-city and double-town feature on the board -- New York (G19), all
 *  five OO `DoubleCityHub` variants (laid and unlaid), and all three
 *  double-town hexes (laid `DoubleTown` tile #6 and the unlaid
 *  `townDesignation: "double"` marker pass). Returns a 2-tuple, `[node0,
 *  node1]`, so every call site indexes directly into the SAME array a
 *  feature's own city/town/segment index already uses (`cityGroups[0]`/
 *  `[1]`, `LANDMARK_TRACKS[...][0]`/`[1]`, a company's `city_index`) --
 *  index 0 is always the first slot (Top-Right/Northeast), index 1 is
 *  always the second slot (Bottom-Left/Southwest), with NO re-sorting, no
 *  sign-flipped arithmetic re-derived at each call site, and therefore no
 *  opportunity for a call site to accidentally swap which physical corner
 *  a given index lands on (the exact class of bug design note #56 fixed
 *  for G19 specifically -- this generalizes that fix so it can't recur at
 *  any OTHER call site either). Every 2-node feature on the board -- laid
 *  or unlaid, city or town -- calls this one function; none compute their
 *  own diagonal offset independently anymore. */
function twoNodePositions(
  center: { x: number; y: number },
  size: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  const offset = doubleNodeOffset(size);
  return [
    { x: center.x + offset.x, y: center.y + offset.y }, // index 0: Top-Right / Northeast
    { x: center.x - offset.x, y: center.y - offset.y }, // index 1: Bottom-Left / Southwest
  ];
}

/** Archetype A/SingleTown shared nameplate anchor (design note #55's
 *  Upper-Left wedge default; DYNAMICALLY SLOT-AWARE by design note #70's
 *  13-Slot system): used for any hex with exactly ONE central station/dit
 *  node (a laid `MajorCityHub`/`BostonHub` tile, a real GRAY single-city
 *  hex, an ordinary white `cityDesignation` hex, a real GRAY single-town
 *  hex, or a blank `townDesignation: "single"` hex).
 *
 *  #55 anchored EVERY single-node hex at the identical fixed Upper-Left
 *  point regardless of what track that specific hex actually has -- fine
 *  for most of the board, but with no fallback at all for the hexes whose
 *  real printed track happens to run through that exact wedge. #70 makes
 *  the choice of WHICH open slot to use dynamic: `NAMEPLATE_SLOT_PREFERENCE`
 *  tries Upper-Left (slot 12) as ONE candidate; a hex that resolves there
 *  still renders at the EXACT same pixel as #55's original literal
 *  formula, via the `slot === 12` special case just below. Off that one
 *  slot, the SAME wedge magnitude (`size * hypot(0.25, 0.35)`, #55's own
 *  tuned "into the hex, not all the way to the corner" distance) is kept,
 *  just re-aimed along the chosen slot's own direction (`hexSlotDirection`)
 *  instead of #55's fixed literal `(-0.25, -0.35)` vector.
 *
 *  Design note #105: Upper-Left is no longer tried FIRST -- per direct
 *  request, `NAMEPLATE_SLOT_PREFERENCE` now leads with center (slot 0),
 *  then the top vertex (slot 7), then the bottom vertex (slot 10), so the
 *  "overwhelming majority renders byte-identical to #55" property this
 *  paragraph used to describe no longer holds; see that constant's own
 *  updated doc comment for the reasoning. */
// Design note #74: reordered -- Upper-Left (12) is still tried FIRST (the
// overwhelmingly common case renders byte-identical to before), but the
// BOTTOM VERTEX (10) moves to SECOND preference instead of second-to-last.
// Reported: on real gray connector hexes with heavy pre-printed track
// fanning out from center (Fall River/F24, Atlantic City/I19), every upper
// corner ends up blocked, and the OLD order fell through six EDGE slots
// first -- each one sitting right where a track spline actually runs --
// before ever reaching the bottom corner, so the nameplate visually landed
// on top of a track spline despite technically not occupying a "blocked"
// slot. The bottom vertex is just as legitimate a corner as any other and,
// per the user's own explicit suggestion, a much safer fallback than an
// edge slot for a hex whose track fans out in every other direction.
//
// Design note #105: REORDERED again, per direct request -- CENTER (slot 0)
// now tried FIRST, then the TOP vertex (slot 7), then the BOTTOM vertex
// (slot 10), with the remaining slots following in the same relative order
// #74 left them in. Center is blocked on the overwhelming majority of
// named hexes (any hex with live track through it, or a SingleCity/
// SingleTown archetype's own station/dit circle -- see `hexBlockedSlots`),
// so in practice this is a no-op fallthrough to the top vertex for nearly
// every hex; it only actually WINS on a genuinely blank, trackless named
// hex, where `hexSlotDirection(0)` resolves to `{x:0,y:0}` and
// `singleNodeNameplateAnchor` (below) renders dead-center, same as this
// system's DoubleCity/DoubleTown nameplates already always do.
const NAMEPLATE_SLOT_PREFERENCE: readonly number[] = [0, 7, 10, 12, 8, 11, 9, 6, 1, 5, 2, 4, 3];

function singleNodeNameplateAnchor(
  center: { x: number; y: number },
  size: number,
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  // Design note #74: shared cross-pass claiming ledger (see `claimHexSlot`'s
  // own doc comment) -- nameplates previously called `pickHexSlot` directly,
  // completely unaware of what the restriction-badge/revenue-badge passes
  // on the SAME hex had already claimed (or would later claim), which let a
  // nameplate and a restriction badge land on the EXACT same slot (reported:
  // Baltimore/I15's nameplate and its "B" restriction badge both
  // independently resolving to the same upper-left corner once Baltimore's
  // real edge-0/edge-4 track blocks every other corner). Now the FIRST of
  // the slot-picking passes to run each render (nameplate, then restriction,
  // then terrain-cost, then revenue badge), so it gets first pick, exactly
  // as before for the common case, while every later pass now sees its own
  // claim and avoids it.
  claimedHexSlots: Map<string, Set<number>>,
): { x: number; y: number } {
  const blocked = hexBlockedSlots(mapGrid, q, r);
  const dead = slotsBlockedByEdges(deadEdgesAt(q, r), false);
  const nameplateForce = HEX_SLOT_FORCE[`${q},${r}`]?.nameplate;
  const nameplateOverride = resolveSlotOverride(q, r, "nameplate");
  const nameplatePreference = withSlotReserve(q, r, "nameplate", NAMEPLATE_SLOT_PREFERENCE);
  const slot =
    nameplateForce !== undefined
      ? claimHexSlotForced(claimedHexSlots, q, r, nameplateForce)
      : claimHexSlotPreferring(claimedHexSlots, q, r, nameplateOverride, nameplatePreference, blocked, dead);
  if (slot === 12) {
    // Design note #55's own exact literal formula, preserved byte-for-byte
    // for the default (and overwhelmingly common) case.
    return { x: center.x - size * 0.25, y: center.y - size * 0.35 };
  }
  const magnitude = Math.hypot(0.25, 0.35) * size;
  const direction = hexSlotDirection(slot);
  return { x: center.x + direction.x * magnitude, y: center.y + direction.y * magnitude };
}

/** Frontend mirror of the Rust backend's `hexmap::describe_hex` -- given an
 *  axial `(q, r)`, returns the same style of human-readable label a player
 *  would expect: the board's own printed coordinate (preferring a
 *  landmark's city name when the hex is a landmark, or an off-board zone's
 *  name when it's a red off-board hex), or an explicit off-board fallback
 *  string when the hex isn't part of the real 93-hex board at all. Used by
 *  the click interceptor (design note #7) to label its popup/loading states
 *  without a round-trip query just to learn a hex's name. */
function describeHex(q: number, r: number): string {
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) return `${landmark.name} (${landmark.label})`;

  const boardHex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (boardHex) {
    const offboardName = OFFBOARD_LABELS[boardHex.label];
    if (offboardName) return `${offboardName} (${boardHex.label})`;
    // Dynamic City Nameplate Suppression (design note #47): this function
    // previously fell straight through to the bare coordinate label
    // (`"J14"`) for every `NAMED_HEX_LABELS` city -- Washington, Toledo,
    // Providence, Albany, Cleveland, Altoona, and the rest never had their
    // real name in the tooltip at all, landmark/off-board names aside. That
    // was a real, previously-uncaught gap in its own right, and now a load-
    // bearing one: once a laid tile suppresses a city's ON-CANVAS nameplate
    // (see the drawing passes below), the hover tooltip becomes the ONLY
    // remaining place that name is shown at all -- so it must actually
    // carry it. Checked here rather than in the caller so every one of
    // `describeHex`'s existing call sites (tile-selection console.log
    // included) picks up the fix at once.
    const namedLabel = NAMED_HEX_LABELS[boardHex.label];
    return namedLabel ? `${namedLabel} (${boardHex.label})` : boardHex.label;
  }

  return `(${q}, ${r}) [off the authentic 1830 board]`;
}

/** Debug-only descriptor of hex `(q, r)`'s PRE-PRINTED terrain/designation
 *  -- independent of whatever tile a player may have actually laid there --
 *  built for the tile-selection click console.log below (Tile Selection
 *  Catalog verification pass, item 1). Mirrors the exact same lookup
 *  priority `describeHex`/`hexRouteValue` already use: `LANDMARK_HEXES`
 *  first, then a `GRAY_HEXES` real-track marker, then `YELLOW_OO_HEXES`,
 *  then `townDesignation`/`cityDesignation`, falling back to an ordinary
 *  ungated hex or off-board.
 *
 *  NOTE on the `YELLOW_OO_HEXES` branch's `designation` string: item 1's
 *  investigation (immediate click-time log, this function) originally found
 *  that `TILE_CATALOG` had no distinct double-city tile type at all --
 *  every `CITY_DESIGNATED_HEXES` entry, OO hexes included, required plain
 *  `MajorCityHub`. That gap is what item 2 of this same pass fixed: a new
 *  `TerrainType.DoubleCityHub` (tile 15, real 1830 tile 59), a new
 *  `OO_DESIGNATED_HEXES` list split out of `CITY_DESIGNATED_HEXES`, and an
 *  updated City Reservation gate in `hexmap.rs` (module doc comment #18).
 *  This branch now correctly reports "DoubleCityHub" rather than
 *  "MajorCityHub" for an OO hex. */
function describeHexDesignationForLog(
  q: number,
  r: number,
): { hexLabel: string; terrainType: TerrainType | "None"; designation: string } {
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    return {
      hexLabel: landmark.label,
      terrainType: "MajorCityHub",
      designation: `Landmark: ${landmark.name} (LANDMARK_HEXES)`,
    };
  }

  const boardHex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (boardHex) {
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack && grayTrack.marker !== "none") {
      return {
        hexLabel: boardHex.label,
        terrainType: grayTrack.marker === "city" ? "MajorCityHub" : "SmallTown",
        designation: `Preprinted GRAY ${grayTrack.marker} (CITY_DESIGNATED_HEXES/TOWN_DESIGNATED_HEXES)`,
      };
    }
    if (YELLOW_OO_HEXES.has(boardHex.label)) {
      return {
        hexLabel: boardHex.label,
        terrainType: "DoubleCityHub",
        designation:
          "Preprinted YELLOW OO double-city (OO_DESIGNATED_HEXES) -- Tile Selection Catalog verification pass: now strictly requires DoubleCityHub artwork (tile 15, the real 1830 tile 59), rejecting an ordinary MajorCityHub tile here",
      };
    }
    if (boardHex.townDesignation) {
      return {
        hexLabel: boardHex.label,
        terrainType: boardHex.townDesignation === "double" ? "DoubleTown" : "SmallTown",
        designation: "Blank Town-designated, no printed track yet (TOWN_DESIGNATED_HEXES)",
      };
    }
    if (boardHex.cityDesignation) {
      return {
        hexLabel: boardHex.label,
        terrainType: "MajorCityHub",
        designation: "Blank City-designated, no printed track yet (CITY_DESIGNATED_HEXES)",
      };
    }
    return { hexLabel: boardHex.label, terrainType: "None", designation: boardHex.type };
  }

  return { hexLabel: `(${q}, ${r})`, terrainType: "None", designation: "off the authentic 1830 board" };
}

/** Frontend mirror of `hexmap::terrain_base_value` -- the SAME flat,
 *  terrain-only $ value the backend computes for `RunManualRoute`'s payout
 *  math (see `src/hexmap.rs`). Deliberately flat/terrain-based, NOT
 *  phase/color-tier-dependent -- see design note #26/item 5 for why that
 *  matters: the two example numbers a later request gave ($10 towns / $20
 *  base cities) DO match this table, but the "based on the current game
 *  phase tier" framing that request used does not match how this contract
 *  actually prices a route, since a hex's value never changes as the game
 *  advances through color tiers. */
function terrainBaseValue(terrain: TerrainType): number {
  switch (terrain) {
    case "Plain":
    case "MountainRugged":
      return 0;
    case "SmallTown":
      return 10;
    case "DoubleTown": // flat $10, mirrors hexmap::terrain_base_value (backend module doc comment #21) -- NOT $20 (two $10 stops summed): a route can only ever reach ONE of the hex's two town stops in a single continuous visit, the same single-visit reasoning DoubleCityHub's own $80->$40 correction already established, just never backported to DoubleTown until that pass
      return 10;
    case "MajorCityHub":
      return 20;
    case "DoubleCityHub": // real 1830 tile 59's per-station $40, NOT both stations at once -- mirrors hexmap::terrain_base_value, reverted from an earlier pass's $80 overcorrection (backend module doc comment #20 follow-up): tile 59's two stations are real disconnected one-edge stubs with no path between them, so a single continuous transit can only ever reach one station per visit
      return 40;
    case "BostonHub": // design note #49, mirrors hexmap::terrain_base_value's BostonHub => 20 (module doc comment #26/#27) -- same flat single-city bucket as MajorCityHub
      return 20;
    case "NewYorkHub": // design note #49, mirrors hexmap::terrain_base_value's NewYorkHub => 40 -- same flat per-station bucket as DoubleCityHub
      return 40;
  }
}

/** Resolves the $ route value to show for hex `(q, r)` in the enriched
 *  hover tooltip (design note #26/item 2) and the on-board value badges
 *  (design note #26/item 5). Mirrors the SAME priority order `draw()`
 *  itself already uses to decide what's rendered on a hex: a laid tile's
 *  own terrain (from `TILE_CATALOG`) wins first, then the three fixed
 *  landmark cities (always `MajorCityHub`), then a pre-printed gray hex's
 *  own city/town/none marker, then a yellow "OO" hex (always
 *  `MajorCityHub` -- two $20 stations, see `YELLOW_OO_HEXES`), then a
 *  plain unlaid hex's flat $0. Off-board red revenue zones are deliberately
 *  excluded (returns `null`) -- those already have their own, genuinely
 *  era-tiered `OFFBOARD_REVENUE` value (design note #22), a DIFFERENT
 *  value system from this terrain-based one, and callers fall back to that
 *  instead. */
function hexRouteValue(q: number, r: number, mapGrid: MapGridResponse): number | null {
  const laidTile = mapGrid.tiles.find((t) => t.q === q && t.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry) return terrainBaseValue(catalogEntry.terrain);
  }

  const landmark = LANDMARK_HEXES.find((l) => l.q === q && l.r === r);
  const boardHex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
  // Design note #35/items 2-3: a per-hex real-value override, checked
  // BEFORE the flat-by-terrain fallback below -- see
  // `HEX_START_VALUE_OVERRIDE`'s own doc comment for the sourced $ figures
  // and the two factual corrections (F6 is Cleveland, not "Chicago"; F24 is
  // a Town hex, not one of the city hubs this override table covers) this
  // uncovered. Any hex not listed there (e.g. Lansing/Altoona/Rochester/
  // Richmond, or any `townDesignation` hex) falls straight through to the
  // untouched flat logic beneath, unaffected.
  const overrideLabel = landmark?.label ?? boardHex?.label;
  if (overrideLabel !== undefined && overrideLabel in HEX_START_VALUE_OVERRIDE) {
    return HEX_START_VALUE_OVERRIDE[overrideLabel];
  }

  if (landmark) {
    return terrainBaseValue("MajorCityHub");
  }

  if (boardHex) {
    if (OFFBOARD_LABELS[boardHex.label]) return null;
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack) {
      if (grayTrack.marker === "city") return terrainBaseValue("MajorCityHub");
      if (grayTrack.marker === "town") return terrainBaseValue("SmallTown");
      return terrainBaseValue("Plain");
    }
    if (YELLOW_OO_HEXES.has(boardHex.label)) return terrainBaseValue("MajorCityHub");
    // Design note #37 (corrects the previous pass's `return null` here --
    // reported: a blank `townDesignation` hex showed NO value suffix at
    // all in the tooltip, inconsistent with every blank `cityDesignation`
    // hex just below, which shows an explicit "(Value: $0)" via
    // `HEX_START_VALUE_OVERRIDE`'s real sourced $0 entries. A blank
    // `townDesignation` hex -- unlike `GRAY_HEXES`'s three real-track towns
    // (Kingston/Atlantic City/Fall River, handled by the `grayTrack` branch
    // above) -- has no printed track at all, so its real printed value IS
    // $0, the same fact that already justifies `cityDesignation`'s $0
    // figure below -- there's no principled reason for one blank-hex
    // category to hide its value while the other shows "$0" explicitly.
    // Flat `0`, not a per-hex `HEX_START_VALUE_OVERRIDE` entry, since
    // there's no individually-sourced figure to look up here -- both
    // single- and double-town blank hexes get the same $0 (the ON-BOARD
    // badge for these hexes stays suppressed regardless, per the separate,
    // still-correct "Only Real-Track Towns Show Revenue" fix in `draw()`
    // below -- that fix was about the visible badge plate, not this
    // tooltip text).
    if (boardHex.townDesignation) return 0;
    // Design note #34/item 2: `cityDesignation` hexes get the same flat
    // `MajorCityHub` $20 value `townDesignation` hexes already get above --
    // both are ordinary blank hexes with no real printed track. SUPERSEDED
    // for all eight of these specific hexes by `HEX_START_VALUE_OVERRIDE`'s
    // real $0 above (design note #35/item 3); this fallback branch is now
    // only reachable if a NEW `cityDesignation` hex is ever added without
    // also adding a matching override entry.
    if (boardHex.cityDesignation) return terrainBaseValue("MajorCityHub");
    return terrainBaseValue("Plain");
  }

  return null;
}

/** Builds the enriched "{label}: {name} (Value: $X) (Terrain Cost: $Y)"
 *  hover tooltip string (design note #26/item 2) -- `describeHex`'s own
 *  coordinate/name text plus, where applicable, a
 *  `hexRouteValue`/`offboardValueForEra` value suffix and a terrain-cost
 *  suffix. Off-board red zones use their own era-tiered value (design note
 *  #22) instead of the flat terrain table, since that's the value that's
 *  actually relevant there; a hex with no applicable value (off the real
 *  board entirely) prints no value suffix at all.
 *
 *  Design note #103: two follow-up fixes, per direct request. (a) The
 *  `(Value: $X)` suffix is now suppressed when `X` is `0` -- design note
 *  #35/#37 had deliberately kept a literal "(Value: $0)" for hexes whose
 *  on-canvas badge is itself hidden at $0, reasoning the tooltip was the
 *  only place that fact was visible; per this direct request, that's
 *  reversed -- the suffix now only appears for an ACTUAL (nonzero) value,
 *  same standard applied to both the flat `hexRouteValue` path and the
 *  off-board `offboardValueForEra` path (though real off-board revenue is
 *  never $0 in practice). `hexRouteValue`'s own return value is untouched
 *  -- still literally `0` for those hexes -- only this tooltip-string
 *  formatting layer changed. (b) A new `(Terrain Cost: $Y)` suffix is
 *  appended for any Mountain/River hex, reusing
 *  `TERRAIN_BUILD_COST_LABEL` (the same source the on-canvas red cost
 *  badge draws from, #68/#87) -- note that constant's own values are bare
 *  digits since #94 dropped their `$` prefix for the badge, so a `$` is
 *  re-added here for this text-sentence context.
 *
 *  Design note #117: a new `(Stations: N)` suffix, per direct request
 *  ("when a tile has stations on it") -- SUPERSEDED by design note #118
 *  below. `N` was a CAPACITY count derived from `archetypeForHex` (how many
 *  station tokens could ever occupy this hex), not which companies actually
 *  have one placed there.
 *
 *  Design note #118: corrected per direct follow-up -- the request was
 *  never a count, it was "what stations are there": which corporation(s)
 *  actually have a station token ON this hex right now, printed by
 *  `ticker` (e.g. `"PRR"`), not a bare number. Reworked to cross-reference
 *  `publicCompanies` (this component's own `StationTokenCompany[]` prop,
 *  design note #36) against `(q, r)`: any company whose
 *  `station_token_hexes` array contains this exact pair has a token here.
 *  Tickers are collected in `publicCompanies`' own array order (that
 *  array's order is itself stable across a poll -- `App.tsx` passes
 *  `state.public_companies` straight through, sourced from the backend's
 *  own fixed `PUBLIC_COMPANIES` ordering), joined with `", "`. Singular
 *  `(Station: X)` for exactly one company, plural `(Stations: X, Y)` for
 *  two or more -- matching the exact two example strings from the
 *  request -- and the suffix is omitted ENTIRELY (not printed as
 *  `(Stations: )` or `(Stations: 0)`) when no company has a token on this
 *  hex, same "only appears when true" standard design note #103 applied to
 *  the Value suffix. Appended last, after the value/terrain-cost suffixes
 *  above, matching this function's own established left-to-right ordering
 *  (name, then value, then cost, then stations). */
function describeHexWithValue(
  q: number,
  r: number,
  mapGrid: MapGridResponse,
  currentEra: TileColorTier,
  publicCompanies: readonly StationTokenCompany[],
): string {
  const base = describeHex(q, r);
  const boardHex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);

  let result = base;

  const offboardName = boardHex ? OFFBOARD_LABELS[boardHex.label] : undefined;
  if (offboardName) {
    const tiers = OFFBOARD_REVENUE[offboardName];
    if (tiers) {
      const offboardValue = offboardValueForEra(tiers, currentEra);
      if (offboardValue !== 0) result = `${result} (Value: $${offboardValue})`;
    }
  } else {
    const value = hexRouteValue(q, r, mapGrid);
    if (value !== null && value !== 0) result = `${result} (Value: $${value})`;
  }

  if (boardHex) {
    // Design note #136 (F-2): resolved by COORDINATE through the mirror of
    // `hexmap::terrain_build_fee`, not by looking the hex's display type up
    // in a label table.
    const terrainFee = terrainBuildFeeAt(q, r);
    if (terrainFee > 0) result = `${result} (Terrain Cost: $${terrainFee})`;
  }

  // Design note #118: real placed station tokens, by ticker -- not a
  // capacity count.
  const tickersHere = publicCompanies
    .filter((company) => company.station_token_hexes.some(([hexQ, hexR]) => hexQ === q && hexR === r))
    .map((company) => company.ticker);
  if (tickersHere.length === 1) {
    result = `${result} (Station: ${tickersHere[0]})`;
  } else if (tickersHere.length > 1) {
    result = `${result} (Stations: ${tickersHere.join(", ")})`;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

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
}

const EMPTY_ROUTE_OVERLAYS: readonly RouteOverlay[] = [];

export interface HexGridRendererProps {
  /** `QueryMsg::GetMapGrid`'s response, verbatim. */
  mapGrid: MapGridResponse;
  /** Pixel radius (center to corner) of one hex. Default 42. */
  hexSize?: number;
  /** Explicit pixel size override. Omit both (the default, and the expected
   *  usage per design note #19/Request F item 3, refined by design note
   *  #27/item 1) to let this component measure its own wrapping `<div>`'s
   *  available WIDTH via `ResizeObserver` and flex-fill that; `height` in
   *  that case is no longer independently measured -- it's DERIVED from the
   *  real board's own aspect ratio at that width, so the canvas always
   *  renders at its true full proportional size instead of being cropped to
   *  fit a bounded ancestor pane. Provide both explicitly to keep the old
   *  fixed-pixel, independently-set-dimensions behavior. */
  width?: number;
  height?: number;
  className?: string;
  /** Enables the click interceptor (design note #7): when all four of
   *  `queryClient`/`contractAddress`/`gameId`/`protocolId` are provided, a
   *  genuine click on a hex (as opposed to a pan drag -- see
   *  `handlePointerUp`) converts the pixel to `(q, r)` and fires
   *  `GetLegalTilePlacements` against `queryClient`. Omit any of them to
   *  keep this component's original pan/zoom-only, query-free behavior. */
  queryClient?: QueryCapableClient;
  contractAddress?: string;
  gameId?: number;
  protocolId?: number;
  /** Traced train routes to draw over the rail map -- design note #137
   *  (F-1). One entry per train; omit or pass `[]` for no overlay.
   *
   *  This is the layer the board previously had NO equivalent of: track was
   *  drawn, but which track a train actually RAN was never shown, so a player
   *  building a manual route had no visual confirmation of the path they were
   *  assembling. */
  routeOverlays?: readonly RouteOverlay[];
  /** Fired synchronously on every genuine hex click, before the
   *  `GetLegalTilePlacements` query (if enabled) resolves -- lets the host
   *  app position a popup immediately instead of waiting on the network. */
  onHexClick?: (info: {
    q: number;
    r: number;
    hexLabel: string;
    clientX: number;
    clientY: number;
  }) => void;
  /** Reports the click-triggered `GetLegalTilePlacements` query's
   *  lifecycle -- see `HexClickQueryState`. */
  onHexClickQuery?: (state: HexClickQueryState) => void;
  /** When set, draws a translucent dashed-outline "ghost" preview of
   *  `tileId` at `orientation` on hex `(q, r)` -- the live map preview (see
   *  design note #7 / item 3 of the popup feature). */
  previewTile?: { q: number; r: number; tileId: number; orientation: number } | null;
  /** The room's live `GameStateResponse.current_global_era` -- see design
   *  note #15/item 4. Drives which single off-board revenue tier renders
   *  inside each red off-board hex. Defaults to `"Yellow"` (every new
   *  game's real starting era) so this component still renders sensibly
   *  when the host app hasn't wired a live `GetGameState` query yet. */
  currentEra?: TileColorTier;
  /** The room's live `GameStateResponse.public_companies`, verbatim (or a
   *  `StationTokenCompany[]` subset of it) -- see design note #36. Drives
   *  the Station Token marker rendering pass: a muted preprinted marker at
   *  each `STATION_HOME_HEXES` entry for any company not yet `is_floated`,
   *  and a real ticker-labeled marker at every one of a floated company's
   *  own `station_token_hexes`. Defaults to an empty array, so this
   *  component still renders its existing city circles sensibly (just with
   *  no Station Token overlay at all) when the host app hasn't wired a
   *  live `GetGameState` query yet -- the same fallback pattern `currentEra`
   *  above already establishes. */
  publicCompanies?: StationTokenCompany[];
}

interface ViewTransform {
  panX: number;
  panY: number;
  zoom: number;
}

const DEFAULT_HEX_SIZE = 42;
const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 640;
/** Design note #36/item 1: was a flat `MAX_ZOOM = 3` ABSOLUTE cap, applied
 *  not just to the interactive zoom-in handlers below but to `minZoom`
 *  itself (the baseline board-fit zoom) -- on a wide-enough viewport,
 *  `fitZoom = width / boundsWidth` legitimately exceeds `3`, and that old
 *  absolute cap would silently clamp the baseline fit back DOWN to `3`,
 *  leaving real unused width on a widescreen pane instead of letting the
 *  board's true full-width scale (this item's "static max/min scale
 *  fraction override" that "compresses our map"). Redefined as a
 *  MULTIPLIER on `minZoom` instead of an absolute pixel-density constant --
 *  every use site below now computes `minZoom * MAX_ZOOM_MULTIPLIER`
 *  fresh, so the interactive "zoom in past the fit baseline" ceiling always
 *  scales WITH the baseline instead of ever being able to sit below it
 *  (the old absolute constant could invert -- a `minZoom` of `4` on a very
 *  wide viewport with the old `MAX_ZOOM = 3` would have made the
 *  "detail zoom" ceiling literally SMALLER than the baseline fit, an
 *  impossible zoomed-OUT "zoom in" button). `3` is kept as the multiplier's
 *  own value -- unrelated to the old absolute-pixel-density meaning, it
 *  just happens to be a reasonable "3x closer than the full-board fit"
 *  interactive zoom-in ceiling either way. */
const MAX_ZOOM_MULTIPLIER = 3;
/** Absolute safety floor under the dynamically-computed board-fit minimum
 *  zoom (design note #8) -- guards only against a degenerate near-zero
 *  viewport/`hexSize` combination; in normal use the computed `minZoom`
 *  below is always well above this. */
const ABSOLUTE_MIN_ZOOM_FLOOR = 0.1;

/** Rail Map Overhaul (design note #42): "Clean Up Control Overlay Overlaps."
 *  The old separate "Toggle Detailed View" button (design note #13) is
 *  removed outright per that item's explicit instruction -- `detailedView`
 *  itself is UNCHANGED (still gates pan/zoom, design note #13), it's just no
 *  longer toggled by its own dedicated button; `handleZoomStep` (design note
 *  #17) already flips it on by itself the moment "+"/"-" is pressed, and
 *  "Fit to Screen" already re-locks it back off, so removing this one
 *  redundant control loses no capability. The former "+"/"-"/"Fit to
 *  Screen" stack is consolidated into ONE floating "clean container" (this
 *  panel) -- a single bordered/backed card holding City Names/"-"/"+"/"Fit
 *  to Screen" as a horizontal row -- instead of two separate overlay
 *  clusters. Positioned top-right (the corner the old toggle button used to
 *  occupy) with a generous `20px` margin inset -- larger than the old
 *  16px -- specifically so this single compact row sits further inside the
 *  canvas, away from `drawBoardMarginLabels`' own row-letter/column-number
 *  text, which (design note #28) is drawn deliberately close to the true
 *  board edge. */
const MAP_CONTROLS_PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "20px",
  right: "20px",
  zIndex: 5,
  display: "flex",
  flexDirection: "row",
  alignItems: "stretch",
  gap: "6px",
  padding: "8px",
  borderRadius: "10px",
  border: "1.5px solid #5c6a52",
  backgroundColor: "rgba(20, 20, 20, 0.85)",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
};

/** Base style shared by every button inside `MAP_CONTROLS_PANEL_STYLE` --
 *  see design note #42. `minWidth`/`textAlign` keep the single-character
 *  "+"/"-" buttons the same width as their wordier siblings in the same
 *  row. */
const CAMERA_CONTROL_BUTTON_STYLE: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "6px",
  border: "2px solid #5c6a52",
  backgroundColor: "rgba(255, 255, 255, 0.06)",
  color: "#f4ecd8",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  fontSize: "18px",
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
  minWidth: "44px",
  textAlign: "center",
};

/** The floating "G19: New York (Value: $20)"-style coordinate+value
 *  tooltip -- see design note #21, scaled up and value-enriched by design
 *  note #26/item 2. `position: fixed` since it tracks the raw viewport
 *  pointer position (`clientX`/`clientY`), not anything relative to the
 *  wrapping panel. `pointerEvents: "none"` so it can never itself intercept
 *  the pointer events it's reporting on. Padding/font size roughly doubled
 *  from the original coordinate-only tooltip (design note #21) so the now-
 *  longer "{label}: {name} (Value: $X)" string stays fully legible instead
 *  of reading as a cramped afterthought. */
const HOVER_TOOLTIP_STYLE: React.CSSProperties = {
  position: "fixed",
  zIndex: 20,
  pointerEvents: "none",
  padding: "9px 16px",
  borderRadius: "10px",
  backgroundColor: "rgba(18, 20, 26, 0.94)",
  border: "2px solid #6a7285",
  color: "#f4ecd8",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  fontSize: "20px",
  fontWeight: 700,
  whiteSpace: "nowrap",
  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.55)",
};

interface BoardContentBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The `[lo, hi]` pan range, along one axis, that keeps the board's own
 *  footprint from ever being fully dragged out of the canvas viewport at a
 *  given zoom level -- see design note #8. A single formula handles both
 *  the "board bigger than the viewport" case (keep the viewport inside the
 *  board) and the "board smaller than the viewport" case (keep the board
 *  inside the viewport): the two raw candidate bounds swap their min/max
 *  ordering exactly at the point where the board's scaled size crosses the
 *  viewport size, so sorting them always produces the correct pair either
 *  way, with no branching needed. */
function panClampRange(
  boundMin: number,
  boundMax: number,
  zoom: number,
  viewportSize: number,
): { lo: number; hi: number } {
  const a = viewportSize - boundMax * zoom;
  const b = -boundMin * zoom;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** Clamps a candidate `(panX, panY)` into the range `panClampRange`
 *  computes for each axis -- see design note #8. */
function clampPanToBoard(
  panX: number,
  panY: number,
  zoom: number,
  bounds: BoardContentBounds,
  viewportWidth: number,
  viewportHeight: number,
): { panX: number; panY: number } {
  const xRange = panClampRange(bounds.minX, bounds.maxX, zoom, viewportWidth);
  const yRange = panClampRange(bounds.minY, bounds.maxY, zoom, viewportHeight);
  return {
    panX: Math.min(xRange.hi, Math.max(xRange.lo, panX)),
    panY: Math.min(yRange.hi, Math.max(yRange.lo, panY)),
  };
}

/** Stable empty-array default for the `publicCompanies` prop (design note
 *  #36) -- a fresh `[]` literal in the destructuring default below would
 *  be a NEW array reference on every render, which would in turn make
 *  `draw`'s own `useCallback` dependency array (which includes
 *  `publicCompanies`) see a "changed" dependency every render and rebuild
 *  the callback needlessly. One shared module-level reference avoids that.
 *  Typed as plain (non-`readonly`) `StationTokenCompany[]`, matching the
 *  prop's own declared type exactly -- never actually mutated, but a
 *  `readonly` array literal here would not be assignable to that
 *  destructuring default. */
const EMPTY_PUBLIC_COMPANIES: StationTokenCompany[] = [];

export function HexGridRenderer({
  mapGrid,
  hexSize = DEFAULT_HEX_SIZE,
  width: widthProp,
  height: heightProp,
  className,
  queryClient,
  contractAddress,
  gameId,
  protocolId,
  onHexClick,
  onHexClickQuery,
  previewTile,
  currentEra = "Yellow",
  publicCompanies = EMPTY_PUBLIC_COMPANIES,
  routeOverlays = EMPTY_ROUTE_OVERLAYS,
}: HexGridRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  /** Live-measured size of the wrapping `<div>` -- see design note #19.
   *  Only consulted when `widthProp`/`heightProp` are omitted; seeded with
   *  the old fixed defaults purely as a sane first-paint fallback before
   *  the `ResizeObserver` below reports its first real measurement. */
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });

  useEffect(() => {
    if (widthProp !== undefined && heightProp !== undefined) return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width: observedWidth, height: observedHeight } = entry.contentRect;
      // Guard against a transient near-zero-size measurement clobbering the
      // last known-good `measuredSize` (design note #34/item 1). Originally
      // just `< 1`, which only caught a literal zero -- too narrow to catch
      // the actual reported bug: switching away from this component's tab
      // and back (a React re-render that toggles the host pane's display,
      // not an unmount) can report a transient SINGLE-DIGIT pixel size for
      // one observation (e.g. a hidden pane briefly reporting `contentRect`
      // as `{width: 4, height: 2}` mid-swap, before layout settles back to
      // its real size) -- comfortably past the old `< 1` gate, so it used to
      // sail through and collapse `measuredSize` (and therefore `hexSize`/
      // `minZoom`/the whole camera fit) down to that near-zero size, which
      // is the "crashing the layout down to zero" this item reports.
      // Widened to `<= 10`: still small enough that no real, usable board
      // pane will ever legitimately measure at or under it, but comfortably
      // covers the transient tab-swap readings actually seen. Simply
      // `return`ing here (skipping `setMeasuredSize` entirely) is already
      // exactly the "preserve last known valid ... settings" behavior this
      // item asks for -- React state isn't touched, so `measuredSize` stays
      // at whatever it was before this bad reading, with zero extra state
      // needed to "remember" it separately.
      if (observedWidth <= 10 || observedHeight <= 10) return;
      setMeasuredSize((prev) => {
        if (prev.width === observedWidth && prev.height === observedHeight) return prev;
        return { width: observedWidth, height: observedHeight };
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [widthProp, heightProp]);

  // The board's own fixed, unscaled footprint -- deliberately memoized on
  // `hexSize` alone, NOT on `mapGrid.tiles` (design note #8): the
  // clampable/fittable area is the physical board, not whatever happens to
  // be laid on it yet. MOVED above the `width`/`height` derivation below
  // (design note #27/item 1) -- `height` is now DERIVED from this board's
  // own aspect ratio, so it has to exist first.
  const boardContentBounds = useMemo<BoardContentBounds>(() => {
    const points = [
      ...STATIC_BOARD_HEXES.map((h) => axialToPixel(h.q, h.r, hexSize)),
      ...LANDMARK_HEXES.map((l) => axialToPixel(l.q, l.r, hexSize)),
    ];
    // Design note #26: tightened to the hexes' own true outermost
    // coordinate edges -- `hexSize` is the exact center-to-corner radius
    // (see `pointOnCircle(center, size, cornerAngleRad(i))` in
    // `drawHexPath`), so padding by exactly `hexSize` is the tight,
    // mathematically-derived bound against each edge hex's real corner,
    // not an arbitrary buffer. The previous `hexSize * 2.5` term (extra
    // clearance reserved for the margin labels drawn outside the board)
    // has been removed outright per that item's explicit "completely
    // remove any large hardcoded pixel padding" instruction -- see design
    // note #26 for the accepted margin-label tradeoff this creates.
    //
    // FOLLOW-UP ("Camera Padding Must Reserve Room For Margin Labels"):
    // design note #26's tight `hexSize`-only padding left literally ZERO
    // slack beyond each edge hex's own corner point -- fine for the board
    // itself, but it meant there was no room at all left over for the
    // margin labels drawn just outside that corner, which is the deeper
    // reason column-number labels kept overlapping the top/bottom hexes
    // even after `computeBoardMarginLabels`'s own width-vs-height
    // measurement bug was fixed (that fix corrected WHICH dimension the
    // label's clearance came from, but there was no budget left in that
    // dimension to spend). `marginLabelReserve` adds back a small,
    // proportional reservation -- NOT the old flat `hexSize * 2.5` -- sized
    // off `hexSize`/font size alone so it stays a minimal, formula-derived
    // top-up rather than the "large hardcoded pixel padding" that note #26
    // was written to remove. `computeBoardMarginLabels` MUST keep deriving
    // its own `hexEdgePadding` from this exact same total (see its own
    // comment) or the two fall back out of sync.
    const hexEdgePadding = hexSize + marginLabelReserve(hexSize);
    return {
      minX: Math.min(...points.map((p) => p.x)) - hexEdgePadding,
      maxX: Math.max(...points.map((p) => p.x)) + hexEdgePadding,
      minY: Math.min(...points.map((p) => p.y)) - hexEdgePadding,
      maxY: Math.max(...points.map((p) => p.y)) + hexEdgePadding,
    };
  }, [hexSize]);

  const width = widthProp ?? measuredSize.width;
  /** ITEM 1 FIX (design note #27): `height` used to come straight from the
   *  `ResizeObserver`'s own measured container height -- which only ever
   *  reflected whatever fixed/clamped height an ancestor pane imposed (see
   *  `App.tsx` design note #13), i.e. exactly the "tiny panel box" this item
   *  reports. Now that no ancestor imposes one, that measurement would be
   *  meaningless (a `height: auto` box just mirrors back whatever this
   *  component itself renders -- circular). `height` is now DERIVED from
   *  the board's own true aspect ratio (`boardContentBounds`) at the
   *  available `width`, so the canvas always renders at its full natural
   *  proportional height for that width -- "true maximum proportional scale
   *  bounds," not vertically cropped/shrunk to fit whatever bounded
   *  viewport happened to be available. Ancestors are now free to just grow
   *  to match (`App.tsx` design note #13), letting the BROWSER's own page
   *  scrollbar carry the rest. */
  const height = useMemo(() => {
    if (heightProp !== undefined) return heightProp;
    const boundsWidth = Math.max(boardContentBounds.maxX - boardContentBounds.minX, 1);
    const boundsHeight = Math.max(boardContentBounds.maxY - boardContentBounds.minY, 1);
    return Math.round(width * (boundsHeight / boundsWidth));
  }, [heightProp, boardContentBounds, width]);
  /** Monotonic counter guarding against a stale `GetLegalTilePlacements`
   *  response (from an earlier click) resolving after a newer click's
   *  request has already superseded it -- only the most recent request's
   *  result is ever reported to `onHexClickQuery`. */
  const clickQuerySeqRef = useRef(0);

  const [view, setView] = useState<ViewTransform>({
    panX: width / 2,
    panY: height / 2,
    zoom: 1,
  });
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
  } | null>(null);

  /** The zoom level used for the locked baseline camera pose -- see design
   *  note #8, tightened by design note #26.
   *
   *  ITEM 1 FIX (design note #27, supersedes the structural calibration
   *  pass's `Math.max(width / boundsWidth, height / boundsHeight)` "fill
   *  both edge-to-edge, crop whichever axis doesn't fit" formula): now that
   *  `height` (above) is DERIVED to always match `boundsWidth`'s own aspect
   *  ratio at this `width`, fitting to `width` alone is exactly equivalent
   *  to fitting to both axes -- there is no longer a mismatched-aspect-ratio
   *  viewport to crop against, because the viewport's own aspect ratio now
   *  always matches the board's. This is what "true maximum proportional
   *  scale bounds" means concretely: the hex size that makes the board's
   *  full width exactly fill the available `width`, with zero cropping on
   *  either axis, rather than the previous pass's deliberate crop-to-fill.
   *  Toggling "Detailed View" still lets a player pan/zoom in past this for
   *  a closer look, same as before. */
  const minZoom = useMemo(() => {
    const boundsWidth = Math.max(boardContentBounds.maxX - boardContentBounds.minX, 1);
    const fitZoom = width / boundsWidth;
    // Design note #36/item 1: no upper clamp here anymore -- only the
    // degenerate-viewport floor. `fitZoom` IS "the base hex radius
    // multiplier scaled up so the map naturally occupies the widescreen
    // space," so nothing should cap it back down on a wide viewport.
    return Math.max(ABSOLUTE_MIN_ZOOM_FLOOR, fitZoom);
  }, [boardContentBounds, width]);

  /** The locked "100% view" camera pose -- see design note #13. Exactly
   *  `minZoom`, centered on the board's own bounds, i.e. the same
   *  computation the one-shot auto-fit (design note #5) already used. This
   *  is now also the camera's permanent baseline pose: with
   *  `detailedView === false`, `view` is always exactly this (drag/wheel
   *  handlers are no-ops at baseline), and toggling detailed view back off
   *  snaps the camera back to precisely this pose. */
  const fitView = useMemo<ViewTransform>(() => {
    const centerX = (boardContentBounds.minX + boardContentBounds.maxX) / 2;
    const centerY = (boardContentBounds.minY + boardContentBounds.maxY) / 2;
    return {
      zoom: minZoom,
      panX: width / 2 - centerX * minZoom,
      panY: height / 2 - centerY * minZoom,
    };
  }, [boardContentBounds, minZoom, width, height]);

  /** `false` (the default): the camera is locked at exactly `fitView` --
   *  the "100% view", the whole board framed in the viewport -- and pan/
   *  zoom input is ignored (see design note #13). `true`: the "Toggle
   *  Detailed View" button was clicked -- the camera jumped to a closer,
   *  zoomed-in pose and drag-pan/wheel-zoom are both live so the player can
   *  inspect close details manually. */
  const [detailedView, setDetailedView] = useState(false);

  /** Rail Map Overhaul (design note #42): "City Nameplate Visibility
   *  Toggle." `true` (the default): city/landmark name plates render
   *  normally, exactly as before this item. `false`: `draw()`'s every
   *  name-label pass (landmark names, gray/OO hex names, the stacked
   *  dual-city/dual-town name pairs, and the off-board zone nameplates) is
   *  skipped outright -- station tokens, revenue/value badges, and every
   *  track spline are all drawn by entirely separate passes earlier in
   *  `draw()` and are completely unaffected either way, per this item's own
   *  explicit "while maintaining station tokens, revenue badges, and track
   *  splines" wording. */
  const [showCityNames, setShowCityNames] = useState(true);

  /** The off-board hex currently under the pointer, if any -- see design
   *  note #15/item 4. Tracked independently of drag/`detailedView` state
   *  (hover works at the locked 100% baseline too, not just in detailed
   *  view): `handlePointerMove` updates this on every move, `handlePointerUp`
   *  (also wired to `onPointerLeave`) clears it. Stored as the hovered
   *  hex's own axial `(q, r)`, not a pixel/label, so it stays correct
   *  across zoom/pan changes without needing to be recomputed. */
  const [hoveredOffboardHex, setHoveredOffboardHex] = useState<{ q: number; r: number } | null>(
    null,
  );

  /** The hex currently under the pointer, if any -- see item 7 ("Muted Base
   *  Text with Hover Glow"). Deliberately separate from `hoveredOffboardHex`
   *  above (which only ever populates for an off-board zone hex, for that
   *  feature's own narrower tooltip purpose): this one is set on EVERY
   *  pointer move regardless of what kind of hex is under it, so `draw()`'s
   *  city/town/landmark name-label passes can look it up to decide whether
   *  that specific hex's label should render in its bright, bold, 100%-
   *  opaque hover style instead of its default muted/translucent one. */
  const [hoveredHexCoord, setHoveredHexCoord] = useState<{ q: number; r: number } | null>(null);

  /** The active-coordinate hover tooltip's live state -- see design note
   *  #21. `label` is the same board-label string `describeHex` would
   *  produce (a landmark's name + label, an off-board zone's name + label,
   *  or a plain board label like `"G19"`); `null` whenever the pointer
   *  isn't over a real hex of the authentic board at all, which hides the
   *  tooltip entirely rather than reporting a meaningless "off the board"
   *  string. `clientX`/`clientY` are the raw viewport pointer coordinates
   *  (NOT canvas-relative), so the DOM tooltip below can position itself
   *  with plain `position: fixed` math. `preferLeft`/`preferAbove` (design
   *  note #75) mirror `drawOffboardTooltip`'s own "ADAPTIVE QUADRANT"
   *  pattern for this file's OTHER tooltip -- reported: this one always
   *  anchored down-right of the cursor regardless of available room, so it
   *  ran off the panel for any hex near the panel's own right/bottom edge
   *  (Boston, Fall River). Set once per pointer move, from the cursor's
   *  position within the CANVAS's own bounding rect (i.e. the panel), not
   *  the browser window -- so the flip threshold tracks the panel's actual
   *  edges even if the canvas doesn't fill the whole viewport. */
  const [hoveredCoordLabel, setHoveredCoordLabel] = useState<{
    label: string;
    clientX: number;
    clientY: number;
    preferLeft: boolean;
    preferAbove: boolean;
  } | null>(null);

  /** The full draw pass: background, landmark shading, every laid tile's
   *  fill + track path, then landmark labels on top so they stay legible
   *  regardless of what's drawn beneath them. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Neutral dark charcoal workspace background -- see design note #18.
    // Everything outside the authentic 93-hex footprint (including the real
    // A13/A15 gap) simply shows this solid fill; no decorative hex fills any
    // of that space anymore.
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, width, height);

    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);

    // Used by every label pass below (moved up from its previous spot
    // right before the landmark labels, since the new terrain-icon labels
    // pass now needs it earlier too).
    const hexFlatWidth = Math.sqrt(3) * hexSize;

    // ---- Static board background (see design note #6) -- drawn first, so
    // everything else (landmark shading, laid tiles, labels) layers on top
    // of it. This is what makes the board visible at game launch, before
    // any tile has been laid.
    for (const hex of STATIC_BOARD_HEXES) {
      const center = axialToPixel(hex.q, hex.r, hexSize);
      drawHexPath(ctx, center, hexSize);
      // Pre-printed gray/yellow hexes override the ordinary terrain fill
      // (see design note #12) -- `hex.type` still drives the terrain icon
      // pass below regardless, so e.g. E5 gets BOTH the yellow fill AND its
      // river icon/cost label.
      ctx.fillStyle = hex.printedColor ? PRINTED_HEX_FILL[hex.printedColor] : BOARD_HEX_FILL[hex.type];
      ctx.fill();
      ctx.strokeStyle = hex.printedColor
        ? PRINTED_HEX_STROKE[hex.printedColor]
        : BOARD_HEX_STROKE[hex.type];
      ctx.lineWidth = 1;
      // Design note #26/item 3: I1/J2 (Gulf) suppress their one shared
      // interior edge here so the two hexes read as a single merged region
      // -- `drawHexEdges` re-strokes the OTHER five edges individually
      // instead of `ctx.stroke()`ing the full closed path `drawHexPath`
      // just traced above. Item 9: A9/A11 (Canadian West) get the identical
      // treatment via `CANADIAN_WEST_HIDDEN_EDGE`.
      const hiddenEdge = GULF_HIDDEN_EDGE[hex.label] ?? CANADIAN_WEST_HIDDEN_EDGE[hex.label];
      if (hiddenEdge !== undefined) {
        drawHexEdges(ctx, center, hexSize, new Set([hiddenEdge]));
      } else {
        ctx.stroke();
      }
    }

    // Design note #72: ONE claimed-slot ledger, shared by every one of this
    // render's slot-picking passes (terrain icon, restriction badge,
    // terrain-cost label, revenue badge) in their existing draw order --
    // see `claimHexSlot`'s own doc comment for why this exists (New York/
    // G19's badge, cost label, and icon all independently picking the same
    // one open corner). Declared fresh here, at the top of this whole block
    // of passes, and threaded through every one of them below.
    const claimedHexSlots = new Map<string, Set<number>>();

    // Design note #72: the SE-edge-first preference a complex hex's terrain
    // icon/cost share -- pulled out to a shared constant so both stay in
    // visual agreement about which corner/edge is "the bottom-right
    // quadrant". Design note #87: RENAMED from `DOUBLE_CITY_TERRAIN_SLOT_PREFERENCE`
    // (unchanged values) now that it's used by every complex hex's ONE
    // compound [icon+cost] badge claim, not just DoubleCity's separate
    // icon-slot claim.
    //
    // Design note #105: REORDERED, per direct request -- now leads with
    // (what the request calls) "Vertex 2" and "Vertex 4", this system's
    // own slot 9 (Lower-Right corner) and slot 11 (Lower-Left corner)
    // respectively, before falling through to the original SE-edge/
    // Bottom-Point pair (slots 3/10) as before.
    const COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE: readonly number[] = [9, 11, 3, 10];

    // ---- Buildable terrain icons (design note #9; SPLIT from its own cost
    // label by design note #55's Strict Canvas Layering Hierarchy -- a cost
    // label is Layer 4 (text) content and now draws in that section further
    // below, alongside every other badge/label; only the Layer 1 terrain
    // VECTOR itself belongs this early). Mountain hexes get a brown
    // twin-peak icon, River hexes get a blue river-line icon -- both now sit
    // on the standard land fill drawn above, so they read as "buildable, at
    // a cost" rather than "impassable obstacle".
    //
    // Design note #87: a "complex" hex -- one with a city/town archetype OR
    // real live track -- no longer draws a standalone icon here AT ALL.
    // GENERALIZED from the old DoubleCity-only check, which missed the
    // SingleCity `cityDesignation` River hexes (Toledo/F4, Providence/F22,
    // Washington D.C./J14) -- those rendered a FULL-SIZE, dead-CENTERED
    // icon directly under their own revenue badge/nameplate, since
    // `isDoubleCityHex` was false for them. Every complex hex's icon is now
    // drawn together with its cost, as ONE compound badge, by the
    // terrain-cost pass further below (Layer 4) -- claiming exactly ONE
    // slot there, instead of the two separate claims (one here, one there)
    // a DoubleCity hex used to make.
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      const terrainType = hex.type;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isComplexHex =
        archetypeForHex(mapGrid, hex.q, hex.r) !== "Plain" ||
        liveEdgesForHex(mapGrid, hex.q, hex.r).length > 0;
      if (isComplexHex) continue;
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask --
      // the terrain icon itself never bleeds past this hex's own border.
      withHexClip(ctx, center, hexSize, () => {
        drawTerrainIcon(ctx, terrainType, center, hexSize);
      });
    }

    // ---- Landmark dashed outline (drawn next, so a laid hub tile there,
    // and the label drawn later, both sit visibly on top of it).
    // ITEM 1 FIX (color calibration pass, "Unify All Board Yellow
    // Shades"): this loop used to ALSO re-fill each landmark hex with its
    // own translucent per-city tint (`LANDMARK_FILL` -- a ~20%-alpha red/
    // blue/green painted over that hex's ordinary cream `BOARD_HEX_FILL.Plain`
    // base from the static-background pass above), which is exactly the
    // "lighter pastel/cream" look this item reports -- visually distinct
    // from every other real pre-printed yellow hex on the board. Design
    // note #12 already established, from the same sourced data as the
    // pre-printed yellow "OO" hexes, that New York/Boston/Baltimore ARE
    // real pre-printed yellow hexes too -- so `STATIC_BOARD_HEXES`'s own
    // entries for G19/E23/I15 now carry `printedColor: "Yellow"` just like
    // every OO hex, which means the static-background pass above already
    // fills them with the exact same shared `PRINTED_HEX_FILL.Yellow`
    // constant an OO hex gets -- genuinely "the exact same... fill color"
    // this item asks for, not just a matching hex string. FACTUAL
    // CORRECTION: this item's own suggested `#FFCC00` example doesn't match
    // what this file actually uses for OO/catalog yellow anywhere --
    // `PRINTED_HEX_FILL.Yellow` is `#e8d488`, a deliberately muted
    // "cardstock" gold (design note #12), not a bright saturated color; no
    // bright/saturated yellow fill exists anywhere else in this file to
    // match. Using the literal `#FFCC00` example instead would have
    // introduced a FOURTH distinct yellow shade rather than unifying to the
    // three hexes that already share one -- so this pass points landmarks
    // at the real shared constant instead, which is what actually delivers
    // this item's own stated goal ("a uniform visual look across the map").
    // This loop's own `LANDMARK_FILL` fill is removed outright (the base
    // pass already paints the correct fill); only the dashed white outline
    // -- which still usefully flags "this hex is a landmark station",
    // unrelated to fill color uniformity -- remains here.
    for (const landmark of LANDMARK_HEXES) {
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      drawHexPath(ctx, center, hexSize);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#ffffff88";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- Every laid tile: fill, outline, and its decoded track path.
    // Landmark hexes (New York/Boston/Baltimore) skip the generic
    // bitmask-driven `drawTrackPath` entirely -- their authentic
    // pre-printed track is drawn unconditionally in a dedicated pass below
    // instead (see design note #6b). The fill/outline (including any
    // color-tier upgrade) still draws here either way.
    // BUG FIX ("Unify All Board Yellow Shades" follow-up -- reported: I15/
    // G19/E23 render a visibly different shade of yellow from every other
    // pre-printed yellow hex). The earlier pass fixed the STATIC background
    // fill (`STATIC_BOARD_HEXES`'s own `printedColor: "Yellow"` entries,
    // painted with `PRINTED_HEX_FILL.Yellow` = `#e8d488` before any tile is
    // laid), but this loop repaints right over that base the moment a real
    // `mapGrid.tiles` entry exists at that hex -- which, for a landmark, is
    // basically always true (a `MajorCityHub`/`DoubleCityHub` tile is
    // required there per the backend's landmark reservation, not an
    // optional player upgrade), using `ERA_TILE_FILL[catalogEntry.color]` (design note #122)
    // instead -- `TERRAIN_FILL.MajorCityHub`/`DoubleCityHub` is `#e8d9c0`, a
    // distinctly lighter/less-saturated tan than `#e8d488`, which is
    // exactly the "different shade of yellow" this reports. The same latent
    // mismatch applies to the four `YELLOW_OO_HEXES` once THEY receive a
    // laid `DoubleCityHub` tile too (tile 15) -- they just hadn't yet in
    // this game state, which is why only the landmarks showed it. Elsewhere
    // in this file, a laid tile's FILL is deliberately terrain-only, with
    // color-tier (Yellow/Green/Brown) conveyed purely through the stroke
    // below (`COLOR_TIER_STROKE`) -- never the fill -- so this keeps that
    // same convention for these hexes: any hex whose `STATIC_BOARD_HEXES`
    // entry is `printedColor: "Yellow"` (landmarks AND OO hexes alike) always
    // keeps the shared `PRINTED_HEX_FILL.Yellow` fill regardless of which
    // hub tile ends up laid there or what tier it's since been upgraded to
    // -- exactly mirroring how the pre-laid static pass already treats it,
    // and how an ordinary buildable hex's fill never encodes tier either.

    for (const tile of mapGrid.tiles) {
      const catalogEntry = TILE_CATALOG_BY_ID.get(tile.tile_id);
      const center = axialToPixel(tile.q, tile.r, hexSize);

      drawHexPath(ctx, center, hexSize);
      // Design note #122: era, and only era. No terrain keying, and no
      // printed-yellow override for landmark/OO hexes -- see `ERA_TILE_FILL`.
      ctx.fillStyle = catalogEntry ? ERA_TILE_FILL[catalogEntry.color] : "#dddddd";
      ctx.fill();
      ctx.strokeStyle = catalogEntry ? COLOR_TIER_STROKE[catalogEntry.color] : "#9a9a9a";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (catalogEntry) {
        // Design note #133: the `!landmarkAt(...)` guard that used to sit
        // here is GONE, and its removal is the real fix for the reported
        // "tile 62 draws crossing track with a station dumped on the
        // intersection".
        //
        // New York, Boston and Baltimore are `LANDMARK_HEXES`. The guard
        // meant a laid tile on one of them never called `drawTrackPath` at
        // all -- so #54/#62 (NY) and #53/#61 (B) could never reach the
        // hardcoded artwork catalog no matter what was in it. What the
        // player saw on G19 instead was the PRE-PRINTED landmark track
        // from `drawLandmarkTrack`, whose two stubs run to
        // `twoNodePositions`' fixed NE/SW diagonal: a stub from the NW
        // edge sweeping down to the SW node crosses the other stub, and
        // the station sits on the crossing. Exactly the reported symptom,
        // and entirely upstream of the #62 path strings -- those are
        // provably non-crossing (see `TILE_GRAPHICS_CATALOG`'s #62 note:
        // the two arcs occupy x >= 0.366 and x <= -0.366 respectively).
        //
        // The pre-printed track pass below is now the one that yields,
        // which is the correct direction: printed artwork is what a hex
        // shows UNTIL a tile covers it.
        // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
        withHexClip(ctx, center, hexSize, () => {
          // Design note #121: no longer passes `tile.paths`. Double-town
          // artwork now comes from the explicit `DOUBLE_TOWN_ROUTES` table
          // keyed on `tile_id`, and every other tile was always drawn from
          // `connections` alone -- so there is nothing left for the
          // per-tile query value to feed. The contract still sends it and
          // `MapTileEntry.paths` still types it; this renderer just has no
          // use for it now.
          drawTrackPath(ctx, center, hexSize, catalogEntry, tile.orientation, false);
        });
      } else {
        // Unknown tile_id -- see design notes #2 and #118. Renders generic
        // provisional artwork rather than silently drawing nothing (or,
        // as previously, an alarming bare red "?" that read as an error
        // state). Every one of the backend's 46 real tray tiles IS in the
        // mirror above, so reaching this path means the mirror has fallen
        // behind a further backend change -- degraded, but never a crash.
        withHexClip(ctx, center, hexSize, () => {
          drawUnknownTilePlaceholder(ctx, center, hexSize, tile.tile_id);
        });
      }
    }

    // ---- Landmark pre-printed track, always drawn (see design note #6b).
    // Positioned after the per-tile loop (not folded into the earlier
    // landmark-shading pass) so a laid hub tile's own opaque fill -- drawn
    // in that loop above -- can never paint over this authentic track.
    for (const landmark of LANDMARK_HEXES) {
      // Design note #133: "always drawn" was the bug's other half. A
      // landmark's pre-printed track is its STARTING artwork, not a
      // permanent overlay -- once a real tile is laid the printed stubs are
      // physically covered by it. Continuing to draw them on top of a laid
      // #62 stacked two different renderings of New York in the same hex.
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawLandmarkTrack(ctx, center, hexSize, LANDMARK_TRACKS[landmark.name] ?? []);
      });
    }

    // ---- Off-board pre-printed track, always drawn (see design note #10)
    // -- symmetric with the landmark track pass above. No laid-tile loop
    // ever needs to skip over these coordinates the way it does for
    // landmarks: `hexmap::OffboardHexNotBuildable` makes it impossible for
    // `mapGrid.tiles` to ever contain an entry here in the first place.
    for (const hex of STATIC_BOARD_HEXES) {
      const edges = OFFBOARD_TRACKS[hex.label];
      if (!edges) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawOffboardTrack(ctx, center, hexSize, edges);
      });
    }

    // ---- Pre-printed gray hex track + city/town markers, always drawn
    // (see design note #12) -- symmetric with the landmark/off-board track
    // passes above.
    for (const hex of STATIC_BOARD_HEXES) {
      const grayTrack = GRAY_HEXES[hex.label];
      if (!grayTrack) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        drawPrintedTrack(ctx, center, hexSize, grayTrack.edges, grayTrack.marker, grayTrack.bypass);
      });
    }

    // ---- Pre-printed yellow "OO" double-city hexes, always drawn (see
    // design note #12) -- two independent station circles, no connecting
    // track (the real board prints none there either).
    for (const hex of STATIC_BOARD_HEXES) {
      if (!YELLOW_OO_HEXES.has(hex.label)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawOOCityMarkers(ctx, center, hexSize);
      });
    }

    // ---- Item 1/8 (structural calibration pass): ordinary white Town/
    // Double-Town-DESIGNATED hexes get their dark dit marker(s) drawn even
    // though they carry no printed track of their own (see
    // `BoardHex.townDesignation`'s doc comment) -- a single dark dit for a
    // Single-Town designation, two side-by-side dark dits (mirroring
    // `drawOOCityMarkers`'s two-station layout) for a Double-Town
    // designation, so a player can see at a glance which blank hexes are
    // reserved for a Town/Double-Town tile rather than ordinary track.
    for (const hex of STATIC_BOARD_HEXES) {
      if (!hex.townDesignation) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station/
      // dit markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        if (hex.townDesignation === "double") {
          // Design note #54/#55/#58: Unified Diagonal Node Geometry -- the
          // SAME shared `twoNodePositions` tuple `drawOOCityMarkers` uses
          // for its two station circles, not an independently-tuned
          // side-by-side layout, so every two-node hex on the board reads
          // identically. Index 0/1 map straight onto the two `drawDitMarker`
          // calls, first slot then second, with no re-sorting.
          const [node0, node1] = twoNodePositions(center, hexSize);
          drawDitMarker(ctx, node0, hexSize * 0.85); // index 0: top-right
          drawDitMarker(ctx, node1, hexSize * 0.85); // index 1: bottom-left
        } else {
          drawDitMarker(ctx, center, hexSize);
        }
      });
    }

    // ---- Design note #34/item 2: ordinary white single-CITY-DESIGNATED
    // hexes (Toledo/Providence/Pittsburgh/Columbus/Washington/Lancaster/
    // Ottawa/Barrie) get the same "marker with no printed track" treatment
    // as the Town/Double-Town pass just above, but using the SAME
    // `drawStationCircle` (white fill, dark stroke) every other real city
    // marker in this file uses -- landmarks, `GRAY_HEXES` cities, OO
    // stations, laid `MajorCityHub` tiles -- rather than `drawDitMarker`, so
    // these read as genuine cities rather than minor town stops, matching
    // this item's own explicit "correct white station circles" ask. All
    // eight are single-city hexes on the real board (none of them a
    // double-city pair like `YELLOW_OO_HEXES`), so this is always one
    // centered circle, no offset pair needed.
    for (const hex of STATIC_BOARD_HEXES) {
      if (!hex.cityDesignation) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #55: Strict Hex Boundary Clipping, extended to station
      // markers -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawStationCircle(ctx, center, hexSize);
      });
    }

    // ---- Traced train routes (design note #137 / F-1). ----
    //
    // POSITION IN THE PASS ORDER IS DELIBERATE, and is the whole reason this
    // sits here rather than at the end: AFTER every track pass, so a route
    // reads as running ON the rails rather than under them; BEFORE station
    // tokens, city circles and every badge, so the overlay can never bury the
    // markers a player needs in order to read the board. A route is an
    // annotation over the map, not a replacement for it.
    drawRouteOverlays(ctx, hexSize, routeOverlays);

    // ---- Station Token markers (design note #36, extended by #44) --
    // layered on TOP of every white/gray/OO station circle drawn above. Two
    // passes: (1) a MUTED preprinted marker at each of the 8
    // `STATION_HOME_HEXES` whose matching company hasn't floated yet (or is
    // missing from
    // `publicCompanies` entirely -- e.g. before the host app's first
    // `GetGameState` query resolves), and (2) a REAL, ticker-colored marker
    // at every `station_token_hexes` entry of every company that HAS
    // floated -- which, since the home token is always index 0 there,
    // covers the home marker and any additional paid tokens together.
    {
      const companiesById = new Map<number, StationTokenCompany>();
      for (const company of publicCompanies) {
        companiesById.set(company.company_id, company);
      }

      for (const home of STATION_HOME_HEXES) {
        const company = companiesById.get(home.companyId);
        if (company && company.is_floated) continue; // drawn by the floated pass below instead
        // Station Token Badges (design note #43): a RESERVED (not-yet-
        // floated) marker on a `YELLOW_OO_HEXES` home hex (today, only
        // ERIE/E11) is drawn in neutral hex-margin space below both station
        // circles -- NOT `stationMarkerPoint`'s own left-circle anchor --
        // since real 1830 lets that corporation's President choose EITHER
        // of the two slots on its first Operating Round turn after
        // floating (module doc comment #23 in `hexmap.rs`); anchoring the
        // still-undecided reserved badge onto one specific circle would
        // misleadingly imply that slot is already committed. The ACTUAL
        // token, once floated, still renders via `stationMarkerPoint`
        // below (unchanged) -- the chain only ever records this hex's one
        // `(q, r)`, not which of the two corners was chosen, so the real
        // marker keeps its existing left-circle convention.
        const homeCenter = axialToPixel(home.q, home.r, hexSize);
        // Design note #106 (E11/Dunkirk & Buffalo only): reported the
        // reserved marker's straight-down margin point slightly overlaps
        // the bottom city marker there -- moved to Vertex 2/slot9
        // (Lower-Right), the requested destination, via `hexSlotDirection`
        // at the SAME `0.46 * hexSize` magnitude as the original
        // straight-down point (direction changed, distance from center
        // unchanged, per the user's own separate observation that these
        // offset magnitudes may already be too large -- no reason to make
        // this one any larger while fixing its direction). The other three
        // `YELLOW_OO_HEXES` (Detroit & Windsor/E5, Hamilton & Toronto/D10,
        // H18) were NOT reported and keep the original straight-down point
        // unchanged.
        const erieVertex2 = hexSlotDirection(9);
        const point =
          home.label === "E11"
            ? { x: homeCenter.x + erieVertex2.x * hexSize * 0.46, y: homeCenter.y + erieVertex2.y * hexSize * 0.46 }
            : YELLOW_OO_HEXES.has(home.label)
              ? { x: homeCenter.x, y: homeCenter.y + hexSize * 0.46 }
              : stationMarkerPoint(home.q, home.r, hexSize);
        // Design note #55: Strict Hex Boundary Clipping, extended to
        // station token markers -- previously only track/text calls were
        // wrapped.
        withHexClip(ctx, homeCenter, hexSize, () => {
          drawStationTokenMarker(
            ctx,
            point,
            hexSize,
            // Corporate Acronym Overlay guarantee (design note #45): prefer
            // a live `company.ticker` when `publicCompanies` has already
            // loaded this company, but fall back to the static
            // `stationTickerLabel` table (never an empty string) so every
            // reserved/unfloated home badge draws its acronym
            // unconditionally, regardless of query timing -- see that
            // table's own doc comment.
            company?.ticker || stationTickerLabel(home.companyId),
            stationTickerColor(home.companyId),
            true,
          );
        });
      }

      // ---- Design note #134: PER-SLOT token placement. ----
      //
      // A 2-slot city draws a pill with one ring per slot, so a token has to
      // land ON a ring rather than at the pill's centre -- two tokens at the
      // centre of one pill stack on top of each other and hide a real,
      // decision-relevant fact (whether that city still has room).
      //
      // The chain records WHICH CITY a token is in (`station_tokens`,
      // backend Audit G-12) but not which SLOT, because a slot has no
      // meaning in the rules -- capacity is a count, and two tokens in one
      // city are interchangeable. So slot order is chosen here, by ascending
      // `company_id`. That is deterministic and identical on every client
      // and every re-render, which is the property that actually matters; it
      // just isn't authoritative about which physical circle a company
      // "owns", and nothing downstream should read it as though it were.
      const occupantsByCity = new Map<string, StationTokenCompany[]>();
      for (const company of publicCompanies) {
        if (!company.is_floated) continue;
        for (const [q, r] of company.station_token_hexes) {
          const city = tokenCityIndex(company, q, r) ?? 0;
          const key = `${q},${r},${city}`;
          const bucket = occupantsByCity.get(key);
          if (bucket) bucket.push(company);
          else occupantsByCity.set(key, [company]);
        }
      }
      // `forEach`, not `for...of` over `.values()` -- tsconfig targets ES5
      // without `downlevelIteration`, so iterating a Map iterator is a
      // compile error here.
      occupantsByCity.forEach((bucket) => {
        bucket.sort((a, b) => a.company_id - b.company_id);
      });

      for (const company of publicCompanies) {
        if (!company.is_floated) continue;
        for (const [q, r] of company.station_token_hexes) {
          const laidTile = mapGrid.tiles.find((laid) => laid.q === q && laid.r === r);
          const chainCity = tokenCityIndex(company, q, r);
          const tokenCenter = axialToPixel(q, r, hexSize);

          let point: { x: number; y: number } | undefined;
          if (laidTile && chainCity !== undefined) {
            const slotPoints = tileCitySlotPoints(
              laidTile.tile_id,
              chainCity,
              laidTile.orientation,
              tokenCenter,
              hexSize,
            );
            const bucket = occupantsByCity.get(`${q},${r},${chainCity}`) ?? [];
            const slot = bucket.findIndex((entry) => entry.company_id === company.company_id);
            // A bucket longer than the city has slots means the chain and
            // this mirror disagree about capacity (see
            // `tileCitySlotCounts`' own note). Clamping to the last real
            // slot keeps the token visible and stacked rather than
            // vanishing, which is the more debuggable failure.
            point = slotPoints[Math.min(Math.max(slot, 0), slotPoints.length - 1)];
          }

          // Fallback: a pre-G-12 chain, an unknown tile, or an untiled
          // preprinted city -- all cases where there is no per-slot answer
          // to be had, so the legacy per-hex anchor is the honest one.
          const resolved = point ?? stationMarkerPoint(q, r, hexSize, laidTile);
          withHexClip(ctx, tokenCenter, hexSize, () => {
            drawStationTokenMarker(ctx, resolved, hexSize, company.ticker, stationTickerColor(company.company_id), false);
          });
        }
      }
    }

    // ---- Landmark labels, always on top. Font size responsively shrinks
    // (see design note #3b / `fitFontSize`) so the name never overflows
    // the hex's own flat-to-flat width or collides with the track above.
    // Item 3 (Three-Tier Local Deflection Stack): drawn in the hex's UPPER
    // third (negative offset), clear of the station circle locked at
    // absolute center and the terrain-cost slot in the lower third. Item 7
    // (Muted Base Text with Hover Glow): styling/hover-pop now handled by
    // `drawHexNameLabel`, shared with the gray/OO name pass below.
    // Universal Canvas Layout Engine (design note #55): a landmark's
    // nameplate anchor/format is now derived from its ARCHETYPE
    // (`archetypeForHex`), not a name check -- Boston/Baltimore
    // (SingleCity) get the shared Archetype A upper-left wedge anchor
    // (`singleNodeNameplateAnchor`), while New York (DoubleCity, per its
    // own real "two disconnected stations" `LANDMARK_TRACKS` shape) gets
    // the shared Archetype B dead-center anchor, splitting into the same
    // compact 2-line "A & B" stacked format the OO pass below uses whenever
    // a name actually contains " & " (dropping the ampersand) -- New York's
    // own name has no ampersand, so it renders as a single centered line,
    // but the ANCHOR POINT and formatting RULE are identical to every other
    // DoubleCity hex, not a special case of its own.
    for (const landmark of LANDMARK_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle -- station tokens/badges/tracks are all drawn by separate
      // passes above and are unaffected by this skip.
      if (!showCityNames) continue;
      // Dynamic City Nameplate Suppression (design note #47): once a real
      // tile is laid here, physical-board parity says its preprinted name
      // is covered -- see `hexHasLaidTile`'s own doc comment. The name
      // stays 100% available on hover (`describeHex`, extended this same
      // pass to cover every `NAMED_HEX_LABELS` city too, not just
      // landmarks/off-board zones).
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === landmark.q && hoveredHexCoord.r === landmark.r,
      );
      const archetype = archetypeForHex(mapGrid, landmark.q, landmark.r);
      // Design note #78: the nameplate shows `displayName` when the landmark
      // has one (New York -> "New York & Newark"), falling back to the real
      // structural `name` otherwise -- see that field's own doc comment.
      const displayName = landmark.displayName ?? landmark.name;
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- `withHexClip` (design note #42) previously only wrapped
      // track-drawing calls; a nameplate positioned close to a hex's own
      // edge could still bleed its text into the neighboring hex. Now every
      // `drawHexNameLabel` call site is wrapped the same way.
      withHexClip(ctx, center, hexSize, () => {
        if (archetype === "DoubleCity") {
          const parts = displayName.split(" & ");
          if (parts.length === 2) {
            const lineMaxWidth = hexFlatWidth * 0.85;
            drawStackedNameLabel(ctx, [parts[0], parts[1]], center, lineMaxWidth, isHovered);
          } else {
            drawHexNameLabel(ctx, displayName, center, hexFlatWidth * 0.85, isHovered);
          }
        } else {
          const anchor = singleNodeNameplateAnchor(
            center,
            hexSize,
            mapGrid,
            landmark.q,
            landmark.r,
            claimedHexSlots,
          );
          drawSingleNodeNameplate(ctx, displayName, anchor, hexFlatWidth * 0.92, isHovered);
        }
      });
    }

    // ---- Pre-printed gray hex name labels (design note #12), also always
    // on top. Item 3 (Three-Tier Local Deflection Stack): UPPER third, same
    // as the landmark pass above. Item 7: styling/hover-pop via
    // `drawHexNameLabel`. Item 4 (Split Dual-City Labels): the four
    // `YELLOW_OO_HEXES` are deliberately EXCLUDED here -- a single centered
    // string through a hex with two independent stations is exactly what
    // item 4 asks to stop doing -- and get their own split-label pass right
    // below instead.
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name) continue;
      if (YELLOW_OO_HEXES.has(hex.label)) continue;
      // Design note #41 (Stacked Dual-Name Labels): the three double-town
      // hexes get their own split+stacked pass below, same as the OO
      // double-city hexes just below that -- skip the single-centered-
      // string treatment here for them.
      if (hex.townDesignation === "double") continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above -- identical skip, applied here for every
      // remaining `NAMED_HEX_LABELS` city (Washington, Toledo, Providence,
      // Albany, Cleveland, Altoona, and the rest).
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      // Design note #55: Universal Canvas Layout Engine -- every hex this
      // pass ever reaches (a real GRAY single-city hex, an ordinary white
      // `cityDesignation` hex, or a real GRAY single-town hex) resolves to
      // the SingleCity or SingleTown archetype, both of which share the
      // Archetype A upper-left wedge anchor (`singleNodeNameplateAnchor`) --
      // REPLACING the previous upper-CENTER anchor. Design note #70: now
      // dynamically slot-aware, see that function's own doc comment.
      const anchor = singleNodeNameplateAnchor(center, hexSize, mapGrid, hex.q, hex.r, claimedHexSlots);
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawSingleNodeNameplate(ctx, name, anchor, hexFlatWidth * 0.92, isHovered);
      });
    }

    // ---- Item 4 (Split Dual-City Labels), STACKED (design note #41), REPOSITIONED
    // to dead-center by design note #49: the four preprinted yellow "OO"
    // double-city hexes (Detroit & Windsor, Hamilton & Toronto, Dunkirk &
    // Buffalo, Philadelphia & Trenton) get TWO independent name labels
    // instead of one string through the center -- one line directly above
    // the other. Design note #49 moved this pass from the upper-third band
    // (shared with every other name label, `center.y - hexSize * 0.58`) to
    // TRUE HEX CENTER, per the OO Double-City Layout & Geometry Refactor's
    // explicit request: with the two station circles now on a top-right/
    // bottom-left diagonal (`ooCityMarkerOffset`, was left/right), the open
    // space actually available for a nameplate is the center of the hex,
    // between the two circles, not the upper third (which the top-right
    // circle now partly occupies). Reported for the original side-by-side
    // layout: each half squeezed into less than half the hex's own width
    // (`hexFlatWidth * 0.42`), which a longer name like "Philadelphia" or
    // "Hamilton" overflowed and visibly collided with -- unreadable.
    // Stacking instead gives each line the hex's (nearly) full width to
    // itself. Each half still independently uses `drawHexNameLabel` (item
    // 7's muted/hover-glow styling), and each half's own hover state is
    // judged by the SAME shared hex coordinate -- the two stations aren't
    // separately hoverable, only the hex as a whole is.
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name || !YELLOW_OO_HEXES.has(hex.label)) continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above -- UNCHANGED by design note #49, which only
      // repositions where this nameplate sits, not whether it persists.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const [primaryName, secondaryName] = name.split(" & ");
      if (!primaryName || !secondaryName) continue; // defensive -- every real OO name is "A & B"
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      const lineMaxWidth = hexFlatWidth * 0.85;
      // Design note #84: line spacing (`NAMEPLATE_LINE_HEIGHT_PX / 2`) is
      // now derived inside `drawStackedNameLabel` itself, from the SAME
      // constant design note #51 tuned here -- no longer computed at this
      // call site.
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // ---- Stacked Dual-Name Labels (design note #41), part 2: the three
    // double-town hexes -- Akron & Canton (G7), Reading & Allentown (G17),
    // New Haven & Hartford (F20) -- each name TWO independent town stops
    // sharing one hex, exactly the same "A & B" shape as the four OO
    // double-city hexes above, but previously still rendered as a single
    // un-split "A & B" string via the generic single-name pass above
    // (before this pass excluded `townDesignation === "double"` from it).
    // Split and stacked the identical way the OO pass just above is, for
    // the same readability reason.
    for (const hex of STATIC_BOARD_HEXES) {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle.
      if (!showCityNames) continue;
      if (hex.townDesignation !== "double") continue;
      const name = NAMED_HEX_LABELS[hex.label];
      if (!name) continue;
      // Dynamic City Nameplate Suppression (design note #47): see the
      // landmark pass above.
      if (hexHasLaidTile(mapGrid, hex.q, hex.r)) continue;
      const [primaryName, secondaryName] = name.split(" & ");
      if (!primaryName || !secondaryName) continue; // defensive -- every real double-town name is "A & B"
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      const lineMaxWidth = hexFlatWidth * 0.85;
      // Design note #84: line spacing now derived inside
      // `drawStackedNameLabel` itself -- no longer computed at this call
      // site (was design note #51's same font-size-relative spacing the
      // OO pass above also used).
      // Design note #54: Compact Stacked Nameplate Centering -- moved from
      // the upper-third band (`center.y - hexSize * 0.58 +/- lineOffset`,
      // shared with every single-name label) to TRUE HEX CENTER, mirroring
      // design note #49's identical repositioning for the OO pass just
      // above. Now that the two dit markers sit on the same diagonal
      // top-right/bottom-left layout OO uses (this same design note), true
      // center is the open channel between them, not the upper third (which
      // the top-right marker now partly occupies) -- so this pass no longer
      // needs its own separate "no station circles to clear" carve-out.
      // Design note #53: Hex Boundary Clipping Mask, extended to nameplate
      // text -- see the landmark pass above for the full reasoning.
      withHexClip(ctx, center, hexSize, () => {
        drawStackedNameLabel(ctx, [primaryName, secondaryName], center, lineMaxWidth, isHovered);
      });
    }

    // ---- Red off-board revenue zone labels ("Chicago", "Gulf", etc.) plus
    // ONLY the currently active era's value, now as a circular color-coded
    // badge rather than a second text plate (design note #22) -- see design
    // note #6 / OFFBOARD_LABELS. Same responsive font-fit treatment as the
    // landmark labels above. The name plate sits above center (pushed up
    // slightly further than before -- design note #22's "explicit offset
    // padding" ask) and the value badge sits below, so both stay clear of
    // the pre-printed track stubs (design note #10) converging toward
    // center. The FULL Yellow/Green/Brown progression is still available --
    // via the floating hover tooltip card drawn later in this function, see
    // design note #15/item 4.
    //
    // Factored into a small closure (design note #26/item 3) so the SAME
    // nameplate-plus-badge drawing can be pointed at an arbitrary center --
    // needed below to draw Gulf's single merged nameplate at the I1/J2
    // midpoint instead of twice, once per hex, like every other zone here.
    //
    // Design note #78: name line(s) and revenue badge are now computed and
    // laid out as ONE combined block, anchored so the BLOCK's own vertical
    // center (not each piece independently) lands on `center` -- REPLACING
    // the previous two fixed hex-relative offsets (name pinned `hexSize *
    // 0.42` above center, badge pinned `hexSize * 0.44` below, regardless of
    // whether the name was one line or two). The badge sits a small
    // proportional gap directly beneath the name block. Also picks up the
    // shared white translucent shield (`NAMEPLATE_SHIELD_FILL`/`_HOVERED`)
    // and the standardized regular-weight `NAMEPLATE_FONT_SIZE_PX`/`_MIN_PX`
    // scale, same as every other nameplate on the board.
    const drawOffboardNameplate = (
      center: { x: number; y: number },
      offboardName: string,
      isHovered: boolean,
    ) => {
      // Rail Map Overhaul (design note #42): City Nameplate Visibility
      // Toggle gates ONLY the name text -- the value badge below is drawn
      // unconditionally, per that item's explicit "maintaining ... revenue
      // badges" requirement (so a hidden-name hex still shows a
      // badge-only block, centered on the hex).
      //
      // Design note #83: wraps onto two stacked lines ONLY for "Maritime
      // Provinces" -- the one explicitly named exception, too long to fit
      // its single hex on one line despite naming only one place -- via
      // `offboardNameplateLines` below. Every other off-board zone name
      // ("Chicago", "Gulf", "Canadian West", "Deep South") now stays a
      // single line, REVERSING #47's old "every multi-word name wraps"
      // rule: per explicit request, wrapping is reserved for names that
      // either denote two separate cities (an ampersand -- none of this
      // file's off-board zones have one) or are this one named exception.
      const nameLines: readonly string[] = showCityNames ? offboardNameplateLines(offboardName) : [];
      const nameBlockHeight = nameLines.length * NAMEPLATE_LINE_HEIGHT_PX;

      const tiers = OFFBOARD_REVENUE[offboardName];
      // Design note #66: `$` prefix DROPPED, same reasoning as
      // `drawValueBadge`'s own comment.
      const activeValue = tiers ? `${offboardValueForEra(tiers, currentEra)}` : "";
      // Design note #63/#64/#65/#66: Text-Driven Badge Sizing -- see
      // `drawValueBadge`'s own comment for the shared font/padding/floor
      // reasoning behind this exact formula. Badge text stays BOLD --
      // design note #78 scopes the regular-weight typography change to
      // nameplate TEXT, not revenue/terrain-cost badge figures.
      const offboardFontSizePx = Math.max(9, hexSize * 0.24) - 1;
      let badgeRadius = 0;
      if (tiers) {
        ctx.font = `bold ${offboardFontSizePx}px ${FONT_FAMILY_STACK}`;
        badgeRadius = badgeRadiusForLabel(ctx.measureText(activeValue), offboardFontSizePx, "square", 2, 1.5, 5);
      }
      const badgeDiameter = badgeRadius * 2;
      // Small proportional gap between the badge's own bottom and the name
      // block's own top (design note #85 flipped which sits on top) --
      // only when BOTH are actually present, so a name-only (era has no
      // revenue -- doesn't happen today, but kept correct) or badge-only
      // (`showCityNames` off) block doesn't carry a stray empty gap.
      const gap = nameLines.length > 0 && tiers ? hexSize * 0.08 : 0;
      const totalHeight = nameBlockHeight + gap + badgeDiameter;
      const blockTop = center.y - totalHeight / 2;
      // Design note #85: order flipped -- badge now occupies the TOP of the
      // combined block, name text sits directly beneath it (was the
      // reverse). `nameBlockStart` (below) marks where the name text's own
      // band begins, after the badge and the gap.
      const nameBlockStart = blockTop + badgeDiameter + gap;

      if (tiers) {
        // Centered at the TOP of the combined block.
        const badgeCenter = { x: center.x, y: blockTop + badgeRadius };

        // Design note #62: solid white square badge, dark-navy stroke --
        // off-board revenue is grouped with city hub revenue under this
        // pass's "Squares = City/Off-Board Revenue" rule.
        drawBadgeShape(ctx, badgeCenter, badgeRadius, "square");

        // Bold black text -- no halo needed on a white fill.
        ctx.fillStyle = "#000000";
        ctx.font = `bold ${offboardFontSizePx}px ${FONT_FAMILY_STACK}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(activeValue, badgeCenter.x, badgeCenter.y);
      }

      // Design note #84: a 2-line name (only "Maritime Provinces", per #83)
      // draws through `drawStackedNameLabel` for its ONE shared background
      // shield, instead of each line painting its own box independently
      // (the overlap-darkening seam that fixed). A 1-line name (every other
      // off-board zone, now, per #83) draws through the ordinary
      // `drawHexNameLabel`, same as every on-board single-line nameplate.
      // Design note #85: now positioned at `nameBlockStart` (beneath the
      // badge), not at `blockTop` (was the top of the block).
      if (nameLines.length === 2) {
        const linesCenterY = nameBlockStart + NAMEPLATE_LINE_HEIGHT_PX;
        drawStackedNameLabel(ctx, [nameLines[0], nameLines[1]], { x: center.x, y: linesCenterY }, hexFlatWidth * 0.92, isHovered);
      } else if (nameLines.length === 1) {
        const lineCenterY = nameBlockStart + NAMEPLATE_LINE_HEIGHT_PX * 0.5;
        drawHexNameLabel(ctx, nameLines[0], { x: center.x, y: lineCenterY }, hexFlatWidth * 0.92, isHovered);
      }
    };

    for (const hex of STATIC_BOARD_HEXES) {
      const offboardName = OFFBOARD_LABELS[hex.label];
      if (!offboardName) continue;
      // Design note #26/item 3 / item 9: I1/J2 (Gulf) and A9/A11 (Canadian
      // West) are each drawn with ONE shared nameplate below instead of one
      // each here.
      if (GULF_HIDDEN_EDGE[hex.label] !== undefined) continue;
      if (CANADIAN_WEST_HIDDEN_EDGE[hex.label] !== undefined) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      const isHovered = Boolean(
        hoveredHexCoord && hoveredHexCoord.q === hex.q && hoveredHexCoord.r === hex.r,
      );
      // Design note #55: Strict Hex Boundary Clipping, extended to
      // off-board nameplates -- previously unclipped.
      withHexClip(ctx, center, hexSize, () => {
        drawOffboardNameplate(center, offboardName, isHovered);
      });
    }

    // ---- Gulf's and Canadian West's single merged nameplates (design note
    // #26/item 3, generalized by item 9) -- drawn once, at the midpoint
    // between each zone's two hex centers, instead of the per-hex loop
    // above's usual one-nameplate-per-hex treatment. Matches the merged
    // single-region border stroke drawn in the static board background pass
    // above. Deliberately NOT wrapped in a single-hex `withHexClip` (design
    // note #55's otherwise-universal clipping requirement) -- the midpoint
    // sits ON the shared border between the two real hexes this nameplate
    // spans, by design (the same "merged region" treatment
    // `GULF_HIDDEN_EDGE`/`CANADIAN_WEST_HIDDEN_EDGE` gives their shared
    // border stroke above); clipping to either ONE hex's boundary alone
    // would incorrectly slice the text in half instead of protecting it.
    for (const [labelA, labelB, name] of [
      ["I1", "J2", "Gulf"],
      ["A9", "A11", "Canadian West"],
    ] as const) {
      const hexA = STATIC_BOARD_HEXES.find((h) => h.label === labelA);
      const hexB = STATIC_BOARD_HEXES.find((h) => h.label === labelB);
      if (hexA && hexB) {
        const centerA = axialToPixel(hexA.q, hexA.r, hexSize);
        const centerB = axialToPixel(hexB.q, hexB.r, hexSize);
        const mergedCenter = { x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 };
        const isHovered = Boolean(
          hoveredHexCoord &&
            ((hoveredHexCoord.q === hexA.q && hoveredHexCoord.r === hexA.r) ||
              (hoveredHexCoord.q === hexB.q && hoveredHexCoord.r === hexB.r)),
        );
        drawOffboardNameplate(mergedCenter, name, isHovered);
      }
    }

    // ---- Terrain build-cost labels (design note #9, RELOCATED here by
    // design note #55's Strict Canvas Layering Hierarchy -- Layer 4/text
    // content, drawn after every Layer 1-3 pass rather than immediately
    // after the Layer 1 terrain icon that used to sit right next to it).
    // RECOLORED by design note #68: solid red box + white text (was the
    // same tier-colored shield box every other text element on the board
    // uses, `nameplateBoxFillFor`) -- reported: terrain costs needed to
    // read as visually distinct from revenue badges (#62-#66's white
    // squares), and a red box unambiguously reads as "cost," not
    // "revenue." Tight 2px padding/radius unchanged.
    for (const hex of STATIC_BOARD_HEXES) {
      if (hex.type !== "Mountain" && hex.type !== "River") continue;
      const terrainType = hex.type;
      // Design note #136 (F-2): the printed figure comes from the
      // coordinate-keyed mirror of `hexmap::terrain_build_fee`, so the label
      // on the board and the fee the contract charges are the same lookup.
      const terrainFee = terrainBuildFeeAt(hex.q, hex.r);
      if (terrainFee <= 0) continue;
      const costLabel = String(terrainFee);
      const center = axialToPixel(hex.q, hex.r, hexSize);
      // Design note #87: GENERALIZED past the old DoubleCity-only
      // `isDoubleCityHex` check -- see the terrain-icon pass above's own
      // comment for why (SingleCity `cityDesignation` River hexes like
      // Toledo/Providence/Washington, D.C. needed the same treatment and
      // weren't getting it). This is the SAME `isComplexHex` test that
      // pass uses, so the two always agree on which hexes are complex.
      const isComplexHex =
        archetypeForHex(mapGrid, hex.q, hex.r) !== "Plain" ||
        liveEdgesForHex(mapGrid, hex.q, hex.r).length > 0;
      // Design note #70 (13-Slot Perimeter Anchor System): Item 3's old
      // fixed "lower third" / "bottom-right quadrant" literals are now
      // resolved through the shared slot engine per Requirement 4 ("Tile
      // IDs... anchor along open outer edge faces such as the bottom
      // vertex or lower edge margins, clear of track entry points") --
      // terrain cost labels are the closest existing on-board element to
      // that description (see this task's closing summary for why no
      // actual tile-ID number is rendered on the board today), so they're
      // the one refactored against it. Default (simple hex) prefers the
      // true BOTTOM POINT (slot 10, straight down -- byte-identical
      // direction to the old fixed `{x: center.x, y: center.y +
      // hexSize*0.58}`, so the overwhelmingly common unblocked case looks
      // unchanged), then the two lower edges (4/SW, 3/SE), then the two
      // lower corners as a last resort. Any complex hex keeps its own
      // distinct bottom-RIGHT preference by starting at the SE edge (slot
      // 3) instead of the bottom point.
      // Design note #87: this is now the ONLY slot claim for a complex
      // hex's terrain icon+cost -- REPLACES the old two-claim split (one
      // here, a separate one in the icon pass above) with a SINGLE
      // `claimHexSlot` call for the whole compound badge. A simple hex's
      // claim is unchanged from before.
      const blockedCostSlots = hexBlockedSlots(mapGrid, hex.q, hex.r);
      const deadCostSlots = slotsBlockedByEdges(deadEdgesAt(hex.q, hex.r), false);
      const costOverride = resolveSlotOverride(hex.q, hex.r, "terrain");
      const costSlotPreference = withSlotReserve(
        hex.q,
        hex.r,
        "terrain",
        isComplexHex ? COMPLEX_HEX_TERRAIN_SLOT_PREFERENCE : [10, 4, 3, 11, 9],
      );
      const costSlot = claimHexSlotPreferring(
        claimedHexSlots,
        hex.q,
        hex.r,
        costOverride,
        costSlotPreference,
        blockedCostSlots,
        deadCostSlots,
      );
      const costDirection = hexSlotDirection(costSlot);
      const point = {
        x: center.x + costDirection.x * hexSize * 0.58,
        y: center.y + costDirection.y * hexSize * 0.58,
      };
      // Design note #122: the compound [icon+cost] badge's own anchor,
      // offset at `0.65` instead of the plain cost box's `0.58` above --
      // matches `drawValueBadge`'s own `REVENUE_BADGE_OFFSET` (design note
      // #109) exactly, per direct request to give the (recently shrunk,
      // design note #121) compound badge the same offset treatment the
      // revenue badge already has. Scoped to ONLY the compound badge --
      // `point` above (the plain-hex cost box's own anchor) is untouched,
      // same "only the compound badge" scope #121's own shrink used.
      const COMPOUND_BADGE_OFFSET = 0.65;
      const compoundBadgePoint = {
        x: center.x + costDirection.x * hexSize * COMPOUND_BADGE_OFFSET,
        y: center.y + costDirection.y * hexSize * COMPOUND_BADGE_OFFSET,
      };
      withHexClip(ctx, center, hexSize, () => {
        if (isComplexHex) {
          // Design note #87: ONE compound [icon+cost] pill, REPLACING the
          // plain cost-only box below for every complex hex -- the
          // standalone icon pass above already skipped drawing anything
          // for this hex, so this is the ONLY place its terrain icon
          // renders at all.
          drawTerrainCompoundBadge(ctx, terrainType, costLabel, compoundBadgePoint, hexFlatWidth * 0.85);
          return;
        }
        // Design note #68: font dropped 1pt (base `9` instead of `10`) as
        // part of the same terrain-cost-vs-revenue-badge distinction pass.
        // Design note #92: dropped another 1pt (base `8`) on top of #91's
        // tightened box padding (kept, not reverted) -- per direct request,
        // both changes now apply together.
        // Design note #95: raised back 1pt (base `9`) now that the `$`
        // prefix is gone (#94) -- freed-up horizontal room lets the number
        // read at its original size again.
        // Design note #99: raised another 1pt (base `10`), per direct
        // request.
        ctx.font = fitFontSize(ctx, costLabel, 10, hexFlatWidth * 0.85, 6, "bold");
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Design note #68: white text on the new solid-red box, replacing
        // the old black-on-tier-color styling.
        ctx.fillStyle = "#FFFFFF";
        // Design note #91 REVERTED (design note #97): padding tried
        // tightened 2->1 on both axes, but per direct follow-up request
        // the box is reverted back to its original 2/2 padding.
        drawLabelWithBackground(ctx, costLabel, point, {
          paddingX: 2,
          paddingY: 2,
          // Design note #68: literal solid red, this file's own established
          // "crisp" red (`drawImpassableBorderEdge`'s `#E53E3E`, design note
          // #42) -- reused here rather than inventing a new red, so the
          // board's palette stays consistent.
          fillStyle: "#E53E3E",
          cornerRadiusPx: 2,
        });
      });
    }

    // ---- City/town route-value badges (design note #26/item 5) -- a
    // small, color-coded $-value plate next to every printed destination
    // city/town circle: the three landmark cities, every pre-printed gray
    // hex city/town marker, every yellow "OO" hex, and any laid
    // SmallTown/MajorCityHub tile. FACTUAL NOTE (see design note #26): the
    // request that asked for this called the value "phase-dependent...
    // based on the current game phase tier," but `terrainBaseValue` (this
    // file's mirror of the actual `hexmap::terrain_base_value` rule
    // `RunManualRoute`'s payout math uses) is flat and terrain-only -- a
    // hex's value never changes as the game advances through color tiers.
    // The two example numbers that request gave ($10 towns / $20 base
    // cities) DO match this flat table, so they're used here verbatim; a
    // second, era-varying value for the same hex was NOT implemented,
    // since the backend has no such rule to mirror (unlike the off-board
    // zones' badges above, which genuinely are era-tiered).
    // Design note #35/items 2-3: a hex listed in `HEX_START_VALUE_OVERRIDE`
    // uses its real sourced $ figure instead of the flat terrain default --
    // and if that real figure is exactly `$0` (the four `YELLOW_OO_HEXES`,
    // and all eight `cityDesignation` hexes), the badge is skipped
    // entirely rather than drawn showing "$0", per this item's own "fully
    // hiding or removing" instruction. `undefined` (a hex absent from the
    // override table entirely) falls through to `drawValueBadge`'s own
    // unchanged flat-by-terrain default.
    for (const landmark of LANDMARK_HEXES) {
      // Design note #133: same yield as the track pass above, and for the
      // same reason one step further on -- `HEX_START_VALUE_OVERRIDE` is
      // this hex's PRINTED starting value. Once a tile is laid, the tile's
      // own chain revenue is the figure that pays (a laid #62 pays $90, not
      // New York's printed starting value), and the laid-tile badge loop
      // below now prints it.
      if (hexHasLaidTile(mapGrid, landmark.q, landmark.r)) continue;
      const override = HEX_START_VALUE_OVERRIDE[landmark.label];
      if (override === 0) continue;
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      // ADAPTIVE PLACEMENT (see `drawValueBadge`'s own doc comment): this
      // landmark's own real printed track edges, flattened out of
      // `LANDMARK_TRACKS`'s per-segment shape -- exactly the data that lets
      // New York's badge dodge its NE stub (edge 1) instead of sitting on
      // top of it, which is the G19 collision this pass was reported for.
      const landmarkEdges = (LANDMARK_TRACKS[landmark.name] ?? []).flatMap((segment) => segment.edges);
      // Design note #55: Strict Hex Boundary Clipping, extended to value
      // badges -- previously only track/text calls were wrapped.
      withHexClip(ctx, center, hexSize, () => {
        drawValueBadge(
          ctx,
          center,
          landmark.q,
          landmark.r,
          "MajorCityHub",
          hexSize,
          override,
          landmarkEdges,
          claimedHexSlots,
        );
      });
    }
    for (const hex of STATIC_BOARD_HEXES) {
      const override = HEX_START_VALUE_OVERRIDE[hex.label];
      const grayTrack = GRAY_HEXES[hex.label];
      if (grayTrack && grayTrack.marker !== "none") {
        if (override !== 0) {
          const center = axialToPixel(hex.q, hex.r, hexSize);
          withHexClip(ctx, center, hexSize, () => {
            drawValueBadge(
              ctx,
              center,
              hex.q,
              hex.r,
              grayTrack.marker === "city" ? "MajorCityHub" : "SmallTown",
              hexSize,
              override,
              grayTrack.edges,
              claimedHexSlots,
            );
          });
        }
        continue;
      }
      if (YELLOW_OO_HEXES.has(hex.label)) {
        if (override !== 0) {
          const center = axialToPixel(hex.q, hex.r, hexSize);
          withHexClip(ctx, center, hexSize, () => {
            drawValueBadge(ctx, center, hex.q, hex.r, "MajorCityHub", hexSize, override, [], claimedHexSlots);
          });
        }
      }
      // REVERTED (this pass, "Only Real-Track Towns Show Revenue" --
      // reported: every blank Town/Double-Town-designated hex shows a
      // revenue badge, when only the three hexes with REAL pre-printed
      // track -- Kingston C15, Atlantic City I19, Fall River F24, the
      // `GRAY_HEXES`/`grayTrack.marker !== "none"` branch above -- should).
      // The item 1 fix this reverts gave every blank `townDesignation` hex
      // (London E7, Burlington B20, Flint D4, Erie F10, Akron & Canton G7,
      // Reading & Allentown G17, New Haven & Hartford F20 -- see
      // `TOWN_DESIGNATED_HEXES`'s own doc comment in `hexmap.rs` for the
      // full sourcing) the same flat SmallTown/DoubleTown badge as a REAL
      // printed town, even though these seven have no printed track at all
      // -- a bare town PLACEHOLDER, not a scored destination, until a
      // player actually lays a real tile there. `hexRouteValue`'s own
      // matching fallback (used by the hover tooltip) is fixed the same way
      // just below. The backend (`pathfinding::effective_tile_and_value`)
      // was independently verified to already treat these seven correctly
      // -- `gray_preprinted_name_at` only ever matches the twelve REAL gray
      // hexes (the six cities, C15/I19/F24, and the three bare connectors),
      // never these seven blank placeholders, so a route can't pass through
      // or score value at one of them until a real tile is laid; this was a
      // frontend-only display bug, nothing to change on-chain.
      // Design note #34/item 2, values corrected by design note #35/item 3:
      // the blank single-CITY-designated hexes' real printed value is $0
      // (bare `city`/`city=revenue:0` source entries, no track), so their
      // badge is skipped entirely -- `override` is always exactly `0` for
      // every one of these eight hexes (see `HEX_START_VALUE_OVERRIDE`).
      if (hex.cityDesignation && override !== 0) {
        const center = axialToPixel(hex.q, hex.r, hexSize);
        withHexClip(ctx, center, hexSize, () => {
          drawValueBadge(ctx, center, hex.q, hex.r, "MajorCityHub", hexSize, override, [], claimedHexSlots);
        });
      }
    }
    for (const tile of mapGrid.tiles) {
      const catalogEntry = TILE_CATALOG_BY_ID.get(tile.tile_id);
      if (!catalogEntry) continue;
      if (
        catalogEntry.terrain !== "SmallTown" &&
        catalogEntry.terrain !== "DoubleTown" &&
        catalogEntry.terrain !== "MajorCityHub" &&
        catalogEntry.terrain !== "DoubleCityHub" // Tile Selection Catalog verification pass, tile 15
      ) {
        continue;
      }
      // design note #49: `BostonHub`/`NewYorkHub` are deliberately NOT
      // added to the allow-list above (even though they're now real
      // `TerrainType` members, closing the gap described in that type's own
      // doc comment) -- both terrains only ever occur at a `LANDMARK_HEXES`
      // hex, which the `landmarkAt` skip just below always catches first,
      // and `drawValueBadge`'s own `terrain` parameter is intentionally
      // typed to the narrower `SmallTown | DoubleTown | MajorCityHub |
      // DoubleCityHub` union it's always accepted -- widening the allow-list
      // above would widen `catalogEntry.terrain`'s narrowed type past what
      // `drawValueBadge` accepts for no functional benefit (this branch is
      // unreachable for a landmark hex either way).
      // Design note #133: no longer skipped for a landmark hex. The
      // landmark badge pass above now yields whenever a tile is laid, so
      // exactly one badge is drawn either way -- the printed value while the
      // hex is bare, the chain's `MapTileEntry.revenue` once it is not.
      const center = axialToPixel(tile.q, tile.r, hexSize);
      // Local `const` so the allow-list narrowing above (`catalogEntry.terrain
      // !== ...`) survives being read inside the `withHexClip` closure below
      // -- TS does not carry property-access narrowing across a function
      // boundary, only a local variable's.
      const terrain = catalogEntry.terrain;
      // ADAPTIVE PLACEMENT (see `drawValueBadge`'s own doc comment): this
      // laid tile's actual live edges at its current orientation -- the
      // same `rotateConnections`/`liveEdges` pair `drawTrackPath` itself
      // uses to draw the real track, so the badge dodges exactly what's
      // actually drawn, not the tile's unrotated base artwork.
      const tileEdges = liveEdges(rotateConnections(catalogEntry.connections, tile.orientation));
      // Design note #132: THE revenue figure, read off `MapTileEntry.revenue`
      // -- `hexmap::tile_base_value`, the same call `pathfinding::HexInfo`
      // and `operations::execute_run_manual_route` price a route through.
      // What is printed here is therefore what the contract will actually
      // pay, by construction. It is no longer computed on the frontend at
      // all; `drawValueBadge`'s existing `valueOverride` parameter is the
      // channel, so nothing about badge placement or styling changes.
      const chainRevenue = chainTileRevenue(tile);
      // `0` is a real chain answer -- plain connector track pays nothing --
      // and a `$0` badge is noise, so suppress it. `undefined` (a pre-G-11
      // contract) keeps the old terrain-bucket fallback by passing through.
      if (chainRevenue === 0) continue;
      withHexClip(ctx, center, hexSize, () => {
        drawValueBadge(ctx, center, tile.q, tile.r, terrain, hexSize, chainRevenue, tileEdges, claimedHexSlots);
      });
    }

    // ---- Canonical Tile Upgrade Restriction badges ("B"/"NY"/"OO", design
    // note #47, REVISED by design note #49, mirroring `hexmap.rs` module
    // doc comment #26/#27): Boston AND Baltimore each get a "B" corner
    // badge (Baltimore added by #49 -- real 1830 prints the "B" label on
    // both hexes, not just Boston, see #27's own Verification Status
    // paragraph), New York gets "NY", and each of the four
    // `YELLOW_OO_HEXES` gets "OO" -- see `drawRestrictionBadge`'s own doc
    // comment for the fixed-corner-and-plain-text styling. Drawn right
    // after the landmark name pass, so it layers on top of the printed
    // track/station circle beneath it but stays visually distinct from the
    // (possibly now-suppressed) name label above center.
    //
    // PERSISTENCE (design note #49, REVERSING #47): #47 gated both loops
    // below on `!hexHasLaidTile`, hiding each badge once its hex was tiled.
    // This request explicitly asks these labels to "remain visible across
    // ALL tile upgrade phases (un-tiled preprinted hexes, yellow tiles,
    // green tiles, and brown tiles)" -- the opposite of #47's own framing
    // ("before tiles are laid"). Both `hexHasLaidTile` checks are removed
    // outright; #47 itself is left in place, unedited, as the historical
    // record of the original (now-superseded) decision, per this file's own
    // convention of never silently deleting a prior pass's reasoning.
    for (const landmark of LANDMARK_HEXES) {
      const center = axialToPixel(landmark.q, landmark.r, hexSize);
      const archetype = archetypeForHex(mapGrid, landmark.q, landmark.r);
      // Badge TEXT content ("B" vs "NY") is genuine per-hex DATA (which
      // letter a real landmark prints), read the same structural way
      // `archetypeForHex` itself classifies the hex -- not a separate name
      // check -- so a DoubleCity landmark always gets "NY" and a
      // SingleCity landmark always gets "B", by construction.
      const badgeText = archetype === "DoubleCity" ? "NY" : "B";
      withHexClip(ctx, center, hexSize, () => {
        drawRestrictionBadge(
          ctx,
          center,
          hexSize,
          badgeText,
          archetype,
          mapGrid,
          landmark.q,
          landmark.r,
          claimedHexSlots,
        );
      });
    }
    for (const hex of STATIC_BOARD_HEXES) {
      if (!YELLOW_OO_HEXES.has(hex.label)) continue;
      const center = axialToPixel(hex.q, hex.r, hexSize);
      withHexClip(ctx, center, hexSize, () => {
        drawRestrictionBadge(ctx, center, hexSize, "OO", "DoubleCity", mapGrid, hex.q, hex.r, claimedHexSlots);
      });
    }

    // ---- Impassable border edges (design note #38): a fixed set of four
    // board crossings (E7/F8, D12/C11, D12/C13, C17/B16) across which track
    // may never be built, marked with a thick red bar. Drawn after every
    // tile/badge pass above so the bar is never hidden underneath a laid
    // tile's own track or fill, but before the live preview ghost tile
    // below, so a player actively previewing a placement there still sees
    // their own tentative track on top.
    for (const border of IMPASSABLE_BORDER_EDGES) {
      const center = axialToPixel(border.q, border.r, hexSize);
      drawImpassableBorderEdge(ctx, center, hexSize, border.edge);
    }

    // ---- Live preview "ghost" tile (design note #7 / item 3), drawn last
    // so it's always visible on top of everything else, but at reduced
    // opacity with a dashed outline so it clearly reads as a not-yet-
    // confirmed preview rather than a real, committed tile.
    if (previewTile) {
      const previewCatalogEntry = TILE_CATALOG_BY_ID.get(previewTile.tileId);
      const previewCenter = axialToPixel(previewTile.q, previewTile.r, hexSize);
      ctx.save();
      ctx.globalAlpha = 0.65;
      drawHexPath(ctx, previewCenter, hexSize);
      ctx.fillStyle = previewCatalogEntry ? ERA_TILE_FILL[previewCatalogEntry.color] : "#dddddd";
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = previewCatalogEntry
        ? COLOR_TIER_STROKE[previewCatalogEntry.color]
        : "#c0392b";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (previewCatalogEntry) {
        // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
        withHexClip(ctx, previewCenter, hexSize, () => {
          // No query paths to pass (design note #119): `previewTile` is a
          // ghost of a tile the player is CONSIDERING, built client-side by
          // `TileSelectionPopup` from a `GetLegalTilePlacements` pairing --
          // it isn't on the board, so no `MapTileEntry` describes it.
          // `pathsForTile` falls back to the catalog mirror, which is why
          // the mirror had to carry `paths` too: a previewed double-town
          // must draw identically to the same tile once it is laid.
          drawTrackPath(ctx, previewCenter, hexSize, previewCatalogEntry, previewTile.orientation);
        });
      }
      ctx.restore();
    }

    // ---- Off-board hover tooltip (design note #15/item 4), drawn LAST so
    // it's always on top of everything else, including the ghost preview
    // tile above.
    if (hoveredOffboardHex) {
      const hex = STATIC_BOARD_HEXES.find(
        (h) => h.q === hoveredOffboardHex.q && h.r === hoveredOffboardHex.r,
      );
      const offboardName = hex ? OFFBOARD_LABELS[hex.label] : undefined;
      const tiers = offboardName ? OFFBOARD_REVENUE[offboardName] : undefined;
      if (hex && offboardName && tiers) {
        const center = axialToPixel(hex.q, hex.r, hexSize);
        // Point the card back toward the board's own interior (see
        // `drawOffboardTooltip`'s "ADAPTIVE QUADRANT" doc comment) rather
        // than always up-right, so zones near the top/right edge (Canadian
        // West, Maritime Provinces) get room to render instead of clipping
        // off the visible canvas.
        const boardCenterX = (boardContentBounds.minX + boardContentBounds.maxX) / 2;
        const boardCenterY = (boardContentBounds.minY + boardContentBounds.maxY) / 2;
        const preferLeft = center.x > boardCenterX;
        const preferBelow = center.y < boardCenterY;
        drawOffboardTooltip(
          ctx,
          center,
          hexSize,
          offboardName,
          tiers,
          currentEra,
          preferLeft,
          preferBelow,
        );
      }
    }

    // ---- Board margin labels (row letters / column numbers), drawn LAST
    // in this world-space pass -- see design note #25. Native canvas text,
    // inside the same `ctx.translate`/`ctx.scale` transform as everything
    // else above, so it automatically pans/zooms/aligns with the board.
    drawBoardMarginLabels(ctx, hexSize);

    ctx.restore();
  }, [
    // `mapGrid`, not `mapGrid.tiles` (react-hooks/exhaustive-deps).
    //
    // The body reads the WHOLE object, not just the array: `hexHasLaidTile`,
    // `archetypeForHex`, `liveEdgesForHex`, `hexBlockedSlots` and
    // `singleNodeNameplateAnchor` all take `mapGrid` itself. Depending only
    // on `.tiles` was a narrower key than the closure actually needs, which
    // is the definition of a stale-closure hazard: any change to `mapGrid`
    // that did not also replace `.tiles` would leave this callback painting
    // from the previous board.
    //
    // It costs nothing to widen. A live `GetMapGrid` response is freshly
    // parsed per poll, so `mapGrid` and `mapGrid.tiles` get new identities
    // together -- the narrow key only ever helped in the one case where a
    // parent reuses the tiles array inside a new wrapper object, which no
    // caller does.
    //
    // WHY THIS WAS INVISIBLE: `App.tsx` currently supplies
    // `useMemo(() => MOCK_MAP_GRID, [])` -- a frozen mock that never changes
    // at all, so neither the stale read nor any extra repaint could be
    // observed. The hazard only becomes real when this is wired to the live
    // poll, which is exactly when it would have been hardest to diagnose.
    //
    // NOTE FOR CALLERS: pass a STABLE `mapGrid` reference (memoised or
    // straight from the polling hook). An object literal built inline in JSX
    // gets a new identity every render and would repaint the canvas on every
    // render of the parent.
    mapGrid,
    hexSize,
    width,
    height,
    view,
    previewTile,
    currentEra,
    hoveredOffboardHex,
    hoveredHexCoord,
    boardContentBounds,
    publicCompanies,
    // Design note #137: a new route trace must repaint the canvas. Omitting
    // this from the dep list is the classic failure here -- the prop updates,
    // React re-renders, and the memoised draw callback never re-runs, so the
    // overlay silently never appears.
    routeOverlays,
    showCityNames,
  ]);

  /** Coalesces pan/zoom-driven redraws to at most one per animation
   *  frame -- see design note #4. */
  const scheduleDraw = useCallback(() => {
    if (rafHandleRef.current !== null) return;
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      draw();
    });
  }, [draw]);

  // Prop-driven redraw (new map data, resize, or hex size change).
  useEffect(() => {
    draw();
  }, [draw]);

  // Cancel any in-flight coalesced redraw on unmount.
  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
      }
    };
  }, []);

  // BUG FIX ("Tab-Switch Shrink" -- reported: returning to the Rail Map tab
  // after visiting another tab renders the board shrunk, fixed only by
  // manually clicking "Fit to Screen"). This used to be a ONE-SHOT auto-fit
  // effect (guarded by `hasAutoFitRef`, empty deps, "must run exactly once")
  // that snapped `view` to `fitView` a single time on mount. That's the bug:
  // `App.tsx` fully unmounts/remounts this component on every Rail Map <->
  // Stock Market tab switch (a plain ternary, not a CSS display toggle), so
  // "on mount" happens on every single return trip, not just first page
  // load -- and on this component's very first render after each such
  // mount, `width` is still seeded with the small `DEFAULT_WIDTH` fallback,
  // because the `ResizeObserver` above hasn't reported its real, larger
  // measurement yet (that callback fires asynchronously, after this
  // synchronous first paint). The one-shot effect fired at that exact
  // moment, captured a `fitView` computed from the too-small fallback
  // width, and then never ran again -- so `view` stayed locked to that
  // stale shrunk fit even after `measuredSize`/`width`/`fitView` corrected
  // themselves moments later once the `ResizeObserver`'s real reading
  // arrived. Clicking "Fit to Screen" happened to fix it only because that
  // handler independently re-reads the CURRENT `fitView` at click time.
  //
  // Fixed by re-running on every `fitView` change instead of once -- this
  // is also just what design note #13's own stated invariant already
  // claims ("with detailedView === false, `view` is always exactly
  // `fitView`"), now actually enforced continuously instead of only at two
  // isolated trigger points (mount, and toggling detailed view off).
  // Gated on `!detailedView` so it never fights a player's own free pan/
  // zoom while inspecting details; `handlePointerMove`/`handleWheel`
  // already independently no-op pan/zoom mutations at that baseline (see
  // design note #13), so this effect is the only writer to `view` while
  // `detailedView` is false, and cannot loop (`fitView` itself doesn't
  // depend on `view`).
  useEffect(() => {
    if (detailedView) return;
    setView(fitView);
  }, [fitView, detailedView]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Always tracked, even at the locked 100% baseline (design note #13)
      // -- `dragStateRef` doubles as the click-vs-drag distance check
      // `handlePointerUp`'s click interceptor (design note #7) relies on,
      // so a genuine click must still register at baseline even though the
      // pan itself is disabled there (see `handlePointerMove` below).
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originPanX: view.panX,
        originPanY: view.panY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [view.panX, view.panY],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Off-board hover tracking (design note #15/item 4) -- runs on EVERY
      // pointer move, independent of drag/`detailedView` state, so the
      // tooltip works even at the locked 100% baseline and even when no
      // button is pressed at all (ordinary hover, not a drag gesture).
      // Reuses the SAME transform-undo math `handlePointerUp`'s click
      // interceptor already uses to convert a raw pointer position into an
      // axial `(q, r)`.
      const rect = event.currentTarget.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const contentX = (cssX - view.panX) / view.zoom;
      const contentY = (cssY - view.panY) / view.zoom;
      const { q: hoverQ, r: hoverR } = pixelToAxial(contentX, contentY, hexSize);
      const hoveredBoardHex = STATIC_BOARD_HEXES.find((h) => h.q === hoverQ && h.r === hoverR);
      const isOffboardHover = !!(hoveredBoardHex && OFFBOARD_LABELS[hoveredBoardHex.label]);

      // Item 7 ("Muted Base Text with Hover Glow") -- tracked unconditionally,
      // unlike `hoveredOffboardHex` just below, since every labeled hex type
      // (landmark, gray/OO, plain) needs to know when it's the one under the
      // pointer, not just off-board zones.
      setHoveredHexCoord((prev) => {
        if (prev && prev.q === hoverQ && prev.r === hoverR) return prev;
        return { q: hoverQ, r: hoverR };
      });

      setHoveredOffboardHex((prev) => {
        if (isOffboardHover) {
          if (prev && prev.q === hoverQ && prev.r === hoverR) return prev;
          return { q: hoverQ, r: hoverR };
        }
        return prev === null ? prev : null;
      });

      // Active coordinate + value hover tooltip (design note #21, enriched
      // by design note #26/item 2) -- `describeHexWithValue` builds on
      // `describeHex` (still used, unchanged, by the click interceptor) so
      // the tooltip's naming still matches this file's one existing
      // hex-naming convention, with a "(Value: $X)" suffix appended. Only
      // shown over a real hex of the authentic board (a landmark or a
      // `STATIC_BOARD_HEXES` entry); the plain charcoal workspace outside
      // the board (design note #18) shows no tooltip at all.
      const hoveredLandmark = LANDMARK_HEXES.find((l) => l.q === hoverQ && l.r === hoverR);
      if (hoveredLandmark || hoveredBoardHex) {
        // Design note #75: flip toward whichever side of the PANEL (this
        // canvas's own `rect`, already computed above for the hex-hit-test)
        // still has room, mirroring `drawOffboardTooltip`'s own adaptive
        // quadrant logic -- `cssX`/`cssY` are the cursor's position relative
        // to the canvas's own top-left corner, so comparing them against
        // half the canvas's own width/height (not `window.innerWidth`/
        // `innerHeight`) keeps this correct even when the canvas doesn't
        // fill the whole browser viewport.
        setHoveredCoordLabel({
          label: describeHexWithValue(hoverQ, hoverR, mapGrid, currentEra, publicCompanies),
          clientX: event.clientX,
          clientY: event.clientY,
          preferLeft: cssX > rect.width / 2,
          preferAbove: cssY > rect.height / 2,
        });
      } else {
        setHoveredCoordLabel((prev) => (prev === null ? prev : null));
      }

      const drag = dragStateRef.current;
      if (!drag) return;
      // Design note #13: pan is only live in detailed view -- at the locked
      // 100% baseline, pointer movement is still tracked above (so
      // `handlePointerUp`'s click-vs-drag distance check, and therefore the
      // click interceptor, keeps working) but never actually updates
      // `view.panX`/`panY`.
      if (!detailedView) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      // Design note #8: rigid boundary clamping on drag displacement --
      // `clampPanToBoard` stops the raw drag-following pan the instant it
      // would pull the board's own edge past the viewport edge, rather
      // than letting the map drift into empty canvas space and relying on
      // the user to notice and drag back.
      setView((prev) => {
        const clamped = clampPanToBoard(
          drag.originPanX + dx,
          drag.originPanY + dy,
          prev.zoom,
          boardContentBounds,
          width,
          height,
        );
        return { ...prev, panX: clamped.panX, panY: clamped.panY };
      });
      scheduleDraw();
    },
    [
      detailedView,
      scheduleDraw,
      boardContentBounds,
      width,
      height,
      view.panX,
      view.panY,
      view.zoom,
      hexSize,
      // Design note #118: added so the tooltip's new real-ticker station
      // list doesn't close over a stale `publicCompanies` array from this
      // callback's first render -- station tokens are placed live during
      // play.
      publicCompanies,
      // Design note #138: `mapGrid` and `currentEra` added. The comment that
      // stood here previously acknowledged both were missing and deferred
      // them as "out of scope"; they are in scope now, and both were real
      // staleness bugs rather than lint noise.
      //
      // All three feed the SAME call -- `describeHexWithValue(hoverQ, hoverR,
      // mapGrid, currentEra, publicCompanies)` -- which builds the hover
      // tooltip, so a stale closure here does not fail loudly. It quietly
      // reports outdated numbers, indefinitely:
      //
      //   - `currentEra` is the worse of the two. It selects which off-board
      //     revenue TIER the tooltip prints, and it advances Yellow -> Green
      //     -> Brown as the game progresses. Frozen at first render, every
      //     off-board hover would show Yellow-era revenue for the entire rest
      //     of the game -- a number the contract stopped paying rounds ago.
      //   - `mapGrid` selects the hex's own value. Frozen, hovering a hex
      //     someone just upgraded reports its PRE-tile value.
      //
      // Cheap to fix: this is an `onPointerMove` prop, so a new identity just
      // swaps the handler React has attached. Nothing re-subscribes, and
      // nothing here writes state that could feed back into these deps.
      mapGrid,
      currentEra,
    ],
  );

  /** Canvas Click Interceptor (design note #7 / item 1). Pointer-up is used
   *  rather than a native `click` event so this can distinguish a genuine
   *  click from the tail end of a pan drag using the SAME `dragStateRef`
   *  already tracked for panning, instead of a second parallel gesture
   *  tracker. */
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);

      if (!drag) return;
      const movedX = event.clientX - drag.startX;
      const movedY = event.clientY - drag.startY;
      const movedDistance = Math.sqrt(movedX * movedX + movedY * movedY);
      // A real pan drag almost always moves several pixels even when the
      // user "meant" to click; a small dead zone tells the two apart
      // without feeling laggy on a genuine click.
      const CLICK_MOVEMENT_THRESHOLD_PX = 4;
      if (movedDistance > CLICK_MOVEMENT_THRESHOLD_PX) return;

      const rect = event.currentTarget.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      // Undo `draw()`'s own `ctx.translate(view.panX, view.panY)` /
      // `ctx.scale(view.zoom, view.zoom)` to land back in the hex layer's
      // own untransformed coordinate space that `pixelToAxial` expects.
      const contentX = (cssX - view.panX) / view.zoom;
      const contentY = (cssY - view.panY) / view.zoom;
      const { q, r } = pixelToAxial(contentX, contentY, hexSize);
      const hexLabel = describeHex(q, r);

      // Tile Selection Catalog verification pass, item 1 ("Expose Selection
      // Logs"): fires the instant a player clicks a hex to open the tile
      // picker -- BEFORE the async `GetLegalTilePlacements` query below even
      // starts, since the hex's own coordinate/preprinted terrain/
      // designation is already known synchronously at this point. The
      // "complete filtered array of allowed tile_ids" this item also asks
      // for genuinely can't be logged here too: it doesn't exist yet until
      // that query resolves (this is a live on-chain query, not a local
      // filter) -- see the second `console.log` in the `.then` handler
      // below for that half, fired the moment the response actually arrives.
      // eslint-disable-next-line no-console
      console.log("[TileSelection] hex clicked", {
        hex_coordinate: { q, r, hex_label: hexLabel },
        preprinted: describeHexDesignationForLog(q, r),
      });

      onHexClick?.({ q, r, hexLabel, clientX: event.clientX, clientY: event.clientY });

      // Design note #120: this guard used to be a single condition covering
      // all four interceptor props, and it is now split in two, because the
      // props go missing for two completely different reasons that were
      // being treated identically.
      //
      // FIRST: the interceptor is switched OFF deliberately. `App.tsx`'s
      // route-select mode omits `gameId`/`protocolId` (and `contractAddress`
      // and `queryClient`) specifically so a route-point click doesn't also
      // pop the LayTile picker open underneath it -- see design note #7 and
      // App.tsx design note #11. That must keep bailing out silently.
      //
      // REGRESSION FIX (design note #139): `!contractAddress` USED TO BE PART
      // OF THIS GUARD, and moving it out is the entire fix for "clicking a
      // hex no longer opens the tile picker offline".
      //
      // A contract address is a CHAIN concern, not a "which hex am I laying
      // on" concern, so it never belonged in the deliberately-off test. It
      // survived here only because it was never previously falsy: the address
      // was a hardcoded placeholder string (`"juno1...eighteencosmos..."`)
      // that was invalid but TRUTHY, so this guard always passed and control
      // always reached the offline fallback below. Offline mode was, without
      // anyone intending it, load-bearing on a fake constant being truthy.
      //
      // F-4 moved the address into the environment, where an unset variable
      // is correctly `undefined` -- and this guard, unchanged, began swallowing
      // every hex click in exactly the sandbox mode that has no address by
      // design. Silent, too: `onHexClick` had already fired, so the
      // "[TileSelection] hex clicked" log above still printed while the popup
      // never opened.
      //
      // `gameId`/`protocolId` are the honest discriminator: `App.tsx` supplies
      // both in normal mode and omits both in route-select mode, and neither
      // has anything to do with whether a chain is reachable.
      if (gameId === undefined || protocolId === undefined) {
        return;
      }

      // SECOND: the interceptor is ON -- the caller supplied the hex's
      // identity -- but there is no chain client to ask. In practice that
      // means the app is running without a connected wallet or node, which
      // is the ordinary state of `npm start` against no backend.
      //
      // THE BUG THIS FIXES: the old combined guard returned here too, so
      // `onHexClickQuery` never fired, `App.tsx`'s `hexClickQuery` stayed
      // `null`, and its `hexClickQuery?.status === "success"` gate never
      // rendered the popup. The picker appeared completely dead on click --
      // no popup, no error, no exception, and the "[TileSelection] hex
      // clicked" log above still printing perfectly, because the handler had
      // genuinely run and then decided there was nothing to do. Nothing was
      // hanging and no promise was pending; the flow simply had no offline
      // path at all.
      //
      // Now it falls back to the local catalog mirror so the picker still
      // opens and the tray still renders. `localCatalogPlacements` filters by
      // era ONLY -- see its doc comment -- so the result is explicitly
      // provisional and goes out under `status: "offline"`, which the UI is
      // required to label as such and must not dispatch from.
      // Design note #139: `!contractAddress` now sits HERE, alongside
      // `!queryClient`, because the two mean the same thing -- there is no
      // chain to ask. Either one missing takes the offline path, which is the
      // behaviour the sandbox has always needed and only accidentally had.
      if (!queryClient || !contractAddress) {
        const placements = localCatalogPlacements();
        // eslint-disable-next-line no-console
        console.log("[TileSelection] no chain client -- local catalog fallback", {
          hex_coordinate: { q, r, hex_label: hexLabel },
          eras: "all (browse via the picker's era tabs)",
          tile_count: new Set(placements.map((p) => p.tile_id)).size,
          contract_validated: false,
        });
        // Supersede any in-flight real query, so a response that arrives
        // after the client drops can't overwrite this offline state.
        clickQuerySeqRef.current += 1;
        onHexClickQuery?.({
          status: "offline",
          q,
          r,
          hexLabel,
          clientX: event.clientX,
          clientY: event.clientY,
          placements,
        });
        return;
      }

      const seq = ++clickQuerySeqRef.current;
      onHexClickQuery?.({
        status: "loading",
        q,
        r,
        hexLabel,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      queryClient
        .queryContractSmart(contractAddress, {
          GetLegalTilePlacements: { game_id: gameId, protocol_id: protocolId, q, r },
        })
        .then((response) => {
          // Stale-response guard: a rapid earlier click's request can
          // resolve after a newer click's -- only the latest matters.
          if (clickQuerySeqRef.current !== seq) return;

          // Tile Selection Catalog verification pass, item 1 (continued):
          // the "complete filtered array of allowed tile_ids" half of this
          // item's log, fired now that the upgrade catalog module
          // (`hexmap::legal_tile_placements` on-chain) has actually
          // returned it -- each entry is a `(tile_id, orientation)` pairing
          // the live `LayTile` call would currently accept at this hex.
          // eslint-disable-next-line no-console
          console.log("[TileSelection] legal placements resolved", {
            hex_coordinate: { q, r, hex_label: hexLabel },
            allowed_placements: (response as LegalTilePlacementsResponse).placements,
          });

          onHexClickQuery?.({
            status: "success",
            q,
            r,
            hexLabel,
            clientX: event.clientX,
            clientY: event.clientY,
            response: response as LegalTilePlacementsResponse,
          });
        })
        .catch((error: unknown) => {
          if (clickQuerySeqRef.current !== seq) return;
          const message = error instanceof Error ? error.message : String(error);
          onHexClickQuery?.({
            status: "error",
            q,
            r,
            hexLabel,
            clientX: event.clientX,
            clientY: event.clientY,
            message,
          });
        });
    },
    [
      view.panX,
      view.panY,
      view.zoom,
      hexSize,
      queryClient,
      contractAddress,
      gameId,
      protocolId,
      onHexClick,
      onHexClickQuery,
      // Design note #125 dropped `currentEra` from here: the offline
      // fallback no longer filters by era, so the handler has nothing
      // era-dependent left to close over. Era browsing is now a view control
      // inside `TileSelectionPopup` instead.
    ],
  );

  /** Design note #67: Scroll-Wheel Zoom Disabled. Previously zoomed the
   *  board around the cursor (`deltaY < 0` -> `factor = 1.1`, else `1 /
   *  1.1`, the exact same `setView`/`clampPanToBoard` update the "+"/"-"
   *  camera buttons below still use) -- reported: the ONLY way to zoom
   *  should be those manual buttons, not an incidental scroll-wheel
   *  gesture while the cursor happens to be over the map. The zoom
   *  math/state update is REMOVED entirely (not merely gated off, so
   *  there's no dead `minZoom`/`MAX_ZOOM_MULTIPLIER`/`clampPanToBoard`
   *  zoom-on-wheel path left to accidentally re-enable) -- `handleWheel`
   *  now does exactly one thing: `preventDefault()`, still unconditional,
   *  still purely to stop the page itself from scrolling while the cursor
   *  is over the canvas (design note #13's own reasoning, UNCHANGED by
   *  this pass -- that's a scroll-containment concern, not a zoom one). */
  const handleWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  }, []);

  /** "+"/"-" camera overlay button handler -- see design note #17.
   *  Zooms by `factor` around the canvas's own screen-space center (a
   *  button click has no cursor position to anchor on, unlike
   *  `handleWheel`'s mouse-anchored zoom), clamped to
   *  `[minZoom, minZoom * MAX_ZOOM_MULTIPLIER]` (design note #36/item 1 --
   *  relative to `minZoom`, not the old absolute `MAX_ZOOM`)
   *  and pan-clamped to the board exactly like every other zoom path here.
   *  If the camera is still at the locked `fitView` baseline
   *  (`detailedView === false`), this ALSO flips `detailedView` on -- these
   *  buttons are meant to work standalone, without first requiring a
   *  separate "Toggle Detailed View" click, so the very first "+"/"-"
   *  press starts from `fitView`'s own zoom/pan (captured via the
   *  `detailedView` dependency below) rather than being a no-op. */
  const handleZoomStep = useCallback(
    (factor: number) => {
      setDetailedView(true);
      setView((prev) => {
        const baseView = detailedView ? prev : fitView;
        const nextZoom = Math.min(minZoom * MAX_ZOOM_MULTIPLIER, Math.max(minZoom, baseView.zoom * factor));
        // Keep the point currently at the canvas's own screen-space center
        // fixed in world space while zooming, so repeated +/- presses zoom
        // in/out around the middle of the view rather than drifting.
        const centerWorldX = (width / 2 - baseView.panX) / baseView.zoom;
        const centerWorldY = (height / 2 - baseView.panY) / baseView.zoom;
        const clamped = clampPanToBoard(
          width / 2 - centerWorldX * nextZoom,
          height / 2 - centerWorldY * nextZoom,
          nextZoom,
          boardContentBounds,
          width,
          height,
        );
        return { zoom: nextZoom, panX: clamped.panX, panY: clamped.panY };
      });
      scheduleDraw();
    },
    [detailedView, fitView, minZoom, boardContentBounds, width, height, scheduleDraw],
  );
  const handleZoomIn = useCallback(() => handleZoomStep(1.25), [handleZoomStep]);
  const handleZoomOut = useCallback(() => handleZoomStep(1 / 1.25), [handleZoomStep]);

  /** "Fit to Screen" camera overlay button handler -- see design note #17
   *  (button removed and consolidated per design note #42, handler logic
   *  unchanged). Unconditionally snaps the camera back to exactly `fitView`
   *  and re-locks it (`detailedView` false) -- idempotent and always
   *  available as its own explicit action, regardless of whether the camera
   *  got to its current pose via drag/wheel or the "+"/"-" buttons above. */
  const handleFitToScreen = useCallback(() => {
    setDetailedView(false);
    setView(fitView);
    scheduleDraw();
  }, [fitView, scheduleDraw]);

  /** The pointer has left the canvas entirely -- clears the off-board hover
   *  tooltip (design note #15/item 4) in addition to `handlePointerUp`'s own
   *  drag-release handling, since `handlePointerMove` (the only other place
   *  that updates `hoveredOffboardHex`) stops firing once the pointer is
   *  outside the element. */
  const handlePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      setHoveredOffboardHex(null);
      setHoveredCoordLabel(null);
      setHoveredHexCoord(null);
      handlePointerUp(event);
    },
    [handlePointerUp],
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        // Design note #19: with no explicit `widthProp`, this wrapper
        // flex-fills its host pane's WIDTH (`ResizeObserver` above measures
        // the pixel width that resolves to); an explicit override keeps the
        // old fixed-pixel behavior.
        width: widthProp ?? "100%",
        // ITEM 1 FIX (design note #27): was `heightProp ?? "100%"` -- a
        // percentage height only ever resolves against an ANCESTOR's own
        // definite height, which no longer exists once `App.tsx` (design
        // note #13) stops imposing one. This is now the same computed pixel
        // `height` the `<canvas>` below uses (derived from the board's own
        // aspect ratio, not measured), so this wrapper's real DOM box is
        // exactly as tall as its content actually needs -- letting that
        // height propagate straight up through every unconstrained ancestor
        // to the page itself.
        height: `${height}px`,
      }}
      className={className}
    >
      {/* Design note #25: the map canvas is once again the direct, single
          child here -- no nested wrapper div. Design notes #20/#23/#24's DOM
          overlay/frame detour is gone entirely: the row/column margin
          labels are now drawn NATIVELY on the canvas itself (see
          `drawBoardMarginLabels`, called at the end of `draw()`'s
          world-space pass), so there's no longer any separate DOM element
          that needs to be sized or positioned relative to the canvas at
          all. */}
      <canvas
        ref={canvasRef}
        style={{ width, height, touchAction: "none", cursor: detailedView ? "grab" : "default" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
      />
      {/* Active coordinate + value hover tooltip -- see design note #21,
          enriched by design note #26/item 2 (drops the old "Hovering: "
          prefix so the on-screen text matches that item's own literal
          "G19: New York (Value: $20)" example exactly). Positioned with
          plain `position: fixed` viewport coordinates (not relative to
          this wrapper), so it tracks the raw cursor position exactly.
          Design note #75: ADAPTIVE QUADRANT, mirroring `drawOffboardTooltip`
          -- reported, this always anchored down-right of the cursor
          regardless of room, running off the panel for hexes near its
          right/bottom edge (Boston, Fall River). `preferLeft`/`preferAbove`
          (computed in `handlePointerMove` from the cursor's position within
          the canvas's own panel) flip which corner of the tooltip sits at
          the cursor, using `right`/`bottom` (viewport-anchored, same as
          `left`/`top`) instead of just always growing down-right. */}
      {hoveredCoordLabel && (
        <div
          style={{
            ...HOVER_TOOLTIP_STYLE,
            ...(hoveredCoordLabel.preferLeft
              ? { right: window.innerWidth - hoveredCoordLabel.clientX + 14 }
              : { left: hoveredCoordLabel.clientX + 14 }),
            ...(hoveredCoordLabel.preferAbove
              ? { bottom: window.innerHeight - hoveredCoordLabel.clientY + 14 }
              : { top: hoveredCoordLabel.clientY + 14 }),
          }}
        >
          {hoveredCoordLabel.label}
        </div>
      )}
      {/* Rail Map Overhaul (design note #42): "Clean Up Control Overlay
          Overlaps" -- the old separate "Toggle Detailed View" button
          (design note #13) is removed entirely, and the former "+"/"-"/
          "Fit to Screen" bottom-right stack is folded into this single
          floating top-right panel alongside the new City Names toggle, so
          there's exactly ONE control cluster instead of two. */}
      <div style={MAP_CONTROLS_PANEL_STYLE}>
        <button
          type="button"
          onClick={() => setShowCityNames((prev) => !prev)}
          style={CAMERA_CONTROL_BUTTON_STYLE}
          aria-label={showCityNames ? "Hide city names" : "Show city names"}
        >
          {showCityNames ? "Hide City Names" : "Show City Names"}
        </button>
        <button type="button" onClick={handleZoomOut} style={CAMERA_CONTROL_BUTTON_STYLE} aria-label="Zoom out">
          -
        </button>
        <button type="button" onClick={handleZoomIn} style={CAMERA_CONTROL_BUTTON_STYLE} aria-label="Zoom in">
          +
        </button>
        <button
          type="button"
          onClick={handleFitToScreen}
          style={CAMERA_CONTROL_BUTTON_STYLE}
          aria-label="Fit to screen"
        >
          Fit to Screen
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                    */
/* ------------------------------------------------------------------ */

/** Traces (but doesn't fill/stroke) the six-cornered hex outline centered
 *  at `center`, ready for the caller to `ctx.fill()`/`ctx.stroke()`. */
function drawHexPath(
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
function withHexClip(
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
function edgeInwardNormal(edgeIndex: number): { x: number; y: number } {
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
function bezierTrackSegment(
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
function drawHexEdges(
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
function drawImpassableBorderEdge(
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
function twoCityStationPoints(
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
interface DoubleTownRoute {
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
const DOUBLE_TOWN_ROUTES: Readonly<Record<number, readonly DoubleTownRoute[]>> = {
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
function drawDoubleTownRoute(
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
function pathsAreDisjoint(paths: ReadonlyArray<readonly [number, number]>): boolean {
  const seen = new Set<number>();
  for (const [a, b] of paths) {
    if (a === b) return false; // terminal spur -- handled by `cityGroups`
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a);
    seen.add(b);
  }
  return paths.length > 0;
}

/** Draws a tile's revenue-centre markers -- station circle, town dit(s),
 *  or a neutral junction dot -- on top of whatever track was already
 *  stroked. Extracted from `drawTrackPath` by design note #122 so the
 *  new disjoint-path branch and the original fan branch share one
 *  implementation instead of growing a second copy that could drift.
 *
 *  Keyed purely on TERRAIN, never on edge count -- see the notes inside.
 *  `DoubleTown` is handled by `DOUBLE_TOWN_ROUTES` before this is ever
 *  reached, so its branch here is a fallback for a double-town tile with
 *  no explicit artwork entry. */
function drawTileMarkers(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  entry: TileCatalogEntry,
  edges: readonly number[],
): void {
  //
  // Design note #118: this block used to live INSIDE the 3+-edge branch (for
  // the station circle) and to be gated on `edges.length === 2` (for the
  // dits), which quietly assumed the old invented catalog's geometry. The
  // real 1830 tray catalog breaks both assumptions in ways that matter:
  //
  //   - #57, the Yellow `MajorCityHub` that EVERY plain-city hex on the
  //     board starts from, has exactly TWO live edges (0/3, a straight) --
  //     so under the old placement it drew no station circle at all, the
  //     single most visible tile in the game rendering as bare track.
  //   - #1/#2/#55/#56/#69, the Yellow `DoubleTown`s, have FOUR live edges
  //     each -- so under the old `=== 2` gate they drew no dits, and picked
  //     up the neutral junction dot instead, reading as plain track.
  //
  // Hoisting the whole thing out and keying it purely on TERRAIN (never on
  // edge count) fixes both and is inherently robust to any future catalog
  // whose geometry differs again.
  if (entry.terrain === "MajorCityHub" || entry.terrain === "BostonHub") {
    // design note #49: Boston/Baltimore's own "B"-labeled single-city hub
    // (`BostonHub`) gets the same single-station treatment as an ordinary
    // MajorCityHub -- the "B" label is a legality restriction, not a
    // different artwork shape.
    drawStationCircle(ctx, center, size);
  } else if (entry.terrain === "SmallTown") {
    // A solid DARK circle (design note #3b / item 8's "Distinct Dark Small
    // Towns"), deliberately not the small white circle this file used
    // previously, so a town/dit reads as visually distinct from a buildable
    // city station hub at a glance.
    drawDitMarker(ctx, center, size);
  } else if (entry.terrain === "DoubleTown") {
    // Standardized onto the SAME `twoNodePositions` diagonal coordinates as
    // G19/OO/every unlaid double-town-designated hex (design notes #57/#58).
    // Index 0/1 map directly onto the two `drawDitMarker` calls below, first
    // slot then second slot, with no re-sorting.
    const [node0, node1] = twoNodePositions(center, size);
    drawDitMarker(ctx, node0, size * 0.85); // index 0: top-right
    drawDitMarker(ctx, node1, size * 0.85); // index 1: bottom-left
  }
  // FIX (design note #128): a branch used to sit here giving any non-city
  // tile with 3+ live edges a small dark dot at hex centre. That dot is why
  // Green and Brown PLAIN track showed phantom towns -- at 0.18 radius in
  // `#555555` it reads as a dit, and the multi-edge plains and junctions
  // (#16, #39-#47, #70) all qualified. A junction is a track crossing, not a
  // revenue centre; real cardboard prints nothing there.
  //
  // Every marker this function draws is now gated on TERRAIN alone -- never
  // on edge count, never on path shape. Only `SmallTown`/`DoubleTown`
  // produce dits, only `MajorCityHub`/`BostonHub` a station circle, and
  // anything else draws no centre marker at all.
}

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
function drawHardcodedTileArtwork(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  tileId: number,
  orientation: number,
): boolean {
  const paths = tileArtworkPaths(tileId);
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (!paths || !art) return false;

  const rot = ((orientation % 6) + 6) % 6;

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate((-60 * rot * Math.PI) / 180);
  ctx.scale(size, size);
  ctx.strokeStyle = "#2b2b2b";
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

function drawTrackPath(
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
): void {
  // ==== Design note #131: hardcoded artwork wins, unconditionally. ====
  // FIRST statement in the function, ahead of `rotateConnections`/
  // `liveEdges` and every procedural branch below, so a catalogued tile
  // cannot reach them even by accident. The overlays pass still runs --
  // that is the revenue badge and the "B"/"NY"/"OO" restriction label,
  // neither of which is track art.
  if (drawHardcodedTileArtwork(ctx, center, size, entry.tileId, orientation)) {
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
    return;
  }

  const actualMask = rotateConnections(entry.connections, orientation);
  const edges = liveEdges(actualMask);

  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));

  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(3, size * 0.12);
  ctx.lineCap = "round";

  // Design note #119: the DoubleTown discrete-path branch, checked before
  // everything else because it is the narrowest and most specific case.
  //
  // SCOPE, deliberately: this branch is gated on `terrain === "DoubleTown"`
  // AND on discrete paths actually being available, so it can only ever
  // capture #1/#2/#55/#56/#69. Every other tile -- including the multi-edge
  // city and plain tiles, whose Rust catalog rows DO carry path lists --
  // falls through to exactly the branches it used before, unchanged. That
  // is a scope decision, not an oversight: the existing branches already
  // render those correctly, and routing them through here too would restyle
  // most of the board for no correctness gain.
  //
  // Why these five needed it: each has FOUR live edges paired into TWO
  // independent two-edge routes, one per town, and `connections` is a flat
  // union that cannot say which edge pairs with which. Proof that the mask
  // alone is insufficient rather than merely inconvenient -- #1 and #55
  // share the identical mask `0b01_1011` but pair as {0,4}+{1,3} versus
  // {0,3}+{1,4}; #2 and #56 share `0b00_1111` but pair as {0,3}+{1,2}
  // versus {0,2}+{1,3}. No function of the mask can tell those apart. The
  // old fan-to-centre rendering drew all four of them as the same four-way
  // junction with two dits floated at fixed offsets, which is wrong track
  // topology and wrong dit placement on every one of the five.
  // SUPERSEDED APPROACH (design note #121): a first pass drew these from
  // the catalog's path data through a generalized offset -- each route bent
  // through its own node so the two dits could not collide. That was wrong
  // on the tiles it mattered most for. #55 is two straights crossing in an
  // X, and bending both arms through offset nodes visibly bowed them into
  // something that is not the tile; #56's two gentle curves came out warped
  // enough to be hard to read. The lesson is that "make the markers fit" is
  // not a good enough reason to move the TRACK. There are exactly five of
  // these tiles in all of 1830, so they are now drawn from an explicit
  // per-tile table (`DOUBLE_TOWN_ROUTES`) instead of derived, and the dits
  // move around the geometry rather than the geometry moving around them.
  const doubleTownRoutes =
    entry.terrain === "DoubleTown" ? DOUBLE_TOWN_ROUTES[entry.tileId] : undefined;
  if (doubleTownRoutes) {
    const rot = ((orientation % 6) + 6) % 6;
    // Every route drawn before any dit, so a crossing arm (#55's X crosses
    // at centre by definition) can never be stroked over a town marker.
    const ditPoints = doubleTownRoutes.map((route) => {
      const edgeA = (route.edges[0] + rot) % 6;
      const edgeB = (route.edges[1] + rot) % 6;
      const along = drawDoubleTownRoute(ctx, center, size, apothem, edgeA, edgeB);
      // Design note #123: each town sits at its own explicit `ditAt`, out
      // along its arm and clear of the crossing -- never at `t = 0.5`,
      // which is precisely where the other track passes.
      return along(route.ditAt);
    });
    for (const point of ditPoints) {
      drawDitMarker(ctx, point, size * 0.85);
    }
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
    return;
  }

  // Design note #122: every OTHER tile whose catalog paths are disjoint --
  // #16/#18/#19/#20's crossing green plains, and the single-track tiles
  // (#3/#4/#7/#8/#9/#57/#58) -- is now drawn from those declared paths too,
  // with the same canonical straight/gentle/sharp primitives the
  // double-towns use. This is the "art, not math" rule applied to the whole
  // catalog: track shape comes from sourced path data, never from a guess
  // about what a flat bitmask might have meant. Junction and city tiles
  // deliberately do NOT come through here -- see `pathsAreDisjoint`.
  // REGRESSION FIX (design note #130): the `!entry.cityGroups` guard is
  // load-bearing and its absence was the reported "city markers completely
  // missing" bug, introduced by design note #122's own ordering.
  //
  // Every two-city tile has DISJOINT paths by definition -- that is what
  // makes it two cities rather than one hub. #54/#62 are `[[0,1],[2,3]]`,
  // #59 two spurs, #64-#68 two pairs. So this branch, sitting above the
  // `cityGroups` branch, swallowed all eight of them: it drew their track
  // correctly and then handed off to `drawTileMarkers`, which keys on
  // terrain and has no case for `NewYorkHub`/`DoubleCityHub` -- because
  // those were always meant to have drawn their own pair of station circles
  // in the `cityGroups` branch that now never ran. Result: correct track,
  // no cities at all.
  //
  // Guarding here rather than reordering the branches keeps the diff honest
  // about which one is the special case: `cityGroups` tiles have bespoke
  // two-node artwork and must claim themselves first; this branch is the
  // general disjoint-path renderer for everything else.
  if (!entry.cityGroups && entry.paths && pathsAreDisjoint(entry.paths)) {
    const rot = ((orientation % 6) + 6) % 6;
    for (const [baseA, baseB] of entry.paths) {
      drawDoubleTownRoute(ctx, center, size, apothem, (baseA + rot) % 6, (baseB + rot) % 6);
    }
    drawTileMarkers(ctx, center, size, entry, edges);
    drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
    return;
  }

  // Design note #118: `cityGroups` is checked FIRST now, ahead of the
  // 2-live-edge shortcut below. Previously the shortcut won, which was
  // harmless while the only two-city tiles in the catalog had 4+ live edges
  // -- but the real 1830 tray catalog includes #59 ("OO" Green), whose two
  // cities are a pair of DISCONNECTED one-edge stubs on edges 0 and 2.
  // That's exactly 2 live edges, so the old ordering would have drawn it as
  // a single continuous curve joining the two edges through one shared
  // centre node: visually a through-route, and factually the opposite of
  // what the tile is (`hexmap::terrain_base_value` prices `DoubleCityHub` at
  // $40 -- one station per visit -- precisely BECAUSE those two stations
  // don't connect intra-hex).
  if (entry.cityGroups) {
    // Design note #52: a genuine two-city tile (New York, every OO
    // variant) -- draw each city's own paired-edge curve into ITS OWN
    // station point, NOT one shared fan-to-center hub. The old code below
    // (still used for single-city tiles) fanned every live edge into
    // `center`, which was fine for a `MajorCityHub`/`BostonHub` tile (a
    // single real city) but wrong for these: the real tile has two
    // physically independent city nodes, and treating all of a NY/OO
    // tile's edges as radiating from ONE point drew phantom track past
    // wherever the OTHER city's own edges actually terminate, and is what
    // let a corrected (sparse) bitmask still look like a 6-spoke wildcard
    // fanning from hex center. `twoCityStationPoints` gives the exact same
    // two points the station-circle block below draws its circles at, so
    // track and circles can't drift apart.
    //
    // BUG FIX (design note #118): `cityGroups` is expressed in BASE
    // (pre-rotation) edge numbers, exactly like `entry.connections`, but
    // `edges` above is the POST-rotation live set. The old code intersected
    // the two directly, so at any `orientation !== 0` the intersection came
    // back empty or partial and a rotated NY/OO tile silently drew little or
    // none of its own track. `rotateConnections` shifts base edge `e` to
    // `(e + orientation) % 6` (bit `e` left-shifted by `orientation`), so
    // the same transform is applied here before intersecting.
    const rot = ((orientation % 6) + 6) % 6;
    const stationPoints = twoCityStationPoints(entry.terrain, center, size);
    entry.cityGroups.forEach((groupEdges, cityIndex) => {
      const liveGroupEdges = groupEdges
        .map((edge) => (edge + rot) % 6)
        .filter((edge) => edges.includes(edge))
        .sort((a, b) => a - b);
      if (liveGroupEdges.length === 0) return;
      const stationPoint = stationPoints[cityIndex] ?? center;
      if (liveGroupEdges.length === 1) {
        const point = edgePoint(liveGroupEdges[0]);
        bezierTrackSegment(ctx, point, stationPoint, size, edgeInwardNormal(liveGroupEdges[0]), null);
      } else if (liveGroupEdges.length === 2) {
        const [a, b] = liveGroupEdges;
        const start = edgePoint(a);
        const end = edgePoint(b);
        const isOpposite = Math.abs(b - a) === 3;
        if (isOpposite) {
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        } else {
          bezierTrackSegment(ctx, start, stationPoint, size, edgeInwardNormal(a), null);
          bezierTrackSegment(ctx, stationPoint, end, size, null, edgeInwardNormal(b));
        }
      } else {
        for (const edge of liveGroupEdges) {
          const point = edgePoint(edge);
          bezierTrackSegment(ctx, point, stationPoint, size, edgeInwardNormal(edge), null);
        }
      }
    });

    // Both two-node terrains draw the identical pair of station circles --
    // see `twoCityStationPoints`/design note #56 for why `NewYorkHub` was
    // merged onto `DoubleCityHub`'s geometry rather than keeping its own.
    drawStationCircle(ctx, stationPoints[0], size * 0.85);
    drawStationCircle(ctx, stationPoints[1], size * 0.85);
    // Design note #124: two-node hubs return through the shared tail below,
    // so their badge is drawn there like every other tile's.
  } else if (edges.length === 2) {
    const [a, b] = edges;
    const start = edgePoint(a);
    const end = edgePoint(b);
    // `liveEdges` returns edges in ascending order (a < b), so a true
    // opposite pair -- 0&3, 1&4, 2&5 -- is exactly the b - a === 3 case;
    // no modular-distance math is needed given that ordering.
    const isOpposite = b - a === 3;

    // BUG FIX (Revenue Center Connectivity pass -- see `drawPrintedTrack`'s
    // identical fix for the full derivation of why `arcTo` never actually
    // touches `center`). Design note #118 update: the real tray catalog makes
    // this branch far busier than the old one did -- it now carries every
    // single-town tile (#3/#4/#58), every plain curve and straight
    // (#7/#8/#9), AND #57, the yellow city tile that starts every plain-city
    // hex on the board -- so the hardening below is load-bearing now rather
    // than merely proactive.
    if (isOpposite) {
      // A true through-route: edges directly across the tile from each
      // other -- a straight track, per this feature's explicit request
      // to use `ctx.lineTo` for this case.
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    } else {
      // Rail Map Overhaul (design note #42): two cubic-Bezier halves via
      // `bezierTrackSegment`, each perpendicular-entering its own edge
      // (`edgeInwardNormal(a)`/`edgeInwardNormal(b)`) and easing through the
      // shared station node at `center` -- replaces the previous
      // `quadraticCurveTo`-based `curveHalf` closure.
      bezierTrackSegment(ctx, start, center, size, edgeInwardNormal(a), null);
      bezierTrackSegment(ctx, center, end, size, null, edgeInwardNormal(b));
    }
  } else if (edges.length > 0) {
    // Three or more live edges, single city (a `MajorCityHub`/`BostonHub`
    // tile) or an ordinary multi-spur junction: the bitmask alone doesn't
    // say which pairs route together (see design note #3), so draw a spoke
    // from each live edge into a shared center "station" node instead.
    // Rail Map Overhaul (design note #42): each spoke is now a
    // perpendicular-entering Bezier curve (`bezierTrackSegment`), matching
    // `drawPrintedTrack`'s own already-curved 3+-edge treatment, instead of
    // the previous straight `lineTo` spoke.
    //
    // Design note #118: this is also the deliberate GENERIC-ARTWORK fallback
    // for the real tray catalog's multi-edge DOUBLE-TOWN tiles (#1, #2,
    // #55, #56, #69 -- four live edges each, two towns each). Real 1830
    // pairs those four edges into two specific two-edge town routes, but
    // `hexmap::TILE_CATALOG` only publishes the flat union bitmask, and this
    // file's standing discipline (design note #3) is to render what the data
    // actually says rather than invent a pairing it doesn't. So each edge
    // fans to centre and the two dit markers are drawn at the canonical
    // two-node positions below: correct terrain, correct live edges, correct
    // stop count, approximate intra-tile routing. Upgrade path if the
    // backend ever publishes per-node edge groups: give those five entries
    // `cityGroups` and they move to the first branch with no other change.
    for (const edge of edges) {
      const point = edgePoint(edge);
      bezierTrackSegment(ctx, point, center, size, edgeInwardNormal(edge), null);
    }
  }

  drawTileMarkers(ctx, center, size, entry, edges);
  drawTileOverlays(ctx, center, size, entry, showRevenue, revenueOverride);
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
function drawRouteOverlays(
  ctx: CanvasRenderingContext2D,
  size: number,
  overlays: readonly RouteOverlay[],
): void {
  if (overlays.length === 0) return;

  const apothem = size * (Math.sqrt(3) / 2);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(6, size * 0.3);
  ctx.globalAlpha = 0.55;

  for (const overlay of overlays) {
    if (overlay.hexes.length < 2) continue;
    ctx.strokeStyle = overlay.color;

    for (let index = 0; index < overlay.hexes.length - 1; index += 1) {
      const [q, r] = overlay.hexes[index];
      const [nextQ, nextR] = overlay.hexes[index + 1];

      // Which edge of the current hex faces the next one. `undefined` means
      // they are not neighbours -- see the doc comment on why that is skipped
      // rather than bridged.
      const exitEdge = HEX_NEIGHBOR_OFFSETS.findIndex(
        ([dq, dr]) => q + dq === nextQ && r + dr === nextR,
      );
      if (exitEdge < 0) continue;

      const center = axialToPixel(q, r, size);
      const nextCenter = axialToPixel(nextQ, nextR, size);
      const crossing = pointOnCircle(center, apothem, edgeAngleRad(exitEdge));
      const arrivalEdge = (exitEdge + 3) % 6;

      // Same two-half construction, same normals, as a real track spline --
      // so the ribbon lies along the rails through curves instead of cutting
      // across them.
      bezierTrackSegment(ctx, center, crossing, size, null, edgeInwardNormal(exitEdge));
      bezierTrackSegment(ctx, crossing, nextCenter, size, null, edgeInwardNormal(arrivalEdge));
    }
  }

  ctx.restore();
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
function drawUnknownTilePlaceholder(
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
function drawStationCircle(
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
function drawStationPill(
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
    ctx.arc(offset, 0, radius * 0.86, 0, Math.PI * 2);
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
function drawDitMarker(
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
const VALUE_BADGE_SHAPE: Readonly<
  Record<"SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub", "square" | "diamond">
> = {
  SmallTown: "square",
  DoubleTown: "square",
  MajorCityHub: "square",
  DoubleCityHub: "square",
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
function drawBadgeShape(
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
function badgeRadiusForLabel(
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
const BADGE_SLOT_PREFERENCE: readonly number[] = [11, 9, 12, 8, 6, 5, 2, 3];

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
function drawValueBadge(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  // Design note #39: this hex's own axial coordinates, needed to look up
  // `deadEdgesAt(q, r)` -- `center` alone (a pixel position) can't recover
  // these, and every existing call site already has them on hand (they're
  // how `center` itself was computed via `axialToPixel`).
  q: number,
  r: number,
  terrain: "SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub",
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
function drawValueBadgeAt(
  ctx: CanvasRenderingContext2D,
  badgeCenter: { x: number; y: number },
  size: number,
  terrain: "SmallTown" | "DoubleTown" | "MajorCityHub" | "DoubleCityHub",
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
 *  would stamp two numbers on one hex. The restriction label is NOT gated
 *  the same way -- `drawRestrictionBadge` labels the HEX (and only the nine
 *  real B/NY/OO hexes), whereas this labels the TILE, which is a different
 *  statement: it tells you what the piece in your hand is restricted to,
 *  which is exactly what the tray needs and what the board's hex badge
 *  cannot say. */
function drawTileOverlays(
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

  const label = restrictionLabelFor(entry.terrain);
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
function valueBadgeTerrainFor(
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
 *  tell the player something untrue about where they may be laid. The nine
 *  that really are label-restricted: #53/#61 (B), #54/#62 (NY),
 *  #59/#64/#65/#66/#67/#68 (OO). */
function restrictionLabelFor(terrain: TerrainType): "B" | "NY" | "OO" | null {
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
const RESTRICTION_SLOT_PREFERENCE_DOUBLE_CITY: readonly number[] = [12, 8, 1, 2, 3, 4, 5, 6];
const RESTRICTION_SLOT_PREFERENCE_OTHER: readonly number[] = [12, 8, 1, 2, 3, 4, 5, 6];

function drawRestrictionBadge(
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
function drawRestrictionBadgeAt(
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

/** Draws a landmark's authentic, fixed starting track (see `LANDMARK_TRACKS`
 *  and design note #6b) -- NOT derived from any connection bitmask, since a
 *  landmark's pre-printed track is not a laid tile. Each segment is drawn
 *  independently: a 2-edge segment is a through-route with one shared
 *  station at hex center (mirroring `drawTrackPath`'s opposite/curve split
 *  above); a 1-edge segment (New York's two disconnected stubs) draws a
 *  short stub from the edge partway toward center, with its own station
 *  positioned there so New York's two stations don't overlap each other. */
function drawLandmarkTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  segments: ReadonlyArray<{ edges: readonly number[] }>,
): void {
  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));

  segments.forEach((segment, segmentIndex) => {
    // BUG FIX ("G19 Thin Track" -- reported: New York's track renders much
    // thinner than every other hex's track). Root cause: `drawStationCircle`
    // (called at the end of each segment's branch below, once per station)
    // sets `ctx.lineWidth = Math.max(2, size * 0.06)` for its own circle
    // outline and never restores it afterward. New York is the only
    // landmark with TWO segments in this loop (its "one hex, two
    // disconnected stations" design, see `LANDMARK_TRACKS`'s doc comment)
    // -- Boston/Baltimore each have exactly one, so their single track
    // stroke always happens before their one `drawStationCircle` call ever
    // runs and is never affected. New York's SECOND segment, though, draws
    // its own track stroke AFTER the first segment's `drawStationCircle`
    // call already shrank `ctx.lineWidth` down to the thin circle-outline
    // value -- with nothing in between to set it back, that second stub
    // rendered at barely half this function's intended track width. Setting
    // the track's stroke style fresh at the TOP of every loop iteration
    // (rather than once before the loop) guarantees each segment's own
    // stroke always uses the correct track width, regardless of what a
    // prior segment's station circle left behind.
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = Math.max(3, size * 0.12);
    ctx.lineCap = "round";

    if (segment.edges.length === 2) {
      const [a, b] = segment.edges;
      const start = edgePoint(a);
      const end = edgePoint(b);
      const isOpposite = Math.abs(b - a) === 3;

      // BUG FIX (Revenue Center Connectivity pass -- see `drawPrintedTrack`'s
      // identical fix for the full derivation): `arcTo` cuts the corner at
      // `center` by construction and never actually touches it. Boston/
      // Baltimore's real edge pairs happen to be 120 degrees apart, where
      // the old `curveRadius = size * 0.6` leaves only a `~0.09 * size` gap
      // -- small enough to usually hide under `drawStationCircle`'s `0.22 *
      // size` radius -- but that's a coincidence of these two hexes' exact
      // edges, not a guarantee, and it's the same fragile pattern that
      // visibly broke for the gray hexes' more common 60-degree pairs.
      // Replaced with the same two-`quadraticCurveTo`-halves technique,
      // each with a guaranteed-exact endpoint at `center.x, center.y`.
      if (isOpposite) {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      } else {
        // Rail Map Overhaul (design note #42): two perpendicular-entering
        // cubic-Bezier halves via `bezierTrackSegment`, replacing the
        // previous `quadraticCurveTo`-based `curveHalf` closure -- same
        // "guaranteed-exact endpoint at center" property this BUG FIX
        // originally required, now via a Bezier curve instead of a
        // quadratic one.
        bezierTrackSegment(ctx, start, center, size, edgeInwardNormal(a), null);
        bezierTrackSegment(ctx, center, end, size, null, edgeInwardNormal(b));
      }

      drawStationCircle(ctx, center, size);
    } else if (segment.edges.length === 1) {
      const edgeEnd = edgePoint(segment.edges[0]);
      // A dead-end stub, curving in from the printed edge to the SAME
      // canonical diagonal node `stationMarkerPoint` anchors its token
      // marker to (design note #56: segment index 0 = Node Index 0 =
      // Top-Right/NE via `center + doubleNodeOffset`; segment index 1 =
      // Node Index 1 = Bottom-Left/SW via `center - doubleNodeOffset`) --
      // NOT the old independently-computed "50% of the way from this
      // segment's own edge toward center" approximation, which could land
      // at a different pixel than `stationMarkerPoint`'s point and let the
      // real printed track visually detach from its own token marker.
      // `LANDMARK_TRACKS["New York"]`'s segment order already encodes this
      // (segment 0 = edge 1/NE, segment 1 = edge 4/SW), so this stays a
      // purely structural, non-hardcoded mapping -- `segmentIndex` indexes
      // directly into `twoNodePositions`' own 2-tuple (design note #58), no
      // re-derived arithmetic. Rail Map Overhaul (design note #42): a
      // perpendicular-entering Bezier curve (`bezierTrackSegment`) instead
      // of a straight `lineTo` stub.
      const stubStation = twoNodePositions(center, size)[segmentIndex];

      bezierTrackSegment(ctx, edgeEnd, stubStation, size, edgeInwardNormal(segment.edges[0]), null);

      drawStationCircle(ctx, stubStation, size);
    }
  });
}

/** Draws an off-board hex's pre-printed track stubs -- see `OFFBOARD_TRACKS`
 *  and design note #10. A short stub line from each live edge partway
 *  toward the hex's center, deliberately with NO station circle (unlike
 *  `drawLandmarkTrack` above) -- an off-board hex is a revenue
 *  destination, not a real station a train can dwell at. */
function drawOffboardTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  edges: readonly number[],
): void {
  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));

  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(3, size * 0.12);
  ctx.lineCap = "round";

  // Rail Map Overhaul (design note #42): each stub is now a
  // perpendicular-entering Bezier curve (`bezierTrackSegment`) instead of a
  // straight `lineTo` stub, matching every other track-drawing function in
  // this file.
  for (const edge of edges) {
    const edgeEnd = edgePoint(edge);
    const stubEnd = {
      x: center.x + (edgeEnd.x - center.x) * 0.55,
      y: center.y + (edgeEnd.y - center.y) * 0.55,
    };
    bezierTrackSegment(ctx, edgeEnd, stubEnd, size, edgeInwardNormal(edge), null);
  }
}

/** Draws a pre-printed gray hex's fixed track + station/dit/none marker --
 *  see `GRAY_HEXES` and design note #12. Generalizes `drawLandmarkTrack`'s
 *  1-edge (dead-end stub) and 2-edge (through-route) cases to also handle
 *  3+ edges (a curved multi-spur junction, matching `drawTrackPath`'s
 *  multi-spur handling), since two real gray hexes (Rochester, Altoona)
 *  have three real live edges converging on one city.
 *
 *  Item 6 (Authentic Preprinted Gray Track Curves): every segment here
 *  now curves cleanly INTO the station/dit marker rather than stopping
 *  short of it or meeting it via a straight spoke -- a 1-edge dead-end
 *  stub now runs the full distance to hex center (where its own marker
 *  sits, matching the 2-edge/3+-edge cases below, instead of the previous
 *  pass's shortened halfway stub with the marker floating off-center), and
 *  a 3+-edge junction now draws each spoke as a gentle `quadraticCurveTo`
 *  bend into center instead of a straight radial line, so the track reads
 *  as authentic curved 1830 tile artwork "snapping into" the station hole
 *  rather than a generic straight-line stub. The 2-edge case already had
 *  real curve/straight-through logic (unchanged here) -- see the
 *  `isOpposite` branch below, identical to `drawTrackPath`'s own.
 *
 *  Item (Precise Geometric Track Calibration pass): `bypass`, when set on a
 *  true opposite-edge pair (the only shape the real source's bypass paths
 *  ever take -- see `GrayHexTrack.bypass`'s doc comment), draws a SECOND
 *  curve between the same two edges via `quadraticCurveTo`, bowed well off
 *  the straight chord so it visibly clears the station circle instead of
 *  passing through it -- Altoona's real "some trains skip this stop" fork,
 *  reinstated after being simplified away in an earlier pass. */
function drawPrintedTrack(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  size: number,
  edges: readonly number[],
  marker: "city" | "town" | "none",
  bypass?: boolean,
): void {
  const apothem = size * (Math.sqrt(3) / 2);
  const edgePoint = (edgeIndex: number) => pointOnCircle(center, apothem, edgeAngleRad(edgeIndex));
  const sorted = [...edges].sort((a, b) => a - b);

  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = Math.max(3, size * 0.12);
  ctx.lineCap = "round";

  // Every case's marker now sits at true hex center -- item 6's "snap
  // perfectly into the center holes" ask -- since no gray hex has more
  // than one single-edge dead-end stub of its own (unlike New York's two
  // independent landmark stations, which still need `drawLandmarkTrack`'s
  // own off-center offset to avoid overlapping each other).
  const markerPoint = center;

  if (sorted.length === 1) {
    // A gentle curve rather than a dead-straight radial line, so even a
    // single stub reads as authentic curved track, not a generic
    // ruler-straight stub. Rail Map Overhaul (design note #42):
    // perpendicular-entering cubic Bezier (`bezierTrackSegment`) instead of
    // the previous `quadraticCurveTo`.
    const edgeEnd = edgePoint(sorted[0]);
    bezierTrackSegment(ctx, edgeEnd, center, size, edgeInwardNormal(sorted[0]), null);
  } else if (sorted.length === 2) {
    const [a, b] = sorted;
    const start = edgePoint(a);
    const end = edgePoint(b);
    const isOpposite = b - a === 3;

    // BUG FIX (this pass, "Revenue Center Connectivity" -- reported: gray
    // preprinted hexes with a city/town marker and a NON-opposite 2-edge
    // pair render with the track visibly missing the marker at center).
    // Root cause: `arcTo(center, end, radius)` is a rounded-CORNER
    // primitive -- by construction it is tangent to, but never actually
    // touches, its own corner point for any `radius > 0`. The previous
    // `curveRadius = size * 0.6` made this far worse than a small visual
    // offset: the tangent length from the corner along each ray is `t =
    // radius / tan(angle / 2)`, and for this file's common 60-degree
    // adjacent-edge pairs (e.g. Cleveland/Montreal/Lansing/Atlantic City/
    // Fall River's edge pairs are all 60 degrees apart), `t ≈ 1.04 * size`
    // -- LONGER than the `apothem ≈ 0.866 * size` edge-to-center segment
    // itself, so the requested tangent point doesn't even exist within the
    // hex; the resulting arc genuinely does not approach center at all.
    // Even the one 120-degree case in this file (Kingston, C15) only
    // brings the curve to within `~0.09 * size` of center -- inside a
    // "town" dit's radius but not a "city" station's, and not a reliable
    // margin either way. Fixed the same way item 6 already fixed this
    // function's 1-edge and 3+-edge cases: two independent
    // `quadraticCurveTo` bends, edge-to-center and center-to-edge, each
    // with an explicit, guaranteed-exact endpoint at `center.x, center.y`
    // -- so the track always visibly connects to the marker drawn there,
    // while still reading as curved (not a sharp straight "V") through the
    // shared vertex. `isOpposite` keeps its own true straight-line case
    // unchanged (a real opposite pair is already exactly collinear through
    // center, so it never had this bug).
    if (isOpposite) {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    } else {
      // Rail Map Overhaul (design note #42): two perpendicular-entering
      // cubic-Bezier halves via `bezierTrackSegment`, replacing the
      // previous `quadraticCurveTo`-based `curveHalf` closure -- same
      // "guaranteed-exact endpoint at center" property this BUG FIX
      // originally required.
      bezierTrackSegment(ctx, start, center, size, edgeInwardNormal(a), null);
      bezierTrackSegment(ctx, center, end, size, null, edgeInwardNormal(b));
    }

    // Bypass fork: a second, independent curve between the SAME two edges
    // that loops well clear of the station circle at center (radius
    // `size * 0.22`, per `drawStationCircle`) rather than passing through
    // it -- only meaningful for a true opposite pair, since a non-opposite
    // pair's main route already curves away from center on its own. The
    // control point offset (`size * 0.8`, perpendicular to the start->end
    // chord) puts the curve's own peak deviation from that chord at roughly
    // half that -- `size * 0.4` -- comfortably outside the station circle
    // plus its stroke width, while staying inside the hex's own apothem
    // (`size * 0.866`) so the fork never bleeds into a neighboring hex.
    if (bypass && isOpposite) {
      // Rail Map Overhaul (design note #42): converted to `ctx.bezierCurveTo`
      // via the standard quadratic-to-cubic control-point elevation (`cp1 =
      // start + 2/3*(q - start)`, `cp2 = end + 2/3*(q - end)`) -- this
      // produces the EXACT SAME curve the single quadratic control point `q`
      // did, so the fork's already-verified "clears the station circle,
      // stays inside the hex" geometry is unchanged; only the drawing API
      // is. Left as its own dedicated wide loop (not `bezierTrackSegment`'s
      // perpendicular-normal profile) since this fork's whole purpose is to
      // swing FAR off the direct chord to avoid the station circle, not to
      // read as a perpendicular edge crossing.
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = size * 0.8;
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const qx = midX + (-dy / len) * bend;
      const qy = midY + (dx / len) * bend;
      const cp1x = start.x + (2 / 3) * (qx - start.x);
      const cp1y = start.y + (2 / 3) * (qy - start.y);
      const cp2x = end.x + (2 / 3) * (qx - end.x);
      const cp2y = end.y + (2 / 3) * (qy - end.y);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, end.x, end.y);
      ctx.stroke();
    }
  } else if (sorted.length >= 3) {
    // Item 6: each spoke bends gently into center (all bowed the same
    // rotational direction, so they read as one coherent curved junction)
    // instead of straight radial lines converging on the station. Rail Map
    // Overhaul (design note #42): perpendicular-entering cubic Bezier
    // (`bezierTrackSegment`) instead of the previous `quadraticCurveTo`.
    for (const edge of sorted) {
      const point = edgePoint(edge);
      bezierTrackSegment(ctx, point, center, size, edgeInwardNormal(edge), null);
    }
  }

  if (marker === "city") {
    drawStationCircle(ctx, markerPoint, size);
  } else if (marker === "town") {
    // Item 8 ("Distinct Dark Small Towns"): dark dit marker, not a white
    // circle -- see `drawDitMarker`'s own doc comment.
    drawDitMarker(ctx, markerPoint, size);
  }
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
function drawOOCityMarkers(
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
function stationMarkerPoint(
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
    // Index 1: bottom-left circle, mirrors `drawOOCityMarkers`'s own
    // placement -- both now read from the same `twoNodePositions` tuple
    // (design note #58) instead of hand-deriving the offset here.
    return twoNodePositions(center, size)[1];
  }
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  const landmarkSegments = landmark ? LANDMARK_TRACKS[landmark.name] : undefined;
  if (landmarkSegments && landmarkSegments.length >= 2) {
    // Structural "two real disconnected stub stations" signature (today,
    // only New York) -- Node Index 0 is always the canonical Top-Right/NE
    // node, matching `drawLandmarkTrack`'s own segment-index-0 anchor below
    // exactly (design note #56), both now reading from the same
    // `twoNodePositions` tuple (design note #58).
    return twoNodePositions(center, size)[0];
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
function drawStationTokenMarker(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  size: number,
  ticker: string,
  color: string,
  muted: boolean,
): void {
  const radius = size * 0.22;

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

  // Solid Corporate Brand Color Borders (design note #48, tone updated by
  // #116 above): the ring is still the corporation's own brand `color`, at
  // the same fixed, un-scaled `1.75px` (within the original 1.5px-2px
  // request) reserved/unfloated badges have used since #48 -- deliberately
  // NOT `size`-scaled like most of this file's other stroke widths, so it
  // reads as a thin, consistent ring at every zoom level. Floated badges'
  // own outline (`#f4ecd8`, solid, size-scaled) is unchanged.
  ctx.strokeStyle = muted ? color : "#f4ecd8";
  ctx.lineWidth = muted ? 1.75 : Math.max(2, size * 0.05);
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
  ctx.font = fitFontSize(ctx, ticker, 11, radius * 1.7, 9, "bold");
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
function drawMountainIcon(
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
function drawRiverIcon(
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
function drawWaveStrand(
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
function drawTerrainIcon(
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
const TERRAIN_ICON_SIZE_RATIO: Readonly<Record<"Mountain" | "River", { width: number; height: number }>> = {
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
const COMPOUND_BADGE_SHRINK = 0.65;

function drawTerrainCompoundBadge(
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
function fillTextWithHalo(
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
function fillRoundedRect(
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
function drawLabelWithBackground(
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
const FONT_FAMILY_STACK = "system-ui, -apple-system, sans-serif";

function fitFontSize(
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
const NAMEPLATE_FONT_SIZE_PX = 8;
const NAMEPLATE_FONT_MIN_PX = 6;
/** Design note #51: `lineHeight = 1.05 * fontSize`, per the request's own
 *  explicit formula -- each stacked line offsets `NAMEPLATE_LINE_HEIGHT_PX
 *  / 2` above/below true center, so consecutive line centers sit exactly
 *  one `lineHeight` apart. Derived from `NAMEPLATE_FONT_SIZE_PX` (not
 *  `hexSize`, unlike the OLD `hexSize * 0.19`/`0.24` offsets it replaces)
 *  so the stack's own compactness tracks the now-fixed font size rather
 *  than the hex's zoom-dependent pixel size. */
const NAMEPLATE_LINE_HEIGHT_PX = NAMEPLATE_FONT_SIZE_PX * 1.05;
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
const NAMEPLATE_SHIELD_FILL = "rgba(255, 255, 255, 0.55)";
const NAMEPLATE_SHIELD_FILL_HOVERED = "rgba(255, 255, 255, 1.0)";

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
function drawHexNameLabel(
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
function drawStackedNameLabel(
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
function drawSingleNodeNameplate(
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
function offboardNameplateLines(offboardName: string): readonly string[] {
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
function drawOffboardTooltip(
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
function parseColumnNumber(label: string): number | null {
  const match = /^[A-Z]+(\d+)$/.exec(label);
  return match ? Number(match[1]) : null;
}

/** Real board row letters, one per axial row index `r` -- row A (`r = 0`)
 *  through row K (`r = 10`), matching every real hex `label` in
 *  `STATIC_BOARD_HEXES` exactly (see design note #6's row-letter/column-
 *  number -> axial transform, which this is the direct inverse of for the
 *  row half). */
function rowLetterForR(r: number): string {
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
function computeBoardMarginLabels(
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
function drawBoardMarginLabels(ctx: CanvasRenderingContext2D, hexSize: number): void {
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

/* ------------------------------------------------------------------ */
/* Tile preview thumbnail -- for TileSelectionPopup.tsx (design note #7) */
/* ------------------------------------------------------------------ */

export interface TilePreviewThumbnailProps {
  tileId: number;
  /** Legal orientation angle (0-5) to preview -- see design note #7's
   *  orientation-cycling limitation. Default 0 (the lowest legal
   *  orientation, which is also always what the contract itself will
   *  auto-pick for a given `tile_id`). */
  orientation?: number;
  /** Overall canvas size in CSS pixels (square). Default 96. */
  size?: number;
  /** Hex radius used to render the tile within the canvas. Default 40. */
  hexSize?: number;
  className?: string;
}

/** A small, self-contained canvas that renders exactly one catalog tile in
 *  isolation -- terrain fill, color-tier outline, and its decoded track
 *  path at the given `orientation` -- reusing this file's own
 *  `TILE_CATALOG_BY_ID`/`drawHexPath`/`drawTrackPath` rather than a second
 *  hand-kept catalog mirror (see design note #2's "DESIGN GAP" discipline).
 *  Built for `TileSelectionPopup.tsx`'s carousel thumbnails and its larger
 *  rotation preview; has no wallet/session/query dependency of its own,
 *  matching this file's presentational-only design. */
export function TilePreviewThumbnail({
  tileId,
  orientation = 0,
  size = 96,
  hexSize = 40,
  className,
}: TilePreviewThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const center = { x: size / 2, y: size / 2 };
    const catalogEntry = TILE_CATALOG_BY_ID.get(tileId);

    drawHexPath(ctx, center, hexSize);
    ctx.fillStyle = catalogEntry ? ERA_TILE_FILL[catalogEntry.color] : "#dddddd";
    ctx.fill();
    ctx.strokeStyle = catalogEntry ? COLOR_TIER_STROKE[catalogEntry.color] : "#9a9a9a";
    ctx.lineWidth = 2;
    ctx.stroke();

    if (catalogEntry) {
      // Rail Map Overhaul (design note #42): Hex Boundary Clipping Mask.
      withHexClip(ctx, center, hexSize, () => {
        // Mirror-only, by construction (design note #119): this component
        // renders an UN-LAID tile in the picker carousel and has no query
        // row for it -- see this file's `pathsForTile`. It is also the
        // reason the mirror carries `paths` at all rather than the backend
        // being the single source: a tile has to render correctly before it
        // exists on the board.
        drawTrackPath(ctx, center, hexSize, catalogEntry, orientation);
      });
    } else {
      // Unknown tile_id -- see design notes #2/#118 -- same generic
      // provisional artwork as the main board renderer, rather than
      // silently drawing nothing. This path matters more here than on the
      // board: `TileSelectionPopup`'s carousel renders one of these per
      // legal placement the contract returned, so an id this mirror hasn't
      // caught up to is still a real, clickable, submittable choice and
      // needs to at least show its own number.
      withHexClip(ctx, center, hexSize, () => {
        drawUnknownTilePlaceholder(ctx, center, hexSize, tileId);
      });
    }

    ctx.restore();
  }, [tileId, orientation, size, hexSize]);

  return <canvas ref={canvasRef} style={{ width: size, height: size }} className={className} />;
}

export default HexGridRenderer;
