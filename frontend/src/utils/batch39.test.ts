/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1037 (harness): A HIDDEN RING IS NOT A CLOSED ONE
// ==================================================================
//
// REPORTED: "If a player clicks away from the Rail Map tab and then returns, the tile selector radial menu is
// inappropriately opening/staying open on a hex."
//
// THE DIAGNOSIS IS THE INTERESTING PART and it is what this file is shaped around. The ring was never on
// screen while the player was away -- `RadialTileSelector` has been gated on `activeMainTab === "map"` since
// #199 -- so nothing rendered wrongly. What outlived the view was the STATE, held in the shell, which does not
// unmount when a tab changes. A conditional render looks exactly like a closed menu until it comes back.
//
// SO THE CASES SPLIT THREE WAYS. That the reset exists; that it reaches every ring rather than the one that
// was reported; and -- the half that matters most -- that it does NOT reach the player's turn. "Reset the
// local state" is easy to read as "reset everything local", and everything local includes drafted routes and
// armed private-company errands.
//
// SOURCE-SCANNED, and honestly so: this is a claim about a React effect in a tree with no component renderer,
// so what can be checked is what the file says it does on a tab change. The gap is the same one every UI
// assertion in this repo has.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");

/** The body of the tab-change effect, bounded so a stray `setRadialSelector(null)` elsewhere in a
 *  four-thousand-line file cannot satisfy these -- #886's rule, and the failure a bare `toContain` produced
 *  twice in this project already. */
const RESET = APP.slice(
  APP.indexOf('if (activeMainTab === "map") return;'),
  APP.indexOf("}, [activeMainTab]);"),
);

describe("leaving the map closes what was open on it", () => {
  it("keys the reset on the tab rather than on a component unmount", () => {
    /* THE MECHANISM. The map is conditionally rendered, not unmounted-and-remounted in a way the ring's owner
       can observe -- the state lives in the shell, one level above anything that goes away. An effect keyed on
       the tab is the only place that can see the transition. */
    expect(APP).toContain('if (activeMainTab === "map") return;');
    expect(APP).toContain("}, [activeMainTab]);");
  });

  it("clears the tile ring that was reported", () => {
    expect(RESET).toContain("setRadialSelector(null);");
  });

  it("clears the station confirm ring too", () => {
    /* THE SIBLING WITH THE IDENTICAL FAULT. `RadialTokenConfirm` is the same component (#201), gated on the
       same tab, holding its state in the same place. Fixing only the reported one is the half-fix this
       codebase keeps producing -- and the second report would have been indistinguishable from the first. */
    expect(RESET).toContain("setPendingToken(null);");
  });

  it("clears the preview the ring drives, and the lookup behind it", () => {
    /* #625 ALREADY PAIRS `previewTile` WITH THE RING on a corporation handover, which is the same transition
       seen from a different cause -- so leaving them out of this one would make two paths disagree about what
       closing the picker means. `hexClickQuery` is the in-flight lookup whose spinner is itself map-gated. */
    expect(RESET).toContain("setPreviewTile(null);");
    expect(RESET).toContain("setHexClickQuery(null);");
  });
});

describe("the player's turn survives a look at another tab", () => {
  /* ==================================================================
      THE HALF THAT WOULD BE THE WORSE BUG
     ==================================================================
     Each of these is local shell state that a broad reading of "reset the local state tracking the map" would
     sweep up, and each describes what the player is DOING rather than what is on their screen. A player who
     opens the Ledger to check a rival's cash has not abandoned a half-drawn Diesel route. These assertions are
     what would fail if a later tidy-up widened the effect. */

  it("does not disarm the tile inspector", () => {
    // Being in Lay Track is a fact about the turn, not about which tab is showing.
    expect(RESET).not.toContain("setTileInspectorArmed");
  });

  it("does not cancel an armed private-company errand", () => {
    /* THE MOST EXPENSIVE ONE TO LOSE. An errand is a once-per-game power, and cancelling it silently because
       somebody glanced at the market would be unrecoverable within the turn. */
    expect(RESET).not.toContain("setArmedErrand");
  });

  it("does not discard drafted routes", () => {
    /* A LONG DIESEL ROUTE IS MINUTES OF WORK, clicked hex by hex. #275 keys drafts by train index precisely
       so they persist across everything else the player does. */
    expect(RESET).not.toContain("setRouteDrafts");
    expect(RESET).not.toContain("setRouteSelectMode");
  });

  it("does not abandon a home station placement", () => {
    /* #763: while a home token is owed, nothing else may happen at all. Clearing it here would leave the
       player owing a placement with no prompt telling them so. */
    expect(RESET).not.toContain("setHomeStationPlacement");
  });

  it("does not leave the token targeting mode", () => {
    expect(RESET).not.toContain("setTokenTargetMode");
  });

  it("touches exactly four pieces of state", () => {
    /* THE BOUNDARY, COUNTED. Each `not.toContain` above names one thing a widening could catch; this catches
       a widening that adds something nobody thought to name. Four setters, no more. */
    expect((RESET.match(/set[A-Z]\w*\(/g) ?? []).length).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* The fault that actually produced the report -- design note #1038    */
/* ------------------------------------------------------------------ */

describe("the one-shot auto-select cannot fire twice", () => {
  /* ==================================================================
      THE REPRODUCTION NAMED THE CAUSE AND #1037 HAD GUESSED WRONG
     ==================================================================
     REPORTED, on being asked whether the first fix checked out: "every time I clicked another tab and came
     back to Rail Map, the exact same hex (F16, where I had used DH's private power) had its radial menu open,
     and this occurred only after I used the DH private power."
     THREE FACTS, ONE MECHANISM. Every return, one specific hex, only after that power -- which is not a ring
     lingering. A lingering ring would have been on screen continuously and would have sat wherever it was
     last opened. This one was OPENED AGAIN, once per return, on the hex an instruction still pointed at.
     `lastAutoSelectRef` REMEMBERS THE CONSUMED TOKEN AND LIVES IN THE BOARD, which is conditionally rendered
     on the map tab. Leaving unmounts it; the instruction lives in the shell, which does not. Return, remount
     with a blank ref, meet a token with no record of consumption, select the hex again.
     AND ONLY THE D&H COULD DO IT because `setAutoSelectHex` is reached from the private-tile reservation path
     and nowhere else. */

  const RENDERER = readStripped("components/HexGridRenderer.tsx");

  it("tells the shell when it has carried the instruction out", () => {
    expect(RENDERER).toContain("onAutoSelectConsumed?.(token);");
  });

  it("reports only after the hex has actually been selected", () => {
    /* ORDER IS THE WHOLE CORRECTNESS OF THE HANDSHAKE. A clear that raced ahead of `selectHex` would drop an
       instruction nobody carried out -- the opposite bug, and a harder one to see. */
    expect(RENDERER.indexOf("onAutoSelectConsumed?.(token);")).toBeGreaterThan(
      RENDERER.indexOf("cityIndexAtPoint2: null,"),
    );
  });

  it("spends the instruction in the shell, which outlives the board", () => {
    /* THE POINT OF THE FIX. The ref was never wrong -- it was in the wrong place. The only record that
       survives a remount is the one held above the thing that remounts. */
    expect(APP).toContain(
      "setAutoSelectHex((current) => (current?.token === token ? null : current))",
    );
  });

  it("cannot swallow a newer instruction", () => {
    /* #873 KEYED THE ONE-SHOT ON A TOKEN so arming the same hex twice still fires twice. The clear has to
       respect that from the other end: an unguarded `setAutoSelectHex(null)` would discard an instruction
       issued between the selection and this commit, and the player would ask for the C&SL a second time and
       watch nothing happen. */
    expect(APP).not.toContain("onAutoSelectConsumed={() => setAutoSelectHex(null)}");
  });

  it("keeps the in-component guard as well", () => {
    /* TWO GUARDS, TWO LIFETIMES, and neither is redundant. The ref stops a re-render of a MOUNTED board
       firing twice before the shell's clear commits -- the race #873 built it for. The shell's clear stops a
       REMOUNT firing again at all. Deleting the ref because "the shell clears it now" would reintroduce the
       first race while fixing the second. */
    expect(RENDERER).toContain("if (lastAutoSelectRef.current === autoSelectHex.token) return;");
  });
});

describe("the ring is still gated where it always was", () => {
  it("keeps the render gate that made the state outlive the view", () => {
    /* NOT A REDUNDANCY WITH THE RESET, and worth keeping both. The gate is what stops the ring drawing over
       the Ledger; the reset is what stops it coming back. Removing the gate because "the state is cleared
       now" would put a tile picker on the stock market for one render. */
    expect(APP).toContain('{activeMainTab === "map" && tileInspectorArmed && radialSelector && (');
    expect(APP).toContain('{activeMainTab === "map" && pendingToken && (');
  });
});
