/** @jest-environment node */
// frontend/src/utils/refusalAtomicity.test.ts -- design note #1560 (Batch 7.1).
//
// ==================================================================
//  A REFUSED PURCHASE DOES NOT HAPPEN BY HALVES
// ==================================================================
//
// Batch 7.1 moved two transactions from "floor the payment and carry on" to "refuse" -- the stock purchase
// and the corporate private purchase -- and a refusal that is only PARTIAL is worse than the mint it
// replaced. A share that moved without being paid for, a presidency taken on an unfunded certificate, a
// corporation floated out of a bank that never paid, a `bought_this_turn` spent on a purchase that did not
// occur: each of those is a board no replay can reproduce and no player can argue with.
//
// SO EVERY MONEY MOVEMENT COMES FIRST IN ITS ARM, and the arm returns the board it was handed the instant the
// ledger says no. That is asserted here by comparing the WHOLE STATE field by field, rather than by checking
// the two or three fields the author happened to think of -- the assertion names every field that differs,
// so a future arm that writes something new before the charge fails this file rather than passing it.
//
// ==================================================================
//  "NOTHING" MEANS NOTHING -- AND THE DERIVED FIELDS ARE PROVED, NOT WAIVED
// ==================================================================
//
// The settle chain that runs after EVERY message normalises two derived fields: `settleEra` writes
// `current_global_era` from the trains in play and the variants in force, and `settleOperatingCursor` writes
// `operating_sub_phase`. Neither reads the message. The reducer already says so at design note #1303 -- "the
// settle chain below the arm stamps `current_global_era` on a state that never carried one, and a refused
// exchange came back as a new object" -- and it is why Stage 7 tests refusals by digest rather than by object
// identity (S7-17 / S10-1).
//
// SO THE PRIMARY CASES BELOW START FROM A BOARD THAT ALREADY CARRIES THOSE DERIVED FIELDS, and on such a
// board a refused purchase differs in NO FIELD AT ALL -- literal whole-state equality, which is the strongest
// statement this file can make. A second pair of cases starts from a STALE board (the fields absent, as a
// hand-built fixture usually leaves them) and pins the normalisation as independent of the transaction, with
// two controls: the same board through `UndoLastAction` -- an arm whose entire body is `return state` -- is
// normalised identically, and so is an AFFORDABLE purchase. A mutation caused by the rejected transaction
// could not survive either control.

import { applySandboxAction } from "../gameEngine/sandboxSession";
import { fieldDigests } from "../gameEngine/stateDigest";
import { moneyConservationBreach } from "../gameEngine/cashLedger";
import type { GameStateResponse } from "../gameEngine/gameState";

/** Every top-level field whose canonical form differs. The empty array is the strongest claim this file can
 *  make; a short, named array is the second strongest. */
const differingFields = (before: GameStateResponse, after: GameStateResponse): string[] => {
  const was = fieldDigests(before);
  const now = fieldDigests(after);
  return Object.keys({ ...was, ...now })
    .filter((key) => was[key] !== now[key])
    .sort();
};

/** Derived by the post-action settle chain on every message, refused or applied, from the board and never
 *  from the message: `settleEra` (#1303) and `settleOperatingCursor` (#656). */
const DERIVED_BY_THE_SETTLE_CHAIN = ["current_global_era", "operating_sub_phase"];

/** An arm whose entire body is `return state` (#S10-8: undo is a full replay and the sandbox has no log).
 *  The neutral control: whatever this changes was not changed by the transaction under test. */
const NEUTRAL = { UndoLastAction: { game_id: 0 } };

describe("the two derived fields, named and pinned", () => {
  it("are exactly what a neutral message writes onto a board that carries neither", () => {
    /* The list at the top of this file is a claim about the reducer, so it is checked rather than trusted:
       a board with neither field, through an arm that returns its input, acquires exactly these two. */
    const bare = {
      current_round_type: "OperatingRound",
      virtual_bank_vgp: "5000",
      player_addresses: ["p1"],
      player_cash: [{ player: "p1", cash_vgp: "0" }],
      private_companies: [],
      public_companies: [
        { company_id: 1, ticker: "PRR", treasury: "0", is_floated: true, president: "p1", owned_trains: [], station_token_hexes: [] },
      ],
    } as unknown as GameStateResponse;
    expect(differingFields(bare, applySandboxAction(bare, NEUTRAL as never))).toEqual(
      [...DERIVED_BY_THE_SETTLE_CHAIN].sort(),
    );
  });
});

describe("an unaffordable stock purchase changes nothing at all", () => {
  const stockRound = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
    ({
      current_round_type: "StockRound",
      macro_round_number: 2,
      sub_round_index: 0,
      active_player_index: 0,
      priority_deal_index: 0,
      consecutive_passes: 0,
      /* The derived field the settle chain would otherwise stamp, supplied up front so these cases can
         assert literal whole-state equality. The stale-board case at the end of this describe is the one
         that pins what happens without it. */
      current_global_era: "Yellow",
      player_addresses: ["p1", "p2"],
      player_cash: [
        { player: "p1", cash_vgp: "60" },
        { player: "p2", cash_vgp: "600" },
      ],
      virtual_bank_vgp: "9000",
      private_companies: [],
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          president: "p2",
          par_value: "100",
          is_floated: false,
          treasury: "0",
          owned_trains: [],
          ipo_pool_percentage: 80,
          bank_pool_percentage: 0,
          player_holdings: [{ player: "p2", percentage: 20 }],
          station_token_hexes: [],
          station_tokens: [],
        },
      ],
      ...over,
    }) as unknown as GameStateResponse;

  const BUY = { BuyStock: { game_id: 0, protocol_id: 1, source: "Ipo", par_value: "100", certificate: "single" } };
  const buy = (state: GameStateResponse, actor: string) =>
    applySandboxAction(state, BUY as never, { actor });

  it("moves no money, no certificate and no turn bookkeeping when the buyer is short", () => {
    /* p1 holds $60 against a $100 share. The retired `adjustCash` took the $60, credited the bank $100 and
       minted $40 -- audit C3, and 26 entries of the stored corpus. */
    const before = stockRound();
    const after = buy(before, "p1");

    // NO FIELD AT ALL. Not "nothing that matters" -- nothing.
    expect(differingFields(before, after)).toEqual([]);

    // Spelled out as well, because the field list above is only as good as its reader.
    expect(after.player_cash[0].cash_vgp).toBe("60");
    expect(after.virtual_bank_vgp).toBe("9000");
    expect(after.public_companies[0].ipo_pool_percentage).toBe(80);
    expect(after.public_companies[0].player_holdings).toEqual([{ player: "p2", percentage: 20 }]);
    expect(after.bought_this_turn).toBeUndefined();
    expect(after.turn_action_taken).toBeUndefined();
    expect(after.last_trader_index).toBeUndefined();
    expect(after.stock_turn_stage).toBeUndefined();
    expect(after.active_player_index).toBe(0);
    expect(after.market_positions).toBeUndefined();
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("the same purchase by a buyer who can pay moves all of it (the control)", () => {
    /* WITHOUT THIS THE CASE ABOVE IS VACUOUS: an arm that refused everything would satisfy it. */
    const before = stockRound();
    const after = buy(before, "p2");
    expect(differingFields(before, after)).toEqual(
      [
        "active_player_index",
        "bought_this_turn",
        "last_trader_index",
        "player_cash",
        "public_companies",
        "stock_turn_stage",
        "turn_action_taken",
        "virtual_bank_vgp",
      ].sort(),
    );
    expect(after.player_cash[1].cash_vgp).toBe("500");
    expect(after.virtual_bank_vgp).toBe("9100");
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("takes no presidency, writes no par and floats nothing when the president's certificate is unaffordable", () => {
    /* THE EXPENSIVE HALF. A president's purchase is 2 x par and it writes three things together -- the
       presidency, the par, and (through `applyFloatThreshold`) ten times par out of the bank into the
       treasury. Under the floor, a player with $60 could take the presidency of a corporation for $60 and
       capitalise it with $1,000 of invented money. */
    const before = stockRound({
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          president: null,
          par_value: null,
          is_floated: false,
          treasury: "0",
          owned_trains: [],
          ipo_pool_percentage: 100,
          bank_pool_percentage: 0,
          player_holdings: [],
          station_token_hexes: [],
          station_tokens: [],
        },
      ],
    } as unknown as Partial<GameStateResponse>);
    const after = buy(before, "p1");

    expect(differingFields(before, after)).toEqual([]);
    expect(after.public_companies[0].president).toBeNull();
    expect(after.public_companies[0].par_value).toBeNull();
    expect(after.public_companies[0].is_floated).toBe(false);
    expect(after.public_companies[0].treasury).toBe("0");
    expect(after.public_companies[0].ipo_pool_percentage).toBe(100);
    expect(after.player_cash[0].cash_vgp).toBe("60");
    expect(after.virtual_bank_vgp).toBe("9000");
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  describe("on a STALE board the settle chain normalises a derived field, and the transaction does not", () => {
    /* WHY THIS IS NOT A PARTIAL MUTATION, proved rather than asserted. A hand-built fixture usually omits
       `current_global_era`; the settle chain derives it from the trains in play after every message. Three
       cases separate "the pipeline normalised a stale board" from "the rejected purchase mutated something". */
    const stale = () => {
      const { current_global_era: _derived, ...rest } = stockRound();
      return rest as GameStateResponse;
    };

    it("the refused purchase differs in that one derived field", () => {
      const before = stale();
      expect("current_global_era" in before).toBe(false);
      expect(differingFields(before, buy(before, "p1"))).toEqual(["current_global_era"]);
    });

    it("...and so does a NEUTRAL message that cannot have mutated anything (the control)", () => {
      /* `UndoLastAction`'s arm is `return state` in its entirety. If the era write were a consequence of the
         rejected purchase, this message could not produce it. */
      const before = stale();
      const neutral = applySandboxAction(before, NEUTRAL as never);
      expect(differingFields(before, neutral)).toEqual(["current_global_era"]);
      expect(neutral.current_global_era).toBe("Yellow");
    });

    it("...and an AFFORDABLE purchase normalises it to the same value (the second control)", () => {
      // Not refusal-specific either: the era is a function of the board, and the board's fleet is unchanged.
      expect(buy(stale(), "p2").current_global_era).toBe("Yellow");
      expect(buy(stale(), "p1").current_global_era).toBe("Yellow");
    });

    it("no gameplay or transaction state moves on the stale board either", () => {
      const before = stale();
      const after = buy(before, "p1");
      expect(after.player_cash[0].cash_vgp).toBe("60");
      expect(after.virtual_bank_vgp).toBe("9000");
      expect(after.public_companies).toEqual(before.public_companies);
      expect(after.bought_this_turn).toBeUndefined();
      expect(after.turn_action_taken).toBeUndefined();
      expect(moneyConservationBreach(before, after)).toBeNull();
    });
  });
});

describe("an unaffordable corporate private purchase changes nothing but the offer it settles", () => {
  const operating = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
    ({
      current_round_type: "OperatingRound",
      // Both derived fields supplied up front -- see the note at the top of this file.
      current_global_era: "Yellow",
      operating_sub_phase: "Track",
      virtual_bank_vgp: "5000",
      player_addresses: ["p1", "p2"],
      player_cash: [
        { player: "p1", cash_vgp: "100" },
        { player: "p2", cash_vgp: "0" },
      ],
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          treasury: "0",
          is_floated: true,
          president: "p1",
          owned_trains: [],
          station_token_hexes: [],
        },
      ],
      private_companies: [
        {
          private_id: 1,
          name: "Schuylkill Valley",
          face_value: "20",
          revenue_per_or: "5",
          owner: "p2",
          owner_protocol_id: null,
          closed: false,
        },
      ],
      ...over,
    }) as unknown as GameStateResponse;

  const buy = (state: GameStateResponse, price = "70") =>
    applySandboxAction(state, {
      BuyPrivateCompany: { game_id: 0, protocol_id: 1, private_id: 1, price },
    } as never);

  it("moves no money and no ownership when the treasury is empty", () => {
    const before = operating();
    const after = buy(before);
    expect(differingFields(before, after)).toEqual([]);
    expect(after.public_companies[0].treasury).toBe("0");
    expect(after.player_cash[1].cash_vgp).toBe("0");
    expect(after.private_companies[0].owner).toBe("p2");
    expect(after.private_companies[0].owner_protocol_id).toBeNull();
    expect(after.jk_license_granted).toBeUndefined();
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("still retires the accepted offer it was settling, which is #1247's rule and not an accident", () => {
    /* THE ONE DELIBERATE PARTIAL EFFECT IN THIS BATCH, and it is required rather than tolerated. The arm
       clears a matching offer BEFORE it attempts the transfer, because `nextDerivedAction` owes the derived
       purchase for as long as an `accepted` offer stands: a refused settlement that left the offer in place
       would be re-owed on the next look, and again, and the settle loop would spin for ever. The design says
       the same thing in so many words -- "a refused settlement retires the offer and transfers nothing".
       Everything else about the board is untouched, which the field list asserts. */
    const before = operating({
      private_purchase_offer: {
        private_id: 1,
        private_name: "Schuylkill Valley",
        owner: "p2",
        buyer_protocol_id: 1,
        buyer_ticker: "PRR",
        price: 70,
        accepted: true,
      },
    } as unknown as Partial<GameStateResponse>);
    const after = buy(before);

    expect(differingFields(before, after)).toEqual(["private_purchase_offer"]);
    expect(after.private_purchase_offer).toBeNull();
    expect(after.public_companies[0].treasury).toBe("0");
    expect(after.player_cash[1].cash_vgp).toBe("0");
    expect(after.private_companies[0].owner).toBe("p2");
    expect(moneyConservationBreach(before, after)).toBeNull();
  });

  it("the same purchase from a funded treasury moves all of it (the control)", () => {
    const before = operating({
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          treasury: "300",
          is_floated: true,
          president: "p1",
          owned_trains: [],
          station_token_hexes: [],
        },
      ],
    } as unknown as Partial<GameStateResponse>);
    const after = buy(before);
    expect(after.public_companies[0].treasury).toBe("230");
    expect(after.player_cash[1].cash_vgp).toBe("70");
    expect(after.private_companies[0].owner_protocol_id).toBe(1);
    expect(moneyConservationBreach(before, after)).toBeNull();
  });
});
