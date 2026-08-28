/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 936 (harness): THE STAR IS ACTUALLY WIRED, NOT JUST AVAILABLE
// ==================================================================
//
// `privatePowerStar.test.ts` proves the geometry. THAT IS NOT THE PART THAT KEEPS BREAKING.
//
// The repeated failure in this project is a correct pure module beside untouched wiring: the bank sizing, the
// renderer's zoom, the toggle default, the OR header layout -- four batches where the calculation passed its
// own suite and nothing on screen changed, because the call site still held the old copy. A shape that both
// surfaces are SUPPOSED to share is exactly that hazard again, since a leftover inline loop in the canvas
// renders a perfectly good star that simply is not this one.
//
// SO THESE ARE SOURCE SCANS, and they ask the two questions the arithmetic cannot: does the board draw THIS
// star, and does the button carry it.

import { readStripped, sliceBetween } from "../utils/sourceScan";

describe("the board draws the shared star (design note #936)", () => {
  const CANVAS = readStripped("components/hexCanvasPrimitives.ts");

  it("walks the shared vertices instead of plotting its own", () => {
    expect(CANVAS).toContain("starVertices(");
    expect(CANVAS).toContain("starRadiusForHeight(");
  });

  it("keeps no second copy of the ten-vertex loop", () => {
    /* THE LEFTOVER-COPY CASE, asked as an absence. #714's loop built its angles as
       `-Math.PI / 2 + (point * Math.PI) / 5`; that expression now exists only inside `privatePowerStar`, and
       finding it here again means the canvas went back to drawing its own.
       SCANNED ON A COMMENT-STRIPPED COPY (#490a) so the design note explaining the move cannot itself satisfy
       the search -- the mistake I made anchoring a stripped slice on a comment. */
    expect(CANVAS).not.toContain("(point * Math.PI) / 5");
  });

  it("sizes the star from the measured cap-height", () => {
    /* #937'S INSTRUCTION, at the only place that can honour it. `actualBoundingBoxAscent` on an all-caps
       string IS the cap-height; a fixed ratio would be a guess about whichever font loaded. */
    const badge = sliceBetween(CANVAS, "export function drawReservationBadgeAt", "ctx.restore();");
    expect(badge).toContain("actualBoundingBoxAscent");
    expect(badge).toContain("const starH = capHeight;");
  });

  it("measures the cap-height from the ALPHABETIC baseline", () => {
    /* ==================================================================
        THE BUG THE SUITE COULD NOT HAVE FOUND
       ==================================================================
       `actualBoundingBoxAscent` is measured from whatever `textBaseline` is currently set to, not from the
       alphabetic baseline. This badge draws with `textBaseline = "middle"`, and the first version of #937
       measured under that setting -- returning the distance from the em-box middle, about a third short of
       the cap-height. The star would have got SMALLER while the note said it had grown.
       NO TEST FAILED. jsdom does not implement the metric, so every run took the `fontPx * 0.72` fallback and
       the real branch was never executed. That is the reason this case is a source scan rather than an
       arithmetic one: the arithmetic is unreachable in this environment, and the ORDER of two statements is
       the entire defect.
       ANCHORED ON THE MEASUREMENT, not on the presence of the string "alphabetic" anywhere in the function,
       or a stray baseline change elsewhere would satisfy it. */
    const badge = sliceBetween(CANVAS, "export function drawReservationBadgeAt", "ctx.restore();");
    const measured = sliceBetween(badge, 'ctx.textBaseline = "alphabetic";', "const capHeight =");
    expect(measured).toContain("ctx.measureText(initials)");
    /* And put back before anything is drawn, or the acronym and the star both sit a half-em high. */
    expect(badge).toContain('ctx.textBaseline = "middle";');
    expect(badge.indexOf('ctx.textBaseline = "middle";')).toBeGreaterThan(
      badge.indexOf("const capMetrics = ctx.measureText(initials);"),
    );
  });

  it("derives the slot width from the star rather than from the font", () => {
    /* THE OVERLAP THIS PREVENTS. `markW` used to be an input to the star's size and is now an output of it;
       left as `fontPx * 0.62` while the star grew to a cap-height, the glyph would run into the acronym. */
    const badge = sliceBetween(CANVAS, "export function drawReservationBadgeAt", "ctx.restore();");
    expect(badge).toContain("const markW = starWidthForHeight(starH);");
    expect(badge).not.toContain("const markW = fontPx * 0.62;");
  });

  it("still leaves the mark on the hex background with no plate", () => {
    /* RULED: "Leave the text and star floating directly on the hex background (do not put it in a badge or
       pill) ... as this marker is designed to disappear when a tile is laid anyway."
       ALREADY TRUE, and pinned rather than changed -- #364 removed the plate and left a shadow halo doing the
       legibility work. Recorded here because "no pill" is now an instruction as well as a past decision, and
       the next person to fight a contrast problem should find this before reaching for a background. */
    const badge = sliceBetween(CANVAS, "export function drawReservationBadgeAt", "ctx.restore();");
    expect(badge).toContain("ctx.shadowColor");
    expect(badge).not.toContain("fillRect");
    expect(badge).not.toContain("roundRect");
  });
});

describe("the power chips carry it (design notes #936 -> #943)", () => {
  /* ==================================================================
      CORRECTED: THE STAR WAS ON THE WRONG BUTTON
     ==================================================================
     #936 PUT IT ON "Buy Private Company", on instruction. CORRECTED: "In Batch 13, I mistakenly instructed
     you to put the `<PrivatePowerIcon/>` on the 'Buy Private Companies' button. The star represents the
     physical location of a private company's power."
     THESE CASES USED TO PIN THE OLD PLACEMENT:
         expect(BAR).toContain("<PrivatePowerStar height={11} />");
         expect(BAR).toContain("icon: privatePanelOpen ? undefined : <PrivatePowerStar");
     AND THE CORRECTION IS RIGHT ABOUT WHAT THE MARK MEANS. #714 draws the star on hexes where a power TAKES
     EFFECT. Buying a private is a transaction in a list; using one is an act on the board, and only the
     second is what the board's star has ever stood for.
     ON EVERY POWER CHIP INCLUDING THE M&H, ruled: "It's okay to apply the star to the MH power button as
     well. It keeps private powers consistent." The narrower reading -- that the M&H's share exchange has no
     hex and so should not carry a location mark -- was considered and overruled, and #943 records why. */
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("marks the Use Power chips", () => {
    expect(BAR).toContain("icon: <PrivatePowerStar height={11} />");
  });

  it("has taken the star off the Buy toggle", () => {
    /* THE CORRECTION, AS AN ABSENCE. Scanned on a comment-stripped copy (#490a) so #943's note explaining the
       removal cannot itself satisfy the search. */
    expect(BAR).not.toContain("privatePanelOpen ? undefined : <PrivatePowerStar");
  });

  it("renders exactly one star per chip and none anywhere else", () => {
    /* ONE DECLARATION, ONE RENDER SITE. The chips are built once and placed twice (#884), so the mark cannot
       be added at a placement without the two rails disagreeing. */
    expect(BAR.match(/<PrivatePowerStar/g)?.length ?? 0).toBe(1);
    expect(BAR).toContain("{chip.icon ? (");
  });

  it("keeps the ordinary buttons' icon slot intact", () => {
    /* THE SLOT SURVIVES the star leaving the Buy toggle. It is a general affordance on `ActionBarButton`, and
       #619's rule still applies to it: both forms of the bar must render it or neither. */
    expect(BAR.match(/btn\.icon \?/g)?.length ?? 0).toBe(2);
  });

  it("keeps the accessible name in the label, not the glyph", () => {
    /* The chip must still be reachable by its words -- `chipLabel` is `Use ${acronym} Power` and stays a
       string, so the star is decoration beside a name rather than the name itself. */
    expect(BAR).toContain("label: offer.chipLabel,");
  });
});

describe("the style the button spreads actually exists (design note #936)", () => {
  const STYLES = readStripped("styles/appStyles.ts");

  it("defines actionBarButtonWithIcon in the sheet", () => {
    /* ==================================================================
        THE PHANTOM-KEY CHECK, AND IT HAS CAUGHT ME TWICE
       ==================================================================
       `styles` is typed `Record<string, React.CSSProperties>`, so a key that does not exist is `undefined`,
       and spreading `undefined` is a silent no-op -- no type error, no lint error, no layout. #619's own note
       records an audit that found call sites which had been styling nothing since they were written, and I
       later did the same thing with `orProgressRow` by defining a style in the panel instead of the sheet.
       ASSERTED AGAINST THE SHEET, not against the panel, because the panel referencing it is exactly the
       half that is already true when this bug happens. */
    expect(STYLES).toContain("actionBarButtonWithIcon:");
    expect(STYLES).toContain('display: "inline-flex"');
  });
});
