// server/src/identity/fileStore.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §14): THE INTERIM FILE ADAPTER FOR IDENTITY
// ==================================================================
//
// One small document, `identity.json` in the data directory, rewritten whole on every change by LIVE-3B's
// replacement protocol (§8.7): a unique temporary opened `wx`, every byte written, `fsync`, close, rename over the
// target, `fsync` the directory. Serialized, so two changes never interleave. It lives under the data directory
// the server already LOCKS (LIVE-3B §8.8), and it asks the lock before every write, so a fenced process writes
// nothing.
//
// FAILURES SURFACE (LIVE-2B §1). Before the rename nothing changed: `StoreDefiniteError`, and the caller refuses
// what it was doing. At or after the rename the outcome is unknown: the SAME bytes are written again once (the
// replacement is idempotent); if that also fails the store holds itself -- every later commit refuses -- and asks
// for a restart, whose load reads what the disk really holds. There is no quiet save anywhere in this file.
//
// A RESTART DURING A SAVE leaves either the old file or the new one (the rename is atomic), never half of each; a
// stray temporary is ignored by the load. A file that is not exactly the format below refuses to load: identity is
// never guessed at.
//
// ONLY ACTIVATED PRINCIPALS AND THEIR SESSIONS ARE EVER HERE, AND NEVER A SECRET -- `secret_hash` is SHA-256 of it.
// Nothing in this file prints a record.

import { randomBytes } from "crypto";
import * as path from "path";

import { nodeStoreFs, type StoreFileHandle, type StoreFs } from "../fileLogStore";
import { StoreDefiniteError, StoreUncertainError } from "../persistence/storeResult";
import { applyChange, checkSnapshot, IdentityStoreCorruptError, type IdentityChange, type IdentitySnapshot, type IdentityStore } from "./store";

export const IDENTITY_FILE = "identity.json";
const FORMAT = "gs-identity";
const VERSION = 1;

export interface FileIdentityStoreOptions {
  fs?: StoreFs;
  /** `process.platform` when absent; directory sync is skipped on win32, as in `fileLogStore.ts`. */
  platform?: string;
  /** Consulted before every write: false means another process owns the data directory now. */
  writerCheck?: () => Promise<boolean>;
  /** An uncertain write the redo could not settle: the process must restart (LIVE-3 §8.2 step 7). */
  onRestartRequired?: (detail: string) => void;
  warn?: (line: string) => void;
}

export interface FileIdentityStore extends IdentityStore {
  readonly file: string;
  readonly stats: { commits: number; redone: number; definite: number; uncertain: number };
}

type Attempt = { kind: "committed" } | { kind: "definite" | "uncertain"; detail: string };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null ? ((error as { code?: unknown }).code as string | undefined) : undefined;
const DIR_SYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EBADF"]);

export function createFileIdentityStore(directory: string, options: FileIdentityStoreOptions = {}): FileIdentityStore {
  const io = options.fs ?? nodeStoreFs;
  const platform = options.platform ?? process.platform;
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const target = path.join(directory, IDENTITY_FILE);
  const stats = { commits: 0, redone: 0, definite: 0, uncertain: 0 };
  /** What the file holds: set by the load, and by each committed write. `null` until loaded. */
  let current: IdentitySnapshot | null = null;
  let poisoned: string | null = null;
  let temporaries = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  async function writeFully(handle: StoreFileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!(bytesWritten > 0)) throw new Error(`a write of ${bytes.length - offset} bytes wrote nothing`);
      offset += bytesWritten;
    }
  }

  async function syncDirectory(): Promise<void> {
    if (platform === "win32") return;
    let handle: StoreFileHandle;
    try {
      handle = await io.open(directory, "r");
    } catch (error) {
      if (DIR_SYNC_UNSUPPORTED.has(codeOf(error) ?? "")) return;
      throw error;
    }
    try {
      await handle.sync();
    } catch (error) {
      if (!DIR_SYNC_UNSUPPORTED.has(codeOf(error) ?? "")) throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function replaceOnce(bytes: Uint8Array, redo: boolean): Promise<Attempt> {
    temporaries += 1;
    /* A random part too: after a crash, a restarted process may carry the same pid (containers). */
    const temporary = `${target}.${process.pid}.${temporaries}.${randomBytes(4).toString("hex")}.tmp`;
    let handle: StoreFileHandle | null = null;
    try {
      handle = await io.open(temporary, "wx");
      await writeFully(handle, bytes);
      await handle.sync();
      const closing = handle;
      handle = null;
      await closing.close();
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      await io.unlink(temporary).catch(() => undefined);
      const detail = `could not write ${path.basename(temporary)}: ${describe(error)}`;
      return { kind: redo ? "uncertain" : "definite", detail };
    }
    try {
      await io.rename(temporary, target);
    } catch (error) {
      await io.unlink(temporary).catch(() => undefined);
      return { kind: "uncertain", detail: `renaming the identity file into place: ${describe(error)}` };
    }
    try {
      await syncDirectory();
    } catch (error) {
      return { kind: "uncertain", detail: `syncing the directory after renaming the identity file: ${describe(error)}` };
    }
    return { kind: "committed" };
  }

  const load = (): Promise<IdentitySnapshot> =>
    serial(async () => {
      await io.mkdir(directory);
      let raw: Buffer;
      try {
        raw = await io.readFile(target);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error;
        current = { principals: [], sessions: [] };
        return { principals: [], sessions: [] };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new IdentityStoreCorruptError(`${target}: not JSON`);
      }
      const document = parsed as { format?: unknown; version?: unknown; principals?: unknown; sessions?: unknown };
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "format,principals,sessions,version" ||
        document.format !== FORMAT ||
        document.version !== VERSION
      ) {
        throw new IdentityStoreCorruptError(`${target}: not a ${FORMAT} v${VERSION} document`);
      }
      current = checkSnapshot({ principals: document.principals, sessions: document.sessions }, target);
      return JSON.parse(JSON.stringify(current)) as IdentitySnapshot;
    });

  const commit = (change: IdentityChange): Promise<void> =>
    serial(async () => {
      if (current === null) throw new StoreDefiniteError("the identity store has not been loaded; nothing was written");
      if (poisoned !== null) {
        throw new StoreDefiniteError(`the identity store is held after an unresolved write (${poisoned}); nothing was written`);
      }
      if (options.writerCheck && !(await options.writerCheck().catch(() => false))) {
        stats.definite += 1;
        throw new StoreDefiniteError("this server no longer owns the data directory (its lock was taken over); nothing was written");
      }
      const next = checkSnapshot(applyChange(current, change), "identity commit");
      const bytes = Buffer.from(
        `${JSON.stringify({ format: FORMAT, version: VERSION, principals: next.principals, sessions: next.sessions })}\n`,
        "utf8",
      );
      const first = await replaceOnce(bytes, false);
      if (first.kind === "committed") {
        current = next;
        stats.commits += 1;
        return;
      }
      if (first.kind === "definite") {
        stats.definite += 1;
        throw new StoreDefiniteError(first.detail);
      }
      warn(`  identity store: ${first.detail}; redoing the replacement (LIVE-3 §8.7)`);
      const redo = await replaceOnce(bytes, true);
      if (redo.kind === "committed") {
        current = next;
        stats.commits += 1;
        stats.redone += 1;
        return;
      }
      const detail = `${first.detail}; the redo failed too: ${(redo as { detail: string }).detail}`;
      poisoned = detail;
      stats.uncertain += 1;
      options.onRestartRequired?.(detail);
      throw new StoreUncertainError(detail);
    });

  return { file: target, stats, load, commit };
}
