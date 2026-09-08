// frontend/src/components/YellowSignOverlay.tsx
//
// ==================================================================
//  DESIGN NOTE 1043: A HAUNTING YOU CAN PLAY THROUGH
// ==================================================================
//
// RULED: "they must appear centered over the UI. Ensure the video container has `pointer-events: none;` so it
// does not block interaction while playing for the full 10000ms, and `mix-blend-mode: screen;` so the black
// background of the videos renders completely transparent over the game board."
//
// AND THE DURATION IS WHY BOTH OF THOSE ARE LOAD-BEARING. Ten seconds was reached deliberately -- "a slow,
// lingering 10-second haunting is going to feel incredibly unsettling and impactful compared to a quick
// flash" -- and ten seconds is also long enough that a player WILL try to act during it. A quarter-second
// flash that ate a click would be a curiosity; this would be a turn.
//
// `mix-blend-mode: screen` IS WHAT MAKES THE CLIP AN OVERLAY RATHER THAN A WINDOW. The videos are drawn on
// black, and screen blending maps black to transparent -- so the sign appears over the board instead of in a
// rectangle cut out of it. It is on the VIDEO rather than the container: a blended container would also blend
// its own (absent) background, and browsers differ about what that means.
//
// ==================================================================
//  DESIGN NOTE 1045: THE CLIP SPEAKS, AND #1043 SAID IT SHOULD NOT
// ==================================================================
//
// #1043 MUTED THIS DELIBERATELY, so the only sound came through `playVariantCue` and therefore through the
// ducking and the SFX mute. RULED SINCE: "unmuted so its built-in audio layers with the MP3 string" -- the
// layering IS the effect, and muting it threw away half the haunting to keep an invariant tidy.
//
// SO IT PLAYS ALOUD, WITH THE TWO CONSEQUENCES HANDLED RATHER THAN ACCEPTED:
//   THE SFX MUTE STILL WINS. `muted` follows the player's toggle, so a muted table gets a silent film rather
//   than a video that ignores the one control the audio settings offer. A clip that shouted through a mute
//   would be the feature disrespecting a setting, which is worse than a quieter Easter egg.
//   THE RADIO STILL DUCKS. The caller holds a duck for the clip's full ten seconds (#1041), because the video
//   element is outside the concurrency-and-ducking path entirely and would otherwise play over the bed at
//   full volume -- the exact thing #1043 was avoiding by muting it.
//
// AUTOPLAY IS THE RISK WORTH NAMING. Browsers allow muted autoplay unconditionally and gate unmuted autoplay
// on user activation. This fires immediately after the player submits routes, so activation is present and it
// plays -- but a client that somehow reaches this without a click gets a silent video rather than a throw,
// which is the harmless direction and the same one `playQuietly` chooses (#1009).
//
// UNMOUNTED WHEN IDLE rather than hidden. A `<video>` left mounted with `display: none` keeps its decoder
// alive, and this one is on screen for ten seconds once or twice a game.
//
// ==================================================================
//  DESIGN NOTE 1093: TWO CLIPS FLOAT ON BLACK; THE THIRD IS MADE OF FOG
// ==================================================================
//
// THE FOG CLIP BREAKS #1043's ONE ASSUMPTION. `mix-blend-mode: screen` is not a style choice, it is a keying
// technique, and it only keys clips shot bright-on-black. `carcosan-train.mp4` is a gold train receding into
// bright fog -- mean luma 134 to 160 across its six seconds, measured with `ffprobe` rather than eyeballed.
// Screen blending KEEPS the bright pixels, so the fog would survive as a near-white slab over the board and
// the train, the darkest thing in frame, would be the part that vanished. The clip would erase the picture it
// was added to show.
//
// SO THERE ARE TWO COMPOSITES, chosen by the cue (`variantSfx.ts` #1093) rather than derived from the file:
//
//   "screen"    #1043's treatment, untouched. Black keys out, the figure floats, no fade.
//   "feather"   No blend mode at all. The rectangle's edges are dissolved into transparency with a radial
//               mask and the whole clip fades up and back down, so it reads as fog rolling over the table
//               rather than as a video player that opened on top of it.
//
// WHY A MASK RATHER THAN A BLEND. The problem `screen` solves for the other two is "this clip is a rectangle
// and the board is behind it". A radial alpha mask solves the same problem the other way: instead of keying a
// colour, it removes the EDGES, which is where a rectangle announces itself. The centre stays fully opaque,
// so the train is at full contrast where it matters, and there is no hard border anywhere.
//
// WHY THE FADE IS ONE ANIMATION ACROSS THE WHOLE WINDOW rather than an enter and an exit. The overlay is
// unmounted by the caller's timer (#1040's `videoMs`), and an exit transition on an unmounting element does
// not run -- it would need a second delayed unmount and two timers that must agree, which is #891's shape.
// One keyframe set spanning the clip, driven by `animationDuration`, has no second timer to disagree with.
//
// IT IS 88vw, NOT 72vw, AND THAT IS DELIBERATE. Considered a full-viewport wash, which was the instinct
// -- nobody is deciding anything while it plays. Rejected on two measurements: `objectFit: cover` on a 16:9
// clip in a tall window crops horizontally from centre, and the locomotive sits in the right third of the
// frame, so a narrow window would crop away the subject; and a full-bleed wash needs low opacity to stay
// readable, at which point a bright-fog clip over a #1b1f29 board flattens into grey haze and the gold train
// -- the smallest, most detailed thing in frame -- is the first element lost. Bigger than the hauntings,
// still contained.

import React from "react";
// Design note #1144: the chrome's scale, so this layer can divide back out of it.
/* Design note #1294: the chrome scale, live, for the counter-zoom. */
import { useUiScale } from "../utils/useUiScale";

/** Which of the two treatments a clip needs. Design note #1093: a property of how the clip was shot. */
export type HauntingComposite = "screen" | "feather";

export interface YellowSignOverlayProps {
  /** The clip to play, or `null` when nothing is haunting anybody. */
  src: string | null;
  /** Design note #1045: the player's SFX toggle. The clip is unmuted so its audio layers with the MP3, and
   *  muted anyway when the table has asked for silence. */
  sfxEnabled: boolean;
  /** ==================================================================
   *   DESIGN NOTE 1093: NOT DEFAULTED, FOR `CarcosaMark` #1091's REASON
   *  ==================================================================
   *
   * A default would be silently wrong on whichever clip did not think about it, and wrong here means the
   * clip erases the board rather than floating over it. There is one caller and two answers. */
  composite: HauntingComposite;
  /** The window the caller is holding this open for, in ms -- the same number it will unmount on.
   *
   *  Design note #1093: used only by "feather", to span its fade across the clip. Passed rather than
   *  hard-coded because the two treatments already have different durations (10000 and 6042) and a third
   *  clip would have a third. */
  ms: number;
  /** ==================================================================
   *   DESIGN NOTE 1260: A LATE VIEWER JOINS THE HAUNTING WHERE IT IS
   *  ==================================================================
   *  RULED (2.4 of the 7 September plan): the clip plays on the Rail Map viewport only, for whoever is
   *  looking at it. So the overlay can now MOUNT PART-WAY through the caller's window -- a player who
   *  switches to the map five seconds in. `startedAt` is the caller's `performance.now()` at dispatch; the
   *  clip seeks to the elapsed offset on mount, so it ends when the window ends rather than being cut off
   *  at the caller's timer with the figure half-drawn. Optional: absent means "start from the top". */
  startedAt?: number;
}

export function YellowSignOverlay({ src, sfxEnabled, composite, ms, startedAt }: YellowSignOverlayProps) {
  const uiScale = useUiScale();
  if (!src) return null;
  const feathered = composite === "feather";
  /* Design note #1260: a negative delay starts the fog's fade part-way through, matching the seek. */
  const elapsedMs = startedAt === undefined ? 0 : Math.max(0, performance.now() - startedAt);
  return (
    <div
      style={{ ...styles.container, zoom: 1 / uiScale, ...(feathered ? null : styles.containerScreened) }}
      aria-hidden="true"
    >
      {feathered ? <style>{FOG_CSS}</style> : null}
      <HauntingVideo
        key={src}
        className={feathered ? "app-haunting-feather" : undefined}
        style={{
          ...styles.video,
          ...(feathered ? styles.videoFeathered : styles.videoScreened),
          ...(feathered
            ? { animationDuration: `${ms}ms`, animationDelay: `-${Math.round(elapsedMs)}ms` }
            : null),
        }}
        src={src}
        muted={!sfxEnabled}
        startedAt={startedAt}
      />
    </div>
  );
}

/* ==================================================================
    DESIGN NOTE 1260: THE BOX WAS THE BLEND NOT HAPPENING, AND THE EMPTY BOX WAS AUTOPLAY
   ==================================================================
   REPORTED THREE TIMES: "Yellow Sign video has a black box" (22a), "Carcosa Awaits video has a black box"
   (22d), and from the other seat: "their screen showed the black box but no video."
   THE CLIPS ARE INNOCENT. Both are pure black at the corners -- sampled with ffmpeg, (0,0,3) and (1,0,2) --
   so `screen` would key them out perfectly IF IT WERE BLENDING AGAINST THE BOARD. It was not. #1043 put the
   blend on the `<video>` and the container is `position: fixed` with a `z-index`, which makes the container
   a STACKING CONTEXT -- and an element blends only with the content of the stacking context it belongs to.
   Inside the container there is nothing under the video, so it screened against transparency, which is the
   identity: the black stayed black. A rectangle of the clip's own background, exactly as reported.
   THE BLEND MOVES TO THE CONTAINER. A blended stacking context is composited as a group against ITS parent's
   backdrop, which is the page -- board, panels, whatever tab is up. #1043's worry about "blending its own
   (absent) background" is the reason it is safe rather than a reason against: an absent background is
   transparent, and transparent screened over anything is that thing.
   THE EMPTY BOX IS A SEPARATE FAULT. #1045 unmutes the clip and #1043's own note names the risk: unmuted
   autoplay wants user activation, and the seat that did NOT just click Submit may not have it. Chrome then
   rejects `play()` and leaves the element on its poster -- a black frame, now un-keyed by the fault above.
   The fix #1043 described ("gets a silent video rather than a throw") was never written; it is now:
   `play()` is called by hand, and a rejection retries muted. The film is the effect; its dialogue is a
   bonus that a browser policy may withhold from one seat.
   AND NOTHING PAINTS BEFORE THE FIRST FRAME. `visibility: hidden` until `playing`, so a slow fetch on a
   client that has never seen the file shows the board rather than a placeholder. `visibility` rather than
   `opacity`, because the fog clip's fade animates `opacity` and an inline value would fight it. */
function HauntingVideo({
  startedAt,
  muted,
  style,
  ...rest
}: React.VideoHTMLAttributes<HTMLVideoElement> & { startedAt?: number }) {
  const ref = React.useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = React.useState(false);

  React.useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (startedAt !== undefined) {
      const elapsed = Math.max(0, performance.now() - startedAt) / 1000;
      if (elapsed > 0.05) video.currentTime = elapsed;
    }
    let cancelled = false;
    const attempt = video.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => {
        if (cancelled) return;
        video.muted = true;
        video.play().catch(() => undefined);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [startedAt]);

  return (
    <video
      ref={ref}
      style={{ ...style, visibility: playing ? "visible" : "hidden" }}
      muted={muted}
      playsInline
      /* `autoPlay` is gone: the effect above calls `play()` so the rejection is observable. */
      onPlaying={() => setPlaying(true)}
      /* NOT LOOPED. The caller owns the ten seconds (#1040's `videoMs`); a clip that looped would keep
         going if that timer were ever missed, and a clip shorter than the window simply ends early and
         leaves the overlay transparent -- which is the harmless direction. */
      loop={false}
      {...rest}
    />
  );
}

export default YellowSignOverlay;

/* Design note #1093: the fade, and the reduced-motion answer.
   NO BACKTICKS IN THIS BLOCK. It lives inside a template literal, which is `animations.ts` #755's trap and
   the fourth time I have walked into it -- the string terminates at the first one and tsc reports the error
   somewhere else entirely.
   THE PERCENTAGES ARE PROPORTIONS, not milliseconds, so one keyframe set serves any `animationDuration`: up
   over the first 8% (about 490ms at 6100), hold, and back down over the last 12% (about 730ms), which is
   slower going than coming because fog thins more slowly than it arrives.
   REDUCED MOTION KEEPS THE CLIP AND LOSES THE FADE, the same rule the toast, the cash badge and the money
   machine all follow (#606): the information is the picture, never the movement. It does NOT drop to
   `animation: none`, which would leave `opacity` at its unanimated default -- fine here, since that default
   is 1 and the clip simply cuts in and out, which is exactly what "no motion" should mean. */
const FOG_CSS = `
@keyframes app-haunting-fog {
  0%   { opacity: 0; }
  8%   { opacity: 1; }
  88%  { opacity: 1; }
  100% { opacity: 0; }
}
.app-haunting-feather {
  animation-name: app-haunting-fog;
  animation-timing-function: ease-in-out;
  animation-fill-mode: both;
}
@media (prefers-reduced-motion: reduce) {
  .app-haunting-feather { animation: none; }
}
`;

/** Design note #1093: one string, used twice -- prefixed and not. Written once so the two cannot drift. */
const FOG_MASK =
  "radial-gradient(ellipse closest-side at 56% 50%," +
  " rgba(0,0,0,1) 62%, rgba(0,0,0,0.9) 76%, rgba(0,0,0,0) 100%)";

const styles: Record<string, React.CSSProperties> = {
  container: {
    /* ==================================================================
        DESIGN NOTE 1144: ART AT VIEWPORT SIZE OPTS OUT OF THE CHROME'S ZOOM
       ==================================================================
       The shell's root carries `zoom: UI_SCALE` so the game room's CHROME draws at the size the player was
       reaching for the browser's zoom control to get.
       AN EARLIER DRAFT OF THIS NOTE SAID `inset: 0` WOULD STOP MEANING "THE VIEWPORT". IT WAS WRONG: measured
       in Chrome 148, a fixed layer inside `zoom: 0.7` still comes back the full size of the window, because
       the containing block a fixed element gets is itself zoom-adjusted.
       WHAT THE MEASUREMENT DID FIND IS THIS SURFACE'S ACTUAL PROBLEM -- `vw` and `vh` DO scale. A `100vh` box
       inside `zoom: 0.7` measures 560px on an 800px window, so #73's carefully argued `88vw` sign would have
       been drawn at 62vw and the caps below it at 50vh, quietly undoing the one decision that note explains
       at length.
       COUNTER-ZOOMED RATHER THAN MOVED OUT OF THE TREE, which was the alternative: a portal would work and
       would put this layer somewhere a reader does not expect to find it. `1 / UI_SCALE` is the same idiom
       `boardPane` uses, and for the same reason -- this is ART sized to the window, not chrome sized to the
       reader.
       THE MODALS ARE DELIBERATELY NOT DOING THIS. A confirm dialog is chrome and should shrink with the rest
       of it; only the surfaces that are pictures at viewport size are exempt. */
    /* Design note #1294: `zoom` is written per render as `1 / useUiScale()`. */
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    /* THE RULED PROPERTY, and the one this component would be a bug without. Ten seconds of a full-viewport
       fixed element that swallowed clicks would take a turn away from whoever triggered it. */
    pointerEvents: "none",
    /* Above the board and the panels, below nothing that matters -- a modal that opened during the haunting
       should still be reachable, and it would be at a higher layer. */
    zIndex: 9000,
  },
  /* Design note #1260: THE OTHER RULED PROPERTY, on the container now -- see the note on `HauntingVideo`.
     The container is the stacking context, so this is the only place the blend reaches the board. */
  containerScreened: {
    mixBlendMode: "screen",
  },
  video: {
    // Inherited rather than assumed: the container is already inert, and a nested element can re-enable it.
    pointerEvents: "none",
  },
  videoScreened: {
    maxWidth: "72vw",
    maxHeight: "72vh",
  },
  videoFeathered: {
    /* Design note #1093: larger than the hauntings, because this one is not keyed and therefore reads as a
       picture rather than as an apparition -- and because the train is small in frame. */
    maxWidth: "88vw",
    maxHeight: "80vh",
    /* ==================================================================
        DESIGN NOTE 1093: `closest-side` IS THE LOAD-BEARING WORD HERE
       ==================================================================
       NO BLEND MODE. See the note above: there is no black in this clip to key out.
       THE FIRST DRAFT LEFT A SEAM AND A RENDER SHOWED IT. Written without a sizing keyword, a radial gradient
       is sized `farthest-corner`, so 100% of the ray lands at the CORNER -- which puts the edge midpoints at
       only 71% of it. A fade ending at 92% therefore still had roughly 0.6 alpha where the left and right
       edges are, and the clip ended on a visible vertical line down the board. Caught by compositing a real
       frame over #1b1f29 and looking at it, which is the check I have skipped before and been wrong for.
       `closest-side` SIZES THE ELLIPSE TO THE HALF-EXTENTS, so 100% is exactly the edge midpoint on both
       axes and the corners are past it. Every edge reaches zero; nothing ends on a line.
       CENTRED AT 56%, NOT 50%, because the locomotive sits right of centre for the first half of the clip and
       a mask centred on the frame would fade the subject. It recedes toward the middle as it goes, so a
       modest offset suits the whole run better than either extreme.
       `WebkitMaskImage` IS CARRIED ALONGSIDE for Safari, which still wants the prefix on a video element -- a
       mask that silently did nothing there would show the hard-edged box to the players least likely to
       report it. */
    WebkitMaskImage: FOG_MASK,
    maskImage: FOG_MASK,
  },
};
