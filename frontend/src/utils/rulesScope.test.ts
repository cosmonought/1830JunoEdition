/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1293 (harness): A RULE ASKED OUTSIDE ITS RULES
// ==================================================================
//
// TWICE IN ONE EVENING, on opposite sides of the wire:
//   #1279  the shell judged a tile lay against the board and tray IN EFFECT during a render-free rebuild,
//          so a refreshed tab refused every LPF tile and diverged;
//   #1287  the server decided what the game owed with the STANDARD board in effect, because nothing on a
//          bare Node process ever activates one, so C&O's Tokens step was skipped.
//
// The two share one shape: `STATIC_BOARD_HEXES` and the tray are module-level tables that `activateRules`
// swaps, and the shell swaps them during RENDER (#1300). Any reader of those tables that runs where no render
// has put the game's board in effect -- inside a dispatch loop, on the server -- is only correct inside
// `withRules(...)`. `tsc` cannot see that. This scan can.
//
// THE RULE: in the files that run without a render, every call to a board-table reader named below sits
// inside a `withRules(` (or `withBoard(`) expression -- checked as "the call's enclosing text, back to the
// start of its statement, contains the wrapper". Readers that run at render time (the picker, the veil) are
// out of scope; #1300 covers them.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

/** The readers that walk `STATIC_BOARD_HEXES` or the tray and answer a rule. */
const READERS = ["nextDerivedAction(", "filterSandboxPlacements("] as const;

/** Files whose calls run with no render to put the board in effect: the engine, and the shell's dispatch. */
const RENDER_FREE: ReadonlyArray<{ file: string; region?: [string, string] }> = [
  { file: "utils/replayLog.ts" },
  /* The shell's dispatch only -- `runGameplayAction`'s body, which a rebuild runs 150 times before the first
     paint. The picker's and the veil's calls live elsewhere in the file and are render-time. */
  { file: "App.tsx", region: ["const gridBeforeAction = mapGridRef.current;", "if (\"LayTile\" in msg)"] },
];

function unwrappedCalls(source: string, reader: string): string[] {
  const out: string[] = [];
  let at = source.indexOf(reader);
  while (at !== -1) {
    /* Back to the start of the statement: the previous line that ends a statement or opens a block. A
       wrapper on the same statement -- `withRules(v, () => reader(...))` -- is within this window. */
    const statementStart = Math.max(
      source.lastIndexOf(";\n", at),
      source.lastIndexOf("{\n", at),
      source.lastIndexOf("=> {", at),
    );
    const statement = source.slice(statementStart, at);
    if (!statement.includes("withRules(") && !statement.includes("withBoard(")) {
      out.push(source.slice(at, at + 60).replace(/\s+/g, " "));
    }
    at = source.indexOf(reader, at + reader.length);
  }
  return out;
}

describe("a board-table reader that runs without a render is scoped to the game's rules", () => {
  it.each(RENDER_FREE)("$file", ({ file, region }) => {
    let source = readStripped(file);
    if (region) {
      const start = source.indexOf(region[0]);
      const end = source.indexOf(region[1], start);
      expect([file, start, end].every((v) => v !== -1)).toBe(true);
      source = source.slice(start, end);
    }
    for (const reader of READERS) {
      expect([file, reader, unwrappedCalls(source, reader)]).toEqual([file, reader, []]);
    }
  });

  it("would have caught both", () => {
    /* The harness's own control: the two shapes as they were written, and as they are now. */
    const before = "    for (;;) {\n      const next = nextDerivedAction({ state });\n";
    const after = "    for (;;) {\n      const next = withRules(v, () =>\n        nextDerivedAction({ state }));\n";
    expect(unwrappedCalls(before, "nextDerivedAction(")).toHaveLength(1);
    expect(unwrappedCalls(after, "nextDerivedAction(")).toHaveLength(0);
  });
});
