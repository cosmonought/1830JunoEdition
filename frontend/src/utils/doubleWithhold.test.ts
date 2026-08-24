/** @jest-environment node */
//
// One corporation, one dividend declaration per turn -- on the board and on the chart. No React.
//
// ==================================================================
//  DESIGN NOTE 774 (harness): TWO BROWSERS, TWO MESSAGES, TWO CELLS
// ==================================================================
//
// REPORTED: "B&O parred at $100. After the first OR (no train to run), its share price moved two cells left
// rather than one."
//
// THE ARITHMETIC RULED OUT EVERY OTHER SUSPECT FIRST, and that is the only reason this file is about
// duplicates at all. Par $100 is cell (6,10). One step left is (5,10), $90. `projectDividendCellMove` walks
// exactly one column and clamps at the edge, so it cannot produce a two-cell move however it is called.
// A single message could not have done this; two of them could.
//
// THE TEST THAT MATTERS IS THE REPLAY, not the predicate. `dividendRefusal` returning a string proves
// nothing on its own -- #757 shipped a predicate that was never asked, and #766's test pinned the bug it was
// written to catch. So the central case here applies the SAME message twice through the real reducer and the
// real market atom, in the order the drain applies them, and counts cells.
//
// WHAT THIS FILE CANNOT DO is prove that two browsers were the source. It proves that two arrivals now move
// one cell, which is the property that matters and is true whatever produced the second one.

import { applySandboxAction, applySandboxMarketAction } from "./sandboxSession";
import { dividendRefusal, operatingCorporationId } from "./dividendGate";
import { projectDividendCellMove } from "../components/StockMarketRenderer";
import type { GameStateResponse } from "./gameState";
import type { SandboxMarketPrices } from "./sandboxState";

const BO = 6;
const PRR = 1;

/** Par $100 on the real ladder: `PAR_VALUE_LADDER` puts it at (6, 10). */
const PAR_100 = { price: 100, x: 6, y: 10 } as const;

/** B&O operating, trainless, parked on the Dividends step -- the reported board. */
function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Dividends",
    macro_round_number: 2,
    sub_round_index: 0,
    active_player_index: 0,
    active_operating_order: [BO, PRR],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: BO,
        ticker: "B&O",
        is_floated: true,
        president: "p1",
        par_value: "100",
        home_hex_label: "I15",
        ipo_pool_percentage: 30,
        bank_pool_percentage: 0,
        treasury: "400",
        last_route_revenue: "0",
        player_holdings: [{ player: "p1", percentage: 60 }],
        station_token_hexes: [[0, 0]],
        owned_trains: [],
      },
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: "p2",
        par_value: "90",
        home_hex_label: "H12",
        ipo_pool_percentage: 40,
        bank_pool_percentage: 0,
        treasury: "300",
        last_route_revenue: "0",
        player_holdings: [{ player: "p2", percentage: 60 }],
        station_token_hexes: [[1, 0]],
        owned_trains: [],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

const chart = (): SandboxMarketPrices => ({ [BO]: { ...PAR_100 }, [PRR]: { price: 90, x: 6, y: 9 } });

const withhold = (companyId = BO) =>
  ({
    DeclareDividends: {
      game_id: 1,
      protocol_id: companyId,
      revenue_amount: "0",
      distribute: false,
    },
  }) as never;

/** The drain's order of operations, for one message: the chart first (#272/#273), then the board. */
function applyBoth(
  state: GameStateResponse,
  prices: SandboxMarketPrices,
  msg: ReturnType<typeof withhold>,
): { state: GameStateResponse; prices: SandboxMarketPrices } {
  const market = applySandboxMarketAction(prices, msg, {
    projectDividend: (from, choice) => projectDividendCellMove(from, choice),
    dividendRefused: (companyId) => dividendRefusal(state, companyId) !== null,
  });
  return { state: applySandboxAction(state, msg), prices: market.prices };
}

describe("the projection was never the problem", () => {
  it("walks exactly one column left from par $100", () => {
    /* Stated first because it is what makes the rest of this file the right investigation: if a single
       withhold could move two cells, none of the duplicate work below would be the fix. */
    expect(projectDividendCellMove(PAR_100, "withhold")).toEqual({ price: 90, x: 5, y: 10 });
  });

  it("walks one column right on a payout", () => {
    expect(projectDividendCellMove(PAR_100, "pay")).toEqual({ price: 112, x: 7, y: 10 });
  });
});

describe("the reported turn, replayed", () => {
  it("moves one cell for one declaration", () => {
    /* THE CONTROL, and it has to come first: a gate that also refuses the legitimate move would brick every
       Operating Round while making the reported symptom go away. */
    const after = applyBoth(board(), chart(), withhold());
    expect(after.prices[BO]).toMatchObject({ price: 90, x: 5, y: 10 });
    expect(after.state.operating_sub_phase).toBe("Hardware");
  });

  it("moves one cell for two", () => {
    /* THE REPORT. Two arrivals of the same forced withhold -- one per browser -- applied in the order the
       drain applies them. Before #774 the second walked the token to $82. */
    const first = applyBoth(board(), chart(), withhold());
    const second = applyBoth(first.state, first.prices, withhold());
    expect(second.prices[BO]).toMatchObject({ price: 90, x: 5, y: 10 });
  });

  it("moves one cell for five", () => {
    /* A five-player table is five browsers. Keyed on the cursor rather than on a count, so the number of
       clients never enters into it. */
    let carried = { state: board(), prices: chart() };
    for (let client = 0; client < 5; client += 1) {
      carried = applyBoth(carried.state, carried.prices, withhold());
    }
    expect(carried.prices[BO]).toMatchObject({ price: 90 });
  });

  it("credits the treasury once", () => {
    /* THE HALF THAT WOULD HAVE BEEN WORSE AND WAS NEVER REPORTED: a withhold credits the corporation, so a
       duplicate declaration is free money as well as a free price step.
       A REAL REVENUE, NOT THE REPORTED $0. The first draft of this test withheld zero and passed with the
       gate REMOVED -- twice nothing is nothing, so it proved only that the fixture was quiet. #490a's lesson
       in a different key: a test has to be able to fail. */
    const earning = board({
      public_companies: board().public_companies.map((company) =>
        company.company_id === BO ? { ...company, last_route_revenue: "100" } : company,
      ),
    } as Partial<GameStateResponse>);
    const msg = {
      DeclareDividends: { game_id: 1, protocol_id: BO, revenue_amount: "100", distribute: false },
    } as never;
    const first = applyBoth(earning, chart(), msg);
    const second = applyBoth(first.state, first.prices, msg);
    expect(Number(first.state.public_companies[0].treasury)).toBe(500);
    expect(second.state.public_companies[0].treasury).toBe(
      first.state.public_companies[0].treasury,
    );
  });

  it("pays a real dividend exactly once", () => {
    const paying = board({
      public_companies: board().public_companies.map((company) =>
        company.company_id === BO ? { ...company, last_route_revenue: "100" } : company,
      ),
    } as Partial<GameStateResponse>);
    const msg = {
      DeclareDividends: { game_id: 1, protocol_id: BO, revenue_amount: "100", distribute: true },
    } as never;
    const first = applyBoth(paying, chart(), msg);
    const second = applyBoth(first.state, first.prices, msg);
    const cashOf = (state: GameStateResponse) =>
      state.player_cash.find((entry) => entry.player === "p1")?.cash_vgp;
    expect(cashOf(second.state)).toBe(cashOf(first.state));
    expect(second.prices[BO]).toMatchObject({ price: 112 });
  });
});

describe("the rule, stated on its own", () => {
  it("allows the declaration at the Dividends step", () => {
    expect(dividendRefusal(board(), BO)).toBeNull();
  });

  it("refuses one after the cursor has moved on", () => {
    expect(dividendRefusal(board({ operating_sub_phase: "Hardware" }), BO)).toMatch(
      /already settled its dividends/,
    );
  });

  it("refuses one at a step that has not got there yet", () => {
    /* Not only "already done". The cursor names the step that owns the choice, so a declaration arriving
       during Track is equally out of order -- which is what makes this a rule rather than a de-duplicator. */
    expect(dividendRefusal(board({ operating_sub_phase: "Track" }), BO)).not.toBeNull();
  });

  it("refuses one outside an Operating Round", () => {
    expect(dividendRefusal(board({ current_round_type: "StockRound" }), BO)).toMatch(
      /Operating Round/,
    );
  });

  it("refuses one for a corporation that is not operating", () => {
    // PRR is second in the queue; its dividend is not this turn's business.
    expect(dividendRefusal(board(), PRR)).toMatch(/Only the operating corporation/);
  });

  it("allows a state that does not report a cursor at all", () => {
    /* DELIBERATE, and the one place this gate declines to judge: `operating_sub_phase` is optional, and a
       seeded board arriving without one is a missing field rather than a broken rule. Refusing there would
       brick a game to catch a duplicate that always carries a cursor. */
    expect(dividendRefusal(board({ operating_sub_phase: undefined }), BO)).toBeNull();
  });

  it("names the operating corporation from the queue", () => {
    expect(operatingCorporationId(board())).toBe(BO);
    expect(operatingCorporationId(board({ active_corporation_index: 1 }))).toBe(PRR);
    expect(operatingCorporationId(board({ current_round_type: "StockRound" }))).toBeNull();
  });
});

describe("the chart refuses what the board refuses", () => {
  it("leaves the token alone on a refused declaration", () => {
    /* #748a's split, which is why the market atom needed its own callback: it advances FIRST, so a reducer
       refusal alone would have left the chart walking and the board still. The visible symptom of that is a
       price move with nothing behind it -- the reported bug, with the fix half-applied. */
    const settled = board({ operating_sub_phase: "Hardware" });
    const result = applySandboxMarketAction(chart(), withhold(), {
      projectDividend: (from, choice) => projectDividendCellMove(from, choice),
      dividendRefused: (companyId) => dividendRefusal(settled, companyId) !== null,
    });
    expect(result.moved).toBeNull();
    expect(result.prices[BO]).toMatchObject({ price: 100 });
  });

  it("still moves it when nobody refuses", () => {
    const result = applySandboxMarketAction(chart(), withhold(), {
      projectDividend: (from, choice) => projectDividendCellMove(from, choice),
    });
    expect(result.moved).toMatchObject({ companyId: BO, from: 100, to: 90, reason: "withhold" });
  });
});

describe("only the client on turn dispatches the derived actions", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    // #490a: both notes quote the missing check while explaining it.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  const between = (start: string, end: string) =>
    APP.slice(APP.indexOf(start), APP.indexOf(end));

  it("gates the forced withhold on isMyTurn", () => {
    /* THE SOURCE OF THE DUPLICATE. Every other condition in that effect is shared state, replayed the same
       on every browser, so this is the only line that distinguishes one client from the rest. */
    const effect = between("const forcedWithholdRef", "const autoSkippedRef");
    expect(effect).toContain("if (!isMyTurn) return;");
  });

  it("gates the auto-skip on isMyTurn", () => {
    /* Its twin, fixed at the same time. It produced no reported symptom because a repeated cursor step
       usually lands where it was going anyway -- which is exactly how it would have kept shipping. */
    const effect = between("const autoSkippedRef", "skipSubPhaseAutomatically();");
    expect(effect).toContain("if (!isMyTurn) return;");
  });

  it("keeps the turn as a dependency of both", () => {
    // A gate read from a stale closure is not a gate.
    const withholdEffect = between("const forcedWithholdRef", "const autoSkippedRef");
    expect(withholdEffect).toContain("isMyTurn,");
  });

  it("leaves the automatic exemption in the turn gate alone", () => {
    /* RECORDED AS A DECISION. The obvious alternative fix is to stop exempting `automatic` from the turn
       gate -- and it is wrong: those messages are dispatched for a corporation whose president is the client
       sending them, and #701's consent answers rely on the same escape hatch working for `offTurn`. The
       ownership check belongs in the effects, which know which player they are acting for. */
    expect(APP).toContain("options?.automatic !== true &&");
  });

  it("asks the reducer for the same refusal the chart asks", () => {
    expect(APP).toContain("dividendRefused: (companyId) =>");
  });
});
