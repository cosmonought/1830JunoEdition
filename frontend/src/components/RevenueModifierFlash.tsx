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
import { createPortal } from "react-dom";
import { REVENUE_FLASH_ARROWS_CSS, REVENUE_FLASH_GLOW_CSS } from "../styles/animations";

/** Exactly two seconds, as ruled. Exported so the test asserts the number the component uses rather than a
 *  copy of it. */
/* ==================================================================
    DESIGN NOTE 954: SHORTER, BECAUSE IT IS A TWO-DIGIT NUMBER
   ==================================================================
   REPORTED: "The floating variant modifier is too large and hangs on screen too long", and then the rule of
   thumb behind it: "a juice notification should be readable ~1.5x before it goes away, and it doesn't take
   long to read a two-digit number."
   THE ARITHMETIC THAT PICKED 700. "+20%" is about a 300ms read. 1.5x of that is ~450ms of LEGIBLE time --
   and legible time is the window minus the fade, not the window. 700ms with a 200ms fade leaves ~500ms at
   full opacity, which clears the rule with a little room; 500ms with the old 400ms fade would have left
   100ms, which is why the fade had to shrink with it rather than being left alone.
   ONE CONSTANT, so trying 500 or 800 is a one-line change and the test reads it rather than a copy. */
export const REVENUE_FLASH_MS = 700;

/** How long the fade at the end takes, inside the two seconds rather than after them: "display for exactly 2
 *  seconds, then fade or disappear" -- so the text is legible for most of the window and gone at the end of
 *  it, rather than lingering to 2s plus a fade. */
export const REVENUE_FLASH_FADE_MS = 200;

/* ==================================================================
 *  DESIGN NOTE 956: ABOVE EVERYTHING, BY BEING OUTSIDE EVERYTHING
 * ==================================================================
 *
 * REPORTED: "the notification is getting pinned or stuck directly underneath the Action Bar instead of
 * appearing in the center of the viewport."
 *
 * AND I COULD NOT NAME THE ANCESTOR THAT DID IT. The overlay already carried `position: fixed; inset: 0` and
 * a `zIndex` far above the bar's 50, which is the configuration that is supposed to make this impossible. The
 * two things that break it are a containing block (an ancestor with `transform`, `filter`, `perspective`,
 * `contain` or `will-change`) and a stacking context (an ancestor that is positioned with a `z-index`, or has
 * `opacity < 1`, or `isolation`). A search of the shell's style sheet and its inline styles turned up neither
 * on any ancestor of this component.
 *
 * SO THIS IS FIXED STRUCTURALLY RATHER THAN BY PATCHING A CAUSE I COULD NOT IDENTIFY. A portal to
 * `document.body` renders outside the App subtree entirely, which means no ancestor's containing block or
 * stacking context can reach it -- whatever the specific one turned out to be. That is a guarantee rather than
 * a correction, and it is what "must break out of any local container constraints" asks for.
 * SAYING THAT PLAINLY because a fix whose mechanism I cannot demonstrate is worth flagging as such: this makes
 * the symptom impossible, and it does not tell either of us which element was causing it.
 *
 * THE CEILING IS DELIBERATE. The highest `zIndex` in `appStyles.ts` is 3000; this sits well above it and is
 * named rather than inline so the two can be compared without reading two files. */
export const REVENUE_FLASH_Z_INDEX = 9000;

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
/** Where the six arrows sit around the figure, and when each starts.
 *
 *  PERCENTAGES, so the spread scales with the type rather than clustering on a large screen and overlapping
 *  on a small one. Every delay is comfortably inside `REVENUE_FLASH_MS` -- an arrow that started after the
 *  overlay had faded would be paid for and never seen, which is the one way this can be silently wrong. */
/** The swing at which the arrows step up a size -- the two 20% faces. Named rather than inline so #957's
 *  rule reads as a rule and not as a magic number beside a ternary. */
const CRITICAL_SWING_PERCENT = 20;

const ARROW_POSITIONS: readonly {
  left: string;
  top: string;
  delay: number;
  /* ==================================================================
      DESIGN NOTE 959: A MIX OF SIZES, SKEWED BY TIER
     ==================================================================
     RULED: "the animation arrows should be a mix of sizes, but skew larger on the critical and smaller on the
     malus. They shouldn't all be one size."
     AGREED, AND NO PUSHBACK -- #957's single size per tier was the weaker idea and it is worth saying why
     rather than just replacing it. Six identical glyphs on six offsets read as a WIDGET: the eye resolves a
     repeating unit and stops. Mixed sizes read as depth, because that is what distance does to a size in
     every scene a person has ever looked at, and the irregularity is what makes six marks read as drift
     rather than as a control.
     AND THE MAGNITUDE CUE SURVIVES BECAUSE IT MOVED FROM THE SIZE TO THE DISTRIBUTION. #957's point stands --
     "big green" has to be readable before the numeral is -- and a tier scalar over a varied set keeps that
     while dropping the uniformity. The spread is what changed; the skew is what was kept.
     THESE ARE MULTIPLIERS, not sizes. The tier scalar below turns them into ems, so a future change to
     "how much bigger is critical" is one number rather than twelve. */
  scale: number;
}[] = [
  { left: "-14%", top: "10%", delay: 0, scale: 1.25 },
  { left: "6%", top: "-18%", delay: 90, scale: 0.7 },
  { left: "34%", top: "24%", delay: 40, scale: 1 },
  { left: "62%", top: "-14%", delay: 150, scale: 0.8 },
  { left: "88%", top: "16%", delay: 70, scale: 1.4 },
  { left: "108%", top: "-6%", delay: 120, scale: 0.85 },
];

/** The em the multipliers above are applied to. Critical swings skew larger, minor smaller -- #957's rule,
 *  now expressed as the centre of a spread rather than as the whole of it. */
const ARROW_BASE_EM = { critical: 0.34, minor: 0.2 } as const;

const BONUS_COLOR = "#4ade80";
const MALUS_COLOR = "#f87171";

/** The glow's core colour -- the outcome's own hue at low alpha. Derived by eye rather than by `mixHex`,
 *  because this one is not a blend between two known inks: it is a light source, and the alpha is doing the
 *  work that a blend ratio would do for a solid. */
const BONUS_GLOW = "rgba(74, 222, 128, 0.28)";
const MALUS_GLOW = "rgba(248, 113, 113, 0.28)";

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
  /* ==================================================================
      DESIGN NOTE 957: BIGGER ARROWS FOR THE BIGGER SWING
     ==================================================================
     RULED: "larger arrows for critical bonus/malus animations and smaller arrows for minor bonus/malus
     animations, so that the information is scannable at a glance without having to read (once players are
     familiar with the system)."
     THE SIZE IS THE THIRD CHANNEL, and the ruling names exactly why it earns a place: colour says direction,
     the figure says magnitude, and the figure has to be READ. Size does not -- a player who has learnt the
     system takes "big green" as +20% before the numeral resolves, which is the whole point of a 700ms window.
     KEYED ON THE MAGNITUDE, NOT ON THE BUCKET NAME. `criticalBonus` and `criticalMalus` are the two 20%
     buckets, so `|delta| === 20` is the same test one step closer to the thing that matters -- and it stays
     right if a face is ever re-tabled, where a bucket-name check would have to be found and updated. */
  const critical = Math.abs(shown.delta) >= CRITICAL_SWING_PERCENT;
  const overlay = (
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
        zIndex: REVENUE_FLASH_Z_INDEX,
        opacity: visible ? 1 : 0,
        transition: `opacity ${REVENUE_FLASH_FADE_MS}ms ease-out`,
      }}
    >
      <style>{REVENUE_FLASH_ARROWS_CSS}</style>
      <style>{REVENUE_FLASH_GLOW_CSS}</style>
      {/* ==================================================================
           DESIGN NOTE 953: SIX ARROWS, AROUND THE FIGURE RATHER THAN ON IT
          ==================================================================
          RULED: "For bonuses (green), include subtle up-arrows floating upward around the text. For maluses
          (red), include down-arrows floating downward."
          POSITIONED RELATIVE TO THE FIGURE'S OWN BOX, which is why this wrapper is `position: relative` and
          the arrows are absolute inside it. Anchoring them to the VIEWPORT would scatter them to the screen
          edges on a wide monitor, where they stop being "around the text" at all.
          SIX, AT ASYMMETRIC OFFSETS AND STAGGERED DELAYS. An even spread on a regular beat reads as a loading
          spinner; the irregularity is what makes it read as drift. */}
      <span style={{ position: "relative", display: "inline-block" }}>
        {/* ==================================================================
             DESIGN NOTE 960: A GLOW IS NOT A BOX, AND THE DIFFERENCE IS THE EDGE
            ==================================================================
            ASKED: "It might help if the number and arrows had a brief background glow behind them as well?"
            IT DOES, AND IT HAS TO BE RECONCILED WITH #940 RATHER THAN SLIPPED PAST IT. That note ruled: "Do
            not put this in a box, pill, or standard toast notification window", and its test asserts the
            absence of `backgroundColor`, `borderRadius`, `boxShadow`, `border` and `padding`. A radial
            gradient would have sailed through every one of those on a technicality -- it sets `background`,
            not `backgroundColor` -- and doing it quietly is exactly the kind of thing that makes an absence
            test worthless.
            SO THE DISTINCTION IS STATED. What #940 forbids is a SURFACE: something with an edge, that the
            figure sits ON, that reads as a window laid over the board. This has no edge at any point -- the
            gradient reaches full transparency well inside its own box -- so there is nothing to read as a
            rim, and no rectangle appears at any opacity. It is the same family as the `textShadow` halo
            #940 explicitly kept, one step larger.
            AND IT EARNS ITS PLACE at 700ms: the overlay sits over a board that is yellow, green, grey and red
            by turns, and a green "+20%" over green track is the one case the halo alone struggles with. The
            glow is tinted to the OUTCOME, so it deepens the colour contrast rather than merely darkening.
            `closest-side` KEEPS IT CIRCULAR regardless of the figure's aspect -- a percentage would ellipse
            it into something that reads as a shape. */}
        <span
          aria-hidden="true"
          className="app-revenue-glow"
          style={{
            background: `radial-gradient(closest-side, ${
              bonus ? BONUS_GLOW : MALUS_GLOW
            }, rgba(0, 0, 0, 0) 70%)`,
          }}
        />
        {ARROW_POSITIONS.map((offset, index) => (
          <span
            key={index}
            aria-hidden="true"
            className="app-revenue-arrow"
            style={{
              left: offset.left,
              top: offset.top,
              color: bonus ? BONUS_COLOR : MALUS_COLOR,
              animationName: bonus ? "app-revenue-arrow-up" : "app-revenue-arrow-down",
              animationDelay: `${offset.delay}ms`,
              /* Design note #957: sized from the FIGURE's em, so the ratio holds at every viewport -- a fixed
                 px size would make the two tiers indistinguishable on a small screen and absurd on a large
                 one, which is the failure the `clamp` on the numeral already exists to avoid.
                 Design note #959: and multiplied per arrow, so the six are a spread rather than a set. */
              fontSize: `${
                (critical ? ARROW_BASE_EM.critical : ARROW_BASE_EM.minor) * offset.scale
              }em`,
            }}
          >
            {bonus ? "\u25B2" : "\u25BC"}
          </span>
        ))}
      <span
        className="app-revenue-figure"
        style={{
          /* Design note #954: "Slightly reduce the maximum font size." The ceiling comes down hardest --
             132px was set for a two-second read and is simply loud at 700ms -- and the floor with it, so the
             shape stays proportional on a narrow window instead of the range collapsing. */
          fontSize: "clamp(40px, 10vw, 104px)",
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
      </span>
    </div>
  );

  /* Design note #956: OUTSIDE THE APP SUBTREE. `document` is absent under SSR and can be absent in a bare
     test environment, so the portal is guarded rather than assumed -- rendering in place is a worse position
     and a working component; throwing is neither. */
  if (typeof document === "undefined" || !document.body) return overlay;
  return createPortal(overlay, document.body);
}
