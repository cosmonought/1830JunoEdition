// frontend/src/gameEngine/stockTransactionAuthority.ts
//
// ==================================================================
//  DESIGN NOTE 1570: THE STOCK TRANSACTION HAS AN AUTHORITY NOW (Batch 7.2)
// ==================================================================
//
// WHAT THE AUDIT FOUND, and it is four faults wearing one name (S7-13, S8-7, S8-8, S8-9, S7-16, S7-18,
// and m9 out of `AUDIT_RULES_TO_MACHINE_2026-09-13.md`):
//
//   `BuyStock` priced an IPO share FROM THE MESSAGE. `{par_value: "1"}` bought a $100 share for $1, and a
//   president's certificate could be parred at 999 or at 1 because nothing compared the figure against the
//   chart's ladder. An IPO buy of an unparred corporation with NO par silently became the president's
//   purchase at $67 -- a fallback nobody chose, on a board nobody could reconstruct.
//
//   NEITHER MESSAGE HAD A ROUND GATE. Stock was bought and sold during Operating Rounds and during the
//   private auction, by whoever the cursor happened to seat.
//
//   A PURCHASE FROM AN EMPTY SOURCE CHARGED AND DELIVERED NOTHING (m9). The arm capped the certificates it
//   handed over to what the pool held and charged for what was asked.
//
//   AND THE SALE HAD NO CALENDAR AT ALL: certificates sold in the first Stock Round (§5.1 forbids it),
//   shares of an unparred corporation sold at a nominal price (§p.15 forbids it), and a `percentage: 15`
//   left a five-percent holding no card in the box can represent.
//
// ONE PREDICATE PER MESSAGE, ASKED IN THREE PLACES. `stockPurchaseRefusal` and `stockSaleRefusal` are asked
// by the reducer's core (by identity -- a refused action makes no mutation), at ingress (with the sentence
// the room banner shows), and -- for the sale -- inside the market step's `saleRefused` closure, which is
// #748a's rule and the only subtle wiring in this batch: the chart atom advances BEFORE the board, so a sale
// the core will decline must be declined by the SAME predicate there, or the token drops for a sale that
// never happened and the board and the chart disagree permanently.
//
// THE REDUCER REMAINS CANONICAL LAW. Ingress answers with a reason; it does not own a rule. Both locks call
// the functions below, so they cannot drift -- #1184's shape, avoided by construction.
//
// SEAT AUTHORITY IS NOT HERE, DELIBERATELY (owner ruling D-9/Q10). JUNO-3XD's Stock Round 1 was seated under
// the pre-#1235 constant, so every SR1 buy in that legacy log has `actor !== seat` on the log-derived board;
// a reducer seat check would refuse a whole round of a development-corpus log for no rules reason. The round
// and legality gates below are functions of the log and are safe.
//
// THE LADDER, THE ZONE AND THE PRICE COME FROM THE CHART IN EFFECT, never from a second table: `parBoxCellFor`
// (#415) is the one statement of which par boxes exist, and `market_positions` (#1196) is the one statement of
// where the tokens are. A caller may inject both (the reducer already carries them); a caller that carries
// NEITHER gets #757's answer -- no opinion -- rather than a guess, which is why a bare fixture board keeps the
// behaviour it was written against.
//
// See BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md §7.2 / §7.3, owner rulings D-17 (Q4), D-22 (Q9),
// D-25 (Q13), and RULES_HARDENING_BACKLOG.md S7-13 / S7-16 / S7-18 / S8-7 / S8-8 / S8-9.

import type { GameStateResponse, PublicCompanyState } from "./gameState";
import { playerCashOf } from "./cashLedger";
import {
  PRESIDENT_SHARE_PERCENT,
  SHARE_PERCENT,
  sharePurchaseBlock,
  type PriceZone,
} from "./sharePurchase";
import { shareSaleBlock } from "./shareSale";
import {
  DOUBLE_CERTIFICATE_PERCENT,
  doubleCertificateAt,
  doublePurchaseRefusal,
  doubleSaleEffect,
} from "./doubleCertificate";
import { PAR_BOX_PRICES, marketZoneForPrice, parBoxCellFor } from "./marketGeometry";
import { emergencyFundingFor, forcedSaleRefusal } from "./emergencyFunding";
import type { MapGridResponse } from "../components/hexContractTypes";

/** The chart facts a stock rule needs, injected on #7's rule.
 *
 *  EVERY FIELD IS OPTIONAL AND ABSENT MEANS "NO OPINION" (#757/#232), which is what keeps this safe to add to
 *  a reducer whose fixtures were written without a chart. `chartContextFromState` below builds the whole set
 *  from `state.market_positions`, so the live callers hand in the board's own chart rather than a copy. */
export interface StockChartContext {
  /** The zone of a corporation's current price. ABSENT MEANS THE ZONE RULES ARE NOT ASKED -- #712's rule,
   *  preserved exactly: "a caller with no chart cannot tell a Normal price from an Orange one, and guessing
   *  would either forbid a legal purchase or wave an illegal one through." */
  marketZoneFor?: (companyId: number) => PriceZone;
  marketPricesByCompany?: Readonly<Record<number, number | null>> | null;
  zoneForPrice?: (price: number | null | undefined) => string | null;
  /** The par ladder in effect (#415/#1193). Absent falls back to the chart module's own par boxes, which is
   *  the same table every injecting caller passes. */
  parCellFor?: (parPrice: number) => { x: number; y: number } | null;
  /** The authoritative price of a corporation's token, or `null` when it has none.
   *  `undefined` (the field absent) means THIS BOARD HAS NO CHART, which is a different fact from "this
   *  corporation has no token" and is why the two are not folded together. */
  priceFor?: (companyId: number) => number | null;
  /** #1520's pin: this board was dealt by this engine and carries a `rules_engine_version`.
   *
   *  WHY THE PIN AND NOT "DOES THIS BOARD HAVE A CHART". A corporation with no market position has no price,
   *  and the reducer's nominal fallback (`SANDBOX_NOMINAL_SHARE_PRICE`) is a figure nobody chose -- so on a
   *  board this engine dealt, a pool trade of a corporation with no token is refused rather than priced at
   *  it (design §7.2 rule 4: "no nominal fallback on a pinned board"). On a LEGACY board it is not, for
   *  D-9's reason: the development corpus and the hand-built fixtures predate the invariant that every
   *  parred corporation has a mark, and refusing there would strand a replay on a rule its game never had.
   *  Unreachable in ordinary play either way -- an unparred corporation's shares are refused one rule
   *  earlier, and a parred one always has a mark (`reconcileParMarks`, #688). */
  pinnedBoard?: boolean;
  /** A last-resort price for a board with no chart at all -- the reducer's `ctx.sharePrice`. Consulted only
   *  where the pin above permits it. */
  nominalPrice?: number;
}

/** The chart context a board carries, read off the state and never off a copy any caller keeps (#1196).
 *
 *  A BOARD WITH NO `market_positions` GETS AN EMPTY CONTEXT, not a context full of nulls: the zone rules stay
 *  unasked and the pool price keeps its nominal fallback, which is exactly what the reducer does today for a
 *  caller with no chart. The par ladder is static board data and is always available. */
export function chartContextFromState(state: GameStateResponse): StockChartContext {
  const positions = state.market_positions;
  /* NO CHART AT ALL IS NOT A PINNED BOARD'S PROBLEM: the pin below decides what a MISSING POSITION means, and
     a board carrying no positions has nothing to be missing from. #757's answer, kept separate from D-9's. */
  if (!positions) return { parCellFor: parBoxCellFor };
  const pinnedBoard = typeof state.rules_engine_version === "number";
  const priceFor = (companyId: number): number | null => positions[companyId]?.price ?? null;
  return {
    parCellFor: parBoxCellFor,
    priceFor,
    pinnedBoard,
    marketZoneFor: (companyId: number) => marketZoneForPrice(priceFor(companyId)),
    zoneForPrice: marketZoneForPrice,
    marketPricesByCompany: Object.fromEntries(
      Object.entries(positions).map(([id, mark]) => [Number(id), mark?.price ?? null]),
    ) as Record<number, number | null>,
  };
}

/* ---- the par ladder ------------------------------------------------------------------------- */

/** Whether `par` is a legal par space on the chart in effect. */
export function isLegalPar(par: number, ctx?: StockChartContext): boolean {
  if (!Number.isFinite(par) || !Number.isInteger(par) || par <= 0) return false;
  return (ctx?.parCellFor ?? parBoxCellFor)(par) !== null;
}

/** The par a message carries, as a number, or `null` when it carries none.
 *
 *  `null` AND `undefined` ARE THE SAME ANSWER HERE and the empty string with them: the wire spells an absent
 *  par all three ways across the corpus. What is NOT folded in is a par that is present and unreadable
 *  ("abc", "1.5", "-67") -- `NaN` and a fraction are refused by `parLadderRefusal` rather than treated as
 *  absent, because "you sent nonsense" and "you sent nothing" are different mistakes. */
export function messagePar(parValue: string | number | null | undefined): number | null {
  if (parValue === null || parValue === undefined) return null;
  if (typeof parValue === "string" && parValue.trim() === "") return null;
  return Number(parValue);
}

/** Why `parValue` is not a par this board can be started at, or `null`.
 *
 *  ONE PREDICATE FOR BOTH PARS -- the president's certificate purchase and the B&O private's free grant. The
 *  B&O pays nothing for its certificate (rulebook p.27) and still may not choose a price the board has no box
 *  for, which is the whole of S8-9's second half. */
export function parLadderRefusal(
  parValue: string | number | null | undefined,
  ctx?: StockChartContext,
  what = "This corporation",
): string | null {
  const par = messagePar(parValue);
  if (par === null) {
    return `${what} cannot be started without a par value — choose one of ${PAR_BOX_PRICES.map((price) => `$${price}`).join(", ")}.`;
  }
  if (!Number.isFinite(par) || !Number.isInteger(par)) {
    return `A par value must be a whole number of dollars — “${String(parValue)}” is not one.`;
  }
  if (!isLegalPar(par, ctx)) {
    return `$${par} is not a par space on this market chart. The par values are ${PAR_BOX_PRICES.map((price) => `$${price}`).join(", ")}.`;
  }
  return null;
}

/* ---- what a purchase is, and what it costs --------------------------------------------------- */

export interface StockPurchaseIntent {
  companyId: number;
  source: "Ipo" | "Bank";
  /** The message's `par_value`. NARRATION on every purchase but the president's (ruled Q4/D-17). */
  parValue?: string | number | null;
  quantity?: number | null;
  certificate?: "double" | string | null;
}

export type StockPurchaseKind = "president" | "double" | "ordinary";

export interface StockPurchasePlan {
  kind: StockPurchaseKind;
  /** Cards taken out of the source. */
  certificates: number;
  /** Percentage taken out of the source. */
  percentage: number;
  /** The authoritative price of ONE ordinary certificate. */
  price: number;
  /** The exact authoritative charge. */
  charged: number;
  /** The validated par this purchase establishes, or `null` when it establishes none. */
  par: number | null;
}

export type StockPurchasePricing =
  | { ok: true; plan: StockPurchasePlan }
  | { ok: false; reason: string };

/** Read a `BuyStock` payload into the intent the rules are written against. */
export function purchaseIntentOf(buy: {
  protocol_id: number;
  source: "Ipo" | "Bank" | string;
  par_value?: string | null;
  quantity?: number | null;
  certificate?: string | null;
}): StockPurchaseIntent {
  return {
    companyId: buy.protocol_id,
    source: buy.source === "Bank" ? "Bank" : "Ipo",
    parValue: buy.par_value ?? null,
    quantity: buy.quantity ?? null,
    certificate: buy.certificate ?? null,
  };
}

/** THE CORPORATION'S STATE DECIDES WHICH PURCHASE THIS IS -- never the message (design §7.2 rule 3).
 *
 *  The president's certificate purchase is the one that STARTS the corporation: bought from the IPO, of a
 *  corporation that has no president and no established par. A corporation with either of those is already
 *  started, and every further IPO purchase is an ordinary one priced from the par it was started at.
 *
 *  `company.par_value === null` IS NOT `message.par_value === null`, and confusing the two is how the $67
 *  fallback got written: the first is a fact about the board, the second is a field a client chose to send. */
export function isPresidentPurchase(
  company: Pick<PublicCompanyState, "president" | "par_value"> | undefined,
  source: "Ipo" | "Bank",
): boolean {
  if (!company || source !== "Ipo") return false;
  return company.president === null && (company.par_value === null || company.par_value === undefined);
}

/** The ordinary certificates a pool can actually hand over, in percent.
 *
 *  TWO CARDS ARE NOT ORDINARY AND ARE SUBTRACTED HERE: the 20% president's certificate, which sits in the IPO
 *  while the presidency is unsold and never reaches the Bank Pool (#448), and the LPF double (#1324), which is
 *  one card of twenty and is bought by naming it. `certificateCardsInPool` makes the same two subtractions for
 *  the display; this is the same reading in the unit the purchase is expressed in. */
export function ordinaryPercentAvailable(
  company: Pick<
    PublicCompanyState,
    "ipo_pool_percentage" | "bank_pool_percentage" | "president" | "double_certificate"
  >,
  source: "Ipo" | "Bank",
): number {
  const total = source === "Bank" ? company.bank_pool_percentage : company.ipo_pool_percentage;
  const president = source === "Ipo" && company.president === null ? PRESIDENT_SHARE_PERCENT : 0;
  const double = doubleCertificateAt(company) === source ? DOUBLE_CERTIFICATE_PERCENT : 0;
  return Math.max(0, (Number.isFinite(total) ? total : 0) - president - double);
}

const sourceName = (source: "Ipo" | "Bank"): string => (source === "Bank" ? "Bank Pool" : "IPO");

/** The one price for this purchase, or the sentence that says why it has none.
 *
 *  THE PRICE IS A FACT ABOUT THE BOARD, and that is the whole of ruling Q4/D-17. An IPO share costs the par
 *  the corporation was STARTED at; a pool share costs what the token stands on. The message's `par_value`
 *  reaches the price in exactly one case -- the purchase that sets the par -- and there it is validated
 *  against the chart's own ladder before a cent moves.
 *
 *  `nominalPrice` IS THE BOARD-WITHOUT-A-CHART CASE ONLY. On a board that carries `market_positions` a pool
 *  purchase of a corporation with no token is refused, not priced at the nominal: a chart that has a position
 *  for every other corporation and none for this one is saying something, and "$67 then" is not a reading of
 *  it (design §7.2 rule 4). */
export function priceStockPurchase(
  state: GameStateResponse,
  buy: StockPurchaseIntent,
  ctx?: StockChartContext,
): StockPurchasePricing {
  const company = state.public_companies.find((entry) => entry.company_id === buy.companyId);
  if (!company) return { ok: false, reason: "That corporation is not in this game." };

  const wantsDouble = buy.certificate === "double";
  const president = isPresidentPurchase(company, buy.source);

  /* ---- the president's certificate: the message's par, validated, and twice it ---------------- */
  if (president) {
    if (wantsDouble) {
      return {
        ok: false,
        reason: `${company.ticker}'s President's Certificate is the 20% card that starts the corporation — it is not the standard 20% certificate and cannot be bought as one.`,
      };
    }
    const asked = buy.quantity ?? null;
    if (asked !== null && Number(asked) !== 1) {
      return {
        ok: false,
        reason: `There is one President's Certificate — ${company.ticker} cannot be started with ${Number(asked)}.`,
      };
    }
    const ladder = parLadderRefusal(buy.parValue, ctx, company.ticker);
    if (ladder !== null) return { ok: false, reason: ladder };
    const par = messagePar(buy.parValue) as number;
    if (company.ipo_pool_percentage < PRESIDENT_SHARE_PERCENT) {
      return {
        ok: false,
        reason: `${company.ticker}'s initial offering holds only ${company.ipo_pool_percentage}%, which is less than the ${PRESIDENT_SHARE_PERCENT}% President's Certificate.`,
      };
    }
    return {
      ok: true,
      plan: {
        kind: "president",
        certificates: 1,
        percentage: PRESIDENT_SHARE_PERCENT,
        price: par,
        charged: par * 2,
        par,
      },
    };
  }

  /* ---- every other purchase: the price is on the board ---------------------------------------- */
  let price: number;
  if (buy.source === "Ipo") {
    const stored = company.par_value === null || company.par_value === undefined ? null : Number(company.par_value);
    if (stored === null || !Number.isFinite(stored) || stored <= 0) {
      /* A corporation with a president and no par is a board no rule was written against; an IPO purchase of
         one cannot be priced, and the $67 fallback that used to price it is exactly what ruling Q4 removed. */
      return {
        ok: false,
        reason: `${company.ticker} has not been started yet — its President's Certificate must be bought, at a par value, before any other share of it can be.`,
      };
    }
    price = stored;
  } else {
    const onChart = ctx?.priceFor?.(buy.companyId) ?? null;
    if (onChart !== null && Number.isFinite(onChart) && onChart > 0) {
      price = onChart;
    } else if (ctx?.pinnedBoard === true) {
      return {
        ok: false,
        reason: `${company.ticker} has no price on the market chart, so a Bank Pool share of it cannot be priced.`,
      };
    } else {
      /* #757/D-9: a legacy board has no opinion about the price, and the reducer's own nominal is what it has
         always charged there. Never reached on a board this engine dealt. */
      price = ctx?.nominalPrice ?? 0;
      if (!Number.isFinite(price) || price <= 0) {
        return { ok: false, reason: `${company.ticker} has no price, so a Bank Pool share of it cannot be priced.` };
      }
    }
  }

  if (wantsDouble) {
    return {
      ok: true,
      plan: {
        kind: "double",
        certificates: 1,
        percentage: DOUBLE_CERTIFICATE_PERCENT,
        price,
        charged: price * 2,
        par: null,
      },
    };
  }

  /* ABSENT MEANS ONE, which is what every message written before `quantity` existed meant and must keep
     meaning on replay (#712). What is NOT tolerated any more is a request the source cannot fill: the old arm
     capped the certificates and charged for the request (m9), so this returns the number ASKED and the
     availability rule below refuses outright (ruled Q13/D-25). */
  const requested = Math.max(1, Math.floor(Number(buy.quantity ?? 1) || 1));
  return {
    ok: true,
    plan: {
      kind: "ordinary",
      certificates: requested,
      percentage: requested * SHARE_PERCENT,
      price,
      charged: price * requested,
      par: null,
    },
  };
}

/* ---- the purchase predicate ------------------------------------------------------------------ */

export interface StockPurchaseRefusalInput {
  state: GameStateResponse;
  buy: StockPurchaseIntent;
  /** The buyer. `null` is a positive state (solo play, an attribution-less fixture) and skips the rules that
   *  are about a PLAYER -- affordability and the holdings caps -- exactly as the reducer's arms do. */
  actor: string | null | undefined;
  ctx?: StockChartContext;
}

/** Why this stock purchase is illegal, or `null`.
 *
 *  THE ORDER IS THE DESIGN'S (§7.2) AND IT IS LOAD-BEARING: the round first, because a purchase in the wrong
 *  round is not a purchase whose price is worth discussing; the corporation's own state next, because it
 *  decides which KIND of purchase this is; then the price, the physical card, the standing holdings rules and
 *  the money. A player refused at the last of these has learnt something playable; a player refused at the
 *  first has learnt the only thing that matters. */
export function stockPurchaseRefusal(input: StockPurchaseRefusalInput): string | null {
  const { state, buy, actor, ctx } = input;

  /* ---- 1. A stock purchase is a Stock Round action (rulebook §5.0, S7-13) --------------------- */
  if (state.current_round_type !== "StockRound") {
    return state.current_round_type === "WaterfallAuction"
      ? "Shares cannot be bought during the private company auction — the Stock Round opens when the auction is over."
      : "Shares can only be bought during a Stock Round.";
  }

  /* ---- 2. The corporation, and the cards that are not ordinary cards -------------------------- */
  const company = state.public_companies.find((entry) => entry.company_id === buy.companyId);
  if (!company) return "That corporation is not in this game.";
  if (buy.certificate === "double") {
    const refusal = doublePurchaseRefusal(company, buy.source);
    if (refusal !== null) return refusal;
  }

  /* ---- 3 & 4. Which purchase this is, and what it costs (§7.2 rules 3-4) ---------------------- */
  const pricing = priceStockPurchase(state, buy, ctx);
  if (!pricing.ok) return pricing.reason;
  const plan = pricing.plan;

  /* ---- 5. The card has to be in the source (m9, ruled Q13/D-25) ------------------------------- */
  if (plan.kind === "ordinary") {
    const available = ordinaryPercentAvailable(company, buy.source);
    if (available < plan.percentage) {
      const where = sourceName(buy.source);
      return available <= 0
        ? `The ${where} holds no ordinary ${company.ticker} certificate to sell.`
        : `The ${where} holds ${available}% of ${company.ticker} — not the ${plan.percentage}% asked for.`;
    }
  }

  /* ---- 6. The standing ownership rules, unchanged and NOT forked (§7.2 rule 6) ----------------
     `sharePurchaseBlock` owns the 60% cap and its Orange/Brown waivers, the certificate limit and its zone
     exemptions, the divestment debt, the sold-this-round lockout, the one-purchase-per-turn rule and its
     Brown Bank-Pool allowance, and the double's placement. Asked with the ZONE, and only when a zone is
     available: #712's "omitted means unenforced" is preserved to the letter, so a fixture with no chart keeps
     the behaviour it was written against. */
  if (actor && ctx?.marketZoneFor) {
    const blocked = sharePurchaseBlock({
      state,
      buyer: actor,
      companyId: buy.companyId,
      source: buy.source,
      quantity: plan.kind === "ordinary" ? plan.certificates : 1,
      zone: ctx.marketZoneFor(buy.companyId),
      marketPrices: ctx.marketPricesByCompany ?? null,
      zoneForPrice: ctx.zoneForPrice,
      certificate: plan.kind === "double" ? "double" : undefined,
      boughtThisTurn: state.bought_this_turn ?? 0,
    });
    if (blocked !== null) return blocked;
  }

  /* ---- 7. The Brown continuation names the corporation of the first purchase (Q9 / D-22) ------
     Rulebook §4.4: "any number of certificates from the bank pool of ONE corporation". The allowance is
     represented as a second message (the representation is preserved for replay), so the same-corporation
     half of the printed rule has to be state: `bought_this_turn_company`, written by the first purchase of
     the turn and cleared wherever `bought_this_turn` is.
     ABSENT IS "NOT SAID" (#232), never "any corporation": a board mid-turn from a log written before this
     field existed gets no opinion here, which is what keeps a legacy replay replaying. */
  const openedWith = state.bought_this_turn_company;
  if ((state.bought_this_turn ?? 0) > 0 && openedWith !== undefined && openedWith !== buy.companyId) {
    const first = state.public_companies.find((entry) => entry.company_id === openedWith);
    return `You have already bought ${first?.ticker ?? "another corporation"} this turn. The Brown-zone Bank Pool allowance is several certificates of ONE corporation, so it cannot be continued with ${company.ticker}.`;
  }

  /* ---- 8. And the buyer has to be able to pay the exact figure (§6.1, C3) --------------------- */
  if (actor) {
    const cash = playerCashOf(state, actor);
    if (cash === null || cash < plan.charged) {
      const holding = cash === null ? "no readable cash" : `$${cash}`;
      return plan.kind === "president"
        ? `Starting ${company.ticker} at $${plan.par} costs twice its par — $${plan.charged} — and you hold ${holding}.`
        : `That purchase costs $${plan.charged} and you hold ${holding}.`;
    }
  }

  return null;
}

/* ---- the sale predicate ---------------------------------------------------------------------- */

export interface StockSaleIntent {
  companyId: number;
  percentage: number;
}

export interface StockSaleRefusalInput {
  state: GameStateResponse;
  sell: StockSaleIntent;
  actor: string | null | undefined;
  /** #1540: the grid the forced-sale obligation is derived with. Absent, no forced sale is recognised, which
   *  is #757's answer and the one the reducer's own gates give. */
  mapGrid?: MapGridResponse;
  ctx?: StockChartContext;
}

/** Whether this is the FIRST Stock Round -- the one §5.1 forbids sales in.
 *
 *  `macro_round_number === 1` IS THE WHOLE TEST, in both variants, and the Delayed Auction is why it is worth
 *  a function rather than a comparison inline. Standard: the auction is macro round 1 and `OpenStockRound`
 *  leaves the number where it is, so SR1 is macro round 1. Delayed: the deal opens ON Stock Round 1 with the
 *  same number, the auction is inserted later as its own round and takes the next number with it, so the
 *  Stock Round that follows it (SR3) is macro round 3 and sales are allowed there. One reading, both boards. */
export function isFirstStockRound(state: GameStateResponse): boolean {
  return state.current_round_type === "StockRound" && (state.macro_round_number ?? 0) === 1;
}

/** Why this sale is illegal, or `null`. */
export function stockSaleRefusal(input: StockSaleRefusalInput): string | null {
  const { state, sell, actor, mapGrid, ctx } = input;

  /* ---- 1. The round: a Stock Round, or the §6.6.3 forced sale (Batch 5, preserved) ------------ */
  const funding = state.current_round_type === "OperatingRound" ? emergencyFundingFor(state, mapGrid) : null;
  const forced = funding !== null && actor != null && funding.president === actor;
  if (state.current_round_type !== "StockRound" && !forced) {
    return state.current_round_type === "OperatingRound"
      ? "Shares can only be sold during a Stock Round — the one exception is a president selling to fund a train his corporation must buy."
      : "Shares can only be sold during a Stock Round.";
  }

  const company = state.public_companies.find((entry) => entry.company_id === sell.companyId);
  if (!company) return "That corporation is not in this game.";

  /* ---- 2. A bundle is whole certificates (S7-16) ---------------------------------------------- */
  const percentage = sell.percentage;
  if (
    !Number.isFinite(percentage) ||
    !Number.isInteger(percentage) ||
    percentage <= 0 ||
    percentage % SHARE_PERCENT !== 0
  ) {
    return `Shares are sold in whole ${SHARE_PERCENT}% certificates — ${String(percentage)}% is not a bundle that exists.`;
  }

  /* ---- 3. No selling in the first Stock Round (rulebook §5.1, S8-7) --------------------------- */
  if (!forced && isFirstStockRound(state)) {
    return "Certificates may not be sold in the first Stock Round.";
  }

  /* ---- 4. A share of a corporation that has not been started cannot be sold ------------------
     Rulebook p.15, for the C&A's and the M&H's granted shares: they "cannot be sold until the president's
     certificate has been purchased". Written as the board fact rather than as a private-company special case
     (S8-8) -- an unparred corporation has no price, so there is nothing a sale could be settled at, and that
     is true of every share of it however it was come by. */
  if (company.par_value === null || company.par_value === undefined) {
    return `${company.ticker} has not been started yet — a share of it cannot be sold until its President's Certificate has been bought and its par set.`;
  }

  /* ---- 5. The proceeds come from the chart, never from a nominal (§7.2 sale rule 5) ----------- */
  if (ctx?.pinnedBoard === true) {
    const price = ctx.priceFor?.(sell.companyId) ?? null;
    if (price === null || !Number.isFinite(price) || price <= 0) {
      return `${company.ticker} has no price on the market chart, so a sale of it cannot be settled.`;
    }
  }

  /* ---- 6. The standing sale rules, unchanged and NOT forked ----------------------------------- */
  if (actor) {
    const blocked = shareSaleBlock({ state, seller: actor, companyId: sell.companyId, percentage });
    if (blocked !== null) return blocked;
    const double = doubleSaleEffect(company, actor, percentage);
    if (double.kind === "refused") return double.reason;
    /* #1540/D-6: the forced sale's own three rules, on top of the ordinary ones and never instead of them. */
    if (forced && funding !== null) {
      const refusal = forcedSaleRefusal(state, funding, actor, sell.companyId, percentage);
      if (refusal !== null) return refusal;
    }
  }

  return null;
}
