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
  bankSizeLabel,
  GAME_LENGTH_NOTE,
  GAME_MODE_COPY,
  GAME_TYPE_COPY,
  STANDARD_VARIANTS,
  VARIANT_COPY,
  type VariantCopyKey,
  gameTypeOf,
} from "../gameEngine/gameVariants";

import { FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, RADIUS } from "../styles/typography";
import {
  roomSeatCap,
  roomVisibility,
  seatsNeeded,
  waitingRoomBlock,
  waitingRoomNotice,
  type SandboxRoomDoc,
} from "../utils/sandboxRoom";
import { MIN_PLAYERS, certLimitForPlayers, startingCashForPlayers } from "../gameEngine/gameSetup";
// #1415: the ante's figures and the subsidy line, the same ones the host's setup card showed.
import { ANTE_SUBSIDY_NOTE, VISIBILITY_COPY } from "./HostSetupCard";
import { anteBreakdown, formatJuno } from "../utils/anteMath";
import { SEAT_COLORS, SEAT_COLOR_NAMES, resolveSeatColors } from "../utils/playerLabels";
import { type AudioControlsProps } from "./AudioControls";
/* Design note #1138: the shell's own bar, mounted here so the audio controls stop moving between the
   anteroom and the table. */
import TopBar from "./TopBar";
import AppFooter from "./AppFooter";
// Design note #1341: the seat PIN, set and rejoined from the roster.
import { SeatPinModal } from "./SeatPinModal";
import { setSkipIntroPreferred, skipIntroPreferred } from "../utils/introPreference";
import { chromeZoomFor } from "../styles/appStyles";
/* Design note #1294: the chrome scale, live. */
import { useUiScale } from "../utils/useUiScale";
/* Design note #1122: the sandbox signal ladder. */
import {
  SANDBOX_TITLE,
} from "../styles/palette";

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
/* Design note #1271: `expandedMap` and `levelPlayingField` are NOT toggles -- they are the Game Type, one
   choice with its illegal combinations removed (see `gameVariants` #1271). #1415: the CONTROLS for all of
   these live on `HostSetupCard` now; this table is the ORDER the terms in force are listed in here, and
   `GAME_TYPE_FLAGS` names the two the type owns, so `variantWiring.test.ts` can still ask that every boolean
   flag reaches a control somewhere. */
export const GAME_TYPE_FLAGS = ["expandedMap", "levelPlayingField"] as const;
const VARIANT_TOGGLES: ReadonlyArray<{
  key: VariantCopyKey;
  label: string;
  blurb: string;
}> = (
  [
    "unpredictableRevenue",
    "dynamicStockMarket",
    "gentleRust",
    "delayedAuction",
    "plusTiles",
  ] as const
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
  /* ==================================================================
      DESIGN NOTE 1415: THE TERMS ARE READ HERE, NOT WRITTEN
     ==================================================================
     `onSetVariants` IS GONE. #910 put the house-rules controls on this screen so every seat could see them
     before agreeing; the host now chooses them on the setup card BEFORE the room exists (`HostSetupCard`),
     and "rules frozen after Create Room" is the ruling. What this screen keeps is #910's real point -- the
     terms are on the room document and every seat reads the same ones -- drawn as a summary rather than a
     form. A host who wants different terms hosts a different room.
     `onKick` IS NEW: the host removes a joiner, before the start only. `undefined` for a guest. */
  onKick?: (playerId: string) => void;
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
  onKick,
  audio,
}: SandboxWaitingRoomProps) {
  /* Design note #1294: the chrome scale, live. */
  const uiScale = useUiScale();
  const players = room?.players ?? [];
  const me = players.find((player) => player.id === localPlayerId) ?? null;
  /* Design note #1337: one colour per seat, chosen or assigned, the same on every client. */
  const resolvedColors = resolveSeatColors(players);
  const isHost = room?.hostId === localPlayerId;
  /* Design note #910: read off the ROOM, so a guest and the host are looking at one answer. */
  const variants = room?.variants ?? STANDARD_VARIANTS;
  /* #1415: the table's terms beyond the variants -- who may join, how many, and what a seat puts in. */
  const visibility = roomVisibility(room);
  const seatCap = roomSeatCap(room);
  const exactCount = typeof room?.playerCount === "number" ? room.playerCount : null;
  const ante = anteBreakdown(room?.anteUjuno);
  const canKick = isHost && room?.status === "waiting" && !busy && onKick !== undefined;
  /* #1415: this seat was removed -- the roster no longer holds it and the document says why. */
  const wasKicked = room !== null && me === null && (room.kicked ?? []).includes(localPlayerId);
  /* ==================================================================
      DESIGN NOTE 1441: WATCHING AN OPEN TABLE, SAID OUT LOUD
     ==================================================================
     #1441 lets the Lobby offer Watch on a table that is still waiting, so this screen now has a viewer it
     never had: somebody with no seat who was not kicked out of one. Every control here is already gated on
     `me` and correctly does nothing for them -- Ready, the colours, the name -- and a screen full of
     controls that silently refuse is the failure #1415 wrote the full table's reason for.
     ONE LINE, NOT A MODE. They are looking at the room; what they need is the sentence that explains why
     none of it is theirs, and the way back to a seat. */
  const isWatching = room !== null && me === null && !wasKicked;
  /* #1415: Ready is the deposit, so it asks first; un-Ready is the withdrawal and asks too. */
  const [readyConfirm, setReadyConfirm] = useState<"deposit" | "withdraw" | null>(null);
  const [kicking, setKicking] = useState<string | null>(null);
  /* ==================================================================
     DESIGN NOTE 1169a: AN INITIALISER IS NOT A SUBSCRIPTION
     ==================================================================
     `useState(me?.nickname ?? "")` reads its argument ONCE, on the mount -- and on the mount there is no `me`,
     because the seat arrives with the first snapshot one round trip later (#764's third state, again). So the
     field opened empty for a player who already had a name: rejoin a room, or reload into one, and the box
     said nothing while the roster below it said "B". Found next to #1169 rather than reported, and it is the
     same shape -- a control drawn from data that had not arrived yet.
     SEEDED ONCE, AND NEVER OVER TYPING. `touched` is what separates "has not been filled in yet" from "is
     deliberately empty because I am clearing it", which a `!nicknameText` test would run together. */
  const [skipIntro, setSkipIntro] = useState(() => skipIntroPreferred());
  /* Design note #1341: the seat-PIN card -- set mine, or rejoin another seat from this device. */
  const [seatPin, setSeatPin] = useState<{ mode: "set" | "rejoin"; seatId: string | null } | null>(null);
  const [nicknameText, setNicknameText] = useState(me?.nickname ?? "");
  const [nicknameTouched, setNicknameTouched] = useState(false);
  const knownNickname = me?.nickname ?? "";
  React.useEffect(() => {
    if (nicknameTouched || knownNickname === "") return;
    setNicknameText(knownNickname);
  }, [knownNickname, nicknameTouched]);

  /* #1415: "exactly N" means N -- the server refuses the (N+1)th seat, so "at least N" here IS exactly N. */
  const needed = seatsNeeded(room, MIN_PLAYERS);
  const enough = players.length >= needed;
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
  /* #1320: the Level Playing Field has its own tables and a seventh seat, so the figures read the room's
     variants -- the same object the toggles below edit, so they move the moment the host ticks the box. */
  /* #1445: the optional rules in force, derived once -- the right region's existence, the left column's
     "None" line and the rows themselves are three readings of one answer, so there is one filter. */
  const houseRules = VARIANT_TOGGLES.filter((toggle) => variants[toggle.key]);
  /* ==================================================================
      DESIGN NOTE 1446: A RAIL IS FOR A COLUMN'S WORTH OF RULES
     ==================================================================
     REPORTED of the single-rule capture: "a full-height divided column is reserved for one short item" --
     which is #1445's own no-rules argument arriving one case later. An empty rail and a rail holding two
     lines are the same fault at different sizes.
     THE COUNT DECIDES, and nothing else. Not the rendered height, not the viewport: a layout chosen by
     measuring text is a layout that changes when a word is edited, and it cannot be asserted without a
     browser. `houseRules.length` is the same number on every client and in a unit test.
     THREE IS THE FLOOR because two of these entries are about a paragraph each -- at two the rail is shorter
     than the settings beside it, and at three it is the taller column the divider was drawn for.
     PRESENTATION ONLY. The same array, the same order, the same copy; all that moves is which parent the
     section is rendered into. */
  const RULES_FOR_RAIL = 3;
  const railed = houseRules.length >= RULES_FOR_RAIL;
  /* One element, rendered into one of two parents -- so the flow and the rail cannot drift into two designs
     with two sets of copy, which is what a second JSX block here would become. */
  const houseRulesSection = (
    <>
      <h2 style={styles.sectionHeading}>House rules</h2>
      <div style={styles.variantList}>
        {houseRules.map((toggle) => (
          <div key={toggle.key} style={styles.variantToggle}>
            <span style={styles.termTick} aria-hidden="true">✓</span>
            <span style={styles.termText}>
              <span style={styles.termLabel}>{toggle.label}</span>
              <span style={styles.variantNote}>{toggle.blurb}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
  const cash = startingCashForPlayers(players.length, variants);
  const certs = certLimitForPlayers(players.length, variants);
  const maxPlayers = seatCap;

  /* Design note #1144: the same 70% the shell and the lobby draw at. This screen is the one the report named
     first -- "did the Waiting Room panel become huge at some point?" -- and #1137 answered the half of that
     question that was about the ROOT. This is the other half: the panel really is drawn larger than the
     player has been reading it at, because they have been reading everything at 70%. */
  return (
    <div style={{ ...styles.root, ...chromeZoomFor(uiScale) }}>
      <style>{WAITING_ROOM_CSS}</style>
      {/* Design note #1266: the photograph, on its own fixed layer. */}
      <div style={styles.sceneLayer} aria-hidden="true" />
      {/* Design note #1138: the anteroom gets the shell's own title bar -- one control, one position, both
          screens. `roomName` carries the code, so the bar shows it the way the game does. */}
      <TopBar roomName={roomCode} onLeaveGame={onLeave} audio={audio} />
      <div style={styles.surfaceWrap}>
        <div
          style={{ ...styles.surface, ...(railed ? null : styles.surfaceSolo) }}
          data-testid="waiting-room-main"
        >
          <div className={railed ? "wr-columns" : "wr-columns wr-columns-solo"}>
            {/* ==================================================================
                 PRIMARY: WHERE AM I, WHO IS HERE, WHAT DO I DO NOW
                ==================================================================
                #1443's order, and the visual weight follows it: the room's identity, then the people, then
                the one action. The terms are the second column because a seat reads them once and acts on
                the roster continuously. */}
            <div style={styles.primary}>
              {/* ==================================================================
                   DESIGN NOTE 1444: THE GAME IS THE SUBJECT; THE CODE IS THE ADDRESS
                  ==================================================================
                  REPORTED: "the current oversized green room code still receives the emphasis that should
                  belong to the Game." #1443 unboxed the code and, having unboxed it, left it at the size the
                  box had been sized for -- so the largest thing on a screen about a game was a string you
                  only need in order to reach it.
                  THREE STEPS, ONE ORDER, BOTH VISIBILITIES: the page says what it is, the game says what is
                  being played, the room says where. A private table needs its code no more prominently than a
                  public one -- the code is equally load-bearing there and equally not the subject -- so the
                  hierarchy does not fork, which is one fewer thing that can disagree between two rooms.
                  THE CODE KEEPS ITS MONOSPACE, ITS LETTER-SPACING, ITS GREEN AND ITS `user-select: all`. Those
                  are what make it readable aloud and copyable in one gesture; only the size was the claim. */}
              <h1 style={styles.title}>Waiting room</h1>
              <p style={styles.gameName}>{GAME_TYPE_COPY[gameTypeOf(variants)].label}</p>
              <p style={styles.roomLine}>
                <span style={styles.roomLabel}>Room</span>
                <code style={styles.code}>{roomCode}</code>
              </p>
              {/* #1445: the game's own sentence, kept when its row left the settings list. The TITLE is not
                  duplicated by it (that is why the row went), but the description is the only statement on
                  this screen of what the table is actually playing -- and under the Level Playing Field it is
                  the only place the map's differences are listed at all. Below the code, so the title and the
                  address stay the pair the eye reads first. */}
              <p style={styles.gameNote}>{GAME_TYPE_COPY[gameTypeOf(variants)].blurb}</p>

              {/* #1443: name and colour are ONE operation -- who you are at this table -- so they share a
                  heading and a row rather than sitting as two unlabelled controls. A watcher has no seat to
                  name or colour, so the block is absent rather than disabled (#1441's rule, applied here). */}
              {!isWatching && (
                <section style={styles.block} aria-labelledby="wr-you">
                  <h2 id="wr-you" style={styles.sectionHeading}>
                    Your seat
                  </h2>
                  <form
                    style={styles.nickRow}
                    onSubmit={(event) => {
                      event.preventDefault();
                      onSetNickname(nicknameText);
                    }}
                  >
                    <input
                      className="wr-touch"
                      style={styles.input}
                      value={nicknameText}
                      onChange={(event) => {
                        setNicknameTouched(true);
                        setNicknameText(event.target.value);
                      }}
                      placeholder="Your name"
                      aria-label="Your nickname"
                      maxLength={20}
                    />
                    <button type="submit" className="wr-touch" style={styles.button} disabled={busy}>
                      Set name
                    </button>
                  </form>
                  {/* Design note #569a: optional by construction -- a seat that never touches this gets the
                      palette by index and is never colourless. Taken colours are DISABLED rather than hidden:
                      a greyed swatch with the holder's name says why it cannot be chosen, where removing it
                      would make the palette a different size for every player and look like a bug. */}
                  <div style={styles.colorRow} role="group" aria-label="Your colour">
                    {SEAT_COLORS.map((color) => {
                      /* #1337: a seat's DEFAULT colour is held too -- the table sees colours, not intents. */
                      const holder = players.find(
                        (player) => resolvedColors[player.id] === color && player.id !== localPlayerId,
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
                </section>
              )}

              <section style={styles.block} aria-labelledby="wr-players">
                <h2 id="wr-players" style={styles.sectionHeading}>
                  Players
                  {/* #1443: the seat count belongs to the heading it counts. It used to trail the deal line,
                      where "certificate limit 18." and "4 of 4 seats" ran together as "18.4". */}
                  <span style={styles.seatCount}>
                    {players.length} of {maxPlayers} seats{exactCount !== null ? " (exactly)" : ""}
                  </span>
                </h2>
                <ul style={styles.roster} aria-label="Players in this room">
                  {players.length === 0 ? (
                    <li style={styles.emptySeat}>Nobody here yet.</li>
                  ) : (
                    players.map((player) => (
                      <li key={player.id} className="wr-seat" style={styles.seat}>
                        <span style={styles.seatName}>
                          {/* Design note #569: the seat's colour, where the seat is named -- so a player can
                              see the assignment before the game starts rather than on the board. */}
                          <span
                            style={{ ...styles.rosterDot, backgroundColor: resolvedColors[player.id] }}
                            aria-hidden="true"
                          />
                          <span style={styles.seatNameText}>{player.nickname || "unnamed"}</span>
                          {player.id === room?.hostId && <span style={styles.hostTag}>Host</span>}
                          {player.id === localPlayerId && <span style={styles.youTag}>You</span>}
                        </span>
                        <span style={player.isReady ? styles.ready : styles.notReady}>
                          {player.isReady ? "Ready" : "Not ready"}
                        </span>
                        <span style={styles.seatControls}>
                          {/* Design note #1341: my seat sets its PIN; another seat can be rejoined from here.
                              #1341a: offered for a seat with NO PIN too -- it adopts the one typed. */}
                          {player.id === localPlayerId ? (
                            <button
                              type="button"
                              className="wr-touch"
                              style={styles.quietButton}
                              onClick={() => setSeatPin({ mode: "set", seatId: null })}
                              title="A four-digit PIN, for this room only, so you can pick this seat up on another device."
                            >
                              {player.hasPin ? "PIN set" : "Set PIN"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="wr-touch"
                              style={styles.quietButton}
                              onClick={() => setSeatPin({ mode: "rejoin", seatId: player.id })}
                              title={
                                player.hasPin
                                  ? `Rejoin ${player.nickname || "this seat"} on this device with its PIN.`
                                  : `${player.nickname || "This seat"} has no PIN yet -- rejoining it here sets one.`
                              }
                            >
                              Rejoin
                            </button>
                          )}
                          {/* #1415: the host removes a joiner -- never themselves, never after the start.
                              Asked twice, inline: a seat is a person, and a mis-click here is a person gone. */}
                          {canKick && player.id !== room?.hostId && (
                            kicking === player.id ? (
                              <span style={styles.kickConfirm}>
                                <button
                                  type="button"
                                  className="wr-touch"
                                  style={styles.kickButtonConfirm}
                                  onClick={() => {
                                    setKicking(null);
                                    onKick?.(player.id);
                                  }}
                                  data-testid={`kick-confirm-${player.id}`}
                                >
                                  Remove{player.isReady ? " (refunds ante)" : ""}
                                </button>
                                <button type="button" className="wr-touch" style={styles.quietButton} onClick={() => setKicking(null)}>
                                  Keep
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="wr-touch"
                                style={styles.kickButton}
                                onClick={() => setKicking(player.id)}
                                aria-label={`Remove ${player.nickname || "this player"} from the table`}
                                title="Remove this player. They cannot rejoin this room."
                                data-testid={`kick-${player.id}`}
                              >
                                ✕
                              </button>
                            )
                          )}
                        </span>
                      </li>
                    ))
                  )}
                </ul>

                {/* Design note #529: what this many players are dealt. Its own sentence now -- see the
                    seat-count note above for the run-together it used to make. */}
                <p style={styles.note}>
                  {cash !== null && certs !== null ? (
                    <>
                      {players.length} players — <strong style={styles.figure}>${cash}</strong> each,
                      certificate limit <strong style={styles.figure}>{certs}</strong>.
                    </>
                  ) : exactCount !== null ? (
                    `The host set this table for exactly ${exactCount} players. Waiting for more.`
                  ) : (
                    `Project 18XX is dealt for ${MIN_PLAYERS}–${maxPlayers} players. Waiting for more.`
                  )}
                </p>
                {/* Design note #1341: said once, under the roster, so nobody takes the PIN for an account. */}
                <p style={styles.faintNote}>
                  Seat PINs are for this room only: set one to move your seat between devices mid-game.
                </p>
              </section>

              {/* ==================================================================
                   DESIGN NOTE 1415: READY IS THE DEPOSIT
                  ==================================================================
                  RULED: "Players get a seat, then when they click 'Ready' they ante into the game. Then the
                  Host starts the game." So the button asks first, with the figures: the ante, the treasury's
                  share, and what reaches the pool -- the same three numbers the receipt will carry. Un-Ready
                  is the withdrawal and asks the same way.
                  #1443: THE CONFIRMATION IS THE ONE PANEL LEFT ON THIS SCREEN, and it earns its box: it is a
                  transient state that interrupts the page, which is exactly the object a bounded surface is
                  for. Everything that merely GROUPED content lost its border in this pass. */}
              {readyConfirm && (
                <div style={styles.readyConfirm} role="dialog" aria-label={readyConfirm === "deposit" ? "Confirm your ante" : "Withdraw your ante"}>
                  <span style={styles.confirmTitle}>
                    {readyConfirm === "deposit" ? "Ready to play — ante into this game?" : "Not ready — withdraw your ante?"}
                  </span>
                  <span style={styles.note}>
                    {readyConfirm === "deposit" ? (
                      <>
                        Ante <strong style={styles.figure}>{formatJuno(ante.anteUjuno)}</strong> · developer
                        treasury <strong style={styles.figure}>{formatJuno(ante.subsidyUjuno)}</strong> · to the
                        pool <strong style={styles.figure}>{formatJuno(ante.netUjuno)}</strong>.
                        {ante.anteUjuno === "0" ? " Nothing moves on this table — the ante is off." : ""}
                      </>
                    ) : (
                      <>
                        Your ante of <strong style={styles.figure}>{formatJuno(ante.anteUjuno)}</strong> is refunded
                        and your seat stays. Press Ready again to ante back in.
                      </>
                    )}
                  </span>
                  <span style={styles.kickConfirm}>
                    <button
                      type="button"
                      className="wr-touch"
                      style={styles.buttonPrimary}
                      onClick={() => {
                        setReadyConfirm(null);
                        onToggleReady(readyConfirm === "deposit");
                      }}
                      disabled={busy}
                      data-testid="ready-confirm"
                    >
                      {readyConfirm === "deposit" ? "Confirm and ante" : "Withdraw"}
                    </button>
                    <button type="button" className="wr-touch" style={styles.button} onClick={() => setReadyConfirm(null)}>
                      Cancel
                    </button>
                  </span>
                </div>
              )}

              {/* ==================================================================
                   DESIGN NOTE 1443: A WATCHER IS GIVEN A STATUS, NOT A DISABLED PROMISE
                  ==================================================================
                  REPORTED: "Do not present a prominent green Ready to play control that merely happens to be
                  disabled. That visually promises an action the visitor cannot take."
                  AND IT IS THE SAME FAULT #1441 REMOVED FROM THE LOBBY one screen earlier: a full table's
                  disabled Join took the one place a control can be, said no, and hid what the room could
                  still do. The answer there and here is that a fact about the viewer is written as a fact.
                  THE WATCHER KEEPS THE ROSTER'S `Rejoin`, deliberately: that path needs the seat's PIN, so it
                  is proof of a seat already held rather than a way around #1441's Join -- and `adoptSeat`
                  retires the watch intent on its way through (#1442). */}
              <div style={styles.actionArea}>
                {/* #1443: the ready control belongs to a SEAT. A watcher has none and a removed player has
                    had one taken away -- and a green button that merely happens to be disabled promises
                    both of them something. The condition is `me`, so neither can be forgotten separately. */}
                {me ? (
                  <div style={styles.actionRow}>
                    <button
                      type="button"
                      className="wr-touch"
                      style={me?.isReady ? styles.button : styles.buttonPrimary}
                      onClick={() => setReadyConfirm(me?.isReady ? "withdraw" : "deposit")}
                      disabled={busy || !me || readyConfirm !== null}
                      title={
                        me?.isReady
                          ? "Withdraw your ante and mark yourself not ready."
                          : `Ante ${formatJuno(ante.anteUjuno)} and mark yourself ready.`
                      }
                    >
                      {me?.isReady ? "Not ready" : "Ready to play"}
                    </button>
                    {isHost && (
                      <button
                        type="button"
                        className="wr-touch"
                        style={{ ...styles.buttonStart, ...(canStart ? {} : styles.buttonDisabled) }}
                        onClick={onStart}
                        disabled={!canStart || busy}
                        /* Design note #857: the SAME reader the guest's line uses. This tooltip was the only
                           statement of what was blocking, and it was hovered by the one person who could act
                           on it. */
                        title={
                          block === "need-players"
                            ? exactCount !== null
                              ? `You set this table for exactly ${exactCount} players; ${players.length} ${players.length === 1 ? "is" : "are"} seated.`
                              : `Project 18XX needs at least ${MIN_PLAYERS} players.`
                            : block === "need-ready"
                              ? "Waiting for everyone to mark themselves ready."
                              : "Deal the game and begin."
                        }
                      >
                        Start game
                      </button>
                    )}
                  </div>
                ) : isWatching ? (
                  <p style={styles.watchStatus} data-testid="waiting-room-watching">
                    <span style={styles.watchTag}>Watching</span>
                    You are watching this table. Take a seat from the Lobby if you want to play; the host may
                    start without you.
                  </p>
                ) : null}

                {/* Design note #857: the guest is told what the host was only hovering. Below the row, because
                    it is the ANSWER to the button just pressed. Not an error, and drawn so. */}
                {wasKicked ? (
                  <span style={styles.error}>
                    The host removed you from this table. You cannot rejoin this room; leave and join or host another.
                  </span>
                ) : (
                  notice && <span style={styles.notice}>{notice}</span>
                )}

                {error && <span style={styles.error}>{error}</span>}

                {/* Design note #1239 (`introPreference.ts`): THIS browser's choice, not a term of the game --
                    so it sits with the actions rather than among the rules, is never disabled for guests, and
                    is not written to the room. */}
                <label style={styles.skipIntro}>
                  <input
                    type="checkbox"
                    checked={skipIntro}
                    onChange={(event) => {
                      setSkipIntroPreferred(event.target.checked);
                      setSkipIntro(event.target.checked);
                    }}
                  />
                  <span style={styles.termText}>
                    <span style={styles.termLabel}>Skip the opening titles</span>
                    <span style={styles.variantNote}>
                      On this browser only. Other players still see them unless they tick this too.
                    </span>
                  </span>
                </label>
              </div>

              {/* ==================================================================
                   DESIGN NOTE 1445: THE ORDINARY SETTINGS BELONG WITH THE ROOM, NOT IN A RAIL
                  ==================================================================
                  REPORTED from the captures: "Game Settings should not occupy the right column." #1444 was
                  right that a setting is not a house rule and wrong about where the distinction goes -- it
                  gave a rail to the group that is true of EVERY table and left the lower-left empty under a
                  roster that had finished.
                  SO THE SETTINGS FALL INTO THE LEFT COLUMN'S FLOW, after the action they qualify, and the
                  right region becomes what it is named for: the rules this table is playing DIFFERENTLY. The
                  reading order is the same on both layouts because there is only one source order.
                  DESIGN NOTE 910 survives every re-layout: a seat reads the TERMS IN FORCE, not the menu, and
                  they live on the room document so the host and a guest are looking at one answer. */}
              <section style={styles.flowSection} aria-labelledby="wr-settings">
                <h2 id="wr-settings" style={styles.sectionHeading}>Game settings</h2>
                {/* #1446: "you are agreeing to them when you press Ready" was false for a watcher, who has
                    no Ready control by design, and odd for the host, who chose them. What is true of every
                    reader is that they are settled -- so that is what it says, once, for everyone. */}
                <p style={styles.faintNote}>Fixed when the room opened.</p>

                <dl style={styles.terms}>
                  {/* #1445: Game and Players are GONE from this list. The game is the page's title and the
                      roster's heading already carries "3 of 6 seats" / "4 of 4 seats (exactly)" -- a second
                      copy of either is the duplication #1444 was removing, one level up. */}
                  <TermRow label="Pace" value={GAME_MODE_COPY[variants.mode].label} note={GAME_MODE_COPY[variants.mode].blurb} />
                  {/* #1444: the visibility's explanation lives HERE and nowhere else. It used to sit beside
                      the room code as well, which is where a reader met "Public room — listed on the Lobby"
                      and then met "Visibility · Public" a column later. */}
                  <TermRow
                    label="Visibility"
                    value={VISIBILITY_COPY[visibility].label}
                    note={VISIBILITY_COPY[visibility].blurb}
                  />
                  {/* #1444: a bank that is not the printed one is a table playing differently, so the row says
                      so where the value is -- rather than printing the amount a second time under House rules
                      in order to classify it. */}
                  <TermRow
                    label="Bank"
                    value={bankSizeLabel(variants.length)}
                    tag={variants.length === "standard" ? undefined : "Non-standard"}
                    note={GAME_LENGTH_NOTE[variants.length]}
                  />
                  <TermRow
                    label="Ante"
                    value={formatJuno(ante.anteUjuno)}
                    note={
                      ante.anteUjuno === "0"
                        ? ANTE_SUBSIDY_NOTE
                        : `${formatJuno(ante.subsidyUjuno)} of each ante funds the developer treasury for fee grants; ${formatJuno(ante.netUjuno)} reaches the pool.`
                    }
                  />
                </dl>

                {/* #1445: with no optional rules there is no right region at all -- an empty rail and a
                    divider around the word "None" is half a surface reserved for an absence. The fact is
                    still stated, quietly, at the foot of the settings it belongs beside. */}
                {!houseRules.length && (
                  <p style={styles.noRulesLine} data-testid="waiting-room-no-house-rules">
                    House rules · <span style={styles.noneTag}>None</span>
                  </p>
                )}
              </section>

              {/* #1446: one or two rules follow the settings in the same flow, separated by the same rule and
                  the same space -- a section, not a rail. */}
              {houseRules.length > 0 && !railed && (
                <section style={styles.flowSection} data-testid="waiting-room-rules-inline">
                  {houseRulesSection}
                </section>
              )}
            </div>

            {/* ==================================================================
                 SECONDARY: WHAT THIS TABLE IS PLAYING DIFFERENTLY
                ==================================================================
                #1445: the right region exists for the optional rules in force and for nothing else. Its
                height is whatever the active rules come to -- one rule is a short column and five is a long
                one -- and with none active it is not rendered, so the surface becomes a single region rather
                than a column of settings beside a column of nothing.
                THE CLASSIFICATION IS THE MODEL'S. `VARIANT_TOGGLES` is the list of optional rules the
                configuration already keeps, and the filter over it is unchanged: nothing has moved between ON
                and off, only between headings. The copy is #961a's shared record, so a rule reads here
                exactly as it did on the setup card. */}
            {railed && (
              <div className="wr-secondary" style={styles.secondary} data-testid="waiting-room-rules-rail">
                {houseRulesSection}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Design note #1341: the seat-PIN card, owned here so the shell carries none of it. */}
      {seatPin && (
        <SeatPinModal
          mode={seatPin.mode}
          roomCode={roomCode}
          localPlayerId={localPlayerId}
          players={players}
          initialSeatId={seatPin.seatId}
          onClose={() => setSeatPin(null)}
        />
      )}
      {/* Design note #1113: the meta-UI credit, the same component and the same moving mark the lobby
          carries. The waiting room is the one screen between them and had no footer at all. */}
      <AppFooter surface="meta" />
    </div>
  );
}

export default SandboxWaitingRoom;

/* ==================================================================
    DESIGN NOTE 1258: THE HOLD IS DRAWN IN THE ROOM IT IS HOLDING FOR
   ==================================================================
   REPORTED: "screen flash on Host Game."
   THE FLASH WAS A THIRD SCREEN. Pressing Host unmounts the lobby -- the boardroom photograph -- and the
   shell's first render is #764's hold: a small card on the bare app ground, no photograph, no title bar,
   for exactly the one round trip it takes the room document to arrive. Then THIS screen mounts, with its
   own photograph and its own bar. Two full-bleed scenes with a dark card between them is a flash however
   short the middle frame is, and the host sees it on every single game.
   #764 WAS RIGHT THAT THERE MUST BE A HOLD -- the board is not a safe default -- and wrong only about what
   it looks like. The hold now renders in this component's own root, bar and panel, so the frame between
   the lobby and the waiting room IS the waiting room, with a sentence where the roster will be. One
   transition rather than two, and the photograph is already decoded when the roster lands.
   `roomCode` IS SHOWN IMMEDIATELY. It is known before the document is -- `hostSandboxRoom` returns it --
   and it is the one thing a host wants to start reading aloud. */
export function SandboxWaitingRoomHold({
  roomCode,
  onLeave,
  audio,
}: Pick<SandboxWaitingRoomProps, "roomCode" | "onLeave" | "audio">) {
  const uiScale = useUiScale();
  return (
    <div style={{ ...styles.root, ...chromeZoomFor(uiScale) }}>
      <style>{WAITING_ROOM_CSS}</style>
      <div style={styles.sceneLayer} aria-hidden="true" />
      <TopBar roomName={roomCode} onLeaveGame={onLeave} audio={audio} />
      <div style={styles.surfaceWrap}>
        <div style={styles.surface}>
          {/* #1443: the hold wears the room's own type, so the frame before the roster lands is the same
              screen rather than a card that becomes one. */}
          <div style={styles.primary}>
            <h1 style={styles.title}>Waiting room</h1>
            <code style={styles.code}>{roomCode}</code>
            <p style={styles.visibilityNote}>Fetching the room…</p>
            <div style={styles.actionRow}>
              <button type="button" className="wr-touch" style={styles.button} onClick={onLeave}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
      <AppFooter surface="meta" />
    </div>
  );
}

/** #1415: one term of the table, read-only -- a label, its value, and the sentence that explains it.
 *  #1443: a real definition pair inside a `<dl>`, separated from its neighbours by a hairline rather than
 *  gathered into a card. The label and the value are the scannable line; the prose sits under both. */
function TermRow({ label, value, tag, note }: { label: string; value: string; tag?: string; note?: string }) {
  return (
    <div style={styles.term}>
      <div style={styles.termLine}>
        <dt style={styles.termLabel}>{label}</dt>
        <dd style={styles.termValue}>
          {/* #1444: a classification, beside the value it classifies -- not a second copy of the value under
              another heading. */}
          {tag && <span style={styles.termTag}>{tag}</span>}
          {value}
        </dd>
      </div>
      {note && <p style={styles.variantNote}>{note}</p>}
    </div>
  );
}

/* Design note #1258: the same photograph the root paints, fetched while the player is still in the lobby
   so it is in the cache before the hold needs it. A `link rel=preload` would want the document head; an
   `Image` is the same request from here. Idempotent -- the browser dedupes a URL it already holds. */
export function preloadWaitingRoomScene(): void {
  if (typeof Image === "undefined") return;
  const img = new Image();
  img.src = `${process.env.PUBLIC_URL ?? ""}/images/waiting-room.jpg`;
}

/* ==================================================================
    DESIGN NOTE 1443: TWO COLUMNS, ONE HAIRLINE, AND NOTHING ELSE DRAWN
   ==================================================================
   REPORTED: "almost every level is expressed as another rectangle ... a long, narrow form floating in a
   large room." SIX NESTED SURFACES for four questions -- the panel, the code box, the roster rows, the house
   rules card, the confirm, the variant rows -- each one a correct grouping and, together, a page with no
   hierarchy at all. The same fault this project removed from the Rules Reference, one screen later.
   THE STRUCTURE DOES THE GROUPING NOW. Two unequal columns on a single surface, divided by one hairline: the
   room and the people on the left, the terms they are agreeing to on the right. Nothing inside either column
   is boxed except the ante confirmation, which is a transient state rather than a grouping.
   ONE MARKUP AT BOTH WIDTHS. The columns collapse to one and the hairline turns from a left border into a
   top rule; the roster's three cells become a name, a state under it and the controls beside both -- the
   same `display: contents`-free grid re-placement the Lobby's list uses, which is to say the rows are
   re-hung rather than re-rendered.
   `!important` ON THE TOUCH HEIGHT for the reason #1441 recorded: these controls carry inline padding, and
   an inline declaration outranks any ordinary rule. Only `min-height` is asserted here, which no inline
   style sets -- the shorthand is left alone so the horizontal padding stays as authored. */
const WAITING_ROOM_CSS = `
.wr-columns {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  /* #1445: "stretch" is about the RULE, not the region. The rules themselves still end where they end --
     nothing in the right column grows to fill it -- but the hairline that divides the two regions runs the
     height of the surface, because a divider that stops two thirds of the way down reads as unfinished
     rather than as a boundary. */
  align-items: stretch;
}
/* #1445: no optional rules, no second region -- and therefore no divider and no half-surface reserved for
   the word "None". The surface narrows with it (see "surfaceSolo") so one column is a column and not a
   thousand pixels of prose. */
.wr-columns-solo { grid-template-columns: minmax(0, 1fr); }
.wr-secondary {
  border-left: 1px solid #2a2a2a;
  margin-left: 30px;
  padding-left: 30px;
}
.wr-seat {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px max-content;
  column-gap: 12px;
  align-items: center;
}
.wr-columns button:focus-visible,
.wr-columns input:focus-visible { outline: 2px solid #8a8a86; outline-offset: 2px; }
@media (max-width: 899px) {
  .wr-columns { grid-template-columns: minmax(0, 1fr); }
  .wr-secondary {
    border-left: none;
    border-top: 1px solid #2a2a2a;
    margin-left: 0;
    padding-left: 0;
    margin-top: 24px;
    padding-top: 20px;
  }
  .wr-seat {
    grid-template-columns: minmax(0, 1fr) max-content;
    row-gap: 1px;
  }
  .wr-seat > :nth-child(1) { grid-column: 1; grid-row: 1; }
  .wr-seat > :nth-child(2) { grid-column: 1; grid-row: 2; }
  .wr-seat > :nth-child(3) { grid-column: 2; grid-row: 1 / span 2; }
  .wr-touch { min-height: 44px; min-width: 44px; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  /* ==================================================================
      DESIGN NOTE 1100: THE ONE SCREEN THAT NEVER PAINTED ITS OWN GROUND
     ==================================================================
     REPORTED: "the Lobby and Game screens are both full-page in the color scheme, but the Waiting Room has a
     bright white background that is jarring between the two darks." This root declared layout and padding
     only, so the page behind the panel was whatever `body` happened to be -- the user-agent default. Both
     halves are fixed: this root paints itself like its two neighbours, AND `index.html` paints `body`. */
  root: {
    display: "flex",
    flexDirection: "column",
    /* ==================================================================
        DESIGN NOTE 1443: `align-items: center` WAS CENTRING BY SHRINKING
       ==================================================================
       FOUND BY MEASURING, not by looking: this root centred its children by making every one of them
       shrink-to-fit, which is a different thing from centring a full-width child's contents. `AppFooter`
       therefore became as wide as the credit inside it -- so a footer that could not fit the window did not
       merely overflow, it also denied `max-width: 100%` anything to resolve against.
       THE CENTRING MOVES TO `surfaceWrap`, which is where it belongs: that box is full-width and centres the
       surface inside itself, exactly as the Lobby's root does for its content column. */
    minHeight: "100vh",
    width: "100%",
    /* ==================================================================
        DESIGN NOTE 1266: THE STACKING CONTEXT THE PHOTOGRAPH LIVES INSIDE
       ==================================================================
       REPORTED: "clicking Ready in the waiting room causes the screen to zoom in a bit?" -- the scene was a
       background on this root, so it re-fit every time the roster grew. It is a FIXED child at `z-index: -1`
       now, and these two lines are what make that legal: `position: relative` plus `isolation: isolate` make
       this root the stacking context the layer sits in, so it paints above this root's own opaque fill
       instead of behind it. Drop either one and the photograph disappears entirely -- which is exactly what
       #1443 did for one build while rewriting these styles, and what this note is here to prevent next time. */
    position: "relative",
    isolation: "isolate",
    backgroundColor: "#0f0f0f",
    color: "#f2f0eb",
    fontFamily: FONT_FAMILY,
    padding: 0,
    boxSizing: "border-box",
  },
  /* Design note #1266: the photograph on its own FIXED layer at `z-index: -1`, so a growing roster cannot
     re-fit it -- that re-fit was reported as the screen "zooming" on Ready. */
  sceneLayer: {
    position: "fixed",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    backgroundImage:
      "linear-gradient(rgba(8, 8, 8, 0.24), rgba(8, 8, 8, 0.38)), " +
      `url("${process.env.PUBLIC_URL ?? ""}/images/waiting-room.jpg")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  },
  surfaceWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
    padding: "24px 20px 0",
    boxSizing: "border-box",
  },
  /* ==================================================================
      DESIGN NOTE 1112: NEARLY OPAQUE, AND NO BACKDROP BLUR -- RE-MEASURED FOR #1443's WIDTH
     ==================================================================
     0.90 IS A MEASURED FLOOR, NOT A FEEL. A lamp sits directly behind this surface, and it is the brightest
     thing in the photograph; under the 0.24-0.38 wash the ladder's FAINTEST text step has to clear AA there
     or the number is wrong.
     WIDENING TO 1040 COSTS NOTHING, which is the fact this pass had to check rather than assume. The lamp
     (rgb 246, 255, 213) is already inside the old 520px footprint, so the worst case is the SAME pixel at
     both widths: measured 4.66:1 for `#8a8a86`, 9.46:1 for `#c8c6c0` and 14.19:1 for `#f2f0eb` over the
     resulting `rgb(32, 33, 30)`. Past AA on the faintest step, which is what sets the number -- at 0.88 it
     falls under it.
     THE CAP IS THE LOBBY'S. 1040px is what `Lobby.tsx` caps its content column at; a third width for the
     screen between them would be a number with no argument behind it. */
  surface: {
    width: "100%",
    maxWidth: "1040px",
    padding: "26px 30px 30px",
    boxSizing: "border-box",
    borderRadius: RADIUS.layer,
    border: "1px solid #2a2a2a",
    backgroundColor: "rgba(15, 15, 15, 0.90)",
    boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
  },
  /* #1445: with one region the cap comes in, because 980px of definition rows is a label at one edge and a
     value at the other. 720 is about the measure the two-column left region already reads at. */
  surfaceSolo: { maxWidth: "720px" },
  primary: { display: "flex", flexDirection: "column", minWidth: 0 },
  secondary: { display: "flex", flexDirection: "column", minWidth: 0 },

  /* --- where am I --- */
  /* #1444: the page's own name, sized as a label rather than as the subject -- the game below it is what the
     screen is about. Same treatment as the section headings, so the three levels read as one ladder. */
  title: {
    margin: 0,
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  gameName: {
    margin: "3px 0 0",
    fontSize: "26px",
    fontWeight: 800,
    letterSpacing: "0.01em",
    lineHeight: LINE_HEIGHT.tight,
    color: "#f2f0eb",
    overflowWrap: "anywhere",
  },
  roomLine: { margin: "6px 0 0", display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
  gameNote: {
    margin: "8px 0 0",
    fontSize: FONT_SIZE.small,
    color: "#8a8a86",
    lineHeight: LINE_HEIGHT.normal,
    maxWidth: "52ch",
  },
  roomLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  /* #1444: the ADDRESS, not the subject. #1443 unboxed it and left it at 28px -- the size the box had been
     sized for -- which kept the emphasis the game should carry. What survives is everything that makes it
     usable: the monospace, the letter-spacing that stops O and 0 running together when it is read aloud, the
     green it has carried since #1100, and `user-select: all` so one gesture copies the whole code. */
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.12em",
    color: "#7ee0a1",
    userSelect: "all",
  },
  visibilityNote: {
    margin: "5px 0 0",
    fontSize: FONT_SIZE.small,
    color: "#8a8a86",
    lineHeight: LINE_HEIGHT.normal,
    maxWidth: "46ch",
  },

  /* --- sections --- */
  block: { display: "flex", flexDirection: "column", marginTop: "22px", minWidth: 0 },
  sectionHeading: {
    margin: 0,
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: "10px",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#c8c6c0",
  },
  /* #1445: the settings are the last thing in the left column, separated from the action above them by space
     and a rule -- #1443's constraint, and the same separation #1444 used between the two groups before the
     settings moved out of the rail. */
  /* #1446: named for the PLACE rather than for one of its occupants -- the settings and, at one or two
     rules, the house rules are the same kind of block in the same flow. */
  flowSection: { display: "flex", flexDirection: "column", marginTop: "26px", paddingTop: "20px", borderTop: "1px solid #2a2a2a", minWidth: 0 },
  noRulesLine: {
    margin: "14px 0 0",
    paddingTop: "10px",
    borderTop: "1px solid #23231f",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#8a8a86",
  },
  termTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#8a8a86",
    marginRight: "8px",
    whiteSpace: "nowrap",
  },
  noneTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  subHeading: {
    margin: "14px 0 2px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  seatCount: {
    fontWeight: 600,
    letterSpacing: "0.02em",
    textTransform: "none",
    color: "#8a8a86",
    fontVariantNumeric: "tabular-nums",
  },

  /* --- your seat --- */
  nickRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "8px", marginTop: "8px", flexWrap: "wrap" },
  colorRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "7px", marginTop: "10px", flexWrap: "wrap" },
  input: {
    flex: 1,
    minWidth: "140px",
    fontSize: FONT_SIZE.control,
    padding: "7px 10px",
    /* An input is `content-box` by default, so the 44px touch floor would have been 44 PLUS its padding and
       border -- a 60px field beside a 44px button. The border box is what the floor is about. */
    boxSizing: "border-box",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
  },
  swatch: {
    width: "26px",
    height: "26px",
    borderRadius: RADIUS.circle,
    border: "2px solid transparent",
    cursor: "pointer",
    padding: 0,
  },
  // #1449: the shorthand, not `borderColor` -- the base is `2px solid transparent`, so the longhand left a
  // black ring on whichever swatch the player had just left.
  swatchMine: { border: "2px solid #f2f0eb", boxShadow: "0 0 0 2px rgba(226,230,238,0.25)" },
  swatchTaken: { opacity: 0.28, cursor: "not-allowed" },

  /* --- the roster: an open list, hairline separated --- */
  roster: { listStyle: "none", margin: "8px 0 0", padding: 0, minWidth: 0 },
  seat: {
    padding: "8px 0",
    borderBottom: "1px solid #23231f",
    fontSize: FONT_SIZE.body,
    color: "#c8c6c0",
    minWidth: 0,
  },
  emptySeat: { listStyle: "none", padding: "8px 0", fontSize: FONT_SIZE.small, color: "#8a8a86" },
  seatName: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexWrap: "wrap" },
  seatNameText: { fontWeight: 700, color: "#f2f0eb", overflowWrap: "anywhere", minWidth: 0 },
  rosterDot: { width: "10px", height: "10px", borderRadius: RADIUS.circle, flex: "none" },
  hostTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    // Design note #1122: the sandbox heading tone, shared rather than re-picked.
    color: SANDBOX_TITLE,
  },
  youTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#8a8a86",
  },
  seatControls: { display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" },
  ready: { fontSize: FONT_SIZE.small, color: "#7ee0a1", fontWeight: 700 },
  notReady: { fontSize: FONT_SIZE.small, color: "#8a8a86" },

  /* --- prose --- */
  note: { margin: "10px 0 0", fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: LINE_HEIGHT.normal },
  faintNote: { margin: "6px 0 0", fontSize: FONT_SIZE.small, color: "#8a8a86", lineHeight: LINE_HEIGHT.normal },
  figure: { color: "#f2f0eb", fontVariantNumeric: "tabular-nums" },

  /* --- what can I do now --- */
  actionArea: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "24px" },
  actionRow: { display: "flex", flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" },
  button: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: "8px 16px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    cursor: "pointer",
  },
  quietButton: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "4px 9px",
    borderRadius: RADIUS.control,
    border: "1px solid #2e2e2e",
    backgroundColor: "transparent",
    color: "#a8a6a0",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  buttonPrimary: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: "8px 18px",
    borderRadius: RADIUS.card,
    border: "1px solid #2f6f6a",
    backgroundColor: "#14312f",
    color: "#7fe0d0",
    cursor: "pointer",
  },
  buttonStart: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: "8px 18px",
    borderRadius: RADIUS.card,
    border: "1px solid #38bdf8",
    backgroundColor: "#1d3a55",
    color: "#9ec5ff",
    cursor: "pointer",
  },
  buttonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  /* #1443: the watcher's status. A fact about the viewer, written as one -- the tag carries the same blue
     the guest's waiting line uses, because both say "nothing is wrong, and nothing is yours to press". */
  watchStatus: {
    margin: 0,
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: "4px 10px",
    fontSize: FONT_SIZE.small,
    color: "#c8c6c0",
    lineHeight: LINE_HEIGHT.normal,
    maxWidth: "58ch",
  },
  watchTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#9ec5ff",
    border: "1px solid #2f4a68",
    borderRadius: RADIUS.control,
    padding: "2px 8px",
    whiteSpace: "nowrap",
  },
  skipIntro: { display: "flex", flexDirection: "row", gap: "9px", alignItems: "flex-start", marginTop: "4px", cursor: "pointer" },

  /* --- the ante confirmation: the one bounded object left, because it is a state and not a grouping --- */
  readyConfirm: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginTop: "22px",
    padding: "14px 16px",
    borderRadius: RADIUS.card,
    border: "1px solid #2f6f6a",
    backgroundColor: "#12201f",
  },
  confirmTitle: { fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#f2f0eb" },
  kickConfirm: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  kickButton: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    lineHeight: 1,
    padding: "4px 8px",
    borderRadius: RADIUS.control,
    border: "1px solid #5a2f2f",
    backgroundColor: "transparent",
    color: "#c07a7a",
    cursor: "pointer",
  },
  kickButtonConfirm: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    padding: "4px 10px",
    borderRadius: RADIUS.control,
    border: "1px solid #7a3a3a",
    backgroundColor: "#2a1616",
    color: "#e0a0a0",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  /* --- the terms --- */
  terms: { margin: "10px 0 0", padding: 0, minWidth: 0 },
  term: { padding: "8px 0", borderTop: "1px solid #23231f", minWidth: 0 },
  termLine: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" },
  termLabel: { margin: 0, fontSize: FONT_SIZE.small, fontWeight: 700, color: "#f2f0eb" },
  termValue: {
    margin: 0,
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#c8c6c0",
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
    overflowWrap: "anywhere",
  },
  termTick: { color: "#7ee0a1", fontWeight: 800, fontSize: FONT_SIZE.small, lineHeight: LINE_HEIGHT.normal },
  termText: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  variantList: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" },
  variantToggle: { display: "flex", flexDirection: "row", gap: "9px", alignItems: "flex-start" },
  /* Design note #924: these descriptions are the CONTENT of the decision, not a caption on a control whose
     label already carries it, so they take this app's body treatment rather than micro/grey captions.
     #1092 retoned this to `#c8c6c0`, the neutral ladder's secondary-text step. */
  variantNote: {
    margin: "2px 0 0",
    fontSize: FONT_SIZE.small,
    color: "#c8c6c0",
    lineHeight: LINE_HEIGHT.normal,
  },
  notice: {
    fontSize: FONT_SIZE.small,
    lineHeight: LINE_HEIGHT.normal,
    color: "#9ec5ff",
  },
  error: { fontSize: FONT_SIZE.small, color: "#e07a7a", lineHeight: LINE_HEIGHT.normal },
};
