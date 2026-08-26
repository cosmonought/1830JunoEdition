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
import { purchaseCeiling } from "../utils/purchaseCeiling";
import { buyableNow, isTrainLocked, quantityOptionCount } from "../utils/trainLimit";
import { STICKY_OPTIONAL } from "../utils/stickyCollapse";
// Design note #702: moved to its own file, because the train CHIPS draw it now too.
import { TrainGlyph } from "./TrainGlyph";
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
  /** Design note #751c: opens the emergency modal. Absent where there is no such flow to open. */
  onEmergencyPurchase?: () => void;
  /** Whether the corporation is actually short -- computed by the caller, which is the only place that
   *  knows both the obligation and the depot. */
  emergencyAvailable?: boolean;
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
  onEmergencyPurchase,
  emergencyAvailable,
  onProposeTrade,
  labelForAddress,
  defaultCorporateOpen = false,
  condensed = false,
}: TrainPurchasePanelProps) {
  /* ---- Bank section state ---- */
  const [quantityText, setQuantityText] = useState("1");

  /* ---- Corporate section state ---- */
  const [corporateOpen, setCorporateOpen] = useState(defaultCorporateOpen);
  /* ==================================================================
     DESIGN NOTE 812: THE BANK STANDS ASIDE FOR THE ROSTER
     ==================================================================

     REQUESTED TWICE, and I declined it the first time for a reason the second version answers: "I think Buy
     Trains from the Bank should collapse when opening Buy Trains from a Corporation. The collapsed title
     could still list the current train and its price off to the side without all the actions needing to be
     visible."

     I EVALUATED THE WRONG PROPOSAL. What I turned down was "collapse it", on the grounds that comparing the
     depot's price against a corporation's asking price is the entire reason a player opens the roster -- so
     hiding the depot hides the number the comparison is against. That objection was sound and it does not
     apply here: the collapsed header KEEPS the tier and its price. What goes away is the depot table, the
     quantity selector and the buy button, none of which are part of the comparison.

     A DEFAULT, NOT A LOCK. Opening the roster closes the bank; closing the roster opens it again; in between
     the player may toggle either freely. A panel that refused to show both at once would be making a decision
     that is theirs, and there are boards where seeing both in full is exactly right.

     AND IT IS THE PREREQUISITE FOR A BIGGER QUESTION. Whether these panels can live inside the sticky bar
     (#813) turns on the bar's tallest state, and the roster with eight operating corporations open UNDER a
     full depot table is that state. This removes the worst case rather than merely shrinking the ordinary
     one. */
  const [bankOpen, setBankOpen] = useState(true);
  useEffect(() => {
    setBankOpen(!corporateOpen);
  }, [corporateOpen]);
  /* Design note #828: AND PINNED MEANS COLLAPSED, which is what lets this panel live inside the sticky bar.
     #720 unpins a bar past half the viewport, and the probe (#813) measured the open panel at 242px against a
     326px budget it shares with a 185px bar. Folded, the section is a header and the buy row.
     A DEFAULT, NOT A LOCK, like #812's: a player may open the table while pinned, and if that tips the bar
     past the threshold #720 unpins it -- which is the right outcome for something they deliberately expanded,
     and is a different event from the bar unpinning by surprise, which is what was reported twice.

     DESIGN NOTE 837: THIS LINE WAS HALF OF A DEADLOCK, and the half that was easiest to miss. `condensed` was
     only ever true when the bar had PINNED, and the bar could only pin if this table was already folded --
     so the table folded because the bar pinned and the bar pinned because the table folded. Reported as "in
     OR 1.1 it's not [sticky], but in OR 2.1 it is", which is not a fact about rounds at all: it is whichever
     side of the threshold the first measurement happened to land on.
     THE LINE SURVIVES BECAUSE ITS TRIGGER CHANGED, not because the rule was wrong. `stickyCollapse.ts` #837
     makes the pin test read the bar's RESTING height -- what it occupies with this table folded away -- which
     no longer depends on whether it is folded. So `condensed` now means what it says: the bar has stuck and
     travelled. A player ARRIVING at Buy Trains is not scrolled, so the depot is open, which is what was asked
     for ("Shouldn't the Bank one be expanded?"); it folds as they scroll away, which is the moment a compact
     bar is worth having. */
  useEffect(() => {
    if (condensed) setBankOpen(false);
  }, [condensed]);
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

  /* ==================================================================
   *  DESIGN NOTE 798: "NEXT" WAS THE FIRST ROW, NOT THE NEXT ONE
   * ==================================================================
   *
   * REPORTED: "The 'Later trains' accordion: at flush right it says 'next:' but for me it is wrong.
   * Corporations own 3-trains and it says 'next: 2-train ($80)'."
   *
   * THE SUMMARY AND THE LIST SHARED ONE ARRAY AND WANTED DIFFERENT ANSWERS. `laterTiers` is everything except
   * the purchasable tier, and #633 chose that deliberately -- "rusted tiers go with the later ones rather
   * than being dropped: a 2-train that has left play is still the reason the board looks the way it does."
   * Right for the LIST. But it leaves the earliest tier at index 0, so `laterTiers[0]` is the OLDEST train in
   * the game rather than the one coming up, and the caption confidently named a 2-train in Phase 3.
   *
   * SO THE SUMMARY GETS ITS OWN LOOKUP: the depot row after the purchasable one, by POSITION. The depot is
   * ordered cheapest-first and sells in that order, so "the row after this one" is exactly what "next" means
   * -- and it stays correct without the caption having to know anything about rusting or phases.
   *
   * `null` WHEN THERE IS NO ROW AFTER IT, which is Diesels and the honest answer. The caption renders nothing
   * rather than wrapping round to the front of the list, which is the bug it is replacing. */
  const upcomingTier = useMemo(() => {
    if (nextTier === null) return null;
    const at = depot.findIndex((row) => row.tier === nextTier.tier);
    return at === -1 ? null : (depot[at + 1] ?? null);
  }, [depot, nextTier]);

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

  /* Design note #703: THE LIMIT THAT BINDS A PURCHASE IS THE ONE IN FORCE WHEN IT IS MADE.

     REPORTED: "NNH owns three trains, the next available train to purchase is a 4-train, and there is a red
     text that says 'Buying a 4-train would start the next phase and cut the limit to 3, and NNH already holds
     3.' This misunderstands the rule: corporations are not prohibited from buying a train if doing so triggers
     a phase change that lowers the train limit, provided the corporation was legally under the old limit
     before the purchase."

     Correct, and #296 chose this deliberately: "ENFORCEMENT STAYS ON THE AFTER-VALUE: buying the first 4-train
     starts Phase 4 and the limit drops with it, so capping against the old one would offer a quantity the
     rules take back." That sentence describes a rule 1830 does not have. A phase change does not reach
     backwards and un-make the purchase that caused it; it changes what the corporation may HOLD from that
     moment on, which is a different obligation with a different remedy.

     AND IT WAS PROBABLY A HALF-MEMORY OF A REAL RULE, which the report also names: "a player cannot purchase
     a train that exceeds the train limit even if doing so would rust their current trains to bring them under
     the limit." Both rules are the same principle read at the same instant -- the limit is checked BEFORE the
     purchase resolves, against what the corporation holds and what the phase allows RIGHT NOW. Rusting does
     not create headroom in advance and a phase shift does not remove it in arrears. #296 applied the correct
     instant to one of the two consequences and the wrong one to the other.

     EVERY OTHER SURFACE ALREADY HAD IT RIGHT -- `App.tsx`'s auto-skip gate, `TrainBadges`' capacity pill and
     the action bar's train-limit rail all read the CURRENT phase. So the panel that ENFORCED was the only one
     out of step, and it contradicted the rail directly above it: "Train limit: 3 / 4" beside "already holds
     3". */
  const trainLimit = currentTrainLimit ?? Infinity;
  /* The limit's OWN ceiling, with the depot taken out of it -- the figure `purchaseCeiling` names in "Room for
     N more". Walked, not subtracted, for the same reason `supplyCap` is: with a phase change in the middle,
     `currentLimit - owned` overcounts. A caption reading "Room for 3 more" beside two selectable buttons is
     precisely the reconciliation failure #247 exists to prevent, so the caption and the buttons are handed the
     same walk. */
  const limitHeadroom = useMemo(
    () =>
      buyableNow({
        owned: ownedTrainCount,
        currentLimit: currentTrainLimit,
        depotSupply: Number.MAX_SAFE_INTEGER,
        advancesPhase: limitDropsOnPurchase,
        limitAfterPurchase,
      }),
    [ownedTrainCount, currentTrainLimit, limitDropsOnPurchase, limitAfterPurchase],
  );
  const atTrainLimit = isTrainLocked(ownedTrainCount, currentTrainLimit);

  /* THE MULTI-BUY IS WHERE #296'S WORRY WAS ACTUALLY TRUE, and it is a cap rather than a block: buying two
     4-trains at once is two purchases, the first legal under the current limit and the second judged by the
     new one. The walk lives in `trainLimit.ts` with the rule it implements -- a rule this file has now had
     wrong across two design notes is not one to keep in local arithmetic. */
  const supplyCap = useMemo(
    () =>
      buyableNow({
        owned: ownedTrainCount,
        currentLimit: currentTrainLimit,
        depotSupply,
        advancesPhase: limitDropsOnPurchase,
        limitAfterPurchase,
      }),
    [ownedTrainCount, currentTrainLimit, depotSupply, limitDropsOnPurchase, limitAfterPurchase],
  );

  /* Design note #719: the row shows the PHASE's limit and greys what this corporation cannot reach; the rule
     and the reasoning live in `trainLimit.ts` beside `buyableNow`, which supplies the greying threshold. */
  const optionCount = useMemo(
    () => quantityOptionCount(currentTrainLimit, supplyCap),
    [currentTrainLimit, supplyCap],
  );

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

  /* Design note #247 named which of two ceilings bound; #700 moved the rule into `purchaseCeiling` and split
     its answer by MOOD -- a caption volunteered permanently, a reason asked for by hovering a dead option.
     The reasoning, including why the depot's sentence left the caption, is recorded there rather than here:
     it is a rule about what the panel already draws, and it now has one statement. */
  const { reason: ceilingReason } = purchaseCeiling({
    hasTierForSale: nextTier !== null,
    atTrainLimit,
    limitHeadroom,
    depotSupply,
    trainLimit,
    limitDropsOnPurchase,
    limitAfterPurchase,
  });

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
          /* Design note #703: ONE SENTENCE, because there is one rule. The `limitDropsOnPurchase` variant read
             "Buying a 4-train would start the next phase and cut the limit to 3, and NNH already holds 3" --
             a prohibition 1830 does not contain, and the only message on this panel that could fire while the
             corporation was legally under its limit. */
          `Train limit reached — ${buyer?.ticker ?? "this corporation"} already holds ${ownedTrainCount} of a maximum ${trainLimit} for this phase.`
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
    <div
      style={{
        ...styles.root,
        /* Design note #810: THE LIVERY EDGE, tying this panel to the bar above it. `buyer` is the acting
           corporation, and `stationTickerColor` is the same palette the bar, the map tokens and the herald
           already use -- so the edge says "this belongs to the corporation whose turn it is" in the one
           channel this app has already taught. Grey when there is no buyer, which is a real state (a
           corporation with no president reported) rather than a colour worth inventing. */
        borderLeft: `4px solid ${buyer ? stationTickerColor(buyer.company_id) : "#3a3f4b"}`,
        ...(condensed ? styles.rootCondensed : {}),
      }}
    >
      {/* ================= BANK ================= */}
      <section style={styles.section}>
        {/* Design note #812: the header is a disclosure now, matching the roster's below it -- two sections
            that behave differently while looking the same is the kind of difference a player learns by being
            surprised. The treasury stays on the header in both states: it is the figure that decides whether
            EITHER purchase is possible, so it belongs to the panel rather than to one section's body. */}
        <button
          type="button"
          style={styles.accordionHeader}
          onClick={() => setBankOpen((open) => !open)}
          aria-expanded={bankOpen}
          title={bankOpen ? "Hide the depot table." : "Show the depot table and the buy controls."}
        >
          <span style={styles.accordionCaret} aria-hidden="true">
            {bankOpen ? "▼" : "▶"}
          </span>
          <span style={styles.sectionTitle}>Buy Trains from the Bank</span>
          {/* Design note #812: THE FIGURE THE COMPARISON IS AGAINST, kept when everything else folds away.
              This is the whole difference between the proposal I declined and the one that was made: with the
              tier and its price on the header, a player weighing a corporation's asking price against the
              depot's can still read both at once. Absent when the depot is empty, which the body says in a
              sentence rather than the header saying it in a dash. */}
          {!bankOpen && nextTier && (
            <span style={styles.sectionSummary}>
              {nextTier.tier}-train ${nextTier.cost}
            </span>
          )}
          {buyer && <span style={styles.sectionMeta}>{buyer.ticker} treasury ${treasury}</span>}
        </button>

        {/* Design note #827: THE BODY BELONGS TO THE HEADER THAT OPENS IT.
            REPORTED: "the 'Buy Trains from the Bank' expands/collapses a section that isn't actually inside
            the Buy Trains from the Bank subpanel, which kind of makes it appear like those contents are
            disconnected."
            MY OWN #812, HALF-DONE. That pass gave the bank the roster's HEADER -- "two sections that behave
            differently while looking the same is the kind of difference a player learns by being surprised"
            -- and then left its body as a bare fragment at the section's own level, where the roster's sits
            in `accordionBody` with the inset that makes it read as contained. So the two now look the same
            until you open them, which is the same complaint one layer down. */}
        {/* Design note #837: reference behind a caret, not part of the bar's resting height. */}
        {bankOpen && (
          <div style={styles.accordionBody} {...STICKY_OPTIONAL}>

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
          </div>
        )}

        {/* ==================================================================
             DESIGN NOTE 828: THE CARET HIDES THE REFERENCE, NEVER THE ACTION
            ==================================================================

            The buy row sits OUTSIDE the disclosure now. #812 folded the whole bank section away when the
            roster opened, action included, which was right for the problem it was solving and wrong as a
            general shape: the depot table is reference (#633: "five of the six are reference") and the buy
            row is the step. A caret that can hide the only control on a step is a caret that can leave a
            player looking at a step with nothing on it.
            AND IT IS WHAT MAKES THE PANEL FIT IN THE STICKY BAR. Measured at 242px with the table open,
            against a 326px budget shared with a 185px bar; the row alone is a fraction of that. */}
        {nextTier ? (
          <>
            <div style={styles.buyRow}>
              {/* Design note #294: TWO NUMBERS, TWO SUBJECTS. "Quantity" sat beside a "Trains 2 / 4" readout and the pair
                 was read as one thing -- players could not tell whether the 4 was the depot's stock, the corporation's
                 ceiling, or what the ceiling would be after buying. They are facts about different subjects: one counts
                 cardboard in the bank, the other caps a corporation's holdings this phase. Naming the subject on each is
                 the whole fix -- neither number was wrong, and neither said whose it was. */}
              {/* Design note #719: THE LABEL WRAPS THE CONTROL.
                 REPORTED: 'the "Buy from bank [selector]" could read "Buy [selector] x-train(s) from the Bank"
                 to make it absolutely clear.'
                 "Buy from bank" followed by a row of bare digits leaves the digits' SUBJECT unstated -- #294
                 fixed exactly this failure one element to the right, where a quantity and a limit sat side by
                 side and were read as one figure. The same fix applies here: put the noun in the sentence and
                 the number cannot be read as anything else. The tier is named too, so the row of digits cannot
                 be mistaken for a choice of train.
                 The group carries its own `aria-label` rather than pointing at a fragment, because the visible
                 text is now two spans with the control between them and neither half labels it alone. */}
              <span style={styles.quantityLabel}>Buy</span>
              {/* Design note #247: A DROPDOWN THAT LISTS WHAT IS BUYABLE. Two things were true at once and it was not one
                 bug. IT WAS NOT A DROPDOWN -- it was `<input type="number">` that silently CLAMPED, so typing 2 against a
                 ceiling of 1 rewrote the field mid-keystroke, indistinguishable from the control refusing the digit. A
                 clamp is the right behaviour and the wrong affordance: it enforces a rule the player cannot see by
                 undoing their input.
                 AND THE CEILING WAS OFTEN THE TRAIN LIMIT, NOT THE DEPOT -- `min(depot, limit - owned)` -- so the panel
                 showed the depot's 2 and enforced the limit's 1 without ever mentioning the limit.
                 A `<select>` fixes the first; `ceilingCaption`/`ceilingReason` name which rule set the ceiling and fix
                 the second. */}
              {/* Design note #696: A SEGMENTED ROW, NOT A DROPDOWN.
                 REPORTED: "since players can only ever buy at most 4 trains in one purchase, the drop-down
                 selector is a little over-the-top ... this would only need to show a maximum of 4 until the
                 train limit drops to 3 and then 2, so it could shrink as the phases change. Players only need
                 to click one to change the number instead of once to open a drop-down and once to select."
                 EVERY WORD OF #247 SURVIVES -- it is the CONTROL that changes, not the reasoning. A `<select>`
                 was the fix for an `<input type="number">` that silently clamped, and the property that made it
                 right is that the options ARE the buyable set. A row of buttons has that property just as
                 exactly, in one click instead of two, and it is the same shape as the sell-size and par
                 selectors a player has already used twice by the time they reach this step.
                 IT SHRINKS ON ITS OWN, which is the part that makes a row viable where it would not be for an
                 open-ended count: `supplyCap` is already `min(depot stock, limit headroom)`, so the row is at
                 most four and narrows as the phase turns -- no new rule, and nothing to keep in step. */}
              <div
                style={styles.quantityRow}
                role="group"
                aria-label={`How many ${nextTier.tier}-trains to buy from the Bank`}
              >
                {Array.from({ length: optionCount }, (_, index) => index + 1).map(
                  (option, index) => {
                    const selected = String(option) === quantityText;
                    /* Design note #719: BEYOND THE CAP, NOT OFF THE ROW. The option is drawn, dead, and says
                       why on hover -- `ceilingReason` already names whether it was the depot or the limit that
                       bound, which is the sentence #700 wrote for exactly this hover and which the old row
                       could only ever show on a control that had no dead options left to hover. */
                    const beyondCap = option > supplyCap;
                    const unavailable =
                      !sessionReady || !canAct || atTrainLimit || supplyCap < 1 || beyondCap;
                    return (
                      <React.Fragment key={option}>
                        {/* Design note #19 in `StockRoundPanel`: the separators are `aria-hidden`, so a
                            screen reader hears four options rather than "1 slash 2 slash 3". */}
                        {index > 0 && (
                          <span style={styles.quantitySeparator} aria-hidden="true">
                            /
                          </span>
                        )}
                        <button
                          type="button"
                          aria-pressed={selected}
                          disabled={unavailable}
                          onClick={() => setQuantityText(String(option))}
                          style={{
                            ...styles.quantityOption,
                            ...(selected ? styles.quantityOptionActive : {}),
                            // Design note #681/#687: it passes `disabled`, so it computes a
                            // disabled look. `Lobby.tsx` #3 -- inline styles cannot express
                            // `:disabled`.
                            ...(unavailable ? styles.quantityOptionDisabled : {}),
                          }}
                          title={
                            unavailable
                              ? (ceilingReason ?? "No trains can be bought right now.")
                              : `Buy ${option} ${option === 1 ? "train" : "trains"}.`
                          }
                        >
                          {option}
                        </button>
                      </React.Fragment>
                    );
                  },
                )}
              </div>
              <span style={styles.quantityLabel}>
                {nextTier.tier}-train{quantity === 1 ? "" : "s"} from the Bank
              </span>

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
                    : `This corporation holds ${ownedTrainCount} of the ${trainLimit} trains Project 18XX allows one corporation in this phase. Separate from the depot's own stock above.`
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
                {/* Design note #703: "now 4 · holds 3" REMOVED, on report. #296 added it because "After
                    Purchase: 3" is "a number with no baseline to read it against" -- true of that number
                    alone, and it stopped being the whole line. `ownedTrainCount` is drawn as a train chip
                    for every train the corporation owns two rows up, and the current limit is on the action
                    bar's own rail; restating both here made the busiest line on the panel out of the one
                    that a player reads while deciding. The label still says "After Purchase", which is the
                    tense the bare number needed. */}
              </span>

              {/* ==================================================================
                   DESIGN NOTE 838: THE CEILING CAPTION IS GONE FROM THE BUY LINE
                  ==================================================================
                  REPORTED: "to help with horizontal compression, there's a character string on the Buy line
                  that reads: 'Current Train Limit 2 / 4 Room for 2 more before the 4-train limit.' There's no
                  need for the string."
                  #247 ADDED IT WHEN THE CEILING WAS INVISIBLE -- the panel "showed the depot's 2 and enforced
                  the limit's 1 without ever mentioning the limit". It is mentioned now, twice over and better:
                  the `<select>` lists exactly what is buyable, and "2 / 4" sits immediately to its left.
                  A sentence restating two adjacent numbers is what #703 removed from the line below it.
                  `ceilingReason` SURVIVES, and that is the half that still has no other home: it is the
                  `title` on a dead option, answering "why can I not pick 3" at the moment it is asked. */}


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
                /* Design note #722: THE VISIBLE LABEL IS A PRICE; THE ACCESSIBLE NAME IS A SENTENCE.
                   A button reading "$600" is unambiguous BESIDE the sentence that sets it up, and a screen
                   reader does not get the sentence -- it announces the button alone, out of order and out of
                   context. "$600" would be an unusable control. This is the ordinary fix for a label that
                   leans on its surroundings, and it costs nothing on screen. */
                aria-label={
                  atTrainLimit
                    ? "Train limit reached — no train can be bought."
                    : `Buy ${quantity} ${nextTier.tier}-train${quantity === 1 ? "" : "s"} from the Bank for $${
                        bankTotal || nextTier.cost
                      }.`
                }
              >
                {/* Design note #722: THE COST ALONE.
                   #719 made the row above read "Buy [2] 4-trains from the Bank", and this button was still
                   saying "Buy 2 x 4-Train for $600" a few pixels away -- the same verb, the same quantity and
                   the same tier, twice, with only the price distinguishing them. Two statements of one thing is
                   how a panel gets long, which is the complaint #719 came from.
                   THE PRICE IS WHAT THE BUTTON UNIQUELY KNOWS. Everything else on it was already on the line
                   above, and the total is the one figure that appears nowhere else: the depot table lists the
                   UNIT cost, so `bankTotal` is the only place a multi-buy is priced.
                   THE LIMIT WORDING STAYS, because it is the one state where a price is the wrong thing to
                   show: the button is dead, and the reason beats a number nobody can pay.

                   ==================================================================
                   DESIGN NOTE 796: A PRICE IS NOT A VERB
                   ==================================================================

                   REPORTED: "the clickable button only lists the price that will be paid. It needs to clearly
                   say 'Buy for $X'."

                   #722'S ARGUMENT WAS ABOUT REDUNDANCY AND MISSED WHAT A BUTTON IS FOR. It was right that
                   "Buy 2 x 4-Train for $600" repeats the row above almost word for word -- and wrong to
                   conclude that the fix was to delete the verb. A control has to say what it DOES; "$600" is a
                   label on a figure, and a figure is the one thing on a purchase panel that a player is
                   already reading everywhere else. The redundancy #722 removed was the QUANTITY and the TIER,
                   which really were duplicated. The verb never was.

                   ITS OWN `aria-label` GAVE THE GAME AWAY. #722 wrote a full sentence for screen readers
                   because "'$600' would be an unusable control" out of context -- which is an admission that
                   the visible label was leaning on its surroundings to mean anything. A sighted player
                   scanning a dense panel is closer to that position than the note assumed.

                   "PAY $600" IS BETTER THAN "BUY FOR $600", which was the first draft. Reported: "instead of
                   'Buy for $X' it could say 'Pay $X' since you mentioned before that the line the button is
                   on already says 'Buy 1/2/3/4 x-train(s)'."
                   THAT KEEPS #722'S REAL POINT while fixing what it broke. The row above supplies the verb
                   "buy" and the object; repeating "Buy" on the button is the duplication #722 objected to,
                   and "Pay" is the half of the transaction the button uniquely performs. One word, one
                   figure, no repetition, and it still reads as an action rather than as a caption. */}
                {atTrainLimit ? "Train Limit Reached" : `Pay $${bankTotal || nextTier.cost}`}
              </button>
            </div>
            {bankProblem && <p style={styles.problem}>{bankProblem}</p>}
            {/* ==================================================================
               DESIGN NOTE 751c: THE EMERGENCY IS A BUTTON, BESIDE THE REFUSAL IT ANSWERS
               ==================================================================
               REPORTED: "let's have the normal Buy button grayed out with the explanation as usual, and a
               new 'Emergency Train Purchase' button that opens a modal instead -- it is important that this
               be a button because the corporation could fulfill its obligation by buying from another
               corporation instead."
               PLACED HERE RATHER THAN ON THE ACTION BAR because the sentence above it is the reason it
               exists -- "PRR's treasury holds $500, it cannot pay $630" and then, immediately, the one
               control that can do something about it. A president who reads the refusal and has to go
               looking for the remedy has been told half a thing.
               AND IT DOES NOT REPLACE THE DISABLED BUY. #619's rule: the dead control carries the
               explanation, so removing it would remove the reason. */}
            {onEmergencyPurchase && emergencyAvailable && (
              <button
                type="button"
                style={styles.emergencyButton}
                onClick={onEmergencyPurchase}
                title={
                  `${buyer?.ticker ?? "This corporation"} cannot pay for a train from its treasury. ` +
                  "An emergency purchase draws on the president's own cash, and on share sales if that is " +
                  "not enough. Buying a train from another corporation is the other way out."
                }
              >
                Emergency Train Purchase
              </button>
            )}
            {/* Design note #1 stated this here, "because it is the question a player asks the moment they see a
               quantity field", and #508 hid it when pinned because it "explains a rule rather than a value --
               read once, not on every scroll".
               DESIGN NOTE 810 FINISHES THAT THOUGHT. Requested: "I'm not sure we need 'One tier per purchase...'
               any longer. We can move the important information (buying through a tier requires two actions) to
               a tutorial box."
               #508 HAD ALREADY IDENTIFIED IT AS THE WRONG KIND OF TEXT for this surface and only found half the
               remedy: hiding a rule on scroll makes it intermittent, not relocated. A rule read once belongs
               where rules are read once, and this app has that place -- `TutorialModal`'s "Steps 5 and 6" slide,
               which already covers Buy Trains and did not carry this. The sentence is there now, in full.
               THE PANEL KEEPS EVERY FACT A PLAYER ACTS ON: the purchasable tier, its price, the quantity, the
               button and the "next" caption on the accordion all say cheapest-first in figures rather than in
               prose. What is gone is the paragraph explaining them. */}
          </>
        ) : (
          <p style={styles.empty}>{bankProblem}</p>
        )}

        {/* Design note #719: REFERENCE BELOW THE ACTION.
           REPORTED: "it shows the current trains, then there's a dropdown for Later Trains, then there's the
           Buy from bank [selector].... I think Buy from bank [selector] should be below the current train and
           the Later trains dropdown can be below that?"
           #633 put the accordion here because it is a continuation of the depot table, which is true of the
           MARKUP and wrong about the reading order: it left a collapsed row of reference material sitting
           between the one purchasable tier and the control that buys it. The two halves of a single decision
           had a filing cabinet between them, and opening the accordion pushed the buy row off the bottom of a
           condensed panel entirely. */}
        {bankOpen && laterTiers.length > 0 && (
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
              {/* Design note #719: the count is gone. REPORTED: "Later trains has a parenthetical (5) that I
                 think tells players how many types of trains are left? I'm unsure if it's necessary."
                 It was the number of TIERS not yet for sale, which is not a quantity anybody plans around --
                 it counts rows behind a caret, and it decrements as the game advances in a way that invites
                 reading it as trains remaining. The summary beside it already answers the question a player
                 actually has, which is what comes next and what it costs. */}
              <span style={styles.laterTrainsTitle}>Upcoming Trains</span>
              {/* Design note #633: the collapsed summary answers the
                  commonest reference question -- what is next and what does
                  it cost -- so opening this is for the rarer ones.
                  Design note #798: from `upcomingTier`, not `laterTiers[0]`. The list keeps rusted tiers at
                  the front on purpose; the caption must not read them as "next". */}
              <span style={styles.sectionMeta}>
                {laterTrainsOpen
                  ? "hide"
                  : upcomingTier
                    ? `next: ${upcomingTier.tier}-train $${upcomingTier.cost}`
                    : ""}
              </span>
            </button>
            {laterTrainsOpen && (
              /* Design note #837: the same marker the depot table carries -- five tiers of reference a player
                 opened deliberately, which must not be what decides whether the bar can pin at all. */
              <div style={styles.depotGrid} {...STICKY_OPTIONAL}>
                {laterTiers.map((tier) => (
                  <DepotRow key={tier.tier} tier={tier} isNext={false} />
                ))}
              </div>
            )}
          </>
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

        {/* Design note #837: reference behind a caret, not part of the bar's resting height. */}
        {corporateOpen && (
          <div style={styles.accordionBody} {...STICKY_OPTIONAL}>
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
              ? `Project 18XX's depot sells cheapest-first, so the ${tier.tier}-train is the only one purchasable right now.`
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
        {/* Design note #695: "2-TRAIN", NOT "2".
            REPORTED: "the name of the train is listed as '2' and two entries right of that is '3 / 6 left' --
            there are both 3-train and 6-train options later, and I'm not sure it is as clear here what a player
            is being told."
            THREE BARE NUMERALS ON ONE ROW, and every one of them is a different kind of quantity: a tier, a
            price, and a supply fraction whose numerator is another tier's name. `2 · $80 · 3 / 6` reads as
            four numbers where the first is a NAME. Naming it costs six characters and removes the collision
            entirely -- the reader stops parsing and starts reading. */}
        <span style={styles.depotTier}>
          {tier.tier}
          <span style={styles.depotTierUnit}>-train</span>
        </span>
        <span style={styles.depotCost}>${tier.cost}</span>
        {/* Design note #687: THE SUPPLY IS A FIGURE, AND IT WAS DRESSED AS A FOOTNOTE.
            REPORTED: "the Bank/Depot Supply of trains is hard to notice because it isn't labeled AND its font
            seems to be faded and unbolded against everything else." Both halves are measurable: this cell was
            11px/400 in `#8a919e` while the tier beside it is 13px/800 in `#e6e8ef` -- the smallest, dimmest,
            lightest thing in the row.
            IT IS ALSO THE FIGURE THE PHASE TURNS ON. 1830's depot sells cheapest-first, so how many are left is
            what says when this tier sells out, when the phase advances and when a fleet rusts. A player weighing
            $180 against $300 is weighing exactly that count, and it was set as an aside.
            THE COUNT CARRIES THE WEIGHT, NOT THE WHOLE STRING. Bolding "2 / 4 left" entire would just move the
            problem -- the reader would still have to find the number inside it. The remaining count takes the
            tier's own weight and the rest stays muted, so the cell has an answer and a unit rather than a
            sentence.
            SELF-LABELLED RATHER THAN HEADED -- see the caption note below the grid for why the table has no
            header row. "left" is the label, and it is already in the string. */}
        <span
          style={{
            ...styles.depotSupply,
            ...(tier.remaining === 0 ? styles.depotSupplyEmpty : {}),
          }}
          /* An arrangement of numerals and a slash reads as "two slash four" to a
             screen reader. The sentence says what the row means.
             Design note #687a: IT DOES NOT NAME THE TIER. The first draft read "2 of 4 3-trains left in the
             depot", and the tier is redundant twice over -- it is the cell immediately before this one, so a
             reader hears "three" and then "three-trains" back to back, and a sighted reader has the same
             collision two columns wide. A cell in a labelled row should say what the CELL means; saying what
             the row is about is the row's job, and the row already does it. */
          aria-label={
            tier.total === null
              ? "Unlimited supply in the depot"
              : `${tier.remaining ?? tier.total} of ${tier.total} left in the depot`
          }
        >
          {tier.total === null ? (
            "unlimited"
          ) : (
            <>
              <span
                style={{
                  ...styles.depotSupplyCount,
                  /* Design note #687: the count opts back IN to the empty tint. Without this a
                     sold-out row reads "0 / 4 left" with a bright white zero inside an amber
                     string -- the one glyph saying the tier is gone, drawn as though it were
                     the healthy case. */
                  ...(tier.remaining === 0 ? styles.depotSupplyEmpty : {}),
                }}
              >
                {tier.remaining ?? tier.total}
              </span>
              {` / ${tier.total} left`}
            </>
          )}
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
              title={`${tier.tier}-trains never rust — nothing in Project 18XX removes them from play.`}
            >
              Permanent
            </span>
          ))}
        </span>
      </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /* ==================================================================
     DESIGN NOTE 810: IT RECEDED BECAUSE IT WAS THE DARKEST THING ON THE PAGE
     ==================================================================

     REPORTED: "there is something about this subpanel that doesn't quite grab me or clarify itself: all the
     information is there, but I think the dark blue background that is the same as the main app makes it
     'recede' ... I hesitate to say we should swap it for a parchment color like we have on the corporation,
     company, and player cards ... Maybe the parchment background IS the right choice?"

     THE DIAGNOSIS IS ONE SHADE OFF THE REPORT AND IT MATTERS. This was `#12141b`, which is not the same as
     the app -- it is DARKER than everything around it (`orContextCard` is `#171c28`, the private panel
     `#141a26`). A surface that sinks below its own container reads as a well, and a well is where an app puts
     things it wants you to stop looking at. The instinct "it recedes" is exact; the cause is depth, not hue.

     PARCHMENT IS NOT THE ANSWER HERE, and the reason is a rule this app already keeps rather than a
     preference. Every parchment surface in Project 18XX is a NOUN -- a corporation card, a company card, a
     player card: a thing you hold and read. This panel is a VERB. It is the step's controls, and dressing it
     as a card would say there is a fourth thing to read at the moment a player is being asked to act.
     (It also costs what a swept repaint costs: roughly twenty-five colour tokens in this file are tuned
     against a dark ground, and #732 is the record of what happens when those drift apart.)

     SO IT RISES INSTEAD OF CHANGING MATERIAL. Three changes, each doing one job: the ground goes ABOVE its
     surroundings rather than below; a shadow makes that a lift rather than a lighter patch; and a livery edge
     ties it to the bar overhead, which is the same channel #236 used to make the bar itself findable.
     WHETHER IT NOW GRABS is a playtest question and nothing here can answer it. If it still does not, the
     parchment version is a bigger change and remains available -- and this note is the argument to overrule. */
  /* ==================================================================
      DESIGN NOTE 838: TWO SOURCES, SIDE BY SIDE
     ==================================================================

     ASKED: "it appears you've shrunk the horizontal width of the Buy Trains subpanel, and I'm now wondering
     if it would make sense to have the two options (Buy from Bank, Buy from Corps) side-by-side in a
     two-column layout. That might be 'too much' but it also might help players realize there are two sources
     to buy trains from."

     TWO REASONS AND THE SECOND IS THE BETTER ONE. Stacked accordions make the roster something a player has
     to go looking for, and #293 makes buying compulsory -- so the moment the bank cannot help is exactly the
     moment the second source has to be findable. #765 reported the same shape as "not enough. Buying a train
     from another corporation is the other way out", and the answer then was a sentence.
     AND IT HALVES THE PANEL, which is what lets the depot table stay open inside a pinned bar (#837).

     `auto-fit` PLUS `minmax`, NOT A BREAKPOINT. The fallback to a single column happens when the columns
     would be narrower than 320px, measured by the browser against the panel's actual width -- so it is right
     inside the sticky bar, inside the wider standalone panel, and at any window size, without this file
     holding an opinion about viewport widths it cannot see. A `matchMedia` here would be a third place with a
     guess about layout, and #813 settled that argument: measure, do not assume.

     `alignItems: start` because the two columns are independent. Stretching them to a shared height would
     draw a roster of two corporations as tall as a full depot table and imply a relationship. */
  root: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    alignItems: "start",
    gap: "14px 18px",
    padding: "14px 18px",
    backgroundColor: "#1e2331",
    border: "1px solid #454c5c",
    borderRadius: "10px",
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.45)",
  },
  /* Design note #508: the pinned form. Tighter on every axis and without
     the standalone card treatment -- inside the action bar it is a SECTION
     of that panel rather than a panel of its own, and a bordered box inside
     a bordered box reads as two things when it is one.
     Design note #810: which is also why the lift is dropped when condensed -- a raised, shadowed slab INSIDE
     the bar would be the second box #508 removed, wearing a highlight. The livery edge is spread before this,
     so `borderLeft` is cleared here too and the condensed form keeps its single top rule. */
  rootCondensed: {
    /* Design note #838: the columns survive the condense. It is the same two sources either way, and a bar
       that reflowed them into a stack on the scroll that pins it would move the roster under the player's
       cursor -- `auto-fit` already stacks them when the width genuinely cannot hold two. */
    gap: "8px 14px",
    padding: "8px 10px",
    backgroundColor: "transparent",
    border: "none",
    borderLeft: "none",
    borderTop: "1px solid #2b3242",
    borderRadius: 0,
    boxShadow: "none",
  },
  section: { display: "flex", flexDirection: "column", gap: "10px" },
  sectionHeader: { display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap" },
  /* Design note #812: the tier and price on a collapsed bank header. Monospace and green because it is a
     FIGURE being compared against another figure -- the corporation's asking price a few pixels below -- and
     that is the one job monospace has in this app (#804 settled the same question for the private row's
     income against its acronym). */
  sectionSummary: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#7ee0a1",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "nowrap",
  },
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
  /* Design note #687: NO HEADER ROW, and the reasoning belongs here because the absence is the kind of thing
     that gets "fixed" by the next reader. Asked directly -- "there is a table but no headings for the entries.
     I am not sure if there needs to be one" -- and the answer is no, for three reasons that are about THIS
     table rather than about headers in general:
       TWO OF THE FIVE COLUMNS CANNOT BE HEADED. The row opens with a train glyph and closes with a cluster of
       fate flags; a header would be three captions and two blanks, which reads as a table missing something.
       THE CELLS SELF-LABEL. "$180" and "2 / 4 left" carry their own units. `PlayerCards` #567 removed three
       marks for exactly this reason -- a caption over a string that already says what it is, is one more thing
       to read and nothing more to know.
       AND THE GRID RENDERS TWICE -- once for the purchasable tier, once inside the "Later trains" accordion.
       One header serves the first list and leaves the second bare, or it is repeated and the panel gains two
       header rows for six data rows.
     WHAT THE REPORT WAS ACTUALLY ABOUT was weight, not vocabulary: the supply cell was set as an aside. That is
     fixed above. If a header still turns out to be wanted, it belongs over the three data columns only, with the
     accordion's list sharing it -- not as a `<thead>` per grid. */
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
    /* Design note #695: the tier column widens 26 -> 68 to hold "-train". #618's argument for FIXED columns is
       unchanged and is why this is one edit rather than a `flex` that would let the longest row decide. */
    gridTemplateColumns: "58px 68px 56px 84px 1fr",
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
    whiteSpace: "nowrap",
  },
  /* Design note #695: the unit is quieter than the numeral it qualifies. The tier is the thing being chosen;
     "-train" is there to stop it being read as a count, and a suffix at equal weight would just be a longer
     number. */
  depotTierUnit: { fontWeight: 400, color: "#8a919e" },
  depotCost: {
    fontSize: FONT_SIZE.small,
    color: "#c8cdd8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
  },
  /* Design note #687: a step up to `small`, matching the cost column beside it -- the two are the pair a
     purchase is decided on and they should read as peers. The muted ink stays on the UNIT ("/ 4 left"), which
     is genuinely secondary; the count opts back out below. */
  depotSupply: {
    fontSize: FONT_SIZE.small,
    color: "#8a919e",
    whiteSpace: "nowrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
  },
  /* Design note #687: the remaining count, at the tier column's weight and ink. Tabular figures come from the
     parent, so "10 / 12" and "2 / 4" keep their slash on the same x down the six rows -- #618's whole argument
     for fixed columns, applied inside one of them. */
  depotSupplyCount: { fontWeight: 800, color: "#e6e8ef" },
  /* Design note #618: the shared right-hand column the fate flags live in,
     so "rusted" / "For Sale" / "Rusts on Phase 5" / "Permanent" all start on
     the same x whatever the row above said. */
  depotFate: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
  /* Design note #687: spread onto the CELL and, separately, onto the count inside it. An inline style on a
     child does not inherit through a `color` set on its parent when the child sets its own -- and the count
     does set its own, so a sold-out row would have shown a bright white `0` inside an amber string reporting
     that the tier is gone. */
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
  /* Design note #696: `quantitySelect` is GONE with the dropdown it styled. The row below is the same shape
     `StockRoundPanel`'s sell-size and par selectors use -- one bordered group, options separated by slashes,
     the chosen one filled -- so a player meets one control three times rather than three controls once each.
     Deleted rather than left: an unused style for a dropdown somebody just asked us to replace is how the
     dropdown comes back (`palette.ts`'s rule for its removed colour token). */
  quantityRow: {
    display: "inline-flex",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: "1px",
    padding: "4px 6px",
    borderRadius: "7px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1b1e27",
  },
  quantityOption: {
    /* Design note #732: `backgroundColor`, not the `background` shorthand -- `quantityOptionActive` below
       toggles the longhand on THIS element, which is the exact pairing that gave the Tiles tab a white
       background on deselect. Found by the sweep that fix prompted rather than by a report, so this one never
       shipped the symptom. */
    backgroundColor: "transparent",
    border: "none",
    padding: "3px 8px",
    borderRadius: "5px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
    color: "#9aa0ac",
    cursor: "pointer",
  },
  quantityOptionActive: { backgroundColor: "#2b3a4d", color: "#e6e8ef" },
  quantityOptionDisabled: { opacity: 0.45, cursor: "not-allowed" },
  /* Non-interactive, `aria-hidden` at the call site -- it separates the options visually and says nothing. */
  quantitySeparator: { color: "#3a3f4b", fontSize: FONT_SIZE.small },
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
  /* `limitWas` is gone with design note #703's "now 4 · holds 3". */
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
  /* Design note #751c: amber, not green and not the disabled grey. It is a live control, so it must not read
     as dead; it is a last resort that spends the president's own money, so it must not read as the ordinary
     purchase either. The Phase Shift warning on the action bar already uses this register for "you may do
     this, and you should understand it first". */
  emergencyButton: {
    alignSelf: "flex-start",
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #f59e0b",
    backgroundColor: "#3a2a10",
    color: "#fcd34d",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
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
