// frontend/src/utils/firstOperatingRound.test.ts
//
// ==================================================================
//  DESIGN NOTE 638 (harness): THE REPORTED SEQUENCE, THROUGH THE REDUCER
// ==================================================================
//
// REPORTED: "at the end of OR1.1 the first 3-train was bought, and it
// immediately started another OR, though once again the 'Operating Round 1.1'
// did not increment to 'Operating Round 1.2'." And, decisively: "there can
// never be an Operating Round 1.2, since Operating Round 1.1 always starts in
// the 2-train/yellow phase."
//
// `operatingRoundCycleCount.test.ts` pins the same rule but applies the phase
// change by MUTATING the state object directly. That is not the path a game
// takes: a real 3-train arrives through `BuyHardwareFromPool`, which runs
// `buyDepotTrain` -> `applyPhaseChange` and rebuilds the state. If any step in
// that chain drops the cycle's stamped length, the fallback in
// `operatingRoundSequenceLength` re-derives it live -- from the Green phase
// the train just started -- and a one-round Yellow cycle becomes a two-round
// Green one. That is precisely the reported symptom, and only a test that
// buys the train through the dispatcher can see it.

import { applySandboxAction, beginOperatingRound } from "./sandboxSession";
import { derivePhase } from "./gamePhase";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

/* ==================================================================
 *  DESIGN NOTE 642 (harness): "THE ROUND ENDED" IS A STATE, NOT A FLAG
 * ==================================================================
 *
 * These tests detected the end of an Operating Round by reading
 * `operating_round_just_ended`. That flag was a message from the reducer to
 * the SHELL, which then performed the transition -- and design note #642
 * moved the transition into the reducer, where it belongs, so the flag is now
 * raised and consumed inside a single `applySandboxAction` call and is never
 * observable from outside.
 *
 * THE REPLACEMENT IS BETTER, not merely different. A flag says "something is
 * about to happen if the right caller notices"; `current_round_type` says what
 * round the game is actually in. The first could be true on a board that
 * never moved, which is exactly the bug the move fixed -- so a harness that
 * asserts against the flag would keep passing on a game that had stopped
 * advancing.
 */
const inOperatingRound = (state: { current_round_type: string }) =>
  state.current_round_type === "OperatingRound";
const roundHasEnded = (state: { current_round_type: string }) => !inOperatingRound(state);

const ALICE = "juno1alice";
const BOB = "juno1bob";
const CAI = "juno1cai";

function company(
  over: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
): PublicCompanyState {
  return {
    is_floated: true,
    /* Enough for the last corporation to buy out the 2-train tier
       (6 x $80) and then the first 3-train ($180) -- see the sequence
       test below for why that is the reachable route to Phase 3. */
    treasury: "2000",
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

/** The state a Stock Round hands over: Phase 2, nobody owns a train. */
function stockRoundHandover(): GameStateResponse {
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
    sub_round_index: 0,
    // Seeded WRONG on purpose: nothing should read it before the cycle opens.
    operating_round_sequence_length: 9,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
      { player: CAI, cash_vgp: "400" },
    ],
    public_companies: [
      company({ company_id: 4, ticker: "B&O", president: ALICE }),
      company({ company_id: 1, ticker: "PRR", president: BOB }),
      company({ company_id: 5, ticker: "C&O", president: CAI }),
    ],
    private_companies: [],
  };
}

const END_TURN = { PassTurn: { game_id: 1 } } as const;
const buyTrain = (protocolId: number) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: protocolId } }) as const;

describe("the first Operating Round of a game", () => {
  it("opens at 1.1 in Phase 2, with a one-round cycle", () => {
    const opened = beginOperatingRound(stockRoundHandover());
    expect(derivePhase(opened)?.tier).toBe("2");
    expect(opened.sub_round_index).toBe(1);
    expect(opened.operating_round_sequence_length).toBe(1);
  });

  it("ends after one round even though a 3-train was bought during it", () => {
    /* ==================================================================
     *  THE REPORTED SEQUENCE, STEP FOR STEP
     * ==================================================================
     *
     * Three corporations operate. The last one buys the first 3-train --
     * which moves the game to Phase 3 while the cycle is still running --
     * and then ends its turn. 1830 fixes the number of Operating Rounds when
     * the cycle OPENS, so the new phase governs the NEXT cycle and this one
     * must close to a Stock Round.
     */
    let state = beginOperatingRound(stockRoundHandover());
    const queue = state.active_operating_order;
    expect(queue).toHaveLength(3);

    // First two corporations operate and end their turns.
    state = applySandboxAction(state, END_TURN);
    expect(inOperatingRound(state)).toBe(true);
    state = applySandboxAction(state, END_TURN);
    expect(inOperatingRound(state)).toBe(true);

    /* THE 3-TRAIN IS REACHED THE WAY A GAME REACHES IT. 1830's depot sells
       cheapest-first, so the first purchase of OR1.1 is a 2-train and the
       first 3-train only becomes buyable once all six 2-trains are gone.
       That is a reachable position -- the panel sells several at a time --
       and it is the position the report describes. Buying straight to a
       3-train, as an earlier draft of this test did, is not a state the
       depot can be in, and asserting against it tested the harness rather
       than the rule. */
    const lastCompany = queue[state.active_corporation_index];
    for (let buy = 0; buy < 12 && derivePhase(state)?.tier !== "3"; buy += 1) {
      state = applySandboxAction(state, buyTrain(lastCompany));
    }
    expect(derivePhase(state)?.tier).toBe("3");

    /* THE STAMPED LENGTH MUST HAVE SURVIVED THE REBUILD. If a spread
       anywhere in that chain dropped it, `operatingRoundSequenceLength`
       would fall back to deriving live -- and live now says Green, which
       runs two rounds. */
    expect(state.operating_round_sequence_length).toBe(1);
    expect(state.sub_round_index).toBe(1);

    // ...and ending the turn closes the CYCLE, not just the turn.
    state = applySandboxAction(state, END_TURN);
    expect(roundHasEnded(state)).toBe(true);
  });

  it("never produces an Operating Round 1.2", () => {
    /* The report's own framing, asserted directly: OR1 always opens in the
       2-train phase, and Phase 2 runs exactly one Operating Round. Whatever
       is bought during it, the counter cannot reach 2 before the round
       closes. */
    let state = beginOperatingRound(stockRoundHandover());
    for (let dispatch = 0; dispatch < 50; dispatch += 1) {
      const acting = state.active_operating_order[state.active_corporation_index];
      // Buy a train whenever one is affordable, to push the phase as hard as
      // the sequence allows.
      state = applySandboxAction(state, buyTrain(acting));
      state = applySandboxAction(state, END_TURN);
      expect(state.sub_round_index).toBeLessThanOrEqual(1);
      if (roundHasEnded(state)) return;
    }
    throw new Error("the first Operating Round never closed");
  });
});

describe("the reported board: two floated corporations", () => {
  /* ==================================================================
   *  DESIGN NOTE 638a: THE SCREENSHOT'S EXACT POSITION
   * ==================================================================
   *
   * "only B&O and PRR have been floated. Both laid track creating valid
   * routes on their first turn, and B&O purchased four 2-trains, while PRR
   * purchased the remaining two 2-trains and one 3-train to end its turn.
   * The game then immediately flipped back to B&O's turn."
   *
   * Two corporations rather than three, because a queue of two is where an
   * off-by-one in the cursor walk would show and a queue of three might not.
   */
  function twoFloated(): GameStateResponse {
    const base = stockRoundHandover();
    return {
      ...base,
      public_companies: base.public_companies.filter((entry) => entry.ticker !== "C&O"),
    };
  }

  it("closes the round when the second of two corporations ends its turn", () => {
    let state = beginOperatingRound(twoFloated());
    expect(state.active_operating_order).toHaveLength(2);
    expect(state.sub_round_index).toBe(1);
    expect(state.operating_round_sequence_length).toBe(1);

    // B&O buys four 2-trains, then ends its turn.
    const first = state.active_operating_order[0];
    for (let buy = 0; buy < 4; buy += 1) state = applySandboxAction(state, buyTrain(first));
    state = applySandboxAction(state, END_TURN);
    expect(inOperatingRound(state)).toBe(true);
    expect(state.active_corporation_index).toBe(1);

    // PRR takes the last two 2-trains and then the first 3-train.
    const second = state.active_operating_order[1];
    for (let buy = 0; buy < 3; buy += 1) state = applySandboxAction(state, buyTrain(second));
    expect(derivePhase(state)?.tier).toBe("3");

    /* THE MOMENT THE REPORT IS ABOUT. Ending here must close the CYCLE. If
       it instead rebuilds the queue, `active_corporation_index` returns to 0
       and B&O is asked to lay track a second time -- which is the screenshot,
       captioned "OPERATING ROUND 1.1 / LAY TRACK 2/6". */
    state = applySandboxAction(state, END_TURN);
    expect(roundHasEnded(state)).toBe(true);
    /* Design note #642: `1` here was the OLD two-step behaviour -- the flag
       was raised and the board had not moved yet, so the counter still read
       the round that had just finished. The transition happens in the same
       dispatch now, so the game is already in the next Stock Round and the
       counter has reset. Asserting the round type as well, because "the
       counter is 0" is only meaningful alongside where the game actually is. */
    expect(state.current_round_type).toBe("StockRound");
    expect(state.sub_round_index).toBe(0);
    expect(state.macro_round_number).toBe(2);
  });

  it("keeps the queue populated across the phase change", () => {
    /* `advanceCorporation` rebuilds the round from scratch when it finds an
       EMPTY queue -- and that recovery path resets the cursor to zero while
       leaving `sub_round_index` at 1, which is the screenshot exactly. So the
       queue surviving `applyPhaseChange` is worth asserting on its own. */
    let state = beginOperatingRound(twoFloated());
    const acting = state.active_operating_order[0];
    for (let buy = 0; buy < 7; buy += 1) state = applySandboxAction(state, buyTrain(acting));
    expect(derivePhase(state)?.tier).toBe("3");
    expect(state.active_operating_order).toHaveLength(2);
  });
});
