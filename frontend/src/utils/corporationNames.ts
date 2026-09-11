// The eight 1830 corporations' canonical full names, keyed by ticker.
//
// Design note #1: a frontend table, not a query. `PublicCompanyState` carries
// `ticker` and nothing else, and these names are FIXED -- 1830 ships the same
// eight railroads every game, so this is the correct place for a board constant
// rather than a stopgap. The alternative is four components disagreeing about
// whether the Erie is "Erie Railroad" or "Erie RR".
//
// Design note #2: ticker spelling is not consistent in this codebase
// (`sandboxState.ts` uses `NNH`/`ERIE`; the canonical labels are `NYNH`/`Erie`),
// so `corporationFullName()` upper-cases and resolves through an alias table.
// UNKNOWN TICKERS RETURN `null`, NOT THE TICKER BACK -- callers decide the
// fallback, and returning the ticker would make "PRR - PRR" the failure mode,
// which reads as data corruption rather than a missing name.
//
// See docs/ai_architecture/utils_layer.md, corporationNames.ts #1 / #2.

/** Ticker -> canonical full name. Keys are UPPERCASE; look up through
 *  `corporationFullName()` rather than indexing this directly. */
const CORPORATION_FULL_NAMES: Readonly<Record<string, string>> = {
  PRR: "Pennsylvania Railroad",
  NYC: "New York Central",
  "B&O": "Baltimore & Ohio",
  "C&O": "Chesapeake & Ohio",
  ERIE: "Erie Railroad",
  NYNH: "New York, New Haven & Hartford",
  "B&M": "Boston & Maine",
  CPR: "Canadian Pacific",
  // Design note #1320: the Level Playing Field's two.
  PMQ: "Pere Marquette",
  "N&W": "Norfolk & Western",
};

/** Spellings this codebase already uses that are not the canonical key.
 *  See design note #2 -- `sandboxState.ts` is the current source of both. */
const TICKER_ALIASES: Readonly<Record<string, string>> = {
  NNH: "NYNH",
  "NY&NH": "NYNH",
  PENN: "PRR",
};

/** The canonical full name for a ticker, or `null` if unrecognised.
 *  Case-insensitive, and resolves the aliases in `TICKER_ALIASES`. */
export function corporationFullName(ticker: string | null | undefined): string | null {
  if (!ticker) return null;
  const key = ticker.trim().toUpperCase();
  const canonical = TICKER_ALIASES[key] ?? key;
  return CORPORATION_FULL_NAMES[canonical] ?? null;
}

/** `"PRR - Pennsylvania Railroad"`, or just `"PRR"` when the ticker is not
 *  one of the eight. Use for tooltips and any single-line label that has
 *  room for both halves. */
export function corporationLabel(ticker: string | null | undefined): string {
  const full = corporationFullName(ticker);
  const shown = ticker ?? "";
  return full ? `${shown} - ${full}` : shown;
}

/** Convenience for `title=` props: the combined label, or `undefined` so
 *  React omits the attribute entirely rather than rendering an empty
 *  tooltip that flashes a blank box on hover. */
export function corporationTitle(ticker: string | null | undefined): string | undefined {
  return corporationFullName(ticker) ? corporationLabel(ticker) : undefined;
}


/* Design note #582: a standing order for the eight, so a player can memorise it
   and stop reading the labels. `public_companies` order is the order the state
   happens to hold, so two cards side by side could list the same corporations
   the other way round.

   ALPHABETICAL BY TICKER, over the two alternatives: NOT market price, which
   reorders the rows every time a token moves; NOT the board's own numbering,
   which no player can see. A printed table rather than a sort over live data. */
export const CORPORATION_DISPLAY_ORDER: readonly string[] = [
  "B&M",
  "B&O",
  "C&O",
  "CPR",
  "ERIE",
  "N&W",
  "NYC",
  "NYNH",
  "PMQ",
  "PRR",
];

/* ==================================================================
    DESIGN NOTE 1350: THE SPECTRUM ORDER, FOR THE CARDS NOBODY HAS BOUGHT
   ==================================================================
   RULED (10 September): the Stocks page's cards group floated -> parred -> unbought at the Operating Round
   boundary (#464's moment, kept), and the unbought sit in "ROYGBIV" order -- red to violet by livery, the
   two neutrals last -- so a player can learn where a card is from its colour. The same order opens the
   game, before any Operating Round has sorted anything. A PRINTED TABLE (#582's rule): the liveries have
   hues, but a sort over them would move the moment a livery is re-cut. Hue angles from `corporationLivery`
   at the time of writing: PRR 351, NNH 27, CPR 27 (the darker of the two oranges), ERIE 47, B&M 145, C&O
   193, B&O 218, PMQ 272; N&W (gray) and NYC (black) have none. */
export const CORPORATION_SPECTRUM_ORDER: readonly string[] = [
  "PRR",
  "NYNH",
  "CPR",
  "ERIE",
  "B&M",
  "C&O",
  "B&O",
  "PMQ",
  "N&W",
  "NYC",
];

export function corporationSpectrumRank(ticker: string): number {
  const upper = ticker.toUpperCase();
  const at = CORPORATION_SPECTRUM_ORDER.indexOf(TICKER_ALIASES[upper] ?? upper);
  return at === -1 ? CORPORATION_SPECTRUM_ORDER.length : at;
}

/** Sort position for a ticker, or a number past the end for one this table
 *  does not know -- an unrecognised corporation sorts last rather than
 *  first, so a typo cannot silently head the list. */
export function corporationDisplayRank(ticker: string): number {
  const at = CORPORATION_DISPLAY_ORDER.indexOf(ticker.toUpperCase());
  return at === -1 ? CORPORATION_DISPLAY_ORDER.length : at;
}
