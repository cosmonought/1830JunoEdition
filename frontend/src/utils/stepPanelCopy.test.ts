/** @jest-environment node */

// The step panels' copy pins that lived in `stickyFitProbe.test.ts`.
//
// Phase 3 W1-I removed the temporary sticky-fit probe (#813) after the owner ruled OD-14(a) on 2026-10-04,
// and deleted that file's probe block with it. The three blocks below were NOT about the probe -- they pin
// the depot's bank line (#812 -> #859/#860, #889), the offer's counterparty (#811) and the private panel's
// intro moving to the tutorial (#814, #490a) -- so they are carried here verbatim, with the same readers.

// A module, like the file it came from (which imported from `./stickyCollapse`): `--isolatedModules` refuses a
// global-script test file.
export {};

const read = (relative: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
};
const strip = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const DEPOT = strip(read("components/TrainPurchasePanel.tsx"));
const PRIVATE_RAW = read("components/PrivateTradePanel.tsx");
const PRIVATE = strip(PRIVATE_RAW);
/* PHASE 3 FINAL PLAY TUTORIAL: the tutorial's words moved from `TutorialModal.tsx`'s page arrays into the canonical
   lesson registry; the consent rule lives on the private-company lesson. */
const TUTORIAL = strip(read("tutorial/lessons.ts"));

describe("the bank no longer stands aside, because it no longer folds (#812 -> #859/#860)", () => {
  /* #812 COLLAPSED THE DEPOT WHEN THE ROSTER OPENED, and its reasoning was about height: the roster with
     eight corporations UNDER a full depot table was the bar's worst case, and folding one removed it.
     BOTH HALVES OF THAT PREMISE ARE GONE. #859 gave the panel the bar's full width, so the two sections sit
     SIDE BY SIDE rather than stacked -- neither is under the other. #860 then deleted the depot table
     outright, its three facts having found other homes (the price on the buy row, the roster behind the
     caret, the rust on #839's badge). What is left of the bank is a heading, a buy row and two figures.
     #812's REAL POINT SURVIVES AND IS ASSERTED BELOW: the treasury stays on the bank's line, because it is
     the figure that decides whether EITHER purchase is possible. */
  it("no longer restates the treasury the corporation strip carries", () => {
    /* Design note #889: this asserted `treasury ${treasury}` on the bank's heading. #812 put it there as
       "the figure that decides whether EITHER purchase is possible", which was true when the panel was the
       only place it appeared -- the corporation strip above shows `Treasury $X` in the same typeface, which
       is #325's two-pockets-one-row complaint from the other side.
       THE FIGURE IS STILL READ, four lines up, to decide affordability and to word the refusal; what went is
       the second DISPLAY of it. Asserted as the absence, because a heading is exactly where it would come
       back. */
    expect(DEPOT).not.toContain("treasury " + String.fromCharCode(36) + "{treasury}");
    /* Design note #1007: this pinned the heading VERBATIM, which is one word more than #889's argument needs.
       The claim being made here is that the treasury is not restated on the bank's heading -- the heading's
       own wording is a different subject, and it now names the tier for sale ("Buy 3-Trains from the Bank
       Depot"). Narrowed to the half that belongs to this file; `depotTierHeading.test.ts` owns the rest.
       A TEST THAT PINS MORE THAN ITS SUBJECT is a test that fails for somebody else's reasons, which is how a
       harness starts enforcing the code instead of the rule. */
    expect(DEPOT).toContain("from the Bank Depot");
  });

  it("has no fold left to trigger", () => {
    expect(DEPOT).not.toContain("setBankOpen");
    expect(DEPOT).not.toContain("bankOpen");
  });

  it("keeps the roster's own caret, which is the one that grows", () => {
    // #758's case: eight operating corporations. That table is still a table a player opens on purpose.
    expect(DEPOT).toContain("setCorporateOpen((open) => !open)");
  });
});

describe("the offer names who it goes to (design note #811)", () => {
  it("puts the holder on the button", () => {
    expect(PRIVATE).toContain("Propose Purchase to");
    expect(PRIVATE).toContain("{entry.owner ? labelForAddress(entry.owner) : \"the owner\"}");
  });

  it("keeps a sentence when the room has not resolved the holder", () => {
    /* The same fallback rule #779 set for the holder's COLOUR: a missing answer degrades to a neutral one
       rather than to a gap, because the sentence's shape is what a player reads first. */
    expect(PRIVATE).toContain('"the owner"');
  });
});

describe("the private panel's intro moved to the tutorial (design note #814)", () => {
  it("no longer states the band in the panel", () => {
    expect(PRIVATE).not.toContain("A corporation may buy a private company from its owner");
    expect(PRIVATE).not.toContain("body: { margin: 0, fontSize: FONT_SIZE.body");
  });

  it("still states the band where the price is chosen", () => {
    /* THE HALF THAT WAS ALREADY DUPLICATED. #721 said it first -- "two statements of one rule, and the
       redundant one was shouting" -- and #804 put the surviving one inline beside the offer field.
       #842 MOVED IT INTO THE FIELD'S LABEL and changed the separator to an en dash, so the literal moved
       with it. The PROPERTY is unchanged and is what this pins: the band is stated where the number is
       typed, rather than only in a paragraph the panel no longer has. */
    const dollar = String.fromCharCode(36);
    expect(PRIVATE).toContain(
      "Offer price (" + dollar + "{bounds.min}&#8211;" + dollar + "{bounds.max})",
    );
  });

  it("gives the consent rule a home, since it had none", () => {
    /* THE HALF THAT COULD NOT SIMPLY BE DELETED, and the reason I left this paragraph alone two reports ago
       after flagging it. "The owner has to agree" was stated nowhere else in the app. */
    expect(TUTORIAL).toContain("The owner has to agree");
    const slide = TUTORIAL.slice(
      TUTORIAL.indexOf('id: "operating.privates"'),
      TUTORIAL.indexOf('id: "market.moves"'),
    );
    expect(slide).toContain("The owner has to agree");
    expect(slide).toContain("negotiation, not a purchase you can force");
  });

  it("keeps the note that records what was removed", () => {
    /* #490a: the scan runs comment-stripped, so the reasoning is asserted against the raw file.
       THIS FAILED FIRST, and the reason is now a pattern rather than an accident. The note quoted the deleted
       sentence across a wrapped comment line, so "The owner has to agree" existed as words and not as a
       STRING. That is the third time in two passes that source text read as contiguous and was not -- a JSX
       `$` beside an expression (#804), a `+`-joined tutorial line (#810), and a wrapped comment here. The
       remedy in the source is to quote a removed string on one unwrapped line; the remedy here is to say why,
       because the next person to add a #490a guard will hit it again. */
    expect(PRIVATE_RAW).toContain(
      "A corporation may buy a private company from its owner between 50% and 200% of face value.",
    );
    expect(PRIVATE_RAW).toContain("The owner has to agree.");
  });
});
