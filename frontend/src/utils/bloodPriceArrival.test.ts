/** @jest-environment node */
// frontend/src/utils/bloodPriceArrival.test.ts -- S9-11.
//
// ==================================================================
//  DESIGN NOTE (S9-11): THE BLOOD PRICE LANDING WAS NEVER STAMPED
// ==================================================================
//
// FOUND BY SLICE 8.1 (RULES_HARDENING_BACKLOG.md): `applySandboxMarketAction`'s `BuyTrainFromCorporation` arm
// wrote `projectBloodPriceMove`'s cell straight into `market_positions` instead of routing it through
// `withArrival` (#646: "every place a marker moves goes through here"). The seller's token (the mover then -- UR-4 made it the buyer's) carried no
// arrival ordinal at all. #647's rule-6.0 stack tie-break (`operatingOrderKey` in `operatingOrder.ts`) reads
// an unrecorded arrival as `Infinity`, so the unstamped token sorted after every stamped token sharing its
// cell -- and worse, a LATER stamped arrival into that same cell would then sort ABOVE a Blood Price landing
// that got there first, because `Infinity - finite > 0` reads as "arrived later" under the ascending
// comparator.
//
// THIS FILE PINS THE FIX RATHER THAN THE SYMPTOM. The repair is one call site routed through the same
// `withArrival` every other mover (`SellStock`, `DeclareDividends`) already used -- no new state, no second
// history mechanism, no replay-ABI change. `nextArrival` derives the ordinal from the marks already on the
// chart (not a clock), so the fix is automatically replay-safe: a rebuild from the log reaches the same
// numbers a live session would.
//
// CORPUS: swept separately (server/data, frontend/sandbox-log-JUNO-*.json, the golden and Z6C fixtures) --
// no stored game exercises a Carcosan train sale, so this defect never actually mis-sorted a played game.
// The tests below exercise the atom directly rather than through a corpus replay.
//
// UR-4 (OD-UR-5(b) -- DECIDED 2026-09-24, backlog D-50): THE TOKEN THAT MOVES IS THE BUYER'S. When this file was
// written the arm moved the SELLER (#1090); the owner has since ruled that the buyer pays the Blood Price and its
// marker moves Left 1 / Down 1, the seller's never (UR-F22). The stamping rule pinned here is unchanged -- it is the
// same `withArrival` landing -- so the cases keep their shape and the mover is now `BUYER` (the message's
// `buyer_protocol_id`). The seller (`SELLER`) holds no mark on these charts, and the arm never reads one.

import {
  applySandboxMarketAction,
  type SandboxMarketContext,
} from "../gameEngine/sandboxSession";
import { nextArrival, withArrival, type SandboxMarketPrices } from "../gameEngine/sandboxState";
import { operatingOrderKey, compareOperatingOrder } from "../gameEngine/operatingOrder";

/** The Blood Price's BUYER -- the corporation whose token the arm moves (UR-4, OD-UR-5(b)). */
const BUYER = 3;
/** The Carcosan seller. Never moved; never on these charts. */
const SELLER = 9;
const OTHER = 6;
const THIRD = 1;

/** A Carcosan sale message. `model_type` and the identity fields are the only ones the arm reads; the extra
 *  fields (including a bogus one) are here to prove a crafted client message cannot smuggle anything in. */
const buyTrain = (overrides: Record<string, unknown> = {}) =>
  ({
    BuyTrainFromCorporation: {
      game_id: 1,
      buyer_protocol_id: BUYER,
      seller_protocol_id: SELLER,
      model_type: "5",
      price: "450",
      ...overrides,
    },
  }) as never;

/** The message this arm actually gates on -- `ctx.isCarcosanSale` returning true and a mark to move from. */
const carcosanCtx = (
  landed: { price: number; x: number; y: number } | null,
  over: Partial<SandboxMarketContext> = {},
): SandboxMarketContext => ({
  isCarcosanSale: () => true,
  projectBloodPrice: () => landed,
  ...over,
});

describe("S9-11: the Blood Price landing is stamped as an arrival", () => {
  it("stamps a fresh landing with an arrival ordinal rather than leaving it undefined", () => {
    const prices: SandboxMarketPrices = { [BUYER]: { price: 100, x: 6, y: 10 } };
    const landed = { price: 90, x: 5, y: 10 };
    const result = applySandboxMarketAction(prices, buyTrain(), carcosanCtx(landed));

    expect(result.prices[BUYER]?.enteredAt).toBe(nextArrival(prices));
    expect(typeof result.prices[BUYER]?.enteredAt).toBe("number");
  });

  it("a Blood Price landing that got to a cell first still outranks a stamped token that arrives later", () => {
    /* THE EXACT REGRESSION #S9-11 NAMES. Before the fix `landed` carried no `enteredAt`, so the tie-break
       read it as `Infinity` -- "arrived last" -- however early it actually got there. */
    let prices: SandboxMarketPrices = { [BUYER]: { price: 100, x: 6, y: 10 } };

    // The Blood Price lands in a cell nothing else occupies yet.
    const bloodPriceLanding = { price: 71, x: 2, y: 3 };
    const afterBloodPrice = applySandboxMarketAction(
      prices,
      buyTrain(),
      carcosanCtx(bloodPriceLanding),
    );
    prices = afterBloodPrice.prices;
    expect(prices[BUYER]?.enteredAt).toBeDefined();

    // A second, already-floated corporation's ordinary sale later walks into the SAME cell.
    prices = { ...prices, [OTHER]: { price: 90, x: 5, y: 5 } };
    const laterLanding = { price: 71, x: 2, y: 3 };
    const afterLaterSale = applySandboxMarketAction(
      prices,
      { SellStock: { game_id: 1, protocol_id: OTHER, percentage: 10 } } as never,
      { projectSale: () => laterLanding, saleRefused: () => false },
    );
    prices = afterLaterSale.prices;

    const bloodPriceKey = operatingOrderKey(BUYER, prices[BUYER]!.price, null, prices[BUYER]);
    const laterKey = operatingOrderKey(OTHER, prices[OTHER]!.price, null, prices[OTHER]);

    // Same price, same cell (column, row) -- the comparator must fall through to arrival, and the token
    // that reached the cell FIRST (the Blood Price) must sort ahead of (before) the one that arrived later.
    expect(bloodPriceKey.column).toBe(laterKey.column);
    expect(bloodPriceKey.row).toBe(laterKey.row);
    expect(bloodPriceKey.arrival).toBeLessThan(laterKey.arrival);
    expect(compareOperatingOrder(bloodPriceKey, laterKey)).toBeLessThan(0);
  });

  it("event A then B: the Blood Price arriving before B's sale sorts before it", () => {
    // Both corporations must already be floated (on the chart) before either can move at all.
    let prices: SandboxMarketPrices = {
      [BUYER]: { price: 100, x: 6, y: 10 },
      [OTHER]: { price: 90, x: 5, y: 5 },
    };
    prices = applySandboxMarketAction(prices, buyTrain(), carcosanCtx({ price: 50, x: 1, y: 1 })).prices;
    prices = applySandboxMarketAction(
      prices,
      { SellStock: { game_id: 1, protocol_id: OTHER, percentage: 10 } } as never,
      { projectSale: () => ({ price: 50, x: 1, y: 1 }), saleRefused: () => false },
    ).prices;

    expect(prices[BUYER]!.enteredAt!).toBeLessThan(prices[OTHER]!.enteredAt!);
  });

  it("event B then A: reversing the order reverses which one sorts first", () => {
    let prices: SandboxMarketPrices = {
      [BUYER]: { price: 100, x: 6, y: 10 },
      [OTHER]: { price: 90, x: 5, y: 5 },
    };
    prices = applySandboxMarketAction(
      prices,
      { SellStock: { game_id: 1, protocol_id: OTHER, percentage: 10 } } as never,
      { projectSale: () => ({ price: 50, x: 1, y: 1 }), saleRefused: () => false },
    ).prices;
    prices = applySandboxMarketAction(prices, buyTrain(), carcosanCtx({ price: 50, x: 1, y: 1 })).prices;

    expect(prices[OTHER]!.enteredAt!).toBeLessThan(prices[BUYER]!.enteredAt!);
  });

  it("a Blood Price that lands where it started is not a move and is not stamped", () => {
    /* The arm's own guard -- `landed.x === mark.x && landed.y === mark.y` -- returns `unchanged` before
       reaching `withArrival` at all. This pins that the fix did not disturb that early return. */
    const prices: SandboxMarketPrices = { [BUYER]: { price: 100, x: 6, y: 10 } };
    const result = applySandboxMarketAction(prices, buyTrain(), carcosanCtx({ price: 100, x: 6, y: 10 }));
    expect(result.prices).toBe(prices);
    expect(result.moved).toBeNull();
  });

  it("replay reproduces the same arrival stamps as live play, in one burst", () => {
    const messages = [
      buyTrain(),
      { SellStock: { game_id: 1, protocol_id: OTHER, percentage: 10 } } as never,
      { SellStock: { game_id: 1, protocol_id: THIRD, percentage: 10 } } as never,
    ];
    const ctxFor = (msg: unknown): SandboxMarketContext => {
      if (typeof msg === "object" && msg !== null && "BuyTrainFromCorporation" in msg) {
        return carcosanCtx({ price: 50, x: 1, y: 1 });
      }
      return { projectSale: () => ({ price: 50, x: 1, y: 1 }), saleRefused: () => false };
    };

    const runOnce = (): SandboxMarketPrices => {
      // All three corporations are already floated -- a corporation with no position cannot move at all.
      let prices: SandboxMarketPrices = {
        [BUYER]: { price: 100, x: 6, y: 10 },
        [OTHER]: { price: 90, x: 5, y: 5 },
        [THIRD]: { price: 76, x: 4, y: 3 },
      };
      for (const msg of messages) {
        prices = applySandboxMarketAction(prices, msg, ctxFor(msg)).prices;
      }
      return prices;
    };

    const live = runOnce();
    // "A replay applies the whole log in one burst" -- re-running from an empty chart, as a replay would
    // from the start of a room's log, reaches the exact same ordinals rather than continuing some
    // browser-session counter.
    const replayed = runOnce();

    expect(replayed[BUYER]).toEqual(live[BUYER]);
    expect(replayed[OTHER]).toEqual(live[OTHER]);
    expect(replayed[THIRD]).toEqual(live[THIRD]);
    expect(live[BUYER]!.enteredAt).toBe(1);
    expect(live[OTHER]!.enteredAt).toBe(2);
    expect(live[THIRD]!.enteredAt).toBe(3);
  });

  it("undo/revert leaves no stale ordering state -- the ordinal is derived from the chart, not a counter", () => {
    /* #646: "an arrival ORDINAL derived from the marks already on the chart, not a clock". A `RevertTo` that
       drops a later entry (the shell's undo) restores an EARLIER `prices` object outright; there is no
       separate counter anywhere else that a revert could leave stale. This proves it by reverting to the
       pre-Blood-Price chart and applying a DIFFERENT action, which must reuse the same ordinal the undone
       action had used -- not continue past it. */
    const before: SandboxMarketPrices = {
      [BUYER]: { price: 100, x: 6, y: 10 },
      [OTHER]: { price: 90, x: 5, y: 5 },
    };
    const afterBloodPrice = applySandboxMarketAction(before, buyTrain(), carcosanCtx({ price: 50, x: 1, y: 1 }))
      .prices;
    expect(afterBloodPrice[BUYER]!.enteredAt).toBe(1);

    // Undo: the session reverts to `before` (the Blood Price message is dropped from the log).
    const reverted = before;

    // A different action is applied against the reverted chart.
    const afterOther = applySandboxMarketAction(
      reverted,
      { SellStock: { game_id: 1, protocol_id: OTHER, percentage: 10 } } as never,
      { projectSale: () => ({ price: 60, x: 2, y: 2 }), saleRefused: () => false },
    ).prices;

    expect(afterOther[OTHER]!.enteredAt).toBe(1);
  });

  it("a crafted client message cannot forge the arrival order", () => {
    /* The message schema for `BuyTrainFromCorporation` (messageSchema.ts) carries no arrival/order field at
       all -- only identity, model and price (and, since UR-4, the copy). The arm destructures the two ids and `model_type` and
       nothing else, so a hand-crafted extra field is inert: the landing is still stamped SERVER-SIDE by
       `withArrival`/`nextArrival` from the authoritative chart, never from anything the client supplied. */
    const prices: SandboxMarketPrices = {
      [BUYER]: { price: 100, x: 6, y: 10 },
      [OTHER]: { price: 82, x: 4, y: 4, enteredAt: 7 },
    };
    const forged = buyTrain({ enteredAt: 1, arrival: -999, order: "first" });
    const result = applySandboxMarketAction(prices, forged, carcosanCtx({ price: 90, x: 5, y: 4 }));

    // The forged fields are simply not read: the real stamp is derived, and it is *after* the existing
    // token (7), never the forged "-999" or "1".
    expect(result.prices[BUYER]?.enteredAt).toBe(nextArrival(prices));
    expect(result.prices[BUYER]?.enteredAt).toBe(8);
  });

  it("leaves the trade price, the move reason and every other corporation's mark untouched", () => {
    const prices: SandboxMarketPrices = {
      [BUYER]: { price: 100, x: 6, y: 10 },
      [OTHER]: { price: 82, x: 4, y: 4, enteredAt: 3 },
    };
    const result = applySandboxMarketAction(prices, buyTrain(), carcosanCtx({ price: 90, x: 5, y: 10 }));

    expect(result.tradePrice).toBeNull();
    expect(result.moved).toEqual({
      companyId: BUYER,
      from: 100,
      to: 90,
      reason: "bloodPrice",
    });
    // The unrelated corporation's own mark and arrival are exactly what they were.
    expect(result.prices[OTHER]).toEqual(prices[OTHER]);
  });

  it("a non-Carcosan sale is still refused the move (and therefore never touches an arrival)", () => {
    const prices: SandboxMarketPrices = { [BUYER]: { price: 100, x: 6, y: 10 } };
    const result = applySandboxMarketAction(
      prices,
      buyTrain(),
      carcosanCtx({ price: 90, x: 5, y: 10 }, { isCarcosanSale: () => false }),
    );
    expect(result.prices).toBe(prices);
    expect(result.moved).toBeNull();
  });
});

describe("S9-11: withArrival is the one place every landing is stamped", () => {
  it("is what the Blood Price arm now calls, exactly like the sale and dividend arms already did", () => {
    const prices: SandboxMarketPrices = { [BUYER]: { price: 100, x: 6, y: 10 } };
    const direct = withArrival(prices, BUYER, { price: 50, x: 1, y: 1 });
    const viaArm = applySandboxMarketAction(prices, buyTrain(), carcosanCtx({ price: 50, x: 1, y: 1 })).prices[
      BUYER
    ];
    expect(viaArm).toEqual(direct);
  });
});
