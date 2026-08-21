// frontend/src/utils/privateRevenue.test.ts
//
// ==================================================================
//  DESIGN NOTE 685 (harness): THE PRIVATES ARE PAID BY THE REDUCER
// ==================================================================
//
// REPORTED as a regression: "the Private Companies are supposed to pay out
// their income every Operating Round, and in previous playthroughs they have,
// but in my latest playthrough they did not."
//
// THE PAYOUT HAD NO TEST AT ALL. `applyPrivateRevenue` was pure and correct and
// nothing ever called it in a test, so what broke was not the arithmetic but
// the TRIGGER -- a React effect in the shell watching `current_round_type` for
// an edge against a ref that `rebuildSandbox` does not reset. After a rebuild
// the ref still read "OperatingRound" while the replay ended in one: no edge,
// no payout, no error.
//
// #668 is what surfaced it. Replacing the drain's length check with a prefix
// check rebuilds correctly in cases the old one missed, and every one of those
// newly-correct rebuilds silently skipped a round of private income. The bug
// was always there; it just needed rebuilds to be common enough to notice.
//
// SO THIS TESTS THE TRIGGER, THROUGH THE REDUCER. Not "does applyPrivateRevenue
// add up" -- that was never in doubt -- but "does a game that reaches an
// Operating Round have the money in it". The distinction is the whole lesson:
// a pure function nobody calls passes every test you write for it.

import { applyPrivateRevenue, applySandboxAction, beginOperatingRound } from "./sandboxSession";
import type { GameStateResponse, PrivateCompanyState, PublicCompanyState } from "./gameState";

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
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  };
}

function priv(
  over: Partial<PrivateCompanyState> & Pick<PrivateCompanyState, "private_id" | "name">,
): PrivateCompanyState {
  return {
    cost: "20",
    revenue_per_or: "5",
    owner: null,
    owner_protocol_id: null,
    closed: false,
    ...over,
  };
}

/** A Stock Round one PassTurn away from closing, with privates on the table.
 *  Built at the point the reported bug lives: the transition INTO an Operating
 *  Round, which is the only moment 1830 pays private income. */
function stockRoundHandover(privates: readonly PrivateCompanyState[]): GameStateResponse {
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
    // One more pass closes the round -- two seats, one pass already recorded.
    consecutive_passes: 1,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    current_round_type: "StockRound",
    macro_round_number: 2,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
    ],
    public_companies: [
      company({ company_id: 4, ticker: "B&O" }),
      company({ company_id: 1, ticker: "PRR", president: BOB }),
    ],
    private_companies: [...privates],
  };
}

const cashOf = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((row) => row.player === player)?.cash_vgp ?? NaN);
const treasuryOf = (state: GameStateResponse, companyId: number) =>
  Number(state.public_companies.find((c) => c.company_id === companyId)?.treasury ?? NaN);

const PASS = { PassTurn: { game_id: 1 } } as const;

describe("opening an Operating Round pays the privates", () => {
  it("credits a player who owns one", () => {
    /* THE REPORTED BUG, as a sequence rather than a function call. The Stock
       Round closes, the reducer opens an Operating Round, and the money has to
       be there when it does. */
    const before = stockRoundHandover([
      priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, revenue_per_or: "5" }),
    ]);
    const after = applySandboxAction(before, PASS);
    expect(after.current_round_type).toBe("OperatingRound");
    expect(cashOf(after, ALICE)).toBe(cashOf(before, ALICE) + 5);
  });

  it("credits a corporation that bought one", () => {
    // Design note #379: a corporation really can own a private, and the
    // revenue goes to its treasury rather than to its president.
    const before = stockRoundHandover([
      priv({
        private_id: 3,
        name: "Delaware & Hudson",
        owner_protocol_id: 4,
        revenue_per_or: "15",
      }),
    ]);
    const after = applySandboxAction(before, PASS);
    expect(treasuryOf(after, 4)).toBe(treasuryOf(before, 4) + 15);
  });

  it("pays every open private in one transition", () => {
    const before = stockRoundHandover([
      priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, revenue_per_or: "5" }),
      priv({ private_id: 2, name: "Champlain & St Lawrence", owner: BOB, revenue_per_or: "10" }),
    ]);
    const after = applySandboxAction(before, PASS);
    expect(cashOf(after, ALICE)).toBe(cashOf(before, ALICE) + 5);
    expect(cashOf(after, BOB)).toBe(cashOf(before, BOB) + 10);
  });

  it("pays nothing for a CLOSED private", () => {
    const before = stockRoundHandover([
      priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, closed: true }),
    ]);
    const after = applySandboxAction(before, PASS);
    expect(cashOf(after, ALICE)).toBe(cashOf(before, ALICE));
  });

  it("pays nothing for an UNSOLD private", () => {
    // Still in the auction, owned by nobody. There is no one to pay.
    const before = stockRoundHandover([priv({ private_id: 1, name: "Schuylkill Valley" })]);
    const after = applySandboxAction(before, PASS);
    expect(cashOf(after, ALICE)).toBe(cashOf(before, ALICE));
    expect(after.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
  });

  it("takes the money from the bank", () => {
    // Design note #329: the bank funds it, in one write for the sum.
    const before = stockRoundHandover([
      priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, revenue_per_or: "5" }),
      priv({ private_id: 2, name: "Champlain & St Lawrence", owner: BOB, revenue_per_or: "10" }),
    ]);
    const after = applySandboxAction(before, PASS);
    expect(Number(after.virtual_bank_vgp)).toBe(Number(before.virtual_bank_vgp) - 15);
  });
});

describe("it pays ONCE, on the transition", () => {
  it("does not pay again on an ordinary Operating Round action", () => {
    /* The failure the old shell trigger was written to avoid, restated against
       the new home: `settleRoundTransitions` only fires on the edge, so a turn
       taken inside the round must move no private money. */
    const opened = applySandboxAction(
      stockRoundHandover([
        priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, revenue_per_or: "5" }),
      ]),
      PASS,
    );
    expect(opened.current_round_type).toBe("OperatingRound");
    const paidOnce = cashOf(opened, ALICE);

    // A corporation ends its turn inside the round.
    const later = applySandboxAction(opened, PASS);
    expect(cashOf(later, ALICE)).toBe(paidOnce);
  });

  it("is not paid by beginOperatingRound on its own", () => {
    /* `beginOperatingRound` builds the queue and is called from places that are
       NOT a round transition -- the harnesses above do it directly. Paying
       inside it would bill the bank every time somebody rebuilt a queue. */
    const before = stockRoundHandover([
      priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, revenue_per_or: "5" }),
    ]);
    const opened = beginOperatingRound(before);
    expect(cashOf(opened, ALICE)).toBe(cashOf(before, ALICE));
  });
});

describe("a replay reproduces the payout", () => {
  it("lands on the same figures when the same actions are applied twice", () => {
    /* WHY THE PAYOUT MOVED. In the shell it was a React effect keyed on a ref
       that a rebuild does not reset, so a client that replayed its history got
       a different board from one that did not -- money moving outside the log
       is the divergence class the action log itself was hardened against.
       In the reducer it is a function of the state, so replaying is replaying. */
    const start = stockRoundHandover([
      priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, revenue_per_or: "5" }),
      priv({ private_id: 3, name: "Delaware & Hudson", owner_protocol_id: 4, revenue_per_or: "15" }),
    ]);
    const live = applySandboxAction(start, PASS);
    const replayed = applySandboxAction(start, PASS);
    expect(cashOf(replayed, ALICE)).toBe(cashOf(live, ALICE));
    expect(treasuryOf(replayed, 4)).toBe(treasuryOf(live, 4));
    expect(replayed.virtual_bank_vgp).toBe(live.virtual_bank_vgp);
  });
});

describe("the log line agrees with the money", () => {
  it("reports the same payouts the reducer paid", () => {
    /* App.tsx re-derives the log lines by calling `applyPrivateRevenue(before)`
       for its `payouts` list WITHOUT taking its `state`. That is only honest if
       the list matches what the transition actually paid -- asserted here
       rather than trusted, because the two could drift silently and the only
       symptom would be a log that quietly understates somebody's income. */
    const before = stockRoundHandover([
      priv({ private_id: 1, name: "Schuylkill Valley", owner: ALICE, revenue_per_or: "5" }),
      priv({ private_id: 3, name: "Delaware & Hudson", owner_protocol_id: 4, revenue_per_or: "15" }),
      priv({ private_id: 2, name: "Champlain & St Lawrence", closed: true, owner: BOB }),
    ]);
    const after = applySandboxAction(before, PASS);

    const reported = applyPrivateRevenue(before)?.payouts ?? [];
    const reportedTotal = reported.reduce((sum, payout) => sum + payout.amount, 0);
    const bankPaid = Number(before.virtual_bank_vgp) - Number(after.virtual_bank_vgp);

    expect(reportedTotal).toBe(bankPaid);
    expect(reported.map((p) => p.privateId).sort()).toEqual([1, 3]);
  });
});
