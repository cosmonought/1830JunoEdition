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
  mainTabBar: {
    display: "flex",
    gap: "6px",
    padding: "6px 16px 0",
    backgroundColor: "#0F172A",
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
  tutorialsButton: {
    padding: "8px 16px",
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
    flex: 1,
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
    marginBottom: "12px",
  },
  // Active Player Turn Notifications -- design note #18/item 4. Spread onto
  // `actionBar` alongside its base style, not replacing it, so the bar's
  // own layout/padding/background are unaffected -- only the border color
  // and the shared pulsing-glow animation are added.
  /* Design note #298: the pinned form. Vertical padding halves and the
     bar loses its rounding against the top edge -- it is now a chrome
     element rather than a card, and a floating rounded card that never
     moves reads as a stuck modal. */
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
  actionBarRoundLabel: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
  },
  actionBarButtons: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
    // Design note #40: must GROW, or the internal spacer has no width to
    // expand into and the phase badge sits flush against Undo instead of at
    // the far right. `minWidth: 0` lets it shrink below its content width
    // too, so a long button row wraps rather than overflowing the bar.
    flex: 1,
    minWidth: 0,
  },
  actionBarButton: {
    // Design note #31: slimmed from `strong`/12px padding. These were sized
    // for a standalone panel; in a single chrome strip they only have to be
    // comfortably clickable, not the focal point of the screen.
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "7px 14px",
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
  orContextIdentity: { display: "inline-flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
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
  orPanelStepperRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    borderBottom: "1px solid #2b3242",
    // Design note #299: the rule below the strip is the separator; 4px of
    // padding on top of the stepper's own is a second one made of air.
    paddingBottom: "1px",
  },
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
    minHeight: "44px",
    maxHeight: "52px",
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
  /* Design note #342: the roster row. `flexWrap` because four pills plus
     the buttons genuinely overflow a narrow window, and wrapping is a
     better failure than clipping a player's balance. */
  actionBarRoster: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
  },
  rosterPill: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "6px",
    padding: "3px 9px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  /* Green for the seat on turn -- the same `#7ee0a1` family the seating
     table's ON TURN badge uses, so the two surfaces mark the turn in one
     colour rather than each picking their own. */
  rosterPillActive: {
    borderColor: "#3f7a55",
    backgroundColor: "#17301f",
    color: "#9fe9bb",
  },
  rosterPillIdle: {
    borderColor: "#2f3543",
    backgroundColor: "#1b1f29",
    color: "#8a919e",
  },
  rosterPillName: { fontSize: FONT_SIZE.micro, fontWeight: 700 },
  rosterPillValue: { fontSize: FONT_SIZE.small, fontWeight: 800 },
  rosterPillEscrow: { fontSize: FONT_SIZE.micro, opacity: 0.75 },
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
  dividendPanel: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    padding: "10px 12px",
    borderRadius: "8px",
    border: "1px solid #2b3242",
    backgroundColor: "#161b27",
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
  dividendMoveArrowUp: { color: "#4ade80" },
  dividendMoveArrowDown: { color: "#f87171" },
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

