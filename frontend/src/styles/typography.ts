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
// ===================================================================
//  DESIGN NOTE 3: THE THIRD PASS, AND WHY IT GOES THE OTHER WAY
// ===================================================================
//
// REPORTED: the interface has to be viewed at 50% browser zoom to look
// proportionate on a 1080p screen or a 13" laptop.
//
// Two passes had run before this one, both upward. The note below records
// them: roughly 1.25x over the original hand-written sizes, then a further
// +2px on every step. Net, body went 13 -> 18px, controls 14 -> 19px,
// badges 10-11 -> 15px, the brand title 26 -> 34px. Compounded, that is
// about 1.4x -- and a UI drawn 1.4x too large is one a player fixes with
// the zoom control, which is exactly what happened.
//
// THE PREVIOUS FEEDBACK WAS PROBABLY MEASURING THE SAME PROBLEM FROM THE
// OTHER SIDE, and it is worth saying so rather than treating this as a
// simple reversal. "Hard to read" and "needs 50% zoom" are not opposite
// complaints if the reader was already zoomed out to fit the board on
// screen: shrinking the page to see the map makes the text small, the fix
// applied was to grow the text, and growing the text made the page need
// more shrinking. Each pass made the next one necessary.
//
// So this pass sets the type scale to desktop-dense targets AND caps the
// board to the viewport (`HexGridRenderer` design note #30), which is the
// half that was missing. Text at a normal size only stays readable if the
// page is not being zoomed out to accommodate something else.
//
// WHERE THE NUMBERS COME FROM: 13px body and 14px controls are the density
// desktop tools converge on; 11-12px for badges and metadata; 16px for
// section headings. Every step moves together, for the reason the note
// below already gives -- bumping only the sizes someone complained about
// is what produces a scale whose steps no longer mean anything.

/** Font sizes. The comment on each records what it replaced, so a future
 *  reader can tell whether a given call site is on the scale or was missed. */
export const FONT_SIZE = {
  /** Tiny status pills and inline tags. 10-11 -> 15 -> 11px. */
  micro: "11px",
  /** Secondary metadata, timestamps, helper text. 12 -> 17 -> 12px. */
  small: "12px",
  /** Default body text and list rows. 13 -> 18 -> 13px. */
  body: "13px",
  /** Buttons, inputs, selects -- anything the user clicks or types into.
   *  14 -> 19 -> 14px. Deliberately a step ABOVE `body`: an under-sized
   *  control is both harder to read and harder to hit than under-sized
   *  prose. */
  control: "14px",
  /** Emphasised rows, seat names, ticker preview. 15 -> 20 -> 15px. */
  strong: "15px",
  /** Panel and section headings. 17 -> 23 -> 16px. */
  heading: "16px",
  /** The one brand title. 26 -> 34 -> 22px. */
  display: "22px",
} as const;

/** Padding for interactive controls, scaled to match `FONT_SIZE.control`.
 *
 *  These move WITH the font, always. The inverse of the note above: text
 *  shrunk without shrinking the box around it leaves controls that are
 *  small AND still tall, which is the worst of both -- the density never
 *  arrives and the type just looks lost. A 14px label in 7px vertical
 *  padding is a ~30px control, which is what puts an action strip inside
 *  the 44-52px band the layout targets. */
export const CONTROL_PADDING = {
  /** Buttons. 11px 20px -> */
  button: "7px 14px",
  /** Small/secondary buttons and pills. 7px 14px -> */
  buttonSmall: "4px 10px",
  /** Text inputs and selects. 11px 14px -> */
  input: "6px 10px",
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
