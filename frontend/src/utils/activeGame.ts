// frontend/src/utils/activeGame.ts
//
// WHICH BOARD THE PLAYER IS LOOKING AT -- the persisted room pointer, the
// three viewing modes and the sandbox's reserved identifiers. Moved out of
// `App.tsx` unchanged.
//
// `BoardMode` is the reason this file exists rather than these constants
// staying beside `GameRouter`. It is a type three separate layers agree on --
// the router that picks a board, the shell that renders one, and the stored
// pointer that survives a reload -- and `AppShell`'s own props interface
// depends on it. A vocabulary that a component's props depend on should not
// live inside that component's file.
//
// `readActiveGame` comes with it because it is the only reader of the storage
// key and the only place that validates the stored shape, so the key, the
// type and the parser are one unit.

export const ACTIVE_GAME_STORAGE_KEY = "18cosmos.active_game.v1";

/* ==================================================================== */
/*  DESIGN NOTE 24: THE THREE WAYS TO BE LOOKING AT A BOARD             */
/* ==================================================================== */
//
//   play     A real on-chain game. `gameId` is the contract's, every
//            control is live, every action signs.
//   spectate A real on-chain game someone else is playing. Live data,
//            no dispatch -- design note #23.
//   sandbox  NO CHAIN AT ALL. The board, tile catalog and picker run off
//            local mock state so the UI can be worked on without a
//            deployed contract, a funded wallet, or a populated Firestore.
//
// Sandbox exists because the lobby was a TRAP. Launching needs a valid
// contract address, spectating needs a game someone already launched, and
// with mock addresses and a fresh Firebase neither is possible -- so there
// was no route from the lobby to `HexGridRenderer` at all. A UI you cannot
// open is a UI you cannot develop.
//
// IMPLEMENTATION NOTE, and the reason this is a mode rather than a magic
// `gameId`. The obvious shape -- `gameId = "offline-sandbox"` -- was tried
// and rejected: `gameId` is typed `number` because it is threaded into
// roughly twenty `ExecuteMsg` payloads as `game_id`, which the contract
// declares as `u64`. Widening it to `number | string` would push a
// `string | number` into every one of those messages and delete the
// compiler's ability to tell a real game id from a placeholder -- the exact
// class of mistake `config.ts` design note #3 exists to catch. So the
// sandbox's identity lives in `mode`, where it is a UI concern, and
// `gameId` stays a number that always means "a room the contract knows
// about". `SANDBOX_GAME_ID` is never sent anywhere; sandbox mode does not
// dispatch.
//
// Sandbox is NOT spectator mode. Spectating disables the tile picker
// (design note #23); sandbox is specifically FOR the tile picker. The two
// are separate flags on purpose -- `spectator` gates dispatch, `sandbox`
// gates whether there is a chain to dispatch to.

export type BoardMode = "play" | "spectate" | "sandbox";

/** The `gameId` handed to the shell in sandbox mode. Never reaches the
 *  chain: sandbox forces `HexGridRenderer` down its offline path, and every
 *  dispatch site is gated before a message is built. `0` because the
 *  contract's `NEXT_GAME_ID` counter starts at 1, so this collides with no
 *  real room. */
export const SANDBOX_GAME_ID = 0;

/** The `roomId` handed to the shell in sandbox mode. There is no Firestore
 *  room, so chat and presence both no-op on it. */
export const SANDBOX_ROOM_ID = "offline-sandbox";

export interface ActiveGame {
  gameId: number;
  roomId: string;
  /** Design note #24. Persisted alongside the ids so a reload cannot
   *  silently promote a spectator into a player -- reading the ids back
   *  without this would default to the most permissive mode and hand a
   *  watcher a playable board. */
  mode: BoardMode;
}


export function readActiveGame(): ActiveGame | null {
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_GAME_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ActiveGame).gameId === "number" &&
      Number.isSafeInteger((parsed as ActiveGame).gameId) &&
      typeof (parsed as ActiveGame).roomId === "string" &&
      (parsed as ActiveGame).roomId.length > 0
    ) {
      const storedMode = (parsed as ActiveGame).mode;
      return {
        gameId: (parsed as ActiveGame).gameId,
        roomId: (parsed as ActiveGame).roomId,
        // Fails CLOSED: only the three known modes are accepted, and
        // anything else -- including an entry written before this field
        // existed -- degrades to `spectate`, the least privileged of the
        // three. The safe reading of "I do not know what this viewer is" is
        // "assume they may not act"; the cost is one trip back through the
        // lobby, versus handing a non-player a board full of live controls.
        mode:
          storedMode === "play" || storedMode === "spectate" || storedMode === "sandbox"
            ? storedMode
            : "spectate",
      };
    }
    return null;
  } catch {
    // Malformed JSON or storage disabled. Falling back to the Lobby is
    // always safe -- it is the screen that can recover from anything.
    return null;
  }
}

/**
 * The boundary between "choosing a room" and "playing in one".
 *
 * With no active game this renders `Lobby`; with one, `AppShell`. That is
 * the whole router -- there is no URL routing here on purpose, since this
 * app has exactly two screens and adding `react-router` for a single
 * boolean would be a dependency and a build-config change (see
 * `config-overrides.js`) bought for nothing.
 *
 * Rendered INSIDE both providers: `Lobby` calls `useWallet()` to sign the
 * launch transaction, so it must sit under `WalletProvider` -- the same
 * nesting requirement `GameSessionContext.tsx`'s own design note #2 records
 * for itself.
 */
