// frontend/src/utils/sandboxPresence.ts
//
// The transport for `presence.ts` -- one Firestore document per seat, and nothing else.
//
// ==================================================================
//  DESIGN NOTE 740: A SUBCOLLECTION, NOT THE ROOM DOCUMENT
// ==================================================================
//
// WHERE THIS GOES IS THE DESIGN. Three candidates and why two are wrong:
//
//   THE ROOM DOCUMENT would have been the small change: it already has a `players` array and every client is
//   already subscribed. It is also the document `upsertSandboxPlayer` mutates inside a TRANSACTION -- so a
//   route publish twice a second would contend with joins and colour changes, and lose or delay them. Worse,
//   every waiting-room subscriber would re-render on every hex click of a game they are not in.
//
//   THE ACTIONS SUBCOLLECTION is the append-only log. Writing drafts there would put ephemeral, retracted,
//   half-finished intent into the sequence Undo replays (#591) -- and `effectiveActions` would have to learn
//   to skip them, which is a rule the log exists not to need.
//
//   A `presence` SUBCOLLECTION, one document per player id, is what this uses. Writes are per-seat so two
//   clients never contend; the document id IS the seat, so a reconnecting client overwrites its own record
//   rather than accumulating; and the collection is separately subscribable, so nothing that does not care
//   about presence pays for it.
//
// `setDoc` WITH MERGE, NOT `addDoc`. Presence is a CURRENT VALUE, not an event: there is exactly one truth per
// seat and the newest write wins. `addDoc` would make a history of intentions -- an unbounded one, since
// nothing would ever delete it.
//
// AND THE CLOCK IS THE CLIENT'S, deliberately, where everything else in this codebase uses `serverTimestamp`.
// A server timestamp is resolved on write and is unreadable until the round trip completes, so a subscriber
// would see `null` on exactly the freshest record -- the one it most wants. Staleness here is a rendering
// judgement over a few seconds, not an ordering guarantee, so a client clock is the right instrument and its
// skew is handled in `isPresenceFresh`.
//
// See docs/ai_architecture/firebase_middleware.md, sandboxPresence.ts #740.

import {
  collection,
  doc,
  deleteDoc,
  onSnapshot,
  setDoc,
  type DocumentData,
  type FirestoreError,
} from "firebase/firestore";

import { getFirestoreDb } from "../config/firebase";
import { SANDBOX_ROOMS_COLLECTION } from "./sandboxRoom";
import type { PresenceState } from "./presence";

export const SANDBOX_PRESENCE_SUBCOLLECTION = "presence";

/** Firestore rejects nested arrays, so `[[q, r], [q, r]]` cannot be stored as-is.
 *
 *  Design note #740: FLATTENED TO A NUMBER LIST, `[q, r, q, r, ...]`. The alternative -- an array of
 *  `{ q, r }` objects -- is legal and roughly twice the bytes for a payload that publishes twice a second.
 *  Encoding and decoding sit beside each other here so the pair cannot drift. */
function encodeHexes(hexes: ReadonlyArray<readonly [number, number]>): number[] {
  const flat: number[] = [];
  for (const [q, r] of hexes) flat.push(q, r);
  return flat;
}

function decodeHexes(flat: unknown): Array<readonly [number, number]> {
  if (!Array.isArray(flat)) return [];
  const out: Array<readonly [number, number]> = [];
  // An odd-length array is a malformed write; the trailing half-pair is dropped rather than read as `[q, NaN]`.
  for (let at = 0; at + 1 < flat.length; at += 2) {
    const q = Number(flat[at]);
    const r = Number(flat[at + 1]);
    if (Number.isFinite(q) && Number.isFinite(r)) out.push([q, r]);
  }
  return out;
}

function toPresence(id: string, data: DocumentData | undefined): PresenceState | null {
  if (!data) return null;
  const at = Number(data.at);
  const drafts: Record<number, Array<readonly [number, number]>> = {};
  const raw = data.routeDrafts;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const index = Number(key);
      if (!Number.isFinite(index)) continue;
      const hexes = decodeHexes(value);
      if (hexes.length > 0) drafts[index] = hexes;
    }
  }
  return {
    playerId: id,
    at: Number.isFinite(at) ? at : 0,
    routeDrafts: drafts,
    actingCompanyId:
      typeof data.actingCompanyId === "number" ? data.actingCompanyId : null,
  };
}

/** Publish this client's live intent. Fire-and-forget: a failed presence write is not worth surfacing.
 *
 *  Design note #740: SWALLOWS ITS ERRORS, unlike `appendSandboxAction`, which reports them because a lost
 *  ACTION is a lost move. A lost presence update costs a rival one stale frame and the next publish fixes it;
 *  raising a room error for that would train players to ignore room errors. */
export async function publishPresence(
  roomCode: string,
  state: PresenceState,
): Promise<void> {
  const db = getFirestoreDb();
  if (!db) return;
  const drafts: Record<string, number[]> = {};
  for (const [index, hexes] of Object.entries(state.routeDrafts ?? {})) {
    if (hexes.length > 0) drafts[index] = encodeHexes(hexes);
  }
  try {
    await setDoc(
      doc(
        db,
        SANDBOX_ROOMS_COLLECTION,
        roomCode,
        SANDBOX_PRESENCE_SUBCOLLECTION,
        state.playerId,
      ),
      {
        at: state.at,
        routeDrafts: drafts,
        actingCompanyId: state.actingCompanyId ?? null,
      },
      { merge: true },
    );
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
  const db = getFirestoreDb();
  if (!db) return;
  try {
    await deleteDoc(
      doc(db, SANDBOX_ROOMS_COLLECTION, roomCode, SANDBOX_PRESENCE_SUBCOLLECTION, playerId),
    );
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
  const db = getFirestoreDb();
  if (!db) return () => undefined;
  return onSnapshot(
    collection(db, SANDBOX_ROOMS_COLLECTION, roomCode, SANDBOX_PRESENCE_SUBCOLLECTION),
    (snapshot) => {
      const entries: PresenceState[] = [];
      snapshot.forEach((document) => {
        const parsed = toPresence(document.id, document.data());
        if (parsed) entries.push(parsed);
      });
      onPresence(entries);
    },
    (error: FirestoreError) => onError?.(error.message),
  );
}
