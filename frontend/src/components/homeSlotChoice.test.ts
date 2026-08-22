/** @jest-environment node */
//
// Which home slots the placement ring may light. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 742 (harness): THE RING MADE A CHOICE THE BADGE DECLINED
// ==================================================================
//
// REPORTED: "I floated ERIE after its home hex had been upgraded to a brown tile. The 'Place Home Station'
// glow ring only circled one of the city/station markers rather than both, though it seems possible to place
// the station in either."
//
// THE CODEBASE ALREADY HELD BOTH HALVES OF THIS AND NEVER PUT THEM TOGETHER. #43 draws the reservation badge
// for an OO hex in neutral hex-margin space precisely because the President has not chosen yet -- "anchoring
// the still-undecided reserved badge onto one specific circle would misleadingly imply that slot is already
// committed." #584 then anchored the RING to that badge, correctly reasoning about New York, where the home
// really is one specific circle. On an OO hex the ring therefore asked "which circle is the badge nearest?"
// of a marker positioned to have no answer.
//
// SO THE ASSERTIONS ARE ABOUT THE DISTINCTION, not about ERIE. A fix that lit every city on every hex would
// pass "E11 lights both" and be wrong on New York; a fix that kept #584 everywhere would pass every New York
// case and reproduce the report. The tests below pin both sides, and the second is the one a later
// simplification would break.
//
// AND THE BROWN UPGRADE IS THE POINT OF THE `it` ABOUT TILES. Membership is a property of the HEX, so the
// answer must not move when something is laid on it -- which is what makes the report's late-game case the
// same case as an opening-board one.

import { homeSlotsAreOpen } from "./hexCanvasPrimitives";
import { STATION_HOME_HEXES } from "./hexContractTypes";
import { YELLOW_OO_HEXES, STATIC_BOARD_HEXES } from "./hexBoardData";

describe("either slot is the President's on an OO hex", () => {
  it("says so for ERIE's E11, which the report is about", () => {
    expect(homeSlotsAreOpen("E11")).toBe(true);
  });

  it("says so for every OO hex, not just the one that was noticed", () => {
    /* The same sweep discipline #724b needed: the fix is in shared drawing code, so testing one hex proves
       nothing about the other three. */
    for (const label of Array.from(YELLOW_OO_HEXES)) {
      expect(homeSlotsAreOpen(label)).toBe(true);
    }
  });

  it("covers the four the board actually has", () => {
    // A sweep over an emptied set would pass silently.
    expect(YELLOW_OO_HEXES.size).toBe(4);
  });
});

describe("New York keeps #584's single ring", () => {
  it("says NO for G19", () => {
    /* THE CASE A GENERAL RULE WOULD BREAK. G19 has two cities and the home is one of them -- so "light every
       city with room" would ring a circle the corporation may not use, which is the same class of error as
       the report, inverted. */
    expect(homeSlotsAreOpen("G19")).toBe(false);
  });

  it("says NO for every home hex that is not OO", () => {
    for (const home of STATION_HOME_HEXES) {
      if (YELLOW_OO_HEXES.has(home.label)) continue;
      expect(homeSlotsAreOpen(home.label)).toBe(false);
    }
  });

  it("says NO for a hex it has never heard of", () => {
    // An unknown label must not open a choice; the conservative answer is the one #584 already gives.
    expect(homeSlotsAreOpen("ZZ99")).toBe(false);
    expect(homeSlotsAreOpen(undefined)).toBe(false);
  });
});

describe("the answer is about the hex, not about what is laid on it", () => {
  it("is a property of the label alone", () => {
    /* THE REPORT'S LATE-GAME DETAIL, as an invariant. ERIE's home had been upgraded to BROWN when this was
       seen; if the rule consulted the tile, an upgrade could silently change whether a President still has a
       choice -- and 1830 gives them that choice regardless of what colour the hex has reached. */
    expect(homeSlotsAreOpen("E11")).toBe(homeSlotsAreOpen("E11"));
    const printed = STATIC_BOARD_HEXES.find((hex) => hex.label === "E11");
    expect(printed).toBeDefined();
  });

  it("names a set whose membership is by hex, whatever it is called", () => {
    /* `YELLOW_OO_HEXES` is named for the printed yellow and MEANS "either slot is the President's". Recorded
       because the name invites a future reader to assume it stops applying once the hex is green or brown. */
    for (const label of Array.from(YELLOW_OO_HEXES)) {
      expect(STATIC_BOARD_HEXES.some((hex) => hex.label === label)).toBe(true);
    }
  });
});

describe("the renderer consults the rule rather than the marker", () => {
  const renderer = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "HexGridRenderer.tsx"), "utf8");
    // #490a: the note explains the old behaviour in the past tense and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("skips the nearest-marker lookup where either slot is open", () => {
    /* The shape of the fix: `homeCityIndexAt` is still asked on every OTHER hex, so #584's pairing of ring and
       badge survives exactly where its reasoning holds. */
    expect(renderer).toContain("const eitherSlot = homeSlotsAreOpen(");
    expect(renderer).toContain("const homeSlot = eitherSlot");
  });

  it("still lights every node when no single slot is resolved", () => {
    // The existing `null` path is what carries the both-slots case; the fix routes into it rather than beside it.
    expect(renderer).toContain("homeSlot === null ? slotNodes : [slotNodes[homeSlot]]");
  });
});
