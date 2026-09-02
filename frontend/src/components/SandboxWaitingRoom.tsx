// The anteroom: who is here, what they are called, and who may start.
//
// Design note #529: this REPLACES the board rather than sitting over it. Before
// setup lands there is no game -- the player count is undecided, so starting
// cash and the certificate limit are too, and showing the board underneath would
// show a plausible, correctly-rendered game nobody is playing.
//
// Design note #529a: everyone gets Ready; only the host gets Start. Start is the
// one write that DEALS the game, and two clients sending it would put two setups
// with different shuffles in the log, each replayed by every client.
//
// See docs/ai_architecture/firebase_middleware.md, SandboxWaitingRoom.tsx #529.

import React, { useState } from "react";
import {
  BANK_SIZE_BY_LENGTH,
  GAME_LENGTH_BLURB,
  STANDARD_VARIANTS,
  type GameLength,
  type GameVariants,
  VARIANT_COPY,
  type VariantCopyKey,
} from "../utils/gameVariants";

import { FONT_FAMILY, FONT_SIZE, LINE_HEIGHT } from "../styles/typography";
import { waitingRoomBlock, waitingRoomNotice, type SandboxRoomDoc } from "../utils/sandboxRoom";
import { MAX_PLAYERS, MIN_PLAYERS, certLimitForPlayers, startingCashForPlayers } from "../utils/gameSetup";
import { SEAT_COLORS, SEAT_COLOR_NAMES } from "../utils/playerLabels";
import AudioControls, { type AudioControlsProps } from "./AudioControls";

/** Design note #910: the four boolean variants as DATA, so adding a fifth is one row rather than a fifth
 *  hand-written block that could be forgotten -- which is exactly the failure this note is fixing, at the
 *  scale of a whole panel. `key` is typed against `GameVariants`, so a renamed flag is a compile error here
 *  rather than a toggle that silently stops binding. */
/* ==================================================================
    DESIGN NOTE 961a: NEITHER THE LABELS NOR THE BLURBS ARE WRITTEN HERE
   ==================================================================
   This table used to carry both, and BOTH had drifted from the Lobby's: the blurb by a whole sentence about
   dividend rounding, and the label by a word -- "Delayed private auction" here against "Delayed auction"
   there. One variant with two names, on the two screens a table reads before agreeing to it.
   THE ORDER IS STILL THIS FILE'S OWN, which is why the keys are listed rather than taken from
   `Object.keys`: the sequence a host reads the toggles in is a presentation decision, and the record is a
   dictionary rather than a running order. Typed as `VariantCopyKey`, so a renamed flag is a compile error
   here rather than a toggle that silently stops binding. */
const VARIANT_TOGGLES: ReadonlyArray<{
  key: VariantCopyKey;
  label: string;
  blurb: string;
}> = (
  ["unpredictableRevenue", "dynamicStockMarket", "gentleRust", "delayedAuction"] as const
).map((key) => ({ key, ...VARIANT_COPY[key] }));

export interface SandboxWaitingRoomProps {
  roomCode: string;
  room: SandboxRoomDoc | null;
  /** This browser's seat -- design note #528. */
  localPlayerId: string;
  error: string | null;
  busy: boolean;
  onSetNickname: (nickname: string) => void;
  /** Design note #569: `null` returns this seat to the assigned default. */
  onSetColor: (color: string | null) => void;
  onToggleReady: (isReady: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
  /** Design note #910: the host rewrites the table's house rules; every seat sees them. `undefined` for a
   *  guest, which is what makes the controls read-only rather than absent for them. */
  onSetVariants?: (variants: GameVariants) => void;
  /** ==================================================================
   *   DESIGN NOTE 1101: THE RADIO WAS ALREADY PLAYING HERE, WITH NOTHING TO PRESS
   *  ==================================================================
   *
   * ASKED: "can we have the radio playable in the Waiting Room and continue smoothly into the game start?"
   *
   * THE CONTINUITY HALF NEEDED NO WORK, and that is worth stating because it looks like it should have.
   * `useRadioStream`'s element is owned by `AppShell`, built once under a `[]`-dep effect and released only
   * when that component unmounts. This screen and the game shell are two BRANCHES OF THE SAME RENDER -- an
   * early return and the fall-through -- so the element is already alive here, and pressing Start does not
   * touch it. No reconnect, no re-buffer, no gap.
   *
   * WHAT WAS MISSING WAS REACH. The toggle lives in `TopBar`, which the early return skips, so the stream
   * sat there with no control attached. This prop is that control and nothing more.
   *
   * SUPERSEDED IN PART BY #1102. This first shipped as a plain on/off toggle, on the reasoning that volume
   * and per-category switches do not belong on a screen whose job is to be left. REPORTED back: "I'm not
   * sure the audio button should behave one way in the Waiting Room and another in the Game." The reasoning
   * was sound and the premise was not -- a player should not learn two audio controls for one app -- so this
   * now renders the very same `AudioControls` the bar does.
   *
   * AND IT BUYS THE AUTOPLAY GESTURE. Browsers require a click before audio may start (#1009), which is why
   * the stream defaults to paused; a click here satisfies it, so the game never has to ask for one. */
  audio?: AudioControlsProps["audio"];
}

export function SandboxWaitingRoom({
  roomCode,
  room,
  localPlayerId,
  error,
  busy,
  onSetNickname,
  onSetColor,
  onToggleReady,
  onStart,
  onLeave,
  onSetVariants,
  audio,
}: SandboxWaitingRoomProps) {
  const players = room?.players ?? [];
  const me = players.find((player) => player.id === localPlayerId) ?? null;
  const isHost = room?.hostId === localPlayerId;
  /* Design note #910: read off the ROOM, so a guest and the host are looking at one answer. */
  const variants = room?.variants ?? STANDARD_VARIANTS;
  const canEditVariants = isHost && room?.status === "waiting" && !busy && onSetVariants !== undefined;
  const [nicknameText, setNicknameText] = useState(me?.nickname ?? "");

  const enough = players.length >= MIN_PLAYERS;
  const allReady = players.length > 0 && players.every((player) => player.isReady);
  const canStart = isHost && enough && allReady;
  /* Design note #857: what the ROOM is short of, from the same reader `canStartSandboxGame` uses -- so the
     host's tooltip and the guest's line cannot describe the same room differently. */
  const block = waitingRoomBlock(room, MIN_PLAYERS);
  const notice = waitingRoomNotice(room, MIN_PLAYERS, {
    isHost,
    isReady: me?.isReady ?? false,
  });

  /* Design note #529: the numbers this room WOULD be dealt, shown live as people
     arrive. They are the whole consequence of the player count, and a lobby that
     hides them makes the count feel cosmetic. `null` off the printed table. */
  const cash = startingCashForPlayers(players.length);
  const certs = certLimitForPlayers(players.length);

  return (
    <div style={styles.root}>
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <span style={styles.title}>Sandbox waiting room</span>
          <div style={styles.headerActions}>
            {audio && <AudioControls audio={audio} />}
            <button type="button" style={styles.quiet} onClick={onLeave}>
              Leave
            </button>
          </div>
        </div>

        {/* The code, at the size of the thing people have to read aloud. */}
        <div style={styles.codeBlock}>
          <span style={styles.codeLabel}>Room code</span>
          <code style={styles.code}>{roomCode}</code>
          <span style={styles.note}>Anyone with this code can join from the lobby.</span>
        </div>

        <form
          style={styles.nickRow}
          onSubmit={(event) => {
            event.preventDefault();
            onSetNickname(nicknameText);
          }}
        >
          <input
            style={styles.input}
            value={nicknameText}
            onChange={(event) => setNicknameText(event.target.value)}
            placeholder="Your name"
            aria-label="Your nickname"
            maxLength={20}
          />
          <button type="submit" style={styles.button} disabled={busy}>
            Set name
          </button>
        </form>

        {/* Design note #569a: optional by construction -- a seat that never touches this
           gets the palette by index and is never colourless. Taken colours are DISABLED
           rather than hidden: a greyed swatch with the holder's name says why it cannot
           be chosen, where removing it would make the palette a different size for every
           player and look like a bug. */}
        <div style={styles.colorRow} role="group" aria-label="Your colour">
          <span style={styles.colorLabel}>Colour</span>
          {SEAT_COLORS.map((color) => {
            const holder = players.find(
              (player) => player.color === color && player.id !== localPlayerId,
            );
            const mine = me?.color === color;
            return (
              <button
                key={color}
                type="button"
                aria-pressed={mine}
                aria-label={SEAT_COLOR_NAMES[color] ?? color}
                disabled={busy || !me || holder !== undefined}
                onClick={() => onSetColor(mine ? null : color)}
                title={
                  holder
                    ? `${holder.nickname || "Another player"} has taken ${SEAT_COLOR_NAMES[color] ?? "this"}.`
                    : mine
                      ? `${SEAT_COLOR_NAMES[color] ?? "This colour"} — click again to let the game assign one.`
                      : (SEAT_COLOR_NAMES[color] ?? color)
                }
                style={{
                  ...styles.swatch,
                  backgroundColor: color,
                  ...(mine ? styles.swatchMine : {}),
                  ...(holder ? styles.swatchTaken : {}),
                }}
              />
            );
          })}
        </div>

        <div style={styles.roster} role="list" aria-label="Players in this room">
          {players.length === 0 ? (
            <span style={styles.note}>Nobody here yet.</span>
          ) : (
            players.map((player) => (
              <span key={player.id} style={styles.rosterRow} role="listitem">
                <span style={styles.rosterName}>
                  {/* Design note #569: the seat's colour, where the seat is
                      named -- so a player can see the assignment before the
                      game starts rather than discovering it on the board. */}
                  <span
                    style={{
                      ...styles.rosterDot,
                      backgroundColor:
                        player.color ?? SEAT_COLORS[players.indexOf(player) % SEAT_COLORS.length],
                    }}
                    aria-hidden="true"
                  />
                  {player.nickname || "unnamed"}
                  {player.id === room?.hostId && <span style={styles.hostTag}>HOST</span>}
                  {player.id === localPlayerId && <span style={styles.youTag}>YOU</span>}
                </span>
                <span style={player.isReady ? styles.ready : styles.notReady}>
                  {player.isReady ? "Ready" : "Not ready"}
                </span>
              </span>
            ))
          )}
        </div>

        {/* Design note #529: what this many players are dealt. */}
        <div style={styles.dealRow}>
          {cash !== null && certs !== null ? (
            <span style={styles.note}>
              {players.length} players — <strong style={styles.figure}>${cash}</strong> each,
              certificate limit <strong style={styles.figure}>{certs}</strong>.
            </span>
          ) : (
            <span style={styles.note}>
              Project 18XX is dealt for {MIN_PLAYERS}–{MAX_PLAYERS} players. Waiting for more.
            </span>
          )}
        </div>

        {/* ==================================================================
             DESIGN NOTE 910: THE HOUSE RULES, WHERE THE GAME IS ACTUALLY STARTED
            ==================================================================
            REPORTED: "there are no options visible in the Lobby to actually select them."
            THEY WERE VISIBLE, ON A SCREEN NOBODY USES. #902 built this same panel on `Lobby.tsx`'s
            create-room form -- the on-chain staging path -- while a sandbox table starts its game from HERE.
            SHOWN TO EVERY SEAT, EDITABLE BY THE HOST. A guest sees the same five rows, disabled: they are
            about to agree to this game by pressing Ready, and a table's terms that only the host can read are
            not terms. That is also why they live on the room document rather than in the host's component
            state -- see `sandboxRoom.ts` #910.
            LOCKED ONCE THE GAME STARTS. `status !== "waiting"` closes the controls, because the variants
            travel in the `SetupGame` action and changing them afterwards would describe a game that is not
            the one being played. */}
        <div style={styles.variantPanel}>
          <span style={styles.variantHeading}>House rules</span>
          <label style={styles.variantRow}>
            <span style={styles.variantLabel}>Game length</span>
            <select
              value={variants.length}
              disabled={!canEditVariants}
              onChange={(event) =>
                onSetVariants?.({ ...variants, length: event.target.value as GameLength })
              }
              style={styles.variantSelect}
            >
              {(Object.keys(BANK_SIZE_BY_LENGTH) as GameLength[]).map((option) => (
                <option key={option} value={option}>
                  {option === "short" ? "Short" : option === "long" ? "Long" : "Standard"} &mdash; $
                  {BANK_SIZE_BY_LENGTH[option].toLocaleString()} bank
                </option>
              ))}
            </select>
          </label>
          <span style={styles.variantNote}>{GAME_LENGTH_BLURB[variants.length]}</span>

          {/* ==================================================================
               DESIGN NOTE 924: A GUEST READS THE TERMS, NOT THE MENU
              ==================================================================
              REPORTED: "for joining players (guests), hide the descriptions (or the entire rows) of any
              variants that the host has toggled OFF. Guests only need to see the terms/variants that are
              actively enabled."
              AND #910 WAS RIGHT ABOUT THE WRONG AUDIENCE. It argued that terms only the host can read are not
              terms -- true, and it made every seat read the whole MENU, including four rules that are not in
              force. A guest is agreeing to a game, not reviewing a settings screen: what they need is the
              list of rules that will actually apply, and an unticked box is not one of them.
              THE HOST STILL SEES ALL FIVE, because the host is choosing rather than agreeing. Same panel, two
              audiences, and the difference is which question they are answering. */}
          {VARIANT_TOGGLES.filter((toggle) => canEditVariants || variants[toggle.key]).map((toggle) => (
            <label key={toggle.key} style={styles.variantToggle}>
              <input
                type="checkbox"
                checked={variants[toggle.key]}
                disabled={!canEditVariants}
                onChange={(event) =>
                  onSetVariants?.({ ...variants, [toggle.key]: event.target.checked })
                }
              />
              <span style={styles.variantToggleText}>
                <span style={styles.variantToggleLabel}>{toggle.label}</span>
                <span style={styles.variantNote}>{toggle.blurb}</span>
              </span>
            </label>
          ))}

          {!canEditVariants && (
            <span style={styles.variantNote}>
              {VARIANT_TOGGLES.some((toggle) => variants[toggle.key])
                ? "Only the host can change these. You are agreeing to them when you press Ready."
                : /* Design note #924: SILENCE WOULD READ AS A LOADING STATE. With every toggle off the list
                     above renders nothing, and a heading with an empty body looks broken rather than
                     settled. This says the same thing the empty list means. */
                  /* Design note #977: "the standard game" rather than the number. Same rule, same batch's
                     slip, same reason -- see `gameVariants` #977. */
                  "No variants are switched on — this table is playing the standard game, as printed."}
            </span>
          )}
        </div>

        <div style={styles.actionRow}>
          <button
            type="button"
            style={me?.isReady ? styles.button : styles.buttonPrimary}
            onClick={() => onToggleReady(!(me?.isReady ?? false))}
            disabled={busy || !me}
          >
            {me?.isReady ? "Not ready" : "Ready to play"}
          </button>
          {isHost && (
            <button
              type="button"
              style={{ ...styles.buttonStart, ...(canStart ? {} : styles.buttonDisabled) }}
              onClick={onStart}
              disabled={!canStart || busy}
              /* A disabled control with no explanation is the thing this
                 codebase's own prop conventions exist to prevent, so the
                 reason names whichever condition is actually blocking. */
              /* Design note #857: the SAME reader the guest's line uses. This tooltip was the only statement
                 of what was blocking, and it was hovered by the one person who could act on it. */
              title={
                block === "need-players"
                  ? `Project 18XX needs at least ${MIN_PLAYERS} players.`
                  : block === "need-ready"
                    ? "Waiting for everyone to mark themselves ready."
                    : "Deal the game and begin."
              }
            >
              Start game
            </button>
          )}
        </div>

        {/* ==================================================================
             DESIGN NOTE 857: THE GUEST IS TOLD WHAT THE HOST WAS ONLY HOVERING
            ==================================================================
            ASKED: "when a non-host player clicks 'Ready,' there should be a notification like 'Waiting for
            Host to start the game...' so that players know they don't need to do anything else."
            BELOW THE ROW, because it is the ANSWER to the button just pressed -- the same placement rule
            #835 applied to the Track hint and #855 to the route detail: a line about a control goes under it.
            NOT AN ERROR, and drawn so: nothing has gone wrong, the player has finished their part. `error`
            below keeps its own louder treatment. */}
        {notice && <span style={styles.notice}>{notice}</span>}

        {error && <span style={styles.error}>{error}</span>}
      </div>
    </div>
  );
}

export default SandboxWaitingRoom;

const styles: Record<string, React.CSSProperties> = {
  /* ==================================================================
      DESIGN NOTE 1100: THE ONE SCREEN THAT NEVER PAINTED ITS OWN GROUND
     ==================================================================
     REPORTED: "the Lobby and Game screens are both full-page in the color scheme, but the Waiting Room has a
     bright white background that is jarring between the two darks."
     AND IT WAS NEVER DARK -- this is not something #1092 broke. This root declared layout and padding only,
     so the page behind the panel was whatever `body` happened to be, which is the user-agent default. The
     lobby and the shell each set `minHeight: 100vh` and a `backgroundColor` on their own roots and so never
     showed it; this screen sits between them and did.
     BOTH HALVES ARE FIXED, deliberately. This root now paints itself like its two neighbours, AND
     `index.html` paints `body` -- see the note there. Either alone would have closed the report; together
     they also close the NEXT screen that forgets, because a full-height root is a thing an author has to
     remember and a painted body is not. */
  root: {
    display: "flex",
    justifyContent: "center",
    padding: "40px 20px",
    minHeight: "100vh",
    backgroundColor: "#0f0f0f",
    color: "#f2f0eb",
    fontFamily: FONT_FAMILY,
    boxSizing: "border-box",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    width: "100%",
    maxWidth: "520px",
    padding: "22px 24px",
    borderRadius: "12px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#0f0f0f",
  },
  headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  headerActions: { display: "flex", alignItems: "center", gap: "6px" },
  title: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#f2f0eb" },
  codeBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "12px 14px",
    borderRadius: "8px",
    backgroundColor: "#141414",
    border: "1px solid #2a2a2a",
  },
  codeLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#a8a6a0",
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "28px",
    fontWeight: 800,
    letterSpacing: "0.12em",
    color: "#7ee0a1",
    userSelect: "all",
  },
  note: { fontSize: FONT_SIZE.small, color: "#8a8a86", lineHeight: LINE_HEIGHT.normal },
  figure: { color: "#f2f0eb", fontVariantNumeric: "tabular-nums" },
  nickRow: { display: "flex", flexDirection: "row", gap: "8px" },
  colorRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "6px" },
  colorLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#a8a6a0",
    marginRight: "2px",
  },
  swatch: {
    width: "26px",
    height: "26px",
    borderRadius: "50%",
    border: "2px solid transparent",
    cursor: "pointer",
    padding: 0,
  },
  swatchMine: { borderColor: "#f2f0eb", boxShadow: "0 0 0 2px rgba(226,230,238,0.25)" },
  swatchTaken: { opacity: 0.28, cursor: "not-allowed" },
  rosterDot: { width: "10px", height: "10px", borderRadius: "50%", flex: "none" },
  input: {
    flex: 1,
    fontSize: FONT_SIZE.control,
    padding: "7px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
  },
  roster: { display: "flex", flexDirection: "column", gap: "4px" },
  rosterRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    borderRadius: "6px",
    backgroundColor: "#1c1c1c",
    fontSize: FONT_SIZE.small,
    color: "#c8c6c0",
  },
  rosterName: { display: "inline-flex", alignItems: "center", gap: "7px", fontWeight: 700 },
  hostTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
    color: "#d9c0f5",
  },
  youTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
    color: "#9ec5ff",
  },
  ready: { color: "#7ee0a1", fontWeight: 700 },
  notReady: { color: "#8a8a86" },
  dealRow: { paddingTop: "2px" },
  actionRow: { display: "flex", flexDirection: "row", gap: "8px", flexWrap: "wrap" },
  button: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    cursor: "pointer",
  },
  buttonPrimary: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
    color: "#7fe0d0",
    cursor: "pointer",
  },
  buttonStart: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: "8px 18px",
    borderRadius: "8px",
    border: "1px solid #38bdf8",
    backgroundColor: "#1d3a55",
    color: "#9ec5ff",
    cursor: "pointer",
    marginLeft: "auto",
  },
  buttonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  /* Design note #910: a panel rather than loose rows, because these five belong together as one agreement. */
  variantPanel: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#0f0f0f",
    marginTop: "10px",
  },
  variantHeading: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.08em",
    color: "#8a8a86",
    textTransform: "uppercase",
  },
  variantRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" },
  variantLabel: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#f2f0eb" },
  variantSelect: {
    fontSize: FONT_SIZE.small,
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    minWidth: "220px",
  },
  variantToggle: { display: "flex", flexDirection: "row", gap: "9px", alignItems: "flex-start" },
  variantToggleText: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  variantToggleLabel: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#f2f0eb" },
  /* ==================================================================
      DESIGN NOTE 924: THE RULES ARE THE CONTENT, NOT A CAPTION
     ==================================================================
     REPORTED: "the variant rules text in the Lobby is too small and too gray against the dark background."
     AND THE TREATMENT WAS BORROWED FROM THE WRONG PLACE. `AutoPassModal`'s captions are `micro` in `#8a90a0`
     because they explain a control whose LABEL already carries the decision. Here the description IS the
     decision -- a player agreeing to Gentle Rust has to read the sentence, because the two words above it do
     not say what the rule does.
     `small` ON `#c8cdd8`, which is this app's body treatment for text meant to be read rather than glanced
     at: the same pairing the fleet-loss modal and the Auto-Pass body use. */
  variantNote: {
    fontSize: FONT_SIZE.small,
    color: "#c8c6c0",
    lineHeight: LINE_HEIGHT.normal,
  },
  /* Design note #857: calm, not alarmed. #707's distinction between a refusal and a status -- this reports
     that the player has finished and the room has not, which is neither an error nor an instruction. */
  notice: {
    fontSize: FONT_SIZE.small,
    lineHeight: LINE_HEIGHT.normal,
    color: "#9ec5ff",
  },
  quiet: {
    fontSize: FONT_SIZE.small,
    padding: "5px 10px",
    borderRadius: "6px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "#8a8a86",
    cursor: "pointer",
  },
  error: { fontSize: FONT_SIZE.small, color: "#e07a7a" },
};
