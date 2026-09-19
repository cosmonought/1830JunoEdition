// frontend/src/utils/stockTransaction.ts
//
// What the stock action that just landed actually did, for the corporation card that has to show it.
//
/* ==================================================================
 *  DESIGN NOTE 1451: THE SHELL DESCRIBES; IT DOES NOT DECIDE
 * ==================================================================
 *
 * REQUESTED: the card's animation must "model 1830 transaction procedure, especially when a transaction
 * changes the presidency" -- and, as the constraint on how: "Do not copy or reimplement stock-market rules in
 * the animation layer. Use the authoritative action and resulting states to describe what already happened."
 *
 * THE ARCHITECTURE ALREADY SUPPLIES EVERYTHING, and it is worth writing down exactly what, because the
 * tempting alternative -- inferring "was this a buy or a sell" from a state diff -- is both harder and wrong.
 * At the point the drain reaches, it holds three things:
 *
 *   THE COMPLETED ACTION. `{ BuyStock: { protocol_id, ... } }` or `{ SellStock: { protocol_id, ... } }`, the
 *   very message the reducer applied. It names the KIND and the CORPORATION outright. Nothing is inferred and
 *   nothing can disagree with the reducer, because this IS what the reducer was given.
 *
 *   `before` AND `after`. The percentage diff below reads the ownership that moved.
 *
 *   `president`, BEFORE AND AFTER. `presidencyTransfer.ts` #596 owns the rule -- strictly more, ties by seat,
 *   never vacated -- and `settlePresidencies` has already applied its verdict to `after`. Comparing one field
 *   across two states is reading that verdict, not re-deriving it. This module never calls `presidentFor`,
 *   never compares two holdings, and would be unaffected by a change to how the crown is awarded.
 *
 * THE ONE THING THIS MODULE DECIDES IS NOT A RULE. Which sub-animation runs first is keyed off the action
 * kind -- a buy shows the purchase and then the handoff, a sale shows the handoff and then the shares leaving
 * -- and that is a statement about the ORDER A PLAYER SHOULD READ IT IN, chosen by the brief. It computes no
 * price, no legality, no successor and no percentage. `stockTransferFocus.ts` holds it, one step away from
 * here, so this module stays a pure description of a completed event.
 *
 * ==================================================================
 *  WHY THE PERCENTAGE DIFF SURVIVED #1450 AND THE REST OF IT DID NOT
 * ==================================================================
 *
 * #1450's screen-space flight is deleted -- slide-out movement is reserved for money, and a certificate
 * flying across the application shell borrowed the treasury machine's vocabulary for something that is not a
 * dollar. What survived is the diff, because the question it answers did not change and it is the one part
 * that was hard to get right:
 *
 *   PERCENTAGES, NOT CARD COUNTS. A presidency transfer swaps the 20% card for two 10% cards, so both
 *   players' CARD counts move by one in opposite directions while neither's stake moves at all
 *   (`presidencyTransfer.ts` #596a: "this file therefore changes no `percentage` at all"). A card-counting
 *   diff reports a transfer between two players who traded nothing.
 *
 *   AND THAT PROPERTY IS NOW LOAD-BEARING TWICE OVER. Because the exchange is invisible to the percentage
 *   diff, a takeover produces exactly ONE movement -- the purchase or the sale that caused it -- and the
 *   crown's own handoff is read from the `president` field instead. Two questions, two sources, neither
 *   guessing at the other. Had the diff counted cards, the two would overlap and the card would have to
 *   subtract one from the other to find out what a player actually bought.
 *
 * ==================================================================
 *  DESIGN NOTE 1452: THE CARD STARTS FROM `before` AND ARRIVES AT `after`
 * ==================================================================
 *
 * RULED: "The animation should cause the visible final state, not fire on top of it after it is already
 * visible." #1451 drew the right gesture over the wrong board -- the figures were already final when the
 * proxy set off, so the animation explained a change the reader had already been shown.
 *
 * SO THE DESCRIPTOR CARRIES BOTH SNAPSHOTS, and the card renders a SELECTION between them rather than a
 * mutation of either. That is the whole technique and it is why no arithmetic appears anywhere in the
 * presentation layer: the intermediate board is `before`'s holdings with `after`'s president, or `after`'s
 * holdings with `before`'s president, depending which beat has landed. Every figure the card draws at every
 * instant is a figure the reducer actually produced.
 *
 * AND BOTH OF THOSE INTERMEDIATES ARE REAL 1830 MOMENTS, which is the part that makes this honest rather
 * than merely convenient. A buy takeover passes through "the buyer has the shares, the old president still
 * holds the certificate"; a sale takeover passes through "the certificate has been exchanged, the sold
 * shares have not yet reached the pool". Those are the two halves of the procedure, and the card is showing
 * them in the order the rules perform them.
 *
 * THE SNAPSHOT IS FOUR FIELDS. Not the state, not the company -- the ownership the ownership table draws,
 * plus the one extra fact a percentage cannot carry (`double_certificate`, #1324), so certificate COUNTS
 * stage correctly alongside the percentages they are derived from.
 *
 * See docs/ai_architecture/stock_market.md, stockTransaction.ts #1451/#1452. */

import type { GameStateResponse, PlayerShareEntry, PublicCompanyState } from "../gameEngine/gameState";

/** Who can hold a certificate: the two pools by the names the reducer's `moveShares` uses, or a player
 *  address. No address can collide with either (`doubleCertificate.ts` #1324 keys the same way). */
export type ShareHolder = string;

export const IPO_HOLDER: ShareHolder = "Ipo";
export const BANK_HOLDER: ShareHolder = "Bank";

/** One transfer of economic ownership. `percentage` is always positive. */
export interface ShareTransfer {
  from: ShareHolder;
  to: ShareHolder;
  percentage: number;
}

/** The crown moving between two PLAYERS. */
export interface PresidencyHandoff {
  from: string;
  to: string;
}

export type StockActionKind = "buy" | "sell";

/** One corporation's ownership, as the ownership table draws it.
 *
 *  `double_certificate` IS COPIED VERBATIM, `undefined` included. `gameState.ts` #1324 is explicit that
 *  `undefined` means "this build cannot tell you" while `null` means "there is no such certificate", and
 *  `certificateCardsHeld` reads it -- collapsing the two here would make a staged card count differently
 *  from the authoritative one it resolves into. */
export interface OwnershipSnapshot {
  ipo_pool_percentage: number;
  bank_pool_percentage: number;
  player_holdings: PlayerShareEntry[];
  president: string | null;
  double_certificate?: { at: string } | null;
}

/** Which of the transaction's two beats have landed. Both start `false`; see `stagedOwnership`. */
export interface AppliedSteps {
  transfer: boolean;
  presidency: boolean;
}

/** Everything the card needs, and nothing it could act on. */
export interface StockTransaction {
  companyId: number;
  ticker: string;
  /** From the message the reducer applied -- never inferred from the board. */
  kind: StockActionKind;
  /** The ownership that changed hands, or `null` when none did. */
  transfer: ShareTransfer | null;
  /** The crown's handoff between two sitting players, or `null`. */
  presidency: PresidencyHandoff | null;
  /** Design note #1452: the ownership the card starts from, and the ownership it arrives at. Four fields of
   *  one corporation -- not a copy of the state, and not enough of one to be mistaken for authority. */
  before: OwnershipSnapshot;
  after: OwnershipSnapshot;
}

type CompanyLike = Pick<
  PublicCompanyState,
  | "company_id"
  | "ticker"
  | "ipo_pool_percentage"
  | "bank_pool_percentage"
  | "player_holdings"
  | "president"
  | "double_certificate"
>;

/** The four fields, copied. `player_holdings` is COPIED rather than referenced: the card holds this across
 *  several renders while the shell goes on replacing state objects, and a shared array is how a "snapshot"
 *  quietly stops being one. */
function ownershipSnapshot(company: CompanyLike): OwnershipSnapshot {
  return {
    ipo_pool_percentage: company.ipo_pool_percentage,
    bank_pool_percentage: company.bank_pool_percentage,
    player_holdings: (company.player_holdings ?? []).map((entry) => ({
      player: entry.player,
      percentage: entry.percentage,
    })),
    president: company.president,
    double_certificate: company.double_certificate,
  };
}

/** What the card should be showing, given which beats have landed.
 *
 *  A SELECTION, NEVER A MUTATION. The holdings come whole from one snapshot or the other and the president
 *  comes from its own, so the presentation layer performs no arithmetic and can produce no figure the
 *  reducer did not. It also cannot drift: there is no accumulated state to be wrong, only a pair of
 *  booleans choosing between two fixed answers.
 *
 *  BOTH FLAGS START `false`, AND THAT IS CORRECT EVEN WHEN A BEAT IS ABSENT. A transaction with no
 *  presidency change has the same `president` in both snapshots; one with no transfer has the same holdings
 *  in both. So "not yet applied" and "nothing to apply" select the same values, and no separate
 *  initialisation is needed to tell them apart. */
export function stagedOwnership(
  transaction: { before: OwnershipSnapshot; after: OwnershipSnapshot } | null,
  applied: AppliedSteps,
): OwnershipSnapshot | null {
  if (!transaction) return null;
  const holdings = applied.transfer ? transaction.after : transaction.before;
  return {
    ...holdings,
    president: applied.presidency ? transaction.after.president : transaction.before.president,
  };
}

/* ---- what moved ---------------------------------------------------------------- */

/** Every holder's percentage, pools included. A player at 0% is omitted from `player_holdings` upstream and
 *  is simply absent here; the diff reads a missing key as zero, which is what it means.
 *
 *  A PLAIN RECORD RATHER THAN A `Map`: `tsconfig` targets ES5 without `downlevelIteration`, so iterating a
 *  `Map` or spreading a `Set` does not compile. Every question below is a lookup anyway, which is
 *  `cashDelta.ts` #670's own reason for the same choice. */
function holdingsByHolder(company: CompanyLike): Record<ShareHolder, number> {
  const out: Record<ShareHolder, number> = {};
  out[IPO_HOLDER] = company.ipo_pool_percentage;
  out[BANK_HOLDER] = company.bank_pool_percentage;
  for (const entry of company.player_holdings ?? []) {
    out[entry.player] = entry.percentage;
  }
  return out;
}

/** The one transfer this corporation performed between the two states, or `null`.
 *
 *  ONE LOSER AND ONE GAINER, OF EQUAL SIZE, OR NOTHING. Every transfer in scope has that shape -- a pool to a
 *  player on a buy, a player to the Bank Pool on a sale, the IPO to the new president at par, and the double
 *  certificate's half-sale nets to it (the 20% card leaves for the pool and a 10% card comes back, so the
 *  seller is -10 and the pool +10). Anything else is either not a transfer or not one this module can name
 *  without guessing, and the card's answer to `null` is to animate nothing -- which is the correct answer to
 *  "I cannot tell what moved". */
export function companyShareTransfer(before: CompanyLike, after: CompanyLike): ShareTransfer | null {
  const was = holdingsByHolder(before);
  const now = holdingsByHolder(after);

  let loser: { holder: ShareHolder; amount: number } | null = null;
  let gainer: { holder: ShareHolder; amount: number } | null = null;
  let losers = 0;
  let gainers = 0;

  const holders = Object.keys(now);
  for (const holder of Object.keys(was)) {
    if (!(holder in now)) holders.push(holder);
  }

  for (const holder of holders) {
    const delta = (now[holder] ?? 0) - (was[holder] ?? 0);
    if (delta === 0) continue;
    if (delta < 0) {
      losers += 1;
      loser = { holder, amount: -delta };
    } else {
      gainers += 1;
      gainer = { holder, amount: delta };
    }
  }

  if (losers !== 1 || gainers !== 1 || loser === null || gainer === null) return null;
  /* Conserved, or it is not a transfer. 1830 never issues a certificate out of thin air, so an unequal pair
     is a state this module has misread rather than an event worth drawing. */
  if (loser.amount !== gainer.amount) return null;
  return { from: loser.holder, to: gainer.holder, percentage: gainer.amount };
}

/* ---- who now presides ---------------------------------------------------------- */

/** The crown's handoff, or `null`.
 *
 *  BETWEEN TWO SITTING PLAYERS ONLY. A corporation's FIRST president arrives from `null` -- the par purchase
 *  that starts the company -- and that is not a handoff: there is no old crown to erase, no certificate to
 *  exchange and no row to displace. It is exactly the transfer the diff above already describes, and the
 *  crown simply appears on the row that arrives with it. Emitting a handoff there would stage a duel with a
 *  player who does not exist. */
export function presidencyHandoff(before: CompanyLike, after: CompanyLike): PresidencyHandoff | null {
  const was = before.president;
  const now = after.president;
  if (!was || !now || was === now) return null;
  return { from: was, to: now };
}

/* ---- the completed action ------------------------------------------------------ */

/** The kind and the corporation, read off the authoritative message.
 *
 *  `unknown` IN, DELIBERATELY. The drain's message union is wider than the two entries this cares about
 *  (`SandboxLogMsg` carries setup events too), and importing that union to narrow it would tie this module to
 *  a shape it reads exactly two fields of. Two fields is the whole contract; a message that does not carry
 *  them is not a stock action. */
function stockAction(msg: unknown): { kind: StockActionKind; companyId: number } | null {
  if (typeof msg !== "object" || msg === null) return null;
  const record = msg as Record<string, unknown>;
  const read = (key: "BuyStock" | "SellStock"): number | null => {
    const body = record[key];
    if (typeof body !== "object" || body === null) return null;
    const id = (body as { protocol_id?: unknown }).protocol_id;
    return typeof id === "number" && Number.isFinite(id) ? id : null;
  };
  const bought = read("BuyStock");
  if (bought !== null) return { kind: "buy", companyId: bought };
  const sold = read("SellStock");
  if (sold !== null) return { kind: "sell", companyId: sold };
  return null;
}

/** What the card should show, or `null` when this action was not a stock trade -- or was one that moved
 *  nothing observable. */
export function describeStockTransaction(
  msg: unknown,
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
): StockTransaction | null {
  const action = stockAction(msg);
  if (!action || !before || !after) return null;

  const find = (state: GameStateResponse) =>
    (state.public_companies ?? []).find((entry) => entry.company_id === action.companyId) ?? null;
  const was = find(before);
  const now = find(after);
  if (!was || !now) return null;

  const transfer = companyShareTransfer(was, now);
  const presidency = presidencyHandoff(was, now);
  /* A refused action leaves the board untouched, and an action that changed nothing observable has nothing to
     narrate. Either way the holdings on screen are already correct, which is the whole fallback. */
  if (!transfer && !presidency) return null;

  return {
    companyId: action.companyId,
    ticker: now.ticker,
    kind: action.kind,
    transfer,
    presidency,
    before: ownershipSnapshot(was),
    after: ownershipSnapshot(now),
  };
}
