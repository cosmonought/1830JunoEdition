/** @jest-environment node */

//
// The station marker's ring says what the placement leaves behind.
//
// ==================================================================
//  DESIGN NOTE 836 (harness): THE SENTENCE IS SHARED, NOT COPIED
// ==================================================================
//
// REPORTED: "In the same the tooltip confirmation for laying a track on a terrain tile lists the treasury
// effect, the Station Marker tooltip confirmation should list the Treasury effect."
//
// #673 BUILT THE PROJECTION FOR THE TILE RING and argued for it in terms that were never about tiles: "the
// question a president actually has is not 'what does this hex cost' but 'what am I left with' -- because the
// next step in the same turn may be a $450 train." A station marker is $40 or $100 out of that same treasury
// in that same turn, and its ring quoted the price and stopped.
//
// THE RISK IN THIS FIX IS THE SECOND COPY. Writing "Costs $40 — treasury $960 after" into
// `RadialTokenConfirm` would have been #815's three chip rows and #829's two acronym vocabularies again: two
// surfaces answering one question with two implementations, which is how they come to answer it differently.
// So the arithmetic and the wording moved to `pendingSpend.ts` and both rings ask it. The tests below pin
// that there is exactly one of it.

import { readSource, stripComments } from "./sourceScan";

import { describePendingSpend, pendingSpend } from "./pendingSpend";

describe("pendingSpend", () => {
  it("projects the treasury through the charge", () => {
    expect(pendingSpend(40, 1000)).toEqual({ fee: 40, before: 1000, after: 960, short: false });
  });

  it("reports a shortfall without enforcing it", () => {
    /* #673's rule, inherited: the contract owns what is legal. A projection that refused to compute would
       leave the player looking at a ring with no figure at the moment the figure matters most. */
    const spend = pendingSpend(100, 60);
    expect(spend.after).toBe(-40);
    expect(spend.short).toBe(true);
  });

  it("keeps an unknown balance unknown", () => {
    /* An unknown balance minus a known fee is still unknown. Rendering "-$40" there would be a figure no
       corporation has -- `playerFinance.ts` #562's em-dash argument, applied to a treasury. */
    const spend = pendingSpend(100, null);
    expect(spend.before).toBeNull();
    expect(spend.after).toBeNull();
    expect(spend.short).toBe(false);
  });

  it("does not treat a missing balance as zero", () => {
    // The distinction the `number | null` exists for: nobody has read it, versus the company is broke.
    expect(pendingSpend(40, 0).short).toBe(true);
    expect(pendingSpend(40, null).short).toBe(false);
  });
});

describe("describePendingSpend", () => {
  it("names the fee and the remainder together", () => {
    expect(describePendingSpend(pendingSpend(40, 1000))).toBe("Costs $40 — treasury $960 after");
  });

  it("says nothing at all about a free placement", () => {
    /* Design note #454: a home station and the D&H's F16 token are free, and the ring already says $0. A
       remainder that has not moved is an arrow pointing at itself, and a permanent "Costs $0" teaches a
       player to stop reading the line that matters where it does.
       REACHED FROM THE FEE, not from a second branch in `App.tsx` -- so the free case cannot be handled one
       way by the tile ring and another by the token ring. */
    expect(describePendingSpend(pendingSpend(0, 1000))).toBeNull();
  });

  it("falls back to the price when the balance is unknown", () => {
    expect(describePendingSpend(pendingSpend(100, null))).toBe("Costs $100");
  });

  it("still speaks when the corporation cannot afford it", () => {
    /* The one case where suppressing the line would be worst. It is REPORTED, not refused -- the ring's own
       `canConfirm` is a different question and belongs to the caller. */
    expect(describePendingSpend(pendingSpend(100, 60))).toBe("Costs $100 — treasury $-40 after");
  });
});

describe("one sentence, two rings", () => {
  /* #490a: the notes in both files QUOTE the sentence while explaining where it lives, so a raw search would
     find the prose and call it the implementation. Comment-stripped copies for the code assertions; the raw
     text is read separately where a note is what is being checked. */
  const RING = stripComments(readSource("components/RadialTileSelector.tsx"));
  const APP = stripComments(readSource("App.tsx"));
  const SPEND = stripComments(readSource("utils/pendingSpend.ts"));

  it("builds the wording in exactly one place", () => {
    /* THE PROPERTY THIS WHOLE HARNESS EXISTS FOR. If the phrase is ever written into a component, this fails
       -- which is the moment the two rings can start to disagree. */
    /* TWO DOLLARS, and the reason is the one this session has now hit three times. The source line is a real
       template literal -- `Costs $${spend.fee}` -- so its RAW TEXT carries the printed dollar AND the
       interpolation's. A single dollar here matches nothing.
       BOTH SPELT WITH `String.fromCharCode(36)`, because writing the second one literally puts `${` inside a
       plain string and trips `no-template-curly-in-string` -- the lint rule reads the literal, not the
       intent. The first fix for that lint error silently dropped a dollar and this assertion went from
       correct to unfalsifiable; the run caught it, which is the only reason it is not still that way. */
    const dollar = String.fromCharCode(36);
    expect(SPEND).toContain("Costs " + dollar + dollar + "{spend.fee} — treasury");
    expect(RING).not.toContain("treasury " + dollar);
    expect(APP).not.toContain("— treasury");
  });

  it("gives the token ring the tile ring's caption slot", () => {
    /* `cost` on `RadialConfirmRing` is the slot #673 built for the tile. The token ring rendered no caption
       at all before this -- so the fix is a wiring, not a new surface. */
    expect(RING).toContain("cost={costNote}");
    expect(RING).toContain("costNote = null,");
  });

  it("puts the same fact in the tooltip, which is what was asked for", () => {
    /* REPORTED as a TOOLTIP: "the Station Marker tooltip confirmation should list the Treasury effect."
       Appended to the existing sentence rather than replacing it -- that sentence says what is charged and to
       whom, and this says what survives it. */
    const title = RING.slice(RING.indexOf("confirmTitle={"), RING.indexOf("confirmAriaLabel=\"Confirm station"));
    expect(title.length).toBeGreaterThan(0);
    expect(title).toContain("costNote === null");
    expect(title).toContain("to its treasury.");
  });

  it("charges the corporation whose token it is", () => {
    /* #556's rule, and it bites harder here than on the ticker. A free home station can be staged for a
       company that is not the operating one; quoting the ACTING corporation's balance while naming another
       company's token would print a figure belonging to nobody in the transaction. */
    /* THE END ANCHOR IS SEARCHED FROM THE START ANCHOR. `ticker={` occurs many times earlier in this file, so
       a bare `indexOf` gives a backwards range and an empty slice -- which passes every `not.toContain` beside
       it while proving nothing. `bonusLayStep.test.ts` lost an assertion to exactly this, and #785's harness
       before it, so the length guard below is not decoration. */
    const start = APP.indexOf("costNote={describePendingSpend(");
    expect(start).toBeGreaterThan(-1);
    const call = APP.slice(start, APP.indexOf("ticker={", start));
    expect(call.length).toBeGreaterThan(0);
    expect(call).toContain("pendingToken.companyId ?? actingProtocolId");
    expect(call).toContain("Number(payer.treasury)");
    /* AND NOT THE `|| 0` this file uses everywhere else. `pendingSpend` reports an unreadable balance as
       unknown and prints the price alone; `|| 0` would say the corporation is broke on a figure nobody
       could read, which is the one wrong answer a treasury projection can give. */
    expect(call).not.toContain("Number(payer.treasury) || 0");
  });

  it("keeps the terrain rule where terrain rules live", () => {
    /* THE HALF THAT DID NOT MOVE. `pendingTileCost.ts` still owns which ground costs what and #723's rule
       that it is charged once -- the generalisation took the arithmetic, not the rules. */
    const tile = readSource("utils/pendingTileCost.ts");
    expect(tile).toContain("terrainFeeDue");
    expect(tile).toContain("pendingSpend(");
    expect(stripComments(tile)).not.toContain("short: after");
  });
});
