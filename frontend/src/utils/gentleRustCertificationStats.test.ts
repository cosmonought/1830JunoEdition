/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1703 / 1704 (harness): U-9 -- A GENTLE RUST TRAIN IS LOST WHEN IT IS DESTROYED
// ==================================================================
//
// OWNER RULING (U-9, 2026-09-24): "U-9 uses DESTRUCTION-TIME accounting. A Gentle Rust train counts as RUSTED / LOST
// for the fleet ledger, Rust Belt and Gravedigger only when the train is actually permanently removed at the end of
// its qualifying Final Run. Merely entering `pending_rust_trains` / Final Run does NOT yet count ... If the game ends
// while the Final Run train still exists in `owned_trains`, that train is KEPT, not both RUSTED and KEPT." It restores
// #1414 ("a rusted train is one that actually left the roster") and #1422 (the Gravedigger SENDS trains to the
// scrapheap; the Rust Belt LOST them). Implemented in `gameHistory.ts` (#1704): the loss is booked at the destruction
// (`describeReprieveExpiries`), charged to the president AT DESTRUCTION, and credited to the player whose purchase
// brought in the tier that rusts the model -- reconstructed from the log, never the destruction entry's own actor.
//
// THE GAME IS GR-4's CONSTRUCTED CERTIFICATION GAME. Who dooms what, and when each copy is destroyed:
//   first 4  (P1, PRR's purchase):  NYC 2,2 (gone 3.2) · B&O 2,2 (3.1) · C&O 2 (3.1) · PRR 2 (3.2)   -- 6 x $80
//   first 6  (P2, NYC's purchase):  PRR 3 (3.2) · CPR 3,3 (3.2) · NYC 3 (4.1)                         -- 4 x $180
//   first D  (P3, B&O's trade-in):  PRR 4 (4.1) · B&O 4 (4.1)                                         -- 2 x $300
// Presidents: P1 PRR and C&O, P2 NYC, P3 CPR and B&O. The history is cut at chosen entries to read the tallies as the
// game stood then -- every cut is a real prefix of the room's log with the room's own boards.
//
// A GAME THAT REACHES THE FIRST D CANNOT BE BUILT FROM A DEFAULT-SEED LOG, so -- as GR-3's
// `gentleRustExchangeStats.test.ts` does -- the history's replay engine is replaced by a script of the real boards
// (produced by the real `RoomSession` below while the script is off). Nothing else in `gameHistory.ts` is stubbed.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

let mockScript: GameStateResponse[] | null = null;

jest.mock("../gameEngine/replayLog", () => {
  const actual = jest.requireActual("../gameEngine/replayLog");
  /* The real engine until a script is installed (the room below needs it); the scripted one after. A constructor
     function returning an object is what `new` hands back, so both callers get the engine they expect. */
  function RoomEngine(this: unknown, ...args: unknown[]) {
    if (mockScript === null) return new actual.RoomEngine(...args);
    return { snapshot: { state: mockScript[0], grid: { game_id: 1, tiles: [] } } };
  }
  function LegacyLogAdapters(this: unknown, ...args: unknown[]) {
    if (mockScript === null) return new actual.LegacyLogAdapters(...args);
    return {
      apply(engine: { snapshot: { state: GameStateResponse; grid: unknown } }, entry: { index: number }) {
        engine.snapshot = { ...engine.snapshot, state: mockScript![entry.index + 1] };
      },
    };
  }
  return { ...actual, RoomEngine, LegacyLogAdapters };
});

const G = require("./gentleRustCertificationGame") as typeof import("./gentleRustCertificationGame");
const S = require("./gentleRustPresentationSupport") as typeof import("./gentleRustPresentationSupport");
const { gameHistoryFrom } = require("./gameHistory") as typeof import("./gameHistory");
const { replayLog } = jest.requireActual("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");

type Entry = { index: number; id: string; actor: string | null; payload: string; derived?: boolean };
type History = ReturnType<typeof gameHistoryFrom>;

/** Every board of the constructed game: `boards[i]` is the board after entry i-1 (`boards[0]` the start). */
function playedGame() {
  mockScript = null;
  const run = G.runCertificationGame();
  const entries: Entry[] = run.room.entries.map((e) => ({ index: e.index, id: e.id, actor: e.actor, payload: e.payload, derived: (e as Entry).derived }));
  const before: GameStateResponse[] = [];
  const result = replayLog(entries as never, { ...sandboxReplayProviders(), initialGrid: G.EMPTY_GRID }, { state: G.certificationStart(), waterfall: null }, ({ stateBefore }) => {
    before.push(stateBefore);
  });
  /** How many log entries exist once the step with this label (and everything the room derived from it) is in. */
  const through = (label: string) => {
    const played = run.played.find((entry) => entry.step.label === label)!;
    return Math.max(...played.indices) + 1;
  };
  return { entries, boards: [...before, result.state], through };
}

function historyOf(entries: Entry[], boards: GameStateResponse[]): History {
  mockScript = boards;
  try {
    return gameHistoryFrom(entries.map((e) => ({ ...e, derived: e.derived === true })) as never);
  } finally {
    mockScript = null;
  }
}

const accolade = (history: History, key: string) => history.accolades.find((entry) => entry.key === key)!;
const top = (history: History, key: string) => [accolade(history, key).holder, accolade(history, key).value, accolade(history, key).runnerUp];
const fates = (history: History, companyId: number, model: string) =>
  history.autopsy.find((row) => row.companyId === companyId)?.fleetLedger.find((row) => row.model === model)?.fates;

describe("U-9 (owner ruling: destruction-time). The obsolescence statistics book a Gentle Rust train when it is destroyed", () => {
  const game = playedGame();
  const cut = (label: string) => {
    const n = game.through(label);
    return historyOf(game.entries.slice(0, n), game.boards.slice(0, n + 1));
  };

  it("MARKING books nothing: straight after the first 4 marked six 2-trains there is no Rust Belt, no Gravedigger, and the ledger has no 'rusted' fate", () => {
    const h = cut("3.1 PRR buys the FIRST 4");
    expect(top(h, "rust-belt")).toEqual([null, 0, null]);
    expect(top(h, "gravedigger")).toEqual([null, 0, null]);
    expect(fates(h, G.PRR, "4")).toMatchObject({ rusted: 0, kept: 1 });
    for (const row of h.autopsy) for (const line of row.fleetLedger) expect([row.ticker, line.model, line.fates.rusted]).toEqual([row.ticker, line.model, 0]);
  });

  it("DESTRUCTION books it: B&O's two 2s leave the roster at its Run Routes end -- the loss is P3's (B&O's president), the credit P1's (who bought the first 4), not the actor of the expiry entry", () => {
    const h = cut("3.1 B&O grace turn");
    const expiryEntry = game.entries[game.through("3.1 B&O grace turn") - 2];
    expect(expiryEntry.actor).not.toBe(G.P1); // the entry that destroyed them was B&O's own turn (P3 / derived)
    expect(top(h, "rust-belt")).toEqual([G.P3, 2 * 80, null]);
    expect(top(h, "gravedigger")).toEqual([G.P1, 2 * 80, null]);
  });

  it("identical copies keep their multiplicity: CPR's two 3s add exactly two losses and two credits", () => {
    const beforeCpr = cut("3.2 PRR ends");
    const afterCpr = cut("3.2 CPR grace turn");
    // P2 (who bought the first 6) is credited PRR's one 3 before CPR's turn, and CPR's two after it.
    expect(top(beforeCpr, "gravedigger")).toEqual([G.P1, 6 * 80, 180]);
    expect(top(afterCpr, "gravedigger")).toEqual([G.P2, 3 * 180, 6 * 80]);
  });

  it("two rust groups destroyed in ONE entry are each credited to their own cause, and a self-trigger's president is both the cause and the victim", () => {
    // PRR's grace turn destroys its 2 (doomed by P1's own first 4 -- a self-trigger) and its 3 (doomed by P2's first
    // 6) in the same entry. By then every 2 is gone: P1 has sent all six; P2 exactly the one 3.
    const h = cut("3.2 PRR grace turn");
    expect(top(h, "gravedigger")).toEqual([G.P1, 6 * 80, 180]);
    // P1 LOST C&O's 2, PRR's own 2 and PRR's 3 -- the same player that sent the 2 to the scrapheap is its victim.
    expect(top(h, "rust-belt")).toEqual([G.P1, 80 + 80 + 180, 2 * 80]);
  });

  it("GAME ENDS DURING GRACE: cut straight after the first D, the doomed 4s (and NYC's 3) are KEPT -- rusted 0, no loss, no credit to the D's buyer", () => {
    const h = cut("3.2 B&O trades an ordinary 4 for the FIRST D");
    expect(fates(h, G.BO, "4")).toMatchObject({ rusted: 0, traded: 1, kept: 1 });
    expect(fates(h, G.PRR, "4")).toMatchObject({ rusted: 0, kept: 1 });
    // Destroyed by now: six 2s (P1's), PRR's 3 and CPR's two 3s (P2's). None of P3's first-D rust has happened.
    expect(top(h, "gravedigger")).toEqual([G.P2, 3 * 180, 6 * 80]);
    expect(top(h, "rust-belt")).toEqual([G.P3, 2 * 80 + 2 * 180, 80 + 80 + 180]);
  });

  it("the finished game: every doomed train was destroyed, so every loss and credit is booked once -- P3 is credited the first D's two 4s only now", () => {
    const h = historyOf(game.entries, game.boards);
    expect(top(h, "gravedigger")).toEqual([G.P2, 4 * 180, 2 * 300]);
    expect(top(h, "rust-belt")).toEqual([G.P3, 2 * 80 + 2 * 180 + 300, 80 + 80 + 180 + 300]);
    expect(fates(h, G.PRR, "4")).toMatchObject({ rusted: 1, kept: 0 });
    expect(fates(h, G.BO, "4")).toMatchObject({ rusted: 1, traded: 1, kept: 0 });
  });

  it("CONTROL: the president's excess discard and the Diesel trade-in never become 'rusted' (the discarded 4 and 5 were bought in this game)", () => {
    const h = historyOf(game.entries, game.boards);
    expect(fates(h, G.CPR, "4")).toMatchObject({ rusted: 0 });
    expect(fates(h, G.BO, "5")).toMatchObject({ rusted: 0 });
    expect(fates(h, G.BO, "4")).toMatchObject({ traded: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* A sale on a Gentle Rust table, and the standard table              */
/* ------------------------------------------------------------------ */

/** Phase 3, every 2 and 3 held: PRR (P1) buys the first 4 -- a real rust -- then buys one of C&O's ordinary 3s (P1
 *  presides over both). The script opens
 *  one board earlier with C&O's trains not yet on its roster and a neutral entry that delivers them, so the ledger
 *  has C&O's rows (GR-3's trick, the only hand-made board here). */
function saleHistory(gentle: boolean) {
  const before = S.board({
    corps: [
      { id: S.PRR, trains: ["2", "2", "3"] },
      { id: S.NYC, trains: ["2", "2", "3", "3"] },
      { id: S.CO, trains: ["2", "2", "3", "3"] },
    ],
    operating: S.PRR,
    gentle,
  });
  if (S.headTier(before) !== "4") throw new Error("saleHistory: the depot's head is not the first 4");
  const rusted = S.send(before, S.BUY(S.PRR));
  const sold = S.send(rusted, S.SALE(S.PRR, S.CO, "3", "150"));
  const seed = {
    ...before,
    public_companies: before.public_companies.map((c) => (c.company_id === S.CO ? { ...c, owned_trains: [] } : c)),
  } as GameStateResponse;
  const entries: Entry[] = [
    { index: 0, id: "u9-seed", actor: S.P1, payload: JSON.stringify({ U9LedgerSeed: {} }) },
    { index: 1, id: "u9-buy", actor: S.P1, payload: JSON.stringify(S.BUY(S.PRR)) },
    { index: 2, id: "u9-sale", actor: S.P1, payload: JSON.stringify(S.SALE(S.PRR, S.CO, "3", "150")) },
  ];
  return { sold, history: historyOf(entries, [seed, before, rusted, sold]) };
}

describe("U-9 controls: a sale stays 'sold'; the standard table still books rust at the purchase", () => {
  it("Gentle Rust: the sold 3 is 'sold'; C&O's two marked 2s are still owned at the end -- KEPT, not rusted -- and nobody has lost or sent a train", () => {
    const { sold, history } = saleHistory(true);
    expect([S.fleetOf(sold, S.CO), S.marksOf(sold, S.CO)]).toEqual([["2", "2", "3"], ["2", "2"]]);
    expect(fates(history, S.CO, "3")).toMatchObject({ sold: 1, rusted: 0, kept: 1 });
    expect(fates(history, S.CO, "2")).toMatchObject({ rusted: 0, kept: 2 });
    expect(top(history, "rust-belt")).toEqual([null, 0, null]);
    expect(top(history, "gravedigger")).toEqual([null, 0, null]);
  });

  it("STANDARD: marking and destruction coincide, so the first 4 books every 2 at once -- the losses to their presidents, the credit to the buyer (unchanged behaviour)", () => {
    const { sold, history } = saleHistory(false);
    expect(S.fleetOf(sold, S.CO)).toEqual(["3"]);
    expect(fates(history, S.CO, "2")).toMatchObject({ rusted: 2, kept: 0 });
    expect(fates(history, S.CO, "3")).toMatchObject({ sold: 1, rusted: 0, kept: 1 });
    // Rusted: PRR 2,2 and C&O 2,2 (P1 presides over both), NYC 2,2 (P2's); all sent by P1's purchase.
    expect(top(history, "gravedigger")).toEqual([S.P1, 6 * 80, null]);
    expect(top(history, "rust-belt")).toEqual([S.P1, 4 * 80, 2 * 80]);
  });
});
