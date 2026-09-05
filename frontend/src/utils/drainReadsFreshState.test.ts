/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1178 (harness): WHAT A DRAIN DOES TO A CLOSURE
// ==================================================================
//
// REPORTED: "Refreshing the page several times has caused the Activity Log to lose all player information and
// sequence ordering."
//
// ONE CAUSE, TWO HALVES, and it is #1177's cause on the narration side. `runGameplayAction` composed every
// label from `describeContext.gameState` -- the committed React state, captured in its closure -- and stamped
// every line from `roundLabelRef`, which a `useEffect` feeds. Both update when React COMMITS.
//
// A DRAIN COMMITS NOTHING UNTIL IT FINISHES. Playing normally that is invisible, because a drain holds one
// action and the closure's state really is the state before it. A refresh replays the entire log in one
// drain, so action forty is described against the board as it stood before action one -- which is the seeded
// board, with no seats, no presidents and no holdings. Every id-to-person lookup comes back empty (the lost
// "player information") and every line carries the opening round (the lost "sequence ordering", since the
// feed groups on that stamp even though `seq` is intact).
//
// THE FIX IS THE SAME SHAPE AS #1177's: read the ref the drain writes synchronously, not the state React has
// yet to commit. The live chain path keeps `gameState` and `roundLabelRef`, where there is no ref, no drain,
// and an action arrives alone.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");

describe("labels are composed against the board the action actually applied to", () => {
  const CONTEXT = sliceBetween(APP, "const describeContext = {", "orSubPhase,");

  it("takes the sandbox board from the synchronous ref", () => {
    expect(CONTEXT).toContain("gameState: sandbox ? (sandboxStateRef.current ?? gameState) : gameState");
  });

  it("keeps the live path on committed state, where there is no ref to read", () => {
    /* Off the sandbox `sandboxStateRef` is null by construction -- `gameState` is `sandboxState ?? live` --
       so the conditional is the whole of the compatibility, not a hedge. */
    expect(CONTEXT).toContain(": gameState");
    expect(APP).toContain("const gameState = sandboxState ?? liveGameState;");
  });

  it("quotes prices from the same ref the trade used", () => {
    /* Design note #1177: a label that names a price must name the one the reducer charged, or the log
       explains a purchase with a number nobody paid. */
    expect(CONTEXT).toContain("marketPrices: marketPricesFromRef()");
    expect(CONTEXT).not.toContain("marketGrid");
  });
});

describe("the round stamp is taken from the action, not from the last commit", () => {
  const STAMP = sliceBetween(APP, "round:\n          (round ??", "?? undefined,");

  it("derives it at read time from the synchronous ref", () => {
    expect(STAMP).toContain("roundStampFor(sandboxStateRef.current)");
  });

  it("falls back to the committed ref only where there is no sandbox state", () => {
    expect(STAMP).toContain("roundLabelRef.current");
  });

  it("leaves the live chain's own log entries alone", () => {
    /* The spectator notice and the session-key "Broadcasting..." entry are written on the chain path, one at
       a time, with no drain to be stale inside. They keep #343's ref, and that is a decision. */
    expect(APP).toContain("round: roundLabelRef.current ?? undefined,");
  });

  it("still feeds the ref from the effect, because the live path needs it", () => {
    expect(sliceBetween(APP, "const roundLabelRef = useRef", "}, [roundLabel]);")).toContain(
      "roundLabelRef.current = roundLabel;",
    );
  });
});

describe("the drain writes the state ref it now reads", () => {
  it("advances the board ref after each applied action", () => {
    /* THE PRECONDITION FOR ALL OF THE ABOVE. If this ever stops being synchronous, the reads reintroduce the
       bug quietly -- the labels would simply go back to describing an older board. */
    expect(APP).toContain("sandboxStateRef.current = after;");
  });

  it("keeps `seq` as the feed's real ordering, which was never the broken part", () => {
    /* Worth pinning so a future reader does not "fix" ordering by touching the counter: the entries were
       always in order, and it was the ROUND they were grouped under that had collapsed. */
    expect(APP).toContain("seq: id,");
  });
});
