/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: THE ORACLE AGAINST HAND-WORKED BOARDS AND A BRUTE-FORCE WALK
// ==================================================================
//
// Three independent checks of the oracle, none of which asks production anything:
//
//   1. HAND EXPECTATIONS. Small boards (the same shapes `routeAuthority.test.ts` builds) with every legal route
//      and every optimum written out by hand from the rulebook, beside the board.
//   2. A BRUTE-FORCE WALK that knows nothing of the law: every walk along the track (any centre, any spoke,
//      any rail) up to a length, handed to the standalone checker `judgeRoute`. The DFS enumerator must produce
//      exactly the walks the checker accepts -- no more (soundness of the generator) and no fewer
//      (completeness). Run over the hand boards, every known-defect fixture, and seeded random boards.
//   3. THE PACKING against an exhaustive product of every route choice, on small fleets.

import { STANDARD_BOARD } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { LPF_BOARD } from "../components/hexBoardDataLpf";
import { TILE_CATALOG, TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import {
  buildOracleGraph,
  canonicalRouteKey,
  enumerateRoutes,
  judgeRoute,
  judgeRouteSet,
  judgeWaypoints,
  neighbourLabel,
  optimumRouteSet,
  oppositeEdge,
  solveOracleCase,
  type OracleCaseInput,
  type OracleGraph,
  type OraclePolicy,
  type RouteVisit,
} from ".";
import { KNOWN_DEFECT_FIXTURES } from "./harness/knownDefects";

type Lay = [label: string, tileId: number, orientation: number];
const CO = 5;
const BO = 4;
const PRR = 1;

function caseOn(
  board = STANDARD_BOARD,
  lays: Lay[],
  companies: Array<{ companyId: number; tokens: Array<[string, number | null]>; licences?: number }>,
  companyId = CO,
  policy?: OraclePolicy,
): OracleCaseInput {
  const at = (label: string) => {
    const hex = board.hexes.find((entry) => entry.label === label)!;
    return { q: hex.q, r: hex.r };
  };
  const printed = board.hexes.flatMap((hex) =>
    hex.printedTile ? [{ q: hex.q, r: hex.r, tile_id: hex.printedTile.tileId, orientation: hex.printedTile.orientation }] : [],
  );
  // A lay replaces the printed tile on its hex (an upgrade of H12's #24, say).
  const tiles = new Map<string, { q: number; r: number; tile_id: number; orientation: number }>();
  [...printed, ...lays.map(([label, tile_id, orientation]) => ({ ...at(label), tile_id, orientation }))].forEach((tile) =>
    tiles.set(`${tile.q},${tile.r}`, tile),
  );
  return {
    board,
    grid: Array.from(tiles.values()),
    catalog: TILE_CATALOG_BY_ID,
    companies: companies.map((company) => ({
      companyId: company.companyId,
      tokens: company.tokens.map(([label, city]) => ({ ...at(label), city })),
      licences: company.licences ?? 0,
    })),
    companyId,
    highTier: false,
    licenceRule: false,
    policy,
  };
}

/** Every legal route as waypoint text with its value, e.g. `"I5>I7 $40"`. `*` marks a bypass, `:n` a city. */
function routeTable(input: OracleCaseInput): string[] {
  const solved = solveOracleCase({ ...input, fleet: ["D"] });
  expect(solved.undecided).toBeNull();
  return solved.routes
    .map((route) => {
      const hexes = route.visits.map((visit) => {
        if (visit.element.kind === "path") {
          const hex = solved.graph.hexes.get(visit.hex)!;
          return hex.nodes.length > 0 ? `${visit.hex}*` : visit.hex;
        }
        const cities = solved.graph.hexes.get(visit.hex)!.nodes.filter((node) => node.kind === "city").length;
        return cities > 1 ? `${visit.hex}:${visit.element.node.cityIndex}` : visit.hex;
      });
      const forward = hexes.join(">");
      const backward = [...hexes].reverse().join(">");
      return `${forward < backward ? forward : backward} $${route.value}`;
    })
    .sort();
}

const optimum = (input: OracleCaseInput, fleet: string[]) => {
  const solved = solveOracleCase({ ...input, fleet });
  expect(solved.undecided).toBeNull();
  return solved.optimum.total;
};

/* ------------------------------------------------------------------ */
/* The hand boards                                                    */
/* ------------------------------------------------------------------ */

const LINE: Lay[] = [["I5", 57, 0], ["I7", 57, 0], ["I9", 57, 0]]; // three $20 cities on one straight
const GULF: Lay[] = [...LINE, ["I3", 8, 4]]; // I3 gentle curve: edge 4 to the Gulf (J2), edge 0 to I5
const CROSS: Lay[] = [["I5", 57, 0], ["I7", 20, 0], ["I9", 57, 0], ["H8", 57, 1], ["J6", 57, 1]];
const FORK: Lay[] = [["I5", 57, 0], ["I7", 24, 0], ["I9", 57, 0], ["H6", 57, 2]];
const LOOP: Lay[] = [["I3", 57, 0], ["I5", 63, 0], ["I7", 7, 3], ["J6", 7, 1]];
const DOUBLE_TOWN: Lay[] = [["I5", 57, 0], ["I7", 1, 0], ["H8", 7, 4], ["I9", 7, 2], ["J6", 57, 1]];
const TWO_CITIES: Lay[] = [["I7", 59, 0], ["I9", 57, 0], ["H6", 57, 2]];

describe("hand-worked boards: every legal route, and the optimum, written out by hand", () => {
  it("LINE: from I5, the two routes east; I7>I9 carries no C&O station", () => {
    const input = caseOn(STANDARD_BOARD, LINE, [{ companyId: CO, tokens: [["I5", 0]] }]);
    expect(routeTable(input)).toEqual(["I5>I7 $40", "I5>I7>I9 $60"]);
    expect(optimum(input, ["2"])).toBe(40);
    expect(optimum(input, ["3"])).toBe(60);
    // I5 has one track east: a second train has nothing that avoids the first's.
    expect(optimum(input, ["2", "2"])).toBe(40);
  });

  it("GULF: the red area ends a route, is priced at $30 before the first 5-train, and two trains share I5 on different spokes", () => {
    const input = caseOn(STANDARD_BOARD, GULF, [{ companyId: CO, tokens: [["I5", 0]] }]);
    expect(routeTable(input)).toEqual([
      "I5>I3>J2 $50",
      "I5>I7 $40",
      "I5>I7>I9 $60",
      "I7>I5>I3>J2 $70",
      "I9>I7>I5>I3>J2 $90",
    ]);
    expect(optimum(input, ["2"])).toBe(50);
    expect(optimum(input, ["3"])).toBe(70);
    expect(optimum(input, ["2", "2"])).toBe(90); // I5>I3>J2 + I5>I7
    expect(optimum(input, ["2", "3"])).toBe(110); // I5>I3>J2 + I5>I7>I9
    expect(optimum({ ...input, highTier: true }, ["2"])).toBe(80); // the Gulf pays $60 from the first 5-train
  });

  it("CROSS: the crossover's two straights never meet -- H8 and J6 are not reachable from I5", () => {
    const input = caseOn(STANDARD_BOARD, CROSS, [{ companyId: CO, tokens: [["I5", 0]] }]);
    expect(routeTable(input)).toEqual(["I5>I7>I9 $40"]);
  });

  it("FORK: a Y is run stem to prong only; prong to prong is a reversal", () => {
    const input = caseOn(STANDARD_BOARD, FORK, [{ companyId: CO, tokens: [["I5", 0]] }]);
    expect(routeTable(input)).toEqual(["I5>I7>I9 $40"]);
    const fromH6 = caseOn(STANDARD_BOARD, FORK, [{ companyId: CO, tokens: [["H6", 0]] }]);
    expect(routeTable(fromH6)).toEqual(["H6>I7>I9 $40"]);
  });

  it("LOOP: a route may not come back into the city it left", () => {
    const input = caseOn(STANDARD_BOARD, LOOP, [{ companyId: CO, tokens: [["I5", 0]] }]);
    // I3's #57 runs 0 / 3, and edge 3 is the Gulf's I1: the Gulf ($30) ends the westward route. Nothing may
    // come back into I5 around the I7 / J6 loop.
    expect(routeTable(input)).toEqual(["I1>I3>I5 $90", "I3>I5 $60"]);
  });

  it("DOUBLE_TOWN: the two towns of #1 are two stops; one route may visit both by re-entering the hex", () => {
    const input = caseOn(STANDARD_BOARD, DOUBLE_TOWN, [{ companyId: CO, tokens: [["I5", 0]] }]);
    expect(routeTable(input)).toEqual([
      "I5>I7 $30",
      "I5>I7>H8>I9>I7 $40",
      "I5>I7>H8>I9>I7>J6 $60",
    ]);
    expect(optimum(input, ["2"])).toBe(30);
    expect(optimum(input, ["3"])).toBe(40);
    expect(optimum(input, ["4"])).toBe(60);
  });

  it("TWO_CITIES: an OO tile is two cities; a station in one is not a station in the other", () => {
    const fromI9 = caseOn(STANDARD_BOARD, TWO_CITIES, [{ companyId: CO, tokens: [["I9", 0]] }]);
    expect(routeTable(fromI9)).toEqual(["I7:0>I9 $60"]);
    const inCity1 = caseOn(STANDARD_BOARD, TWO_CITIES, [{ companyId: CO, tokens: [["I7", 1]] }]);
    expect(routeTable(inCity1)).toEqual(["H6>I7:1 $60"]);
  });

  it("BLOCKING: a city filled with another railroad's station ends a route but is never run through", () => {
    const input = caseOn(STANDARD_BOARD, LINE, [
      { companyId: CO, tokens: [["I5", 0]] },
      { companyId: BO, tokens: [["I7", 0]] },
    ]);
    expect(routeTable(input)).toEqual(["I5>I7 $40"]);
    expect(optimum(input, ["3"])).toBe(40);
    // B&O's own station opens its own city.
    const bo = caseOn(STANDARD_BOARD, LINE, [
      { companyId: CO, tokens: [["I5", 0]] },
      { companyId: BO, tokens: [["I7", 0]] },
    ], BO);
    expect(routeTable(bo)).toEqual(["I5>I7 $40", "I5>I7>I9 $60", "I7>I9 $40"]);
  });

  it("HERALD (1830+): PRR's herald is a stop, an end, and -- ONLY when counted -- a station (IL-2 YES, IL-3 NO)", () => {
    const lays: Lay[] = [["H10", 57, 0], ["H14", 57, 0]];
    const input = caseOn(EXPANDED_BOARD, lays, [{ companyId: PRR, tokens: [] }], PRR);
    // H10>H12*>H14 ($40, the herald passed uncounted) is NOT a route: PRR has no station on it (IL-3 NO).
    expect(routeTable(input)).toEqual(["H10>H12 $30", "H10>H12>H14 $50", "H12>H14 $30"]);
    expect(optimum(input, ["2"])).toBe(30);
    expect(optimum(input, ["3"])).toBe(50);
    expect(optimum(input, ["2", "2"])).toBe(60); // both trains leave the herald on its two rails
    // The SEEDED pre-ruling reading (an uncounted pass is a station) is noticed: it adds the $40 pass.
    const seeded = caseOn(EXPANDED_BOARD, lays, [{ companyId: PRR, tokens: [] }], PRR, { heraldUncountedIsStation: true });
    expect(routeTable(seeded)).toEqual(["H10>H12 $30", "H10>H12*>H14 $40", "H10>H12>H14 $50", "H12>H14 $30"]);
    expect(optimum(seeded, ["2"])).toBe(40);
    // Nobody else sees a herald: for NYC, H12 is plain track.
    const nyc = caseOn(EXPANDED_BOARD, lays, [{ companyId: 2, tokens: [["H10", 0]] }], 2);
    expect(routeTable(nyc)).toEqual(["H10>H12>H14 $40"]);
  });
});

/* ------------------------------------------------------------------ */
/* The herald rulings (R12-1 repair): IL-2, IL-3, IL-4, IL-11          */
/* ------------------------------------------------------------------ */

// REENTRY: H12 upgraded to brown #44 (turn 0: rails E-NE [0,1], E-W [0,3], NE-SW [1,4], W-SW [3,4]; E-SW and
// NE-W are NOT joined). H10 #57 (a $20 city on its E edge), I11 #57 turned 1 (a $20 city on its NE edge, which
// faces H12's SW), and a plain loop leaving H12 east and coming back into its NE edge: H14 #7 turned 2 (W-NW),
// G13 #7 turned 4 (SW-SE). A route may therefore cross H12 twice, E-W and NE-SW, on distinct sections.
const REENTRY: Lay[] = [["H12", 44, 0], ["H10", 57, 0], ["I11", 57, 1], ["H14", 7, 2], ["G13", 7, 4]];
// CROSSING: H12 as green #19 (two sections that never meet: E-W [0,3] and NW-SW [2,4]), a $20 city at each of
// the four ends: H10 #57, H14 #57, G11 #57 turned 2 (its SE edge faces H12), I11 #57 turned 1.
const CROSSING: Lay[] = [["H12", 19, 0], ["H10", 57, 0], ["H14", 57, 0], ["G11", 57, 2], ["I11", 57, 1]];
// Y_LOOP: H12's own printed #24 (stem W 3, prongs E 0 and SE 5; prong to prong is not a rail), H14 #57, and a
// plain loop from the SE prong round to the stem: I13 #7 turned 2, I11 #8, H10 #7 turned 5.
const Y_LOOP: Lay[] = [["H14", 57, 0], ["H10", 7, 5], ["I11", 8, 0], ["I13", 7, 2]];
// IL4: #44 again, with a $20 city on each of its four live edges: H10 #57 (PRR's token), H14 #57, G13 #57
// turned 1 (its SW edge faces H12's NE), I11 #57 turned 1.
const IL4: Lay[] = [["H12", 44, 0], ["H10", 57, 0], ["H14", 57, 0], ["G13", 57, 1], ["I11", 57, 1]];

describe("IL-11 (ruled): H12 may be re-entered on distinct track; the herald is counted at most once, and a pass never uses it up", () => {
  const bare = () => caseOn(EXPANDED_BOARD, REENTRY, [{ companyId: PRR, tokens: [] }], PRR);
  const withH10 = () => caseOn(EXPANDED_BOARD, REENTRY, [{ companyId: PRR, tokens: [["H10", 0]] }], PRR);

  it("every legal route, by hand (PRR from its herald alone)", () => {
    // Ends: H10 ($20), I11 ($20), the herald ($10). Through H12 once: counted 3->4 (a rail) is $50; passed
    // uncounted it has no station. Through H12 twice (E-W, then NE-SW via the loop): count on the first
    // crossing or the second ($50 each, two different routes), never on both, never on neither (no station).
    // The loop routes that END on the herald count it once, on their second arrival. #44's E-NE rail is
    // unusable: whatever leaves by one loop edge must come back by the other.
    expect(routeTable(bare())).toEqual([
      "H10>H12 $30",
      "H10>H12*>H14>G13>H12 $30", // PASS then COUNT (ending on it)
      "H10>H12*>H14>G13>H12>I11 $50", // PASS then COUNT (running through it)
      "H10>H12>H14>G13>H12*>I11 $50", // COUNT then PASS
      "H10>H12>I11 $50",
      "H12>H14>G13>H12*>I11 $30", // COUNT (starting on it) then PASS
      "H12>I11 $30",
    ]);
    expect(optimum(bare(), ["2"])).toBe(30);
    expect(optimum(bare(), ["3"])).toBe(50);
    expect(optimum(bare(), ["2", "2"])).toBe(60); // H10>H12 + H12>I11: two trains, two different rails
    expect(optimum(bare(), ["3", "2"])).toBe(60); // every $50 route uses both H10|H12 and H12|I11
  });

  it("pass then count, and count then pass, are both legal messages at $50", () => {
    const graph = buildOracleGraph(bare());
    expect(judgeWaypoints(graph, [{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "H14" }, { hex: "G13" }, { hex: "H12" }, { hex: "I11" }])).toMatchObject({ kind: "legal", stops: 3, value: 50 });
    expect(judgeWaypoints(graph, [{ hex: "H10" }, { hex: "H12" }, { hex: "H14" }, { hex: "G13" }, { hex: "H12", bypass: true }, { hex: "I11" }])).toMatchObject({ kind: "legal", stops: 3, value: 50 });
  });

  it("two uncounted passes: no station without a token (IL-3); legal with PRR's token on H10", () => {
    const twoPasses = [{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "H14" }, { hex: "G13" }, { hex: "H12", bypass: true }, { hex: "I11" }];
    const noToken = judgeWaypoints(buildOracleGraph(bare()), twoPasses);
    expect(noToken.kind === "illegal" && noToken.reason).toMatch(/must include a city holding one of the railroad's stations/);
    expect(judgeWaypoints(buildOracleGraph(withH10()), twoPasses)).toMatchObject({ kind: "legal", stops: 2, value: 40 });
    // With the token, the two pass-only routes join the table; nothing else changes.
    expect(routeTable(withH10())).toEqual([
      "H10>H12 $30",
      "H10>H12*>H14>G13>H12 $30",
      "H10>H12*>H14>G13>H12*>I11 $40", // two legal uncounted passes
      "H10>H12*>H14>G13>H12>I11 $50",
      "H10>H12*>I11 $40",
      "H10>H12>H14>G13>H12*>I11 $50",
      "H10>H12>I11 $50",
      "H12>H14>G13>H12*>I11 $30",
      "H12>I11 $30",
    ]);
  });

  it("an attempted double count is refused, and the enumerator never makes one", () => {
    const graph = buildOracleGraph(bare());
    const twice = judgeWaypoints(graph, [{ hex: "H10" }, { hex: "H12" }, { hex: "H14" }, { hex: "G13" }, { hex: "H12" }, { hex: "I11" }]);
    expect(twice.kind === "illegal" && twice.reason).toMatch(/includes H12\/herald0 twice/);
    // Ending a loop on the herald it started from is the same double count.
    const loop = judgeWaypoints(graph, [{ hex: "H12" }, { hex: "H14" }, { hex: "G13" }, { hex: "H12" }]);
    expect(loop.kind === "illegal" && loop.reason).toMatch(/includes H12\/herald0 twice/);
    const solved = solveOracleCase({ ...bare(), fleet: ["D"] });
    for (const route of solved.routes) {
      const heralds = route.visits.filter((visit) => visit.element.kind === "node" && visit.element.node.kind === "herald").length;
      expect([route.key, heralds <= 1]).toEqual([route.key, true]);
    }
  });

  it("a second crossing may not reuse track: the Y's stem, used by a pass, cannot carry the herald's route out again", () => {
    // Y_LOOP, by hand: the herald ends a route on the E prong; or the route STARTS on the herald (arriving along
    // the SE prong), loops round through I13 / I11 / H10, and crosses H12 again stem -> E prong uncounted to
    // H14 -- count then pass, on three distinct pieces of the Y. Nothing else: the herald may not also be run
    // through SE prong -> stem, because the loop comes back in along that same stem.
    const input = caseOn(EXPANDED_BOARD, Y_LOOP, [{ companyId: PRR, tokens: [] }], PRR);
    expect(routeTable(input)).toEqual(["H12>H14 $30", "H12>I13>I11>H10>H12*>H14 $30"]);
    const graph = buildOracleGraph(input);
    const hex = (label: string) => graph.hexes.get(label)!;
    const herald = hex("H12").nodes.find((node) => node.kind === "herald")!;
    const pathOn = (label: string, a: number, b: number) => hex(label).paths.find((path) => (path.a === a && path.b === b) || (path.a === b && path.b === a))!;
    const visits: RouteVisit[] = [
      { hex: "H14", element: { kind: "node", node: hex("H14").nodes[0] }, entry: null, exit: 3 },
      { hex: "H12", element: { kind: "path", path: pathOn("H12", 0, 3) }, entry: 0, exit: 3 }, // pass E -> W (stem)
      { hex: "H10", element: { kind: "path", path: pathOn("H10", 0, 5) }, entry: 0, exit: 5 },
      { hex: "I11", element: { kind: "path", path: pathOn("I11", 2, 0) }, entry: 2, exit: 0 },
      { hex: "I13", element: { kind: "path", path: pathOn("I13", 3, 2) }, entry: 3, exit: 2 },
      // Back in by the SE prong: counting the herald and leaving by the stem reuses the stem's H12|H10 track
      // (and would go round the loop again to the herald: refused at the first reuse).
      { hex: "H12", element: { kind: "node", node: herald }, entry: 5, exit: 3 },
      { hex: "H10", element: { kind: "path", path: pathOn("H10", 0, 5) }, entry: 0, exit: 5 },
      { hex: "I11", element: { kind: "path", path: pathOn("I11", 2, 0) }, entry: 2, exit: 0 },
      { hex: "I13", element: { kind: "path", path: pathOn("I13", 3, 2) }, entry: 3, exit: 2 },
      { hex: "H12", element: { kind: "node", node: herald }, entry: 5, exit: null },
    ];
    const verdict = judgeRoute(graph, visits);
    expect(verdict.legal === false && verdict.reason).toMatch(/uses the track between H12 and H10 twice/);
    // Stopping there instead (the route's end) is the legal pass-then-count.
    expect(judgeRoute(graph, [...visits.slice(0, 5), { hex: "H12", element: { kind: "node", node: herald }, entry: 5, exit: null }])).toMatchObject({ legal: true, stops: 2, value: 30 });
  });

  it("the virtual city joins nothing the track does not: no bridge between #19's two sections, no prong-to-prong on the Y", () => {
    // CROSSING, by hand: the herald ends a route on any of its four rails ($30 each), or is run through along
    // either section ($50). The four "joins" across the crossing are not routes.
    const crossing = caseOn(EXPANDED_BOARD, CROSSING, [{ companyId: PRR, tokens: [] }], PRR);
    expect(routeTable(crossing)).toEqual(["G11>H12 $30", "G11>H12>I11 $50", "H10>H12 $30", "H10>H12>H14 $50", "H12>H14 $30", "H12>I11 $30"]);
    const graph = buildOracleGraph(crossing);
    const herald = graph.hexes.get("H12")!.nodes.find((node) => node.kind === "herald")!;
    const city = (label: string) => graph.hexes.get(label)!.nodes[0];
    const bridge = judgeRoute(graph, [
      { hex: "H10", element: { kind: "node", node: city("H10") }, entry: null, exit: 0 },
      { hex: "H12", element: { kind: "node", node: herald }, entry: 3, exit: 4 },
      { hex: "I11", element: { kind: "node", node: city("I11") }, entry: 1, exit: null },
    ]);
    expect(bridge.legal === false && bridge.reason).toMatch(/No rail through H12\/herald0 joins edge 3 to edge 4/);
    expect(judgeWaypoints(graph, [{ hex: "H10" }, { hex: "H12" }, { hex: "I11" }]).kind).toBe("illegal");
    // The Y (H12's printed #24, cities on both prongs): prong to prong through the herald is not a route.
    const y = caseOn(EXPANDED_BOARD, [["H14", 57, 0], ["I13", 57, 2]], [{ companyId: PRR, tokens: [] }], PRR);
    expect(routeTable(y)).toEqual(["H12>H14 $30", "H12>I13 $30"]);
    expect(judgeWaypoints(buildOracleGraph(y), [{ hex: "I13" }, { hex: "H12" }, { hex: "H14" }]).kind).toBe("illegal");
  });
});

describe("IL-4 (ruled): separate PRR trains meet H12 independently", () => {
  const input = () => caseOn(EXPANDED_BOARD, IL4, [{ companyId: PRR, tokens: [["H10", 0]] }], PRR);
  const set = (routes: Array<Array<{ hex: string; bypass?: boolean }>>) => judgeRouteSet(buildOracleGraph(input()), ["3", "3"], routes, routes.map((_, i) => i));

  it("one train counts the herald while the other passes it, on separate track: legal, $50 + $40", () => {
    expect(set([[{ hex: "G13" }, { hex: "H12" }, { hex: "H14" }], [{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "I11" }]])).toEqual({ kind: "legal", total: 90, perRoute: [50, 40] });
  });

  it("each route needs its own station: a pass is not saved by another train's count", () => {
    const verdict = set([[{ hex: "H10" }, { hex: "H12" }, { hex: "I11" }], [{ hex: "G13" }, { hex: "H12", bypass: true }, { hex: "H14" }]]);
    expect(verdict.kind === "illegal" && verdict.reason).toMatch(/Route 2: .*must include a city holding one of the railroad's stations/);
  });

  it("they may not share track (the H10|H12 boundary here)", () => {
    const verdict = set([[{ hex: "H10" }, { hex: "H12" }], [{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "I11" }]]);
    expect(verdict.kind === "illegal" && verdict.reason).toMatch(/Route 2 shares track/);
  });

  it("the optimum: two trains may each count it on separate rails -- the ordinary rule for a city, which IL-2 makes it", () => {
    // By hand: no route has more than two $20 cities and the herald ($50); two such routes on disjoint rails of
    // #44 (e.g. H10>H12>I11 on W-SW and G13>H12>H14 on NE-E) make $100.
    expect(optimum(input(), ["3", "3"])).toBe(100);
    expect(optimum(input(), ["3"])).toBe(50);
  });
});

/* ------------------------------------------------------------------ */
/* Warehouses (R12-1 repair ruling)                                   */
/* ------------------------------------------------------------------ */

describe("warehouses (ruled): a city for revenue and capacity -- counted when traversed, an end, never a block, never counted twice", () => {
  // The WAREHOUSE-M13 fixture's layout on the Level Playing Field: C&O at Richmond K13 (#57 turned 1), L12 #8
  // turned 5, the Deep South warehouse M13, M11's printed straight, M9 #8, Coal River L8 ($40, licensed); then
  // (TWO_WAREHOUSES) L6 and L4 #9 on to the Chattanooga warehouse L2. Both warehouses pay $30 before the first
  // 5-train. A real, valid board: no tile off its class.
  const M13: Lay[] = [["K13", 57, 1], ["L12", 8, 5], ["M9", 8, 0]];
  const TWO_WAREHOUSES: Lay[] = [...M13, ["L6", 9, 0], ["L4", 9, 0]];
  const lpf = (lays: Lay[], licences: number) => ({ ...caseOn(LPF_BOARD, lays, [{ companyId: CO, tokens: [["K13", 0]], licences }]), licenceRule: true });

  it("traversing M13 counts it: a 2-train cannot reach Coal River through it, a 3-train can", () => {
    const input = lpf(M13, 1);
    expect(routeTable(input)).toEqual(["K13>L12>M13 $50", "K13>L12>M13>M11>M9>L8 $90"]);
    expect(optimum(input, ["2"])).toBe(50); // NOT $60 = K13 + L8 with the warehouse skipped
    expect(optimum(input, ["3"])).toBe(90);
    const graph = buildOracleGraph(input);
    const through = [{ hex: "K13" }, { hex: "L12" }, { hex: "M13" }, { hex: "M11" }, { hex: "M9" }, { hex: "L8" }];
    expect(judgeRouteSet(graph, ["2"], [through], [0])).toMatchObject({ kind: "illegal", reason: expect.stringMatching(/counts 3 cities; a 2-train counts 2/) });
    // There is no plain track beside a warehouse to "bypass" it along.
    expect(judgeWaypoints(graph, through.map((wp) => (wp.hex === "M13" ? { ...wp, bypass: true } : wp))).kind).toBe("illegal");
  });

  it("seeded: a warehouse that could be run past uncounted (a silent pass) changes the 2-train optimum -- so the law is pinned", () => {
    const graph = buildOracleGraph(lpf(M13, 1));
    const m13 = graph.hexes.get("M13")!;
    m13.paths.push({ id: "M13/seeded-pass", hex: "M13", a: 2, b: 3, bypass: true });
    const routes = enumerateRoutes(graph, { maxStops: 2, budget: 5_000_000, selfCheck: true }).routes;
    expect(optimumRouteSet(routes, [{ trainIndex: 0, model: "2" }], 1_000_000).total).toBe(60);
  });

  it("a warehouse ends a route (unlicensed: Coal River is shut, M13 is the end)", () => {
    expect(routeTable(lpf(M13, 0))).toEqual(["K13>L12>M13 $50"]);
  });

  it("no cap on warehouses: one route counts both M13 and L2 ($120 on a 4-train)", () => {
    const input = lpf(TWO_WAREHOUSES, 1);
    expect(routeTable(input)).toEqual(["K13>L12>M13 $50", "K13>L12>M13>M11>M9>L8 $90", "K13>L12>M13>M11>M9>L8>L6>L4>L2 $120"]);
    expect(optimum(input, ["4"])).toBe(120);
    expect(optimum(input, ["3"])).toBe(90);
  });

  it("the same warehouse is never counted twice on one route (A11 by two of its stubs)", () => {
    const graph = buildOracleGraph(caseOn(LPF_BOARD, [["B10", 14, 1]], [{ companyId: CO, tokens: [["B10", 0]] }]));
    const twice = judgeWaypoints(graph, [{ hex: "A11" }, { hex: "A9" }, { hex: "B10" }, { hex: "A11" }]);
    expect(twice.kind === "illegal" && twice.reason).toMatch(/includes area:Canadian West twice/);
  });
});

describe("Norfolk (L16), owner-corrected: ONE city with TWO station circles, paying $30 / $50", () => {
  // Level Playing Field. Richmond K13 #57 turned 2 (edges 2 / 5; 5 faces L14), L14 #8 (edges 0 / 2: Norfolk to
  // Richmond), K15 #9 turned 2 (edges 2 / 5: Norfolk to Washington), Washington J14 #57 turned 2 (5 faces K15). A
  // valid board. C&O's station is at Richmond; N&W's home (company 10) is Norfolk; B&O (4) may take its second circle.
  const NORFOLK: Lay[] = [["K13", 57, 2], ["L14", 8, 0], ["K15", 9, 2], ["J14", 57, 2]];
  const NW = 10;
  const withTokens = (norfolk: Array<{ companyId: number }>, runner = CO) =>
    caseOn(LPF_BOARD, NORFOLK, [{ companyId: CO, tokens: [["K13", 0]] }, ...norfolk.map((entry) => ({ companyId: entry.companyId, tokens: [["L16", 0]] as Array<[string, number | null]> }))], runner);

  it("the graph binds every Norfolk token to its one city node, which has two circles", () => {
    const graph = buildOracleGraph(withTokens([{ companyId: NW }, { companyId: BO }]));
    expect(graph.hexes.get("L16")!.nodes.map((node) => [node.id, node.kind, node.cityIndex, node.slots])).toEqual([["L16/city0", "city", 0, 2]]);
    expect(graph.stations.get("L16/city0")).toEqual([NW, BO]);
    expect(graph.validity).toEqual([]);
    // Not two cities: a token recorded in a "city 1" names a city Norfolk does not have (V2) ...
    const second = caseOn(LPF_BOARD, NORFOLK, [{ companyId: CO, tokens: [["K13", 0]] }, { companyId: NW, tokens: [["L16", 0]] }, { companyId: BO, tokens: [["L16", 1]] }]);
    expect(buildOracleGraph(second).validity.map((finding) => finding.code)).toEqual(["V2"]);
    // ... and a third token does not fit its two circles (V6).
    const third = caseOn(LPF_BOARD, NORFOLK, [
      { companyId: CO, tokens: [["K13", 0], ["L16", 0]] },
      { companyId: NW, tokens: [["L16", 0]] },
      { companyId: BO, tokens: [["L16", 0]] },
    ]);
    expect(buildOracleGraph(third).validity.map((finding) => finding.code)).toEqual(["V6"]);
  });

  it("N&W's home alone does not block Norfolk: C&O runs through it, counting it once", () => {
    const input = withTokens([{ companyId: NW }]);
    // By hand: K13>L14>L16 ($20 + $30) and through Norfolk to Washington ($20 + $30 + $20). Nothing else has track.
    expect(routeTable(input)).toEqual(["J14>K15>L16>L14>K13 $70", "K13>L14>L16 $50"]);
    expect(optimum(input, ["2"])).toBe(50);
    expect(optimum(input, ["3"])).toBe(70);
    expect(optimum({ ...input, highTier: true }, ["3"])).toBe(90); // Norfolk $50 from the first 5-train
    // One city, one stop: the through-route counts three stops, not four.
    expect(judgeWaypoints(buildOracleGraph(input), [{ hex: "K13" }, { hex: "L14" }, { hex: "L16" }, { hex: "K15" }, { hex: "J14" }])).toMatchObject({ kind: "legal", stops: 3, value: 70 });
    // Either N&W token binding (city 0 or no city recorded) is the same one node: a bare token binds on a one-city hex.
    const bare = caseOn(LPF_BOARD, NORFOLK, [{ companyId: CO, tokens: [["K13", 0]] }, { companyId: NW, tokens: [["L16", null]] }]);
    expect(buildOracleGraph(bare).stations.get("L16/city0")).toEqual([NW]);
  });

  it("N&W's home plus one foreign token fill Norfolk: C&O may end there but not run through", () => {
    const input = withTokens([{ companyId: NW }, { companyId: BO }]);
    expect(routeTable(input)).toEqual(["K13>L14>L16 $50"]);
    expect(optimum(input, ["3"])).toBe(50);
    const through = judgeWaypoints(buildOracleGraph(input), [{ hex: "K13" }, { hex: "L14" }, { hex: "L16" }, { hex: "K15" }, { hex: "J14" }]);
    expect(through.kind === "illegal" && through.reason).toMatch(/L16\/city0 is filled with other railroads' stations/);
  });

  it("the second circle's holder is not blocked by the full city: its own station opens it", () => {
    const input = withTokens([{ companyId: NW }, { companyId: BO }], BO);
    expect(routeTable(input)).toEqual(["J14>K15>L16 $50", "J14>K15>L16>L14>K13 $70", "K13>L14>L16 $50"]);
  });
});

describe("Montreal (A19), owner-corrected: ONE city with TWO station circles, paying $40 / $60 (1830+ / LPF)", () => {
  // Level Playing Field. Montreal's printed spokes: W (A17), SW (B18), SE (B20). A17 is the printed gray connector
  // (edges E 0 -> A19, SW 4 -> B16, SE 5 -> B18, joined pair by pair). Ottawa B16 #57 turned 1 (edges 1 / 4; 1 faces A17); B20 (a
  // double-town hex) #55 turned 1 (towns on 1 / 4 and 2 / 5; 2 faces A19, $10). A valid board. The runner is ERIE
  // (6) with its station at Ottawa; CPR (3) and NYC (2) may hold Montreal's circles.
  const MONTREAL: Lay[] = [["B16", 57, 1], ["B20", 55, 1]];
  const ERIE = 6;
  const CPR = 3;
  const NYC = 2;
  const tokens = (montreal: number[], runner = ERIE) =>
    caseOn(
      LPF_BOARD,
      MONTREAL,
      [
        { companyId: ERIE, tokens: [["B16", 0]] },
        ...montreal.map((companyId) => ({ companyId, tokens: [["A19", 0]] as Array<[string, number | null]> })),
      ],
      runner,
    );

  it("both tokens bind to the one node A19/city0 (two circles); a 'city 1' token is invalid; a third does not fit", () => {
    const graph = buildOracleGraph(tokens([CPR, NYC]));
    expect(graph.hexes.get("A19")!.nodes.map((node) => [node.id, node.kind, node.cityIndex, node.slots])).toEqual([["A19/city0", "city", 0, 2]]);
    expect(graph.stations.get("A19/city0")).toEqual([CPR, NYC]);
    expect(graph.validity).toEqual([]);
    const second = caseOn(LPF_BOARD, MONTREAL, [{ companyId: ERIE, tokens: [["B16", 0]] }, { companyId: CPR, tokens: [["A19", 0]] }, { companyId: NYC, tokens: [["A19", 1]] }]);
    expect(buildOracleGraph(second).validity.map((finding) => finding.code)).toEqual(["V2"]);
    const third = caseOn(LPF_BOARD, MONTREAL, [{ companyId: ERIE, tokens: [["B16", 0], ["A19", 0]] }, { companyId: CPR, tokens: [["A19", 0]] }, { companyId: NYC, tokens: [["A19", 0]] }]);
    expect(buildOracleGraph(third).validity.map((finding) => finding.code)).toEqual(["V6"]);
  });

  it("one foreign token does not block Montreal: ERIE runs through it, counting it once", () => {
    const input = tokens([CPR]);
    // By hand: Ottawa also reaches Kingston (C15, the printed $10 town on its SW edge). ERIE's routes: Ottawa-Kingston
    // ($30); Montreal-Ottawa ($60) and on to Kingston ($70); THROUGH Montreal from Ottawa to the B20 town ($70); and
    // the whole line, town to town through both cities ($10 + $40 + $20 + $10 = $80).
    expect(routeTable(input)).toEqual([
      "A19>A17>B16 $60",
      "A19>A17>B16>C15 $70",
      "B16>A17>A19>B20 $70",
      "B16>C15 $30",
      "B20>A19>A17>B16>C15 $80",
    ]);
    expect(optimum(input, ["3"])).toBe(70);
    expect(optimum(input, ["4"])).toBe(80);
    expect(optimum({ ...input, highTier: true }, ["3"])).toBe(90); // Montreal $60 from the first 5-train
    expect(judgeWaypoints(buildOracleGraph(input), [{ hex: "B16" }, { hex: "A17" }, { hex: "A19" }, { hex: "B20" }])).toMatchObject({ kind: "legal", stops: 3, value: 70 });
  });

  it("two foreign tokens fill Montreal: ERIE (no token there) may end there but not run through", () => {
    const input = tokens([CPR, NYC]);
    // The two routes through Montreal are gone; everything ending there stays.
    expect(routeTable(input)).toEqual(["A19>A17>B16 $60", "A19>A17>B16>C15 $70", "B16>C15 $30"]);
    expect(optimum(input, ["4"])).toBe(70); // was $80 with one token
    const through = judgeWaypoints(buildOracleGraph(input), [{ hex: "B16" }, { hex: "A17" }, { hex: "A19" }, { hex: "B20" }]);
    expect(through.kind === "illegal" && through.reason).toMatch(/A19\/city0 is filled with other railroads' stations/);
  });

  it("a corporation holding one of the two circles still runs through the full city (the ordinary rule)", () => {
    // CPR, with NYC in the other circle: from Montreal west to Ottawa ($60), east to the town ($50), and straight
    // through ($70). Ottawa (ERIE's one circle) is an end only, so Kingston is out of reach.
    expect(routeTable(tokens([CPR, NYC], CPR))).toEqual(["A19>A17>B16 $60", "A19>B20 $50", "B16>A17>A19>B20 $70"]);
  });

  it("the standard map's Montreal is unchanged: one circle, one token fills it", () => {
    const graph = buildOracleGraph(caseOn(STANDARD_BOARD, [], [{ companyId: CPR, tokens: [["A19", 0]] }], ERIE));
    expect(graph.hexes.get("A19")!.nodes.map((node) => node.slots)).toEqual([1]);
  });
});

describe("metamorphic: the answer does not depend on the order the board is written in", () => {
  it("permuting corporations and their tokens leaves every legal route and the optimum unchanged", () => {
    const companies = [
      { companyId: CO, tokens: [["I5", 0], ["I9", 0]] as Array<[string, number | null]> },
      { companyId: BO, tokens: [["I7", 0]] as Array<[string, number | null]> },
    ];
    const a = caseOn(STANDARD_BOARD, GULF, companies);
    const b = caseOn(STANDARD_BOARD, [...GULF].reverse(), [...companies].reverse().map((company) => ({ ...company, tokens: [...company.tokens].reverse() })));
    expect(routeTable(b)).toEqual(routeTable(a));
    expect(optimum(b, ["3", "2"])).toBe(optimum(a, ["2", "3"]));
  });

  it("a waypoint list read backwards is the same route: same verdict, same price", () => {
    const graph = buildOracleGraph(caseOn(STANDARD_BOARD, GULF, [{ companyId: CO, tokens: [["I5", 0]] }]));
    for (const route of [["J2", "I3", "I5", "I7", "I9"], ["I5", "I7"], ["I9", "I7", "I5", "I3"]]) {
      const forward = judgeWaypoints(graph, route.map((hex) => ({ hex })));
      const backward = judgeWaypoints(graph, [...route].reverse().map((hex) => ({ hex })));
      expect([route.join(">"), backward.kind, backward.kind === "legal" ? backward.value : null]).toEqual([
        route.join(">"),
        forward.kind,
        forward.kind === "legal" ? forward.value : null,
      ]);
    }
  });
});

describe("the judge: waypoint semantics", () => {
  it("an interior waypoint enters the centre when one joins its edges; `bypass` runs the bow and visits nothing", () => {
    const input = caseOn(STANDARD_BOARD, [["H10", 57, 0], ["H14", 57, 0]], [{ companyId: PRR, tokens: [["H12", null]] }], PRR);
    const graph = buildOracleGraph(input);
    const through = judgeWaypoints(graph, [{ hex: "H10" }, { hex: "H12" }, { hex: "H14" }]);
    expect(through).toMatchObject({ kind: "legal", stops: 3, value: 50 });
    const bow = judgeWaypoints(graph, [{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "H14" }]);
    expect(bow.kind).toBe("illegal"); // the bow visits no PRR station
    expect(bow.kind === "illegal" && bow.reason).toMatch(/must include a city holding one of the railroad's stations/);
  });

  it("a flag must mean something: a city_node the track does not run through, or a bypass with nothing to bypass, is refused", () => {
    const altoona = buildOracleGraph(caseOn(STANDARD_BOARD, [["H10", 57, 0], ["H14", 57, 0]], [{ companyId: CO, tokens: [["H10", 0]] }]));
    expect(judgeWaypoints(altoona, [{ hex: "H10" }, { hex: "H12", city_node: 1 }, { hex: "H14" }]).kind).toBe("illegal");
    expect(judgeWaypoints(altoona, [{ hex: "H10" }, { hex: "H12", bypass: true, city_node: 0 }, { hex: "H14" }]).kind).toBe("illegal");
    const line = buildOracleGraph(caseOn(STANDARD_BOARD, [["I5", 57, 0], ["I7", 9, 0], ["I9", 57, 0]], [{ companyId: CO, tokens: [["I5", 0]] }]));
    expect(judgeWaypoints(line, [{ hex: "I5" }, { hex: "I7", bypass: true }, { hex: "I9" }]).kind).toBe("illegal");
    expect(judgeWaypoints(line, [{ hex: "I5" }, { hex: "I7" }, { hex: "I9" }])).toMatchObject({ kind: "legal", value: 40 });
  });

  it("refuses a waypoint list that is not a walk, and a named city the track does not enter", () => {
    const graph = buildOracleGraph(caseOn(STANDARD_BOARD, TWO_CITIES, [{ companyId: CO, tokens: [["I9", 0]] }]));
    expect(judgeWaypoints(graph, [{ hex: "I9" }, { hex: "I5" }]).kind).toBe("illegal");
    expect(judgeWaypoints(graph, [{ hex: "I9" }, { hex: "I7", city_node: 1 }]).kind).toBe("illegal");
    expect(judgeWaypoints(graph, [{ hex: "I9" }, { hex: "I7", city_node: 0 }])).toMatchObject({ kind: "legal", value: 60 });
  });
});

/* ------------------------------------------------------------------ */
/* The brute-force walk                                               */
/* ------------------------------------------------------------------ */

/** Every walk along the track of at most `maxVisits` visits, judged ONLY by `judgeRoute`. */
function bruteForceLegalKeys(graph: OracleGraph, maxVisits: number): Set<string> {
  const legal = new Set<string>();
  const visits: RouteVisit[] = [];
  const extend = () => {
    if (visits.length >= maxVisits) return;
    const last = visits[visits.length - 1];
    const next = neighbourLabel(graph, last.hex, last.exit!);
    if (next === null) return;
    const arrival = oppositeEdge(last.exit!);
    const hex = graph.hexes.get(next)!;
    for (const path of hex.paths) {
      if (path.a !== arrival && path.b !== arrival) continue;
      visits.push({ hex: next, element: { kind: "path", path }, entry: arrival, exit: path.a === arrival ? path.b : path.a });
      extend();
      visits.pop();
    }
    for (const node of hex.nodes) {
      if (!node.spokes.includes(arrival)) continue;
      const visit: RouteVisit = { hex: next, element: { kind: "node", node }, entry: arrival, exit: null };
      visits.push(visit);
      if (judgeRoute(graph, visits).legal) legal.add(canonicalRouteKey(visits));
      for (const out of node.spokes) {
        if (out === arrival) continue;
        visit.exit = out;
        extend();
      }
      visit.exit = null;
      visits.pop();
    }
  };
  Array.from(graph.nodes.values()).forEach((node) => {
    for (const spoke of node.spokes) {
      visits.push({ hex: node.hex, element: { kind: "node", node }, entry: null, exit: spoke });
      extend();
      visits.pop();
    }
  });
  return legal;
}

function dfsKeys(graph: OracleGraph, maxVisits: number): Set<string> {
  const result = enumerateRoutes(graph, { maxStops: Number.POSITIVE_INFINITY, budget: 50_000_000, selfCheck: true });
  expect(result.exhausted).toBe(false);
  return new Set(result.routes.filter((route) => route.visits.length <= maxVisits).map((route) => route.key));
}

function expectSameKeys(graph: OracleGraph, maxVisits: number) {
  const brute = bruteForceLegalKeys(graph, maxVisits);
  const dfs = dfsKeys(graph, maxVisits);
  const missing = Array.from(brute).filter((key) => !dfs.has(key));
  const extra = Array.from(dfs).filter((key) => !brute.has(key));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  return brute.size;
}

/** A tiny integer PRNG (LCG, Numerical Recipes constants) so every seed is reproducible without floats. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % bound;
  };
}

describe("the brute-force walk agrees with the DFS enumerator", () => {
  it.each([
    ["LINE", LINE],
    ["GULF", GULF],
    ["CROSS", CROSS],
    ["FORK", FORK],
    ["LOOP", LOOP],
    ["DOUBLE_TOWN", DOUBLE_TOWN],
    ["TWO_CITIES", TWO_CITIES],
  ] as const)("on %s", (_name, lays) => {
    const tokens: Array<[string, number | null]> = lays.filter(([, tile]) => [57, 63, 59].includes(tile)).map(([label]) => [label, 0]);
    expectSameKeys(buildOracleGraph(caseOn(STANDARD_BOARD, [...lays], [{ companyId: CO, tokens }])), 12);
  });

  it.each([
    ["REENTRY", REENTRY, [] as Array<[string, number | null]>],
    ["REENTRY with an H10 token", REENTRY, [["H10", 0]] as Array<[string, number | null]>],
    ["CROSSING", CROSSING, [] as Array<[string, number | null]>],
    ["Y_LOOP", Y_LOOP, [] as Array<[string, number | null]>],
    ["IL4", IL4, [["H10", 0]] as Array<[string, number | null]>],
  ] as const)("on the herald board %s (both IL-3 readings)", (_name, lays, tokens) => {
    for (const heraldUncountedIsStation of [false, true]) {
      expectSameKeys(buildOracleGraph(caseOn(EXPANDED_BOARD, [...lays], [{ companyId: PRR, tokens: [...tokens] }], PRR, { heraldUncountedIsStation })), 12);
    }
  });

  it.each(KNOWN_DEFECT_FIXTURES.filter((fixture) => !fixture.law.malformed).map((fixture) => [fixture.id, fixture] as const))(
    "on the known-defect fixture %s (both IL-3 readings)",
    (_id, fixture) => {
      for (const heraldUncountedIsStation of [true, false]) {
        const graph = buildOracleGraph({
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
          policy: { heraldUncountedIsStation },
        });
        expectSameKeys(graph, 12);
      }
    },
  );

  /** Seeded random boards: catalog tiles at random turns on every layable hex of a region (printed tiles may be
   *  replaced; gray, red and Coal River hexes never are), up to two stations each for three corporations, and --
   *  on the Level Playing Field -- a random licence. Every corporation's DFS routes must equal the brute-force
   *  walk's legal set. */
  const randomBoards = (board: typeof STANDARD_BOARD, region: string[], seeds: number, maxVisits: number, licenceRule = false) => {
    const layable = region.filter((label) => {
      const hex = board.hexes.find((entry) => entry.label === label);
      return hex !== undefined && hex.type !== "RedOffboard" && board.grayHexes[label] === undefined && hex.revenueTiers === undefined;
    });
    let checked = 0;
    for (let seed = 1; seed <= seeds; seed += 1) {
      const rand = lcg(seed * 7919 + region.length);
      // A hex printed with plain track (H12's #24, M11's #9) only ever takes plain track.
      const plain = TILE_CATALOG.filter((entry) => entry.terrain === "Plain");
      const lays: Lay[] = layable.filter(() => rand(10) < 8).map((label) => {
        const printedPlain = board.hexes.find((entry) => entry.label === label)?.printedTile !== undefined;
        // Half the time a tile with four or more exits, so the random boards are dense enough to re-enter hexes.
        const dense = TILE_CATALOG.filter((entry) => (entry.paths ?? []).flat().filter((e, i, all) => all.indexOf(e) === i).length >= 4);
        const pool = printedPlain ? plain : rand(2) === 0 ? dense : TILE_CATALOG;
        return [label, pool[rand(pool.length)].tileId, rand(6)];
      });
      const graph0 = buildOracleGraph(caseOn(board, lays, []));
      const cities = Array.from(graph0.nodes.values()).filter((node) => node.kind === "city" && node.spokes.length > 0);
      const free = new Map(cities.map((node) => [node.id, node.slots]));
      const companies = [CO, BO, PRR].map((companyId) => {
        const tokens: Array<[string, number | null]> = [];
        const used = new Set<string>();
        for (let pick = 0; pick < 2 && cities.length > 0; pick += 1) {
          const node = cities[rand(cities.length)];
          if ((free.get(node.id) ?? 0) <= 0 || used.has(node.hex)) continue;
          free.set(node.id, free.get(node.id)! - 1);
          used.add(node.hex);
          tokens.push([node.hex, node.cityIndex]);
        }
        return { companyId, tokens, licences: rand(2) };
      });
      for (const companyId of [CO, BO, PRR]) {
        const input = { ...caseOn(board, lays, companies, companyId), licenceRule };
        const graph = buildOracleGraph(input);
        // Synthetic boards: tiles are laid regardless of what the hex prints (V10) so the boards are dense; every
        // other validity condition must hold.
        expect(graph.validity.filter((finding) => finding.code !== "V10" && !(finding.code === "V3" && /impassable/.test(finding.detail)))).toEqual([]);
        checked += expectSameKeys(graph, maxVisits);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`brute force vs DFS on ${board.id} ${region[0]}..: ${checked} legal routes compared`);
    return checked;
  };

  it("on 150 seeded random boards around F14 (standard)", () => {
    const region = ["E13", "E15", "F12", "F14", "F16", "G13", "G15", "D14", "D16", "E11", "E17", "F10", "F18", "G11", "G17", "H12", "H14", "H16"];
    expect(randomBoards(STANDARD_BOARD, region, 150, 9)).toBeGreaterThan(1000);
  });

  it("on 120 seeded random boards around Altoona and the Gulf (standard: the bow, a two-hex red area)", () => {
    const region = ["H6", "H8", "H10", "H12", "H14", "I1", "I3", "I5", "I7", "J2", "J4", "J6", "G7", "G9", "G11"];
    expect(randomBoards(STANDARD_BOARD, region, 120, 9)).toBeGreaterThan(500);
  });

  it("on 120 seeded random boards around the herald (1830+: H12's #24 replaced or kept)", () => {
    const region = ["G9", "G11", "G13", "H8", "H10", "H12", "H14", "H16", "I9", "I11", "I13", "I15", "J12", "J14"];
    expect(randomBoards(EXPANDED_BOARD, region, 120, 9)).toBeGreaterThan(800);
  });

  it("on 120 seeded random boards around Coal River and Chattanooga (Level Playing Field, random licences)", () => {
    const region = ["K1", "K3", "K5", "K7", "K9", "K11", "L2", "L4", "L6", "L8", "L10", "L12", "M9", "M11", "J8", "J10"];
    expect(randomBoards(LPF_BOARD, region, 120, 9, true)).toBeGreaterThan(500);
  });
});

/* ------------------------------------------------------------------ */
/* The packing                                                        */
/* ------------------------------------------------------------------ */

describe("the packing equals an exhaustive product of every route choice", () => {
  const exhaustive = (graph: OracleGraph, fleet: string[]) => {
    const routes = enumerateRoutes(graph, { maxStops: Number.POSITIVE_INFINITY, budget: 50_000_000, selfCheck: true }).routes;
    const caps = fleet.map((model) => (model === "D" ? Number.POSITIVE_INFINITY : Number(model)));
    let best = 0;
    const pick = (i: number, used: Set<number>, total: number) => {
      if (i === fleet.length) {
        best = Math.max(best, total);
        return;
      }
      pick(i + 1, used, total);
      for (const route of routes) {
        if (route.stops > caps[i] || route.boundaries.some((b) => used.has(b))) continue;
        const next = new Set(used);
        route.boundaries.forEach((b) => next.add(b));
        pick(i + 1, next, total + route.value);
      }
    };
    pick(0, new Set(), 0);
    return best;
  };

  it.each([
    ["GULF", GULF, ["2", "2"]],
    ["GULF", GULF, ["2", "3"]],
    ["GULF", GULF, ["2", "2", "2"]],
    ["DOUBLE_TOWN", DOUBLE_TOWN, ["2", "2"]],
    ["DOUBLE_TOWN", DOUBLE_TOWN, ["2", "4"]],
    ["LINE", LINE, ["2", "3"]],
  ] as const)("%s with %j", (_name, lays, fleet) => {
    const graph = buildOracleGraph(caseOn(STANDARD_BOARD, [...lays], [{ companyId: CO, tokens: [["I5", 0]] }]));
    const routes = enumerateRoutes(graph, { maxStops: Number.POSITIVE_INFINITY, budget: 50_000_000, selfCheck: true }).routes;
    const packed = optimumRouteSet(routes, fleet.map((model, trainIndex) => ({ trainIndex, model })), 10_000_000);
    expect(packed.exhausted).toBe(false);
    expect(packed.total).toBe(exhaustive(graph, [...fleet]));
  });

  it("an unknown train model is UNDECIDED, never a guess", () => {
    const solved = solveOracleCase({ ...caseOn(STANDARD_BOARD, LINE, [{ companyId: CO, tokens: [["I5", 0]] }]), fleet: ["9"] });
    expect(solved.undecided).toMatch(/unknown train model/);
  });

  it("an exhausted enumeration budget is UNDECIDED, never 'no route'", () => {
    const solved = solveOracleCase({ ...caseOn(STANDARD_BOARD, GULF, [{ companyId: CO, tokens: [["I5", 0]] }]), fleet: ["D"], enumerationBudget: 3 });
    expect(solved.undecided).toMatch(/budget exhausted/);
  });
});
