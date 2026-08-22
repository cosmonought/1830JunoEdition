/** @jest-environment node */
//
// Ending a turn versus passing it, through the reducer. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 745 (harness): A TURN YOU SOLD IN IS NOT A PASS
// ==================================================================
//
// REPORTED: "it seems that the only way to avoid the 'Passed' designation (and thus the end of the Stock
// Round) is to buy a share ... a player who only sells but does not buy should not be labeled as 'Passed' --
// they took an action and therefore guaranteed themselves at least one more action opportunity in the SR."
//
// THE ASSERTIONS ARE ABOUT THE STREAK, NOT THE STAMP. `passedSeatIndices` derives the PASSED marks entirely
// from `consecutive_passes`, so a test that reached for the label would be testing a projection of the number
// this file already pins. The number is also the Stock Round's only termination condition, which is why the
// visible half of the report is the smaller half: a seller's turn counted as a pass could be the fourth pass
// at a four-player table and close the round on the turn of somebody who had just acted.
//
// THE CASE THAT DECIDES THE DESIGN IS `a later pass in the same round still counts`. #744's `sold_this_round`
// was sitting right there and would have passed every other test in this file -- it knows exactly who sold --
// but it lasts the whole round on purpose, so reusing it would mean a player who sold once could never pass
// again and the round could never end. Two facts, two lifetimes, two fields.

import { applySandboxAction } from "./sandboxSession";
import { hasActedThisTurn, passButtonLabel, passButtonTitle } from "./turnAction";
import { passedSeatIndices } from "./passedSeats";
import type { GameStateResponse } from "./gameState";

const SEATS = ["p0", "p1", "p2", "p3"];
const PRR = 1;

function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: SEATS,
    player_cash: SEATS.map((player) => ({ player, cash_vgp: "2000" })),
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 2,
    active_player_index: 0,
    consecutive_passes: 0,
    priority_deal_index: 0,
    last_trader_index: null,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        president: "p0",
        par_value: "100",
        ipo_pool_percentage: 20,
        bank_pool_percentage: 0,
        player_holdings: [
          { player: "p0", percentage: 60 },
          { player: "p1", percentage: 20 },
        ],
        station_token_hexes: [],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

const seatOf = (state: GameStateResponse) => state.player_addresses[state.active_player_index];

function sell(state: GameStateResponse, percentage = 10): GameStateResponse {
  return applySandboxAction(
    state,
    { SellStock: { game_id: 1, protocol_id: PRR, percentage } } as never,
    { actor: seatOf(state) },
  );
}

function pass(state: GameStateResponse): GameStateResponse {
  return applySandboxAction(state, { PassTurn: { game_id: 1 } } as never, { actor: seatOf(state) });
}

describe("selling and then finishing is not a pass", () => {
  it("leaves the streak at zero", () => {
    /* THE REPORT. The sale zeroed `consecutive_passes` correctly and the Pass put it straight back to one --
       both halves right, the seam between them wrong. */
    const after = pass(sell(board()));
    expect(after.consecutive_passes).toBe(0);
  });

  it("still moves the seat, because the turn IS over", () => {
    /* The other half of "end turn": a fix that merely stopped counting would have to leave the seat where it
       was, and the player could never finish. */
    expect(pass(sell(board())).active_player_index).toBe(1);
  });

  it("marks nobody as passed", () => {
    // The visible symptom, read through the same function the trail uses.
    const after = pass(sell(board()));
    const stamped = passedSeatIndices({
      seatCount: after.player_addresses.length,
      activeIndex: after.active_player_index,
      consecutivePasses: after.consecutive_passes,
    });
    expect(stamped.size).toBe(0);
  });

  it("counts a bare pass, which is the control", () => {
    /* Without this, a reducer that simply never counted passes would satisfy every assertion above -- and the
       Stock Round would run forever. */
    const after = pass(board());
    expect(after.consecutive_passes).toBe(1);
    expect(after.active_player_index).toBe(1);
  });
});

describe("the round does not end on a seller's turn", () => {
  it("gives the seller another opportunity", () => {
    /* THE RULE UNDERNEATH THE REPORT, spelled out: four seats, one of whom acts. Before #745 that was four
       consecutive passes and the round closed; the player who had just sold never got the turn the rulebook
       guarantees them. */
    let state = pass(sell(board())); // p0 sells, ends turn
    state = pass(state); // p1
    state = pass(state); // p2
    state = pass(state); // p3
    expect(state.consecutive_passes).toBe(3);
    expect(state.current_round_type).toBe("StockRound");
    expect(seatOf(state)).toBe("p0");
  });

  it("still ends after a full lap of genuine passes", () => {
    /* The termination condition must survive the fix. A rule that made rounds unclosable would be the worse
       bug, and it is the one this change is closest to.
       READ AS THE ROUND TYPE, not as `stock_round_just_ended`: the same reducer call that raises the flag
       consumes it and opens the Operating Round, so the flag is never visible from outside. */
    let state = board();
    for (let i = 0; i < SEATS.length; i += 1) state = pass(state);
    expect(state.current_round_type).toBe("OperatingRound");
  });

  it("ends one lap later when somebody sold, not never", () => {
    let state = pass(sell(board()));
    for (let i = 0; i < SEATS.length; i += 1) state = pass(state);
    expect(state.current_round_type).toBe("OperatingRound");
  });
});

describe("the flag belongs to the turn, not to the round", () => {
  it("a later pass in the same round still counts", () => {
    /* THE CASE THAT RULES OUT REUSING #744's RECORD. `sold_this_round` remembers p0 sold PRR for the rest of
       the round -- that is what makes the buy-back lockout work -- so asking it here would exempt every one
       of p0's remaining turns from the pass count, and the round could not reach its own ending. */
    let state = pass(sell(board())); // p0 sells and ends: not a pass
    state = pass(pass(pass(state))); // p1, p2, p3 pass
    expect(state.sold_this_round?.p0).toEqual([PRR]);
    expect(hasActedThisTurn(state)).toBe(false);

    const p0Again = pass(state); // p0 now genuinely passes
    /* It counted: the fourth consecutive pass at a four-seat table closes the round, which the reducer turns
       straight into the Operating Round. Had the flag been sticky, p0's pass would have been exempt and the
       Stock Round would still be open with nobody left who could end it. */
    expect(p0Again.current_round_type).toBe("OperatingRound");
  });

  it("is false again the moment the seat moves", () => {
    expect(hasActedThisTurn(sell(board()))).toBe(true);
    expect(hasActedThisTurn(pass(sell(board())))).toBe(false);
  });

  it("is cleared by a pass as well as by an end-turn", () => {
    /* Both seat-moving functions clear it, so the invariant holds no matter which arm a future message picks.
       Asserted rather than left to the two one-line comments that say so. */
    expect(hasActedThisTurn(pass(board()))).toBe(false);
  });

  it("survives a second sale in the same turn", () => {
    // A player may sell several shares before deciding whether to buy; each sale re-states the same fact.
    const twice = sell(sell(board()));
    expect(hasActedThisTurn(twice)).toBe(true);
    expect(pass(twice).consecutive_passes).toBe(0);
  });

  it("is cleared when a Stock Round opens", () => {
    /* The opening moves the seat to the Priority Deal holder WITHOUT going through either seat-moving
       function, so it needs its own clear. A stale `true` would let that player's opening pass slip out of
       the count -- the same un-endable round as above, arrived at from the other side. */
    const opened = applySandboxAction(
      board({ turn_action_taken: true, operating_round_just_ended: true } as never),
      { PassTurn: { game_id: 1 } } as never,
      { actor: "p0" },
    );
    expect(opened.current_round_type).toBe("StockRound");
    expect(hasActedThisTurn(opened)).toBe(false);
  });
});

describe("buying keeps working the way it did", () => {
  it("does not count as a pass either", () => {
    /* Never broken -- a buy ends the turn itself, through `advanceSeat`, which is precisely why the bug was
       invisible to anyone who bought. Kept because #745 edited `advanceSeat`. */
    const bought = applySandboxAction(
      board(),
      { BuyStock: { game_id: 1, protocol_id: PRR, source: "IPO", par_value: "100" } } as never,
      { actor: "p0" },
    );
    expect(bought.consecutive_passes).toBe(0);
    expect(bought.active_player_index).toBe(1);
    expect(hasActedThisTurn(bought)).toBe(false);
  });
});

describe("an Operating Round is untouched", () => {
  it("routes Pass to the corporation queue, not to either seat function", () => {
    /* #478's distinction, which #745 had to reach past: in an OR, Pass ends a CORPORATION's turn from a step.
       The new branch sits inside the seat-driven half only. */
    const or = board({
      current_round_type: "OperatingRound",
      active_operating_order: [PRR],
      active_corporation_index: 0,
      sub_round_index: 1,
      operating_round_sequence_length: 1,
    } as never);
    const after = applySandboxAction(or, { PassTurn: { game_id: 1 } } as never, { actor: "p0" });
    expect(after.consecutive_passes).toBe(or.consecutive_passes);
  });
});

describe("the button says which one it is", () => {
  it("names the decision that is left, not just the end of the turn", () => {
    /* Why a label change ships with a reducer fix: the player who found this had no way to tell that pressing
       the button marked "Pass Turn" would not forfeit their turn. The rule is invisible until it is named.
       "Skip Buy Share" over "End Turn" because 1830's sell-then-buy ordering means a player who has sold is
       standing at exactly one remaining decision, so the label can name it rather than describe the clock. */
    expect(passButtonLabel(true)).toBe("Skip Buy Share");
    expect(passButtonTitle(true)).toMatch(/does not count as a pass/);
  });

  it("reads Pass Turn when neither half has been taken", () => {
    expect(passButtonLabel(false)).toBe("Pass Turn");
    expect(passButtonTitle(false)).toMatch(/Pass/);
  });

  it("gives the two states different words", () => {
    // A label pair that collapsed would leave the reducer's distinction with no surface at all.
    expect(passButtonLabel(true)).not.toBe(passButtonLabel(false));
  });
});

describe("the surfaces ask the rule module", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes quote the old wording in the past tense and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("leaves no hardcoded label on the bar", () => {
    /* The structural half. A caption that agrees today because somebody typed the same words twice is the
       shape of bug this project keeps finding -- #723, #736, #712 -- so the bar renders the function. */
    const bar = read("panels/ContextualActionBar.tsx");
    expect(bar).toContain("passButtonLabel(turnActionTaken === true)");
    expect(bar).not.toMatch(/>\s*Pass Turn\s*</);
  });

  it("feeds the bar from replayed state", () => {
    // #400/#685: the reducer settles, the shell narrates. An Undo past the sale takes the label back with it.
    expect(read("App.tsx")).toContain("turnActionTaken={gameState?.turn_action_taken === true}");
  });

  it("narrates the difference in the Activity Log", () => {
    expect(read("utils/actionLog.ts")).toContain("ended the turn.");
    expect(read("utils/actionLog.ts")).toContain("passed the turn.");
  });
});
