// One tunable type + control scale for the DOM chrome (Lobby, ChatBox,
// TopTicker, InlineQuickChat, the dashboard room strip).
//
// A module because the legibility pass had to change ~60 `fontSize` literals
// across five components, and doing that by hand is a one-time fix for a
// recurring question -- the sizes drift apart a little more each sweep. The
// scale is deliberately SMALL (seven steps).
//
// WHY NOT A ROOT font-size AND `rem`, so nobody tries it and quietly gets
// nothing: every style here is an inline `React.CSSProperties` object with
// explicit `px`, which a root font-size does not touch; and form controls do not
// inherit font-size by default, so an inheritance-based approach silently misses
// exactly the controls this pass most needed to fix. The canvas renderers are
// OUT of scope -- both have zoom-aware scaling a fixed scale would fight.
//
// Design note #3: the third pass goes DOWNWARD. Two earlier passes compounded to
// about 1.4x, and a UI drawn 1.4x too large is one a player fixes with the zoom
// control -- which is the report. "Hard to read" and "needs 50% zoom" are not
// opposite complaints if the reader was already zoomed out to fit the board:
// each pass made the next one necessary. So this sets desktop-dense targets (13px
// body, 14px controls, 11-12px badges, 16px headings) AND caps the board to the
// viewport (`HexGridRenderer` design note #30), which is the half that was
// missing. Every step moves together.
//
// See docs/ai_architecture/ui_shell_layout.md, typography.ts #3.

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
 *  These move WITH the font, always. Text shrunk without shrinking its box leaves
 *  controls that are small AND still tall -- the density never arrives and the
 *  type just looks lost. A 14px label in 7px vertical padding is a ~30px control,
 *  which puts an action strip inside the 44-52px band the layout targets. */
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
