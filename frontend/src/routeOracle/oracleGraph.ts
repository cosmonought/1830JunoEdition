// frontend/src/routeOracle/oracleGraph.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE'S TRACK GRAPH
// ==================================================================
//
// TEST-ONLY. The oracle's own reading of a board: which pieces of track and which revenue centres each hex
// holds, and how they join. It is built ONLY from declarative data (the `BoardDefinition` passed in, the tile
// catalog's `paths` / `cityGroups` / `terrain` / `revenue`) and the oracle's own manifest. It never calls a
// production topology helper (`traversalsFrom`, `neighbourAcross`, `liveEdgesForHex`, `cityForArrival`,
// `archetypeForHex`, `citySlotCount`, `hexValueForEra`, `isOffboardTerminal`, ...), and it never reads the
// module-global "board in effect": the board is an argument.
//
// THE CONCEPTS ARE KEPT APART ON PURPOSE (brief §5). A HEX is a place. A PATH is one section of track between
// two hex edges. A NODE is a revenue centre (city, town, red area, warehouse, Coal River, a herald) with SPOKES
// (the short sections of track from an edge into the node). A STATION is a token bound to a NODE, never to a
// hex. A route VISITS a node only by entering it along a spoke; running along a path through the same hex
// (the Altoona bow, or plain track beside a city) is a TRAVERSAL of that hex and visits nothing. That is the
// distinction whose absence produced the Altoona defect ("a bare token counts for the hex").
//
// EXCLUSIVITY. Every section of track that crosses a hex edge meets the neighbour's section at that edge; the
// oracle's unit of exclusivity is that BOUNDARY (the pair (hex, edge) / (neighbour, opposite edge)). A path, a
// spoke and a bypass that share an edge therefore share the boundary, and two routes (or one route twice) may
// not both use it (rulebook 6.4.2 "may not use the same section of track more than once"; "routes ... may not
// use the same track"). Two routes meeting at a city on different spokes use different boundaries, so they may.

import type { BoardDefinition, BoardHex } from "../components/hexBoardData";
import type { TileCatalogEntry } from "../components/hexTileCatalog";
import {
  ORACLE_COAL_RIVER_TIERS,
  ORACLE_LANDMARK_VALUE,
  ORACLE_NEIGHBOUR,
  ORACLE_OFFBOARD_TIERS,
  ORACLE_PRINTED_STOP_VALUE,
  ORACLE_STANDARD_TILES,
  ORACLE_TILE_CITY_SLOTS,
  ORACLE_UNRESOLVED_PRINTED_STOPS,
  oppositeEdge,
  rotateEdge,
} from "./oracleManifest";

export type NodeKind = "city" | "town" | "offboard" | "warehouse" | "coalfield" | "herald";

export interface OracleNode {
  /** Unique within the graph: `${hex}/${kind}${index}`. */
  id: string;
  hex: string;
  kind: NodeKind;
  /** City number within the hex (the token's `city_index`), for cities only. */
  cityIndex: number | null;
  spokes: readonly number[];
  /** The same-city identity (rulebook 6.4.2 "may not include the same city more than once"; the same red area
   *  cannot be both the beginning and the end of a route). A two-hex red area is ONE group. */
  group: string;
  /** Integer dollars at the case's tier. */
  value: number;
  /** Station circles (cities only; 0 otherwise). */
  slots: number;
  /** Herald only: the pairs of edges the node may be passed between (the hex's printed rails); every other
   *  passable node joins any two distinct spokes. */
  transit?: ReadonlyArray<readonly [number, number]>;
  /** A printed stop whose figure the oracle does not know (`ORACLE_UNRESOLVED_PRINTED_STOPS`): `value` is a
   *  placeholder 0 and any case in which a route could stop here is UNDECIDED. The reason, when set. */
  unresolvedValue?: string;
}

export interface OraclePath {
  id: string;
  hex: string;
  a: number;
  b: number;
  /** A path that runs past a node without entering it (Altoona's bow), recorded for narration only. */
  bypass: boolean;
}

export interface OracleHex {
  label: string;
  q: number;
  r: number;
  paths: OraclePath[];
  nodes: OracleNode[];
  /** Coal River (a printed revenue-tiered hex) -- the Level Playing Field's licence rule reads this. */
  coalfield: boolean;
}

export interface OracleTokenInput {
  q: number;
  r: number;
  /** `null` / `undefined` = the token was recorded without a city. */
  city?: number | null;
}

export interface OracleCompanyInput {
  companyId: number;
  tokens: readonly OracleTokenInput[];
  /** Kanawha licences held (Level Playing Field). */
  licences: number;
}

export interface OraclePolicy {
  /** IL-3, RULED NO (R12-1 repair): merely traversing the herald hex WITHOUT electing to count the herald does
   *  not satisfy the station requirement; the herald is PRR's station on a route only when that route counts
   *  it. The default is therefore `false`. `true` is kept only as a SEEDED WRONG READING (the authority's
   *  pre-ruling behaviour, S6-4 "today it does") so the sensitivity tests can show the fixtures notice it. */
  heraldUncountedIsStation: boolean;
}

export const DEFAULT_ORACLE_POLICY: OraclePolicy = {
  heraldUncountedIsStation: false,
};

export interface OracleGridTile {
  q: number;
  r: number;
  tile_id: number;
  orientation: number;
  /** The chain's own revenue figure, when a grid carries one. The oracle never PRICES from it (V7): it only
   *  reports a grid whose figure disagrees with the tile's printed value. */
  revenue?: string | number | null;
}

export interface OracleCaseInput {
  board: BoardDefinition;
  grid: readonly OracleGridTile[];
  companies: readonly OracleCompanyInput[];
  companyId: number;
  /** Off-board / Coal River tier: `true` from the first 5-train (rulebook 6.5 / the off-board note). */
  highTier: boolean;
  /** Whether the Level Playing Field's Kanawha licence rule is in force (Coal River barred to the unlicensed). */
  licenceRule: boolean;
  catalog: ReadonlyMap<number, TileCatalogEntry>;
  policy?: OraclePolicy;
}

/** A state the oracle refuses to treat as valid evidence. The preflight's valid-state conditions, as far as a
 *  board can show them: V1 a token on a multi-city hex names its city; V2 that city exists; V3 every tile is a
 *  catalog tile, in orientation 0-5, on a hex that takes tiles, with no track across an impassable border; V10
 *  (split out of V3 so a SYNTHETIC test board can knowingly waive it) the tile is of the class its hex prints
 *  (city / town / plain); V6 tokens fit their circles, one per company per hex; V7 a
 *  grid's own revenue figure (when present) agrees with the printed value; plus V8 the board's printed tiles are
 *  on the grid, and V9 the oracle has its own figure for every stop it could reach (a missing figure is never
 *  silently $0). V4 (the table's board) and V5 (the runnable fleet) are the CALLER'S: the oracle is handed the
 *  board and the fleet explicitly. */
export interface ValidityFinding {
  code: "V1" | "V2" | "V3" | "V6" | "V7" | "V8" | "V9" | "V10";
  detail: string;
}

export interface OracleGraph {
  hexes: ReadonlyMap<string, OracleHex>;
  byCoord: ReadonlyMap<string, string>;
  /** `${label}:${edge}` -> boundary index, for every edge that has a neighbour on the board and no impassable
   *  border. Absent = no boundary (track there leads nowhere). */
  boundaryAt: ReadonlyMap<string, number>;
  boundaryCount: number;
  nodes: ReadonlyMap<string, OracleNode>;
  /** Node id -> companies with a station in that node. */
  stations: ReadonlyMap<string, readonly number[]>;
  companyId: number;
  /** Nodes where the running company has a station (the herald included, for its owner). */
  anchors: readonly OracleNode[];
  /** The running company's herald hex, if any (the seeded wrong IL-3 reading's path anchors read it). */
  heraldHex: string | null;
  /** Hexes the running company may not touch at all (Coal River without a licence). */
  barred: ReadonlySet<string>;
  policy: OraclePolicy;
  validity: ValidityFinding[];
}

const coordKey = (q: number, r: number) => `${q},${r}`;

function tierValue(tiers: readonly [number, number], highTier: boolean): number {
  return highTier ? tiers[1] : tiers[0];
}

/** The tile's own topology at an orientation: plain sections and revenue centres. Shapes from the catalog's
 *  DECLARATIVE `paths`; for a standard 1830 tile the value and the city membership from the oracle's own
 *  transcription (`ORACLE_STANDARD_TILES`); for a Project 18XX+ tile, the catalog's (repository authority).
 *  `value === null` means no figure is known: the caller records V9. */
function tileTopology(
  label: string,
  entry: TileCatalogEntry,
  orientation: number,
): { paths: OraclePath[]; nodes: Omit<OracleNode, "group">[]; value: number | null } | null {
  const rot = (e: number) => rotateEdge(e, orientation);
  const basePaths = entry.paths ?? [];
  const standard = ORACLE_STANDARD_TILES[entry.tileId];
  const known = standard ? standard.value : typeof entry.revenue === "number" ? entry.revenue : null;
  const value = known ?? 0;
  const edgesOf = (pairs: ReadonlyArray<readonly [number, number]>) =>
    Array.from(new Set(pairs.flatMap(([a, b]) => [rot(a), rot(b)]))).sort((x, y) => x - y);
  const slots = ORACLE_TILE_CITY_SLOTS[entry.tileId];
  switch (entry.terrain) {
    case "Plain":
    case "MountainRugged":
      return {
        paths: basePaths.map(([a, b], i) => ({ id: `${label}/p${i}`, hex: label, a: rot(a), b: rot(b), bypass: false })),
        nodes: [],
        value: 0,
      };
    case "SmallTown":
      // One town; every rail of the tile runs into it (the #141-#144 three-exit towns and the #87/#88/#204
      // merged towns alike).
      return {
        paths: [],
        nodes: [{ id: `${label}/town0`, hex: label, kind: "town", cityIndex: null, spokes: edgesOf(basePaths), value, slots: 0 }],
        value: known,
      };
    case "DoubleTown":
      // Two towns, one per rail (#1, #2, #55, #56, #69, #630-#633).
      return {
        paths: [],
        nodes: basePaths.map(([a, b], i) => ({
          id: `${label}/town${i}`,
          hex: label,
          kind: "town" as const,
          cityIndex: null,
          spokes: edgesOf([[a, b]]),
          value,
          slots: 0,
        })),
        value: known,
      };
    case "MajorCityHub":
    case "BostonHub":
    case "NewYorkHub":
    case "DoubleCityHub":
    case "TorontoHub": {
      if (!slots) return null;
      // Which base edges belong to which city: the oracle's own transcription for a standard tile, the catalog's
      // `cityGroups` only for an 18XX+ tile.
      const groups = standard
        ? standard.cities ?? null
        : entry.cityGroups && entry.cityGroups.length > 0
          ? entry.cityGroups
          : null;
      if (groups === null) {
        if (slots.length !== 1) return null;
        return {
          paths: [],
          nodes: [{ id: `${label}/city0`, hex: label, kind: "city", cityIndex: 0, spokes: edgesOf(basePaths), value, slots: slots[0] }],
          value: known,
        };
      }
      if (slots.length !== groups.length) return null;
      return {
        value: known,
        paths: [],
        nodes: groups.map((group, i) => ({
          id: `${label}/city${i}`,
          hex: label,
          kind: "city" as const,
          cityIndex: i,
          spokes: Array.from(new Set(group.map(rot))).sort((x, y) => x - y),
          value,
          slots: slots[i],
        })),
      };
    }
  }
  return null;
}

function tokenNodeOf(
  hex: OracleHex | undefined,
  token: OracleTokenInput,
): { node: OracleNode } | { finding: ValidityFinding } {
  if (!hex) return { finding: { code: "V3", detail: `token at ${token.q},${token.r}: no such hex` } };
  const cities = hex.nodes.filter((node) => node.kind === "city");
  if (cities.length === 0) return { finding: { code: "V2", detail: `token on ${hex.label}, which holds no city` } };
  if (token.city === null || token.city === undefined) {
    if (cities.length === 1) return { node: cities[0] };
    return { finding: { code: "V1", detail: `token on ${hex.label} without a city, and ${hex.label} has ${cities.length} cities` } };
  }
  const city = cities.find((node) => node.cityIndex === token.city);
  if (!city) return { finding: { code: "V2", detail: `token on ${hex.label} city ${token.city}, which the tile does not have` } };
  return { node: city };
}

/** V3's class check: a tile of the class its hex prints. Cities on a city hex with the same number of cities
 *  (New York may merge into one: #883), towns on a town hex (a double town takes two-town tiles or a merged
 *  town), plain track on a hex that prints nothing (or prints plain track: H12's #24, M11's #9). */
function tileClassMismatch(board: BoardDefinition, bh: BoardHex, landmarkName: string | undefined, entry: TileCatalogEntry): string | null {
  const cityTiles = ["MajorCityHub", "BostonHub", "NewYorkHub", "DoubleCityHub", "TorontoHub"];
  const tileCities = cityTiles.includes(entry.terrain) ? Math.max(1, entry.cityGroups?.length ?? 1) : 0;
  const landmarkCities = landmarkName ? Math.max(1, (board.landmarkTracks[landmarkName] ?? []).length) : 0;
  const printedCities = board.yellowOoHexes.has(bh.label) ? 2 : landmarkName ? landmarkCities : bh.cityDesignation ? 1 : 0;
  const printedTowns = bh.townDesignation === "double" ? 2 : bh.townDesignation === "single" ? 1 : 0;
  if (printedCities > 0) {
    if (tileCities === 0) return `a ${entry.terrain} tile on a hex printed with ${printedCities} city(ies)`;
    if (tileCities !== printedCities && !(entry.terrain === "NewYorkHub" && landmarkName === "New York")) {
      return `a ${tileCities}-city tile on a hex printed with ${printedCities}`;
    }
    return null;
  }
  if (printedTowns > 0) {
    if (entry.terrain !== "SmallTown" && entry.terrain !== "DoubleTown") return `a ${entry.terrain} tile on a town hex`;
    if (entry.terrain === "DoubleTown" && printedTowns !== 2) return "a two-town tile on a one-town hex";
    // A one-town tile on a two-town hex only as the merge family (#87 / #88 / #204, #1403) or its brown upgrades.
    if (entry.terrain === "SmallTown" && printedTowns === 2 && entry.mergesTowns !== true && entry.color !== "Brown") {
      return "a one-town tile on a two-town hex";
    }
    if (entry.terrain === "SmallTown" && printedTowns === 1 && entry.mergesTowns === true) return "a merged-town tile on a one-town hex";
    return null;
  }
  if (entry.terrain !== "Plain" && entry.terrain !== "MountainRugged") return `a ${entry.terrain} tile on a hex that prints no city or town`;
  return null;
}

/** Build the running company's view of the board. */
export function buildOracleGraph(input: OracleCaseInput): OracleGraph {
  const { board, grid, catalog, highTier, companyId } = input;
  const policy = input.policy ?? DEFAULT_ORACLE_POLICY;
  const validity: ValidityFinding[] = [];
  const hexes = new Map<string, OracleHex>();
  const byCoord = new Map<string, string>();
  const nodes = new Map<string, OracleNode>();
  const boardHexByLabel = new Map<string, BoardHex>(board.hexes.map((hex) => [hex.label, hex]));
  for (const hex of board.hexes) byCoord.set(coordKey(hex.q, hex.r), hex.label);

  const tileAt = new Map<string, OracleGridTile>();
  for (const tile of grid) {
    const label = byCoord.get(coordKey(tile.q, tile.r));
    if (!label) {
      validity.push({ code: "V3", detail: `tile #${tile.tile_id} at ${tile.q},${tile.r}: no such hex` });
      continue;
    }
    if (tileAt.has(label)) validity.push({ code: "V3", detail: `two tiles on ${label}` });
    tileAt.set(label, tile);
  }

  const landmarkByLabel = new Map(board.landmarks.map((landmark) => [landmark.label, landmark]));

  for (const bh of board.hexes) {
    const label = bh.label;
    const hex: OracleHex = { label, q: bh.q, r: bh.r, paths: [], nodes: [], coalfield: false };
    const addNode = (node: Omit<OracleNode, "group"> & { group?: string }) => {
      const full: OracleNode = { ...node, group: node.group ?? node.id };
      hex.nodes.push(full);
    };
    const tile = tileAt.get(label);
    const offboardName = board.offboardLabels[label];
    const gray = board.grayHexes[label];

    if (bh.type === "RedOffboard") {
      if (tile) validity.push({ code: "V3", detail: `tile #${tile.tile_id} laid on the red area ${label}` });
      const spokes = board.offboardTracks[label] ?? [];
      // THE ORACLE'S OWN FIGURES, by area name (never the board's `offboardRevenue`, which the topology test diffs).
      const tiers = offboardName ? ORACLE_OFFBOARD_TIERS[offboardName] : undefined;
      if (!tiers) validity.push({ code: "V9", detail: `red area ${label} (${offboardName ?? "unnamed"}) has no figure in the oracle's table` });
      const value = tiers ? tierValue(tiers, highTier) : 0;
      addNode({
        id: `${label}/${bh.warehouse ? "warehouse" : "offboard"}0`,
        hex: label,
        kind: bh.warehouse ? "warehouse" : "offboard",
        cityIndex: null,
        spokes: [...spokes].sort((x, y) => x - y),
        // THE AREA, NOT THE HEX: both hexes of Canadian West / the Gulf / Chattanooga are one red area.
        group: `area:${offboardName ?? label}`,
        value,
        slots: 0,
      });
    } else if (tile) {
      if (gray) validity.push({ code: "V3", detail: `tile #${tile.tile_id} laid on the printed gray hex ${label}` });
      if (bh.revenueTiers) validity.push({ code: "V3", detail: `tile #${tile.tile_id} laid on ${label}, which is never tiled` });
      if (!Number.isInteger(tile.orientation) || tile.orientation < 0 || tile.orientation > 5) {
        validity.push({ code: "V3", detail: `tile #${tile.tile_id} on ${label} has orientation ${String(tile.orientation)}, not 0-5` });
      }
      const entry = catalog.get(tile.tile_id);
      const topo = entry ? tileTopology(label, entry, tile.orientation) : null;
      if (!topo || !entry) {
        validity.push({ code: "V3", detail: `tile #${tile.tile_id} on ${label} is not a tile the oracle can read` });
      } else {
        const mismatch = tileClassMismatch(board, bh, landmarkByLabel.get(label)?.name, entry);
        if (mismatch) validity.push({ code: "V10", detail: `tile #${tile.tile_id} on ${label}: ${mismatch}` });
        if (topo.value === null && topo.nodes.length > 0) {
          validity.push({ code: "V9", detail: `tile #${tile.tile_id} on ${label} has no printed value the oracle knows` });
        }
        const chain = tile.revenue === undefined || tile.revenue === null || tile.revenue === "" ? null : Number(tile.revenue);
        if (chain !== null && topo.nodes.length > 0 && chain !== (topo.value ?? 0)) {
          validity.push({ code: "V7", detail: `the grid says #${tile.tile_id} on ${label} pays ${String(tile.revenue)}; the tile prints ${String(topo.value)}` });
        }
        hex.paths.push(...topo.paths);
        topo.nodes.forEach((node) => addNode(node));
      }
    } else if (bh.revenueTiers && gray) {
      // Coal River (LPF): functions as a small town on every printed stub; tiers like a red area.
      hex.coalfield = true;
      addNode({
        id: `${label}/coalfield0`,
        hex: label,
        kind: "coalfield",
        cityIndex: null,
        spokes: [...gray.edges].sort((x, y) => x - y),
        value: tierValue(ORACLE_COAL_RIVER_TIERS, highTier),
        slots: 0,
      });
    } else if (gray) {
      const edges = [...gray.edges];
      if (gray.marker === "city" || gray.marker === "town") {
        const unresolved = ORACLE_UNRESOLVED_PRINTED_STOPS[label];
        addNode({
          id: `${label}/${gray.marker}0`,
          hex: label,
          kind: gray.marker,
          cityIndex: gray.marker === "city" ? 0 : null,
          spokes: [...edges].sort((x, y) => x - y),
          value: ORACLE_PRINTED_STOP_VALUE[label] ?? 0,
          slots: gray.marker === "city" ? gray.slots ?? 1 : 0,
          ...(unresolved !== undefined ? { unresolvedValue: unresolved } : {}),
        });
        // An UNRESOLVED figure is not a missing one: it is known to be unknown, and makes a case UNDECIDED only
        // when a route could actually stop there (`solveOracleCase`), not the whole board invalid.
        if (ORACLE_PRINTED_STOP_VALUE[label] === undefined && unresolved === undefined) {
          validity.push({ code: "V9", detail: `printed ${gray.marker} ${label} has no figure in the oracle's table` });
        }
        if (gray.bypass) {
          if (edges.length !== 2) {
            validity.push({ code: "V3", detail: `${label}: a bypass needs exactly two edges` });
          } else {
            hex.paths.push({ id: `${label}/bypass`, hex: label, a: edges[0], b: edges[1], bypass: true });
          }
        }
      } else {
        // A connector with no centre: two edges are one rail; three or more are joined pair by pair (the
        // expansion's A17, "tile-39 connectivity").
        let i = 0;
        for (let x = 0; x < edges.length; x += 1) {
          for (let y = x + 1; y < edges.length; y += 1) {
            hex.paths.push({ id: `${label}/p${i}`, hex: label, a: edges[x], b: edges[y], bypass: false });
            i += 1;
          }
        }
      }
    } else if (landmarkByLabel.has(label)) {
      const landmark = landmarkByLabel.get(label)!;
      const segments = board.landmarkTracks[landmark.name] ?? [];
      const value = ORACLE_LANDMARK_VALUE[landmark.name] ?? 0;
      if (ORACLE_LANDMARK_VALUE[landmark.name] === undefined) {
        validity.push({ code: "V9", detail: `landmark ${landmark.name} (${label}) has no figure in the oracle's table` });
      }
      if (segments.length >= 2) {
        segments.forEach((segment, i) =>
          addNode({
            id: `${label}/city${i}`,
            hex: label,
            kind: "city",
            cityIndex: i,
            spokes: [...segment.edges].sort((x, y) => x - y),
            value,
            slots: 1,
          }),
        );
      } else {
        addNode({
          id: `${label}/city0`,
          hex: label,
          kind: "city",
          cityIndex: 0,
          spokes: [...(segments[0]?.edges ?? [])].sort((x, y) => x - y),
          value,
          slots: 1,
        });
      }
    } else if (board.yellowOoHexes.has(label)) {
      // A printed double city with no track yet: two circles a token can sit in, nothing a route can reach.
      [0, 1].forEach((i) =>
        addNode({ id: `${label}/city${i}`, hex: label, kind: "city", cityIndex: i, spokes: [], value: 0, slots: 1 }),
      );
    } else if (bh.cityDesignation) {
      addNode({ id: `${label}/city0`, hex: label, kind: "city", cityIndex: 0, spokes: [], value: 0, slots: 1 });
    } else if (bh.townDesignation) {
      const count = bh.townDesignation === "double" ? 2 : 1;
      for (let i = 0; i < count; i += 1) {
        addNode({ id: `${label}/town${i}`, hex: label, kind: "town", cityIndex: null, spokes: [], value: 0, slots: 0 });
      }
    }

    // THE HERALD (1830+ / LPF, #1302): a stop printed on a hex that is not a city, for one corporation only.
    // For everyone else the hex is its plain track. The owner's rulings (R12-1 repair):
    //   IL-2 YES -- PRR may count its H12 home as a VIRTUAL CITY on any otherwise legal traversal of the hex:
    //     stopping there (a route end, arriving along ANY live edge) or running through it along one of the
    //     hex's printed rails. The node's `transit` is exactly those rails, so the virtual city joins nothing the
    //     track does not already join: no prong-to-prong reversal on the Y, no bridge between disconnected
    //     sections of a crossing tile.
    //   IL-3 NO -- running past it uncounted is plain track and is NOT a station (`OraclePolicy`).
    //   IL-4 YES -- separate trains are independent: one may count it while another passes, on separate track.
    //   IL-11 -- a route may re-enter the hex on DISTINCT sections (boundary exclusivity polices the track). The
    //     herald is counted AT MOST ONCE per route (its group), and an uncounted pass does NOT consume that
    //     identity: pass-then-count and count-then-pass are both legal; count-and-count is not.
    //   S6-4 -- no "PRR must count its herald on its first turns" obligation exists.
    if (bh.herald && bh.herald.companyId === companyId) {
      const liveEdges = Array.from(new Set(hex.paths.flatMap((path) => [path.a, path.b]))).sort((x, y) => x - y);
      if (hex.nodes.length > 0) {
        validity.push({ code: "V3", detail: `${label} carries a herald and a revenue centre; the oracle does not model both` });
      }
      addNode({
        id: `${label}/herald0`,
        hex: label,
        kind: "herald",
        cityIndex: null,
        spokes: liveEdges,
        value: bh.herald.revenue,
        slots: 0,
        transit: hex.paths.map((path) => [path.a, path.b] as const),
      });
    }

    hexes.set(label, hex);
    hex.nodes.forEach((node) => nodes.set(node.id, node));
  }

  // BOUNDARIES: an edge with a neighbour on the board and no impassable border between them.
  const impassable = new Set<string>();
  for (const border of board.impassableBorderEdges) {
    const label = byCoord.get(coordKey(border.q, border.r));
    const [dq, dr] = ORACLE_NEIGHBOUR[border.edge];
    const other = byCoord.get(coordKey(border.q + dq, border.r + dr));
    if (label) impassable.add(`${label}:${border.edge}`);
    if (other) impassable.add(`${other}:${oppositeEdge(border.edge)}`);
  }
  const boundaryAt = new Map<string, number>();
  let boundaryCount = 0;
  for (const hex of Array.from(hexes.values())) {
    for (let edge = 0; edge < 6; edge += 1) {
      const key = `${hex.label}:${edge}`;
      if (boundaryAt.has(key) || impassable.has(key)) continue;
      const [dq, dr] = ORACLE_NEIGHBOUR[edge];
      const other = byCoord.get(coordKey(hex.q + dq, hex.r + dr));
      if (!other) continue;
      const otherKey = `${other}:${oppositeEdge(edge)}`;
      boundaryAt.set(key, boundaryCount);
      boundaryAt.set(otherKey, boundaryCount);
      boundaryCount += 1;
    }
  }
  // V3: printed or laid track across an impassable border.
  for (const key of Array.from(impassable)) {
    const [label, edgeText] = key.split(":");
    const hex = hexes.get(label);
    const edge = Number(edgeText);
    const uses = hex && (hex.paths.some((path) => path.a === edge || path.b === edge) || hex.nodes.some((node) => node.spokes.includes(edge)));
    if (uses) validity.push({ code: "V3", detail: `track on ${label} crosses an impassable border at edge ${edge}` });
  }

  // STATIONS: every company's tokens bound to NODES.
  const stations = new Map<string, number[]>();
  for (const company of input.companies) {
    const seen = new Set<string>();
    for (const token of company.tokens) {
      const label = byCoord.get(coordKey(token.q, token.r));
      const bound = tokenNodeOf(label ? hexes.get(label) : undefined, token);
      if ("finding" in bound) {
        validity.push({ ...bound.finding, detail: `company ${company.companyId}: ${bound.finding.detail}` });
        continue;
      }
      if (seen.has(bound.node.hex)) {
        validity.push({ code: "V6", detail: `company ${company.companyId} holds two tokens on ${bound.node.hex}` });
      }
      seen.add(bound.node.hex);
      const holders = stations.get(bound.node.id) ?? [];
      holders.push(company.companyId);
      stations.set(bound.node.id, holders);
    }
  }
  for (const [nodeId, holders] of Array.from(stations.entries())) {
    const node = nodes.get(nodeId)!;
    if (holders.length > node.slots) {
      validity.push({ code: "V6", detail: `${nodeId} holds ${holders.length} tokens in ${node.slots} circle(s)` });
    }
  }

  // THE PRINTED TILE must be on the grid (#1301 seeds it): a grid without it is not a board the game can reach.
  for (const bh of board.hexes) {
    if (bh.printedTile && !tileAt.has(bh.label)) {
      validity.push({ code: "V8", detail: `${bh.label}'s printed tile #${bh.printedTile.tileId} is missing from the grid` });
    }
  }

  const running = input.companies.find((company) => company.companyId === companyId);
  const anchors: OracleNode[] = [];
  Array.from(stations.entries()).forEach(([nodeId, holders]) => {
    if (holders.includes(companyId)) anchors.push(nodes.get(nodeId)!);
  });
  let heraldHex: string | null = null;
  for (const bh of board.hexes) {
    if (bh.herald && bh.herald.companyId === companyId) {
      heraldHex = bh.label;
      const herald = hexes.get(bh.label)?.nodes.find((node) => node.kind === "herald");
      if (herald) anchors.push(herald);
    }
  }
  anchors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const barred = new Set<string>();
  if (input.licenceRule && (running?.licences ?? 0) <= 0) {
    Array.from(hexes.values()).forEach((hex) => {
      if (hex.coalfield) barred.add(hex.label);
    });
  }

  void boardHexByLabel;
  return { hexes, byCoord, boundaryAt, boundaryCount, nodes, stations, companyId, anchors, heraldHex, barred, policy, validity };
}

/** Whether `node` is closed to `companyId` for running THROUGH (rulebook 6.3.3 / 6.4.2): a large city whose
 *  every circle holds another railroad's station; any red off-board area that is not a warehouse. Towns,
 *  warehouses, Coal River (when not barred outright) and the herald never close. */
export function nodeClosedToTransit(graph: OracleGraph, node: OracleNode): boolean {
  switch (node.kind) {
    case "offboard":
      return true;
    case "city": {
      const holders = graph.stations.get(node.id) ?? [];
      if (holders.includes(graph.companyId)) return false;
      return node.slots > 0 && holders.length >= node.slots;
    }
    default:
      return false;
  }
}

/** Whether a route may pass through `node` from spoke `a` to spoke `b` (both distinct spokes of the node). */
export function nodeJoins(node: OracleNode, a: number, b: number): boolean {
  if (a === b) return false;
  if (!node.spokes.includes(a) || !node.spokes.includes(b)) return false;
  if (node.transit) return node.transit.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  return true;
}

export function neighbourLabel(graph: OracleGraph, label: string, edge: number): string | null {
  const hex = graph.hexes.get(label);
  if (!hex) return null;
  const [dq, dr] = ORACLE_NEIGHBOUR[edge];
  return graph.byCoord.get(coordKey(hex.q + dq, hex.r + dr)) ?? null;
}
