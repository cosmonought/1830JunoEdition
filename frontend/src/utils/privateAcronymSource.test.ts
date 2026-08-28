/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 881 (harness): ONE TABLE ANSWERS "WHAT IS THIS PRIVATE CALLED"
// ==================================================================
//
// REPORTED: "the Private Companies listed in the Private Power subpanel do not have their acronym
// abbreviation, and the acronym used in the action bar still contains the old acronym style (eg, M&H rather
// than the sleeker MH that we agreed to) that needs to be updated."
//
// THE RULE IS #364's AND IT WAS NEVER IN DOUBT -- `hexCanvasPrimitives.ts` states it ("No ampersand"),
// `privateReservations.ts` restates it, and `privateCatalog.ts` holds the answers. What was missing was the
// ASKING: three modal titles and one chip label were hand-typed literals carrying the abandoned form.
//
// SCOPED DELIBERATELY TO THE SHORT FORM. "Mohawk & Hudson" is a railroad's name and keeps its ampersand;
// so does the B&O CORPORATION's ticker, which lives in `corporationNames.ts` and is a different namespace
// from the B&O private's `BO`. A test that banned the character outright would fail on both and would be
// asserting something #364 never said.
//
// No React here -- `privatePowerFlow` is a pure function and the rest is a source scan -- so this file takes
// the node environment.

import { readSource, stripComments } from "./sourceScan";

import { PRIVATE_COMPANY_CATALOG, privateAcronym } from "./privateCatalog";
import { privatePowerFlow } from "./privatePowerFlow";

/* #490a: the notes below QUOTE the literals they replaced, so every code assertion reads a comment-stripped
   copy and the record is asserted separately against the raw text. Without this, "the old string is gone"
   would be satisfied by a file that still contains it in a comment -- or, worse, would fail on a file that
   correctly kept the record. */

const FLOW_RAW = readSource("utils/privatePowerFlow.ts");
const FLOW = stripComments(FLOW_RAW);

describe("the catalog is the authority, and it says no ampersand", () => {
  it("gives the three powered privates the short form", () => {
    /* ASSERTED BY IDENTITY, not by a count or by a regex over the table. A `toHaveLength(6)` would survive
       any pair of these being swapped, and swapping DH for MH is precisely the failure a lookup introduces
       that a literal could not. */
    expect(privateAcronym(2)).toBe("CSL");
    expect(privateAcronym(3)).toBe("DH");
    expect(privateAcronym(4)).toBe("MH");
  });

  it("carries no ampersand in any acronym", () => {
    /* THE WHOLE TABLE, because #364's rule is about the short form as a class rather than about the three
       that happen to have powers. SV and BO have no ampersand to lose and are included anyway: a test that
       only covered the ones that changed would not notice a seventh private arriving with `C&O`. */
    for (const entry of Object.values(PRIVATE_COMPANY_CATALOG)) {
      expect(entry.acronym).not.toContain("&");
    }
  });
});

describe("the modal titles are built from it", () => {
  /* RUNTIME, NOT A SOURCE SCAN. `privatePowerFlow` is pure, so the strongest available assertion is to call
     it and read what a player would see -- which also proves the lookup RESOLVES rather than merely that the
     source no longer contains a literal. A scan cannot tell a working lookup from one that falls through to
     its fallback. */
  it("names the MH without an ampersand", () => {
    const flow = privatePowerFlow({
      abilityKey: "mh-exchange",
      holder: "Alice",
      revenuePerOr: 20,
    });
    expect(flow.title).toBe("Exchange the MH for an NYC share?");
    /* BOTH HALVES. The positive pins the exact string; the negative is what would catch a fallback that
       happened to produce something plausible, and it is stated against the old literal specifically rather
       than against "&" in general -- the D&H's own BODY text legitimately says nothing of the sort, but a
       future title mentioning a corporation could. */
    expect(flow.title).not.toContain("M&H");
  });

  it("names the CSL without an ampersand", () => {
    const flow = privatePowerFlow({
      abilityKey: "csl-tile",
      holder: "PRR",
      hexLabel: "B20",
      layDone: false,
      station: "none",
    });
    expect(flow.title).toBe("Use the CSL's extra tile lay?");
    expect(flow.title).not.toContain("C&SL");
  });

  it("names the DH without an ampersand", () => {
    const flow = privatePowerFlow({
      abilityKey: "dh-tile",
      holder: "PRR",
      hexLabel: "F16",
      layDone: false,
      station: "pending",
    });
    expect(flow.title).toBe("Use the DH's private power?");
    expect(flow.title).not.toContain("D&H");
  });

  it("reads the catalog rather than a second table of names", () => {
    /* THE POINT OF THE CHANGE, and the thing three passing titles above cannot prove: they would also pass
       for three new hand-typed literals that happen to be spelled correctly today. */
    expect(FLOW).toContain('import { PRIVATE_COMPANY_CATALOG } from "./privateCatalog";');
    expect(FLOW).toContain("function flowAcronym(abilityKey: PowerAbilityKey): string {");
    /* AND NO LITERAL SURVIVES IN THE CODE. Read off the stripped copy -- the notes quote all three. */
    expect(FLOW).not.toContain("Exchange the M&H");
    expect(FLOW).not.toContain("Use the C&SL");
    expect(FLOW).not.toContain("Use the D&H's private power");
  });

  it("asks the lookup in each of the three titles", () => {
    /* ==================================================================
        WHY THIS IS SEPARATE FROM THE ASSERTION ABOVE
       ==================================================================
       THE NEGATIVE CONTROL FOUND THIS GAP. Reverting ONE title to a hand-typed literal spelled correctly
       today -- `"Exchange the MH for an NYC share?"` -- passed every other test in this file: the runtime
       title is right, the import is still there, `flowAcronym` is still defined and still used by the other
       two, and the banned old spellings are still absent. The module-level assertions prove the MECHANISM
       EXISTS; they cannot prove each title uses it, and a correct-today literal is exactly how the acronym
       rule drifted out of this file in the first place.
       BY IDENTITY, NOT BY COUNT. `flowAcronym` appearing three times would survive two of them being on one
       title and none on another. Each string is pinned whole.
       `String.fromCharCode(36)` because a literal dollar-brace in a plain string trips
       `no-template-curly-in-string` -- the same dodge `mhStockRoundChip.test.ts` uses. */
    const D = String.fromCharCode(36);
    expect(FLOW).toContain("title: `Exchange the " + D + "{flowAcronym(abilityKey)} for an NYC share?`");
    expect(FLOW).toContain("title: `Use the " + D + "{flowAcronym(abilityKey)}'s extra tile lay?`");
    expect(FLOW).toContain("title: `Use the " + D + "{flowAcronym(abilityKey)}'s private power?`");
  });

  it("keeps the replaced titles on the record", () => {
    // #490a in reverse: the absence is read off the stripped copy, the record off the raw file.
    expect(FLOW_RAW).toContain("Exchange the M&H for an NYC share?");
    expect(FLOW_RAW).toContain("Use the C&SL's extra tile lay?");
    expect(FLOW_RAW).toContain("Use the D&H's private power?");
  });
});

describe("the Stock Round chip is built from it too", () => {
  /* ==================================================================
      DESIGN NOTE 887: TWO OF THESE THREE BECAME BEHAVIOURAL
     ==================================================================
     "no longer hand-types the label" and "imports the lookup rather than reaching into the table" scanned
     `App.tsx` for `privateAcronym(MH_PRIVATE_ID)` and for the import that supplied it. The chip's
     construction moved into `stockRoundExchangeOffers`, and `activePrivatePower.test.ts` now CALLS it and
     asserts `chipLabel` is exactly `"Exchange MH for NYC"` -- which is the assertion the scans were reaching
     for and could not make. A scan proves a lookup is CALLED; only a call proves it RESOLVES, and a lookup
     falling through to its fallback is precisely the failure a correct-today literal hides.
     WHAT STAYS HERE IS THE RECORD, which no function call can hold: #814's one-line quotation of the string
     that was replaced, read off raw text per #490a. */
  it("keeps the replaced label on the record", () => {
    expect(readSource("utils/activePrivatePower.ts")).toContain('"Exchange M&H for NYC"');
  });

  it("keeps the fallback on the short form, not the old one", () => {
    /* THE ONE PIECE OF THE CONSTRUCTION A CALL CANNOT REACH: `privateAcronym` returns `null` only for an id
       outside the six, so the `?? "MH"` arm is unreachable with a real catalog and cannot be exercised.
       Asserted as source, because an unreachable arm is exactly where the ampersand would creep back in
       unnoticed -- #788's rule, applied to a fallback rather than to a branch. */
    const module_ = stripComments(readSource("utils/activePrivatePower.ts"));
    expect(module_).toContain('privateAcronym(mhPrivateId) ?? "MH"');
    expect(module_).not.toContain('?? "M&H"');
  });
});

/* ==================================================================
    DESIGN NOTE 885: THE PANEL BLOCK IS GONE WITH THE PANEL
   ==================================================================
   A `describe("the powers panel prints it beside the name")` stood here, added by #881 hours before #885
   deleted its subject. It asserted that `PrivatePowerPanel.tsx` rendered `privateAcronym(ability.privateId)`
   and that the style it used carried no colour, size or weight of its own -- #779's correction, which had to
   be made because an acronym given its own grey styling "read as a code rather than a word".

   THE RULE IT PROTECTED IS NOT GONE, and it is asserted where the acronym is now shown: the chips, above,
   whose labels are composed from the same lookup, and `PrivateTradePanel`'s `rowAcronym`, which
   `privateRowDensity.test.ts` covers. What died is the third surface, not the rule.

   RECORDED RATHER THAN QUIETLY DROPPED because a test that disappears in the same pass as its subject looks
   identical, in a diff, to a test somebody removed because it was failing. */
