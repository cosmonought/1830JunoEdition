/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1125-1128 (harness): A DEBUG FLAG THAT CROSSES MACHINES, AND A RADIO THAT STOPS HIDING
// ==================================================================
//
// THE BATCH'S ONE HARD ITEM was asked for as "a state flag the engine reads at the next valid mechanical
// window, bypassing the normal RNG check". Two words in that sentence did not survive contact:
//
//   "the RNG check"  -- there are three stages with three sets of gates, and one of them has no roll at all.
//   "a state flag"   -- in the host's browser it would be armed on one machine and read on another.
//
// So the cases here are mostly about the SEAM: that the flag names its stage, that it lives on the document
// every client is subscribed to, and that a force skips chance without skipping the state that makes the
// resulting sentence true.

export {};

const { readStripped, readShell } = require("./sourceScan") as typeof import("./sourceScan");
const {
  resolveFlavourLine,
  YELLOW_SIGN_MALUS_LINE,
  YELLOW_SIGN_BONUS_LINE,
  CARCOSA_FOG_LINE,
  NO_YELLOW_SIGN,
} = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");

const APP = readShell();
const ROOM = readStripped("utils/sandboxRoom.ts");
const CONTROLS = readStripped("components/AudioControls.tsx");
const LEDGER = readStripped("components/FinancialLedger.tsx");
const WATERFALL = readStripped("components/WaterfallAuctionDashboard.tsx");

/** A turn whose natural draw is an ordinary line and whose roll is not a critical bonus -- i.e. a turn on
 *  which nothing would happen. Everything below forces against this baseline, so a pass means the force did
 *  the work rather than the turn happening to qualify. */
const QUIET_TURN = {

/* Design note #1151 superseded the SPELLING of the radius assertions in this file, not their claims. The app held twelve
   near-identical radii doing the work of one; they are three named steps now, so a case that pinned a pixel value was
   testing the literal rather than the property it stood for. Each reads the token it now is. */

  naturalLine: "an ordinary day on the line.",
  /* A REAL BUCKET NAME, and the first draft used `"smallBonus"`, which is not one -- `skipFrom` indexes
     `UNPREDICTABLE_REVENUE_FLAVOR[bucket]` and an invented key made it read `.length` off `undefined`. The
     five real buckets are criticalMalus / minorMalus / unchanged / minorBonus / criticalBonus. `minorBonus`
     is deliberately NOT `criticalBonus`, so the Carcosa case below proves the force skipped that gate rather
     than the turn happening to satisfy it. */
  bucket: "minorBonus" as const,
  ticker: "B&O",
  parts: { turnSeed: 7, macroRound: 1, companyId: 4 } as never,
  state: NO_YELLOW_SIGN,
  phaseTier: "2",
  owned: ["2", "3"] as readonly string[],
};

describe("a forced stage skips the chance, not the story", () => {
  it("does nothing at all when nothing is armed", () => {
    const out = resolveFlavourLine({ ...QUIET_TURN, forced: null });
    expect(out.stage).toBeNull();
  });

  it("fires the Mark on a turn that never drew it", () => {
    /* THE MARK'S REAL GATE IS THE DRAW -- the hash has to land on its line, which no amount of playing can
       hurry. That plus the phase window is what a force skips. */
    const out = resolveFlavourLine({ ...QUIET_TURN, forced: "mark" });
    expect(out.stage).toBe("mark");
    expect(out.line).toBe(YELLOW_SIGN_MALUS_LINE);
  });

  it("refuses to mark a corporation with no train to lose", () => {
    /* ==================================================================
        DESIGN NOTE 1128: WHAT A FORCE MUST NOT BYPASS
       ==================================================================
       The Mark's sentence names the train it deletes. Forced onto a corporation holding none, it would print
       a line about a train that does not exist -- so the prerequisite stands and the flag stays armed for a
       corporation that can carry it. "The next available window", as ruled. */
    const out = resolveFlavourLine({ ...QUIET_TURN, owned: [], forced: "mark" });
    expect(out.stage).toBeNull();
  });

  it("refuses to mark a game that already has a mark", () => {
    const out = resolveFlavourLine({
      ...QUIET_TURN,
      state: { markedTicker: "PRR", carcosaSeen: false },
      forced: "mark",
    });
    expect(out.stage).toBeNull();
  });

  it("fires Carcosa without a critical bonus, a Phase 5, or the roll", () => {
    /* ALL THREE GATES AT ONCE, which is the point: the bucket is `minorBonus`, the phase is 2, and the seed
       is one that does not hit. Only the marked-corporation state is satisfied. */
    const out = resolveFlavourLine({
      ...QUIET_TURN,
      state: { markedTicker: "B&O", carcosaSeen: false },
      forced: "carcosa",
    });
    expect(out.stage).toBe("carcosa");
    expect(out.line).toBe(YELLOW_SIGN_BONUS_LINE);
  });

  it("will not escalate a corporation that was never marked", () => {
    // It is that corporation's story. Forcing past this would print somebody else's sentence.
    const out = resolveFlavourLine({ ...QUIET_TURN, forced: "carcosa" });
    expect(out.stage).toBeNull();
  });

  it("will not escalate twice", () => {
    const out = resolveFlavourLine({
      ...QUIET_TURN,
      state: { markedTicker: "B&O", carcosaSeen: true },
      forced: "carcosa",
    });
    expect(out.stage).toBeNull();
  });

  it("forces the Fog, which had no roll to bypass in the first place", () => {
    const out = resolveFlavourLine({ ...QUIET_TURN, fogDue: false, forced: "fog" });
    expect(out.stage).toBe("fog");
    expect(out.line).toBe(CARCOSA_FOG_LINE);
  });

  it("leaves the natural paths exactly as they were", () => {
    /* THE REGRESSION THIS BATCH COULD MOST EASILY HAVE CAUSED. Every gate was rewritten to admit a bypass;
       with nothing armed, an ordinary game has to behave identically. */
    const natural = resolveFlavourLine({
      ...QUIET_TURN,
      naturalLine: YELLOW_SIGN_MALUS_LINE,
      forced: null,
    });
    expect(natural.stage).toBe("mark");
    const blocked = resolveFlavourLine({
      ...QUIET_TURN,
      naturalLine: YELLOW_SIGN_MALUS_LINE,
      phaseTier: "5",
      forced: null,
    });
    expect(blocked.stage).toBeNull();
  });
});

/* LIVE-2D (LIVE-2 §9.4, §13.1): #1128's flag lived on the legacy room DOCUMENT so it could cross machines. The document
   is gone, and every table is server-dealt and pinned -- where the waiver was always dropped at ingress and refused by
   the reducer -- so the tool is deleted end to end. What stays pinned is that nothing of it survives to be armed. */
describe("the flag is gone with the room document it lived on (LIVE-2D)", () => {
  it("is on no room, in no shell state, and sent by no one", () => {
    expect(ROOM).not.toContain("forcedSign");
    expect(ROOM).not.toContain("setSandboxForcedSign");
    for (const gone of ["sandboxRoomDocRef", "setSandboxForcedSign", "cycleForcedSign", "const forcedSign = sandbox ?", "debug_force: true"]) {
      expect([gone, APP.includes(gone)]).toEqual([gone, false]);
    }
    expect(APP).toContain("const signForced = null;");
  });

  it("no stage is taken from the wire: the server has no forced-sign op to answer", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    for (const file of ["gameServer.ts", "rooms/roomHost.ts"]) {
      const server = fs.readFileSync(path.join(__dirname, "../../../server/src", file), "utf8");
      expect([file, server.includes('case "forced-sign"')]).toEqual([file, false]);
    }
  });
});

describe("the radio bar is a permanent control", () => {
  it("shows the station whether or not anything is playing", () => {
    /* #1120 HID IT WHEN STOPPED and was overruled: "it should remain permanently visible, even when playback
       is stopped, to serve as an ambient feature flag." A radio nobody can see is a radio nobody turns on. */
    expect(CONTROLS).toContain("{currentStationName && (");
    expect(CONTROLS).not.toContain("{audio.musicPlaying && currentStationName && (");
    /* The state moves to the tone rather than to presence -- and #1134 moved WHERE that tone is declared,
       from the name itself up to the drawer that now holds it, so `currentColor` states it once for the
       readout and both steppers together. */
    expect(CONTROLS).toContain("styles.stationDrawerOn");
  });

  it("cycles the stations without opening anything", () => {
    expect(CONTROLS).toContain("stepStation(-1)");
    expect(CONTROLS).toContain("stepStation(1)");
    expect(CONTROLS).toContain('aria-label="Previous station"');
    expect(CONTROLS).toContain('aria-label="Next station"');
  });

  it("wraps rather than dead-ending, and no-ops when there is nothing to cycle", () => {
    expect(CONTROLS).toContain("(stationIndex + delta + stationList.length) % stationList.length");
    expect(CONTROLS).toContain("if (stationIndex < 0 || stationList.length === 0) return;");
    // One station is the single-stream case, where two steppers would be two buttons that do nothing.
    expect(CONTROLS).toContain("stationList.length > 1");
  });

  it("puts the readout before the transport in source order", () => {
    /* "Move the currently selected station name to the left of the play/pause button" -- asserted as ORDER
       rather than as a style, because that is the claim. */
    /* Design note #1134 REORDERED THIS DELIBERATELY: the ruling is `<| [station title] |>`, so Previous now
       comes BEFORE the readout, and the whole tuner comes before the radio button it belongs to. The claim
       that survives is the one that mattered -- the readout is not stranded on the far side of the transport
       -- so it is asserted against the RADIO BUTTON, which is what "left of" was always about. */
    expect(CONTROLS.indexOf("styles.topBarStationName")).toBeLessThan(
      CONTROLS.indexOf('aria-label={audio.musicPlaying ? "Radio settings"'),
    );
  });
});

describe("the small readability fixes", () => {
  it("puts a currency mark on both waterfall figures", () => {
    expect(WATERFALL).toContain("<span style={styles.privateCardFigureValue}>${priv.face_value}</span>");
    expect(WATERFALL).toContain("+${catalogEntry.revenue}");
  });

  it("spells out the Priority Deal instead of ranking the player", () => {
    expect(LEDGER).toContain(">\n                          Priority Deal\n                        </span>");
    expect(LEDGER).not.toContain("#1\n                        </span>");
    // `priorityTag`'s shape, from `PlayerCards` -- one badge, two panels.
    expect(LEDGER).toContain('borderRadius: RADIUS.pill');
  });

  it("gives the tiles their own column and pays for it in padding", () => {
    /* #1094 CHOSE THE OTHER WAY and was overruled here; the objection was width, so the width is found rather
       than argued away. The prose columns are deliberately NOT narrowed -- squeezing a sentence buys width by
       adding lines. */
    expect(LEDGER).toContain(">Available Tiles</th>");
    expect(LEDGER).toContain('padding: "8px 8px"');
    expect(LEDGER).toContain("<th style={styles.th}>On First Purchase</th>");
    expect(LEDGER).toContain("<th style={styles.th}>Rusts</th>");
  });
});
