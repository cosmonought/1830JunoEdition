/** @jest-environment node */
// frontend/src/components/marketChart.test.ts -- design note #1435.
import {
  DYNAMIC_MARKET_CHART,
  DYNAMIC_MARKET_ROW,
  PRICE_GRID,
  STANDARD_MARKET_CHART,
  activateMarketChart,
  chartFor,
  marketChartInEffect,
  marketMaxY,
  withMarketChart,
} from "./marketChart";
import { marketCellForPrice, parBoxCellFor, projectDividendCellMove, projectRiseMove } from "./StockMarketRenderer";
import { withRules } from "../utils/boardSelection";
import { STANDARD_VARIANTS } from "../utils/gameVariants";

describe("the Dynamic Market row above the top (design note #1435)", () => {
  afterEach(() => activateMarketChart(STANDARD_MARKET_CHART));

  it("the standard chart is untouched: eleven rows, top row y=10, $350 in the corner", () => {
    expect(marketChartInEffect()).toBe(STANDARD_MARKET_CHART);
    expect(marketMaxY()).toBe(10);
    expect(PRICE_GRID.some((c) => c.y === 11)).toBe(false);
    expect(PRICE_GRID.find((c) => c.x === 18 && c.y === 10)?.price).toBe(350);
    expect(PRICE_GRID.length).toBe(11 * 0 + STANDARD_MARKET_CHART.rows.reduce((n, r) => n + r.cells.length, 0));
  });

  it("the row runs $67 to $450, one cell per column, all Normal, and the par ladder does not move", () => {
    expect(DYNAMIC_MARKET_ROW.cells.map(([p]) => p)).toEqual([67, 71, 76, 82, 90, 100, 112, 124, 138, 155, 175, 200, 225, 250, 275, 300, 350, 400, 450]);
    expect(DYNAMIC_MARKET_ROW.cells.length).toBe(19);
    expect(DYNAMIC_MARKET_ROW.cells.every(([, zone]) => zone === "Normal")).toBe(true);
    activateMarketChart(DYNAMIC_MARKET_CHART);
    expect(marketMaxY()).toBe(11);
    expect(PRICE_GRID.filter((c) => c.y === 11).length).toBe(19);
    expect(PRICE_GRID.filter((c) => c.isParValueLadder).map((c) => [c.x, c.y, c.price])).toEqual([
      [6, 10, 100], [6, 9, 90], [6, 8, 82], [6, 7, 76], [6, 6, 71], [6, 5, 67],
    ]);
    for (const par of [67, 71, 76, 82, 90, 100]) expect(parBoxCellFor(par)?.y).toBeLessThanOrEqual(10);
    // The new row sits AFTER the standard rows, so a price still resolves to the standard chart first.
    expect(marketCellForPrice(100)).toEqual({ x: 6, y: 10 });
    expect(marketCellForPrice(350)).toEqual({ x: 18, y: 10 });
    expect(marketCellForPrice(450)).toEqual({ x: 18, y: 11 });
  });

  it("absorbs the extra effects: from the standard top row a token can rise; on the standard chart it cannot", () => {
    const at = (m: { x: number; y: number; price: number } | null) => (m ? [m.x, m.y, m.price] : null);
    // Standard: $350 is the corner; a pay stays.
    expect(at(projectDividendCellMove({ x: 18, y: 10 }, "pay"))).toEqual([18, 10, 350]);
    expect(at(projectRiseMove({ x: 6, y: 10 }))).toEqual([6, 10, 100]);
    activateMarketChart(DYNAMIC_MARKET_CHART);
    // Dynamic: the ledge turns up into the new row; a double jump from $325 goes right then up.
    expect(at(projectDividendCellMove({ x: 18, y: 10 }, "pay"))).toEqual([18, 11, 450]);
    expect(at(projectDividendCellMove({ x: 17, y: 10 }, "pay", 2))).toEqual([18, 11, 450]);
    expect(at(projectRiseMove({ x: 6, y: 10 }))).toEqual([6, 11, 112]);
    // And the new row's own corner is the ceiling now.
    expect(at(projectDividendCellMove({ x: 18, y: 11 }, "pay"))).toEqual([18, 11, 450]);
    // A withhold from the new row's left edge falls back onto the standard chart.
    expect(at(projectDividendCellMove({ x: 0, y: 11 }, "withhold"))).toEqual([0, 10, 60]);
  });

  it("is chosen by the variant, through the same switch as the board and the tray, and restored after", () => {
    expect(chartFor({ dynamicStockMarket: false })).toBe(STANDARD_MARKET_CHART);
    expect(chartFor({ dynamicStockMarket: true })).toBe(DYNAMIC_MARKET_CHART);
    const seen = withRules({ ...STANDARD_VARIANTS, dynamicStockMarket: true }, () => marketMaxY());
    expect(seen).toBe(11);
    expect(marketMaxY()).toBe(10);
    expect(withMarketChart(DYNAMIC_MARKET_CHART, () => PRICE_GRID.length)).toBe(PRICE_GRID.length + 19);
  });
});
