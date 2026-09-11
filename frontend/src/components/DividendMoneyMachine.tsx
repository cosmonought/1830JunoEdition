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
import { CARD_DIVIDER, CARD_INK, CARD_INK_MUTED, CARD_INK_POSITIVE } from "../styles/palette";
import { bestContrastTextColor } from "../styles/corporationLivery";
import { CorporateLogo } from "./CorporateLogo";
import {
  MONEY_MACHINE_FALL_AT_MS,
  MONEY_MACHINE_MERGE_AT_MS,
  MONEY_MACHINE_LEAVE_AT_MS,
  MONEY_MACHINE_TOTAL_MS,
} from "./moneyMachineSchedule";
/* Design note #1291: the shared panel. It imports this file's schedule constants; this file imports its
   component -- a cycle TypeScript resolves because neither side reads the other at module-evaluation time. */
import { MoneyMachinePanel } from "./MoneyMachinePanel";
/* Design note #1339: the spend's own timing and ink, shared with the treasury machine. */
import { CARD_INK_NEGATIVE, SPEND_CUE_AT_MS } from "./TreasuryMoneyMachine";

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
/* Design note #1291: the eight marks live in `moneyMachineSchedule.ts` now (a leaf module, for the panel's
   sake) and are re-exported here under the same names. */
export {
  MONEY_MACHINE_SLIDE_MS,
  MONEY_MACHINE_HOLD_MS,
  MONEY_MACHINE_FALL_MS,
  MONEY_MACHINE_LINGER_MS,
  MONEY_MACHINE_FALL_AT_MS,
  MONEY_MACHINE_MERGE_AT_MS,
  MONEY_MACHINE_LEAVE_AT_MS,
  MONEY_MACHINE_TOTAL_MS,
} from "./moneyMachineSchedule";


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
  /** The corporation paying, for the herald and the top line. Design note #1339: `null` when the mover is
   *  not a corporation -- a private bought at auction, or the auction's private income -- and `label` names
   *  it instead. */
  ticker: string | null;
  /** Design note #1339: the mover's name when there is no herald to show. */
  label?: string;
  /** What this viewer received. Design note #1339: NEGATIVE for a spend -- the figure rises out of cash with
   *  the spend's whoosh (`SPEND_SFX`) rather than falling onto it with the register. */
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
  /** Design note #1339: the spend cue, fired so its whoosh lands on the merge. Only for a negative amount. */
  onSpendCue?: () => void;
  /** Fired when the panel has finished leaving, so the shell can clear its state. */
  onDone: () => void;
  /** Design note #1291: 1 when the treasury's panel already holds the corner. */
  stackIndex?: number;
}

export function DividendMoneyMachine({
  event,
  onCue,
  onSpendCue,
  onDone,
  stackIndex = 0,
}: DividendMoneyMachineProps) {
  const [phase, setPhase] = useState<"holding" | "falling" | "merged" | "leaving">("holding");

  useEffect(() => {
    if (!event) return undefined;
    const quiet = prefersReducedMotion();
    setPhase(quiet ? "merged" : "holding");
    const timers: number[] = [];
    /* #1339: a spend rings the whoosh (`TreasuryMoneyMachine`'s timing), a payout the register. */
    const spend = event.amount < 0;
    if (quiet) {
      if (spend) (onSpendCue ?? onCue)();
      else onCue();
    } else {
      if (spend) timers.push(window.setTimeout(onSpendCue ?? onCue, SPEND_CUE_AT_MS));
      else timers.push(window.setTimeout(onCue, MONEY_MACHINE_CUE_AT_MS));
      timers.push(window.setTimeout(() => setPhase("falling"), MONEY_MACHINE_FALL_AT_MS));
      timers.push(window.setTimeout(() => setPhase("merged"), MONEY_MACHINE_MERGE_AT_MS));
      timers.push(window.setTimeout(() => setPhase("leaving"), MONEY_MACHINE_LEAVE_AT_MS));
    }
    timers.push(window.setTimeout(onDone, MONEY_MACHINE_TOTAL_MS));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [event, onCue, onSpendCue, onDone]);

  if (!event) return null;
  const spend = event.amount < 0;

  /* ==================================================================
      DESIGN NOTE 1291: THE PANEL IS SHARED; THIS FILE KEEPS THE SCHEDULE AND THE SOUND
     ==================================================================
     Everything this component used to draw -- the stripe (#1098), the payer row, the total and its caption
     (#1163), the CSS that collapsed the row (#1082, #1163) -- is `MoneyMachinePanel` now, shared with the
     treasury's machine so the two cannot drift. What stays here is what is particular to a dividend: the
     five-phase schedule (#1082), the cue that rings on the merge (#1062), the seat stripe, and the direction
     -- a payout FALLS onto cash. The row collapse is gone: the report (16) was that it read as the panel
     narrowing rather than as a merge, and the figure itself travels now. The three phase class names
     survive on the mover row for the callers' pins. */
  const moverClassName =
    phase === "holding"
      ? "app-money-machine-waiting"
      : phase === "falling"
        ? "app-money-machine-fall"
        : "app-money-machine-landed";
  return (
    <MoneyMachinePanel
      token={event.token}
      phase={phase}
      kind="player"
      header={{
        label: event.playerName,
        fill: event.seatColor,
        ink: event.seatColor ? bestContrastTextColor(event.seatColor) : CARD_INK,
      }}
      mover={{
        label:
          event.ticker !== null ? (
            <>
              <CorporateLogo
                ticker={event.ticker}
                size={16}
                title={`${event.ticker} herald`}
                fallbackStyle={styles.heraldFallback}
              />
              <span style={styles.payerTicker}>{event.ticker}</span>
            </>
          ) : (
            <span style={styles.payerTicker}>{event.label ?? (spend ? "Spent" : "Received")}</span>
          ),
        amountText: `${spend ? "−" : "+"}$${Math.abs(event.amount)}`,
        ink: spend ? CARD_INK_NEGATIVE : CARD_INK_POSITIVE,
      }}
      holder={{ label: "Cash", before: event.cashBefore, after: event.cashAfter }}
      stackIndex={stackIndex}
      moverClassName={moverClassName}
      /* #1339: a spend rises out of cash, as it rises out of a treasury (#1291). */
      direction={spend ? "up" : "down"}
    />
  );
}

export default DividendMoneyMachine;

const styles: Record<string, React.CSSProperties> = {
  payerTicker: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: CARD_INK_MUTED,
    letterSpacing: "0.03em",
  },
  heraldFallback: { fontSize: FONT_SIZE.micro, fontWeight: 700, color: CARD_INK_MUTED },
  /* Design note #1291: kept so `stripeUnknown` still names the neutral band this file's pins look for; the
     panel draws it. */
  stripeUnknown: { backgroundColor: CARD_DIVIDER, color: CARD_INK },
};
