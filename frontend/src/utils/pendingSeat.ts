import type { SandboxRoomDoc, SandboxRoomPlayer } from "./sandboxRoom";

/* ==================================================================
   DESIGN NOTE 1169: THE THREE CONTROLS THAT WAIT FOR A SERVER, ON A SCREEN WHERE NOTHING ELSE DOES
   ==================================================================
   REPORTED as "I can no longer set my name nor select a player color", then corrected to "I was able to set
   them, but there was considerable lag". Both halves of that report are worth keeping, because the first one
   is what the second one FEELS like: a control that gives no answer for half a second has not been slow, it
   has been broken, and the player's hand has already moved on.

   IT IS NOT "ROOMS ARE SLOW", and the proof is on the same screen. The waiting room writes to one Firestore
   document through four functions:

     setSandboxRoomVariants   updateDoc      the host's toggles      instant
     setSandboxForcedSign     updateDoc                              instant
     markSandboxRoomPlaying   updateDoc                              instant
     upsertSandboxPlayer      runTransaction nickname, colour, ready LAGS

   Firestore applies an `updateDoc` to the local cache immediately and fires `onSnapshot` with the new value
   BEFORE the server has answered -- latency compensation, and `subscribeSandboxRoom` does nothing to opt out
   of it. A TRANSACTION CANNOT BE COMPENSATED: it exists to read the server's current value, so there is
   nothing to apply locally and the listener fires only once the commit lands. Read plus commit, two round
   trips, more when it retries on contention.

   So the three laggy controls are exactly, and only, the three that go through the transaction. The variant
   toggles an inch away move instantly, which is what makes the colour swatch read as broken rather than slow.

   THE TRANSACTION IS RIGHT AND STAYS. #541 needs it: the write is a read-modify-write on a `players` array
   shared with everyone else in the room, and a blind overwrite would drop a rename that landed between the
   read and the write. The cost is real and the reason for it is real. What was missing is the ECHO.

   SO THE ECHO IS DRAWN HERE, over the snapshot, until the snapshot agrees. This is #1145's medicine for
   #1145's disease one screen earlier -- the tile ghost and the in-flight station token are held for exactly
   the same reason -- and it is #764's lesson again: the screen was answering a question during the window
   where it did not have the data, and the fix is to say what it knows rather than to wait faster.

   ONE OBJECT, NOT TWO. The overlay is applied once, to the room the whole shell reads, rather than beside
   each control. #891 is the codebase's most-repeated fault -- two components computing the same fact and
   disagreeing -- and a swatch with a private idea of its own colour while the roster below it shows another
   is that fault with a 400ms lifetime. It also fixes an interleaving that predates the report: the three
   writers carry each other's fields forward (#569), and reading a room WITHOUT the echo meant that picking a
   colour and submitting a name before the colour committed wrote the name with no colour -- erasing the
   choice the player had just made. They read the overlay, so the carry-forward carries what is in flight.

   NULL IS A VALUE HERE, NOT AN ABSENCE. Clicking your own swatch clears the colour and lets the game assign
   one (#569), so `color: null` is a pending CHOICE and `color` absent is "not pending". Key presence
   distinguishes them; a truthiness test would silently drop the clear. */

export interface PendingSeat {
  nickname?: string;
  /** `null` is the deliberate clear (#569), which is why this is a nullable key rather than an optional one. */
  color?: string | null;
  isReady?: boolean;
}

/** Nothing pending. Kept as a named empty rather than `null` so callers can always spread it. */
export const NO_PENDING_SEAT: PendingSeat = {};

export function hasPendingSeat(pending: PendingSeat | null | undefined): boolean {
  return pending !== null && pending !== undefined && Object.keys(pending).length > 0;
}

/** The seat as it will be once the write lands, over the seat as the server last described it. */
function applyToPlayer(player: SandboxRoomPlayer, pending: PendingSeat): SandboxRoomPlayer {
  const next: SandboxRoomPlayer = { ...player };
  if ("nickname" in pending && pending.nickname !== undefined) next.nickname = pending.nickname;
  if ("isReady" in pending && pending.isReady !== undefined) next.isReady = pending.isReady;
  if ("color" in pending) {
    /* DELETED RATHER THAN SET TO `null`, because that is what the write does: `upsertSandboxPlayer` spreads
       `...(color ? { color } : {})`, so a cleared colour comes back from the server as an ABSENT key. An
       echo that showed `null` where the commit will show nothing would be a second shape for one state. */
    if (pending.color) next.color = pending.color;
    else delete next.color;
  }
  return next;
}

/**
 * The room the screen should draw: the snapshot, with the local player's in-flight choices already applied.
 *
 * Returns the SAME OBJECT when there is nothing to apply, so the memo above this does not hand every
 * downstream reader a new room on each render.
 */
export function applyPendingSeat(
  room: SandboxRoomDoc | null,
  localId: string,
  pending: PendingSeat | null | undefined,
): SandboxRoomDoc | null {
  if (!room || !hasPendingSeat(pending)) return room;
  const index = room.players.findIndex((player) => player.id === localId);
  /* NO SEAT IS NOT AN EMPTY SEAT. Before the auto-join write lands (App #9793) the local player is genuinely
     not in this room, and inventing a row for them here would draw a player into a roster the host cannot
     see -- a worse lie than the lag this module exists to hide. */
  if (index === -1) return room;
  const players = room.players.map((player, at) =>
    at === index ? applyToPlayer(player, pending as PendingSeat) : player,
  );
  return { ...room, players };
}

/**
 * The pending fields the snapshot has caught up with -- i.e. the ones that can now be dropped.
 *
 * SELF-CLEARING BY COMPARISON, not by timer. The echo's whole job is to cover the gap between the click and
 * the commit, so the commit itself is the signal, and a field is released the instant the server's answer
 * matches it. A timer would either release early (a flash back to the old colour) or hold late (a stale echo
 * over a value someone else changed).
 */
export function settledSeatKeys(
  room: SandboxRoomDoc | null,
  localId: string,
  pending: PendingSeat | null | undefined,
): (keyof PendingSeat)[] {
  if (!room || !hasPendingSeat(pending)) return [];
  const mine = room.players.find((player) => player.id === localId);
  if (!mine) return [];
  const settled: (keyof PendingSeat)[] = [];
  const seat = pending as PendingSeat;
  if ("nickname" in seat && mine.nickname === seat.nickname) settled.push("nickname");
  if ("isReady" in seat && mine.isReady === seat.isReady) settled.push("isReady");
  if ("color" in seat && (mine.color ?? null) === (seat.color ?? null)) settled.push("color");
  return settled;
}

/** `pending` minus the keys named, or `null` when that empties it -- so "nothing in flight" has one shape. */
export function dropSeatKeys(
  pending: PendingSeat | null | undefined,
  keys: (keyof PendingSeat)[],
): PendingSeat | null {
  if (!hasPendingSeat(pending)) return null;
  const next: PendingSeat = { ...(pending as PendingSeat) };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}

/* THE BACKSTOP, and the reason it has to exist. `upsertSandboxPlayer` returns `true` when the room document
   is missing -- it opens a transaction, finds nothing, and returns without writing -- so a "successful" write
   can leave a pending field that no snapshot will ever settle. Rather than reach into the middleware for
   that (the audit owns it), the echo simply refuses to outlive a plausible round trip. Long enough that a
   slow commit is not yanked out from under the player, short enough that a lie is not left on screen. */
export const PENDING_SEAT_BACKSTOP_MS = 6000;
