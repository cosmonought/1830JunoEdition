// frontend/src/utils/mockFixtures.ts
//
// PLACEHOLDER DATA still standing in for chain queries, moved out of
// `App.tsx` unchanged.
//
// Collected under a filename that says what they are. Every constant here is
// a promise to delete something later, and while they sat interleaved with
// real game constants in `App.tsx`'s preamble that promise was invisible -- a
// reader could not tell `MOCK_TRAIN_CATALOG` (a stand-in) from
// `SMALLEST_TRAIN_CAPACITY` (a rule) without reading both comments. Grouping
// them makes the remaining surface area countable: whatever is in this file
// is what the frontend still fakes.
//
// The tombstone comments came too. A note recording that
// `MOCK_DECLARE_DIVIDENDS_REVENUE` was DELETED, and why, is worth more here
// -- among the surviving placeholders -- than it was in a file that no longer
// has anything to do with them.

import type { MapGridResponse } from "../components/HexGridRenderer";
import type { MarketGridResponse } from "../components/StockMarketRenderer";

/* ------------------------------------------------------------------ */
/* Placeholder room state -- see design note #1                       */
/* ------------------------------------------------------------------ */

/** Room id for the two MOCK DISPLAY GRIDS below, and nothing else.
 *
 *  Design note #1's `MOCK_GAME_ID` is GONE -- `AppShell` now receives a real
 *  `gameId` prop from `GameRouter`, sourced from the contract's own
 *  `CreateGameRoom` response (see `Lobby.tsx` design note #2). This constant
 *  survives only because `MOCK_MAP_GRID`/`MOCK_MARKET_GRID` are module-scope
 *  literals that have to put SOMETHING in their `game_id` field, and design
 *  note #2 above is explicit that those two are illustrative data never
 *  produced by a live query. It is deliberately NOT the room anything talks
 *  to. */
export const MOCK_GRID_GAME_ID = 1;
export const MOCK_BUY_STOCK_PAR_VALUE = "100"; // top of the standard 1830 par ladder

/* `MOCK_DECLARE_DIVIDENDS_REVENUE` is GONE -- design note #198.
   It was `"0"`, dispatched on every dividend declaration regardless of what
   the corporation had just earned, while the panel beside the buttons showed
   the real figure. Deleted rather than left unused so nothing can quietly
   start sending a constant again; `handleDeclareDividendsChoice` reads
   `last_route_revenue` from the corporation being acted for. */

// Same placeholder rationale as design note #1/#4 above: there's no
// company-selector UI yet, so the Interactive Tile-Selection Popup's
// GetLegalTilePlacements/LayTile calls -- and now the Operating-Round-scoped
// mock action bar buttons too -- need SOME protocol_id to target. B&O
// (protocol_id 4) is used here specifically because it's the simplest
// "always floatable" company in the Rust test suite (src/tests.rs), not
// because of any in-game significance -- swap for real company-selection
// state once that flow exists, same as MOCK_BUY_STOCK_PROTOCOL_ID.
export const MOCK_LAY_TILE_PROTOCOL_ID = 4; // B&O, per public_company::CORE_PUBLIC_COMPANIES

/** Hand-kept mirror of `hardware::TRAIN_CATALOG` (`(model_type, baseline
 *  cost in, max route distance, bank quantity)`) -- same convention as
 *  `HexGridRenderer.tsx`'s `TILE_CATALOG` mirror. Purely a DISPLAY source
 *  for the Operating Round Phase 4 "active engines" marketplace tray (item
 *  2/Phase 4 below): `BuyHardwareFromPool` itself takes no model-selection
 *  parameter yet (see `hardware.rs`'s own module doc comment #2, "No model
 *  selection" -- it auto-picks from the pool), so selecting a tile here
 *  only drives which model is highlighted/labeled in the tray, not which
 *  model actually gets purchased. Keep this in exact sync with the Rust
 *  array if it ever changes. */
export const MOCK_TRAIN_CATALOG: ReadonlyArray<{
  modelType: string;
  costVgp: number;
  maxDistance: number;
  bankQuantity: number;
}> = [
  { modelType: "2", costVgp: 80, maxDistance: 2, bankQuantity: 6 },
  { modelType: "3", costVgp: 180, maxDistance: 3, bankQuantity: 5 },
  { modelType: "4", costVgp: 300, maxDistance: 4, bankQuantity: 4 },
  { modelType: "5", costVgp: 450, maxDistance: 5, bankQuantity: 3 },
  { modelType: "6", costVgp: 630, maxDistance: 6, bankQuantity: 2 },
  { modelType: "D", costVgp: 1_100, maxDistance: 999, bankQuantity: 20 },
];

/* ------------------------------------------------------------------ */
/* Mock map preview data -- see design note #2                        */
/* ------------------------------------------------------------------ */

// design note #15: the three landmark entries this array used to carry
// (New York/Boston/Baltimore, each pre-seeded with `tile_id: 10`) are
// REMOVED -- see that note for the full bug this caused and why an empty
// `tiles: []` is actually the MORE accurate mock of a freshly-created real
// game, not less.
export const MOCK_MAP_GRID: MapGridResponse = {
  game_id: MOCK_GRID_GAME_ID,
  tiles: [],
};

/* ------------------------------------------------------------------ */
/* Mock stock market preview data -- same rationale as MOCK_MAP_GRID    */
/* above: illustrative only, never actually produced by a live         */
/* `GetMarketGrid` query. PRR/NYC/ERIE deliberately share the same      */
/* ($100 par) cell so StockMarketRenderer's token-stacking behavior is  */
/* visible without needing three real players to actually park there.  */
/* Positions use the real board's own par column (x=6) -- see          */
/* StockMarketRenderer.tsx design note #4 -- not the old x=0..5, y=0    */
/* placeholder row a previous pass used here.                          */
/* ------------------------------------------------------------------ */

export const MOCK_MARKET_GRID: MarketGridResponse = {
  game_id: MOCK_GRID_GAME_ID,
  positions: [
    { company_id: 1, ticker: "PRR", x: 6, y: 10, price: "100" },
    { company_id: 2, ticker: "NYC", x: 6, y: 10, price: "100" },
    { company_id: 6, ticker: "ERIE", x: 6, y: 10, price: "100" },
    { company_id: 4, ticker: "B&O", x: 8, y: 4, price: "70" },
  ],
};
