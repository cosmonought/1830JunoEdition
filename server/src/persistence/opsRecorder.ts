// server/src/persistence/opsRecorder.ts
//
// ==================================================================
//  LIVE-3C (LIVE-3 §18, brief §15): WHAT AN OPERATOR CAN READ ABOUT A RUNNING SERVER
// ==================================================================
//
// Two small files beside the games, both written only by the process that holds the data directory's lock:
//
//   ops/audit.jsonl   one JSON line per lifecycle event that changed durable state or needs an operator's eye: a
//                     hold created or released, a record repaired from its log, a table expired or archived, the
//                     join-code index rebuilt, a game moved to the archive, a temporary removed, the identity
//                     journal compacted. Appended AFTER the change it describes is durable, and synced; a crash
//                     between the two loses the line (accepted for the local store, LIVE-3 §9.3).
//   ops/status.json   the server's current inventory: how many games are in each class, why each held game is held,
//                     which games could not be loaded, whether any store is holding a write only a restart can
//                     settle, and the identity store's health. Replaced whole (LIVE-3B §8.7), coalesced, best
//                     effort: a failure to write it is said in the window and never touches a game.
//
// NEITHER EVER HOLDS A SECRET OR A PRINCIPAL. Game ids and player ids are keys a table already shares; principal,
// profile and session ids, recovery selectors and credential digests are never passed in -- and, as a second fence,
// any value shaped like an identity id is redacted before a line is written (`redactIdentity`). CloudWatch is
// LIVE-6's; this is only what `cat` and `tools/gamesDoctor.ts status` read.

import { promises as fs } from "fs";
import * as path from "path";

import { nodeStoreFs } from "../fileLogStore";
import { durableReplace } from "./durableReplace";

/** Identity ids that must never reach an ops file (the LIVE-2B/2E formats: principal, profile, session, recovery
 *  selector). Credential digests are 64 hex characters like a log hash, so they cannot be told apart by shape: they
 *  are simply never passed to a recorder, and the tests scan every ops file for them. */
const IDENTITY_PATTERN = /\b(?:pr|pf|se|rk)_[0-9a-hjkmnp-tv-z]{20,}\b|\bpr_dev_[A-Za-z0-9._-]+/gi;

/** A value made safe for an ops file: every identity-shaped token replaced. */
export function redactIdentity<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(IDENTITY_PATTERN, "[redacted]")) as T;
}

export interface OpsRecorder {
  /** Append one audit line (fire and forget; lines keep their order). */
  audit(event: string, fields?: Record<string, unknown>): void;
  /** Replace the status snapshot (coalesced; best effort). */
  status(snapshot: Record<string, unknown>): void;
  /** Every pending write finished (tests, shutdown). */
  flush(): Promise<void>;
}

export interface MemoryOpsRecorder extends OpsRecorder {
  readonly lines: Array<Record<string, unknown>>;
  readonly snapshots: Array<Record<string, unknown>>;
}

export function createMemoryOpsRecorder(): MemoryOpsRecorder {
  const lines: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  return {
    lines,
    snapshots,
    audit(event, fields = {}) {
      lines.push(redactIdentity({ event, ...fields }));
    },
    status(snapshot) {
      snapshots.push(redactIdentity(snapshot));
    },
    flush: async () => undefined,
  };
}

export const NO_OPS: OpsRecorder = Object.freeze({ audit: () => undefined, status: () => undefined, flush: async () => undefined });

export interface FileOpsRecorderOptions {
  build: string;
  instanceId: string;
  writerCheck?: () => Promise<boolean>;
  warn?: (line: string) => void;
  now?: () => number;
  /** How often the status file may be rewritten (5 s when absent). */
  statusEveryMs?: number;
}

export const OPS_DIRECTORY = "ops";
export const AUDIT_FILE = "audit.jsonl";
export const STATUS_FILE = "status.json";
export const STATUS_FORMAT = "gs-ops-status";

export function createFileOpsRecorder(dataDir: string, options: FileOpsRecorderOptions): OpsRecorder {
  const directory = path.join(dataDir, OPS_DIRECTORY);
  const auditFile = path.join(directory, AUDIT_FILE);
  const statusFile = path.join(directory, STATUS_FILE);
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const now = options.now ?? (() => Date.now());
  const every = options.statusEveryMs ?? 5_000;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (task: () => Promise<void>) => {
    chain = chain.then(task, task).catch((error) => warn(`  ops: ${error instanceof Error ? error.message : String(error)}`));
  };
  let ready: Promise<void> | null = null;
  const prepare = () => (ready ??= fs.mkdir(directory, { recursive: true }).then(() => undefined));
  const mayWrite = async () => options.writerCheck === undefined || (await options.writerCheck().catch(() => false));

  let pendingStatus: Record<string, unknown> | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatusAt = 0;
  const writeStatus = () => {
    statusTimer = null;
    const snapshot = pendingStatus;
    pendingStatus = null;
    if (snapshot === null) return;
    lastStatusAt = now();
    serial(async () => {
      await prepare();
      if (!(await mayWrite())) return;
      const body = redactIdentity({ format: STATUS_FORMAT, version: 1, written_at: now(), build: options.build, instance_id: options.instanceId, ...snapshot });
      const outcome = await durableReplace(nodeStoreFs, statusFile, Buffer.from(`${JSON.stringify(body, null, 1)}\n`, "utf8"));
      if (outcome.kind !== "committed") warn(`  ops: the status file was not written (${outcome.detail})`);
    });
  };

  return {
    audit(event, fields = {}) {
      const line = redactIdentity({ at: now(), event, ...fields, build: options.build, instance_id: options.instanceId });
      serial(async () => {
        await prepare();
        if (!(await mayWrite())) return;
        const handle = await fs.open(auditFile, "a");
        try {
          await handle.write(`${JSON.stringify(line)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    },
    status(snapshot) {
      pendingStatus = snapshot;
      if (statusTimer !== null) return;
      const wait = Math.max(0, lastStatusAt + every - now());
      statusTimer = setTimeout(writeStatus, wait);
      statusTimer.unref?.();
    },
    async flush() {
      if (statusTimer !== null) {
        clearTimeout(statusTimer);
        writeStatus();
      }
      await chain;
    },
  };
}
