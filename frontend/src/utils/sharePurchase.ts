// frontend/src/utils/sharePurchase.ts
//
// Whether a player may buy this share, and why not.
//
// Design note #712: THE ZONE RULES WERE DESCRIBED BUT NOT ENFORCED.
//
// REPORTED: "Players are able to purchase more than 60% in a corporation even if its stock price isn't in the
// orange zone." Followed by: "make sure the other rules are encoded as well."
//
// They were all encoded as PREDICATES and none of them as GATES. `isCertificateExemptZone` and
// `allowsMultipleBankPoolBuys` have existed for a long time, `ZONE_DESCRIPTIONS` states all three rules in
// prose a player can read on the chart, and `certificateBreakdown` carefully splits a player's holdings into
// `counted` and `exempt`. Nothing consulted any of it before applying a purchase: the Buy button's only
// conditions were "is it your turn" and "can you afford it", and the reducer moved the certificate
// unconditionally.
//
// SO THE RULES WERE DOCUMENTATION. The chart told a player that the Orange zone lets them exceed 60%, which
// implies a 60% ceiling everywhere else -- and that ceiling was never there. `PLAYER_HOLDING_CAP_PERCENT` was
// read by exactly one caller, `privateExchange`, guarding the M&H trade-in and nothing else.
//
// THREE BASE RULES AND THREE WAIVERS, which is why they belong in one function rather than three:
//
//   no player may hold more than 60% of a corporation   waived in ORANGE and BROWN
//   no player may exceed the certificate limit          waived per-certificate in YELLOW, ORANGE and BROWN
//   one certificate purchase per stock-round turn       waived for POOL shares in BROWN
//
// The waivers are not independent of the rules -- each is stated as an exception to a specific one -- so a
// design that scattered them would leave a reader unable to find the rule a waiver waives.
//
// THE ZONE ARRIVES AS A PARAMETER, for the reason design note #7 gives about `certificateBreakdown`: the
// price-to-zone table lives in `StockMarketRenderer.tsx` and `utils/` may not import from `components/`.
// Injecting it keeps that boundary AND keeps this pure.
//
// See docs/ai_architecture/stock_market.md, sharePurchase.ts #712.

import { certificateBreakdown, type GameStateResponse } from "./gameState";
import { PLAYER_HOLDING_CAP_PERCENT } from "./privateExchange";

/** A 10% certificate. The president's is 20%, and is handled where it is bought. */
export const SHARE_PERCENT = 10;
export const PRESIDENT_SHARE_PERCENT = 20;

/** `ZoneType` from `StockMarketRenderer`, restated as a bare string union so `utils/` need not import it. */
export type PriceZone = "Normal" | "Yellow" | "Orange" | "Brown" | null;

export interface SharePurchaseInput {
  state: GameStateResponse;
  buyer: string;
  companyId: number;
  source: "Ipo" | "Bank";
  /** How many certificates this purchase would take. `1` unless a Brown pool multi-buy. */
  quantity: number;
  /** The zone of THIS corporation's current price. */
  zone: PriceZone;
  /** Live prices per company, for the certificate-limit exemption. Omit and everything counts, which is
   *  #7's deliberate conservative answer rather than a degraded one. */
  marketPrices?: Readonly<Record<number, number | null>> | null;
  zoneForPrice?: (price: number | null | undefined) => string | null;
  /** Certificates this player has already bought this stock-round turn. */
  boughtThisTurn?: number;
}

/** Why this purchase is illegal, or `null` if it is allowed.
 *
 *  A REASON RATHER THAN A BOOLEAN, following #619: a Buy button that refuses without saying why is a button a
 *  player cannot reason about -- and here the reason is a rule they may not know, which is worse. Each string
 *  names the RULE and, where a zone would lift it, says so: a player denied at 60% should learn that the
 *  Orange zone is what changes it, because that is a thing they can play toward. */
export function sharePurchaseBlock(input: SharePurchaseInput): string | null {
  const {
    state,
    buyer,
    companyId,
    source,
    quantity,
    zone,
    marketPrices,
    zoneForPrice,
    boughtThisTurn = 0,
  } = input;

  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  // A corporation this build cannot see is not a corporation this build may reason about.
  if (!company) return null;

  const taking = Math.max(1, Math.floor(quantity)) * SHARE_PERCENT;

  /* ---- 1. The 60% cap, waived in Orange and Brown --------------------------------------------- */
  const held =
    company.player_holdings.find((entry) => entry.player === buyer)?.percentage ?? 0;
  if (!exceeds60Allowed(zone) && held + taking > PLAYER_HOLDING_CAP_PERCENT) {
    /* THE REPORTED BUG. Named with the zone that would lift it, because "you may not" and "you may not YET"
       are different pieces of information and only one of them is playable. */
    return `No player may hold more than ${PLAYER_HOLDING_CAP_PERCENT}% of one corporation — ${company.ticker} is at ${held}% for you. The Orange and Brown zones lift this cap.`;
  }

  /* ---- 2. The certificate limit, waived per-certificate in Yellow, Orange and Brown ------------ */
  const certs = certificateBreakdown(buyer, state, marketPrices, zoneForPrice);
  if (certs.limit !== null && !isExemptZone(zone)) {
    /* ONLY A NON-EXEMPT PURCHASE COUNTS. A share bought into a Yellow-or-better corporation is exempt the
       moment it is held, so it cannot push anybody over -- which is the whole point of the exemption and the
       reason this test is on the ZONE rather than on the total. */
    const after = certs.counted + Math.max(1, Math.floor(quantity));
    if (after > certs.limit) {
      return `That would put you at ${after} certificates against a limit of ${certs.limit}. Shares priced in the Yellow, Orange or Brown zones do not count.`;
    }
  }

  /* ---- 3. One purchase per turn, waived for pool shares in Brown ------------------------------- */
  if (boughtThisTurn > 0 && !allowsExtraPoolBuys(zone, source)) {
    return `One certificate purchase per turn. Only Brown-zone shares bought from the Bank Pool may be taken several at a time.`;
  }
  if (quantity > 1 && !allowsExtraPoolBuys(zone, source)) {
    return `Several certificates at once is a Brown-zone Bank Pool allowance only.`;
  }

  return null;
}

/** Orange and Brown lift the 60% ownership cap. */
export function exceeds60Allowed(zone: PriceZone): boolean {
  return zone === "Orange" || zone === "Brown";
}

/** Yellow, Orange and Brown certificates are exempt from the limit. Mirrors
 *  `isCertificateExemptZone`, which lives in `components/` and cannot be imported here. */
export function isExemptZone(zone: PriceZone): boolean {
  return zone === "Yellow" || zone === "Orange" || zone === "Brown";
}

/** Brown, and from the Bank Pool -- both halves, because the allowance is about POOL shares specifically. */
export function allowsExtraPoolBuys(zone: PriceZone, source: "Ipo" | "Bank"): boolean {
  return zone === "Brown" && source === "Bank";
}

/** The most certificates this purchase may legally take at once.
 *
 *  Used to cap the Brown selector, so the control cannot offer a quantity the gate above would refuse --
 *  #247's rule about a field showing a number the player cannot buy, applied to shares. */
export function maxPurchaseQuantity(input: Omit<SharePurchaseInput, "quantity">): number {
  if (!allowsExtraPoolBuys(input.zone, input.source)) return 1;
  const company = input.state.public_companies.find(
    (entry) => entry.company_id === input.companyId,
  );
  if (!company) return 1;
  // The pool is the physical ceiling; the rules above are checked per candidate quantity.
  const inPool = Math.floor(company.bank_pool_percentage / SHARE_PERCENT);
  let allowed = 0;
  for (let take = 1; take <= inPool; take += 1) {
    if (sharePurchaseBlock({ ...input, quantity: take }) !== null) break;
    allowed = take;
  }
  return Math.max(1, allowed);
}
