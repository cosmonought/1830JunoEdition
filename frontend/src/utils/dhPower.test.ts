/** @jest-environment node */
//
// The rule, and the two gates it has to override. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 725 (harness): THE ORDER IS THE POWER
// ==================================================================
//
// REPORTED: the D&H's Lay Track button lit F16 and then refused the lay; its Place Station worked on its own;
// and "if another player has already laid track on F16, all of DH's powers are forfeited."
//
// #442 IS THE REASON THIS FILE EXISTS, and it is worth reading before changing anything here. That note
// concluded "the rulebook grants the tile and the token independently -- a corporation may take either, both,
// or neither", built two independent buttons on that basis, and wrote the conclusion into the caption, the
// rules reference and the auction card. It was confidently argued and wrong, and nothing in the codebase
// disagreed with it, because the only statement of the rule WAS the note. So the rule now lives in a function,
// the wording lives in one constant, and both are asserted here.
//
// THE DISCRIMINATING CASE IS THE TOKEN BEFORE THE LAY. Every other case passes against the old code.

import {
  DH_HEX_LABEL,
  DH_POWER_DESCRIPTION,
  DH_PRIVATE_ID,
  DH_TILE_ID,
  dhPowerState,
} from "./dhPower";
import { privateHexFor } from "./privateReservations";

const FRESH = { hexBuilt: false, layUsed: false, tokenUsed: false };

describe("the station is the second half of the lay", () => {
  it("offers the lay and withholds the station at the start", () => {
    /* THE REPORT'S (b). The old panel offered both, so a corporation could take a free F16 token having never
       laid the tile -- the power's cost skipped and its benefit kept. */
    const state = dhPowerState(FRESH);
    expect(state.layAvailable).toBe(true);
    expect(state.tokenAvailable).toBe(false);
  });

  it("says which one to do first rather than 'already used'", () => {
    /* THE WORDING IS THE FEATURE. A greyed button reading "Already used this game" about a power the player
       still holds would be a lie; this one teaches the order. */
    const reason = dhPowerState(FRESH).tokenBlockedReason ?? "";
    expect(reason).toContain(DH_HEX_LABEL);
    expect(reason).toMatch(/first/i);
    expect(reason).not.toMatch(/already used/i);
  });

  it("opens the station once the lay is taken", () => {
    const state = dhPowerState({ ...FRESH, layUsed: true });
    expect(state.tokenAvailable).toBe(true);
    expect(state.tokenBlockedReason).toBeNull();
  });

  it("allows the lay ALONE, which is the other legal branch", () => {
    /* REPORTED: "players either lay track #57 and pay the $120 mountain fee, OR they lay track #57 and pay the
       mountain fee AND place a free station." The station is optional; nothing here may force it. */
    const state = dhPowerState({ hexBuilt: true, layUsed: true, tokenUsed: false });
    expect(state.forfeited).toBe(false);
    expect(state.tokenAvailable).toBe(true);
  });

  it("closes both once each has been spent", () => {
    const spent = dhPowerState({ hexBuilt: true, layUsed: true, tokenUsed: true });
    expect(spent.layAvailable).toBe(false);
    expect(spent.tokenAvailable).toBe(false);
    expect(spent.tokenBlockedReason).toMatch(/already used/i);
  });
});

describe("somebody else building on F16 forfeits everything", () => {
  it("takes both halves when the hex is built and the power is unused", () => {
    const state = dhPowerState({ hexBuilt: true, layUsed: false, tokenUsed: false });
    expect(state.forfeited).toBe(true);
    expect(state.layAvailable).toBe(false);
    expect(state.tokenAvailable).toBe(false);
  });

  it("does NOT forfeit on the power's own lay", () => {
    /* THE CONJUNCTION, AS THE BUG IT PREVENTS. `hexBuilt` alone is the obvious test and it would forfeit the
       power at the instant of using it -- taking the station with it and making the second half unreachable
       by construction, which is the same defect as the report with the opposite cause. */
    expect(dhPowerState({ ...FRESH, hexBuilt: true, layUsed: true }).forfeited).toBe(false);
  });

  it("explains the forfeit rather than greying silently", () => {
    const state = dhPowerState({ hexBuilt: true, layUsed: false, tokenUsed: false });
    expect(state.layBlockedReason).toBe(state.tokenBlockedReason);
    expect(state.layBlockedReason ?? "").toMatch(/already built/i);
  });
});

describe("the rule is stated once, and states what #442 got wrong", () => {
  it("says the lay REPLACES the normal tile lay", () => {
    /* #442's caption said "in addition to its normal lay". Confirmed otherwise, so the correction is asserted
       rather than left to a comment nobody reads next to a string everybody does. */
    expect(DH_POWER_DESCRIPTION).toMatch(/INSTEAD OF its normal tile lay/);
    expect(DH_POWER_DESCRIPTION).not.toMatch(/in addition to its normal (tile )?lay/i);
  });

  it("says the station is extra, and only with the lay", () => {
    expect(DH_POWER_DESCRIPTION).toMatch(/in addition to its normal placement/);
    expect(DH_POWER_DESCRIPTION).toMatch(/only available with the lay/i);
  });

  it("no longer says AND/OR", () => {
    // The single word that made the token independent, and the one a future edit is likeliest to restore.
    expect(DH_POWER_DESCRIPTION).not.toMatch(/AND\/OR/i);
  });

  it("names the connectivity waiver, which is the whole point of the power", () => {
    expect(DH_POWER_DESCRIPTION).toMatch(/ignoring track connection rules/i);
  });

  it("quotes the mountain cost and the tile the report named", () => {
    expect(DH_TILE_ID).toBe(57);
    expect(DH_POWER_DESCRIPTION).toContain("$120");
    expect(DH_POWER_DESCRIPTION).toContain(`#${DH_TILE_ID}`);
  });
});

describe("F16 is the hex the rest of the app already means", () => {
  it("matches the reservation table", () => {
    /* The constants here would be worthless if they named a different hex from the one the board lights. Both
       sides are asserted against the shipped table rather than against each other. */
    const hex = privateHexFor(DH_PRIVATE_ID);
    expect(hex).not.toBeNull();
    expect(hex!.hexLabel).toBe(DH_HEX_LABEL);
  });
});

describe("both connectivity gates are overridden, not just the visible one", () => {
  const app = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  })();

  it("lets the ring open on the power's own hex", () => {
    /* (a)'s FIRST half: #716 refuses to open a picker outside the acting corporation's reach, which is exactly
       what this power exists to ignore.
       DESIGN NOTE 809 MOVED THE GATE AND THIS ASSERTION DID NOT FOLLOW. It used to read the inline
       comparison `privateTileHexKeyRef.current !== \`...\``; #809 lifted the whole gate into
       `inspectorClickRefused` so a watcher's clicks would stop being swallowed, and the exemption became a
       named argument. The RULE is unchanged and is now asserted where it lives -- `privateErrand.test.ts`
       and `inspectorClick.test.ts` both cover it -- so what is left here is that the shell still HANDS the
       exemption over.
       AND I DID NOT RUN THIS FILE AFTER #809, which is how a harness fails for a whole pass without anybody
       noticing: the suites I ran were the ones I had just edited. */
    expect(app).toContain("privateTileHexKey: privateTileHexKeyRef.current,");
  });

  it("lets the picker offer candidates there too", () => {
    /* (a)'s SECOND half, and the one that would have survived fixing the first. Opening the ring with the
       network filter still applied would show an empty carousel -- the same refusal, one step later, and
       arguably more confusing than the original. */
    expect(app).toContain("canLayTileNow && !onPrivateTileHex ? layTrackFocus?.network");
    expect(app).toContain("canLayTileNow && !onPrivateTileHex ? layTrackFocus?.ports");
  });

  it("reads the armed errand from a ref, not from a captured render", () => {
    /* `handleHexClickQuery` is a `useCallback` the canvas holds across renders. Reading the state variable
       there would capture whichever errand was armed when the callback was built -- for a control the player
       arms and THEN clicks, reliably the wrong one. */
    expect(app).toContain("privateTileHexKeyRef.current =");
  });
});
