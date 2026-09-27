// server/src/fileLogStore.ts
//
// A room's history on disk: one file per room, one line per entry, written positionally and synced before
// anybody is told.
//
// ==================================================================
//  DESIGN NOTE 1250: THE APPEND IS THE COMMIT POINT, SO THE APPEND HAS TO REACH A DISK
// ==================================================================
//
// #1209 made the append the commit point and the response news: "a move whose answer was lost has still
// happened." That was true of memory. `start.ts` said in as many words that "a restart starts an empty room",
// and the audit (§7, triage 3.3a) named it: "a restart erases a money game ... or 'the append is the commit
// point' is a claim about memory." This is the store that makes it a claim about a file.
//
// ONE FILE PER ROOM, ONE LINE PER ENTRY. JSON Lines rather than a rewritten document, because the log is
// append-only by construction (#1026, #1233: a revert is an entry, not an erasure) and a store that rewrote the
// whole history on every move would have a window in which the file held half a game. The server awaits the
// write BEFORE it answers the submitter and before it fans out (#1250, LIVE-3A's actor), so no client ever
// applies an entry the disk does not have.
//
// THE ROOM DOCUMENT GOES IN A SIDECAR, REWRITTEN WHOLE. It is last-write-wins and never replayed (#1215), so a
// rewrite is its natural shape; and without it a restart would restore a game whose roster nobody could name.
//
// NOT FIRESTORE, AND DELIBERATELY SO. A directory on the machine the server runs on is reachable by definition,
// survives a restart, and is what the operator can `cat`. DynamoDB is LIVE-5's, behind the same seam.
//
// ==================================================================
//  LIVE-3B (LIVE-3 §8): CRASH-CONSISTENT, NOT MERELY SYNCED
// ==================================================================
//
// #1250's store opened the file `O_APPEND`, wrote once, synced once and called it done. LIVE-3 found five ways
// that is not enough, and this store closes each of them:
//
//   F-8   A torn tail was skipped on load and the next append landed BEHIND it (O_APPEND), so every later
//         acknowledged entry was unreadable. Now: writes are POSITIONAL at `committedEnd` -- the byte just past the
//         last complete durable batch -- never appends; the load (logFormat.ts `scanLog`) truncates a damaged
//         in-flight batch and HOLDS the room, untouched, when damage is not confined to it.
//   F-9   A new file's directory entry was never synced, and the room document was renamed from an unsynced
//         temporary. Now: the directory is synced after a file is created and after every rename (POSIX; see
//         WINDOWS below), and the room document follows §8.7 -- unique temporary, write, sync, rename, sync.
//   F-15  An `fsync` failure let the next batch be written behind whatever the kernel kept. Now: an error after a
//         byte may have reached storage is UNCERTAIN, resolved by REDOING the exact batch at `committedEnd` and
//         syncing again -- never by re-reading, because after a failed `fsync` the page cache can show a batch the
//         disk does not hold (the fsyncgate behaviour). If the redo fails, the game is held and the process must
//         restart; nothing is ever written behind unresolved bytes.
//   F-16  A short write was acknowledged (`bytesWritten` ignored). Now: every write loops until every byte is
//         written; a zero-byte write or an error part-way is uncertain; `ftruncate` only ever SHRINKS the file (to
//         cut stray bytes an earlier attempt left), because extending would leave a hole that reads back as zeros.
//   F-12  Two servers could share one directory. Now: `persistence/processLock.ts`, consulted before every write.
//
// EVERY OPERATION ON ONE FILE RUNS IN ORDER (a per-file chain), so a load's repair can never interleave with an
// append, and a call the actor gave up waiting for (E-11) still finishes before the next one on that file starts.
//
// WINDOWS: Node cannot open a directory handle to sync it there. A process crash loses nothing (NTFS metadata
// survives process death); a POWER LOSS shortly after a room's log or document is first created or renamed could
// lose that directory entry. Accepted for the development store (LIVE-3 §8.7); POSIX behaviour is not weakened to
// match.
//
// WHAT THIS DOES NOT DO: it does not make the file tamper-evident (that is 2.5f's hash), does not sign anything
// (2.5b), does not replicate, and cannot tell silent bit rot in the LAST acknowledged batch from a torn write
// (LIVE-3 §8.6: that batch would be truncated; the `ahead` tripwire counts the clients that held it).

import { promises as fs } from "fs";
import * as path from "path";

import type { ServerLogEntry } from "../../frontend/src/utils/roomSession";
import type { RoomChatEntry } from "../../frontend/src/utils/roomProtocol";
import { parseEntryLine, scanLog, serializeBatch } from "./persistence/logFormat";
import {
  COMMITTED,
  StoreCorruptError,
  StoreUncertainError,
  throwUnlessCommitted,
  type StoreWriteOutcome,
} from "./persistence/storeResult";

export interface LogStore {
  /** Everything durable for this room, in index order, store metadata stripped. Empty for a room never written.
   *  LIVE-3B: rejects with `StoreCorruptError` when the file holds damage that is not a torn final batch. */
  loadLog(room: string): Promise<readonly ServerLogEntry[]>;
  /** The legacy throwing form: resolves only once the entries are durable; rejects `StoreDefiniteError` when
   *  nothing was written and anything else when the outcome is unknown. */
  appendLog(room: string, entries: readonly ServerLogEntry[]): Promise<void>;
  /** LIVE-3B: one batch with a classified outcome (storeResult.ts). Never rejects. Preferred when present. */
  appendBatch?(room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome>;
  /* ==================================================================
      DESIGN NOTE 1361: THE TRANSCRIPT, ON THE SAME DISK
     ==================================================================
     Chat left Firestore for the server (#1361a). One append-only sidecar per game, the log's shape
     (`<game_id>.chat.jsonl`), unsynced: a lost chat line is not a lost move (LIVE-3 §9.5 keeps it so). Optional on
     the interface, because the in-memory store the tests and the smoke run use has no reason to keep one.
     LIVE-2D: the legacy room document (`<code>.room.json`) and the staging lobby (`lobby.json`) are gone from this
     store with the protocol that wrote them; a game's roster is its GameRecord (`rooms/recordStore.ts`). Old files of
     either kind are left on disk untouched and never read. */
  loadChat?(room: string): Promise<readonly RoomChatEntry[]>;
  appendChat?(room: string, entry: RoomChatEntry): Promise<void>;
  /** LIVE-3C (discovery): every server-owned game (`g_…`) with a log file -- names only, nothing read. */
  listGameLogs?(): Promise<string[]>;
  /** LIVE-3C (discovery): READ-ONLY, the log's size and its first line -- the deal of a server-owned game -- without
   *  scanning, repairing or holding the file. `first` is `null` for an empty file and `undefined` when the first line
   *  is not a whole entry (a torn deal batch is the load's to repair; only the full scan tells it from damage). */
  readHead?(room: string): Promise<LogHeadRead>;
}

export interface LogHeadRead {
  readonly present: boolean;
  readonly size: number;
  readonly first: ServerLogEntry | null | undefined;
}

/* ==================================================================
    THE FILE SEAM: Node's own, or one a test drives
   ==================================================================
   The durability protocol is only testable if a test can make `write` return short, `fsync` fail with the bytes
   still readable, or the disk fill part-way (FI-22, FI-23). So the store reaches the file system through this
   narrow adapter; `nodeStoreFs` is Node's `fs.promises`, unchanged. */
export interface StoreFileHandle {
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  stat(): Promise<{ size: number }>;
  truncate(length: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface StoreFs {
  open(file: string, flags: "r" | "r+" | "wx"): Promise<StoreFileHandle>;
  readFile(file: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
  readdir(directory: string): Promise<string[]>;
  appendFile(file: string, text: string): Promise<void>;
}

export const nodeStoreFs: StoreFs = {
  open: (file, flags) => fs.open(file, flags),
  readFile: (file) => fs.readFile(file),
  rename: (from, to) => fs.rename(from, to),
  unlink: (file) => fs.unlink(file),
  mkdir: async (directory) => {
    await fs.mkdir(directory, { recursive: true });
  },
  readdir: (directory) => fs.readdir(directory),
  appendFile: (file, text) => fs.appendFile(file, text, "utf8"),
};

export interface FileLogStoreOptions {
  /** The file system. Node's when absent; a test passes an adapter that injects faults. */
  fs?: StoreFs;
  /** `process.platform` when absent. Directory sync is skipped on `win32` (see WINDOWS above). */
  platform?: string;
  warn?: (line: string) => void;
  /** Called once per room when an uncertain write could not be resolved by its redo: the room is held and the
   *  process must restart (LIVE-3 §8.2 step 7). `start.ts` wires this to a fail-fast exit. */
  onRestartRequired?: (room: string, detail: string) => void;
  /** Consulted before every write: false means this process no longer owns the data directory (the lock was
   *  taken over), so nothing is written (LIVE-3 §8.8 self-check). */
  writerCheck?: () => Promise<boolean>;
}

/** What the store did, for tests, the smoke run and the window. LIVE-3C turns these into §18's metrics. */
export interface FileLogStoreStats {
  appends: number;
  shortWrites: number;
  redone: number;
  uncertain: number;
  definite: number;
  tornTailsRepaired: number;
  tornBytesRepaired: number;
  corruptHeld: number;
  loadSyncs: number;
  dirSyncs: number;
  dirSyncSkipped: number;
  docReplaced: number;
}

export interface FileLogStore extends LogStore {
  appendBatch(room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome>;
  readonly stats: Readonly<FileLogStoreStats>;
  readonly directory: string;
}

/** A room code becomes a file name. Codes are `JUNO-XXX` in practice; anything else is reduced to a safe
 *  character set so a code cannot name a path outside the directory. */
function safeName(room: string): string {
  const cleaned = room.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned === "" ? "_" : cleaned;
}

/** Per open log: where the durable prefix ends, and whether the file may be written at all. */
interface LogState {
  exists: boolean;
  /** The byte just past the last complete durable batch. Every write lands exactly here. */
  committedEnd: number;
  /** The index the next batch must begin at. */
  nextIndex: number;
  /** A file created by this store whose directory entry has not yet been synced. */
  dirSyncPending: boolean;
  /** Set when an uncertain write's redo failed: nothing more is written or read until a restart. */
  poisoned: string | null;
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** A directory that cannot be opened or synced on this platform or file system: best effort, not a failure. */
const DIR_SYNC_UNSUPPORTED = new Set(["EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM", "EACCES", "ENOSYS"]);

export function createFileLogStore(directory: string, options: FileLogStoreOptions = {}): FileLogStore {
  const io = options.fs ?? nodeStoreFs;
  const platform = options.platform ?? process.platform;
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const logPath = (room: string) => path.join(directory, `${safeName(room)}.log.jsonl`);
  const chatPath = (room: string) => path.join(directory, `${safeName(room)}.chat.jsonl`);
  const stats: FileLogStoreStats = {
    appends: 0,
    shortWrites: 0,
    redone: 0,
    uncertain: 0,
    definite: 0,
    tornTailsRepaired: 0,
    tornBytesRepaired: 0,
    corruptHeld: 0,
    loadSyncs: 0,
    dirSyncs: 0,
    dirSyncSkipped: 0,
    docReplaced: 0,
  };
  const states = new Map<string, LogState>();
  let dirSyncNoted = false;

  const ready = io.mkdir(directory);

  /* ONE FILE, ONE LINE OF WORK. Each call on a path starts only after the previous call on it has settled. */
  const chains = new Map<string, Promise<void>>();
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  const definite = (detail: string): StoreWriteOutcome => {
    stats.definite += 1;
    return { kind: "definite", detail };
  };

  const restartRequired = (room: string, detail: string) => {
    warn(
      `  STORE HELD (uncertain): ${detail}. Nothing more is written for ${room} and the process must be restarted; ` +
        `the load after the restart reads what the disk really holds (LIVE-3 §8.2 step 7).`,
    );
    try {
      options.onRestartRequired?.(room, detail);
    } catch (error) {
      warn(`  store: the restart hook threw — ${describe(error)}`);
    }
  };

  /** Sync a directory so a created or renamed entry in it survives power loss. `false` when this platform or file
   *  system cannot (Windows, some mounts): best effort, noted once. Throws on a real failure. */
  async function syncDirectory(dir: string): Promise<boolean> {
    const skip = (why: string) => {
      stats.dirSyncSkipped += 1;
      if (!dirSyncNoted) {
        dirSyncNoted = true;
        warn(`  store: directory sync is not available here (${why}); a power loss right after a room file is created or renamed could lose that entry (LIVE-3 §8.7 residual)`);
      }
      return false;
    };
    if (platform === "win32") return skip("Windows");
    let handle: StoreFileHandle;
    try {
      handle = await io.open(dir, "r");
    } catch (error) {
      if (DIR_SYNC_UNSUPPORTED.has(codeOf(error) ?? "")) return skip(codeOf(error) as string);
      throw error;
    }
    try {
      await handle.sync();
      stats.dirSyncs += 1;
      return true;
    } catch (error) {
      if (DIR_SYNC_UNSUPPORTED.has(codeOf(error) ?? "")) return skip(codeOf(error) as string);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Write `bytes` at `position` until every byte is written. A short write continues; a zero write throws. */
  async function writeFully(handle: StoreFileHandle, bytes: Uint8Array, position: number): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
      if (!(bytesWritten > 0)) {
        throw new Error(`a write returned ${bytesWritten} bytes with ${bytes.length - offset} still to write at byte ${position + offset}`);
      }
      if (bytesWritten < bytes.length - offset) stats.shortWrites += 1;
      offset += bytesWritten;
    }
  }

  /* ---------------------------------------------------------------------------
      THE LOAD (§8.3): validate, truncate only a torn in-flight batch, sync before serving
     --------------------------------------------------------------------------- */

  async function validatedLoad(room: string): Promise<ServerLogEntry[]> {
    await ready;
    const file = logPath(room);
    const known = states.get(room);
    if (known?.poisoned) {
      throw new StoreUncertainError(`${file} is held after an unresolved write (${known.poisoned}); restart the server`);
    }
    let bytes: Buffer;
    try {
      bytes = await io.readFile(file);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      if (known?.exists) throw new StoreCorruptError(`${file} disappeared while the server was using it`, file, 0);
      states.set(room, { exists: false, committedEnd: 0, nextIndex: 0, dirSyncPending: false, poisoned: null });
      return [];
    }
    const scan = scanLog(bytes);
    if (scan.classification === "corrupt") {
      stats.corruptHeld += 1;
      states.delete(room);
      warn(
        `  STORE CORRUPT: ${file} -- ${scan.detail}. Evidence at byte ${scan.evidenceAt}. The file is left exactly ` +
          `as found and the room is HELD; stop the server and run tools/logDoctor on it (LIVE-3 §8.5).`,
      );
      throw new StoreCorruptError(`${file}: ${scan.detail}`, file, scan.damageAt ?? 0);
    }
    if (known?.exists && (scan.classification !== "clean" || scan.end !== known.committedEnd)) {
      /* A file this process has been writing no longer ends where its last durable batch ended: something outside
         the protocol touched it. Never repaired from here. */
      states.delete(room);
      stats.corruptHeld += 1;
      throw new StoreCorruptError(
        `${file} changed under the server: it ends at byte ${scan.end} (${scan.classification}), the last durable batch ended at ${known.committedEnd}`,
        file,
        scan.end,
      );
    }
    /* LIVE-3C (review E9): the repair is a WRITE, and only the lock's owner writes. A process whose lock was taken over
       leaves the file exactly as it is -- the new owner may be appending to it right now -- and the load fails
       ("unavailable"); the owner's own load repairs it. */
    if (scan.classification === "torn-tail" && options.writerCheck && !(await options.writerCheck().catch(() => false))) {
      throw new Error(`${file} has a torn final batch, and this server no longer owns the data directory (its lock was taken over); it is left exactly as found`);
    }
    const handle = await io.open(file, "r+");
    try {
      if (scan.classification === "torn-tail") {
        await handle.truncate(scan.end); // only ever DOWN, to the end of the last complete batch
        stats.tornTailsRepaired += 1;
        stats.tornBytesRepaired += scan.size - scan.end;
        warn(
          `  store.torn_tail_repaired ${room}: truncated ${scan.size - scan.end} bytes at byte ${scan.end} ` +
            `(${scan.detail}); ${scan.entries.length} entries stand`,
        );
      }
      /* SYNCED BEFORE IT IS SERVED, repaired or not: what the room serves from now on is on the disk. */
      await handle.sync();
      stats.loadSyncs += 1;
    } finally {
      await handle.close().catch(() => undefined);
    }
    states.set(room, {
      exists: true,
      committedEnd: scan.end,
      nextIndex: scan.entries.length,
      dirSyncPending: false,
      poisoned: null,
    });
    return scan.entries;
  }

  /* ---------------------------------------------------------------------------
      THE WRITE (§8.2): positional at committedEnd, every byte, shrink-only, sync, directory on create
     --------------------------------------------------------------------------- */

  /** One attempt. `redo` says an earlier attempt of the same batch may have written: then even an open failure is
   *  uncertain, because the earlier bytes may be on disk. */
  async function attemptBatch(room: string, state: LogState, bytes: Uint8Array, redo: boolean): Promise<StoreWriteOutcome> {
    const file = logPath(room);
    let handle: StoreFileHandle | null = null;
    try {
      if (!state.exists) {
        try {
          handle = await io.open(file, "wx");
          state.dirSyncPending = true;
        } catch (error) {
          if (codeOf(error) !== "EEXIST") throw error;
          handle = await io.open(file, "r+");
        }
        state.exists = true;
      } else {
        handle = await io.open(file, "r+");
      }
    } catch (error) {
      const detail = `could not open ${file}: ${describe(error)}`;
      return redo ? { kind: "uncertain", detail } : definite(detail);
    }
    /* FROM THE FIRST WRITE ON, A FAILURE IS UNCERTAIN: some of these bytes may be on the disk. */
    try {
      await writeFully(handle, bytes, state.committedEnd);
      const intended = state.committedEnd + bytes.length;
      const { size } = await handle.stat();
      if (size > intended) await handle.truncate(intended); // stray bytes from an earlier attempt: cut, never grow
      else if (size < intended) throw new Error(`${file} is ${size} bytes after writing through byte ${intended}`);
      await handle.sync();
      if (state.dirSyncPending) {
        await syncDirectory(directory);
        state.dirSyncPending = false;
      }
      const closing = handle;
      handle = null;
      await closing.close();
      return COMMITTED;
    } catch (error) {
      return { kind: "uncertain", detail: `writing ${bytes.length} bytes at byte ${state.committedEnd} of ${file}: ${describe(error)}` };
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
    }
  }

  async function appendBatch(room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome> {
    if (entries.length === 0) return COMMITTED;
    /* Entered into the file's chain SYNCHRONOUSLY, so calls on one file run in the order they were made. */
    return serial(logPath(room), async () => {
      try {
        await ready;
      } catch (error) {
        return definite(`the data directory ${directory} is not usable: ${describe(error)}`);
      }
      stats.appends += 1;
      if (options.writerCheck && !(await options.writerCheck().catch(() => false))) {
        return definite("this server no longer owns the data directory (its lock was taken over); nothing was written");
      }
      let state = states.get(room);
      if (state === undefined) {
        try {
          await validatedLoad(room);
        } catch (error) {
          return definite(`could not open the log for ${room}: ${describe(error)}`);
        }
        state = states.get(room) as LogState;
      }
      if (state.poisoned) return definite(`${room} is held after an unresolved write (${state.poisoned}); nothing was written`);
      if (entries[0].index !== state.nextIndex) {
        return definite(`the batch begins at index ${entries[0].index} but ${room}'s log continues at ${state.nextIndex}; nothing was written`);
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(serializeBatch(entries), "utf8");
      } catch (error) {
        return definite(`the batch could not be serialized: ${describe(error)}`);
      }

      const first = await attemptBatch(room, state, bytes, false);
      if (first.kind !== "uncertain") {
        if (first.kind === "committed") {
          state.committedEnd += bytes.length;
          state.nextIndex += entries.length;
        }
        return first;
      }
      /* UNCERTAIN: the attempt has settled (every await above returned and its handle is closed). REDO it -- the
         same bytes at the same offset, stray bytes cut, synced again. The client has been told nothing, so the
         batch may simply be MADE durable rather than discovered to be. Never a re-read. */
      warn(`  store: ${first.detail}; redoing the batch at byte ${state.committedEnd} (LIVE-3 §8.2 step 7)`);
      const redo = await attemptBatch(room, state, bytes, true);
      if (redo.kind === "committed") {
        stats.redone += 1;
        state.committedEnd += bytes.length;
        state.nextIndex += entries.length;
        return { kind: "committed", redone: true };
      }
      const detail = `${first.detail}; the redo failed too: ${(redo as { detail: string }).detail}`;
      state.poisoned = detail;
      stats.uncertain += 1;
      restartRequired(room, detail);
      return { kind: "uncertain", detail };
    });
  }

  return {
    directory,
    stats,

    loadLog(room) {
      return serial(logPath(room), () => validatedLoad(room));
    },

    appendBatch,

    async appendLog(room, entries) {
      throwUnlessCommitted(await appendBatch(room, entries));
    },

    async loadChat(room) {
      await ready;
      let text: string;
      try {
        text = (await io.readFile(chatPath(room))).toString("utf8");
      } catch (error) {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      }
      const entries: RoomChatEntry[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          entries.push(JSON.parse(line) as RoomChatEntry);
        } catch {
          break; // a partial last line: chat is lossy by design (LIVE-3 §9.5)
        }
      }
      return entries;
    },

    async appendChat(room, entry) {
      await ready;
      /* LIVE-3C (review E3): chat is a write too -- refused once the lock is lost. */
      if (options.writerCheck && !(await options.writerCheck().catch(() => false))) {
        throw new Error("this server no longer owns the data directory (its lock was taken over); the chat line was not written");
      }
      await io.appendFile(chatPath(room), `${JSON.stringify(entry)}\n`);
    },

    async listGameLogs() {
      await ready;
      const suffix = ".log.jsonl";
      return (await io.readdir(directory))
        .filter((name) => name.endsWith(suffix) && /^g_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]$/.test(name.slice(0, -suffix.length)))
        .map((name) => name.slice(0, -suffix.length));
    },

    /* LIVE-3C: a bounded, read-only look at the deal. Through Node's own `fs`, never the fault seam: it writes nothing,
       and it runs before any game is loaded (discovery), so no append can be in flight on the file. */
    async readHead(room) {
      await ready;
      let handle: import("fs").promises.FileHandle;
      try {
        handle = await fs.open(logPath(room), "r");
      } catch (error) {
        if (codeOf(error) === "ENOENT") return { present: false, size: 0, first: null };
        throw error;
      }
      try {
        const { size } = await handle.stat();
        if (size === 0) return { present: true, size, first: null };
        const limit = Math.min(size, HEAD_BYTES);
        const buffer = Buffer.alloc(limit);
        let read = 0;
        while (read < limit) {
          const { bytesRead } = await handle.read(buffer, read, limit - read, read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        const newline = buffer.subarray(0, read).indexOf(0x0a);
        if (newline === -1) return { present: true, size, first: undefined };
        const parsed = parseEntryLine(buffer.subarray(0, newline).toString("utf8"));
        return { present: true, size, first: parsed === null ? undefined : parsed.entry };
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  };
}

/** The most discovery reads of a log to find its first line (a deal is far smaller: frames are capped at 32 KiB). */
const HEAD_BYTES = 64 * 1024;
