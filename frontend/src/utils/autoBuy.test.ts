/** @jest-environment node */
//
// Design note #1240 (harness): what Auto-Buy picks, and what it refuses to pick for itself.
//
// The board's purchase rule is a stub here -- the real one is `sharePurchaseBlock`, tested on its own. What
// these cases pin is the tool's OWN behaviour: order of preference, the cap, IPO before pool, an unparred
// corporation skipped rather than parred, pass when nothing qualifies, stop when the round changes.

import {
  armAutoBuy,
  autoBuyDecision,
  autoBuySourceOrder,
  autoBuyWake,
  holdingPercent,
  refreshAutoBuyWatch,
  type AutoBuyPlan,
  type AutoBuySettings,
} from "./autoBuy";
import type { GameStateResponse } from "./gameState";
import { readStripped, sliceBetween } from "./sourceScan";

const ME = "me";

type Co = {
  id: number;
  par?: string | null;
  ipo?: number;
  pool?: number;
  mine?: number;
};

function board(companies: Co[], round = 3): GameStateResponse {
  return {
    macro_round_number: round,
    public_companies: companies.map((entry) => ({
      company_id: entry.id,
      ticker: `C${entry.id}`,
      par_value: entry.par === undefined ? "67" : entry.par,
      ipo_pool_percentage: entry.ipo ?? 0,
      bank_pool_percentage: entry.pool ?? 0,
      player_holdings: entry.mine ? [{ player: ME, percentage: entry.mine }] : [],
    })),
  } as unknown as GameStateResponse;
}

const allowAll = () => null;

/* #1333: the old (ids, cap) shape, as one shared cap over every id, with the wakes off so the #1240 cases
   pin the picker alone. */
function arm(
  state: GameStateResponse,
  ids: readonly number[],
  cap: number,
  extra: Partial<AutoBuySettings> = {},
): AutoBuyPlan {
  return armAutoBuy(state, ME, {
    targets: ids.map((companyId) => ({ companyId, maxPercent: cap })),
    source: "Ipo",
    stopOnPar: false,
    stopOnSale: false,
    ...extra,
  });
}

describe("autoBuyDecision", () => {
  it("buys the first ticked corporation with a share on offer, IPO before pool", () => {
    const state = board([{ id: 1, ipo: 50, pool: 20 }, { id: 2, ipo: 90 }]);
    const plan = arm(state, [2, 1], 60);
    expect(autoBuyDecision(state, plan, allowAll)).toEqual({ action: "buy", companyId: 2, source: "Ipo" });
  });

  it("falls to the pool when the IPO is empty, and to the next corporation when both are", () => {
    const state = board([{ id: 1, pool: 20 }, { id: 2, ipo: 10 }]);
    expect(autoBuyDecision(state, arm(state, [1, 2], 60), allowAll)).toEqual({
      action: "buy",
      companyId: 1,
      source: "Bank",
    });
    const empty = board([{ id: 1 }, { id: 2, ipo: 10 }]);
    expect(autoBuyDecision(empty, arm(empty, [1, 2], 60), allowAll)).toEqual({
      action: "buy",
      companyId: 2,
      source: "Ipo",
    });
  });

  it("stops buying a corporation at the cap and moves on", () => {
    const state = board([{ id: 1, ipo: 50, mine: 30 }, { id: 2, ipo: 90 }]);
    expect(autoBuyDecision(state, arm(state, [1, 2], 30), allowAll)).toEqual({
      action: "buy",
      companyId: 2,
      source: "Ipo",
    });
    expect(holdingPercent(state, 1, ME)).toBe(30);
    expect(holdingPercent(state, 2, ME)).toBe(0);
  });

  it("skips an unparred corporation rather than parring it", () => {
    const state = board([{ id: 1, par: null, ipo: 100 }, { id: 2, ipo: 90 }]);
    expect(autoBuyDecision(state, arm(state, [1, 2], 60), allowAll)).toEqual({
      action: "buy",
      companyId: 2,
      source: "Ipo",
    });
  });

  it("asks the board's rule per source and skips what it refuses", () => {
    const state = board([{ id: 1, ipo: 50, pool: 20 }]);
    const ipoBlocked = (_id: number, source: "Ipo" | "Bank") => (source === "Ipo" ? "no" : null);
    expect(autoBuyDecision(state, arm(state, [1], 60), ipoBlocked)).toEqual({
      action: "buy",
      companyId: 1,
      source: "Bank",
    });
  });

  it("hands the turn back when nothing qualifies, and never passes it (design note #1274)", () => {
    /* JUNO-CV4 18-26: the auto-buyer passed every turn its list had nothing for. A standing instruction to
       buy is not one to pass -- the player may still want to sell, or buy something unticked. */
    const state = board([{ id: 1, ipo: 50, mine: 60 }, { id: 2, par: null, ipo: 100 }]);
    const done = autoBuyDecision(state, arm(state, [1, 2], 60), allowAll);
    expect(done.action).toBe("done");
    expect(autoBuyDecision(state, arm(state, [1], 60), () => "blocked").action).toBe("done");
    const APP = readStripped("App.tsx");
    const effect = sliceBetween(APP, "(companyId, source) => purchaseBlockFor(companyId, source, 1),", "const handleSellShares");
    expect(effect).not.toContain("handlePassTurn()");
    expect(effect).toContain('decision.action === "stop" || decision.action === "done"');
  });

  it("stops when the Stock Round it was set in has ended", () => {
    const armedIn = board([{ id: 1, ipo: 50 }], 3);
    const later = board([{ id: 1, ipo: 50 }], 4);
    const decision = autoBuyDecision(later, arm(armedIn, [1], 60), allowAll);
    expect(decision.action).toBe("stop");
  });

  it("stops with nothing ticked", () => {
    const state = board([{ id: 1, ipo: 50 }]);
    expect(autoBuyDecision(state, arm(state, [], 60), allowAll).action).toBe("stop");
  });
});

/* Design note #1333 (harness): the graduation -- a cap per corporation, the source preference, the wakes. */
describe("#1333: per-corporation caps, source, and the off-switches", () => {
  it("10a: each target has its own cap", () => {
    const state = board([{ id: 1, ipo: 50, mine: 20 }, { id: 2, ipo: 50, mine: 20 }]);
    const plan = armAutoBuy(state, ME, {
      targets: [
        { companyId: 1, maxPercent: 20 },
        { companyId: 2, maxPercent: 30 },
      ],
      source: "Ipo",
      stopOnPar: false,
      stopOnSale: false,
    });
    expect(autoBuyDecision(state, plan, allowAll)).toEqual({ action: "buy", companyId: 2, source: "Ipo" });
  });

  it("10c: Bank prefers the pool, Cheapest compares the two prices, IPO on a tie or unknown", () => {
    const state = board([{ id: 1, ipo: 50, pool: 20 }]);
    expect(autoBuyDecision(state, arm(state, [1], 60, { source: "Bank" }), allowAll)).toMatchObject({ source: "Bank" });
    const cheap = (companyId: number, source: "Ipo" | "Bank") => (source === "Ipo" ? 67 : 50);
    expect(autoBuyDecision(state, arm(state, [1], 60, { source: "Cheapest" }), allowAll, cheap)).toMatchObject({
      source: "Bank",
    });
    const dear = (companyId: number, source: "Ipo" | "Bank") => (source === "Ipo" ? 67 : 90);
    expect(autoBuyDecision(state, arm(state, [1], 60, { source: "Cheapest" }), allowAll, dear)).toMatchObject({
      source: "Ipo",
    });
    expect(autoBuyDecision(state, arm(state, [1], 60, { source: "Cheapest" }), allowAll)).toMatchObject({
      source: "Ipo",
    });
    expect(autoBuySourceOrder("Bank", { ipo: true, bank: false }, () => null)).toEqual(["Ipo"]);
    expect(autoBuySourceOrder("Cheapest", { ipo: true, bank: true }, (s) => (s === "Ipo" ? 67 : 67))).toEqual([
      "Ipo",
      "Bank",
    ]);
  });

  it("10b: a new par wakes it, and a sale of a ticked corporation wakes it; the tool's own buy does not", () => {
    const armed = board([{ id: 1, ipo: 50, pool: 10 }, { id: 2, par: null, ipo: 100 }]);
    const plan = arm(armed, [1], 60, { stopOnPar: true, stopOnSale: true });
    expect(autoBuyWake(armed, plan)).toBeNull();
    const parred = board([{ id: 1, ipo: 50, pool: 10 }, { id: 2, par: "100", ipo: 100 }]);
    expect(autoBuyWake(parred, plan)).toContain("C2 has been parred");
    expect(autoBuyDecision(parred, plan, allowAll).action).toBe("stop");
    const sold = board([{ id: 1, ipo: 50, pool: 30 }, { id: 2, par: null, ipo: 100 }]);
    expect(autoBuyWake(sold, plan)).toContain("sold to the pool");
    // Our own pool buy drains the pool; the refreshed watch sees the lower figure and stays quiet.
    const bought = board([{ id: 1, ipo: 50, pool: 0, mine: 10 }, { id: 2, par: null, ipo: 100 }]);
    expect(autoBuyWake(bought, refreshAutoBuyWatch(plan, armed))).toBeNull();
    // Switches off: neither wakes.
    const deaf = arm(armed, [1], 60);
    expect(autoBuyWake(parred, deaf)).toBeNull();
    expect(autoBuyWake(sold, deaf)).toBeNull();
  });

  it("10a: the modal lists only parred corporations, and the acting effect refreshes the watch before buying", () => {
    const MODAL = readStripped("components/AutoBuyModal.tsx");
    expect(MODAL).toContain("corporations.filter((row) => row.parValue !== null)");
    expect(MODAL).toContain("not yet parred and");
    const APP = readStripped("App.tsx");
    const effect = sliceBetween(APP, "autoBuyDecision(", "const handleSellShares");
    expect(effect.indexOf("setAutoBuyPlan(refreshAutoBuyWatch(autoBuyPlan, gameState));")).toBeGreaterThan(
      effect.indexOf("autoBoughtAtLogIndexRef.current = lastLogIndex;"),
    );
  });
});

/* Design note #1243 (harness): Auto-Buy waits while a home station is owed.
   The buy that floats a corporation holds the seat (#769) and moves the log, so the acting effect fires
   again on the same turn; with buying blocked it passed, the server appended the no-op (#763's gate
   returns the board unchanged, but the append comes first), the index moved, and it passed again -- a
   flood interleaved with the president's placement. Source scan: the guard is a hex lookup that lives in
   `components/` (#7), so it cannot be written into `autoBuyDecision`. */
describe("#1243: the acting effect waits for the home station", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  })();

  it("checks the debt before deciding, and returns without disarming", () => {
    const guard = APP.indexOf("if (homeTokenOwed(gameState, homeHexToAxial)) return;");
    const decide = APP.indexOf("(companyId, source) => purchaseBlockFor(companyId, source, 1),");
    const acted = APP.indexOf("autoBoughtAtLogIndexRef.current = lastLogIndex;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(decide);
    expect(guard).toBeLessThan(acted);
    expect(APP).toContain('import { homeTokenBlock, homeTokenOwed } from "./utils/homeTokenGate";');
  });
});
