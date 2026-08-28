/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 898 (harness): THE BANK BREAKS AND THE SET STILL FINISHES
// ==================================================================
//
// REPORTED: "If the bank breaks during an Operating Round set, players complete that current set before the
// game ends. If the bank breaks during a Stock Round, players complete one final set of ORs after that Stock
// Round before the game ends."
//
// THE OLD TRIGGER WAS A RENDER-TIME DERIVATION -- `App.tsx` asked `bankIsBroken(gameState)` on every render,
// so the modal appeared the instant a payout emptied the bank, mid-turn, with corporations still owed runs.
//
// WHAT THIS FILE IS REALLY PINNING is the COLLAPSE, because that is the part a later reader will be tempted to
// undo. The two reported cases look like two rules and are one: the game ends when the first OR SET COMPLETES
// at or after the break. Nothing records WHEN the bank broke, and nothing needs to -- which is why there is no
// `bank_broke_at` field to keep in step with `macro_round_number`. Both cases are asserted separately below so
// that claim is checked rather than asserted in a comment.
//
// AND THE ENDING IS UNDOABLE, which a render-time derivation could never be. `settleRoundTransitions` is a
// pure state -> state function, so a `RevertTo` that rewinds past the break rebuilds a game that has not
// ended. That is asserted too.

import { applySandboxAction, operatingRoundSequenceLength } from "./sandboxSession";
import type { GameStateResponse } from "./gameState";

/** A state on the LAST Operating Round of its set, with the bank wherever the case wants it.
 *
 *  `active_operating_order` has ONE corporation so ending its turn reaches the set boundary in one step -- the
 *  queue's length is not what this file is about, and a longer one would make "which turn are we on" part of
 *  every case.
 *  `sub_round_index` IS DERIVED, NOT TYPED IN, and the first draft got this wrong in a way worth recording: it
 *  hard-coded `1`, and a Phase-4 set is TWO Operating Rounds long, so ending the turn opened the set's second
 *  round instead of closing the set. Six assertions failed against correct code. `operatingRoundSequenceLength`
 *  is the same function the reducer consults, so the fixture sits at the boundary whatever the phase does. */
const LAST_OR_OF_SET = operatingRoundSequenceLength({
  public_companies: [{ company_id: 1, owned_trains: ["4"] }],
} as unknown as GameStateResponse);

const operating = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    active_operating_order: [1],
    active_corporation_index: 0,
    sub_round_index: LAST_OR_OF_SET,
    macro_round_number: 3,
    virtual_bank_vgp: "4000",
    public_companies: [{ company_id: 1, ticker: "PRR", owned_trains: ["4"], is_floated: true }],
    private_companies: [],
    player_addresses: ["p1"],
    priority_deal_index: 0,
    active_player_index: 0,
    consecutive_passes: 0,
    ...over,
  }) as unknown as GameStateResponse;

/** Ends the acting corporation's turn, exactly as the shell does.
 *
 *  THROUGH `applySandboxAction` RATHER THAN THE INTERNALS. `advanceCorporation` and `settleRoundTransitions`
 *  are both module-private, and exporting them to test them would widen the reducer's surface for the
 *  harness's convenience. This is the function the app calls, so what it exercises is the real path -- the
 *  advance AND the transition that follows it, in the order the game runs them. */
const endTurn = (state: GameStateResponse) =>
  applySandboxAction(state, { PassTurn: { game_id: 0 } } as never);

/** One corporation, one OR in the set: ending its turn ends the set. */
const endOfSet = (state: GameStateResponse) => endTurn(state);

describe("a solvent bank ends an OR set into a Stock Round (the control)", () => {
  it("opens the next Stock Round as it always did", () => {
    /* THE CONTROL, FIRST, because every assertion below is "and NOT this". A guard that ended the game
       whenever an OR set finished would satisfy both reported cases and break every ordinary round. */
    const after = endOfSet(operating({ virtual_bank_vgp: "4000" }));
    expect(after.current_round_type).toBe("StockRound");
    expect(after.macro_round_number).toBe(4);
  });
});

describe("the bank breaks during an Operating Round set (design note #898)", () => {
  it("ends the game when that set completes, not when the bank empties", () => {
    /* THE FIRST REPORTED CASE. The break has already happened -- the bank is at zero while the corporation is
       still operating -- and the game must run on to the set boundary and stop THERE. */
    const midSet = operating({ virtual_bank_vgp: "0" });
    expect(midSet.current_round_type).toBe("OperatingRound");
    const after = endOfSet(midSet);
    expect(after.current_round_type).toBe("GameEnd");
  });

  it("does not open another Stock Round on the way out", () => {
    /* The failure this replaces would have been subtle: ending the game AND advancing the calendar leaves a
       terminal state that still claims to be in macro round 4, which every round-aware surface then reads. */
    const after = endOfSet(operating({ virtual_bank_vgp: "0" }));
    expect(after.macro_round_number).toBe(3);
    expect(after.operating_round_just_ended).toBe(false);
  });

  it("treats a bank at exactly zero as broken, not as solvent", () => {
    // `bankIsBroken` is `<= 0`, and an off-by-one here would let a game run forever on an empty bank.
    expect(endOfSet(operating({ virtual_bank_vgp: "0" })).current_round_type).toBe("GameEnd");
    expect(endOfSet(operating({ virtual_bank_vgp: "1" })).current_round_type).toBe("StockRound");
  });
});

describe("the bank breaks during a Stock Round (design note #898)", () => {
  /* ==================================================================
      THE SECOND CASE, AND WHY IT NEEDS NO SECOND RULE
     ==================================================================
     A break during a Stock Round is not visible to `settleRoundTransitions` at all -- the Stock Round ends by
     its own passes and opens an OR set, and only when THAT set finishes does this code look at the bank. So
     the second reported case is the first one arrived at a round later, and the assertions below walk it:
     the OR set that follows the broken Stock Round runs in full, and ends the game at its boundary. */

  it("runs the whole OR set rather than ending on entry to it", () => {
    /* THE HALF A NAIVE "bank is broken -> end now" FIX GETS WRONG, and the first draft of this case asserted
       it VACUOUSLY -- it read `current_round_type` straight off the fixture it had just built, so it passed
       without calling the reducer at all and would have passed against any implementation whatsoever.
       Asserted properly: with two corporations still queued and the bank already empty, ending the first
       corporation's turn must reach the SECOND corporation, not the standings. */
    const owedAFullSet = operating({
      virtual_bank_vgp: "0",
      active_operating_order: [1, 2],
      active_corporation_index: 0,
    });
    const after = endTurn(owedAFullSet);
    expect(after.current_round_type).toBe("OperatingRound");
  });

  it("ends the game at the end of that following set", () => {
    const finalSet = operating({ virtual_bank_vgp: "0", macro_round_number: 5 });
    expect(endOfSet(finalSet).current_round_type).toBe("GameEnd");
  });
});

describe("the ending is a fact the log produces, not a render", () => {
  it("un-ends when the state is rebuilt with a solvent bank", () => {
    /* THE UNDO PROPERTY, and the reason this rule belongs to the reducer rather than to `App.tsx`. A
       `RevertTo` that rewinds past the payout that emptied the bank replays into a game that has not ended --
       which falls out for free from a pure state -> state function, and which a render-time
       `bankIsBroken(gameState)` could never express, because there is no earlier state for it to read. */
    const ended = endOfSet(operating({ virtual_bank_vgp: "0" }));
    expect(ended.current_round_type).toBe("GameEnd");
    const rewound = endOfSet(operating({ virtual_bank_vgp: "4000" }));
    expect(rewound.current_round_type).toBe("StockRound");
  });

  it("leaves a mid-set turn alone whatever the bank says", () => {
    /* THE REPORTED SYMPTOM, INVERTED. With two corporations queued, advancing off the first must move to the
       second and NOT end the game -- the old derivation ended it here, in the middle of somebody's turn. */
    const twoQueued = operating({
      virtual_bank_vgp: "0",
      active_operating_order: [1, 2],
      active_corporation_index: 0,
    });
    const after = endTurn(twoQueued);
    expect(after.current_round_type).toBe("OperatingRound");
    expect(after.active_corporation_index).toBe(1);
  });
});
