// frontend/src/utils/operatingCursorReplay.test.ts
//
// ==================================================================
//  DESIGN NOTE 656 (harness): THE TURN CURSOR IS GAME STATE
// ==================================================================
//
// REPORTED: "the game stayed in OR 1.1 and returned to C&O's turn, starting
// at step 3 (Station Tokens). Last time I ended OR 1.1 with a corporation
// purchasing a 3-train, it looped back to step 2 (Lay Track). It should not
// be looping at all."
//
// WRITTEN BEFORE THE FIX, and failing, for the same reason design note #642's
// `replayEquivalence.test.ts` was: four passes at that bug each fixed
// something real and none fixed the bug, because the defect was in WHERE the
// rule lived rather than in what it said. The test that finds that class of
// defect is one that asserts the property directly.
//
// THE PROPERTY. `orSubPhase` -- which step of its turn a corporation is on --
// was React `useState` in `App.tsx`, re-seeded by an effect whose dependency
// array named `currentPhase.tier` among others. `derivePhase` reads the tier
// off the highest train anybody owns, so buying the first 3-train moves it
// from "2" to "3" MID-TURN -- and the effect re-fired with
// `active_corporation_index` unmoved, re-seeding the cursor to
// `visibleSubPhases[0]`: `Track` when Buy Private is hidden, `BuyPrivate` when
// it is not. That is the reported loop, and why the step it lands on varies
// between playthroughs.
//
// NOT `current_global_era`, which is the obvious suspect and was this file's
// first answer. Mutation-testing the fix disproved it: the mutation that
// reproduced an era-keyed reset failed to fail any test, because
// `sandboxSession.ts` never writes `current_global_era` at all. See design
// note #656a -- that frozen field is its own bug, and a larger one.
//
// Two consequences follow, and both are tested here:
//
//   1. A REPLAY CANNOT REBUILD THE TURN. `applySandboxAction` is the whole
//      description of the game for a rebuilding client (design note #642).
//      A cursor held outside it is not in the log, so a client that joins or
//      undoes lands on whatever step its own effect seeds.
//   2. A PHASE CHANGE MUST NOT MOVE THE CURSOR. Buying a train that advances
//      the era is a legal thing to do on the Buy Trains step, and it does not
//      send the corporation back to Lay Track.

import { applySandboxAction } from "./sandboxSession";
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

/** An Operating Round already under way, in the Yellow era -- OR 1.1, the
 *  only Operating Round a Phase 2 game has. */
function operatingBoard(): GameStateResponse {
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
    priority_deal_index: 1,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [4, 1],
    active_corporation_index: 0,
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

function replay(from: GameStateResponse, log: readonly Msg[]): GameStateResponse {
  let state = from;
  for (const msg of log) state = applySandboxAction(state, msg);
  return state;
}

describe("the sub-phase cursor lives on the state the log rebuilds", () => {
  it("is reported at all", () => {
    /* The narrowest statement of the defect: before this chunk the field did
       not exist, so there was nothing for a replay to restore. Every other
       test in this file depends on this one. */
    const state = applySandboxAction(operatingBoard(), {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    expect(state.operating_sub_phase).toBeDefined();
  });

  it("opens a corporation's turn on the era's first step", () => {
    /* `initialOrSubPhase` -- Track in the Yellow era, because Buy Private is
       locked until Phase 3. The rule is unchanged; only its owner is. */
    const state = applySandboxAction(operatingBoard(), {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    expect(state.operating_sub_phase).toBe("Track");
  });

  it("advances one step per skip", () => {
    const skip = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 } } as Msg;
    const opened = applySandboxAction(operatingBoard(), {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    expect(applySandboxAction(opened, skip).operating_sub_phase).toBe("Tokens");
    expect(replay(opened, [skip, skip]).operating_sub_phase).toBe("Routes");
    expect(replay(opened, [skip, skip, skip]).operating_sub_phase).toBe("Dividends");
  });

  it("holds at the last step rather than wrapping back to Track", () => {
    /* Wrapping would let a corporation lay a second tile -- the reason the
       old `skipSubPhase` held rather than wrapped. The rule moves with the
       cursor rather than being left behind in the callback. */
    const skip = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 } } as Msg;
    const opened = applySandboxAction(operatingBoard(), {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    const walked = replay(opened, [skip, skip, skip, skip, skip, skip, skip, skip]);
    expect(walked.operating_sub_phase).toBe("Hardware");
  });

  it("survives a replay of the same log", () => {
    /* Design note #642's property, extended to the cursor. Playing the log
       and replaying it must reach the same state -- INCLUDING which step the
       corporation is on, or a client that joins mid-turn shows a different
       action panel from the one the acting player is looking at. */
    const skip = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 } } as Msg;
    const log: Msg[] = [{ BeginOperatingRound: { game_id: 1 } } as Msg, skip, skip];
    const live = replay(operatingBoard(), log);
    const rebuilt = replay(operatingBoard(), log);
    expect(rebuilt.operating_sub_phase).toBe(live.operating_sub_phase);
    expect(rebuilt.active_corporation_index).toBe(live.active_corporation_index);
  });

  it("puts the next corporation at the start of its own turn", () => {
    const skip = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 } } as Msg;
    const opened = applySandboxAction(operatingBoard(), {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    const handedOver = replay(opened, [skip, skip, { PassTurn: { game_id: 1 } } as Msg]);
    expect(handedOver.active_corporation_index).toBe(1);
    expect(handedOver.operating_sub_phase).toBe("Track");
  });
});

/** Six 2-trains already owned, so the depot's cheapest is a 3-train.
 *
 *  The depot sells CHEAPEST FIRST and ignores the `model_type` asked for --
 *  a probe written for this file showed `BuyHardwareFromPool` with
 *  `model_type: "3"` handing back a 2-train, which is why the first draft of
 *  these tests passed without ever reaching the phase change they claimed to
 *  test. The six are spread across two other corporations because one
 *  corporation cannot hold six trains under the Phase 2 limit. */
function boardOneBuyFromPhaseThree(): GameStateResponse {
  const base = operatingBoard();
  return {
    ...base,
    public_companies: [
      ...base.public_companies,
      company({ company_id: 2, ticker: "NYC", president: BOB, owned_trains: ["2", "2", "2"] }),
      company({ company_id: 3, ticker: "CPR", president: BOB, owned_trains: ["2", "2", "2"] }),
    ],
  };
}

describe("the reported loop: a phase change mid-turn", () => {
  it("holds the cursor when the purchase advances the phase", () => {
    /* THE BUG, as an assertion.

       B&O reaches Buy Trains and buys the first 3-train. `derivePhase` now
       answers tier "3" where it answered "2" a moment ago -- which is exactly
       the dependency the old effect watched, and exactly the change that used
       to send the buying corporation back to the top of its own turn.

       Buying a train is what the Buy Trains step is FOR. */
    const opened = applySandboxAction(boardOneBuyFromPhaseThree(), {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    const skip = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 } } as Msg;
    const atHardware = replay(opened, [skip, skip, skip, skip]);
    expect(atHardware.operating_sub_phase).toBe("Hardware");

    /* ==================================================================
       DESIGN NOTE 1019: THE BUYER IS READ FROM THE CURSOR, NOT ASSUMED
       ==================================================================
       This hard-coded `protocol_id: 4`, and it worked because the reducer let any corporation buy at any
       time. `BeginOperatingRound` rebuilds the queue from every floated corporation -- this fixture adds two
       more to clear the 2-train row -- so which company sits at index 0 is the QUEUE's answer, not the
       fixture's. With the acting-corporation rule enforced, a purchase for whoever is not operating is now
       correctly refused, and the test was buying for the wrong one.
       READING THE CURSOR IS ALSO WHAT THE TEST MEANS. Its subject is that the cursor HOLDS through a phase
       change; naming the buyer by id was incidental to that and is what made the fixture fragile. */
    const buyer = atHardware.active_operating_order[atHardware.active_corporation_index];
    const afterPurchase = applySandboxAction(atHardware, {
      BuyHardwareFromPool: { game_id: 1, protocol_id: buyer, model_type: "3" },
    } as Msg);

    // The purchase really did move the phase -- without this the test would
    // pass for the reason the first draft did, having changed nothing.
    expect(
      afterPurchase.public_companies.find((c) => c.company_id === buyer)?.owned_trains,
    ).toContain("3");
    expect(afterPurchase.operating_sub_phase).toBe("Hardware");
    expect(afterPurchase.active_corporation_index).toBe(0);
  });

  it("opens the NEXT turn on Buy Private once the phase allows it", () => {
    /* The other side of the same rule, and a bug in its own right (design
       note #656a). A turn opening in Phase 3 opens on `BuyPrivate`, because
       that is where a corporation may buy a private from a player -- a step
       the game silently walked past for as long as the opening step was read
       off the frozen `current_global_era`. */
    const board = boardOneBuyFromPhaseThree();
    const withPrivate: GameStateResponse = {
      ...board,
      public_companies: board.public_companies.map((c) =>
        c.company_id === 4 ? { ...c, owned_trains: ["3"] } : c,
      ),
      private_companies: [
        {
          private_id: 1,
          name: "Schuylkill Valley",
          cost: "20",
          revenue_per_or: "5",
          // Held by a PLAYER and not closed -- `hasBuyablePrivate`'s test for
          // "is there anything left for a corporation to buy".
          owner: ALICE,
          owner_protocol_id: null,
          closed: false,
        },
      ],
    };
    const opened = applySandboxAction(withPrivate, {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    expect(opened.operating_sub_phase).toBe("BuyPrivate");
  });

  it("still opens on Track while the game is in Phase 2", () => {
    const opened = applySandboxAction(operatingBoard(), {
      BeginOperatingRound: { game_id: 1 },
    } as Msg);
    expect(opened.operating_sub_phase).toBe("Track");
  });
});
