// server/src/persistence/conformance/referenceLogStore.ts
//
// ==================================================================
//  LIVE-5 L5-1: THE LOG PORT'S REFERENCE MODEL (test-only; never wired into a server)
// ==================================================================
//
// The server has no in-memory `LogStore`: without a store a game lives in the actor's memory (`gameServer.ts`), and the
// suites' `controlledStore` is a fault-injection double, not an implementation of the contract. So the log conformance
// suite needs a second, independent implementation to show that its cases describe the PORT and not the file store's
// accidents. This is it: the smallest store that keeps the contract, over a backing map that a "reopen" shares (the way a
// DynamoDB table outlives the task that wrote it):
//
//   loadLog        every committed entry, in index order, as written (a copy; never the caller's objects).
//   appendBatch    one batch, all or nothing: committed; or DEFINITE (nothing written) when the batch does not begin at
//                  the log's next index, is not contiguous, is larger than a batch may be, holds an entry the store could
//                  not read back (no index / id), or the writer's fence has moved -- checked AGAIN at the apply itself
//                  (`fenceHolds`), the way a DynamoDB condition is, so the model passes the fence-inside-the-write case.
//   appendLog      the throwing form of the same.
//   chat           lossy, append-only, never part of the gameplay history.
//
// The DynamoDB log adapter (L5-2) must pass the same cases (a batch is one TransactWriteItems with the HEAD item).

import type { ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { RoomChatEntry } from "../../../../frontend/src/utils/roomProtocol";
import type { LogStore } from "../../fileLogStore";
import { MAX_BATCH_SPAN } from "../logFormat";
import { COMMITTED, throwUnlessCommitted, type StoreWriteOutcome } from "../storeResult";
import { arrive, type Gate } from "./faults";

export interface ReferenceLogBacking {
  readonly logs: Map<string, string[]>;
  readonly chats: Map<string, string[]>;
  /** A test's stall for a room's next append: held after the writer's checks, before the fenced apply. */
  readonly stalls: Map<string, Gate>;
}

export const newReferenceLogBacking = (): ReferenceLogBacking => ({ logs: new Map(), chats: new Map(), stalls: new Map() });

const readable = (entry: ServerLogEntry): boolean => {
  const raw = entry as unknown as Record<string, unknown>;
  return Number.isSafeInteger(raw.index) && (raw.index as number) >= 0 && typeof raw.id === "string" && raw.id !== "";
};

/** `fenceHolds` is the fence evaluated AT THE APPLY, synchronously with it -- the model of a condition inside the write
 *  (a DynamoDB ConditionCheck): a takeover after `writerCheck` passed, before the apply, still refuses the batch. */
export function createReferenceLogStore(
  backing: ReferenceLogBacking,
  options: { writerCheck?: () => Promise<boolean>; fenceHolds?: () => boolean } = {},
): LogStore & { appendBatch(room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome> } {
  const definite = (detail: string): StoreWriteOutcome => ({ kind: "definite", detail });
  async function appendBatch(room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome> {
    if (entries.length === 0) return COMMITTED;
    if (options.writerCheck && !(await options.writerCheck().catch(() => false))) return definite("fenced: a newer writer owns this log");
    const log = backing.logs.get(room) ?? [];
    if (entries[0].index !== log.length) return definite(`the batch begins at ${entries[0].index}; the log continues at ${log.length}`);
    if (entries.length - 1 > MAX_BATCH_SPAN) return definite("a batch larger than a batch may be");
    for (const [at, entry] of entries.entries()) {
      if (entry.index !== entries[0].index + at) return definite("a batch must be contiguous");
      if (!readable(entry)) return definite("an entry the store could not read back");
    }
    const stall = backing.stalls.get(room);
    if (stall !== undefined) {
      backing.stalls.delete(room);
      arrive(stall);
      await stall.opened;
    }
    /* THE APPLY, with the fence and the index condition evaluated in the same synchronous step as the mutation. */
    if (options.fenceHolds && !options.fenceHolds()) return definite("fenced at the write: a newer writer owns this log");
    const now = backing.logs.get(room) ?? [];
    if (now.length !== log.length) return definite(`the log moved to ${now.length} while this batch waited`);
    backing.logs.set(room, [...now, ...entries.map((entry) => JSON.stringify(entry))]);
    return COMMITTED;
  }
  return {
    async loadLog(room) {
      return (backing.logs.get(room) ?? []).map((line) => JSON.parse(line) as ServerLogEntry);
    },
    appendBatch,
    async appendLog(room, entries) {
      throwUnlessCommitted(await appendBatch(room, entries));
    },
    async loadChat(room) {
      return (backing.chats.get(room) ?? []).map((line) => JSON.parse(line) as RoomChatEntry);
    },
    async appendChat(room, entry) {
      if (options.writerCheck && !(await options.writerCheck().catch(() => false))) throw new Error("fenced: the chat line was not written");
      backing.chats.set(room, [...(backing.chats.get(room) ?? []), JSON.stringify(entry)]);
    },
    async listGameLogs() {
      return [...backing.logs.keys()].filter((room) => /^g_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]$/.test(room) && (backing.logs.get(room) ?? []).length > 0);
    },
    async readHead(room) {
      const log = backing.logs.get(room) ?? [];
      return log.length === 0 ? { present: false, size: 0, first: null } : { present: true, size: log.join("\n").length, first: JSON.parse(log[0]) as ServerLogEntry };
    },
  };
}
