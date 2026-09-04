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
  it("shows for long enough to be seen at all", () => {
    /* RULED: "Reduce its display duration to strictly `400ms`."
       ASSERTED AS THE VALUE AND AS A RELATIONSHIP. #967 built this constant as `STANDARD_TOAST_MS * 1.5`,
       so a reader who only saw the multiplier would expect it to track the standard window; it does not any
       more, and a future change to the standard must not drag this back up with it.
       ==================================================================
        400 MEANT THE TOAST WAS NEVER SEEN (design note #1000)
       ==================================================================
       THIS ASSERTED 400, ON INSTRUCTION. REPORTED SINCE: "Players are not getting the toast notifications for
       private company payouts."
       THE WIRING WAS INTACT AND THE WINDOW WAS THE BUG. The toast's own entrance takes 180ms
       (`app-action-toast-in`), so 400 left roughly 220ms at rest -- it was removed before it had finished
       arriving. #983 records the arithmetic that predicted this and shipped the number anyway, which is worth
       naming: a warning inside a design note is not a warning anybody reads at the moment it matters.
       WHAT SURVIVES IS THE RELATIONSHIP, not the figure: this is still the one toast with a window of its own
       (#967's distinction, a table rather than a sentence), and it is still far shorter than the 5,550 that
       started the complaint. The number is checked against the entrance it has to outlast rather than
       asserted bare. */
    /* ==================================================================
        AND 2000 WAS STILL A GLANCE (design note #1016)
       ==================================================================
       REPORTED: "The private company payout toast disappears too quickly." #1000 sized the window off the
       MIDDLE of a one-to-three-row table; the three-row case is the common one, and 2000ms left 1.8s at rest
       against a ~1.4s read -- 1.3x, where this project's own rule of thumb is 1.5x.
       THE BARE LITERAL GOES WITH IT. This constant has now moved three times and the assertion has had to be
       edited three times; that is a test pinned to a figure rather than to the property the figure serves.
       What it is FOR is that the window outlasts the entrance by enough to be read, and that it is still far
       shorter than the 5,550 that started the complaint -- both of which are stated below as relationships
       and neither of which needs re-editing when the number is tuned again. */
    expect(PRIVATE_REVENUE_TOAST_MS).toBeLessThan(STANDARD_TOAST_MS * 2);
    expect(TOAST).toContain("export const PRIVATE_REVENUE_TOAST_MS = ");
    expect(TOAST).not.toContain("STANDARD_TOAST_MS * 1.5");
    /* THE ENTRANCE IS THE FLOOR. A window shorter than the slide-up plus a beat is a toast nobody sees, which
       is the whole of this report -- so the constant is compared with the animation it must outlast. */
    const entrance = Number(TOAST.match(/app-action-toast-in (\d+)ms/)?.[1]);
    expect(entrance).toBeGreaterThan(0);
    expect(PRIVATE_REVENUE_TOAST_MS).toBeGreaterThan(entrance * 5);
  });

  it("still names the window once, rather than inlining it at the call site", () => {
    /* THE HALF OF #967 WORTH KEEPING. One place to change and a test that reads the constant instead of a
       copy of it -- which is the only reason the case above can assert a number at all. */
    /* Design note #1016: the call site gained an `anchor` argument, so the two are no longer adjacent -- the
       claim is that the constant is NAMED at the call site rather than inlined, which is what makes the case
       above able to read it instead of a copy of it.
       ==================================================================
        DESIGN NOTE 1049: THERE IS NO CALL SITE LEFT, AND THE FIGURE IS STILL NAMED ONCE
       ==================================================================
       THIS PINNED `PRIVATE_REVENUE_TOAST_MS,` IN `App.tsx`. The private payout became a modal, so `App.tsx`
       neither imports nor names the constant -- and an assertion that it does could now only be satisfied by
       putting a duration back into a file that no longer has anything to time.
       THE PROPERTY THIS CASE DEFENDS IS "ONE PLACE, NOT A COPY", and it moves to where the one place is. The
       declaration is asserted directly, and the NEGATIVE below is kept exactly as it was: it forbids the
       literal being written out at a call site, which is the failure the case exists to catch and is still
       possible for any future caller. Keeping the negative is what stops this becoming a case that passes by
       having nothing to check. */
    expect(TOAST).toContain("export const PRIVATE_REVENUE_TOAST_MS = ");
    expect(APP).not.toContain("showDividendToast(mine.text, mine.detail, null, 3200");
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
    /* ==================================================================
        DESIGN NOTE 1052: PINNED AS THE PAIR IT IS ABOUT, NOT AS THE WHOLE ROW
       ==================================================================
       THIS WAS `toEqual([{ label, value }, ...])`, which asserts the row has EXACTLY those two fields -- so
       #1052 adding `privateId` for the payout modal's enumeration broke a case that has nothing to do with
       enumeration. That is my most frequent failure in this project and this is its cleanest example: the
       case's subject is that the STRUCTURE travels instead of a joined sentence, and it was written in a form
       that also silently forbade the structure ever growing.
       THE SUBJECT IS UNCHANGED AND IS NOW WHAT IS ASSERTED: two rows, in order, each carrying its name and
       its figure as separate fields. A regression to a joined string still fails this; a third field does
       not. `toMatchObject` is the shape-with-room-to-grow form of the same claim. */
    expect(summary?.rows).toHaveLength(2);
    expect(summary?.rows).toMatchObject([
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
    // Design note #1052: `toMatchObject`, for the reason the case above records.
    expect(summary?.rows).toMatchObject([{ label: "Delaware & Hudson", value: "$20" }]);
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
       ==================================================================
        SUPERSEDED BY #1014 -- BY INSTRUCTION, NOT BY DRIFT
       ==================================================================
       RULED SINCE: "Remove ALL zoom features and controls from the map and UI entirely. Ensure the viewport is
       locked and strictly prevents user scaling", with panning confirmed to go with it in review.

       SO THE DISTINCTION THIS CASE PROTECTED NO LONGER HAS TWO SIDES. #987's line was between moves the GAME
       makes and moves the PLAYER makes, and it was the right line then: deleting the player's controls would
       have answered an auto-camera report by removing the ability to zoom at all. The player's controls have
       now been removed deliberately and on their own instruction, which is a different act with a different
       reason.

       WHAT THIS CASE STILL GUARDS is the half of #987 that never changed: the AUTOMATIC camera stays dead. A
       later batch restoring a zoom control would be a decision; a later batch restoring a `fitBounds` call on
       a round transition would be #987's bug returning, and that is what the assertions above this one are
       for. Inverted rather than deleted so the supersession is visible in the run. */
    expect(BOARD).not.toContain("const handleFitToScreen");
    expect(BOARD).not.toContain("const handleZoomIn");
    expect(BOARD).not.toContain("const handleZoomOut");
    expect(BOARD).not.toContain("rememberedCamera");
  });

  it("leaves the Lay Track button a tab switch and nothing more", () => {
    /* REPORTED: "it scrolls to the top of the page". `scrollIntoView({ block: "start" })` puts the target's
       top edge at the viewport top -- so where the board pane IS near the top of the document, doing it
       correctly and scrolling to the top of the page are the same outcome. There was nothing to fix.
       THE TAB SWITCH IS THE HALF THAT WAS ALWAYS DOING WORK (#833): a player on the Stock Market tab has no
       map pane at all, and that is the one case where this button can help. */
    /* Design note #1164: the dependency list gained `onSayWhereToClick`, so this slice's END MARKER moved --
       it named the deps verbatim, which is the narrowest possible way to describe "the end of this callback".
       Sliced to the closing brace instead; what the case is about is the BODY, and the body's claim is
       unchanged. */
    const goToMap = sliceBetween(BAR, "const goToMap = React.useCallback(", "\n  }, [");
    expect(goToMap).toContain("if (!mapEl) onShowMap?.();");
    /* ==================================================================
        DESIGN NOTE 1164 ADDS A SENTENCE, NOT A MOVEMENT
       ==================================================================
       The callback now also SAYS where to click, because #987 left it a deliberate no-op once the map is
       showing and a player pressing an inert control deserves an answer. That is speech, not navigation --
       the rule this case guards is that the callback moves the PAGE not at all, and it still does not. */
    expect(goToMap).toContain("onSayWhereToClick?.(");
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

describe("the overlay fades in as well as out (design note #999)", () => {
  it("mounts transparent and rises on the next frame", () => {
    /* ==================================================================
        THERE WAS NO FADE-IN, AND #971's REMOUNT IS WHY
       ==================================================================
       REPORTED: the glow "seems to just appear on the screen instead of fading in and out", refined to "the
       fade in may be happening, but it is very abrupt."
       IT WAS NOT HAPPENING AT ALL. Opacity here is a CSS `transition`, which needs a previous value to move
       from. While the overlay stayed mounted between flashes it had one -- `visible` went false, then true.
       #971 made it UNMOUNT after its window and remount on a changed key, and a freshly inserted element
       commits at `opacity: 1` with nothing to transition from. The fade-OUT still worked, which is exactly
       why the report describes an abrupt arrival rather than a missing feature.
       SO #971 FIXED THE ARROWS AND BROKE THE ARRIVAL IN ONE EDIT. Remounting to replay an animation is the
       right tool and it silently disables every transition on the node it remounts -- worth a case of its
       own, because the two are the same mechanism pointing opposite ways.
       ASSERTED AS THE PAIR: the explicit `false` and the frame callback that follows it. Either alone is a
       state a half-done fix reaches, and the `false` looks redundant to a reader who does not know that a
       re-trigger mid-fade arrives with `visible` already false. */
    /* #490a: ANCHORED ON CODE, NOT ON A COMMENT. My first version ended the slice at
       "// Design note #940: the TOKEN" -- which `readStripped` removes, so `sliceBetween` threw rather than
       passing vacuously. The same mistake #955's harness records, caught by the thrower this time. */
    /* Design note #1095: the dependency array gained `onDone`, so the anchor is the array's opening rather
       than its whole contents -- a list pinned complete breaks every time anything is added to it, which is
       the mistake this suite has made more often than any other. */
    const effect = sliceBetween(FLASH, "if (!signal) return undefined;", "}, [signal?.token, signal");
    expect(effect).toContain("setVisible(false);");
    expect(effect).toContain("window.requestAnimationFrame(() => setVisible(true))");
    expect(effect).not.toContain("setVisible(true);\n    const timer");
  });

  it("cancels the frame it queued", () => {
    /* A PENDING FRAME AFTER AN UNMOUNT sets state on a component that is gone -- and worse, a re-trigger
       inside one frame would leave two callbacks racing to raise the same overlay. The cleanup already
       cleared both timers; the frame is the third thing this effect starts. */
    const cleanup = sliceBetween(FLASH, "return () => {", "};");
    expect(cleanup).toContain("window.cancelAnimationFrame(rise);");
  });

  it("times the rise and the fall separately", () => {
    /* RULED: "let's move the juice to 900ms and the fade in/out to 300ms each."
       TWO CONSTANTS EVEN THOUGH BOTH ARE 300 TODAY, because they answer different questions -- how fast
       should this arrive, how slowly should it leave -- and juice conventionally moves fast in and slow out.
       Naming them apart is what makes trying that a one-line change rather than a refactor.
       THE TRANSITION READS THE DIRECTION, which is the mechanism: React writes the style for the state being
       entered, so the rise and the fall can differ without a second element or a keyframe. */
    expect(FLASH).toContain("export const REVENUE_FLASH_RISE_MS = 300;");
    expect(FLASH).toContain("export const REVENUE_FLASH_FADE_MS = 300;");
    /* `no-template-curly-in-string` RIGHTLY OBJECTS to `${...}` inside a plain string, so the interpolation
       is assembled rather than typed -- the same dodge `#779`'s harness uses for its dollar sign. What is
       being asserted is the source text of a template literal, which is a string to this file. */
    const DOLLAR = String.fromCharCode(36);
    expect(FLASH).toContain(
      "transition: `opacity " +
        DOLLAR +
        "{visible ? REVENUE_FLASH_RISE_MS : REVENUE_FLASH_FADE_MS}ms ease-out`",
    );
  });

  it("keeps the backdrop on the overlay's own curve", () => {
    /* #986 GAVE THE BACKDROP NO ANIMATION ON PURPOSE -- "a backdrop that faded on a different curve from the
       thing it backs would leave a cream smudge over the board with nothing in it". That decision is what
       makes this fix reach the glow the report was actually about: it inherits the overlay's opacity, so
       fixing the overlay's rise fixes the glow's without a second timeline to keep in step. */
    const backdrop = sliceBetween(ANIM, ".app-revenue-backdrop {", "}");
    expect(backdrop).not.toContain("animation");
    expect(backdrop).not.toContain("transition");
  });

  it("leaves enough time at full opacity to read the figure", () => {
    /* ==================================================================
        "900ms" IS TIME BEFORE IT LEAVES, NOT TIME ON SCREEN
       ==================================================================
       READ AS A TOTAL, 900 with a 300ms rise and a 300ms fall would leave 300ms at full opacity -- less than
       half what the overlay had before this batch, which would be a legibility regression arriving as a
       polish request. Read as the window before the fade STARTS, the overlay is on screen for 1,200ms and
       fully opaque for 600.
       CHECKED AS THE ARITHMETIC rather than as three literals, so the next change to any of the three has to
       keep the property rather than merely keep the numbers. */
    const window = Number(FLASH.match(/REVENUE_FLASH_MS = (\d+)/)?.[1]);
    const rise = Number(FLASH.match(/REVENUE_FLASH_RISE_MS = (\d+)/)?.[1]);
    expect(window - rise).toBeGreaterThanOrEqual(500);
  });
});
