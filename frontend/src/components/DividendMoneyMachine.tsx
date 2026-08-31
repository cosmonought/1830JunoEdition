// frontend/src/components/DividendMoneyMachine.tsx
//
// The payout, shown as the money arriving rather than as a sentence about money.
//
// ==================================================================
//  DESIGN NOTE 1060: A RECEIPT THAT IS LEGIBLE BECAUSE IT MOVES
// ==================================================================
//
// SPECIFIED: "Remove Old Toast: Completely disable the default fast-fading toast notification for dividend
// payouts", replaced by "a localized overlay in the bottom right corner for any player receiving a payout ...
// a distinct background (e.g. semi-transparent dark gray or frosted glass) so the text is fully legible
// against the game board and colored heralds."
//
// AND THE LEGIBILITY COMPLAINT IS THE OLDER ONE. #1030 moved the toast to cream because "the dark green toast
// notifications blend in too heavily with the map background and app UI"; this asks for the opposite material
// for the same reason, and both are right about their own surface. #1030's toast is a CARD that arrives -- it
// borrows the auction's paper. This is a READOUT over the board, closer to the revenue flash than to a card,
// and a light panel over a light herald is the collision #702 measured at 1.00:1. Dark ground, light ink,
// stated rather than inherited.
//
// WHO SEES IT IS NOT A NEW DECISION. `dividendReceipt` already returns `null` unless the viewer personally
// holds shares and was paid a positive amount (#795, #923), so the overlay inherits exactly the scoping the
// toast had: your own money, on your own screen, and nothing on a screen belonging to somebody who was paid
// nothing. The player's NAME is on it anyway, because a figure with no owner in the corner of a shared board
// is the ambiguity #1050 spent a batch removing from the payout modal.
//
// ==================================================================
//  DESIGN NOTE 1061: THE MERGE IS THE MESSAGE, AND IT STILL CANNOT BE THE ONLY ONE
// ==================================================================
//
// THE ANIMATION IS SPECIFIED PRECISELY -- 900ms, the top line falls into the bottom, the herald fades to zero,
// the figure merges and the total updates "immediately upon impact", then it lingers and fades. Built as
// written.
//
// BUT THIS APP TURNS MOTION OFF, everywhere, on one rule it has never made an exception to: `PlayerCards`
// #606's lift, `ActionToast`'s slide and every keyframe in `animations.ts` are all wrapped in
// `prefers-reduced-motion`, and #606 states the principle -- "the information is the sentence, never the
// movement." A payout the player only learns by watching two lines collide would be the first surface in the
// tree where the motion IS the information.
//
// SO THE REDUCED-MOTION PATH IS NOT A DEGRADED VERSION, IT IS THE SAME FACTS WITHOUT THE TRAVEL. The panel
// appears already merged: the name, the new total, and the payout beside it as a static `+$54`. Same
// lifetime, same sound at the same moment, nothing to read that a moving reader would have had.
//
// See docs/ai_architecture/ui_shell_layout.md, DividendMoneyMachine.tsx #1060.

import React, { useEffect, useState } from "react";

import { FONT_SIZE } from "../styles/typography";
/* Design note #1098: the card palette, and the per-seat ink picker the player card's own stripe uses. Both
   are borrowed rather than matched by eye -- that borrowing IS the change. */
import {
  CARD_BORDER,
  CARD_DIVIDER,
  CARD_INK,
  CARD_INK_MUTED,
  CARD_INK_POSITIVE,
  CARD_SURFACE,
} from "../styles/palette";
import { bestContrastTextColor } from "../styles/corporationLivery";
import { CorporateLogo } from "./CorporateLogo";

/** The cue, by its on-disk name.
 *
 *  ==================================================================
 *   DESIGN NOTE 1062: NAMED HERE, NOT IN THE VARIANT REGISTRY
 *  ==================================================================
 *
 *  `variantSfx.ts` HOLDS THE OTHER FILENAMES and `everySfxFile()` is checked against `public/audio` by
 *  `batch46` -- the guard #1040 built after two spec names turned out not to match what was on disk
 *  (`iec-crack.mp3`, `carcosa_awaits.mp3`). The obvious move is to add this one to that list.
 *
 *  IT WOULD BREAK THE OTHER CASE IN THAT PAIR. `everySfxFile()` means "every file the flavour-line keyword
 *  table can reach", and `batch46` also asserts that nothing in it is UNREACHABLE from that table. A cue
 *  belonging to the dividend overlay is not reachable from a keyword table about train journeys, so listing
 *  it would make one case pass by making the other lie.
 *
 *  SO IT LIVES WITH ITS OWNER AND CARRIES ITS OWN ON-DISK ASSERTION, in `batch52`. The lesson from #1040 is
 *  that a filename must be checked against the filesystem, not that it must live in one particular array. */
export const MONEY_MACHINE_SFX = "money-machine.mp3";

/* ==================================================================
    DESIGN NOTE 1082: FIVE PHASES, AND THE MARKS ARE DERIVED FROM THEM
   ==================================================================

   REPORTED: "The current animation merges the numbers too quickly after sliding in, making it impossible for
   players to read the payout amount before it disappears." Ruled as an exact schedule:

     0.0 - 0.5  slide in          0.5 - 1.5  BOTH FIGURES HOLD STILL
     1.5 - 2.0  the merge         2.0 - 3.0  linger on the summed total
     3.0 - 3.5  slide out

   THE MISSING PHASE WAS THE PAUSE, and it is the whole complaint. #1061 started the fall at MOUNT, so the top
   line was already dropping while the panel was still sliding in: the two numbers a player has to read never
   stood still together for a single frame. Lengthening the fall would not have fixed that -- it would have
   made a longer smear. What was needed was a beat where nothing moves.

   THE MARKS ARE COMPUTED FROM THE DURATIONS, not typed alongside them. The spec states both -- five spans and
   six timestamps -- and writing down both invites the pair that #1042's two alphas were: two statements of one
   fact, agreeing until somebody edits one. The durations are the source; every mark is a running sum.

   THE CUE MOVED, AND NOT BY A DESIGN PREFERENCE. `money-machine.mp3` is 2.23s long and still audible at
   1.86s. Fired at the ruled 2.0s mark it would have been ringing 0.36s after the panel had slid off -- the
   same "delayed or laggy" complaint that had just been raised about `coins-clinking.mp3` outlasting the
   revenue flash. RULED, once measured: "have it fire once the slide-in is complete." At 0.5s the clip ends at
   2.36s, comfortably inside, and its loudest moment lands at ~1.54s, on the merge. */

/** 0.0-0.5s in, 3.0-3.5s out. */
export const MONEY_MACHINE_SLIDE_MS = 500;
/** 0.5-1.5s. The beat this batch exists to add: both figures perfectly still, so they can be read. */
export const MONEY_MACHINE_HOLD_MS = 1000;
/** 1.5-2.0s. The top line drops and fades; the bottom becomes the sum at the end of it. */
export const MONEY_MACHINE_FALL_MS = 500;
/** 2.0-3.0s, on the final total. */
export const MONEY_MACHINE_LINGER_MS = 1000;

/** When the top line starts to drop. */
export const MONEY_MACHINE_FALL_AT_MS = MONEY_MACHINE_SLIDE_MS + MONEY_MACHINE_HOLD_MS;
/** When it has landed and the sum updates. */
export const MONEY_MACHINE_MERGE_AT_MS = MONEY_MACHINE_FALL_AT_MS + MONEY_MACHINE_FALL_MS;
/** When the panel starts to leave. */
export const MONEY_MACHINE_LEAVE_AT_MS = MONEY_MACHINE_MERGE_AT_MS + MONEY_MACHINE_LINGER_MS;
/** Total lifetime, animated or not (#1082). */
export const MONEY_MACHINE_TOTAL_MS = MONEY_MACHINE_LEAVE_AT_MS + MONEY_MACHINE_SLIDE_MS;

/** ==================================================================
 *   DESIGN NOTE 1082: WHERE THE BELL IS INSIDE THE CLIP
 *  ==================================================================
 *
 * RULED, after the clip's length was measured: "have it fire once the slide-in is complete." Then, with more
 * of the file described: "money-machine ends with a cash register 'ding' sound, so the ideal animation is for
 * the merge/sum to conclude in the neighborhood of that."
 *
 * THE SECOND STATEMENT IS A GOAL AND THE FIRST WAS A MEANS, so the goal wins and the means is recomputed.
 * Decoding the file at 8kHz and taking a 50ms envelope gives its shape: a crank/rattle from 0.15s peaking at
 * 0.60s, then a fresh attack at 0.85s reaching 0.86 of peak and ringing down to inaudible by ~1.9s. A sharp
 * strike with a long metallic decay IS the bell; everything before it is the drawer.
 *
 * SO THE DING IS AT 0.85s, NOT AT THE END. Firing at the slide-in's completion would have rung it at 1.35s --
 * in the middle of the pause, with nothing moving. Working backwards from the merge instead puts the crank
 * under the falling line and the bell on the frame the sum lands.
 *
 * DERIVED, SO THE ALIGNMENT SURVIVES AN EDIT. If the schedule moves, or the clip is replaced and this figure
 * is re-measured, the cue follows without anyone remembering to move it. A hand-typed `1150` would be correct
 * today and silently wrong the first time either changes.
 *
 * MEASURED, NOT SPECIFIED, which is why it lives here with its method rather than in a table of design
 * decisions: it is a property of a file on disk, and `batch56` re-derives it from that file rather than
 * trusting this constant.
 *
 * ==================================================================
 *  DESIGN NOTE 1086: 850 BECAME 700 WHEN THE CLIP LOST ITS DEAD AIR
 * ==================================================================
 *
 * THE AUDIO PASS TRIMMED 0.11s FROM THE HEAD of this file and 0.21s from its tail, along with 13.5s of the
 * same across the pack. The bell did not move inside the sound; the sound moved forward inside the file.
 *
 * AND THIS IS EXACTLY WHY `batch56` DECODES THE MP3 rather than checking one constant against another. A
 * tautological assertion would have stayed green through a change that silently pushed the register 150ms
 * past the merge -- the fault this alignment was built to avoid, reintroduced by an unrelated batch. The
 * case failed, which is the whole of what it is for. */
export const MONEY_MACHINE_DING_AT_MS = 700;

/** When the register starts, so that its bell lands on the merge. */
export const MONEY_MACHINE_CUE_AT_MS = MONEY_MACHINE_MERGE_AT_MS - MONEY_MACHINE_DING_AT_MS;

/** Whether this viewer has asked for less movement.
 *
 *  ==================================================================
 *   DESIGN NOTE 1064: THE REDUCED PATH IS A DIFFERENT SCHEDULE, NOT JUST DIFFERENT CSS
 *  ==================================================================
 *
 *  SPECIFIED: "If motion is reduced, skip the slide-in entirely. The panel must instantly appear on-screen in
 *  its final merged state, displaying the `+$[Payout]` statically next to it, trigger the local audio at 0ms,
 *  linger, and then instantly disappear without sliding."
 *
 *  AND `@media` ALONE CANNOT DO THAT. A stylesheet can stop the panel moving, but the cue fires from a
 *  `setTimeout` at the 900ms impact and the total changes on a React state flip -- neither is reachable from
 *  CSS. A media-query-only implementation would leave a reduced-motion player watching a static panel show
 *  the OLD total for 900 silent milliseconds and then jump, which is worse than the animation.
 *
 *  SO THE COMPONENT ASKS. `matchMedia` optional-chained twice, matching `HexGridRenderer`'s existing read:
 *  jsdom has no media engine, and a test environment that returns `undefined` must mean "animate" rather than
 *  throw. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

export interface DividendPayoutEvent {
  /** The corporation paying, for the herald and the top line. */
  ticker: string;
  /** What this viewer received. */
  amount: number;
  /** The viewer, named on the bottom line. */
  playerName: string;
  /** Their seat colour, or `null` when the roster cannot place them (#232). */
  seatColor: string | null;
  /** Cash before the payout -- the figure the total counts UP from. */
  cashBefore: number;
  /** Cash after. Read off the settled state rather than added here, on #685's rule. */
  cashAfter: number;
  /** Changes per payout so a second dividend restarts the animation rather than inheriting a finished one. */
  token: number;
}

export interface DividendMoneyMachineProps {
  /** `null` renders nothing. */
  event: DividendPayoutEvent | null;
  /** ==================================================================
   *   DESIGN NOTE 1082: `onImpact` BECAME `onCue`, BECAUSE IT NO LONGER MEANS IMPACT
   *  ==================================================================
   *
   * IT FIRED AT THE MERGE and the name said so. The clip now starts when the panel finishes arriving, half a
   * second before anything merges, so keeping the old name would leave a prop whose one job is to say WHEN
   * and which says the wrong when. That is the proxy-stopped-standing-for-its-subject shape, in a name.
   * RENAMED RATHER THAN RE-DOCUMENTED: a comment correcting a name is read by whoever opens this file, and
   * the name is read by whoever greps for it. */
  onCue: () => void;
  /** Fired when the panel has finished leaving, so the shell can clear its state. */
  onDone: () => void;
}

export function DividendMoneyMachine({ event, onCue, onDone }: DividendMoneyMachineProps) {
  /* ==================================================================
      DESIGN NOTE 1061: THREE STATES, NOT A CSS ANIMATION LEFT TO FINISH ALONE
     ==================================================================
     THE TOTAL HAS TO CHANGE ON IMPACT -- "the bottom line updates to the new sum" -- and a number is not
     something CSS can swap halfway through a keyframe. So the phase is React state and the movement is CSS:
     `falling` runs the transform, `merged` is the frame the figure lands and the sum updates, `leaving` is
     the fade. The keyframes never have to know what the number is and the number never has to know how far
     the line has travelled.
     KEYED ON THE TOKEN, so a second payout in the same round restarts at the beginning rather than inheriting
     a finished animation -- the same reason `ActionToast` #697 keys its entrance on a token.

     Design note #1082: `holding` IS THE NEW FIRST PHASE and it is the point of this batch. It covers the
     slide-in AND the pause after it, because nothing about the two lines differs between them -- the slide is
     the panel moving, not the figures -- and a phase that changes nothing a reader can see is a phase that
     exists only to be got wrong. The one thing that happens at the seam between them is the cue, which is a
     timer rather than a render. */
  const [phase, setPhase] = useState<"holding" | "falling" | "merged" | "leaving">("holding");
  /* Design note #1064: THE PREFERENCE IS READ ONCE PER PAYOUT AND NEVER STORED. A first draft kept it in
     state, on the reasoning that one payout should run on one schedule; it was never read at render, because
     the media block below already handles every visual difference and the effect below handles every timing
     one. A piece of state nothing consumes is the kind of thing `tsc` will not flag and a reader will assume
     is load-bearing. */
  useEffect(() => {
    if (!event) return undefined;
    const quiet = prefersReducedMotion();
    setPhase(quiet ? "merged" : "holding");

    const timers: number[] = [];
    if (quiet) {
      /* "TRIGGER THE LOCAL AUDIO AT 0ms." There is no merge to wait for -- the panel arrives merged, so the
         cue marks its arrival. */
      onCue();
    } else {
      /* ==================================================================
          DESIGN NOTE 1082: FOUR TIMERS FOR FOUR MOMENTS, EACH AT ITS OWN MARK
         ==================================================================
         EVERY ONE IS AN ABSOLUTE OFFSET FROM THE MOUNT, not a chain of relative waits. #1061 nested its two
         (`settled + LINGER`), which was readable at two and would be four running sums here -- and a running
         sum is where a phase silently absorbs its neighbour's slip. Each timer states the mark the spec names.
         TIMERS, NOT `animationend`. A tab in the background throttles animation events and can drop them
         entirely; a payout that never merged would leave the old total on screen and never ring. A
         `setTimeout` in a throttled tab runs LATE, which is recoverable, rather than not at all. */
      timers.push(window.setTimeout(onCue, MONEY_MACHINE_CUE_AT_MS));
      timers.push(window.setTimeout(() => setPhase("falling"), MONEY_MACHINE_FALL_AT_MS));
      timers.push(window.setTimeout(() => setPhase("merged"), MONEY_MACHINE_MERGE_AT_MS));
      timers.push(window.setTimeout(() => setPhase("leaving"), MONEY_MACHINE_LEAVE_AT_MS));
    }

    /* ==================================================================
        DESIGN NOTE 1082: THE QUIET PATH NOW LASTS AS LONG AS THE OTHER ONE
       ==================================================================
       #1064 CLAIMED "SAME LIFETIME, SAME SOUND AT THE SAME MOMENT" AND WAS WRONG ABOUT THE FIRST. Its
       animated path ran 900 + 2000 + 420 = 3320ms and its quiet path 2000ms -- a note describing an intention
       as an accomplishment, which is a shape this project keeps producing.
       MADE TRUE RATHER THAN THE CLAIM WITHDRAWN, because the claim is the right one: a reader who has asked
       for less movement has not asked for less time, and the animated path spends 1.5s of its length on the
       final sum. One `MONEY_MACHINE_TOTAL_MS` for both is the shortest way to say that and the only way to
       keep it true after the next edit to the schedule. */
    timers.push(window.setTimeout(onDone, MONEY_MACHINE_TOTAL_MS));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [event, onCue, onDone]);

  if (!event) return null;

  /* Design note #1061: the sum updates AT the merge, which is what makes the figure look absorbed rather than
     replaced. Before then the bottom line still reads what the player had.
     Design note #1082: WRITTEN AS THE PHASES THAT SHOW THE OLD FIGURE, not as the ones that show the new. It
     read `phase === "falling" ? before : after`, and adding `holding` in front of `falling` would have made
     the panel arrive already showing the sum -- the pause is meant to hold BOTH numbers, which is the entire
     point of adding it. Naming the "before" side means a future phase inserted ahead of the merge has to
     declare itself rather than defaulting to the wrong answer. */
  const shown = phase === "holding" || phase === "falling" ? event.cashBefore : event.cashAfter;

  return (
    <>
      <style>{MONEY_MACHINE_CSS}</style>
      <div
        key={event.token}
        style={styles.panel}
        /* Design note #1064: the till slides in from the right edge and back out the same way. Under reduced
           motion both classes are inert (see the media block) and the panel simply is, then is not. */
        className={
          phase === "leaving" ? "app-money-machine app-money-machine-out" : "app-money-machine"
        }
        /* `status`, not `alert`: money arriving is not an interruption, and #697 drew that line for the
           receipt this replaces. */
        role="status"
        aria-live="polite"
      >
        {/* ==================================================================
             DESIGN NOTE 1098: THE PLAYER CARD'S HEADER, BORROWED WHOLE
            ==================================================================
            REPORTED: "it needs to have the background color of the player cards, and perhaps the entire row
            with the player name should be in the player color, repeating the stripe theme."

            #1060 CHOSE A 9px DOT AND ITS REASONING DOES NOT COVER THIS. It rejected the seat colour as INK on
            a dark panel -- "the seat colours were chosen against a light card" -- which is true and is a
            different proposal. A stripe puts the colour on the GROUND and lets `bestContrastTextColor` pick
            the ink per seat, which is what the player card has always done. Measured against that picker all
            six seats clear 4.5:1 (5.04 to 6.37); #1050's "three of the six under threshold" was measured
            against WHITE specifically, and the picker flips to black for Moss, Ochre and Teal.

            #1052'S RULE IS OBEYED HERE: THE STRIPE IS IDENTITY AND NOTHING ELSE. My first draft put the new
            total on it, which is the exact mistake that note records and corrects on the sibling surface --
            "the same number twice, four lines apart" -- made again, one surface over. The total stays in the
            body.

            AND THAT IS WHAT KEEPS THE MERGE FALLING DOWNWARD. The payer row drops onto the total the way a
            column sum is written, addend over sum; #1082's own phase names -- holding, falling, landed -- say
            which way this is meant to go. A stripe carrying the total would have inverted it.

            SO THE TWO PAYOUT SURFACES NOW SPEAK ONE LANGUAGE, which is #569's case for seat colour: "colour
            in exactly one place is decoration; colour meaning the same thing in several places is a
            language." `PrivateRevenueModal` #1049 got here first; this is the same header on the same paper.

            THE COST IS HEIGHT: 64px to 90px, +41%, on a panel that appears every Operating Round. #1049
            recorded a size objection to exactly this layout and called it "a toast objection". This is still
            an overlay over the board, so the objection is live -- ruled anyway, and noted here so the retreat
            is obvious if it plays heavy: drop the divider and the label back to ~78px, keeping the stripe. */}
        <header
          style={{
            ...styles.stripe,
            ...(event.seatColor
              ? { backgroundColor: event.seatColor, color: bestContrastTextColor(event.seatColor) }
              : styles.stripeUnknown),
          }}
        >
          {event.playerName}
        </header>

        {/* ---- Top line: the payer, falling ---- */}
        <div
          style={styles.payerRow}
          /* Design note #1082: THREE STATES, NOT TWO. `holding` is the new one and it must be neither -- not
             `fall` (the drop has not started) and not `landed` (which is `opacity: 0`, and would have made
             the payout invisible for the whole pause that exists to let it be read). */
          className={
            phase === "holding"
              ? "app-money-machine-waiting"
              : phase === "falling"
                ? "app-money-machine-fall"
                : "app-money-machine-landed"
          }
        >
          <span style={styles.payer}>
            <CorporateLogo
              ticker={event.ticker}
              size={16}
              title={`${event.ticker} herald`}
              fallbackStyle={styles.heraldFallback}
            />
            <span style={styles.payerTicker}>{event.ticker}</span>
          </span>
          <span style={styles.payerAmount}>+${event.amount}</span>
        </div>

        {/* ==================================================================
             DESIGN NOTE 1098: THE TOTAL, AND ITS LABEL
            ==================================================================
            THE NAME LEFT THIS ROW for the stripe, which left the total floating against an empty gutter and
            broke the label/figure rhythm the payer row above it keeps. `your cash` restores it.
            FLAGGED AS AN ADDITION rather than slipped in: no such caption existed before. It is here because
            the layout asked for it, not because the report did. */}
        <div style={styles.holderRow}>
          <span style={styles.holderLabel}>your cash</span>
          <span style={styles.holderTotal}>${shown}</span>
        </div>
      </div>
    </>
  );
}

export default DividendMoneyMachine;

/* Design note #1061: NO BACKTICKS IN THIS BLOCK. It lives inside a template literal, which is `animations.ts`
   #755's trap -- the string terminates at the first one and `tsc` reports the error somewhere else entirely.
   Walked into three times in this project; written down here so it is four fewer.

   THE FALL IS A TRANSFORM, not a change of height or margin: those are layout properties and animating them
   re-lays the panel out sixty times a second. `translateY` and `opacity` are the two the compositor can do
   without touching layout, which is the same pair every other animation in this app confines itself to.

   REDUCED MOTION LANDS THE LINE IMMEDIATELY. #606's rule, and the reason the total is React state rather than
   a keyframe: with the travel removed the panel still says the name, the new total and the payout, because
   none of those were ever carried by the movement. */
const MONEY_MACHINE_CSS = `
@keyframes app-money-machine-in {
  from { transform: translateX(100%); opacity: 0; }
  to   { transform: translateX(0); opacity: 1; }
}
@keyframes app-money-machine-drop {
  from { transform: translateY(0); opacity: 1; }
  to   { transform: translateY(26px); opacity: 0; }
}
/* Design note #1082: this duration IS the 0.0-0.5s slide-in phase. It shares MONEY_MACHINE_SLIDE_MS with the
   exit and with every mark derived from it, so the CSS and the timers cannot disagree about when the panel
   has finished arriving -- which is what the cue's offset is measured from.
   NO BACKTICKS -- see #1061 at the head of this block. Walked into a fourth time, by me, four lines from the
   warning that says so. The warning is not the problem; reaching for a backtick to quote an identifier is a
   reflex, and a reflex is not stopped by a comment. */
.app-money-machine {
  animation: app-money-machine-in ${MONEY_MACHINE_SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.app-money-machine-out {
  transform: translateX(100%);
  opacity: 0;
  transition: transform ${MONEY_MACHINE_SLIDE_MS}ms cubic-bezier(0.5, 0, 0.75, 0), opacity ${MONEY_MACHINE_SLIDE_MS}ms ease;
}
/* Design note #1082: the pause, stated rather than left to the absence of a class. The top line is fully
   visible and perfectly still for a full second -- which is the whole of what this batch adds, so it gets a
   name a reader can grep for rather than being the gap between two other rules. */
.app-money-machine-waiting {
  opacity: 1;
  transform: none;
}
.app-money-machine-fall {
  animation: app-money-machine-drop ${MONEY_MACHINE_FALL_MS}ms cubic-bezier(0.55, 0, 0.9, 0.55) forwards;
}
.app-money-machine-landed {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .app-money-machine { animation: none; }
  .app-money-machine-out { transition: none; transform: none; opacity: 1; }
  .app-money-machine-fall { animation: none; opacity: 1; transform: none; }
  /* "DISPLAYING THE +$[PAYOUT] STATICALLY NEXT TO IT." The merged phase hides the payer line once it has been
     absorbed, which is the whole point of the merge -- and with no merge to watch there is nothing to absorb,
     so the figure stays on screen as a static statement of what arrived. */
  .app-money-machine-landed { opacity: 1; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  /* Design note #1060: THE GROUND IS THE REQUIREMENT. "A distinct background ... so the text is fully legible
     against the game board and colored heralds" -- so this is opaque enough to own its pixels rather than a
     wash the board shows through. `backdrop-filter` is the frosted half and is deliberately additive: an
     engine that ignores it still gets the solid layer underneath, which is where the legibility actually
     comes from. */
  panel: {
    position: "fixed",
    right: "24px",
    /* Clear of the status dock, matching the corner the private payout toast used to take (#1016). */
    bottom: "84px",
    zIndex: 4100,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "200px",
    /* Design note #1098: NO HORIZONTAL PADDING ON THE PANEL. The stripe has to reach both edges the way the
       player card's does, and a padded parent would inset it into a floating band. The rows below carry their
       own padding instead -- which is how `PlayerCards` arranges the same thing. */
    padding: "0 0 9px",
    borderRadius: "10px",
    /* Design note #1098: the card's own border, and `overflow: hidden` so the stripe's square top corners are
       clipped to the panel's radius rather than poking out of it. */
    border: `1px solid ${CARD_BORDER}`,
    overflow: "hidden",
    /* ==================================================================
        DESIGN NOTE 1098: PAPER, AND #1060's REQUIREMENT IS BETTER MET BY IT
       ==================================================================
       #1060 RULED "a distinct background ... so the text is fully legible against the game board and colored
       heralds", and satisfied it with a near-opaque dark wash plus a blur. The card surface satisfies the same
       requirement more strongly: it is fully opaque and it is the lightest thing on a dark board, so it owns
       its pixels outright.
       `backdropFilter` IS GONE WITH THE TRANSLUCENCY it existed to soften. A blur behind an opaque layer is
       work no one can see. */
    backgroundColor: CARD_SURFACE,
    boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
    color: CARD_INK,
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    /* It reports; it does not receive -- `ActionToast`'s standing rule, and this sits over the board where a
       swallowed click is a lost tile lay. */
    pointerEvents: "none",
  },
  /** Design note #1098: the stripe, the player card's header at this panel's scale. Square-topped because the
   *  panel's `overflow: hidden` rounds it; `CARD_INK` only as the unknown-seat fallback's ink. */
  stripe: {
    padding: "5px 13px",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    letterSpacing: "0.2px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** Design note #232: a seat the roster cannot place gets the muted paper, never a guessed hue -- the same
   *  answer `PrivateRevenueModal` #1050 gives for the same absence. */
  stripeUnknown: { backgroundColor: CARD_DIVIDER, color: CARD_INK },
  payerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "7px 13px 0",
  },
  payer: { display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 },
  payerTicker: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: CARD_INK_MUTED,
    letterSpacing: "0.03em",
  },
  heraldFallback: { fontSize: FONT_SIZE.micro, fontWeight: 700, color: CARD_INK_MUTED },
  /* The figure that travels. Green because it is money arriving -- #670's rule, and the one colour on this
     panel that means something.
     ==================================================================
      DESIGN NOTE 1098: THE GREEN CHANGES TOKEN BECAUSE THE GROUND DID
     ==================================================================
     `#5fd39a` READS 9.8:1 ON THE OLD DARK PANEL AND 1.7:1 ON PAPER -- effectively invisible, and the one
     figure on this panel that must not be. `CARD_INK_POSITIVE` is the palette's answer for money on the card
     surface at 6.0:1, already used by `PrivateRevenueModal` for exactly this.
     A SWAP, NOT A NEW COLOUR. The rule "#670: green means money arriving" is untouched; only the register it
     is spoken in has changed, the same way ink does between a dark panel and a light one. */
  payerAmount: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    color: CARD_INK_POSITIVE,
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
  holderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "5px 13px 0",
    marginTop: "4px",
    /* Design note #1098: the rule the payer falls ACROSS. It is what makes the drop read as a sum landing in
       a total rather than two figures happening to be near each other -- the line under a column of addends,
       which is the convention the whole animation is imitating. */
    borderTop: `1px solid ${CARD_DIVIDER}`,
  },
  /** Design note #1098: see the render site -- an addition, made because the name's departure left the gutter
   *  empty and the row without the label/figure rhythm the payer row keeps. */
  holderLabel: { fontSize: FONT_SIZE.micro, color: CARD_INK_MUTED, fontWeight: 600 },
  /* Design note #1098: `holderName` and `seatDot` are DELETED, not left unused. The name is the stripe's now,
     and the dot was #1060's substitute for a colour it could not otherwise show -- an orphaned style for a
     thing this panel has stopped doing is how the thing comes back. */
  holderTotal: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
};
