// Shared fixtures for the W3-H evidence entries. Shapes follow stockCardFocus.test.tsx and
// corporationCardFloatFocus.test.tsx (the same `as unknown as PublicCompanyState` construction).
import type { PublicCompanyState } from "../../src/gameEngine/gameState";

export const TICKERS: Record<number, string> = { 1: "PRR", 2: "NYC", 3: "CPR", 4: "B&O", 5: "C&O", 6: "ERIE", 7: "NNH", 8: "B&M" };
export const ALICE = "juno1alice";
export const BOB = "juno1bob";
export const CAROL = "juno1carol";

export const holdingRows = (holdings: Record<string, number>) =>
  Object.keys(holdings)
    .filter((player) => holdings[player] > 0)
    .map((player) => ({ player, percentage: holdings[player] }));

export const corporation = (
  companyId: number,
  holdings: Record<string, number>,
  president: string | null,
  pools: { ipo: number; bank: number },
  floated = true,
): PublicCompanyState =>
  ({
    company_id: companyId,
    ticker: TICKERS[companyId],
    is_floated: floated,
    treasury: "500",
    total_shares_issued: 10,
    par_value: "90",
    president,
    ipo_pool_percentage: pools.ipo,
    bank_pool_percentage: pools.bank,
    player_holdings: holdingRows(holdings),
    home_hex_label: "H12",
    station_token_hexes: [],
    trains: [],
  }) as unknown as PublicCompanyState;

/** Eight floated corporations with varied ownership, so the roster grid is several rows tall. */
export const eightCorporations = (): PublicCompanyState[] =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((id) =>
    corporation(id, { [ALICE]: 40 + (id % 3) * 10, [BOB]: 10 * (id % 2) }, ALICE, { ipo: 40 - (id % 3) * 10 - 10 * (id % 2), bank: 20 }),
  );
