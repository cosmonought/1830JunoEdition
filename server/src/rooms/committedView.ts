// server/src/rooms/committedView.ts
//
// LIVE-3A: the only thing a reader of a game may see.
//
// ==================================================================
//  LIVE-3 L3-1 / L3-2: READS ARE SERVED FROM WHAT IS DURABLE, NEVER FROM THE LIVE SESSION
// ==================================================================
//
// LIVE-1's failure, reproduced by LIVE-3 as P1: a `hello` arriving while a move's append was still awaiting the
// disk was answered from the live `RoomSession`, so a client applied -- and then built on -- an entry the store
// later refused. The session is where a task SPECULATES (the reducer runs on it before the append), so it can
// never be a read authority while a task is in flight.
//
// SO READERS GET THIS INSTEAD. A `CommittedView` is built from the session only at a publish, after the append
// that covers every entry in it has resolved, and it is frozen: a publish REPLACES it, nothing mutates it. A
// hello's catch-up, the digest a watcher checks itself against, the anchor a submission names, the host a
// submit is judged under -- every one is read from here.
//
// WHAT IT CARRIES BEFORE LIVE-2C (LIVE-3 §3.2, the fields that apply to a legacy room):
//   watermark     the last durable index; -1 when the log is empty (§7: w = log_next_index - 1)
//   entries       exactly the durable log, frozen
//   digest        the board at the watermark; `fields` beside it when the server explains divergences (#1225)
//   record        LIVE-2C: the GameRecord as last durably committed -- the room's authority (LIVE-2D: the only one;
//                 the legacy room document is gone)
//   hold          why the game will not take a write: `version` (#1520), `uncertain` (a store outcome not
//                 yet known) or `corrupt` (LIVE-3B: a damaged log, held for an operator); `incompatible` is the
//                 frame a version hold answers with
//   version       +1 per publish, for diagnostics and tests

import type { RoomSession, ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { GameRecord } from "./gameRecord";
import type { HoldCode } from "./lifecycle";
import type { BuildId, ServerMessage } from "../../../frontend/src/utils/serverProtocol";
import { fieldDigests, stateDigest } from "../../../frontend/src/gameEngine";

/** `version`: #1520. `uncertain`: a store outcome not yet known (§17 class 4). `corrupt`: LIVE-3B -- the load found
 *  damage that is not a torn final batch, so no history is served until an operator repairs the file (§8.5).
 *  `held`: LIVE-3C -- a DURABLE hold (`holdStore.ts`): the game's durable sources disagree or could not be read, and
 *  it stays held across restarts until an operator's verified release. `corrupt` and `held` are served identically
 *  (`isMaintenanceHold`): no history, no move, one fixed sentence. */
export type HoldReason = "version" | "uncertain" | "corrupt" | "held";

export interface Hold {
  readonly reason: HoldReason;
  /** Operator-facing. Never sent to a client for a maintenance hold (the fixed sentence is). */
  readonly detail: string;
  /** LIVE-3B: an uncertain outcome only a process restart can resolve (a failed redo, §8.2 step 7). Never read
   *  back: after a failed `fsync` a read can show bytes the disk does not hold. */
  readonly restart?: boolean;
  /** LIVE-3C: why a maintenance hold holds (`lifecycle.ts` `HoldCode`), for the operator's inventory. */
  readonly code?: HoldCode;
}

/** LIVE-3C: a hold that serves no history and takes no change until an operator acts -- a damaged log (`corrupt`,
 *  LIVE-3B) or a durable hold (`held`). */
export const isMaintenanceHold = (hold: Hold | null | undefined): boolean => hold?.reason === "corrupt" || hold?.reason === "held";

export interface CommittedView {
  readonly gameId: string;
  readonly watermark: number;
  readonly entries: readonly ServerLogEntry[];
  readonly digest: string;
  readonly fields?: Readonly<Record<string, string>>;
  /** LIVE-2C: the server-owned GameRecord -- the room's authority -- as committed. `null` only while a game that does
   *  not exist is being looked at (the registry never keeps one). */
  readonly record: Readonly<GameRecord> | null;
  readonly hold: Hold | null;
  readonly incompatible: ServerMessage | null;
  readonly version: number;
}

/** Freeze the committed history. Entries are already immutable by convention -- `RoomSession` never edits one
 *  after minting it -- and this makes the convention a fact for every reader of a view. */
function frozenEntries(entries: readonly ServerLogEntry[]): readonly ServerLogEntry[] {
  for (const entry of entries) if (!Object.isFrozen(entry)) Object.freeze(entry);
  return Object.freeze(entries.slice());
}

/** The view a publish installs, read off a session whose every entry is durable. THROWS if the board cannot be
 *  hashed -- which is why the actor, not this function, decides what a failed build means (E-13). */
export function buildCommittedView(input: {
  gameId: string;
  session: RoomSession;
  record?: Readonly<GameRecord> | null;
  /** An `uncertain` hold carried across a publish; a version hold is read off the session itself. */
  hold?: Hold | null;
  explainDivergence: boolean;
  version: number;
}): CommittedView {
  const { session } = input;
  const incompatible = session.heldAnswer();
  const hold: Hold | null =
    input.hold ??
    (incompatible !== null && incompatible.kind === "incompatible"
      ? { reason: "version", detail: incompatible.reason }
      : null);
  return Object.freeze({
    gameId: input.gameId,
    watermark: session.nextIndex - 1,
    entries: frozenEntries(session.entries),
    digest: stateDigest(session.state),
    ...(input.explainDivergence ? { fields: Object.freeze(fieldDigests(session.state)) } : {}),
    record: input.record ?? null,
    hold,
    incompatible,
    version: input.version,
  });
}

/** LIVE-2C: the same view with a different GameRecord, for a publish that changed only the record. */
export function withRecord(view: CommittedView, record: Readonly<GameRecord>): CommittedView {
  return Object.freeze({ ...view, record, version: view.version + 1 });
}

/** The same view with a different hold, for a publish that changed only whether the game takes writes. */
export function withHold(view: CommittedView, hold: Hold | null): CommittedView {
  return Object.freeze({ ...view, hold, version: view.version + 1 });
}

/** Everything after `fromIndex`, as a catch-up frame. The filter rather than a slice keeps today's behaviour on a
 *  legacy log whose indices are not contiguous (LIVE-3 P2/P2b shapes written before this pass). */
export function catchUpFrom(
  view: CommittedView,
  fromIndex: number,
  build: BuildId,
  extra: { inReplyTo?: string; inFlight?: string[] } = {},
): ServerMessage {
  if (view.incompatible !== null) return view.incompatible;
  return {
    kind: "catch-up",
    entries: view.entries.filter((entry) => entry.index > fromIndex),
    digest: view.digest,
    ...(view.fields ? { fields: { ...view.fields } } : {}),
    build,
    ...extra,
  };
}

/** The entry at `index` in the committed log, from the end (see `RoomSession.entryIdAt`). */
export function entryAt(view: CommittedView, index: number): ServerLogEntry | undefined {
  for (let at = view.entries.length - 1; at >= 0; at -= 1) {
    if (view.entries[at].index === index) return view.entries[at];
  }
  return undefined;
}

/** Whether `longer` begins with exactly `prefix`, entry for entry (index and id). */
export function extendsHistory(prefix: readonly ServerLogEntry[], longer: readonly ServerLogEntry[]): boolean {
  if (longer.length < prefix.length) return false;
  for (let at = 0; at < prefix.length; at += 1) {
    if (longer[at].index !== prefix[at].index || longer[at].id !== prefix[at].id) return false;
  }
  return true;
}
