/** @jest-environment node */
//
// Design note #1340 (harness): one dispatch, the whole transition -- and nothing outside the reducer moving money.

import { applySandboxAction } from "../gameEngine/sandboxSession";
import { describeAuctionTransition } from "./auctionTransition";
import { SV_PRIVATE_ID } from "../gameEngine/gameConstants";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { GameStateResponse } from "../gameEngine/gameState";
import { readStripped } from "./sourceScan";

const HOST = "p-host";
const GUEST = "p-guest";

function dealt(): GameStateResponse {
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );
  const seeded: GameStateResponse = { ...seedState, waterfall: seedWaterfall };
  const setup = {
    SetupGame: {
      build: "test",
      players: [
        { id: HOST, nickname: "Host" },
        { id: GUEST, nickname: "Guest" },
      ],
      variants: { delayedAuction: false },
    },
  } as unknown as GameplayExecuteMsg;
  return applySandboxAction(seeded, setup);
}

const cashOf = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp ?? NaN);

describe("#1340: the reducer settles the auction inside one call", () => {
  it("re-seats the auction on the deal, from the dealt roster", () => {
    const board = dealt();
    expect(board.waterfall).not.toBeNull();
    expect(board.player_addresses).toContain(board.waterfall?.current_turn);
    expect(board.waterfall?.privates.length).toBeGreaterThan(0);
    expect(board.waterfall?.waterfall_auction_active).toBe(true);
  });

  it("a buy-lowest charges the buyer, writes the owner and the settled price -- all in the returned state", () => {
    const board = dealt();
    const buyer = board.waterfall?.current_turn as string;
    const cheapest = board.waterfall?.privates.find((p) => p.is_lowest_offered);
    const before = cashOf(board, buyer);
    const after = applySandboxAction(board, { WaterfallBuyLowest: { game_id: 0 } } as GameplayExecuteMsg, {
      actor: buyer,
    });
    const priv = after.private_companies.find((p) => p.private_id === cheapest?.private_id);
    expect(priv?.owner).toBe(buyer);
    expect(priv?.settled_price).toBe(Number(cheapest?.face_value));
    expect(cashOf(after, buyer)).toBe(before - Number(cheapest?.face_value));
    expect(after.waterfall?.privates.some((p) => p.private_id === cheapest?.private_id)).toBe(false);

    const transition = describeAuctionTransition(board, after, { WaterfallBuyLowest: { game_id: 0 } } as GameplayExecuteMsg);
    expect(transition.won).toEqual([
      { privateId: priv?.private_id, name: priv?.name, player: buyer, price: Number(cheapest?.face_value) },
    ]);
    expect(transition.allPassed).toBe(false);
    expect(transition.markdown).toBeNull();
  });

  it("the all-pass pays private income once the SV is sold, and marks nothing down (Batch 7.3, C5)", () => {
    /* ==================================================================
        WHAT THIS CASE USED TO PIN, AND WHY IT IS THE DEFECT (audit C5, #1580)
       ==================================================================
       It asserted that an all-pass marks THE CHEAPEST private down $5 AND pays private income, in every
       case. Rulebook §1.2.3 states two rules with the same trigger and different conditions: the markdown is
       the Schuylkill Valley's while the SV is UNSOLD, and the income is paid when the SV HAS been sold. The
       engine ran both every time, which marked the B&O down 220 -> 215 in JUNO-Z6C and paid income to
       everybody on an all-pass with the SV still on the table.

       THIS FIXTURE'S FIRST SEAT BUYS THE CHEAPEST PRIVATE, which IS the SV -- so this is §1.2.3's second
       rule: income to what is already owned, and nothing marked down. The first rule has its own case below.
       The atom's own reporting (`allPassed`, `markdown`) is asserted both ways, because the shell's
       narration reads those two fields. */
    let board = dealt();
    const first = board.waterfall?.current_turn as string;
    // The first seat buys the SV, so somebody owns a private to be paid AND the SV has left the auction.
    board = applySandboxAction(board, { WaterfallBuyLowest: { game_id: 0 } } as GameplayExecuteMsg, { actor: first });
    const owned = board.private_companies.find((p) => p.owner === first);
    expect(owned?.private_id).toBe(SV_PRIVATE_ID);
    const income = Number(owned?.revenue_per_or ?? 0);
    const cheapest = board.waterfall?.privates.find((p) => p.is_lowest_offered);
    expect(cheapest?.private_id).not.toBe(SV_PRIVATE_ID);
    const cashBefore = cashOf(board, first);

    // Two players, two passes: the second is the all-pass.
    const pass = { WaterfallPass: { game_id: 0 } } as GameplayExecuteMsg;
    const onePass = applySandboxAction(board, pass);
    expect(describeAuctionTransition(board, onePass, pass).allPassed).toBe(false);
    const allPass = applySandboxAction(onePass, pass);

    // §1.2.3, second rule: the income is paid...
    expect(cashOf(allPass, first)).toBe(cashBefore + income);
    // ...and the next card up is NOT marked down, because it is not the Schuylkill Valley.
    const marked = allPass.waterfall?.privates.find((p) => p.private_id === cheapest?.private_id);
    expect(Number(marked?.face_value)).toBe(Number(cheapest?.face_value));

    const transition = describeAuctionTransition(onePass, allPass, pass);
    expect(transition.allPassed).toBe(true);
    expect(transition.markdown).toBeNull();
    expect(transition.payouts.some((p) => p.toPlayer === first && p.amount === income)).toBe(true);
  });

  it("...and marks the SV down $5 with NO income while the SV is still unsold (Batch 7.3, C5)", () => {
    /* §1.2.3's FIRST rule, which the case above cannot reach because its first seat buys the SV. Nobody has
       bought anything here, so nobody is owed income -- and the card that loses $5 is the SV by name. */
    const board = dealt();
    const sv = board.waterfall?.privates.find((p) => p.private_id === SV_PRIVATE_ID);
    expect(sv?.is_lowest_offered).toBe(true);
    const cashBefore = board.player_cash.map((entry) => entry.cash_vgp);

    const pass = { WaterfallPass: { game_id: 0 } } as GameplayExecuteMsg;
    const allPass = applySandboxAction(applySandboxAction(board, pass), pass);

    const marked = allPass.waterfall?.privates.find((p) => p.private_id === SV_PRIVATE_ID);
    expect(Number(marked?.face_value)).toBe(Number(sv?.face_value) - 5);
    // No income: the SV is unsold, so §1.2.3's second rule has not been reached.
    expect(allPass.player_cash.map((entry) => entry.cash_vgp)).toEqual(cashBefore);
    /* The table DID all pass -- that is what marked the SV down -- and nobody was paid for it. The two
       facts are separate fields now (#1580): the shell still says "everyone passed", and prints no payout. */
    const transition = describeAuctionTransition(applySandboxAction(board, pass), allPass, pass);
    expect(transition.allPassed).toBe(true);
    expect(transition.payouts).toEqual([]);
    expect(transition.markdown).toEqual({
      privateId: SV_PRIVATE_ID,
      name: sv?.name,
      from: Number(sv?.face_value),
      to: Number(sv?.face_value) - 5,
    });
  });

  it("a state carrying no auction is left exactly as it was", () => {
    const board = dealt();
    const { waterfall: _drop, ...bare } = board;
    const after = applySandboxAction(bare as GameStateResponse, { WaterfallBuyLowest: { game_id: 0 } } as GameplayExecuteMsg);
    expect(after.waterfall).toBeUndefined();
    expect(after.player_cash).toEqual(bare.player_cash);
  });

  it("neither caller composes the auction any more", () => {
    const APP = readStripped("App.tsx");
    const ENGINE = readStripped("gameEngine/replayLog.ts");
    for (const source of [APP, ENGINE]) {
      expect(source).not.toContain("applySandboxWaterfallAction(");
      expect(source).not.toContain("result.allPassed");
      expect(source).not.toContain("result.charges");
      expect(source).not.toContain("result.won");
      expect(source).not.toContain("applyPrivateExchange(");
    }
    expect(ENGINE).not.toContain("applyPrivateRevenue(");
    expect(ENGINE).not.toContain("waterfallForRoster(");
    // The engine holds one value and applies one function.
    expect(ENGINE).toContain("this.state = { ...seed.state, market_positions: providers.initialMarket, waterfall: seed.waterfall };");
    expect(ENGINE).not.toContain("private waterfall:");
    // The shell hands the atom in and mirrors it out.
    expect(APP).toContain("waterfall: sandboxWaterfallRef.current,");
    expect(APP).toContain("const auction = after.waterfall ?? null;");
  });
});
