/** @jest-environment node */
// frontend/src/utils/operatingOrderFloatGate.test.ts
//
// ==================================================================
//  DESIGN NOTE 1448 (test): AN UNFLOATED CORPORATION DOES NOT OPERATE, AND AN EMPTY ROUND DOES NOT OPEN
// ==================================================================
//
// TWO CLAIMS, and the playtest that prompted them could not tell them apart. A Stock Round ended with three
// parred, president-owned, unfloated corporations, and the table landed in an Operating Round that nobody
// could act in. The obvious reading -- "an unfloated corporation got into the queue" -- was wrong:
// `buildOperatingOrder` filters on floated-with-a-president and always has, and the queue it built was
// EMPTY. The fault was that the round opened around that empty queue, and `actingSeatIndex` resolves the
// acting seat out of it, so `null` came back, `isMyTurn` was false for everybody, and the only repair
// (`advanceCorporation`, #411) can only be reached by an action nobody was allowed to take.
//
// SO BOTH ARE PINNED SEPARATELY, because they fail independently and the first one masks the second.

import { applySandboxAction, buildOperatingOrder } from "../gameEngine/sandboxSession";
import { actingSeatIndex } from "../gameEngine/gameState";
import { CURRENT_RULES_REVISION, STANDARD_VARIANTS } from "../gameEngine/gameVariants";
import type { GameStateResponse } from "../gameEngine/gameState";

const SEATS = ["p0", "p1", "p2"];

/** A corporation that has been parred and has a president, and has NOT floated. That is the state 1830
 *  leaves a corporation in after its first purchase, and the one the playtest ended in. */
function started(company_id: number, ticker: string, president: string, floated = false) {
  return {
    company_id,
    ticker,
    president,
    par_value: "100",
    is_floated: floated,
    ipo_pool_percentage: floated ? 0 : 40,
    bank_pool_percentage: 0,
    player_holdings: [{ player: president, percentage: floated ? 60 : 20 }],
    station_token_hexes: [],
  };
}

function board(companies: ReturnType<typeof started>[]): GameStateResponse {
  return {
    player_addresses: SEATS,
    player_cash: SEATS.map((player) => ({ player, cash_vgp: "2000" })),
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 2,
    active_player_index: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    consecutive_passes: 0,
    priority_deal_index: 0,
    last_trader_index: null,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    variants: { ...STANDARD_VARIANTS, rules: CURRENT_RULES_REVISION },
    public_companies: companies,
    ...{},
  } as unknown as GameStateResponse;
}

const seatOf = (state: GameStateResponse) => state.player_addresses[state.active_player_index];
const pass = (state: GameStateResponse) =>
  applySandboxAction(state, { PassTurn: { game_id: 1 } } as never, { actor: seatOf(state) });

/** Pass until the Stock Round is over. Under Sell-Buy-Sell a turn that does nothing takes two Passes (#1443),
 *  so the cap is generous; it THROWS rather than returning a half-finished board, because a silent cap is how
 *  an assertion comes to be made about a state the test never reached (#886). */
function endStockRound(start: GameStateResponse): GameStateResponse {
  let state = start;
  for (let i = 0; i < 40; i++) {
    if (state.current_round_type !== "StockRound" || state.macro_round_number !== start.macro_round_number) {
      return state;
    }
    const next = pass(state);
    if (next === state) throw new Error(`the Pass was refused at step ${i}; the round cannot be ended`);
    state = next;
  }
  throw new Error("the Stock Round did not end within 40 passes");
}

describe("the operating order admits only floated corporations", () => {
  it("leaves out a corporation that is parred and presided over but not floated", () => {
    const state = board([
      started(1, "PRR", "p0"),
      started(4, "B&O", "p1"),
      started(8, "B&M", "p2"),
    ]);
    expect(buildOperatingOrder(state)).toEqual([]);
  });

  it("admits a floated one, and still leaves its unfloated neighbours out", () => {
    const state = board([
      started(1, "PRR", "p0"),
      started(4, "B&O", "p1", true),
      started(8, "B&M", "p2"),
    ]);
    expect(buildOperatingOrder(state)).toEqual([4]);
  });

  it("leaves out a floated corporation with no president -- both halves of the filter are load-bearing", () => {
    const orphan = { ...started(4, "B&O", "p1", true), president: null };
    expect(buildOperatingOrder(board([orphan as never]))).toEqual([]);
  });
});

describe("a Stock Round that floats nothing does not brick the game (#1448)", () => {
  it("advances past the empty Operating Round instead of opening it", () => {
    const opening = board([
      started(1, "PRR", "p0"),
      started(4, "B&O", "p1"),
      started(8, "B&M", "p2"),
    ]);
    const after = endStockRound(opening);

    /* THE CLAIM IS "SOMEBODY CAN ACT". A round whose acting seat is `null` is one no player's controls will
       enable -- which is the brick, and it is invisible to an assertion about the round's NAME alone. */
    expect(actingSeatIndex(after)).not.toBeNull();
    expect(after.active_operating_order).toEqual([]);
    expect(after.current_round_type).not.toBe("OperatingRound");
  });

  it("still opens the Operating Round when one corporation floated, seated on its president", () => {
    const opening = board([
      started(1, "PRR", "p0"),
      started(4, "B&O", "p1", true),
      started(8, "B&M", "p2"),
    ]);
    const after = endStockRound(opening);

    expect(after.current_round_type).toBe("OperatingRound");
    expect(after.active_operating_order).toEqual([4]);
    expect(actingSeatIndex(after)).toBe(SEATS.indexOf("p1"));
  });
});
