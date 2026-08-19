// frontend/src/utils/operatingRoundCycleCount.test.ts
//
// ==================================================================
//  DESIGN NOTE 621 (harness): COUNTING FROM A STOCK ROUND, NOT A FIXTURE
// ==================================================================
//
// REPORTED: three corporations floated, all three operated, "the Operating
// Round then looped back to B&O" -- in Phase 2, which runs exactly one
// Operating Round.
//
// `operatingRoundPhaseLoop.test.ts` already pins `operatingRoundsForPhase`
// and already runs whole cycles, and it passed throughout. It could not have
// caught this: its harness seeds `sub_round_index: 1`, which is what a
// fixture that OPENS in an Operating Round carries. The bug lived entirely
// in the other entry -- a cycle opened by a Stock Round closing, where
// `sub_round_index` has just been zeroed.
//
// So these tests start where the report started: at a Stock Round, with the
// counter at 0, and open the cycle the way the shell does. That is the one
// path neither existing harness covered, and it is the path every real game
// takes.
//
// THE ASSERTIONS ARE ABOUT CYCLE LENGTH, not about the counter, wherever
// possible. A test that only checked `sub_round_index === 1` after opening
// would pin the fix rather than the rule, and would keep passing if the
// comparison in `advanceCorporation` were later inverted to compensate.

import {
  applySandboxAction,
  beginOperatingRound,
  operatingRoundsForPhase,
} from "./sandboxSession";
import { derivePhase } from "./gamePhase";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";
const CAI = "juno1cai";

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
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  };
}

/** The state a Stock Round hands over: round type still `StockRound`, the
 *  counter zeroed, no queue built yet. Deliberately the shape `App.tsx`
 *  produces when it closes a Stock Round, because that is where the bug was.
 *
 *  `operating_round_sequence_length` is seeded WRONG (9) so nothing can pass
 *  by reading it -- the same trick `operatingRoundPhaseLoop.test.ts` uses. */
function stockRoundHandover(trains: string[]): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 3,
    player_addresses: [ALICE, BOB, CAI],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    current_round_type: "StockRound",
    macro_round_number: 1,
    // What `App.tsx` writes when a Stock Round closes.
    sub_round_index: 0,
    operating_round_sequence_length: 9,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
      { player: CAI, cash_vgp: "400" },
    ],
    /* The report's three: B&O, PRR and C&O, all floated, all with a
       president -- which is what `buildOperatingOrder` requires to seat a
       corporation in the queue. */
    public_companies: [
      company({ company_id: 4, ticker: "B&O", owned_trains: trains, president: ALICE }),
      company({ company_id: 1, ticker: "PRR", owned_trains: trains, president: BOB }),
      company({ company_id: 5, ticker: "C&O", owned_trains: trains, president: CAI }),
    ],
    private_companies: [],
  };
}

const END_TURN = { PassTurn: { game_id: 1 } } as const;

/** Opens a cycle from a Stock Round and ends every corporation's turn until
 *  the sequence closes. Returns how many Operating Rounds ran.
 *
 *  Bounded, so the infinite-round regression this file exists for fails
 *  loudly instead of hanging the suite. */
function operatingRoundsInCycle(trains: string[]): number {
  let state = beginOperatingRound(stockRoundHandover(trains));
  let rounds = 1;
  for (let dispatch = 0; dispatch < 200; dispatch += 1) {
    state = applySandboxAction(state, END_TURN);
    if (state.operating_round_just_ended) return rounds;
    if (state.active_corporation_index === 0) rounds += 1;
  }
  throw new Error("the operating round never closed");
}

describe("a cycle opened by a Stock Round runs the phase's number of rounds", () => {
  it("runs ONE Operating Round in Phase 2", () => {
    // The reported bug: this ran two, and the second one looped back to B&O.
    expect(operatingRoundsInCycle(["2"])).toBe(1);
  });

  it("runs TWO in Phases 3 and 4", () => {
    expect(operatingRoundsInCycle(["3"])).toBe(2);
    expect(operatingRoundsInCycle(["4"])).toBe(2);
  });

  it("runs THREE in Phases 5, 6 and D", () => {
    expect(operatingRoundsInCycle(["5"])).toBe(3);
    expect(operatingRoundsInCycle(["6"])).toBe(3);
    expect(operatingRoundsInCycle(["D"])).toBe(3);
  });

  it("runs ONE with no trains bought at all, which is where a game starts", () => {
    /* An opening cycle: nobody owns a train, so the phase is 2. This is the
       exact position the report describes -- the first Operating Round of a
       fresh game. */
    expect(operatingRoundsInCycle([])).toBe(1);
  });
});

describe("the cycle's opening bookkeeping", () => {
  it("stamps the counter, the queue and the length together", () => {
    /* Design note #621: all three, in one place. Two of them were already
       stamped here and the third was not, which is the whole bug. */
    const opened = beginOperatingRound(stockRoundHandover([]));
    expect(opened.sub_round_index).toBe(1);
    expect(opened.operating_round_sequence_length).toBe(1);
    expect(opened.active_operating_order).toHaveLength(3);
    expect(opened.active_corporation_index).toBe(0);
  });

  it("numbers the rounds 1..N as the cycle runs", () => {
    // Phase 3: the player should read "1.1" then "1.2", never "1.0".
    let state = beginOperatingRound(stockRoundHandover(["3"]));
    expect(state.sub_round_index).toBe(1);
    for (let turn = 0; turn < 3; turn += 1) state = applySandboxAction(state, END_TURN);
    expect(state.operating_round_just_ended).toBeFalsy();
    expect(state.sub_round_index).toBe(2);
  });

  it("keeps the length the cycle opened with when a train shifts the phase mid-cycle", () => {
    /* Design note #511, re-pinned from the Stock-Round entry. A cycle that
       opened in Phase 2 runs one round even if a 3-train arrives during it;
       the new phase governs the NEXT cycle. */
    let state = beginOperatingRound(stockRoundHandover([]));
    expect(state.operating_round_sequence_length).toBe(1);
    // B&O buys a 3-train on its turn -- the phase moves under the cycle.
    state = {
      ...state,
      public_companies: state.public_companies.map((entry) =>
        entry.company_id === 4 ? { ...entry, owned_trains: ["3"] } : entry,
      ),
    };
    expect(derivePhase(state)?.tier).toBe("3");
    expect(operatingRoundsForPhase(derivePhase(state))).toBe(2);
    // ...and the cycle in progress still ends after its one round.
    for (let turn = 0; turn < 3; turn += 1) state = applySandboxAction(state, END_TURN);
    expect(state.operating_round_just_ended).toBe(true);
  });
});

describe("the round closes only when every floated corporation has ended its turn", () => {
  it("holds the round open until the last corporation in the queue is done", () => {
    /* The other half of the report: "make sure that the condition for moving
       Rounds is that the floated corporations have all hit End Turn."
       Buying a train is NOT the condition -- C&O ended its turn without one,
       which is legal when it has no route to run. */
    let state = beginOperatingRound(stockRoundHandover(["2"]));
    expect(state.active_operating_order).toHaveLength(3);

    state = applySandboxAction(state, END_TURN);
    expect(state.operating_round_just_ended).toBeFalsy();
    expect(state.active_corporation_index).toBe(1);

    state = applySandboxAction(state, END_TURN);
    expect(state.operating_round_just_ended).toBeFalsy();
    expect(state.active_corporation_index).toBe(2);

    state = applySandboxAction(state, END_TURN);
    expect(state.operating_round_just_ended).toBe(true);
  });

  it("seats only floated corporations that have a president", () => {
    /* An unfloated company cannot operate, so it is not in the queue and
       cannot hold the round open. Design note #169. */
    const handover = stockRoundHandover(["2"]);
    const opened = beginOperatingRound({
      ...handover,
      public_companies: handover.public_companies.map((entry) =>
        entry.company_id === 5 ? { ...entry, is_floated: false } : entry,
      ),
    });
    expect(opened.active_operating_order).toEqual(
      expect.not.arrayContaining([5]),
    );
    expect(opened.active_operating_order).toHaveLength(2);
  });
});
