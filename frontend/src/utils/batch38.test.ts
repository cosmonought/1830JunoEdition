/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1036 (harness): AUTO-PASS, SET WHENEVER YOU LIKE
// ==================================================================
//
// REQUESTED: "the ability to enable 'Auto-Pass' during a Stock Round even when it is not currently their turn,
// similar to standard digital 18xx implementations", plus turn-progression evaluation and a reset at the end
// of the round.
//
// MOST OF THIS ALREADY EXISTED, which is the useful thing to record. #717 built auto-pass as a standing
// instruction held on the viewer's own client; #728 made the off switch always reachable; #816 keyed one
// dispatch per turn to the append-only log; #759a added the divestment rule. Item 2's "evaluate their autoPass
// state flag when the turn passes" is the effect #717 wrote and #816 corrected -- it fires on every state
// change and acts the moment `isMyTurn` becomes true.
//
// TWO THINGS WERE GENUINELY MISSING and this file is about those.
//   (1) ARMING WAS TURN-GATED, by reading a flag that answers two questions. The control was dead for the
//       whole round except on the one turn a player least needs it.
//   (2) A SPENT ARM SURVIVED ITS ROUND. Nothing was ever auto-passed by accident -- `autoPassDecision` has
//       always refused on a different `macroRoundNumber` -- but the button went on claiming "Auto-Pass: On"
//       through the Operating Round and into the next Stock Round, until that player's first turn came round.
//
// THE THIRD ITEM ASKED FOR A RESET AND THE RESET IT ASKED FOR WAS ALREADY THERE. What was wrong was the
// CLAIM, not the behaviour, and that distinction is the whole of the second describe.

export {};

const { autoPassDecision, armAutoPass, DEFAULT_AUTO_PASS_CONDITIONS } =
  require("./autoPass") as typeof import("./autoPass");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");

const state = (round: string, macro: number): any => ({
  current_round_type: round,
  macro_round_number: macro,
  public_companies: [],
});

/* ------------------------------------------------------------------ */
/* (1) Arming out of turn                                             */
/* ------------------------------------------------------------------ */

describe("the toggle is reachable whenever the player is connected", () => {
  it("gates arming on the connection alone", () => {
    /* THE FIX. `sessionReady` is `controlsEnabled && isMyTurn`; #728 reached for it wanting the first half
       and silently got the second. Arming writes local state and dispatches nothing -- the pass happens later,
       on this player's own turn, which the acting effect tests for itself. */
    expect(APP).toContain("canArm: controlsEnabled,");
    expect(BAR).toContain("disabled={!autoPass.armed && !autoPass.canArm}");
  });

  it("does not quietly put the turn back into the new predicate", () => {
    /* THE HALF A RENAME WOULD STILL GET WRONG. `canArm: controlsEnabled && isMyTurn` satisfies every other
       assertion here and changes nothing a player can see -- the failure mode of carving out a second field
       and then feeding it the first one's value. */
    expect(APP).not.toContain("canArm: controlsEnabled && isMyTurn");
    expect(BAR).not.toContain("disabled={!autoPass.armed && !sessionReady}");
  });

  it("leaves Pass itself gated on the turn", () => {
    /* THE CONTROL ON THE SPLIT, and the reason this is a carve-out rather than a loosening. The button that
       ENDS a turn still needs it to be your turn; only the standing instruction does not. */
    /* Design note #1173 re-anchored this: the acting gate gained a fourth condition, the in-flight latch, so
       the string is now `controlsEnabled && isMyTurn && !actionInFlight`. The CLAIM is unchanged and this
       still tests it -- the button that ends a turn wears the turn gate -- and it is now strictly stronger,
       which is the direction a control on a carve-out should ever move. Asserted on the `isMyTurn` half so a
       future condition beside it does not break the test it is supposed to satisfy. */
    expect(APP).toContain("sessionReady={controlsEnabled && isMyTurn && !actionInFlight}");
  });

  it("keeps the off switch free of both gates", () => {
    // #728's rule, unchanged: a dropped connection must not trap a player inside a setting that acts for them.
    expect(BAR).toContain("autoPass.armed ? autoPass.onDisarm : autoPass.onOpenSettings");
  });

  it("arms without consulting the seat", () => {
    /* THE AUTHORITY SIDE. A turn gate hidden in `armAutoPass` would defeat the button fix, and this is the
       function the modal calls -- it takes a state and a player and asks nothing about whose turn it is. */
    const arm = armAutoPass(state("StockRound", 2), "p1", DEFAULT_AUTO_PASS_CONDITIONS);
    expect(arm.player).toBe("p1");
    expect(arm.macroRoundNumber).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* (2) The turn-progression evaluation, which already worked          */
/* ------------------------------------------------------------------ */

describe("the arm is evaluated when the turn arrives", () => {
  it("passes when nothing has happened that concerns this player", () => {
    /* ITEM 2, DRIVEN. "When the turn passes to a new player, immediately evaluate their autoPass state flag"
       -- this is that evaluation, and it predates the batch. Asserted anyway because the effect's guards were
       edited in this batch's neighbourhood and a broken decision would be invisible from the source scans. */
    const arm = armAutoPass(state("StockRound", 2), "p1", DEFAULT_AUTO_PASS_CONDITIONS);
    expect(autoPassDecision(state("StockRound", 2), arm).pass).toBe(true);
  });

  it("acts through the ordinary pass rather than a private path", () => {
    /* #717's ARCHITECTURE, PINNED. The request says "the engine should automatically execute a Pass action on
       their behalf" -- and there is no engine here to do it: this app has no backend, only a replayed action
       log. So the armed player's OWN client dispatches the same `PassTurn` the button dispatches, which is
       what makes it undoable and indistinguishable afterwards from a pass they clicked. */
    expect(APP).toContain("void handlePassTurn();");
  });

  it("still dispatches only once per turn", () => {
    // #816's guard, which a new effect in the same file could plausibly have disturbed.
    expect(APP).toContain(
      "if (autoPassAlreadyActed(autoPassedAtLogIndexRef.current, lastLogIndex)) return;",
    );
  });
});

/* ------------------------------------------------------------------ */
/* (3) The reset                                                      */
/* ------------------------------------------------------------------ */

describe("a spent arm does not outlive its Stock Round", () => {
  it("was already unable to pass a turn in a later round", () => {
    /* THE HALF THAT WAS NEVER BROKEN, and worth asserting before the fix so the fix is not credited with it.
       "so they do not accidentally auto-pass their first turn in the next Stock Round" -- they never could:
       the decision refuses on any round but the one the arm was made in, and wakes the player instead. */
    const arm = armAutoPass(state("StockRound", 2), "p1", DEFAULT_AUTO_PASS_CONDITIONS);
    const later = autoPassDecision(state("StockRound", 3), arm);
    expect(later.pass).toBe(false);
    expect(later.wakeReason).toContain("expired with the Stock Round");
  });

  it("clears the arm the moment the round is no longer a Stock Round", () => {
    /* THE HALF THAT WAS. The acting effect returns early outside a Stock Round, so the arm sat there through
       the Operating Round with the button reading "Auto-Pass: On", and kept reading it into the next Stock
       Round until that player's first turn. A control announcing a setting that is not in force is the same
       fault as one that is missing -- and #728 built the always-visible state precisely so it could be
       trusted. */
    expect(APP).toContain('if (gameState.current_round_type === "StockRound") return;\n    setAutoPassArm(null);');
  });

  it("clears it silently rather than through the disarm handler", () => {
    /* `handleDisarmAutoPass` LOGS "Auto-Pass is off", which is right for a player pressing the button and
       wrong for a round boundary: nobody decided anything, and a line per armed player per boundary is noise
       in a log this project has twice been asked to quieten. */
    const block = APP.slice(
      APP.indexOf('if (gameState.current_round_type === "StockRound") return;'),
      APP.indexOf("useEffect(() => {\n    if (!autoPassArm || !gameState || !viewerAddress) return;"),
    );
    expect(block).not.toContain("handleDisarmAutoPass");
    expect(block).not.toContain("logInfo");
  });

  it("resets the one-dispatch-per-turn guard with it", () => {
    /* #816's REF IS PART OF THE ARM'S STATE. Left holding a stale log index, a fresh arm set in the next
       round would be guarded off for its first turn -- which is precisely the bug #816 was reported for,
       reintroduced by the cleanup for a different one. Counted rather than merely present: arm, disarm and
       now the round change. */
    expect((APP.match(/autoPassedAtLogIndexRef\.current = null;/g) ?? []).length).toBe(3);
  });
});
