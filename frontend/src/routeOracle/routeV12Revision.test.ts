/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-2: WHICH ROUTE RULES A BOARD PLAYS -- THE PIN DECIDES, AND AN UNPINNED BOARD KEEPS THE OLD ONES
// ==================================================================
//
// R12-2 changes what a stored log replays to (the rules engine moved to 12), so every replay-affecting repair is asked
// only on a PINNED board, as Stage 10.6's lay authority is (#1696 / #1698: presence, not a version number). An
// UNPINNED board -- the development corpus the tests replay, and from which the frozen SET-0A settlement goldens
// (SYN-05, SYN-07) are rebuilt -- is handed the `*_PRE_V12` board: the pre-v12 route law, search and 1830+ data. This
// suite pins that switch in both directions, on the R12-1 known-defect boards: the v12 answer where the pin exists,
// the pre-v12 answer (KNOWN-RED under the law, deliberately kept) where it does not.

import { STANDARD_BOARD, STANDARD_BOARD_PRE_V12, withBoard } from "../components/hexBoardData";
import { EXPANDED_BOARD, EXPANDED_BOARD_PRE_V12 } from "../components/hexBoardDataPlus";
import { LPF_BOARD, LPF_BOARD_PRE_V12 } from "../components/hexBoardDataLpf";
import { hexValueForEra } from "../components/hexGeometry";
import { initialGridFor } from "../gameEngine/initialGrid";
import { citySlotCount } from "../gameEngine/stationTokens";
import { boardFor, routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { evaluateRouteSet } from "../gameEngine/routeAuthority";
import { maxRouteRevenueFor } from "../gameEngine/derivedActions";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { stateDigest } from "../gameEngine/stateDigest";
import type { GameStateResponse } from "../gameEngine/gameState";
import { KNOWN_DEFECT_FIXTURES, parseRoute } from "./harness/knownDefects";
import { gridOf, probeState } from "./harness/productionProbe";
import { probeCaseFor } from "./harness/compare";

const fixture = (id: string) => KNOWN_DEFECT_FIXTURES.find((entry) => entry.id === id)!;
const unpinned = (state: GameStateResponse): GameStateResponse => {
  const copy = { ...state } as GameStateResponse & { rules_engine_version?: number };
  delete copy.rules_engine_version;
  return copy;
};
const run = (state: GameStateResponse, companyId: number, route: string, train: string) =>
  ({
    RunMultipleRoutes: { game_id: 1, protocol_id: companyId, routes: [parseRoute(route)], train_indices: [0], trains: [train], revenue_turn: "3.1.x" },
  }) as never;

describe("the revision is the pin's presence, and it picks the board", () => {
  it("a numeric pin plays the v12 rules; no pin (or a malformed one) plays the pre-v12 ones", () => {
    expect(routeRulesRevisionOf({ rules_engine_version: 12 })).toBe("v12");
    expect(routeRulesRevisionOf({ rules_engine_version: 11 })).toBe("v12"); // presence, never the value (#1698)
    for (const board of [{}, { rules_engine_version: null }, null, undefined]) expect(routeRulesRevisionOf(board)).toBe("pre-v12");
  });

  it("each map has its pre-v12 twin, which differs only in the route rules and the 1830+ Montreal / Norfolk data", () => {
    const pairs = [
      [{}, STANDARD_BOARD, STANDARD_BOARD_PRE_V12],
      [{ expandedMap: true }, EXPANDED_BOARD, EXPANDED_BOARD_PRE_V12],
      [{ expandedMap: true, levelPlayingField: true }, LPF_BOARD, LPF_BOARD_PRE_V12],
    ] as const;
    for (const [variants, current, legacy] of pairs) {
      const resolved = resolveVariants(variants);
      expect(boardFor(resolved)).toBe(current);
      expect(boardFor(resolved, "v12")).toBe(current);
      expect(boardFor(resolved, "pre-v12")).toBe(legacy);
      expect(legacy.preV12RouteRules).toBe(true);
      expect(current.preV12RouteRules).toBeUndefined();
      expect(legacy.id).toBe(current.id);
      expect(legacy.hexes).toBe(current.hexes);
    }
    expect(STANDARD_BOARD_PRE_V12).toEqual({ ...STANDARD_BOARD, preV12RouteRules: true });
    for (const board of [EXPANDED_BOARD_PRE_V12, LPF_BOARD_PRE_V12]) {
      expect(board.printedCityTiers).toBeUndefined();
      expect([board.grayHexes.A19.slots, board.grayHexes.L16.slots]).toEqual([undefined, undefined]);
    }
  });

  it("Montreal / Norfolk: v12 prices $40/$60 and $30/$50 with two circles each; the pre-v12 board keeps $40 and $20 flat, one circle", () => {
    for (const [current, legacy] of [[EXPANDED_BOARD, EXPANDED_BOARD_PRE_V12], [LPF_BOARD, LPF_BOARD_PRE_V12]] as const) {
      const read = (board: typeof current) =>
        withBoard(board, () => {
          const grid = initialGridFor(board);
          const at = (label: string) => board.hexes.find((hex) => hex.label === label)!;
          return (["A19", "L16"] as const).map((label) => [
            hexValueForEra(grid, at(label).q, at(label).r, "Yellow"),
            hexValueForEra(grid, at(label).q, at(label).r, "Brown"),
            citySlotCount(grid, at(label).q, at(label).r, 0),
          ]);
        });
      expect(read(current)).toEqual([[40, 60, 2], [30, 50, 2]]);
      expect(read(legacy)).toEqual([[40, 40, 1], [20, 20, 1]]);
    }
  });
});

describe("Montreal / Norfolk's second circle is placeable on v12 (review HIGH-1), and still not pre-v12", () => {
  const { evaluateStationPlacement, stationSlotCount } = require("../gameEngine/stationTokens") as typeof import("../gameEngine/stationTokens");
  const corp = (company_id: number, held: ReadonlyArray<readonly [number, number]>) => ({
    company_id,
    is_floated: true,
    station_token_hexes: held,
    station_token_limit: 4,
    station_tokens: held.map(([q, r]) => [q, r, 0] as const),
  });
  const cases = [
    { board: LPF_BOARD, legacy: LPF_BOARD_PRE_V12, label: "L16", holder: 10 /* N&W, whose home it is */ },
    { board: EXPANDED_BOARD, legacy: EXPANDED_BOARD_PRE_V12, label: "A19", holder: 3 /* CPR, whose home it is */ },
    { board: EXPANDED_BOARD, legacy: EXPANDED_BOARD_PRE_V12, label: "L16", holder: 2 },
  ] as const;
  it.each(cases)("$label on $board.id: a second corporation may take the free circle beside one foreign token; a third may not", ({ board, legacy, label, holder }) => {
    const ask = (b: typeof board, placer: number, holders: number[]) =>
      withBoard(b, () => {
        const grid = initialGridFor(b);
        const { q, r } = b.hexes.find((hex) => hex.label === label)!;
        const all = [...holders.map((id) => corp(id, [[q, r]])), corp(placer, [])];
        return [
          stationSlotCount(grid, q, r),
          ...[0, null].map((cityIndex) =>
            evaluateStationPlacement({ mapGrid: grid, q, r, company: all[all.length - 1], allCompanies: all, cityIndex, skipConnectivity: true }),
          ),
        ] as const;
      });
    const [slots, atCircle, atHex] = ask(board, 5, [holder]);
    expect(slots).toBe(2);
    expect(atCircle).toEqual({ allowed: true, reason: null });
    expect(atHex).toEqual({ allowed: true, reason: null });
    const [, full] = ask(board, 6, [holder, 5]);
    expect(full).toMatchObject({ allowed: false, reason: expect.stringMatching(/station slots are taken|only station slot/) });
    const [legacySlots, legacyAt] = ask(legacy, 5, [holder]);
    expect(legacySlots).toBe(1);
    expect(legacyAt).toMatchObject({ allowed: false, reason: "This city's only station slot is taken." });
  });
});

describe("the law: v12 on a pinned board, pre-v12 kept on an unpinned one (R12-1's KNOWN-RED answers, deliberately)", () => {
  it("IL-5: one red area at both ends -- refused on v12, still legal pre-v12", () => {
    const f = fixture("RED-CANADIAN-WEST");
    const probe = probeCaseFor(f.board, f.companyId, ["3"]);
    const state = probeState(probe);
    const ask = () => evaluateRouteSet({ state, mapGrid: probe.grid, era: "Yellow", companyId: f.companyId, routes: [parseRoute("A9>B10>A11")], trainIndices: [0] });
    expect(withBoard(STANDARD_BOARD, ask)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/counts Canadian West twice/) });
    expect(withBoard(STANDARD_BOARD_PRE_V12, ask)).toMatchObject({ kind: "legal", total: 90 });
    // Through the reducer, the state's own pin picks: pinned -> refused (nothing moves); unpinned -> applied.
    const msg = run(state, f.companyId, "A9>B10>A11", "3");
    expect(stateDigest(applySandboxAction(state, msg, { mapGrid: probe.grid, era: "Yellow" }))).toBe(stateDigest(state));
    const legacy = unpinned(state);
    expect(stateDigest(applySandboxAction(legacy, msg, { mapGrid: probe.grid, era: "Yellow" }))).not.toBe(stateDigest(legacy));
  });

  it("IL-7: a bare token at a bypassed Altoona -- refused on v12, still legal pre-v12", () => {
    const f = fixture("ALTOONA-BOW");
    const probe = probeCaseFor(f.board, f.companyId, ["4"]);
    const state = probeState(probe);
    const ask = () => evaluateRouteSet({ state, mapGrid: probe.grid, era: "Yellow", companyId: f.companyId, routes: [parseRoute("H10>H12*>H14>H16")], trainIndices: [0] });
    expect(withBoard(STANDARD_BOARD, ask).kind).toBe("refused");
    expect(withBoard(STANDARD_BOARD_PRE_V12, ask)).toMatchObject({ kind: "legal", total: 40 });
  });

  it("Coal River: an unlicensed END is refused by the walk on v12; pre-v12 only the reducer's own gate refused it", () => {
    const f = fixture("COAL-RIVER-UNLICENSED");
    const probe = probeCaseFor(f.board, f.companyId, ["2"]);
    const state = probeState(probe);
    const ask = () => evaluateRouteSet({ state, mapGrid: probe.grid, era: "Yellow", companyId: f.companyId, routes: [parseRoute("K7>L8")], trainIndices: [0] });
    expect(withRules(resolveVariants(state.variants), ask, "v12")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/without a Kanawha Licence/) });
    expect(withRules(resolveVariants(state.variants), ask, "pre-v12")).toMatchObject({ kind: "legal", total: 60 });
  });
});

describe("the search: the v12 demonstration on a pinned board, the pre-v12 one kept on an unpinned one", () => {
  it("CROSS_TWICE (IL-11 re-entry): found on v12 ($40), not found pre-v12 ($0)", () => {
    const f = fixture("CROSS-TWICE");
    const probe = probeCaseFor(f.board, f.companyId, ["2"]);
    const state = probeState(probe);
    expect(withBoard(STANDARD_BOARD, () => maxRouteRevenueFor(state, f.companyId, probe.grid, "Yellow"))).toBe(40);
    expect(withBoard(STANDARD_BOARD_PRE_V12, () => maxRouteRevenueFor(state, f.companyId, probe.grid, "Yellow"))).toBe(0);
  });

  it("the H12 herald fork (S6-16): v12 demonstrates the legal $30; pre-v12 still joins the prongs ($50, which its own authority refuses)", () => {
    const f = fixture("HERALD-FORK-PLUS");
    const probe = probeCaseFor(f.board, f.companyId, ["3"]);
    const state = probeState(probe);
    expect(withBoard(EXPANDED_BOARD, () => maxRouteRevenueFor(state, f.companyId, probe.grid, "Yellow"))).toBe(30);
    expect(withBoard(EXPANDED_BOARD_PRE_V12, () => maxRouteRevenueFor(state, f.companyId, probe.grid, "Yellow"))).toBe(50);
  });

  it("an unpinned board is judged pre-v12 by the reducer's own scope: CROSS_TWICE's skip is still allowed there, and refused when pinned", () => {
    const f = fixture("CROSS-TWICE");
    const probe = probeCaseFor(f.board, f.companyId, ["2"]);
    const state = probeState(probe);
    const skip = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: f.companyId } } as never;
    expect(stateDigest(applySandboxAction(state, skip, { mapGrid: probe.grid, era: "Yellow" }))).toBe(stateDigest(state));
    const legacy = unpinned(state);
    expect(stateDigest(applySandboxAction(legacy, skip, { mapGrid: probe.grid, era: "Yellow" }))).not.toBe(stateDigest(legacy));
  });
});

describe("ING-1: a city-less paid placement on a two-city hex", () => {
  it("is refused on v12 and still accepted pre-v12", () => {
    const { stationPlacementRefusal } = require("../gameEngine/stationPlacementGate") as typeof import("../gameEngine/stationPlacementGate");
    // NNH (7) at Tokens with G19 (New York) printed, two cities; an empty grid is the printed board.
    const probe = { ...probeCaseFor(fixture("ING1-NYC-CITY-RECORDED").board, 7, ["3"]), grid: gridOf([]) };
    const base = probeState(probe);
    const state = {
      ...base,
      operating_sub_phase: "Tokens",
      public_companies: base.public_companies.map((company) => ({ ...company, station_token_hexes: [], station_tokens: [] })),
    } as GameStateResponse;
    const g19 = probe.board.hexes.find((hex) => hex.label === "G19")!;
    const placement = { protocol_id: 7, q: g19.q, r: g19.r };
    const ask = (revision: "v12" | "pre-v12") => withRules(resolveVariants(state.variants), () => stationPlacementRefusal(state, placement, probe.grid), revision);
    expect(ask("v12")).toMatch(/has 2 cities; the placement must say which one/);
    expect(ask("pre-v12")).toBeNull();
    expect(withRules(resolveVariants(state.variants), () => stationPlacementRefusal(state, { ...placement, city_index: 0 }, probe.grid), "v12")).toBeNull();
  });
});
