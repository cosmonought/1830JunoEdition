// The Sandbox multiplayer lobby: host a room, or join one by code.
//
// Design note #521: a BAR, not a gate. Offline Sandbox is the one mode that runs
// end to end with no wallet, chain or second player, so a modal asking "host or
// join?" would put a multiplayer decision in front of the single-player front
// door and every solo session would begin by dismissing it.
//
// Design note #521a: with Firestore unconfigured the controls are HIDDEN rather
// than disabled. A disabled control invites the player to work out how to enable
// it; this is a deployment fact they cannot act on from inside the game.
//
// See docs/ai_architecture/firebase_middleware.md, SandboxRoomBar.tsx #521.

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { BRAND_PINK } from "../styles/palette";

export interface SandboxRoomBarProps {
  /** `null` when not in a room -- the ordinary solo sandbox. */
  roomCode: string | null;
  /** False when Firestore is not configured; the strip explains and offers
   *  nothing. */
  available: boolean;
  /** A live error from the room, or `null`. Reported here only while JOINING -- once in a room the title
   *  strip carries it, beside `chatError` (#1083). */
  error: string | null;
  busy: boolean;
  onHost: () => void;
  onJoin: (code: string) => void;
  /** ==================================================================
   *   DESIGN NOTE 1137: THE ERROR HAD NO WAY TO BE WRONG ABOUT ITSELF
   *  ==================================================================
   *
   * REPORTED: "the error for entering a malformed room code persists indefinitely, even after a player hits
   * cancel." THE ERROR BELONGS TO THE PARENT and every route that could retire it belonged here. `onJoin`
   * sets it; Cancel and the next keystroke are the two moments it stops being true, and both of those happen
   * inside this component, which had no way to say so.
   * FIRED ON CANCEL AND ON EDIT, not just on Cancel. A player who mistypes and corrects the code without
   * cancelling is looking at a verdict on a string they have already replaced -- the same staleness, one
   * interaction earlier. Optional, so the in-game caller is unaffected. */
  onClearError?: () => void;
  /** ==================================================================
   *   DESIGN NOTE 1131: THE SAME CONTROLS, WITHOUT THE TRAY THEY SIT IN
   *  ==================================================================
   *
   * REPORTED of the lobby: "the Host Game and Join Game buttons are still inside a box. Move them out of
   * that." THE BOX IS THIS COMPONENT'S OWN -- a bordered `#0f0f0f` strip with an uppercase label -- and it is
   * right where this bar appears in the GAME, which is a dense screen where an unbounded row of controls
   * would float free of everything around it.
   * SO IT IS A SURFACE FLAG, NOT A DELETION, the same shape `AppFooter` uses. `bare` drops the tray, the
   * label and the padding; the buttons, the join form and the error are untouched, because those are the
   * component and the rest was packaging.
   * THE LABEL GOES WITH THE TRAY rather than being conditioned separately: "SANDBOX MULTIPLAYER" was naming
   * the box's contents, and on a title screen the buttons say what they are. */
  bare?: boolean;
}

export function SandboxRoomBar({
  roomCode,
  available,
  error,
  busy,
  onHost,
  onJoin,
  onClearError,
  bare = false,
}: SandboxRoomBarProps) {
  const [joining, setJoining] = useState(false);
  const [codeText, setCodeText] = useState("");

  if (!available) {
    return (
      <div style={styles.bar}>
        <span style={styles.muted}>
          Sandbox multiplayer needs Firestore, which this build has not been configured with.
          Solo sandbox is unaffected.
        </span>
      </div>
    );
  }

  /* ==================================================================
      DESIGN NOTE 1083: THE IN-ROOM BAR IS GONE, AND EVERY PIECE OF IT WENT SOMEWHERE
     ==================================================================
     RULED: "Completely delete the '68 actions' text ... Completely delete the 'Leave Room' button. Players
     will use the existing '<- Lobby' button in the title area to navigate away ... Move the remaining Room
     Name information into the Title area."

     THAT IS THREE REMOVALS AND ONE MOVE, and taken together they empty the branch. Worth stating as a whole
     rather than as four edits, because what is left over decides whether the branch should exist:

       "N actions synced"  DELETED. A replay counter is a fact about the transport, not about the game -- it
                           told a player their client was keeping up, which is the sort of thing that belongs
                           in a console when it is true and in an error when it is not.
       "Leave room"        DELETED. The title area's back-arrow already leaves, and two exits mean a player
                           has to work out whether they differ. They did not.
       the room code       MOVED to the title, where the room's identity now lives beside the app's.
       the error           MOVED to the title strip, beside `chatError` -- the two are the same KIND of fact
                           (this room's connection is unhappy) and were being reported in two places.

     SO THE BRANCH IS DELETED RATHER THAN EMPTIED. A `<div>` that renders an empty flex row is a gap in the
     layout with no explanation, and this batch is about removing exactly that.

     WHAT SURVIVES IS THE JOIN/HOST FORM BELOW, which is the bar's actual job: it is how a solo sandbox
     BECOMES a room. Once you are in one it has nothing left to offer. */
  if (roomCode) return null;

  return (
    <div style={bare ? styles.barBare : styles.bar}>
      {!bare && <span style={styles.label}>Sandbox multiplayer</span>}
      {/* ==================================================================
           DESIGN NOTE 1136: ONE SIZE, ONE COLOUR, AND GREEN ONLY WHILE PRESSED
          ==================================================================
          FOUR REPORTS, AND THREE OF THEM ARE ONE FAULT. #1132 sized the bare pair UP -- "they can hold their
          own against the title" -- and overshot into `control` type with 22px of side padding. That is what
          made the padding "far too much", it is what left the two buttons "still quite close together"
          (wide buttons meeting in the middle of a fixed box), and it is why the small "Join" that appears
          after clicking looked like a different control: it was one, at the ORIGINAL size, beside two that
          had grown.
          SO EVERY BUTTON IN THIS BAR IS NOW THE SAME BUTTON. Host, Join game, Join and Cancel all take
          `bareButton`, which is the size the report proposed -- "I wonder if the smaller Join button is the
          right size for everything?" It is: `small` type with 7px/16px, one step over the in-game original
          rather than two.
          AND NOT GREEN AT REST. "Leaving Host Game green makes it seem like the other option is disabled or
          lesser value" -- exactly right, and this screen offers two equal doors. `buttonPrimary`'s teal was
          chosen for a control INSIDE the tray, where it was the only thing worth pressing; alone on a title
          screen it demotes its neighbour. The teal moves to `:active`, which is the thing the report asked
          for -- "when players click a button it can become green to show it was pressed" -- and is the one
          moment a colour like that is a fact rather than a ranking.
          `:active` NEEDS A STYLESHEET, which is #46's standing exception. The class is applied only in bare
          mode, so the in-game bar keeps its own look untouched. */}
      <style>{BARE_BUTTON_CSS}</style>
      <button
        type="button"
        className={bare ? "sandbox-bare-btn" : undefined}
        style={bare ? styles.bareButton : styles.buttonPrimary}
        onClick={onHost}
        disabled={busy}
      >
        Host game
      </button>
      {joining ? (
        <form
          style={styles.joinRow}
          onSubmit={(event) => {
            event.preventDefault();
            onJoin(codeText);
          }}
        >
          <input
            style={styles.input}
            value={codeText}
            onChange={(event) => {
              // Design note #1137: the verdict was about the old string.
              if (codeText !== event.target.value) onClearError?.();
              setCodeText(event.target.value);
            }}
            placeholder="JUNO-4T2"
            aria-label="Room code"
            autoFocus
          />
          <button
            type="submit"
            className={bare ? "sandbox-bare-btn" : undefined}
            style={bare ? styles.bareButton : styles.button}
            disabled={busy}
          >
            Join
          </button>
          <button
            type="button"
            className={bare ? "sandbox-bare-btn" : undefined}
            style={bare ? { ...styles.bareButton, ...styles.bareButtonQuiet } : styles.buttonQuiet}
            onClick={() => {
              setJoining(false);
              setCodeText("");
              // Design note #1137: leaving the form retires its error with it.
              onClearError?.();
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={bare ? "sandbox-bare-btn" : undefined}
          style={bare ? styles.bareButton : styles.button}
          onClick={() => {
            onClearError?.();
            setJoining(true);
          }}
          disabled={busy}
        >
          Join game
        </button>
      )}
      {error && <span style={styles.error}>{error}</span>}
    </div>
  );
}

export default SandboxRoomBar;

/* Design note #1136: `:active` has no inline form -- #46's standing exception. The teal is the pressed
   state now rather than a resting rank, and the transition is short enough to read as a press rather than as
   an animation. Scoped to the bare class so the in-game bar is untouched. */
/* ==================================================================
    DESIGN NOTE 1165: THE HOVER IS NETA'S, AND ONLY WHERE THERE IS A POINTER
   ==================================================================
   ASKED: "add a distinct hover state for desktop users. Keep it strictly within the Neta DAO design tokens."
   THE OLD ONE WAS TWO GREYS -- #262626 on #1c1c1c, which is a shade nobody notices on a photograph. The brand
   has exactly two colours and #1092 took them from Neta's own stylesheet rather than from the logo, so the
   pink is quotable rather than approximate: border to BRAND_PINK, with the same pink as a low glow so the
   edge does not have to carry the whole signal alone.
   GATED ON A REAL POINTER, which is the "for desktop users" half and not decoration: a `:hover` rule on a
   touch screen fires on tap and STICKS until something else is touched, so the button that was pressed stays
   lit afterwards. #1148 hit exactly this on the float badge; asking the browser is the fix there and here.
   NO GRADIENT ON THE BORDER. `BRAND_GRADIENT` exists and cannot be a border-color without a second painted
   layer -- and a two-stop edge on a 45px control is a detail nobody resolves. The pink is the half of the
   brand that reads at this size. */
const BARE_BUTTON_CSS = `
.sandbox-bare-btn { transition: background-color 90ms ease, border-color 90ms ease, color 90ms ease, box-shadow 90ms ease; }
@media (hover: hover) and (pointer: fine) {
  .sandbox-bare-btn:hover:not(:disabled) {
    background-color: #262626;
    border-color: ${BRAND_PINK};
    box-shadow: 0 0 0 1px ${BRAND_PINK}, 0 6px 18px rgba(201, 51, 138, 0.28);
  }
}
.sandbox-bare-btn:active:not(:disabled) {
  background-color: #14312f;
  border-color: #2f6f6a;
  color: #7fe0d0;
}
.sandbox-bare-btn:focus-visible { outline: 2px solid #8a8a86; outline-offset: 2px; }
`;

const styles: Record<string, React.CSSProperties> = {
  /* Design note #1131: the tray, minus the tray. Kept as its own object rather than as a spread-with-
     overrides, because "no border, no fill, no padding" said three times in overrides is harder to read than
     the four properties that actually remain. */
  /* ==================================================================
      DESIGN NOTE 1136: THE ONE LOBBY BUTTON
     ==================================================================
     Every control in the bare bar is this -- Host, Join game, Join and Cancel -- so none of them can be
     "smaller than" another, which is what the join form's Join button was.
     THE SIZE IS THE ONE THE REPORT PROPOSED: `small` type at 7px/16px. #1132's `control` at 10px/22px was an
     overcorrection, and the padding is what made two buttons in a fixed box look crowded -- they were nearly
     touching in the middle of it, which reads as "close together" even though the box had not moved.
     NEUTRAL, NOT TEAL. Two equal doors, so neither gets the colour that says "press this one". */
  /* ==================================================================
      DESIGN NOTE 1165: BIGGER, AND #1136'S PREMISE IS WHAT EXPIRED
     ==================================================================
     ASKED: "scale up the Host Game and Join Game buttons by roughly 60% so they feel like true primary
     actions on the screen."
     #1136 CHOSE `small` AT 7/16 DELIBERATELY and called `control` at 10/22 "an overcorrection" -- and its
     reason was crowding: "the padding is what made two buttons in a fixed box look crowded, they were nearly
     touching in the middle of it". THE BOX IS GONE. #1131 removed the tray and #1132 anchored these two onto
     the boardroom photograph at the coordinates the report named, so there is no longer a container for them
     to crowd; they float on a full-bleed image, where `small` type reads as a caption rather than a door.
     SIXTY PERCENT, TAKEN ON THE BUTTON AND NOT ONLY THE TYPE. The control was about 28px tall (12px type in
     7px padding); it is about 45px now (16px type in 13px), which is the ~60% the report asked for.
     THE TYPE STAYS ON THE SCALE, at `heading`. 12px x 1.6 is 19.2 and there is no 19 -- and #1151 has just
     finished removing twelve near-identical values that were invented exactly this way. The presence comes
     from the padding, which is not a scale and was never meant to be.
     STILL ONE BUTTON FOR ALL FOUR. #1136's rule is that Host, Join game, Join and Cancel are the same
     control so none can read as lesser; they all grow together, and Cancel keeps its quiet fill. */
  bareButton: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    padding: "13px 30px",
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    letterSpacing: "0.02em",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  /* Cancel is the one control here that IS lesser -- it undoes rather than does -- so it keeps the size and
     gives up the fill. The only place in this bar where a difference in weight is a fact. */
  bareButtonQuiet: {
    backgroundColor: "transparent",
    borderColor: "#2a2a2a",
    color: "#a8a6a0",
    fontWeight: 600,
  },
  barBare: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    /* ==================================================================
        DESIGN NOTE 1132: `center` WAS WHY THE BUTTONS IGNORED THEIR COORDINATES
       ==================================================================
       REPORTED: "the Host Game and Join Game buttons are not at the coordinates I specified." The ANCHOR was
       right -- a 24% box centred on the scene -- and this line then packed both buttons into the middle of
       it, so they sat shoulder to shoulder at 0.5 instead of straddling 0.40 and 0.60. A container positioned
       correctly and a content alignment that ignores it.
       `space-between` PUTS THEM ON THE BOX'S EDGES, which is what the width was chosen to place. It also
       behaves when the join form opens: Host stays left, the form takes the right, and the row does not
       re-centre itself mid-interaction. */
    justifyContent: "space-between",
    gap: "12px",
    width: "100%",
    /* ==================================================================
        DESIGN NOTE 1136: `wrap` IS WHY THE JOIN FORM JUMPED A LINE
       ==================================================================
       REPORTED: "when clicking Join game the join interface jumps below the Host Game button." The bar is a
       fixed 24% of the scene, and opening the form swaps one button for three controls plus an input -- which
       at #1132's padding no longer fitted, so `flexWrap: wrap` did exactly what it was told and put them on a
       second line. A layout that reflows under the thing you just clicked.
       `nowrap` PLUS THE SMALLER BUTTONS IS WHAT FIXES IT: at 7px/16px the whole form -- Host, code field,
       Join, Cancel -- fits the same row it opened from, so the only thing that changes on click is the
       control that was clicked. */
    flexWrap: "nowrap",
    fontSize: FONT_SIZE.small,
  },
  bar: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #2a2a2a",
    backgroundColor: "#0f0f0f",
    fontSize: FONT_SIZE.small,
  },
  label: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#a8a6a0",
  },
  /* Design note #1083: `code` is DELETED, not left unused. Its one caller was the in-room branch and the
     room code now renders in the title strip, which carries its own copy of this treatment -- an orphaned
     style for a thing this component no longer shows is an invitation to show it again. */
  muted: { color: "#8a8a86" },
  error: { color: "#e07a7a" },
  joinRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "6px" },
  input: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.small,
    padding: "5px 8px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    width: "110px",
    textTransform: "uppercase",
  },
  button: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "5px 12px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    cursor: "pointer",
  },
  buttonPrimary: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    padding: "5px 12px",
    borderRadius: RADIUS.control,
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
    color: "#7fe0d0",
    cursor: "pointer",
  },
  buttonQuiet: {
    fontSize: FONT_SIZE.small,
    padding: "5px 10px",
    borderRadius: RADIUS.control,
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "#8a8a86",
    cursor: "pointer",
  },
};
