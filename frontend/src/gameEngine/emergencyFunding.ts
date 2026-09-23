// frontend/src/gameEngine/emergencyFunding.ts
//
// The forced train purchase when the corporation cannot pay: the president's money, the president's forced
// sales, and bankruptcy -- as one authoritative obligation, resolved one real action at a time.
//
// ==================================================================
//  DESIGN NOTE 1540: THE FUNDING CASCADE IS A STATE THE BOARD IS IN, NOT A SUM THE CLIENT MADE
// ==================================================================
//
// RULEBOOK (1830-RE, Lookout 2018):
//   6.6.2 "If a railroad with a legal train route has no train at the end of its operating turn, it must
//         immediately purchase a train. The railroad may purchase a train from the Bank Pool, the bank, or
//         another railroad using the normal rules. Otherwise, if the railroad has enough money, the railroad
//         must purchase the cheapest train available. Otherwise, if together the railroad and its president
//         have enough money, they must purchase the cheapest train available. All of the railroad's money
//         must be spent, and the president must then make up the difference using his own money. However,
//         in this case, the price paid for a train from another railroad may not exceed the train's face
//         value."
//   6.6.3 "If together the railroad and its president do not have enough money to buy a train, both the
//         railroad and its president put aside all of their money. Then the president must sell his shares
//         and/or private companies until he raises enough additional money to be able to purchase a train.
//         The share sales may not cause a change in the presidency of the railroad that is without a train.
//         Any changes of president caused by share sales take place immediately. The president decides what
//         to sell, in what order to sell it, and how to sell the shares and/or private companies. The
//         president may only sell enough shares to be able to make the forced purchase of a train. The
//         president may sell private companies he owns (if he can find a buyer), but he is not required to
//         do so." ... "The bankrupt president's final score (i.e., wealth) is the value of all of the shares
//         that he could not sell. It is possible, but unlikely, that a bankrupt player can win."
//   6.7   "If a railroad is forced to buy a train and its money and the president's money together are not
//         enough to make the purchase, the president must sell shares to make up the difference. If there is
//         not enough money after the president sells all of his shares that he is allowed to, he goes
//         bankrupt and the game ends."
//
// WHAT WAS HERE BEFORE. The shell built a "plan" (`buildEmergencyPurchasePlan` -> `resolveEmergencyFunding`,
// `sellableHoldings`): a static cascade summing cash plus a ceiling of what could be sold, with `bankrupt =
// maxRaisable < cost` decided once from that snapshot, the rescued corporation's shares excluded wholesale,
// and the Game Over modal raised by the CLIENT from that flag. The reducer knew nothing of it: it took the
// president's cash on `EmergencyBuyHardware` and, when that was short, refused (Batch 4 #1513) -- honest,
// and unfinished. A static sum cannot be the rule, because every sale moves a price, can move a presidency,
// and changes what the next sale is allowed to be; and a bankruptcy the reducer never records cannot end a
// game every client agrees is over, nor be undone by a `RevertTo`.
//
// THE OBLIGATION IS DERIVED, like the discard's (#1530). It stands exactly while the board says so:
//   an Operating Round, at the Buy Trains step; the operating corporation owns no train and has a legal
//   route (`trainObligationFor`, Batch 4 -- which needs the grid; without one it has no opinion, #757);
//   the bank has a train to sell (`cheapestPurchasableTrain`, the ONE required train, #1512); and the
//   treasury cannot pay for it. Nothing is stored: the corporation, its president, the train and its price,
//   the treasury, the president's cash and the shortfall are all read off the state, so a rebuild owes what
//   the play owed and a sale that changed a price changes the next answer by itself.
//
// THE MONEY, IN THE RULEBOOK'S ORDER. The corporation spends ALL its money (6.6.2); the president covers the
// difference from personal cash; what the president cannot cover is the SHORTFALL and is the only thing a
// forced sale may raise. So `shortfall = cost - treasury - presidentCash`, floored at zero -- and while it
// is zero the president MUST buy ("they must purchase the cheapest train available") and may not sell.
//
// THE FORCED SALE IS THE ORDINARY `SellStock`, judged by the ordinary rules plus three of 6.6.3's, applied
// only while this obligation stands and only to its president: (a) the rescued corporation's presidency may
// not change -- a sale of its shares is projected through `presidentFor` and refused if the crown would move
// (it may otherwise be sold, which the old plan forbade outright); (b) only enough -- a bundle is refused
// when one certificate fewer would already cover the shortfall, so the LAST certificate may overshoot and
// its proceeds are the real proceeds, never truncated; (c) once treasury + cash covers the price, no sale.
// Price movement, the Bank Pool's ceiling, the double certificate and presidency changes in OTHER
// corporations all happen exactly as in a Stock Round, because it is the same arm.
//
// ==================================================================
//  DESIGN NOTE 1541: THE EMERGENCY PRIVATE SALE, AND THE ONE DECLARATION THE RULES LEAVE TO THE PLAYER
// ==================================================================
// 6.6.3: "the president must sell his shares and/or private companies until he raises enough" ... "The
// president may sell private companies he owns (if he can find a buyer), but he is not required to do so."
// The ordinary private transaction (3.0/3.1) is player -> corporation, only: "During phases 3 and 4, a
// railroad may buy a private company at any time during its turn in an operating round"; "The price paid
// may not be less than half or more than twice the face value"; "Private companies may be bought by railroad
// corporations but not sold by them."
//
// WHAT 6.6.3 OVERRIDES, AND WHAT IT DOES NOT SAY. The rulebook does not state which of 3.0/3.1's restrictions
// are relaxed for a forced-funding sale. Read literally, the only railroad "in its turn" is the one without
// money, which has "put aside all of [its] money" -- so a buyer could never be found. The owner's decision
// (recorded here as such): the buyer's OWN-TURN timing is relaxed -- any eligible corporation may buy, its
// president answering off-turn -- and every other ordinary restriction stands, because 6.6.3 gives no reason
// to drop it: phases 3 and 4 only; half to twice face value; the buyer pays from its treasury and must hold
// the price; the B&O private is never sold to a corporation; a corporation never resells; and the rescued
// corporation itself is not a buyer (its money is put aside). AMBIGUITY REPORTED, NOT RESOLVED BY GUESS:
// whether 6.6.3 meant to open the sale outside phases 3-4, or outside the band, is not written; both are
// kept as printed.
//
// THE SHAPE IS A SELLER-INITIATED DIRECTED OFFER: `OfferPrivateForFunding {private_id, buyer_protocol_id,
// price}` by the obligated president; `AnswerFundingPrivateOffer {accept}` by the BUYING corporation's
// president; `RescindFundingPrivateOffer` by the seller. Acceptance settles at once through the same
// transfer every corporate purchase uses (`transferPrivateToCorporation`): treasury to player, private to
// corporation for good, and the shortfall is simply re-read. A rejection or a withdrawal returns to the
// obligation. While an offer is outstanding, nothing else moves -- not even a share sale -- so the board
// the answer is given on is the board the offer was made on.
//
// OPTIONAL, NEVER FORCED. A private is never liquidated for the president and never a precondition of
// bankruptcy. But because a buyer may exist and only the president can ask, bankruptcy cannot be DERIVED
// while an offer is still possible: it is derived when no legal share sale remains AND no eligible buyer
// exists; it is DECLARED (`DeclareBankruptcy`, the obligated president only) when no legal share sale
// remains but a private could still be offered -- and refused, always, while any legal share sale stands,
// while the purchase is already funded, or while an offer is outstanding. A client cannot declare early.
//
// THE BANKRUPT PRESIDENT'S SCORE (6.6.3) is the market value of the shares he could not sell: cash is not
// counted -- it was "put aside" for the purchase -- and the player is ranked with everybody else; "it is
// possible ... that a bankrupt player can win". Written by the same transition that ends the game
// (`GameEnd`, `bankrupt_president`), the one fact the ended board must carry.
//
// ==================================================================
//  OWNER-DEFINED DIGITAL SIMPLIFICATION: THE INTERCORPORATE TRAIN PURCHASE DURING A FORCED OBLIGATION
// ==================================================================
// 6.6.2 lets the corporation buy "from ... another railroad using the normal rules", and 6.6.3's nested case
// -- a trade that the president must then fund by selling shares, which may change the SELLER's presidency,
// with its veto and unwind -- is deliberately NOT implemented. Instead (a deviation from the 2018 rulebook,
// chosen by the owner for the digital game): while a forced purchase is owed, a `BuyTrainFromCorporation`
// with the rescued corporation as buyer is permitted only when the buyer's treasury plus its president's
// currently available cash covers the agreed price; the treasury pays first and the president pays the rest
// (6.6.2's own funding order, and its face-value cap applies whenever the president contributes). If
// completing the trade would require any liquidation, that path is refused and the corporation resolves its
// obligation through the bank / Bank Pool instead. Recorded as a rule deviation, with tests.
//
// THE GATE. While the obligation stands, every message but the ones that resolve it is refused, in the core
// before any arm and at the ingress (`turnRefusal`): `SellStock` (the president's forced sale),
// `EmergencyBuyHardware` (the purchase, once funded), the voluntary trade family (6.6.2's "another railroad
// using the normal rules" -- under the simplification above), the funding private offer and its answer and
// withdrawal, `DeclareBankruptcy`, `DiscardTrain`/`CloseRoom` (their own obligations), and `RevertTo` at the
// log. While a funding offer is outstanding only its answer, its withdrawal, `CloseRoom` and `RevertTo`
// pass. After `GameEnd` everything but `CloseRoom` is refused.

import type { GameStateResponse, PublicCompanyState, PrivatePurchaseOffer } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";
import type { MapGridResponse } from "../components/hexContractTypes";
import { operatingCorporationId } from "./dividendGate";
import { cheapestPurchasableTrain, trainObligationFor, type PurchasableTrain } from "./trainAvailability";
import { TRAIN_PURCHASE_SUB_PHASE } from "./trainPurchaseGate";
import { shareSaleBlock, certificatesIn } from "./shareSale";
/* Design note #1624 (Slice 8.3): the projection MOVED to `presidencyTransfer.ts`, where the selection lives,
   because the share-sale gate wants it too (S9-14) and a second copy is #1184's failure mode. Imported
   rather than re-declared; 6.6.3 case (c) below is unchanged. */
import { presidentAfterSale } from "./presidencyTransfer";
import { SHARE_BLOCK_PERCENT } from "./endgame";
import { derivePhase } from "./gamePhase";
import { isSellableToCorporation } from "./baltimorePrivate";
import { privatePriceBounds, privatePurchasePhaseOpen } from "./privatePriceBand";

/** The last-resort price on a LEGACY or chartless board -- the same figure, and the same D-9 reason, as the
 *  reducer's `SANDBOX_NOMINAL_SHARE_PRICE`. Never consulted on a board this engine dealt (#1640). */
const NOMINAL_SHARE_PRICE = 67;


export interface EmergencyFunding {
  companyId: number;
  ticker: string;
  president: string;
  /** The one required train (#1512): the cheapest the bank sells, depot or pool. */
  train: PurchasableTrain;
  treasury: number;
  presidentCash: number;
  /** What forced sales must still raise. Zero means the purchase can -- and must -- be made now. */
  shortfall: number;
  canPurchase: boolean;
  /** Every legal forced sale the president could make right now, by corporation. */
  legalSales: LegalForcedSale[];
  /** #1541: every private the president could offer, with its price band and the corporations that could buy. */
  legalPrivateSales: LegalPrivateSale[];
  /** #1541: the seller-initiated offer awaiting the buying president's answer, if one stands. */
  privateOffer: PrivatePurchaseOffer | null;
  /** #1541: no legal share sale remains and no private could be offered: bankruptcy is derived and the game
   *  ends in this transition. */
  bankrupt: boolean;
  /** #1541: no legal share sale remains but a private could still be offered: the president may declare. */
  canDeclareBankruptcy: boolean;
}

export interface LegalPrivateSale {
  privateId: number;
  name: string;
  faceValue: number;
  minPrice: number;
  maxPrice: number;
  /** Corporations that may buy it now: floated, presided, not the rescued one, treasury at least `minPrice`. */
  buyers: Array<{ companyId: number; ticker: string; president: string; treasury: number }>;
}

export interface LegalForcedSale {
  companyId: number;
  ticker: string;
  heldPercent: number;
  pricePerShare: number;
  /** Bundles the president may sell, in percent, ascending -- each one legal on its own. */
  bundles: number[];
  /** The largest legal bundle (the modal's cap). */
  maxPercent: number;
  /** Why nothing larger, for the shell. */
  restriction: string | null;
}

/** The price a share of this corporation fetches, as the sale arm prices it -- or `null` when it has none.
 *
 *  ==================================================================
 *   DESIGN NOTE 1640 (Slice 8.5, S8-8): AN UNPARRED CORPORATION HAS NO PRICE, SO IT IS NOT PROJECTED
 *  ==================================================================
 *  THIS WAS THE LAST `?? 67` ON THE BOARD, and it was a SECOND ladder. `gameState.sharePriceFor` -- the one
 *  every display reads -- has answered "market, then par, then nothing to sell" since #711, which retired
 *  exactly this kind of divergent second reading. This one had no par step and no bottom: a corporation with
 *  no token on the chart was worth $67, whatever the board said about it.
 *
 *  AND IT WAS REACHABLE, which is why it is Stage 8's and not hygiene. `stockSaleRefusal` refuses every sale
 *  of an unparred corporation (rule 4, Batch 7.2) and every sale on a pinned board of a corporation with no
 *  mark (rule 5) -- but `legalForcedSales` asks `forcedSaleRefusal` DIRECTLY, one layer below those rules, so
 *  the 6.6.3 projection could offer the president a share nothing would ever buy, priced at a number nobody
 *  chose, and count it toward whether a bankruptcy was avoidable. The C&A's PRR share and the M&H's NYC share
 *  before its president's certificate is bought are precisely the shares that reach that state (rulebook
 *  p. 15: they cannot be sold until the President's Certificate has been purchased).
 *
 *  `null` RATHER THAN ZERO, because zero is a price and this is the absence of one: the two callers below
 *  refuse and skip respectively, and neither divides by it.
 *
 *  THE PINNED / LEGACY SPLIT IS BATCH 7.2's, NOT A NEW ONE, and it is why the nominal is still in this file.
 *  §7.2 rule 4 already decided what a MISSING MARK means: on a board this engine dealt (`pinnedBoard`) a
 *  corporation with no token has no price and the trade is refused; on a legacy or chartless board it keeps
 *  the reducer's nominal, for D-9's reason -- "the development corpus and the hand-built fixtures predate the
 *  invariant that every parred corporation has a mark, and refusing there would strand a replay on a rule its
 *  game never had". This function now answers the same way, so the projection and the sale gate agree about
 *  every board instead of about only the charted ones.
 *
 *  WHAT CHANGED IS THE UNPARRED CASE, and it changes on EVERY board: a corporation that has not been started
 *  has no price anywhere, pinned or legacy, because there is nothing a sale of it could be settled at
 *  (`stockSaleRefusal` rule 4, S8-8). That is the whole of the Stage-8 residual.
 *
 *  `SANDBOX_NOMINAL_SHARE_PRICE` in the reducer is the same last resort at the other atom and stays for the
 *  same D-9 reason; Batch 7.2 already made it unreachable on any pinned board. */
export function sharePriceFor(state: GameStateResponse, companyId: number): number | null {
  const mark = state.market_positions?.[companyId]?.price;
  if (typeof mark === "number" && Number.isFinite(mark) && mark > 0) return mark;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  // S8-8: unstarted, so unpriced -- on every board, and whatever the chart does or does not say.
  if (!company || company.par_value === null || company.par_value === undefined) return null;
  // §7.2 rule 4's split, restated: no nominal on a board this engine dealt.
  return typeof state.rules_engine_version === "number" ? null : NOMINAL_SHARE_PRICE;
}

function cashOf(state: GameStateResponse, player: string): number {
  const cash = Number(state.player_cash.find((entry) => entry.player === player)?.cash_vgp ?? 0);
  return Number.isFinite(cash) ? cash : 0;
}

/** The obligation as it stands, or `null`. `mapGrid` is what the route walk needs; without one there is no
 *  opinion (#757), which is the fixture case. */
export function emergencyFundingFor(
  state: GameStateResponse,
  mapGrid: MapGridResponse | undefined,
): EmergencyFunding | null {
  if (state.current_round_type !== "OperatingRound") return null;
  if (state.operating_sub_phase !== TRAIN_PURCHASE_SUB_PHASE) return null;
  const companyId = operatingCorporationId(state);
  if (companyId === null) return null;
  if (trainObligationFor(state, companyId, mapGrid).owed !== true) return null;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company || !company.president) return null;
  const train = cheapestPurchasableTrain(state);
  if (!train) return null;
  const treasury = Math.max(0, Number(company.treasury) || 0);
  if (treasury >= train.cost) return null; // the corporation pays alone: an ordinary purchase, Batch 4's gate
  const presidentCash = cashOf(state, company.president);
  const shortfall = Math.max(0, train.cost - treasury - presidentCash);
  const skeleton = {
    companyId,
    ticker: company.ticker,
    president: company.president,
    train,
    treasury,
    presidentCash,
    shortfall,
    canPurchase: shortfall === 0,
  };
  const privateOffer = state.private_purchase_offer?.funding ? state.private_purchase_offer : null;
  const legalSales = shortfall === 0 ? [] : legalForcedSales(state, skeleton);
  const legalPrivateSales = shortfall === 0 ? [] : legalPrivateSalesFor(state, skeleton);
  const sharesExhausted = shortfall > 0 && legalSales.length === 0;
  return {
    ...skeleton,
    legalSales,
    legalPrivateSales,
    privateOffer,
    bankrupt: sharesExhausted && legalPrivateSales.length === 0 && privateOffer === null,
    canDeclareBankruptcy: sharesExhausted && privateOffer === null,
  };
}

/** #1541: the privates the president could offer, with the corporations that could buy each. */
export function legalPrivateSalesFor(
  state: GameStateResponse,
  funding: Pick<EmergencyFunding, "companyId" | "president">,
): LegalPrivateSale[] {
  if (!privatePurchasePhaseOpen(derivePhase(state)?.tier ?? null)) return [];
  const out: LegalPrivateSale[] = [];
  for (const priv of state.private_companies ?? []) {
    if (priv.owner !== funding.president || priv.closed) continue;
    if (!isSellableToCorporation(priv.private_id)) continue;
    const faceValue = Number(priv.cost) || 0;
    const { min, max } = privatePriceBounds(faceValue);
    const buyers = state.public_companies
      .filter(
        (company) =>
          company.company_id !== funding.companyId &&
          company.is_floated &&
          !!company.president &&
          (Number(company.treasury) || 0) >= min,
      )
      .map((company) => ({
        companyId: company.company_id,
        ticker: company.ticker,
        president: company.president as string,
        treasury: Number(company.treasury) || 0,
      }));
    if (buyers.length === 0) continue;
    out.push({ privateId: priv.private_id, name: priv.name, faceValue, minPrice: min, maxPrice: max, buyers });
  }
  return out;
}

/** #1541: why this funding offer may not be made, or `null`. */
export function fundingPrivateOfferRefusal(
  state: GameStateResponse,
  funding: EmergencyFunding,
  offer: { private_id: number; buyer_protocol_id: number; price: number },
  actor?: string | null,
): string | null {
  if (actor != null && actor !== funding.president) return `Only ${funding.ticker}'s president can offer a private company to fund its train.`;
  if (funding.privateOffer !== null) return "An offer is already waiting for an answer.";
  if (state.train_purchase_offer && !state.train_purchase_offer.accepted) return "A train offer is already waiting for an answer.";
  return fundingPrivateSaleRefusal(state, funding, offer);
}

/** #1541: THE TRANSACTION'S OWN LEGALITY, asked twice -- when the offer is made and again when it is accepted
 *  (`fundingPrivateAnswerRefusal`), against the board as it then stands. A proposal reserves nothing: the
 *  private must still be the obligated president's and open, the buyer still a presided corporation other than
 *  the rescued one with the price in its treasury, the phase still 3 or 4, the price still within the band, the
 *  shortfall still positive, and the B&O ban still in force. The freeze makes a change between the two moments
 *  unlikely; the authority does not rely on it. */
export function fundingPrivateSaleRefusal(
  state: GameStateResponse,
  funding: EmergencyFunding,
  offer: { private_id: number; buyer_protocol_id: number; price: number },
): string | null {
  if (funding.shortfall <= 0) return `${funding.ticker} and its president can already pay for the train — no sale is needed.`;
  const sale = legalPrivateSalesFor(state, funding).find((entry) => entry.privateId === offer.private_id);
  if (!sale) {
    const priv = state.private_companies.find((entry) => entry.private_id === offer.private_id);
    if (!priv || priv.owner !== funding.president) return "That is not a private company you own.";
    if (priv.closed) return `${priv.name} has closed and cannot be sold.`;
    if (!isSellableToCorporation(priv.private_id)) return `${priv.name} may never be sold to a corporation.`;
    if (!privatePurchasePhaseOpen(derivePhase(state)?.tier ?? null)) return "Corporations may buy private companies only during phases 3 and 4.";
    return `No corporation can buy ${priv.name} right now.`;
  }
  if (!Number.isInteger(offer.price) || offer.price < sale.minPrice || offer.price > sale.maxPrice) {
    return `The price must be a whole number between $${sale.minPrice} and $${sale.maxPrice} (half to twice ${sale.name}'s $${sale.faceValue} face value).`;
  }
  const buyer = sale.buyers.find((entry) => entry.companyId === offer.buyer_protocol_id);
  if (!buyer) {
    if (offer.buyer_protocol_id === funding.companyId) return `${funding.ticker}'s money is put aside for the train; it cannot buy a private company now.`;
    return "That corporation cannot buy a private company now.";
  }
  if (buyer.treasury < offer.price) return `${buyer.ticker}'s treasury holds $${buyer.treasury} — it cannot pay $${offer.price}.`;
  return null;
}

/** #1541: why this answer may not be given, or `null`. The answering party is the BUYING corporation's president
 *  -- and an ACCEPTANCE is the settlement, so it is re-validated in full against the current board
 *  (`fundingPrivateSaleRefusal`): the obligation must still stand, and every condition of the sale must still
 *  hold. Without a grid the obligation cannot be re-derived, and an acceptance moves money, so it is refused
 *  rather than admitted on the proposal's word (fail closed). A rejection needs no board. */
export function fundingPrivateAnswerRefusal(
  state: GameStateResponse,
  answer: { private_id: number; accept?: boolean },
  actor?: string | null,
  mapGrid?: MapGridResponse,
): string | null {
  const offer = state.private_purchase_offer ?? null;
  if (!offer || !offer.funding) return "There is no funding offer to answer.";
  if (offer.private_id !== answer.private_id) return "That is not the private company on offer.";
  const buyer = state.public_companies.find((company) => company.company_id === offer.buyer_protocol_id);
  if (actor != null && buyer?.president !== actor) return `Only ${offer.buyer_ticker}'s president can answer this offer.`;
  if (answer.accept !== true) return null;
  if (mapGrid === undefined) return "The sale cannot be settled without the board to judge the obligation on.";
  const funding = emergencyFundingFor(state, mapGrid);
  if (funding === null) return "No forced train purchase is owed any more, so the offer cannot be settled.";
  if (offer.owner !== funding.president) return "The offer is not the obligated president's.";
  return fundingPrivateSaleRefusal(state, funding, { private_id: offer.private_id, buyer_protocol_id: offer.buyer_protocol_id, price: offer.price });
}

/** #1541: why the seller may not withdraw, or `null`. */
export function fundingPrivateRescindRefusal(
  state: GameStateResponse,
  rescind: { private_id: number },
  actor?: string | null,
): string | null {
  const offer = state.private_purchase_offer ?? null;
  if (!offer || !offer.funding) return "There is no funding offer to withdraw.";
  if (offer.private_id !== rescind.private_id) return "That is not the private company on offer.";
  if (actor != null && actor !== offer.owner) return "Only the seller can withdraw this offer.";
  return null;
}

/** #1541: why bankruptcy may not be declared, or `null`. Never while a legal share sale stands. */
export function declareBankruptcyRefusal(
  funding: EmergencyFunding | null,
  actor?: string | null,
): string | null {
  if (funding === null) return "No forced train purchase is owed, so nobody is bankrupt.";
  if (actor != null && actor !== funding.president) return `Only ${funding.ticker}'s president can declare bankruptcy.`;
  if (funding.canPurchase) return `${funding.ticker} and its president can pay for the train; the purchase must be made.`;
  if (funding.privateOffer !== null) return "A private-company offer is still waiting for an answer.";
  if (funding.legalSales.length > 0) {
    return `A share sale is still possible (${funding.legalSales.map((sale) => sale.ticker).join(", ")}); bankruptcy cannot be declared while it is.`;
  }
  return null;
}

/* ==================================================================
    OWNER-DEFINED SIMPLIFICATION (see the header): the intercorporate trade while a purchase is owed
   ================================================================== */
/** Why the rescued corporation may not complete this trade, or `null` with how it is funded. */
export function fundedTradeRefusal(
  state: GameStateResponse,
  funding: EmergencyFunding,
  buyerId: number,
  price: number,
  faceValue: number | null,
): string | null {
  if (buyerId !== funding.companyId) return null; // somebody else's trade is not this obligation's business
  const treasury = funding.treasury;
  if (price <= treasury) return null;
  const presidentCash = funding.presidentCash;
  if (treasury + presidentCash < price) {
    return (
      `${funding.ticker} and its president hold $${treasury + presidentCash} together and cannot pay $${price} without ` +
      "selling shares or private companies; a forced purchase is completed through the Bank instead (owner rule)."
    );
  }
  if (faceValue !== null && price > faceValue) {
    return `When the president contributes, a train bought from another corporation may not cost more than its $${faceValue} face value (rulebook 6.6.2).`;
  }
  return null;
}

/** Why this sale is not a legal forced sale, or `null`. Asked of every `SellStock` while the obligation
 *  stands -- in the core (by identity), at the market step (so no token moves for a refused sale), and at the
 *  ingress. `funding` is the standing obligation. */
export function forcedSaleRefusal(
  state: GameStateResponse,
  funding: Pick<EmergencyFunding, "companyId" | "ticker" | "president" | "shortfall">,
  seller: string,
  companyId: number,
  percentage: number,
): string | null {
  if (seller !== funding.president) {
    return `Only ${funding.ticker}'s president can sell shares to fund its train.`;
  }
  if (funding.shortfall <= 0) {
    return `${funding.ticker} and its president can now pay for the train — no further sale is allowed; the purchase must be made.`;
  }
  const ordinary = shareSaleBlock({ state, seller, companyId, percentage });
  if (ordinary !== null) return ordinary;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return "That corporation is not on this board.";
  /* 6.6.3: the rescued corporation's presidency may not change. Projected through the same rule every other
     change uses (`presidentFor`, #596): the crown moves only to a holder with strictly more.
     Design note #1620 (Slice 8.3): AND THROUGH THE SAME TIE-BREAK. The projection is handed
     `state.player_addresses`, so the successor it predicts is the successor `settlePresidencies` will
     actually crown -- a predictor with a different tie rule would refuse a legal sale, or allow one whose
     settlement then moved the crown the rule says a forced sale may not move. */
  if (
    companyId === funding.companyId &&
    presidentAfterSale(company, seller, percentage, state.player_addresses ?? []) !== company.president
  ) {
    return `Selling ${percentage}% of ${company.ticker} would hand its presidency to another player, which a forced sale may not do.`;
  }
  /* Design note #1640 (S8-8): NO PRICE, NO SALE -- the same fact `stockSaleRefusal` states as rules 4 and 5,
     asked here because `legalForcedSales` reaches this function directly and would otherwise project a sale
     of a share that cannot be sold. An unparred corporation has no price for a sale to be settled at, and a
     corporation whose token is not on the chart has none either. */
  const price = sharePriceFor(state, companyId);
  if (price === null) {
    return company.par_value === null || company.par_value === undefined
      ? `${company.ticker} has not been started yet — a share of it cannot be sold until its President's Certificate has been bought and its par set.`
      : `${company.ticker} has no price on the market chart, so a sale of it cannot be settled.`;
  }
  /* 6.6.3: only enough. A bundle one certificate smaller that still covers the shortfall means this one is
     more than enough. The last certificate may overshoot -- that is the rule's own arithmetic. */
  const certificates = certificatesIn(percentage);
  if (certificates > 1 && price * (certificates - 1) >= funding.shortfall) {
    const needed = Math.max(1, Math.ceil(funding.shortfall / Math.max(1, price)));
    return `Only enough may be sold: ${needed} certificate${needed === 1 ? "" : "s"} of ${company.ticker} at $${price} covers the $${funding.shortfall} still needed.`;
  }
  return null;
}

/** Every legal forced sale, corporation by corporation, judged bundle by bundle against the current board. */
export function legalForcedSales(
  state: GameStateResponse,
  funding: Pick<EmergencyFunding, "companyId" | "ticker" | "president" | "shortfall">,
): LegalForcedSale[] {
  const out: LegalForcedSale[] = [];
  for (const company of state.public_companies) {
    const held = company.player_holdings.find((entry) => entry.player === funding.president)?.percentage ?? 0;
    if (held <= 0) continue;
    /* Design note #1640 (S8-8): SKIPPED, not valued. `forcedSaleRefusal` refuses every bundle of a priceless
       corporation anyway, so this only states the rule where a reader looks for it -- and it keeps
       `pricePerShare` a price rather than a fallback. */
    const price = sharePriceFor(state, company.company_id);
    if (price === null) continue;
    const bundles: number[] = [];
    let restriction: string | null = null;
    for (let percentage = SHARE_BLOCK_PERCENT; percentage <= held; percentage += SHARE_BLOCK_PERCENT) {
      const refusal = forcedSaleRefusal(state, funding, funding.president, company.company_id, percentage);
      if (refusal === null) bundles.push(percentage);
      else if (restriction === null) restriction = refusal;
    }
    if (bundles.length === 0) continue;
    out.push({
      companyId: company.company_id,
      ticker: company.ticker,
      heldPercent: held,
      pricePerShare: price,
      bundles,
      maxPercent: bundles[bundles.length - 1],
      restriction,
    });
  }
  return out;
}

/** The messages that may resolve the obligation; everything else is held. */
export function resolvesEmergencyFunding(msg: SandboxLogMsg): boolean {
  return (
    "SellStock" in msg ||
    "EmergencyBuyHardware" in msg ||
    "BuyTrainFromCorporation" in msg ||
    "ProposeTrainPurchase" in msg ||
    "AnswerTrainPurchase" in msg ||
    "RescindTrainOffer" in msg ||
    "RescindTrainPurchase" in msg || // #1594: the sandbox's own withdrawal of the trade family's offer
    "OfferPrivateForFunding" in msg ||
    "AnswerFundingPrivateOffer" in msg ||
    "RescindFundingPrivateOffer" in msg ||
    "DeclareBankruptcy" in msg ||
    "DiscardTrain" in msg ||
    "CloseRoom" in msg ||
    "RevertTo" in msg
  );
}

/** #1541: while a funding offer waits for its answer, only the answer, the withdrawal and the room's own pass. */
function passesWhileOfferStands(msg: SandboxLogMsg): boolean {
  return (
    "AnswerFundingPrivateOffer" in msg ||
    "RescindFundingPrivateOffer" in msg ||
    "CloseRoom" in msg ||
    "RevertTo" in msg
  );
}

/** Why this message is held while the obligation stands (or after the game has ended), or `null`. */
export function emergencyFundingBlock(
  state: GameStateResponse,
  msg: SandboxLogMsg,
  mapGrid: MapGridResponse | undefined,
): string | null {
  if (state.current_round_type === "GameEnd" && !("CloseRoom" in msg) && !("RevertTo" in msg)) {
    return state.bankrupt_president
      ? "The game has ended — a president went bankrupt. Nothing further can be played."
      : "The game has ended. Nothing further can be played.";
  }
  /* #1541: an outstanding funding offer freezes the board -- the answer is given on the board the offer was
     made on. Asked of the offer directly, so it holds even where the grid is absent. */
  if (state.private_purchase_offer?.funding && !passesWhileOfferStands(msg)) {
    return `${state.private_purchase_offer.private_name} is on offer to ${state.private_purchase_offer.buyer_ticker}; nothing else can happen until its president answers or the seller withdraws.`;
  }
  if (resolvesEmergencyFunding(msg)) return null;
  const funding = emergencyFundingFor(state, mapGrid);
  if (funding === null) return null;
  return (
    `${funding.ticker} must buy a ${funding.train.tier}-train ($${funding.train.cost}) and cannot pay for it; ` +
    `its president must fund the purchase before anything else happens.`
  );
}

/** Why this `EmergencyBuyHardware` may not be made, or `null`: the obligation must stand and be funded. */
export function emergencyPurchaseRefusal(
  state: GameStateResponse,
  companyId: number,
  mapGrid: MapGridResponse | undefined,
  actor?: string | null,
): string | null {
  const funding = emergencyFundingFor(state, mapGrid);
  if (funding === null) {
    /* Without a grid the obligation cannot be judged (#757): the arm's own checks stand alone, which is the
       fixture case. With one, an unowed emergency purchase is refused -- the president's money is only ever
       spent on a forced purchase (6.6.2). */
    return mapGrid === undefined ? null : "No forced train purchase is owed, so the president's money may not be used.";
  }
  if (funding.companyId !== companyId) return `${funding.ticker} is the corporation that must buy a train.`;
  if (actor != null && actor !== funding.president) return `Only ${funding.ticker}'s president can make the emergency purchase.`;
  if (funding.privateOffer !== null) return "A private-company offer is still waiting for an answer.";
  if (!funding.canPurchase) {
    return funding.bankrupt
      ? `${funding.ticker} and its president cannot raise $${funding.train.cost} — the president is bankrupt.`
      : `${funding.ticker} and its president are $${funding.shortfall} short; the president must sell shares first.`;
  }
  return null;
}
