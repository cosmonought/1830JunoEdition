/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module for `--isolatedModules`.
export {};
//
// The Buy Trains panel stops sinking, and stops explaining itself in prose.
//
// ==================================================================
//  DESIGN NOTE 810 (harness): A WELL IS WHERE AN APP PUTS THINGS TO IGNORE
// ==================================================================
//
// REPORTED, two asks about one panel:
//   a) "I'm not sure we need 'One tier per purchase. The depot sells cheapest-first, so a 3-train and a
//      4-train are two separate actions with a phase change between them.' any longer. We can move the
//      important information (buying through a tier requires two actions) to a tutorial box."
//   b) "there is something about this subpanel that doesn't quite grab me ... I think the dark blue
//      background that is the same as the main app makes it 'recede' ... Maybe the parchment background IS
//      the right choice?"
//
// (b)'S DIAGNOSIS IS ONE SHADE OFF AND THE DIFFERENCE IS THE FIX. The ground was `#12141b` -- not the same as
// the app, DARKER than it (`orContextCard` is `#171c28`, the private panel `#141a26`). A surface that sinks
// below its own container reads as a well. "It recedes" is exact; the cause is depth, not hue, and the
// remedy is therefore a lift rather than a repaint.
//
// PARCHMENT IS DECLINED ON A RULE THIS APP ALREADY KEEPS. Every parchment surface here is a NOUN -- a
// corporation card, a company card, a player card, a thing you hold and read. This panel is a VERB, the
// step's own controls, and dressing it as a card would announce a fourth thing to READ at the moment a player
// is being asked to ACT. Recorded rather than merely done, because it is a judgement and the report was
// explicitly open to the other answer; if a playtest says otherwise, this paragraph is what to overrule.
//
// (a) IS #508 FINISHING A THOUGHT IT STARTED. That note hid this paragraph when the bar was pinned, on the
// grounds that it "explains a rule rather than a value -- read once, not on every scroll". Correct, and
// hiding a rule on scroll makes it intermittent rather than relocated. A rule read once belongs where rules
// are read once, and this app has that place.
//
// WHAT THIS FILE CANNOT DO: say whether the panel now grabs the eye. jsdom measures nothing and a source scan
// sees no pixels. It pins the three claims that ARE checkable -- the ground rose above its neighbours, the
// rule survived the move, and the panel kept every fact a player acts on.

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

const PANEL_RAW = read("components/TrainPurchasePanel.tsx");
/** #490a: the note quotes the deleted sentence and the old colour while explaining both. */
const PANEL = strip(PANEL_RAW);
const TUTORIAL = strip(read("components/TutorialModal.tsx"));

/** The panel's own `root` style block, sliced so a colour elsewhere in the file cannot satisfy these. */
const ROOT = PANEL.slice(PANEL.indexOf("  root: {"), PANEL.indexOf("rootCondensed: {"));
const CONDENSED = PANEL.slice(PANEL.indexOf("rootCondensed: {"), PANEL.indexOf("section: {"));

describe("the panel sits above its surroundings, not below them", () => {
  it("no longer uses the darkest ground on the page", () => {
    /* THE REPORTED CAUSE, as the literal figure it was. Asserted as an absence of the old value rather than
       "is lighter", because a hex is not comparable without parsing it and the specific shade is what the
       report was about. */
    expect(ROOT).not.toContain("#12141b");
  });

  it("is lighter than the two surfaces it sits between", () => {
    /* Read back rather than asserted from memory -- the same discipline #737's premise block uses. The bar's
       card is `#171c28` and the private panel is `#141a26`; this has to clear both, and the assertion names
       them so that a later repaint of either shows up here rather than silently reversing the fix. */
    /* Design note #1092 retoned the bar's card from `#171c28` to `#0f0f0f`. THE CLAIM THIS TEST MAKES IS
       UNAFFECTED and was re-checked rather than assumed: the panel is L* 13.83, the card is now L* 4.31 and
       the private panel L* 9.22, so the panel still clears both and the gap in fact widened. The private
       panel's `#141a26` is untouched because it lives in a component the re-theme's first pass did not
       reach -- when it is retoned, this line is where the ordering gets re-checked. */
    expect(strip(read("styles/appStyles.ts"))).toContain('backgroundColor: "#0f0f0f"');
    expect(strip(read("components/PrivateTradePanel.tsx"))).toContain('backgroundColor: "#141a26"');
    /* #1092 retoned this panel and its neighbours, and THIS LINE IS WHY THE PANEL IS NOT `#161616`: the
       re-theme's lightness bands mapped it there, which would have put it BELOW the private panel and
       rebuilt the well #810 removed. The figures, so the next pass does not have to re-derive them --
       panel L* 10.27, private panel L* 9.22, the bar's card L* 4.31. Still lighter than both. */
    expect(ROOT).toContain('backgroundColor: "#1c1c1c"');
  });

  it("lifts rather than merely lightening", () => {
    // A lighter patch with no shadow reads as a different colour; a shadow is what makes it a surface above.
    expect(ROOT).toContain("boxShadow:");
  });

  it("wears the acting corporation's colour on its edge", () => {
    /* #236's channel, reused: the bar overhead is painted in the acting corporation's livery, so an edge in
       the same palette says this panel belongs to the turn above it rather than to the page. */
    expect(PANEL).toContain("borderLeft: `4px solid ${buyer ? stationTickerColor(buyer.company_id)");
  });

  it("falls back to grey with no buyer rather than inventing a colour", () => {
    // A corporation the chain reported without a president is a real state, not a hue worth guessing at.
    expect(PANEL).toContain(': "#3a3a3a"}`'); // #1092: the fallback grey, retoned with the rest of the ladder.
  });

  it("drops the whole treatment when pinned", () => {
    /* #508: inside the bar this is a SECTION of that panel, and "a bordered box inside a bordered box reads
       as two things when it is one". A raised, shadowed, edge-striped slab in there would be that second box
       wearing a highlight -- so every part of the lift is cleared, including the border the spread applies
       AFTER the base style. */
    expect(CONDENSED).toContain('boxShadow: "none"');
    expect(CONDENSED).toContain('borderLeft: "none"');
    expect(CONDENSED).toContain('backgroundColor: "transparent"');
  });

  it("did not reach for parchment", () => {
    /* THE DECISION, as an assertion, because it is the obvious next move if the lift does not land and it
       should be taken deliberately rather than by drift. The cards' ground is a warm light tone; nothing in
       this file should be one without this note being rewritten. */
    expect(PANEL).not.toMatch(/backgroundColor: "#[eEfF][0-9a-fA-F]{5}"/);
  });
});

describe("the rule moved rather than vanished", () => {
  it("no longer prints the paragraph in the panel", () => {
    expect(PANEL).not.toContain("One tier per purchase");
  });

  it("says it in the slide that already covered Buy Trains", () => {
    /* "Steps 5 and 6" described step 6 and was the one place that did not mention the depot's ordering --
       which is the rule a player is most likely to be surprised by, since it is the one that makes a
       four-train two purchases away rather than one. */
    expect(TUTORIAL).toContain("The Depot sells CHEAPEST-FIRST, one tier per purchase.");
    /* A FRAGMENT, and the first draft chose the wrong one. The slide's body is built by `+`-joining string
       literals, so a phrase that reads as one sentence to a player is split across two lines of source at a
       point no reader would guess -- here, between "two " and "separate actions". A source scan has to search
       within a literal, not within the rendered text. */
    expect(TUTORIAL).toContain("separate actions, with a phase change in between.");
    const slide = TUTORIAL.slice(
      TUTORIAL.indexOf('title: "Steps 5 and 6"'),
      TUTORIAL.indexOf('title: "Train Obsolescence'),
    );
    expect(slide).toContain("CHEAPEST-FIRST");
  });

  it("keeps every fact a player acts on", () => {
    /* THE GUARD ON THIS PASS, and the one #779's harness taught: height and clutter were the complaints, and
       the cheapest way to satisfy either is to delete something load-bearing. The panel still names the
       purchasable tier, its price, the quantity, the pay button and what comes next -- all of them figures
       rather than prose, which is why the paragraph was the removable part. */
    expect(PANEL).toContain("upcomingTier");
    expect(PANEL).toContain("Pay ");
    /* #860 MERGED THE TWO LISTS. `laterTiers` was "the depot minus the one you can buy", which existed only
       because the purchasable tier had a table of its own; with that table gone the roster is the WHOLE
       depot. The property this line guards -- that a player can still see every tier, its stock, its price
       and what rusts it -- is unchanged and now covers one more row than it did. */
    expect(PANEL).toContain("depot.map((tier) => (");
    expect(PANEL).not.toContain("laterTiers");
  });

  it("keeps the note that records the removal", () => {
    // #490a: the scan runs comment-stripped, so the reasoning has to be asserted against the raw file.
    expect(PANEL_RAW).toContain("One tier per purchase");
    expect(PANEL_RAW).toContain("#12141b");
  });
});
