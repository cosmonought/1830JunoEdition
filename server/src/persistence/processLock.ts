// server/src/persistence/processLock.ts
//
// LIVE-3B: at most one game server writes a data directory (LIVE-3 §8.8, F-12).
//
// ==================================================================
//  A LOCK DIRECTORY WITH A HEARTBEAT, AND A TAKEOVER THAT ONLY ONE RACER CAN WIN
// ==================================================================
//
// Two servers on one `data/` fork every log they both write (LIVE-3 P5's zombie runs). The obvious fix -- an
// `O_EXCL` lock file holding a PID, taken over when that PID looks dead -- has two holes: "check the PID, then
// overwrite the file" is not atomic, so two restarting servers can both take over; and a PID the operating system
// has reused makes a dead owner look alive (or a live one look dead on another host). So:
//
//   ACQUIRE   `mkdir <data>/LOCK` -- atomic on every platform; `EEXIST` means someone holds it. The winner writes
//             `LOCK/owner.json` = {instance_id, pid, host, started_at} and touches `LOCK/heartbeat` every 5 s.
//   HELD      a lock whose newest sign of life (heartbeat, owner.json or the directory itself) is younger than
//             30 s belongs to a live server: refuse (the server exits 2).
//   STALE     older than that: take it over by RENAMING the whole directory aside, then `mkdir` again. The
//             aside-name is derived from the stale owner's identity, so every racer who judged the same lock stale
//             renames onto the SAME name -- only the first can succeed; a later one either finds no `LOCK` to move
//             (ENOENT) or finds the aside-name already taken by a non-empty directory (the loser's rename fails).
//             The winner marks the aside directory before it re-creates `LOCK`, so a racer that still believes the
//             old lock is stale can never rename the winner's fresh lock onto an empty aside directory. A loser goes
//             round again, meets the winner's fresh lock, and refuses. Liveness is the heartbeat's age, NEVER the
//             PID: the PID and host are printed as supporting evidence and never decide anything.
//   SELF-CHECK before every commit batch (the store asks) and every 5 s, the holder reads `LOCK/owner.json`; if it
//             no longer names this instance, the lock was taken over -- this process is fenced and must stop
//             writing at once (the server exits 3, LIVE-3 §16).
//   RELEASE   on a clean shutdown: remove `LOCK`, but only while it is still ours.
//
// AWS writer epochs are LIVE-5's; this is the local store's whole fence.

import { promises as fs, rmSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

export const LOCK_DIRECTORY = "LOCK";
export const LOCK_STALE_AFTER_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 5_000;

export interface LockOwner {
  readonly instance_id: string;
  readonly pid: number;
  readonly host: string;
  readonly started_at: number;
}

export interface DataLockOptions {
  /** This process's identity in the lock. Random (16 bytes, hex) when absent. */
  instanceId?: string;
  staleAfterMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  /** Called once, when a self-check finds the lock is no longer this instance's (taken over, or removed). */
  onLost?: (reason: string) => void;
  log?: (line: string) => void;
}

export interface DataLock {
  readonly instanceId: string;
  readonly directory: string;
  /** True while `LOCK/owner.json` names this instance. False (and `onLost` fired) otherwise. */
  verify(): Promise<boolean>;
  /** Stop the heartbeat and remove the lock if it is still ours. */
  release(): Promise<void>;
  /** The same, synchronously -- for `process.on("exit")`. */
  releaseSync(): void;
}

export type AcquireResult =
  | {
      readonly ok: true;
      readonly lock: DataLock;
      /** Set when a stale lock was taken over: whose, and how old its last sign of life was. */
      readonly tookOver: { readonly previous: LockOwner | null; readonly ageMs: number } | null;
    }
  | { readonly ok: false; readonly reason: string; readonly owner: LockOwner | null; readonly ageMs: number | null };

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8")) as LockOwner;
    return typeof parsed?.instance_id === "string" ? parsed : null;
  } catch {
    return null; // absent or half-written: the owner is identified by the directory's age alone
  }
}

/** A held lock as a contender sees it, or `null` if it vanished while being looked at. */
async function inspect(lockDir: string, now: number): Promise<{ owner: LockOwner | null; ageMs: number; identity: string } | null> {
  const dirTime = await mtimeOf(lockDir);
  if (dirTime === null) return null;
  const owner = await readOwner(lockDir);
  const beats = await Promise.all([mtimeOf(path.join(lockDir, "heartbeat")), mtimeOf(path.join(lockDir, "owner.json"))]);
  const newest = Math.max(dirTime, ...beats.map((time) => time ?? 0));
  const identity = owner?.instance_id ?? `anon-${Math.floor(dirTime)}`;
  return { owner, ageMs: now - newest, identity: identity.replace(/[^A-Za-z0-9_-]/g, "_") };
}

/** For offline tools (`logDoctor`): is a live server holding this data directory right now? */
export async function lockStatus(
  dataDir: string,
  options: { now?: number; staleAfterMs?: number } = {},
): Promise<{ readonly held: boolean; readonly owner: LockOwner | null; readonly ageMs: number | null }> {
  const seen = await inspect(path.join(dataDir, LOCK_DIRECTORY), options.now ?? Date.now());
  if (seen === null) return { held: false, owner: null, ageMs: null };
  return { held: seen.ageMs < (options.staleAfterMs ?? LOCK_STALE_AFTER_MS), owner: seen.owner, ageMs: seen.ageMs };
}

export const describeOwner = (owner: LockOwner | null): string =>
  owner === null
    ? "an owner that never finished writing its owner.json"
    : `instance ${owner.instance_id} (pid ${owner.pid} on ${owner.host}, started ${new Date(owner.started_at).toISOString()})`;

export async function acquireDataLock(dataDir: string, options: DataLockOptions = {}): Promise<AcquireResult> {
  const now = options.now ?? (() => Date.now());
  const staleAfterMs = options.staleAfterMs ?? LOCK_STALE_AFTER_MS;
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const instanceId = options.instanceId ?? randomBytes(16).toString("hex");
  const log = options.log ?? (() => undefined);
  const lockDir = path.join(dataDir, LOCK_DIRECTORY);
  await fs.mkdir(dataDir, { recursive: true });

  let tookOver: { previous: LockOwner | null; ageMs: number } | null = null;
  let asideDir: string | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      const seen = await inspect(lockDir, now());
      if (seen === null) continue; // released or moved while we looked: try again
      if (seen.ageMs < staleAfterMs) {
        return {
          ok: false,
          owner: seen.owner,
          ageMs: seen.ageMs,
          reason:
            `another game server owns this data directory: ${describeOwner(seen.owner)}, last heartbeat ` +
            `${Math.round(seen.ageMs / 1000)} s ago (${lockDir})`,
        };
      }
      /* STALE: move it aside under a name every racer derives the same way. */
      const aside = path.join(dataDir, `${LOCK_DIRECTORY}.stale.${seen.identity}`);
      try {
        await fs.rename(lockDir, aside);
      } catch (moveError) {
        const code = codeOf(moveError);
        if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY") {
          continue; // another racer moved it first (or its aside-name is taken): look again
        }
        throw moveError;
      }
      /* Mark the aside directory before re-creating LOCK: from here a racer still holding the stale judgement can
         only fail to rename a fresh LOCK onto it (the target is not empty). */
      await fs.writeFile(path.join(aside, `taken-over-by-${instanceId}`), `${now()}\n`);
      tookOver = { previous: seen.owner, ageMs: seen.ageMs };
      asideDir = aside;
      log(
        `  LOCK TAKEN OVER: the lock held by ${describeOwner(seen.owner)} had no heartbeat for ` +
          `${Math.round(seen.ageMs / 1000)} s; moved aside to ${aside}`,
      );
      continue;
    }

    /* WE CREATED LOCK. Record who we are, then confirm nobody moved it in the meantime. */
    const owner: LockOwner = { instance_id: instanceId, pid: process.pid, host: os.hostname(), started_at: now() };
    const ownerTmp = path.join(lockDir, `owner.json.${instanceId}.tmp`);
    try {
      await fs.writeFile(ownerTmp, JSON.stringify(owner));
      await fs.rename(ownerTmp, path.join(lockDir, "owner.json"));
      await fs.writeFile(path.join(lockDir, "heartbeat"), `${now()}\n`);
    } catch (error) {
      if (codeOf(error) === "ENOENT") continue; // our fresh LOCK was moved aside by a racer: look again
      throw error;
    }
    if ((await readOwner(lockDir))?.instance_id !== instanceId) continue;
    const lock = heldLock(lockDir, instanceId, heartbeatMs, now, options.onLost, log);
    /* THE ASIDE DIRECTORY IS KEPT, not removed at once: while it exists, a racer that judged the same old lock
       stale cannot rename this fresh LOCK onto its name. Aside directories older than ten minutes -- far past any
       racer's window -- are pruned here, best-effort. */
    await pruneAside(dataDir, now(), asideDir);
    return { ok: true, lock, tookOver };
  }
  return { ok: false, owner: null, ageMs: null, reason: `could not settle ${lockDir} after repeated attempts (a takeover race)` };
}

async function pruneAside(dataDir: string, now: number, keep: string | null): Promise<void> {
  try {
    for (const name of await fs.readdir(dataDir)) {
      if (!name.startsWith(`${LOCK_DIRECTORY}.stale.`)) continue;
      const full = path.join(dataDir, name);
      if (full === keep) continue;
      const time = await mtimeOf(full);
      if (time !== null && now - time > 10 * 60_000) await fs.rm(full, { recursive: true, force: true });
    }
  } catch {
    // best-effort housekeeping only
  }
}

function heldLock(
  lockDir: string,
  instanceId: string,
  heartbeatMs: number,
  now: () => number,
  onLost: ((reason: string) => void) | undefined,
  log: (line: string) => void,
): DataLock {
  let lost = false;
  let released = false;
  const markLost = (reason: string) => {
    if (lost || released) return;
    lost = true;
    clearInterval(timer);
    log(`  LOCK LOST: ${reason}`);
    onLost?.(reason);
  };
  const verify = async (): Promise<boolean> => {
    if (lost) return false;
    if (released) return false;
    const owner = await readOwner(lockDir);
    if (owner?.instance_id === instanceId) return true;
    markLost(
      owner === null
        ? `${lockDir} no longer names this instance (${instanceId}): it was removed or moved`
        : `${lockDir} now belongs to ${describeOwner(owner)}; this instance (${instanceId}) was fenced`,
    );
    return false;
  };
  const beat = async () => {
    if (!(await verify())) return;
    try {
      await fs.writeFile(path.join(lockDir, "heartbeat"), `${now()}\n`);
    } catch (error) {
      if (codeOf(error) === "ENOENT") await verify();
      else log(`  lock: could not touch the heartbeat — ${(error as Error).message}`);
    }
  };
  const timer = setInterval(() => void beat().catch(() => undefined), heartbeatMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    instanceId,
    directory: lockDir,
    verify,
    async release() {
      if (released) return;
      clearInterval(timer);
      const ours = !lost && (await readOwner(lockDir))?.instance_id === instanceId;
      released = true;
      if (ours) await fs.rm(lockDir, { recursive: true, force: true });
    },
    releaseSync() {
      if (released) return;
      clearInterval(timer);
      released = true;
      try {
        const owner = JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8")) as LockOwner;
        if (!lost && owner.instance_id === instanceId) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // not ours, or already gone
      }
    },
  };
}
