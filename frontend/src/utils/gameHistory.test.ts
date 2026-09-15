/** @jest-environment node */
// frontend/src/utils/gameHistory.test.ts -- design note #1411.
import { gameHistoryFrom } from "./gameHistory";
import { readStripped } from "./sourceScan";
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
    /* Batch 6 (#1550/#1552): this fixture is JUNO-Z6C, a legacy log whose entry 418 declared $180 on a run the
       reducer had priced at $190 (and 428 / 433 the same, $10-$20 short -- the client's figure, not the
       authority's). Version 4 refuses those declarations, the treasuries differ from there, the bank does not
       break where it did, and the log-derived timeline no longer reaches OR 9 before the entries run out. It
       used to assert `toContain("OR 9.1")`; the timeline's SHAPE is what #1411 is about, so that is what is
       asserted -- a divergence reported in the Batch 6 write-up, not absorbed silently. */
    expect(labels).toContain("OR 5.1");
    expect(labels.filter((label) => label.startsWith("OR ")).length).toBeGreaterThan(10);
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
    const empty = gameHistoryFrom([]);
    expect(empty.rounds).toEqual([]);
    expect(empty.autopsy).toEqual([]);
    expect(empty.accolades.every((a) => a.holder === null)).toBe(true);
  });
});

/* ==================================================================
    DESIGN NOTE 1414 (harness): THE TALLIES ARE DIFFS
   ================================================================== */
describe("the accolades and the autopsy, read off the board's diffs (design note #1414)", () => {
  const history = gameHistoryFrom(LOG as never);

  it("names a Robber Baron, a Master of the Line, a Track Boss and a Market Manipulator on a played game", () => {
    const by = Object.fromEntries(history.accolades.map((a) => [a.key, a]));
    for (const key of ["robber-baron", "master-of-the-line", "track-boss", "market-manipulator"]) {
      expect(history.players).toContain(by[key].holder);
      expect(by[key].detail.length).toBeGreaterThan(0);
    }
    expect(by["master-of-the-line"].detail).toMatch(/^\$\d[\d,]* on [A-Z&]+'s \w+-train \(OR \d+\.\d+\)$/);
  });

  it("gives every accolade a holder from the roster, or none", () => {
    for (const a of history.accolades) {
      if (a.holder !== null) expect(history.players).toContain(a.holder);
      else expect(a.detail).toBe("");
    }
  });

  it("the autopsy covers exactly the floated corporations, with lifetime revenue at least the last run's", () => {
    const final = history.rounds[history.rounds.length - 1];
    const floated = final.corporations.filter((c) => c.floated).map((c) => c.companyId);
    expect(history.autopsy.map((c) => c.companyId).sort()).toEqual([...floated].sort());
    for (const corp of history.autopsy) {
      const last = final.corporations.find((c) => c.companyId === corp.companyId)!;
      expect(corp.lifetimeRevenue).toBeGreaterThanOrEqual(last.revenue);
      expect(corp.floatRound).not.toBeNull();
      expect(corp.treasury).toBe(last.treasury);
      expect(corp.fleet).toEqual(last.trains);
    }
  });

  it("a player's equity by corporation sums to their stock value", () => {
    for (const round of history.rounds) {
      for (const p of round.players) {
        expect(p.equity.reduce((sum, [, v]) => sum + v, 0)).toBe(p.stockValue);
      }
    }
  });

  it("samples carry the phase, and it never goes backwards", () => {
    const order = ["2", "3", "4", "5", "6", "7", "D"];
    let at = -1;
    for (const round of history.rounds) {
      if (round.phase === null) continue;
      const here = order.indexOf(round.phase);
      expect(here).toBeGreaterThanOrEqual(at);
      at = here;
    }
  });
});

describe("the fleet ledger behind a click (design note #1431)", () => {
  it("every corporation carries a payback and a ledger whose rows add up to its train spend", () => {
    const history = gameHistoryFrom(LOG as never);
    for (const corp of history.autopsy) {
      expect(typeof corp.payback).toBe("number");
      for (const row of corp.fleetLedger) {
        const fates = Object.values(row.fates).reduce((a, b) => a + b, 0);
        expect(fates).toBe(row.count);
        expect(row.paid).toBeGreaterThanOrEqual(0);
        expect(row.earned).toBeGreaterThanOrEqual(0);
      }
      const paid = corp.fleetLedger.reduce((a, r) => a + r.paid, 0);
      const earned = corp.fleetLedger.reduce((a, r) => a + r.earned, 0);
      expect(corp.payback).toBe(earned - paid);
    }
    expect(history.autopsy.some((c) => c.fleetLedger.length > 0)).toBe(true);
  });

  it("the autopsy table opens a ledger on click", () => {
    const src = readStripped("components/EpilogueCharts.tsx");
    expect(src).toContain("autopsy-ledger-");
    expect(src).toContain("aria-expanded={isOpen}");
    expect(src).toContain("ROI"); // #1436: the Payback column went; the ledger's Net is ROI
  });
});

describe("dividends per player per round (design note #1434)", () => {
  it("each OR sample carries what each player was paid in it, and the rounds add up to the Robber Baron's figure", () => {
    const history = gameHistoryFrom(LOG as never);
    const ors = history.rounds.filter((r) => r.label.startsWith("OR "));
    for (const address of history.players) {
      const sum = ors.reduce((a, r) => a + (r.players.find((p) => p.address === address)?.dividends ?? 0), 0);
      const baron = history.accolades.find((a) => a.key === "robber-baron")!;
      if (baron.holder === address) expect(sum).toBe(baron.value);
    }
    // Somebody was paid something in some round.
    expect(ors.some((r) => r.players.some((p) => p.dividends > 0))).toBe(true);
    // Stock Rounds pay nothing.
    for (const r of history.rounds.filter((r) => r.label.startsWith("SR "))) {
      for (const p of r.players) expect(p.dividends).toBe(0);
    }
  });
});
