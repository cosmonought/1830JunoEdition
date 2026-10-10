// frontend/src/components/Lobby.tsx
//
// The pre-game screen: room discovery, the off-chain staging room, and the host's Launch -- where a Firestore
// room becomes a real on-chain game. This is what produces the real `gameId` `AppShell` takes.
//
// Design note #0: STAGE OFF-CHAIN, LAUNCH ON-CHAIN. Creating a room does not touch the chain; signing on
// Create was rejected because it litters the contract with dead rooms holding real JUNO, and because it would
// make the lobby unusable without a deployed contract. The cost: a Firestore seat is a RESERVATION, not a
// commitment, which is why the seat list distinguishes "Ready" from "Anted" -- only the second means anything.
//
// Design note #1: the uniform ante is the CONTRACT's rule. The advertised figure is a convenience, not a
// validation -- the contract never reads it, so a rewritten value only gets the joiner rejected. Amounts are
// base-denom INTEGER STRINGS throughout, never numbers.
//
// Design note #2: the `game_id` comes from the TRANSACTION. The client cannot predict `NEXT_GAME_ID`, and a
// failed parse leaves the room in an explicit error state rather than being guessed at -- the transaction
// succeeded and real JUNO has moved, so silently retrying would create a SECOND paid room.
//
// Design notes #3/#24/#524/#525/#527/#586: see `docs/ai_architecture/firebase_middleware.md`.

import React, { useCallback, useEffect, useState } from "react";

import { UiScalePicker } from "./UiScalePicker";
import { FREE_TABLES_OFFERED } from "../utils/tablePolicy"; // PHASE 3 FINAL (§13)
import { isBackendConfigured, backendConfigError } from "../config/backend";
import { preloadWaitingRoomScene } from "./SandboxWaitingRoom";
import {
  CARD_SURFACE,
  INK,
  SANDBOX_INK,
  SANDBOX_PANEL,
  SANDBOX_RAISED,
  SANDBOX_RULE,
  SANDBOX_RULE_STRONG,
  SANDBOX_TEXT,
  SANDBOX_TITLE,
} from "../styles/palette";
import { chromeZoomFor } from "../styles/appStyles";
/* Design note #1294: the chrome scale, live, for the root's zoom and the scene's viewport arithmetic. */
import { useUiScale } from "../utils/useUiScale";
/* W1-O (AUD-16.05): breakpoints asked in the zoomed root's own pixels. */
import { zoomAwareMediaCss } from "../utils/uiScale";
// Design note #524: the sandbox lobby lives on this screen now.
import { createHostedGame, gameIdOf, joinHostedGame, type RoomSetup } from "../utils/sandboxRoom";
/* LIVE-2E: the profile chip (link a device, rotate the key, sign out), and the profile's name as the host's seat name.
   P3-ACCT (public first): signed out, the same corner offers Log in and Create account. */
import { ProfileMenu } from "./ProfileMenu";
import AppFooter from "./AppFooter";
import { profileNickname } from "../utils/profileApi";
/* P3-ACCT: Host, Join and a listed table's Join ask for an account first, then carry on by themselves. */
import { requireAccount } from "../utils/accountPrompt";
import { useSession } from "../utils/useSession";
import { openInfoPage } from "../utils/infoPages";
// #1415: the host's setup card -- type, pace, visibility, then the house rules -- before the room exists; and
// the join card, the code box for an unlisted table.
import { HostSetupCard } from "./HostSetupCard";
import { JoinGameCard } from "./JoinGameCard";
import { LobbyBoards } from "./LobbyBoards";
import { LOBBY_DESIGN_CSS } from "./lobbyDesignCss";
import { roomLinkAvailable } from "../utils/roomLink";
import { JOIN_CODE_EXAMPLE, parseJoinCode, refusalMessage, supportRefOf } from "../utils/roomProtocol";
import { CONTROL_PADDING, FONT_FAMILY, FONT_FAMILY_MONO, FONT_SIZE, LINE_HEIGHT, RADIUS } from "../styles/typography";
import { useMyTables, usePublicRooms } from "../utils/lobby";
import { MyTablesList } from "./MyTablesList";
import type { GameVariants } from "../gameEngine/gameVariants";

// Design note #3: THE SILENT-BUTTON BUG, AND THE RULE THAT REPLACED IT. Reported: clicking "Create Room" did
// nothing -- no UI change, no error banner, and NOTHING in the console. Cause: the button was `disabled`, so
// the browser DISCARDED THE CLICK BEFORE REACT SAW IT. A silent no-op is correct for a disabled button; the
// bug is that it did not look disabled -- and it could not, because inline `React.CSSProperties` cannot
// express `:disabled`. Eleven buttons here were disabled somewhere in their lifecycle and none looked it, so
// this was eleven identical traps.
// TWO RULES NOW, AND THE SECOND MATTERS MORE:
//   1. Never `disabled` without the disabled style.
//   2. PREFER A LOUD FAILURE TO A DISABLED CONTROL. Disabling is reserved for "already in flight"; every other
//      precondition leaves the button ENABLED and reports the specific reason when clicked.
// This inverts the usual instinct: a disabled button answers "can I do this?" with silence and leaves the user
// guessing which of four preconditions they missed, while an enabled button that says "Connect a wallet first
// -- the room is stored under your address as host" answers the question they actually have. The precondition
// is still enforced in the handler; the only change is that refusing now explains itself.

export interface LobbyProps {
  /** LIVE-2D: enter a server-owned table by its `gameId` -- after Host (the server seated the host), Join (the server
   *  seated this principal, or admitted it to watch), or Watch on a public row (no op at all: a public table is
   *  readable by any signed-in profile). The shell opens the table's RoomView and log by that id; the seat, if
   *  any, is the server's answer in `RoomView.you`, never this screen's. */
  onEnterSandbox: (gameId: string) => void;
  /** PHASE 3 W3-J (OD-19, AUD-25.16): the public list's Watch -- the table opened as a READ-ONLY spectator view, even
   *  when this principal holds a seat at it ("Watch this game. You will not have a seat."). A seat is re-entered
   *  through "Your tables", which keeps `onEnterSandbox`. Omitted: Watch falls back to `onEnterSandbox` (no caller
   *  does this; it keeps the prop optional for the component's own tests). */
  onWatchSandbox?: (gameId: string) => void;
}

/* ==================================================================
    LIVE-2D (RUST-RETIRE-1 2B.3): THE ON-CHAIN STAGING LOBBY IS DELETED
   ==================================================================
   #525 parked it behind `WEB3_LOBBY_ENABLED = false`, LIVE-0 switched its server half off, and LIVE-2 scheduled its
   removal here: the room browser, the staging table, `CreateGameRoom` / `JoinGameRoom` launch and ante,
   `bind-chain-game-id`, the wallet-keyed seats and heartbeats. Money tables return through the escrow contract
   (ESCROW-3), not through this path. The wallet furniture in the corner stays -- Keplr connect is kept. */

/* PLAY LOBBY (approved design): the photograph scene and its cover arithmetic (#1131 / #1144 / #1440) are gone with
   the full-page picture -- the header is the design's two columns, and the boardroom drawing sits in its own masked
   box (`lobbyDesignCss.ts`). The notes below record why the scene was built the way it was. */
/* ==================================================================
    DESIGN NOTE 1440: THE PICTURE IS TOP-ANCHORED, BECAUSE THE PAGE NOW HAS A BOTTOM
   ==================================================================
   #1131 CENTRED THE SCENE IN ITS CLIP AND #1133 RAN THE CLIP TO THE FOOT OF THE PAGE, and both were right
   about a page that was ONE SCREEN: with nothing below the buttons, a centred picture is the picture, and a
   clip that stopped at 100vh left a band of bare ink the footer's strip ran into.
   THE PUBLIC LIST GIVES THE PAGE A SECOND HALF. Twenty-four rooms is several thousand pixels, and a scene
   centred in a clip that tall would slide the photograph -- and with it the title and the two buttons
   anchored INSIDE it -- down to the middle of the scroll. The band #1133 fixed is gone for the better
   reason: there is content under the picture now, not emptiness.
   SO THE SCENE'S TOP EDGE IS PINNED TO THE HERO'S. `translate(-50%, -50%)` still does the centring, so `top`
   is half the scene's own height -- which is why the height expression appears twice here rather than in a
   local: `lobbyHeroBand.test.ts` asserts the `height:` declaration verbatim, and a `const` would have moved
   the ratio out of the line that guards it.
   NOTHING ELSE MOVES. The scene is at least the viewport tall (both `max()`s), so on a one-screen lobby the
   photograph, the title and the buttons are where they were; the hero window below simply stops the picture
   above the fold instead of below it. */

/* ==================================================================
    DESIGN NOTE 1440: THE HERO IS A WINDOW ON THE PICTURE, NOT THE WHOLE PAGE
   ==================================================================
   RULED: "Once games are available, the list should be easy to find below the main actions, not buried far
   down by a full-height hero."
   A 100vh HERO PUTS THE FIRST ROOM AT 100vh, which is exactly one scroll of nothing between the buttons a
   player just read and the list they were sent to. The window is 74% of the viewport instead, with a floor
   so a short laptop does not crop the title into the utility row: the photograph runs past the buttons at
   70% and stops, and the list starts where it ends.
   THE PICTURE IS NOT RESIZED, ONLY CROPPED. Shrinking the scene would move every anchor inside it (#1131);
   cropping the bottom of a top-anchored scene moves nothing -- the title and the buttons keep their exact
   positions, and what is lost is the foreground edge of the table below them.
   [P3-N028, below: the window is now the top region's MINIMUM height -- a floor, not a clip the doors hang in.] */
const HERO_MIN_PX = 520;
const HERO_SHARE = 74;
/* ==================================================================
    PHASE 3 (P3-N028, REOPENED 2026-10-06): THE TOP REGION OWNS ITS HEIGHT, AND THE TABLES START BELOW IT
   ==================================================================
   REPORTED AGAIN BY THE OWNER (playtesting, ~300% viewing scale): "Your Tables" covering Host / Join. P3-N028 is not
   closed while that is reproducible.
   WHY THE FIRST FIX COULD NOT HOLD. It kept the doors ABSOLUTELY positioned inside the photograph (`top: 70%` of a
   `cover` scene, clamped into the window) and the list in the flow, and it bridged the two with a NUMBER: the doors'
   foot, measured (`getBoundingClientRect`, divided by the zoom, `ResizeObserver` + `resize`) and written back as the
   height of an empty spacer. The boundary was therefore a copy -- of a measurement taken in one coordinate system
   (the zoomed scene) and replayed in another (the flow) one render later -- correct only after every observer had
   fired, in the right order, in an engine whose client rects agreed with this file's division by the zoom. Until the
   copy landed (the first frames after a load, a resize, a sign-in or a reflow), and wherever it never landed, the list
   was laid out over the doors: measured-height luck, which is exactly what the owner ruled out.
   THE BOUNDARY IS STRUCTURAL NOW, AND NOTHING IS MEASURED:
     1. the TOP REGION (`styles.top`, `lobby-top`) is a normal-flow block holding the account corner, the title and the
        doors, all in flow -- so its height IS its content's, never less than the hero window (`minHeight`);
     2. the photograph is that region's DECORATIVE BACKGROUND and nothing more (`sceneClip`: absolute, `inset: 0`,
        clipped to the region, `pointer-events: none`, painted under the region's flow content) -- it positions nothing;
     3. an explicit BOUNDARY (`lobby-boundary`) follows the region, and then the TABLES REGION (`lobby-tables`: "Your
        tables", the public list, their loading / empty / error states, the banners) as a normal-flow sibling with no
        absolute position, no negative margin, no transform and no offset.
   So a taller corner (wrapped, signed in, a wallet), a larger text size, a wrapped door row or an error under it makes
   the TOP REGION taller and moves the tables DOWN -- at every window, zoom and font, in the very frame it happens.
   THE COMPOSITION (#1131) SURVIVES AS MARGINS, NOT COORDINATES. The scene keeps its exact cover arithmetic
   (`sceneSizeFor`, top-anchored), and the flow aims the title's foot at 40% of it and the doors' centre at 70%,
   clamped into the hero window as #1441 / P3-ACCT did -- computed in CSS from the scene's own size (`topRegionVars`),
   so on the window it was tuned on the picture and the controls line up as before. The aim assumes a one-line corner
   and a one-line row; when either is taller, everything below it moves down rather than under anything. */
/** #1131's composition, as fractions of the scene's height: the title's foot ("at the lowest" 0.4) and the doors'
 *  centre (the table, 0.7). */
const TITLE_FOOT_OF_SCENE = 0.4;
const DOORS_CENTRE_OF_SCENE = 0.7;
/** #1131: the wordmark is 20% of the scene wide (at least 230px); the artwork is 900 x 617. P3-N028: the 230px floor
 *  gives way on a very short window (at most half the window's height wide), so the corner, the title and the doors
 *  stack inside it instead of the title being laid over the corner (what the absolute layout did at ~300%). */
const WORDMARK_SHARE_OF_SCENE = 0.2;
const WORDMARK_MIN_PX = 230;
const WORDMARK_MAX_SHARE_OF_WINDOW = 0.5;
/** The aim's assumptions only (never a measurement): the account corner's one-line height (its 14px top padding
 *  plus a row of small pills) and half the doors' one-line height (#1136's 45px control). */
const UTILITY_ROW_NOMINAL_PX = 44;
const DOORS_HALF_NOMINAL_PX = 23;
/** P3-ACCT, kept: the doors' least distance from the hero window's foot, and from the title above them. */
const ACTIONS_WINDOW_MARGIN_PX = 20;
const ACTIONS_TITLE_GAP_PX = 12;
/** P3-ACCT, kept: the least space under the doors, inside the top region. */
const ACTIONS_GAP_PX = 24;

/** P3-N028: the top region's lengths, in the zoomed root's layout space (every viewport term divided by the scale,
 *  #1144/#1294). Pure CSS arithmetic of the window -- nothing here reads the DOM. */
export function topRegionVars(scale: number): React.CSSProperties {
  return {
    /* The hero window (#1440): the top region's floor. */
    "--lobby-hero-window": `min(${100 / scale}vh, max(${HERO_MIN_PX}px, ${HERO_SHARE / scale}vh))`,
    /* The window's own height, for the wordmark's floor. */
    "--lobby-window-h": `${100 / scale}vh`,
    /* The scene's own box -- `cover` of the window (#1131/#1144), the same arithmetic as `sceneSizeFor`. */
    "--lobby-scene-w": `max(${100 / scale}vw, calc(${100 / scale}vh * 1920 / 1072))`,
    "--lobby-scene-h": `max(${100 / scale}vh, calc(${100 / scale}vw * 1072 / 1920))`,
  } as React.CSSProperties;
}

/** The wordmark's width: 20% of the scene, at least 230px (#1131) unless the window is too short for that. The column
 *  caps it too (`maxWidth` on `titleAnchor`). */
const WORDMARK_WIDTH = `max(min(${WORDMARK_MIN_PX}px, calc(var(--lobby-window-h) * ${WORDMARK_MAX_SHARE_OF_WINDOW})), calc(var(--lobby-scene-w) * ${WORDMARK_SHARE_OF_SCENE}))`;
const WORDMARK_HEIGHT = `${WORDMARK_WIDTH} * 617 / 900`;
/** The title's flow offset under the corner: its foot at 40% of the scene (#1131), never closer than 16px to the
 *  corner (#1354's safe line, now simply flow). */
export const TITLE_MARGIN_TOP = `max(16px, calc(var(--lobby-scene-h) * ${TITLE_FOOT_OF_SCENE} - ${WORDMARK_HEIGHT} - ${UTILITY_ROW_NOMINAL_PX}px))`;
/** Where the title's foot lands under a one-line corner: 40% of the scene, or lower when the corner and the title
 *  need more (the margin above, resolved). */
const TITLE_FOOT = `max(calc(var(--lobby-scene-h) * ${TITLE_FOOT_OF_SCENE}), calc(${UTILITY_ROW_NOMINAL_PX + 16}px + ${WORDMARK_HEIGHT}))`;
/** The doors' flow offset under the title: their centre at 70% of the scene, clamped into the hero window (P3-ACCT's
 *  clamp: half the row and 20px inside it), and never closer than 12px to the title. */
export const ACTIONS_MARGIN_TOP = `max(${ACTIONS_TITLE_GAP_PX}px, min(calc(var(--lobby-scene-h) * ${DOORS_CENTRE_OF_SCENE} - ${DOORS_HALF_NOMINAL_PX}px - ${TITLE_FOOT}), calc(var(--lobby-hero-window) - ${2 * DOORS_HALF_NOMINAL_PX + ACTIONS_WINDOW_MARGIN_PX}px - ${TITLE_FOOT})))`;

export function Lobby({ onEnterSandbox, onWatchSandbox }: LobbyProps) {
  /* Design note #1294: the chrome scale, live. */
  const uiScale = useUiScale();
  /* P3-N028 (reopened): NOTHING ON THIS SCREEN IS MEASURED. #1354's utility-row observer and P3-ACCT's door
     observer are gone with the absolute layout they corrected: the corner, the title and the doors are flow content
     of the top region, so the region's height is theirs and the tables follow it (see `topRegionVars`). */
  /* Design note #524: the sandbox room handlers. Local to this screen -- the game id is handed straight to
     `onEnterSandbox` and this component unmounts, so there is nothing to keep. */
  const [sandboxRoomError, setSandboxRoomError] = useState<string | null>(null);
  const [sandboxRoomBusy, setSandboxRoomBusy] = useState(false);

  /* Design note #1258: the next screen's photograph, fetched while this one is up. */
  useEffect(() => {
    preloadWaitingRoomScene();
  }, []);

  /* #1415: Host opens the setup card; the table is created with what the host chose there. Join opens the code box.
     LIVE-2D: both are `room-op`s the server answers -- a game id, a code and a seat it minted, or a named refusal. */
  const [hostSetup, setHostSetup] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const publicRooms = usePublicRooms();
  /* P3-ACCT (public first): who is looking -- a visitor browses; Host and Join ask for an account first. */
  const session = useSession();
  const signedIn = session.state === "ready" && session.account !== null;
  /* LIVE-2F/3D (C9-01): the tables this profile sits at -- the way back to a seat from any tab or browser (signed in
     only: a visitor sits nowhere, and the server answers it nothing). */
  const myTables = useMyTables(signedIn);

  /** A refusal, said as a sentence a player can act on; an internal failure's reference goes to the console only. */
  const sayRefusal = useCallback((code: string, reason: string): string => {
    const ref = supportRefOf(reason);
    // eslint-disable-next-line no-console
    if (ref !== null) console.warn(`[lobby] the server refused (${code}); support reference ${ref}`);
    return refusalMessage(code, reason);
  }, []);

  const handleHostSandboxRoom = useCallback(
    async (variants: GameVariants, setup: RoomSetup) => {
      setSandboxRoomBusy(true);
      setSandboxRoomError(null);
      try {
        if (!roomLinkAvailable()) {
          setSandboxRoomError("The game server is not configured in this build.");
          return;
        }
        /* LIVE-2E: the lobby has no name field, so the host's seat starts with the profile's name. */
        const answer = await createHostedGame(variants, setup, profileNickname());
        const gameId = gameIdOf(answer);
        if (!answer.ok || gameId === null) {
          setSandboxRoomError(answer.ok ? refusalMessage("internal") : sayRefusal(answer.code, answer.reason));
          return;
        }
        setHostSetup(false);
        onEnterSandbox(gameId);
      } finally {
        setSandboxRoomBusy(false);
      }
    },
    [onEnterSandbox, sayRefusal],
  );

  /* Design note #1440: the join, with its verdict RETURNED as well as shown -- the code box reports beside its own
     field, a listed row beside that row. LIVE-2D: `room-op join {code, takeSeat: true}`; the server answers the game
     id and the seat it gave, or `invalid-or-expired` / `room-full` / `kicked` / `rate-limited` / `limit-reached`. */
  const [roomRefusal, setRoomRefusal] = useState<{ code: string; reason: string } | null>(null);
  const handleJoinSandboxRoom = useCallback(
    async (raw: string): Promise<string | null> => {
      const code = parseJoinCode(raw);
      if (!code) {
        const reason = `That is not a table code — they look like ${JOIN_CODE_EXAMPLE}.`;
        setSandboxRoomError(reason);
        return reason;
      }
      setSandboxRoomBusy(true);
      setSandboxRoomError(null);
      try {
        const answer = await joinHostedGame(code, true);
        const gameId = gameIdOf(answer);
        if (!answer.ok || gameId === null) {
          const reason = answer.ok ? refusalMessage("internal") : sayRefusal(answer.code, answer.reason);
          setSandboxRoomError(reason);
          return reason;
        }
        setJoinOpen(false);
        onEnterSandbox(gameId);
        return null;
      } finally {
        setSandboxRoomBusy(false);
      }
    },
    [onEnterSandbox, sayRefusal],
  );

  /* The same join, said on the row it was asked from. A success unmounts this screen, so the only state kept
     is the refusal -- and it is cleared the moment another row is tried. */
  const handleJoinListedRoom = useCallback(
    async (code: string) => {
      setRoomRefusal(null);
      const reason = await handleJoinSandboxRoom(code);
      setRoomRefusal(reason === null ? null : { code, reason });
    },
    [handleJoinSandboxRoom],
  );

  /* P3-ACCT: the three doors that seat somebody ask for an account first and carry on by themselves once signed in
     (`requireAccount`). Watch and the rules never ask (OD-19: Watch is read-only for everyone). */
  const openHost = useCallback(() => {
    setSandboxRoomError(null);
    requireAccount(() => setHostSetup(true), "Log in or create an account to host a game.");
  }, []);
  const openJoin = useCallback(() => {
    setSandboxRoomError(null);
    requireAccount(() => setJoinOpen(true), "Log in or create an account to join a game.");
  }, []);
  const joinListed = useCallback(
    (code: string) => {
      setRoomRefusal(null);
      requireAccount(() => void handleJoinListedRoom(code), "Log in or create an account to join this table.");
    },
    [handleJoinListedRoom],
  );

  const backendError = backendConfigError();


  /* ---------------- Render ---------------- */

  return (
    <div style={{ ...styles.root, ...chromeZoomFor(uiScale) }}>
      {/* Design note #46 is the standing exception and this is the case it exists for: neither a keyframe nor
          a media query can be expressed as an inline style object.
          Design note #1130: #1123's 860px breakpoint is GONE WITH ITS GRID -- one centred column needs no
          collapse, and the wordmark's own `min(520px, 84vw)` handles the narrow case inline. What is left is
          the title's entrance, wrapped in `prefers-reduced-motion` because a thing that moves on load is
          exactly what that query exists to switch off. */}
      {/* W1-O (AUD-16.05): the narrow amendment switches at the same effective width at every text size. */}
      <style>{zoomAwareMediaCss(LOBBY_CSS, uiScale)}</style>
      {/* ==================================================================
           P3-N028 (REOPENED): THE TOP REGION -- THE CORNER, THE TITLE AND THE DOORS, IN FLOW
          ==================================================================
          One normal-flow block that owns its height (at least the hero window): the account corner, then the
          stage (title, Host / Join), with the photograph as its background only. It ends at `lobby-boundary`;
          the tables region is the next thing in the column. See `topRegionVars`. */}
      <style>{zoomAwareMediaCss(LOBBY_DESIGN_CSS, uiScale)}</style>
      <div style={styles.topBand} data-testid="lobby-top">
      {/* ==================================================================
           DESIGN NOTE 1130: THE UTILITY ROW LEAVES THE TITLE ALONE
          ==================================================================
          PROPOSED as "move the Display name input, the Connect button and the offline badge to a top-right
          pinned utility row. This matches standard Web3 application patterns." AGREED, and the reason is
          better than the precedent: these three are ACCOUNT furniture. They are the same three things in the
          same corner of every wallet-facing app because they answer "who am I and is this connected", which
          is a question you ask once and then stop asking.
          #1129 HAD PUT THEM UNDER THE TITLE, inside the hero plate, on the argument that a centred title with
          controls pinned right "reads as two designs sharing a row". That was true of a plate holding both.
          With the account furniture moved to its own corner there is no row left to share -- the title gets
          the middle of the screen to itself, which is what a title is for. */}
      <div style={styles.utilityRow}>
        {/* ==================================================================
             DESIGN NOTE 1131: THE PILL GOES LEFT, AND THE ROW BECOMES TWO GROUPS
            ==================================================================
            RULED: "move 'Offline · sandbox active' to the left side of the screen."
            AND IT WAS NEVER ACCOUNT FURNITURE, which is what the right-hand group is for. #1130 put it there
            because it was the third small thing on the screen and the row was where small things had gone.
            The name, the wallet and the balance answer "who am I"; this answers "what is this build talking
            to", which is a fact about the WORLD. Opposite ends of the row is the right expression of that.
            THE OFFSET IT WAS ASKED TO FIX IS ALREADY GONE, and this is worth recording so the next reader
            does not go looking for it: the title was pushed down by the flow header it used to live in, and
            #1131 anchored it to the scene instead, where nothing above it can move it. The pill moves because
            the left is where it belongs, not because the title still needs the room. */}
        {/* PHASE 4 (owner): the "Offline · sandbox active" pill is gone. It reported the parked on-chain mode's
            REACT_APP_CONTRACT_ADDRESS configuration and said every table was a no-money table -- untrue on a build
            pinned to the Escrow 2.1 deployment, where tables are anted. Real failures are still said where they
            happen: the game server's connection (the session and room notices) and the escrow pin (the money panel). */}
        <div style={styles.utilityAccount}>
        {/* P3-ACCT: the rules are public -- a visitor reads them here, no account needed. */}
        <button type="button" style={styles.rulesButton} onClick={() => openInfoPage("rules")} data-testid="lobby-rules">
          Rules
        </button>
        {/* LIVE-2E: who this browser plays as -- the account chip, first in the account corner. Its menu changes the
            password or the Authorization Wallet and signs devices out. Signed out: Log in and Create account. */}
        <ProfileMenu />
        {/* Design note #1336: the text-size control, on the first screen a player sees. The same component
            as the bars'; the scale it writes is the one every later screen reads. */}
        <UiScalePicker />
        {/* Design note #1133: the lobby's Display Name field served only the parked Web3 staging lobby, and went with
            it (LIVE-2D). A seat's name is set in the waiting room.
            PHASE 3 FINAL (§12): the parked on-chain mode's Connect / address / balance / Disconnect chip is gone from this
            corner too. A connected Keplr address beside the account chip answered "who am I" -- the question the owner
            ruled only the PROFILE answers. Keplr is reached where it signs: a seat's money panel, the account's
            Authorization Wallet steps. */}
        </div>
      </div>

      {/* ==================================================================
           DESIGN NOTE 1131: A SCENE WITH COORDINATES -- NOW THE TOP REGION'S BACKGROUND ONLY (P3-N028)
          ==================================================================
          RULED, with the positions given directly: "y0.4 x0.5 is where I'd have the Project 18XX at the
          lowest, x0.4y0.7 and x0.6y0.7 is where I'd put the Host Game and Join Game buttons."
          `.scene` is sized `max(100vw, 100vh * 1920/1072)` by `max(100vh, 100vw * 1072/1920)` and top-anchored --
          precisely what `cover` computes, done in CSS so the photograph's framing is the same feature on every
          screen. P3-N028 (reopened) KEEPS THAT BOX AND STOPS HANGING CONTROLS IN IT: the title and the doors are
          flow content of the top region (below), aimed at 0.4 and 0.7 of this same box by CSS arithmetic, so the
          picture is decoration that can position nothing and cover nothing. `sceneClip` is the region's own size
          (`inset: 0`), clipped to it, `pointerEvents: none`, and painted beneath the region's flow content. */}
      {/* ==================================================================
           PLAY LOBBY (approved design, "play-lobby-handoff" §2): THE HEADER
          ==================================================================
          Ludum's lockup for Project 18XX -- PROJECT in Anton, 18XX in Anton under the gilt gradient -- the line, and
          the two doors (Host game, Join by code: the same handlers as before, account first), beside Ludum's boardroom
          drawing, masked into the page. On phones the drawing is a full-width backdrop with the title set into its lower left. The doors' refusal shows
          under them, as the bar did. */}
      <div className="lb" style={styles.heroWrap}>
        <section className="lb-hero" aria-labelledby="lobby-title">
          <div className="lb-hero-l">
            <h1 className="lb-lockup" id="lobby-title">
              <span className="lb-name">Project</span>{" "}
              <span className="lb-num">18XX</span>
            </h1>
            <p className="lb-dek">Railroads, a stock market, and the people who run both. Take a seat at a table below, or open one of your own.</p>
            {isBackendConfigured() ? (
              <div className="lb-doors" data-testid="lobby-actions">
                <button type="button" className="lb-btn lb-primary" onClick={openHost} disabled={sandboxRoomBusy} data-testid="lobby-host">
                  Host game
                </button>
                <button type="button" className="lb-btn" onClick={openJoin} disabled={sandboxRoomBusy} data-testid="lobby-join-code">
                  Join by code
                </button>
              </div>
            ) : null}
            {sandboxRoomError !== null && !joinOpen && !hostSetup && (
              <p className="lb-door-error" role="alert" data-testid="lobby-door-error">
                {sandboxRoomError}
              </p>
            )}
          </div>
          <figure className="lb-hero-art" aria-hidden="true">
            <img alt="" src={`${process.env.PUBLIC_URL ?? ""}/images/p18-board-meeting.webp`} />
          </figure>
        </section>
      </div>
      {/* The top region ends here (`lobby-top`). */}
      </div>

      {/* P3-N028 (reopened): THE HARD BOUNDARY. The top region above ends here, in flow; every table-related box --
          "Your tables", its rows and error, the public list and its loading / empty states, the banners -- is in the
          region after it. Nothing on either side is positioned against the other, so the boundary is the document's
          own order: it cannot be crossed by a measurement arriving late, because there is none. */}
      <div style={styles.boundary} role="presentation" aria-hidden="true" data-testid="lobby-boundary" />

      {/* Design note #1114: the width cap.      {/* Design note #1114: the width cap. The HEADER stays full-bleed above it -- its own background is a
          band across the window and capping it would leave two stripes of root either side -- so the cap
          wraps everything below instead, which is the part that actually stretches. */}
      {/* ==================================================================
           DESIGN NOTE 1360: THE CARDS LIVE AT THE ROOT, NOT IN THE SCENE
          ==================================================================
          REPORTED: on the "Rejoin a game" card "they try clicking Rejoin or anything else on the screen and
          nothing happens (the cursor doesn't even switch to indicate clickability)". No `[seat]` line in the
          console: the clicks never reached the buttons.
          `sceneClip` IS `pointer-events: none` (#1131, so the photograph does not swallow the footer's clicks)
          and the value INHERITS -- a `position: fixed` card mounted inside it is a card nobody can click. Both
          cards sat there because they were written beside the bar that opens them. They sit here now, outside
          the scene, and each card's backdrop says `pointerEvents: "auto"` itself so no ancestor can do this
          to them again. Enter "worked" only because the PIN field had focus and resubmitted the lookup. */}
      {/* #1415: the host's setup card, at the root for #1360's reason. */}
      {/* [Superseded in part by W3-D, below: the wrapper this note describes is removed, and the "later batch" that
          would make this screen `inert` is ruled out by OD-15(b).] #1648: the pilot for the modal layer. The mount lifecycle is unchanged -- `hostSetup` still decides
          whether the card exists, and closing still unmounts it, which is still what resets every selection.
          Only the DOM destination moved: the card now renders into the layer beside this screen rather than
          inside it, so a later batch can make this screen `inert` without disabling the dialog. React context
          and event bubbling follow the React tree, not the DOM, so everything this card is handed still
          arrives and `onClose` still runs here. */}
      {/* Phase 3 W3-D (OD-15(b), AUD-13.06): THE PILOT'S WRAPPER IS GONE. `HostSetupCard` has been a `NativeModal` since
          #1651, and `NativeModal` puts its own `<dialog>` in the layer -- so this outer `ModalPortal` was a second,
          redundant route into the same host, and the last one outside `NativeModal`. The DOM is unchanged: the
          dialog lands in the layer exactly as before, and `hostSetup` still decides whether the card exists. */}
      {hostSetup && (
        <HostSetupCard
          busy={sandboxRoomBusy}
          error={sandboxRoomError}
          onClose={() => setHostSetup(false)}
          onCreate={(variants, setup) => void handleHostSandboxRoom(variants, setup)}
        />
      )}
      {/* Design note #1440: the code box alone -- the public list moved onto the page (`LobbyRoomList`).
          Watching a game is entering the room with no seat, which is the shell's own watcher path, so the
          list's Watch is `onEnterSandbox` with no join write first. */}
      {joinOpen && (
        <JoinGameCard
          error={sandboxRoomError}
          busy={sandboxRoomBusy}
          onClose={() => {
            setJoinOpen(false);
            setSandboxRoomError(null);
          }}
          onJoin={(code) => void handleJoinSandboxRoom(code)}
          onClearError={() => setSandboxRoomError(null)}
        />
      )}
      {/* P3-N028 (reopened): THE TABLES REGION -- a normal-flow sibling after the boundary. No position, offset,
          transform or negative margin here or on anything in it that could lift it into the top region. */}
      <div style={styles.content} data-testid="lobby-tables">

      {/* ==================================================================
           DESIGN NOTE 1440: THE PUBLIC ROOMS, BELOW THE TWO DOORS
          ==================================================================
          RULED: "Move the public-game list below the Lobby's Host Game / Join Game actions, using the
          existing room-list data and existing eligibility rules."
          THE DATA IS THE SAME SUBSCRIPTION #1415 OPENED -- `useSandboxRooms`, the server's `rooms` frame
          pushed on every room write -- read here instead of being handed to a modal. Private rooms are not
          in it and never were: the server drops them before the frame is built (`gameServer.ts`,
          `doc.visibility !== "public") continue;`), which is why nothing on this side has to filter.
          THE REFUSAL LANDS ON THE ROW. A join attempted from a row eight hundred pixels down cannot report
          itself beside the buttons at the top of the page, which is where `SandboxRoomBar` carries the
          bar's own errors; `attemptJoinSandboxRoom` returns the reason so both callers can say it where
          the player is looking. */}
      {/* LIVE-2F/3D (C9-01): "Your tables" above the public list -- a private table is in no list but this one, and
          after the deal its code no longer opens it. Hidden when there is nothing to show. */}
      {signedIn ? <MyTablesList tables={myTables.tables} error={myTables.error} onOpen={(gameId) => onEnterSandbox(gameId)} /> : null}
      <div className="lb">
        <LobbyBoards
          rooms={publicRooms.rooms}
          loading={publicRooms.loading}
          error={publicRooms.error}
          available={publicRooms.available}
          busy={sandboxRoomBusy}
          refusal={roomRefusal}
          onJoin={joinListed}
          /* LIVE-2D: Watch needs no op -- a public table is readable by any profile; the shell opens its RoomView and log
             by game id, and the viewer holds no seat. PHASE 3 W3-J (OD-19): its OWN door (`onWatchSandbox`). */
          onWatch={(gameId) => (onWatchSandbox ?? onEnterSandbox)(gameId)}
          /* PHASE 3 FINAL (§13): every player game is anted -- a no-ante table is Watch only (`utils/tablePolicy.ts`). */
          noAnteSeats={FREE_TABLES_OFFERED}
        />
      </div>

      {/* Honest, specific banners -- never a silently empty screen. Each
          names what is missing and what still works without it. */}
      {!isBackendConfigured() && <Banner tone="error" text={backendError ?? "The game server is not configured."} />}
      {/* ==================================================================
           DESIGN NOTE 1114: A STATUS, NOT A WARNING
          ==================================================================
          THE BANNER WAS AN AMBER SLAB carrying the whole `chainConfigError()` sentence, which names an
          environment variable and a rebuild requirement. That is a true thing to tell a developer and the
          wrong thing to put at the top of the screen a player opens.
          A PILL RATHER THAN A `<details>` ACCORDION, which was the other option offered. An accordion is a
          control that invites opening; this does not want opening by most of the people who see it, and the
          full text is already available on hover where a developer will look for it.
          AND IT IS NOT AMBER. #1094 freed amber to mean "heads up, nothing is broken", and this is one step
          quieter than that: nothing here is wrong, the app is doing exactly what an unconfigured build
          should. The neutral chip is the same one `CHIP_INERT` uses for a genuinely inert fact. */}
      {/* PHASE 3 FINAL (§12): the parked on-chain mode's wallet-error banner went with its Connect chip. */}


      {/* The escape hatch (`App.tsx #24`), placed OUTSIDE the room-browser branch so it is reachable in every state
         this screen can be in -- including the states that motivated it: Firebase unconfigured, no wallet, no rooms,
         or stuck in a staging room that can never launch because the contract address is a placeholder.
         Deliberately has NO `disabled` condition of any kind. It is the one control on this screen that must work
         when everything else is broken, which is exactly why it must never be gated on any of the things that might
         be broken. */}
      {/* Design note #586: THE OFFLINE STRIP IS GONE. #578 removed solo sandbox and this button outlived it by one
         pass -- so the Lobby went on offering an "Offline Sandbox" that landed on a screen asking the player to host
         a room. A door labelled for a room that no longer exists.
         NOTHING TO MERGE: both strips called the same handler, and that single handler is the only path into the
         shell. There was never a second branch behind the second button -- which is why deleting the button is the
         whole change. */}

      {/* Design note #524: THE MULTIPLAYER DECISION IS A LOBBY DECISION. #522 mounted this strip inside the game
         shell, which put "host or join" BEHIND "enter the sandbox" -- so two playtesters had to open the board
         separately, find a strip neither knew was there, and only then discover each other: a multiplayer feature
         whose first step was for everyone to go and play alone.
         HOSTING ENTERS IMMEDIATELY. The alternative -- show the code, wait for a start -- is a staging room, and the
         Web3 lobby already has one for a flow that genuinely needs it. A sandbox room needs none of that: the code is
         on the board's own strip, and a joiner can arrive at any point because the log replays. */}
      {/* ==================================================================
          DESIGN NOTE 1130: THE CARD COMES OFF, SUPERSEDING #1123's GRID
         ==================================================================
         ASKED: "I wonder if there's a way we could eliminate the boxes altogether, and instead have the Host
         Game and Join Game buttons rendered directly on top of the table?"
         YES, AND IT IS THE BEST IDEA IN THE BATCH. #1123 built two columns because there were two cards to
         place; removing the paused card leaves one, and that one turns out not to need a card at all. A panel
         is a device for grouping things that would otherwise scatter -- with one sentence and two buttons
         there is nothing to gather, and the box was drawing a boundary around the entire contents of the
         screen.
         NOT ANCHORED TO THE TABLE, DELIBERATELY, and this is the one place the request is not taken
         literally. The table is a region of a `cover`-cropped photograph: it moves with the viewport's aspect
         ratio, so a control pinned to it would slide off it on the first window of a different shape. The
         stage is CENTRED instead, which puts the buttons over the table on the aspect the picture was framed
         for and somewhere sensible on every other -- the effect that was asked for, by a means that survives
         a resize.

         WHAT #1123 GOT RIGHT AND THIS KEEPS: the Web3 branch below is still full-width and still outside this
         block. "On-chain rooms -- paused" was a card only because the flag is off; flip it and that slot
         renders a room list and a staging table, which never belonged in a half-width sidebar.

         ==================================================================
          DESIGN NOTE 1130: THE PAUSED CARD IS GONE, AND THE ARGUMENT FOR IT WAS BACKWARDS
         ==================================================================
         PROPOSED as "remove it entirely -- we are designing for the final production state, so we don't need
         to dedicate half the screen to a non-actionable disabled feature."
         THE CONCLUSION IS RIGHT AND THE REASONING IS INVERTED. In the final production state the flag is ON
         and this area renders `RoomBrowser`; designing for production is exactly what #1123 did by giving that
         branch the full width below. Deleting this card does not design for production -- it removes today's
         placeholder, which is a smaller and entirely good thing.
         THE REAL CASE AGAINST IT IS #1119's. Its body named `WEB3_LOBBY_ENABLED` and `Lobby.tsx` -- a build
         variable and a filename, on the first screen a player opens, which is the exact category of text that
         batch spent its whole length removing. It was the last one left.
         THE SENTENCE IS NOT LOST: it moved into the offline pill's tooltip, where a developer will look and a
         player will not -- the same move #1119 made with the missing env var. */}
      {/* ==================================================================
           DESIGN NOTE 1131: THREE LINES OF COPY, NONE OF THEM NECESSARY
          ==================================================================
          RULED: "I'm not sure any of 'Pre-game lobby · rooms stage off-chain and cost nothing until launch',
          'Real-time multiplayer sandbox. Host a room, or join with a room code.' or 'Sandbox multiplayer'
          are necessary." THEY ARE NOT, AND THE REASON IS THE SAME FOR ALL THREE: each was captioning a
          control that had a label already.
          "SANDBOX MULTIPLAYER" named the tray the buttons sat in, and the tray is gone (#1131 in
          `SandboxRoomBar`). "Host a room, or join with a room code" restated two buttons that read "Host
          game" and "Join game". And "rooms stage off-chain and cost nothing until launch" was reassurance
          about a transaction cost on a screen where the only live path never touches a chain.
          WHAT WAS ACTUALLY LOAD-BEARING IN THE THIRD ONE survives elsewhere: the offline pill says the chain
          is off, and its tooltip carries the rest for whoever needs it. Nothing left here is unexplained --
          it is a title, and two buttons that say what they do. */}

      {/* ==================================================================
           DESIGN NOTE 1099: THE LOBBY GETS THE GAME'S FOOTER, NOT ITS OWN
          ==================================================================
          REPORTED: "the lobby screen doesn't mention Neta DAO anywhere at all."
          REUSED RATHER THAN REBUILT. The obvious fix is a logo in the brand header beside "Project 18XX",
          and it is the wrong one twice over: it would put the attribution in the most valuable strip on the
          screen -- which is the exact placement #1083 moved it OUT of on the game side -- and it would make
          two attributions to keep in step, which is how the credit ended up spelled five different ways
          before #708.
          `AppFooter` ALREADY FITS: this root is a flex column with bottom padding, and the footer's own
          `marginTop: auto` pins it to the bottom on a short lobby and lets it follow the list on a long
          one. Same component, same words, same logo, both screens. */}
      </div>

      {/* PLAY LOBBY (approved design §2.5): the Ludum footer -- the wordmark and "Project 18XX on Ludum", a hairline, and
          the Neta DAO credit (still the link to netadao.org it always was). */}
      {/* The Ludum link and a hairline, then Play's own Neta DAO credit UNCHANGED (`AppFooter` "meta": the animated
          mark at 28px, keyed with `screen`, and "Powered by Neta DAO" as one link). A <div>, because the credit is the
          <footer> landmark and a footer may not hold another. */}
      <div className="lb-footer" data-testid="lobby-footer">
        <a href="https://ludum.netadao.org/projects/project-18xx/" target="_blank" rel="noopener noreferrer">
          <b className="lb-lw">LUDUM</b>
          <span>Project 18XX on Ludum ↗</span>
        </a>
        <i className="lb-sep" aria-hidden="true" />
        <AppFooter surface="meta" />
      </div>
    </div>
  );
}

export default Lobby;

function Banner({ tone, text }: { tone: "error" | "warn"; text: string }) {
  return (
    <p
      // `role="alert"` so the message is announced rather than merely
      // rendered. An error that appears above the fold while the user is
      // looking at a button below it has not really been reported --
      // design note #3's whole point is that failures must be noticed.
      role={tone === "error" ? "alert" : undefined}
      style={{ ...styles.banner, ...(tone === "error" ? styles.bannerError : styles.bannerWarn) }}
    >
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Inline styles                                                       */
/* ------------------------------------------------------------------ */

/* Design note #1123: the one rule inline styles cannot carry. Kept next to the grid it collapses rather
   than in a shared sheet -- this file has no other CSS and a second consumer would be a reason to move it. */
const LOBBY_CSS = `
/* P3-N028 (reopened): #1441's narrow amendment ("left/width: var(--lobby-actions-*) !important") is GONE with the
   absolute anchor it re-hung. The doors' row is flow content the width of the top region less a 16px gutter, so a
   narrow window cannot start it off-screen; "SandboxRoomBar" still wraps it and trims its padding there (#1441). */
@media (prefers-reduced-motion: no-preference) {
  .lobby-wordmark { animation: lobby-wordmark-in 620ms ease-out both; }
}
@keyframes lobby-wordmark-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: none; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  /* ==================================================================
      DESIGN NOTE 1114: A WIDTH CAP, AND THE GROUND STAYS ON THE TOKEN
     ==================================================================
     ASKED FOR: pure black, and a centred max-width container so the cards do not stretch on wide monitors.
     THE CAP IS RIGHT and is applied below on `content`, as a `maxWidth` and `margin: 0 auto` rather than as
     a new wrapping element -- the root is already the column everything sits in, so a second container would
     be a div that exists to hold a number.
     THE GROUND IS NOT PURE BLACK, deliberately. `#080808` is Neta's own `--ink` and is what every other
     surface in this app was retoned to (#1092); `#000000` here would make the lobby the one screen off the
     ladder, and the difference from `#080808` is invisible while the inconsistency is permanent.
     NOT VERTICALLY CENTRED, which was also asked for. The room list grows with the table -- ten staged rooms
     is an ordinary evening -- and centring a column that can outgrow the viewport pushes its head and foot
     off both ends at once, where a top-anchored column simply scrolls. */
  /* ==================================================================
      DESIGN NOTE 1129: THE ROOM IS THE PAGE, NOT A LETTERBOX ACROSS THE TOP
     ==================================================================
     REPORTED of #1124's banner: "too dark, and the cropping on my screen means I'm only really seeing random
     heads." BOTH HALVES WERE ONE FAULT AND IT WAS MINE: a header is roughly 15:1 on a wide window while the
     band was 5.3:1, so `cover` threw away about two thirds of its height and kept the middle -- which is the
     row of foreheads. No crop survives that ratio. A room cannot be shown through a letterbox.
     SO THE PICTURE GETS THE WHOLE PAGE, which is the alternative that was then proposed and is the one that
     removes the problem rather than tuning it. At 1920x1072 there is nothing to crop: the table, the map, the
     lamps and every figure are in frame, and the aspect is close enough to a browser window that `cover`
     trims edges rather than content.
     THE SCRIM DROPS FROM 0.70 TO 0.48 BECAUSE THE TEXT NO LONGER LEANS ON IT. #1124 had one uniform scrim
     doing two jobs -- mood, and legibility for a title occupying a quarter of the width -- so it was set by
     the harder job and the picture paid for it. The hero block carries its own panel now, which was the other
     suggestion and is what made this possible: local contrast where text is, light scrim everywhere else.
     THE WAITING ROOM PATTERN, reached from the other direction. That screen has been a photo under one
     near-opaque panel since #1113 and it works; this is the same construction with the occupied room rather
     than the empty one -- the distinction #1124 drew, and far easier to see at full size than in a strip.
     `backgroundAttachment: fixed` so the room stays put while the cards scroll over it. */
  /* Design note #1131: the picture moved to `.scene`, which is an ELEMENT with a known aspect rather than a
     `cover` background -- see the note at its call site. The root keeps the ink underneath, which is what
     shows in the margins before the image decodes and behind it if it never does.
     `position: relative` so the scene can be absolutely placed against it; `overflow-x: hidden` because the
     scene is deliberately wider than the viewport on a tall window and must not produce a scrollbar. */
  root: {
    position: "relative",
    minHeight: "100vh",
    overflowX: "hidden",
    backgroundColor: "#080808",
    color: "#f2f0eb",
    fontFamily: FONT_FAMILY,
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    /* Design note #1133: the bottom padding is GONE. It held the footer 40px off the foot of the page --
       "sort of floating on the left side of the screen" -- and it was there to keep content clear of a
       bottom edge back when this screen was a scrolling stack of cards. It is a title screen now, and the
       credit belongs ON the edge. */
    padding: 0,
    boxSizing: "border-box",
  },
  /* ==================================================================
      DESIGN NOTE 1131: `cover`, DONE IN CSS SO ITS RESULT IS ADDRESSABLE
     ==================================================================
     `sceneClip` is the viewport-sized window; `scene` is the image's own box, sized exactly as
     `background-size: cover` would compute it and centred the same way, then filled `100% 100%` so the
     picture is never distorted. The difference from a background is that this one is an ELEMENT: children
     positioned at 40% or 70% land on the same part of the photograph on every screen, which is the whole
     reason the anchoring in #1131 is possible at all.
     THE SCRIM IS A GRADIENT LAYER ABOVE THE IMAGE in the same declaration -- #1129's 0.48, unchanged, and
     unchanged for its reason: the title sits where the room is darkest and needs no more than this.
     IT DOES NOT SCROLL AND IT DOES NOT CATCH CLICKS. `position: absolute` inside the root rather than
     `fixed`, so a long page (the Web3 branch, when that flag turns on) scrolls past it normally rather than
     leaving it pinned; `pointerEvents: none` so the layer over the whole window does not eat the footer. */
  sceneClip: {
    position: "absolute",
    /* ==================================================================
        DESIGN NOTE 1133: `height: 100vh` LEFT A BAND OF BARE INK AT THE BOTTOM
       ==================================================================
       REPORTED: "the footer now scrims the entire lower fourth of the screen." IT WAS NOT THE FOOTER. This
       layer was pinned to 100vh while the ROOT is `min-height: 100vh` PLUS 40px of bottom padding plus
       whatever the flow children come to -- so the last stretch of the page had no picture on it at all, and
       the footer's own ink strip ran into that bare band and read as one enormous slab.
       `bottom: 0` MAKES IT THE ROOT'S HEIGHT, whatever that turns out to be. The scene inside still sizes
       itself from the VIEWPORT (`100vh`/`100vw`), so the photograph's framing is unchanged -- only the window
       it is seen through now reaches the bottom of the page. */
    top: 0,
    left: 0,
    right: 0,
    /* Design note #1440 superseded #1133's `bottom: 0` with the hero's height (`--lobby-hero`) so the window would
       not stretch down the list. P3-N028 (reopened) brings `bottom: 0` back for the better reason: this layer now
       lives INSIDE the top region, so `bottom: 0` is the region's foot -- the hero, by construction, whatever the
       corner, the title and the doors come to -- and it can never reach the list, which is outside the region. */
    bottom: 0,
    overflow: "hidden",
    zIndex: 0,
    pointerEvents: "none",
  },
  /* ==================================================================
      P3-N028 (REOPENED): THE TOP REGION, THE STAGE AND THE BOUNDARY
     ==================================================================
     `heroFlow` -- #1440's empty spacer, sized from P3-ACCT's measured doors -- is GONE: the region is no longer an
     absolute layer that reserves nothing, so there is nothing to reserve.
     `top` is a flow block (the root column's first item) whose height is its content's, at least the hero window.
     `position: relative` makes it `sceneClip`'s containing block; `zIndex: 1` makes it one group (the wordmark's
     blend happens inside it) that paints above the column's later flow -- so the account menu's dropdown overhangs
     the tables rather than sliding under them. Its box never overlaps the tables region: that one starts after it. */
  /* PLAY LOBBY: the corner and the header, in flow; no photograph behind them any more. */
  topBand: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
  },
  heroWrap: {
    padding: "0 16px",
  },
  top: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: "var(--lobby-hero-window)",
    flexShrink: 0,
  },
  /* The title and the doors, a centred flow column under the corner. Positioned only to paint above `sceneClip`
     (tree order, same layer); no z-index, transform, opacity or filter -- see `blendIsolation.test.ts`. */
  heroStage: {
    position: "relative",
    flex: "1 0 auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingBottom: `${ACTIONS_GAP_PX}px`,
  },
  /* The hard boundary between the top region and the tables region: an empty flow box, never positioned. */
  boundary: {
    flex: "none",
    height: 0,
    margin: 0,
    padding: 0,
  },
  heroFade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "112px",
    backgroundImage: "linear-gradient(rgba(8, 8, 8, 0), #080808)",
    pointerEvents: "none",
  },
  scene: {
    position: "absolute",
    /* Design note #1440: `top` is written per render from `sceneSizeFor(uiScale)` -- half the scene's own
       height, so `translate(-50%, -50%)` lands its top edge on the hero's rather than centring it. */
    left: "50%",
    transform: "translate(-50%, -50%)",
    /* ==================================================================
        DESIGN NOTE 1144: THE COVER ARITHMETIC HAD TO MOVE INTO THE ZOOM'S SPACE
       ==================================================================
       THIS IS THE ONE PLACE THE ZOOM COULD HAVE BROKEN SILENTLY. Each `max()` weighs a PERCENTAGE of the
       parent against a VIEWPORT unit, and under `zoom: 0.7` those two stop being comparable: `100%` is
       resolved inside the zoomed box (already 1/0.7 of the window in layout terms) while `100vh` is the real
       window and is only scaled afterwards. The comparison would have been made between a scaled number and
       an unscaled one, and #1131's whole claim -- "children positioned at 40% or 70% land on the same part of
       the photograph on every screen" -- rests on this box being exactly `cover` and nothing else.
       DIVIDING THE VIEWPORT TERMS PUTS BOTH SIDES IN LAYOUT SPACE, where the `max()` means what it meant
       before the zoom existed. The ratios are untouched: this is a change of units, not of framing. */
    /* Design note #1294: `width` and `height` are written per render from `sceneSizeFor(uiScale)`. */
    backgroundImage:
      "linear-gradient(rgba(8, 8, 8, 0.48), rgba(8, 8, 8, 0.48)), " +
      `url("${process.env.PUBLIC_URL ?? ""}/images/lobby-boardroom.jpg")`,
    backgroundSize: "100% 100%",
    backgroundRepeat: "no-repeat",
  },
  /* Design note #1131: "at the lowest" is a BOTTOM edge, so the bottom is what is pinned -- `bottom: 60%`
     puts it 40% down from the top and stays true if the artwork's aspect ever changes. Width drives the
     size: 20% of the scene reaches up among the chandelier's arms and stops clear of the heads at 0.44. */
  /* ==================================================================
      DESIGN NOTE 1132: A TRANSFORM HERE PUT A BLACK BOX ROUND THE TITLE
     ==================================================================
     REPORTED: "the title has a black box background around it." THE BLEND WAS ISOLATED, and by this rule:
     `mix-blend-mode` blends an element with the backdrop INSIDE ITS NEAREST STACKING CONTEXT, and `transform`
     creates a stacking context. `translateX(-50%)` on this box therefore cut the wordmark off from the only
     thing it had to blend with -- the photograph two levels up -- so `screen` had nothing but transparency
     underneath and the artwork's own black rendered as a rectangle.
     CENTRED BY ARITHMETIC INSTEAD. `left: 40%` with `width: 20%` puts the centre at 50% without a transform,
     which is the same position by a means that does not break the blend. The lesson generalises: NOTHING
     between a blended element and its backdrop may create a stacking context -- not `transform`, not
     `opacity` below 1, not `filter`, not a `z-index` on a positioned ancestor. */
  /* P3-N028 (reopened): CENTRED BY FLOW NOW -- the stage centres it (`alignItems: center`), so neither #1132's
     `left: 40%` arithmetic nor a transform is needed, and the rule above holds trivially: this box carries a width
     and a margin, nothing that can isolate the blend. Its foot is aimed at 0.4 of the scene (`TITLE_MARGIN_TOP`). */
  titleAnchor: {
    flex: "none",
    width: WORDMARK_WIDTH,
    maxWidth: "calc(100% - 32px)",
    marginTop: TITLE_MARGIN_TOP,
  },
  /* Design note #1131: centred on the table at 0.7. A 24%-wide box with `space-between` puts the two buttons
     either side of 0.40 and 0.60 as ruled; `pointerEvents: auto` re-enables clicks that `sceneClip` turned
     off for the layer as a whole. */
  /* Design note #1132: centred the same way -- `left: 38%` with `width: 24%` puts the box's edges on 0.38 and
     0.62 and its centre on 0.50. `translateY` is all that remains, and only the vertical: nothing here blends,
     but keeping both anchors on the same idiom means the next reader does not have to work out why one uses a
     transform and the other does not. */
  /* ==================================================================
      DESIGN NOTE 1423: THREE BUTTONS, CENTRED BY THE SAME ARITHMETIC
     ==================================================================
     REPORTED: "the Host/Join/Rejoin buttons are not centered. As players zoom in, Host Game stays anchored
     but Join and Rejoin push out to the right." #1132's box was 24% wide at 38% -- centred on 0.5 for TWO
     buttons pushed to its edges -- and a third button (#1355's Rejoin) plus the zoom made the row overflow
     it to the right, since the box's left edge is what is anchored. The box is now 60% wide at 20% (the same
     centre, still no horizontal transform -- #1132's blend-mode reason stands) and the row centres its
     contents with a gap, so the group stays centred at any zoom and any count. */
  /* P3-N028 (reopened): THE DOORS ARE FLOW CONTENT -- no `position`, no `top: 70%`, no `translateY(-50%)`. The row is
     the stage's width less a 16px gutter (the bar centres its buttons, #1423; it can never begin off-screen, #1441)
     and its centre is aimed at 0.7 of the scene, clamped into the hero window (`ACTIONS_MARGIN_TOP`). */
  tableAnchor: {
    flex: "none",
    width: "100%",
    boxSizing: "border-box",
    padding: "0 16px",
    marginTop: ACTIONS_MARGIN_TOP,
    pointerEvents: "auto",
  },
  /* Design note #1131: `brandHeader`, `brandSubtitle`, `stage` and `stageNote` are GONE. The header was a
     flow container for a title and a strapline; the title is anchored to the scene now and the strapline was
     one of the three lines removed with it. `stage` held the controls, which are anchored too.
     [P3-N028 (reopened): the title and the controls are flow content again -- of the top region's `heroStage`, not
     of a card -- so the list after them can never be laid out over them.] */
  /* ==================================================================
      DESIGN NOTE 1130: SCREEN, NOT ALPHA
     ==================================================================
     The artwork is gold on true black, and `mix-blend-mode: screen` takes black to nothing -- the technique
     #1040 established for the yellow sign. It is why this can stay a JPEG: the same lettering as a PNG with a
     real alpha channel measured 330KB against 94KB here.
     THE WIDTH IS CAPPED IN BOTH DIRECTIONS. `min(520px, 84vw)` keeps it a title on a desktop and stops a
     900px image overflowing a phone; height follows the aspect, because only width is set. This is also why
     #1123's media query could go -- the one responsive rule left is expressible inline. */
  brandWordmark: {
    display: "block",
    /* Design note #1131: was `min(520px, 84vw)`. The anchor sets the size now, so the image simply fills it
       -- two places deciding one width is how the title and its anchor would have drifted apart. */
    width: "100%",
    height: "auto",
    mixBlendMode: "screen",
    userSelect: "none",
  },
  /* Clipped rather than `display: none`, which screen readers skip rather than read -- the same `srOnly`
     shape the ledger's tile strip uses. The heading has to stay in the document: an image cannot be selected,
     searched, translated or spoken. */
  srOnlyTitle: {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  /* ==================================================================
      DESIGN NOTE 1130: THE ACCOUNT ROW
     ==================================================================
     Pinned right, above everything, and deliberately OUTSIDE the width cap -- account furniture belongs to
     the window rather than to the column of content. `flex-end` plus `wrap`, so a connected wallet's three
     chips fall to a second line rather than pushing the row wider than the screen. */
  utilityRow: {
    /* ==================================================================
        DESIGN NOTE 1131: THE STACKING FIX THIS ROW NEEDED AND DID NOT HAVE
       ==================================================================
       `sceneClip` is `position: absolute` with `zIndex: 0`, and a POSITIONED element at z-index 0 paints
       above an unpositioned flow sibling however late that sibling appears in the document. So this row --
       and `content` below it -- were about to be painted UNDER the photograph, which `pointerEvents: none`
       would have hidden by leaving them clickable: visibly gone, still working, the hardest kind of bug to
       read. `position: relative` plus a z-index puts them back on top explicitly. */
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "10px",
    padding: "14px 20px 0",
  },
  /* Design note #1131: the account half of the row, grouped so `space-between` has two things to separate
     rather than four to scatter. `marginLeft: auto` keeps it right even when the pill is absent. */
  /* Design note #1133: the compact connect. Same paper-on-ink as `primaryButton` -- it is still the one
     thing in this row a player might click -- at the row's own scale rather than the stage's. */
  connectButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "5px 12px",
    borderRadius: RADIUS.card,
    border: "1px solid transparent",
    backgroundColor: CARD_SURFACE,
    color: INK,
    cursor: "pointer",
  },
  utilityAccount: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    /* P3-ACCT: a wrapped corner stays right-aligned, so the account buttons never drift under the title. */
    justifyContent: "flex-end",
    gap: "10px",
    marginLeft: "auto",
  },
  /* P3-ACCT: the public rules, as quiet as the corner's other furniture. */
  rulesButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.pill,
    border: "1px solid #3a3a3a",
    backgroundColor: "rgba(8, 8, 8, 0.6)",
    color: "#f2f0eb",
    cursor: "pointer",
  },
  /* Design note #1130: the stage -- a centred column holding a sentence and the two controls, with no panel
     around them. See the note at its call site for why the box came off. */
  stage: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    paddingTop: "4px",
  },
  /* ==================================================================
      DESIGN NOTE 1129: GILT, WITH A SOLID COLOUR UNDERNEATH IT
     ==================================================================
     ASKED FOR as "a gilded/stylized Project 18XX". GOLD RATHER THAN THE BRAND GRADIENT, deliberately: pink to
     blue belongs to Neta and appears on this screen already, on the footer mark and the card edges. This is
     the GAME's name, over a room of brass lamps and gilt frames, and `#c9a94c` is a gold the palette holds.
     THE SWEEP IS GOLD -> PALE -> GOLD, which is how gilt behaves under a light, and it is bounded at both
     ends by the same stop so the worst case is a single number: 4.27:1 on the hero panel. At 34px/800 the
     bar is 3:1 -- large text starts at 18.66px bold -- so it clears with room. A darker bronze stop was
     measured first and came back 1.93:1.
     `color` IS SET BEFORE THE CLIP, and that is the whole safety of this technique. An engine without
     `background-clip: text` also lacks `-webkit-text-fill-color`, so the transparent fill never applies and
     the solid gold shows through. Setting only the gradient renders an INVISIBLE title on those engines.
     LARGER THAN `FONT_SIZE.display` AND LEFT LOCAL. 22px is right for a heading inside a screen; this is the
     one place in the app that is a title card, and promoting the size into the shared scale would push every
     other `display` heading with it. */
  brandTitle: {
    margin: 0,
    fontSize: "34px",
    fontWeight: 800,
    letterSpacing: "1.5px",
    textAlign: "center",
    color: "#e8c877",
    backgroundImage: "linear-gradient(100deg, #c9a94c 0%, #f5e3ac 50%, #c9a94c 100%)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  /* Design note #1131: `brandSubtitle` went with its sentence. `brandTitle` above STAYS -- it is the
     fallback the wordmark falls back to, not a survivor. It also picks up the text shadow the subtitle used
     to carry, since in that branch it is the one piece of text standing on the photograph unaided. */
  headerControls: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  nameInput: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    color: "#f2f0eb",
    width: "190px",
  },
  addressBadge: {
    fontSize: FONT_SIZE.body,
    fontFamily: FONT_FAMILY_MONO,
    padding: "7px 12px",
    borderRadius: RADIUS.pill,
    backgroundColor: "#0f0f0f",
    border: "1px solid #2a2a2a",
    color: "#a8a6a0",
  },
  balanceBadge: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "7px 12px",
    borderRadius: RADIUS.pill,
    backgroundColor: "#14301f",
    border: "1px solid #2c6e4a",
    color: "#8fe0b0",
  },
  // ---- Escape hatch (App.tsx design note #24). Violet, deliberately not
  // reusing any of the blue/green/amber the real gameplay controls use --
  // this is a developer affordance, and it should not read as another way
  // to start a real game. ----
  /* ==================================================================
      DESIGN NOTE 1123: A CARD IN A COLUMN, NOT A STRIP ACROSS THE PAGE
     ==================================================================
     REPORTED as "the lobby looks too much like a settings menu", and the strips are why: four full-width
     bands stacked down a 1040px page, each the same height and weight, so nothing on the screen claimed to
     be the thing you came to do. A settings menu is exactly what a stack of equal-weight full-width rows is.
     COLUMN-ORIENTED NOW. `flexDirection: "column"` rather than a row with `space-between`, because these are
     cards in a two-column grid: the copy sits above its controls instead of beside them, which is what lets
     two of these stand side by side at half width without the buttons crushing the text.
     THE `margin: "0 28px"` IS GONE and it was a bug. #1114 added the `content` wrapper with its own 20px
     inset; this margin predates it and was never removed, so the strips sat 48px in while every panel beside
     them sat at 20px. Two different left edges on one page, from a rule nobody had re-read. */
  sandboxStrip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "14px",
    padding: "20px",
    /* Design note #1129: 0.92 rather than opaque, so the room shows faintly through the card instead of the
       card reading as a sticker on a photograph -- the treatment the waiting room's panel already uses. The
       ink was re-measured against the blend rather than against the flat token: title 8.87:1, note 6.15:1. */
    backgroundColor: "rgba(22, 18, 30, 0.92)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: SANDBOX_RULE,
    borderRadius: RADIUS.layer,
  },
  /* Design note #1130: `dashboard`, `dashboardColumn`, `sandboxCopy`, `sandboxTitle` and `sandboxNote` are
     GONE with the cards they dressed. `sandboxStrip` above stays -- `StagingRoom` still uses it -- which is
     why it was kept rather than swept with the rest. */
  sandboxButton: {
    flexShrink: 0,
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: SANDBOX_RULE_STRONG,
    backgroundColor: SANDBOX_RAISED,
    color: SANDBOX_INK,
    cursor: "pointer",
  },
  browserGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(280px, 360px) 1fr",
    gap: "16px",
    padding: "0 28px",
    alignItems: "start",
  },
  roomGrid: {
    display: "grid",
    gridTemplateColumns: "1fr minmax(300px, 400px)",
    gap: "16px",
    padding: "0 28px",
    alignItems: "start",
  },
  /* Design note #1114: asked for `#121212` on `#262626`. Both are within a point or two of tokens this app
     already has, and adding them would put two more near-duplicate neutrals back into a codebase that just
     finished collapsing 212 of them into eight. `INK_CHIP #141414` is the elevated off-black that was wanted
     and `RULE #2a2a2a` is the subtle border; the radius stays 12px rather than churning to 8 for no reason.
     The card now sits one step ABOVE the root, which is the half of the request that actually changes
     anything -- it was `#0f0f0f` on `#0f0f0f`, an edge with no elevation behind it. */
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "20px",
    backgroundColor: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: RADIUS.layer,
  },
  /* Design note #1114: 1040px rather than the 960 suggested -- the room browser is a table with a name, a
     status pill, a seat count and two buttons, and at 960 the buttons start wrapping under the name on a
     staged room with a long title. `margin: 0 auto` centres it; the root's own column keeps the gaps. */
  content: {
    /* P3-N028 (reopened): no `position` / `zIndex` any more. #1131 lifted this above an absolute scene that spread
       over the column; the scene is the top region's background now and ends where the region does, so nothing is
       painted here to rise above -- and the tables region carries nothing that could move it out of the flow. */
    width: "100%",
    /* PLAY LOBBY: the design's 1200px column (the boards' frame takes 7px each side). */
    maxWidth: "1232px",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "0 20px",
    boxSizing: "border-box",
  },
  panelTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 700, color: "#f2f0eb" },
  /* Design note #902: the variant rows. Same rhythm as `AutoPassModal`'s condition list -- a label, then what
     it costs you -- because both are asking a player to agree to something before it happens. */
  variantRow: {
    display: "flex",
    flexDirection: "row",
    gap: "10px",
    alignItems: "flex-start",
    cursor: "pointer",
    marginTop: "2px",
  },
  variantNote: { display: "block", fontSize: "11px", color: "#8a8a86", lineHeight: 1.4, marginTop: "2px" },
  panelNote: { margin: 0, fontSize: FONT_SIZE.small, color: "#6e6c68", lineHeight: LINE_HEIGHT.normal },
  label: { display: "flex", flexDirection: "column", gap: "6px", fontSize: FONT_SIZE.body, color: "#a8a6a0" },
  input: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: RADIUS.card,
    // Longhand, so `inputInvalid` can override the colour alone without
    // mixing against a shorthand -- same hazard as `tabButton` above.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3a3a",
    backgroundColor: "#0f0f0f",
    color: "#f2f0eb",
    boxSizing: "border-box",
  },
  inputInvalid: { borderColor: "#8e3b31" },
  /** The "here is why that control will refuse you" hint -- design note #3,
   *  rule 2. Amber rather than red: nothing has failed yet, and colouring a
   *  precondition as an error trains people to ignore real errors. */
  blockedNote: {
    margin: 0,
    padding: "10px 14px",
    borderRadius: RADIUS.card,
    backgroundColor: "#3a2f14",
    border: "1px solid #6a5a24",
    color: "#e0c07a",
    fontSize: FONT_SIZE.small,
    lineHeight: LINE_HEIGHT.normal,
  },
  hint: { fontSize: FONT_SIZE.body, color: "#6e6c68", margin: 0, padding: "0 28px" },
  // ---- Open Lobbies / Live Games tabs. Same #1E293B-on-#0F172A active-tab
  // treatment `MainTabBar` uses on the dashboard, so the two screens' nav
  // reads as one system. ----
  tabBar: {
    display: "flex",
    gap: "4px",
    borderBottom: "1px solid #1c1c1c",
    marginBottom: "4px",
  },
  tabButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: "12px 20px",
    // Longhand, NOT the `borderBottom` shorthand. This pair produced the reported console warning: the base style
    // set the SHORTHAND while the active variant overrode only the `borderBottomColor` LONGHAND, and on a tab
    // switch React removes the longhand from the outgoing element while the shorthand is still present -- the
    // order in which a browser applies that combination is not guaranteed. Expressing all three parts as longhands
    // means the active variant overrides exactly one property that was already there.
    borderWidth: "0",
    borderStyle: "solid",
    borderColor: "transparent",
    borderBottomWidth: "3px",
    backgroundColor: "transparent",
    color: "#6e6c68",
    cursor: "pointer",
  },
  tabButtonActive: {
    color: "#f2f0eb",
    // Overrides one longhand set above -- see the note there.
    borderBottomColor: "#4a6a92",
    backgroundColor: "#1c1c1c",
  },
  tabCount: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 7px",
    borderRadius: RADIUS.pill,
    backgroundColor: "#2a2a2a",
    color: "#9ec1ea",
  },
  roomList: { display: "flex", flexDirection: "column", gap: "8px" },
  roomRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 14px",
    backgroundColor: "#0f0f0f",
    border: "1px solid #1c1c1c",
    borderRadius: RADIUS.card,
    flexWrap: "wrap",
  },
  roomRowMain: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: "180px" },
  roomName: { fontSize: FONT_SIZE.strong, fontWeight: 600, color: "#f2f0eb" },
  roomMeta: { fontSize: FONT_SIZE.small, color: "#6e6c68" },
  seatPill: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "4px 10px",
    borderRadius: RADIUS.pill,
    backgroundColor: "#1c1c1c",
    color: "#a8a6a0",
  },
  roomHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" },
  seatList: { display: "flex", flexDirection: "column", gap: "8px" },
  seatCard: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 14px",
    backgroundColor: "#0f0f0f",
    // Longhand: `seatCardDropped` overrides `borderStyle` alone.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#1c1c1c",
    borderRadius: RADIUS.card,
  },
  seatCardDropped: { opacity: 0.55, borderStyle: "dashed" },
  presenceDot: { fontSize: FONT_SIZE.micro, flexShrink: 0 },
  seatMain: { display: "flex", flexDirection: "column", gap: "1px", flex: 1, minWidth: 0 },
  seatName: { display: "flex", alignItems: "center", gap: "8px", fontSize: FONT_SIZE.control, fontWeight: 600, color: "#f2f0eb" },
  seatAddress: { fontSize: FONT_SIZE.micro, color: "#6e6c68", fontFamily: FONT_FAMILY_MONO },
  selfTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: RADIUS.pill,
    backgroundColor: "#2a2a2a",
    color: "#9ec1ea",
  },
  hostTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: RADIUS.pill,
    backgroundColor: "#3a2f14",
    color: "#e0c07a",
  },
  readyTag: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#8fe0b0", flexShrink: 0 },
  antedTag: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#9ec1ea", flexShrink: 0 },
  waitingTag: { fontSize: FONT_SIZE.small, color: "#6e6c68", flexShrink: 0 },
  openSeat: {
    padding: "10px 14px",
    border: "1px dashed #2a2a2a",
    borderRadius: RADIUS.card,
    fontSize: FONT_SIZE.body,
    color: "#4a4a4a",
    textAlign: "center",
  },
  roomActions: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "4px" },
  /* ==================================================================
      DESIGN NOTE 1114: THE BRAND GRADIENT ON THE EDGE, NOT UNDER THE TEXT
     ==================================================================
     ASKED FOR: the gradient as the Host button's "border or background", text bright and readable.
     BACKGROUND FAILS THAT SECOND CLAUSE AND CANNOT BE MADE TO PASS. White on the pink end is 4.86:1 and on
     the blue end 3.20:1, so a button filled with the axis is legible at one end and not the other, and no
     ink is right for both. The border is the half of the offer that works, and it is also the half that
     reads as a brand: a gradient hairline around a dark control is a mark, a gradient slab is a toy.
     AND THE GRADIENT IN THE PROMPT IS NOT NETA'S. It gave `#00C3FF -> #FF00EA`, a cyan-to-magenta neon that
     appears nowhere in their identity; their published `--gradient` is `#C9338A -> #5B8EF0`, which is what
     `BRAND_GRADIENT` already holds because #1092 read it out of their stylesheet rather than eyeballing it.
     Using the invented pair would have put a fourth palette in an app that just spent a whole pass getting
     to one.
     TWO BACKGROUNDS, ONE ELEMENT: the fill is painted over the gradient with `padding-box`/`border-box`
     origins, so the 1px edge shows the axis and the centre stays a dark control with `#f2f0eb` at 16.8:1
     on it. */
  /* ==================================================================
      DESIGN NOTE 1123: THE BRAND USES THE GRADIENT FOR TEXT, NOT FOR BUTTONS
     ==================================================================
     ASKED FOR as a gradient FILL with pure black bold text, and the fill is the right instinct -- a hairline
     gradient border is a weak call to action for the one control this screen exists to offer. The colours
     were the problem, twice over.
     THE SUPPLIED GRADIENT WAS NOT NETA'S. `#00C3FF -> #FF00EA` was given as "the exact Neta DAO gradient";
     netadao.org's own `--gradient` is `#C9338A -> #5B8EF0`, which is what `BRAND_GRADIENT` already held.
     AND BLACK ON THE REAL ONE FAILS. 4.12:1 at the pink end against a 14px bold label, where the bar is 4.5 --
     14px bold is not "large text", which starts at 18.66px bold. Paper on it fails too, at 4.26:1. There is
     no ink that clears AA across that sweep, because the gradient crosses mid-luminance in the middle.
     SO IT IS NETA'S ACTUAL PRIMARY BUTTON. `.btn-primary` on their site is `background: var(--paper); color:
     var(--ink)` -- a paper slab with ink text, 17.59:1, and the strongest thing this palette can put on a
     dark page. The gradient stays where the brand puts it: `.grad-text`, and the borders it already edges. */
  primaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: "1px solid transparent",
    backgroundColor: CARD_SURFACE,
    color: INK,
    cursor: "pointer",
  },
  /* Design note #1114: the ghost button, as asked -- transparent, light text, dark edge. `#3a3a3a` is the
     ladder's `RULE_STRONG` rather than the `#333333` suggested, which is a third neutral within a point of
     one this app already has. */
  secondaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#f2f0eb",
    cursor: "pointer",
  },
  launchButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: "1px solid #2c6e4a",
    backgroundColor: "#1a4530",
    color: "#a8f0c8",
    cursor: "pointer",
  },
  dangerButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.card,
    border: "1px solid #5a2a24",
    backgroundColor: "#2a1614",
    color: "#f0b0a8",
    cursor: "pointer",
  },
  removeButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#161616",
    color: "#a8a6a0",
    cursor: "pointer",
    flexShrink: 0,
  },
  pill: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "3px 10px",
    borderRadius: RADIUS.pill,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    flexShrink: 0,
  },
  pillStaging: { backgroundColor: "#1c1c1c", color: "#a8a6a0" },
  pillLaunching: { backgroundColor: "#3a2f14", color: "#e0c07a" },
  pillLive: { backgroundColor: "#14301f", color: "#8fe0b0" },
  pillClosed: { backgroundColor: "#2a1614", color: "#f0b0a8" },
  banner: {
    /* Design note #1123: the SAME stale inset the sandbox strips carried, found by the assertion written for
       those. #1114's `content` wrapper supplies the 20px; this 28px predates it and put the error banners on
       a third left edge, 48px in, beside panels at 20px. A margin that survived the thing it was compensating
       for -- which is the shape of nearly every defect in this file's history. */
    margin: 0,
    padding: "10px 14px",
    borderRadius: RADIUS.card,
    fontSize: FONT_SIZE.body,
    lineHeight: LINE_HEIGHT.normal,
  },
  bannerError: { backgroundColor: "#2a1614", border: "1px solid #5a2a24", color: "#f0b0a8" },
  bannerWarn: { backgroundColor: "#3a2f14", border: "1px solid #6a5a24", color: "#e0c07a" },
};
