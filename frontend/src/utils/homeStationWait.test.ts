/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module, which
// `--isolatedModules` requires. Second time this session -- Jest runs such a file happily and only
// `tsc` objects, which is exactly what the standing clean-typecheck rule is for.
export {};
//
// The table is told why the game has stopped. Source-level; no DOM.
//
// ==================================================================
//  DESIGN NOTE 783 (harness): THE GAME STOPPED AND ONLY ONE PERSON KNEW
// ==================================================================
//
// REPORTED: "when another player buys the share that floats your corporation, the screen just hangs on that
// player's turn until the corporation president places the home station. This is confusing players who think
// they still need to do something."
//
// TWO CORRECT FIXES ADDED UP TO A SILENCE. #763 refuses every action while a home token is owed -- right,
// because a board with an unplaced home token is a board that cannot exist. #769 holds the seat on the
// President rather than advancing past them -- right, because being refused is not the same as not being
// asked. Neither told anyone else. So three players watch a turn that will not move, with the cursor sitting
// on somebody who is not them and no statement anywhere that the game is waiting rather than broken.
//
// THE SAME CARD, NOT A SECOND MODAL. A watcher needs the identical facts -- which corporation, whose move --
// and a separate "waiting" component would be a second home for that copy, which is how two accounts of one
// situation start to disagree (#391's rule, in a component rather than a catalog). The verb changes and the
// button goes.
//
// NO DISABLED BUTTON FOR A WATCHER, stated because it is the obvious alternative: it would invite exactly the
// click this modal exists to explain away, and #763's gate would then refuse it silently.
//
// A SOURCE SCAN because the branch is JSX and this suite has no DOM. What it can pin is that both arms exist,
// that the button is inside the president's arm only, and that the default keeps hotseat unchanged.
//
// ==================================================================
//  DESIGN NOTE 788: AND EXISTING IS NOT THE SAME AS RENDERING
// ==================================================================
//
// REPORTED after #783 shipped: "no modal popped up on other players' screen. However, their attempted actions
// were recorded in the activity log as REFUSED."
//
// THE WATCHER ARM WAS UNREACHABLE. `pendingHomeToken` returned `null` for anybody who was not the president,
// so the modal rendered nothing at all and `viewerIsPresident` was never consulted. #783's fix was a branch
// with no way in -- #757's shape ("a predicate that was never asked"), committed while fixing another
// instance of the same thing.
//
// AND EVERY TEST IN THIS FILE PASSED. They assert the copy EXISTS in the source, and it did. A source scan
// cannot tell a rendered branch from a dead one, which is #490a's limitation applied to markup rather than to
// comments. The REFUSED lines are what caught it: `homeTokenBlock` saw the debt on the watcher's client while
// the memo one file away decided that client had nothing to be told about.
//
// SO THE GUARD BELOW IS ABOUT THE MEMO, NOT THE MARKUP. "Does the board owe a token" is a fact about the
// BOARD and identical on every client; "is this viewer the one who must place it" is a different question
// with its own home. A viewer test creeping back into the first is the regression to catch.

const { readShell, readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const PROMPT = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(
    path.join(__dirname, "..", "components", "HomeStationPrompt.tsx"),
    "utf8",
  );
})();

/** #490a: the notes quote both arms of the copy while explaining them. */
const strip = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CODE = strip(PROMPT);
const APP_CODE = readShell();
/** Phase 3 W1-J: the viewer rule the prop now calls. Phase 3 W2-H: it delegates to the shared viewer policy, so the
 *  comparison itself is read from there. */
const RULE_CODE = readStripped("utils/homeStationAskView.ts") + readStripped("utils/waitingPromptView.ts");
/** Phase 3 W2-H (OD-1): the waiting seats' arm -- an early return of the non-modal status -- and the President's card
 *  after it. */
const WAITING_ARM = sliceBetween(CODE, "if (!viewerIsPresident) {", "</WaitingStatusBanner>");
const PRESIDENT_ARM = CODE.slice(CODE.indexOf('role="dialog"'));

describe("a watcher is told what the table is waiting for", () => {
  it("names the person", () => {
    /* The one fact that turns "the game is stuck" into "it is not my move": WHO. The heading already carried
       the president's name -- it simply addressed the reader as if they were that person. */
    expect(CODE).toContain("Waiting for {presidentLabel ??");
  });

  it("names the corporation", () => {
    // The `$` is assembled: `no-template-curly-in-string` rightly flags that syntax inside a plain string,
    // and this is the rare case where the string IS source text being searched for (as in #779's harness).
    /* Phase 3 W2-H (K-21 / U-32): WAS `${ticker} has floated`. The prompt appears at the corporation's first
       operating turn, not at its float (#1610), so the heading names the corporation by what it owes now. */
    const dollar = String.fromCharCode(36);
    expect(WAITING_ARM).toContain(`heading={\`${dollar}{pending.ticker} must place its home station\`}`);
  });

  it("says the timing that is true: the first operating turn, never the float (K-21 / U-32)", () => {
    expect(CODE).not.toContain("has floated");
    expect(WAITING_ARM).toContain("is starting its first operating turn and cannot operate until its home station");
    expect(PRESIDENT_ARM).toContain("is starting its first operating turn and its home station is not on the board yet.");
  });

  it("says play resumes, rather than leaving the reader to infer it", () => {
    expect(CODE).toContain("Play resumes as soon as it is down.");
  });

  it("promises no timing it cannot keep", () => {
    // This clears on an action, not a clock, so any "shortly"/"in a moment" would be an invention.
    expect(CODE).not.toMatch(/shortly|in a moment|any second/i);
  });
});

describe("the ask belongs to the President alone", () => {
  it("keeps the place button inside the president's branch", () => {
    /* Phase 3 W2-H: WAS `{viewerIsPresident && (` around the button. The waiting seats now leave by an early return
       (the non-modal status), so everything after it is the President's alone. */
    expect(WAITING_ARM.length).toBeGreaterThan(50);
    expect(WAITING_ARM).toContain("return (");
    expect(WAITING_ARM).not.toContain("onPlace");
    expect(WAITING_ARM).not.toContain("<button");
    expect(PRESIDENT_ARM).toContain("onPlace(pending.companyId");
  });

  it("offers a watcher no control at all", () => {
    /* Not a disabled one. #763's gate would refuse the click silently, so a greyed button would add a second
       confusion to the one being fixed.
       ASSERTED OVER THE WHOLE COMPONENT, and deliberately so after the first draft sliced from a misspelled
       anchor ("presentLabel"), got -1 back, and silently asserted over the whole file anyway -- passing for a
       reason it did not state. The honest version is the one that does not depend on finding an offset:
       there is no disabled control anywhere in this modal, for anybody. */
    expect(CODE).not.toContain("disabled");
    expect(CODE.match(/<button/g)?.length).toBe(1);
  });

  it("still addresses the President as before", () => {
    expect(CODE).toContain("As President you place its first station token");
  });
});

describe("the default cannot regress an existing caller", () => {
  it("assumes the president when nothing says otherwise", () => {
    /* `viewerIsPresident = true` is the pre-#783 behaviour exactly, so a caller that does not pass it -- or a
       test fixture, or hotseat, where one screen IS the president's -- behaves as it always did. */
    expect(CODE).toContain("viewerIsPresident = true");
  });

  it("no longer treats a screen without a seat as the President's (Phase 3 W1-J, A-2)", () => {
    /* WAS "treats a hotseat screen as the President's", pinning a `!viewerAddress ||` arm on the prop. Hotseat is
       gone (#578), and in a room a seatless watcher's id is "" -- falsy -- so that arm handed a watcher the
       President's form. The rule now lives in `homeStationAskView.ts`, with no escape arm. */
    const MOUNT = sliceBetween(APP_CODE, "<HomeStationPrompt", "liveryColor=");
    expect(MOUNT).not.toContain("!viewerAddress");
    expect(MOUNT).toContain("viewerIsPresident={homeStationViewerIsPresident({");
  });

  it("compares the seat rather than the corporation", () => {
    expect(APP_CODE).toContain("president: pendingHomeToken?.president,");
    expect(RULE_CODE).toContain("actor: president");
    expect(RULE_CODE).toContain("return actor === viewerAddress;");
  });
});

describe("the watcher's arm can actually be reached (design note #788)", () => {
  /** The memo that decides whether the modal renders at all. */
  const MEMO = sliceBetween(APP_CODE, "const pendingHomeToken = useMemo", "const privateTileHexKeyRef");

  it("has a memo to inspect", () => {
    // The slice guard: a boundary that moves silently would make every assertion below vacuous.
    expect(MEMO.length).toBeGreaterThan(50);
    /* #1616 (Slice 8.2): the grid rides along so the options are the hexes with a legal circle now; the memo still
       asks only the board. */
    expect(MEMO).toContain("pendingHomeTokens(gameState, homeHexToAxial, mapGrid)");
  });

  it("does not withhold the token from a non-president", () => {
    /* THE ACTUAL BUG. `if (!owed.president || owed.president !== viewerAddress) return null;` is what made
       #783's watcher arm dead code, and it read as an obviously correct line -- the prompt IS the
       president's. What it also did was decide, one file away from the component, that nobody else needed
       telling. */
    expect(MEMO).not.toContain("owed.president !== viewerAddress");
    expect(MEMO).not.toContain("viewerAddress");
  });

  it("keeps the viewer out of its dependencies", () => {
    /* Belt to the above: if the memo does not read the viewer, it cannot depend on one. A stray dependency
       here would be the first sign the filter had come back. */
    expect(MEMO).toContain("}, [gameState, homeHexToAxial, mapGrid]);");
  });

  it("still decides the ASK by the viewer, at the prop", () => {
    // The question did not disappear; it moved to where it can be answered without hiding the modal.
    // Phase 3 W1-J: the prop calls the one rule, which compares the named president with this viewer.
    expect(APP_CODE).toContain("viewerIsPresident={homeStationViewerIsPresident({");
    expect(RULE_CODE).toContain("return actor === viewerAddress;");
  });

  it("stops the President's screen, and tells the waiting seats without covering theirs (Phase 3 W2-H, OD-1)", () => {
    /* WAS "covers the screen while it waits": #783's report asked to "prohibit players from doing anything until the
       Home Station is placed", and the card's full-viewport scrim did that for every seat. The authority already
       refuses every held action (#763 / #1612), so the scrim added nothing for a waiting seat but a dialog with no
       focusable control (the modal audit's H5). OD-1: the President's card keeps the stop; every other seat gets the
       non-modal status, which says why the table has stopped and leaves the board usable. */
    expect(PRESIDENT_ARM).toContain('aria-modal="true"');
    expect(CODE).toContain('position: "fixed"');
    expect(CODE).toContain("inset: 0");
    expect(WAITING_ARM).toContain("<WaitingStatusBanner");
    expect(WAITING_ARM).not.toContain("aria-modal");
    expect(WAITING_ARM).not.toContain("styles.backdrop");
  });
});

describe("the gates this explains are still in place", () => {
  it("keeps #763's refusal", () => {
    /* The modal EXPLAINS the freeze; it must not become the thing that enforces it. If this gate ever goes,
       the copy would be describing a rule the board no longer applies. */
    /* Phase 3 W2-A (OD-1, P3-N001): the shell no longer names `homeTokenBlock` -- Pass's home arm was dead (Pass
       renders only outside the Operating Round) and every control now reads the ONE hold answer, `dockHoldView`,
       which asks the composition whose fourth hold is this one. The refusal is still the authority's. */
    expect(APP_CODE).toContain("dockHoldView({ state: gameState, mapGrid, homeHexToAxial,");
    const VIEW = readStripped("utils/dockHoldView.ts");
    expect(VIEW).toContain("authoritativeHoldRefusal(state, msg, ctx)");
    expect(readStripped("gameEngine/authoritativeHolds.ts")).toContain("homeStationHold(state, msg, ctx.homeHexToAxial)");
  });

  it("keeps the prompt's list in the reducer (the #769 held seat it was paired with is retired by #1610)", () => {
    /* Was "keeps #769's held seat". Slice 8.2 retired the seat hold -- a float owes nothing in a Stock Round -- and
       the modal now explains the operating corporation's turn-local hold instead. What this still guards is that the
       list the modal is raised from is the reducer's own derivation, not a shell copy. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const reducer = fs.readFileSync(path.join(__dirname, "..", "gameEngine", "sandboxSession.ts"), "utf8");
    expect(reducer).toContain("export function pendingHomeTokens(");
    expect(reducer).toContain("const owed = owedHomeStation(state, homeHexToAxial);");
  });
});
