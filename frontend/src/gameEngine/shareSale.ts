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
import { doubleSaleRefusal, needsDoubleForPresidencyExchange } from "./doubleCertificate";
import { presidentAfterSale } from "./presidencyTransfer";

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
  /* Design note #1324: a sale that reaches the seller's 20% certificate must be able to move it -- as a block,
     or as the half-sale when the pool has a 10% card to exchange. */
  const doubleRefusal = doubleSaleRefusal(company, seller, percentage);
  if (doubleRefusal !== null) return doubleRefusal;
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

    /* ==================================================================
        DESIGN NOTE 1624 (Slice 8.3, S9-14): THE CARD YOU DO NOT HOLD YET
       ==================================================================
       RULED (owner, 2026-09-17, absorbing S9-14 into Slice 8.3): "V-7.2 requires the 10% exchange certificate
       to have been in the Bank Pool before a half-sale of the other-20. A president who must first receive
       that other-20 during a presidency transfer is subject to the same requirement. The current sale cannot
       supply its own prerequisite."

       THE PRINTED SEQUENCE PUTS THE EXCHANGE BEFORE THE SALE. §5.4 settles the presidency the moment the
       announced sale would cause it -- so a president whose sale hands the crown to a holder of the
       Scenario-D other-20 who has no two ordinary 10%s (#1622) receives that card FIRST, and then completes
       the announced sale out of it. Selling only 10% of a 20% card is V-7.2's half-sale, legal only when the
       Bank Pool ALREADY holds a 10% certificate to exchange against.

       AND THE ENGINE COULD NOT SEE IT, because it asked the right question of the wrong board. `doubleSaleRefusal`
       above judges the seller's CURRENT cards (#1324), and at that moment the other-20 is still the
       successor's -- so the gate found nothing to refuse, the arm moved the percentages, and the 10% the sale
       itself put in the pool looked like the prerequisite. A sale may not supply its own precondition.

       SO THE SAME AUTHORITY IS ASKED OF THE BOARD THE EXCHANGE WILL LEAVE: the seller holding the other-20
       and no longer the president, on the PRE-SALE pools. `doubleSaleRefusal` then answers all three shapes
       for free and no arithmetic is restated here -- the sale that never reaches the card (the seller keeps
       it), the block sale of the whole card (no prerequisite, rulebook-legal, and the pool cap above already
       judged it), and the half-sale that needs the pool's 10%.

       NOT ON THE BUY SIDE. A challenger who BUYS to exceed the president performs no sale and no half-sale;
       this is a `SellStock` condition and it lives in the sale gate, which the reducer, the ingress
       (`stockSaleRefusal`), the chart step's `saleRefused` and the panel all already ask -- one implementation,
       and a refusal therefore lands before the chart moves (S8-13's rule). */
    const successor = presidentAfterSale(company, seller, percentage, state.player_addresses ?? []);
    if (successor !== null && successor !== seller && needsDoubleForPresidencyExchange(company, successor)) {
      const returned = { ...company, president: successor, double_certificate: { at: seller } };
      if (doubleSaleRefusal(returned, seller, percentage) !== null) {
        /* #619: the reason names the fact that would change it -- a 10% certificate in the pool, or selling
           the whole 20%. Both are things the player can act on. */
        return (
          `Selling ${percentage}% would hand the presidency to a player whose only ${PRESIDENT_BLOCK_PERCENT}% is the ` +
          `${PRESIDENT_BLOCK_PERCENT}% certificate, so you would take that certificate in exchange for your President's ` +
          `Certificate and be selling ${percentage}% of it — which needs a ${SHARE_BLOCK_PERCENT}% share already in the ` +
          `Bank Pool to exchange it for, and there is none. Sell the whole ${PRESIDENT_BLOCK_PERCENT}% instead.`
        );
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
