// Design notes #1310-#1312: the Project 18XX+ optional tile set.
//
// THE REQUEST IS THE ORACLE, as with the board (expandedBoard.test.ts): every edge below is written in the
// request's own numbering and translated through the one `edge()` seam, the counts are the request's own,
// and the standard game is asserted unchanged before anything about the expansion is.

import { TILE_CATALOG, TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { STANDARD_TRAY, activateTray, trayInEffect, withTray } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import { edge, EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { STANDARD_BOARD, STATIC_BOARD_HEXES, activateBoard, offboardValueForEra } from "../components/hexBoardData";
import { tileArtwork, tileArtworkEdgePairs, tileCitySlotCounts } from "../components/TileGraphics";
import { filterSandboxPlacements, hexLabelRestriction } from "../components/sandboxTileLegality";
import { restrictionLabelFor } from "../components/hexCanvasPrimitives";
import { liveEdges } from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { resolveVariants } from "./gameVariants";
import { activateRules, trayFor, withRules } from "./boardSelection";
import { resetTileUpgradeGraph, tileUpgradeGraph, tileUpgradeTargets } from "./tileUpgrades";
import { eraForPhase, tileEraFor } from "./gameConstants";
import { tileStock } from "./tileSupply";
import type { GameStateResponse } from "./gameState";

const PLUS = resolveVariants({ expandedMap: true, plusTiles: true });
const STANDARD = resolveVariants({});
const NEW_IDS = [5, 6, 17, 35, 36, 87, 88, 141, 142, 143, 144, 145, 146, 147, 167, 204, 513, 592, 619, 626, 630, 631, 632, 633, 810, 882, 883, 884, 984, 997];

afterEach(() => {
  activateBoard(STANDARD_BOARD);
  activateTray(STANDARD_TRAY);
});

describe("the variant flag (design note #1310)", () => {
  it("rides on the map: no tray without the board", () => {
    expect(resolveVariants({ plusTiles: true }).plusTiles).toBe(false);
    expect(resolveVariants({ expandedMap: true, plusTiles: true }).plusTiles).toBe(true);
    expect(resolveVariants({ expandedMap: true }).plusTiles).toBe(false);
    expect(STANDARD.plusTiles).toBe(false);
  });

  it("selects the tray, and the rules put both in effect", () => {
    expect(trayFor(STANDARD)).toBe(STANDARD_TRAY);
    expect(trayFor(PLUS)).toBe(PLUS_TRAY);
    withRules(PLUS, () => expect(trayInEffect()).toBe(PLUS_TRAY));
    expect(trayInEffect()).toBe(STANDARD_TRAY);
    activateRules(PLUS);
    expect(trayInEffect()).toBe(PLUS_TRAY);
  });
});

describe("the standard tray is exactly what it was (design note #1311)", () => {
  it("holds the 46 standard tiles at their printed counts and none of the new ones", () => {
    expect(STANDARD_TRAY.counts.size).toBe(46);
    for (const entry of TILE_CATALOG) {
      if (entry.plusOnly) expect(STANDARD_TRAY.counts.has(entry.tileId)).toBe(false);
      else expect(STANDARD_TRAY.counts.get(entry.tileId)).toBe(entry.quantity);
    }
    expect(STANDARD_TRAY.counts.get(9)).toBe(7);
    expect(STANDARD_TRAY.counts.get(57)).toBe(4);
  });

  it("does not let the standard game see a tile it never had", () => {
    expect(tileStock({ game_id: 1, tiles: [] }, 141)).toBeNull();
    expect(tileStock({ game_id: 1, tiles: [] }, 513)).toBeNull();
    expect(tileStock({ game_id: 1, tiles: [] }, 57)?.printed).toBe(4);
  });
});

describe("the Project 18XX+ tray, count by count (the request, section 1)", () => {
  it("recounts the eight standard tiles the request names", () => {
    for (const [id, count] of [[9, 12], [8, 13], [7, 7], [57, 6], [14, 4], [15, 4], [59, 3], [63, 1]]) {
      expect({ id, count: PLUS_TRAY.counts.get(id) }).toEqual({ id, count });
    }
  });

  it("adds the 30 new tiles at their listed counts, and leaves every other count alone", () => {
    expect(PLUS_TRAY.counts.size).toBe(76);
    for (const id of NEW_IDS) {
      expect(STANDARD_TRAY.counts.has(id)).toBe(false);
      expect(PLUS_TRAY.counts.get(id)).toBe(TILE_CATALOG_BY_ID.get(id)!.quantity);
    }
    expect(PLUS_TRAY.counts.get(5)).toBe(2);
    expect(PLUS_TRAY.counts.get(6)).toBe(2);
    expect(PLUS_TRAY.counts.get(592)).toBe(2);
    for (const id of NEW_IDS.filter((tileId) => ![5, 6, 592].includes(tileId))) {
      expect(PLUS_TRAY.counts.get(id)).toBe(1);
    }
    for (const entry of TILE_CATALOG) {
      if (entry.plusOnly || [9, 8, 7, 57, 14, 15, 59, 63].includes(entry.tileId)) continue;
      expect(PLUS_TRAY.counts.get(entry.tileId)).toBe(entry.quantity);
    }
  });

  it("counts against the tray in effect", () => {
    withTray(PLUS_TRAY, () => {
      expect(tileStock({ game_id: 1, tiles: [] }, 57)?.printed).toBe(6);
      expect(tileStock({ game_id: 1, tiles: [] }, 141)).toEqual({ printed: 1, placed: 0, remaining: 1 });
    });
  });
});

describe("the new tiles, in the request's own edge numbers", () => {
  const codeEdges = (specEdges: number[]) => specEdges.map(edge).sort();
  const live = (id: number) => liveEdges(TILE_CATALOG_BY_ID.get(id)!.connections).sort();

  it("translates each track description", () => {
    expect(live(6)).toEqual(codeEdges([0, 2]));
    expect(live(5)).toEqual(codeEdges([0, 1]));
    expect(live(17)).toEqual(codeEdges([0, 2, 3, 5]));
    expect(live(141)).toEqual(codeEdges([0, 3, 4]));
    expect(live(142)).toEqual(codeEdges([0, 2, 3]));
    expect(live(143)).toEqual(codeEdges([0, 1, 2]));
    expect(live(144)).toEqual(codeEdges([0, 2, 4]));
    expect(live(88)).toEqual(codeEdges([0, 1, 3, 4]));
    expect(live(204)).toEqual(codeEdges([0, 2, 3, 4]));
    expect(live(87)).toEqual(codeEdges([0, 1, 2, 3]));
    expect(live(619)).toEqual(codeEdges([0, 2, 3, 4]));
    expect(live(884)).toEqual(codeEdges([0, 2, 3, 4]));
    expect(live(997)).toEqual(codeEdges([0, 2, 3, 4]));
    expect(live(883)).toEqual(codeEdges([0, 1, 2, 3]));
    expect(live(145)).toEqual(codeEdges([0, 1, 3, 4]));
    expect(live(147)).toEqual(codeEdges([0, 1, 2, 3]));
    expect(live(146)).toEqual(codeEdges([0, 2, 3, 4]));
    expect(live(513)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps the two-city tiles' cities apart", () => {
    const groups = (id: number) =>
      TILE_CATALOG_BY_ID.get(id)!.cityGroups!.map((group) => [...group].sort()).sort((a, b) => a[0] - b[0]);
    const spec = (...specs: number[][]) => specs.map(codeEdges).sort((a, b) => a[0] - b[0]);
    expect(groups(626)).toEqual(spec([0, 1], [3, 4]));
    expect(groups(36)).toEqual(spec([0, 2], [3, 5]));
    expect(groups(35)).toEqual(spec([0, 2], [1, 3]));
    expect(groups(984)).toEqual(spec([0, 1], [2, 3]));
    expect(groups(167)).toEqual(spec([0, 1, 3], [2, 4, 5]));
    // Two towns, two separate tracks.
    const paths = (id: number) => TILE_CATALOG_BY_ID.get(id)!.paths!.map((p) => [...p].sort()).sort((a, b) => a[0] - b[0]);
    expect(paths(630)).toEqual(spec([4, 5], [1, 3]));
    expect(paths(631)).toEqual(spec([0, 1], [3, 5]));
    expect(paths(632)).toEqual(spec([4, 5], [2, 3]));
    expect(paths(633)).toEqual(spec([4, 5], [1, 2]));
  });

  it("carries the agreed revenues and tiers", () => {
    const tile = (id: number) => TILE_CATALOG_BY_ID.get(id)!;
    expect([tile(5).revenue, tile(6).revenue]).toEqual([20, 20]);
    for (const id of [630, 631, 632, 633, 141, 142, 143, 144, 88, 204, 87]) expect(tile(id).revenue).toBe(10);
    expect(tile(619).revenue).toBe(30);
    expect(tile(592).revenue).toBe(50);
    expect(tile(626).revenue).toBe(40);
    for (const id of [884, 997]) expect(tile(id).revenue).toBe(40);
    expect(tile(883).revenue).toBe(90); // the same figure as #62, per the ruling
    for (const id of [145, 146, 147]) expect(tile(id).revenue).toBe(20);
    for (const id of [36, 35, 984]) expect(tile(id).revenue).toBe(50);
    expect(tile(167).revenue).toBe(70);
    expect(tile(513).revenue).toBe(60);
    expect(tile(17).revenue).toBeUndefined();
    expect([tile(167).color, tile(513).color]).toEqual(["Gray", "Gray"]);
    // #1317: the Toronto pair -- green then brown, per-station $50 then $70, the TO family.
    expect([tile(810).color, tile(882).color]).toEqual(["Green", "Brown"]);
    expect([tile(810).revenue, tile(882).revenue]).toEqual([50, 70]);
    expect([tile(810).terrain, tile(882).terrain]).toEqual(["TorontoHub", "TorontoHub"]);
    expect(tile(592).terrain).toBe("BostonHub"); // both B hexes, per the ruling
    expect(tile(883).terrain).toBe("NewYorkHub");
    for (const id of [626, 36, 35, 984, 167]) expect(tile(id).terrain).toBe("DoubleCityHub");
  });

  it("has artwork whose rails end on exactly its edges, and the stations the request describes", () => {
    for (const id of NEW_IDS) {
      const art = tileArtwork(id);
      expect({ id, art: art !== undefined }).toEqual({ id, art: true });
      const ends = new Set<number>();
      for (const pair of tileArtworkEdgePairs(id)) for (const end of pair ?? []) if (end !== null) ends.add(end);
      expect({ id, edges: Array.from(ends).sort() }).toEqual({ id, edges: live(id) });
    }
    const slots = (id: number) => tileCitySlotCounts(id);
    expect(slots(592)).toEqual([2]);
    expect(slots(619)).toEqual([2]);
    expect(slots(884)).toEqual([3]);
    expect(slots(997)).toEqual([2]);
    expect(slots(883)).toEqual([4]);
    expect(slots(513)).toEqual([3]);
    for (const id of [626, 36, 35, 984, 167]) expect(slots(id)).toEqual([1, 1]);
    expect(slots(810)).toEqual([1, 2]); // #1317: a single and a double station
    expect(slots(882)).toEqual([2, 2]);
    for (const id of [5, 6]) expect(slots(id)).toEqual([1]);
    for (const id of [141, 145, 630]) expect(slots(id)).toEqual([]);
    expect(tileArtwork(630)!.markers.filter((m) => m.kind === "town")).toHaveLength(2);
    expect(tileArtwork(141)!.markers.filter((m) => m.kind === "town")).toHaveLength(1);
  });
});

describe("the Gray era (design note #1312)", () => {
  const diesel = { tier: "D", tint: "brown" as const };
  it("opens with the first Diesel under the tile set only", () => {
    expect(eraForPhase(diesel, PLUS)).toBe("Gray");
    expect(eraForPhase(diesel, STANDARD)).toBe("Brown");
    expect(eraForPhase({ tier: "6", tint: "brown" }, PLUS)).toBe("Brown");
    expect(eraForPhase(null, PLUS)).toBe("Yellow");
  });

  it("is read off the state", () => {
    const state = (variants: object) =>
      ({ variants, public_companies: [{ company_id: 1, owned_trains: ["D"] }] } as unknown as GameStateResponse);
    expect(tileEraFor(state({ expandedMap: true, plusTiles: true }))).toBe("Gray");
    expect(tileEraFor(state({}))).toBe("Brown");
  });

  it("pays the brown figure at the red off-board areas", () => {
    expect(offboardValueForEra({ yellow: 30, brown: 60 }, "Gray")).toBe(60);
  });
});

describe("what upgrades to what, under each tray", () => {
  const under = <T,>(variants: typeof PLUS, fn: () => T) =>
    withRules(variants, () => {
      resetTileUpgradeGraph();
      try {
        return fn();
      } finally {
        resetTileUpgradeGraph();
      }
    });

  it("gives the standard game no green town, no gray city and nothing new", () => {
    under(STANDARD, () => {
      expect(tileUpgradeTargets(3)).toEqual([]);
      expect(tileUpgradeTargets(4)).toEqual([]);
      expect(tileUpgradeTargets(63)).toEqual([]);
      expect(tileUpgradeTargets(64)).toEqual([]);
      expect(tileUpgradeTargets(57)).toEqual([14, 15]);
      for (const id of NEW_IDS) expect({ id, targets: tileUpgradeTargets(id) }).toEqual({ id, targets: [] });
    });
  });

  it("runs the towns yellow to green to brown, the cities up to gray, and the OO hexes to #167", () => {
    under(PLUS, () => {
      // Yellow towns reach the green towns; green towns reach the brown ones with the same four edges.
      expect(tileUpgradeTargets(4).some((id) => [141, 142, 143, 144, 88, 204, 87].includes(id))).toBe(true);
      expect(tileUpgradeTargets(88)).toContain(145);
      expect(tileUpgradeTargets(87)).toContain(147);
      expect(tileUpgradeTargets(204)).toContain(146);
      // The yellow city now has the two new yellow cities beside it, and reaches #619 as well as #14/#15.
      expect(tileUpgradeTargets(57)).toContain(619);
      // Brown cities upgrade to the gray three-station city.
      expect(tileUpgradeTargets(63)).toContain(513);
      expect(tileUpgradeTargets(997)).toContain(513);
      // The OO hexes: green #626 beside #59, brown #36/#35/#984 beside the printed set, then gray #167.
      expect(tileUpgradeTargets(59).some((id) => [36, 35, 984].includes(id))).toBe(true);
      expect(tileUpgradeTargets(64)).toContain(167);
      // New York's second brown option, from the green #54.
      expect(tileUpgradeTargets(54)).toContain(883);
      // And Baltimore/Boston's green #592 sits beside #53 over the printed yellow.
      expect(tileUpgradeTargets(53)).toContain(61);
      expect(tileUpgradeTargets(592)).toContain(61);
      // Gray is the top: nothing follows.
      expect(tileUpgradeTargets(513)).toEqual([]);
      expect(tileUpgradeTargets(167)).toEqual([]);
    });
  });

  it("gives Toronto the TO tiles and nothing else (design note #1317)", () => {
    under(PLUS, () => {
      const graph = tileUpgradeGraph();
      expect(graph.printedHexes.get("TO")).toEqual(["D10"]);
      expect(graph.printedStarts.get("TO")).toEqual([810]);
      // The other three OO hexes keep the OO family, and D10 has left it.
      expect(graph.printedHexes.get("OO")).toEqual(["E11", "E5", "H18"]);
      expect(tileUpgradeTargets(810)).toEqual([882]);
      expect(tileUpgradeTargets(882)).toEqual([]);
    });
    under(STANDARD, () => {
      const graph = tileUpgradeGraph();
      expect(graph.printedHexes.get("TO")).toBeUndefined();
      expect(graph.printedHexes.get("OO")).toEqual(["D10", "E11", "E5", "H18"]);
      expect(graph.printedStarts.get("OO")).toEqual([59]);
    });
  });
});

describe("Toronto is printed TO on the expanded board (design note #1317)", () => {
  const everyPlacement = TILE_CATALOG.flatMap((entry) =>
    [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: entry.tileId, orientation })),
  );
  const legalAtToronto = (era: "Green" | "Brown" | "Gray", mapGrid: MapGridResponse = { game_id: 1, tiles: [] }) => {
    const toronto = STATIC_BOARD_HEXES.find((hex) => hex.label === "D10")!;
    const allowed = filterSandboxPlacements(everyPlacement, {
      mapGrid,
      q: toronto.q,
      r: toronto.r,
      era,
      networkHexes: new Set([`${toronto.q},${toronto.r}`]),
    } as never);
    return Array.from(new Set(allowed.map((entry) => entry.tile_id))).sort((a, b) => a - b);
  };

  it("takes only #810, then only #882, and nothing gray", () => {
    withRules(PLUS, () => {
      expect(hexLabelRestriction({ game_id: 1, tiles: [] }, 3, 3)).toBe("TO");
      expect(legalAtToronto("Green")).toEqual([810]);
      const withGreen: MapGridResponse = { game_id: 1, tiles: [{ q: 3, r: 3, tile_id: 810, orientation: 0, landmark: null }] };
      expect(legalAtToronto("Brown", withGreen)).toEqual([882]);
      const withBrown: MapGridResponse = { game_id: 1, tiles: [{ q: 3, r: 3, tile_id: 882, orientation: 0, landmark: null }] };
      expect(legalAtToronto("Gray", withBrown)).toEqual([]);
    });
  });

  it("is still an OO hex at a standard table", () => {
    withRules(STANDARD, () => {
      expect(hexLabelRestriction({ game_id: 1, tiles: [] }, 3, 3)).toBe("OO");
      expect(legalAtToronto("Green")).toEqual([59]);
    });
  });

  it("keeps the TO letter on the laid tiles", () => {
    expect(restrictionLabelFor("TorontoHub")).toBe("TO");
    expect(EXPANDED_BOARD.torontoHexes.has("D10")).toBe(true);
    expect(EXPANDED_BOARD.yellowOoHexes.has("D10")).toBe(true); // still a printed double city
    expect(STANDARD_BOARD.torontoHexes.size).toBe(0);
  });
});

describe("legality asks the tray (design note #1311)", () => {
  const pittsburgh = STATIC_BOARD_HEXES.find((hex) => hex.label === "H10")!;
  const fiftySeven = [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: 57, orientation }));
  const grid = (copies: number): MapGridResponse => ({
    game_id: 1,
    // Four other city hexes, far from H10, each holding a #57 -- what matters is the count.
    tiles: [
      { q: -2, r: 7, tile_id: 57, orientation: 0, landmark: null },
      { q: 7, r: 4, tile_id: 57, orientation: 0, landmark: null },
      { q: 4, r: 7, tile_id: 57, orientation: 0, landmark: null },
      { q: 4, r: 1, tile_id: 57, orientation: 0, landmark: null },
      { q: 7, r: 1, tile_id: 57, orientation: 0, landmark: null },
      { q: 2, r: 10, tile_id: 57, orientation: 0, landmark: null },
    ].slice(0, copies),
  });
  const legal = (mapGrid: MapGridResponse) =>
    filterSandboxPlacements(fiftySeven, {
      mapGrid,
      q: pittsburgh.q,
      r: pittsburgh.r,
      era: "Yellow",
      networkHexes: new Set([`${pittsburgh.q},${pittsburgh.r}`]),
    } as never);

  it("offers a tile while copies remain, and refuses the lay once the tray is empty", () => {
    expect(legal(grid(3)).length).toBeGreaterThan(0);
    expect(legal(grid(4))).toEqual([]); // the standard tray's four #57s are all out
    withTray(PLUS_TRAY, () => {
      expect(legal(grid(4)).length).toBeGreaterThan(0); // six in the Project 18XX+ tray
      expect(legal(grid(6))).toEqual([]);
    });
  });

  it("never offers a tile that is not in this game", () => {
    const greenTown = [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: 141, orientation }));
    const flint = STATIC_BOARD_HEXES.find((hex) => hex.label === "D4")!; // a printed town
    const withYellowTown: MapGridResponse = {
      game_id: 1,
      tiles: [{ q: flint.q, r: flint.r, tile_id: 4, orientation: 0, landmark: null }],
    };
    const ask = () =>
      filterSandboxPlacements(greenTown, {
        mapGrid: withYellowTown,
        q: flint.q,
        r: flint.r,
        era: "Green",
        networkHexes: new Set([`${flint.q},${flint.r}`]),
      } as never);
    expect(ask()).toEqual([]);
    withTray(PLUS_TRAY, () => expect(ask().length).toBeGreaterThan(0));
  });

  it("does not count a printed tile against the tray", () => {
    activateBoard(EXPANDED_BOARD);
    withTray(PLUS_TRAY, () => {
      const printed: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: 2, r: 7, tile_id: 24, orientation: 3, landmark: null, printed: true }],
      };
      expect(tileStock(printed, 24)?.remaining).toBe(3);
    });
  });
});
