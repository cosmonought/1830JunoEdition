// frontend/src/panels/ContextualActionBar.tsx
//
// THE CONTEXTUAL TOP ACTION BAR -- the strip that swaps its controls to match the live round type and
// Operating Round sub-phase. Moved out of `App.tsx` unchanged.
//
// `panels/` rather than `components/` because this is not a reusable widget but one named region of
// the game screen, assembled from widgets that DO live in `components/`. The distinction is worth a
// directory: it tells the next reader which files they may freely reuse.
//
// `ActionBarButton`, `useCondensedOnScroll`, `ZonedPrice` and `MarketMoveLine` travelled with it --
// each had exactly one consumer and that consumer is this file. Leaving any behind would have meant
// `App.tsx` exporting a helper solely so this panel could import it back.
//
// Design notes: shell/layout in `docs/ai_architecture/ui_shell_layout.md`, economics in
// `contract_economy.md`, the market-move line in `stock_market.md`.

import React from "react";

import { TrainChips } from "../components/TrainBadges";
import { RouteChipDetail } from "../components/RouteChipDetail";
import PrivatePowerPanel, {
  type PrivateAbility,
  type PrivateAbilityAction,
} from "../components/PrivatePowerPanel";
// Design note #623: `RunRoutesButton` joins them -- the step's finishing
// action belongs on the bar that follows the player down the page.
/* Design note #802: `RoutePlannerPanel` itself is no longer imported -- the chip detail replaced it. The
   FILE stays, and deliberately: it exports `AutoRouteButton` and `RunRoutesButton`, which the bar's button
   row still renders, and `TrainRouteDraft`, which is the shape the shell, the map and the new strip all
   speak. Deleting the component would take three live exports with it. */
import { AutoRouteButton, RunRoutesButton } from "../components/RoutePlannerPanel";
// Design note #715: the private-purchase panel, embedded rather than modal.
import { ProposePrivatePurchase } from "../components/PrivateTradePanel";
import TrainPurchasePanel, {
  type TrainPurchaseCompany,
  type TrainTradeProposal,
} from "../components/TrainPurchasePanel";
import type { TrainRouteDraft } from "../components/RoutePlannerPanel";
import StationTokenRow from "../components/StationTokenRow";
import {
  /* Design note #481: `OperatingSubPhaseStepper` is no longer imported -- the strip it renders became an
     inline phrase. The component is kept because it is a correct rendering of the turn sequence and the
     rules reference is the natural home for one. `visibleSubPhases` is what this file needs from it now,
     so the count reads "2 of 5" in the Yellow era and "2 of 6" from Phase 3 rather than a fixed six. */
  OPERATING_SUB_PHASE_LABELS,
  visibleSubPhases,
  type OperatingSubPhase,
} from "../components/OperatingSubPhaseStepper";
import {
  ZonedPrice,
  type MarketProjection,
} from "../components/StockMarketRenderer";
import {
  bestContrastTextColor,
  stationTickerColor,
} from "../components/hexContractTypes";
import type { StationTokenSlot } from "../utils/stationTokens";
import type { PrivateCompanyState } from "../utils/gameState";
import type { RoundType, TileColor } from "../utils/gameState";
import {
  phaseAlertLevel,
  type GamePhase,
  type TierRustOutlook,
  type TrainTier,
} from "../utils/gamePhase";
import {
  isPlayingSurface,
  labelForTab,
  misplacedSurfaceTab,
  type MainTab,
} from "../components/MainTabBar";
// Design note #601: `ROSTER_CONTEST_CHASE_CSS` gone with the pills it chased.
import { TURN_HANDOFF_SWEEP_CSS } from "../styles/animations";
// Design note #410: shared with the Stock Card stripe.
import { CorporateLogo } from "../components/CorporateLogo";
// Design note #552: the shipped crown, not a platform emoji.
import { PresidentCrown } from "../components/PresidentCrown";
import { NO_TRAIN_ROUTE_REASON } from "../utils/gameConstants";
import { passButtonLabel, passButtonTitle } from "../utils/turnAction";
import {
  canPinWithoutTrapping,
  shouldCondenseSticky,
  stickyTopOffset,
} from "../utils/stickyCollapse";
import type { DepotTier } from "../utils/gamePhase";
import { dividendDeclaration, marketMoveDirection } from "../utils/dividendStep";
// Design note #494: the per-train route ink, so the collapsed chips match
// the lines on the map.
import { routeTrainColor } from "../styles/routeLivery";
import { styles, PHASE_TINT_STYLES } from "../styles/appStyles";
// Design note #707: a corporation that can run must run.
import { routeRunObligation } from "../utils/routeStep";
// Design note #705: the row as one sentence, built from the fields the row renders.
import {
  describeDividendRow,
  type DividendPayoutProjection,
} from "../utils/dividendProjection";

/* ------------------------------------------------------------------ */
/* Contextual Top Action Bar -- see design note #8/item 5              */
/* ------------------------------------------------------------------ */

interface ActionBarButton {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

/** Design note #805: the herald's height, in one place because TWO things now depend on it.
 *
 *  The corporation card is two columns of two rows. On the left, the herald sits above the full name; on the
 *  right, the treasury sits above the president. The president lands on the full name's line ONLY IF the
 *  right column's first row is exactly as tall as the herald -- which is a relationship, not a coincidence,
 *  and the sort of thing that survives about one refactor when it is written as `24` in two places.
 *  A number rather than a style key because `appStyles.ts` cannot see the `size` prop this is passed to. */
const CORPORATION_HERALD_PX = 24;

/** Design note #831: a stand-in for a caller with no map on screen. A ref that never resolves makes the hook
 *  a no-op and the button greyed -- the same answer an absent step panel gets, reached the same way, rather
 *  than a second branch inside the hook for "no target". */
const EMPTY_JUMP_REF: React.RefObject<HTMLElement | null> = { current: null };




/* Design note #197's ZonedPrice moved to `StockMarketRenderer` at #712, when the Stock Round's corporation
   cards needed the same tinted figure. Its reasoning is unchanged and now lives beside the zone table it
   reads: "a player reading this panel is looking at a NUMBER, not the chart, so stepping into the Yellow zone
   was invisible exactly when it mattered." */

function MarketMoveLine({
  currentPrice,
  projection,
  direction,
}: {
  currentPrice: number | null;
  projection: MarketProjection | null;
  /** Which way the token travels: paying out steps right, withholding left. */
  direction: "pay" | "withhold";
}) {
  /* Design note #214: THE ARROW CARRIES THE MEANING (glyph superseded by #489; the colour argument
     stands). Grey arrows made the two columns look identical at a glance, so green for the rise and red
     for the fall lets the choice be made peripherally. The PRICES keep their own zone colours -- a rules
     fact that must not be overwritten by the direction.
     Design note #489: THE MONEY MOVED, NOT THE CARDBOARD. #214 chose diagonals to describe the token's
     TRAVEL, which is the thing this line was never about -- a player reading a payout panel is deciding
     between two amounts of money, and the chart's geometry is how the board implements that consequence.
     So the arrow is straight and says only "becomes".
     AND THE COLOUR IS COMPUTED FROM THE PRICES, which fixes a real bug: `rising` was `direction === "pay"`,
     an assumption that paying always raises the price. It does not at the RIGHT-HAND END OF A ROW, where
     the old line drew a confident green up-arrow between two identical numbers. FLAT IS ITS OWN CASE. */
  const movement = marketMoveDirection(currentPrice, projection?.price);

  // No chart position at all -- an unfloated corporation, or a price the
  // grid has no cell for. Saying so beats printing an arrow between two
  // dashes, which would read as a move to nowhere.
  if (projection === null || currentPrice === null) {
    return (
      <span style={styles.dividendMove}>
        Market move: not on the market chart
      </span>
    );
  }

  return (
    <span style={styles.dividendMove}>
      Market move: <ZonedPrice price={currentPrice} />{" "}
      <span
        style={{
          ...styles.dividendMoveArrow,
          ...(movement === "rise" ? styles.dividendMoveArrowUp : {}),
          ...(movement === "fall" ? styles.dividendMoveArrowDown : {}),
          ...(movement === "flat" ? styles.dividendMoveArrowFlat : {}),
        }}
        // The arrow is decoration for a sighted reader and the whole
        // comparison for everyone else, so it is labelled rather than
        // hidden. Design note #489: the label states the OUTCOME, matching
        // what the colour now encodes.
        role="img"
        aria-label={
          movement === "rise" ? "rises to" : movement === "fall" ? "falls to" : "stays at"
        }
      >
        &#10132;
      </span>{" "}
      <ZonedPrice price={projection.price} />
      {/* The edge of the chart: both prices and the arrow are still there and simply equal, with the reason
         appended -- "$100 -> $100" with no explanation looks like a bug rather than a ceiling. WHICH edge is a
         fact about the token's travel, so this is the one place `direction` is still the right thing to read. */}
      {!projection.moves && (
        <span style={styles.dividendMoveNote}>
          {direction === "pay"
            ? " (already at the top of its row)"
            : " (already at the bottom of its row)"}
        </span>
      )}
    </span>
  );
}

/* Design note #298: what a pinned bar is allowed to keep. A sticky bar costs the map its height for the
   whole scroll, so the rule was: keep what a player needs WHILE LOOKING AT THE BOARD (the phase badge,
   the acting corporation, treasury, train limit, every action button), drop what only answers "where am
   I in the turn". Superseded by #590, which found the premise -- that space is scarce -- untrue.
   Design note #480: MEASURE THE PANEL, NOT THE PAGE. `window.scrollY > 24` collapsed the bar while it
   still sat mid-viewport (`utils/stickyCollapse.ts`), so the hook hands back a ref as well as the flag.
   The rAF matters more now: this calls `getBoundingClientRect`, which forces layout, so the read is
   coalesced to one per frame. `resize` is listened to alongside `scroll` because a reflow above the
   panel moves its pin line without the scroll position changing -- and a media query may change the
   sticky offset too. */
function useCondensedWhenPinned(): [React.RefObject<HTMLDivElement>, boolean, boolean, number] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [condensed, setCondensed] = React.useState(false);
  /* Design note #810: how much of the viewport's top edge this bar covers when it is pinned.
   *
   * REPORTED: "the Buy Trains auto-scroll 'works,' but the Action Bar covers the actual Buy Trains subpanel,
   * so players who click it may still be confused what they need to do."
   *
   * ALREADY MEASURED, NEVER PUBLISHED. `measure` below reads the bar's height and its sticky offset every
   * frame for #720's pin test, and both numbers were thrown away afterwards -- so two other places had to
   * guess about a quantity this hook already knew. That is the same shape as the last four reports: an
   * authority that was never asked.
   *
   * `stickyTop + height` rather than `height`, because the bar sits AT `stickyTop`, so the first pixel a
   * scrolled-to panel may occupy is below both. ZERO WHEN IT CANNOT PIN -- a `position: static` bar scrolls
   * away with the page and covers nothing, which is #720's own state and would otherwise reserve a gap for a
   * bar that is not there.
   *
   * ROUNDED, AND ONLY SET WHEN IT CHANGES. `measure` runs in a rAF on every scroll event; a sub-pixel rect
   * would re-render the bar and re-create the observer below on every frame of a drag. */
  const [barClearance, setBarClearance] = React.useState(0);
  /* Design note #720: whether the bar is short enough to pin at all. Starts `true` -- the pre-#720 behaviour --
     so the first paint is unchanged and the measurement corrects it a frame later. */
  const [mayPin, setMayPin] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;

    let queued = false;
    /* Cached because it changes only with layout, not with scrolling, and
       `getComputedStyle` in a scroll handler is a second forced style
       recalculation per frame for a value that is almost always "0px". */
    let stickyTop: number | null = null;

    const measure = () => {
      const node = ref.current;
      if (!node) return;
      if (stickyTop === null) {
        stickyTop = stickyTopOffset(window.getComputedStyle(node).top);
      }
      const rect = node.getBoundingClientRect();
      /* Design note #720: measured on the SAME rect as the pin distance, in the same rAF. Two reads would be
         two forced layouts per frame for numbers that must agree with each other. */
      const pinnable = canPinWithoutTrapping(rect.height, window.innerHeight, stickyTop);
      setMayPin(pinnable);
      // Design note #810: the same rect, in the same frame, for the same reason the pin test uses it.
      const clearance = pinnable ? Math.round(stickyTop + rect.height) : 0;
      setBarClearance((was) => (was === clearance ? was : clearance));
      const distanceToPin = rect.top - stickyTop;
      /* A bar that cannot pin must not CONDENSE either. Condensing is a response to being stuck, and a static
         element's rect top goes negative simply by scrolling past it -- so the untouched predicate would shed
         rows as the bar left the screen, for space nothing was competing for. */
      setCondensed((was) => (pinnable ? shouldCondenseSticky(distanceToPin, was) : false));
    };

    const schedule = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        measure();
      });
    };

    const onResize = () => {
      stickyTop = null;
      schedule();
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize);

    /* ==================================================================
       DESIGN NOTE 758: THE RULE WAS RIGHT AND ITS TRIGGER WAS INCOMPLETE
       ==================================================================

       REPORTED: "A similar bug as occurred with the Buy Private Company sticky, the sticky for Buy Trains
       from Other Corporations is so large when all corporations are operating that it takes up the whole
       screen and cannot be scrolled to the bottom until the screen behind it is scrolled all the way down."

       "A SIMILAR BUG" IS EXACTLY RIGHT, AND #720 ALREADY FIXED THE RULE. `canPinWithoutTrapping` is sound and
       was already being applied to this same bar. What it was wired to is the problem: scroll and resize --
       two things that describe the VIEWPORT. The quantity that actually changes here is the PANEL. "Buy
       Trains from a Corporation" is an accordion, and the seller roster inside it grows with every
       corporation that owns a train, so the bar can double in height with the viewport untouched and nothing
       telling the measurement to look again.

       SO A STALE `mayPin` FROM WHEN THE ACCORDION WAS SHUT keeps the bar pinned while it is too tall to pin.
       A scroll eventually corrects it, which is why this reads as "cannot be scrolled to the bottom UNTIL the
       screen behind it is scrolled" rather than as a permanently broken panel -- the fix arrives, one gesture
       after it was needed.

       A `ResizeObserver` IS THE WHOLE FIX, and it covers the cases nobody has thought of yet: a longer
       refusal message wrapping to three lines, a tray added next year, a font-size preference. Anything that
       changes the bar's height now re-asks the question, which is what #720 meant to happen and wired to the
       wrong events.

       FEATURE-DETECTED because this hook renders under jsdom in the component tests, where `ResizeObserver`
       is not always defined -- and an absent observer must degrade to the old scroll-and-resize behaviour
       rather than throwing on mount. */
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    if (observer && ref.current) observer.observe(ref.current);

    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, []);

  return [ref, condensed, mayPin, barClearance];
}

/** ==================================================================
 *   DESIGN NOTE 813: WOULD THEY FIT? MEASURE IT INSTEAD OF GUESSING AGAIN
 *  ==================================================================
 *
 *  ASKED: "we have slimmed the Buy Trains subpanel so much that I am wondering if it makes sense to condense
 *  it into the sticky Action Bar ... My only fear is that Buy Trains from Corporation, when there are 8
 *  operating corporations, may expand and create a scrolling problem like we had before."
 *
 *  THE FEAR IS THE RIGHT ONE AND WE HAVE GUESSED THIS TWICE. #508 moved the panel INTO the bar on the
 *  reasoning that it would be "sticky by inheritance"; #720 then found that a sticky element past half the
 *  viewport traps the page and taught the bar to unpin itself; #785 moved the panel back OUT because the depot
 *  reliably tripped that. Two moves, two guesses about one number, and the failure mode is silent -- a bar
 *  that stops being sticky looks like a bar that was never sticky, which is exactly how it was reported.
 *
 *  SO THIS MEASURES THE QUESTION RATHER THAN ANSWERING IT. The number that matters is not the bar's height
 *  today: it is what the bar WOULD be with the step panel inside it, against the viewport it is actually
 *  played on. Both nodes already carry refs, so both can be read.
 *
 *  IT CONSULTS THE AUTHORITY RATHER THAN REIMPLEMENTING IT. The verdict comes from `canPinWithoutTrapping`,
 *  the same predicate #720 enforces, so the probe cannot say "would pin" about a bar the rule would unpin --
 *  which is the failure this session has found four times in other guises.
 *
 *  RENDERED OUTSIDE THE BAR, deliberately. A readout inside the element being measured adds its own height to
 *  the reading, and a measurement that changes what it measures is worse than none.
 *
 *  TEMPORARY, and saying so is part of it: this exists to settle one question. Once the answer is in, either
 *  the panels move and this comes out, or they stay and this comes out. */
function useStickyFitProbe(
  barRef: React.RefObject<HTMLDivElement>,
  panelRef: React.RefObject<HTMLDivElement>,
): string | null {
  const [reading, setReading] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let queued = false;

    const measure = () => {
      const bar = barRef.current;
      if (!bar) return;
      const barHeight = Math.round(bar.getBoundingClientRect().height);
      const panelHeight = Math.round(panelRef.current?.getBoundingClientRect().height ?? 0);
      // Nothing rendered on this step: a probe about a panel that is not there would read as a verdict.
      if (panelHeight === 0) {
        setReading((was) => (was === null ? was : null));
        return;
      }
      const viewport = window.innerHeight;
      const stickyTop = stickyTopOffset(window.getComputedStyle(bar).top);
      /* ==================================================================
         DESIGN NOTE 828a: THE PROBE HAD TO STOP ADDING WHAT IT NOW CONTAINS
         ==================================================================

         #813 measured `bar + panel` because the panel was a SIBLING and the question was what the bar would
         become if it swallowed it. #828 moved the panel inside, so `getBoundingClientRect` on the bar already
         includes it -- and the same arithmetic would have reported roughly double, said WOULD UNPIN, and been
         believed. An instrument that lies is worse than none, which is the sentence its own harness opens
         with; this is that sentence being tested.

         ASKED OF THE DOM RATHER THAN OF A FLAG. `contains` is true exactly when the panel is nested, so the
         probe cannot fall out of step with a later move the way a hand-set boolean would. It is also what
         makes the readout self-describing: it says which arrangement it measured. */
      const nested = panelRef.current !== null && bar.contains(panelRef.current);
      const combined = nested ? barHeight : barHeight + panelHeight;
      const share = viewport > 0 ? Math.round((combined / viewport) * 100) : 0;
      const verdict = canPinWithoutTrapping(combined, viewport, stickyTop)
        ? "would stay pinned"
        : "WOULD UNPIN";
      const shape = nested
        ? `bar ${barHeight} (panel ${panelHeight} inside)`
        : `bar ${barHeight} + panel ${panelHeight}`;
      const next = `fit probe · ${shape} = ${combined}px · ${share}% of ${viewport}px · ${verdict}`;
      setReading((was) => (was === next ? was : next));
    };

    const schedule = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        measure();
      });
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    /* #758's lesson, applied here from the start rather than after a report: the panel's height changes with
       the corporate accordion and with the number of operating corporations, neither of which is a scroll or
       a resize. Feature-detected for the same reason -- jsdom does not always define it. */
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    if (observer) {
      if (barRef.current) observer.observe(barRef.current);
      if (panelRef.current) observer.observe(panelRef.current);
    }

    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [barRef, panelRef]);

  return reading;
}


export default function ContextualActionBar({
  roundType,
  orSubPhase,
  sessionReady,
  onPassTurn,
  autoPass,
  passDisabledReason,
  turnActionTaken,
  onPlaceStationTokenHint,
  stationTokenCost,
  maxRouteRevenue = null,
  activeCorporation,
  pendingTreasury = null,
  tokenTargetMode,
  setTokenTargetMode,
  onSkipSubPhase,
  orSequence = null,
  trainPurchase = null,
  armedErrand = null,
  mapRef,
  privatePurchase,
  onOpenPrivateTrade,
  ownsAnyTrain,
  mustBuyTrain,
  activePlayerName,
  activePlayerCash,
  activePlayerEscrow,
  actingSeatColor = null,
  privateCompanies,
  privatePowerViewer,
  sandboxMode,
  usedPrivateAbilities,
  privateActionBlocks,
  privateAbilityError = null,
  onUsePrivateAbility,
  onRunTrains,
  onPayDividends,
  onWithholdRevenue,
  dividendRevenue,
  dividendRevenueIsThisTurn,
  dividendPerShare,
  dividendPayouts,
  rustOutlookForBar,
  dividendPrice,
  payProjection,
  withholdProjection,
  selectedHardwareModel,
  onEndOperatingTurn,
  onUndoLastAction,
  undoBlockedReason = null,
  seatOrderTrail = null,
  onAutoRoute,
  onSelectRouteTrain,
  highlightedRouteIndex,
  onHighlightRoute,
  trainDrafts,
  activeTrainIndex,
  routeFeedback,
  onClearRoute,
  currentGlobalEra,
  activeTab,
  onSelectTab,
  isMyTurn,
  phase,
}: {
  roundType: RoundType | null;
  /** Only meaningful while `roundType === "OperatingRound"` -- see design
   *  note #10/item 2. */
  orSubPhase: OperatingSubPhase;
  sessionReady: boolean;
  onPassTurn: () => void;
  /** Design note #717: the standing-pass control. `null` where there is no such thing to offer. */
  autoPass?: {
    armed: boolean;
    onOpenSettings: () => void;
    onDisarm: () => void;
  } | null;
  /** Design note #31: why passing is currently illegal, or `null`. The
   *  waterfall forbids it while no private holds a standing bid
   *  (`waterfall.rs` doc comment #1) -- a fact only the caller has. */
  passDisabledReason: string | null;
  /** Design note #745: has the acting seat already sold this turn? The bar renders the fact; the reducer
   *  decides it. `undefined` reads as "no", which is the right answer everywhere outside a Stock Round. */
  turnActionTaken?: boolean;
  onPlaceStationTokenHint: () => void;
  /** Design note #181: what a token costs this corporation, for the button
   *  label. A number rather than a formatted string so the caller cannot
   *  quietly change the currency here. */
  stationTokenCost: number;
  /** Design note #707: the best total `assignRouteSet` can find for the acting corporation -- `0` for
   *  "nothing to run", `null` for "could not tell". The Routes step's Skip is withdrawn on a positive figure
   *  and on nothing else; see `routeStep.ts` for why `null` must never block. */
  maxRouteRevenue?: number | null;
  /** Design note #228: who is acting, and the three figures that gate what
   *  they can do this turn. `null` before the first `GetGameState` resolves
   *  or when the operating queue names a company this build does not know --
   *  the card then says so rather than rendering blanks. */
  activeCorporation: {
    companyId: number;
    ticker: string;
    fullName: string | null;
    homeHexLabel: string | null;
    privates: readonly PrivateCompanyState[];
    presidentLabel: string | null;
    /** Design note #441: the president's ADDRESS, not their display name.
     *  A corporate private power is executed by the person holding this
     *  corporation's controls, and that is an identity comparison -- two
     *  seats can share a truncated label, so the label cannot answer it. */
    presidentAddress: string | null;
    /* Design note #806: `presidentCash` is GONE, and #326's figure with it -- see the render site for the
       argument. The prop had exactly one consumer, the tooltip, so leaving it declared would be a value the
       shell computes every render for nobody: #660a's dead `eligiblePrivatesForPurchase` in miniature, and
       invisible to both `tsc` and ESLint because an unread prop is legal. */
    treasury: number;
    /** Design note #237: the whole allowance, one entry per token, with its
     *  own escalating price. Replaces the `stationsLeft`/`stationLimit`
     *  pair, which could only express a fraction. */
    stationSlots: readonly StationTokenSlot[];
    trains: readonly string[];
  } | null;
  /** Design note #673: the tile lay currently being previewed, or `null` when
   *  none is or when it is free.
   *
   *  A SEPARATE PROP rather than a field on `activeCorporation`, deliberately:
   *  that object is what the corporation IS, and this is a gesture in flight
   *  that has not happened and may never. Folding a pending figure into the
   *  standing record is how a preview ends up read as a fact. */
  pendingTreasury?: { fee: number; after: number } | null;
  /** Design note #159: whether station-token targeting is armed, and the
   *  setter behind the banner's own Cancel. Passed rather than owned here
   *  because the CANVAS is the other half of this mode and lives in the
   *  parent. */
  tokenTargetMode: boolean;
  setTokenTargetMode: (on: boolean) => void;
  /** Design note #144: dispatches the real `AdvanceOperatingSubPhase`, so every skip is an on-chain,
   *  replayable event. The old client-only `setOrSubPhase` advanced the UI while the contract's cursor
   *  stayed put, which under G-14 enforcement would desync the bar from what the chain accepts. */
  onSkipSubPhase: () => void;
  /** Opens the propose-purchase sheet -- design note #165. */
  onOpenPrivateTrade: () => void;
  /** Drives the Routes skip button's disabled state -- see its `title`. */
  ownsAnyTrain: boolean;
  /** Design note #293b: the corporation's roster is REPORTED and EMPTY, so
   *  1830's mandatory purchase applies. Distinct from `!ownsAnyTrain`,
   *  which is also true when the chain simply did not say. */
  mustBuyTrain: boolean;
  /* Design note #300: the player's own money was nowhere on this panel. The bar reports the CORPORATION's
     treasury -- what pays for track, tokens and trains -- and said nothing about the player's own cash,
     which pays for shares, privates and the president's emergency purchase (#293). Both pockets are spent
     from this screen, and a president told "you must buy a train" with no way to see whether they can
     cover it is being asked a question the UI refuses to answer. */
  activePlayerName: string | null;
  /** Design note #317: AVAILABLE cash during the auction, total otherwise. */
  activePlayerCash: number | null;
  /** How much of their money is standing on bids. `0` outside the auction. */
  activePlayerEscrow: number;
  /** Design note #342: every seat, in order, with its spendable cash. Empty falls back to the acting-player
   *  badge.
   *  Design note #570: THE BAR WEARS WHOSE TURN IT IS. Players found the panel easy to see during an
   *  Operating Round and hard to see otherwise -- and that pairing is the answer: an OR bar carries the
   *  acting corporation's livery as a block of colour, and a block of colour is what makes a panel findable.
   *  The seat-driven rounds have an acting PLAYER; #569 gave every seat a colour and this spends it.
   *  A STRIPE, NOT A FILL: an OR turn is ABOUT a corporation, while a Stock Round turn is a player choosing
   *  among eight companies. Enough to locate, not enough to claim. `null` outside those rounds, so an
   *  Operating Round cannot wear two identities at once. */
  actingSeatColor?: string | null;
  /* Design note #601: `playerRoster` is gone. The bar never read it except in the unreachable pill branch
     -- `App.tsx` still computes the figures and hands them straight to `SeatOrderTrail`.
     Design note #0 in `PrivatePowerPanel.tsx`. */
  privateCompanies: readonly PrivateCompanyState[];
  privatePowerViewer: string | null;
  sandboxMode: boolean;
  /** Design note #442: keyed by ACTION, not by private id -- the D&H's
   *  two powers are spent independently. */
  usedPrivateAbilities: ReadonlySet<string>;
  /** Design note #725: per-action refusals for the private powers, keyed by action key. Passed straight
   *  through -- the bar hosts the panel but has no opinion about the D&H's ordering rule. */
  privateActionBlocks?: Readonly<Record<string, string | null>>;
  /** Design note #573b: why the last exchange refused. */
  privateAbilityError?: string | null;
  onUsePrivateAbility: (ability: PrivateAbility, action: PrivateAbilityAction) => void;
  onRunTrains: () => void;
  onPayDividends: () => void;
  onWithholdRevenue: () => void;
  /* Design note #510: `onJumpToTrainPurchase` is gone with the button it drove -- see the render site.
     Design note #517: which Operating Round this is, as the board counts them (`macro_round_number` and
     `sub_round_index`, rendered "3.2"). PASSED RATHER THAN DERIVED, because this bar has no game state.
     `null` before the first poll keeps the bare "Operating Round" wording rather than a placeholder pair. */
  orSequence?: { cycle: number; index: number } | null;
  /** Design note #817: the private power currently holding the board, and the way out of it.
   *
   *  REPORTED: "I have no clear way of escaping this action if I decide I don't want to do it ... they may
   *  think once they click the Special Power they have no choice but to follow through on it."
   *
   *  THE ESCAPE EXISTED AND WAS INVISIBLE, which is the worse of the two failures: clicking off the hex has
   *  always cancelled in effect, and #817 makes that official -- but a rule a player has to discover by
   *  disobeying the interface is not a rule they have. So the bar names it.
   *  `null` for a compulsory home-station errand, which has no exit by design. */
  armedErrand?: { label: string; onCancel: () => void } | null;
  /** Design note #831: the Rail Map, so the Lay Track step can offer the same jump the purchase steps do.
   *  Owned by the shell, because the bar has no canvas -- and optional, because a caller without one gets a
   *  greyed button rather than a broken one. */
  mapRef?: React.RefObject<HTMLElement | null>;
  /** Design note #715: everything the embedded `ProposePrivatePurchase` needs, as ONE object -- the same
   *  shape and for the same reason as `trainPurchase` below. `null` renders no panel. */
  privatePurchase?: {
    buyerTicker: string;
    privates: readonly PrivateCompanyState[];
    treasury: number;
    labelForAddress: (address: string) => string;
    /** Design note #779: the holder's seat colour, resolved by the shell (it has the roster index). */
    colorForAddress?: (address: string) => string | null;
    onPropose: (privateId: number, price: number) => void;
  } | null;
  /** Design note #508: everything `TrainPurchasePanel` needs, as ONE object. These are not facts this bar
   *  reasons about -- it neither reads nor derives any of them -- they are a child's props passing through,
   *  and spreading them across the bar's interface would imply the bar has an opinion about the depot.
   *  `null` outside the step renders nothing. */
  trainPurchase?: {
    depot: readonly DepotTier[];
    buyer: TrainPurchaseCompany | null;
    companies: readonly TrainPurchaseCompany[];
    canAct: boolean;
    blockedReason: string | null;
    onBuyFromBank: (tier: string, quantity: number) => void;
    /** Design note #751c: opens the emergency modal, and whether the corporation is short enough to need it.
     *  Passed straight through -- the bar is a conduit, not a decider. */
    onEmergencyPurchase?: () => void;
    emergencyAvailable?: boolean;
    onProposeTrade: (proposal: TrainTradeProposal) => void;
    labelForAddress: (address: string) => string;
  } | null;
  /** Design note #188: the acting corporation's last route revenue, and the
   *  per-10%-share split of it. */
  dividendRevenue: number;
  /** Design note #278: whether `dividendRevenue` was earned on THIS turn.
   *  `false` only when this corporation is known to have skipped the Routes
   *  step, which makes a carried-over figure from a previous Operating
   *  Round non-binding. */
  dividendRevenueIsThisTurn: boolean;
  dividendPerShare: number;
  /** Who receives what, already resolved to display names. */
  /* Design note #705: `cashBefore`/`cashAfter` are `null` for a holder with no balance to project -- the bank
     pool, which is paid but is not a player. */
  dividendPayouts: ReadonlyArray<DividendPayoutProjection>;
  /** Design note #259: per-tier rust countdown, so the bar's train chips
   *  read identically to the Round Detail table's. */
  rustOutlookForBar: Readonly<Record<TrainTier, TierRustOutlook>> | null;
  /** Design note #197: the price the token sits on NOW. The market move line
   *  states both ends of the step, and this is the departure. `null` for a
   *  corporation with no position on the chart. */
  dividendPrice: number | null;
  /** Where the stock token lands under each choice, or `null` when the
   *  current price is not on the chart. */
  payProjection: MarketProjection | null;
  withholdProjection: MarketProjection | null;
  selectedHardwareModel: string;
  onEndOperatingTurn: () => void;
  onUndoLastAction: () => void;
  /* Design note #592c: ONE UNDO BUTTON, NOT TWO. A second "Undo Round" control asked the host to decide,
     before pressing anything, how far they intended to go -- which is not how anybody uses undo. Instructed:
     "Can the Host's Undo button simply reverse through every player's actions?" So there is one button; it
     steps back one action at a time, and for the host that step may land in somebody else's turn.
     The reason it cannot fire is shown on the button rather than left to a dead click. */
  undoBlockedReason?: string | null;
  /** Design note #595: the seat-order trail, for the two seat-driven rounds.
   *  `null` in an Operating Round, whose turn belongs to a corporation and
   *  which has its own step trail. */
  seatOrderTrail?: React.ReactNode;
  /** Design note #266: which drafting tool built the path on screen. The
   *  old `routeSelectMode` boolean plus a separate Auto Route ACTION became
   *  one two-position mode -- see `RoutePlannerPanel`'s design note #1. */
  /** Design note #493: re-run the tracer. An action, not a mode. */
  onAutoRoute: () => void;
  onSelectRouteTrain: (trainIndex: number) => void;
  /** Design note #373: the shared route cursor, owned by the shell. */
  highlightedRouteIndex: number | null;
  onHighlightRoute: (trainIndex: number | null) => void;
  /** Design note #275: one priced draft per owned train, INCLUDING
   *  duplicate models -- three 3-trains are three entries. */
  trainDrafts: readonly TrainRouteDraft[];
  /** Which train the map's clicks are drafting for. */
  activeTrainIndex: number;
  /** Design note #266/#4: why the builder refused the last map click, or
   *  `null`. Distinct from the standing legality reasons the panel derives
   *  for itself -- only the click handler knows this one. */
  routeFeedback: string | null;
  onClearRoute: (trainIndex: number | null) => void;
  /** Buy Private Company Action Tray -- design note #14. Already filtered
   *  down to what `activePlayerAddress` actually still owns and could sell
   *  (`playerSellablePrivateCompanies`), not the full room-wide list. */
  currentGlobalEra: TileColor | null;
  /** Design note #390: which top-level tab the player is looking at, so the
   *  bar can tell when it is being rendered beside the wrong board.
   *  Optional -- a caller that omits it never redirects, rather than
   *  redirecting to a guess. */
  activeTab?: MainTab;
  /** Navigates to a tab. Required for the redirect to do anything, so the
   *  check is skipped without it: a redirect button with nothing to
   *  dispatch is a dead end, not a fix. */
  onSelectTab?: (tab: MainTab) => void;
  /** Active Player Turn Notifications -- design note #18/item 4. Applies
   *  the shared `app-turn-pulse-glow` keyframe (see `styles.appRoot`'s own
   *  JSX call site for where that `<style>` tag is injected) to this bar's
   *  own outer wrapper. */
  isMyTurn: boolean;
  /* Design note #500: `latestFeedItem` and `onOpenActivityLog` are GONE. They fed a one-line echo of
     `TopTicker`'s newest entry inside this panel, and the ticker is on the same screen. Removed rather than
     left unread -- an unused prop is an invitation to render it again.
     Derived phase (`utils/gamePhase.ts`) for the far-right badge -- design note #40 for why it moved here. */
  phase?: GamePhase | null;
}) {
  // Design note #7 (`gamePhase.ts`): the ONE severity decision, shared with
  // the train chips. Computed here rather than inline in the JSX because
  // both the badge's style and its wording branch on it.
  const phaseAlert = phaseAlertLevel(phase ?? null);
  /** Design note #297/#298: pinned to the top, so the bar sheds its
   *  orientation rows and keeps only what is needed while reading the map. */
  const [actionBarRef, condensed, mayPin, barClearance] = useCondensedWhenPinned();

  /* ==================================================================
   *  DESIGN NOTE 792: THE JUMP BUTTON COMES BACK, AND SO DOES ITS REASON
   * ==================================================================
   *
   * REPORTED: "During the Buy Trains action, there is no 'Buy Trains' button on the sticky to scroll them to
   * the subpanel. The only button on the sticky Action Bar is 'End Turn,' which signals the wrong thing to a
   * player who has to buy a train this subphase."
   *
   * THIS IS #491's BUTTON, WHICH #508 RETIRED, AND BOTH WERE RIGHT AT THE TIME. #491 added a jump because the
   * purchase panel lived below a sticky bar and scrolled away from it. #508 removed the cause instead by
   * moving the panel INSIDE the bar -- "sticky by inheritance, with nothing to jump to" -- and deleted the
   * button as redundant. Correct, until #720 taught the bar to unpin itself when it grew past half the
   * viewport, which the depot table reliably does; and #785 then moved the panel back out to stop that.
   * So the panel is a sibling below the bar again, and the jump has a job again.
   *
   * WHAT THE BAR WAS SAYING WITHOUT IT is the sharper half of the report. On the Hardware step the bar held
   * exactly one control, "End Turn" -- and #293 disables it while a corporation is trainless, so a player who
   * MUST buy saw a single greyed button and no route to the thing they had to do. A bar whose only offer is
   * an exit reads as "you are finished here" at the one moment that is least true.
   *
   * A SCROLL IS NOT AN ACTION, and the label says so: it names the destination rather than the purchase, so
   * it cannot be mistaken for the buy itself. #263's "two controls for one outcome" objection -- which #715
   * used to refuse a Buy Private button -- does not apply to a control that dispatches nothing.
   *
   * DESIGN NOTE 793: THE ARROW IS GONE, AND IT WAS WRONG BEFORE IT WAS UNNECESSARY. The first draft labelled
   * these "Buy Trains \u2193". Asked whether it should point UP instead, since the panel is often above a
   * scrolled-down player -- and the answer is that the button cannot know. The panel sits below the bar in
   * DOCUMENT order and anywhere at all relative to the VIEWPORT, which is the only direction a player
   * experiences. A glyph asserting one of them is a surface stating something it has not got the information
   * to state, which is the shape of most of the bugs this project has found.
   *
   * AND THE SECOND HALF OF THAT REPORT SETTLES IT: "just clicking the button to auto scroll to the panel
   * seems adequate". It is. The arrow was decorating a claim rather than making one, and the `title` already
   * says "scrolls to ... below" -- prose can hedge a direction; an arrowhead cannot. */
  const stepPanelRef = React.useRef<HTMLDivElement>(null);

  // Design note #813: the temporary instrument that decides whether these panels can move back into the bar.
  const stickyFitProbe = useStickyFitProbe(actionBarRef, stepPanelRef);

  /* ==================================================================
   *  DESIGN NOTE 797: A SCROLL BUTTON FOR A PANEL ALREADY ON SCREEN
   * ==================================================================
   *
   * REPORTED: "when a player is scrolled up, the Action Bar should still show 'Buy Trains' and 'End Turn,'
   * but 'Buy Trains' should be grayed out when there's no need to scroll them to the subpanel."
   *
   * A CONTROL THAT DOES NOTHING SHOULD LOOK LIKE ONE. `block: "nearest"` already makes the click harmless
   * when the panel is visible -- it scrolls by zero -- and a button that responds to a press by doing nothing
   * is indistinguishable from a broken one. The greying is the difference between "no need" and "no effect".
   *
   * MEASURED RATHER THAN GUESSED, because the alternative is comparing scroll offsets against element
   * heights, which is the arithmetic `IntersectionObserver` exists to replace and gets wrong at every
   * zoom level and on every rubber-band scroll.
   *
   * UNMEASURABLE MEANS ENABLED, which is #720's rule pointed the same way: before the first callback, in a
   * test environment, or in a browser without the API, the button stays live. Offering a scroll that turns
   * out to be unnecessary costs a player nothing; withholding one they needed strands them, and stranding
   * them at the Buy Trains step is exactly what was reported one note ago. */
  /* ==================================================================
     DESIGN NOTE 831: ONE JUMP MECHANISM, TWO DESTINATIONS
     ==================================================================

     ASKED, of the Lay Track step: "'Lay Track' button should autoscroll players into the map and gray out
     while they're on it?"

     AND THAT DISSOLVES THE OBJECTION RAISED ALONGSIDE IT -- "sometimes a grayed out button means an action
     can't be taken, but here it means 'Resolve this action elsewhere'." It does not have to mean that. This
     button greys for the reason #797 already established and the only reason `disabled` means anywhere else
     in this app: pressing it would do nothing, because the thing it scrolls to is already on screen. One
     channel, one meaning (#732).

     SO THE MECHANISM IS LIFTED RATHER THAN COPIED. #792/#797/#810 built observe-and-scroll for the step
     panel; the map wants the same three parts and a different target, and a second copy is how the two would
     come to disagree about the clearance -- which is exactly what #810 had to fix once already.

     THE CLEARANCE IS APPLIED TO THE TARGET, not at the call site. #810 put `scroll-margin-top` on the step
     panel's own element and argued for it there: "stated once, where the element is, rather than at each call
     site that has to remember the bar exists." A second target owned by a different component makes that
     argument stronger, not weaker -- so the hook writes it, and neither caller has to know. */
  function useJumpTarget(
    target: React.RefObject<HTMLElement | null>,
    clearance: number,
  ): [boolean, () => void] {
    const [inView, setInView] = React.useState(false);

    React.useEffect(() => {
      const node = target.current;
      if (!node) return undefined;
      // Design note #810/#831: the destination carries the bar's height, whoever owns the element.
      node.style.scrollMarginTop = `${clearance}px`;
      if (typeof IntersectionObserver === "undefined") return undefined;
      const observer = new IntersectionObserver(
        ([entry]) => {
          /* HEIGHT AS WELL AS INTERSECTION. The step wrapper renders on every step and holds a panel on two
             of them, so elsewhere it is a zero-height div sitting wherever the layout puts it -- which an
             observer will happily report as intersecting. `isIntersecting` alone would grey a button that has
             a real destination. */
          setInView(entry.isIntersecting && entry.boundingClientRect.height > 0);
        },
        /* A quarter is enough to count as "you can see it". Requiring all of it would keep the button live
           for a target taller than the viewport, which is precisely when scrolling to the TOP of it is still
           useful.
           Design note #810: and the strip behind the bar does not count as seen. */
        { threshold: 0.25, rootMargin: `-${clearance}px 0px 0px 0px` },
      );
      observer.observe(node);
      return () => observer.disconnect();
      // The margin is baked into the observer at construction, so a changed clearance needs a new one. It is
      // rounded and set only on change (see the hook above), so this re-subscribes on a condense or a resize.
    }, [target, clearance]);

    const scrollTo = React.useCallback(() => {
      /* Design note #810: `block: "start"` with the clearance on the element -- see that note for why both
         `start` and `nearest` were wrong before the height was known. */
      target.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, [target]);

    return [inView, scrollTo];
  }

  const [stepPanelInView, scrollToStepPanel] = useJumpTarget(stepPanelRef, barClearance);
  /* Design note #831: the map is the Lay Track step's panel. It is owned by the shell rather than by this
     bar, so it arrives as a ref -- `null` for any caller that has no map on screen, which greys the button
     the same way an absent panel does. */
  const [mapInView, scrollToMap] = useJumpTarget(mapRef ?? EMPTY_JUMP_REF, barClearance);

  /* Design note #481: the strip, as three facts instead of six chips.
     `null` when the cursor sits on a step this era does not show -- the
     same -1 case `OperatingSubPhaseStepper` guards, and the same answer:
     say nothing rather than render "0 of 5". */
  const orSubPhaseProgress = React.useMemo(() => {
    // Design note #613: `Buy Private` shows in Phases 3 and 4 only. The
    // era is the fallback while the phase is not yet knowable.
    const steps = visibleSubPhases(
      currentGlobalEra,
      privateCompanies,
      phase?.known ? phase.tier : null,
    );
    const index = steps.indexOf(orSubPhase);
    if (index < 0) return null;
    return {
      label: OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel,
      position: index + 1,
      total: steps.length,
      /* Design note #518: the whole sequence, for the expanded breadcrumb -- measured against the SAME
         `visibleSubPhases` result the position is, so the trail and the counter cannot disagree about how many
         steps this era has. */
      steps,
    };
  }, [currentGlobalEra, privateCompanies, orSubPhase, phase]);

  /* Design note #236: the acting corporation's own colours, resolved once. `bestContrastTextColor` is the
     same per-fill choice the map's station tokens make, so the bar and the tokens agree about what is
     legible on that brand colour rather than this asserting white and being wrong on C&O's orange.
     SECONDARY TEXT IS THE SAME INK AT REDUCED ALPHA, never a fixed grey -- a grey that reads as quieter on
     PRR's dark red is nearly invisible on C&O's orange.
     NO CORPORATION -> the neutral dark this bar always had. That state is reachable before the first
     `GetGameState` resolves, and a fallback grey would dress an empty bar as though a company were acting.
     Design note #631: the same secondary-ink rule, factored out because the seat card needs it too. */
  const seatInkMuted = React.useCallback(
    (background: string) =>
      bestContrastTextColor(background) === "#FFFFFF"
        ? "rgba(255, 255, 255, 0.74)"
        : "rgba(0, 0, 0, 0.66)",
    [],
  );

  const corporationBarInk = React.useMemo(() => {
    if (!activeCorporation) {
      return {
        background: "#171c28",
        border: "#2b3242",
        ink: "#eaf2ff",
        inkMuted: "rgba(234, 242, 255, 0.66)",
      };
    }
    const background = stationTickerColor(activeCorporation.companyId);
    const ink = bestContrastTextColor(background);
    const light = ink === "#FFFFFF";
    return {
      background,
      // A translucent black edge darkens any hue by the same amount, so one
      // rule gives every corporation a border rather than eight hand-picked
      // shades that would drift from the palette they are derived from.
      border: "rgba(0, 0, 0, 0.35)",
      ink,
      inkMuted: light ? "rgba(255, 255, 255, 0.74)" : "rgba(0, 0, 0, 0.66)",
    };
  }, [activeCorporation]);

  // Round-type-specific buttons -- design note #8 for which real `ExecuteMsg` each dispatches, and why
  // "Place Station Token" is deliberately non-dispatching. Design note #10/item 2: within an Operating
  // Round the set also swaps per `orSubPhase`, walking the player through the real 1830 legal order
  // (Track -> Tokens -> Dividends -> Hardware) rather than exposing every action at once.
  // Design note #390: `null` when the player is where the action is, or on a reference tab. `onSelectTab`
  // is part of the condition because a redirect button with nothing to dispatch is a dead end, not a fix.
  const misplacedTab =
    activeTab !== undefined && onSelectTab !== undefined
      ? misplacedSurfaceTab(activeTab, roundType)
      : null;
  const misplacedTabLabel = misplacedTab !== null ? labelForTab(misplacedTab, roundType) : "";
  const roundLabelForTab =
    roundType === "WaterfallAuction"
      ? "The private auction"
      : roundType === "StockRound"
        ? "The Stock Round"
        : roundType === "OperatingRound"
          ? "The Operating Round"
          : "This round";

  /* Design note #485a: ONE REVENUE FIGURE, FOUR SURFACES. `dividendRevenue` is `last_route_revenue`, which
     is a PREVIOUS turn's figure for a corporation that skipped Routes (#278) -- and three of the four
     surfaces quoting it were quoting the stale one, so a corporation that ran nothing displayed a payout
     table for a run that did not happen. Derived once, above every reader, through the same
     `dividendDeclaration` App uses for the dispatch (#486). */
  const declaration = dividendDeclaration({
    lastRouteRevenue: dividendRevenue,
    skippedRoutes: !dividendRevenueIsThisTurn,
  });
  const declaredRevenue = declaration.revenue;
  const declaredPerShare = declaration.perShare;

  /* Design note #509a: the two ends of the withhold, and the ink for the herald beside them. The dividend
     panel sits on the bar's own dark surface rather than the corporation's livery, so the logo's text
     FALLBACK takes the panel ink -- not `bestContrastTextColor`, which answers what is legible ON the
     brand colour. */
  const treasuryNow = activeCorporation?.treasury ?? 0;
  const treasuryAfterWithhold = treasuryNow + declaredRevenue;
  const corporationInk = "#e2e6ee";

  let contextualButtons: ActionBarButton[];
  if (roundType === "OperatingRound") {
    switch (orSubPhase) {
      case "Track":
        /* ==================================================================
           DESIGN NOTE 831: THE STEP WITH NO BUTTON WAS THE MOST CONSEQUENTIAL ONE
           ==================================================================

           REPORTED: "I now find it weird that it's the one panel that doesn't have a clear action button when
           it's one of the more consequential actions of the whole game. Maybe we should look at it in the
           reverse of how we're thinking of the Buy Trains button, i.e., 'Lay Track' button should autoscroll
           players into the map and gray out while they're on it?"

           THE REVERSAL IS THE FIX. Every other step's panel is in the bar, so its jump button is greyed
           almost always; Lay Track's panel is the MAP, which is the one destination a player really can be
           scrolled away from. Same control, same rule, and the step that needed it most was the one without.

           IT DISPATCHES NOTHING, which is what keeps #263 satisfied and answers the doubt raised with the
           request: a greyed control here means "pressing this would do nothing", exactly as it does on the
           other two, because the map is already in front of you. It never means "you may not lay track" --
           that refusal lives on the hex, where #716 put it. */
        contextualButtons = [
          {
            key: "go-to-map",
            label: "Lay Track",
            onClick: scrollToMap,
            disabled: mapInView,
            title: mapInView
              ? "The Rail Map is already on screen. Click a hex to lay or upgrade track."
              : "Scrolls to the Rail Map, where the track is laid.",
          },
        ];
        break;
      case "BuyPrivate":
        // Design note #144: Phase 3+ only, and FIRST in the turn. The
        // contract starts the cursor at `Track` before Phase 3, so this case
        // is unreachable in the Yellow era rather than showing a dead button.
        /* Design note #715: NO BUTTON. It opened a modal, and the panel that modal held now renders below --
           so the button's only remaining job would be scrolling to something already on screen.
           #691 removed the Buy Trains button for the same reason one step later, and #263's argument applies
           here too: two controls for one outcome implies a distinction a player then has to work out.
           DESIGN NOTE 792 REINSTATES IT, and the premise that failed is the parenthetical: "already on
           screen". That was true while #508 had the panel inside the sticky bar; #720 then unpinned the bar
           whenever the panel made it tall, and #785 moved the panel out to fix that. It is below the fold
           again, so the jump has a job again.
           #263 STILL HOLDS, because this is not a second control for one outcome: it scrolls and dispatches
           nothing, and its label names the destination rather than the purchase. */
        contextualButtons = privatePurchase
          ? [
              {
                key: "go-to-privates",
                label: "Buy Private Company",
                onClick: scrollToStepPanel,
                // Design note #797: same rule, same panel wrapper.
                disabled: stepPanelInView,
                title: stepPanelInView
                  ? "The Buy Private Company panel is already on screen."
                  : "Scrolls to the Buy Private Company panel below.",
              },
            ]
          : [];
        break;
      case "Tokens":
        contextualButtons = [
          {
            key: "station",
            // Design note #181: the PRICE is on the button. A token costs
            // real treasury and the amount varies by corporation, so
            // "Place Station Token" asked the player to commit to a spend
            // whose size the UI knew and did not say.
            label: `Place Station Token for $${stationTokenCost}`,
            onClick: onPlaceStationTokenHint,
            title: `Costs $${stationTokenCost} from this corporation's treasury. Click a city hex on the Rail Map to place it.`,
          },
        ];
        break;
      case "Routes":
        /* Design note #142: its own phase. Running trains PRODUCES the revenue; the dividend decision below is
           what is done with it.
           Design note #266: NO CONTEXTUAL BUTTON. "Run Selected Route" sat here, ABOVE the panel showing the
           route it would submit; it is now the bottom row of `RoutePlannerPanel`, under the path it runs and
           carrying the amount it pays. A copy here would be a second control for one action, and the vaguer of
           the two, since only the panel's copy knows the figure. */
        contextualButtons = [];
        break;
      case "Dividends":
        /* Design note #414: THERE IS NO SUCH THING AS PAYING $0. 1830 has no such declaration -- a corporation
           that earned nothing withholds, and that is what steps the share price left. Offering Pay beside
           Withhold at $0 presents a binary where the rules have one outcome, and the two do not even differ in
           effect; the only thing a player could get wrong is the market move, and Pay gets it wrong SILENTLY.
           `App`'s forced-withhold effect normally declares it first; this is the same rule on the control, so a
           player arriving during the poll interval cannot click a button that should not exist.
           THE TEST IS THE REVENUE, NOT THE TRAIN -- it covers the stranded-train, trainless and worthless-route
           cases without naming any of them, and cannot disagree with the label beside it. */
        contextualButtons = [
          ...(declaration.mayPay
            ? [
                {
                  key: "pay-dividends",
                  // Design note #188: the per-share figure is the number the
                  // decision turns on, and it was the one thing the button did
                  // not say. 1830 splits revenue ten ways -- one share is 10% --
                  // so a $180 route pays $18 a share.
                  label: `Pay Dividends ($${declaredPerShare} per share)`,
                  onClick: onPayDividends,
                  title: `Splits $${declaredRevenue} between every shareholder at $${declaredPerShare} per 10% share.`,
                },
              ]
            : []),
          {
            key: "withhold-revenue",
            label:
              declaredRevenue > 0
                ? "Withhold to Corporate Treasury"
                : "Withhold $0 — Share Price Steps Left",
            onClick: onWithholdRevenue,
            title:
              declaredRevenue > 0
                ? `Keeps all $${declaredRevenue} in the corporation's treasury. Shareholders receive nothing.`
                : "This corporation earned nothing this turn. Project 18XX has no $0 dividend — the revenue is withheld and the share price moves one step left.",
          },
        ];
        break;
      case "Hardware":
        contextualButtons = [
          // Both ways of acquiring a train live in `TrainPurchasePanel` (#203), the only place that knows what the
          // depot will sell and which corporations hold what. A generic "Buy Train" here would be a second control
          // for one action, and the vaguer of the two.
          // Design note #293: A CORPORATION MUST OWN A TRAIN. 1830 does not let one end its turn trainless: it MUST
          // buy, and if the treasury cannot cover the cheapest in the depot the president pays the difference
          // personally. There is no branch of that rule where the turn simply ends.
          // THE POVERTY CASE IS THE ONE THAT MATTERS -- being unable to pay is precisely when a player wants the
          // exit and precisely when 1830 refuses it, so the button stays disabled on an empty treasury too and the
          // tooltip names the president's purchase rather than implying the step is stuck.
          // The gate is "owns a train", not "has bought one this turn" -- one acquired by trade satisfies the rule.
          /* Design note #792: the step's own destination, first -- an obligation should be offered before an
             exit. Only when the panel is actually on screen to be scrolled to. */
          ...(trainPurchase
            ? [
                {
                  key: "go-to-trains",
                  /* Design note #793: one label, no glyph. The obligation lives in the `title` and in End
                     Turn's greying beside it; the button's job is to be findable and to say where it goes. */
                  label: "Buy Trains",
                  onClick: scrollToStepPanel,
                  // Design note #797: nothing to scroll to means nothing to press.
                  disabled: stepPanelInView,
                  title: stepPanelInView
                    ? "The Buy Trains panel is already on screen."
                    : mustBuyTrain
                      ? "This corporation must own a train. Scrolls to the Buy Trains panel below."
                      : "Scrolls to the Buy Trains panel below.",
                },
              ]
            : []),
          {
            key: "end-turn",
            label: "End Turn",
            onClick: onEndOperatingTurn,
            disabled: mustBuyTrain,
            title: !mustBuyTrain
              ? "Finish this corporation's turn and pass to the next in the queue."
              : "A corporation must own a train. Buy one from the Bank Depot or another corporation — if the treasury cannot cover it, the president buys it out of pocket.",
          },
        ];
        break;
    }
  } else {
    // Stock & Auction: Buy/Sell live entirely in `StockRoundPanel`'s corporation cards, so there is never a
    // duplicate control surface.
    // Design note #29: `onBuyShare`/`onSellShares` are no longer props at all. They were kept unused "to keep
    // this a minimal-footprint change", then their signature changed to take a company id and four call sites
    // failed to typecheck for a prop nobody reads. Dead props are a type error waiting for the real
    // implementation to move.
    contextualButtons = [];
  }

  /* Design note #413: THE BAR NOW ASKS WHOSE TURN IT IS. Reported as the president being locked out of Lay
     Tile while every non-acting player could click Skip -- both halves at once, which is what gives it away.
     THE LOCKOUT was `actingSeatIndex` returning `null` on an empty `active_operating_order`
     (`sandboxSession.ts #411`); fixed at the source, nothing here caused it. THE SKIP BUTTON is this file's:
     every control was gated on `sessionReady` alone -- "is there a signing session", not "may this player
     act" -- so spectators and waiting players carried live buttons that dispatched real messages.
     `isMyTurn` was already computed, already correct and already passed in, and used for exactly one thing:
     a decorative pulse. The predicate the bar needed was in its own props being used as a CSS class.
     HIDDEN, NOT DISABLED, and a departure from how this file treats every other unavailable control. A
     disabled button with a reason fits when the player COULD act (#293's End Turn); it is the wrong shape
     for "this is not your turn", where there is no action to take and eight greyed buttons on four screens
     describe somebody else's decision. The acting corporation is already named across the top of the bar.
     SCOPED TO OPERATING ROUNDS -- the round whose turn belongs to a corporation rather than a seat, and the
     only one this bar carries action buttons in. */
  /* Design note #691: AND THE SAME RULE FOR THE PANELS, which is where #740 stopped.
     REPORTED: "on the non-active players' turn during the Operating Round, the Action Bar displays all the
     actions and views of the current player -- when the current player enters Buy Train, the inactive players'
     screens are filled with the Buy Train action panels."
     #740's argument is quoted above and is exactly right; it was simply applied to `contextualButtons` and to
     nothing else. Its own words -- "eight greyed buttons on four screens describe somebody else's decision" --
     understate what was left rendering: a depot table, a payout ledger, a route planner and a train-purchase
     panel are far more screen than eight buttons, and every one of them was describing a turn the reader cannot
     take.
     WHAT AN INACTIVE PLAYER KEEPS is what the report asks for and what #740's reasoning already implies: WHO is
     acting (the corporation card across the top), WHERE they are in the turn (the sub-phase trail, #672), and
     Undo -- which is deliberately not gated on turn at all (#592c/#592d), because it is an instruction about the
     log rather than a move.
     WHAT IT DOES NOT TOUCH is the train-trade ledger. That lives in `App.tsx` (#508 moved only the PURCHASE
     panel in here) and it is the one thing a non-acting player legitimately acts on during somebody else's
     Hardware step -- a seller answering an offer. Hiding it would take away a real decision rather than a
     description of one. */
  const mayActThisTurn = roundType !== "OperatingRound" || isMyTurn;
  if (!mayActThisTurn) contextualButtons = [];


  /* Design note #33: THE ROUTE TOGGLE IS A RUN-TRAINS TOOL, NOT A GLOBAL ONE. `Routes` is this UI's name
     for the contract's run-trains sub-phase, and sketching a route is only meaningful while a corporation
     is about to run one.
     #11 argued the toggle was harmless to leave on. It was not: (1) IT SILENTLY DISARMS THE MAP -- route
     mode switches `queryClient`/`contractAddress`/`gameId`/`onHexClick` to `undefined`, so a player who
     left it on and clicked a hex next turn got a route point and no tile picker with nothing explaining
     why; (2) it advertised a control for a phase the player was not in.
     Hiding the button alone would leave hazard (1) intact -- the mode would just become unreachable while
     still ON -- so the owning component force-clears `routeSelectMode` when this condition goes false. */
  /* Design note #691: `mayActThisTurn` folded in here rather than repeated at three call sites -- this one flag
     gates the Auto Route button and the Run Routes button, which after #802 are the whole of the
     Run Routes step's interface. Three separate conditions is three chances to miss one. */
  const showRouteToggle =
    roundType === "OperatingRound" && orSubPhase === "Routes" && mayActThisTurn;

  /* ==================================================================
   *  DESIGN NOTE 787: A WATCHER SEES THE ROUTES AND NOT THE FIGURES
   * ==================================================================
   *
   * REPORTED: "During other players' run routes action, I can see the highlighted routes on the rail map, but
   * on the sticky Action bar I don't see the trains listed with their individual revenues."
   *
   * THE DATA WAS ALREADY THERE AND THE GATE HID IT. `rivalTrainDrafts` prices every rival route through
   * `sandboxRouteBreakdown` and names the train from the board -- the shell hands the bar exactly that when
   * it is not your turn (`trainDrafts={isMyTurn ? trainDrafts : rivalTrainDrafts}`). The panel that would
   * print it was gated on `mayActThisTurn`, so the one surface carrying the numbers was withheld from
   * everyone who was not producing them.
   *
   * A HALF-VISIBLE EVENT IS WORSE THAN A HIDDEN ONE. The map already draws the rival's routes, so a watcher
   * could see WHERE the train went and not what it earned -- which reads as a missing readout rather than as
   * a deliberate scope.
   *
   * THE CONTROLS ARE STILL THE ACTOR'S. Two flags rather than one widened flag: this decides whether the
   * READOUT renders, `showRouteToggle` still decides whether the mode toggle does, and `controlsEnabled`
   * carries `mayActThisTurn` so a watcher's buttons are disabled by the panel's own rule rather than by a
   * second one written here. */
  const showRouteReadout = roundType === "OperatingRound" && orSubPhase === "Routes";

  /* ==================================================================
   *  DESIGN NOTE 803: A GATE THAT WAS PROVIDED BY NESTING
   * ==================================================================
   *
   * REPORTED as a regression: "now in the Stock Round following the transition to Phase 3, the 'Purchase a
   * Private Company' subpanel shows up under the player Action bar. If it matters, it shows that the last
   * corporation that operated is now proposing a purchase."
   *
   * MINE, FROM #785. Those panels used to sit INSIDE the bar's Operating Round branch, so `roundType ===
   * "OperatingRound"` was true by construction and their own conditions never had to say it. Lifting them out
   * to stop the bar unpinning itself moved them out of that branch too -- and their conditions, which read
   * only `orSubPhase === "BuyPrivate"`, were suddenly asking an unqualified question.
   *
   * AND `orSubPhase` LIES OUTSIDE AN OPERATING ROUND, which is what made the gap visible rather than
   * harmless. `settleOperatingCursor` clears `operating_sub_phase` when the round ends, so the shell falls
   * back to `liveOrSubPhase` -- local state still holding whatever step the last corporation was on. Hence
   * the second sentence of the report: the panel names the corporation that operated last, because that is
   * genuinely what the stale cursor still points at.
   *
   * ONE DERIVED VALUE RATHER THAN TWO MORE CONJUNCTIONS. `orStep` is `null` outside an Operating Round, so
   * every step test is answering the qualified question whether or not its author remembered to ask it --
   * which is the property the nesting used to provide for free and the reason this is not just `&& roundType
   * === "OperatingRound"` pasted twice. */
  const orStep = roundType === "OperatingRound" ? orSubPhase : null;

  /* Design note #802: which chip is open. LOCAL to the bar and not lifted: it is one viewer's reading
     position, not a fact about the game, and the shell already owns the two cursors that ARE shared (the
     hovered train and the active one). Cleared when the step ends so a chip cannot stay open into a round
     that has no routes in it. */
  const [openTrainIndex, setOpenTrainIndex] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!showRouteReadout) setOpenTrainIndex(null);
  }, [showRouteReadout]);
  const openDraft =
    openTrainIndex === null
      ? null
      : (trainDrafts.find((draft) => draft.trainIndex === openTrainIndex) ?? null);

  /* Design note #278: the Dividends step's Pay-or-Withhold binary, derived here because both halves are
     already props and a second boolean saying what they jointly mean can disagree with them.
     Design note #436: $0 IS A DECISION TOO, AND SKIP IS NOT IT. #278 argued a $0 declaration is "a message
     with no effect" -- the premise is wrong, and #414 had established why one step over: it is the withhold
     that steps the share price one cell LEFT, the most consequential thing that happens to a corporation
     that could not run. Skip dispatches `AdvanceOperatingSubPhase` and settles nothing, and it was the more
     prominent of the pair by position -- so the easiest action on screen silently omitted a mandatory move.
     Design note #485: SKIP IS NEVER A DIVIDEND DECLARATION. `dividendRevenueIsThisTurn` was the third
     clause and it is false in precisely the reported situation -- a corporation that skipped Routes -- so
     the one corporation guaranteed to have $0 was the one Skip was kept alive for. Gone rather than
     inverted: 1830 requires a declaration every turn.
     Design note #707 CORRECTED THE LAST CLAUSE, which read "Skip remains correct on Track, Tokens and
     Routes". It is correct on Track and Tokens, where declining is an ordinary strong play (#674) -- and it
     was not correct on ROUTES, where a corporation that can run must. Reported: "I was able to skip Run
     Routes with both a train and a valid route." #278 guards the money once it exists; the step before it
     decides whether it exists at all, so the omission voided this note's own protection upstream of it. */
  const dividendChoiceForced =
    roundType === "OperatingRound" && orSubPhase === "Dividends";

  /* Design note #707: AND THE STEP BEFORE IT. #278's note above ends "Skip remains correct on Track, Tokens
     and Routes" -- and Routes is where its own argument applies hardest.
     REPORTED: "there is a 'Skip Run Routes' button even when a corporation has trains and a valid route ...
     the game is very strict that players MUST run routes if they can."
     #278 protects the money once it exists; this protects its existing. A corporation that declines a run it
     could have made voids the declaration AND the market move #436 calls "the most consequential thing that
     happens to a corporation that could not run" -- upstream of every guard built to preserve them.
     DERIVED HERE FROM `maxRouteRevenue` rather than passed as a ready-made boolean, for the reason #278's own
     note gives one paragraph up: the facts are already props, and a second boolean saying what they jointly
     mean can disagree with them. */
  const routeObligation =
    roundType === "OperatingRound"
      ? routeRunObligation({
          orSubPhase,
          maxRouteRevenue,
          ticker: activeCorporation?.ticker,
        })
      : null;

  /* Design note #31: ONE BAR, EVERYWHERE. Two bars existed and on the phase tab during a Stock Round BOTH
     rendered, with two Undo buttons. `GlobalActionBar` is deleted; this component absorbed Pass, kept Undo
     and was restyled slim.
     PASS IS PHASE-ROUTED: `WaterfallPass` and `PassTurn` are different contract messages, not one action
     with two names. The caller decides which; this renders the button and shows `passDisabledReason`.
     THE THREE TRAYS BELOW ARE NOT PART OF THE BAR -- they are panels, not buttons, and one contains a price
     slider. They render under the slim strip as their own blocks.
     Design note #390: ONE BUTTON, AND NOTHING ELSE. On any other tab the entire bar is REPLACED by a single
     control that takes the player back -- alongside would leave live controls for a round being played on a
     screen the player cannot see. #404 extends this to the reference tabs: the exemption cost turns spent
     by accident, and the replacement is what makes the reversal safe, since that one control cannot end a
     turn. The copy distinguishes standing on another round's PLAYING surface from deliberately reading. */
  if (misplacedTab !== null) {
    return (
      <div
        ref={actionBarRef}
        style={{
          ...styles.actionBar,
          ...(condensed ? styles.actionBarCondensed : {}),
          // Design note #720: applied here too. This form is one button tall and will never trip the rule --
          // what it must not do is become the copy that disagrees when somebody grows it.
          ...(mayPin ? {} : styles.actionBarUnpinned),
          ...styles.actionBarRedirect,
        }}
      >
        <button
          type="button"
          style={{ ...styles.actionBarButton, ...styles.actionBarRedirectButton }}
          onClick={() => onSelectTab?.(misplacedTab)}
          title={
            activeTab !== undefined && isPlayingSurface(activeTab)
              ? `${roundLabelForTab} is being played on the ${misplacedTabLabel} tab, not this one.`
              : `${roundLabelForTab} is being played on the ${misplacedTabLabel} tab. Turn actions are hidden here so a reference screen cannot spend your turn.`
          }
        >
          Return to {misplacedTabLabel}
        </button>
      </div>
    );
  }

  return (
    <>
    <div
      ref={actionBarRef}
      style={{
        ...styles.actionBar,
        /* Design note #597: the CONTINUOUS pulse stays and is now the quieter of two cues -- it says "it is still
           your turn", a sustained state correctly rendered by a sustained animation. The band's sweep says "your
           turn just began", which a continuous animation can never carry. */
        ...(isMyTurn ? styles.actionBarTurnPulse : {}),
        ...(condensed ? styles.actionBarCondensed : {}),
        /* Design note #720: THE BAR UNSTICKS WHEN IT OUTGROWS THE VIEWPORT. Reported of the embedded Buy
           Private step: "my scrolling is taking me down the page but not the subpanel". A sticky element stops
           at its offset, so anything hanging below the fold when it pins can never be scrolled to -- the panel
           was not unscrollable, it was anchored. `static` gives it back to the page, which is the only
           behaviour that reaches its bottom. The rule and the reasoning are in `stickyCollapse.ts` #720. */
        ...(mayPin ? {} : styles.actionBarUnpinned),
        /* Design note #597a: `sticky` IS ALREADY A POSITIONED ELEMENT. Reported as the bar no longer travelling
           with the scroll -- that was this line. A previous pass added `position: relative` so the band could pin
           itself, claiming it did so "without the bar's own sticky positioning being disturbed", which is exactly
           what it disturbed. `position: sticky` already establishes a containing block for absolutely positioned
           children, so the band pins with no help: the override bought nothing and cost the bar's whole purpose. */
      }}
    >
      {/* Design note #597: THE HANDOFF BAND. `key` IS THE MECHANISM, not a React formality -- changing it on
         every new acting seat makes React replace the element, which RESTARTS the CSS animation, so the sweep
         fires once per handoff. Without it the animation would run once on mount for the whole game.
         `aria-hidden`: it decorates a fact the bar already states in words. */}
      {actingSeatColor && (
        <>
          <style>{TURN_HANDOFF_SWEEP_CSS}</style>
          <span
            /* Keyed on the SEAT, not the colour. Colour is unique per seat today and would work, but it is a proxy
               for identity -- and a proxy that silently stops being one (a seventh player, a duplicate pick) would
               leave the sweep never firing with no visible cause. The name is what actually changed. */
            key={`${activePlayerName ?? ""}:${actingSeatColor}:${isMyTurn ? "mine" : "theirs"}`}
            className={`app-turn-band${isMyTurn ? " app-turn-band-mine" : ""}`}
            style={{ backgroundColor: actingSeatColor }}
            aria-hidden="true"
          />
        </>
      )}
      {/* The "Phase N of 6" suffix is GONE, and its removal is the point. The stepper numbers from the steps
         this era actually has -- five in the Yellow era, six from Phase 3 -- while this label numbered from the
         fixed six-entry table, so the bar read "Phase 2 of 6: Track" directly above a strip whose first chip
         said "1 Lay Track": two numbers for one step, six inches apart. Reconciling them would mean two places
         computing one position, so the honest fix is for one of them to stop making the claim. */}
      {/* Design note #339: the auction is a ROUND, and the bar said it was not. `roundType` has four values and
         this branch covered two, so the Waterfall Auction -- the phase every game opens in -- fell through to
         "No live round" while the auction dashboard was on screen beneath it. `null` keeps the honest wording:
         before the first `GetGameState` resolves there genuinely is no round yet. */}
      {/* Design note #517: the round's own number. "Operating Round" alone named the KIND of round in a game
         that runs several back to back, so a player reading a log line about "OR 3.2" had nothing to match it
         against. `cycle.index` is the board's own notation and the same pair `ContextualSubPanel` prints. */}
      <span style={styles.actionBarRoundLabel}>
        {roundType === "OperatingRound"
          ? orSequence
            ? `Operating Round ${orSequence.cycle}.${orSequence.index}`
            : "Operating Round"
          : roundType === "StockRound"
            ? "Stock Round"
            : roundType === "WaterfallAuction"
              ? "Auction Round"
              : "No live round"}
      </span>
      {/* Design note #481: the sub-phase, inline. Operating Round only -- there is no sub-phase sequence in a
         Stock Round or the auction, and a step counter beside those titles would invent structure.
         IT SURVIVES THE COLLAPSE, unlike the strip it replaces. #298 dropped the stepper when pinned as
         orientation rather than input; neither objection survives the change of form -- at three words it costs
         the board nothing, and it is now the ONLY thing naming the current step in the header. */}
      {/* Design note #518: THE TRAIL, WHEN THERE IS ROOM FOR IT. This restored what #481 removed, and split the
         two forms: the expanded panel got the whole trail, the pinned form kept #481's three-word phrase.

         Design note #672: THE SPLIT IS GONE. THE TRAIL RENDERS IN BOTH FORMS.

         REPORTED, more than once: "when the Action Bar becomes sticky it drops the Train Limit and condenses the
         sub-phase into '[Current Action] x/6' — there is plenty of room for both."

         #590 had already reached that conclusion and said so in capitals -- NOTHING IS DROPPED WHEN PINNED -- and
         then only half-applied it. It restored the president and the privates row and left the two facts here
         behind, so a note asserting a rule sat six lines above two violations of it. That is worse than either
         behaviour on its own: the next reader trusts the note.

         THE PREMISE WAS THE PROBLEM, and it is worth naming precisely because it sounded so reasonable. #298
         reasoned that a sticky bar costs the map its height for the whole scroll, so a pinned bar must earn every
         row. True. But the trail does not COST a row -- it sits on the same line as the round label, in 11px
         boxes about a pixel taller than the 14px phrase it replaced. The saving was never real; it was assumed
         from the fact that the trail looks bigger.

         AND THE COUNTER GOES WITH IT, for #518's own reason: "4/6" beside six visible boxes is two renderings of
         one position. It existed because the phrase was the only thing carrying the position, and the phrase is
         gone.

         IF A NARROW WINDOW EVER MAKES THIS TIGHT the trail wraps -- `subPhaseTrail` is `flexWrap` already -- which
         is #590's stated answer: wrapping or a smaller type scale, not deciding for the player which facts they
         may keep. */}
      {roundType === "OperatingRound" && orSubPhaseProgress && (
        <span
          style={styles.subPhaseTrail}
          role="list"
          aria-label={`Operating Round steps — currently ${orSubPhaseProgress.label}`}
        >
          {orSubPhaseProgress.steps.map((phase, index) => {
            const isCurrent = phase === orSubPhase;
            const isDone = index < orSubPhaseProgress.position - 1;
            return (
              <span
                key={phase}
                role="listitem"
                aria-current={isCurrent ? "step" : undefined}
                style={{
                  ...styles.subPhaseStep,
                  ...(isDone ? styles.subPhaseStepDone : {}),
                  ...(isCurrent ? styles.subPhaseStepCurrent : {}),
                }}
                title={
                  isCurrent
                    ? `Step ${orSubPhaseProgress.position} of ${orSubPhaseProgress.total} — this corporation is here now.`
                    : isDone
                      ? `${OPERATING_SUB_PHASE_LABELS[phase].stepLabel} — already past.`
                      : `${OPERATING_SUB_PHASE_LABELS[phase].stepLabel} — still to come.`
                }
              >
                {OPERATING_SUB_PHASE_LABELS[phase].stepLabel}
              </span>
            );
          })}
        </span>
      )}
      {/* Design note #630: BOTH ROUNDS PUT THEIR TRACK IN THE SAME PLACE. It was in the BUTTON row because that
         is where the roster pills it replaced sat (#342) -- and a pill carrying spendable cash did belong next
         to the controls that spend it. `SeatOrderTrail` is not that: it answers "where are we in the rotation",
         the same question the sub-phase trail answers for a corporation's turn.
         So it moves under the round label. One place to look for "how far through are we", holding whichever
         track this round has; the two are mutually exclusive by round type, so this costs no height.
         AND THE MONEY IS NO LONGER WHY IT IS THERE -- #631's seat card carries the acting player's figures
         beside the controls, which is the part of #342 that was about proximity to the buttons. */}
      {roundType !== "OperatingRound" && seatOrderTrail}
      {/* Operating Round turn stepper, directly under the round label it elaborates: the label says WHICH step,
         the strip says where that step sits in the turn. Operating Round only -- a strip elsewhere would be
         inventing structure.
         Design note #212: READ-ONLY in every mode now, sandbox included. Its only control is Skip, which
         dispatches the real `AdvanceOperatingSubPhase` -- see that component's #1 for why a clickable sandbox
         strip made the one place that tests turn order unable to test it. */}
      {/* Design note #159: the targeting badge. A crosshair on the canvas
          only reads while the pointer is OVER the canvas -- a player who
          armed the mode and then looked at a panel has no way to tell it is
          still on. This says so where the controls are. */}
      {tokenTargetMode && (
        <div style={styles.tokenTargetBanner} role="status">
          <span style={styles.tokenTargetDot} aria-hidden="true" />
          Placing station token — click a city hex on the Rail Map.
          <button
            type="button"
            style={styles.tokenTargetCancel}
            onClick={() => setTokenTargetMode(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {/* Design note #164: THE OPERATING ROUND PANEL IS TWO ROWS. It was one wrapping strip, and because the
         number of contextual buttons CHANGES with the sub-phase, the badges moved every time the turn advanced
         -- a warning that relocates as the game progresses is one players stop tracking.
         Now a stepper row, then a THREE-COLUMN GRID (`1fr auto 1fr`): the centre column is centred on the panel
         rather than on the leftovers, because the two rails are equal by construction however wide they get.
         THE FOUR "SKIP" BUTTONS ARE GONE -- `Skip Track Lay`, `Skip Private Purchase`, `Skip Tokens` and `Skip
         Routes` all called the handler the stepper's own button calls. Advancing is a property of the TURN, so
         it lives with the stepper; the action row holds only things that change game state. */}
      {roundType === "OperatingRound" ? (
        <div style={styles.orPanel}>
          {/* Design note #228: WHOSE TURN IS IT, AND WHAT DO THEY HAVE. A player presiding over three corporations
             had no single place naming the acting one -- the information existed elsewhere on the page, and the bar
             where every decision is made named no company at all.
             FOUR FACTS, chosen because each gates a decision on this very bar: TREASURY caps every action in the
             turn; STATIONS is the Tokens step's whole decision and was previously only on the button; TRAINS is what
             can run in Routes and what the limit permits buying in Hardware.
             A strip ABOVE the stepper: it describes the whole turn, and the stepper describes where in it you are. */}
          {/* Design note #236: THE BAR WEARS THE CORPORATION'S COLOUR. It was a fixed navy slab with a small brand
             dot, so telling PRR's turn from NYC's meant reading the ticker. It now takes `stationTickerColor`, the
             exact palette the map's station tokens are drawn from, so the strip and the tokens are visibly the same
             company. THE DOT WENT WITH IT -- a brand dot on a brand bar is invisible.
             INK IS DERIVED, NOT ASSERTED: `bestContrastTextColor` gives B&M's slate white text and C&O's orange
             black without either being hardcoded, and secondary text takes the same ink at reduced alpha rather
             than a fixed grey, which would go illegible on half the palette. */}
          <div
            style={{
              ...styles.orContextCard,
              backgroundColor: corporationBarInk.background,
              borderColor: corporationBarInk.border,
            }}
          >
            {/* Design note #575: the bar identifies a corporation the SAME WAY the card does. Herald and full name sat
               on one baseline row, so the ACRONYM appeared only as `CorporateLogo`'s text fallback -- which is to say
               only when the artwork failed to load. `StockRoundPanel #465` settled this: a herald is unmistakable once
               you know it and unreadable until you do, and the full name is what you read second.
               Not a similar arrangement to `rosterIdentityRow` -- the same one, because the bar and the card name the
               same object and a player should not learn two layouts for it. */}
            <span style={styles.orContextIdentity}>
              <span style={styles.orContextIdentityRow}>
                {/* Design note #410: the same herald the Stock Card stripe shows, so a corporation is not a logo on one
                   screen and an acronym on the other. `null` has no logo to draw -- there is no corporation, which is a
                   sentence rather than a missing image. */}
                {activeCorporation ? (
                  <>
                    <CorporateLogo
                      ticker={activeCorporation.ticker}
                      size={CORPORATION_HERALD_PX}
                      color={corporationBarInk.ink}
                      title={activeCorporation.fullName ?? activeCorporation.ticker}
                      fallbackStyle={styles.orContextTicker}
                    />
                    {/* Design note #465: BESIDE, not instead. The herald keeps its recognisability and the acronym rides next
                       to it as the readable handle. The logo's own text fallback would double this when a file is missing --
                       only in the failure case, and a doubled ticker is a better failure than a nameless bar. */}
                    <span
                      style={{ ...styles.orContextAcronym, color: corporationBarInk.ink }}
                    >
                      {activeCorporation.ticker}
                    </span>
                  </>
                ) : (
                  <span style={{ ...styles.orContextTicker, color: corporationBarInk.ink }}>
                    No corporation
                  </span>
                )}
              </span>
              {/* Design note #589: TWO LINES, NOT THREE. A side effect of #575 turning a baseline-aligned ROW into a
                 column: the president had shared a line and a column gave it one of its own.
                 Design note #671: and the president has LEFT this line, which leaves the full name alone on it. #589
                 argued the two were one thought -- "the Pennsylvania Railroad, Ada presiding" -- and that reading is
                 fine in prose and wrong on this bar, because the full name is the LONGEST string here and the
                 president's name sat downstream of it. Every company shifted the crown to a different x, so the one
                 fact a reader scans for ("whose company is this?") had no fixed place to look. It sits at the end of
                 the facts rail now, where the row's own gaps give it a stable position. */}
              {activeCorporation?.fullName && (
                <span style={styles.orContextSubRow}>
                  <span style={{ ...styles.orContextName, color: corporationBarInk.inkMuted }}>
                    {activeCorporation.fullName}
                  </span>
                </span>
              )}
            </span>

            {activeCorporation && (
              <span style={styles.orContextFacts}>
                {/* Design note #805: THE FIRST FACT IS A COLUMN, AND THE PRESIDENT IS ITS SECOND ROW.
                   REQUESTED: "the president information is currently the last item on a line in small font. I
                   wonder if it would make sense to place it under the Treasury information on the same line as
                   the corporation's full name, if possible? This would not add vertical space to the
                   corporation card, but would keep the president identifier right by the name of the
                   corporation."
                   THE HEIGHT REASONING IS THE REPORT'S OWN AND IT IS RIGHT. The identity block is two lines
                   tall (herald over full name) and this rail was one, so the card's height has always been set
                   by the left column and there is a spare line of it on the right. A second row here spends
                   slack that already existed.
                   IT ALSO ANSWERS #671 ON #671's TERMS. That note moved the president off the name line
                   because "the full name is the LONGEST string here and the president's name sat downstream of
                   it. Every company shifted the crown to a different x" -- and then parked it at the END of a
                   WRAPPING rail, which is the least stable position on the card: the crown moved with the
                   number of privates, the length of the fleet and the window width. Anchored under the
                   treasury it has a landmark; whatever x the rail starts at, the crown is under the money.
                   WHAT IS GIVEN UP, stated rather than glossed: an absolute fixed x is still not available,
                   because the rail begins where the identity column ends and that column is as wide as the
                   full name. #671 wanted one and could not have one either. */}
                <span style={styles.orContextTreasuryStack}>
                  {/* Design note #673: THE PROVISIONAL TREASURY. While a tile lay is being previewed, this
                     reads "$1000 → $920" -- where the corporation stands and where the pending lay leaves it.
                     THE ARROW, NOT A LONE CHANGED NUMBER. A single amber "$920" is the same failure the
                     dividend report named (#670): a figure only reads as a change to somebody who had
                     memorised the one before it. Both ends, and the reader does no arithmetic.
                     IT IS NOT A COMMITMENT. The lay has not happened -- the player still has a tick and a
                     cross above the hex -- so the pending figure is styled as pending and the standing one is
                     left legible beside it rather than replaced. */}
                  <span
                    /* Design note #805: as tall as the herald opposite it, which is what puts the row BELOW
                       this one on the full name's line. Without it the treasury's own line height decides,
                       and the two columns' second rows drift apart by a few pixels per type-scale change. */
                    style={{ ...styles.orContextFact, minHeight: `${CORPORATION_HERALD_PX}px` }}
                    title={
                      pendingTreasury
                        ? `Treasury $${activeCorporation.treasury} now. The previewed tile lay costs $${pendingTreasury.fee}, leaving $${pendingTreasury.after}. Nothing is spent until you confirm.`
                        : "Everything this corporation can spend this turn."
                    }
                  >
                    <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                      Treasury
                    </span>
                    <span
                      style={{
                        ...styles.orContextFactValue,
                        // Dimmed to the muted ink while pending: the standing figure is
                        // about to stop being the answer, and the arrow's right-hand side
                        // is what the player is deciding about.
                        color: pendingTreasury ? corporationBarInk.inkMuted : corporationBarInk.ink,
                      }}
                    >
                      ${activeCorporation.treasury}
                    </span>
                    {pendingTreasury && (
                      <span
                        style={{ ...styles.orContextTreasuryPending, color: corporationBarInk.ink }}
                        /* A live region: the figure changes as the player moves between hexes without
                           anything being focused or clicked, which is exactly the update assistive tech
                           has no other way to learn about. */
                        aria-live="polite"
                        aria-label={`After the previewed tile lay, $${pendingTreasury.after}`}
                      >
                        {"→"} ${pendingTreasury.after}
                      </span>
                    )}
                  </span>

                  {/* Design note #671: NO CAPTION, unlike its four neighbours. The crown IS the caption -- it
                     is the mark every other surface in this app uses for exactly this fact (`PlayerCards`
                     #567 settled the same question the same way), and "PRESIDENT [crown] Ada" says it twice.
                     The one thing that would justify the word is if the crown were ambiguous here, and next
                     to a rail of money and trains it is not.
                     Design note #805: and it is now directly under the word "Treasury", which is a caption --
                     so the column reads "Treasury / [crown] Ada" and the absence of a second caption is what
                     keeps those two from looking like a label and its value. */}
                  {/* Design note #806: THE CASH TOOLTIP IS GONE, AND THE FIGURE IS NOT.
                     REQUESTED: "I believe we can remove the tooltip on the President's treasury/cash since
                     we've added this information at the bottom panel of the screen."
                     CHECKED RATHER THAN TAKEN ON TRUST, because the whole point of #326 was that this figure
                     existed on no Operating Round surface: `PlayerCashStrip` (#670) renders a row per seat
                     under the corporation panel, headed "Cash", for the whole table. Every president's cash
                     is on screen, visibly, all round -- which is strictly more than a hover on one name.
                     #326's ARGUMENT IS SATISFIED, NOT OVERRULED. It wanted the number attached to a person
                     rather than to "the acting turn"; the strip attaches it to every person by name. What
                     made it a tooltip was that there was nowhere to put it, and there is now.
                     AND #805 MADE THE CASE FOR REMOVING IT WITHOUT NOTICING. One turn ago I argued this
                     tooltip was "MORE load-bearing" once the president sat directly under the treasury,
                     because the two purses must not read as one figure. A hidden second number under a
                     visible first one is exactly the arrangement that invites that reading. A name is a name.
                     THE UNDERLINE GOES WITH IT: a dotted underline is a promise that hovering says something,
                     so leaving it over a tooltip-free element would be a control that refuses.
                     THE REMOVED STRING, for the record, was "President's Cash: $420" -- #743 corrected its
                     wording from "President's Personal Treasury" and #743's harness has been asserting on
                     this exact sentence since. The vocabulary RULE it was protecting is a sweep over every
                     surface and is untouched; what changes is which surface the example points at. */}
                  {activeCorporation.presidentLabel && (
                    <span
                      style={{
                        ...styles.orContextPresident,
                        color: corporationBarInk.inkMuted,
                      }}
                    >
                      {/* Design note #552: our own crown, not U+1F451 -- the same drawing every other surface
                          uses. */}
                      <PresidentCrown scale={0.95} style={{ marginRight: "3px" }} />
                      {activeCorporation.presidentLabel}
                    </span>
                  )}
                </span>

                {/* Design note #237: TOKENS, NOT A FRACTION. This read `2/4 - $40 ea`, which was wrong about the money:
                   the home token is free, the second is $40 and every one after that is $100 (`utils/stationTokens.ts
                   #0`), so "$40 ea" understated a third token by 60%. The row draws the whole allowance as circles in
                   placement order, each captioned with its own cost. See `StationTokenRow.tsx` for why it needs an inset
                   surface on a brand-coloured bar. */}
                {/* Design note #372: THE PINNED CARD SHOWS THE PIECES. #298 dropped the two rows that were expensive in
                   height -- the station circles and the train chips -- keeping the cheap single figures, which optimised
                   for pixels rather than for the decision: a president mid-turn asks "what do I own and where can I put a
                   token", and the answer was scrolled off the top while a number they cannot act on stayed pinned.
                   So the condensed card kept the PIECES and dropped the LIMIT.
                   Design note #672: and now keeps both -- see the train limit below, and the note on the sub-phase trail
                   for why the "expensive when pinned" premise did not survive being measured. */}
                <span style={styles.orContextFact}>
                  <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                    Stations
                  </span>
                  <StationTokenRow
                    slots={activeCorporation.stationSlots}
                    color={corporationBarInk.background}
                    ink={corporationBarInk.ink}
                    inkMuted={corporationBarInk.inkMuted}
                    emptyLabel="no allowance reported"
                    // Design note #362: the home slot shows its hex.
                    homeHexLabel={activeCorporation.homeHexLabel}
                  />
                </span>

                <span style={styles.orContextFact}>
                  <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                    Trains
                  </span>
                  {/* The same chips the Round Detail table draws, so a train
                      reads identically wherever it appears -- including the
                      amber tint on a tier that is about to rust. */}
                  {/* Design note #372: chips survive the pin. */}
                  {activeCorporation.trains.length === 0 ? (
                    <span style={{ ...styles.orContextFactNone, color: corporationBarInk.inkMuted }}>
                      none
                    </span>
                  ) : (
                    <TrainChips
                      trains={activeCorporation.trains}
                      phase={phase ?? null}
                      surface="dark"
                      // Design note #259: the rust countdown, matching the Round Detail table below the board. Without
                      // `outlook` a chip's tooltip names WHAT will destroy it but not HOW SOON -- and "rusts when the first
                      // 4-train is bought" is a different decision from "rusts in one more purchase". The figure was already
                      // computed for the table; this bar was not being handed it.
                      outlook={rustOutlookForBar}
                      /* Design note #375: interactive only during Run
                         Routes, where a chip and a route line are two views
                         of one thing. Outside it the chips are badges. */
                      interactive={orSubPhase === "Routes"}
                      highlightedTrainIndex={highlightedRouteIndex}
                      onHighlightTrain={onHighlightRoute}
                      /* Design note #802: clicking a chip opens that train's route under the row. Available
                         to every viewer -- the chips and the drafts both are -- which is what answers "the
                         train chips with their respective revenue values are still not displaying on other
                         players' Action bars". */
                      selectedTrainIndex={openTrainIndex}
                      onSelectTrain={(index) => {
                        setOpenTrainIndex((open) => (open === index ? null : index));
                        // The acting player's own cursor follows the chip they opened; a watcher has none.
                        if (mayActThisTurn) onSelectRouteTrain?.(index);
                      }}
                    />
                  )}
                  {/* Design note #248: the limit, beside the fleet it caps. The chips say WHICH trains; this says how much
                     room is left, which decides whether the Buy Trains step has anything in it. Amber at the ceiling.
                     Design note #372: dropped when pinned -- the one figure here a president cannot act on, since the Buy
                     Trains step enforces it on its own.
                     Design note #672: RESTORED IN THE CODE, not only in a note. #590 said this was restored and left the
                     `!condensed` gate in place, so the file asserted one thing and did another for two releases.
                     ON #372's ARGUMENT that a president cannot act on it: they cannot act on the number, and they decide
                     with it -- "am I one train from the ceiling" is what makes a $450 purchase urgent or pointless, and
                     the pinned bar is exactly where that question gets asked, because the player is looking at the board.
                     It is a `<span>` on a line that already exists; there was no row to reclaim. */}
                  {phase?.trainLimit !== undefined && (
                    <span
                      style={{
                        ...styles.orContextFactValue,
                        color:
                          activeCorporation.trains.length >= phase.trainLimit
                            ? "#e0c97a"
                            : corporationBarInk.ink,
                      }}
                      title={
                        activeCorporation.trains.length >= phase.trainLimit
                          ? `At the limit — ${phase.tier}-phase corporations may hold ${phase.trainLimit}. The Buy Trains step is skipped automatically.`
                          : `${phase.tier}-phase corporations may hold ${phase.trainLimit} trains.`
                      }
                    >
                      {/* A bare "2 / 4" beside a row of train chips reads as
                          a second count OF those chips. Naming it is the
                          whole fix: the number was never ambiguous to
                          anyone who already knew what it was. */}
                      Train limit: {activeCorporation.trains.length} / {phase.trainLimit}
                    </span>
                  )}
                </span>

                {/* Design note #379 (strip half): PRIVATES THE COMPANY OWNS. A corporation that bought a private owns a
                   real asset -- it pays that revenue into this treasury every Operating Round (#329) -- and no surface
                   said so. `utils/gameState.ts #379` has the full account.
                   ABSENT, NOT EMPTY, when there are none: a permanent "Privates: none" would be a row of nothing for seven
                   companies out of eight. The Ledger's table shows a dash, which is right for a table -- a column has to
                   keep its cell -- and wrong for a strip. */}
                {/* Design note #590: NOTHING IS DROPPED WHEN PINNED. #298 and #372 dropped the president line and the
                   privates row on the reasoning that a pinned bar carries "the pieces a president acts on".
                   The premise was that space was scarce. It is not, at the widths this is played at -- and the cost of the
                   rule is worse than the space it saved: a player who learns that presidency and train limit vanish under
                   pressure reasonably concludes they matter less, which is the opposite of true for the train limit.
                   If a narrow window ever makes this tight, the answer is wrapping or a smaller type scale, not deciding
                   for the player which facts they may keep. */}
                {activeCorporation.privates.length > 0 && (
                  <span style={styles.orContextFact}>
                    <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                      Privates
                    </span>
                    <span style={styles.orContextPrivates}>
                      {activeCorporation.privates.map((priv) => (
                        <span
                          key={priv.private_id}
                          style={{
                            ...styles.orContextPrivateChip,
                            color: corporationBarInk.ink,
                            borderColor: corporationBarInk.border,
                          }}
                          title={`${priv.name} — $${priv.revenue_per_or} per Operating Round into ${activeCorporation.ticker}'s treasury.`}
                        >
                          {/* Design note #407: revenue shown, not hovered. */}
                          {priv.private_id}. {priv.name} +${priv.revenue_per_or}
                        </span>
                      ))}
                    </span>
                  </span>
                )}

                {/* Design note #671: THE PRESIDENT WAS HERE, AT THE END OF THE RAIL, and #805 moved it under
                   the treasury. #671's placement argument was that the rail "is ordered by what a president
                   acts ON -- treasury, then tokens, then the fleet and its ceiling -- and whose company it is
                   decides nothing during the turn", so identity belonged after the figures.
                   THAT ORDERING SURVIVES; what it could not survive was WRAPPING. "Last" in a rail whose
                   length changes with the number of privates a corporation owns is not a position at all --
                   the crown moved down a line the moment a company bought its second private. Under the
                   treasury it keeps the same claim (identity is not a figure) while having somewhere fixed to
                   be, and it is beside the corporation's name again, which is what was asked for. */}
              </span>
            )}
          </div>

          {/* Design note #481: THE STEPPER ROW WAS A ROW FOR ONE WORD. Reported as two Undo buttons when expanded,
             and the sub-phase taking a whole row -- both were the same row. #235 put Undo beside the cursor it
             moves; #451 then put Undo in the action row's right rail WITH the sub-phase name, for the same reason.
             Two notes, one argument, two buttons. #451's placement wins because it sits with the other turn
             controls.
             THE STRIP IS NOW A PHRASE: it spent the panel's full width and 30-odd pixels of permanent height saying
             "you are on step 2 of 5, called Lay Track" -- which is a sentence. All three facts survive inline.
             WHAT IS LOST, honestly: the chips named the steps that come NEXT. `RulesReference.tsx` still lists them
             and the component is kept intact rather than deleted so that view can use it. */}
          <div style={styles.orPanelActionRow}>
            {/* LEFT RAIL -- docked status. Fixed home, so the phase badge and
                the rust warning sit in the same place all game. */}
            <div style={styles.orPanelRailLeft}>
              {/* Design note #482: THE TICKER LEAVES THE PINNED BAR. The row is a `1fr auto 1fr` grid precisely so the
                 centre is centred on the panel (#426) -- but a `1fr` track is `minmax(auto, 1fr)`: it refuses to shrink
                 below its content, so a rail holding a long unconstrained line of text does not get clipped, it GROWS
                 and takes the centre column with it. The sibling rail has carried `minWidth: 0` since #458; this never
                 did. Both fixes are wanted: the rail gets its `minWidth: 0`, which makes the centring structural.
                 Design note #500: THE HONEST NEXT STEP, TAKEN. #482 ended on "the honest next step is to take it out
                 altogether", and its own note called the expanded copy "redundant with the full ticker sitting on the
                 same screen". `TopTicker` has the same feed, the same filter and an accordion for the history.
                 `latestFeedItem` and `onOpenActivityLog` go with it -- a prop with no reader is how the line comes back. */}
              {phase && (
                <span style={{ ...styles.phaseBadge, ...PHASE_TINT_STYLES[phase.tint] }}>
                  {phase.label}
                </span>
              )}
              {/* Design note #325: TWO POCKETS, ONE ROW, CONSTANT CONFUSION. #300 added personal cash here so a
                 president facing an emergency buy could see what they can cover -- true, and the placement was still
                 wrong: this rail sits directly under the corporation strip, which shows `Treasury $X` in the same
                 typeface at the same size, and the tooltip explaining that they are different pockets only opens if you
                 already suspected they were. An Operating Round spends the CORPORATION's money, so the figure had no
                 decision on this screen to inform.
                 IT IS NOT DELETED, IT IS MOVED -- #326 hangs it off the president's own name. The auction and Stock
                 Round branch keeps its badge (#308): there the money IS the player's. */}
              {phaseAlert && (
                <span
                  className={phaseAlert === "critical" ? "app-phase-shift-critical" : undefined}
                  style={{
                    ...styles.phaseShiftBadge,
                    ...(phaseAlert === "critical"
                      ? styles.phaseShiftBadgeCritical
                      : styles.phaseShiftBadgeWarn),
                  }}
                  title={
                    phase?.shiftWarning ??
                    (phase?.depotRemaining === 0
                      ? `No ${phase.tier}-Trains left in the Bank Depot.`
                      : `Only one ${phase?.tier}-Train left in the Bank Depot.`)
                  }
                >
                  {phaseAlert === "critical" ? (
                    <>&#9888; Phase Shift Imminent</>
                  ) : (
                    <>&#9888; Phase Shift in 2 Buys</>
                  )}
                </span>
              )}
            </div>

            {/* CENTRE -- only what this sub-phase can actually do. */}
            <div style={styles.orPanelActions}>
              {/* Design note #279: NO PLACEHOLDER WHERE A CONTROL SHOULD BE. This fell back to "No button for this step
                 -- use Skip to move on", which describes the PANEL rather than the player's options: every step of an
                 Operating Round has something to do, and the line was only ever true of one div.
                 It also aged badly -- once the route controls moved into their own panel, `Routes` was the only step
                 reaching this branch, so the one place it rendered was a step with a whole route planner beneath it.
                 Deleted, with the Routes controls moved onto this line. The Track hint survives because it is the
                 opposite kind of string: it says where the action IS, which the player cannot otherwise know. */}
              {/* Design note #413: and it is only true for the player who may actually click that hex. Told to a
                 non-acting player it is an instruction they cannot follow, on a map that will refuse them. */}
              {/* Design note #831: TRIMMED, BECAUSE THE BUTTON NOW SAYS THE FIRST HALF.
                 #279 kept this sentence on the grounds that "it says where the action IS, which the player
                 cannot otherwise know" -- true then, and the Lay Track button says it now, in a control
                 rather than a paragraph. What a button cannot say is what to do once you are there, so that
                 is what survives.
                 THE CONDITION LOSES `contextualButtons.length === 0`, which was how this rendered at all: the
                 Track case had no buttons, and now it has one. Kept on `mayActThisTurn` for #413's reason --
                 told to a watcher it is an instruction they cannot follow. */}
              {mayActThisTurn && orSubPhase === "Track" && (
                <span style={styles.orPanelNoActions}>Click a laid preview to rotate it.</span>
              )}
              {/* Design note #510: the "Buy Trains" jump button is GONE. #491 added it because the purchase panels sat
                 far below a pinned bar; #508 moved those panels INTO the bar, so they travel with it -- and a button
                 whose only job was to scroll to something that no longer goes anywhere has nothing left to do. */}
              {contextualButtons.map((btn) => (
                <button
                  key={btn.key}
                  type="button"
                  /* Design note #619: a disabled button has to LOOK
                     disabled. */
                  style={{
                    ...styles.actionBarButton,
                    ...(btn.disabled || !sessionReady ? styles.actionBarButtonDisabled : {}),
                  }}
                  onClick={btn.onClick}
                  disabled={btn.disabled || !sessionReady}
                  title={btn.title}
                >
                  {btn.label}
                </button>
              ))}

              {/* Design note #279: THE ROUTE MODE TOGGLE IS A TOOLBAR CONTROL. It sat at the top of `RoutePlannerPanel`
                 above a table of drafted routes, which reads as a property of those routes rather than as the tool that
                 makes them. It sits immediately before Skip because those two ARE the choice on arriving at this step:
                 pick how to build a route, or decline to build one. See `RoutePlannerPanel`'s #7 for why the component
                 itself still lives there. */}
              {showRouteToggle && (
                <AutoRouteButton
                  onAutoRoute={onAutoRoute}
                  ownsAnyTrain={ownsAnyTrain}
                  controlsEnabled={sessionReady}
                  noTrainReason={NO_TRAIN_ROUTE_REASON}
                />
              )}
              {/* Design note #623: the step's finishing action, on the bar
                  that follows the player down the page. See
                  `RoutePlannerPanel.tsx` for why a second copy is right here
                  and was not before the bar became sticky. */}
              {showRouteToggle && (
                <RunRoutesButton
                  onRunRoute={onRunTrains}
                  drafts={trainDrafts}
                  controlsEnabled={sessionReady}
                  ownsAnyTrain={ownsAnyTrain}
                  noTrainReason={NO_TRAIN_ROUTE_REASON}
                />
              )}

              {/* Design note #258: SKIP IS AN ACTION, SO IT SITS WITH THE ACTIONS. #235 moved it to the action ROW for
                 the right reason and dropped it into the right RAIL -- the docked-utilities column -- so it ended up
                 flush right, half a panel from the buttons it is an alternative to. It is last in the CENTRE group now:
                 declining is the fallback, so it reads after the things it is a fallback to.
                 Design note #263: EXCEPT ON THE LAST STEP, WHERE IT IS A TWIN. Nothing follows Buy Trains, so "move past
                 this step" IS "finish this turn" -- and two buttons for one outcome implies a distinction a player then
                 has to work out. Skip is hidden on `Hardware`; every earlier step keeps it, because there it genuinely
                 does something End Turn does not. */}
              {/* Design note #278: A CORPORATION THAT EARNED CANNOT DECLINE. Skip on the Dividends step offered a third
                 option 1830 does not have -- once a route runs for more than $0 the money EXISTS and the rules give it
                 two destinations. Worse, it was the ONE step where skipping silently destroyed value: skipping Track
                 forgoes an opportunity, skipping a declared $180 throws away $180 already earned.
                 It tests the REVENUE rather than the sub-phase: the question is whether anything was earned.
                 (Its own "IT STAYS AT $0" exception is superseded -- see #436/#485.) */}
              {/* Design note #413: `mayActThisTurn` leads, because Skip is the control the report names. It dispatches
                 `AdvanceOperatingSubPhase` for the ACTING corporation, so a non-acting player clicking it was stepping
                 somebody else's turn forward. */}
              {/* Design note #674: SKIP IS NOT A UTILITY. It wore `actionBarUtilityButton` -- dimmer ink and a dashed
                 border -- alongside Undo, and reported as looking "slightly dimmer than the Buy Private button; they
                 should be the same since they're equally viable options."
                 THE REPORT IS A RULES POINT, not a taste one, and it is right. #258 called declining "the fallback",
                 which is true of a UI affordance and false of 1830: not laying track to keep $120 for a train, or
                 declining a private a rival needs you to bid on, are ordinary strong plays. A control the game
                 offers as a peer of the action beside it should not be drawn as its lesser.
                 UNDO KEEPS THE TREATMENT, which is what makes this a distinction rather than a deletion. Undo is not
                 a move at all -- `logRevert.ts` #591 is explicit that it is an instruction about the LOG -- so it is
                 categorically not one of the turn's options, and dimmer-and-dashed says exactly that.
                 THE LABEL CARRIES THE DIFFERENCE, chevron included. "Skip Buy Private ›" beside "Buy Private
                 Company" is unambiguous in words, and a second signal for a fact the words already state is what
                 `PlayerCards` #567 removed three of. */}
              {mayActThisTurn && orSubPhase !== "Hardware" && !dividendChoiceForced && !routeObligation && (
                <button
                  type="button"
                  /* Design note #619: it passes `disabled` and so it has to LOOK disabled. This button was missed by
                     that note's own sweep -- which found the contextual buttons and the phantom style key and left
                     the one control sitting between them. Exactly the invisible failure #619 describes: a
                     `Record<string, CSSProperties>` sheet cannot report a style nobody spread. */
                  style={{
                    ...styles.actionBarButton,
                    ...(!sessionReady ? styles.actionBarButtonDisabled : {}),
                  }}
                  onClick={onSkipSubPhase}
                  disabled={!sessionReady}
                  title={`Move past ${OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} without acting. Dispatches AdvanceOperatingSubPhase — the contract moves its own cursor one step.`}
                >
                  Skip {OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} &#8250;
                </button>
              )}
              {/* Design note #707/#619 said: SAY THE OBLIGATION, DO NOT ONLY REFUSE IT. #278 withdrew Skip on
                  Dividends silently, and this note argued that here "a Skip that is simply absent reads as a
                  panel that failed rather than as a rule".
                  ==================================================================
                   DESIGN NOTE 800: THE SENTENCE IS GONE; THE RULE IT DESCRIBED IS NOT
                  ==================================================================
                  REPORTED: "There's a string on the action panel: 'B&O has a route it can run, so it must.
                  Which route is up to you.' Get rid of this, it's unnecessary to state what the UI already
                  enforces. For 'Which route is up to you,' we will include a section of the future lightboxing
                  tutorial, so it can go too."
                  #707's WORRY WAS ABOUT A GAP AND THE GAP CLOSED. It was written when Skip's absence left an
                  unexplained hole; the step now shows a route planner, an Auto Route control and a Run button
                  in that space, so nothing reads as a panel that failed. A caption explaining why a button a
                  player never saw is missing is prose about an absence they cannot perceive.
                  AND THE SECOND SENTENCE HAS A BETTER HOME. "Which route is up to you" is a RULE, not a
                  status -- it belongs in the tutorial being built, where a player meets it once, rather than
                  on a bar that repeats it every Operating Round for the rest of the game.
                  `routeObligation` SURVIVES AS THE GATE. It still withdraws Skip four lines above (#41),
                  which is the enforcement the report calls "what the UI already enforces" -- deleting the
                  predicate along with its sentence would have removed the rule while satisfying the request. */}
              {/* The one line that replaces the whole control set for a
                  player who is not acting. Without it the centre column is
                  simply empty, which reads as a panel that failed to load
                  rather than as somebody else's turn. */}
              {!mayActThisTurn && (
                <span style={styles.orPanelNoActions}>
                  {activeCorporation
                    ? `${activeCorporation.ticker} is operating — its president has the controls.`
                    : "Another corporation is operating."}
                </span>
              )}
            </div>

            {/* RIGHT RAIL -- always-available utilities, never sub-phase
                specific, so they do not belong in the centre. */}
            <div style={styles.orPanelRailRight}>
              {/* Design note #266: the Auto Route / Manual Route pair used to live in the docked-utilities rail. They are
                 not utilities -- they are the first step of the Run Routes task -- and now head `RoutePlannerPanel` as
                 one segmented control. See that file's #0 for why three regions became one column. */}
              {/* Design note #451: UNDO, AND WHAT IT WOULD UNDO. Undo lived only on the non-Operating-Round branch, so
                 in the round with the most undoable actions and the only one with sub-steps to get lost in, the button
                 was absent -- a player who laid the wrong tile had to leave the round's own panel to find it.
                 THE PAIR IS THE POINT: `Undo` alone answers "can I take that back"; `Track undo` answers "take back what
                 I did in Track". #439 made Undo rewind past auto-skipped steps to the last thing the player chose, so
                 naming the step it lands on is what makes that legible rather than surprising.
                 It sits in the right rail, which the grid keeps clear of the centred group, so adding it moves nothing. */}
              <span style={styles.undoStepLabel}>
                {OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel}
              </span>
              {/* Design note #592d: `undoBlockedReason`, not `sessionReady` --
                  Undo is not a move and must not wait for your turn. */}
              <button
                type="button"
                style={{
                  ...styles.actionBarButton,
                  ...styles.actionBarUtilityButton,
                  ...(undoBlockedReason ? styles.actionBarButtonDisabled : {}),
                }}
                onClick={onUndoLastAction}
                disabled={undoBlockedReason !== null}
                title={
                  undoBlockedReason ??
                  "Takes back the last action. Available on anyone's turn."
                }
              >
                &#8630; Undo
              </button>
            </div>
          </div>

          {/* Design note #490: the payout detail, inside the panel and under the buttons it explains. `orPanel` is a
             flex COLUMN, so this lands directly below the action row with no positioning of its own.
             Design note #188 (kept): the consequence of each option, laid out before the player commits -- WHO gets
             paid and how much, and WHERE the stock token lands. Both computable from state already on screen, and
             both previously left for the player to work out. */}
          {/* Design note #498: THE PINNED BAR DROPPED THE ONE STEP THAT IS ABOUT THE TRAINS. #298's rule -- keep
             what a player needs WHILE LOOKING AT THE BOARD -- is right, and Run Routes is the step where it
             misfires: everything about this step IS the board, and `RoutePlannerPanel` carries all of it and scrolls
             away. So this row is the exception #298's own reasoning asks for, and it is narrow: condensed only,
             Routes only, one line.
             THE CHIPS ARE LIVE, not a readout -- they call the same handlers the planner rows do, so a player can
             still switch which train the map is drafting for. A dead label would show the problem without giving
             anywhere to act on it. */}
          {/* ==================================================================
               DESIGN NOTE 739: WATCHING IS PART OF THE GAME
             ==================================================================

             REQUESTED: "it is normal in a game of 18xx to see/watch rivals set their routes: perhaps during
             the Run Routes phase, every player's Action bar should show the color-coded train chips as well as
             the routes on the map and the revenue for each and total?"

             #691 REMOVED THIS ROW FROM INACTIVE SCREENS, and its reasoning was about CONTROLS -- "on somebody
             else's turn they would be a row of controls that dispatch for a corporation the reader does not
             hold". Every word of that is still true, and none of it argues against the INFORMATION. A route
             is public: it is drawn on a shared board out of track everybody can see, and at a table you watch
             a president trace it with a finger. Hiding it is a departure from the physical game that #691
             never intended and only made because control and content were the same element.

             SO THE ROW IS SPLIT BY ROLE, NOT REMOVED. The acting president gets buttons; everybody else gets
             the same chips as static text -- no `onClick`, no `aria-pressed`, no `disabled`, because a
             disabled control invites a reader to wonder what they did wrong. Hover still highlights the route
             on the map, which is a reading aid rather than an action.

             AND THE TOTAL, which the report asks for and the president's own row never had: watching is a
             comparison ("can they beat my run?"), and per-train figures without a sum make the reader do
             arithmetic the panel is already holding. */}
          {/* ==================================================================
               DESIGN NOTE 815: THREE ROWS OF TRAIN CHIPS, ONE OF WHICH OPENED THE ROUTE
              ==================================================================

              REPORTED, two halves of one thing:
                2)  "on the Run Routes subphase, the sticky/traveling Action Panel shows the train chips, but
                     clicking them does not have the drop-down showing their route and the option to clear
                     them for manual routing."
                2a) "when the Action Bar docks at the top, the train chips with their revenue values disappear
                     completely. Usually the docked version is larger than the sticky. Here, they should be
                     the same size."

              THE BAR WAS DRAWING TRAIN CHIPS IN THREE PLACES AND ONLY ONE OF THEM WAS #802's HANDLE.
                * The corporation card's fleet chips (`TrainChips`, above) -- correctly wired to open the
                  route detail, and carrying no revenue figures, because the fleet is not a route.
                * This row, for the acting president -- revenue figures, gated on `condensed`, and its click
                  moved the DRAFT CURSOR rather than opening anything.
                * A read-only twin of this row for everybody else (#739) -- revenue figures, static spans.
              So a president clicked the chips that showed the money and nothing dropped down, because the
              chips that drop down are the ones without the money on them. Both halves of #802 shipped; they
              shipped on different rows.

              AND (2a) IS THE SAME SPLIT SEEN FROM THE OTHER SIDE. `condensed &&` was correct when this row
              was the SMALL twin of `RoutePlannerPanel`, which carried the per-train figures in the full-size
              bar. #802 deleted that panel and left the gate, so the figures existed only while the bar was
              pinned -- exactly inverted from the report's expectation, and from every other row here, which
              #590 settled: "nothing is dropped when pinned".

              ONE ROW NOW, for every viewer, in both bar states. The president's click still moves their draft
              cursor; a watcher has no cursor to move and is not offered one. The TOTAL, which #739 gave only
              to watchers, is on the row everybody sees -- a president comparing their own trains was doing
              arithmetic the panel was already holding for somebody else. */}
          {orSubPhase === "Routes" && trainDrafts.length > 0 && (
            <div style={styles.condensedTrainRow} role="group" aria-label="Drafted routes">
              {trainDrafts.map((draft) => {
                const isOpen = draft.trainIndex === openTrainIndex;
                /* Design note #815: TWO STATES, TWO CHANNELS, and they are genuinely different facts. OPEN is
                   "this chip's route is showing" and belongs to every viewer; DRAFTING is "map clicks land on
                   this train" and belongs only to the president. A click sets both for them, so they usually
                   coincide -- but `AutoRouteButton` moves the cursor without opening anything, and that is
                   exactly the moment a president needs to know which train they are about to draw for.
                   The fill carries the cursor and an outline carries the open state, which is the same split
                   #802 used on the fleet chips for the same reason (#732: one channel, one meaning). */
                const isDrafting = mayActThisTurn && draft.trainIndex === activeTrainIndex;
                return (
                  <button
                    key={draft.trainIndex}
                    type="button"
                    aria-pressed={isOpen}
                    aria-expanded={isOpen}
                    /* NOT `disabled` ON `sessionReady`, unlike the row this replaces. Opening a readout
                       dispatches nothing, and a watcher has no session key by construction -- greying the
                       chips for them would be #783's "disabled control invites a reader to wonder what they
                       did wrong" on the one surface #802 built for exactly those readers. */
                    onClick={() => {
                      setOpenTrainIndex((open) =>
                        open === draft.trainIndex ? null : draft.trainIndex,
                      );
                      // The acting president's draft cursor follows the chip; a watcher has none.
                      if (mayActThisTurn) onSelectRouteTrain(draft.trainIndex);
                    }}
                    onMouseEnter={() => onHighlightRoute?.(draft.trainIndex)}
                    onMouseLeave={() => onHighlightRoute?.(null)}
                    style={{
                      ...styles.condensedTrainChip,
                      ...(isDrafting ? styles.condensedTrainChipActive : {}),
                      ...(isOpen ? styles.condensedTrainChipOpen : {}),
                      // Design note #494: the route's own ink, so the chip and
                      // the line on the map are the same colour.
                      borderBottomColor: routeTrainColor(draft.trainIndex),
                    }}
                    title={
                      draft.value === null
                        ? `${draft.model}-train has no route drafted yet. Click to open it${
                            mayActThisTurn ? " and draft for it" : ""
                          }.`
                        : `${draft.model}-train runs for $${draft.value}. Click to see its route.`
                    }
                  >
                    {draft.model}-Train
                    {/* Design note #498: the VALUE, which is the number this
                        row exists to carry. An em dash rather than "$0" for a
                        train with no route: zero is a priced run that earns
                        nothing, and no route is not that. */}
                    <span style={styles.condensedTrainValue}>
                      {draft.value === null ? "—" : `$${draft.value}`}
                    </span>
                  </button>
                );
              })}
              {/* Design note #739: the sum, and only when there is more than one figure to sum. On a
                  one-train corporation a total beside the single value would be the same number twice.
                  Design note #815: and now for the president too -- see above. */}
              {trainDrafts.filter((draft) => draft.value !== null).length > 1 && (
                <span style={styles.spectatorTotal}>
                  Total ${trainDrafts.reduce((sum, draft) => sum + (draft.value ?? 0), 0)}
                </span>
              )}
            </div>
          )}
          {/* Design note #509: THE DECISION TRAVELS WITH THE BUTTONS. #490 gated this on `!condensed`, reasoning
             from #298's rule -- and this was the wrong side of it: the payout table and the two market moves are
             not orientation, they are the INPUTS to the two buttons directly above them. Hiding them when pinned
             left a scrolled player with Pay and Withhold live and no way to see what either does.
             The Buy Trains panel travels for the same reason and by the same mechanism: the bar is `position:
             sticky`, so anything inside it follows. */}
          {/* Design note #691: the payout table and the two market moves are the INPUTS to Pay and Withhold
              (#509). With those buttons gone on an inactive screen, the inputs describe a choice the reader is
              not making -- and the round's own result reaches them through the Activity Log either way. */}
          {mayActThisTurn && orSubPhase === "Dividends" && (
            <div style={styles.dividendPanel}>
              <div style={styles.dividendColumn}>
                <span style={styles.dividendHeading}>
                  Pay out ${declaredRevenue} &middot; ${declaredPerShare}/share
                </span>
                {dividendPayouts.length === 0 ? (
                  <span style={styles.dividendNote}>
                    No shareholders on record — the whole payout would go to the bank pool.
                  </span>
                ) : (
                  /* Design note #705: BOTH ENDS AND THE MOVE BETWEEN THEM.
                     REPORTED: "it's hard to see in the Dividends phase how paying out affects players'
                     personal cash ... the solution is looking at us on the Withhold side where we show the
                     corporation's treasury with its current value to its new value ... I am reluctant to lose
                     the actual payout amount, which going from current to new treasury will elide."
                     The two columns were answering different KINDS of question -- Withhold a before-and-after
                     about a balance, Pay a bare delta only a reader already holding P1's cash in their head
                     could use. That is the very thing #509a fixed one column to the right, and this column was
                     left computing.
                     THE AMOUNT KEEPS ITS GREEN and its place in the middle: it is what the decision turns on
                     (#188 put it on the button for the same reason), so it sits BETWEEN the balances it
                     connects rather than being replaced by them.
                     ONE ARROW, NOT TWO. The report sketched `[current] > +$[payout] > [new]`; written as
                     `$420 + $54` then the arrow, the middle term reads as the addition it is rather than as a
                     value the cash briefly becomes -- and the line keeps `MarketMoveLine`'s and the withhold
                     transition's single-arrow grammar, which is the consistency the report is reaching for. */
                  dividendPayouts.map((row) => (
                    <span
                      key={row.holder}
                      style={styles.dividendRow}
                      title={describeDividendRow(row)}
                    >
                      <span style={styles.dividendHolder}>
                        {/* Design note #706: the bank pool pays the CORPORATION, so its row wears the same
                            herald the Withhold column gives the treasury -- the two columns are now showing
                            the same balance and should say so in the same way. */}
                        {row.kind === "treasury" && (
                          <CorporateLogo
                            ticker={row.holder}
                            size={14}
                            color={corporationInk}
                            title={`${row.holder} treasury`}
                          />
                        )}
                        {row.holder} <span style={styles.dividendPct}>{row.percentage}%</span>
                      </span>
                      {row.cashBefore === null || row.cashAfter === null ? (
                        /* A balance this build cannot read. #278's rule -- a number we cannot stand behind is
                           worse than no number -- so the row states what is known and stops. */
                        <span style={styles.dividendAmount}>${row.amount}</span>
                      ) : (
                        <span style={styles.dividendMoveGroup}>
                          <span style={styles.treasuryFrom}>${row.cashBefore}</span>
                          <span style={styles.dividendPlus} aria-hidden="true">
                            +
                          </span>
                          <span style={styles.dividendAmount}>${row.amount}</span>
                          <span
                            style={{ ...styles.dividendMoveArrow, ...styles.dividendMoveArrowUp }}
                            role="img"
                            aria-label="rises to"
                          >
                            &#10132;
                          </span>
                          <span style={styles.treasuryTo}>${row.cashAfter}</span>
                        </span>
                      )}
                    </span>
                  ))
                )}
                <MarketMoveLine
                  currentPrice={dividendPrice}
                  projection={payProjection}
                  direction="pay"
                />
              </div>

              {/* Design note #509a: SHOW THE MONEY MOVING, DO NOT DESCRIBE IT. The sentence it replaces was two clauses
                 of rules text on a panel whose other column shows an actual table of figures -- it described a
                 consequence the player then had to compute, since they know the treasury and they know the revenue.
                 The transition states it, and it mirrors `MarketMoveLine` deliberately (same arrow, same green-for-a-
                 rise rule, #489) so the two things a withhold does read as one pair of before/after facts.
                 THE HERALD IS THE SUBJECT -- whose treasury this is was the one fact the sentence carried that the
                 numbers do not, and a logo says it in the space a pronoun took. */}
              <div style={styles.dividendColumn}>
                <span style={styles.dividendHeading}>Withhold ${dividendRevenue}</span>
                <span style={styles.treasuryMove}>
                  {activeCorporation && (
                    <CorporateLogo
                      ticker={activeCorporation.ticker}
                      size={18}
                      color={corporationInk}
                      title={`${activeCorporation.ticker} treasury`}
                    />
                  )}
                  <span style={styles.treasuryFrom}>${treasuryNow}</span>
                  <span
                    style={{ ...styles.dividendMoveArrow, ...styles.dividendMoveArrowUp }}
                    role="img"
                    aria-label="rises to"
                  >
                    &#10132;
                  </span>
                  <span style={styles.treasuryTo}>${treasuryAfterWithhold}</span>
                </span>
                <MarketMoveLine
                  currentPrice={dividendPrice}
                  projection={withholdProjection}
                  direction="withhold"
                />
              </div>
            </div>
          )}

          {/* Design note #508: THE PURCHASE PANELS MOVED INTO THE BAR. #203 moved both halves of this step OUT,
             correctly -- the bar could not host a depot queue and a corporation roster as inline controls. What that
             left was a step whose entire interface lived below a `position: sticky` bar, so scrolling the board
             scrolled the controls away and left "End Turn" pinned on its own. #491 patched the symptom with a jump
             button; this removes the cause -- the panel renders HERE, sticky by inheritance, with nothing to jump to.
             IT IS STILL ONE COMPONENT, which keeps #203's argument intact: there is exactly one place a train is
             bought, it has simply changed address. `condensed` is the panel's own pinned form, not a second copy. */}
          {/* Design note #619: SAY THE OBLIGATION, DO NOT ONLY REFUSE IT. A `disabled` button cannot answer a click
             -- the browser swallows the event before any handler runs -- so "prompt errant clicks" is not available
             without un-disabling the control and refusing the action ourselves, which would put a button on screen
             that dispatches nothing. The honest substitute is to stop the click being errant: state the obligation
             where the player is already looking.
             So the notice is PERSISTENT rather than a response, and it names the emergency purchase -- which is what
             makes the greyed button feel like a rule rather than a malfunction. */}
          {/* Design note #691: the obligation is the ACTING president's. #619 wrote it to stop an errant click on
              a greyed button; on a screen with no button it is a rule addressed to somebody else. */}
          {/* Design note #803: `orStep` here too. This one is still inside the Operating Round branch and is
              therefore already safe -- switched anyway so every step test in the file reads the same way. A
              rule that holds only where somebody remembered to nest it is the rule that broke. */}
          {mayActThisTurn && orStep === "Hardware" && mustBuyTrain && (
            <div style={styles.mustBuyTrainNotice} role="status">
              This corporation owns no train and has a route to run — it must buy one before the
              turn can end. If the treasury cannot cover the cheapest train, the president pays
              the difference personally.
            </div>
          )}
          {/* Design note #785: THE TWO TALL PANELS MOVED OUT OF THE STICKY ELEMENT -- see the note beside
              them, below the bar's closing tag. They were the only reason it kept unpinning itself. */}
        </div>
      ) : (
      <div style={styles.actionBarPanel}>
        {/* Design note #636: THE SAME THREE ROWS AS AN OPERATING ROUND. The OR branch is a COLUMN -- identity
           card, then a `1fr auto 1fr` action row -- while this was a single action row with the seat card wedged
           into its left rail, so the card competed with the buttons for width and the two rounds put the same
           object in two places.
           ON THE OBJECTION that players are different from corporations: the difference is real and it is not in
           the LAYOUT. What differs is what the track contains -- one corporation's progress through its own turn
           versus the whole table's rotation. What a player learns from the standardisation is where to LOOK.
           THE PHASE BADGE STAYS IN THE ACTION ROW'S RIGHT RAIL, as the Operating Round keeps its utilities there:
           it is chrome about the game rather than about this seat. */}
          {/* Design note #631: THE SEAT CARD, BUILT LIKE THE CORPORATION CARD. A 3px stripe can only signal that
             SOMETHING is the case; it cannot say what. The Operating Round bar does not have that problem because
             it does not use a stripe -- `orContextCard` is a saturated block carrying acronym, name and figures, and
             a player reads WHO from it without being taught that colour means anything.
             So this is that card with a seat in it: same construction, ink from `bestContrastTextColor` rather than
             asserted, a translucent black border so one rule darkens any hue. Not a new idea, the existing one
             applied to the round that was left out.
             THE FIGURES ARE LABELLED: the compressed "P1 $500 (+$200)" made players think they were earning $200,
             which is entirely fair -- a bare "+$200" beside a balance is the notation a game uses for income, while
             escrowed money is the opposite. A plus sign cannot carry that and no tooltip fixes a glyph nobody hovers.
             THE STRIPE STAYS -- it is the HANDOFF animation (#597), and a card that is always there cannot sweep. */}
          {actingSeatColor && activePlayerCash !== null && (
            <span
              style={{
                ...styles.seatContextCard,
                backgroundColor: actingSeatColor,
                borderColor: "rgba(0, 0, 0, 0.35)",
              }}
            >
              <span
                style={{
                  ...styles.seatContextName,
                  color: bestContrastTextColor(actingSeatColor),
                }}
              >
                {activePlayerName ?? "Player"}
              </span>
              <span style={styles.seatContextFigures}>
                <span style={styles.seatContextFact}>
                  <span
                    style={{
                      ...styles.seatContextFactLabel,
                      color: seatInkMuted(actingSeatColor),
                    }}
                  >
                    Cash
                  </span>
                  <span
                    style={{
                      ...styles.seatContextFactValue,
                      color: bestContrastTextColor(actingSeatColor),
                    }}
                  >
                    ${activePlayerCash}
                  </span>
                </span>
                {activePlayerEscrow > 0 && (
                  <span
                    style={styles.seatContextFact}
                    title={`$${activePlayerEscrow} of ${activePlayerName ?? "this player"}'s money is committed to standing bids. It is not spendable now, and it comes back if those bids lose.`}
                  >
                    <span
                      style={{
                        ...styles.seatContextFactLabel,
                        color: seatInkMuted(actingSeatColor),
                      }}
                    >
                      In bids
                    </span>
                    <span
                      style={{
                        ...styles.seatContextFactValue,
                        color: bestContrastTextColor(actingSeatColor),
                      }}
                    >
                      ${activePlayerEscrow}
                    </span>
                  </span>
                )}
              </span>
            </span>
          )}
        <div style={styles.actionBarButtons}>
          {/* Design note #308: THE AUCTION BAR HAD NEITHER NAME NOR MONEY. #300 put the acting player's cash on the
             Operating Round branch; the auction and Stock Round got neither -- the wrong way round if anything,
             since an OR spends the CORPORATION's treasury while a private auction spends the player's own money and
             nothing else. It leads the row because in a hotseat the first question is whose turn this is.
             Design note #309: THE BUTTONS SIT WHERE THE OTHER BRANCH PUTS THEM. Pass and Undo were left-aligned here
             while the OR's are centred, so switching rounds moved the buttons across the screen and muscle memory
             built in one phase missed in the next. A leading spacer balances the trailing one. */}
          {/* Design note #601: THE ROSTER PILLS WERE UNREACHABLE. Deleted: a `playerRoster.length > 0` branch, eight
             styles and a keyframes block -- roughly forty lines of render that could not execute.
             #595a left them "for every case the trail does not cover", which sounded careful and described an empty
             set: `playerRoster` is computed behind `current_round_type === "WaterfallAuction" || === "StockRound"`
             (#406) and returns `[]` otherwise -- the SAME test that decides whether `seatOrderTrail` is passed. Any
             time the roster is non-empty the trail is non-null, wins the `??`, and the pills never render.
             THE LESSON IS ABOUT THE SHAPE OF THE GUARD: two conditions in two files, each true exactly when the
             other is, read like a fallback and behave like dead code -- and nothing flags it, because it compiles.
             What the pills knew lives on in `SeatOrderTrail` (#342, #317). #545's mini-auction chase is the one
             thing genuinely gone. The acting-player badge below is now the only fallback. */}
          {/* Design note #426: the centre cell of a `1fr auto 1fr` grid.
              The leading `actionBarSpacer` that used to sit here is gone --
              see `appStyles.ts` for why two equal spacers centred the group
              between themselves but not on the bar. */}
          {/* Design note #654: the phase group leads the row, flush left. */}
          <span style={styles.actionBarRailLead}>
          {phase && (
            <span style={{ ...styles.phaseBadge, ...PHASE_TINT_STYLES[phase.tint] }}>
              {phase.label}
            </span>
          )}
          {/* Design note #7 (`gamePhase.ts`): TWO steps, not one. This badge rendered identically at two purchases
             and at one, so the last purchase before a rust -- the most consequential moment in an 1830 game --
             looked exactly like the moment before it. It reads the same `phaseAlertLevel` helper the train chips do,
             so the bar and the chips escalate together, and the wording escalates with the colour: "Imminent" is a
             claim about the NEXT purchase, and it was being made one purchase too early. */}
          {phaseAlert && (
            <span
              className={phaseAlert === "critical" ? "app-phase-shift-critical" : undefined}
              style={{
                ...styles.phaseShiftBadge,
                ...(phaseAlert === "critical"
                  ? styles.phaseShiftBadgeCritical
                  : styles.phaseShiftBadgeWarn),
              }}
              // The exact consequence, per tier. Falls back to a plain
              // depot-count statement for the 2-train case, which empties
              // without triggering anything -- see `PHASE_SHIFT_CONSEQUENCE`.
              title={
                phase?.shiftWarning ??
                (phase?.depotRemaining === 0
                  ? `No ${phase.tier}-Trains left in the Bank Depot.`
                  : `Only one ${phase?.tier}-Train left in the Bank Depot.`)
              }
            >
              {phaseAlert === "critical" ? (
                <>&#9888; Phase Shift Imminent</>
              ) : (
                <>&#9888; Phase Shift in 2 Buys</>
              )}
            </span>
          )}
          </span>
          <span style={styles.actionBarButtonsCentre}>
          {/* Design note #31: Pass leads -- it is the action available in
              every phase, and the one a player reaches for most. */}
          <button
            type="button"
            style={{
              ...styles.actionBarButton,
              ...(!sessionReady || passDisabledReason !== null
                ? styles.actionBarButtonDisabled
                : {}),
            }}
            onClick={onPassTurn}
            disabled={!sessionReady || passDisabledReason !== null}
            /* Design note #745: the label is the rule. A player who has just sold is looking at the only
               button that will end their turn, and while it read "Pass Turn" the reasonable inference was
               that pressing it forfeits something -- which is how the reported bug was found. */
            title={passDisabledReason ?? passButtonTitle(turnActionTaken === true)}
          >
            {passButtonLabel(turnActionTaken === true)}
          </button>
          {/* Design note #717: AUTO-PASS SITS BESIDE PASS, because it is the same decision with a duration.
              Only in a Stock Round -- an Operating Round turn is a corporation's, not a player's, and there is
              nothing there a standing instruction could safely stand for.
              ARMED, IT IS A DISARM BUTTON. One control, two states, so a player can always see whether it is
              on -- which is the thing they most need to know about a setting that acts without them. */}
          {/* Design note #728: SHOWN WHENEVER IT IS ARMED, not only where it can be armed.
              REPORTED: "Players need a way to disable Auto-Pass once it is on. The Auto-Pass button should be
              clickable at any time for them to turn it off."
              The condition was `roundType === "StockRound"`, which is right for OFFERING the control and wrong
              for WITHDRAWING it: the instant the round turned, the button vanished while the arm was still set,
              so the only way out was to wait for a Stock Round that would then be passed for you. An off switch
              that is only reachable in the state it acts on is not an off switch.
              `armed ||` is the whole fix. Arming still needs a Stock Round; disarming needs nothing. */}
          {autoPass && (autoPass.armed || roundType === "StockRound") && (
            <button
              type="button"
              style={{
                ...styles.actionBarButton,
                ...(autoPass.armed ? styles.autoPassArmed : {}),
                ...(!autoPass.armed && !sessionReady ? styles.actionBarButtonDisabled : {}),
              }}
              onClick={autoPass.armed ? autoPass.onDisarm : autoPass.onOpenSettings}
              /* Design note #728: never disabled while armed. `sessionReady` gates ARMING because a standing
                 instruction that will dispatch needs a session to dispatch through; clearing one is a local
                 state write that needs nothing. A dropped connection must not trap a player inside a setting
                 that keeps taking their turns. */
              disabled={!autoPass.armed && !sessionReady}
              title={
                autoPass.armed
                  ? "Auto-Pass is on for this Stock Round. Click to turn it off."
                  : "Pass automatically until something happens that affects you, or the Stock Round ends."
              }
            >
              {autoPass.armed ? "Auto-Pass: On" : "Auto-Pass"}
            </button>
          )}
          {/* Design note #540: A DIVIDER NEEDS SOMETHING ON BOTH SIDES. Reported as two bars between Pass Turn and
             Undo -- these two, with nothing between them. The pair frames `contextualButtons`, which is EMPTY in
             several real states: an auction round, a Stock Round with no corporation selected, and a room whose game
             has not been dealt. A rule divides things, and there was nothing to divide.
             Gated on the group they frame rather than on any particular round, so every empty case is covered. */}
          {/* Design note #817: THE WAY OUT, where a player is already looking. It sits before the divider
              rather than among `contextualButtons` because it is not a step's control -- it belongs to a MODE
              the board is currently in, and it appears and vanishes with that mode rather than with the step.
              Amber rather than red: cancelling an unspent power costs nothing, and a destructive colour on the
              escape hatch is the wrong sort of hesitation to introduce. */}
          {armedErrand && (
            <button
              type="button"
              style={{ ...styles.actionBarButton, ...styles.actionBarCancelErrand }}
              onClick={armedErrand.onCancel}
              title="Leaves this special power armed and unspent. Nothing is used up."
            >
              {armedErrand.label}
            </button>
          )}
          {contextualButtons.length > 0 && <span style={styles.actionBarDivider} />}
          {contextualButtons.map((btn) => (
            <button
              key={btn.key}
              /* Design note #619: same treatment as the expanded copy above --
                 the two forms of this bar must not disagree about whether a
                 control is available. */
              style={{
                ...styles.actionBarButton,
                ...(btn.disabled || !sessionReady ? styles.actionBarButtonDisabled : {}),
              }}
              onClick={btn.onClick}
              disabled={btn.disabled || !sessionReady}
              title={btn.title}
            >
              {btn.label}
            </button>
          ))}
          <span style={styles.actionBarDivider} />
          {/* Design note #592d: UNDO IS NOT A MOVE, SO IT IS NOT TURN-GATED. `sessionReady` is
             `controlsEnabled && isMyTurn`, so Undo wore the same gate as Buy and Pass -- exactly backwards, since
             the player who most needs it is the one whose turn has just passed, and the host's longer reach exists
             to fix a mistake that is no longer theirs to fix on their own turn.
             ONE REASON STRING IS THE WHOLE GATE: `undoBlockedReason` is non-null whenever Undo cannot fire, and the
             button shows it. A boolean plus a separate message would be two things to keep in step. */}
          <button
            style={{
              ...styles.actionBarButton,
              ...styles.actionBarUtilityButton,
              ...(undoBlockedReason ? styles.actionBarButtonDisabled : {}),
            }}
            onClick={onUndoLastAction}
            disabled={undoBlockedReason !== null}
            title={undoBlockedReason ?? "Takes back the last action. Available on anyone's turn."}
          >
            Undo Last Action
          </button>
          {/* The route mode toggle used to render here too. It is `showRouteToggle`-gated and that flag is
             OR-and-Routes-only, so in this branch it was unreachable markup -- removed rather than left as a second
             copy to keep in step with the live one. */}
          </span>

          {/* Design note #654: THE GRID HAD THREE COLUMNS AND TWO CHILDREN. `actionBarButtons` is a `1fr auto 1fr`
             grid and #426 describes it working -- it never did in this branch. Only TWO children were put in it, so
             the buttons took column one, the badge took column two, and a whole `1fr` column sat empty off the right
             edge: buttons left of centre, badge adrift in the middle.
             #426 says "the rail renders unconditionally so the grid always has three columns" -- true of the RIGHT
             rail it was written about, never made true of the left one. `actionBarRailLeft` is defined in
             `appStyles.ts` and this file had never referenced it. A grid does not report a missing child; it shifts
             everything one column over and renders something plausible.
             Phase leads, buttons centre, and the trailing rail is empty and unconditional -- it exists only so the
             centre column has equal weight either side. */}
          <span style={styles.actionBarRailTrail} aria-hidden="true" />
        </div>
      </div>
      )}
      {/* ==================================================================
           DESIGN NOTE 828: BACK INSIDE THE BAR, ON A MEASUREMENT THIS TIME
          ==================================================================

          #508 put these panels in the bar by reasoning. #785 took them out by reasoning. Both were right
          about the mechanism and neither had the number, which is why #813 built a probe instead of a
          third argument. It reported, on the device this is played on:

              fit probe . bar 185 + panel 242 = 427px . 65% of 652px . WOULD UNPIN

          427 AGAINST A 326px BUDGET -- half of a 652px viewport, #720's threshold. So the answer to "can
          the panel be sticky" was no, and the answer to "can it be MADE sticky" was 101 pixels.

          #828 FINDS THEM IN THE PANEL RATHER THAN THE BAR. The depot table is reference (#633: "five of
          the six are reference") and folds behind its caret when the bar is pinned; the buy row, which is
          the step, never folds. The pinned panel is a header and a row.

          AND #720 REMAINS THE SAFETY NET, which is what makes this reversible rather than a bet. If a
          player opens the depot table or the corporate roster while pinned and the bar exceeds the
          budget, it unpins -- the same behaviour that was reported twice as a bug. The difference is that
          it now follows an expansion the player asked for, rather than arriving with the step. The probe
          stays until a playtest says the pinned default reads "would stay pinned". */}
      {/* Design note #810: the clearance rides on the DESTINATION, not on the scroll call. `scroll-margin-top`
          is honoured by `scrollIntoView`, by `:target`, by a browser's own restore-scroll and by anything
          else that ever scrolls to this element -- so the bar's height is stated once, where the element is,
          rather than at each call site that has to remember the bar exists.
          Design note #831: WRITTEN BY `useJumpTarget` NOW, not inline. #810's argument gets stronger with a
          second destination that a different component owns: if the clearance were an inline style, the map's
          owner would have to know about this bar's height. The hook applies it to whatever target it is
          given, so neither caller has to. */}
      <div ref={stepPanelRef}>
      {/* Design note #691: THE PANEL THE REPORT NAMES. The depot table, its quantity selector and its Buy
          button are the largest block in this bar, and on three of four screens they were furniture. */}
      {/* Design note #715: THE STEP'S OWN CONTROLS, ON THE STEP. Reported: the purchase panel "should maybe
          be a subpanel like 'Buy Trains' instead of something you only see by actively clicking into it."
          Rendered on the same condition as the depot below it -- acting player, right sub-phase, data
          present -- so the two purchase steps of a turn have one shape. */}
      {mayActThisTurn && orStep === "BuyPrivate" && privatePurchase && (
        <ProposePrivatePurchase
          embedded
          open
          buyerTicker={privatePurchase.buyerTicker}
          privates={privatePurchase.privates}
          treasury={privatePurchase.treasury}
          labelForAddress={privatePurchase.labelForAddress}
          // Design note #779: the holder's seat colour, from the shell that has the roster.
          colorForAddress={privatePurchase.colorForAddress}
          onPropose={privatePurchase.onPropose}
          onClose={() => undefined}
        />
      )}
      {mayActThisTurn && orStep === "Hardware" && trainPurchase && (
        <TrainPurchasePanel
          depot={trainPurchase.depot}
          buyer={trainPurchase.buyer}
          companies={trainPurchase.companies}
          sessionReady={sessionReady}
          canAct={trainPurchase.canAct}
          blockedReason={trainPurchase.blockedReason}
          onBuyFromBank={trainPurchase.onBuyFromBank}
          onEmergencyPurchase={trainPurchase.onEmergencyPurchase}
          emergencyAvailable={trainPurchase.emergencyAvailable}
          onProposeTrade={trainPurchase.onProposeTrade}
          labelForAddress={trainPurchase.labelForAddress}
          /* Design note #785: still `condensed` when the BAR is condensed. The panel is no longer inside the
             sticky element, but the two are read together and a bar that has shed its prose beside a panel
             that has not would look like a rendering fault rather than a density choice. */
          condensed={condensed}
        />
      )}
      </div>

    </div>

    {/* Contextual trays -- design note #31. Panels, not bar content: a train marketplace, a private-company
       purchase tray with a price slider, and the route-point readout. Each is narrowly conditional, so most of
       the time none renders and the bar above is the entire control surface. */}
      {/* Phase 4's marketplace selection tray -- design note #10/item 2. `BuyHardwareFromPool` has no per-model
         parameter yet (see `MOCK_TRAIN_CATALOG`'s doc comment), so selecting a card only changes which model is
         highlighted; the purchase still targets whichever unit the pool auto-assigns. */}
      {/* Design note #490: THE CONSEQUENCE BELONGS TO THE BUTTON. This block sat OUTSIDE the bar's root `<div>`
         as a sibling, so a bordered card appeared under the bar when the sub-phase changed -- the player read
         the payout in one panel and clicked the button that caused it in another, with a border between the
         cause and the effect. #188's content was right and is kept verbatim; only its address changed.
         NOT RENDERED WHEN CONDENSED: a payout table is read while deciding, not while scrolling a map, and two
         columns of figures would cost the board more height than any other state of this panel. */}
      {/* Design note #203: THE HARDWARE TRAY MOVED OUT OF THE BAR. #182 correctly reduced a six-card selector to
         the ONE train 1830's cheapest-first depot will sell. What it could not fix from inside the bar is that
         the depot was only half the step -- a corporation in Hardware can buy from the bank OR from another
         corporation, and the second half lived in a separate panel further down the page.
         Both halves are now `TrainPurchasePanel`. The bar keeps only "End Turn", the one thing here that is a
         button rather than a panel. */}
      {/* Design note #165: THE INLINE BUY-PRIVATE TRAY IS GONE. A select, a slider and a Buy button modelled the
         purchase as a UNILATERAL act -- and in 1830 that transaction needs the owner's agreement, which a slider
         you drag past somebody else's property does not represent.
         `ProposePrivatePurchase` replaces it, with a TYPED price: the legal band is 50-200% of face value, so a
         $100 private has a 51-value range and a slider makes an exact figure fiddly.
         The tray also sat under HARDWARE, which is wrong -- `trading.rs`'s own sub-phase gate puts private
         purchase FIRST in the turn, before track. */}
      {/* Design note #266: THE RUN ROUTES STEP IS ONE PANEL NOW -- the mode toggle from the right rail, the run
         button from the centre column and the waypoint readout from here all moved into `RoutePlannerPanel`.
         It renders on the whole `Routes` sub-phase rather than only while route mode is engaged: the old panel
         was gated on `routeSelectMode`, which forced the toggle that turns route mode ON to live elsewhere by
         necessity -- a control cannot switch on the panel it is inside. */}
      {/* ==================================================================
           DESIGN NOTE 785: THE BAR UNPINNED ITSELF, AND IT WAS RIGHT TO
          ==================================================================

          REPORTED across two rounds of playtesting: "buy trains is not sticky and does not travel: it is
          fixed at the top of the screen", and the same of Buy Private.

          NOT A CSS FAILURE. `styles.actionBar` declares `position: sticky` correctly, and no ancestor sets an
          `overflow` -- I checked the whole chain, `html` and `body` included. What happens is #720 doing its
          job: `canPinWithoutTrapping` unpins the bar the moment it exceeds half the usable viewport, because
          a sticky element taller than that traps the page behind it. `actionBarUnpinned` sets
          `position: static`, and a static bar sits where it is written and scrolls away.

          THE EVIDENCE WAS IN WHICH PANELS WERE REPORTED. `PrivatePowerPanel` and `RoutePlannerPanel` have
          always rendered out here, past the bar's closing tag, and neither was ever reported as broken. The
          two that were are precisely the two that lived INSIDE the sticky element and pushed it past the
          budget.

          SO THE FIX IS THE PLAYER'S OWN SUGGESTION: "at least Action bar with the corporation card should be
          sticky". The bar keeps the identity row and the controls -- short, fixed height, never near 50% --
          and the tall step panels become ordinary blocks beneath it, which is what the other two already
          were. Nothing is hidden and nothing needs a jump button, because the pinned half no longer
          disqualifies itself.

          WHAT THIS DOES NOT DO is make a long depot table reachable without scrolling. That is the honest
          trade #720 identified and twice refused to solve with an inner scrollbar (#13/item 1 removed one;
          #655 found a `maxHeight` on this very bar was "the bug it warned about"). A player scrolls the page;
          the controls stay with them. */}
      {/* Design note #792: ONE WRAPPER, so the bar's jump button has a single destination whichever step is
          live. Both panels are mutually exclusive by sub-phase, so this holds exactly one at a time. */}
      {/* Design note #813: the probe, OUTSIDE both measured elements -- see the hook for why that matters. */}
      {stickyFitProbe && (
        <div style={styles.fitProbe} title="Temporary instrument (design note #813): what the sticky bar would measure with this step's panel inside it, judged by the same rule that unpins it.">
          {stickyFitProbe}
        </div>
      )}

      {/* Design note #0 in `PrivatePowerPanel.tsx`: the abilities, gated on
          ownership and on the round they may be used in. Renders nothing
          outside sandbox, and nothing when the viewer owns none. */}
      <PrivatePowerPanel
        privateCompanies={privateCompanies}
        viewerAddress={privatePowerViewer}
        roundType={roundType}
        orSubPhase={roundType === "OperatingRound" ? orSubPhase : null}
        sandbox={sandboxMode}
        /* Design note #441: a corporate power belongs to the corporation OPERATING and is executed by whoever
           holds its controls. The bar already resolves both, so the panel is handed the same answers the rest of
           the bar is gated on rather than deriving a second set. */
        actingProtocolId={activeCorporation?.companyId ?? null}
        actingPresident={activeCorporation?.presidentAddress ?? null}
        usedAbilities={usedPrivateAbilities}
        // Design note #725: the D&H's station stays greyed, with its reason, until its lay resolves.
        blockedActions={privateActionBlocks}
        abilityError={privateAbilityError}
        onUseAbility={onUsePrivateAbility}
        controlsEnabled={sessionReady}
      />
      {/* ==================================================================
           DESIGN NOTE 802: THE PLANNER PANEL IS GONE; THE CHIP CARRIES THE ROUTE
          ==================================================================

          REQUESTED twice: "the Run Routes fixed subpanel can be completely done away with in exchange for the
          ability to click the train chips and have the sticky Action bar expand slightly to list its route."

          AND IT ANSWERS THE BUG BESIDE IT. "The train chips with their respective revenue values are still
          not displaying on other players' Action bars" -- #787 tried to fix that by showing the whole panel
          to watchers, which widened the audience for a surface that should not have been that size. The
          figures a watcher wants are one train's, on demand. So are the acting player's.

          THE CONTROLS SPLIT BY WHAT THEY ACT ON, which is the arrangement asked for: "Auto Route and Run in
          the sticky bar beside the chips. Clear in the expanded chip panel?" Auto Route and Run are TURN
          actions and were already in the button row (#623); Clear is a TRAIN action and travels with the
          train it clears.

          WHAT IS LOST WITH THE PANEL, stated rather than glossed: the all-trains-at-once view. A president
          with three drafted routes now reads them one chip at a time. That is the trade the request makes
          explicitly -- "players can click through each one to see what it's doing" -- and the running total
          they used to get from the panel's footer is the figure the Dividends step opens with anyway. */}
      {showRouteReadout && (
        <RouteChipDetail
          draft={openDraft}
          canClear={mayActThisTurn && sessionReady}
          onClearRoute={onClearRoute}
          onClose={() => setOpenTrainIndex(null)}
          /* #802: the panel's click feedback had nowhere else to go. A refused draft explaining itself here
             beats it explaining itself nowhere, which is what deleting the panel would otherwise have done. */
          feedback={mayActThisTurn ? routeFeedback : null}
        />
      )}
      {!sessionReady && (
        <span style={styles.sidebarHint}>Initialize the session key above to enable these actions.</span>
      )}
    </>
  );
}

/** Design note #47: the credit's hover/focus states, which inline styles
 *  cannot reach. Kept next to the tab bar's own escape hatch so this file
 *  has one place where raw CSS lives rather than several. */
