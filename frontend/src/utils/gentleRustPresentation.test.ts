/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1702 (harness): GR-3 -- THE APPLICATION TELLS THE SAME RULE THE ENGINE PLAYS (the engine half)
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` rev 2 (U-1 ... U-11, GR-S15 ... GR-S19, GR-S27) and the
// GR-1 / GR-2 / DT-1 authorities (`gentleRustGrace.ts`, `trainSaleAuthority.ts`, `dieselExchange.ts`,
// `derivedActions.ts`). GR-3 is presentation only: every case here derives what a player is told from a board the
// real reducer produced, and then -- where the copy makes a promise -- drives the reducer on to show the promise is
// kept. The rendered half (chips, panel, prompt, Rules Reference) is `components/gentleRustPresentation.test.tsx`;
// the statistics half of U-6 is `gentleRustExchangeStats.test.ts`.
//
// Every Gentle Rust mark below is written by a real phase-changing purchase, EXCEPT the cases labelled
// REPRESENTATION-ONLY: two identical copies of one model with only one of them marked cannot arise in play (a
// phase change marks every copy at once, and the pool's are scrapped), but the multiset authority answers it and
// the brief requires the surfaces to, so those boards set the mark by hand and say so.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const S = require("./gentleRustPresentationSupport") as typeof import("./gentleRustPresentationSupport");
const { PRR, NYC, BO, CO, board, company, fleetOf, marksOf, treasuryOf, acting, send, refused, BUY, EXCHANGE, SALE, DISCARD, PASS, advanceTo, playUntil } = S;
const { describeFleetLosses, describeFleetLoss } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase, depotInventory } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { purchaseWarnings } = require("./purchaseWarnings") as typeof import("./purchaseWarnings");
const { finalRunScheduleFor, finalRunChipTooltip, finalRunBadgeDetail, FINAL_RUN_LIMIT_AND_OWNERSHIP } =
  require("./finalRunTiming") as typeof import("./finalRunTiming");
const { trainSaleRefusal, reprievedSaleReason } =
  require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const {
  dieselExchangeRefusal,
  dieselExchangeCostFor,
  dieselExchangeOfferFor,
  dieselExchangeMayFollowPurchase,
  reprievedExchangeReason,
  reprievedExchangeCopies,
  DIESEL_EXCHANGE_COST,
  LPF_DIESEL_EXCHANGE_COST,
} = require("../gameEngine/dieselExchange") as typeof import("../gameEngine/dieselExchange");
const { buyTrainsAutoSkipReason, TRAIN_LIMIT_SKIP_REASON } =
  require("../gameEngine/derivedActions") as typeof import("../gameEngine/derivedActions");
const { finalRunPositions } = require("../gameEngine/gentleRustGrace") as typeof import("../gameEngine/gentleRustGrace");
const { pendingTrainDiscards } = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");

const { stateDigest: stateDigestOf } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { headTier, discardBoard } = S;

/* ------------------------------------------------------------------ */
/* Boards                                                             */
/* ------------------------------------------------------------------ */

/** Phase 3, every 2 and every 3 bought, so the next depot purchase is the first 4 and dooms every 2. NYC operates
 *  first and is at Buy Trains; PRR and B&O operate after it in the same round. */
const firstFourByNyc = (gentle = true) =>
  board({
    corps: [
      { id: NYC, trains: ["2", "2", "3"] },
      { id: PRR, trains: ["2", "2", "3", "3"] },
      { id: BO, trains: ["2", "2", "3", "3"] },
    ],
    operating: NYC,
    gentle,
  });

/** The DT-1 finding's board (#1701 finding 1): phase 6 with one 6 left, the 6 / D shelf open so the Diesel is for
 *  sale; PRR operates at Buy Trains holding a 4. The limit is two. */
const lastSixBoard = (prrTreasury = "3000", gentle = false) =>
  board({
    corps: [{ id: PRR, trains: ["4"], treasury: prrTreasury }, { id: NYC, trains: ["6"] }, { id: BO, trains: ["5", "5"] }],
    operating: PRR,
    gentle,
    returned: ["5"],
  });

/** Phase 6 with both 6-trains out (DT-1's `dieselStart`): the Diesel is for sale and the first D -- bought or
 *  exchanged for -- rusts every 4. PRR operates at Buy Trains. */
const dieselStart = (prr: string[], opts: { gentle?: boolean; lpf?: boolean; bo?: string[]; returned?: string[] } = {}) =>
  opts.lpf
    ? board({ corps: [{ id: PRR, trains: prr }, { id: NYC, trains: ["6"] }], operating: PRR, lpf: true, gentle: opts.gentle })
    : board({
        corps: [{ id: PRR, trains: prr }, { id: NYC, trains: ["6", "6"] }, { id: BO, trains: opts.bo ?? ["4"] }],
        operating: PRR,
        gentle: opts.gentle,
        returned: opts.returned,
      });

/* ================================================================================================= */
/* UI1 ... UI3 -- WHEN A FINAL RUN TRAIN GOES, READ FROM THE BOARD                                   */
/* ================================================================================================= */

describe("UI1-UI3. Final Run timing is read from the board, not inferred", () => {
  it("UI2. the corporation that rusted its own trains in Buy Trains is told NEXT Operating Turn -- and the train survives", () => {
    const before = firstFourByNyc();
    expect(headTier(before)).toBe("4");
    const bought = send(before, BUY(NYC));
    expect(marksOf(bought, NYC)).toEqual(["2", "2"]);

    const schedule = finalRunScheduleFor(bought, NYC);
    expect(schedule).toEqual({ thisTurn: [], nextTurn: ["2", "2"], doomedThisTurn: true });
    const detail = finalRunBadgeDetail(schedule)!;
    expect(detail).toContain("rusted during this turn's Buy Trains");
    expect(detail).toContain("survive into this corporation's next Operating Turn");
    expect(detail).toContain("removed after that turn's Run Routes");
    expect(detail).not.toContain("removed after this turn's Run Routes");
    expect(detail).not.toContain("end of this turn's Run Routes");
    expect(finalRunChipTooltip("next-turn")).toContain("next Operating Turn");

    // The promise, kept: the turn ends and the 2s are still owned; NYC's next turn begins with them, and they go
    // only as its cursor enters Dividends.
    const ended = send(bought, PASS);
    expect(fleetOf(ended, NYC)).toEqual(["2", "2", "3", "4"]);
    const nycAgain = playUntil(ended, (now) => acting(now) === NYC);
    const back = nycAgain[nycAgain.length - 1].after;
    expect(marksOf(back, NYC)).toEqual(["2", "2"]);
    expect(finalRunScheduleFor(back, NYC)).toEqual({ thisTurn: ["2", "2"], nextTurn: [], doomedThisTurn: false });
    const atRoutes = advanceTo(back, "Routes");
    expect(fleetOf(atRoutes, NYC)).toEqual(["2", "2", "3", "4"]);
    const atDividends = advanceTo(atRoutes, "Dividends");
    expect(fleetOf(atDividends, NYC)).toEqual(["3", "4"]);
  });

  it("UI3. a corporation that is not operating is told its NEXT Operating Turn", () => {
    const bought = send(firstFourByNyc(), BUY(NYC));
    for (const id of [PRR, BO]) {
      expect(marksOf(bought, id)).toEqual(["2", "2"]);
      expect(finalRunScheduleFor(bought, id)).toEqual({ thisTurn: [], nextTurn: ["2", "2"], doomedThisTurn: false });
    }
    const detail = finalRunBadgeDetail(finalRunScheduleFor(bought, PRR))!;
    expect(detail).toContain("next Operating Turn");
    expect(detail).not.toContain("this turn's Buy Trains");
  });

  it("UI1. in its CURRENT grace turn the corporation is told THIS turn -- and the train goes after this turn's Run Routes", () => {
    const ended = send(send(firstFourByNyc(), BUY(NYC)), PASS);
    expect(acting(ended)).toBe(PRR);
    const schedule = finalRunScheduleFor(ended, PRR);
    expect(schedule).toEqual({ thisTurn: ["2", "2"], nextTurn: [], doomedThisTurn: false });
    const detail = finalRunBadgeDetail(schedule)!;
    expect(detail).toContain("removed after this turn's Run Routes");
    expect(detail).not.toContain("next Operating Turn");
    const tooltip = finalRunChipTooltip("this-turn");
    expect(tooltip).toContain("removed after this turn's Run Routes");
    expect(tooltip).not.toMatch(/depot purchase/i);
    // The limit and the ownership are both said, never "doesn't count" alone (SR-1).
    expect(tooltip).toContain(FINAL_RUN_LIMIT_AND_OWNERSHIP);
    expect(detail).toContain("do not count against the train limit, but they are still the corporation's trains");

    // The promise, kept.
    const atRoutes = advanceTo(ended, "Routes");
    expect(fleetOf(atRoutes, PRR)).toEqual(["2", "2", "3", "3"]);
    expect(fleetOf(advanceTo(atRoutes, "Dividends"), PRR)).toEqual(["3", "3"]);
    // NYC, not operating now, is still told its next Operating Turn.
    expect(finalRunScheduleFor(ended, NYC).nextTurn).toEqual(["2", "2"]);
  });

  it("answers nothing for a standard game and for a corporation with no Final Run train", () => {
    const standard = send(firstFourByNyc(false), BUY(NYC));
    for (const id of [NYC, PRR, BO]) {
      expect(finalRunScheduleFor(standard, id)).toEqual({ thisTurn: [], nextTurn: [], doomedThisTurn: false });
      expect(finalRunBadgeDetail(finalRunScheduleFor(standard, id))).toBeNull();
    }
    expect(finalRunScheduleFor(null, PRR).thisTurn).toEqual([]);
  });
});

/* ================================================================================================= */
/* UI4 -- THE PURCHASE WARNING'S "NEXT RUN ROUTES", RE-AUDITED AGAINST REAL PURCHASES                */
/* ================================================================================================= */

describe("UI4. 'destroyed at the end of their corporation's next Run Routes step' is true after GR-1", () => {
  // Order PRR, NYC, B&O, C&O, in the LAST round of the set. NYC -- second -- buys the first 4: PRR has operated
  // (case B, across a Stock Round), NYC is the buyer (case C, also across the Stock Round), B&O and C&O have not
  // operated (case A, later this round). The sentence is kept only if every one of them loses its 2s exactly at
  // its own next Run Routes' end.
  const before = () =>
    board({
      corps: [
        { id: PRR, trains: ["2", "3"] },
        { id: NYC, trains: ["2", "2", "3"] },
        { id: BO, trains: ["2", "3", "3"] },
        { id: CO, trains: ["2", "2", "3"] },
      ],
      operating: NYC,
      sub: 2,
      length: 2,
      gentle: true,
    });

  it("is the wording the warning shows one purchase before the first 4", () => {
    const state = before();
    expect(headTier(state)).toBe("4");
    const rust = purchaseWarnings(derivePhase(state), depotInventory(state), true).find((w) => w.key === "rust")!;
    expect(rust.detail).toContain("destroyed at the end of their corporation's next Run Routes step");
    // A turn, not a guaranteed run (GR-S17): the warning promises availability for one final Operating Turn.
    expect(rust.detail).toContain("remain available for one final Operating Turn");
    expect(rust.detail).not.toMatch(/run once more|one more run|runs? one last time/i);
    // The subject is narrowed: a train in the Bank Pool gets no Final Run (GR-S6).
    expect(rust.detail).toContain("every 2-Train a corporation owns");
    expect(rust.detail).toContain("any in the Bank Pool are removed at once");
    expect(rust.detail).not.toContain("in play");
  });

  it("two purchases out, the Gentle Rust warning promises no run either, and keeps the same timing", () => {
    // One 3-train left in the depot: the first 4 is two purchases away.
    const state = board({
      corps: [
        { id: PRR, trains: ["2", "2", "3"] },
        { id: NYC, trains: ["2", "2", "3"] },
        { id: BO, trains: ["2", "2", "3", "3"] },
      ],
      operating: NYC,
      gentle: true,
    });
    expect(headTier(state)).toBe("3");
    const rust = purchaseWarnings(derivePhase(state), depotInventory(state), true).find((w) => w.key === "rust")!;
    expect(rust.label).toBe("Rusts Soon: 2-trains");
    expect(rust.detail).toContain("not destroyed until the end of their corporation's next Run Routes step");
    expect(rust.detail).not.toMatch(/run once more|one more run|runs? one last time/i);
  });

  it("holds for every corporation the purchase touches: each loses its 2s as its own next Run Routes ends", () => {
    const bought = send(before(), BUY(NYC));
    for (const id of [PRR, NYC, BO, CO]) expect(marksOf(bought, id).length).toBeGreaterThan(0);
    const steps = playUntil(bought, (now) => [PRR, NYC, BO, CO].every((id) => marksOf(now, id).length === 0));
    for (const id of [PRR, NYC, BO, CO]) {
      const cleared = steps.findIndex((step) => marksOf(step.before, id).length > 0 && marksOf(step.after, id).length === 0);
      expect([id, cleared >= 0]).toEqual([id, true]);
      const step = steps[cleared];
      // At the end of ITS Run Routes: the cursor entering Dividends, with this corporation acting ...
      expect([id, acting(step.before), step.before.operating_sub_phase, step.after.operating_sub_phase]).toEqual([id, id, "Routes", "Dividends"]);
      // ... and the FIRST such moment since the purchase -- its next Run Routes, not a later one.
      const earlier = steps.slice(0, cleared).filter((s) => acting(s.before) === id && s.after.operating_sub_phase === "Dividends");
      expect([id, earlier.length]).toEqual([id, 0]);
      // The owned train was still there until then (removed, not traded away or lost to the limit).
      expect(fleetOf(step.before, id)).toContain("2");
      expect(fleetOf(step.after, id)).not.toContain("2");
      // PRR (already operated) and NYC (the buyer) reach it across the Stock Round; B&O and C&O later this round.
      const crossedStockRound = steps.slice(0, cleared).some((s) => s.after.current_round_type === "StockRound");
      expect([id, crossedStockRound]).toEqual([id, id === PRR || id === NYC]);
    }
  });

  it("names the Bank Pool because a pool train really gets no Final Run", () => {
    // Phase 5, the depot's head the first 6; a 3 sits in the Bank Pool. NYC buys the first 6.
    const state = board({
      corps: [{ id: NYC, trains: ["5"] }, { id: BO, trains: ["5"] }, { id: PRR, trains: ["3", "4"] }],
      operating: NYC,
      returned: ["5", "3", "4"],
      gentle: true,
    });
    expect(derivePhase(state)?.tier).toBe("5");
    expect(headTier(state)).toBe("6");
    const after = send(state, BUY(NYC));
    expect(after.returned_trains).not.toContain("3"); // the pool's 3: removed at once
    expect(marksOf(after, PRR)).toEqual(["3"]); // PRR's 3: a Final Run
  });
});

/* ================================================================================================= */
/* UI5 / U-7 -- THE STANDARD WORDING IS UNCHANGED; THE LIMIT COPY NAMES THE PRESIDENT'S CHOICE        */
/* ================================================================================================= */

describe("UI5 / U-7. purchase-warning copy", () => {
  it("UI5. the standard rust warning is byte-for-byte what it was", () => {
    const state = firstFourByNyc(false);
    const rust = purchaseWarnings(derivePhase(state), depotInventory(state), false).find((w) => w.key === "rust")!;
    expect(rust.label).toBe("Rusts in 1 Buy: 2-train");
    expect(rust.detail).toBe("The next train purchase destroys every 2-Train in play, in every corporation.");
  });

  it("U-7. the limit drop names the president's choice, and under Gentle Rust excludes Final Run trains", () => {
    const state = firstFourByNyc(true);
    const standard = purchaseWarnings(derivePhase(state), depotInventory(state), false).find((w) => w.key === "train-limit")!;
    const gentle = purchaseWarnings(derivePhase(state), depotInventory(state), true).find((w) => w.key === "train-limit")!;
    for (const warning of [standard, gentle]) {
      expect(warning.detail).toContain("from 4 to 3");
      expect(warning.detail).toContain("its president chooses which trains go to the Bank Pool");
      expect(warning.detail).not.toContain("is discarded when the phase turns");
    }
    expect(standard.detail).not.toContain("Final Run");
    expect(gentle.detail).toContain("Only trains that count toward the limit are considered; Final Run trains are excluded.");
  });
});

/* ================================================================================================= */
/* U-6 -- A DIESEL TRADE-IN IS NARRATED AS THE EXCHANGE, NOT AS A RUST OR A LIMIT DISCARD           */
/* ================================================================================================= */

describe("UI14-UI17. the fleet-loss narrator", () => {
  it("UI14. standard first-D exchange: the traded 4 is not 'rusted'; the 4s the Diesel really rusts still are", () => {
    const before = dieselStart(["4", "4"]);
    const msg = EXCHANGE(PRR, "4");
    const after = send(before, msg);
    expect(derivePhase(after)?.tier).toBe("D");
    expect(fleetOf(after, PRR)).toEqual(["D"]); // one 4 traded, the other rusted
    const losses = describeFleetLosses(before, after, msg);
    expect(losses.find((loss) => loss.companyId === PRR)).toEqual({ companyId: PRR, ticker: "PRR", rusted: ["4"], discarded: [] });
    expect(losses.find((loss) => loss.companyId === BO)).toEqual({ companyId: BO, ticker: "B&O", rusted: ["4"], discarded: [] });
    // Without the message the diff reads both 4s as rust -- the defect (P9n's standard half).
    expect(describeFleetLosses(before, after).find((loss) => loss.companyId === PRR)?.rusted).toEqual(["4", "4"]);

    // A corporation whose only 4 is the one it trades in is told nothing by this narrator at all.
    const lone = dieselStart(["4", "5"], { returned: ["5"] });
    const traded = send(lone, EXCHANGE(PRR, "4"));
    expect(describeFleetLosses(lone, traded, EXCHANGE(PRR, "4")).find((loss) => loss.companyId === PRR)).toBeUndefined();
  });

  it("UI15. Gentle Rust first-D exchange: the traded 4 is not a limit discard; the other 4s enter their Final Run", () => {
    const before = dieselStart(["4", "4"], { gentle: true });
    const msg = EXCHANGE(PRR, "4");
    const after = send(before, msg);
    expect(fleetOf(after, PRR)).toEqual(["4", "D"]);
    expect(marksOf(after, PRR)).toEqual(["4"]);
    const losses = describeFleetLosses(before, after, msg);
    const prr = losses.find((loss) => loss.companyId === PRR)!;
    expect(prr).toEqual({ companyId: PRR, ticker: "PRR", rusted: ["4"], discarded: [] });
    expect(losses.find((loss) => loss.companyId === BO)).toEqual({ companyId: BO, ticker: "B&O", rusted: ["4"], discarded: [] });
    for (const loss of losses) expect(describeFleetLoss(loss, 2)).not.toContain("discarded to meet");
    // Without the message: the old "discarded to meet the new limit of 2" -- the defect (P9n).
    expect(describeFleetLoss(describeFleetLosses(before, after).find((loss) => loss.companyId === PRR)!, 2)).toContain(
      "was discarded to meet the new limit of 2",
    );

    // A later ordinary trade-in under Gentle Rust (phase D, a 5 for a D): nothing to narrate but the exchange.
    const phaseD = board({
      corps: [{ id: PRR, trains: ["5", "D"] }, { id: NYC, trains: ["6", "D"] }],
      operating: PRR,
      gentle: true,
    });
    expect(derivePhase(phaseD)?.tier).toBe("D");
    const five = send(phaseD, EXCHANGE(PRR, "5"));
    expect(fleetOf(five, PRR)).toEqual(["D", "D"]);
    expect(describeFleetLosses(phaseD, five, EXCHANGE(PRR, "5"))).toEqual([]);
  });

  it("UI16. an ordinary excess discard is narrated exactly as before -- by the action, not by this diff", () => {
    const owedBoard = discardBoard(false);
    const due = pendingTrainDiscards(owedBoard)!.required;
    const before = owedBoard;
    const msg = DISCARD(due.companyId, due.choices[0]);
    const after = S.dispatchAs(before, msg, due.president!);
    expect(fleetOf(after, due.companyId).length).toBe(fleetOf(before, due.companyId).length - 1);
    expect(describeFleetLosses(before, after, msg)).toEqual([]);
  });

  it("UI17. an ordinary corporation-to-corporation sale is narrated exactly as before -- nothing here", () => {
    // P1 presides over PRR and C&O: the same-president sale settles on the spot (#1592). PRR buys C&O's 3.
    const before = board({
      corps: [{ id: PRR, trains: ["2", "2", "3"] }, { id: NYC, trains: ["2", "2"] }, { id: CO, trains: ["2", "2", "3"] }],
      operating: PRR,
    });
    const msg = SALE(PRR, CO, "3", "50");
    const after = send(before, msg);
    expect(fleetOf(after, CO)).toEqual(["2", "2"]);
    expect(describeFleetLosses(before, after, msg)).toEqual([]);
    expect(describeFleetLosses(before, after).find((loss) => loss.companyId === CO)?.discarded).toEqual(["3"]);
  });
});

describe("U-5. the discard obligation beside Final Run trains (the board the prompt explains)", () => {
  it("offers only trains that count toward the limit; the Final Run 2 is owned, and not a choice", () => {
    const state = discardBoard(true);
    const pending = pendingTrainDiscards(state)!;
    // NYC decides first (share value). Its 2s were rusted by its own purchase this round, so they are owed its NEXT
    // turn: still owned, marked, and not among the choices. B&O's 2s were owed B&O's turn and went at its Run
    // Routes, before it bought -- so B&O's own prompt has no Final Run train to explain.
    expect(pending.queue.map((due) => due.companyId)).toEqual([NYC, BO]);
    const nyc = pending.required;
    expect(nyc.companyId).toBe(NYC);
    expect(marksOf(state, NYC)).toEqual(["2", "2"]);
    expect(company(state, NYC).owned_trains).toEqual(["2", "2", "4", "4", "4"]);
    expect(nyc.choices).toEqual(["4", "4", "4"]);
    expect(marksOf(state, BO)).toEqual([]);
    // Legality unchanged: a DiscardTrain of the Final Run 2 is refused.
    expect(stateDigestOf(S.dispatchAs(state, DISCARD(NYC, "2"), nyc.president!))).toBe(stateDigestOf(state));
    // ... and a countable one is accepted, leaving the marks where they were.
    const answered = S.dispatchAs(state, DISCARD(NYC, "4"), nyc.president!);
    expect([fleetOf(answered, NYC), marksOf(answered, NYC)]).toEqual([["2", "2", "4", "4"], ["2", "2"]]);
  });

  it("the standard control owes a discard with no Final Run train anywhere", () => {
    const state = discardBoard(false);
    for (const due of pendingTrainDiscards(state)!.queue) expect(marksOf(state, due.companyId)).toEqual([]);
  });
});

/* ================================================================================================= */
/* U-11 -- THE SALE AND TRADE-IN SURFACES ASK THE AUTHORITY, AND IN ITS WORDS                        */
/* ================================================================================================= */

describe("U-11. the Final Run sentences come from the transaction authorities", () => {
  it("UI6. a sole Final Run copy: the roster's sentence IS the sale refusal's", () => {
    // NYC buys the first 4: C&O (P1, like PRR) holds marked 2s. PRR, operating next, may buy from C&O directly.
    const state = send(
      send(
        board({
          corps: [
            { id: NYC, trains: ["2", "2", "3"] },
            { id: PRR, trains: ["2", "3", "3"] },
            { id: CO, trains: ["2", "3"] },
            { id: BO, trains: ["2", "2", "3"] },
          ],
          operating: NYC,
          gentle: true,
        }),
        BUY(NYC),
      ),
      PASS,
    );
    const atHardware = advanceTo(state, "Hardware");
    expect(acting(atHardware)).toBe(PRR);
    expect(marksOf(atHardware, CO)).toEqual(["2"]);
    const refusal = trainSaleRefusal(atHardware, { buyerId: PRR, sellerId: CO, model: "2", price: 1 }, "p1", undefined, "proposal");
    expect(refusal).toBe("C&O's 2-train is on its Gentle Rust final run — it cannot be sold to another corporation.");
    expect(reprievedSaleReason(company(atHardware, CO), "2")).toBe(refusal);
    expect(finalRunPositions(company(atHardware, CO))).toEqual([true, false]);
    expect(refused(atHardware, SALE(PRR, CO, "2"))).toBe(true);
    // The ordinary 3 beside it is not touched by the rule.
    expect(reprievedSaleReason(company(atHardware, CO), "3")).toBeNull();
  });

  it("UI7 / UI8. REPRESENTATION-ONLY mixed copies: one ordinary copy stays saleable; after it is sold the other is refused", () => {
    const state = board({
      corps: [{ id: PRR, trains: ["3"] }, { id: NYC, trains: ["2", "2", "2"] }, { id: CO, trains: ["2", "2", "3"] }],
      operating: PRR,
      gentle: true,
    });
    const marked = {
      ...state,
      public_companies: state.public_companies.map((entry) =>
        entry.company_id === CO ? { ...entry, pending_rust_trains: ["2"] } : entry,
      ),
    } as GameStateResponse;
    expect(finalRunPositions(company(marked, CO))).toEqual([true, false, false]);
    expect(reprievedSaleReason(company(marked, CO), "2")).toBe(
      "One of C&O's 2-trains is on its Gentle Rust final run and cannot be sold to another corporation; the other can.",
    );
    expect(trainSaleRefusal(marked, { buyerId: PRR, sellerId: CO, model: "2", price: 1 }, "p1", undefined, "proposal")).toBeNull();
    const sold = send(marked, SALE(PRR, CO, "2"));
    expect([fleetOf(sold, CO), marksOf(sold, CO)]).toEqual([["2", "3"], ["2"]]);
    expect(finalRunPositions(company(sold, CO))).toEqual([true, false]);
    expect(reprievedSaleReason(company(sold, CO), "2")).toBe(
      "C&O's 2-train is on its Gentle Rust final run — it cannot be sold to another corporation.",
    );
    expect(refused(sold, SALE(PRR, CO, "2"))).toBe(true);
  });

  it("UI9. a sole Final Run 4 (self-doomed by the first D): shown greyed with the exchange refusal's sentence", () => {
    const before = dieselStart(["4"], { gentle: true });
    const after = send(before, BUY(PRR, "D"));
    expect([fleetOf(after, PRR), marksOf(after, PRR)]).toEqual([["4", "D"], ["4"]]);
    const offer = dieselExchangeOfferFor(after, PRR)!;
    expect(offer.models).toEqual([]);
    expect(offer.finalRun).toEqual([
      { model: "4", reason: "PRR's 4-train is on its Gentle Rust final run — it cannot be traded in for a Diesel." },
    ]);
    expect(offer.problem).toBe("PRR's only 4-, 5- or 6-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.");
    expect(offer.finalRun![0].reason).toBe(dieselExchangeRefusal(after, PRR, "4"));
    expect(refused(after, EXCHANGE(PRR, "4"))).toBe(true);
  });

  it("UI10. a Final Run 4 beside an ordinary 5: the 5 is the candidate, the 4 is shown and explained", () => {
    const before = dieselStart(["4"], { gentle: true, returned: ["5"] });
    const withD = send(before, BUY(PRR, "D"));
    const withFive = send(withD, S.BUY_RETURNED(PRR, "5"));
    expect([fleetOf(withFive, PRR), marksOf(withFive, PRR)]).toEqual([["4", "D", "5"], ["4"]]);
    const offer = dieselExchangeOfferFor(withFive, PRR)!;
    expect(offer.models).toEqual(["5"]);
    expect(offer.problem).toBeNull();
    expect(offer.finalRun).toEqual([
      { model: "4", reason: "PRR's 4-train is on its Gentle Rust final run — it cannot be traded in for a Diesel." },
    ]);
    const traded = send(withFive, EXCHANGE(PRR, "5"));
    expect(fleetOf(traded, PRR)).toEqual(["4", "D", "D"]);
  });

  it("UI11. REPRESENTATION-ONLY two identical 4s, one on a Final Run: one exchangeable copy, never both, never none", () => {
    const state = dieselStart(["4", "4"], { gentle: true, bo: ["5"] });
    const marked = {
      ...state,
      public_companies: state.public_companies.map((entry) =>
        entry.company_id === PRR ? { ...entry, pending_rust_trains: ["4"], pending_rust_doomed_this_turn: ["4"] } : entry,
      ),
    } as GameStateResponse;
    const offer = dieselExchangeOfferFor(marked, PRR)!;
    // `pending_rust_doomed_this_turn` is inside the marks already and is not subtracted twice.
    expect(offer.models).toEqual(["4"]);
    expect(reprievedExchangeCopies(company(marked, PRR))).toEqual(["4"]);
    expect(offer.finalRun).toEqual([
      { model: "4", reason: "One of PRR's 4-trains is on its Gentle Rust final run and cannot be traded in for a Diesel; the other can." },
    ]);
    expect(offer.problem).toBeNull();
  });

  it("UI12 / UI13. ordinary exchanges: the offer is what it was, at the table's price -- $800, and $750 under the LPF", () => {
    const standard = dieselStart(["4", "5"], { returned: ["5"] });
    const lpf = dieselStart(["4", "5"], { lpf: true });
    for (const [state, cost] of [
      [standard, DIESEL_EXCHANGE_COST],
      [lpf, LPF_DIESEL_EXCHANGE_COST],
    ] as const) {
      const offer = dieselExchangeOfferFor(state, PRR)!;
      expect(offer).toEqual({ models: ["4", "5"], problem: null, cost, finalRun: [] });
      expect(dieselExchangeCostFor(state)).toBe(cost);
      // UI19 / UI20's authority half: what is charged is what is shown.
      const traded = send(state, EXCHANGE(PRR, "5"));
      expect(treasuryOf(state, PRR) - treasuryOf(traded, PRR)).toBe(cost);
    }
    expect([DIESEL_EXCHANGE_COST, LPF_DIESEL_EXCHANGE_COST]).toEqual([800, 750]);
    // Standard play has no reprieve at all to explain.
    expect(reprievedExchangeReason(company(standard, PRR), "4")).toBeNull();
  });
});

/* ================================================================================================= */
/* UI18 / UI21 -- "AND END TURN" ONLY WHERE THE ENGINE ENDS THE TURN                                 */
/* ================================================================================================= */

describe("UI18 / UI21. the screen behind 'Pay $X and End Turn'", () => {
  it("UI18. the DT-1 board: the last 6 for $630 leaves a legal exchange -- the screen says one may follow, and the turn stays open", () => {
    const before = lastSixBoard();
    expect(derivePhase(before)?.tier).toBe("6");
    expect(headTier(before)).toBe("6");
    expect(dieselExchangeMayFollowPurchase(before, PRR, "6", 630)).toBe(true);
    const after = send(before, BUY(PRR, "6"));
    expect(fleetOf(after, PRR)).toEqual(["4", "6"]);
    expect(treasuryOf(before, PRR) - treasuryOf(after, PRR)).toBe(630);
    expect(dieselExchangeRefusal(after, PRR)).toBeNull();
    expect(buyTrainsAutoSkipReason(after, PRR)).toBeNull(); // the turn does NOT end
  });

  it("UI21. where the screen says no trade-in can follow, the turn really ends -- phase 3, and phase 6 without the money", () => {
    // Phase 3: PRR fills its limit of 4 with a 3; no 4, 5 or 6 anywhere near it.
    const phase3 = board({
      corps: [{ id: PRR, trains: ["2", "2", "3"] }, { id: NYC, trains: ["2", "2"] }, { id: BO, trains: ["2", "2"] }],
      operating: PRR,
    });
    expect([derivePhase(phase3)?.tier, headTier(phase3)]).toEqual(["3", "3"]);
    expect(dieselExchangeMayFollowPurchase(phase3, PRR, "3", 180)).toBe(false);
    const filled = send(phase3, BUY(PRR));
    expect(fleetOf(filled, PRR)).toEqual(["2", "2", "3", "3"]);
    expect(buyTrainsAutoSkipReason(filled, PRR)).toBe(TRAIN_LIMIT_SKIP_REASON);

    // Phase 6, the DT-1 board, but $700 in the treasury: $70 after the 6 cannot pay $800.
    const poor = lastSixBoard("700");
    expect(dieselExchangeMayFollowPurchase(poor, PRR, "6", 630)).toBe(false);
    const bought = send(poor, BUY(PRR, "6"));
    expect(buyTrainsAutoSkipReason(bought, PRR)).toBe(TRAIN_LIMIT_SKIP_REASON);
  });

  it("is conservative: every board where it says no, the post-purchase exchange is refused", () => {
    // A screen that said "no" wrongly would promise an ending the engine does not give; sampled across the boards
    // above plus the Gentle Rust sole-candidate case, where the only 4 is doomed by the purchase itself.
    const gentleSole = dieselStart(["4"], { gentle: true });
    // Buying the first D: the only candidate is marked by that very purchase, so the screen may say "yes" (it does
    // not look ahead) -- silence, never a false promise.
    expect(dieselExchangeMayFollowPurchase(gentleSole, PRR, "D", 1100)).toBe(true);
    for (const [state, tier, price] of [
      [board({ corps: [{ id: PRR, trains: ["2", "2", "3"] }, { id: NYC, trains: ["2", "2"] }, { id: BO, trains: ["2", "2"] }], operating: PRR }), "3", 180],
      [lastSixBoard("700"), "6", 630],
    ] as const) {
      expect(dieselExchangeMayFollowPurchase(state, PRR, tier, price)).toBe(false);
      expect(dieselExchangeRefusal(send(state, BUY(PRR, tier === "3" ? undefined : tier)), PRR)).not.toBeNull();
    }
  });
});

/* ================================================================================================= */
/* WIRING -- secondary evidence that the shell hands the surfaces these answers                      */
/* ================================================================================================= */

describe("the shell wires the surfaces to the shared answers (source scan, secondary)", () => {
  const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
  const APP = readStripped("App.tsx");
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("the bar's Final Run badge and chips read the board's schedule; the stale 'this turn' sentence is gone", () => {
    expect(APP).toContain("finalRunSchedule: finalRunScheduleFor(gameState, company.company_id)");
    expect(BAR).toContain("finalRunBadgeDetail(activeCorporation.finalRunSchedule)");
    expect(BAR).toContain("reprievedThisTurn={activeCorporation.finalRunSchedule.thisTurn}");
    expect(BAR).not.toContain("destroyed at the end of this turn's Run Routes step");
  });

  it("the trade-in row and the Pay button ask the Diesel module; the discard prompt gets the marks", () => {
    expect(APP).toContain("dieselExchangeOfferFor(gameState, actingProtocolId)");
    expect(APP).toContain("dieselExchangeMayFollowPurchase(gameState, actingProtocolId, tier, price)");
    expect(APP).toMatch(/finalRun:\s*gameState\?\.public_companies\.find\(\(company\) => company\.company_id === required\.companyId\)\s*\?\.pending_rust_trains \?\? \[\]/);
    expect(readStripped("components/TrainPurchasePanel.tsx")).not.toContain("DIESEL_EXCHANGE_COST");
  });

  it("the other chip surfaces with a board pass the timing too", () => {
    expect(readStripped("components/ContextualSubPanel.tsx")).toContain("reprievedThisTurn={finalRunScheduleFor(gameState, company.company_id).thisTurn}");
    expect(readStripped("components/FinancialLedger.tsx")).toContain("reprievedThisTurn={finalRunScheduleFor(gameState, company.company_id).thisTurn}");
    // The chip consults the Final Run wording before the rust window's, so a reprieved chip cannot fall through to it.
    expect(readStripped("components/TrainBadges.tsx")).toMatch(/isFinalRun\s*\?\s*finalRunChipTooltip\(finalRunWhen\)\s*:\s*rustTooltip\(/);
  });
});
