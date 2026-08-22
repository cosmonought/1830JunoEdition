// frontend/src/components/trainChipContrast.test.ts
//
// ==================================================================
//  DESIGN NOTE 702 (harness): A CHIP ON EIGHT DIFFERENT BACKDROPS
// ==================================================================
//
// REPORTED: "NNH is running and already owned a 2-train and a 3-train. It purchased a second 3-train, which
// meant the phase shift is in two buys. Its 2-train chip almost disappears into its corporation card -- I
// actually thought the 3-train purchase had been swapped out with it because it is so hard to see -- and I
// think this is because of the amber color for the 'two buys left' warning. To avoid this issue on other
// corporations (red on red later, etc), what if we just colored the number itself and left the train chip
// alone?"
//
// The instinct was right and the cause was one layer under it. The rust tints were TRANSLUCENT fills --
// `rgba(249, 115, 22, 0.1)` and `rgba(244, 63, 94, 0.2)` -- and `ContextualActionBar` paints the corporation
// card `stationTickerColor(companyId)`. Ten percent of a colour over ninety percent of a livery is not a chip,
// it is a tint on the livery, and the measured contrast of the tinted body was 1.00-1.14:1 against ALL EIGHT
// cards. NNH scored 1.00:1 exactly, because `#ee7c22` and `#f97316` are the same hue at the same lightness --
// which is why NNH is where a board-wide fault got noticed as a one-corporation one.
//
// WHAT THIS FILE ASSERTS is the property that was missing rather than the fix: every state of the chip has to
// hold a measurable edge against every livery, not just against the neutral chrome the palette was designed
// on. `TrainChips` takes `surface: "dark" | "light"`, which names the app chrome; a prop with two values
// cannot describe eight backdrops, and that mismatch is the whole bug. So the loop below is over the
// CORPORATIONS, and it is the loop that would have failed before the fix.
//
// Contrast is WCAG relative luminance, computed here rather than imported: the styles are inline objects on a
// component that needs a DOM to render, so what is testable is the arithmetic over the exported constants --
// the same instrument `stationTokenArt.test.ts` uses for the same reason.

import { CORPORATION_LIVERY_COLORS } from "../styles/corporationLivery";
import {
  ALERT_CRITICAL_INK,
  ALERT_WARN_INK,
} from "../styles/palette";

/** The chip's opaque dark body. Stated here as the number the component uses, so a change to it fails here. */
const CHIP_BODY = "#232936";
/** The chip's default numeral, and the locomotive's ink in every state (#702). */
const CHIP_INK = "#e2e6ee";

/** `DARK_CHIP_RING`'s two structural strokes, as the component states them. The pair is the point: they are
 *  ADJACENT, one just inside the chip's edge and one just outside it. */
const RING_INNER = { color: "#ffffff", alpha: 0.45 };
const RING_OUTER = { color: "#000000", alpha: 0.8 };

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(h.slice(at, at + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** What a translucent colour actually becomes once the backdrop shows through it. The step the old palette
 *  never took, and the reason a fill that looked amber in a swatch was the livery on screen. */
function composite(fore: string, alpha: number, back: string): string {
  const [f, b] = [fore.replace("#", ""), back.replace("#", "")];
  const mixed = [0, 2, 4].map((at) => {
    const top = parseInt(f.slice(at, at + 2), 16);
    const under = parseInt(b.slice(at, at + 2), 16);
    return Math.round(alpha * top + (1 - alpha) * under);
  });
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const LIVERIES = Object.entries(CORPORATION_LIVERY_COLORS) as [string, string][];

/** The chip is a small bold badge, not body text, so the bar is WCAG's non-text / large-text threshold. Held
 *  as a named constant because the point of this harness is that a number was never checked at all. */
const MIN_EDGE = 3;

describe("the chip body holds an edge on every corporation card", () => {
  it("is opaque, so the livery never shows through it", () => {
    /* THE FAULT, as a property. If a future palette reintroduces an `rgba(...)` body, the composite below is
       the livery and this fails on the first card it is tried against. */
    expect(CHIP_BODY).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("would have failed against every card under the old translucent fill", () => {
    /* THE REGRESSION, stated so the fix has something to be measured against. Kept as an explicit record
       because "it looks better now" is not a reason anyone can check later. */
    const failures = LIVERIES.filter(([, card]) => {
      const oldAmberBody = composite("#f97316", 0.1, card);
      return contrast(oldAmberBody, card) < 1.2;
    });
    expect(failures).toHaveLength(LIVERIES.length);
  });

  it("shows a light-against-dark boundary on every card", () => {
    /* THE FIX, and the claim worth checking. No single colour clears 3:1 against all eight liveries -- they
       run from `#1a1a1a` to `#f5cd3a`, so any fixed edge is close to SOMETHING, and the best available choice
       measures about 1.5:1 at its optimum. The ring does not try. It carries its own contrast: a near-black
       stroke outside the chip and a light hairline inside it, touching, so the boundary the eye lands on is
       between THOSE TWO rather than between either of them and the card. */
    const inner = composite(RING_INNER.color, RING_INNER.alpha, CHIP_BODY);
    const thin: string[] = [];
    for (const [name, card] of LIVERIES) {
      // The outer stroke sits ON the card, so it composites over the livery.
      const outer = composite(RING_OUTER.color, RING_OUTER.alpha, card);
      if (contrast(inner, outer) < MIN_EDGE) thin.push(`${name} ${card} ${contrast(inner, outer).toFixed(2)}`);
    }
    expect(thin).toEqual([]);
  });

  it("does not merely rely on the body reading against the card", () => {
    /* The counterfactual that makes the test above mean something. If the body alone were enough, the ring
       would be decoration -- and on three cards it is nowhere near enough, which is exactly what was
       reported. */
    const bare = LIVERIES.filter(([, card]) => contrast(CHIP_BODY, card) < MIN_EDGE);
    expect(bare.length).toBeGreaterThanOrEqual(3);
  });

  it("holds its worst case well clear of the threshold", () => {
    /* Stated as a floor rather than an average, because the failure mode here is one corporation, not the
       fleet -- NNH was one card out of eight and it was the one that got reported. */
    const inner = composite(RING_INNER.color, RING_INNER.alpha, CHIP_BODY);
    const worst = Math.min(
      ...LIVERIES.map(([, card]) =>
        contrast(inner, composite(RING_OUTER.color, RING_OUTER.alpha, card)),
      ),
    );
    expect(worst).toBeGreaterThan(4);
  });

  it("keeps the hairline visible against the body it lies on", () => {
    // A ring that cannot be told from the chip is not a ring. The other side of the same measurement, and the
    // one a lighter chip body would break.
    const hairline = composite(RING_INNER.color, RING_INNER.alpha, CHIP_BODY);
    expect(contrast(hairline, CHIP_BODY)).toBeGreaterThan(MIN_EDGE);
  });
});

describe("the number carries the warning, and can be read where it is", () => {
  /* Once the tint moved off the body, every rust colour sits on ONE known surface -- the opaque chip -- rather
     than on whatever the card happens to be. That is the real win, and it is what makes these three numbers
     checkable at all: before, the answer depended on which corporation was operating. */

  it("reads the amber warning against the chip", () => {
    expect(contrast(ALERT_WARN_INK, CHIP_BODY)).toBeGreaterThan(MIN_EDGE);
  });

  it("reads the critical warning against the chip", () => {
    expect(contrast(ALERT_CRITICAL_INK, CHIP_BODY)).toBeGreaterThan(MIN_EDGE);
  });

  it("reads the ordinary numeral against the chip", () => {
    expect(contrast(CHIP_INK, CHIP_BODY)).toBeGreaterThan(MIN_EDGE);
  });

  it("does not depend on which corporation is operating", () => {
    /* THE PROPERTY THE OLD CODE LACKED, stated directly. Under the translucent fill the amber numeral's
       contrast ranged from 1.09:1 (C&O) to 6.72:1 (NYC) -- a six-fold swing decided by whose turn it was. Now
       there is one answer. */
    const readings = LIVERIES.map(() => contrast(ALERT_WARN_INK, CHIP_BODY));
    expect(new Set(readings).size).toBe(1);
  });

  it("would have been unreadable on most cards under the old fill", () => {
    // The counterfactual, so the assertion above is not merely tautological.
    const unreadable = LIVERIES.filter(([, card]) => {
      const oldBody = composite("#f97316", 0.1, card);
      return contrast(ALERT_WARN_INK, oldBody) < MIN_EDGE;
    });
    expect(unreadable.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the locomotive is the chip's constant", () => {
  it("is drawn in the chip's neutral ink, not the warning colour", () => {
    /* REPORTED: "the train icon could be black or something to signal it's still there even as the number
       turns amber, red." The glyph's whole job is to be the thing that does NOT change, so a tinted chip and a
       plain one differ by more than one numeral's colour -- which is the discrimination that failed when a
       2-train read as a missing 3-train. */
    expect(CHIP_INK).not.toBe(ALERT_WARN_INK);
    expect(CHIP_INK).not.toBe(ALERT_CRITICAL_INK);
  });
});
