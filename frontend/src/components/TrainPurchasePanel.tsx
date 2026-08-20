// frontend/src/components/TrainPurchasePanel.tsx
//
// The Buy Trains step's action panel -- two sources, two sections.
//
// Design note #0: the bank depot (fixed price, finite supply, strict cheapest-first queue, and a purchase
// that can END THE PHASE) and a rival corporation (any price, no supply question, no rusting, and a
// counterparty who has to agree) are different transactions in every respect that matters. One panel,
// two separated sections, with the corporate half COLLAPSED by default because the bank is the ordinary
// case and a trade is the exception.
//
// Design note #1: the quantity field is a convenience, not a batch -- `BuyHardwareFromPool` carries no
// quantity, so "buy 3" is three sequential messages. ONE TIER PER SUBMISSION, because 1830's depot is a
// strict queue and a player wanting a 3 and a 4 is describing two situations separated by a phase change.
//
// Design notes #2/#3: a train badge is the whole interaction (seller and model in one gesture), and
// `BuyTrainFromCorporation` names one model and no count, so one train per trade.
//
// Design history: see `docs/ai_architecture/contract_economy.md`.

import React, { useEffect, useMemo, useState } from "react";


import { FONT_SIZE } from "../styles/typography";
import { corporationLabel } from "../utils/corporationNames";
import type { DepotTier, PhaseTint } from "../utils/gamePhase";
// Design note #632: one tier-to-era lookup, shared with the phase badge.
import { tierTint } from "../utils/gamePhase";
import { stationTickerColor } from "./hexContractTypes";

/** The subset of a corporation both sections need. */
export interface TrainPurchaseCompany {
  company_id: number;
  ticker: string;
  president: string | null;
  /** `Uint128` on the wire, so a string here too. */
  treasury: string;
  /** Models currently held, e.g. `["2", "2", "4"]` -- duplicates are meaningful and drive the badge counts.
   *  `null`/`undefined` means UNKNOWN (a chain predating `owned_trains`), NOT "owns nothing": the corporate
   *  section says so rather than rendering an empty roster that looks like a board where nobody has bought. */
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

/* `countByModel` is GONE with design note #282. It collapsed a roster into model-and-count for the trade
   badges and nothing else ever wanted that shape -- the corporation table has always drawn one chip per
   train. Deleted rather than left unused so the grouped rendering cannot quietly come back. */


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
  /** Whether the corporate-trade accordion starts open. Defaults closed, per #0's argument that the bank is
   *  the common case. Exists so the section can be rendered without a DOM to click it open with -- a test
   *  that cannot reach a surface cannot check it, and this section carries the train-limit gate. */
  defaultCorporateOpen?: boolean;
  /* Design note #508: THE PANEL TRAVELS WITH THE BAR NOW. Mounted inside `ContextualActionBar`, which is
     `position: sticky`, so it follows the player down the page instead of being scrolled away from -- which
     is what retires #491's jump button.
     `condensed` is what makes that affordable: a sticky element costs the board its full height for the whole
     scroll (#298), so the pinned form drops what is PROSE and keeps what is CONTROL. The corporate accordion
     needs no special handling -- already collapsed, header still reachable. */
  condensed?: boolean;
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
  condensed = false,
}: TrainPurchasePanelProps) {
  /* ---- Bank section state ---- */
  const [quantityText, setQuantityText] = useState("1");

  /* ---- Corporate section state ---- */
  const [corporateOpen, setCorporateOpen] = useState(defaultCorporateOpen);
  /* Design note #633: CLOSED by default. The five tiers behind it are
     reference, and a reference list that opens itself is the vertical space
     this pass exists to give back. */
  const [laterTrainsOpen, setLaterTrainsOpen] = useState(false);
  /* Design note #282: `position` indexes into the seller's `owned_trains`, which is what tells two identical
     models apart. The dispatch still names only the model -- one 3-train is interchangeable with another --
     so this exists purely so the badge the player clicked is the badge that looks selected. */
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

  /* Design note #633: THE ONE YOU CAN BUY, AND EVERYTHING ELSE. Rusted tiers go with the later ones rather
     than being dropped: a 2-train that has left play is still the reason the board looks the way it does.
     NO AVAILABLE TIER IS A REAL STATE -- every tier sold out, which in 1830 means Diesels or over. The
     accordion then holds the whole depot, which is honest: there is nothing to buy and the panel says so by
     having nothing in the top slot. */
  const availableTiers = useMemo(
    () => (nextTier === null ? [] : depot.filter((row) => row.tier === nextTier.tier)),
    [depot, nextTier],
  );
  const laterTiers = useMemo(
    () => (nextTier === null ? depot : depot.filter((row) => row.tier !== nextTier.tier)),
    [depot, nextTier],
  );

  /* Design note #230: THE TRAIN LIMIT IS A SECOND, TIGHTER CEILING. The panel capped quantity at the DEPOT'S
     SUPPLY and nothing else, while 1830 caps holdings per corporation by PHASE -- and the figure was being
     displayed and not enforced, which is the worst of both. The binding ceiling is whichever is smaller, and
     the message names whichever one bit. ZERO HEADROOM IS ITS OWN STATE: "enter a number between 1 and 0" is
     nonsense, "train limit reached" is the situation, and it is a reason to move on rather than to retype.
     Design note #296: THE NUMBER WAS ALREADY IN THE FUTURE TENSE. It read `nextTier.trainLimit`, which means
     "trains one corporation may hold ONCE THIS TIER IS THE CURRENT PHASE" -- and the next tier is not the
     current phase whenever the depot has moved on. In Phase 3 with the 2s and 3s sold out the panel read
     "/ 3" while the real limit was 4, measured on the real fixture.
     Both figures are derived and named now, equal on an ordinary purchase and differing on exactly the one
     that advances the phase. ENFORCEMENT STAYS ON THE AFTER-VALUE: buying the first 4-train starts Phase 4
     and the limit drops with it, so capping against the old one would offer a quantity the rules take back. */
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

  /* Design note #219: THE CAP MOVES WHILE THE FIELD IS SITTING THERE. Supply is derived from what every
     corporation owns, so it drops when ANY of them buys -- including on a poll while this panel is open.
     The submit guard catches that, but a field showing a number the player cannot buy next to a button that
     refuses it reads as the UI being broken rather than as the depot having moved.
     DOWNWARD ONLY. A supply that grows must not silently raise a quantity the player typed -- that would be
     the UI buying more than they asked for. */
  useEffect(() => {
    const cap = Math.max(1, supplyCap);
    setQuantityText((current) => {
      const parsed = Number(current);
      if (!Number.isFinite(parsed) || parsed <= cap) return current;
      return String(cap);
    });
  }, [supplyCap]);

  /* Design note #247: WHICH rule stopped the list where it did. With two ceilings in play and one of them
     displayed, a player facing "2 in the depot, 1 selectable" had no way to reconcile the numbers. This names
     the binding one, and says nothing when neither is close -- a permanent explanation of a constraint nobody
     is hitting is noise. */
  const bindingCeiling: string | null =
    nextTier === null || atTrainLimit
      ? null
      : limitHeadroom < depotSupply
        ? (limitDropsOnPurchase
            ? `Room for ${limitHeadroom} more — this purchase drops the limit to ${limitAfterPurchase}.`
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
      ? "The Bank Depot is empty — every printed train has been bought."
      : atTrainLimit
        ? /* Design note #230: the phase's own ceiling, named as such -- this
             says what is true rather than asking for a smaller number.

             Design note #485: it no longer says what to DO about it. Both
             strings used to end by directing the president to sell or scrap
             a train first, and 1830 permits neither: there is no voluntary
             discard, and the Bank never buys a train back. A corporation at
             its limit is simply train-locked. The only thing that can move a
             train off its roster is ANOTHER corporation buying it, which is
             that corporation's decision and not an action available on this
             panel -- so an instruction here could not be followed even in
             principle. Naming the lock and stopping is the honest end of the
             sentence. */
          (limitDropsOnPurchase
            ? `Buying a ${nextTier?.tier}-train would start the next phase and cut the limit to ${limitAfterPurchase}, and ${buyer?.ticker ?? "this corporation"} already holds ${ownedTrainCount}.`
            : `Train limit reached — ${buyer?.ticker ?? "this corporation"} already holds ${ownedTrainCount} of a maximum ${trainLimit} for this phase.`)
        : !quantityValid
          ? `Enter a whole number between 1 and ${Math.max(1, supplyCap)}.`
          : bankTotal > treasury
            ? `${buyer?.ticker ?? "This corporation"}'s treasury holds $${treasury} — it cannot pay $${bankTotal}.`
            : null;

  /* Design note #281: THE LIMIT IS A LIMIT ON HOLDINGS, NOT ON THE BANK. #230 had enforced the cap on the
     BANK section thoroughly, and the corporate section shared none of it -- because the cap had been reasoned
     about as a property of buying FROM THE DEPOT rather than of the corporation's fleet. 1830 caps what a
     corporation may HOLD, whatever the source, so the same gate covers both and the reason is the same
     sentence: giving it two wordings would imply two rules.
     IT DISABLES RATHER THAN HIDING. Knowing who holds what tells a president which rivals are themselves
     train-locked; a vanished section would answer a question nobody asked by removing the one they did.
     Design note #485: the reason no longer ends "scrap or sell a train before buying another" -- a
     corporation cannot scrap and the Bank does not buy trains back, so the sentence instructed the player to
     take an action 1830 does not contain. It is a lock, not a prerequisite. */
  const tradeBlockedReason: string | null =
    blockedReason ??
    (atTrainLimit
      ? `Train limit reached — ${buyer?.ticker ?? "this corporation"} already holds ${ownedTrainCount} of a maximum ${trainLimit} for this phase.`
      : null);
  const canTrade = canAct && sessionReady && tradeBlockedReason === null;

  /* Design note #232: ONLY LIST CORPORATIONS THAT HAVE SOMETHING TO SELL. It listed all seven with a "no
     trains" placeholder each, on the reasoning that a complete roster is easier to scan. In practice the
     opposite: early on most corporations own nothing, so the panel was mostly rows that could not be acted
     on and the two or three that COULD were buried among them.
     `owned_trains` UNDEFINED IS KEPT, and the distinction is load-bearing: it means the chain did not say,
     which is emphatically not "owns nothing". Filtering those out would empty the section against such a
     chain and make trading look removed rather than unsupported. */
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
    <div style={{ ...styles.root, ...(condensed ? styles.rootCondensed : {}) }}>
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
        {/* Design note #618: SIX ROWS, NOT SIX CARDS. Nothing is dropped -- what changes is the AXIS. Each tier was
           a five-line stack ~100px tall wrapping into two or three rows of cards; the same six as single lines are
           one column about a third the height.
           AND IT READS BETTER, which is the argument for doing it this way rather than shrinking the cards: the
           question here is comparative, and a wrapping grid puts "how many 4s are left" and "what does the 5 cost"
           in different places on different widths. Columns put every cost under every other cost.
           The report's own observation is why this is safe -- "you can only ever interact with one of them". The
           other five are reference, and reference wants a table. */}
        {/* Design note #633: ONE ROW BY DEFAULT, FIVE BEHIND A CARET. #618 made each row shorter and kept all six
           on screen, so the panel got tidier and barely got shorter -- the height was never in the row's design, it
           was in the row COUNT.
           And five of the six are reference: the depot sells cheapest-first, so exactly one tier is ever
           purchasable. The rest fold into the same accordion this file already uses for corporate trades, for the
           reason recorded there -- the ordinary case is the open one. The collapsed summary still names what is
           next and what it costs. This is also what retires the "For sale" badge (#634). */}
        <div style={styles.depotGrid}>
          {availableTiers.map((tier) => (
            <DepotRow
              key={tier.tier}
              tier={tier}
              isNext={nextTier !== null && tier.tier === nextTier.tier}
            />
          ))}
        </div>

        {laterTiers.length > 0 && (
          <>
            <button
              type="button"
              style={styles.laterTrainsHeader}
              onClick={() => setLaterTrainsOpen((open) => !open)}
              aria-expanded={laterTrainsOpen}
            >
              <span style={styles.accordionCaret} aria-hidden="true">
                {laterTrainsOpen ? "\u25bc" : "\u25b6"}
              </span>
              <span style={styles.laterTrainsTitle}>
                Later trains ({laterTiers.length})
              </span>
              {/* Design note #633: the collapsed summary answers the
                  commonest reference question -- what is next and what does
                  it cost -- so opening this is for the rarer ones. */}
              <span style={styles.sectionMeta}>
                {laterTrainsOpen
                  ? "hide"
                  : laterTiers[0]
                    ? `next: ${laterTiers[0].tier}-train $${laterTiers[0].cost}`
                    : ""}
              </span>
            </button>
            {laterTrainsOpen && (
              <div style={styles.depotGrid}>
                {laterTiers.map((tier) => (
                  <DepotRow key={tier.tier} tier={tier} isNext={false} />
                ))}
              </div>
            )}
          </>
        )}

        {nextTier ? (
          <>
            <div style={styles.buyRow}>
              {/* Design note #294: TWO NUMBERS, TWO SUBJECTS. "Quantity" sat beside a "Trains 2 / 4" readout and the pair
                 was read as one thing -- players could not tell whether the 4 was the depot's stock, the corporation's
                 ceiling, or what the ceiling would be after buying. They are facts about different subjects: one counts
                 cardboard in the bank, the other caps a corporation's holdings this phase. Naming the subject on each is
                 the whole fix -- neither number was wrong, and neither said whose it was. */}
              <label style={styles.quantityLabel} htmlFor="depot-quantity">
                Buy from bank
              </label>
              {/* Design note #247: A DROPDOWN THAT LISTS WHAT IS BUYABLE. Two things were true at once and it was not one
                 bug. IT WAS NOT A DROPDOWN -- it was `<input type="number">` that silently CLAMPED, so typing 2 against a
                 ceiling of 1 rewrote the field mid-keystroke, indistinguishable from the control refusing the digit. A
                 clamp is the right behaviour and the wrong affordance: it enforces a rule the player cannot see by
                 undoing their input.
                 AND THE CEILING WAS OFTEN THE TRAIN LIMIT, NOT THE DEPOT -- `min(depot, limit - owned)` -- so the panel
                 showed the depot's 2 and enforced the limit's 1 without ever mentioning the limit.
                 A `<select>` fixes the first; `bindingCeiling` names which rule set the ceiling and fixes the second. */}
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

              {/* Design note #248: the limit, where the decision is made. `Trains: 2 / 4` explains why the quantity list
                 stops where it does, and it was only available on the Operating Round strip -- a different panel from the
                 one enforcing it. */}
              {/* Design note #296: the label states WHICH MOMENT the number describes. On an ordinary purchase these are
                 the same figure and it reads as the plain current limit; on the purchase that advances the phase it says
                 so, in amber, because the ceiling is about to move under the player. */}
              <span
                style={styles.limitReadout}
                title={
                  limitDropsOnPurchase
                    ? `Buying a ${nextTier?.tier}-train starts the next phase, which lowers the limit from ${currentTrainLimit} to ${limitAfterPurchase} for every corporation. This corporation holds ${ownedTrainCount} — anything above ${limitAfterPurchase} is discarded when the phase turns.`
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
            {/* Design note #1: stated, because it is the question a player asks the moment they see a quantity field.
               Design note #508: except when pinned. This is the longest piece of prose in the panel and it explains a
               rule rather than a value -- read once, not on every scroll -- so it is the first thing the condensed form
               gives back to the board. */}
            {!condensed && (
              <p style={styles.note}>
                One tier per purchase. The depot sells cheapest-first, so a 3-train and a 4-train
                are two separate actions with a phase change between them.
              </p>
            )}
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
                  No other corporation owns a train yet — there is nothing to buy.
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
                      {/* Design note #282: ONE BADGE PER TRAIN. These were grouped -- a single "3" wearing an "x2". Compact, and
                         wrong for what this row is: a rack of things to click. A count is a summary and answers HOW MANY; here
                         the reader wants WHICH, because each badge is an offer about one specific train. "3 x2" makes the player
                         do arithmetic to learn two purchases are available, and renders two purchasable objects as one object
                         with a footnote.
                         It also mismatched the fleet everywhere else -- the corporation table has always drawn one chip per train,
                         so the same roster read "3 3" there and "3 x2" here. `owned_trains` is already a list with meaningful
                         duplicates; this just stops collapsing it. */}
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

/** The counterparty's Accept / Reject. Deliberately the same shape and the same corner as
 *  `PrivateTradePrompt`: these are the two consent flows in the app, they interrupt at the same moment in a
 *  turn, and a player should not have to learn two affordances for "somebody is asking you to agree". */
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

/* Design note #617: A TRAIN THAT LOOKS LIKE A TRAIN, AND COUNTS. Inline SVG is the answer to the emoji
   problem -- drawn by this file, from these coordinates, on every device, with no font to substitute and
   no colour-emoji fallback. The objection that ruled emojis out does not apply to a path we ship.
   THE CARRIAGES ARE THE TIER, which is the part worth having: what a new player needs to learn is that the
   NUMBER IS A CAPACITY, so the glyph is a locomotive plus one carriage per revenue centre and "buy a 3"
   becomes a picture of the thing it buys.
   DIESEL IS DRAWN, NOT COUNTED -- a D-train has no fixed length, so a carriage count would be a lie in the
   one case where the number is not a number.
   `aria-hidden`: every glyph sits beside the tier already written as text. */
function TrainGlyph({ tier, color }: { tier: string; color: string }) {
  const carriages = tier === "D" ? 3 : Math.min(6, Number(tier) || 0);
  const isDiesel = tier === "D";
  // Locomotive is 13 wide; each carriage is 5 wide on a 6px pitch.
  const width = 15 + carriages * 6;
  return (
    <svg
      width={width}
      height={12}
      viewBox={`0 0 ${width} 12`}
      aria-hidden="true"
      focusable="false"
      style={{ flex: "none", display: "block" }}
    >
      {/* Locomotive: cab, boiler, and two wheels. */}
      <rect x={0} y={2} width={6} height={6} rx={1} fill={color} />
      <rect x={6} y={4} width={7} height={4} rx={1} fill={color} />
      <circle cx={3} cy={10} r={1.6} fill={color} />
      <circle cx={10} cy={10} r={1.6} fill={color} />
      {isDiesel
        ? /* Design note #617: "and onward", not a count. */
          [0, 1, 2].map((index) => (
            <circle key={index} cx={18 + index * 6} cy={6} r={1.4} fill={color} opacity={0.75} />
          ))
        : Array.from({ length: carriages }, (_, index) => (
            <rect
              key={index}
              x={16 + index * 6}
              y={3.5}
              width={5}
              height={5}
              rx={1}
              fill={color}
              opacity={0.8}
            />
          ))}
    </svg>
  );
}

/* Design note #632: THE ERA PALETTE, LIGHTENED FOR A DARK PANEL. The tile colours a player already knows,
   adjusted to be legible as INK on near-black rather than as fills on a map -- brown forces the adjustment,
   since the tile brown reads as mud at 12px and the ink is a warm tan that still says "brown era".
   NOT PULLED FROM `hexTileCatalog`, deliberately: those values are chosen to be correct as large filled
   hexes on a light board, and reusing them would be sharing a number that happens to match rather than a
   decision. What IS shared is the tier-to-era mapping, which is the part that would be wrong if it drifted. */
const ERA_INK: Readonly<Record<PhaseTint, string>> = {
  yellow: "#d9c05a",
  green: "#6fbf7f",
  brown: "#c08a5a",
};

/* Design note #633: one depot line, rendered identically whether it is the
   purchasable tier standing alone or one of the five behind the caret. A
   second copy for the collapsed list is how the two would come to disagree
   about what a rusted tier looks like. */
function DepotRow({ tier, isNext }: { tier: DepotTier; isNext: boolean }) {
  return (
      <div
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
        {/* Design note #617: the glyph leads, so the row opens with a
            picture of what is being bought rather than a bare digit.
            Green on the purchasable row, muted elsewhere -- it takes
            the same ink as the tier label beside it. */}
        <TrainGlyph
          tier={tier.tier}
          color={tier.rusted ? "#5a6070" : ERA_INK[tierTint(tier.tier)]}
        />
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
        {/* Design note #618: the flags share one right-hand column, so
            a row always has the same four slots whatever it is
            saying. */}
        <span style={styles.depotFate}>
        {tier.rusted && <span style={styles.depotFlag}>rusted</span>}
        {/* Design note #283: WHAT HAPPENS TO THIS TIER, NEXT. A card said how many were left and, once they were
           gone, nothing -- but sold out is not the end of a tier's story, it is the middle: the 3-trains leaving
           the depot is the moment every 3-train ON THE BOARD becomes a liability, and the card went quiet then.
           "Permanent" is worth its own badge rather than an absence: a player weighing $630 for a 6-train against
           $300 for a 4 is weighing precisely the fact that one of them never dies, and an empty space does not
           state it. Not shown once it has already happened -- the `rusted` flag says that in the past tense. */}
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
              title={`${tier.tier}-trains never rust — nothing in 1830 removes them from play.`}
            >
              Permanent
            </span>
          ))}
        </span>
      </div>
  );
}

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
  /* Design note #508: the pinned form. Tighter on every axis and without
     the standalone card treatment -- inside the action bar it is a SECTION
     of that panel rather than a panel of its own, and a bordered box inside
     a bordered box reads as two things when it is one. */
  rootCondensed: {
    gap: "8px",
    padding: "8px 10px",
    backgroundColor: "transparent",
    border: "none",
    borderTop: "1px solid #2b3242",
    borderRadius: 0,
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

  /* ---- Depot (design note #618: a column of rows, not a grid of cards) ---- */
  depotGrid: {
    display: "flex",
    flexDirection: "column",
    /* 1px, so consecutive rows read as a table rather than as six objects.
       The row's own border does the separating. */
    gap: "1px",
  },
  /* Design note #618: ONE ROW. The column widths are fixed rather than
     content-sized, because the point of the change is that every cost sits
     under every other cost -- `flex` on the cells would let a wide supply
     string in one row shove that row's fate flag out of the column. */
  depotCard: {
    display: "grid",
    gridTemplateColumns: "58px 26px 56px 84px 1fr",
    alignItems: "center",
    gap: "10px",
    padding: "3px 8px",
    borderRadius: "5px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    /* Design note #635: A ROW THAT DOES NOTHING SHOULD NOT OFFER TO. `cursor: help` was inherited from the card
       layout, where it was arguably right -- a card with five lines of detail and a queue-rule tooltip is a
       thing you interrogate. A one-line row whose four columns are already on screen has nothing left to
       reveal, so the cursor promised an interaction that had been designed away.
       THE TOOLTIPS STAY: `title` still explains why a tier is or is not purchasable -- it just should not change
       the pointer. */
    cursor: "default",
  },
  /* Design note #618: only the purchasable row keeps a raised treatment --
     it is the one that is a control rather than a reference line. */
  depotCardActive: { borderColor: "#3f7a55", backgroundColor: "#152317" },
  depotCardRusted: { opacity: 0.45 },
  depotTier: {
    fontSize: FONT_SIZE.body,
    fontWeight: 800,
    color: "#e6e8ef",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  depotCost: {
    fontSize: FONT_SIZE.small,
    color: "#c8cdd8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
  },
  depotSupply: { fontSize: FONT_SIZE.micro, color: "#8a919e", whiteSpace: "nowrap" },
  /* Design note #618: the shared right-hand column the fate flags live in,
     so "rusted" / "For Sale" / "Rusts on Phase 5" / "Permanent" all start on
     the same x whatever the row above said. */
  depotFate: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
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
  /* Design note #634: THE "FOR SALE" BADGE IS RETIRED. It was always a workaround for the layout rather than
     a fact worth stating: six near-identical rows needed one of them marked, and a single row standing above
     a caret labelled "Later trains" is marked by position, which is the stronger signal and costs no width.
     `depotFlagNext` is deleted with it rather than left unused. */

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
  /* Design note #296: the future-tense treatment. Amber on BOTH the label and the value, because the pair is
     one statement -- an amber number under a grey "Current Train Limit" would be the same wrong reading in a
     different colour. Amber rather than red: the ceiling is moving, which is a consequence to plan around. */
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
  /* Design note #633: quieter than `accordionHeader`. That one opens a
     section with controls in it; this opens a reference list, and a header
     as loud as the panel's own would make the collapsed state look like the
     thing the panel is for. */
  laterTrainsHeader: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    textAlign: "left",
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid #2b2f3a",
    backgroundColor: "transparent",
    color: "#c8cdd8",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  laterTrainsTitle: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#c8cdd8",
    flex: 1,
  },
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
