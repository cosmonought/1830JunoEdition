/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1703 (harness): GR-4 -- THE GAPS THE EARLIER SLICES LEFT, CLOSED BY MESSAGES
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` §3 / §4 / §11. EVIDENCE MAP:
// `VARIANT_CERT_GENTLE_RUST_CERTIFICATION_2026-09-24.md`. This file adds ONLY what GR-1 (`gentleRustGraceTurn`),
// GR-2 (`gentleRustTransactionLocks`), DT-1 (`dieselExchangeAutoSkip`), GR-3 (`gentleRustPresentation`) and the
// constructed game (`gentleRustCertificationGame`) do not already prove behaviourally:
//   E / A / B  -- the forced-purchase side of "owns a train", asked through MESSAGES (End Turn, the emergency
//                 purchase) rather than helper calls, with a standard-rules control proving there is no Gentle Rust
//                 purchase rule (the obligation is the ordinary one, byte for byte, once ownership reaches zero);
//   GR-S4      -- the emergency purchase is a rust trigger like any other (Gentle: marks; standard: destroys);
//   D          -- limit capacity through purchases: a Final Run train frees its slot for another purchase, an
//                 ordinary train still fills one, and ownership above the limit owes no discard;
//   multiset   -- an expiry beside an ordinary twin of the same model removes exactly the marked copy;
//   discard    -- the dead trim helper's useful expectation (one slot per MARK, not per model) on the live
//                 `pendingTrainDiscards` / `DiscardTrain` authority;
//   arms       -- the sub-multiset invariant after the category-A arms the game does not visit (a Bank Pool
//                 purchase with live marks elsewhere, both turn-end fallbacks, an emergency purchase);
//   LPF / 18XX+ -- the rust tiers and the limit table on those tables, the first D bought outright at $900.
//
// Boards are the GR-1 / GR-2 / GR-3 harness's legal pinned v8 Operating Rounds (`gentleRustPresentationSupport`):
// every mark written by a real phase-changing message. Hand-written state is labelled REPRESENTATION (a board today's
// messages cannot reach) or PROBE (the cursor moved to ask one question); a refusal is judged by digest.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import {
  BO,
  CO,
  NYC,
  PRR,
  P1,
  P2,
  P3,
  board,
  company,
  fleetOf,
  marksOf,
  treasuryOf,
  acting,
  BUY,
  BUY_RETURNED,
  EXCHANGE,
  DISCARD,
  PASS,
  headTier,
  type Msg,
} from "./gentleRustPresentationSupport";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { derivePhase } from "../gameEngine/gamePhase";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import { stateDigest } from "../gameEngine/stateDigest";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { countableTrainCount } from "../gameEngine/trainLimit";
import { pendingTrainDiscards, discardTrainRefusal } from "../gameEngine/trainDiscard";
import { trainObligationFor } from "../gameEngine/trainAvailability";
import { emergencyFundingFor, emergencyPurchaseRefusal } from "../gameEngine/emergencyFunding";
import { dieselExchangeCostFor, dieselExchangeRefusal, DIESEL_EXCHANGE_COST, LPF_DIESEL_EXCHANGE_COST } from "../gameEngine/dieselExchange";
import { moneyTotal } from "../gameEngine/cashLedger";
import { refusalReasonFor } from "./refusedAction";
import { routeSkipRefusal } from "../gameEngine/routeAuthority";

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

const at = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
  return { q: hex.q, r: hex.r };
};
/** GR-1's straight of three yellow cities, I5 - I7 - I9: C&O (home I5) runs a 2-train for $40. */
const LINE: MapGridResponse = {
  game_id: 1,
  tiles: (["I5", "I7", "I9"] as const).map((label) => ({ ...at(label), tile_id: 57, orientation: 0 }) as MapTileEntry),
};

const actorOf = (state: GameStateResponse): string => {
  const id = acting(state);
  return id !== null ? company(state, id).president! : state.player_addresses[state.active_player_index];
};
/** The reducer as a room calls it -- the table's rules in scope -- with a grid when the case needs routes. */
const dispatch = (state: GameStateResponse, msg: Msg, grid?: MapGridResponse, actor = actorOf(state)) =>
  withRules(resolveVariants(state.variants), () =>
    applySandboxAction(state, msg, { actor, ...(grid ? { mapGrid: grid, era: "Yellow" } : {}) }),
  );
function send(state: GameStateResponse, msg: Msg, grid?: MapGridResponse, actor?: string): GameStateResponse {
  const after = dispatch(state, msg, grid, actor);
  if (stateDigest(after) === stateDigest(state)) {
    throw new Error(`refused: ${JSON.stringify(msg)} -- ${refusalReasonFor(state, msg) ?? "no reason"}`);
  }
  return after;
}
const refused = (state: GameStateResponse, msg: Msg, grid?: MapGridResponse, actor?: string) =>
  stateDigest(dispatch(state, msg, grid, actor)) === stateDigest(state);
const ADVANCE = (state: GameStateResponse) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: acting(state) } }) as unknown as Msg;
const EMERGENCY = (id: number) => ({ EmergencyBuyHardware: { game_id: 1, protocol_id: id } }) as unknown as Msg;
function advanceTo(state: GameStateResponse, step: string, grid?: MapGridResponse): GameStateResponse {
  let now = state;
  for (let guard = 0; now.operating_sub_phase !== step; guard += 1) {
    if (guard > 6) throw new Error(`never reached ${step}`);
    now = send(now, ADVANCE(now), grid);
  }
  return now;
}
const countable = (state: GameStateResponse, id: number) => {
  const c = company(state, id);
  return countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains);
};
const copies = (list: readonly string[] | null | undefined, model: string) => (list ?? []).filter((entry) => entry === model).length;
function expectMarksWithinFleets(state: GameStateResponse): void {
  for (const entry of state.public_companies) {
    const owned = entry.owned_trains ?? [];
    const marks = entry.pending_rust_trains ?? [];
    const doomed = entry.pending_rust_doomed_this_turn ?? [];
    for (const model of Array.from(new Set([...owned, ...marks, ...doomed]))) {
      const row = [entry.ticker, model, copies(doomed, model), copies(marks, model), copies(owned, model)];
      expect([...row, copies(doomed, model) <= copies(marks, model) && copies(marks, model) <= copies(owned, model)]).toEqual([...row, true]);
    }
  }
}

/* ================================================================== */
/* E / A / B -- owning a train is not the train-limit count           */
/* ================================================================== */

/** NYC buys the first 4 in its Buy Trains step; C&O (home I5 on LINE), holding only 2-trains and $100, operates
 *  next -- its grace turn. The 3s are all held and the 2s all marked, so the depot's head after the purchase is a
 *  4 at $300. */
const graceBoard = (gentle: boolean) => {
  const before = board({
    corps: [
      { id: NYC, trains: ["3"] },
      { id: CO, trains: ["2", "2"], treasury: "100" },
      { id: PRR, trains: ["2", "2", "3", "3"] },
      { id: BO, trains: ["2", "2", "3", "3"] },
    ],
    operating: NYC,
    gentle,
  });
  if (headTier(before) !== "4") throw new Error("graceBoard: the depot's head is not the first 4");
  return send(send(before, BUY(NYC), LINE), PASS, LINE);
};

describe("E / A / B. a corporation whose only trains are Final Run trains owns trains -- asked through messages", () => {
  it("A: at the start of its grace turn C&O owns two trains and counts none toward the limit; skipping its run is refused because it owns trains and has a paying route", () => {
    const state = graceBoard(true);
    expect([acting(state), state.operating_sub_phase, fleetOf(state, CO), marksOf(state, CO), countable(state, CO)]).toEqual([
      CO,
      "Track",
      ["2", "2"],
      ["2", "2"],
      0,
    ]);
    const atRoutes = advanceTo(state, "Routes", LINE);
    expect(refused(atRoutes, ADVANCE(atRoutes), LINE)).toBe(true);
    expect(routeSkipRefusal(atRoutes, ADVANCE(atRoutes), LINE)).not.toBeNull();
  });

  it("E (PROBE): were its Buy Trains step reached while it still held only Final Run trains, End Turn is ACCEPTED and the president's money is REFUSED -- the capacity count (0) is not 'owns a train'", () => {
    // PROBE: the cursor moved to Buy Trains at the start of the grace turn. Unreachable in play (the grace turn's own
    // Run Routes end removes the trains first) -- which is exactly why a regression that read the capacity count as
    // ownership would be invisible to every played board and must be pinned here. `trainObligationFor` substituting
    // `countableTrainCount` for the raw fleet makes BOTH expectations below fail.
    const grace = graceBoard(true);
    const probe = { ...grace, operating_sub_phase: "Hardware" } as GameStateResponse;
    expect(countable(probe, CO)).toBe(0);
    expect(trainObligationFor(probe, CO, LINE)).toEqual({ owed: false, reason: null });
    expect(emergencyFundingFor(probe, LINE)).toBeNull();
    expect(refused(probe, EMERGENCY(CO), LINE, P1)).toBe(true);
    expect(emergencyPurchaseRefusal(probe, CO, LINE, P1)).toBe("No forced train purchase is owed, so the president's money may not be used.");
    const ended = send(probe, PASS, LINE);
    expect(acting(ended)).toBe(PRR);
  });

  it("B: at the end of Run Routes the trains are destroyed; only then is End Turn refused with the ordinary 6.6.2 sentence, and the ordinary emergency purchase (president's money) goes through", () => {
    let state = advanceTo(graceBoard(true), "Routes", LINE);
    state = send(state, { RunMultipleRoutes: { game_id: 1, protocol_id: CO, routes: [[{ hex: "I5" }, { hex: "I7" }]], train_indices: [0], revenue_turn: "gr4" } } as unknown as Msg, LINE);
    expect([state.operating_sub_phase, fleetOf(state, CO), marksOf(state, CO)]).toEqual(["Dividends", [], []]);
    state = send(state, { DeclareDividends: { game_id: 1, protocol_id: CO, distribute: false, revenue_amount: "40" } } as unknown as Msg, LINE);
    expect([state.operating_sub_phase, treasuryOf(state, CO)]).toEqual(["Hardware", 140]);

    const obligation = trainObligationFor(state, CO, LINE);
    expect(obligation.owed).toBe(true);
    expect(refused(state, PASS, LINE)).toBe(true);
    const funding = emergencyFundingFor(state, LINE)!;
    expect([funding.companyId, funding.train.tier, funding.train.cost, funding.treasury]).toEqual([CO, "4", 300, 140]);
    expect(emergencyPurchaseRefusal(state, CO, LINE, P1)).toBeNull();
    const money = moneyTotal(state);
    const bought = send(state, EMERGENCY(CO), LINE, P1);
    expect([fleetOf(bought, CO), treasuryOf(bought, CO), moneyTotal(bought)]).toEqual([["4"], 0, money]);
    expectMarksWithinFleets(bought);
    expect(acting(send(bought, PASS, LINE))).toBe(PRR);
  });

  it("B CONTROL: the obligation is the ordinary one -- a corporation made trainless by STANDARD rust meets the identical sentence and the identical emergency purchase", () => {
    const gentle = (() => {
      let state = advanceTo(graceBoard(true), "Routes", LINE);
      state = send(state, { RunMultipleRoutes: { game_id: 1, protocol_id: CO, routes: [[{ hex: "I5" }, { hex: "I7" }]], train_indices: [0], revenue_turn: "gr4" } } as unknown as Msg, LINE);
      return send(state, { DeclareDividends: { game_id: 1, protocol_id: CO, distribute: false, revenue_amount: "40" } } as unknown as Msg, LINE);
    })();
    // Standard game: the first 4 destroyed C&O's 2s at the purchase, so it reaches Buy Trains trainless with its
    // $100 (nothing to run, nothing to withhold).
    let standard = graceBoard(false);
    expect([fleetOf(standard, CO), marksOf(standard, CO)]).toEqual([[], []]);
    standard = advanceTo(standard, "Hardware", LINE);
    const std = trainObligationFor(standard, CO, LINE);
    const gr = trainObligationFor(gentle, CO, LINE);
    expect(std).toEqual(gr);
    expect(refusalReasonFor(standard, PASS, { mapGrid: LINE })).toBe(refusalReasonFor(gentle, PASS, { mapGrid: LINE }));
    expect(refusalReasonFor(gentle, PASS, { mapGrid: LINE })).toBe(
      "C&O must buy a 4-train ($300) and cannot pay for it; its president must fund the purchase before anything else happens.",
    );
    const a = emergencyFundingFor(standard, LINE)!;
    const b = emergencyFundingFor(gentle, LINE)!;
    expect([a.train, a.president, a.companyId]).toEqual([b.train, b.president, b.companyId]);
    expect(fleetOf(send(standard, EMERGENCY(CO), LINE, P1), CO)).toEqual(["4"]);
  });
});

/* ================================================================== */
/* GR-S4 -- the emergency purchase is a trigger like any other        */
/* ================================================================== */

describe("GR-S4. an emergency purchase that brings the first 4 changes the phase and dooms every held 2", () => {
  // Phase 3, every 2 and 3 held, so the cheapest train for sale is the first 4. C&O (home I5 on LINE: a route) owns
  // no train and has $100; its president covers the rest -- the ordinary 6.6.2 path.
  const start = (gentle: boolean) =>
    board({
      corps: [
        { id: CO, trains: [], treasury: "100" },
        { id: NYC, trains: ["2", "2", "3"] },
        { id: PRR, trains: ["2", "2", "3", "3"] },
        { id: BO, trains: ["2", "2", "3", "3"] },
      ],
      operating: CO,
      gentle,
    });

  it("Gentle Rust: the forced first 4 marks every 2 in play; nothing is destroyed; the buyer holds no 2", () => {
    const before = start(true);
    expect([headTier(before), derivePhase(before)?.tier, trainObligationFor(before, CO, LINE).owed]).toEqual(["4", "3", true]);
    const after = send(before, EMERGENCY(CO), LINE, P1);
    expect([derivePhase(after)?.tier, fleetOf(after, CO), marksOf(after, CO)]).toEqual(["4", ["4"], []]);
    expect([marksOf(after, NYC), marksOf(after, PRR), marksOf(after, BO)]).toEqual([["2", "2"], ["2", "2"], ["2", "2"]]);
    expect([fleetOf(after, NYC), fleetOf(after, PRR), fleetOf(after, BO)]).toEqual([["2", "2", "3"], ["2", "2", "3", "3"], ["2", "2", "3", "3"]]);
    expectMarksWithinFleets(after);
  });

  it("CONTROL (standard rules): the same forced purchase destroys every 2 at once", () => {
    const after = send(start(false), EMERGENCY(CO), LINE, P1);
    expect([derivePhase(after)?.tier, fleetOf(after, NYC), fleetOf(after, PRR), fleetOf(after, BO)]).toEqual(["4", ["3"], ["3", "3"], ["3", "3"]]);
    expect(after.public_companies.every((c) => (c.pending_rust_trains ?? []).length === 0)).toBe(true);
  });
});

/* ================================================================== */
/* D -- limit capacity through purchases                              */
/* ================================================================== */

describe("D. a Final Run train occupies no slot; an ordinary train still fills one", () => {
  // PRR buys the first 4 itself: its own two 2s are doomed in this turn and do not fill limit-3 slots.
  const start = (gentle: boolean) =>
    board({
      corps: [{ id: PRR, trains: ["2", "2", "3"] }, { id: NYC, trains: ["2", "2", "3", "3"] }, { id: BO, trains: ["2", "2", "3", "3"] }],
      operating: PRR,
      gentle,
    });

  it("PRR owns 5 trains under a limit of 3 after two purchases, owes no discard, and the third purchase is refused by the ORDINARY trains filling the limit", () => {
    let state = start(true);
    state = send(state, BUY(PRR));
    expect([derivePhase(state)?.trainLimit, fleetOf(state, PRR), marksOf(state, PRR), countable(state, PRR)]).toEqual([3, ["2", "2", "3", "4"], ["2", "2"], 2]);
    state = send(state, BUY(PRR));
    expect([fleetOf(state, PRR).length, countable(state, PRR)]).toEqual([5, 3]);
    expect(pendingTrainDiscards(state)).toBeNull();
    expect(refused(state, BUY(PRR))).toBe(true);
    expect(refusalReasonFor(state, BUY(PRR))).toMatch(/limit/i);
    expectMarksWithinFleets(state);
  });

  it("CONTROL (standard rules): the 2s are destroyed at the first 4, so the same fleet reaches the same limit with one purchase fewer -- the limit counts every owned train", () => {
    let state = send(start(false), BUY(PRR));
    expect([fleetOf(state, PRR), marksOf(state, PRR), countable(state, PRR)]).toEqual([["3", "4"], [], 2]);
    state = send(state, BUY(PRR));
    expect([fleetOf(state, PRR), countable(state, PRR)]).toEqual([["3", "4", "4"], 3]);
    expect(refused(state, BUY(PRR))).toBe(true);
  });
});

/* ================================================================== */
/* Multiset -- expiry beside an ordinary twin                         */
/* ================================================================== */

describe("multiset. an expiry removes exactly the marked multiplicity and never an ordinary copy of the same model", () => {
  it("REPRESENTATION: C&O holds one marked 2 and one ordinary 2 at its grace turn -- entering Dividends takes one 2, the ordinary copy stays, no mark remains", () => {
    // REPRESENTATION: an ordinary 2 added beside C&O's real mark (every copy of a doomed model is marked at once, so
    // only the two holes GR-2 closed could have produced this). The expiry arm is asked the multiset question.
    const grace = graceBoard(true);
    const twin = {
      ...grace,
      public_companies: grace.public_companies.map((c) => (c.company_id === CO ? { ...c, owned_trains: ["2", "2", "2"], pending_rust_trains: ["2", "2"] } : c)),
    } as GameStateResponse;
    const after = advanceTo(twin, "Dividends");
    expect([fleetOf(after, CO), marksOf(after, CO)]).toEqual([["2"], []]);
    expectMarksWithinFleets(after);
  });
});

/* ================================================================== */
/* Excess discard on the live authority                               */
/* ================================================================== */

describe("discard. the live 6.6.1 authority subtracts one slot per MARK, not per model (the trim helper's case, retargeted)", () => {
  it("REPRESENTATION: owned [3,3,5,6] with one 3 marked, limit 2 -- one discard owed, the choices keep the ORDINARY 3, the discard takes that copy, the mark stays", () => {
    // REPRESENTATION: an ordinary 3 beside a marked 3 in phase 6 (unreachable, as above). What this pins is the live
    // authority's multiset: `trimToTrainLimit`'s "exempts one train per mark, not every train of that model" asked of
    // `pendingTrainDiscards` and `DiscardTrain`, which is what the game actually runs since #1530.
    const s = board({
      corps: [{ id: NYC, trains: ["6"] }, { id: PRR, trains: ["3", "3", "5", "6"] }],
      operating: NYC,
      gentle: true,
      returned: ["5", "5"],
    });
    const probe = {
      ...s,
      public_companies: s.public_companies.map((c) => (c.company_id === PRR ? { ...c, pending_rust_trains: ["3"] } : c)),
    } as GameStateResponse;
    expect([derivePhase(probe)?.tier, derivePhase(probe)?.trainLimit, countable(probe, PRR)]).toEqual(["6", 2, 3]);
    const owed = pendingTrainDiscards(probe)!;
    expect(owed.queue.map((due) => [due.ticker, due.excess, [...due.choices]])).toEqual([["PRR", 1, ["3", "5", "6"]]]);
    expect(discardTrainRefusal(probe, { protocol_id: PRR, model_type: "3" }, P1)).toBeNull();
    const after = send(probe, DISCARD(PRR, "3"), undefined, P1);
    expect([fleetOf(after, PRR), marksOf(after, PRR), after.returned_trains]).toEqual([["3", "5", "6"], ["3"], ["5", "5", "3"]]);
    expect(pendingTrainDiscards(after)).toBeNull();
    expect(refused(after, DISCARD(PRR, "3"), undefined, P1)).toBe(true);
    expectMarksWithinFleets(after);
  });
});

/* ================================================================== */
/* Train-moving arms not visited by the game                          */
/* ================================================================== */

describe("arms. the sub-multiset invariant after the category-A arms the constructed game does not visit", () => {
  // Phase 3, last round of the set. NYC [3,3,3] buys the first 4 (over the new limit of 3 on ordinary trains: it
  // discards a 3 to the Bank Pool); PRR, C&O and B&O hold 2s that are marked. PRR then buys the pooled 3 while C&O's
  // and B&O's marks stand; C&O and B&O end their grace turns at Lay Track (OBS-1: no grid), so the two turn-end
  // fallbacks -- a turn change, then leaving the Operating Round -- spend their marks.
  const start = () =>
    board({
      corps: [
        { id: NYC, trains: ["3", "3", "3"] },
        { id: PRR, trains: ["2", "2"] },
        { id: CO, trains: ["2", "3"] },
        { id: BO, trains: ["2", "3"] },
      ],
      operating: NYC,
      sub: 2,
      length: 2,
    });

  it("Bank Pool purchase with live marks elsewhere; turn-change fallback; leaving-the-round fallback -- every board keeps doomed <= marks <= fleet and no expiry reaches the pool", () => {
    let state = { ...start(), variants: resolveVariants({ gentleRust: true }) } as GameStateResponse;
    expect(headTier(state)).toBe("4");
    state = send(state, BUY(NYC));
    expectMarksWithinFleets(state);
    state = send(state, DISCARD(NYC, "3"), undefined, P2);
    expect([fleetOf(state, NYC), state.returned_trains]).toEqual([["3", "3", "4"], ["3"]]);
    expectMarksWithinFleets(state);
    state = send(state, PASS);

    // PRR: its 2s expire at its Run Routes end (the normal point); then it buys the Bank Pool's 3 while C&O's and
    // B&O's marks stand untouched.
    expect(acting(state)).toBe(PRR);
    state = advanceTo(state, "Hardware");
    expect([fleetOf(state, PRR), marksOf(state, PRR)]).toEqual([[], []]);
    const marksBefore = [marksOf(state, CO), marksOf(state, BO)];
    state = send(state, BUY_RETURNED(PRR, "3"));
    expect([fleetOf(state, PRR), state.returned_trains, [marksOf(state, CO), marksOf(state, BO)]]).toEqual([["3"], [], marksBefore]);
    expectMarksWithinFleets(state);
    state = send(state, PASS);

    // C&O ends its grace turn at Lay Track: the turn-change fallback spends its owed mark.
    expect([acting(state), state.operating_sub_phase]).toEqual([CO, "Track"]);
    const poolBefore = [...(state.returned_trains ?? [])];
    state = send(state, PASS);
    expect([acting(state), fleetOf(state, CO), marksOf(state, CO), state.returned_trains]).toEqual([BO, ["3"], [], poolBefore]);
    expectMarksWithinFleets(state);

    // B&O, the last corporation of the last round, does the same: the leaving-the-round fallback.
    state = send(state, PASS);
    expect([state.current_round_type, fleetOf(state, BO), marksOf(state, BO), state.returned_trains]).toEqual(["StockRound", ["3"], [], poolBefore]);
    expectMarksWithinFleets(state);
  });
});

/* ================================================================== */
/* LPF / 18XX+                                                        */
/* ================================================================== */

describe("LPF / 18XX+. Gentle Rust on those tables: the same rust tiers, the table's own limit, the table's Diesel prices", () => {
  it("Level Playing Field: the 7-train rusts nothing; the first D bought outright ($900) marks every 4 -- the buyer's own this turn -- and the limit is the table's 2", () => {
    const sevenBoard = board({ corps: [{ id: PRR, trains: ["6"] }, { id: NYC, trains: ["4", "5"] }], operating: PRR, gentle: true, lpf: true });
    expect(derivePhase(sevenBoard)?.tier).toBe("6");
    const seven = send(sevenBoard, BUY(PRR, "7"));
    expect([fleetOf(seven, PRR), marksOf(seven, PRR), fleetOf(seven, NYC), marksOf(seven, NYC)]).toEqual([["6", "7"], [], ["4", "5"], []]);
    let state = board({ corps: [{ id: PRR, trains: ["4"] }, { id: NYC, trains: ["6", "4"] }], operating: PRR, gentle: true, lpf: true });
    expect(derivePhase(state)?.tier).toBe("6");
    state = send(state, BUY(PRR, "D"));
    expect([derivePhase(state)?.tier, derivePhase(state)?.trainLimit]).toEqual(["D", 2]);
    expect([fleetOf(state, PRR), marksOf(state, PRR), company(state, PRR).pending_rust_doomed_this_turn, treasuryOf(state, PRR)]).toEqual([
      ["4", "D"],
      ["4"],
      ["4"],
      3000 - 900,
    ]);
    expect([fleetOf(state, NYC), marksOf(state, NYC)]).toEqual([["6", "4"], ["4"]]);
    // The Final Run 4 frees its slot under the table's limit: NYC owns 2 trains and counts 1; PRR may buy again.
    expect([countable(state, NYC), countable(state, PRR), pendingTrainDiscards(state)]).toEqual([1, 1, null]);
    expect(fleetOf(send(state, BUY(PRR, "D")), PRR)).toEqual(["4", "D", "D"]);
    // The LPF exchange price is $750 for an ordinary train (GR-2 D7) and refused for the Final Run 4 (GR-2 D8).
    expect(dieselExchangeCostFor(state)).toBe(LPF_DIESEL_EXCHANGE_COST);
    expect(dieselExchangeRefusal(state, PRR, "4")).toMatch(/Gentle Rust final run/);
    expectMarksWithinFleets(state);
  });

  it("Project 18XX+ (expanded map and tiles, no LPF): the first D by an $800 trade-in marks every remaining 4 exactly as on the standard table", () => {
    const base = board({
      corps: [{ id: PRR, trains: ["4", "4"] }, { id: NYC, trains: ["6", "6"] }, { id: BO, trains: ["4"] }],
      operating: PRR,
      gentle: true,
    });
    const plus = { ...base, variants: resolveVariants({ gentleRust: true, expandedMap: true, plusTiles: true }) } as GameStateResponse;
    expect([resolveVariants(plus.variants).expandedMap, resolveVariants(plus.variants).levelPlayingField]).toEqual([true, false]);
    expect(dieselExchangeCostFor(plus)).toBe(DIESEL_EXCHANGE_COST);
    const traded = send(plus, EXCHANGE(PRR, "4"));
    expect([derivePhase(traded)?.tier, derivePhase(traded)?.trainLimit]).toEqual(["D", 2]);
    expect([fleetOf(traded, PRR), marksOf(traded, PRR), fleetOf(traded, BO), marksOf(traded, BO), traded.returned_trains]).toEqual([
      ["4", "D"],
      ["4"],
      ["4"],
      ["4"],
      [],
    ]);
    expect(treasuryOf(traded, PRR)).toBe(3000 - DIESEL_EXCHANGE_COST);
    expect(refused(traded, EXCHANGE(PRR, "4"))).toBe(true);
    expectMarksWithinFleets(traded);
  });
});
