// frontend/src/utils/seatPin.ts
//
// The four digits that let a seat move between devices. Design note #1341 (`sandboxRoom.ts`) is the argument;
// this is the browser's half: what a PIN is, where this tab keeps the one it knows, and how a tab becomes a seat.

/* A LEAF MODULE, deliberately: `sandboxRoom.ts` imports `roomDocLink.ts`, which reads this file, so nothing
   here may import either. The player-id store (#528) moved in from `sandboxRoom.ts` for that reason and is
   re-exported there. */

export const SEAT_PIN_LENGTH = 4;

/** Exactly four digits. The same test on both ends of the wire, so a PIN the client accepted is one the server
 *  accepts, and a refusal is always about the MATCH rather than the shape. */
export function isValidSeatPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^[0-9]{4}$/.test(pin);
}

/* PER ROOM, IN `sessionStorage` -- the same store and the same reasoning as the player id (#528): two tabs are
   two players, a refresh keeps the seat. A PIN is a key to one room's seat and is filed under that room. */
const key = (room: string) => `juno.sandbox.seatPin.${room}`;

export function readSeatPin(room: string): string | null {
  try {
    const stored = window.sessionStorage.getItem(key(room));
    return isValidSeatPin(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeSeatPin(room: string, pin: string): void {
  try {
    window.sessionStorage.setItem(key(room), pin);
  } catch {
    /* Private browsing: the PIN is not remembered; the next hello will be asked for it. */
  }
}

/* ==================================================================
    THE SESSION TOKEN -- WHY A PIN ALONE CANNOT MOVE A SEAT
   ==================================================================
   Both devices know the PIN once the seat has moved, and the old one's socket reconnects on a backoff with
   the same id and the same PIN (#1253). A PIN can therefore let a device IN but cannot tell two devices
   APART. So a successful `claim-seat` (and a `seat-pin` set) hands the asking device a fresh token; the server
   keeps the latest per seat and refuses a hello carrying an older one as SUPERSEDED. The old device forgets
   its seat and reloads as a fresh visitor, from which it can rejoin with the PIN -- which mints a new token
   and supersedes the other device in turn. In memory on the server, so a restart lets any device with the
   PIN back in; in `sessionStorage` here, beside the PIN, for the same reasons. */
const tokenKey = (room: string) => `juno.sandbox.seatToken.${room}`;

export function readSeatToken(room: string): string | null {
  try {
    return window.sessionStorage.getItem(tokenKey(room));
  } catch {
    return null;
  }
}

export function storeSeatToken(room: string, token: string): void {
  try {
    window.sessionStorage.setItem(tokenKey(room), token);
  } catch {
    /* Private browsing: the token is not remembered. */
  }
}

/** Forget this room's PIN and token. The player id is `sandboxRoom.ts`'s to forget (`forgetSeat`). */
export function clearSeatSecrets(room: string): void {
  try {
    window.sessionStorage.removeItem(key(room));
    window.sessionStorage.removeItem(tokenKey(room));
  } catch {
    /* nothing to forget */
  }
}

/** The wire's word for "another device holds this seat now". Matched by the clients, minted by the server. */
export const SEAT_SUPERSEDED_CODE = "seat-superseded";
/** #1346: the wire's word for "this seat turned your hello away" (a wrong or missing PIN). Terminal. */
export const SEAT_REFUSED_CODE = "seat-refused";

/* sessionStorage, not localStorage: two tabs must be two players, which is how one developer playtests this. It survives a refresh so a reloading player reclaims their own seat.
   See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #528 */
const PLAYER_ID_STORAGE_KEY = "juno.sandbox.playerId";

/** Design note #1341: this tab becomes `id`. Written where `localPlayerId` reads, so the next load IS that
 *  seat; the caller reloads. */
export function adoptLocalPlayerId(id: string): void {
  try {
    window.sessionStorage.setItem(PLAYER_ID_STORAGE_KEY, id);
  } catch {
    /* Private browsing: the fallback id stands and the adoption cannot survive a reload. */
  }
}

/** Design note #1341: this tab takes over `playerId` in `room`. The id and the PIN are written where the next
 *  load reads them, and the page reloads. A RELOAD, deliberately -- every socket, ref and memo in the shell was
 *  built around the old id, and the log rebuilds the game for a fresh tab in one pass (#551). Rewiring them
 *  live would be a second identity path through `App.tsx`, which is the bloat this feature was asked not to
 *  add. */
export function adoptSeat(room: string, playerId: string, pin: string, token: string): void {
  adoptLocalPlayerId(playerId);
  storeSeatPin(room, pin);
  storeSeatToken(room, token);
  window.location.reload();
}

/** Design note #1341: this tab was SUPERSEDED -- another device took the seat. It forgets the seat entirely
 *  (id, PIN, token) and reloads as a fresh visitor, from which "Rejoin a seat" is one PIN away. */
export function forgetSeat(room: string): void {
  try {
    window.sessionStorage.removeItem(PLAYER_ID_STORAGE_KEY);
    /* #1358: AND THE RESUME. A superseded tab that still remembered its room would reload straight back into
       it under a freshly minted id and be seated as a new "Player" -- a ghost on the roster every time a seat
       moved. It lands on the lobby instead, from which "Rejoin game" is one PIN away. The two keys are
       `activeGame.ts`'s; written here as literals because this module is a leaf (see the header). */
    window.sessionStorage.removeItem("18cosmos.active_game.v1");
    window.sessionStorage.removeItem("juno.activeSandboxRoom");
  } catch {
    /* nothing to forget */
  }
  clearSeatSecrets(room);
  window.location.reload();
}

export function localPlayerId(): string {
  try {
    const existing = window.sessionStorage.getItem(PLAYER_ID_STORAGE_KEY);
    if (existing) return existing;
    const minted = `p-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(PLAYER_ID_STORAGE_KEY, minted);
    return minted;
  } catch {
    /* Private browsing. A per-render id would make this player a new seat on
       every render, so it is minted once per module load instead -- the
       session lasts as long as the tab, which is the same guarantee. */
    return FALLBACK_PLAYER_ID;
  }
}

const FALLBACK_PLAYER_ID = `p-${Math.random().toString(36).slice(2, 10)}`;
