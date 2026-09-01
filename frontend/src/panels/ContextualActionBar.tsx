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

import React, { useEffect, useRef, useState } from "react";

import { TrainChips } from "../components/TrainBadges";
import { RouteChipDetail } from "../components/RouteChipDetail";
// Design note #885: `PrivatePowerPanel` is deleted -- see `App.tsx` #885 for what it held and where each
// piece went. This file's own #884 is the surface that replaced it.
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
import { desaturatedLiveryInk } from "../styles/corporationLivery";
import type { StationTokenSlot } from "../utils/stationTokens";
import type { PrivateCompanyState } from "../utils/gameState";
import type { RoundType, TileColor } from "../utils/gameState";
import {
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
import { PresidentCrown, PRESIDENT_CROWN_GOLD } from "../components/PresidentCrown";
import { NO_TRAIN_ROUTE_REASON } from "../utils/gameConstants";
import { passButtonLabel, passButtonTitle } from "../utils/turnAction";
import {
  canPinWithoutTrapping,
  restingHeight,
  shouldCondenseSticky,
  shouldReleasePin,
  stickyTopOffset,
} from "../utils/stickyCollapse";
import type { DepotTier } from "../utils/gamePhase";
import { purchaseWarnings } from "../utils/purchaseWarnings";
// Design note #1034: the one place that says a reprieved train occupies no limit slot.
import { countableTrainCount } from "../utils/trainLimit";
import { dividendDeclaration, marketMoveDirection } from "../utils/dividendStep";
// Design note #494: the per-train route ink, so the collapsed chips match
// the lines on the map.
import { routeTrainColor } from "../styles/routeLivery";
import { styles, PHASE_TINT_STYLES } from "../styles/appStyles";
// Design note #975: the chip's own type scale and the x-height ratio, so its star can be derived from the
// text beside it rather than typed as a pixel count.
import { FONT_SIZE, X_HEIGHT_RATIO } from "../styles/typography";
// Design note #707: a corporation that can run must run.
import { routeRunObligation } from "../utils/routeStep";
// Design note #705: the row as one sentence, built from the fields the row renders.
import {
  describeDividendRow,
  type DividendPayoutProjection,
} from "../utils/dividendProjection";
import CarcosaMark from "../components/CarcosaMark";
import { PrivatePowerStar } from "../components/privatePowerStar";

/* ------------------------------------------------------------------ */
/* Contextual Top Action Bar -- see design note #8/item 5              */
/* ------------------------------------------------------------------ */

interface ActionBarButton {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /* ==================================================================
      DESIGN NOTE 936: A SLOT FOR THE MARK, BESIDE THE WORDS
     ==================================================================
     ASKED FOR: the board's private-power star on the Buy Private Company button, "to bridge the visual
     vocabulary."
     A SEPARATE FIELD RATHER THAN WIDENING `label` TO A NODE. `label` is read as TEXT elsewhere -- it is what
     the collapsed bar measures and what a test asserts on -- and turning it into a `ReactNode` would make
     every one of those readers accept something they cannot read. The icon is a different thing from the
     name, so it gets a different field.
     DECORATIVE BY CONSTRUCTION. The button says "Buy Private Company" in words; the star repeats that rather
     than adding to it, so it is rendered `aria-hidden` (#936) and the accessible name is unchanged. */
  icon?: React.ReactNode;
}

/** Design note #805: the herald's height, in one place because TWO things now depend on it.
 *
 *  The corporation card is two columns of two rows. On the left, the herald sits above the full name; on the
 *  right, the treasury sits above the president. The president lands on the full name's line ONLY IF the
 *  right column's first row is exactly as tall as the herald -- which is a relationship, not a coincidence,
 *  and the sort of thing that survives about one refactor when it is written as `24` in two places.
 *  A number rather than a style key because `appStyles.ts` cannot see the `size` prop this is passed to. */
const CORPORATION_HERALD_PX = 24;

/** The power chip's star, sized from the chip's own type rather than typed as a pixel count.
 *
 *  ==================================================================
 *   DESIGN NOTE 975: 11 WAS A NUMBER, NOT A RULE
 *  ==================================================================
 *
 *  REPORTED: "The star icon on the Action Bar button is currently larger than the star on the board hexes.
 *  Scale down the Action Bar button's star so it matches the size of the board hex star perfectly."
 *
 *  THE REAL DEFECT IS THAT THE TWO STARS WERE NOT RELATED BY ANYTHING. The hex derives its star from the
 *  MEASURED cap-height of the acronym beside it (#937); #943 wrote `height={11}` here and derived it from
 *  nothing at all. That the two were ever close was luck, and it would have come apart silently the next
 *  time `FONT_SIZE.strong` moved.
 *
 *  X-HEIGHT, NOT CAP-HEIGHT, and `privatePowerStar` #975 carries the argument: the hex's neighbour is
 *  `DH` -- all capitals -- while this chip's is `Use DH Power`, which is mostly lowercase. One ratio applied
 *  to both makes the mark sit flush on the hex and tower over the chip, which is exactly what was reported.
 *
 *  IT DOES NOT MATCH THE HEX'S STAR IN PIXELS AND CANNOT. The board star is ~5.8px at full zoom and shrinks
 *  with the map; this lands near 8px against 15px text. Said plainly rather than implied, because the
 *  request asked for "perfectly" and this is deliberately not that -- see #975 for why no fixed number can
 *  be.
 *
 *  PARSED FROM THE TYPE SCALE so there is one declaration of the chip's font size. `FONT_SIZE.strong` is the
 *  string `actionBarButton` sets; reading it here is what keeps this derived rather than re-typed. */
const POWER_CHIP_STAR_PX = Math.round(parseFloat(FONT_SIZE.strong) * X_HEIGHT_RATIO * 10) / 10;

/* Design note #831's `EMPTY_JUMP_REF` is GONE, and #833 says why: the map now arrives as an ELEMENT rather
   than a ref, so "no map on screen" is spelled `null` and needs no stand-in object. See `useJumpTarget`. */




/* Design note #197's ZonedPrice moved to `StockMarketRenderer` at #712, when the Stock Round's corporation
   cards needed the same tinted figure. Its reasoning is unchanged and now lives beside the zone table it
   reads: "a player reading this panel is looking at a NUMBER, not the chart, so stepping into the Yellow zone
   was invisible exactly when it mattered." */

function MarketMoveLine({
  currentPrice,
  projection,
  direction,
  steps = 1,
}: {
  currentPrice: number | null;
  projection: MarketProjection | null;
  /** Which way the token travels: paying out steps right, withholding left. */
  direction: "pay" | "withhold";
  /* ==================================================================
   *  DESIGN NOTE 998: HOW FAR, SO THE LINE CAN SAY WHEN IT IS TWO
   * ==================================================================
   * ASKED: "can we actually just indicate this on the Market Move line? e.g., 'Market Move: $current >
   * $new (double jump)' ... Maybe we replace both with (double move)?"
   * AND THE LINE IS THE RIGHT SURFACE, which #997's footer was not. That footer explained a rule beneath a
   * pair of figures that already state the outcome -- "$76 ➜ $65" IS the projection, and a sentence under
   * it describing why is #509a's own complaint one panel over: "SHOW THE MONEY MOVING, DO NOT DESCRIBE IT."
   * A two-word marker on the line itself is the same fact where the player is already looking.
   * DEFAULTED TO ONE so the two call sites that do not care read as before -- there is only one variant
   * that can produce a two, and every other caller is describing a single step by definition. */
  steps?: number;
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
      {/* Design note #891: THE OLD SENTENCES NAMED A THING THAT DOES NOT EXIST. They read
          " (already at the top of its row)" and " (already at the bottom of its row)" -- and a ROW has a
          left and a right edge, not a top and a bottom. Reported: "It is NOT at the top of its row, it's at
          the right edge of its row."
          AND THEY FIRED IN THE WRONG PLACE, which is the half that mattered: the right edge of a row is a
          LEDGE, where a payout moves the token up a row, so `moves` is true there now and this note is not
          reached. What remains is the genuine edge of the CHART -- the top-right corner on a payout, the
          bottom-left on a withhold -- where there is no cell in either direction. */}
      {/* ==================================================================
           DESIGN NOTE 998: "(double move)", NOT "(double jump)" OR "(double drop)"
          ==================================================================
          RULED, with the reasoning supplied: "The only issue with 'drop' is that it sounds like a vertical
          movement. Maybe we replace both with (double move)?"
          AND IT IS THE ONLY DIRECTION-NEUTRAL OPTION THAT IS ACTUALLY TRUE HERE, which is a stronger reason
          than symmetry. On this chart a step is horizontal UNTIL it reaches a ledge and then it is vertical
          -- `dividendStepFrom` moves right, or up from the end of a row; left, or down from the start of one.
          So "jump" and "drop" are both wrong about the geometry roughly whenever a token is near an edge, and
          #891's note records the last time this panel described the chart's shape incorrectly in print.
          ONE WORD FOR BOTH COLUMNS, so the marker means "twice as far" and never encodes a direction the
          arrow beside it is already carrying (#489: the arrow says only "becomes").
          SUPPRESSED AT THE CHART'S EDGE. A token with nowhere to go has not moved twice as far -- it has not
          moved at all -- and the note below already says so. Two contradictory parentheticals on one line
          would be worse than either alone. */}
      {steps >= 2 && projection.moves && (
        <span style={styles.dividendMoveNote}> (double move)</span>
      )}
      {!projection.moves && (
        <span style={styles.dividendMoveNote}>
          {direction === "pay"
            ? " (already at the ceiling of the chart)"
            : " (already at the floor of the chart)"}
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
     so the first paint is unchanged and the measurement corrects it a frame later.
     Design note #851: mirrored in a ref because the answer now depends on the PREVIOUS answer, and `measure`
     runs on scroll frames long after the commit that set the state. */
  const [mayPin, setMayPin] = React.useState(true);
  const mayPinRef = React.useRef(true);

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
         two forced layouts per frame for numbers that must agree with each other.
         Design note #837: THE PIN TEST READS THE RESTING HEIGHT, not the rect. Asking whether the bar fits
         while measuring a subtree whose height the answer controls is a loop, and it settled differently in
         OR 1.1 and OR 2.1 for no better reason than a few pixels. See `stickyCollapse.ts` #837.
         THE CLEARANCE STILL READS THE RECT, and the two must not be confused: "can I pin" is about the bar's
         resting form, "how much am I covering" is about the pixels actually on screen right now. */
      /* Design note #851: TWO QUESTIONS, AND ONLY ONE OF THEM APPLIES AT A TIME. An unpinned bar asks whether
         it MAY pin -- a comfort test, on the resting height. A pinned bar asks whether it is TRAPPING -- a
         reachability test, on the height actually on screen. Asking the comfort question of a pinned bar is
         what made a refusal sentence and one button drop it out of the viewport mid-decision.
         THE PREVIOUS ANSWER COMES FROM A REF, not from `mayPin`: this closure is rebuilt only when the effect
         re-subscribes, and `measure` runs on every scroll frame in between. */
      /* ==================================================================
         DESIGN NOTE 863: THE 50% RULE'S ONLY EFFECT WAS TO PREVENT RECOVERY
         ==================================================================

         REPORTED TWICE. 4d: "I accidentally clicked 'Upcoming trains' and the Action Bar zipped up to fixed
         placement/stopped being sticky; however, when I closed that Upcoming trans section, the Action Bar
         stayed pinned instead of becoming sticky again." 5d: "at least when there are 5 PCs available,
         clicking any of them forces the Action Bar to jump and pin. Like 4d before, closing the PC leaves the
         Action Bar pinned and doesn't return it to being sticky."
         I INSTRUMENTED 4d RATHER THAN FIXING IT because I could not find the fault in the release logic. It
         was never in the release logic. It is two lines above, in the seed.

         `mayPin` AND `mayPinRef` BOTH START `true` -- an assertion, not a measurement. Follow it through:
           A bar begins life claiming it may pin, so `wasPinned` is true on the very first frame, so the
           comfort test is NEVER ASKED of a bar that has not already been released. From birth until the first
           release, the bar is governed only by the 80% trapping test.
           The first release flips the ref to false. From then on the return is governed only by the 50%
           comfort test -- of a bar that was sticky at up to 80%.
         SO THE BAND BETWEEN 50% AND 80% IS A ONE-WAY DOOR. Every bar wide enough to be interesting lives in
         it: sticky by default because nothing under 80% ever released it, then permanently static because it
         cannot get back under 50%. That is exactly the two reports, and it is why closing the section changed
         nothing -- closing it was never the question being asked.

         WHICH MEANS #720's COMFORT RULE HAS NEVER ONCE DECIDED WHETHER THIS BAR IS STICKY. Its sole
         observable effect, across its whole life in this file, has been to block recovery. Confirmed by
         reading its callers: this line and the fit probe's `verdict`, which is an instrument and changes
         nothing.

         THE HYSTERESIS IS THE RESTING/ACTUAL SPLIT, NOT THE TWO CONSTANTS. #851's insight survives intact and
         is the thing worth keeping: "may I pin" is about the bar's RESTING form and "am I trapping" is about
         the pixels ACTUALLY on screen. Give both edges the trapping threshold and let the height source do
         the hysteresis, and every case lands right:
           A DELIBERATELY OPENED ROSTER OR PRIVATE CARD grows the actual height past 80% and releases (#758's
           case, unchanged). Its subtree is `STICKY_OPTIONAL`, so the RESTING height never moved -- and when
           the player closes it the bar returns, because the resting form was never the problem.
           A REFUSAL SENTENCE AND ONE BUTTON (#851's report, item 7) take the bar from 45% to 55% and change
           nothing, because 55% is not trapping. The case that motivated the 50% constant is answered by the
           80% one.
           A GENUINELY OVERSIZED BAR whose resting height is past 80% releases and stays released, which is
           the outcome #720 wanted and never actually produced.
         `canPinWithoutTrapping` IS DELIBERATELY LEFT IMPORTED for the fit probe, and #720's constant with it.
         If the comfort rule should ever bite, the honest place is the SEED -- measure the first frame instead
         of asserting it -- and that is a change in what the bar does on load, which is not what was reported
         here. Written down so the choice is a choice. */
      const wasPinned = mayPinRef.current;
      const pinnable = !shouldReleasePin(
        wasPinned ? rect.height : restingHeight(node),
        window.innerHeight,
        stickyTop,
      );
      /* ==================================================================
         DESIGN NOTE 861: A BAR THAT STOPS TRAVELLING TAKES THE PLAYER WITH IT
         ==================================================================
         REPORTED: "since I think pinning is the right action when the Action Bar takes up 80+% of the screen,
         we need to make sure that when this pin happens that the player is auto-scrolled to the top of the
         Action Bar, otherwise it seems like the Action Bar mysteriously disappeared and they are interrupted
         mid-task."
         EXACTLY THE SYMPTOM, AND THE MECHANISM IS ORDINARY CSS: a `position: sticky` element that becomes
         `static` snaps back to its place in the document, which is above the current scroll. Nothing has
         moved except the rule, and from the chair it reads as the bar vanishing upward.
         ONLY ON THE TRANSITION, never on a frame where the answer is unchanged -- a scroll handler that
         scrolls is a loop, and `measure` runs on every frame of a drag.
         AND ONLY WHEN IT UNPINS. Going the other way the bar arrives at the top of the viewport on its own,
         which is where the player already is. */
      if (wasPinned && !pinnable) node.scrollIntoView({ behavior: "smooth", block: "start" });
      mayPinRef.current = pinnable;
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
      /* Design note #837: THE VERDICT IS TAKEN ON THE SAME NUMBER THE PIN TEST USES, which is the resting
         height. It read `combined` -- the pixels on screen -- so the probe agreed with the deadlock instead of
         exposing it: it said WOULD UNPIN while the bar was unpinned BECAUSE it was unpinned, which is a
         reading that confirms whatever it finds. #828a's own warning, one turn later. */
      const resting = Math.round(restingHeight(bar));
      const verdict = canPinWithoutTrapping(resting, viewport, stickyTop)
        ? "would stay pinned"
        : "WOULD UNPIN";
      const shape = nested
        ? `bar ${barHeight} (panel ${panelHeight} inside)`
        : `bar ${barHeight} + panel ${panelHeight}`;
      /* Design note #861a: AND WHICH STATE IT IS ACTUALLY IN. Reported: "when I closed that Upcoming trains
         section, the Action Bar stayed pinned instead of becoming sticky again" -- and I could not reproduce
         it by reading, which is the same position #813 was in before it built this probe. `verdict` is what
         the rule WOULD say; `now` is what the bar is doing. If those two disagree in a playtest, the fault is
         between the measurement and the style; if they agree, the measurement is what is wrong. */
      const now = bar.getBoundingClientRect().top <= stickyTop + 1 ? "pinned" : "travelling";
      const next =
        `fit probe · ${shape} = ${combined}px · ${share}% of ${viewport}px` +
        ` · resting ${resting}px · ${verdict} · now ${now}`;
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
  onCloseRoom,
  roomClosed = false,
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
  onSkipSubPhase,
  orSequence = null,
  operatingOrder = [],
  trainPurchase = null,
  depot = [],
  gentleRust = false,
  armedErrand = null,
  mapEl = null,
  onShowMap,
  powerOffers = [],
  onUsePowerOffer,
  privatePurchase,
  onOpenPrivateTrade,
  ownsAnyTrain,
  mustBuyTrain,
  activePlayerName,
  activePlayerCash,
  activePlayerEscrow,
  actingSeatColor = null,
  privateCompanies,
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
  dividendMoveSteps = null,
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
  onRemoveRouteStop,
  stopsRemovedByRemoval,
  currentGlobalEra,
  activeTab,
  onSelectTab,
  isMyTurn,
  turnGlowActive,
  phase,
}: {
  roundType: RoundType | null;
  /** Design note #899: closes the room and settles the payout. `undefined` outside a room that can be
   *  closed, which is what keeps the button out of the bar in a local game. */
  onCloseRoom?: () => void;
  /** Whether it has already been closed -- the button stays and goes inert (#899). */
  roomClosed?: boolean;
  /** Only meaningful while `roundType === "OperatingRound"` -- see design
   *  note #10/item 2. */
  orSubPhase: OperatingSubPhase;
  sessionReady: boolean;
  onPassTurn: () => void;
  /** Design note #717: the standing-pass control. `null` where there is no such thing to offer. */
  autoPass?: {
    armed: boolean;
    /** ==================================================================
     *   DESIGN NOTE 1036: ARMING NEEDS A CONNECTION, NOT A TURN
     *  ==================================================================
     *
     * REQUESTED: "the ability to enable Auto-Pass during a Stock Round even when it is not currently their
     * turn, similar to standard digital 18xx implementations."
     *
     * AND THE BUTTON READ `sessionReady`, WHICH IS `controlsEnabled && isMyTurn`. #728 gated arming on it for
     * a sound reason -- "a standing instruction that will dispatch needs a session to dispatch through" --
     * but the flag it reached for carries a SECOND fact, and that one had no business here. Arming dispatches
     * nothing: it writes local state, and the dispatch happens later, on this player's own turn, where
     * `isMyTurn` is true by construction because the acting effect tests it itself.
     *
     * SO THE CONTROL GETS ITS OWN PREDICATE and `sessionReady` keeps its meaning for the Pass button beside
     * it, which genuinely does need the turn. One field answering two questions is #732's rule, and this is
     * the second time this batch's neighbourhood has produced it.
     *
     * `false` WHEN THE CALLER CANNOT SAY, which is the same direction #728 chose: a player who cannot reach
     * the room must not be able to set an instruction that will not run. */
    canArm: boolean;
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
    /** Design note #974: the president's seat colour, or `null` for an address the roster does not know.
     *  The shell resolves it (`seatColor` indexes the roster); this panel only paints with it. */
    presidentColor: string | null;
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
    /** Design note #1004: the models on their final run under Gentle Rust. Empty in every standard game. */
    reprievedTrains: readonly string[];
    /** Design note #1046: the Yellow Sign's gift, exempt from the limit until the round ends. */
    ghostTrains: readonly string[];
    /** Design note #1089: the gold-trimmed train, which outlives `ghostTrains` by an OR set. */
    carcosanTrains: readonly string[];
    /** Design note #1089: the permanent curse, which outlives the train itself. */
    isCarcosan: boolean;
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
     Design note #885: and the pointer to `PrivatePowerPanel.tsx` is gone with the file. `privateCompanies`
     survives the panel's removal because this component READS it, in the rust and train-limit warnings --
     which is the test #885 applies to all six of the props that did not. */
  privateCompanies: readonly PrivateCompanyState[];
  /* Design note #885: THREE ORPHANED DOC COMMENTS STOOD HERE, describing props deleted two lines apart --
     #442's "keyed by ACTION, not by private id", #725's per-action refusals "passed straight through", and
     #573b's "why the last exchange refused". Each documented a member of this interface that no longer
     exists, which is worse than an undocumented one: a reader looks for the field. #442's and #725's rules
     live on in `dhPower.ts`, which is where the D&H's ordering is computed; #573b's sentence is now a prop
     on the flow modal (#882). */
  onRunTrains: () => void;
  onPayDividends: () => void;
  onWithholdRevenue: () => void;
  /* Design note #510: `onJumpToTrainPurchase` is gone with the button it drove -- see the render site.
     Design note #517: which Operating Round this is, as the board counts them (`macro_round_number` and
     `sub_round_index`, rendered "3.2"). PASSED RATHER THAN DERIVED, because this bar has no game state.
     `null` before the first poll keeps the bare "Operating Round" wording rather than a placeholder pair. */
  /** Design note #890: the Bank Depot's tiers, always -- `buyWarnings` reads it to know what the NEXT phase's
   *  train limit will be, and that question is live all round rather than only while the buy panel is up. */
  depot?: readonly DepotTier[];
  /** Design note #1033: whether the table is playing Gentle Rust. It changes the rust countdown's WORDING and
   *  whether that one badge animates -- see `purchaseWarnings`. Defaults to `false`, so a caller that has not
   *  been taught to pass it shows the standard strings rather than nothing. */
  gentleRust?: boolean;
  orSequence?: { cycle: number; index: number } | null;
  /* ==================================================================
      DESIGN NOTE 889: WHO OPERATES NEXT, ON THE BAR THAT SAYS WHO OPERATES NOW
     ==================================================================
     ASKED: "In the Action Bar during ORs, add the Corporation Turn Order layout (flush left or flush right,
     whichever fits best alongside the Subphase order)."
     FLUSH LEFT, IN THE STATUS RAIL. The right rail holds the step caption and Undo -- controls and the name
     of the thing Undo would reverse -- while the left rail is #654's "fixed home, so the phase badge and the
     rust warning sit in the same place all game". A turn order is status of exactly that kind: it changes
     without anybody pressing anything, and it belongs where a player's eye already goes for "where are we".
     ONE ROW, NOT A TABLE. `ContextualSubPanel` has the full roster with prices; this is the ORDER, which is
     the only part of it that is about the clock. Same relationship `SeatOrderTrail` has to the Ledger.
     PASSED PRE-SORTED, because the sort is `sortForOperatingOrder`'s and reproducing it here is what #285
     records going wrong: "the table re-sorted mid-round while the actual turn order -- frozen in
     `active_operating_order` when the round opened -- did not budge." */
  operatingOrder?: readonly {
    companyId: number;
    ticker: string;
    /** The corporation's livery, for the chip's ink. */
    color: string;
    /** It has already operated this Operating Round. */
    done: boolean;
  }[];
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
   *  Owned by the shell, because the bar has no canvas.
   *  Design note #833: AN ELEMENT, NOT A REF, and the board pane rather than the pane that holds this bar.
   *  `null` means the map is not rendered -- a different tab, not "no map exists" -- so the button stays live
   *  and `onShowMap` is what makes pressing it do something. */
  mapEl?: HTMLElement | null;
  /** Design note #833: bring the Rail Map tab forward. Not a game action and it dispatches nothing (#263):
   *  it is the first half of the same jump, for a player who is looking at the Stock Market. */
  onShowMap?: () => void;
  /* ==================================================================
      DESIGN NOTE 888: THE JUMP FRAMES THE TRACK, IT DOES NOT FIND THE MAP
     ==================================================================
     REPORTED: "The 'Lay 1 Track' button ... currently auto-scrolls to the rail map, which when players are
     at the top of the screen is trivially true so it remains grayed out/disabled unless they are scrolled
     all the way down to the corporation and player subpanels."
     THE BUTTON WAS HONEST AND ITS SUBJECT HAD MOVED. `mapInView` is an IntersectionObserver at
     `threshold: 0.25` on the board PANE, so it greys the button whenever a quarter of a DOM element is on
     screen -- a fact about layout, not about whether the player can see where they may build. #833 picked
     that subject when the map genuinely needed FINDING. It does not need finding any more; it needs READING,
     and the predicate never moved with the question. A proxy that stopped standing for its subject.
     SO THE DESTINATION CHANGED AND THE GATE WENT WITH IT -- and #987 has now removed the destination too.
     `onFrameNetwork` and `canFrameNetwork` are GONE: the press frames nothing, because framing is the
     auto-camera that was ruled off. What is left of this button is a tab switch, and a tab switch always has
     somewhere to go. */
  /** ==================================================================
   *   DESIGN NOTE 846: THE POWER, WHERE A PLAYER IS ALREADY LOOKING
   *  ==================================================================
   *
   *  REPORTED as a principle: "what a player needs to do needs to be present on the screen without scrolling
   *  or guessing where they need to look." The powers subpanel is below the fold, and the Lay Track step is
   *  spent looking at the map -- so a corporation could hold the C&SL's extra lay all turn and never learn it.
   *
   *  AT MOST TWO, EVER. The fear raised with the request -- "if somehow a corporation bought all five PCs,
   *  the sticky might overwhelm the screen" -- does not arise: only the D&H's F16 lay and the C&SL's B20 lay
   *  are Lay Track powers. SV has none, M&H and C&A are share exchanges, the B&O's share arrives at purchase.
   *  `privatePowerOffer.ts` carries the working.
   *
   *  IT OPENS THE SAME PROMPT THE HEX DOES, rather than arming the errand directly. One question, asked one
   *  way, whichever door a player came through -- and it keeps this bar's rule that a chip here dispatches
   *  nothing (#263/#793). */
  /* Design note #884: `chipTitle` TRAVELS WITH THE OFFER, like `chipLabel` already does. The two producers
     had different sentences for the hover -- "Opens the question the hex asks" for the lays, "Opens the
     exchange question" for the M&H -- written inline at the two places this bar assembled the chips. Pulling
     the chips into one group would have forced a choice between one wrong sentence and a `switch` in this
     file on which power it is, which is this component writing copy about a rule it does not own (#848's
     rule, and #872's correction of two strings that had escaped it). */
  powerOffers?: readonly { abilityKey: string; chipLabel: string; chipTitle?: string }[];
  /** Raises the prompt for one of them. Absent means no chips, the same way an absent `mapEl` means no jump. */
  onUsePowerOffer?: (abilityKey: string) => void;
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
    /** Design note #1101: whether filling the train limit also ends the turn. Resolved by the shell from
     *  `autoSkipExit` and the live step list; this bar only forwards it. */
    endsTurnAtLimit: boolean;
    /** Design note #751c: opens the emergency modal, and whether the corporation is short enough to need it.
     *  Passed straight through -- the bar is a conduit, not a decider. */
    onEmergencyPurchase?: () => void;
    emergencyAvailable?: boolean;
    onProposeTrade: (proposal: TrainTradeProposal) => void;
    labelForAddress: (address: string) => string;
    /** Design note #914: the seller roster paints each president in their own seat colour. Conduit only --
     *  the bar has no roster to resolve a seat from, so the shell answers it. */
    colorForAddress?: (address: string) => string | null;
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
  /* ==================================================================
   *  DESIGN NOTE 998: HOW MANY CELLS EACH DECISION MOVES
   * ==================================================================
   * #997 PASSED TWO SENTENCES HERE and this passes two numbers instead -- see `MarketMoveLine` for why the
   * marker beat the footer.
   * THE COUNTS RATHER THAN A BOOLEAN, so this panel is told the same thing the board is told rather than a
   * predicate derived from it. `steps >= 2` is a rendering decision and belongs at the render site; "how far
   * does this decision move the token" is the rule, and it has exactly one author (`dividendStepsFor`).
   * DERIVED IN THE SHELL, from the same revenue and price the projections use. This panel holds a revenue and
   * a price of its own and could compute it -- which is precisely the split #891 exists because of: the bar
   * once promised a move the board did not perform.
   */
  dividendMoveSteps?: { pay: number; withhold: number } | null;
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
  /** Design note #1024: remove one stop and everything drawn after it. Keyed by hex label, because this
   *  panel lists PAYING stops while the array being spliced is the full walk. */
  onRemoveRouteStop?: (trainIndex: number, hexLabel: string) => void;
  /** How many drafted hexes that removal would take. The shell owns the walk; the panel only sees the stops. */
  stopsRemovedByRemoval?: (trainIndex: number, hexLabel: string) => number;
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
  /** Whether the bar should still be LIT -- design note #1008.
   *
   *  A SECOND FLAG, NOT A NARROWER `isMyTurn`. This bar reads `isMyTurn` for six things, and five of them are
   *  rules: `mayActThisTurn`, the Undo gate (#3734), which train drafts are editable, the band's identity key
   *  and the band's own class. Only the pulse is decoration. Reusing one boolean for both would mean a player
   *  who clicked anywhere lost their Undo button.
   *
   *  OPTIONAL, defaulting to `isMyTurn` at the use site, so a caller that has no acknowledgement state to
   *  offer gets exactly the pre-#1008 behaviour rather than a bar that never lights. */
  turnGlowActive?: boolean;
  /* Design note #500: `latestFeedItem` and `onOpenActivityLog` are GONE. They fed a one-line echo of
     `TopTicker`'s newest entry inside this panel, and the ticker is on the same screen. Removed rather than
     left unread -- an unused prop is an invitation to render it again.
     Derived phase (`utils/gamePhase.ts`) for the far-right badge -- design note #40 for why it moved here. */
  phase?: GamePhase | null;
}) {
  /* Design note #839: what the next purchase destroys, as badges rather than as hover text and rather than
     as a line inside a table the scroll folds away.
     Design note #7 (`gamePhase.ts`): the ONE severity decision, shared with the train chips. It used to be
     read HERE as `phaseAlert` for a badge of its own; #868 deleted that badge and #867 moved the call inside
     `purchaseWarnings`, so the severity now reaches the row through the warnings themselves. This file no
     longer has an opinion about how loud anything is -- which is what #839's note claimed and did not do. */
  /* ==================================================================
      DESIGN NOTE 890: THE LIMIT BADGE WAS READING A DEPOT THAT COMES AND GOES
     ==================================================================
     REPORTED: "When there were 2 or 1 3-trains left, the Rust and Limit badges popped up until the operating
     corporation ended their turn: then the Rust badge stayed, but the Limit badge disappeared."
     THE TWO BADGES DEPEND ON DIFFERENT THINGS AND ONLY ONE OF THEM TRAVELS. `purchaseWarnings` builds the
     rust arm from `phase` alone; the limit arm calls `limitAfterNextPhase(phase, depot)`, which looks the
     current tier up IN THE DEPOT to read the next tier's `trainLimit`. Handed `[]`, that lookup returns
     `null` and the arm is skipped -- silently, because a missing tier and a tier with no successor are the
     same answer.
     AND `trainPurchase` IS HARDWARE-ONLY BY CONSTRUCTION. `App.tsx` builds it as
     `orSubPhase === "Hardware" ? {...} : null`, which is right for a BUY PANEL and wrong as the source of a
     countdown that is true all round. So the badge vanished the moment the step turned -- not when the
     threshold cleared.
     THE DEPOT ARRIVES ON ITS OWN PROP NOW. `depotInventory` is already computed unconditionally in the shell
     and handed to the purchase panel; this asks the same value for a different reason, which is why it is a
     second prop rather than a reshaped `trainPurchase`. A warning about the next purchase is not a property
     of the step in which purchases happen. */
  /* Design note #1033: the variant reaches the countdown, because the countdown's WORDING depends on it and
     nothing else on this bar can say so. Derived from the shell rather than from `reprievedTrains` -- the
     obvious shortcut and a wrong one: marks exist only after the trigger is bought, and the two strings this
     changes are both shown BEFORE that. A proxy that is empty in exactly the case it is consulted for is
     #1006's shape. */
  const buyWarnings = React.useMemo(
    () => purchaseWarnings(phase ?? null, depot, gentleRust),
    [phase, depot, gentleRust],
  );
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
  /* ==================================================================
      DESIGN NOTE 833: A TARGET THAT MOUNTS LATER NEEDS TO BE AN ELEMENT
     ==================================================================

     A `RefObject` mutates without re-rendering, so an effect keyed on it never re-runs when the node appears.
     That is harmless for the step panel, which is mounted for the whole life of the bar; it is fatal for the
     Rail Map, which unmounts every time the player looks at the Stock Market tab. Passing the ELEMENT makes
     the identity change part of the render, so the observer re-subscribes when the pane comes back.

     THE UNION RATHER THAN A SECOND HOOK. Two implementations of one question is the failure this session has
     found repeatedly (#815's three chip rows, #829's two acronym vocabularies). One hook, two ways to name a
     node, and the resolution happens in one line below. */
  function useJumpTarget(
    target: React.RefObject<HTMLElement | null> | HTMLElement | null,
    clearance: number,
  ): [boolean, () => void] {
    const [inView, setInView] = React.useState(false);

    React.useEffect(() => {
      const node = target instanceof HTMLElement ? target : (target?.current ?? null);
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
      const node = target instanceof HTMLElement ? target : (target?.current ?? null);
      node?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, [target]);

    return [inView, scrollTo];
  }

  const [stepPanelInView, scrollToStepPanel] = useJumpTarget(stepPanelRef, barClearance);
  /* ==================================================================
      DESIGN NOTE 833: THE JUMP POINTED AT THE PANE THAT HOLDS THE BAR
     ==================================================================

     REPORTED: "if they do click it let's have the page scroll to the map?" -- which reads as a feature request
     and was a bug report. #831 attached the target to `<main>`, and `<main>` CONTAINS this action bar as well
     as everything under it. So the node the bar observed had the bar at its top edge and ran thousands of
     pixels down the page: at `threshold: 0.25` it could never be a quarter visible in a 652px viewport, so
     `mapInView` never turned true, and `scrollIntoView` landed on the top of the whole pane rather than on
     the board.

     THE MISTAKE IS THE ONE THIS SESSION KEEPS FINDING, in its third form. #824 asserted an index the board
     never had; #831 asserted a destination the ref never pointed at. A target picked because it was the
     convenient node to hang a ref on, rather than because it was the thing meant.

     `boardPane` IS THE THING MEANT, and the shell already held it in state for the radial selector -- so it
     arrives as an element and the observer follows it across a tab change. */
  /* ==================================================================
      DESIGN NOTE 987: THE MAP'S JUMP TARGET IS GONE, HOOK AND PENDING FLAG BOTH
     ==================================================================
     WHAT WAS HERE: a second `useJumpTarget` bound to the board pane, and a pending flag that waited for the
     pane to mount after a tab change so the scroll could fire on the commit after it.
     #888 ALREADY RECORDED WHY THE `inView` HALF HAD NO READER, and left the scroll half running
     unconditionally on the reasoning that "`scrollIntoView` on an element already at the top of the viewport
     moves nothing". That is true and it is also the bug: when the pane IS at the top of the document,
     scrolling it to `block: "start"` moves the PAGE to the top, which is what was reported.
     THE STEP PANEL'S OWN JUMP IS UNTOUCHED. `stepPanelInView`/`scrollToStepPanel` still serve Buy Trains and
     Buy Private, which scroll to a panel genuinely below the fold -- a different destination with a real
     journey, and not the map. Only the map's binding goes. */

  /* ==================================================================
      DESIGN NOTE 987: THE TAB SWITCH SURVIVES; THE SCROLL DOES NOT
     ==================================================================
     REPORTED: "The 'Lay 1 Track' button's attempt to center on the home station is broken (it scrolls to the
     top of the page). Remove the scroll action entirely OR FIGURE OUT HOW TO DO IT CORRECTLY."
     THE SCROLL'S FAILURE IS ITS OWN MECHANISM. `scrollIntoView({ block: "start" })` puts the target's top
     edge at the viewport's top -- so on a layout where the board pane IS near the top of the document, doing
     it correctly and scrolling to the top of the page are the same outcome. There was nothing to fix; #810's
     `scroll-margin-top` was already compensating for the sticky bar, and the destination was still the top.
     AND ON A DESKTOP-FIRST BOARD THERE IS NOTHING TO TRAVEL TO. The map is the main pane and is on screen;
     what a player on the Stock Market tab needs is the TAB, not a scroll position. That half is kept, and it
     is the half that was always doing real work -- #833 records that it was written for exactly the case
     where the pane does not exist yet.
     SO THE BUTTON IS A NO-OP WHILE THE MAP IS ALREADY SHOWING, deliberately and visibly rather than by
     accident. It is not greyed for it: #888 already fought that battle and lost it for a good reason -- a
     greyed "Lay 1 Track" reads as "you may not lay track", which is a legality answer on a navigation
     control (#732's one-channel rule), and the refusal to lay lives on the hex (#716). */
  const goToMap = React.useCallback(() => {
    if (!mapEl) onShowMap?.();
  }, [mapEl, onShowMap]);

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
      bestContrastTextColor(background) === "#f2f0eb"
        ? "rgba(255, 255, 255, 0.74)"
        : "rgba(0, 0, 0, 0.66)",
    [],
  );

  const corporationBarInk = React.useMemo(() => {
    if (!activeCorporation) {
      return {
        background: "#0f0f0f",
        border: "#2a2a2a",
        ink: "#eaf2ff",
        inkMuted: "rgba(234, 242, 255, 0.66)",
      };
    }
    const background = stationTickerColor(activeCorporation.companyId);
    const ink = bestContrastTextColor(background);
    const light = ink === "#f2f0eb";
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
  const corporationInk = "#f2f0eb";

  /* ==================================================================
      DESIGN NOTE 915: "BUY TRAINS" IS A DISCLOSURE, NOT A SUBMISSION
     ==================================================================
     REPORTED: "The 'Buy Trains' button on the Action Bar looks like a submission button, which is confusing.
     Convert this button into a functional toggle that expands and collapses the Depot/Corporation purchase
     subpanel below it."
     AND IT NEVER SUBMITTED ANYTHING -- #793 built it to SCROLL, which is the confusion: it sits in a row of
     controls that commit moves, wearing their shape, and doing something a player cannot predict from the
     label. A press that scrolls and a press that buys a train are the same gesture in the same place.
     OPEN ONLY ON AN OBLIGATION -- design note #918, correcting this note's first version. It said "open by
     default ... hiding its only means of getting one behind a closed disclosure would bury an obligation",
     and the second half of that sentence is the whole rule: the obligation is what earns the space, and a
     corporation that already owns a train has no obligation. Defaulting open for everybody spent eight
     corporations' worth of vertical space (#418) on a step most turns pass through.
     DERIVED, NOT REMEMBERED. The default is a function of the acting corporation's CURRENT train count, so
     it is re-answered whenever that count changes rather than carried between turns -- which is what stops a
     player's collapse on one corporation deciding the next corporation's opening state.
     RE-SEEDED ON THE CORPORATION, NOT ON THE COUNT, and the difference is the whole of why this is safe. An
     effect watching the TRAIN COUNT would fight the player: they collapse the panel, they buy the train, the
     count changes and it reopens under their hand at the moment they are done with it. An effect watching
     WHOSE TURN IT IS re-seeds only when a new corporation starts operating, which is exactly when a fresh
     default is wanted and when no player has expressed a preference yet.
     THE FIRST DRAFT OF THIS NOTE CLAIMED A `key` AT THE CALL SITE that did not exist -- a note describing a
     mechanism the code does not have, which is this project's third recurring bug shape written by the person
     who keeps naming it. Recorded rather than quietly corrected.
     LOCAL STATE, NOT THE LOG. Whether a panel is open is this browser's business; it changes nothing another
     client replays, so it is one of the few pieces of UI state that legitimately lives here. */
  const [trainPanelOpen, setTrainPanelOpen] = useState(false);
  /* Design note #919: the private step's own disclosure. Closed by default and not re-seeded per corporation
     -- buying a private is never compulsory, so there is no obligation for a default to answer to. */
  const [privatePanelOpen, setPrivatePanelOpen] = useState(false);
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    /* ==================================================================
        DESIGN NOTE 921: SEEDED WHEN THE STEP ARRIVES, NOT WHEN THE TURN DOES
       ==================================================================
       REPORTED: "the Buy Trains panel is starting CLOSED even when the corporation has a mandatory obligation
       to buy a train (the warning badge is visible, but the panel is shut)."
       AND #918 SEEDED AT THE WRONG MOMENT, which is the whole bug. It re-seeded when the acting CORPORATION
       changed -- the top of the turn, at the Track step -- and read `mustBuyTrain` there. A corporation is
       almost never trainless at the top of its turn: it becomes trainless MID-turn, when a phase change rusts
       its fleet, and at the top of the turn it is not standing in the Hardware step at all. So the seed
       sampled the obligation several steps before the obligation could exist, got `false`, and the panel was
       shut by the time the badge appeared beside it.
       THE KEY IS THE TURN AND THE STEP TOGETHER, as one composite string rather than two refs -- "have I
       already seeded for this situation" is then one comparison and cannot be half-updated. Arriving at
       Hardware is exactly when "must this corporation buy?" first has a meaningful answer.
       STILL NOT A DEPENDENCY ON `mustBuyTrain`: once seeded for this step the player's own toggle stands, so
       buying the train does not slam the panel shut under their hand while they weigh a second one. */
    /* `orSubPhase` rather than `orStep`, which is derived two hundred lines below this effect. Same value
       inside an Operating Round, and `roundType` is checked here instead -- reading the later binding would
       be a temporal-dead-zone error, which is how this landed the first time. */
    const inOperatingRound = roundType === "OperatingRound";
    const key = `${activeCorporation?.companyId ?? "none"}:${inOperatingRound ? orSubPhase : "none"}`;
    if (seededForRef.current === key) return;
    seededForRef.current = key;
    setTrainPanelOpen(inOperatingRound && orSubPhase === "Hardware" && mustBuyTrain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCorporation?.companyId, orSubPhase, roundType]);

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
        /* ==================================================================
            DESIGN NOTE 834: THE COUNT IS WITHDRAWN, AND THE NUMBER STAYS AT ONE
           ==================================================================

           #832 made the label read the turn's lay count, so the C&SL's extra one would show as "Lay 2 Track".

           RULED OUT BY THE PERSON WHO ASKED FOR THE COUNT: "There should actually never be a 'Lay 2 Track'
           button because a 'second' track lay is ONLY provided by the special power of a private company, for
           which we've already built a modal. The Action Bar should be used for the standard actions, let's
           leave the Special Powers where they are without trying to display them again."

           THE ARGUMENT IS ABOUT WHERE A FACT LIVES, not about whether it is true. #832 was right that nothing
           on screen said the C&SL's lay is extra, and wrong about the remedy: the private's power already has
           a surface of its own (#817's errand lifecycle, #818's modal), and a second display of it on the bar
           is the two-surfaces-one-question failure this session has found in #815 and #829 -- reached this
           time by adding the second surface deliberately.

           SO THE NUMBER IS A CONSTANT, not a `trackLays` of 1. A prop whose only reachable value is 1 is
           #788's unreachable arm wearing a variable: rendered by nothing else, and read by the next
           maintainer as a quantity that varies. It does not.
           "LAY 0 TRACK" IS STILL UNREACHABLE, as established at #832: `layEndsTrackStep` is `!isBonusLay`, so
           an ordinary lay ends the step and takes this button with it. Raised again as a maybe -- "I suppose
           'Lay 0 Track' may be necessary if a player Undo's back into the Lay Track subphase" -- and an Undo
           that returns to Track has REVERSED the lay it is undoing, so the lay is available again. One. */
        /* ==================================================================
            DESIGN NOTE 884: THE POWER CHIPS LEAVE `contextualButtons`
           ==================================================================
           REPORTED: "I don't want the PC action bar buttons to interfere with the center of the standard
           action and Skip buttons, so we need to find a way to organize them a bit."
           #846 PUT THEM HERE AND ITS ORDERING ARGUMENT IS STILL RIGHT -- "BEFORE the map jump, because a
           power is a thing you may not know you have and the map is a place you already know how to reach ...
           an opportunity before a destination". What it did not weigh is that `contextualButtons` renders
           inside the CENTRED column, so an opportunity appearing shoved Pass and Lay 1 Track sideways: the
           standard controls moved position depending on which privates a corporation happened to own.
           #309 ALREADY NAMED THAT COST in the other direction -- "switching rounds moved the buttons across
           the screen and muscle memory built in one phase missed in the next" -- and this is the same failure
           reached by owning a private instead of by changing round.
           SO THE ORDERING SURVIVES INSIDE A GROUP OF ITS OWN. `powerChips` is built once below, from the same
           `powerOffers` both branches used, and renders in the trailing rail beside Undo. */
        contextualButtons = [
          {
            key: "go-to-map",
            label: "Lay 1 Track",
            /* Design note #987: ONE THING NOW. #888 had this do two -- travel, then frame -- and described
               them as "the journey" and "the arrival". The arrival is what was moving the camera into empty
               space and it is gone; the journey is a tab switch. */
            onClick: goToMap,
            /* Design note #987: NEVER DISABLED. #888 gated this on having somewhere to frame; with the
               framing gone the only pointless press is one made while the Rail Map is already showing, and
               greying it for that is the mistake #888's own note argues against at length -- a greyed
               "Lay 1 Track" reads as "you may not lay track", which is a legality answer on a navigation
               control (#732), and that refusal lives on the hex (#716). */
            disabled: false,
            title: "Switches to the Rail Map tab. Click a hex there to lay track.",
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
                /* ==================================================================
                    DESIGN NOTE 919: THE SAME DISCLOSURE, ONE STEP OVER
                   ==================================================================
                   REPORTED: "Mirror the fix you just did for Buy Trains."
                   AND IT IS THE SAME COMPLAINT FOR THE SAME REASON: this button sits in a row of controls
                   that commit moves, wearing their shape, and scrolls. #915 argued that at length for the
                   trains step; nothing about the argument was specific to trains.
                   CLOSED BY DEFAULT AND STAYS THAT WAY, which is where it differs from #918's contextual
                   rule. Buying a private is never compulsory -- there is no state in 1830 where a
                   corporation MUST buy one -- so there is no obligation for a default to respond to, and
                   "open it when you want it" is the whole rule. #918's exception exists because a trainless
                   corporation genuinely has no choice; this step always does. */
                label: privatePanelOpen ? "Hide Privates" : "Buy Private Company",
                /* ==================================================================
                    DESIGN NOTE 943: THE STAR CAME OFF THIS BUTTON
                   ==================================================================
                   CORRECTED: "In Batch 13, I mistakenly instructed you to put the `<PrivatePowerIcon/>` on
                   the 'Buy Private Companies' button. The star represents the physical location of a private
                   company's power."
                   AND THE CORRECTION IS RIGHT ABOUT THE MARK'S MEANING. #714 put the star on hexes where a
                   power TAKES EFFECT -- it answers "something can be done here", not "a company can be
                   bought". Buying a private is a transaction in a list; using its power is an act on the
                   board, and only the second is what the board's star has ever meant. It now marks the
                   power chips (#943 on `powerChips`), which is the control that does that act. */
                onClick: () => {
                  setPrivatePanelOpen((open: boolean) => {
                    if (!open) scrollToStepPanel();
                    return !open;
                  });
                },
                /* Design note #919: never disabled, per #915 -- #797's "nothing to scroll to" is right for a
                   scroll button and backwards for a toggle, because a panel on screen is the one you want to
                   collapse. */
                title: privatePanelOpen
                  ? "Collapse the Buy Private Company panel below."
                  : "Expands the Buy Private Company panel below.",
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
                  /* Design note #915: the label SAYS WHICH STATE IT IS IN, because a toggle whose text never
                     changes is indistinguishable from a button that did nothing. #793's "one label, no
                     glyph" was right for a control with one behaviour; this one has two.
                     STILL NO GLYPH, and that is #793 honoured rather than worked around. A disclosure
                     triangle would be the obvious reach and it would claim a DIRECTION -- and the panel is
                     below the bar in document order and anywhere at all relative to the viewport, which is
                     the only direction a player experiences. Two words carry the state without asserting
                     something the button cannot know. */
                  label: trainPanelOpen ? "Hide Trains" : "Buy Trains",
                  /* Design note #915: OPENING ALSO SCROLLS, which is #793's job kept rather than replaced --
                     a panel that expands below the fold has not been shown to anybody. Closing does not
                     scroll: the player just asked for the space back. */
                  onClick: () => {
                    setTrainPanelOpen((open: boolean) => {
                      if (!open) scrollToStepPanel();
                      return !open;
                    });
                  },
                  /* Design note #915: NEVER DISABLED NOW. #797's "nothing to scroll to means nothing to
                     press" was right about a scroll button and wrong about a toggle -- a panel already on
                     screen is exactly the one a player wants to collapse, and greying the control then would
                     take the feature away in the only state it is for. */
                  title: trainPanelOpen
                    ? "Collapse the Buy Trains panel below."
                    : mustBuyTrain
                      ? "This corporation must own a train. Expands the Buy Trains panel below."
                      : "Expands the Buy Trains panel below.",
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
    /* ==================================================================
        DESIGN NOTE 871: EXCEPT THE M&H, WHICH IS A STOCK-ROUND POWER
       ==================================================================
       REPORTED: "the MH private power is pinned below the Action Bar rather than sticky with it, so it is
       easy to miss for players not scrolling up and down the page."
       THE SENTENCE ABOVE IS STILL TRUE OF BUY AND SELL -- they live in `StockRoundPanel`'s corporation cards
       and a duplicate here would be a second control surface for the same move. A private POWER is not that:
       nothing else in this round offers it, so this is its only control rather than its second.
       IT DISPATCHES NOTHING, which is what keeps #263 satisfied. The chip raises the same confirmation the
       panel's own button raises -- #846's rule, third power: "One question, asked one way, whichever door a
       player came through."

       DESIGN NOTE 881: THE SECOND HALF OF THAT SENTENCE WAS FALSE WHEN IT WAS WRITTEN, and is corrected here
       rather than deleted because it states the rule this file is still built on. The chip did raise the
       confirmation. The PANEL's button did not -- `handleUsePrivateAbility` called `runPrivateExchange`
       directly, so the two doors reached the same dispatch by different routes and only one of them asked
       first. Reported as: "clicking 'Exchange for NYC' in the Private Powers subpanel instantly completes
       the action without the modal."
       #871 DESCRIBED AN INTENTION AS AN ACCOMPLISHMENT, which is worth naming as the failure mode rather
       than as an oversight: the note was written from the chip's side, where the claim was true, and the
       sibling it asserted about was never opened. App.tsx #881 is where both doors now ask.
       NOT TURN-GATED, and that is the M&H's own rule rather than an oversight: the exchange "can be made on
       their own stock-round turn, or in the gap between any other player's or corporation's turn". The gate
       is OWNERSHIP, applied where the list is built. */
    /* Design note #884: AND THIS BRANCH KEEPS NONE. It existed only to carry the M&H chip -- the note above
       says so outright ("nothing else in this round offers it, so this is its only control rather than its
       second") -- and the chip now renders from `powerChips` in the trailing rail, in every round alike. An
       empty assignment rather than a deleted `case`, because `contextualButtons` is declared without an
       initialiser and every path has to give it one. */
    contextualButtons = [];
  }

  /* ==================================================================
      DESIGN NOTE 899: THE ONE CONTROL A FINISHED GAME STILL HAS
     ==================================================================
     REQUESTED: "Add a manual Close Room button to the UI (e.g., in the Action Bar) during the GameEnd state."
     APPENDED RATHER THAN BRANCHED, and the reason is the `else` above: that branch is "Stock & Auction", and
     `GameEnd` reaches it only by not being an Operating Round. A new `roundType === "GameEnd"` arm would have
     meant restating the whole if/else to say something the append says directly -- during `GameEnd` there are
     no contextual actions, and this is the only one.
     OFFERED TO EVERY PLAYER, per #899's idempotency: any seat may close the room, and a client whose press
     loses the race to another's is a no-op rather than an error. Electing an owner is what strands a table.
     STAYS VISIBLE ONCE CLOSED, disabled, rather than vanishing. The bar is where a player looks to find out
     what is happening; a control that disappears at the moment it succeeds leaves them wondering whether they
     pressed it. */
  if (roundType === "GameEnd" && onCloseRoom) {
    contextualButtons = [
      ...contextualButtons,
      {
        key: "close-room",
        label: roomClosed ? "Room closed" : "Close Room",
        onClick: onCloseRoom,
        disabled: roomClosed,
        title: roomClosed
          ? "The payout distribution has been dispatched for on-chain settlement."
          : "Close the room and settle the payout on-chain. Any player may do this; it closes on its own if nobody does.",
      },
    ];
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

  /* ==================================================================
      DESIGN NOTE 884: ONE GROUP, BUILT ONCE, FOR EVERY ROUND
     ==================================================================
     BOTH BRANCHES PRODUCED THE SAME MAPPING and differed only in the hover sentence, which is now carried by
     the offer (`chipTitle`). Building it here instead means the Track step and the Stock Round cannot come to
     disagree about what a power chip is -- #815's three chip rows and #829's two acronym vocabularies are
     what that disagreement looks like when it is allowed to happen.
     `mayActThisTurn` IS APPLIED, and it is the same expression `contextualButtons` gets rather than a second
     rule: `roundType !== "OperatingRound" || isMyTurn`, so a watcher during somebody's Operating Round loses
     the hex chips and the M&H's Stock Round chip is untouched. That is exactly #871's rule -- the exchange is
     "NOT TURN-GATED, and that is the M&H's own rule rather than an oversight" -- preserved without this file
     having to know which power is which. */
  const powerChips: ActionBarButton[] =
    onUsePowerOffer && mayActThisTurn
      ? powerOffers.map((offer) => ({
          key: `power-${offer.abilityKey}`,
          label: offer.chipLabel,
          /* ==================================================================
              DESIGN NOTE 943: THE BOARD'S MARK, ON THE CONTROL THAT ACTS ON THE BOARD
             ==================================================================
             CORRECTED from #936: the star belongs on "Use Power", not on "Buy Private Company". #714 draws it
             on the hex where a power takes effect, so the semantic link is between that hex and the button
             that spends the power -- a player who has seen a star on Scranton should recognise the mark on
             the chip that acts there.
             ON THE M&H CHIP TOO, ruled explicitly: "It's okay to apply the star to the MH power button as
             well. It keeps private powers consistent." My own reading had been to withhold it, since the
             M&H's exchange has no hex and the star is a LOCATION mark -- but a glyph that appears on three
             of four private powers teaches nothing except that it is unreliable, and "this is a private
             power" is the more useful thing for it to mean at the size it renders. Recorded because the
             narrower reading is the one #714's note supports, and a later reader deserves to know it was
             considered and overruled rather than missed. */
          icon: <PrivatePowerStar height={POWER_CHIP_STAR_PX} />,
          onClick: () => onUsePowerOffer(offer.abilityKey),
          disabled: false,
          title: offer.chipTitle ?? "Opens the question — nothing is spent until you answer it.",
        }))
      : [];

  /* ==================================================================
      DESIGN NOTE 884: RENDERED ONCE, PLACED TWICE
     ==================================================================
     THE TWO BRANCHES OF THIS BAR HAVE DIFFERENT RIGHT-HAND RAILS -- `orPanelRailRight` in an Operating Round,
     `actionBarRailTrail` everywhere else -- and the chips belong in both. Written out at both sites, the
     rainbow mark, the disabled treatment and the `type="button"` would be two copies to keep in step, which
     is how #619 describes the same hazard for the expanded and condensed forms of the ordinary buttons:
     "the two forms of this bar must not disagree about whether a control is available."
     AN ARRAY OF ELEMENTS RATHER THAN A COMPONENT, because the two placements are mutually exclusive by round
     -- only one rail is mounted at a time -- so there is no second instance for React to reconcile and a
     component would add a name and a props interface to carry nothing. */
  const powerChipNodes = powerChips.map((chip) => (
    <button
      key={chip.key}
      type="button"
      style={{
        ...styles.actionBarButton,
        ...styles.actionBarPowerChip,
        ...(chip.disabled || !sessionReady ? styles.actionBarButtonDisabled : {}),
      }}
      onClick={chip.onClick}
      disabled={chip.disabled || !sessionReady}
      title={chip.title}
    >
      {/* ==================================================================
           DESIGN NOTE 976: THE GRADIENT STRIP IS GONE, AND #884 WAS WRONG ABOUT WHAT IT SAID
          ==================================================================
          RULED: "Remove the vertical rainbow gradient strip from the 'Use [Private Company] Power' button."
          AGREED, AND FOR A STRONGER REASON THAN TIDINESS. #943's note beside this element claimed "The
          gradient says WHICH company; the star says what kind of thing this is." That is false, and it is
          checkable: `PRIVATE_POWER_GLOW_STOPS` is ONE array -- a fixed eight-stop hue circle, identical for
          the DH, the C&A, the M&H and every future private. Every chip drew the same strip. It never said
          which company anything was; the ACRONYM in the label does that, and always did.
          SO WHAT WAS ACTUALLY ON THE CHIP was two marks meaning "this is a private power", one of them a
          7px strip that #931 had already had to widen once because it was "too subtle to clearly link it to
          the map elements". The answer to a mark that is too weak to carry its meaning, standing beside a
          mark that carries the same meaning clearly, is not a third revision of the weak one.
          WHAT IS LOST, stated rather than glossed: #727's rainbow is still the hex halo and still the
          auction's palette, so the card -> hex association is intact everywhere it was. What goes is the
          chip's copy of it -- and the star is a stronger link to the hex than the halo was, because the star
          is drawn ON the hex (#714) while the halo is drawn AROUND it.
          `actionBarPowerChipMark` IS DELETED FROM THE SHEET TOO. An orphaned style for a rendering somebody
          has just asked us to stop using is how it comes back -- `palette.ts`'s rule for its deleted colour
          token, and #682's for `cashAfter`. */}
      {/* Design note #943: the star sits INSIDE the chip's own row, before the words. */}
      {chip.icon ? (
        <span style={styles.actionBarButtonWithIcon}>
          {chip.icon}
          {chip.label}
        </span>
      ) : (
        chip.label
      )}
    </button>
  ));


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
  /* ==================================================================
      DESIGN NOTE 1004: "Rust Imminent: [type]-train", FROM THE MARKS THEMSELVES
     ==================================================================
     RULED verbatim, including the label. Built here rather than in `purchaseWarnings` because that module
     answers "how close is the next rust" from the DEPOT, and the whole reported fault is that the depot has
     already moved past the tier these trains belong to. The marks are the only surviving record.
     ONE BADGE PER TIER, NOT PER TRAIN. A corporation with two reprieved 3-trains has one fact to state, and
     the ruled label is singular in its type ("[type]-train") rather than a count -- two identical badges
     would read as two separate warnings.
     SORTED, so two tiers under reprieve appear in a stable order rather than in whatever order the reducer
     happened to append them; an order that changed between renders would read as the badges rearranging
     themselves.
     ==================================================================
      DESIGN NOTE 1033: "Final Run", BECAUSE "Rust Imminent" NOW MEANS THE STEP BEFORE THIS ONE
     ==================================================================
     #1004 RULED THIS LABEL VERBATIM as "Rust Imminent: [type]-train" and it is superseded, not drifted.
     RULED NOW: "Once the phase-change train is purchased and the trains are in their reprieved/final-run
     state, the badge must dynamically update to read 'Final Run: [type]-trains'."
     AND THE OLD LABEL BECAME AMBIGUOUS THE MOMENT THE COUNTDOWN GOT ONE. #1033 gives the pre-purchase badge
     "Rust Imminent:" at one buy away, so keeping it here would put the identical words on two badges meaning
     two different things -- the trigger is one purchase away, versus the trains are condemned and running
     their last. Two states, one string, is the #891 shape this project keeps finding.
     PLURAL, following the ruling's own example ("Final Run: 2-trains"). #1004 argued for the singular type on
     the grounds that a count would read as two warnings; the plural here is a category, not a count, and it
     is what the corporation is looking at -- every 2-train it holds is on its last run, not one of them. */
  /** Design note #1034: the trains this corporation holds that occupy a limit slot, and the phrase naming the
   *  ones that do not. Both derived here so the figure and its explanation cannot disagree -- the failure
   *  #979 was reported for, one surface up. `null` rather than an empty string when nothing is exempt, so the
   *  render can drop the whole parenthetical rather than emit "()" in every standard game. */
  const countableTrains = countableTrainCount(
    activeCorporation?.trains,
    activeCorporation?.reprievedTrains,
    activeCorporation?.ghostTrains,
  );
  const reprievedNames = React.useMemo(() => {
    const marks = activeCorporation?.reprievedTrains ?? [];
    if (marks.length === 0) return null;
    return Array.from(new Set(marks))
      .sort()
      .map((tier) => `${tier}-trains`)
      .join(", ");
  }, [activeCorporation]);

  const reprieveWarning = React.useMemo(() => {
    const marks = activeCorporation?.reprievedTrains ?? [];
    if (marks.length === 0) return null;
    const tiers = Array.from(new Set(marks)).sort();
    return {
      label: `Final Run: ${tiers.map((tier) => `${tier}-trains`).join(", ")}`,
      detail:
        tiers.length === 1
          ? `This corporation's ${tiers[0]}-train has already rusted. Gentle Rust lets it run once more; it is destroyed at the end of this turn's Run Routes step.`
          : `These trains have already rusted. Gentle Rust lets them run once more; they are destroyed at the end of this turn's Run Routes step.`,
    };
  }, [activeCorporation]);

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
        /* Design note #1008: the pulse now ends on the player's first click. #597's argument is untouched --
           a sustained state deserves a sustained animation -- but "it is still your turn" stops being news
           the moment they have shown they know. `?? isMyTurn` keeps a caller that passes nothing exactly
           where it was. */
        ...((turnGlowActive ?? isMyTurn) ? styles.actionBarTurnPulse : {}),
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
      {/* ==================================================================
           DESIGN NOTE 946: THE TITLE JOINED THE ROW IT WAS SITTING ABOVE
          ==================================================================
          REPORTED: "We need to save vertical space in the Action Bar. Currently, 'Operating Round 1.1' sits on
          its own line, with the subphase sequence and corporation turn order on a separate line below it.
          Consolidate these: the Round Title, subphase sequence, and corporation turn order must all sit on
          the exact same horizontal line."
          THE TITLE WAS A BARE `<span>` BESIDE A `<div>`, which is the whole of the bug: `orProgressRow` is a
          block, so it broke the line however narrow its contents were. Nothing about the two facts wanted
          separating -- #920 had already argued the trail and the order belong together, and the label is the
          third member of that family for the same reason (#630: "one place to look for 'how far through are
          we'").
          THE ROW RENDERS IN EVERY ROUND NOW, not only an Operating Round, because the label does. Its two
          Operating-Round children keep their own conditions, so a Stock Round gets a row with one child in it
          -- which lays out identically to the bare span it replaces. */}
      <div style={styles.orProgressRow}>
        <span style={styles.actionBarRoundLabel}>
          {roundType === "OperatingRound"
            ? orSequence
              ? `Operating Round ${orSequence.cycle}.${orSequence.index}`
              : "Operating Round"
            : roundType === "StockRound"
              ? /* ==================================================================
                    DESIGN NOTE 964: THE STOCK ROUND HAS A NUMBER TOO
                   ==================================================================
                   REPORTED: "Ensure the Stock Round title includes its round number (e.g., 'Stock Round 1')."
                   AND #517 ALREADY MADE THIS ARGUMENT for the Operating Round: "'Operating Round' alone named
                   the KIND of round in a game that runs several back to back, so a player reading a log line
                   about 'OR 3.2' had nothing to match it against." The Stock Round is the same shape and was
                   simply left out -- and `roundLabelFor` has been stamping "SR2" on log entries the whole
                   time, so the feed and the bar disagreed about whether this round had an identity.
                   `orSequence.cycle` IS `macro_round_number`, which numbers BOTH kinds of round -- the prop is
                   named for the caller that needed it first, not for the field. Using it here is reading the
                   same number the log reads rather than adding a second source; the alternative was a new
                   prop carrying a value this one already holds. */
                orSequence
                ? `Stock Round ${orSequence.cycle}`
                : "Stock Round"
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
      {/* ==================================================================
           DESIGN NOTE 920: TWO PROGRESS TRACKS, ONE ROW
          ==================================================================
          REPORTED: "The corporation turn order in the OR is rendering on the same row as the Action Bar
          buttons and warning badges, creating clutter. Move the corporation turn order to the same row as the
          subphase order, aligned flush right."
          AND THEY ARE THE SAME KIND OF FACT, which is why this reads as tidier rather than merely rearranged.
          #630 already made this argument for the seat trail: "it answers 'where are we in the rotation', the
          same question the sub-phase trail answers for a corporation's turn. So it moves under the round
          label. One place to look for 'how far through are we'." The corporation order is the third member of
          that family and was the one left in the button row.
          FLUSH RIGHT VIA `marginLeft: auto` ON THE ORDER, not `justify-content: space-between` on the row --
          the trail must stay left-anchored when the order is absent (a Stock Round, or a round with no queue),
          and `space-between` would centre a lone trail. */}
      {/* ==================================================================
           DESIGN NOTE 964: THE SEAT TRAIL JOINS THE ROW THE LABEL IS IN
          ==================================================================
          REPORTED: "The player turn order in the Auction and Stock rounds has incorrectly dropped to a second
          line. Restore them to the exact same horizontal row as the round title."
          AND #946 IS WHY IT DROPPED. That note moved the round label INTO `orProgressRow` to put the Operating
          Round's three facts on one line -- and left this sibling outside the div, where it had always been
          harmless because the label was a sibling too. Moving one of a pair into a container puts the other
          on its own line; the regression is the shape of the fix, not a separate fault.
          THE SAME ROW SERVES BOTH ROUNDS, which is #630's own argument: the seat trail and the sub-phase
          trail "answer 'where are we in the rotation'", and they are mutually exclusive by round type, so one
          row holds whichever the round has. */}
      {roundType !== "OperatingRound" && seatOrderTrail}
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
          {/* Design note #889: the turn order, beside the phase. `done` dims rather than removes -- a
              row that shortens as the round goes on stops being an ORDER and becomes a queue, and the
              question "have they gone yet" is the one a player asks about the corporations behind them.
              The acting corporation is already named across the top of this bar, so it is not marked
              again here; what this row adds is everyone else. */}
          {operatingOrder.length > 0 && (
            <span style={styles.orTurnOrder} aria-label="Corporation turn order this Operating Round">
              {operatingOrder.map((entry) => (
                <span
                  key={entry.companyId}
                  style={{
                    /* Design note #930: THE LIVERY IS THE ACTIVE STATE'S ALONE. Every chip used to carry its
                       corporation's colour on both border and ink, which turned a sequence into eight
                       unrelated objects and left no way to scan the row for a position. The inactive ones
                       take the sub-phase trail's neutral treatment now; only the operating corporation is in
                       full colour. */
                    ...styles.orTurnOrderChip,
                    ...(entry.done
                      ? styles.orTurnOrderChipDone
                      : styles.orTurnOrderChipUpcoming),
                    /* ==================================================================
                        DESIGN NOTE 945: THE INK CARRIES IDENTITY; THE BOX STILL CARRIES ORDER
                       ==================================================================
                       REPORTED: "The acronym text for the inactive corporations should be rendered in their
                       respective corporate colors, but appropriately desaturated so they don't compete with
                       the active corporation's badge."
                       WHICH PARTLY REVERSES #930, and the reversal is narrower than it looks. That note
                       stripped the livery from every inactive chip because "eight unrelated objects" left no
                       way to scan the row -- but its evidence was about BORDER AND FILL, which stay uniform
                       here. Only the letters take colour, so the strip still reads as one control.
                       WRITTEN AFTER THE `done`/`upcoming` SPREADS so it overrides their flat `#8a90a0`, and
                       BEFORE the acting-chip block below so a filled chip's computed contrast ink still wins.
                       Order is the whole mechanism; a reader moving this line changes which colour survives. */
                    ...(entry.companyId === activeCorporation?.companyId
                      ? {}
                      : { color: desaturatedLiveryInk(entry.companyId) }),
                    ...(entry.companyId === activeCorporation?.companyId
                      ? {
                          backgroundColor: entry.color,
                          borderColor: entry.color,
                          /* Design note #889: the ink is COMPUTED, not a constant. A livery fill with a
                             livery-coloured label is invisible on half the roster, and a fixed dark ink
                             is invisible on the other half -- `bestContrastTextColor` is the same
                             helper the acting-seat badge below uses for the same reason. */
                          color: bestContrastTextColor(entry.color),
                        }
                      : {}),
                  }}
                  title={
                    entry.companyId === activeCorporation?.companyId
                      ? `${entry.ticker} is operating now.`
                      : entry.done
                        ? `${entry.ticker} has already operated this Operating Round.`
                        : `${entry.ticker} operates later this Operating Round.`
                  }
                >
              {entry.ticker}
                </span>
              ))}
            </span>
      )}
      </div>
      {/* Design note #630: BOTH ROUNDS PUT THEIR TRACK IN THE SAME PLACE. It was in the BUTTON row because that
         is where the roster pills it replaced sat (#342) -- and a pill carrying spendable cash did belong next
         to the controls that spend it. `SeatOrderTrail` is not that: it answers "where are we in the rotation",
         the same question the sub-phase trail answers for a corporation's turn.
         So it moves under the round label. One place to look for "how far through are we", holding whichever
         track this round has; the two are mutually exclusive by round type, so this costs no height.
         AND THE MONEY IS NO LONGER WHY IT IS THERE -- #631's seat card carries the acting player's figures
         beside the controls, which is the part of #342 that was about proximity to the buttons. */}
      {/* Operating Round turn stepper, directly under the round label it elaborates: the label says WHICH step,
         the strip says where that step sits in the turn. Operating Round only -- a strip elsewhere would be
         inventing structure.
         Design note #212: READ-ONLY in every mode now, sandbox included. Its only control is Skip, which
         dispatches the real `AdvanceOperatingSubPhase` -- see that component's #1 for why a clickable sandbox
         strip made the one place that tests turn order unable to test it. */}
      {/* ==================================================================
           DESIGN NOTE 925: THE TARGETING BANNER IS GONE
          ==================================================================
          REPORTED: "a new text panel pops up saying 'Placing station token — click a city hex on the Rail
          Map.' Remove this panel entirely. The player's cursor already changes to a herald icon; we do not
          want to sacrifice screen real estate for redundant text."
          AND #159'S PREMISE EXPIRED. It argued "a crosshair on the canvas only reads while the pointer is
          OVER the canvas -- a player who armed the mode and then looked at a panel has no way to tell it is
          still on." The cursor is a HERALD now rather than a crosshair, which is legible at a glance and
          specific to this corporation, and the veil lights the placeable hexes at the same time. Two signals
          the banner was compensating for the absence of.
          NOBODY IS STRANDED BY LOSING ITS CANCEL. `handlePlaceStationTokenHint` is a real toggle -- pressing
          the arming button again disarms it, and its own log line says so -- and #388's effect drops the mode
          on leaving the Tokens step. The banner's Cancel was a third way out, not the only one, which is what
          makes this a removal rather than a trade. */}

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
                      {/* Design note #1091: only once the train is gone -- while it is held, the chip's own sign says it. */}
                      {activeCorporation.isCarcosan && activeCorporation.carcosanTrains.length === 0 && (
                        <CarcosaMark meaning="corporation" size={12} />
                      )}
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
                  {/* ==================================================================
                       DESIGN NOTE 974: A PLATE, SO THE SEAT COLOUR CAN BE ITSELF
                      ==================================================================
                     REPORTED: "When buying private companies or trains from other corporations, it is hard
                     to tell at a glance who owns the active corporation. Update the president designation
                     ... use a neutral background badge, render the player's name in their specific player
                     color, and include the yellow crown icon."
                     THE PLATE IS WHAT MAKES THE COLOUR POSSIBLE, and that is the whole of why this needs
                     three changes rather than one. #236 paints this entire bar in the ACTING CORPORATION's
                     livery, which is why every other figure on it takes a derived `corporationBarInk`
                     rather than a fixed one. A seat colour laid straight onto that is eight hues over eight
                     liveries -- sixty-four contrast pairs, several of them a seat colour on top of very
                     nearly itself, and the failure is silent: the name does not vanish, it just stops being
                     legible on the two boards where it matters.
                     A NEUTRAL PLATE COLLAPSES THAT TO EIGHT. `rgba(0,0,0,0.5)` is one ground, so each seat
                     colour has to be legible against exactly one thing, and it is the same ground whichever
                     corporation is acting -- which is also what stops the badge itself flickering hue as the
                     turn passes round the table.
                     #779's RULE STILL DECIDES WHEN NOT TO. An address off the roster gets no colour, and
                     then the badge falls back to the bar's own muted ink -- "a wrong colour is worse than
                     none", so the fallback is the reading it had before this note rather than a guess.
                     THE CROWN GOES GOLD, WHICH IS A CORRECTION AND NOT A DECORATION. It has been taking
                     `currentColor` here, so it was rendering in the corporation's muted ink -- a different
                     colour on this surface than on `ContextualSubPanel`'s table, where #552's crown is
                     `#c9a94c`. One mark, two colours, decided by which panel you were looking at. Now the
                     crown is the constant and the NAME is the variable, which is the arrangement that lets
                     a player read "crown = president, colour = who" instead of decoding both together. */}
                  {activeCorporation.presidentLabel && (
                    <span
                      style={{
                        ...styles.orContextPresident,
                        color: activeCorporation.presidentColor ?? corporationBarInk.inkMuted,
                      }}
                    >
                      {/* Design note #552: our own crown, not U+1F451 -- the same drawing every other surface
                          uses. Design note #974: and in the badge gold every other surface gives it, set
                          explicitly because the name beside it no longer supplies a `currentColor` the crown
                          should follow. */}
                      <PresidentCrown
                        scale={0.95}
                        style={{ marginRight: "3px", color: PRESIDENT_CROWN_GOLD }}
                      />
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
                      reprieved={activeCorporation.reprievedTrains}
                      // Design note #1088: already on the bar's corporation since #1046 -- it gates the limit.
                      ghosts={activeCorporation.carcosanTrains}
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
                          countableTrains >= phase.trainLimit ? "#e0c97a" : corporationBarInk.ink,
                      }}
                      title={
                        (countableTrains >= phase.trainLimit
                          ? `At the limit — ${phase.tier}-phase corporations may hold ${phase.trainLimit}. The Buy Trains step is skipped automatically.`
                          : `${phase.tier}-phase corporations may hold ${phase.trainLimit} trains.`) +
                        (reprievedNames === null
                          ? ""
                          : ` Its ${reprievedNames} are on a final run and do not count toward the limit.`)
                      }
                    >
                      {/* A bare "2 / 4" beside a row of train chips reads as
                          a second count OF those chips. Naming it is the
                          whole fix: the number was never ambiguous to
                          anyone who already knew what it was. */}
                      {/* ==================================================================
                           DESIGN NOTE 1034: THE FIGURE AND ITS EXEMPTION, TOGETHER
                          ==================================================================
                          RULED: "we have to find some way to indicate that the trains have one run left AND
                          that they don't count to the train limit ... we might do that PLUS add an additional
                          parenthetical to the Train Limit like (Gently Rusting: 3-trains)".
                          THE PARENTHETICAL IS WHY THE NUMBER IS BELIEVABLE. Without it this line reads "2 / 2"
                          beside three chips, which looks like the bar miscounting the fleet in front of it --
                          and a player who distrusts one figure on this bar has no way to tell which others to
                          trust. It is placed here rather than on the capacity pill because this line has the
                          room for the full phrase and sits beside the Final Run badge naming the same trains.
                          ABSENT WHEN THERE IS NOTHING TO EXEMPT, so a standard game's bar is untouched. */}
                      Train limit: {countableTrains} / {phase.trainLimit}
                      {reprievedNames !== null && (
                        <span style={{ color: corporationBarInk.inkMuted }}>
                          {" "}
                          (Gently Rusting: {reprievedNames})
                        </span>
                      )}
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
              {/* Design note #920: THE TURN ORDER MOVED OUT OF THIS RAIL. It sat beside the phase badge,
                  on the same row as the contextual buttons and the rust/limit warnings -- three unrelated
                  kinds of thing competing for one line. It now shares the sub-phase trail's row, which is
                  where it belongs by SUBJECT: both answer "how far through are we", one within a
                  corporation's turn and one across the round. See the trail above. */}
              {/* Design note #325: TWO POCKETS, ONE ROW, CONSTANT CONFUSION. #300 added personal cash here so a
                 president facing an emergency buy could see what they can cover -- true, and the placement was still
                 wrong: this rail sits directly under the corporation strip, which shows `Treasury $X` in the same
                 typeface at the same size, and the tooltip explaining that they are different pockets only opens if you
                 already suspected they were. An Operating Round spends the CORPORATION's money, so the figure had no
                 decision on this screen to inform.
                 IT IS NOT DELETED, IT IS MOVED -- #326 hangs it off the president's own name. The auction and Stock
                 Round branch keeps its badge (#308): there the money IS the player's. */}
          {/* ==================================================================
                    DESIGN NOTE 868: THE BADGE THAT ONLY SAID SOMETHING WAS COMING
                  ==================================================================
                  ASKED: "I'm wondering if we can combine the Phase and Phase Change badges? and I'm wondering if
                  we need the Phase Change notification for every phase or only the two that shift from Yellow to
                  Green and Green to Brown?"
                  THE BADGE IS GONE AND ITS JOB IS SHARED OUT. "Phase Shift Imminent" named an event rather than a
                  consequence -- every phase change is a phase change -- while the two badges beside it were
                  already saying what this particular one would DO. The era change was the one fact none of them
                  carried, so it becomes the third warning rather than the generic one staying.
                  NOT SUPPRESSED ON THE OTHER THREE, which was the other half of the question and would have been
                  the wrong move: 3->4, 5->6 and 6->D are the RUST transitions, so filtering to era changes would
                  silence the row exactly when trains are about to be destroyed. Those three are covered by the
                  rust and limit badges instead, and `purchaseWarnings.test.ts` asserts the whole table.
                  THE `phase.label` TAG ABOVE STAYS SEPARATE. Current state and what is coming are two facts, and
                  a chip that is always present but sometimes red would be carrying both on one channel -- #732's
                  rule, and the reason the two were not merged.
                  WHAT WENT WITH IT: `phaseAlert`, and #839's note about the tooltip it used to carry. That note's
                  argument survives in `purchaseWarnings.ts`, which is where the sentence it was defending now
                  lives. */}
              {/* Design note #839: the two facts the phase badge used to whisper. Same row, same shape and the
                  same escalation -- a warning drawn differently from the warning beside it reads as a different KIND
                  of thing, which is the distinction #732 keeps on one channel. */}
              {/* ==================================================================
                   DESIGN NOTE 1005: THE BADGES KEEP TO ONE LINE
                  ==================================================================
                  REPORTED: "The Warning badges on certain Action Bar subphases are spilling into a second
                  row."
                  AND THE BADGES WERE NEVER THE THING WRAPPING. `phaseShiftBadge` already carries
                  `whiteSpace: nowrap` and `flexShrink: 0`, so no badge has ever broken internally -- what
                  wraps is `orPanelRailLeft`, which is `flexWrap: wrap` and has been since it was written.
                  A GROUP RATHER THAN `nowrap` ON THE RAIL, which is the narrow fix. The rail wraps on purpose:
                  #482 records that it holds a phase badge, a round label and a variable number of warnings in
                  a column that must yield rather than drag the centre rail sideways. Forbidding it to wrap at
                  all would trade a second row of badges for a rail that overflows its own track. Grouping the
                  badges means they wrap TOGETHER, as one unit, and never against each other. */}
              <span style={styles.orWarningGroup}>
                {reprieveWarning && (
                  /* ==================================================================
                      DESIGN NOTE 1004: THE WARNING SURVIVES THE PHASE CHANGE
                     ==================================================================
                     REPORTED: "the red/amber warning badges and flashing train chips immediately disappear
                     for the reprieved trains", with the fix ruled: "retain a persistent warning badge reading
                     'Rust Imminent: [type]-train' for any corporation holding gently rusted trains until they
                     are destroyed."
                     IT IS NOT A COUNTDOWN AND SO IT IS NOT A `buyWarning`. Those are derived from the depot --
                     "N purchases away" -- and the whole problem is that the depot has moved on. This badge is
                     derived from the corporation's own marks, which is the only place the fact still lives,
                     and it is true until the reducer clears them (#1001).
                     THE SAME PULSE AS THE CHIPS IT DESCRIBES, ruled explicitly, so a player's eye ties the
                     badge to the trains rather than reading two unrelated warnings. */
                  <span
                    className="app-train-final-run"
                    style={{ ...styles.phaseShiftBadge, ...styles.phaseShiftBadgeCritical }}
                    aria-label={reprieveWarning.detail}
                  >
                    &#9888; {reprieveWarning.label}
                  </span>
                )}
                {buyWarnings.map((warning) => (
                  <span
                    key={warning.key}
                    className={warning.pulses ? "app-phase-shift-critical" : undefined}
                    style={{
                      ...styles.phaseShiftBadge,
                      ...(warning.imminent ? styles.phaseShiftBadgeCritical : styles.phaseShiftBadgeWarn),
                    }}
                    aria-label={warning.detail}
                  >
                    &#9888; {warning.label}
                  </span>
                ))}
              </span>
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
                 told to a watcher it is an instruction they cannot follow.
                 ==================================================================
                  DESIGN NOTE 835: THE HINT MOVES BELOW THE BUTTONS AND CHANGES ITS SUBJECT
                 ==================================================================
                 REPORTED: "there's a character string: 'Click a laid preview to rotate it.' This should be in
                 the tutorial, not printed on the Action Bar." Rotation is a RULE of the interface -- true on
                 every lay in every Operating Round for the rest of the game -- and #800 settled where those
                 belong: "a player meets it once, rather than on a bar that repeats it every Operating Round".
                 It is now on the tutorial's Lay Track slide.
                 WHAT REPLACES IT IS NOT A RULE BUT A DESTINATION, asked for in the same breath: "maybe below
                 the 'Lay 1 Track' and 'Skip Track' buttons you can place a character string: 'Click a hex on
                 the Rail Map to lay track.'" That is #279's own test for the sentence it kept -- "it says
                 where the action IS, which the player cannot otherwise know" -- and it is the answer to the
                 misreading that prompted all of this: the button looks like it performs the lay, so the line
                 under it names the thing that actually does.
                 BELOW, NOT BEFORE. It rendered first in a wrapping flex row, so it sat to the LEFT of the
                 controls it describes. `orPanelStepHint` claims a full row, and it renders after Skip. */}
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
                  {/* Design note #936: matched to the collapsed bar below, per #619's rule that the two
                      forms of this bar must not disagree about a control. */}
                  {btn.icon ? (
                    <span style={styles.actionBarButtonWithIcon}>
                      {btn.icon}
                      {btn.label}
                    </span>
                  ) : (
                    btn.label
                  )}
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
              {/* Design note #835: the line under the pair. See the note above the button group for why this
                 sentence and not the rotation one, and why it renders here rather than first.
                 ==================================================================
                  DESIGN NOTE 870: THE SENTENCE HAD NO STATE, SO IT RODE OVER THE MAP
                 ==================================================================
                 REPORTED: "we added the character string 'Click a hex on the Rail Map to lay track.' below the
                 two Action Buttons, but this eats up some vertical space that is needed for viewing the map."
                 AND THE SHAPE OF THE FIX, on being told the wrong diagnosis: "the sentence IS appearing when
                 the Action Bar is sticky, it isn't only displayed when the Action Bar is pinned. If that were
                 the behavior it would be completely fine, no change needed."

                 EXACTLY SO, AND #835 SIMPLY NEVER ASKED. The line rendered on `mayActThisTurn && Track` and
                 nothing else, so it was drawn in every state the bar has -- including the one where the bar
                 is stuck to the top of the viewport and travelling over the board a player is trying to read.
                 `orPanelStepHint` claims `flexBasis: 100%`, so it is a whole row of map, spent restating a
                 destination the player has already reached.

                 THE GATE IS `mayPin`, WHICH IS THE DISTINCTION THE REPORT DRAWS. A bar that MAY pin travels
                 with the scroll and covers the top of the viewport; a bar that may not is `position: static`
                 (#720), parked in the document above the map, and costs nothing to make one line taller. So
                 the sentence appears where a player is looking at the BAR and is absent where they are
                 looking at the MAP -- which is also the only place it was ever useful.
                 NOT `condensed`. That flag means "has stuck and travelled", which would keep the line while
                 the bar sits at rest at the top of the page with a sticky future ahead of it -- true for most
                 of a turn, and the row would then vanish mid-scroll. `mayPin` is a property of the bar's
                 SHAPE and does not flicker as the player moves.

                 THE BUTTON IS UNCHANGED, and that was the other half of the answer. The report opened by
                 proposing "Select a Hex to Lay 1 Track" as a label; the reply withdrew it -- "no change
                 needed" -- once the real behaviour was named. #834's constant "Lay 1 Track" stands. */}
              {mayActThisTurn && orSubPhase === "Track" && !mayPin && (
                <span style={styles.orPanelStepHint}>Click a hex on the Rail Map to lay track.</span>
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
              {/* Design note #890: NOT IN DIVIDENDS, where the readout below now says what is happening in
                  far more detail than this sentence does. The line exists so the centre column does not read
                  as a panel that failed to load; a payout table is not an empty column. It stays for every
                  other step, where an inactive viewer genuinely has nothing in front of them. */}
              {!mayActThisTurn && orSubPhase !== "Dividends" && (
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
              {/* Design note #884: THE POWER CHIPS, AHEAD OF THE STEP CAPTION AND UNDO. #451's sentence above
                 -- "the right rail, which the grid keeps clear of the centred group, so adding it moves
                 nothing" -- is the whole argument for putting them here: the D&H's and C&SL's chips appear
                 and vanish with ownership and with the Track step, and in the centre that motion dragged
                 Skip and Lay 1 Track sideways with them.
                 SAME NODES AS THE OTHER BRANCH RENDERS, so the two forms of this bar cannot disagree about
                 what a power chip looks like or when it is live. */}
              {powerChipNodes}
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
          {/* ==================================================================
               DESIGN NOTE 855: THE DETAIL BELONGS TO THE CHIP THAT OPENS IT
              ==================================================================

              REPORTED: "when a player clicks the train chips with the revenue, the route information (e.g.
              G19 > F20 > etc) opens *below the action panel* in a fixed spot above the rail map. This needs to
              be rendering inside the Action Panel, below the train chips."

              #802 MOUNTED IT AS A SIBLING OF THE STICKY ELEMENT, not inside it -- in the same trailing
              fragment as the private-powers panel, which is a separate surface and belongs there. So the
              disclosure opened somewhere the bar had already scrolled away from, and the two halves of one
              control were in different places on the page. #828's sentence, exactly: "anything inside it
              follows" -- and anything outside it does not.

              UNDER THE ROW RATHER THAN UNDER THE BUTTONS. The chips are the control; a disclosure that opens
              anywhere but immediately beneath its trigger makes the reader find it. It is the same placement
              rule #835 applied to the Track hint one step over.

              AND IT COSTS NOTHING IN RESTING HEIGHT, because it is a disclosure a player opened on purpose:
              #851's release test asks whether the bar is TRAPPING, at 80% of the viewport, so one route line
              cannot unpin the bar the way a content change did before that pass. */}
          {showRouteReadout && (
            <RouteChipDetail
              draft={openDraft}
              canClear={mayActThisTurn && sessionReady}
              onClearRoute={onClearRoute}
              /* Design note #1024: the granular edit, beside the global one. */
              onRemoveStop={onRemoveRouteStop}
              stopsRemovedBy={stopsRemovedByRemoval}
              onClose={() => setOpenTrainIndex(null)}
              /* #802: the panel's click feedback had nowhere else to go. A refused draft explaining itself
                 here beats it explaining itself nowhere, which is what deleting the panel would otherwise
                 have done. */
              feedback={mayActThisTurn ? routeFeedback : null}
            />
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
          {/* ==================================================================
                DESIGN NOTE 890: THE DIVIDEND READOUT IS FOR THE TABLE, NOT THE PRESIDENT
              ==================================================================
              ASKED: "Let's change this so that non-active players can see the operating corporation's payout
              and withhold information -- essentially duplicate the operating corporation's subpanel across
              all players' action bars (without the action buttons)."
              #691 GATED IT AND ITS REASON IS WITHDRAWN, on report. That note argued: "the payout table and
              the two market moves are the INPUTS to Pay and Withhold (#509). With those buttons gone on an
              inactive screen, the inputs describe a choice the reader is not making -- and the round's own
              result reaches them through the Activity Log either way."
              BOTH HALVES TURN OUT TO BE WRONG ABOUT 1830. The payout table is not only an input to a
              decision: it says what every OTHER player is about to be paid, which is a fact about their own
              cash and the only place it is stated before it happens. And "the Activity Log either way" is
              after the fact -- a shareholder watching a president choose wants to know what the choice is
              worth to them WHILE it is being made, which is the same argument #705 made for showing both
              ends of the transfer rather than a bare delta.
              THE BUTTONS STAY GATED, which is the distinction that makes this safe: `mayActThisTurn` still
              guards Pay and Withhold four hundred lines up, so what travels is the READOUT and not the
              controls. #740's rule -- "eight greyed buttons on four screens describe somebody else's
              decision" -- is about controls, and it is untouched. */}
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
                  steps={dividendMoveSteps?.pay ?? 1}
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
                  steps={dividendMoveSteps?.withhold ?? 1}
                />
              </div>
              {/* Design note #998: #997's EXPLANATION FOOTER WAS HERE and is gone. It rendered the two
                  sentences from `dividendStepsExplanation` beneath both columns -- correct, and one layer of
                  prose too many: the figures directly above it already state the outcome, and #509a settled
                  this exact question one panel over ("SHOW THE MONEY MOVING, DO NOT DESCRIBE IT"). The fact
                  the sentences carried that the figures did not is "this move is twice the usual", and that
                  is now two words on the line itself. */}
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
          {/* ==================================================================
                DESIGN NOTE 868: THE BADGE THAT ONLY SAID SOMETHING WAS COMING
              ==================================================================
              ASKED: "I'm wondering if we can combine the Phase and Phase Change badges? and I'm wondering if
              we need the Phase Change notification for every phase or only the two that shift from Yellow to
              Green and Green to Brown?"
              THE BADGE IS GONE AND ITS JOB IS SHARED OUT. "Phase Shift Imminent" named an event rather than a
              consequence -- every phase change is a phase change -- while the two badges beside it were
              already saying what this particular one would DO. The era change was the one fact none of them
              carried, so it becomes the third warning rather than the generic one staying.
              NOT SUPPRESSED ON THE OTHER THREE, which was the other half of the question and would have been
              the wrong move: 3->4, 5->6 and 6->D are the RUST transitions, so filtering to era changes would
              silence the row exactly when trains are about to be destroyed. Those three are covered by the
              rust and limit badges instead, and `purchaseWarnings.test.ts` asserts the whole table.
              THE `phase.label` TAG ABOVE STAYS SEPARATE. Current state and what is coming are two facts, and
              a chip that is always present but sometimes red would be carrying both on one channel -- #732's
              rule, and the reason the two were not merged.
              WHAT WENT WITH IT: `phaseAlert`, and #839's note about the tooltip it used to carry. That note's
              argument survives in `purchaseWarnings.ts`, which is where the sentence it was defending now
              lives. */}
          {/* Design note #839: the two facts the phase badge used to whisper. Same row, same shape and the
              same escalation -- a warning drawn differently from the warning beside it reads as a different KIND
              of thing, which is the distinction #732 keeps on one channel. */}
          {buyWarnings.map((warning) => (
            <span
              key={warning.key}
              className={warning.pulses ? "app-phase-shift-critical" : undefined}
              style={{
                ...styles.phaseShiftBadge,
                ...(warning.imminent ? styles.phaseShiftBadgeCritical : styles.phaseShiftBadgeWarn),
              }}
              aria-label={warning.detail}
            >
              &#9888; {warning.label}
            </span>
          ))}
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
                ...(!autoPass.armed && !autoPass.canArm ? styles.actionBarButtonDisabled : {}),
              }}
              onClick={autoPass.armed ? autoPass.onDisarm : autoPass.onOpenSettings}
              /* Design note #728: never disabled while armed. Arming is gated because a standing instruction
                 that will dispatch needs a session to dispatch through; clearing one is a local state write
                 that needs nothing. A dropped connection must not trap a player inside a setting that keeps
                 taking their turns.
                 Design note #1036: THE GATE IS `canArm`, NOT `sessionReady`. The reasoning above is about the
                 CONNECTION and the flag it used to read also carried whose turn it is -- so the control was
                 dead for the whole round except on the one turn a player least needs it. */
              disabled={!autoPass.armed && !autoPass.canArm}
              title={
                autoPass.armed
                  ? "Auto-Pass is on for this Stock Round. Click to turn it off."
                  : autoPass.canArm
                    ? "Pass automatically until something happens that affects you, or the Stock Round ends. You can set this at any point in the round."
                    : "Auto-Pass needs a live connection to the room."
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
              {/* Design note #936: the mark and the words are one row, so a wrapping label cannot leave the
                  star orphaned on the line above. */}
              {btn.icon ? (
                <span style={styles.actionBarButtonWithIcon}>
                  {btn.icon}
                  {btn.label}
                </span>
              ) : (
                btn.label
              )}
            </button>
          ))}
          {/* Design note #881: THE DIVIDER GOES WITH UNDO, for #540's reason applied one step further. That
             note's rule is that "a divider needs something on both sides"; with Undo moved to the trailing
             rail there is nothing to its right in this group, so a rule here would be a bar at the end of a
             row -- the same empty-sided divider #540 was reported for, arrived at by moving the neighbour
             instead of by the neighbour being absent. The rule above `contextualButtons` still has the
             group on both sides and stays. */}
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
          {/* ==================================================================
                DESIGN NOTE 881: THE TRAILING RAIL HAS A TENANT, AND IT IS UNDO
              ==================================================================
              REPORTED: "in the Stock Round the 'Undo Last Action' button is not flush right in the action bar
              like it is in the Operating Rounds, and I don't know why."

              BECAUSE THE TWO BRANCHES PUT IT IN DIFFERENT COLUMNS. `orPanelActionRow` has a genuine right
              rail -- #451 put Undo in it explicitly, and its note says why in a sentence that reads as a
              prediction of this bug: "It sits in the right rail, which the grid keeps clear of the centred
              group, so adding it moves nothing." This branch's grid has the same three columns (#426/#654)
              and Undo was the LAST ITEM OF THE CENTRE GROUP, so it was centred along with Pass -- flush
              right only by accident, whenever the group happened to be wide enough to reach the edge.

              #654 IS WHY IT LOOKED SETTLED. That pass found this grid had "three columns and two children"
              and fixed the count by adding an EMPTY trailing rail: "the trailing rail carries nothing and
              exists to be the third grid column ... An empty element as layout is worth defending because it
              looks like something to delete." The defence was right about the element and wrong about the
              emptiness -- the OR branch's third column was never empty, and the branch being mirrored had
              had a tenant for it since #451. So the rail stops being a spacer and becomes what its sibling
              already is.

              `aria-hidden` HAD TO GO WITH THE CHANGE, and it is the sharp edge here rather than the layout.
              It was correct for a decorative spacer and is a bug the moment the element contains a control:
              `aria-hidden` on an ancestor hides the whole subtree, so Undo would have rendered, been
              clickable with a mouse, and been invisible to a screen reader and skipped by keyboard focus --
              a control that is present, functional and unreachable. `undoStepLabel`'s counterpart in the OR
              branch is not hidden either.

              THE STEP CAPTION DOES NOT COME WITH IT. #451's pair -- "`Undo` alone answers 'can I take that
              back'; `Track undo` answers 'take back what I did in Track'" -- is an Operating Round fact:
              this branch has no sub-phases, so there is no step to name and the caption would be a label
              with nothing to say. */}
          <span style={styles.actionBarRailTrail}>
            {/* ==================================================================
                  DESIGN NOTE 884: THE POWER CHIPS, LEFT OF UNDO
                ==================================================================
                ASKED: "I don't want the PC action bar buttons to interfere with the center of the standard
                action and Skip buttons, so we need to find a way to organize them a bit."

                THE TRAILING RAIL IS THE CORNER THAT MEANS "not one of this step's centred controls" -- the
                Operating Round's own right rail is described in exactly those words (#451: "always-available
                utilities, never sub-phase specific, so they do not belong in the centre"). Putting the chips
                here makes the centre INVARIANT: Pass, Auto-Pass and the step's own button sit in the same
                place whether or not the viewer owns a private.

                NOT THE LEAD RAIL, which was the other candidate and is the wrong neighbourhood. That rail
                carries the phase badge and `buyWarnings` -- countdowns to a loss. A private power is the
                opposite kind of thing: it EXPANDS what a player may do, and the rule this project settled is
                that those are not drawn as warnings. A chip beside a rust warning is that distinction
                collapsing on the one channel #732 keeps clear.

                LEFT OF UNDO, not right of it. Undo is the last thing on the bar in both rounds and moving it
                would undo #881 one note later; and the chips are an opportunity while Undo is a way back,
                so reading order puts the offer before the retreat. */}
            {powerChipNodes}
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
          </span>
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
      {/* ==================================================================
           DESIGN NOTE 859: THE PANEL NEVER HAD THE BAR'S WIDTH TO DIVIDE
          ==================================================================
          REPORTED: "we had discussed making this subpanel double columned ... Instead it is still sitting
          under Buy Trains from the Bank", and then, decisively: "the current version has two columns appear
          in half the width of the Action Bar, when actually each column should be half the width of the
          Action Bar."
          THIS WRAPPER HAD NO STYLE AT ALL. `styles.actionBar` is a WRAPPING FLEX ROW, so an unstyled child is
          a flex item sized to its own content, sharing a line with the corporation card and the button row.
          #838's `repeat(auto-fit, minmax(320px, 1fr))` then had a content-width box to fit columns into --
          one column at first, and two crammed inside that narrow box the moment the train limit changed the
          content enough to cross 640px. The grid was right and the container was never asked to be wide.
          `flexBasis: 100%` CLAIMS THE ROW, which is how a wrapping flex container is told "this child gets a
          line of its own". Then #838's grid divides the bar rather than a fragment of it. */}
      <div ref={stepPanelRef} style={styles.stepPanelRow}>
      {/* Design note #691: THE PANEL THE REPORT NAMES. The depot table, its quantity selector and its Buy
          button are the largest block in this bar, and on three of four screens they were furniture. */}
      {/* Design note #715: THE STEP'S OWN CONTROLS, ON THE STEP. Reported: the purchase panel "should maybe
          be a subpanel like 'Buy Trains' instead of something you only see by actively clicking into it."
          Rendered on the same condition as the depot below it -- acting player, right sub-phase, data
          present -- so the two purchase steps of a turn have one shape. */}
      {/* Design note #919: unmounted when collapsed, like the trains panel -- a disclosure that leaves its
          contents tabbable has not collapsed anything. */}
      {mayActThisTurn && orStep === "BuyPrivate" && privatePurchase && privatePanelOpen && (
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
      {/* Design note #915: the toggle's subject. Unmounted rather than hidden, so a collapsed panel costs no
          layout and cannot be tabbed into -- a disclosure that leaves its contents reachable is the "hidden
          behind disabled CSS" shape this project has been asked to avoid elsewhere. */}
      {mayActThisTurn && orStep === "Hardware" && trainPurchase && trainPanelOpen && (
        <TrainPurchasePanel
          depot={trainPurchase.depot}
          buyer={trainPurchase.buyer}
          companies={trainPurchase.companies}
          sessionReady={sessionReady}
          canAct={trainPurchase.canAct}
          blockedReason={trainPurchase.blockedReason}
          onBuyFromBank={trainPurchase.onBuyFromBank}
          /* Design note #1101: resolved by the shell, which owns the step list -- see the panel's prop.
             A `{...}` comment is JSX CHILDREN syntax and is a parse error inside an attribute list; the
             plain block form is what the neighbouring props already use. */
          endsTurnAtLimit={trainPurchase.endsTurnAtLimit}
          onEmergencyPurchase={trainPurchase.onEmergencyPurchase}
          emergencyAvailable={trainPurchase.emergencyAvailable}
          onProposeTrade={trainPurchase.onProposeTrade}
          labelForAddress={trainPurchase.labelForAddress}
          colorForAddress={trainPurchase.colorForAddress}
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

      {/* Design note #885: `<PrivatePowerPanel>` rendered here, with eleven props. Deleted -- App.tsx #885
          records what it held, where each piece went, and why its rules table went with it rather than being
          rehomed. The power chips in this file's #884 are what a player uses now.
          A JSX-CHILD COMMENT, in braces. The first draft of this note was a bare block comment in the same
          position, which is not a comment at all here -- JSX renders it as TEXT, so the bar would have worn
          three lines of design note across it. Valid between ATTRIBUTES, never between children. */}
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
      {/* Design note #855: `RouteChipDetail` MOVED INTO THE BAR, beneath the chip row that opens it. It
          rendered here -- outside the sticky element -- so a chip in a travelling bar opened a panel that
          stayed behind. See the chip row for the note. */}
      {!sessionReady && (
        <span style={styles.sidebarHint}>Initialize the session key above to enable these actions.</span>
      )}
    </>
  );
}

/** Design note #47: the credit's hover/focus states, which inline styles
 *  cannot reach. Kept next to the tab bar's own escape hatch so this file
 *  has one place where raw CSS lives rather than several. */
