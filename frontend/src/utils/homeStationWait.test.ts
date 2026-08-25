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

const PROMPT = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(
    path.join(__dirname, "..", "components", "HomeStationPrompt.tsx"),
    "utf8",
  );
})();

const APP = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
})();

/** #490a: the notes quote both arms of the copy while explaining them. */
const strip = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CODE = strip(PROMPT);
const APP_CODE = strip(APP);

describe("a watcher is told what the table is waiting for", () => {
  it("names the person", () => {
    /* The one fact that turns "the game is stuck" into "it is not my move": WHO. The heading already carried
       the president's name -- it simply addressed the reader as if they were that person. */
    expect(CODE).toContain("Waiting for {presidentLabel ??");
  });

  it("names the corporation", () => {
    // The `$` is assembled: `no-template-curly-in-string` rightly flags that syntax inside a plain string,
    // and this is the rare case where the string IS source text being searched for (as in #779's harness).
    const dollar = String.fromCharCode(36);
    expect(CODE).toContain(`\`${dollar}{pending.ticker} has floated\``);
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
    expect(CODE).toContain("{viewerIsPresident && (");
    const branch = CODE.slice(CODE.indexOf("{viewerIsPresident && ("));
    expect(branch).toContain("onPlace(pending.companyId");
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

  it("treats a hotseat screen as the President's", () => {
    // `viewerAddress` is null with no room; the same reasoning `holding.isSelf` uses on the roster.
    expect(APP_CODE).toContain("!viewerAddress ||");
  });

  it("compares the seat rather than the corporation", () => {
    expect(APP_CODE).toContain("pendingHomeToken.president === viewerAddress");
  });
});

describe("the gates this explains are still in place", () => {
  it("keeps #763's refusal", () => {
    /* The modal EXPLAINS the freeze; it must not become the thing that enforces it. If this gate ever goes,
       the copy would be describing a rule the board no longer applies. */
    expect(APP_CODE).toContain("homeTokenBlock");
  });

  it("keeps #769's held seat", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const reducer = fs.readFileSync(path.join(__dirname, "sandboxSession.ts"), "utf8");
    expect(reducer).toContain("pendingHomeTokens");
  });
});
