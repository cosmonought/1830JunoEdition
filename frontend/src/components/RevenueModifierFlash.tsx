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
import {
  REVENUE_FLASH_ARROWS_CSS,
  REVENUE_FLASH_BACKDROP_CSS,
  REVENUE_FLASH_EDGE_CSS,
} from "../styles/animations";
// Design note #985: how much of its em a capital actually inks -- the conversion #972 was missing.
import { CAP_HEIGHT_RATIO } from "../styles/typography";

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
   ONE CONSTANT, so trying 500 or 800 is a one-line change and the test reads it rather than a copy.

   ==================================================================
    DESIGN NOTE 970: 850, AND NOW IT IS THE ONLY COPY OF THE NUMBER
   ==================================================================
   RULED: "The animation speed feels inconsistent when re-running a route via Undo. Hardcode the display
   duration to exactly 850ms so it is uniform in all contexts."
   THE INCONSISTENCY WAS REAL AND THIS CONSTANT WAS NEVER THE CAUSE. There were THREE durations, not one:
   this 700, `.app-revenue-arrow`'s own `animation-duration: 700ms` in the stylesheet, and
   `.app-revenue-glow`'s `700ms` inside a shorthand. Three literals that happened to agree, which is a
   coincidence rather than an invariant -- and the moment one moved, the text and its motion would run for
   different lengths and the overlay would read as a different speed depending on which one you noticed.
   SO THE STYLESHEET NO LONGER NAMES A DURATION AT ALL. The arrows and the edge flash take
   `animationDuration` inline from this constant, and the CSS owns the CURVE. One number, three surfaces,
   and "uniform in all contexts" becomes structural instead of a thing to keep checking.
   WHAT THIS DOES NOT EXPLAIN, said plainly: nothing here was ever per-CALLER, so an Undo re-run has always
   been handed the same figures as a first run. #971 is the change that actually accounts for a re-run
   looking different -- the second flash was playing no motion at all. */
export const REVENUE_FLASH_MS = 900;

/** How long the fade at the end takes, inside the two seconds rather than after them: "display for exactly 2
 *  seconds, then fade or disappear" -- so the text is legible for most of the window and gone at the end of
 *  it, rather than lingering to 2s plus a fade. */
export const REVENUE_FLASH_FADE_MS = 300;

/** How long the arrival takes.
 *
 *  ==================================================================
 *   DESIGN NOTE 999: THERE WAS NO FADE-IN AT ALL, AND #971 IS WHY
 *  ==================================================================
 *
 *  REPORTED: "The glow behind the juice notification ... seems to just appear on the screen instead of fading
 *  in and out" and then, more precisely, "the fade in may be happening, but it is very abrupt."
 *
 *  IT WAS NOT HAPPENING. The overlay's opacity has always been a CSS `transition`, which needs a previous
 *  value to move from -- and while the node stayed mounted between flashes it had one: `visible` went false,
 *  then true, and the browser animated between them. #971 made the overlay UNMOUNT after its window and
 *  remount on a changed key, and a freshly inserted element has no previous value. It commits at `opacity: 1`
 *  and there is nothing to transition. The fade-OUT still worked, which is exactly why this reads as "abrupt
 *  in, fine out" rather than as a missing feature.
 *  SO #971 FIXED THE ARROWS AND BROKE THE ARRIVAL, in the same edit and for the same reason. Worth recording
 *  plainly: remounting to replay an animation is the right tool, and it silently disables every transition on
 *  the node it remounts.
 *
 *  THE FIX IS A FIRST FRAME AT ZERO. The overlay now mounts transparent and is flipped opaque on the next
 *  animation frame, which gives the transition the previous value it needs. That is the standard enter
 *  transition and it is written out rather than reached for a library.
 *
 *  RISE AND FALL ARE SEPARATE CONSTANTS even though both are 300ms today, because they answer different
 *  questions -- how fast should this arrive, how slowly should it leave -- and juice conventionally moves
 *  fast in and slow out. Naming them apart is what makes trying that a one-line change. */
export const REVENUE_FLASH_RISE_MS = 300;

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
 * named rather than inline so the two can be compared without reading two files.
 *
 * ==================================================================
 *  DESIGN NOTE 970a: REPORTED AGAIN, AND THE FIX ASKED FOR WAS ALREADY IN
 * ==================================================================
 *
 * REPORTED: "The notification is being hidden/overlapped by the sticky Action Bar. Break the overlay out
 * using an absolute top-level `z-index` (or a React portal)."
 *
 * BOTH OF THOSE ARE WHAT THIS FILE ALREADY DOES, and I went looking for a mechanism a third time rather than
 * writing the same fix twice. What I checked, so the next person does not repeat it:
 *   - EVERY `zIndex` IN THE APP. The highest anywhere in `src` is 4000; nothing beats 9000, and nothing sets
 *     one from a variable except this file.
 *   - THE PORTAL'S ANCESTORS. `createPortal` targets `document.body`, whose only styling is the three lines
 *     in `public/index.html` -- `margin`, `font-size`, `line-height`. No `transform`, `filter`, `contain` or
 *     `will-change` on `html` or `body`, and nothing anywhere writes `document.body.style`. That matters
 *     specifically: a containing block on BODY would make `position: fixed` resolve against the whole
 *     scrollable document instead of the viewport, which is the one arrangement that would centre this
 *     overlay somewhere other than the middle of the screen. It is not present.
 *   - THE APPEND ORDER. A body portal mounts last, so it is after `#root` in paint order as well as above it.
 *
 * SO I CANNOT REPRODUCE THE OCCLUSION FROM THE SOURCE, and the honest reading is that what was seen was
 * #971: from the second flash of a session onward the arrows and the glow did not play, so the overlay
 * arrived as a bare numeral with no motion and nothing around it. That is a very reasonable thing to
 * describe as being hidden. #971 is the change; this note is here so the portal is not "fixed" a third time.
 *
 * WHAT DID CHANGE HERE is that the overlay no longer OUTLIVES its own window -- see the effect below. It
 * used to stay mounted forever at `opacity: 0`, which left a full-viewport node at z-index 9000 over the
 * whole app between runs. It could not swallow a click (`pointer-events: none`), so this is not the report's
 * cause either -- but a permanent invisible sheet over everything is worth not having. */
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
  /** ==================================================================
   *   DESIGN NOTE 1095: TELL THE CALLER WHEN IT IS SAFE TO FORGET
   *  ==================================================================
   *
   * REPORTED: "the app erroneously replays the last visual animation ... ensure the React state cleanup
   * applies globally across all subphase mounts."
   *
   * `revenueFlash` WAS THE ONE EPHEMERAL SIGNAL IN THE SHELL THAT WAS NEVER CLEARED. Every other one has a
   * way home -- the toast has `onDismiss`, the money machine `onMoneyMachineDone`, the private payout
   * `onAcknowledge`, the haunting its own timer -- and this one was set and left set for the rest of the
   * session. So the LAST flash of the game sat in `App` state permanently, and anything that remounted this
   * component found a non-null `signal` waiting and played it again. That is a different mechanism from the
   * replay guard #1094 added: the guard stops a REBUILD from re-firing the signal, and this stops a stale
   * signal from being re-consumed by a fresh mount. Both had to be true, which is why fixing one left a
   * report open.
   *
   * THE COMPONENT OWNS THE TIMING, so the component says when it is done -- fired at the same moment it
   * clears its own `shown`, not on a second timer in the caller that would have to agree with these two
   * (#891). A caller that clears earlier would truncate the fade; one that clears later leaves the window
   * this note exists to close. */
  onDone?: () => void;
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
  /* ==================================================================
      DESIGN NOTE 972: PUSHED OUT, BECAUSE THEY GOT BIGGER
     ==================================================================
     THESE OFFSETS ARE PERCENTAGES OF THE FIGURE'S OWN BOX, so they are a position and not a distance -- and
     enlarging the glyphs by two thirds without moving them would have walked the two inner arrows straight
     over the numeral. The spread widens by roughly the same factor the type does; the ASYMMETRY and the
     staggered delays are #953's and are deliberately preserved, since an even ring on a regular beat is the
     loading-spinner reading that note exists to avoid. */
  { left: "-32%", top: "6%", delay: 0, scale: 0.85 },
  { left: "-6%", top: "-46%", delay: 90, scale: 0.15 },
  { left: "34%", top: "58%", delay: 40, scale: 0.55 },
  { left: "70%", top: "-42%", delay: 150, scale: 0.3 },
  { left: "104%", top: "10%", delay: 70, scale: 1 },
  { left: "124%", top: "-26%", delay: 120, scale: 0.45 },
];

/* ==================================================================
 *  DESIGN NOTE 985: THE SIZE IS A BAND NOW, AND THE `scale` IS A POSITION INSIDE IT
 * ==================================================================
 *
 * RULED: "Increase their size by at least 10x. The large/critical arrows must be 60-80% of the size of the
 * number text, and the small/minor arrows must be 30-50%."
 *
 * THE TWO HALVES OF THAT DISAGREE, AND THE BAND IS THE HALF I FOLLOWED. Ten times #972's sizing would put a
 * single arrow at five and a half times the height of the numeral it decorates; the percentages are the
 * checkable instruction and they are what the code now expresses. Said plainly rather than quietly split,
 * because "10x" is a real perception and the band is where I think it came from -- see below.
 *
 * WHY THEY LOOKED SO MUCH SMALLER THAN THEIR NUMBERS SAID. #972 set a FONT SIZE, and a font size is not a
 * drawn height: U+25B2 fills roughly seven tenths of its em box, while the numeral beside it is measured by
 * its cap height, about `CAP_HEIGHT_RATIO` of ITS em. So an arrow at `0.55em` drew at about 0.385em against a
 * numeral drawing at 0.72em -- 53% where the note claimed 55%, and the smallest of the six landed near 37%.
 * Every figure in that note was about a box nobody can see. This one converts, once, in a named constant.
 *
 * THE BAND COSTS THE SPREAD SOME OF ITS RANGE, and that is worth naming as a trade rather than discovering
 * later. #959 ruled the six arrows "a mix of sizes ... They shouldn't all be one size", and its harness
 * asserted the largest was at least 1.5x the smallest. A band of 60-80% cannot hold a 1.5x ratio -- its own
 * extremes are 1.33x apart. So the mix is narrower than it was, by arithmetic rather than by choice, and the
 * harness's ratio assertion moves with it.
 *
 * `scale` IS A POSITION FROM 0 TO 1 ACROSS THE BAND, not a multiplier on a base. Written that way, "every
 * arrow is inside the ruled range" is true by construction rather than by six separate checks -- and a future
 * edit that widens the mix cannot silently walk an arrow out of the band. */
const ARROW_BAND = {
  critical: { low: 0.6, high: 0.8 },
  minor: { low: 0.3, high: 0.5 },
} as const;

/** How much of its own em U+25B2 actually inks, near enough for sizing.
 *
 *  A MEASURED PROPERTY OF THE GLYPH, not a taste. It sits beside `CAP_HEIGHT_RATIO` in spirit -- both are
 *  "how tall is the thing you can see, given a font size" -- and it is here rather than in `typography.ts`
 *  because it is a fact about ONE character rather than about the type scale. If a second surface ever draws
 *  this triangle, that is the moment to move it. */
const ARROW_GLYPH_RATIO = 0.7;

const BONUS_COLOR = "#4ade80";
const MALUS_COLOR = "#f87171";
/* ==================================================================
    DESIGN NOTE 1065: THE THIRD OUTCOME GETS A COLOUR THAT CLAIMS NOTHING
   ==================================================================
   REPORTED: "When the variant rolls an unchanged revenue state (0% modifier), cleanly flash the screen white
   and briefly display a `+0%` or `Unchanged` indicator to confirm the roll was executed."
   AND THE COMPLAINT BEHIND IT IS THAT SILENCE LOOKS LIKE FAILURE. A player who sees nothing cannot tell an
   unchanged roll from a variant that did not fire, and a third of the die's faces are unchanged -- so the
   commonest single outcome was the one with no confirmation.
   WHITE BECAUSE IT IS NOT A DIRECTION. Green rises and red falls (#973); a third hue on that axis would
   invite the reader to ask which way it points. White is the absence of the claim, which is exactly what an
   unchanged roll is. */
const NEUTRAL_COLOR = "#2a2a2a";
const NEUTRAL_EDGE = "rgba(244, 246, 251, 0.42)";

/* ==================================================================
    DESIGN NOTE 973: THE GLOW LEFT THE TEXT AND WENT TO THE EDGE
   ==================================================================
   RULED: "Remove the text glow and replace it with a brief screen-border glow/flash (green for bonus, red
   for malus) that matches this 850ms duration."
   AND IT SETTLES SOMETHING #960 LEFT UNCOMFORTABLE. That note spent a paragraph arguing that a radial
   gradient behind the numeral was "not a box" on the grounds that it has no edge -- true, and it was
   arguing the point at all because the thing was sitting exactly where #940 ruled nothing may sit. A flash
   at the VIEWPORT's rim is not in that argument's territory at all: it is nowhere near the figure, so
   "floating text ONLY" is satisfied by construction rather than by a distinction about rims.
   IT ALSO DOES THE JOB BETTER THAN THE THING IT REPLACES. #960's glow existed to lift a green "+20%" off
   green track -- it was a legibility patch on a contrast problem, and it worked by putting more of the
   figure's own hue directly behind the figure, which is the least effective place to put it. The board is
   never the screen's edge, so the same hue at the rim carries the direction cue without competing with the
   numeral for the same pixels.
   THE BLACK HALO ON THE TEXT STAYS. That is `textShadow`, it is what #364 uses on the hex badge, and it is
   doing the legibility work over a four-coloured board -- "the text glow" being removed here is #960's
   coloured field, not the shadow that makes the numeral readable at all.
   ALPHA 0.45 RATHER THAN #960's 0.28. A vignette is spread over the whole rim at low blur density, where
   the radial sat concentrated behind two glyphs; the same alpha would read as a smudge rather than a
   flash. */
const BONUS_EDGE = "rgba(74, 222, 128, 0.45)";
const MALUS_EDGE = "rgba(248, 113, 113, 0.45)";

/** The backdrop's two stops, ruled: "70% opacity at its center and fade out completely to 0% at its edges".
 *
 *  Design note #986: CREAM RATHER THAN WHITE, and the difference is small and deliberate. Pure white behind a
 *  green "+20%" reads as a lit panel; `#fffaf0` is the warm near-white this app's cards are already made of
 *  (`palette.ts`'s `CARD_SURFACE`), so the backdrop reads as paper the figure is printed on rather than as a
 *  second light source competing with the rim flash.
 *  BOTH STOPS ARE THE SAME INK AT DIFFERENT ALPHAS. Fading to `transparent` rather than to `rgba(...,0)` is
 *  the classic gradient bug -- several engines interpolate the keyword through transparent BLACK, which puts
 *  a grey halo between the two stops on exactly the surface this is meant to brighten. */
const BACKDROP_INK = "rgba(255, 250, 240, 0.7)";
const BACKDROP_FADE = "rgba(255, 250, 240, 0)";

export function RevenueModifierFlash({
  signal,
  onDone,
}: RevenueModifierFlashProps): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState<RevenueFlashSignal | null>(null);

  useEffect(() => {
    if (!signal) return undefined;
    /* HELD IN LOCAL STATE so the text does not vanish the instant the caller clears its signal -- the
       component owns the two seconds, and a parent that cleared early would truncate them. */
    setShown(signal);
    /* Design note #999: MOUNTED TRANSPARENT, THEN FLIPPED ON THE NEXT FRAME. Setting `visible` true here
       would commit the new node already opaque and the transition would have nothing to move from -- which
       is precisely the bug this fixes. The `false` is not redundant: a re-trigger during the previous
       flash's fade arrives with `visible` already false, and the frame callback is what restarts the rise. */
    setVisible(false);
    const rise = window.requestAnimationFrame(() => setVisible(true));
    const timer = window.setTimeout(() => setVisible(false), REVENUE_FLASH_MS);
    /* ==================================================================
        DESIGN NOTE 971: AND THEN IT LEAVES, WHICH IS HALF THE BUG
       ==================================================================
       THE OVERLAY USED TO STAY MOUNTED FOR THE REST OF THE SESSION at `opacity: 0`. That is what made the
       reported fault possible: `.app-revenue-arrow` and the old glow both carry `animation-fill-mode:
       forwards` with `iteration-count: 1`, so on the second flash the SAME DOM nodes were still sitting on
       their final keyframe -- opacity 0, translated 46px away -- and a CSS animation does not replay because
       a parent re-rendered. The numeral kept appearing because its own keyframe ends at `opacity: 1`; the
       arrows ended at 0. Exactly the report: "they fail to appear at all after the first time."
       CLEARED AFTER THE FADE, NOT AT THE WINDOW. `setVisible(false)` starts a `REVENUE_FLASH_FADE_MS`
       opacity transition, and unmounting at `REVENUE_FLASH_MS` would cut it off -- the overlay would blink
       out rather than fade, which is the one visible way this fix could go wrong. */
    const clear = window.setTimeout(() => {
      setShown(null);
      /* Design note #1095: AFTER `setShown`, deliberately. The caller answers this by clearing the signal,
         which re-runs this effect and tears down these timers -- harmless once they have all fired, and a
         frozen overlay if it happened while one was still pending. */
      onDone?.();
    }, REVENUE_FLASH_MS + REVENUE_FLASH_FADE_MS);
    return () => {
      window.cancelAnimationFrame(rise);
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
    // Design note #940: the TOKEN is the dependency, not the delta -- see `RevenueFlashSignal`.
  }, [signal?.token, signal, onDone]);

  if (!shown) return null;

  const bonus = shown.delta > 0;
  /* ==================================================================
      DESIGN NOTE 1065: `bonus` WAS A BOOLEAN OVER A THREE-WAY OUTCOME
     ==================================================================
     `delta > 0` MADE ZERO A MALUS. Every branch below reads `bonus ? green : red`, so a neutral roll arriving
     here before this batch would have flashed red with six falling arrows and printed `-0%` -- which is why
     the caller suppressed it entirely rather than letting it through. That suppression was the reported gap.
     THE ARROWS GO, AND ONLY FOR THIS OUTCOME. #953 put them there to say direction ("up-arrows floating
     upward" for a bonus, down for a malus); an unchanged roll has no direction, and six drifting triangles
     that mean nothing are worse than none. The figure and the rim carry the confirmation.
     THE FIGURE READS `+0%`, ON INSTRUCTION AND OVER MY OWN SUGGESTION. I proposed "Unchanged", because
     `revenueOutcome` returns `"normal"` both for a die that rolled 100% and for a 90% roll the rounding
     swallowed, and "+0%" is literally true only of the first. RULED: "Players don't know the difference
     between roll3/roll4 and a 10% malus that rounded back up: for them the end result is +0%, so it's okay
     to print that." Which is right, and is the better reading of #938 rather than a departure from it: that
     note forbids the flash claiming a modifier the corporation did not FEEL, and `+0%` claims the opposite of
     one. The nominal swing is the thing that must never appear here, and it does not -- the caller passes a
     hard zero for this branch (`App.tsx` #1065) rather than `percent - 100`. */
  const neutral = shown.delta === 0;
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
      /* ==================================================================
          DESIGN NOTE 971: A KEY ON THE TRIGGER, SO EVERY ANIMATION STARTS OVER
         ==================================================================
         RULED: "Ensure the animation state/keyframe fully resets (e.g., via a React `key` tied to the
         trigger token) so the arrows reliably appear on every single trigger."
         THIS IS THE MECHANISM ASKED FOR AND IT IS THE RIGHT ONE. A changed key makes React destroy the
         subtree and build a new one, and a freshly-inserted element runs its animations from 0% -- which is
         the only way to replay a CSS animation without a class toggle, a forced reflow read and a cleanup.
         #597 settled the identical question the identical way for the turn-handoff band: "Replayed by
         REMOUNTING -- the band carries `key={acting seat}`."
         BELT AND BRACES WITH THE UNMOUNT ABOVE, deliberately. The unmount handles the ordinary case; this
         handles the one it cannot -- a second turn's flash arriving DURING the previous one's fade, when the
         node is still mounted and mid-animation. Two trains rolling in quick succession is exactly the case
         #940's token was invented for, so it would be odd to fix the common path and leave that one.
         ON THE WHOLE OVERLAY RATHER THAN ON THE ARROWS. The figure's entrance, the edge flash and the six
         arrows are three animations that must start together; keying only the list would replay one of the
         three and leave the reported symptom half-fixed. */
      key={shown.token}
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
        /* Design note #999: the duration follows the DIRECTION. React writes the style for the state being
           entered, so a rise reads `REVENUE_FLASH_RISE_MS` and a fall reads `REVENUE_FLASH_FADE_MS` -- which
           is what lets the two be tuned apart without a second element or a keyframe. */
        transition: `opacity ${visible ? REVENUE_FLASH_RISE_MS : REVENUE_FLASH_FADE_MS}ms ease-out`,
      }}
    >
      <style>{REVENUE_FLASH_ARROWS_CSS}</style>
      <style>{REVENUE_FLASH_EDGE_CSS}</style>
      <style>{REVENUE_FLASH_BACKDROP_CSS}</style>
      {/* Design note #973: THE SCREEN'S RIM, tinted to the outcome. `currentColor` is what keeps the
          `box-shadow` geometry in the stylesheet and the COLOUR here beside `BONUS_COLOR`/`MALUS_COLOR` --
          one decision about which hue means what, in one file, rather than a second green written into CSS.
          `animationDuration` INLINE, from #970's constant: the stylesheet names no duration at all now, so
          the edge, the arrows and the timer cannot come to disagree about how long this lasts. */}
      <span
        aria-hidden="true"
        className="app-revenue-edge"
        style={{
          color: neutral ? NEUTRAL_EDGE : bonus ? BONUS_EDGE : MALUS_EDGE,
          animationDuration: `${REVENUE_FLASH_MS}ms`,
        }}
      />
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
             DESIGN NOTE 986: A GLOW BEHIND THE FIGURE, BACK, AND IN A DIFFERENT COLOUR
            ==================================================================
            RULED: "The number is getting lost against the map and the Action Bar ... render a white/cream
            radial gradient glow strictly behind the number and arrows. This radial glow should be 70%
            opacity at its center and fade out completely to 0% at its edges."
            THIS REVERSES HALF OF #973 AND I WANT THAT ON THE RECORD rather than quietly re-landed. #960 put
            a glow here, #973 took it to the screen's rim and argued the rim was the better home "from a
            place the board never occupies". That argument was about the DIRECTION cue and it still holds --
            the rim flash stays, green or red, and is untouched. What it got wrong is that it treated one
            element as doing two jobs. #960's glow was ALSO doing legibility work directly behind the
            glyphs, and moving it to the rim left the numeral with nothing behind it but a black text-shadow
            over a board of four colours and a sticky bar. That is the report.
            AND THE COLOUR IS WHY THE TWO CAN COEXIST NOW. #960's glow was tinted to the OUTCOME, so keeping
            it alongside a tinted rim would have been the same hue twice for one fact -- #973's actual
            objection. A neutral cream says nothing about direction; it only lifts. Two elements, two jobs,
            no overlap.
            `ellipse` RATHER THAN #960's CIRCLE. The thing being backed is wider than it is tall -- a
            percentage plus six arrows spread from -32% to 124% -- and `closest-side` on a circle would size
            to the SHORT axis and leave the outer arrows outside the glow entirely.
            `z-index: -1` INSIDE THIS WRAPPER is what "strictly behind" means mechanically: the numeral and
            every arrow are siblings in the same stacking context, so one negative index puts the backdrop
            under all of them without needing an index of its own on each. */}
        <span
          aria-hidden="true"
          className="app-revenue-backdrop"
          style={{
            background: `radial-gradient(ellipse closest-side, ${BACKDROP_INK} 0%, ${BACKDROP_FADE} 100%)`,
          }}
        />
        {(neutral ? [] : ARROW_POSITIONS).map((offset, index) => (
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
              /* Design note #970: the duration comes from the constant, not from a second copy in the
                 stylesheet. `.app-revenue-arrow` used to carry its own `animation-duration: 700ms`. */
              animationDuration: `${REVENUE_FLASH_MS}ms`,
              /* Design note #957: sized from the FIGURE's em, so the ratio holds at every viewport -- a fixed
                 px size would make the two tiers indistinguishable on a small screen and absurd on a large
                 one, which is the failure the `clamp` on the numeral already exists to avoid.
                 Design note #959: and varied per arrow, so the six are a spread rather than a set.
                 Design note #985: the arithmetic, in the order it reads. `share` is the fraction of the
                 NUMERAL'S DRAWN HEIGHT this arrow should draw at -- the thing the ruling specifies. Multiply
                 by `CAP_HEIGHT_RATIO` to turn that into a fraction of the numeral's em, then divide by the
                 glyph's own fill to get the font size that draws it. Two conversions, both named, because
                 #972 skipped them and its every stated percentage was about an invisible box. */
              fontSize: `${
                (((critical ? ARROW_BAND.critical : ARROW_BAND.minor).low +
                  ((critical ? ARROW_BAND.critical : ARROW_BAND.minor).high -
                    (critical ? ARROW_BAND.critical : ARROW_BAND.minor).low) *
                    offset.scale) *
                  CAP_HEIGHT_RATIO) /
                ARROW_GLYPH_RATIO
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
          color: neutral ? NEUTRAL_COLOR : bonus ? BONUS_COLOR : MALUS_COLOR,
          /* THE HALO AGAIN, for the reason #364 gives on the hex badge: this text floats over a board that is
             yellow, green, grey and red by turns, and a plate is exactly what was ruled out. A shadow costs no
             footprint and keeps it legible over all of them. */
          textShadow: "0 2px 18px rgba(0, 0, 0, 0.85), 0 0 3px rgba(0, 0, 0, 0.9)",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {/* Design note #1065: `+` for a neutral roll as well as for a bonus -- ruled, and true of the
            outcome rather than of the die. A bare `0%` reads as a missing sign. */}
        {bonus || neutral ? "+" : "-"}
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
