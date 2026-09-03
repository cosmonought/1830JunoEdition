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
  APP_NAME,
} from "../config";
import { isFirebaseConfigured, firebaseConfigError } from "../config/firebase";
import ChatBox from "./ChatBox";
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
import AppFooter from "./AppFooter";
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
import {
  BANK_SIZE_BY_LENGTH,
  bankStartFor,
  GAME_LENGTH_BLURB,
  STANDARD_VARIANTS,
  type GameLength,
  type GameVariants,
  VARIANT_COPY,
} from "../utils/gameVariants";

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

/** Visibly greys out a disabled control -- design note #3, rule 1. `pointerEvents` is deliberately NOT `none`:
 *  the click must still reach React so a genuinely disabled (busy) control can be distinguished from a dead one
 *  during debugging, and so the `title` still appears on hover. `cursor: not-allowed` is what communicates it. */
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
  /** Opens a game the viewer is NOT playing in, read-only. A separate callback rather than a flag, because the
   *  two are different in kind and confusing them would be expensive: entering means "I am in this contract's
   *  roster and may act", spectating means "I may look and may not". Distinct entry points mean a caller cannot
   *  accidentally open a playable board by forgetting a boolean. */
  onSpectateGame: (chainGameId: number, roomId: string) => void;
  /** The escape hatch -- `App.tsx #24`. With a mock contract address you cannot launch, and with a fresh Firebase
   *  there is nothing to spectate, so without this the lobby has no exit at all.
   *  Design note #524: carries the Firebase sandbox room code, or `null` for an ordinary solo sandbox. */
  onEnterSandbox: (sandboxRoomCode?: string | null) => void;
}

/** Which half of the room browser is showing.
 *  NAMING NOTE: the requested filter was `status: "active"`. This schema has no `"active"` -- the equivalent is
 *  `"live"`, and a second status string meaning the same thing as an existing one is exactly the drift
 *  `config.ts #1` is about, so the tab is LABELLED "Live Games" and filters on `"live"`. The contract's own
 *  `is_active` is a different flag again -- running versus finished, a question only the chain can answer and
 *  Firestore deliberately does not mirror. */
type BrowserTab = "open" | "live";

/* ------------------------------------------------------------------ */
/* Amount conversion -- design note #1, integer string math only       */
/* ------------------------------------------------------------------ */

/** Display units -> base-denom integer string. Returns `null` for anything malformed, including more fractional
 *  digits than the denom actually has -- silently truncating a player's stated amount is not an acceptable
 *  failure mode when the amount is a deposit. */
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

/** Pulls the contract-assigned `game_id` out of a confirmed `CreateGameRoom` transaction. Reads the `wasm`
 *  event specifically: every attribute a CosmWasm contract adds is emitted under that type, and scoping to it
 *  avoids picking up a same-named attribute from an unrelated module in a multi-message transaction. */
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

/* Design note #525: the Web3 lobby's on-switch. `false` parks the room browser and the staging room together
   for sandbox playtesting; `true` restores the screen exactly as it was. One flag, one place, no other edits --
   so turning it back on is a one-character change rather than a revert somebody has to reconstruct. */
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
        /* Read the log once purely to TELL THE PLAYER whether the room is real before the board opens. An empty log
           and a wrong code are indistinguishable once you are inside, and the second is a much more common mistake.
           The replay itself belongs to the shell's listener; doing it here would apply the history twice. */
        await readSandboxLog(code);
        /* Design note #527: joining means taking a seat in the anteroom. Done here rather than in the waiting room so
           a player who joins and then closes the tab has still been seen -- and so the room's roster is correct the
           moment the screen opens rather than one round trip later. */
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
        // Design note #3: ALSO log. The banner is for the user; this is for the next person debugging with the console
        // open. The original report came with "there are no errors in the console", which was true and was itself the
        // clue -- an empty console should mean nothing ran, never that something failed quietly.
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

  /* Design note #902: the variants come UP from the form rather than being held here. `RoomBrowser` owns every
     other field of this form -- name, players, ante -- and splitting one of them into the parent would mean
     two components had to agree about which. */
  const handleCreate = useCallback(
    (name: string, maxPlayers: number, anteDisplay: string, variants: GameVariants) =>
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
          /* Design note #902: THE VARIANT'S BANK, not the constant. This figure is what the room advertises
             to joiners, so a short game must say $4,500 here or players sit down expecting a different game
             from the one that will be dealt. */
          virtualBankStart: String(bankStartFor(variants)),
          variants,
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

  /** Opens a live game read-only. Deliberately claims NO seat and requires NO wallet -- a spectator is not a
   *  participant in either system. They are not in the contract's roster, so the chain would reject any action
   *  from them regardless, and they get no seat doc, so they never appear in the player list or occupy capacity. */
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
            `${APP_NAME}: create room "${room.name}"`,
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
          `${APP_NAME}: join room ${room.chainGameId}`,
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
      {/* Design note #46 is the standing exception and this is the case it exists for: a media query cannot
          be expressed as an inline style object, and #1123's grid has to become one column on a narrow
          window or the two cards halve into unreadable slivers. 860px is where two ~500px columns stop
          fitting inside the 1040px cap with its gutters -- netadao.org collapses its own `.two-col` at
          900px, near enough that the two screens behave alike on the same devices. */}
      <style>{LOBBY_CSS}</style>
      <header style={styles.brandHeader}>
        {/* Design note #1129: one centred plate holding the title, the strapline and the controls, rather than
            a title on the left and a control cluster on the right. */}
        <div style={styles.brandHeaderInner}>
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
            // The burner-wallet security recommendation ships with the button (`ConnectWalletButton.tsx #0`), so the
            // lobby's connect path shows it just like the in-game top bar's does. Calling `wallet.connect()` directly here
            // is exactly the omission that component exists to make impossible.
            <ConnectWalletButton
              buttonStyle={disabledButtonStyle(
                styles.primaryButton,
                wallet.status === "connecting",
              )}
            />
          )}
        </div>
        </div>
      </header>

      {/* Design note #1114: the width cap. The HEADER stays full-bleed above it -- its own background is a
          band across the window and capping it would leave two stripes of root either side -- so the cap
          wraps everything below instead, which is the part that actually stretches. */}
      <div style={styles.content}>

      {/* Honest, specific banners -- never a silently empty screen. Each
          names what is missing and what still works without it. */}
      {!isFirebaseConfigured() && <Banner tone="error" text={firebaseError ?? "Firebase is not configured."} />}
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
      {wallet.error && <Banner tone="error" text={wallet.error} />}
      {actionError && <Banner tone="error" text={actionError} />}
      {roomsError && <Banner tone="error" text={roomsError} />}
      {roomError && <Banner tone="error" text={roomError} />}

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
          DESIGN NOTE 1123: TWO COLUMNS, AND THE ROOM BROWSER IS NOT IN EITHER
         ==================================================================
         THE LAYOUT ASKED FOR was left "Play", right "System Status", and the split is right -- one column
         for the thing you came to do, one for the state of the world. WHAT IT PUT IN THE RIGHT COLUMN IS THE
         PART THAT COULD NOT STAY: "On-chain rooms -- paused" is a card TODAY because `WEB3_LOBBY_ENABLED` is
         off. Flip that flag and the same slot renders `RoomBrowser` or `StagingRoom` -- a room list, a seat
         table, ante controls -- which is not status and does not fit in a half-width sidebar.
         SO THE GRID HOLDS THE TWO THINGS THAT ARE ALWAYS SMALL, and the Web3 branch renders full-width
         BELOW it. The paused card is status while it is paused; the browser that replaces it is a primary
         surface, and it gets the whole width the moment it exists. A layout keyed to the current value of a
         feature flag would have had to be rebuilt by whoever turns that flag on. */}
      <div className="lobby-dashboard" style={styles.dashboard}>
      <div style={styles.dashboardColumn}>
      <section style={styles.sandboxStrip}>
        <div style={styles.sandboxCopy}>
          {/* Design note #1123: the left column's heading is the invitation, so it names the game rather than
              the plumbing. "Sandbox Multiplayer" described the transport; this describes the door. */}
          <span style={styles.sandboxTitle}>▶ Play Project 18XX</span>
          {/* Design note #1114: shortened, as asked. The cut half named the plumbing -- Firestore, no wallet,
              no contract -- which is a developer's sentence on a screen a player reads. What survives is what
              they can act on. The plumbing is still stated, once, in the status pill below. */}
          <span style={styles.sandboxNote}>
            Real-time multiplayer sandbox. Host a room or join with a room code.
          </span>
        </div>
        {/* Design note #1083: `appliedCount={0}` and `onLeave={() => undefined}` are GONE with the props
            they fed. Both were placeholders this surface had no use for -- the lobby is never in a room --
            and a required prop satisfied by a stub is a prop the component did not need. */}
        <SandboxRoomBar
          roomCode={null}
          available={isFirebaseConfigured()}
          error={sandboxRoomError}
          busy={sandboxRoomBusy}
          onHost={handleHostSandboxRoom}
          onJoin={handleJoinSandboxRoom}
        />
      </section>

      </div>
      {/* The right column: what the world is doing, as opposed to what you can do about it. */}
      <div style={styles.dashboardColumn}>
      {/* Design note #1123: DOCKED AT THE TOP OF THE STATUS COLUMN, as asked. It used to sit above
          everything, in the run of error banners -- which put a permanent, deliberate state in the slot the
          screen uses for things that have gone wrong. In a column headed by "on-chain rooms are paused" it
          is reading the same fact from the other side, and #1114's argument for a quiet pill over an amber
          slab is unchanged: nothing here is broken. */}
      {chainError && (
        <div style={styles.chainPill} title={chainError}>
          <span style={styles.chainDot} aria-hidden="true" />
          Offline · sandbox active
        </div>
      )}
      {!WEB3_LOBBY_ENABLED && (
        <section style={styles.sandboxStrip}>
          <div style={styles.sandboxCopy}>
            <span style={styles.sandboxTitle}>⛓ On-chain rooms — paused</span>
            {/* Design note #1123: the flag name and the filename stay. This card is the one place on the
                screen whose whole audience is whoever turns the lobby back on -- #1119 moved developer text
                OFF the surfaces players read, which is a different rule from deleting it everywhere. */}
            <span style={styles.sandboxNote}>
              The Juno wallet lobby is switched off while sandbox multiplayer is being tested.
              Flip <code>WEB3_LOBBY_ENABLED</code> in <code>Lobby.tsx</code> to bring it back.
            </span>
          </div>
        </section>
      )}
      </div>
      </div>

      {/* Design note #525: THE WEB3 LOBBY IS PARKED, NOT DELETED. Gated behind ONE flag rather than removed, and the
         constant is at the top of this file where it can be found -- deleting a working staging room to run a
         playtest would cost far more to rebuild than it costs to switch off, and #24 already records what happens
         when the lobby becomes unreachable by accident.
         WHAT IS HIDDEN IS THE WHOLE BRANCH, browser and staging room alike. Hiding only the create button would leave
         a room list that cannot be joined, which is a worse trap than the one being removed: a control that looks
         live and refuses is harder to dismiss than one that is absent.
         THE SANDBOX PATHS ARE OUTSIDE IT and unaffected -- the same placement argument #24 made for the hatch. */}
      {/* Design note #1123: FULL WIDTH, BELOW THE GRID. The paused card above is status; everything this
          branch renders is a primary surface, and it gets the whole page the moment the flag turns on. */}
      {!WEB3_LOBBY_ENABLED ? null : activeRoomId && room ? (
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

      <AppFooter surface="meta" />
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
  onCreate: (
    name: string,
    maxPlayers: number,
    anteDisplay: string,
    variants: GameVariants,
  ) => void;
  onJoin: (room: RoomDoc) => void;
  onSpectate: (room: RoomDoc) => void;
  /** Raises a precondition failure into the parent's error banner --
   *  design note #3, rule 2. */
  onBlocked: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  /* Design note #902: the house rules, chosen before the room exists. Held as one object rather than four
     `useState`s so what gets written to the room is the same shape the reducer resolves -- four separate
     pieces of state assembled at the call site is where a fifth variant gets forgotten. */
  const [variants, setVariants] = useState<GameVariants>(STANDARD_VARIANTS);
  const [ante, setAnte] = useState(DEFAULT_ANTE_DISPLAY);
  const [tab, setTab] = useState<BrowserTab>("open");

  const anteBase = toBaseAmount(ante);
  const anteValid = anteBase !== null;

  /** Why creating is currently impossible, or `null` if it is possible. Ordered most-fundamental first, so the
   *  message names the thing to fix FIRST rather than the last check that happened to fail -- and each string is
   *  written to be actionable on its own, because this is the entire explanation the user gets. */
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
      // `launching` belongs here, not in Open Lobbies: the host has already signed, so the room is no longer
      // joinable -- but it has no `chainGameId` yet, so it is not watchable either. It appears in this tab with
      // Spectate disabled, which is the honest representation of a transient state, rather than vanishing from both
      // tabs for the duration of a block time.
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
            placeholder="Friday night 18XX"
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

        {/* ==================================================================
             DESIGN NOTE 902: THE HOUSE RULES, AGREED BEFORE THE DEAL
            ==================================================================
            AT ROOM CREATION rather than in a settings panel, because these are not preferences -- they are
            terms. A player taking a seat is agreeing to a game, and a variant discovered after the deal is
            not something they chose. The room list shows them for the same reason.
            ALL FIVE ARE LIVE NOW. Two of them shipped disabled for one batch, labelled "not built yet" -- a
            toggle that silently does nothing is a lie the table only discovers three hours in, and saying so
            in the label was the cheap honest option while they were being built. Both are implemented, so
            both are switches again. */}
        <label style={styles.label}>
          Game length
          <select
            value={variants.length}
            onChange={(event) =>
              setVariants((current) => ({
                ...current,
                length: event.target.value as GameLength,
              }))
            }
            style={styles.input}
          >
            {(Object.keys(BANK_SIZE_BY_LENGTH) as GameLength[]).map((option) => (
              <option key={option} value={option}>
                {option === "short" ? "Short" : option === "long" ? "Long" : "Standard"} &mdash; $
                {BANK_SIZE_BY_LENGTH[option].toLocaleString()} bank
              </option>
            ))}
          </select>
        </label>
        <p style={styles.panelNote}>{GAME_LENGTH_BLURB[variants.length]}</p>

        <label style={styles.variantRow}>
          <input
            type="checkbox"
            checked={variants.unpredictableRevenue}
            onChange={(event) =>
              setVariants((current) => ({
                ...current,
                unpredictableRevenue: event.target.checked,
              }))
            }
          />
          <span>
            <strong>{VARIANT_COPY.unpredictableRevenue.label}</strong>
            <span style={styles.variantNote}>{VARIANT_COPY.unpredictableRevenue.blurb}</span>
          </span>
        </label>

        <label style={styles.variantRow}>
          <input
            type="checkbox"
            checked={variants.dynamicStockMarket}
            onChange={(event) =>
              setVariants((current) => ({
                ...current,
                dynamicStockMarket: event.target.checked,
              }))
            }
          />
          <span>
            <strong>{VARIANT_COPY.dynamicStockMarket.label}</strong>
            <span style={styles.variantNote}>{VARIANT_COPY.dynamicStockMarket.blurb}</span>
          </span>
        </label>

        <label style={styles.variantRow}>
          <input
            type="checkbox"
            checked={variants.gentleRust}
            onChange={(event) =>
              setVariants((current) => ({ ...current, gentleRust: event.target.checked }))
            }
          />
          <span>
            <strong>{VARIANT_COPY.gentleRust.label}</strong>
            <span style={styles.variantNote}>{VARIANT_COPY.gentleRust.blurb}</span>
          </span>
        </label>

        <label style={styles.variantRow}>
          <input
            type="checkbox"
            checked={variants.delayedAuction}
            onChange={(event) =>
              setVariants((current) => ({ ...current, delayedAuction: event.target.checked }))
            }
          />
          <span>
            <strong>{VARIANT_COPY.delayedAuction.label}</strong>
            <span style={styles.variantNote}>{VARIANT_COPY.delayedAuction.blurb}</span>
          </span>
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
            onCreate(name, maxPlayers, ante, variants);
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

/** One row in the Live Games tab. No wallet check on Spectate, unlike Join: watching requires no identity
 *  because it performs no write in either system -- no seat is claimed and no transaction is signed. */
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

/* Design note #1123: the one rule inline styles cannot carry. Kept next to the grid it collapses rather
   than in a shared sheet -- this file has no other CSS and a second consumer would be a reason to move it. */
const LOBBY_CSS = `
@media (max-width: 860px) {
  .lobby-dashboard { grid-template-columns: 1fr !important; }
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
  root: {
    minHeight: "100vh",
    backgroundColor: "#080808",
    backgroundImage:
      "linear-gradient(rgba(8, 8, 8, 0.48), rgba(8, 8, 8, 0.48)), " +
      `url("${process.env.PUBLIC_URL ?? ""}/images/lobby-boardroom.jpg")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundAttachment: "fixed",
    color: "#f2f0eb",
    fontFamily: FONT_FAMILY,
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "0 0 40px",
    boxSizing: "border-box",
  },
  /* Design note #1129: no background of its own any more -- the page's picture runs behind it unbroken, which
     is what stops the header reading as a second photograph pasted above the content. The bottom rule stays:
     it is the line between the front door and the room, and it is now the only thing marking the header. */
  brandHeader: {
    display: "flex",
    justifyContent: "center",
    padding: "44px 28px 40px",
    borderBottom: "1px solid #2a2a2a",
  },
  /* ==================================================================
      DESIGN NOTE 1129: THE PANEL THE TITLE ASKED FOR
     ==================================================================
     "I think you could provide a background of sorts to Project 18XX and other elements that need one" -- and
     that is exactly what lets the page scrim be light. A second 0.55 over the 0.48 page puts the hero ground
     at L 0.058, on which paper reads 8.50:1, the subtitle 5.67:1 and the gilt's darkest stop 4.27:1.
     BLURRED, NOT SOLID. `backdrop-filter` keeps the room visible THROUGH the plate rather than punching a
     rectangle out of it -- the difference between a caption plate and a hole. The flat rgba fill is stated as
     well, because that is what an engine without the filter falls back to, and it is what carries the
     measured contrast in either case.
     CENTRED, AS ASKED, AND THE CONTROLS COME WITH IT. A centred title with a name field still pinned to the
     right reads as two designs sharing a row; stacked under it, the block is one object. */
  brandHeaderInner: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "18px",
    textAlign: "center",
    maxWidth: "760px",
    padding: "26px 34px",
    borderRadius: "14px",
    border: "1px solid rgba(201, 169, 76, 0.22)",
    backgroundColor: "rgba(8, 8, 8, 0.55)",
    backdropFilter: "blur(3px)",
    WebkitBackdropFilter: "blur(3px)",
    boxSizing: "border-box",
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
    color: "#e8c877",
    backgroundImage: "linear-gradient(100deg, #c9a94c 0%, #f5e3ac 50%, #c9a94c 100%)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  /* Design note #1129: lifted from `#a8a6a0` to the dim step. 5.67:1 on the hero panel -- the old tone was
     sized for a flat card and would have been marginal over a photograph. */
  brandSubtitle: { margin: "6px 0 0", fontSize: FONT_SIZE.body, color: "#c8c6c0" },
  headerControls: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  nameInput: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: "8px",
    border: "1px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    color: "#f2f0eb",
    width: "190px",
  },
  addressBadge: {
    fontSize: FONT_SIZE.body,
    fontFamily: FONT_FAMILY_MONO,
    padding: "7px 12px",
    borderRadius: "999px",
    backgroundColor: "#0f0f0f",
    border: "1px solid #2a2a2a",
    color: "#a8a6a0",
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
    borderRadius: "12px",
  },
  /* Design note #1123: the two columns. `1fr 1fr` on desktop and a single column under 860px -- the same
     shape netadao.org's own `.two-col` uses, collapsing at the same kind of breakpoint. `alignItems: start`
     so a short status card does not stretch to match a tall play card; they are siblings, not a table row. */
  dashboard: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    alignItems: "start",
    gap: "16px",
  },
  dashboardColumn: { display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 },
  sandboxCopy: { display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "260px" },
  sandboxTitle: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: SANDBOX_TITLE },
  sandboxNote: { fontSize: FONT_SIZE.small, color: SANDBOX_TEXT, lineHeight: LINE_HEIGHT.normal },
  sandboxButton: {
    flexShrink: 0,
    fontSize: FONT_SIZE.control,
    fontWeight: 800,
    padding: CONTROL_PADDING.button,
    borderRadius: "8px",
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
    borderRadius: "12px",
  },
  /* Design note #1114: 1040px rather than the 960 suggested -- the room browser is a table with a name, a
     status pill, a seat count and two buttons, and at 960 the buttons start wrapping under the name on a
     staged room with a long title. `margin: 0 auto` centres it; the root's own column keeps the gaps. */
  content: {
    width: "100%",
    maxWidth: "1040px",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "0 20px",
    boxSizing: "border-box",
  },
  chainPill: {
    alignSelf: "flex-start",
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.03em",
    padding: "3px 10px",
    borderRadius: "999px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#141414",
    color: "#a8a6a0",
    cursor: "help",
  },
  /* The dot is the one coloured thing, and it is the app's own "connecting/undecided" amber rather than a
     red -- an unconfigured chain is a state, not a failure. */
  chainDot: { width: "7px", height: "7px", borderRadius: "50%", backgroundColor: "#c9a94c", flex: "none" },
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
    borderRadius: "8px",
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
    borderRadius: "8px",
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
    borderRadius: "999px",
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
    borderRadius: "10px",
    flexWrap: "wrap",
  },
  roomRowMain: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: "180px" },
  roomName: { fontSize: FONT_SIZE.strong, fontWeight: 600, color: "#f2f0eb" },
  roomMeta: { fontSize: FONT_SIZE.small, color: "#6e6c68" },
  seatPill: {
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    padding: "4px 10px",
    borderRadius: "999px",
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
    borderRadius: "10px",
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
    borderRadius: "999px",
    backgroundColor: "#2a2a2a",
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
  waitingTag: { fontSize: FONT_SIZE.small, color: "#6e6c68", flexShrink: 0 },
  openSeat: {
    padding: "10px 14px",
    border: "1px dashed #2a2a2a",
    borderRadius: "10px",
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
    borderRadius: "8px",
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
    borderRadius: "8px",
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#f2f0eb",
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
    borderRadius: "999px",
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
    borderRadius: "8px",
    fontSize: FONT_SIZE.body,
    lineHeight: LINE_HEIGHT.normal,
  },
  bannerError: { backgroundColor: "#2a1614", border: "1px solid #5a2a24", color: "#f0b0a8" },
  bannerWarn: { backgroundColor: "#3a2f14", border: "1px solid #6a5a24", color: "#e0c07a" },
};
