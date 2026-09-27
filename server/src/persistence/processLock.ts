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
//   BEACON    (LIVE-2F/3D, C7-01..05) a stale heartbeat is NOT enough to take a lock over while its owner still
//             lives on this machine. A stopped, suspended or hung server (Ctrl-Z, `docker pause`, a debugger) stops
//             beating but keeps its handles; resumed after a takeover, a write it had already checked the lock for
//             lands on top of the new owner's acknowledged history -- the self-check runs BEFORE a write, never
//             between the write's own syscalls, so no check can close that window. So the holder listens on a
//             LIVENESS BEACON -- a Unix-domain socket (a named pipe on Windows) named in `owner.json` -- created before
//             `owner.json` names it and closed only after `LOCK` is gone. The kernel keeps a stopped process's
//             listening socket, and removes it when the process dies, whatever its PID becomes afterwards: a
//             connection that succeeds means "alive" (refuse, exit 2, however old the heartbeat), a refused or
//             absent beacon means "dead" (the heartbeat's age decides, as before). A beacon on another host (the
//             `host` differs) or one that cannot be reached (another container) is not evidence either way, and the
//             heartbeat alone decides -- the residual AWS writer epochs close.
//
// AWS writer epochs are LIVE-5's; this is the local store's whole fence.

import { promises as fs, rmSync, readFileSync, unlinkSync } from "fs";
import * as net from "net";
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
  /** LIVE-2F/3D: where this owner's liveness beacon listens -- a name inside `LOCK/` (relative), an absolute socket
   *  path, or a Windows pipe name. Absent from an owner that runs no beacon (an older server, or one whose beacon
   *  could not listen): then the heartbeat alone decides. */
  readonly beacon?: string;
}

/** How long a contender waits for a beacon to answer before calling it alive (fail-closed). */
export const LOCK_BEACON_PROBE_MS = 2_000;

export interface DataLockOptions {
  /** This process's identity in the lock. Random (16 bytes, hex) when absent. */
  instanceId?: string;
  staleAfterMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  /** Called once, when a self-check finds the lock is no longer this instance's (taken over, or removed). */
  onLost?: (reason: string) => void;
  log?: (line: string) => void;
  /** LIVE-2F/3D: run a liveness beacon while this lock is held (default true). `false` is for tests that stand in for
   *  an owner a contender cannot probe -- one on another host, or an older server. */
  beacon?: boolean;
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

/** A directory's identity (device and inode) and its mtime, or `null` if it is not there. */
async function statOf(target: string): Promise<{ id: string; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(target, { bigint: true });
    return { id: `${stat.dev}-${stat.ino}`, mtimeMs: Number(stat.mtimeMs) };
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** `inspect`'s owner read. Absent (ENOENT) or not an owner record: anonymous (`null`) -- the same for every racer,
 *  since owner.json is only ever renamed into place whole. Any OTHER failure (a transient read error on a loaded
 *  machine) is `undefined`: inconclusive, look again -- never a different identity than the other racers derive. */
async function readOwnerForInspection(lockDir: string): Promise<LockOwner | null | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
  } catch (error) {
    return codeOf(error) === "ENOENT" ? null : undefined;
  }
  try {
    const parsed = JSON.parse(text) as LockOwner;
    return typeof parsed?.instance_id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** A held lock as a contender sees it, or `null` if it vanished, or was replaced, while being looked at.
 *
 *  ==================================================================
 *   FI-28 (LIVE-2C, REPRODUCED UNDER LOAD): EVERY FACT FROM ONE DIRECTORY
 *  ==================================================================
 *  Two of six racers both won a stale takeover when the machine was loaded (2 of 7 heavy runs). The inspection read
 *  the stale lock's mtime, and then -- after a winner had moved that lock aside and created its own fresh `LOCK`,
 *  still without an owner record -- read the NEW directory's (missing) owner and heartbeat. Stale age from the old
 *  directory plus an anonymous identity from the new one made an aside-name no other racer used, so the rename that
 *  every racer is meant to lose to the first one succeeded, and moved the winner's fresh lock aside. Now the
 *  directory's identity (device + inode) is read before and after; if it changed, the inspection is discarded and
 *  the racer looks again -- where it meets the fresh lock and refuses. */
async function inspect(lockDir: string, now: number): Promise<{ owner: LockOwner | null; ageMs: number; identity: string } | null> {
  const before = await statOf(lockDir);
  if (before === null) return null;
  const owner = await readOwnerForInspection(lockDir);
  const beats = await Promise.all([mtimeOf(path.join(lockDir, "heartbeat")), mtimeOf(path.join(lockDir, "owner.json"))]);
  const after = await statOf(lockDir);
  if (owner === undefined || after === null || after.id !== before.id) return null;
  const newest = Math.max(before.mtimeMs, after.mtimeMs, ...beats.map((time) => time ?? 0));
  const identity = owner?.instance_id ?? `anon-${Math.floor(before.mtimeMs)}`;
  return { owner, ageMs: now - newest, identity: identity.replace(/[^A-Za-z0-9_-]/g, "_") };
}

/** For offline tools (`logDoctor`): is a live server holding this data directory right now? */
export async function lockStatus(
  dataDir: string,
  options: { now?: number; staleAfterMs?: number } = {},
): Promise<{ readonly held: boolean; readonly owner: LockOwner | null; readonly ageMs: number | null }> {
  const lockDir = path.join(dataDir, LOCK_DIRECTORY);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seen = await inspect(lockDir, options.now ?? Date.now());
    if (seen !== null) {
      /* LIVE-2F/3D: a stale heartbeat whose owner still lives (stopped, hung) is still held -- offline tools refuse. */
      const held = seen.ageMs < (options.staleAfterMs ?? LOCK_STALE_AFTER_MS) || (await probeBeacon(lockDir, seen.owner)) === "alive";
      return { held, owner: seen.owner, ageMs: seen.ageMs };
    }
    if ((await statOf(lockDir)) === null) return { held: false, owner: null, ageMs: null };
  }
  /* A lock that keeps changing while it is read is being written by somebody alive. */
  return { held: true, owner: null, ageMs: null };
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
      /* LIVE-2F/3D: STALE BY ITS HEARTBEAT, BUT ALIVE BY ITS BEACON -- a stopped, suspended or hung owner. Never taken
         over: resumed, it would finish the write it had already checked the lock for, on top of ours. */
      if ((await probeBeacon(lockDir, seen.owner)) === "alive") {
        return {
          ok: false,
          owner: seen.owner,
          ageMs: seen.ageMs,
          reason:
            `the data directory's lock belongs to ${describeOwner(seen.owner)}, which has not beaten its heartbeat for ` +
            `${Math.round(seen.ageMs / 1000)} s but is STILL RUNNING on this machine (stopped, suspended or hung?) -- or its ` +
            `liveness beacon answers but not to this user. End that process first -- a lock is never taken over from a ` +
            `live owner (${lockDir})`,
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

    /* WE CREATED LOCK. LIVE-2F/3D: the beacon listens FIRST, so an owner.json that names a beacon names one that
       answers for as long as this process lives. Then record who we are, and confirm nobody moved it meanwhile. */
    const beacon = options.beacon === false ? null : await openBeacon(lockDir, instanceId, log);
    const owner: LockOwner = {
      instance_id: instanceId,
      pid: process.pid,
      host: os.hostname(),
      started_at: now(),
      ...(beacon !== null ? { beacon: beacon.name } : {}),
    };
    const ownerTmp = path.join(lockDir, `owner.json.${instanceId}.tmp`);
    try {
      await fs.writeFile(ownerTmp, JSON.stringify(owner));
      await fs.rename(ownerTmp, path.join(lockDir, "owner.json"));
      await fs.writeFile(path.join(lockDir, "heartbeat"), `${now()}\n`);
    } catch (error) {
      beacon?.close();
      if (codeOf(error) === "ENOENT") continue; // our fresh LOCK was moved aside by a racer: look again
      throw error;
    }
    if ((await readOwner(lockDir))?.instance_id !== instanceId) {
      beacon?.close();
      continue;
    }
    const lock = heldLock(lockDir, instanceId, heartbeatMs, now, options.onLost, log, beacon);
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
  beacon: Beacon | null,
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
      try {
        if (ours) await fs.rm(lockDir, { recursive: true, force: true });
      } finally {
        /* LIVE-2F/3D: the beacon goes LAST -- while it answers, nobody can take over a LOCK this process may still be
           removing, so a release can never remove a successor's lock (C7-05). */
        beacon?.close();
      }
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
      } finally {
        beacon?.closeSync();
      }
    },
  };
}

/* ==================================================================
    LIVE-2F/3D (C7-01..05): THE LIVENESS BEACON
   ==================================================================
   A listening Unix-domain socket (a named pipe on Windows) that exists exactly as long as the lock's owner PROCESS
   does -- stopped or not -- and whose absence a contender can observe without trusting a PID. It answers nothing: a
   connection is accepted by the kernel (a stopped process's backlog still takes it) and destroyed if the owner is
   running. The name is random per instance, so a reused PID or a restarted owner can never answer for a dead one. */

interface Beacon {
  /** What `owner.json` records: a name relative to `LOCK/`, an absolute socket path, or a Windows pipe name. */
  readonly name: string;
  close(): void;
  closeSync(): void;
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
/** A Unix socket path must fit `sockaddr_un` (104 bytes on macOS, 108 on Linux, NUL included). */
const MAX_SOCKET_PATH_BYTES = 100;

function beaconAddress(lockDir: string, name: string): string | null {
  if (name.startsWith(WINDOWS_PIPE_PREFIX)) return process.platform === "win32" ? name : null;
  const full = path.isAbsolute(name) ? name : path.join(lockDir, name);
  return process.platform !== "win32" && Buffer.byteLength(full) <= MAX_SOCKET_PATH_BYTES ? full : null;
}

async function openBeacon(lockDir: string, instanceId: string, log: (line: string) => void): Promise<Beacon | null> {
  let name: string;
  let unlinkPath: string | null = null;
  if (process.platform === "win32") {
    name = `${WINDOWS_PIPE_PREFIX}gs-data-lock-${instanceId}`;
  } else {
    /* PER INSTANCE, never a shared name (independent review IR-01): closing a Unix-socket server unlinks the path it
       bound, so an old owner closing a shared `beacon.sock` after a successor bound its own would delete the
       successor's -- and the successor would then look dead to the next contender. */
    const inLock = `b-${instanceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}.sock`;
    if (Buffer.byteLength(path.join(lockDir, inLock)) <= MAX_SOCKET_PATH_BYTES) {
      name = inLock; // inside LOCK: it moves (and is removed) with the lock directory
    } else {
      name = path.join(os.tmpdir(), `gs-data-lock-${instanceId.slice(0, 32)}.sock`);
      unlinkPath = name;
    }
  }
  const address = beaconAddress(lockDir, name);
  if (address === null) return null;
  const server = net.createServer((socket) => socket.destroy());
  server.on("error", () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    log(`  lock: no liveness beacon (${(error as Error).message}); a stale heartbeat alone will decide a takeover of this lock`);
    return null;
  }
  server.unref();
  let closed = false;
  const unlink = () => {
    if (unlinkPath === null) return;
    try {
      unlinkSync(unlinkPath);
    } catch {
      // already gone
    }
  };
  return {
    name,
    close() {
      if (closed) return;
      closed = true;
      server.close();
      unlink();
    },
    closeSync() {
      if (closed) return;
      closed = true;
      server.close();
      unlink();
    },
  };
}

/** Is the lock's owner (by its beacon) alive on this machine? `unknown` when the owner names no beacon, runs on
 *  another host, or its beacon cannot be addressed from here -- then the heartbeat alone decides, as it always did. */
export async function probeBeacon(lockDir: string, owner: LockOwner | null, timeoutMs = LOCK_BEACON_PROBE_MS): Promise<"alive" | "dead" | "unknown"> {
  if (owner === null || typeof owner.beacon !== "string" || owner.beacon.length === 0) return "unknown";
  if (owner.host !== os.hostname()) return "unknown";
  const address = beaconAddress(lockDir, owner.beacon);
  if (address === null) return "unknown";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (verdict: "alive" | "dead" | "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(verdict);
    };
    const socket = net.connect(address);
    /* No answer in time: something holds the name but does not complete a connection -- treated as ALIVE (fail
       closed: a takeover is refused, and the operator is told to end the old process). */
    const timer = setTimeout(() => finish("alive"), timeoutMs);
    socket.once("connect", () => finish("alive"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "";
      /* Nobody listens: the owner is gone (its socket file outlived it, or its pipe vanished with it). An absolute
         socket outside LOCK that is simply not there may be in another mount namespace (a private /tmp) -- not
         evidence either way (independent review IR-07): the heartbeat decides, as it did before the beacon. */
      if (code === "ENOENT" && path.isAbsolute(owner.beacon as string) && !owner.beacon?.startsWith(WINDOWS_PIPE_PREFIX)) return finish("unknown");
      if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK") return finish("dead");
      /* Somebody holds it (a full backlog, a busy pipe, a permission wall): alive. */
      if (code === "EAGAIN" || code === "EBUSY" || code === "EACCES" || code === "EPERM") return finish("alive");
      finish("unknown");
    });
  });
}
