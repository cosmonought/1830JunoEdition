// frontend/src/utils/sandboxPresence.ts
//
// The transport for `presence.ts` -- one current value per seat on the room-doc socket, and nothing else.
//
// ==================================================================
//  DESIGN NOTE 740: A RECORD OF ITS OWN, NOT THE ROOM DOCUMENT AND NOT THE LOG
// ==================================================================
//
// WHERE THIS GOES IS THE DESIGN. Three candidates and why two are wrong:
//
//   THE ROOM DOCUMENT would have been the small change: it already has a `players` array and every client is
//   already subscribed. But a route publish twice a second would rewrite the roster that joins and colour
//   changes write, and every waiting-room subscriber would re-render on every hex click of a game they are
//   not in.
//
//   THE ACTIONS LOG is append-only and replayed. Writing drafts there would put ephemeral, retracted,
//   half-finished intent into the sequence Undo replays (#591) -- and `effectiveActions` would have to learn
//   to skip them, which is a rule the log exists not to need. `appendSandboxAction` is never called here.
//
//   A PRESENCE RECORD, one current value per player id, is what this uses. The newest write per seat wins;
//   the record IS the seat, so a reconnecting client overwrites its own entry rather than accumulating; and
//   it is separately subscribable, so nothing that does not care about presence pays for it.
//
// #1361a: THE RECORD LIVES ON THE GAME SERVER, in memory, and travels on the room-doc socket (`roomDocLink`)
// as `presence-set` up and `presence` down. It was a Firestore subcollection; Firestore is gone. Nothing
// about the shape changed -- `PresenceState` goes on the wire as JSON, which unlike Firestore is happy to
// carry `[[q, r], ...]` as it is, so the old flattening is gone with the reason for it.
//
// AND THE CLOCK IS THE CLIENT'S, deliberately. Staleness here is a rendering judgement over a few seconds, not
// an ordering guarantee, so a client clock is the right instrument and its skew is handled in `isPresenceFresh`.
//
// See docs/ai_architecture/firebase_middleware.md, sandboxPresence.ts #740.

import { localPlayerId } from "./seatPin";
import { roomDocOnServer, sendPresence, subscribePresence } from "./roomDocLink";
import type { PresenceState } from "./presence";

function toPresence(raw: unknown): PresenceState | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const id = typeof data.playerId === "string" ? data.playerId : "";
  if (!id) return null;
  const at = Number(data.at);
  const drafts: Record<number, Array<readonly [number, number]>> = {};
  const rawDrafts = data.routeDrafts;
  if (rawDrafts && typeof rawDrafts === "object") {
    for (const [key, value] of Object.entries(rawDrafts as Record<string, unknown>)) {
      const index = Number(key);
      if (!Number.isFinite(index) || !Array.isArray(value)) continue;
      const hexes: Array<readonly [number, number]> = [];
      for (const point of value) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const q = Number(point[0]);
        const r = Number(point[1]);
        if (Number.isFinite(q) && Number.isFinite(r)) hexes.push([q, r]);
      }
      if (hexes.length > 0) drafts[index] = hexes;
    }
  }
  /* Design note #1021: the drafter's own figure for each route. Read defensively -- a key that is not a
     finite number is dropped rather than coerced to zero, because "$0" is a claim and "absent" is not. */
  const values: Record<number, number> = {};
  const rawValues = data.routeValues;
  if (rawValues && typeof rawValues === "object") {
    for (const [key, value] of Object.entries(rawValues as Record<string, unknown>)) {
      const index = Number(key);
      const revenue = Number(value);
      if (!Number.isFinite(index) || !Number.isFinite(revenue)) continue;
      values[index] = revenue;
    }
  }
  return {
    playerId: id,
    at: Number.isFinite(at) ? at : 0,
    routeDrafts: drafts,
    routeValues: values,
    actingCompanyId: typeof data.actingCompanyId === "number" ? data.actingCompanyId : null,
  };
}

/** Publish this client's live intent. Fire-and-forget: a failed presence write is not worth surfacing.
 *
 *  Design note #740: SWALLOWS ITS ERRORS, unlike `appendSandboxAction`, which reports them because a lost
 *  ACTION is a lost move. A lost presence update costs a rival one stale frame and the next publish fixes it;
 *  raising a room error for that would train players to ignore room errors. */
export async function publishPresence(roomCode: string, state: PresenceState): Promise<void> {
  if (!roomDocOnServer()) return;
  const drafts: Record<string, Array<[number, number]>> = {};
  for (const [index, hexes] of Object.entries(state.routeDrafts ?? {})) {
    if (hexes.length > 0) drafts[index] = hexes.map(([q, r]) => [q, r]);
  }
  try {
    sendPresence(roomCode, localPlayerId(), {
      playerId: state.playerId,
      at: state.at,
      routeDrafts: drafts as unknown as PresenceState["routeDrafts"],
      // Design note #1021: what the DRAFTER priced them at, so no watcher has to guess.
      routeValues: state.routeValues ?? {},
      actingCompanyId: state.actingCompanyId ?? null,
    });
  } catch {
    // Deliberately silent -- see the note above.
  }
}

/** Clear this seat's presence.
 *
 *  Design note #740: called when a turn ends, so a president's routes vanish the moment they stop drafting
 *  rather than lingering until they go stale. Staleness is the SAFETY NET, not the mechanism -- relying on it
 *  alone would leave every finished turn's routes on screen for six seconds. */
export async function clearPresence(roomCode: string, playerId: string): Promise<void> {
  if (!roomDocOnServer()) return;
  try {
    /* The server clears the entry for the CONNECTION's seat; `playerId` is what the caller believes that is,
       and is sent for the record. */
    sendPresence(roomCode, playerId, null);
  } catch {
    // Same reasoning: a failed clear resolves itself when the record goes stale.
  }
}

/** Subscribe to every seat's presence in this room. */
export function subscribeSandboxPresence(
  roomCode: string,
  onPresence: (entries: PresenceState[]) => void,
  onError?: (message: string) => void,
): () => void {
  if (!roomDocOnServer()) return () => undefined;
  return subscribePresence(
    roomCode,
    localPlayerId(),
    (entries, serverNow) => {
      /* #1397: REBASED INTO THIS CLOCK. The server stamps `at` and sends its own `now`; the entry's age is
         their difference, and `at` becomes "that long ago, here". A frame without `now` (an older server)
         is taken as it comes, which is the pre-#1397 behaviour. */
      const received = Date.now();
      const parsed: PresenceState[] = [];
      for (const entry of entries) {
        const state = toPresence(entry);
        if (!state) continue;
        if (serverNow !== undefined && Number.isFinite(state.at)) {
          parsed.push({ ...state, at: received - Math.max(0, serverNow - state.at) });
        } else {
          parsed.push(state);
        }
      }
      onPresence(parsed);
    },
    onError,
  );
}
