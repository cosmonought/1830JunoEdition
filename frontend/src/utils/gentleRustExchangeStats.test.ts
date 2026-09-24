/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1702 (harness): U-6's STATISTICS HALF -- THE NARRATOR MOVED, THE TALLIES DID NOT
// ==================================================================
//
// `gameHistory.ts` reads "trains rusted or discarded to the limit" (the Gravedigger, the Rust Belt, the fleet
// ledger's fates) off the same fleet-loss diff the notices use, and used to take a Diesel trade-in's model back out
// of it ("it left the roster, but nobody scrapped it"). GR-3 takes the trade-in out of the diff itself (U-6), so the
// history no longer takes it out a second time -- which on a standard table would have removed a 4 that really
// rusted beside it -- and records the traded train's fate from the message instead.
//
// WHAT MUST NOT MOVE: every scrap tally (trains lost / sent, count and value). WHAT MOVES, deliberately and only
// here: the fleet ledger's fate for a train traded in for the FIRST Diesel on a standard table, which the old diff
// filed as "rusted" (the U-6 defect, in the ledger) and is "traded". Under Gentle Rust the old diff already filed it
// as "traded", and that is unchanged.
//
// OWNER RULING U-9 (2026-09-24, #1704) SUPERSEDES THE GENTLE RUST HALF OF THIS FILE'S ORIGINAL EXPECTATION: under Gentle
// Rust a marked (Final Run) train is not a loss until its Final Run removes it, so the Gentle Rust case below now books
// no loss and no "rusted" fate for the 4s the first Diesel doomed -- they are "kept". The standard case is unchanged.
//
// A GAME THAT REACHES THE FIRST DIESEL CANNOT BE BUILT FROM A LOG IN A TEST, so the replay engine is replaced by a
// script: the history is handed the real reducer's boards, before and after one real `ExchangeTrainForDiesel`, and
// runs its own tallies over them exactly as it does over a replay. Nothing else in `gameHistory.ts` is stubbed.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

let mockScript: GameStateResponse[] = [];

jest.mock("../gameEngine/replayLog", () => {
  const actual = jest.requireActual("../gameEngine/replayLog");
  class RoomEngine {
    snapshot: { state: GameStateResponse; grid: unknown };
    constructor() {
      this.snapshot = { state: mockScript[0], grid: { game_id: 1, tiles: [] } };
    }
  }
  class LegacyLogAdapters {
    apply(engine: RoomEngine, entry: { index: number }) {
      engine.snapshot = { ...engine.snapshot, state: mockScript[entry.index + 1] };
    }
  }
  return { ...actual, RoomEngine, LegacyLogAdapters };
});

const S = require("./gentleRustPresentationSupport") as typeof import("./gentleRustPresentationSupport");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");
const { depotCostFor } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { PRR, NYC, BO, P1, board, send, EXCHANGE, fleetOf } = S;

/** Phase 6, both 6s out, the Diesel for sale; PRR (P1) holds two 4s, B&O (P3) one. PRR trades a 4 in for the
 *  first D: one 4 leaves by the exchange, the other rusts (standard) or is marked (Gentle Rust), and so does B&O's. */
function historyOfFirstDieselTradeIn(gentle: boolean) {
  const before = board({
    corps: [{ id: PRR, trains: ["4", "4"] }, { id: NYC, trains: ["6", "6"] }, { id: BO, trains: ["4"] }],
    operating: PRR,
    gentle,
  });
  const msg = EXCHANGE(PRR, "4");
  const after = send(before, msg);
  /* The fleet ledger lists a model the corporation ACQUIRED during the game (or still holds), so the script opens
     one board earlier, with PRR's and B&O's 4s not yet on their rosters, and a neutral entry that delivers them -- the only
     hand-made board here, and it exists only to give the ledger its 4-train row. */
  const seed = {
    ...before,
    public_companies: before.public_companies.map((c) => (c.company_id === PRR || c.company_id === BO ? { ...c, owned_trains: [] } : c)),
  } as GameStateResponse;
  mockScript = [seed, before, after];
  const history = gameHistoryFrom([
    { index: 0, id: "gr3-seed", actor: P1, derived: false, payload: JSON.stringify({ Gr3LedgerSeed: {} }) },
    { index: 1, id: "gr3-exchange", actor: P1, derived: false, payload: JSON.stringify(msg) },
  ]);
  return { before, after, history };
}

const ledger = (history: ReturnType<typeof gameHistoryFrom>, companyId: number, model: string) =>
  history.autopsy.find((row) => row.companyId === companyId)?.fleetLedger.find((row) => row.model === model)?.fates;
const accolade = (history: ReturnType<typeof gameHistoryFrom>, key: string) =>
  history.accolades.find((entry) => entry.key === key)!;

describe("U-6 statistics: a Diesel trade-in taken out of the fleet-loss diff", () => {
  it("standard: the scrap tallies are what they were; the traded 4's ledger fate is 'traded', not 'rusted'", () => {
    const { before, after, history } = historyOfFirstDieselTradeIn(false);
    expect(fleetOf(after, PRR)).toEqual(["D"]);
    const four = depotCostFor(before, "4");
    // Trains lost: P1 one 4 (the one that rusted -- not the one traded), P3 one 4. Sent: P1 dispatched both rusts.
    // These are the pre-GR-3 figures too: the old diff read two rusted 4s at PRR and took the traded one back out.
    expect([accolade(history, "rust-belt").holder, accolade(history, "rust-belt").value, accolade(history, "rust-belt").runnerUp]).toEqual([
      expect.any(String),
      four,
      four,
    ]);
    expect([accolade(history, "gravedigger").holder, accolade(history, "gravedigger").value]).toEqual([P1, 2 * four]);
    // The ledger: one 4 rusted and one traded (was: two "rusted"); B&O's 4 rusted.
    expect(ledger(history, PRR, "4")).toMatchObject({ rusted: 1, traded: 1, discarded: 0 });
    expect(ledger(history, BO, "4")).toMatchObject({ rusted: 1, traded: 0 });
  });

  it("Gentle Rust (owner ruling U-9, #1704): the trade-in is 'traded'; the 4s the Diesel doomed are still owned -- KEPT, not yet rusted -- and nobody has lost or sent a train", () => {
    const { after, history } = historyOfFirstDieselTradeIn(true);
    expect([fleetOf(after, PRR), after.public_companies.find((c) => c.company_id === PRR)?.pending_rust_trains]).toEqual([
      ["4", "D"],
      ["4"],
    ]);
    /* Superseded expectation (GR-3): "the reprieve is the rust" -- the marks were booked as losses at the phase change.
       The owner ruled destruction-time accounting: a Final Run train is lost only when its Final Run removes it, so a
       history that ends here books no loss, and the destruction case is `gentleRustCertificationStats.test.ts`. */
    expect([accolade(history, "rust-belt").holder, accolade(history, "rust-belt").value]).toEqual([null, 0]);
    expect([accolade(history, "gravedigger").holder, accolade(history, "gravedigger").value]).toEqual([null, 0]);
    expect(ledger(history, PRR, "4")).toMatchObject({ rusted: 0, traded: 1, discarded: 0, kept: 1 });
    expect(ledger(history, BO, "4")).toMatchObject({ rusted: 0, traded: 0, kept: 1 });
  });

  it("a refused trade-in records no fate", () => {
    const before = board({ corps: [{ id: PRR, trains: ["4"] }, { id: NYC, trains: ["5"] }], operating: PRR });
    mockScript = [before, before];
    const history = gameHistoryFrom([{ index: 0, id: "gr3-refused", actor: P1, derived: false, payload: JSON.stringify(EXCHANGE(PRR, "4")) }]);
    expect(ledger(history, PRR, "4")).toMatchObject({ rusted: 0, traded: 0, discarded: 0, kept: 1 });
  });
});
