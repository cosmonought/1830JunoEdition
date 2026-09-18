/** @jest-environment node */
//
// ==================================================================
//  STAGE 8.5: THE FIVE CLOSURE MATRICES, AND THE STATIC AUDITS
// ==================================================================
//
// Stage 8 moved five rules out of the reducer's arms and into authorities of their own: the operating order
// (8.1), the home station (8.2), the presidency (8.3), the M&H exchange (8.4), and -- across all four -- the
// authoritative holds (#1613). Each slice's own suite proves its BEHAVIOUR on built boards; what none of them
// states is the RULE AS A TABLE, every cell at once, so that a later reader can see the whole of what the
// authority answers rather than the cases one slice happened to need.
//
// THAT IS WHAT THIS FILE IS. Every matrix asks the authority function directly, prints the grid it produced,
// and compares it against the grid written out below it. Nothing here rebuilds a slice suite's scenarios:
// where a cell is already owned by a green suite, the owner is named in a comment beside it and this file
// asserts only the authority's own answer, which is cheap and is the thing the table is about.
//
//   §11 operating order        -- `operatingOrder.ts`      (owners: operatingOrderTieBreak, operatingQueueSettle)
//   §12 hold x message x round -- `authoritativeHoldRefusal` (owner: holdBeforeChart)
//   §13 home placement         -- `homeStationAuthority.ts` (owners: homeStationAuthority, homeStationWait)
//   §14 presidency             -- `presidencyTransfer.ts`   (owners: presidencyAuthority, presidencyTransfer)
//   §15 M&H exchange           -- `mohawkExchange.ts`       (owner: mohawkExchangeAuthority)
//   §16 static source audits   -- the eight patterns Stage 8 was supposed to remove
//
// NOTHING HERE WRITES: no golden is repinned, no expectation is re-derived from the new engine, and every
// board is built in this file or by the shared Batch-7.4 fixtures.

export {};

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { GameplayExecuteMsg } from "./sessionKey";

import {
  buildOperatingOrder,
  compareOperatingOrder,
  operatingOrderKey,
  settleOperatingQueue,
  type OperatingOrderKey,
} from "../gameEngine/operatingOrder";
import { authoritativeHoldRefusal } from "../gameEngine/sandboxSession";
import { pendingDiscardBlock } from "../gameEngine/trainDiscard";
import { pendingOfferBlock } from "../gameEngine/pendingOfferHold";
import { emergencyFundingBlock } from "../gameEngine/emergencyFunding";
import {
  boardHomeHexToAxial,
  homeEstablished,
  homeHexChoicesFor,
  homeIsHerald,
  homeStationHold,
  owedHomeStation,
  passesHomeStationHold,
} from "../gameEngine/homeStationAuthority";
import { PRESIDENT_CERTIFICATE_PERCENT, presidentAfterSale, presidentFor, settlePresidencies } from "../gameEngine/presidencyTransfer";
import {
  MH_EXCHANGE_TICKER,
  mhExchangeDisposition,
  mhExchangeRefusal,
  mhExchangeRequestRefusal,
  mhSourceRefusal,
  type MhExchangeRequest,
} from "../gameEngine/mohawkExchange";
import { STANDARD_BOARD, activateBoard } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { readStripped } from "./sourceScan";
import { board, operatingBoard, stockRoundBoard, P1, P2, P3, PRR, NYC, CO, DH, MH } from "./offerFixtures74";
import { M, corridor, fundingBoard, withCorp, withState } from "./offerMatrix74Support";

const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
const table = boardHomeHexToAxial;
const holds = (state: GameStateResponse, msg: unknown, mapGrid: MapGridResponse = GRID) =>
  authoritativeHoldRefusal(state, msg as GameplayExecuteMsg, { mapGrid, homeHexToAxial: table });

/** A grid is printed once and compared as ONE value: a per-cell assertion reports the first failure and hides
 *  the shape of the disagreement, which on a table is the whole diagnosis. */
const show = (title: string, lines: readonly string[]): void => {
  // eslint-disable-next-line no-console
  console.log([title, ...lines.map((line) => `  ${line}`)].join("\n"));
};

/* ================================================================================================= */
/* §11  THE OPERATING ORDER (rule 6.0), as one table                                                  */
/* ================================================================================================= */

describe("§11 the operating-order matrix (rule 6.0; Slice 8.1, #1600/#1601)", () => {
  /** A key built from the four raw inputs the reader normalises, so the comparator is asked exactly what the
   *  chart would give it. */
  const key = (
    id: number,
    price: number | null,
    par: string | null,
    mark: { x?: number; y?: number; enteredAt?: number } | null,
  ): OperatingOrderKey => operatingOrderKey(id, price, par, mark);

  const first = (a: OperatingOrderKey, b: OperatingOrderKey): number => (compareOperatingOrder(a, b) < 0 ? a.companyId : b.companyId);

  it("11.1 the comparator's five levels, each decided with every higher level tied", () => {
    const cells: Array<[string, number, number]> = [
      // level, winner, expected
      [
        "1 price desc beats a better column",
        first(key(1, 90, null, { x: 0, y: 0, enteredAt: 1 }), key(2, 80, null, { x: 9, y: 9, enteredAt: 0 })),
        1,
      ],
      [
        "2 equal price -> column desc (rightmost first, #647)",
        first(key(1, 90, null, { x: 3, y: 9, enteredAt: 0 }), key(2, 90, null, { x: 7, y: 0, enteredAt: 9 })),
        2,
      ],
      [
        "3 equal price+column -> row desc (furthest up, #1531)",
        first(key(1, 90, null, { x: 5, y: 2, enteredAt: 0 }), key(2, 90, null, { x: 5, y: 6, enteredAt: 9 })),
        2,
      ],
      [
        "4 equal price+column+row -> arrival asc (the token on top, 4.5/#646)",
        first(key(1, 90, null, { x: 5, y: 6, enteredAt: 8 }), key(2, 90, null, { x: 5, y: 6, enteredAt: 3 })),
        2,
      ],
      [
        "5 all four tied -> companyId asc, so the sort stays TOTAL (#468)",
        first(key(7, 90, null, { x: 5, y: 6, enteredAt: 3 }), key(2, 90, null, { x: 5, y: 6, enteredAt: 3 })),
        2,
      ],
    ];
    show("§11.1 comparator levels (winner)", cells.map(([label, got]) => `${label} -> ${got}`));
    expect(cells.map(([label, got]) => `${label}=${got}`)).toEqual(cells.map(([label, , want]) => `${label}=${want}`));
  });

  it("11.2 the fallbacks, which are what make the key finite on every board", () => {
    const rows = [
      ["priced and marked", key(1, 90, "67", { x: 5, y: 6, enteredAt: 2 })],
      ["no price, par only (#468)", key(1, null, "67", { x: 5, y: 6, enteredAt: 2 })],
      ["no price, no par", key(1, null, null, { x: 5, y: 6, enteredAt: 2 })],
      ["priced, unmarked (#647/#1531)", key(1, 90, "67", null)],
      ["marked, no arrival (#646)", key(1, 90, "67", { x: 5, y: 6 })],
      ["a NaN par is coerced, never propagated", key(1, null, "abc", null)],
    ] as const;
    show(
      "§11.2 key fallbacks",
      rows.map(([label, k]) => `${label}: price ${k.price}, column ${k.column}, row ${k.row}, arrival ${k.arrival}`),
    );
    expect(rows.map(([label, k]) => `${label}: ${k.price}/${k.column}/${k.row}/${k.arrival}`)).toEqual([
      "priced and marked: 90/5/6/2",
      "no price, par only (#468): 67/5/6/2",
      "no price, no par: 0/5/6/2",
      "priced, unmarked (#647/#1531): 90/-Infinity/-Infinity/Infinity",
      "marked, no arrival (#646): 90/5/6/Infinity",
      "a NaN par is coerced, never propagated: 0/-Infinity/-Infinity/Infinity",
    ]);
    // Every field finite-or-infinite, never NaN: the property #468 is about.
    for (const [, k] of rows) for (const value of [k.price, k.column, k.row, k.arrival]) expect(Number.isNaN(value)).toBe(false);
  });

  it("11.3 MEMBERSHIP is floated-with-a-president, and nothing else (#411)", () => {
    const state = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, price: 90 },
        { id: NYC, ticker: "NYC", president: null, price: 100 }, // parred, presidentless: not in the round
        { id: CO, ticker: "C&O", president: P3, price: 80, floated: false }, // presided, unfloated: not in the round
        { id: 7, ticker: "NNH", president: P2, price: 95 },
      ],
    });
    const order = buildOperatingOrder(state);
    show("§11.3 membership", [`built ${JSON.stringify(order)} from four corporations`]);
    expect(order).toEqual([7, PRR]); // NNH $95 then PRR $90; NYC and C&O are not members at all
  });

  it("11.4 THE SETTLE NEVER INSERTS AND NEVER DEMOTES A CORPORATION THAT HAS OPERATED (#1600)", () => {
    /* The cursor is on the second corporation, so the first two are frozen; the tail is re-sorted only.
       A corporation that floats mid-round is not a member and cannot be added -- 5.3's "begins operating in
       the NEXT operating round" falls out of the settle's shape rather than being a rule it knows. */
    const before = board({
      round: "OperatingRound",
      corps: [
        { id: PRR, ticker: "PRR", president: P1, price: 90 },
        { id: NYC, ticker: "NYC", president: P2, price: 100 },
        { id: CO, ticker: "C&O", president: P3, price: 60 },
        { id: 7, ticker: "NNH", president: P2, price: 70 },
      ],
      operating: NYC,
      over: { active_operating_order: [PRR, NYC, CO, 7] },
    });
    // The chart moves: C&O's mark rises above NNH's, so the WAITING tail re-sorts.
    const after = withState(before, {
      market_positions: { ...before.market_positions, [CO]: { price: 140, x: 9, y: 6, enteredAt: 3 } },
    });
    const settled = settleOperatingQueue(before, after);
    const floatedMidRound = withState(settled, {
      public_companies: [...settled.public_companies, { ...settled.public_companies[0], company_id: 9, ticker: "B&M", president: P1 }],
    });
    show("§11.4 settle", [
      `before ${JSON.stringify(before.active_operating_order)} cursor ${before.active_corporation_index}`,
      `after  ${JSON.stringify(settled.active_operating_order)}`,
      `a corporation floated mid-round is still absent: ${JSON.stringify(
        settleOperatingQueue(settled, floatedMidRound).active_operating_order,
      )}`,
    ]);
    // Frozen prefix kept (PRR operated, NYC is operating); the tail re-sorted on the new mark.
    expect(settled.active_operating_order).toEqual([PRR, NYC, CO, 7]);
    // ... and with C&O's rise put BELOW NNH instead, the tail flips, which is the same rule seen moving.
    const lowered = withState(before, {
      market_positions: { ...before.market_positions, [CO]: { price: 50, x: 2, y: 6, enteredAt: 3 } },
    });
    expect(settleOperatingQueue(before, lowered).active_operating_order).toEqual([PRR, NYC, 7, CO]);
    // A mid-round float is never inserted, whatever the settle is asked afterwards.
    expect(settleOperatingQueue(settled, floatedMidRound).active_operating_order).toEqual([PRR, NYC, CO, 7]);
  });

  it("11.5 the settle is a no-op by IDENTITY unless a round opened or the chart moved", () => {
    const before = operatingBoard();
    expect(settleOperatingQueue(before, before)).toBe(before);
    // Same chart object, different board: nothing moved, nothing to re-sort.
    const touched = withState(before, { consecutive_passes: 1 });
    expect(settleOperatingQueue(before, touched)).toBe(touched);
    // No committed chart at all (a unit fixture): nothing authoritative to order on.
    const chartless = withState(before, { market_positions: undefined });
    expect(settleOperatingQueue(chartless, chartless)).toBe(chartless);
    // Not an Operating Round: the queue is not this round's business.
    const sr = stockRoundBoard();
    expect(settleOperatingQueue(sr, sr)).toBe(sr);
  });
});

/* ================================================================================================= */
/* §12  THE FOUR AUTHORITATIVE HOLDS x MESSAGE x ROUND (#1613)                                        */
/* ================================================================================================= */

describe("§12 the hold matrix: which messages each authoritative hold lets through (#1613)", () => {
  /* Each row is a board with exactly ONE hold standing; the columns are the message kinds a player can send.
     `holdBeforeChart.test.ts` owns the property that a held message moves neither chart nor grid; what this
     table adds is the whole escape list of each hold at once -- the thing that is otherwise only readable by
     reading four `passes*` predicates in four files. */

  const offerStanding = (base: GameStateResponse): GameStateResponse =>
    withState(base, {
      train_purchase_offer: {
        seller_protocol_id: NYC,
        seller_ticker: "NYC",
        seller_president: P2,
        buyer_protocol_id: PRR,
        buyer_ticker: "PRR",
        model_type: "3",
        price: "150",
        accepted: false,
        instance: 1,
      },
      offer_serial: 1,
    });

  const homeOwing = (base: GameStateResponse): GameStateResponse =>
    withCorp(base, CO, { home_hex_label: "F6", station_token_hexes: [] });

  const rows: Array<{ hold: string; state: GameStateResponse; grid: MapGridResponse }> = [
    { hold: "none", state: operatingBoard(), grid: GRID },
    /* Over the train limit: C&O's 4-train puts the board in phase 4 (limit 3) and NYC holds four (#1530).
       The phase is derived from the fleets on the board, so the limit has to be moved by a train. */
    {
      hold: "discard",
      state: withCorp(withCorp(operatingBoard(), CO, { owned_trains: ["4"] }), NYC, { owned_trains: ["3", "3", "2", "2"] }),
      grid: GRID,
    },
    // A forced purchase C&O's president cannot fund (#1540). Needs the corridor grid to be judged at all.
    { hold: "funding", state: fundingBoard(100), grid: corridor() },
    // The finished game is the same hold's other sentence (#1540).
    { hold: "gameEnd", state: withState(operatingBoard(), { current_round_type: "GameEnd" }), grid: GRID },
    // An unanswered ordinary train offer (#1590).
    { hold: "offer", state: offerStanding(operatingBoard({ operating: PRR })), grid: GRID },
    // C&O under the cursor, floated, home resolvable, no token (#1612).
    { hold: "home", state: homeOwing(operatingBoard({ operating: CO })), grid: GRID },
  ];

  const columns: Array<{ name: string; msg: unknown }> = [
    { name: "PassTurn", msg: M.pass },
    { name: "SellStock", msg: M.sellStock(PRR, 10) },
    { name: "BuyStock", msg: M.buyStock(PRR) },
    { name: "LayTile", msg: M.layTile(CO) },
    { name: "PlaceStationToken", msg: M.token(CO) },
    { name: "RunRoutes", msg: M.run(CO) },
    { name: "DeclareDividends", msg: M.dividend(CO) },
    { name: "BuyHardware", msg: M.depot(CO) },
    { name: "DiscardTrain", msg: M.discard(NYC, "2") },
    { name: "EmergencyBuy", msg: M.emergency(CO) },
    { name: "AnswerTrain", msg: M.answerTrain(NYC, true) },
    { name: "RescindTrain", msg: M.rescindTrain(NYC) },
    { name: "PlaceHomeStation", msg: { PlaceHomeStation: { game_id: 1, protocol_id: CO, q: 0, r: 0, kind: "home" } } },
    { name: "PlaceHomeStation(dh)", msg: { PlaceHomeStation: { game_id: 1, protocol_id: CO, q: 0, r: 0, kind: "dh" } } },
    { name: "RevertTo", msg: M.revert(1) },
    { name: "CloseRoom", msg: M.closeRoom },
  ];

  const grid = rows.map(
    ({ hold, state, grid: mapGrid }) =>
      `${hold.padEnd(8)}| ${columns.map(({ msg }) => (holds(state, msg, mapGrid) === null ? "-" : "H")).join(" ")}`,
  );

  it("12.1 the grid (H = held, - = allowed through)", () => {
    show("§12 hold x message", [`${"".padEnd(8)}| ${columns.map((c) => c.name).join(" ")}`, ...grid]);
    expect(grid).toEqual([
      // Pass Sell Buy Lay Token Run Div Hardware Discard Emergency AnswerTrain RescindTrain Home Home(dh) Revert Close
      "none    | - - - - - - - - - - - - - - - -",
      "discard | H H H H H H H H - H H H H H H -",
      "funding | H - H H H H H H - - - - H H - -",
      "gameEnd | H H H H H H H H H H H H H H - -",
      "offer   | H H H H H H H H H H - - H H - -",
      "home    | H H H H H H H H H H H H - H - -",
    ]);
  });

  const escapesOf = (hold: string) =>
    columns.filter((_, at) => grid[rows.findIndex((row) => row.hold === hold)].split("| ")[1].split(" ")[at] === "-").map((c) => c.name);

  it("12.2 every hold's escape list is exactly the obligation's own messages plus the log's own instructions", () => {
    /* Read down the grid. Each escape list is the obligation ITSELF and nothing that would advance the game:
         discard   -- `DiscardTrain` (6.6.1's own answer) and `CloseRoom`.
         funding   -- the whole of 6.6.2/6.6.3: the president's share sales, the emergency purchase, the train
                      trade the forced purchase can take, the discard, plus `RevertTo` and `CloseRoom`.
         gameEnd   -- nothing but `RevertTo` and `CloseRoom`; a finished game has no legal play left.
         offer     -- this offer's answer and its rescission, plus `RevertTo` and `CloseRoom`.
         home      -- the home placement, `RevertTo` and `CloseRoom` -- and NOT the D&H's free token, which is
                      a different placement wearing the same message (`passesHomeStationHold`).
       No hold admits an ordinary game action, and the "none" row admits everything, which is what says the
       holds are obligations rather than a general freeze. */
    show("§12.2 escapes", rows.map(({ hold }) => `${hold.padEnd(8)} ${JSON.stringify(escapesOf(hold))}`));
    expect(escapesOf("discard")).toEqual(["DiscardTrain", "CloseRoom"]);
    expect(escapesOf("funding")).toEqual([
      "SellStock",
      "DiscardTrain",
      "EmergencyBuy",
      "AnswerTrain",
      "RescindTrain",
      "RevertTo",
      "CloseRoom",
    ]);
    expect(escapesOf("gameEnd")).toEqual(["RevertTo", "CloseRoom"]);
    expect(escapesOf("offer")).toEqual(["AnswerTrain", "RescindTrain", "RevertTo", "CloseRoom"]);
    expect(escapesOf("home")).toEqual(["PlaceHomeStation", "RevertTo", "CloseRoom"]);
    expect(escapesOf("none")).toEqual(columns.map((c) => c.name));
  });

  /* ==================================================================
      FINDING S10-24: THE DISCARD HOLD IS THE ONE THAT DOES NOT ADMIT `RevertTo`
     ==================================================================
     FILED, NOT FIXED (brief §1). Three of the four holds list `RevertTo` among their escapes -- the funding
     hold through `resolvesEmergencyFunding`, the offer hold through `ALWAYS_PASSES`, the home hold through
     `passesHomeStationHold` -- and `pendingDiscardBlock` admits only `DiscardTrain` and `CloseRoom` (#1530,
     which predates the other three). Read literally that says a board carrying an excess train cannot be
     undone out of.

     IT IS NOT REACHABLE ON THE REPLAY PATH, which is why this is an observation and not a defect: a `RevertTo`
     is resolved by `effectiveActions` (`replayLog.ts`, `const live = effectiveActions(ordered)`) and removed
     from the log BEFORE any entry is applied, so the reducer is never asked to judge one and this cell never
     decides anything. It is recorded because the asymmetry is real in the source and a future caller that
     asked the hold about a `RevertTo` directly would get the odd answer. #1530 predates the Stage-8 holds and
     was not touched by any Stage-8 slice. */
  it("12.2b S10-24: the discard hold alone omits `RevertTo`, which no replay can reach", () => {
    expect(escapesOf("discard")).not.toContain("RevertTo");
    for (const hold of ["funding", "gameEnd", "offer", "home"]) expect(escapesOf(hold)).toContain("RevertTo");
    // The reason it cannot bite: reverts never reach the reducer.
    expect(readStripped("gameEngine/replayLog.ts")).toContain("effectiveActions(ordered)");
  });

  it("12.3 the priority is discard, then funding, then the offer, then the home station", () => {
    /* All four raised at once on one board: the sentence names the FIRST, and removing it reveals the next.
       This is the ordering `authoritativeHoldRefusal` composes, asked as a ladder rather than as four cases. */
    const all = homeOwing(
      offerStanding(
        withCorp(withCorp(operatingBoard({ operating: CO }), CO, { owned_trains: ["4"] }), NYC, { owned_trains: ["3", "3", "2", "2"] }),
      ),
    );
    const ladder: string[] = [];
    let state = withState(all, { current_round_type: "GameEnd" });
    ladder.push(holds(state, M.pass)!.slice(0, 24));
    state = withState(state, { current_round_type: "OperatingRound" });
    ladder.push(holds(state, M.pass)!.slice(0, 24));
    state = withCorp(state, NYC, { owned_trains: ["2"] });
    ladder.push(holds(state, M.pass)!.slice(0, 24));
    state = withState(state, { train_purchase_offer: null });
    ladder.push(holds(state, M.pass)!.slice(0, 24));
    state = withCorp(state, CO, { station_token_hexes: [[0, 0]] });
    ladder.push(String(holds(state, M.pass)));
    show("§12.3 priority ladder", ladder);
    /* The finished game and the discard are both above the others; with the game running the discard leads,
       then the offer, then the home station, then nothing. (The game-end sentence is the funding hold's own,
       which is why it appears where it does -- see #1540.) */
    expect(ladder[0]).toMatch(/^NYC holds 1 train more/); // discard outranks even the finished game
    expect(ladder[1]).toMatch(/^NYC holds 1 train more/);
    expect(ladder[2]).toMatch(/^PRR's offer of \$150/); // the offer, once the discard clears
    expect(ladder[3]).toMatch(/^C&O is starting its firs/);
    expect(ladder[4]).toBe("null");
  });
});

/* ================================================================================================= */
/* §13  THE HOME STATION (rule 6.3.1), as one table                                                   */
/* ================================================================================================= */

describe("§13 the home-placement matrix (rule 6.3.1; Slice 8.2, #1610/#1611/#1612)", () => {
  const withHome = (state: GameStateResponse, id: number, over: Record<string, unknown>) => withCorp(state, id, over);
  const owing = operatingBoard({ operating: CO });

  const cases: Array<{ name: string; state: GameStateResponse; owed: boolean }> = [
    { name: "OR, cursor corp, floated, home resolves, no token", state: withHome(owing, CO, { home_hex_label: "F6", station_token_hexes: [] }), owed: true },
    { name: "... but a token is already on the board (#1325)", state: withHome(owing, CO, { home_hex_label: "F6", station_token_hexes: [[1, 1]] }), owed: false },
    { name: "... but it is NOT the corporation under the cursor", state: withHome(operatingBoard({ operating: PRR }), CO, { home_hex_label: "F6", station_token_hexes: [] }), owed: false },
    { name: "... but it has not floated (5.3)", state: withHome(owing, CO, { home_hex_label: "F6", station_token_hexes: [], is_floated: false }), owed: false },
    { name: "... but its home does not resolve on this board (#416)", state: withHome(owing, CO, { home_hex_label: "ZZ99", station_token_hexes: [] }), owed: false },
    { name: "... but it prints no home at all", state: withHome(owing, CO, { home_hex_label: null, station_token_hexes: [] }), owed: false },
    { name: "in a STOCK Round nothing is owed -- it is not an operating turn", state: withState(withHome(owing, CO, { home_hex_label: "F6", station_token_hexes: [] }), { current_round_type: "StockRound" }), owed: false },
  ];

  it("13.1 the obligation table: exactly when a home station is owed", () => {
    const got = cases.map(({ name, state }) => `${owedHomeStation(state, table) !== null ? "OWED    " : "not owed"} ${name}`);
    show("§13.1 owedHomeStation", got);
    expect(got).toEqual(cases.map(({ name, owed }) => `${owed ? "OWED    " : "not owed"} ${name}`));
  });

  it("13.2 the obligation and the hold are one derivation: the hold stands exactly when something is owed", () => {
    for (const { state, owed } of cases) {
      expect(homeStationHold(state, M.pass as GameplayExecuteMsg, table) !== null).toBe(owed);
      expect(holds(state, M.pass) !== null).toBe(owed);
    }
  });

  it("13.3 a herald home owes no token, and the choices list puts the printed home first (#1302/#1611)", () => {
    /* A corporation whose home is a printed herald has no city to put a token in (#1302). The STANDARD board
       prints none, so the exemption is inert there and the table has to be read on the board that does print
       one -- the expanded board's H12 herald for the PRR. Asserting it on the standard board alone would be a
       loop over an empty list, which is how an exemption stops being checked. */
    const standard = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((id) => homeIsHerald(id));
    activateBoard(EXPANDED_BOARD);
    const expanded = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((id) => homeIsHerald(id));
    try {
      show("§13.3 heralds", [
        `standard board: ${JSON.stringify(standard)}`,
        `expanded board: ${JSON.stringify(expanded)}`,
      ]);
      expect(standard).toEqual([]);
      expect(expanded).toEqual([PRR]);
      // PRR under the cursor, floated, home resolvable, no token -- and still owing nothing, because a herald.
      const heralded = withHome(operatingBoard({ operating: PRR }), PRR, { home_hex_label: "F6", station_token_hexes: [] });
      expect(owedHomeStation(heralded, table)).toBeNull();
      expect(holds(heralded, M.pass)).toBeNull();
      // The same board for a NON-herald corporation on the same board still owes its home.
      const notHeralded = withHome(operatingBoard({ operating: CO }), CO, { home_hex_label: "F6", station_token_hexes: [] });
      expect(owedHomeStation(notHeralded, table)?.ticker).toBe("C&O");
    } finally {
      activateBoard(STANDARD_BOARD);
    }
    // The printed home is always choice 0, whatever else the corporation may choose (#1611).
    const choices = homeHexChoicesFor({ company_id: CO, home_hex_label: "F6", station_token_hexes: [] } as unknown as PublicCompanyState, table);
    expect(choices[0].hexLabel).toBe("F6");
    expect(homeHexChoicesFor({ company_id: CO, home_hex_label: null, station_token_hexes: [] } as unknown as PublicCompanyState, table)).toEqual([]);
    // "Established" is ANY token, not the home hex specifically (#1325).
    expect(homeEstablished({ station_token_hexes: [] } as unknown as PublicCompanyState)).toBe(false);
    expect(homeEstablished({ station_token_hexes: [[9, 9]] } as unknown as PublicCompanyState)).toBe(true);
  });

  it("13.4 the hold's escape is the home placement itself -- and the D&H's free token is not it", () => {
    const rows = [
      ["PlaceHomeStation kind=home", { PlaceHomeStation: { game_id: 1, protocol_id: CO, q: 0, r: 0, kind: "home" } }],
      ["PlaceHomeStation kind=dh", { PlaceHomeStation: { game_id: 1, protocol_id: CO, q: 0, r: 0, kind: "dh" } }],
      ["PlaceHomeStation no kind", { PlaceHomeStation: { game_id: 1, protocol_id: CO, q: 0, r: 0 } }],
      ["RevertTo", M.revert(1)],
      ["CloseRoom", M.closeRoom],
      ["PlaceStationToken", M.token(CO)],
      ["PassTurn", M.pass],
    ] as const;
    const got = rows.map(([label, msg]) => `${passesHomeStationHold(msg as GameplayExecuteMsg) ? "passes" : "held  "} ${label}`);
    show("§13.4 passesHomeStationHold", got);
    expect(got).toEqual([
      "passes PlaceHomeStation kind=home",
      "held   PlaceHomeStation kind=dh",
      "passes PlaceHomeStation no kind",
      "passes RevertTo",
      "passes CloseRoom",
      "held   PlaceStationToken",
      "held   PassTurn",
    ]);
  });
});

/* ================================================================================================= */
/* §14  THE PRESIDENCY (rule 5.4), as one table                                                       */
/* ================================================================================================= */

describe("§14 the presidency matrix (rule 5.4; Slice 8.3, #1620/#1624)", () => {
  const SEATING = [P1, P2, P3];
  /** A corporation carrying just the fields the selector reads. */
  const corp = (president: string | null, holdings: Array<[string, number]>, par: string | null = "100"): PublicCompanyState =>
    ({
      company_id: NYC,
      ticker: "NYC",
      president,
      par_value: par,
      player_holdings: holdings.map(([player, percentage]) => ({ player, percentage })),
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      is_floated: true,
      station_token_hexes: [],
      owned_trains: [],
      treasury: "0",
    }) as unknown as PublicCompanyState;

  const cases: Array<{ name: string; company: PublicCompanyState; want: string | null }> = [
    { name: "a clear majority takes the crown", company: corp(P1, [[P1, 20], [P2, 40]]), want: P2 },
    { name: "STRICTLY more: an equal holding leaves it where it is (#596b)", company: corp(P1, [[P1, 30], [P2, 30]]), want: P1 },
    { name: "under 20% nobody qualifies at all", company: corp(null, [[P1, 10], [P2, 10]]), want: null },
    { name: "the incumbent stays when nobody exceeds them", company: corp(P2, [[P2, 40], [P1, 20], [P3, 20]]), want: P2 },
    { name: "percentage FIRST: 40% three seats away beats 30% in the next seat (#1620)", company: corp(P1, [[P1, 10], [P2, 30], [P3, 40]]), want: P3 },
    { name: "a tie between challengers breaks CLOCKWISE from the incumbent", company: corp(P1, [[P1, 10], [P2, 30], [P3, 30]]), want: P2 },
    { name: "... and clockwise means from the INCUMBENT's seat, not from seat 0", company: corp(P2, [[P2, 10], [P3, 30], [P1, 30]]), want: P3 },
    { name: "no incumbent: the circle is counted from seat 0", company: corp(null, [[P2, 30], [P3, 30]]), want: P2 },
    { name: "an unstarted corporation has no presidency to settle (#587)", company: corp(null, [[P1, 40]], null), want: P1 },
    { name: "a 20% NON-president certificate qualifies exactly as two 10%s do (#1324)", company: corp(P1, [[P1, 20], [P2, 20]]), want: P1 },
  ];

  it("14.1 the selector table -- one function, asked every way", () => {
    const got = cases.map(({ name, company }) => `${String(presidentFor(company, SEATING)).padEnd(4)} ${name}`);
    show("§14.1 presidentFor", got);
    expect(got).toEqual(cases.map(({ name, want }) => `${String(want).padEnd(4)} ${name}`));
  });

  it("14.2 the PROJECTION is the same function, so a sale's answer cannot drift from its settlement (#1620)", () => {
    const held = corp(P1, [[P1, 40], [P2, 30]]);
    const rows = [
      ["P1 sells 0%", presidentAfterSale(held, P1, 0, SEATING)],
      ["P1 sells 10% (down to 30%, tied -- keeps it)", presidentAfterSale(held, P1, 10, SEATING)],
      ["P1 sells 20% (down to 20%, P2 exceeds)", presidentAfterSale(held, P1, 20, SEATING)],
      ["P1 sells 30% (down to 10%, under the block)", presidentAfterSale(held, P1, 30, SEATING)],
    ] as const;
    show("§14.2 presidentAfterSale", rows.map(([label, who]) => `${label} -> ${who}`));
    expect(rows.map(([label, who]) => `${label}=${who}`)).toEqual([
      `P1 sells 0%=${P1}`,
      `P1 sells 10% (down to 30%, tied -- keeps it)=${P1}`,
      `P1 sells 20% (down to 20%, P2 exceeds)=${P2}`,
      `P1 sells 30% (down to 10%, under the block)=${P2}`,
    ]);
    // The projection is the selector on the projected holdings, and nothing else: same answer, board untouched.
    const projected = { ...held, player_holdings: [{ player: P1, percentage: 20 }, { player: P2, percentage: 30 }] } as PublicCompanyState;
    expect(presidentAfterSale(held, P1, 20, SEATING)).toBe(presidentFor(projected, SEATING));
    expect(held.player_holdings.map((entry) => entry.percentage)).toEqual([40, 30]);
  });

  it("14.3 the settlement moves only the crowns that must move, and is identity when none do", () => {
    const base = stockRoundBoard();
    expect(settlePresidencies(base).state).toBe(base);
    expect(settlePresidencies(base).changes).toEqual([]);
    // P3 takes NYC off P2 by holding more of it.
    const taken = withCorp(base, NYC, { player_holdings: [{ player: P2, percentage: 30 }, { player: P3, percentage: 40 }] });
    const settled = settlePresidencies(taken);
    show("§14.3 settlePresidencies", [`changes ${JSON.stringify(settled.changes.map((c) => [c.companyId, c.from, c.to]))}`]);
    expect(settled.state.public_companies.find((c) => c.company_id === NYC)?.president).toBe(P3);
    expect(settled.changes.map((c) => c.companyId)).toEqual([NYC]);
    // PRR was not touched: one holding change settles one crown.
    expect(settled.state.public_companies.find((c) => c.company_id === PRR)?.president).toBe(P1);
    // The block is a percentage, and this is the one number the whole table turns on.
    expect(PRESIDENT_CERTIFICATE_PERCENT).toBe(20);
  });

  it("14.4 a malformed roster answers DETERMINISTICALLY rather than by holdings order (#1620)", () => {
    /* Not reachable in play -- every real holder is seated -- but a hand-built board must not make a REPLAY
       diverge, so the arms exist and this is what they answer. */
    const tied = corp(null, [[P2, 30], [P3, 30]]);
    expect(presidentFor(tied, [])).toBe(P2); // no circle at all: both infinitely far, so the lower address
    expect(presidentFor(tied, [P1])).toBe(P2); // neither seated: same
    expect(presidentFor(tied, [P3, P2, P1])).toBe(P3); // the circle's own order decides
    expect(presidentFor(corp("nobody", [[P2, 30], [P3, 30]]), SEATING)).toBe(P2); // unseated incumbent: from seat 0
  });
});

/* ================================================================================================= */
/* §15  THE M&H EXCHANGE (p. 27), as one table                                                        */
/* ================================================================================================= */

describe("§15 the M&H matrix (rulebook p. 27; Slice 8.4, #1630-#1634)", () => {
  const request = (over: Partial<MhExchangeRequest> = {}): MhExchangeRequest => ({
    private_id: MH,
    company_id: NYC,
    player: P1,
    source: "Ipo",
    ...over,
  });
  // The Batch-7.4 Stock Round board already gives P1 the M&H; NYC needs a pile to exchange against.
  const srBoard = withCorp(stockRoundBoard(), NYC, { ipo_pool_percentage: 50, bank_pool_percentage: 10 });

  it("15.1 the DISPOSITION table: execute only in the requester's own Stock Round seat, else queue (R1)", () => {
    const rows: Array<[string, GameStateResponse, MhExchangeRequest]> = [
      ["StockRound, the requester is seated", srBoard, request()],
      ["StockRound, another player is seated", withState(srBoard, { active_player_index: 1 }), request()],
      ["StockRound, the seat is unresolvable", withState(srBoard, { active_player_index: 9 }), request()],
      ["OperatingRound", withState(srBoard, { current_round_type: "OperatingRound" }), request()],
      ["WaterfallAuction", withState(srBoard, { current_round_type: "WaterfallAuction" }), request()],
      ["GameEnd", withState(srBoard, { current_round_type: "GameEnd" }), request()],
    ];
    const got = rows.map(([label, state, req]) => `${mhExchangeDisposition(state, req).padEnd(7)} ${label}`);
    show("§15.1 mhExchangeDisposition", got);
    expect(got).toEqual([
      "execute StockRound, the requester is seated",
      "queue   StockRound, another player is seated",
      "queue   StockRound, the seat is unresolvable",
      "queue   OperatingRound",
      "queue   WaterfallAuction",
      "queue   GameEnd",
    ]);
  });

  it("15.2 the REFUSAL table: what makes the exchange itself illegal, whenever it is asked", () => {
    const rows: Array<[string, GameStateResponse, MhExchangeRequest, string | null]> = [
      ["legal: the M&H's owner takes an IPO 10%", srBoard, request(), null],
      ["a different private is not an exchange (#576)", srBoard, request({ private_id: DH }), "Mohawk & Hudson"],
      ["the wrong corporation", srBoard, request({ company_id: PRR }), "NYC"],
      ["a player who does not own the M&H", srBoard, request({ player: P2 }), "yours"],
      ["a pile with no certificate in it", withCorp(srBoard, NYC, { ipo_pool_percentage: 0, bank_pool_percentage: 10 }), request(), "IPO"],
      ["the Bank Pool, which holds a 10% on this board", srBoard, request({ source: "Bank" }), null],
      ["a source that is neither pile", srBoard, request({ source: "Pool" as "Ipo" }), "IPO or the Bank Pool"],
      ["the M&H is already closed", withState(srBoard, { private_companies: srBoard.private_companies.map((p) => (p.private_id === MH ? { ...p, closed: true } : p)) }), request(), "closed"],
    ];
    const got = rows.map(([label, state, req]) => {
      const refusal = mhExchangeRefusal(state, req, req.player);
      return `${refusal === null ? "LEGAL " : "refuse"} ${label}`;
    });
    show("§15.2 mhExchangeRefusal", got.map((line, at) => `${line} :: ${String(mhExchangeRefusal(rows[at][1], rows[at][2], rows[at][2].player)).slice(0, 70)}`));
    expect(got).toEqual(rows.map(([label, , , want]) => `${want === null ? "LEGAL " : "refuse"} ${label}`));
    // ... and the refusals that carry a phrase say the right thing.
    for (const [, state, req, want] of rows) {
      if (want !== null) expect(mhExchangeRefusal(state, req, req.player)).toContain(want);
    }
  });

  it("15.3 the SOURCE is the owner's choice and is never switched for them (R2)", () => {
    /* The refusal names the pile that was ASKED FOR. An engine that silently fell back to the other pile
       would make this pair of sentences identical, which is why they are asserted as a pair. */
    const ipoOnly = withCorp(stockRoundBoard(), NYC, { ipo_pool_percentage: 50, bank_pool_percentage: 0 });
    const poolOnly = withCorp(stockRoundBoard(), NYC, { ipo_pool_percentage: 0, bank_pool_percentage: 20 });
    const nyc = (state: GameStateResponse) => state.public_companies.find((c) => c.company_id === NYC)!;
    const cells = [
      `IPO holds 50, asked IPO  -> ${mhSourceRefusal(nyc(ipoOnly), "Ipo") === null ? "LEGAL" : "refused"}`,
      `IPO holds 50, asked Bank -> ${mhSourceRefusal(nyc(ipoOnly), "Bank") === null ? "LEGAL" : "refused"}`,
      `Pool holds 20, asked Bank -> ${mhSourceRefusal(nyc(poolOnly), "Bank") === null ? "LEGAL" : "refused"}`,
      `Pool holds 20, asked IPO  -> ${mhSourceRefusal(nyc(poolOnly), "Ipo") === null ? "LEGAL" : "refused"}`,
    ];
    show("§15.3 mhSourceRefusal", cells);
    expect(cells).toEqual([
      "IPO holds 50, asked IPO  -> LEGAL",
      "IPO holds 50, asked Bank -> refused",
      "Pool holds 20, asked Bank -> LEGAL",
      "Pool holds 20, asked IPO  -> refused",
    ]);
    expect(mhSourceRefusal(nyc(ipoOnly), "Bank")).toContain("Bank Pool");
    expect(mhSourceRefusal(nyc(poolOnly), "Ipo")).toContain("IPO");
    expect(MH_EXCHANGE_TICKER).toBe("NYC");
  });

  it("15.4 a request while one is already standing is refused, and queuing vests nothing (R1)", () => {
    const queued = withState(srBoard, { pending_mh_exchange: { player: P1, private_id: MH, company_id: NYC, source: "Ipo" } });
    expect(mhExchangeRequestRefusal(queued, request(), P1)).toMatch(/already pending/);
    // The queued request has changed no holding, closed no private and moved no marker.
    expect(queued.public_companies).toBe(srBoard.public_companies);
    expect(queued.private_companies).toBe(srBoard.private_companies);
    expect(queued.active_player_index).toBe(srBoard.active_player_index);
    expect(queued.consecutive_passes).toBe(srBoard.consecutive_passes);
    expect(queued.priority_deal_index).toBe(srBoard.priority_deal_index);
  });
});

/* ================================================================================================= */
/* §16  THE STATIC AUDITS: the eight patterns Stage 8 was supposed to remove                           */
/* ================================================================================================= */

/* Each audit names a pattern the pre-Stage-8 engine contained, greps the CURRENT sources for it, and
   classifies what it finds as AUTHORITATIVE (the repaired rule, in its one place), DEAD (a comment or a
   compatibility re-export that cannot be reached) or DEFECT (a second rule still standing). An audit that
   finds a defect fails; an audit whose pattern is simply gone asserts that too, because "we removed it" is a
   claim about the source and this is where it is checked. Comments are stripped first (`readStripped`) so a
   design note describing the removed rule cannot be mistaken for the rule. */

describe("§16 static source audits", () => {
  const src = (path: string) => readStripped(path);
  const engine = [
    "gameEngine/sandboxSession.ts",
    "gameEngine/operatingOrder.ts",
    "gameEngine/homeStationAuthority.ts",
    "gameEngine/homeTokenGate.ts",
    "gameEngine/presidencyTransfer.ts",
    "gameEngine/mohawkExchange.ts",
    "gameEngine/privateExchange.ts",
    "gameEngine/shareSale.ts",
    "gameEngine/sharePurchase.ts",
    "gameEngine/emergencyFunding.ts",
    "gameEngine/floatThreshold.ts",
    "gameEngine/stockTransactionAuthority.ts",
    "gameEngine/trainDiscard.ts",
    "gameEngine/pendingOfferHold.ts",
  ];
  const hits = (pattern: RegExp, files: readonly string[] = engine): string[] => {
    const found: string[] = [];
    for (const file of files) {
      const lines = src(file).split("\n");
      lines.forEach((line, at) => {
        if (pattern.test(line)) found.push(`${file}:${at + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    return found;
  };

  it("A1 the presidency is chosen in ONE place, and never by `player_holdings` order", () => {
    /* The repaired rule is `presidencyTransfer.presidentFor`. A second selector would be a `reduce`/`sort`/
       `[0]` over `player_holdings` somewhere else; a `find` for a NAMED player is a lookup, not a selection,
       so the pattern asks for the shapes that pick a player out of the array. */
    const found = hits(/player_holdings[\s\S]*?(\.sort\(|\.reduce\(|\[0\])/);
    const outsideTheAuthority = found.filter((line) => !line.startsWith("gameEngine/presidencyTransfer.ts"));
    show("A1", outsideTheAuthority.length === 0 ? ["no selector outside presidencyTransfer.ts"] : outsideTheAuthority);
    // `floatThreshold` sums percentages (a measure, not a selection) -- everything else must be a lookup.
    expect(outsideTheAuthority.filter((line) => !line.startsWith("gameEngine/floatThreshold.ts"))).toEqual([]);
    expect(src("gameEngine/presidencyTransfer.ts")).toContain("function closestClockwise");
  });

  it("A2 no home station is demanded AT FLOAT: the obligation is derived on the Operating Round cursor", () => {
    /* #1610 moved the obligation from the float to the first operating turn. `homeTokenGate.ts` survives as
       the SHELL's prompt and asks the authority; the pattern that must be gone is an obligation derived from
       `is_floated` without the cursor. */
    const authority = src("gameEngine/homeStationAuthority.ts");
    expect(authority).toContain("current_round_type !== \"OperatingRound\"");
    expect(authority).toContain("operatingCorporationId");
    // The gate delegates rather than re-deriving: it holds no float-keyed obligation of its own.
    const gate = src("gameEngine/homeTokenGate.ts");
    show("A2", [`homeTokenGate.ts mentions owedHomeStation: ${gate.includes("owedHomeStation") || gate.includes("homeStationHold")}`]);
    expect(/is_floated[\s\S]{0,120}station_token_hexes/.test(gate)).toBe(false);
  });

  it("A3 there is ONE M&H arm, and the shell submits a message rather than applying an exchange", () => {
    const direct = hits(/applyPrivateExchange\(/, [...engine, "App.tsx"]);
    show("A3", direct);
    /* `privateExchange.ts` defines it; `mohawkExchange.ts` projects and applies with it; `sandboxSession.ts`
       uses it for the C&A's purchase bonus (#576), which is a grant and not an exchange. Nothing in the shell
       calls it -- #1246 took that branch off App.tsx and left the message. */
    expect(direct.filter((line) => line.startsWith("App.tsx"))).toEqual([]);
    const arm = src("gameEngine/sandboxSession.ts");
    expect(arm).toContain("mhExchangeRequestRefusal");
    expect(arm).toContain("mhExchangeDisposition");
    expect(arm).toContain("withPendingMhExchange");
  });

  it("A4 the M&H source is required, never defaulted: no silent IPO-first preference survives", () => {
    const mh = src("gameEngine/mohawkExchange.ts");
    // A default would read `source ?? "Ipo"`, `source || "Ipo"`, or a ternary on pile size.
    const defaults = /source\s*(\?\?|\|\|)\s*"(Ipo|Bank)"/.test(mh) || /ipo_pool_percentage\s*>=\s*\d+\s*\?\s*"Ipo"/.test(mh);
    show("A4", [`a defaulted source in mohawkExchange.ts: ${defaults}`]);
    expect(defaults).toBe(false);
    // The type makes it required, and the arm passes the message's own value through.
    expect(mh).toContain("source: \"Ipo\" | \"Bank\";");
    expect(src("gameEngine/sandboxSession.ts")).toContain("const { private_id, company_id, player, source, keep_open } = msg.ExchangePrivate;");
  });

  it("A5 `applyFloatThreshold` is defined ONCE (#1631)", () => {
    const definitions = hits(/export function applyFloatThreshold|function applyFloatThreshold\s*\(/);
    show("A5", definitions);
    expect(definitions.map((line) => line.split(":")[0])).toEqual(["gameEngine/floatThreshold.ts"]);
    // The reducer keeps a re-export so its old importers still compile; that is a name, not a second rule.
    expect(src("gameEngine/sandboxSession.ts")).toContain("export { applyFloatThreshold };");
  });

  it("A6 no `?? 67` survives, and the two remaining nominals say what they are for (S8-8)", () => {
    const fallbacks = hits(/\?\?\s*67\b|\|\|\s*67\b/, [...engine, "gameEngine/gameState.ts"]);
    show("A6", fallbacks.length === 0 ? ["no `?? 67` anywhere in the engine"] : fallbacks);
    expect(fallbacks).toEqual([]);
    // The two surviving constants are named, and the price helper reaches the legacy one only off a pinned board.
    const funding = src("gameEngine/emergencyFunding.ts");
    expect(funding).toContain("const NOMINAL_SHARE_PRICE = 67;");
    expect(funding).toContain("typeof state.rules_engine_version === \"number\" ? null : NOMINAL_SHARE_PRICE");
    expect(src("gameEngine/sandboxSession.ts")).toContain("export const SANDBOX_NOMINAL_SHARE_PRICE = 67;");
  });

  it("A7 `active_operating_order` is WRITTEN in exactly three places, all of them authoritative", () => {
    const writes = hits(/active_operating_order\s*:/, [
      ...engine,
      "gameEngine/gameState.ts",
      "gameEngine/sandboxState.ts",
      "App.tsx",
    ]);
    show("A7", writes);
    expect(writes.map((line) => line.split(":")[0])).toEqual([
      "gameEngine/sandboxSession.ts", // buildOperatingOrder's result, where a round opens
      "gameEngine/operatingOrder.ts", // settleOperatingQueue's permutation
      "gameEngine/gameState.ts", // the field's declaration
      "gameEngine/sandboxState.ts", // the scenario seed
      "gameEngine/sandboxState.ts",
    ]);
    // Nothing in the shell writes the queue: the turn-order surfaces read it (U-34).
    expect(writes.filter((line) => line.startsWith("App.tsx"))).toEqual([]);
  });

  it("A8 nothing inserts a mid-round float into the queue: the settle slices and permutes only", () => {
    const order = src("gameEngine/operatingOrder.ts");
    // The one write is a slice of the existing order plus a permutation of its own tail.
    expect(order).toContain("active_operating_order: [...order.slice(0, frozen), ...settled],");
    // No `push`/`splice`/`concat` into the queue anywhere in the engine.
    const inserts = hits(/active_operating_order[\s\S]{0,40}(\.push\(|\.splice\(|\.concat\()/);
    show("A8", inserts.length === 0 ? ["no insertion into active_operating_order"] : inserts);
    expect(inserts).toEqual([]);
    // And the settle's tail is built from `waiting`, which is a slice of the order it was handed.
    expect(order).toContain("const waiting = order.slice(frozen);");
  });
});
