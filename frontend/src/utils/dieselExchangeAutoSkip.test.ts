/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1701 (harness): DT-1 -- A LEGAL DIESEL EXCHANGE KEEPS BUY TRAINS OPEN AT THE TRAIN LIMIT
// ==================================================================
//
// FOUND DURING GR-2 (finding 2), AND NOT A GENTLE RUST BUG. `nextDerivedAction` ended a corporation's turn at Buy
// Trains the moment it was at its train limit ("it is already at its train limit"), and so did the shell's own
// `autoSkipReason`. The train limit answers "may another train be ADDED?"; the Diesel exchange (#1303) adds none --
// one 4-, 5- or 6-train out, one D in -- and `dieselExchangeRefusal` deliberately asks `trainPurchaseRefusal` with
// `trainLimit: null`. So a corporation at its limit could still have a legal Buy Trains action, and the automatic
// progression made it unreachable: in a room (the server derives the PassTurn) and in the browser (the shell does).
//
// THE RULE NOW: the train-limit lock ends Buy Trains only when no legal one-for-one Diesel exchange remains, asked of
// the canonical Diesel authority (`dieselExchangeRefusal(state, company) === null`) on every board the derived loop
// looks at -- availability, the GR-2 reprieve exclusion, the $800 / LPF $750 price against the treasury, actor and
// step all come from there, and nothing is restated here or in `derivedActions.ts`.
//
// HOW THE PRE-FIX FAILURE IS PINNED. The old verdict was exactly `isTrainLocked(countable fleet, current limit)`.
// Every "stays open" board below asserts that predicate is TRUE -- the old engine ended that turn -- beside the new
// answer. Each is paired with a control changed in one fact (funds, availability, the reprieve, the fleet) where the
// ordinary end-turn still derives, so a hold or a missing home token can never be what kept a step open.
//
// Boards are legal pinned v8 Operating Rounds built as GR-2's harness builds them (depot derived from the fleets, a
// station token on each corporation so no home is owed, a chart). Gentle Rust only where named.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";

export {};

const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase, depotInventory } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { resolveVariants } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { withRules } = require("../gameEngine/boardSelection") as typeof import("../gameEngine/boardSelection");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { countableTrainCount, isTrainLocked } = require("../gameEngine/trainLimit") as typeof import("../gameEngine/trainLimit");
const { trainPurchaseRefusal } = require("../gameEngine/trainPurchaseGate") as typeof import("../gameEngine/trainPurchaseGate");
const { trainSaleRefusal } = require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const { dieselAvailable, dieselExchangeRefusal, dieselExchangeCostFor, exchangeableTrains } =
  require("../gameEngine/dieselExchange") as typeof import("../gameEngine/dieselExchange");
const { nextDerivedAction, buyTrainsAutoSkipReason, TRAIN_LIMIT_SKIP_REASON } =
  require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { readFileSync } = require("fs") as typeof import("fs");
const { join } = require("path") as typeof import("path");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

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

const TICKER: Record<number, string> = { [PRR]: "PRR", [NYC]: "NYC", [BO]: "B&O", [CO]: "C&O" };
/** P1 presides over PRR and C&O -- the direct same-president sale (#1592) the intercorporate control uses. */
const PRESIDENT: Record<number, string> = { [PRR]: P1, [NYC]: P2, [BO]: P3, [CO]: P1 };
const HOME: Record<number, string> = { [PRR]: "H6", [NYC]: "I9", [BO]: "J6", [CO]: "I5" };
const PRICE: Record<number, number> = { [PRR]: 100, [NYC]: 90, [BO]: 80, [CO]: 70 };

function at(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return { q: hex.q, r: hex.r };
}

interface Corp {
  id: number;
  trains: string[];
  treasury?: string;
}

/** A legal pinned Operating Round at `operating`'s Buy Trains step. Under the Level Playing Field the home labels are
 *  dropped (its map rebinds the hex table) but the token stays, so no home station is owed and no hold stands. */
function board(input: {
  corps: Corp[];
  operating: number;
  gentle?: boolean;
  lpf?: boolean;
  returned?: string[];
}): GameStateResponse {
  const order = input.corps.map((entry) => entry.id);
  return {
    game_id: 1,
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "12000",
    private_companies: [],
    variants: resolveVariants({
      ...(input.gentle ? { gentleRust: true } : {}),
      ...(input.lpf ? { levelPlayingField: true } : {}),
    }),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(input.operating),
    operating_sub_phase: "Hardware",
    rules_engine_version: RULES_ENGINE_VERSION,
    returned_trains: input.returned ?? [],
    market_positions: Object.fromEntries(
      input.corps.map((entry, index) => [entry.id, { price: PRICE[entry.id], x: 5 + index, y: 4, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((entry) => ({
      company_id: entry.id,
      ticker: TICKER[entry.id],
      is_floated: true,
      president: PRESIDENT[entry.id],
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: entry.treasury ?? "3000",
      owned_trains: entry.trains,
      pending_rust_trains: [],
      player_holdings: [{ player: PRESIDENT[entry.id], percentage: 60 }],
      station_token_hexes: [[at(HOME[entry.id]).q, at(HOME[entry.id]).r]],
      station_tokens: [[at(HOME[entry.id]).q, at(HOME[entry.id]).r, 0]],
      station_token_limit: 3,
      home_hex_label: input.lpf ? null : HOME[entry.id],
    })),
  } as unknown as GameStateResponse;
}

/** Phase 6 with both 6-trains out (GR-2's `dieselStart`): the 6 / D shelf is open, so the Diesel is for sale, and the
 *  first D -- bought or exchanged for -- rusts every 4-train. PRR operates first, at Buy Trains; the limit is two. */
const dieselStart = (prr: string[], extra: { treasury?: string; gentle?: boolean; returned?: string[] } = {}) =>
  board({
    corps: [{ id: PRR, trains: prr, treasury: extra.treasury }, { id: NYC, trains: ["6", "6"] }, { id: BO, trains: ["4"] }],
    operating: PRR,
    gentle: extra.gentle,
    returned: extra.returned,
  });

/** The same table before its first 6-train: phase 5, the same two-train limit, and the 6 / D shelf not yet open --
 *  so no Diesel is for sale (#1439: "the first 6-train must be bought first"). */
const beforeDiesels = (prr: string[], treasury?: string) =>
  board({ corps: [{ id: PRR, trains: prr, treasury }, { id: NYC, trains: ["5"] }, { id: BO, trains: ["4"] }], operating: PRR });

/** The Level Playing Field with its 6 / 7 / D shelf open (NYC's 6 opened phase 6): the trade-in is $750. */
const lpfStart = (prr: string[], treasury?: string) =>
  board({ corps: [{ id: PRR, trains: prr, treasury }, { id: NYC, trains: ["6"] }], operating: PRR, lpf: true });

/* ------------------------------------------------------------------ */
/* Driving the board                                                  */
/* ------------------------------------------------------------------ */

const company = (state: GameStateResponse, id: number): PublicCompanyState =>
  state.public_companies.find((entry) => entry.company_id === id)!;
const fleetOf = (state: GameStateResponse, id: number) => [...(company(state, id).owned_trains ?? [])];
const treasuryOf = (state: GameStateResponse, id: number) => Number(company(state, id).treasury);
const acting = (state: GameStateResponse): number | null =>
  state.current_round_type === "OperatingRound" ? state.active_operating_order[state.active_corporation_index] ?? null : null;

type Msg = Parameters<typeof applySandboxAction>[1];
const dispatch = (state: GameStateResponse, msg: Msg) =>
  withRules(resolveVariants(state.variants), () => applySandboxAction(state, msg, { actor: company(state, acting(state)!).president! }));
function send(state: GameStateResponse, msg: Msg): GameStateResponse {
  const after = dispatch(state, msg);
  if (stateDigest(after) === stateDigest(state)) throw new Error(`refused: ${JSON.stringify(msg)}`);
  return after;
}
const refused = (state: GameStateResponse, msg: Msg) => stateDigest(dispatch(state, msg)) === stateDigest(state);

const BUY = (id: number, model?: string) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, ...(model ? { model_type: model } : {}) } }) as unknown as Msg;
const BUY_RETURNED = (id: number, model: string) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } }) as unknown as Msg;
const EXCHANGE = (id: number, model: string) =>
  ({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } }) as unknown as Msg;
const SALE = (buyer: number, seller: number, model: string, price = "1") =>
  ({ BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price } }) as unknown as Msg;

/** What the game owes on this board -- the server's own call, scoped to the table's rules as `settleOwed` scopes it. */
const owed = (state: GameStateResponse) =>
  withRules(resolveVariants(state.variants), () => nextDerivedAction({ state, mapGrid: S.GRID, emitted: new Set() }));

/** The PRE-FIX verdict, restated only to pin it: the old Hardware auto-skip was exactly this lock. */
const trainLocked = (state: GameStateResponse, id: number) => {
  const entry = company(state, id);
  return isTrainLocked(
    countableTrainCount(entry.owned_trains, entry.pending_rust_trains, entry.carcosan_trains),
    depotInventory(state).find((tier) => tier.isCurrent)?.trainLimit ?? null,
  );
};
const limitOf = (state: GameStateResponse) => depotInventory(state).find((tier) => tier.isCurrent)?.trainLimit ?? null;

/** Buy Trains stays open: the old lock is on, the canonical exchange authority says yes, and nothing is derived. */
function expectStaysOpen(state: GameStateResponse, id = PRR): void {
  expect(trainLocked(state, id)).toBe(true); // the pre-fix engine ended this turn here
  expect(dieselExchangeRefusal(state, id)).toBeNull();
  expect(buyTrainsAutoSkipReason(state, id)).toBeNull();
  expect(owed(state)).toBeNull();
}

/** The ordinary train-limit end of turn, exactly as before. */
function expectAutoEnds(state: GameStateResponse, id = PRR): void {
  expect(trainLocked(state, id)).toBe(true);
  expect(dieselExchangeRefusal(state, id)).not.toBeNull();
  expect(buyTrainsAutoSkipReason(state, id)).toBe(TRAIN_LIMIT_SKIP_REASON);
  const action = owed(state);
  expect(action?.kind).toBe("end-turn");
  expect(action?.msg).toHaveProperty("PassTurn");
  expect(action?.reason).toBe("it is already at its train limit");
}

/* ================================================================== */
/* The standard table and the Level Playing Field                     */
/* ================================================================== */

describe("DT-1: at the train limit, a legal Diesel exchange keeps Buy Trains open", () => {
  it("DT1: standard table, at the limit with an ordinary 4 and 5, $800 payable -- no auto-skip, and the exchange executes", () => {
    const state = dieselStart(["4", "5"]);
    expect([dieselAvailable(state), limitOf(state), dieselExchangeCostFor(state)]).toEqual([true, 2, 800]);
    expect(exchangeableTrains(company(state, PRR))).toEqual(["4", "5"]);
    expectStaysOpen(state);

    const traded = send(state, EXCHANGE(PRR, "4"));
    expect(fleetOf(traded, PRR)).toEqual(["5", "D"]);
    expect(treasuryOf(traded, PRR)).toBe(3000 - 800);
  });

  it("DT2: Level Playing Field, at the limit with an ordinary 4, $750 payable -- no auto-skip, and the $750 exchange executes", () => {
    const state = lpfStart(["6", "4"]);
    expect([dieselAvailable(state), limitOf(state), dieselExchangeCostFor(state)]).toEqual([true, 2, 750]);
    expectStaysOpen(state);
    const traded = send(state, EXCHANGE(PRR, "4"));
    expect([fleetOf(traded, PRR), treasuryOf(traded, PRR)]).toEqual([["6", "D"], 3000 - 750]);
  });

  it("DT3: an eligible train but no Diesel for sale yet -- the ordinary end of turn stands", () => {
    const state = beforeDiesels(["4", "5"]);
    expect([derivePhase(state)?.tier, dieselAvailable(state), limitOf(state)]).toEqual(["5", false, 2]);
    expect(dieselExchangeRefusal(state, PRR)).toBe("D-trains are not for sale yet — the first 6-train must be bought first.");
    expectAutoEnds(state);
  });

  it("DT4: an eligible train and a Diesel for sale, but not the exchange price -- the ordinary end of turn stands (no emergency funding)", () => {
    const standard = dieselStart(["4", "5"], { treasury: "799" });
    expect(dieselExchangeRefusal(standard, PRR)).toBe("PRR's treasury holds $799 — it cannot pay $800.");
    expectAutoEnds(standard);
    const lpf = lpfStart(["6", "4"], "749");
    expect(dieselExchangeRefusal(lpf, PRR)).toBe("PRR's treasury holds $749 — it cannot pay $750.");
    expectAutoEnds(lpf);
    // And the exchange itself is refused on both boards -- the treasury pays or nothing moves.
    expect(refused(standard, EXCHANGE(PRR, "4"))).toBe(true);
    expect(refused(lpf, EXCHANGE(PRR, "4"))).toBe(true);
  });

  it("DT5 / DT6: exactly the price keeps the step open -- $800 on the standard table, $750 under the Level Playing Field", () => {
    const standard = dieselStart(["4", "5"], { treasury: "800" });
    expectStaysOpen(standard);
    expect(treasuryOf(send(standard, EXCHANGE(PRR, "5")), PRR)).toBe(0);
    const lpf = lpfStart(["6", "4"], "750");
    expectStaysOpen(lpf);
    expect(treasuryOf(send(lpf, EXCHANGE(PRR, "4")), PRR)).toBe(0);
  });

  it("DT9: at the limit with nothing tradeable -- only Diesels, or the Level Playing Field's 7 beside a D -- the ordinary end of turn stands", () => {
    const diesels = board({ corps: [{ id: PRR, trains: ["D", "D"] }, { id: NYC, trains: ["6", "6"] }], operating: PRR });
    expect(dieselExchangeRefusal(diesels, PRR)).toBe("PRR holds no 4-, 5- or 6-train to trade in.");
    expectAutoEnds(diesels);
    const seven = lpfStart(["7", "D"]);
    expect(exchangeableTrains(company(seven, PRR))).toEqual([]);
    expectAutoEnds(seven);
  });

  it("below the limit this changes nothing: no skip is invented, with or without a Diesel for sale", () => {
    for (const state of [dieselStart(["4"]), beforeDiesels(["5"]), lpfStart(["6"])]) {
      expect(trainLocked(state, PRR)).toBe(false);
      expect(buyTrainsAutoSkipReason(state, PRR)).toBeNull();
      expect(owed(state)).toBeNull();
    }
  });
});

/* ================================================================== */
/* Re-asked on every board: a second exchange, and the last one       */
/* ================================================================== */

describe("DT-1: the derived loop re-asks the canonical authority after every exchange", () => {
  it("DT10 + DT11 + DT12: two ordinary trains -- the first-D exchange is legal, the step stays open for the second, then the turn ends", () => {
    const start = dieselStart(["4", "5"]);
    expectStaysOpen(start);
    expect(derivePhase(start)?.tier).toBe("6");

    // DT12: the ordinary 4 buys the FIRST Diesel -- judged on the board before the purchase, as #1303 / GR-2 judge it.
    const once = send(start, EXCHANGE(PRR, "4"));
    expect(derivePhase(once)?.tier).toBe("D");
    expect(fleetOf(once, BO)).toEqual([]); // the first D rusted B&O's 4 (no Gentle Rust here)
    // Still at the limit -- one out, one in -- and the 5 is still a legal trade-in: the turn is NOT ended.
    expect([fleetOf(once, PRR), limitOf(once)]).toEqual([["5", "D"], 2]);
    expect(acting(once)).toBe(PRR);
    expectStaysOpen(once);

    // The last candidate is traded: nothing legal remains, and the ordinary end of turn returns.
    const twice = send(once, EXCHANGE(PRR, "5"));
    expect([fleetOf(twice, PRR), treasuryOf(twice, PRR)]).toEqual([["D", "D"], 3000 - 1600]);
    expect(dieselExchangeRefusal(twice, PRR)).toBe("PRR holds no 4-, 5- or 6-train to trade in.");
    expectAutoEnds(twice);
  });

  it("DT11: exactly one candidate -- no skip before the exchange, the ordinary end of turn right after it", () => {
    const state = board({ corps: [{ id: PRR, trains: ["6", "D"] }, { id: NYC, trains: ["6"] }], operating: PRR });
    expect([derivePhase(state)?.tier, exchangeableTrains(company(state, PRR))]).toEqual(["D", ["6"]]);
    expectStaysOpen(state);
    const traded = send(state, EXCHANGE(PRR, "6"));
    expect(fleetOf(traded, PRR)).toEqual(["D", "D"]);
    expectAutoEnds(traded);
  });

  it("DT11 (funds): two candidates but money for one -- the first exchange spends the price of the second, and the turn then ends", () => {
    const state = dieselStart(["4", "5"], { treasury: "1500" });
    expectStaysOpen(state);
    const once = send(state, EXCHANGE(PRR, "4"));
    expect([fleetOf(once, PRR), treasuryOf(once, PRR)]).toEqual([["5", "D"], 700]);
    expect(exchangeableTrains(company(once, PRR))).toEqual(["5"]);
    expectAutoEnds(once);
  });
});

/* ================================================================== */
/* Gentle Rust composes through the GR-2 authority                    */
/* ================================================================== */

describe("DT-1 x Gentle Rust: a reprieved train never keeps Buy Trains open", () => {
  it("DT7 / DT16: the only 4-, 5- or 6-train is reprieved -- no legal exchange, and the ordinary end of turn stands", () => {
    // Real marks: PRR buys the first Diesel outright (its 4 is doomed in its own turn), then a second D, which fills
    // the limit on the countable fleet (the reprieved 4 occupies no slot) and leaves exactly $800 in the treasury.
    let state = dieselStart(["4"], { gentle: true });
    state = send(state, BUY(PRR, "D"));
    expect([fleetOf(state, PRR), company(state, PRR).pending_rust_trains]).toEqual([["4", "D"], ["4"]]);
    expect(trainLocked(state, PRR)).toBe(false);
    state = send(state, BUY(PRR, "D"));
    expect([fleetOf(state, PRR), treasuryOf(state, PRR)]).toEqual([["4", "D", "D"], 800]);
    // The model is a 4 and the money is there -- but the copy is on its final run, so it is no candidate.
    expect(exchangeableTrains(company(state, PRR))).toEqual([]);
    expect(dieselExchangeRefusal(state, PRR)).toBe(
      "PRR's only 4-, 5- or 6-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.",
    );
    expectAutoEnds(state);
  });

  it("DT8: a reprieved 4 beside an ordinary 5 -- the 5 is a legal exchange, so no auto-skip; once it is traded the turn ends", () => {
    let state = dieselStart(["4"], { gentle: true, returned: ["5"] });
    state = send(state, BUY(PRR, "D"));
    state = send(state, BUY_RETURNED(PRR, "5"));
    expect([fleetOf(state, PRR), company(state, PRR).pending_rust_trains]).toEqual([["4", "D", "5"], ["4"]]);
    expect(exchangeableTrains(company(state, PRR))).toEqual(["5"]);
    expectStaysOpen(state);
    expect(refused(state, EXCHANGE(PRR, "4"))).toBe(true); // GR-2 unchanged: the reprieved 4 is never a trade-in
    const traded = send(state, EXCHANGE(PRR, "5"));
    expect(fleetOf(traded, PRR)).toEqual(["4", "D", "D"]);
    expectAutoEnds(traded);
  });

  it("DT12 under Gentle Rust: the ordinary 4 still buys the first Diesel at the limit, and the step stays open for the 5", () => {
    const state = dieselStart(["4", "5"], { gentle: true });
    expectStaysOpen(state);
    const traded = send(state, EXCHANGE(PRR, "4"));
    // The traded 4 carried no mark and PRR keeps none; B&O's 4 is reprieved for its own later turn.
    expect([fleetOf(traded, PRR), company(traded, PRR).pending_rust_trains, company(traded, BO).pending_rust_trains]).toEqual([
      ["5", "D"],
      [],
      ["4"],
    ]);
    expectStaysOpen(traded);
  });
});

/* ================================================================== */
/* The train limit itself is not relaxed                              */
/* ================================================================== */

describe("DT13: the limit still refuses every purchase that ADDS a train", () => {
  it("a depot Diesel, a Bank Pool 5 and an intercorporate 6 are refused at the limit, on a board where the exchange is legal", () => {
    const state = board({
      corps: [
        { id: PRR, trains: ["4", "5"] },
        { id: NYC, trains: ["6"] },
        { id: CO, trains: ["6"] },
      ],
      operating: PRR,
      returned: ["5"],
    });
    expectStaysOpen(state);
    const LIMIT = "Train limit reached — PRR already holds 2 of a maximum 2.";
    const depotD = depotInventory(state).find((row) => row.tier === "D")!;
    expect(trainPurchaseRefusal(state, PRR, { cost: depotD.cost, trainLimit: limitOf(state), requireFunds: true })).toBe(LIMIT);
    expect(refused(state, BUY(PRR, "D"))).toBe(true);
    expect(refused(state, BUY(PRR))).toBe(true);
    expect(refused(state, BUY_RETURNED(PRR, "5"))).toBe(true);
    expect(trainSaleRefusal(state, { buyerId: PRR, sellerId: CO, model: "6", price: "1" }, P1, undefined, "settlement")).toBe(
      "PRR is already at its train limit and may not buy another train.",
    );
    expect(refused(state, SALE(PRR, CO, "6"))).toBe(true);
    // ...and the one-for-one exchange is still the one legal train movement.
    expect(fleetOf(send(state, EXCHANGE(PRR, "4")), PRR)).toEqual(["5", "D"]);
  });
});

/* ================================================================== */
/* Server / RoomSession                                               */
/* ================================================================== */

describe("DT14 / DT15: through a room, the server derives no PassTurn while an exchange is legal, and derives it once none is", () => {
  it("standard table: the Bank Pool 5 fills the limit (no PassTurn), the 4 buys the first D (no PassTurn), the 5 trades in (PassTurn)", () => {
    const { room, submit, kinds } = S.roomFor(dieselStart(["4"], { returned: ["5"] }));
    expect(kinds(submit(P1, BUY_RETURNED(PRR, "5")))).toEqual(["BuyHardwareFromPool"]);
    expect([fleetOf(room.state, PRR), acting(room.state), room.state.operating_sub_phase]).toEqual([["4", "5"], PRR, "Hardware"]);
    expect(trainLocked(room.state, PRR)).toBe(true);

    expect(kinds(submit(P1, EXCHANGE(PRR, "4")))).toEqual(["ExchangeTrainForDiesel"]);
    expect([fleetOf(room.state, PRR), acting(room.state), room.state.operating_sub_phase]).toEqual([["5", "D"], PRR, "Hardware"]);

    expect(kinds(submit(P1, EXCHANGE(PRR, "5")))).toEqual(["ExchangeTrainForDiesel", "PassTurn*"]);
    expect(fleetOf(room.state, PRR)).toEqual(["D", "D"]);
    expect(acting(room.state)).not.toBe(PRR);
  });

  it("control: the same room when the 5 leaves less than $800 -- the limit ends the turn at once, exactly as before", () => {
    const seed = dieselStart(["4"], { returned: ["5"] });
    const five = depotInventory(seed).find((row) => row.tier === "5")!.cost;
    const { room, submit, kinds } = S.roomFor(S.withCorp(seed, PRR, { treasury: String(five + 799) }));
    expect(kinds(submit(P1, BUY_RETURNED(PRR, "5")))).toEqual(["BuyHardwareFromPool", "PassTurn*"]);
    expect(acting(room.state)).not.toBe(PRR);
  });

  it("Gentle Rust: the room keeps PRR at Buy Trains for its ordinary 5 beside a reprieved 4, refuses the 4, and ends the turn after the 5", () => {
    const { room, submit, kinds } = S.roomFor(dieselStart(["4"], { gentle: true, returned: ["5"] }));
    expect(kinds(submit(P1, BUY(PRR, "D")))).toEqual(["BuyHardwareFromPool"]);
    expect(kinds(submit(P1, BUY_RETURNED(PRR, "5")))).toEqual(["BuyHardwareFromPool"]);
    expect([fleetOf(room.state, PRR), acting(room.state)]).toEqual([["4", "D", "5"], PRR]);
    const logged = room.entries.length;
    const reprieved = submit(P1, EXCHANGE(PRR, "4")) as { kind: string; reason?: string };
    expect([reprieved.kind, reprieved.reason]).toEqual([
      "refused",
      "PRR's 4-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.",
    ]);
    expect(room.entries.length).toBe(logged);
    expect(kinds(submit(P1, EXCHANGE(PRR, "5")))).toEqual(["ExchangeTrainForDiesel", "PassTurn*"]);
    expect(acting(room.state)).not.toBe(PRR);
  });
});

/* ================================================================== */
/* One authority for the server and the browser                       */
/* ================================================================== */

describe("DT-1 parity: the shell and the server ask the same Buy Trains verdict", () => {
  it("on every board above, the exported verdict is the derived action's reason", () => {
    const boards = [
      dieselStart(["4", "5"]),
      dieselStart(["4", "5"], { treasury: "799" }),
      dieselStart(["4", "5"], { treasury: "800" }),
      lpfStart(["6", "4"]),
      lpfStart(["6", "4"], "749"),
      lpfStart(["7", "D"]),
      beforeDiesels(["4", "5"]),
      dieselStart(["4"]),
    ];
    for (const state of boards) {
      expect(withRules(resolveVariants(state.variants), () => buyTrainsAutoSkipReason(state, PRR))).toBe(owed(state)?.reason ?? null);
    }
  });

  it("the shell's `autoSkipReason` takes its Hardware answer from `buyTrainsAutoSkipReason`: no sentence and no Diesel rule of its own", () => {
    /* The shell's effect dispatches on Firestore and in solo play, and on the server path its answer still drives the
       Action Bar freeze (#1145) -- so a browser-only verdict would either end the turn itself or freeze the bar on a
       step the server has left open. `atTrainLimitNow` stays as the arm's guard: it is the same shared lock the
       engine's verdict starts from, so the conjunction is exactly the engine's answer. */
    const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
    const memo = app.slice(app.indexOf("const autoSkipReason = useMemo"), app.indexOf("const forcedWithholdRef"));
    expect(memo).toContain('if (orSubPhase === "Hardware" && atTrainLimitNow) {');
    expect(memo).toContain("return gameState ? buyTrainsAutoSkipReason(gameState, actingProtocolId) : null;");
    expect(memo).not.toContain("already at its train limit");
    expect(memo).not.toMatch(/dieselExchange|exchangeableTrains|dieselAvailable/);
    // And the derived action asks the same function -- one verdict, two callers.
    const derived = readFileSync(join(__dirname, "..", "gameEngine", "derivedActions.ts"), "utf8");
    const branch = derived.slice(derived.indexOf('if (step === "Hardware")'), derived.indexOf("/** The best revenue"));
    expect(branch).toContain("buyTrainsAutoSkipReason(state, protocolId)");
  });
});
