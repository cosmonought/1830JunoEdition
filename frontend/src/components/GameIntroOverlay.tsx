// frontend/src/components/GameIntroOverlay.tsx
//
// The title sequence, between the waiting room and the first deal.
//
// ==================================================================
//  DESIGN NOTE 1111: TEN SECONDS THE PLAYER CAN LEAVE
// ==================================================================
//
// REQUESTED: "I want to use this cinematic intro video between the Waiting Room and the actual game. It
// should play once all players Ready and the Host clicks Start Game."
//
// IT IS AN OVERLAY, NOT A SCREEN, and that is the one structural decision here. A third top-level branch --
// waiting room, then intro, then shell -- would hold the game back for ten seconds and then start mounting
// it. Laid over the shell instead, the deal, the board and the first render all happen behind the clip, so
// dismissing it lands on a game that is already there rather than on a loading state wearing a different
// picture. It also means a skip is INSTANT, which is what makes the skip worth offering.
//
// EVERY CLIENT, NOT THE HOST. Start writes `SetupGame` to the room document and every browser replays it, so
// the room's status is what moves -- the caller watches for the `waiting` -> `playing` edge rather than for
// a local click. A player who joins a room already in progress never sees the edge, and correctly gets no
// intro.
//
// A SKIP BUTTON RATHER THAN CLICK-ANYWHERE, on instruction. Click-to-dismiss on a full-screen element is
// invisible until it is explained, and it fires on the click a player did not mean -- reaching for a control
// on the board they can see through the clip. A button is a target, is reachable by keyboard, and can say
// what it does. Escape works too, because Escape always should.
//
// See docs/ai_architecture/ui_shell_layout.md, GameIntroOverlay.tsx #1111.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import { duckRadio, DUCK_FOR_VIDEO } from "../utils/audio";
// Design note #1144: the chrome's scale, so this layer can divide back out of it.
import { UI_SCALE } from "../styles/appStyles";

/** Served from `public/`, like the haunting clips. `video/` rather than `audio/`: those three live beside
 *  the variant SFX they belong to, and this is not a sound effect. */
export const GAME_INTRO_SRC = `${process.env.PUBLIC_URL ?? ""}/video/game-intro.mp4`;

/** The clip's own length. The overlay does not depend on it -- `onEnded` is the real signal -- but a timer
 *  this long is the backstop for an engine that never fires it (a decode failure, a tab suspended mid-clip).
 *  Generous rather than exact, so a slow start is not cut short. */
const INTRO_BACKSTOP_MS = 14000;

/** How long before the skip offers itself. Long enough that the opening is not competing with a control,
 *  short enough that nobody feels held. */
const SKIP_APPEARS_AFTER_MS = 1800;

/* Inline styles cannot express `@keyframes` -- design note #46's escape hatch. One rule, one consumer, so it
   lives here rather than in `animations.ts`, which is for keyframes several surfaces share.
   REDUCED MOTION LOSES THE FADE AND KEEPS THE BUTTON, matching #606's rule everywhere else in the app: the
   information is the control, never the movement. */
const SKIP_FADE_CSS = `
@keyframes app-intro-skip-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .app-intro-skip { animation: none !important; }
}
`;

export interface GameIntroOverlayProps {
  /** Dismissed by the clip ending, the skip button, Escape, or the backstop. */
  onDone: () => void;
  /** Design note #1111: the clip carries a soundtrack, and a player who muted effects meant it. */
  sfxEnabled: boolean;
}

export function GameIntroOverlay({ onDone, sfxEnabled }: GameIntroOverlayProps) {
  const [skipVisible, setSkipVisible] = React.useState(false);

  /* ONE `onDone`, HOWEVER IT ENDS. Four things can finish this -- the clip, the button, Escape, the backstop
     -- and every one of them must release the duck exactly once. The ref is what makes the second caller a
     no-op rather than a second release. */
  const finished = React.useRef(false);
  const finish = React.useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  }, [onDone]);

  React.useEffect(() => {
    /* Design note #1041's registry, used as intended: the radio drops to 20% under the clip and comes back
       on the release. Nothing here knows whether a radio exists, and the radio does not know about this. */
    const release = duckRadio(DUCK_FOR_VIDEO);
    const skipTimer = window.setTimeout(() => setSkipVisible(true), SKIP_APPEARS_AFTER_MS);
    const backstop = window.setTimeout(finish, INTRO_BACKSTOP_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      release();
      window.clearTimeout(skipTimer);
      window.clearTimeout(backstop);
      window.removeEventListener("keydown", onKey);
    };
  }, [finish]);

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Opening titles">
      <style>{SKIP_FADE_CSS}</style>
      <video
        style={styles.video}
        src={GAME_INTRO_SRC}
        autoPlay
        playsInline
        muted={!sfxEnabled}
        loop={false}
        onEnded={finish}
        /* A clip that will not decode must not become a ten-second black screen with a button on it. */
        onError={finish}
      />
      {skipVisible && (
        <button type="button" className="app-intro-skip" style={styles.skip} onClick={finish} autoFocus>
          Skip intro
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /* Above everything. The shell's own layers top out in the low thousands (`ActionToast` sits at 4000), so
     this clears them by an order of magnitude rather than by one. */
  backdrop: {
    /* ==================================================================
        DESIGN NOTE 1144: ART AT VIEWPORT SIZE OPTS OUT OF THE CHROME'S ZOOM
       ==================================================================
       The shell's root carries `zoom: UI_SCALE` so the game room's CHROME draws at the size the player was
       reaching for the browser's zoom control to get.
       AN EARLIER DRAFT OF THIS NOTE SAID `inset: 0` WOULD STOP MEANING "THE VIEWPORT". IT WAS WRONG, and it
       was wrong in the confident direction: measured in Chrome 148, a fixed layer inside `zoom: 0.7` still
       comes back the full width and height of the window, because the containing block a fixed element gets
       is itself zoom-adjusted. The clip would have played full-bleed with or without this line.
       WHAT ACTUALLY SHRINKS IS EVERYTHING AUTHORED IN PIXELS INSIDE THE LAYER -- here, "Skip intro". The
       video is a raster stretched to a box that covers the window either way, so it is unaffected; the button
       is a control sized to a cinematic, and at 70% it becomes a small grey word on a full-screen picture.
       COUNTER-ZOOMED RATHER THAN MOVED OUT OF THE TREE, which was the alternative: a portal would work and
       would put this layer somewhere a reader does not expect to find it. `1 / UI_SCALE` is the same idiom
       `boardPane` uses, and for the same reason -- this is ART sized to the window, not chrome sized to the
       reader.
       THE MODALS ARE DELIBERATELY NOT DOING THIS. A confirm dialog is chrome and should shrink with the rest
       of it; only the surfaces that are pictures at viewport size are exempt. */
    zoom: 1 / UI_SCALE,
    position: "fixed",
    inset: 0,
    zIndex: 40000,
    backgroundColor: "#080808",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  /* `contain` rather than `cover`: the clip is a drawing with content at its edges, and cropping it to fill
     a wide window would cut the map it is drawing. The letterbox is the theme's own ground, so it reads as
     framing rather than as a gap. */
  video: { width: "100%", height: "100%", objectFit: "contain", display: "block" },
  skip: {
    position: "absolute",
    right: "22px",
    bottom: "22px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    padding: "7px 16px",
    borderRadius: "8px",
    border: "1px solid #3a3a3a",
    backgroundColor: "rgba(20, 20, 20, 0.82)",
    color: "#c8c6c0",
    cursor: "pointer",
    /* Fades in rather than appearing, so it does not read as something arriving to be dealt with. */
    animation: "app-intro-skip-in 320ms ease both",
  },
};

export default GameIntroOverlay;
