/** @jest-environment node */
//
// ==================================================================
//  STAGE 10.3b (S10-4) -- CHART / CORE ATOMICITY (design note #1691)
// ==================================================================
//
// The invariant: IF THE AUTHORITATIVE ACTION IS REFUSED, NO CHART MOVEMENT CAUSED BY IT SURVIVES.
//
// The reducer moves the chart BEFORE the core settles the action (#272/#273: the core needs the price the chart
// step produced), and until 10.3b it relied on a hand-kept list of pre-chart refusals (`saleRefused`,
// `dividendRefused`, the board gates, the Blood Price's `trainSaleRefusal`) to keep a refused action off the
// chart. The list was short: `dividendAmountRefusal` and every refusal an arm makes for itself sit after the chart
// step, and `saleRefused` has no opinion at all without an author. #1691 makes the chart step provisional: the
// core is judged on the moved board exactly as before, and if it declines, the move is discarded.
//
// Every case goes through the SHARED composition (`sandboxActionContext`) -- the context `RoomEngine` and
// `App.tsx` both hand the reducer -- and asks the shell's sentence (`sandboxChartStepReport`) the same question.
// The market-moving families: `SellStock`, `DeclareDividends`, `BuyTrainFromCorporation` (the Blood Price). The
// sold-out rise is not message-driven: it is computed after the core from the core's own result, so a refused
// core (no round change) produces none -- pinned in part E.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import { applySandboxAction, applySandboxMarketAction, sandboxChartStepReport } from "../gameEngine/sandboxSession";
import { sandboxActionContext } from "../gameEngine/actionContext";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { entriesFromExport, replayLog, type ExportedEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { canonicalJson } from "../gameEngine/stateDigest";
import { dividendRefused } from "../gameEngine/dividendGate";
import { dividendAmountRefusal } from "../gameEngine/routeAuthority";
import { stockSaleRefusal } from "../gameEngine/stockTransactionAuthority";
import { trainSaleRefusal } from "../gameEngine/trainSaleAuthority";
import { projectBloodPriceMove, projectShareSaleMove } from "../gameEngine/marketGeometry";
import { moneyTotal } from "../gameEngine/cashLedger";
import { readStripped, sliceBetween } from "./sourceScan";
import { operatingBoard, stockRoundBoard, P1, P2, PRR, NYC, CO } from "./offerFixtures74";
import { withCorp, withState, M, cash, treasury, trains } from "./offerMatrix74Support";

const providers = sandboxReplayProviders();
const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
const ctxFor = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  sandboxActionContext(providers, { state, msg: msg as GameplayExecuteMsg, actor, grid: GRID, gridBefore: GRID });
const reduce = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  applySandboxAction(state, msg as GameplayExecuteMsg, ctxFor(state, msg, actor));
const report = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  sandboxChartStepReport(state, msg as GameplayExecuteMsg, ctxFor(state, msg, actor));
const chart = (state: GameStateResponse) => canonicalJson(state.market_positions);
const same = (a: GameStateResponse, b: GameStateResponse) => canonicalJson(a) === canonicalJson(b);
/** The whole board EXCEPT the chart -- what "the core did nothing" means. */
const offChart = (state: GameStateResponse) => canonicalJson({ ...state, market_positions: null });

/** A refusal, pinned as the invariant: the board is returned unchanged (chart included), and the shell's
 *  sentence says nothing moved. */
function expectRefusedWithoutMove(board: GameStateResponse, msg: unknown, actor: string | null) {
  const after = reduce(board, msg, actor);
  expect(same(after, board)).toBe(true);
  expect(chart(after)).toBe(chart(board));
  expect(report(board, msg, actor)).toBeNull();
}

/** What the chart step's OWN pre-chart predicates would do with this message -- the reducer's `chartStepContext`
 *  reconstructed for the families below. Used only to show a case really is one the pre-chart list let through,
 *  i.e. that it is the transaction (#1691) and nothing else that keeps the token still. */
function preChartMove(board: GameStateResponse, msg: unknown, actor: string | null) {
  const geometry = providers.marketContext(board, msg as GameplayExecuteMsg, actor);
  return applySandboxMarketAction(board.market_positions ?? {}, msg as GameplayExecuteMsg, {
    ...geometry,
    dividendRefused: (companyId) => dividendRefused(board, companyId),
    saleRefused: (companyId, percentage) =>
      actor ? stockSaleRefusal({ state: board, sell: { companyId, percentage }, actor, mapGrid: GRID }) !== null : false,
  }).moved;
}

/* ================================================================================================= */
/* A / B. STOCK SALES                                                                                 */
/* ================================================================================================= */

describe("SellStock: the sale and its chart move land together or not at all", () => {
  it("A. a legal sale: the shares, the money and one row down the chart", () => {
    const board = stockRoundBoard();
    const sale = M.sellStock(PRR, 10);
    const mark = board.market_positions![PRR]!;
    const after = reduce(board, sale, P1);
    const held = (state: GameStateResponse) =>
      state.public_companies.find((entry) => entry.company_id === PRR)!.player_holdings.find((h) => h.player === P1)!.percentage;
    expect(held(after)).toBe(held(board) - 10);
    expect(cash(after, P1)).toBe(cash(board, P1) + mark.price);
    const landed = projectShareSaleMove(mark, 1)!;
    expect([after.market_positions![PRR]!.x, after.market_positions![PRR]!.y, after.market_positions![PRR]!.price]).toEqual([
      landed.x,
      landed.y,
      landed.price,
    ]);
    expect(report(board, sale, P1)).toEqual({ companyId: PRR, from: mark.price, to: landed.price, reason: "sale" });
    expect(moneyTotal(after)).toBe(moneyTotal(board));
  });

  it("B1. a sale the pre-chart predicate already refuses (outside a Stock Round): nothing moves", () => {
    const board = operatingBoard();
    expect(preChartMove(board, M.sellStock(NYC, 10), P2)).toBeNull();
    expectRefusedWithoutMove(board, M.sellStock(NYC, 10), P2);
  });

  it("B2. a sale that ESCAPED the pre-chart predicate -- no author, so `saleRefused` had no opinion -- now moves nothing", () => {
    /* Solo play and fixtures dispatch without an author (S10-20's reach). `saleRefused` answers `false` without a
       seller, so the chart step walked NYC's token down; the core's `stockSaleRefusal` then refused the sale
       (an Operating Round) -- and until #1691 the token stayed down, with nobody's holdings changed. */
    const board = operatingBoard();
    const sale = M.sellStock(NYC, 10);
    expect(preChartMove(board, sale, null)).not.toBeNull(); // the pre-chart list let it through
    expect(stockSaleRefusal({ state: board, sell: { companyId: NYC, percentage: 10 }, actor: null, mapGrid: GRID })).not.toBeNull();
    expectRefusedWithoutMove(board, sale, null);
  });

  it("B3. every late stock-sale refusal the core can reach without an author leaves the chart alone", () => {
    for (const [board, msg] of [
      [stockRoundBoard({ macro: 1 }), M.sellStock(PRR, 10)], // the first Stock Round (§5.1)
      [stockRoundBoard(), M.sellStock(PRR, 15)], // not a whole certificate
      [withCorp(stockRoundBoard(), PRR, { par_value: null }), M.sellStock(PRR, 10)], // unstarted corporation
    ] as Array<[GameStateResponse, unknown]>) {
      expectRefusedWithoutMove(board, msg, null);
      expectRefusedWithoutMove(board, msg, P1);
    }
  });
});

/* ================================================================================================= */
/* C / D. THE BLOOD PRICE                                                                             */
/* ================================================================================================= */

describe("BuyTrainFromCorporation: the Blood Price occurs exactly when the legal transfer occurs", () => {
  /** PRR (P1) buying NYC's gilded 3-train at its Purchase Trains step; P1 presides over both (#1592's direct buy). */
  const gilded = (patch: Record<string, unknown> = {}) =>
    withState(withCorp(operatingBoard({ step: "Hardware" }), NYC, { president: P1, carcosan_trains: ["3"] }), patch);
  const sale = M.buyTrain(PRR, NYC, "3", "150");

  it("C. a legal Carcosan transfer: the train and the money move, and exactly ONE Blood Price step lands", () => {
    const board = gilded();
    const mark = board.market_positions![NYC]!;
    const landed = projectBloodPriceMove(mark)!;
    const after = reduce(board, sale, P1);
    expect(trains(after, PRR)).toEqual([...trains(board, PRR), "3"]);
    expect(trains(after, NYC)).toEqual(["2"]);
    expect(treasury(after, PRR)).toBe(treasury(board, PRR) - 150);
    expect(treasury(after, NYC)).toBe(treasury(board, NYC) + 150);
    expect([after.market_positions![NYC]!.x, after.market_positions![NYC]!.y, after.market_positions![NYC]!.price]).toEqual([
      landed.x,
      landed.y,
      landed.price,
    ]);
    // ONE step: not two, and no other token moved.
    expect(projectBloodPriceMove(landed)).not.toEqual(landed);
    for (const id of [PRR, CO]) expect(after.market_positions![id]).toEqual(board.market_positions![id]);
    expect(report(board, sale, P1)).toEqual({ companyId: NYC, from: mark.price, to: landed.price, reason: "bloodPrice" });
  });

  it("D. every refusal of the transfer: no train, no money, no Blood Price", () => {
    const cases: Array<{ why: string; board: GameStateResponse; actor: string | null }> = [
      { why: "not the Purchase Trains step", board: gilded({ operating_sub_phase: "Tokens" }), actor: P1 },
      { why: "no consent (another president, no offer)", board: withCorp(gilded(), NYC, { president: P2 }), actor: P1 },
      { why: "the treasury cannot pay", board: withCorp(gilded(), PRR, { treasury: "10" }), actor: P1 },
      { why: "not the operating corporation", board: gilded({ active_corporation_index: 2 }), actor: P1 },
      { why: "the seller does not own the model", board: withCorp(gilded(), NYC, { owned_trains: ["2"], carcosan_trains: ["3"] }), actor: P1 },
      { why: "outside an Operating Round", board: gilded({ current_round_type: "StockRound" }), actor: P1 },
      { why: "no author and no common president", board: withCorp(gilded(), NYC, { president: P2 }), actor: null },
    ];
    for (const { why, board, actor } of cases) {
      expect([why, trainSaleRefusal(board, { buyerId: PRR, sellerId: NYC, model: "3", price: "150" }, actor, GRID, "settlement") !== null]).toEqual([why, true]);
      expectRefusedWithoutMove(board, sale, actor);
      expect(trains(reduce(board, sale, actor), PRR)).toEqual(trains(board, PRR));
    }
  });

  it("D (the settlement of an accepted offer): #1596 retires the offer and nothing else moves -- not the chart", () => {
    // P2 presides over NYC and ACCEPTED P1's offer; the treasury then cannot pay, so the settlement is refused.
    const offer = { seller_protocol_id: NYC, buyer_protocol_id: PRR, model_type: "3", price: "150", accepted: true };
    const board = withCorp(withCorp(gilded({ train_purchase_offer: offer }), NYC, { president: P2 }), PRR, { treasury: "10" });
    const after = reduce(board, sale, P1);
    expect(after.train_purchase_offer ?? null).toBeNull();
    expect(offChart({ ...after, train_purchase_offer: offer } as GameStateResponse)).toBe(offChart(board));
    expect(chart(after)).toBe(chart(board));
    expect(report(board, sale, P1)).toBeNull();
  });
});

/* ================================================================================================= */
/* E / F. DIVIDENDS                                                                                   */
/* ================================================================================================= */

describe("DeclareDividends: the declaration and its chart move land together or not at all", () => {
  const atDividends = (patch: Record<string, unknown> = {}) =>
    withCorp(operatingBoard({ step: "Dividends" }), PRR, { last_route_revenue: "80", ...patch });
  const declare = (distribute: boolean, amount = "80") => ({
    DeclareDividends: { game_id: 1, protocol_id: PRR, distribute, revenue_amount: amount },
  });

  it("E. a legal payout: the money moves, the step closes, and the token rises", () => {
    const board = atDividends();
    const after = reduce(board, declare(true), P1);
    expect(cash(after, P1)).toBeGreaterThan(cash(board, P1));
    expect(after.operating_sub_phase).not.toBe("Dividends");
    const moved = report(board, declare(true), P1);
    expect(moved?.reason).toBe("payout");
    expect(after.market_positions![PRR]!.price).toBe(moved!.to);
    expect(moneyTotal(after)).toBe(moneyTotal(board));
  });

  it("E. a legal withhold: the treasury keeps the revenue, and the token falls", () => {
    const board = atDividends();
    const after = reduce(board, declare(false), P1);
    expect(treasury(after, PRR)).toBe(treasury(board, PRR) + 80);
    const moved = report(board, declare(false), P1);
    expect(moved?.reason).toBe("withhold");
    expect(after.market_positions![PRR]!.price).toBe(moved!.to);
  });

  it("F1. a declaration the pre-chart predicate already refuses (wrong step, wrong corporation): nothing moves", () => {
    expectRefusedWithoutMove(atDividends({}), { DeclareDividends: { game_id: 1, protocol_id: NYC, distribute: true } }, P1);
    const hardware = withCorp(operatingBoard({ step: "Hardware" }), PRR, { last_route_revenue: "80" });
    expectRefusedWithoutMove(hardware, declare(true), P1);
  });

  it("F2. a declaration that ESCAPED the pre-chart predicate -- an amount the trains did not run -- now moves nothing", () => {
    /* `dividendAmountRefusal` (#1552) is a core gate after the chart step; `dividendRefused` does not ask it. A
       crafted `$999` declaration walked the token by the multiple the real $80 earned, and the core then refused
       the declaration -- money, cursor and step untouched, token moved, and (on a charted board mid-round) the
       operating queue re-sorted on the moved price. */
    const board = atDividends();
    for (const distribute of [true, false]) {
      const crafted = declare(distribute, "999");
      expect(dividendAmountRefusal(board, crafted.DeclareDividends)).not.toBeNull();
      expect(preChartMove(board, crafted, P1)).not.toBeNull(); // the pre-chart list let it through
      expectRefusedWithoutMove(board, crafted, P1);
    }
  });
});

/* ================================================================================================= */
/* E. THE WHOLE CORPUS: A DECLINED CORE NEVER LEAVES A MOVED CHART                                    */
/* ================================================================================================= */

describe("the invariant, over every stored entry", () => {
  const UTILS = __dirname;
  const jsonl = (file: string): ExportedEntry[] =>
    readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);
  const rows = (file: string): ExportedEntry[] => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
    return raw.actions ?? raw.entries ?? [];
  };
  const logs: ExportedEntry[][] = [];
  const frozen = join(UTILS, "__fixtures__", "replayGolden", "logs");
  for (const file of readdirSync(frozen).filter((f) => f.endsWith(".log.jsonl"))) logs.push(jsonl(join(frozen, file)));
  const server = join(UTILS, "..", "..", "..", "server", "data");
  if (existsSync(server)) for (const file of readdirSync(server).filter((f) => f.endsWith(".log.jsonl"))) logs.push(jsonl(join(server, file)));
  const exported = join(UTILS, "..", "..");
  for (const file of readdirSync(exported).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f))) logs.push(rows(join(exported, file)));
  logs.push(jsonl(join(UTILS, "__fixtures__", "JUNO-FCJ-prefix96.log.jsonl")));
  logs.push(rows(join(UTILS, "__fixtures__z6cLog.json")));

  it("where the core changed nothing, the chart did not move either; where the chart moved, the sentence names it", () => {
    let applications = 0;
    let moves = 0;
    let violations = 0;
    let sentenceMismatches = 0;
    for (const entries of logs) {
      let previous: MapGridResponse | null = null;
      replayLog(
        entriesFromExport(entries),
        providers,
        {
          state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
          waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
        },
        ({ entry, msg, stateBefore, grid }) => {
          const gridBefore = previous ?? grid;
          previous = grid;
          if (!("SellStock" in msg) && !("DeclareDividends" in msg) && !("BuyTrainFromCorporation" in msg)) return;
          applications += 1;
          const ctx = sandboxActionContext(providers, { state: stateBefore, msg, actor: entry.actor, grid, gridBefore });
          const after = applySandboxAction(stateBefore, msg, ctx);
          const chartMoved = chart(after) !== chart(stateBefore);
          if (chartMoved) moves += 1;
          if (chartMoved && offChart(after) === offChart(stateBefore)) violations += 1;
          const sentence = sandboxChartStepReport(stateBefore, msg, ctx);
          if (sentence !== null && after.market_positions?.[sentence.companyId]?.price !== sentence.to) sentenceMismatches += 1;
        },
        DEVELOPMENT_CORPUS_POLICY,
      );
    }
    expect(applications).toBeGreaterThan(100);
    expect(moves).toBeGreaterThan(50);
    expect(violations).toBe(0);
    expect(sentenceMismatches).toBe(0);
  });
});

/* ================================================================================================= */
/* SOURCE: ONE TRANSACTION, ASKED BY THE REDUCER AND BY THE SENTENCE                                  */
/* ================================================================================================= */

describe("the reducer and the shell's sentence ask one chart/core transaction", () => {
  const REDUCER = readStripped("gameEngine/sandboxSession.ts");

  it("the reducer's market branch commits through `marketTransaction`", () => {
    const branch = sliceBetween(REDUCER, "function applySandboxActionAfterAuction(", "return applySandboxActionInner(state, msg, ctx);");
    expect(branch).toContain("const transaction = marketTransaction(state, state.market_positions, msg, ctx);");
    expect(branch).not.toContain("chartStep(");
  });

  it("the sentence reads the same transaction, never the bare chart step", () => {
    const sentence = sliceBetween(REDUCER, "export function sandboxChartStepReport(", "function applySandboxActionAfterAuction(");
    expect(sentence).toContain("marketTransaction(afterAuction, afterAuction.market_positions, msg, ctx).priced.moved");
    expect(sentence).not.toContain("chartStep(afterAuction");
  });

  it("a declined core discards the move", () => {
    const transaction = sliceBetween(REDUCER, "function marketTransaction(", "function settleChartAfterCore(");
    expect(transaction).toContain("const declined = judged === settled || canonicalJson(judged) === canonicalJson(settled);");
    expect(transaction).toContain("priced: { prices: positions, tradePrice: null, moved: null },");
  });
});
