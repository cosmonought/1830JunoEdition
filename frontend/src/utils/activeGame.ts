// Which board the player is looking at -- the persisted room pointer, the three
// viewing modes and the sandbox's reserved identifiers. Moved out of `App.tsx`.
//
// `BoardMode` is a type three layers agree on (the router that picks a board,
// the shell that renders one, the stored pointer that survives a reload), and
// `AppShell`'s props depend on it -- a vocabulary a component's props depend on
// should not live inside that component's file. `readActiveGame` comes with it
// because the key, the type and the parser are one unit.

export const ACTIVE_GAME_STORAGE_KEY = "18cosmos.active_game.v1";

// Design note #24: `play` is a real on-chain game; `spectate` is somebody
// else's, live but with no dispatch (#23); `sandbox` has NO CHAIN AT ALL.
//
// Sandbox exists because the lobby was a TRAP: launching needs a contract
// address and spectating needs an existing game, so with mock addresses there
// was no route to `HexGridRenderer` at all.
//
// A MODE rather than a magic `gameId`, and the alternative was tried:
// `gameId` is `number` because it is threaded into ~20 `ExecuteMsg` payloads as
// a `u64` `game_id`, so widening it would delete the compiler's ability to tell
// a real game id from a placeholder. Sandbox is NOT spectator mode -- spectating
// disables the tile picker, sandbox is FOR it; `spectator` gates dispatch,
// `sandbox` gates whether there is a chain to dispatch to.

export type BoardMode = "play" | "spectate" | "sandbox";

/** The `gameId` handed to the shell in sandbox mode. Never reaches the chain:
 *  sandbox forces `HexGridRenderer` down its offline path and every dispatch site
 *  is gated before a message is built. `0` because the contract's `NEXT_GAME_ID`
 *  counter starts at 1, so this collides with no real room. */
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
        // Fails CLOSED: only the three known modes are accepted, and anything else --
        // including an entry written before this field existed -- degrades to
        // `spectate`, the least privileged. The cost is one trip back through the lobby,
        // versus handing a non-player a board full of live controls.
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

/** The boundary between "choosing a room" and "playing in one": `Lobby` with no
 *  active game, `AppShell` with one.
 *
 *  No URL routing on purpose -- this app has two screens, and `react-router` for
 *  a single boolean is a dependency and a build-config change bought for nothing.
 *  Rendered inside both providers, because `Lobby` calls `useWallet()` to sign
 *  the launch transaction (`GameSessionContext.tsx` design note #2). */

/* Design note #551: a refresh must not cost you the room. `activeGame` was
   persisted but the ROOM CODE was React state, so a reload came back in exactly
   the shape that says "solo sandbox" while the game sat in Firestore addressed
   by a code no longer in the browser.

   Resumable because THE LOG IS THE GAME: the action log is replayed from index 0
   on every join (#522), so a rejoin is identical to a first join and only one
   short string needs storing. A serialised board would be a second source of
   truth about the position, and the one that goes stale silently.

   `sessionStorage`, MATCHING `localPlayerId` -- the two must not diverge. In
   `localStorage` the code would outlive the identity, so a new tab weeks later
   would rejoin a finished game as a stranger. */
export const ACTIVE_SANDBOX_ROOM_STORAGE_KEY = "juno.activeSandboxRoom";

export function readActiveSandboxRoom(): string | null {
  try {
    return window.sessionStorage.getItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY);
  } catch {
    /* Private browsing. The game runs; it just is not resumable, which is
       the same bargain `readActiveGame` above already makes. */
    return null;
  }
}

export function writeActiveSandboxRoom(code: string | null): void {
  try {
    if (code) window.sessionStorage.setItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY, code);
    else window.sessionStorage.removeItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY);
  } catch {
    /* as above */
  }
}
