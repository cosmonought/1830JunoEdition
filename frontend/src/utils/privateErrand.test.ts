/** @jest-environment node */
//
// An armed private power has a beginning, an end and a way out. No DOM.
//
// ==================================================================
//  DESIGN NOTE 817 (harness): FOUR SYMPTOMS, ONE MISSING LIFECYCLE
// ==================================================================
//
// REPORTED as four separate things, and they are one:
//   4)  no visible way to escape an armed power;
//   4a) "I placed a tile that was not the F16 one, and it seems the DH power was consumed";
//   4b) the station power opening a TILE selector on any hex, with the confirm disabled -- "so it seems like
//       the Special Power is technically disabled, it just affords players the opportunity to find out that
//       it isn't";
//   4c) the errand surviving into Run Routes, where a free station was then placed.
//
// THE ERRAND WAS A VEIL, NOT A MODE. It lit one hex and left two click handlers to decide independently
// whether a click was theirs, with nothing anywhere saying what cancelling meant, which completed action
// belonged to it, or when it stopped mattering. Each of those three questions was answered -- differently --
// by an `if` in a different callback, and two of them were not answered at all.
//
// 4b's ROOT IS 4a, which is worth stating because it is the one that looks like a separate bug. The station
// power was only ever offered because `dh-tile` had been wrongly marked used; with the lay correctly scoped,
// `dhPowerState.tokenAvailable` stays false until the F16 tile actually exists, and the button that led to
// the disabled checkmark is not green in the first place.
//
// THE HOME STATION IS THE CONTROL CASE, and it is why this is a table rather than a rule. It shares the veil
// and shares none of the answers: it is compulsory, the table is blocked on it (#783), and a lifecycle that
// treated all three errands alike would have made the one placement nobody may skip skippable.

import {
  errandCancelLabel,
  errandClaimsLay,
  errandClickIntent,
  errandSurvivesStep,
} from "./privateErrand";

const F16 = { q: 3, r: 6 };
const ELSEWHERE = { q: 9, r: 9 };

const tile = { kind: "private-tile" as const, ...F16 };
const station = { kind: "private-station" as const, ...F16 };
const home = { kind: "home-station" as const, ...F16 };

describe("a click off the hex is a way out", () => {
  it("cancels an optional power", () => {
    /* THE (4) FIX. The escape already existed in effect -- "I can escape it by clicking the veiled legal
       placement options and laying track there" -- and was never anybody's decision. */
    expect(errandClickIntent(tile, ELSEWHERE.q, ELSEWHERE.r)).toBe("cancel");
    expect(errandClickIntent(station, ELSEWHERE.q, ELSEWHERE.r)).toBe("cancel");
  });

  it("does not cancel a compulsory home station", () => {
    /* THE CONTROL, and the reason the three errands cannot share one answer. A home token is placed on
       floating, the whole table waits for it (#783's modal exists for that), and there is nowhere else to
       go. Making the escape uniform would have made this one escapable. */
    expect(errandClickIntent(home, ELSEWHERE.q, ELSEWHERE.r)).toBe("ignore");
  });

  it("completes on its own hex, whatever the kind", () => {
    for (const errand of [tile, station, home]) {
      expect(errandClickIntent(errand, F16.q, F16.r)).toBe("complete");
    }
  });

  it("says nothing when nothing is armed", () => {
    expect(errandClickIntent(null, F16.q, F16.r)).toBe("ignore");
  });

  it("offers a named exit for the optional powers only", () => {
    /* The other half of (4): the escape has to be VISIBLE. "They may think once they click the Special Power
       they have no choice but to follow through on it" is a report about discoverability, not about
       mechanics -- the mechanics worked. */
    expect(errandCancelLabel(tile)).toBe("Cancel Track Lay");
    expect(errandCancelLabel(station)).toBe("Cancel Station");
    expect(errandCancelLabel(home)).toBeNull();
    expect(errandCancelLabel(null)).toBeNull();
  });
});

describe("only the errand's own lay spends the power", () => {
  it("claims a tile laid on its hex", () => {
    expect(errandClaimsLay(tile, F16.q, F16.r)).toBe(true);
  });

  it("REGRESSION (4a): does not claim a tile laid anywhere else", () => {
    /* THE REPORTED BUG, and the whole of it. `handleConfirmRadialLay` tested that an errand was ARMED, not
       that the lay was the errand's -- so an ordinary tile on an ordinary hex consumed the D&H's power and
       unlocked its free token. The note above that line already said "marked spent on the LAY, not on the
       button press", which is the right intent asked the wrong way. */
    expect(errandClaimsLay(tile, ELSEWHERE.q, ELSEWHERE.r)).toBe(false);
  });

  it("claims nothing for a station or a home errand", () => {
    // A station errand ends in a token and a home errand lays nothing; neither may consume a tile lay.
    expect(errandClaimsLay(station, F16.q, F16.r)).toBe(false);
    expect(errandClaimsLay(home, F16.q, F16.r)).toBe(false);
    expect(errandClaimsLay(null, F16.q, F16.r)).toBe(false);
  });
});

describe("an errand ends with its step", () => {
  it("REGRESSION (4c): a station errand does not survive into Run Routes", () => {
    /* THE REPORTED BUG: "even once I skipped the Station Marker subphase into the Run Routes one, my cursor
       still showed the herald ... and indeed I was then able to place the station for free on the untiled
       F16 *in the middle* of Run Routes." */
    expect(errandSurvivesStep(station, "Tokens")).toBe(true);
    expect(errandSurvivesStep(station, "Routes")).toBe(false);
    expect(errandSurvivesStep(station, "Track")).toBe(false);
  });

  it("keeps a tile errand to the Track step", () => {
    expect(errandSurvivesStep(tile, "Track")).toBe(true);
    expect(errandSurvivesStep(tile, "Tokens")).toBe(false);
    expect(errandSurvivesStep(tile, "Routes")).toBe(false);
  });

  it("keeps a home station through every step and round", () => {
    /* It is raised when a corporation FLOATS, which happens in a Stock Round, so an Operating Round step is
       not a fact about it at all. `null` is the Stock Round case and must not tear it down. */
    for (const step of ["Track", "Tokens", "Routes", "Dividends", "Hardware", null]) {
      expect(errandSurvivesStep(home, step)).toBe(true);
    }
  });

  it("drops a private errand when the step is unknown", () => {
    /* An errand that cannot see the step cannot claim to belong to it, and the safe direction is out: an
       un-armed power is re-armable from its button, where an armed one over the wrong step is what produced
       a free station in the middle of Run Routes. */
    expect(errandSurvivesStep(tile, null)).toBe(false);
    expect(errandSurvivesStep(station, null)).toBe(false);
  });
});

describe("the shell asks these rather than keeping its own copies", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  })();

  it("scopes the lay to the errand's hex", () => {
    expect(APP).toContain("if (errandClaimsLay(homeStationPlacement, q, r)) {");
    expect(APP).not.toContain('if (homeStationPlacement?.kind === "private-tile") {');
  });

  it("routes the click through one intent rather than two silent returns", () => {
    expect(APP).toContain("const intent = errandClickIntent(placement, q, r);");
    expect(APP).toContain('if (intent === "cancel") {');
  });

  it("tears the errand down when the step moves", () => {
    expect(APP).toContain("errandSurvivesStep(armed, orSubPhase) ? armed : null");
  });

  it("hands the bar a named exit", () => {
    expect(APP).toContain("errandCancelLabel(homeStationPlacement)");
  });
});
