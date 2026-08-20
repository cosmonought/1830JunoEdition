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
