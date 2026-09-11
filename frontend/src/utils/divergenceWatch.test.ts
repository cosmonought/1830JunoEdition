/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1223 (harness): AN ALARM IS ONLY WORTH ITS FALSE-POSITIVE RATE
// ==================================================================
//
// The rule this file protects is not "detect a mismatch" -- comparing two strings needs no test. It is
// WHEN THE PLAYER IS TOLD, and every case below is a case where telling them would be wrong:
//
//   a frame with no digest (the Firestore path) claims nothing;
//   a mismatch before the two sides have ever agreed is this mechanism's fault, not the room's;
//   a mismatch already reported is not news after every subsequent action;
//   an agreement re-arms, because a client that resynced and drifted again has something new to say.
//
// THE ONE THAT MATTERS MOST IS THE THIRD. A diverged client stays diverged until it reloads, so an alarm
// without suppression puts the same sentence on screen after every action in the game -- which trains the
// player to ignore it and buries the message that mattered.

export {};

const { divergenceVerdict, divergenceMessage } =
  require("./divergenceWatch") as typeof import("./divergenceWatch");

const AGREED = "aaaaaaaaaaaaaaaa";
const DRIFTED = "bbbbbbbbbbbbbbbb";

const verdict = (over: Partial<Parameters<typeof divergenceVerdict>[0]> = {}) =>
  divergenceVerdict({
    serverDigest: AGREED,
    clientDigest: AGREED,
    appliedIndex: 12,
    reportedAt: null,
    everAgreed: true,
    ...over,
  });

describe("silence, where a report would be wrong", () => {
  it("says nothing when the frame carried no digest", () => {
    /* #232: absent is not equal and it is not different. The Firestore path has no server to disagree with,
       and an alarm that fires without evidence is an alarm that gets turned off. */
    const answer = verdict({ serverDigest: null, clientDigest: DRIFTED });
    expect(answer.diverged).toBe(false);
    expect(answer.message).toBeNull();
    expect(answer.note).toBeNull();
  });

  it("keeps the arming state across a digest-less frame", () => {
    // A frame that says nothing must not clear a divergence already reported, or the next one repeats it.
    expect(verdict({ serverDigest: null, reportedAt: 9 }).reportedAt).toBe(9);
  });

  it("does not tell the player about a mismatch before the two sides have ever agreed", () => {
    /* THE FAILURE MODE THAT WOULD HAVE KILLED THIS FEATURE. If the two halves differ systemically -- a seed,
       a field one carries and the other does not -- every settle point would put a reload prompt on screen,
       from the first action, forever. That is a bug in the comparison and it belongs in the console. */
    const answer = verdict({ clientDigest: DRIFTED, everAgreed: false });
    expect(answer.diverged).toBe(true);
    expect(answer.message).toBeNull();
    expect(answer.note).toContain("not agreed on the board at any point");
    expect(answer.everAgreed).toBe(false);
  });

  it("notes that case once rather than on every settle", () => {
    const answer = verdict({ clientDigest: DRIFTED, everAgreed: false, reportedAt: 4 });
    expect(answer.note).toBeNull();
  });

  it("does not repeat itself after a divergence already reported", () => {
    const answer = verdict({ clientDigest: DRIFTED, reportedAt: 7 });
    expect(answer.diverged).toBe(true);
    expect(answer.message).toBeNull();
    expect(answer.reportedAt).toBe(7);
  });
});

describe("the seeds the alarm compares, #1224", () => {
  /* THE ALARM'S FIRST RUN FOUND THIS, and it is the case worth pinning hardest: the two halves seeded
     DIFFERENT BOARDS before a single action was played. `RoomEngine`'s constructor puts the chart on the
     state (#1197); the shell put the same chart in a ref and left the state's field absent. Same values,
     different addresses -- so every screen was right, every rule that read the ref was right, and the two
     boards could never hash alike no matter how faithfully either replayed the log. */
  const S = require("./sandboxState") as typeof import("./sandboxState");
  const { withEmptyRoster, waterfallForRoster } =
    require("./gameSetup") as typeof import("./gameSetup");
  const { stateDigest } = require("./stateDigest") as typeof import("./stateDigest");
  const { RoomEngine } = require("./replayLog") as typeof import("./replayLog");
  const { sandboxReplayProviders } =
    require("./replayProviders") as typeof import("./replayProviders");
  const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

  const SCENARIO = S.DEFAULT_SANDBOX_SCENARIO;

  it("hash the same board once the chart is on both", () => {
    const providers = sandboxReplayProviders();
    const board = withEmptyRoster(S.sandboxScenarioState(SCENARIO, 0, "default"));
    const engine = new RoomEngine(providers, {
      state: board,
      waterfall: waterfallForRoster(
        S.sandboxWaterfallState(S.sandboxScenario(SCENARIO).phase, 0, true),
        [],
      ),
    });
    /* The shape the shell now produces, reproduced here rather than imported: `App.tsx` cannot be called
       from a test, so this asserts the CONTRACT the shell has to meet, and the source scan below asserts
       that it meets it. */
    /* #1340: and the auction atom, which the engine has always carried on its state and the shell now seeds
       through the same helper (`withSeededChart`), as a room's empty-roster auction. */
    const shellSeed = {
      ...board,
      market_positions: providers.initialMarket,
      waterfall: waterfallForRoster(S.sandboxWaterfallState(S.sandboxScenario(SCENARIO).phase, 0, true), []),
    };
    expect(stateDigest(shellSeed)).toBe(stateDigest(engine.snapshot.state));
  });

  it("and differ without it, which is the bug this pins", () => {
    /* THE NEGATIVE CASE IS THE POINT. Without it the assertion above would still pass on a build where the
       engine had ALSO stopped seeding the chart -- two wrongs hashing alike. */
    const providers = sandboxReplayProviders();
    const board = withEmptyRoster(S.sandboxScenarioState(SCENARIO, 0, "default"));
    const engine = new RoomEngine(providers, {
      state: board,
      waterfall: waterfallForRoster(
        S.sandboxWaterfallState(S.sandboxScenario(SCENARIO).phase, 0, true),
        [],
      ),
    });
    expect(stateDigest(board)).not.toBe(stateDigest(engine.snapshot.state));
  });

  it("the shell seeds through one helper at every seed site", () => {
    /* THREE SITES: the state initialiser, the ref initialiser, and `rebuildSandbox` (through
       `seedSandboxState`). A fourth copy of the expression is how the last one drifted, so the count is
       what is asserted rather than the presence. */
    const APP = readStripped("App.tsx");
    expect(APP).toContain("function withSeededChart(");
    expect(APP).toContain("waterfall: room ? waterfallForRoster(auction, []) : auction,");
    const uses = APP.split("withSeededChart(").length - 1;
    // One declaration plus three call sites.
    expect(uses).toBeGreaterThanOrEqual(4);
  });
});

describe("the report itself", () => {
  it("tells the player once, naming where and what to do", () => {
    const answer = verdict({ clientDigest: DRIFTED, appliedIndex: 41 });
    expect(answer.message).toBe(divergenceMessage(41));
    expect(answer.message).toContain("41");
    /* THE INSTRUCTION HAS TO BE THE ONE THAT WORKS. The log is the game (#522), so a reloading client
       replays from index 0 and arrives at whatever the room actually holds. */
    expect(answer.message).toContain("Reload");
    expect(answer.reportedAt).toBe(41);
  });

  it("re-arms on agreement, so a second drift is reported too", () => {
    const settled = verdict({ reportedAt: 41 });
    expect(settled.diverged).toBe(false);
    expect(settled.reportedAt).toBeNull();
    expect(settled.everAgreed).toBe(true);

    const again = verdict({ clientDigest: DRIFTED, appliedIndex: 60, reportedAt: settled.reportedAt });
    expect(again.message).toContain("60");
  });

  it("records the first agreement, which is what unlocks reporting at all", () => {
    expect(verdict({ everAgreed: false }).everAgreed).toBe(true);
  });

  it("treats an empty-string digest as absent rather than as a value", () => {
    /* The fan-out fills `digest` with `""` when the submitter's answer carried none (`gameServer.ts`), so
       this is a real frame and not a hypothetical. Comparing against it would report every watcher in the
       room as diverged. */
    expect(verdict({ serverDigest: "", clientDigest: DRIFTED }).diverged).toBe(false);
  });
});
