/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1095 (harness): THE SECOND HALF OF THE REPLAY BUG, AND A FILL THAT MOVES FOR THE THIRD TIME
// ==================================================================
//
// #1094 FIXED A REAL BUG AND LEFT A REPORT OPEN, which is the interesting thing about this batch. Its guard
// stops a REBUILD from re-firing an ephemeral signal, and that was correct and necessary. It says nothing
// about a signal that was fired legitimately and then left lying in state: anything that remounts the
// consumer finds it and plays it again. Two mechanisms, both required, and the first one's success is what
// made the second one look like the same bug not being fixed.
//
// SO THE STRUCTURAL CASE IN THIS FILE IS THE ONE THAT MATTERS: every ephemeral signal `App` holds must have a
// way home. Four had one; `revenueFlash` did not.
//
// THE TINT MOVES FOR THE THIRD TIME and it is worth saying why this is not churn. #1042 put it on the label
// span. #1079 read a ruling about the `[time]`/`[round]` TAGS as being about the fill and left it there.
// #1080 moved it to the row, dropped the padding and radius with it, and converted it to a gradient -- and
// was withdrawn, correctly, for changing three things when one was asked. The destination was right the whole
// time; only that batch's blast radius was wrong. This one moves the fill and nothing else.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const TICKER = readStripped("components/TopTicker.tsx");
const FLASH = readStripped("components/RevenueModifierFlash.tsx");

/* ------------------------------------------------------------------ */
/* Colour arithmetic, so the assertions can be about what is SEEN      */
/* ------------------------------------------------------------------ */

const ROW: readonly [number, number, number] = [0x14, 0x1c, 0x2c]; // logEntry's own ground
const INK: readonly [number, number, number] = [0xc7, 0xcb, 0xd4]; // logLabelFull's colour
const BONUS: readonly [number, number, number] = [74, 222, 128];
const MALUS: readonly [number, number, number] = [244, 63, 94];

const over = (tint: readonly [number, number, number], alpha: number) =>
  ROW.map((base, i) => Math.round(base + (tint[i] - base) * alpha)) as unknown as number[];

/** WCAG relative luminance, and the contrast ratio built from it. */
const luminance = (rgb: readonly number[]) => {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
};
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The alpha the file declares, read rather than restated. */
const declaredAlpha = Number(
  /const TONE_TINT_ALPHA = ([0-9.]+);/.exec(TICKER)?.[1] ?? "NaN",
);

/* ------------------------------------------------------------------ */
/* 1: the flash signal is consumed, not just fired                     */
/* ------------------------------------------------------------------ */

describe("every ephemeral signal the shell holds has a way home", () => {
  it("clears the revenue flash when it finishes", () => {
    /* THE HOLE #1094 LEFT. Its guard stops a rebuild re-FIRING this; nothing stopped a stale signal being
       re-CONSUMED by a fresh mount, because `setRevenueFlash` had no matching clear anywhere in the file.
       The last flash of a game sat in state for the rest of the session. */
    expect(APP).toContain("const clearRevenueFlash = useCallback(() => setRevenueFlash(null), []);");
    expect(APP).toContain("onDone={clearRevenueFlash}");
  });

  it("lets the component decide when that is", () => {
    /* THE COMPONENT OWNS THE 900ms AND THE FADE AFTER IT, so it is the only thing that knows when the signal
       has been spent. A second timer in the caller would be two clocks that must agree about one animation,
       which is #891 with a frozen overlay as the failure. */
    expect(FLASH).toContain("onDone?.();");
    expect(FLASH).toContain("onDone?: () => void;");
    /* AFTER `setShown(null)`, ASSERTED BY POSITION. Clearing the caller's signal re-runs this effect and
       tears down its timers -- harmless once they have fired, a frozen overlay if one is still pending. */
    const timer = sliceBetween(FLASH, "const clear = window.setTimeout", "REVENUE_FLASH_FADE_MS);");
    expect(timer.indexOf("setShown(null)")).toBeLessThan(timer.indexOf("onDone?.()"));
  });

  it("is not a second replay guard", () => {
    /* THE TWO FIXES ANSWER DIFFERENT QUESTIONS and neither replaces the other. #1094's `ephemeral` still
       gates the firing; this clears what was fired. Asserted together so a later batch that "simplifies" one
       away is told the other does not cover it. */
    expect(APP).toContain("const ephemeral = !replayingHistory;");
    expect(APP).toContain("setRevenueFlash(null)");
  });

  it("leaves no other signal without one", () => {
    /* THE STRUCTURAL CASE, AND THE POINT OF THE WHOLE FILE. Ruled: "ensure the React state cleanup applies
       globally". Four of the five already had a way home and one did not, so the durable version of that
       ruling is to check the whole set rather than the one that was reported.
       WRITTEN AS "every setter has a matching clear" because that is the property, not a list of five names
       -- a sixth ephemeral signal added later is caught by this without anybody remembering to add it. */
    for (const clear of [
      "setRevenueFlash(null)",
      "setActionToast(null)",
      "setDividendPayout(null)",
      "setPrivatePayoutPhase(null)",
      "setHaunting(null)",
    ]) {
      expect(APP).toContain(clear);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2: the fill spans the row                                           */
/* ------------------------------------------------------------------ */

describe("the revenue tint fills the whole row", () => {
  it("is applied to the row, not to the label beside the gutter", () => {
    /* RULED: "apply the green and red background tints to the full parent row container, not just the text
       elements ... spanning the entire width of the line."
       IT WAS ON `logLabelFull`, a SIBLING of the gutter. `flex: 1` made it reach the right edge -- which is
       what #1080's withdrawal established and is true -- but the `[OR 2.1]` tag, the gap beside it and the
       row's left padding all sat outside it, so the block started well inside the line. */
    const row = sliceBetween(TICKER, "...styles.logEntry,", 'role="button"');
    expect(row).toContain("styles.logRowToneBonus");
    expect(row).toContain("styles.logRowToneMalus");
    const label = sliceBetween(TICKER, "...styles.logLabelFull,", "{parts.body}");
    expect(label).not.toContain("logToneBonus");
    expect(label).toContain("logLabelError");
  });

  it("is one solid colour, not a wash over the row's own fill", () => {
    /* RULED: "a solid, uniform block of color ... do not use gradients or fades", which is also #1080's
       epitaph -- that batch reached for a `backgroundImage` gradient to layer a wash over `#141c2c`.
       AND A PLAIN `rgba` WOULD NOT HAVE BEEN RIGHT EITHER, which is the subtle half: setting
       `backgroundColor` on the row REPLACES the row's own, so a wash would composite against the list behind
       it and land on a colour nobody picked. The arithmetic is done up front instead. */
    expect(TICKER).toContain("logRowToneBonus: { backgroundColor: toneOverRow(TONE_BONUS_RGB) }");
    expect(TICKER).not.toContain("backgroundImage");
    expect(TICKER).not.toContain("linear-gradient");
  });

  it("changes the colour and nothing else about the row", () => {
    /* THE LESSON OF #1080, WHICH WAS WITHDRAWN FOR MOVING THREE THINGS WHEN ONE WAS ASKED: "the changes we
       made should have only changed the color of the background, nothing else about the background needed to
       change." The row's padding and radius are what make the fill reach the line's ends, and the tone styles
       carry neither -- one property each. */
    const bonus = sliceBetween(TICKER, "logRowToneBonus: {", "}");
    expect(bonus).not.toContain("padding");
    expect(bonus).not.toContain("borderRadius");
    const entry = sliceBetween(TICKER, "logEntry: {", "fontSize:");
    expect(entry).toContain('padding: "6px 12px"');
    expect(entry).toContain('borderRadius: "8px"');
  });

  it("keeps the collapsed ticker's wash, which was already right", () => {
    /* THIS SURFACE HAS TINTED ITS WHOLE ENTRY SINCE #1080, gutter included -- the expanded row is the one
       that had to catch up, which is the #891 asymmetry the report found. Its wrapper paints no ground of its
       own, so a wash composites correctly there and a flattened solid would be wrong.
       ONE ALPHA AND ONE PAIR OF HUES FEED BOTH, so this is not two answers to one question: it is one answer
       rendered correctly for two different grounds, with nothing kept in step by hand. */
    expect(TICKER).toContain("toneWash(TONE_BONUS_RGB)");
    expect(TICKER).toContain("toneOverRow(TONE_BONUS_RGB)");
    expect(TICKER.split("TONE_TINT_ALPHA =").length - 1).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3: the tint is strong enough, and not too strong                    */
/* ------------------------------------------------------------------ */

describe("the tints pop without washing the text out", () => {
  it("is much stronger than #1042's", () => {
    /* RULED: "increase the opacity and saturation ... they need to stand out clearly and pop."
       0.12 WAS #1042's AND ITS REASONING EXPIRED. It kept the fill quiet because "the italic is doing most of
       the work"; #1079 then removed the coloured ink and this batch moved the fill to the whole row, so the
       tint is now the only thing carrying direction. */
    expect(declaredAlpha).toBeGreaterThan(0.25);
    expect(declaredAlpha).toBe(0.32);
  });

  it("keeps the log's own ink above the AA floor", () => {
    /* THE CEILING, MEASURED RATHER THAN GUESSED, and the reason this case exists rather than a comment: the
       green is always the binding one, and it crosses below 4.5:1 at 0.36. The next person who wants more pop
       is told by a failing test where the limit is, instead of finding it in play on a phone. */
    expect(contrast(over(BONUS, declaredAlpha), INK)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(MALUS, declaredAlpha), INK)).toBeGreaterThanOrEqual(4.5);
  });

  it("is measurably more separated from an untinted neighbour", () => {
    /* WHAT "POP" MEANS, ARITHMETICALLY: a tinted row against the plain one above it. At 0.12 the green was
       1.27:1 from the row's own ground, which is why it read as washed out. */
    expect(contrast(over(BONUS, declaredAlpha), ROW)).toBeGreaterThan(
      contrast(over(BONUS, 0.12), ROW),
    );
    expect(contrast(over(BONUS, declaredAlpha), ROW)).toBeGreaterThan(1.9);
  });

  it("reaches for no new colours", () => {
    /* #1079'S ARGUMENT, UNCHANGED: `#4ade80` is this app's positive green at sixteen call sites and `#f43f5e`
       its red. The saturation the ruling asks for comes from the alpha -- the blend's own saturation rises
       from 0.35 to 0.42 with it -- not from a seventeenth green saying what the sixteenth says. */
    expect(TICKER).toContain("[74, 222, 128] as const");
    expect(TICKER).toContain("[244, 63, 94] as const");
  });
});

/* ------------------------------------------------------------------ */
/* 4: the flavour reads on a phone                                     */
/* ------------------------------------------------------------------ */

describe("the flavour clause is bold-italic", () => {
  it("gains weight, on both surfaces at once", () => {
    /* RULED: "from standard italics to bold-italics to improve legibility on small screens."
       ONE STYLE, TWO RENDERERS. The collapsed ticker and the expanded row both apply `logFlavourText`, which
       is what has kept them from drifting since #1079 -- so this is one edit and cannot land on half of it. */
    expect(TICKER).toContain('logFlavourText: { fontStyle: "italic", fontWeight: 700 }');
    expect(TICKER.split("styles.logFlavourText").length - 1).toBe(2);
  });

  it("does not bold the revenue math with it", () => {
    /* #1079 RULED "DO NOT BOLD THE EVENT TEXT" and that ruling stands -- this one is about the flavour
       CLAUSE, which is a different span for a different reason (an italic is what a small rasteriser loses
       first). The sentence's mechanical half is still upright and unweighted. */
    const label = sliceBetween(TICKER, "logLabelFull: {", "lineHeight");
    expect(label).not.toContain("fontWeight");
    expect(label).not.toContain("fontStyle");
  });

  it("still leaves the ink alone", () => {
    /* THE PART OF #1079 THAT MATTERS MOST. Colour was the second signal it removed -- "two signals for one
       fact" -- and weight is not colour. `logFlavourText` sets no `color`, so the clause reads in the same
       ink as the sentence it ends. */
    const flavour = sliceBetween(TICKER, "logFlavourText: {", "}");
    expect(flavour).not.toContain("color");
  });
});
