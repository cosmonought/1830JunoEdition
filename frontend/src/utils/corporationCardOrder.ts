// Design note #464: the corporation cards hold still while you are trading.
//
// #446 sorted floated companies to the front and was right about the ORDER and
// wrong about the MOMENT: a Stock Round is eight cards a player buys from
// repeatedly, buying is what causes floats, and so the act of using the screen
// rearranged it under them.
//
// The ordering itself is useful -- an Operating Round runs corporations in
// market-price order, so the roster previews the round about to happen. So the
// sort happens ONCE, when an Operating Round begins, and holds through that OR
// and the Stock Round after it.
//
// Market value descending; an unfloated corporation has no market position at
// all (`sandboxMarketPositions` refuses to give one) and sorts after every
// company that does, rather than being treated as price zero and interleaved.
// Ties break on `company_id` -- arbitrary but STABLE, which is the property that
// matters.
//
// See docs/ai_architecture/stock_market.md, corporationCardOrder.ts #464.

/** The minimum a corporation must expose to be ranked. */
export interface OrderableCorporation {
  company_id: number;
  is_floated: boolean;
}

/** The card order for an Operating Round: floated first, by market price
 *  descending, then by `company_id`.
 *
 *  Returns `company_id`s rather than the companies themselves, so a caller can
 *  hold the answer across renders without pinning stale company objects -- the
 *  roster it applies to is refreshed on every poll. */
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

/** Applies a held order to the current roster.
 *
 *  NEW COMPANIES GO TO THE END rather than being dropped or forcing a re-sort.
 *  Appending shows the entry without disturbing the positions the player has
 *  learned, and the next Operating Round files it properly. `null` or an empty
 *  order returns the roster untouched -- the honest answer before any Operating
 *  Round has established one. */
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
