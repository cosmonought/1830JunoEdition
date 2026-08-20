// frontend/src/utils/roundLabel.test.ts
//
// ==================================================================
//  DESIGN NOTE 659 (harness): TAGGED WITH THE ROUND IT HAPPENED IN
// ==================================================================
//
// REPORTED: "it labels the last action of OR 1.1 as the first action of SR2,
// i.e., it printed '[SR2] PRR passed Buy Trains.' This should read [OR1.1]
// and then a second entry for [SR2]."
//
// `roundLabelFor` was never the bug -- it is asked which round a state is in
// and it answers correctly. The bug was asking it about `after`, the state
// the action resolved TO, for an action whose whole significance is that it
// ended the round it was taken in.
//
// So the assertions here are about the PAIR. A round-closing action produces
// two different labels from one dispatch, and the test states which entry
// gets which. That is checkable without a renderer because both labels come
// from the reducer, which is the point of having moved the rounds into it
// (design note #642).

import { applySandboxAction } from "./sandboxSession";
import { roundLabelFor } from "./roundLabel";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";

function company(
  over: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
): PublicCompanyState {
  return {
    is_floated: true,
    treasury: "900",
    total_shares_issued: 10,
    par_value: "100",
    president: ALICE,
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: null,
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  };
}

/** OR 1.1 with one corporation left to act -- so the next `PassTurn` is the
 *  last action of the Operating Round, which is the action the report is
 *  about. */
function lastTurnOfOr11(): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 2,
    player_addresses: [ALICE, BOB],
    active_player_index: 1,
    priority_deal_index: 1,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [4, 1],
    // The second and last corporation in the queue.
    active_corporation_index: 1,
    current_round_type: "OperatingRound",
    macro_round_number: 1,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
    ],
    public_companies: [
      company({ company_id: 4, ticker: "B&O", president: ALICE }),
      company({ company_id: 1, ticker: "PRR", president: BOB }),
    ],
    private_companies: [],
  };
}

type Msg = Parameters<typeof applySandboxAction>[1];

describe("roundLabelFor", () => {
  it("names each round the way the log and the ticker do", () => {
    const or = lastTurnOfOr11();
    expect(roundLabelFor(or)).toBe("OR 1.1");
    expect(roundLabelFor({ ...or, current_round_type: "StockRound", macro_round_number: 2 })).toBe(
      "SR2",
    );
    expect(roundLabelFor({ ...or, current_round_type: "WaterfallAuction" })).toBe("Auction");
  });

  it("drops the cycle suffix between rounds", () => {
    /* Design note #621 zeroes `sub_round_index` on close and
       `beginOperatingRound` stamps it back to 1, so a 0 is the gap rather
       than a round -- "OR 2.0" would name something that never happens. */
    expect(roundLabelFor({ ...lastTurnOfOr11(), sub_round_index: 0 })).toBe("OR 1");
  });

  it("has no answer for a state it was not given", () => {
    expect(roundLabelFor(null)).toBeNull();
    expect(roundLabelFor(undefined)).toBeNull();
  });
});

describe("the action that closes a round", () => {
  it("produces two different labels from one dispatch", () => {
    /* THE REPORTED BUG, as the assertion that makes it visible. Until an
       Operating Round ends, `before` and `after` agree and either would do --
       which is how `roundLabelFor(after)` passed every earlier reading. */
    const before = lastTurnOfOr11();
    const after = applySandboxAction(before, { PassTurn: { game_id: 1 } } as Msg);
    expect(roundLabelFor(before)).toBe("OR 1.1");
    expect(roundLabelFor(after)).toBe("SR2");
    expect(roundLabelFor(before)).not.toBe(roundLabelFor(after));
  });

  it("belongs to the round it was taken in, not the one it opened", () => {
    /* The rule, stated as the log applies it: the ACTION entry takes
       `before`. "[OR 1.1] PRR passed Buy Trains", not "[SR2]". */
    const before = lastTurnOfOr11();
    const after = applySandboxAction(before, { PassTurn: { game_id: 1 } } as Msg);
    const actionEntryRound = roundLabelFor(before);
    const announcementRound = roundLabelFor(after);
    expect(actionEntryRound).toBe("OR 1.1");
    expect(announcementRound).toBe("SR2");
  });

  it("hands the Priority Deal to the seat the announcement names", () => {
    /* The second entry says who acts first, so the label and the seat have to
       come from the same state. `settleRoundTransitions` sets
       `active_player_index` to `priority_deal_index` on this transition
       (design note #353); the announcement reads the same field. */
    const before = lastTurnOfOr11();
    const after = applySandboxAction(before, { PassTurn: { game_id: 1 } } as Msg);
    expect(after.current_round_type).toBe("StockRound");
    expect(after.active_player_index).toBe(after.priority_deal_index);
    expect(after.player_addresses[after.priority_deal_index]).toBe(BOB);
  });

  it("leaves both labels equal for an ordinary mid-round action", () => {
    /* The other 99% of actions, asserted so the fix cannot be "read `before`
       everywhere" applied somewhere it would be wrong. A hand-over between
       corporations is still OR 1.1 on both sides. */
    const before: GameStateResponse = { ...lastTurnOfOr11(), active_corporation_index: 0 };
    const after = applySandboxAction(before, { PassTurn: { game_id: 1 } } as Msg);
    expect(roundLabelFor(after)).toBe(roundLabelFor(before));
    expect(after.active_corporation_index).toBe(1);
  });
});
