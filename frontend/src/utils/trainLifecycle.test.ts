/** @jest-environment node */
//
// Batch 4 (design notes #1512/#1513): the train path, asked of the authority.
//
// WHAT IS PINNED HERE. One answer to "what is for sale" (`purchasableTrains` / `cheapestPurchasableTrain`,
// depot and Bank Pool together, with the depot no longer counting pooled trains as printed stock); the forced
// purchase taking that answer; the obligation gate that keeps a trainless corporation with a route from
// ending its Buy Trains step; the buyer's limit on a corporation-to-corporation trade; and the discard's
// destination. The C&O case from JUNO-FCJ (413 / 468) is reconstructed at the end.
//
// THE BOARD IS THE CORRIDOR `stationLegality.test.ts` USES: a token at H16 (tile 57), bare track on I17 (tile
// 7), and printed Baltimore -- two revenue centres joined by track, which is a legal route for any train.

import { applySandboxAction, applyPhaseChange, describeFleetLosses } from "../gameEngine/sandboxSession";
import {
  bankPoolTrains,
  cheapestPurchasableTrain,
  purchasableTrains,
  trainObligationFor,
  trainObligationRefusal,
} from "../gameEngine/trainAvailability";
import { hasLegalRouteFor } from "../gameEngine/derivedActions";
import { depotInventory, derivePhase } from "../gameEngine/gamePhase";
import { countableTrainCount, isTrainLocked } from "../gameEngine/trainLimit";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

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
const BARE: MapGridResponse = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

const CO = 5;
const NYC = 2;
const PRR = 1;
const P1 = "p1";
const P2 = "p2";

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  treasury?: string;
  tokens?: Array<[number, number]>;
  pendingRust?: string[];
}

function board(input: {
  corps: Corp[];
  operating: number;
  step?: string;
  cash?: Record<string, string>;
  returned?: string[];
  variants?: Record<string, unknown>;
}): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
  return {
    player_addresses: [P1, P2],
    player_cash: [
      { player: P1, cash_vgp: input.cash?.[P1] ?? "500" },
      { player: P2, cash_vgp: input.cash?.[P2] ?? "500" },
    ],
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
    ...(input.variants ? { variants: input.variants } : {}),
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: corp.treasury ?? "1000",
      owned_trains: corp.trains,
      ...(corp.pendingRust ? { pending_rust_trains: corp.pendingRust } : {}),
      player_holdings: [{ player: corp.president, percentage: 100 }],
      station_token_hexes: corp.tokens ?? [[H16.q, H16.r]],
      station_tokens: (corp.tokens ?? [[H16.q, H16.r]]).map(([q, r]) => [q, r, 0]),
      station_token_limit: 3,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
const cash = (state: GameStateResponse, player: string) => Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
const depotRow = (state: GameStateResponse, tier: string) => depotInventory(state).find((row) => row.tier === tier)!;

const PASS = { PassTurn: { game_id: 1 } } as never;
const ADVANCE = (id: number) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: id } }) as never;
const BUY = (id: number) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id } }) as never;
const BUY_POOL = (id: number, model: string) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } }) as never;
const EMERGENCY = (id: number) => ({ EmergencyBuyHardware: { game_id: 1, protocol_id: id } }) as never;
const TRADE = (buyer: number, seller: number, model: string, price: string) =>
  ({ BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price } }) as never;

/* ------------------------------------------------------------------ */
/* The fixture                                                          */
/* ------------------------------------------------------------------ */

describe("the corridor is a legal route and the depot opens on the 2-train", () => {
  it("reaches two revenue centres from H16 for a hypothetical two-stop train", () => {
    const state = board({ corps: [{ id: CO, ticker: "C&O", president: P1, trains: [] }], operating: CO });
    expect(hasLegalRouteFor(state, CO, CORRIDOR)).toBe(true);
    expect(hasLegalRouteFor(state, CO, BARE)).toBe(false);
    expect(derivePhase(state)?.tier).toBe("2");
    expect(cheapestPurchasableTrain(state)).toEqual({ source: "depot", tier: "2", cost: 80, remaining: 6 });
  });
});

/* ------------------------------------------------------------------ */
/* Mandatory purchase (#1513)                                           */
/* ------------------------------------------------------------------ */

describe("a trainless corporation with a legal route cannot end its Buy Trains step (design note #1513)", () => {
  const obliged = () => board({ corps: [{ id: CO, ticker: "C&O", president: P1, trains: [] }], operating: CO });

  it("(1) the obligation is owed, and names the cheapest train", () => {
    const state = obliged();
    const obligation = trainObligationFor(state, CO, CORRIDOR);
    expect(obligation.owed).toBe(true);
    expect(obligation.reason).toMatch(/must acquire one before its turn ends/);
    expect(obligation.reason).toMatch(/2-train at \$80/);
  });

  it("(1) PassTurn is refused by identity while it stands", () => {
    const before = obliged();
    expect(trainObligationRefusal(before, PASS, CORRIDOR)).toMatch(/must acquire one/);
    expect(applySandboxAction(before, PASS, { actor: P1, mapGrid: CORRIDOR })).toBe(before);
  });

  it("(2) a hand-crafted AdvanceOperatingSubPhase cannot leave the step either", () => {
    const before = obliged();
    expect(applySandboxAction(before, ADVANCE(CO), { actor: P1, mapGrid: CORRIDOR })).toBe(before);
    // Nor a PassTurn attributed to nobody in particular: the gate reads the board, not the sender.
    expect(applySandboxAction(before, PASS, { mapGrid: CORRIDOR })).toBe(before);
  });

  it("is discharged by a purchase, after which the turn ends normally", () => {
    const before = obliged();
    const bought = applySandboxAction(before, BUY(CO), { actor: P1, mapGrid: CORRIDOR });
    expect(company(bought, CO).owned_trains).toEqual(["2"]);
    expect(trainObligationFor(bought, CO, CORRIDOR).owed).toBe(false);
    const ended = applySandboxAction(bought, PASS, { actor: P1, mapGrid: CORRIDOR });
    expect(ended).not.toBe(bought);
  });

  it("(3) a corporation the rule does not reach completes normally", () => {
    // No legal route: tokens, but no track to a second centre.
    const routeless = obliged();
    expect(trainObligationFor(routeless, CO, BARE).owed).toBe(false);
    expect(applySandboxAction(routeless, PASS, { actor: P1, mapGrid: BARE })).not.toBe(routeless);
    // Owns a train.
    const trained = board({ corps: [{ id: CO, ticker: "C&O", president: P1, trains: ["2"] }], operating: CO });
    expect(trainObligationFor(trained, CO, CORRIDOR).owed).toBe(false);
    expect(applySandboxAction(trained, PASS, { actor: P1, mapGrid: CORRIDOR })).not.toBe(trained);
    // A reprieved train is still a train the corporation can run this turn (#979).
    const reprieved = board({
      corps: [{ id: CO, ticker: "C&O", president: P1, trains: ["2"], pendingRust: ["2"] }],
      operating: CO,
    });
    expect(trainObligationFor(reprieved, CO, CORRIDOR).owed).toBe(false);
    // Not at the Buy Trains step: the gate says nothing (the obligation arises at the end of the turn).
    const atTrack = { ...obliged(), operating_sub_phase: "Track" } as GameStateResponse;
    expect(trainObligationRefusal(atTrack, ADVANCE(CO), CORRIDOR)).toBeNull();
  });

  it("has no opinion without a board to walk, which is the fixture case (#757)", () => {
    const before = obliged();
    expect(trainObligationFor(before, CO, undefined).owed).toBeNull();
    expect(applySandboxAction(before, PASS, { actor: P1 })).not.toBe(before);
  });

  it("negative control: the arm itself never checked -- a state the gate cannot read ends the turn", () => {
    /* THE PRE-#1513 BEHAVIOUR. With the fleet unreported, the obligation is "not said" and the PassTurn
       reaches `advanceCorporation` exactly as every PassTurn did before this note. */
    const unreported = obliged();
    unreported.public_companies[0].owned_trains = undefined as never;
    const after = applySandboxAction(unreported, PASS, { actor: P1, mapGrid: CORRIDOR });
    expect(after).not.toBe(unreported);
  });
});

/* ------------------------------------------------------------------ */
/* Availability (#1512)                                                 */
/* ------------------------------------------------------------------ */

describe("one answer to what is for sale (design note #1512)", () => {
  it("(4) the forced purchase cannot choose a sold-out train: both 6s out, it buys a Diesel", () => {
    // Standard table, phase 6: PRR and NYC hold the two printed 6-trains. C&O is trainless and broke.
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0" },
        { id: PRR, ticker: "PRR", president: P2, trains: ["6"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["6"] },
      ],
      operating: CO,
      cash: { [P1]: "2000" },
    });
    expect(depotRow(state, "6").remaining).toBe(0);
    expect(cheapestPurchasableTrain(state)).toEqual({ source: "depot", tier: "D", cost: 1100, remaining: null });
    const after = applySandboxAction(state, EMERGENCY(CO), { actor: P1, mapGrid: CORRIDOR });
    expect(company(after, CO).owned_trains).toEqual(["D"]);
    expect(company(after, CO).treasury).toBe("0");
    expect(cash(after, P1)).toBe(2000 - 1100);
  });

  it("(5) when the nominal tier is exhausted, selection proceeds to the cheapest train actually for sale", () => {
    // Phase 5: all three 5s are owned. The next printed train is the 6 at $630.
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0" },
        { id: PRR, ticker: "PRR", president: P2, trains: ["5", "5"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["5"] },
      ],
      operating: CO,
      cash: { [P1]: "2000" },
    });
    expect(depotRow(state, "5").remaining).toBe(0);
    expect(cheapestPurchasableTrain(state)).toMatchObject({ source: "depot", tier: "6", cost: 630 });
    const after = applySandboxAction(state, EMERGENCY(CO), { actor: P1, mapGrid: CORRIDOR });
    expect(company(after, CO).owned_trains).toEqual(["6"]);
    expect(cash(after, P1)).toBe(2000 - 630);
  });

  it("(6) a Bank Pool train is available, is cheaper, and is what the forced purchase takes", () => {
    // Same phase-5 board, but a 4-train sits in the pool (traded in or discarded). 4s rust only at the D.
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: [], treasury: "100" },
        { id: PRR, ticker: "PRR", president: P2, trains: ["5", "5"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["5"] },
      ],
      operating: CO,
      cash: { [P1]: "2000" },
      returned: ["4"],
    });
    expect(bankPoolTrains(state)).toEqual([{ source: "pool", tier: "4", cost: 300, remaining: 1 }]);
    expect(purchasableTrains(state).map((row) => `${row.source}:${row.tier}`)).toEqual(["depot:6", "pool:4"]);
    expect(cheapestPurchasableTrain(state)).toMatchObject({ source: "pool", tier: "4", cost: 300 });
    const after = applySandboxAction(state, EMERGENCY(CO), { actor: P1, mapGrid: CORRIDOR });
    expect(company(after, CO).owned_trains).toEqual(["4"]);
    expect(after.returned_trains).toEqual([]);
    expect(company(after, CO).treasury).toBe("0");
    expect(cash(after, P1)).toBe(2000 - 200);
    // Negative control: the old arm read the depot's first row with stock, which is the 6.
    expect(depotInventory(state).find((row) => row.remaining === null || row.remaining > 0)?.tier).toBe("6");
  });

  it("(6) a pooled train is in exactly one place: the depot no longer counts it as printed stock", () => {
    // Standard table, phase D: one printed 6 is owned, the other was traded in for a Diesel and sits in the pool.
    const state = board({
      corps: [
        { id: PRR, ticker: "PRR", president: P2, trains: ["6"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["D"] },
      ],
      operating: PRR,
      returned: ["6"],
    });
    expect(depotRow(state, "6").remaining).toBe(0);
    expect(purchasableTrains(state).filter((row) => row.tier === "6")).toEqual([
      { source: "pool", tier: "6", cost: 630, remaining: 1 },
    ]);
    // Negative control: `TOTAL - owned` is 2 - 1 = 1 -- the phantom the old subtraction produced.
    expect(depotRow(state, "6").total! - state.public_companies.flatMap((c) => c.owned_trains ?? []).filter((m) => m === "6").length).toBe(1);
  });

  it("ties between a pool train and printed stock of the same model go to the pool", () => {
    const state = board({
      corps: [{ id: CO, ticker: "C&O", president: P1, trains: [] }],
      operating: CO,
      returned: ["2"],
    });
    expect(depotRow(state, "2").remaining).toBe(5); // six printed, one loose in the pool
    expect(cheapestPurchasableTrain(state)).toMatchObject({ source: "pool", tier: "2" });
  });

  it("(7) a normal depot purchase decrements printed stock and leaves the pool alone", () => {
    const state = board({
      corps: [{ id: CO, ticker: "C&O", president: P1, trains: [] }],
      operating: CO,
      returned: ["2"],
    });
    const after = applySandboxAction(state, BUY(CO), { actor: P1, mapGrid: CORRIDOR });
    expect(company(after, CO).owned_trains).toEqual(["2"]);
    expect(depotRow(after, "2").remaining).toBe(4);
    expect(after.returned_trains).toEqual(["2"]);
    expect(Number(company(after, CO).treasury)).toBe(1000 - 80);
    // And a pool purchase takes the loose train and leaves the printed count alone.
    const fromPool = applySandboxAction(state, BUY_POOL(CO, "2"), { actor: P1, mapGrid: CORRIDOR });
    expect(company(fromPool, CO).owned_trains).toEqual(["2"]);
    expect(fromPool.returned_trains).toEqual([]);
    expect(depotRow(fromPool, "2").remaining).toBe(5);
  });

  it("refuses the forced purchase when the president cannot cover the shortfall, and the obligation stands", () => {
    /* Audit C4c. `adjustCash` floors at zero, so this used to take the $50 and hand over the train. Refused
       by identity now; how the money is raised is Batch 5's. */
    const state = board({
      corps: [{ id: CO, ticker: "C&O", president: P1, trains: [], treasury: "0" }],
      operating: CO,
      cash: { [P1]: "50" },
    });
    expect(applySandboxAction(state, EMERGENCY(CO), { actor: P1, mapGrid: CORRIDOR })).toBe(state);
    expect(trainObligationFor(state, CO, CORRIDOR).owed).toBe(true);
    expect(applySandboxAction(state, PASS, { actor: P1, mapGrid: CORRIDOR })).toBe(state);
  });
});

/* ------------------------------------------------------------------ */
/* Trades and the limit                                                  */
/* ------------------------------------------------------------------ */

describe("a corporation-to-corporation sale", () => {
  it("(8) moves exactly one train and the price, and touches no bank inventory", () => {
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: ["3"], treasury: "500" },
        { id: NYC, ticker: "NYC", president: P2, trains: ["3", "4"], treasury: "200" },
      ],
      operating: CO,
    });
    const depotBefore = depotInventory(state).map((row) => row.remaining);
    const after = applySandboxAction(state, TRADE(CO, NYC, "4", "150"), { actor: P1, mapGrid: CORRIDOR });
    expect(company(after, CO).owned_trains).toEqual(["3", "4"]);
    expect(company(after, NYC).owned_trains).toEqual(["3"]);
    expect(company(after, CO).treasury).toBe("350");
    expect(company(after, NYC).treasury).toBe("350");
    expect(depotInventory(after).map((row) => row.remaining)).toEqual(depotBefore);
    expect(after.returned_trains).toBeUndefined();
    // And the seller's shrunken fleet is a SALE, not a discard (#1245).
    expect(describeFleetLosses(state, after, TRADE(CO, NYC, "4", "150"))).toEqual([]);
  });

  it("(8) is refused for a buyer at its train limit -- the limit applies to a trade as to the depot", () => {
    // Phase 4, limit 3: C&O already holds three.
    const state = board({
      corps: [
        { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"], treasury: "500" },
        { id: NYC, ticker: "NYC", president: P2, trains: ["4"], treasury: "200" },
      ],
      operating: CO,
    });
    expect(depotInventory(state).find((row) => row.isCurrent)?.trainLimit).toBe(3);
    expect(applySandboxAction(state, TRADE(CO, NYC, "4", "1"), { actor: P1, mapGrid: CORRIDOR })).toBe(state);
  });
});

describe("the train limit", () => {
  it("(9) at or below the limit, a phase change owes no discard and touches the pool not at all", () => {
    const state = board({
      corps: [{ id: CO, ticker: "C&O", president: P1, trains: ["3", "4"] }],
      operating: CO,
    });
    const after = applyPhaseChange(state, "5"); // limit 2
    expect(company(after, CO).owned_trains).toEqual(["3", "4"]);
    expect(after.returned_trains).toBeUndefined();
    expect(isTrainLocked(countableTrainCount(company(after, CO).owned_trains, undefined, undefined), 2)).toBe(true);
    expect(describeFleetLosses(state, after)).toEqual([]);
  });

  it("(10) above the limit, the excess is discarded and the discarded train goes to the Bank Pool", () => {
    const state = board({
      corps: [{ id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"] }],
      operating: CO,
    });
    const after = applyPhaseChange(state, "5");
    expect(company(after, CO).owned_trains).toEqual(["3", "4"]); // cheapest-first, the trim's standing choice
    expect(after.returned_trains).toEqual(["3"]);
    expect(describeFleetLosses(state, after)).toEqual([{ companyId: CO, ticker: "C&O", rusted: [], discarded: ["3"] }]);
    // The discarded train is now for sale at face value to anybody with room.
    expect(bankPoolTrains(after)).toEqual([{ source: "pool", tier: "3", cost: 180, remaining: 1 }]);
    // And it is not ALSO printed stock: 3s are below the phase-5 head, so the depot row stays at zero.
    expect(depotRow(after, "3").remaining).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* (11) The C&O report, reconstructed                                    */
/* ------------------------------------------------------------------ */

describe("JUNO-FCJ 413 and 468: the discard was real and the sale was not one", () => {
  /* Replayed on the engine that ran the game: at 413 NYC bought the first 5-train (OR 7.1). Phase 4 -> 5,
     limit 3 -> 2; C&O held [3, 3, 4] and was trimmed to [3, 4]. At 468 (OR 7.2) NYC bought C&O's 4 for $1;
     C&O went [3, 4] -> [3]. The Train Limit modal the president saw at the top of C&O's 7.2 turn was the
     413 discard, deferred to the president's next turn by design (#896) -- it arrived after the sale and
     read as its consequence. Reconstructed here on the same figures. */
  // All four printed 4-trains are out (C&O one, PRR one, B&O two), so the depot's head is the 5.
  const BO = 4;
  const beforeFive = board({
    corps: [
      { id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "1000" },
      { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"] },
      { id: PRR, ticker: "PRR", president: P2, trains: ["3", "4"] },
      { id: BO, ticker: "B&O", president: P2, trains: ["4", "4"] },
    ],
    operating: NYC,
  });

  it("C&O was genuinely one over the limit when the first 5 arrived, and lost one train to it", () => {
    expect(depotInventory(beforeFive).find((row) => row.isCurrent)?.trainLimit).toBe(3);
    expect(depotRow(beforeFive, "4").remaining).toBe(0);
    const afterFive = applySandboxAction(beforeFive, BUY(NYC), { actor: P2, mapGrid: CORRIDOR });
    expect(company(afterFive, NYC).owned_trains).toEqual(["5"]);
    expect(depotInventory(afterFive).find((row) => row.isCurrent)?.trainLimit).toBe(2);
    expect(company(afterFive, CO).owned_trains).toEqual(["3", "4"]);
    expect(company(afterFive, PRR).owned_trains).toEqual(["3", "4"]); // at the limit, untouched
    expect(describeFleetLosses(beforeFive, afterFive, BUY(NYC))).toEqual([
      { companyId: CO, ticker: "C&O", rusted: [], discarded: ["3"] },
    ]);
    expect(afterFive.returned_trains).toEqual(["3"]); // #1513: to the pool, not lost
  });

  it("the later sale of C&O's 4 took C&O to one train, owed nothing, and narrated no loss", () => {
    const afterFive = applySandboxAction(beforeFive, BUY(NYC), { actor: P2, mapGrid: CORRIDOR });
    const sale = TRADE(NYC, CO, "4", "1");
    const afterSale = applySandboxAction(afterFive, sale, { actor: P2, mapGrid: CORRIDOR });
    expect(company(afterSale, CO).owned_trains).toEqual(["3"]);
    expect(company(afterSale, NYC).owned_trains).toEqual(["5", "4"]);
    expect(describeFleetLosses(afterFive, afterSale, sale)).toEqual([]);
    expect(isTrainLocked(countableTrainCount(company(afterSale, CO).owned_trains, undefined, undefined), 2)).toBe(false);
    expect(trainObligationFor(afterSale, CO, CORRIDOR).owed).toBe(false);
  });
});
