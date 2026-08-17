// frontend/src/panels/ContextualActionBar.tsx
//
// THE CONTEXTUAL TOP ACTION BAR -- the strip that swaps its controls to match
// the live round type and Operating Round sub-phase. Moved out of `App.tsx`
// unchanged.
//
// At 1,440 lines this was the single largest extractable block in that file,
// and it is the clearest case for a `panels/` directory rather than
// `components/`: this is not a reusable widget but one named region of the
// game screen, assembled from widgets that DO live in `components/`. The
// distinction is worth a directory, because it tells the next reader which
// files they may freely reuse and which are one-of-a-kind surfaces.
//
// WHAT TRAVELLED WITH IT, and why each one belongs here rather than in a
// shared module:
//
//   `ActionBarButton`       the shape of one button in this bar; nothing else
//                           constructs one.
//   `useCondensedOnScroll`  exists solely to collapse THIS bar when the page
//                           scrolls (design note #268 in `App.tsx`).
//   `ZonedPrice`            renders one market price with its zone tint; used
//                           only by `MarketMoveLine`.
//   `MarketMoveLine`        the dividend projection line, used only by this
//                           bar.
//
// Each had exactly one consumer, and that consumer is in this file. Leaving
// any of them behind would have meant `App.tsx` exporting a helper solely so
// this panel could import it back -- the shape that makes a monolith
// structural rather than incidental.
//
// NOTHING ELSE CHANGED. Same props, same order, same branches, same comments.

import React from "react";

import { TrainChips } from "../components/TrainBadges";
import { StickyTickerLine } from "../components/TopTicker";
import type { FeedItem } from "../utils/feed";
import PrivatePowerPanel, {
  type PrivateAbility,
  type PrivateAbilityAction,
} from "../components/PrivatePowerPanel";
import { RoutePlannerPanel, AutoRouteButton } from "../components/RoutePlannerPanel";
import type { TrainRouteDraft } from "../components/RoutePlannerPanel";
import StationTokenRow from "../components/StationTokenRow";
import {
  /* Design note #481: `OperatingSubPhaseStepper` itself is no longer
     imported. The strip it renders became an inline phrase here; the
     component is left in place rather than deleted because it is a correct,
     self-contained rendering of the turn sequence and the rules reference is
     the natural home for one. `visibleSubPhases` is what this file needs
     from it now -- the same era/privates filtering the strip did, so the
     count beside the title is "2 of 5" in the Yellow era and "2 of 6" from
     Phase 3, rather than a fixed six. */
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
// Design note #410: shared with the Stock Card stripe.
import { CorporateLogo } from "../components/CorporateLogo";
import { NO_TRAIN_ROUTE_REASON } from "../utils/gameConstants";
import { shouldCondenseSticky, stickyTopOffset } from "../utils/stickyCollapse";
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




/* ===================================================================
 *  DESIGN NOTE 197: THE MARKET MOVE LINE
 * ===================================================================
 *
 * Two changes, and the second is a rules affordance rather than styling.
 *
 * FORMAT. It read "Market move: ↗ to $82", which states the destination and
 * hides the departure -- the one comparison the dividend decision turns on.
 * It now reads "Market move: $76 ⬆ $82": both prices, the arrow between
 * them, in the direction the token travels.
 *
 * COLOUR AND TOOLTIP. A price that lands in a Yellow, Orange or Brown cell
 * carries real rule consequences -- certificate-limit exemption, the 60%
 * ownership cap, multi-share bank-pool buys -- and the chart has always
 * shown that by tinting the cell. A player reading this panel is looking at
 * a NUMBER, not at the chart, so the fact was invisible exactly when it
 * mattered: paying out to step from a Normal cell into the Yellow zone is a
 * different decision from stepping to any other cell, and nothing said so.
 *
 * Each price is therefore tinted with its own zone's ink and carries that
 * zone's rule as a tooltip. `marketZoneForPrice` is the same lookup the
 * chart colours itself from, so this panel and the board can never disagree
 * about which prices are Brown -- see design note #196 for why the flat text
 * ink is a separate export from the cell gradient.
 *
 * THE TWO PRICES ARE TINTED INDEPENDENTLY, which is the whole point: the
 * interesting case is precisely the one where they differ.
 */
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
  /* ================================================================
   *  DESIGN NOTE 214: THE ARROW CARRIES THE MEANING
   * ================================================================
   *
   * (Superseded in its GLYPH choice by design note #489 below; the colour
   * argument it makes is unchanged and still the reason the arrow is tinted
   * at all.)
   *
   * The arrows were a vertical pair -- U+2B06 UP and U+2B07 DOWN -- in the
   * same neutral grey as the surrounding text. Two problems, and the second
   * is the one that mattered.
   *
   * DIRECTIONALITY. 1830's chart moves a token ALONG ITS ROW: paying out
   * steps right, withholding steps left. A purely vertical arrow describes
   * neither of those, and on a chart where vertical movement is what
   * SELLING does, an up arrow is actively the wrong gesture. The diagonals
   * (U+2197 up-right, U+2198 down-right) read as "onward and better" versus
   * "onward and worse", which is what the two choices actually are.
   *
   * COLOUR. Both arrows were grey, so at a glance the two columns of this
   * panel looked identical and the player had to read the prices to tell
   * which was which. Green for the rise and red for the fall is the one
   * colour convention every player already has, and it lets the choice be
   * made peripherally.
   *
   * THE PRICES KEEP THEIR OWN COLOURS. Design note #197 tints each price by
   * its market ZONE -- a rules fact -- and that must not be overwritten by
   * the direction, which is a different fact about a different thing. So the
   * arrow is the only glyph the direction colours, and it is deliberately
   * heavier than the text around it so it wins the glance without needing
   * the prices to shout.
   *
   * ================================================================
   *  DESIGN NOTE 489: THE MONEY MOVED, NOT THE CARDBOARD
   * ================================================================
   *
   * REPORTED: the diagonal arrows are confusing. Use a plain
   * `[old] -> [new]`, green for an increase and red for a decrease,
   * ignoring the physical grid direction.
   *
   * #214 chose diagonals to describe the token's TRAVEL on the chart, and
   * that is the thing this line was never actually about. A player reading
   * a payout panel is deciding between two amounts of money. The chart's
   * geometry -- rightward along a row, leftward on a withhold -- is how the
   * board implements that consequence, not the consequence itself, and
   * spending a glyph on it made the reader translate a direction into a
   * value every time.
   *
   * SO THE ARROW IS STRAIGHT (U+2794) and says only "becomes". The
   * comparison it used to carry moves into the colour, where it is read
   * without being decoded.
   *
   * AND THE COLOUR IS COMPUTED FROM THE PRICES, which is the part that
   * fixes a real bug rather than restyling one. `rising` was
   * `direction === "pay"` -- an assumption that paying out always raises
   * the price. It does not at the RIGHT-HAND END OF A ROW, where the token
   * cannot advance: `projection.moves` is false, `projection.price` equals
   * `currentPrice`, and the old line rendered a confident green up-arrow
   * between two identical numbers. Same in mirror image for a withhold at
   * the left edge. Comparing the two numbers cannot produce that, because
   * the numbers are what the player is being asked about.
   *
   * FLAT IS ITS OWN CASE, neither green nor red. A ceiling is not a gain,
   * and colouring it as one is the misreport this note exists to remove. */
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
      {/* The edge of the chart. Both prices and the arrow are still there
          and simply equal, with the reason appended -- a line reading
          "$100 ➔ $100" with no explanation looks like a bug rather than a
          ceiling. Which edge is a fact about the TOKEN's travel, so this is
          the one place `direction` is still the right thing to read: at a
          flat move the prices cannot say which end of the row was hit. */}
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

/* ==================================================================
 *  DESIGN NOTE 298: WHAT A PINNED BAR IS ALLOWED TO KEEP
 * ==================================================================
 *
 * A sticky bar costs the map its height for the whole scroll, so the
 * pinned form has to earn every row it occupies. The rule applied is: keep
 * what a player needs WHILE LOOKING AT THE BOARD, drop what they only need
 * when deciding what to do next.
 *
 *   KEPT   the phase badge, the acting corporation, its treasury and train
 *          limit, and every action button. These are the inputs to "can I
 *          click that hex", which is the question being asked while the map
 *          is on screen.
 *   DROPPED the station-token row, the president's name, the train chips
 *          and the sub-phase stepper. All are orientation -- they answer
 *          "where am I in the turn", which the player has already answered
 *          by the time they are scrolling the map.
 *
 * The stepper is the one worth defending: it is a progress indicator, and a
 * progress indicator that is always visible stops being read. It comes back
 * the moment the bar unsticks.
 */
/* ==================================================================
 *  DESIGN NOTE 480 (cont.): MEASURE THE PANEL, NOT THE PAGE
 * ==================================================================
 *
 * This used to be `window.scrollY > 24` -- see `utils/stickyCollapse.ts`
 * for why that collapsed the bar while it was still sitting in the middle
 * of the viewport with nothing to gain by it.
 *
 * The hook now hands back a ref as well as the flag, because the question
 * it answers is about a specific element and cannot be answered without
 * one. Both of this component's root branches attach it; only one is ever
 * mounted, so there is no contention.
 *
 * THE rAF IS KEPT and matters more than it did. The old body read one
 * number off `window`; this one calls `getBoundingClientRect`, which forces
 * layout. Doing that on every pixel of a wheel gesture is the difference
 * between a cheap scroll handler and a janky one, so the read is coalesced
 * to at most one per frame.
 *
 * `resize` IS LISTENED TO ALONGSIDE `scroll`, because a window resize can
 * reflow everything above the panel and move its pin line without the
 * scroll position changing by a pixel. The sticky offset is re-read then
 * too -- a media query is entitled to change it. */
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
  onOpenPrivateTrade,
  ownsAnyTrain,
  mustBuyTrain,
  activePlayerName,
  activePlayerCash,
  activePlayerEscrow,
  playerRoster,
  privateCompanies,
  privatePowerViewer,
  sandboxMode,
  usedPrivateAbilities,
  onUsePrivateAbility,
  onRunTrains,
  onPayDividends,
  onWithholdRevenue,
  onJumpToTrainPurchase,
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
  latestFeedItem = null,
  onOpenActivityLog,
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
  /** Design note #144: dispatches the real `AdvanceOperatingSubPhase`
   *  message. Every skip is now an on-chain, replayable event -- the old
   *  client-only `setOrSubPhase` calls advanced the UI while the contract's
   *  cursor stayed put, which under G-14 enforcement would have desynced the
   *  bar from what the chain would actually accept. */
  onSkipSubPhase: () => void;
  /** Opens the propose-purchase sheet -- design note #165. */
  onOpenPrivateTrade: () => void;
  /** Drives the Routes skip button's disabled state -- see its `title`. */
  ownsAnyTrain: boolean;
  /** Design note #293b: the corporation's roster is REPORTED and EMPTY, so
   *  1830's mandatory purchase applies. Distinct from `!ownsAnyTrain`,
   *  which is also true when the chain simply did not say. */
  mustBuyTrain: boolean;
  /* ==================================================================
   *  DESIGN NOTE 300: THE PLAYER'S OWN MONEY WAS NOWHERE ON THIS PANEL
   * ==================================================================
   *
   * The bar reports the CORPORATION's treasury, which is what pays for
   * track, tokens and trains -- and says nothing about the player's own
   * cash, which is what pays for shares, private companies, and the
   * president's emergency train purchase this app now enforces (design
   * note #293).
   *
   * Those are different pockets and both are spent from this screen. A
   * president told "you must buy a train" with no way to see whether they
   * can personally cover it is being asked a question the UI is refusing
   * to answer.
   *
   * It stays in the CONDENSED form too. Design note #298's rule is "keep
   * what a player needs while looking at the board" -- and whether they can
   * afford the thing they are about to click is exactly that. */
  activePlayerName: string | null;
  /** Design note #317: AVAILABLE cash during the auction, total otherwise. */
  activePlayerCash: number | null;
  /** How much of their money is standing on bids. `0` outside the auction. */
  activePlayerEscrow: number;
  /** Design note #342: every seat, in order, with its spendable cash.
   *  Empty falls back to the single acting-player badge. */
  playerRoster: ReadonlyArray<{
    address: string;
    label: string;
    available: number;
    escrowed: number;
    isActive: boolean;
  }>;
  /** Design note #0 in `PrivatePowerPanel.tsx`. */
  privateCompanies: readonly PrivateCompanyState[];
  privatePowerViewer: string | null;
  sandboxMode: boolean;
  /** Design note #442: keyed by ACTION, not by private id -- the D&H's
   *  two powers are spent independently. */
  usedPrivateAbilities: ReadonlySet<string>;
  onUsePrivateAbility: (ability: PrivateAbility, action: PrivateAbilityAction) => void;
  onRunTrains: () => void;
  onPayDividends: () => void;
  onWithholdRevenue: () => void;
  /** Design note #491: scroll the Buy Trains panels into view. Navigation
   *  only -- it dispatches nothing and buys nothing. Optional, so a caller
   *  with no such panel on screen simply omits it and the button does not
   *  render rather than appearing and scrolling to nowhere. */
  onJumpToTrainPurchase?: () => void;
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
  /** Design note #458: the newest activity-log line, kept visible while the
   *  page scrolls. `null` renders nothing. */
  latestFeedItem?: FeedItem | null;
  /** Scrolls the player back to the full ticker. */
  onOpenActivityLog?: () => void;
  /** Derived phase (`utils/gamePhase.ts`) for the far-right badge -- see
   *  design note #40 for why it moved here from the header. */
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
    const steps = visibleSubPhases(currentGlobalEra, privateCompanies);
    const index = steps.indexOf(orSubPhase);
    if (index < 0) return null;
    return {
      label: OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel,
      position: index + 1,
      total: steps.length,
    };
  }, [currentGlobalEra, privateCompanies, orSubPhase]);

  /* Design note #236: the acting corporation's own colours, resolved once.
   *
   * `bestContrastTextColor` is the same per-fill choice the map's station
   * tokens make for their acronyms, so this bar and the tokens it describes
   * agree about what is legible on that brand colour -- rather than this
   * asserting white and being wrong on C&O's orange.
   *
   * SECONDARY TEXT IS THE SAME INK AT REDUCED ALPHA, never a fixed grey. A
   * grey that reads as "quieter" on PRR's dark red is nearly invisible on
   * C&O's orange; alpha over the actual background holds its relationship to
   * whatever is behind it.
   *
   * NO CORPORATION -> the neutral dark this bar always had. That state is
   * reachable before the first `GetGameState` resolves, and colouring it
   * from `stationTickerColor(0)`'s fallback grey would dress an empty bar as
   * though a company were acting. */
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

  // Round-type-specific buttons -- see design note #8 for exactly which
  // real ExecuteMsg each one dispatches, and why "Place Station Token" is
  // deliberately non-dispatching. Design note #10/item 2: within an
  // Operating Round, the button set ALSO swaps per `orSubPhase`, walking the
  // player through a corporation's turn in the real 1830 legal order --
  // Track -> Tokens -> Dividends -> Hardware -- one step at a time, rather
  // than exposing every OR action at once regardless of where the
  // corporation actually is in its turn.
  /* Design note #390: `null` when the player is where the action is, or is
     on a reference tab. `onSelectTab` is part of the condition because a
     redirect button with nothing to dispatch is a dead end, not a fix. */
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

  /* ==================================================================
   *  DESIGN NOTE 485a: ONE REVENUE FIGURE, FOUR SURFACES
   * ==================================================================
   *
   * What this turn's declaration is actually worth. `dividendRevenue` is
   * the corporation's `last_route_revenue`, which is a PREVIOUS turn's
   * figure for a corporation that skipped Routes -- design note #278
   * established that and used it to hide the Pay button, then left the
   * number itself in circulation.
   *
   * Four surfaces quote it: the Pay label, the Pay tooltip, the Withhold
   * label/tooltip, and the consequence panel's "Pay out $N · $M/share"
   * heading. Three of them were quoting the stale one, so a corporation
   * that ran nothing displayed a payout table for a run that did not
   * happen. Derived once, here, above every reader -- through the same
   * `dividendDeclaration` App uses for the dispatch (design note #486), so
   * the number on the button and the number in the message are one
   * derivation rather than two that agree today. */
  const declaration = dividendDeclaration({
    lastRouteRevenue: dividendRevenue,
    skippedRoutes: !dividendRevenueIsThisTurn,
  });
  const declaredRevenue = declaration.revenue;
  const declaredPerShare = declaration.perShare;

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
        /* Design note #142: its own phase. Running trains is what PRODUCES
           the revenue figure; the dividend decision below is what is done
           with it.

           NO CONTEXTUAL BUTTON -- design note #266. "Run Selected Route"
           used to sit here, in the centre column, ABOVE the panel showing
           the route it would submit and the readout saying whether that
           route was legal. It is now the bottom row of `RoutePlannerPanel`,
           directly under the path it runs and carrying the amount it pays.
           Leaving a copy here would be a second control for one action --
           and the vaguer of the two, since only the panel's copy knows the
           figure. */
        contextualButtons = [];
        break;
      case "Dividends":
        /* ==================================================================
           DESIGN NOTE 414: THERE IS NO SUCH THING AS PAYING $0
          ==================================================================

           REPORTED: a corporation with no earnable revenue is still offered
           "Pay Dividends", quoting $0 per share.

           1830 has no such declaration. A corporation that earned nothing
           withholds -- that is the whole decision, and it is the one that
           steps the share price left. Offering Pay beside Withhold at $0
           presents a binary where the rules have a single outcome, and the
           two buttons do not even differ in effect: paying nothing and
           withholding nothing move the same zero. The only thing the player
           could get wrong is the market move, and Pay gets it wrong
           silently -- the marker stays put, the price never falls, and
           nothing on screen says a rule was skipped.

           So at zero the choice collapses to the one legal action. `App`'s
           forced-withhold effect (design note #414 there) will normally have
           declared it before this renders; this is the same rule expressed
           on the control, so a player who reaches the step during the poll
           interval that precedes the auto-declaration cannot click the
           button that should not exist.

           THE TEST IS THE REVENUE, NOT THE TRAIN. `dividendRevenue` is
           already what the pay button spends and what its per-share figure
           divides, so gating on it cannot disagree with the label beside it
           -- and it covers the stranded-train case, the trainless case and
           the ran-a-worthless-route case without naming any of them. */
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
          // Both ways of acquiring a train live in `TrainPurchasePanel`
          // (design note #203), which is the only place that knows what the
          // depot will sell and which corporations hold what. Duplicating
          // either here as a generic "Buy Train" would be a second control
          // for one action, and the vaguer of the two.
          /* ==================================================================
             DESIGN NOTE 293: A CORPORATION MUST OWN A TRAIN
            ==================================================================

             REPORTED: a corporation with no trains can click End Turn in the
             Buy Trains step without buying one.

             1830 does not let it. A corporation that owns no train MUST buy
             one, and if its treasury cannot cover the cheapest in the depot
             the president pays the difference personally -- the emergency
             purchase. There is no branch of that rule where the turn simply
             ends.

             THE POVERTY CASE IS THE ONE THAT MATTERS, and it is why this is
             not merely disabled when the corporation could afford a train.
             Being unable to pay is precisely when a player wants the exit,
             and precisely when 1830 refuses it: the obligation falls to the
             president rather than lapsing. So the button stays disabled on
             an empty treasury too, and the tooltip names the president's
             purchase rather than implying the step is stuck.

             The gate is "owns a train", not "has bought one this turn" --
             a corporation that acquired one by trade has satisfied the rule
             just as completely. */
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
    // Stock & Auction: Buy/Sell live entirely in `StockRoundPanel`'s own
    // corporation cards, so there is never a duplicate control surface.
    //
    // Design note #29: `onBuyShare`/`onSellShares` are no longer props of
    // this component at all. They were kept in the interface after the
    // controls moved out, unused, "to keep this a minimal-footprint
    // change" -- and then their signature changed to take a company id,
    // and four call sites failed to typecheck for a prop nobody reads.
    // Dead props are not free; they are a type error waiting for the real
    // implementation to move.
    contextualButtons = [];
  }

  /* ==================================================================
   *  DESIGN NOTE 413: THE BAR NOW ASKS WHOSE TURN IT IS
   * ==================================================================
   *
   * REPORTED: during an Operating Round the acting corporation's president
   * is locked out of Lay Tile, while every player who is NOT acting can see
   * and click Skip.
   *
   * Both halves at once, which is what makes it look contradictory and what
   * gives it away: the authorisation was not merely wrong, it was ABSENT
   * from one surface and correct-but-starved on the other.
   *
   *   THE LOCKOUT was `actingSeatIndex` returning `null` because
   *   `active_operating_order` was empty -- see `sandboxSession.ts` design
   *   note #411. "Nobody may act" is the correct reading of an empty queue,
   *   and `tileLayDisabledReason` correctly refused everyone including the
   *   president. Fixed at the source; nothing in this file caused it.
   *
   *   THE SKIP BUTTON is this file's. Every control below was gated on
   *   `sessionReady` alone -- "is there a signing session", not "may this
   *   player act" -- so a bar rendered for a spectator or for the four
   *   players waiting their turn carried live buttons that dispatched real
   *   messages. The chain would refuse them, but only after a signature and
   *   a round trip, and the sandbox has no chain to refuse anything.
   *
   * `isMyTurn` was already computed, already correct, and already passed to
   * this component -- and used for exactly one thing: a decorative pulse on
   * the wrapper (design note #4's turn alert). The predicate the bar needed
   * was sitting in its own props being used as a CSS class.
   *
   * HIDDEN, NOT DISABLED, and that is a departure from how this file treats
   * every other unavailable control. A disabled button with a reason is the
   * right shape when the player COULD act and something specific stops them
   * -- design note #293's End Turn, which explains the train they must buy.
   * It is the wrong shape for "this is not your turn", because there is no
   * action for the player to take, nothing they can change, and eight
   * greyed buttons on four players' screens is an entire panel of noise
   * describing somebody else's decision. The acting corporation is already
   * named across the top of the bar; that is the answer to why the controls
   * are absent, and it is already on screen.
   *
   * SCOPED TO OPERATING ROUNDS, because that is the round whose turn belongs
   * to a corporation rather than a seat, and the round this bar carries
   * action buttons in. The Stock Round and the auction put their controls in
   * their own panels (`contextualButtons` is empty for both), so widening
   * this would gate a set that is already empty while risking the auction's
   * own flow. */
  const mayActThisTurn = roundType !== "OperatingRound" || isMyTurn;
  if (!mayActThisTurn) contextualButtons = [];


  /* ==================================================================
   *  DESIGN NOTE 33: THE ROUTE TOGGLE IS A RUN-TRAINS TOOL, NOT A
   *  GLOBAL ONE
   * ==================================================================
   *
   * `Routes` is this UI's name for the contract's run-trains sub-phase
   * (`OPERATING_SUB_PHASE_LABELS.Routes` renders as "Run Trains", mirroring
   * `or_phase::OR_PHASE_ORDER`). Sketching a route is only meaningful while
   * a corporation is about to run one, so that is the only time the toggle
   * exists now.
   *
   * Design note #11 argued the toggle was "harmless to leave on" outside
   * that phase. It was not, for two reasons that only show up in use:
   *
   *   1. IT SILENTLY DISARMS THE MAP. Leaving route mode on rewires the
   *      Rail Map's click handling -- look at the `queryClient`/
   *      `contractAddress`/`gameId`/`onHexClick` props below, every one of
   *      which is switched to `undefined` while `routeSelectMode` is true.
   *      A player who flipped the switch during Routes, moved to Track next
   *      turn and clicked a hex to lay tile would get a route point and no
   *      tile picker, with nothing on screen explaining why.
   *   2. IT ADVERTISED A CONTROL FOR A PHASE THE PLAYER WAS NOT IN, on the
   *      Auction and Stock Round tabs where there is no train to run at all.
   *
   * Hiding the button alone would have left hazard (1) intact -- the mode
   * would just become unreachable while still ON. So the owning component
   * force-clears `routeSelectMode` whenever this condition goes false; see
   * the `useEffect` next to the `routeSelectMode` state declaration. */
  const showRouteToggle = roundType === "OperatingRound" && orSubPhase === "Routes";

  /* Design note #278: the Dividends step's Pay-or-Withhold binary. Derived
     here rather than passed in, because both halves -- the step and the
     revenue -- are already props, and a second boolean saying what they
     jointly mean is a thing that can disagree with them.

     ==================================================================
      DESIGN NOTE 436: $0 IS A DECISION TOO, AND SKIP IS NOT IT
     ==================================================================

     REPORTED: at $0 route revenue, hide Skip and offer only Withhold.

     `dividendRevenue > 0` used to gate this, and design note #422's own
     text argued for the exception: "IT STAYS AT $0, which is the case the
     rule does not cover. A corporation that ran nothing has no money to
     allocate and no reason to be held on this step; `DeclareDividends` for
     zero is a message with no effect, so Skip is the honest control there."

     The premise is wrong, and design note #414 had already established why
     one step over: a $0 declaration is NOT a message with no effect. It is
     the withhold that steps the share price one cell LEFT, which is the
     single most consequential thing that happens to a corporation that
     could not run. Skip dispatches `AdvanceOperatingSubPhase` -- it moves
     the cursor and settles nothing -- so at $0 the two controls did
     visibly similar things and only one of them obeyed the rules.

     Worse, Skip was the more prominent of the pair by position, so the
     easiest action on the screen was the one that silently omitted a
     mandatory market move. That is how a corporation's price stays put
     through a round it should have fallen in.

     So the step is forced at $0 as well. `App`'s auto-withhold effect
     (design note #414) will usually have declared it before the player
     sees this, and the two agree by construction now rather than by
     coincidence: both treat "nothing was earned" as a decision to make,
     not a step to step past. */
  /* ==================================================================
   *  DESIGN NOTE 485: SKIP IS NEVER A DIVIDEND DECLARATION
   * ==================================================================
   *
   * REPORTED: a corporation landing on Dividends with $0 revenue must not
   * be offered Skip -- only "Withhold $0".
   *
   * `dividendRevenueIsThisTurn` was the third clause, and it is false in
   * precisely the situation the report is about: a corporation that skipped
   * Routes (design note #278 sets it that way so a stale
   * `last_route_revenue` cannot be paid out). So the one corporation
   * guaranteed to have $0 was the one the Skip button was kept alive for.
   *
   * The clause is gone rather than inverted, because there is no state of
   * an Operating Round in which Skip is the right control here. 1830
   * requires a declaration every turn: revenue splits or it is withheld,
   * and $0 withheld is what steps the marker LEFT. `AdvanceOperatingSubPhase`
   * settles nothing and moves no marker, so offering it on this step offers
   * a way to omit a mandatory market move -- which design note #436 already
   * argued for the $0 case without following it to the case where the
   * revenue figure is not this turn's.
   *
   * Skip remains correct on Track, Tokens and Routes, all of which are
   * genuinely declinable. This is the one step that is not. */
  const dividendChoiceForced =
    roundType === "OperatingRound" && orSubPhase === "Dividends";

  /* ==================================================================
   *  DESIGN NOTE 31: ONE BAR, EVERYWHERE
   * ==================================================================
   *
   * This is now the app's ONLY action bar, and it renders on every active
   * tab. Two separate bars existed: this one (chunky, inside the workspace,
   * carrying the operating-round buttons plus Undo) and a slim
   * `GlobalActionBar` added at the top of the phase tab for Pass/Undo. On
   * the phase tab during a Stock Round BOTH rendered, one above the other,
   * with two Undo buttons -- because the phase tab falls through to this
   * component's branch as well.
   *
   * `GlobalActionBar` is deleted. This component absorbed Pass, kept Undo,
   * and was restyled slim, so there is exactly one strip of turn controls
   * no matter which tab is showing.
   *
   * PASS IS PHASE-ROUTED, and this is the part worth not getting wrong:
   * `WaterfallPass` and `PassTurn` are different contract messages, not one
   * action with two names. The caller decides which; this component just
   * renders the button and shows `passDisabledReason` when passing is
   * illegal (the waterfall forbids it while no bid stands anywhere).
   *
   * THE THREE TRAYS BELOW ARE NOT PART OF THE BAR. The hardware
   * marketplace, the Buy Private Company tray and the route-point readout
   * used to sit inside the bar's own container, which is most of what made
   * it "chunky" -- they are panels, not buttons, and one of them contains a
   * price slider. They now render UNDER the slim strip as their own blocks,
   * so the bar stays one row tall while the trays keep working. */
  /* ==================================================================
   *  DESIGN NOTE 390 (panel half): ONE BUTTON, AND NOTHING ELSE
   * ==================================================================
   *
   * When the player is on any tab other than the one this round is played
   * on, the entire bar is replaced by a single control that takes them
   * back. Replaced rather than prefixed, and that is the requirement's
   * word: a bar that showed the redirect ALONGSIDE the usual buttons would
   * leave live controls for a round being played on a screen the player
   * cannot see, which is how you get an action dispatched against a board
   * you are not looking at.
   *
   * DESIGN NOTE 404: THIS NOW COVERS THE REFERENCE TABS TOO -- Ledger,
   * Rules and the market chart. `misplacedSurfaceTab` used to exempt them
   * so that reading did not cost a player their controls; playtest found
   * the cost of the exemption, which is that Pass and Undo sat live on a
   * screen nobody was acting from and turns were being spent by accident.
   *
   * The replacement is what makes the reversal safe. A reference tab keeps
   * an action bar -- so the player stays oriented and the layout does not
   * jump -- and that bar has exactly one control, which cannot end a turn.
   *
   * THE COPY DISTINGUISHES THE TWO CASES. Standing on another round's
   * PLAYING surface is a player who may be waiting for something that will
   * never happen there; standing on a reference tab is a player who is
   * deliberately reading. Same button, different sentence. */
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
        ...(isMyTurn ? styles.actionBarTurnPulse : {}),
        ...(condensed ? styles.actionBarCondensed : {}),
      }}
    >
      {/* The "Phase N of 6: Track" suffix is GONE, and its removal is the
          point rather than a simplification.

          The stepper below numbers from the steps this era actually has
          (design note #2 there): five in the Yellow era, six from Phase 3.
          This label numbered from the fixed six-entry table. So the moment
          the stepper shipped, the bar read "Phase 2 of 6: Track" directly
          above a strip whose first chip said "1 Lay Track" -- two different
          numbers for the same step, six inches apart.

          Reconciling them would mean two places computing one position.
          The strip already shows the position, the progress AND the
          sequence, so the text is redundant as well as contradictory; the
          honest fix is for one of them to stop making the claim. */}
      {/* Design note #339: the auction is a ROUND, and the bar said it was
          not. `roundType` has four values and this branch covered two, so
          the Waterfall Auction -- the phase every game opens in -- fell
          through to "No live round" while the auction dashboard was on
          screen beneath it. A player's first impression of the app was a
          header denying that anything was happening.

          `null` keeps the honest wording: before the first `GetGameState`
          resolves there genuinely is no round yet. */}
      <span style={styles.actionBarRoundLabel}>
        {roundType === "OperatingRound"
          ? "Operating Round"
          : roundType === "StockRound"
            ? "Stock Round"
            : roundType === "WaterfallAuction"
              ? "Auction Round"
              : "No live round"}
      </span>
      {/* Design note #481: the sub-phase, inline. Operating Round only --
          there is no sub-phase sequence in a Stock Round or the auction,
          and a step counter next to those titles would be inventing
          structure the round does not have.

          IT SURVIVES THE COLLAPSE, unlike the strip it replaces. Design
          note #298 dropped the stepper when pinned on the grounds that it
          is orientation rather than input, and that a progress indicator
          which is always on screen stops being read. Neither objection
          survives the change of form: at three words it costs the board
          nothing, and it is now the ONLY thing naming the current step in
          the header, so dropping it when pinned would leave a player who
          scrolled unable to tell Lay Track from Station Tokens. */}
      {roundType === "OperatingRound" && orSubPhaseProgress && (
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
      )}
      {/* Operating Round turn stepper. Renders directly under the round
          label it elaborates: the label says WHICH step, the strip says
          where that step sits in the turn. Operating Round only -- there is
          no sub-phase sequence in a Stock Round or the auction, and a strip
          showing one would be inventing structure.

          Design note #212: the strip is a READ-ONLY indicator in every
          mode now, sandbox included. The only control on it is Skip, which
          dispatches the real `AdvanceOperatingSubPhase` -- see that
          component's design note #1 for why a clickable sandbox strip made
          the one place that tests the turn order unable to test it. */}
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
      {/* ===================================================================
           DESIGN NOTE 164: THE OPERATING ROUND PANEL IS TWO ROWS
          ===================================================================

          It used to be one long wrapping strip: Pass Turn, a divider, every
          action for the current sub-phase, another divider, Undo, the route
          mode toggle, a spacer, the phase badge, the shift warning. On a
          narrow window that wrapped, and because the number of contextual
          buttons CHANGES with the sub-phase, the badges moved every time the
          turn advanced. A warning that relocates as the game progresses is a
          warning players stop tracking.

          Now: a stepper row, then an action row laid out as a THREE-COLUMN
          GRID -- `1fr auto 1fr`. The centre column holds the sub-phase
          actions and is genuinely centred on the panel, not merely centred
          in whatever space the sides left over, because the two `1fr` rails
          are equal by construction however wide their contents get. The
          badges dock left and the always-available utilities dock right, and
          neither can push the actions off-centre.

          THE FOUR "SKIP" BUTTONS ARE GONE. `Skip Track Lay`, `Skip Private
          Purchase`, `Skip Tokens` and `Skip Routes` all called
          `onSkipSubPhase` -- the exact handler the stepper's own "Advance
          Sub-Phase" button calls. Four names for one action, one of them
          present in every phase, which is what made the action row read as
          a pile of controls rather than as "what can I do here". Advancing
          is a property of the TURN, so it lives with the stepper that shows
          the turn; the action row now holds only things that actually
          change game state. */}
      {roundType === "OperatingRound" ? (
        <div style={styles.orPanel}>
          {/* ===================================================================
               DESIGN NOTE 228: WHOSE TURN IS IT, AND WHAT DO THEY HAVE
              ===================================================================

              A player presiding over three corporations had no single place
              telling them which one is acting. The information existed --
              the Round Detail table below the board highlights the active
              row, and the corporation roster carries treasuries -- but both
              are elsewhere on the page, and the action bar, which is where
              every decision is actually made, named no company at all. So
              the commonest question in an Operating Round ("am I spending
              PRR's money or NYC's?") required looking away from the controls
              that spend it.

              FOUR FACTS, chosen because each one gates a decision on this
              very bar rather than because they were available:

                TREASURY   caps every action in the turn -- a tile's terrain
                           cost, a token, a train.
                STATIONS   how many tokens are left and what the next one
                           costs, which is the Tokens step's whole decision
                           and was previously only on the button.
                TRAINS     what can run in the Routes step, and what the
                           train limit permits buying in Hardware.

              Rendered as a strip above the stepper: it describes the whole
              turn, and the stepper describes where in that turn you are. */}
          {/* ==================================================================
               DESIGN NOTE 236: THE BAR WEARS THE CORPORATION'S COLOUR
              ==================================================================

              Two changes, and the second is why the first matters.

              THE COLOUR IS THE IDENTITY NOW. This was a fixed dark navy with
              a small brand-coloured dot -- the same slab for every
              corporation, so telling PRR's turn from NYC's meant reading the
              ticker. The bar now takes `stationTickerColor`, the exact
              palette the station tokens on the map are drawn from, so the
              strip and the tokens the player is placing are visibly the same
              company. A player running three corporations can tell whose
              turn it is peripherally, which is the whole complaint.

              THE DOT WENT WITH IT. A brand-coloured dot on a brand-coloured
              bar is invisible, and it was only ever a miniature of the
              signal the bar now carries at full size.

              INK IS DERIVED, NOT ASSERTED. `bestContrastTextColor` is the
              same per-fill choice the map tokens use for their acronyms, so
              B&M's dark slate gets white text and C&O's orange gets black
              without either being hardcoded. Secondary text takes the same
              ink at reduced alpha rather than a fixed grey, which would go
              illegible on half the palette. */}
          <div
            style={{
              ...styles.orContextCard,
              backgroundColor: corporationBarInk.background,
              borderColor: corporationBarInk.border,
            }}
          >
            <span style={styles.orContextIdentity}>
              {/* Design note #410: the same herald the Stock Card stripe
                  shows, so a corporation is not a logo on one screen and an
                  acronym on the other. `null` has no logo to draw -- there
                  is no corporation, which is a sentence rather than a
                  missing image. */}
              {activeCorporation ? (
                <CorporateLogo
                  ticker={activeCorporation.ticker}
                  size={24}
                  color={corporationBarInk.ink}
                  title={activeCorporation.fullName ?? activeCorporation.ticker}
                  fallbackStyle={styles.orContextTicker}
                />
              ) : (
                <span style={{ ...styles.orContextTicker, color: corporationBarInk.ink }}>
                  No corporation
                </span>
              )}
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
                    // Design note #298: identity detail, dropped when pinned.
                    ...(condensed ? { display: "none" } : {}),
                    ...(activeCorporation.presidentCash !== null
                      ? { cursor: "help", textDecoration: "underline dotted 1px" }
                      : {}),
                  }}
                  /* ==================================================
                       DESIGN NOTE 326: THE PERSONAL PURSE, ON THE PERSON
                      ==================================================

                      Where design note #325's figure went. Attached to the
                      president's NAME, so there is no ambiguity about
                      whose money it is -- a number beside a crown is a
                      fact about that human, where the same number floating
                      in the rail below was a fact about "the acting
                      turn", which in an Operating Round means the
                      company.

                      A tooltip rather than visible text because it is
                      reference, not a driver: it answers "can they cover
                      the emergency buy" when somebody asks, and the rest
                      of the time the strip is about the corporation. The
                      dotted underline is what makes it discoverable --
                      an unmarked tooltip is one nobody hovers. */
                  title={
                    activeCorporation.presidentCash !== null
                      ? `President's Personal Treasury: $${activeCorporation.presidentCash}`
                      : undefined
                  }
                >
                  {"\u{1F451} "}
                  {activeCorporation.presidentLabel}
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

                {/* ==================================================================
                     DESIGN NOTE 237: TOKENS, NOT A FRACTION
                    ==================================================================

                    This read `2/4 - $40 ea`, which was wrong about the money
                    and shaped wrong for the decision. The price is not flat:
                    the home token is free, the second is $40 and every one
                    after that is $100 (`utils/stationTokens.ts` design note
                    #0), so "$40 ea" understated a third token by 60%.

                    The row draws the corporation's whole allowance as
                    circles in placement order, each captioned with its own
                    cost, spent ones greyed in place. See
                    `StationTokenRow.tsx` for why it needs its own inset
                    surface on a brand-coloured bar. */}
                {/* ==================================================
                     DESIGN NOTE 372: THE PINNED CARD SHOWS THE PIECES
                    ==================================================

                    REPORTED: scrolled down, the sticky card shows the name,
                    the treasury and the TRAIN LIMIT. During operations the
                    actual trains and stations matter far more than the cap.

                    Design note #298 chose what to drop when the bar pins,
                    and it dropped the two rows that were expensive in
                    height -- the station circles and the train chips --
                    keeping the cheap single figures. That optimised for
                    pixels rather than for the decision: a president mid-turn
                    is asking "what do I own and where can I put a token",
                    and the answer was scrolled off the top of the page while
                    a number they cannot act on stayed pinned.

                    So the condensed card keeps the PIECES and drops the
                    LIMIT. It costs a few pixels back, which is the right
                    trade for the one row that is on screen the whole time
                    the map is being used. */}
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
                      // Design note #259: the rust countdown, matching the
                      // Round Detail table below the board. Without
                      // `outlook` a chip's tooltip names WHAT will destroy
                      // it but not HOW SOON -- and "rusts when the first
                      // 4-train is bought" is a different decision from
                      // "rusts in one more purchase". The figure was
                      // already computed for the table; this bar simply
                      // was not being handed it.
                      outlook={rustOutlookForBar}
                      /* Design note #375: interactive only during Run
                         Routes, where a chip and a route line are two views
                         of one thing. Outside it the chips are badges. */
                      interactive={orSubPhase === "Routes"}
                      highlightedTrainIndex={highlightedRouteIndex}
                      onHighlightTrain={onHighlightRoute}
                    />
                  )}
                  {/* Design note #248: the limit, beside the fleet it caps.
                      The chips say WHICH trains; this says how much room is
                      left, which is the figure that decides whether the Buy
                      Trains step has anything in it. Amber at the ceiling,
                      because that is the state that ends the step.

                      Design note #372: DROPPED WHEN PINNED. It is the one
                      figure here a president cannot act on -- the Buy Trains
                      step enforces it on its own -- so it is what gives way
                      to keep the chips and the tokens on a bar that has to
                      stay short. Still present in the full card, where there
                      is room for both. */}
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

                {/* ==================================================
                     DESIGN NOTE 379 (strip half): PRIVATES THE COMPANY OWNS
                    ==================================================

                    A corporation that bought a private from a player owns a
                    real asset -- it pays that company's revenue into this
                    treasury every Operating Round (design note #329) -- and
                    no surface said so. `utils/gameState.ts` design note #379
                    has the full account.

                    ABSENT, NOT EMPTY, when there are none. Most
                    corporations never buy a private, so a permanent
                    "Privates: none" on the one bar that is on screen all
                    turn would be a row of nothing for seven companies out
                    of eight. The Game Ledger's table shows a dash instead,
                    which is right for a table -- a column has to keep its
                    cell -- and wrong for a strip.

                    DROPPED WHEN PINNED, like the president line: design
                    note #372 keeps the pieces a president acts on, and a
                    private is a standing asset rather than a move. */}
                {activeCorporation.privates.length > 0 && (
                  <span
                    style={{
                      ...styles.orContextFact,
                      ...(condensed ? { display: "none" } : {}),
                    }}
                  >
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

          {/* ==============================================================
               DESIGN NOTE 481: THE STEPPER ROW WAS A ROW FOR ONE WORD
              ==============================================================

               REPORTED: two Undo buttons when expanded, and the sub-phase
               takes an entire unnecessary row.

               Both were the same row. It held the six-chip progress strip
               and, in its `trailing` slot, a second Undo -- design note
               #235's reasoning, which was sound when it was written and
               stopped being true underneath it. #235 put Undo beside the
               cursor it moves; design note #451 then put Undo in the action
               row's right rail, WITH the sub-phase name next to it, for
               the same reason. Two notes, one argument, two buttons. #451's
               placement wins because it sits with the other turn controls,
               which is where a player looks for it.

               THE STRIP IS NOW A PHRASE. It rendered five or six chips,
               chevrons and step numbers across the full width of the panel
               to say "you are on step 2 of 5, called Lay Track" -- which is
               a sentence, and now reads as one, inline beside the round
               title. The three facts the strip carried are all still there:
               the step's name, its position, and how many there are. What
               is gone is a horizontal rule and 30-odd pixels of height,
               permanently, on the panel that sits above the board.

               WHAT IS LOST, honestly: the chips named the steps that come
               NEXT, so a newcomer could read the whole sequence off the
               bar. `RulesReference.tsx` still lists it, and the strip
               component is kept intact rather than deleted so that view can
               use it -- see this file's import, which is now the only thing
               that changed about it. */}
          <div style={styles.orPanelActionRow}>
            {/* LEFT RAIL -- docked status. Fixed home, so the phase badge and
                the rust warning sit in the same place all game. */}
            <div style={styles.orPanelRailLeft}>
              {/* ==============================================================
                   DESIGN NOTE 482: THE TICKER LEAVES THE PINNED BAR
                  ==============================================================

                   REPORTED: the activity ticker pushes the action buttons
                   off-centre in the collapsed bar.

                   It did, and the mechanism is worth recording because the
                   row was BUILT not to allow it. `orPanelActionRow` is a
                   `1fr auto 1fr` grid precisely so the centre column is
                   centred on the panel rather than on the leftovers
                   (design note #426). But a `1fr` track is
                   `minmax(auto, 1fr)`: it refuses to shrink below its
                   content, so a rail holding a long, unconstrained line of
                   text does not get clipped -- it grows, and takes the
                   centre column with it. The sibling rail on the
                   non-Operating-Round bar has carried `minWidth: 0` for
                   exactly this reason since design note #458; this one
                   never did.

                   So there are two fixes here and both are wanted. The
                   rail gets its `minWidth: 0`, which makes the centring
                   structural rather than dependent on what happens to be
                   in the rail. And the ticker is gone from the pinned form
                   outright, which is what was asked for.

                   ON #458's ARGUMENT: it put the line here because the
                   sticky bar is the one element that survives scrolling --
                   which is a claim about the PINNED state specifically. It
                   does not survive the removal, and the copy kept below is
                   redundant with the full ticker sitting on the same
                   screen. It is left in the expanded bar because that is
                   the change that was asked for and no more; the honest
                   next step is to take it out altogether. */}
              {!condensed && (
                <StickyTickerLine latestItem={latestFeedItem} onExpand={onOpenActivityLog} />
              )}
              {phase && (
                <span style={{ ...styles.phaseBadge, ...PHASE_TINT_STYLES[phase.tint] }}>
                  {phase.label}
                </span>
              )}
              {/* ==================================================
                   DESIGN NOTE 325: TWO POCKETS, ONE ROW, CONSTANT CONFUSION
                  ==================================================

                  REPORTED: the standalone personal cash line in the
                  Operating Round panel is confused with corporate treasury
                  funds.

                  Design note #300 added it here on the reasoning that a
                  president facing an emergency train buy needs to know
                  what they can personally cover. That is true and the
                  placement was still wrong: this rail sits directly under
                  the corporation strip, which shows `Treasury $X` in the
                  same typeface at the same size. Two dollar figures, one
                  above the other, both attached to the acting turn, and
                  the tooltip explaining that they are different pockets
                  only opens if you already suspected they were.

                  An Operating Round spends the CORPORATION's money.
                  Nothing on this rail is charged to a player's wallet, so
                  the figure had no decision on this screen to inform.

                  IT IS NOT DELETED, IT IS MOVED -- design note #326 hangs
                  it off the president's own name in the strip above, where
                  it is unambiguously a fact about the person rather than
                  about the turn. The auction and Stock Round branch of this
                  bar keeps its badge (design note #308): there the money
                  IS the player's, and there it is the only figure on the
                  row. */}
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
              {/* ===================================================================
                   DESIGN NOTE 279: NO PLACEHOLDER WHERE A CONTROL SHOULD BE
                  ===================================================================

                  This row used to fall back to "No button for this step --
                  use Skip to move on." whenever a sub-phase contributed no
                  contextual buttons.

                  Design note #180 wrote it to replace an even worse string
                  ("Nothing to do in this step"), and it kept that string's
                  central mistake: it describes the PANEL rather than the
                  player's options. Every step of an Operating Round has
                  something to do -- lay track, place a token, draw a route,
                  buy a train -- and a line saying otherwise was only ever
                  true of this one div.

                  It also aged badly. By the time the Run Routes controls had
                  moved into their own panel, `Routes` was the only step
                  reaching this branch -- so the one place the string
                  actually rendered was a step with a whole route planner
                  directly beneath it, telling the player there was nothing
                  here but Skip.

                  Deleted outright, and the Routes controls moved onto this
                  line (below) so the branch has content rather than a
                  caption about its absence. The Track hint survives because
                  it is the opposite kind of string: it says where the
                  action IS (on the map), which is a thing the player cannot
                  otherwise know. */}
              {/* Design note #413: and it is only true for the player who
                  may actually click that hex. Told to a non-acting player it
                  is an instruction they cannot follow, on a map that will
                  refuse them -- which is the same dead click the Skip button
                  was handing out, dressed as help. */}
              {mayActThisTurn && contextualButtons.length === 0 && orSubPhase === "Track" && (
                <span style={styles.orPanelNoActions}>
                  Select a hex on the map to lay or upgrade track. Click the preview to rotate.
                </span>
              )}
              {/* ==================================================================
                   DESIGN NOTE 491: THE COLLAPSED BAR HID THE ONLY STEP THAT
                   HAPPENS SOMEWHERE ELSE
                  ==================================================================

                  REPORTED: when the Action panel is collapsed during Buy
                  Trains, the player sees only "End Turn" and can miss the
                  purchasing menus below.

                  Buy Trains is the one sub-phase whose controls are not on
                  this bar at all. Design note #203 moved both halves of the
                  step -- the depot and the corporation-to-corporation trade
                  -- out to `TrainPurchasePanel`, correctly, and left the bar
                  holding "End Turn" and nothing else. Expanded that is fine:
                  the panel is visible right underneath. PINNED it is not,
                  because the bar is pinned precisely when the player has
                  scrolled, and what they have scrolled away from is the
                  panel. The step then presents as a single button whose
                  only offer is to end the turn -- which is also the one
                  action 1830 may forbid here (design note #293).

                  So the collapsed bar gets a way BACK to the step. It is
                  navigation, not a second purchase control: it dispatches
                  nothing, and there is still exactly one place a train is
                  bought. Design note #182's argument against a generic "Buy
                  Train" button is unaffected -- that objected to a duplicate
                  ACTION, and this is a scroll.

                  BEFORE END TURN, per the report and because that is the
                  order the step is done in: buy, then finish. It is also the
                  safer reading order when End Turn is disabled, since the
                  button that explains what to do first now precedes the one
                  refusing to move on.

                  CONDENSED ONLY. Expanded, the panel it scrolls to is
                  already on screen, and a button that scrolls to something
                  visible is noise. */}
              {condensed && orSubPhase === "Hardware" && mayActThisTurn && onJumpToTrainPurchase && (
                <button
                  type="button"
                  style={{ ...styles.actionBarButton, ...styles.actionBarJumpButton }}
                  onClick={onJumpToTrainPurchase}
                  title="Scroll down to the Bank Depot and corporation train trade panels."
                >
                  &#8595; Buy Trains
                </button>
              )}
              {contextualButtons.map((btn) => (
                <button
                  key={btn.key}
                  type="button"
                  style={styles.actionBarButton}
                  onClick={btn.onClick}
                  disabled={btn.disabled || !sessionReady}
                  title={btn.title}
                >
                  {btn.label}
                </button>
              ))}

              {/* ===================================================================
                   DESIGN NOTE 279: THE ROUTE MODE TOGGLE IS A TOOLBAR CONTROL
                  ===================================================================

                  Run Routes was the only sub-phase whose primary controls
                  lived somewhere other than this line. The toggle sat at the
                  top of `RoutePlannerPanel`, inside its border, above a
                  table of drafted routes -- which reads as a property of
                  those routes rather than as the tool that makes them.

                  It sits here now, immediately before Skip, because those
                  two ARE the choice on arriving at this step: pick how to
                  build a route, or decline to build one. The panel below
                  keeps everything that describes a route.

                  See `RoutePlannerPanel`'s design note #7 for why the
                  component itself still lives there rather than being
                  rebuilt here. */}
              {showRouteToggle && (
                <AutoRouteButton
                  onAutoRoute={onAutoRoute}
                  ownsAnyTrain={ownsAnyTrain}
                  controlsEnabled={sessionReady}
                  noTrainReason={NO_TRAIN_ROUTE_REASON}
                />
              )}

              {/* ==================================================================
                   DESIGN NOTE 258: SKIP IS AN ACTION, SO IT SITS WITH THE ACTIONS
                  ==================================================================

                  Design note #235 moved Skip onto the action ROW for the
                  right reason -- it is the alternative to whatever this step
                  offers -- but dropped it into the right RAIL, which is the
                  docked-utilities column. The row is a three-column grid
                  (`1fr auto 1fr`), so anything in that rail is pinned to the
                  far edge: Skip ended up flush right, half a panel away from
                  the buttons it is an alternative to.

                  It sits in the CENTRE column now, last in the group.
                  Declining is the fallback, so it reads after the things it
                  is a fallback to rather than competing for the first
                  glance.

                  ==================================================================
                   DESIGN NOTE 263: EXCEPT ON THE LAST STEP, WHERE IT IS A TWIN
                  ==================================================================

                  Buy Trains is the final sub-phase of a corporation's turn,
                  and it already carries "End Turn". Skip and End Turn there
                  are the same gesture wearing two labels: nothing follows
                  Buy Trains, so "move past this step without acting" IS
                  "finish this turn". Two buttons for one outcome is worse
                  than a redundant control -- it implies a distinction, and a
                  player who reads one has to work out what the other would
                  do differently.

                  So Skip is hidden on `Hardware` and End Turn is the sole
                  advancement, which is also the honest label: the turn is
                  what ends. Every earlier step keeps Skip, because on those
                  it genuinely does something End Turn does not -- move one
                  step and leave the rest of the turn intact. */}
              {/* ===================================================================
                   DESIGN NOTE 278: A CORPORATION THAT EARNED CANNOT DECLINE
                  ===================================================================

                  Skip was available on the Dividends step regardless of what
                  the trains had just earned, which offers a third option
                  1830 does not have. Once a corporation runs a route for
                  more than $0 the money EXISTS, and the rules give exactly
                  two places it can go: out to the shareholders, or into the
                  treasury. There is no third door where it evaporates.

                  Worse than merely wrong, it was the ONE step where skipping
                  silently destroyed value. Skipping Track or Tokens forgoes
                  an opportunity; skipping a declared $180 would have thrown
                  away $180 the corporation had already earned, and nothing
                  on screen said so.

                  So Skip disappears when there is revenue to allocate, and
                  the Pay/Withhold pair -- already the only two contextual
                  buttons on this step -- becomes the whole choice.

                  IT STAYS AT $0, which is the case the rule does not cover.
                  A corporation that ran nothing, or ran a route worth
                  nothing, has no money to allocate and no reason to be held
                  on this step; `DeclareDividends` for zero is a message with
                  no effect, so Skip is the honest control there. That is
                  also why this tests the REVENUE rather than the sub-phase:
                  the question is whether anything was earned, not which
                  step the cursor is on. */}
              {/* Design note #413: `mayActThisTurn` leads, because Skip is
                  the control the report names. It dispatches
                  `AdvanceOperatingSubPhase` for the ACTING corporation, so a
                  non-acting player clicking it was stepping somebody else's
                  turn forward. */}
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
              {/* Design note #266: the Auto Route / Manual Route pair used to
                  live here, in the docked-utilities rail. They are not
                  utilities -- they are the first step of the Run Routes
                  task -- and they now head `RoutePlannerPanel` below as one
                  segmented control. See that file's design note #0 for why
                  the three regions became one column. */}
              {/* ==================================================
                   DESIGN NOTE 451: UNDO, AND WHAT IT WOULD UNDO
                  ==================================================

                   REPORTED: add Undo to the collapsed/sticky action bar so
                   it is always accessible, and put the sub-phase name beside
                   it so the logic of what is being undone is visible.

                   Undo lived only on the NON-Operating-Round branch of this
                   bar -- the auction and Stock Round row. During an
                   Operating Round, which is the round with the most
                   undoable actions in it and the only one with sub-steps to
                   get lost in, the button was simply absent. A player who
                   laid the wrong tile had to leave the round's own panel to
                   find the control that would take it back.

                   THE PAIR IS THE POINT, not two controls that happen to be
                   adjacent. `Undo` alone answers "can I take that back";
                   `Track ⟲ Undo` answers "take back what I did in Track",
                   which is the question actually being asked. Design note
                   #439 made Undo rewind past auto-skipped steps to the last
                   thing the player chose -- so naming the step it will land
                   on is what makes that behaviour legible rather than
                   surprising.

                   IT SITS IN THE RIGHT RAIL, which the grid keeps clear of
                   the centred action group (design note #426). So adding it
                   moves nothing: the primary buttons stay exactly where
                   muscle memory left them. */}
              <span style={styles.undoStepLabel}>
                {OPERATING_SUB_PHASE_LABELS[orSubPhase].stepLabel}
              </span>
              <button
                type="button"
                style={{ ...styles.actionBarButton, ...styles.actionBarUtilityButton }}
                onClick={onUndoLastAction}
                disabled={!sessionReady}
                title={`Undo the last action you took. Rewinds to your last real decision, skipping any steps the game advanced for you.`}
              >
                &#8630; Undo
              </button>
            </div>
          </div>

          {/* Design note #490: the payout detail, inside the panel and under
              the buttons it explains. `orPanel` is a flex COLUMN, so this
              lands directly below `orPanelActionRow` with no positioning of
              its own -- which is why the move needed no new layout, only a
              different parent.

              Design note #188 (kept): the consequence of each option, laid
              out before the player commits. Two things they could not
              otherwise see -- WHO gets paid and how much, and WHERE the
              stock token lands -- both computable from state already on
              screen, and both previously left for the player to work out. */}
          {/* ==================================================================
               DESIGN NOTE 498: THE PINNED BAR DROPPED THE ONE STEP THAT IS
               ABOUT THE TRAINS
              ==================================================================

              REPORTED: during Run Routes the collapsed Action Panel does not
              give enough context about the active trains.

              It gave none. Design note #298's rule for the pinned form --
              keep what a player needs WHILE LOOKING AT THE BOARD, drop the
              rest -- is right, and Run Routes is the step where it misfires.
              Everything about this step IS the board: which train is being
              drafted for, what its run is worth, whether the other two have
              routes at all. `RoutePlannerPanel` carries all of it and scrolls
              away, so a pinned player drawing a route on the map had no way
              to see the value of what they were drawing.

              So this row is the exception #298's own reasoning asks for, and
              it is narrow: condensed only, Routes only, one line.

              THE CHIPS ARE LIVE, not a readout. They call the same
              `onSelectRouteTrain`/`onHighlightRoute` the planner rows do, so
              from the collapsed bar a player can still switch which train the
              map is drafting for and light its route up (design note #495's
              emphasis). A dead label here would have shown the problem
              without giving anywhere to act on it. */}
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
          {orSubPhase === "Dividends" && !condensed && (
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

              <div style={styles.dividendColumn}>
                <span style={styles.dividendHeading}>Withhold ${dividendRevenue}</span>
                <span style={styles.dividendNote}>
                  The full amount stays in the corporation's treasury. Shareholders receive
                  nothing this Operating Round.
                </span>
                <MarketMoveLine
                  currentPrice={dividendPrice}
                  projection={withholdProjection}
                  direction="withhold"
                />
              </div>
            </div>
          )}
        </div>
      ) : (
      <div style={styles.actionBarButtons}>
        {/* ==================================================================
             DESIGN NOTE 308: THE AUCTION BAR HAD NEITHER NAME NOR MONEY
            ==================================================================

            Design note #300 put the acting player's cash on the Operating
            Round branch of this bar. The auction and Stock Round take the
            OTHER branch a few lines down, and got neither -- which is the
            wrong way round if anything: an Operating Round spends the
            CORPORATION's treasury, while a private auction spends the
            player's own money and nothing else. The one screen where a
            personal balance decides every action was the one not showing it.

            It leads the row rather than trailing it, because in a hotseat
            the first question on arriving at the bar is whose turn this is.

            ==================================================================
             DESIGN NOTE 309: THE BUTTONS SIT WHERE THE OTHER BRANCH PUTS THEM
            ==================================================================

            Pass and Undo were left-aligned here while the Operating Round's
            controls are centred (`orPanelActionRow`'s `1fr auto 1fr` grid).
            Switching rounds moved the buttons across the screen, so muscle
            memory built in one phase missed in the next. A leading spacer
            balances the trailing one that already pins the phase badge,
            which centres the group between them without either rail having
            to know what the other holds. */}
        {/* ==================================================================
             DESIGN NOTE 342: THE WHOLE TABLE, NOT JUST WHOEVER IS UP
            ==================================================================

            REPORTED: display every player's name and treasury persistently
            in the Action Bar, with the active player highlighted green and
            the rest slate.

            Design note #308 put the ACTING seat's name and cash here, which
            answered "what can I spend" and nothing else. In an auction the
            question that decides a bid is "what can THEY spend" -- whether
            the player who keeps raising is about to run out, and whether
            the $220 B&O is reachable by anyone but you. That was on the
            seating table at the bottom of the auction tab and nowhere else,
            so judging a raise meant scrolling away from the raise button.

            A ROW OF PILLS, one per seat, in seating order. The active seat
            is green and the rest are slate, which makes the turn readable
            at a glance without a separate badge -- and because every seat
            is always present, the row does not reflow when the turn moves
            (the same fixed-layout reasoning as design note #323).

            AVAILABLE cash, not total, for design note #317's reason: during
            the auction the total is the one figure that cannot be spent.
            Falls back to the single acting-player badge whenever the roster
            is not available, which is every non-sandbox room until the
            first `GetGameState` resolves. */}
        {playerRoster.length > 0 ? (
          <span style={styles.actionBarRoster}>
            {playerRoster.map((seat) => (
              <span
                key={seat.address}
                style={{
                  ...styles.rosterPill,
                  ...(seat.isActive ? styles.rosterPillActive : styles.rosterPillIdle),
                }}
                title={
                  seat.escrowed > 0
                    ? `${seat.label} has $${seat.available} available to bid. $${seat.escrowed} more is escrowed in standing bids and comes back if those bids lose.`
                    : `${seat.label} holds $${seat.available}.${seat.isActive ? " On turn." : ""}`
                }
              >
                <span style={styles.rosterPillName}>{seat.label}</span>
                <span style={styles.rosterPillValue}>${seat.available}</span>
                {seat.escrowed > 0 && (
                  <span style={styles.rosterPillEscrow}>+${seat.escrowed}</span>
                )}
              </span>
            ))}
          </span>
        ) : (
          activePlayerCash !== null && (
            <span
              style={styles.playerCashBadge}
              /* Design note #317: when money is escrowed the badge says so,
                 because the figure beside the name has stopped being the
                 player's balance and become their SPENDING POWER -- two
                 different numbers that only coincide when nothing is bid. */
              title={
                activePlayerEscrow > 0
                  ? `${activePlayerName ?? "The acting player"} has $${activePlayerCash} available to bid. $${activePlayerEscrow} more is escrowed in standing bids and comes back if those bids lose.`
                  : `${activePlayerName ?? "The acting player"} holds $${activePlayerCash}. In the auction this is the only money in play \u2014 privates are bought from a player's own cash, not a corporation's treasury.`
              }
            >
              <span style={styles.playerCashName}>{activePlayerName ?? "Player"}</span>
              <span style={styles.playerCashValue}>${activePlayerCash}</span>
              {activePlayerEscrow > 0 && (
                <span style={styles.playerCashEscrow}>${activePlayerEscrow} held</span>
              )}
            </span>
          )
        )}
        {/* Design note #426: the centre cell of a `1fr auto 1fr` grid.
            The leading `actionBarSpacer` that used to sit here is gone --
            see `appStyles.ts` for why two equal spacers centred the group
            between themselves but not on the bar. */}
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
        <span style={styles.actionBarDivider} />
        {contextualButtons.map((btn) => (
          <button
            key={btn.key}
            style={styles.actionBarButton}
            onClick={btn.onClick}
            disabled={btn.disabled || !sessionReady}
            title={btn.title}
          >
            {btn.label}
          </button>
        ))}
        <span style={styles.actionBarDivider} />
        <button
          style={{ ...styles.actionBarButton, ...styles.actionBarUtilityButton }}
          onClick={onUndoLastAction}
          disabled={!sessionReady}
          title="Always available, independent of round type."
        >
          Undo Last Action
        </button>
        {/* The route mode toggle used to render here too. It is
            `showRouteToggle`-gated, and that flag is OR-and-Routes-only, so
            in this NON-Operating-Round branch it was unreachable markup.
            Removed rather than left as a second copy to keep in step with
            the live one in the OR panel above. */}
        </span>

        {/* Design note #40/#426: the phase badge, pinned right. The trailing
            spacer is gone with the leading one -- the grid's right rail
            (`justifySelf: end`) pins the badge without taking width from the
            centred group, which is what the spacer pair could not do. The
            rail renders unconditionally so the grid always has three
            columns; design note #40's warning about an auto margin on a
            conditional node no longer applies, because the margin is now the
            rail's rather than the badge's. */}
        <span style={styles.actionBarRailRight}>
        {phase && (
          <span style={{ ...styles.phaseBadge, ...PHASE_TINT_STYLES[phase.tint] }}>
            {phase.label}
          </span>
        )}
        {/* Design note #7 (`gamePhase.ts`): TWO steps, not one. This badge
            used to render identically at two purchases and at one, so the
            last purchase before a rust -- the single most consequential
            moment in an 1830 game -- looked exactly like the moment before
            it. It now reads the same `phaseAlertLevel` helper the train
            chips do, so the bar and the chips escalate together.

            The wording escalates with the colour: "Imminent" is a claim
            about the next purchase, and it was previously being made one
            purchase too early. */}
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
      </div>
      )}
    </div>

    {/* ---- Contextual trays -- design note #31 --------------------------
        Panels, not bar content: a train marketplace, a private-company
        purchase tray with a price slider, and the route-point readout.
        Each is narrowly conditional (a specific OR sub-phase, or the route
        toggle being on), so most of the time none of this renders at all
        and the bar above is the entire control surface. */}
      {/* Phase 4's marketplace selection tray -- see design note #10/item 2.
          `BuyHardwareFromPool` has no per-model parameter yet (see
          `MOCK_TRAIN_CATALOG`'s own doc comment), so selecting a card here
          only changes which model is highlighted/labeled; the purchase
          itself still targets whichever unit the pool auto-assigns. */}
      {/* ===================================================================
           DESIGN NOTE 490: THE CONSEQUENCE BELONGS TO THE BUTTON
          ===================================================================

          REPORTED: the Dividends step opens a separate, redundant panel
          below the Action panel to show payouts and market moves.

          It did, and the split was structural rather than cosmetic: this
          block sat OUTSIDE the action bar's own root `<div>`, as a sibling
          of it, so a bordered card appeared under the bar the moment the
          sub-phase changed and vanished again when it advanced. The player
          read the payout in one panel and clicked the button that caused it
          in another, with a border between the cause and the effect.

          Design note #188's content was right -- WHO gets paid and WHERE
          the token lands are exactly the two things a player cannot
          otherwise see -- and it is kept verbatim. Only its address changed:
          it now renders inside `orPanel`, directly beneath the action row
          that carries Pay and Withhold, so each column sits under the
          button it describes.

          NOT RENDERED WHEN CONDENSED. Design note #298's rule for the
          pinned bar is that it keeps what a player needs WHILE LOOKING AT
          THE BOARD and drops the rest. A payout table is the opposite of
          that: it is read while deciding, not while scrolling a map, and a
          pinned bar carrying two columns of figures would cost the board
          more height than any other state of this panel. The buttons stay;
          the reading matter returns the moment the bar unsticks. */}
      {/* ===================================================================
           DESIGN NOTE 203: THE HARDWARE TRAY MOVED OUT OF THE BAR
          ===================================================================

          Design note #182 correctly reduced a six-card selector to the ONE
          train 1830's cheapest-first depot will actually sell. What it could
          not fix, sitting inside the action bar, is that the depot was only
          half the step: a corporation in the Hardware sub-phase can buy from
          the bank OR from another corporation, and the second half lived in
          a completely separate panel further down the page.

          Both halves are now `TrainPurchasePanel`, rendered by the shell --
          see that file's design note #0 for why they are two sections rather
          than one control, and #1 for the quantity field this tray had
          nowhere to put. The bar keeps only "End Turn" for this step, which
          is the one thing here that is a button rather than a panel. */}
      {/* ===================================================================
           DESIGN NOTE 165: THE INLINE BUY-PRIVATE TRAY IS GONE
          ===================================================================

          It was a select, a range slider and a Buy button wedged into the
          action bar, and it modelled the purchase as a UNILATERAL act: pick
          a private, drag a price, buy it. In 1830 that transaction needs the
          owner's agreement, and a slider you drag past somebody else's
          property does not represent one.

          `ProposePrivatePurchase` replaces it -- a real sheet with the
          eligible privates, each showing its owner and its legal band, and
          a typed price rather than a drag. Typing matters here: the band is
          50-200% of face value, so a $100 private has a 51-value range and
          a slider makes hitting an exact intended figure fiddly.

          The tray also sat under the HARDWARE sub-phase, which is wrong --
          `trading.rs`'s own sub-phase gate puts private purchase FIRST in
          the turn, before track. The button now lives in the `BuyPrivate`
          step where the contract expects it. */}
      {/* ===================================================================
           DESIGN NOTE 266: THE RUN ROUTES STEP IS ONE PANEL NOW
          ===================================================================

          Everything this step needs moved into `RoutePlannerPanel` -- the
          mode toggle that was in the right rail, the run button that was in
          the centre column, and the waypoint readout that was here. See
          that file's design note #0 for the reading-order argument.

          It renders on the whole `Routes` sub-phase rather than only while
          route mode is engaged. The old panel was gated on
          `routeSelectMode`, which made the toggle that turns route mode on
          live somewhere else by necessity -- a control cannot switch on the
          panel it is inside. Rendering on the sub-phase breaks that loop. */}
      {/* Design note #0 in `PrivatePowerPanel.tsx`: the abilities, gated on
          ownership and on the round they may be used in. Renders nothing
          outside sandbox, and nothing when the viewer owns none. */}
      <PrivatePowerPanel
        privateCompanies={privateCompanies}
        viewerAddress={privatePowerViewer}
        roundType={roundType}
        orSubPhase={roundType === "OperatingRound" ? orSubPhase : null}
        sandbox={sandboxMode}
        /* Design note #441: a corporate power belongs to the corporation
           OPERATING and is executed by whoever holds its controls. The bar
           already resolves both -- `activeCorporation` is the acting
           company and `presidentAddress` the person entitled to act for it
           -- so the panel is handed the same answers the rest of this bar
           is gated on rather than deriving a second set. */
        actingProtocolId={activeCorporation?.companyId ?? null}
        actingPresident={activeCorporation?.presidentAddress ?? null}
        usedAbilities={usedPrivateAbilities}
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
