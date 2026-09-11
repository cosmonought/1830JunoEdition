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

import { corporationSpectrumRank } from "./corporationNames";

/* ==================================================================
    DESIGN NOTE 1350: THREE GROUPS, AND A SPECTRUM UNDER THEM
   ==================================================================
   RULED (10 September): the cards group FLOATED -> PARRED -> UNBOUGHT. The moment is unchanged -- #464's
   Operating Round boundary, held through the OR and the Stock Round after it, because the Stock Round is
   where a player looks and acts and must not have the cards move under them. What changed is the tail:
   #464 filed everything unfloated by `company_id`, a number nobody can see, so a parred corporation and one
   nobody had touched were interleaved. Now the parred sort by par (highest first) and the untouched sit in
   the spectrum order (`CORPORATION_SPECTRUM_ORDER`, red to violet by livery), which is also the OPENING
   order -- so a card's place can be learned from its colour before any Operating Round has sorted anything.
   Ties inside a group fall to the spectrum too; `company_id` is the last resort. */

/** The minimum a corporation must expose to be ranked. */
export interface OrderableCorporation {
  company_id: number;
  is_floated: boolean;
  /** #1350: `null`/absent for a corporation nobody has parred. */
  par_value?: string | number | null;
  /** #1350: for the spectrum order. Absent sorts after every known ticker. */
  ticker?: string;
}

const spectrum = (c: OrderableCorporation) => (c.ticker ? corporationSpectrumRank(c.ticker) : Number.MAX_SAFE_INTEGER);
const parOf = (c: OrderableCorporation): number | null => {
  if (c.par_value === null || c.par_value === undefined) return null;
  const value = Number(c.par_value);
  return Number.isFinite(value) && value > 0 ? value : null;
};
const groupOf = (c: OrderableCorporation): number => (c.is_floated ? 0 : parOf(c) !== null ? 1 : 2);

/** The card order for an Operating Round: floated (market price descending), then parred (par descending),
 *  then unbought in spectrum order; the spectrum breaks ties throughout, then `company_id`.
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
      const ga = groupOf(a);
      const gb = groupOf(b);
      if (ga !== gb) return ga - gb;
      if (ga === 0) {
        const priceOf = (c: OrderableCorporation) => marketPrices?.[c.company_id] ?? null;
        const pa = priceOf(a);
        const pb = priceOf(b);
        // A company with no position sorts after one that has a price, rather
        // than being read as $0 and mixed in among the cheap ones.
        if (pa === null && pb !== null) return 1;
        if (pb === null && pa !== null) return -1;
        const byPrice = (pb ?? 0) - (pa ?? 0);
        if (byPrice !== 0) return byPrice;
      } else if (ga === 1) {
        const byPar = (parOf(b) ?? 0) - (parOf(a) ?? 0);
        if (byPar !== 0) return byPar;
      }
      return spectrum(a) - spectrum(b) || a.company_id - b.company_id;
    })
    .map((company) => company.company_id);
}

/** #1350: the order before any Operating Round has sorted the cards -- the spectrum, red to violet. */
export function openingCardOrder(companies: readonly OrderableCorporation[]): number[] {
  return [...companies]
    .sort((a, b) => spectrum(a) - spectrum(b) || a.company_id - b.company_id)
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
