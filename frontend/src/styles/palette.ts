// frontend/src/styles/palette.ts
//
// Shared surface colours for the "paper card" treatment used by the
// auction's private companies and the Stock Round's public corporations.
//
// ===================================================================
//  WHY THESE ARE SHARED CONSTANTS AND NOT TWO MATCHING HEX CODES
// ===================================================================
//
// The two card sets were restyled light in separate passes and drifted
// immediately: the privates ended up on `#f4f1e8` with a `#fdf6e0` variant
// for the lowest offer and a `#fdeee8` variant for a live mini-auction,
// while the corporations landed on `#f5f4ef` with a `#eef3fb` selected
// tint. Five near-white values, no two the same, across two components
// that sit one tab apart -- which reads exactly as it sounds: slightly
// grubby, as though some cards were dirtier than others.
//
// The fix is not "pick a better hex twice". It is to have ONE value that
// both files import, so a future pass physically cannot restyle one set
// without the other. Uniformity is now structural rather than a
// coincidence that survives until the next edit.
//
// ===================================================================
//  THE ONE RULE FOR VARIANTS
// ===================================================================
//
// Card STATE is expressed through borders, accents and badges -- never
// through the card's background. That constraint is what keeps the set
// looking like one deck of certificates instead of a colour-coded chart,
// and it is why the lowest-offer and mini-auction cards below share a fill
// with every other card and differ only at their edges.
//
// The single deliberate exception is `CARD_SURFACE_MUTED`, for a card that
// is genuinely inert (an unfloated corporation with nothing to act on). A
// slightly cooler, dimmer paper reads as "not in play" without introducing
// a hue.

/** The card surface. One value, used by every private-company and
 *  public-corporation card in the app.
 *
 *  Warm near-white rather than pure `#ffffff`: at full white the cards
 *  glare against this app's very dark chrome, and the gold and green
 *  accents both look washed out on them. A few points of warmth keeps the
 *  contrast step just as large while letting the accent colours read. */
export const CARD_SURFACE = "#f7f5f0";

/** An inert card -- e.g. an unfloated corporation. Same paper, dimmer. */
export const CARD_SURFACE_MUTED = "#e8e6e0";

/** Hairline border for a card in its ordinary state. */
export const CARD_BORDER = "#c9c3b4";

/** Border + accent for the card the player should look at first: the
 *  lowest-offered private, or the selected corporation. */
export const CARD_BORDER_ACTIVE = "#c9a94c";
export const CARD_ACCENT_ACTIVE = "#d4a017";

/** Border + accent for a card under live contest (a running mini-auction).
 *  The strongest signal available, because a mini-auction pauses the entire
 *  waterfall for every player. */
export const CARD_BORDER_CONTESTED = "#c05a3a";

/* `CARD_GLOW_MINI_AUCTION` (a red `#ef4444`) was DELETED by
   `WaterfallAuctionDashboard.tsx` design note #320, which replaced the red
   pulse on a contested card with a multicolour border chaser.
 
   Removed rather than left exported-and-unused. A colour token that nothing
   imports is a standing invitation to reintroduce the exact problem #320
   fixed -- red on that screen means "something is wrong", and a mini-auction
   is the most interesting thing that can happen in the auction. The chaser's
   palette is deliberately not a token: it is a nine-stop gradient that only
   makes sense as a whole, and it lives in the keyframes beside the rule that
   uses it. */

/** The lowest-offered private: the one card in the waterfall that can be
 *  bought outright, and the only Buy button in the panel.
 *
 *  GREEN, deliberately outside the card palette's gold family. Gold marks
 *  "look here" (`CARD_BORDER_ACTIVE`) and red now marks "contested"; green
 *  marks the third thing, which is neither attention nor danger but
 *  AVAILABILITY -- this is the action you can actually take right now. Three
 *  states, three hues, no overlap. */
export const CARD_BUY_GREEN = "#10b981";
export const CARD_BUY_GREEN_DARK = "#047857";
export const CARD_BUY_GREEN_TINT = "#d6f5e8";
export const CARD_BUY_GREEN_INK = "#04553c";

/** The active-turn pulse. White/crisp silver rather than red: see
 *  the note above for the red pulse this once collided with. White also
 *  survives being layered over any tab's background, which red did not do
 *  evenly across the linen-white card surfaces.
 *
 *  Exported as BOTH a hex and a bare `r, g, b` triple because the pulse is
 *  an `@keyframes` block built as a raw CSS string (inline styles cannot
 *  express keyframes), and every stop in it needs its own alpha. Without
 *  the triple the animation would have to hardcode `255, 255, 255` and this
 *  constant would be decorative -- a colour "constant" that the actual
 *  colour does not come from is worse than no constant. */
export const TURN_PULSE_INK = "#ffffff";
export const TURN_PULSE_INK_RGB = "255, 255, 255";

/** Neutral accent stripe down the left edge of an ordinary card. */
export const CARD_ACCENT = "#8a7a4a";

/* ------------------------------------------------------------------ */
/* Text on paper                                                       */
/* ------------------------------------------------------------------ */
//
// Every one of these is a dark-on-light value. Light-on-light is the
// obvious mistake when a surface flips, and it is easy to catch; the
// subtle one is a mid-grey that was fine at 4.5:1 on a dark card and drops
// to 2:1 on white. These are the audited set -- use them rather than
// inventing a shade at the call site.

/** Primary text: company names, headline figures. */
export const CARD_INK = "#1c1a14";
/** Secondary text: labels, captions, descriptions. */
export const CARD_INK_MUTED = "#4a463c";
/** Tertiary text: unit captions under figures, hints. */
export const CARD_INK_FAINT = "#6b6350";
/** Rule between regions inside a card. */
export const CARD_DIVIDER = "#d5cfbc";

/* ------------------------------------------------------------------ */
/* Status chips on dark chrome                                         */
/* ------------------------------------------------------------------ */
//
// ===================================================================
//  WHY "UNFLOATED" IS SLATE AND NOT AMBER
// ===================================================================
//
// The Game Ledger renders two amber pills within a few hundred pixels of
// each other: the corporation roster's UNFLOATED badge (`#3a2f14` on
// `#6a5a24`) and the Bank Depot's CURRENT badge (`rgba(201,169,76,0.18)` on
// `#c9a94c`). Two golds that close together do not read as two states --
// they read as one style applied inconsistently, and the eye tries to
// relate them. They are not related at all: one marks a corporation that
// has not floated, the other marks which train tier the phase is on.
//
// Amber in this app means "look here" (`CARD_BORDER_ACTIVE`,
// `CARD_HIGHLIGHT_BG`, the depot's CURRENT). UNFLOATED is the opposite
// claim -- a corporation with nothing to act on, which is precisely the
// case `CARD_SURFACE_MUTED` exists for on the light side. Slate says
// "inert" without spending the attention colour, which frees amber to mean
// one thing again.
//
// THE SHAPE DIFFERS TOO, and deliberately. The chip is squared (4px) and
// monospaced where every neighbouring badge is a 999px pill in the body
// face. Colour alone would still leave two same-shaped tags side by side,
// and a distinction that survives being desaturated is a stronger one --
// it also keeps working for a red-green colourblind viewer, who cannot use
// the amber/slate difference at all.

/** UNFLOATED and other genuinely-inert status chips on dark chrome.
 *  Slate-800 at 80%, matching the muted register of `CARD_SURFACE_MUTED`
 *  on the paper side. */
export const CHIP_INERT_BG = "rgba(30, 41, 59, 0.8)";
export const CHIP_INERT_BORDER = "#334155";
export const CHIP_INERT_INK = "#94a3b8";

/* ------------------------------------------------------------------ */
/* Escalation: the two-step countdown to a phase shift                 */
/* ------------------------------------------------------------------ */
//
// `gamePhase.ts` design note #5 establishes that the phase shift and the
// rust are THE SAME PURCHASE, counted by one number
// (`purchasesUntilPhaseChange` === `purchasesUntilRust`). These colours are
// the presentation half of that: two purchases out is orange, one purchase
// out is crimson. Because both readouts read the same countdown AND the
// same two constants, they cannot drift into disagreeing about urgency any
// more than they can disagree about the count.
//
// Orange rather than yellow for the two-away step, specifically because
// yellow/amber is already spent on "look here" and on the Yellow ERA --
// a yellow rust warning during the Yellow era would be invisible.

/** Two purchases from the phase shift: act soon. */
export const ALERT_WARN_INK = "#fb923c";
export const ALERT_WARN_BG = "rgba(249, 115, 22, 0.1)";
export const ALERT_WARN_BORDER = "rgba(249, 115, 22, 0.3)";

/** One purchase from the phase shift: the next depot buy does it. */
export const ALERT_CRITICAL_INK = "#fb7185";
export const ALERT_CRITICAL_BG = "rgba(244, 63, 94, 0.2)";
export const ALERT_CRITICAL_BORDER = "rgba(244, 63, 94, 0.5)";

/** Positive figures on paper (revenue, gains). */
export const CARD_INK_POSITIVE = "#1d6b3f";
/** The president/owner highlight -- dark on gold, never gold on dark. */
export const CARD_HIGHLIGHT_BG = "#f7e3a8";
export const CARD_HIGHLIGHT_INK = "#5c4204";
export const CARD_HIGHLIGHT_BORDER = "#c9a94c";
