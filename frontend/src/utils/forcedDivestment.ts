import { certificateBreakdown, type GameStateResponse } from "./gameState";
import { PLAYER_HOLDING_CAP_PERCENT } from "./privateExchange";
import { SHARE_BLOCK_PERCENT } from "./endgame";

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
  /** Corporations held above 60% whose price no longer waives it. */
  overCapCompanies: readonly { companyId: number; ticker: string; percentage: number }[];
  /** Anything owed at all. */
  owed: boolean;
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

/** What this player must sell before they may do anything else in a Stock Round.
 *
 *  RETURNS AN EMPTY DEBT OUTSIDE A STOCK ROUND, which is rule (i) and rule (ii) both. The caller does not
 *  have to remember to ask only at the right time, because asking at the wrong time answers "nothing owed". */
export function divestmentDebt(input: DivestmentInput): DivestmentDebt {
  const { state, player, marketPrices, zoneForPrice } = input;
  const empty: DivestmentDebt = {
    certificatesOver: 0,
    certificateLimit: null,
    counted: 0,
    overCapCompanies: [],
    owed: false,
  };

  if (state.current_round_type !== "StockRound") return empty;

  const breakdown = certificateBreakdown(player, state, marketPrices, zoneForPrice as never);
  const certificatesOver =
    breakdown.limit === null ? 0 : Math.max(0, breakdown.counted - breakdown.limit);

  const overCapCompanies = state.public_companies
    .filter((company) => {
      const held =
        company.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
      if (held <= PLAYER_HOLDING_CAP_PERCENT) return false;
      const zone = zoneForPrice ? zoneForPrice(marketPrices?.[company.company_id]) : null;
      return !capWaived(zone);
    })
    .map((company) => ({
      companyId: company.company_id,
      ticker: company.ticker,
      percentage:
        company.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0,
    }));

  return {
    certificatesOver,
    certificateLimit: breakdown.limit,
    counted: breakdown.counted,
    overCapCompanies,
    owed: certificatesOver > 0 || overCapCompanies.length > 0,
  };
}

/** Why this player may not buy, pass or auto-pass yet, or `null`.
 *
 *  A REASON RATHER THAN A BOOLEAN (#619), and it names BOTH debts when both exist -- a player told only about
 *  the certificate limit would sell the wrong shares and still be stuck. */
export function divestmentRefusal(debt: DivestmentDebt): string | null {
  if (!debt.owed) return null;

  const parts: string[] = [];
  if (debt.certificatesOver > 0) {
    parts.push(
      `${debt.certificatesOver} certificate${debt.certificatesOver === 1 ? "" : "s"} over the ` +
        `limit of ${debt.certificateLimit}`,
    );
  }
  for (const company of debt.overCapCompanies) {
    const excess = company.percentage - PLAYER_HOLDING_CAP_PERCENT;
    parts.push(
      `${excess}% over the ${PLAYER_HOLDING_CAP_PERCENT}% cap in ${company.ticker} ` +
        `(${company.percentage}% held)`,
    );
  }

  /* THE CAUSE IS NAMED, because this arrives without the player doing anything -- a price moved while they
     were not looking and a holding that was legal all game became illegal between rounds. "You are over the
     limit" would read as an accusation about a purchase they were allowed to make. */
  return (
    `Those shares left the Yellow/Orange/Brown zones, so they now count: you are ` +
    `${parts.join(" and ")}. Sell down before buying or passing.`
  );
}

/** The fewest certificates that would clear the debt -- for the panel's caption, not for enforcement.
 *
 *  A FLOOR, NOT AN INSTRUCTION. Which shares to sell is the player's decision and the two debts overlap in
 *  ways only they can weigh, so this says how far there is to go rather than what to do. */
export function minimumCertificatesToSell(debt: DivestmentDebt): number {
  const fromCap = debt.overCapCompanies.reduce(
    (most, company) =>
      Math.max(most, Math.ceil((company.percentage - PLAYER_HOLDING_CAP_PERCENT) / SHARE_BLOCK_PERCENT)),
    0,
  );
  return Math.max(debt.certificatesOver, fromCap);
}
