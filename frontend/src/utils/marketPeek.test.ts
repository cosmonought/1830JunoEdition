/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1141 (harness): THE MINI-CAMERA MUST NOT BE A SECOND OPINION
// ==================================================================
//
// THE FEATURE WAS SPECIFIED AS A HOVER POPOVER OVER THE BUTTONS and was rebuilt as a click-gated modal over
// the readouts, after it turned out all three triggers already carry permanent consequence text -- #509a
// ("show the money moving, do not describe it"), #998 and #951 each arrived at that shape deliberately.
//
// SO THE RISK THIS FILE GUARDS IS NOT "does the popover open". It is #891, the fault this codebase produces
// more than any other: two components working out the same fact and disagreeing. A preview that walked its
// own step would be that fault with a magnifying glass on it -- and it would be INVISIBLE, because a preview
// is only ever compared with the board by a player who already suspects something.
//
// Every case below therefore asks either "does the preview read the authority?" or "does the camera frame
// the thing it was opened to show?" -- the two ways this can be wrong without looking wrong.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const {
  PRICE_GRID,
  projectDividendCellMove,
  projectShareSaleMove,
} = require("../components/StockMarketRenderer") as typeof import("../components/StockMarketRenderer");

const PREVIEW = readStripped("components/StockMarketPreview.tsx");
const MODAL = readStripped("components/MarketPeekModal.tsx");
const APP = readStripped("App.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const SR = readStripped("components/StockRoundPanel.tsx");

describe("the preview reads the board rather than re-deriving it", () => {
  it("computes no movement of its own", () => {
    /* ==================================================================
        DESIGN NOTE 1141: THE ONE THING THIS COMPONENT MUST NOT DO
       ==================================================================
       `dividendStepFrom` carries the ledge rule, the direction and the step count, and `App.tsx` wires the
       sandbox reducer to the very same arm -- so that arithmetic is not a readout, it IS the move. A second
       walk here would be free to disagree with the board about where the token lands, in a picture whose
       entire purpose is to show where the token lands.
       ASSERTED AS THE ABSENCE OF THE INGREDIENTS. A preview that stepped would have to name a direction or
       an axis somewhere; it has neither. */
    expect(PREVIEW).not.toContain("projectDividend");
    expect(PREVIEW).not.toContain("projectShareSaleMove");
    expect(PREVIEW).not.toContain("y - 1");
    expect(PREVIEW).not.toContain("y + 1");
    // What it DOES read: which cells exist, and what zone each one is.
    expect(PREVIEW).toContain("PRICE_GRID");
  });

  it("takes the neighbours as given rather than sorting them", () => {
    /* RULED: "ensure it lands in the correct visual stacking order if it enters a cell occupied by other
       tokens." The order arrives with `positions`, in the order the chart itself has it -- a preview that
       re-sorted the pile would be telling the player something about precedence that is not true. */
    expect(PREVIEW).not.toContain(".sort(");
    expect(PREVIEW).toContain("positions.filter(");
  });

  it("gives both openers the arm the reducer uses", () => {
    /* THE OTHER HALF OF THE SAME CLAIM, one level up: the shell resolves the destination, and it resolves it
       with the exported projections rather than with arithmetic of its own. */
    expect(APP).toContain("projectDividendCellMove(from, which, steps)");
    expect(APP).toContain("projectShareSaleMove(from, certificates)");
  });
});

/* ==================================================================
    DESIGN NOTE 1156 RETIRES THIS BLOCK WITH THE WINDOW IT GUARDED
   ==================================================================
   IT HAD FIVE CASES ABOUT `previewCentre`, and every one of them asked the same question: given that only
   five columns can be shown, are they the RIGHT five -- does the destination stay in frame on a double move,
   does a four-block sale, is the window ever centred somewhere the chart cannot fill. Good questions about a
   camera that has to crop.
   THE CAMERA NO LONGER CROPS. The dialog was widened and the whole 19x11 board is drawn, so there is no
   centre to choose and no cell that can fall outside the frame -- `previewCentre` is deleted rather than left
   exported with no caller. The property that replaces all five is one line in `marketCamera.test.ts`: every
   cell of `PRICE_GRID` is rendered. A test for the right crop cannot survive the crop being removed. */

describe("the move repeats without ever running backwards", () => {
  it("snaps back rather than animating the return", () => {
    /* ==================================================================
        DESIGN NOTE 1142: THE LOOP THAT WOULD HAVE TAUGHT THE OPPOSITE
       ==================================================================
       RULED: "if it plays once on click players may not have time to take everything in, so looping it lets
       them get settled and see it clearly."
       THE OBVIOUS LOOP IS A TOGGLE ON A TIMER, and it animates the token BACK as well as forward -- so a
       withhold preview would show the price RISING for half of every cycle. Not a rougher version of the
       truth: the other decision, shown to a player who is looking at this picture precisely because they
       have not yet internalised which way the token goes.
       THE RESET IS A CUT. `movingTokenInstant` kills the transition for exactly the render that returns the
       token to its start, so the only motion an eye ever sees is the real one.
       ASSERTED AS THE EXISTENCE OF THAT OFF-STATE, because a loop without it looks correct in source and is
       wrong on screen -- which is the only kind of bug this preview can have. */
    expect(PREVIEW).toContain("movingTokenInstant");
    expect(PREVIEW).toContain('transition: "none"');
    expect(PREVIEW).toContain("phase.animate ? {} : styles.movingTokenInstant");
  });

  it("chains its three legs rather than running one interval", () => {
    /* Rest, slide, hold, snap -- four moments of three different lengths. An interval long enough for the
       whole cycle cannot also fire the snap in the middle of it. */
    expect(PREVIEW).toContain("const SLIDE_MS = 420;");
    expect(PREVIEW).toContain("const HOLD_MS = 1100;");
    expect(PREVIEW).toContain("const REST_MS = 500;");
    expect(PREVIEW).not.toContain("setInterval");
    expect(PREVIEW).toContain("window.clearTimeout(timerRef.current)");
  });

  it("gives a reduced-motion reader the answer instead of the animation", () => {
    /* The destination is the INFORMATION; the slide is how it is delivered. A player who has asked their
       system for less movement still needs to know where the token lands, so the preview places it there and
       never loops. */
    expect(PREVIEW).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(PREVIEW).toContain("if (prefersReducedMotion) {");
    expect(PREVIEW).toContain("setPhase({ atStart: false, animate: false });");
  });
});

describe("the trigger is a click on the readout, not a hover on the button", () => {
  it("leaves the permanent readouts exactly where they were", () => {
    /* THE PART OF THE BRIEF THAT WAS TURNED DOWN, kept as a guard: hovering the decision buttons would have
       duplicated a fact three components already state, gated it behind a pointer, and re-added the row #951
       consolidated away. The lines themselves are untouched -- every figure, arrow and parenthetical. */
    /* ==================================================================
        DESIGN NOTE 1153 SUPERSEDES THE SPELLING OF THIS ONE ASSERTION
       ==================================================================
       IT PINNED `"Market move: <ZonedPrice price={currentPrice} />"` -- the label, the colon and the element,
       as one run of source. #1153 split that line into a LABEL cell and a FIGURES cell so its `$current ->
       $new` lands in the same column as the payout rows above it (reported: "the 'market move' on payout needs
       to be aligned with the other $current > $new values"), and the colon went with the sentence.
       THE CLAIM WAS NEVER ABOUT THE MARKUP. #1141's property is that the readout is PERMANENT -- that the
       mini-camera was added beside it rather than replacing it with something hover-gated -- so what has to be
       true is that the line still states both prices unconditionally. That is asserted directly now, and it
       survives any future rewording of the label. */
    expect(BAR).toContain("<ZonedPrice price={currentPrice} />");
    expect(BAR).toContain("<ZonedPrice price={projection.price} />");
    expect(BAR).toContain("Market move");
    expect(BAR).toContain("(double move)");
    expect(SR).toContain("already at the bottom of its column");
    /* NO HOVER ON THE TRIGGER, which is the claim -- and it is asserted against `MarketMoveLine` itself
       rather than against the whole file. The bar DOES carry an `onMouseEnter`, on the route chips, for
       highlighting a drafted route on the map; a blanket "this file has no hover handlers" would have failed
       on unrelated code and said nothing about the mini-camera either way. */
    const line = sliceBetween(BAR, "function MarketMoveLine({", "\n}\n");
    expect(line).not.toContain("onMouseEnter");
    expect(line).toContain("onClick={onOpenChart}");
    expect(PREVIEW).not.toContain("onMouseEnter");
  });

  it("offers the door only where there is a chart to open", () => {
    /* The readout has a "not on the market chart" branch for an unfloated corporation. A button promising a
       view of a position that does not exist is worse than no button. */
    expect(BAR).toContain("onOpenChart?: () => void;");
    expect(BAR).toContain("{onOpenChart && (");
    expect(SR).toContain("{onPeekMarket && (");
  });

  it("keeps the panels out of the market data business", () => {
    /* Both panels hold PRICES and neither has ever held a cell coordinate. Handing them `marketGrid` so they
       could draw a preview would widen a panel that already takes ninety props. They pass a question up. */
    expect(BAR).toContain("onPeekMarket?: (which: \"pay\" | \"withhold\") => void;");
    expect(SR).toContain("onPeekSaleMarket?: (companyId: number, certificates: number) => void;");
    expect(BAR).not.toContain("StockMarketPreview");
    expect(SR).not.toContain("StockMarketPreview");
  });
});

describe("the dialog behaves like the other dialogs in this app", () => {
  it("closes on Escape and on the backdrop, and not on itself", () => {
    expect(MODAL).toContain('event.key === "Escape"');
    expect(MODAL).toContain("onClick={onClose}");
    expect(MODAL).toContain("onClick={(event) => event.stopPropagation()}");
  });

  it("returns focus to whatever opened it", () => {
    /* Without this a keyboard player who closes the dialog lands at the top of the document -- which on the
       Operating Round panel means finding the dividend columns again. */
    expect(MODAL).toContain("document.activeElement");
    expect(MODAL).toContain("opener.focus()");
  });

  it("is separable from the chart it frames", () => {
    /* The preview knows nothing about being in a dialog, which is what lets the Stock Round summon the same
       component from a different control. Asserted as the absence of the backdrop from the preview. */
    expect(PREVIEW).not.toContain("position: \"fixed\"");
    expect(PREVIEW).not.toContain("aria-modal");
  });
});
