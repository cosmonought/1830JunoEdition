/** @jest-environment node */
// frontend/src/utils/roundReplay.test.ts -- design note #1425.
import { gameHistoryFrom, roundLabelOf } from "./gameHistory";
import { replaySnapshotAtRound, roundEndExclusive } from "./roundReplay";
import { activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import { readStripped } from "./sourceScan";
import { readFileSync } from "fs";
import { join } from "path";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";

/* Batch 7.5: the completed game these cases replay is the frozen golden copy of JUNO-CV4. JUNO-Z6C's log -- the
   fixture they were written on -- no longer reaches a completed game under rules engine version 5 (it freezes at
   index 33 behind the home-token hold; characterized in `gameHistory.test.ts`), and a board frozen in SR 1 has no
   Operating Round to scrub to. The round below was Z6C's OR 7.2; CV4's OR 4.1 has the same shape -- an Operating
   Round whose next sample opens a Stock Round, with tiles still to be laid after it.
   Slice 8.2 (#1614a): CV4 is a legacy log whose home placements sit in Stock Rounds, so the history and every scrubbed
   board below are read under the development corpus's policy, named at each call -- the same value on both sides, as
   `replaySnapshotAtRound` requires. Measured: the OR 4.1 and Final boards are identical to the pre-8.2 replay's; the
   ends of SR 1 and SR 3 differ only in that B&O's and C&O's homes are not on the board until their first turns. */
const LOG = readFileSync(join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line)) as never;

describe("the board at the end of a round (design note #1425)", () => {
  afterAll(() => activateBoard(STANDARD_BOARD));
  const history = gameHistoryFrom(LOG, DEVELOPMENT_CORPUS_POLICY);

  it("a round's end is the next round's opening entry, exclusive; the last runs to the end", () => {
    expect(roundEndExclusive(history.rounds, 0)).toBe(history.rounds[1].atIndex);
    expect(roundEndExclusive(history.rounds, history.rounds.length - 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("replays to a board still labelled with that round, and its prices match the next sample's opening", () => {
    const at = history.rounds.findIndex((r) => r.label === "OR 4.1");
    expect(at).toBeGreaterThan(0);
    const snapshot = replaySnapshotAtRound(LOG, history.rounds, at, DEVELOPMENT_CORPUS_POLICY)!;
    expect(snapshot.label).toBe("OR 4.1");
    expect(roundLabelOf(snapshot.state)).toBe("OR 4.1");
    /* The next round's sample was taken one entry later -- the entry that flipped the round, which moves no
       token on the chart -- so the prices agree. */
    const next = history.rounds[at + 1];
    for (const corp of next.corporations) {
      expect(snapshot.state.market_positions?.[corp.companyId]?.price ?? null).toBe(corp.price);
    }
    // And tiles do not un-lay: the grid at OR 4.1 is a subset of the final grid.
    const final = replaySnapshotAtRound(LOG, history.rounds, history.rounds.length - 1, DEVELOPMENT_CORPUS_POLICY)!;
    expect(snapshot.grid.tiles.length).toBeLessThanOrEqual(final.grid.tiles.length);
    expect(final.grid.tiles.length).toBeGreaterThan(snapshot.grid.tiles.length);
  });

  it("the last round is the live board", () => {
    const final = replaySnapshotAtRound(LOG, history.rounds, history.rounds.length - 1, DEVELOPMENT_CORPUS_POLICY)!;
    expect(final.label).toBe("Final");
    const sample = history.rounds[history.rounds.length - 1];
    for (const corp of sample.corporations) {
      expect(final.state.market_positions?.[corp.companyId]?.price ?? null).toBe(corp.price);
    }
  });

  it("an out-of-range round is null", () => {
    expect(replaySnapshotAtRound(LOG, history.rounds, 99, DEVELOPMENT_CORPUS_POLICY)).toBeNull();
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
