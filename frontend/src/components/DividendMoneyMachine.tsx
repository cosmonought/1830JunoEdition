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

/** The 900ms the merge takes, as specified. Exported so the shell's audio cue and this component's own
 *  impact frame cannot drift -- one number, two consumers (#1062). */
export const MONEY_MACHINE_FALL_MS = 900;
/** How long the merged total sits before it leaves. "The panel lingers for ~2 seconds so players can read
 *  the total." */
export const MONEY_MACHINE_LINGER_MS = 2000;
/** The slide, in and out. "Smoothly slides in from the right edge" and "smoothly slides back off-screen." */
export const MONEY_MACHINE_SLIDE_MS = 420;

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
  /** Fired at the impact frame, for the cue that has to land on the merge rather than on the mount. */
  onImpact: () => void;
  /** Fired when the fade completes, so the shell can clear its state. */
  onDone: () => void;
}

export function DividendMoneyMachine({ event, onImpact, onDone }: DividendMoneyMachineProps) {
  /* ==================================================================
      DESIGN NOTE 1061: THREE STATES, NOT A CSS ANIMATION LEFT TO FINISH ALONE
     ==================================================================
     THE TOTAL HAS TO CHANGE ON IMPACT -- "updating the sum immediately upon impact" -- and a number is not
     something CSS can swap halfway through a keyframe. So the phase is React state and the movement is CSS:
     `falling` runs the transform, `merged` is the frame the figure lands and the sum updates, `leaving` is
     the fade. The keyframes never have to know what the number is and the number never has to know how far
     the line has travelled.
     KEYED ON THE TOKEN, so a second payout in the same round restarts at `falling` rather than inheriting a
     finished animation -- the same reason `ActionToast` #697 keys its entrance on a token. */
  const [phase, setPhase] = useState<"falling" | "merged" | "leaving">("falling");
  /* Design note #1064: THE PREFERENCE IS READ ONCE PER PAYOUT AND NEVER STORED. A first draft kept it in
     state, on the reasoning that one payout should run on one schedule; it was never read at render, because
     the media block below already handles every visual difference and the effect below handles every timing
     one. A piece of state nothing consumes is the kind of thing `tsc` will not flag and a reader will assume
     is load-bearing. */
  useEffect(() => {
    if (!event) return undefined;
    const quiet = prefersReducedMotion();
    setPhase(quiet ? "merged" : "falling");

    const timers: number[] = [];
    if (quiet) {
      /* "TRIGGER THE LOCAL AUDIO AT 0ms." There is no merge to wait for -- the panel arrives merged, so the
         cue marks its arrival. */
      onImpact();
    } else {
      /* THE IMPACT IS A TIMER, NOT AN `animationend`. A tab in the background throttles animation events and
         can drop them entirely; a payout that never merged would leave the old total on screen and never fire
         the cue. `setTimeout` in a throttled tab runs late, which is recoverable, rather than not at all. */
      timers.push(
        window.setTimeout(() => {
          setPhase("merged");
          onImpact();
        }, MONEY_MACHINE_FALL_MS),
      );
    }

    const settled = quiet ? 0 : MONEY_MACHINE_FALL_MS;
    timers.push(window.setTimeout(() => setPhase("leaving"), settled + MONEY_MACHINE_LINGER_MS));
    /* "INSTANTLY DISAPPEAR WITHOUT SLIDING" is the zero here: with motion reduced the leaving phase has no
       duration to wait out, so the panel is unmounted in the same tick it is marked leaving. */
    timers.push(
      window.setTimeout(
        onDone,
        settled + MONEY_MACHINE_LINGER_MS + (quiet ? 0 : MONEY_MACHINE_SLIDE_MS),
      ),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [event, onImpact, onDone]);

  if (!event) return null;

  /* Design note #1061: the sum updates AT the merge, which is what makes the figure look absorbed rather than
     replaced. Before impact the bottom line still reads what the player had. */
  const shown = phase === "falling" ? event.cashBefore : event.cashAfter;

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
        {/* ---- Top line: the payer, falling ---- */}
        <div
          style={styles.payerRow}
          className={phase === "falling" ? "app-money-machine-fall" : "app-money-machine-landed"}
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

        {/* ---- Bottom line: the viewer, and the total that absorbs it ---- */}
        <div style={styles.holderRow}>
          <span style={styles.holder}>
            {/* Design note #1060: the seat's colour as a dot rather than as ink. The panel is dark by
                requirement and the seat colours were chosen against a light card -- #1050 measured three of
                the six under the body-text threshold, and that was against WHITE. A swatch carries the
                identity with no contrast claim attached. */}
            <span
              aria-hidden="true"
              style={{
                ...styles.seatDot,
                ...(event.seatColor ? { backgroundColor: event.seatColor } : styles.seatDotUnknown),
              }}
            />
            <span style={styles.holderName}>{event.playerName}</span>
          </span>
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
.app-money-machine {
  animation: app-money-machine-in ${MONEY_MACHINE_SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.app-money-machine-out {
  transform: translateX(100%);
  opacity: 0;
  transition: transform ${MONEY_MACHINE_SLIDE_MS}ms cubic-bezier(0.5, 0, 0.75, 0), opacity ${MONEY_MACHINE_SLIDE_MS}ms ease;
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
    padding: "9px 13px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.14)",
    backgroundColor: "rgba(18, 21, 29, 0.9)",
    backdropFilter: "blur(6px)",
    boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
    color: "#e8ecf4",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    /* It reports; it does not receive -- `ActionToast`'s standing rule, and this sits over the board where a
       swallowed click is a lost tile lay. */
    pointerEvents: "none",
  },
  payerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  payer: { display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 },
  payerTicker: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#aab3c4",
    letterSpacing: "0.03em",
  },
  heraldFallback: { fontSize: FONT_SIZE.micro, fontWeight: 700, color: "#aab3c4" },
  /* The figure that travels. Green because it is money arriving -- #670's rule, and the one colour on this
     panel that means something. */
  payerAmount: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    color: "#5fd39a",
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
  holderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  holder: { display: "inline-flex", alignItems: "center", gap: "7px", minWidth: 0 },
  seatDot: { width: "9px", height: "9px", borderRadius: "999px", flex: "none" },
  seatDotUnknown: { backgroundColor: "#4a5164" },
  holderName: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  holderTotal: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
};
