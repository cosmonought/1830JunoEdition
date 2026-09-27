import { certificateBreakdown, type GameStateResponse, type PublicCompanyState } from "./gameState";
import { PLAYER_HOLDING_CAP_PERCENT } from "./privateExchange";
import { SHARE_BLOCK_PERCENT } from "./endgame";
// DA-5 (curable excess): the sale rules are asked, not restated -- the same three predicates `stockSaleRefusal` asks.
import { shareSaleBlock } from "./shareSale";
import { certificateCardsHeld, doubleSaleEffect } from "./doubleCertificate";
import { presidentAfterSale } from "./presidencyTransfer";
import { marketZoneForPrice } from "./marketGeometry";
// DA-6 (DA-F8, the must-sell sentence): which causes this table can have -- the Delayed Auction adds one.
import { resolveVariants } from "./gameVariants";

/* ==================================================================
 *  DESIGN NOTE 759: WHAT HAPPENS WHEN THE EXEMPTION GOES AWAY
 * ==================================================================
 *
 * REPORTED: "I don't think we have encoded rules for what a player must do when they purchased
 * Yellow/Orange/Brown zone stocks and exceeded their certificate and/or corporation limits and then those
 * corporation share prices move out of those zones. Here are the rules: i) a player retains their shares
 * until the next Stock Round (even if the share price moved out of the zone as a result of the 'move up'
 * action that happens at the very end of a stock round), ii) if the game ends before the next Stock Round,
 * they keep the shares and all are calculated as part of their net worth, iii) if the game has another stock
 * round, they MUST sell down to the corporation and/or certificate limit (so they should not be able to buy
 * shares OR skip/pass/auto-pass their turn until these sales have been made)."
 *
 * THE EXEMPTIONS WERE BUILT AND THEIR EXPIRY WAS NOT. #7 gave the certificate limit its zone exemption and
 * #712 gave the 60% cap its Orange/Brown waiver, and both are correct about the moment of PURCHASE. Neither
 * has any notion of the position afterwards -- a zone is "a MARKET-POSITION rule, not an ownership one: the
 * same certificate counts today and stops counting tomorrow if the price moves, with nothing about the
 * certificate changing" (#7's own words). That sentence describes an obligation and stops one clause short of
 * saying who owes it.
 *
 * THE WHOLE RULE IS ABOUT TIMING, so that is what this module is shaped around.
 *
 * (i) RETENTION IS FREE, AND IT IS THE DEFAULT HERE rather than a rule to enforce: nothing asks this question
 *     outside a Stock Round, so a price that climbs out of the yellow zone during an Operating Round costs the
 *     holder nothing until the next Stock Round opens. The parenthetical about the end-of-round rise (#746)
 *     falls out for free -- that rise happens as the Stock Round CLOSES, so the obligation it creates belongs
 *     to the round after, which is the one that has not started yet.
 *
 * (ii) GAME END KEEPS THE SHARES, and again by not doing anything: `rankPlayers` values every certificate a
 *     player holds and never consults this module. Worth stating explicitly because "must sell down" invites
 *     a reader to add a liquidation to the endgame path, and that would be wrong -- a game that ends before
 *     the next Stock Round ends with those shares owned and scored.
 *
 * (iii) IS THE ONLY PART THAT NEEDS CODE, and it is a debt with three doors to hold shut: no buying, no
 *     passing, no auto-passing. The debt is recomputed from the board rather than stamped on state when a
 *     round opens, which is what makes it self-clearing -- each sale shrinks it, and the doors open the
 *     moment it reaches zero without anything needing to notice.
 *
 * TWO SEPARATE DEBTS, NOT ONE. A player can be over the certificate limit, over 60% in a corporation, or
 * both, and the sales that discharge them are not interchangeable: selling a 10% of a corporation you hold
 * 70% of fixes the second and the first, while selling your only share of some other corporation fixes the
 * first alone. So the module reports both and the message names both.
 */

export interface DivestmentDebt {
  /** Certificates over the limit, or 0. */
  certificatesOver: number;
  /** The limit itself, for the message. `null` where the player count is off the table. */
  certificateLimit: number | null;
  counted: number;
  /** Corporations held above 60% whose price no longer waives it. DA-5: only those where a legal sale can cure
   *  some of it, and `mustSellPercent` says how much can -- the part the player owes. */
  overCapCompanies: readonly { companyId: number; ticker: string; percentage: number; mustSellPercent?: number }[];
  /** Anything owed at all. */
  owed: boolean;
  /** DA-6: this table plays the Delayed Auction, whose acquisitions can put a player over a limit (D-53, D-57, D-58)
   *  -- so the sentence cannot blame a zone exit alone. Absent reads as `false`: the standard game's causes. */
  delayedAuction?: boolean;
}

export interface DivestmentInput {
  state: GameStateResponse;
  player: string;
  marketPrices: Readonly<Record<number, number | null>> | null | undefined;
  /** `marketZoneForPrice`, injected -- the zone table lives in `components/` (#7). */
  zoneForPrice: ((price: number | null | undefined) => string | null) | undefined;
}

/** Whether this zone still waives the 60% holding cap. Orange and Brown only -- #712's rule, restated here
 *  rather than imported because `sharePurchase`'s version is about a PURCHASE and this is about a position. */
function capWaived(zone: string | null): boolean {
  return zone === "Orange" || zone === "Brown";
}

/* ==================================================================
    DA-5 (D-53, D-57, D-58, D-59): ONLY A CURABLE EXCESS IS OWED
   ==================================================================
   OWNER RULINGS (Delayed Auction, 2026-09-25): a mandatory acquisition -- the forced $0 SV, the C&A's PRR share,
   an award from a bid that was legal when placed -- may put a player over the certificate limit or a 60% cap, and
   "the must-sell obligation applies only to excess that can actually be cured by legal sales"; "the player may not
   make an ordinary stock purchase while any curable excess remains"; "an excess that cannot legally be cured does
   not deadlock the game".

   #759'S DEBT WAS THE WHOLE EXCESS, and it has three doors -- no buying (`sharePurchaseBlock`, both locks), no
   passing (now both locks too, `divestmentPassRefusal`), no auto-passing. With nothing the player can legally
   sell, every door stays shut and the game stops. Classic reaches that too: a zone-exit debt in a corporation
   whose Bank Pool already holds five certificates.

   SO THE DEBT IS NOW THE CURABLE PART, judged by the SALE RULES THEMSELVES -- the ones `stockSaleRefusal` asks:
   a Stock Round other than the first (§5.1), a started corporation (p.15, S8-8), a chart price on a pinned board
   (§7.2 rule 5), `shareSaleBlock` (the Bank Pool's five cards, the President's Certificate) and the double's
   half-sale (`doubleSaleEffect`). For each corporation the largest legal sale is found; a 60% excess is curable
   up to what that sale removes, and a certificate excess up to the cards all of them together remove. Judged AT
   THE PRICES ON THE BOARD: a sale's own drop in price, which can carry a corporation into an exempt zone, is not
   credited in advance -- the debt is re-read after every real sale, so it is credited the moment it happens.
   The part no legal sale can reach is incurable: it is reported (`assessExcess`) and owes nothing. */

/** A player's position against the certificate limit and the 60% cap, and how much of each excess legal
 *  sales could cure at the prices on the board. PURE; the board may be hypothetical (the auction's
 *  acquisition check asks it of the Stock Round that would follow). */
export interface ExcessAssessment {
  certificateLimit: number | null;
  counted: number;
  /** `counted - limit`, or 0. */
  certificatesOver: number;
  /** How much of `certificatesOver` legal sales could remove. */
  curableCertificates: number;
  /** Every corporation held above 60% whose price does not waive it. */
  overCap: readonly {
    companyId: number;
    ticker: string;
    percentage: number;
    /** `percentage - 60`. */
    excessPercent: number;
    /** How much of `excessPercent` legal sales could remove. */
    curablePercent: number;
  }[];
}

/** Whether sales are open on this board at all: a Stock Round other than the first (§5.1). The same reading as
 *  `stockTransactionAuthority.isFirstStockRound`, restated because that module imports this one. */
function salesOpen(state: GameStateResponse): boolean {
  return state.current_round_type === "StockRound" && (state.macro_round_number ?? 0) !== 1;
}

function heldBy(company: Pick<PublicCompanyState, "player_holdings">, player: string): number {
  return company.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
}

/** Whether `player` may sell `percentage` of this corporation now -- the sale rules, asked. */
function saleLegal(state: GameStateResponse, company: PublicCompanyState, player: string, percentage: number): boolean {
  if (!salesOpen(state)) return false;
  if (company.par_value === null || company.par_value === undefined) return false;
  const pinned = typeof state.rules_engine_version === "number";
  if (pinned && state.market_positions && !(Number(state.market_positions[company.company_id]?.price) > 0)) {
    return false;
  }
  if (shareSaleBlock({ state, seller: player, companyId: company.company_id, percentage }) !== null) return false;
  return doubleSaleEffect(company, player, percentage).kind !== "refused";
}

/** The cards `player` still holds of this corporation after selling `percentage` of it: the crown settled by the
 *  canonical selector (`presidentAfterSale`), the double gone to the pool when the sale reached it. */
function cardsAfterSale(
  state: GameStateResponse,
  company: PublicCompanyState,
  player: string,
  percentage: number,
): number {
  const remaining = heldBy(company, player) - percentage;
  const effect = doubleSaleEffect(company, player, percentage);
  const after: PublicCompanyState = {
    ...company,
    president: presidentAfterSale(company, player, percentage, state.player_addresses ?? []) ?? company.president,
    player_holdings: company.player_holdings
      .map((entry) => (entry.player === player ? { ...entry, percentage: remaining } : entry))
      .filter((entry) => entry.percentage > 0),
    bank_pool_percentage: company.bank_pool_percentage + percentage,
    ...(effect.kind === "block" || effect.kind === "half" ? { double_certificate: { at: "Bank" } } : {}),
  };
  return remaining > 0 ? certificateCardsHeld(after, player) : 0;
}

/** DA-5: the player's excess over the certificate limit and the 60% cap, and the part of each legal sales cure. */
export function assessExcess(input: DivestmentInput): ExcessAssessment {
  const { state, player, marketPrices, zoneForPrice } = input;
  const breakdown = certificateBreakdown(player, state, marketPrices, zoneForPrice as never);
  const certificatesOver = breakdown.limit === null ? 0 : Math.max(0, breakdown.counted - breakdown.limit);
  const zoneOf = (companyId: number) => (zoneForPrice ? zoneForPrice(marketPrices?.[companyId]) : null);
  const exempt = (zone: string | null) => zone === "Yellow" || zone === "Orange" || zone === "Brown";

  let removableCards = 0;
  const overCap: Array<ExcessAssessment["overCap"][number]> = [];
  for (const company of state.public_companies) {
    const held = heldBy(company, player);
    if (held <= 0) continue;
    const zone = zoneOf(company.company_id);
    /* The largest legal sale, and the most cards any legal sale removes. Every bundle is asked: legality is not
       monotonic in size at the President's Certificate or the double. */
    let largestSale = 0;
    let mostCards = 0;
    const cardsNow = certificateCardsHeld(company, player);
    for (let percentage = SHARE_BLOCK_PERCENT; percentage <= held; percentage += SHARE_BLOCK_PERCENT) {
      if (!saleLegal(state, company, player, percentage)) continue;
      largestSale = percentage;
      mostCards = Math.max(mostCards, cardsNow - cardsAfterSale(state, company, player, percentage));
    }
    if (!exempt(zone)) removableCards += mostCards;
    if (held > PLAYER_HOLDING_CAP_PERCENT && !capWaived(zone)) {
      const excessPercent = held - PLAYER_HOLDING_CAP_PERCENT;
      overCap.push({
        companyId: company.company_id,
        ticker: company.ticker,
        percentage: held,
        excessPercent,
        curablePercent: Math.min(excessPercent, largestSale),
      });
    }
  }

  return {
    certificateLimit: breakdown.limit,
    counted: breakdown.counted,
    certificatesOver,
    curableCertificates: Math.min(certificatesOver, removableCards),
    overCap,
  };
}

/** The part of an excess no legal sale can reach: certificates over the limit, and percentage points over the
 *  cap, summed across corporations. D-57/D-58's measure of an acquisition that must not be made voluntarily. */
export function incurableExcess(assessment: ExcessAssessment): { certificates: number; capPercent: number } {
  return {
    certificates: assessment.certificatesOver - assessment.curableCertificates,
    capPercent: assessment.overCap.reduce((sum, entry) => sum + (entry.excessPercent - entry.curablePercent), 0),
  };
}

/** What this player must sell before they may do anything else in a Stock Round.
 *
 *  RETURNS AN EMPTY DEBT OUTSIDE A STOCK ROUND, which is rule (i) and rule (ii) both. The caller does not
 *  have to remember to ask only at the right time, because asking at the wrong time answers "nothing owed".
 *  DA-5: AND ONLY THE CURABLE PART IS OWED -- see the note above `ExcessAssessment`. */
export function divestmentDebt(input: DivestmentInput): DivestmentDebt {
  const { state } = input;
  const empty: DivestmentDebt = {
    certificatesOver: 0,
    certificateLimit: null,
    counted: 0,
    overCapCompanies: [],
    owed: false,
  };

  if (state.current_round_type !== "StockRound") return empty;

  const assessment = assessExcess(input);
  const overCapCompanies = assessment.overCap
    .filter((entry) => entry.curablePercent > 0)
    .map((entry) => ({
      companyId: entry.companyId,
      ticker: entry.ticker,
      percentage: entry.percentage,
      mustSellPercent: entry.curablePercent,
    }));

  return {
    certificatesOver: assessment.curableCertificates,
    certificateLimit: assessment.certificateLimit,
    counted: assessment.counted,
    overCapCompanies,
    owed: assessment.curableCertificates > 0 || overCapCompanies.length > 0,
    delayedAuction: resolveVariants(state.variants).delayedAuction === true,
  };
}

/** The chart a board carries, in the shape `divestmentDebt` takes: its market positions' prices and the chart's own
 *  zone table -- the same reading the room's providers inject (`replayProviders.chartInjections`) and
 *  `chartContextFromState` gives the stock authority. A board with no positions has no zones: everything counts,
 *  #7's conservative answer. */
export function chartForDivestment(
  state: GameStateResponse,
): Pick<DivestmentInput, "marketPrices" | "zoneForPrice"> {
  const positions = state.market_positions;
  if (!positions) return { marketPrices: null, zoneForPrice: undefined };
  return {
    marketPrices: Object.fromEntries(
      Object.entries(positions).map(([id, mark]) => [Number(id), mark?.price ?? null]),
    ) as Record<number, number | null>,
    zoneForPrice: marketZoneForPrice,
  };
}

/** DA-5 (D-53, D-58): why the Stock Round seat may not pass or end the turn yet, or `null` -- #759's rule (iii),
 *  "they should not be able to buy shares OR skip/pass/auto-pass their turn until these sales have been made",
 *  which only the shell's button and auto-pass enforced. Asked by BOTH locks now (`turnRefusal`, and the reducer's
 *  core gate beside the stock transaction predicates), and only for the CURABLE excess, so a player no legal sale
 *  can bring under the limit is never held. */
export function divestmentPassRefusal(state: GameStateResponse): string | null {
  if (state.current_round_type !== "StockRound") return null;
  const player = state.player_addresses?.[state.active_player_index];
  if (!player) return null;
  return divestmentRefusal(divestmentDebt({ state, player, ...chartForDivestment(state) }));
}

/** Why this player may not buy, pass or auto-pass yet, or `null`.
 *
 *  A REASON RATHER THAN A BOOLEAN (#619), and it names BOTH debts when both exist -- a player told only about
 *  the certificate limit would sell the wrong shares and still be stuck. */
/* ==================================================================
    DA-6 (DA-F8; D-53, D-57, D-58): THE MUST-SELL SENTENCE SAYS WHAT IS TRUE AT THIS TABLE
   ==================================================================
   #759 NAMED THE CAUSE -- "Those shares left the Yellow/Orange/Brown zones" -- because in the standard game a
   price leaving a zone is how a legal holding becomes an illegal one between rounds, and "you are over the limit"
   alone reads as an accusation. UNDER THE DELAYED AUCTION IT IS NOT THE ONLY CAUSE, and after the auction it is
   usually the wrong one: a private won at the auction counts as a certificate, and it can bring the C&A's PRR share
   or the B&O President's Certificate with it (D-53, D-57), so the next Stock Round can open with a player over the
   limit or a 60% cap who never saw a price move. DA-5 recorded the sentence as wrong for an auction overage; this is
   that correction. The Delayed Auction's sentence names both causes and states the rule as ruled: only what a legal
   sale can fix is owed, and it is owed before a purchase or a pass (D-58).
   AND THE FIGURES ARE THE EXCESS, WITH THE OWED PART BESIDE IT. DA-5 made the debt the CURABLE part (in every game
   -- its standard-game effect (1)), and this sentence then printed that part as the amount "over", which
   understated the position whenever some of it was incurable. The excess is now printed as it stands, and the part
   a sale can fix is named only when it is smaller -- so every fully-curable debt, which is every standard debt
   before DA-5, reads exactly as it always did. */
export function divestmentRefusal(debt: DivestmentDebt): string | null {
  if (!debt.owed) return null;

  const parts: string[] = [];
  if (debt.certificatesOver > 0) {
    const over =
      debt.certificateLimit === null
        ? debt.certificatesOver
        : Math.max(debt.certificatesOver, debt.counted - debt.certificateLimit);
    parts.push(
      `${over} certificate${over === 1 ? "" : "s"} over the limit of ${debt.certificateLimit}` +
        (over > debt.certificatesOver ? ` (${debt.certificatesOver} of them can be sold now)` : ""),
    );
  }
  for (const company of debt.overCapCompanies) {
    const excess = company.percentage - PLAYER_HOLDING_CAP_PERCENT;
    const owed = company.mustSellPercent ?? excess;
    parts.push(
      `${excess}% over the ${PLAYER_HOLDING_CAP_PERCENT}% cap in ${company.ticker} ` +
        `(${company.percentage}% held${owed < excess ? `; ${owed}% of it can be sold now` : ""})`,
    );
  }

  if (debt.delayedAuction === true) return delayedAuctionDivestmentSentence(parts.join(" and "));

  /* THE CAUSE IS NAMED, because this arrives without the player doing anything -- a price moved while they
     were not looking and a holding that was legal all game became illegal between rounds. "You are over the
     limit" would read as an accusation about a purchase they were allowed to make. */
  return (
    `Those shares left the Yellow/Orange/Brown zones, so they now count: you are ` +
    `${parts.join(" and ")}. Sell down before buying or passing.`
  );
}

/** DA-6 (D-53, D-57, D-58): the Delayed Auction's must-sell sentence -- both causes, and the curable-only rule. */
export function delayedAuctionDivestmentSentence(position: string): string {
  return (
    `You are ${position}. At this table a private company won in the delayed auction (with any share it brings) ` +
    `counts toward your limits, as does a price leaving the Yellow/Orange/Brown zones — sell what a legal sale can ` +
    `fix before buying or passing.`
  );
}

/** DA-6: the auto-pass wake reason for a debt -- the same two readings, in the shorter form the wake line uses. */
export function divestmentWakeReason(delayedAuction: boolean): string {
  return delayedAuction
    ? "You are over a holding limit — a private company won in the delayed auction, the share it brought, or a price leaving the Yellow/Orange/Brown zones — and you must sell down before passing."
    : "Shares of yours left the Yellow/Orange/Brown zones and now count against your limits — you must sell down before passing.";
}

/** The fewest certificates that would clear the debt -- for the panel's caption, not for enforcement.
 *
 *  A FLOOR, NOT AN INSTRUCTION. Which shares to sell is the player's decision and the two debts overlap in
 *  ways only they can weigh, so this says how far there is to go rather than what to do. */
export function minimumCertificatesToSell(debt: DivestmentDebt): number {
  const fromCap = debt.overCapCompanies.reduce(
    (most, company) =>
      Math.max(
        most,
        Math.ceil((company.mustSellPercent ?? company.percentage - PLAYER_HOLDING_CAP_PERCENT) / SHARE_BLOCK_PERCENT),
      ),
    0,
  );
  return Math.max(debt.certificatesOver, fromCap);
}
