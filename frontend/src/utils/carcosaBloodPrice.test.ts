/** @jest-environment node */
//
// ==================================================================
//  UR-4 (Variant Certification 1B -- Unpredictable Revenue): THE BLOOD PRICE, COPY BY COPY, PAID BY THE BUYER
// ==================================================================
//
// OWNER RULINGS (VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md, "Owner rulings" -- OD-UR-5; backlog D-48, D-50):
//   (a) 5a-1 -- the Blood Price CURES the train. The buyer receives an ORDINARY train: it counts against the buyer's
//       limit, runs, rusts and sells normally, can be a Diesel trade-in when otherwise eligible, and has no gilding, no
//       fog deadline, no Carcosan exemption and no other supernatural status. It is an ADDITIONAL ordinary train, +1 in
//       circulation relative to the printed Depot supply: "SYNTHETIC ORIGIN / SUPPLY PROVENANCE MAY PERSIST !=
//       SUPERNATURAL RULES STATUS PERSISTS". The transfer itself changes no phase, rust, Gentle Rust mark, Depot tier,
//       18XX+ era or real-D doom trigger -- an intercorporate purchase, not a Bank / Depot purchase.
//   (b) the BUYER only -- the buyer pays the cash price and ITS marker moves Left 1 / Down 1; the seller gets no
//       movement (its benefit is release from the curse); never both. #1090's seller move is superseded (UR-F22).
//   (c) 5c-2 -- the sale NAMES THE COPY. Selling the ordinary copy of a model the seller also holds gilded is an ordinary
//       sale (no Blood Price, the gilded copy keeps its gilding, curse and deadline); selling the gilded copy is the
//       Blood Price (UR-F21).
//
// THE REPRESENTATION (UR-4): one optional boolean, `gilded`, on `BuyTrainFromCorporation` and `ProposeTrainPurchase`
// (and so on the offer and its derived settlement) -- multiset copy selection, never a persistent train identity. Absent
// is legal only where it cannot be ambiguous (the seller holds only gilded, or only ordinary, copies of the model).
// Provenance (`ghost_trains`) is supply accounting only, and it now follows the ADDITIONAL copy into and out of the Bank
// Pool (`returned_ghost_trains`), so a cured train traded in or discarded never becomes one of the printed copies and
// never leaves a stale marker behind (#1675's hazard, reachable once the cured train is ordinary).
//
// Every case goes through production authority: the reducer with the composed context a server builds
// (`sandboxActionContext` over `sandboxReplayProviders`), and `RoomSession` for the hosted path.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const SS = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const GP = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const TSA = require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const DX = require("../gameEngine/dieselExchange") as typeof import("../gameEngine/dieselExchange");
const TA = require("../gameEngine/trainAvailability") as typeof import("../gameEngine/trainAvailability");
const TL = require("../gameEngine/trainLimit") as typeof import("../gameEngine/trainLimit");
const YS = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { SERVER_REPLAY_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { sandboxActionContext } = require("../gameEngine/actionContext") as typeof import("../gameEngine/actionContext");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { projectBloodPriceMove } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { nextArrival } = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { nextDerivedAction } = require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { validateGameplayMessage } = require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { tileEraFor } = require("../gameEngine/gameConstants") as typeof import("../gameEngine/gameConstants");

const { CO, BO, NYC, CPR, P1, P2, P3, GULF, LONG_ROUTE, urBoard, companyOf, runMsg, partsFor } = S;

/* ------------------------------------------------------------------ */
/* Messages and the composed reducer                                   */
/* ------------------------------------------------------------------ */

type Msg = Record<string, unknown>;
const sale = (buyer: number, seller: number, model: string, price: string, gilded?: boolean): Msg => ({
  BuyTrainFromCorporation: {
    game_id: 1,
    buyer_protocol_id: buyer,
    seller_protocol_id: seller,
    model_type: model,
    price,
    ...(gilded === undefined ? {} : { gilded }),
  },
});
const propose = (seller: number, buyer: number, model: string, price: string, gilded?: boolean): Msg => ({
  ProposeTrainPurchase: {
    game_id: 1,
    seller_protocol_id: seller,
    seller_ticker: "narration",
    seller_president: "narration",
    buyer_protocol_id: buyer,
    buyer_ticker: "narration",
    model_type: model,
    price,
    ...(gilded === undefined ? {} : { gilded }),
  },
});
const answer = (seller: number, accept: boolean): Msg => ({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: seller, accept } });
const exchange = (id: number, model: string): Msg => ({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } });
const discard = (id: number, model: string): Msg => ({ DiscardTrain: { game_id: 1, protocol_id: id, model_type: model } });
const buyDepot = (id: number, tier?: string): Msg => ({
  BuyHardwareFromPool: { game_id: 1, protocol_id: id, ...(tier === undefined ? {} : { model_type: tier }) },
});
const buyPool = (id: number, model: string): Msg => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } });

const providers = sandboxReplayProviders();
const ctxFor = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  sandboxActionContext(providers, { state, msg: msg as never, actor, grid: GULF, gridBefore: GULF });
/** The reducer as a server's engine runs it: the composed context, including the chart's Blood Price projection. */
const reduce = (state: GameStateResponse, msg: unknown, actor: string | null = P1) =>
  SS.applySandboxAction(state, msg as never, ctxFor(state, msg, actor));
/** The chart step's own report (the Activity Log's market sentence reads this). */
const report = (state: GameStateResponse, msg: unknown, actor: string | null = P1) =>
  SS.sandboxChartStepReport(state, msg as never, ctxFor(state, msg, actor));

const c = (state: GameStateResponse, id: number): PublicCompanyState => companyOf(state, id);
const treasury = (state: GameStateResponse, id: number) => Number(c(state, id).treasury);
const row = (state: GameStateResponse, tier: string) => GP.depotInventory(state).find((entry) => entry.tier === tier)!;
const rows = (state: GameStateResponse) =>
  GP.depotInventory(state)
    .map((entry) => `${entry.tier}:${entry.remaining}`)
    .join(" ");
const poolProvenance = (state: GameStateResponse) =>
  (state as GameStateResponse & { returned_ghost_trains?: readonly string[] }).returned_ghost_trains ?? [];
const mark = (state: GameStateResponse, id: number) => state.market_positions?.[id] ?? null;

/** Every provenance marker belongs to a copy that is really there -- a fleet's `ghost_trains` is a sub-multiset of its
 *  `owned_trains`, and the Bank Pool's provenance of the pool -- and none has been lost or invented: the count of
 *  markers in play is the count of synthetic copies the case put in play. */
function provenanceCoherent(state: GameStateResponse, syntheticInPlay: number): void {
  const within = (inner: readonly string[], outer: readonly string[]) => {
    const pool = [...outer];
    return inner.every((model) => {
      const at = pool.indexOf(model);
      if (at < 0) return false;
      pool.splice(at, 1);
      return true;
    });
  };
  let markers = 0;
  for (const company of state.public_companies) {
    const ghosts = company.ghost_trains ?? [];
    expect([company.ticker, within(ghosts, company.owned_trains ?? [])]).toEqual([company.ticker, true]);
    markers += ghosts.length;
  }
  expect(within(poolProvenance(state), state.returned_trains ?? [])).toBe(true);
  markers += poolProvenance(state).length;
  expect(markers).toBe(syntheticInPlay);
}

/* ------------------------------------------------------------------ */
/* Boards                                                              */
/* ------------------------------------------------------------------ */

/** The gilded Carcosa copy: gilding (`carcosan_trains`), provenance (`ghost_trains`), the corporation's curse. */
const GILDED = (model: string, extra: Partial<PublicCompanyState> = {}): Partial<PublicCompanyState> =>
  ({ is_carcosan: true, carcosan_trains: [model], ghost_trains: [model], ...extra }) as Partial<PublicCompanyState>;
/** A copy already cured by an earlier Blood Price: provenance only. */
const CURED = (...models: string[]): Partial<PublicCompanyState> => ({ ghost_trains: models }) as Partial<PublicCompanyState>;

/** Phase 6 on the printed board: B&O's REAL 6 is the phase and one printed 6 is left in the Depot. B&O ALSO holds the
 *  gilded Carcosa 6 -- a gilded copy and an ordinary copy of one model (OD-UR-5(c)). C&O is at its Purchase Trains step.
 *  `sellerPresident` P1 = the same-president direct sale (#1592); P2 = the offer flow. */
const mixed = (sellerPresident: string = P1, over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 1000 },
      { id: BO, president: sellerPresident, trains: ["6", "6"], extra: GILDED("6") },
      { id: NYC, president: P3, trains: ["5", "5"] },
    ],
    step: "Hardware",
    macro: 6,
    ...over,
  });

/** The same table with B&O holding ONLY the gilded 6 (beside a 5): the unnamed sale is unambiguous -- the Blood Price. */
const onlyGilded = (sellerPresident: string = P1) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 1000 },
      { id: BO, president: sellerPresident, trains: ["5", "6"], extra: GILDED("6") },
      { id: NYC, president: P3, trains: ["6", "5"] },
    ],
    step: "Hardware",
    macro: 6,
  });

/** C&O already holds a CURED 6 (bought through an earlier Blood Price): phase 6 (B&O's real 6), one printed 6 left. */
const curedAtCO = (over: Partial<Parameters<typeof urBoard>[0]> = {}, coTrains: string[] = ["5", "6"]) =>
  urBoard({
    corps: [
      { id: CO, president: P1, trains: coTrains, treasury: 1500, extra: CURED("6") },
      { id: BO, president: P2, trains: ["6"] },
      { id: NYC, president: P1, trains: ["5"], treasury: 1500 },
    ],
    step: "Hardware",
    macro: 6,
    ...over,
  });

const MIXED_DIGEST = () => stateDigest(mixed());

/* ================================================================== */
/* A. UR-F21 -- THE SALE NAMES THE COPY (OD-UR-5(c) = 5c-2)            */
/* ================================================================== */

describe("A. UR-F21: which copy is sold decides whether it is the Blood Price", () => {
  it("A1. the ORDINARY copy's sale is an ordinary sale: the gilded copy keeps its gilding, provenance, curse", () => {
    const board = mixed();
    const msg = sale(CO, BO, "6", "300", false);
    const after = reduce(board, msg);
    expect(c(after, BO).owned_trains).toEqual(["6"]);
    expect(c(after, BO).carcosan_trains).toEqual(["6"]);
    expect(c(after, BO).ghost_trains).toEqual(["6"]);
    expect(c(after, BO).is_carcosan).toBe(true);
    expect(c(after, CO).owned_trains).toEqual(["5", "6"]);
    expect(c(after, CO).ghost_trains ?? []).toEqual([]);
    expect(c(after, CO).carcosan_trains ?? []).toEqual([]);
    expect([treasury(after, CO), treasury(after, BO)]).toEqual([700, 1300]);
    // No Blood Price: no token moves, and the chart's sentence says nothing.
    expect(after.market_positions).toEqual(board.market_positions);
    expect(report(board, msg)).toBeNull();
  });

  it("A2. an UNNAMED sale of a model held both gilded and ordinary is ambiguous: refused atomically, in every moment", () => {
    const board = mixed();
    const msg = sale(CO, BO, "6", "300");
    const reason = TSA.trainSaleRefusal(board, { buyerId: CO, sellerId: BO, model: "6", price: "300" }, P1, GULF, "settlement");
    expect(reason).toMatch(/B&O holds both a gold-trimmed and an ordinary 6-train/);
    expect(stateDigest(reduce(board, msg))).toBe(MIXED_DIGEST());
    expect(report(board, msg)).toBeNull();
    // The proposal is refused with the same sentence (the offer can never carry an ambiguity to its answer).
    expect(TSA.proposeTrainPurchaseRefusal(mixed(P2), propose(BO, CO, "6", "300").ProposeTrainPurchase as never, P1, GULF)).toBe(reason);
  });

  it("A3. the GILDED copy's sale is the Blood Price: the gilding burns, the curse and deadline clear, provenance moves", () => {
    const after = reduce(mixed(), sale(CO, BO, "6", "300", true));
    expect(c(after, BO).owned_trains).toEqual(["6"]); // B&O keeps its REAL 6
    expect(c(after, BO).carcosan_trains).toEqual([]);
    expect(c(after, BO).ghost_trains).toEqual([]);
    expect(c(after, BO).is_carcosan).toBe(false);
    expect(c(after, BO).carcosan_doom_after_macro_round).toBeUndefined();
    expect(c(after, CO).owned_trains).toEqual(["5", "6"]);
    expect(c(after, CO).ghost_trains).toEqual(["6"]); // provenance only (the +1)
    expect(c(after, CO).carcosan_trains ?? []).toEqual([]);
    expect(c(after, CO).is_carcosan).toBeFalsy();
  });

  it("A4. naming the gilded copy where there is none is refused (no wrong-copy purification, no Blood Price invented)", () => {
    const plain = mixed(P1, {
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1000 },
        { id: BO, president: P1, trains: ["6"] },
        { id: NYC, president: P3, trains: ["5", "5"] },
      ],
    });
    expect(TSA.trainSaleRefusal(plain, { buyerId: CO, sellerId: BO, model: "6", price: "300", gilded: true } as never, P1, GULF, "settlement")).toMatch(
      /B&O holds no gold-trimmed 6-train/,
    );
    expect(stateDigest(reduce(plain, sale(CO, BO, "6", "300", true)))).toBe(stateDigest(plain));
  });

  it("A5. naming an ORDINARY copy where every copy is gilded is refused -- that sale can only be the Blood Price", () => {
    const board = onlyGilded();
    expect(TSA.trainSaleRefusal(board, { buyerId: CO, sellerId: BO, model: "6", price: "300", gilded: false } as never, P1, GULF, "settlement")).toMatch(
      /gold-trimmed/,
    );
    expect(stateDigest(reduce(board, sale(CO, BO, "6", "300", false)))).toBe(stateDigest(board));
    // Unnamed, it is unambiguous: the Blood Price.
    const after = reduce(board, sale(CO, BO, "6", "300"));
    expect(c(after, BO).carcosan_trains).toEqual([]);
    expect(c(after, CO).ghost_trains).toEqual(["6"]);
  });

  it("A6. the Blood Price predicate reads the copy, not the model", () => {
    const board = mixed();
    expect(SS.isCarcosanTransfer(board, BO, "6", true)).toBe(true);
    expect(SS.isCarcosanTransfer(board, BO, "6", false)).toBe(false);
    expect(SS.isCarcosanTransfer(board, BO, "6")).toBe(false); // ambiguous: it is no transfer at all (refused)
    expect(SS.isCarcosanTransfer(onlyGilded(), BO, "6")).toBe(true); // unambiguous: the gilded copy
    expect(SS.isCarcosanTransfer(onlyGilded(), BO, "5")).toBe(false);
    expect(SS.isCarcosanTransfer(board, NYC, "5")).toBe(false);
  });

  it("A7. beside the gilded copy a CURED copy is the ordinary one: its provenance leaves with it, the gilded copy keeps its own", () => {
    const board = mixed(P1, {
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1000 },
        { id: BO, president: P1, trains: ["6", "6"], extra: GILDED("6", { ghost_trains: ["6", "6"] }) },
        { id: NYC, president: P3, trains: ["6", "5"] },
      ],
    });
    const before = rows(board);
    const after = reduce(board, sale(CO, BO, "6", "300", false));
    expect(c(after, BO).owned_trains).toEqual(["6"]);
    expect(c(after, BO).carcosan_trains).toEqual(["6"]);
    expect(c(after, BO).ghost_trains).toEqual(["6"]); // the gilded copy's own
    expect(c(after, CO).ghost_trains).toEqual(["6"]); // the cured copy's, which left with it
    expect(rows(after)).toBe(before);
    provenanceCoherent(after, 2);
  });

  it("A8. the offer carries the copy to its derived settlement; the other copy's settlement is not consented", () => {
    let board = mixed(P2);
    board = reduce(board, propose(BO, CO, "6", "300", false), P1);
    expect(board.train_purchase_offer).toMatchObject({ model_type: "6", gilded: false });
    board = reduce(board, answer(BO, true), P2);
    expect(board.train_purchase_offer).toMatchObject({ accepted: true, gilded: false });
    const owed = nextDerivedAction({ state: board, mapGrid: GULF, emitted: new Set() });
    expect(owed?.msg).toMatchObject({ BuyTrainFromCorporation: { buyer_protocol_id: CO, seller_protocol_id: BO, model_type: "6", gilded: false } });
    // The OTHER copy, at the offer's price, is not what the seller agreed to: no consent, nothing moves, the offer stands.
    const wrongCopy = reduce(board, sale(CO, BO, "6", "300", true), null);
    expect(stateDigest(wrongCopy)).toBe(stateDigest(board));
    const settled = reduce(board, owed!.msg as never, null);
    expect(c(settled, BO).carcosan_trains).toEqual(["6"]);
    expect(c(settled, BO).is_carcosan).toBe(true);
    expect(c(settled, CO).owned_trains).toEqual(["5", "6"]);
    expect(settled.train_purchase_offer).toBeNull();
    expect(settled.market_positions).toEqual(board.market_positions);
  });
});

/* ================================================================== */
/* B. UR-F22 -- THE BUYER'S MARKER MOVES, NEVER THE SELLER'S           */
/* ================================================================== */

describe("B. UR-F22: the Blood Price moves the BUYER Left 1 / Down 1 and the seller not at all", () => {
  it("B1. the gilded copy's sale: C&O (buyer) moves exactly one Left and one Down; B&O (seller) does not move", () => {
    const board = mixed();
    const msg = sale(CO, BO, "6", "300", true);
    const buyerFrom = mark(board, CO)!;
    const landed = projectBloodPriceMove(buyerFrom)!;
    expect(landed).not.toBeNull();
    const after = reduce(board, msg);
    expect(mark(after, CO)).toMatchObject({ price: landed.price, x: landed.x, y: landed.y });
    expect(mark(after, CO)!.enteredAt).toBe(nextArrival(board.market_positions ?? {})); // stamped (S9-11)
    expect(mark(after, BO)).toEqual(mark(board, BO)); // the seller: no movement at all
    expect(mark(after, NYC)).toEqual(mark(board, NYC));
    expect(report(board, msg)).toEqual({ companyId: CO, from: buyerFrom.price, to: landed.price, reason: "bloodPrice" });
  });

  it("B2. an unnamed but unambiguous Blood Price (only the gilded copy held) moves the buyer too", () => {
    const board = onlyGilded();
    const after = reduce(board, sale(CO, BO, "6", "300"));
    expect(mark(after, CO)!.price).toBe(projectBloodPriceMove(mark(board, CO)!)!.price);
    expect(mark(after, BO)).toEqual(mark(board, BO));
  });

  it("B3. never both, and nothing for the ordinary copy", () => {
    const board = mixed();
    const ordinary = reduce(board, sale(CO, BO, "6", "300", false));
    expect(ordinary.market_positions).toEqual(board.market_positions);
    const blood = reduce(board, sale(CO, BO, "6", "300", true));
    const moved = [CO, BO, NYC].filter((id) => JSON.stringify(mark(blood, id)) !== JSON.stringify(mark(board, id)));
    expect(moved).toEqual([CO]);
  });

  it("B4. a Blood Price the core refuses moves no token (not at Purchase Trains; the treasury cannot pay)", () => {
    for (const refused of [mixed(P1, { step: "Tokens" }), mixed(P1, { corps: [
      { id: CO, president: P1, trains: ["5"], treasury: 100 },
      { id: BO, president: P1, trains: ["6", "6"], extra: GILDED("6") },
      { id: NYC, president: P3, trains: ["5", "5"] },
    ] })]) {
      const msg = sale(CO, BO, "6", "300", true);
      expect(stateDigest(reduce(refused, msg))).toBe(stateDigest(refused));
      expect(report(refused, msg)).toBeNull();
    }
  });
});

/* ================================================================== */
/* C. OD-UR-5(a) -- THE CURED TRAIN IS ORDINARY                         */
/* ================================================================== */

describe("C. 5a-1: after the Blood Price the buyer's train is an ordinary train", () => {
  const cured = () => reduce(mixed(), sale(CO, BO, "6", "300", true));

  it("C1. no gilding, no curse, no deadline; it counts against the limit, which now refuses another purchase", () => {
    const after = cured();
    const buyer = c(after, CO);
    expect(buyer.carcosan_trains ?? []).toEqual([]);
    expect(buyer.is_carcosan).toBeFalsy();
    expect(buyer.carcosan_doom_after_macro_round).toBeUndefined();
    expect(TL.countableTrainCount(buyer.owned_trains, buyer.pending_rust_trains, buyer.carcosan_trains)).toBe(2);
    expect(GP.derivePhase(after)!.trainLimit).toBe(2);
    // At its limit: the last printed 6 cannot be bought.
    expect(stateDigest(reduce(after, buyDepot(CO, "6")))).toBe(stateDigest(after));
  });

  it("C2. it runs normally: next Operating Round its route is priced and paid exactly like an ordinary 6-train's", () => {
    /* The whole line J2-I3-I5-I7-I9 in the Brown phase: $120 printed. Measured against the SAME board whose 6 carries no
       provenance -- the cured copy's run must be that run, figure for figure. */
    const QUIET = S.seedWhere((seed) => S.isQuietDraw(120, partsFor(seed, 7, 1, CO)));
    const boardWith = (extra: Partial<PublicCompanyState>) =>
      urBoard({
        corps: [
          { id: CO, president: P1, trains: ["6"], treasury: 700, extra },
          { id: BO, president: P2, trains: ["6"] },
        ],
        step: "Routes",
        macro: 7,
      });
    const cured = boardWith(CURED("6"));
    const after = reduce(cured, runMsg(CO, [LONG_ROUTE], [0], ["6"], QUIET));
    const ordinary = reduce(boardWith({}), runMsg(CO, [LONG_ROUTE], [0], ["6"], QUIET));
    expect(after).not.toBe(cured);
    expect(c(after, CO).last_run_breakdown).toEqual([{ train_index: 0, model: "6", printed_revenue: "120" }]);
    expect(c(after, CO).last_run_breakdown).toEqual(c(ordinary, CO).last_run_breakdown);
    expect(c(after, CO).last_route_revenue).toBe(c(ordinary, CO).last_route_revenue);
    expect(c(after, CO).owned_trains).toEqual(["6"]);
    expect(c(after, CO).last_run_yellow_sign).toBeUndefined();
  });

  it("C3. the fog never comes for it, at any boundary; the Diesel starts no clock at the buyer", () => {
    const after = cured();
    for (const macro of [6, 7, 8, 12]) {
      const boundary = { ...after, macro_round_number: macro } as GameStateResponse;
      expect(YS.fogDueAtSetEnd(boundary)).toBe(false);
      expect(c(YS.fogAtSetEnd(boundary), CO).owned_trains).toEqual(["5", "6"]);
    }
  });

  it("C4. it can be sold normally later: an ordinary sale -- no Blood Price, no market move -- and its provenance follows", () => {
    const board = curedAtCO();
    const before = rows(board);
    const msg = sale(NYC, CO, "6", "200");
    const toNyc = reduce({ ...board, active_corporation_index: board.active_operating_order!.indexOf(NYC) } as GameStateResponse, msg);
    expect(c(toNyc, NYC).owned_trains).toEqual(["5", "6"]);
    expect(c(toNyc, NYC).ghost_trains).toEqual(["6"]);
    expect(c(toNyc, CO).ghost_trains).toEqual([]);
    expect(c(toNyc, NYC).carcosan_trains ?? []).toEqual([]);
    expect(toNyc.market_positions).toEqual(board.market_positions);
    expect(rows(toNyc)).toBe(before);
    provenanceCoherent(toNyc, 1);
  });

  it("C5. it is a legal Diesel trade-in when otherwise eligible (only a GILDED copy is refused, OD-UR-7)", () => {
    const board = curedAtCO();
    expect(DX.exchangeableTrains(c(board, CO))).toEqual(["5", "6"]);
    expect(DX.dieselExchangeRefusal(board, CO, "6")).toBeNull();
  });
});

/* ================================================================== */
/* D. THE +1 -- SUPPLY PROVENANCE THROUGH THE WHOLE LIFECYCLE          */
/* ================================================================== */

describe("D. the additional copy stays additional: the printed Depot neither loses nor regains a train", () => {
  it("D1. the Blood Price leaves the Depot as it was; the last printed 6 is still for sale and makes three 6s in play", () => {
    const board = mixed();
    const sold = reduce(board, sale(CO, BO, "6", "300", true));
    expect(rows(sold)).toBe(rows(board));
    expect(row(sold, "6").remaining).toBe(1);
    provenanceCoherent(sold, 1);
    // NYC (another corporation, at its own Purchase Trains step) buys the last printed 6.
    const nycTurn = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["5", "6"], extra: CURED("6") },
        { id: BO, president: P2, trains: ["6"] },
        { id: NYC, president: P3, trains: ["5"], treasury: 1000 },
      ],
      operating: NYC,
      step: "Hardware",
      macro: 6,
    });
    const bought = reduce(nycTurn, buyDepot(NYC, "6"), P3);
    expect(c(bought, NYC).owned_trains).toEqual(["5", "6"]);
    expect(row(bought, "6").remaining).toBe(0);
    const sixes = bought.public_companies.flatMap((company) => (company.owned_trains ?? []).filter((model) => model === "6"));
    expect(sixes).toHaveLength(3); // the two printed 6s and the one additional copy
  });

  it("D2. a Diesel trade-in of the cured 6 puts it in the Bank Pool AS the additional copy -- no printed 6 is lost", () => {
    const board = curedAtCO();
    expect(row(board, "6").remaining).toBe(1);
    const after = reduce(board, exchange(CO, "6"));
    expect(c(after, CO).owned_trains).toEqual(["5", "D"]);
    expect(after.returned_trains).toEqual(["6"]);
    expect(poolProvenance(after)).toEqual(["6"]);
    expect(c(after, CO).ghost_trains ?? []).toEqual([]); // nothing stale left behind at the trader
    expect(row(after, "6").remaining).toBe(1); // the printed 6 is still the Depot's to sell
    expect(TA.bankPoolTrains(after)).toEqual([{ source: "pool", tier: "6", cost: GP.depotCostFor(after, "6"), remaining: 1 }]);
    expect(GP.derivePhase(after)!.tier).toBe("D"); // the REAL Diesel the trade-in bought
    provenanceCoherent(after, 1);
  });

  it("D3. buying the additional copy from the Bank Pool carries its provenance to the buyer -- never duplicated, never erased", () => {
    const traded = reduce(curedAtCO(), exchange(CO, "6"));
    const nycTurn = { ...traded, active_corporation_index: traded.active_operating_order!.indexOf(NYC), operating_sub_phase: "Hardware" } as GameStateResponse;
    const bought = reduce(nycTurn, buyPool(NYC, "6"));
    expect(c(bought, NYC).owned_trains).toEqual(["5", "6"]);
    expect(c(bought, NYC).ghost_trains).toEqual(["6"]);
    expect(bought.returned_trains).toEqual([]);
    expect(poolProvenance(bought)).toEqual([]);
    expect(row(bought, "6").remaining).toBe(1);
    provenanceCoherent(bought, 1);
    // And the last printed 6 is still bought normally afterwards (B&O, at its own step), which exhausts the tier exactly:
    // two printed 6s and the one additional copy, three in play.
    const boTurn = { ...bought, active_corporation_index: bought.active_operating_order!.indexOf(BO) } as GameStateResponse;
    const last = reduce(boTurn, buyDepot(BO, "6"), P2);
    expect(c(last, BO).owned_trains).toEqual(["6", "6"]);
    expect(row(last, "6").remaining).toBe(0);
    const sixes = last.public_companies.flatMap((company) => (company.owned_trains ?? []).filter((model) => model === "6"));
    expect(sixes).toHaveLength(3);
    provenanceCoherent(last, 1);
  });

  it("D4. the trader buying its own copy back gets its provenance back, and no printed 6 reappears", () => {
    const traded = reduce(curedAtCO({}, ["6"]), exchange(CO, "6"));
    expect(c(traded, CO).owned_trains).toEqual(["D"]);
    expect(c(traded, CO).ghost_trains ?? []).toEqual([]); // no stale marker waiting to absorb the next 6 it buys
    expect(row(traded, "6").remaining).toBe(1);
    const back = reduce(traded, buyPool(CO, "6"));
    expect(c(back, CO).owned_trains).toEqual(["D", "6"]);
    expect(c(back, CO).ghost_trains).toEqual(["6"]);
    expect(row(back, "6").remaining).toBe(1);
    provenanceCoherent(back, 1);
  });

  it("D5. (constructed) a president's discard of the cured copy puts its provenance in the pool with it", () => {
    /* NOT REACHABLE IN LEGAL PLAY, pinned for the reading: a cured train exists only from phase 5 (the gift's window),
       and every limit from phase 5 on is 2 and never falls, so no discard obligation can arise while one is held. The
       board below is over its limit by construction. */
    const board = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["5", "5", "6"], extra: CURED("6") },
        { id: BO, president: P2, trains: ["6"] },
      ],
      step: "Hardware",
      macro: 6,
    });
    const after = reduce(board, discard(CO, "6"));
    expect(c(after, CO).owned_trains).toEqual(["5", "5"]);
    expect(c(after, CO).ghost_trains ?? []).toEqual([]);
    expect(after.returned_trains).toEqual(["6"]);
    expect(poolProvenance(after)).toEqual(["6"]);
    expect(row(after, "6").remaining).toBe(row(board, "6").remaining);
    provenanceCoherent(after, 1);
  });

  it("D6. (constructed) the additional copy in the pool is never the phase, and a pooled synthetic D is never a real D", () => {
    // Phase 5: nobody has bought a 6. A cured 6 (constructed into the pool) does not make it phase 6.
    const phase5 = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["5", "5", "6"], extra: CURED("6") },
        { id: BO, president: P2, trains: ["5"] },
      ],
      step: "Hardware",
      macro: 5,
    });
    expect(GP.derivePhase(phase5)!.tier).toBe("5");
    const pooled = reduce(phase5, discard(CO, "6"));
    expect(pooled.returned_trains).toEqual(["6"]);
    expect(GP.derivePhase(pooled)!.tier).toBe("5");
    expect(GP.openDepotTiers(pooled).map((entry) => entry.tier)).toEqual(["6"]);
    // A synthetic D sitting in the pool is not evidence that a Diesel was bought.
    const dBoard = { ...phase5, returned_trains: ["D"], returned_ghost_trains: ["D"] } as unknown as GameStateResponse;
    expect(GP.realDieselPurchased(dBoard)).toBe(false);
    expect(GP.realDieselPurchased({ ...dBoard, returned_ghost_trains: [] } as unknown as GameStateResponse)).toBe(true);
  });

  it("D7. the gift is always a permanent tier, so ordinary rust never meets a synthetic copy (5, 6, 7 and D never rust)", () => {
    /* The cured train "rusts normally": in 1830 a 5, 6, 7 or D is permanent, and the gift is the Depot's lowest tier in
       phases 5 - D, which is always one of them. Measured over every phase in the window, printed and Level Playing
       Field, against the one rust table the reducer uses (a D arriving rusts 4s only). */
    for (const lpf of [false, true]) {
      for (const [phaseTrains, shelf] of [
        [["5"], "5"],
        [["5", "5", "5"], "6"],
        [["6"], lpf ? "6" : "6"],
        [["6", "6"], lpf ? "7" : "D"],
        [["6", "6", "7", "7"], "D"],
      ] as Array<[string[], string]>) {
        if (!lpf && phaseTrains.includes("7")) continue;
        const board = urBoard({ lpf, corps: [{ id: BO, president: P2, trains: phaseTrains }], macro: 6 });
        const gift = YS.carcosaGiftModel(board, GP.derivePhase(board)!.tier)!;
        expect([lpf, phaseTrains.join(","), gift]).toEqual([lpf, phaseTrains.join(","), shelf]);
        expect(["5", "6", "7", "D"]).toContain(gift);
      }
    }
    // The D's arrival (a real Diesel bought) rusts the 4s and leaves a cured 6 exactly where it is.
    const board = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["6"], treasury: 1500, extra: CURED("6") },
        { id: BO, president: P2, trains: ["6", "4"] },
      ],
      step: "Hardware",
      macro: 6,
    });
    const after = reduce(board, buyDepot(CO, "D"));
    expect(c(after, CO).owned_trains).toEqual(["6", "D"]);
    expect(c(after, CO).ghost_trains).toEqual(["6"]);
    expect(c(after, BO).owned_trains).toEqual(["6"]); // the 4 rusted, as it always does
    expect(c(after, CO).carcosan_doom_after_macro_round).toBeUndefined();
  });
});

/* ================================================================== */
/* E. PHASE / REAL-D NEGATIVE CONTROLS                                 */
/* ================================================================== */

describe("E. an intercorporate purchase is not a Depot purchase: the Blood Price turns nothing", () => {
  /** Phase 5 with the 5s sold out: Carcosa gifted B&O the Depot's lowest tier, a 6 ABOVE the phase. B&O's 3 is live
   *  (3s rust on the first REAL 6). C&O, trainless, is at Purchase Trains. */
  const giftAbove = (gentle = false) =>
    urBoard({
      gentle,
      corps: [
        { id: CO, president: P1, trains: [], treasury: 1500 },
        { id: BO, president: P1, trains: ["3", "5", "6"], extra: GILDED("6") },
        { id: NYC, president: P3, trains: ["5", "5"] },
      ],
      step: "Hardware",
      macro: 5,
    });

  it("E1. a cured 6 above the phase: no phase change, no rust, no marks, no shelf -- until a REAL 6 is bought", () => {
    for (const gentle of [false, true]) {
      const board = giftAbove(gentle);
      expect(GP.derivePhase(board)!.tier).toBe("5");
      const sold = reduce(board, sale(CO, BO, "6", "300", true));
      expect(c(sold, CO).owned_trains).toEqual(["6"]);
      expect(GP.derivePhase(sold)!.tier).toBe("5");
      expect(c(sold, BO).owned_trains).toEqual(["3", "5"]); // the 3 is not rusted
      expect(c(sold, BO).pending_rust_trains ?? []).toEqual([]); // no Gentle Rust mark either
      expect(GP.openDepotTiers(sold).map((entry) => entry.tier)).toEqual(["6"]); // the D shelf is not open
      expect(rows(sold)).toBe(rows(board));
      expect(tileEraFor(sold)).toBe(tileEraFor(board));
      // The first REAL 6 from the Depot is the phase change, as in the printed game.
      const real = reduce(sold, buyDepot(CO, "6"));
      expect(c(real, CO).owned_trains).toEqual(["6", "6"]);
      expect(GP.derivePhase(real)!.tier).toBe("6");
      if (gentle) {
        expect(c(real, BO).owned_trains).toEqual(["3", "5"]);
        expect(c(real, BO).pending_rust_trains).toEqual(["3"]);
      } else {
        expect(c(real, BO).owned_trains).toEqual(["5"]);
      }
      expect(GP.openDepotTiers(real).map((entry) => entry.tier)).toEqual(["6", "D"]);
    }
  });

  /** Phase 6 with both printed 6s owned: the gift was a D. NYC's 4 is live (4s rust on the first REAL D). CPR holds
   *  another gilded train whose doom clock waits for the first REAL D. */
  const giftD = (options: { lpf?: boolean; plusTiles?: boolean; gentle?: boolean } = {}) =>
    urBoard({
      ...options,
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1500 },
        { id: BO, president: P1, trains: ["6", "D"], extra: GILDED("D") },
        { id: NYC, president: P3, trains: ["6", "4"] },
        { id: CPR, president: P3, trains: ["5"], extra: GILDED("5") },
      ],
      step: "Hardware",
      macro: 6,
    });

  it("E2. a cured D: no phase D, no rust of 4s, no real-D doom trigger, no Gray era -- then a REAL D does all of it", () => {
    for (const options of [{}, { gentle: true }, { plusTiles: true }, { lpf: true }]) {
      const board = giftD(options);
      expect(GP.derivePhase(board)!.tier).toBe("6");
      const sold = reduce(board, sale(CO, BO, "D", "300", true));
      expect(c(sold, CO).owned_trains).toEqual(["5", "D"]);
      expect(c(sold, CO).ghost_trains).toEqual(["D"]);
      expect(GP.derivePhase(sold)!.tier).toBe("6");
      expect(GP.realDieselPurchased(sold)).toBe(false);
      expect(c(sold, NYC).owned_trains).toEqual(["6", "4"]);
      expect(c(sold, NYC).pending_rust_trains ?? []).toEqual([]);
      expect(c(sold, CPR).carcosan_doom_after_macro_round).toBeUndefined(); // the real-D trigger has not happened
      expect(tileEraFor(sold)).toBe(tileEraFor(board));
      expect(rows(sold)).toBe(rows(board));
      // A REAL Diesel (C&O trades its 5 in): phase D, the 4 rusts (or is marked), CPR's clock starts.
      const real = reduce(sold, exchange(CO, "5"));
      expect(c(real, CO).owned_trains).toEqual(["D", "D"]);
      expect(GP.derivePhase(real)!.tier).toBe("D");
      expect(GP.realDieselPurchased(real)).toBe(true);
      if ((options as { gentle?: boolean }).gentle) expect(c(real, NYC).pending_rust_trains).toEqual(["4"]);
      else expect(c(real, NYC).owned_trains).toEqual(["6"]);
      expect(c(real, CPR).carcosan_doom_after_macro_round).toBe(7);
      if ((options as { plusTiles?: boolean }).plusTiles) expect(tileEraFor(real)).toBe("Gray");
    }
  });

  it("E3. Level Playing Field: a cured 7 is not the phase either", () => {
    const board = urBoard({
      lpf: true,
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1500 },
        { id: BO, president: P1, trains: ["6", "7"], extra: GILDED("7") },
        { id: NYC, president: P3, trains: ["6", "4"] },
      ],
      step: "Hardware",
      macro: 6,
    });
    expect(GP.derivePhase(board)!.tier).toBe("6");
    const sold = reduce(board, sale(CO, BO, "7", "300", true));
    expect(c(sold, CO).owned_trains).toEqual(["5", "7"]);
    expect(GP.derivePhase(sold)!.tier).toBe("6");
    expect(rows(sold)).toBe(rows(board));
  });
});

/* ================================================================== */
/* F. FOG / CURSE CLEANUP                                              */
/* ================================================================== */

describe("F. the fog follows the gilding, and only the gilding", () => {
  /** Phase D (NYC's real D), the doom clock running: B&O's gilded 6 is due at the END of set 7. B&O also holds a REAL 6. */
  const doomed = () =>
    urBoard({
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1500 },
        { id: BO, president: P1, trains: ["6", "6"], extra: GILDED("6", { carcosan_doom_after_macro_round: 7 }) },
        { id: NYC, president: P3, trains: ["D"] },
      ],
      step: "Hardware",
      macro: 7,
    });
  const endOfSet = (state: GameStateResponse, macro: number) => YS.fogAtSetEnd({ ...state, macro_round_number: macro } as GameStateResponse);

  it("F1. the gilded copy sold: the seller is absolved; no fog is ever due; the buyer's cured train survives the old deadline", () => {
    const sold = reduce(doomed(), sale(CO, BO, "6", "300", true));
    expect(c(sold, BO).is_carcosan).toBe(false);
    expect(c(sold, BO).carcosan_trains).toEqual([]);
    expect(c(sold, BO).carcosan_doom_after_macro_round).toBeUndefined();
    for (const macro of [7, 8, 9]) {
      const after = endOfSet(sold, macro);
      expect(c(after, CO).owned_trains).toEqual(["5", "6"]);
      expect(c(after, BO).owned_trains).toEqual(["6"]); // the seller's REAL 6 is not the gilded one
      expect(YS.fogDueAtSetEnd({ ...sold, macro_round_number: macro } as GameStateResponse)).toBe(false);
    }
    expect(c(sold, CO).is_carcosan).toBeFalsy();
  });

  it("F2. the ORDINARY copy sold: the curse, the gilded copy and the deadline all stay, and the fog takes only that copy", () => {
    const sold = reduce(doomed(), sale(CO, BO, "6", "300", false));
    expect(c(sold, BO).is_carcosan).toBe(true);
    expect(c(sold, BO).carcosan_trains).toEqual(["6"]);
    expect(c(sold, BO).carcosan_doom_after_macro_round).toBe(7);
    expect(c(sold, CO).owned_trains).toEqual(["5", "6"]);
    const fogged = endOfSet(sold, 7);
    expect(c(fogged, BO).owned_trains).toEqual([]);
    expect(c(fogged, BO).ghost_trains).toEqual([]);
    expect(c(fogged, BO).is_carcosan).toBe(true); // the curse outlives the train (#1089)
    expect(c(fogged, CO).owned_trains).toEqual(["5", "6"]); // the ordinary copy C&O bought is untouched
  });
});

/* ================================================================== */
/* H. STANDARD-MODE AND ORDINARY-SALE CONTROLS                         */
/* ================================================================== */

describe("H. the standard game and every ordinary sale are unchanged", () => {
  const standard = (over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
    urBoard({
      ur: false,
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1000 },
        { id: BO, president: P1, trains: ["6", "6"] },
        { id: NYC, president: P3, trains: ["5", "5"] },
      ],
      step: "Hardware",
      macro: 6,
      ...over,
    });

  it("H1. variant off: an unnamed sale settles as it always did -- no Blood Price, no market move, no marker written", () => {
    const board = standard();
    const after = reduce(board, sale(CO, BO, "6", "300"));
    expect(c(after, CO).owned_trains).toEqual(["5", "6"]);
    expect(c(after, BO).owned_trains).toEqual(["6"]);
    expect([treasury(after, CO), treasury(after, BO)]).toEqual([700, 1300]);
    expect(after.market_positions).toEqual(board.market_positions);
    for (const id of [CO, BO]) {
      expect("ghost_trains" in c(after, id)).toBe(false);
      expect("carcosan_trains" in c(after, id)).toBe(false);
    }
    expect("returned_ghost_trains" in after).toBe(false);
    expect(report(board, sale(CO, BO, "6", "300"))).toBeNull();
  });

  it("H2. variant off: naming the gilded copy is refused (there is none); naming the ordinary copy is the ordinary sale", () => {
    const board = standard();
    expect(stateDigest(reduce(board, sale(CO, BO, "6", "300", true)))).toBe(stateDigest(board));
    const named = reduce(board, sale(CO, BO, "6", "300", false));
    const unnamed = reduce(board, sale(CO, BO, "6", "300"));
    expect(stateDigest(named)).toBe(stateDigest(unnamed));
  });

  it("H3. under Unpredictable Revenue, two ordinary copies of one model sell unnamed exactly as in the standard game", () => {
    const ur = reduce(standard({ ur: true }), sale(CO, BO, "6", "300"));
    const std = reduce(standard(), sale(CO, BO, "6", "300"));
    expect(ur.public_companies).toEqual(std.public_companies);
    expect(ur.market_positions).toEqual(std.market_positions);
  });

  it("H4. variant off: the Diesel trade-in, the discard and a Bank Pool purchase write no provenance field (#232)", () => {
    const board = urBoard({
      ur: false,
      corps: [
        { id: CO, president: P1, trains: ["5", "6"], treasury: 1500 },
        { id: BO, president: P2, trains: ["6"] },
        { id: NYC, president: P1, trains: ["5"], treasury: 1500 },
      ],
      step: "Hardware",
      macro: 6,
    });
    const traded = reduce(board, exchange(CO, "6"));
    expect(traded.returned_trains).toEqual(["6"]);
    expect("returned_ghost_trains" in traded).toBe(false);
    expect(row(traded, "6").remaining).toBe(0); // a printed 6 in the pool is printed stock, as it always was (#1512)
    const bought = reduce({ ...traded, active_corporation_index: traded.active_operating_order!.indexOf(NYC) } as GameStateResponse, buyPool(NYC, "6"));
    expect(c(bought, NYC).owned_trains).toEqual(["5", "6"]);
    expect("ghost_trains" in c(bought, NYC)).toBe(false);
    expect("returned_ghost_trains" in bought).toBe(false);
  });
});

/* ================================================================== */
/* I. THE HOSTED PATH -- RoomSession, replay, restore, undo, ingress   */
/* ================================================================== */

describe("I. the hosted room: copy selection reaches the authority, and the log replays to the same board", () => {
  const restoredFrom = (room: InstanceType<typeof RoomSession>, seed: GameStateResponse) => {
    const restored = new RoomSession({
      providers: S.roomProviders(seed, GULF),
      seed: { state: seed, waterfall: null },
      build: "ur3",
      mintId: () => "x",
      mintSeed: () => {
        throw new Error("a restore must never draw");
      },
    });
    restored.restore(room.entries as never);
    return restored;
  };
  const replayed = (room: InstanceType<typeof RoomSession>, seed: GameStateResponse) =>
    replayLog(
      room.entries.map((entry) => ({ index: entry.index, id: entry.id, actor: entry.actor, payload: entry.payload })),
      S.roomProviders(seed, GULF),
      { state: seed, waterfall: null },
      undefined,
      SERVER_REPLAY_POLICY,
    );

  it("I1. the offer for the ORDINARY copy: proposed, accepted, settled by the derived entry -- an ordinary sale", () => {
    const seed = mixed(P2);
    const room = S.hostedRoom(seed, GULF, [1]);
    expect(S.submitTo(room, P1, propose(BO, CO, "6", "300", false) as never).kind).toBe("applied");
    const accepted = S.submitTo(room, P2, answer(BO, true) as never);
    expect(accepted.kind).toBe("applied");
    const settlement = room.entries.find((entry) => entry.derived === true && entry.payload.includes("BuyTrainFromCorporation"));
    expect(settlement).toBeDefined();
    expect(JSON.parse(settlement!.payload)).toMatchObject({ BuyTrainFromCorporation: { model_type: "6", gilded: false } });
    expect(c(room.state, BO).carcosan_trains).toEqual(["6"]);
    expect(c(room.state, BO).is_carcosan).toBe(true);
    expect(c(room.state, CO).owned_trains).toEqual(["5", "6"]);
    expect(room.state.market_positions).toEqual(seed.market_positions);
    expect(stateDigest(replayed(room, seed).state)).toBe(stateDigest(room.state));
    expect(stateDigest(restoredFrom(room, seed).state)).toBe(stateDigest(room.state));
  });

  it("I2. the offer for the GILDED copy: the Blood Price, the buyer's token moves and the seller's does not", () => {
    const seed = mixed(P2);
    const room = S.hostedRoom(seed, GULF, [1]);
    expect(S.submitTo(room, P1, propose(BO, CO, "6", "300", true) as never).kind).toBe("applied");
    expect(S.submitTo(room, P2, answer(BO, true) as never).kind).toBe("applied");
    expect(c(room.state, BO).carcosan_trains).toEqual([]);
    expect(c(room.state, BO).is_carcosan).toBe(false);
    expect(c(room.state, CO).ghost_trains).toEqual(["6"]);
    expect(mark(room.state, CO)!.price).toBe(projectBloodPriceMove(mark(seed, CO)!)!.price);
    expect(mark(room.state, BO)).toEqual(mark(seed, BO));
    expect(stateDigest(replayed(room, seed).state)).toBe(stateDigest(room.state));
    expect(stateDigest(restoredFrom(room, seed).state)).toBe(stateDigest(room.state));
  });

  it("I3. an ambiguous (unnamed) proposal is refused at ingress with the authority's sentence; nothing is appended", () => {
    const seed = mixed(P2);
    const room = S.hostedRoom(seed, GULF, [1]);
    const before = stateDigest(room.state);
    const refused = S.submitTo(room, P1, propose(BO, CO, "6", "300") as never);
    expect(refused.kind).toBe("refused");
    expect(refused.reason).toMatch(/B&O holds both a gold-trimmed and an ordinary 6-train/);
    expect(room.entries).toHaveLength(0);
    expect(stateDigest(room.state)).toBe(before);
    // The same for a direct same-president sale.
    const direct = S.hostedRoom(mixed(P1), GULF, [1]);
    const directRefused = S.submitTo(direct, P1, sale(CO, BO, "6", "300") as never);
    expect(directRefused.kind).toBe("refused");
    expect(direct.entries).toHaveLength(0);
  });

  it("I4. the direct same-president Blood Price, then an undo: gilding, curse, provenance and both tokens come back", () => {
    const seed = mixed(P1);
    const room = S.hostedRoom(seed, GULF, [1]);
    const seated = stateDigest(room.state);
    expect(S.submitTo(room, P1, sale(CO, BO, "6", "300", true) as never).kind).toBe("applied");
    expect(mark(room.state, CO)!.price).toBe(projectBloodPriceMove(mark(seed, CO)!)!.price);
    expect(mark(room.state, BO)).toEqual(mark(seed, BO));
    expect(S.submitTo(room, P1, { RevertTo: { index: 0, player: P1, summary: "undo" } } as never).kind).toBe("applied");
    expect(stateDigest(room.state)).toBe(seated);
    expect(c(room.state, BO).carcosan_trains).toEqual(["6"]);
    // And the ordinary copy's sale instead, from the same board.
    expect(S.submitTo(room, P1, sale(CO, BO, "6", "300", false) as never).kind).toBe("applied");
    expect(c(room.state, BO).carcosan_trains).toEqual(["6"]);
    expect(room.state.market_positions).toEqual(seed.market_positions);
  });

  it("I5. ingress validates the new field's shape on both messages; absent, true and false are all well-formed", () => {
    for (const make of [(g: unknown) => sale(CO, BO, "6", "300", g as boolean), (g: unknown) => propose(BO, CO, "6", "300", g as boolean)]) {
      expect(validateGameplayMessage(make(undefined)).ok).toBe(true);
      expect(validateGameplayMessage(make(true)).ok).toBe(true);
      expect(validateGameplayMessage(make(false)).ok).toBe(true);
      const bad = validateGameplayMessage(make("yes"));
      expect(bad.ok).toBe(false);
      expect((bad as { reason: string }).reason).toMatch(/gilded/);
    }
  });

  it("I6. the trade-in of a cured 6, hosted: the pool keeps the provenance, and a replay and a restore agree", () => {
    const seed = curedAtCO();
    const room = S.hostedRoom(seed, GULF, [1]);
    expect(S.submitTo(room, P1, exchange(CO, "6") as never).kind).toBe("applied");
    expect(poolProvenance(room.state)).toEqual(["6"]);
    expect(c(room.state, CO).ghost_trains ?? []).toEqual([]);
    expect(row(room.state, "6").remaining).toBe(1);
    expect(stateDigest(replayed(room, seed).state)).toBe(stateDigest(room.state));
    expect(stateDigest(restoredFrom(room, seed).state)).toBe(stateDigest(room.state));
  });
});

/* ================================================================== */
/* J. VERSION / REPLAY POLICY                                          */
/* ================================================================== */

describe("J. the replay boundary: carried by v10 (UR-8), every table plays the ruled Blood Price, old messages read as they did", () => {
  const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");

  it("J1. RULES_ENGINE_VERSION is at least 10 -- UR-F21 / UR-F22 are carried by the deliberate 9 -> 10 boundary (UR-8)", () => {
    /* UR-8: was `toBe(9)` ("owed to the 9 -> 10 boundary") -- the right claim while UR-4 stayed on 9. The boundary is taken
       (changelog row 10 (6)); the current number belongs to `unpredictableRevenueClosure.test.ts`. Version-literal only. */
    expect(RULES_ENGINE_VERSION).toBeGreaterThanOrEqual(10);
  });

  it("J2. an UNPINNED board (the Firestore / development-corpus population) plays the same rule -- no legacy branch", () => {
    /* UR-3's precedent for a rule the corpus never exercises (the fog, the phase, the trade-in): one rule on pinned and
       unpinned tables alike. Measured: no corpus file holds a gilded train or transfers one (UR-4 record), so no stored
       entry is reinterpreted, and no crafted unpinned client can reach #1090's model-level sale or seller move. */
    const unpinned = mixed(P1, { pinned: false });
    expect(unpinned.rules_engine_version).toBeUndefined();
    expect(stateDigest(reduce(unpinned, sale(CO, BO, "6", "300")))).toBe(stateDigest(unpinned)); // ambiguous: refused
    const ordinary = reduce(unpinned, sale(CO, BO, "6", "300", false));
    expect(c(ordinary, BO).carcosan_trains).toEqual(["6"]);
    expect(ordinary.market_positions).toEqual(unpinned.market_positions);
    const blood = reduce(unpinned, sale(CO, BO, "6", "300", true));
    expect(mark(blood, CO)!.price).toBe(projectBloodPriceMove(mark(unpinned, CO)!)!.price);
    expect(mark(blood, BO)).toEqual(mark(unpinned, BO));
  });

  it("J3. an offer that names no copy derives the settlement every offer before UR-4 derived, key for key", () => {
    let board = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1000 },
        { id: BO, president: P2, trains: ["6"] },
        { id: NYC, president: P3, trains: ["5", "5"] },
      ],
      step: "Hardware",
      macro: 6,
    });
    board = reduce(board, propose(BO, CO, "6", "300"), P1);
    expect("gilded" in board.train_purchase_offer!).toBe(false);
    board = reduce(board, answer(BO, true), P2);
    const owed = nextDerivedAction({ state: board, mapGrid: GULF, emitted: new Set() })!;
    expect(owed.msg).toEqual({ BuyTrainFromCorporation: { game_id: 0, buyer_protocol_id: CO, seller_protocol_id: BO, model_type: "6", price: "300" } });
  });
});
