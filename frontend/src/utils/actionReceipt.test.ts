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

describe("the toast is mounted once, behind the rule", () => {
  it("has exactly one call site, and it is guarded", () => {
    /* THE STRUCTURAL HALF. The predicate could be perfect and the bug could return tomorrow by way of a second
       `showActionToast` somewhere else in the file -- which is exactly how the first one spread. Reading the
       source is a weak instrument, and it is the only one that can see this. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const calls = app.match(/^\s*showActionToast\(/gm) ?? [];
    expect(calls).toHaveLength(1);
    expect(app).toContain("deservesActionReceipt(msg)");
  });
});
