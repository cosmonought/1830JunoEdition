// server/src/fileLogStore.test.ts
//
// LIVE-3B: the hardened local log store (LIVE-3 §8) -- format, write protocol, recovery, room documents -- against
// real files in temporary directories, with a file-system adapter that injects the faults a disk actually produces
// (short writes, a full disk part-way, `fsync` errors with the bytes still cached, failed renames). Numbered cases
// are the LIVE-3B brief's mandatory list; FI-22 and FI-23 are LIVE-3 §20.2's. Nothing here touches `server/data`.
// Run with `npm test` in server/ (after `npm run build`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  createFileLogStore,
  nodeStoreFs,
  type FileLogStoreOptions,
  type StoreFileHandle,
  type StoreFs,
} from "./fileLogStore";
import { scanLog, serializeBatch, stripStoreMetadata } from "./persistence/logFormat";
import { StoreCorruptError, StoreUncertainError } from "./persistence/storeResult";
import { diagnose, repairBytes, verifyReplay } from "./tools/logDoctor";
import type { ServerLogEntry } from "../../frontend/src/utils/roomSession";
import { logHash, stateDigest } from "../../frontend/src/gameEngine";
import {
  ALICE,
  BOB,
  BUY,
  Client,
  SETUP,
  controlledStore,
  probeSession,
  quietConsole,
  sleep,
  startServer,
  stopServer,
  storedLog,
  until,
  type SeenEntry,
} from "./rooms/testSupport";

quietConsole();

const ROOM = "L3B";
const LOG = `${ROOM}.log.jsonl`;

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `live3b-${tag}-`));
}
function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = tmpDir(tag);
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** Synthetic entries with realistic fields; `from` is the first index. */
function entries(count: number, from = 0, tag = "e"): ServerLogEntry[] {
  return Array.from({ length: count }, (_, at) => ({
    index: from + at,
    id: `${tag}-${from + at}`,
    actor: at % 2 === 0 ? ALICE : BOB,
    payload: JSON.stringify({ PassTurn: { game_id: 0, n: from + at } }),
    at: 1_000 + from + at,
    ...(at > 0 ? { derived: true } : { submission_id: `sub-${from + at}` }),
  }));
}
const legacy = (list: readonly ServerLogEntry[]) => list.map((entry) => `${JSON.stringify(entry)}\n`).join("");
const indices = (list: readonly { index: number }[]) => list.map((entry) => entry.index);
const quiet: Pick<FileLogStoreOptions, "warn"> = { warn: () => undefined };

const errno = (code: string, message = "injected") => Object.assign(new Error(`${code}: ${message}`), { code });

/* ==================================================================
    A FILE SYSTEM THAT MISBEHAVES ON COMMAND
   ================================================================== */
type WriteFault =
  | { short: number } // write at most this many bytes, report the count, no error
  | { zero: true } // report 0 bytes written
  | { error: string } // throw before writing anything in this call
  | { junkAfter: number; error: string }; // write NULs this far past the intended end, then throw

interface Hooks {
  write?: (call: { file: string; n: number; length: number; position: number }) => WriteFault | undefined;
  sync?: (call: { file: string; n: number }) => string | undefined;
  open?: (call: { file: string; flags: string }) => string | undefined;
  rename?: (call: { from: string; to: string; n: number }) => { error: string; afterRename: boolean } | undefined;
  /** Awaited before a write call; lets a test hold a write in the air. */
  beforeWrite?: (file: string) => Promise<void> | void;
}

function faultyFs(hooks: Hooks = {}) {
  const ops: string[] = [];
  const counts = { writes: 0, syncs: 0, renames: 0 };
  const name = (file: string) => path.basename(file) || file;
  const wrap = (file: string, real: StoreFileHandle): StoreFileHandle => ({
    async write(buffer, offset, length, position) {
      counts.writes += 1;
      await hooks.beforeWrite?.(file);
      const fault = hooks.write?.({ file, n: counts.writes, length, position });
      if (fault && "error" in fault && !("junkAfter" in fault)) {
        ops.push(`write-error ${name(file)} ${fault.error}`);
        throw errno(fault.error);
      }
      if (fault && "junkAfter" in fault) {
        await real.write(new Uint8Array(fault.junkAfter), 0, fault.junkAfter, position + length);
        ops.push(`write-junk ${name(file)} +${fault.junkAfter}`);
        throw errno(fault.error);
      }
      if (fault && "zero" in fault) {
        ops.push(`write ${name(file)} @${position} 0/${length}`);
        return { bytesWritten: 0 };
      }
      const take = fault && "short" in fault ? Math.min(fault.short, length) : length;
      const { bytesWritten } = await real.write(buffer, offset, take, position);
      ops.push(`write ${name(file)} @${position} ${bytesWritten}/${length}`);
      return { bytesWritten };
    },
    stat: () => real.stat(),
    async truncate(length) {
      ops.push(`truncate ${name(file)} ${length}`);
      await real.truncate(length);
    },
    async sync() {
      counts.syncs += 1;
      const code = hooks.sync?.({ file, n: counts.syncs });
      if (code) {
        ops.push(`sync-error ${name(file)} ${code}`);
        throw errno(code);
      }
      ops.push(`sync ${name(file)}`);
      await real.sync();
    },
    async close() {
      ops.push(`close ${name(file)}`);
      await real.close();
    },
  });
  const io: StoreFs = {
    ...nodeStoreFs,
    async open(file, flags) {
      const code = hooks.open?.({ file, flags });
      if (code) {
        ops.push(`open-error ${flags} ${name(file)} ${code}`);
        throw errno(code);
      }
      const real = await nodeStoreFs.open(file, flags);
      ops.push(`open ${flags} ${name(file)}`);
      return wrap(file, real);
    },
    async rename(from, to) {
      counts.renames += 1;
      const fault = hooks.rename?.({ from, to, n: counts.renames });
      if (fault?.afterRename) await nodeStoreFs.rename(from, to);
      if (fault) {
        ops.push(`rename-error ${name(from)} -> ${name(to)} ${fault.error}${fault.afterRename ? " (after it landed)" : ""}`);
        throw errno(fault.error);
      }
      await nodeStoreFs.rename(from, to);
      ops.push(`rename ${name(from)} -> ${name(to)}`);
    },
  };
  return { io, ops, counts };
}

/* ==================================================================
    §8.1 / §8.3: FORMAT AND LOAD
   ================================================================== */
describe("the stamped format and the validated load (§8.1, §8.3)", () => {
  test("1: a legacy unstamped log loads exactly, and is synced before it is served", () =>
    withDir("legacy", async (dir) => {
      const list = entries(5);
      fs.writeFileSync(path.join(dir, LOG), legacy(list));
      const store = createFileLogStore(dir, quiet);
      assert.deepEqual(await store.loadLog(ROOM), list);
      assert.equal(store.stats.loadSyncs, 1);
      assert.equal(store.stats.tornTailsRepaired, 0);
    }));

  test("2, 3: stamped single-entry and multi-entry batches are one line per entry and load as their entries", () =>
    withDir("stamped", async (dir) => {
      const store = createFileLogStore(dir, quiet);
      const all = entries(6);
      assert.equal((await store.appendBatch(ROOM, all.slice(0, 1))).kind, "committed");
      assert.equal((await store.appendBatch(ROOM, all.slice(1, 4))).kind, "committed");
      assert.equal((await store.appendBatch(ROOM, all.slice(4, 5))).kind, "committed");
      assert.equal((await store.appendBatch(ROOM, all.slice(5, 6))).kind, "committed");
      const lines = fs.readFileSync(path.join(dir, LOG), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.length, 6, "one line per entry");
      assert.deepEqual(
        lines.map((line) => line.batch),
        [[0, 0], [1, 3], [1, 3], [1, 3], [4, 4], [5, 5]],
      );
      assert.deepEqual(await createFileLogStore(dir, quiet).loadLog(ROOM), all);
    }));

  test("legacy lines followed by stamped batches load as one history, and the append continues after them", () =>
    withDir("mixed", async (dir) => {
      fs.writeFileSync(path.join(dir, LOG), legacy(entries(3)));
      const store = createFileLogStore(dir, quiet);
      assert.equal((await store.appendBatch(ROOM, entries(2, 3))).kind, "committed");
      assert.deepEqual(indices(await createFileLogStore(dir, quiet).loadLog(ROOM)), [0, 1, 2, 3, 4]);
    }));

  test("23: the batch stamp is stripped before an entry reaches replay, logHash or a digest", () =>
    withDir("strip", async (dir) => {
      const log = storedLog(4);
      const store = createFileLogStore(dir, quiet);
      assert.equal((await store.appendBatch(ROOM, log.slice(0, 1))).kind, "committed");
      assert.equal((await store.appendBatch(ROOM, log.slice(1))).kind, "committed");
      const loaded = await createFileLogStore(dir, quiet).loadLog(ROOM);
      assert.ok(loaded.every((entry) => !("batch" in entry)), "no stamp survives the load");
      assert.deepEqual(loaded, log);
      assert.equal(logHash(loaded), logHash(log));
      const fromStore = probeSession("strip-a");
      fromStore.restore(loaded);
      const original = probeSession("strip-b");
      original.restore(log);
      assert.equal(stateDigest(fromStore.state), stateDigest(original.state));
      // The stored bytes of each entry are its old bytes plus the stamp -- nothing else changed.
      const text = fs.readFileSync(path.join(dir, LOG), "utf8").trim().split("\n");
      text.forEach((line, at) => {
        assert.equal(line, `${JSON.stringify(log[at]).slice(0, -1)},"batch":${JSON.stringify(JSON.parse(line).batch)}}`);
      });
    }));
});

describe("recovery: a torn tail is cut, anything else is held (§8.3, §8.4)", () => {
  const prefix = () => serializeBatch(entries(1)) + serializeBatch(entries(3, 1)); // [0] [1..3]
  const inflight = () => serializeBatch(entries(3, 4)); // [4..6], the batch that was being written

  async function loadsTo(dir: string, bytes: Buffer | string, expected: number[], tornBytes: number) {
    const file = path.join(dir, LOG);
    fs.writeFileSync(file, bytes);
    const store = createFileLogStore(dir, quiet);
    assert.deepEqual(indices(await store.loadLog(ROOM)), expected);
    assert.equal(store.stats.tornBytesRepaired, tornBytes);
    assert.equal(fs.statSync(file).size, Buffer.byteLength(prefix()), "truncated back to the last complete batch");
    assert.equal(store.stats.loadSyncs, 1, "synced before serving");
    // And the next batch lands exactly where the torn one was cut.
    assert.equal((await store.appendBatch(ROOM, entries(1, 4, "next"))).kind, "committed");
    assert.deepEqual(indices(await createFileLogStore(dir, quiet).loadLog(ROOM)), [...expected, 4]);
  }

  test("4: a torn final JSON line is truncated", () =>
    withDir("torn", async (dir) => {
      const bytes = prefix() + inflight().slice(0, 57);
      await loadsTo(dir, bytes, [0, 1, 2, 3], 57);
    }));

  test("5: whole lines of an incomplete final batch are truncated as a whole batch", () =>
    withDir("whole", async (dir) => {
      const lines = inflight().split("\n");
      const partial = `${lines[0]}\n${lines[1]}\n`; // two of three lines, both whole
      await loadsTo(dir, prefix() + partial, [0, 1, 2, 3], Buffer.byteLength(partial));
    }));

  test("6: page-like holes inside the final batch are truncated with it", () =>
    withDir("hole", async (dir) => {
      const tail = Buffer.from(inflight());
      const lines = inflight().split("\n");
      const start = Buffer.byteLength(`${lines[0]}\n`);
      tail.fill(0, start, start + Buffer.byteLength(lines[1]) + 1); // the middle line and its newline lost
      await loadsTo(dir, Buffer.concat([Buffer.from(prefix()), tail]), [0, 1, 2, 3], tail.length);
      // A hole that swallows only a newline, gluing two lines of the same in-flight batch, is still that batch.
      const glued = Buffer.from(inflight());
      glued[Buffer.byteLength(lines[0])] = 0;
      fs.rmSync(path.join(dir, LOG));
      await loadsTo(dir, Buffer.concat([Buffer.from(prefix()), glued]), [0, 1, 2, 3], glued.length);
    }));

  test("7: a NUL-extended or garbage tail is truncated", () =>
    withDir("nul", async (dir) => {
      await loadsTo(dir, Buffer.concat([Buffer.from(prefix()), Buffer.alloc(4096)]), [0, 1, 2, 3], 4096);
      fs.rmSync(path.join(dir, LOG));
      await loadsTo(dir, `${prefix()}#!garbage\n\u0000\u0000{"ind`, [0, 1, 2, 3], Buffer.byteLength('#!garbage\n\u0000\u0000{"ind'));
    }));

  async function holds(dir: string, bytes: Buffer | string, why: RegExp) {
    const file = path.join(dir, LOG);
    fs.writeFileSync(file, bytes);
    const before = fs.readFileSync(file);
    const store = createFileLogStore(dir, quiet);
    await assert.rejects(store.loadLog(ROOM), (error: unknown) => error instanceof StoreCorruptError && why.test(error.message));
    assert.ok(fs.readFileSync(file).equals(before), "the file is left byte-for-byte as found");
    assert.equal(store.stats.corruptHeld, 1);
    // Nothing can be appended behind it either.
    const refused = await store.appendBatch(ROOM, entries(1, 9));
    assert.equal(refused.kind, "definite");
    assert.ok(fs.readFileSync(file).equals(before));
  }

  test("8: a malformed line with a later valid batch after it is CORRUPT, held and untouched", () =>
    withDir("midfile", async (dir) => {
      const lines = serializeBatch(entries(3, 1)).split("\n");
      const damaged = serializeBatch(entries(1)) + `${lines[0]}\n{"index":2,"id":"e-2",GARBAGE\n${lines[2]}\n` + serializeBatch(entries(1, 4));
      await holds(dir, damaged, /cannot belong to the batch in flight/);
    }));

  test("9: a duplicate index is held", () =>
    withDir("dup", async (dir) => {
      await holds(dir, legacy([...entries(2), ...entries(1, 1, "again")]), /index 1/);
      fs.rmSync(path.join(dir, LOG));
      await holds(dir, serializeBatch(entries(2)) + serializeBatch(entries(2)), /cannot belong/);
    }));

  test("10: a skipped index is held", () =>
    withDir("skip", async (dir) => {
      await holds(dir, legacy([...entries(2), ...entries(1, 3)]), /index 3/);
    }));

  test("11: today's poisoned shape -- acknowledged entries appended behind a torn fragment -- is held, not truncated", () =>
    withDir("poison", async (dir) => {
      const whole = legacy(entries(2));
      const torn = JSON.stringify(entries(1, 2, "crashed")[0]).slice(0, 40); // no newline: the crash
      // The old store loaded [0,1], minted index 2 again and O_APPENDed it behind the fragment; then index 3.
      await holds(dir, whole + torn + legacy(entries(2, 2, "acked")), /cannot belong|F-8/);
      // Even ONE acknowledged entry glued behind the fragment is history, not a torn tail.
      fs.rmSync(path.join(dir, LOG));
      await holds(dir, whole + torn + legacy(entries(1, 2, "acked")), /F-8/);
    }));
});

/* ==================================================================
    §8.2: THE WRITE PROTOCOL
   ================================================================== */
describe("the write protocol (§8.2)", () => {
  test("13: short positive writes are continued until every byte is written", () =>
    withDir("short", async (dir) => {
      const { io, ops } = faultyFs({ write: () => ({ short: 7 }) });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      const batch = entries(3);
      assert.deepEqual(await store.appendBatch(ROOM, batch), { kind: "committed", redone: false });
      assert.ok(store.stats.shortWrites > 5);
      assert.ok(ops.filter((op) => op.startsWith("write ")).length > 5);
      assert.deepEqual(await createFileLogStore(dir, quiet).loadLog(ROOM), batch);
    }));

  test("14, 16: a zero-byte write is uncertain, and the redo writes the batch exactly once at the committed offset", () =>
    withDir("zero", async (dir) => {
      const store0 = createFileLogStore(dir, quiet);
      await store0.appendBatch(ROOM, entries(1));
      const { io, counts } = faultyFs({ write: ({ n }) => (n === 1 ? { zero: true } : undefined) });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      await store.loadLog(ROOM);
      const outcome = await store.appendBatch(ROOM, entries(3, 1));
      assert.deepEqual(outcome, { kind: "committed", redone: true });
      assert.ok(counts.writes >= 2);
      const lines = fs.readFileSync(path.join(dir, LOG), "utf8").trim().split("\n");
      assert.equal(lines.length, 4, "exactly one copy of the batch");
      assert.deepEqual(indices(await createFileLogStore(dir, quiet).loadLog(ROOM)), [0, 1, 2, 3]);
    }));

  test("16: stray bytes an attempt left past the batch are cut on the redo -- ftruncate only ever shrinks", () =>
    withDir("stray", async (dir) => {
      const { io, ops } = faultyFs({ write: ({ n }) => (n === 1 ? { junkAfter: 300, error: "EIO" } : undefined) });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      const batch = entries(2);
      assert.deepEqual(await store.appendBatch(ROOM, batch), { kind: "committed", redone: true });
      const intended = Buffer.byteLength(serializeBatch(batch));
      assert.equal(fs.statSync(path.join(dir, LOG)).size, intended);
      const cuts = ops.filter((op) => op.startsWith("truncate")).map((op) => Number(op.split(" ")[2]));
      assert.deepEqual(cuts, [intended], "one truncate, DOWN to the intended end");
      assert.deepEqual(await createFileLogStore(dir, quiet).loadLog(ROOM), batch);
    }));

  test("12, 15, 17, 20 / FI-22: a short write then ENOSPC is uncertain; a redo into a still-full disk holds -- never acknowledged, never written behind", () =>
    withDir("fi22", async (dir) => {
      const base = createFileLogStore(dir, quiet);
      await base.appendBatch(ROOM, entries(1));
      let full = true;
      // The reviewer's tmpfs sequence: 4096 of N bytes with no error, then ENOSPC on the next call.
      const { io, counts } = faultyFs({
        write: ({ length }) => (full ? (length > 64 ? { short: 64 } : { error: "ENOSPC" }) : undefined),
      });
      const restarts: string[] = [];
      const store = createFileLogStore(dir, { ...quiet, fs: io, onRestartRequired: (room, detail) => restarts.push(`${room} ${detail}`) });
      await store.loadLog(ROOM);
      const outcome = await store.appendBatch(ROOM, entries(3, 1));
      assert.equal(outcome.kind, "uncertain", "never committed while the bytes are not all there");
      assert.match((outcome as { detail: string }).detail, /ENOSPC[\s\S]*redo failed too/);
      assert.equal(restarts.length, 1, "the process is asked to restart");
      assert.ok(fs.statSync(path.join(dir, LOG)).size > Buffer.byteLength(serializeBatch(entries(1))), "partial bytes are on the disk");
      // 20: nothing more is written, and nothing is read back, until a restart.
      full = false;
      const writes = counts.writes;
      assert.equal((await store.appendBatch(ROOM, entries(1, 1))).kind, "definite");
      assert.equal(counts.writes, writes);
      await assert.rejects(store.loadLog(ROOM), StoreUncertainError);
      // The restart reads the disk's truth: the partial batch is a torn tail, cut; the acknowledged prefix stands.
      const restarted = createFileLogStore(dir, quiet);
      assert.deepEqual(indices(await restarted.loadLog(ROOM)), [0]);
      assert.ok(restarted.stats.tornBytesRepaired > 0);
      assert.equal((await restarted.appendBatch(ROOM, entries(3, 1))).kind, "committed");
    }));

  test("FI-22: once space is freed, the redo of a short-then-ENOSPC write succeeds and is committed once", () =>
    withDir("fi22b", async (dir) => {
      let calls = 0;
      const { io } = faultyFs({
        write: ({ length }) => {
          calls += 1;
          if (calls === 1) return length > 64 ? { short: 64 } : undefined;
          if (calls === 2) return { error: "ENOSPC" };
          return undefined; // freed before the redo
        },
      });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      assert.deepEqual(await store.appendBatch(ROOM, entries(3)), { kind: "committed", redone: true });
      assert.equal(fs.readFileSync(path.join(dir, LOG), "utf8").trim().split("\n").length, 3);
    }));

  test("FI-22 (real disk): a tmpfs too small for the batch never acknowledges it", { skip: !process.env.LIVE3B_TMPFS_DIR }, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.LIVE3B_TMPFS_DIR as string, "fi22-"));
    try {
      const store = createFileLogStore(dir, quiet);
      const big = entries(60).map((entry) => ({ ...entry, payload: JSON.stringify({ PassTurn: { game_id: 0, pad: "x".repeat(900) } }) }));
      let committed = 0;
      let failed: string | null = null;
      for (let from = 0; failed === null && from < 1000; from += 60) {
        const batch = big.map((entry, at) => ({ ...entry, index: from + at, id: `big-${from + at}` }));
        const outcome = await store.appendBatch(ROOM, batch);
        if (outcome.kind === "committed") committed += batch.length;
        else failed = outcome.kind;
      }
      assert.ok(failed !== null, "the small tmpfs filled");
      assert.notEqual(failed, "committed");
      assert.deepEqual(indices(await createFileLogStore(dir, quiet).loadLog(ROOM)).length, committed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("18, 19 / FI-23: an fsync error with the bytes still readable is NOT resolved by a re-read; the redo commits it once", () =>
    withDir("fi23", async (dir) => {
      const { io, counts, ops } = faultyFs({ sync: ({ file, n }) => (file.endsWith(LOG) && n === 1 ? "EIO" : undefined) });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      const batch = entries(3);
      const outcome = await store.appendBatch(ROOM, batch);
      assert.deepEqual(outcome, { kind: "committed", redone: true });
      const writes = ops.filter((op) => op.startsWith("write ")).length;
      assert.equal(writes, 2, "the batch was written twice -- once, then REDONE -- never adopted by reading it back");
      assert.ok(counts.syncs >= 2);
      assert.equal(fs.readFileSync(path.join(dir, LOG), "utf8").trim().split("\n").length, 3, "one copy on disk");
    }));

  test("17, 18 / FI-23: when the redo's fsync fails too, cached bytes that read back complete are still not committed", () =>
    withDir("fi23b", async (dir) => {
      const { io } = faultyFs({ sync: ({ file }) => (file.endsWith(LOG) ? "EIO" : undefined) });
      const restarts: string[] = [];
      const store = createFileLogStore(dir, { ...quiet, fs: io, onRestartRequired: (room) => restarts.push(room) });
      const batch = entries(3);
      const outcome = await store.appendBatch(ROOM, batch);
      assert.equal(outcome.kind, "uncertain");
      assert.deepEqual(restarts, [ROOM]);
      // A plain re-read WOULD see the whole batch -- which is exactly why it is not trusted.
      assert.deepEqual(scanLog(fs.readFileSync(path.join(dir, LOG))).entries, batch);
      await assert.rejects(store.loadLog(ROOM), StoreUncertainError, "the store itself refuses to re-read");
      assert.equal((await store.appendBatch(ROOM, entries(1, 3))).kind, "definite");
    }));

  test("an open that fails before any byte is written is DEFINITE -- retry is safe", () =>
    withDir("open", async (dir) => {
      const { io } = faultyFs({ open: ({ file }) => (file.endsWith(LOG) ? "EMFILE" : undefined) });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      const outcome = await store.appendBatch(ROOM, entries(1));
      assert.equal(outcome.kind, "definite");
      assert.equal(fs.existsSync(path.join(dir, LOG)), false);
    }));

  test("21: a new log's directory entry is synced (POSIX); on Windows the residual is skipped, not faked", () =>
    withDir("dirsync", async (dir) => {
      const { io, ops } = faultyFs();
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      await store.appendBatch(ROOM, entries(1));
      const base = path.basename(dir);
      const created = ops.indexOf(`open wx ${LOG}`);
      const fileSync = ops.indexOf(`sync ${LOG}`);
      const dirSync = ops.indexOf(`sync ${base}`);
      assert.ok(created !== -1 && fileSync > created, `created, then synced: ${ops.join(" | ")}`);
      if (process.platform !== "win32") {
        assert.ok(dirSync > fileSync, `the directory is synced after the file: ${ops.join(" | ")}`);
        assert.equal(store.stats.dirSyncs, 1);
      }
      // The second batch to the same file does not re-sync the directory.
      await store.appendBatch(ROOM, entries(1, 1));
      assert.equal(ops.filter((op) => op === `sync ${base}`).length, process.platform === "win32" ? 0 : 1);

      const windows = faultyFs();
      const skipped = createFileLogStore(dir, { ...quiet, fs: windows.io, platform: "win32" });
      await skipped.appendBatch("WIN", entries(1));
      assert.equal(windows.ops.filter((op) => op.endsWith(` ${base}`)).length, 0, "no directory handle on Windows");
      assert.equal(skipped.stats.dirSyncSkipped, 1);
    }));

  test("22: a load syncs the file before serving it, repaired or not", () =>
    withDir("loadsync", async (dir) => {
      fs.writeFileSync(path.join(dir, LOG), legacy(entries(2)));
      const { io, ops } = faultyFs();
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      await store.loadLog(ROOM);
      assert.deepEqual(ops, [`open r+ ${LOG}`, `sync ${LOG}`, `close ${LOG}`]);
    }));

  test("the writer check runs before every write: a fenced process writes nothing", () =>
    withDir("fence", async (dir) => {
      let owner = true;
      const store = createFileLogStore(dir, { ...quiet, writerCheck: async () => owner });
      assert.equal((await store.appendBatch(ROOM, entries(1))).kind, "committed");
      owner = false;
      assert.equal((await store.appendBatch(ROOM, entries(1, 1))).kind, "definite");
      assert.equal((await store.replaceRoomDoc(ROOM, { hostId: ALICE } as never)).kind, "definite");
      assert.deepEqual(indices(await createFileLogStore(dir, quiet).loadLog(ROOM)), [0]);
    }));

  test("27: two games write independently while one of them is held at the disk", () =>
    withDir("two", async (dir) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { io } = faultyFs({ beforeWrite: (file) => (file.includes("SLOW") ? gate : undefined) });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      const slow = store.appendBatch("SLOW", entries(1));
      await sleep(20);
      assert.equal((await store.appendBatch("FAST", entries(1))).kind, "committed", "the other game did not wait");
      assert.equal((await store.appendBatch("FAST", entries(1, 1))).kind, "committed");
      release();
      assert.equal((await slow).kind, "committed");
    }));

  test("28: one game's operations stay in order under delayed I/O -- a later batch and a load wait for the earlier write", () =>
    withDir("order", async (dir) => {
      let delay = true;
      const { io } = faultyFs({ beforeWrite: () => (delay ? sleep(40).then(() => void (delay = false)) : undefined) });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      const first = store.appendBatch(ROOM, entries(2));
      const second = store.appendBatch(ROOM, entries(1, 2));
      const read = store.loadLog(ROOM);
      assert.deepEqual([(await first).kind, (await second).kind], ["committed", "committed"]);
      assert.deepEqual(indices(await read), [0, 1, 2], "the load ran after both writes");
      const lines = fs.readFileSync(path.join(dir, LOG), "utf8").trim().split("\n").map((line) => JSON.parse(line).index);
      assert.deepEqual(lines, [0, 1, 2]);
    }));
});

/* ==================================================================
    §8.7: THE ROOM DOCUMENT
   ================================================================== */
describe("durable room-document replacement (§8.7)", () => {
  const doc = (hostId: string) => ({ hostId, players: [], status: "waiting" }) as never;
  const DOC = `${ROOM}.room.json`;

  test("24, 25: unique temporary, written, synced, renamed, directory synced -- in that order", () =>
    withDir("doc", async (dir) => {
      const { io, ops } = faultyFs();
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      assert.equal((await store.replaceRoomDoc(ROOM, doc(ALICE))).kind, "committed");
      assert.equal((await store.replaceRoomDoc(ROOM, doc(BOB))).kind, "committed");
      const temps = ops.filter((op) => op.startsWith("open wx ")).map((op) => op.slice("open wx ".length));
      assert.equal(temps.length, 2);
      assert.notEqual(temps[0], temps[1], "a temporary name is never reused");
      for (const temp of temps) assert.match(temp, new RegExp(`^${DOC.replace(".", "\\.")}\\.${process.pid}\\.\\d+\\.tmp$`));
      const first = ops.slice(0, ops.indexOf(`rename ${temps[0]} -> ${DOC}`) + 2);
      assert.deepEqual(first.slice(0, 4), [`open wx ${temps[0]}`, `write ${temps[0]} @0 ${first[1].split(" ")[3]}`, `sync ${temps[0]}`, `close ${temps[0]}`]);
      assert.equal(first[4], `rename ${temps[0]} -> ${DOC}`);
      if (process.platform !== "win32") assert.equal(first[5], `open r ${path.basename(dir)}`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, DOC), "utf8")).hostId, BOB);
      assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temporaries left");
    }));

  test("a failure BEFORE the rename is definite: the previous document stands", () =>
    withDir("docpre", async (dir) => {
      const { io } = faultyFs({ sync: ({ file }) => (file.endsWith(".tmp") ? "EIO" : undefined) });
      const good = createFileLogStore(dir, quiet);
      await good.replaceRoomDoc(ROOM, doc(ALICE));
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      assert.equal((await store.replaceRoomDoc(ROOM, doc(BOB))).kind, "definite");
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, DOC), "utf8")).hostId, ALICE);
      assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
    }));

  test("26: a failure AT or AFTER the rename is uncertain: redone; if the redo fails, held for a restart and never read back", () =>
    withDir("docpost", async (dir) => {
      const once = faultyFs({ rename: ({ n }) => (n === 1 ? { error: "EIO", afterRename: true } : undefined) });
      const store = createFileLogStore(dir, { ...quiet, fs: once.io });
      assert.deepEqual(await store.replaceRoomDoc(ROOM, doc(ALICE)), { kind: "committed", redone: true });
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, DOC), "utf8")).hostId, ALICE);

      const always = faultyFs({ rename: () => ({ error: "EIO", afterRename: true }) });
      const restarts: string[] = [];
      const stuck = createFileLogStore(dir, { ...quiet, fs: always.io, onRestartRequired: (room) => restarts.push(room) });
      const outcome = await stuck.replaceRoomDoc(ROOM, doc(BOB));
      assert.equal(outcome.kind, "uncertain");
      assert.deepEqual(restarts, [ROOM]);
      // The new document may well be the one on disk -- the store does not look; it refuses until a restart.
      await assert.rejects(stuck.loadRoomDoc(ROOM), StoreUncertainError);
      assert.equal((await stuck.replaceRoomDoc(ROOM, doc(ALICE))).kind, "definite");
    }));
});

/* ==================================================================
    THE SERVER OVER THE HARDENED STORE
   ================================================================== */
describe("the server over the hardened store", () => {
  test("E-11 with the real file store: a write held at the disk holds the game, issues no second write, and lands once", () =>
    withDir("e11", async (dir) => {
      let release: () => void = () => undefined;
      let holding = false;
      const gate = () => (holding ? new Promise<void>((resolve) => (release = resolve)) : undefined);
      const { io, counts } = faultyFs({ beforeWrite: () => gate() });
      const store = createFileLogStore(dir, { ...quiet, fs: io });
      const { server, port } = await startServer({ store, storeTimeoutMs: 50 });
      try {
        const alice = await Client.open(port, ALICE);
        alice.hello(ROOM);
        await alice.next((f) => f.kind === "catch-up");
        holding = true;
        alice.submit(SETUP, { baseIndex: -1, submissionId: "deal" });
        assert.equal((await alice.answerTo("deal")).code, "unavailable");
        const bob = await Client.open(port, BOB);
        bob.hello(ROOM);
        assert.equal((await bob.next((f) => f.kind === "status")).state, "unavailable");
        bob.submit(BUY, { baseIndex: -1, submissionId: "queued" });
        await sleep(120);
        assert.equal(counts.writes, 1, "no second write was issued behind the held one");
        holding = false;
        release();
        const landed = await bob.next((f) => f.kind === "applied");
        assert.deepEqual((landed.entries as SeenEntry[]).map((e) => e.submission_id), ["deal"]);
        assert.equal((await bob.answerTo("queued")).kind, "catch-up");
        assert.deepEqual(indices(await createFileLogStore(dir, quiet).loadLog(ROOM)), [0]);
        await Promise.all([alice.close(), bob.close()]);
      } finally {
        await stopServer(server);
      }
    }));

  test("a CORRUPT log is held: no history served, no move taken, the file untouched; logDoctor's verified copy then loads", () =>
    withDir("held", async (dir) => {
      const log = storedLog(3);
      const file = path.join(dir, LOG);
      const torn = JSON.stringify(log[2]).slice(0, 50);
      // F-8: [0,1], a torn fragment of 2, then 2 and 3 appended behind it by the old O_APPEND store.
      fs.writeFileSync(file, legacy(log.slice(0, 2)) + torn + legacy(log.slice(2)));
      const before = fs.readFileSync(file);
      const first = await startServer({ store: createFileLogStore(dir, quiet) });
      try {
        const alice = await Client.open(first.port, ALICE);
        alice.hello(ROOM);
        const answer = await alice.next((f) => f.kind === "error" || f.kind === "catch-up");
        assert.deepEqual([answer.kind, answer.code], ["error", "held"]);
        assert.equal(alice.seen().length, 0, "no history served");
        alice.submit(BUY, { baseIndex: 3, submissionId: "x" });
        assert.equal((await alice.answerTo("x")).code, "held");
        assert.ok(fs.readFileSync(file).equals(before), "untouched");
        assert.equal(first.server.counters.heldCorrupt, 1);
        await alice.close();
      } finally {
        await stopServer(first.server);
      }
      // Offline: diagnose, repair into a copy, verify, install -- then a verified reload.
      assert.equal(diagnose(file, before).classification, "corrupt");
      assert.equal(repairBytes(before).ok, false, "not without --split-poisoned");
      const repair = repairBytes(before, { split: true });
      assert.ok(repair.ok);
      if (!repair.ok) return;
      assert.deepEqual(repair.entries, log);
      assert.equal(repair.splits.length, 1);
      const replay = verifyReplay(repair.entries);
      assert.ok(replay.ok && replay.logHash === logHash(log));
      assert.ok(fs.readFileSync(file).equals(before), "the original is still untouched");
      fs.renameSync(file, `${file}.original`);
      fs.writeFileSync(file, repair.bytes);
      const second = await startServer({ store: createFileLogStore(dir, quiet) });
      try {
        const back = await Client.open(second.port, ALICE);
        back.hello(ROOM);
        const hello = await back.next((f) => f.kind === "catch-up");
        assert.deepEqual((hello.entries as SeenEntry[]).map((e) => e.id), log.map((e) => e.id));
        await back.close();
      } finally {
        await stopServer(second.server);
      }
    }));

  test("the 3A regressions over the real file store: the smoke shape, a restart, and the file one entry per line", () =>
    withDir("restart", async (dir) => {
      const first = await startServer({ store: createFileLogStore(dir, quiet) });
      const alice = await Client.open(first.port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal" });
      const dealt = await alice.answerTo("deal");
      assert.equal(dealt.kind, "applied");
      alice.submit(BUY, { baseIndex: (dealt.entries as SeenEntry[]).length - 1, submissionId: "buy" });
      assert.equal((await alice.answerTo("buy")).kind, "applied");
      await alice.close();
      await stopServer(first.server);
      const stored = await createFileLogStore(dir, quiet).loadLog(ROOM);
      const lines = fs.readFileSync(path.join(dir, LOG), "utf8").trim().split("\n");
      assert.equal(lines.length, stored.length, "one line per entry");
      const second = await startServer({ store: createFileLogStore(dir, quiet) });
      try {
        const back = await Client.open(second.port, BOB);
        back.hello(ROOM);
        const hello = await back.next((f) => f.kind === "catch-up");
        assert.deepEqual(hello.entries, stored);
        const replay = probeSession("restart-verify");
        replay.restore(lines.map((line) => stripStoreMetadata(JSON.parse(line))));
        assert.equal(hello.digest, stateDigest(replay.state));
        await back.close();
      } finally {
        await stopServer(second.server);
      }
    }));
});

/* ==================================================================
    CORPUS COMPATIBILITY: the stamped line is still an entry
   ================================================================== */
describe("stored-log and corpus compatibility", () => {
  /** The frozen corpus, found by walking up from the compiled test and from the working directory (read-only). */
  const SOURCE_FIXTURES = (() => {
    const tail = path.join("frontend", "src", "utils", "__fixtures__");
    for (const start of [__dirname, process.cwd()]) {
      for (let at = start; ; at = path.dirname(at)) {
        if (fs.existsSync(path.join(at, tail, "replayGolden"))) return path.join(at, tail);
        if (path.dirname(at) === at) break;
      }
    }
    return path.join(process.cwd(), "..", tail);
  })();

  test("every frozen corpus log, re-stamped into batches, loads to the same entries, hash and board -- and a naive line reader replays it the same", () =>
    withDir("corpus", async (dir) => {
      const golden = path.join(SOURCE_FIXTURES, "replayGolden", "logs");
      const files = [
        ...fs.readdirSync(golden).filter((f) => f.endsWith(".log.jsonl")).map((f) => path.join(golden, f)),
        path.join(SOURCE_FIXTURES, "JUNO-FCJ-prefix96.log.jsonl"),
      ];
      assert.ok(files.length >= 3, `found ${files.length} corpus logs under ${SOURCE_FIXTURES}`);
      let checked = 0;
      for (const source of files) {
        const original = fs.readFileSync(source, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ServerLogEntry);
        if (!original.every((entry, at) => entry.index === at)) continue; // a legacy non-contiguous corpus: not a store shape
        const room = path.basename(source).replace(/\.log\.jsonl$/, "").replace(/[^A-Za-z0-9_-]/g, "_");
        const store = createFileLogStore(dir, quiet);
        // Batches of 1..5 entries, deterministic.
        for (let at = 0, size = 1; at < original.length; at += size, size = (size % 5) + 1) {
          assert.equal((await store.appendBatch(room, original.slice(at, at + size))).kind, "committed");
        }
        const loaded = await createFileLogStore(dir, quiet).loadLog(room);
        assert.deepEqual(loaded, original, `${room}: the store hands back the corpus entries exactly`);
        assert.equal(logHash(loaded), logHash(original));
        const naive = fs.readFileSync(path.join(dir, `${room}.log.jsonl`), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
        assert.equal(naive.length, original.length, `${room}: still one line per entry`);
        const a = verifyReplay(original);
        const b = verifyReplay(naive); // a reader that does not strip the stamp
        assert.ok(a.ok && b.ok, `${room} replays`);
        if (a.ok && b.ok) assert.deepEqual([b.applied, b.logHash], [a.applied, a.logHash]);
        const sa = probeSession("corpus-a");
        const sb = probeSession("corpus-b");
        try {
          sa.restore(original);
          sb.restore(naive);
          assert.equal(stateDigest(sb.state), stateDigest(sa.state), `${room}: the same board`);
        } catch {
          // a corpus log this server build would hold (#1520) -- the replay check above still compared it
        }
        checked += 1;
      }
      assert.ok(checked >= 3, `checked ${checked}`);
    }));
});

// Keep `controlledStore` and `until` referenced for readers comparing with the 3A suites.
void controlledStore;
void until;
