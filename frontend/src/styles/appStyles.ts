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

import { CONTROL_PADDING, FONT_SIZE, LINE_HEIGHT, RADIUS } from "./typography";
import {
  ALERT_CRITICAL_BG,
  ALERT_CRITICAL_BORDER,
  ALERT_CRITICAL_INK,
  ALERT_WARN_BG,
  ALERT_WARN_BORDER,
  ALERT_WARN_INK,
  SANDBOX_INK,
  SANDBOX_PANEL,
  SANDBOX_RAISED,
  SANDBOX_RULE,
  SANDBOX_RULE_STRONG,
  SANDBOX_TEXT,
  SANDBOX_TITLE,
  TURN_PULSE_INK_RGB,
} from "./palette";
import type { GamePhase } from "../utils/gamePhase";
/* Design note #884 imported `PRIVATE_POWER_GLOW_STOPS` here, for the chip's gradient strip.
   Design note #976: the strip is gone and so is the import -- this sheet had exactly one consumer of the
   list, and an unused import is the half of a deletion that gets left behind. The palette itself is
   untouched and still drawn by `HexGridRenderer` and the auction dashboard. */

export const NEUTRAL_PHASE_BADGE: React.CSSProperties = {
  borderColor: "#3a3a3a",
  backgroundColor: "#141414",
  color: "#c8c6c0",
};
export const PHASE_TINT_STYLES: Readonly<Record<GamePhase["tint"], React.CSSProperties>> = {
  yellow: NEUTRAL_PHASE_BADGE,
  green: NEUTRAL_PHASE_BADGE,
  brown: NEUTRAL_PHASE_BADGE,
};

/* ==================================================================
    DESIGN NOTE 1144: ONE NUMBER, AND WHY IT IS NOT A SETTING YET
   ==================================================================
   0.7 WAS THE FIGURE THE PLAYER WAS ALREADY USING, read off their browser's zoom control over several
   playtests rather than guessed at here. RULED: "fixed now, control later if playtesters ask" -- so it is a
   constant in one place, and a `localStorage`-backed picker in the top bar is a follow-up rather than a
   control nobody has asked for, in a bar several batches have spent their length de-cluttering.

   ==================================================================
    DESIGN NOTE 1149: 0.63, AND WHY MULTIPLYING THE TWO ZOOMS IS EXACT
   ==================================================================
   REPORTED against #1144: "I still need to zoom out my browser to 90% to get the right aspect."

   THE TWO ZOOMS COMPOSE, AND THE COMPOSITION DEPENDS ONLY ON THEIR PRODUCT -- which is worth deriving rather
   than assuming, because the obvious worry is that they do NOT compose. Browser zoom scales everything
   uniformly; this one shrinks the FIXED chrome and lets the flexible board pane absorb whatever that frees.
   Those sound like different operations. With fixed chrome `F`, viewport `W`, app scale `s` and browser zoom
   `b`, the root lays out at `(W / b) / s`, so the board pane takes `(W / b) / s - F` and lands on screen at
   `W - F * s * b`, with the chrome at `F * s * b`. Both terms see `s` and `b` only as a product: the split
   between chrome and board is identical for any pair with the same `k = s * b`.
   SO 0.7 x 0.9 IS NOT AN APPROXIMATION OF WHAT THE PLAYER IS LOOKING AT. It is the same layout, and setting
   the constant to 0.63 at 100% browser zoom reproduces it exactly rather than merely closely.
   AND IT SAYS THE ORIGINAL READING WAS SIMPLY SHORT. #1144 took 0.7 from the browser control, which is a
   coarse instrument -- Chrome's next step down from 100% IS 90%, and 80% and 67% are the ones after it, so a
   player converging on "about right" through those stops can only land within about a tenth. Two playtests
   have now bracketed it, and 0.63 is the second reading rather than a correction of a mistake in the first.
   TWICE IS THE SIGNAL FOR THE PICKER. If a third reading moves it again, the follow-up ruled out above has
   earned its place: this is a per-reader preference being fitted by successive approximation from here. */
export const UI_SCALE = 0.63;

/* ==================================================================
    DESIGN NOTE 1144: ONE ZOOM, SPREAD ON ALL THREE ROOTS
   ==================================================================
   THE LOBBY AND THE WAITING ROOM ARE NOT INSIDE THE SHELL. Both are early returns above `AppShell`'s root, so
   a zoom applied there alone would have left the game room at 70% and the two screens on either side of it at
   100% -- and the batch immediately before this one spent its length making the footer read the SAME on all
   three ("the Lobby and Waiting Room ones look like they could shrink another 10%"). Scaling one of the three
   would have undone that with the first screen change.
   IT IS ALSO WHAT THE REPORT DESCRIBES. A browser's zoom control is not per-route; the player has been at 70%
   on every screen, and that is the state the three footers were balanced in.
   EXPORTED AS AN OBJECT rather than left as a `styles` entry, because two of its three consumers do not import
   this table at all and should not start importing a shell's style sheet to get one declaration. */
export const CHROME_ZOOM: React.CSSProperties = {
  zoom: UI_SCALE,
  /* ==================================================================
      DESIGN NOTE 1144: A VIEWPORT UNIT INSIDE A ZOOM IS NOT A VIEWPORT UNIT
     ==================================================================
     MEASURED, not reasoned about, because the two plausible answers differ by 30% of the screen: in Chrome
     148 a `100vh` box inside `zoom: 0.7` comes back 560px tall on an 800px window. `vh` resolves against the
     real viewport and is THEN scaled, so the `minHeight: 100vh` that keeps a ground under every one of these
     three screens would stop three-tenths of the way up and show the body colour beneath it. That is the same
     fault as #1140's footer band, arriving by a different route.
     CORRECTED HERE RATHER THAN IN EACH ROOT, so the compensation travels with the thing that causes it. A
     reader who deletes the zoom deletes this with it, instead of leaving a 142vh floor behind.
     WHAT SURVIVED THE SAME MEASUREMENT UNTOUCHED, so nobody re-checks it: a `position: fixed` layer inside the
     zoom still covers the whole window (the fixed containing block is zoom-adjusted), and a child at
     `width: 100%` still fills it -- so the modals' `84vh` caps and the toast's `100vw` clamp scale WITH their
     contents and read exactly as before, one size smaller. */
  minHeight: `${100 / UI_SCALE}vh`,
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
    backgroundColor: "#0f0f0f",
    borderBottom: "1px solid #2a2a2a",
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
    border: "1px solid #2a2a2a",
    backgroundColor: "#141414",
    color: "#6e6c68",
    whiteSpace: "nowrap",
    flexShrink: 0,
    cursor: "help",
  },
  /* Design note #930: still to come. The same treatment the sub-phase trail gives an unreached step -- it is
     the same fact about a sequence. */
  orTurnOrderChipUpcoming: { color: "#8a8a86" },
  /* DIMMED, NOT REMOVED. A row that shortens as the round goes on stops being an ORDER and becomes a queue,
     and "have they gone yet" is the question a player asks about the corporations behind them. */
  /* Design note #930: `opacity` dimmed the BORDER as well as the text, which on a livery-coloured chip made
     "already operated" look like a rendering fault. An explicit ink and fill instead, matching
     `subPhaseStepDone`. */
  orTurnOrderChipDone: { color: "#8a8a86", backgroundColor: "#161616" },
  /* THE ACTING ONE IS FILLED, and both its background and its ink are written INLINE at the call site --
     the fill from the corporation's livery, the ink from `bestContrastTextColor` against it. Neither can be
     a static entry here, so there is no `orTurnOrderChipActing` to define; saying so is worth a line,
     because an absent style in a set of three reads as an oversight. */
  phaseBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.03em",
    padding: "3px 10px",
    borderRadius: RADIUS.pill,
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
    borderRadius: RADIUS.pill,
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
    /* Design note #1099: the credit carries the logo now, so it lays its two children out rather than
       being a bare text node. `inline-flex` and not `flex`, so the anchor stays the width of its content
       and the footer's `justifyContent: center` still centres the pair. */
    display: "inline-flex",
    alignItems: "center",
    // Design note #1137: 5px, the lobby's tightened gap (#1135), now the only gap.
    gap: "5px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    letterSpacing: "0.02em",
    // Design note #1137: white, tight and shadowed on every surface -- see the note above `appFooter`.
    color: "#f2f0eb",
    textShadow: "0 1px 4px rgba(8, 8, 8, 0.85)",
    textDecoration: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  /* Design note #1129: the meta surfaces' mark is 31px against the board's 18px, so the words beside it move
     one step of the scale too -- `micro` next to a 31px mark reads as a caption parked beside a logo rather
     than as the second half of one object. The gap tightens for the same reason: a wide gap at a small type
     size is what turns a lockup into two things. */
  /* ==================================================================
      DESIGN NOTE 1135: THE PLATE WAS SOLVING A PROBLEM THAT HAD ALREADY MOVED
     ==================================================================
     RULED: "I don't like the logo and 'Powered by Neta DAO' being in a pill/container." AND THE PILL CAN
     SIMPLY GO, which is worth stating rather than just doing, because two notes in a row argued it was
     load-bearing.
     #1132 GAVE THE FOOTER AN OPAQUE STRIP so the mark's `screen` blend had a dark backdrop; #1133 narrowed
     that strip to a plate on the lockup. Both were answering a black box that appeared when the footer sat
     BELOW the scene layer on bare ink, at the wrong end of the page. #1133's other half fixed that -- the
     picture reaches the foot of the root now -- and the corner the credit lands in is one of the darkest
     parts of the whole photograph: worst pixel L 0.0054 under the page scrim, which is visually black.
     SO THE BACKDROP IS ALREADY WHAT THE PLATE WAS SUPPLYING. `screen` keys against the room itself, and
     paper reads 16.64:1 on the worst pixel down there. The plate had become a rectangle drawn to guarantee a
     condition that was true anyway.
     THE SHADOW IS THE INSURANCE THAT REPLACES IT, and it is cheap: `cover` crops differently by aspect, so
     some window somewhere puts a brighter part of the room under this corner. A shadow costs nothing when it
     is not needed and saves the one case where it is -- which a rectangle does too, far more loudly.
     WHITE, AS RULED, and closer: the credit stops being `#8a8a86` metadata beside a logo and becomes the
     other half of one object, which is what the tighter gap is for. */
  /* Design note #1137: `netaCreditMeta` is GONE and its three properties moved into `netaCredit` itself --
     white, tight, shadowed. They were ruled for the lobby (#1135) and there was never a reason the board
     should disagree: the shadow costs nothing on a flat ground, and the credit reads as one lockup on both. */
  /* ==================================================================
      DESIGN NOTE 1083: THE PAGE ENDS HERE
     ==================================================================
     A row rather than a bar: no background, no border, nothing that would read as another strip of chrome in
     a shell this batch is spending its whole length de-cluttering. What makes it a footer is its POSITION and
     the space above it, not a rule across the page.
     `marginTop: auto` IS LOAD-BEARING and is why `appRoot` is a column flex: it pushes this to the bottom on
     a short page (a lobby, an error screen) instead of leaving it floating under half a viewport of nothing.
     On a long page it simply follows the content.
     CLEAR OF THE STATUS DOCK. `appRoot` already carries 96px of bottom padding for the fixed dock (#581);
     this sits inside that padding's flow, above it, so the credit is never underneath the ticker. */
  /* Design note #1132: the meta strip. Opaque ink so the mark's `screen` blend has the near-black it was
     drawn for, `relative` + `zIndex` so it sits above the lobby's scene layer rather than under it, and
     `flex-start` because a full-width bar reads from its leading edge. */
  /* ==================================================================
      DESIGN NOTE 1137: ONE FOOTER, THREE SCREENS
     ==================================================================
     REPORTED across all three: fine in the lobby, "nearly overlapping the panel" in the waiting room with the
     mark "rising above" it, and "much smaller and centred" in the game. THREE TREATMENTS FOR ONE CREDIT, and
     each was reasoned separately -- #1124 sized the meta mark up so its animation would register, #1132 moved
     the meta footer flush left, and the board kept #1099's original 18px centred. Nobody ever compared them
     side by side, which is exactly what a player does by walking through the three screens in order.
     STANDARDISED, AS RULED: one size, one alignment, one padding, on every surface. `appFooterMeta` is gone
     rather than retuned -- a per-surface override is the thing that produced the drift, so what replaces it
     is nothing.
     FLUSH RIGHT, also as ruled. The lobby's account row is already right-aligned and the game's top bar puts
     its wallet cluster there; the credit joining that edge makes one margin the app's furniture column
     instead of two competing ones.
     THE TOP PADDING IS THE OVERLAP FIX. `marginTop: auto` pins this to the bottom of a flex column, and in
     the waiting room the panel can reach that far -- so with no space above it the mark butted the panel and
     appeared to climb it. 18px is a gap the footer carries itself, rather than something each surface has to
     remember to leave. */
  appFooter: {
    marginTop: "auto",
    /* ==================================================================
        DESIGN NOTE 1140: THE Z-INDEX WENT OUT WITH THE OVERRIDE THAT CARRIED IT
       ==================================================================
       REPORTED: "'Powered by Neta DAO' doesn't render on the Lobby page, just the animation." THE TEXT WAS
       ALWAYS IN THE MARKUP -- what changed is what paints over it.
       #1132 GAVE THE META FOOTER `position: relative` AND A Z-INDEX, buried among the four properties that
       made it a flush-left ink strip, and the reason was never about ink: the lobby's `sceneClip` is a
       POSITIONED element at z-index 0, and a positioned element paints above unpositioned in-flow siblings
       however late they appear in the document. Without a z-index of its own the whole footer goes under the
       photograph.
       #1137 THEN DELETED THAT OVERRIDE WHOLESALE, on the correct reasoning that a per-surface footer style
       was what had let three screens drift apart -- and took the stacking fix with it, because it had never
       been labelled as anything but part of the strip. The mark survived because `mix-blend-mode` promotes it
       to its own compositing layer; the words, having no such trick, simply went under.
       SO IT LIVES ON THE BASE STYLE NOW, where it costs nothing on a flat shell and is not something a future
       "one footer, no overrides" sweep can quietly remove. */
    position: "relative",
    zIndex: 1,
    display: "flex",
    /* Design note #1140: BACK TO CENTRE. Flush right was #1137's answer to a footer that looked wrong beside
       everything else, and the wrongness turned out to be the missing half of the lockup rather than its
       alignment -- see the note on `MARK_HEIGHT`. Centred is where it started and where a credit belongs. */
    justifyContent: "center",
    alignItems: "center",
    padding: "18px 20px 12px",
    boxSizing: "border-box",
    width: "100%",
  },
  /* Design note #1083: the room's code in the title strip, in the treatment it had in the bar it came from --
     monospace, sized up, and `userSelect: "all"` so one click takes the whole code. It is the string a player
     relays to somebody else, which is the entire reason it is not a chip. */
  topBarRoom: { display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 },
  topBarRoomLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  topBarRoomCode: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.08em",
    color: "#7ee0a1",
    userSelect: "all",
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
  /* Design note #1119: the offline state as a dot, so it sits in the same row and the same vocabulary as the
     session-key and wallet dots rather than as a warning badge shouting a build variable at a player. Amber
     is the colour the old badge's border carried, kept so the state is recognisable to anyone who knew it. */
  topBarDotOffline: { backgroundColor: "#d9b95c" },
  topBarDot: {
    width: "9px",
    height: "9px",
    borderRadius: RADIUS.circle,
    flexShrink: 0,
    cursor: "help",
  },
  topBarAddress: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    color: "#a8a6a0",
    whiteSpace: "nowrap",
  },
  topBarButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.pill,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  /* ==================================================================
      DESIGN NOTE 1009: THE AUDIO TOGGLES ARE ICONS, AND ICONS NEED A SQUARE
     ==================================================================
     REQUESTED: "simple, elegant toggle icons ... to the app's global Header ... ensure the Header UI controls
     are cleanly aligned."

     `topBarButton` IS A PILL SIZED BY ITS TEXT, which is right for "Session Key" and "Disconnect" and wrong
     for a single glyph: two one-character buttons under it come out at two different widths, because a
     speaker and a musical note have different advances. A FIXED SQUARE is what makes a row of icons read as a
     row -- so this sets `width` and `height` rather than horizontal padding, and centres the glyph in it.

     THE PAIR SITS IN ITS OWN GROUP (`topBarAudioGroup`) so the gap between the two icons is tighter than the
     bar's own gap. They are one control in two halves; spaced like everything else they read as two unrelated
     buttons that happen to be adjacent.

     ONE TREATMENT, TWO STATES, NO SECOND GLYPH. Muted is the same icon dimmed and unfilled -- a slash through
     a speaker is a third thing to recognise, and at 13px it is a smudge. `aria-pressed` carries the state to
     anybody not reading the colour, which is the half a purely visual toggle leaves out. */
  /* Design note #1120: the station name beside the radio button. Sized and toned as a QUIET label -- it is
     an answer to "what is playing", not a control, and the row it sits in is already busy. `maxWidth` plus
     ellipsis because station names are supplied data and a long one would push the wallet cluster around;
     the full name is in the `title`. */
  /* ==================================================================
      DESIGN NOTE 1134: THE DRAWER
     ==================================================================
     Rounded on the left, SQUARE on the right, and pulled 13px under the 26px radio button so the circle caps
     its open end. That overlap is the whole idea -- a rectangle merely NEAR a button is another loose object
     in a row that already had too many; a rectangle the button sits on top of is a thing that came OUT of
     the button. `paddingRight` covers the tucked-away strip so the last stepper never lands beneath it.
     ONE COLOUR FOR THE WHOLE ASSEMBLY, carried by `color` and inherited: the steppers draw in `currentColor`
     and the name reads it too, so the on/off state is stated once here rather than three times at the leaves.
     The stopped tone is the same `#6e6c68` the disabled controls use -- under the text bar deliberately,
     because an inert readout should read as inert. */
  stationDrawer: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    height: "22px",
    boxSizing: "border-box",
    padding: "0 17px 0 4px",
    marginRight: "-13px",
    borderRadius: `${RADIUS.pill} 0 0 ${RADIUS.pill}`,
    border: "1px solid #2a2a2a",
    borderRight: "none",
    backgroundColor: "#141414",
    color: "#6e6c68",
    flexShrink: 1,
    minWidth: 0,
  },
  /* Design note #1134: "when the radio is active, the title and station seeks should be coloured the active
     white". One declaration, because `currentColor` carries it to every child. */
  stationDrawerOn: {
    color: "#f2f0eb",
    borderColor: "rgba(242, 240, 235, 0.35)",
    backgroundColor: "#1c1c1c",
  },
  /* Design note #1134: the button that caps the drawer has to paint OVER its open edge, and a positioned
     element with a z-index is the only thing that reliably does. Nothing here blends, so the stacking
     context this creates costs nothing -- unlike the one that put a box round the lobby title (#1132). */
  topBarIconButtonCaps: { position: "relative", zIndex: 1 },
  topBarStationName: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    letterSpacing: "0.02em",
    // Design note #1134: inherits the drawer's state colour instead of naming its own.
    color: "inherit",
    maxWidth: "104px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flexShrink: 1,
    minWidth: 0,
    cursor: "help",
  },
  /* ==================================================================
      DESIGN NOTE 1127: STOPPED IS DIMMER, NOT ABSENT
     ==================================================================
     The readout is permanent now, so it needs a way to say "this is what WOULD play" without claiming to be
     playing. It dims to the same `#6e6c68` the disabled controls use -- 3.52:1 on the bar, which is under the
     text bar and is the POINT: an inert label should read as inert. It is `aria-hidden` and always has been,
     so nothing is lost to a screen reader, which gets the state from the button's own #1078 label instead. */
  /* Design note #1134: `topBarStationNameOff` is GONE. The drawer states the state for the whole assembly
     now, so a second declaration at the leaf could only disagree with it. */
  /* Design note #1127: smaller than `topBarIconButton`'s 26px circle and square rather than round, so the two
     steppers read as satellites of the note button rather than as three equal controls. `#34`'s note that
     this group is the first thing to wrap still holds -- these are the cheapest items in the row to push to a
     second line, which is why they are the smallest. */
  /* ==================================================================
      DESIGN NOTE 1134: "THE SEEK BUTTONS DON'T LOOK INTERACTIVE"
     ==================================================================
     THEY WERE TRANSPARENT WITH A HAIRLINE, which in this bar is the costume of an inert chip -- `chainPill`
     and `forcedSignChip` both wear it, and neither does anything on click. Every control here that IS a
     control has a FILL: `topBarIconButton` is `#1c1c1c` on `#3a3a3a`, and so are the buttons in the room
     bar. The steppers were dressed as labels.
     FILLED AND RAISED, to the same recipe as the icon buttons they sit beside -- one step above the drawer
     they sit in, which is what makes them read as pressable rather than printed. The ink stays
     `currentColor` so they still take the drawer's on/off state. */
  topBarStationStep: {
    width: "18px",
    height: "18px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#262626",
    color: "inherit",
    cursor: "pointer",
    flexShrink: 0,
  },
  topBarAudioGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
  },
  topBarIconButton: {
    width: "26px",
    height: "26px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: FONT_SIZE.small,
    lineHeight: 1,
    padding: 0,
    borderRadius: RADIUS.pill,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#6e6c68",
    cursor: "pointer",
    flexShrink: 0,
  },
  /** The lit half of the toggle -- design note #1009. Silver rather than a hue, for #35's reason: the bar
   *  already spends its colour budget on the wallet and session status dots, and a third colour there would
   *  read as a fourth status rather than as a control the player set. */
  topBarIconButtonOn: {
    color: "#f2f0eb",
    borderColor: "rgba(242, 240, 235, 0.55)",
    backgroundColor: "#2a2a2a",
  },
  // The one call to action in the bar, so it is the one thing in it with a
  // filled treatment.
  topBarConnectButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.pill,
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
    /* Design note #1098 (TD-6): WAS AMBER, WHICH CLAIMED YOUR ATTENTION FOR A FACT THAT NEVER CHANGES.
       Amber says "something needs looking at"; watching a game is a state you are simply in, for the whole
       session. Neutral says it once and stops asking. 10.79:1, up from the gold's 10.21:1. */
    backgroundColor: "#141414",
    borderTop: "1px solid #2a2a2a",
    borderBottom: "1px solid #2a2a2a",
    color: "#c8c6c0",
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
    backgroundColor: "#141414",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2a2a2a",
    borderRadius: RADIUS.card,
    boxSizing: "border-box",
  },
  globalActionBarLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.6px",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  globalActionButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // the disabled look is computed, never assumed.
  globalActionButtonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  globalActionBarHint: { fontSize: FONT_SIZE.small, color: "#8a8a86" },
  // ---- Sandbox phase switcher (design note #25). Violet, matching the
  // sandbox badge beside it, so it reads as part of the debug affordance
  // and never as a gameplay control. ----
  phaseToggleGroup: { display: "flex", gap: "4px", flexShrink: 0 },
  phaseToggleButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.pill,
    borderWidth: "1px",
    borderStyle: "solid",
    /* Design note #1122: the sandbox family, luminance-matched to the ink ladder it stands beside. */
    borderColor: SANDBOX_RULE,
    backgroundColor: SANDBOX_PANEL,
    color: SANDBOX_TEXT,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  phaseToggleButtonActive: {
    backgroundColor: SANDBOX_RAISED,
    borderColor: SANDBOX_RULE_STRONG,
    color: SANDBOX_INK,
  },
  /* ==================================================================
      DESIGN NOTE 1128: A DEBUG CONTROL DRESSED AS A DEBUG CONTROL
     ==================================================================
     It sits next to OFFLINE SANDBOX and borrows that badge's pill shape, because it belongs to the same
     family -- things that are true about this build rather than about this game. Disarmed it is the inert
     chip treatment: no fill, a hairline, muted ink, so it does not compete with the badge beside it.
     ARMED IT GOES AMBER, which #1094 freed to mean "heads up, nothing is broken" -- exactly right for a
     forced event that has not happened yet. Not red: nothing is wrong, a playtester asked for this. */
  forcedSignChip: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    padding: "3px 10px",
    borderRadius: RADIUS.pill,
    border: "1px solid #2a2a2a",
    backgroundColor: "transparent",
    color: "#6e6c68",
    cursor: "pointer",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  forcedSignChipArmed: {
    borderColor: "#6b5a24",
    backgroundColor: "#2a2413",
    color: "#d9b95c",
  },
  sandboxBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    padding: "4px 12px",
    borderRadius: RADIUS.pill,
    /* Design note #1122: the badge is the in-game end of the same signal the lobby's strips carry, so it
       reads from the same constants rather than from a third hand-picked purple. */
    backgroundColor: SANDBOX_RAISED,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    color: SANDBOX_TITLE,
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
    borderRadius: RADIUS.pill,
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
    borderRadius: RADIUS.pill,
    backgroundColor: "#3a2f14",
    border: "1px solid #6a5a24",
    color: "#e0c07a",
    flexShrink: 0,
  },
  roomStripLabel: { display: "inline-flex", alignItems: "center", gap: "6px" },
  roomStripValue: { color: "#f2f0eb", fontWeight: 700 },
  roomStripDivider: { width: "1px", alignSelf: "stretch", minHeight: "16px", backgroundColor: "#2a2a2a" },
  roomStripError: { color: "#f0b0a8", fontSize: FONT_SIZE.small },
  /* ==================================================================
      DESIGN NOTE 1144: THE ZOOM THE PLAYER HAD BEEN APPLYING BY HAND
     ==================================================================
     REPORTED: "I have to scale my browser to 70% for these things to look right, and it may have been that
     I've been playing with a 70% browser scaling until this latest playtest ... if you don't see anything
     changed that would affect their scaling, then this is likely the culprit."
     NOTHING CHANGED, AND THE HISTORY SAYS SO. `typography.ts` has not moved since `a014db5`, and the retheme's
     whole diff on the Auction and Stock panels is two lines, both hex values. The Auction's cards-per-row and
     the Stock panel's are decided by `minmax(240px)` and `minmax(300px)` floors that no commit in this
     sequence touches. The app draws today what it drew before; the reader had been viewing it 1.43x smaller.
     `typography.ts` #3 DIAGNOSED THIS EXACT THING AND UNDERSHOT. Its own words: "two earlier passes compounded
     to about 1.4x, and a UI drawn 1.4x too large is one a player fixes with the zoom control -- which is the
     report." It then took the type down and stopped, which is the half that was reachable: 601 of the 622
     `fontSize` call sites read that module, but only 21 of 413 paddings read `CONTROL_PADDING`. Type came down
     and its boxes did not, which is the failure that note warns about one paragraph later -- "text shrunk
     without shrinking its box leaves controls that are small AND still tall".
     SO THE SCALE IS APPLIED THE WAY THE PLAYER WAS APPLYING IT. `zoom` scales everything a browser's own zoom
     scales -- type, padding, gaps, borders, the lot -- which is precisely why it succeeds where three passes
     over a type module could not: it does not need 392 paddings to have been centralised.
     THE CANVASES ARE EXCLUDED, because they were never the problem. Both renderers already carry zoom-aware
     scaling of their own (`HexGridRenderer` #30 caps the board to the viewport), and the report says so
     directly: "the one thing that doesn't seem to have grown is the Rail Map". `boardPane` counter-zooms.
     NOT `transform: scale()`, which was the other candidate and is wrong here: a transform does not affect
     layout, so the page would be drawn small inside a full-size box and every scroll height, sticky offset
     and `100vh` would still be computed at 100%. `zoom` reflows, which is the entire point. */
  appChromeZoom: CHROME_ZOOM,
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
    backgroundColor: "#080808",
    color: "#f2f0eb",
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
    borderRadius: RADIUS.pill,
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
    borderRadius: RADIUS.control,
    border: "1px solid #6b5a24",
    backgroundColor: "#2a2413",
    color: "#d9b95c",
    cursor: "help",
  },
  button: {
    fontSize: FONT_SIZE.strong,
    padding: "9px 18px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
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
  /* ==================================================================
      DESIGN NOTE 1084: THE SEPARATION IS A GAP, NOT A RULE
     ==================================================================
     ASKED, with the bar moving above the tabs: "should we add a subtle drop-shadow or a bottom border to it
     so it visually separates from the navigation tabs directly beneath it?"

     NEITHER, because both would be a second statement of something already said three ways. `actionBar` is
     `#141414` with a full 1px `#2a2a2a` border and a 10px radius -- it is a CARD, outlined on all four sides
     -- while this strip is `#0f0f0f` and the page behind both is `#080808`. A bottom border would be a second
     border on an edge that already has one; a drop shadow would say "floats above", which is wrong for two
     things stacked in a column.

     Design note #1092 retoned all four of those values and the ARGUMENT is unchanged, which is the point of
     restating them here rather than leaving the old hexes to rot: the three grounds still step apart in the
     same order and by a comparable amount, so a card outlined against a strip against a page is still what a
     reader sees. Only the cast moved, slate-blue to neutral.

     WHAT THEY LACKED WAS AIR. Flush, a bordered card and a flat strip read as one welded assembly. 10px of it
     is enough to make them two objects, and it goes HERE rather than on the bar because #426's rule holds: a
     sticky element's own bottom margin travels with it and offsets it from its pin.

     AND THE PINNED FORM ALREADY HAS THE SHADOW. `actionBarCondensed` squares the top corners and adds
     `0 2px 10px rgba(0,0,0,0.45)` when the bar is stuck to the viewport -- which is the one moment the bar is
     genuinely floating over something. The separation the question asked for exists; it appears when it is
     true rather than being drawn permanently. */
  mainTabBar: {
    marginTop: "10px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    rowGap: "6px",
    /* ==================================================================
        DESIGN NOTE 1150: THE STRIP AND ITS PANEL DISAGREED BY FOUR PIXELS
       ==================================================================
       REPORTED: "the game room tabs sit slightly outside the viewport, with the leftmost tab extending a bit
       off the side."
       FOUND BY READING THE TWO INSETS RATHER THAN BY EYE, because four pixels is exactly the size of mistake
       that gets attributed to something else: this strip inset its buttons by 16 and `canvasPane` insets the
       panel below by 20, so the leftmost tab began four pixels to the LEFT of the panel it belongs to. Not
       "off the viewport" in the literal sense -- outside the shape the tabs are supposed to be attached to,
       which is what the eye reports.
       NEITHER NUMBER WAS EVER ARGUED FOR against the other. #1118 closed the vertical seam between these two
       surfaces and made them read as one assembly, which is precisely what turned a horizontal difference
       nobody could see into one nobody could miss -- the same story as #1117 making the viewport ground
       visible before this strip's alignment could matter at all.
       MATCHED TO THE PANEL, not split between them: 20 is the one with a reason (it "keeps the panel's border
       and radius visible", #1118), and 16 was only ever the strip's own habit. */
    padding: "6px 20px",
    backgroundColor: "#0f0f0f",
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
    borderRadius: `${RADIUS.card} ${RADIUS.card} 0 0`,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(42, 42, 42, 0.85)",
    borderBottomWidth: 0,
    backgroundColor: "rgba(15, 15, 15, 0.6)",
    color: "#8a8a86",
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
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a5a8a",
    backgroundColor: "#141414",
    color: "#9ec5ff",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  mainTabButtonActive: {
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontWeight: 700,
    borderColor: "rgba(242, 240, 235, 0.8)",
    borderBottomColor: "#1c1c1c",
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
    color: "#6e6c68",
    margin: "0 0 4px",
  },
  /* Design note #813: the sticky-fit probe's readout. Deliberately plain and deliberately ugly -- it is an
     instrument, not a feature, and it should look like something that is going to be removed. Monospace and
     tabular so the figures do not jitter as they update on every scroll frame. */
  fitProbe: {
    margin: "4px 0 0",
    padding: "3px 8px",
    borderRadius: RADIUS.control,
    border: "1px dashed #4a4a4a",
    backgroundColor: "#0f0f0f",
    color: "#a8a6a0",
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
    /* ==================================================================
        DESIGN NOTE 1118: THE TABS SIT ON THEIR CONTENT NOW
       ==================================================================
       ASKED FOR AS "remove the unnecessary vertical gap between the tab navigation buttons and the viewport
       content below it", and the first answer given was the wrong one: #1084's `marginTop` was cited as the
       obstacle. THAT GAP IS ON THE OTHER SIDE OF THE STRIP -- it separates the action bar ABOVE the tabs
       from the tabs, and nothing about this request touches it. The gap actually being described was this
       pane's own top padding, which no note ever argued for.
       IT COULD NOT HAVE BEEN CLOSED BEFORE #1117 and it can be now, which is the connection worth recording.
       Flush against a viewport that was #0f0f0f -- the strip's own fill -- the two would have merged into one
       slab, the failure #1084 names in the sentence "a bordered card and a flat strip read as one welded
       assembly". With the viewport at #141414 there is a value step across that seam, so touching edges read
       as a tab strip ATTACHED to its panel rather than as one shape. Which is what tabs are supposed to say.
       LEFT, RIGHT AND BOTTOM ARE UNCHANGED. The inset is what keeps the panel's border and radius visible;
       only the top edge had a reason to close. */
    padding: "0 20px 20px",
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
    backgroundColor: "#141414",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2a2a2a",
    borderRadius: RADIUS.card,
    /* Design note #426: no `marginBottom`. See above -- a sticky element's
       own margin scrolls with it and offsets it from `top: 0`. The gap is
       now the following content's `marginTop`, which stays put.
       ==================================================================
        DESIGN NOTE 1084: THE INSET CAME WITH IT
       ==================================================================
       THE BAR USED TO SIT INSIDE `canvasPane`, whose `padding: 20px` gave it its margins from the window
       edge. Hoisted to the root it would have gone full-bleed, which reads as a different KIND of element --
       a banner rather than a card -- and would have put its rounded corners flush against the viewport.
       HORIZONTAL ONLY, and #426's rule is unaffected: a VERTICAL margin offsets a sticky element from its
       `top: 0` pin, which is the bug that note records. A horizontal one does nothing of the sort.
       NOT A WRAPPER DIV, which was the first thing I reached for and would have re-created #600's bug
       exactly: a sticky element travels only within its PARENT'S box, so wrapping it in a short container
       pins it to a strip a few pixels tall. The inset has to be the bar's own. */
    marginLeft: "20px",
    marginRight: "20px",
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
    color: "#a8a6a0",
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
  /* Design note #1085: `returnBarNotice` is DELETED with `ReturnToTurnBar`, its only caller. An orphaned
     style for a component that no longer exists is an invitation to rebuild the component. */
  /* Design note #451: names the step Undo would rewind. Muted and small --
     it is a caption on the button beside it, not a control. */
  undoStepLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "#a8a6a0",
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
  /* ==================================================================
      DESIGN NOTE 976: `actionBarPowerChipMark` IS GONE
     ==================================================================
     RULED: "Remove the vertical rainbow gradient strip from the 'Use [Private Company] Power' button."
     THE NOTE ABOVE IS KEPT AS THE RECORD OF TWO REVISIONS, and it should be read knowing its premise did not
     survive. #884 introduced this strip as the chip's identity mark and #931 widened it and gave it a halo
     when it read as too subtle -- but `PRIVATE_POWER_GLOW_STOPS` is a single shared hue circle, so the strip
     was the same on every chip and identified nothing. The acronym in the label identifies the company; the
     star (#943) says it is a private power. The strip was a third, weaker copy of the second of those.
     DELETED RATHER THAN LEFT UNREFERENCED, per the rule this sheet keeps for itself: an orphaned style for a
     rendering we have been asked to stop doing is how the rendering comes back.
     `PRIVATE_POWER_GLOW_STOPS` STILL HAS CONSUMERS -- `HexGridRenderer`'s hex halo and the auction palette --
     so the association #727 built is intact; what left is this surface's copy of it. */
  /* Design note #426: nudged back up. #31 slimmed these on the reasoning that a chrome strip only has to be
     comfortably clickable, which took them below comfortable. These are the primary actions of a turn and
     several are destructive-ish, so they get one step of the type scale back. */
  /* Design note #817: the exit from an armed private power. Amber, not red -- leaving an unspent power costs
     nothing, and a destructive colour here would make the escape hatch look like the dangerous option when
     the dangerous option is the one that spends the power by accident. */
  actionBarCancelErrand: {
    /* Design note #1098 (TD-6): WAS GOLD, FOR A SAFE AND REVERSIBLE ACTION -- its own tooltip says
       "Nothing is used up". Gold gave a back-out button the weight of a decision. Neutral, at 9.98:1
       against the gold's 9.97:1, so nothing is lost but the false emphasis. */
    borderColor: "#3a3a3a",
    color: "#c8c6c0",
    backgroundColor: "#1c1c1c",
  },
  actionBarButton: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    padding: "9px 18px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
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
    /* Design note #1098 (TECH_DEBT TD-6): THE ONE THAT BECOMES PINK. #1094 moved "look here" from gold to
       the brand, and of the seven amber survivors this is the only one that is an OBLIGATION -- the
       corporation must buy a train before the turn can end, and the president pays if it cannot. That is
       the strongest "you must act" the game has, which is precisely what pink now means.
       A LIGHTER PINK THAN `BRAND_PINK_INK`, because this is a PARAGRAPH and not a chip: `#F0A8D4` is
       9.68:1 here, matching the 9.37:1 the gold gave, where the brand ink would have dropped it to 4.9.
       It also lands 18.1 dE from `ALERT_CRITICAL_INK` -- further than the brand pink itself, so the one
       collision #1094 recorded is not made worse by putting pink into the action bar. */
    color: "#F0A8D4",
    backgroundColor: "#241018",
    border: "1px solid #7a2456",
    borderRadius: RADIUS.control,
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
    color: "#c8c6c0",
    borderStyle: "dashed",
  },
  actionBarDivider: {
    width: "1px",
    alignSelf: "stretch",
    backgroundColor: "#2a2a2a",
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
    borderRadius: RADIUS.pill,
    backgroundColor: "#3a3a3a",
    padding: "2px",
    marginRight: "10px",
    verticalAlign: "middle",
    boxSizing: "border-box",
  },
  routeToggleSwitchThumb: {
    width: "12px",
    height: "12px",
    borderRadius: RADIUS.pill,
    backgroundColor: "#c8c6c0",
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
    borderRadius: RADIUS.card,
    backgroundColor: "#0f0f0f",
    border: "1px solid #2a2a2a",
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
  /* ==================================================================
      DESIGN NOTE 974: THE ONE PLACE ON THIS BAR THAT IS NOT ABOUT THE CORPORATION
     ==================================================================
     REPORTED: "it is hard to tell at a glance who owns the active corporation ... use a neutral background
     badge, render the player's name in their specific player color."
     A PLATE HERE AND NOWHERE ELSE ON THE CARD, which is worth defending because #236 painted this whole bar
     one colour precisely so its contents would NOT need individual containers. Every other fact on it is
     about the acting corporation and can take the livery's derived ink. This one is about a PERSON, and it
     is the only fact on the bar whose colour has to come from a different vocabulary -- so it is the only
     one that needs a ground of its own to be legible in.
     `rgba(0, 0, 0, 0.5)` RATHER THAN A NAMED SURFACE. It has to darken eight liveries by the same amount and
     stay the same badge on all of them; a solid hex would be right on the dark corporations and a grey patch
     on the pale ones. A translucent black is one rule that works over every hue -- the same trick #631 uses
     for the seat card's border, and #2165's desaturation argument one step down.
     PADDING AND A RADIUS ARE WHAT MAKE IT A BADGE rather than a tint behind text, and they are small on
     purpose: this sits in a two-row column under the treasury figure (#805), and a badge with real padding
     would push the second row off the full name's line -- the alignment that note exists to hold.
     TYPOGRAPHY UNCHANGED from #671/#805: still `FONT_SIZE.small`, still not tabular, because a name is not a
     quantity and the reasons for that did not move with the plate. */
  orContextPresident: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: FONT_SIZE.small,
    whiteSpace: "nowrap",
    minWidth: 0,
    /* ==================================================================
        DESIGN NOTE 989: SOLID WHITE, NOT A TRANSLUCENT DARKENING
       ==================================================================
       REPORTED: "The OR Action Bar's corporation card president badge has a dark, semi-opaque background
       that looks messy against the app's blue theme. Change the badge's background to a solid `white` so it
       looks intentional and clean."
       AND "MESSY" NAMES THE ACTUAL DEFECT. #974 chose `rgba(0, 0, 0, 0.5)` so one rule could darken eight
       liveries by the same amount -- but a translucent plate does not produce one ground, it produces eight
       muddied ones, each the corporation's own hue seen through smoke. The badge changed colour as the turn
       passed round the table, which is the opposite of the "same badge on every livery" the note claimed.
       SOLID WHITE IS THE ONE GROUND, so a seat colour is read against a known surface instead of against
       whichever livery is acting -- which is what #974's contrast argument was actually asking for and did
       not get.

       CORRECTED (TECH_DEBT TD-4): this note used to continue "every seat colour in `SEAT_COLORS` is a
       mid-to-dark ink ... so all six read on white". THREE OF THEM DO NOT, and never did -- `#4f8a5c` is
       4.10:1, `#3f8a94` is 3.98:1 and `#a88a3f` is 3.30:1, all under AA on this ground. The sentence was
       wrong when it was written, and it was load-bearing: it is the reason this ground is white, and it
       was cited again to justify keeping white through the re-theme. The GROUND is still right for the
       reason above; the claim about the six colours was not. Re-cutting them is TD-4's own job.
       THE CROWN'S GOLD IS THE ONE THING THIS COSTS. `PRESIDENT_CROWN_GOLD` was chosen against dark chrome and
       is lower contrast on white; it stays a legible SHAPE and the name beside it carries the identity, so
       this is a small loss rather than a lost fact -- but it is a real one and worth having written down.

       DESIGN NOTE 1092 SWEPT THIS TO `#f2f0eb` AND IT WAS REVERTED. Recorded so the same tidy-up is not
       attempted a second time: every other paper surface in the app is now Neta's warm paper, so a lone
       pure white beside them reads as a value somebody missed, and that is exactly why the sweep took it.
       But this white is not decoration, it is the CONTRAST GROUND this note chose, and the six seat colours
       are already tight against it -- the worst, `#a88a3f`, is 3.30:1 on white and 2.89:1 on paper. A
       re-theme does not get to spend contrast that was this thin to begin with. It stays white, and stays
       the documented exception to "one paper value".

       AND THE THIN CONTRAST IS OLDER THAN THE RE-THEME. The claim above that "all six read on white" is not
       true of three of them: `#4f8a5c` is 4.10:1, `#3f8a94` is 3.98:1 and `#a88a3f` is 3.30:1, all under AA
       today and before #1092 touched anything. The badge survives it for the reason the paragraph above
       already gives -- the seat colour is a SHAPE here and the name carries the identity -- but the sentence
       overstates its case, and correcting those three is its own pass rather than a colour swap. */
    backgroundColor: "#ffffff",
    borderRadius: RADIUS.control,
    padding: "1px 6px 1px 4px",
    fontWeight: 700,
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
    borderRadius: RADIUS.control,
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
    borderRadius: RADIUS.card,
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
    color: "#c8c6c0",
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
    borderTop: "1px solid #2a2a2a",
    backgroundColor: "#080808",
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
    borderRadius: RADIUS.layer,
    border: "1px solid #2a2a2a",
    backgroundColor: "#0f0f0f",
  },
  sandboxGateTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#f2f0eb" },
  sandboxGateBody: {
    margin: 0,
    fontSize: FONT_SIZE.body,
    lineHeight: 1.55,
    color: "#a8a6a0",
  },
  sandboxGateQuiet: {
    alignSelf: "flex-start",
    fontSize: FONT_SIZE.small,
    padding: "6px 12px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#8a8a86",
    cursor: "pointer",
  },
  /* Design note #601: eight `rosterPill*` styles deleted with the unreachable branch that was their only
     consumer. #406's 8em name ceiling is worth carrying forward -- `SeatOrderTrail` does not clamp its names,
     so a table of long sandbox nicknames widens the trail rather than truncating. If that ever overflows,
     a max-width on the seat name is the fix and this is the note that predicted it. */
  /* Design note #1005: the warning badges, as one unit. `nowrap` here rather than on the rail -- see the
     render site for why the rail must stay free to wrap. `flexShrink: 0` matches the badges' own, so the
     group behaves like the widest badge it holds rather than compressing them against each other. */
  orWarningGroup: {
    display: "inline-flex",
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: "8px",
    flexShrink: 0,
  },
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
    borderRadius: RADIUS.control,
    minWidth: 0,
    flexShrink: 0,
  },
  /* THE DEFAULT IS THE MUTED ONE. Five of the six steps are inactive at any
     moment, so the quiet treatment is the base and emphasis is what gets
     added -- rather than styling five exceptions around one norm. */
  subPhaseStep: {
    padding: "2px 8px",
    marginLeft: "-1px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#141414",
    color: "#6e6c68",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  /* Past steps sit between done and pending: still dim, but not as faint as
     what has not happened, so the trail reads left-to-right as travelled,
     here, remaining. */
  subPhaseStepDone: { color: "#8a8a86", backgroundColor: "#161616" },
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
    borderTop: "1px solid #2a2a2a",
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
    borderLeft: "1px solid #3a3a3a",
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
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    // Design note #494: overridden per chip with that train's route ink.
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
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
  /* ==================================================================
      DESIGN NOTE 1153: THE TWO COLUMNS STOP BEING HALF THE BAR EACH
     ==================================================================
     REPORTED, at length: "the Pay Out side lists the entities on a flush left column and the payout results on
     a flush right column; the Withhold side lists entities and payouts in a single string" -- and then the
     consequence, "the Payout subpanel is split into two columns where the payout results are directly visible
     under the Payout button, but the entities and Market Move are far to the left of it."
     `1fr 1fr` IS WHERE THAT GAP CAME FROM. Each column took half the bar -- which on a wide screen is several
     hundred pixels -- and `dividendRow`'s `space-between` then pushed the holder and the figures to opposite
     ends of it. The panel was not spacious; it was stretched, and the two halves of every fact were as far
     apart as the layout could put them.
     THE REPORT'S OWN CONCLUSION IS WHAT THIS IMPLEMENTS: "the consequence subpanel on Pay Out could also be
     'compressed' ... we might be able to significantly narrow them together, and then use that for the
     Withhold." So both sides become the same compact `label | figures` pair, sized to their contents, and the
     PAIR is centred -- which is what puts each column under the centred button it belongs to, the thing the
     report wanted from the Withhold side and could not see how to get from Pay.
     A RESTATEMENT OF THIS REQUEST GOT THE DIRECTION BACKWARDS -- "compress the Pay Out list ... matching the
     clean, readable column feel of the Withhold side" -- and the report says plainly that the Withhold side is
     a SINGLE STRING with no columns to match. Compressing Pay and then giving that form to Withhold is the
     opposite operation, and it is the one that was asked for. */
  dividendPanel: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: "12px 40px",
    padding: "8px 4px 2px",
    marginTop: "5px",
    borderTop: "1px solid #2a2a2a",
  },
  /* Design note #1153: a two-column grid sized to its CONTENT, so every `label | figures` pair in the column
     shares one edge and the figures stack into a readable column of their own. `max-content` is what keeps it
     compact -- the column is now as wide as its widest row and no wider, which is the "narrow them together"
     the report asked for. */
  dividendColumn: {
    display: "grid",
    gridTemplateColumns: "max-content max-content",
    columnGap: "12px",
    rowGap: "4px",
    alignItems: "baseline",
  },
  /* Design note #998: `dividendRuleFooter`/`dividendRuleLine` are GONE with #997's explanation block. An
     orphaned style for a rendering we have just been asked to stop doing is how the rendering comes back --
     the rule this sheet keeps for itself, and the one #976 applied to the power chip's gradient. */
  /* Design note #1153: `dividendRow` and `dividendHeading` are GONE, not left behind. The row wrapper became
     `display: contents` so its children could join the column's grid, and the headings were deleted as
     redundant with the buttons -- an unused style entry is the half of a deletion that gets forgotten, and
     this table has had that pointed out in it before (`appStyles.ts`, the `PRIVATE_POWER_GLOW_STOPS` import).
     Recorded rather than silently removed so a reader looking for either name finds out where it went. */
  /* The percentage moved OUT of the amount and in beside the name. #705 put a three-part transition on the
     right of this row, and a parenthetical share sitting inside it read as part of the arithmetic; beside the
     holder it is what it always was -- a fact about who this is, not about the money. */
  /* Design note #1153: the label cell. `FONT_SIZE.strong` is the size `dividendHeading` used to have -- the
     report asked for exactly that trade ("the font size/emphasis used on these titles could be applied to the
     entities and payouts"), so the panel gains a step on the facts rather than only losing two lines. */
  dividendHolder: {
    whiteSpace: "nowrap",
    // Design note #706: the treasury row carries a herald before its name, so the row is a flex line rather
    // than bare text -- and the logo sits ON the baseline with the ticker rather than above it.
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    fontSize: FONT_SIZE.strong,
    color: "#e8e6e0",
  },
  dividendAmount: { fontVariantNumeric: "tabular-nums", color: "#7ee0a1", fontWeight: 700 },
  dividendPct: { color: "#6e6c68", fontWeight: 400 },
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
    /* Design note #1153: `marginLeft: auto` is GONE. It pushed the figures to the far end of a half-bar-wide
       column, which is precisely the separation the report describes; in a `max-content` grid the cell sits
       against its label with one gap between them. */
    fontSize: FONT_SIZE.strong,
  },
  /* Muted, like the departure figure it follows: the `+` is grammar, not a value. */
  dividendPlus: { color: "#6e6c68", fontWeight: 400 },
  /* Design note #1153: spans both cells. It is a SENTENCE where every other row is a pair, so without this it
     would be squeezed into the label column and wrap against a figures column that has nothing in it. */
  dividendNote: {
    gridColumn: "1 / -1",
    fontSize: FONT_SIZE.small,
    color: "#a8a6a0",
    lineHeight: 1.4,
  },
  /* Design note #1153: the market move is a label cell and a figures cell now, so its `$current -> $new`
     lands in the same column as every other pair above it -- which is the alignment the report opens with.
     `marginTop` is gone with the split: the grid's `rowGap` spaces it like any other row, and a margin on one
     of two cells in a row would have tilted them against each other. */
  dividendMoveLabel: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#9ec5ff",
    whiteSpace: "nowrap",
  },
  dividendMove: { fontSize: FONT_SIZE.strong, fontWeight: 700, color: "#9ec5ff", cursor: "pointer" },
  /* Design note #1154: the label half of the widened hit area. A separate entry rather than a spread, because
     a label with no chart to open must NOT claim to be pressable -- `MarketMoveLine` picks between the two. */
  dividendMoveLabelOpens: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#9ec5ff",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
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
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
  /* The departure is muted and the destination is not: a withhold always
     RAISES the treasury, so the figure that matters is the one after. */
  treasuryFrom: { color: "#a8a6a0" },
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
  saleMarketLabel: { color: "#8a8a86", fontWeight: 400, marginRight: "2px" },
  saleMarketArrow: { color: "#f87171", fontWeight: 900, fontSize: "1.15em", lineHeight: 1 },
  dividendMoveArrowUp: { color: "#4ade80" },
  dividendMoveArrowDown: { color: "#f87171" },
  /* Design note #489: a move that goes nowhere is neither a gain nor a loss.
     It takes the muted note ink rather than green or red, because those two
     are the only colours on this line carrying a claim about VALUE, and a
     token pinned at the end of its row has not changed any. */
  dividendMoveArrowFlat: { color: "#8a8a86" },
  dividendMoveNote: { color: "#8a8a86", fontWeight: 400 },
  /* ==================================================================
      DESIGN NOTE 1141: THE DOOR ON THE MOVE LINE
     ==================================================================
     A quiet glyph rather than a button-shaped button: this line is a READOUT that has gained an affordance,
     not a control that has gained a label, and giving it a fill would make it compete with the actual
     decision buttons a few pixels away. The hairline and the hover lift are enough to say "pressable" in a
     panel where every real control has a fill -- the same vocabulary the station steppers use (#1134), read
     from the other end.
     BASELINE-ALIGNED, so it sits ON the sentence rather than beside it. */
  marketPeekButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "17px",
    height: "17px",
    marginLeft: "6px",
    verticalAlign: "-3px",
    padding: 0,
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#a8a6a0",
    cursor: "pointer",
    flexShrink: 0,
  },
  depotSupply: { fontSize: FONT_SIZE.small, color: "#a8a6a0" },
  /* Design note #279: the Track step's "the action is on the map" hint, and
     nothing else. This used to carry a second string saying the step had no
     button at all -- a caption about an empty div, which is exactly what
     that note deleted. An empty centre column is now allowed to be empty. */
  orPanelNoActions: { fontSize: FONT_SIZE.small, color: "#6e6c68", fontStyle: "italic" },
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
    color: "#6e6c68",
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
    borderRadius: RADIUS.card,
    border: "1.5px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    color: "#f2f0eb",
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
    color: "#a8a6a0",
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
    borderRadius: RADIUS.card,
    border: "1.5px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
  },
  privateCompanyTrayLabel: {
    fontSize: FONT_SIZE.body,
    color: "#a8a6a0",
    fontWeight: 600,
  },
  privateCompanySelect: {
    padding: "6px 10px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
  },
  privateCompanyPriceRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
  },
  privateCompanyPriceValue: {
    fontSize: FONT_SIZE.body,
    color: "#f2f0eb",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    minWidth: "72px",
  },
  boardPane: {
    /* ==================================================================
        DESIGN NOTE 1144: THE BOARD OPTS OUT OF THE CHROME'S ZOOM
       ==================================================================
       "The one thing that doesn't seem to have grown is the Rail Map, perhaps because it's drawn as its own
       thing" -- and that is exactly right: both canvas renderers already scale themselves against the
       viewport (`HexGridRenderer` #30 caps the board to it), so the chrome's 0.7 would shrink a surface that
       was already the correct size and then be undone by the renderer's own fit pass fighting it.
       `1 / UI_SCALE` RATHER THAN A LITERAL, so the two can never drift: whatever the chrome scales by, this
       divides by, and a future change to `UI_SCALE` moves both ends together. */
    zoom: 1 / UI_SCALE,
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
    borderRadius: RADIUS.card,
    backgroundColor: "#1c1c1c",
    border: "1px solid #3a3a3a",
    color: "#f2f0eb",
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
    /* Design note #1098 (TD-6): WAS AMBER, AND A REFUSAL IS NOT A WARNING. This is the 🚫 that appears when
       a hex cannot take the click; every other refusal in the app is red, and gold made a "no" read as a
       "careful". Red now -- but a SOFTER red than `hexClickIndicatorError` (4.6 dE apart), because the note
       below is right that these two differ: an error is the app failing, this is the BOARD RULE holding. */
    backgroundColor: "#251818",
    borderColor: "#8a4040",
    color: "#f5d8d8",
    lineHeight: LINE_HEIGHT.normal,
  },
};

