// frontend/src/styles/appStyles.ts
//
// THE SHARED INLINE-STYLE TABLE, lifted out of `App.tsx` unchanged -- a MOVE, not a rewrite: same
// declarations, same order, so `git log -p` on a style reads as one continuous history.
//
// It moved because a table with five consumers (`TopBar`, `MarketMoveLine`, `ContextualActionBar`,
// `MainTabBar`, `AppShell`) is shared infrastructure, and shared infrastructure living inside one of its
// consumers forces every other consumer to import from that consumer. `PHASE_TINT_STYLES` rides along;
// separating it would put two halves of one lookup in two files.
//
// Design history: see `docs/ai_architecture/ui_shell_layout.md`.

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
/* Design note #884: the private-power hue circle, imported rather than retyped. #727 is explicit that the
   MECHANISM cannot be shared between a canvas gradient and a CSS one, "so what must be shared is the list". */
import { PRIVATE_POWER_GLOW_STOPS } from "../utils/privatePowerGlow";

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
  /* Design note #34: the single slim top bar. 6px vertical against the old header's 16px -- the point of
     the consolidation was vertical space, so the row has to actually be short. `flexWrap` stays on: the
     sandbox phase switcher can overflow, and wrapping beats a clipped Connect button. */
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
  /* ==================================================================
      DESIGN NOTE 889: THE OPERATING ORDER, AS A ROW OF TICKERS
     ==================================================================
     DESIGN NOTE 930 REPLACED BOTH HALVES OF THIS NOTE, and they are kept because each states a rule that is
     still true somewhere else.
     THE LONGHAND BORDERS ARE GONE with the per-chip livery border: only the ACTIVE chip is coloured now, and
     it carries a complete `border` shorthand of its own, so #732/#840's shorthand-beside-longhand hazard no
     longer has two properties to fight over.
     `flexWrap` IS GONE TOO, and #590's rule about it is what forced the alternative rather than being
     overruled by it: the strip must not decide which corporations a player may see, so at eight tickers it
     SCROLLS horizontally instead of wrapping -- every corporation still reachable, and the row still one
     line high. Wrapping was what produced the reported stagger. */
  /* Design note #920: pushed to the right end of the progress row by its OWN margin rather than by
     `space-between` on the row -- the sub-phase trail must stay left-anchored on a round with no queue, and
     `space-between` would centre it there. */
  orTurnOrder: {
    marginLeft: "auto",
    /* Design note #930: ONE UNBROKEN RECTANGLE. `inline-flex` with no wrap, and the strip's own rounding
       clipping the first and last chip's square corners, is what makes eight boxes read as one control -- a
       wrapped strip of butted rectangles is exactly where the reported stagger came from.
       IT SCROLLS RATHER THAN WRAPPING at eight tickers, which is #590's rule honoured rather than dropped:
       every corporation stays reachable and the row stays one line high. */
    overflow: "auto",
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
  },
  /* ==================================================================
      DESIGN NOTE 930: ONE RECTANGLE, NOT EIGHT FLOATING CHIPS
     ==================================================================
     REPORTED: "the corporation turn order badges are rendering staggered (uneven vertical alignment) instead
     of in a straight line. Consolidate them: model this component after the subphase sequence UI."
     AND THE STAGGER WAS `flexWrap` ON THE ROW plus per-chip borders in eight different livery colours. Rounded
     independent chips have no shared baseline to sit on, so any wrap or any difference in border weight reads
     as a jog -- the sub-phase trail never had that problem because it is one strip of butted rectangles.
     SO IT BORROWS THAT CONSTRUCTION EXACTLY: square corners, `marginLeft: -1px` so adjacent borders collapse
     into one hairline, and the strip itself carrying the rounding. Same vocabulary in both places, which is
     also #575's rule -- a player should not learn two layouts for one idea.
     THE LIVERY SURVIVES ON THE ACTIVE ONE ONLY. Eight simultaneous brand colours is what made this a row of
     unrelated objects; desaturating the inactive ones turns it back into a sequence with a position in it,
     which is the question this element answers. */
  orTurnOrderChip: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.03em",
    padding: "2px 8px",
    marginLeft: "-1px",
    border: "1px solid #2f3542",
    backgroundColor: "#191d27",
    color: "#6f7480",
    whiteSpace: "nowrap",
    flexShrink: 0,
    cursor: "help",
  },
  /* Design note #930: still to come. The same treatment the sub-phase trail gives an unreached step -- it is
     the same fact about a sequence. */
  orTurnOrderChipUpcoming: { color: "#8a90a0" },
  /* DIMMED, NOT REMOVED. A row that shortens as the round goes on stops being an ORDER and becomes a queue,
     and "have they gone yet" is the question a player asks about the corporations behind them. */
  /* Design note #930: `opacity` dimmed the BORDER as well as the text, which on a livery-coloured chip made
     "already operated" look like a rendering fault. An explicit ink and fill instead, matching
     `subPhaseStepDone`. */
  orTurnOrderChipDone: { color: "#8a90a0", backgroundColor: "#1c212c" },
  /* THE ACTING ONE IS FILLED, and both its background and its ink are written INLINE at the call site --
     the fill from the corporation's livery, the ink from `bestContrastTextColor` against it. Neither can be
     a static entry here, so there is no `orTurnOrderChipActing` to define; saying so is worth a line,
     because an absent style in a set of three reads as an oversight. */
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
    /* ==================================================================
        DESIGN NOTE 867: A CURSOR PROMISING A TOOLTIP THAT WAS REMOVED
       ==================================================================
       REPORTED: "all of the warning badges have a tooltip hover cursor icon, but no tooltip appears for
       them."
       EXACTLY RIGHT, AND #839 IS WHERE IT HAPPENED. That pass removed the phase badge's `title` on request --
       "Keeping with our policy of not hiding critical information in hover tooltips ... The Phase Change can
       stay and have its tooltip removed" -- and left `cursor: "help"` behind on the shared style. The badges
       added in the same pass inherited it, so three chips advertised a hover that had been deliberately
       deleted.
       A CURSOR IS AN AFFORDANCE, which is why this is a bug and not a cosmetic leftover: `help` tells a
       player there is more to read, and the whole point of #839 was that there is no more to read because it
       is all already on the chip. The `aria-label` is not a tooltip -- it carries the same sentence for a
       reader who cannot see the label, and no pointer will ever reveal it.
       `default`, NOT UNSET: these sit inside a bar of buttons, and a badge that inherited a neighbouring
       `pointer` would advertise a click instead. */
    cursor: "default",
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
  // Pushes the connection cluster right. A spacer element rather than `marginLeft: auto` on the first
  // right-hand child, because which child is first varies -- the offline badge and both error spans are
  // conditional -- and an `auto` margin on a node that sometimes does not render un-pins the whole group.
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

  // Room strip -- design notes #1/#22, in the same recessed tone `TopTicker`'s expanded body and `Lobby`'s
  // panels use, so the two screens read as one application.
  // Design note #34: the `roomStrip` container is gone -- its children are inline content in `topBar` now.
  // The item styles are kept because those children still exist and still need their look.
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
  /* Design note #901: RED, where the spectator badge is amber. Amber is this app's "be aware"; a broken bank
     is not a mode the player is in, it is a countdown they cannot stop, and it has to out-rank every other
     badge in the same strip. Complete `border` shorthand rather than a longhand beside a sibling's shorthand
     -- #840/#732. */
  bankBrokenBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    padding: "4px 12px",
    borderRadius: "999px",
    backgroundColor: "#3d1a18",
    border: "1px solid #8a3a30",
    color: "#f0a898",
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
    // Design note #13/item 1: was a hard `height: "100vh"`, which clipped this column to one viewport-worth
    // of pixels no matter how tall the board needed to be. `minHeight` keeps the same look on a short screen
    // and lets the column grow, so the BROWSER's page scrollbar carries the rest instead of an inner pane's.
    minHeight: "100vh",
    width: "100%",
    /* Design note #599: the SEED only. The real value is measured from the dock and applied inline -- a
       constant was right while the dock had one height, and became "the log covers the page" the moment it
       could grow. Kept as the pre-measurement default so the first paint does not start with the footer over
       the content. */
    paddingBottom: "96px",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    backgroundColor: "#12141a",
    color: "#e6e8ef",
  },
  // Design note #12/item 5 (upper brand header): fonts, badges and wallet fields upscaled 40-60% past their
  // original small print so the topmost bar reads on a widescreen panel.
  // VGP: no container, amber -- reads as a SCORE. $JUNO: contained pill, teal, bordered -- reads as a REAL
  // ASSET. Two deliberately different kinds of object, not two rows of the same kind.
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
  // Main tabs -- design note #9, upscaled by #12/item 5 so the four destinations read as primary
  // navigation. Design note #20/item 3: this background matches `TopTicker`'s expanded-body slate and the
  // active tab shares its exact header colour, so the tab flows into the ticker with no seam.
  // Design note #299: THE TABS WERE A HEADING WEARING A BUTTON'S BORDER. 14px of padding around a
  // `heading`-sized label is a ~47px control for a one-word destination, and the bar added 14px more -- ~60px
  // before anything had been read. A tab is a navigation control, not a section heading.
  // Design note #456: THE TAB ROW HAD NO ESCAPE. Flex items refuse to shrink below their content width, so
  // once the labels exceeded the bar nothing gave -- the row ran past its own padding and Tutorials, on the
  // far side of an `auto` margin, was the item that visibly left. `flexWrap` is the fix and `rowGap` is what
  // makes it survivable; bottom padding 0 -> 6px because the original assumed exactly one line.
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
  /* Design note #46: every tab is visibly a control. The resting border was barely a shade from the bar, so
     an unselected tab had no edge and read as recessed rather than clickable. */
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
  /* The active tab is the only WHITE-edged item in the bar and the only one with a lift, and it keeps the
     ticker's own header colour so it docks seamlessly into the panel below (`TopTicker.tsx #7`).
     Design note #456: Tutorials condensed. It was the widest single item and the first to be pushed out; it
     is a secondary control, so it can afford to be smaller than the tabs. `flexShrink` lets it give way
     before the row breaks, and `minWidth: 0` is what permits that -- a flex item will not otherwise shrink
     below its content. */
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
  /* Design note #813: the sticky-fit probe's readout. Deliberately plain and deliberately ugly -- it is an
     instrument, not a feature, and it should look like something that is going to be removed. Monospace and
     tabular so the figures do not jitter as they update on every scroll frame. */
  fitProbe: {
    margin: "4px 0 0",
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px dashed #4a5163",
    backgroundColor: "#141a26",
    color: "#8f98a8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.micro,
    fontVariantNumeric: "tabular-nums",
  },
  canvasPane: {
    /* Design note #600: `flex: 1` MEANS `flex-basis: 0`, AND THAT IS THE BUG. A sticky element travels only
       within its PARENT'S BOX, and `flex: 1` expands to `1 1 0%` -- a basis of ZERO, grown to fill a flex line
       that is one viewport tall. So this pane computed to roughly the viewport height while its content ran
       past it, and the bar stuck perfectly within the few pixels of parent it had.
       The auction showed it first because the effect scales with the overrun and that tab stacks six cards, a
       bar and a row of player cards.
       `1 0 auto`: still grows to fill a short page, but its basis is its CONTENT, so it is never shorter than
       what it holds. NOT VERIFIED IN A BROWSER -- reasoned from the flex spec after ruling out three other CSS
       causes. If the bar still fails to travel, this is the next thing to disbelieve. */
    flex: "1 0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    // Design note #13/item 1: `overflow: "auto"` removed -- exactly the inner scrollbar this item asks to
    // eliminate. With no `overflow` set the pane grows to its content's real height, same as any block, and
    // the page scrolls.
    padding: "20px",
  },
  // Contextual top action bar -- design note #8/item 5, upscaled by #12/item 5, slimmed by #31 (the three
  // trays that made it a tall panel are separate blocks below it now, so this is page chrome, not a card).
  // Design note #297: THE CONTROLS FOLLOW THE PLAYER DOWN THE PAGE. The board is taller than the viewport by
  // design, so scrolling to the southern hexes takes Place Token and Skip off screen first. Sticky rather
  // than fixed: fixed would leave a gap where the bar was, and it only needs to stop at the top of the
  // container it already lives in. It condenses when it sticks -- see #298 for what is dropped.
  // Design note #426: PLAIN `sticky top-0`. The positioning was already here; what stopped it behaving that
  // way was `marginBottom` -- a sticky element's margin travels with it, so the bar reserved 12px beneath
  // itself for the whole scroll and detached from the viewport edge early. The margin moves to the content
  // that follows. `zIndex: 50` stays: sticky creates no stacking context, and without it the panels
  // scrolling underneath paint over the bar at exactly the moment it is doing its job.
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
    /* Design note #295: the strip's own height -- at 10px padding around a 19px control this ran past 60px;
       with the type scale at 14px it lands inside the 44-52px band the layout targets.
       Design note #655: the clause that used to end this sentence described a `maxHeight` this bar does not
       have and should not. This bar WRAPS, and a wrapped row growing is the wrap working. */
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
  /* Design note #720: the bar, given back to the page. Spread OVER `actionBar` when it has grown past half the
     viewport -- an embedded step panel, usually -- because a sticky box taller than its own pin space hides its
     own bottom for the rest of the scroll.
     `zIndex` stays: the bar still overlaps the panels below it while it travels, and dropping the stacking
     order here would make it flicker under them instead of trapping. */
  /* Design note #859: the step panel's own row in the bar's wrapping flex. Without it the wrapper is a flex
     item sized to its content, and every layout inside it divides a fragment of the bar instead of the bar. */
  stepPanelRow: { flexBasis: "100%", width: "100%", minWidth: 0 },
  actionBarUnpinned: {
    position: "static",
  },
  // Turn notifications -- design note #18/item 4. Spread onto `actionBar` alongside its base style so only
  // the border colour and the glow are added.
  // Design note #298: the pinned form. Vertical padding halves and the rounding goes -- a floating rounded
  // card that never moves reads as a stuck modal.
  // Design note #390: the wrong-tab redirect. Padding grows because the bar is now one control, and a lone
  // button pinned left in a full-width bar reads as a leftover rather than as the point.
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
  /* `actionBarSubPhaseInline` and `actionBarSubPhaseCount` are GONE -- design note #672. They styled the
     pinned bar's compact "LAY TRACK 2/5", which the sub-phase trail now replaces in both forms.
     DELETED RATHER THAN LEFT UNUSED, the same rule `palette.ts` records for its removed colour token: a
     ready-made style for a form somebody just asked us to stop rendering is a standing invitation to render it
     again. The trail's own styles are below (`subPhaseTrail`, `subPhaseStep`). */
  actionBarRoundLabel: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
  },
  /* Design note #426: TRUE-CENTRED, WHICH THE SPACER PAIR WAS NOT. Two equal spacers centre the group
     BETWEEN THEMSELVES, not on the bar -- the phase badge sits outside the trailing spacer, so the group was
     pushed left by exactly the badge's width and drifted as the phase text changed. `1fr auto 1fr` is the
     same grid `orPanelActionRow` has always used and is immune to that. `actionBarSpacer` stays defined for
     the auction bar's own row, which is a genuine flex line.
     Design note #636: the Stock/Auction branch as a COLUMN mirroring `orPanel` -- identity on one row,
     actions on the next, same shape and gap, so the two rounds' bars are one object with different contents. */
  actionBarPanel: { display: "flex", flexDirection: "column", gap: "3px", width: "100%" },
  actionBarButtons: {
    display: "grid",
    /* Design note #654: `minmax(0, 1fr)` rather than bare `1fr`. A `1fr` track still has an `auto` minimum, so
       a rail wider than its share grows past half and drags the centre off true. The explicit `0` floor lets
       the rails shrink and keeps the middle middle. */
    gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
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
  /* Design note #426: the right rail. `justifySelf: end` rather than a spacer, so the badge pins right
     without stealing width from the centred group.
     Design note #427: the reason the return bar is on screen at all, stated beside the button rather than
     left to the button's wording. */
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
  /* Design note #654: LEAD AND TRAIL, NOT LEFT AND RIGHT. The badge is flush left now, so the pair is named
     for position rather than side; the trailing rail carries nothing and exists to be the third grid column.
     An empty element as layout is worth defending because it looks like something to delete: it is a grid
     TRACK, not one of the flex spacers #426 removed. Delete it and the centre column becomes the last one. */
  actionBarRailLead: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    justifySelf: "start",
    minWidth: 0,
  },
  /* Design note #881: A RAIL, NOT A SPACER, so it takes the layout its sibling has had since #426: `flex`
     with `justifyContent: end`, mirroring `actionBarRailLead`'s `justifySelf: start`.
     `justifyContent`, NOT `justifySelf`. The grid track is already `minmax(0, 1fr)` and this element fills
     it, so `justifySelf` would move the RAIL inside a track it already spans -- which is nothing. What has
     to move is the button inside the rail, and that is the flex container's business. The lead rail can use
     `justifySelf` because it is `minWidth: 0` and shrinks to its content; this one holds a fixed-width
     button and does not.
     `minWidth: 0` STAYS, unchanged and load-bearing: a `1fr` track has an `auto` minimum (#654), so without
     the explicit floor a rail holding a real button refuses to shrink and drags the centred group off true
     on a narrow bar -- the exact failure #654 fixed by adding the floor to the tracks. */
  actionBarRailTrail: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "6px",
    minWidth: 0,
  },
  /* ==================================================================
      DESIGN NOTE 884: THE PRIVATE-POWER MARK IS INSIDE THE CHIP
     ==================================================================
     ASKED: "whether the PC action bar buttons should share the rainbow outline, or have a PC chip, or
     something similar."

     THE PALETTE IS RIGHT AND THE BORDER IS THE WRONG PLACE FOR IT. #727 chose the auction's hue circle for
     the powered hexes precisely because #320 picked it to be "unmistakably not any status colour", and a
     player meets it first on the private company cards -- "the association is not decorative". Carrying it
     to the chip completes card -> hex -> chip, which is the whole reason to mark them at all.

     BUT THE BORDER ON THIS BAR IS A STATE CHANNEL. `actionBarButtonDisabled` overrides `borderColor`,
     `actionBarCancelErrand` paints it amber for an armed power's escape hatch. A border that is sometimes a
     rainbow is #732's failure exactly -- identity and state on one channel -- and #840 makes it concrete:
     a `border` shorthand in a base style beside a `borderColor` longhand in a sibling state makes React
     write `borderColor = ""` on the render that drops the override. A gradient border cannot be expressed as
     a `borderColor` longhand at all (it needs `borderImage`), so it could not participate in that channel
     even if the collision were acceptable.

     SO THE MARK IS A CHILD, not an edge: a small gradient bar at the chip's leading edge, using the same
     `PRIVATE_POWER_GLOW_STOPS` the canvas draws, and the border stays free to say whether the control is
     live. `flexShrink: 0` because it is an identifier -- a mark that narrows on a crowded bar reads as a
     rendering fault, which is #2951's argument for gating the hex ticker on measured size.

     THE STOPS ARE IMPORTED, NOT RETYPED. #727 is explicit that the one thing two renderers cannot share is
     the MECHANISM -- canvas gradient here, CSS there -- "so what must be shared is the list. Two hard-coded
     palettes drifting apart is how the association quietly stops being one." This is the third renderer. */
  actionBarPowerChip: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "7px",
  },
  /* ==================================================================
      DESIGN NOTE 931: THE MARK GROWS; IT DOES NOT BECOME A BORDER, AND IT IS NOT A STAR
     ==================================================================
     REPORTED: "the thin rainbow gradient bar ... is too subtle to clearly link it to the map elements. Add
     the Star icon (currently used on the map for private company hexes) directly to this button, and/or
     expand the gradient to be a border around the button."

     THERE IS NO STAR ON THE MAP TO BORROW. The powered hexes are marked by the rainbow GLOW HALO #727 draws
     -- three blurred strokes of `PRIVATE_POWER_GLOW_STOPS` around the hex -- and nothing anywhere renders a
     star. Adding one here would invent a second private-power symbol and put the button in a vocabulary the
     board does not speak, which is the opposite of the connection being asked for.

     AND THE BORDER IS STILL REFUSED, for #884's two reasons, both of which still hold: `actionBarButtonDisabled`
     overrides `borderColor` and `actionBarCancelErrand` paints it amber, so the border is a STATE channel and a
     rainbow on it would be #732's identity-and-state collision; and a gradient border needs `borderImage`,
     which cannot participate in a `borderColor` longhand at all.

     SO THE SHARED SIGNATURE GETS LOUDER INSTEAD. Wider, and carrying the same halo the canvas draws -- a
     `boxShadow` in the palette's own mid stop, which is the glow's effect expressed in the medium CSS has.
     Card -> hex -> chip now share a colour AND a glow rather than a colour alone, which is the association
     #884 was building and the subtlety the report is about. */
  actionBarPowerChipMark: {
    flexShrink: 0,
    width: "7px",
    alignSelf: "stretch",
    minHeight: "16px",
    borderRadius: "3px",
    backgroundImage: `linear-gradient(180deg, ${PRIVATE_POWER_GLOW_STOPS.join(", ")})`,
    /* The canvas halo, in the medium available here. `PRIVATE_POWER_GLOW_STOPS[4]` is the same stop
       `HexGridRenderer` uses for its `shadowColor`, imported rather than retyped for #727's stated reason. */
    boxShadow: `0 0 6px ${PRIVATE_POWER_GLOW_STOPS[4]}`,
  },
  /* Design note #426: nudged back up. #31 slimmed these on the reasoning that a chrome strip only has to be
     comfortably clickable, which took them below comfortable. These are the primary actions of a turn and
     several are destructive-ish, so they get one step of the type scale back. */
  /* Design note #817: the exit from an armed private power. Amber, not red -- leaving an unspent power costs
     nothing, and a destructive colour here would make the escape hatch look like the dangerous option when
     the dangerous option is the one that spends the power by accident. */
  actionBarCancelErrand: {
    borderColor: "#c9a227",
    color: "#e6cf7a",
    backgroundColor: "#2a2415",
  },
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
  /* Design note #619: THE STYLE EXISTED; THE NAME AT THE CALL SITE DID NOT. `ContextualActionBar` reached
     for `styles.actionButtonDisabled`; the key here is `actionBarButtonDisabled`. `styles` is typed
     `Record<string, React.CSSProperties>`, so a missing key is `undefined` rather than a compile error, and
     spreading `undefined` is a silent no-op -- two call sites had been styling nothing since they were
     written, with `tsc` and ESLint both perfectly happy. The contextual buttons were a plainer miss: they
     passed `disabled` and spread no disabled style at all, so the bar had three ways of drawing an
     unavailable control and one of them worked.
     A `Record<string, T>` style sheet cannot catch this. One audit found one phantom key, so the sweep is
     done -- but nothing stops the next one, and the failure is invisible by construction. */
  actionBarButtonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  /* ==================================================================
      DESIGN NOTE 936: THE MARK AND THE WORDS ARE ONE ROW
     ==================================================================
     The Buy Private Company button carries the board's private-power star (#936). Inline-flex rather than a
     margin on the glyph: the star is an `<svg>` with `display: block`, and a bare sibling would sit on the
     text baseline with its own line-height, which puts a 11px shape a pixel or two low and makes the pairing
     look accidental. `center` aligns the two by their middles, which is what the eye reads.
     ADDED HERE AND NOT IN THE PANEL, which is the whole of #619's lesson one file over: `styles` is typed
     `Record<string, React.CSSProperties>`, so a key defined in the component that renders it is `undefined`
     at the call site and spreads to nothing, silently, with `tsc` and ESLint content. */
  actionBarButtonWithIcon: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  /* Design note #619: the standing "you must buy a train" notice. Amber, not
     red -- an obligation the rules impose is not an error the player has
     made, and this appears the moment the step opens rather than in response
     to anything they did. */
  mustBuyTrainNotice: {
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
    color: "#e0c07a",
    backgroundColor: "#241f12",
    border: "1px solid #6b5a2a",
    borderRadius: "6px",
    padding: "7px 10px",
  },
  /* Design note #674: UNDO ONLY, now. Skip wore this too and was reported as looking "slightly dimmer than the
     Buy Private button; they should be the same since they're equally viable options" -- which is correct, and
     about the RULES rather than about taste. Declining a step is a real 1830 play, not a fallback, and drawing a
     peer of the action beside it as its lesser tells the player something untrue about their own options.
     WHAT THIS MARK MEANS, stated so the next call site can tell whether it qualifies: NOT ONE OF THE TURN'S
     MOVES. Undo is an instruction about the log (`logRevert.ts` #591), not an action a corporation takes -- so it
     belongs outside the set of things the player is choosing between, and dimmer ink plus a dashed edge is that
     boundary. Anything the game offers as an option does not qualify, however secondary it feels. */
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
  /* Design note #266: twenty `route*` keys were deleted here with the panel they dressed. They live in
     `RoutePlannerPanel.tsx`, next to the only markup that ever used them.
     Design note #228: the active-corporation strip. A row rather than a boxed card -- it sits inside a panel
     that already has a border, and a second frame would read as a separate widget. */
  orContextCard: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px 14px",
    /* Design note #299: the 44px floor is dropped rather than lowered -- a minimum height on a card whose
       contents already exceed it does nothing except on the one screen where the card is nearly empty.
       Design note #371: 3px WAS ONE PIXEL TOO FEW. The chips are 24px, so at 3px either side the card is 30px
       -- which fits until the row WRAPS: a wrapping flex container distributes its lines by `align-content`,
       whose initial value is `stretch`, and any rounding or partially-filled last line pushes the final row
       against the padding edge. 6px, plus `alignContent: center`. */
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
  /* Design note #589: the full name and the president shared line two --
     identity detail, read second, one thought.
     Design note #671: the president has moved to the end of the facts rail, so
     this row now carries the full name alone. The flex box STAYS rather than
     collapsing to a bare span: `flexWrap` and `minWidth: 0` are what let a long
     company name wrap instead of clipping, and that was never about having two
     children. */
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
  /* Design note #575: `rosterLiveryAcronym`'s typography exactly, monospace face and tracking included --
     approximating it would give the same company two slightly different looks on two screens, which is the
     specific thing this was asked for to stop. `flexShrink: 0` because the acronym is the handle and must
     not be the thing that ellipsises when the bar is narrow. */
  orContextAcronym: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  /* `orContextDot` is GONE -- design note #236. The whole bar is the corporation's colour now, so a dot of
     that same colour drawn on it was invisible by construction.
     Colours on these five are supplied per-render from `corporationBarInk`; what stays here is everything
     that does not depend on which corporation is acting. */
  orContextTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800 },
  orContextName: { fontSize: FONT_SIZE.small },
  /* Design note #671: a step BELOW the figures it now sits beside, deliberately.
     The rail's values are 14px tabular monospace because they are quantities a
     president compares; a name is not, and matching their weight would make the
     rail read as five figures with a typo in the last one.
     Design note #805: MORE important now that it sits directly under the treasury figure rather than beside
     four of them. A name and a quantity in one column, at one size and one weight, would read as two rows of
     the same table -- and the two things in this particular column are the corporation's money and the
     person's, which #743 has already had to stop the UI conflating once.
     It also carries its own layout now: it was spreading `orContextFact` for that and then overriding the
     6px gap back to 0, because `orContextFact`'s gap is the space between a CAPTION and its value and there
     is no caption here -- the crown brings its own 3px margin. Two declarations to reach one arrangement. */
  orContextPresident: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: FONT_SIZE.small,
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  /* Design note #805: the first fact is a two-row column -- treasury above, president below.
     `alignItems: flex-start` so the crown starts at the treasury caption's x rather than centring itself
     against a wider row; the 1px gap is `orContextIdentity`'s, so that the left column (herald over full
     name) and this one space their two rows identically and the second rows land together. */
  orContextTreasuryStack: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "1px",
    minWidth: 0,
  },
  /* Design note #236: the figures CONTINUE FROM THE LEFT. `marginLeft: auto` flung them to the far edge, so
     reading "PRR ... $640" meant crossing the bar and the figures ended up further from their own label than
     from the window edge. They flow inline after the identity, which is how the sentence reads. */
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
  /* Design note #673: the treasury as a previewed tile lay will leave it. Same face and size as the standing
     figure -- it is the same quantity, one step in the future, and shrinking it would read as a footnote rather
     than as the number the player is deciding about.
     A DASHED UNDERLINE is what marks it provisional. Colour alone cannot: the bar is painted in the acting
     corporation's own livery, so any hue chosen here is legible on some of the roster and invisible on the rest
     -- the same trap `hexBoardData` #561 records for the legality glow. A border is a shape, and a shape works
     on all eight. */
  orContextTreasuryPending: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
    borderBottom: "1px dashed currentColor",
    paddingBottom: "1px",
    whiteSpace: "nowrap",
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
  /* Design note #925: `tokenTargetBanner`, `tokenTargetDot` and `tokenTargetCancel` were deleted with the
     banner they dressed. Recorded rather than silently removed because an unreferenced style is invisible to
     the type checker -- #29's "dead props are a type error waiting for the real implementation to move",
     applied to a stylesheet, where there is no type error to wait for at all. */
  /* Design note #164: the two-row Operating Round panel.
     Design note #299: three stacked rows at 6px each is 18px of pure separation in a panel whose own rows
     are ~30px -- halved, which still reads as three distinct bands. */
  orPanel: { display: "flex", flexDirection: "column", gap: "3px", width: "100%" },
  /* Design note #481: `orPanelStepperRow` is GONE, and so is the rule that divided it from the action row.
     The strip is an inline phrase beside the round title now -- a style kept "in case" is how a deleted row
     comes back.
     Design note #426: this row was ALREADY true-centred, and is the model `actionBarButtons` was rebuilt to
     match; see that style's note for why the spacer pair only looked like centring. */
  orPanelActionRow: {
    display: "grid",
    // THE WHOLE POINT. Equal `1fr` rails mean the centre column is centred
    // on the PANEL, not on the leftovers -- so the action buttons stay put
    // however wide the badges or the utilities grow. `auto` in the middle
    // lets the actions size to their content rather than stretching.
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    gap: "10px",
    /* Design note #655: THE CEILING WAS THE BUG IT WARNED ABOUT. `maxHeight: 60px` capped this row's BOX, not
       its contents. Routes is the busiest step, so the centre column wraps and the real content runs past 60px
       -- and with no `overflow` set, that surplus paints outside the box.
       The reported rule is the next row's `borderTop`: that row is a SIBLING laid out at this row's DECLARED
       bottom edge while the buttons are still being drawn below it, so the divider lands across the controls
       and the chips that follow fall outside the panel's background and over the map.
       #426 named this failure while keeping it and raised the number instead. A ceiling on a wrapping row has
       no version that is right; the FLOOR is what #295 actually wanted, with `alignItems: center` keeping the
       contents centred in whatever height results. The chips were never mispositioned -- they were positioned
       relative to a boundary that lied. */
    minHeight: "48px",
  },
  /* Design note #631: THE SEAT CARD, built to `orContextCard`'s proportions rather than a badge's -- two
     identity blocks of different sizes on two rounds of the same bar would read as two kinds of thing.
     NO `borderRadius: 999px`: the pill shape is what made the old badge read as a tag ABOUT something rather
     than as the thing itself (#603 worked through the same distinction). A card is a rectangle.
     Background and border come from the CALL SITE, because only it knows the seat; everything that can be
     fixed is fixed here so the two cards cannot drift in shape while differing in colour.
     Design note #678: PROPORTIONS, NOT AXIS. Matching `orContextCard` meant its padding, radius and border --
     copying its column too was the part that did not follow, and it is the part that cost a row. */
  /* Design note #678: ONE ROW. The card stacked the name over the figures, and reported as "taking up vertical
     screen real estate" for nothing -- which is right, and the reason is that #631 borrowed a COLUMN from
     `orContextCard` along with its proportions. That card is a column because it has four things to say
     (acronym, full name, a rail of figures, privates); this one has a name and at most two numbers, so the
     column bought a second line of bar height to hold whitespace.
     BASELINE, not centre: the name is 14/800 and the figures 13/800 under a 10px caption, and centring three
     type sizes leaves the digits floating against the name. Sitting them on a shared baseline is what makes
     "Bradshaw  CASH $500" read as one line rather than as three things that happen to be adjacent.
     THE STACK WAS NEVER LOAD-BEARING -- #631's argument was about labelling the figures so a second number is
     not read as a delta on the first, and the labels do that inline exactly as well. */
  seatContextCard: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "baseline",
    gap: "12px",
    padding: "5px 12px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    whiteSpace: "nowrap",
    flex: "none",
  },
  seatContextName: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.02em",
    lineHeight: 1.15,
  },
  seatContextFigures: { display: "inline-flex", alignItems: "baseline", gap: "12px" },
  /* Design note #631: a NAMED figure, not "$500 (+$200)". The label is what stops a second figure being read
     as a delta on the first -- escrowed money is the opposite of income, and a plus sign cannot carry that.
     Design note #678: the note used to say "label above value", which the style has never done -- these are
     baseline-aligned at a 4px gap and always have been. Corrected rather than left, because the card just
     moved onto one row and a stale note claiming a stack is how the stack comes back. */
  seatContextFact: { display: "inline-flex", alignItems: "baseline", gap: "4px" },
  seatContextFactLabel: {
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  },
  seatContextFactValue: {
    fontSize: FONT_SIZE.body,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
  },
  /* Design note #631: THE ACTING-PLAYER BADGE WAS ALREADY UNREACHABLE. `playerCashBadge` and its parts are
     deleted. It was the `seatOrderTrail ?? ...` fallback in the non-Operating-Round branch, and #601 worked
     out that the trail is non-null for exactly the two rounds that branch renders -- and the one state that
     might have slipped past (no `gameState` yet) fails the cash guard too, since that figure derives from
     the same absent state.
     THAT IS THE SECOND DEAD FALLBACK IN THIS ONE `??`. Both were kept "for the case the trail does not
     cover", both described an empty set, and both compiled and linted perfectly for months. The shape to
     distrust is a fallback whose condition is the negation of a condition maintained in a different file.
     Design note #317: escrow qualifies the figure beside it rather than competing with it -- muted, and
     absent entirely when nothing is bid.
     Design note #563: the player-card grid's own section, spaced from the corporation cards rather than
     merged into their grid -- a shared grid would imply they were comparable cells. */
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
  /* Design note #578: the room gate. Deliberately plain -- it is a doorway, not a screen.
     Design note #581: the status-line dock, anchored to the bottom EDGE rather than given a height, so the
     expanded history grows upward and never off the screen. `maxHeight` with `overflowY` is the ceiling: a
     long history must not become the whole window, and 60vh leaves the board visible above it. */
  statusLineDock: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3000,
    display: "flex",
    flexDirection: "column",
    /* Design note #614: THE DOCK MUST NOT BE THE THING THAT SCROLLS. The dock is a column whose FIRST child
       is the header carrying Collapse, so a dock that scrolls can carry its own escape hatch off-screen -- and
       with the history scrolling too, a wheel gesture landed on whichever of two nested scrollers was under
       the pointer.
       ONE SCROLLER, AND IT IS THE LIST: `overflow: hidden` here, `flex` and `minHeight: 0` down the chain
       (`TopTicker.tsx #614`), so a capped dock shortens the HISTORY and never the header. The cap stays for
       #599's reason, and #605's scroll compensation still pushes the page down by whatever the dock takes. */
    maxHeight: "60vh",
    overflow: "hidden",
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
  /* Design note #601: eight `rosterPill*` styles deleted with the unreachable branch that was their only
     consumer. #406's 8em name ceiling is worth carrying forward -- `SeatOrderTrail` does not clamp its names,
     so a table of long sandbox nicknames widens the trail rather than truncating. If that ever overflows,
     a max-width on the seat name is the fix and this is the note that predicted it. */
  orPanelRailLeft: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    justifySelf: "start",
    /* Design note #482: THE CENTRING WAS ONLY EVER CONDITIONAL. A `1fr` track is `minmax(auto, 1fr)` and will
       not shrink below its content, so a rail holding a long line of text widens instead of clipping and drags
       the centre column with it. `minWidth: 0` is what makes the rail yield -- the sibling rail on the other
       bar has had it since #458. */
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
  /* Design note #490: a SECTION of the action panel rather than a card floating beneath it. The full border
     is gone -- a box inside a box reads as a separate object -- leaving a hairline doing the one job the
     border really did; `marginTop` pays for it, since `orPanel`'s 3px gap is too tight to sit a divider in.
     Design note #498: the collapsed bar's Run Routes train row, sized DOWN from the ordinary chip -- it lives
     in the pinned form, whose premise is that height is being taken from the board.
     Design note #518: THE SUB-PHASE TRAIL. Connected boxes rather than separated pills, sharing edges
     (`marginLeft: -1px` collapses the doubled border), so it reads as a SEQUENCE rather than a set of tags --
     the same construction the par ladder uses, and for the same reason. `flexWrap` because a wrapped trail
     still reads in order where a clipped one loses its tail. */
  /* ==================================================================
      DESIGN NOTE 920: THE TWO PROGRESS TRACKS SHARE A LINE
     ==================================================================
     The sub-phase trail and the corporation turn order answer the same question at two scales -- "how far
     through are we", within a turn and across the round -- so they belong on one row. #630 made exactly this
     argument when it moved the seat trail under the round label; the corporation order was the member of that
     family still sitting in the button rail.
     `flexWrap` SO A NARROW WINDOW DROPS THE ORDER BELOW rather than crushing the trail -- #590's rule again:
     wrap or scale, never decide which facts the player may keep. */
  /* ==================================================================
      DESIGN NOTE 946: ONE LINE, AND IT HAS TO STAY ONE LINE
     ==================================================================
     RULED: "the Round Title, subphase sequence, and corporation turn order must all sit on the exact same
     horizontal line", to save vertical space in the Action Bar.
     SO THE WRAP IS GONE. `flexWrap: "wrap"` was the house answer to a narrow window (#590: "wrapping or a
     smaller type scale, not deciding for the player which facts they may keep") -- and it is the one thing
     that can silently give the row back the second line this change exists to remove. A window narrow enough
     to need it would reintroduce the reported bug rather than degrade gracefully.
     WHAT REPLACES IT IS THE TREATMENT #930 ALREADY CHOSE for the turn order beside it: the row scrolls rather
     than wrapping, so every fact stays reachable and the height is fixed. That is #590's rule honoured by a
     different mechanism, not overruled -- nothing is dropped. */
  orProgressRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "10px",
    flexWrap: "nowrap",
    width: "100%",
    minWidth: 0,
    overflowX: "auto",
  },
  subPhaseTrail: {
    display: "inline-flex",
    flexDirection: "row",
    /* Design note #946: `nowrap`, for the row's reason. A trail that wrapped INSIDE a no-wrap row would grow
       the row's height, which is the vertical space this change was asked to reclaim -- so the two must agree
       about wrapping or the outer rule is decorative. */
    flexWrap: "nowrap",
    alignItems: "center",
    marginLeft: "10px",
    borderRadius: "6px",
    minWidth: 0,
    flexShrink: 0,
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
  /* Design note #739 gave the spectator a muted twin of `condensedTrainChip` -- "same shape, none of the
     affordance ... because the reader cannot act on it and a chip that looks clickable and is not is worse
     than one that plainly is not."
     Design note #815: `spectatorTrainChip` is DELETED, because the premise expired. A watcher CAN act on
     these chips now: #802 made a click open that train's route, and reading a rival's route is the whole
     point of the row. There is no longer a viewer for whom the chip is inert, so there is no longer a second
     style. #772's rule is why this is a deletion rather than an unused key -- neither `tsc` nor ESLint can
     see an orphan in a `Record<string, CSSProperties>`.
     Design note #815: and its replacement, marking the chip whose route is OPEN. An outline rather than a
     fill, because the fill already carries the drafting cursor -- two meanings on one channel is #732. */
  condensedTrainChipOpen: {
    outline: "2px solid #7fb2ff",
    outlineOffset: "1px",
  },
  /* The sum, set apart from the per-train chips: it is a different KIND of figure -- theirs are the parts,
     this is what the corporation actually earns -- and running it in the same chip style would invite it to
     be read as a fourth train. */
  spectatorTotal: {
    alignSelf: "center",
    marginLeft: "4px",
    paddingLeft: "8px",
    borderLeft: "1px solid #3a4150",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#7ee0a1",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
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
    /* Design note #705: WRAPS RATHER THAN OVERFLOWS. The row carries five things now (holder, share, and the
       three-part money move) in half the panel's width, and the bar is `position: sticky` -- it narrows with
       the viewport and cannot be scrolled sideways. A wrapped second line is legible; a clipped one is not. */
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "4px 10px",
    fontSize: FONT_SIZE.small,
    color: "#c8cdd8",
  },
  /* The percentage moved OUT of the amount and in beside the name. #705 put a three-part transition on the
     right of this row, and a parenthetical share sitting inside it read as part of the arithmetic; beside the
     holder it is what it always was -- a fact about who this is, not about the money. */
  dividendHolder: {
    whiteSpace: "nowrap",
    // Design note #706: the treasury row carries a herald before its name, so the row is a flex line rather
    // than bare text -- and the logo sits ON the baseline with the ticker rather than above it.
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
  },
  dividendAmount: { fontVariantNumeric: "tabular-nums", color: "#7ee0a1", fontWeight: 700 },
  dividendPct: { color: "#6f7480", fontWeight: 400 },
  /* Design note #705: the money move, kept on one line of its own so the arrow never separates from the
     figures it points between. Same vocabulary as `treasuryMove` deliberately -- the Pay column and the
     Withhold column are two answers to one question and should not read as two designs. */
  dividendMoveGroup: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "baseline",
    gap: "4px",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    marginLeft: "auto",
  },
  /* Muted, like the departure figure it follows: the `+` is grammar, not a value. */
  dividendPlus: { color: "#6f7480", fontWeight: 400 },
  dividendNote: { fontSize: FONT_SIZE.small, color: "#9aa0ac", lineHeight: 1.4 },
  dividendMove: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#9ec5ff", marginTop: "4px" },
  /* Design note #214: the arrow is the one glyph in the line carrying a DIRECTION, so it takes the
     direction's colour, sized and weighted past the zone-tinted prices either side -- if it merely matched
     them the line would read as three coloured things competing rather than one movement between two values.
     `lineHeight: 1` because the diagonal glyphs sit taller than the digits. */
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
  /* Design note #713: the sale's market consequence, under the treasury block it accompanies. Sized and
     spaced like `treasuryMove` deliberately -- a player reads one shape for "what this does to a number",
     whichever number it is. The arrow is red and points the only way a sale ever moves a price. */
  /* Design note #717: the armed state, in the same green the app uses for a thing that is working rather than
     a thing that is urgent. Not a toggle switch: this is a button whose LABEL changes, so the state is legible
     in a screenshot and to a screen reader without anybody having to interpret a colour. */
  autoPassArmed: {
    borderColor: "#3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontWeight: 700,
  },
  saleMarketMove: {
    display: "flex",
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: "6px",
    fontSize: FONT_SIZE.small,
    fontVariantNumeric: "tabular-nums",
    marginTop: "3px",
  },
  saleMarketLabel: { color: "#8a90a0", fontWeight: 400, marginRight: "2px" },
  saleMarketArrow: { color: "#f87171", fontWeight: 900, fontSize: "1.15em", lineHeight: 1 },
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
  /* Design note #835: the Track step's "the action is on the map" line, on its OWN row beneath the controls.
     `orPanelActions` wraps, so a hint sharing the row sat to the left of the buttons it describes -- which is
     where it has been since #279, and reads as a label for them rather than as a note under them.
     `flexBasis: 100%` forces the wrap; `textAlign: center` matches the row's `justifyContent`.
     ITS OWN KEY RATHER THAN A SPREAD-PLUS-OVERRIDE, per #772: a style assembled at the call site is invisible
     to the sheet, and this one carries a layout fact (the full-width row) that belongs with the layout. */
  orPanelStepHint: {
    flexBasis: "100%",
    textAlign: "center",
    fontSize: FONT_SIZE.small,
    color: "#6f7480",
    fontStyle: "italic",
  },
  /* Design note #707: NOT `orPanelNoActions`. That is the Track step's "the action is on the map" hint --
     muted and italic, which is right for orientation nobody was looking for. This line stands where a BUTTON
     was, and a player hunting for Skip needs to find the sentence explaining its absence rather than read past
     it. Upright, brighter, and no italic; still not an alert, because nothing has gone wrong. */
  /* `orPanelObligation` REMOVED by design note #800 with the sentence it styled -- "B&O has a route it can
     run, so it must. Which route is up to you." The rule it described still withdraws Skip (#41); only the
     prose is gone, and the second half of it moves to the tutorial being built.
     DELETED RATHER THAN LEFT UNUSED, per #772: `styles` is typed `Record<string, CSSProperties>`, so an
     orphan key is invisible to both `tsc` and ESLint and sits there looking like a thing to reach for. */
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
    // Design note #13/item 1: `overflow: "auto"` removed -- see `canvasPane` above. `StockMarketRenderer`
    // still gets its pane height from this same un-clipped flex chain; only the Rail Map's canvas actually
    // grows past one viewport in practice.
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

