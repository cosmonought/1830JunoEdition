/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1530 (harness): THE PRESIDENT CHOOSES, THE ORDER IS 6.0's, AND THE GAME WAITS
// ==================================================================
//
// Batch 4 (#1513) put the trimmed train in the Bank Pool and left the CHOICE to the reducer: cheapest-first.
// Rulebook 6.6.1 gives it to the president. This file proves the replacement: a phase change that leaves a
// corporation over the new limit creates an obligation and takes nothing; the president discards any train
// they hold; nobody else can; corporations decide in share-value order; nothing else happens until every
// one is compliant; the discarded train is the Bank Pool's and is bought from there by the Batch-4 model.
//
// FIXTURES ARE CHARTLESS, so a refusal comes back by identity (#778) -- except where a market chart is the
// subject (the 6.0 tie-break), where `stateDigest` is compared instead (#1196: chart states are rebuilt).

export {};

const { applySandboxAction, describeFleetLosses } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { pendingTrainDiscards, discardTrainRefusal, pendingDiscardBlock } =
  require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { bankPoolTrains, purchasableTrains, cheapestPurchasableTrain } =
  require("../gameEngine/trainAvailability") as typeof import("../gameEngine/trainAvailability");
const { nextDerivedAction } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { validateGameplayMessage, GAMEPLAY_MESSAGE_KINDS } =
  require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { GAMEPLAY_MESSAGE_KEYS } = require("./sessionKey") as typeof import("./sessionKey");
const { depotInventory, derivePhase } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog, RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } =
  require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxWaterfallState, sandboxScenarioState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { DEVELOPMENT_CORPUS_POLICY, RULES_ENGINE_VERSION, RULES_ENGINE_CHANGELOG, RULES_ENGINE_VERSION_FIELD, SUPPORTED_RULES_ENGINE_VERSIONS } =
  require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const H16 = hex("H16");
const I17 = hex("I17");
const CORRIDOR: MapGridResponse = {
  game_id: 1,
  tiles: [
    { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
    { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
  ],
} as unknown as MapGridResponse;

const PRR = 1;
const NYC = 2;
const BO = 4;
const CO = 5;
const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  par?: string;
  treasury?: string;
  pendingRust?: string[];
}

function board(input: {
  corps: Corp[];
  operating: number;
  step?: string;
  returned?: string[];
  positions?: Record<number, { price: number; x: number; y: number; enteredAt?: number }>;
}): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(input.operating),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: input.step ?? "Hardware",
    ...(input.returned ? { returned_trains: input.returned } : {}),
    ...(input.positions ? { market_positions: input.positions } : {}),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: corp.president,
      par_value: corp.par ?? "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: corp.treasury ?? "1000",
      owned_trains: corp.trains,
      ...(corp.pendingRust ? { pending_rust_trains: corp.pendingRust } : {}),
      player_holdings: [{ player: corp.president, percentage: 100 }],
      station_token_hexes: [[H16.q, H16.r]],
      station_tokens: [[H16.q, H16.r, 0]],
      station_token_limit: 3,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
const depotRow = (state: GameStateResponse, tier: string) => depotInventory(state).find((row) => row.tier === tier)!;
const bank = (state: GameStateResponse) => Number(state.virtual_bank_vgp);

const BUY = (id: number) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id } }) as never;
const BUY_POOL = (id: number, model: string) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } }) as never;
const DISCARD = (id: number, model: string) => ({ DiscardTrain: { game_id: 1, protocol_id: id, model_type: model } }) as never;
const PASS = { PassTurn: { game_id: 1 } } as never;
const ADVANCE = (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } }) as never;
const apply = (state: GameStateResponse, msg: never, actor: string) => applySandboxAction(state, msg, { actor, mapGrid: CORRIDOR });

/** The Batch-4 C&O board: every printed 4-train is out, so the depot's head is the first 5 (phase 4 -> 5,
 *  limit 3 -> 2). NYC (P2) is operating and buys it; C&O (P1) holds three trains and will be one over. */
function coBoard() {
  return board({
    corps: [
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "1000" },
      { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"] },
      { id: PRR, ticker: "PRR", president: P3, trains: ["3", "4"] },
      { id: BO, ticker: "B&O", president: P3, trains: ["4", "4"] },
    ],
    operating: NYC,
  });
}

/* ------------------------------------------------------------------ */
/* (1) The obligation replaces the trim                                 */
/* ------------------------------------------------------------------ */

describe("a phase change that leaves a corporation over the limit owes a discard, and takes nothing (#1530)", () => {
  const before = coBoard();
  const after = apply(before, BUY(NYC), P2);

  it("1. the fleet is untouched, the pool is untouched, and the obligation names C&O", () => {
    expect(company(after, NYC).owned_trains).toEqual(["5"]);
    expect(derivePhase(after)?.trainLimit).toBe(2);
    expect(company(after, CO).owned_trains).toEqual(["3", "3", "4"]); // Batch 4 trimmed this to ["3", "4"]
    expect(after.returned_trains).toBeUndefined();
    const pending = pendingTrainDiscards(after);
    expect(pending).not.toBeNull();
    expect(pending?.limit).toBe(2);
    expect(pending?.queue.map((due) => due.companyId)).toEqual([CO]);
    expect(pending?.required).toEqual({ companyId: CO, ticker: "C&O", president: P1, limit: 2, choices: ["3", "3", "4"], excess: 1 });
    // The phase change narrates no discard: nothing was taken from anybody.
    expect(describeFleetLosses(before, after, BUY(NYC))).toEqual([]);
    // Negative control: before the purchase nothing was owed.
    expect(pendingTrainDiscards(before)).toBeNull();
  });

  it("2. the president chooses any train they hold -- here the 4, which the trim would never have taken", () => {
    const chosen = apply(after, DISCARD(CO, "4"), P1);
    expect(chosen).not.toBe(after);
    expect(company(chosen, CO).owned_trains).toEqual(["3", "3"]);
    expect(chosen.returned_trains).toEqual(["4"]);
    expect(pendingTrainDiscards(chosen)).toBeNull();
    // Nobody is paid: treasury and bank exactly as they were.
    expect(company(chosen, CO).treasury).toBe(company(after, CO).treasury);
    expect(bank(chosen)).toBe(bank(after));
    // And the other legal choice works the same way, one copy of the model at a time.
    const other = apply(after, DISCARD(CO, "3"), P1);
    expect(company(other, CO).owned_trains).toEqual(["3", "4"]);
    expect(other.returned_trains).toEqual(["3"]);
    // The president's own discard is not narrated as a loss the phase took.
    expect(describeFleetLosses(after, chosen, DISCARD(CO, "4"))).toEqual([]);
  });

  it("3. a non-president cannot make the discard", () => {
    for (const actor of [P2, P3]) {
      expect(apply(after, DISCARD(CO, "4"), actor)).toBe(after);
      expect(discardTrainRefusal(after, { protocol_id: CO, model_type: "4" }, actor)).toContain("Only C&O's president");
      expect(turnRefusal({ state: after, waterfall: null, actor, msg: DISCARD(CO, "4") })).toContain("Only C&O's president");
    }
    // The president is allowed through the authority even though NYC's president is the one operating.
    expect(turnRefusal({ state: after, waterfall: null, actor: P1, msg: DISCARD(CO, "4") })).toBeNull();
    // ...and the seat cursor is not widened for it: with the obligation gone, the ordinary rule stands.
    expect(turnRefusal({ state: after, waterfall: null, actor: P1, msg: PASS })).toContain("must discard before anything else happens");
    const resolved = apply(after, DISCARD(CO, "4"), P1);
    expect(turnRefusal({ state: resolved, waterfall: null, actor: P1, msg: PASS })).toBe("It is not your turn.");
    expect(turnRefusal({ state: resolved, waterfall: null, actor: P2, msg: PASS })).toBeNull();
  });

  it("5. a train the required corporation does not hold cannot be discarded", () => {
    for (const model of ["5", "2", "D"]) {
      expect(apply(after, DISCARD(CO, model), P1)).toBe(after);
      expect(discardTrainRefusal(after, { protocol_id: CO, model_type: model }, P1)).toContain(`holds no ${model}-train`);
    }
    // Naming another corporation's train under C&O's id is the same refusal: C&O holds no 5.
    expect(apply(after, DISCARD(CO, "5"), P1)).toBe(after);
    expect(company(after, NYC).owned_trains).toEqual(["5"]);
  });

  it("6. DiscardTrain is refused when no obligation exists", () => {
    // Before the purchase nothing is owed; after the discard nothing is owed. Both refuse by identity.
    expect(apply(before, DISCARD(CO, "3"), P1)).toBe(before);
    expect(apply(before, DISCARD(PRR, "3"), P3)).toBe(before);
    expect(discardTrainRefusal(before, { protocol_id: CO, model_type: "3" }, P1)).toContain("no train to discard");
    expect(turnRefusal({ state: before, waterfall: null, actor: P1, msg: DISCARD(CO, "3") })).toContain("no train to discard");
    const resolved = apply(after, DISCARD(CO, "4"), P1);
    expect(apply(resolved, DISCARD(CO, "3"), P1)).toBe(resolved);
  });
});

/* ------------------------------------------------------------------ */
/* (7) Two discards, (8) two corporations                              */
/* ------------------------------------------------------------------ */

describe("more than one discard (#1530)", () => {
  it("7. a corporation two over the limit stays the required one after its first discard", () => {
    /* Unreachable through the printed schedule (4 -> 3 -> 2 drops one at a time and no fleet may exceed the
       limit in between), so built directly: phase 5 in force, C&O holding four countable trains. 6.6.1 says
       "a train"; a corporation still over after one discard is still "a railroad with an excess train". */
    const state = board({
      corps: [
        { id: NYC, ticker: "NYC", president: P2, trains: ["5"] },
        { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4", "4"] },
      ],
      operating: NYC,
    });
    const pending = pendingTrainDiscards(state);
    expect(pending?.required.companyId).toBe(CO);
    expect(pending?.required.excess).toBe(2);
    const once = apply(state, DISCARD(CO, "3"), P1);
    expect(company(once, CO).owned_trains).toEqual(["3", "4", "4"]);
    expect(pendingTrainDiscards(once)?.required).toMatchObject({ companyId: CO, excess: 1, choices: ["3", "4", "4"] });
    expect(apply(once, PASS, P2)).toBe(once); // still blocked
    const twice = apply(once, DISCARD(CO, "4"), P1);
    expect(company(twice, CO).owned_trains).toEqual(["3", "4"]);
    expect(twice.returned_trains).toEqual(["3", "4"]);
    expect(pendingTrainDiscards(twice)).toBeNull();
  });

  /** Two corporations over: C&O at $100 and B&O at $67 (par, the chartless fallback for share value). */
  function twoOver() {
    return board({
      corps: [
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "1000" },
        { id: BO, ticker: "B&O", president: P3, trains: ["3", "4", "4"], par: "67" },
        { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"], par: "100" },
        { id: PRR, ticker: "PRR", president: P3, trains: ["3", "4"] },
      ],
      operating: NYC,
    });
  }

  it("8. resolves in share-value order: the higher-valued corporation decides first, the other cannot jump the queue", () => {
    const before = twoOver();
    expect(depotRow(before, "4").remaining).toBe(0);
    const after = apply(before, BUY(NYC), P2);
    const pending = pendingTrainDiscards(after)!;
    expect(pending.queue.map((due) => due.ticker)).toEqual(["C&O", "B&O"]);
    expect(pending.required.companyId).toBe(CO);

    // B&O's president tries to go first: refused, and told why.
    expect(apply(after, DISCARD(BO, "3"), P3)).toBe(after);
    expect(discardTrainRefusal(after, { protocol_id: BO, model_type: "3" }, P3)).toContain("C&O decides first");
    expect(turnRefusal({ state: after, waterfall: null, actor: P3, msg: DISCARD(BO, "3") })).toContain("C&O must discard first");
    // C&O's president cannot discard B&O's train under B&O's id either.
    expect(apply(after, DISCARD(BO, "3"), P1)).toBe(after);

    // C&O discards; B&O becomes the required corporation.
    const first = apply(after, DISCARD(CO, "3"), P1);
    expect(pendingTrainDiscards(first)?.queue.map((due) => due.ticker)).toEqual(["B&O"]);
    expect(pendingTrainDiscards(first)?.required).toMatchObject({ companyId: BO, president: P3, excess: 1 });
    // Now C&O's president is the one who may not act, and NYC still cannot move.
    expect(apply(first, DISCARD(CO, "3"), P1)).toBe(first);
    expect(apply(first, PASS, P2)).toBe(first);
    // B&O discards; everything is compliant and the game resumes where it stopped (NYC's Buy Trains step).
    const second = apply(first, DISCARD(BO, "4"), P3);
    expect(pendingTrainDiscards(second)).toBeNull();
    expect(second.returned_trains).toEqual(["3", "4"]);
    expect(second.operating_sub_phase).toBe("Hardware");
    expect(second.active_operating_order[second.active_corporation_index]).toBe(NYC);
    const ended = apply(second, PASS, P2);
    expect(ended).not.toBe(second);
  });

  it("8. the discard queue is 6.0's order, all four keys, read from the state's positions (#1531)", () => {
    /* Four over-limit corporations, every tie-break exercised at once: NYC at $112 first (higher share value);
       then the three at $100 -- ERIE in column 8 before B&O and C&O in column 7 (rightmost first); B&O above
       C&O in column 7 (furthest up first). Then the same-cell case separately below. The buyer is PRR. */
    const over = (id: number, ticker: string, president: string) => ({ id, ticker, president, trains: ["3", "4", "4"] });
    const before = board({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: [], treasury: "1000" },
        over(NYC, "NYC", P2),
        over(BO, "B&O", P3),
        over(CO, "C&O", P1),
        over(6, "ERIE", P2),
      ],
      operating: PRR,
      positions: {
        [PRR]: { price: 90, x: 5, y: 10, enteredAt: 1 },
        [NYC]: { price: 112, x: 7, y: 10, enteredAt: 2 },
        [BO]: { price: 100, x: 7, y: 9, enteredAt: 5 }, // same column as C&O, higher, arrived later
        [CO]: { price: 100, x: 7, y: 8, enteredAt: 3 },
        [6]: { price: 100, x: 8, y: 8, enteredAt: 4 }, // rightmost of the $100s
      },
    });
    // Twelve 4s on the board is more than are printed; the fixture only needs the depot's head on the 5.
    const after = apply(before, BUY(PRR), P1);
    expect(derivePhase(after)?.trainLimit).toBe(2);
    expect(pendingTrainDiscards(after)?.queue.map((due) => due.ticker)).toEqual(["NYC", "ERIE", "B&O", "C&O"]);
  });

  it("8. two over-limit corporations in one cell: the earlier arrival is on top and decides first (4.5/6.0)", () => {
    const before = board({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: [], treasury: "1000" },
        { id: BO, ticker: "B&O", president: P3, trains: ["3", "4", "4"] },
        { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["4"] }, // the fourth printed 4, so the depot's head is the 5
      ],
      operating: PRR,
      positions: {
        [PRR]: { price: 90, x: 5, y: 10, enteredAt: 1 },
        [NYC]: { price: 80, x: 4, y: 10, enteredAt: 3 },
        [BO]: { price: 100, x: 7, y: 9, enteredAt: 6 }, // arrived later: placed at the bottom of the stack
        [CO]: { price: 100, x: 7, y: 9, enteredAt: 2 }, // arrived first: on top
      },
    });
    const after = apply(before, BUY(PRR), P1);
    expect(pendingTrainDiscards(after)?.queue.map((due) => due.ticker)).toEqual(["C&O", "B&O"]);
    const jumped = apply(after, DISCARD(BO, "3"), P3);
    expect(stateDigest(jumped)).toBe(stateDigest(after));
  });

  it("8. ties in share value fall to the 6.0 operating-order tie-break (rightmost column first)", () => {
    /* Same price, different columns: rulebook 6.0 -- "the railroad whose token is furthest to the right takes a
       turn first". `buildOperatingOrder` is that rule (#647); the discard queue is read from it. */
    const before = board({
      corps: [
        { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "1000" },
        { id: BO, ticker: "B&O", president: P3, trains: ["3", "4", "4"] },
        { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"] },
        { id: PRR, ticker: "PRR", president: P3, trains: ["3", "4"] },
      ],
      operating: NYC,
      positions: {
        [BO]: { price: 100, x: 7, y: 3, enteredAt: 1 },
        [CO]: { price: 100, x: 5, y: 3, enteredAt: 2 },
        [NYC]: { price: 90, x: 4, y: 3, enteredAt: 3 },
        [PRR]: { price: 80, x: 3, y: 3, enteredAt: 4 },
      },
    });
    const after = apply(before, BUY(NYC), P2);
    expect(pendingTrainDiscards(after)?.queue.map((due) => due.ticker)).toEqual(["B&O", "C&O"]);
    // A chart state is rebuilt on every apply (#1196), so the refusal is proven by digest here.
    const jumped = apply(after, DISCARD(CO, "3"), P1);
    expect(stateDigest(jumped)).toBe(stateDigest(after));
    const ok = apply(after, DISCARD(BO, "3"), P3);
    expect(stateDigest(ok)).not.toBe(stateDigest(after));
    expect(pendingTrainDiscards(ok)?.required.companyId).toBe(CO);
    // And no share price moved between the phase change and the last discard: the order could not have changed.
    expect(ok.market_positions).toEqual(after.market_positions);
  });
});

/* ------------------------------------------------------------------ */
/* (9) The gate                                                        */
/* ------------------------------------------------------------------ */

describe("nothing else happens while a discard is owed (#1530)", () => {
  const before = coBoard();
  const after = apply(before, BUY(NYC), P2);

  it("9. every ordinary message is refused by identity, by one gate, and the game owes no derived action", () => {
    const blocked: Array<[string, never, string]> = [
      ["PassTurn by the operating president", PASS, P2],
      ["AdvanceOperatingSubPhase", ADVANCE(NYC), P2],
      ["another depot purchase by the buyer", BUY(NYC), P2],
      ["a purchase by another corporation", BUY(PRR), P3],
      ["a tile lay", { LayTile: { game_id: 1, protocol_id: NYC, q: H16.q, r: H16.r, tile_id: 57, orientation: 0 } } as never, P2],
      ["a dividend", { DeclareDividends: { game_id: 1, protocol_id: NYC, revenue_amount: "0", mode: "Payout" } } as never, P2],
      ["a stock purchase", { BuyStock: { game_id: 1, protocol_id: PRR, source: "Ipo" } } as never, P1],
      ["a stock sale", { SellStock: { game_id: 1, protocol_id: CO, percentage: 10 } } as never, P1],
      ["an emergency purchase", { EmergencyBuyHardware: { game_id: 1, protocol_id: NYC } } as never, P2],
      ["a trade offer", { BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: NYC, seller_protocol_id: CO, model_type: "3", price: "1" } } as never, P2],
      ["a Stock Round opening", { OpenStockRound: {} } as never, P1],
      ["a discard by the wrong corporation", DISCARD(PRR, "3"), P3],
    ];
    for (const [label, msg, actor] of blocked) {
      expect([label, apply(after, msg, actor) === after]).toEqual([label, true]);
      expect([label, pendingDiscardBlock(after, msg)]).toEqual([label, "DiscardTrain" in (msg as object) ? null : expect.stringContaining("must discard before anything else happens")]);
    }
    expect(nextDerivedAction({ state: after, mapGrid: CORRIDOR, emitted: new Set() })).toBeNull();
    // Negative control: the same board with the obligation discharged is not blocked, and derives normally.
    const resolved = apply(after, DISCARD(CO, "3"), P1);
    expect(pendingDiscardBlock(resolved, PASS)).toBeNull();
    expect(apply(resolved, PASS, P2)).not.toBe(resolved);
    // The gate, not the arms: the one message it lets through is the discard, and CloseRoom is the room's.
    expect(pendingDiscardBlock(after, { CloseRoom: {} } as never)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* (10) RevertTo, (13) same-version rebuild                            */
/* ------------------------------------------------------------------ */

describe("the log: RevertTo and a same-version rebuild (#1530)", () => {
  const seedState = coBoard();
  const seed = () => ({
    state: seedState,
    waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
  });
  const entry = (index: number, actor: string, msg: unknown, derived = false) => ({
    index,
    id: `e${index}`,
    actor,
    payload: JSON.stringify(msg),
    ...(derived ? { derived: true } : {}),
  });
  const REVERT = (index: number, player: string) => ({ RevertTo: { index, player, summary: "undo" } });

  it("10. RevertTo past the discard restores the obligation; RevertTo past the purchase removes it; neither appends", () => {
    const providers = sandboxReplayProviders();
    const played = replayLog([entry(0, P2, BUY(NYC)), entry(1, P1, DISCARD(CO, "4"))], providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(pendingTrainDiscards(played.state)).toBeNull();
    expect(company(played.state, CO).owned_trains).toEqual(["3", "3"]);

    const undoneDiscard = replayLog(
      [entry(0, P2, BUY(NYC)), entry(1, P1, DISCARD(CO, "4")), entry(2, P1, REVERT(1, P1))],
      providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY,
    );
    expect(undoneDiscard.applied).toBe(1);
    expect(company(undoneDiscard.state, CO).owned_trains).toEqual(["3", "3", "4"]);
    expect(pendingTrainDiscards(undoneDiscard.state)?.required.companyId).toBe(CO);
    expect(undoneDiscard.state.returned_trains).toBeUndefined();

    const undonePurchase = replayLog(
      [entry(0, P2, BUY(NYC)), entry(1, P1, REVERT(0, P1))],
      providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY,
    );
    expect(undonePurchase.applied).toBe(0);
    expect(pendingTrainDiscards(undonePurchase.state)).toBeNull();
    // The engine seeds a chart onto the board, so "back to the seed" is "the same as a replay of nothing".
    const nothing = replayLog([], providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(stateDigest(undonePurchase.state)).toBe(stateDigest(nothing.state));
    expect(company(undonePurchase.state, NYC).owned_trains).toEqual([]);
  });

  it("13. a same-version log holding DiscardTrain rebuilds identically, through the engine and through a room", () => {
    const entries = [entry(0, P2, BUY(NYC)), entry(1, P1, DISCARD(CO, "4")), entry(2, P2, PASS)];
    const providers = sandboxReplayProviders();
    const once = replayLog(entries, providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    const twice = replayLog(entries, providers, seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(once.applied).toBe(3);
    expect(stateDigest(once.state)).toBe(stateDigest(twice.state));
    expect(once.state.returned_trains).toEqual(["4"]);

    // The same history through RoomSession: played, then restored from its own log (a restart).
    const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => `m${Math.random()}` });
    const submit = (actor: string, msg: never) => room.submit({ actor, build: "b", msg, baseIndex: room.nextIndex - 1 });
    expect(submit(P2, BUY(NYC)).kind).toBe("applied");
    expect(pendingTrainDiscards(room.state)?.required.companyId).toBe(CO);
    // The wrong president through the room's authority: refused, nothing appended.
    const wrong = submit(P3, DISCARD(CO, "4"));
    expect(wrong.kind).toBe("refused");
    expect((wrong as { reason: string }).reason).toContain("Only C&O's president");
    // NYC's president cannot end the turn around it: refused at the authority, with the reason, nothing appended.
    const held = submit(P2, PASS);
    expect(held.kind).toBe("refused");
    expect((held as { reason: string }).reason).toContain("C&O's president must discard before anything else happens");
    const lengthBefore = room.entries.length;
    expect(submit(P1, DISCARD(CO, "4")).kind).toBe("applied");
    expect(room.entries.length).toBe(lengthBefore + 1);
    expect(JSON.parse(room.entries[room.entries.length - 1].payload)).toEqual(DISCARD(CO, "4"));
    expect(pendingTrainDiscards(room.state)).toBeNull();
    const restored = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "x" });
    restored.restore(room.entries as ServerLogEntry[]);
    expect(restored.incompatible).toBeNull();
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
  });
});

describe("RevertTo keeps its owner and its reach while a discard is owed (#1530, Part 5)", () => {
  it("the buyer's own RevertTo of the phase-changing purchase is applied through the room, and clears the obligation", () => {
    const seed = () => ({
      state: coBoard(),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    });
    const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => `m${Math.random()}` });
    const submit = (actor: string, msg: never) => room.submit({ actor, build: "b", msg, baseIndex: room.nextIndex - 1 });
    expect(submit(P2, BUY(NYC)).kind).toBe("applied");
    expect(pendingTrainDiscards(room.state)?.required.companyId).toBe(CO);
    // Somebody else's RevertTo is still refused for the reason it always was (not theirs), not for the hold.
    const notTheirs = submit(P3, { RevertTo: { index: 0, player: P3, summary: "undo" } } as never);
    expect(notTheirs.kind).toBe("refused");
    expect((notTheirs as { reason: string }).reason).not.toContain("must discard");
    // The buyer reverts their own last action: the purchase, the phase change and the obligation are gone.
    const undone = submit(P2, { RevertTo: { index: 0, player: P2, summary: "undo" } } as never);
    expect(undone.kind).toBe("applied");
    expect(pendingTrainDiscards(room.state)).toBeNull();
    expect(company(room.state, NYC).owned_trains).toEqual([]);
    expect(derivePhase(room.state)?.trainLimit).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* The legacy corpus: the choice the old engine made, supplied visibly   */
/* ------------------------------------------------------------------ */

describe("a legacy log's silent discard is supplied by the corpus policy, and by nothing else (#1530)", () => {
  /* A log played before version 2 has the phase change and NO discard entry -- the old engine trimmed the
     cheapest train itself and wrote nothing. `replayLog` supplies that choice only for a `legacy` log (an
     unpinned DEAL) and only under `legacyExcessTrains: "engine-chose-cheapest"`. The fixture log below has
     no deal at all (`undealt`), so it proves the adapter's silence; the legacy case is proven on the real
     thing, JUNO-3XD, whose index 255 is exactly this situation. */
  const seedState = coBoard();
  const seed = () => ({
    state: seedState,
    waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
  });
  const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
  const silent = [entry(0, P2, BUY(NYC)), entry(1, P2, PASS)]; // the old engine's log: purchase, then the turn ends

  it("an unpinned-and-undealt fixture is not a legacy log: nothing is supplied and the obligation blocks the rest", () => {
    const result = replayLog(silent, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(result.legacyDiscards).toEqual([]);
    expect(pendingTrainDiscards(result.state)?.required.companyId).toBe(CO);
    // The PassTurn at index 1 was refused by the gate: NYC is still operating, C&O still holds three.
    expect(result.state.active_operating_order[result.state.active_corporation_index]).toBe(NYC);
    expect(company(result.state, CO).owned_trains).toEqual(["3", "3", "4"]);
  });

  it("the corpus policy supplies the cheapest-first discard for a legacy log, through today's arm, appending nothing", () => {
    /* Proven on JUNO-3XD: replayed under `DEVELOPMENT_CORPUS_POLICY` its index-255 discard is supplied (the
       3 the Batch-4 engine trimmed) and the log continues; under the same policy with
       `legacyExcessTrains: "refuse"` the obligation stands at 255 and every later entry is refused. */
    const { entriesFromExport } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "..", "sandbox-log-JUNO-3XD.json"), "utf8")) as { actions: unknown[] };
    const entries = entriesFromExport(raw.actions as never);
    const seedFor = () => ({
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    });
    /* Batch 6 (#1556, S6-3): the log-derived JUNO-3XD now parts from the played game at 175 (NNH's run is
       short of the demonstrated combination, see `replayJuno3XD.test.ts`), and in the game the log derives
       from there no corporation is ever over its train limit -- the 4 that put C&O over at 255 is bought on a
       turn that no longer comes. So this log no longer exercises the adapter: under both policies nothing is
       supplied and nothing is owed, and the two rebuild to one board. The adapter itself is proven by the
       synthetic case above ("supplies the cheapest-first discard"); what this case keeps is the corpus fact
       and the server policy's refusal. Re-pinned with the reason, not silently. */
    const supplied = replayLog(entries, sandboxReplayProviders(), seedFor(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(supplied.legacyDiscards).toEqual([]);
    expect(pendingTrainDiscards(supplied.state)).toBeNull();

    /* Slice 8.2 (#1614): the corpus policy gained a second adapter (`legacyHomeTokens`), so this comparison spreads the
       policy and changes the ONE key it is about. Written as a literal it silently dropped the home-choice adapter
       too, and 3XD then froze at B&O's first operating turn on one side only. */
    const refused = replayLog(entries, sandboxReplayProviders(), seedFor(), undefined, { ...DEVELOPMENT_CORPUS_POLICY, legacyExcessTrains: "refuse" });
    expect(refused.legacyDiscards).toEqual([]);
    expect(pendingTrainDiscards(refused.state)).toBeNull();
    expect(stateDigest(refused.state)).toBe(stateDigest(supplied.state));

    // And the server's policy refuses the legacy log before its first entry, whatever the adapter says.
    expect(() => replayLog(entries, sandboxReplayProviders(), seedFor())).toThrow(/before rules-engine versioning/);
  });
});

/* ------------------------------------------------------------------ */
/* (11)(12) The Bank Pool                                              */
/* ------------------------------------------------------------------ */

describe("the discarded train is the Bank Pool's (#1530, #1512)", () => {
  const after = apply(coBoard(), BUY(NYC), P2);
  const discarded = apply(after, DISCARD(CO, "4"), P1);

  it("11. appears in the pool at face value, is what the availability model offers, and is bought from there", () => {
    expect(bankPoolTrains(discarded)).toEqual([{ source: "pool", tier: "4", cost: 300, remaining: 1 }]);
    expect(purchasableTrains(discarded)).toContainEqual({ source: "pool", tier: "4", cost: 300, remaining: 1 });
    // Cheapest for sale: the pooled 4 at $300 beats the depot's remaining 5s at $450.
    expect(cheapestPurchasableTrain(discarded)).toEqual({ source: "pool", tier: "4", cost: 300, remaining: 1 });
    // NYC (one train, room for one more) buys it at face value; the bank is paid, the pool is emptied.
    const bought = apply(discarded, BUY_POOL(NYC, "4"), P2);
    expect(company(bought, NYC).owned_trains).toEqual(["5", "4"]);
    expect(bought.returned_trains).toEqual([]);
    expect(Number(company(bought, NYC).treasury)).toBe(Number(company(discarded, NYC).treasury) - 300);
    expect(bank(bought)).toBe(bank(discarded) + 300);
    expect(Number(company(bought, CO).treasury)).toBe(Number(company(discarded, CO).treasury)); // the discarder is not paid
  });

  it("12. is not also printed stock: the depot's 4-row stays empty, and a discarded phase-changer keeps the phase", () => {
    // All four printed 4s are accounted for: PRR one, B&O two, and the pooled one. None is "remaining".
    expect(depotRow(discarded, "4").remaining).toBe(0);
    expect(depotRow(discarded, "5").remaining).toBe(2); // three printed, NYC holds one
    // The buyer itself over the limit may discard the 5 it just bought; the phase does not fall back to 4.
    const buyerOver = board({
      corps: [
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "3"], treasury: "1000" },
        { id: CO, ticker: "C&O", president: P1, trains: ["4"] },
        { id: PRR, ticker: "PRR", president: P3, trains: ["4"] },
        { id: BO, ticker: "B&O", president: P3, trains: ["4", "4"] },
      ],
      operating: NYC,
    });
    const bought5 = apply(buyerOver, BUY(NYC), P2);
    expect(pendingTrainDiscards(bought5)?.required).toMatchObject({ companyId: NYC, president: P2, excess: 1 });
    const gaveUpThe5 = apply(bought5, DISCARD(NYC, "5"), P2);
    expect(company(gaveUpThe5, NYC).owned_trains).toEqual(["3", "3"]);
    expect(gaveUpThe5.returned_trains).toEqual(["5"]);
    expect(derivePhase(gaveUpThe5)?.tier).toBe("5");
    expect(derivePhase(gaveUpThe5)?.trainLimit).toBe(2);
    expect(depotRow(gaveUpThe5, "5").remaining).toBe(2); // three printed, one loose in the pool, none owned
    expect(bankPoolTrains(gaveUpThe5)).toEqual([{ source: "pool", tier: "5", cost: 450, remaining: 1 }]);
    expect(pendingTrainDiscards(gaveUpThe5)).toBeNull();
  });

  it("a same-model pool/depot tie still goes to the pool (Batch 4's documented tie-break)", () => {
    // Put a printed 5 and a pooled 5 side by side: the forced purchase takes the pool copy.
    const state = board({
      corps: [{ id: NYC, ticker: "NYC", president: P2, trains: ["5"], treasury: "1000" }],
      operating: NYC,
      returned: ["5"],
    });
    expect(cheapestPurchasableTrain(state)).toEqual({ source: "pool", tier: "5", cost: 450, remaining: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* (4) Schema and authorisation, (14) the version                      */
/* ------------------------------------------------------------------ */

describe("DiscardTrain at the ingress (#1530, Batch 2 machinery)", () => {
  it("is a schema'd gameplay message with an integer corporation and a string model", () => {
    expect(GAMEPLAY_MESSAGE_KINDS).toContain("DiscardTrain");
    expect(GAMEPLAY_MESSAGE_KEYS).toContain("DiscardTrain");
    expect(validateGameplayMessage(DISCARD(CO, "4")).ok).toBe(true);
    expect(validateGameplayMessage({ DiscardTrain: { protocol_id: CO } }).ok).toBe(false);
    expect(validateGameplayMessage({ DiscardTrain: { protocol_id: "5", model_type: "4" } }).ok).toBe(false);
    expect(validateGameplayMessage({ DiscardTrain: { protocol_id: CO, model_type: 4 } }).ok).toBe(false);
  });

  it("14. RULES_ENGINE_VERSION is 2, the changelog says why, and a version-1 room is refused before replay", () => {
    // Batch 4.6 pinned 2; Batch 5 (#1540) bumped to 3. The DiscardTrain semantics are version >= 2's.
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(2);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version)).toContain(2);
    expect(RULES_ENGINE_CHANGELOG.find((row) => row.version === 2)?.note).toContain("DiscardTrain");

    // A room dealt today is pinned to 2; the same log re-pinned to 1 is held, and its history is never applied.
    const fresh = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: {
        state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
        waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
      },
      build: "b",
      mintId: () => "d",
    });
    const dealt = fresh.submit({
      actor: P1,
      build: "b",
      msg: { SetupGame: { players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }], variants: {}, build: "b" } } as never,
      baseIndex: -1,
    });
    expect(dealt.kind).toBe("applied");
    expect(fresh.rulesEngineVersion()).toBe(RULES_ENGINE_VERSION);
    const versionOne = fresh.entries.map((row) => {
      const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
      if (!parsed.SetupGame) return { ...row };
      return { ...row, payload: JSON.stringify({ ...parsed, SetupGame: { ...parsed.SetupGame, [RULES_ENGINE_VERSION_FIELD]: 1 } }) };
    });
    const applySpy = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const old = new RoomSession({ providers: sandboxReplayProviders(), seed: seedOf(), build: "b", mintId: () => "x" });
      old.restore(versionOne as ServerLogEntry[]);
      expect(applySpy).not.toHaveBeenCalled();
      expect(old.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 1, supported: [RULES_ENGINE_VERSION] });
      expect(old.catchUp(-1).kind).toBe("incompatible");
      expect(old.submit({ actor: P1, build: "b", msg: DISCARD(CO, "4"), baseIndex: old.nextIndex - 1 }).kind).toBe("incompatible");
    } finally {
      applySpy.mockRestore();
    }
  });

  function seedOf() {
    return {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    };
  }
});
