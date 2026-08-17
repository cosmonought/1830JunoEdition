// frontend/src/utils/operatingRoundTurn.test.ts
//
// ==================================================================
//  DESIGN NOTE 411 (harness): PROVING THE ROUND TERMINATES
// ==================================================================
//
// The reported bug was an Operating Round that never advanced, and the
// thing that makes that class of bug expensive is that it is invisible in
// every fixture: `sandboxState.ts` ships a hand-written operating queue, so
// every scenario that OPENS in an Operating Round worked perfectly. Only a
// game PLAYED into one -- from the zero state, through a Stock Round -- hit
// the empty queue, and that is the one path no fixture exercises.
//
// So these tests start from the state the fixtures do not produce: floated
// corporations and NO queue. That is the precondition the bug needed, and
// asserting on it is what stops the next pass from reintroducing it by
// seeding a queue somewhere new and calling it fixed.
//
// THE TERMINATION TEST IS BOUNDED, NOT "RUN UNTIL IT STOPS". A test for an
// infinite loop cannot itself loop forever waiting to find out, so it
// dispatches a hard cap of turns and asserts the round ended well inside
// it. A regression would blow the cap rather than hang the suite.

import { applySandboxAction, beginOperatingRound, buildOperatingOrder } from "./sandboxSession";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";
const CAROL = "juno1carol";

function company(
  overrides: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
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
    ...overrides,
  };
}

/** A game that has just left a Stock Round: corporations floated, and the
 *  operating queue still empty because nothing had built it. */
function stateEnteringOperatingRound(
  companies: PublicCompanyState[] = [
    company({ company_id: 1, ticker: "PRR", par_value: "100", president: ALICE }),
    company({ company_id: 2, ticker: "NYC", par_value: "82", president: BOB }),
    company({ company_id: 8, ticker: "B&M", par_value: "90", president: CAROL }),
  ],
): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 4,
    player_addresses: [ALICE, BOB, CAROL],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    current_round_type: "OperatingRound",
    macro_round_number: 2,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
      { player: CAROL, cash_vgp: "400" },
    ],
    public_companies: companies,
    private_companies: [],
  };
}

const PASS = { PassTurn: { game_id: 1 } } as const;

describe("buildOperatingOrder", () => {
  it("orders floated corporations by market price, descending", () => {
    const state = stateEnteringOperatingRound();
    const order = buildOperatingOrder(state, (id) =>
      ({ 1: 67, 2: 112, 8: 90 })[id] ?? null,
    );
    expect(order).toEqual([2, 8, 1]);
  });

  it("falls back to par value when no market lookup is supplied", () => {
    // PRR 100, B&M 90, NYC 82 -- the par order, not the market one above.
    expect(buildOperatingOrder(stateEnteringOperatingRound())).toEqual([1, 8, 2]);
  });

  it("excludes unfloated corporations and ones with no president", () => {
    const order = buildOperatingOrder(
      stateEnteringOperatingRound([
        company({ company_id: 1, ticker: "PRR", par_value: "100" }),
        company({ company_id: 2, ticker: "NYC", par_value: "90", is_floated: false }),
        company({ company_id: 8, ticker: "B&M", par_value: "82", president: null }),
      ]),
    );
    expect(order).toEqual([1]);
  });

  it("is total and stable when prices tie", () => {
    const tied = stateEnteringOperatingRound([
      company({ company_id: 8, ticker: "B&M", par_value: "90" }),
      company({ company_id: 2, ticker: "NYC", par_value: "90" }),
      company({ company_id: 1, ticker: "PRR", par_value: "90" }),
    ]);
    expect(buildOperatingOrder(tied)).toEqual([1, 2, 8]);
  });
});

describe("beginOperatingRound", () => {
  it("builds the queue the Stock Round close used to leave empty", () => {
    const opened = beginOperatingRound(stateEnteringOperatingRound());
    expect(opened.active_operating_order.length).toBe(3);
    expect(opened.active_corporation_index).toBe(0);
  });

  it("seats the first corporation's president", () => {
    // PRR is first on par, and Alice presides over it. The incoming seat
    // pointer is Bob's (index 1) -- whoever happened to act last in the SR.
    const stale = { ...stateEnteringOperatingRound(), active_player_index: 1 };
    expect(beginOperatingRound(stale).active_player_index).toBe(0);
  });
});

describe("PassTurn during an Operating Round", () => {
  it("advances the corporation cursor", () => {
    const opened = beginOperatingRound(stateEnteringOperatingRound());
    const next = applySandboxAction(opened, PASS);
    expect(next.active_corporation_index).toBe(1);
  });

  it("advances the acting player alongside the corporation", () => {
    // The reported symptom was that NEITHER moved. Queue on par is
    // [PRR(Alice), B&M(Carol), NYC(Bob)], so the seat walks 0 -> 2 -> 1.
    const opened = beginOperatingRound(stateEnteringOperatingRound());
    expect(opened.active_player_index).toBe(0);
    const second = applySandboxAction(opened, PASS);
    expect(second.active_player_index).toBe(2);
    const third = applySandboxAction(second, PASS);
    expect(third.active_player_index).toBe(1);
  });

  it("recovers a round that somehow started with no queue at all", () => {
    // The exact reported state: round type set, queue empty. This returned
    // the state untouched, which is the infinite loop in one line.
    const stranded = stateEnteringOperatingRound();
    const next = applySandboxAction(stranded, PASS);
    expect(next).not.toBe(stranded);
    expect(next.active_operating_order.length).toBe(3);
  });

  it("ends the round after the last corporation, rather than wrapping", () => {
    let state = beginOperatingRound(stateEnteringOperatingRound());
    state = applySandboxAction(state, PASS); // -> 2nd
    state = applySandboxAction(state, PASS); // -> 3rd
    expect(state.operating_round_just_ended).toBeFalsy();
    state = applySandboxAction(state, PASS); // past the end
    expect(state.operating_round_just_ended).toBe(true);
  });

  /* ==================================================================
   *  UPDATED BY DESIGN NOTE 431: THE PHASE SETS THE COUNT
   * ==================================================================
   *
   * This test previously set `operating_round_sequence_length: 2` on the
   * state and asserted a second Operating Round ran. It passed, and it was
   * asserting the bug: nothing ever WROTE that field, so the fixtures'
   * hardcoded `2` made the Yellow phase -- which runs one Operating Round
   * -- run two, and the game never returned to the Stock Round.
   *
   * A test that supplies the number it then checks is only testing that the
   * number was read. The rule is that the count comes from the PHASE, so
   * the fixture now sets the TRAINS and lets it be derived: a 3-train is
   * Green, and Green runs two.
   *
   * Rewritten rather than deleted -- the behaviour it describes (a second
   * round runs when the sequence calls for one) is still correct and still
   * worth pinning. Only the mechanism that decides "calls for one" changed.
   * `operatingRoundPhaseLoop.test.ts` covers the counts themselves. */
  it("runs a second Operating Round when the PHASE calls for one", () => {
    const green = stateEnteringOperatingRound([
      company({ company_id: 1, ticker: "PRR", president: ALICE, owned_trains: ["3"] }),
      company({ company_id: 2, ticker: "NYC", par_value: "82", president: BOB }),
      company({ company_id: 8, ticker: "B&M", par_value: "90", president: CAROL }),
    ]);
    let state = beginOperatingRound({ ...green, sub_round_index: 1 });
    for (let i = 0; i < 3; i += 1) state = applySandboxAction(state, PASS);
    // The queue rebuilt for OR 2 rather than the round closing.
    expect(state.operating_round_just_ended).toBeFalsy();
    expect(state.sub_round_index).toBe(2);
    expect(state.active_corporation_index).toBe(0);
  });

  it("closes after ONE round when the phase is Yellow", () => {
    // The mirror of the case above, and the reported bug. Every corporation
    // here is trainless, which derives to the Yellow phase.
    let state = beginOperatingRound(stateEnteringOperatingRound());
    for (let i = 0; i < 3; i += 1) state = applySandboxAction(state, PASS);
    expect(state.operating_round_just_ended).toBe(true);
  });

  it("TERMINATES -- the regression that started all of this", () => {
    // Bounded so a reintroduced loop fails the test instead of hanging it.
    const CAP = 200;
    let state = beginOperatingRound(stateEnteringOperatingRound());
    let turns = 0;
    while (!state.operating_round_just_ended && turns < CAP) {
      state = applySandboxAction(state, PASS);
      turns += 1;
    }
    expect(state.operating_round_just_ended).toBe(true);
    // Three corporations, one round in the sequence: it should close on the
    // fourth dispatch, not merely somewhere under the cap.
    expect(turns).toBe(3);
  });

  it("ends immediately when nothing can operate", () => {
    // Nothing floated -> no queue is buildable -> the round is over rather
    // than stuck, which is the other way an empty queue could hang.
    const noneFloated = stateEnteringOperatingRound([
      company({ company_id: 1, ticker: "PRR", is_floated: false }),
    ]);
    expect(applySandboxAction(noneFloated, PASS).operating_round_just_ended).toBe(true);
  });
});
