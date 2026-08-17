// frontend/src/utils/operatingRoundPhaseLoop.test.ts
//
// ==================================================================
//  DESIGN NOTE 431 (harness): THE OR COUNT IS THE PHASE'S
// ==================================================================
//
// The reported bug: in the Yellow phase the game opened a second Operating
// Round instead of returning to the Stock Round.
//
// It is the same failure `operatingRoundTurn.test.ts` was written for --
// a value that has to be correct, read from a state field nothing
// maintains -- and it survived that harness because those tests SET
// `operating_round_sequence_length` explicitly, so they were asserting
// against the number they had just supplied rather than against the rule.
//
// These tests set the trains instead and let the phase be derived, which is
// the path a real game takes. A regression that goes back to reading the
// state field fails here and passes there, which is exactly the split
// worth having.

import {
  applySandboxAction,
  beginOperatingRound,
  operatingRoundsForPhase,
} from "./sandboxSession";
import { derivePhase } from "./gamePhase";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";

function company(
  over: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
): PublicCompanyState {
  return {
    is_floated: true,
    treasury: "500",
    total_shares_issued: 10,
    par_value: "100",
    president: ALICE,
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: null,
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: ["2"],
    last_route_revenue: "0",
    ...over,
  };
}

/** A live Operating Round whose phase comes from the trains in play.
 *
 *  `operating_round_sequence_length` is deliberately seeded to a WRONG
 *  value (9) in every case below. Nothing should read it, and a test that
 *  set it correctly could not tell whether it was being read. */
function stateWithTrains(trains: string[]): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 2,
    player_addresses: [ALICE, BOB],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    current_round_type: "OperatingRound",
    macro_round_number: 2,
    sub_round_index: 1,
    operating_round_sequence_length: 9,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
    ],
    public_companies: [
      company({ company_id: 1, ticker: "PRR", owned_trains: trains, president: ALICE }),
      company({ company_id: 2, ticker: "NYC", owned_trains: trains, president: BOB }),
    ],
    private_companies: [],
  };
}

const PASS = { PassTurn: { game_id: 1 } } as const;

/** Runs whole Operating Rounds until the round sequence closes, and reports
 *  how many it took. Bounded so a regression fails rather than hangs. */
function operatingRoundsUntilStockRound(trains: string[]): number {
  let state = beginOperatingRound(stateWithTrains(trains));
  let rounds = 1;
  for (let dispatch = 0; dispatch < 200; dispatch += 1) {
    state = applySandboxAction(state, PASS);
    if (state.operating_round_just_ended) return rounds;
    // A rebuilt queue with the cursor back at zero means a new OR opened.
    if (state.active_corporation_index === 0) rounds += 1;
  }
  throw new Error("the operating round never closed");
}

describe("operatingRoundsForPhase", () => {
  it("runs 1 Operating Round in Yellow", () => {
    expect(operatingRoundsForPhase(derivePhase(stateWithTrains(["2"])))).toBe(1);
  });

  it("runs 2 in Green, on both the 3- and the 4-train", () => {
    expect(operatingRoundsForPhase(derivePhase(stateWithTrains(["3"])))).toBe(2);
    expect(operatingRoundsForPhase(derivePhase(stateWithTrains(["4"])))).toBe(2);
  });

  it("runs 3 in Brown, including the Diesel phase", () => {
    expect(operatingRoundsForPhase(derivePhase(stateWithTrains(["5"])))).toBe(3);
    expect(operatingRoundsForPhase(derivePhase(stateWithTrains(["6"])))).toBe(3);
    expect(operatingRoundsForPhase(derivePhase(stateWithTrains(["D"])))).toBe(3);
  });

  it("reads the HIGHEST train in play, not the first", () => {
    // The phase is set by the best train anyone owns.
    expect(operatingRoundsForPhase(derivePhase(stateWithTrains(["2", "5"])))).toBe(3);
  });

  it("falls back to the Yellow count when the phase is unknown", () => {
    // One round too few returns the player to a Stock Round they can act
    // in; one too many is the bug. Erring short is the safe direction.
    expect(operatingRoundsForPhase(null)).toBe(1);
  });
});

describe("the Yellow-phase loop, end to end", () => {
  it("returns to the Stock Round after ONE Operating Round in Yellow", () => {
    // The reported bug: this ran twice.
    expect(operatingRoundsUntilStockRound(["2"])).toBe(1);
  });

  it("runs two in Green and three in Brown", () => {
    expect(operatingRoundsUntilStockRound(["3"])).toBe(2);
    expect(operatingRoundsUntilStockRound(["5"])).toBe(3);
  });

  it("ignores operating_round_sequence_length on the state", () => {
    // Every fixture above seeds it to 9. If anything still reads it, the
    // Yellow game runs nine rounds and the count above is wrong.
    const state = stateWithTrains(["2"]);
    expect(state.operating_round_sequence_length).toBe(9);
    expect(operatingRoundsUntilStockRound(["2"])).toBe(1);
  });

  it("stamps the derived count onto the state when the round opens", () => {
    // So "OR n of N" in the sub-phase strip reports the real N rather than
    // the fixture's placeholder.
    expect(beginOperatingRound(stateWithTrains(["2"])).operating_round_sequence_length).toBe(1);
    expect(beginOperatingRound(stateWithTrains(["4"])).operating_round_sequence_length).toBe(2);
    expect(beginOperatingRound(stateWithTrains(["6"])).operating_round_sequence_length).toBe(3);
  });
});
