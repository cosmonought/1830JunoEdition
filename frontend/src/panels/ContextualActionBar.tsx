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
import PrivatePowerPanel, { type PrivateAbility } from "../components/PrivatePowerPanel";
import { RoutePlannerPanel, RouteModeToggle } from "../components/RoutePlannerPanel";
import type { RouteBuildMode, TrainRouteDraft } from "../components/RoutePlannerPanel";
import StationTokenRow from "../components/StationTokenRow";
import {
  OperatingSubPhaseStepper,
  OPERATING_SUB_PHASE_LABELS,
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
   */
  const rising = direction === "pay";
  const arrow = rising ? "↗" : "↘";

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
          ...(rising ? styles.dividendMoveArrowUp : styles.dividendMoveArrowDown),
        }}
        // The arrow is decoration for a sighted reader and the whole
        // direction for everyone else, so it is labelled rather than hidden.
        role="img"
        aria-label={rising ? "rises to" : "falls to"}
      >
        {arrow}
      </span>{" "}
      <ZonedPrice price={projection.price} />
      {/* The edge of the chart. The format is unchanged -- both prices and
          the arrow are still there, and they are simply equal -- with the
          reason appended, because a line reading "$100 ↗ $100" with no
          explanation looks like a bug rather than a ceiling. */}
      {!projection.moves && (
        <span style={styles.dividendMoveNote}>
          {rising ? " (already at the top of its row)" : " (already at the bottom of its row)"}
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
function useCondensedOnScroll(threshold = 24): boolean {
  const [condensed, setCondensed] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    /* Read on a rAF rather than on every scroll event: this flips one
       boolean, and re-rendering the action bar on every pixel of a wheel
       gesture is the classic scroll-listener jank. */
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        setCondensed(window.scrollY > threshold);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return condensed;
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
  routeBuildMode,
  onSelectRouteBuildMode,
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
  usedPrivateAbilities: ReadonlySet<number>;
  onUsePrivateAbility: (ability: PrivateAbility) => void;
  onRunTrains: () => void;
  onPayDividends: () => void;
  onWithholdRevenue: () => void;
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
  routeBuildMode: RouteBuildMode;
  onSelectRouteBuildMode: (mode: RouteBuildMode) => void;
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
  const condensed = useCondensedOnScroll();

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
        contextualButtons = [
          {
            key: "pay-dividends",
            // Design note #188: the per-share figure is the number the
            // decision turns on, and it was the one thing the button did
            // not say. 1830 splits revenue ten ways -- one share is 10% --
            // so a $180 route pays $18 a share.
            label: `Pay Dividends ($${dividendPerShare} per share)`,
            onClick: onPayDividends,
            title: `Splits $${dividendRevenue} between every shareholder at $${dividendPerShare} per 10% share.`,
          },
          {
            key: "withhold-revenue",
            label: "Withhold to Corporate Treasury",
            onClick: onWithholdRevenue,
            title: `Keeps all $${dividendRevenue} in the corporation's treasury. Shareholders receive nothing.`,
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
     jointly mean is a thing that can disagree with them. */
  const dividendChoiceForced =
    roundType === "OperatingRound" &&
    orSubPhase === "Dividends" &&
    dividendRevenue > 0 &&
    dividendRevenueIsThisTurn;

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

          {!condensed && (
          <div style={styles.orPanelStepperRow}>
            {/* Design note #235: UNDO lives on the sub-phase line now. It is
                the only control that moves the turn cursor BACKWARDS, so it
                belongs beside the strip that displays that cursor -- the two
                things that move the same pointer, together. */}
            <OperatingSubPhaseStepper
              current={orSubPhase}
              era={currentGlobalEra}
              // Design note #385: the strip drops `Buy Private` once every
              // private is closed or inside a corporation, so the step is
              // not there to be skipped.
              privates={privateCompanies}
              trailing={
                <button
                  type="button"
                  style={{ ...styles.actionBarButton, ...styles.actionBarUtilityButton }}
                  onClick={onUndoLastAction}
                  disabled={!sessionReady}
                  title="Step the turn back. Always available, independent of round type."
                >
                  Undo
                </button>
              }
            />
          </div>
          )}

          <div style={styles.orPanelActionRow}>
            {/* LEFT RAIL -- docked status. Fixed home, so the phase badge and
                the rust warning sit in the same place all game. */}
            <div style={styles.orPanelRailLeft}>
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
              {contextualButtons.length === 0 && orSubPhase === "Track" && (
                <span style={styles.orPanelNoActions}>
                  Select a hex on the map to lay or upgrade track. Click the preview to rotate.
                </span>
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
                <RouteModeToggle
                  mode={routeBuildMode}
                  onSelectMode={onSelectRouteBuildMode}
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
              {orSubPhase !== "Hardware" && !dividendChoiceForced && (
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
            </div>
          </div>
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
        <span style={styles.actionBarSpacer} />
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

        {/* Design note #40: the phase badge, pinned right. `marginLeft:
            auto` on the spacer rather than on the badge itself, because the
            badge is conditional -- an auto margin on a node that sometimes
            does not render would silently stop pinning anything. */}
        <span style={styles.actionBarSpacer} />
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
      {/* Design note #188: the consequence of each option, laid out before
          the player commits. Two things they could not otherwise see: WHO
          gets paid and how much, and WHERE the stock token lands. Both are
          computable from state already on screen, and both were being left
          for the player to work out. */}
      {roundType === "OperatingRound" && orSubPhase === "Dividends" && (
        <div style={styles.dividendPanel}>
          <div style={styles.dividendColumn}>
            <span style={styles.dividendHeading}>
              Pay out ${dividendRevenue} &middot; ${dividendPerShare}/share
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
              The full amount stays in the corporation's treasury. Shareholders receive nothing
              this Operating Round.
            </span>
            <MarketMoveLine
              currentPrice={dividendPrice}
              projection={withholdProjection}
              direction="withhold"
            />
          </div>
        </div>
      )}
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
