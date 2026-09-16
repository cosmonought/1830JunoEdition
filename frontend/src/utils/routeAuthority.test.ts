/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1550 (harness): ROUTES AND REVENUE, JUDGED BY THE AUTHORITY -- Batch 6
// ==================================================================
//
// Rulebook 6.4 / 6.4.1 / 6.4.2 / 6.3.3 / 6.5 (quoted in `routeAuthority.ts`). Every case builds a real board
// from the tile catalog on the standard board's plain hexes (rows H-J, west of Pittsburgh: I3 I5 I7 I9 with H6,
// H8, J2 (the Gulf), J4, J6 around them), sends a real `RunMultipleRoutes` through `applySandboxAction` with a
// grid, and reads the board back. A refusal is the state returned by identity (#778), exactly as the reducer
// returns it; the sentence is read from `routeSetRefusal`, the same predicate the socket asks (#1550 ingress).
//
// EDGES (hexGeometry): 0 E (+1,0)  1 NE (+1,-1)  2 NW (0,-1)  3 W (-1,0)  4 SW (-1,+1)  5 SE (0,+1).

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import type { ServerLogEntry } from "./roomSession";

export {};

const { applySandboxAction, isRouteTerminusHex, sandboxRouteBreakdown } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { evaluateRouteSet, routeSetRefusal, routeSkipRefusal, dividendAmountRefusal } = require("../gameEngine/routeAuthority") as typeof import("../gameEngine/routeAuthority");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog, RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxWaterfallState, sandboxScenarioState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { DEVELOPMENT_CORPUS_POLICY, RULES_ENGINE_VERSION, RULES_ENGINE_CHANGELOG, RULES_ENGINE_VERSION_FIELD, SUPPORTED_RULES_ENGINE_VERSIONS } =
  require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { STATIC_BOARD_HEXES, STANDARD_BOARD, activateBoard } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { EXPANDED_BOARD } = require("../components/hexBoardDataPlus") as typeof import("../components/hexBoardDataPlus");
const { LPF_BOARD } = require("../components/hexBoardDataLpf") as typeof import("../components/hexBoardDataLpf");
const { initialGridFor } = require("../gameEngine/initialGrid") as typeof import("../gameEngine/initialGrid");
const { validateGameplayMessage } = require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { editRouteDraft } = require("./routeDraftEdit") as typeof import("./routeDraftEdit");
const { hasLegalRouteFor, maxRouteRevenueFor } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { trainObligationFor, trainObligationRefusal } = require("../gameEngine/trainAvailability") as typeof import("../gameEngine/trainAvailability");
const { assignRouteSet } = require("../gameEngine/routeAutoTrace") as typeof import("../gameEngine/routeAutoTrace");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

/* ------------------------------------------------------------------ */
/* Boards                                                             */
/* ------------------------------------------------------------------ */

const CO = 5; // C&O, the corporation running
const BO = 4; // B&O, the rival
const PRR = 1;
const P1 = "p1"; // C&O's president
const P2 = "p2"; // B&O's president

function at(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return { q: hex.q, r: hex.r };
}

type Lay = [label: string, tileId: number, orientation: number];
const gridOf = (lays: Lay[], base: MapGridResponse = { game_id: 1, tiles: [] }): MapGridResponse => ({
  ...base,
  tiles: [...base.tiles, ...lays.map(([label, tile_id, orientation]) => ({ ...at(label), tile_id, orientation }) as MapTileEntry)],
});

/** A straight of three yellow cities:  I5 - I7 - I9 (each $20; a 2-train's best from I5 is $40, a 3-train's $60). */
const LINE = gridOf([
  ["I5", 57, 0], // city, edges 3 / 0
  ["I7", 57, 0],
  ["I9", 57, 0],
]);
/** LINE with the Gulf hanging off the west end:  J2(Gulf $30) - I3 - I5 - I7 - I9. A 2-train's best is now
 *  I5-I3-J2 ($50); a 3-train's is still I5-I7-I9 ($60); two 2-trains' best is $90. */
const GULF = gridOf([["I3", 8, 4]], LINE); // gentle curve, edges 4 (Gulf) and 0 (I5) -- plain track
/** GULF plus a straight on J4, so the Gulf has a hex on its far side to be run through to. */
const PAST_THE_GULF = gridOf([["J4", 9, 0]], GULF);
/** A crossover (#20) on I7: I5-I7-I9 is one straight, H8-I7-J6 the other; they do not touch. */
const CROSS = gridOf([
  ["I5", 57, 0],
  ["I7", 20, 0],
  ["I9", 57, 0],
  ["H8", 57, 1], // edges 1 / 4; 4 faces I7
  ["J6", 57, 1], // edges 1 / 4; 1 faces I7
]);
/** A fork (#24) on I7: both prongs (to H6 and to I5) join the one stub toward I9. */
const FORK = gridOf([
  ["I5", 57, 0],
  ["I7", 24, 0], // rails [0,2] and [0,3]: 0 -> I9, 2 -> H6, 3 -> I5
  ["I9", 57, 0],
  ["H6", 57, 2], // edges 2 / 5; 5 faces I7
]);
/** A brown hub (#63) on I5 with a loop hanging off it: I5 -> I7 -> J6 -> back into I5. I3 is a city west of it. */
const LOOP = gridOf([
  ["I3", 57, 0],
  ["I5", 63, 0],
  ["I7", 7, 3], // edges 3 (I5) / 4 (J6)
  ["J6", 7, 1], // edges 1 (I7) / 2 (I5)
]);
/** A double town (#1) on I7 crossed twice on its two separate rails: I5 -> I7 -> H8 -> I9 -> I7 -> J6. */
const DOUBLE_TOWN = gridOf([
  ["I5", 57, 0],
  ["I7", 1, 0], // rails [0,4] and [1,3]: 3 -> I5, 1 -> H8, 0 -> I9, 4 -> J6
  ["H8", 7, 4], // edges 4 (I7) / 5 (I9)
  ["I9", 7, 2], // edges 2 (H8) / 3 (I7)
  ["J6", 57, 1], // edges 1 (I7) / 4
]);
/** Towns either side of the token city: I3 (#4 straight town) - I5 (#57 city) - I7 (#4 straight town). Nothing
 *  else is laid, so every route from I5 ENDS on a town -- the S6-10 case. */
const TOWN_ENDS = gridOf([
  ["I3", 58, 0], // town, edges 0 (I5) / 2 (H4, bare) -- a #4 straight would face the Deep South off-board at I1
  ["I5", 57, 0],
  ["I7", 4, 0], // town, edges 0 (I9, bare) / 3 (I5)
]);
/** large city - small city - large city:  I5 (#57) - I7 (#4, a straight town) - I9 (#57). */
const CITY_TOWN_CITY = gridOf([
  ["I5", 57, 0],
  ["I7", 4, 0], // town, edges 0 / 3
  ["I9", 57, 0],
]);
/** A crossover crossed twice by ONE route: I5 -> I7 (straight 3-0) -> I9 -> H8 -> I7 (straight 1-4) -> J6. Legal
 *  (two separate sections of track, no city twice) and beyond the tracer, which never re-enters a plain hex. */
const CROSS_TWICE = gridOf([
  ["I5", 57, 0],
  ["I7", 20, 0],
  ["I9", 7, 2], // edges 2 (H8) / 3 (I7)
  ["H8", 7, 4], // edges 4 (I7) / 5 (I9)
  ["J6", 57, 1], // edge 1 faces I7
]);
/** An OO tile (#59) on I7: city 0 is a spur from I9's side, city 1 a spur from H6's side. */
const TWO_CITIES = gridOf([
  ["I7", 59, 0],
  ["I9", 57, 0], // edge 3 faces I7
  ["H6", 57, 2], // edge 5 faces I7
]);

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  tokens: Array<[string, number]>;
  treasury?: string;
  holdings?: Array<[string, number]>;
  home?: string;
}

function board(input: {
  corps: Corp[];
  operating?: number;
  step?: string;
  pinned?: boolean;
  extra?: Partial<GameStateResponse>;
}): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
  const operating = input.operating ?? CO;
  return {
    game_id: 1,
    player_addresses: [P1, P2],
    player_cash: [P1, P2].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "10000",
    private_companies: [],
    variants: {},
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(operating),
    operating_sub_phase: input.step ?? "Routes",
    ...(input.pinned === false ? {} : { rules_engine_version: RULES_ENGINE_VERSION }),
    market_positions: Object.fromEntries(order.map((id, index) => [id, { price: 100 - index, x: 5 + index, y: 6, enteredAt: index + 1 }])),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: corp.treasury ?? "300",
      owned_trains: corp.trains,
      player_holdings: (corp.holdings ?? [[corp.president, 60]]).map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: corp.tokens.map(([label]) => [at(label).q, at(label).r]),
      station_tokens: corp.tokens.map(([label, city]) => [at(label).q, at(label).r, city]),
      station_token_limit: 3,
      home_hex_label: corp.home ?? corp.tokens[0]?.[0] ?? "F6",
    })),
    ...input.extra,
  } as unknown as GameStateResponse;
}

const co = (trains: string[], tokens: Array<[string, number]> = [["I5", 0]]): Corp => ({ id: CO, ticker: "C&O", president: P1, trains, tokens });
const bo = (tokens: Array<[string, number]>, trains: string[] = ["2"]): Corp => ({ id: BO, ticker: "B&O", president: P2, trains, tokens });

type Route = Array<{ hex: string; city_node?: number; bypass?: boolean }>;
const R = (...hexes: string[]): Route => hexes.map((hex) => ({ hex }));

function runMsg(companyId: number, routes: Route[], indices: number[] | null, models?: string[], extra: Record<string, unknown> = {}) {
  return {
    RunMultipleRoutes: {
      game_id: 1,
      protocol_id: companyId,
      routes,
      ...(indices === null ? {} : { train_indices: indices }),
      ...(models ? { trains: models } : {}),
      revenue_turn: "3.1.x",
      ...extra,
    },
  } as never;
}

const run = (state: GameStateResponse, grid: MapGridResponse, routes: Route[], indices: number[] | null = routes.map((_, i) => i), models?: string[], extra?: Record<string, unknown>) =>
  applySandboxAction(state, runMsg(CO, routes, indices, models, extra), { mapGrid: grid, era: "Yellow" });

const why = (state: GameStateResponse, grid: MapGridResponse, routes: Route[], indices: number[] | null = routes.map((_, i) => i), models?: string[]) =>
  routeSetRefusal(state, { protocol_id: CO, routes, ...(indices === null ? {} : { train_indices: indices }), ...(models ? { trains: models } : {}) }, grid, "Yellow");

const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
type Verdict = ReturnType<typeof evaluateRouteSet>;
/** `[trainIndex, model, revenue, centres]` per run of a legal verdict; `null` for a refusal. */
const legalRuns = (verdict: Verdict) =>
  verdict.kind === "legal" ? verdict.runs.map((r) => [r.trainIndex, r.model, r.revenue, r.centres] as const) : null;
/** Refusals are proven by digest: these boards carry a chart, and the chart step rebuilds the object on every
 *  apply (#1196), so identity cannot be the witness here (the emergency-funding harness's rule). */
const same = (a: GameStateResponse, b: GameStateResponse) => stateDigest(a) === stateDigest(b);
const refused = (before: GameStateResponse, after: GameStateResponse) => expect(same(before, after)).toBe(true);
const applied = (before: GameStateResponse, after: GameStateResponse) => expect(same(before, after)).toBe(false);
const revenue = (state: GameStateResponse, id = CO) => Number(company(state, id).last_route_revenue ?? NaN);

/* ------------------------------------------------------------------ */
/* 1-2. Legal runs                                                    */
/* ------------------------------------------------------------------ */

describe("legal runs (1-2, 15-16)", () => {
  it("1. a legal single-train route is accepted and priced by the authority", () => {
    const state = board({ corps: [co(["2"])] });
    const after = run(state, LINE, [R("I5", "I7")]);
    applied(state, after);
    expect(revenue(after)).toBe(40);
    expect(company(after, CO).routes_run_this_turn).toBe(1);
    expect(company(after, CO).last_run_breakdown).toEqual([{ train_index: 0, model: "2", printed_revenue: "40" }]);
    expect(after.operating_sub_phase).toBe("Dividends");
  });

  it("2 / 15 / 16. a legal multi-train set is accepted, each train priced on its own, the total summed", () => {
    const state = board({ corps: [co(["2", "3"])] });
    const verdict = evaluateRouteSet({ state, mapGrid: GULF, era: "Yellow", companyId: CO, routes: [R("I5", "I3", "J2"), R("I5", "I7", "I9")], trainIndices: [0, 1] });
    expect(legalRuns(verdict)).toEqual([
      [0, "2", 50, 2], // I5 $20 + the Gulf $30 (yellow); I3 is plain track
      [1, "3", 60, 3],
    ]);
    expect(verdict).toMatchObject({ kind: "legal", total: 110 });
    const after = run(state, GULF, [R("I5", "I3", "J2"), R("I5", "I7", "I9")]);
    expect(revenue(after)).toBe(110);
    expect(company(after, CO).last_run_breakdown?.map((r) => r.printed_revenue)).toEqual(["50", "60"]);
  });

  it("3-train through three cities: the same city on two trains' routes is paid on both (#1319 ii)", () => {
    const state = board({ corps: [co(["3", "3"], [["I7", 0]])] });
    const after = run(state, GULF, [R("I5", "I7", "I9"), R("J2", "I3", "I5", "I7")], [0, 1]);
    // I5-I7-I9 and J2-I3-I5-I7 both run the I5-I7 section: refused.
    refused(state, after);
    expect(why(state, GULF, [R("I5", "I7", "I9"), R("J2", "I3", "I5", "I7")], [0, 1])).toMatch(/both use the track at I5|both use the track at I7/);
    // Meeting at I7 only -- separate track -- is legal, and I7 pays on both runs.
    const legal = run(state, LINE, [R("I5", "I7"), R("I7", "I9")], [0, 1]);
    expect(revenue(legal)).toBe(80);
  });
});

/* ------------------------------------------------------------------ */
/* 3-5. Corporation / train identity                                  */
/* ------------------------------------------------------------------ */

describe("train identity (3-5)", () => {
  it("3. the train must belong to the operating corporation -- another corporation's run is refused for identity", () => {
    const state = board({ corps: [co(["2"]), bo([["I9", 0]])] });
    const msg = runMsg(BO, [R("I9", "I7")], [0]);
    refused(state, applySandboxAction(state, msg, { mapGrid: LINE, era: "Yellow" }));
    // and a slot the corporation does not have
    expect(why(state, LINE, [R("I5", "I7")], [1])).toMatch(/no train in slot 1/);
    refused(state, run(state, LINE, [R("I5", "I7")], [1]));
  });

  it("4. a train named for two routes is refused", () => {
    const state = board({ corps: [co(["2", "2"])] });
    expect(why(state, GULF, [R("I5", "I7"), R("I5", "I3", "J2")], [0, 0])).toMatch(/named for two routes/);
    refused(state, run(state, GULF, [R("I5", "I7"), R("I5", "I3", "J2")], [0, 0]));
  });

  it("5. more routes than trains is refused; a trainless corporation cannot run at all", () => {
    const state = board({ corps: [co(["2"])] });
    expect(why(state, GULF, [R("I5", "I7"), R("I5", "I3", "J2")], [0, 1])).toMatch(/owns 1 train and declared 2 routes/);
    const trainless = board({ corps: [co([])] });
    expect(why(trainless, LINE, [R("I5", "I7")], [0])).toMatch(/owns 0 trains/);
    refused(trainless, run(trainless, LINE, [R("I5", "I7")], [0]));
  });

  it("the model and its capacity come from the fleet slot, never from the message", () => {
    const state = board({ corps: [co(["2"])] });
    // Claiming the slot holds a Diesel does not make the three-city run legal.
    expect(why(state, LINE, [R("I5", "I7", "I9")], [0], ["D"])).toMatch(/holds a 2-train, not the D/);
    refused(state, run(state, LINE, [R("I5", "I7", "I9")], [0], ["D"]));
    // A message with no train identity at all is paired by the authority (a log from before #1031): the
    // three-city run has no train that fits.
    expect(why(state, LINE, [R("I5", "I7", "I9")], null)).toMatch(/no train that can run it/);
    const two = board({ corps: [co(["2", "3"])] });
    const paired = evaluateRouteSet({ state: two, mapGrid: GULF, era: "Yellow", companyId: CO, routes: [R("I5", "I7", "I9"), R("I5", "I3", "J2")] });
    expect(legalRuns(paired)?.map(([index, model]) => [index, model])).toEqual([[1, "3"], [0, "2"]]);
  });

  it("ghost and reprieved trains run by their existing rules: a ghost in the fleet is a train that runs", () => {
    const state = board({ corps: [co(["2"])], extra: {} });
    const ghosted = { ...state, public_companies: state.public_companies.map((c) => ({ ...c, owned_trains: ["2", "3"], ghost_trains: ["3"] })) };
    expect(revenue(run(ghosted, GULF, [R("I5", "I3", "J2"), R("I5", "I7", "I9")], [0, 1]))).toBe(110);
  });
});

/* ------------------------------------------------------------------ */
/* 6-14. Per-route and cross-route legality                           */
/* ------------------------------------------------------------------ */

describe("per-route legality (6-12)", () => {
  const state = board({ corps: [co(["3"])] });

  it("6. a disconnected route is refused: a hex off the board, a non-adjacent step, an edge with no rail", () => {
    expect(why(state, LINE, [R("I5", "Z99")])).toMatch(/not a hex on this board/);
    expect(why(state, LINE, [R("I5", "I9")])).toMatch(/not adjacent/);
    expect(why(state, LINE, [R("I5", "J6")])).toMatch(/No track joins I5 to J6/); // adjacent, no rail
    expect(why(state, LINE, [R("I5")])).toMatch(/at least two stops/);
    refused(state, run(state, LINE, [R("I5", "I9")]));
  });

  it("7. a station of the corporation must be on the route, in the city the route actually enters", () => {
    const rival = board({ corps: [co(["2"], [["I9", 0]])] });
    expect(why(rival, LINE, [R("I5", "I7")])).toMatch(/station token in/);
    refused(rival, run(rival, LINE, [R("I5", "I7")]));
    expect(why(rival, LINE, [R("I7", "I9")])).toBeNull();
    const tokenless = board({ corps: [co(["3"], [])] });
    expect(why(tokenless, LINE, [R("I5", "I7")])).toMatch(/no station token on the board/);
    // Two cities on one hex (#59): the token's circle, not the hex, satisfies the rule (#853).
    const spur = board({ corps: [co(["2"], [["I7", 1]])] });
    expect(why(spur, TWO_CITIES, [R("I9", "I7")])).toMatch(/station token in/); // enters city 0
    expect(why(spur, TWO_CITIES, [R("H6", "I7")])).toBeNull(); // enters city 1
    expect(revenue(run(spur, TWO_CITIES, [R("H6", "I7")]))).toBe(60);
  });

  it("8. a city full of other corporations' stations may end a route but not be run through (6.3.3)", () => {
    const walled = board({ corps: [co(["3"]), bo([["I7", 0]])] });
    expect(why(walled, LINE, [R("I5", "I7", "I9")])).toMatch(/I7 is tokened out/);
    refused(walled, run(walled, LINE, [R("I5", "I7", "I9")]));
    expect(why(walled, LINE, [R("I5", "I7")])).toBeNull();
    expect(revenue(run(walled, LINE, [R("I5", "I7")]))).toBe(40);
    // An empty circle, or the corporation's own token, lets the train through.
    const open = board({ corps: [co(["3"]), bo([["I9", 0]])] });
    expect(why(open, LINE, [R("I5", "I7", "I9")])).toBeNull();
  });

  it("9. the train's number caps the cities counted; a Diesel is unlimited; a town counts; a bypass does not", () => {
    const two = board({ corps: [co(["2"])] });
    expect(why(two, LINE, [R("I5", "I7", "I9")])).toMatch(/counts 3 cities, more than a 2-train's 2/);
    refused(two, run(two, LINE, [R("I5", "I7", "I9")]));
    expect(why(state, LINE, [R("I5", "I7", "I9")])).toBeNull();
    const diesel = board({ corps: [co(["D"])] });
    expect(revenue(run(diesel, GULF, [R("J2", "I3", "I5", "I7", "I9")]))).toBe(90);
    // Towns count against the number (6.4.1: "city" includes a small city) -- four stops on a 3-train is refused.
    const three = board({ corps: [co(["3"])] });
    expect(why(three, DOUBLE_TOWN, [R("I5", "I7", "H8", "I9", "I7", "J6")])).toMatch(/counts 4 cities, more than a 3-train's 3/);
  });

  it("10. a route may not reverse at a junction or change track at a crossover", () => {
    const forked = board({ corps: [co(["3"])] });
    expect(why(forked, FORK, [R("I5", "I7", "I9")])).toBeNull();
    expect(why(forked, FORK, [R("H6", "I7", "I5")])).toMatch(/No rail through I7 joins/); // the two prongs
    refused(forked, run(forked, FORK, [R("H6", "I7", "I5")]));
    const crossed = board({ corps: [co(["3"], [["I5", 0], ["H8", 0]])] });
    expect(why(crossed, CROSS, [R("I5", "I7", "I9")])).toBeNull();
    expect(why(crossed, CROSS, [R("I5", "I7", "H8")])).toMatch(/No rail through I7 joins/); // straight to straight
    refused(crossed, run(crossed, CROSS, [R("I5", "I7", "H8")]));
  });

  it("11. a red off-board area starts or ends a route and is never run through", () => {
    expect(why(state, PAST_THE_GULF, [R("I7", "I5", "I3", "J2")])).toBeNull(); // the 3-train's best, $70
    expect(why(state, PAST_THE_GULF, [R("J2", "I3", "I5", "I7")])).toBeNull();
    expect(why(state, PAST_THE_GULF, [R("I5", "I3", "J2", "J4")])).toMatch(/J2 is a red off-board area/);
    refused(state, run(state, PAST_THE_GULF, [R("I5", "I3", "J2", "J4")]));
    // A route must begin and end at a revenue centre; plain track (I3 on this board is a bare curve) cannot.
    expect(why(state, GULF, [R("I3", "I5")])).toMatch(/I3 cannot start a route/);
    expect(why(state, GULF, [R("I5", "I3")])).toMatch(/I3 cannot end a route/);
  });

  it("12. a train may not use the same section of track twice, nor count the same city twice", () => {
    const looped = board({ corps: [co(["D"], [["I3", 0]])] });
    expect(why(looped, LOOP, [R("I3", "I5", "I7", "J6", "I5", "I7")])).toMatch(/same section of track twice at I5/);
    refused(looped, run(looped, LOOP, [R("I3", "I5", "I7", "J6", "I5", "I7")]));
    expect(why(looped, LOOP, [R("I3", "I5", "I7", "J6", "I5")])).toMatch(/counts I5 twice/);
    // I3 -> I5 -> I7 -> J6 ends on plain track; the loop itself is fine when it ends at a city.
    expect(why(looped, LOOP, [R("I3", "I5", "I7", "J6")])).toMatch(/J6 cannot end a route/);
  });

  it("the other city (or town) of the same hex may be visited: two rails, two stops, both paid (6.4.2)", () => {
    const four = board({ corps: [co(["4"])] });
    const path = R("I5", "I7", "H8", "I9", "I7", "J6");
    expect(why(four, DOUBLE_TOWN, [path])).toBeNull();
    const after = run(four, DOUBLE_TOWN, [path]);
    expect(revenue(after)).toBe(60); // I5 $20, town $10, town $10, J6 $20
    expect(sandboxRouteBreakdown(DOUBLE_TOWN, path, "Yellow", CO).centres).toBe(4);
  });

  it("a named city must be the one the rail enters, and a bypass only where the rails offer one", () => {
    expect(why(state, TWO_CITIES, [[{ hex: "I9" }, { hex: "I7", city_node: 1 }]])).toMatch(/does not enter city 1/);
    expect(why(state, LINE, [[{ hex: "I5" }, { hex: "I7", bypass: true }, { hex: "I9" }]])).toMatch(/cannot be bypassed/);
    expect(why(state, LINE, [[{ hex: "I5" }, { hex: "I7", bypass: true }]])).toMatch(/cannot be bypassed/);
    expect(why(state, LINE, [[{ hex: "I5" }, { hex: "I7", city_node: 7 }]])).toMatch(/names a city/);
  });
});

/* ------------------------------------------------------------------ */
/* S6-10 (#1555): a town is a terminus                                 */
/* ------------------------------------------------------------------ */

describe("a town is a terminus (S6-10, rulebook 6.4 / 6.4.2, #1555)", () => {
  it("a town -> city route is legal, priced, and accepted by the reducer; so is starting on the town", () => {
    const state = board({ corps: [co(["2"])] });
    expect(why(state, TOWN_ENDS, [R("I5", "I7")])).toBeNull();
    expect(why(state, TOWN_ENDS, [R("I7", "I5")])).toBeNull();
    const after = run(state, TOWN_ENDS, [R("I5", "I7")]);
    applied(state, after);
    expect(revenue(after)).toBe(30); // city $20 + town $10
    expect(company(after, CO).last_run_breakdown).toEqual([{ train_index: 0, model: "2", printed_revenue: "30" }]);
    // Town - city - town on a 3-train: both towns are cities for the count and both are legal ends.
    const three = board({ corps: [co(["3"])] });
    expect(why(three, TOWN_ENDS, [R("I3", "I5", "I7")])).toBeNull();
    expect(revenue(run(three, TOWN_ENDS, [R("I3", "I5", "I7")]))).toBe(40);
    // Two towns still need a station between them: the 2-train may not run I3-I5-I7 (3 stops), and I3-I5 is fine.
    expect(why(state, TOWN_ENDS, [R("I3", "I5", "I7")])).toMatch(/counts 3 cities/);
    expect(why(state, TOWN_ENDS, [R("I3", "I5")])).toBeNull();
  });

  it("the tracer drafts it, the draft editor allows the first click, and the shell's terminus test agrees", () => {
    expect(isRouteTerminusHex(TOWN_ENDS, "I7")).toBe(true);
    expect(isRouteTerminusHex(TOWN_ENDS, "I5")).toBe(true);
    expect(isRouteTerminusHex(GULF, "I3")).toBe(false); // plain track stays plain track
    const drafted = assignRouteSet({
      mapGrid: TOWN_ENDS,
      era: "Yellow",
      startHexes: [[at("I5").q, at("I5").r, 0]],
      trains: [{ trainIndex: 0, maxRevenueCentres: 2 }],
      companyId: CO,
    });
    expect(drafted.assignments).toHaveLength(1);
    const drawn = drafted.assignments[0].path.map((p) => p.hexLabel);
    expect(drawn).toContain("I5");
    expect(["I3", "I7"]).toContain(drawn[drawn.length - 1] === "I5" ? drawn[0] : drawn[drawn.length - 1]); // ends on a town
    expect(drafted.totalRevenue).toBe(30);
    const town = { ...at("I7"), hexLabel: "I7" };
    expect(editRouteDraft({ mapGrid: TOWN_ENDS, points: [], click: town, displayLabel: "I7", maxDistance: 2 }).ok).toBe(true);
    // And the preview the shell runs before dispatch agrees with the authority.
    const state = board({ corps: [co(["2"])] });
    expect(evaluateRouteSet({ state, mapGrid: TOWN_ENDS, era: "Yellow", companyId: CO, routes: [R("I5", "I7")], trainIndices: [0] })).toMatchObject({ kind: "legal", total: 30 });
  });

  it("a town terminus is the only legal route: the auto-skip sees it and the forced train purchase is owed", () => {
    // With a train: the Run Trains step may not be skipped, because I5-I7 (or I5-I3) is a paying route.
    const withTrain = board({ corps: [co(["2"])] });
    expect(maxRouteRevenueFor(withTrain, CO, TOWN_ENDS)).toBe(30);
    expect(routeSkipRefusal(withTrain, { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: CO } } as never, TOWN_ENDS)).toMatch(/worth up to \$30/);
    // Trainless: the Batch-4/5 gate asks `hasLegalRouteFor`, which searches through the same predicate.
    const trainless = board({ corps: [co([])], step: "Hardware", extra: { current_global_era: "Yellow" } as never });
    expect(hasLegalRouteFor(trainless, CO, TOWN_ENDS)).toBe(true);
    expect(trainObligationFor(trainless, CO, TOWN_ENDS).owed).toBe(true);
    expect(trainObligationRefusal(trainless, { PassTurn: { game_id: 1 } } as never, TOWN_ENDS)).toMatch(/must acquire one/);
    // The negative control: the same board with the towns' tiles removed has no route, and no obligation.
    const bare = gridOf([["I5", 57, 0]]);
    expect(hasLegalRouteFor(trainless, CO, bare)).toBe(false);
    expect(trainObligationFor(trainless, CO, bare).owed).toBe(false);
    expect(trainObligationRefusal(trainless, { PassTurn: { game_id: 1 } } as never, bare)).toBeNull();
  });
});

describe("a town run through is a counted city (6.4.1: 'includes all of the cities that the route runs through')", () => {
  /* THE ONE MODEL. `sandboxRouteBreakdown` (sandboxSession.ts #1318) walks every non-bypassed waypoint, adds its
     value and pushes it to `stops` when `isRevenueCentreHex` (archetype !== "Plain" -- SingleTown and DoubleTown
     included, #289 "a $0 city still costs a train a stop"); `centres = stops.length`. The authority's capacity
     check (`walkRoute` step 8 / `evaluateRouteSet`), the tracer's leash (`candidatePathsFrom`,
     `breakdown.centres >= maxCentres`) and the shell's `exceedsMaxDistance` (`trainDrafts`, `stops.length`) all
     read that count, and the reducer's `last_route_revenue` is that sum. A town cannot be flagged past
     (`bypass` is refused where the rails offer no bow), so it is never "just track". */
  const path = R("I5", "I7", "I9");

  it("capacity: large city -> town -> large city is three cities, not two", () => {
    const two = board({ corps: [co(["2"])] });
    expect(why(two, CITY_TOWN_CITY, [path])).toMatch(/counts 3 cities, more than a 2-train's 2/);
    refused(two, run(two, CITY_TOWN_CITY, [path]));
    const three = board({ corps: [co(["3"])] });
    expect(why(three, CITY_TOWN_CITY, [path])).toBeNull();
    expect(sandboxRouteBreakdown(CITY_TOWN_CITY, path, "Yellow", CO)).toMatchObject({
      centres: 3,
      stops: [{ hex: "I5", value: 20 }, { hex: "I7", value: 10 }, { hex: "I9", value: 20 }],
    });
    // The town may not be flagged past: no rail on #4 misses its centre.
    expect(why(three, CITY_TOWN_CITY, [[{ hex: "I5" }, { hex: "I7", bypass: true }, { hex: "I9" }]])).toMatch(/I7 has no track that goes around/);
  });

  it("revenue: the authoritative total includes the town", () => {
    const three = board({ corps: [co(["3"])] });
    const after = run(three, CITY_TOWN_CITY, [path]);
    expect(revenue(after)).toBe(50); // $20 + $10 + $20
    expect(company(after, CO).last_run_breakdown).toEqual([{ train_index: 0, model: "3", printed_revenue: "50" }]);
    expect(evaluateRouteSet({ state: three, mapGrid: CITY_TOWN_CITY, era: "Yellow", companyId: CO, routes: [path], trainIndices: [0] })).toMatchObject({ kind: "legal", total: 50 });
  });

  it("the tracer counts it the same way: a 2-train cannot reach past the town, a 3-train collects all three", () => {
    const trace = (cap: number) =>
      assignRouteSet({ mapGrid: CITY_TOWN_CITY, era: "Yellow", startHexes: [[at("I5").q, at("I5").r, 0]], trains: [{ trainIndex: 0, maxRevenueCentres: cap }], companyId: CO });
    const withTwo = trace(2);
    expect(withTwo.totalRevenue).toBe(30); // I5 + the town; I9 is out of reach behind a counted stop
    expect(withTwo.assignments[0].path.map((p) => p.hexLabel)).not.toContain("I9");
    const withThree = trace(3);
    expect(withThree.totalRevenue).toBe(50);
    expect(withThree.assignments[0].path.map((p) => p.hexLabel).sort()).toEqual(["I5", "I7", "I9"]);
    // And the search agrees with the authority on the best a 2-train can do here.
    expect(maxRouteRevenueFor(board({ corps: [co(["2"])] }), CO, CITY_TOWN_CITY)).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* S6-3 (#1556): the highest-revenue combination, as a demonstrated bound */
/* ------------------------------------------------------------------ */

describe("the highest-revenue combination is a demonstrated lower bound (S6-3, rulebook 6.4, #1556)", () => {
  const SHORTFALL = /Route set earns \$40; a legal combination worth \$60 is available\./;

  it("a legal but suboptimal run is refused with the demonstrated figure, in the core and at ingress", () => {
    const state = board({ corps: [co(["3"])] });
    expect(why(state, LINE, [R("I5", "I7")])).toMatch(SHORTFALL);
    refused(state, run(state, LINE, [R("I5", "I7")]));
    expect(turnRefusal({ state, waterfall: null, actor: P1, msg: runMsg(CO, [R("I5", "I7")], [0], ["3"]), mapGrid: LINE })).toMatch(SHORTFALL);
    // The figure is the search's own concrete set, so the auto-tracer offers exactly what the authority demands.
    expect(maxRouteRevenueFor(state, CO, LINE, "Yellow")).toBe(60);
  });

  it("a run equal to the search's value is accepted", () => {
    const state = board({ corps: [co(["3"])] });
    expect(why(state, LINE, [R("I5", "I7", "I9")])).toBeNull();
    expect(revenue(run(state, LINE, [R("I5", "I7", "I9")]))).toBe(60);
  });

  it("a legal hand-drawn run above the heuristic's result is accepted -- the search is a bound, not a ceiling", () => {
    const state = board({ corps: [co(["2"])] });
    // The tracer never re-enters a plain hex, so it finds nothing here at all ...
    expect(maxRouteRevenueFor(state, CO, CROSS_TWICE, "Yellow")).toBe(0);
    // ... while the route across both straights of the crossover is legal and pays $40.
    const twice = R("I5", "I7", "I9", "H8", "I7", "J6");
    expect(why(state, CROSS_TWICE, [twice])).toBeNull();
    expect(revenue(run(state, CROSS_TWICE, [twice]))).toBe(40);
  });

  it("the comparison is on the corporation's total, not train by train", () => {
    const state = board({ corps: [co(["2", "2"])] });
    expect(maxRouteRevenueFor(state, CO, GULF, "Yellow")).toBe(90); // I5-I3-Gulf $50 + I5-I7 $40
    // The best single route, run alone with the second train idle: $50 < $90 -- refused as a combination.
    expect(why(state, GULF, [R("I5", "I3", "J2")], [1], ["2"])).toMatch(/Route set earns \$50; a legal combination worth \$90/);
    // Two legal routes that are each fine but total less than the demonstrated pair: refused.
    const walled = board({ corps: [co(["2", "2"]), bo([["I9", 0]])] });
    expect(why(walled, GULF, [R("I5", "I7"), R("I5", "I3", "J2")], [0, 1])).toBeNull();
    expect(revenue(run(walled, GULF, [R("I5", "I7"), R("I5", "I3", "J2")], [0, 1]))).toBe(90);
  });

  it("the demonstration is built from the corporation's actual fleet and the board's blocking rules", () => {
    // Fleet: the same $50 route is the best a 2-train can do and short of what a 3-train can do ($70: I7-I5-I3-Gulf).
    expect(why(board({ corps: [co(["2"])] }), GULF, [R("I5", "I3", "J2")])).toBeNull();
    expect(why(board({ corps: [co(["3"])] }), GULF, [R("I5", "I3", "J2")])).toMatch(/earns \$50; a legal combination worth \$70/);
    // Blocking: with I7 tokened out by B&O, a 3-train's best from I5 is I5-I7 ($40, ending in the wall) -- accepted;
    // on the open board the same run is short of I5-I7-I9.
    const walled = board({ corps: [co(["3"]), bo([["I7", 0]])] });
    expect(maxRouteRevenueFor(walled, CO, LINE, "Yellow")).toBe(40);
    expect(why(walled, LINE, [R("I5", "I7")])).toBeNull();
    expect(why(board({ corps: [co(["3"])] }), LINE, [R("I5", "I7")])).toMatch(SHORTFALL);
  });

  it("replay and RevertTo stay deterministic under the bound", () => {
    const providers = () => ({ ...sandboxReplayProviders(), initialGrid: LINE });
    const seed = () => ({ state: board({ corps: [co(["3"])] }), waterfall: null });
    const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
    const SHORT = runMsg(CO, [R("I5", "I7")], [0], ["3"], { revenue_turn: "3.1.5" });
    const BEST = runMsg(CO, [R("I5", "I7", "I9")], [0], ["3"], { revenue_turn: "3.1.5" });
    const once = replayLog([entry(0, P1, SHORT), entry(1, P1, BEST)], providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    const twice = replayLog([entry(0, P1, SHORT), entry(1, P1, BEST)], providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(revenue(once.state)).toBe(60); // the short run was a no-op; the best one ran
    expect(stateDigest(once.state)).toBe(stateDigest(twice.state));
    const room = new RoomSession({ providers: providers(), seed: seed(), build: "b", mintId: () => `m${Math.random()}` });
    const submit = (msg: never) => room.submit({ actor: P1, build: "b", msg, baseIndex: room.nextIndex - 1, host: P1 });
    const short = submit(SHORT);
    expect(short.kind).toBe("refused");
    expect((short as { reason: string }).reason).toMatch(SHORTFALL);
    expect(submit(BEST).kind).toBe("applied");
    expect(submit({ RevertTo: { index: 0, player: P1, summary: "undo" } } as never).kind).toBe("applied");
    expect(company(room.state, CO).routes_run_this_turn ?? 0).toBe(0);
    expect(submit(BEST).kind).toBe("applied");
    const restored = new RoomSession({ providers: providers(), seed: seed(), build: "b", mintId: () => "x" });
    restored.restore(room.entries as ServerLogEntry[]);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
    expect(revenue(restored.state)).toBe(60);
  });
});

describe("cross-route legality (13-14)", () => {
  it("13. two of the corporation's trains may not share a section of track", () => {
    const state = board({ corps: [co(["2", "2"])] });
    expect(why(state, LINE, [R("I5", "I7"), R("I5", "I7")], [0, 1])).toMatch(/Routes 1 and 2 both use the track at/);
    refused(state, run(state, LINE, [R("I5", "I7"), R("I5", "I7")], [0, 1]));
    // The fork's shared stub toward I9 is one piece of track for both prongs (#731).
    const forked = board({ corps: [co(["2", "2"], [["I5", 0], ["H6", 0]])] });
    expect(why(forked, FORK, [R("I5", "I7", "I9"), R("H6", "I7", "I9")], [0, 1])).toMatch(/both use the track at I7/);
  });

  it("14. sharing a city, a hex on separate tracks, or an off-board destination by different edges stays legal", () => {
    const state = board({ corps: [co(["2", "2"])] });
    // Meeting at I5: one train leaves east, the other west -- two stubs of one straight (#669).
    expect(why(state, GULF, [R("I5", "I7"), R("I5", "I3", "J2")], [0, 1])).toBeNull();
    // Crossing one hex on the two separate straights of a crossover.
    const crossed = board({ corps: [co(["2", "2"], [["I5", 0], ["H8", 0]])] });
    expect(why(crossed, CROSS, [R("I5", "I7", "I9"), R("H8", "I7", "J6")], [0, 1])).toBeNull();
    expect(revenue(run(crossed, CROSS, [R("I5", "I7", "I9"), R("H8", "I7", "J6")], [0, 1]))).toBe(80);
  });
});

/* ------------------------------------------------------------------ */
/* 17-19. Revenue and dividend authority                              */
/* ------------------------------------------------------------------ */

describe("revenue and dividend authority (17-19)", () => {
  it("17. a crafted revenue figure on the message cannot change the total", () => {
    const state = board({ corps: [co(["2"])] });
    const after = run(state, LINE, [R("I5", "I7")], [0], ["2"], { revenue: "9999", printed_revenue: "9999", last_route_revenue: "9999", total: 9999 });
    expect(revenue(after)).toBe(40);
    expect(company(after, CO).printed_route_revenue).toBe("40");
  });

  it("18. DeclareDividends pays only the authoritative run: a mismatched amount is refused at the reducer and at ingress", () => {
    const state = board({ corps: [co(["2"])] });
    const ran = run(state, LINE, [R("I5", "I7")]);
    expect(ran.operating_sub_phase).toBe("Dividends");
    const declare = (amount: string) => ({ DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: amount, distribute: true } }) as never;
    expect(dividendAmountRefusal(ran, { protocol_id: CO, revenue_amount: "400" })).toMatch(/ran \$40 this turn; a dividend declaration of \$400/);
    refused(ran, applySandboxAction(ran, declare("400"), { mapGrid: LINE, era: "Yellow" }));
    refused(ran, applySandboxAction(ran, declare("0"), { mapGrid: LINE, era: "Yellow" }));
    expect(turnRefusal({ state: ran, waterfall: null, actor: P1, msg: declare("400"), mapGrid: LINE })).toMatch(/does not match/);
    const paid = applySandboxAction(ran, declare("40"), { mapGrid: LINE, era: "Yellow" });
    applied(ran, paid);
    expect(Number(paid.player_cash.find((row) => row.player === P1)?.cash_vgp)).toBe(524); // 60% of $40
    expect(paid.operating_sub_phase).toBe("Hardware");
    // Nothing ran: only $0 may be declared.
    const idle = board({ corps: [co(["2"])], step: "Dividends" });
    expect(dividendAmountRefusal(idle, { protocol_id: CO, revenue_amount: "50" })).toMatch(/ran \$0/);
    expect(dividendAmountRefusal(idle, { protocol_id: CO, revenue_amount: "0" })).toBeNull();
    // A log written before #752 carries no amount: judged by the field it would have read.
    expect(dividendAmountRefusal(idle, { protocol_id: CO })).toBeNull();
  });

  it("19. a repeated or stale run in the same turn cannot double the revenue, whatever key it carries", () => {
    const state = board({ corps: [co(["2"])] });
    const once = run(state, LINE, [R("I5", "I7")], [0], ["2"], { revenue_turn: "3.1.5" });
    expect(revenue(once)).toBe(40);
    refused(once, run(once, LINE, [R("I5", "I7")], [0], ["2"], { revenue_turn: "3.1.5" }));
    refused(once, run(once, LINE, [R("I5", "I7")], [0], ["2"], { revenue_turn: "9.9.9" }));
    refused(once, run(once, LINE, [R("I5", "I7")], [0], ["2"], {}));
    expect(why(once, LINE, [R("I5", "I7")])).toMatch(/already run its trains this turn/);
    // The #1183 key now lands where it is read (the state), so its undo semantics hold too.
    expect(once.last_run_turn_key).toBe("3.1.5");
    // Out of step: a run at the Track step is refused.
    const early = board({ corps: [co(["2"])], step: "Track" });
    expect(why(early, LINE, [R("I5", "I7")])).toMatch(/Run Trains step/);
    refused(early, run(early, LINE, [R("I5", "I7")]));
  });

  it("the legacy RunManualRoute arm is closed on a pinned board and open to a legacy log", () => {
    const pinned = board({ corps: [co(["2"])] });
    const manual = { RunManualRoute: { game_id: 1, protocol_id: CO, path: R("I5", "I7"), payout_strategy: "Withhold" } } as never;
    refused(pinned, applySandboxAction(pinned, manual, { mapGrid: LINE, era: "Yellow" }));
    expect(turnRefusal({ state: pinned, waterfall: null, actor: P1, msg: manual, mapGrid: LINE })).toMatch(/legacy replay message/);
    const legacy = board({ corps: [co(["2"])], pinned: false });
    expect(revenue(applySandboxAction(legacy, manual, { mapGrid: LINE, era: "Yellow" }))).toBe(40);
  });
});

/* ------------------------------------------------------------------ */
/* 10 (Part 10). No-route and skip cases                              */
/* ------------------------------------------------------------------ */

describe("no-route, zero-revenue and skipping (Part 10)", () => {
  const ADVANCE = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: CO } } as never;
  const PASS = { PassTurn: { game_id: 1 } } as never;

  it("a corporation with trains and a paying route may not skip Run Trains or end its turn there", () => {
    const state = board({ corps: [co(["2"])] });
    expect(routeSkipRefusal(state, ADVANCE, GULF)).toMatch(/has a route it can run \(worth up to \$50\)/); // I5-I3-Gulf
    expect(routeSkipRefusal(state, PASS, LINE)).toMatch(/has a route it can run/);
    refused(state, applySandboxAction(state, ADVANCE, { mapGrid: LINE, era: "Yellow" }));
    expect(turnRefusal({ state, waterfall: null, actor: P1, msg: ADVANCE, mapGrid: LINE })).toMatch(/has a route it can run/);
    // Once it has run, the step moves on and nothing objects to the turn ending.
    const ran = run(state, LINE, [R("I5", "I7")]);
    expect(routeSkipRefusal(ran, PASS, LINE)).toBeNull();
  });

  it("a corporation with trains but no legal route skips; a trainless one skips (the forced purchase is Batch 4/5's)", () => {
    const stranded = board({ corps: [co(["2"], [["I9", 0]])] }); // I9's only rail runs west to I7 -- one city each way? No: I9-I7 pays.
    expect(routeSkipRefusal(stranded, ADVANCE, LINE)).toMatch(/has a route/);
    const isolated = board({ corps: [co(["2"], [["H6", 0]])] }); // H6 has no track on LINE
    expect(routeSkipRefusal(isolated, ADVANCE, LINE)).toBeNull();
    applied(isolated, applySandboxAction(isolated, ADVANCE, { mapGrid: LINE, era: "Yellow" }));
    const trainless = board({ corps: [co([])] });
    expect(routeSkipRefusal(trainless, ADVANCE, LINE)).toBeNull();
    expect(why(trainless, LINE, [R("I5", "I7")])).toMatch(/owns 0 trains/);
  });

  it("a legacy (unpinned) board keeps the skips its log recorded", () => {
    const legacy = board({ corps: [co(["2"])], pinned: false });
    applied(legacy, applySandboxAction(legacy, ADVANCE, { mapGrid: LINE, era: "Yellow" }));
  });

  it("without a grid the gate has no opinion (#757), so fixtures exercising other rules still run", () => {
    const state = board({ corps: [co(["2"])] });
    const after = applySandboxAction(state, runMsg(CO, [R("I5", "I7")], [0]));
    applied(state, after);
  });
});

/* ------------------------------------------------------------------ */
/* 20. The PRR $60 -> $30 defect (LPF / 1830+ herald home)             */
/* ------------------------------------------------------------------ */

describe.each([
  ["18XX+ (expandedMap)", EXPANDED_BOARD, { expandedMap: true, plusTiles: true }],
  ["Level Playing Field", LPF_BOARD, { levelPlayingField: true, expandedMap: true, plusTiles: true }],
] as const)("20. the PRR that ran $60 and was paid $30 (#1554) on the %s board", (_name, BOARD, variants) => {
  /* The reducer scopes the board from `state.variants` (`withRules`, #1300); the evaluator called directly
     reads the board in effect, so both are set. The LPF playtest reported it; 18XX+ prints the same herald. */
  beforeAll(() => activateBoard(BOARD));
  afterAll(() => activateBoard(STANDARD_BOARD));

  const H10 = { q: 1, r: 7 };
  const H14 = { q: 3, r: 7 };
  const plusGrid = (): MapGridResponse => {
    const base = initialGridFor(BOARD);
    return { ...base, tiles: [...base.tiles, { ...H10, tile_id: 57, orientation: 0 } as MapTileEntry, { ...H14, tile_id: 57, orientation: 0 } as MapTileEntry] };
  };
  const prrBoard = () => board({
    corps: [{ id: PRR, ticker: "PRR", president: P1, trains: ["2", "2"], tokens: [], home: "H12" }],
    operating: PRR,
    extra: { variants: { ...variants } } as never,
  });
  const TO_HOME = R("H10", "H12");
  const FROM_HOME = R("H12", "H14");

  it("both routes are legal for the herald's owner and total $60 in the authority", () => {
    const state = prrBoard();
    const grid = plusGrid();
    const verdict = evaluateRouteSet({ state, mapGrid: grid, era: "Yellow", companyId: PRR, routes: [TO_HOME, FROM_HOME], trainIndices: [0, 1] });
    expect(legalRuns(verdict)?.map(([, , revenue]) => revenue)).toEqual([30, 30]);
    expect(verdict).toMatchObject({ kind: "legal", total: 60 });
    const after = applySandboxAction(state, runMsg(PRR, [TO_HOME, FROM_HOME], [0, 1], ["2", "2"]), { mapGrid: grid, era: "Yellow" });
    expect(revenue(after, PRR)).toBe(60);
  });

  it("ROOT CAUSE: the shell's terminus test was asked without the corporation, so the route ENDING on the herald was dropped before dispatch", () => {
    const grid = plusGrid();
    // The predicate the draft memo used (no corporation): H12 is not a terminus, so `endsOffTerminus` was true
    // for TO_HOME and `runnableDrafts` skipped it -- one route dispatched, $30 shown.
    expect(isRouteTerminusHex(grid, "H12")).toBe(false);
    // The predicate every other reader used (the tracer, the pricing, and now the shell): H12 is PRR's terminus.
    expect(isRouteTerminusHex(grid, "H12", PRR)).toBe(true);
    // FROM_HOME survived because a route's START is judged by the tracer with the corporation. Both are drawn.
    const app = readStripped("App.tsx");
    expect(app).toContain("!isRouteTerminusHex(mapGrid, last.hexLabel, actingProtocolId ?? undefined)");
    expect(app).not.toContain("!isRouteTerminusHex(mapGrid, last.hexLabel)\n");
    // And a hand-drawn route may now START on the herald for its owner (rule 1 of the draft editor).
    const start = { q: 2, r: 7, hexLabel: "H12" };
    expect(editRouteDraft({ mapGrid: grid, points: [], click: start, displayLabel: "Altoona (H12)", maxDistance: 2, forCompanyId: PRR }).ok).toBe(true);
    expect(editRouteDraft({ mapGrid: grid, points: [], click: start, displayLabel: "Altoona (H12)", maxDistance: 2 }).ok).toBe(false);
  });

  it("the herald is nobody else's: NYC neither counts it nor may end there, and cannot bypass a plain hex", () => {
    const grid = plusGrid();
    const nyc = board({ corps: [{ id: 2, ticker: "NYC", president: P1, trains: ["3"], tokens: [["H10", 0]] }], operating: 2, extra: { variants: { ...variants } } as never });
    const verdict = evaluateRouteSet({ state: nyc, mapGrid: grid, era: "Yellow", companyId: 2, routes: [R("H10", "H12", "H14")], trainIndices: [0] });
    expect(verdict).toMatchObject({ kind: "legal", total: 40 });
    const ends = evaluateRouteSet({ state: nyc, mapGrid: grid, era: "Yellow", companyId: 2, routes: [R("H10", "H12")], trainIndices: [0] });
    expect(ends.kind === "refused" && ends.reason).toMatch(/H12 cannot end a route/);
    const bypass = evaluateRouteSet({ state: nyc, mapGrid: grid, era: "Yellow", companyId: 2, routes: [[{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "H14" }]], trainIndices: [0] });
    expect(bypass.kind === "refused" && bypass.reason).toMatch(/cannot be bypassed/);
    // PRR may pass its herald uncounted (#1302) -- two cities on a 2-train, $40, and the flag is kept.
    const prr = prrBoard();
    const passed = evaluateRouteSet({ state: prr, mapGrid: grid, era: "Yellow", companyId: PRR, routes: [[{ hex: "H10" }, { hex: "H12", bypass: true }, { hex: "H14" }]], trainIndices: [0] });
    expect(passed.kind === "legal" && passed.total).toBe(40);
  });
});

/* ------------------------------------------------------------------ */
/* 21-23. Replay, RevertTo, the version                               */
/* ------------------------------------------------------------------ */

describe("the log (21-23)", () => {
  const providers = () => ({ ...sandboxReplayProviders(), initialGrid: GULF });
  const seed = () => ({ state: board({ corps: [co(["2", "2"]), bo([["I9", 0]])] }), waterfall: null });
  const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
  const RUN = runMsg(CO, [R("I5", "I7"), R("I5", "I3", "J2")], [0, 1], ["2", "2"], { revenue_turn: "3.1.5" });
  const DECLARE = { DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: "90", distribute: false } } as never;
  const REVERT = (index: number, player: string) => ({ RevertTo: { index, player, summary: "undo" } });

  it("21. a same-version route log rebuilds identically through the engine and through a room", () => {
    const entries = [entry(0, P1, RUN), entry(1, P1, DECLARE)];
    const once = replayLog(entries, providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    const twice = replayLog(entries, providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(once.applied).toBe(2);
    expect(stateDigest(once.state)).toBe(stateDigest(twice.state));
    expect(revenue(once.state)).toBe(90);
    expect(Number(company(once.state, CO).treasury)).toBe(390);

    const room = new RoomSession({ providers: providers(), seed: seed(), build: "b", mintId: () => `m${Math.random()}` });
    const submit = (actor: string, msg: never) => room.submit({ actor, build: "b", msg, baseIndex: room.nextIndex - 1, host: P1 });
    const bad = submit(P1, runMsg(CO, [R("I5", "I7"), R("I5", "I7")], [0, 1], ["2", "2"]));
    expect(bad.kind).toBe("refused");
    expect((bad as { reason: string }).reason).toMatch(/both use the track/);
    expect(submit(P2, RUN).kind).toBe("refused"); // not B&O's president's to send
    expect(submit(P1, RUN).kind).toBe("applied");
    expect(submit(P1, RUN).kind).toBe("refused"); // one run per turn
    const wrong = submit(P1, { DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: "180", distribute: false } } as never);
    expect((wrong as { reason: string }).reason).toMatch(/does not match/);
    expect(submit(P1, DECLARE).kind).toBe("applied");
    const restored = new RoomSession({ providers: providers(), seed: seed(), build: "b", mintId: () => "x" });
    restored.restore(room.entries as ServerLogEntry[]);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
    expect(revenue(restored.state)).toBe(90);
  });

  it("22. RevertTo reconstructs the route and revenue state exactly", () => {
    const undone = replayLog([entry(0, P1, RUN), entry(1, P1, REVERT(0, P1))], providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(undone.applied).toBe(0);
    const untouched = replayLog([], providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(stateDigest(undone.state)).toBe(stateDigest(untouched.state));
    expect(company(undone.state, CO).routes_run_this_turn ?? 0).toBe(0);
    expect(undone.state.last_run_turn_key).toBeUndefined();
    // and the honest re-dispatch after an undo is accepted, at the same key (#1183's undo case)
    const again = replayLog([entry(0, P1, RUN), entry(1, P1, REVERT(0, P1)), entry(2, P1, RUN)], providers(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(revenue(again.state)).toBe(90);
  });

  it("23. RULES_ENGINE_VERSION is at least 4, the changelog says why, and a version-3 room is refused before reducer replay", () => {
    /* Batch 7.5 bumped the pin to 5 (Batch 7's transaction authority, #1560-#1598); this case keeps asserting
       what Batch 6 introduced -- the version-4 row and the refusal of a version-3 room -- against whatever the
       current pin is, as Batch 6 itself relaxed Batch 5's `3` to `>= 3`. A version-only edit: nothing about the
       route authority's replay meaning changed. */
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(4);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version).slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(RULES_ENGINE_CHANGELOG[3].note).toMatch(/route|revenue|dividend/i);
    const seedOf = () => ({
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    });
    const fresh = new RoomSession({ providers: sandboxReplayProviders(), seed: seedOf(), build: "b", mintId: () => "d" });
    expect(fresh.submit({ actor: P1, build: "b", msg: { SetupGame: { players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }], variants: {}, build: "b" } } as never, baseIndex: -1 }).kind).toBe("applied");
    expect(fresh.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
    expect(fresh.state.rules_engine_version).toBe(RULES_ENGINE_VERSION); // #1551: the pin is on the board
    const versionThree = fresh.entries.map((row) => {
      const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
      return parsed.SetupGame ? { ...row, payload: JSON.stringify({ ...parsed, SetupGame: { ...parsed.SetupGame, [RULES_ENGINE_VERSION_FIELD]: 3 } }) } : { ...row };
    });
    const applySpy = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const old = new RoomSession({ providers: sandboxReplayProviders(), seed: seedOf(), build: "b", mintId: () => "x" });
      old.restore(versionThree as ServerLogEntry[]);
      expect(applySpy).not.toHaveBeenCalled();
      expect(old.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 3, supported: [RULES_ENGINE_VERSION] });
    } finally {
      applySpy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Ingress: the schema refuses shapes, never rules (#1553)            */
/* ------------------------------------------------------------------ */

describe("the schema at the door (#1553)", () => {
  const msg = (routes: unknown, extra: Record<string, unknown> = {}) => ({ RunMultipleRoutes: { protocol_id: CO, routes, ...extra } });
  it("refuses malformed route payloads", () => {
    expect(validateGameplayMessage(msg("x")).ok).toBe(false);
    expect(validateGameplayMessage(msg([["I5", "I7"]])).ok).toBe(false);
    expect(validateGameplayMessage(msg([[{ hex: 5 }]])).ok).toBe(false);
    expect(validateGameplayMessage(msg([[{ hex: "I5", city_node: "1" }]])).ok).toBe(false);
    expect(validateGameplayMessage(msg([[{ hex: "I5", bypass: "yes" }]])).ok).toBe(false);
    expect(validateGameplayMessage(msg([[{ hex: "I5" }, { hex: "I7" }]], { train_indices: ["0"] })).ok).toBe(false);
    expect(validateGameplayMessage(msg([[{ hex: "I5" }, { hex: "I7" }]], { trains: [2] })).ok).toBe(false);
    expect(validateGameplayMessage(msg(Array.from({ length: 65 }, () => [{ hex: "I5" }, { hex: "I7" }]))).ok).toBe(false);
    expect(validateGameplayMessage({ RunManualRoute: { protocol_id: CO, path: [1], payout_strategy: "Withhold" } }).ok).toBe(false);
  });
  it("admits every shape the stored logs carry, and leaves the rules to the reducer", () => {
    expect(validateGameplayMessage(msg([[{ hex: "H16" }, { hex: "H14" }, { bypass: true, hex: "H12" }, { hex: "H10" }]], { trains: ["2"], train_indices: [1], revenue_seed: 1, revenue_turn: "5.1.1", payout_strategy: "Withhold" })).ok).toBe(true);
    expect(validateGameplayMessage(msg([[{ hex: "Z99" }, { hex: "Q1" }]])).ok).toBe(true); // a rule, not a shape
    expect(validateGameplayMessage(msg([])).ok).toBe(true); // an empty run is the reducer's to refuse
  });
});
