/** @jest-environment node */
// frontend/src/utils/roundReplay.test.ts -- design note #1425.
import { gameHistoryFrom, roundLabelOf } from "./gameHistory";
import { replaySnapshotAtRound, roundEndExclusive } from "./roundReplay";
import { activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import { readStripped } from "./sourceScan";
import FIXTURE from "./__fixtures__z6cLog.json";

const LOG = FIXTURE.entries as never;

describe("the board at the end of a round (design note #1425)", () => {
  afterAll(() => activateBoard(STANDARD_BOARD));
  const history = gameHistoryFrom(LOG);

  it("a round's end is the next round's opening entry, exclusive; the last runs to the end", () => {
    expect(roundEndExclusive(history.rounds, 0)).toBe(history.rounds[1].atIndex);
    expect(roundEndExclusive(history.rounds, history.rounds.length - 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("replays to a board still labelled with that round, and its prices match the next sample's opening", () => {
    const at = history.rounds.findIndex((r) => r.label === "OR 7.2");
    expect(at).toBeGreaterThan(0);
    const snapshot = replaySnapshotAtRound(LOG, history.rounds, at)!;
    expect(snapshot.label).toBe("OR 7.2");
    expect(roundLabelOf(snapshot.state)).toBe("OR 7.2");
    /* The next round's sample was taken one entry later -- the entry that flipped the round, which moves no
       token on the chart -- so the prices agree. */
    const next = history.rounds[at + 1];
    for (const corp of next.corporations) {
      expect(snapshot.state.market_positions?.[corp.companyId]?.price ?? null).toBe(corp.price);
    }
    // And tiles do not un-lay: the grid at OR 7.2 is a subset of the final grid.
    const final = replaySnapshotAtRound(LOG, history.rounds, history.rounds.length - 1)!;
    expect(snapshot.grid.tiles.length).toBeLessThanOrEqual(final.grid.tiles.length);
    expect(final.grid.tiles.length).toBeGreaterThan(snapshot.grid.tiles.length);
  });

  it("the last round is the live board", () => {
    const final = replaySnapshotAtRound(LOG, history.rounds, history.rounds.length - 1)!;
    expect(final.label).toBe("Final");
    const sample = history.rounds[history.rounds.length - 1];
    for (const corp of sample.corporations) {
      expect(final.state.market_positions?.[corp.companyId]?.price ?? null).toBe(corp.price);
    }
  });

  it("an out-of-range round is null", () => {
    expect(replaySnapshotAtRound(LOG, history.rounds, 99)).toBeNull();
  });
});

describe("the shell draws the past and keeps the verdict (design note #1425)", () => {
  const app = readStripped("App.tsx");

  it("swaps the state, grid and waterfall the shell renders", () => {
    expect(app).toContain("const gameState = replaySnapshot?.state ?? liveState;");
    expect(app).toContain("const mapGrid = replaySnapshot?.grid ?? liveMapGrid;");
    expect(app).toContain("const waterfallState = replaySnapshot ? replaySnapshot.waterfall : sandboxWaterfall ?? liveWaterfallState;");
  });

  it("latches the ending and the standings, and makes the past nobody's turn", () => {
    expect(app).toContain("const gameEndReason = scrubbing ? latchedEndReasonRef.current : derivedEndReason;");
    expect(app).toContain("const finalStandings = scrubbing ? latchedStandingsRef.current : derivedStandings;");
    expect(app).toContain("if (scrubbing) return false; // #1425: a past board is nobody's turn");
    expect(app).toContain(") : scrubbing ? (");
  });

  it("mounts the scrubber in the bottom dock above the Activity Log while the modal is down, and clears it with the ending", () => {
    expect(app).toContain("<RoundScrubber rounds={gameHistory.rounds} cursor={replayCursor} onChange={setReplayCursor} />");
    expect(app.indexOf("style={styles.statusLineDock}")).toBeLessThan(app.indexOf("<RoundScrubber"));
    expect(app.indexOf("<RoundScrubber")).toBeLessThan(app.indexOf("<TopTicker"));
    expect(app).toContain("setReplayCursor(null); // #1425");
    const scrubber = readStripped("components/RoundScrubber.tsx");
    expect(scrubber).toContain('type="range"');
    expect(scrubber).toContain("Back to final");
    // #1430: Operating Rounds only -- the stops are ORs and Final.
    expect(scrubber).toContain('round.label.startsWith("OR ") || index === rounds.length - 1');
  });
});
