/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-4: THE EXACT SEARCH, TESTED AGAINST THE AUTHORITY AND AGAINST BRUTE FORCE
// ==================================================================
//
// `gameEngine/routeExactSearch.ts` is production code and imports nothing from `routeOracle/**`
// (`routeOracleIndependence.test.ts`). This suite lives beside the oracle because it borrows the R12-1 harness's
// boards (the B-2 dense corpus and the known-defect fixtures) -- it asks production only production's questions:
//
//   1. SOUNDNESS OF THE INCREMENTAL PRICING: every enumerated route is re-judged by `walkRoute` (`validate: "all"`),
//      which must accept it at exactly the search's text, revenue, centre count and track. (Default runs: every
//      capacity 2..7 on every dense board and corporation, and every known-defect fixture at Diesel reach. The Diesel
//      sweep of the dense boards -- ~180 000 routes, about a minute -- runs under ROUTE_ORACLE_FULL=1.)
//   2. PACKING EXACTNESS: the branch and bound (admissible bound + identical-train symmetry) against a brute force
//      that tries every assignment, on real route lists with real track clashes.
//   3. DETERMINISM AND THE TIE-BREAK: equal inputs give equal outputs; routes are ordered revenue-then-text; among
//      equal sets the widest train takes the first route in that order.
//   4. EXPLICIT CEILINGS: a search past its ceiling THROWS -- it never answers with a smaller figure.
//   5. THE REVISION SEAM: only a v12 board is searched exactly; the pre-v12 board keeps the heuristic.
//
// Optimality against the independent oracle is `routeOracleCorpus.test.ts` (sample; FULL: the whole B-2 corpus).

import { denseBoards } from "./harness/corpus";
import { oracleFor, probeCaseFor } from "./harness/compare";
import { KNOWN_DEFECT_FIXTURES, parseRoute, type KnownDefectFixture } from "./harness/knownDefects";
import { waypointsOf } from ".";
import { probeState, type ProbeCase } from "./harness/productionProbe";
import type { CorpusBoard } from "./harness/corpus";
import { tokenCityIndex, type StationTokenCompany } from "../components/hexContractTypes";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { cityBlockerFor } from "../gameEngine/cityBlocking";
import { citySlotCount } from "../gameEngine/stationTokens";
import { barredHexesFor } from "../gameEngine/kanawhaLicense";
import { stationTokensOf } from "../gameEngine/trackReach";
import { assignRouteSet } from "../gameEngine/routeAutoTrace";
import { walkRoute } from "../gameEngine/routeWalk";
import * as exactSearchModule from "../gameEngine/routeExactSearch";
import { reducerAllowsSkip } from "./harness/productionProbe";
import {
  enumerateLegalRoutes,
  exactRouteSet,
  packExactRouteSet,
  RouteSearchLimitError,
  type ExactEnumerationInput,
  type ExactRoute,
  type ExactTrain,
} from "../gameEngine/routeExactSearch";

const FULL = process.env.ROUTE_ORACLE_FULL === "1";
const UNLIMITED = 999;

type SearchInput = Omit<ExactEnumerationInput, "maxCentres">;

/** Runs `fn` under the case's own board scope (v12 unless told otherwise) with `routeSearchFor`'s inputs. */
function withSearchInput<T>(c: ProbeCase, fn: (input: SearchInput) => T, revision: "v12" | "pre-v12" = "v12"): T {
  const state = probeState(c);
  return withRules(
    resolveVariants(c.variants),
    () => {
      const company = state.public_companies.find((entry) => entry.company_id === c.companyId)!;
      const barredHexes = barredHexesFor(state, c.companyId);
      const blocksThrough = cityBlockerFor({
        actingCompanyId: c.companyId,
        companies: state.public_companies,
        slotsAt: (q: number, r: number, cityIndex: number) => citySlotCount(c.grid, q, r, cityIndex),
        cityOf: (holder, q, r) => tokenCityIndex(holder as unknown as StationTokenCompany, q, r),
        barredHexes,
      });
      return fn({ mapGrid: c.grid, era: c.era, tokens: stationTokensOf(company), companyId: c.companyId, blocksThrough, barredHexes });
    },
    revision,
  );
}

/** Every dense board's corporations that can run at all (a token, or a herald of their own). */
function denseCases(): Array<{ board: CorpusBoard; companyId: number }> {
  const out: Array<{ board: CorpusBoard; companyId: number }> = [];
  for (const board of denseBoards()) {
    const heraldOwners = new Set(board.board.hexes.flatMap((hex) => (hex.herald ? [hex.herald.companyId] : [])));
    for (const company of board.companies) {
      if (company.tokens.length === 0 && !heraldOwners.has(company.companyId)) continue;
      out.push({ board, companyId: company.companyId });
    }
  }
  return out;
}

describe("1. every enumerated route is one the authority's walk accepts, at exactly the search's price", () => {
  it.each(denseCases().map((entry) => [`${entry.board.id} company ${entry.companyId}`, entry] as const))(
    "%s: every capacity 2..7 (validate: all)",
    (_name, { board, companyId }) => {
      const c = probeCaseFor(board, companyId, ["2"]);
      withSearchInput(c, (input) => {
        let previous = -1;
        for (const cap of [2, 3, 4, 5, 6, 7]) {
          // `validate: "all"` throws RouteSearchInconsistencyError on the first route the walk disagrees with.
          const { routes, stats } = enumerateLegalRoutes({ ...input, maxCentres: cap, validate: "all" });
          // Every legal route (both readings of a reversible one) was re-judged; the candidates are those minus twins.
          expect(stats.walkValidated).toBe(stats.legalRoutes);
          expect(routes.length + stats.reversedTwins).toBe(stats.legalRoutes);
          expect(routes.every((route) => route.centres <= cap && route.centres >= 2)).toBe(true);
          // A wider train can run every route a narrower one can: the lists nest.
          expect(stats.legalRoutes).toBeGreaterThanOrEqual(previous);
          previous = stats.legalRoutes;
        }
      });
    },
    120_000,
  );

  (FULL ? it : it.skip)("the Diesel sweep of every dense board (ROUTE_ORACLE_FULL=1): ~180 000 routes, each re-judged", () => {
    for (const { board, companyId } of denseCases()) {
      const c = probeCaseFor(board, companyId, ["D"]);
      withSearchInput(c, (input) => {
        const { routes, stats } = enumerateLegalRoutes({ ...input, maxCentres: Number.POSITIVE_INFINITY, validate: "all" });
        expect([board.id, companyId, stats.walkValidated]).toEqual([board.id, companyId, routes.length + stats.reversedTwins]);
      });
    }
  }, 30 * 60 * 1000);

  it.each(KNOWN_DEFECT_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    "known-defect fixture %s at Diesel reach (validate: all)",
    (_id, fixture: KnownDefectFixture) => {
      const c = probeCaseFor(fixture.board, fixture.companyId, fixture.fleet);
      withSearchInput(c, (input) => {
        const { routes, stats } = enumerateLegalRoutes({ ...input, maxCentres: Number.POSITIVE_INFINITY, validate: "all" });
        expect(stats.walkValidated).toBe(routes.length + stats.reversedTwins);
      });
    },
    120_000,
  );
});

describe("1b. completeness, route by route: every route the independent oracle finds is a candidate, at the walk's price", () => {
  /* The proof in the module header, checked directly: each oracle route (both readings) that the authority's walk
     accepts within the train's reach must be among the search's candidates -- itself, or as its reversal twin (the
     reading kept for it) -- at exactly the walk's revenue and centre count. */
  it.each(denseCases().map((entry) => [`${entry.board.id} company ${entry.companyId}`, entry] as const))("%s at reach 2, 4, 6", (_name, { board, companyId }) => {
    for (const cap of [2, 4, 6]) {
      const solution = oracleFor(board, companyId, [String(cap)]);
      const c = probeCaseFor(board, companyId, [String(cap)]);
      withSearchInput(c, (input) => {
        const { routes } = enumerateLegalRoutes({ ...input, maxCentres: cap });
        const byKey = new Map(routes.map((route) => [route.key, route]));
        const ctx = { mapGrid: input.mapGrid, era: input.era, companyId: input.companyId, tokens: input.tokens, blocksThrough: input.blocksThrough, barredHexes: input.barredHexes };
        let accepted = 0;
        const missing: string[] = [];
        for (const route of solution.routes) {
          const forward = waypointsOf(route.visits, solution.graph);
          for (const waypoints of [forward, [...forward].reverse()]) {
            const verdict = walkRoute(ctx, waypoints);
            if (typeof verdict === "string" || verdict.centres > cap) continue;
            accepted += 1;
            const key = verdict.path.map((wp) => (wp.bypass ? `${wp.hex}*` : wp.hex)).join(">");
            const found = byKey.get(key) ?? byKey.get(key.split(">").reverse().join(">"));
            if (!found || found.revenue !== verdict.revenue || found.centres !== verdict.centres) missing.push(`${key} $${verdict.revenue}`);
          }
        }
        expect([cap, missing]).toEqual([cap, []]);
        expect(accepted).toBeGreaterThanOrEqual(routes.length); // every candidate has its oracle counterpart too
      });
    }
  }, 120_000);
});

/** Every assignment of `routes` to `fleet` (each train one route it can count, or none; no shared track). */
function bruteForce(routes: readonly ExactRoute[], fleet: readonly ExactTrain[]): number {
  const cap = (train: ExactTrain) => (train.maxRevenueCentres >= UNLIMITED ? Number.POSITIVE_INFINITY : train.maxRevenueCentres);
  const used = new Set<number>();
  let best = 0;
  const go = (i: number, total: number) => {
    if (i === fleet.length) {
      best = Math.max(best, total);
      return;
    }
    go(i + 1, total);
    for (const route of routes) {
      if (route.centres > cap(fleet[i])) continue;
      if (route.segmentIds.some((id) => used.has(id))) continue;
      route.segmentIds.forEach((id) => used.add(id));
      go(i + 1, total + route.revenue);
      route.segmentIds.forEach((id) => used.delete(id));
    }
  };
  go(0, 0);
  return best;
}

describe("2. the packing is exact: branch and bound = brute force", () => {
  const FLEETS: ReadonlyArray<readonly number[]> = [[2, 2], [3, 3], [2, 3, 3], [3, 4, 4], [4, 4, 4], [2, 2, 2, 2], [6, UNLIMITED], [5, 5, 3]];

  it.each(denseCases().map((entry) => [`${entry.board.id} company ${entry.companyId}`, entry] as const))("%s", (_name, { board, companyId }) => {
    const c = probeCaseFor(board, companyId, ["D"]);
    withSearchInput(c, (input) => {
      const { routes, segmentKeys } = enumerateLegalRoutes({ ...input, maxCentres: 6 });
      // The brute force is exponential: the 36 richest routes (real clashes, real ties) and a spread of shorter
      // ones, kept in the search's order.
      const pool = routes.filter((_route, index) => index < 36 || index % 97 === 0).slice(0, 48);
      for (const caps of FLEETS) {
        const fleet = caps.map((maxRevenueCentres, trainIndex) => ({ trainIndex, maxRevenueCentres }));
        const packed = packExactRouteSet(pool, segmentKeys.length, fleet);
        expect([caps, packed.total]).toEqual([caps, bruteForce(pool, fleet)]);
        // The witness is a real set: disjoint track, each route within its train.
        const seen = new Set<number>();
        for (const { trainIndex, routeIndex } of packed.choice) {
          if (routeIndex < 0) continue;
          const route = pool[routeIndex];
          const capacity = caps[trainIndex] >= UNLIMITED ? Number.POSITIVE_INFINITY : caps[trainIndex];
          expect(route.centres).toBeLessThanOrEqual(capacity);
          for (const id of route.segmentIds) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
        }
        expect(packed.choice.reduce((sum, entry) => sum + (entry.routeIndex >= 0 ? pool[entry.routeIndex].revenue : 0), 0)).toBe(packed.total);
      }
    });
  }, 120_000);

  it("the one-train pass and the revenue floors change nothing: exactRouteSet = the unfiltered packing, route for route", () => {
    for (const { board, companyId } of denseCases()) {
      const c = probeCaseFor(board, companyId, ["D"]);
      withSearchInput(c, (input) => {
        for (const caps of [[2], [4], [6], [UNLIMITED], [6, UNLIMITED], [3, 4, 4], [5, 5, UNLIMITED], [2, 2]]) {
          const fleet = caps.map((maxRevenueCentres, trainIndex) => ({ trainIndex, maxRevenueCentres }));
          const maxCentres = caps.some((cap) => cap >= UNLIMITED) ? Number.POSITIVE_INFINITY : Math.max(...caps);
          const all = enumerateLegalRoutes({ ...input, maxCentres });
          const unfiltered = packExactRouteSet(all.routes, all.segmentKeys.length, fleet);
          const exact = exactRouteSet({ ...input, trains: fleet });
          expect([board.id, companyId, caps, exact.total]).toEqual([board.id, companyId, caps, unfiltered.total]);
          expect(exact.assignments.map((x) => [x.trainIndex, x.route.key])).toEqual(
            unfiltered.choice.filter((x) => x.routeIndex >= 0).map((x) => [x.trainIndex, all.routes[x.routeIndex].key]),
          );
        }
      });
    }
  }, 300_000);

  it("identical trains are searched once per combination, and the fleet slot a route lands on does not change the total", () => {
    const [{ board, companyId }] = denseCases();
    const c = probeCaseFor(board, companyId, ["D"]);
    withSearchInput(c, (input) => {
      const { routes, segmentKeys } = enumerateLegalRoutes({ ...input, maxCentres: 4 });
      const pool = routes.slice(0, 40);
      const three = [0, 1, 2].map((trainIndex) => ({ trainIndex, maxRevenueCentres: 4 }));
      const packed = packExactRouteSet(pool, segmentKeys.length, three);
      expect(packed.total).toBe(bruteForce(pool, three));
      // Reversing the slot numbers relabels the trains and nothing else.
      const relabelled = packExactRouteSet(pool, segmentKeys.length, [...three].reverse().map((train, i) => ({ ...train, trainIndex: 10 + i })));
      expect(relabelled.total).toBe(packed.total);
    });
  });
});

describe("2b. the packing's answer is the FIRST maximum: brute force in the documented order, randomised", () => {
  /** Every assignment, trains widest first then by slot, each train's options in list order with idle last; the
   *  incumbent replaced only on a strictly higher total -- the tie-break's definition, without symmetry or bounds. */
  function firstMaximum(pool: readonly ExactRoute[], fleet: readonly ExactTrain[], blocked: Uint8Array) {
    const cap = (train: ExactTrain) => (train.maxRevenueCentres >= UNLIMITED ? Number.POSITIVE_INFINITY : train.maxRevenueCentres);
    const trains = [...fleet].sort((x, y) => cap(y) - cap(x) || x.trainIndex - y.trainIndex);
    const used = new Set<number>();
    const chosen: number[] = [];
    let best = -1;
    let bestChoice: number[] = [];
    const go = (i: number, total: number) => {
      if (i === trains.length) {
        if (total > best) [best, bestChoice] = [total, [...chosen]];
        return;
      }
      pool.forEach((route, index) => {
        if (route.centres > cap(trains[i])) return;
        if (route.segmentIds.some((id) => used.has(id) || blocked[id] === 1)) return;
        route.segmentIds.forEach((id) => used.add(id));
        chosen[i] = index;
        go(i + 1, total + route.revenue);
        route.segmentIds.forEach((id) => used.delete(id));
      });
      chosen[i] = -1;
      go(i + 1, total);
    };
    go(0, 0);
    return { total: Math.max(0, best), choice: trains.map((train, i) => ({ trainIndex: train.trainIndex, routeIndex: bestChoice[i] ?? -1 })).sort((x, y) => x.trainIndex - y.trainIndex) };
  }

  it("600 random pools, fleets and occupied track: the same total AND the same assignment", () => {
    let seed = 20260930;
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const pools: Array<{ routes: ExactRoute[]; segments: number }> = [];
    for (const { board, companyId } of denseCases().slice(0, 12)) {
      const c = probeCaseFor(board, companyId, ["D"]);
      withSearchInput(c, (input) => {
        const { routes, segmentKeys } = enumerateLegalRoutes({ ...input, maxCentres: 6 });
        pools.push({ routes, segments: segmentKeys.length });
      });
    }
    const CAPS = [2, 3, 4, 5, 6, UNLIMITED];
    for (let trial = 0; trial < 600; trial += 1) {
      const source = pools[Math.floor(random() * pools.length)];
      // A pool of 10-14 routes kept in the search's order, biased to the top (ties and clashes live there).
      const picked = new Set<number>();
      const size = 10 + Math.floor(random() * 5);
      while (picked.size < Math.min(size, source.routes.length)) picked.add(Math.floor(random() * random() * Math.min(source.routes.length, 200)));
      const pool = Array.from(picked).sort((a, b) => a - b).map((index) => source.routes[index]);
      const fleet = Array.from({ length: 1 + Math.floor(random() * 4) }, (_x, i) => ({ trainIndex: (i * 7 + trial) % 5 + i * 5, maxRevenueCentres: CAPS[Math.floor(random() * CAPS.length)] }));
      const blocked = new Uint8Array(source.segments);
      if (random() < 0.3) for (const id of pool[Math.floor(random() * pool.length)].segmentIds) if (random() < 0.5) blocked[id] = 1;
      const packed = packExactRouteSet(pool, source.segments, fleet, blocked);
      const brute = firstMaximum(pool, fleet, blocked);
      expect([trial, packed.total, packed.choice]).toEqual([trial, brute.total, brute.choice]);
    }
  }, 300_000);
});

describe("3. determinism and the tie-break", () => {
  const board = denseBoards().find((entry) => entry.id === "Y8V@651")!;

  it("routes are ordered by revenue (highest first), then waypoint text (code-unit order); equal inputs, equal output", () => {
    const c = probeCaseFor(board, 1, ["4", "6"]);
    withSearchInput(c, (input) => {
      const first = enumerateLegalRoutes({ ...input, maxCentres: 6 }).routes;
      const second = enumerateLegalRoutes({ ...input, maxCentres: 6 }).routes;
      expect(second.map((route) => `${route.revenue}|${route.key}`)).toEqual(first.map((route) => `${route.revenue}|${route.key}`));
      for (let i = 1; i < first.length; i += 1) {
        const [a, b] = [first[i - 1], first[i]];
        expect(a.revenue > b.revenue || (a.revenue === b.revenue && a.key < b.key)).toBe(true);
      }
      // REVERSAL TWINS: a route legal from both ends, at the same figure on the same track, is a candidate once, by
      // the reading whose text sorts first -- the dropped reading is exactly interchangeable, and would sort later.
      const { stats } = enumerateLegalRoutes({ ...input, maxCentres: 6 });
      expect(stats.reversedTwins).toBeGreaterThan(0);
      expect(stats.legalRoutes).toBe(first.length + stats.reversedTwins);
      const ctx = { mapGrid: input.mapGrid, era: input.era, companyId: input.companyId, tokens: input.tokens, blocksThrough: input.blocksThrough, barredHexes: input.barredHexes };
      let checked = 0;
      for (const route of first) {
        const reverseKey = route.key.split(">").reverse().join(">");
        if (!(reverseKey < route.key)) continue;
        // The earlier reading was not kept, so it must not be an exact twin: refused by the walk, or not interchangeable.
        const verdict = walkRoute(ctx, parseRoute(reverseKey));
        if (typeof verdict !== "string") {
          const sameTrack = verdict.segments.size === route.segmentIds.length;
          expect(verdict.revenue === route.revenue && verdict.centres === route.centres && sameTrack).toBe(false);
        }
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(0);
    });
  });

  it("the set is the first maximum in that order: the widest train takes its richest route, text order among equals", () => {
    const c = probeCaseFor(board, 8, ["6", "D"]);
    withSearchInput(c, (input) => {
      const trains = [
        { trainIndex: 0, maxRevenueCentres: 6 },
        { trainIndex: 1, maxRevenueCentres: UNLIMITED },
      ];
      const a = exactRouteSet({ ...input, trains });
      const b = exactRouteSet({ ...input, trains: [...trains].reverse() });
      expect(a.total).toBe(840); // the oracle's optimum (routeOracleCorpus SAMPLE)
      expect(b.assignments.map((x) => [x.trainIndex, x.route.key])).toEqual(a.assignments.map((x) => [x.trainIndex, x.route.key]));
      // Replayed: byte-identical answers.
      const again = exactRouteSet({ ...input, trains });
      expect(again.assignments.map((x) => [x.trainIndex, x.route.key, x.route.revenue])).toEqual(a.assignments.map((x) => [x.trainIndex, x.route.key, x.route.revenue]));
      // No set in the tie-break order before the answer reaches its total: the Diesel's route is the first in the
      // list that any maximum gives it.
      const diesel = a.assignments.find((x) => x.trainIndex === 1)!;
      const dieselIndex = a.routes.indexOf(diesel.route);
      const segmentCount = a.routes.reduce((most, route) => Math.max(most, ...route.segmentIds), 0) + 1;
      for (let i = 0; i < dieselIndex; i += 1) {
        const earlier = a.routes[i];
        const blocked = new Uint8Array(segmentCount);
        earlier.segmentIds.forEach((id) => (blocked[id] = 1));
        const rest = packExactRouteSet(a.routes, segmentCount, [{ trainIndex: 0, maxRevenueCentres: 6 }], blocked);
        expect(earlier.revenue + rest.total).toBeLessThan(a.total);
      }
    });
  });
});

describe("4. explicit ceilings fail loudly, never with a smaller figure", () => {
  const board = denseBoards().find((entry) => entry.id === "Y8V@651")!;
  const c = probeCaseFor(board, 6, ["D"]);
  const trains = [{ trainIndex: 0, maxRevenueCentres: UNLIMITED }];

  const pair = [
    { trainIndex: 0, maxRevenueCentres: 6 },
    { trainIndex: 1, maxRevenueCentres: UNLIMITED },
  ];
  it.each([
    ["hex arrivals", { expansions: 1000 }, trains, 780],
    ["legal routes", { routes: 100 }, trains, 780],
    ["packing states", { packingStates: 1 }, pair, 900],
    ["packing route examinations", { packingWork: 1 }, pair, 900],
  ] as const)("%s", (_name, limits, fleet, answer) => {
    withSearchInput(c, (input) => {
      expect(() => exactRouteSet({ ...input, trains: fleet, limits })).toThrow(RouteSearchLimitError);
      expect(exactRouteSet({ ...input, trains: fleet }).total).toBe(answer);
    });
  });
});

describe("5. the revision seam: v12 searches exactly, the unpinned (pre-v12) board keeps its heuristic", () => {
  it("assignRouteSet reports the exact search's counts only on a v12 board", () => {
    const board = denseBoards().find((entry) => entry.id === "Y8V@651")!;
    const c = probeCaseFor(board, 5, ["3"]);
    const ask = (revision: "v12" | "pre-v12") =>
      withSearchInput(
        c,
        (input) =>
          assignRouteSet({
            mapGrid: input.mapGrid,
            era: input.era,
            startHexes: input.tokens,
            companyId: input.companyId,
            blocksThrough: input.blocksThrough,
            barredHexes: input.barredHexes,
            trains: [{ trainIndex: 0, maxRevenueCentres: 3 }],
          }),
        revision,
      );
    const v12 = ask("v12");
    expect(v12.exact).toBeDefined();
    expect(v12.totalRevenue).toBe(170); // the oracle's optimum; R12-3's heuristic demonstrated 150
    const legacy = ask("pre-v12");
    expect(legacy.exact).toBeUndefined();
    expect(legacy.totalRevenue).toBeLessThan(170); // the pre-v12 heuristic, as the unpinned corpus replays it
  });
});

describe("6. a search that cannot answer is never read as a figure", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a thrown ceiling reaches the reducer's caller (the room refuses the move and rolls back); nothing substitutes a figure", () => {
    const board = denseBoards().find((entry) => entry.id === "Y8V@651")!;
    const c = probeCaseFor(board, 5, ["3"]);
    expect(reducerAllowsSkip(c)).toBe(false); // the control: a paying route exists, so the skip is refused
    jest.spyOn(exactSearchModule, "exactRouteSet").mockImplementation(() => {
      throw new RouteSearchLimitError("probe: the ceiling was met");
    });
    // The skip refusal asks `maxRouteRevenueFor`; the error propagates out of the reducer rather than letting the
    // corporation skip (`null`, "could not tell") or demonstrating a smaller figure. The hosted room catches a throw
    // from `session.submit`, rolls the transaction back and answers `refused` / `internal` (`gameServer.ts`).
    expect(() => reducerAllowsSkip(c)).toThrow(RouteSearchLimitError);
  });
});

describe("the benchmark (reported by R12-4; generous bounds only)", () => {
  it("the dense corpus's largest Diesel searches stay well inside their ceilings", () => {
    const rows: string[] = [];
    for (const [id, companyId, caps] of [
      ["Y8V@651", 6, [UNLIMITED]],
      ["Y8V@651", 8, [6, UNLIMITED]],
      ["Z6C@608", 1, [UNLIMITED]],
      ["Z6C@608", 2, [6, UNLIMITED]],
      ["Z6C@494", 1, [UNLIMITED]],
      ["Z6C@608", 10, [3, 4, 4]],
    ] as const) {
      const board = denseBoards().find((entry) => entry.id === id)!;
      const c = probeCaseFor(board, companyId, ["D"]);
      withSearchInput(c, (input) => {
        const result = exactRouteSet({ ...input, trains: caps.map((maxRevenueCentres, trainIndex) => ({ trainIndex, maxRevenueCentres })) });
        rows.push(`${id} ${companyId} [${caps.join(",")}] $${result.total} ${JSON.stringify(result.stats)}`);
        expect(result.stats.expansions).toBeLessThan(1_000_000);
        expect(result.stats.legalRoutes).toBeLessThan(100_000);
        expect(result.stats.packingStates).toBeLessThan(1_000_000);
        expect(result.stats.enumerateMs + result.stats.packMs).toBeLessThan(10_000);
      });
    }
    // eslint-disable-next-line no-console
    console.log(rows.join("\n"));
  }, 300_000);
});
