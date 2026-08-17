// frontend/src/utils/corporationCardOrder.ts
//
// ==================================================================
//  DESIGN NOTE 464: THE CARDS HOLD STILL WHILE YOU ARE TRADING
// ==================================================================
//
// REPORTED: the corporation cards re-sort the moment a company floats,
// disrupting the player's rhythm during a Stock Round.
//
// Design note #446 sorted floated companies to the front, and it was right
// about the ORDER and wrong about the MOMENT. A Stock Round is eight cards
// a player buys from repeatedly, and buying is what causes floats -- so the
// act of using the screen rearranged it. A player reaching for the card
// they just looked at found something else there, caused by their own last
// click.
//
// ==================================================================
//  WHY THE ORDER IS RECOMPUTED AT A ROUND BOUNDARY
// ==================================================================
//
// The ordering itself is genuinely useful: an Operating Round runs
// corporations in market-price order, so a roster in that order is a
// preview of the round about to happen. What makes it disruptive is
// recomputing it CONTINUOUSLY, during the one round where the player is
// interacting with the cards themselves.
//
// So the sort happens once, when an Operating Round begins, and the order
// is then held -- through that Operating Round and through the Stock Round
// that follows, until the next Operating Round re-sorts it. The player's
// mental map of the screen changes only at a moment when the screen was
// going to change anyway.
//
// ==================================================================
//  MARKET VALUE, DESCENDING -- AND WHAT HAPPENS TO THE UNFLOATED
// ==================================================================
//
// Highest price first, which is 1830's operating order. An unfloated
// corporation has no market position at all (`sandboxMarketPositions`
// refuses to give one), so it cannot be ranked among companies that do --
// it sorts after all of them rather than being treated as price zero and
// interleaved by accident.
//
// Ties break on `company_id`: an arbitrary but STABLE tiebreak, which is
// the property that matters. Two corporations at the same price must not
// swap places on an unrelated re-render.

/** The minimum a corporation must expose to be ranked. */
export interface OrderableCorporation {
  company_id: number;
  is_floated: boolean;
}

/**
 * The card order for an Operating Round: floated first, by market price
 * descending, then by `company_id`.
 *
 * Returns `company_id`s rather than the companies themselves, so a caller
 * can hold the answer across renders without pinning stale company objects
 * -- the roster it applies this to is refreshed on every poll.
 */
export function operatingRoundCardOrder(
  companies: readonly OrderableCorporation[],
  marketPrices: Readonly<Record<number, number | null>> | undefined,
): number[] {
  return [...companies]
    .sort((a, b) => {
      if (a.is_floated !== b.is_floated) return Number(b.is_floated) - Number(a.is_floated);
      const priceOf = (c: OrderableCorporation) => marketPrices?.[c.company_id] ?? null;
      const pa = priceOf(a);
      const pb = priceOf(b);
      // A company with no position sorts after one that has a price, rather
      // than being read as $0 and mixed in among the cheap ones.
      if (pa === null && pb !== null) return 1;
      if (pb === null && pa !== null) return -1;
      return (pb ?? 0) - (pa ?? 0) || a.company_id - b.company_id;
    })
    .map((company) => company.company_id);
}

/**
 * Applies a held order to the current roster.
 *
 * NEW COMPANIES GO TO THE END rather than being dropped or forcing a
 * re-sort. A roster that gained an entry the held order has never seen is
 * either a fixture change or a contract that grew a corporation mid-game;
 * appending shows it without disturbing the positions the player has
 * learned, and the next Operating Round files it properly.
 *
 * `null` or an empty order returns the roster untouched -- the honest
 * answer before any Operating Round has established one.
 */
export function applyCardOrder<T extends OrderableCorporation>(
  companies: readonly T[],
  order: readonly number[] | null,
): T[] {
  if (!order || order.length === 0) return [...companies];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...companies].sort(
    (a, b) =>
      (rank.get(a.company_id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.company_id) ?? Number.MAX_SAFE_INTEGER) || a.company_id - b.company_id,
  );
}
