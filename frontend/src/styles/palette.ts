// The app's colour tokens: the dark chrome the shell is built on, and the
// "paper card" treatment used by the auction's private companies and the Stock
// Round's public corporations.
//
// The two card sets were restyled light in separate passes and drifted
// immediately -- five near-white values, no two the same, one tab apart. The fix
// is not "pick a better hex twice": ONE value both files import, so a future
// pass physically cannot restyle one set without the other.
//
// THE ONE RULE FOR VARIANTS: card STATE lives in borders, accents and badges,
// never in the card's background. The single deliberate exception is
// `CARD_SURFACE_MUTED`, for a genuinely inert card.
//
// See docs/ai_architecture/ui_shell_layout.md, palette.ts.

/* ==================================================================
    DESIGN NOTE 1092: THE NETA DAO RE-THEME, AND WHY IT IS ONLY COLOUR
   ==================================================================

   REQUESTED: re-skin the app in Neta DAO's identity. SCOPED, deliberately, to colour VALUES -- no
   typography, no spacing, no layout. Every edit this note covers replaces one hex with another on a
   colour-valued property; the `1px solid` half of a border shorthand is untouched, and so is every
   `fontSize`, `padding`, `gap` and grid track in the codebase.

   WHY THE FENCE IS DRAWN THERE. This app sizes everything in explicit `px` inside inline
   `React.CSSProperties` objects, and `typography.ts` carries hardcoded `CAP_HEIGHT_RATIO` and
   `X_HEIGHT_RATIO` approximations of the SYSTEM font's proportions. Eight separate harnesses exist
   because text-versus-box has already broken here -- `ownershipColumnFit` was written after a column
   came out 22px too narrow and pushed Price off the card. A family swap would have moved every one of
   those tuned relationships at once, with nothing failing loudly. Colour moves none of them.
   `FONT_FAMILY` therefore stays exactly where it is; the brand is carried by ground, paper and accent.

   THE SOURCE IS NETA'S OWN STYLESHEET, not an eyeballing of the logo: `--ink #080808`,
   `--ink-panel #0f0f0f`, `--ink-mid #161616`, `--rule-thin #2a2a2a`, `--paper #f2f0eb`,
   `--paper-dim #c8c6c0`, `--pink #C9338A`, `--blue #5B8EF0`. Everything below is derived from those
   eight and nothing else.

   THE CHROME WAS SLATE-BLUE AND IS NOW NEUTRAL. That is the half of the change a player actually sees.
   The old ladder had a cool cast in every step, which fought the C&O's cyan and the B&O's navy wherever
   chrome met the map; Neta's ink is chromatically flat, so the livery is the only hue on screen. That
   is an argument for the swap independent of branding, and it is why the ladder is now EIGHT NAMED
   TOKENS rather than the 212 near-identical literals it had drifted into. */

/* ------------------------------------------------------------------ */
/* The ink ladder. Dark chrome grounds, darkest first.                  */
/* ------------------------------------------------------------------ */

/** The page ground, and the deepest well. Also the gutter colour wherever
 *  panels are butted against each other. */
export const INK = "#080808";
/** The default panel fill: top bar, status dock, recessed panels. */
export const INK_PANEL = "#0f0f0f";
/** Chip and badge fills -- the phase badge, the turn-order tickers. */
export const INK_CHIP = "#141414";
/** Panel bodies. */
export const INK_MID = "#161616";
/** Raised surfaces and hover states. */
export const INK_RAISED = "#1c1c1c";

/** The hairline. Rules between rows, chip borders.
 *
 *  READS SLIGHTLY STRONGER THAN THE SLATE IT REPLACES, which is worth stating
 *  because a neutralised border is the kind of thing that gets "fixed" back:
 *  `#2a2a2a` on `#0f0f0f` is 1.34:1, against the old `#2a2e3a` on `#1a1d26`
 *  at 1.24:1. Nothing got fainter. */
export const RULE = "#2a2a2a";
/** Emphasised borders and input edges. */
export const RULE_STRONG = "#3a3a3a";
/** The edge of a disabled control. */
export const EDGE_DISABLED = "#4a4a4a";

/* ------------------------------------------------------------------ */
/* Text on ink. Five steps, each verified on the ground it sits on.     */
/* ------------------------------------------------------------------ */

// NETA SHIPS A `#555555` TERTIARY INK AND THIS LADDER DOES NOT ADOPT IT. On
// `#080808` that value is 2.69:1 -- below AA for text and below the 3:1 bar for
// anything at all. It works on their site because the strings wearing it are
// decorative; the equivalent slots HERE hold a room code and a wallet address,
// which people read character by character. The ladder bottoms out at
// `INK_TEXT_DIMMEST` instead.

/** Primary: headings, figures, active labels. 16.83:1 on `INK_PANEL`. */
export const INK_TEXT = "#f2f0eb";
/** Secondary: body copy and row text. 11.22:1. */
export const INK_TEXT_DIM = "#c8c6c0";
/** Muted: captions, metadata, hints. 7.87:1. */
export const INK_TEXT_MUTED = "#a8a6a0";
/** Faint: disabled labels, not-yet-reached steps. 5.53:1. */
export const INK_TEXT_FAINT = "#8a8a86";
/** Dimmest: the label on an inert ticker, against `INK_CHIP`.
 *
 *  3.52:1, down from the slate's 3.94:1 -- the one contrast this re-theme
 *  spends, recorded rather than buried. It clears the 3:1 non-text bar, and it
 *  is the colour of a corporation that has ALREADY OPERATED, which is a
 *  deliberately recessive thing to be. `#7a7874` restores 4.1:1 if a future
 *  pass decides the trade was wrong. */
export const INK_TEXT_DIMMEST = "#6e6c68";

/* ------------------------------------------------------------------ */
/* The brand accent.                                                    */
/* ------------------------------------------------------------------ */

/* ==================================================================
    DESIGN NOTE 1093: PINK IS A BORDER, NOT A SENTENCE
   ==================================================================
   `BRAND_PINK` reaches 3.73:1 on `INK_MID`. That is fine for the 3:1 non-text bar -- borders, fills,
   accent bars, an icon -- and SHORT OF the 4.5:1 a run of text needs. The two values below are that
   fact made unavoidable at the call site: reach for `BRAND_PINK` when the pink is a SHAPE, and
   `BRAND_PINK_INK` when it is a STRING. They are 8.9 dE apart, which is the same colour to a reader
   and a legal one to a contrast checker.

   BLUE NEVER TOUCHES PAPER, and this one has no lifted sibling on purpose. `BRAND_BLUE` is 6.00:1 on
   ink and 2.81:1 on `CARD_SURFACE` -- unreadable. Darkening it until it passes on paper lands it at
   dE 10 from the B&O's navy, which is a livery collision on the one surface where corporations are
   listed by name. There is no version of Neta blue that is both legible on paper and safely distinct
   from the B&O, so blue is chrome-only: links, informational chips, the gradient. */

/** The brand accent as a SHAPE: borders, fills, accent bars. Not text. */
export const BRAND_PINK = "#C9338A";
/** The brand accent as TEXT on ink. 5.11:1 on `INK_MID`. */
export const BRAND_PINK_INK = "#E052A6";
/** Informational blue -- links and info chips. ON INK ONLY; see note #1093. */
export const BRAND_BLUE = "#5B8EF0";
/** The one brand gesture, for a surface that wants the whole axis rather than
 *  one end of it. */
export const BRAND_GRADIENT = "linear-gradient(90deg, #C9338A 0%, #5B8EF0 100%)";

/* ------------------------------------------------------------------ */
/* The paper card.                                                      */
/* ------------------------------------------------------------------ */

/** The card surface. One value, used by every private-company and
 *  public-corporation card in the app.
 *
 *  Warm near-white rather than pure `#ffffff`: at full white the cards glare
 *  against this app's very dark chrome and the accents wash out. It is now
 *  Neta's `--paper` exactly, so the app has ONE paper value and it is the
 *  brand's. */
export const CARD_SURFACE = "#f2f0eb";

/** An inert card -- e.g. an unfloated corporation. Same paper, dimmer. */
export const CARD_SURFACE_MUTED = "#dedcd6";

/** Hairline border for a card in its ordinary state. */
export const CARD_BORDER = "#c8c6c0";

/* ==================================================================
    DESIGN NOTE 1094: "LOOK HERE" WAS GOLD AND IS NOW PINK
   ==================================================================
   THIS IS THE WHOLE RE-BRAND, IN TWO CONSTANTS. Gold marked the card a player should look at first;
   Neta's look-here is pink; the substitution is one-for-one.

   AND IT SETTLES AN ARGUMENT THIS FILE WAS ALREADY HAVING WITH ITSELF. The escalation note below used
   to read "Orange rather than yellow, because yellow/amber is already spent on 'look here' and on the
   Yellow ERA -- a yellow rust warning would be invisible." That reasoning INVERTS the moment look-here
   stops being gold: the entire yellow band goes back to the ERA and the Erie, and the rust warning is
   orange because orange is the right colour for it rather than because yellow was taken. The note is
   rewritten below rather than left standing, because a stale justification is how a future pass
   re-litigates a question that has already been answered.

   THE COLLISION THAT SURVIVES, stated so nobody has to rediscover it: `ALERT_CRITICAL_INK` is 21.0 dE
   from `BRAND_PINK` and 16.3 from `BRAND_PINK_INK`. Both clear this codebase's stated floor of 8.4 and
   both are far short of the livery's 44. A contested private bordered in pink CAN now appear beside a
   train chip counting down in rose. It was reviewed and ACCEPTED: the two never share a component, and
   shape already separates them -- alerts are pills, the active border is a 1px edge. If it ever does
   read as one colour, `#f05b5b` (Neta's own red, 23.4 dE) is the change to make, and pushing critical
   orange-ward is NOT -- it narrows the gap to `ALERT_WARN_INK`, and those two DO share a component. */

/** Border + accent for the card the player should look at first: the
 *  lowest-offered private, or the selected corporation. */
export const CARD_BORDER_ACTIVE = "#C9338A";
export const CARD_ACCENT_ACTIVE = "#C9338A";

/** Border + accent for a card under live contest (a running mini-auction).
 *  The strongest signal available, because a mini-auction pauses the entire
 *  waterfall for every player. */
export const CARD_BORDER_CONTESTED = "#c05a3a";

/* `CARD_GLOW_MINI_AUCTION` (a red `#ef4444`) was DELETED by
   `WaterfallAuctionDashboard.tsx` design note #320, which replaced the red pulse
   on a contested card with a multicolour border chaser.

   Removed rather than left exported-and-unused: an unimported colour token is a
   standing invitation to reintroduce the exact problem #320 fixed. The chaser's
   palette is deliberately not a token -- a nine-stop gradient that only makes
   sense as a whole, living in the keyframes beside the rule that uses it.

   Design note #1092 leaves the chaser alone and does NOT hand it
   `BRAND_GRADIENT`: whether the house gradient should replace a nine-stop
   chaser is a question about that animation, not about this palette. */

/** The lowest-offered private: the one card in the waterfall that can be bought
 *  outright, and the only Buy button in the panel.
 *
 *  GREEN, deliberately outside the brand family. Pink marks "look here" and red
 *  marks "contested"; green marks the third thing, AVAILABILITY. Three states,
 *  three hues, no overlap -- and at 81.0 dE from `BRAND_PINK` this one has the
 *  widest margin of the three. */
export const CARD_BUY_GREEN = "#10b981";
export const CARD_BUY_GREEN_DARK = "#047857";
export const CARD_BUY_GREEN_TINT = "#d6f5e8";
export const CARD_BUY_GREEN_INK = "#04553c";

/** The active-turn pulse. Paper rather than pure white -- so the pulse belongs
 *  to the palette rather than sitting outside it -- and light enough to survive
 *  being layered over any tab's background.
 *
 *  Exported as BOTH a hex and a bare `r, g, b` triple, because the pulse is an
 *  `@keyframes` block built as a raw CSS string and every stop needs its own
 *  alpha. THE TWO MOVE TOGETHER OR NOT AT ALL: without the triple the animation
 *  would silently keep pulsing the old colour and this constant would be
 *  decorative. */
export const TURN_PULSE_INK = "#f2f0eb";
export const TURN_PULSE_INK_RGB = "242, 240, 235";

/** Neutral accent stripe down the left edge of an ordinary card.
 *
 *  Now genuinely neutral. It was `#8a7a4a`, a desaturated gold, which read as a
 *  weak version of the ACTIVE accent rather than as the absence of one -- a
 *  distinction the card set depends on. */
export const CARD_ACCENT = "#b8b6b0";

// Text on paper. Every one is a dark-on-light value. Light-on-light is the
// obvious mistake when a surface flips and is easy to catch; the subtle one is a
// mid-grey that was fine at 4.5:1 on a dark card and drops to 2:1 on white.
// These are the audited set -- use them rather than inventing a shade.
//
// Design note #1092 neutralised all four. They were warm (`#1c1a14`, `#4a463c`,
// `#6b6350`), which was correct beside a gold accent and is not beside a pink
// one; these are Neta's own ink and its two greys. Every ratio below is against
// `CARD_SURFACE`, and every one went UP.

/** Primary text: company names, headline figures. 17.59:1. */
export const CARD_INK = "#080808";
/** Secondary text: labels, captions, descriptions. 11.09:1. */
export const CARD_INK_MUTED = "#333333";
/** Tertiary text: unit captions under figures, hints. 6.55:1. */
export const CARD_INK_FAINT = "#555555";
/** Rule between regions inside a card. */
export const CARD_DIVIDER = "#d8d6d0";

// Status chips on dark chrome.
//
// WHY "UNFLOATED" IS SLATE AND NOT AMBER: the Ledger renders the roster's
// UNFLOATED badge and the depot's CURRENT badge within a few hundred pixels of
// each other, and two golds that close read as one style applied inconsistently.
//
// DESIGN NOTE 1092 RETIRES THE COLOUR HALF OF THAT ARGUMENT AND KEEPS THE SHAPE
// HALF, which is the half that was doing the work. There is no amber left in the
// chrome for slate to be distinguished FROM, so the chip is now simply the
// neutral ladder. What still matters -- and what the original note was right
// about -- is that it is SQUARED AND MONOSPACED where every neighbour is a 999px
// pill: a distinction that survives desaturation is stronger, and it keeps
// working for a viewer who cannot use hue at all.

/** UNFLOATED and other genuinely-inert status chips on dark chrome.
 *
 *  The alpha lifts from 0.80 to 0.85 to compensate for the fill sitting darker
 *  than the slate it replaces; the chip reads at the same weight against the
 *  panel behind it. Alpha is part of the colour, so this stays inside #1092's
 *  colour-only fence. */
export const CHIP_INERT_BG = "rgba(26, 26, 26, 0.85)";
export const CHIP_INERT_BORDER = "#2a2a2a";
/** 5.02:1 on the fill above, down from 6.79:1. Comfortably past AA; flagged
 *  because a threshold pinned above 6 in a future harness would trip on it. */
export const CHIP_INERT_INK = "#8a8a86";

// Escalation: the two-step countdown to a phase shift.
//
// `gamePhase.ts` design note #5 establishes that the phase shift and the rust
// are THE SAME PURCHASE, counted by one number. These are its presentation half:
// two purchases out is orange, one is crimson. Both readouts read the same
// countdown and the same two constants, so they cannot disagree about urgency.
//
// ORANGE BECAUSE ORANGE IS RIGHT, which is design note #1094's correction to
// this paragraph. It used to say orange was chosen because yellow was "already
// spent on 'look here'"; look-here is pink now, the yellow band is free, and the
// escalation stays orange-then-crimson on its own merits -- a warm ramp toward
// red is what a countdown to a loss should look like.

/** Two purchases from the phase shift: act soon. */
export const ALERT_WARN_INK = "#fb923c";
export const ALERT_WARN_BG = "rgba(249, 115, 22, 0.1)";
export const ALERT_WARN_BORDER = "rgba(249, 115, 22, 0.3)";

/** One purchase from the phase shift: the next depot buy does it.
 *  See design note #1094 for its measured distance from `BRAND_PINK`. */
export const ALERT_CRITICAL_INK = "#fb7185";
export const ALERT_CRITICAL_BG = "rgba(244, 63, 94, 0.2)";
export const ALERT_CRITICAL_BORDER = "rgba(244, 63, 94, 0.5)";

/** Positive figures on paper (revenue, gains). Unchanged: it is a rules
 *  colour, and 5.71:1 on the new paper. */
export const CARD_INK_POSITIVE = "#1d6b3f";

/** The president/owner highlight -- dark on pink, never pink on dark.
 *
 *  The construction is the one thing that mattered here and it is untouched;
 *  only the hue moved, gold to brand. It comes out BETTER: 8.96:1 against the
 *  gold pairing's 7.38:1. */
export const CARD_HIGHLIGHT_BG = "#f7dcea";
export const CARD_HIGHLIGHT_INK = "#6d1247";
export const CARD_HIGHLIGHT_BORDER = "#C9338A";
