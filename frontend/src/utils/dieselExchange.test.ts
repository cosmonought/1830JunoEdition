// Design note #1303: the Project 18XX+ D-train exchange.
//
// RULED: "a 4-, 5- or 6-train may be traded in to purchase a D-train for $800." Treasury only -- an exchange
// is an ordinary purchase by a corporation that already owns a train, so the emergency flow never applies.

import { applySandboxAction, returnedTrainRefusal } from "./sandboxSession";
import { actionWasRefused, refusalReasonFor } from "./refusedAction";
import { describeGameplayAction } from "./actionLog";
import { depotInventory } from "./gamePhase";
import {
  DIESEL_EXCHANGE_COST,
  dieselAvailable,
  dieselExchangeRefusal,
  exchangeableTrains,
} from "./dieselExchange";
import type { GameStateResponse } from "./gameState";
import { MOCK_MAP_GRID } from "./mockFixtures";

const NNH = 7;
const BO = 4;

/** An Operating Round at the Buy Trains step, both 6-trains sold so the Diesel is for sale. */
function board(overrides: Record<string, unknown> = {}): GameStateResponse {
  return {
    game_id: 1,
    current_round_type: "OperatingRound",
    operating_sub_phase: "Hardware",
    macro_round_number: 9,
    sub_round_index: 1,
    active_operating_order: [NNH, BO],
    active_corporation_index: 0,
    active_player_index: 0,
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "8000",
    private_companies: [],
    variants: { expandedMap: true },
    public_companies: [
      {
        company_id: NNH,
        ticker: "NNH",
        president: "p1",
        treasury: "900",
        owned_trains: ["4", "6"],
        station_token_hexes: [[6, 6]],
        station_token_limit: 4,
        player_holdings: [{ player: "p1", percentage: 60 }],
        is_floated: true,
      },
      {
        company_id: BO,
        ticker: "B&O",
        president: "p2",
        treasury: "2000",
        owned_trains: ["4", "5", "6"],
        station_token_hexes: [[3, 8]],
        station_token_limit: 4,
        player_holdings: [{ player: "p2", percentage: 60 }],
        is_floated: true,
      },
    ],
    ...overrides,
  } as unknown as GameStateResponse;
}

const EXCHANGE = (companyId: number, model: string) => ({
  ExchangeTrainForDiesel: { game_id: 1, protocol_id: companyId, model_type: model },
});

const company = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;

describe("the fixture really has the Diesel for sale", () => {
  it("has both 6-trains out and nothing cheaper left", () => {
    const forSale = depotInventory(board()).find((row) => row.remaining === null || row.remaining > 0);
    expect(forSale?.tier).toBe("D");
    expect(dieselAvailable(board())).toBe(true);
  });
  it("lists NNH's tradeable trains", () => {
    expect(exchangeableTrains(company(board(), NNH))).toEqual(["4", "6"]);
    expect(exchangeableTrains({ owned_trains: ["2", "3", "D"] })).toEqual([]);
  });
});

describe("the exchange", () => {
  it("swaps the train, pays the bank $800, and turns the phase", () => {
    const before = board();
    const after = applySandboxAction(before, EXCHANGE(NNH, "4") as never);
    expect(after).not.toBe(before);
    expect(company(after, NNH).owned_trains).toEqual(["6", "D"]);
    expect(Number(company(after, NNH).treasury)).toBe(900 - DIESEL_EXCHANGE_COST);
    expect(Number(after.virtual_bank_vgp)).toBe(8000 + DIESEL_EXCHANGE_COST);
    // The first Diesel rusts every 4-train still on the board -- B&O's, not the one that was traded.
    expect(company(after, BO).owned_trains).toEqual(["5", "6"]);
    expect(after.current_global_era).toBe("Brown");
  });

  it("removes exactly one train when the corporation holds two of that model", () => {
    // Two 5s at NNH, both 6s at B&O: the Diesel is for sale and no fleet is over the Phase-D limit.
    const before = board({
      public_companies: board().public_companies.map((entry) =>
        entry.company_id === NNH
          ? { ...entry, owned_trains: ["5", "5"], treasury: "1000" }
          : { ...entry, owned_trains: ["6", "6"] },
      ),
    });
    const after = applySandboxAction(before, EXCHANGE(NNH, "5") as never);
    expect(company(after, NNH).owned_trains).toEqual(["5", "D"]);
  });

  it("gives a traded 4-train no Gentle Rust reprieve -- it was exchanged, not rusted", () => {
    const before = board({ variants: { expandedMap: true, gentleRust: true } });
    const after = applySandboxAction(before, EXCHANGE(NNH, "4") as never);
    expect(company(after, NNH).owned_trains).toEqual(["6", "D"]);
    expect(company(after, NNH).pending_rust_trains ?? []).toEqual([]);
    // B&O's 4 is reprieved rather than destroyed, exactly as a bought Diesel would have it.
    expect(company(after, BO).pending_rust_trains).toEqual(["4"]);
  });

  it("does not count as a purchase against the train limit", () => {
    // Three trains at a Phase-6 limit of two would refuse a purchase; an exchange is one out, one in.
    const before = board({
      public_companies: board().public_companies.map((entry) =>
        entry.company_id === NNH
          ? { ...entry, owned_trains: ["4", "5", "6"], treasury: "1000" }
          : { ...entry, owned_trains: ["4", "6"] },
      ),
    });
    expect(dieselAvailable(before)).toBe(true);
    expect(dieselExchangeRefusal(before, NNH, "4")).toBeNull();
  });
});

describe("the traded-in train goes back to the depot (design note #1314)", () => {
  const RETURNED_BUY = (companyId: number, model: string) => ({
    BuyHardwareFromPool: { game_id: 1, protocol_id: companyId, returned_model_type: model },
  });

  it("returns a 6-train to the bank, where any corporation may buy it at face value", () => {
    // NNH trades its 6 in once the Diesel is already out at B&O, so nothing rusts.
    const before = board({
      public_companies: board().public_companies.map((entry) =>
        entry.company_id === NNH
          ? { ...entry, owned_trains: ["5", "6"], treasury: "1000" }
          : { ...entry, owned_trains: ["D"] }, // one train, so the Phase-D limit of two has room for the 6
      ),
    });
    const traded = applySandboxAction(before, EXCHANGE(NNH, "6") as never);
    expect(company(traded, NNH).owned_trains).toEqual(["5", "D"]);
    expect(traded.returned_trains).toEqual(["6"]);
    // NNH itself is at the Phase-D limit of two now, so the gate says so; B&O, with one train, may buy it.
    expect(returnedTrainRefusal(traded, NNH, "6")).toMatch(/Train limit reached/);

    // B&O's turn: buys the returned 6 for its printed $630.
    const boTurn = { ...traded, active_corporation_index: 1 };
    expect(returnedTrainRefusal(boTurn, BO, "6")).toBeNull();
    const bought = applySandboxAction(boTurn, RETURNED_BUY(BO, "6") as never);
    expect(bought).not.toBe(boTurn);
    expect(company(bought, BO).owned_trains).toEqual(["D", "6"]);
    expect(Number(company(bought, BO).treasury)).toBe(2000 - 630);
    expect(Number(bought.virtual_bank_vgp)).toBe(8000 + DIESEL_EXCHANGE_COST + 630);
    expect(bought.returned_trains).toEqual([]);
    expect(
      describeGameplayAction(RETURNED_BUY(BO, "6") as never, {
        gameState: boTurn,
        afterState: bought,
        mapGrid: MOCK_MAP_GRID,
        era: "Brown",
        labelForAddress: (address) => address,
      }),
    ).toMatch(/B&O bought a returned 6-train from the Bank for \$630\./);
  });

  it("scraps a returned 4-train with every other 4 when the first Diesel arrives", () => {
    const after = applySandboxAction(board(), EXCHANGE(NNH, "4") as never);
    expect(after.returned_trains).toEqual([]); // put in the depot, then rusted by the same sweep
    // And under Gentle Rust it gets no final run -- nobody in the depot can run it.
    const gentle = applySandboxAction(
      board({ variants: { expandedMap: true, gentleRust: true } }),
      EXCHANGE(NNH, "4") as never,
    );
    expect(gentle.returned_trains).toEqual([]);
  });

  it("refuses a returned purchase the depot cannot honour, by identity", () => {
    const nothingReturned = board();
    const after = applySandboxAction(nothingReturned, RETURNED_BUY(NNH, "5") as never);
    expect(after).toBe(nothingReturned);
    expect(refusalReasonFor(nothingReturned, RETURNED_BUY(NNH, "5") as never)).toMatch(/no returned 5-train/);
  });

  it("leaves the ordinary purchase exactly as it was", () => {
    const plain = { BuyHardwareFromPool: { game_id: 1, protocol_id: NNH } };
    const before = board({
      public_companies: board().public_companies.map((entry) =>
        entry.company_id === NNH ? { ...entry, owned_trains: ["6"], treasury: "1200" } : { ...entry, owned_trains: ["6", "D"] },
      ),
    });
    const after = applySandboxAction(before, plain as never);
    expect(company(after, NNH).owned_trains).toEqual(["6", "D"]);
    expect(after.returned_trains).toBeUndefined();
  });
});

describe("the refusals, by identity and by sentence", () => {
  const refused = (state: GameStateResponse, msg: object, reason: RegExp) => {
    const after = applySandboxAction(state, msg as never);
    expect(after).toBe(state);
    expect(actionWasRefused(state, after, msg as never)).toBe(true);
    expect(refusalReasonFor(state, msg as never)).toMatch(reason);
  };

  it("is not played on the standard table", () => {
    refused(board({ variants: {} }), EXCHANGE(NNH, "4"), /not playing Project 18XX\+/);
    refused(board({ variants: undefined }), EXCHANGE(NNH, "4"), /not playing Project 18XX\+/);
  });

  it("waits for the Diesel to be for sale", () => {
    const early = board({
      public_companies: board().public_companies.map((entry) => ({ ...entry, owned_trains: ["4", "5"] })),
    });
    expect(dieselAvailable(early)).toBe(false);
    refused(early, EXCHANGE(NNH, "4"), /not for sale yet/);
  });

  it("needs the whole $800 in the treasury -- no president's cash", () => {
    const poor = board({
      public_companies: board().public_companies.map((entry) =>
        entry.company_id === NNH ? { ...entry, treasury: "700" } : entry,
      ),
    });
    refused(poor, EXCHANGE(NNH, "4"), /cannot pay \$800/);
  });

  it("takes only a 4, 5 or 6 the corporation actually owns", () => {
    refused(board(), EXCHANGE(NNH, "3"), /no 3-train to trade in/);
    refused(board(), EXCHANGE(NNH, "5"), /no 5-train to trade in/);
    const noneToTrade = board({
      public_companies: board().public_companies.map((entry) =>
        entry.company_id === NNH
          ? { ...entry, owned_trains: ["D"] }
          : { ...entry, owned_trains: ["4", "5", "6", "6"] }, // both 6s still out, so the Diesel is for sale
      ),
    });
    refused(noneToTrade, EXCHANGE(NNH, "4"), /no 4-, 5- or 6-train/);
  });

  it("is the operating corporation's to make, at the Buy Trains step", () => {
    refused(board(), EXCHANGE(BO, "5"), /Only the operating corporation/);
    refused(board({ operating_sub_phase: "Track" }), EXCHANGE(NNH, "4"), /Buy Trains step/);
    refused(board({ current_round_type: "StockRound" }), EXCHANGE(NNH, "4"), /Operating Round/);
  });
});

describe("the log line", () => {
  it("says what was traded and what it cost", () => {
    const before = board();
    const after = applySandboxAction(before, EXCHANGE(NNH, "4") as never);
    const line = describeGameplayAction(EXCHANGE(NNH, "4") as never, {
      gameState: before,
      afterState: after,
      mapGrid: MOCK_MAP_GRID,
      era: "Brown",
      labelForAddress: (address) => address,
    });
    expect(line).toMatch(/NNH traded in a 4-train and paid \$800 for a D-train\./);
  });
});
