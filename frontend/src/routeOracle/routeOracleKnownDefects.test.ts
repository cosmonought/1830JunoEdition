/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: THE PREFLIGHT'S DEFECTS, PINNED BOTH WAYS
// ==================================================================
//
// For every fixture in `harness/knownDefects.ts`:
//
//   THE LAW (must always hold): the oracle's optimum, its legal witness, and its refusal of every route the law
//   forbids -- written by hand beside the fixture.
//
//   KNOWN-RED (production today): the defect class production falls into, what it demonstrates, and what the
//   authority answers. These are pinned AS DEFECTS. R12-2's repairs will fail them on purpose; each must then be
//   moved to the law's answer in the same reviewed change, so a repair is never silent and a regression never
//   hides behind a green suite. They are not rules.

import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { KNOWN_DEFECT_FIXTURES, parseRoute } from "./harness/knownDefects";
import { compareCase, oracleFor, probeCaseFor } from "./harness/compare";
import { productionAuthority } from "./harness/productionProbe";
import { buildOracleGraph, judgeRouteSet, judgeWaypoints } from ".";

const graphFor = (fixture: (typeof KNOWN_DEFECT_FIXTURES)[number]) =>
  buildOracleGraph({
    board: fixture.board.board,
    grid: fixture.board.lays,
    catalog: TILE_CATALOG_BY_ID,
    companies: fixture.board.companies.map((company) => ({
      companyId: company.companyId,
      tokens: company.tokens.map((token) => ({ q: token[0], r: token[1], city: token.length === 3 ? token[2] : null })),
      licences: company.licences,
    })),
    companyId: fixture.companyId,
    highTier: false,
    licenceRule: fixture.board.variants.levelPlayingField === true,
  });

describe.each(KNOWN_DEFECT_FIXTURES.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
  it(`THE LAW: ${fixture.title}`, () => {
    const solved = oracleFor(fixture.board, fixture.companyId, fixture.fleet);
    if (fixture.law.malformed) {
      // Outside the valid-state domain: the oracle names the violation and derives nothing from the state.
      expect(solved.validity.map((finding) => finding.code)).toContain("V1");
      return;
    }
    // Valid states only -- a synthetic board (production's own CROSS_TWICE) waives the tile-class check alone.
    expect(solved.validity.filter((finding) => !(fixture.board.synthetic && finding.code === "V10"))).toEqual([]);
    if (!fixture.board.synthetic) expect(solved.validity).toEqual([]);
    expect(solved.undecided).toBeNull();
    expect(solved.optimum.total).toBe(fixture.law.optimum);
    const graph = graphFor(fixture);
    for (const route of fixture.law.illegalRoutes) {
      const verdict = judgeWaypoints(graph, parseRoute(route));
      expect([route, verdict.kind]).toEqual([route, "illegal"]);
    }
    // The hand-written witness is a legal set for this fleet at exactly the optimum.
    if (fixture.law.optimum > 0) {
      const witness = fixture.law.legalWitness.map(parseRoute);
      expect(judgeRouteSet(graph, fixture.fleet, witness, witness.map((_, i) => i))).toMatchObject({ kind: "legal", total: fixture.law.optimum });
    } else {
      expect(fixture.law.legalWitness).toEqual([]);
    }
  });

  it(`KNOWN-RED (production today): ${fixture.knownProduction.primary}`, () => {
    const result = compareCase(fixture.board, fixture.companyId, fixture.fleet, true, { reducer: true });
    expect(result.production.demonstrated).toBe(fixture.knownProduction.demonstrated);
    expect(result.primary).toBe(fixture.knownProduction.primary);
    expect([...result.flags].sort()).toEqual([...fixture.knownProduction.flags].sort());
    expect(result.authorityOnProductionSet).toMatch(fixture.knownProduction.authority);
  });

  if (fixture.authorityProbes) {
    it("the authority, route by route: the law's verdict and the authority's answer today", () => {
      const probe = probeCaseFor(fixture.board, fixture.companyId, fixture.fleet);
      const graph = graphFor(fixture);
      for (const { route, law, authorityToday } of fixture.authorityProbes!) {
        const waypoints = parseRoute(route);
        const oracle = judgeWaypoints(graph, waypoints);
        expect([route, oracle.kind]).toEqual([route, law]);
        const authority = productionAuthority(probe, { routes: [waypoints], trainIndices: [0] });
        const text = authority.kind === "legal" ? `legal $${authority.total}` : `REFUSED: ${authority.reason}`;
        expect(text).toMatch(authorityToday);
      }
    });
  }
});

describe("the classification is not vacuous: every production defect class of the brief is reproduced", () => {
  it("sound-optimal, emits-illegal-optimum, fails-to-find-legal-route, permits-skip-despite-legal-route and route-phase-stranding all occur", () => {
    const classes = new Set(KNOWN_DEFECT_FIXTURES.flatMap((fixture) => fixture.knownProduction.flags));
    for (const cls of ["sound-optimal", "emits-illegal-optimum", "fails-to-find-legal-route", "permits-skip-despite-legal-route", "route-phase-stranding"]) {
      expect([cls, classes.has(cls as never)]).toEqual([cls, true]);
    }
  });
});
