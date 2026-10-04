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
// AUD-03.09 (K-22 / U-37, OD-8 RULED 2026-10-04, Option A) -- the float and its capital are said at the purchase that
//   floats the corporation; the home placement, at its first operating turn, says only that it was placed.

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

describe("AUD-03.09 (K-22, OD-8 RULED Option A): the float is said at the purchase, the home at its placement", () => {
  /* A REAL game: dealt by the room engine (delayed auction, so Stock Round 1 opens at once), PRR parred and bought to
     60% through both locks, the round closed, and PRR's home placed at the start of its first operating turn. Every
     step is narrated the way the shell narrates it: the message's own sentence (`describeGameplayAction`, on the
     before/after boards) and the float lines the shell's loop reads off every company (`describeFloat`). */
  type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;
  const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
  const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
  const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
  const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
  const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
  const { actingAddress } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
  const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
  const { pendingHomeTokens } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
  const { boardHomeHexToAxial } = require("../gameEngine/homeStationAuthority") as typeof import("../gameEngine/homeStationAuthority");
  const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");

  const [A, B, C] = ["p0", "p1", "p2"];
  const GRID = { game_id: 1, tiles: [] } as unknown as ActionLogContext["mapGrid"];
  let serial = 0;
  const entry = (actor: string, msg: unknown) =>
    RL.entriesFromExport([{ index: serial, id: `w2j-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];
  const boardOf = (engine: Engine): State => ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
  const seatOf = (state: State) => state.player_addresses[state.active_player_index];
  const prr = (state: State) => state.public_companies.find((entry) => entry.ticker === "PRR")!;

  /** The shell's narration of one applied entry: the entry's sentence, then the float lines (`logInfo("Float", …)`). */
  type Narrated = { kind: string; lines: string[] };
  const log: Narrated[] = [];
  function send(engine: Engine, actor: string, msg: unknown) {
    const before = boardOf(engine);
    expect([Object.keys(msg as object)[0], turnRefusal({ state: before, waterfall: before.waterfall ?? null, actor, msg: msg as never })]).toEqual([
      Object.keys(msg as object)[0],
      null,
    ]);
    engine.apply(entry(actor, msg));
    const after = boardOf(engine);
    const lines: string[] = [];
    const sentence = describeGameplayAction(msg as never, { ...context(before, after), mapGrid: GRID });
    if (sentence) lines.push(sentence);
    for (const company of after.public_companies) {
      const previously = before.public_companies.find((entry) => entry.company_id === company.company_id);
      const line = previously ? describeFloat(previously, company) : null;
      if (line) lines.push(line);
    }
    log.push({ kind: Object.keys(msg as object)[0], lines });
    return { before, after, lines };
  }

  function play() {
    log.length = 0;
    const seed = withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default"));
    const waterfall = waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []);
    const engine: Engine = new RL.RoomEngine(
      { ...sandboxReplayProviders(), ...(seed.market_positions ? { initialMarket: seed.market_positions } : {}) } as never,
      { state: { ...seed, waterfall }, waterfall } as never,
    );
    engine.apply(
      entry(A, {
        SetupGame: {
          players: [
            { id: A, nickname: "Ann" },
            { id: B, nickname: "Bob" },
            { id: C, nickname: "Cal" },
          ],
          variants: { delayedAuction: true, length: "standard", rules: 1 },
          rules_engine_version: RULES_ENGINE_VERSION,
        },
      }),
    );
    const id = prr(boardOf(engine)).company_id;
    const buy = (par?: number) => {
      const player = seatOf(boardOf(engine));
      send(engine, player, { PassTurn: { game_id: 0 } }); // declines to sell (#1443)
      const bought = send(engine, player, {
        BuyStock: { game_id: 0, protocol_id: id, source: "Ipo", ...(par === undefined ? {} : { par_value: String(par) }) },
      });
      send(engine, player, { PassTurn: { game_id: 0 } });
      return bought;
    };
    const purchases = [buy(100), buy(), buy(), buy(), buy()]; // A 20%, B 10%, C 10%, A 10%, B 10% = 60%
    for (let guard = 0; boardOf(engine).current_round_type === "StockRound"; guard += 1) {
      if (guard > 12) throw new Error("the Stock Round did not end");
      send(engine, seatOf(boardOf(engine)), { PassTurn: { game_id: 0 } });
    }
    const opened = boardOf(engine);
    const owed = pendingHomeTokens(opened, boardHomeHexToAxial, GRID as never)[0] ?? null;
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === owed?.hexLabel)!;
    const placed = send(engine, owed!.president!, {
      PlaceHomeStation: { game_id: 1, company_id: id, q: hex.q, r: hex.r, kind: "home", city_index: null, hex_label: owed!.hexLabel },
    });
    return { purchases, opened, owed, placed };
  }

  it("1-2. the purchase that takes PRR to 60% floats it, and that entry says so with the capital it actually received", () => {
    const { purchases } = play();
    const floating = purchases.findIndex(({ before, after }) => !prr(before).is_floated && prr(after).is_floated);
    expect(floating).toBe(4); // the fifth purchase: 60%
    const { after, lines } = purchases[floating];
    expect(Number(prr(after).treasury)).toBe(1000); // 10 x par, on the settled board
    // The purchase's own sentence (priced by the shell's chart, which this harness does not pass), then the float.
    expect(lines).toEqual(["Bob bought a 10% share of PRR from the IPO.", "PRR has floated. It received $1000."]);
    // No earlier purchase said anything about a float.
    for (const earlier of purchases.slice(0, floating)) expect(earlier.lines.join(" ")).not.toContain("floated");
  });

  it("3. nothing about the home station is said at the float", () => {
    const { purchases } = play();
    expect(purchases[4].lines.join(" ")).not.toMatch(/home station/i);
  });

  it("4. the home line is said when the home is actually placed, at PRR's first operating turn -- and only that", () => {
    const { opened, owed, placed } = play();
    expect(opened.current_round_type).toBe("OperatingRound");
    expect(owed).toMatchObject({ ticker: "PRR", president: A });
    expect(prr(placed.after).station_token_hexes?.length).toBe(1); // the reducer placed it
    expect(placed.lines).toEqual([`PRR placed its home station on ${owed!.hexLabel}.`]);
  });

  it("5-6. the old combined line never appears, and the float and the home are each said exactly once", () => {
    play();
    const all = log.flatMap((step) => step.lines);
    expect(all.join("\n")).not.toContain("is placed.");
    expect(all.join("\n")).not.toMatch(/has floated\..*home station/);
    expect(all.filter((line) => line.includes("PRR has floated."))).toHaveLength(1);
    expect(all.filter((line) => line.includes("placed its home station"))).toHaveLength(1);
  });

  it("a herald home and NNH keep their float lines (only the owed-home case changed)", () => {
    expect(describeFloat({ is_floated: false }, { ticker: "NNH", treasury: "670", is_floated: true, home_hex_label: null })).toBe(
      "NNH has floated. It received $670. It has no home hex on this board, so no home token is placed.",
    );
    expect(describeFloat({ is_floated: true }, { ticker: "PRR", treasury: "1000", is_floated: true, home_hex_label: "H12" })).toBeNull();
  });
});
