/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 983-987 (harness): A TOAST, A CAMERA THAT IS NOW DEAD, AND AN ARITHMETIC MISTAKE
// ==================================================================
//
// THREE REPORTS, AND THE MIDDLE ONE IS A DELETION, which is the hardest kind of thing to hold a suite to.
// Asserting that a feature works is easy; asserting that it is GONE means naming every surface it reached,
// because a removal that half-lands leaves a prop threaded to nothing and reads, from any one file, as
// correct. So #987's block below is mostly absences, spread across four files on purpose.
//
// #983/#984 (the toast) are a constant and a render shape -- one value with an answer, one piece of markup.
//
// #985/#986 (the arrows and the backdrop) are style literals, with one genuine piece of arithmetic in them:
// the conversion from "how big should this look next to the number" to "what font size draws that". #972 got
// that wrong by skipping it entirely, and its every stated percentage was consequently about a box nobody can
// see. That is the case worth having here.

import { readStripped, sliceBetween } from "./sourceScan";
import { summarisePrivateRevenueForPlayer } from "./sandboxSession";
import { PRIVATE_REVENUE_TOAST_MS, STANDARD_TOAST_MS } from "../components/ActionToast";

const APP = readStripped("App.tsx");
const TOAST = readStripped("components/ActionToast.tsx");
const FLASH = readStripped("components/RevenueModifierFlash.tsx");
const ANIM = readStripped("styles/animations.ts");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const BOARD = readStripped("components/HexGridRenderer.tsx");

describe("the private-revenue toast is short and stacked (design notes #983/#984)", () => {
  it("shows for exactly 400ms", () => {
    /* RULED: "Reduce its display duration to strictly `400ms`."
       ASSERTED AS THE VALUE AND AS A RELATIONSHIP. #967 built this constant as `STANDARD_TOAST_MS * 1.5`,
       so a reader who only saw the multiplier would expect it to track the standard window; it does not any
       more, and a future change to the standard must not drag this back up with it. */
    expect(PRIVATE_REVENUE_TOAST_MS).toBe(400);
    expect(PRIVATE_REVENUE_TOAST_MS).toBeLessThan(STANDARD_TOAST_MS);
    expect(TOAST).toContain("export const PRIVATE_REVENUE_TOAST_MS = 400;");
    expect(TOAST).not.toContain("STANDARD_TOAST_MS * 1.5");
  });

  it("still names the window once, rather than inlining it at the call site", () => {
    /* THE HALF OF #967 WORTH KEEPING. One place to change and a test that reads the constant instead of a
       copy of it -- which is the only reason the case above can assert a number at all. */
    expect(APP).toContain("PRIVATE_REVENUE_TOAST_MS, mine.rows)");
    expect(APP).not.toContain("400);");
  });

  it("hands the toast rows rather than a joined sentence", () => {
    /* ==================================================================
        THE ONE-LINE FORM WAS NOT A STYLING CHOICE
       ==================================================================
       REPORTED: "Cramming all the companies onto one line is unreadable ... vertically stacked and easily
       comparable."
       `detail` IS A `string`, joined with a middle dot at the source -- so by the time it reached the toast
       the rows had stopped being rows, and no CSS recovers a column from a sentence. The structure has to
       travel.
       ASSERTED ON THE SUMMARY ITSELF, not on the toast, because this is where the shape is decided. */
    const summary = summarisePrivateRevenueForPlayer(
      [
        { toPlayer: "p1", privateName: "Schuylkill Valley", amount: 5, companyId: null },
        { toPlayer: "p1", privateName: "Baltimore & Ohio", amount: 30, companyId: null },
        { toPlayer: "p2", privateName: "Camden & Amboy", amount: 25, companyId: null },
      ] as never,
      "p1",
    );
    expect(summary?.rows).toEqual([
      { label: "Schuylkill Valley", value: "$5" },
      { label: "Baltimore & Ohio", value: "$30" },
    ]);
  });

  it("keeps the joined line as well, for the surfaces that want a sentence", () => {
    /* `detail` IS NOT REPLACED. It is the shape every other consumer of a summary expects, and deleting it
       would make this function's output toast-specific -- the opposite of the separation #400 draws between
       settling and narrating. The two are the same figures in two shapes, so they are asserted together. */
    const summary = summarisePrivateRevenueForPlayer(
      [{ toPlayer: "p1", privateName: "Delaware & Hudson", amount: 20, companyId: null }] as never,
      "p1",
    );
    expect(summary?.detail).toBe("Delaware & Hudson $20");
    expect(summary?.rows).toEqual([{ label: "Delaware & Hudson", value: "$20" }]);
  });

  it("does not split the joined string back apart", () => {
    /* THE IMPLEMENTATION THIS RULES OUT, and it is the obvious cheap one: parse `detail` in the component.
       That makes a middle dot into load-bearing punctuation, and a private company whose name contained one
       would silently produce a wrong table -- a rendering bug with no error and no wrong figure. */
    expect(TOAST).not.toContain("detail.split");
    expect(TOAST).not.toContain("\\u00B7");
  });

  it("renders the rows as an aligned two-column grid", () => {
    /* "EASILY COMPARABLE" IS AN ALIGNMENT REQUIREMENT, not a line-break one. A flex column of pre-joined
       strings stacks the rows and still leaves the figures ragged; comparing $25 with $5 by eye needs the
       digits in one column, which is what the grid and `tabular-nums` are for. */
    const table = sliceBetween(TOAST, "detailTable: {", "},");
    expect(table).toContain('display: "grid"');
    expect(table).toContain('gridTemplateColumns: "auto auto"');
    expect(TOAST).toContain('textAlign: "right"');
    expect(TOAST).toContain('fontVariantNumeric: "tabular-nums"');
  });

  it("actually renders them (the gap this project keeps finding)", () => {
    /* ==================================================================
        ADDED BECAUSE A NEGATIVE CONTROL WALKED STRAIGHT THROUGH THE BLOCK ABOVE
       ==================================================================
       A control replacing the render guard with `{false && (` -- rows computed, styles defined, nothing on
       screen -- PASSED every case in this describe. The grid style existed, the prop existed, the summary
       emitted rows, and the toast drew none of them.
       THAT IS THIS CODEBASE'S SIGNATURE FAULT, named in `privatePowerStarWiring`'s header: "a correct pure
       module beside untouched wiring ... four batches where the calculation passed its own suite and nothing
       on screen changed." I wrote a suite for a rendering change and asserted everything except the
       rendering.
       SO THE MAP IS THE ASSERTION, and the guard with it: a truthy check that never fires renders nothing
       just as silently as a missing block. */
    expect(TOAST).toContain("{detailRows && detailRows.length > 0 && (");
    expect(TOAST).toContain("{detailRows.map((row) => (");
    expect(TOAST).toContain("{row.label}");
    expect(TOAST).toContain("{row.value}");
    expect(TOAST).toContain("style={styles.detailTable}");
  });

  it("wires the rows from the summary to the toast without a gap in the middle", () => {
    /* THE SAME FAULT ONE LEVEL UP, because the chain has three links and every one of them can be the
       missing one: the summary emits `rows`, the shell puts them in the toast's state, and the render reads
       them back out. Two of the three were already asserted and the third is where the control landed. */
    expect(APP).toContain("detailRows,");
    expect(APP).toContain("detailRows={actionToast?.detailRows ?? null}");
  });

  it("leaves every other toast without a table slot", () => {
    /* #697's RULE: the ordinary receipt has one thing to say and should not grow a slot it leaves empty. The
       rows are optional and exactly one caller passes them -- asserted as a count, because a second caller
       is how an optional slot quietly becomes a required one. */
    expect(APP.match(/mine\.rows/g)?.length ?? 0).toBe(1);
    expect(TOAST).toContain("detailRows = null,");
  });
});

describe("the auto-camera is dead (design note #987)", () => {
  /* ==================================================================
      A DELETION, ASSERTED ACROSS EVERY SURFACE IT REACHED
     ==================================================================
     RULED: "Strip out the map auto-zoom functionality completely" and "ensure the auto-camera functions are
     dead."
     THE FEATURE SPANNED FOUR FILES -- a chooser and a request in the shell, two props on the bar, a prop and
     an effect on the board, and a pure module underneath. A removal that half-lands leaves a prop threaded to
     nothing, which from any single file reads as correct. So this is a sweep rather than one absence. */

  it("has no chooser and no request left in the shell", () => {
    expect(APP).not.toContain("chooseFrameKeys");
    expect(APP).not.toContain("frameHexRequest");
    expect(APP).not.toContain("layTrackFrameKeys");
    expect(APP).not.toContain("handleFrameNetwork");
  });

  it("has no framing props left on the bar", () => {
    /* AN UNREAD PROP IS LEGAL, SILENT, AND INVISIBLE TO BOTH `tsc` AND ESLINT -- #660a's rule, and the exact
       way this codebase has left half-deletions behind before. */
    expect(BAR).not.toContain("onFrameNetwork");
    expect(BAR).not.toContain("canFrameNetwork");
  });

  it("has no framing effect left on the board", () => {
    expect(BOARD).not.toContain("frameHexRequest");
    expect(BOARD).not.toContain("frameHexes");
    expect(BOARD).not.toContain("lastFrameTokenRef");
  });

  it("has deleted the module rather than leaving it importable", () => {
    /* AN UNUSED PURE MODULE WITH A PASSING SUITE IS HOW A RULED-OFF FEATURE COMES BACK: it looks available,
       and its tests read as a commitment to keep it working. Checked on the filesystem, because "nothing
       imports it" and "it is gone" are different facts and only the second one holds. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(fs.existsSync(path.join(__dirname, "frameHexes.ts"))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, "frameHexes.test.ts"))).toBe(false);
  });

  it("leaves the player's own camera controls untouched", () => {
    /* ==================================================================
        THE HALF THAT MUST NOT GO WITH IT
       ==================================================================
       "Strip out the auto-zoom" is about moves the game makes on its own. The zoom buttons, the drag and Fit
       to Screen are moves the PLAYER makes, and deleting any of them would answer the report by removing the
       ability to zoom at all.
       `rememberedCamera` IS THE SUBTLE ONE and is deliberately kept. It carries the player's own pose across
       a remount so a round change does not throw their zoom away (#927); it initiates nothing. It is the
       piece most likely to be mistaken for auto-camera in a later sweep, which is why it is named here. */
    expect(BOARD).toContain("const handleFitToScreen");
    expect(BOARD).toContain("const handleZoomIn");
    expect(BOARD).toContain("const handleZoomOut");
    expect(BOARD).toContain("rememberedCamera");
  });

  it("leaves the Lay Track button a tab switch and nothing more", () => {
    /* REPORTED: "it scrolls to the top of the page". `scrollIntoView({ block: "start" })` puts the target's
       top edge at the viewport top -- so where the board pane IS near the top of the document, doing it
       correctly and scrolling to the top of the page are the same outcome. There was nothing to fix.
       THE TAB SWITCH IS THE HALF THAT WAS ALWAYS DOING WORK (#833): a player on the Stock Market tab has no
       map pane at all, and that is the one case where this button can help. */
    const goToMap = sliceBetween(BAR, "const goToMap = React.useCallback(", "}, [mapEl, onShowMap]);");
    expect(goToMap).toContain("if (!mapEl) onShowMap?.();");
    /* ==================================================================
        `scroll`, NOT `scrollTo` -- THE NARROW FORM LET A CONTROL THROUGH
       ==================================================================
       MY FIRST VERSION forbade `scrollTo`, and a control that put `mapEl?.scrollIntoView({...})` back into
       this callback PASSED: `scrollIntoView` does not contain the substring `scrollTo`. The assertion was
       named for one API and the browser offers several.
       WHAT THE RULE IS ABOUT is that this callback moves the PAGE not at all -- so the substring to forbid is
       the concept, not a method. */
    expect(goToMap).not.toContain("scroll");
    expect(BAR).not.toContain("scrollToMap");
    expect(BAR).not.toContain("mapJumpPending");
  });

  it("keeps the step panels' own jumps, which scroll to something below the fold", () => {
    /* THE DISTINCTION THAT BOUNDS THIS BATCH. Buy Trains and Buy Private scroll to a PANEL that is genuinely
       below the fold -- a real journey to a real destination, and neither one touches the camera. Only the
       map's binding was removed, and sweeping them up with it would have been the deletion overshooting. */
    expect(BAR).toContain("scrollToStepPanel");
    expect(BAR.match(/if \(!open\) scrollToStepPanel\(\);/g)?.length).toBe(2);
  });
});

describe("the arrows are sized against what a player can see (design note #985)", () => {
  it("expresses each tier as the ruled band", () => {
    expect(FLASH).toContain("critical: { low: 0.6, high: 0.8 }");
    expect(FLASH).toContain("minor: { low: 0.3, high: 0.5 }");
  });

  it("makes every arrow land inside its band by construction", () => {
    /* THE REASON `scale` IS A POSITION AND NOT A MULTIPLIER. Written as `base * scale`, "is this arrow inside
       the ruled range" is six separate checks and a future edit can walk one out of the band without
       touching the band. Written as a position from 0 to 1 across `low..high`, it cannot -- which is worth
       more than any assertion this file could make about the six values. */
    const scales = (FLASH.match(/scale: [\d.]+/g) ?? []).map((entry) =>
      Number(entry.replace(/[^\d.]/g, "")),
    );
    expect(scales.length).toBe(6);
    for (const scale of scales) {
      expect(scale).toBeGreaterThanOrEqual(0);
      expect(scale).toBeLessThanOrEqual(1);
    }
    expect(FLASH).toContain(".low +");
    expect(FLASH).toContain(".high -");
  });

  it("converts a drawn share into a font size", () => {
    /* ==================================================================
        THE ARITHMETIC #972 SKIPPED, WHICH IS WHY ITS NUMBERS WERE ALL WRONG
       ==================================================================
       The ruling is about DRAWN heights -- "60-80% of the size of the number text". #972 set a FONT SIZE and
       compared it to the numeral's font size. Those are different quantities: U+25B2 inks about seven tenths
       of its em, and the numeral is read by its cap height, `CAP_HEIGHT_RATIO` of ITS em. So a "0.55em" arrow
       drew at roughly 53% of the numeral and the smallest of the six at about 37% -- below the band, while
       the note claimed otherwise.
       BOTH FACTORS ASSERTED. Either one alone still leaves the size wrong, and the error is invisible in the
       output as anything but "a bit small", which is precisely how it survived a batch. */
    /* ==================================================================
        ASSERTED INSIDE THE `fontSize` EXPRESSION, BECAUSE THE FILE-WIDE FORM WAS VACUOUS
       ==================================================================
       MY FIRST VERSION was `expect(FLASH).toContain("CAP_HEIGHT_RATIO")`, and a control that replaced the
       multiplication with `* 1` PASSED -- the IMPORT still mentioned the constant, so the search found it
       while the conversion it names had been deleted. A test satisfied by an import is a test about nothing.
       SO THE SLICE IS THE EXPRESSION ITSELF. Both factors have to appear where the size is computed. */
    const size = sliceBetween(FLASH, "fontSize: `${", "}em`");
    expect(size).toContain("CAP_HEIGHT_RATIO");
    expect(size).toContain("ARROW_GLYPH_RATIO");
    expect(FLASH).toContain("const ARROW_GLYPH_RATIO = 0.7;");
    /* AND THE CAP RATIO IS THE SHARED ONE (#975), not a fourth copy of 0.72 written here. */
    expect(FLASH).toContain('from "../styles/typography"');
    expect(FLASH).not.toContain("0.72");
  });

  it("computes a critical arrow larger than a minor one at every position", () => {
    /* THE PROPERTY #957 INTRODUCED AND EVERY RESCALING SINCE HAS HAD TO KEEP: size is the channel a familiar
       player reads before the numeral resolves, and it says nothing unless the tiers stay apart. Driven as
       arithmetic over both bands rather than as a comparison of two numbers, because two overlapping ranges
       can have a higher midpoint and still collide at the edges. */
    const low = (tier: string) => Number(FLASH.match(new RegExp(`${tier}: \\{ low: ([\\d.]+)`))?.[1]);
    const high = (tier: string) =>
      Number(FLASH.match(new RegExp(`${tier}: \\{ low: [\\d.]+, high: ([\\d.]+)`))?.[1]);
    expect(low("critical")).toBeGreaterThan(high("minor"));
    expect(low("minor")).toBeGreaterThan(0);
  });
});

describe("the figure sits on a neutral backdrop (design note #986)", () => {
  it("renders a cream radial gradient behind the glyphs", () => {
    /* RULED: "render a white/cream radial gradient glow strictly behind the number and arrows ... 70% opacity
       at its center and fade out completely to 0% at its edges." */
    expect(FLASH).toContain('className="app-revenue-backdrop"');
    expect(FLASH).toContain("radial-gradient(ellipse closest-side");
    expect(FLASH).toContain('const BACKDROP_INK = "rgba(255, 250, 240, 0.7)"');
    expect(FLASH).toContain('const BACKDROP_FADE = "rgba(255, 250, 240, 0)"');
  });

  it("is an ellipse, not #960's circle", () => {
    /* THE SHAPE IS A CONSEQUENCE OF WHAT IT BACKS. The figure plus six arrows is far wider than it is tall,
       and `closest-side` on a CIRCLE sizes to the SHORT axis -- leaving the outer arrows outside the glow
       entirely, which is the half of the report about the number being lost against the Action Bar. */
    expect(FLASH).toContain("ellipse closest-side");
    const backdrop = sliceBetween(ANIM, ".app-revenue-backdrop {", "}");
    expect(Number(backdrop.match(/height: (\d+)%/)?.[1])).toBeGreaterThan(
      Number(backdrop.match(/width: (\d+)%/)?.[1]),
    );
  });

  it("carries no direction cue of its own", () => {
    /* WHY THIS CAN COEXIST WITH #973's RIM FLASH where #960's glow could not. That one was tinted to the
       OUTCOME, so keeping both would put the same hue behind the figure and around the screen -- one fact on
       two channels, which is #973's actual objection. A neutral cream says nothing about direction; it only
       lifts. Two elements, two jobs. */
    const backdrop = sliceBetween(FLASH, 'className="app-revenue-backdrop"', "/>");
    expect(backdrop).not.toContain("bonus");
    expect(backdrop).not.toContain("BONUS");
  });

  it("does not animate on a curve of its own", () => {
    /* A BACKDROP THAT FADED SEPARATELY FROM THE THING IT BACKS leaves a cream smudge over the board with
       nothing in it -- the failure #960 named for its own glow and then avoided with a matching keyframe. A
       static child of the animated overlay gets it for free and cannot come out of step. */
    const backdrop = sliceBetween(ANIM, ".app-revenue-backdrop {", "}");
    expect(backdrop).not.toContain("animation");
  });
});
