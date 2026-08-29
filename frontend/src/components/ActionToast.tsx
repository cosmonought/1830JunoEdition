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
 * keeping: one place to change, and a test that reads the constant rather than a copy of it. */
export const PRIVATE_REVENUE_TOAST_MS = 400;

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
}: ActionToastProps) {
  useEffect(() => {
    if (message === null) return undefined;
    const timer = window.setTimeout(onDismiss, durationMs);
    /* Cleared on `token` as well as on unmount: a second action inside the
       window restarts the clock rather than inheriting the first one's
       remaining time and vanishing early. */
    return () => window.clearTimeout(timer);
  }, [message, token, onDismiss, durationMs]);

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
        style={styles.toast}
        className="app-action-toast"
      >
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
.app-action-toast {
  animation: app-action-toast-in 180ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .app-action-toast { animation: none; }
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
    color: "#8a90a0",
  },
  eraArrow: { flex: "none" },
  detail: {
    fontSize: FONT_SIZE.micro,
    color: "#9fb8a4",
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
  detailRowLabel: { color: "#9fb8a4", textAlign: "left" },
  /* Brighter than the label: on a row of two facts the figure is the one being compared, and #670's rule for
     the dividend block applies here too -- the number carries the decision, the name only says whose it is. */
  detailRowValue: { color: "#d8e6da", textAlign: "right", fontVariantNumeric: "tabular-nums" },
  /* Design note #697: BOTTOM CENTRE, above the status dock. Not top -- the action bar is sticky there and a
     toast over it would cover the controls the player is mid-sequence with, which is the one place it must
     not be. Not a corner either: a receipt for a deliberate action should be on the axis the reader is
     already on, and centred is the only position that is the same distance from every button.
     `position: fixed` and a high `zIndex`, because it has to clear the sticky bar and the board canvas both. */
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
    backgroundColor: "#16211a",
    border: "1px solid #3f7a55",
    boxShadow: "0 6px 20px rgba(0, 0, 0, 0.5)",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: FONT_SIZE.body,
    lineHeight: 1.45,
    /* It reports; it does not receive. Clicks fall through to whatever it is
       covering, so a toast can never eat the next purchase. */
    pointerEvents: "none",
  },
  /* Green, and the only place this toast uses colour. #670's rule: green means money or a thing arriving, and
     an action that succeeded is the plainest case of it. */
  check: { color: "#4ea172", fontWeight: 700, flexShrink: 0 },
  text: { minWidth: 0 },
};
