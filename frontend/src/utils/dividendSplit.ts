// frontend/src/utils/dividendSplit.ts
//
// What a dividend declaration actually pays, computed once and read by everyone who describes it.
//
// ==================================================================
//  DESIGN NOTE 775: THE NARRATION RECOMPUTED INSTEAD OF REPORTING
// ==================================================================
//
// TWO REPORTS, ONE CAUSE.
//
//   (1) "the doubled Withhold logs report the incorrect second movement" -- alongside a log showing
//       `Market Move — C&O fell from $82 to $76 on the withheld dividend` and, twice,
//       `C&O withheld $0 into its treasury. Share price moved from $76 to $71.`
//   (2) "the toast notification for payouts is reporting a doubled amount (that isn't actually being paid,
//       only half, the correct amount)."
//
// THE MARKET MOVE LINE IS RIGHT AND THE SENTENCE IS WRONG, which is the correction that unlocked this. The
// token went $82 -> $76, one cell, correctly. The sentence claimed $76 -> $71 -- and $76 is where the token
// had JUST LANDED. So the sentence read the price AFTER the move and then projected the move AGAIN. It was
// not describing what happened; it was predicting a second step that never came.
//
// THE SAME SHAPE PRODUCES THE DOUBLED TOAST. The payout sentence re-derived the revenue and re-split it ten
// ways from its own copy of the corporation, rather than reporting the split the reducer performed. Two
// implementations of one calculation, run against two different snapshots, and only one of them moves money.
// The one that moves money was right, which is why the cash was correct and the notice was not.
//
// SO THE RULE: A NARRATION REPORTS, IT DOES NOT RECOMPUTE. `Market Move` was already built this way (#435) --
// it prints `applySandboxMarketAction`'s own `moved` result -- and it is the line that came out correct in
// every log. #750's treasury instrument and #768's grid instrument are the same principle: compare or report
// what the authority did, never ask a second implementation what it should have done.
//
// THIS MODULE IS THAT ONE IMPLEMENTATION. The reducer moves the money by calling it; the log line and the
// toast describe the money by calling it. They cannot disagree, because there is nothing left to disagree
// with -- and if a future snapshot mismatch makes them differ, they differ by naming a different state
// rather than by doing different arithmetic.

import type { GameStateResponse, PublicCompanyState } from "./gameState";

/** One shareholder's slice. */
export interface DividendShare {
  player: string;
  /** Whole VGP units. */
  amount: number;
}

/** Everything a dividend declaration does to the money, in one value. */
export interface DividendSplit {
  /** The figure being declared on. */
  revenue: number;
  /** Per 10% certificate, floored -- 1830 pays whole units. */
  perShare: number;
  /** Paid to each shareholder, in the corporation's own holdings order. */
  players: readonly DividendShare[];
  /** Design note #706: the Bank Pool's slice pays the CORPORATE TREASURY. Unsold IPO shares pay nobody. */
  poolSlice: number;
  /** What the bank actually funds -- players plus the pool slice, summed rather than reconstructed. */
  totalPaid: number;
  /** `false` for a withhold: the whole revenue goes to the treasury and no shareholder is paid. */
  distributed: boolean;
}

/** The declared revenue, by the rule #752 settled.
 *
 *  AN EXPLICIT `"0"` IS A FIGURE, NOT A MISSING ONE. A trainless corporation declares a forced $0 withhold,
 *  and reading `last_route_revenue` instead paid out $1000 for a run that never happened. ABSENT is still
 *  different from zero, because a message written before `revenue_amount` was carried has no figure at all.
 *
 *  AND A TRAINLESS CORPORATION HAS NO LAST RUN, so even a legitimately reached fallback pays nothing: its
 *  stored figure is a fact about an earlier Operating Round. */
export function dividendRevenue(
  company: Pick<PublicCompanyState, "last_route_revenue" | "owned_trains"> | undefined,
  revenueAmount: string | null | undefined,
): number {
  const stated =
    revenueAmount === undefined || revenueAmount === null || revenueAmount === ""
      ? NaN
      : Number(revenueAmount);
  if (Number.isFinite(stated)) return Math.max(0, stated);

  const ownsTrain = (company?.owned_trains?.length ?? 0) > 0;
  return ownsTrain ? Number(company?.last_route_revenue ?? 0) || 0 : 0;
}

/** The whole settlement for one declaration, or `null` when there is nothing to settle.
 *
 *  TAKES THE STATE THE ACTION APPLIES TO. Every caller must pass the BEFORE state -- the reducer has it by
 *  definition, and the shell has to hand it in deliberately. That is the discipline this module buys: the
 *  snapshot is now an argument that a caller can get wrong visibly, instead of a closure a caller could read
 *  without noticing which copy it got. */
export function dividendSplit(
  state: GameStateResponse | null | undefined,
  companyId: number,
  revenueAmount: string | null | undefined,
  distribute: boolean,
): DividendSplit | null {
  const company = state?.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return null;

  const revenue = dividendRevenue(company, revenueAmount);
  if (revenue <= 0) return null;

  if (!distribute) {
    /* A withhold is the whole figure into the treasury. Reported through the same type so a caller does not
       need a second shape for the other half of one decision. */
    return {
      revenue,
      perShare: 0,
      players: [],
      poolSlice: 0,
      totalPaid: revenue,
      distributed: false,
    };
  }

  // Floored: 1830 pays whole units, and rounding up would have the corporation pay out more than it earned.
  const perShare = Math.floor(revenue / 10);
  const players = company.player_holdings.map((holding) => ({
    player: holding.player,
    amount: perShare * (holding.percentage / 10),
  }));
  const poolSlice = perShare * (company.bank_pool_percentage / 10);
  const totalPaid = players.reduce((sum, share) => sum + share.amount, 0) + poolSlice;

  return { revenue, perShare, players, poolSlice, totalPaid, distributed: true };
}
