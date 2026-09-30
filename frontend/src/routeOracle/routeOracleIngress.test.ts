/** @jest-environment node */
//
// ==================================================================
//  ROUTE v12 R12-1 -> R12-2: HOSTED ROUTE INGRESS JUDGES A TABLE'S ROUTES ON THE TABLE'S OWN BOARD (S6-15)
// ==================================================================
//
// Brief section 8: `RoomSession.submit` -> `turnRefusal` -> `operatingLegalityRefusal`. The reducer opens the
// table's board scope (`applySandboxAction` -> `withRules`); R12-1 pinned (KNOWN-RED) that ingress did not, so on a
// 1830+ / Level Playing Field table the route arm read whatever board was in effect in the process -- STANDARD, since
// the server never activates one -- refused PRR's legal herald run, called every board-only hex "not a hex on this
// board", and let a skip through that the reducer then refused (PRR stranded at Run Trains).
//
// R12-2 REPAIRED IT (the handoff's F-1): `turnRefusal` opens the table's rules ONCE at its entry, so every arm reads
// the table's board. Each assertion below is the R12-1 pin turned around, deliberately.
//
// The second, separate ingress gap R12-1 pinned beside it -- even SCOPED, ingress never asked the reducer's Coal
// River gate -- is closed too: the route walk itself (`routeWalk.ts`) now refuses any touch of L8 by an unlicensed
// corporation, so ingress, the authority, the reducer's gate and the search give one answer.

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
] as const)("S6-15 on a hosted %s table (R12-2 repaired)", (_name, board, variants) => {
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

  it("outside any scope the process's board is STANDARD -- and ingress judges the legal run on the TABLE's board anyway", () => {
    expect(boardInEffect().id).toBe("standard");
    const c = heraldCase(board, variants);
    const state = probeState(c);
    const unscoped = turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg: RUN(PRR, HERALD_SET, ["2", "2"]), mapGrid: c.grid });
    expect(unscoped).toBeNull();
    // The scope is ingress's own and is put back: the process's board is untouched.
    expect(boardInEffect().id).toBe("standard");
    // The same predicate inside the table's own scope agrees.
    const scoped = withRules(resolveVariants(state.variants), () =>
      turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg: RUN(PRR, HERALD_SET, ["2", "2"]), mapGrid: c.grid }),
    );
    expect(scoped).toBe(unscoped);
  });

  it("end to end through RoomSession.submit: the skip is refused while a route exists, and the legal run is applied", () => {
    const c = heraldCase(board, variants);
    const state = probeState(c);
    const { room, submit } = roomFor(state, c.grid);
    // R12-1: unscoped, the route search saw no route for PRR on the standard board, so ingress let the skip through
    // and the reducer refused it by identity -- PRR stranded. Now ingress refuses it with its reason.
    const skipped = submit(SKIP(PRR));
    expect(skipped.kind).toBe("refused");
    expect((skipped as { reason: string }).reason).toMatch(/has a route it can run/);
    const ran = submit(RUN(PRR, HERALD_SET, ["2", "2"]));
    expect(ran.kind).toBe("applied");
    const prr = room.state.public_companies.find((company) => company.company_id === PRR)!;
    expect(prr.last_route_revenue).toBe("60");
    expect(prr.routes_run_this_turn ?? 0).toBeGreaterThan(0);
  });
});

describe("S6-15: every hex that exists only on the 1830+ / LPF boards is judged by the real rule at ingress (R12-2 repaired)", () => {
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
    // R12-1 pinned `Route 1: ${label} is not a hex on this board.` here. Now: the table's board judges it.
    expect(unscoped).not.toBe(`Route 1: ${label} is not a hex on this board.`);
    expect(unscoped ?? "").not.toMatch(/is not a hex on this board/);
    const scoped = withRules(resolveVariants(state.variants), () => turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg, mapGrid: c.grid }));
    expect(scoped).toBe(unscoped);
  });
});

describe("the second ingress gap is closed too: an unlicensed run to L8 is refused at ingress, as the law and the reducer refuse it", () => {
  it("ingress (scoped or not) refuses an unlicensed run to L8, and the reducer refuses it", () => {
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
    expect(scoped).toMatch(/without a Kanawha Licence/);
    expect(turnRefusal({ state, waterfall: null, actor: PRESIDENT, msg, mapGrid: c.grid })).toBe(scoped);
    const after = applySandboxAction(state, msg, { mapGrid: c.grid, era: "Yellow" });
    expect(stateDigest(after)).toBe(stateDigest(state));
  });
});
