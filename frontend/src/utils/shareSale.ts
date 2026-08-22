// frontend/src/utils/shareSale.ts
//
// What a sale raises, what it costs the share price, and when it is not allowed at all.
//
// Design note #713: THE SALE HAD ONE CONSEQUENCE ON SCREEN AND CAUSES TWO.
//
// REPORTED: "When Selling shares, we have the effect on the player's treasury listed, but we don't list the
// effect on the stock price. Remember that: i) sales happen before the stock price impact, and ii) sales drop
// (vertically) the stock price for each share sold."
//
// The Buy side has shown both halves of its consequence since #682 -- the treasury before and after, under the
// button that causes it. The Sell side got the treasury half and not the market half, which is the more
// interesting one: cash is a number a player can add up, and where the token lands afterwards is the reason
// they might not sell at all.
//
// THE ORDER IS THE RULE, and it is worth stating as arithmetic rather than as prose. A sale is settled at the
// price the token stands on NOW; the token then moves down one row per certificate sold. So three shares of a
// $100 corporation raise $300 and leave the price wherever three rows below $100 lands -- NOT $100 + $90 + $82
// summing the way down, which is the mistake the ordering exists to prevent.
//
// AND VERTICALLY, one row per 10% certificate. `projectShareSaleMove` already walks that (and records that
// DOWN is `y - 1` on this chart, because "the y axis is inverted relative to the screen, so `y + 1` walked up
// and a sale RAISED the price"). This module owns the COUNT it is walked with.
//
// TWO RULES GUARD THE SALE, and the report names both:
//
//   the bank pool may not exceed 50%      -- already enforced by `sellOptionState`
//   a president may not sell the block    -- NOT enforced anywhere, until now
//                                            unless another player already holds 20%
//
// THE SECOND WAS ENCODED AND UNUSED, which is the same shape as #712 one report earlier: `sellableHoldings`
// has computed the successor rule since #6 -- "some OTHER single player already holds enough to take the
// certificate. Per player, never a sum" -- and the Sell control never asked it. It checked that the player
// held enough shares and that the pool had room, and would happily sell a presidency into nobody's hands.
//
// See docs/ai_architecture/stock_market.md, shareSale.ts #713.

import {
  BANK_POOL_CAP_PERCENT,
  PRESIDENT_BLOCK_PERCENT,
  SHARE_BLOCK_PERCENT,
} from "./endgame";
import type { GameStateResponse } from "./gameState";

export interface ShareSaleInput {
  state: GameStateResponse;
  seller: string;
  companyId: number;
  /** The bundle being sold, in percent -- 10, 20, 30... */
  percentage: number;
}

/** Why this sale is illegal, or `null` if it is allowed.
 *
 *  A REASON RATHER THAN A BOOLEAN (#619), and each one names the fact that would change it: a president told
 *  "nobody can succeed you" knows to wait for a rival to reach 20%, where "you may not sell" teaches nothing. */
export function shareSaleBlock(input: ShareSaleInput): string | null {
  const { state, seller, companyId, percentage } = input;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return null;

  const held = company.player_holdings.find((entry) => entry.player === seller)?.percentage ?? 0;
  if (percentage > held) {
    return `You hold ${held}% — not enough for a ${percentage}% bundle.`;
  }

  /* ---- The bank pool's 50% ceiling ------------------------------------------------------------- */
  const poolRoom = Math.max(0, BANK_POOL_CAP_PERCENT - company.bank_pool_percentage);
  if (percentage > poolRoom) {
    return `The Bank Pool is at ${company.bank_pool_percentage}% and caps at ${BANK_POOL_CAP_PERCENT}% — only ${poolRoom}% more can be sold into it.`;
  }

  /* ---- The presidency ---------------------------------------------------------------------------
     A president keeps the 20% block unless a sale would leave them holding it anyway. Selling DOWN TO 20%
     is fine; selling INTO the block hands the certificate to somebody, so somebody must be able to take it.
     PER PLAYER, NEVER A SUM -- #6's rule. Two rivals at 10% each cannot jointly succeed a president; the
     certificate is one card and goes to one holder. */
  if (company.president === seller) {
    const after = held - percentage;
    if (after < PRESIDENT_BLOCK_PERCENT) {
      const successor = company.player_holdings.find(
        (entry) => entry.player !== seller && entry.percentage >= PRESIDENT_BLOCK_PERCENT,
      );
      if (!successor) {
        return `Selling ${percentage}% would leave you under the ${PRESIDENT_BLOCK_PERCENT}% President's Certificate, and no other player holds ${PRESIDENT_BLOCK_PERCENT}% to take it.`;
      }
    }
  }

  return null;
}

/** Certificates in a bundle -- one row of price drop each. */
export function certificatesIn(percentage: number): number {
  return Math.max(0, Math.floor(percentage / SHARE_BLOCK_PERCENT));
}

/** What the seller receives.
 *
 *  Design note #713, rule (i): AT THE PRICE THE TOKEN STANDS ON NOW. The sale settles first and the market
 *  moves after, so every certificate in one bundle fetches the same figure. Summing the ladder downward as
 *  the token falls would under-pay a multi-share sale, and is the specific error the ordering prevents. */
export function saleProceeds(pricePerShare: number, percentage: number): number {
  return pricePerShare * certificatesIn(percentage);
}
