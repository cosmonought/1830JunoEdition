// server/src/persistence/conformance/logStore.conformance.ts
//
// LIVE-5 L5-1: the gameplay-log port (`LogStore` + the classified `appendBatch`), as every implementation must keep it.
// The log is the gameplay authority: append-only, contiguous from index 0, one batch all-or-nothing, never a second
// copy of a batch, never a torn batch acknowledged, and never "repaired" into another build's format. See `harness.ts`.

import assert from "node:assert/strict";

import type { ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { LogStore } from "../../fileLogStore";
import { isStoreCorrupt, isStoreIncompatible, type StoreWriteOutcome } from "../storeResult";
import type { Gate } from "./faults";
import { entries, gameId, largeEntry } from "./fixtures";
import { hook, rejection, stalledAt, turns, type CaseContext, type ConformanceCase, type SubjectBase } from "./harness";

export type ConformantLogStore = LogStore & { appendBatch(room: string, batch: readonly ServerLogEntry[]): Promise<StoreWriteOutcome> };

export interface LogSubject extends SubjectBase {
  /** A store over this case's backing. `writerCheck` is the fence (a DynamoDB subject carries `ctx.fence.epoch`). */
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<ConformantLogStore>;
  /** The room's stored log, as bytes or item text (`null`: nothing stored) -- "nothing was written" is always checked. */
  stored(ctx: CaseContext, room: string): Promise<Buffer | string | null>;
  /** "plant": store these bytes as the room's log, as another writer (or damage) left them. */
  plant?(ctx: CaseContext, room: string, bytes: Buffer): Promise<void>;
  /** "stall-write": hold the room's next append after the writer's own checks, before it is applied. */
  stallNextWrite?(ctx: CaseContext, room: string): Gate;
  /** "inject-lost-answer": the room's next append lands, and its answer is lost. */
  armLostAnswer?(ctx: CaseContext, room: string): void;
  /** "inject-transient-failure": the room's next append fails before it has any effect. */
  armTransientFailure?(ctx: CaseContext, room: string): void;
  /** "inject-unresolved": the room's next append's outcome stays unknown however it is retried (the first attempt tears). */
  armUnresolvedWrite?(ctx: CaseContext, room: string): void;
  /** "fs-faults": the path the file seam sees for a room's log. */
  logPath?(ctx: CaseContext, room: string): string;
}

const ROOM = gameId(1);
const kinds = (outcome: StoreWriteOutcome) => outcome.kind;
const indicesOf = (log: readonly ServerLogEntry[]) => log.map((entry) => entry.index);
const idsOf = (log: readonly ServerLogEntry[]) => log.map((entry) => (entry as unknown as { id: string }).id);

async function seeded(subject: LogSubject, ctx: CaseContext, sizes: readonly number[], options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<{ store: ConformantLogStore; written: ServerLogEntry[] }> {
  const store = await subject.open(ctx, options);
  const written: ServerLogEntry[] = [];
  for (const size of sizes) {
    const batch = entries(written.length, size);
    assert.equal(kinds(await store.appendBatch(ROOM, batch)), "committed");
    written.push(...batch);
  }
  return { store, written };
}

async function unchanged(subject: LogSubject, ctx: CaseContext, before: Buffer | string | null): Promise<void> {
  assert.deepEqual(await subject.stored(ctx, ROOM), before, "a refused write must leave the stored log byte-identical");
}

const chatLine = (ctx: CaseContext, n: number) => ({ id: `c${n}`, author: "p-0000000000000000", displayName: "P", text: `hello ${n}`, at: ctx.tick() });

export const LOG_CASES: readonly ConformanceCase<LogSubject>[] = [
  {
    id: "LOG-01",
    title: "a room never written loads as an empty log",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.deepEqual(await store.loadLog(gameId(99)), []);
      assert.equal(await subject.stored(ctx, gameId(99)), null);
    },
  },
  {
    id: "LOG-02",
    title: "create and read: a committed batch loads back exactly (payload text byte-for-byte), in index order",
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [3]);
      assert.deepEqual(await store.loadLog(ROOM), written);
    },
  },
  {
    id: "LOG-03",
    title: "ordering: batches of different sizes load as one contiguous history from index 0",
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [1, 4, 2, 7, 1]);
      const log = await store.loadLog(ROOM);
      assert.deepEqual(indicesOf(log), written.map((_, at) => at));
      assert.deepEqual(idsOf(log), idsOf(written));
    },
  },
  {
    id: "LOG-04",
    title: "stale writer: a batch that does not begin at the next index is DEFINITE and writes nothing (behind or ahead)",
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [3]);
      const before = await subject.stored(ctx, ROOM);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(1, 2, "stale"))), "definite");
      assert.equal(kinds(await store.appendBatch(ROOM, entries(5, 1, "gap"))), "definite");
      assert.deepEqual(await store.loadLog(ROOM), written);
      await unchanged(subject, ctx, before);
    },
  },
  {
    id: "LOG-05",
    title: "duplicate delivery: the same batch delivered twice is committed once; the second copy is DEFINITE",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const batch = entries(0, 3);
      assert.equal(kinds(await store.appendBatch(ROOM, batch)), "committed");
      const before = await subject.stored(ctx, ROOM);
      assert.equal(kinds(await store.appendBatch(ROOM, batch)), "definite");
      assert.deepEqual(await store.loadLog(ROOM), batch);
      await unchanged(subject, ctx, before);
    },
  },
  {
    id: "LOG-06",
    title: "a batch that is not contiguous, or larger than a batch may be, is DEFINITE and writes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const broken = [...entries(0, 2), ...entries(3, 1)];
      assert.equal(kinds(await store.appendBatch(ROOM, broken)), "definite");
      assert.equal(kinds(await store.appendBatch(ROOM, entries(0, 101))), "definite");
      assert.deepEqual(await store.loadLog(ROOM), []);
      assert.equal(await subject.stored(ctx, ROOM), null);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(0, 100))), "committed", "a batch of 100 entries is the largest a batch may be");
    },
  },
  {
    id: "LOG-07",
    title: "an entry the store could not read back (no id) is refused DEFINITE -- a committed batch always loads back",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const [first] = entries(0, 1);
      const idless = { ...first, id: "" } as unknown as ServerLogEntry;
      assert.equal(kinds(await store.appendBatch(ROOM, [idless])), "definite");
      assert.deepEqual(await store.loadLog(ROOM), []);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(0, 1))), "committed", "the log is still writable at index 0");
    },
  },
  {
    id: "LOG-08",
    title: "append-only: every earlier load is a prefix of every later load, and committed bytes never change",
    async run(subject, ctx) {
      const { store } = await seeded(subject, ctx, [2]);
      const early = await store.loadLog(ROOM);
      const earlyBytes = await subject.stored(ctx, ROOM);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 3))), "committed");
      assert.equal(kinds(await store.appendBatch(ROOM, entries(5, 1))), "committed");
      const late = await store.loadLog(ROOM);
      assert.deepEqual(late.slice(0, early.length), early);
      const lateBytes = await subject.stored(ctx, ROOM);
      assert.ok(earlyBytes !== null && lateBytes !== null);
      assert.equal(String(lateBytes).slice(0, String(earlyBytes).length), String(earlyBytes), "the committed prefix is untouched by later appends");
    },
  },
  {
    id: "LOG-09",
    title: "an empty batch is committed and changes nothing",
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2]);
      const before = await subject.stored(ctx, ROOM);
      assert.equal(kinds(await store.appendBatch(ROOM, [])), "committed");
      assert.deepEqual(await store.loadLog(ROOM), written);
      await unchanged(subject, ctx, before);
    },
  },
  {
    id: "LOG-10",
    title: "restart: a reopened store loads the same history and continues it at the right index",
    needs: ["durable"],
    async run(subject, ctx) {
      const { written } = await seeded(subject, ctx, [2, 3]);
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.loadLog(ROOM), written);
      assert.equal(kinds(await reopened.appendBatch(ROOM, entries(5, 1))), "committed");
      assert.equal(kinds(await reopened.appendBatch(ROOM, entries(0, 1, "again"))), "definite", "history is never restarted from 0");
      assert.deepEqual(indicesOf(await (await subject.open(ctx)).loadLog(ROOM)), [0, 1, 2, 3, 4, 5]);
    },
  },
  {
    id: "LOG-11",
    title: "idempotent retry: a batch whose answer was lost after it landed is committed exactly once -- never twice, never a false conflict",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2]);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, ROOM);
      assert.deepEqual(await store.appendBatch(ROOM, entries(2, 3)), { kind: "committed", redone: true });
      assert.deepEqual(await (await subject.open(ctx)).loadLog(ROOM), [...written, ...entries(2, 3)]);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(5, 1))), "committed", "the log continues after it");
    },
  },
  {
    id: "LOG-12",
    title: "transient failure before any effect: DEFINITE, nothing written, and the retry commits",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2]);
      const before = await subject.stored(ctx, ROOM);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, ROOM);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 2))), "definite");
      await unchanged(subject, ctx, before);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 2))), "committed");
      assert.deepEqual(await store.loadLog(ROOM), [...written, ...entries(2, 2)]);
    },
  },
  {
    id: "LOG-13",
    title: "an outcome that stays unknown is never reported committed; a restart serves either the batch once or not at all",
    needs: ["inject-unresolved", "durable"],
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2]);
      hook(subject.armUnresolvedWrite, "armUnresolvedWrite")(ctx, ROOM);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 2))), "uncertain");
      const reopened = await subject.open(ctx);
      const log = await reopened.loadLog(ROOM);
      assert.ok(JSON.stringify(log) === JSON.stringify(written) || JSON.stringify(log) === JSON.stringify([...written, ...entries(2, 2)]), `a consistent prefix: ${indicesOf(log).join(",")}`);
      assert.equal(kinds(await reopened.appendBatch(ROOM, entries(log.length, 1))), "committed");
    },
  },
  {
    id: "LOG-14",
    title: "file store: an unresolved write POISONS the room (no write, no read) until the restart reads the disk's truth",
    needs: ["fs-faults", "inject-unresolved", "durable"],
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2]);
      hook(subject.armUnresolvedWrite, "armUnresolvedWrite")(ctx, ROOM);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 2))), "uncertain");
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 2))), "definite", "a poisoned room takes no further write");
      await rejection(store.loadLog(ROOM));
      assert.deepEqual(await (await subject.open(ctx)).loadLog(ROOM), written, "the torn in-flight batch was cut at the restart");
    },
  },
  {
    id: "LOG-15",
    title: "file store: a transient read failure rejects the load, damages nothing, and the next load serves the history",
    needs: ["fs-faults"],
    async run(subject, ctx) {
      const { written } = await seeded(subject, ctx, [3]);
      const store = await subject.open(ctx);
      const file = hook(subject.logPath, "logPath")(ctx, ROOM);
      ctx.faults.add({ op: "readFile", where: (at) => at === file, action: { kind: "fail" }, label: "one failed read" });
      await rejection(store.loadLog(ROOM));
      assert.deepEqual(await store.loadLog(ROOM), written);
    },
  },
  {
    id: "LOG-16",
    title: "corrupt history (damage before the final batch) is refused CORRUPT, left byte-identical, and takes no write",
    needs: ["plant"],
    async run(subject, ctx) {
      const good = entries(0, 3).map((entry) => `${JSON.stringify({ ...entry, batch: [entry.index, entry.index] })}\n`);
      const damaged = Buffer.from(`${good[0]}{"index":1,"id":"s0-1"GARBAGE\n${good[2]}`, "utf8");
      await hook(subject.plant, "plant")(ctx, ROOM, damaged);
      const before = await subject.stored(ctx, ROOM);
      const store = await subject.open(ctx);
      const error = await rejection(store.loadLog(ROOM));
      assert.ok(isStoreCorrupt(error), `expected StoreCorruptError, got ${String(error)}`);
      assert.equal(kinds(await store.appendBatch(ROOM, entries(1, 1))), "definite");
      assert.ok(isStoreCorrupt(await rejection(store.loadLog(ROOM))), "every load repeats the same answer");
      await unchanged(subject, ctx, before);
    },
  },
  {
    id: "LOG-17",
    title: "newer format: a complete record another build wrote is INCOMPATIBLE, never truncated, repaired or appended behind",
    needs: ["plant"],
    async run(subject, ctx) {
      const good = entries(0, 2).map((entry) => `${JSON.stringify({ ...entry, batch: [0, 1] })}\n`).join("");
      const newer = Buffer.from(`${good}${JSON.stringify({ format: "gs-log-v2", entries: [{ index: 2 }] })}\n`, "utf8");
      await hook(subject.plant, "plant")(ctx, ROOM, newer);
      const before = await subject.stored(ctx, ROOM);
      const store = await subject.open(ctx);
      assert.ok(isStoreIncompatible(await rejection(store.loadLog(ROOM))));
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 1))), "definite");
      assert.ok(isStoreIncompatible(await rejection(store.loadLog(ROOM))), "every load repeats the same non-destructive answer");
      await unchanged(subject, ctx, before);
    },
  },
  {
    id: "LOG-18",
    title: "torn tail: a final batch cut mid-line is truncated at load; the acknowledged history stands and continues",
    needs: ["plant", "torn-tail"],
    async run(subject, ctx) {
      const first = entries(0, 2).map((entry) => `${JSON.stringify({ ...entry, batch: [0, 1] })}\n`).join("");
      const torn = `${JSON.stringify({ ...entries(2, 2)[0], batch: [2, 3] })}\n{"index":3,"id":"s0-3","ac`;
      await hook(subject.plant, "plant")(ctx, ROOM, Buffer.from(first + torn, "utf8"));
      const store = await subject.open(ctx);
      assert.deepEqual(await store.loadLog(ROOM), entries(0, 2));
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 1))), "committed");
      assert.deepEqual(indicesOf(await (await subject.open(ctx)).loadLog(ROOM)), [0, 1, 2]);
    },
  },
  {
    id: "LOG-19",
    title: "fence: once a newer writer takes over, the stale writer's append and chat are refused and write nothing; reads still serve",
    needs: ["fence"],
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2], { writerCheck: ctx.fence.writer() });
      const before = await subject.stored(ctx, ROOM);
      await ctx.fence.takeOver();
      assert.equal(kinds(await store.appendBatch(ROOM, entries(2, 1))), "definite");
      await unchanged(subject, ctx, before);
      assert.deepEqual(await store.loadLog(ROOM), written);
      await rejection(hook(store.appendChat, "appendChat").call(store, ROOM, chatLine(ctx, 1)));
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.deepEqual(await current.loadLog(ROOM), written);
      assert.equal(kinds(await current.appendBatch(ROOM, entries(2, 1))), "committed", "the newer writer continues the history");
    },
  },
  {
    id: "LOG-20",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its append is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2], { writerCheck: ctx.fence.writer() });
      const before = await subject.stored(ctx, ROOM);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, ROOM);
      const pending = store.appendBatch(ROOM, entries(2, 1));
      await stalledAt(stall, pending, "the stale append");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal(kinds(await pending), "definite", "FENCE-IN-WRITE: the stale writer's in-flight append was applied");
      await unchanged(subject, ctx, before);
      assert.deepEqual(await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).loadLog(ROOM), written);
    },
  },
  {
    id: "LOG-21",
    title: "ordering under a stall: a later append or read on the same room never completes before an earlier stalled append",
    needs: ["stall-write", "ordered-under-stall"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, ROOM);
      const settled: string[] = [];
      const first = store.appendBatch(ROOM, entries(0, 2)).then((outcome) => (settled.push(`first:${outcome.kind}`), outcome));
      await stalledAt(stall, first, "the first append");
      const second = store.appendBatch(ROOM, entries(2, 1)).then((outcome) => (settled.push(`second:${outcome.kind}`), outcome));
      const read = store.loadLog(ROOM).then((log) => (settled.push(`read:${log.length}`), log));
      await turns();
      assert.deepEqual(settled, [], "nothing on the room settles while its earlier write is stalled");
      stall.release();
      await Promise.all([first, second, read]);
      assert.deepEqual(settled, ["first:committed", "second:committed", "read:3"]);
    },
  },
  {
    id: "LOG-22",
    title: "a long history (1,200 entries in 40 batches) and a near-frame-cap entry load whole and in order after a reopen",
    needs: ["durable"],
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, Array.from({ length: 40 }, () => 30));
      const big = largeEntry(1200, 30 * 1024);
      assert.equal(kinds(await store.appendBatch(ROOM, [big])), "committed");
      const log = await (await subject.open(ctx)).loadLog(ROOM);
      assert.equal(log.length, 1201);
      assert.deepEqual(log, [...written, big]);
    },
  },
  {
    id: "LOG-23",
    title: "chat is lossy and separate: lines load in order and never enter the gameplay log",
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [1]);
      const append = hook(store.appendChat, "appendChat");
      const load = hook(store.loadChat, "loadChat");
      await append.call(store, ROOM, chatLine(ctx, 1));
      await append.call(store, ROOM, chatLine(ctx, 2));
      assert.deepEqual((await load.call(store, ROOM)).map((entry) => entry.id), ["c1", "c2"]);
      assert.deepEqual(await store.loadLog(ROOM), written);
    },
  },
  {
    id: "LOG-24",
    title: "discovery reads: game logs are listed by id, and the head read returns the deal without changing a byte",
    async run(subject, ctx) {
      const { store, written } = await seeded(subject, ctx, [2, 1]);
      assert.equal(kinds(await store.appendBatch("JUNO-LEGACY", entries(0, 1))), "committed");
      assert.deepEqual(await hook(store.listGameLogs, "listGameLogs").call(store), [ROOM]);
      const before = await subject.stored(ctx, ROOM);
      const head = await hook(store.readHead, "readHead").call(store, ROOM);
      assert.equal(head.present, true);
      assert.deepEqual(head.first, written[0]);
      assert.deepEqual(await hook(store.readHead, "readHead").call(store, gameId(98)), { present: false, size: 0, first: null });
      await unchanged(subject, ctx, before);
    },
  },
];
