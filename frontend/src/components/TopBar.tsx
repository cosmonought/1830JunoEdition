// The slim top bar -- the account chip, room controls -- moved out of
// `App.tsx`, with its private helper and its one CSS string. (Phase 3 final, §12: the
// parked on-chain mode's wallet cluster -- address, balance, Connect, session key -- is gone.)
//
// `firstMissingEnvVar` has
// exactly one caller. As top-level functions in a 9,600-line file they looked
// like shared utilities and meant reading `TopBar` required scrolling away from
// it. `NETA_CREDIT_CSS` likewise styles one link in one component.

import React from "react";

import { chainConfigError } from "../config";
import { styles } from "../styles/appStyles";
// Design note #1075: the volume, the off switch, and which effects play -- one panel, two buttons.
import AudioControls from "./AudioControls";
/* Design note #1273: the text-size picker's steps and store. */
import { styles as appStyles } from "../styles/appStyles";
import { UiScalePicker } from "./UiScalePicker";
/* LIVE-2E: the profile chip, reachable at the table and in the waiting room as well as the lobby. */
import { ProfileMenu } from "./ProfileMenu";
import { type AudioCategoryToggle } from "./AudioControlPopover";

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
/* Design note #1273's picker lives in `UiScalePicker.tsx` now (#1336), so the lobby can mount the same one. */

export default function TopBar({
  roomContext,
  roomName = null,
  onLeaveGame,
  onCopyGameLog,
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
  /** W1-N / AUD-01.09: copies the table's action log (the shell's `copySandboxLog`, the same export as Ctrl+Shift+L,
   *  which was its only way in). Absent outside a room, where there is no log -- and then there is no button. */
  onCopyGameLog?: () => void;
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
  /* Design note #1075: one open panel at a time, named rather than a pair of booleans -- two flags can
     both be true and would render two overlapping popovers from the same corner. */
  /** Design note #1094: the disclosure's outer bound -- both trigger buttons and whichever panel is open.
   *  The popover's outside-click listener asks this rather than its own panel, so pressing a trigger is
   *  inside the disclosure and the trigger's toggle is allowed to run. See `AudioControlPopover` #1094. */

  // F-4 UI: why the wallet cannot connect, when that is a configuration problem
  // rather than a user one. `config.ts` deliberately no longer throws at import
  // (its #0), so an unconfigured build boots offline and "Connect Keplr" would
  // otherwise look like it should work and fail on click. Names the exact
  // environment variable. Computed at render -- these are build-time constants
  // that cannot change during a session, so there is nothing to cache.
  const configError = chainConfigError();

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
      {audio && <AudioControls audio={audio} />}

      {/* ==================================================================
           DESIGN NOTE 1273: THE TEXT-SIZE PICKER, WHICH #1149 SAID A THIRD READING WOULD EARN
          ==================================================================
          REPORTED: "everything is way too small" -- one player at 250% browser zoom, on a screen where
          #1149's 0.63 draws body text at eight pixels. The scale is a per-reader preference now
          (`utils/uiScale.ts`); this is where a reader sets it.
          BESIDE THE AUDIO PAIR, for #1009's ordering: it changes what the player SEES and nothing else, so it
          belongs with the control that changes what they hear, furthest from the cluster that can cost
          money. Two 18px steppers around a readout, the tuner's own vocabulary (#1134) at the tuner's size,
          so it does not widen the row the audio note says wraps first.
          IT RELOADS. The scale is baked into style tables at module load, and the log makes a reload
          survivable (#1250, #1253); a control pressed once per browser does not need to be live. */}
      <UiScalePicker />

      {/* LIVE-2E: who this browser plays as, and its account actions (change password, change the Authorization Wallet,
          sign out). With the player-only controls, before the wallet cluster that can cost money. */}
      <ProfileMenu />

      {/* W1-N / AUD-01.09: the log export, visible. It writes nothing to the room, so it sits with the player-only
          controls, before the wallet cluster; the shell says in the Activity Log whether it reached the clipboard. */}
      {onCopyGameLog && (
        <button
          type="button"
          style={styles.topBarButton}
          onClick={onCopyGameLog}
          data-testid="top-bar-copy-game-log"
          title="Copy this table's action log to the clipboard, to attach to a report (also Ctrl+Shift+L)."
        >
          Copy game log
        </button>
      )}

      {/* ==================================================================
           DESIGN NOTE 1119: THE ENV VAR WAS THE PART ONLY A DEVELOPER COULD USE
          ==================================================================
          IT READ "Offline — REACT_APP_CONTRACT_ADDRESS", in warning yellow, permanently, at the top right of
          a game. A player cannot act on the name of a build variable, and the badge's own note admits what it
          was doing -- "the badge shows the actionable half" -- while `firstMissingEnvVar` makes the
          "actionable half" the variable name. It was actionable for whoever runs the build, which is not who
          is looking at it.
          THE FACT SURVIVES, THE SHOUTING DOES NOT. It becomes a dot, which is the vocabulary this bar already
          speaks twice over -- the session key and the wallet each state themselves as a coloured dot with the
          detail in a `title`. Amber rather than yellow-on-yellow, sitting with the other two status dots, and
          the full message including the variable name is still one hover away for the person who can fix it.
          NOT DELETED, because "the chain is not configured" is the reason every on-chain action will fail and
          a board that silently does nothing is worse than a quiet dot. It is diagnosis, so it is sized like
          the other diagnoses instead of like an alarm. */}
      {configError && (
        <span
          style={{ ...styles.topBarDot, ...styles.topBarDotOffline }}
          title={`Offline — ${configError}`}
          aria-label={`Offline — ${firstMissingEnvVar(configError) ?? "chain not configured"}`}
        />
      )}

      {/* ==================================================================
           PHASE 3 FINAL (§12): NO WALLET CLUSTER IN THE BAR -- A KEPLR ADDRESS IS NOT "WHO YOU ARE"
          ==================================================================
          This strip used to carry the parked on-chain mode's wallet furniture: a Connect / Disconnect button, the
          connected address, its balance, a wallet dot and a session-key dot. Beside the account chip it answered
          "who am I" with a Keplr address -- exactly the question the owner ruled a wallet may NOT answer: the PROFILE
          is the player, and the account chip (`ProfileMenu`) is the only "who" on this bar. Every table here is a
          hosted table whose actor the server derives from the session; a seat's wallet is chosen, linked and signed
          with in the money panel, per seat, and Keplr is consulted only at the moment it must sign. */}
      {onLeaveGame && (
        <button type="button" style={styles.topBarButton} onClick={onLeaveGame}>
          &larr; Lobby
        </button>
      )}
    </header>
  );
}
