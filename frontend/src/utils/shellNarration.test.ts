/** @jest-environment node */
//
// Design note #1246 (harness): the retired shell messages narrate from `describeGameplayAction`.
//
// Each retirement kept the shell's SENTENCE as a `logInfo` and let the state fall through -- and the general
// path then printed its own entry for the same message, labelled with the drain's fallback ("Sandbox room")
// on every server-path entry. `ExchangePrivate` comes off the shell here (the fifth of the ten), and the
// sentences for it, `SetBoPar` and `OpenStockRound` move to where every other message's lives.

export {};

const { describeGameplayAction } = require("./actionLog") as typeof import("./actionLog");
const { refusalReasonFor } = require("./refusedAction") as typeof import("./refusedAction");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const BO = 2;

const board = (over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [
      { private_id: 5, name: "Mohawk & Hudson", owner: "p1", face_value: "110", is_closed: false },
      { private_id: 6, name: "Camden & Amboy", owner: "p2", face_value: "160", is_closed: false },
    ],
    current_round_type: "StockRound",
    macro_round_number: 1,
    sub_round_index: 1,
    active_player_index: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: BO,
        ticker: "B&O",
        is_floated: false,
        president: null,
        par_value: null,
        treasury: "0",
        last_route_revenue: "0",
        player_holdings: [],
        station_token_hexes: [],
        owned_trains: [],
      },
    ],
    ...over,
  }) as unknown as GameStateResponse;

const context = (before: GameStateResponse) => ({
  gameState: before,
  afterState: undefined,
  mapGrid: { game_id: 1, tiles: [] } as unknown as MapGridResponse,
  era: "Yellow" as const,
  labelForAddress: (address: string) => (address === "p1" ? "Host" : "sandbox"),
});

describe("#1246: the sentences that left the shell", () => {
  it("SetBoPar", () => {
    const line = describeGameplayAction(
      { SetBoPar: { player: "p1", par_value: "100" } } as never,
      context(board()) as never,
    );
    expect(line).toBe("Host receives the B&O President's Certificate and pars it at $100.");
  });

  it("OpenStockRound, from the auction only", () => {
    const fromAuction = describeGameplayAction(
      { OpenStockRound: {} } as never,
      context(board({ current_round_type: "WaterfallAuction" })) as never,
    );
    expect(fromAuction).toBe("The Waterfall Auction is complete — Stock Round 1 begins.");
    const delayed = describeGameplayAction(
      { OpenStockRound: {} } as never,
      context(board({ current_round_type: "WaterfallAuction", macro_round_number: 3 })) as never,
    );
    expect(delayed).toContain("Stock Round 3 begins");
    // A duplicate against an open round is the reducer's no-op (#546); no sentence announces a round that did not begin.
    expect(describeGameplayAction({ OpenStockRound: {} } as never, context(board()) as never)).toBeNull();
  });

  it("ExchangePrivate, both shapes (#576)", () => {
    const closes = describeGameplayAction(
      { ExchangePrivate: { private_id: 5, company_id: BO, player: "p1", source: "Ipo" } } as never,
      context(board()) as never,
    );
    expect(closes).toBe("Host exchanged the Mohawk & Hudson for a 10% share of B&O. The private company closes.");
    const stays = describeGameplayAction(
      { ExchangePrivate: { private_id: 6, company_id: BO, player: "p2", source: "Ipo", keep_open: true } } as never,
      context(board()) as never,
    );
    expect(stays).toBe("sandbox receives a free 10% share of B&O with the Camden & Amboy, which stays open.");
  });

  it("a refused SetBoPar names the reducer's own reason", () => {
    /* The shell used to print `boPresidencyRefusal`'s sentence itself; the REFUSED line carries it now, from
       the same call on the same before-state (#784's rule). A B&O already parred is the simplest refusal. */
    const parred = board({
      public_companies: [{ ...(board().public_companies[0] as object), par_value: "100", president: "p2" }],
    } as never);
    const reason = refusalReasonFor(parred, { SetBoPar: { player: "p1", par_value: "100" } } as never);
    expect(typeof reason).toBe("string");
    expect(reason).not.toBe("");
  });
});

describe("#1246: the shell no longer narrates them, or applies ExchangePrivate", () => {
  const APP = readStripped("App.tsx");

  it("ExchangePrivate has no shell branch", () => {
    expect(APP).not.toContain("isExchangePrivateMsg(msg)");
    expect(APP).not.toContain("applyPrivateExchange(base,");
  });

  it("the SetBoPar branch only closes the prompt", () => {
    const start = APP.indexOf("if (isSetBoParMsg(msg)) {");
    const end = APP.indexOf("if (isSetupGameMsg(msg)) {", start);
    expect(start).toBeGreaterThan(-1);
    const branch = APP.slice(start, end);
    expect(branch).toContain("setBoParPrompt(null);");
    expect(branch).not.toContain("logInfo(");
    expect(branch).not.toContain("boPresidencyRefusal(");
  });
});
