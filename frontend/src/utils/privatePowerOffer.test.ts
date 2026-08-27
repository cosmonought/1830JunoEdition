/** @jest-environment node */

//
// The private power a player can actually find.
//
// ==================================================================
//  DESIGN NOTE 844 (harness): TWO PREDICATES, ONE RULE, ONE OF THEM TOLD
// ==================================================================
//
// REPORTED: "the relevant hexes currently have the rainbow outline on them (but for some reason in a recent
// pass they have been veiled again, rather than marked/highlighted for inclusion in a corporation's network
// as usual...this should be fixed)."
//
// #727 SAID IT PLAINLY -- "a private power's hex glows whether or not it is in the reach set -- being outside
// it is the point" -- and taught the GLOW arm with an `||`. The VEIL arm, three blocks above it in the same
// draw pass, asks `!layFocus.visible.has(key)`, and `powerHexes` was handed over BESIDE `visible` rather than
// added to it. So the board drew a hue ring underneath a dim: "this is special" and "this is not for you", in
// the same pixel, and the darker one won.
//
// NINTH INSTANCE OF THE SESSION'S DOMINANT SHAPE -- a rule stated in one place and never asked in the
// authority beside it (#807, #809, #816, #820, #824, #825, #826, #831, and now this).

import {
  privatePowerOfferAt,
  privatePowerHexKeys,
  privatePowerOffers,
  type PrivatePowerCandidate,
} from "./privatePowerOffer";

const read = (rel: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
};
// #490a: every note here quotes the rule it explains.
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const APP = strip(read("App.tsx"));
const BAR = strip(read("panels/ContextualActionBar.tsx"));

const DH: PrivatePowerCandidate = {
  privateId: 3,
  abilityKey: "dh-tile",
  hex: { q: 5, r: -3, hexLabel: "F16" },
  usable: true,
};
const CSL: PrivatePowerCandidate = {
  privateId: 2,
  abilityKey: "csl-tile",
  hex: { q: 1, r: 9, hexLabel: "B20" },
  usable: true,
};

describe("the veil was never told (design note #844)", () => {
  it("adds the power hexes to the set the veil reads", () => {
    expect(APP).toContain("privatePowerHexes.forEach((key) => visible.add(key));");
  });

  it("keeps powerHexes as its own set, because the glow still needs it", () => {
    /* THE TWO SETS MEAN DIFFERENT THINGS and merging them would lose the ring. `visible` is "not veiled";
       `powerHexes` is "gets the hue". A power hex is both; a network hex is only the first. */
    expect(APP).toContain("powerHexes: privatePowerHexes");
  });
});

describe("one list feeds the ring and the chip (design note #845)", () => {
  it("derives the glow keys from the offers", () => {
    /* `privatePowerGlowKeys` took its own reading of the same state, so a hex could ring while nothing
       offered it -- which is the "why is this glowing" half of the report. */
    expect(privatePowerHexKeys(privatePowerOffers([DH, CSL]))).toEqual(new Set(["5,-3", "1,9"]));
    expect(APP).toContain("privatePowerHexKeys(privatePowerOfferList)");
    expect(APP).not.toContain("privatePowerGlowKeys");
  });

  it("drops an unusable power from both at once", () => {
    const offers = privatePowerOffers([{ ...DH, usable: false }, CSL]);
    expect(offers).toHaveLength(1);
    expect(privatePowerHexKeys(offers).has("5,-3")).toBe(false);
  });

  it("drops a candidate with no reserved hex rather than naming nowhere", () => {
    expect(privatePowerOffers([{ ...DH, hex: null }])).toHaveLength(0);
  });

  it("takes its words from the catalog", () => {
    /* #661 built `abilityBullets` as the ONE description of a power. A modal with prose of its own is how a
       rule comes to be stated twice and corrected once. */
    const [csl] = privatePowerOffers([CSL]);
    expect(csl.acronym).toBe("CSL");
    expect(csl.chipLabel).toBe("Use CSL Power");
    expect(csl.title).toBe("Use the CSL's private power?");
    expect(csl.body).toContain("B-20");
    expect(csl.confirmLabel).toBe("Use it on B20");
  });
});

describe("who the ringed hex answers", () => {
  const offers = privatePowerOffers([DH, CSL]);

  it("offers the power on its own hex", () => {
    expect(privatePowerOfferAt({ hexKey: "1,9", actingViewer: true, errandArmed: false, offers })?.acronym)
      .toBe("CSL");
  });

  it("says nothing on any other hex", () => {
    expect(privatePowerOfferAt({ hexKey: "0,0", actingViewer: true, errandArmed: false, offers })).toBeNull();
  });

  it("says nothing to a watcher", () => {
    /* #413/#809: an offer to use somebody else's power is an instruction a watcher cannot follow, and #809
       was reported precisely because a watcher's clicks were being measured against the acting player's
       state. */
    expect(privatePowerOfferAt({ hexKey: "1,9", actingViewer: false, errandArmed: false, offers })).toBeNull();
  });

  it("stands aside once the errand is armed", () => {
    /* THE ONE THAT WOULD HAVE BROKEN THE FEATURE IT ADDS. After accepting, the same hex is where the player
       LAYS -- #725 exists so that click reaches the tile picker -- so asking again would put a modal between
       them and the action they just agreed to. */
    expect(privatePowerOfferAt({ hexKey: "1,9", actingViewer: true, errandArmed: true, offers })).toBeNull();
  });
});

describe("the click is intercepted where it has to be", () => {
  it("asks before the inspector gate swallows the click", () => {
    /* `inspectorClickRefused` exists to swallow clicks on hexes with nothing to offer (#716), and this hex
       has something to offer BECAUSE it is out of network. Order is the whole fix. */
    /* BOTH ANCHORS PROVEN PRESENT FIRST. `indexOf` returns -1 for a missing needle, and -1 is less than
       everything -- so a rename or a deletion would make this ordering assertion pass while asserting
       nothing. The same trap as the backwards slice in `bonusLayStep.test.ts`, wearing a comparison instead
       of a range. Found by a negative control that renamed the thing and watched the test stay green. */
    const ask = APP.indexOf("const powerOffer = privatePowerOfferAt({");
    const gate = APP.indexOf("inspectorClickRefused({");
    expect(ask).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(gate);
  });

  it("reads the offers through a ref, like the turn flag beside it", () => {
    // The handler is a `useCallback` the canvas holds across renders; a click lands long after that commit.
    expect(APP).toContain("offers: privatePowerOffersRef.current");
    expect(APP).toContain("actingViewer: isMyTurnRef.current");
  });

  it("closes the request when the step ends, TRACK OR TOKENS (design note #849a)", () => {
    /* #817's rule: "a prompt that outlived its turn would be a modal over a board doing something else."
       #845 WROTE THIS GUARD AS `!== "Track"` AND THAT WAS WRONG. A D&H lay ENDS the Track step --
       `layEndsTrackStep` is `!isBonusLay`, and only the C&SL's lay is a bonus -- so the guard would have
       closed the modal at exactly the moment its second step became live. #818's own condition was Track OR
       Tokens for this reason. The narrower form is asserted absent, because it is the one a tidy-up would
       reach for. */
    expect(APP).toContain(
      'if (orSubPhase !== "Track" && orSubPhase !== "Tokens") setPrivatePowerRequest(null);',
    );
    expect(APP).not.toContain('if (orSubPhase !== "Track") setPrivatePowerRequest(null);');
  });
});

describe("both doors, one question (design note #846)", () => {
  it("arms through one extracted callback", () => {
    /* The powers panel and the prompt both call `armPrivateHexErrand`. Two copies of four lines that must
       agree about `kind`, `returnTab` and the log entry is how two paths come to arm different errands --
       and `kind` is the one that would have drifted, since `dh-token` is a STATION placement and the two
       tile powers are not (#548). */
    /* THREE CALL SITES NOW (#849), and each is a step rather than an entry point: the powers panel's
       non-hex fallback, the modal's LAY step, and the modal's STATION step. The declaration reads
       `const armPrivateHexErrand = useCallback(`, so it does not match this pattern, and the dependency
       arrays are bare identifiers -- which is what makes this a count of CALLERS.
       WHAT THE COUNT GUARDS is that nothing arms an errand without going through here, so `kind` and
       `returnTab` cannot be decided twice. */
    expect(APP.match(/armPrivateHexErrand\(/g) ?? []).toHaveLength(3);
    expect(APP).toContain('kind: abilityKey === "dh-token" ? "private-station" : "private-tile"');
  });

  it("makes the chip raise the modal rather than arm", () => {
    /* A chip that armed directly would be a third path into the errand and a second thing "use this power"
       can mean. It also keeps #263's rule that nothing on this bar dispatches. */
    expect(APP).toContain("if (offer) setPrivatePowerRequest(offer.abilityKey);");
    /* THE END ANCHOR IS SEARCHED FROM THE START ANCHOR, and both are proven present -- the slice this
       replaced ended at a handler #849 deleted, so it ran to -1 and produced an empty string that passed the
       `not.toContain` beside it. Third instance of that trap this session. */
    const start = APP.indexOf("const handleChipPowerOffer");
    expect(start).toBeGreaterThan(-1);
    const end = APP.indexOf("const handlePowerFlowAct", start);
    expect(end).toBeGreaterThan(start);
    const chip = APP.slice(start, end);
    expect(chip).not.toContain("armPrivateHexErrand");
  });

  it("feeds the chip the same list the board rings", () => {
    /* #846's PROPERTY, WHICH #871 DID NOT WEAKEN. This read `powerOffers={privatePowerOfferList}` and broke
       when the M&H joined the bar as a Stock Round chip. The rule it defends is about the HEX powers: the
       list that rings the board is the list that draws the chips, so a glow and a chip cannot disagree about
       whether a power is available.
       THE M&H CANNOT AFFECT THAT and the two assertions below are why. It is appended rather than mixed in,
       so `privatePowerOfferList` still reaches the bar whole; and it is built only in a Stock Round, where
       there is no board veil and no Lay Track step, so the two lists are disjoint by round rather than by
       filtering. `privatePowerHexKeys` -- the thing the glow actually reads -- is handed the hex list alone,
       which the next test pins. */
    expect(APP).toContain("powerOffers={[...privatePowerOfferList, ...stockRoundPowerOffers]}");
    expect(APP).toContain("privatePowerHexKeys(privatePowerOfferList)");
  });

  it("never lets a hexless power reach the board's glow (design note #871)", () => {
    /* THE FAILURE THIS FORECLOSES: `privatePowerHexKeys` maps offers to `"q,r"` keys the veil looks up. An
       exchange has no hex (#312), so putting one in that list would hand the map a key nothing resolves --
       and the veil would either miss a hex or light an undefined one. Asserted as the ABSENCE of the M&H
       from the module that builds hex offers, because that is where a future tidy-up would merge them. */
    const offers = read("utils/privatePowerOffer.ts");
    expect(offers).not.toContain("mh-exchange");
    expect(offers).not.toContain("MH_PRIVATE_ID");
  });

  it("puts the chips before the map jump", () => {
    /* #792's ordering argument one step over: an obligation before an exit, and here an opportunity before a
       destination. A power is a thing you may not know you have; the map is a place you know how to reach. */
    const chip = BAR.indexOf("key: `power-" + String.fromCharCode(36) + "{offer.abilityKey}`");
    const jump = BAR.indexOf('key: "go-to-map"');
    expect(chip).toBeGreaterThan(-1);
    expect(jump).toBeGreaterThan(-1);
    expect(chip).toBeLessThan(jump);
  });

  it("offers no chip when the shell cannot answer one", () => {
    // The same rule the jump buttons follow: a control pointing at nothing is worse than no control.
    expect(BAR).toContain("...(onUsePowerOffer");
  });
});

/* ==================================================================
    DESIGN NOTE 849: THIS BLOCK'S TWO SUBJECTS NO LONGER EXIST
   ==================================================================
   It compared `PrivatePowerPrompt`'s dismissible question against `DhStationPrompt`'s refusal to be
   dismissed. #848 folded both into `PrivatePowerFlowModal`, where the distinction survives as a WINDOW
   rather than as two components: the X is offered while nothing is committed and withdrawn the moment the
   tile is laid, because from then on a dismissal would have to mean "forfeit the free placement" -- which is
   #818's argument exactly, and is now a button that says so.
   ASSERTED IN `privatePowerFlow.test.ts` under "the escape is a window". Moved rather than deleted, because
   the property is the one a future tidy-up is most likely to lose: an X in the corner looks like a thing
   every modal should have. */
