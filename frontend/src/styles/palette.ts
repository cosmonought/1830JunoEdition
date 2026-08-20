// Shared surface colours for the "paper card" treatment used by the auction's
// private companies and the Stock Round's public corporations.
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

/** The card surface. One value, used by every private-company and
 *  public-corporation card in the app.
 *
 *  Warm near-white rather than pure `#ffffff`: at full white the cards glare
 *  against this app's very dark chrome and the gold and green accents wash out. */
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
   `WaterfallAuctionDashboard.tsx` design note #320, which replaced the red pulse
   on a contested card with a multicolour border chaser.

   Removed rather than left exported-and-unused: an unimported colour token is a
   standing invitation to reintroduce the exact problem #320 fixed. The chaser's
   palette is deliberately not a token -- a nine-stop gradient that only makes
   sense as a whole, living in the keyframes beside the rule that uses it. */

/** The lowest-offered private: the one card in the waterfall that can be bought
 *  outright, and the only Buy button in the panel.
 *
 *  GREEN, deliberately outside the gold family. Gold marks "look here" and red
 *  marks "contested"; green marks the third thing, AVAILABILITY. Three states,
 *  three hues, no overlap. */
export const CARD_BUY_GREEN = "#10b981";
export const CARD_BUY_GREEN_DARK = "#047857";
export const CARD_BUY_GREEN_TINT = "#d6f5e8";
export const CARD_BUY_GREEN_INK = "#04553c";

/** The active-turn pulse. White/crisp silver rather than red -- see the note
 *  above -- and white also survives being layered over any tab's background.
 *
 *  Exported as BOTH a hex and a bare `r, g, b` triple, because the pulse is an
 *  `@keyframes` block built as a raw CSS string and every stop needs its own
 *  alpha. Without the triple the animation would hardcode `255, 255, 255` and
 *  this constant would be decorative. */
export const TURN_PULSE_INK = "#ffffff";
export const TURN_PULSE_INK_RGB = "255, 255, 255";

/** Neutral accent stripe down the left edge of an ordinary card. */
export const CARD_ACCENT = "#8a7a4a";

// Text on paper. Every one is a dark-on-light value. Light-on-light is the
// obvious mistake when a surface flips and is easy to catch; the subtle one is a
// mid-grey that was fine at 4.5:1 on a dark card and drops to 2:1 on white.
// These are the audited set -- use them rather than inventing a shade.

/** Primary text: company names, headline figures. */
export const CARD_INK = "#1c1a14";
/** Secondary text: labels, captions, descriptions. */
export const CARD_INK_MUTED = "#4a463c";
/** Tertiary text: unit captions under figures, hints. */
export const CARD_INK_FAINT = "#6b6350";
/** Rule between regions inside a card. */
export const CARD_DIVIDER = "#d5cfbc";

// Status chips on dark chrome.
//
// WHY "UNFLOATED" IS SLATE AND NOT AMBER: the Ledger renders the roster's
// UNFLOATED badge and the depot's CURRENT badge within a few hundred pixels of
// each other, and two golds that close read as one style applied inconsistently.
// Amber here means "look here"; UNFLOATED is the opposite claim, so slate frees
// amber to mean one thing again.
//
// THE SHAPE DIFFERS TOO -- squared and monospaced where every neighbour is a
// 999px pill -- because a distinction that survives desaturation is stronger,
// and it keeps working for a viewer who cannot use the amber/slate difference.

/** UNFLOATED and other genuinely-inert status chips on dark chrome.
 *  Slate-800 at 80%, matching the muted register of `CARD_SURFACE_MUTED`
 *  on the paper side. */
export const CHIP_INERT_BG = "rgba(30, 41, 59, 0.8)";
export const CHIP_INERT_BORDER = "#334155";
export const CHIP_INERT_INK = "#94a3b8";

// Escalation: the two-step countdown to a phase shift.
//
// `gamePhase.ts` design note #5 establishes that the phase shift and the rust
// are THE SAME PURCHASE, counted by one number. These are its presentation half:
// two purchases out is orange, one is crimson. Both readouts read the same
// countdown and the same two constants, so they cannot disagree about urgency.
//
// Orange rather than yellow, because yellow/amber is already spent on "look
// here" and on the Yellow ERA -- a yellow rust warning would be invisible.

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
