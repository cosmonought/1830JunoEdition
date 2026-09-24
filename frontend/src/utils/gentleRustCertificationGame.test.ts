/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1703 (harness): GR-4 -- THE CONSTRUCTED LEGAL CERTIFICATION GAME
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` (§3 GR-S1 ... GR-S30, §4 SR-1 ... SR-9, §11 invariants
// A-H). EVIDENCE: `VARIANT_CERT_GENTLE_RUST_CERTIFICATION_2026-09-24.md` §G.
//
// ONE GAME, THREE RUST BOUNDARIES. The starting board and the fixed message list live in
// `gentleRustCertificationGame.ts` (provenance in its header). Everything below reads the boards a real
// `RoomSession` produced from those messages -- the room's own derived entries included -- and never writes a
// board. The only hand-edited boards in this file are the standard-rules CONTROLS in G6, each labelled: the same
// board the game handed the phase-changing message, with the variant switched off, asked the same message once.
//
// WHAT THIS FILE PROVES THAT THE ISOLATED SUITES DO NOT: the rules compose. A self-trigger at the first 4 whose
// 2-train meets a rival's first 6 before its grace turn (two groups, one turn); an excess discard at the first 5
// with a Final Run train in the fleet; Bank Pool copies of the 3 and the 4 scrapped at their phase; an ordinary
// first-D trade-in followed at once by the refused trade-in of the 4 it doomed; and a final board holding no
// 2-, 3- or 4-train anywhere.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import {
  ALBANY_LAY,
  BANK_SIZE,
  BO,
  CO,
  CPR,
  EMPTY_GRID,
  FLOATED,
  NYC,
  PRR,
  SCRIPT,
  TICKER,
  certificationRoom,
  certificationStart,
  runCertificationGame,
  runFingerprint,
  type CertificationRun,
} from "./gentleRustCertificationGame";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { derivePhase, depotInventory } from "../gameEngine/gamePhase";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { stateDigest, canonicalJson } from "../gameEngine/stateDigest";
import { moneyTotal } from "../gameEngine/cashLedger";
import { countableTrainCount } from "../gameEngine/trainLimit";
import { pendingTrainDiscards } from "../gameEngine/trainDiscard";
import { trainObligationFor } from "../gameEngine/trainAvailability";
import { graceTurnReprieves } from "../gameEngine/gentleRustGrace";
import { exchangeableTrains, dieselExchangeRefusal, DIESEL_EXCHANGE_COST } from "../gameEngine/dieselExchange";
import { owedHomeStation, boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { replayLog } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";

/* ------------------------------------------------------------------ */
/* Reading boards                                                     */
/* ------------------------------------------------------------------ */

const company = (state: GameStateResponse, id: number): PublicCompanyState => state.public_companies.find((entry) => entry.company_id === id)!;
const fleetOf = (state: GameStateResponse, id: number) => [...(company(state, id).owned_trains ?? [])];
const marksOf = (state: GameStateResponse, id: number) => [...(company(state, id).pending_rust_trains ?? [])];
const doomedOf = (state: GameStateResponse, id: number) => company(state, id).pending_rust_doomed_this_turn;
const countable = (state: GameStateResponse, id: number) => {
  const c = company(state, id);
  return countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains);
};
const limitOf = (state: GameStateResponse) => derivePhase(state)!.trainLimit;
const headTier = (state: GameStateResponse) => depotInventory(state).find((row) => row.remaining === null || (row.remaining ?? 0) > 0)?.tier;
const operating = (state: GameStateResponse) =>
  state.current_round_type === "OperatingRound" ? (state.active_operating_order[state.active_corporation_index] ?? null) : null;
const floatedIds = FLOATED.map((entry) => entry.id);
const copies = (list: readonly string[] | null | undefined, model: string) => (list ?? []).filter((entry) => entry === model).length;

/** doomed-this-turn <= marks <= fleet, by model and multiplicity, for every corporation. */
function marksWithinFleets(state: GameStateResponse): string[] {
  const breaches: string[] = [];
  for (const entry of state.public_companies) {
    const owned = entry.owned_trains ?? [];
    const marks = entry.pending_rust_trains ?? [];
    const doomed = entry.pending_rust_doomed_this_turn ?? [];
    for (const model of Array.from(new Set([...owned, ...marks, ...doomed]))) {
      if (!(copies(doomed, model) <= copies(marks, model) && copies(marks, model) <= copies(owned, model))) {
        breaches.push(`${entry.ticker} ${model}: doomed ${copies(doomed, model)} marks ${copies(marks, model)} owned ${copies(owned, model)}`);
      }
    }
  }
  return breaches;
}

/** Every corporation holding `tier` has every copy marked, and nobody holds a mark of any other tier that was not
 *  there before. */
function expectEveryCopyMarked(before: GameStateResponse, after: GameStateResponse, tier: string) {
  for (const id of floatedIds) {
    expect([TICKER[id], copies(marksOf(after, id), tier)]).toEqual([TICKER[id], copies(fleetOf(after, id), tier)]);
    const added = [...marksOf(after, id)];
    for (const model of marksOf(before, id)) {
      const at = added.indexOf(model);
      if (at >= 0) added.splice(at, 1);
    }
    expect([TICKER[id], added.filter((model) => model !== tier)]).toEqual([TICKER[id], []]);
  }
}

let run: CertificationRun;
/** The replay's board handed to each log index, and the final board. */
let boardAt: Map<number, GameStateResponse>;
beforeAll(() => {
  run = runCertificationGame();
  const { boards, result } = everyBoard(run.room.entries, certificationStart());
  boardAt = new Map(boards.map((b) => [b.index, b.state]));
  boardAt.set(run.room.nextIndex, result.state);
});
/** The board right after a step's OWN entry -- before any entry the room derived from it (a derived end of turn
 *  releases this turn's doom record, so the purchase's own consequence is read here). */
const rightAfter = (label: string): GameStateResponse => {
  const played = run.played.find((entry) => entry.step.label === label)!;
  return boardAt.get(played.indices[0] + 1)!;
};

/* ================================================================== */
/* G0. The starting board                                             */
/* ================================================================== */

describe("G0. the starting board is a legal phase-3 board", () => {
  const s0 = certificationStart();

  it("phase 3, limit 4, the depot's head is the first 4: every 2 and every 3 owned, the Bank Pool empty", () => {
    expect(derivePhase(s0)?.tier).toBe("3");
    expect(limitOf(s0)).toBe(4);
    expect(headTier(s0)).toBe("4");
    const all = s0.public_companies.flatMap((entry) => entry.owned_trains ?? []);
    expect([copies(all, "2"), copies(all, "3"), all.length]).toEqual([6, 5, 11]);
    expect(s0.returned_trains).toEqual([]);
    for (const id of floatedIds) expect(fleetOf(s0, id).length).toBeLessThanOrEqual(4);
    expect(s0.public_companies.every((entry) => (entry.pending_rust_trains ?? []).length === 0)).toBe(true);
    expect(s0.public_companies.some((entry) => entry.pending_rust_doomed_this_turn !== undefined)).toBe(false);
  });

  it("five corporations floated on their real home hexes, each with its token -- no home station owed", () => {
    for (const id of floatedIds) {
      const c = company(s0, id);
      const home = STATION_HOME_HEXES.find((entry) => entry.companyId === id)!;
      expect([c.ticker, c.home_hex_label, c.station_token_hexes]).toEqual([TICKER[id], home.label, [[home.q, home.r]]]);
      const onTurn = { ...s0, active_corporation_index: s0.active_operating_order.indexOf(id) } as GameStateResponse;
      expect([TICKER[id], owedHomeStation(onTurn, boardHomeHexToAxial)]).toEqual([TICKER[id], null]);
      expect(c.player_holdings.reduce((sum, h) => sum + h.percentage, 0) + c.ipo_pool_percentage + c.bank_pool_percentage).toBe(100);
    }
    for (const id of [6, 7, 8]) {
      const c = company(s0, id);
      expect([c.is_floated, c.ipo_pool_percentage, c.owned_trains, c.station_token_hexes]).toEqual([false, 100, [], []]);
    }
  });

  it("every dollar of the $12,000 bank is on the table; privates as the opening auction and #660 leave them", () => {
    expect(moneyTotal(s0)).toBe(BANK_SIZE);
    expect(s0.private_companies.map((p) => [p.private_id, p.closed])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
      [6, true],
    ]);
  });

  it("pinned to this engine, Gentle Rust the only variant, NYC at the start of its turn, operating in price order", () => {
    expect(s0.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    expect(RULES_ENGINE_VERSION).toBe(8);
    expect(s0.variants).toEqual(resolveVariants({ gentleRust: true }));
    expect([s0.current_round_type, s0.macro_round_number, s0.sub_round_index, s0.operating_round_sequence_length]).toEqual([
      "OperatingRound",
      3,
      1,
      2,
    ]);
    expect([operating(s0), s0.operating_sub_phase]).toEqual([NYC, "Track"]);
    const prices = s0.active_operating_order.map((id) => s0.market_positions![id]!.price);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
  });

  it("the one tile of the game is laid by the first message, through the ordinary LayTile authority", () => {
    expect(SCRIPT[0].msg).toBe(ALBANY_LAY);
    const room = certificationRoom();
    const answer = room.submit({ actor: "p2", build: "gr4", host: "p1", msg: ALBANY_LAY, baseIndex: -1 }) as { kind: string };
    expect(answer.kind).toBe("applied");
    expect(room.state.operating_sub_phase).not.toBe("Track");
  });
});

/* ================================================================== */
/* G1. The first 4 (2-trains)                                         */
/* ================================================================== */

describe("G1. the first 4 marks every 2-train in play; Final Run turns follow cases A, B and C", () => {
  const TRIGGER = "3.1 PRR buys the FIRST 4";

  it("the purchase that brings the first 4 changes the phase and marks every corporation-held 2 -- the buyer's own as this turn's doom -- and nothing else", () => {
    const before = run.before(TRIGGER);
    const after = rightAfter(TRIGGER);
    expect([derivePhase(before)?.tier, headTier(before), derivePhase(after)?.tier, limitOf(after)]).toEqual(["3", "4", "4", 3]);
    expectEveryCopyMarked(before, after, "2");
    expect([fleetOf(after, PRR), marksOf(after, PRR), doomedOf(after, PRR)]).toEqual([["2", "3", "3", "4"], ["2"], ["2"]]);
    expect([fleetOf(after, NYC), marksOf(after, NYC), doomedOf(after, NYC)]).toEqual([["2", "2", "3"], ["2", "2"], undefined]);
    expect([fleetOf(after, BO), marksOf(after, BO), doomedOf(after, BO)]).toEqual([["2", "2"], ["2", "2"], undefined]);
    expect([fleetOf(after, CO), marksOf(after, CO)]).toEqual([["2"], ["2"]]);
    expect(marksOf(after, CPR)).toEqual([]);
    expect(after.returned_trains).toEqual([]);
  });

  it("the Final Run trains are owned and consume no train-limit slot: PRR owns 4 trains under a limit of 3, owes no discard, and the room ends its Buy Trains at the limit", () => {
    const after = run.at(TRIGGER);
    expect([fleetOf(after, PRR).length, countable(after, PRR), limitOf(after)]).toEqual([4, 3, 3]);
    expect(pendingTrainDiscards(after)).toBeNull();
    const played = run.played.find((entry) => entry.step.label === TRIGGER)!;
    expect(played.entries).toEqual(["BuyHardwareFromPool", "PassTurn*"]);
    // B&O owns only Final Run trains: two owned, zero counted -- and it is not trainless.
    expect([fleetOf(after, BO).length, countable(after, BO)]).toEqual([2, 0]);
    expect(trainObligationFor(after, BO, EMPTY_GRID).owed).toBe(false);
  });

  it("case C (self-trigger): PRR's 2 survives the end of the turn that doomed it -- the doom record is released there -- and stays owned and marked", () => {
    const afterTurn = run.before("3.1 CPR track");
    expect(operating(afterTurn)).toBe(CPR);
    expect([fleetOf(afterTurn, PRR), marksOf(afterTurn, PRR), doomedOf(afterTurn, PRR)]).toEqual([["2", "3", "3", "4"], ["2"], undefined]);
    expect(graceTurnReprieves(company(afterTurn, PRR))).toEqual(["2"]);
  });

  it("case A (rival trigger before the target operated): B&O's grace turn is its later turn in the SAME round; it owns only Final Run trains, runs nothing, and loses both 2s entering Dividends", () => {
    const start = run.before("3.1 B&O grace turn");
    expect([operating(start), start.sub_round_index, start.operating_sub_phase]).toEqual([BO, 1, "Track"]);
    expect([fleetOf(start, BO), marksOf(start, BO), graceTurnReprieves(company(start, BO))]).toEqual([["2", "2"], ["2", "2"], ["2", "2"]]);
    const played = run.played.find((entry) => entry.step.label === "3.1 B&O grace turn")!;
    // The room skipped Tokens and Routes (no earnable route) and forced the $0 withhold: a turn, not a run.
    expect(played.entries).toEqual(["AdvanceOperatingSubPhase", "AdvanceOperatingSubPhase*", "AdvanceOperatingSubPhase*", "DeclareDividends*"]);
    const after = played.after;
    expect([after.operating_sub_phase, fleetOf(after, BO), marksOf(after, BO)]).toEqual(["Hardware", [], []]);
    expect(after.returned_trains).toEqual(start.returned_trains);
    // Now genuinely trainless: the ordinary obligation is asked, and its prerequisite (a route) is absent.
    expect(trainObligationFor(after, BO, EMPTY_GRID)).toEqual({ owed: false, reason: null });
  });

  it("case A again for C&O, the last corporation of the round: its lone 2 is gone at its own Run Routes end", () => {
    const start = run.before("3.1 C&O grace turn");
    expect([fleetOf(start, CO), marksOf(start, CO)]).toEqual([["2"], ["2"]]);
    const after = run.at("3.1 C&O grace turn");
    expect([fleetOf(after, CO), marksOf(after, CO), after.operating_sub_phase]).toEqual([[], [], "Hardware"]);
  });

  it("case B (rival trigger after the target operated): NYC's two 2s survive every later turn of round 3.1 and the round boundary, and go at its first turn of round 3.2", () => {
    for (const label of ["3.1 CPR track", "3.1 B&O grace turn", "3.1 C&O grace turn", "3.2 NYC grace turn"]) {
      const board = run.before(label);
      expect([label, fleetOf(board, NYC), marksOf(board, NYC)]).toEqual([label, ["2", "2", "3"], ["2", "2"]]);
    }
    const start = run.before("3.2 NYC grace turn");
    expect([start.sub_round_index, operating(start), start.operating_sub_phase]).toEqual([2, NYC, "Track"]);
    const after = run.at("3.2 NYC grace turn");
    expect([fleetOf(after, NYC), marksOf(after, NYC)]).toEqual([["3"], []]);
  });
});

/* ================================================================== */
/* G2. The first 5 (phase 5 as needed)                                */
/* ================================================================== */

describe("G2. the first 5: the limit drops to 2, the privates close, and the excess discard never offers a Final Run train", () => {
  const TRIGGER = "3.1 B&O buys the FIRST 5";

  it("phase 5, limit 2, every private closed; three corporations over the limit -- PRR counted on its ordinary trains only", () => {
    const after = run.at(TRIGGER);
    expect([derivePhase(after)?.tier, limitOf(after)]).toEqual(["5", 2]);
    expect(after.private_companies.every((p) => p.closed)).toBe(true);
    const owed = pendingTrainDiscards(after)!;
    expect(owed.queue.map((due) => [due.ticker, due.excess, [...due.choices]])).toEqual([
      ["PRR", 1, ["3", "3", "4"]],
      ["CPR", 1, ["3", "3", "4"]],
      ["B&O", 1, ["4", "4", "5"]],
    ]);
    expect([fleetOf(after, PRR), marksOf(after, PRR)]).toEqual([["2", "3", "3", "4"], ["2"]]);
  });

  it("the president may not discard the Final Run 2 (refused, nothing moves); an ordinary 3 goes to the Bank Pool and the mark stays home", () => {
    const refusedStep = run.played.find((entry) => entry.step.label === "3.1 PRR may not discard its reprieved 2")!;
    expect([refusedStep.kind, refusedStep.reason]).toEqual(["refused", "PRR holds no 2-train it could discard."]);
    expect(stateDigest(refusedStep.after)).toBe(stateDigest(refusedStep.before));
    const discarded = run.at("3.1 PRR discards a 3");
    expect([fleetOf(discarded, PRR), marksOf(discarded, PRR), discarded.returned_trains]).toEqual([["2", "3", "4"], ["2"], ["3"]]);
  });

  it("the other discards are ordinary: CPR's 4 and B&O's phase-turning 5 enter the Bank Pool, the phase stays 5, and the room ends B&O's turn at its limit", () => {
    const after = run.at("3.1 B&O discards its 5");
    expect([fleetOf(after, CPR), fleetOf(after, BO), after.returned_trains]).toEqual([["3", "3"], ["4", "4"], ["3", "4", "5"]]);
    expect(derivePhase(after)?.tier).toBe("5");
    expect(pendingTrainDiscards(after)).toBeNull();
    expect(run.played.find((entry) => entry.step.label === "3.1 B&O discards its 5")!.entries).toEqual(["DiscardTrain", "PassTurn*"]);
  });
});

/* ================================================================== */
/* G3. The first 6 (3-trains)                                         */
/* ================================================================== */

describe("G3. the first 6 marks every 3-train in play and scraps the Bank Pool's", () => {
  const TRIGGER = "3.2 NYC buys the FIRST 6";

  it("every corporation-held 3 is marked -- NYC's own as this turn's doom, CPR's two identical copies twice -- only 3s are added, and the pool's 3 is destroyed with no Final Run", () => {
    const before = run.before(TRIGGER);
    const after = run.at(TRIGGER);
    expect([headTier(before), derivePhase(after)?.tier, limitOf(after)]).toEqual(["6", "6", 2]);
    expectEveryCopyMarked(before, after, "3");
    expect([fleetOf(after, NYC), marksOf(after, NYC), doomedOf(after, NYC)]).toEqual([["3", "6"], ["3"], ["3"]]);
    expect([fleetOf(after, CPR), marksOf(after, CPR)]).toEqual([["3", "3"], ["3", "3"]]);
    expect([before.returned_trains, after.returned_trains]).toEqual([["3", "4", "5"], ["4", "5"]]);
  });

  it("GR-S25 in play: PRR now carries two rust groups -- its self-doomed 2 from the first 4 and a rival-doomed 3 -- both owned, neither counted", () => {
    const after = run.at(TRIGGER);
    expect([fleetOf(after, PRR), marksOf(after, PRR), countable(after, PRR)]).toEqual([["2", "3", "4"], ["2", "3"], 1]);
    const start = run.before("3.2 PRR grace turn");
    expect([operating(start), start.operating_sub_phase, graceTurnReprieves(company(start, PRR))]).toEqual([PRR, "Track", ["2", "3"]]);
  });

  it("both groups expire together at PRR's one qualifying turn -- the end of its Run Routes -- and nothing enters the pool", () => {
    const start = run.before("3.2 PRR grace turn");
    const after = run.at("3.2 PRR grace turn");
    expect([fleetOf(after, PRR), marksOf(after, PRR)]).toEqual([["4"], []]);
    expect(after.returned_trains).toEqual(start.returned_trains);
  });

  it("CPR's two identical 3s (case A) are removed together, exactly two, leaving it trainless", () => {
    const after = run.at("3.2 CPR grace turn");
    expect([fleetOf(after, CPR), marksOf(after, CPR)]).toEqual([[], []]);
  });

  it("case D shape: NYC's self-doomed 3 survives its turn end, the rest of the set and the Stock Round, and is removed at its next Run Routes end", () => {
    const checkpoints = ["3.2 PRR grace turn", "3.2 B&O track", "3.2 C&O track", "4.1 NYC turn"];
    for (const label of checkpoints) {
      const board = run.before(label);
      expect([label, fleetOf(board, NYC), marksOf(board, NYC)]).toEqual([label, ["3", "6", "6"], ["3"]]);
    }
    const srBoard = run.played.find((entry) => entry.step.label.startsWith("SR "))!.before;
    expect([srBoard.current_round_type, fleetOf(srBoard, NYC), marksOf(srBoard, NYC), doomedOf(srBoard, NYC)]).toEqual([
      "StockRound",
      ["3", "6", "6"],
      ["3"],
      undefined,
    ]);
    const after = run.at("4.1 NYC turn");
    expect([fleetOf(after, NYC), marksOf(after, NYC)]).toEqual([["6", "6"], []]);
  });
});

/* ================================================================== */
/* G4. The first D (4-trains)                                         */
/* ================================================================== */

describe("G4. the first D: an ordinary trade-in turns the phase; the 4 it dooms cannot follow it", () => {
  const TRIGGER = "3.2 B&O trades an ordinary 4 for the FIRST D";

  it("before the exchange both of B&O's 4s are ordinary candidates and the $800 trade-in is legal", () => {
    const before = run.before(TRIGGER);
    expect([derivePhase(before)?.tier, fleetOf(before, BO), marksOf(before, BO)]).toEqual(["6", ["4", "4"], []]);
    expect(exchangeableTrains(company(before, BO))).toEqual(["4", "4"]);
    expect(dieselExchangeRefusal(before, BO, "4")).toBeNull();
  });

  it("the exchange turns the phase to D and marks every held 4 -- B&O's remaining 4 as this turn's doom, PRR's (already operated: case B) -- and scraps the pool's 4 and the traded one", () => {
    const before = run.before(TRIGGER);
    const after = run.at(TRIGGER);
    expect([derivePhase(after)?.tier, limitOf(after)]).toEqual(["D", 2]);
    expectEveryCopyMarked(before, after, "4");
    expect([fleetOf(after, BO), marksOf(after, BO), doomedOf(after, BO)]).toEqual([["4", "D"], ["4"], ["4"]]);
    expect([fleetOf(after, PRR), marksOf(after, PRR)]).toEqual([["4"], ["4"]]);
    expect([before.returned_trains, after.returned_trains]).toEqual([["4", "5"], ["5"]]);
    expect(Number(company(after, BO).treasury)).toBe(Number(company(before, BO).treasury) - DIESEL_EXCHANGE_COST);
  });

  it("the Final Run 4 cannot be the trade-in: refused with the Gentle Rust sentence, and the board is untouched", () => {
    const refusedStep = run.played.find((entry) => entry.step.label === "3.2 B&O may not trade in its reprieved 4")!;
    expect([refusedStep.kind, refusedStep.reason]).toEqual([
      "refused",
      "B&O's 4-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.",
    ]);
    expect(stateDigest(refusedStep.after)).toBe(stateDigest(refusedStep.before));
    expect(exchangeableTrains(company(refusedStep.before, BO))).toEqual([]);
  });

  it("every 4 receives its grace and then disappears: PRR's across the Stock Round (case B), B&O's self-doomed one at its next turn (case C)", () => {
    const srBoard = run.played.find((entry) => entry.step.label.startsWith("SR "))!.before;
    expect([fleetOf(srBoard, PRR), marksOf(srBoard, PRR), fleetOf(srBoard, BO), marksOf(srBoard, BO)]).toEqual([["4"], ["4"], ["4", "D"], ["4"]]);
    expect([fleetOf(run.at("4.1 PRR turn"), PRR), marksOf(run.at("4.1 PRR turn"), PRR)]).toEqual([[], []]);
    expect([fleetOf(run.at("4.1 B&O turn"), BO), marksOf(run.at("4.1 B&O turn"), BO)]).toEqual([["D"], []]);
  });
});

/* ================================================================== */
/* G5. Whole-game invariants                                          */
/* ================================================================== */

/** Every board the room passed through, entry by entry (the replay observer's `stateBefore`), plus the final one. */
function everyBoard(entries: readonly { index: number; id: string; actor: string | null; payload: string }[], seed: GameStateResponse) {
  const boards: Array<{ index: number; kind: string; derived: boolean; state: GameStateResponse }> = [];
  const result = replayLog(entries as never, { ...sandboxReplayProviders(), initialGrid: EMPTY_GRID }, { state: seed, waterfall: null }, ({ entry, msg, stateBefore }) => {
    boards.push({ index: entry.index, kind: Object.keys(msg as object)[0], derived: (entry as { derived?: boolean }).derived === true, state: stateBefore });
  });
  return { boards, result };
}

describe("G5. whole-game invariants, on every board of the game", () => {
  it("the progression is exactly the script, and the game ends past every grace turn", () => {
    expect(run.played.filter((entry) => entry.kind === "refused").map((entry) => entry.step.label)).toEqual([
      "3.1 PRR may not discard its reprieved 2",
      "3.2 B&O may not trade in its reprieved 4",
    ]);
    const final = run.room.state;
    expect([final.current_round_type, final.macro_round_number, final.sub_round_index, derivePhase(final)?.tier]).toEqual(["OperatingRound", 4, 2, "D"]);
  });

  it("pending_rust_doomed_this_turn <= pending_rust_trains <= owned_trains (by model and count) on every board -- no mark ever outlives its train", () => {
    const { boards, result } = everyBoard(run.room.entries, certificationStart());
    expect(boards.length).toBe(run.room.entries.length);
    for (const board of boards) expect([board.index, board.kind, marksWithinFleets(board.state)]).toEqual([board.index, board.kind, []]);
    expect(marksWithinFleets(result.state)).toEqual([]);
  });

  it("money is conserved at $12,000 on every board; the only transfers are train purchases", () => {
    const { boards, result } = everyBoard(run.room.entries, certificationStart());
    for (const board of boards) expect([board.index, moneyTotal(board.state)]).toEqual([board.index, BANK_SIZE]);
    expect(moneyTotal(result.state)).toBe(BANK_SIZE);
  });

  it("the train-limit count never includes a Final Run train, and ownership always does: a discard is owed only when the ordinary trains exceed the limit", () => {
    const { boards } = everyBoard(run.room.entries, certificationStart());
    let sawOwnedOverLimitWithoutDebt = false;
    for (const { state, index } of boards) {
      const phase = derivePhase(state)!;
      const owed = pendingTrainDiscards(state);
      for (const id of floatedIds) {
        const c = company(state, id);
        const ordinary = (c.owned_trains ?? []).length - (c.pending_rust_trains ?? []).length;
        expect([index, TICKER[id], countable(state, id)]).toEqual([index, TICKER[id], ordinary]);
        const due = owed?.queue.find((entry) => entry.companyId === id) ?? null;
        expect([index, TICKER[id], due === null ? 0 : due.excess]).toEqual([index, TICKER[id], Math.max(0, ordinary - phase.trainLimit)]);
        if ((c.owned_trains ?? []).length > phase.trainLimit && ordinary <= phase.trainLimit && (c.pending_rust_trains ?? []).length > 0) {
          sawOwnedOverLimitWithoutDebt = true;
        }
        // Ownership: a corporation holding only Final Run trains is never treated as trainless.
        if ((c.owned_trains ?? []).length > 0) expect(trainObligationFor(state, id, EMPTY_GRID).owed).toBe(false);
      }
    }
    expect(sawOwnedOverLimitWithoutDebt).toBe(true);
  });

  it("no expiry ever sends a train to the Bank Pool, and no obsolete tier stays in the pool after its phase", () => {
    const { boards, result } = everyBoard(run.room.entries, certificationStart());
    const states = [...boards.map((b) => b.state), result.state];
    for (let at = 0; at + 1 < states.length; at += 1) {
      const was = states[at];
      const now = states[at + 1];
      const expired = floatedIds.some((id) => marksOf(now, id).length < marksOf(was, id).length && fleetOf(now, id).length < fleetOf(was, id).length);
      if (expired && derivePhase(was)?.tier === derivePhase(now)?.tier) expect(now.returned_trains).toEqual(was.returned_trains);
    }
    const RUSTS: Record<string, string> = { "2": "4", "3": "6", "4": "D" };
    const order = ["2", "3", "4", "5", "6", "D"];
    for (const state of states) {
      const tier = derivePhase(state)!.tier;
      for (const model of state.returned_trains ?? []) {
        const rustsAt = RUSTS[model];
        expect([model, tier, rustsAt === undefined || order.indexOf(tier) < order.indexOf(rustsAt)]).toEqual([model, tier, true]);
      }
    }
  });

  it("the final board holds no 2-, 3- or 4-train anywhere and no mark: nothing obsolete became permanent", () => {
    const final = run.room.state;
    const everywhere = [...final.public_companies.flatMap((c) => c.owned_trains ?? []), ...(final.returned_trains ?? [])];
    expect(everywhere.filter((model) => ["2", "3", "4"].includes(model))).toEqual([]);
    expect(final.public_companies.every((c) => (c.pending_rust_trains ?? []).length === 0 && c.pending_rust_doomed_this_turn === undefined)).toBe(true);
    expect(floatedIds.map((id) => [TICKER[id], fleetOf(final, id)])).toEqual([
      ["NYC", ["6", "6"]],
      ["PRR", []],
      ["CPR", []],
      ["B&O", ["D"]],
      ["C&O", ["5", "5"]],
    ]);
    expect(final.returned_trains).toEqual(["5"]);
  });
});

/* ================================================================== */
/* G6. Standard-rules controls on the game's own boards               */
/* ================================================================== */

describe("G6. CONTROL: the same phase-changing messages on the same boards with Gentle Rust off destroy at once and mark nothing", () => {
  // CONTROL BOARDS: the board the game handed each trigger, turned into the standard game's board at that moment --
  // `variants` switched off, and every train still standing on a Final Run taken out with its mark (a standard game
  // destroyed those at their own phase change). Not part of the progression; each is asked its one message and
  // discarded.
  const standard = (state: GameStateResponse) =>
    ({
      ...state,
      variants: resolveVariants({}),
      public_companies: state.public_companies.map((c) => {
        const owned = [...(c.owned_trains ?? [])];
        for (const model of c.pending_rust_trains ?? []) owned.splice(owned.indexOf(model), 1);
        const { pending_rust_doomed_this_turn: _dropped, ...rest } = c;
        return { ...rest, owned_trains: owned, pending_rust_trains: [] };
      }),
    }) as GameStateResponse;
  const ask = (state: GameStateResponse, msg: SandboxLogMsg, actor: string) =>
    withRules(resolveVariants(state.variants), () => applySandboxAction(state, msg, { actor }));
  const cases: Array<[string, string, string]> = [
    ["3.1 PRR buys the FIRST 4", "2", "p1"],
    ["3.2 NYC buys the FIRST 6", "3", "p2"],
    ["3.2 B&O trades an ordinary 4 for the FIRST D", "4", "p3"],
  ];

  it.each(cases)("%s: every corporation-held %s-train is destroyed at the purchase; no pending field is written; the limit counts the whole fleet", (label, tier, actor) => {
    const step = run.played.find((entry) => entry.step.label === label)!;
    const board = standard(step.before);
    const gentle = step.after;
    const after = ask(board, step.step.msg, actor);
    expect(derivePhase(after)?.tier).toBe(derivePhase(gentle)?.tier);
    for (const id of floatedIds) {
      expect([TICKER[id], copies(fleetOf(after, id), tier)]).toEqual([TICKER[id], 0]);
      expect([TICKER[id], marksOf(after, id), doomedOf(after, id)]).toEqual([TICKER[id], [], undefined]);
      const c = company(after, id);
      expect(countableTrainCount(c.owned_trains, c.pending_rust_trains, c.carcosan_trains)).toBe((c.owned_trains ?? []).length);
    }
    expect((after.returned_trains ?? []).filter((model) => model === tier)).toEqual([]);
    // The Gentle Rust board kept every one of those trains, marked.
    const kept = floatedIds.reduce((n, id) => n + copies(fleetOf(gentle, id), tier), 0);
    expect(kept).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* G7. Deterministic replay                                           */
/* ================================================================== */

describe("G7. the certification game replays deterministically", () => {
  it("replaying the room's own log twice reproduces every intermediate board and the final one, entry by entry", () => {
    const first = everyBoard(run.room.entries, certificationStart());
    const second = everyBoard(run.room.entries, certificationStart());
    const trace = (x: ReturnType<typeof everyBoard>) => x.boards.map((b) => [b.index, b.kind, b.derived, stateDigest(b.state)]);
    expect(trace(second)).toEqual(trace(first));
    expect(stateDigest(first.result.state)).toBe(stateDigest(run.room.state));
    expect(stateDigest(second.result.state)).toBe(stateDigest(run.room.state));
    expect(canonicalJson(first.result.grid)).toBe(canonicalJson(second.result.grid));
    expect(first.result.grid.tiles.length).toBe(1);
    // The board each scripted submission left behind is a board the replay passes through (or its final board).
    const seen = new Set([...first.boards.map((b) => stateDigest(b.state)), stateDigest(first.result.state)]);
    for (const played of run.played) expect([played.step.label, seen.has(stateDigest(played.after))]).toEqual([played.step.label, true]);
  });

  it("a second, independent room given the same starting board and script writes the same log and passes through the same boards", () => {
    const again = runCertificationGame();
    expect(runFingerprint(again)).toEqual(runFingerprint(run));
    const log = (r: CertificationRun) => r.room.entries.map((e) => [e.index, e.actor, e.payload, (e as { derived?: boolean }).derived === true]);
    expect(log(again)).toEqual(log(run));
    expect(stateDigest(again.room.state)).toBe(stateDigest(run.room.state));
    // Fleets, marks, cursor, phase and money facts, spelled out beside the digest.
    const facts = (s: GameStateResponse) => ({
      fleets: s.public_companies.map((c) => [c.ticker, c.owned_trains, c.pending_rust_trains ?? [], c.pending_rust_doomed_this_turn ?? null, c.treasury]),
      pool: s.returned_trains,
      cursor: [s.current_round_type, s.macro_round_number, s.sub_round_index, s.active_corporation_index, s.operating_sub_phase ?? null],
      phase: derivePhase(s)?.tier,
      bank: s.virtual_bank_vgp,
    });
    expect(facts(again.room.state)).toEqual(facts(run.room.state));
  });
});
