/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1: HOSTED ROUTE INGRESS JUDGES A TABLE'S ROUTES ON THE WRONG BOARD (S6-15, KNOWN-RED)
// ==================================================================
//
// Brief section 8: `RoomSession.submit` -> `turnRefusal` -> `operatingLegalityRefusal`. The reducer opens the
// table's board scope (`applySandboxAction` -> `withRules`); this path does not, so on a 1830+ / Level Playing
// Field table the route arm reads whatever board is in effect in the process -- STANDARD, since the server
// never activates one. NOT FIXED HERE (brief: "prefer leaving a known-red fixture for R12-2"). Every assertion
// below pins today's DEFECTIVE behaviour and says so; R12-2's fix (scope `turnRefusal` once at its entry, F-1)
// must turn each one around deliberately.
//
// A second, separate ingress gap is pinned beside it: even SCOPED, ingress never asks the reducer's Coal River
// gate, so an unlicensed run to L8 passes ingress and is then refused by the reducer.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { boardInEffect, STANDARD_BOARD } from "../components/hexBoardData";
import { LPF_BOARD } from "../components/hexBoardDataLpf";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { stateDigest } from "../gameEngine/stateDigest";
import { RoomSession } from "../utils/roomSession";
import { gridOf, probeState, type ProbeCase } from "./harness/productionProbe";
import { VARIANT_ONLY_HEXES } from "./harness/knownDefects";
import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { buildOracleGraph, judgeRouteSet } from ".";

const PRR = 1;
const CO = 5;
const PRESIDENT = "p-probe";
const LPF = { expandedMap: true, plusTiles: true, levelPlayingField: true };
const PLUS = { expandedMap: true, plusTiles: true };

const at = (label: string, board = LPF_BOARD) => {
  const hex = board.hexes.find((entry) => entry.label === label)!;
  return { q: hex.q, r: hex.r };
};

/** The PRR herald board of `routeAuthority.test.ts` #20: #57 on H10 and H14 either side of H12's printed #24. */
function heraldCase(board = LPF_BOARD, variants: Record<string, unknown> = LPF): ProbeCase {
  const printed = board.hexes.flatMap((hex) => (hex.printedTile ? [{ ...at(hex.label, board), tile_id: hex.printedTile.tileId, orientation: hex.printedTile.orientation, printed: true }] : []));
  return {
    board,
    variants,
    grid: gridOf([...printed, { ...at("H10", board), tile_id: 57, orientation: 0 }, { ...at("H14", board), tile_id: 57, orientation: 0 }]),
    companies: [{ companyId: PRR, tokens: [], licences: 0, trains: ["2", "2"] }],
    companyId: PRR,
    era: "Yellow",
  };
}

const RUN = (companyId: number, routes: Array<Array<{ hex: string; bypass?: boolean }>>, trains: string[]) =>
  ({
    RunMultipleRoutes: { game_id: 1, protocol_id: companyId, routes, train_indices: routes.map((_, i) => i), trains, revenue_turn: "3.1.x" },
  }) as never;
const SKIP = (companyId: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: companyId } }) as never;

const HERALD_SET = [[{ hex: "H10" }, { hex: "H12" }], [{ hex: "H12" }, { hex: "H14" }]];

function roomFor(state: GameStateResponse, grid: MapGridResponse) {
  const room = new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: grid },
    seed: { state, waterfall: null },
    build: "b",
    mintId: () => `m${Math.random()}`,
  });
  const submit = (msg: never) => room.submit({ actor: PRESIDENT, build: "b", msg, baseIndex: room.nextIndex - 1, host: PRESIDENT });
  return { room, submit };
}

describe.each([
  ["Level Playing Field", LPF_BOARD, LPF],
  ["1830+", EXPANDED_BOARD, PLUS],
] as const)("S6-15 on a hosted %s table (KNOWN-RED)", (_name, board, variants) => {
  it("THE LAW and THE REDUCER: PRR's two herald runs are legal and worth $60 on the table's own board", () => {
    const c = heraldCase(board, variants);
    const graph = buildOracleGraph({
      board: c.board,
      grid: c.grid.tiles,
      catalog: TILE_CATALOG_BY_ID,
      companies: [{ companyId: PRR, tokens: [], licences: 0 }],
      companyId: PRR,
      highTier: false,
      licenceRule: variants === LPF,
    });
    expect(judgeRouteSet(graph, ["2", "2"], HERALD_SET, [0, 1])).toEqual({ kind: "legal", total: 60, perRoute: [30, 30] });
    const state = probeState(c);
    const after = applySandboxAction(state, RUN(PRR, HERALD_SET, ["2", "2"]), { mapGrid: c.grid, era: "Yellow" });
    expect(stateDigest(after)).not.toBe(stateDigest(state));
    expect(after.public_companies.find((company) => company.company_id === PRR)!.last_route_revenue).toBe("60");
  });

  it("KNOWN-RED: outside any scope the process's board is STANDARD, and ingress refuses the legal run on it", () => {
    expect(boardInEffect().id).toBe("standard");
    const c = heraldCase(board, variants);
    const state = probeState(c);
    const unscoped = turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg: RUN(PRR, HERALD_SET, ["2", "2"]), mapGrid: c.grid });
    expect(unscoped).toMatch(/H12 cannot end a route/);
    // The same predicate inside the table's own scope accepts it: the defect is the missing scope, nothing else.
    const scoped = withRules(resolveVariants(state.variants), () =>
      turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg: RUN(PRR, HERALD_SET, ["2", "2"]), mapGrid: c.grid }),
    );
    expect(scoped).toBeNull();
  });

  it("KNOWN-RED, end to end through RoomSession.submit: the legal run is refused, the skip is 'applied' and changes nothing", () => {
    const c = heraldCase(board, variants);
    const state = probeState(c);
    const { room, submit } = roomFor(state, c.grid);
    const ran = submit(RUN(PRR, HERALD_SET, ["2", "2"]));
    expect(ran.kind).toBe("refused");
    expect((ran as { reason: string }).reason).toMatch(/H12 cannot end a route/);
    // Unscoped, the route search sees no route for PRR on the standard board, so ingress lets the skip through;
    // the reducer (scoped) refuses it by identity. PRR is still at Run Trains having run nothing: stranded.
    const skipped = submit(SKIP(PRR));
    expect(skipped.kind).toBe("applied");
    expect(room.state.operating_sub_phase).toBe("Routes");
    expect(room.state.public_companies.find((company) => company.company_id === PRR)!.routes_run_this_turn ?? 0).toBe(0);
  });
});

describe("S6-15: every hex that exists only on the 1830+ / LPF boards is 'not a hex' to unscoped ingress (KNOWN-RED)", () => {
  it.each(VARIANT_ONLY_HEXES.map((label) => [label] as const))("%s", (label) => {
    expect(STANDARD_BOARD.hexes.some((hex) => hex.label === label)).toBe(false);
    const hex = LPF_BOARD.hexes.find((entry) => entry.label === label)!;
    // Any neighbour on the LPF board makes a two-waypoint route; the point is which board judges the hex.
    const neighbour = LPF_BOARD.hexes.find((entry) => Math.abs(entry.q - hex.q) + Math.abs(entry.r - hex.r) + Math.abs(entry.q + entry.r - hex.q - hex.r) === 2)!;
    const c: ProbeCase = {
      board: LPF_BOARD,
      variants: LPF,
      grid: gridOf([]),
      companies: [{ companyId: CO, tokens: [[hex.q, hex.r]], licences: 1, trains: ["2"] }],
      companyId: CO,
      era: "Yellow",
    };
    const state = probeState(c);
    const msg = RUN(CO, [[{ hex: label }, { hex: neighbour.label }]], ["2"]);
    const unscoped = turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg, mapGrid: c.grid });
    expect(unscoped).toBe(`Route 1: ${label} is not a hex on this board.`);
    const scoped = withRules(resolveVariants(state.variants), () => turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg, mapGrid: c.grid }));
    expect(scoped).not.toBe(unscoped);
    expect(scoped).not.toMatch(/is not a hex on this board/);
  });
});

describe("a second ingress gap, independent of the scope: ingress never asks the Coal River gate (KNOWN-RED)", () => {
  it("scoped ingress accepts an unlicensed run to L8 that the law forbids and the reducer refuses", () => {
    const c: ProbeCase = {
      board: LPF_BOARD,
      variants: LPF,
      grid: gridOf([{ ...at("K7"), tile_id: 57, orientation: 2 }]),
      companies: [{ companyId: CO, tokens: [[at("K7").q, at("K7").r, 0]], licences: 0, trains: ["2"] }],
      companyId: CO,
      era: "Yellow",
    };
    const state = probeState(c);
    const msg = RUN(CO, [[{ hex: "K7" }, { hex: "L8" }]], ["2"]);
    const scoped = withRules(resolveVariants(state.variants), () => turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg, mapGrid: c.grid }));
    expect(scoped).toBeNull();
    const after = applySandboxAction(state, msg, { mapGrid: c.grid, era: "Yellow" });
    expect(stateDigest(after)).toBe(stateDigest(state));
  });
});
