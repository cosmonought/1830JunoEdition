// frontend/src/utils/boFloatRule.test.ts
//
// ==================================================================
//  DESIGN NOTE 445 (harness): NOTHING FLOATS IN THE AUCTION
// ==================================================================
//
// The reported bug was a hallucinated RULE: that winning the B&O private
// floats the B&O corporation. The reducer never implemented it -- the belief
// lived in UI copy, a badge reading "Auto-floated by the B&O private" and
// several comments describing the state as one the panel was "ready for".
//
// That makes this an unusual regression to guard, because the code was
// right and the story around it was wrong. A story is what the next person
// implements. So these tests assert the BEHAVIOUR plainly enough that
// anyone tempted to "fix" the reducer to match a remembered rule has to
// delete an explicit assertion saying otherwise.
//
// The float threshold itself is exercised alongside, because "B&O floats
// like everyone else" is only meaningful if the ordinary path is pinned
// too.

import {
  applyFloatThreshold,
  grantBOPresidency,
  FLOAT_THRESHOLD_PERCENT,
} from "./sandboxSession";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const DAVE = "juno1dave";
const ALICE = "juno1alice";

function bo(over: Partial<PublicCompanyState> = {}): PublicCompanyState {
  return {
    company_id: 4,
    ticker: "B&O",
    is_floated: false,
    treasury: "0",
    total_shares_issued: 0,
    par_value: null,
    president: null,
    ipo_pool_percentage: 100,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: "I15",
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  };
}

function auctionState(company: PublicCompanyState = bo()): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 4,
    player_addresses: [ALICE, DAVE],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    // The round the bug claimed a float could happen in.
    current_round_type: "WaterfallAuction",
    macro_round_number: 1,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: DAVE, cash_vgp: "400" },
    ],
    public_companies: [company],
    private_companies: [],
  };
}

const noAxial = () => null;

describe("winning the B&O private", () => {
  const granted = grantBOPresidency(auctionState(), DAVE, "67");
  const company = granted.public_companies[0];

  it("does NOT float the corporation", () => {
    // The whole bug, in one assertion.
    expect(company.is_floated).toBe(false);
  });

  it("grants the 20% President's Certificate", () => {
    expect(company.president).toBe(DAVE);
    expect(company.player_holdings).toEqual([{ player: DAVE, percentage: 20 }]);
  });

  it("sets the par price the winner chose", () => {
    expect(company.par_value).toBe("67");
  });

  it("leaves the unsold 80% in the IPO", () => {
    // Not a bank pool: nobody has sold anything.
    expect(company.ipo_pool_percentage).toBe(80);
    expect(company.bank_pool_percentage).toBe(0);
  });

  it("takes no money", () => {
    // The certificate is granted, not bought -- charging par here would
    // bill the player twice for one private.
    expect(granted.player_cash).toEqual(auctionState().player_cash);
    expect(granted.virtual_bank_vgp).toBe("12000");
  });

  it("leaves the treasury empty", () => {
    // Capitalisation arrives at FLOAT, and it has not floated.
    expect(company.treasury).toBe("0");
  });

  it("places no home station token", () => {
    expect(company.station_token_hexes).toEqual([]);
  });

  it("is idempotent -- a second grant changes nothing", () => {
    expect(grantBOPresidency(granted, ALICE, "100")).toBe(granted);
  });
});

describe("the float threshold applies to the B&O like anyone else", () => {
  it("does not float at 20% sold", () => {
    const after = applyFloatThreshold(auctionState(bo({
      president: DAVE,
      par_value: "67",
      ipo_pool_percentage: 80,
      player_holdings: [{ player: DAVE, percentage: 20 }],
    })), noAxial);
    expect(after.public_companies[0].is_floated).toBe(false);
  });

  it("does not float one percent short of the threshold", () => {
    const short = FLOAT_THRESHOLD_PERCENT - 10;
    const after = applyFloatThreshold(auctionState(bo({
      president: DAVE,
      par_value: "67",
      ipo_pool_percentage: 100 - short,
      player_holdings: [{ player: DAVE, percentage: short }],
    })), noAxial);
    expect(after.public_companies[0].is_floated).toBe(false);
  });

  it("floats at exactly 60% sold, and capitalises then", () => {
    const after = applyFloatThreshold(auctionState(bo({
      president: DAVE,
      par_value: "67",
      ipo_pool_percentage: 100 - FLOAT_THRESHOLD_PERCENT,
      player_holdings: [{ player: DAVE, percentage: FLOAT_THRESHOLD_PERCENT }],
    })), noAxial);
    const floated = after.public_companies[0];
    expect(floated.is_floated).toBe(true);
    // Ten times par, and not a moment before.
    expect(floated.treasury).toBe("670");
  });

  it("uses the same threshold for the B&O as for any other corporation", () => {
    const asPRR = applyFloatThreshold(auctionState(bo({
      company_id: 1,
      ticker: "PRR",
      president: ALICE,
      par_value: "67",
      ipo_pool_percentage: 100 - FLOAT_THRESHOLD_PERCENT,
      player_holdings: [{ player: ALICE, percentage: FLOAT_THRESHOLD_PERCENT }],
    })), noAxial);
    expect(asPRR.public_companies[0].is_floated).toBe(true);
    expect(FLOAT_THRESHOLD_PERCENT).toBe(60);
  });
});
