/** @jest-environment node */
//
// A declared zero is a figure. Through the reducer. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 752 (harness): WHERE THE $1000 CAME FROM
// ==================================================================
//
// REPORTED: "a corporation's trains rusted with $500 in its treasury and the cheapest next train was $630. On
// its turn it laid track and then was auto-skipped to Buy Trains, where it miraculously suddenly had $1500 to
// make the purchase. This amount did not come from the player's cash."
//
// I GUESSED RE-CAPITALISATION AND WAS WRONG. REPORTED BACK: "it definitely isn't recapitalization: the
// company was pared at 72." $72 x 10 is $720, not $1000 -- one multiplication, and the theory was gone. That
// is the third mechanism I have supplied this session that fit a symptom and was false, and the thing that
// finally found it was arithmetic on a number the user supplied rather than any amount of further reading.
//
// THE WRITER IS THE DIVIDEND ARM'S FALLBACK. `stated > 0` treated a DECLARED ZERO as "no figure given" and
// reached for `last_route_revenue` -- the corporation's takings from the last Operating Round it actually
// ran, before the rust. A withhold credits the treasury, so the bank paid $1000 for a run that did not
// happen.
//
// AND #486 HAD ALREADY FIXED THIS ONCE, in the shell. Its opening sentence is the bug verbatim: "a PREVIOUS
// turn's figure for a corporation that skipped Routes, so a forced $0 withhold could move real money for a
// run that did not happen." The reducer's fallback reinstated it for every client that replays the log.
// A rule corrected at one surface and left standing in the authority -- the same shape as #712, #723, #736
// and #748, and the reason this file tests through `applySandboxAction` rather than through the helper.

import { applySandboxAction } from "./sandboxSession";
import type { GameStateResponse } from "./gameState";

const PRR = 1;

function board(over: Record<string, unknown> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "300" },
      { player: "p2", cash_vgp: "300" },
    ],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 4,
    active_player_index: 0,
    active_operating_order: [PRR],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: "p1",
        par_value: "72",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        total_shares_issued: 10,
        treasury: "500",
        // The rust already happened: no trains, and a stale figure from the OR before.
        owned_trains: [],
        last_route_revenue: "1000",
        player_holdings: [
          { player: "p1", percentage: 60 },
          { player: "p2", percentage: 40 },
        ],
        station_token_hexes: [],
        ...over,
      },
    ],
  } as unknown as GameStateResponse;
}

const declare = (
  state: GameStateResponse,
  revenue_amount: string | undefined,
  distribute = false,
) =>
  applySandboxAction(
    state,
    { DeclareDividends: { game_id: 1, protocol_id: PRR, revenue_amount, distribute } } as never,
    { actor: "p1" },
  );

const treasury = (state: GameStateResponse) => Number(state.public_companies[0].treasury);

describe("the reported board", () => {
  it("keeps its $500 through the forced zero withhold", () => {
    /* THE REPORT, as one assertion. Before #752 this returned 1500 -- $500 plus a thousand dollars of a run
       that happened two Operating Rounds ago, paid out by the bank. */
    expect(treasury(declare(board(), "0"))).toBe(500);
  });

  it("does not pay the shareholders either", () => {
    /* The same fallback fed the PAY branch, so a forced declaration could have split last turn's revenue ten
       ways. Worth pinning: the withhold is what the auto-skip declares, but nothing stops a president
       pressing Pay on a corporation with a stale figure. */
    const paid = declare(board(), "0", true);
    const cash = paid.player_cash.find((entry) => entry.player === "p1");
    expect(Number(cash?.cash_vgp)).toBe(300);
  });

  it("does not move the bank", () => {
    // The money came from somewhere: a withhold debits the bank to credit the treasury.
    expect(Number(declare(board(), "0").virtual_bank_vgp)).toBe(10000);
  });
});

describe("a real declaration still works", () => {
  it("withholds what the message states", () => {
    const running = board({ owned_trains: ["4"], last_route_revenue: "260" });
    expect(treasury(declare(running, "260"))).toBe(760);
  });

  it("pays what the message states", () => {
    const running = board({ owned_trains: ["4"], last_route_revenue: "260" });
    const paid = declare(running, "260", true);
    // 60% of $26 per share.
    const cash = paid.player_cash.find((entry) => entry.player === "p1");
    expect(Number(cash?.cash_vgp)).toBe(300 + 26 * 6);
  });
});

describe("absent is not zero", () => {
  it("still falls back for a message that carries no figure", () => {
    /* THE REASON THE FALLBACK SURVIVES. A message written before `revenue_amount` was carried has no figure
       at all, and reading those as zero would silently cancel real dividends on replay. What changed is that
       an explicit "0" is now a figure rather than a missing one. */
    const running = board({ owned_trains: ["4"], last_route_revenue: "260" });
    expect(treasury(declare(running, undefined))).toBe(760);
  });

  it("refuses the fallback for a corporation with no trains", () => {
    /* THE BELT. Even where the fallback is legitimately reached, a corporation that owns no trains cannot
       have run this turn, so its stored figure is a fact about an earlier Operating Round. This is what makes
       the stale value harmless rather than merely unreachable by one path. */
    expect(treasury(declare(board(), undefined))).toBe(500);
  });

  it("treats an empty string as no figure, not as zero", () => {
    const running = board({ owned_trains: ["4"], last_route_revenue: "260" });
    expect(treasury(declare(running, ""))).toBe(760);
  });
});

describe("the shell and the reducer agree about a skipped Routes step", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the note quotes the old condition and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("no longer discards a declared zero", () => {
    /* THE STRUCTURAL HALF. Every behavioural test above passes against a build that simply moved the
       fallback somewhere else; this one is about the condition that caused it. */
    expect(read("utils/sandboxSession.ts")).not.toMatch(
      /Number\.isFinite\(stated\) && stated > 0/,
    );
  });

  it("still computes the zero in the shell, which was never wrong", () => {
    // #484/#486: `dividendDeclaration` exists precisely to say $0 for a corporation that skipped Routes.
    expect(read("App.tsx")).toContain("skippedRoutes: skippedRoutesThisTurn");
  });
});
