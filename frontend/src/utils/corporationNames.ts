// frontend/src/utils/corporationNames.ts
//
// The eight 1830 corporations' canonical full names, keyed by ticker.
//
// ===================================================================
//  DESIGN NOTE 1: WHY THIS IS A FRONTEND TABLE AND NOT A QUERY
// ===================================================================
//
// `PublicCompanyState` (see `utils/gameState.ts`) carries `ticker` and
// nothing else -- there is no `name` field on the contract response, and
// adding one is a Rust change. These names are also FIXED: 1830 ships the
// same eight railroads every game, so a static table is not a stopgap
// standing in for real data, it is the correct place for a board constant.
//
// The alternative -- writing "Pennsylvania Railroad" inline wherever a
// ticker is displayed -- is how four components end up disagreeing about
// whether the Erie is "Erie Railroad" or "Erie RR". One table, imported.
//
// ===================================================================
//  DESIGN NOTE 2: TICKER SPELLING IS NOT CONSISTENT, SO LOOKUP NORMALISES
// ===================================================================
//
// This codebase already spells the same two companies more than one way.
// `utils/sandboxState.ts` uses `NNH` and `ERIE`; the canonical labels are
// `NYNH` and `Erie`. Rather than rename mock data and hope every future
// caller matches the casing, `corporationFullName()` upper-cases its input
// and resolves through an alias table, so `Erie`, `ERIE` and `erie` all
// land on the same entry.
//
// UNKNOWN TICKERS RETURN `null`, NOT THE TICKER BACK. Callers decide what
// an unrecognised company should look like -- a tooltip wants to fall back
// to no tooltip, a table cell wants to fall back to a dash. Returning the
// ticker would make "PRR - PRR" the failure mode, which reads as data
// corruption rather than as a missing name.

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
