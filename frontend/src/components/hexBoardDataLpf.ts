// frontend/src/components/hexBoardDataLpf.ts
//
// The Level Playing Field board -- design note #1320.
//
// ==================================================================
//  DESIGN NOTE 1321: LPF IS A DELTA ON THE EXPANSION, AS THE EXPANSION IS ON THE STANDARD BOARD
// ==================================================================
//
// The variant "starts with the 1830+ expanded board" and changes seven hexes. So this file starts from
// `EXPANDED_BOARD` and applies exactly those changes, in the same shape `hexBoardDataPlus.ts` (#1301) uses
// against `STANDARD_BOARD`: a hex the request does not name is the expansion's hex, by construction.
//
// THE WAREHOUSES. Five red areas keep their colour, their nameplate and their printed value, and become
// small towns that a route passes THROUGH: every stub meets at a dit in the centre. Three things make a red
// hex a town here, and all three are needed --
//   `warehouse: true` on the hex, which `isOffboardTerminal` and `isRouteTerminusHex` read to stop treating
//   it as a place a route ends;
//   a `grayHexes` entry with marker `"town"`, which is what `archetypeForHex` classifies as a town and
//   `liveEdgesForHex` reads the stubs from;
//   printed artwork of spokes meeting at the centre, which is what the router walks (spokes join at a hub,
//   `pathVariantsForTraversal`) and the renderer draws.
// The value stays where it always was: `hexValueForEra` asks `OFFBOARD_LABELS` first, and a warehouse is
// still listed there.
//
// TWO OF THE FIVE WERE HALF OF A TWO-HEX REGION, and the ruling (this batch) is that the other half becomes a
// plain gray connector feeding the warehouse: K1 curves from the L2 border up to J2, A9 curves from the A11
// border down to Barrie (B10). So each warehouse has its third stub across what used to be the region's
// hidden seam, and the seam is no longer hidden -- the two hexes are two hexes now.
//
// COAL RIVER (L8) is a printed hex of its own colour that FUNCTIONS as a small town: no station may ever be
// placed on it, it counts as a stop, and it pays $40 through Green and $60 from Brown. It carries the
// `revenueTiers` the value ladder reads, a gray-track entry with a town marker, and an `emblem` so the
// renderer draws the large circle, the pickaxe and the "$120" box the request describes (the licence fee
// itself is a later batch). Its five stubs face every neighbour it has -- NW, NE, E, W and SE (M9); only SW
// is the edge of the map.

import {
  type BoardDefinition,
  type BoardHex,
  type GrayHexTrack,
  type OffboardRevenueTiers,
} from "./hexBoardData";
import { EXPANDED_BOARD, axialOf, curve, hex, spoke } from "./hexBoardDataPlus";
import type { PrintedArtwork } from "./TileGraphics";

/* ---- the warehouses ------------------------------------------------------ */

/** The five red areas that become warehouse towns, with every stub (board edge numbers: 0 E, counter-clockwise).
 *  M13, F2 and B24 keep the expansion's own stubs; L2 and A11 gain one across the old seam. */
export const LPF_WAREHOUSES: Readonly<Record<string, readonly number[]>> = {
  M13: EXPANDED_BOARD.offboardTracks.M13, // Deep South: NW, NE, W -- 3 stubs
  L2: [...EXPANDED_BOARD.offboardTracks.L2, 2], // Chattanooga: E, NE + NW into K1 -- 3 stubs
  F2: EXPANDED_BOARD.offboardTracks.F2, // Chicago: E, NE, SE -- 3 stubs
  A11: [3, ...EXPANDED_BOARD.offboardTracks.A11], // Canadian West: W into A9 + SW, SE -- 3 stubs
  B24: EXPANDED_BOARD.offboardTracks.B24, // Maritime Provinces: W, SW -- 2 stubs
};

/* ---- Coal River ----------------------------------------------------------- */

export const COAL_RIVER_LABEL = "L8";
export const COAL_RIVER_REVENUE: OffboardRevenueTiers = { yellow: 40, brown: 60 };
/** NW (K7), NE (K9), E (L10), W (L6), SE (M9). SW is the map's edge. */
export const COAL_RIVER_EDGES: readonly number[] = [2, 1, 0, 3, 5];
/* Design note #1282: `COAL_RIVER_LICENCE_LABEL` ("$120") is gone with the box that printed it. */

/* ---- the hex list --------------------------------------------------------- */

const CHANGED: readonly BoardHex[] = [
  // The five warehouses: still red, still unbuildable, now towns.
  hex("M13", { type: "RedOffboard", warehouse: true }),
  hex("L2", { type: "RedOffboard", warehouse: true }),
  hex("F2", { type: "RedOffboard", warehouse: true }),
  hex("A11", { type: "RedOffboard", warehouse: true }),
  hex("B24", { type: "RedOffboard", warehouse: true }),
  // The two former region partners, now gray connectors into their warehouse.
  hex("K1", { type: "Plain", printedColor: "Gray" }),
  hex("A9", { type: "Plain", printedColor: "Gray" }),
  // Coal River.
  hex(COAL_RIVER_LABEL, { type: "Plain", printedColor: "Coal", revenueTiers: COAL_RIVER_REVENUE }),
];

const LPF_HEXES: readonly BoardHex[] = (() => {
  const byLabel = new Map(EXPANDED_BOARD.hexes.map((entry) => [entry.label, entry] as const));
  CHANGED.forEach((entry) => byLabel.set(entry.label, entry));
  return Array.from(byLabel.values()).sort((a, b) => a.r - b.r || a.q - b.q);
})();

/* ---- gray track ------------------------------------------------------------ */

/** K1 (-5, 10): J2 is (-4, 9) = NE = edge 1; L2 is (-5, 11) = SE = edge 5. A gentle curve.
 *  A9 (4, 0): B10 is (4, 1) = SE = edge 5; A11 is (5, 0) = E = edge 0. A sharp curve. */
const K1_EDGES: readonly number[] = [1, 5];
const A9_EDGES: readonly number[] = [5, 0];

const LPF_GRAY: Readonly<Record<string, GrayHexTrack>> = {
  ...EXPANDED_BOARD.grayHexes,
  K1: { edges: K1_EDGES, marker: "none" },
  A9: { edges: A9_EDGES, marker: "none" },
  [COAL_RIVER_LABEL]: { edges: COAL_RIVER_EDGES, marker: "town" },
  ...Object.fromEntries(
    Object.entries(LPF_WAREHOUSES).map(([label, edges]) => [label, { edges, marker: "town" } satisfies GrayHexTrack]),
  ),
};

/* ---- red off-board tables ---------------------------------------------------- */

const LPF_OFFBOARD_LABELS: Readonly<Record<string, string>> = (() => {
  const { K1: _k1, A9: _a9, ...kept } = EXPANDED_BOARD.offboardLabels;
  return kept;
})();

const LPF_OFFBOARD_TRACKS: Readonly<Record<string, readonly number[]>> = (() => {
  const { K1: _k1, A9: _a9, ...kept } = EXPANDED_BOARD.offboardTracks;
  return { ...kept, ...LPF_WAREHOUSES };
})();

/** No two-hex regions remain: the seams K1/L2 and A9/A11 are ordinary borders now. */
const LPF_OFFBOARD_HIDDEN_EDGES: Readonly<Record<string, number>> = (() => {
  const { K1: _k1, L2: _l2, A9: _a9, A11: _a11, ...kept } = EXPANDED_BOARD.offboardHiddenEdges;
  return kept;
})();

/* ---- names ------------------------------------------------------------------- */

const LPF_NAMED_HEX_LABELS: Readonly<Record<string, string>> = {
  ...EXPANDED_BOARD.namedHexLabels,
  /* Design note #1282: "Coalfields" on the nameplate -- the hex's own name; Coal River stays the code name
     (`COAL_RIVER_LABEL`) and the route label. */
  [COAL_RIVER_LABEL]: "Coalfields",
};

/* ---- printed artwork ------------------------------------------------------------ */

function hubTown(edges: readonly number[]): PrintedArtwork {
  return {
    tracks: edges.map((edgeIndex) => spoke(edgeIndex)),
    marker: { kind: "town", at: { x: 0, y: 0 } },
  };
}

const LPF_PRINTED_ARTWORK: Readonly<Record<string, PrintedArtwork>> = {
  ...EXPANDED_BOARD.printedArtwork,
  K1: { tracks: [curve(K1_EDGES[0], K1_EDGES[1])] },
  A9: { tracks: [curve(A9_EDGES[0], A9_EDGES[1])] },
  [COAL_RIVER_LABEL]: {
    ...hubTown(COAL_RIVER_EDGES),
    emblem: { kind: "coal" },
  },
  /* Design note #1286: a warehouse draws as a city circle with a crate in it -- a terminus that cannot be
     tokened (`GRAY_HEXES` keeps `marker: "town"`, which is what the slot count reads). */
  ...Object.fromEntries(
    Object.entries(LPF_WAREHOUSES).map(([label, edges]) => [
      label,
      { ...hubTown(edges), marker: { kind: "city", at: { x: 0, y: 0 } }, emblem: { kind: "crate" } } satisfies PrintedArtwork,
    ]),
  ),
};

/* ---- the new corporations' homes ---------------------------------------------------- */

/** PMQ (9) shares E5 the way ERIE shares E11; N&W (10) homes at Norfolk. Ids continue the printed eight. */
export const PMQ_COMPANY_ID = 9;
export const NW_COMPANY_ID = 10;

/** C&O's printed id. */
export const CO_COMPANY_ID = 5;

/* ==================================================================
 *  DESIGN NOTE 1325: C&O RESERVES TWO CITIES AND SITS IN ONE
 * ==================================================================
 * RULED: "C&O now places a home station reservation marker on both Cleveland and Richmond. No other
 * corporation may place a station in Richmond until C&O places its home station. However, other corps may
 * place a station in Cleveland ... Once C&O chooses and places its home station in one of those two hexes,
 * the reservation marker on the other hex is forfeited and removed."
 * So the board adds Richmond (K13) as a second, ENFORCED home and re-lists Cleveland (F6) UNENFORCED -- the
 * marker draws, the slot is not held. `homeReservationStands` (hexContractTypes) is what releases the other
 * marker the moment C&O holds any token. */
export const LPF_HOME_STATIONS: BoardDefinition["homeStations"] = [
  { companyId: PMQ_COMPANY_ID, ...axialOf("E5"), label: "E5" },
  { companyId: NW_COMPANY_ID, ...axialOf("L16"), label: "L16" },
  { companyId: CO_COMPANY_ID, ...axialOf("F6"), label: "F6", enforced: false },
  { companyId: CO_COMPANY_ID, ...axialOf("K13"), label: "K13" },
];

/** Every station after the free home one costs $100 -- the variant's flat schedule. */
export const LPF_STATION_TOKEN_SCHEDULE = { home: 0, second: 100, later: 100 } as const;

/* ==================================================================
    DESIGN NOTE 1288: THE PLATES MOVE OUT OF THE ART'S WAY
   ==================================================================
   RULED, hex by hex, once the warehouses had a crate in the middle and the Coalfields a pickaxe:
     A11  badge on the right edge, name at the top point
     B24  badge on the bottom-right edge, name at the top point
     L2   badge on the left edge, name at the bottom point       (second pass: was the upper-left vertex)
     L8   badge at the upper-right vertex, name on the lower-left edge, turned parallel to it (30 degrees
          clockwise -- that edge runs from the lower-left vertex up to the bottom point)
     M13  badge on the right edge, name at the bottom point      (second pass: was the upper-right vertex)
     I19  "Atlantic City" over two lines, so it stops clipping
   `nameInset` pulls a plate's name 4px toward the centre (2, then 2 more on the second look); the four red areas asked for it after the first
   pass clipped at their points.
   Slots are `hexGeometry`'s thirteen. Only this board carries the table; the others keep the centred block. */
export const LPF_PLATE_LAYOUT: BoardDefinition["plateLayout"] = {
  A11: { badge: 2, name: 7, nameInset: 4 },
  B24: { badge: 3, name: 7, nameInset: 4 },
  L2: { badge: 5, name: 10, nameInset: 4 },
  [COAL_RIVER_LABEL]: { badge: 8, name: 4, nameRotateDeg: 30 },
  M13: { badge: 2, name: 10, nameInset: 4 },
  I19: { stack: true },
};

export const LPF_BOARD: BoardDefinition = {
  ...EXPANDED_BOARD,
  id: "lpf",
  hexes: LPF_HEXES,
  grayHexes: LPF_GRAY,
  offboardLabels: LPF_OFFBOARD_LABELS,
  offboardTracks: LPF_OFFBOARD_TRACKS,
  offboardHiddenEdges: LPF_OFFBOARD_HIDDEN_EDGES,
  namedHexLabels: LPF_NAMED_HEX_LABELS,
  printedArtwork: LPF_PRINTED_ARTWORK,
  homeStations: LPF_HOME_STATIONS,
  stationTokenSchedule: LPF_STATION_TOKEN_SCHEDULE,
  plateLayout: LPF_PLATE_LAYOUT,
};
