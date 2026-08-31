/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 868 (harness): GOOD NEWS ARRIVES, IT IS NOT COUNTED DOWN TO
// ==================================================================
//
// SPECIFIED: "the meaningful era change information (Green Tiles are now available, Brown Tiles are now
// available) could be a toast notification to every player when the threshold is crossed. The Rust and Limit
// warnings restrict what players can do, the Era change expands their repertoires."
//
// THE ERA TABLE IS THE PRECONDITION, so it is checked first: a toast fires on a CHANGE, and the set of
// changes is a property of `TIER_PRESENTATION`. Two toasts in an 1830 game, not five.

import { tierEra } from "./gamePhase";
import type { TrainTier } from "./gamePhase";

const TIERS: readonly TrainTier[] = ["2", "3", "4", "5", "6", "D"];

/* ==================================================================
    DESIGN NOTE 1096: THIS FILE'S OWN READER MADE IT INVISIBLE TO THE SWEEP
   ==================================================================
   IT ROLLED ITS OWN `read()` AND STRIPPED COMMENTS BY HAND, which is exactly what `readStripped` does. That
   looked harmless and was not: `sourceScanSweep.js` finds assertions by locating `const X = readStripped(...)`
   declarations, so a file that reads source any other way is not merely unchecked -- it is not even COUNTED
   in the sweep's own "not checked" total. Four cases in this file went stale when #1094 moved the era toast
   out of its render effect, and the sweep reported a clean run over the whole suite while they sat red.
   FOUND BY THE RUNNER, which is the tool of last resort and the one this project keeps trying to stop needing.
   THE SWEEP NOW WARNS about any test file that reads source by hand, so the next one names itself.
   THE WRAPPER WAS NOT ENOUGH EITHER, and that is the second half of the lesson. The first fix kept a local
   `read()` that CALLED `readStripped` -- which removed the hand-rolled reader and therefore removed the
   warning, while leaving `const CODE = read("App.tsx")` unmatched by the sweep's declaration pattern. The
   file went from visibly-unchecked to invisibly-unchecked, which is worse than where it started. THE
   DECLARATION ITSELF has to be the recognised form, not a call that eventually reaches it. */
const { readStripped, anchorIndex, sliceBetween } =
  require("./sourceScan") as typeof import("./sourceScan");

describe("the era changes exactly twice", () => {
  it("turns at 2 to 3 and at 4 to 5, and nowhere else", () => {
    /* THE WHOLE REASON A TOAST IS THE RIGHT SURFACE: it fires twice in a game, which is rare enough to be an
       event and frequent enough to matter. A badge counting down to it would be on screen for a large share
       of the game saying something a player can do nothing about. */
    const turns = TIERS.slice(1)
      .map((tier, index) => [TIERS[index], tier] as const)
      .filter(([from, to]) => tierEra(from) !== tierEra(to))
      .map(([from, to]) => `${from}->${to}`);
    expect(turns).toEqual(["2->3", "4->5"]);
  });

  it("keeps Diesel inside Brown", () => {
    // #612: the era names a TILE COLOUR and there is no diesel-coloured tile.
    expect(tierEra("D")).toBe("Brown");
    expect(tierEra("6")).toBe("Brown");
  });
});

describe("the shell announces it once, when it lands", () => {
  /* Design note #1096: `readStripped`, so the sweep can resolve this and check every anchor below. */
  const CODE = readStripped("App.tsx");

  it("says what became possible, in the present tense", () => {
    /* ==================================================================
        SUPERSEDED BY #966, AND THIS CASE HAD BEEN RED EVER SINCE
       ==================================================================
       IT ASSERTED "`${eraNow} Tiles are now available.`" -- #868's sentence, near enough to quote the
       original report. RULED SINCE: "The current era change toast has too much text. Change the copy to
       simply read: 'Corporations can now upgrade yellow tiles to green.'"
       THE COPY CHANGED AND THIS DID NOT, so a suite has been failing on the old wording in a file the copy
       batch had no reason to open. A test enforcing the sentence a ruling replaced is the same shape as a
       test enforcing a bug, and it is worth naming as such rather than quietly editing the string.
       WHAT SURVIVES IS THE PROPERTY, not the words: the toast is in the PRESENT TENSE, because it fires at
       the moment the thing becomes true -- which is the difference between this and the badge it replaced --
       and it is DERIVED FROM THE TRANSITION rather than written per era, so the Brown and Grey crossings
       read the same way without a table of four sentences. Both halves are asserted. */
    /* ==================================================================
        DESIGN NOTE 1096: THE VARIABLES CHANGED WHEN THE TOAST MOVED HOUSE
       ==================================================================
       #1094 TOOK THIS OUT OF A RENDER EFFECT. The effect held the previous era in a ref and compared it to a
       derived `eraNow`, and its replay guard could never fire -- `replayingHistory` is cleared before any
       effect runs -- so a refresh re-announced every era crossing the rebuild walked through. It is derived
       from the dispatch's `before`/`after` now, hence `from` and `to`.
       #966'S COPY RULING IS UNTOUCHED, which is what this case is actually about. */
    const dollar = String.fromCharCode(36);
    expect(CODE).toContain(
      "`Corporations can now upgrade " +
        dollar +
        "{from.toLowerCase()} tiles to " +
        dollar +
        "{to.toLowerCase()}.`",
    );
    /* THE SENTENCE IT REPLACED, as an absence: leaving both would toast twice on one crossing, which is the
       plausible half-done state for a copy change made at one of two call sites. */
    expect(CODE).not.toContain("Tiles are now available");
  });

  it("fires on a CHANGE, never on the first thing it sees", () => {
    /* ==================================================================
        DESIGN NOTE 1096: THE SUBTLETY SURVIVED; THE MECHANISM THAT CARRIED IT DID NOT
       ==================================================================
       THIS CASE PINNED A REF AND A GUARD -- "the ref starts empty and the era is simply whatever it already
       is". The reasoning was right and the implementation could not deliver it: a `useEffect` sees every
       intermediate commit of a rebuild, so on a refresh the ref went empty -> Yellow -> Green -> Brown and
       announced each step to somebody who has been laying brown tiles for an hour. Exactly what this case
       said must not happen, passing the whole time.
       THE PROPERTY IS NOW STRUCTURAL rather than a ref discipline: two states, one comparison, and no stored
       previous to be stale. There is nothing to write before a guard because there is nothing stored. */
    expect(CODE).toContain("const eraBefore = derivePhase(before)?.tier;");
    expect(CODE).toContain("if (from !== null && to !== null && from !== to)");
    expect(CODE).not.toContain("lastEraRef");
    /* AND THE COMPARISON HAPPENS INSIDE THE REPLAY GUARD, which is the half the effect could not reach.
       `anchorIndex` rather than `indexOf` (#1090): a rotted anchor throws instead of comparing against -1,
       which is how this file reported "Expected: > -1" rather than naming what had gone. */
    const guard = anchorIndex(CODE, "if (before !== null && !replayingHistory) {");
    expect(anchorIndex(CODE, "const eraBefore = derivePhase(before)?.tier;")).toBeGreaterThan(guard);
  });

  it("reaches every player rather than only the buyer", () => {
    /* `showDividendToast` on #738's own distinction: `showActionToast` is a receipt for YOUR dispatch, this
       is a notification about a change in the world. Every client derives the era from the same state, so
       every client fires its own. */
    /* Design note #1096: AND THE GUARD IS `replayingHistory`, NOT `options?.isRemoteReplay`. That is what
       makes "every player" true: the round-transition line beside this one suppresses itself on remote
       clients because it is a receipt for a transition the local client drove, and a live action arriving
       from another browser IS a crossing that just happened. `isRemoteReplay` cannot tell that from a
       rebuild; `replayingHistory` is exactly that distinction. */
    /* ==================================================================
        DESIGN NOTE 1096a: A FIXED WINDOW, FOUR CASES BELOW THE NOTE WARNING ABOUT ONE
       ==================================================================
       THE FIRST DRAFT WAS `CODE.slice(at, at + 900)` AND IT FAILED on `not.toContain("isRemoteReplay")` --
       because 900 characters overran the era block entirely and landed in the ROUND-TRANSITION block that
       follows it, where `isRemoteReplay` is correct and load-bearing. The assertion was reading a region it
       was not about.
       AND THIS FILE ALREADY SAYS SO, in the last case of this describe: "a fixed-length window is a hidden
       assumption about how long a signature is allowed to get, and it fails on a change that has nothing to
       do with the property being asserted." I read that note while editing this file and then wrote the
       mistake it describes, four cases above it.
       ANCHORED ON CODE AT BOTH ENDS. The era block ends where the round block begins, and that boundary is a
       real thing in the file rather than a character count -- so the negative assertions below are about this
       block and can only be satisfied by this block. */
    const body = sliceBetween(
      CODE,
      "if (before !== null && !replayingHistory) {",
      "before.current_round_type !== after.current_round_type",
    );
    expect(body).toContain("showDividendToast(");
    expect(body).not.toContain("showActionToast(");
    expect(body).not.toContain("isRemoteReplay");
    /* AND THE REGION IS SMALL, so a future edit that swallowed the neighbour would fail here rather than
       quietly widening what these negatives are denying. */
    expect(body.length).toBeLessThan(1200);
  });

  it("derives the era rather than waiting for a message", () => {
    /* NO WIRE FORMAT FOR THIS, deliberately: the era is a function of the highest train in play (#1), so a
       message would be a second source for a fact already in `gameState` -- and the two could disagree. */
    /* Design note #1096: STILL DERIVED, from a different pair of states. `derivePhase` on `before` and
       `after` is the same claim the old `currentPhase` read made -- the era is a function of the highest
       train in play -- asked of the two states the dispatch already has rather than of render state. */
    expect(CODE).toContain("const to = eraAfter ? tierEra(eraAfter) : null;");
    expect(CODE).not.toContain("const eraNow = currentPhase");
  });

  it("keeps the replay guard #825 installed upstream", () => {
    /* Nothing has just happened during a rebuild. The guard lives inside `showDividendToast`, so this
       asserts the toast goes through that door rather than around it. */
    /* ==================================================================
        SLICED TO THE FUNCTION'S FIRST STATEMENT, NOT TO A BYTE COUNT
       ==================================================================
       IT WAS `CODE.slice(at, at + 300)`, and #984 broke it by adding one parameter -- `detailRows`, whose
       type annotation is about seventy characters. The guard had not moved; the window had. A fixed-length
       window is a hidden assumption about how long a signature is allowed to get, and it fails on a change
       that has nothing to do with the property being asserted.
       ANCHORED ON THE TOKEN BUMP, which is the first statement after the guard and the thing the guard must
       come before. That is the relationship this case is actually about: the replay check happens BEFORE any
       toast state is written, not merely somewhere in the vicinity. */
    const at = CODE.indexOf("const showDividendToast");
    expect(at).toBeGreaterThan(-1);
    const body = CODE.slice(at, CODE.indexOf("actionToastTokenRef.current += 1;", at));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("if (replayingHistory) return;");
  });
});
