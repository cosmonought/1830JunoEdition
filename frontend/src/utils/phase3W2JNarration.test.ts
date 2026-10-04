/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W2-J: NARRATION CORRECTIONS
// ==================================================================
//
// AUD-03.08 (K-18 / U-36, OD-12 RED R2) -- the sold-out rise's Activity Log line read its marks from the shell's
//   market mirror, which the dispatch had already advanced to the risen board: the line described a further,
//   hypothetical rise. It now reads the marks the reducer was HANDED (`handedBoard.market_positions`).
// AUD-10.01 (K-20 / U-33) -- a presidency change is narrated on the entry that caused it, with §5.4's clockwise
//   tie-break named when the new president was level with another holder.
// AUD-03.09 (K-22 / U-37) -- NOT IMPLEMENTED / OWNER DECISION (OD-8). See the last block.

import {
  applySandboxAction,
  describeFloat,
} from "../gameEngine/sandboxSession";
import { describeSoldOutRise, soldOutRises } from "../gameEngine/soldOutRise";
import { projectRiseMove, PRICE_GRID } from "../components/StockMarketRenderer";
import type { GameStateResponse } from "../gameEngine/gameState";
import { describeGameplayAction, type ActionLogContext } from "./actionLog";
import { expectOrder, readShell, sliceBetween } from "./sourceScan";

type State = GameStateResponse;

const PRR = 1;
const BO = 2;
const NAMES: Record<string, string> = { p0: "Ann", p1: "Bob", p2: "Cal" };

function company(over: Record<string, unknown> = {}) {
  return {
    company_id: PRR,
    ticker: "PRR",
    is_floated: true,
    president: "p0",
    par_value: "100",
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [{ player: "p0", percentage: 100 }],
    station_token_hexes: [],
    owned_trains: [],
    treasury: "0",
    ...over,
  };
}

function board(seats: string[], over: Partial<State> = {}): State {
  return {
    player_addresses: seats,
    player_cash: seats.map((player) => ({ player, cash_vgp: "2000" })),
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 2,
    active_player_index: 0,
    consecutive_passes: 0,
    priority_deal_index: 0,
    last_trader_index: null,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    public_companies: [company()],
    ...over,
  } as unknown as State;
}

const cell = (x: number, y: number) => {
  const found = PRICE_GRID.find((entry) => entry.x === x && entry.y === y);
  if (!found) throw new Error(`no chart cell at (${x}, ${y})`);
  return { x, y, price: found.price };
};

/** A real cell that can rise twice, so "the rise that happened" and "a further rise" are different numbers. */
const START = (() => {
  for (const start of PRICE_GRID) {
    const up = projectRiseMove(start);
    if (!up || (up.x === start.x && up.y === start.y)) continue;
    const again = projectRiseMove(up);
    if (!again || (again.x === up.x && again.y === up.y)) continue;
    if (start.price >= 60 && start.price <= 100) return { start: cell(start.x, start.y), up, again };
  }
  throw new Error("no chart cell rises twice");
})();

function context(before: State, after: State): ActionLogContext {
  return {
    gameState: before,
    afterState: after,
    mapGrid: { game_id: 1, tiles: [] } as unknown as ActionLogContext["mapGrid"],
    era: "yellow" as never,
    labelForAddress: (address: string) => NAMES[address] ?? address,
  };
}

/* ================================================================================================ */

describe("AUD-03.08 (K-18): the sold-out rise is described from the marks the reducer was handed", () => {
  /** The last pass of a Stock Round with PRR sold out (within the cap) and B&O not, on a charted board. */
  function closingBoard(): State {
    return board(["p0", "p1"], {
      consecutive_passes: 1,
      public_companies: [
        company({ company_id: BO, ticker: "B&O", ipo_pool_percentage: 40, player_holdings: [{ player: "p0", percentage: 60 }] }),
        company({ player_holdings: [{ player: "p0", percentage: 60 }, { player: "p1", percentage: 40 }] }),
      ],
      market_positions: {
        [BO]: { ...cell(START.start.x, START.start.y), enteredAt: 1 },
        [PRR]: { ...START.start, enteredAt: 2 },
      },
    } as never);
  }

  /** The dispatch's own two boards: the one handed to the reducer and the one it settled. */
  function dispatch() {
    const handed = closingBoard();
    const after = applySandboxAction(handed, { PassTurn: { game_id: 1 } } as never, { actor: "p1", projectRise: projectRiseMove });
    return { handed, after };
  }

  it("the reducer committed exactly one rise, PRR one cell up", () => {
    const { after } = dispatch();
    expect(after.current_round_type).toBe("OperatingRound");
    expect(after.market_positions?.[PRR]?.price).toBe(START.up.price);
    expect(after.market_positions?.[BO]?.price).toBe(START.start.price);
  });

  it("the shell's line (handed marks) names the rise that happened -- from the old price to the committed one", () => {
    const { handed, after } = dispatch();
    const rises = soldOutRises({
      before: handed,
      after,
      markFor: (companyId) => handed.market_positions?.[companyId] ?? null, // the RED R2 call's resolver
      projectRise: projectRiseMove,
    });
    expect(rises).toHaveLength(1);
    expect(rises[0]).toEqual(expect.objectContaining({ ticker: "PRR", from: START.start.price, to: START.up.price }));
    expect(rises[0].to).toBe(after.market_positions?.[PRR]?.price);
    expect(describeSoldOutRise(rises[0])).toBe(
      `PRR rose from $${START.start.price} to $${START.up.price} — sold out at the end of the Stock Round.`,
    );
  });

  it("the old resolver (the mirror, already at the risen board) described a further, hypothetical rise -- the defect", () => {
    const { handed, after } = dispatch();
    const mirror = after.market_positions; // `sandboxMarketRef.current = after.market_positions` runs first
    const stale = soldOutRises({ before: handed, after, markFor: (id) => mirror?.[id] ?? null, projectRise: projectRiseMove });
    expect(stale[0]).toEqual(expect.objectContaining({ from: START.up.price, to: START.again.price }));
    expect(stale[0].to).not.toBe(after.market_positions?.[PRR]?.price);
  });

  it("no line on a message that does not close the round", () => {
    const handed = board(["p0", "p1"], {
      public_companies: [company({ player_holdings: [{ player: "p0", percentage: 60 }, { player: "p1", percentage: 40 }] })],
      market_positions: { [PRR]: { ...START.start, enteredAt: 1 } },
    } as never);
    const after = applySandboxAction(handed, { PassTurn: { game_id: 1 } } as never, { actor: "p0", projectRise: projectRiseMove });
    expect(after.current_round_type).toBe("StockRound");
    expect(soldOutRises({ before: handed, after, markFor: (id) => handed.market_positions?.[id] ?? null, projectRise: projectRiseMove })).toEqual([]);
  });

  it("the RED R2 call reads `handedBoard.market_positions`, after the mirror write -- one edit, nothing else moved", () => {
    const shell = readShell();
    const call = sliceBetween(shell, "const rises = soldOutRises({", "});");
    expect(call).toContain("markFor: (companyId) => handedBoard?.market_positions?.[companyId] ?? null,");
    expect(call).not.toContain("marketMarkForCompany");
    expect(call).toContain("projectRise: (from) => projectRiseMove(from),");
    // The mirror is advanced to the risen board BEFORE the line is built, which is why the mirror cannot be read.
    expectOrder(shell, "const handedBoard: GameStateResponse | null = before", "sandboxMarketRef.current = after.market_positions;", "const rises = soldOutRises({");
    expect(shell.match(/const rises = soldOutRises\(\{/g)).toHaveLength(1);
  });
});

/* ================================================================================================ */

describe("AUD-10.01 (K-20): a presidency change is narrated, with its tie-break", () => {
  /** PRR: p0 presides with 40%; the challengers hold `others`. A charted board so a sale is priced. */
  function presided(seats: string[], others: Array<{ player: string; percentage: number }>): State {
    const held = 40 + others.reduce((sum, entry) => sum + entry.percentage, 0);
    return board(seats, {
      public_companies: [
        company({
          ipo_pool_percentage: 100 - held,
          player_holdings: [{ player: "p0", percentage: 40 }, ...others],
        }),
      ],
      market_positions: { [PRR]: { ...START.start, enteredAt: 1 } },
    } as never);
  }
  const SELL = (percentage: number) => ({ SellStock: { game_id: 1, protocol_id: PRR, percentage } });
  const narrate = (before: State, msg: unknown) => {
    const after = applySandboxAction(before, msg as never, { actor: "p0" });
    return { after, line: describeGameplayAction(msg as never, context(before, after)) };
  };

  it("a sale that hands the crown to the one larger holder says so on the sale's own line", () => {
    const before = presided(["p0", "p1", "p2"], [{ player: "p1", percentage: 30 }]);
    const { after, line } = narrate(before, SELL(20));
    expect(after.public_companies[0].president).toBe("p1"); // the reducer's verdict
    expect(line).toBe(
      "Ann sold 20% of PRR. Bob becomes president of PRR with 30%, taking the President's Certificate from Ann, who now holds 20%.",
    );
    expect(line).not.toContain("tie");
  });

  it("a tie names §5.4's clockwise rule, counted from the outgoing president -- and follows the seating", () => {
    const tie = [
      { player: "p1", percentage: 30 },
      { player: "p2", percentage: 30 },
    ];
    const first = narrate(presided(["p0", "p1", "p2"], tie), SELL(20));
    expect(first.after.public_companies[0].president).toBe("p1");
    expect(first.line).toBe(
      "Ann sold 20% of PRR. Bob becomes president of PRR with 30%, taking the President's Certificate from Ann, who now holds 20%. " +
        "Bob and Cal each hold 30%; the tie goes to the player seated closest to Ann going clockwise, which is Bob.",
    );
    // The same holdings at a table seated the other way round: the reducer crowns Cal, and the line says so.
    const second = narrate(presided(["p0", "p2", "p1"], tie), SELL(20));
    expect(second.after.public_companies[0].president).toBe("p2");
    expect(second.line).toContain("Cal becomes president of PRR with 30%");
    expect(second.line).toContain("Cal and Bob each hold 30%; the tie goes to the player seated closest to Ann going clockwise, which is Cal.");
  });

  it("review fix: the level holders are listed clockwise from the outgoing president, the winner first", () => {
    // p1 presides with 40%, p0 and p2 at 30%; p1 sells 20%. Seated p0, p1, p2: clockwise from p1 is p2 then p0.
    const before = board(["p0", "p1", "p2"], {
      active_player_index: 1,
      public_companies: [
        company({
          president: "p1",
          ipo_pool_percentage: 0,
          player_holdings: [
            { player: "p0", percentage: 30 },
            { player: "p1", percentage: 40 },
            { player: "p2", percentage: 30 },
          ],
        }),
      ],
      market_positions: { [PRR]: { ...START.start, enteredAt: 1 } },
    } as never);
    const after = applySandboxAction(before, SELL(20) as never, { actor: "p1" });
    expect(after.public_companies[0].president).toBe("p2");
    const line = describeGameplayAction(SELL(20) as never, context(before, after));
    expect(line).toContain("Cal and Ann each hold 30%; the tie goes to the player seated closest to Bob going clockwise, which is Cal.");
  });

  it("no presidency sentence when the crown does not move (an equal holding leaves it where it is)", () => {
    const before = presided(["p0", "p1", "p2"], [{ player: "p1", percentage: 30 }]);
    const { after, line } = narrate(before, SELL(10));
    expect(after.public_companies[0].president).toBe("p0");
    expect(line).toBe("Ann sold 10% of PRR.");
  });

  it("a corporation's FIRST president is not a change: the opening purchase keeps its one sentence", () => {
    const before = board(["p0", "p1"], {
      public_companies: [company({ is_floated: false, president: null, par_value: null, ipo_pool_percentage: 100, player_holdings: [] })],
    } as never);
    const msg = { BuyStock: { game_id: 1, protocol_id: PRR, source: "Ipo", par_value: "100" } };
    const after = applySandboxAction(before, msg as never, { actor: "p0" });
    expect(after.public_companies[0].president).toBe("p0");
    const line = describeGameplayAction(msg as never, context(before, after));
    expect(line).toBe("Ann bought the 20% President's Certificate of PRR from the IPO for $200, setting par at $100.");
    expect(line).not.toContain("becomes president");
  });

  it("said once: the sentence is read off the two boards, so the same entry rebuilt gives the same single line", () => {
    const before = presided(["p0", "p1", "p2"], [{ player: "p1", percentage: 30 }]);
    const { after, line } = narrate(before, SELL(20));
    const again = describeGameplayAction(SELL(20) as never, context(before, after));
    expect(again).toBe(line);
    expect((line ?? "").match(/becomes president/g)).toHaveLength(1);
    // Without the settled board (a live chain) nothing is guessed.
    expect(describeGameplayAction(SELL(20) as never, { ...context(before, after), afterState: undefined })).toBe("Ann sold 20% of PRR.");
  });
});

/* ================================================================================================ */

describe("AUD-03.09 (K-22): NOT IMPLEMENTED — OWNER DECISION (OD-8); characterisation only, not a pass for the row", () => {
  /* OD-8 is open: (a) "floated" at the float plus "placed its home" later, or (b) one line at the placement (the
     current #1343 sentence, which #1616 moved to the corporation's first operating turn). This block records the
     CURRENT behaviour the decision is about; it is not a pass for AUD-03.09. */
  it("NOT IMPLEMENTED (OD-8): pins today's behaviour -- a float that owes a home token prints nothing at the float", () => {
    const line = describeFloat(
      { is_floated: false, station_token_hexes: [] },
      { company_id: PRR, ticker: "PRR", treasury: "1000", is_floated: true, home_hex_label: "H12", station_token_hexes: [] },
    );
    expect(line).toBeNull();
  });
});
