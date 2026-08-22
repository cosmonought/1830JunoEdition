import type { GameStateResponse, PublicCompanyState } from "./gameState";

/* ==================================================================
 *  DESIGN NOTE 753: THE QUEUE IS DECIDED ONCE, SO THE TABLE MUST READ IT
 * ==================================================================
 *
 * REPORTED: "During the Operating Round, it appears the Operating Round--Corporations panel re-orders itself
 * after every corporation acts, but this is somewhat confusing because you can end up with a corporation
 * appearing to take its turn after another corporation has acted. Let's set this panel's table to
 * refresh/re-order at the start of each OR rather than continuously with each corporation's actions."
 *
 * THE ROUND ALREADY WORKS THAT WAY; THE TABLE DID NOT. `beginOperatingRound` builds `active_operating_order`
 * once when the round opens and the cursor walks it -- that queue is frozen for the whole round, which is
 * 1830's rule. #449 then taught the table to show operating order instead of `company_id` order, and did it
 * by REPRODUCING the comparison rather than reading the queue: "the same rule `buildOperatingOrder` uses:
 * market price descending, then par, then id. Reproduced rather than imported because that function returns
 * only the FLOATED queue and this table shows every corporation."
 *
 * THAT REASONING IS SOUND AND THE CONCLUSION WAS WRONG. Reproducing a comparison reproduces it against
 * WHATEVER THE PRICES ARE NOW -- and prices move during an Operating Round, on every dividend. So the table
 * re-sorted itself under the player mid-round while the actual turn order did not budge, which is exactly
 * the report: a corporation appearing to act out of sequence because the list moved, not because the round
 * did.
 *
 * THE FIX IS TO STOP DERIVING AN ANSWER THE STATE ALREADY HOLDS -- #734 and #741's lesson, arriving here from
 * a third direction. The queue is the authority on order; the live comparison is only needed for
 * corporations the queue does not contain.
 *
 * I CLAIMED A SECOND BUG HERE AND THERE WAS NOT ONE. The paragraph said a corporation floating DURING an
 * Operating Round would be mis-slotted by the live sort. REPORTED BACK: "this isn't really a bug, because
 * corporations will never and cannot float during an Operating Round, only a Stock Round."
 *
 * WHICH IS RIGHT -- floating is caused by a share purchase, and shares are bought in a Stock Round. The
 * scenario cannot arise, so the live sort was never wrong about it and the frozen queue fixes nothing there.
 * Corrected rather than deleted because the reasoning is the recurring failure worth remembering: I found a
 * case the new code handles better, checked that it handles it, and never checked whether the case exists.
 *
 * THE TESTS FOR IT SURVIVE AS INVARIANTS RATHER THAN AS REGRESSIONS. "A corporation absent from the queue
 * sorts after it, whatever its price" is a true and useful property of this function -- it is what keeps an
 * unfloated corporation out of the operating order -- and it is worth pinning. What it is not is a bug fix.
 */

/** Where each corporation sits in the round's frozen queue, by `company_id`. */
export function operatingOrderRanks(
  state: Pick<GameStateResponse, "active_operating_order">,
): ReadonlyMap<number, number> {
  const ranks = new Map<number, number>();
  (state.active_operating_order ?? []).forEach((companyId, index) => {
    if (!ranks.has(companyId)) ranks.set(companyId, index);
  });
  return ranks;
}

export interface OperatingOrderSortInput {
  ranks: ReadonlyMap<number, number>;
  /** Live market price by `company_id`. Used ONLY for corporations outside the queue. */
  priceFor: (companyId: number) => number | null | undefined;
}

/** Orders every corporation for display: the round's queue first, in its own order, then everything else.
 *
 *  THE TAIL STILL NEEDS A COMPARISON and it is the old one, applied where it is harmless: a corporation
 *  outside the queue is not operating this round, so nothing about its position can misrepresent a turn
 *  order. Sorting it by price keeps the tail readable rather than arbitrary.
 *
 *  AN EMPTY QUEUE FALLS BACK ENTIRELY to that comparison, which is what a Stock Round looks like from here.
 *  The table is visible outside an Operating Round and would otherwise render in `company_id` order -- the
 *  thing #449 removed. */
export function sortForOperatingOrder(
  companies: readonly PublicCompanyState[],
  input: OperatingOrderSortInput,
): PublicCompanyState[] {
  const { ranks, priceFor } = input;
  const priceOf = (company: PublicCompanyState) =>
    priceFor(company.company_id) ?? (Number(company.par_value ?? 0) || 0);

  return [...companies].sort((a, b) => {
    const rankA = ranks.get(a.company_id);
    const rankB = ranks.get(b.company_id);

    /* IN THE QUEUE BEATS OUT OF IT, whatever the prices say. This is the whole fix: a corporation's place in
       the round is a fact the round decided, not a function of what its shares are worth right now. */
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;

    /* #449's comparison, kept for the tail. Unfloated last, then price, then par, then id -- so the ordering
       of corporations that are NOT operating stays stable and readable. */
    if (a.is_floated !== b.is_floated) return Number(b.is_floated) - Number(a.is_floated);
    return priceOf(b) - priceOf(a) || a.company_id - b.company_id;
  });
}
