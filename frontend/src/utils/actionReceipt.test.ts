/** @jest-environment node */
//
// One pure predicate and a source scan; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 718 (harness): SILENCE IS THE DEFAULT
// ==================================================================
//
// REPORTED: "There seem to be toast notifications for literally every action now ... Please remove all the
// toast notifications I did not explicitly ask you to implement."
//
// THE INTERESTING ASSERTIONS ARE THE SILENCES. A predicate that returns `false` is easy to get accidentally
// right, so the cases below are not a spot-check of a few quiet actions: the first test walks the ENTIRE
// gameplay message allow-list and insists every key outside the named set produces nothing. That is the shape
// the bug had -- not "one action wrongly toasted" but "the rule was written at a place that saw everything" --
// and only a test over the whole list would have caught it.
//
// AND IT IS WRITTEN TO FAIL ON GROWTH. `GAMEPLAY_MESSAGE_KEYS` is imported rather than transcribed, so a
// message type added next year is picked up by this test automatically and must be silent unless somebody adds
// it to the receipt set on purpose. A transcribed copy would have quietly stopped covering the new key, which
// is the failure mode of every "list of things to check" written by hand.

import {
  ACTION_RECEIPT_MESSAGE_KEYS,
  deservesActionReceipt,
} from "./actionReceipt";
import { GAMEPLAY_MESSAGE_KEYS } from "./sessionKey";
// Design note #886: a slice that THROWS on a missing anchor, so a case cannot empty itself silently.
import { sliceBetween } from "./sourceScan";

/** A dispatch of one message key, shaped as `runGameplayAction` sees it. */
function msg(key: string): Record<string, unknown> {
  return { [key]: { game_id: 1, protocol_id: 2 } };
}

describe("every action the report named is silent", () => {
  it.each([
    ["BuyStock", "the share count, treasury and market price all move in the panel being read"],
    ["PlaceStationToken", "a token appears on the hex just clicked"],
    ["PassTurn", "the turn indicator moving IS the visible state of a pass"],
    ["LayTile", "the tile is drawn under the cursor"],
  ])("says nothing for %s — %s", (key) => {
    expect(deservesActionReceipt(msg(key))).toBe(false);
  });

  it("says nothing for any gameplay message outside the named set", () => {
    /* THE TEST THAT WOULD HAVE CAUGHT #697, and the reason it is written over the imported allow-list rather
       than over a handful of examples. The bug was never about a particular action -- it was a rule attached
       to a funnel that carries all of them, and any sample small enough to write by hand would have passed. */
    const noisy = GAMEPLAY_MESSAGE_KEYS.filter((key) => deservesActionReceipt(msg(key)));
    expect(noisy.slice().sort()).toEqual(ACTION_RECEIPT_MESSAGE_KEYS.slice().sort());
  });

  it("keeps the receipt set to a small, deliberate few", () => {
    /* Not a style rule. The whole correction is that a receipt is exceptional; a set that has crept to a
       dozen entries means the principle has quietly inverted again, and the number is the cheapest possible
       tripwire for that. */
    expect(ACTION_RECEIPT_MESSAGE_KEYS.length).toBeLessThanOrEqual(3);
  });
});

describe("the depot purchase keeps its receipt", () => {
  it("gives one to the Buy Trains button", () => {
    /* #697'S ACTUAL REPORT: "of the Buy Trains step: it is slightly hard to tell whether the purchase went
       through ... somehow it is hard to tell if you purchased anything." The treasury is on a card, the supply
       is in a table, the fleet is a row of chips, and the player is looking at a button. */
    expect(deservesActionReceipt(msg("BuyHardwareFromPool"))).toBe(true);
  });

  it("gives one to the forced emergency purchase", () => {
    /* The same panel and the same invisibility, at a moment when a president is markedly LESS sure what has
       just happened to them. */
    expect(deservesActionReceipt(msg("EmergencyBuyHardware"))).toBe(true);
  });

  it("does not give one to a corporation-to-corporation trade", () => {
    /* A JUDGEMENT, recorded because it is the one exclusion that is not obvious: this IS a train purchase and
       it IS invisible at the click. But since #701 it settles through a consent handshake, and the modal
       resolving on an accepted answer is a confirmation already delivered where the player is looking. A
       toast behind it would be the second receipt for a single decision. */
    expect(deservesActionReceipt(msg("BuyTrainFromCorporation"))).toBe(false);
  });
});

describe("the predicate is not fooled by the shape of its input", () => {
  it("ignores a message that merely mentions a receipt key as a value", () => {
    // Keys, not contents: a label or payload that happens to contain the word must not trigger one.
    expect(deservesActionReceipt({ PassTurn: { note: "BuyHardwareFromPool" } })).toBe(false);
  });

  it("survives null, undefined and non-objects", () => {
    /* `runGameplayAction` is called from forty places and this guard is the only thing between a malformed
       dispatch and a crash inside a send path that has already reached the network. */
    for (const bad of [null, undefined, 0, "BuyHardwareFromPool", []]) {
      expect(deservesActionReceipt(bad)).toBe(false);
    }
  });
});

describe("a toast marks a move, not a catch-up (design note #825)", () => {
  /* ==================================================================
      #670 WROTE THIS RULE FOR BADGES AND THE TOASTS NEVER ASKED IT
     ==================================================================

     REPORTED: "when Undoing any action, a toast notification surfaces about the last corporation's payout.
     There shouldn't be any toast notifications on Undo."

     #670's note is still in the drain, unchanged: "A BADGE MARKS A MOVE, NOT A CATCH-UP ... Joining a room
     replays a whole game, and an undo rebuilds from the fixture -- in both, every balance on the board
     changes, and firing a badge per change would carpet the strip with figures about events that are minutes
     old." The cash badges have honoured that since the day it was written. #718's receipt and #786/#795's
     payout notice arrived afterwards and inherited nothing.

     AND A PAYOUT TOAST IS WORSE THAN NOISE HERE, because it is a CLAIM: money has just moved. During a
     rebuild nothing has -- the board is being restored to a state it already reached, and the entry being
     replayed is one the player is in the middle of undoing.

     `isOrdinaryPlay` ALREADY EXISTED and was already deciding whether a badge fires. Publishing it as a flag
     is the whole change; the rule was never in doubt, only its audience. */

  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  })();

  it("gates every door rather than the call sites", () => {
    /* #748a's rule: a call site that has to remember is one that will forget, and the next toast added would
       have forgotten too. Entry points carry the guard; call sites carry nothing.

       ==================================================================
        DESIGN NOTE 1049: THIS PINNED THE NUMBER 2, AND THE NUMBER WAS NEVER THE PROPERTY
       ==================================================================

       A THIRD RAISER ARRIVED -- `showPrivatePayoutPhase`, for the payout phase that used to be a toast -- and
       it carries the guard exactly as the rule requires. The case failed anyway, because it asserted "there
       are two guards" where the rule is "every raiser has one". A correct change broke a test that was
       measuring a proxy for what it cared about, which is this codebase's fifth recurring bug shape sitting
       inside the harness rather than the source.

       SO THE COUNT IS DERIVED NOW INSTEAD OF WRITTEN DOWN TWICE. Every `const show* = useCallback(` in this
       file is a raise-a-notification entry point, and the assertion is that the guards and the doors are the
       same number. A fourth raiser added WITH a guard passes without anybody editing this file; a fourth
       added WITHOUT one fails, which is the failure the case exists to produce.

       THE THREE ARE STILL NAMED BELOW, deliberately. The derived count alone would be satisfied by zero
       doors and zero guards -- the vacuity #886 is about -- so the roster is what proves there is something
       under it, and a raiser RENAMED out of the `show*` shape would take its guard off this count silently. */
    const doors = APP.match(/const show[A-Za-z]* = useCallback\(/g) ?? [];
    const guards = APP.match(/if \(replayingHistory\) return;/g) ?? [];
    expect(doors.length).toBeGreaterThanOrEqual(3);
    expect(guards).toHaveLength(doors.length);
    expect(APP).toContain("const showDividendToast = useCallback(");
    expect(APP).toContain("const showActionToast = useCallback(");
    // Design note #1049: the payout phase's raiser -- a modal rather than a toast, and the same rule applies.
    expect(APP).toContain("const showPrivatePayoutPhase = useCallback(");
  });

  it("takes the answer from the drain's own predicate", () => {
    // Not a second definition of "is this a replay" -- #670's `isOrdinaryPlay`, published.
    expect(APP).toContain("replayingHistory = !isOrdinaryPlay;");
    expect(APP).toContain("const isOrdinaryPlay = !rewound && pending === 1;");
  });

  it("clears the flag even when a dispatch throws", () => {
    /* A stuck flag silences every later toast, which reads as "notifications stopped working" and has no
       obvious cause -- the same reasoning the `replayClock` beside it already carries, and the reason both
       are cleared in the same `finally`. */
    const drain = APP.slice(
      APP.indexOf("replayingHistory = !isOrdinaryPlay;"),
      APP.indexOf("if (cashBefore && live)"),
    );
    expect(drain).toContain("} finally {");
    expect(drain).toContain("replayingHistory = false;");
  });

  it("resets with the log clock on a rewind", () => {
    // `resetLogClock` runs before the replay loop; a flag left true from a previous run would silence it.
    const start = APP.indexOf("function resetLogClock");
    expect(start).toBeGreaterThan(-1);
    expect(APP.slice(start, start + 220)).toContain("replayingHistory = false;");
  });

  it("leaves the badges alone", () => {
    /* THE CONTROL. #670's own gate is what this borrows from, and borrowing must not disturb it -- the cash
       badge still asks `isOrdinaryPlay` directly, one line away. */
    expect(APP).toContain("const cashBefore = isOrdinaryPlay ? cashByPlayer(sandboxStateRef.current) : null;");
  });
});

describe("every toast is mounted behind a rule", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  })();

  it("has exactly two call sites", () => {
    /* THE STRUCTURAL HALF. The predicate could be perfect and the bug could return tomorrow by way of a
       `showActionToast` somewhere else in the file -- which is exactly how the first one spread. Reading the
       source is a weak instrument, and it is the only one that can see this.
       WAS ONE; #784 ADDED THE REFUSAL NOTICE (reported as "there was no notification that the player was at
       certificate limit", the rule having lived in a disabled button's tooltip). #786 briefly added a third
       and #795 withdrew it -- see the note there: `showDividendToast` had covered that case since #400 and I
       built a duplicate while hunting the reason the original quoted a wrong figure.
       THE COUNT IS NOT THE PROPERTY WORTH GUARDING -- #718's actual complaint was "toast notifications for
       literally every action", which is about toasts that are not behind a CONDITION. The count is pinned so
       that changing it is a decision rather than a drift, and each site's guard is named individually below.
       Moving this number without moving the guard list is the thing to refuse. */
    const calls = APP.match(/^\s*showActionToast\(/gm) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("gates the receipt on the message deserving one", () => {
    expect(APP).toContain("deservesActionReceipt(msg)");
  });

  it("raises the receipt from the sentence the log gets", () => {
    /* ==================================================================
     *  DESIGN NOTE 794: THE RECEIPT MOVED TO WHERE THE TRUTH IS
     * ==================================================================
     *
     * REPORTED three runs running: "the Dividends and the Activity Log showed the correct amounts, but the
     * toast notification said B&O paid $5 per share ... I'm not sure why you don't have the toast
     * notifications pulling from the same source as the Activity Log."
     *
     * THE FIGURES NAMED IT. $100 reported as $50; $150 as $50; $190 as $70; PRR's $70 as $30. Every wrong
     * number is one train's worth of a multi-train run -- the toast was built at DISPATCH time from this
     * browser's React state, which had caught up with some of the turn's `RunManualRoute` messages and not
     * all of them. The drain has all of them, which is why the log was right every time.
     *
     * SO THE ORDER MATTERS AND IS ASSERTED: the toast must sit AFTER the label is rebuilt with `afterState`,
     * not before. Raising it a few lines earlier would silently restore the bug with the code in the right
     * file. */
    /* ==================================================================
        DESIGN NOTE 1054: ANCHORED ON THE CALL, NOT ON ITS FORMATTING
       ==================================================================
       THIS PINNED `afterState: after }) ?? label;` -- the rebuild written as one line. #1054 added
       `marketMove` to that context so the dividend sentence could carry the atom's price move, which broke
       the object across lines and left the anchor at -1.
       AND -1 IS WHY THIS CASE HAS ITS GUARD. `indexOf` returning -1 would have made the ORDERING comparison
       below vacuous rather than red: -1 is less than every real index, so `rebuilt < raised` would have
       passed with nothing under it. That guard is `sourceScan` #886's whole argument, written inline here
       before the helper existed, and it did exactly its job.
       RE-ANCHORED ON THE CALL ITSELF, which is the thing that must come first. A reformat moves the braces;
       it does not move `describeGameplayAction`. */
    /* Design note #1063: THE ARGUMENT CHANGED AND THE ORDER DID NOT. This anchored on
       `showActionToast(label)`; the receipt now takes the train purchase's own short sentence when there is
       one (`showActionToast(globallyBroadcast ?? label)`), so the literal moved. Re-anchored on the CALL,
       which is what the ordering is about -- pinning the argument list again would break on the next caller
       that passes something else, which is the mistake this file has now recorded twice. */
    const rebuilt = APP.indexOf("describeGameplayAction(msg, {");
    /* Design note #1072: the call went multi-line when the depot toast gained its own duration, so the
       argument is no longer adjacent to the name. Anchored on the CALL, which is what the ordering is
       about -- and which no reformat can move. */
    const raised = APP.indexOf("showActionToast(");
    expect(rebuilt).toBeGreaterThan(-1);
    expect(raised).toBeGreaterThan(rebuilt);
  });

  it("no longer fires from the append branch", () => {
    /* #697 put it there to be immediate, and immediacy bought a figure that could be wrong. A receipt whose
       whole job is to be trusted must not quote a number the player did not receive. */
    /* ==================================================================
        THIS CASE HAD BEEN VACUOUS, AND #886 NAMES EXACTLY HOW
       ==================================================================
       IT SLICED BETWEEN `const ok = await appendSandboxAction` AND `Setup is handled first and returns`.
       Neither string exists anywhere in the tree -- the first became `const allocated = await
       appendSandboxAction(` when #1026 changed the return from a boolean to the allocated index, and the
       second was a comment that has since been rewritten. `indexOf` returned -1 for both, `slice(-1, -1)` is
       the empty string, and `expect("").not.toContain(...)` passes for any source at all.
       SO IT HAS BEEN GREEN WITHOUT CHECKING ANYTHING for however long, which is `sourceScan` #886's whole
       subject: "the recurring vacuity in these tests is not a wrong assertion, it is an assertion with
       nothing under it." FOUND BY SWEEPING every App anchor in every suite for resolution, not by reading.
       RE-ANCHORED ON `sliceBetween`, which THROWS on a missing anchor and names it. A case that cannot
       silently empty itself is the fix; re-pointing the strings alone would leave the same trap armed. */
    const appendBranch = sliceBetween(
      APP,
      "const appendAt = appliedIndexRef.current;",
      "appliedIndexRef.current = appendAt + 1;",
    );
    /* BOUNDED BY THE BRANCH, NOT BY A LATER LANDMARK. A first re-anchoring ended this at
       `refreshGameState();` and produced a 42,000-character slice that swallowed the toast site itself -- an
       assertion that would have failed for the opposite of the right reason. `sliceBetween` searches the end
       anchor FORWARD FROM THE START (#886), so the trap is a loose end anchor rather than a missing one, and
       the guard against it is asserting the slice is the size of a branch rather than merely non-empty. */
    expect(appendBranch.length).toBeGreaterThan(0);
    expect(appendBranch.length).toBeLessThan(2000);
    expect(appendBranch).not.toContain("showActionToast(");
  });

  it("still reaches only the player who acted", () => {
    /* The drain runs on every client, so the actor test does the job #697's placement used to. It is #786's
       comparison inverted, which is what makes the receipt and the payout notice mutually exclusive rather
       than two notices for one event. */
    expect(APP).toContain(
      "(options?.actor ?? viewerAddressRef.current) === viewerAddressRef.current",
    );
  });

  it("gates the refusal notice on there being a refusal and a reason", () => {
    /* #784's site. Three conditions, and the third is the one that matters at a table: a replayed refusal
       must not tell all four players about one player's blocked purchase. */
    expect(APP).toContain("if (refusalWasRefused && refusalReason && options?.isRemoteReplay !== true)");
  });

  it("leaves the payout notice to the function that already had it", () => {
    /* #795: the dividend notice is `showDividendToast`, a separate control with its own gate, and it reaches
       every shareholder rather than only the actor. #786 added a second one to `showActionToast` and was
       withdrawn -- the case was covered, the FIGURE was wrong, and I mistook one for the other. */
    expect(APP).toContain("showDividendToast(");
    expect(APP).not.toContain("viewer !== options?.actor");
  });

  it("leaves no unguarded call", () => {
    /* The property #718 was really after: every call site sits inside an `if`/`else if`. One named guard per
       call, so the count above and this list have to be changed together. */
    const guards = ["deservesActionReceipt(msg)", "refusalWasRefused && refusalReason"];
    for (const guard of guards) {
      expect(APP).toContain(guard);
    }
    expect(guards).toHaveLength((APP.match(/^\s*showActionToast\(/gm) ?? []).length);
  });
});
