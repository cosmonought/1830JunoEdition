// frontend/src/utils/presidencyTransfer.ts
//
// THE PRESIDENT'S CERTIFICATE CHANGES HANDS.
//
// ==================================================================
//  DESIGN NOTE 596: BEING BOUGHT OUT OF A PRESIDENCY
// ==================================================================
//
// REPORTED: "P1 was President of a corporation with 1 share (President's
// 20%). P2 owned two shares and purchased a third. The card then showed: P2,
// 3 certificates, 30%, and P1 (president's crown), 1 certificate, 20%... P1
// must transfer the President's share to P2, so that the resulting card
// should read: P2 (crown), 2 certificates, 30%, and P1, 2 certificates, 20%."
//
// Exactly right, and the reducer had no notion of it. `BuyStock` moved
// percentages and set `president` only on the FOUNDING purchase; after that
// the crown never moved again, however the holdings changed. So a corporation
// could be majority-owned by one player and presided over by another
// indefinitely -- which in 1830 decides who lays its track, runs its trains
// and spends its treasury.
//
// ==================================================================
//  DESIGN NOTE 596a: IT IS A SWAP, NOT A RELABEL
// ==================================================================
//
// The subtle half, and the reason the report spells out the certificate
// counts. The presidency is not a flag on a player -- it is a PHYSICAL
// CERTIFICATE worth 20%, and there is exactly one. So a takeover is an
// exchange: the new president hands back two ordinary 10% certificates and
// receives the president's card; the outgoing president hands back the
// president's card and receives those two 10% certificates.
//
// NOBODY'S PERCENTAGE MOVES. P2 held 30% before and holds 30% after; P1 held
// 20% and holds 20%. What changes is how many CARDS each holds -- P2 goes
// from three to two, P1 from one to two -- because the certificate LIMIT
// counts cards, not percentages. Modelling this as "set `president` to P2"
// would leave both players' certificate counts wrong for the rest of the
// game, and the limit is a real constraint players plan around.
//
// This file therefore changes no `percentage` at all. The whole transfer is
// expressed by moving `president`, and `certificateCount` (`gameState.ts`)
// already derives the card count from that -- one certificate for the 20%
// block plus one per 10% beyond it. The swap is real; it is simply already
// implied by the one field.
//
// ==================================================================
//  DESIGN NOTE 596b: STRICTLY MORE, AND TIES DO NOT MOVE IT
// ==================================================================
//
// 1830: the presidency passes when another player holds MORE than the
// president. An equal holding leaves it where it is -- the incumbent keeps
// it, which is what stops the crown flickering between two players who buy
// alternately to 30% each.
//
// ONLY ONE CHALLENGER CAN WIN, and when several are tied above the president
// the rule is "the one who most recently reached that level". This module
// cannot see history, so it takes the first in seating order and says so
// here rather than pretending the tie cannot arise -- it can, when a sale
// drops the president below two players at once.

import type { GameStateResponse, PublicCompanyState } from "./gameState";

/** 1830's president's certificate: one card, worth two ordinary shares. */
export const PRESIDENT_CERTIFICATE_PERCENT = 20;

export interface PresidencyChange {
  companyId: number;
  ticker: string;
  from: string | null;
  to: string;
}

/** Who should preside over this corporation, given its holdings.
 *
 *  `null` when nobody qualifies -- an unstarted company, or one whose shares
 *  are all in the pool. Returning the INCUMBENT when they still lead is
 *  deliberate: the caller compares against `company.president` and does
 *  nothing when they match, so "no change" and "no president" stay distinct.
 */
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

/**
 * Settles the presidency of every corporation whose holdings have moved.
 *
 * Returns the state unchanged when no crown moves, so a caller can use
 * identity to decide whether anything happened -- and so this is safe to run
 * after every holding change rather than only where a takeover is expected.
 */
export function settlePresidencies(state: GameStateResponse): {
  state: GameStateResponse;
  changes: PresidencyChange[];
} {
  const changes: PresidencyChange[] = [];

  const companies = state.public_companies.map((company) => {
    /* An unstarted company has no presidency to settle -- its certificate is
       still in the IPO, and `par_value` is what says so (design note #587). */
    if (company.par_value === null || company.par_value === undefined) return company;

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
