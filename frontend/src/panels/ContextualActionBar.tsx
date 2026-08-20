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
import PrivatePowerPanel, {
  type PrivateAbility,
  type PrivateAbilityAction,
} from "../components/PrivatePowerPanel";
// Design note #623: `RunRoutesButton` joins them -- the step's finishing
// action belongs on the bar that follows the player down the page.
import { RoutePlannerPanel, AutoRouteButton, RunRoutesButton } from "../components/RoutePlannerPanel";
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
  marketZoneForPrice,
  marketZoneTextColor,
  marketZoneTooltip,
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
import { shouldCondenseSticky, stickyTopOffset } from "../utils/stickyCollapse";
import type { DepotTier } from "../utils/gamePhase";
import { dividendDeclaration, marketMoveDirection } from "../utils/dividendStep";
// Design note #494: the per-train route ink, so the collapsed chips match
// the lines on the map.
import { routeTrainColor } from "../styles/routeLivery";
import { styles, PHASE_TINT_STYLES } from "../styles/appStyles";

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




/* Design note #197: THE MARKET MOVE LINE. "Market move: to $82" stated the destination and hid the
   departure -- the one comparison the dividend decision turns on. It reads `$76 -> $82` now.
   Each price is tinted with its own zone's ink and carries that zone's rule as a tooltip: a player
   reading this panel is looking at a NUMBER, not the chart, so stepping into the Yellow zone was
   invisible exactly when it mattered. `marketZoneForPrice` is the same lookup the chart colours itself
   from, so the panel and the board cannot disagree (see #196 for why the flat ink is a separate export).
   The two prices are tinted INDEPENDENTLY -- the interesting case is the one where they differ. */
function ZonedPrice({ price }: { price: number | null }) {
  if (price === null) return <>--</>;
  const zone = marketZoneForPrice(price);
  const color = marketZoneTextColor(zone);
  const tooltip = marketZoneTooltip(zone);
  return (
    <span
      style={color ? { color, fontWeight: 700, cursor: "help" } : undefined}
      title={tooltip ?? undefined}
    >
      ${price}
    </span>
  );
}

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
function useCondensedWhenPinned(): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [condensed, setCondensed] = React.useState(false);

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
      const distanceToPin = node.getBoundingClientRect().top - stickyTop;
      setCondensed((was) => shouldCondenseSticky(distanceToPin, was));
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
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return [ref, condensed];
}


export default function ContextualActionBar({
  roundType,
  orSubPhase,
  sessionReady,
  onPassTurn,
  passDisabledReason,
  onPlaceStationTokenHint,
  stationTokenCost,
  activeCorporation,
  tokenTargetMode,
  setTokenTargetMode,
  onSkipSubPhase,
  orSequence = null,
  trainPurchase = null,
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
  /** Design note #31: why passing is currently illegal, or `null`. The
   *  waterfall forbids it while no private holds a standing bid
   *  (`waterfall.rs` doc comment #1) -- a fact only the caller has. */
  passDisabledReason: string | null;
  onPlaceStationTokenHint: () => void;
  /** Design note #181: what a token costs this corporation, for the button
   *  label. A number rather than a formatted string so the caller cannot
   *  quietly change the currency here. */
  stationTokenCost: number;
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
    /** Design note #326: the president's personal cash, for the tooltip. */
    presidentCash: number | null;
    treasury: number;
    /** Design note #237: the whole allowance, one entry per token, with its
     *  own escalating price. Replaces the `stationsLeft`/`stationLimit`
     *  pair, which could only express a fraction. */
    stationSlots: readonly StationTokenSlot[];
    trains: readonly string[];
  } | null;
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
  dividendPayouts: ReadonlyArray<{ holder: string; percentage: number; amount: number }>;
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
  const [actionBarRef, condensed] = useCondensedWhenPinned();

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
        contextualButtons = [
        ];
        break;
      case "BuyPrivate":
        // Design note #144: Phase 3+ only, and FIRST in the turn. The
        // contract starts the cursor at `Track` before Phase 3, so this case
        // is unreachable in the Yellow era rather than showing a dead button.
        contextualButtons = [
          {
            key: "buy-private",
            label: "Buy Private Company",
            onClick: onOpenPrivateTrade,
            title: "Select a private company below to purchase it into this corporation's treasury.",
          },
        ];
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
                : "This corporation earned nothing this turn. 1830 has no $0 dividend — the revenue is withheld and the share price moves one step left.",
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
  const showRouteToggle = roundType === "OperatingRound" && orSubPhase === "Routes";

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
     inverted: 1830 requires a declaration every turn. Skip remains correct on Track, Tokens and Routes. */
  const dividendChoiceForced =
    roundType === "OperatingRound" && orSubPhase === "Dividends";

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
      {/* Design note #518: THE TRAIL, WHEN THERE IS ROOM FOR IT. This restores what #481 removed, and the
         reason it is not a reversal is the CONDITION: #481's argument was about the PINNED form (a pinned bar
         must earn every row) and was applied to both.
         So the two forms split. The expanded panel shows the whole trail, which answers "what is still to
         come"; the pinned form keeps #481's phrase, which answers "where am I" in three words. Neither state
         gains a row it was not already spending.
         THE COUNTER GOES WITH THE TRAIL -- "4/6" beside six visible boxes is two renderings of one position.
         The compact form keeps it, because there it is the only thing carrying the position. */}
      {roundType === "OperatingRound" && orSubPhaseProgress && (
        condensed ? (
          <span
            style={styles.actionBarSubPhaseInline}
            title={`Step ${orSubPhaseProgress.position} of ${orSubPhaseProgress.total} in this corporation's turn.`}
          >
            {orSubPhaseProgress.label}
            <span style={styles.actionBarSubPhaseCount}>
              {" "}
              {orSubPhaseProgress.position}/{orSubPhaseProgress.total}
            </span>
          </span>
        ) : (
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
        )
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
                      size={24}
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
                 column: the president had shared a line and a column gave it one of its own. It belongs beside the full
                 NAME -- both are identity detail read second ("the Pennsylvania Railroad, Ada presiding" is one
                 thought), while the herald and acronym above are the label you read first. */}
              {(activeCorporation?.fullName || activeCorporation?.presidentLabel) && (
                <span style={styles.orContextSubRow}>
                  {activeCorporation?.fullName && (
                    <span style={{ ...styles.orContextName, color: corporationBarInk.inkMuted }}>
                      {activeCorporation.fullName}
                    </span>
                  )}
                  {activeCorporation?.presidentLabel && (
                <span
                  style={{
                    ...styles.orContextPresident,
                    color: corporationBarInk.inkMuted,
                    ...(activeCorporation.presidentCash !== null
                      ? { cursor: "help", textDecoration: "underline dotted 1px" }
                      : {}),
                  }}
                  /* Design note #326: THE PERSONAL PURSE, ON THE PERSON. Where #325's figure went -- attached to the
                     president's NAME, so a number beside a crown is a fact about that human, where the same number in the
                     rail below was a fact about "the acting turn", which in an Operating Round means the company.
                     A tooltip rather than visible text because it is reference: it answers "can they cover the emergency
                     buy" when asked. The dotted underline is what makes it discoverable -- an unmarked tooltip is one
                     nobody hovers. */
                  title={
                    activeCorporation.presidentCash !== null
                      ? `President's Personal Treasury: $${activeCorporation.presidentCash}`
                      : undefined
                  }
                >
                  {/* Design note #552: our own crown, not U+1F451 -- the
                      same drawing every other surface uses. */}
                  <PresidentCrown scale={0.95} style={{ marginRight: "3px" }} />
                  {activeCorporation.presidentLabel}
                </span>
                  )}
                </span>
              )}
            </span>

            {activeCorporation && (
              <span style={styles.orContextFacts}>
                <span style={styles.orContextFact} title="Everything this corporation can spend this turn.">
                  <span style={{ ...styles.orContextFactLabel, color: corporationBarInk.inkMuted }}>
                    Treasury
                  </span>
                  <span style={{ ...styles.orContextFactValue, color: corporationBarInk.ink }}>
                    ${activeCorporation.treasury}
                  </span>
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
                   So the condensed card keeps the PIECES and drops the LIMIT. */}
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
                    />
                  )}
                  {/* Design note #248: the limit, beside the fleet it caps. The chips say WHICH trains; this says how much
                     room is left, which decides whether the Buy Trains step has anything in it. Amber at the ceiling.
                     Design note #372: dropped when pinned -- the one figure here a president cannot act on, since the Buy
                     Trains step enforces it on its own. (Restored by #590, which found the space was never scarce.) */}
                  {!condensed && phase?.trainLimit !== undefined && (
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
              {mayActThisTurn && contextualButtons.length === 0 && orSubPhase === "Track" && (
                <span style={styles.orPanelNoActions}>
                  Select a hex on the map to lay or upgrade track. Click the preview to rotate.
                </span>
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
              {mayActThisTurn && orSubPhase !== "Hardware" && !dividendChoiceForced && (
                <button
                  type="button"
                  style={{ ...styles.actionBarButton, ...styles.actionBarUtilityButton }}
                  onClick={onSkipSubPhase}
                  disabled={!sessionReady}
                  title={`Move past ${OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} without acting. Dispatches AdvanceOperatingSubPhase — the contract moves its own cursor one step.`}
                >
                  Skip {OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel} &#8250;
                </button>
              )}
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
          {orSubPhase === "Routes" && condensed && trainDrafts.length > 0 && (
            <div style={styles.condensedTrainRow} role="group" aria-label="Drafted routes">
              {trainDrafts.map((draft) => {
                const isActive = draft.trainIndex === activeTrainIndex;
                return (
                  <button
                    key={draft.trainIndex}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => onSelectRouteTrain(draft.trainIndex)}
                    onMouseEnter={() => onHighlightRoute?.(draft.trainIndex)}
                    onMouseLeave={() => onHighlightRoute?.(null)}
                    disabled={!sessionReady}
                    style={{
                      ...styles.condensedTrainChip,
                      ...(isActive ? styles.condensedTrainChipActive : {}),
                      // Design note #494: the route's own ink, so the chip and
                      // the line on the map are the same colour.
                      borderBottomColor: routeTrainColor(draft.trainIndex),
                    }}
                    title={
                      draft.value === null
                        ? `${draft.model}-train has no route drafted yet. Click to draft for it, then click hexes on the map.`
                        : `${draft.model}-train runs for $${draft.value}. Click to draft for it.`
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
            </div>
          )}
          {/* Design note #509: THE DECISION TRAVELS WITH THE BUTTONS. #490 gated this on `!condensed`, reasoning
             from #298's rule -- and this was the wrong side of it: the payout table and the two market moves are
             not orientation, they are the INPUTS to the two buttons directly above them. Hiding them when pinned
             left a scrolled player with Pay and Withhold live and no way to see what either does.
             The Buy Trains panel travels for the same reason and by the same mechanism: the bar is `position:
             sticky`, so anything inside it follows. */}
          {orSubPhase === "Dividends" && (
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
                  dividendPayouts.map((row) => (
                    <span key={row.holder} style={styles.dividendRow}>
                      <span>{row.holder}</span>
                      <span style={styles.dividendAmount}>
                        ${row.amount} <span style={styles.dividendPct}>({row.percentage}%)</span>
                      </span>
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
          {orSubPhase === "Hardware" && mustBuyTrain && (
            <div style={styles.mustBuyTrainNotice} role="status">
              This corporation owns no train and has a route to run — it must buy one before the
              turn can end. If the treasury cannot cover the cheapest train, the president pays
              the difference personally.
            </div>
          )}
          {orSubPhase === "Hardware" && trainPurchase && (
            <TrainPurchasePanel
              depot={trainPurchase.depot}
              buyer={trainPurchase.buyer}
              companies={trainPurchase.companies}
              sessionReady={sessionReady}
              canAct={trainPurchase.canAct}
              blockedReason={trainPurchase.blockedReason}
              onBuyFromBank={trainPurchase.onBuyFromBank}
              onProposeTrade={trainPurchase.onProposeTrade}
              labelForAddress={trainPurchase.labelForAddress}
              condensed={condensed}
            />
          )}
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
            title={passDisabledReason ?? "Pass / skip your turn."}
          >
            Pass Turn
          </button>
          {/* Design note #540: A DIVIDER NEEDS SOMETHING ON BOTH SIDES. Reported as two bars between Pass Turn and
             Undo -- these two, with nothing between them. The pair frames `contextualButtons`, which is EMPTY in
             several real states: an auction round, a Stock Round with no corporation selected, and a room whose game
             has not been dealt. A rule divides things, and there was nothing to divide.
             Gated on the group they frame rather than on any particular round, so every empty case is covered. */}
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
        abilityError={privateAbilityError}
        onUseAbility={onUsePrivateAbility}
        controlsEnabled={sessionReady}
      />
      {showRouteToggle && (
        <RoutePlannerPanel
          drafts={trainDrafts}
          activeTrainIndex={trainDrafts.length === 0 ? null : activeTrainIndex}
          // Design note #9 there: transient, and NOT the active train.
          highlightedTrainIndex={highlightedRouteIndex}
          onHighlightTrain={onHighlightRoute}
          onSelectTrain={onSelectRouteTrain}
          onClearRoute={onClearRoute}
          onRunRoute={onRunTrains}
          ownsAnyTrain={ownsAnyTrain}
          controlsEnabled={sessionReady}
          noTrainReason={NO_TRAIN_ROUTE_REASON}
          clickFeedback={routeFeedback}
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
