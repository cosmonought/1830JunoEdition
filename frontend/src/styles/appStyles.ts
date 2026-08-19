// frontend/src/styles/appStyles.ts
//
// THE SHARED INLINE-STYLE TABLE, lifted out of `App.tsx` unchanged.
//
// This module is a MOVE, not a rewrite. Every declaration below is the same
// object literal `App.tsx` carried at the bottom of the file, in the same
// order, with the same comments -- so `git log -p` on a style still reads as
// one continuous history rather than as a deletion and an unrelated
// creation. Nothing here is new, and nothing that was here was dropped.
//
// WHY IT MOVED. `styles` alone was 988 of `App.tsx`'s 9,636 lines, and it is
// read by five separate components (`TopBar`, `MarketMoveLine`,
// `ContextualActionBar`, `MainTabBar` and `AppShell` itself). A table with
// five consumers is shared infrastructure, and shared infrastructure that
// lives inside one of its consumers forces every other consumer to import
// from that consumer -- which is how a file becomes a hub that cannot be
// split. Hoisting it into `styles/`, alongside the existing `typography.ts`
// and `palette.ts` tokens it already reads from, makes the dependency point
// the way it always logically pointed.
//
// The phase-badge tints ride along because `PHASE_TINT_STYLES` is a
// `React.CSSProperties` map keyed by phase tint -- the same kind of thing,
// consumed by the same components, and separating it from `styles` would put
// two halves of one lookup in two files.

import React from "react";

import { CONTROL_PADDING, FONT_SIZE, LINE_HEIGHT } from "./typography";
import {
  ALERT_CRITICAL_BG,
  ALERT_CRITICAL_BORDER,
  ALERT_CRITICAL_INK,
  ALERT_WARN_BG,
  ALERT_WARN_BORDER,
  ALERT_WARN_INK,
  TURN_PULSE_INK_RGB,
} from "./palette";
import type { GamePhase } from "../utils/gamePhase";

export const NEUTRAL_PHASE_BADGE: React.CSSProperties = {
  borderColor: "#3a4055",
  backgroundColor: "#1b1f29",
  color: "#a8b0c0",
};
export const PHASE_TINT_STYLES: Readonly<Record<GamePhase["tint"], React.CSSProperties>> = {
  yellow: NEUTRAL_PHASE_BADGE,
  green: NEUTRAL_PHASE_BADGE,
  brown: NEUTRAL_PHASE_BADGE,
};

export const styles: Record<string, React.CSSProperties> = {
  /* ---- Design note #34: the single slim top bar. ----
     `padding` is 6px vertical against the old header's 16px, and the brand
     drops from `display` to `strong`: the point of the consolidation was
     vertical space, so the row has to actually be short or nothing was
     gained by merging. `flexWrap` stays on -- the sandbox phase switcher
     genuinely can overflow on a narrow window, and wrapping is a better
     failure than a clipped Connect button. */
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "6px 20px",
    backgroundColor: "#1a1d26",
    borderBottom: "1px solid #2a2e3a",
    boxSizing: "border-box",
    flexWrap: "wrap",
    rowGap: "6px",
  },
  /* ---- Design note #36: the phase badge and its warning. ----
     Both are `flexShrink: 0` and `whiteSpace: nowrap`: the top bar wraps
     rather than clips, and a phase label broken across two lines in a slim
     bar reads as a layout fault. */
  actionBarSpacer: { flex: 1, minWidth: "8px" },
  phaseBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.03em",
    padding: "3px 10px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  // Design note #7 (`gamePhase.ts`): the shell is shared, the two severity
  // steps below supply the colour. Both read the same `ALERT_*` constants as
  // `TrainBadges.tsx`'s chips, so the bar and the chips cannot escalate to
  // different colours for the same countdown.
  phaseShiftBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.02em",
    padding: "3px 9px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    flexShrink: 0,
    cursor: "help",
  },
  phaseShiftBadgeWarn: {
    borderColor: ALERT_WARN_BORDER,
    backgroundColor: ALERT_WARN_BG,
    color: ALERT_WARN_INK,
  },
  phaseShiftBadgeCritical: {
    borderColor: ALERT_CRITICAL_BORDER,
    backgroundColor: ALERT_CRITICAL_BG,
    color: ALERT_CRITICAL_INK,
    animation: "app-phase-shift-pulse 1.4s ease-in-out infinite",
  },
  /* Design note #47: muted by default, brightening on hover -- a credit
     should be findable without competing with the game's own chrome. */
  netaCredit: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    letterSpacing: "0.02em",
    color: "#94a3b8",
    textDecoration: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
    paddingLeft: "2px",
  },
  topBarBrand: {
    fontWeight: 700,
    fontSize: FONT_SIZE.strong,
    letterSpacing: "0.02em",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  // Pushes the connection cluster right. A spacer element rather than
  // `marginLeft: auto` on the first right-hand child, because which child
  // is first varies (the offline badge and the two error spans are all
  // conditional) and an `auto` margin on a node that sometimes does not
  // render silently un-pins the whole group.
  topBarSpacer: { flex: 1, minWidth: "8px" },
  topBarDot: {
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    flexShrink: 0,
    cursor: "help",
  },
  topBarAddress: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    color: "#9aa0ac",
    whiteSpace: "nowrap",
  },
  topBarButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "999px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#c7cbd4",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  // The one call to action in the bar, so it is the one thing in it with a
  // filled treatment.
  topBarConnectButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "999px",
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
    color: "#7fe0d0",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  topBarError: {
    fontSize: FONT_SIZE.small,
    color: "#e07a7a",
    maxWidth: "240px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  // ---- Room strip -- design notes #1/#22. Sits between the brand header
  // and the nav tabs, in the same #0F172A recessed tone `TopTicker`'s
  // expanded body and `Lobby`'s panels use, so the two screens read as one
  // application. ----
  // Design note #34: `roomStrip` the container is gone -- its children are
  // inline content in `topBar` now. The `roomStrip*` item styles below are
  // kept because those children still exist and still need their look.
  spectatorNotice: {
    width: "100%",
    padding: "14px 28px",
    backgroundColor: "#1a1710",
    borderTop: "1px solid #3a2f14",
    borderBottom: "1px solid #3a2f14",
    color: "#e0c07a",
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    boxSizing: "border-box",
  },
  // ---- Global action bar (design note #30). Sits above the phase panel,
  // visually part of the page chrome rather than of either phase's own
  // card layout -- which is the point: these two actions are constant
  // while everything below them changes. ----
  globalActionBar: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
    width: "100%",
    padding: "12px 20px",
    marginBottom: "14px",
    backgroundColor: "#1b2130",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2f3646",
    borderRadius: "10px",
    boxSizing: "border-box",
  },
  globalActionBarLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.6px",
    textTransform: "uppercase",
    color: "#7f8798",
  },
  globalActionButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a4055",
    backgroundColor: "#242c3d",
    color: "#e6e8ef",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // the disabled look is computed, never assumed.
  globalActionButtonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  globalActionBarHint: { fontSize: FONT_SIZE.small, color: "#8a90a0" },
  // ---- Sandbox phase switcher (design note #25). Violet, matching the
  // sandbox badge beside it, so it reads as part of the debug affordance
  // and never as a gameplay control. ----
  phaseToggleGroup: { display: "flex", gap: "4px", flexShrink: 0 },
  phaseToggleButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#4a3a6a",
    backgroundColor: "#1a1424",
    color: "#9a8ab0",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  phaseToggleButtonActive: {
    backgroundColor: "#3a2a56",
    borderColor: "#7a5aa8",
    color: "#e8d8ff",
  },
  sandboxBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "#2a1e3a",
    border: "1px solid #6a4a8a",
    color: "#c9a8e8",
    flexShrink: 0,
  },
  spectatorBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "#3a2f14",
    border: "1px solid #6a5a24",
    color: "#e0c07a",
    flexShrink: 0,
  },
  roomStripLabel: { display: "inline-flex", alignItems: "center", gap: "6px" },
  roomStripValue: { color: "#e6e8ef", fontWeight: 700 },
  roomStripDivider: { width: "1px", alignSelf: "stretch", minHeight: "16px", backgroundColor: "#2a3a52" },
  roomStripError: { color: "#f0b0a8", fontSize: FONT_SIZE.small },
  appRoot: {
    display: "flex",
    flexDirection: "column",
    // Design note #13/item 1: was a hard `height: "100vh"` -- clipped this
    // whole column (and everything inside it) to exactly one viewport-worth
    // of pixels no matter how tall the actual board content needed to be.
    // `minHeight` keeps the same "fills at least the full viewport on a
    // short screen" look, but lets the column grow taller than 100vh when
    // real content (the now-un-shrunk map canvas) needs more room, so the
    // BROWSER's own page scrollbar carries the rest instead of an inner
    // pane's.
    minHeight: "100vh",
    width: "100%",
    /* Design note #599: the SEED only. The real value is measured from the
       dock and applied inline -- a constant here was right while the dock had
       one height, and became "the log covers the page" the moment it could
       grow. Kept as the pre-measurement default so the first paint does not
       start with the footer over the content. */
    paddingBottom: "96px",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    backgroundColor: "#12141a",
    color: "#e6e8ef",
  },
  // Design note #12/item 5 (Upper Brand Header): fonts, badges, and wallet
  // fields all upscaled roughly 40-60% past their original small-print
  // sizes so the absolute topmost bar reads comfortably on a widescreen
  // panel, matching the same "fill the real estate" intent already applied
  // to the map/stock canvases.
  //: no container, amber. Reads as a SCORE.
  // $JUNO: contained pill, teal, bordered. Reads as a REAL ASSET -- see the
  // comment at the render site for why the two are deliberately different
  // kinds of object rather than two rows of the same kind.
  nativeBalancePill: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "6px",
    padding: "4px 12px",
    borderRadius: "999px",
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
  },
  nativeBalanceAmount: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.heading,
    fontWeight: 600,
    color: "#5fd4c4",
  },
  nativeBalanceDenom: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: "#7fb3ad",
  },
  offlineBadge: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "6px",
    border: "1px solid #6b5a24",
    backgroundColor: "#2a2413",
    color: "#d9b95c",
    cursor: "help",
  },
  button: {
    fontSize: FONT_SIZE.strong,
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  errorText: {
    fontSize: FONT_SIZE.body,
    color: "#e07a7a",
    maxWidth: "280px",
  },
  // ---- Main tabs -- see design note #9, upscaled by design note #12/item
  // 5 (Primary Navigation Tabs): bigger text and generous click padding so
  // "Rail Map" / "Stock Market" / "Financial Ledger" / "Rules Reference"
  // read as clear, comfortably-clickable primary navigation. ----
  // Design note #20/item 3: `#0F172A` background here matches
  // `TopTicker.tsx`'s own expanded-body slate, and `mainTabButtonActive`
  // below now shares `TopTicker.tsx`'s exact header color (`#1E293B`) --
  // together these let the active tab flow directly into the ticker
  // docked beneath it with no color seam or border line.
  /* ==================================================================
   *  DESIGN NOTE 299: THE TABS WERE A HEADING WEARING A BUTTON'S BORDER
   * ==================================================================
   *
   * REPORTED: the main tabs are quite tall and push the chat and activity
   * rows down.
   *
   * They were 14px of padding above and below a `heading`-sized label --
   * the same type step a panel TITLE uses -- which is roughly a 47px
   * control for a one-word destination. The tab bar added another 14px of
   * its own above that, so the row cost about 60px before anything in it
   * had been read.
   *
   * A tab is a navigation control, not a section heading. It takes the
   * `control` step like every other clickable thing in the app, and the
   * padding comes down to a standard compact button. The label is
   * unchanged and still reads at a glance -- what shrank is the empty
   * space around it. */
  /* ==================================================================
   *  DESIGN NOTE 456: THE TAB ROW HAD NO ESCAPE
   * ==================================================================
   *
   * REPORTED: the "? Tutorials" button overflows its container.
   *
   * The row is a flex line with no `flexWrap` and no `minWidth: 0` on its
   * children, and Tutorials is pinned right past an `auto` margin. Flex
   * items refuse to shrink below their content width by default, so once
   * four or five tab labels plus the button exceed the bar, nothing gives
   * -- the row simply runs past its own padding, and the item on the far
   * side of the auto margin is the one that visibly leaves.
   *
   * `flexWrap` is the fix and `rowGap` is what makes it survivable: a
   * wrapped row needs vertical separation or the second line collides with
   * the first. The bottom padding goes from `0` to `6px` for the same
   * reason -- the original `6px 16px 0` assumed exactly one line and let
   * the active tab's edge sit flush with the panel below it.
   *
   * `alignItems: center` because a wrapped Tutorials button is shorter than
   * a tab and would otherwise stretch. */
  mainTabBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    rowGap: "6px",
    padding: "6px 16px",
    backgroundColor: "#0F172A",
    boxSizing: "border-box",
    maxWidth: "100%",
  },
  /* ---- Design note #46: every tab is visibly a control. ----
     The resting border was `#2a2e3a` against a `#1a1d26` bar -- barely a
     shade apart, so an unselected tab had no edge and read as recessed
     rather than clickable. It is now a crisp slate line on a slightly
     inset fill, which is what makes the row legible as a set of buttons
     before anyone hovers anything. */
  mainTabButton: {
    // Design note #299: `control`, not `heading` -- a tab is a button.
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: "7px 18px",
    borderRadius: "10px 10px 0 0",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(51, 65, 85, 0.85)",
    borderBottomWidth: 0,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    color: "#94a3b8",
    cursor: "pointer",
  },
  /* The active tab is the only WHITE-edged thing in the bar, and the only
     one with a lift. It also keeps `#1E293B` so it still docks seamlessly
     into the panel below (design note #7 in `TopTicker.tsx`). */
  /* Design note #456: condensed. At `8px 16px` beside a `control`-sized
     label this was the widest single item in the row and the first thing to
     be pushed out. It is a secondary control -- it opens a reader over the
     current screen rather than navigating -- so it can afford to be smaller
     than the tabs it sits beside. `flexShrink` lets it give way before the
     row breaks, and `minWidth: 0` is what actually permits that: without
     it a flex item will not shrink below its content. */
  tutorialsButton: {
    flexShrink: 1,
    minWidth: 0,
    padding: "6px 10px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a5a8a",
    backgroundColor: "#16202e",
    color: "#9ec5ff",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  mainTabButtonActive: {
    backgroundColor: "#1E293B",
    color: "#ffffff",
    fontWeight: 700,
    borderColor: "rgba(255, 255, 255, 0.8)",
    borderBottomColor: "#1E293B",
    boxShadow: "0 -1px 6px rgba(0, 0, 0, 0.35)",
  },
  // ---- Active Player Turn Notifications -- design note #18/item 4. A
  // full-viewport, `pointerEvents: "none"` overlay so the pulsing glow
  // reads as a page-level "your turn" signal around the viewport margin,
  // never intercepting clicks meant for the real UI underneath it. ----
  turnPulseOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none",
    zIndex: 800,
    animation: "app-turn-pulse-glow 1.6s ease-in-out infinite",
  },
  sidebarHint: {
    fontSize: FONT_SIZE.control,
    color: "#6f7480",
    margin: "0 0 4px",
  },
  canvasPane: {
    /* ==================================================================
     *  DESIGN NOTE 600: `flex: 1` MEANS `flex-basis: 0`, AND THAT IS THE BUG
     * ==================================================================
     *
     * REPORTED, twice: "the Action bar no longer travels down the screen as
     * the player scrolls." The first fix -- removing a `position: relative`
     * that had overridden `sticky` -- was a real bug and not this one.
     *
     * A sticky element travels only within its PARENT'S BOX. This pane is
     * the action bar's parent, and `flex: 1` expands to `1 1 0%` -- a
     * flex-basis of ZERO, grown to fill the flex line. In a column whose
     * container is `min-height: 100vh`, that line is one viewport tall. So
     * this pane computed to roughly the viewport height while its CONTENT --
     * the bar, the auction dashboard, the player cards -- ran far past it and
     * simply overflowed.
     *
     * The bar was sticking perfectly. It had a few pixels of parent to stick
     * within, reached the bottom of that box, and scrolled away with it.
     *
     * WHY THE AUCTION SHOWED IT FIRST: the effect scales with how far the
     * content overruns the pane, and the auction stacks six private-company
     * cards, the action bar and a row of player cards on one tab. The same
     * fault was present everywhere and simply had less to give it away.
     *
     * `1 0 auto`: still grows to fill a short page (which is what `flex: 1`
     * was here for -- design note #13 wanted the pane to claim the full
     * height rather than sit in a box), but its basis is now its CONTENT, so
     * it is never shorter than what it holds. `flex-shrink: 0` because a
     * pane that shrinks below its content is the state this note is about.
     *
     * NOT VERIFIED IN A BROWSER, and worth saying: this is reasoned from the
     * flex spec rather than watched. Three earlier CSS causes were checked
     * and ruled out first (no `overflow` on any ancestor, no `position`
     * override, no competing stacking context) -- but if the bar still fails
     * to travel, this note is the next thing to disbelieve. */
    flex: "1 0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    // Design note #13/item 1: was `overflow: "auto"` -- exactly the "tiny
    // panel box" internal scrollbar this item asks to remove. Dropped
    // outright: with no `overflow` set, this pane simply grows to its
    // content's real height (the board canvas's now-un-shrunk natural
    // size), same as any ordinary block content, and the page scrolls.
    padding: "20px",
  },
  // ---- Contextual Top Action Bar -- see design note #8/item 5, upscaled
  // by design note #12/item 5 (Gameplay Action Top Bar): larger button
  // font/padding and a taller bar overall so the dynamic header action
  // layout reads clearly at widescreen scale. ----
  /* ---- Design note #31: THE slim bar. Was a tall panel because three
   * trays lived inside it; those are separate blocks below it now, so this
   * is a single row of controls and is styled as page chrome rather than as
   * a card. ---- */
  /* ==================================================================
   *  DESIGN NOTE 297: THE CONTROLS FOLLOW THE PLAYER DOWN THE PAGE
   * ==================================================================
   *
   * The board is taller than the viewport by design (`HexGridRenderer`
   * design note #30 -- the page scrolls rather than the map), which means
   * scrolling to see the southern hexes takes the action panel off the top
   * of the screen. The two controls a player needs while looking at the
   * map -- Place Token, Skip -- are the two that leave first.
   *
   * Sticky rather than fixed: fixed would take the bar out of flow and
   * leave a gap where it was, and it only needs to stop at the top of the
   * scroll container it already lives in.
   *
   * IT CONDENSES WHEN IT STICKS, because a pinned bar is a permanent
   * subtraction from the map. Design note #298 covers what is dropped and
   * why the choice is not arbitrary. */
  /* ==================================================================
   *  DESIGN NOTE 426: PLAIN `sticky top-0`
   * ==================================================================
   *
   * REPORTED: the bar should use standard `sticky top-0` behaviour, so it
   * only collapses when it actually reaches the top of the screen.
   *
   * `position: sticky; top: 0` was already here and is kept verbatim --
   * what stopped it behaving that way was `marginBottom`, below. A sticky
   * element's margin travels with it, so the bar reserved 12px of empty
   * space beneath itself for the whole scroll, and it detached from the
   * viewport edge 12px early. The margin moves to the CONTENT that follows,
   * which is where the gap was actually wanted.
   *
   * `zIndex: 50` stays: sticky does not create a stacking context on its
   * own, and without it the panels scrolling underneath paint over the bar
   * at exactly the moment it is doing its job. */
  actionBar: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    display: "flex",
    // Row, not column: the round label sits inline with the controls now
    // that nothing else shares the container.
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
    /* Design note #295: the action strip's own height. At 10px vertical
       padding around a 19px control this bar ran past 60px; with the type
       scale at 14px it lands inside the 44-52px band the layout targets,
       and `maxHeight` stops a wrapped row from silently growing past it. */
    padding: "6px 12px",
    backgroundColor: "#1b2130",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2f3646",
    borderRadius: "10px",
    /* Design note #426: no `marginBottom`. See above -- a sticky element's
       own margin scrolls with it and offsets it from `top: 0`. The gap is
       now the following content's `marginTop`, which stays put. */
  },
  // Active Player Turn Notifications -- design note #18/item 4. Spread onto
  // `actionBar` alongside its base style, not replacing it, so the bar's
  // own layout/padding/background are unaffected -- only the border color
  // and the shared pulsing-glow animation are added.
  /* Design note #298: the pinned form. Vertical padding halves and the
     bar loses its rounding against the top edge -- it is now a chrome
     element rather than a card, and a floating rounded card that never
     moves reads as a stuck modal. */
  /* ---- Design note #390: the wrong-tab redirect ----
     The bar becomes one centred control. Padding grows because it is now
     the only thing in the strip and a lone button pinned left in a
     full-width bar reads as a leftover rather than as the point. */
  actionBarRedirect: {
    justifyContent: "center",
    padding: "14px 16px",
  },
  actionBarRedirectButton: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    padding: "10px 22px",
    letterSpacing: "0.02em",
    backgroundColor: "#2f6fb2",
    borderColor: "#4d8ee0",
    color: "#f2f7ff",
  },
  actionBarCondensed: {
    padding: "3px 12px",
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.45)",
  },
  actionBarTurnPulse: {
    // Design note #35: crisp silver rather than the old `#c0392b`. Bright
    // enough to read as lit against `actionBar`'s dark fill, and it no
    // longer competes with the auction's red contested ring.
    borderColor: `rgba(${TURN_PULSE_INK_RGB}, 0.75)`,
    animation: "app-turn-pulse-glow 1.6s ease-in-out infinite",
  },
  /* ==================================================================
   *  DESIGN NOTE 481: THE SUB-PHASE, BESIDE THE TITLE
   * ==================================================================
   *
   * Sized and coloured to read as a CONTINUATION of `actionBarRoundLabel`
   * rather than as a second heading: same uppercase treatment and letter
   * spacing, one step lighter in weight and colour. "OPERATING ROUND ·
   * LAY TRACK 2/5" should scan as one line, because it is one fact --
   * where the turn is -- split across two spans only because half of it is
   * conditional.
   *
   * `whiteSpace: nowrap` because the bar wraps (`flexWrap` on `actionBar`),
   * and a step name broken across two lines inside a wrapping row is how a
   * 48px bar becomes a 70px one. */
  actionBarSubPhaseInline: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#d7dce5",
    whiteSpace: "nowrap",
    /* The separator is drawn rather than typed: a literal "·" in the JSX
       would need its own span to be spaced correctly and would be read
       aloud by a screen reader as "middle dot". */
    paddingLeft: "10px",
    borderLeft: "1px solid #2f3646",
  },
  /* The position, deliberately quieter than the name. A player reads
     "Lay Track" every turn and "2/5" only when they want to know how much
     of the turn is left, so the two should not compete. */
  actionBarSubPhaseCount: {
    fontWeight: 700,
    color: "#8f98a8",
  },
  actionBarRoundLabel: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
  },
  /* ==================================================================
   *  DESIGN NOTE 426: TRUE-CENTRED, WHICH THE SPACER PAIR WAS NOT
   * ==================================================================
   *
   * REPORTED: true-centre the action buttons (Skip / Undo).
   *
   * This row -- Pass Turn, the contextual buttons, Undo -- was a flex line
   * with a `flex: 1` spacer before the group and another after it, and
   * design note #309 described that as centring: "a leading spacer balances
   * the trailing one that already pins the phase badge, which centres the
   * group between them without either rail having to know what the other
   * holds."
   *
   * Two equal spacers do centre the group BETWEEN THEMSELVES. They do not
   * centre it on the bar, because the phase badge sits outside the trailing
   * spacer and the leading spacer has nothing balancing it -- so the whole
   * group is pushed left by exactly the badge's width, and by more when the
   * badge escalates to its wider alert wording. The buttons drifted as
   * phase text changed, which is the tell.
   *
   * `1fr auto 1fr` is the same grid `orPanelActionRow` has used all along,
   * and it is immune to that: the side rails are equal by construction
   * whatever they contain, so the centre column is centred on the PANEL.
   * The two bars now centre identically, which also settles design note
   * #309's actual goal -- muscle memory built in one phase landing in the
   * next.
   *
   * The spacers are gone from the markup with it; `actionBarSpacer` stays
   * defined for the auction bar's own row, which is a genuine flex line. */
  actionBarButtons: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    gap: "6px",
    // Design note #40, still: must GROW so the rails have width to take.
    // `minWidth: 0` lets it shrink below its content width, so a long row
    // wraps rather than overflowing the bar.
    flex: 1,
    minWidth: 0,
  },
  /* Design note #426: the centre cell of the grid above -- the buttons
     themselves, centred within a column that is already centred. */
  actionBarButtonsCentre: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    flexWrap: "wrap",
  },
  /* Design note #426: the right rail, holding the phase badge. `justifySelf:
     end` rather than a spacer, so the badge pins right without stealing
     width from the centred group. */
  /* Design note #427: the reason the return bar is on screen at all,
     stated beside the button rather than left to the button's wording. */
  returnBarNotice: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#9fe5b5",
    whiteSpace: "nowrap",
  },
  /* Design note #451: names the step Undo would rewind. Muted and small --
     it is a caption on the button beside it, not a control. */
  undoStepLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "#8f98a8",
    whiteSpace: "nowrap",
  },
  /* Design note #458: the left rail of the non-Operating-Round bar. Holds
     the sticky log line; `minWidth: 0` is what lets its text ellipsis
     rather than forcing the grid wider. */
  actionBarRailLeft: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    overflow: "hidden",
  },
  actionBarRailRight: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    justifySelf: "end",
  },
  /* Design note #426: nudged back up. Design note #31 slimmed these to
     `small`/7px on the reasoning that "in a single chrome strip they only
     have to be comfortably clickable, not the focal point of the screen" --
     which took them below comfortable. These are the primary actions of a
     turn and several are destructive-ish (Skip forgoes a step outright), so
     they get one step of the type scale back and a little more room around
     the label. Still not the focal point; just reliably hittable. */
  actionBarButton: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // every disabled control computes its own look.
  actionBarButtonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  actionBarUtilityButton: {
    color: "#c7cbd4",
    borderStyle: "dashed",
  },
  actionBarDivider: {
    width: "1px",
    alignSelf: "stretch",
    backgroundColor: "#2a2e3a",
    margin: "0 6px",
  },
  // ---- Manual Route Point UI -- see design note #11. ----
  routeToggleButtonActive: {
    borderColor: "#caa42a",
    backgroundColor: "#2a2410",
    color: "#f0d9a0",
  },
  routeToggleSwitchTrack: {
    display: "inline-flex",
    alignItems: "center",
    width: "30px",
    height: "16px",
    borderRadius: "999px",
    backgroundColor: "#3a3f4b",
    padding: "2px",
    marginRight: "10px",
    verticalAlign: "middle",
    boxSizing: "border-box",
  },
  routeToggleSwitchThumb: {
    width: "12px",
    height: "12px",
    borderRadius: "999px",
    backgroundColor: "#c7cbd4",
    transition: "transform 0.12s ease",
  },
  routeToggleSwitchThumbActive: {
    backgroundColor: "#caa42a",
    transform: "translateX(14px)",
  },
  /* Design note #266: twenty `route*` style keys were deleted here along
     with the panel they dressed -- the dashed-border box, the waypoint
     pills, the train chips, the hop counter, the two red warning styles and
     the Auto/Manual pair. They now live in `RoutePlannerPanel.tsx`, next to
     the only markup that ever used them. */
  /* Design note #228: the active-corporation strip. A row rather than a
     boxed card -- it sits directly above the stepper inside a panel that
     already has a border, and nesting a second frame would read as a
     separate widget instead of as this panel's own heading. */
  orContextCard: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px 14px",
    /* Design note #299: the strip's height is set by the station-token row
       and the train chips inside it, which are already compact -- so the
       44px floor was adding empty space to a row that had none to give.
       Dropped rather than lowered: a minimum height on a card whose
       contents already exceed it does nothing except on the one screen
       where the card is nearly empty, and there the extra height is not
       worth the pixels everywhere else.

       ==================================================================
        DESIGN NOTE 371: 3px WAS ONE PIXEL TOO FEW
       ==================================================================

       REPORTED: the train chips inside this card are clipped at the
       bottom.

       #299 was right that the 44px floor was dead space and wrong by a
       hair about the padding. The chips are the tallest thing in this row
       at 24px (`TrainBadges` design note #370), and at 3px top and bottom
       the card is 30px -- which fits, until the row WRAPS. A wrapping flex
       container distributes its lines by `align-content`, whose initial
       value is `stretch`; with the card's height driven by content that is
       usually harmless, but any ancestor rounding or a partially-filled
       last line pushes the final row against the padding edge, and the
       thing that goes is the 1px bottom border of a 5px-radius chip.

       6px, and `alignContent: center` so a wrapped set of lines is
       centred in the box rather than stretched against its edges. Two
       pixels each way is not the space #299 reclaimed -- that was the
       40px difference between a 44px floor and a 30px row. */
    padding: "6px 10px",
    alignContent: "center",
    borderRadius: "8px",
    backgroundColor: "#171c28",
    border: "1px solid #2b3242",
  },
  /* Design note #575: a COLUMN now -- herald+acronym on one line, full name
     under it, matching `rosterIdentityRow` on the Stock Card. It was a
     baseline-aligned row, which is why the acronym had nowhere to go without
     pushing the name onto a second line anyway. */
  orContextIdentity: {
    display: "inline-flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0,
  },
  /* Design note #589: the full name and the president share line two --
     identity detail, read second, one thought. `flexWrap` because a long
     name plus a long player name genuinely can exceed a narrow bar, and
     wrapping is a better failure than clipping a president's name. */
  orContextSubRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "baseline",
    gap: "8px",
    flexWrap: "wrap",
    minWidth: 0,
  },
  orContextIdentityRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "7px",
    minWidth: 0,
  },
  /* Design note #575: `rosterLiveryAcronym`'s typography exactly -- the
     monospace face and its tracking included. Approximating it would give
     the same company two slightly different looks on two screens, which is
     the specific thing this change was asked for to stop.

     `flexShrink: 0` for that file's own reason: the acronym is the handle
     and must not be the thing that ellipsises when the bar is narrow. */
  orContextAcronym: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  /* `orContextDot` is GONE -- design note #236. The whole bar is the
     corporation's colour now, so a dot of that same colour drawn on it was
     invisible by construction. */
  /* Colours on these five are supplied per-render from
     `corporationBarInk` -- see design note #236. What stays here is
     everything that does not depend on which corporation is acting. */
  orContextTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800 },
  orContextName: { fontSize: FONT_SIZE.small },
  orContextPresident: { fontSize: FONT_SIZE.small, whiteSpace: "nowrap" },
  /* Design note #236: the figures CONTINUE FROM THE LEFT.
     This carried `marginLeft: auto`, which flung them to the far edge of the
     panel. On a wide window that left a gulf between the corporation's name
     and its own numbers, so reading "PRR ... $640" meant crossing the bar,
     and the three figures ended up further from the label they belong to
     than from the window edge. They now flow inline after the identity,
     which is how the sentence actually reads: this corporation, then what it
     has. */
  orContextFacts: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px 18px",
  },
  orContextFact: { display: "inline-flex", alignItems: "center", gap: "6px" },
  orContextFactLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  orContextFactValue: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
  },
  /* Design note #379: chips, matching the Game Ledger's own list so a
     private reads the same wherever it appears. The border takes the
     corporation's own ink so the chip sits on a brand-coloured bar without
     a hardcoded colour that would be invisible on half the palette. */
  orContextPrivates: { display: "inline-flex", flexWrap: "wrap", gap: "4px" },
  orContextPrivateChip: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: "4px",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    cursor: "help",
  },
  orContextFactAside: { fontSize: FONT_SIZE.micro, fontWeight: 400 },
  orContextFactNone: { fontSize: FONT_SIZE.small, fontStyle: "italic" },
  tokenTargetBanner: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "10px",
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #3a5a8a",
    backgroundColor: "#16202e",
    color: "#9ec5ff",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
  },
  tokenTargetDot: {
    width: "9px",
    height: "9px",
    borderRadius: "999px",
    backgroundColor: "#38bdf8",
    flexShrink: 0,
  },
  tokenTargetCancel: {
    marginLeft: "auto",
    padding: "3px 10px",
    borderRadius: "6px",
    border: "1px solid #4a5163",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.small,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  /* Design note #164: the two-row Operating Round panel. */
  /* Design note #299: the gap between the corporation strip, the sub-phase
     stepper and the action row. Three stacked rows at 6px each is 18px of
     pure separation in a panel whose own rows are ~30px -- halved, which
     still reads as three distinct bands. */
  orPanel: { display: "flex", flexDirection: "column", gap: "3px", width: "100%" },
  /* Design note #481: `orPanelStepperRow` is GONE, and so is the rule that
     divided it from the action row. The strip it framed is now an inline
     phrase beside the round title (`actionBarSubPhaseInline` below), which
     is what removed the row rather than merely emptying it -- a style kept
     "in case" is how a deleted row comes back. */
  /* Design note #426: this row was ALREADY true-centred -- `1fr auto 1fr`
     rails plus `justifyContent: center` on `orPanelActions` inside them.
     It is the model the non-Operating-Round bar (`actionBarButtons`) has
     now been rebuilt to match; see that style's own note for what it was
     doing instead and why the spacer pair only looked like centring. */
  orPanelActionRow: {
    display: "grid",
    // THE WHOLE POINT. Equal `1fr` rails mean the centre column is centred
    // on the PANEL, not on the leftovers -- so the action buttons stay put
    // however wide the badges or the utilities grow. `auto` in the middle
    // lets the actions size to their content rather than stretching.
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    gap: "10px",
    // Design note #295: a fixed band rather than a floor alone -- the
    // floor was already 44px and nothing stopped the row exceeding it.
    /* Design note #426: the band grows with the buttons. At 9px padding
       around a `strong` label the row needs the extra few pixels, and a
       `maxHeight` that no longer fits its contents is how a bar starts
       clipping its own controls. */
    minHeight: "48px",
    maxHeight: "60px",
  },
  /* Design note #300: the player's own wallet. Deliberately styled unlike
     the corporation strip's treasury -- they are different money, and two
     figures that look alike on one bar will be read as one. */
  playerCashBadge: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "5px",
    padding: "2px 7px",
    borderRadius: "999px",
    border: "1px solid #2f6f55",
    backgroundColor: "#16241d",
    cursor: "help",
    whiteSpace: "nowrap",
  },
  playerCashName: { fontSize: FONT_SIZE.micro, fontWeight: 700, color: "#8fb6a1" },
  playerCashValue: {
    fontSize: FONT_SIZE.body,
    fontWeight: 800,
    color: "#7ee0a1",
    fontVariantNumeric: "tabular-nums",
  },
  /* Design note #317: escrow qualifies the figure beside it rather than
     competing with it -- muted, and absent entirely when nothing is bid. */
  /* Design note #563: the player card grid's own section. Spaced from the
     corporation cards above rather than merged into their grid -- they are a
     different kind of object and a shared grid would imply they were
     comparable cells. */
  playerCardsSection: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginTop: "14px",
  },
  playerCardsTitle: {
    margin: 0,
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.3px",
    color: "#c8cdd8",
  },
  /* Design note #578: the room gate. Deliberately plain -- it is a doorway,
     not a screen, and anything decorative here would be competing with the
     board it exists to get out of the way of. */
  /* Design note #581: the status line dock. Anchored to the bottom EDGE
     rather than given a height, so the expanded history grows upward from
     the line and never off the screen.

     `maxHeight` with `overflowY` is the ceiling: a long history must not
     become the whole window. 60vh leaves the board visible above it, which
     is the point of a peripheral surface. */
  statusLineDock: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3000,
    display: "flex",
    flexDirection: "column",
    /* Design note #599: still capped -- a long history must not become the
       whole window -- but the app root now reserves whatever height this
       actually takes, so growing pushes the page down instead of covering
       it. */
    maxHeight: "60vh",
    overflowY: "auto",
    borderTop: "1px solid #2b3242",
    backgroundColor: "#11151d",
    boxShadow: "0 -6px 18px rgba(0,0,0,0.35)",
  },
  sandboxGateRoot: { display: "flex", justifyContent: "center", padding: "48px 20px" },
  sandboxGateCard: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    width: "100%",
    maxWidth: "560px",
    padding: "24px 26px",
    borderRadius: "12px",
    border: "1px solid #2b3242",
    backgroundColor: "#161b27",
  },
  sandboxGateTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#e2e6ee" },
  sandboxGateBody: {
    margin: 0,
    fontSize: FONT_SIZE.body,
    lineHeight: 1.55,
    color: "#9aa0ac",
  },
  sandboxGateQuiet: {
    alignSelf: "flex-start",
    fontSize: FONT_SIZE.small,
    padding: "6px 12px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "transparent",
    color: "#8a90a0",
    cursor: "pointer",
  },
  /* Design note #601: eight `rosterPill*` styles deleted here, with the
     unreachable pill branch in `ContextualActionBar.tsx` that was their
     only consumer. Design note #406's 8em name ceiling ('six seats have to
     fit') is the one constraint worth carrying forward -- `SeatOrderTrail`
     does not clamp its names, so a table of long sandbox nicknames widens
     the trail rather than truncating. Six-seat games are supported, so if
     that ever overflows the bar, a max-width on `seatName` is the fix and
     this is the note that predicted it. */
  playerCashEscrow: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    color: "#8a919e",
    fontVariantNumeric: "tabular-nums",
  },
  orPanelRailLeft: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    justifySelf: "start",
    /* Design note #482: THE CENTRING WAS ONLY EVER CONDITIONAL. The row's
       `1fr auto 1fr` rails centre the action group on the panel -- but a
       `1fr` track is `minmax(auto, 1fr)` and will not shrink below its
       content, so a rail holding a long line of text widens instead of
       clipping and drags the centre column with it. `minWidth: 0` is what
       makes the rail yield, and it is what the sibling rail on the
       non-Operating-Round bar has had since design note #458. Without it,
       the centring holds only for as long as nothing wide is put in here. */
    minWidth: 0,
  },
  orPanelRailRight: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    justifySelf: "end",
  },
  orPanelActions: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  /* Design note #490: this is now a SECTION of the action panel rather than
     a card floating beneath it, and the styling follows the move.

     The full border is gone. A box inside a box reads as a separate object
     -- which is exactly what this block used to be and no longer is -- so
     what remains is a single hairline along the top, doing the one job the
     border was really doing: separating the figures from the button row
     immediately above them. `marginTop` pays for that rule; `orPanel`'s own
     3px column gap is too tight to sit a divider in. */
  /* Design note #498: the collapsed bar's Run Routes train row. Sized DOWN
     from the ordinary chip -- it exists in the pinned form, whose whole
     premise is that height is being taken from the board, so it buys its
     line with the smallest type this bar uses rather than the control size.
     `wrap` so four trains on a narrow window become two short lines instead
     of overflowing the panel. */
  /* ==================================================================
   *  DESIGN NOTE 518: THE SUB-PHASE TRAIL
   * ==================================================================
   *
   * Connected boxes rather than separated pills, which is what makes it read
   * as a SEQUENCE rather than as a set of tags. The segments share edges --
   * `marginLeft: -1px` collapses the doubled border between neighbours -- so
   * the trail is one object with divisions rather than six objects in a row.
   * That is the same construction the Par ladder on the stock cards uses,
   * and for the same reason: both describe positions along one track.
   *
   * `flexWrap` because six steps at the era's full length can outrun a
   * narrow window, and a wrapped trail still reads in order where a clipped
   * one loses its tail. */
  subPhaseTrail: {
    display: "inline-flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    marginLeft: "10px",
    borderRadius: "6px",
  },
  /* THE DEFAULT IS THE MUTED ONE. Five of the six steps are inactive at any
     moment, so the quiet treatment is the base and emphasis is what gets
     added -- rather than styling five exceptions around one norm. */
  subPhaseStep: {
    padding: "2px 8px",
    marginLeft: "-1px",
    border: "1px solid #2f3542",
    backgroundColor: "#191d27",
    color: "#6f7480",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  /* Past steps sit between done and pending: still dim, but not as faint as
     what has not happened, so the trail reads left-to-right as travelled,
     here, remaining. */
  subPhaseStepDone: { color: "#8a90a0", backgroundColor: "#1c212c" },
  /* The one the player is on. Lifted on all three channels -- fill, ink and
     border -- because a single channel is not enough to win a glance across
     six adjacent boxes, which is the whole job of this element. */
  subPhaseStepCurrent: {
    backgroundColor: "#1d3a55",
    color: "#9ec5ff",
    borderColor: "#38bdf8",
    position: "relative",
    zIndex: 1,
  },
  condensedTrainRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    marginTop: "4px",
    paddingTop: "4px",
    borderTop: "1px solid #2b3242",
  },
  condensedTrainChip: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    padding: "2px 8px",
    borderRadius: "6px",
    border: "1px solid #3a4150",
    // Design note #494: overridden per chip with that train's route ink.
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.small,
    fontFamily: "inherit",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  condensedTrainChipActive: {
    backgroundColor: "#1d3a55",
    color: "#9ec5ff",
    borderColor: "#38bdf8",
  },
  /* The figure this row exists for, in tabular numerals so a column of
     values does not jitter as the drafts change under the pointer. */
  condensedTrainValue: {
    fontVariantNumeric: "tabular-nums",
    color: "#7ee0a1",
    fontWeight: 800,
  },
  dividendPanel: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    padding: "8px 4px 2px",
    marginTop: "5px",
    borderTop: "1px solid #2b3242",
  },
  dividendColumn: { display: "flex", flexDirection: "column", gap: "4px" },
  dividendHeading: { fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#e2e6ee" },
  dividendRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: "12px",
    fontSize: FONT_SIZE.small,
    color: "#c8cdd8",
  },
  dividendAmount: { fontVariantNumeric: "tabular-nums", color: "#7ee0a1", fontWeight: 700 },
  dividendPct: { color: "#6f7480", fontWeight: 400 },
  dividendNote: { fontSize: FONT_SIZE.small, color: "#9aa0ac", lineHeight: 1.4 },
  dividendMove: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#9ec5ff", marginTop: "4px" },
  /* Design note #214: the arrow is the one glyph in the line that carries a
     DIRECTION, so it is the one that takes the direction's colour. Sized up
     and weighted past the prices either side of it: those are tinted by
     market zone (a rules fact), and if the arrow merely matched them the
     line would read as three coloured things competing rather than one
     movement between two values.

     `lineHeight: 1` because the diagonal glyphs sit taller than the digits
     and would otherwise push this row's baseline down relative to the
     Withhold column beside it. */
  dividendMoveArrow: {
    fontWeight: 900,
    fontSize: "1.15em",
    lineHeight: 1,
    padding: "0 2px",
  },
  /* Design note #509a: the treasury transition under Withhold, built from
     the same vocabulary as `MarketMoveLine` -- herald, from-value, arrow,
     to-value -- so a player reads the two consequences of a withhold as one
     pair of before/after facts rather than as a sentence and a diagram. */
  treasuryMove: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    marginTop: "2px",
  },
  /* The departure is muted and the destination is not: a withhold always
     RAISES the treasury, so the figure that matters is the one after. */
  treasuryFrom: { color: "#9aa0ac" },
  treasuryTo: { color: "#7ee0a1", fontWeight: 800 },
  dividendMoveArrowUp: { color: "#4ade80" },
  dividendMoveArrowDown: { color: "#f87171" },
  /* Design note #489: a move that goes nowhere is neither a gain nor a loss.
     It takes the muted note ink rather than green or red, because those two
     are the only colours on this line carrying a claim about VALUE, and a
     token pinned at the end of its row has not changed any. */
  dividendMoveArrowFlat: { color: "#8a90a0" },
  dividendMoveNote: { color: "#8a90a0", fontWeight: 400 },
  depotSupply: { fontSize: FONT_SIZE.small, color: "#9aa0ac" },
  /* Design note #279: the Track step's "the action is on the map" hint, and
     nothing else. This used to carry a second string saying the step had no
     button at all -- a caption about an empty div, which is exactly what
     that note deleted. An empty centre column is now allowed to be empty. */
  orPanelNoActions: { fontSize: FONT_SIZE.small, color: "#6f7480", fontStyle: "italic" },
  // ---- Operating Round Phase 4 hardware marketplace tray -- see design
  // note #10/item 2, upscaled alongside the rest of the action bar (design
  // note #12/item 5). ----
  hardwareTray: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: "10px",
  },
  hardwareTrayCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    padding: "10px 16px",
    borderRadius: "8px",
    border: "1.5px solid #3a3f4b",
    backgroundColor: "#1a1d26",
    color: "#e6e8ef",
    cursor: "pointer",
    minWidth: "72px",
  },
  hardwareTrayCardSelected: {
    borderColor: "#caa42a",
    backgroundColor: "#2a2410",
  },
  hardwareTrayCardModel: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
  },
  hardwareTrayCardCost: {
    fontSize: FONT_SIZE.body,
    color: "#9aa0ac",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  // ---- Buy Private Company Action Tray -- design note #14. ----
  privateCompanyTray: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1.5px solid #3a3f4b",
    backgroundColor: "#1a1d26",
  },
  privateCompanyTrayLabel: {
    fontSize: FONT_SIZE.body,
    color: "#9aa0ac",
    fontWeight: 600,
  },
  privateCompanySelect: {
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
  },
  privateCompanyPriceRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
  },
  privateCompanyPriceValue: {
    fontSize: FONT_SIZE.body,
    color: "#e6e8ef",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    minWidth: "72px",
  },
  boardPane: {
    flex: 1,
    display: "flex",
    // Was "center"/"center" -- changed to "stretch" (design note #19/item 3
    // in HexGridRenderer.tsx) so `HexGridRenderer`/`StockMarketRenderer`
    // actually receive this pane's full available WIDTH to flex-fill,
    // instead of being centered at their own fixed content size.
    alignItems: "stretch",
    justifyContent: "stretch",
    // Design note #13/item 1: `overflow: "auto"` removed -- see
    // `canvasPane`'s own comment above for why. `StockMarketRenderer` (the
    // Stock Market tab, unaffected by this item) still gets its own
    // dedicated pane height from this same un-clipped flex chain; only the
    // Rail Map tab's canvas actually grows past one viewport in practice.
    minHeight: "420px",
  },
  hexClickIndicator: {
    position: "fixed",
    zIndex: 1000,
    maxWidth: "240px",
    padding: "8px 12px",
    borderRadius: "8px",
    backgroundColor: "#242833",
    border: "1px solid #3a3f4b",
    color: "#e6e8ef",
    fontSize: FONT_SIZE.small,
    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
  },
  hexClickIndicatorError: {
    backgroundColor: "#2a1414",
    borderColor: "#8a2020",
    color: "#ffe8e8",
  },
  // Design note #141. Amber, and deliberately roomier than the error
  // variant: these messages explain a board rule ("gray hexes are
  // permanently fixed") rather than report a failure, so they run longer
  // and need the width to stay readable at two or three lines.
  hexClickIndicatorBlocked: {
    maxWidth: "320px",
    backgroundColor: "#2a2114",
    borderColor: "#8a6a20",
    color: "#f0dcb0",
    lineHeight: LINE_HEIGHT.normal,
  },
};

