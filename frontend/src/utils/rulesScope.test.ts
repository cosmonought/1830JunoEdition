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

const { readStripped, readShell, sliceBetween, occurrences } = require("./sourceScan") as typeof import("./sourceScan");

/** The readers that walk `STATIC_BOARD_HEXES` or the tray and answer a rule. */
const READERS = ["nextDerivedAction(", "filterSandboxPlacements("] as const;

/** Files whose calls run with no render to put the board in effect: the engine, and the shell's dispatch.
 *  APP-TEST-0A: the shell's region is read through `readShell()` and cut with `sliceBetween`, so it follows
 *  `runGameplayAction` into `shell/**` and throws, rather than scanning nothing, if either anchor is lost. */
/*  `witness` (APP-TEST-0A): what proves the scanned text is the rules-scoped code the case is about. The shell's
    region holds NO reader call today -- lay legality moved behind `withRules(rulesBeforeAction, ...)` in Stage
    10.3 (#1690) -- so for it the case is an absence ("no unwrapped reader creeps back into the dispatch"), and
    an absence needs its region to be the real one: the dispatch's own `withRules(` scope. */
const RENDER_FREE: ReadonlyArray<{ file: string; read: () => string; region?: [string, string]; witness: string }> = [
  { file: "gameEngine/replayLog.ts", read: () => readStripped("gameEngine/replayLog.ts"), witness: "withRules(" },
  /* The shell's dispatch only -- `runGameplayAction`'s body, which a rebuild runs 150 times before the first
     paint. The picker's and the veil's calls live elsewhere in the file and are render-time. */
  {
    file: "shell: runGameplayAction",
    read: () => readShell(),
    region: ["const gridBeforeAction = mapGridRef.current;", "if (\"LayTile\" in msg)"],
    witness: "withRules(",
  },
];

function unwrappedCalls(source: string, reader: string): string[] {
  const out: string[] = [];
  /* `allowNone`: not every render-free file calls every reader, and "every call is wrapped" is true of none. */
  for (const at of occurrences(source, reader, { allowNone: true })) {
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
  }
  return out;
}

describe("a board-table reader that runs without a render is scoped to the game's rules", () => {
  it.each(RENDER_FREE)("$file", ({ file, read, region, witness }) => {
    const whole = read();
    const source = region ? sliceBetween(whole, region[0], region[1]) : whole;
    expect([file, witness, source.includes(witness)]).toEqual([file, witness, true]);
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

/* ==================================================================
    ROUTE v12 R12-2 (S6-15, the R12-1 handoff's F-1): INGRESS AND THE REDUCER OPEN THE SAME RULES
   ==================================================================
   `RoomSession.submit` calls `turnRefusal` outside any scope, and a bare Node process never activates a board, so
   hosted ingress judged a 1830+ / Level Playing Field table's routes on the STANDARD board. `turnRefusal` now opens
   the table's rules once at its entry -- with the pin's route rules, as the reducer's entries do -- so every arm it
   asks reads the table's board. Pinned as source because the property is the scope itself; the behaviour is
   `routeOracle/routeOracleIngress.test.ts`. */
describe("R12-2: hosted ingress and the reducer are scoped to the table's rules and its pin's route rules", () => {
  it("turnRefusal opens the table's rules (and route rules) once, at its entry, around the whole body", () => {
    const AUTH = readStripped("gameEngine/turnAuthority.ts");
    const entry = sliceBetween(AUTH, "export function turnRefusal(input: TurnAuthorityInput): string | null {", "function turnRefusalOnTableBoard(");
    expect(entry).toContain(
      "return withRules(resolveVariants(input.state.variants), () => turnRefusalOnTableBoard(input), routeRulesRevisionOf(input.state));",
    );
  });

  it("the room's ingress asks exactly that function", () => {
    const ROOM = readStripped("utils/roomSession.ts");
    expect(ROOM).toContain("const refusal = turnRefusal({");
  });

  it("the reducer's entries and the replay engine name the pin's route rules wherever they open the table's rules", () => {
    const SESSION = readStripped("gameEngine/sandboxSession.ts");
    // W3-K (rules v13, owner ruling 2): the result is then handed to the Brown-continuation close, still under the same rules.
    expect(SESSION).toContain("const next = withRules(resolveVariants(variants), () => applySandboxActionOnBoard(state, msg, ctx), revision);");
    expect(SESSION).toContain("return closeBrownContinuationOnInterveningAction(state, next, msg, ctx);");
    const REPLAY = readStripped("gameEngine/replayLog.ts");
    expect(REPLAY).toContain("withRules(resolveVariants(variants), () => this.applyOnBoard(entry, msg, observe), revision);");
    expect(REPLAY).toContain("routeRulesRevisionOf(this.state),");
  });
});
