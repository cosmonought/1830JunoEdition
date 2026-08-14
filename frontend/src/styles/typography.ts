// frontend/src/styles/typography.ts
//
// One tunable type + control scale for the DOM chrome (Lobby, ChatBox,
// TopTicker, InlineQuickChat, the dashboard room strip).
//
// ===================================================================
//  WHY A MODULE INSTEAD OF EDITING THE NUMBERS IN PLACE
// ===================================================================
//
// The legibility pass that produced this file had to change roughly sixty
// `fontSize` literals scattered across five components. Doing that by hand
// is a one-time fix for a recurring question -- the next time someone says
// "still a bit small" or "too big on a laptop", the same sixty-site sweep
// runs again, and the sizes drift apart a little more each pass because no
// two sweeps hit exactly the same set.
//
// So the sizes live here, once. Tuning the whole app is now editing this
// file. The scale is deliberately SMALL (seven steps): a scale with a step
// for every size anyone ever wanted is just the scattered literals again
// with extra indirection.
//
// ===================================================================
//  WHY NOT A ROOT font-size AND `rem`
// ===================================================================
//
// The obvious alternative -- set `html { font-size: 18px }` and convert
// everything to `rem` -- does not work here, and it is worth writing down
// so nobody tries it and quietly gets nothing:
//
//   - Every style in this codebase is an inline `React.CSSProperties`
//     object with explicit `px`. A root font-size does not touch a `px`
//     value, so the change would have had literally no visible effect
//     without converting all sixty literals anyway.
//   - Form controls (`<input>`, `<select>`, `<button>`) do not inherit
//     font-size from an ancestor by default -- browsers apply their own UA
//     stylesheet default. Any approach that relies on inheritance silently
//     misses exactly the controls this pass most needed to fix.
//
// The canvas renderers (`HexGridRenderer`, `StockMarketRenderer`) are
// deliberately OUT of scope: both already have their own dynamic,
// zoom-aware font scaling (see each file's own design notes), and a fixed
// scale imposed from outside would fight those systems rather than help.
//
// ===================================================================
//  THE SCALE
// ===================================================================
//
// Two passes have run over these numbers. The first was roughly 1.25x over
// the original hand-written sizes (10-11px badges, 12px metadata, 13px
// body), which had been chosen for information density and were correctly
// reported as hard to read. The second added a further +2px to every step
// after the first pass still read small on a normal monitor.
//
// Net effect versus the original: body 13 -> 18px, controls 14 -> 19px,
// pills 10-11 -> 15px. Body text now sits comfortably above the ~16px
// browsers default to, and nothing in the DOM chrome is below 15px.
//
// EVERY step moves together, on purpose. Bumping only the sizes that
// someone complained about is what produces a scale where the "small" and
// "body" steps are one pixel apart and no longer mean anything.

/** Font sizes. The comment on each records what it replaced, so a future
 *  reader can tell whether a given call site is on the scale or was missed. */
export const FONT_SIZE = {
  /** Tiny status pills and inline tags. Originally 10-11px. */
  micro: "15px",
  /** Secondary metadata, timestamps, helper text. Originally 12px. */
  small: "17px",
  /** Default body text and list rows. Originally 13px. */
  body: "18px",
  /** Buttons, inputs, selects -- anything the user clicks or types into.
   *  Originally 14px. Deliberately a step ABOVE `body`: an under-sized
   *  control is both harder to read and harder to hit than under-sized
   *  prose. */
  control: "19px",
  /** Emphasised rows, seat names, ticker preview. Originally 15px. */
  strong: "20px",
  /** Panel and section headings. Originally 17px. */
  heading: "23px",
  /** The one brand title. Originally 26px. */
  display: "34px",
} as const;

/** Padding for interactive controls, scaled to match `FONT_SIZE.control`.
 *  Bumping text without bumping the box it sits in produces cramped
 *  controls that read as a bug rather than as a larger font. */
export const CONTROL_PADDING = {
  /** Buttons. */
  button: "11px 20px",
  /** Small/secondary buttons and pills. */
  buttonSmall: "7px 14px",
  /** Text inputs and selects. */
  input: "11px 14px",
} as const;

/** Line height for multi-line prose. Bare numbers, not `px`, so they scale
 *  with whichever `FONT_SIZE` step the element uses. */
export const LINE_HEIGHT = {
  tight: 1.35,
  normal: 1.55,
} as const;

/** The app's one font stack. Was duplicated as a literal in five files. */
export const FONT_FAMILY = "system-ui, -apple-system, Segoe UI, sans-serif";

/** Monospace, for addresses and ids where character alignment aids
 *  comparison. */
export const FONT_FAMILY_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
