// Design notes #1300/#1301: the Project 18XX+ board, checked against the request it was built from.
//
// THE REQUEST IS THE ORACLE. Every edge here is written in the request's own numbering (0 NE, clockwise) and
// every expectation names the neighbour the request implies, so a wrong translation, a wrong coordinate or a
// wrong stub fails by naming the hex it pointed at instead. The census at the end is the request's own
// count, reconciled once (water 16 is the pure-terrain count: the OO/New York water hexes are not in it).

import {
  STANDARD_BOARD,
  STATIC_BOARD_HEXES,
  GRAY_HEXES,
  OFFBOARD_LABELS,
  OFFBOARD_TRACKS,
  OFFBOARD_HIDDEN_EDGES,
  OFFBOARD_REVENUE,
  NAMED_HEX_LABELS,
  activateBoard,
  terrainBuildFeeAt,
  withBoard,
} from "../components/hexBoardData";
import { EXPANDED_BOARD, axialOf, edge } from "../components/hexBoardDataPlus";
import { HEX_NEIGHBOR_OFFSETS, boardHexExistsAt, liveEdgesForHex, rotateConnections, liveEdges } from "../components/hexGeometry";
import { printedArtworkEdgePairs } from "../components/TileGraphics";
import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { initialGridFor } from "./initialGrid";
import { tileStock } from "./tileSupply";

const at = (label: string) => axialOf(label);

/** The label the board's edge `codeEdge` of `label` points at. */
function neighbourAcross(label: string, codeEdge: number): string | null {
  const { q, r } = at(label);
  const [dq, dr] = HEX_NEIGHBOR_OFFSETS[codeEdge];
  return STATIC_BOARD_HEXES.find((hex) => hex.q === q + dq && hex.r === r + dr)?.label ?? null;
}

describe("the two edge conventions", () => {
  it("translates the request's clockwise-from-NE numbering to the board's", () => {
    // Request: 0 NE, 1 E, 2 SE, 3 SW, 4 W, 5 NW. Board: 0 E, 1 NE, 2 NW, 3 W, 4 SW, 5 SE.
    expect([0, 1, 2, 3, 4, 5].map(edge)).toEqual([1, 0, 5, 4, 3, 2]);
  });

  it("agrees with the board's own neighbour offsets", () => {
    withBoard(EXPANDED_BOARD, () => {
      // Montreal's request edges 2, 3, 4 (SE, SW, W) must land on B20, B18, A17.
      expect(neighbourAcross("A19", edge(2))).toBe("B20");
      expect(neighbourAcross("A19", edge(3))).toBe("B18");
      expect(neighbourAcross("A19", edge(4))).toBe("A17");
    });
  });

  it("derives the axial coordinate every existing entry already satisfies", () => {
    for (const hex of STANDARD_BOARD.hexes) expect(axialOf(hex.label)).toEqual({ q: hex.q, r: hex.r });
    expect(axialOf("L16")).toEqual({ q: 2, r: 11 });
    expect(axialOf("M13")).toEqual({ q: 0, r: 12 });
    expect(() => axialOf("L15")).toThrow();
  });
});

describe("the expansion is a delta and the standard board is untouched", () => {
  it("leaves the standard board exactly as it was", () => {
    expect(STANDARD_BOARD.hexes).toHaveLength(93);
    expect(STANDARD_BOARD.hexes.some((hex) => hex.label === "I1")).toBe(true);
    expect(STANDARD_BOARD.offboardLabels.K13).toBe("Deep South");
    expect(STANDARD_BOARD.grayHexes.K15).toBeDefined();
    expect(STANDARD_BOARD.namedHexLabels.H16).toBe("Lancaster");
  });

  it("keeps every hex the request did not name", () => {
    const changed = new Set([
      "B20", "H12", "I9", "J2", "J4", "J6", "J8", "J16", "J18",
      "K1", "K3", "K5", "K7", "K9", "K11", "K13", "K15", "K17",
      "L2", "L4", "L6", "L8", "L10", "L12", "L14", "L16", "M9", "M11", "M13",
    ]);
    const expanded = new Map(EXPANDED_BOARD.hexes.map((hex) => [hex.label, hex]));
    for (const hex of STANDARD_BOARD.hexes) {
      if (hex.label === "I1") {
        expect(expanded.has("I1")).toBe(false);
        continue;
      }
      if (changed.has(hex.label)) continue;
      expect(expanded.get(hex.label)).toBe(hex); // the SAME object, not a copy that agrees
    }
  });
});

describe("the expanded board, hex by hex (the request, section 1)", () => {
  beforeAll(() => activateBoard(EXPANDED_BOARD));
  afterAll(() => activateBoard(STANDARD_BOARD));

  const hexOf = (label: string) => STATIC_BOARD_HEXES.find((hex) => hex.label === label);

  it("A17 is gray with tile-39 connectivity: E, SE and SW", () => {
    expect(hexOf("A17")?.printedColor).toBe("Gray");
    expect([...GRAY_HEXES.A17.edges].sort()).toEqual([edge(1), edge(2), edge(3)].sort());
    expect(neighbourAcross("A17", edge(1))).toBe("A19");
    expect(neighbourAcross("A17", edge(2))).toBe("B18");
    expect(neighbourAcross("A17", edge(3))).toBe("B16");
    // Three curves, one per pair.
    const pairs = printedArtworkEdgePairs("A17").map((pair) => (pair ? [...pair].sort() : null));
    expect(pairs).toHaveLength(3);
    expect(pairs).toContainEqual([edge(1), edge(2)].sort());
    expect(pairs).toContainEqual([edge(2), edge(3)].sort());
    expect(pairs).toContainEqual([edge(1), edge(3)].sort());
  });

  it("A19 Montreal is a gray single-station city on SE, SW and W (#1401)", () => {
    expect(GRAY_HEXES.A19).toEqual({ edges: [edge(2), edge(3), edge(4)], marker: "city" });
    expect(NAMED_HEX_LABELS.A19).toBe("Montreal");
    expect(EXPANDED_BOARD.printedArtwork?.A19?.marker?.slots ?? 1).toBe(1);
  });

  it("B20 is the double town Plattsburgh & Burlington", () => {
    expect(hexOf("B20")?.townDesignation).toBe("double");
    expect(NAMED_HEX_LABELS.B20).toBe("Plattsburgh & Burlington");
  });

  it("H12 is a printed green #24 joining W to E and W to SE, not a city and not gray", () => {
    const h12 = hexOf("H12");
    expect(h12?.printedColor).toBeUndefined();
    expect(h12?.cityDesignation).toBeUndefined();
    expect(GRAY_HEXES.H12).toBeUndefined();
    expect(h12?.printedTile).toEqual({ tileId: 24, orientation: 3 });
    const grid = initialGridFor(EXPANDED_BOARD);
    expect(grid.tiles).toEqual([expect.objectContaining({ q: 2, r: 7, tile_id: 24, orientation: 3, printed: true })]);
    // Live edges W, E, SE -- and the two paths are exactly W-E and W-SE.
    expect(liveEdgesForHex(grid, 2, 7).sort()).toEqual([edge(1), edge(2), edge(4)].sort());
    const entry = TILE_CATALOG_BY_ID.get(24)!;
    const rotated = entry.paths!.map(([a, b]) => [(a + 3) % 6, (b + 3) % 6].sort());
    expect(rotated).toContainEqual([edge(4), edge(1)].sort());
    expect(rotated).toContainEqual([edge(4), edge(2)].sort());
    expect(liveEdges(rotateConnections(entry.connections, 3)).sort()).toEqual([edge(1), edge(2), edge(4)].sort());
  });

  it("the printed tile does not come out of the tray", () => {
    const grid = initialGridFor(EXPANDED_BOARD);
    expect(tileStock(grid, 24)).toEqual({ printed: 3, placed: 0, remaining: 3 });
    expect(initialGridFor(STANDARD_BOARD).tiles).toEqual([]);
  });

  it("H16 is Reading, and the double town beside Allentown is Bethlehem now", () => {
    expect(NAMED_HEX_LABELS.H16).toBe("Reading");
    expect(NAMED_HEX_LABELS.G17).toBe("Bethlehem & Allentown"); // #1313
    expect(STANDARD_BOARD.namedHexLabels.G17).toBe("Reading & Allentown");
  });

  it("I1 is gone; J2 and the listed hexes are water at the standard fee", () => {
    expect(hexOf("I1")).toBeUndefined();
    for (const label of ["I9", "J2", "J4", "J6", "J8", "J16", "J18", "K15", "K17"]) {
      expect(hexOf(label)?.type).toBe("River");
      const { q, r } = at(label);
      expect(terrainBuildFeeAt(q, r)).toBe(80);
    }
    expect(OFFBOARD_LABELS.J2).toBeUndefined();
    expect(OFFBOARD_LABELS.I1).toBeUndefined();
  });

  it("I19 Atlantic City is a gray town on NW, W and SW", () => {
    expect(GRAY_HEXES.I19).toEqual({ edges: [edge(5), edge(4), edge(3)], marker: "town" });
    expect(neighbourAcross("I19", edge(5))).toBe("H18");
    expect(neighbourAcross("I19", edge(4))).toBe("I17");
    expect(neighbourAcross("I19", edge(3))).toBe("J18");
  });

  it("K1 + L2 are Chattanooga, with the Gulf's stubs and revenue", () => {
    expect(OFFBOARD_LABELS.K1).toBe("Chattanooga");
    expect(OFFBOARD_LABELS.L2).toBe("Chattanooga");
    expect(OFFBOARD_REVENUE.Chattanooga).toEqual(STANDARD_BOARD.offboardRevenue.Gulf);
    expect(OFFBOARD_REVENUE.Gulf).toBeUndefined();
    expect(OFFBOARD_TRACKS.K1).toEqual([edge(1)]);
    expect(OFFBOARD_TRACKS.L2).toEqual([edge(1), edge(0)]);
    expect(neighbourAcross("K1", edge(1))).toBe("K3");
    expect(neighbourAcross("L2", edge(1))).toBe("L4");
    expect(neighbourAcross("L2", edge(0))).toBe("K3");
    // The shared seam faces itself from both sides.
    expect(neighbourAcross("K1", OFFBOARD_HIDDEN_EDGES.K1)).toBe("L2");
    expect(neighbourAcross("L2", OFFBOARD_HIDDEN_EDGES.L2)).toBe("K1");
    expect(OFFBOARD_HIDDEN_EDGES.I1).toBeUndefined();
    expect(OFFBOARD_HIDDEN_EDGES.A9).toBeDefined(); // Canadian West untouched
  });

  it("K3 Lexington, K13 Richmond and K7 Huntington are blank cities; K7 is an $80 mountain", () => {
    for (const [label, name] of [["K3", "Lexington"], ["K13", "Richmond"], ["K7", "Huntington"]] as const) {
      expect(hexOf(label)?.cityDesignation).toBe(true);
      expect(NAMED_HEX_LABELS[label]).toBe(name);
    }
    expect(hexOf("K7")?.type).toBe("Mountain");
    expect(terrainBuildFeeAt(at("K7").q, at("K7").r)).toBe(80);
    for (const label of ["K9", "K11", "L6", "L8", "L10"]) {
      expect(hexOf(label)?.type).toBe("Mountain");
      expect(terrainBuildFeeAt(at(label).q, at(label).r)).toBe(120);
    }
    expect(OFFBOARD_LABELS.K13).toBeUndefined();
    expect(GRAY_HEXES.K15).toBeUndefined();
    expect(NAMED_HEX_LABELS.K15).toBeUndefined();
  });

  it("plain hexes: K5, L4, L12, L14, M11", () => {
    for (const label of ["K5", "L4", "L12", "L14", "M11"]) {
      const hex = hexOf(label);
      expect(hex?.type).toBe("Plain");
      expect(hex?.cityDesignation).toBeUndefined();
      expect(hex?.townDesignation).toBeUndefined();
      expect(hex?.printedColor).toBeUndefined();
    }
  });

  it("L16 Norfolk is a gray single-station city on W, NW and NE (#1401)", () => {
    expect(hexOf("L16")?.printedColor).toBe("Gray");
    expect(GRAY_HEXES.L16).toEqual({ edges: [edge(4), edge(5), edge(0)], marker: "city" });
    expect(neighbourAcross("L16", edge(4))).toBe("L14");
    expect(neighbourAcross("L16", edge(5))).toBe("K15");
    expect(neighbourAcross("L16", edge(0))).toBe("K17");
    expect(NAMED_HEX_LABELS.L16).toBe("Norfolk");
  });

  it("M13 is the Deep South, $30/$40, with separate stubs to NW, NE and W", () => {
    expect(OFFBOARD_LABELS.M13).toBe("Deep South");
    expect(OFFBOARD_REVENUE["Deep South"]).toEqual({ yellow: 30, brown: 40 });
    expect(OFFBOARD_TRACKS.M13).toEqual([edge(5), edge(0), edge(4)]);
    expect(neighbourAcross("M13", edge(5))).toBe("L12");
    expect(neighbourAcross("M13", edge(0))).toBe("L14");
    expect(neighbourAcross("M13", edge(4))).toBe("M11"); // #1313
  });

  it("M9 is a $120 mountain and M11 a plain hex (#1313)", () => {
    expect(hexOf("M9")?.type).toBe("Mountain");
    expect(terrainBuildFeeAt(at("M9").q, at("M9").r)).toBe(120);
    expect(hexOf("M11")?.type).toBe("Plain");
    expect(hexOf("M11")?.cityDesignation).toBeUndefined();
  });

  it("no printed track on any hex points off the board", () => {
    const tracks: Array<[string, readonly number[]]> = [
      ...Object.entries(GRAY_HEXES).map(([label, track]) => [label, track.edges] as [string, readonly number[]]),
      ...Object.entries(OFFBOARD_TRACKS),
    ];
    for (const [label, edges] of tracks) {
      const { q, r } = at(label);
      for (const e of edges) {
        const [dq, dr] = HEX_NEIGHBOR_OFFSETS[e];
        expect(`${label} edge ${e} -> ${boardHexExistsAt(q + dq, r + dr)}`).toBe(`${label} edge ${e} -> true`);
      }
    }
  });

  it("every gray hex's artwork uses exactly its table's edges", () => {
    for (const [label, track] of Object.entries(GRAY_HEXES)) {
      const used = new Set<number>();
      for (const pair of printedArtworkEdgePairs(label)) {
        for (const end of pair ?? []) if (end !== null) used.add(end);
      }
      expect({ label, edges: Array.from(used).sort() }).toEqual({ label, edges: [...track.edges].sort() });
    }
  });
});

describe("the census (the request's own count, reconciled)", () => {
  const hexes = EXPANDED_BOARD.hexes;
  const OO = EXPANDED_BOARD.yellowOoHexes;
  const gray = EXPANDED_BOARD.grayHexes;
  const label = (hex: { label: string }) => hex.label;
  const isCity = (hex: (typeof hexes)[number]) =>
    !OO.has(hex.label) &&
    (hex.cityDesignation === true ||
      gray[hex.label]?.marker === "city" ||
      hex.printedColor === "Yellow" ||
      hex.label === "H12"); // PRR's herald counts as its home city in the request's tally

  it("has 112 hexes -- the 110 of the request plus M9 and M11 (#1313)", () => {
    expect(hexes).toHaveLength(112);
    expect(new Set(hexes.map(label)).size).toBe(112);
  });

  it("matches the request's categories", () => {
    const offboard = hexes.filter((hex) => hex.type === "RedOffboard");
    expect(offboard).toHaveLength(7);
    expect(new Set(offboard.map((hex) => EXPANDED_BOARD.offboardLabels[hex.label])).size).toBe(5); // areas

    const water = hexes.filter((hex) => hex.type === "River");
    expect(water).toHaveLength(19); // every hex that charges the $80 water fee
    expect(water.filter((hex) => !OO.has(hex.label) && hex.label !== "G19")).toHaveLength(16); // the request's 16

    expect(hexes.filter((hex) => hex.type === "Mountain")).toHaveLength(18); // 17 + M9 (#1313)
    expect(hexes.filter((hex) => hex.printedColor === "Gray")).toHaveLength(11); // fixed
    expect(hexes.filter((hex) => OO.has(hex.label))).toHaveLength(4);
    expect(hexes.filter((hex) => hex.townDesignation === "single" || gray[hex.label]?.marker === "town")).toHaveLength(6);
    expect(hexes.filter((hex) => hex.townDesignation === "double")).toHaveLength(4);
    expect(hexes.filter(isCity).map(label).sort()).toEqual(
      ["A19", "B10", "B16", "D14", "D2", "E19", "E23", "F16", "F22", "F4", "F6", "G19", "H10", "H12", "H16", "H4", "I15", "J14", "K13", "K3", "K7", "L16"],
    );
  });
});
