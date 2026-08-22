import type { GameStateResponse } from "./gameState";

/* ==================================================================
 *  DESIGN NOTE 746: THE FOURTH ARROW HAD NO WRITER
 * ==================================================================
 *
 * ASKED FOR: a compass rose on the Stock Market tab -- "an arrow right with 'Paid Dividends', an arrow left
 * with 'Withheld Dividends', an arrow up with 'All shares owned by players', and an arrow down with 'Per share
 * sold'."
 *
 * THREE OF THE FOUR WERE TRUE. `applySandboxMarketAction` walks right on a payout, left on a withhold and down
 * one row per 10% block sold. The up arrow was not implemented anywhere in the frontend, so in a sandbox
 * playthrough no token had ever risen for being sold out.
 *
 * AND THE CODE SAID SO OUT LOUD, WHICH IS WHAT MAKES THIS THE FAMILIAR SHAPE. The `BuyStock` arm's own comment
 * reads "Buying does not move the token in 1830 -- only selling, dividends and THE SOLD-OUT CHECK do", naming
 * a rule the module never performs; #187 on the projections says "Ledges, the right cliff and the sold-out
 * rise are market.rs's". Both are accurate about the division of labour and both leave a player of the sandbox
 * with a rule that silently does not exist -- the same class as #723's terrain fee and #736's private closure,
 * found this time by someone asking for a LEGEND rather than by someone hitting the bug.
 *
 * ==================================================================
 *  DESIGN NOTE 746c: THE RULE IS ONCE, AT THE END OF THE STOCK ROUND
 * ==================================================================
 *
 * THE FIRST VERSION OF THIS MODULE HAD TWO TRIGGERS AND WAS WRONG.
 *
 * REPORTED: "this is completely wrong. A corporation's share price only rises, and only rises once, at the end
 * of a stock round when all of its shares are in the hands of players, period."
 *
 * WHAT I DID AND WHY IT FAILED. I ported the rule out of `src/trading.rs` and `src/market.rs` rather than out
 * of the rulebook, on the reasoning that reading a premise back from shipped code beats writing one from
 * memory. That is usually right and it was wrong here, because THE CONTRACT IS NOT THE AUTHORITY ON THE RULES
 * -- it is another implementation of them, and it had the same bug. `trading.rs` raises the marker inside
 * `execute_buy_stock` on any purchase that empties both pools, calling it "the classic 18xx price bump":
 * a real rule in some 18xx titles and not one in 1830. `market.rs` then wrote the two triggers up as
 * deliberate -- "a corporation that goes sold out mid-round and stays that way is legitimately raised twice"
 * -- and I quoted that sentence into a design note as evidence. A confident comment is not a citation.
 *
 * THE TELL I WALKED PAST. My own note argued the double raise "looks exactly like a bug somebody would
 * helpfully deduplicate" and put a test around it to stop them. That is the argument backwards: when the only
 * defence of a behaviour is that it resembles a defect, the possibility that it IS one deserves checking
 * against the rules rather than a regression test pinning it in place. The test I wrote would have prevented
 * the fix.
 *
 * SO THE PURCHASE TRIGGER IS GONE, here and in `trading.rs`. One trigger, one moment: the end of the Stock
 * Round. The `reason` field went with it -- with a single cause there is nothing for the log line to
 * distinguish, and a discriminant with one case is an invitation to add a second.
 *
 * -------------------------------------------------------------------------------------------------
 * WHAT SURVIVES FROM THE CONTRACT, because it was never the disputed part: the CONDITION, and the single call
 * site. `apply_sold_out_price_rises` requires a FLOATED company whose IPO and Bank pools are both empty, and
 * is called exactly once per Stock Round from `conclude_stock_round` -- which the module's own comment
 * explains is "what makes this an end-of-round bonus rather than a per-purchase one, and is why it must never
 * be invoked speculatively". That sentence was right about this function all along; the second trigger simply
 * sat elsewhere and contradicted it.
 *
 * FLOATED IS REQUIRED, and the contract explains why in a way worth copying down: an unfloated corporation has
 * never sold a share, so an unwritten IPO entry "defaults to FULL (100), not 0". Our `GameStateResponse` is
 * always fully populated, so we cannot reproduce that particular trap -- but the floated test is still the
 * rule, not a workaround for it, and a corporation nobody has bought into must not rise.
 *
 * UP IS `y + 1`. This chart's y axis is inverted relative to the screen -- `projectShareSaleMove` records the
 * same thing from the other direction ("DOWN is y - 1 ... y + 1 walked up and a sale RAISED the price"), and
 * market.rs's own coordinate note says "y = MARKET_MAX_Y is the TOP -- so 'up one' is y + 1 here". Three
 * places, one direction; the traversal itself is injected, so there is still only one definition of it.
 */

/** A cell on the chart. Structurally the same as `SandboxMarketMark`, restated here so this module does not
 *  have to import the reducer it is consumed by. */
export interface RiseCell {
  x: number;
  y: number;
  price: number;
}

export interface SoldOutRise {
  companyId: number;
  ticker: string;
  from: number;
  to: number;
  x: number;
  y: number;
}

type MarkFor = (companyId: number) => RiseCell | null | undefined;
type ProjectRise = (from: RiseCell) => RiseCell | null | undefined;

/** Floated, with nothing left in either pool -- every share in a player's hands.
 *
 *  BOTH POOLS, NOT JUST THE BANK POOL. Worth stating because "sold out" in 18xx conversation usually means
 *  an empty Bank Pool alone, and a reader who applied that meaning here would raise corporations that still
 *  have half their IPO on the shelf. */
export function isSoldOut(company: {
  is_floated: boolean;
  ipo_pool_percentage: number;
  bank_pool_percentage: number;
}): boolean {
  return (
    company.is_floated === true &&
    company.ipo_pool_percentage === 0 &&
    company.bank_pool_percentage === 0
  );
}

function riseFor(
  company: { company_id: number; ticker: string },
  markFor: MarkFor | undefined,
  projectRise: ProjectRise | undefined,
): SoldOutRise | null {
  if (!markFor || !projectRise) return null;
  const mark = markFor(company.company_id);
  if (!mark) return null;
  const landed = projectRise(mark);
  /* A token at the top of its column STAYS THERE and reports nothing. `projectRiseMove` clamps rather than
     inventing a cell (#434's rule for the other three directions), so an unchanged cell means "already at the
     ceiling" -- which is a real outcome and not a failure to move. */
  if (!landed || (landed.x === mark.x && landed.y === mark.y)) return null;
  return {
    companyId: company.company_id,
    ticker: company.ticker,
    from: mark.price,
    to: landed.price,
    x: landed.x,
    y: landed.y,
  };
}

/** Every floated, sold-out corporation rises one cell. The whole rule.
 *
 *  CALLED FROM EXACTLY ONE PLACE, which is the rule rather than an optimisation -- #746c. The contract states
 *  the consequence of getting this wrong: "two calls in one round would double-raise every sold-out company." */
export function roundEndSoldOutRises(
  state: GameStateResponse,
  markFor: MarkFor | undefined,
  projectRise: ProjectRise | undefined,
): readonly SoldOutRise[] {
  const rises: SoldOutRise[] = [];
  for (const company of state.public_companies) {
    if (!isSoldOut(company)) continue;
    const rise = riseFor(company, markFor, projectRise);
    if (rise) rises.push(rise);
  }
  return rises;
}

export interface SoldOutRiseInput {
  /** The board BEFORE this action, or `null` where there is none to compare against. */
  before: GameStateResponse | null | undefined;
  after: GameStateResponse;
  markFor: MarkFor | undefined;
  projectRise: ProjectRise | undefined;
}

/** What this one action caused -- the shell's entry point.
 *
 *  THE ANSWER IS ALWAYS "NOTHING, UNLESS THE STOCK ROUND JUST CLOSED", and that is the point of asking. The
 *  shell runs this after every message and gets an empty list from all but one of them, which is exactly the
 *  shape that stops a second trigger creeping back in: there is no other branch for one to be added to. */
export function soldOutRises(input: SoldOutRiseInput): readonly SoldOutRise[] {
  const { before, after, markFor, projectRise } = input;
  const roundEnded =
    before?.current_round_type === "StockRound" && after.current_round_type !== "StockRound";
  return roundEnded ? roundEndSoldOutRises(after, markFor, projectRise) : [];
}

/** The Activity Log's line. One cause, so it names the moment rather than distinguishing triggers. */
export function describeSoldOutRise(rise: SoldOutRise): string {
  return `${rise.ticker} rose from $${rise.from} to $${rise.to} — sold out at the end of the Stock Round.`;
}
