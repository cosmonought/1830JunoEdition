// frontend/src/utils/doubleCertificate.ts
//
// The 20% standard certificate -- design note #1324.
//
// ==================================================================
//  DESIGN NOTE 1324: ONE CARD THE PERCENTAGES CANNOT SEE
// ==================================================================
//
// RULED: "both N&W and ERIE have a 20% President's share, a standard 20% share, and six standard 10% shares.
// The standard 20% share can be 'half-sold' (acting as a 10% sale) only if the Bank Pool currently holds at
// least one 10% share of that corporation to physically exchange with it. Otherwise, it must be sold entirely
// as a 20% block." And: bought from the IPO or the Bank Pool at twice the share price, counting as ONE
// certificate; a player may hold it beside the president's certificate.
//
// HOLDINGS STAY PERCENTAGES. `player_holdings`, `ipo_pool_percentage` and `bank_pool_percentage` are the
// model every arm and every panel reads, and a percentage cannot say which twenty of a holder's forty is one
// card. So the corporation carries exactly the missing fact -- `double_certificate: { at }` -- and this module
// is the only place that reads it. Every question below is answered from a percentage plus that one field:
//
//   ORDINARY SHARES IN A POOL are the pool's percentage less twenty if the double sits there. A pool holding
//   only the double has no 10% certificate to sell, and an ordinary buy from it is refused.
//   THE DOUBLE MOVES when a holder sells INTO it: a seller's ordinary certificates go first, and only when the
//   sale reaches the double does it leave -- as a block, or as the half-sale when the pool can hand a 10%
//   card back. The arithmetic on the percentages is already right in both cases; what this module adds is
//   which card ends up where, and the refusal when the half-sale has nothing to exchange with.
//   A CERTIFICATE COUNT is president (1) + double (1) + the rest in tens.
//
// KEYED BY ADDRESS OR POOL NAME. `"Ipo"` and `"Bank"` are the two pools' names everywhere else in the
// reducer (`moveShares`), and no player address can collide with either.

import type { GameStateResponse, PublicCompanyState } from "./gameState";

export const DOUBLE_CERTIFICATE_PERCENT = 20;
/* Local, not imported from `sandboxSession` (which imports this file) -- the same two figures `sharePurchase.ts`
   and `shareSale.ts` keep for the same reason. */
const SANDBOX_SHARE_PERCENTAGE = 10;
const SANDBOX_PRESIDENT_PERCENTAGE = 20;

type CompanyLike = Pick<
  PublicCompanyState,
  "player_holdings" | "ipo_pool_percentage" | "bank_pool_percentage" | "president" | "double_certificate"
>;

/** Whether this corporation has a 20% standard certificate at all. */
export function hasDoubleCertificate(company: Pick<PublicCompanyState, "double_certificate"> | null | undefined): boolean {
  return typeof company?.double_certificate?.at === "string" && company.double_certificate.at !== "";
}

/** Where the double is: `"Ipo"`, `"Bank"`, a player address, or `null` when there is none. */
export function doubleCertificateAt(
  company: Pick<PublicCompanyState, "double_certificate"> | null | undefined,
): string | null {
  return hasDoubleCertificate(company) ? (company as PublicCompanyState).double_certificate!.at : null;
}

export function holdsDouble(company: CompanyLike | null | undefined, holder: string | null): boolean {
  return holder !== null && doubleCertificateAt(company) === holder;
}

/** The percentage of a pool that is ordinary 10% certificates -- what an ordinary buy may draw on. */
export function ordinaryPercentIn(company: CompanyLike, pool: "Ipo" | "Bank"): number {
  const total = pool === "Bank" ? company.bank_pool_percentage : company.ipo_pool_percentage;
  return Math.max(0, total - (doubleCertificateAt(company) === pool ? DOUBLE_CERTIFICATE_PERCENT : 0));
}

/** A holder's percentage that is neither the president's card nor the double. */
export function ordinaryPercentHeld(company: CompanyLike, holder: string): number {
  const held = company.player_holdings.find((entry) => entry.player === holder)?.percentage ?? 0;
  const president = company.president === holder ? SANDBOX_PRESIDENT_PERCENTAGE : 0;
  const double = holdsDouble(company, holder) ? DOUBLE_CERTIFICATE_PERCENT : 0;
  return Math.max(0, held - president - double);
}

/** How many CARDS `holder` has of this corporation. Zero when nothing is held. */
export function certificateCardsHeld(company: CompanyLike, holder: string): number {
  const held = company.player_holdings.find((entry) => entry.player === holder)?.percentage ?? 0;
  if (held <= 0) return 0;
  const president = company.president === holder ? 1 : 0;
  const double = holdsDouble(company, holder) ? 1 : 0;
  const ordinary = Math.max(
    0,
    held - president * SANDBOX_PRESIDENT_PERCENTAGE - double * DOUBLE_CERTIFICATE_PERCENT,
  );
  return Math.max(1, president + double + Math.ceil(ordinary / SANDBOX_SHARE_PERCENTAGE));
}

/** How many CARDS a pool holds of this corporation -- the display's unit, with the double counted once.
 *
 *  ==================================================================
 *   DESIGN NOTE 1374: THE PANEL COUNTED IN TENS, SO THE DOUBLE READ AS TWO
 *  ==================================================================
 *  REPORTED: "On LPF, the extra 20% share for N&W and ERIE is counting as 2 certificates instead of 1. That
 *  defeats its purpose. These two corporations should only have 8 shares total."
 *  THE RULE WAS RIGHT AND THE PANEL WAS NOT. `certificateCardsHeld` above has counted the double as one card
 *  since #1324, and the certificate limit and every player card read through it. The Stock Round panel's
 *  ownership table had its own counter -- `percentage / 10`, less one for a president -- written for the
 *  printed game where that is exactly the card count, and it never learned about the double. So a full N&W
 *  IPO read "9 (100%)" for eight pieces of card, and a player holding the double read "2 (20%)".
 *  ONE UNIT FOR EVERY ROW. The pools count here, the holders through `certificateCardsHeld`; the panel's own
 *  arithmetic is gone. A president's certificate sits in the IPO while the presidency is unsold and never
 *  reaches the Bank Pool (#448), which is the one asymmetry between the two pools. */
export function certificateCardsInPool(company: CompanyLike, pool: "Ipo" | "Bank"): number {
  const percentage = pool === "Ipo" ? company.ipo_pool_percentage : company.bank_pool_percentage;
  if (percentage <= 0) return 0;
  const president = pool === "Ipo" && company.president === null ? 1 : 0;
  const double = doubleCertificateAt(company) === pool ? 1 : 0;
  const ordinary = Math.max(
    0,
    percentage - president * SANDBOX_PRESIDENT_PERCENTAGE - double * DOUBLE_CERTIFICATE_PERCENT,
  );
  return president + double + Math.ceil(ordinary / SANDBOX_SHARE_PERCENTAGE);
}

/* ---- buying ------------------------------------------------------------------ */

/** Why the double cannot be bought from `source` right now, or `null`. The price is twice a share; the
 *  certificate-limit and holding-cap rules are the ordinary gate's, asked with one certificate of twenty. */
export function doublePurchaseRefusal(company: CompanyLike, source: "Ipo" | "Bank"): string | null {
  if (!hasDoubleCertificate(company)) return "This corporation has no 20% certificate.";
  if (doubleCertificateAt(company) !== source) {
    return `The 20% certificate is not in the ${source === "Bank" ? "Bank Pool" : "IPO"}.`;
  }
  return null;
}

/** Why an ordinary buy of `certificates` 10% cards from `source` is refused by the double's presence, or
 *  `null`. A pool whose only remaining twenty is the double has nothing ordinary to sell. */
export function ordinaryPurchaseRefusal(
  company: CompanyLike,
  source: "Ipo" | "Bank",
  certificates: number,
): string | null {
  if (!hasDoubleCertificate(company)) return null;
  const ordinary = ordinaryPercentIn(company, source);
  if (ordinary >= certificates * SANDBOX_SHARE_PERCENTAGE) return null;
  const where = source === "Bank" ? "Bank Pool" : "IPO";
  return `The ${where} holds only the 20% certificate of this corporation — buy that (at twice the share price) or nothing.`;
}

/* ---- selling -------------------------------------------------------------------- */

/** What a sale of `percentage` by `holder` does to the double: nothing, moves it as a block, or the
 *  half-sale. `null` when the sale is refused by the half-sale rule (the refusal text is beside it). */
export type DoubleSaleEffect =
  | { kind: "none" }
  | { kind: "block" }
  | { kind: "half" }
  | { kind: "refused"; reason: string };

export function doubleSaleEffect(company: CompanyLike, holder: string, percentage: number): DoubleSaleEffect {
  if (!holdsDouble(company, holder)) return { kind: "none" };
  const ordinary = ordinaryPercentHeld(company, holder);
  if (percentage <= ordinary) return { kind: "none" };
  const fromDouble = percentage - ordinary;
  if (fromDouble >= DOUBLE_CERTIFICATE_PERCENT) return { kind: "block" };
  /* The half-sale: 10% of the double is sold by handing the whole card to the pool and taking a 10%
     card back. Only possible when the pool has one to hand over. */
  if (ordinaryPercentIn(company, "Bank") >= SANDBOX_SHARE_PERCENTAGE) return { kind: "half" };
  return {
    kind: "refused",
    reason:
      "Selling 10% of the 20% certificate needs a 10% share in the Bank Pool to exchange it for — there is none, so the 20% certificate must be sold as a whole.",
  };
}

/** The refusal string the sale gate reports, or `null`. */
export function doubleSaleRefusal(company: CompanyLike, holder: string, percentage: number): string | null {
  const effect = doubleSaleEffect(company, holder, percentage);
  return effect.kind === "refused" ? effect.reason : null;
}

/* ---- the presidency exchange ------------------------------------------------------ */

/** ==================================================================
 *   DESIGN NOTE 1622 (Slice 8.3, S8-15): THE 20%-FOR-20% SWAP
 *  ==================================================================
 *
 * RULED (owner, 2026-09-17): "if the successor instead needs the physical other-20 certificate to provide
 * the required 20% back to the former president, transfer that certificate one-for-one for the President's
 * Certificate; percentages do not change because of the presidency exchange itself."
 *
 * §5.4 SPELLS THE EXCHANGE IN CARDS, and #596a modelled it as "two ordinary 10% certificates" because in the
 * printed game that is the only decomposition there is: "He gives you two of his certificates for that
 * corporation." Under Scenario D the ERIE and the N&W print an "other" 20% certificate as well, and a
 * successor can hold it while holding LESS than 20% in ordinary 10%s besides -- at which point they have no
 * two 10%s to give and the only 20% they can hand back is that one card.
 *
 * SO THE EXCHANGE HAS TWO SHAPES AND THE BOARD PICKS, NOT THE PLAYER. Printed rules give no choice here:
 *
 *   ordinary 10% holdings >= 20  ->  the normal exchange. Two 10%s go back, the other-20 stays put, and this
 *                                    function changes nothing -- which is every board in the printed game.
 *   ordinary 10% holdings <  20  ->  the other-20 card IS the 20% handed back. It leaves the successor and
 *                                    the successor keeps their 10%s.
 *
 * ORDINARY MEANS ORDINARY. The test is `ordinaryPercentHeld`, the same helper the sale gate uses, NEVER the
 * total percentage: a successor on 30% holding the other-20 plus one 10% and a successor on 30% holding three
 * 10%s are the same percentage and a different exchange. Inferring cards from a percentage is exactly the
 * error #1374 fixed in the panel.
 *
 * WHERE THE CARD GOES is the former president, whose own 20% it now is -- they gave a 20% card and received
 * one, so nobody's percentage moved, which is invariant 3 of the ruling.
 *
 * AND THE ONE CASE WHERE IT CANNOT BE THEM. `settlePresidencies` runs AFTER the holdings have moved, so on a
 * `SellStock` the former president can already be below 20% (`shareSaleBlock` permits selling under the block
 * when somebody can take it). The printed sequence for that turn is exchange-then-sell: they took the other-20
 * and sold it, so the card is in the Bank Pool, which is where the percentage they sold went too. Hence the
 * second destination, and its guard: the pool must have 20 points for a 20% card to sit in.
 *
 * WHICH LEAVES EXACTLY THREE DESTINATIONS, AND THE THIRD ARM IS FOR FIXTURES ONLY. Over an accepted action
 * whose crown moves to a successor needing this card, the seller's own 10%s go first (below), so: a sale that
 * does not reach the card leaves the seller on 20% or more and THEY hold it; a sale of the whole card puts at
 * least 20 points in the pool and the POOL holds it; and the half-sale -- the only shape that could leave
 * neither able to hold a 20% card -- is now refused unless the pool already had a 10% to exchange against
 * (`shareSale.ts` #1624, S9-14), after which the pool is again on 20 or more. On the buy side the outgoing
 * president's holding is untouched by the buyer and a president always holds the 20% certificate, so they can
 * always take it. So `return company` below is unreachable through reducer authority and exists for a
 * hand-built board; moving nothing is the honest answer there rather than putting a card somewhere impossible
 * -- #748b's rule that an accommodation is not a repair. `presidencyLpf.test.ts` §7 pins the exhaustiveness.
 *
 * ASKED BEFORE THE CROWN MOVES. `company.president` must still be the OUTGOING president when this is
 * called: it is what identifies the recipient, and `ordinaryPercentHeld` reads it to know the successor does
 * not hold the President's Certificate yet. `presidencyTransfer.ts` calls it and then writes `president`, in
 * that order, into one object. */
export function withPresidencyCertificateExchange<T extends CompanyLike>(
  company: T,
  successor: string,
): T {
  /* No other-20 on this corporation, or it is not the successor's: the normal exchange, and nothing about the
     card identity moves. Every printed-game board takes this return. */
  if (!holdsDouble(company, successor)) return company;
  /* The successor has two ordinary 10%s to hand back, so §5.4's normal exchange applies and the other-20
     stays exactly where it is. */
  if (ordinaryPercentHeld(company, successor) >= SANDBOX_PRESIDENT_PERCENTAGE) return company;

  const outgoing = company.president;
  const outgoingHolding =
    outgoing === null
      ? 0
      : (company.player_holdings.find((entry) => entry.player === outgoing)?.percentage ?? 0);
  if (outgoing !== null && outgoingHolding >= DOUBLE_CERTIFICATE_PERCENT) {
    return { ...company, double_certificate: { at: outgoing } };
  }
  if (company.bank_pool_percentage >= DOUBLE_CERTIFICATE_PERCENT) {
    return { ...company, double_certificate: { at: "Bank" } };
  }
  return company;
}

/** Whether the presidency exchange to `successor` is the special 20%-for-20% one rather than §5.4's two
 *  ordinary 10%s -- the predicate behind `withPresidencyCertificateExchange`, exported so a caller can SAY
 *  so (the Activity Log's reason, U-33) without re-deriving the card arithmetic. Asked of the board before
 *  the crown moves, as above. */
export function needsDoubleForPresidencyExchange(company: CompanyLike, successor: string): boolean {
  return (
    holdsDouble(company, successor) &&
    ordinaryPercentHeld(company, successor) < SANDBOX_PRESIDENT_PERCENTAGE
  );
}

/* ---- state writes ---------------------------------------------------------------- */

/** The corporation with its double recorded at `at`. */
export function withDoubleAt(
  state: GameStateResponse,
  companyId: number,
  at: string,
): GameStateResponse {
  return {
    ...state,
    public_companies: state.public_companies.map((company) =>
      company.company_id === companyId && hasDoubleCertificate(company)
        ? { ...company, double_certificate: { at } }
        : company,
    ),
  };
}
