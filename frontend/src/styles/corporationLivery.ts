// frontend/src/styles/corporationLivery.ts
//
// ==================================================================
//  DESIGN NOTE 428: ONE PALETTE, IMPORTED THREE TIMES
// ==================================================================
//
// The eight canonical corporation colours, and the contrast maths that
// decides what ink goes on top of them. Single source of truth.
//
// WHAT THIS REPLACES. The table lived in three files at once:
//
//   `components/hexContractTypes.ts`      -- `STATION_TICKER_COLORS`
//   `components/StockMarketRenderer.tsx`  -- `TICKER_COLORS` (module-local)
//   `components/StockRoundPanel.tsx`      -- `TICKER_COLORS` (module-local)
//
// The duplication was deliberate and documented rather than accidental,
// which is what made it worth removing carefully rather than quickly.
// Design note #408 ends: "ALL THREE MIRRORS ARE UPDATED TOGETHER ... so
// changing one would give the map and the cards different opinions about
// who a corporation is." `StockRoundPanel`'s copy was headed "hand-kept
// duplicate of StockMarketRenderer.tsx's module-local (unexported)
// `TICKER_COLORS`".
//
// That is a correctness requirement enforced by a comment, and the failure
// it guards against is silent: a pass that recoloured two of the three
// would leave the map and the stock cards disagreeing, with no type error
// and nothing visibly wrong on whichever screen the author was looking at.
//
// ==================================================================
//  THE ARGUMENT AGAINST THE DUPLICATION WAS ALREADY IN THIS FOLDER
// ==================================================================
//
// `palette.ts`, one file over, opens by rejecting exactly this pattern for
// exactly these reasons:
//
//     The fix is not "pick a better hex twice". It is to have ONE value
//     that both files import, so a future pass physically cannot restyle
//     one set without the other. Uniformity is now structural rather than
//     a coincidence that survives until the next edit.
//
// And `StockRoundPanel`'s design note #389 already CLAIMED this was the
// arrangement -- "`tickerColor` is the same lookup those surfaces use, so
// the stripe cannot drift from the token ... one table, not a second
// palette that looks close." It was the intent all along; the livery stripe
// simply read the panel's own private copy rather than the map's.
//
// ==================================================================
//  WHY `styles/` AND NOT `components/`
// ==================================================================
//
// Three consumers, in two different folders (`components/` and `panels/`),
// plus `utils/` code that reasons about contrast. Leaving the canonical
// table inside `hexContractTypes.ts` would keep every other consumer
// importing a corporation's identity out of the HEX MAP's contract-shape
// module, which is the dependency direction `appStyles.ts` records its own
// hoist for: shared infrastructure living inside one of its consumers
// forces the others to depend on that consumer.
//
// `styles/` already holds the app's other cross-cutting colour tokens
// (`palette.ts`) and imports nothing from `components/`, so nothing here
// can create a cycle.
//
// ==================================================================
//  THE CONTRAST HELPERS COME TOO, AND THAT IS NOT SCOPE CREEP
// ==================================================================
//
// `relativeLuminance` and `bestContrastTextColor` are generic colour maths
// that lived in `hexContractTypes.ts` only by accident of history -- the
// map's station tokens were the first surface that needed to put an
// acronym on an arbitrary corporate fill. They are now called by the stock
// cards' livery stripe, the action bar, the home-station prompt and the
// map, and every one of those calls is about THIS palette.
//
// A colour table whose contrast function lives in a different module is a
// table that can be recoloured without its legibility guarantee being
// re-checked, which is the specific thing design note #408 audited by hand.
// Keeping them together is what makes that audit repeatable.
//
// BOTH ARE RE-EXPORTED FROM `hexContractTypes.ts`, so this is a pure
// addition for the eight-plus existing call sites -- see the re-export
// block there.

/* ==================================================================
 *  DESIGN NOTE 408 (moved here intact): THE COLOURS THE BOARD USES
 * ==================================================================
 *
 * REPORTED: the corporate colours do not match the physical board game,
 * which is jarring for experienced players.
 *
 * This palette was never canonical -- it was eight plausible, well-spaced
 * hues, and every previous pass tuned it for legibility and separation
 * without asking what colour the pieces actually are. For a player who
 * knows 1830, that is worse than an arbitrary palette: the Erie is yellow
 * on the board and reaching for the yellow token to find it is the B&O
 * costs more than having no expectation at all.
 *
 * So the hues are the specified ones, and the two properties earlier passes
 * cared about were re-checked rather than assumed against them:
 *
 *   CONTRAST. Every entry clears 4.5:1 against whichever of black or white
 *   `bestContrastTextColor` returns -- the WCAG threshold for normal text,
 *   which is the right bar because the stripe's ticker is 16px bold and
 *   16px bold is NOT "large text" by WCAG (that starts at 18.66px bold).
 *   The lowest is B&M green at 5.35:1; the shade of each hue was chosen to
 *   clear the bar rather than the bar being lowered to fit a shade.
 *
 *   SEPARATION. Minimum pairwise dE across all 28 combinations is 44.4
 *   (ERIE yellow against NNH orange), against the 8.4 that started design
 *   note #403. Canonical and distinguishable turned out not to be in
 *   tension -- the physical game already had to solve this problem with ink
 *   on cardboard.
 *
 *   THE CONTRAST INK FLIPS WHERE IT SHOULD. C&O's cyan, ERIE's yellow and
 *   NNH's orange are light enough to take BLACK text; the other five take
 *   white. That is the helper doing its job on new inputs, and it is
 *   asserted per colour rather than trusted.
 *
 * NYC IS `#1a1a1a`, NOT `#000000`. The requirement allows "a very dark
 * gray to ensure UI legibility" and this takes it: pure black would be
 * indistinguishable from the card borders and the chart's own gridlines,
 * and a corporation whose livery is the same colour as the furniture reads
 * as a rendering failure rather than as the New York Central.
 *
 * THE "ALL THREE MIRRORS" PARAGRAPH IS GONE, because there are no longer
 * three mirrors. That instruction was the maintenance burden this module
 * removes; leaving it would tell a future reader to go and find two copies
 * that do not exist.
 *
 * Keyed by `public_company::CORE_PUBLIC_COMPANIES`'s fixed `company_id`s
 * (1-8: PRR/NYC/CPR/B&O/C&O/ERIE/NNH/B&M). Purely a frontend legibility
 * aid, not backend data. */
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

/** One corporation's livery colour, or the fallback slate.
 *
 *  THE ONLY WAY TO READ THE TABLE. Exported alongside the record so callers
 *  do not each re-implement the `?? fallback` -- three of them previously
 *  did, as three module-local `tickerColor` functions. */
export function corporationLiveryColor(companyId: number): string {
  return CORPORATION_LIVERY_COLORS[companyId] ?? CORPORATION_LIVERY_FALLBACK;
}

/* ------------------------------------------------------------------ */
/* Contrast                                                            */
/* ------------------------------------------------------------------ */

/** Crisp Token Typography (design note #46): WCAG relative luminance of a
 *  `#rrggbb` hex colour -- the standard sRGB-to-linear formula, used below
 *  to pick whichever of pure white/pure black actually contrasts better
 *  against a given badge fill, rather than assuming one fixed choice works
 *  for every corporate colour. */
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

/** Crisp Token Typography (design note #46): returns whichever of pure
 *  white (`#FFFFFF`) or pure black (`#000000`) has the higher WCAG contrast
 *  ratio against `backgroundHex`, per the standard
 *  `(lighter + 0.05) / (darker + 0.05)` formula.
 *
 *  Picked dynamically per badge rather than one colour asserted for every
 *  corporate fill: three of the eight above are light enough to need black
 *  and five need white, so any fixed choice is wrong for at least three of
 *  them. This always returns the better of the two options, which is the
 *  closest a flat single-colour badge fill can get without changing the
 *  palette itself.
 *
 *  The out-of-scope caveat the old copy carried -- that several colours did
 *  not reach 7:1 AAA against either pure colour -- was written against the
 *  PRE-#408 palette and is no longer the live situation. #408 re-checked
 *  every entry against the 4.5:1 AA threshold for normal text and records
 *  the lowest at 5.35:1. AAA is still not claimed. */
export function bestContrastTextColor(backgroundHex: string): string {
  const bgLuminance = relativeLuminance(backgroundHex);
  const contrastWithWhite = 1.05 / (bgLuminance + 0.05);
  const contrastWithBlack = (bgLuminance + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? "#FFFFFF" : "#000000";
}
