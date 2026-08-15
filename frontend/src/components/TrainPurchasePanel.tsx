// frontend/src/components/TrainPurchasePanel.tsx
//
// The Buy Trains step's action panel -- two sources, two sections.
//
// ===================================================================
//  DESIGN NOTE 0: WHY BANK AND CORPORATION ARE NOT ONE CONTROL
// ===================================================================
//
// A corporation in the Hardware sub-phase can acquire a train two ways, and
// they are different transactions in every respect that matters:
//
//   FROM THE BANK DEPOT. A fixed price, a finite printed supply, a strict
//   cheapest-first queue, and a purchase that can END THE PHASE -- buying
//   the depot's last 3-train launches Phase 4 and rusts every 2-train on the
//   board. Nobody consents; the bank always sells.
//
//   FROM ANOTHER CORPORATION. Any price of $1 or more, no supply question at
//   all, no phase advance and no rusting -- and a counterparty who has to
//   agree, unless one player happens to preside over both companies.
//
// The old panel put a corporation-to-corporation offer form under the
// heading "Buy a train from another corporation" and the depot purchase in a
// completely separate tray elsewhere on the page, so the two halves of one
// decision were never on screen together. This is one panel with two clearly
// separated sections, and the corporate half is COLLAPSED by default because
// the bank is the ordinary case and a trade is the exception.
//
// ===================================================================
//  DESIGN NOTE 1: THE QUANTITY FIELD IS A CONVENIENCE, NOT A BATCH
// ===================================================================
//
// `ExecuteMsg::BuyHardwareFromPool` carries no quantity. So "buy 3" is three
// sequential messages, exactly as `StockRoundPanel`'s multi-buy is N
// sequential `BuyStock`s (App.tsx design note #42) -- and for the same
// reason: firing them in parallel would race the depot's own accounting and
// could leave a corporation having bought fewer trains than the log claims.
//
// The cap is `min(depot supply, train limit - owned)` and the quantity
// control LISTS it rather than validating against it -- a `<select>` whose
// options are exactly the buyable quantities, so there is nothing to type
// and nothing to reject. See design note #247 for why the previous
// clamp-on-type input read as a control refusing valid input.
//
// ONE TIER PER SUBMISSION, deliberately. 1830's depot is a strict queue --
// only the cheapest tier still in stock is purchasable -- so a player who
// wants a 3-train and a 4-train is describing two separate situations
// separated by a phase change, not one order. The panel says so rather than
// offering a basket that cannot exist.
//
// ===================================================================
//  DESIGN NOTE 2: A TRAIN BADGE IS THE WHOLE INTERACTION
// ===================================================================
//
// Composing a trade used to mean three dropdowns: pick a corporation, pick a
// model, type a price. The middle one was the problem -- it listed all six
// models whether or not the seller owned any, greying out the ones they did
// not, so the commonest question ("who has a 4-train I could buy?") was
// answered by opening six dropdowns one seller at a time.
//
// The roster now shows every corporation's actual trains as clickable
// badges. The question is answered by looking, and clicking the answer IS
// the selection -- seller and model in one gesture, with only a price left
// to type.
//
// ===================================================================
//  DESIGN NOTE 3: ONE TRAIN PER TRADE
// ===================================================================
//
// `BuyTrainFromCorporation` names a single `model_type` and no count, and
// `train_trade.rs` records one offer at a time per buyer. A multi-train
// trade would therefore be several offers, each separately acceptable --
// which is a negotiation the contract cannot express and this panel will not
// pretend to. The limit is stated in the UI rather than merely enforced, so
// a player planning a two-train deal finds out before composing it.

import React, { useEffect, useMemo, useState } from "react";

import { FONT_SIZE } from "../styles/typography";
import { corporationLabel } from "../utils/corporationNames";
import type { DepotTier } from "../utils/gamePhase";
import { stationTickerColor } from "./hexContractTypes";

/** The subset of a corporation both sections need. */
export interface TrainPurchaseCompany {
  company_id: number;
  ticker: string;
  president: string | null;
  /** `Uint128` on the wire, so a string here too. */
  treasury: string;
  /** Models currently held, e.g. `["2", "2", "4"]`. Duplicates are
   *  meaningful and drive the badge counts.
   *
   *  `null`/`undefined` means UNKNOWN -- a chain predating
   *  `PublicCompanyState.owned_trains` -- not "owns nothing". The corporate
   *  section says so rather than rendering an empty roster that looks like a
   *  board where nobody has bought a train. */
  owned_trains?: string[] | null;
}

/** What a player is proposing, before anybody has answered. */
export interface TrainTradeProposal {
  sellerProtocolId: number;
  sellerTicker: string;
  /** The wallet whose consent 1830 requires, or `null` for a corporation
   *  with no president on record. */
  sellerPresident: string | null;
  sellerPresidentLabel: string;
  buyerProtocolId: number;
  buyerTicker: string;
  modelType: string;
  /** Kept as a STRING all the way through -- `price` is `Uint128` on-chain
   *  and parsing to `Number` here would be a silent precision bug for no
   *  benefit. */
  price: string;
}

/** A price is any integer of at least 1 -- `train_trade::MINIMUM_TRAIN_PRICE`.
 *  Validated as a STRING; see `TrainTradeProposal.price`. */
export function trainPriceError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Enter a price.";
  if (!/^\d+$/.test(trimmed)) return "Whole numbers only.";
  if (/^0+$/.test(trimmed)) return "A train must sell for at least $1.";
  return null;
}

/* `countByModel` is GONE with design note #282. It collapsed a roster into
   model-and-count for the trade badges, and nothing else ever wanted that
   shape -- the corporation table has always drawn one chip per train.
   Deleted rather than left unused so the grouped rendering cannot quietly
   come back. */


export interface TrainPurchasePanelProps {
  /** Every tier, from `gamePhase.depotInventory` -- already carrying the
   *  queue rule, the remaining stock and the sold-out/rusted flags. */
  depot: readonly DepotTier[];
  /** The corporation whose Operating Round turn it is. `null` outside one. */
  buyer: TrainPurchaseCompany | null;
  companies: readonly TrainPurchaseCompany[];
  sessionReady: boolean;
  /** The viewer presides over `buyer`, and so may act for it. */
  canAct: boolean;
  /** Why a new offer cannot be composed right now (one is already
   *  outstanding), or `null`. Stated rather than left as a dead button. */
  blockedReason: string | null;
  /** `quantity` sequential `BuyHardwareFromPool` messages -- design note #1. */
  onBuyFromBank: (tier: string, quantity: number) => void;
  /** Raises a proposal. Dispatches nothing itself: whether this completes
   *  immediately or waits on the seller is the caller's decision, because
   *  only the caller knows who is signing. */
  onProposeTrade: (proposal: TrainTradeProposal) => void;
  /** Renders a wallet as a readable name. */
  labelForAddress: (address: string) => string;
  /** Whether the corporate-trade accordion starts open. Defaults to closed,
   *  which is the shipping behaviour -- design note #0's argument that the
   *  bank is the common case and the trade section is the exception.
   *
   *  Exists so the section can be rendered without a DOM to click it open
   *  with. A test that cannot reach a surface cannot check it, and this
   *  section carries the train-limit gate. */
  defaultCorporateOpen?: boolean;
}

export function TrainPurchasePanel({
  depot,
  buyer,
  companies,
  sessionReady,
  canAct,
  blockedReason,
  onBuyFromBank,
  onProposeTrade,
  labelForAddress,
  defaultCorporateOpen = false,
}: TrainPurchasePanelProps) {
  /* ---- Bank section state ---- */
  const [quantityText, setQuantityText] = useState("1");

  /* ---- Corporate section state ---- */
  const [corporateOpen, setCorporateOpen] = useState(defaultCorporateOpen);
  /* Design note #282: `position` indexes into the seller's `owned_trains`,
     which is what tells two identical models apart. The dispatch still
     names only the model -- `BuyTrainFromCorporation` has no notion of
     which copy, and one 3-train is interchangeable with another -- so this
     exists purely so the badge the player clicked is the badge that looks
     selected. */
  const [selection, setSelection] = useState<{
    sellerId: number;
    model: string;
    position: number;
  } | null>(null);
  const [priceText, setPriceText] = useState("1");

  // Design note #182 (App.tsx): the depot sells the cheapest tier it still
  // holds, and only that one. `depotInventory` already applies the queue
  // rule, so this is a `find` rather than a second derivation.
  const nextTier = useMemo(
    () => depot.find((row) => row.remaining === null || row.remaining > 0) ?? null,
    [depot],
  );

  const depotSupply = nextTier === null ? 0 : (nextTier.remaining ?? 99);

  /* ==================================================================
   *  DESIGN NOTE 230: THE TRAIN LIMIT IS A SECOND, TIGHTER CEILING
   * ==================================================================
   *
   * REPORTED BUG: the Buy Trains action lets a corporation exceed its
   * maximum train limit.
   *
   * The panel capped quantity at the DEPOT'S SUPPLY and nothing else, so a
   * corporation one train below its limit could buy four more as long as the
   * bank had them. 1830 caps holdings per corporation by PHASE -- four
   * through Phases 2-3, three in Phase 4, two from Phase 5 -- and
   * `depotInventory` already reports that figure per tier as `trainLimit`.
   * It was being displayed and not enforced, which is the worst of both:
   * the number was on screen while the control ignored it.
   *
   * THE BINDING CEILING IS WHICHEVER IS SMALLER. A corporation two trains
   * short of its limit facing a depot with five may buy two; one facing a
   * depot with one may buy one. Both are caps on the same field, so the
   * field takes the minimum and the message names whichever one bit.
   *
   * ZERO HEADROOM IS ITS OWN STATE, not a quantity error. "Enter a number
   * between 1 and 0" is nonsense; "Train limit reached" is the actual
   * situation, and it is a reason to move on rather than to retype.
   */
  /* ==================================================================
   *  DESIGN NOTE 296: THE NUMBER WAS ALREADY IN THE FUTURE TENSE
   * ==================================================================
   *
   * REPORTED: the train-limit readout confuses players -- it shows the
   * limit that will apply AFTER the purchase, labelled as though it were
   * the current one.
   *
   * The previous pass renamed it "Corp train limit", which fixed a
   * different confusion (bank stock versus corporation ceiling) and left
   * this one untouched -- arguably made it worse, since a more confident
   * label on a wrong-tense number is a more convincing wrong answer.
   *
   * THE BUG IS IN THE VALUE, NOT ONLY THE WORDS. `trainLimit` reads
   * `nextTier.trainLimit`, and `DepotTier.trainLimit` is documented as
   * "trains one corporation may hold ONCE THIS TIER IS THE CURRENT PHASE".
   * The next tier is not the current phase whenever the depot has moved on
   * -- so in Phase 3 with the 2s and 3s sold out, the panel read "/ 3"
   * while the real limit was 4. Measured on the real fixture before this
   * note was written.
   *
   * Both figures are now derived and named:
   *
   *   `currentTrainLimit` -- the phase the corporation is in RIGHT NOW.
   *   `limitAfterPurchase` -- the phase the next purchase brings.
   *
   * They are equal on the ordinary purchase (buying a 3-train during Phase
   * 3 changes nothing) and differ on exactly the purchase that advances the
   * phase, which is the one worth warning about.
   *
   * ENFORCEMENT STAYS ON THE AFTER-VALUE, deliberately. Buying the first
   * 4-train starts Phase 4 and the limit drops with it, so a corporation
   * cannot end that purchase holding more than the new ceiling -- capping
   * against the old one would offer a quantity the rules take back. What
   * was wrong was never the arithmetic; it was that the screen did not say
   * which moment the number belonged to. */
  const ownedTrainCount = buyer?.owned_trains?.length ?? 0;
  const currentTrainLimit = useMemo(
    () => depot.find((row) => row.isCurrent)?.trainLimit ?? null,
    [depot],
  );
  const limitAfterPurchase = nextTier?.trainLimit ?? null;
  /** The selected purchase advances the phase into a TIGHTER ceiling. */
  const limitDropsOnPurchase =
    currentTrainLimit !== null &&
    limitAfterPurchase !== null &&
    limitAfterPurchase !== currentTrainLimit;
  const trainLimit = nextTier?.trainLimit ?? Infinity;
  const limitHeadroom = Math.max(0, trainLimit - ownedTrainCount);
  const atTrainLimit = limitHeadroom === 0;
  const supplyCap = Math.min(depotSupply, limitHeadroom);

  /* ==================================================================
   *  DESIGN NOTE 219: THE CAP MOVES WHILE THE FIELD IS SITTING THERE
   * ==================================================================
   *
   * Clamping on keystroke is not enough on its own. The depot's supply is
   * not a constant this panel owns -- it is derived from what every
   * corporation owns, so it drops when ANY of them buys, including this one.
   * Two ordinary sequences leave a stale number in the box:
   *
   *   - buy 2 of the 3 remaining trains, and the field still reads 2 against
   *     a supply of 1;
   *   - another player's purchase lands on a poll while this panel is open.
   *
   * The submit guard catches both -- `quantityValid` re-reads `supplyCap`,
   * so the button disables and says why -- but a field showing a number the
   * player cannot buy, next to a button that refuses it, reads as the UI
   * being broken rather than as the depot having moved. Clamping down to the
   * new ceiling keeps the field describing something purchasable.
   *
   * DOWNWARD ONLY. A supply that grows (it cannot today, but a tier change
   * shifts `nextTier` and with it the cap) must not silently raise a
   * quantity the player typed -- that would be the UI buying more than they
   * asked for.
   */
  useEffect(() => {
    const cap = Math.max(1, supplyCap);
    setQuantityText((current) => {
      const parsed = Number(current);
      if (!Number.isFinite(parsed) || parsed <= cap) return current;
      return String(cap);
    });
  }, [supplyCap]);

  /* Design note #247: WHICH rule stopped the list where it did.
   *
   * With two ceilings in play and only one of them displayed, a player
   * facing "2 in the depot, 1 selectable" had no way to reconcile the two
   * numbers. This names the binding one, and says nothing at all when
   * neither is close -- a permanent explanation of a constraint nobody is
   * hitting is noise. */
  const bindingCeiling: string | null =
    nextTier === null || atTrainLimit
      ? null
      : limitHeadroom < depotSupply
        ? (limitDropsOnPurchase
            ? `Room for ${limitHeadroom} more -- this purchase drops the limit to ${limitAfterPurchase}.`
            : `Room for ${limitHeadroom} more before the ${trainLimit}-train limit.`)
        : depotSupply < 99 && depotSupply <= 2
          ? `Only ${depotSupply} left in the depot.`
          : null;

  const quantity = Number(quantityText);
  const quantityValid =
    Number.isInteger(quantity) && quantity >= 1 && quantity <= Math.max(1, supplyCap);
  const treasury = Number(buyer?.treasury ?? 0) || 0;
  const bankTotal = nextTier && quantityValid ? nextTier.cost * quantity : 0;
  const bankProblem: string | null =
    nextTier === null
      ? "The Bank Depot is empty -- every printed train has been bought."
      : atTrainLimit
        ? // Design note #230: the phase's own ceiling, named as such. A
          // corporation at its limit must sell or scrap before it can buy,
          // which is a different action in a different panel -- so this says
          // what is true rather than asking for a smaller number.
          (limitDropsOnPurchase
            ? `Buying a ${nextTier?.tier}-train would start the next phase and cut the limit to ${limitAfterPurchase}, and ${buyer?.ticker ?? "this corporation"} already holds ${ownedTrainCount}. Sell or scrap first.`
            : `Train limit reached -- ${buyer?.ticker ?? "this corporation"} already holds ${ownedTrainCount} of a maximum ${trainLimit} for this phase.`)
        : !quantityValid
          ? `Enter a whole number between 1 and ${Math.max(1, supplyCap)}.`
          : bankTotal > treasury
            ? `${buyer?.ticker ?? "This corporation"}'s treasury holds $${treasury} -- it cannot pay $${bankTotal}.`
            : null;

  /* ==================================================================
   *  DESIGN NOTE 281: THE LIMIT IS A LIMIT ON HOLDINGS, NOT ON THE BANK
   * ==================================================================
   *
   * REPORTED: the UI permits buying trains from other corporations even at
   * or over the train limit.
   *
   * It did, and the shape of the miss is instructive: design note #230 had
   * already enforced the cap -- on the BANK section, thoroughly, with a
   * headroom figure, a clamped quantity field and a named reason. The
   * corporate section a few hundred lines below shared none of it, because
   * the cap had been reasoned about as a property of buying FROM THE DEPOT
   * rather than as a property of the corporation's fleet.
   *
   * 1830 caps what a corporation may HOLD. Where the train comes from is
   * irrelevant -- four through Phases 2-3, three in Phase 4, two from Phase
   * 5, however it was acquired. A corporation at its limit buying from a
   * rival ends up over the limit exactly as it would buying from the bank,
   * and the contract would refuse it either way.
   *
   * So the same `atTrainLimit` gates both, and the reason is the same
   * sentence -- it is the same rule, and giving it two wordings would imply
   * two rules.
   *
   * IT DISABLES RATHER THAN HIDING. The rival's trains are still worth
   * seeing: knowing who holds what is what tells a president they need to
   * scrap before they can trade. A vanished section would answer a question
   * nobody asked by removing the one they did. */
  const tradeBlockedReason: string | null =
    blockedReason ??
    (atTrainLimit
      ? `Train limit reached -- ${buyer?.ticker ?? "this corporation"} already holds ${ownedTrainCount} of a maximum ${trainLimit} for this phase. Scrap or sell a train before buying another.`
      : null);
  const canTrade = canAct && sessionReady && tradeBlockedReason === null;

  /* ==================================================================
   *  DESIGN NOTE 232: ONLY LIST CORPORATIONS THAT HAVE SOMETHING TO SELL
   * ==================================================================
   *
   * REPORTED BUG: the accordion lists corporations with "no trains".
   *
   * It listed all seven, each with a "no trains" placeholder where its
   * badges would be, on the reasoning that a complete roster is easier to
   * scan than a filtered one. In practice the opposite: early in a game most
   * corporations own nothing, so the panel was mostly rows that could not be
   * acted on, and the two or three that COULD were buried among them. The
   * question this section answers is "who has a train I could buy", and a
   * row that answers "not this one" is noise.
   *
   * `owned_trains` UNDEFINED IS KEPT, and the distinction is load-bearing:
   * `undefined` means the chain did not say (a contract predating the
   * field), which is emphatically not "owns nothing". Filtering those out
   * would empty the whole section against such a chain and make trading look
   * removed rather than unsupported -- so they stay, with the note that says
   * which case it is. On a current chain every corporation reports an array,
   * so only real owners appear.
   */
  const sellers = useMemo(
    () =>
      companies.filter(
        (entry) =>
          // A corporation cannot buy from itself (`train_trade::SelfTrade`).
          entry.company_id !== buyer?.company_id &&
          (entry.owned_trains == null || entry.owned_trains.length > 0),
      ),
    [companies, buyer],
  );
  const selectedSeller = sellers.find((entry) => entry.company_id === selection?.sellerId) ?? null;

  // Design note #3 in `TrainTradePanel`: one player presiding over both
  // corporations means the contract settles on the spot and writes no offer.
  // Warned about BEFORE submitting, so the difference does not surprise
  // anyone after the click.
  const samePresident =
    !!selectedSeller &&
    !!buyer &&
    !!selectedSeller.president &&
    selectedSeller.president === buyer.president;

  const priceProblem = trainPriceError(priceText);
  const canPropose =
    canTrade && !!selectedSeller && !priceProblem;

  return (
    <div style={styles.root}>
      {/* ================= BANK ================= */}
      <section style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Buy Trains from the Bank</span>
          {buyer && <span style={styles.sectionMeta}>{buyer.ticker} treasury ${treasury}</span>}
        </div>

        {/* The whole depot, not only the purchasable row. A player deciding
            whether to buy the last 3-train needs to see that a 4-train costs
            $300 and that six 2-trains are about to rust -- which is a fact
            about the tiers they CANNOT buy. */}
        <div style={styles.depotGrid}>
          {depot.map((tier) => {
            const isNext = nextTier !== null && tier.tier === nextTier.tier;
            return (
              <div
                key={tier.tier}
                style={{
                  ...styles.depotCard,
                  ...(isNext ? styles.depotCardActive : {}),
                  ...(tier.rusted ? styles.depotCardRusted : {}),
                }}
                title={
                  tier.rusted
                    ? `${tier.tier}-trains have rusted and left play entirely.`
                    : isNext
                      ? `1830's depot sells cheapest-first, so the ${tier.tier}-train is the only one purchasable right now.`
                      : tier.soldOut
                        ? `The depot holds no ${tier.tier}-trains.`
                        : `Not purchasable until every cheaper tier is sold out.`
                }
              >
                <span style={styles.depotTier}>{tier.tier}</span>
                <span style={styles.depotCost}>${tier.cost}</span>
                <span
                  style={{
                    ...styles.depotSupply,
                    ...(tier.remaining === 0 ? styles.depotSupplyEmpty : {}),
                  }}
                >
                  {tier.total === null
                    ? "unlimited"
                    : `${tier.remaining ?? tier.total} / ${tier.total} left`}
                </span>
                {tier.rusted && <span style={styles.depotFlag}>rusted</span>}
                {!tier.rusted && isNext && <span style={styles.depotFlagNext}>For Sale</span>}
                {/* ==================================================
                     DESIGN NOTE 283: WHAT HAPPENS TO THIS TIER, NEXT
                    ==================================================

                    A depot card said how many were left and, once they
                    were gone, nothing. Sold out is not the end of a tier's
                    story -- it is the middle. The 3-trains leaving the
                    depot is the moment every 3-train ON THE BOARD becomes
                    a liability, and the card went quiet exactly then.

                    So the fate rides on every card that has one, sold out
                    or not, and the tiers that have none say so. "Permanent"
                    is worth its own badge rather than an absence: a player
                    weighing $630 for a 6-train against $300 for a 4 is
                    weighing precisely the fact that one of them never dies,
                    and an empty space does not state it.

                    NOT SHOWN ONCE IT HAS ALREADY HAPPENED -- the `rusted`
                    flag above says that, in the past tense, and a countdown
                    to something that has occurred is noise. */}
                {!tier.rusted &&
                  (tier.rustPhaseLabel !== null ? (
                    <span
                      style={styles.depotFlagRustSoon}
                      title={`Every ${tier.tier}-train in play is destroyed when the first ${tier.rustedBy}-train is bought, which is also what starts ${tier.rustPhaseLabel}.`}
                    >
                      Rusts on {tier.rustPhaseLabel}
                    </span>
                  ) : (
                    <span
                      style={styles.depotFlagPermanent}
                      title={`${tier.tier}-trains never rust -- nothing in 1830 removes them from play.`}
                    >
                      Permanent
                    </span>
                  ))}
              </div>
            );
          })}
        </div>

        {nextTier ? (
          <>
            <div style={styles.buyRow}>
              {/* ==================================================
                   DESIGN NOTE 294: TWO NUMBERS, TWO SUBJECTS
                  ==================================================

                  "Quantity" sat immediately beside a "Trains 2 / 4"
                  readout, and the pair was routinely read as one thing --
                  players could not tell whether the 4 was the depot's
                  stock, the corporation's ceiling, or what the ceiling
                  would be after buying.

                  They are facts about different subjects: one counts
                  cardboard in the bank, the other caps a corporation's
                  holdings this phase. Naming the subject on each is the
                  whole fix -- neither number was wrong, and neither said
                  whose it was. */}
              <label style={styles.quantityLabel} htmlFor="depot-quantity">
                Buy from bank
              </label>
              {/* ==================================================================
                   DESIGN NOTE 247: A DROPDOWN THAT LISTS WHAT IS BUYABLE
                  ==================================================================

                  REPORTED BUG: the depot shows 2 of 5 left, but 2 cannot be
                  selected in the quantity dropdown.

                  Both halves of that were true and it was not one bug.

                  IT WAS NOT A DROPDOWN. It was a `<input type="number">`
                  that silently CLAMPED what you typed. Typing 2 against a
                  ceiling of 1 rewrote the field to 1 mid-keystroke, which is
                  indistinguishable from the control refusing to accept the
                  digit -- exactly how it was reported. A clamp is the right
                  behaviour and the wrong affordance: it enforces a rule the
                  player cannot see by undoing their input.

                  THE CEILING WAS OFTEN THE TRAIN LIMIT, NOT THE DEPOT.
                  `supplyCap` is `min(depot, limit - owned)`, so a
                  corporation holding 3 of 4 caps at 1 however many trains
                  the bank has. The panel showed the depot's 2 and enforced
                  the limit's 1 without ever mentioning the limit, so the two
                  numbers on screen could not be reconciled.

                  A `<select>` fixes the first: it lists exactly the
                  quantities that can be bought, so there is nothing to type
                  and nothing to clamp. `bindingCeiling` below fixes the
                  second by naming which rule set the ceiling. */}
              <select
                id="depot-quantity"
                value={quantityText}
                disabled={!sessionReady || !canAct || atTrainLimit || supplyCap < 1}
                onChange={(event) => setQuantityText(event.target.value)}
                style={styles.quantitySelect}
                aria-label={`Quantity, up to ${Math.max(1, supplyCap)} available`}
              >
                {Array.from({ length: Math.max(1, supplyCap) }, (_, index) => index + 1).map(
                  (option) => (
                    <option key={option} value={String(option)}>
                      {option}
                    </option>
                  ),
                )}
              </select>

              {/* Design note #248: the limit, where the decision is made.
                  `Trains: 2 / 4` is the fact that explains why the quantity
                  list stops where it does, and it was only available on the
                  Operating Round strip at the top of the screen -- a
                  different panel from the one enforcing it. */}
              {/* Design note #296: the label states WHICH MOMENT the number
                  describes. On an ordinary purchase these are the same
                  figure and it reads as the plain current limit; on the
                  purchase that advances the phase it says so, in amber,
                  because the ceiling is about to move under the player. */}
              <span
                style={styles.limitReadout}
                title={
                  limitDropsOnPurchase
                    ? `Buying a ${nextTier?.tier}-train starts the next phase, which lowers the limit from ${currentTrainLimit} to ${limitAfterPurchase} for every corporation. This corporation holds ${ownedTrainCount} -- anything above ${limitAfterPurchase} is discarded when the phase turns.`
                    : `This corporation holds ${ownedTrainCount} of the ${trainLimit} trains 1830 allows one corporation in this phase. Separate from the depot's own stock above.`
                }
              >
                <span
                  style={{
                    ...styles.limitLabel,
                    ...(limitDropsOnPurchase ? styles.limitLabelFuture : {}),
                  }}
                >
                  {limitDropsOnPurchase ? "Train Limit After Purchase" : "Current Train Limit"}
                </span>
                <span
                  style={{
                    ...styles.limitValue,
                    ...(atTrainLimit ? styles.limitValueFull : {}),
                    ...(limitDropsOnPurchase ? styles.limitValueFuture : {}),
                  }}
                >
                  {limitDropsOnPurchase
                    ? `${limitAfterPurchase}`
                    : `${ownedTrainCount} / ${trainLimit}`}
                </span>
                {/* The fact the label alone cannot carry: what it is
                    changing FROM. Without it "After Purchase: 3" is a
                    number with no baseline to read it against. */}
                {limitDropsOnPurchase && (
                  <span style={styles.limitWas}>
                    now {currentTrainLimit} &middot; holds {ownedTrainCount}
                  </span>
                )}
              </span>

              {bindingCeiling && <span style={styles.ceilingNote}>{bindingCeiling}</span>}

              <button
                type="button"
                style={{
                  ...styles.primaryButton,
                  ...(bankProblem || !sessionReady || !canAct ? styles.buttonDisabled : {}),
                }}
                disabled={bankProblem !== null || !sessionReady || !canAct}
                onClick={() => {
                  if (bankProblem) return;
                  onBuyFromBank(nextTier.tier, quantity);
                }}
                title={
                  bankProblem ??
                  `${quantity} x ${nextTier.tier}-train at $${nextTier.cost} each.`
                }
              >
                {atTrainLimit
                  ? "Train Limit Reached"
                  : `Buy ${quantity > 1 ? `${quantity} x ` : ""}${nextTier.tier}-Train for $${
                      bankTotal || nextTier.cost
                    }`}
              </button>
            </div>
            {bankProblem && <p style={styles.problem}>{bankProblem}</p>}
            {/* Design note #1: stated, because it is the question a player
                asks the moment they see a quantity field. */}
            <p style={styles.note}>
              One tier per purchase. The depot sells cheapest-first, so a 3-train and a 4-train are
              two separate actions with a phase change between them.
            </p>
          </>
        ) : (
          <p style={styles.empty}>{bankProblem}</p>
        )}
      </section>

      {/* ================= CORPORATION ================= */}
      <section style={styles.section}>
        {/* Design note #0: collapsed by default. An accordion rather than a
            second always-open block, because buying from the bank is the
            ordinary case and a trade is the exception -- and the roster is
            eight corporations tall. */}
        <button
          type="button"
          style={styles.accordionHeader}
          onClick={() => setCorporateOpen((open) => !open)}
          aria-expanded={corporateOpen}
        >
          <span style={styles.accordionCaret} aria-hidden="true">
            {corporateOpen ? "▼" : "▶"}
          </span>
          <span style={styles.sectionTitle}>Buy Trains from a Corporation</span>
          <span style={styles.sectionMeta}>
            {corporateOpen ? "hide" : "any price, no phase advance, no rusting"}
          </span>
        </button>

        {corporateOpen && (
          <div style={styles.accordionBody}>
            {tradeBlockedReason && <p style={styles.problem}>{tradeBlockedReason}</p>}
            {!canAct && (
              <p style={styles.note}>
                Only the operating corporation&apos;s President may make an offer.
              </p>
            )}

            {/* ---- The roster. Design note #2: badges, not dropdowns. ---- */}
            <div style={styles.rosterList}>
              {sellers.length === 0 && (
                // Design note #232: the roster is filtered to owners, so
                // "empty" now means something specific and worth saying.
                <p style={styles.empty}>
                  No other corporation owns a train yet -- there is nothing to buy.
                </p>
              )}
              {sellers.map((company) => {
                const trains = company.owned_trains;
                return (
                  <div key={company.company_id} style={styles.rosterRow}>
                    <span style={styles.rosterName}>
                      <span
                        style={{
                          ...styles.tokenDot,
                          backgroundColor: stationTickerColor(company.company_id),
                        }}
                        aria-hidden="true"
                      />
                      <span style={styles.rosterTicker}>{corporationLabel(company.ticker)}</span>
                      <span style={styles.rosterPresident}>
                        {company.president
                          ? `\u{1F451} ${labelForAddress(company.president)}`
                          : "no president"}
                      </span>
                    </span>
                    <span style={styles.badgeRow}>
                      {/* ==================================================
                           DESIGN NOTE 282: ONE BADGE PER TRAIN
                          ==================================================

                          These were grouped -- a single "3" badge wearing an
                          "x2" superscript for a corporation holding two
                          3-trains. Compact, and wrong for what this row is:
                          a rack of things to click.

                          A count is a summary, and a summary is the right
                          shape when the reader wants to know HOW MANY. Here
                          the reader wants to know WHICH, because each badge
                          is an offer they are about to make on one specific
                          train. "3 x2" makes the player do arithmetic to
                          learn that two separate purchases are available,
                          and it renders two purchasable objects as one
                          object with a footnote.

                          It also mismatched the fleet everywhere else on
                          screen: the corporation table's own train chips
                          have always drawn one chip per train, so the same
                          roster read as "3 3" there and "3 x2" here.

                          `owned_trains` is already a list with duplicates
                          that are meaningful -- this just stops collapsing
                          it. `countByModel` is gone with it. */}
                      {trains == null ? (
                        // `undefined` means the chain did not say, which is
                        // emphatically not "owns nothing" -- reporting it as
                        // an empty roster would make trading look broken
                        // rather than unsupported.
                        <span style={styles.badgeNone}>trains not reported by this chain</span>
                      ) : (
                        trains.map((model, position) => {
                          // Design note #282: the POSITION is the identity.
                          // Two 3-trains are two trains, and a key on the
                          // model alone would collide between them.
                          const isSelected =
                            selection?.sellerId === company.company_id &&
                            selection?.model === model &&
                            selection?.position === position;
                          return (
                            <button
                              key={`${model}-${position}`}
                              type="button"
                              disabled={!canTrade}
                              onClick={() => {
                                setSelection({
                                  sellerId: company.company_id,
                                  model,
                                  position,
                                });
                                setPriceText("1");
                              }}
                              style={{
                                ...styles.badge,
                                ...(isSelected ? styles.badgeSelected : {}),
                                ...(!canTrade ? styles.badgeDisabled : {}),
                              }}
                              title={
                                canTrade
                                  ? `Offer for this ${model}-train of ${company.ticker}'s.`
                                  : (tradeBlockedReason ??
                                    `${company.ticker} holds this ${model}-train.`)
                              }
                            >
                              {model}
                            </button>
                          );
                        })
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* ---- The offer, once a badge has been clicked. ---- */}
            {selection && selectedSeller && (
              <div style={styles.offerBox}>
                <span style={styles.offerHeading}>
                  {buyer?.ticker ?? "This corporation"} offers for {selectedSeller.ticker}&apos;s{" "}
                  {selection.model}-train
                </span>
                <div style={styles.offerRow}>
                  <label style={styles.quantityLabel} htmlFor="trade-price">
                    Offer price
                  </label>
                  <input
                    id="trade-price"
                    value={priceText}
                    inputMode="numeric"
                    disabled={!canTrade}
                    onChange={(event) => setPriceText(event.target.value)}
                    style={styles.priceInput}
                    aria-label="Offer price"
                  />
                  <button
                    type="button"
                    style={{
                      ...styles.primaryButton,
                      ...(canPropose ? {} : styles.buttonDisabled),
                    }}
                    disabled={!canPropose}
                    onClick={() => {
                      if (!canPropose || !buyer) return;
                      onProposeTrade({
                        sellerProtocolId: selectedSeller.company_id,
                        sellerTicker: selectedSeller.ticker,
                        sellerPresident: selectedSeller.president,
                        sellerPresidentLabel: selectedSeller.president
                          ? labelForAddress(selectedSeller.president)
                          : "nobody",
                        buyerProtocolId: buyer.company_id,
                        buyerTicker: buyer.ticker,
                        modelType: selection.model,
                        price: priceText.trim(),
                      });
                      setSelection(null);
                    }}
                    title={
                      priceProblem ??
                      (samePresident
                        ? "You preside over both corporations, so this completes immediately."
                        : `Ask ${selectedSeller.president ? labelForAddress(selectedSeller.president) : "the seller"} to accept.`)
                    }
                  >
                    {samePresident ? "Buy Now" : "Send Offer"}
                  </button>
                  <button
                    type="button"
                    style={styles.secondaryButton}
                    onClick={() => setSelection(null)}
                  >
                    Cancel
                  </button>
                </div>
                {priceProblem && <p style={styles.problem}>{priceProblem}</p>}
                {samePresident && !priceProblem && (
                  <p style={styles.note}>
                    You are President of both corporations, so this sale completes immediately --
                    no offer is sent and nothing needs accepting.
                  </p>
                )}
                {!samePresident && !priceProblem && (
                  <p style={styles.note}>
                    {selectedSeller.president
                      ? `${labelForAddress(selectedSeller.president)} must accept before the train changes hands.`
                      : `${selectedSeller.ticker} has no President, so nobody can answer this offer.`}
                  </p>
                )}
                {/* Design note #3. */}
                <p style={styles.note}>
                  One train per trade. Any price of $1 or more is legal, with no upper limit.
                </p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default TrainPurchasePanel;

/* ------------------------------------------------------------------ */
/* The consent prompt                                                 */
/* ------------------------------------------------------------------ */

export interface TrainTradePromptProps {
  proposal: TrainTradeProposal | null;
  /** True when the viewer is the SELLER's president -- the party 1830 says
   *  must answer. Forced true in the sandbox, where one human drives every
   *  seat (the same reasoning as `PrivateTradePanel`'s design note #2). */
  viewerIsSeller: boolean;
  onAccept: () => void;
  onReject: () => void;
}

/** The counterparty's Accept / Reject.
 *
 *  Deliberately the same shape and the same corner as `PrivateTradePrompt`:
 *  these are the two consent flows in the app, they interrupt at the same
 *  moment in a turn, and a player should not have to learn two different
 *  affordances for "somebody is asking you to agree to something". */
export function TrainTradePrompt({
  proposal,
  viewerIsSeller,
  onAccept,
  onReject,
}: TrainTradePromptProps) {
  if (!proposal) return null;

  return (
    <div style={styles.promptRoot} role="alertdialog" aria-label="Train offer">
      <div style={styles.promptHeader}>
        <span style={styles.promptDot} aria-hidden="true" />
        <span style={styles.promptTitle}>Offer received</span>
      </div>

      <p style={styles.promptBody}>
        <strong>{proposal.buyerTicker}</strong> wants to buy a{" "}
        <strong>{proposal.modelType}-train</strong> from{" "}
        <strong>{proposal.sellerTicker}</strong> for <strong>${proposal.price}</strong>.
      </p>

      <p style={styles.promptWho}>
        {viewerIsSeller
          ? `This is ${proposal.sellerPresidentLabel}'s decision.`
          : `Waiting on ${proposal.sellerPresidentLabel}.`}
      </p>

      <div style={styles.promptActions}>
        <button
          type="button"
          onClick={onReject}
          style={{ ...styles.promptButton, ...styles.promptReject }}
        >
          Reject
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={!viewerIsSeller}
          style={{
            ...styles.promptButton,
            ...(viewerIsSeller ? styles.promptAccept : styles.buttonDisabled),
          }}
          title={
            viewerIsSeller
              ? `Sell one ${proposal.modelType}-train to ${proposal.buyerTicker} for $${proposal.price}.`
              : `Only ${proposal.sellerPresidentLabel} can accept this offer.`
          }
        >
          Accept
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    padding: "14px 18px",
    backgroundColor: "#12141b",
    border: "1px solid #3a3f4b",
    borderRadius: "10px",
  },
  section: { display: "flex", flexDirection: "column", gap: "10px" },
  sectionHeader: { display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap" },
  sectionTitle: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    color: "#e6e8ef",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  sectionMeta: {
    fontSize: FONT_SIZE.small,
    color: "#8a919e",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },

  /* ---- Depot ---- */
  depotGrid: { display: "flex", flexWrap: "wrap", gap: "8px" },
  depotCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    minWidth: "84px",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid #2b2f3a",
    backgroundColor: "#171a22",
    cursor: "help",
  },
  depotCardActive: { borderColor: "#4ade80", backgroundColor: "#152317" },
  depotCardRusted: { opacity: 0.5 },
  depotTier: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    color: "#e6e8ef",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  depotCost: {
    fontSize: FONT_SIZE.small,
    color: "#c8cdd8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  depotSupply: { fontSize: FONT_SIZE.micro, color: "#8a919e", whiteSpace: "nowrap" },
  depotSupplyEmpty: { color: "#c8a24a" },
  /* Design note #283: amber for a coming loss, slate for a permanence.
     Deliberately quieter than `depotFlag`'s rusted red -- one is a warning
     about the future and the other reports a fact about the past, and a
     card can carry either but never both. */
  depotFlagRustSoon: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#e0b062",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  depotFlagPermanent: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#8fb0d9",
    letterSpacing: "0.03em",
  },
  depotFlag: { fontSize: FONT_SIZE.micro, color: "#9aa0ac", fontStyle: "italic" },
  depotFlagNext: { fontSize: FONT_SIZE.micro, color: "#7ee0a1", fontWeight: 700 },

  /* ---- Buy row ---- */
  buyRow: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" },
  quantityLabel: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#c8cdd8" },
  quantitySelect: {
    minWidth: "72px",
    padding: "7px 10px",
    borderRadius: "7px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1b1e27",
    color: "#e6e8ef",
    fontSize: FONT_SIZE.control,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /* Design note #248: the limit readout. Deliberately quiet -- it is
     context for the control beside it, not a control itself -- until the
     corporation is AT the limit, when it becomes the reason the panel is
     refusing and earns the amber. */
  limitReadout: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "help" },
  limitLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#8a919e",
  },
  limitValue: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#e6e8ef",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
  },
  limitValueFull: { color: "#c8a24a" },
  /* Design note #296: the future-tense treatment. Amber on BOTH the label
     and the value, because the pair is one statement -- an amber number
     under a grey "Current Train Limit" would be the same wrong reading in
     a different colour. Amber rather than red: the ceiling is moving, which
     is a consequence to plan around, not an error. */
  limitLabelFuture: { color: "#e0b062" },
  limitValueFuture: { color: "#e0b062" },
  /** The baseline the after-value is measured against. */
  limitWas: {
    fontSize: FONT_SIZE.micro,
    color: "#8a919e",
    fontVariantNumeric: "tabular-nums",
  },
  ceilingNote: { fontSize: FONT_SIZE.small, color: "#8a919e" },
  /* `quantityInput` is gone with design note #247's number field. */
  priceInput: {
    width: "120px",
    padding: "7px 10px",
    borderRadius: "7px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1b1e27",
    color: "#e6e8ef",
    fontSize: FONT_SIZE.control,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },

  /* ---- Accordion ---- */
  accordionHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    textAlign: "left",
    padding: "9px 12px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#171a22",
    color: "#e6e8ef",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  accordionCaret: { fontSize: FONT_SIZE.micro, color: "#8a919e" },
  accordionBody: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "10px 2px 0",
  },

  /* ---- Roster ---- */
  rosterList: { display: "flex", flexDirection: "column", gap: "6px" },
  rosterRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
    padding: "7px 10px",
    borderRadius: "7px",
    backgroundColor: "#171a22",
    border: "1px solid #2b2f3a",
  },
  rosterName: { display: "inline-flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "220px" },
  tokenDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.35)",
  },
  rosterTicker: { fontSize: FONT_SIZE.body, fontWeight: 700, color: "#e6e8ef" },
  rosterPresident: { fontSize: FONT_SIZE.micro, color: "#8a919e", whiteSpace: "nowrap" },
  badgeRow: { display: "inline-flex", gap: "6px", flexWrap: "wrap", alignItems: "center" },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    minWidth: "34px",
    justifyContent: "center",
    padding: "5px 9px",
    borderRadius: "6px",
    border: "1px solid #4a5163",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    cursor: "pointer",
  },
  badgeSelected: { borderColor: "#4d8ee0", backgroundColor: "#1d3a55" },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // the disabled look is computed.
  badgeDisabled: { opacity: 0.5, cursor: "not-allowed" },
  badgeCount: { fontSize: FONT_SIZE.micro, color: "#9aa0ac", fontWeight: 400 },
  badgeNone: { fontSize: FONT_SIZE.small, color: "#6f7684", fontStyle: "italic" },

  /* ---- Offer ---- */
  offerBox: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 14px",
    borderRadius: "8px",
    border: "1px solid #3a5a8a",
    backgroundColor: "#141a26",
  },
  offerHeading: { fontSize: FONT_SIZE.strong, fontWeight: 700, color: "#e2e6ee" },
  offerRow: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },

  /* ---- Shared ---- */
  primaryButton: {
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #4ade80",
    backgroundColor: "#16a34a",
    color: "#ffffff",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #4a5163",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  buttonDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
    backgroundColor: "#1f2937",
    borderColor: "#374151",
    color: "#6b7280",
  },
  problem: { margin: 0, fontSize: FONT_SIZE.small, color: "#fb7185", lineHeight: 1.45 },
  note: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.5, color: "#8a919e" },
  empty: { margin: 0, fontSize: FONT_SIZE.small, color: "#c9b98a", lineHeight: 1.5 },

  /* ---- Prompt ---- */
  promptRoot: {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: 66,
    width: "min(400px, calc(100vw - 40px))",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "14px 16px",
    borderRadius: "12px",
    border: "1px solid #3a5a8a",
    backgroundColor: "#141a26",
    boxShadow: "0 10px 34px rgba(0,0,0,0.6)",
  },
  promptHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" },
  promptDot: {
    width: "9px",
    height: "9px",
    borderRadius: "999px",
    backgroundColor: "#38bdf8",
    flexShrink: 0,
  },
  promptTitle: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    color: "#9ec5ff",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  promptBody: { margin: 0, fontSize: FONT_SIZE.body, color: "#e2e6ee", lineHeight: 1.5 },
  promptWho: { margin: 0, fontSize: FONT_SIZE.small, color: "#9aa0ac" },
  promptActions: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: "8px",
  },
  promptButton: {
    padding: "7px 16px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  promptAccept: { backgroundColor: "#16a34a", borderColor: "#4ade80", color: "#ffffff" },
  promptReject: { backgroundColor: "#3a1f22", borderColor: "#b91c1c", color: "#fda4af" },
};
