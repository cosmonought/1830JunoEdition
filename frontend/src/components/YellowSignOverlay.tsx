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

import React from "react";

export interface YellowSignOverlayProps {
  /** The clip to play, or `null` when nothing is haunting anybody. */
  src: string | null;
  /** Design note #1045: the player's SFX toggle. The clip is unmuted so its audio layers with the MP3, and
   *  muted anyway when the table has asked for silence. */
  sfxEnabled: boolean;
}

export function YellowSignOverlay({ src, sfxEnabled }: YellowSignOverlayProps) {
  if (!src) return null;
  return (
    <div style={styles.container} aria-hidden="true">
      <video
        style={styles.video}
        src={src}
        autoPlay
        muted={!sfxEnabled}
        playsInline
        /* NOT LOOPED. The caller owns the ten seconds (#1040's `videoMs`); a clip that looped would keep
           going if that timer were ever missed, and a clip shorter than the window simply ends early and
           leaves the overlay transparent -- which is the harmless direction. */
        loop={false}
      />
    </div>
  );
}

export default YellowSignOverlay;

const styles: Record<string, React.CSSProperties> = {
  container: {
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
  video: {
    maxWidth: "72vw",
    maxHeight: "72vh",
    /* THE OTHER RULED PROPERTY. Black becomes transparent, so the board shows through the clip rather than
       being covered by a rectangle. */
    mixBlendMode: "screen",
    // Inherited rather than assumed: the container is already inert, and a nested element can re-enable it.
    pointerEvents: "none",
  },
};
