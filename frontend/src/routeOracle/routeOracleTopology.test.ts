/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE'S TOPOLOGY AGAINST PRODUCTION'S, SOURCE BY SOURCE (C1)
// ==================================================================
//
// The oracle reads tiles from the catalog's DECLARATIVE columns (`paths`, `cityGroups`, `terrain`, `revenue`)
// and printed hexes from the board tables, through its own interpretation. Production routes on the tiles' SVG
// ARTWORK (`TileGraphics.artworkPathsForTraversal`), the catalog BITMASK (`liveEdgesForHex`) and its own
// printed-hex readers. Two different sources: where they agree tile by tile and hex by hex, a defect in one
// source cannot hide in both. Where they disagree, this test fails and the report says which side is wrong.
//
// Also checked here: each hand-transcribed oracle table against the production table it replaces (neighbours,
// train stops, station circles, printed values). The oracle does not READ those production tables; the test
// compares them.

import { STANDARD_BOARD, withBoard, type BoardDefinition } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { LPF_BOARD } from "../components/hexBoardDataLpf";
import { TILE_CATALOG, TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { tileCitySlotCounts } from "../components/TileGraphics";
import { HEX_NEIGHBOR_OFFSETS, hexValueForEra, liveEdgesForHex } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { isOffboardTerminal, neighbourAcross, traversalsFrom } from "../gameEngine/trackSegments";
import { stopForArrival } from "../gameEngine/trackReach";
import { citySlotCount } from "../gameEngine/stationTokens";
import { isRevenueCentreHex } from "../gameEngine/sandboxSession";
import { initialGridFor } from "../gameEngine/initialGrid";
import { MOCK_TRAIN_CATALOG } from "../gameEngine/mockFixtures";
import {
  ORACLE_COAL_RIVER_TIERS,
  ORACLE_NEIGHBOUR,
  ORACLE_OFFBOARD_TIERS,
  ORACLE_STANDARD_TILES,
  ORACLE_TILE_CITY_SLOTS,
  ORACLE_EXPANSION_BOARD_IDS,
  ORACLE_EXPANSION_PRINTED_CITY_SLOTS,
  ORACLE_EXPANSION_PRINTED_TIERS,
  buildOracleGraph,
  nodeJoins,
  oracleTrainStops,
  type OracleGraph,
  type OracleHex,
} from ".";

const liveOf = (hex: OracleHex) =>
  Array.from(new Set([...hex.paths.flatMap((path) => [path.a, path.b]), ...hex.nodes.filter((n) => n.kind !== "herald").flatMap((node) => node.spokes)])).sort((a, b) => a - b);

const exitsOf = (hex: OracleHex, entry: number) =>
  Array.from(
    new Set([
      ...hex.paths.filter((path) => path.a === entry || path.b === entry).map((path) => (path.a === entry ? path.b : path.a)),
      ...hex.nodes
        .filter((node) => node.kind !== "offboard" && node.kind !== "herald")
        .flatMap((node) => node.spokes.filter((out) => nodeJoins(node, entry, out))),
    ]),
  ).sort((a, b) => a - b);

const stopNumber = (hex: OracleHex, edge: number) => {
  const node = hex.nodes.find((entry) => entry.kind !== "herald" && entry.spokes.includes(edge));
  if (!node) return undefined;
  return node.kind === "city" ? node.cityIndex : Number(/(\d+)$/.exec(node.id)![1]);
};

describe("the oracle's hand-transcribed tables equal the production tables they replace", () => {
  it("neighbours", () => {
    expect(ORACLE_NEIGHBOUR.map((pair) => [...pair])).toEqual(HEX_NEIGHBOR_OFFSETS.map((pair) => [...pair]));
  });

  it("train stops (the Diesel's 999 is 'unlimited')", () => {
    for (const train of MOCK_TRAIN_CATALOG) {
      const stops = oracleTrainStops(train.modelType);
      expect([train.modelType, stops]).toEqual([train.modelType, train.maxDistance === 999 ? "unlimited" : train.maxDistance]);
    }
  });

  it("station circles per city, for every city tile", () => {
    for (const entry of TILE_CATALOG) {
      const production = tileCitySlotCounts(entry.tileId);
      const oracle = ORACLE_TILE_CITY_SLOTS[entry.tileId] ?? [];
      expect([entry.tileId, oracle]).toEqual([entry.tileId, production]);
    }
  });
});

describe("the oracle's own figures and city membership against the data both sides would otherwise share (the R12-1 review, H2)", () => {
  it("every standard 1830 tile with a stop has an oracle entry; figures and cities agree with the catalog", () => {
    const standardWithStops = TILE_CATALOG.filter((entry) => !entry.plusOnly && entry.terrain !== "Plain");
    expect(standardWithStops.map((entry) => entry.tileId).filter((id) => ORACLE_STANDARD_TILES[id] === undefined)).toEqual([]);
    for (const entry of standardWithStops) {
      const oracle = ORACLE_STANDARD_TILES[entry.tileId];
      // A recorded PRODUCTION DATA DEFECT (owner-ruled) is the one place the figures may differ.
      if (oracle.productionDefect === undefined) expect([entry.tileId, oracle.value]).toEqual([entry.tileId, entry.revenue]);
      if (oracle.cities) expect([entry.tileId, oracle.cities.map((c) => [...c])]).toEqual([entry.tileId, (entry.cityGroups ?? []).map((c) => [...c])]);
      else expect([entry.tileId, (entry.cityGroups ?? []).length <= 1]).toEqual([entry.tileId, true]);
    }
  });

  it("#62 is $80 per city (owner ruling, R12-1 repair); the catalog's $90 is the one recorded production data defect", () => {
    const defects = Object.entries(ORACLE_STANDARD_TILES).filter(([, entry]) => entry.productionDefect !== undefined).map(([id]) => Number(id));
    expect(defects).toEqual([62]);
    expect(ORACLE_STANDARD_TILES[62].value).toBe(80);
    // KNOWN-RED for R12-2: production still says $90. When R12-2 repairs the catalog this pin fails on purpose,
    // and the `productionDefect` note (and this test) come out with it.
    expect(TILE_CATALOG_BY_ID.get(62)!.revenue).toBe(90);
  });

  it("the 1830+ map's two-value gray cities (owner-confirmed): Montreal $40 / $60, Norfolk $30 / $50 -- production prices both flat", () => {
    expect(ORACLE_EXPANSION_PRINTED_TIERS).toEqual({ A19: [40, 60], L16: [30, 50] });
    for (const board of [EXPANDED_BOARD, LPF_BOARD]) {
      expect(ORACLE_EXPANSION_BOARD_IDS).toContain(board.id);
      for (const highTier of [false, true]) {
        const graph = buildOracleGraph({ board, grid: initialGridFor(board).tiles, catalog: TILE_CATALOG_BY_ID, companies: [], companyId: 99, highTier, licenceRule: false });
        expect([board.id, highTier, graph.hexes.get("A19")!.nodes[0].value, graph.hexes.get("L16")!.nodes[0].value]).toEqual([board.id, highTier, highTier ? 60 : 40, highTier ? 50 : 30]);
      }
      // KNOWN-RED for R12-2 (production data defects): production prices Montreal $40 and Norfolk $20 at BOTH
      // tiers. When R12-2 repairs the board data these pins fail on purpose.
      withBoard(board, () => {
        const grid = initialGridFor(board);
        const priced = (label: string) => {
          const hex = board.hexes.find((entry) => entry.label === label)!;
          return [hexValueForEra(grid, hex.q, hex.r, "Yellow"), hexValueForEra(grid, hex.q, hex.r, "Brown")];
        };
        expect([board.id, priced("A19"), priced("L16")]).toEqual([board.id, [40, 40], [20, 20]]);
      });
    }
    // The standard map's Montreal is one flat $40, both tiers, as before.
    const standard = (highTier: boolean) =>
      buildOracleGraph({ board: STANDARD_BOARD, grid: initialGridFor(STANDARD_BOARD).tiles, catalog: TILE_CATALOG_BY_ID, companies: [], companyId: 99, highTier, licenceRule: false });
    expect([standard(false).hexes.get("A19")!.nodes[0].value, standard(true).hexes.get("A19")!.nodes[0].value]).toEqual([40, 40]);
  });

  it("Norfolk has TWO station circles (owner correction), Montreal one (not re-ruled) -- production gives Norfolk one", () => {
    expect(ORACLE_EXPANSION_PRINTED_CITY_SLOTS).toEqual({ L16: 2 });
    for (const board of [EXPANDED_BOARD, LPF_BOARD]) {
      const grid = initialGridFor(board);
      const graph = buildOracleGraph({ board, grid: grid.tiles, catalog: TILE_CATALOG_BY_ID, companies: [], companyId: 99, highTier: false, licenceRule: false });
      expect([board.id, graph.hexes.get("L16")!.nodes.map((node) => [node.kind, node.slots])]).toEqual([board.id, [["city", 2]]]);
      expect([board.id, graph.hexes.get("A19")!.nodes.map((node) => [node.kind, node.slots])]).toEqual([board.id, [["city", 1]]]);
      // KNOWN-RED for R12-2: production still reads the superseded #1401 "single-station city" ruling for Norfolk.
      withBoard(board, () => {
        const at = (label: string) => board.hexes.find((entry) => entry.label === label)!;
        expect([board.id, citySlotCount(grid, at("L16").q, at("L16").r, 0), citySlotCount(grid, at("A19").q, at("A19").r, 0)]).toEqual([board.id, 1, 1]);
      });
    }
  });

  it.each([
    ["standard", STANDARD_BOARD],
    ["1830+", EXPANDED_BOARD],
    ["Level Playing Field", LPF_BOARD],
  ] as const)("every red area's printed pair on the %s board equals the oracle's own", (_name, board) => {
    const names = Array.from(new Set(Object.values(board.offboardLabels)));
    for (const name of names) {
      const tiers = board.offboardRevenue[name];
      expect([name, ORACLE_OFFBOARD_TIERS[name]]).toEqual([name, [tiers.yellow, tiers.brown]]);
    }
  });

  it("Coal River's tiers equal the oracle's own", () => {
    const coal = LPF_BOARD.hexes.find((hex) => hex.revenueTiers !== undefined)!;
    expect([coal.label, [...ORACLE_COAL_RIVER_TIERS]]).toEqual(["L8", [coal.revenueTiers!.yellow, coal.revenueTiers!.brown]]);
  });
});

describe("every catalog tile at every orientation: live edges, ways through, and which stop an edge enters", () => {
  const F14 = STANDARD_BOARD.hexes.find((hex) => hex.label === "F14")!;
  it.each(TILE_CATALOG.map((entry) => [entry.tileId] as const))("#%s", (tileId) => {
    for (let orientation = 0; orientation < 6; orientation += 1) {
      const tiles = [{ q: F14.q, r: F14.r, tile_id: tileId, orientation }];
      const grid = { game_id: 1, tiles: tiles.map((tile) => ({ ...tile, landmark: null })) } as MapGridResponse;
      const graph = buildOracleGraph({ board: STANDARD_BOARD, grid: tiles, catalog: TILE_CATALOG_BY_ID, companies: [], companyId: 99, highTier: false, licenceRule: false });
      const hex = graph.hexes.get("F14")!;
      withBoard(STANDARD_BOARD, () => {
        const live = liveOf(hex);
        expect([orientation, live]).toEqual([orientation, [...liveEdgesForHex(grid, F14.q, F14.r)].sort((a, b) => a - b)]);
        for (const entry of live) {
          const production = Array.from(new Set(traversalsFrom(grid, F14.q, F14.r, entry).map((way) => way.exitEdge))).sort((a, b) => a - b);
          expect([orientation, entry, exitsOf(hex, entry)]).toEqual([orientation, entry, production]);
          const stop = stopNumber(hex, entry);
          if (stop !== undefined) expect([orientation, entry, stop]).toEqual([orientation, entry, stopForArrival(grid, F14.q, F14.r, entry)]);
        }
      });
    }
  });
});

describe.each([
  ["standard", STANDARD_BOARD],
  ["1830+", EXPANDED_BOARD],
  ["Level Playing Field", LPF_BOARD],
] as const)("every printed hex of the %s board (with its opening grid)", (_name, board: BoardDefinition) => {
  const grid = initialGridFor(board);
  const graphFor = (highTier: boolean): OracleGraph =>
    buildOracleGraph({ board, grid: grid.tiles, catalog: TILE_CATALOG_BY_ID, companies: [], companyId: 99, highTier, licenceRule: board.id === "lpf" });

  it("is a valid board to the oracle", () => {
    expect(graphFor(false).validity).toEqual([]);
  });

  it("agrees on live edges, ways through, two-sided joins, revenue centres, circles and values at both tiers", () => {
    for (const highTier of [false, true]) {
      const graph = graphFor(highTier);
      withBoard(board, () => {
        for (const bh of board.hexes) {
          const hex = graph.hexes.get(bh.label)!;
          const live = liveOf(hex);
          expect([bh.label, live]).toEqual([bh.label, [...liveEdgesForHex(grid, bh.q, bh.r)].sort((a, b) => a - b)]);
          for (const entry of live) {
            const production = isOffboardTerminal(bh.q, bh.r)
              ? []
              : Array.from(new Set(traversalsFrom(grid, bh.q, bh.r, entry).map((way) => way.exitEdge))).sort((a, b) => a - b);
            expect([bh.label, entry, exitsOf(hex, entry)]).toEqual([bh.label, entry, production]);
            // Two-sided join: a boundary exists and the neighbour has track on the facing edge.
            const [dq, dr] = ORACLE_NEIGHBOUR[entry];
            const otherLabel = graph.byCoord.get(`${bh.q + dq},${bh.r + dr}`);
            const other = otherLabel ? graph.hexes.get(otherLabel)! : null;
            const joins = graph.boundaryAt.has(`${bh.label}:${entry}`) && other !== null && liveOf(other).includes((entry + 3) % 6);
            expect([bh.label, entry, joins]).toEqual([bh.label, entry, neighbourAcross(grid, bh.q, bh.r, entry) !== null]);
          }
          const centres = hex.nodes.filter((node) => node.kind !== "herald" && node.spokes.length > 0);
          if (live.length > 0) expect([bh.label, centres.length > 0]).toEqual([bh.label, isRevenueCentreHex(grid, bh.label)]);
          for (const node of centres) {
            // The recorded production data defects (Montreal / Norfolk values, Norfolk's circles) are pinned above;
            // everything else must agree.
            const expansion = ORACLE_EXPANSION_BOARD_IDS.includes(board.id);
            if (!(expansion && ORACLE_EXPANSION_PRINTED_TIERS[bh.label] !== undefined)) {
              expect([node.id, node.value]).toEqual([node.id, hexValueForEra(grid, bh.q, bh.r, highTier ? "Brown" : "Yellow")]);
            }
            if (node.kind === "city" && !(expansion && ORACLE_EXPANSION_PRINTED_CITY_SLOTS[bh.label] !== undefined)) {
              expect([node.id, node.slots]).toEqual([node.id, citySlotCount(grid, bh.q, bh.r, node.cityIndex!)]);
            }
          }
        }
      });
    }
  });
});

describe("the two-hex red areas are ONE area to the oracle (the preflight's IL-5)", () => {
  it.each([
    ["standard", STANDARD_BOARD, ["A9", "A11"], ["I1", "J2"]],
    ["1830+", EXPANDED_BOARD, ["A9", "A11"], ["K1", "L2"]],
  ] as const)("on the %s board", (_name, board, first, second) => {
    const graph = buildOracleGraph({ board, grid: initialGridFor(board).tiles, catalog: TILE_CATALOG_BY_ID, companies: [], companyId: 99, highTier: false, licenceRule: false });
    for (const pair of [first, second]) {
      const groups = pair.map((label) => graph.hexes.get(label)!.nodes[0].group);
      expect(groups[0]).toBe(groups[1]);
    }
  });

  it("the Level Playing Field has no two-hex area left: A9 and K1 are gray connectors, A11 and L2 warehouses", () => {
    const graph = buildOracleGraph({ board: LPF_BOARD, grid: initialGridFor(LPF_BOARD).tiles, catalog: TILE_CATALOG_BY_ID, companies: [], companyId: 99, highTier: false, licenceRule: true });
    expect(graph.hexes.get("A9")!.nodes).toEqual([]);
    expect(graph.hexes.get("K1")!.nodes).toEqual([]);
    expect(graph.hexes.get("A11")!.nodes.map((node) => node.kind)).toEqual(["warehouse"]);
    expect(graph.hexes.get("L2")!.nodes.map((node) => node.kind)).toEqual(["warehouse"]);
    // Every warehouse is its own area, and every remaining red area (none on the LPF board) is terminal.
    const kinds = Array.from(graph.nodes.values()).filter((node) => node.kind === "offboard" || node.kind === "warehouse").map((node) => `${node.hex}:${node.kind}`).sort();
    expect(kinds).toEqual(["A11:warehouse", "B24:warehouse", "F2:warehouse", "L2:warehouse", "M13:warehouse"]);
  });
});
