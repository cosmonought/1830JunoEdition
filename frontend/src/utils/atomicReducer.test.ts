/** @jest-environment node */
//
// Design note #1340 (harness): one dispatch, the whole transition -- and nothing outside the reducer moving money.

import { applySandboxAction } from "./sandboxSession";
import { describeAuctionTransition } from "./auctionTransition";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "./sandboxState";
import { waterfallForRoster, withEmptyRoster } from "./gameSetup";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { GameStateResponse } from "./gameState";
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

  it("the all-pass marks the cheapest down and pays private income, in the same call", () => {
    let board = dealt();
    const first = board.waterfall?.current_turn as string;
    // The first seat buys, so somebody owns a private to be paid.
    board = applySandboxAction(board, { WaterfallBuyLowest: { game_id: 0 } } as GameplayExecuteMsg, { actor: first });
    const owned = board.private_companies.find((p) => p.owner === first);
    const income = Number(owned?.revenue_per_or ?? 0);
    const cheapest = board.waterfall?.privates.find((p) => p.is_lowest_offered);
    const cashBefore = cashOf(board, first);

    // Two players, two passes: the second is the all-pass.
    const pass = { WaterfallPass: { game_id: 0 } } as GameplayExecuteMsg;
    const onePass = applySandboxAction(board, pass);
    expect(describeAuctionTransition(board, onePass, pass).allPassed).toBe(false);
    const allPass = applySandboxAction(onePass, pass);

    expect(cashOf(allPass, first)).toBe(cashBefore + income);
    const marked = allPass.waterfall?.privates.find((p) => p.private_id === cheapest?.private_id);
    expect(Number(marked?.face_value)).toBe(Number(cheapest?.face_value) - 5);

    const transition = describeAuctionTransition(onePass, allPass, pass);
    expect(transition.allPassed).toBe(true);
    expect(transition.markdown).toEqual({
      privateId: cheapest?.private_id,
      name: cheapest?.name,
      from: Number(cheapest?.face_value),
      to: Number(cheapest?.face_value) - 5,
    });
    expect(transition.payouts.some((p) => p.toPlayer === first && p.amount === income)).toBe(true);
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
    const ENGINE = readStripped("utils/replayLog.ts");
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
