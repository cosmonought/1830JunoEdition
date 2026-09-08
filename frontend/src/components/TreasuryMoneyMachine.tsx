// frontend/src/components/TreasuryMoneyMachine.tsx
//
// A corporation's treasury moving, shown as the money moving rather than as a sentence about it.
//
// ==================================================================
//  DESIGN NOTE 1272: THE TREASURY GETS THE DIVIDEND MACHINE'S VOCABULARY
// ==================================================================
//
// REPORTED (7 September plan, 4.2): the train-purchase toast "is not registering with players". Ruled:
//   - drop the train-purchase toast, keep the depot-supply one;
//   - add a treasury slide-out for any corporation treasury adjustment, mirroring the player-cash slide-out;
//   - same animation vocabulary, but a SUBTRACTION-MERGING variant.
//
// ==================================================================
//  DESIGN NOTE 1291: AND NOW THE SAME PANEL, IN THE SAME CORNER, THE OTHER WAY UP
// ==================================================================
//
// REPORTED (14): "The Treasury payment slide-out does not actually merge the numbers and does not stay out
// after it completes the change ... please match exactly the animation and pacing of the Dividend payout
// slide-out." And (16a): "treasury up top, red payment amount at bottom, and merge-subtract upward." And
// (17): both slide-outs bottom right, cued by the corporation's livery and herald and the word TREASURY,
// with rounded corners against the player's square ones.
//
// So this file is the dividend machine's twin: `MoneyMachinePanel` draws it, #1082's schedule times it,
// and what is particular to a treasury is here -- the livery header, the sign, the upward merge, and the
// SOUND (9): `spend.mp3`, timed so its whoosh lands as the figure subtracts. Measured rather than guessed
// (#1082's own method for the ding): the clip is 1.66s and its loudest 50ms sit at 1.18s, so it is fired
// 1.18s before the merge mark, the way `money-machine.mp3` is fired 0.70s before it.
//
// "DOES NOT STAY OUT" was a second fault: a burst of dispatches replaced the event mid-flight, and a new
// `token` remounts the panel. The shell queues movements now (#1291, `App.tsx`) and hands this one at a time.

import React, { useEffect, useState } from "react";
import { FONT_SIZE } from "../styles/typography";
import { CARD_INK_MUTED, CARD_INK_POSITIVE } from "../styles/palette";
import { bestContrastTextColor, corporationLiveryColor } from "../styles/corporationLivery";
import { MoneyMachinePanel } from "./MoneyMachinePanel";
import {
  MONEY_MACHINE_FALL_AT_MS,
  MONEY_MACHINE_LEAVE_AT_MS,
  MONEY_MACHINE_MERGE_AT_MS,
  MONEY_MACHINE_TOTAL_MS,
} from "./moneyMachineSchedule";

/** The spend ink -- the malus red the Activity Log uses (`TopTicker` #1042), at card contrast. */
export const CARD_INK_NEGATIVE = "#b42318";

/** The cue, by its on-disk name (#1062's rule: named with its owner, checked against `public/audio`). */
export const SPEND_SFX = "spend.mp3";
/** Where the whoosh peaks inside the clip, measured. */
export const SPEND_WHOOSH_AT_MS = 1180;
/** Fired so the peak lands on the merge. */
export const SPEND_CUE_AT_MS = MONEY_MACHINE_MERGE_AT_MS - SPEND_WHOOSH_AT_MS;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

export interface TreasuryMovementEvent {
  companyId: number;
  ticker: string;
  /** Signed: negative for a spend. */
  amount: number;
  treasuryBefore: number;
  treasuryAfter: number;
  /** A fresh value per event, so two identical movements in a row still remount (#1060's `token`). */
  token: number;
}

export interface TreasuryMoneyMachineProps {
  event: TreasuryMovementEvent | null;
  /** Design note #1291: the spend cue, fired so its whoosh lands on the merge. Only for a spend. */
  onCue: () => void;
  onDone: () => void;
  /** 1 when the dividend panel already holds the corner. */
  stackIndex?: number;
}

export function TreasuryMoneyMachine({ event, onCue, onDone, stackIndex = 0 }: TreasuryMoneyMachineProps) {
  const [phase, setPhase] = useState<"holding" | "falling" | "merged" | "leaving">("holding");

  useEffect(() => {
    if (!event) return undefined;
    const quiet = prefersReducedMotion();
    const spend = event.amount < 0;
    setPhase(quiet ? "merged" : "holding");
    const timers: number[] = [];
    if (quiet) {
      if (spend) onCue();
    } else {
      if (spend) timers.push(window.setTimeout(onCue, SPEND_CUE_AT_MS));
      timers.push(window.setTimeout(() => setPhase("falling"), MONEY_MACHINE_FALL_AT_MS));
      timers.push(window.setTimeout(() => setPhase("merged"), MONEY_MACHINE_MERGE_AT_MS));
      timers.push(window.setTimeout(() => setPhase("leaving"), MONEY_MACHINE_LEAVE_AT_MS));
    }
    timers.push(window.setTimeout(onDone, MONEY_MACHINE_TOTAL_MS));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [event, onCue, onDone]);

  if (!event) return null;

  const spend = event.amount < 0;
  const livery = corporationLiveryColor(event.companyId);
  const magnitude = Math.abs(event.amount);
  return (
    <MoneyMachinePanel
      token={event.token}
      phase={phase}
      kind="corporation"
      header={{
        label: event.ticker,
        fill: livery,
        ink: bestContrastTextColor(livery),
        heraldTicker: event.ticker,
      }}
      mover={{
        label: <span style={styles.moverLabel}>{spend ? "Spent" : "Received"}</span>,
        amountText: `${spend ? "−" : "+"}$${magnitude}`,
        ink: spend ? CARD_INK_NEGATIVE : CARD_INK_POSITIVE,
      }}
      holder={{ label: "Treasury", before: event.treasuryBefore, after: event.treasuryAfter }}
      stackIndex={stackIndex}
    />
  );
}

export default TreasuryMoneyMachine;

const styles: Record<string, React.CSSProperties> = {
  moverLabel: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: CARD_INK_MUTED,
    letterSpacing: "0.03em",
  },
};
