// frontend/src/utils/playerFinance.ts
//
// ONE PLAYER'S POSITION, as five figures and three lists.
//
// ==================================================================
//  DESIGN NOTE 562: THE ARITHMETIC LIVES APART FROM THE CARD
// ==================================================================
//
// The Stock Round player cards need Cash, Net Worth, Liquidity, Certs and
// Shares, plus a per-corporation breakdown and a private-company table. All
// of that is derivable from `GameStateResponse` and the market, and none of
// it is a rendering concern -- so it is computed here, where it can be
// tested against a fixture instead of against a screenshot.
//
// IT REUSES, IT DOES NOT REDERIVE. `estimatePlayerNetWorth` and
// `sellableHoldings` already exist and are already the app's answers to two
// of these questions. A card that recomputed either would be a second
// opinion, and the two would eventually differ -- which is the failure this
// codebase keeps finding (design notes #549, #553, #559: one fact, two
// places, one updated).
//
// ==================================================================
//  DESIGN NOTE 562a: NET WORTH AND LIQUIDITY ARE DIFFERENT QUESTIONS
// ==================================================================
//
// They look like the same number and they answer opposite questions, so the
// card shows both:
//
//   NET WORTH  is what the player is WORTH -- cash plus every share at its
//              market price. It is the score. It counts the presidency,
//              because at the end of the game the presidency is worth its
//              market value like anything else.
//
//   LIQUIDITY  is what the player could actually RAISE right now -- cash
//              plus only the shares 1830 would let them sell. A president's
//              20% block cannot be sold unless some OTHER single player
//              already holds 20% and can take over; the bank pool's 50% cap
//              can refuse the rest; and a corporation with no position on
//              the chart has nowhere for its shares to be sold at all.
//
//              NOT "unfloated" -- that was the first wording here and it is
//              wrong about 1830. A started-but-unfloated corporation sits at
//              its par position and its shares sell perfectly well. The test
//              is whether the chart can price them.
//
// The gap between them is the interesting part: a player with $2,000 of net
// worth and $200 of liquidity is one bad train purchase from bankruptcy, and
// the ledger's single Net Worth column has never been able to say so.
//
// `null` PROPAGATES rather than degrading to zero, exactly as
// `estimatePlayerNetWorth` already does: no cash record is not the same as
// no cash, and a card that prints $0 for a missing figure is stating
// something false about a player's position.

import {
  certificateCount,
  estimatePlayerNetWorth,
  playerPrivateCompanies,
  type GameStateResponse,
} from "./gameState";
import { sellableHoldings, SHARE_BLOCK_PERCENT } from "./endgame";
import { PRIVATE_COMPANY_CATALOG } from "./privateCatalog";
import { certLimitForPlayers } from "./gameSetup";

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

  /* Design note #562a: what could actually be raised. `sellableHoldings`
     owns the presidency and pool-cap rules, so this only has to add up its
     answer -- and the two surfaces that ask "what can this player pay with"
     (the emergency-funding modal and this card) get the same number by
     construction rather than by agreement. */
  const liquid = cash === null
    ? null
    : sellableHoldings(state, address, (companyId) => marketPrices[companyId] ?? null).reduce(
        (sum, entry) => sum + entry.proceeds,
        cash,
      );

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
