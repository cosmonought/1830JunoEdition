/** @jest-environment node */
//
// The dividend sentence says what happened. It does not predict, and it does not do the arithmetic twice.
//
// ==================================================================
//  DESIGN NOTE 775 (harness): THE NARRATION WAS A SECOND OPINION
// ==================================================================
//
// TWO REPORTS, ONE CAUSE.
//
//   (1) "The Market Move log is the correct movement for the corporation's share price, the doubled Withhold
//       logs report the incorrect second movement."
//   (2) "the toast notification for payouts is reporting a doubled amount (that isn't actually being paid,
//       only half, the correct amount)."
//
// THE CORRECTION IN (1) IS WHAT MADE THIS SOLVABLE, and it is worth recording that I had the diagnosis
// pointed the wrong way first: I read the pair of figures as a race between two copies of the market and
// proposed instrumenting it. The report said plainly which line was right, and once the Market Move line is
// the true one the arithmetic is obvious -- `$82 -> $76` happened, and the sentence's `$76 -> $71` is that
// same step applied a second time to its own result.
//
// SO THE TESTS ARE ABOUT ABSENCE, mostly, which is an awkward thing to pin: they assert the sentence does
// NOT contain a price, and that the projection callback is gone from both the type and the shell. An absence
// is easy to reintroduce by accident, which is exactly why it is worth a test.
//
// AND ONE CALCULATION FOR (2): `dividendSplit` is called by the reducer to MOVE the money and by the
// narration to DESCRIBE it, so a doubled notice is no longer expressible.

import { applySandboxAction } from "./sandboxSession";
import { describeGameplayAction } from "./actionLog";
import { dividendSplit, dividendRevenue } from "./dividendSplit";
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const CO = 3;

function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Dividends",
    macro_round_number: 2,
    sub_round_index: 0,
    active_player_index: 0,
    active_operating_order: [CO],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: CO,
        ticker: "C&O",
        is_floated: true,
        president: "p1",
        par_value: "82",
        home_hex_label: "F16",
        ipo_pool_percentage: 20,
        bank_pool_percentage: 10,
        treasury: "300",
        last_route_revenue: "0",
        player_holdings: [
          { player: "p1", percentage: 60 },
          { player: "p2", percentage: 10 },
        ],
        station_token_hexes: [[0, 0]],
        owned_trains: ["2"],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

const declare = (revenue: string, distribute: boolean) =>
  ({
    DeclareDividends: { game_id: 1, protocol_id: CO, revenue_amount: revenue, distribute },
  }) as never;

const context = (state: GameStateResponse) => ({
  gameState: state,
  mapGrid: { game_id: 1, tiles: [] } as unknown as MapGridResponse,
  era: "Yellow" as const,
  labelForAddress: (address: string) => address,
  marketPrices: { [CO]: 82 } as Record<number, number>,
});

describe("the sentence no longer predicts a price", () => {
  it("says nothing about the price on a withhold", () => {
    /* THE REPORT. The old line read the CURRENT price -- already stepped by the market atom -- and projected
       the step again, so it named a cell the token never reached. */
    /* ==================================================================
        DESIGN NOTE 1054: THE SENTENCE CHANGED; WHAT THIS CASE FORBIDS DID NOT
       ==================================================================
       THIS PINNED "C&O withheld $0 into its treasury." Two things moved it. Reported: "players do not select
       'Withhold $0,' so saying that their corporation did is potentially confusing" -- so a $0 withhold now
       says what actually happened, that no routes were run. And the price move now JOINS this sentence
       instead of getting a line of its own, because the atom's figures are handed in.
       WHAT THIS CASE IS FOR IS UNCHANGED AND IS THE SECOND ASSERTION: the sentence must not PROJECT a price.
       #775's bug was a branch that read the current price and stepped it again, naming a cell the token never
       reached. A clause built from `context.marketMove` is the opposite of that -- it is the atom's report --
       and with no move handed in there is no clause at all, which is what this fixture exercises. */
    const line = describeGameplayAction(declare("0", false), context(board()) as never);
    expect(line).toBe("C&O did not run any routes.");
    expect(line).not.toMatch(/Share price/);
  });

  it("carries the atom's move when it is handed one, and never computes its own", () => {
    /* THE OTHER HALF OF #775, ASSERTED RATHER THAN ASSUMED. The clause is allowed to exist now, so the case
       that it uses the AUTHORITY's figures has to exist too -- otherwise "no projection" is satisfied by a
       branch that quietly started projecting again with different words. Handed 100 -> 90, it must say 100
       and 90 and nothing else. */
    const withMove = describeGameplayAction(declare("0", false), {
      ...(context(board()) as unknown as Record<string, unknown>),
      marketMove: { from: 100, to: 90, reason: "withhold" },
    } as never);
    expect(withMove).toBe("C&O did not run any routes. Its share price fell from $100 to $90.");
  });

  it("says nothing about the price on a payout", () => {
    const line = describeGameplayAction(declare("100", true), context(board()) as never);
    expect(line).not.toMatch(/Share price/);
  });

  it("never names a second cell", () => {
    /* The specific shape of the bug: two dollar figures in one price clause, the second of which is a
       prediction. Guarded across both choices and a clamped edge case. */
    for (const msg of [declare("0", false), declare("100", true), declare("7", true)]) {
      expect(describeGameplayAction(msg, context(board()) as never)).not.toMatch(/\$\d+ to \$\d+/);
    }
  });

  it("has no projection callback left to call", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const strip = (raw: string) =>
      raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // #490a: both files explain the removal in prose and must keep doing so.
    expect(strip(fs.readFileSync(path.join(__dirname, "actionLog.ts"), "utf8"))).not.toContain(
      "projectPrice",
    );
    expect(strip(fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8"))).not.toContain(
      "projectPrice",
    );
  });

  it("leaves Market Move as the one price reporter", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    // #435's line, built from the atom's own `moved` result -- the one the report confirmed correct.
    expect(app).toContain('logInfo("Market Move"');
    expect(app).toContain("marketResult.moved");
  });
});

describe("the sentence and the money come from one calculation", () => {
  it("quotes exactly what each shareholder is paid", () => {
    /* THE SECOND REPORT: a payout notice showing double the cash that moved. $100 on 60/10 holdings is $60
       and $10, and the sentence now reads those out of the same value the reducer spends. */
    const before = board();
    const after = applySandboxAction(before, declare("100", true));
    const line = describeGameplayAction(declare("100", true), context(before) as never);

    const paid = (state: GameStateResponse, player: string) =>
      Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp);
    expect(paid(after, "p1") - paid(before, "p1")).toBe(60);
    expect(paid(after, "p2") - paid(before, "p2")).toBe(10);
    expect(line).toContain("$60 to p1");
    expect(line).toContain("$10 to p2");
  });

  it("agrees with the reducer for every holding shape", () => {
    /* THE PROPERTY, rather than one fixture: whatever the split, the sentence's figures are the cash deltas.
       A doubled notice is not expressible while this holds. */
    for (const [a, b] of [
      [60, 10],
      [50, 50],
      [20, 0],
      [30, 40],
    ]) {
      const before = board({
        public_companies: [
          {
            ...(board().public_companies[0] as object),
            player_holdings: [
              { player: "p1", percentage: a },
              { player: "p2", percentage: b },
            ],
          },
        ],
      } as Partial<GameStateResponse>);
      const after = applySandboxAction(before, declare("100", true));
      const split = dividendSplit(before, CO, "100", true)!;
      for (const share of split.players) {
        const moved =
          Number(after.player_cash.find((e) => e.player === share.player)?.cash_vgp) -
          Number(before.player_cash.find((e) => e.player === share.player)?.cash_vgp);
        expect(moved).toBe(share.amount);
      }
    }
  });

  it("pays the Bank Pool's slice to the treasury, not to a player", () => {
    // #706, preserved through the move: 10% in the pool on $100 is $10 to the corporation.
    const split = dividendSplit(board(), CO, "100", true)!;
    expect(split.poolSlice).toBe(10);
    expect(split.totalPaid).toBe(80);
    expect(split.players.some((share) => share.player === "pool")).toBe(false);
  });

  it("pays nothing for unsold IPO shares", () => {
    /* 20% sits in the IPO here. $100 declared, $70 to players, $10 to the treasury, and the missing $20 is
       the IPO's -- which pays nobody. */
    const split = dividendSplit(board(), CO, "100", true)!;
    expect(split.totalPaid).toBe(80);
  });

  it("rounds the per-share figure half up", () => {
    /* ==================================================================
        SUPERSEDED BY DESIGN NOTE 922, AND THE OLD RULE IS RECORDED HERE
       ==================================================================
       THIS CASE USED TO ASSERT 9, with the reasoning: "$97 is $9 a certificate, not $9.70: 1830 pays whole
       units and a corporation cannot overpay its run."
       #922 REPLACED THE FLOOR WITH ROUND-HALF-UP on the instruction "Do not use floating-point math. Use pure
       integer arithmetic: `Math.floor((revenue * percent_owned + 50) / 100)`", and `dividendSplit` applies
       that one expression to every holder including the 10% certificate. $97 therefore pays $10.
       AND THE OLD REASONING HAS A SURVIVING POINT WORTH FLAGGING RATHER THAN BURYING: ten shares at $10 is
       $100 against a $97 run, so a corporation CAN now pay out marginally more than it earned. That is a
       rules decision, not an arithmetic one, and it was not what the rounding instruction was asked about --
       it was asked about a player's percentage share under the revenue variant. Pinned at the CURRENT
       behaviour so the suite is honest about what the code does, and raised in the report so the choice is
       made deliberately rather than inherited from a helper's reuse. */
    expect(dividendSplit(board(), CO, "97", true)!.perShare).toBe(10);
  });
});

describe("the revenue rule survived the move", () => {
  it("honours an explicit zero", () => {
    /* #752's bug, re-pinned because its fix now lives somewhere else: a declared "0" is a FIGURE. Reading
       `last_route_revenue` instead paid $1000 into a trainless corporation for a run that never happened. */
    const withTrain = { last_route_revenue: "1000", owned_trains: ["2"] };
    expect(dividendRevenue(withTrain as never, "0")).toBe(0);
  });

  it("falls back only when the figure is genuinely absent", () => {
    const withTrain = { last_route_revenue: "120", owned_trains: ["2"] };
    expect(dividendRevenue(withTrain as never, undefined)).toBe(120);
    expect(dividendRevenue(withTrain as never, "")).toBe(120);
  });

  it("pays a trainless corporation nothing even on the fallback", () => {
    // The belt to #752: a stored figure on a trainless corporation describes an earlier Operating Round.
    const noTrain = { last_route_revenue: "1000", owned_trains: [] };
    expect(dividendRevenue(noTrain as never, undefined)).toBe(0);
  });

  it("never returns a negative", () => {
    expect(dividendRevenue({ last_route_revenue: "0", owned_trains: [] } as never, "-50")).toBe(0);
  });

  it("declines to settle when there is nothing to settle", () => {
    expect(dividendSplit(board(), CO, "0", true)).toBeNull();
    expect(dividendSplit(board(), 999, "100", true)).toBeNull();
    expect(dividendSplit(null, CO, "100", true)).toBeNull();
  });

  it("reports a withhold as the whole figure to the treasury", () => {
    const split = dividendSplit(board(), CO, "100", false)!;
    expect(split).toMatchObject({ distributed: false, totalPaid: 100, players: [] });
  });
});
