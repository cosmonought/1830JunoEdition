// The slim top bar -- wallet status, session key, room controls -- moved out of
// `App.tsx` unchanged, with its three private helpers and its one CSS string.
//
// `firstMissingEnvVar`, `nativeBalanceTitle` and `statusDotColor` each have
// exactly one caller. As top-level functions in a 9,600-line file they looked
// like shared utilities and meant reading `TopBar` required scrolling away from
// it. `NETA_CREDIT_CSS` likewise styles one link in one component.

import React from "react";

import { useWallet } from "../context/WalletContext";
import { useGameSession } from "../context/GameSessionContext";
import { chainConfigError, formatNativeAmount, NATIVE_DENOM_DISPLAY } from "../config";
import { ConnectWalletButton } from "./ConnectWalletButton";
import { truncateAddress } from "../utils/address";
import { styles } from "../styles/appStyles";
// Design note #1075: the volume, the off switch, and which effects play -- one panel, two buttons.
import AudioControlPopover, { type AudioCategoryToggle } from "./AudioControlPopover";

/* ------------------------------------------------------------------ */
/* Main tabs -- see design note #9                                    */
/* ------------------------------------------------------------------ */

// Design note #28: `"phase"` is the surface the current round is PLAYED on;
// `"map"`, `"stock"`, `"ledger"` and `"rules"` are REFERENCE boards. One tab
// used to be both, renaming itself by round, which made the market chart
// unreachable during the two phases where it is most worth consulting. The
// Operating Round has no `"phase"` surface at all -- its actionable surface IS
// the rail map -- which is why `orderedMainTabs` returns a LIST: the tab set
// changes shape by phase, not just its order.
//
// Design note #41: `"corps"` is present in every phase and simply IS the Stock
// Round's phase surface. NAMING TRAP: id `"corps"` labelled "Stocks", while a
// different tab has id `"stock"` labelled "Stock Market"; `"stock"`/`"stocks"`
// as siblings would be one letter apart and impossible to review.
//
// See docs/ai_architecture/ui_shell_layout.md, TopBar.tsx #28 / #41.

/** Pulls the `REACT_APP_*` name out of a `chainConfigError()` message, for
 *  the compact badge. `null` if the message names none, in which case the
 *  caller falls back to a generic label rather than printing a truncated
 *  sentence. */
function firstMissingEnvVar(message: string): string | null {
  return message.match(/REACT_APP_[A-Z_]+/)?.[0] ?? null;
}

/** Hover text for the native balance pill -- the exact base-denom integer
 *  alongside the formatted figure, so a player can verify the conversion and
 *  see that no precision was invented. */
function nativeBalanceTitle(coin: { denom: string; amount: string } | null): string {
  if (!coin) return "Native balance unavailable — connect a wallet on a configured chain.";
  return `${coin.amount} ${coin.denom} (raw base-denom integer)`;
}

/** Design note #34: the status PILLS became status DOTS, so this returns a
 *  fill only -- there is no longer any text sitting on the colour to need a
 *  matching foreground. Same four states, same meanings. */
function statusDotColor(
  status: "disconnected" | "connecting" | "connected" | "error"
    | "uninitialized" | "initializing" | "ready",
): React.CSSProperties {
  switch (status) {
    case "connected":
    case "ready":
      return { backgroundColor: "#2f9e57" };
    case "connecting":
    case "initializing":
      return { backgroundColor: "#c9a94c" };
    case "error":
      return { backgroundColor: "#c05050" };
    default:
      return { backgroundColor: "#2a2a2a" };
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard Control Bar                                              */
/* ------------------------------------------------------------------ */

/* Design note #34: one slim strip, replacing two stacked full-width headers
   that were both answering "what am I connected to". Room content arrives as a
   `roomContext` node, so this component stays ignorant of game state. Deleted:
   the in-game cash readout (real and virtual money must not sit side by side --
   the F-3 confusion), the field labels, and the always-visible session-key
   button. The session key is condensed to a dot, not dropped.

   Design note #40: the phase badge is NOT here. This header is a single `flex`
   row and two more pills pushed the wallet cluster onto a second line, undoing
   #34. It lives at the far right of the Contextual Action Bar, which already
   says what round it is. */
export default function TopBar({
  roomContext,
  roomName = null,
  onLeaveGame,
  audio,
}: {
  /** Room identity / sandbox controls, owned by `AppShell` -- see design
   *  note #34 for why this is a node rather than a pile of props. */
  roomContext?: React.ReactNode;
  /** Design note #1083: the room's code, shown beside the app's name. `null` for a solo sandbox and for an
   *  on-chain game, whose identity `roomContext` already names -- two labels for one room is what this
   *  batch is removing, not something to reintroduce one line up. */
  roomName?: string | null;
  onLeaveGame?: () => void;
  /** ==================================================================
   *   DESIGN NOTE 1009: STATE FROM THE SHELL, LAYOUT FROM THE HEADER
   *  ==================================================================
   *
   *  FOUR VALUES RATHER THAN A `React.ReactNode` LIKE `roomContext`. That prop exists because room controls
   *  are a pile of unrelated chrome whose shape the header has no opinion about; these two are a matched pair
   *  the header has to align with its own buttons, and a node handed in from `App.tsx` would put the header's
   *  layout in a file that cannot see the rest of the row.
   *
   *  AND NOT A CONTEXT. The shell owns both flags already -- it is where `isMyTurn` lives, so it is where the
   *  whistle has to fire -- and a provider would exist to carry state downward one level to its only consumer.
   *
   *  OPTIONAL, so `TopBar` still renders in a shell with no audio wired: the group disappears rather than
   *  drawing two dead buttons. */
  audio?: {
    musicPlaying: boolean;
    onToggleMusic: () => void;
    sfxEnabled: boolean;
    onToggleSfx: () => void;
    /** Design note #1075: the popover's contents. Optional so a shell that wires only the two toggles still
     *  renders -- the buttons then behave exactly as they did before this batch. */
    radioVolume?: number;
    onRadioVolume?: (volume: number) => void;
    sfxVolume?: number;
    onSfxVolume?: (volume: number) => void;
    sfxCategories?: readonly AudioCategoryToggle[];
  };
}) {
  const wallet = useWallet();
  const session = useGameSession();
  /* Design note #1075: one open panel at a time, named rather than a pair of booleans -- two flags can
     both be true and would render two overlapping popovers from the same corner. */
  const [openPanel, setOpenPanel] = React.useState<"radio" | "sfx" | null>(null);
  /** Design note #1094: the disclosure's outer bound -- both trigger buttons and whichever panel is open.
   *  The popover's outside-click listener asks this rather than its own panel, so pressing a trigger is
   *  inside the disclosure and the trigger's toggle is allowed to run. See `AudioControlPopover` #1094. */
  const audioGroup = React.useRef<HTMLSpanElement | null>(null);

  // F-4 UI: why the wallet cannot connect, when that is a configuration problem
  // rather than a user one. `config.ts` deliberately no longer throws at import
  // (its #0), so an unconfigured build boots offline and "Connect Keplr" would
  // otherwise look like it should work and fail on click. Names the exact
  // environment variable. Computed at render -- these are build-time constants
  // that cannot change during a session, so there is nothing to cache.
  const configError = chainConfigError();

  const walletStatusLabel: Record<typeof wallet.status, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    connected: "Connected",
    error: "Error",
  };

  const sessionStatusLabel: Record<typeof session.sessionStatus, string> = {
    uninitialized: "Not Initialized",
    initializing: "Initializing...",
    ready: "Ready",
    error: "Error",
  };

  // Only offer the session key when pressing it would do something. See
  // design note #34 -- the disabled-forever button was pure width.
  const canInitSession = wallet.status === "connected" && session.sessionStatus !== "ready";

  return (
    <header style={styles.topBar}>
      <span style={styles.topBarBrand}>Project 18XX</span>

      {/* ==================================================================
           DESIGN NOTE 1083: THE ROOM'S NAME SITS WITH THE APP'S
          ==================================================================
          RULED: "Move the 'Powered by Neta DAO' text out of the title area and anchor it in the global app
          footer ... Move the remaining Room Name information into the Title area to replace the space
          previously occupied by the Neta DAO text."

          AND THE SWAP IS BETTER THAN EITHER HALF ALONE. #47 put the credit here on the argument that "an
          attribution belongs next to the thing attributed" -- true, and it was competing for the most
          valuable strip on screen with the two things a player actually needs to know: which app this is and
          which room they are in. An attribution is read once; a room code is read every time somebody has to
          relay it. The footer keeps #47's adjacency at a fraction of the cost.

          SELECTABLE, MONOSPACED, AT SIZE, which is the treatment it had in the bar it came from: the code is
          the one string a player has to read aloud or paste to someone else, so it must not be a chip they
          would have to retype from a screenshot.

          NOTHING WHEN THERE IS NO ROOM. A solo sandbox has no code, and a label with an empty value beside it
          is worse than a shorter header. */}
      {roomName && (
        <span style={styles.topBarRoom}>
          <span style={styles.topBarRoomLabel}>Room</span>
          <code style={styles.topBarRoomCode}>{roomName}</code>
        </span>
      )}

      {roomContext}

      {/* Everything after this spacer is pinned right. */}
      <span style={styles.topBarSpacer} />

      {/* ==================================================================
           DESIGN NOTE 1009: THE AUDIO PAIR LEADS THE RIGHT-HAND GROUP
          ==================================================================
          PLACED FIRST AFTER THE SPACER, which puts it furthest from the wallet cluster at the far right. The
          order in that group is roughly "least consequential first": these two change what the player hears
          and nothing else, while everything to their right can cost money or end a session. #34's note that
          this group is the one that wraps first applies -- and a pair of 26px squares is the cheapest thing
          in the row to push onto a second line.

          TITLES SAY WHAT THE CLICK WILL DO, not what the state is. "Music: on" leaves a player working out
          whether pressing it turns it off; "Stop the radio stream" is the answer they were after. */}
      {audio && (
        /* Design note #1075: `position: relative` so the popover hangs from the group rather than from the
           viewport -- the bar scrolls with the header on a narrow window, and a fixed panel would part
           company with the button that opened it. */
        <span ref={audioGroup} style={{ ...styles.topBarAudioGroup, position: "relative" }}>
          <button
            type="button"
            style={{
              ...styles.topBarIconButton,
              ...(audio.musicPlaying ? styles.topBarIconButtonOn : {}),
            }}
            /* Design note #1075: THE CLICK OPENS THE PANEL, it no longer toggles. Off lives inside, which is
               what lets the dim mean one thing -- see the component's own note for why the two jobs could not
               share a control. With no volume wiring the button falls back to being a plain toggle. */
            onClick={() =>
              audio.onRadioVolume
                ? setOpenPanel((current) => (current === "radio" ? null : "radio"))
                : audio.onToggleMusic()
            }
            aria-expanded={audio.onRadioVolume ? openPanel === "radio" : undefined}
            aria-pressed={audio.onRadioVolume ? undefined : audio.musicPlaying}
            /* ==================================================================
                DESIGN NOTE 1078: THE DIM HAS TO BE READABLE BY SOMETHING OTHER THAN AN EYE
               ==================================================================
               #1074 FIXED THE DIM FOR EYES AND BROKE IT FOR EVERYONE ELSE, which is a fault of mine that a
               test caught rather than a player: while these buttons were toggles, `aria-pressed` carried the
               on/off state to assistive tech exactly as the colour carried it to the eye. #1075 turned them
               into disclosure controls, so `aria-pressed` correctly became `aria-expanded` -- and the state
               it used to announce went nowhere. The `title` is not a substitute; it is announced
               inconsistently and not at all on touch.
               SO THE LABEL CARRIES IT. `aria-label` is announced on every platform, it is the one string
               these buttons already own, and naming the state in it restores the parity #1074 was about.
               THE OFF ROW INSIDE THE POPOVER KEEPS ITS `aria-pressed` -- that one IS a toggle -- so a reader
               who opens the panel gets the state twice rather than not at all. */
            aria-label={audio.musicPlaying ? "Radio settings" : "Radio settings — radio is off"}
            title={
              audio.musicPlaying
                ? "Radio — volume and off"
                : "Radio is off — click for volume and to turn it back on"
            }
          >
            {/* A note, not a speaker: this one is about MUSIC, and the speaker beside it is about the game. */}
            &#9835;
          </button>
          <button
            type="button"
            style={{
              ...styles.topBarIconButton,
              ...(audio.sfxEnabled ? styles.topBarIconButtonOn : {}),
            }}
            onClick={() =>
              audio.onSfxVolume
                ? setOpenPanel((current) => (current === "sfx" ? null : "sfx"))
                : audio.onToggleSfx()
            }
            aria-expanded={audio.onSfxVolume ? openPanel === "sfx" : undefined}
            aria-pressed={audio.onSfxVolume ? undefined : audio.sfxEnabled}
            /* Design note #1078: the same state in the same place, for the same reason. */
            aria-label={
              audio.sfxEnabled
                ? "Sound effect settings"
                : "Sound effect settings — sound effects are off"
            }
            title={
              audio.sfxEnabled
                ? "Sound effects — volume, off, and which effects play"
                : "Sound effects are off — click for volume and to turn them back on"
            }
          >
            {/* ==================================================================
                 DESIGN NOTE 1074: AN EMOJI CANNOT BE DIMMED
                ==================================================================
                REPORTED: "when Radio is muted the button dims/grays out, when SFX is muted a barely
                perceptible slash mark goes through the icon. The dimming behavior is preferable."
                AND THE TWO BUTTONS ALREADY SHARED THEIR STYLES, which is what made this puzzling to read: the
                same `topBarIconButtonOn` lights both and the same base greys both. The difference was the
                GLYPH. `&#9835;` is a text character and takes the button's `color`, so it greys with it;
                `&#128266;` is an emoji, painted by the emoji font in its own colours, and CSS `color` does
                nothing to it. What the player read as a faint slash is the speaker's own artwork against a
                dimmed border.
                SO IT IS DRAWN RATHER THAN TYPED. An inline SVG on `currentColor` obeys the same rule the
                music note already did, and the two buttons now dim identically because they are finally the
                same kind of thing. */}
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M7.2 2.4 4 5.2H1.8v5.6H4l3.2 2.8z" />
              <path d="M10.1 5.1a3.6 3.6 0 0 1 0 5.8l-.9-1.1a2.2 2.2 0 0 0 0-3.6z" />
              <path d="M12.3 2.6a7 7 0 0 1 0 10.8l-.9-1.1a5.6 5.6 0 0 0 0-8.6z" />
            </svg>
          </button>
          {audio.onRadioVolume && openPanel === "radio" && (
            <AudioControlPopover
              title="Radio"
              volume={audio.radioVolume ?? 0}
              onVolumeChange={audio.onRadioVolume}
              enabled={audio.musicPlaying}
              onEnabledChange={audio.onToggleMusic}
              onClose={() => setOpenPanel(null)}
              owner={audioGroup}
            />
          )}
          {audio.onSfxVolume && openPanel === "sfx" && (
            <AudioControlPopover
              title="Sound effects"
              volume={audio.sfxVolume ?? 0}
              onVolumeChange={audio.onSfxVolume}
              enabled={audio.sfxEnabled}
              onEnabledChange={audio.onToggleSfx}
              categories={audio.sfxCategories}
              onClose={() => setOpenPanel(null)}
              owner={audioGroup}
            />
          )}
        </span>
      )}

      {configError && (
        <span style={styles.offlineBadge} title={configError}>
          {/* The full message is long and names a rebuild requirement; the
              badge shows the actionable half and the tooltip carries the
              rest, so the bar never wraps. */}
          Offline — {firstMissingEnvVar(configError) ?? "chain not configured"}
        </span>
      )}

      {wallet.error && (
        <span style={styles.topBarError} title={wallet.error}>
          {wallet.error}
        </span>
      )}
      {session.sessionError && (
        <span style={styles.topBarError} title={session.sessionError}>
          {session.sessionError}
        </span>
      )}

      {/* Session key: a dot plus, when it would do something, a button. */}
      <span
        style={{ ...styles.topBarDot, ...statusDotColor(session.sessionStatus) }}
        title={`Session key: ${sessionStatusLabel[session.sessionStatus]}${
          session.sessionAddress ? ` (${session.sessionAddress})` : ""
        }`}
        aria-label={`Session key ${sessionStatusLabel[session.sessionStatus]}`}
      />
      {canInitSession && (
        <button
          type="button"
          style={styles.topBarButton}
          onClick={session.initializeSessionKey}
          disabled={session.sessionStatus === "initializing"}
          title="Authorise a session key so gameplay actions do not each need a wallet popup."
        >
          {session.sessionStatus === "initializing" ? "Initializing..." : "Session Key"}
        </button>
      )}

      {wallet.status === "connected" && (
        <>
          <span
            style={styles.nativeBalancePill}
            title={nativeBalanceTitle(wallet.nativeBalance)}
          >
            <span style={styles.nativeBalanceAmount}>
              {wallet.nativeBalance ? formatNativeAmount(wallet.nativeBalance.amount) : "--"}
            </span>
            <span style={styles.nativeBalanceDenom}>{NATIVE_DENOM_DISPLAY}</span>
          </span>
          <span style={styles.topBarAddress} title={wallet.address ?? undefined}>
            {truncateAddress(wallet.address)}
          </span>
        </>
      )}

      <span
        style={{ ...styles.topBarDot, ...statusDotColor(wallet.status) }}
        title={`Wallet: ${walletStatusLabel[wallet.status]}`}
        aria-label={`Wallet ${walletStatusLabel[wallet.status]}`}
      />

      {wallet.status === "connected" ? (
        <button type="button" style={styles.topBarButton} onClick={wallet.disconnect}>
          Disconnect
        </button>
      ) : (
        // Design note #34 + `ConnectWalletButton`'s own design note #0: the
        // burner-wallet recommendation ships WITH the button, so no entry
        // point can skip it.
        <ConnectWalletButton buttonStyle={styles.topBarConnectButton} />
      )}

      {onLeaveGame && (
        <button type="button" style={styles.topBarButton} onClick={onLeaveGame}>
          &larr; Lobby
        </button>
      )}
    </header>
  );
}
