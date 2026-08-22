// One player's position, as five figures and three lists.
//
// Design note #562: computed here rather than in the card, where it can be
// tested against a fixture instead of a screenshot. IT REUSES, IT DOES NOT
// REDERIVE -- `estimatePlayerNetWorth` and `sellableHoldings` are already the
// app's answers, and a card that recomputed either would be a second opinion
// (design notes #549, #553, #559: one fact, two places, one updated).
//
// Design note #562a: NET WORTH is what a player is WORTH -- cash plus every
// share at market price, counting the presidency, and it is the score. LIQUIDITY
// is what they could actually RAISE -- cash plus only the shares 1830 would let
// them sell, bounded by the successor rule and the pool's 50% cap. NOT
// "unfloated": a started-but-unfloated corporation sits at its par position and
// its shares sell perfectly well; the test is whether the corporation has been
// PARRED (design note #711), which is a step earlier than floating.
//
// The gap between the two is the interesting part -- $2,000 of net worth against
// $200 of liquidity is one bad train purchase from bankruptcy, and a single Net
// Worth column has never been able to say so. `null` PROPAGATES rather than
// degrading to zero.
//
// See docs/ai_architecture/stock_market.md, playerFinance.ts #562 / #562a.

import {
  certificateCount,
  estimatePlayerNetWorth,
  sharePriceFor,
  playerPrivateCompanies,
  type GameStateResponse,
} from "./gameState";
import { playerLiquidity, SHARE_BLOCK_PERCENT } from "./endgame";
import { PRIVATE_COMPANY_CATALOG } from "./privateCatalog";
import { certLimitForPlayers } from "./gameSetup";
import { corporationDisplayRank } from "./corporationNames";

/** One corporation this player holds a stake in. */
export interface PlayerHoldingRow {
  companyId: number;
  ticker: string;
  percentage: number;
  isPresident: boolean;
}

/** One private company this player owns. */
export interface PlayerPrivateRow {
  privateId: number;
  name: string;
  acronym: string | null;
  /** What it cost at auction, or its face value -- the figure the ledger
   *  counts toward a player's assets. */
  value: number;
  /** Per-Operating-Round revenue. */
  income: number;
}

export interface PlayerFinances {
  address: string;
  cash: number | null;
  /** Every share at market. `null` when it cannot be computed. */
  stockValue: number | null;
  /** Cash + `stockValue`. The score. */
  netWorth: number | null;
  /** Cash + only what 1830 would let them sell today. Design note #562a. */
  liquidity: number | null;
  certificates: number;
  /** The seat count's certificate ceiling, or `null` off the printed
   *  table -- a room that has not dealt yet has no limit to show. */
  certificateLimit: number | null;
  /** 10% blocks held across every corporation. A presidency counts as two,
   *  because it IS two shares -- it is one CERTIFICATE, which is the
   *  distinction the row above measures instead. */
  shares: number;
  holdings: PlayerHoldingRow[];
  privates: PlayerPrivateRow[];
}

export function playerFinances(
  address: string,
  state: GameStateResponse | null,
  marketPrices: Readonly<Record<number, number | null>>,
  settledPrivatePrices?: Readonly<Record<number, number>>,
): PlayerFinances | null {
  if (!state) return null;

  const cashEntry = state.player_cash.find((row) => row.player === address);
  const cashRaw = Number(cashEntry?.cash_vgp ?? NaN);
  const cash = Number.isFinite(cashRaw) ? cashRaw : null;

  /* Design note #566 kept a private `pricesWithPar` here -- "PAR IS A PRICE, NOT A GUESS" -- because
     `estimateStockPortfolioValue` refused to value a corporation whose token was not yet on the chart, and
     the card wanted a figure where the Ledger accepted a dash.
     Design note #711 RETIRED THAT SPLIT by moving the ladder into `sharePriceFor`: market, then par, then
     $0 for a corporation nobody has parred. So there is no longer a looser reading for this file to hold
     privately -- both surfaces read the same prices, and the only thing that ever differed was where the
     ladder stopped. */
  const worth = estimatePlayerNetWorth(address, state, marketPrices);

  const holdings: PlayerHoldingRow[] = [];
  let shares = 0;
  for (const company of state.public_companies) {
    const held = company.player_holdings
      .filter((entry) => entry.player === address)
      .reduce((sum, entry) => sum + entry.percentage, 0);
    if (held <= 0) continue;
    holdings.push({
      companyId: company.company_id,
      ticker: company.ticker,
      percentage: held,
      isPresident: company.president === address,
    });
    shares += held / SHARE_BLOCK_PERCENT;
  }

  /* Design note #582: a standing order, so a row is in the same place on
     every card and in the same place next round. Sorted here rather than in
     the component because it is a property of the DATA the card renders --
     and two cards sorting independently is how they would come to differ. */
  holdings.sort((a, b) => corporationDisplayRank(a.ticker) - corporationDisplayRank(b.ticker));

  /* Design note #562a: what could actually be raised. `sellableHoldings` owns the
     presidency and pool-cap rules, so this only adds up its answer -- and the two
     surfaces that ask "what can this player pay with" get the same number by
     construction rather than by agreement.
     Design note #710 moved the addition itself into `playerLiquidity`, next to those rules, once the Ledger
     needed the same figure at a different price policy. What is still THIS file's is `pricesWithPar` -- #566's
     par fallback, which is the card's reading and not the Ledger's. */
  const liquid = playerLiquidity(state, address, cash, (companyId) => {
    const company = state.public_companies.find((entry) => entry.company_id === companyId);
    return company ? sharePriceFor(company, marketPrices) : null;
  });

  const privates: PlayerPrivateRow[] = playerPrivateCompanies(address, state).map((entry) => ({
    privateId: entry.private_id,
    name: entry.name,
    acronym: PRIVATE_COMPANY_CATALOG[entry.private_id]?.acronym ?? null,
    /* What it actually SOLD for, when the auction recorded it -- design note
       #303. A private bought in a mini-auction went for more than face
       value, and quoting the printed cost would understate the holding by
       exactly the amount the contest cost. */
    value: settledPrivatePrices?.[entry.private_id] ?? (Number(entry.cost) || 0),
    income: Number(entry.revenue_per_or) || 0,
  }));

  return {
    address,
    cash,
    stockValue: worth?.stockValue ?? null,
    netWorth: worth?.netWorth ?? null,
    liquidity: liquid,
    certificates: certificateCount(address, state),
    certificateLimit: certLimitForPlayers(state.player_addresses.length),
    shares,
    holdings,
    privates,
  };
}
