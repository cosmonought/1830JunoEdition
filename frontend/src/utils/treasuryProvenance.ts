import type { GameStateResponse } from "./gameState";

/* ==================================================================
 *  DESIGN NOTE 750: WHERE DID THE MONEY COME FROM
 * ==================================================================
 *
 * REPORTED: "a corporation's trains rusted with $500 in its treasury and the cheapest next train was $630. On
 * its turn it laid track and then was auto-skipped to Buy Trains, where it miraculously suddenly had $1500 to
 * make the purchase. This amount did not come from the player's cash ... and there was no Emergency Train Buy
 * action."
 *
 * I COULD NOT FIND IT BY READING, AND SAY SO RATHER THAN GUESSING. Every writer that credits a corporate
 * treasury looks correctly guarded -- capitalisation behind `!is_floated`, the train sale on the seller's
 * side, the emergency shortfall out of the president's cash, withheld dividends, the dividend pool slice,
 * private revenue. The purchase panel does gate on the treasury, so the $1500 was almost certainly a real
 * figure in state rather than a bad label. Twice in this session I have supplied a mechanism that fit a
 * symptom and been wrong (#746c, #748b), so this time the instrument comes first.
 *
 * THE INSTRUMENT IS A DIFF, NOT AN ANNOTATION. Every arm could have been made to report what it charged, and
 * that is exactly the arrangement that produces a log agreeing with a bug -- the arm's story and the arm's
 * arithmetic come from the same place. This reads the treasury BEFORE and AFTER the reducer ran and reports
 * the difference, so a credit nobody wrote a sentence for still appears, and appears as a surprise.
 *
 * WHICH IS THE POINT: a movement the log CANNOT name is the interesting one. `describeTreasuryMoves` returns
 * an `unexplained` flag when a corporation's balance moved on a message that has no business touching it,
 * and the shell says so out loud. The phantom $1500 will identify itself the first time it recurs.
 *
 * $1500 - $500 IS $1000, WHICH IS TEN TIMES A $100 PAR. That points at re-capitalisation and the `is_floated`
 * guard should make it unreachable -- recorded as the leading hypothesis, not as a finding.
 */

/** Which messages have a legitimate reason to move a given corporation's treasury. Anything else that moves
 *  one is reported as unexplained. */
const TREASURY_MOVERS: readonly string[] = [
  // Spends
  "LayTile",
  "PlaceStationToken",
  "BuyHardwareFromPool",
  "EmergencyBuyHardware",
  "BuyTrainFromCorporation",
  "BuyPrivateCompany",
  // Credits
  "DeclareDividends",
  "BuyStock", // floats a corporation, which capitalises it
  "PassTurn", // opens an Operating Round, which pays the privates (#685)
  "OpenStockRound",
];

export interface TreasuryMove {
  companyId: number;
  ticker: string;
  from: number;
  to: number;
  /** `true` when this message had no business moving this treasury -- see #750. */
  unexplained: boolean;
}

function balances(state: GameStateResponse | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const company of state?.public_companies ?? []) {
    out.set(company.company_id, Number(company.treasury) || 0);
  }
  return out;
}

/** Every corporate treasury this message moved, and whether the message can account for it. */
export function describeTreasuryMoves(
  msg: unknown,
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
): readonly TreasuryMove[] {
  if (!after) return [];
  const was = balances(before);
  const key =
    typeof msg === "object" && msg !== null ? (Object.keys(msg)[0] ?? "") : String(msg ?? "");
  const expected = TREASURY_MOVERS.includes(key);

  const moves: TreasuryMove[] = [];
  for (const company of after.public_companies) {
    const from = was.get(company.company_id);
    /* A corporation that did not exist before has no MOVE to report -- its opening balance is not a change.
       `undefined` rather than zero for exactly this reason. */
    if (from === undefined) continue;
    const to = Number(company.treasury) || 0;
    if (from === to) continue;
    moves.push({
      companyId: company.company_id,
      ticker: company.ticker,
      from,
      to,
      unexplained: !expected,
    });
  }
  return moves;
}

/** The Activity Log's line. Reads as bookkeeping when the cause is known and as an alarm when it is not. */
export function treasuryMoveLine(move: TreasuryMove, cause: string): string {
  const delta = move.to - move.from;
  const direction = delta > 0 ? "received" : "spent";
  const amount = Math.abs(delta);
  const body = `${move.ticker} ${direction} $${amount} — treasury $${move.from} → $${move.to}`;
  /* THE UNEXPLAINED CASE NAMES THE MESSAGE, because "where did this come from" is the whole question and the
     message key is the only honest answer available at this point. */
  return move.unexplained ? `${body}. UNEXPLAINED — no rule in ${cause} moves a treasury.` : `${body}.`;
}
