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

  it("HERALD (1830+): PRR's herald is a stop, an end and a station for PRR; the uncounted pass is IL-3", () => {
    const lays: Lay[] = [["H10", 57, 0], ["H14", 57, 0]];
    const input = caseOn(EXPANDED_BOARD, lays, [{ companyId: PRR, tokens: [] }], PRR);
    expect(routeTable(input)).toEqual(["H10>H12 $30", "H10>H12*>H14 $40", "H10>H12>H14 $50", "H12>H14 $30"]);
    expect(optimum(input, ["2"])).toBe(40); // the pass, under the authority's current reading of IL-3
    expect(optimum(input, ["3"])).toBe(50);
    expect(optimum(input, ["2", "2"])).toBe(60); // both trains leave the herald on its two rails
    const strict = caseOn(EXPANDED_BOARD, lays, [{ companyId: PRR, tokens: [] }], PRR, { heraldUncountedIsStation: false });
    expect(routeTable(strict)).toEqual(["H10>H12 $30", "H10>H12>H14 $50", "H12>H14 $30"]);
    expect(optimum(strict, ["2"])).toBe(30);
    // Nobody else sees a herald: for NYC, H12 is plain track.
    const nyc = caseOn(EXPANDED_BOARD, lays, [{ companyId: 2, tokens: [["H10", 0]] }], 2);
    expect(routeTable(nyc)).toEqual(["H10>H12>H14 $40"]);
  });
});

describe("IL-11 (the R12-1 review, H1): the herald is one city however a route includes it", () => {
  // H12's printed #24 (stem 3, prongs 0 and 5); H14 #57; a loop from prong 5 round to the stem: I13 #7 turned 2,
  // I11 #8, H10 #7 turned 5. PRR runs from its herald alone.
  const lays: Lay[] = [["H14", 57, 0], ["H10", 7, 5], ["I11", 8, 0], ["I13", 7, 2]];
  it.each([true, false])("a route may not stop at the herald and also run past it (heraldUncountedIsStation %s)", (heraldUncountedIsStation) => {
    const input = caseOn(EXPANDED_BOARD, lays, [{ companyId: PRR, tokens: [] }], PRR, { heraldUncountedIsStation });
    const graph = buildOracleGraph(input);
    // Enter the herald by prong 5 and stop, loop round, run past it on the stem-to-prong-0 rail, end at H14.
    const twice = judgeWaypoints(graph, [{ hex: "H12" }, { hex: "I13" }, { hex: "I11" }, { hex: "H10" }, { hex: "H12", bypass: true }, { hex: "H14" }]);
    expect(twice.kind).toBe("illegal");
    expect(twice.kind === "illegal" && twice.reason).toMatch(/herald on H12 twice|includes H12\/herald0 twice/);
    expect(routeTable(input).some((row) => row.startsWith("H12>I13>I11>H10>H12") || row.startsWith("H14>H12*>H10>I11>I13>H12"))).toBe(false);
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
