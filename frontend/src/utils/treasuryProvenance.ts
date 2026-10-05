import type { GameStateResponse } from "../gameEngine/gameState";
// UR-3: the run that carried a Yellow Sign Mark explains the award it minted (`last_run_yellow_sign`).
import { runYellowSignWritten } from "../gameEngine/yellowSign";

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
  "ExchangeTrainForDiesel", // #1303
  "BuyTrainFromCorporation",
  "BuyPrivateCompany",
  // Credits
  "DeclareDividends",
  "BuyStock", // floats a corporation, which capitalises it
  "PassTurn", // opens an Operating Round, which pays the privates (#685)
  "OpenStockRound",
  "YellowSignEvent", // #1375: the Mark's award -- half the taken train's depot value into the treasury
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

/** Every corporate treasury this message moved, and whether the message can account for it -- except a float's
 *  capital, which the float line states (Phase 3 W3-J, AUD-25.13 #4: see below). */
export function describeTreasuryMoves(
  msg: unknown,
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
): readonly TreasuryMove[] {
  if (!after) return [];
  const was = balances(before);
  const unfloated = new Set(
    (before?.public_companies ?? []).filter((company) => !company.is_floated).map((company) => company.company_id),
  );
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
    /* Phase 3 W3-J (AUD-25.13 #4): ONE FLOAT, ONE SENTENCE. A corporation that floats on this transition (W2-J's
       `describeFloat` edge, `is_floated` false -> true) from an empty treasury has its whole movement stated by the
       float line -- "<CORP> has floated. It received $<treasury>." -- which the shell prints off these same two
       boards for every message. A BuyStock float was already silent here (#1343, `sentenceStatesTreasury`); the M&H
       exchange (on the owner's turn, or settled at a turn boundary inside a PassTurn) and the C&A grant (an auction
       step) printed this line beside it -- on the direct paths flagged UNEXPLAINED. Omitted here, so the shell's
       loop is untouched. A floated corporation re-capitalised (#750's own hypothesis), a float from a non-empty
       treasury, and every other corporation's movement on the same entry are still reported. */
    if (from === 0 && unfloated.has(company.company_id) && company.is_floated) continue;
    /* UR-3 (OD-UR-1): ON A PINNED UNPREDICTABLE REVENUE TABLE THE MARK LANDS IN THE RUN'S OWN ENTRY, and it mints its
       award there -- a treasury movement no run made before. It is explained for exactly the corporation whose run
       recorded a Mark, and exactly by that award; any other treasury a run moves is still the surprise #750 exists to
       flag. */
    const sign = key === "RunMultipleRoutes" ? runYellowSignWritten(before, after, company.company_id) : null;
    const explainedBySign = sign !== null && sign.stage === "mark" && to - from === (Number(sign.award) || 0);
    moves.push({
      companyId: company.company_id,
      ticker: company.ticker,
      from,
      to,
      unexplained: !expected && !explainedBySign,
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
