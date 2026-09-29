// frontend/src/routeOracle/oracleManifest.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE'S OWN TABLES
// ==================================================================
//
// TEST-ONLY. Nothing in the application may import this directory (`routeOracleIndependence.test.ts` scans
// for it). Everything below is transcribed here, by hand, rather than read from a production helper, so that a
// defect in one of those helpers cannot make the oracle agree with the defect:
//
//   - the axial neighbour table and the rotation convention (production: `HEX_NEIGHBOR_OFFSETS`, `rotateConnections`);
//   - how many stops each train model may count (production: `MOCK_TRAIN_CATALOG`, `trainReach`);
//   - how many station circles each city of each city tile has (production: `tileCitySlotCounts`, read off SVG
//     artwork markers);
//   - what each PRINTED city / town / landmark pays (production: `HEX_START_VALUE_OVERRIDE` and the terrain bucket
//     ladder in `hexGeometry`).
//
// What the oracle DOES read from the application is DATA only, and only the declarative parts of it (brief:
// "it may reuse authoritative board data"): the three `BoardDefinition` objects (hex list, red areas' names and
// stubs, gray hexes' edges and markers, landmarks' printed stubs, impassable borders, heralds, warehouses), and
// the tile catalog's `paths` / `terrain` columns -- plus, for the Project 18XX+ tiles ONLY, `cityGroups` and
// `revenue`, for which the repository is the only authority there is.
//
// WHAT IS SHARED WITH PRODUCTION, SAID PLAINLY (the R12-1 review, M6):
//   - Plain track and hub shapes come from the catalog's `paths`. Production ROUTES on the tiles' SVG artwork
//     (`TileGraphics.artworkPathsForTraversal`), not on `paths` -- but it reads `paths` for the double towns'
//     stop order (`stopForArrival`) and `connections` (asserted equal to `paths` by a Rust test) for live
//     edges. `routeOracleTopology.test.ts` compares the oracle's transits with the artwork's, tile by tile.
//   - The board tables (red-area stubs, gray edges, landmark stubs) are read by both sides; the cross-check
//     there shows the two READERS agree, not that the DATA is right. The data itself was compared by hand in
//     R12-1 with tobymao/18xx's `g_1830/map.rb` (every red stub and tier, every gray hex, Altoona's bow) and found
//     equal; the tables below re-transcribe the VALUES so a value error is visible.
//   - A token's `city_index` is a storage convention (the order of a tile's cities), shared by construction.
//     The oracle's standard-tile city membership below is its own transcription; only the 18XX+ tiles fall back
//     to the catalog's `cityGroups`.
//
// Every table here is cross-checked against the production value it replaces in that test; a disagreement is a
// finding about one side or the other, never silently resolved.

/** Axial neighbour of each edge. Edge numbering is the board's own (hexBoardData design note #1): 0 E, 1 NE,
 *  2 NW, 3 W, 4 SW, 5 SE, with `r` the board row (A = 0) and `q = (column - 1 - r) / 2`. Derived here from
 *  that definition: E is one column right on the same row; the NE / NW neighbours are on the row above
 *  (r - 1), one column right / left; the SW / SE neighbours on the row below (r + 1). With `q = (col-1-r)/2`,
 *  NE = (col+1, r-1) -> q+1; NW = (col-1, r-1) -> q; SW = (col-1, r+1) -> q-1; SE = (col+1, r+1) -> q. */
export const ORACLE_NEIGHBOUR: ReadonlyArray<readonly [number, number]> = [
  [1, 0], // 0 E
  [1, -1], // 1 NE
  [0, -1], // 2 NW
  [-1, 0], // 3 W
  [-1, 1], // 4 SW
  [0, 1], // 5 SE
];

export function oppositeEdge(edge: number): number {
  return (edge + 3) % 6;
}

/** A tile laid at `orientation` turns every base edge `e` to `(e + orientation) mod 6` (the catalog's base
 *  edges are the orientation-0 drawing; `routeAuthority.test.ts`'s own boards document the same convention, e.g.
 *  #57 at orientation 1 runs edges 1 / 4). */
export function rotateEdge(edge: number, orientation: number): number {
  return (((edge + orientation) % 6) + 6) % 6;
}

/** Rulebook 6.4.1: a train's number is the most cities it may count; a Diesel has no limit. The 7-train is the
 *  Level Playing Field's (seven cities). `null` = the model is unknown, which the oracle refuses to price
 *  (UNDECIDED) rather than guess. */
export const ORACLE_TRAIN_STOPS: Readonly<Record<string, number | "unlimited">> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  D: "unlimited",
};

export function oracleTrainStops(model: string): number | "unlimited" | null {
  return Object.prototype.hasOwnProperty.call(ORACLE_TRAIN_STOPS, model) ? ORACLE_TRAIN_STOPS[model] : null;
}

/** Station circles per city of each city tile, in `cityGroups` order (a single-city tile has one entry).
 *  Standard 1830 tiles: transcribed from the printed tiles (the 1830 tile sheet: #57 one circle; #14 / #15 two;
 *  #53 / #61 "B" one; #54 NY two cities of one; #62 NY two cities of two; #59 and #64-#68 OO two cities of one;
 *  #63 two).
 *  Project 18XX+ tiles: these are the project's own owner-confirmed tile set (design notes #1311 / #1317 /
 *  #1385 / #1401), for which the repository is the only authority there is; the figures are the ones the tiles
 *  are drawn with, restated here as numbers and cross-checked against `tileCitySlotCounts` by test so that a
 *  change on either side is seen. */
export const ORACLE_TILE_CITY_SLOTS: Readonly<Record<number, readonly number[]>> = {
  // 1830
  57: [1],
  14: [2],
  15: [2],
  53: [1],
  54: [1, 1],
  59: [1, 1],
  61: [1],
  62: [2, 2],
  63: [2],
  64: [1, 1],
  65: [1, 1],
  66: [1, 1],
  67: [1, 1],
  68: [1, 1],
  // Project 18XX+ (repository authority)
  5: [1],
  6: [1],
  592: [2],
  619: [2],
  626: [1, 1],
  884: [3],
  997: [2],
  883: [4],
  36: [1, 1],
  35: [1, 1],
  984: [1, 1],
  810: [1, 2],
  882: [2, 2],
  167: [1, 1],
  513: [3],
};

/** What each PRINTED (never-tiled) gray city or town pays, by hex label. Standard 1830's printed map: Lansing
 *  $20, Cleveland $30, Altoona $10, Rochester $20, Richmond $20, Montreal $40, Kingston $10, Atlantic City $10,
 *  Mansfield $10.
 *
 *  NORFOLK (L16, the 18XX+ expansion's gray city) IS DELIBERATELY ABSENT (R12-1 repair, owner ruling "do not
 *  bless the single $20 without evidence"). The rulebook in the repository (`1830 FULL RULES with variants.pdf`,
 *  p. 36, Scenario S-1.0 "Collect Revenue (7.5)") says Norfolk is one of the gray hexes with TWO values, the
 *  lower until the first 5-train is bought -- but the figures themselves are printed only on the 1830+ map,
 *  which is not in the repository or the Project (the rulebook's board-tile tables, pp. 37 / 45, list no
 *  Norfolk figure; the code prices it at $20 by the ordinary gray-city bucket, with no provenance). The pair is
 *  UNRESOLVED: see `ORACLE_UNRESOLVED_PRINTED_STOPS`, which makes any case where a route could stop there
 *  UNDECIDED rather than priced by a guess.
 *
 *  MONTREAL (A19) keeps the standard map's $40 here. The same rulebook sentence names Montreal as two-valued on
 *  the 1830+ map, so on the expansion boards the $40 (both tiers) is the same kind of unevidenced figure. It is
 *  recorded in the R12-1 repair report beside Norfolk for an owner ruling; it is NOT changed here, because the
 *  repair brief scoped the data question to Norfolk. */
export const ORACLE_PRINTED_STOP_VALUE: Readonly<Record<string, number>> = {
  D2: 20,
  F6: 30,
  H12: 10,
  D14: 20,
  K15: 20,
  A19: 40,
  C15: 10,
  I19: 10,
  F24: 10,
};

/** Printed stops whose figure the oracle does NOT know and will not guess. A route that could stop at one makes
 *  the whole case UNDECIDED (`solveOracleCase`), never a price. Keyed by hex label; the value is the reason. */
export const ORACLE_UNRESOLVED_PRINTED_STOPS: Readonly<Record<string, string>> = {
  L16:
    "Norfolk (L16): a two-value gray city (rulebook p. 36, S-1.0 7.5: lower until the first 5-train); the pair is " +
    "printed only on the 1830+ map, which no project or repository material reproduces -- UNRESOLVED (R12-1 repair blocker)",
};

/** The three landmarks' printed yellow values, per city (1830 map: New York two $40 cities, Boston $30,
 *  Baltimore $30), keyed by the board's landmark `name`. Each landmark city has one circle. */
export const ORACLE_LANDMARK_VALUE: Readonly<Record<string, number>> = {
  "New York": 40,
  Boston: 30,
  Baltimore: 30,
};

/** STANDARD 1830 TILES, TRANSCRIBED A SECOND TIME (the R12-1 review, H2 / M6), from tobymao/18xx's 1830 tile
 *  definitions (`lib/engine/tile.rb`, the same tile numbers and, verbatim, the same base edge numbers the
 *  catalog uses): each tile's printed revenue per stop, and -- for the tiles with more than one city -- which
 *  base edges belong to which city, in the tile's own city order. Plain-track tiles are absent (they pay
 *  nothing). The oracle PRICES and GROUPS standard tiles from this table, never from the catalog; the topology
 *  test diffs the two.
 *
 *  #62 (brown New York) IS $80 PER CITY -- the owner's ruling for Route v12 (R12-1 repair), agreeing with
 *  tobymao/18xx. The project's catalog, its Rust contract and design note #135 say $90: that is a PRODUCTION DATA
 *  DEFECT, recorded here (`productionDefect`) and left for R12-2 (production tile data is not touched in R12-1). */
export const ORACLE_STANDARD_TILES: Readonly<Record<number, { value: number; cities?: ReadonlyArray<readonly number[]>; productionDefect?: string }>> = {
  1: { value: 10 },
  2: { value: 10 },
  3: { value: 10 },
  4: { value: 10 },
  55: { value: 10 },
  56: { value: 10 },
  57: { value: 20 },
  58: { value: 10 },
  69: { value: 10 },
  14: { value: 30 },
  15: { value: 30 },
  53: { value: 50 },
  54: { value: 60, cities: [[0, 1], [2, 3]] },
  59: { value: 40, cities: [[0], [2]] },
  61: { value: 60 },
  62: {
    value: 80,
    cities: [[0, 1], [2, 3]],
    productionDefect: "owner ruling (R12-1 repair): $80 per city; the project's catalog says $90 -- a production data defect for R12-2",
  },
  63: { value: 40 },
  64: { value: 50, cities: [[0, 2], [3, 4]] },
  65: { value: 50, cities: [[0, 4], [2, 3]] },
  66: { value: 50, cities: [[0, 3], [1, 2]] },
  67: { value: 50, cities: [[0, 3], [2, 4]] },
  68: { value: 50, cities: [[0, 3], [1, 4]] },
};

/** Red off-board areas' printed values, by AREA name, lesser / greater (rulebook: the lesser until the first
 *  5-train is bought). 1830 (tobymao `g_1830/map.rb`, and the board): Chicago 40/70, Canadian West 30/50,
 *  Gulf 30/60, Deep South 30/40, Maritime Provinces 20/30. 1830+: Chattanooga takes the Gulf's "same revenue
 *  values" (the expansion spec, design note #1301). The Level Playing Field's warehouses keep their area's
 *  figure (design note #1320). */
export const ORACLE_OFFBOARD_TIERS: Readonly<Record<string, readonly [number, number]>> = {
  Chicago: [40, 70],
  "Canadian West": [30, 50],
  Gulf: [30, 60],
  "Deep South": [30, 40],
  "Maritime Provinces": [20, 30],
  Chattanooga: [30, 60],
};

/** Coal River (Level Playing Field, L8): a town paying $40 until the first 5-train, $60 after (design note
 *  #1320, S-1.0's Coalfields). */
export const ORACLE_COAL_RIVER_TIERS: readonly [number, number] = [40, 60];
