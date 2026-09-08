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
