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

/* ==================================================================
 *  DESIGN NOTE 975: HOW TALL A LETTER ACTUALLY IS, IN ONE PLACE
 * ==================================================================
 *
 * NEITHER OF THESE IS A CHOICE. They are approximations of a metric the font has and the platform mostly
 * will not tell us: `cap-height` and `x-height` as fractions of the em, for a bold UI sans. They live beside
 * `FONT_SIZE` because that is the number they are always multiplied by.
 *
 * THIS BATCH FOUND THREE COPIES OF THE FIRST ONE, in two files, all written as `0.72` with a comment saying
 * roughly "cap height, near enough":
 *   - `drawReservationBadgeAt`, as the fallback when `actualBoundingBoxAscent` is unavailable (#937);
 *   - `tokenTextChordWidth`, sizing the chord a station token's letters have to fit inside (#564);
 *   - and this batch was about to write a fourth on the action bar's power chip.
 * Three literals agreeing is not an invariant, and a corrected figure would have to be found in three places
 * by someone who did not know there were three.
 *
 * MEASURE WHEN YOU CAN. `drawReservationBadgeAt` calls `measureText` and only falls back to `CAP_HEIGHT_RATIO`
 * when the engine does not report the metric -- #937's whole point, and naming the fallback does not weaken
 * it. CSS gives JavaScript no x-height at all without rendering a glyph and measuring it, so
 * `X_HEIGHT_RATIO` is used directly; that is a real limitation and not an oversight.
 *
 * WHY x-HEIGHT EXISTS HERE AT ALL: an icon set to a string's cap-height sits flush beside ALL-CAPS text and
 * towers over mixed-case text, because most of a mixed-case word is x-height. Two ratios, so a caller can
 * ask which kind of string it is standing next to. See `privatePowerStar` #975. */
export const CAP_HEIGHT_RATIO = 0.72;
export const X_HEIGHT_RATIO = 0.52;

/** The app's one font stack. Was duplicated as a literal in five files. */
export const FONT_FAMILY = "system-ui, -apple-system, Segoe UI, sans-serif";

/** Monospace, for addresses and ids where character alignment aids
 *  comparison. */
export const FONT_FAMILY_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/* ==================================================================
    DESIGN NOTE 1151: TWELVE RADII WERE DOING THE WORK OF ONE
   ==================================================================
   REPORTED: "currently every element uses rounded edges", asked as a request to square the player surfaces so
   they would read differently from the corporations'.

   THE PERCEPTION WAS RIGHT AND THE CAUSE IS ITS OPPOSITE, which is why this is a scale and not a split.
   Counted across the app there were TWELVE distinct radii -- 3, 4, 5, 6, 7, 8, 9, 10, 12 and 14px, plus the
   pill and the circle -- and they were scattered INSIDE single components: `AutoPassModal` used 8 and 12,
   `EmergencyTrainPurchaseModal` 4 and 6, `AudioControlPopover` 6 and 10. Nobody chose those against each
   other; they accreted one surface at a time.
   A ONE-PIXEL DIFFERENCE CARRIES NO INFORMATION AND STILL COSTS ALIGNMENT. Ten values spanning 3 to 14px do
   the visual work of a single value -- everything reads as "sort of rounded" -- while making it impossible for
   any radius to mean anything, because nothing is separated enough to be recognised as a category. That is
   exactly "everything looks the same", arrived at from too many values rather than too few.

   THE SPLIT THAT WAS ASKED FOR FIRST IS DELIBERATELY NOT WHAT THIS IS. Squaring player surfaces would have put
   a second, much weaker channel on a distinction SEAT COLOUR and LIVERY already carry loudly -- and the
   boundary turned out to be genuinely fuzzy: the auction prompt is one person's par plus a table handoff, the
   toast carries corporate news and personal refusals through one component, an emergency train purchase is a
   corporation's action funded from a president's pocket. A shape rule whose exceptions cannot be told from its
   mistakes teaches nothing. RULED, after that was laid out: "everything looking the same is probably the main
   issue."

   SO SHAPE SAYS WHAT KIND OF THING THIS IS, NOT WHOSE IT IS. Three steps, six pixels apart, which is far
   enough that neighbours are distinguishable at real sizes and close enough that the app still looks like
   itself. The rule is SIZE-ORDERED and needs no judgement about ownership: the bigger and the more floating a
   surface, the softer its corner.
   `pill` AND `circle` ARE NOT STEPS ON THIS SCALE and keep their values untouched. They are SHAPES -- a pill
   is a pill at any size -- and folding them into a graduated scale would have been the same category error as
   the one this note is fixing, one level up. */
export const RADIUS = {
  /** Buttons, inputs, chips, badges -- anything a finger presses or a word sits in. Was 3-7px. */
  control: "4px",
  /** Cards, panels, tables, the tab strip -- the surfaces content lives ON. Was 8-10px. */
  card: "10px",
  /** Modals, toasts, popovers -- surfaces that float ABOVE the page. Was 12-14px. */
  layer: "16px",
  /** Not a step: a pill is a pill at any size. */
  pill: "999px",
  /** Not a step either: a circle is a shape. */
  circle: "50%",
} as const;
