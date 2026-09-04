/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1161-1162 (harness): A LATCH AND AN INHERITED GROUND
// ==================================================================
//
// Two layout reports, and both turned out to be about a value that was never chosen -- one inherited from a
// flex default, the other inherited from a parent.
//
//   THE TRAY  was wrapped under the matrix by `flex-basis: auto`, which makes a flex item's hypothetical size
//             its CONTENT width. `min-width: 0` cannot prevent a wrap: the browser decides how many lines
//             there are before it consults min-width. And the break sustained itself, because the wrapped
//             column then had the whole row to measure and grew its cells to fill it.
//   THE MODAL and the card inside it were the same colour because the card declared no background at all.
//             Not two colours that resembled each other -- one colour, inherited.
//
// Both are the kind of fault that reads as "someone chose badly" and is actually "nobody chose".

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { CARD_SURFACE, CARD_SURFACE_MUTED, CARD_INK } =
  require("../styles/palette") as typeof import("../styles/palette");

const CHART = readStripped("components/StockMarketRenderer.tsx");
const MODAL = readStripped("components/PrivateRevenueModal.tsx");

const luminance = (hex: string): number => {
  const parts = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = parts.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("the matrix cannot push the tray off its line", () => {
  it("gives the grid's column a zero basis", () => {
    /* THE WHOLE BUG IN ONE KEYWORD. `flex-basis: auto` makes the hypothetical main size the content width --
       nineteen columns at the current cell size -- and a wrapping line is packed by hypothetical sizes, so
       the 168px tray had nowhere to go. A zero basis always fits, then grows into what is left. */
    const area = sliceBetween(CHART, "boardArea: {", "\n  },");
    expect(area).toContain('flex: "1 1 0"');
    expect(area).not.toContain('flex: "1 1 auto"');
    expect(area).toContain("minWidth: 0");
  });

  it("keeps the tray's fixed basis, which is the half that was always right", () => {
    /* #26 sized the tray deliberately and it was never the problem: a fixed slim column beside a grid that
       was supposed to shrink. Asserted so a future fix does not "balance" the two by loosening this one. */
    const slot = sliceBetween(CHART, "traySlot: {", "\n  },");
    expect(slot).toContain('flex: "0 0 168px"');
    expect(slot).toContain('minWidth: "168px"');
  });

  it("leaves the row wrapping, so a genuinely narrow window still folds", () => {
    /* THE FIX IS NOT `nowrap`. On a phone the tray SHOULD drop below the matrix -- what was wrong was doing
       it on a wide screen, and forbidding the wrap outright would trade one bad layout for another. */
    expect(sliceBetween(CHART, "boardRow: {", "\n  },")).toContain('flexWrap: "wrap"');
  });

  it("still derives the cell size from the space the tray leaves", () => {
    /* The observer was always measuring the right box; the box was the wrong width. Left intact, and named
       here because the latch worked THROUGH it -- a wrapped column measures the full row, so the cells grow,
       so the wrap can never undo itself. */
    expect(CHART).toContain("const cellFromWidth =");
    expect(CHART).toContain("observer.observe(wrapper)");
  });
});

describe("the modal and its cards are two surfaces", () => {
  it("stops the card inheriting the panel's ground", () => {
    /* AN OBJECT THAT DOES NOT DECLARE A GROUND cannot be distinguished from the one it sits on -- and it
       silently follows that one every time it changes, which is how this became invisible rather than
       merely subtle. */
    const card = sliceBetween(MODAL, "mine: {", "\n  },");
    expect(card).toContain("backgroundColor: CARD_SURFACE");
    expect(card).toContain("boxShadow:");
  });

  it("steps the container down rather than inventing a lighter card", () => {
    /* THE SUGGESTED FIX ASSUMED THE INK LADDER -- "a slightly lighter rung on the ink/purple ladder" -- and
       this is paper. `CARD_SURFACE` is the top of that ladder; there is no rung above it, so the depth has to
       come from the ground going down. The ladder already has the value for it. */
    const panel = sliceBetween(MODAL, "borderRadius: RADIUS.layer,", "fontFamily:");
    expect(panel).toContain("backgroundColor: CARD_SURFACE_MUTED");
  });

  it("separates the two surfaces enough to see and not enough to fight", () => {
    /* RUN, NOT SCANNED, because "looks lifted" is a number: adjacent large areas need a real step, and two
       competing brightnesses are their own problem. Asserted as a band rather than a value so the ladder can
       be retuned without this becoming a second definition of it. */
    const separation = contrast(CARD_SURFACE, CARD_SURFACE_MUTED);
    expect(separation).toBeGreaterThan(1.15);
    expect(separation).toBeLessThan(1.6);
  });

  it("keeps the panel's own text legible on the darker ground", () => {
    /* The captions and headings did not move; the surface under them did. AA is 4.5:1 and this must not have
       been quietly spent to buy the depth. */
    expect(contrast(CARD_INK, CARD_SURFACE_MUTED)).toBeGreaterThan(4.5);
  });
});
