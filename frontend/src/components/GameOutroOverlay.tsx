// frontend/src/components/GameOutroOverlay.tsx
//
/* ==================================================================
    DESIGN NOTE 1418: THE OUTRO -- EIGHT SECONDS BETWEEN THE LAST ACTION AND THE MODAL
   ==================================================================
   SUPPLIED: an 8-second clip (two people on a roof, a train arriving, fireworks, "Game Over" landing at about
   3s and settling centred by 4.5s, then a hold on that frame to the end). ASKED whether it should cut to the
   modal when "Game Over" appears, or run to the end and become the modal's dimmed background.
   BOTH, AT THE RIGHT MOMENT. The clip plays full-bleed over the board the way the intro does (#1111); at the
   CUE -- 5.0s, once the title has settled -- the modal fades in over it; and the clip is never taken down: it
   runs out its hold underneath and its last frame stays behind the modal, dimmed by the modal's own backdrop,
   until the player leaves for the board. Cutting at the title would make the ending abrupt; waiting for the
   end would be 3.5s of a still. The cue is on the picture's own clock (`timeupdate`), as #1166a argued.
   ONCE, ON THE EDGE. The shell raises this when `gameEndReason` goes from null to set while the log is live.
   A tab that loads a finished game, a spectator arriving late, a re-open from the strip: none of those is the
   ending happening, and none gets the clip. The modal's own Replay covers the ceremony; nothing replays this.
   SKIP AND ESCAPE bring the modal up at once; the clip keeps playing out behind it, muted from then on -- a
   player who skipped the picture did not ask for its soundtrack to continue under the standings.
   THE CLIP HAS A SOUNDTRACK (fireworks), so the radio ducks under it as under the intro, and `sfxEnabled`
   mutes it. Encoded to 1280x720 at 3.8 MB for the tunnel; the still beside it is the last frame, for a
   browser that will not decode the video at all -- the modal then rises over the still instead.

   ==================================================================
    DESIGN NOTE 1437: THE GOLD OUTRO, A BOOKEND TO THE INTRO
   ==================================================================
   REPLACED: the neon pixel-art clip above with a 10-second gold-line-art one -- a locomotive bearing down
   on the camera, then receding over a viaduct into the distance, "GAME OVER" in a gold serif growing in from
   about 3.75s and settled by 4.5s, gold fireworks filling the sky from 4.5s to the end. (A sibling clip, the
   engine rolling through a switching yard with the title over the yard and smaller fireworks, was the first
   candidate; the viaduct shot won -- a train going away is what an ending looks like, the title has the sky
   to itself, and the fireworks are the finale rather than a garnish. It is kept in `_previous/`.) Chosen because the INTRO is gold engraving on black (the blueprint engine, the glowing map, the
   "Project 18XX" title), and the ending should speak the same language as the opening; the neon clip was a
   different game's register. ASKED whether the Neta DAO pink-blue gradient would be better still: no -- the
   gold is the game's own identity (title, chart rules, ceremony, the modal's gold kicker), and the gradient
   is the publisher's mark, which the intro uses as a sign-off sting rather than as its palette. The outro
   keeps to the game's colours for the same reason.
   THE CUE MOVES TO 6.5s -- then 8.0s (#1445: "ends a little abruptly. It should maybe last another 1-2
   seconds before cross-fading"). At 5.0s the title has only just settled and the first volleys are going
   up; raising the modal there would hide them. Three and a half seconds of fireworks, then the ceremony
   fades over the last two.
   The backstop moves out to 11s (clip length plus one). Levelled 2 dB down (peak -2.5 dB, mean -19 dB) so
   the cut to the title drumroll is not a drop; encoded to 2.9 MB. The neon clip is kept in `_previous/`. */

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { duckRadio, DUCK_FOR_VIDEO } from "../utils/audio";
import { useUiScale } from "../utils/useUiScale";

export const GAME_OUTRO_SRC = `${process.env.PUBLIC_URL ?? ""}/video/game-over.mp4`;
export const GAME_OUTRO_STILL = `${process.env.PUBLIC_URL ?? ""}/video/game-over-last.jpg`;

/** The picture's clock at which "Game Over" has settled and the modal may rise. */
export const OUTRO_CUE_SECONDS = 8.0; // #1437; #1445: "ends a little abruptly" -- a second and a half more of fireworks
/** For an engine that fires neither `timeupdate` nor `ended`. */
const OUTRO_BACKSTOP_MS = 11000; // #1437: clip length plus one
const SKIP_APPEARS_AFTER_MS = 1200;

const OUTRO_CSS = `
@keyframes app-outro-skip-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.app-outro-skip { animation: app-outro-skip-in 300ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .app-outro-skip { animation: none !important; } }
`;

export interface GameOutroOverlayProps {
  /** The cue: raise the modal. Fired once, by the clip reaching the cue, by Skip, by Escape, or by the backstop. */
  onCue: () => void;
  /** Whether the modal is up yet -- once it is, the skip goes and the sound stops. */
  cued: boolean;
  sfxEnabled: boolean;
}

export function GameOutroOverlay({ onCue, cued, sfxEnabled }: GameOutroOverlayProps) {
  const uiScale = useUiScale();
  const [skipVisible, setSkipVisible] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const fired = React.useRef(false);
  const cue = React.useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    onCue();
  }, [onCue]);

  const onTimeUpdate = React.useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (event.currentTarget.currentTime >= OUTRO_CUE_SECONDS) cue();
    },
    [cue],
  );

  React.useEffect(() => {
    const release = duckRadio(DUCK_FOR_VIDEO);
    const skipTimer = window.setTimeout(() => setSkipVisible(true), SKIP_APPEARS_AFTER_MS);
    const backstop = window.setTimeout(cue, OUTRO_BACKSTOP_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cue();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      release();
      window.clearTimeout(skipTimer);
      window.clearTimeout(backstop);
      window.removeEventListener("keydown", onKey);
    };
  }, [cue]);

  return (
    <div style={{ ...styles.backdrop, zoom: 1 / uiScale }} role="presentation" aria-hidden={cued} data-testid="game-outro">
      <style>{OUTRO_CSS}</style>
      {failed ? (
        <img src={GAME_OUTRO_STILL} alt="" style={styles.video} />
      ) : (
        <video
          style={styles.video}
          src={GAME_OUTRO_SRC}
          poster={GAME_OUTRO_STILL}
          autoPlay
          playsInline
          muted={!sfxEnabled || cued}
          loop={false}
          onTimeUpdate={onTimeUpdate}
          onEnded={cue}
          onError={() => {
            setFailed(true);
            cue();
          }}
        />
      )}
      {skipVisible && !cued && (
        <button type="button" className="app-outro-skip" style={styles.skip} onClick={cue} autoFocus>
          Skip
        </button>
      )}
    </div>
  );
}

export default GameOutroOverlay;

const styles: Record<string, React.CSSProperties> = {
  /* Under the Game Over modal (1600) and over the board and its toasts: the modal rises over THIS. */
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1500,
    backgroundColor: "#080808",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  skip: {
    position: "absolute",
    right: "24px",
    bottom: "24px",
    padding: "8px 16px",
    borderRadius: RADIUS.card,
    border: "1px solid rgba(255,255,255,0.35)",
    backgroundColor: "rgba(8,8,8,0.55)",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
};
