/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1699 (harness): GENTLE RUST GR-1 -- THE GRACE TURN, AND OWNING A TRAIN ON BORROWED TIME
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` rev 2 (owner spec review SR-1 ... SR-6). The grace
// entitlement is ONE OPERATING TURN THAT BEGINS AFTER THE TRAIN BECAME DOOMED (GR-S15, GR-S16); the train is
// destroyed at the end of Run Routes in that turn (GR-S18), with a turn-end fallback for that turn only
// (GR-S19); until then it is owned, routeable and keeps the corporation from being trainless, while it does not
// occupy a train-limit slot (GR-S7 ... GR-S10, GR-S22, GR-S23).
//
// EVERY RUST IN A REDUCER CASE IS A REAL ONE. Each starts from a legal pinned board (rules-engine version pinned,
// depot derived from the fleets, every corporation within its limit, a home token on its home hex) and dooms
// trains by dispatching the phase-changing `BuyHardwareFromPool` through `applySandboxAction` -- never by writing
// `pending_rust_trains` by hand. Turns end by `PassTurn`, steps advance by `AdvanceOperatingSubPhase`, runs are
// `RunMultipleRoutes` against a real grid, and Stock Rounds are passed seat by seat, all with the acting
// president as the actor. A refusal is proven by digest (#778's identity cannot be the witness on a board that
// carries a chart, #1196). The only hand-built marks are two helper-contract cases in T9, labelled as such.
//
// MEASURED AGAINST THE PRE-GR-1 ENGINE (`b846307`): 11 of these 24 cases fail there -- T3 (all four), T4, T5's
// two self-trigger cases, T9's doomed-this-turn record, the partial-expiry narrator, T10 (C&O's self-doomed 4)
// and T12's rebuild -- because both turn-end fallbacks expired every mark of the outgoing corporation,
// including the marks its own Buy Trains step had just written (IG-A; probes P1, P4-self, P5). The other 13
// pass on both engines: they pin behaviour that was already right and was not pinned (IG-D, IG-E, GR-S15 A/B).

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";

export {};

const { applySandboxAction, applyPhaseChange, describeReprieveExpiries, describeFleetLosses } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase, depotInventory } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { resolveVariants } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { countableTrainCount } = require("../gameEngine/trainLimit") as typeof import("../gameEngine/trainLimit");
const { pendingTrainDiscards } = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { trainPurchaseRefusal } = require("../gameEngine/trainPurchaseGate") as typeof import("../gameEngine/trainPurchaseGate");
const { trainObligationFor, trainObligationRefusal } =
  require("../gameEngine/trainAvailability") as typeof import("../gameEngine/trainAvailability");
const { emergencyFundingFor } = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { evaluateRouteSet, routeSkipRefusal } =
  require("../gameEngine/routeAuthority") as typeof import("../gameEngine/routeAuthority");
const { hasLegalRouteFor, maxRouteRevenueFor } =
  require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { dividendRevenue } = require("../gameEngine/dividendSplit") as typeof import("../gameEngine/dividendSplit");
const { earnableRevenueVerdict } = require("../gameEngine/earnableRevenue") as typeof import("../gameEngine/earnableRevenue");
const { graceTurnReprieves, reprievesDoomedThisTurn } =
  require("../gameEngine/gentleRustGrace") as typeof import("../gameEngine/gentleRustGrace");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

/* ------------------------------------------------------------------ */
/* Boards                                                             */
/* ------------------------------------------------------------------ */

const PRR = 1;
const NYC = 2;
const BO = 4;
const CO = 5;
const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

function at(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return { q: hex.q, r: hex.r };
}

/** `routeAuthority.test.ts`'s straight of three yellow cities, I5 - I7 - I9 ($20 each): a 2-train's best from
 *  I5 is $40, a 3-train's $60. GULF adds the Gulf ($30) off I3, so two 2-trains from I5 earn $50 + $40. */
const gridOf = (lays: Array<[string, number, number]>, base: MapGridResponse = { game_id: 1, tiles: [] }): MapGridResponse => ({
  ...base,
  tiles: [...base.tiles, ...lays.map(([label, tile_id, orientation]) => ({ ...at(label), tile_id, orientation }) as MapTileEntry)],
});
const LINE = gridOf([
  ["I5", 57, 0],
  ["I7", 57, 0],
  ["I9", 57, 0],
]);
const GULF = gridOf([["I3", 8, 4]], LINE);

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  /** The corporation's home hex, where its one station token stands. */
  home: string;
  treasury?: string;
  price?: number;
}

const corp = (id: number, trains: string[], treasury = "3000"): Corp => {
  switch (id) {
    case PRR:
      return { id, ticker: "PRR", president: P1, trains, home: "H6", treasury, price: 100 };
    case NYC:
      return { id, ticker: "NYC", president: P2, trains, home: "I9", treasury, price: 90 };
    case BO:
      return { id, ticker: "B&O", president: P3, trains, home: "J6", treasury, price: 80 };
    default:
      return { id, ticker: "C&O", president: P1, trains, home: "I5", treasury, price: 70 };
  }
};

/** A legal pinned Operating Round: the listed corporations operate in the listed order, `operating` is on
 *  `step`, round `sub` of a set of `length`. Both train lists are always reported (#232). */
function board(input: {
  corps: Corp[];
  operating: number;
  step?: string;
  sub?: number;
  length?: number;
  gentle?: boolean;
  returned?: string[];
}): GameStateResponse {
  const order = input.corps.map((entry) => entry.id);
  return {
    game_id: 1,
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "12000",
    private_companies: [],
    variants: resolveVariants(input.gentle === false ? {} : { gentleRust: true }),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: input.sub ?? 1,
    operating_round_sequence_length: input.length ?? 2,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(input.operating),
    operating_sub_phase: input.step ?? "Hardware",
    rules_engine_version: RULES_ENGINE_VERSION,
    returned_trains: input.returned ?? [],
    market_positions: Object.fromEntries(
      input.corps.map((entry, index) => [entry.id, { price: entry.price ?? 100 - index, x: 5 + index, y: 4, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((entry) => ({
      company_id: entry.id,
      ticker: entry.ticker,
      is_floated: true,
      president: entry.president,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: entry.treasury ?? "3000",
      owned_trains: entry.trains,
      pending_rust_trains: [],
      player_holdings: [{ player: entry.president, percentage: 60 }],
      station_token_hexes: [[at(entry.home).q, at(entry.home).r]],
      station_tokens: [[at(entry.home).q, at(entry.home).r, 0]],
      station_token_limit: 3,
      home_hex_label: entry.home,
    })),
  } as unknown as GameStateResponse;
}

/* ------------------------------------------------------------------ */
/* Driving the reducer                                                */
/* ------------------------------------------------------------------ */

const company = (state: GameStateResponse, id: number): PublicCompanyState =>
  state.public_companies.find((entry) => entry.company_id === id)!;
const fleetOf = (state: GameStateResponse, id: number) => [...(company(state, id).owned_trains ?? [])];
const marksOf = (state: GameStateResponse, id: number) => [...(company(state, id).pending_rust_trains ?? [])];
const doomedThisTurnOf = (state: GameStateResponse, id: number) => company(state, id).pending_rust_doomed_this_turn;
const acting = (state: GameStateResponse): number | null =>
  state.current_round_type === "OperatingRound" ? state.active_operating_order[state.active_corporation_index] ?? null : null;
const actorOf = (state: GameStateResponse): string => {
  const id = acting(state);
  if (id !== null) return company(state, id).president!;
  return state.player_addresses[state.active_player_index];
};
const where = (state: GameStateResponse) =>
  `${state.current_round_type} ${state.macro_round_number}.${state.sub_round_index} corp ${acting(state)} @ ${state.operating_sub_phase}`;

type Msg = Parameters<typeof applySandboxAction>[1];
const dispatch = (state: GameStateResponse, msg: Msg, grid?: MapGridResponse) =>
  applySandboxAction(state, msg, { actor: actorOf(state), ...(grid ? { mapGrid: grid, era: "Yellow" } : {}) });

/** Applies a message the board must accept. A refusal is a harness failure with the board's position in it. */
function send(state: GameStateResponse, msg: Msg, grid?: MapGridResponse): GameStateResponse {
  const after = dispatch(state, msg, grid);
  if (stateDigest(after) === stateDigest(state)) {
    throw new Error(`refused at ${where(state)}: ${JSON.stringify(msg)}`);
  }
  return after;
}
const refused = (state: GameStateResponse, msg: Msg, grid?: MapGridResponse) =>
  stateDigest(dispatch(state, msg, grid)) === stateDigest(state);

const BUY = (state: GameStateResponse) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: acting(state) } }) as unknown as Msg;
const ADVANCE = (state: GameStateResponse) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: acting(state) } }) as unknown as Msg;
const PASS = { PassTurn: { game_id: 1 } } as unknown as Msg;
const DECLARE = (state: GameStateResponse, revenue: string) =>
  ({ DeclareDividends: { game_id: 1, protocol_id: acting(state), distribute: false, revenue_amount: revenue } }) as unknown as Msg;
const RUN = (state: GameStateResponse, routes: string[][], indices: number[]) =>
  ({
    RunMultipleRoutes: {
      game_id: 1,
      protocol_id: acting(state),
      routes: routes.map((hexes) => hexes.map((hex) => ({ hex }))),
      train_indices: indices,
      revenue_turn: "gr1",
    },
  }) as unknown as Msg;

/** Advances the acting corporation's cursor to `step` (Track -> Tokens -> Routes -> Dividends -> Hardware). */
function advanceTo(state: GameStateResponse, step: string, grid?: MapGridResponse): GameStateResponse {
  let now = state;
  for (let guard = 0; now.operating_sub_phase !== step; guard += 1) {
    if (guard > 6) throw new Error(`never reached ${step} from ${where(state)}`);
    now = send(now, ADVANCE(now), grid);
  }
  return now;
}

/** Plays the acting corporation's turn to its end without running or buying: every step, then End Turn. */
function playOutTurn(state: GameStateResponse): GameStateResponse {
  return send(advanceTo(state, "Hardware"), PASS);
}

/** Passes the whole Stock Round, seat by seat, into the next Operating Round. */
function passStockRound(state: GameStateResponse): GameStateResponse {
  let now = state;
  for (let guard = 0; now.current_round_type === "StockRound"; guard += 1) {
    if (guard > 12) throw new Error(`the Stock Round never ended: ${where(now)}`);
    now = send(now, PASS);
  }
  return now;
}

/** Plays other corporations' turns (untouched) until `id` is the corporation operating. */
function untilTurnOf(state: GameStateResponse, id: number): GameStateResponse {
  let now = state;
  for (let guard = 0; acting(now) !== id; guard += 1) {
    if (guard > 12) throw new Error(`never reached corporation ${id}: ${where(now)}`);
    now = now.current_round_type === "StockRound" ? passStockRound(now) : playOutTurn(now);
  }
  return now;
}

/** The phase-3 boards below all hold every 2-train (6) and every 3-train (5), so the depot's head is the
 *  first 4-train: the next depot purchase changes the phase and dooms every 2-train in play. */
const headIsFirstFour = (state: GameStateResponse) =>
  expect(depotInventory(state).find((row) => (row.remaining ?? 0) > 0)?.tier).toBe("4");

/* ------------------------------------------------------------------ */
/* T1 / T2 -- another corporation triggers                            */
/* ------------------------------------------------------------------ */

describe("T1. another corporation triggers the rust before the target has operated", () => {
  // NYC buys the first 4 in its Buy Trains step; PRR, B&O and C&O operate after it in the SAME round.
  const start = () =>
    board({
      corps: [corp(NYC, ["3", "3"]), corp(PRR, ["2", "2", "2", "3"]), corp(BO, ["2", "2", "2", "3"]), corp(CO, ["3"])],
      operating: NYC,
    });

  it("reprieves the target's trains to its later turn in the same round, usable there, gone at the end of Run Routes", () => {
    const before = start();
    headIsFirstFour(before);
    const rusted = send(before, BUY(before));
    expect(derivePhase(rusted)?.tier).toBe("4");
    // Doomed, marked, still owned -- and the rival that bought owes its own turn nothing (it holds no 2-train).
    expect(fleetOf(rusted, PRR)).toEqual(["2", "2", "2", "3"]);
    expect(marksOf(rusted, PRR)).toEqual(["2", "2", "2"]);
    expect(doomedThisTurnOf(rusted, PRR)).toBeUndefined();
    expect(doomedThisTurnOf(rusted, NYC)).toBeUndefined();

    // NYC's turn ends: the fallback is NYC's and takes nothing of PRR's.
    const prrTurn = send(rusted, PASS);
    expect(acting(prrTurn)).toBe(PRR);
    expect(prrTurn.operating_sub_phase).toBe("Track");
    expect(fleetOf(prrTurn, PRR)).toEqual(["2", "2", "2", "3"]);
    expect(marksOf(prrTurn, PRR)).toEqual(["2", "2", "2"]);
    // This turn is the qualifying grace turn for all three marks.
    expect(graceTurnReprieves(company(prrTurn, PRR))).toEqual(["2", "2", "2"]);

    // Still owned through Track, Tokens and Routes...
    const atRoutes = advanceTo(prrTurn, "Routes");
    expect(fleetOf(atRoutes, PRR)).toEqual(["2", "2", "2", "3"]);
    // ...and destroyed as the cursor enters Dividends -- the end of Run Routes (#1102), exactly once per mark.
    const atDividends = advanceTo(atRoutes, "Dividends");
    expect(fleetOf(atDividends, PRR)).toEqual(["3"]);
    expect(marksOf(atDividends, PRR)).toEqual([]);
    expect(describeReprieveExpiries(atRoutes, atDividends)).toEqual([
      { companyId: PRR, ticker: "PRR", rusted: ["2", "2", "2"], discarded: [] },
    ]);
    // B&O, still to operate, is untouched by PRR's expiry.
    expect(marksOf(atDividends, BO)).toEqual(["2", "2", "2"]);
    expect(fleetOf(atDividends, BO)).toEqual(["2", "2", "2", "3"]);
  });
});

describe("T2. another corporation triggers the rust after the target has operated", () => {
  // PRR has already operated; NYC buys the first 4. The round is the last of its set, so a Stock Round follows.
  const start = () =>
    board({
      corps: [corp(PRR, ["2", "2", "2", "3"]), corp(NYC, ["3", "3"]), corp(BO, ["2", "2", "2", "3"]), corp(CO, ["3"])],
      operating: NYC,
      sub: 2,
      length: 2,
    });

  it("keeps the trains through the rest of the round and the Stock Round, and spends them in the target's next turn", () => {
    const before = start();
    headIsFirstFour(before);
    let state = send(before, BUY(before));
    expect(marksOf(state, PRR)).toEqual(["2", "2", "2"]);

    // NYC ends; B&O and C&O operate (B&O's own reprieve is spent in its turn); the set ends.
    state = send(state, PASS);
    expect(acting(state)).toBe(BO);
    state = playOutTurn(state);
    expect(fleetOf(state, BO)).toEqual(["3"]);
    state = playOutTurn(state); // C&O, the last corporation of the last round
    expect(state.current_round_type).toBe("StockRound");
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "2", "3"]);
    expect(marksOf(state, PRR)).toEqual(["2", "2", "2"]);

    // Through the Stock Round, into the next set, to PRR's first turn there.
    state = untilTurnOf(passStockRound(state), PRR);
    expect(state.current_round_type).toBe("OperatingRound");
    expect(state.macro_round_number).toBe(4);
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "2", "3"]);
    const atRoutes = advanceTo(state, "Routes");
    expect(fleetOf(atRoutes, PRR)).toEqual(["2", "2", "2", "3"]);
    const atDividends = advanceTo(atRoutes, "Dividends");
    expect(fleetOf(atDividends, PRR)).toEqual(["3"]);
    expect(marksOf(atDividends, PRR)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* T3 / T4 / T5 -- the corporation triggers its own rust (IG-A)        */
/* ------------------------------------------------------------------ */

describe("T3. self-trigger mid-set: the buyer's own trains survive its turn and are owed its NEXT turn", () => {
  // PRR buys the first 4 in its own Buy Trains step, first of three, round 1 of 2.
  const start = () =>
    board({
      corps: [corp(PRR, ["2", "2", "3"]), corp(NYC, ["2", "2", "3", "3"]), corp(BO, ["2", "2", "3", "3"])],
      operating: PRR,
      sub: 1,
      length: 2,
    });

  it("marks the buyer's trains as doomed in its own turn", () => {
    const before = start();
    headIsFirstFour(before);
    const rusted = send(before, BUY(before));
    expect(derivePhase(rusted)?.tier).toBe("4");
    expect(fleetOf(rusted, PRR)).toEqual(["2", "2", "3", "4"]);
    expect(marksOf(rusted, PRR)).toEqual(["2", "2"]);
    expect(doomedThisTurnOf(rusted, PRR)).toEqual(["2", "2"]);
    // Not this turn's to spend.
    expect(graceTurnReprieves(company(rusted, PRR))).toEqual([]);
    // The rivals' marks are ordinary: their next turns begin after the doom.
    expect(doomedThisTurnOf(rusted, NYC)).toBeUndefined();
    expect(doomedThisTurnOf(rusted, BO)).toBeUndefined();
  });

  it("survives the end of the turn that doomed it (the pre-GR-1 engine destroyed it here)", () => {
    const before = start();
    const rusted = send(before, BUY(before));
    const ended = send(rusted, PASS);
    expect(acting(ended)).toBe(NYC);
    expect(fleetOf(ended, PRR)).toEqual(["2", "2", "3", "4"]);
    expect(marksOf(ended, PRR)).toEqual(["2", "2"]);
    // The turn that doomed them is over: the marks are now ordinary, owed PRR's next turn.
    expect(doomedThisTurnOf(ended, PRR)).toBeUndefined();
    expect(graceTurnReprieves(company(ended, PRR))).toEqual(["2", "2"]);
    // Nothing was narrated as rust at the turn end, because nothing was destroyed.
    expect(describeReprieveExpiries(rusted, ended)).toEqual([]);
  });

  it("stays owned, non-counting and marked through the rivals' turns, into the next round", () => {
    const before = start();
    let state = send(send(before, BUY(before)), PASS);
    state = playOutTurn(state); // NYC: its own 2s expire at its Dividends entry (case A for NYC)
    expect(fleetOf(state, NYC)).toEqual(["3", "3"]);
    state = playOutTurn(state); // B&O likewise; the round ends and round 2 of the set opens
    expect(fleetOf(state, BO)).toEqual(["3", "3"]);
    state = untilTurnOf(state, PRR);
    expect(state.sub_round_index).toBe(2);
    expect(state.operating_sub_phase).toBe("Track");
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "3", "4"]);
    expect(marksOf(state, PRR)).toEqual(["2", "2"]);
    const c = company(state, PRR);
    expect(countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains)).toBe(2);
  });

  it("expires in that future turn at the end of Run Routes, and only there", () => {
    const before = start();
    let state = untilTurnOf(send(send(before, BUY(before)), PASS), PRR);
    const atRoutes = advanceTo(state, "Routes");
    expect(fleetOf(atRoutes, PRR)).toEqual(["2", "2", "3", "4"]);
    state = advanceTo(atRoutes, "Dividends");
    expect(fleetOf(state, PRR)).toEqual(["3", "4"]);
    expect(marksOf(state, PRR)).toEqual([]);
    expect(describeReprieveExpiries(atRoutes, state)[0]?.rusted).toEqual(["2", "2"]);
    // Nothing further at Buy Trains or at the turn end.
    const ended = playOutTurn(state);
    expect(fleetOf(ended, PRR)).toEqual(["3", "4"]);
  });
});

describe("T4. self-trigger by the last corporation of the set: the trains survive the Stock Round", () => {
  const start = () =>
    board({
      corps: [corp(NYC, ["2", "2", "3", "3"]), corp(BO, ["2", "2", "3", "3"]), corp(PRR, ["2", "2", "3"])],
      operating: PRR,
      sub: 2,
      length: 2,
    });

  it("keeps them through the turn end, the Stock Round and into the buyer's next Operating Turn, then expires them", () => {
    const before = start();
    headIsFirstFour(before);
    let state = send(before, BUY(before));
    expect(doomedThisTurnOf(state, PRR)).toEqual(["2", "2"]);
    state = send(state, PASS);
    expect(state.current_round_type).toBe("StockRound");
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "3", "4"]);
    expect(marksOf(state, PRR)).toEqual(["2", "2"]);
    expect(doomedThisTurnOf(state, PRR)).toBeUndefined();
    // NYC and B&O had operated before the doom: case B, their marks cross the Stock Round too.
    expect(marksOf(state, NYC)).toEqual(["2", "2"]);
    expect(marksOf(state, BO)).toEqual(["2", "2"]);

    state = passStockRound(state);
    expect(state.current_round_type).toBe("OperatingRound");
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "3", "4"]);
    state = untilTurnOf(state, PRR);
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "3", "4"]);
    const atDividends = advanceTo(state, "Dividends");
    expect(fleetOf(atDividends, PRR)).toEqual(["3", "4"]);
    expect(marksOf(atDividends, PRR)).toEqual([]);
  });
});

describe("T5. a one-corporation Operating Round", () => {
  // PRR operates alone. The spare 2s and 3s are in the Bank Pool, so the first 4 is the depot's head; the pool
  // 2s are scrapped at the phase change with no reprieve (GR-S6).
  const alone = (sub: number) =>
    board({ corps: [corp(PRR, ["2", "2", "3"])], operating: PRR, sub, length: 2, returned: ["2", "2", "2", "2", "3", "3", "3", "3"] });

  it("ending the set does not spend the reprieve: it survives the Stock Round and dies in the next set's turn", () => {
    const before = alone(2);
    headIsFirstFour(before);
    let state = send(before, BUY(before));
    expect(state.returned_trains).toEqual(["3", "3", "3", "3"]);
    expect(marksOf(state, PRR)).toEqual(["2", "2"]);
    state = send(state, PASS);
    expect(state.current_round_type).toBe("StockRound");
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "3", "4"]);
    state = passStockRound(state);
    expect(acting(state)).toBe(PRR);
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "3", "4"]);
    state = advanceTo(state, "Dividends");
    expect(fleetOf(state, PRR)).toEqual(["3", "4"]);
    expect(marksOf(state, PRR)).toEqual([]);
  });

  it("ending a round inside the set does not spend it either: the next round's turn is the grace turn", () => {
    const before = alone(1);
    let state = send(send(before, BUY(before)), PASS);
    expect(state.current_round_type).toBe("OperatingRound");
    expect(state.sub_round_index).toBe(2);
    expect(acting(state)).toBe(PRR);
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "3", "4"]);
    expect(doomedThisTurnOf(state, PRR)).toBeUndefined();
    state = advanceTo(state, "Dividends");
    expect(fleetOf(state, PRR)).toEqual(["3", "4"]);
  });

  it("a pre-existing reprieve still takes the turn-end fallback when its grace turn ends before Run Routes (P5b)", () => {
    // A rival (NYC) dooms PRR's 2s in the last round of the set, before PRR has operated in it (GR-S15 A), so
    // PRR's turn is their qualifying turn. PRR ends it at Track (OBS-1: without a grid the reducer accepts
    // that), and the fallback spends them on the way into the Stock Round.
    const before = board({
      corps: [corp(NYC, ["3", "3"]), corp(PRR, ["2", "2", "3"])],
      operating: NYC,
      sub: 2,
      length: 2,
      returned: ["2", "2", "2", "2", "3", "3"],
    });
    headIsFirstFour(before);
    let state = send(before, BUY(before));
    expect(marksOf(state, PRR)).toEqual(["2", "2"]);
    expect(doomedThisTurnOf(state, PRR)).toBeUndefined();
    state = send(state, PASS);
    expect(acting(state)).toBe(PRR);
    expect(state.operating_sub_phase).toBe("Track");
    const ended = send(state, PASS);
    expect(ended.current_round_type).toBe("StockRound");
    expect(fleetOf(ended, PRR)).toEqual(["3"]);
    expect(marksOf(ended, PRR)).toEqual([]);
    expect(describeReprieveExpiries(state, ended)[0]?.rusted).toEqual(["2", "2"]);
  });
});

/* ------------------------------------------------------------------ */
/* T6 / T7 / T8 + the real reprieved route -- ownership vs capacity    */
/* ------------------------------------------------------------------ */

describe("T6 / T7 / route. a corporation whose only trains are reprieved", () => {
  // NYC buys the first 4; C&O (token on I5 of LINE) holds only 2-trains and operates next -- its grace turn.
  const start = (coTrains: string[], coTreasury = "100") =>
    board({
      corps: [corp(NYC, ["3"]), corp(CO, coTrains, coTreasury), corp(PRR, ["2", "2", "3", "3"]), corp(BO, ["2", "2", "3", "3"])],
      operating: NYC,
    });
  const toGraceTurn = (coTrains: string[], grid: MapGridResponse, coTreasury?: string) => {
    const before = start(coTrains, coTreasury);
    headIsFirstFour(before);
    const rusted = send(before, BUY(before), grid);
    return send(rusted, PASS, grid);
  };

  it("T6. at the start of its grace turn it OWNS trains -- none counts toward the limit, none is a discard, no purchase is owed", () => {
    const state = toGraceTurn(["2", "2"], LINE);
    expect(acting(state)).toBe(CO);
    const co = company(state, CO);
    expect(co.owned_trains).toEqual(["2", "2"]);
    expect(co.pending_rust_trains).toEqual(["2", "2"]);

    // Capacity: zero slots taken (#1034), nothing over any limit, a purchase is not blocked by the limit.
    expect(countableTrainCount(co.owned_trains, co.pending_rust_trains, co.carcosan_trains)).toBe(0);
    expect(pendingTrainDiscards(state)).toBeNull();
    // Even were its cursor standing on Buy Trains (probed, not played), the limit would not stand in the way...
    const onHardware = { ...state, operating_sub_phase: "Hardware" } as GameStateResponse;
    expect(trainPurchaseRefusal(onHardware, CO, { cost: 0, trainLimit: 3, requireFunds: false })).toBeNull();

    // Ownership: not trainless on any reader (SR-1 / SR-2 / SR-3).
    expect(trainObligationFor(state, CO, LINE)).toEqual({ owed: false, reason: null });
    // ...and neither the obligation nor emergency funding would engage.
    expect(trainObligationFor(onHardware, CO, LINE).owed).toBe(false);
    expect(trainObligationRefusal(onHardware, PASS, LINE)).toBeNull();
    expect(emergencyFundingFor(onHardware, LINE)).toBeNull();
    expect(dividendRevenue({ owned_trains: co.owned_trains, last_route_revenue: "40" }, undefined)).toBe(40);
    expect(
      earnableRevenueVerdict({ ownedTrains: co.owned_trains, stationTokenCount: 1, mapGrid: LINE, searchRevenue: () => 40 }).kind,
    ).not.toBe("cannot-earn");

    // Route authority: the reprieved trains are the corporation's roster, and it has a paying route.
    expect(hasLegalRouteFor(state, CO, LINE)).toBe(true);
    expect(maxRouteRevenueFor(state, CO, LINE)).toBe(40);
  });

  it("route. a genuinely reprieved train runs on its grace turn and earns exactly what the train earns", () => {
    let state = advanceTo(toGraceTurn(["2", "2"], GULF), "Routes", GULF);
    // Skipping the run is refused: the corporation owns trains and has a paying route (#1550, GR-S17).
    expect(routeSkipRefusal(state, ADVANCE(state), GULF)).not.toBeNull();
    expect(refused(state, ADVANCE(state), GULF)).toBe(true);

    const routes = [["I5", "I3", "J2"], ["I5", "I7"]];
    const verdict = evaluateRouteSet({
      state,
      mapGrid: GULF,
      era: "Yellow",
      companyId: CO,
      routes: routes.map((hexes) => hexes.map((hex) => ({ hex }))),
      trainIndices: [0, 1],
    });
    expect(verdict.kind).toBe("legal");
    expect(verdict.kind === "legal" ? verdict.runs.map((r) => [r.trainIndex, r.model, r.revenue]) : null).toEqual([
      [0, "2", 50],
      [1, "2", 40],
    ]);

    // The control: the same corporation with the same fleet, never reprieved, earns the same, train for train.
    const plain = {
      ...state,
      public_companies: state.public_companies.map((c) => (c.company_id === CO ? { ...c, pending_rust_trains: [] } : c)),
    } as GameStateResponse;
    const ranPlain = send(plain, RUN(plain, routes, [0, 1]), GULF);

    const ran = send(state, RUN(state, routes, [0, 1]), GULF);
    expect(company(ran, CO).last_route_revenue).toBe("90");
    expect(company(ran, CO).last_run_breakdown).toEqual(company(ranPlain, CO).last_run_breakdown);
    expect(company(ran, CO).last_route_revenue).toBe(company(ranPlain, CO).last_route_revenue);
    // The run ended Run Routes: the reprieved trains are destroyed on entering Dividends -- after they earned.
    expect(ran.operating_sub_phase).toBe("Dividends");
    expect(fleetOf(ran, CO)).toEqual([]);
    expect(marksOf(ran, CO)).toEqual([]);
    expect(fleetOf(ranPlain, CO)).toEqual(["2", "2"]);
    // And the declaration pays the run: the destruction cannot change it (#752 / #1102).
    state = send(ran, DECLARE(ran, "90"), GULF);
    expect(Number(company(state, CO).treasury)).toBe(100 + 90);
  });

  it("T7. expiry makes it trainless, and only then does the ordinary forced purchase engage at Buy Trains", () => {
    let state = advanceTo(toGraceTurn(["2", "2"], LINE), "Routes", LINE);
    state = send(state, RUN(state, [["I5", "I7"]], [0]), LINE);
    // Destroyed: both trains and both marks, exactly once each.
    expect(fleetOf(state, CO)).toEqual([]);
    expect(marksOf(state, CO)).toEqual([]);
    state = send(state, DECLARE(state, "40"), LINE);
    expect(state.operating_sub_phase).toBe("Hardware");

    // Now -- and not before -- the ordinary §6.6.2 obligation: no train, a legal route, a train for sale.
    const obligation = trainObligationFor(state, CO, LINE);
    expect(obligation.owed).toBe(true);
    expect(refused(state, PASS, LINE)).toBe(true);
    // The treasury ($100 + $40 withheld) cannot pay for the $300 4-train, so emergency funding is the path.
    const funding = emergencyFundingFor(state, LINE);
    expect(funding).not.toBeNull();
    expect(funding?.companyId).toBe(CO);
    expect(funding?.train.cost).toBe(300);
  });

  it("T8. ordinary + reprieved: the ordinary train remains after expiry, and no purchase is owed", () => {
    // C&O holds a 2 and a 3; only the 2 is doomed by the first 4. A rich treasury, so nothing else is in play.
    const before = board({
      corps: [corp(NYC, ["3"]), corp(CO, ["2", "3"], "100"), corp(PRR, ["2", "2", "3", "3"]), corp(BO, ["2", "2", "2", "3"])],
      operating: NYC,
    });
    headIsFirstFour(before);
    let state = send(send(before, BUY(before), LINE), PASS, LINE);
    expect(marksOf(state, CO)).toEqual(["2"]);
    const c = company(state, CO);
    expect(countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains)).toBe(1);
    state = advanceTo(state, "Routes", LINE);
    state = send(state, RUN(state, [["I5", "I7", "I9"]], [1]), LINE);
    expect(fleetOf(state, CO)).toEqual(["3"]);
    expect(marksOf(state, CO)).toEqual([]);
    state = send(state, DECLARE(state, "60"), LINE);
    expect(state.operating_sub_phase).toBe("Hardware");
    expect(trainObligationFor(state, CO, LINE)).toEqual({ owed: false, reason: null });
    expect(emergencyFundingFor(state, LINE)).toBeNull();
    // The turn may end: no purchase arises from the expiry.
    const ended = send(state, PASS, LINE);
    expect(acting(ended)).toBe(PRR);
    expect(fleetOf(ended, CO)).toEqual(["3"]);
  });
});

/* ------------------------------------------------------------------ */
/* T9 / T10 -- multiplicity and coexisting trigger groups             */
/* ------------------------------------------------------------------ */

describe("T9. identical trains: one mark per train, the right number removed, no phantom marks", () => {
  it("marks each doomed copy once, records the self-trigger once, and a re-applied tier adds nothing to either list", () => {
    const before = board({
      corps: [corp(PRR, ["2", "2", "2"]), corp(NYC, ["2", "2", "3", "3"]), corp(BO, ["2", "3", "3", "3"])],
      operating: PRR,
    });
    headIsFirstFour(before);
    const rusted = send(before, BUY(before));
    expect(fleetOf(rusted, PRR)).toEqual(["2", "2", "2", "4"]);
    expect(marksOf(rusted, PRR)).toEqual(["2", "2", "2"]);
    expect(doomedThisTurnOf(rusted, PRR)).toEqual(["2", "2", "2"]);
    // #1032: the same tier applied again marks nothing new -- in either list.
    const again = applyPhaseChange(rusted, "4");
    expect(marksOf(again, PRR)).toEqual(["2", "2", "2"]);
    expect(doomedThisTurnOf(again, PRR)).toEqual(["2", "2", "2"]);
    expect(marksOf(again, NYC)).toEqual(["2", "2"]);

    let state = untilTurnOf(send(rusted, PASS), PRR);
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "2", "4"]);
    expect(marksOf(state, PRR)).toEqual(["2", "2", "2"]);
    state = advanceTo(state, "Dividends");
    // Exactly three 2-trains removed, the 4 untouched, no mark left behind.
    expect(fleetOf(state, PRR)).toEqual(["4"]);
    expect(marksOf(state, PRR)).toEqual([]);
  });

  it("an expiry takes one train per mark, never an unmarked copy of the same model", () => {
    // The helper's multiset, on a corporation with one marked 3 beside a live 3 (a board only a sale can make
    // today -- GR-2's business -- so this is the helper's contract, not a reachable game).
    expect(graceTurnReprieves({ pending_rust_trains: ["3"], pending_rust_doomed_this_turn: undefined })).toEqual(["3"]);
    expect(graceTurnReprieves({ pending_rust_trains: ["2", "2"], pending_rust_doomed_this_turn: ["2"] })).toEqual(["2"]);
    expect(graceTurnReprieves({ pending_rust_trains: ["2", "3"], pending_rust_doomed_this_turn: ["3"] })).toEqual(["2"]);
    expect(reprievesDoomedThisTurn({ pending_rust_trains: ["2"] })).toEqual([]);
  });

  it("the expiry narrator names what an expiry took, even when it leaves this turn's own marks standing", () => {
    // Not reachable through today's messages (a purchase is refused before Buy Trains, which follows Run
    // Routes' end), so these are the narrator's contract, stated on hand-built companies: an expiry that spends
    // the owed 2 and leaves the self-doomed 3 standing is narrated as the 2 alone -- never as a limit discard.
    const was = { company_id: PRR, ticker: "PRR", owned_trains: ["2", "3", "4"], pending_rust_trains: ["2", "3"], pending_rust_doomed_this_turn: ["3"] } as unknown as PublicCompanyState;
    const now = { ...was, owned_trains: ["3", "4"], pending_rust_trains: ["3"], pending_rust_doomed_this_turn: undefined } as PublicCompanyState;
    const expired = describeReprieveExpiries({ public_companies: [was] } as unknown as GameStateResponse, { public_companies: [now] } as unknown as GameStateResponse);
    expect(expired).toEqual([{ companyId: PRR, ticker: "PRR", rusted: ["2"], discarded: [] }]);
    // A standing mark the turn DID owe means the dispatch was not an expiry at all: silent, as before #1699.
    const untagged = { ...was, pending_rust_doomed_this_turn: undefined } as PublicCompanyState;
    expect(describeReprieveExpiries({ public_companies: [untagged] } as unknown as GameStateResponse, { public_companies: [now] } as unknown as GameStateResponse)).toEqual([]);
  });
});

describe("T10. two rust groups pending before the corporation next operates", () => {
  // Phase 5, every 5-train bought (two in play, one in the Bank Pool), so the depot's head is the first 6. NYC
  // buys it (dooming every 3), B&O the second 6, C&O the first D (dooming every 4 -- its own among them, a
  // self-trigger). PRR, holding a 3 and a 4, operates last: two groups, both doomed before its turn began.
  it("keeps both groups to the one qualifying turn and destroys them together at its Run Routes", () => {
    const before = board({
      corps: [corp(NYC, ["5"]), corp(BO, ["5"]), corp(CO, ["4"]), corp(PRR, ["3", "4"])],
      operating: NYC,
      sub: 1,
      length: 3,
      returned: ["5", "4", "4"],
    });
    expect(derivePhase(before)?.tier).toBe("5");
    expect(depotInventory(before).find((row) => (row.remaining ?? 0) > 0)?.tier).toBe("6");

    // NYC: the first 6 -- phase 6, every 3 doomed.
    let state = send(before, BUY(before));
    expect(derivePhase(state)?.tier).toBe("6");
    expect(marksOf(state, PRR)).toEqual(["3"]);
    state = send(state, PASS);
    // B&O: the second 6, no phase change.
    state = send(advanceTo(state, "Hardware"), BUY(advanceTo(state, "Hardware")));
    expect(fleetOf(state, BO)).toEqual(["5", "6"]);
    state = send(state, PASS);
    // C&O: the first D -- phase D, every 4 doomed; the pool's 4s are scrapped outright (GR-S6).
    state = advanceTo(state, "Hardware");
    state = send(state, BUY(state));
    expect(derivePhase(state)?.tier).toBe("D");
    expect(state.returned_trains).toEqual(["5"]);
    expect(marksOf(state, PRR)).toEqual(["3", "4"]);
    expect(doomedThisTurnOf(state, PRR)).toBeUndefined();
    expect(doomedThisTurnOf(state, CO)).toEqual(["4"]);
    state = send(state, PASS);

    // PRR's turn: both groups owed to it, owned and routeable, neither counting toward the limit.
    expect(acting(state)).toBe(PRR);
    expect(fleetOf(state, PRR)).toEqual(["3", "4"]);
    expect(graceTurnReprieves(company(state, PRR))).toEqual(["3", "4"]);
    const c = company(state, PRR);
    expect(countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains)).toBe(0);
    const atRoutes = advanceTo(state, "Routes");
    expect(fleetOf(atRoutes, PRR)).toEqual(["3", "4"]);
    state = advanceTo(atRoutes, "Dividends");
    expect(fleetOf(state, PRR)).toEqual([]);
    expect(marksOf(state, PRR)).toEqual([]);
    expect(describeReprieveExpiries(atRoutes, state)[0]?.rusted).toEqual(["3", "4"]);
    // C&O's self-doomed 4 is still owned and marked: its grace turn is its next one, not the one that doomed it.
    expect(fleetOf(state, CO)).toEqual(["4", "D"]);
    expect(marksOf(state, CO)).toEqual(["4"]);
    expect(doomedThisTurnOf(state, CO)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* T11 -- the standard game                                           */
/* ------------------------------------------------------------------ */

describe("T11. Gentle Rust off: the standard rust is immediate and nothing is marked", () => {
  it("destroys every doomed train at the purchase, the buyer's included, and writes neither list", () => {
    const before = board({
      corps: [corp(PRR, ["2", "2", "3"]), corp(NYC, ["2", "2", "3", "3"]), corp(BO, ["2", "2", "3", "3"])],
      operating: PRR,
      gentle: false,
    });
    headIsFirstFour(before);
    const rusted = send(before, BUY(before));
    expect(fleetOf(rusted, PRR)).toEqual(["3", "4"]);
    expect(fleetOf(rusted, NYC)).toEqual(["3", "3"]);
    expect(fleetOf(rusted, BO)).toEqual(["3", "3"]);
    for (const id of [PRR, NYC, BO]) {
      expect(marksOf(rusted, id)).toEqual([]);
      expect(doomedThisTurnOf(rusted, id)).toBeUndefined();
    }
    expect(describeFleetLosses(before, rusted, BUY(before)).flatMap((loss) => loss.rusted)).toEqual(["2", "2", "2", "2", "2", "2"]);
    const ended = send(rusted, PASS);
    expect(fleetOf(ended, PRR)).toEqual(["3", "4"]);
  });
});

/* ------------------------------------------------------------------ */
/* T12 -- determinism / replay                                        */
/* ------------------------------------------------------------------ */

describe("T12. the timing is a function of the board and the messages alone", () => {
  const script = (start: GameStateResponse): string[] => {
    const digests: string[] = [];
    let state = send(start, BUY(start));
    digests.push(stateDigest(state));
    state = send(state, PASS);
    digests.push(stateDigest(state));
    for (let turn = 0; turn < 3; turn += 1) {
      state = acting(state) === PRR ? advanceTo(state, "Dividends") : playOutTurn(state);
      digests.push(stateDigest(state));
    }
    return digests;
  };
  const start = () =>
    board({
      corps: [corp(PRR, ["2", "2", "3"]), corp(NYC, ["2", "2", "3", "3"]), corp(BO, ["2", "2", "3", "3"])],
      operating: PRR,
    });

  it("replays the same pinned-v8 sequence to the same boards, entry by entry", () => {
    expect(script(start())).toEqual(script(start()));
  });

  it("carries the turn-scoped list on the board itself, so a rebuild from any intermediate board agrees", () => {
    // Resume from the board right after the self-trigger, as a replay that stopped there would: the list is on
    // that board (no UI, clock or narration input), so the continuation is identical.
    const s0 = start();
    const bought = send(s0, BUY(s0));
    const rebuilt = JSON.parse(JSON.stringify(bought)) as GameStateResponse;
    expect(stateDigest(send(rebuilt, PASS))).toBe(stateDigest(send(bought, PASS)));
    expect(fleetOf(send(rebuilt, PASS), PRR)).toEqual(["2", "2", "3", "4"]);
  });

  it("is written and cleared only by the reducer: no shell file names the list", () => {
    for (const file of ["App.tsx", "panels/ContextualActionBar.tsx", "components/TrainBadges.tsx", "utils/roomSession.ts"]) {
      expect([file, readStripped(file).includes("pending_rust_doomed_this_turn")]).toEqual([file, false]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Invariant E -- capacity is never the definition of owning a train   */
/* ------------------------------------------------------------------ */

describe("invariant E. the train-limit count is not reused as 'owns a train'", () => {
  it("no trainlessness / forced-purchase / route-roster reader asks a capacity helper", () => {
    const CAPACITY = /countableTrainCount|countableTrainsOf|excessTrainCount|isTrainLocked/;
    for (const file of [
      "gameEngine/trainAvailability.ts",
      "gameEngine/emergencyFunding.ts",
      "gameEngine/earnableRevenue.ts",
      "gameEngine/dividendSplit.ts",
      "gameEngine/routeAuthority.ts",
      "gameEngine/gentleRustGrace.ts",
      "utils/trainObligation.ts",
    ]) {
      expect([file, CAPACITY.test(readStripped(file))]).toEqual([file, false]);
    }
  });

  it("the shell's ownership reads are raw fleet lengths, not the capacity count", () => {
    const APP = readStripped("App.tsx");
    const owns = APP.slice(APP.indexOf("const ownsAnyTrain = useMemo"), APP.indexOf("const bestOwnedTrain = useMemo"));
    expect(owns).toContain("owned_trains?.length ?? 0) > 0");
    expect(owns).toContain("return owned.length === 0;");
    expect(owns).not.toMatch(/countableTrainCount|pending_rust_trains/);
  });
});
