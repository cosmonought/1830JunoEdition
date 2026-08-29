/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1008 (harness): THE HOOK IS RIGHT; IS IT PLUGGED IN?
// ==================================================================
//
// `turnAttention.test.ts` mounts the hooks and proves they behave. What it cannot see is whether the two
// surfaces the report is about actually READ them -- a hook nobody calls passes every test it has.
//
// #1006 IS THE REASON THIS FILE EXISTS. That batch's bug was a correct walk with a correct predicate that the
// deciding caller simply never passed: "a rule tested at the module that implements it and never at the module
// that has to remember to ask is a rule with a door beside it." Two of the three surfaces here live in
// `App.tsx` and `ContextualActionBar.tsx`, neither of which this repo can mount, so the wiring is asserted the
// only way it can be -- on the text -- and the behaviour is asserted next door on the hook.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");

describe("the shell computes the glow once and shares it", () => {
  it("derives it from the hook rather than from isMyTurn", () => {
    expect(APP).toContain("const turnGlowActive = useTurnGlowActive(isMyTurn);");
  });

  it("gates the full-viewport overlay on it", () => {
    /* THE SCREEN-EDGE GLOW, item 2's first half. Asserted as the exact render, because `turnGlowActive`
       appearing anywhere in a 9500-line file is not evidence that this element reads it. */
    expect(APP).toContain(
      '{turnGlowActive && <div style={styles.turnPulseOverlay} aria-hidden="true" />}',
    );
    expect(APP).not.toContain('{isMyTurn && <div style={styles.turnPulseOverlay}');
  });

  it("hands the same flag to the action bar", () => {
    expect(APP).toContain("turnGlowActive={turnGlowActive}");
  });

  it("keeps isMyTurn itself untouched", () => {
    /* THE HALF THAT WOULD BE A REGRESSION, NOT A FIX. `isMyTurn` gates dispatch and the Undo control; if the
       fix had narrowed it instead of adding a flag beside it, a player who clicked once would lose the
       interface. Asserted as the props still travelling separately. */
    expect(APP).toContain("isMyTurn={isMyTurn}");
  });
});

describe("the action bar lights on the attention flag, not the rules flag", () => {
  /* ==================================================================
     THE ANCHOR MATCHED THE WRONG BAR, WHICH IS A VACUITY #886 DOES NOT LIST
     ==================================================================
     `ref={actionBarRef}` appears TWICE in this file: once on the REDIRECT variant rendered when the player is
     off on a reference tab, and once on the real bar. `indexOf` finds the first, so a slice anchored there
     covered a style object that never mentions the pulse -- not an empty slice, and not a backwards one, but
     a perfectly well-formed slice of the wrong element. `sliceBetween` cannot catch this: both anchors were
     found, in order, with text between them.
     ANCHORED PAST THE DECOY. `styles.actionBarRedirect` is unique to the first block and sits at its end, so
     starting there puts the search for the end anchor safely inside the second. */
  const BAR_STYLE = sliceBetween(
    BAR,
    "...styles.actionBarRedirect,",
    "...(condensed ? styles.actionBarCondensed : {})",
  );

  it("is aimed at the bar that carries the pulse", () => {
    // The slice's own assumption, since getting this wrong is what the note above records.
    expect(BAR_STYLE).toContain("ref={actionBarRef}");
    expect(BAR_STYLE).toContain("styles.actionBarTurnPulse");
  });

  it("applies the pulse from turnGlowActive", () => {
    expect(BAR_STYLE).toContain("(turnGlowActive ?? isMyTurn) ? styles.actionBarTurnPulse");
  });

  it("no longer applies it from isMyTurn alone", () => {
    expect(BAR_STYLE).not.toContain("...(isMyTurn ? styles.actionBarTurnPulse : {})");
  });

  it("still gates the rules on isMyTurn", () => {
    /* The five non-decorative readings stay. Named individually rather than counted, so a future edit that
       converts one of them to the attention flag fails here with the name of what it broke. */
    expect(BAR).toContain('const mayActThisTurn = roundType !== "OperatingRound" || isMyTurn;');
    /* `no-template-curly-in-string` objects to a literal `${...}`, so the interpolation is assembled -- the
       same dodge #1007's harness uses. What is asserted is the SOURCE TEXT of a template literal, which is an
       ordinary string to this file. */
    const DOLLAR = String.fromCharCode(36);
    expect(BAR).toContain(
      "className={`app-turn-band" + DOLLAR + '{isMyTurn ? " app-turn-band-mine" : ""}`}',
    );
  });
});
