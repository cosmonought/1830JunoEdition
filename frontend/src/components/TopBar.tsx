// frontend/src/components/TopBar.tsx
//
// THE SLIM TOP BAR -- wallet status, session key, room controls -- moved out
// of `App.tsx` unchanged.
//
// A pure move: the component body, its three private helpers and its one CSS
// string are the same text `App.tsx` carried, with the same design notes.
//
// WHY IT IS SELF-CONTAINED. `firstMissingEnvVar`, `nativeBalanceTitle` and
// `statusDotColor` each have exactly one caller, and it is this component.
// They were top-level functions in a 9,600-line file, which made them look
// like shared utilities and meant that reading `TopBar` required scrolling
// away from it. Travelling with their only consumer is what makes this file
// readable on its own, and it removes three names from the module scope every
// other declaration in `App.tsx` had to share.
//
// `NETA_CREDIT_CSS` likewise. It styles one link in one component; hoisting
// it to a shared stylesheet would have been indirection, not reuse.

import React from "react";

import { useWallet } from "../context/WalletContext";
import { useGameSession } from "../context/GameSessionContext";
import { chainConfigError, formatNativeAmount, NATIVE_DENOM_DISPLAY } from "../config";
import { ConnectWalletButton } from "./ConnectWalletButton";
import { truncateAddress } from "../utils/address";
import { styles } from "../styles/appStyles";

const NETA_CREDIT_CSS = `
.neta-credit { transition: color 120ms ease, text-shadow 120ms ease; }
.neta-credit:hover { color: #ffffff; text-shadow: 0 0 8px rgba(255,255,255,0.35); }
.neta-credit:focus-visible { outline: 2px solid #94a3b8; outline-offset: 2px; color: #ffffff; }
`;

/* ------------------------------------------------------------------ */
/* Main tabs -- see design note #9                                    */
/* ------------------------------------------------------------------ */

/* ==================================================================== */
/*  DESIGN NOTE 28: PHASE TAB vs REFERENCE BOARDS                       */
/* ==================================================================== */
//
// `"phase"` is new, and splitting it out fixes a conflation that had been
// there since the tabs were flattened. One tab used to be both "the thing
// you act in" and "the stock market chart", renaming itself between
// "Auction", "Stock Round" and "Stock Market" depending on the round. That
// meant the 2D market chart -- a REFERENCE board a player wants to consult
// at any time, including mid-auction to see where prices stand -- was
// unreachable during the two phases where it is most worth consulting,
// because the tab that would have shown it was busy being the auction.
//
// The split is along a real line:
//
//   ACTIONABLE   `"phase"`  the surface where the current round is played.
//                           Auction dashboard, or Stock Round panel.
//   REFERENCE    `"map"`    the rail map (also actionable in an OR).
//                `"stock"`  the market chart. Always just a board.
//                `"ledger"` / `"rules"`  never actionable.
//
// The Operating Round is the one phase with no dedicated `"phase"` surface,
// because its actionable surface IS the rail map -- so during an OR the
// phase tab is simply absent and `"map"` leads instead. That is why
// `orderedMainTabs` returns a LIST rather than a fixed array with a
// reshuffle: the tab set itself changes shape by phase, not just its order.
//
/* ==================================================================== */
/*  DESIGN NOTE 41: `"corps"` -- THE PERSISTENT STOCKS TAB              */
/* ==================================================================== */
//
// The corporation roster used to be reachable ONLY as the Stock Round's
// phase surface. That made "who owns what, and what is it worth" a fact you
// could look up during a Stock Round and nowhere else -- including during
// the Operating Round that decides those valuations, which is precisely
// when a player wants to check them.
//
// `"corps"` is therefore its own tab, present in every phase, and during a
// Stock Round it simply IS the phase surface (there is no separate
// `"phase"` tab that round, the same way an Operating Round has none).
//
// NAMING, because this is a trap worth marking: the id is `"corps"` and the
// LABEL is "Stocks", while a DIFFERENT tab has the id `"stock"` and the
// label "Stock Market". `"stock"`/`"stocks"` as sibling ids would be one
// letter apart and impossible to review; the two surfaces are unrelated
// (one is a corporation roster, one is the price chart).

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
      return { backgroundColor: "#4a505e" };
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard Control Bar                                              */
/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 34: ONE TOP BAR
 * ==================================================================
 *
 * There were two full-width headers stacked above the tab bar: this one
 * (brand, Master Wallet, Session Key, JUNO balance, Cash) and the room
 * strip below it (game id, room id, Back to lobby). Three rows of chrome
 * before a single hex of the board -- and the two headers were not even
 * different subjects, both being "what am I connected to".
 *
 * They are one slim strip now: identity and room context on the left,
 * connection controls pushed right, `Connect Keplr` last. The room content
 * arrives as `roomContext` rather than being rebuilt here, because the
 * sandbox phase switcher and the spectator badge need state that lives in
 * `AppShell`; passing a node keeps this component ignorant of game state
 * it has no other reason to know about.
 *
 * WHAT WAS DELETED, AND WHY IT WAS SAFE:
 *
 *   - THE CASH READOUT. In-game cash belongs to the Game Ledger and the
 *     Player Index, not to the row that also shows a crypto balance --
 *     that adjacency was the exact confusion the old F-3 note worried
 *     about, and the honest fix is not two visual treatments of two kinds
 *     of money side by side, it is not putting them side by side.
 *   - THE FIELD LABELS ("Master Wallet", "Session Key", "Wallet"). A
 *     truncated bech32 address next to a status dot does not need a
 *     caption; the tooltips carry the full values.
 *   - THE ALWAYS-VISIBLE "Initialize Session Key" BUTTON. It now appears
 *     only while it is actionable -- wallet connected, session not ready.
 *     Once ready it collapses to a dot, because a button that has already
 *     been pressed and cannot usefully be pressed again is just width.
 *
 * The session key is NOT dropped, only condensed: it is what authorises
 * gameplay transactions, so its state stays visible at all times, and its
 * error still renders inline. */
/* Design note #40: the phase badge is NOT in this bar.
 *
 * It was, briefly, sitting between the brand and the room context. That was
 * the wrong slot for a measurable reason rather than an aesthetic one: this
 * header is a single `flex` row, and adding two more pills to it pushed the
 * wallet cluster -- balance, address, Connect -- onto a second line, which
 * undid the entire point of design note #34's consolidation.
 *
 * The badge now lives at the far right of the Contextual Action Bar, which
 * is also the better home on the merits. The action bar already says WHAT
 * ROUND it is; the phase says which trains and tiles that round can use.
 * The two belong on the same strip, and that strip has spare width because
 * its buttons are left-aligned. */
export default function TopBar({
  roomContext,
  onLeaveGame,
}: {
  /** Room identity / sandbox controls, owned by `AppShell` -- see design
   *  note #34 for why this is a node rather than a pile of props. */
  roomContext?: React.ReactNode;
  onLeaveGame?: () => void;
}) {
  const wallet = useWallet();
  const session = useGameSession();

  // F-4 UI: WHY the wallet cannot connect, when that is a configuration
  // problem rather than a user one.
  //
  // `config.ts` deliberately no longer throws at import (see its design note
  // #0) -- an unconfigured build boots into offline mode instead of dying.
  // The cost of that correctness is that "Connect Keplr" would otherwise look
  // like it should work and simply fail on click. Surfacing the reason turns
  // a dead button into an explained one, and names the exact environment
  // variable so the fix is obvious without reading source.
  //
  // Computed at render, not memoised: it reads build-time constants that
  // cannot change during a session, so there is nothing to cache and a
  // `useMemo` here would only add indirection.
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
      {/* Inline styles cannot express `:hover`; see design note #46. */}
      <style>{NETA_CREDIT_CSS}</style>
      <span style={styles.topBarBrand}>1830: Juno Edition</span>

      {/* Design note #47: the Neta DAO credit.
          Sits with the BRAND, not with the wallet cluster. It is an
          attribution, so it belongs next to the thing being attributed --
          and the right-hand group is the one that already wraps first when
          the bar gets tight (design note #34). Parking a decorative link
          there would push a functional control onto a second line.

          `flexShrink: 0` plus `nowrap` so it never becomes the thing that
          breaks the row, and `rel="noopener noreferrer"` because
          `target="_blank"` without it hands the new tab a `window.opener`
          handle back into this app. */}
      <a
        href="https://netadao.org"
        target="_blank"
        rel="noopener noreferrer"
        className="neta-credit"
        style={styles.netaCredit}
        title="Neta DAO — opens netadao.org in a new tab"
      >
        Powered by Neta DAO
      </a>

      {roomContext}

      {/* Everything after this spacer is pinned right. */}
      <span style={styles.topBarSpacer} />

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
