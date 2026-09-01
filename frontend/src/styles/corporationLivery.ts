// Design note #428: the eight canonical corporation colours and the contrast
// maths that decides what ink goes on top of them. Single source of truth.
//
// The table lived in three files at once -- `hexContractTypes.ts`,
// `StockMarketRenderer.tsx` and `StockRoundPanel.tsx` -- as a correctness
// requirement enforced by a comment ("ALL THREE MIRRORS ARE UPDATED TOGETHER").
// The failure it guarded against is silent: recolour two of the three and the
// map and the stock cards disagree, with no type error.
//
// In `styles/` rather than `components/` because three consumers sit in two
// folders, and leaving it in `hexContractTypes.ts` would make every one of them
// import a corporation's identity out of the HEX MAP's contract-shape module.
// `styles/` imports nothing from `components/`, so no cycle is possible.
//
// The contrast helpers come too: a colour table whose contrast function lives
// elsewhere can be recoloured without its legibility guarantee being re-checked.
// Both are re-exported from `hexContractTypes.ts`, so this is a pure addition.
//
// See docs/ai_architecture/ui_shell_layout.md, corporationLivery.ts #428.

/* Design note #408: the hues are the physical board's, not eight plausible
   well-spaced ones. For a player who knows 1830, an arbitrary palette is worse
   than none -- the Erie is yellow on the board.

   Both properties earlier passes cared about were re-checked, not assumed:
   CONTRAST, every entry clears 4.5:1 against whichever of black/white
   `bestContrastTextColor` returns (the AA bar for NORMAL text, correct because
   16px bold is not "large" by WCAG), lowest B&M green at 5.35:1; SEPARATION,
   minimum pairwise dE across all 28 combinations is 44.4 (ERIE vs. NNH), against
   the 8.4 that started #403. The ink flips to black for C&O, ERIE and NNH.

   NYC is `#1a1a1a`, not `#000000` -- pure black is indistinguishable from the
   card borders and the chart's gridlines. The "all three mirrors" instruction is
   gone, because there are no longer three mirrors.

   Keyed by `public_company::CORE_PUBLIC_COMPANIES`'s fixed `company_id`s (1-8).
   Purely a frontend legibility aid, not backend data. */
export const CORPORATION_LIVERY_COLORS: Readonly<Record<number, string>> = {
  1: "#c8102e", // PRR  -- red
  2: "#1a1a1a", // NYC  -- black
  3: "#7b4a22", // CPR  -- brown
  4: "#12408f", // B&O  -- dark blue
  5: "#5bc8e8", // C&O  -- light blue / cyan
  6: "#f5cd3a", // ERIE -- yellow
  7: "#ee7c22", // NNH  -- orange
  8: "#1e7a45", // B&M  -- green
};

/** For a `company_id` outside the core eight -- a slate that is visibly not
 *  a livery, so an unknown corporation reads as unknown rather than as one
 *  of the eight rendered wrong. */
export const CORPORATION_LIVERY_FALLBACK = "#5a6270";

/** One corporation's livery colour, or the fallback slate. THE ONLY WAY TO READ
 *  THE TABLE, exported alongside the record so callers do not each re-implement
 *  the `?? fallback` -- three of them previously did. */
export function corporationLiveryColor(companyId: number): string {
  return CORPORATION_LIVERY_COLORS[companyId] ?? CORPORATION_LIVERY_FALLBACK;
}

/* ------------------------------------------------------------------ */
/* Contrast                                                            */
/* ------------------------------------------------------------------ */

/** Crisp Token Typography (design note #46): WCAG relative luminance of a
 *  `#rrggbb` colour, the standard sRGB-to-linear formula, used below to pick
 *  whichever of pure white/black actually contrasts better against a badge fill. */
export function relativeLuminance(hex: string): number {
  const toLinear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLinear(parseInt(hex.slice(1, 3), 16));
  const g = toLinear(parseInt(hex.slice(3, 5), 16));
  const b = toLinear(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Crisp Token Typography (design note #46): whichever of `#FFFFFF` or `#000000`
 *  has the higher WCAG contrast ratio against `backgroundHex`.
 *
 *  Picked per badge rather than one colour asserted for every fill: three of the
 *  eight need black and five need white, so any fixed choice is wrong for at
 *  least three. The old caveat about AAA was written against the pre-#408
 *  palette; #408 records the lowest AA ratio at 5.35:1. AAA is still not claimed. */
export function bestContrastTextColor(backgroundHex: string): string {
  const bgLuminance = relativeLuminance(backgroundHex);
  const contrastWithWhite = 1.05 / (bgLuminance + 0.05);
  const contrastWithBlack = (bgLuminance + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? "#FFFFFF" : "#000000";
}

/* ==================================================================
 *  DESIGN NOTE 945: A LIVERY THAT IDENTIFIES WITHOUT COMPETING
 * ==================================================================
 *
 * REPORTED: "update the inactive corporation badges in the OR Action Bar. The acronym text for the inactive
 * corporations should be rendered in their respective corporate colors, but appropriately desaturated so they
 * don't compete with the active corporation's badge."
 *
 * WHICH PARTLY REVERSES #930, so the reversal is recorded rather than quietly performed. That note took the
 * livery OFF every inactive chip: "Every chip used to carry its corporation's colour on both border and ink,
 * which turned a sequence into eight unrelated objects and left no way to scan the row for a position."
 * BOTH THINGS ARE TRUE, AND THE FIX IS THE CHANNEL RATHER THAN THE COLOUR. #930's complaint was about BORDER
 * AND FILL -- eight differently-outlined boxes stop reading as one strip. Ink is a different channel: the
 * strip keeps its uniform border and background, so it still reads as one control, while the letters carry
 * identity. Only the acting chip is filled.
 *
 * MIXED TOWARD THE ROW'S OWN GREY, not merely faded. `opacity` was tried on this strip once already and #930
 * records why it failed -- it dimmed the border too. Blending toward `#8a90a0` keeps the inactive chips at the
 * neutral's brightness while letting the hue through, which is what "desaturated so they don't compete"
 * describes.
 *
 * INTEGER MATH, per the project's standing rule. Colour is not money and nothing here reaches the chain, but
 * a channel computed with floats would round differently between engines and this is trivially integer. */

/** The neutral these chips sit at today -- `orTurnOrderChipUpcoming`'s ink. Exported so the blend target and
 *  the unblended default cannot drift apart.
 *
 *  ==================================================================
 *   DESIGN NOTE 1092: THE ONE VALUE THE RE-THEME TOOK OUT OF THIS FILE
 *  ==================================================================
 *  THIS FILE IS OTHERWISE LOCKED. #1092 excluded `corporationLivery.ts` outright, because the eight hues are
 *  the physical board's and `bestContrastTextColor` returns literal white and black by contract. This
 *  constant is the exception, and the reason it is one is that it is NOT LIVERY: it is a chrome grey that
 *  happens to live here, and the doc comment above says so -- it is `orTurnOrderChipUpcoming`'s ink, exported
 *  so the two cannot drift. That chip moved to `#8a8a86` with the rest of the ladder; leaving this behind
 *  would have recreated the exact drift the export exists to prevent.
 *
 *  IT IS ALSO VISIBLE, which is what settled it rather than tidiness. At a 55% blend the residual cast is
 *  not diluted away: every corporation's inactive ink shifts by more than a just-noticeable difference
 *  (2.5 to 7.1 dE, NYC worst), so the strip really was the one place still reading blue-grey against
 *  neutral chrome.
 *
 *  WHAT IT COSTS, recorded because #1092's standing rule elsewhere was "do not spend contrast that is
 *  already thin": the worst inactive ink goes 2.72:1 to 2.58:1 against the chip fill. That is a real loss
 *  and it is accepted here for two reasons the other cases did not have -- the chips are DELIBERATELY
 *  recessive (the note above: "not enough to pull the eye off the one filled chip"), and pairwise separation
 *  between the eight actually IMPROVES, 13.9 to 14.5 dE, which is the property this blend exists to protect.
 *  Logged as TECH_DEBT TD-8 with the rest of the recessive family. */
export const TURN_ORDER_NEUTRAL_INK = "#8a8a86";

/** `hex` blended `percent` of the way toward `toward`, per channel, in integers.
 *
 *  `percent` IS HOW MUCH OF `toward` SURVIVES: 0 returns `hex` unchanged, 100 returns `toward`. Stated because
 *  a blend factor is ambiguous by nature and the two readings are indistinguishable at the midpoint -- which
 *  is exactly where a caller would test it. */
export function mixHex(hex: string, toward: string, percent: number): string {
  const parse = (value: string): [number, number, number] => {
    const clean = value.replace("#", "");
    const full =
      clean.length === 3
        ? clean
            .split("")
            .map((character) => character + character)
            .join("")
        : clean;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  };
  const from = parse(hex);
  const to = parse(toward);
  if (from.some(Number.isNaN) || to.some(Number.isNaN)) return hex;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const channel = (a: number, b: number) =>
    /* `+ 50` before the divide is the same round-half-up-in-integers trick #922 uses for money, for the same
       reason: the division is the only place a fraction could appear. */
    Math.floor((a * (100 - clamped) + b * clamped + 50) / 100);
  const hexed = from
    .map((value, index) => channel(value, to[index]).toString(16).padStart(2, "0"))
    .join("");
  return `#${hexed}`;
}

/** A corporation's colour as it should appear on an INACTIVE turn-order chip.
 *
 *  55% toward the neutral: enough hue to tell ERIE's yellow from PRR's green at a glance, not enough to pull
 *  the eye off the one filled chip. The figure is a judgement, which is why it is a named constant with this
 *  sentence beside it rather than a number inline at the call site. */
export const TURN_ORDER_DESATURATION_PERCENT = 55;

export function desaturatedLiveryInk(companyId: number): string {
  return mixHex(
    corporationLiveryColor(companyId),
    TURN_ORDER_NEUTRAL_INK,
    TURN_ORDER_DESATURATION_PERCENT,
  );
}
