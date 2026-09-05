/** @jest-environment node */
//
// Source scanning and one pure string builder; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 714 (harness): A BONUS, NOT A BARRIER
// ==================================================================
//
// REPORTED: "We placed locks on the DH (F16) and CSL (B20) hexes, but these hexes are actually not locked by
// the private companies: any corporation can build on those hexes following the usual rules, it's only that
// the owning corporations of DH or CSL get their special power."
//
// TWO SURFACES SAID THE SAME WRONG THING, in two media. The board drew a gold padlock beside the initials, and
// the hover text appended "— Reserved by DH". Neither is a near-miss: both name exclusivity, which is the one
// thing these hexes do not have.
//
// AND THE TRUE SENTENCE WAS ALREADY IN THE DATA. `ReservationRule.power` has read "its owner may lay a tile
// AND place a station here at no cost" since the table was written. Nothing rendered it -- the two surfaces
// that rendered anything invented a shorter claim instead, and the shorter claim was false. That is the shape
// worth testing: not "is the word gone" but "is the field that was always right the thing a player now sees".
//
// THE PADLOCK IS TESTED AS SOURCE, because it is a canvas path -- an arc and a rectangle in
// `hexCanvasPrimitives`, with no DOM to query and no glyph to search for. A shackle drawn again would be
// invisible to any assertion about rendered output, so the assertion is about the code that draws it.

import fs from "fs";
import path from "path";

import { withReservationNote } from "./HexGridRenderer";
import { activeReservations } from "../utils/privateReservations";
import type { PrivateCompanyState } from "../utils/gameState";

const PRIMITIVES = fs.readFileSync(path.join(__dirname, "hexCanvasPrimitives.ts"), "utf8");

/** Comments discuss the padlock by name, in the past tense, and must keep doing so -- #490a's trap. */
const CODE = PRIMITIVES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function privates(): PrivateCompanyState[] {
  return [
    { private_id: 2, name: "Champlain & St. Lawrence", closed: false, owner: "alice" },
    { private_id: 3, name: "Delaware & Hudson", closed: false, owner: null },
  ] as unknown as PrivateCompanyState[];
}

/* Design note #1176: the existing cases are about CLOSURE and OWNERSHIP, so they pass a set in which both
   powers are live -- the condition they were all written under, now that it has to be said out loud. The new
   describe at the foot of this file is where the set itself is the subject. */
const BOTH_LIVE: ReadonlySet<number> = new Set([2, 3]);

describe("the hover text describes a power, not a claim", () => {
  it("prints the private's actual power", () => {
    /* THE FIELD THAT WAS ALWAYS RIGHT. The badge used to paraphrase it as "Reserved by DH"; it now prints
       what the table says, which is the whole correction.
       Design note #725: PINNED AS A SHAPE, NOT A SENTENCE, after this asserted the exact string and broke when
       the string was corrected. The old wording -- "lay a tile AND place a station here at no cost" -- was
       wrong twice: the tile costs $120, and the station is not independent of the lay. #548's rule applies and
       this file cites it three tests down: pin the fact, not the phrasing. What matters is that the badge
       prints the TABLE'S text, prefixed with the initials. */
    const dh = activeReservations(privates(), BOTH_LIVE).find((entry) => entry.initials === "DH")!;
    expect(withReservationNote("Scranton (F16)", dh)).toBe(`Scranton (F16) — DH: ${dh.power}`);
    // And that the text it prints is the corrected one, not the claim #725 removed.
    expect(dh.power).not.toMatch(/at no cost/i);
    expect(dh.power).toContain("$120");
  });

  it("never tells a player the hex is reserved or locked", () => {
    /* THE REPORT, as a property over every badge rather than the one that was quoted. "Reserved by DH" is
       advice a president may act on -- F16 is Scranton, and there are turns where laying it is right for
       anybody. */
    for (const entry of activeReservations(privates(), BOTH_LIVE)) {
      const note = withReservationNote("A hex", entry);
      expect(note).not.toMatch(/reserved|locked|blocked|off limits/i);
    }
  });

  it("still names the private when no power is on record", () => {
    // A missing field is not a licence to claim exclusivity; name the company and stop.
    expect(withReservationNote("A hex", { initials: "DH" })).toBe(
      "A hex — DH has a special power here",
    );
  });

  it("leaves an unbadged hex's description alone", () => {
    expect(withReservationNote("Altoona (H12)", null)).toBe("Altoona (H12)");
  });
});

describe("the badge is drawn as a star", () => {
  it("no longer draws a padlock", () => {
    /* A canvas path has no DOM to query, so the drawing IS the assertion. The padlock was a shackle arc over
       a body rectangle; both go. */
    expect(CODE).not.toMatch(/shackle/i);
    expect(CODE).not.toMatch(/lockW/);
  });

  it("draws the ten alternating vertices of a five-pointed star", () => {
    /* ==================================================================
        RED SINCE #936, AND NOTHING SAID SO
       ==================================================================
       THIS ASSERTED `point < 10` IN `hexCanvasPrimitives.ts`. That loop left this file in #936, which pulled
       the construction into `privatePowerStar` so the canvas and the action bar's SVG could not draw two
       different stars -- and `privatePowerStarWiring` asserts the move from the other side, including an
       explicit absence of the old angle expression here. So the two suites have been contradicting each
       other since, one of them failing, and the failure was in a file nobody had reason to open.
       FOUND BY A BLAST-RADIUS SWEEP rather than by a run: this batch touched `privatePowerStar`, so every
       suite naming it was run, and this one was already red before a line of the batch was written. Worth
       recording plainly -- "the suite is green" has been true of the suites I ran and not of this one.
       RE-ANCHORED ON THE CONSTRUCTION WHEREVER IT LIVES. The claim was never "this file has a loop", it was
       "the badge is a plotted star and not a glyph the platform might substitute" -- the argument #617 makes
       for the locomotive and #552 for the crown. That claim is now answered by two files, so both are read. */
    const SHARED = fs.readFileSync(path.join(__dirname, "privatePowerStar.tsx"), "utf8");
    expect(SHARED).toContain("point < 10");
    expect(SHARED).toMatch(/outerRadius|innerRatio/);
    /* AND THE CANVAS STILL WALKS IT, or the badge would be a correct shape that nothing draws -- the
       integration gap this project keeps finding, one step from where it was found last time. */
    expect(CODE).toContain("starVertices(");
    expect(CODE).not.toMatch(/[\u{1F31F}★☆]/u);
  });

  it("keeps the padlock in the design note, where it is history", () => {
    /* #490a's rule: a search over source text cannot tell an implementation from an account of one, so the
       checks above read a comment-stripped copy and this one reads the raw file. The note explaining what was
       wrong is the most valuable thing here and must survive its own test. */
    expect(PRIMITIVES).toMatch(/padlock/i);
  });
});

describe("the badge still clears when the private does", () => {
  it("drops a closed private", () => {
    // #1, unchanged by #714: the power goes when the company does.
    const closed = privates().map((entry) =>
      entry.private_id === 3 ? { ...entry, closed: true } : entry,
    );
    expect(activeReservations(closed, BOTH_LIVE).map((entry) => entry.initials)).toEqual(["CSL"]);
  });

  it("marks the hex even while nobody owns the private", () => {
    /* #1 again: during the auction nobody holds the C&SL and the hex still carries the power. What ownership
       changes is who can USE it -- which, after #714, is the only thing the badge was ever about. */
    const unowned = privates().map((entry) => ({ ...entry, owner: null }));
    expect(activeReservations(unowned, BOTH_LIVE)).toHaveLength(2);
  });
});

describe("the badge clears when the POWER goes, not only when the company does", () => {
  /* ==================================================================
      DESIGN NOTE 1176: THE REPORTED FAULT, AS THE PROPERTY IT BROKE
     ==================================================================
     REPORTED: "the private company acronyms+stars are lingering on hexes even after tiles have been laid on
     them ... as soon as any tile is laid on these hexes, their private powers are disabled and the markers
     are removed."
     THE OTHER SURFACES WERE ALREADY RIGHT. `dhPowerState`/`cslPowerState` forfeit on a tile laid by anybody
     else, and the chips, the offers and the hex glow all read them. Only the badge asked a different
     question, and it asked the roster -- which knows open from closed and nothing else. */

  it("drops a private whose power has been forfeited or spent", () => {
    const onlyCsl: ReadonlySet<number> = new Set([2]);
    expect(activeReservations(privates(), onlyCsl).map((entry) => entry.initials)).toEqual(["CSL"]);
  });

  it("draws nothing when no power is live", () => {
    expect(activeReservations(privates(), new Set())).toEqual([]);
  });

  it("keeps the D&H badge while only its first half is spent", () => {
    /* THE CASE THAT RULES OUT THE OBVIOUS FIX. Testing "has anybody built here" would erase this badge the
       moment the D&H used its OWN lay -- and the free station is the second half of that lay (#725), still
       to come. The shell answers with `layAvailable || tokenAvailable` for exactly this. */
    const dhOnly: ReadonlySet<number> = new Set([3]);
    expect(activeReservations(privates(), dhOnly).map((entry) => entry.initials)).toEqual(["DH"]);
  });

  it("still needs the private open, so the two conditions are AND rather than OR", () => {
    /* A live power on a closed private is not a state the game can reach, and the badge should not invent one
       if it ever became reachable. */
    const closed = privates().map((entry) =>
      entry.private_id === 3 ? { ...entry, closed: true } : entry,
    );
    expect(activeReservations(closed, new Set([3]))).toEqual([]);
  });
});
