// frontend/src/components/hexGeometry.ts
//
// PHASE 3 of the HexGridRenderer monolith split: everything that answers a
// question about WHERE something is on the board, without drawing any of it --
// the pointy-top axial system, board topology, the hex ARCHETYPE classifier,
// the 13-SLOT PERIMETER ENGINE, node coordinates, and the naming/valuation
// lookups. No canvas, no React, no DOM.
//
// THE SLOT ENGINE IS THE REASON THIS FILE IS WORTH HAVING: ~1,000 lines of
// placement logic with four layered override mechanisms, and every one exists
// because a real label collided with something on a real hex. The tables look
// arbitrary and are not -- read docs/ai_architecture/hex_tile_math.md first.
//
// IMPORT DIRECTION IS ONE-WAY: never import from HexGridRenderer.tsx.

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
import { corporationLabel } from "../utils/corporationNames";
import { TILE_CATALOG, TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import type { TerrainType, TileColorTier } from "./hexTileCatalog";
import type {
  HexClickRejection,
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

/** Byte-for-byte the same six deltas as hexmap::HEX_NEIGHBOR_OFFSETS -- design note #1's own source for the -60*i edge-angle derivation, finally given a named constant.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #1 */
export const HEX_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Landmarks and static hexes together are the complete 93-hex board. An off-board hex COUNTS as existing -- it is a real drawn entry track legally runs to; what this excludes is a coordinate with no hex at all.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #6 */
export function boardHexExistsAt(q: number, r: number): boolean {
  return (
    LANDMARK_HEXES.some((l) => l.q === q && l.r === r) ||
    STATIC_BOARD_HEXES.some((h) => h.q === q && h.r === r)
  );
}

/** An edge whose neighbouring coordinate is not a real hex can NEVER carry live track from either side, for any tile, ever -- a permanently stronger guarantee than "not currently live", which is what lets a badge prefer parking beside one.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #39 */
export function deadEdgesAt(q: number, r: number): number[] {
  const dead: number[] = [];
  for (let edge = 0; edge < 6; edge++) {
    const [dq, dr] = HEX_NEIGHBOR_OFFSETS[edge];
    if (!boardHexExistsAt(q + dq, r + dr)) dead.push(edge);
  }
  return dead;
}

// The camera fit and the label placement must agree on how much room is reserved beyond each edge hex's corner: reserve too little and labels clip, reserve less than the corner-to-label distance and they render ON TOP of the outermost hex.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #28
export const MARGIN_LABEL_BACKGROUND_PADDING_PX = 4;
export const MARGIN_LABEL_EXTRA_INSET_PX = 8;

/** The exact font size `drawBoardMarginLabels` renders margin labels at --
 *  a single shared formula so nothing else has to re-derive or guess it. */
export function marginLabelFontSize(hexSize: number): number {
  return Math.max(11, hexSize * 0.3);
}

/** An ESTIMATE, because no canvas context exists where the camera bounds are computed -- it only has to be generous enough that the exact measureText pass never needs more. Two-character column numbers are the widest labels the board draws.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #28 */
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

/* rotatePaths and pathsForTile removed with the generalized double-town renderer DOUBLE_TOWN_ROUTES replaced. The contract still sends paths and the mirror still carries it -- the mirror now feeds the drift tripwire.
   See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #121 */

/** No longer filters by era: a fresh offline session showed twelve Yellow tiles and nothing else, with no way to reach the other thirty-four. Offline mode exists to INSPECT the catalog, so filtering moved to a view control the player can change. This weakens no rule, because it was never enforcing one.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #125 */
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

/** Inverse of axialToPixel plus cube rounding. Coordinates must already have the canvas pan/zoom divided out by the caller.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #1 */
export function pixelToAxial(x: number, y: number, size: number): { q: number; r: number } {
  const qFrac = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const rFrac = ((2 / 3) * y) / size;
  return axialRound(qFrac, rFrac);
}

/** Standard cube rounding: round each axis, then re-derive whichever had the largest error so the zero-sum invariant still holds.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #1 */
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

/** Physical-board parity -- a laid tile covers the printed name. Shares the exact lookup this file's other mapGrid-aware passes use rather than a new pattern. Not applied to off-board zones, which can never receive a tile.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #47 */
export function hexHasLaidTile(mapGrid: MapGridResponse, q: number, r: number): boolean {
  return mapGrid.tiles.some((tile) => tile.q === q && tile.r === r);
}

/** THE CONSERVATISM RULE, which matters more than the gates: only ever block what is DEFINITELY illegal. A false allow costs a rejected transaction; a false block makes a legal move look impossible and is invisible, unreportable, and indistinguishable from the feature working. So every gate is a rule the contract states unconditionally, and anything stateful stays with the contract.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #141 */

export interface HexClickEligibility {
  eligible: boolean;
  reason: HexClickRejection | null;
  /** Player-facing, written to explain rather than merely refuse. `null`
   *  when eligible, and also when the reason is `"not-a-hex"` -- see
   *  `evaluateHexForTileLaying` for why that one says nothing. */
  message: string | null;
  hexLabel: string;
}

const ELIGIBLE: Omit<HexClickEligibility, "hexLabel"> = {
  eligible: true,
  reason: null,
  message: null,
};

/** Mirrors hexmap::next_tile_color, including the part that does the work: Brown returns none, which is what makes AlreadyMaxColor fire.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #141 */
export function nextTileColorTier(tier: TileColorTier): TileColorTier | null {
  switch (tier) {
    case "Yellow":
      return "Green";
    case "Green":
      return "Brown";
    case "Brown":
      return null;
  }
}

/** Checks COLOUR only, not terrain compatibility -- the contract's upgrade rule tests the colour step and edge superset and does NOT require terrain to match, so filtering by terrain would block upgrades it would accept. Precisely the false block the conservatism rule forbids.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #141 */
function catalogHasTierAbove(tier: TileColorTier): boolean {
  const next = nextTileColorTier(tier);
  if (next === null) return false;
  return TILE_CATALOG.some((entry) => entry.color === next);
}

/** Pure and synchronous -- every input is static board data plus the already-fetched grid. A stale or empty grid can only make this MORE permissive, which is the correct direction to fail.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #141 */
export function evaluateHexForTileLaying(
  q: number,
  r: number,
  mapGrid: MapGridResponse,
): HexClickEligibility {
  /* ---- Gate 1: is this a hex at all? ---- */
  const boardHex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (!boardHex) {
    // No message on purpose: clicking blank space is not an error a player made, and reporting it would flash a tooltip every time someone clicked the background to dismiss something.
    // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #141
    return { eligible: false, reason: "not-a-hex", message: null, hexLabel: describeHex(q, r) };
  }

  const hexLabel = boardHex.label;

  /* ---- Gate 2a: red off-board terminals ---- */
  if (boardHex.type === "RedOffboard") {
    return {
      eligible: false,
      reason: "offboard",
      message: `${hexLabel} is a red off-board area. It is a revenue destination, not a buildable hex — no tile can ever be laid here.`,
      hexLabel,
    };
  }

  // Both tables are consulted because they were populated in separate passes, and requiring only one to be right would make the gate depend on which pass a hex was added in.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #141
  if (boardHex.printedColor === "Gray" || GRAY_HEXES[hexLabel] !== undefined) {
    return {
      eligible: false,
      reason: "gray-immutable",
      message: `${hexLabel} is a preprinted gray hex. Gray hexes are permanently fixed — their track can never be replaced or upgraded.`,
      hexLabel,
    };
  }

  /* ---- Gate 3: terminal tier ---- */
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laid) {
    const entry = TILE_CATALOG_BY_ID.get(laid.tile_id);
    // An id the catalog mirror has not caught up to is ALLOWED through.
    // The mirror is hand-kept (design note #2) and can lag the backend, and
    // treating "I do not recognise this tile" as "this tile is finished"
    // would silently freeze every hex holding a newly added tile.
    if (entry) {
      const next = nextTileColorTier(entry.color);
      if (next === null || !catalogHasTierAbove(entry.color)) {
        return {
          eligible: false,
          reason: "max-tier",
          message: `${hexLabel} already holds tile #${laid.tile_id}, which is ${entry.color} — the top colour tier. There is no further upgrade for this hex.`,
          hexLabel,
        };
      }
    }
  }

  return { ...ELIGIBLE, hexLabel };
}

/** THE RULE: no rendering code may branch on a specific hex's label/name/(q,r) literal to decide WHERE something is drawn -- only on structural data that classifies identically for any hex with the same real properties. Genuine per-hex DATA is not a hack; every board game has per-hex facts. What changes is that no PLACEMENT FORMULA is keyed off identity.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #55 */
export type HexArchetype = "SingleCity" | "DoubleCity" | "SingleTown" | "DoubleTown" | "Plain";

/** Terrain maps to archetype purely by what KIND of city it draws. MajorCityHub and BostonHub share SingleCity because both draw one node -- Boston's hub also carries a label restriction, a legality concern unrelated to layout.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #55 */
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

/** A laid tile's REAL terrain wins; otherwise the hex's static category. Every branch reads a structural field -- a set membership, an enum tag, an array length -- rather than a name, so adding a hex to any table classifies correctly with no change here.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #55 */
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
  // A landmark's unlaid archetype is read off the STRUCTURE of its own printed track: two independent stub segments means two stations. Any future landmark with the same shape classifies identically without touching this function.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #55
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    const segments = LANDMARK_TRACKS[landmark.name] ?? [];
    return segments.length >= 2 ? "DoubleCity" : "SingleCity";
  }
  return "Plain";
}

// Thirteen slots: 0 centre, 1-6 edge midpoints clockwise from Top-Right, 7-12 corner vertices clockwise from the Top Point. The permutation tables were verified by hand against every one of the old BADGE_CORNERS guardEdges entries. SCOPE: labels and badges only -- station node coordinates keep their own formulas.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #70

export const EDGE_SLOT_TO_EDGE_INDEX: readonly number[] = [1, 0, 5, 4, 3, 2];
// slot 1 = Top-Right (edge 1/NE)      slot 4 = Bottom-Left (edge 4/SW)
// slot 2 = Right/Vertical (edge 0/E)  slot 5 = Left/Vertical (edge 3/W)
// slot 3 = Bottom-Right (edge 5/SE)   slot 6 = Top-Left (edge 2/NW)

export const CORNER_SLOT_TO_CORNER_INDEX: readonly number[] = [2, 1, 0, 5, 4, 3];
// slot 7 = Top Point (corner 2)       slot 10 = Bottom Point (corner 5)
// slot 8 = Upper-Right (corner 1)     slot 11 = Lower-Left (corner 4)
// slot 9 = Lower-Right (corner 0)     slot 12 = Upper-Left (corner 3)

/** The raw geometric reference point. Most passes do NOT draw exactly here -- each keeps its own tuned magnitude and takes only the direction.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #109 */
export function hexSlotPoint(center: { x: number; y: number }, size: number, slot: number): { x: number; y: number } {
  if (slot === 0) return center;
  if (slot >= 1 && slot <= 6) {
    const apothem = size * (Math.sqrt(3) / 2);
    return pointOnCircle(center, apothem, edgeAngleRad(EDGE_SLOT_TO_EDGE_INDEX[slot - 1]));
  }
  return pointOnCircle(center, size, cornerAngleRad(CORNER_SLOT_TO_CORNER_INDEX[slot - 7]));
}

/** The unit direction, so a caller keeps its own magnitude convention while still using this system's occupancy-aware slot selection.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #109 */
export function hexSlotDirection(slot: number): { x: number; y: number } {
  if (slot === 0) return { x: 0, y: 0 };
  return hexSlotPoint({ x: 0, y: 0 }, 1, slot);
}

/** The two edges flanking a corner slot, verified against all four of the old hand-encoded guardEdges pairs and reproduced exactly by (cornerIndex+5)%6, cornerIndex.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #70 */
export function cornerSlotGuardEdges(slot: number): readonly [number, number] {
  const cornerIndex = CORNER_SLOT_TO_CORNER_INDEX[slot - 7];
  return [(cornerIndex + 5) % 6, cornerIndex];
}

/** An edge slot is unusable if that edge is live; a CORNER slot if EITHER guard edge is, because a curve between adjacent live edges bows toward the corner between them. Centre is marked by the caller -- it is not a pure function of an edge set.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #70 */
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

/** Live edges from whichever real source applies, mirroring archetypeForHex's exact fallback order so the two always agree on which hex they are describing.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #70 */
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

/** Centre is occupied by a Single-archetype's always-central circle, OR by track passing through it -- but NEVER on a DoubleCity/DoubleTown hex, which routes track to its own off-centre nodes by construction. Which is exactly why every OO and double-town nameplate already renders dead-centre.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #70 */
export function hexBlockedSlots(mapGrid: MapGridResponse, q: number, r: number): Set<number> {
  const archetype = archetypeForHex(mapGrid, q, r);
  const edges = liveEdgesForHex(mapGrid, q, r);
  const isDoubleArchetype = archetype === "DoubleCity" || archetype === "DoubleTown";
  const centerBlocked =
    archetype === "SingleCity" || archetype === "SingleTown" || (edges.length > 0 && !isDoubleArchetype);
  return slotsBlockedByEdges(edges, centerBlocked);
}

/** Every perimeter slot sits at a fixed 30-degree increment, hand-derived from the edge/corner angle math and verified for all twelve. Slot 0 has no angle and is always treated as compatible.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #104 */
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

/** 120 degrees. Slot 10 and slot 9 are only 60 apart and read as crowded; slot 10 and slot 7 are exactly opposite and read as cleanly separated.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #104 */
export const MIN_SLOT_ANGULAR_SEPARATION_DEG = 120;

/** Slot 0 is a distinct location, not a competing point on the same ring, so it never counts as crowding a perimeter slot or vice versa.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #104 */
export function slotAngularSeparationDeg(a: number, b: number): number {
  const angleA = SLOT_ANGLE_DEG[a];
  const angleB = SLOT_ANGLE_DEG[b];
  if (angleA === undefined || angleB === undefined) return 180;
  const diff = Math.abs(angleA - angleB) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Flags slots that are not literally taken but would still visually crowd an existing claim. A no-op until a hex is genuinely crowded enough to have multiple claims.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #104 */
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

/** Runs the tier search STRICTLY within the given candidates, so pickHexSlot can exhaust the caller's real preference list before ever touching the fallback tail -- see #106 for why the two must never be searched as one flat scan.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #106 */
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

/** Four tiers, plus #104's angular separation folded in as a soft-avoid tried FIRST, degrading gracefully if nothing can satisfy both. #106: the fallback tail can no longer outrank an available primary-preference slot merely by sitting next to a dead edge.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #106 */
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

/** Computes the fallback TAIL by itself, returned separately rather than concatenated. Order among the tail encodes no preference -- by the time a search reaches it every preferred slot is unavailable. A caller that can only draw at corners passes CORNER_SLOTS as the pool.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #106 */
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

/** CROSS-PASS CLAIMING: one ledger per render, threaded through every pass in draw order. G19's two stub edges block four of its six corners, leaving two open -- and three passes all independently picked the same one. #104 also steers new claims away angularly.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #72 */
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

/** Per-hex explicit overrides for the small set where a request asked for a specific canonical vertex, rather than a change to the board-wide order that would ripple into every other hex sharing that pass. Every entry was HAND-VERIFIED against the hex's real live edges; two are genuinely blocked and degrade, kept as accurate documentation.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #106 */
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

/** withSlotOverride SUPERSEDED: prepending onto the preference list let a merely dead-edge-adjacent slot elsewhere in that list leapfrog the override itself. Left defined, unused, per this file's convention. resolveSlotOverride also yields to a reservation for a different pass.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #111 */
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

/** An explicit override is a deliberate placement and should give way ONLY to a genuine collision -- never to the tier list's own dead-edge heuristic, which exists to break ties among equally acceptable candidates, not to outrank a slot the caller asked for. Tries the slot directly, bypassing tiers and angular soft-avoidance.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #111 */
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

/** A FORCE always wins: no track check, no claimed check, nothing. For "put it here so I can see how it looks" requests, where the point is to bypass the collision machinery on purpose. Still RECORDED, so other passes steer clear. A separate table from the override so the two stay semantically distinct.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #115 */
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

/** Reserves one slot on a hex for one specific pass, so an EARLIER-running pass's graceful fallback cannot claim it first purely by going first.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #106 */
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

/** REPLACED WHOLESALE by #73: the old diagonal resolved to -30.17 degrees, 0.17 off a hex VERTEX, when the real board puts each node on an EDGE MIDPOINT. Edges 1 and 4 are exactly opposite, so the +/- structure needed no change -- only the vector. #77 pulled the magnitude to 0.50 so the short real track stub connecting edge to station stays visible.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #77 */
export function doubleNodeOffset(size: number): { x: number; y: number } {
  const magnitude = size * 0.5;
  return pointOnCircle({ x: 0, y: 0 }, magnitude, edgeAngleRad(1));
}

/** THE single shared 2-node helper. Every call site indexes into the SAME tuple by its own existing city/segment index -- no re-sorting, no sign-flipped arithmetic re-derived locally, and therefore no opportunity to swap which physical corner an index lands on.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #58 */
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

// The single-node nameplate anchor, dynamically slot-aware since #70 while keeping #55's tuned wedge magnitude. #105 moved Upper-Left off first place in favour of centre, top vertex, bottom vertex.
// See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #105
export const NAMEPLATE_SLOT_PREFERENCE: readonly number[] = [0, 7, 10, 12, 8, 11, 9, 6, 1, 5, 2, 4, 3];

export function singleNodeNameplateAnchor(
  center: { x: number; y: number },
  size: number,
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  // Nameplates were never migrated off the raw pickHexSlot call, so they stayed invisible to every other pass's claims -- which let a nameplate and a restriction badge land on the exact same corner on Baltimore.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #74
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

/** THE DISPLAY NAME IS NOT THE HEX'S IDENTITY. A human string looks correct in every message it appears in while failing every lookup and wire payload -- which is exactly what priced a whole manual route at $0 and would have been rejected on chain. Anything that INDEXES, COMPARES or TRAVELS uses the identifier.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #242 */
const BOARD_COORD_KEYS: ReadonlySet<string> = new Set(
  STATIC_BOARD_HEXES.map((hex) => `${hex.q},${hex.r}`),
);

/** The red off-board hexes COUNT as on the board: they are real drawn entries at real coordinates where routes terminate. Lives here because it is a question about geometry, and both the routing layer and the tile-legality filter ask it.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #6 */
export function isBoardHex(q: number, r: number): boolean {
  return BOARD_COORD_KEYS.has(`${q},${r}`);
}

export function boardHexLabel(q: number, r: number): string | null {
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) return landmark.label;
  return STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r)?.label ?? null;
}

export function describeHex(q: number, r: number): string {
  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) return `${landmark.name} (${landmark.label})`;

  const boardHex = STATIC_BOARD_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (boardHex) {
    const offboardName = OFFBOARD_LABELS[boardHex.label];
    if (offboardName) return `${offboardName} (${boardHex.label})`;
    // Extended to consult named-hex labels: once a laid tile suppresses a city's on-canvas nameplate, the tooltip becomes the ONLY remaining place that name is shown, so it must actually carry it.
    // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #47
    const namedLabel = NAMED_HEX_LABELS[boardHex.label];
    return namedLabel ? `${namedLabel} (${boardHex.label})` : boardHex.label;
  }

  return `(${q}, ${r}) [off the authentic 1830 board]`;
}

/** Debug descriptor of a hex's PRE-PRINTED terrain, independent of any laid tile, mirroring the same lookup priority describeHex uses.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #7 */
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
          "Preprinted YELLOW OO double-city (OO_DESIGNATED_HEXES) — Tile Selection Catalog verification pass: now strictly requires DoubleCityHub artwork (tile 15, the real 1830 tile 59), rejecting an ordinary MajorCityHub tile here",
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

/** Mirrors hexmap::terrain_base_value -- deliberately flat and terrain-only, NOT phase-dependent: a hex's value never changes as the game advances through colour tiers, unlike the genuinely era-tiered off-board figures.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #26 */
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

/** Mirrors the same priority draw() uses. Off-board zones are deliberately excluded and return null -- they have their own era-tiered value system, and callers fall back to that.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #26 */
export function hexRouteValue(q: number, r: number, mapGrid: MapGridResponse): number | null {
  const laidTile = mapGrid.tiles.find((t) => t.q === q && t.r === r);
  if (laidTile) {
    const catalogEntry = TILE_CATALOG_BY_ID.get(laidTile.tile_id);
    if (catalogEntry) return terrainBaseValue(catalogEntry.terrain);
  }

  const landmark = LANDMARK_HEXES.find((l) => l.q === q && l.r === r);
  const boardHex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
  // A per-hex sourced override, checked BEFORE the flat fallback. Any hex not listed falls straight through to the untouched flat logic.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #35
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
    // A blank town-designated hex has no printed track, so its real printed value IS $0 -- the same fact that justifies the city-designated figure. No principled reason for one blank category to hide its value while the other shows it.
    // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #37
    if (boardHex.townDesignation) return 0;
    // Superseded for all eight of these hexes by their real sourced $0; this branch is now only reachable if a NEW city-designated hex is added without a matching override.
    // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #35
    if (boardHex.cityDesignation) return terrainBaseValue("MajorCityHub");
    return terrainBaseValue("Plain");
  }

  return null;
}

/** Suffixes in a fixed left-to-right order: name, value, terrain cost, stations. #103 suppresses a $0 value. #118 corrected Stations from a CAPACITY count to which corporations actually hold a token here, omitted entirely when none.
 *  See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #118 */
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
    /* IT IS A PRICE, SO IT STOPS BEING NEWS ONCE PAID. A terrain fee is charged once, by the lay that crosses it -- on a hex that already carries a tile the figure is a receipt, and sitting beside the live route value it read as money still owed.
       See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #287 */
    const alreadyBuilt = mapGrid.tiles.some((tile) => tile.q === q && tile.r === r);
    const terrainFee = alreadyBuilt ? 0 : terrainBuildFeeAt(q, r);
    if (terrainFee > 0) result = `${result} (Terrain Cost: $${terrainFee})`;
  }

  // The canvas token can only fit an acronym and has no DOM node to hang a title on, so this is the only place a player learns which railroad it is. Multiple tokens stay bare tickers -- three expanded names would bury the hex's own description.
  // See docs/ai_architecture/hex_tile_math.md - HexGridRenderer.tsx #118
  const tickersHere = publicCompanies
    .filter((company) => company.station_token_hexes.some(([hexQ, hexR]) => hexQ === q && hexR === r))
    .map((company) => company.ticker);
  if (tickersHere.length === 1) {
    result = `${result} (Station: ${corporationLabel(tickersHere[0])})`;
  } else if (tickersHere.length > 1) {
    result = `${result} (Stations: ${tickersHere.join(", ")})`;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */
