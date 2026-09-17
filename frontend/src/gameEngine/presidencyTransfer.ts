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
// buying alternately to 30%.
//
// ==================================================================
//  DESIGN NOTE 1620 (Slice 8.3, S8-2): THE TIE-BREAK IS CLOCKWISE, AND IT IS PRINTED
// ==================================================================
//
// #596b USED TO SAY THE RULE DID NOT EXIST. Its words: 'When several are tied above the president, 1830 says
// "the one who most recently reached that level"; this module cannot see history, so it takes the first in
// seating order and says so rather than pretending the tie cannot arise.' Both halves were wrong.
//
// THE RULE IS IN THE BOOK. §5.4: "If multiple players exceed your share total, and they each have the same
// number of shares, the new president is the player closest to you going in a clockwise direction." No
// history is needed -- the seating circle answers it, and the answer is a fact every client already holds.
//
// AND THE STAND-IN WAS NOT SEATING ORDER. `player_holdings` is built by `moveShares`, which PUSHES a holder
// the first time they buy and SPLICES them out when they fall to nothing, and by the B&O auction grant, which
// moves the winner to the end of the array. So the array is first-acquisition order: it agrees with seating by
// coincidence on a board where everybody bought in turn, and disagrees the moment anybody sells out and buys
// back, or wins the B&O. `presidentFor` could not have done better -- it took only the company, and the
// seating lives on the state -- so the roster is now an argument.
//
// WHICH SEAT THE CIRCLE IS COUNTED FROM is the whole content of the rule: "closest to YOU", the president
// being displaced. The incumbent's SEAT therefore survives their percentage -- a president sold down to 10%
// is no longer eligible, but they are still the player the challengers are closest to, so the origin is their
// seat and not the winner's and not seat 0. Seat 0 is the origin only where there is no incumbent at all,
// which is a fixture's board rather than a game's (#748b).
//
// ONE ORDERING RULE IN THIS FILE, and `closestClockwise` is it. The old `challengers.find(...)` and the
// `eligible.reduce(...)` fallback beside it were two more, both reading `player_holdings` order; a caller that
// wants to know who will preside -- the reducer's settlement, Stage 5's forced-sale projection, Slice 8.4's
// M&H exchange -- asks this function and gets the same answer as the settlement will produce.
//
// ==================================================================
//  DESIGN NOTE 1622 (Slice 8.3, S8-15): SELECTION AND SETTLEMENT ARE TWO THINGS
// ==================================================================
//
// #596a's "ONLY the president field" was right about the printed game and one card short of Scenario D. The
// presidency is a SWAP, and a swap has two sides: the President's 20% goes one way and 20% in the
// successor's own certificates comes back. In the printed game the return side needs no recording, because
// two ordinary 10%s are the only decomposition there is and `certificateCount` derives them from `president`
// alone. Under Scenario D the successor may hold the printed other-20 card and fewer than two 10%s, and then
// the card that comes back IS the other-20 -- a fact no percentage can carry, so it has to be written.
//
// WHICH DOES NOT GO IN `presidentFor`. Selection answers WHO on percentages and seats; settlement moves
// CARDS. They are separate here because they are separate questions asked by different callers: Stage 5's
// forced-sale projection wants the first and must not perform the second (a projection that moved a
// certificate would settle a sale it is only judging), and Slice 8.4's M&H exchange will want both, in this
// order. `settlePresidencies` is the one place that does both, atomically, in the one object it returns.
//
// THE CARD DECISION ITSELF LIVES IN `doubleCertificate.ts` (#1622), which this file asks. That module's own
// rule -- "this module is the only place that reads `double_certificate`" -- is why: the criterion is card
// arithmetic (`ordinaryPercentHeld`), and a second copy of it here is the drift #1184 keeps costing.
//
// See docs/ai_architecture/stock_market.md, presidencyTransfer.ts #596.

import type { GameStateResponse, PublicCompanyState } from "./gameState";
import { withPresidencyCertificateExchange } from "./doubleCertificate";

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

/** Of `candidates`, the one closest to `incumbent` going CLOCKWISE around `seating` -- design note #1620.
 *
 *  `d(p) = (seat(p) - seat(incumbent) + n) mod n`, smallest wins. The incumbent themself is never a
 *  candidate (a challenger holds STRICTLY more), so a finite `d` is always positive except on the
 *  no-incumbent board, where the circle is counted from seat 0 and the seat-0 holder's `d` is 0 -- which is
 *  §5.4's own answer read on a board it does not describe.
 *
 *  MALFORMED BOARDS ANSWER DETERMINISTICALLY RATHER THAN BY HOLDINGS ORDER. A player the roster does not
 *  seat has no place on the circle and no clockwise distance, so they sort last; an incumbent the roster does
 *  not seat gives no origin, so the circle is counted from seat 0 as it is with no incumbent; and a board
 *  that seats nobody has no circle at all. Every real holder IS seated -- `applySandboxActionInner` resolves
 *  its actor through `player_addresses.includes`, the M&H grant through the private's owner and the B&O grant
 *  through a bidder, so `moveShares` can only ever be handed a seated player -- and `presidencyAuthority.test.ts`
 *  pins that. These arms exist so a hand-built fixture cannot make a REPLAY diverge, not as a second rule:
 *  address order is log-derived and independent of the array this note exists to stop reading. */
function closestClockwise(
  candidates: readonly string[],
  seating: readonly string[],
  incumbent: string | null,
): string {
  const seats = seating.length;
  const seated = incumbent === null ? -1 : seating.indexOf(incumbent);
  const from = seated === -1 ? 0 : seated;
  const distance = (player: string): number => {
    if (seats === 0) return Number.POSITIVE_INFINITY;
    const seat = seating.indexOf(player);
    if (seat === -1) return Number.POSITIVE_INFINITY;
    return (seat - from + seats) % seats;
  };
  return candidates.reduce((best, player) => {
    const mine = distance(player);
    const theirs = distance(best);
    if (mine !== theirs) return mine < theirs ? player : best;
    return player < best ? player : best;
  });
}

/** Who should preside over this corporation, given its holdings and the table it is played at.
 *
 *  `seating` is `state.player_addresses` -- CLOCKWISE table order, which is what §5.4's tie-break is measured
 *  on (design note #1620). It is a required argument rather than an optional one precisely because the
 *  defect it repairs was a caller that could not supply it.
 *
 *  `null` when nobody qualifies, which for a PARRED corporation is unreachable: design note #748b, the
 *  President's Certificate is one card that only ever moves by exchange to a holder of 20% or more, so it
 *  cannot reach the Bank Pool and somebody always has it. The real case is a company nobody has started.
 *  This doc comment used to add "or one whose shares are all in the pool" -- that board cannot exist, and
 *  writing it down here is what led a caller to build a vacate-the-crown branch for it.
 *
 *  Returning the INCUMBENT when they still lead is deliberate: the caller compares against
 *  `company.president` and does nothing when they match. */
export function presidentFor(
  company: PublicCompanyState,
  seating: readonly string[],
): string | null {
  const holdings = company.player_holdings.filter((entry) => entry.percentage > 0);
  if (holdings.length === 0) return null;

  /* A player must hold at least the president's block to preside at all --
     nobody can hold a 20% certificate on 10% of the company.
     Design note #1620: A PERCENTAGE, NOT A CARD. Under the Level Playing Field the Erie and the N&W print a
     second, NON-PRESIDENT 20% certificate (`doubleCertificate.ts` #1324), and it qualifies its holder here
     exactly as two ordinary 10% cards would and no more: the crown is decided on percentage ownership plus
     §5.4, and `double_certificate` is not read anywhere in this file. */
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
    /* Nobody exceeds the incumbent, so the incumbent stays -- and they are necessarily still eligible: every
       entry in `eligible` holds 20% or more, and none of them exceeds `incumbentHolding`, so the incumbent
       holds 20% or more too. An incumbent under 20% therefore cannot reach this branch, which is why the old
       `eligible.reduce(...)` arm that stood here was unreachable as well as a second ordering rule. */
    return incumbent;
  }

  /* Design note #1620: percentage first, ALWAYS. The clockwise rule is a tie-break and never a preference --
     a 40% challenger three seats away beats a 30% challenger in the next seat. */
  const top = challengers.reduce(
    (best, entry) => Math.max(best, entry.percentage),
    0,
  );
  const tied = challengers.filter((entry) => entry.percentage === top);
  if (tied.length === 1) return tied[0].player;
  return closestClockwise(
    tied.map((entry) => entry.player),
    seating,
    incumbent,
  );
}

/** Who would preside if `seller` sold `percentage` of this corporation -- the board that sale would leave,
 *  asked of the canonical selector.
 *
 *  Design note #1620 (Slice 8.3, S8-2): THE PROJECTION AND THE SETTLEMENT ARE ONE FUNCTION. It holds no
 *  eligibility test, no strictly-more test and no tie-break of its own, so there is nothing here that can
 *  drift from what the `SellStock` arm will settle. `seating` is `state.player_addresses`.
 *
 *  Design note #1624 (Slice 8.3, S9-14): AND IT HAS TWO ASKERS NOW, which is why it lives here beside the
 *  selector rather than inside `emergencyFunding.ts` where it started. Stage 5 asks it to refuse a forced
 *  sale that would move the crown (6.6.3), and `shareSaleBlock` asks it to find out whether an ordinary sale
 *  triggers the Scenario-D certificate exchange. SELECTION ONLY, in both: a projection that settled a
 *  certificate would change the board it is merely judging. */
export function presidentAfterSale(
  company: PublicCompanyState,
  seller: string,
  percentage: number,
  seating: readonly string[],
): string | null {
  const holdings = company.player_holdings
    .map((entry) => (entry.player === seller ? { ...entry, percentage: entry.percentage - percentage } : entry))
    .filter((entry) => entry.percentage > 0);
  return presidentFor({ ...company, player_holdings: holdings }, seating);
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
  /* Design note #1620: the clockwise tie-break's one input, taken from the state this function already has.
     `?? []` for #232's reason -- a fixture that seats nobody has said nothing about the circle, and a board
     with no tie never asks. */
  const seating = state.player_addresses ?? [];

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
    const next = presidentFor(company, seating);
    if (next === null || next === company.president) return company;

    changes.push({
      companyId: company.company_id,
      ticker: company.ticker,
      from: company.president,
      to: next,
    });
    /* Design note #596a: NO PERCENTAGE MOVES. The swap is implied by `president`, and `certificateCount`
       derives both players' card counts from it.
       Design note #1622 (S8-15): AND, ON A SCENARIO-D CORPORATION, SOMETIMES BY ONE MORE FIELD. Asked
       FIRST, of the board while `company.president` is still the outgoing president -- that is what names
       the recipient and what tells `ordinaryPercentHeld` the successor does not hold the President's
       Certificate yet. Identity on every printed-game board, so the ordinary case is exactly as it was. */
    const exchanged = withPresidencyCertificateExchange(company, next);
    return { ...exchanged, president: next };
  });

  if (changes.length === 0) return { state, changes };
  return { state: { ...state, public_companies: companies }, changes };
}
