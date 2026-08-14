// frontend/src/components/hexGeometry.ts
//
// PHASE 3 of the `HexGridRenderer.tsx` monolith extraction.
//
// WHAT THIS IS. Everything that answers a question about WHERE something is
// on the board, without drawing any of it:
//
//   - the pointy-top axial coordinate system (`axialToPixel`, `pixelToAxial`,
//     `axialRound`, `edgeAngleRad`, `cornerAngleRad`, `pointOnCircle`,
//     `HEX_NEIGHBOR_OFFSETS`);
//   - board topology (`boardHexExistsAt`, `deadEdgesAt`, `rotateConnections`,
//     `liveEdges`, `liveEdgesForHex`, `hexHasLaidTile`);
//   - the hex ARCHETYPE classifier (`archetypeForTerrain`, `archetypeForHex`)
//     that decides how many station nodes a hex has;
//   - the 13-SLOT PERIMETER ENGINE -- `hexSlotPoint`, `hexBlockedSlots`,
//     `pickHexSlot`, `claimHexSlot` and the override/force/reserve tables
//     layered over it -- which is what stops nameplates, revenue badges,
//     terrain costs and restriction labels from landing on top of one another
//     or on top of track;
//   - node coordinates (`doubleNodeOffset`, `twoNodePositions`,
//     `singleNodeNameplateAnchor`);
//   - and the naming/valuation lookups that read a hex rather than paint it
//     (`describeHex`, `describeHexWithValue`, `terrainBaseValue`,
//     `hexRouteValue`).
//
// No canvas, no React, no DOM. Not one function here takes a
// `CanvasRenderingContext2D`.
//
// WHY THIS ORDER. Strictly leaf-first, as with every phase: this module reads
// `hexBoardData` (Phase 2), `hexTileCatalog` (Phase 1) and `hexContractTypes`
// (Phase 3a), and nothing reads it except the renderer itself. Phase 3a
// existed purely to make this possible -- the slot engine takes
// `MapGridResponse` and `StationTokenCompany[]`, so those types had to move
// out of the renderer first or this import would have been a cycle.
//
// THE SLOT ENGINE IS THE REASON THIS FILE IS WORTH HAVING. It is roughly a
// thousand lines of placement logic with four layered override mechanisms,
// and every one of them exists because a real label collided with something
// on a real hex. Read the numbered design notes in
// `./HexGridRenderer.design-notes.md` before changing any of it; the tables
// look arbitrary and are not.
//
// IMPORT DIRECTION IS ONE-WAY: never import from `HexGridRenderer.tsx`.

import {
  GRAY_HEXES,
  HEX_START_VALUE_OVERRIDE,
  LANDMARK_HEXES,
  LANDMARK_TRACKS,
  NAMED_HEX_LABELS,
  OFFBOARD_LABELS,
  OFFBOARD_REVENUE,
  OFFBOARD_TRACKS,
  STATIC_BOARD_HEXES,
  YELLOW_OO_HEXES,
  offboardValueForEra,
  terrainBuildFeeAt,
} from "./hexBoardData";
import { TILE_CATALOG, TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import type { TerrainType, TileColorTier } from "./hexTileCatalog";
import type {
  LegalTilePlacement,
  MapGridResponse,
  StationTokenCompany,
} from "./hexContractTypes";

/* ------------------------------------------------------------------ */
/* Hex geometry (pointy-top axial) -- see design note #1              */
/* ------------------------------------------------------------------ */

/** Pointy-top axial `(q, r)` -> pixel center, standard conversion. */
export function axialToPixel(q: number, r: number, size: number): { x: number; y: number } {
  return {
    x: size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    y: size * (1.5 * r),
  };
}

/** Edge `i`'s direction angle, in radians, from a tile's center -- see
 *  design note #1 for why this is `-60 * i`, not `+60 * i`. */
export function edgeAngleRad(edgeIndex: number): number {
  return (-60 * edgeIndex * Math.PI) / 180;
}

/** Hexagon corner `i`'s direction angle, in radians -- offset 30deg ahead
 *  of edge `i`'s own angle, so corner `i` and corner `(i + 1) % 6` flank
 *  edge `i` on either side. */
export function cornerAngleRad(cornerIndex: number): number {
  return ((30 - 60 * cornerIndex) * Math.PI) / 180;
}

export function pointOnCircle(
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
export const HEX_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
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
export function boardHexExistsAt(q: number, r: number): boolean {
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
export function deadEdgesAt(q: number, r: number): number[] {
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
export function marginLabelFontSize(hexSize: number): number {
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
export function marginLabelReserve(hexSize: number): number {
  const fontSize = marginLabelFontSize(hexSize);
  return fontSize * 1.4 + MARGIN_LABEL_BACKGROUND_PADDING_PX + MARGIN_LABEL_EXTRA_INSET_PX;
}

/** Rotates a 6-bit edge bitmask by `orientation` steps (0-5) -- a direct
 *  TypeScript port of `hexmap::rotate_connections`, kept bit-for-bit
 *  identical so a laid tile's actual on-screen edges always match what
 *  the contract itself considers "live" at that orientation. */
export function rotateConnections(mask: number, orientation: number): number {
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
export function localCatalogPlacements(): LegalTilePlacement[] {
  const placements: LegalTilePlacement[] = [];
  for (const entry of TILE_CATALOG) {
    for (let orientation = 0; orientation < 6; orientation++) {
      placements.push({ tile_id: entry.tileId, orientation });
    }
  }
  return placements;
}

export function liveEdges(mask: number): number[] {
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
export function pixelToAxial(x: number, y: number, size: number): { q: number; r: number } {
  const qFrac = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const rFrac = ((2 / 3) * y) / size;
  return axialRound(qFrac, rFrac);
}

/** Standard cube-coordinate rounding: converts fractional axial `(q, r)` to
 *  cube `(x, y, z)` with `x + y + z === 0`, rounds each axis independently,
 *  then re-derives whichever axis had the largest rounding error from the
 *  other two so the zero-sum invariant still holds -- the textbook
 *  "which hex is under this pixel" hit-testing algorithm. */
export function axialRound(qFrac: number, rFrac: number): { q: number; r: number } {
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
export function hexHasLaidTile(mapGrid: MapGridResponse, q: number, r: number): boolean {
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
export function archetypeForTerrain(terrain: TerrainType): HexArchetype {
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
export function archetypeForHex(mapGrid: MapGridResponse, q: number, r: number): HexArchetype {
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

export const EDGE_SLOT_TO_EDGE_INDEX: readonly number[] = [1, 0, 5, 4, 3, 2];
// slot 1 = Top-Right (edge 1/NE)      slot 4 = Bottom-Left (edge 4/SW)
// slot 2 = Right/Vertical (edge 0/E)  slot 5 = Left/Vertical (edge 3/W)
// slot 3 = Bottom-Right (edge 5/SE)   slot 6 = Top-Left (edge 2/NW)

export const CORNER_SLOT_TO_CORNER_INDEX: readonly number[] = [2, 1, 0, 5, 4, 3];
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
export function hexSlotPoint(center: { x: number; y: number }, size: number, slot: number): { x: number; y: number } {
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
export function hexSlotDirection(slot: number): { x: number; y: number } {
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
export function cornerSlotGuardEdges(slot: number): readonly [number, number] {
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
export function slotsBlockedByEdges(edgeIndices: readonly number[], centerBlocked: boolean): Set<number> {
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
export function liveEdgesForHex(mapGrid: MapGridResponse, q: number, r: number): number[] {
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
export function hexBlockedSlots(mapGrid: MapGridResponse, q: number, r: number): Set<number> {
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
export const SLOT_ANGLE_DEG: readonly (number | undefined)[] = [
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
export const MIN_SLOT_ANGULAR_SEPARATION_DEG = 120;

/** The shortest angular distance (0-180 degrees) between perimeter slots
 *  `a` and `b`. Slot 0 (center) has no angle (`SLOT_ANGLE_DEG[0]` is
 *  `undefined`) and is always treated as maximally separated from
 *  everything -- it's a distinct location, not a competing point on the
 *  same 30-degree ring, so it never counts as "crowding" a perimeter
 *  slot or vice versa. */
export function slotAngularSeparationDeg(a: number, b: number): number {
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
export function angularConflictSlots(claimedSlots: ReadonlySet<number>): Set<number> {
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
export function pickFromCandidates(
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
export function pickHexSlot(
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
export function extendSlotPreference(
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
export function claimHexSlot(
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
export const HEX_SLOT_OVERRIDE: Readonly<
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
export function resolveSlotOverride(
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
export function claimHexSlotPreferring(
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
export const HEX_SLOT_FORCE: Readonly<
  Record<string, { nameplate?: number; terrain?: number; revenue?: number; restriction?: number }>
> = {
  "9,4": { nameplate: 10 }, // E23 Boston -- forced to Vertex 3, ignoring its real SE track stub
};

export function claimHexSlotForced(claimed: Map<string, Set<number>>, q: number, r: number, slot: number): number {
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
export const HEX_SLOT_RESERVE: Readonly<
  Record<string, { for: "nameplate" | "terrain" | "revenue" | "restriction"; slot: number }>
> = {
  "9,4": { for: "revenue", slot: 12 }, // E23 Boston -- reserves Vertex 5 for the revenue badge
};

export function withSlotReserve(
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
export function doubleNodeOffset(size: number): { x: number; y: number } {
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
export function twoNodePositions(
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
export const NAMEPLATE_SLOT_PREFERENCE: readonly number[] = [0, 7, 10, 12, 8, 11, 9, 6, 1, 5, 2, 4, 3];

export function singleNodeNameplateAnchor(
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
export function describeHex(q: number, r: number): string {
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
export function describeHexDesignationForLog(
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
export function terrainBaseValue(terrain: TerrainType): number {
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
export function hexRouteValue(q: number, r: number, mapGrid: MapGridResponse): number | null {
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
export function describeHexWithValue(
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
