/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1094 (harness): THE EPHEMERAL/DURABLE SPLIT, AND FOUR SMALLER THINGS
// ==================================================================
//
// THE BATCH'S CENTRE IS ONE DISTINCTION, arrived at from two directions. A refresh and an undo both replay
// the action log from the top, and everything this shell does in response to an action falls into one of two
// kinds:
//
//   DURABLE   the Activity Log entry, the reducer dispatch, the board.  MUST be rebuilt, every time.
//   EPHEMERAL a sound, a video, a flash, a toast.                       MUST NOT happen twice.
//
// BOTH REPORTED BUGS ARE THE SAME MISTAKE MADE TWICE, in opposite ways:
//
//   THE VARIANT CUE was written as one block with its log line (#1040, deliberately -- "the sentence, its
//   sound and its tint, decided together"), and the block asked no question about replay at all. So the
//   durable half was right and the ephemeral half rode along with it.
//
//   THE ERA TOAST asked the question and could not hear the answer. `replayingHistory` is set and cleared
//   synchronously around each dispatch; the toast was raised from a `useEffect`, which runs after React
//   commits, which is after the `finally`. Not sometimes false -- always false.
//
// WHICH IS WHY THE FIXES DIFFER. One adds the guard where the flag is already true; the other moves the code
// to where the flag can be read at all. A `hasPlayed` flag on top of either would have been a second answer
// to a question `replayingHistory` already answers -- #891's shape, and the thing this file is most concerned
// to keep from happening.

export {};

const { tileErasAt, tileErasUpTo, tierEra, TILE_ERA_ORDER, TIER_ORDER } =
  require("./gamePhase") as typeof import("./gamePhase");
const { STANDARD_TOAST_MS, PHASE_CHANGE_TOAST_MS } =
  require("../components/ActionToast") as typeof import("../components/ActionToast");
const { ERA_HEX_FILL } = require("../components/EraHex") as typeof import("../components/EraHex");
const { readStripped, sliceBetween, anchorIndex } =
  require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const LEDGER = readStripped("components/FinancialLedger.tsx");
const TOAST = readStripped("components/ActionToast.tsx");
const POPOVER = readStripped("components/AudioControlPopover.tsx");
const TOPBAR = readStripped("components/TopBar.tsx");
/* Design note #1102: the audio buttons and their popovers moved out of `TopBar` into `AudioControls`,
   so the waiting room and the bar render the same control rather than two lookalikes. The assertions
   below are unchanged in substance -- they follow their subject to its new file. */
const CONTROLS = readStripped("components/AudioControls.tsx");
const HEX = readStripped("components/EraHex.tsx");

/* ------------------------------------------------------------------ */
/* 1a: the ledger opens                                                */
/* ------------------------------------------------------------------ */

describe("the three ledger panels start open", () => {
  it("opens all three, and no others by accident", () => {
    /* RULED: "default the three main panels in the Game Ledger to be fully open on load."
       COUNTED RATHER THAN SPOT-CHECKED, because "three panels" is the claim: a fourth `<details>` added later
       and left shut would be a panel that behaves differently from its siblings for no stated reason, and
       one of the three losing its attribute would look identical to a player who had collapsed it. */
    expect(LEDGER.split("<details open").length - 1).toBe(3);
    expect(LEDGER).not.toContain("<details style=");
  });

  it("keeps the element rather than growing three booleans", () => {
    /* #1033'S ACTUAL ARGUMENT, which survives the reversal of its default: `<details>` brings the keyboard
       behaviour, the `aria-expanded` and the Ctrl-F reveal for free, and three `useState`s would reimplement
       all of it. What changed is one attribute, not the mechanism. */
    expect(LEDGER).not.toContain("const [bankOpen");
    expect(LEDGER).toContain("<summary");
  });
});

/* ------------------------------------------------------------------ */
/* 1b: the tile hexes                                                  */
/* ------------------------------------------------------------------ */

describe("which tile colours a phase permits", () => {
  it("is cumulative, so a row says what you can lay now", () => {
    /* THE DECISION THIS FUNCTION EXISTS TO RECORD. Phase 5 unlocks Brown and leaves Yellow and Green legal,
       so a row showing only the newly unlocked colour would answer a different question than it appears to.
       Ruled cumulative. */
    expect(tileErasAt("2")).toEqual(["Yellow"]);
    expect(tileErasAt("3")).toEqual(["Yellow", "Green"]);
    expect(tileErasAt("5")).toEqual(["Yellow", "Green", "Brown"]);
  });

  it("only ever grows as the phases advance", () => {
    /* THE PROPERTY, ASSERTED ACROSS THE WHOLE TIER LIST rather than tier by tier: a colour that became legal
       must never become illegal again, which is the whole of what "cumulative" means and the one way this
       could go wrong silently when a tier's era is retuned. */
    let previous = 0;
    for (const tier of TIER_ORDER) {
      const count = tileErasAt(tier).length;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
    expect(previous).toBe(TILE_ERA_ORDER.length);
  });

  it("agrees with the phase badge about the highest colour", () => {
    /* THE ANTI-#891 CASE. `tierEra` is what the phase badge and the era toast both mean by an era, and this
       function's last element is the same claim. Derived from it rather than restated, so this cannot drift
       -- and this case fails loudly if somebody ever writes the second table. */
    for (const tier of TIER_ORDER) {
      const eras = tileErasAt(tier);
      expect(eras[eras.length - 1]).toBe(tierEra(tier));
    }
  });

  it("shows nothing for an era it has never heard of", () => {
    /* ==================================================================
        THE CASE THAT PROVED SOMETHING ELSE
       ==================================================================
       THE FAILURE DIRECTION, CHOSEN. A Grey era added to `TIER_PRESENTATION` and forgotten in
       `TILE_ERA_ORDER` should show a player no hexes -- an absence somebody reports -- rather than a
       confident three that quietly omits the new colour. `indexOf` returning -1 is the case, which is exactly
       the shape #886 warns about, handled rather than left to `slice` to interpret.
       THE FIRST DRAFT WROTE `tileErasAt("Grey" as never)` AND IT THREW. An unknown TIER is not an unknown
       ERA: `tierEra` reads `TIER_PRESENTATION[tier].era` and dies one line earlier, so the guard this case
       exists for was never reached and the design note beside it was describing an intention as an
       accomplishment. `tileErasUpTo` is that half of the function, split out so the choice is reachable. */
    expect(tileErasUpTo("Grey")).toEqual([]);
    expect(tileErasUpTo("")).toEqual([]);
    // And the positive control, or an implementation that returned [] for everything would pass the above.
    expect(tileErasUpTo("Green")).toEqual(["Yellow", "Green"]);
  });

  it("has an order that covers every era a tier actually names", () => {
    /* THE INVARIANT THE GUARD ABOVE IS THE FALLBACK FOR, asserted directly -- so the day a Grey era is added
       this fails HERE, naming the real problem, rather than quietly showing an empty strip in one column of
       one table for somebody to notice in play. */
    for (const tier of TIER_ORDER) {
      expect(TILE_ERA_ORDER).toContain(tierEra(tier));
    }
  });

  it("draws them in their own column, which #1094 had decided against", () => {
    /* ==================================================================
        DESIGN NOTE 1126 SUPERSEDES #1094 ON PLACEMENT, AND ONLY ON PLACEMENT
       ==================================================================
       THIS CASE USED TO ASSERT THE OPPOSITE and the note it carried was a fair summary of the trade: "the
       table already carries eight columns inside a horizontal scroller; a ninth pushes the rightmost facts
       further out of reach to say something that costs no width inline."
       THE RULING CHANGED AND THE WIDTH WAS PAID RATHER THAN ARGUED AWAY -- the five columns holding short
       figures under long labels dropped from 14px of side padding to 8px, which is where the ninth column
       came from. What #1094 was RIGHT about is preserved below and in the case that follows: the strip is
       still cumulative, and it still says out loud what it means.
       INVERTED RATHER THAN DELETED, so the file still records that a choice was made here twice. */
    const tilesCell = sliceBetween(LEDGER, ">Available Tiles</th>", "</thead>");
    expect(tilesCell).toBeTruthy();
    expect(LEDGER).toContain("tileErasAt(row.tier as TrainTier)");
    expect(LEDGER).toContain("<EraHex");
    /* THE PHASE CELL IS NOW JUST THE PHASE. Anchored the same way the old case was, from the other side:
       the hexes must have LEFT it, or the column was added without moving anything into it. */
    const phaseCell = sliceBetween(LEDGER, "{DEPOT_SCHEDULE[row.tier]?.phase", "</td>");
    expect(phaseCell).not.toContain("<EraHex");
  });

  it("says out loud what three unlabelled hexes mean", () => {
    /* `role="presentation"` ON THE SVG IS CORRECT and it means a screen reader gets silence from the strip.
       The sentence is the strip's content for a reader who cannot see a colour, which is also every reader
       who cannot distinguish these three. */
    expect(LEDGER).toContain("Tiles available:");
    expect(LEDGER).toContain("styles.srOnly");
    /* CLIPPED, NOT `display: none`, which is skipped by every screen reader rather than read. */
    const srOnly = sliceBetween(LEDGER, "srOnly: {", "},");
    expect(srOnly).toContain("clip:");
    expect(srOnly).not.toContain("display: \"none\"");
  });
});

describe("one answer to what colour Green is", () => {
  it("is shared by the toast and the table", () => {
    /* #891 IS THIS PROJECT'S MOST EXPENSIVE RECURRING BUG and a second hand-rolled hex would have been it.
       The toast keeps drawing them; it just no longer owns the fills. */
    expect(Object.keys(ERA_HEX_FILL).sort()).toEqual(["Brown", "Green", "Yellow"]);
    expect(TOAST).toContain('import { EraHex } from "./EraHex";');
    expect(TOAST).not.toContain("const ERA_HEX_FILL");
    expect(LEDGER).toContain('import { EraHex } from "./EraHex";');
  });

  it("still leaves the board its own palette", () => {
    /* #929'S REASON SURVIVES THE MOVE, and it is the interesting half: a hex at map scale on the canvas and a
       hex-sized glyph in dark chrome are two different rendering problems. The toast and the table are the
       SAME problem, which is why those two share and the board does not. */
    expect(HEX).not.toContain("PRINTED_HEX_FILL");
    expect(HEX).toContain("size");
  });
});

/* ------------------------------------------------------------------ */
/* 2: the critical one                                                 */
/* ------------------------------------------------------------------ */

describe("the variant cue does not happen twice", () => {
  /* THE WHOLE VARIANT BLOCK, from where the flavour is resolved to where the next handler begins -- both
     halves, because the case that matters is about the LINE between them. A slice starting at the flag would
     have contained only the guarded half, which is how the first draft of the durable-half case below came to
     assert about a dispatch that was not inside it. */
  const block = sliceBetween(APP, "const resolved = resolveFlavourLine({", "if (after && \"DeclareDividends\"");

  it("gates all three ephemeral effects on one flag", () => {
    /* THE SOUND, THE VIDEO AND THE FLASH. Three separate `if`s reading one derived boolean rather than three
       copies of the condition -- #748a's rule, and the direct lesson of how this bug survived: the fog video
       was added as a fourth effect in this block one batch ago without anybody noticing the first three were
       unguarded. */
    expect(block).toContain("if (ephemeral && cue.audio !== null)");
    expect(block).toContain("if (ephemeral && cue.video)");
    expect(block).toContain("if (ephemeral && !cue.suppressStandardVisuals)");
  });

  it("leaves the durable half alone", () => {
    /* THE HALF THAT MUST REPLAY, and the reason this block could not simply be skipped on a rebuild. A client
       that returned early here would rebuild with no Activity Log entry for the run and no Yellow Sign event
       -- a game in which the fog never took the train. */
    expect(block).toContain("YellowSignEvent");
    expect(block).not.toContain("if (ephemeral) return");
    /* THE DISPATCHES ARE NOT GATED, asserted by position: each `runGameplayAction` in this block sits before
       the flag is ever consulted. `anchorIndex` rather than `indexOf` (#1090) so a vanished anchor throws
       instead of comparing against -1. */
    expect(anchorIndex(block, "runGameplayAction(\"YellowSignEvent\"")).toBeLessThan(
      anchorIndex(block, "if (ephemeral && cue.audio !== null)"),
    );
  });

  it("asks the flag that is true on both reported paths", () => {
    /* A REFRESH replays the whole log, so `pending` is not 1; AN UNDO sets `rewound`. `isOrdinaryPlay` is
       false for both, and the drain publishes its negation as `replayingHistory` (#825).
       NOT `options?.isRemoteReplay`, which is the other flag in scope and would have been wrong: it is true
       for a live action arriving from another player's browser, and those clients SHOULD see the flash. */
    expect(block).not.toContain("isRemoteReplay");
    expect(APP).toContain("const ephemeral = !replayingHistory;");
  });
});

describe("the era toast is raised where the guard can see it", () => {
  it("no longer lives in a render effect", () => {
    /* THE BUG WAS NOT A MISSING GUARD, IT WAS AN UNREACHABLE ONE. `showDividendToast` checks
       `replayingHistory`, and that flag is set and cleared synchronously around each dispatch -- a
       `useEffect` runs after React commits, so it read false on every replayed crossing. The effect's own
       note claimed the load case was handled; that was true of the FIRST observation and false of every
       crossing a rebuild walks through afterwards. */
    expect(APP).not.toContain("const lastEraRef");
    expect(APP).not.toContain("}, [eraNow, showDividendToast]);");
  });

  it("derives the crossing from before and after instead", () => {
    /* #1057'S SHAPE, which is how every other derived line in this shell already works: the reducer settles,
       the shell narrates the diff. Two states and one comparison -- there is no stored previous era left to
       go stale, and a rebuild simply never asks. */
    expect(APP).toContain("const eraBefore = derivePhase(before)?.tier;");
    expect(APP).toContain("if (from !== null && to !== null && from !== to)");
  });

  it("still announces to every player, which is why the guard is the one it is", () => {
    /* THE DISTINCTION THAT DECIDED WHERE THIS GOES. The round-transition block a few lines below suppresses
       itself with `options?.isRemoteReplay !== true`, because that line is a receipt for a transition the
       local client drove. #868 ruled the opposite for this one -- "a toast notification to every player when
       the threshold is crossed" -- and a live action from another browser IS a crossing that just happened.
       `isRemoteReplay` cannot tell a live remote action from a rebuild; `replayingHistory` is exactly that
       distinction. */
    const era = sliceBetween(APP, "if (before !== null && !replayingHistory) {", "showDividendToast(");
    expect(era).not.toContain("isRemoteReplay");
    // And the round line beside it still uses the other flag, for its own different reason.
    expect(APP).toContain("options?.isRemoteReplay !== true");
  });

  it("keeps #966's sentence and #929's graphic", () => {
    /* THE MOVE CHANGES WHERE, NOT WHAT. Both rulings that shaped this toast are still in force. */
    expect(APP).toContain("Corporations can now upgrade ${from.toLowerCase()} tiles to ${to.toLowerCase()}.");
    expect(APP).toContain("{ from, to }");
  });
});

/* ------------------------------------------------------------------ */
/* 3: timing                                                           */
/* ------------------------------------------------------------------ */

describe("the phase-change toast is 30% shorter", () => {
  it("is exactly seven tenths of the standard window", () => {
    expect(PHASE_CHANGE_TOAST_MS).toBe(Math.round(STANDARD_TOAST_MS * 0.7));
    expect(PHASE_CHANGE_TOAST_MS).toBe(2590);
  });

  it("is expressed as a multiple, so it cannot drift", () => {
    /* THE STANDARD WINDOW HAS BEEN RETUNED TWICE in this project's life (#983, #1000, #1016 on the private
       toast; #967 on the multiplier). A hand-typed 2590 would silently stop being 70% of it the next time,
       which is #967's own reason for expressing its multiple this way. */
    expect(TOAST).toContain("Math.round(STANDARD_TOAST_MS * 0.7)");
  });

  it("does not retime every other toast in the app", () => {
    /* THE RULING IS ABOUT PHASE-CHANGE TOASTS. Shortening the shared window would have quietly retimed the
       refusal messages and the depot receipt, which were tuned separately and for different reads. */
    expect(STANDARD_TOAST_MS).toBe(3700);
    expect(APP).toContain("PHASE_CHANGE_TOAST_MS");
  });
});

describe("the action bar does not flicker through skipped steps", () => {
  it("draws a held step while a run of skips resolves", () => {
    expect(APP).toContain("const displayedSubPhase = autoSkipPending");
    expect(APP).toContain("orSubPhase={displayedSubPhase}");
  });

  it("cannot freeze past the run it is describing", () => {
    /* THE HAZARD, AND THE CLAUSE THAT REMOVES IT. `autoSkippedRef` holding this turn's key means the effect
       will NOT dispatch -- so a freeze condition that asked only "is there a reason" would hold the bar
       frozen for the rest of the turn. The condition is the effect's own three facts, re-asked, so it cannot
       outlive the dispatch it exists to hide.
       DERIVED, NOT LATCHED, for the same reason: there is no stored flag here to be left set. */
    const cond = sliceBetween(APP, "const autoSkipPending =", "const settledSubPhaseRef");
    expect(cond).toContain("autoSkipReason !== null");
    expect(cond).toContain("isMyTurn");
    expect(cond).toContain("!autoSkippedRef.current.has(");
    expect(APP).not.toContain("const [autoSkipPending, setAutoSkipPending]");
  });

  it("changes what is drawn and not where the turn is", () => {
    /* THE LINE THIS FIX MUST NOT CROSS. A second cursor -- one the reducer uses and one the bar believes --
       is #891 with the stakes raised from a wrong colour to a wrong action. Exactly one prop reads the held
       value; every rule, gate and dispatch still reads `orSubPhase`. */
    expect(APP.split("displayedSubPhase").length - 1).toBeLessThanOrEqual(3);
    expect(APP).not.toContain("displayedSubPhase ===");
  });
});

/* ------------------------------------------------------------------ */
/* 4: the audio popover                                                */
/* ------------------------------------------------------------------ */

describe("the audio popover's three controls", () => {
  it("names both states in aria-label even though the switch dropped visible text", () => {
    /* Design note #1103 REVERSED #1094's visible-text ruling, not its underlying goal. #1094 needed
       "On — click to turn off" / "Off — click to restore" ON THE ROW because colour was the row's only other
       signal. A switch has two colour-independent signals of its own -- thumb position and `aria-checked` --
       so the full sentence stays required only where it was always doing the real work: what a screen reader
       is told. Both halves of that sentence still say what is true, then what a click does. */
    expect(POPOVER).toContain("`Turn ${title.toLowerCase()} off`");
    expect(POPOVER).toContain("`Turn ${title.toLowerCase()} back on`");
    /* AND THE TOGGLE IS STILL A TOGGLE to a screen reader -- `role="switch"` plus `aria-checked` now, the
       correct pairing for this shape, replacing #1078's `aria-pressed` fix rather than dropping it. */
    expect(POPOVER).toContain('role="switch"');
    expect(POPOVER).toContain("aria-checked={enabled}");
  });

  it("lets the slider turn the channel back on", () => {
    /* RULED: interacting with the slider while the master is Off switches it On.
       WHICH REQUIRED DROPPING `disabled`, and that is a deliberate reversal of half of #1075: a disabled
       input fires no events at all, so there is no interaction to notice and the rule could not be
       implemented over it. Asserted as an absence because the attribute returning is exactly how this
       regresses.
       Design note #1103 moved the slider out of the `<label>` #1075 wrapped it in -- the switch now sits
       beside it on a plain row -- so the slice ends at the input's own close rather than a `</label>` that
       no longer follows it directly. */
    const slider = sliceBetween(POPOVER, 'type="range"', "/>");
    expect(slider).not.toContain("disabled={!enabled}");
    expect(slider).toContain("if (!enabled) onEnabledChange(true);");
  });

  it("keeps #1075's reason for showing the slider at all", () => {
    /* THE HALF OF #1075 THAT WAS RIGHT: it argued against HIDING the slider, because a control that vanishes
       changes the panel's height under the cursor and the level a player set is worth showing them even while
       the channel is silent. Still shown, still holding the level -- styled down rather than switched off. */
    expect(POPOVER).toContain("sliderQuiet");
    expect(POPOVER).toContain("opacity: 0.55");
  });

  it("stops the trigger's own click closing the panel underneath it", () => {
    /* THE TOGGLE WAS ALWAYS WRITTEN CORRECTLY -- `TopBar` does `current === "sfx" ? null : "sfx"`. What beat
       it was two events in order: this listener is on `mousedown`, the toggle on `click`, so a second press
       ran close-then-reopen between frames and looked like a dead control.
       "OUTSIDE" NOW MEANS OUTSIDE THE DISCLOSURE, trigger and panel together, which is what it always should
       have meant. */
    expect(POPOVER).toContain("const bounds = owner?.current ?? panel.current;");
    expect(CONTROLS).toContain("const audioGroup = React.useRef<HTMLSpanElement | null>(null);");
    expect(CONTROLS).toContain("owner={audioGroup}");
    /* BOTH PANELS GET IT. One wired and one forgotten is how this half-regresses. */
    // Design note #1102: both popovers moved with the group that owns them.
    expect(CONTROLS.split("owner={audioGroup}").length - 1).toBe(2);
  });

  it("still closes on a drag that ends outside", () => {
    /* `mousedown` RATHER THAN `click` IS UNCHANGED and still deliberate: a drag that starts on the slider and
       ends outside the panel must not close it mid-gesture, which is exactly how a volume slider gets used.
       The fix changed which element is asked, not which event. */
    expect(POPOVER).toContain('window.addEventListener("mousedown", onDown)');
    expect(POPOVER).not.toContain('window.addEventListener("click", onDown)');
  });
});
