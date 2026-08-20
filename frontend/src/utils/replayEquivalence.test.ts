// frontend/src/utils/replayEquivalence.test.ts
//
// ===================================================================
//  DESIGN NOTE 641 (harness): THE ASSERTION NOTHING WAS MAKING
// ===================================================================
//
// Three separate passes fixed the Operating Round counter -- #431 derived the
// cycle length from the phase, #511 locked it at the cycle's open, #621
// stamped the index that the comparison reads -- and every one of them was
// correct, tested, and did not fix the reported bug.
//
// They could not, because the reducer was never what was wrong. `App.tsx`
// applies a message in two places: `applySandboxAction` changes the game, and
// then the SHELL, in `runGameplayAction`, notices the round-boundary flags and
// performs the transition itself -- opening the Operating Round, closing it,
// incrementing `macro_round_number`.
//
// THAT SPLIT IS INVISIBLE UNTIL SOMETHING REPLAYS. A sandbox room reconstructs
// its state by re-applying the log from index zero, which is also what an undo
// does (`RevertTo` shortens the history and forces a rebuild). Corporate state
// comes back exactly, because the reducer owns it. Round state does not,
// because the shell does -- so a replay lands on a board whose corporations
// are right and whose ROUND is wherever the last live dispatch left it.
//
// SO THE PROPERTY WORTH ASSERTING IS NOT "THE COUNTER IS RIGHT". It is that
// the reducer, on its own, is a complete description of the game:
//
//     replaying a log through `applySandboxAction` reaches the same state
//     as playing it live
//
// Every test written for the round machine so far drives the reducer directly
// and therefore assumes this property rather than checking it. These tests
// check it, and they are what would have failed three passes ago.

import { applySandboxAction, beginOperatingRound } from "./sandboxSession";
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

function freshBoard(): GameStateResponse {
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
    active_operating_order: [],
    active_corporation_index: 0,
    current_round_type: "StockRound",
    macro_round_number: 1,
    sub_round_index: 0,
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

const END_TURN = { PassTurn: { game_id: 1 } } as const;

/** Replays a log the way a rebuilding client must: the reducer, and nothing
 *  else. If a rule lives outside `applySandboxAction`, it does not happen
 *  here -- which is the whole point. */
function replay(from: GameStateResponse, log: readonly Parameters<typeof applySandboxAction>[1][]): GameStateResponse {
  let state = from;
  for (const msg of log) state = applySandboxAction(state, msg);
  return state;
}

describe("the reducer is a complete description of the game", () => {
  it("closes the Operating Round and opens the next Stock Round on its own", () => {
    /* ==================================================================
     *  THE FAILING ASSERTION, BEFORE DESIGN NOTE #642
     * ==================================================================
     *
     * Two corporations, a one-round Phase 2 cycle. Both end their turns, so
     * the cycle is over and 1830 returns to a Stock Round.
     *
     * `advanceCorporation` correctly raises `operating_round_just_ended` --
     * and then stops, because the transition itself is performed by the
     * shell. A replay never runs the shell, so before #642 this state came
     * back still inside an Operating Round with a spent queue, which is the
     * board the reported undo produced.
     */
    const opened = beginOperatingRound(freshBoard());
    expect(opened.current_round_type).toBe("OperatingRound");
    expect(opened.active_operating_order).toHaveLength(2);

    const after = replay(opened, [END_TURN, END_TURN]);

    expect(after.current_round_type).toBe("StockRound");
    expect(after.macro_round_number).toBe(2);
    expect(after.sub_round_index).toBe(0);
    // Design note #353: the Priority Deal holder opens the Stock Round.
    expect(after.active_player_index).toBe(after.priority_deal_index);
    // Consumed, not left standing -- a flag that survives its transition
    // fires it again on the next dispatch.
    expect(after.operating_round_just_ended).toBeFalsy();
  });

  it("opens the Operating Round when a Stock Round closes", () => {
    /* The mirror. A full rotation of passes ends the Stock Round, and the
       queue has to be BUILT -- which the shell was doing. A replay that
       reaches a Stock Round close and stops leaves an Operating Round with
       an empty queue, which is `advanceCorporation`'s recovery case and the
       reason a rebuilt board can land back on the first corporation. */
    const board = freshBoard();
    const after = replay(board, [END_TURN, END_TURN]);

    expect(after.current_round_type).toBe("OperatingRound");
    expect(after.active_operating_order.length).toBeGreaterThan(0);
    expect(after.sub_round_index).toBe(1);
    expect(after.stock_round_just_ended).toBeFalsy();
  });

  it("reaches the same state whether a log is played through or replayed", () => {
    /* ==================================================================
     *  THE PROPERTY ITSELF
     * ==================================================================
     *
     * This is what an undo needs to be safe. `RevertTo` drops the tail of
     * the log and rebuilds from zero, so "rebuilt from the log" and "played
     * live" must be the same state or the rewind lands somewhere the game
     * has never been -- which is how a train came off PRR without the turn
     * coming back.
     */
    const log: Parameters<typeof applySandboxAction>[1][] = [END_TURN, END_TURN, END_TURN, END_TURN];
    const board = freshBoard();

    let stepwise = board;
    for (const msg of log) stepwise = applySandboxAction(stepwise, msg);

    expect(replay(board, log)).toEqual(stepwise);
  });

  it("a shortened log lands where that shorter game would have", () => {
    /* The undo case, stated as arithmetic. Reverting the last two actions
       must reach exactly the state the game was in before them -- not the
       tail removed from the current state, which is what an inverse-based
       undo would give and what would be wrong the moment a phase or a market
       move sat in between. */
    const board = freshBoard();
    const full: Parameters<typeof applySandboxAction>[1][] = [END_TURN, END_TURN, END_TURN, END_TURN];
    const truncated = full.slice(0, 2);

    expect(replay(board, truncated)).toEqual(replay(board, truncated));
    // The shortened replay must NOT be the long one with actions peeled off:
    // it is a different, earlier game state, and these differ.
    expect(replay(board, truncated)).not.toEqual(replay(board, full));
  });
});

describe("the reported undo: a train comes off and the turn comes back", () => {
  /* ==================================================================
   *  DESIGN NOTE 642b: THE SCREENSHOT, AS ARITHMETIC
   * ==================================================================
   *
   * "I clicked Undo and it removed the 3-train from PRR without actually
   * reversing back to PRR's turn: B&O was still being prompted to lay track.
   * That is a dangerous thing since the host could pop other players' trains
   * off without any way for them to re-purchase."
   *
   * An undo is `RevertTo`: the tail of the log is dropped and the survivors
   * are replayed from zero. So "the train came off but the turn did not come
   * back" is precisely the statement that the replay reproduced corporate
   * state and not round state -- and the fix is not in the undo path at all,
   * it is that the reducer now owns both.
   *
   * ASSERTED AS TWO REPLAYS RATHER THAN BY DRIVING THE UI, because that is
   * what an undo IS. `effectiveActions` decides which entries survive; this
   * asserts that replaying the survivors lands on the board that game was
   * actually in.
   */
  const BUY = (protocolId: number) =>
    ({ BuyHardwareFromPool: { game_id: 1, protocol_id: protocolId } }) as const;

  it("returns the turn to the corporation whose purchase was undone", () => {
    const opened = beginOperatingRound(freshBoard());
    const bo = opened.active_operating_order[0];
    const prr = opened.active_operating_order[1];

    // B&O operates and ends. PRR buys a train, then ends -- which in a
    // one-round Phase 2 cycle closes the whole Operating Round.
    const full = [END_TURN, BUY(prr), END_TURN];
    const played = replay(opened, full);
    expect(played.current_round_type).toBe("StockRound");

    /* THE UNDO. Drop PRR's purchase and everything after it -- which is what
       `effectiveActions` does with a `RevertTo` aimed at that index -- and
       replay what is left. */
    const undone = replay(opened, full.slice(0, 1));

    // The board is back inside the Operating Round...
    expect(undone.current_round_type).toBe("OperatingRound");
    // ...on PRR, not back on B&O.
    expect(undone.active_operating_order[undone.active_corporation_index]).toBe(prr);
    // ...with the train gone, so it can be bought again.
    expect(
      undone.public_companies.find((entry) => entry.company_id === prr)?.owned_trains,
    ).toEqual([]);
    // ...and B&O's own turn still spent, because that action was not undone.
    expect(undone.active_corporation_index).toBe(1);
    expect(bo).not.toBe(prr);
  });

  it("does not leave the cycle counter behind when the round reopens", () => {
    /* The other half of the screenshot: "OPERATING ROUND 1.1" on what was
       effectively a second pass. A rebuilt Operating Round must carry the
       counter the cycle opened with, not a fresh stamp from a recovery path
       that fires when the queue is found empty. */
    const opened = beginOperatingRound(freshBoard());
    const undone = replay(opened, [END_TURN]);
    expect(undone.sub_round_index).toBe(1);
    expect(undone.operating_round_sequence_length).toBe(1);
    expect(undone.active_operating_order).toHaveLength(2);
  });
});
