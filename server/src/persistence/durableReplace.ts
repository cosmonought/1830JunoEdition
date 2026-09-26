// server/src/persistence/durableReplace.ts
//
// LIVE-2C: LIVE-3B's whole-file replacement protocol (§8.7) as one reusable step, for the game records and the
// join-code index: a unique temporary opened `wx`, every byte written, fsync, close, rename over the target, fsync
// the directory. Before the rename a failure is DEFINITE (the target is untouched). At or after it the outcome is
// UNKNOWN, and the same bytes are written once more (the replacement is idempotent); if that also fails the caller
// holds the file and asks for a restart. Nothing here swallows a failure: every outcome is returned, classified.

import { randomBytes } from "crypto";
import * as path from "path";

import type { StoreFileHandle, StoreFs } from "../fileLogStore";
import type { StoreWriteOutcome } from "./storeResult";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null ? ((error as { code?: unknown }).code as string | undefined) : undefined;
const DIR_SYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EBADF"]);

async function writeFully(handle: StoreFileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (!(bytesWritten > 0)) throw new Error(`a write of ${bytes.length - offset} bytes wrote nothing`);
    offset += bytesWritten;
  }
}

async function syncDirectory(io: StoreFs, directory: string, platform: string): Promise<void> {
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

async function replaceOnce(io: StoreFs, target: string, bytes: Uint8Array, redo: boolean, platform: string): Promise<StoreWriteOutcome> {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
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
    return redo ? { kind: "uncertain", detail } : { kind: "definite", detail };
  }
  try {
    await io.rename(temporary, target);
  } catch (error) {
    await io.unlink(temporary).catch(() => undefined);
    return { kind: "uncertain", detail: `renaming ${path.basename(target)} into place: ${describe(error)}` };
  }
  try {
    await syncDirectory(io, path.dirname(target), platform);
  } catch (error) {
    return { kind: "uncertain", detail: `syncing the directory after renaming ${path.basename(target)}: ${describe(error)}` };
  }
  return { kind: "committed", redone: redo };
}

/** Replace `target` with `bytes`, durably: committed (maybe after one redo), definite, or uncertain. */
export async function durableReplace(
  io: StoreFs,
  target: string,
  bytes: Uint8Array,
  options: { platform?: string; warn?: (line: string) => void } = {},
): Promise<StoreWriteOutcome> {
  const platform = options.platform ?? process.platform;
  const first = await replaceOnce(io, target, bytes, false, platform);
  if (first.kind !== "uncertain") return first;
  options.warn?.(`  store: ${first.detail}; redoing the replacement of ${path.basename(target)} (LIVE-3 §8.7)`);
  const redo = await replaceOnce(io, target, bytes, true, platform);
  if (redo.kind === "committed") return { kind: "committed", redone: true };
  return { kind: "uncertain", detail: `${first.detail}; the redo failed too: ${(redo as { detail: string }).detail}` };
}
