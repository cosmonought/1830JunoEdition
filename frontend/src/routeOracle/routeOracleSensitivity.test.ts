/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: THE HARNESS NOTICES A WRONG ORACLE (SEEDED DEFECTS)
// ==================================================================
//
// The preflight's section 7.8 item 5 (the R12-1 review, M7): a harness that cannot see a defect in the oracle
// certifies nothing. Each case below feeds the oracle a deliberately WRONG reading of the law -- through the
// data and switches it is given, so the oracle's own code is untouched -- and asserts that the hand-written law
// of the known-defect fixtures then fails. If a seeded defect ever went unnoticed, the fixtures would not be
// pinning what they claim to pin.

import type { BoardDefinition } from "../components/hexBoardData";
import { TILE_CATALOG_BY_ID, type TileCatalogEntry } from "../components/hexTileCatalog";
import { KNOWN_DEFECT_FIXTURES, parseRoute, type KnownDefectFixture } from "./harness/knownDefects";
import { buildOracleGraph, judgeWaypoints, solveOracleCase } from ".";

const fixture = (id: string) => KNOWN_DEFECT_FIXTURES.find((entry) => entry.id === id)!;

function optimumWith(f: KnownDefectFixture, seed: { board?: (b: BoardDefinition) => BoardDefinition; catalog?: ReadonlyMap<number, TileCatalogEntry>; licenceRule?: boolean }) {
  const board = seed.board ? seed.board(f.board.board) : f.board.board;
  return solveOracleCase({
    board,
    grid: f.board.lays,
    catalog: seed.catalog ?? TILE_CATALOG_BY_ID,
    companies: f.board.companies.map((company) => ({
      companyId: company.companyId,
      tokens: company.tokens.map((token) => ({ q: token[0], r: token[1], city: token.length === 3 ? token[2] : null })),
      licences: company.licences,
    })),
    companyId: f.companyId,
    highTier: false,
    licenceRule: seed.licenceRule ?? f.board.variants.levelPlayingField === true,
    fleet: f.fleet,
  }).optimum.total;
}

describe("seeded oracle defects are caught by the fixtures' hand-written law", () => {
  it("control: unseeded, every fixture's optimum is the law's", () => {
    for (const id of ["RED-CANADIAN-WEST", "RED-GULF", "COAL-RIVER-UNLICENSED", "WAREHOUSE-M13-PASS", "HERALD-FORK-PLUS"]) {
      expect([id, optimumWith(fixture(id), {})]).toEqual([id, fixture(id).law.optimum]);
    }
  });

  it("a two-hex red area read as two areas (the authority's IL-5 reading) -> the red-area fixtures' illegal routes turn legal", () => {
    // Seeded by renaming one half of each area to ANOTHER real area's name, so both halves still price.
    const split = (b: BoardDefinition): BoardDefinition => ({
      ...b,
      offboardLabels: Object.fromEntries(
        Object.entries(b.offboardLabels).map(([label, name]) => [label, label === "A9" ? "Gulf" : label === "J2" ? "Chicago" : name]),
      ),
    });
    for (const id of ["RED-CANADIAN-WEST", "RED-GULF"]) {
      const f = fixture(id);
      const graph = buildOracleGraph({
        board: split(f.board.board),
        grid: f.board.lays,
        catalog: TILE_CATALOG_BY_ID,
        companies: f.board.companies.map((company) => ({
          companyId: company.companyId,
          tokens: company.tokens.map((token) => ({ q: token[0], r: token[1], city: token.length === 3 ? token[2] : null })),
          licences: company.licences,
        })),
        companyId: f.companyId,
        highTier: false,
        licenceRule: false,
      });
      expect([id, judgeWaypoints(graph, parseRoute(f.law.illegalRoutes[0])).kind]).toEqual([id, "legal"]);
      expect([id, optimumWith(f, { board: split })]).not.toEqual([id, f.law.optimum]);
    }
  });

  it("Coal River open to everyone (the licence rule dropped) -> the unlicensed fixture fails", () => {
    expect(optimumWith(fixture("COAL-RIVER-UNLICENSED"), { licenceRule: false })).not.toBe(0);
  });

  it("warehouses read as ordinary terminal red areas -> the pass-through fixture fails", () => {
    const terminal = (b: BoardDefinition): BoardDefinition => ({
      ...b,
      hexes: b.hexes.map((hex) => (hex.warehouse ? { ...hex, warehouse: undefined } : hex)),
    });
    expect(optimumWith(fixture("WAREHOUSE-M13-PASS"), { board: terminal })).not.toBe(fixture("WAREHOUSE-M13-PASS").law.optimum);
  });

  it("the Y tile read as a triangle (prong to prong allowed) -> the herald fork fixture fails", () => {
    const catalog = new Map(TILE_CATALOG_BY_ID);
    const y = catalog.get(24)!;
    catalog.set(24, { ...y, paths: [...(y.paths ?? []), [2, 3] as const] });
    expect(optimumWith(fixture("HERALD-FORK-PLUS"), { catalog })).not.toBe(fixture("HERALD-FORK-PLUS").law.optimum);
  });
});
