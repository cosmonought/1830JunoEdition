// frontend/src/components/Lobby.tsx
//
// The pre-game screen: room discovery, the off-chain staging room, and the
// one moment this whole flow exists to defer -- the host's Launch, which is
// where a Firestore room becomes a real on-chain game.
//
// This closes `App.tsx` design note #1's acknowledged gap ("No game/room
// selection UI yet ... `MOCK_GAME_ID` stands in for the currently open
// room"). `MOCK_GAME_ID` is gone; `AppShell` now takes a real `gameId`
// prop, and this component is what produces it.
//
// ===================================================================
//  DESIGN NOTE 0: STAGE OFF-CHAIN, LAUNCH ON-CHAIN
// ===================================================================
//
// Creating a room does NOT touch the chain. A room lives in Firestore
// through its entire gathering phase -- players discover it, take seats,
// chat, and toggle Ready -- at zero gas, and only when the host clicks
// "Launch Game" does anything sign anything.
//
// The alternative (sign `CreateGameRoom` the instant someone clicks Create)
// was rejected for two concrete reasons:
//
//   - It litters the contract with dead rooms. Every abandoned "let me see
//     what this does" click becomes a permanent on-chain `GameSession` with
//     real JUNO locked in it, recoverable only through the Inactivity
//     Timeout Safety Valve. Rooms that never fill should cost nothing and
//     leave no trace.
//   - It makes the lobby unusable without a deployed contract, which would
//     quietly kill the Offline Sandbox Mode that `config.ts` design note #0
//     goes to considerable length to protect.
//
// What that buys, and the cost: the gathering phase is free and works with
// an entirely unconfigured chain, but a Firestore seat is a RESERVATION,
// not a commitment -- nothing stops a player claiming a seat and vanishing
// before they ante. That is why `SeatDoc.onChain` exists and why the seat
// list distinguishes "Ready" (staging intent) from "Anted" (actually in the
// contract's roster). Only the second one means anything.
//
// ===================================================================
//  DESIGN NOTE 1: THE UNIFORM ANTE RULE IS THE CONTRACT'S, NOT OURS
// ===================================================================
//
// `contract::execute_join_game_room` requires every joiner to attach
// EXACTLY the amount the creator deposited -- down to the last `ujuno`,
// with no funds and merely-close amounts both rejected as
// `ContractError::InvalidAnteAmount`. So the host sets the ante once, at
// create time, and `RoomDoc.anteUjuno` advertises it to everyone else.
//
// That advertisement is a CONVENIENCE, not a validation. Firestore is not
// deciding what a legal ante is; it is saving a player from discovering the
// number by having a signed transaction rejected. If a malicious client
// rewrote `anteUjuno`, the only consequence is that joiners would attach
// the wrong amount and the CONTRACT would reject them -- the boundary holds
// because the contract never reads this field.
//
// Amounts are handled as base-denom INTEGER STRINGS throughout, never
// numbers. Same discipline, same reason as `config.ts`'s
// `formatNativeAmount`: a `Uint128` above 2^53 silently loses precision as
// an IEEE-754 double, and the value being mangled is the player's own
// money. `toBaseAmount` below is the inverse conversion and is likewise
// pure string manipulation -- `Number("0.1") * 1e6` is 100000.00000000001,
// which is not a valid `Uint128` and would be rejected on chain.
//
// ===================================================================
//  DESIGN NOTE 2: THE game_id COMES FROM THE TRANSACTION, NOT FROM US
// ===================================================================
//
// `NEXT_GAME_ID` lives in contract storage; the client cannot predict it,
// and guessing (or using the Firestore doc id) would bind the room to a
// game that does not exist or, worse, to somebody else's. The contract
// emits it as a `game_id` attribute on `create_game_room`, so `Launch`
// parses the confirmed transaction's own events and binds THAT.
//
// If the parse fails, the room is deliberately left in an explicit error
// state rather than being guessed at: the transaction succeeded and real
// JUNO has moved, so silently retrying would create a SECOND paid room.
// The error text carries the tx hash so the id can be recovered by hand.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Coin } from "@cosmjs/stargate";
import type { ExecuteResult } from "@cosmjs/cosmwasm-stargate";

import { useWallet } from "../context/WalletContext";
import { ConnectWalletButton } from "./ConnectWalletButton";
import {
  NATIVE_DENOM,
  NATIVE_DENOM_DISPLAY,
  NATIVE_DENOM_EXPONENT,
  chainConfigError,
  formatNativeAmount,
  requireContractAddress,
} from "../config";
import { isFirebaseConfigured, firebaseConfigError } from "../config/firebase";
import ChatBox from "./ChatBox";
// Design note #524: the Firebase sandbox lobby lives on this screen now.
import SandboxRoomBar from "./SandboxRoomBar";
import {
  hostSandboxRoom,
  localPlayerId,
  parseRoomCode,
  readSandboxLog,
  upsertSandboxPlayer,
} from "../utils/sandboxRoom";
import {
  CONTROL_PADDING,
  FONT_FAMILY,
  FONT_FAMILY_MONO,
  FONT_SIZE,
  LINE_HEIGHT,
} from "../styles/typography";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  bindChainGameId,
  claimSeat,
  createStagingRoom,
  loadDisplayName,
  markSeatOnChain,
  releaseSeat,
  saveDisplayName,
  seatLabel,
  setRoomStatus,
  setSeatDisplayName,
  setSeatReady,
  truncateAddress,
  useLobbyRooms,
  usePresenceHeartbeat,
  useRoom,
  type PresenceState,
  type RoomDoc,
  type SeatDoc,
} from "../utils/lobby";

/* ==================================================================== */
/*  DESIGN NOTE 3: THE SILENT-BUTTON BUG, AND THE RULE THAT REPLACED IT  */
/* ==================================================================== */
//
// Symptom as reported: clicking "Create Room" did nothing at all. No UI
// change, no error banner, and -- the detail that identifies the cause --
// NOTHING in the browser console. Not a caught error, not a warning, not a
// failed request.
//
// Cause: the button was `disabled`.
//
//     disabled={!available || !address || !anteValid || busy !== null}
//
// With no wallet connected, `!address` is true, so the button was disabled
// and the browser DISCARDED THE CLICK BEFORE REACT SAW IT. No handler ran,
// so there was nothing to log, nothing to catch, and nothing to display.
// A silent no-op is the correct behaviour for a disabled button; the bug is
// that it did not look disabled.
//
// It did not look disabled because this codebase styles with inline
// `React.CSSProperties` objects, and INLINE STYLES CANNOT EXPRESS
// `:disabled`. A pseudo-class needs a stylesheet. So `styles.primaryButton`
// rendered a full-contrast, pointer-cursor, entirely clickable-looking
// button whose clicks went nowhere. Eleven buttons in this file were
// disabled somewhere in their lifecycle and not one had any disabled
// appearance -- so this was not one broken button, it was eleven identical
// traps, and Create Room simply happened to be the one clicked first.
//
// Two rules now, and the second matters more than the first:
//
//   1. NEVER `disabled` WITHOUT `disabledButtonStyle`. Every `disabled`
//      prop in this file is paired with a style computed through that
//      helper, so a disabled control is always visibly disabled.
//
//   2. PREFER A LOUD FAILURE TO A DISABLED CONTROL. Disabling is now
//      reserved for "an action is already in flight" (`busy`), which is
//      genuinely transient and self-explanatory. Every OTHER precondition
//      -- no wallet, no Firebase, malformed ante -- leaves the button
//      ENABLED and reports the specific reason when clicked, via the same
//      error banner every other failure uses.
//
//      This inverts the usual instinct, so here is the justification: a
//      disabled button answers "can I do this?" with silence, and the user
//      is left to guess which of four preconditions they have missed. An
//      enabled button that says "Connect a wallet first -- the room is
//      stored under your address as host" answers the question they
//      actually have. The precondition is still enforced (in
//      `handleCreate`, which throws), so nothing invalid gets through; the
//      only thing that changed is that refusing now explains itself.
//
// `blockedReason` below is the shared shape for rule 2: a nullable string
// that is both rendered inline under the control AND raised into the error
// banner on click.

/** Visibly greys out a disabled control -- see design note #3, rule 1.
 *
 *  `pointerEvents` is deliberately NOT set to `none`: the click must still
 *  reach React so a genuinely disabled (busy) control can be distinguished
 *  from a dead one during debugging, and so the `title` tooltip still
 *  appears on hover. `cursor: not-allowed` is what communicates it. */
function disabledButtonStyle(
  base: React.CSSProperties,
  disabled: boolean,
): React.CSSProperties {
  if (!disabled) return base;
  return { ...base, opacity: 0.4, cursor: "not-allowed" };
}

/** Survives a page reload so a player who refreshes mid-staging lands back
 *  in their room instead of at the room list wondering where it went.
 *  `sessionStorage`, not `localStorage`: rejoining a stale room in a new
 *  browser session a week later is not helpful. */
const ACTIVE_ROOM_STORAGE_KEY = "18cosmos.active_room.v1";

/** Default `CreateGameRoom { virtual_bank_start }`. Matches the figure
 *  `msg.rs` uses in its own doc comment example. */
const DEFAULT_VIRTUAL_BANK_START = "12000";

/** Default ante, in display `JUNO`. Small on purpose -- this is real money
 *  and the field is prefilled, so the prefill must not be a number anyone
 *  would regret confirming without reading. */
const DEFAULT_ANTE_DISPLAY = "1";

export interface LobbyProps {
  /** Called with the CONTRACT's game id once the player is genuinely in the
   *  room's on-chain roster. `roomId` rides along because the dashboard
   *  still needs the Firestore room for chat and presence -- the two ids
   *  are different things and both are load-bearing after this point. */
  onEnterGame: (chainGameId: number, roomId: string) => void;
  /** Opens a game the viewer is NOT playing in, read-only.
   *
   *  A separate callback rather than a flag on `onEnterGame`, because the
   *  two are different in kind and confusing them would be expensive:
   *  entering means "I am in this contract's roster and may act", and
   *  spectating means "I may look and may not". Keeping them as distinct
   *  entry points means a caller cannot accidentally open a playable board
   *  by forgetting a boolean. */
  onSpectateGame: (chainGameId: number, roomId: string) => void;
  /** The escape hatch -- opens the board against local mock state with no
   *  chain, no wallet and no Firestore room. See `App.tsx` design note #24
   *  for why this exists: with a mock contract address you cannot launch,
   *  and with a fresh Firebase there is nothing to spectate, so without
   *  this the lobby has no exit at all and `HexGridRenderer` is
   *  unreachable. */
  /** Design note #524: carries the Firebase sandbox room code, or `null`
   *  for an ordinary solo sandbox. */
  onEnterSandbox: (sandboxRoomCode?: string | null) => void;
}

/** Which half of the room browser is showing.
 *
 *  NAMING NOTE: the requested filter for the second tab was
 *  `status: "active"`. This schema has no `"active"` -- the equivalent is
 *  `"live"` (see `RoomStatus` in `utils/lobby.ts`), meaning "launched, bound
 *  to an on-chain `game_id`, contract is now in charge". A second status
 *  string meaning the same thing as an existing one is exactly the kind of
 *  drift `config.ts` design note #1 is about, so the tab is LABELLED "Live
 *  Games" and filters on `"live"` rather than introducing an alias. The
 *  contract's own `GameStateResponse.is_active` is a different flag again --
 *  it distinguishes a running game from a finished one, which is a question
 *  only the chain can answer and Firestore deliberately does not mirror. */
type BrowserTab = "open" | "live";

/* ------------------------------------------------------------------ */
/* Amount conversion -- design note #1, integer string math only       */
/* ------------------------------------------------------------------ */

/** Display units (`"1.5"` JUNO) -> base-denom integer string
 *  (`"1500000"` ujuno). Returns `null` for anything malformed, including
 *  more fractional digits than the denom actually has -- silently
 *  truncating a player's stated amount is not an acceptable failure mode
 *  when the amount is a deposit. */
export function toBaseAmount(display: string): string | null {
  const trimmed = display.trim();
  if (!/^\d+(\.\d*)?$/.test(trimmed)) return null;

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > NATIVE_DENOM_EXPONENT) return null;

  const padded = fraction.padEnd(NATIVE_DENOM_EXPONENT, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined.length === 0 ? "0" : combined;
}

/* ------------------------------------------------------------------ */
/* Transaction event parsing -- design note #2                         */
/* ------------------------------------------------------------------ */

/** Pulls the contract-assigned `game_id` out of a confirmed
 *  `CreateGameRoom` transaction.
 *
 *  Reads the `wasm` event specifically. Every attribute a CosmWasm contract
 *  adds via `Response::add_attribute` is emitted under that event type, and
 *  scoping to it avoids picking up a same-named attribute from an unrelated
 *  module in a multi-message transaction. */
export function parseGameIdFromExecuteResult(result: ExecuteResult): number | null {
  for (const event of result.events ?? []) {
    if (event.type !== "wasm") continue;
    for (const attribute of event.attributes ?? []) {
      if (attribute.key !== "game_id") continue;
      const parsed = Number(attribute.value);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lobby                                                               */
/* ------------------------------------------------------------------ */

/* Design note #525: the Web3 lobby's on-switch. `false` parks the room
   browser and the staging room together for sandbox playtesting; `true`
   restores the screen exactly as it was. One flag, one place, no other
   edits -- so turning it back on is a one-character change rather than a
   revert somebody has to reconstruct. */
const WEB3_LOBBY_ENABLED = false;

export function Lobby({ onEnterGame, onSpectateGame, onEnterSandbox }: LobbyProps) {
  /* Design note #524: the sandbox room handlers. Local to this screen -- the
     code is handed straight to `onEnterSandbox` and this component unmounts,
     so there is nothing to keep. */
  const [sandboxRoomError, setSandboxRoomError] = useState<string | null>(null);
  const [sandboxRoomBusy, setSandboxRoomBusy] = useState(false);

  const handleHostSandboxRoom = useCallback(async () => {
    setSandboxRoomBusy(true);
    setSandboxRoomError(null);
    try {
      const code = await hostSandboxRoom(localPlayerId(), "Host");
      if (!code) {
        setSandboxRoomError("Firestore is not configured in this build.");
        return;
      }
      onEnterSandbox(code);
    } catch (error) {
      setSandboxRoomError(error instanceof Error ? error.message : "Could not open the room.");
    } finally {
      setSandboxRoomBusy(false);
    }
  }, [onEnterSandbox]);

  const handleJoinSandboxRoom = useCallback(
    async (raw: string) => {
      const code = parseRoomCode(raw);
      if (!code) {
        setSandboxRoomError("That is not a room code — they look like JUNO-4T2.");
        return;
      }
      setSandboxRoomBusy(true);
      setSandboxRoomError(null);
      try {
        /* Read the log once purely to TELL THE PLAYER whether the room is
           real before the board opens. An empty log and a wrong code are
           indistinguishable once you are inside, and the second is a much
           more common mistake than the first. The replay itself belongs to
           the shell's listener; doing it here would apply the history
           twice. */
        await readSandboxLog(code);
        /* Design note #527: joining means taking a seat in the anteroom.
           Done here rather than in the waiting room so a player who joins
           and then closes the tab has still been seen -- and so the room's
           roster is correct the moment the screen opens rather than one
           round trip later. */
        await upsertSandboxPlayer(code, {
          id: localPlayerId(),
          nickname: "Player",
          isReady: false,
        });
        onEnterSandbox(code);
      } catch (error) {
        setSandboxRoomError(error instanceof Error ? error.message : "Could not join that room.");
      } finally {
        setSandboxRoomBusy(false);
      }
    },
    [onEnterSandbox],
  );

  const wallet = useWallet();
  const address = wallet.address;

  const [activeRoomId, setActiveRoomId] = useState<string | null>(() => {
    try {
      return window.sessionStorage.getItem(ACTIVE_ROOM_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const [displayName, setDisplayNameState] = useState<string>(() => loadDisplayName() ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { rooms, loading: roomsLoading, error: roomsError, available } = useLobbyRooms();
  const { room, seats, presence, error: roomError } = useRoom(activeRoomId);

  // Design note #1 of `utils/lobby.ts`: this runs for as long as the player
  // is in a room, keeping their seat marked alive.
  usePresenceHeartbeat(activeRoomId, address);

  useEffect(() => {
    try {
      if (activeRoomId) window.sessionStorage.setItem(ACTIVE_ROOM_STORAGE_KEY, activeRoomId);
      else window.sessionStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY);
    } catch {
      /* private browsing -- the room is still usable, just not resumable */
    }
  }, [activeRoomId]);

  // A room the player has stored but which no longer exists (host cancelled
  // while they were away) must not strand them on a blank screen.
  useEffect(() => {
    if (activeRoomId && room === null && !roomError) {
      const timer = window.setTimeout(() => setActiveRoomId((current) => (current === activeRoomId ? null : current)), 4000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [activeRoomId, room, roomError]);

  const mySeat = useMemo(
    () => (address ? seats.find((seat) => seat.address === address) ?? null : null),
    [seats, address],
  );
  const isHost = room !== null && address !== null && room.hostAddress === address;

  const chainError = chainConfigError();
  const firebaseError = firebaseConfigError();

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      setActionError(null);
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        // Design note #3: ALSO log. The banner is for the user; this is for
        // the next person debugging with the console open. The original
        // report of this screen failing came with "there are no errors in
        // the console", which was true and was itself the clue -- an empty
        // console should mean nothing ran, never that something failed
        // quietly. Anything that goes wrong here is now visible in both
        // places.
        // eslint-disable-next-line no-console
        console.error(`[lobby] ${label} failed:`, error);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /** Reports a precondition failure through the same banner real errors use
   *  -- design note #3, rule 2. */
  const reportBlocked = useCallback((message: string) => {
    setActionError(message);
    // eslint-disable-next-line no-console
    console.warn(`[lobby] action blocked: ${message}`);
  }, []);

  /* ---------------- Display name ---------------- */

  const commitDisplayName = useCallback(
    (value: string) => {
      setDisplayNameState(value);
      saveDisplayName(value);
      if (activeRoomId && address) {
        void setSeatDisplayName(activeRoomId, address, value).catch(() => {
          /* cosmetic; the next heartbeat or ready-toggle carries it anyway */
        });
      }
    },
    [activeRoomId, address],
  );

  /* ---------------- Room list actions ---------------- */

  const handleCreate = useCallback(
    (name: string, maxPlayers: number, anteDisplay: string) =>
      runAction("create", async () => {
        if (!address) throw new Error("Connect a wallet before creating a room.");
        const anteUjuno = toBaseAmount(anteDisplay);
        if (anteUjuno === null) {
          throw new Error(
            `"${anteDisplay}" is not a valid ${NATIVE_DENOM_DISPLAY} amount. ` +
              `Use up to ${NATIVE_DENOM_EXPONENT} decimal places, e.g. "1.5".`,
          );
        }
        const roomId = await createStagingRoom({
          name,
          maxPlayers,
          hostAddress: address,
          hostDisplayName: displayName,
          anteUjuno,
          virtualBankStart: DEFAULT_VIRTUAL_BANK_START,
        });
        setActiveRoomId(roomId);
      }),
    [address, displayName, runAction],
  );

  const handleJoin = useCallback(
    (target: RoomDoc) =>
      runAction(`join:${target.id}`, async () => {
        if (!address) throw new Error("Connect a wallet before joining a room.");
        await claimSeat(target.id, address, displayName);
        setActiveRoomId(target.id);
      }),
    [address, displayName, runAction],
  );

  /** Opens a live game read-only. Deliberately claims NO seat and requires
   *  NO wallet -- a spectator is not a participant in either system. They
   *  are not in the contract's roster, so the chain would reject any action
   *  from them regardless, and they get no Firestore seat doc, so they never
   *  appear in the table's player list or occupy capacity. */
  const handleSpectate = useCallback(
    (target: RoomDoc) => {
      if (target.chainGameId === null) {
        setActionError("That game has not finished launching yet — there is nothing on-chain to watch.");
        return;
      }
      onSpectateGame(target.chainGameId, target.id);
    },
    [onSpectateGame],
  );

  /* ---------------- Staging room actions ---------------- */

  const handleLeave = useCallback(
    () =>
      runAction("leave", async () => {
        if (activeRoomId && address) await releaseSeat(activeRoomId, address);
        setActiveRoomId(null);
      }),
    [activeRoomId, address, runAction],
  );

  const handleToggleReady = useCallback(
    () =>
      runAction("ready", async () => {
        if (!activeRoomId || !address || !mySeat) return;
        await setSeatReady(activeRoomId, address, !mySeat.ready);
      }),
    [activeRoomId, address, mySeat, runAction],
  );

  const handleRemoveSeat = useCallback(
    (seat: SeatDoc) =>
      runAction(`remove:${seat.address}`, async () => {
        if (!activeRoomId) return;
        await releaseSeat(activeRoomId, seat.address);
      }),
    [activeRoomId, runAction],
  );

  const handleCancelRoom = useCallback(
    () =>
      runAction("cancel", async () => {
        if (!activeRoomId) return;
        await setRoomStatus(activeRoomId, "closed");
        setActiveRoomId(null);
      }),
    [activeRoomId, runAction],
  );

  /* ---------------- The launch -- design note #0 / #2 ---------------- */

  const handleLaunch = useCallback(
    () =>
      runAction("launch", async () => {
        if (!room || !activeRoomId) throw new Error("No room is open.");
        if (!address || !wallet.signingClient) {
          throw new Error("Connect a wallet before launching — this transaction moves real JUNO.");
        }
        // Throws naming the exact missing variable if the chain is
        // unconfigured. This is the first thing here that genuinely needs a
        // contract, so it is the right place to fail (config.ts note #0).
        const contractAddress = requireContractAddress();

        if (seats.length < MIN_PLAYERS) {
          throw new Error(`A game needs at least ${MIN_PLAYERS} players. This room has ${seats.length}.`);
        }
        if (!seats.every((seat) => seat.ready)) {
          throw new Error("Every player must be Ready before the room can launch.");
        }

        const funds: Coin[] = [{ denom: NATIVE_DENOM, amount: room.anteUjuno }];

        await setRoomStatus(activeRoomId, "launching");
        let result: ExecuteResult;
        try {
          result = await wallet.signingClient.execute(
            address,
            contractAddress,
            {
              CreateGameRoom: {
                virtual_bank_start: room.virtualBankStart,
                // `max_players` fixes the denominator for EVERY player's
                // starting capital (msg.rs), so it is the room's
                // configured size, never the current headcount -- using the
                // latter would hand different players different capital.
                max_players: room.maxPlayers,
              },
            },
            "auto",
            `1830 Juno: create room "${room.name}"`,
            funds,
          );
        } catch (error) {
          // The transaction failed, so nothing moved. Safe to return the
          // room to staging and let the host retry.
          const message = error instanceof Error ? error.message : String(error);
          await setRoomStatus(activeRoomId, "staging", message);
          throw error;
        }

        const chainGameId = parseGameIdFromExecuteResult(result);
        if (chainGameId === null) {
          // Design note #2: the tx SUCCEEDED and real JUNO has moved. Do not
          // retry, do not guess -- surface the hash so the id can be
          // recovered by hand.
          const message =
            `The room was created on-chain (tx ${result.transactionHash}) but no game_id ` +
            "attribute could be read from the transaction. Recover the id from that " +
            "transaction before retrying — launching again would create a second paid room.";
          await setRoomStatus(activeRoomId, "staging", message);
          throw new Error(message);
        }

        await bindChainGameId(activeRoomId, chainGameId);
        // The contract registers the creator as the room's first player, so
        // the host is in the roster the moment this confirms.
        await markSeatOnChain(activeRoomId, address);
        await wallet.refreshNativeBalance();

        onEnterGame(chainGameId, activeRoomId);
      }),
    [room, activeRoomId, address, wallet, seats, runAction, onEnterGame],
  );

  /* ---------------- The ante -- joiners, once live ---------------- */

  const handleAnte = useCallback(
    () =>
      runAction("ante", async () => {
        if (!room || !activeRoomId) throw new Error("No room is open.");
        if (room.chainGameId === null) throw new Error("This room has not launched yet.");
        if (!address || !wallet.signingClient) throw new Error("Connect a wallet to ante in.");
        const contractAddress = requireContractAddress();

        // Design note #1: EXACTLY the creator's deposit. The contract
        // rejects anything else outright.
        const funds: Coin[] = [{ denom: NATIVE_DENOM, amount: room.anteUjuno }];

        await wallet.signingClient.execute(
          address,
          contractAddress,
          { JoinGameRoom: { game_id: room.chainGameId } },
          "auto",
          `1830 Juno: join room ${room.chainGameId}`,
          funds,
        );

        await markSeatOnChain(activeRoomId, address);
        await wallet.refreshNativeBalance();
        onEnterGame(room.chainGameId, activeRoomId);
      }),
    [room, activeRoomId, address, wallet, runAction, onEnterGame],
  );

  const handleEnter = useCallback(() => {
    if (room?.chainGameId !== null && room?.chainGameId !== undefined && activeRoomId) {
      onEnterGame(room.chainGameId, activeRoomId);
    }
  }, [room, activeRoomId, onEnterGame]);

  /* ---------------- Render ---------------- */

  return (
    <div style={styles.root}>
      <header style={styles.brandHeader}>
        <div>
          <h1 style={styles.brandTitle}>Project 18XX</h1>
          <p style={styles.brandSubtitle}>Pre-game lobby &middot; rooms stage off-chain and cost nothing until launch</p>
        </div>

        <div style={styles.headerControls}>
          <input
            type="text"
            value={displayName}
            onChange={(event) => commitDisplayName(event.target.value)}
            placeholder="Display name"
            aria-label="Your display name"
            style={styles.nameInput}
            maxLength={24}
          />
          {address ? (
            <>
              <span style={styles.addressBadge} title={address}>
                {truncateAddress(address)}
              </span>
              {wallet.nativeBalance && (
                <span style={styles.balanceBadge}>
                  {formatNativeAmount(wallet.nativeBalance.amount)} {NATIVE_DENOM_DISPLAY}
                </span>
              )}
              <button type="button" style={styles.secondaryButton} onClick={wallet.disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            // The burner-wallet security recommendation ships with the
            // button (see `ConnectWalletButton.tsx` design note #0), so the
            // lobby's connect path shows it just like the in-game top bar's
            // does. Calling `wallet.connect()` directly here is exactly the
            // omission that component exists to make impossible.
            <ConnectWalletButton
              buttonStyle={disabledButtonStyle(
                styles.primaryButton,
                wallet.status === "connecting",
              )}
            />
          )}
        </div>
      </header>

      {/* Honest, specific banners -- never a silently empty screen. Each
          names what is missing and what still works without it. */}
      {!isFirebaseConfigured() && <Banner tone="error" text={firebaseError ?? "Firebase is not configured."} />}
      {chainError && (
        <Banner
          tone="warn"
          text={`Chain not configured — you can stage a room and chat, but nothing can launch on-chain. ${chainError}`}
        />
      )}
      {wallet.error && <Banner tone="error" text={wallet.error} />}
      {actionError && <Banner tone="error" text={actionError} />}
      {roomsError && <Banner tone="error" text={roomsError} />}
      {roomError && <Banner tone="error" text={roomError} />}

      {/* ---- The escape hatch (App.tsx design note #24) ----------------
          Placed OUTSIDE the room-browser/staging-room branch below, so it
          is reachable in every state this screen can be in -- including
          the states that motivated it: Firebase unconfigured, no wallet,
          no rooms, or stuck in a staging room that can never launch
          because the contract address is a placeholder.

          Deliberately has NO `disabled` condition of any kind. It is the
          one control on this screen that must work when everything else is
          broken, which is exactly why it must never be gated on any of the
          things that might be broken. */}
      {/* ==================================================================
           DESIGN NOTE 586: THE OFFLINE STRIP IS GONE
          ==================================================================

           Design note #578 removed solo sandbox, and this button outlived it
           by one pass -- so the Lobby went on offering an "Offline Sandbox"
           that landed on a screen asking the player to host a room. A door
           labelled for a room that no longer exists.

           NOTHING TO MERGE. Both strips called the same `onEnterSandbox`,
           the offline one passing `null` and the multiplayer one passing a
           code, and that single handler is the only path into the shell.
           There was never a second branch behind the second button -- which
           is why deleting the button is the whole change. */}

      {/* ==================================================================
           DESIGN NOTE 524: THE MULTIPLAYER DECISION IS A LOBBY DECISION
          ==================================================================

           Design note #522 mounted this strip inside the game shell, which
           put "host or join" BEHIND "enter the sandbox". Two playtesters
           therefore had to open the board separately, find a strip neither
           knew was there, and only then discover each other -- a
           multiplayer feature whose first step was for everyone to go and
           play alone.

           It sits with the other lobby decisions now, directly under the
           sandbox entry it modifies. The plain "Enter Offline Sandbox"
           button above is untouched and still opens a solo session, so the
           escape hatch that note #24 built keeps its own promise: it has no
           `disabled` condition and does not depend on Firestore.

           HOSTING ENTERS IMMEDIATELY. The alternative -- show the code, wait
           for a "start" -- is a staging room, and the Web3 lobby already has
           one of those for a flow that genuinely needs it (an ante, a
           contract call, a launch). A sandbox room needs none of that: the
           code is visible on the board's own strip, and a joiner can arrive
           at any point because the log replays. */}
      <section style={styles.sandboxStrip}>
        <div style={styles.sandboxCopy}>
          <span style={styles.sandboxTitle}>👥 Sandbox Multiplayer</span>
          <span style={styles.sandboxNote}>
            Play the sandbox with other people in real time, over Firestore — still no wallet
            and no contract. Host a room and read the code out, or join one somebody gives you.
          </span>
        </div>
        <SandboxRoomBar
          roomCode={null}
          available={isFirebaseConfigured()}
          appliedCount={0}
          error={sandboxRoomError}
          busy={sandboxRoomBusy}
          onHost={handleHostSandboxRoom}
          onJoin={handleJoinSandboxRoom}
          onLeave={() => undefined}
        />
      </section>

      {/* ==================================================================
           DESIGN NOTE 525: THE WEB3 LOBBY IS PARKED, NOT DELETED
          ==================================================================

           REPORTED: hide the Web3 "Create Room" lobby while the Firebase
           middleware is being playtested, so testers do not click it and hit
           a "No wallet connected" wall.

           It is gated behind ONE flag rather than removed, and the constant
           is at the top of this file where it can be found. Deleting a
           working staging room -- seats, ready checks, the ante, the
           contract launch -- to run a playtest would cost far more to
           rebuild than it costs to switch off, and this file's own design
           note #24 already records what happens when the lobby becomes
           unreachable by accident.

           WHAT IS HIDDEN IS THE WHOLE BRANCH, browser and staging room
           alike. Hiding only the create button would leave a room list that
           cannot be joined, which is a worse trap than the one being
           removed: a control that looks live and refuses is harder to
           dismiss than one that is absent.

           THE SANDBOX PATHS ARE OUTSIDE IT and unaffected -- both strips sit
           above this branch, so the escape hatch and the new multiplayer
           entry keep working exactly as they did. That is the same placement
           argument note #24 made for putting the hatch outside the branch in
           the first place. */}
      {!WEB3_LOBBY_ENABLED ? (
        <section style={styles.sandboxStrip}>
          <div style={styles.sandboxCopy}>
            <span style={styles.sandboxTitle}>⛓ On-chain rooms — paused</span>
            <span style={styles.sandboxNote}>
              The Juno wallet lobby is switched off while sandbox multiplayer is being tested.
              Flip <code>WEB3_LOBBY_ENABLED</code> in <code>Lobby.tsx</code> to bring it back.
            </span>
          </div>
        </section>
      ) : activeRoomId && room ? (
        <StagingRoom
          room={room}
          seats={seats}
          presence={presence}
          mySeat={mySeat}
          isHost={isHost}
          address={address}
          displayName={displayName}
          busy={busy}
          onToggleReady={handleToggleReady}
          onLeave={handleLeave}
          onRemoveSeat={handleRemoveSeat}
          onLaunch={handleLaunch}
          onAnte={handleAnte}
          onEnter={handleEnter}
          onCancelRoom={handleCancelRoom}
        />
      ) : activeRoomId ? (
        <p style={styles.hint}>Loading room...</p>
      ) : (
        <RoomBrowser
          rooms={rooms}
          loading={roomsLoading}
          available={available}
          address={address}
          busy={busy}
          onCreate={handleCreate}
          onJoin={handleJoin}
          onSpectate={handleSpectate}
          onBlocked={reportBlocked}
        />
      )}
    </div>
  );
}

export default Lobby;

/* ------------------------------------------------------------------ */
/* Room browser                                                        */
/* ------------------------------------------------------------------ */

function RoomBrowser({
  rooms,
  loading,
  available,
  address,
  busy,
  onCreate,
  onJoin,
  onSpectate,
  onBlocked,
}: {
  rooms: RoomDoc[];
  loading: boolean;
  available: boolean;
  address: string | null;
  busy: string | null;
  onCreate: (name: string, maxPlayers: number, anteDisplay: string) => void;
  onJoin: (room: RoomDoc) => void;
  onSpectate: (room: RoomDoc) => void;
  /** Raises a precondition failure into the parent's error banner --
   *  design note #3, rule 2. */
  onBlocked: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [ante, setAnte] = useState(DEFAULT_ANTE_DISPLAY);
  const [tab, setTab] = useState<BrowserTab>("open");

  const anteBase = toBaseAmount(ante);
  const anteValid = anteBase !== null;

  /** Why creating is currently impossible, or `null` if it is possible.
   *
   *  Ordered most-fundamental first, so the message names the thing to fix
   *  FIRST rather than the last check that happened to fail. Each string is
   *  written to be actionable on its own -- "Connect a wallet" rather than
   *  "wallet required" -- because this is the entire explanation the user
   *  gets. */
  const createBlockedReason: string | null = !available
    ? "The real-time lobby is offline, so a room cannot be created. Check the REACT_APP_FIREBASE_* values in frontend/.env, then restart the dev server."
    : !address
      ? "Connect a wallet first — the room is stored under your address as its host."
      : !anteValid
        ? `"${ante}" is not a valid ${NATIVE_DENOM_DISPLAY} amount. Use up to ${NATIVE_DENOM_EXPONENT} decimal places, for example 1.5.`
        : null;

  // Partitioned once rather than filtered twice, so the tab COUNTS and the
  // tab CONTENTS can never disagree -- two independent filters over the same
  // array is how a badge ends up saying "3" above an empty list.
  const { openRooms, liveRooms } = useMemo(() => {
    const open: RoomDoc[] = [];
    const live: RoomDoc[] = [];
    for (const room of rooms) {
      if (room.status === "staging") open.push(room);
      // `launching` belongs here, not in Open Lobbies: the host has already
      // signed, so the room is no longer joinable -- but it has no
      // `chainGameId` yet, so it is not watchable either. It appears in this
      // tab with Spectate disabled, which is the honest representation of a
      // transient state, rather than vanishing from both tabs for the
      // duration of a block time.
      else if (room.status === "live" || room.status === "launching") live.push(room);
    }
    return { openRooms: open, liveRooms: live };
  }, [rooms]);

  const visibleRooms = tab === "open" ? openRooms : liveRooms;

  return (
    <div style={styles.browserGrid}>
      <section style={styles.panel}>
        <h2 style={styles.panelTitle}>Create a room</h2>
        <p style={styles.panelNote}>
          Costs nothing. The room stays off-chain while players gather — the on-chain game is
          created when you launch.
        </p>

        <label style={styles.label}>
          Room name
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Friday night 1830"
            style={styles.input}
            maxLength={48}
          />
        </label>

        <label style={styles.label}>
          Players
          <select
            value={maxPlayers}
            onChange={(event) => setMaxPlayers(Number(event.target.value))}
            style={styles.input}
          >
            {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, index) => MIN_PLAYERS + index).map(
              (count) => (
                <option key={count} value={count}>
                  {count} players
                </option>
              ),
            )}
          </select>
        </label>

        <label style={styles.label}>
          Ante per player ({NATIVE_DENOM_DISPLAY})
          <input
            type="text"
            inputMode="decimal"
            value={ante}
            onChange={(event) => setAnte(event.target.value)}
            style={{ ...styles.input, ...(anteValid ? {} : styles.inputInvalid) }}
          />
        </label>
        <p style={styles.panelNote}>
          {anteValid
            ? `Every player deposits exactly ${anteBase} ${NATIVE_DENOM} — the contract enforces this to the last unit.`
            : `Not a valid amount. Up to ${NATIVE_DENOM_EXPONENT} decimal places.`}
        </p>

        {/* Design note #3. Disabled ONLY while a create is in flight;
            every other precondition leaves the button live and explains
            itself on click instead of silently eating the event. */}
        <button
          type="button"
          style={disabledButtonStyle(styles.primaryButton, busy !== null)}
          disabled={busy !== null}
          onClick={() => {
            if (createBlockedReason) {
              onBlocked(createBlockedReason);
              return;
            }
            onCreate(name, maxPlayers, ante);
          }}
        >
          {busy === "create" ? "Creating..." : "Create room"}
        </button>

        {/* The same reason, shown before the click as well as after it --
            an explanation that only appears once you have already been
            refused is half an explanation. */}
        {createBlockedReason && <p style={styles.blockedNote}>⚠ {createBlockedReason}</p>}
      </section>

      <section style={styles.panel}>
        <div style={styles.tabBar} role="tablist" aria-label="Room browser">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "open"}
            style={{ ...styles.tabButton, ...(tab === "open" ? styles.tabButtonActive : {}) }}
            onClick={() => setTab("open")}
          >
            Open Lobbies
            <span style={styles.tabCount}>{openRooms.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "live"}
            style={{ ...styles.tabButton, ...(tab === "live" ? styles.tabButtonActive : {}) }}
            onClick={() => setTab("live")}
          >
            Live Games
            <span style={styles.tabCount}>{liveRooms.length}</span>
          </button>
        </div>

        <p style={styles.panelNote}>
          {tab === "open"
            ? "Rooms still gathering players. Nothing is on-chain yet — joining costs no gas."
            : "Rooms that have launched on-chain. Spectating is read-only: you can watch the board, ledger and market, but every action control is disabled."}
        </p>

        {!available && <p style={styles.hint}>Real-time lobby is offline — no rooms can be listed.</p>}
        {available && loading && <p style={styles.hint}>Loading rooms...</p>}
        {available && !loading && visibleRooms.length === 0 && (
          <p style={styles.hint}>
            {tab === "open"
              ? "No open lobbies. Create one and invite the table."
              : "No games in progress right now."}
          </p>
        )}

        <div style={styles.roomList}>
          {visibleRooms.map((room) =>
            tab === "open" ? (
              <OpenLobbyRow
                key={room.id}
                room={room}
                address={address}
                busy={busy}
                onJoin={() => onJoin(room)}
                onBlocked={onBlocked}
              />
            ) : (
              <LiveGameRow key={room.id} room={room} onSpectate={() => onSpectate(room)} />
            ),
          )}
        </div>
      </section>
    </div>
  );
}

/** One row in the Open Lobbies tab. */
function OpenLobbyRow({
  room,
  address,
  busy,
  onJoin,
  onBlocked,
}: {
  room: RoomDoc;
  address: string | null;
  busy: string | null;
  onJoin: () => void;
  onBlocked: (message: string) => void;
}) {
  const full = room.seatCount >= room.maxPlayers;

  // Design note #3, rule 2. "Full" stays a genuine `disabled` -- it is a
  // property of the room that no action by this user can change, so there
  // is nothing to explain and nothing to try. "No wallet" is the opposite:
  // entirely fixable, and worth saying out loud.
  const joinBlockedReason: string | null = !address
    ? "Connect a wallet first — a seat is claimed under your address."
    : null;

  return (
    <div style={styles.roomRow}>
      <div style={styles.roomRowMain}>
        <span style={styles.roomName}>{room.name}</span>
        <span style={styles.roomMeta}>
          Host {room.hostDisplayName || truncateAddress(room.hostAddress)} &middot;{" "}
          {formatNativeAmount(room.anteUjuno)} {NATIVE_DENOM_DISPLAY} ante
        </span>
      </div>
      <span style={styles.seatPill}>
        {room.seatCount}/{room.maxPlayers}
      </span>
      <button
        type="button"
        style={disabledButtonStyle(styles.secondaryButton, full || busy !== null)}
        disabled={full || busy !== null}
        onClick={() => {
          if (joinBlockedReason) {
            onBlocked(joinBlockedReason);
            return;
          }
          onJoin();
        }}
        title={joinBlockedReason ?? undefined}
      >
        {busy === `join:${room.id}` ? "Joining..." : full ? "Full" : "Join"}
      </button>
    </div>
  );
}

/** One row in the Live Games tab.
 *
 *  No wallet check on Spectate, unlike Join: watching requires no identity
 *  because it performs no write in either system -- no seat is claimed and
 *  no transaction is signed. See `AppShell`'s own read-only query client for
 *  how the board is populated without a connected wallet. */
function LiveGameRow({ room, onSpectate }: { room: RoomDoc; onSpectate: () => void }) {
  const launching = room.status === "launching" || room.chainGameId === null;

  return (
    <div style={styles.roomRow}>
      <div style={styles.roomRowMain}>
        <span style={styles.roomName}>{room.name}</span>
        <span style={styles.roomMeta}>
          {room.chainGameId !== null ? `On-chain game #${room.chainGameId}` : "Awaiting confirmation"} &middot; Host{" "}
          {room.hostDisplayName || truncateAddress(room.hostAddress)}
        </span>
      </div>
      <span style={styles.seatPill}>
        {room.seatCount}/{room.maxPlayers}
      </span>
      <StatusPill status={room.status} />
      <button
        type="button"
        style={disabledButtonStyle(styles.secondaryButton, launching)}
        disabled={launching}
        onClick={onSpectate}
        title={launching ? "The launch transaction has not confirmed yet" : "Watch this game read-only"}
      >
        {launching ? "Launching..." : "👁 Spectate"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Staging room                                                        */
/* ------------------------------------------------------------------ */

function StagingRoom({
  room,
  seats,
  presence,
  mySeat,
  isHost,
  address,
  displayName,
  busy,
  onToggleReady,
  onLeave,
  onRemoveSeat,
  onLaunch,
  onAnte,
  onEnter,
  onCancelRoom,
}: {
  room: RoomDoc;
  seats: SeatDoc[];
  presence: Map<string, PresenceState>;
  mySeat: SeatDoc | null;
  isHost: boolean;
  address: string | null;
  displayName: string;
  busy: string | null;
  onToggleReady: () => void;
  onLeave: () => void;
  onRemoveSeat: (seat: SeatDoc) => void;
  onLaunch: () => void;
  onAnte: () => void;
  onEnter: () => void;
  onCancelRoom: () => void;
}) {
  const everyoneReady = seats.length >= MIN_PLAYERS && seats.every((seat) => seat.ready);
  const openSeats = Math.max(0, room.maxPlayers - seats.length);
  const isLive = room.status === "live" && room.chainGameId !== null;

  return (
    <div style={styles.roomGrid}>
      <section style={styles.panel}>
        <div style={styles.roomHeader}>
          <div>
            <h2 style={styles.panelTitle}>{room.name}</h2>
            <p style={styles.panelNote}>
              {formatNativeAmount(room.anteUjuno)} {NATIVE_DENOM_DISPLAY} ante &middot; {room.maxPlayers} players
              {room.chainGameId !== null && ` · on-chain game #${room.chainGameId}`}
            </p>
          </div>
          <StatusPill status={room.status} />
        </div>

        {room.launchError && <Banner tone="error" text={room.launchError} />}

        <div style={styles.seatList}>
          {seats.map((seat) => (
            <SeatCard
              key={seat.address}
              seat={seat}
              presence={presence.get(seat.address) ?? "online"}
              isSelf={seat.address === address}
              canRemove={isHost && seat.address !== address && room.status === "staging"}
              removing={busy === `remove:${seat.address}`}
              onRemove={() => onRemoveSeat(seat)}
            />
          ))}
          {Array.from({ length: openSeats }, (_, index) => (
            <div key={`open-${index}`} style={styles.openSeat}>
              Open seat
            </div>
          ))}
        </div>

        <div style={styles.roomActions}>
          {mySeat && room.status === "staging" && (
            <button
              type="button"
              style={disabledButtonStyle(mySeat.ready ? styles.secondaryButton : styles.primaryButton, busy !== null)}
              onClick={onToggleReady}
              disabled={busy !== null}
            >
              {mySeat.ready ? "✓ Ready — click to unready" : "Mark me Ready"}
            </button>
          )}

          {isHost && room.status === "staging" && (
            <button
              type="button"
              style={disabledButtonStyle(styles.launchButton, !everyoneReady || busy !== null)}
              onClick={onLaunch}
              disabled={!everyoneReady || busy !== null}
              title={
                everyoneReady
                  ? "Signs CreateGameRoom and deposits your ante"
                  : `All ${MIN_PLAYERS}+ players must be Ready first`
              }
            >
              {busy === "launch" ? "Launching on-chain..." : "🚀 Launch Game"}
            </button>
          )}

          {isLive && mySeat && !mySeat.onChain && (
            <button
              type="button"
              style={disabledButtonStyle(styles.launchButton, busy !== null)}
              onClick={onAnte}
              disabled={busy !== null}
            >
              {busy === "ante"
                ? "Anteing in..."
                : `Ante ${formatNativeAmount(room.anteUjuno)} ${NATIVE_DENOM_DISPLAY} & join`}
            </button>
          )}

          {isLive && mySeat?.onChain && (
            <button type="button" style={styles.launchButton} onClick={onEnter}>
              Enter game →
            </button>
          )}

          <button
            type="button"
            style={disabledButtonStyle(styles.secondaryButton, busy !== null)}
            onClick={onLeave}
            disabled={busy !== null}
          >
            {busy === "leave" ? "Leaving..." : "Leave room"}
          </button>

          {isHost && room.status === "staging" && (
            <button
              type="button"
              style={disabledButtonStyle(styles.dangerButton, busy !== null)}
              onClick={onCancelRoom}
              disabled={busy !== null}
            >
              Cancel room
            </button>
          )}
        </div>

        {isHost && room.status === "staging" && !everyoneReady && (
          <p style={styles.panelNote}>
            Waiting on {seats.filter((seat) => !seat.ready).length || MIN_PLAYERS - seats.length} more
            {seats.length < MIN_PLAYERS ? " player(s) to join" : " player(s) to ready up"}.
          </p>
        )}
        {isLive && (
          <p style={styles.panelNote}>
            This room is live on-chain as game #{room.chainGameId}. Every player must ante in
            before they can act — the contract's roster, not this list, decides who is playing.
          </p>
        )}
      </section>

      <ChatBox roomId={room.id} address={address} displayName={displayName} title={`${room.name} chat`} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function SeatCard({
  seat,
  presence,
  isSelf,
  canRemove,
  removing,
  onRemove,
}: {
  seat: SeatDoc;
  presence: PresenceState;
  isSelf: boolean;
  canRemove: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const dropped = presence === "dropped";
  return (
    <div style={{ ...styles.seatCard, ...(dropped ? styles.seatCardDropped : {}) }}>
      <span style={styles.presenceDot} title={dropped ? "No heartbeat for over a minute" : "Online"}>
        {dropped ? "⚫" : "🟢"}
      </span>
      <div style={styles.seatMain}>
        <span style={styles.seatName}>
          {seatLabel(seat)}
          {isSelf && <span style={styles.selfTag}>you</span>}
          {seat.isHost && <span style={styles.hostTag}>host</span>}
        </span>
        {/* The display name is self-asserted, so the address stays visible
            -- it is the only identity the contract knows. */}
        <span style={styles.seatAddress} title={seat.address}>
          {truncateAddress(seat.address)}
        </span>
      </div>

      {seat.onChain ? (
        <span style={styles.antedTag}>⛓ anted</span>
      ) : seat.ready ? (
        <span style={styles.readyTag}>✓ ready</span>
      ) : (
        <span style={styles.waitingTag}>waiting</span>
      )}

      {canRemove && (
        <button
          type="button"
          style={disabledButtonStyle(styles.removeButton, removing)}
          onClick={onRemove}
          disabled={removing}
        >
          {removing ? "..." : "Remove"}
        </button>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: RoomDoc["status"] }) {
  const tone =
    status === "live"
      ? styles.pillLive
      : status === "launching"
        ? styles.pillLaunching
        : status === "closed"
          ? styles.pillClosed
          : styles.pillStaging;
  return <span style={{ ...styles.pill, ...tone }}>{status}</span>;
}

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

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    backgroundColor: "#0a0e17",
    color: "#e6e8ef",
    fontFamily: FONT_FAMILY,
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "0 0 40px",
    boxSizing: "border-box",
  },
  brandHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "20px",
    flexWrap: "wrap",
    padding: "20px 28px",
    backgroundColor: "#1E293B",
    borderBottom: "1px solid #2a3a52",
  },
  brandTitle: { margin: 0, fontSize: FONT_SIZE.display, fontWeight: 800, color: "#F8FAFC", letterSpacing: "0.5px" },
  brandSubtitle: { margin: "4px 0 0", fontSize: FONT_SIZE.body, color: "#9aa0ac" },
  headerControls: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  nameInput: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#0a0e17",
    color: "#e6e8ef",
    width: "190px",
  },
  addressBadge: {
    fontSize: FONT_SIZE.body,
    fontFamily: FONT_FAMILY_MONO,
    padding: "7px 12px",
    borderRadius: "999px",
    backgroundColor: "#0F172A",
    border: "1px solid #2a3a52",
    color: "#9aa0ac",
  },
  balanceBadge: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "7px 12px",
    borderRadius: "999px",
    backgroundColor: "#14301f",
    border: "1px solid #2c6e4a",
    color: "#8fe0b0",
  },
  // ---- Escape hatch (App.tsx design note #24). Violet, deliberately not
  // reusing any of the blue/green/amber the real gameplay controls use --
  // this is a developer affordance, and it should not read as another way
  // to start a real game. ----
  sandboxStrip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "20px",
    flexWrap: "wrap",
    margin: "0 28px",
    padding: "16px 20px",
    backgroundColor: "#1a1424",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#4a3a6a",
    borderRadius: "12px",
  },
  sandboxCopy: { display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "260px" },
  sandboxTitle: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#d9c0f5" },
  sandboxNote: { fontSize: FONT_SIZE.small, color: "#9a8ab0", lineHeight: LINE_HEIGHT.normal },
  sandboxButton: {
    flexShrink: 0,
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#7a5aa8",
    backgroundColor: "#3a2a56",
    color: "#e8d8ff",
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
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "20px",
    backgroundColor: "#0F172A",
    border: "1px solid #1e2937",
    borderRadius: "12px",
  },
  panelTitle: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 700, color: "#F8FAFC" },
  panelNote: { margin: 0, fontSize: FONT_SIZE.small, color: "#6f7480", lineHeight: LINE_HEIGHT.normal },
  label: { display: "flex", flexDirection: "column", gap: "6px", fontSize: FONT_SIZE.body, color: "#9aa0ac" },
  input: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: "8px",
    // Longhand, so `inputInvalid` can override the colour alone without
    // mixing against a shorthand -- same hazard as `tabButton` above.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3f4b",
    backgroundColor: "#0a0e17",
    color: "#e6e8ef",
    boxSizing: "border-box",
  },
  inputInvalid: { borderColor: "#8e3b31" },
  /** The "here is why that control will refuse you" hint -- design note #3,
   *  rule 2. Amber rather than red: nothing has failed yet, and colouring a
   *  precondition as an error trains people to ignore real errors. */
  blockedNote: {
    margin: 0,
    padding: "10px 14px",
    borderRadius: "8px",
    backgroundColor: "#3a2f14",
    border: "1px solid #6a5a24",
    color: "#e0c07a",
    fontSize: FONT_SIZE.small,
    lineHeight: LINE_HEIGHT.normal,
  },
  hint: { fontSize: FONT_SIZE.body, color: "#6f7480", margin: 0, padding: "0 28px" },
  // ---- Open Lobbies / Live Games tabs. Same #1E293B-on-#0F172A active-tab
  // treatment `MainTabBar` uses on the dashboard, so the two screens' nav
  // reads as one system. ----
  tabBar: {
    display: "flex",
    gap: "4px",
    borderBottom: "1px solid #1e2937",
    marginBottom: "4px",
  },
  tabButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: "12px 20px",
    // Longhand, NOT the `borderBottom` shorthand. This pair is what
    // produced the reported console warning: the base style set the
    // `borderBottom` SHORTHAND while `tabButtonActive` overrode only the
    // `borderBottomColor` LONGHAND. On a tab switch React removes the
    // longhand from the outgoing element while the shorthand is still
    // present, and the order in which a browser applies that combination is
    // not guaranteed -- hence "can lead to styling bugs". Expressing all
    // three parts as longhands means the active variant overrides exactly
    // one property that was already there, with nothing to reconcile.
    borderWidth: "0",
    borderStyle: "solid",
    borderColor: "transparent",
    borderBottomWidth: "3px",
    backgroundColor: "transparent",
    color: "#6f7480",
    cursor: "pointer",
  },
  tabButtonActive: {
    color: "#F8FAFC",
    // Overrides one longhand set above -- see the note there.
    borderBottomColor: "#4a6a92",
    backgroundColor: "#1E293B",
  },
  tabCount: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 7px",
    borderRadius: "999px",
    backgroundColor: "#2a3a52",
    color: "#9ec1ea",
  },
  roomList: { display: "flex", flexDirection: "column", gap: "8px" },
  roomRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 14px",
    backgroundColor: "#141c2c",
    border: "1px solid #1e2937",
    borderRadius: "10px",
    flexWrap: "wrap",
  },
  roomRowMain: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: "180px" },
  roomName: { fontSize: FONT_SIZE.strong, fontWeight: 600, color: "#F8FAFC" },
  roomMeta: { fontSize: FONT_SIZE.small, color: "#6f7480" },
  seatPill: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "4px 10px",
    borderRadius: "999px",
    backgroundColor: "#1e293b",
    color: "#9aa0ac",
  },
  roomHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" },
  seatList: { display: "flex", flexDirection: "column", gap: "8px" },
  seatCard: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 14px",
    backgroundColor: "#141c2c",
    // Longhand: `seatCardDropped` overrides `borderStyle` alone.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#1e2937",
    borderRadius: "10px",
  },
  seatCardDropped: { opacity: 0.55, borderStyle: "dashed" },
  presenceDot: { fontSize: FONT_SIZE.micro, flexShrink: 0 },
  seatMain: { display: "flex", flexDirection: "column", gap: "1px", flex: 1, minWidth: 0 },
  seatName: { display: "flex", alignItems: "center", gap: "8px", fontSize: FONT_SIZE.control, fontWeight: 600, color: "#F8FAFC" },
  seatAddress: { fontSize: FONT_SIZE.micro, color: "#6f7480", fontFamily: FONT_FAMILY_MONO },
  selfTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: "999px",
    backgroundColor: "#2a3a52",
    color: "#9ec1ea",
  },
  hostTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: "999px",
    backgroundColor: "#3a2f14",
    color: "#e0c07a",
  },
  readyTag: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#8fe0b0", flexShrink: 0 },
  antedTag: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#9ec1ea", flexShrink: 0 },
  waitingTag: { fontSize: FONT_SIZE.small, color: "#6f7480", flexShrink: 0 },
  openSeat: {
    padding: "10px 14px",
    border: "1px dashed #2a3a52",
    borderRadius: "10px",
    fontSize: FONT_SIZE.body,
    color: "#4d5462",
    textAlign: "center",
  },
  roomActions: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "4px" },
  primaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    border: "1px solid #3a5a82",
    backgroundColor: "#2a3a52",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  secondaryButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  launchButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    border: "1px solid #2c6e4a",
    backgroundColor: "#1a4530",
    color: "#a8f0c8",
    cursor: "pointer",
  },
  dangerButton: {
    fontSize: FONT_SIZE.control,
    fontWeight: 600,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
    border: "1px solid #5a2a24",
    backgroundColor: "#2a1614",
    color: "#f0b0a8",
    cursor: "pointer",
  },
  removeButton: {
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1e2129",
    color: "#9aa0ac",
    cursor: "pointer",
    flexShrink: 0,
  },
  pill: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "3px 10px",
    borderRadius: "999px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    flexShrink: 0,
  },
  pillStaging: { backgroundColor: "#1e293b", color: "#9aa0ac" },
  pillLaunching: { backgroundColor: "#3a2f14", color: "#e0c07a" },
  pillLive: { backgroundColor: "#14301f", color: "#8fe0b0" },
  pillClosed: { backgroundColor: "#2a1614", color: "#f0b0a8" },
  banner: {
    margin: "0 28px",
    padding: "10px 14px",
    borderRadius: "8px",
    fontSize: FONT_SIZE.body,
    lineHeight: LINE_HEIGHT.normal,
  },
  bannerError: { backgroundColor: "#2a1614", border: "1px solid #5a2a24", color: "#f0b0a8" },
  bannerWarn: { backgroundColor: "#3a2f14", border: "1px solid #6a5a24", color: "#e0c07a" },
};
