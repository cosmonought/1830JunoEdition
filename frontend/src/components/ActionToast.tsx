// frontend/src/components/ActionToast.tsx
//
// A brief receipt for the action you just took.
//
// Design note #697: DID THAT GO THROUGH?
//
// REPORTED of the Buy Trains step: "it is slightly hard to tell whether the
// purchase went through. I know the corp card and the supply depot etc all
// update on the action, but somehow it is hard to tell if you purchased
// anything."
//
// EVERY FIGURE ALREADY MOVES, which is exactly why this was hard to diagnose --
// nothing is missing from the screen. The treasury drops, the depot row
// decrements, the train chips grow, and the Activity Log writes a full
// sentence. What none of them do is happen WHERE THE PLAYER IS LOOKING. A
// player who has just clicked Buy is looking at the button; the confirmations
// are in a rail above it, a table beside it and a ticker at the edge of the
// screen. Each is a place you have to already know to check.
//
// THE FIRST ANSWER CONSIDERED WAS A DELTA BADGE ON THE TREASURY, matching #670's
// fix for the dividend report, and it was the wrong transplant: on the cash
// strip the badge sits in the table the reader is already reading, and on the
// corporation card it would be one figure among five, two hundred pixels from
// the click. That is #682's "an answer in the typography of an aside", which
// this codebase has now fixed twice.
//
// THE SECOND WAS CLOSING THE PANEL, which is unambiguous and costs a reopen on
// every subsequent purchase -- a real cost in the one step where buying twice
// is ordinary, and it was raised in the report itself.
//
// SO: A TOAST, which is the one form that goes to the reader rather than
// waiting to be found. It carries NO NEW COPY -- the sentence is the label
// `runGameplayAction` already derived through `describeGameplayAction`, so the
// toast and the Activity Log cannot describe the same action two ways.
//
// SCOPED TO YOUR OWN DISPATCHES. "Did it go through" is a question about a
// button you pressed; a toast for somebody else's action would be a
// notification feed, which is what the log already is.
//
// AND SCOPED TO THE ACTION IT WAS REPORTED FOR -- which this note asserted and
// the code did not do. Mounting the toast on `runGameplayAction` handed one to
// every dispatch in the app; see `utils/actionReceipt.ts` #718 for the
// correction and for why the scope now lives in a rule with a harness rather
// than in the sentence above.
//
// See docs/ai_architecture/ui_shell_layout.md, ActionToast.tsx #697.

import React, { useEffect } from "react";

import { FONT_SIZE } from "../styles/typography";
/* Design note #1048: the auction private cards' own surface, shared rather than matched by eye.
   `CARD_ACCENT` WAS IMPORTED HERE AND NEVER USED -- #1048 left it behind when the accent turned out to belong
   at the CALL SITE (the caller decides whose toast it is; this file only paints what it is handed). Removed
   while this file was open for #1049, because an unused import is invisible to `tsc` under these settings and
   reads to the next person as a colour this component applies somewhere. */
import { CARD_SURFACE } from "../styles/palette";

/** Design note #928's window, named so #967's longer one can be expressed as a multiple of it rather than as
 *  a second magic number that has to be kept in step by hand. */
export const STANDARD_TOAST_MS = 3700;

/* ==================================================================
 *  DESIGN NOTE 983: 400ms, ON INSTRUCTION, AND I THINK THE NUMBER IS WRONG
 * ==================================================================
 *
 * RULED: "The 'Your Private Companies' toast stays up far too long. Reduce its display duration to strictly
 * `400ms`."
 *
 * IT WAS 5,550 -- `STANDARD_TOAST_MS * 1.5` -- and #967 set the multiplier for a stated reason: this is the
 * one toast in the app that is a LIST rather than a sentence, asked for as "increase the display duration of
 * this specific toast to 1.5x the standard duration so it is easily readable".
 *
 * SO THIS BATCH RULES TWICE ON THE SAME TOAST IN OPPOSITE DIRECTIONS: make the payload a stacked table so the
 * rows are "easily comparable", and show it for 400ms. Those two are in tension, and the project's own
 * rule-of-thumb -- "a juice notification should be readable ~1.5x before it goes away" -- prices it: #970 gave
 * a two-digit percentage 850ms on that basis, and a three-row table of names and figures is several times the
 * read. 400ms is under half of what one two-digit number was given.
 *
 * IMPLEMENTED AS RULED ANYWAY, because it is one constant and trivially revertible, and because the report is
 * about a felt problem I should not talk anybody out of: the old window really was long enough to sit in the
 * player's way. What I would not want is for the number to have been chosen believing the table would still
 * be readable at it. The arithmetic is here so the next figure can be picked rather than guessed.
 *
 * IT IS STILL EXPRESSED AS ITS OWN CONSTANT and not inlined at the call site, which is the half of #967 worth
 * keeping: one place to change, and a test that reads the constant rather than a copy of it.
 *
 * ==================================================================
 *  DESIGN NOTE 1000: 400ms MEANT THE TOAST WAS NEVER SEEN
 * ==================================================================
 *
 * REPORTED: "Players are not getting the toast notifications for private company payouts."
 *
 * THE WIRING IS INTACT AND THE WINDOW WAS THE BUG. `summarisePrivateRevenueForPlayer` runs, the rows are
 * built, `showDividendToast` fires -- and then the toast has 400ms to exist, of which its own entrance
 * animation takes 180 (`app-action-toast-in`, one slide-up, no pulse). That leaves roughly 220ms at rest: the
 * thing arrives and is removed before it has finished arriving, which on screen is a flicker at the bottom
 * of the viewport and is very reasonably described as not happening.
 *
 * I FLAGGED THIS WHEN I IMPLEMENTED IT and should have been louder: #983 records the arithmetic and then
 * shipped the number anyway. The note said "what I would not want is for the number to have been chosen
 * believing the table would still be readable at it", which is exactly the outcome, and a warning inside a
 * design note is not a warning anybody reads at the moment it matters.
 *
 * THE FIGURE, BY THE PROJECT'S OWN RULE OF THUMB ("readable ~1.5x before it goes away"). This toast is a
 * heading plus one to three rows of name-and-figure. One row is about a 600ms read, three about 1.4s; 1.5x of
 * the middle is roughly 1.5s, plus the 180ms entrance. 2000ms is that, rounded, and it is still barely a
 * third of #967's original 5,550 -- so the report that started this ("stays up far too long") is answered
 * without answering it into invisibility.
 *
 * AND IT IS STILL THE ONE TOAST WITH ITS OWN WINDOW. Everything else takes `STANDARD_TOAST_MS`; this is a
 * table rather than a sentence, which is the distinction #967 drew and the reason a separate constant exists
 * at all -- only the direction it points has changed twice. */
/* ==================================================================
 *  DESIGN NOTE 1016: 2000ms WAS STILL A GLANCE, AND THE TABLE NEEDS A READ
 * ==================================================================
 *
 * REPORTED: "The private company payout toast disappears too quickly and is positioned incorrectly."
 *
 * #1000 DID THE ARITHMETIC AND THEN ROUNDED THE WRONG WAY. It sized the window off "the middle" of a one-to-
 * three-row table -- about a 1.4s read at three rows -- and set 2000ms, which leaves 1.8s at rest after the
 * 180ms entrance. That is 1.3x a three-row read, not the 1.5x the note's own rule of thumb asks for, and the
 * three-row case is the common one: most tables have several privates in play at once.
 *
 * 3200ms IS 1.5x THE LONG CASE rather than the middle one, plus the entrance. The asymmetry is deliberate --
 * a player who finishes reading early loses a second of screen furniture, and a player who does not finish
 * loses the figures entirely. Those are not the same cost.
 *
 * AND IT IS STILL WELL UNDER #967's 5,550, so the original "stays up far too long" report is still answered.
 * This constant has now moved three times; what has changed each time is which of the two failures it was
 * being tuned away from. */
export const PRIVATE_REVENUE_TOAST_MS = 3200;

/** Where a toast sits. `"center"` is every toast in the app but one -- see design note #1016 on `toastCorner`
 *  for why the private payout is the exception. */
export type ToastAnchor = "center" | "bottom-right";

/** Adds up a detail column that holds money strings like `"$25"`.
 *
 *  Design note #1047: PARSED RATHER THAN REQUIRED AS NUMBERS, because `detailRows` is a display shape and has
 *  been since #984 -- changing it to carry numbers would touch every caller for the benefit of one. Digits are
 *  extracted rather than the string being trusted, so a row reading "$25/OR" still contributes 25 and a row
 *  with no figure at all contributes nothing instead of `NaN`, which would poison the whole sum. */
export function sumRows(rows: readonly { value: string }[]): string {
  let total = 0;
  for (const row of rows) {
    const digits = row.value.replace(/[^0-9-]/g, "");
    const amount = Number.parseInt(digits, 10);
    if (Number.isFinite(amount)) total += amount;
  }
  return `$${total}`;
}

export interface ActionToastProps {
  /** The sentence, or `null` for nothing pending. */
  message: string | null;
  /** Design note #738: a second, quieter line -- today the treasury transition on a dividend receipt.
   *  Optional because the ordinary receipt (#697) has one thing to say and should not grow a slot it leaves
   *  empty. */
  detail?: string | null;
  /* ==================================================================
   *  DESIGN NOTE 984: A LIST IS NOT A SENTENCE, AND `detail` COULD ONLY BE A SENTENCE
   * ==================================================================
   *
   * REPORTED: "Cramming all the companies onto one line is unreadable. Reformat the toast payload into a
   * multi-line flex-column or table layout so the company titles and their respective revenues are
   * vertically stacked and easily comparable."
   *
   * THE ONE-LINE FORM WAS NOT A STYLING CHOICE, it was the only shape `detail` can hold. It is a `string`,
   * joined with a middle dot at the source, so by the time it reached this component the rows had already
   * stopped being rows -- and no amount of CSS recovers a column from a sentence.
   *
   * A SECOND CHANNEL RATHER THAN A PARSED `detail`. Splitting the string back on its separator here would
   * make the separator load-bearing punctuation, and a private company whose name contained one would
   * silently produce a wrong table. The caller has the structure; it should hand it over rather than encode
   * and re-decode it.
   *
   * OPTIONAL, AND `detail` STAYS. Every other toast in the app has one thing to say (#697) and #738's
   * dividend receipt has a transition line, not a table; giving them a grid slot they leave empty is the
   * shape #697 argues against. Exactly one caller passes rows.
   *
   * ALIGNMENT IS THE WHOLE POINT of the request -- "easily comparable" -- so this is a two-column grid with
   * the figures right-aligned in tabular figures, not a flex column of pre-joined strings. Comparing $25 with
   * $5 by eye needs the digits in one column, which is the thing a `\n`-joined string cannot do either. */
  detailRows?: readonly { label: string; value: string }[] | null;
  /** ==================================================================
   *   DESIGN NOTE 1016: AN EXPLICIT ANCHOR, NOT `detailRows` STANDING IN FOR ONE
   *  ==================================================================
   *
   * REPORTED: "anchor it to the bottom-right (instead of bottom-center)."
   *
   * THE TEMPTING SHORTCUT WAS TO KEY OFF `detailRows`, since exactly one caller passes them and exactly one
   * caller wants the corner -- and that is this codebase's fifth recurring bug shape: a proxy that stands for
   * its subject until the day a second caller has rows and no wish to move, or wants the corner without a
   * table. Position is its own decision, so it gets its own prop.
   *
   * DEFAULTED TO `"center"`, so the four existing call sites are untouched and #697's argument for the
   * centred position -- "a receipt for a deliberate action should be on the axis the reader is already on" --
   * still governs every toast it was written about. This one is not a receipt for anything the reader did. */
  anchor?: ToastAnchor;
  /** Changes on every dispatch, including two identical ones in a row --
   *  which is why it exists rather than keying the timer on `message`. Buying
   *  a second 2-train produces the same string, and a toast that did not
   *  re-show for it would be silent on exactly the repeat this feature is
   *  about. */
  token: number;
  onDismiss: () => void;
  /** How long it stays. Long enough to read a sentence, short enough that a
   *  player taking four actions in a row is not reading a queue.
   *
   *  Design note #928: 2600 -> 3700. REPORTED as "too short for players to read the financial details", and
   *  the receipts grew into that complaint rather than starting there: #923's headline now carries a route
   *  total, a percentage and an amount, and #738's detail line adds a treasury transition underneath. The
   *  original figure was set for a one-clause receipt.
   *  THE SECOND HALF OF THE OLD SENTENCE STILL BINDS. A queue of four is still the failure mode at the other
   *  end, and the token-keyed timer below is what stops it: a second action restarts the clock rather than
   *  stacking, so a longer window costs a fast player nothing.
   *  (The request said 2.7s; the value in the code was 2.6s. Moved to the stated TARGET of 3.7s rather than
   *  by the stated delta, since the target is the thing that was actually judged against a screen.) */
  durationMs?: number;
  /** ==================================================================
   *   DESIGN NOTE 1047: THE ONE TOAST THAT WAITS
   *  ==================================================================
   *
   * REPORTED: "there can be so much variability in what's on them that there's no good way to standardize a
   * time for them ... I worry the toast that disappears suggests the information is less strategic than it
   * actually is."
   *
   * AND THIS FILE ALREADY RECORDED THE PROBLEM WITHOUT NAMING IT. The private-revenue toast has been tuned in
   * BOTH directions: #967 set it to 1.5x standard because "this is the one toast in the app that is a LIST
   * rather than a sentence", and #1013 brought it back down after it was reported as staying up far too long.
   * That is not a number nobody has found yet -- it is evidence that no single number fits content whose
   * length depends on how many privates a player happens to hold.
   *
   * SO THIS ONE STOPS GUESSING AND WAITS. `durationMs` is ignored when this is set; the toast stays until the
   * player closes it.
   *
   * A MODAL WAS THE OTHER CANDIDATE AND WAS DECLINED. Private income is paid every Operating Round,
   * deterministically, with no decision in it -- and #1032 was reported precisely because modals "kept firing
   * at the start of basically every operating round". A recurring modal for the least surprising event in the
   * game would spend the interruption budget where it buys least, and would train players to dismiss the
   * fleet-loss modal, where dismissing without reading costs a turn.
   *
   * ==================================================================
   *  DESIGN NOTE 1049: THE MODAL WON, AND THE PARAGRAPH ABOVE IS WHY IT SHOULD NOT HAVE BEEN DECLINED
   * ==================================================================
   *
   * THE PREMISE WAS WRONG AND WAS CORRECTED BY THE REPORTER: "the reason the modals happening every Operating
   * Round was annoying is that the information they were displaying was irrelevant/old." The paragraph above
   * cites #1032 as evidence that recurring modals are unwelcome; #1032 is evidence that STALE ones are, and
   * #1032 fixed the staleness. A payout modal is about money that moved a moment ago and cannot be old.
   * The desensitisation worry was the half worth keeping and is answered in `App.tsx` #1049a by SEQUENCING the
   * two modals rather than by omitting one, so they are never a stack to click through.
   * KEPT IN PLACE, NOT DELETED, because a note that quietly loses its argument teaches the next reader that
   * the question was never asked.
   *
   * `persistent` HAS NO CALLER TODAY. Its one user was the private payout, which is now
   * `PrivateRevenueModal`. The prop and its close button survive because they are a working, harnessed
   * capability and the reasoning at the top of this block is still sound about toasts in general -- there is
   * no number that fits content of variable length. If nothing has claimed it by the next pass through this
   * file, delete it: an unused prop is invisible to `tsc` and to ESLint, and only a comment marks it. */
  persistent?: boolean;
  /** ==================================================================
   *   DESIGN NOTE 1048: WHOSE TOAST THIS IS, AS A COLOUR
   *  ==================================================================
   *
   * ASKED: "may I ask that the toast notification be the white/cream/whatever background the PC cards have in
   * the Auction Round? and that all other player-focused toasts be in the player-color?"
   *
   * AND THE GROUND WAS ALREADY ALMOST THAT, BY COINCIDENCE. #1030 moved this toast to `#f6f1e4` to get it off
   * the dark map; the auction's private cards use `CARD_SURFACE` at `#f7f5f0`. Two hand-picked creams a shade
   * apart is the #891 shape waiting to happen, so the toast now takes the SHARED constant -- they cannot
   * drift, and the resemblance becomes a statement rather than an accident.
   *
   * THE ACCENT IS THE IDENTITY. A private payout wears the private cards' own accent; a toast about the
   * viewer's own money wears their seat colour. The era toast, which is a fact about the table rather than
   * about anybody, passes nothing and is unchanged.
   *
   * AN EDGE, NOT A GROUND, AND THAT IS A DEVIATION FROM THE LITERAL REQUEST. Seat colours are chosen to be
   * distinguishable from each other, not to carry dark text -- #702 measured one livery pair at 1.00:1 against
   * the ink it was meant to be read against, and #1030 exists because this very toast once blended into what
   * it sat on. So the colour goes on a 5px left border, exactly as the auction card carries its own, and the
   * ground and ink stay the pair that was measured. The toast is identifiably yours from across the screen and
   * still readable up close. */
  accentColor?: string | null;
  /** Design note #929: the era transition this toast is announcing, when it is announcing one. A DESCRIPTOR
   *  rather than a node, so the toast's state stays plain data and this component keeps sole ownership of how
   *  a hex is drawn -- a caller passing JSX would be a second place that decides what Green looks like. */
  eraTransition?: { from: string; to: string } | null;
}

/** Design note #929: one flat-top hex in an era's own colour.
 *
 *  THE FILLS ARE THIS TOAST'S OWN and deliberately not `PRINTED_HEX_FILL` or the tile catalog's palette:
 *  those are the colours a hex is DRAWN on a dark board at map scale, and a 16px glyph inside a toast needs
 *  to read against the toast's background instead. Borrowing them would couple a notification's legibility to
 *  a rendering decision made about the canvas. */
const ERA_HEX_FILL: Readonly<Record<string, string>> = {
  Yellow: "#d9b64a",
  Green: "#4e9d5f",
  Brown: "#8a6242",
};

function EraHex({ tone }: { tone: string }) {
  const fill = ERA_HEX_FILL[tone] ?? "#6d7382";
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" role="presentation">
      {/* A pointy-top hex, the orientation the board draws (#1's unit hex). */}
      <path
        d="M8 0.6 L15.2 4.8 V13.2 L8 17.4 L0.8 13.2 V4.8 Z"
        fill={fill}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="1"
      />
    </svg>
  );
}

export function ActionToast({
  message,
  detail = null,
  detailRows = null,
  token,
  onDismiss,
  durationMs = STANDARD_TOAST_MS,
  eraTransition = null,
  anchor = "center",
  persistent = false,
  accentColor = null,
}: ActionToastProps) {
  useEffect(() => {
    if (message === null) return undefined;
    // Design note #1047: a persistent toast has no clock at all -- it waits for the X.
    if (persistent) return undefined;
    const timer = window.setTimeout(onDismiss, durationMs);
    /* Cleared on `token` as well as on unmount: a second action inside the
       window restarts the clock rather than inheriting the first one's
       remaining time and vanishing early. */
    return () => window.clearTimeout(timer);
  }, [message, token, onDismiss, durationMs, persistent]);

  if (message === null) return null;

  return (
    <>
      <style>{ACTION_TOAST_CSS}</style>
      <div
        /* `status`, not `alert`: this reports something that has already
           happened successfully. `alert` interrupts, and a receipt is not an
           interruption. */
        role="status"
        aria-live="polite"
        /* Design note #697: `key` on the token, so React remounts and the entrance animation replays for a
           repeated action. Without it a second identical purchase would update nothing in the DOM and the
           player would see a toast that never moved. */
        key={token}
        /* Design note #1016: the corner variant OVERRIDES `left`/`transform`, so it must come second -- a
           spread that merely added `right` would leave `left: 50%` in place and put the toast off-screen. */
        style={{
          ...styles.toast,
          ...(anchor === "bottom-right" ? styles.toastCorner : {}),
          // Design note #1048: the identity edge, matching the auction card's own left rule.
          ...(accentColor
            ? { borderLeftWidth: "5px", borderLeftStyle: "solid", borderLeftColor: accentColor }
            : {}),
        }}
        className={anchor === "bottom-right" ? "app-action-toast-corner" : "app-action-toast"}
      >
        {persistent && (
          /* ==================================================================
              DESIGN NOTE 1047: ONE LIVE TARGET IN AN INERT PANEL
             ==================================================================
             THE TOAST IS DELIBERATELY CLICK-THROUGH -- `pointerEvents: "none"`, with the standing rule that
             "it reports; it does not receive. Clicks fall through to whatever it is covering, so a toast can
             never eat the next purchase." A close button needs the opposite.
             SO THE EXCEPTION IS THE BUTTON AND NOTHING ELSE. `pointerEvents: "auto"` is re-enabled on this
             one element, which is about twenty pixels square in a corner; the rest of the panel stays inert
             and the rule it was written for still holds everywhere it mattered. Widening the exception to the
             container would be the tidier-looking edit and would reintroduce exactly the swallowed click. */
          <button
            type="button"
            style={styles.close}
            onClick={onDismiss}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        )}
        <span style={styles.check} aria-hidden="true">
          ✓
        </span>
        <span style={styles.body}>
          <span style={styles.text}>{message}</span>
          {/* ==================================================================
               DESIGN NOTE 929: THE ERA CHANGE, SHOWN AS WELL AS SAID
              ==================================================================
              REPORTED: the text-only era notification "is a bit dry. Add a simple inline graphic ... a plain
              yellow hex shape, an arrow, and a plain green hex shape."
              AND IT IS THE ONE TOAST WHOSE SUBJECT IS A PICTURE. Every other receipt reports a number; this
              one reports that a colour of TILE is now legal, and the player is about to go looking for that
              colour in the tile picker. Two hexes and an arrow say "this becomes that" in the same vocabulary
              the board uses.
              PLAIN HEXES, NO TRACK, per the request. A tile drawn with track would claim a specific tile is
              available, which is not what an era change means -- it unlocks a whole colour.
              `aria-hidden`, because the sentence beside it already says the same thing in words. */}
          {eraTransition && (
            <span style={styles.eraGraphic} aria-hidden="true">
              <EraHex tone={eraTransition.from} />
              <svg width="14" height="10" viewBox="0 0 14 10" style={styles.eraArrow}>
                <path
                  d="M0 5 H10 M6.5 1.5 L10 5 L6.5 8.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <EraHex tone={eraTransition.to} />
            </span>
          )}
          {/* Design note #738: the transition, under the sentence rather than beside it. Money moving is two
              facts -- what arrived and where it left you -- and #670 settled that they read as a before and an
              after rather than as one run-on line. */}
          {detail && <span style={styles.detail}>{detail}</span>}
          {/* Design note #984: the rows, when the caller has rows. Rendered INSTEAD of nothing rather than
              instead of `detail` -- the two are independent slots, and the private-revenue toast is simply
              the only caller that fills this one. */}
          {detailRows && detailRows.length > 0 && (
            <span style={styles.detailTable}>
              {detailRows.map((row) => (
                /* The label is the key: a player cannot hold the same private twice, so it is unique by the
                   rules rather than by construction -- and an index key here would re-associate rows if the
                   list were ever re-ordered under a running animation. */
                <React.Fragment key={row.label}>
                  <span style={styles.detailRowLabel}>{row.label}</span>
                  <span style={styles.detailRowValue}>{row.value}</span>
                </React.Fragment>
              ))}
              {detailRows.length > 1 && (
                /* ==================================================================
                    DESIGN NOTE 1047: THE TOTAL, WHERE THE LIST ALREADY IS
                   ==================================================================
                   ASKED: a standing private-income total, and then -- "Why don't we instead put that on the
                   toast notification?" Which is the better home: this panel IS the list, so the sum belongs
                   at its foot rather than on a surface that would have to repeat the breakdown to explain
                   itself. It also costs no new screen real estate, which the player card version would have.
                   ONLY WHEN THERE IS SOMETHING TO ADD UP. One private is its own total, and a "Total" row
                   under a single line restates it -- the shape #697 argues against for the ordinary receipt.
                   SUMMED FROM THE ROWS RATHER THAN PASSED IN, deliberately: a caller-supplied figure could
                   disagree with the rows above it, and a total that does not match its own column is worse
                   than no total. The rows are the source; this is arithmetic on them. */
                <>
                  <span style={styles.detailTotalLabel}>Total</span>
                  <span style={styles.detailTotalValue}>{sumRows(detailRows)}</span>
                </>
              )}
            </span>
          )}
        </span>
      </div>
    </>
  );
}

export default ActionToast;

/* It arrives, it does not pulse. A receipt that keeps moving reads as a warning; this one slides up once and
   then holds still until it goes.
   REDUCED MOTION KEEPS THE TOAST AND LOSES THE SLIDE -- the same rule `PlayerCards` #606 and the cash badge
   both follow, and for the same reason: the information is the sentence, never the movement. */
const ACTION_TOAST_CSS = `
@keyframes app-action-toast-in {
  from { opacity: 0; transform: translate(-50%, 10px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}
/* Design note #1016: the corner variant needs its OWN keyframe. The centred one bakes translate(-50%) into
   both ends -- that is the centring, not the animation -- so reusing it on a right-anchored toast would drag
   it half its own width off the edge for the whole slide and leave it there. Same 10px rise, no offset.
   NO BACKTICKS IN THIS BLOCK. It lives inside a template literal, which is animations.ts #755's trap and the
   third time I have walked into it -- the string terminates at the first one and tsc reports it somewhere
   else entirely. */
@keyframes app-action-toast-in-corner {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
.app-action-toast {
  animation: app-action-toast-in 180ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.app-action-toast-corner {
  animation: app-action-toast-in-corner 180ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .app-action-toast { animation: none; }
  .app-action-toast-corner { animation: none; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  body: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  /* Quieter than the headline and monospaced, because it is a pair of figures rather than a sentence -- the
     same treatment the Ledger gives every before/after in this app. */
  /* Design note #929: under the sentence, on the same left margin as the detail line -- the graphic is a
     restatement of the message rather than an ornament beside it. */
  eraGraphic: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "6px",
    marginTop: "6px",
    color: "#5a6070",
  },
  eraArrow: { flex: "none" },
  detail: {
    fontSize: FONT_SIZE.micro,
    // Design note #1030: the quieter line on the cream ground -- still secondary, still readable.
    color: "#5a6070",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /* Design note #984: two columns -- names flush left, figures flush right in tabular figures, so the digits
     line up whatever the names are. `auto auto` rather than `1fr auto`: the table is as wide as its content
     and the toast stays the width of its sentence, where a fractional first column would stretch a
     three-row list across the whole card.
     `columnGap` DOES THE SEPARATING, not a dot or a dash. The middle dot this replaces was punctuation
     standing in for a column, which is exactly what stopped the figures being comparable. */
  detailTable: {
    display: "grid",
    gridTemplateColumns: "auto auto",
    columnGap: "14px",
    rowGap: "2px",
    marginTop: "6px",
    fontSize: FONT_SIZE.micro,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  detailRowLabel: { color: "#5a6070", textAlign: "left" },
  /* Design note #1047: the total reads as a sum rather than another row -- a rule above it and the label in
     the same muted ink as the names, so the eye lands on the figure. */
  detailTotalLabel: {
    color: "#5a6070",
    textAlign: "left",
    borderTop: "1px solid #b9ae91",
    paddingTop: "3px",
    marginTop: "2px",
  },
  detailTotalValue: {
    color: "#12151d",
    textAlign: "right",
    fontWeight: 700,
    borderTop: "1px solid #b9ae91",
    paddingTop: "3px",
    marginTop: "2px",
  },
  /* Brighter than the label: on a row of two facts the figure is the one being compared, and #670's rule for
     the dividend block applies here too -- the number carries the decision, the name only says whose it is. */
  // Design note #1030: darker than the label, for the same reason it used to be brighter -- the figure carries
  // the decision and the contrast has simply inverted with the ground.
  detailRowValue: { color: "#12151d", textAlign: "right", fontVariantNumeric: "tabular-nums" },
  /* Design note #697: BOTTOM CENTRE, above the status dock. Not top -- the action bar is sticky there and a
     toast over it would cover the controls the player is mid-sequence with, which is the one place it must
     not be. Not a corner either: a receipt for a deliberate action should be on the axis the reader is
     already on, and centred is the only position that is the same distance from every button.
     `position: fixed` and a high `zIndex`, because it has to clear the sticky bar and the board canvas both. */
  /* ==================================================================
      DESIGN NOTE 1016: THE ONE TOAST THAT IS NOT ABOUT SOMETHING YOU DID
     ==================================================================
     RULED: "anchor it to the bottom-right (instead of bottom-center)."

     AND #697's ARGUMENT FOR THE CENTRE DOES NOT COVER THIS ONE. That note put toasts on the reader's own axis
     because they are receipts -- "a receipt for a deliberate action should be on the axis the reader is
     already on, and centred is the only position that is the same distance from every button." The private
     payout is not a receipt for anything the reader pressed: it arrives when a round opens, unbidden, and it
     is the longest-lived toast in the app. On the centre axis it sits directly over the sticky action bar's
     midline for three seconds at the exact moment a new Operating Round hands the player their controls.

     THE CORNER IS WHERE AMBIENT NOTIFICATIONS GO, and this is the app's only ambient one. Same `bottom`, so
     it still clears the bar; `right` replaces `left`, and `transform` is cleared because a right-anchored
     element does not need centring and the centred keyframe's `-50%` would push it off the edge. */
  toastCorner: {
    left: "auto",
    right: "24px",
    transform: "none",
  },
  toast: {
    position: "fixed",
    left: "50%",
    bottom: "84px",
    transform: "translateX(-50%)",
    zIndex: 4000,
    display: "flex",
    alignItems: "center",
    gap: "9px",
    maxWidth: "min(560px, calc(100vw - 32px))",
    padding: "10px 16px",
    borderRadius: "10px",
    /* ==================================================================
        DESIGN NOTE 1030: CREAM ON THE DARK BOARD, NOT DARK GREEN ON IT
       ==================================================================
       REPORTED: "The dark green toast notifications blend in too heavily with the map background and app UI."

       AND THE WHOLE APP IS DARK, which is what makes a dark toast the wrong answer however carefully it is
       tuned. `#16211a` on a `#12141b` shell over a board of dark cardboard is a panel among panels; the one
       surface that has to be seen over everything else was the one competing with everything else. #810 found
       the same failure on the Buy Trains panel -- "a surface that sinks below its own container reads as a
       well" -- and this is that diagnosis applied to the element with the strongest claim to stand out.

       CREAM RATHER THAN WHITE. Pure white on this palette is a hole; `#f6f1e4` is the parchment the
       corporation and player cards already use, so the toast reads as a card that has arrived rather than as
       a new material. The app has exactly one light surface language and this joins it.

       NOT THE ACTING CORPORATION'S LIVERY, which the report offered as the alternative. Two reasons: this
       toast is often about a corporation the reader does not control (the private payout is the ambient one,
       #1016), so tinting it by whoever is operating would attach a colour to the wrong subject -- and #702
       measured a 1.00:1 contrast between a train chip and NNH's livery, which is the same trap one surface
       over. One legible ground, and colour reserved for the tick and the figures.

       THE GREEN SURVIVES WHERE IT MEANS SOMETHING: the check glyph below keeps #670's rule that green is
       money or a thing arriving. What changes is that it now sits on a ground it can be read against. */
    /* Design note #1048: the auction private cards' own surface, shared rather than matched by eye. #1030
       picked `#f6f1e4` independently and landed one shade away, which is two constants meaning one thing. */
    backgroundColor: CARD_SURFACE,
    border: "1px solid #b9ae91",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.55)",
    color: "#1d2230",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: FONT_SIZE.body,
    lineHeight: 1.45,
    /* It reports; it does not receive. Clicks fall through to whatever it is
       covering, so a toast can never eat the next purchase. */
    pointerEvents: "none",
  },
  /* Green, and the only place this toast uses colour. #670's rule: green means money or a thing arriving, and
     an action that succeeded is the plainest case of it. */
  /* Design note #1030: deepened from `#4ea172`, which was chosen against a near-black ground and is washed
     out on cream. Same hue, same meaning, legible where it now lives. */
  /* Design note #1047: the one element in the panel that receives a click. Positioned in the panel's own
     corner rather than in the flow, so adding it does not reflow a layout four other toasts share. */
  close: {
    position: "absolute",
    top: "4px",
    right: "6px",
    pointerEvents: "auto",
    cursor: "pointer",
    border: "none",
    background: "none",
    padding: "0 4px",
    lineHeight: 1,
    fontSize: FONT_SIZE.strong,
    color: "#5a6070",
    font: "inherit",
  },
  check: { color: "#1f7a4d", fontWeight: 700, flexShrink: 0 },
  text: { minWidth: 0 },
};
