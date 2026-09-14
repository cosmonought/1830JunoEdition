// The President's Certificate changes hands.
//
// Design note #596: `BuyStock` moved percentages and set `president` only on the
// FOUNDING purchase, so after that the crown never moved however the holdings
// changed -- a corporation could be majority-owned by one player and presided
// over by another indefinitely, which in 1830 decides who lays its track, runs
// its trains and spends its treasury.
//
// Design note #596a: IT IS A SWAP, NOT A RELABEL. The presidency is a PHYSICAL
// CERTIFICATE worth 20% and there is exactly one, so a takeover exchanges it for
// two ordinary 10% certificates. Nobody's PERCENTAGE moves; what changes is how
// many CARDS each holds, because the certificate LIMIT counts cards. This file
// therefore changes no `percentage` at all -- `certificateCount`
// (`gameState.ts`) already derives the card count from `president`.
//
// Design note #596b: the presidency passes on STRICTLY MORE. An equal holding
// leaves it where it is, which stops the crown flickering between two players
// buying alternately to 30%. When several are tied above the president, 1830
// says "the one who most recently reached that level"; this module cannot see
// history, so it takes the first in seating order and says so rather than
// pretending the tie cannot arise -- it can, when a sale drops the president
// below two players at once.
//
// See docs/ai_architecture/stock_market.md, presidencyTransfer.ts #596.

import type { GameStateResponse, PublicCompanyState } from "./gameState";

/** 1830's president's certificate: one card, worth two ordinary shares. */
export const PRESIDENT_CERTIFICATE_PERCENT = 20;

export interface PresidencyChange {
  companyId: number;
  ticker: string;
  from: string | null;
  /** Never `null`. Design note #748b: a crown passes from one holder to another and is never vacated, so
   *  every change names a successor. This was briefly widened to `string | null` and put back. */
  to: string;
}

/** Who should preside over this corporation, given its holdings.
 *
 *  `null` when nobody qualifies, which for a PARRED corporation is unreachable: design note #748b, the
 *  President's Certificate is one card that only ever moves by exchange to a holder of 20% or more, so it
 *  cannot reach the Bank Pool and somebody always has it. The real case is a company nobody has started.
 *  This doc comment used to add "or one whose shares are all in the pool" -- that board cannot exist, and
 *  writing it down here is what led a caller to build a vacate-the-crown branch for it.
 *
 *  Returning the INCUMBENT when they still lead is deliberate: the caller compares against
 *  `company.president` and does nothing when they match. */
export function presidentFor(company: PublicCompanyState): string | null {
  const holdings = company.player_holdings.filter((entry) => entry.percentage > 0);
  if (holdings.length === 0) return null;

  /* A player must hold at least the president's block to preside at all --
     nobody can hold a 20% certificate on 10% of the company. */
  const eligible = holdings.filter(
    (entry) => entry.percentage >= PRESIDENT_CERTIFICATE_PERCENT,
  );
  if (eligible.length === 0) return null;

  const incumbent = company.president;
  const incumbentHolding =
    incumbent === null
      ? 0
      : (holdings.find((entry) => entry.player === incumbent)?.percentage ?? 0);

  /* Design note #596b: STRICTLY more. An equal holding leaves the crown
     where it is, which is what stops it flickering between two players who
     buy alternately to the same level. */
  const challengers = eligible.filter((entry) => entry.percentage > incumbentHolding);
  if (challengers.length === 0) {
    return incumbent !== null && incumbentHolding >= PRESIDENT_CERTIFICATE_PERCENT
      ? incumbent
      : (eligible.reduce((best, entry) =>
          entry.percentage > best.percentage ? entry : best,
        ).player ?? null);
  }

  const top = challengers.reduce((best, entry) =>
    entry.percentage > best.percentage ? entry : best,
  );
  /* Ties among challengers: seating order, and design note #596b records why
     that is a stand-in rather than the rule. `player_holdings` is in seating
     order, so `find` takes the earliest seat. */
  return (
    challengers.find((entry) => entry.percentage === top.percentage)?.player ?? top.player
  );
}

/** Settles the presidency of every corporation whose holdings have moved.
 *
 *  Returns the state unchanged when no crown moves, so a caller can use identity
 *  to decide whether anything happened -- and so this is safe to run after every
 *  holding change rather than only where a takeover is expected. */
export function settlePresidencies(state: GameStateResponse): {
  state: GameStateResponse;
  changes: PresidencyChange[];
} {
  const changes: PresidencyChange[] = [];

  const companies = state.public_companies.map((company) => {
    /* An unstarted company has no presidency to settle -- its certificate is
       still in the IPO, and `par_value` is what says so (design note #587). */
    if (company.par_value === null || company.par_value === undefined) return company;

    /* ==================================================================
     *  DESIGN NOTE 748b: A FLOATED CORPORATION ALWAYS HAS A PRESIDENT
     * ==================================================================
     *
     * THIS BRANCH ONCE VACATED THE CROWN, AND THAT WAS WRONG.
     *
     * REPORTED alongside #748: "P2 now shows to have 0 certificates and a 10% share" -- P2 still flagged
     * president of a corporation they held 10% of. I read that as a second defect and made `settlePresidencies`
     * set `president: null` whenever nobody held the 20% block, on the reasoning that `presidentFor` had
     * carefully distinguished "no change" from "no president" and its only caller had collapsed the two.
     *
     * REPORTED BACK: "this is still very wrong: a President's share can NEVER be sold to the Bank, so what's
     * wrong is that a crown/presidency can never be vacated. The player should never have been able to sell
     * below their 20% President's certificate, even though mathematically selling 40% kept the Bank Pool at
     * the limit of 50%."
     *
     * WHAT I ACTUALLY DID was make an illegal board REPRESENTABLE instead of preventing it. A presidentless
     * floated corporation is not a state 1830 has -- the certificate is a physical card that only ever moves
     * by exchange to a player already holding 20%, so it cannot reach the Bank Pool and there is always
     * somebody holding it. Teaching this function to describe that board gave the impossible state a tidy
     * encoding and a passing test, which is worse than the stale crown it replaced: `president: null` would
     * freeze the corporation out of laying track, running trains and spending its treasury.
     *
     * THE SYMPTOM HAD NO FIX OF ITS OWN. It was the shadow of the illegal sale, and #748 -- the reducer
     * refusing that sale -- is the whole correction. `next === null` is unreachable for a parred corporation
     * once the sale rule is enforced, and where it is reached anyway the incumbent is the safe answer: a stale
     * president is at least a president, and the board stays playable while the real error is found upstream.
     *
     * SAME ERROR CLASS AS #746c, one report earlier: making the code agree with a broken board rather than
     * asking whether the board should exist. Twice now the tell was the same -- I was writing an accommodation
     * and calling it a rule. */
    const next = presidentFor(company);
    if (next === null || next === company.president) return company;

    changes.push({
      companyId: company.company_id,
      ticker: company.ticker,
      from: company.president,
      to: next,
    });
    /* Design note #596a: ONLY the president field. No percentage moves --
       the certificate swap is already implied by this one value, and
       `certificateCount` derives both players' card counts from it. */
    return { ...company, president: next };
  });

  if (changes.length === 0) return { state, changes };
  return { state: { ...state, public_companies: companies }, changes };
}
