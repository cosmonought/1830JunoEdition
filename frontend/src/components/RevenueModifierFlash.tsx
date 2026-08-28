// frontend/src/components/RevenueModifierFlash.tsx
//
// ==================================================================
//  DESIGN NOTE 940: THE MODIFIER, SAID OUT LOUD FOR TWO SECONDS
// ==================================================================
//
// RULED: "When a run's payout is legitimately altered, provide immediate visual feedback so players don't
// have to hunt the log ... a brief, non-blocking visual overlay flashing the modifier in the dead center of
// the screen ... Large font, floating text ONLY. Do not put this in a box, pill, or standard toast
// notification window ... Green for bonuses, Red for maluses ... exactly 2 seconds."
//
// NOT A TOAST, AND THE DISTINCTION IS THE POINT. `ActionToast` is a receipt: it lands in a corner, it stacks,
// it is read at leisure, and #794 moved it to fire from the drain so it could be trusted. This is the
// opposite kind of object -- it is the game reacting, in the middle of the screen, and gone before it can be
// studied. Sharing the toast's machinery would have made it inherit a window, a stack position and a
// dismissal, which is three-quarters of what "floating text ONLY" rules out.
//
// `pointer-events: none` ON EVERYTHING, which is what "non-blocking" has to mean mechanically. Dead centre is
// exactly where the board and its controls are, and an overlay that swallowed a click for two seconds after
// every run would be a worse bug than the one it was built to prevent.
//
// TRIGGERED ONLY WHEN THE PAYOUT ACTUALLY MOVED. The caller passes a `delta` it got from #938's
// `revenueOutcome`, so a 90% roll that rounded back to the printed figure raises nothing -- the same
// predicate the log sentence uses, for the reason recorded there.

import React, { useEffect, useState } from "react";

/** Exactly two seconds, as ruled. Exported so the test asserts the number the component uses rather than a
 *  copy of it. */
export const REVENUE_FLASH_MS = 2000;

/** How long the fade at the end takes, inside the two seconds rather than after them: "display for exactly 2
 *  seconds, then fade or disappear" -- so the text is legible for most of the window and gone at the end of
 *  it, rather than lingering to 2s plus a fade. */
export const REVENUE_FLASH_FADE_MS = 400;

export interface RevenueFlashSignal {
  /** Signed whole percentage: `+20`, `-10`. Zero never reaches here -- see the module note. */
  delta: number;
  /* ==================================================================
      DESIGN NOTE 940: A TOKEN, BECAUSE THREE TRAINS CAN ROLL THE SAME FACE
     ==================================================================
     A turn dispatches one run per train, and two of them can legitimately produce the same `delta`. Keyed on
     the value alone, React would see no change and the second flash would never play -- the player would
     watch one train's bonus and silently miss the next. So the caller stamps a monotonic token and this
     restarts on it.
     THE SAME SHAPE `ActionToast` USES for its own re-arming (#923's token-keyed timer), and for the same
     underlying reason: "it happened again" is a distinct event from "it is still true". */
  token: number;
}

export interface RevenueModifierFlashProps {
  signal: RevenueFlashSignal | null;
}

/** Green up, red down. The two colours are the board's own, not new ones -- a bonus reads like a rising share
 *  price and a malus like a falling one, which is the association a player already has. */
const BONUS_COLOR = "#4ade80";
const MALUS_COLOR = "#f87171";

export function RevenueModifierFlash({ signal }: RevenueModifierFlashProps): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState<RevenueFlashSignal | null>(null);

  useEffect(() => {
    if (!signal) return undefined;
    /* HELD IN LOCAL STATE so the text does not vanish the instant the caller clears its signal -- the
       component owns the two seconds, and a parent that cleared early would truncate them. */
    setShown(signal);
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), REVENUE_FLASH_MS);
    return () => window.clearTimeout(timer);
    // Design note #940: the TOKEN is the dependency, not the delta -- see `RevenueFlashSignal`.
  }, [signal?.token, signal]);

  if (!shown) return null;

  const bonus = shown.delta > 0;
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        /* NO BACKGROUND, NO BORDER, NO RADIUS -- the whole of "floating text ONLY". The container exists to
           centre, and centring is all it does. */
        pointerEvents: "none",
        zIndex: 9000,
        opacity: visible ? 1 : 0,
        transition: `opacity ${REVENUE_FLASH_FADE_MS}ms ease-out`,
      }}
    >
      <span
        style={{
          fontSize: "clamp(48px, 12vw, 132px)",
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: bonus ? BONUS_COLOR : MALUS_COLOR,
          /* THE HALO AGAIN, for the reason #364 gives on the hex badge: this text floats over a board that is
             yellow, green, grey and red by turns, and a plate is exactly what was ruled out. A shadow costs no
             footprint and keeps it legible over all of them. */
          textShadow: "0 2px 18px rgba(0, 0, 0, 0.85), 0 0 3px rgba(0, 0, 0, 0.9)",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {bonus ? "+" : "-"}
        {Math.abs(shown.delta)}%
      </span>
    </div>
  );
}
