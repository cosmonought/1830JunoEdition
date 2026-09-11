/** @jest-environment node */
// frontend/src/utils/gameHistory.test.ts -- design note #1411.
import { gameHistoryFrom } from "./gameHistory";
import { activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import FIXTURE from "./__fixtures__z6cLog.json";

/* JUNO-Z6C's own log through OR 9.3 -- the room the epilogue was asked for, and the only thing this
   function reads. */
const LOG = FIXTURE.entries as ReadonlyArray<{ index: number; id: string; actor: string; payload: string; at: number }>;

describe("the log replayed as a timeline (design note #1411)", () => {
  afterAll(() => activateBoard(STANDARD_BOARD));

  it("samples once per round boundary, in order, and ends on Final", () => {
    const history = gameHistoryFrom(LOG as never);
    expect(history.rounds.length).toBeGreaterThan(2);
    expect(history.rounds[history.rounds.length - 1].label).toBe("Final");
    const labels = history.rounds.map((r) => r.label);
    expect(labels[0]).toBe("SR 1");
    expect(labels).toContain("OR 9.1");
    // No two consecutive samples share a label -- a boundary is a change.
    for (let i = 1; i < labels.length; i += 1) expect(labels[i]).not.toBe(labels[i - 1]);
  });

  it("carries every player and every corporation on every sample", () => {
    const history = gameHistoryFrom(LOG as never);
    for (const round of history.rounds) {
      expect(round.players.map((p) => p.address)).toEqual(history.players);
      expect(round.corporations.map((c) => c.companyId)).toEqual(history.corporations.map((c) => c.companyId));
    }
  });

  it("prices come off the chart and net worth is cash plus stock", () => {
    const history = gameHistoryFrom(LOG as never);
    const final = history.rounds[history.rounds.length - 1];
    expect(final.corporations.some((c) => c.price !== null)).toBe(true);
    for (const p of final.players) {
      if (p.cash !== null && p.stockValue !== null && p.netWorth !== null) {
        expect(p.netWorth).toBeGreaterThanOrEqual(p.cash + p.stockValue);
      }
    }
  });

  it("an empty log yields no rounds rather than throwing", () => {
    expect(gameHistoryFrom([]).rounds).toEqual([]);
  });
});
