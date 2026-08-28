// frontend/src/utils/sourceScan.ts
//
// ==================================================================
//  DESIGN NOTE 886: ONE READER, ONE STRIPPER, AND NO BACKWARDS SLICES
// ==================================================================
//
// ASKED, after a feedback turn ran long: "Has this codebase really become this complicated? This is way too
// slow to be iterating UI fixes."
//
// PART OF THE ANSWER IS HERE. 100 of this project's 188 suites read source off disk and assert on substrings.
// That style is what catches this codebase's signature bug -- a design note claiming something the code does
// not do -- and #490a is the rule that makes it work: "a source-scan test can't tell an implementation from a
// design note quoting it. Scan a comment-stripped copy for absences; assert the note separately against raw
// text." What it did not have was one implementation.
//
// SEVENTY-FOUR SUITES HAND-ROLL A COMMENT STRIPPER. Twelve name it `strip`; the rest inline the same regexes
// into a local `read`, which is why a first survey counted twelve. Eight of the twelve carry a `{/* ... */}`
// pattern for JSX comments and four do not, and the difference LOOKS like a correctness split.
//
// IT IS NOT, AND THE REASON IS WORTH WRITING DOWN, because the obvious reading is wrong in the reassuring
// direction. Every one of them runs the block-comment replace FIRST:
//
//     source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
//
// The first pattern already matches the `/* ... */` inside `{/* ... */}`, so the JSX pattern has nothing left
// to match by the time it runs. It is an unreachable arm (#788) that eight authors wrote believing it did
// something. The comment TEXT comes off either way -- so #490a has been holding, in all seventy-four -- and
// what every one of them actually leaves behind is `{}` where the note was: 165 of those across `App.tsx` and
// `ContextualActionBar.tsx` alone. Harmless to a `not.toContain`, noise inside a bounded slice, and a copy
// that does not say what its author thinks it says.
//
// SO THE ORDER IS THE FIX, not a fourth `replace`: JSX comments come off first, braces and all, then block
// comments, then line comments.
//
// MIGRATION IS DELIBERATELY PARTIAL. The twelve that named the helper are converted; the rest are not, and
// converting them by regex is the wrong tool -- the first attempt at exactly that silently replaced a
// read-AND-strip with a plain read in `privatePowerFlow.test.ts`, because that file's stripper lived inside
// its `read` and the survey had not seen it. One suite caught it. Sixty-two more edits of that shape is a
// bad trade against a saved import. New suites use this module; the others convert when they are next opened
// for a reason of their own, which costs nothing because the file is already in front of you.
//
// ------------------------------------------------------------------
//  WHY `sliceBetween` THROWS
// ------------------------------------------------------------------
//
// The recurring vacuity in these tests is not a wrong assertion, it is an assertion with nothing under it:
//
//     const body = CODE.slice(CODE.indexOf(start), CODE.indexOf(end));
//     expect(body).not.toContain("thing");           // passes -- `body` is ""
//
// `indexOf` returns -1 for a missing anchor, -1 is less than every real index, and a backwards slice is the
// empty string, which satisfies every `not.toContain` beside it. This session alone it appeared four times --
// twice in tests written this session, once in `stepJumpButton.test.ts` (whose end anchor was an element
// deleted three notes earlier), and once caught only by a negative control.
//
// THE HABIT THAT GUARDS IT is four lines of `expect(...).toBeGreaterThan(-1)` before every slice, remembered
// every time by every author. `sliceBetween` throws instead, naming the anchor it could not find. A rule the
// tool enforces costs nothing to remember, and a test that fails with "end anchor not found: ..." is telling
// the truth where a silent pass was not.
//
// ------------------------------------------------------------------
//
// TEST-ONLY, and it lives in `utils/` because that is where this project already keeps test-only helpers
// (`mockFixtures.ts`). `fs` is reached through `require` inside the functions rather than a top-level import,
// so nothing can pull a Node built-in into the browser bundle by importing this file from production code by
// mistake. The file is not named `*.test.ts`, so Jest does not collect it as a suite.

/** Read a source file, relative to `src/`. */
export function readSource(relativeToSrc: string): string {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", relativeToSrc), "utf8");
}

/** Every comment removed, so an absence assertion cannot be satisfied -- or defeated -- by a design note
 *  quoting the string it is about (#490a).
 *
 *  ORDER IS LOAD-BEARING: `{/* ... *\/}` first, because the block pattern below would otherwise consume its
 *  interior and leave the braces behind as `{}`. That was the bug in all twelve hand-written copies. */
export function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The common case: read a file and strip it, in one call. */
export function readStripped(relativeToSrc: string): string {
  return stripComments(readSource(relativeToSrc));
}

/** The index of `anchor`, or a thrown error naming it.
 *
 *  NEVER -1. That value is what makes an ordering assertion vacuous -- it is less than every real index, so
 *  `expect(a).toBeLessThan(b)` passes for an `a` that does not exist. Use this for both sides of an ordering
 *  check and the comparison means what it says. */
export function anchorIndex(source: string, anchor: string, label = "anchor"): number {
  const at = source.indexOf(anchor);
  if (at === -1) {
    throw new Error(`sourceScan: ${label} not found: ${JSON.stringify(anchor)}`);
  }
  return at;
}

/** The text between two anchors, `start` inclusive.
 *
 *  `end` IS SEARCHED FROM `start`, not from the beginning of the file -- an end anchor that also appears
 *  earlier would otherwise produce a backwards slice, which is the same empty string by another route.
 *  THROWS rather than returning `""` when either anchor is missing or the order is wrong, so a slice that
 *  reaches a test is a slice with something in it. */
export function sliceBetween(source: string, start: string, end: string): string {
  const from = anchorIndex(source, start, "start anchor");
  const to = source.indexOf(end, from + start.length);
  if (to === -1) {
    throw new Error(
      `sourceScan: end anchor not found after start: ${JSON.stringify(end)} (start was ${JSON.stringify(start)})`,
    );
  }
  return source.slice(from, to);
}
