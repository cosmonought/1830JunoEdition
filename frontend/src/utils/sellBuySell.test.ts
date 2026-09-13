/** @jest-environment node */
// frontend/src/utils/sellBuySell.test.ts -- design note #1443: the Stock Round is Sell-Buy-Sell.
import { applySandboxAction, stockTurnStage } from "./sandboxSession";
import { CURRENT_RULES_REVISION, resolveVariants, sellBuySellInForce, STANDARD_VARIANTS } from "./gameVariants";
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
    variants: { ...STANDARD_VARIANTS, rules: CURRENT_RULES_REVISION },
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        president: "p0",
        par_value: "100",
        ipo_pool_percentage: 50,
        bank_pool_percentage: 0,
        player_holdings: [
          { player: "p0", percentage: 30 },
          { player: "p1", percentage: 20 },
        ],
        station_token_hexes: [],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}
const seatOf = (state: GameStateResponse) => state.player_addresses[state.active_player_index];
const sell = (state: GameStateResponse, percentage = 10) =>
  applySandboxAction(state, { SellStock: { game_id: 1, protocol_id: PRR, percentage } } as never, { actor: seatOf(state) });
const buy = (state: GameStateResponse) =>
  applySandboxAction(state, { BuyStock: { game_id: 1, protocol_id: PRR, source: "Ipo" } } as never, {
    actor: seatOf(state),
    sharePrice: 100,
    marketZoneFor: () => "Normal", // the shell always passes this; #1172's one-purchase guard needs it
  });
const pass = (state: GameStateResponse) => applySandboxAction(state, { PassTurn: { game_id: 1 } } as never, { actor: seatOf(state) });

describe("the revision (design note #1443)", () => {
  it("is stamped on new games and read as 0 off an old log", () => {
    expect(STANDARD_VARIANTS.rules).toBe(CURRENT_RULES_REVISION);
    expect(resolveVariants({}).rules).toBe(0);
    expect(resolveVariants({ rules: 1 }).rules).toBe(1);
    expect(sellBuySellInForce(resolveVariants({}))).toBe(false);
    expect(sellBuySellInForce(resolveVariants({ rules: 1 }))).toBe(true);
  });
});

describe("Sell-Buy-Sell: the stages of a turn", () => {
  it("opens on Sell; a sale keeps the stage (any number may be sold); a Pass moves to Buy", () => {
    const start = board();
    expect(stockTurnStage(start)).toBe("sell");
    const sold = sell(start);
    expect(sold.active_player_index).toBe(0);
    expect(stockTurnStage(sold)).toBe("sell");
    const soldTwice = sell(sold);
    expect(stockTurnStage(soldTwice)).toBe("sell");
    const toBuy = pass(soldTwice);
    expect(toBuy.active_player_index).toBe(0); // still my turn
    expect(stockTurnStage(toBuy)).toBe("buy");
  });

  it("a purchase leaves the seat with the buyer, in Sell Again; the turn ends on End Turn without counting as a pass", () => {
    const toBuy = pass(board());
    const bought = buy(toBuy);
    expect(bought.active_player_index).toBe(0);
    expect(bought.bought_this_turn).toBe(1);
    expect(stockTurnStage(bought)).toBe("sell_again");
    // A second purchase is refused, a sale is not.
    expect(buy(bought)).toBe(bought);
    const soldAfter = sell(bought);
    expect(soldAfter.active_player_index).toBe(0);
    const ended = pass(soldAfter);
    expect(ended.active_player_index).toBe(1);
    expect(ended.consecutive_passes).toBe(0);
    expect(stockTurnStage(ended)).toBe("sell");
  });

  it("a buy straight from the Sell stage is legal (skipping the selling), and a turn that did nothing passes in two", () => {
    const bought = buy(board());
    expect(bought.active_player_index).toBe(0);
    expect(stockTurnStage(bought)).toBe("sell_again");
    const p1 = pass(board());
    const p2 = pass(p1);
    expect(p2.active_player_index).toBe(1);
    expect(p2.consecutive_passes).toBe(1);
  });

  it("a turn that only sold ends on the second Pass without counting", () => {
    const ended = pass(pass(sell(board())));
    expect(ended.active_player_index).toBe(1);
    expect(ended.consecutive_passes).toBe(0);
  });

  it("under the old revision a buy still ends the turn (old logs replay unchanged)", () => {
    const legacy = board({ variants: { ...STANDARD_VARIANTS, rules: 0 } } as Partial<GameStateResponse>);
    const bought = buy(legacy);
    expect(bought.active_player_index).toBe(1);
    const passed = pass(legacy);
    expect(passed.active_player_index).toBe(1);
    expect(passed.consecutive_passes).toBe(1);
  });
});

describe("the shell walks the stages (design notes #1443/#1444)", () => {
  const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
  const app = readStripped("App.tsx");
  const bar = readStripped("panels/ContextualActionBar.tsx");

  it("stamps the revision when it deals, and hands the bar the stage", () => {
    expect(app).toContain("variants: { ...sandboxRoom.variants, rules: CURRENT_RULES_REVISION }");
    expect(app).toContain("? stockTurnStage(gameState)");
    expect(app).toContain('onShowStocks={() => setActiveMainTab("corps")}');
  });

  it("the bar shows Sell | Auto | Pass, Buy | Auto | Pass, Sell | Auto | End Turn", () => {
    expect(bar).toContain('data-testid="stock-stage-button"');
    expect(bar).toContain('{stockStage === "buy" ? "Buy a Share" : "Sell Shares"}');
    expect(bar).toContain('{stockStage === "sell_again" ? "End Turn" : stockStage !== null ? "Pass" : passButtonLabel(turnActionTaken === true)}');
    expect(bar).toContain('data-testid="auto-button"');
    expect(bar).not.toContain('{autoBuy.armed ? "Auto-Buy: On" : "Auto-Buy"}');
  });

  it("the panel greys the other stage's controls with the way forward", () => {
    expect(app).toContain("Selling comes first. Press Pass on the action bar when you are done selling to move on to buying.");
    expect(app).toContain("You have moved on to buying. Buy a share (or Pass) — you can sell again after a purchase.");
  });

  it("Auto-Buy walks the stages and arming one automation disarms the other", () => {
    expect(app).toContain('if (stage !== "buy") {');
    expect(app).toContain("setAutoBuyPlan(null); // #1444: one or the other");
    expect(app).toContain("setAutoPassArm(null); // #1444: one or the other");
    const picker = readStripped("components/AutoModePicker.tsx");
    expect(picker).toContain("One or the other — not both.");
  });
});
