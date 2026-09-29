// server/src/identity/journalStore.ts
//
// ==================================================================
//  LIVE-3C (LIVE-2E review M3): THE IDENTITY STORE, AS A SNAPSHOT AND A JOURNAL
// ==================================================================
//
// LIVE-2B/2E kept identity in one document, `identity.json`, rewritten WHOLE and revalidated WHOLE on every change:
// correct, crash-safe, and O(every profile, principal and session) per sign-in. Fine for a playtest; at tens of
// thousands of profiles each change stalls the event loop (M3). This store keeps the LIVE-2E model exactly -- the same
// records, the same `IdentityChange` deltas, the same service in front -- and changes only how they reach the disk:
//
//   identity.json            the SNAPSHOT: format `gs-identity` version 3 -- version 2's four collections plus `seq`,
//                            the last journal record folded into it. Replaced whole (LIVE-3B §8.7) only at compaction.
//   identity.journal.jsonl   the JOURNAL: one line per committed change -- `{"seq":n,"sha256":…,"change":{…}}` --
//                            appended POSITIONALLY at the end of the last durable line, looped until every byte is
//                            written, synced (and the directory synced when the file is created) before the change is
//                            acknowledged. Exactly the log store's protocol (LIVE-3B §8.2): a failure before a byte
//                            may have been written is DEFINITE; after it, UNCERTAIN, resolved by REDOING the same bytes
//                            at the same offset (never by reading back); a redo that fails poisons the store and asks
//                            for a restart.
//
// A COMMIT IS O(THE CHANGE). The change's own contract (one record once, its preconditions) and every relation it
// touches are checked against an in-memory index (`IdentityIndex`), not the whole set; the whole set is validated at
// the load and at each compaction -- once per `COMPACT_AFTER_RECORDS` changes, amortised O(1).
//
// THE LOAD (startup validation and recovery):
//   1. the snapshot (v1 and v2 are read through LIVE-2E's migration as `seq` 0; v3 as written);
//   2. the journal, line by line: a line must be whole JSON, carry the digest of its own `{seq, change}`, and be the
//      next `seq`; lines at or below the snapshot's `seq` were folded in by a compaction whose truncation did not
//      happen, and are skipped (contiguous among themselves); every later line is checked and applied;
//   3. a damaged FINAL line -- unterminated, unparseable or failing its digest -- is the one write that can have been
//      in flight at a crash (a change is acknowledged only after its sync): it is truncated away. Damage with a whole,
//      valid line after it is not a torn write: the load REFUSES (the server does not start) and nothing is changed;
//   4. the whole set is validated (`checkSnapshot`); a half-bound profile or principal cannot load;
//   5. a snapshot that is not version 3 -- a fresh directory, or a LIVE-2E file -- is rewritten as version 3 BEFORE
//      any journal line is written, so an older server (which reads only v1/v2 and knows nothing of a journal) refuses
//      this directory rather than silently ignoring its journal: a revocation can never be undone by a rollback. A
//      journal with no snapshot, or beside a v1/v2 snapshot, is a disagreement and refuses the start.
//
// COMPACTION (every `COMPACT_AFTER_RECORDS` records or `COMPACT_AFTER_BYTES` bytes, inside the serial queue): the
// whole set is validated and written as a new v3 snapshot with `seq` = the last record; only once that replacement is
// COMMITTED is the journal truncated to nothing. Every crash point is loadable: before the rename -- the old snapshot
// and the whole journal; after it -- the new snapshot and a journal whose lines are all at or below its `seq`
// (skipped); an uncertain replacement is either of those, so the journal is simply kept and appended to. Where the
// platform cannot sync a directory (Windows), the new snapshot's rename is not known durable, so the journal is NOT
// truncated at all (review E14): a power cut that loses the rename then finds the old snapshot and every line since.
// The journal only grows there; its folded lines are skipped at the load.
//
// UNCHANGED FROM LIVE-2E: revocations, rotations, link consumption and profile creation are single changes and so
// single journal lines -- durable before anything is applied or answered, atomic across a crash (a line is whole and
// verified, or it is gone). Nothing here prints a record. The data directory's lock is asked before every write.
//
// LIVE-5: the same `IdentityStore` contract -- `commit(change)` with its preconditions -- maps each change to one
// DynamoDB TransactWriteItems (brief §12, report §10); nothing here depends on rename semantics.

import { createHash } from "crypto";
import * as path from "path";

import { nodeStoreFs, type StoreFileHandle, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { StoreDefiniteError, StoreUncertainError } from "../persistence/storeResult";
import { IDENTITY_FILE, migrateIdentityDocument } from "./fileStore";
import {
  changeShapeProblem,
  checkSnapshot,
  IdentityIndex,
  IdentityStoreCorruptError,
  isLegacySession,
  preconditionFailure,
  withLegacyFamilies,
  type FullIdentitySnapshot,
  type IdentityChange,
  type IdentityCommitOptions,
  type IdentityStore,
  type Session,
} from "./store";

export const IDENTITY_JOURNAL_FILE = "identity.journal.jsonl";
/* ESCROW-3A: version 4 adds `families` (the session-family records, IR-03) and a `family_id` on every session. A v3
   directory (LIVE-3C) -- its snapshot and every journal line written beside it -- is migrated at the load exactly like
   v2 was: its sessions are given their lineage's family (`withLegacyFamilies`), the whole set validated, and the v4
   snapshot written BEFORE any new journal line, so a LIVE-3C server (which reads only v1-v3) refuses the directory
   rather than silently ignoring the families -- a family revocation can never be undone by a rollback. */
export const IDENTITY_SNAPSHOT_VERSION = 4;
/** The LIVE-3C snapshot version: sessions without families, read only to migrate. */
export const LEGACY_JOURNAL_SNAPSHOT_VERSION = 3;
const FORMAT = "gs-identity";
/** Journal records between compactions. */
export const COMPACT_AFTER_RECORDS = 1_000;
/** Journal bytes between compactions. */
export const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;

export interface JournalIdentityStoreOptions {
  fs?: StoreFs;
  /** `process.platform` when absent; directory sync is skipped on win32 (LIVE-3B §8.7 residual). */
  platform?: string;
  /** Consulted before every write: false means another process owns the data directory now (nothing is written). */
  writerCheck?: () => Promise<boolean>;
  /** An uncertain write the redo could not settle: the process must restart (LIVE-3 §8.2 step 7). */
  onRestartRequired?: (detail: string) => void;
  warn?: (line: string) => void;
  compactAfterRecords?: number;
  compactAfterBytes?: number;
  /** A compaction committed (for the audit line): the `seq` it folded in. */
  onCompacted?: (info: { seq: number; records: number; bytes: number }) => void;
}

export interface JournalHealth {
  readonly loaded: boolean;
  readonly poisoned: string | null;
  readonly snapshotSeq: number;
  readonly lastSeq: number;
  readonly journalRecords: number;
  readonly journalBytes: number;
  readonly compactions: number;
  readonly tornBytesRepaired: number;
  /** The snapshot version the load found (`null`: none). */
  readonly loadedVersion: number | null;
  readonly sizes: { principals: number; sessions: number; profiles: number; links: number; families?: number };
}

export interface JournalIdentityStore extends IdentityStore {
  readonly file: string;
  readonly journalFile: string;
  readonly stats: { commits: number; redone: number; definite: number; uncertain: number; compactions: number };
  /** Compact now (tests; the operator tool). */
  compact(): Promise<void>;
  health(): JournalHealth;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const DIR_SYNC_UNSUPPORTED = new Set(["EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM", "EACCES", "ENOSYS"]);
const digestOf = (seq: number, change: unknown): string => createHash("sha256").update(JSON.stringify({ seq, change })).digest("hex");

/** One journal line's bytes. */
export function journalLine(seq: number, change: IdentityChange): string {
  return `${JSON.stringify({ seq, sha256: digestOf(seq, change), change })}\n`;
}

/** A journal line, verified, or `null`. */
export function parseJournalLine(text: string): { seq: number; change: IdentityChange } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as { seq?: unknown; sha256?: unknown; change?: unknown };
  if (Object.keys(record).length !== 3 || !Number.isSafeInteger(record.seq) || (record.seq as number) < 1) return null;
  if (typeof record.change !== "object" || record.change === null || Array.isArray(record.change)) return null;
  if (record.sha256 !== digestOf(record.seq as number, record.change)) return null;
  return { seq: record.seq as number, change: record.change as IdentityChange };
}

export interface ParsedSnapshot {
  readonly snapshot: FullIdentitySnapshot;
  readonly seq: number;
  /** 1, 2 or 3. */
  readonly version: number;
}

/** The snapshot document: v1 and v2 through LIVE-2E's migration (`seq` 0), v3 (LIVE-3C) through ESCROW-3A's family
 *  migration, v4 as written. Refuses anything else. */
export function parseSnapshotDocument(parsed: unknown, where: string): ParsedSnapshot {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as { version?: unknown }).version === IDENTITY_SNAPSHOT_VERSION) {
    const document = parsed as { format?: unknown; seq?: unknown; principals?: unknown; sessions?: unknown; profiles?: unknown; links?: unknown; families?: unknown };
    const keys = Object.keys(parsed).sort().join(",");
    if (document.format !== FORMAT || keys !== "families,format,links,principals,profiles,seq,sessions,version" || !Number.isSafeInteger(document.seq) || (document.seq as number) < 0) {
      throw new IdentityStoreCorruptError(`${where}: not a ${FORMAT} v${IDENTITY_SNAPSHOT_VERSION} document`);
    }
    return {
      snapshot: checkSnapshot({ principals: document.principals, sessions: document.sessions, profiles: document.profiles, links: document.links, families: document.families }, where),
      seq: document.seq as number,
      version: IDENTITY_SNAPSHOT_VERSION,
    };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as { version?: unknown }).version === LEGACY_JOURNAL_SNAPSHOT_VERSION) {
    const document = parsed as { format?: unknown; seq?: unknown; principals?: unknown; sessions?: unknown; profiles?: unknown; links?: unknown };
    const keys = Object.keys(parsed).sort().join(",");
    if (document.format !== FORMAT || keys !== "format,links,principals,profiles,seq,sessions,version" || !Number.isSafeInteger(document.seq) || (document.seq as number) < 0 || !Array.isArray(document.sessions)) {
      throw new IdentityStoreCorruptError(`${where}: not a ${FORMAT} v${LEGACY_JOURNAL_SNAPSHOT_VERSION} document`);
    }
    const migrated = withLegacyFamilies(document.sessions, `${where} (v3, migrated)`);
    return {
      snapshot: checkSnapshot({ principals: document.principals, sessions: migrated.sessions, profiles: document.profiles, links: document.links, families: migrated.families }, `${where} (v3, migrated)`),
      seq: document.seq as number,
      version: LEGACY_JOURNAL_SNAPSHOT_VERSION,
    };
  }
  const version = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
  return { snapshot: migrateIdentityDocument(parsed, where), seq: 0, version: typeof version === "number" ? version : 0 };
}

export function snapshotBytes(snapshot: FullIdentitySnapshot, seq: number): Buffer {
  return Buffer.from(
    `${JSON.stringify({ format: FORMAT, version: IDENTITY_SNAPSHOT_VERSION, seq, principals: snapshot.principals, sessions: snapshot.sessions, profiles: snapshot.profiles, links: snapshot.links, families: snapshot.families })}\n`,
    "utf8",
  );
}

/** ESCROW-3A: a change a LIVE-3C (v3) server journaled, as v4: each legacy session record given the family of its
 *  lineage -- its own stored record's, a predecessor's in the index or in this change, or one it founds -- and each
 *  family it founds added. Deterministic (the same line migrates the same way at every load). Only ever applied to the
 *  lines beside a v3 snapshot; a v4 directory's lines must already be v4 records (a legacy line there is corruption). */
export function upgradeLegacyChange(change: IdentityChange, index: IdentityIndex): IdentityChange {
  const sessions = change.sessions ?? [];
  if (!sessions.some((record) => isLegacySession(record))) return change;
  const predecessorInIndex = (sessionId: string): string | undefined => {
    for (const other of index.sessions.values()) if (other.rotated_to === sessionId) return other.family_id;
    return undefined;
  };
  const migrated = withLegacyFamilies(sessions, "a v3 journal line", (sessionId) => index.sessions.get(sessionId)?.family_id ?? predecessorInIndex(sessionId));
  const added = migrated.families.filter((family) => index.families.get(family.family_id) === undefined && !(change.families ?? []).some((f) => f.family_id === family.family_id));
  const order = new Map(sessions.map((record, at) => [(record as Session).session_id, at] as const));
  const ordered = [...migrated.sessions].sort((a, b) => (order.get(a.session_id) ?? 0) - (order.get(b.session_id) ?? 0));
  return { ...change, sessions: ordered, families: [...(change.families ?? []), ...added] };
}

/** What a journal's bytes hold, against a snapshot at `snapshotSeq`. Pure (the load and the operator tool share it). */
export interface JournalScan {
  /** The changes to apply, in order (every line above the snapshot's `seq`). */
  readonly changes: ReadonlyArray<{ seq: number; change: IdentityChange }>;
  /** The byte just past the last whole, valid line. */
  readonly end: number;
  readonly size: number;
  /** Lines at or below the snapshot's `seq` (a compaction's journal that was not truncated). */
  readonly skipped: number;
  /** `torn`: a damaged final line (truncated at `end`); `corrupt`: damage with a valid line after it, or a sequence
   *  that does not continue the snapshot. */
  readonly classification: "clean" | "torn" | "corrupt";
  readonly detail: string;
}

export function scanJournal(bytes: Buffer, snapshotSeq: number): JournalScan {
  const changes: Array<{ seq: number; change: IdentityChange }> = [];
  let end = 0;
  let skipped = 0;
  let lastSkipped: number | null = null;
  let last = snapshotSeq;
  let damageAt: number | null = null;
  let position = 0;
  while (position < bytes.length) {
    const newline = bytes.indexOf(0x0a, position);
    if (newline === -1) {
      damageAt ??= position; // an unterminated final fragment
      break;
    }
    const parsed = parseJournalLine(bytes.subarray(position, newline).toString("utf8"));
    if (parsed === null) {
      if (damageAt === null) damageAt = position;
      position = newline + 1;
      continue; // keep looking: a VALID line after damage makes it corruption, not a torn write
    }
    if (damageAt !== null) {
      return { changes, end, size: bytes.length, skipped, classification: "corrupt", detail: `a valid line (seq ${parsed.seq}) follows damage at byte ${damageAt}` };
    }
    if (parsed.seq <= snapshotSeq) {
      if (lastSkipped !== null && parsed.seq !== lastSkipped + 1) {
        return { changes, end, size: bytes.length, skipped, classification: "corrupt", detail: `folded lines are not contiguous (seq ${parsed.seq} after ${lastSkipped})` };
      }
      if (changes.length > 0) return { changes, end, size: bytes.length, skipped, classification: "corrupt", detail: `seq ${parsed.seq} after seq ${last}` };
      lastSkipped = parsed.seq;
      skipped += 1;
    } else {
      if (parsed.seq !== last + 1) {
        return { changes, end, size: bytes.length, skipped, classification: "corrupt", detail: `seq ${parsed.seq} does not continue seq ${last}` };
      }
      changes.push(parsed);
      last = parsed.seq;
    }
    end = newline + 1;
    position = newline + 1;
  }
  if (damageAt !== null) {
    /* LIVE-2F/3D (C1-02, C7-04): ONE CHANGE IS ONE LINE, AND ONLY ONE IS EVER IN FLIGHT. What a crash can leave past the
       last whole line is part of that one line -- an unterminated fragment, or the line with holes in it and its own
       newline last. Two or more lines' worth of damage, or a whole verifiable line glued behind the damage (a write
       that landed past a torn one), is not a torn write: acknowledged changes are in there, and truncating them would
       silently undo them (a sign-out that works again). Refused, as the log store refuses its F-8 shape. */
    const region = bytes.subarray(damageAt);
    const firstNewline = region.indexOf(0x0a);
    if (firstNewline !== -1 && firstNewline !== region.length - 1) {
      return { changes, end, size: bytes.length, skipped, classification: "corrupt", detail: `damage at byte ${damageAt} spans more than one line (${region.length} bytes) -- more than the one change a crash can tear` };
    }
    const text = region.toString("utf8");
    for (let at = text.indexOf("{", 1); at !== -1; at = text.indexOf("{", at + 1)) {
      const glued = parseJournalLine(text.slice(at).replace(/\n$/, ""));
      if (glued !== null) {
        return { changes, end, size: bytes.length, skipped, classification: "corrupt", detail: `a whole change (seq ${glued.seq}) was written behind damage at byte ${damageAt}` };
      }
    }
    return { changes, end, size: bytes.length, skipped, classification: "torn", detail: `a damaged final line at byte ${damageAt}` };
  }
  return { changes, end, size: bytes.length, skipped, classification: "clean", detail: "" };
}

export function createJournalIdentityStore(directory: string, options: JournalIdentityStoreOptions = {}): JournalIdentityStore {
  const io = options.fs ?? nodeStoreFs;
  const platform = options.platform ?? process.platform;
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const target = path.join(directory, IDENTITY_FILE);
  const journalFile = path.join(directory, IDENTITY_JOURNAL_FILE);
  const compactRecords = options.compactAfterRecords ?? COMPACT_AFTER_RECORDS;
  const compactBytes = options.compactAfterBytes ?? COMPACT_AFTER_BYTES;
  const stats = { commits: 0, redone: 0, definite: 0, uncertain: 0, compactions: 0 };

  let index: IdentityIndex | null = null;
  let poisoned: string | null = null;
  let snapshotSeq = 0;
  let lastSeq = 0;
  /** Where the next journal line is written: the byte past the last durable line. */
  let committedEnd = 0;
  let journalExists = false;
  let journalRecords = 0;
  /** Records and bytes appended since the last snapshot was written -- what triggers the next compaction (a journal
   *  whose truncation failed is still folded only once per interval, never on every commit). */
  let sinceCompaction = 0;
  let warnedNoDirSync = false;
  let bytesAtCompaction = 0;
  let tornBytesRepaired = 0;
  let loadedVersion: number | null = null;

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

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

  /** One attempt of a positional append at `committedEnd` (LIVE-3B §8.2). */
  async function attempt(bytes: Buffer, redo: boolean): Promise<{ kind: "committed" } | { kind: "definite" | "uncertain"; detail: string }> {
    let handle: StoreFileHandle | null = null;
    let created = false;
    try {
      if (!journalExists) {
        try {
          handle = await io.open(journalFile, "wx");
          created = true;
        } catch (error) {
          if (codeOf(error) !== "EEXIST") throw error;
          handle = await io.open(journalFile, "r+");
        }
      } else {
        handle = await io.open(journalFile, "r+");
      }
    } catch (error) {
      const detail = `could not open ${IDENTITY_JOURNAL_FILE}: ${describe(error)}`;
      return { kind: redo ? "uncertain" : "definite", detail };
    }
    journalExists = true;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, committedEnd + offset);
        if (!(bytesWritten > 0)) throw new Error(`a write returned ${bytesWritten} bytes with ${bytes.length - offset} still to write`);
        offset += bytesWritten;
      }
      const intended = committedEnd + bytes.length;
      const { size } = await handle.stat();
      if (size > intended) await handle.truncate(intended); // stray bytes from an earlier attempt: cut, never grow
      else if (size < intended) throw new Error(`${IDENTITY_JOURNAL_FILE} is ${size} bytes after writing through byte ${intended}`);
      await handle.sync();
      if (created) await syncDirectory();
      const closing = handle;
      handle = null;
      await closing.close();
      return { kind: "committed" };
    } catch (error) {
      return { kind: "uncertain", detail: `writing ${bytes.length} bytes at byte ${committedEnd} of ${IDENTITY_JOURNAL_FILE}: ${describe(error)}` };
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
    }
  }

  async function readOptional(file: string): Promise<Buffer | null> {
    try {
      return await io.readFile(file);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
  }

  const load = (): Promise<FullIdentitySnapshot> =>
    serial(async () => {
      await io.mkdir(directory);
      const raw = await readOptional(target);
      let parsedSnapshot: ParsedSnapshot | null = null;
      if (raw !== null) {
        let document: unknown;
        try {
          document = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new IdentityStoreCorruptError(`${target}: not JSON`);
        }
        parsedSnapshot = parseSnapshotDocument(document, target);
      }
      loadedVersion = parsedSnapshot?.version ?? null;
      const base = parsedSnapshot ?? { snapshot: { principals: [], sessions: [], profiles: [], links: [], families: [] }, seq: 0, version: 0 };
      const journal = await readOptional(journalFile);
      journalExists = journal !== null;
      const legacyJournal = parsedSnapshot !== null && parsedSnapshot.version === LEGACY_JOURNAL_SNAPSHOT_VERSION;
      if (journal !== null && journal.length > 0 && (parsedSnapshot === null || (parsedSnapshot.version !== IDENTITY_SNAPSHOT_VERSION && !legacyJournal))) {
        /* A journal only ever continues a journal snapshot (v4, or the LIVE-3C v3 being migrated): beside no snapshot or
           a whole-file one, the two sources disagree about what identity is -- refused, never guessed at. */
        throw new IdentityStoreCorruptError(
          `${journalFile}: a journal of ${journal.length} bytes beside ${parsedSnapshot === null ? "no snapshot" : `a v${parsedSnapshot.version} snapshot`}`,
        );
      }
      const scan = scanJournal(journal ?? Buffer.alloc(0), base.seq);
      if (scan.classification === "corrupt") throw new IdentityStoreCorruptError(`${journalFile}: ${scan.detail}`);
      const built = IdentityIndex.from(base.snapshot);
      for (const { seq, change: stored } of scan.changes) {
        /* ESCROW-3A: the lines a LIVE-3C server wrote beside its v3 snapshot carry legacy sessions (no family). */
        const change = legacyJournal ? upgradeLegacyChange(stored, built) : stored;
        const problem = built.check(change, `${IDENTITY_JOURNAL_FILE} seq ${seq}`);
        if (problem !== null) throw new IdentityStoreCorruptError(problem);
        built.apply(change);
      }
      /* The whole set, once: nothing half-bound can load, whatever the journal did. */
      const whole = checkSnapshot(built.snapshot(), `${target} + ${IDENTITY_JOURNAL_FILE}`);
      if (scan.classification === "torn") {
        /* LIVE-2F/3D (C7-06): the repair is a WRITE, and only the lock's owner writes (as the log store's, review E9). */
        if (options.writerCheck && !(await options.writerCheck().catch(() => false))) {
          throw new StoreDefiniteError(`${journalFile} has a torn final change, and this server does not own the data directory; it is left exactly as found`);
        }
        const handle = await io.open(journalFile, "r+");
        try {
          await handle.truncate(scan.end); // only ever DOWN, to the end of the last whole, verified line
          await handle.sync();
        } finally {
          await handle.close().catch(() => undefined);
        }
        tornBytesRepaired += scan.size - scan.end;
        warn(`  identity store: ${IDENTITY_JOURNAL_FILE}: truncated ${scan.size - scan.end} bytes of a torn final change (${scan.detail}); ${scan.changes.length} changes stand`);
      }
      index = built;
      snapshotSeq = base.seq;
      lastSeq = scan.changes.length > 0 ? scan.changes[scan.changes.length - 1].seq : base.seq;
      committedEnd = scan.end;
      journalRecords = scan.skipped + scan.changes.length;
      sinceCompaction = scan.changes.length;
      bytesAtCompaction = 0;
      if (base.version !== IDENTITY_SNAPSHOT_VERSION) {
        /* MIGRATION BEFORE ANY JOURNAL LINE: the directory becomes one an older server refuses rather than misreads. */
        if (options.writerCheck && !(await options.writerCheck().catch(() => false))) {
          throw new StoreDefiniteError("this server does not own the data directory; the identity snapshot was not migrated");
        }
        const outcome = await durableReplace(io, target, snapshotBytes(whole, lastSeq), { platform, warn });
        if (outcome.kind !== "committed") throw new IdentityStoreCorruptError(`${target}: could not be written as a v${IDENTITY_SNAPSHOT_VERSION} snapshot (${outcome.detail})`);
        snapshotSeq = lastSeq;
        if (base.version !== 0) warn(`  identity store: ${IDENTITY_FILE} migrated from v${base.version} to v${IDENTITY_SNAPSHOT_VERSION} (snapshot + journal)`);
      }
      return JSON.parse(JSON.stringify(whole)) as FullIdentitySnapshot;
    });

  /** Fold the journal into a new snapshot. Inside the queue. Never fails a commit: a compaction that does not happen
   *  leaves the journal as it was, still complete. */
  async function compactNow(): Promise<void> {
    if (index === null || poisoned !== null) return;
    if (options.writerCheck && !(await options.writerCheck().catch(() => false))) return;
    const whole = checkSnapshot(index.snapshot(), "identity compaction");
    const seq = lastSeq;
    let dirSynced = true;
    const outcome = await durableReplace(io, target, snapshotBytes(whole, seq), { platform, warn, onDirSync: (synced) => (dirSynced = synced) });
    if (outcome.kind !== "committed") {
      /* Either snapshot is loadable against the whole journal, so the journal is kept exactly as it is. */
      warn(`  identity store: compaction at seq ${seq} did not complete (${outcome.detail}); the journal is kept and still complete`);
      return;
    }
    snapshotSeq = seq;
    sinceCompaction = 0;
    const records = journalRecords;
    const bytes = committedEnd;
    bytesAtCompaction = committedEnd;
    /* LIVE-3C (review E14): the journal is emptied only once the new snapshot's directory entry is KNOWN durable. Where
       the platform cannot sync a directory (Windows), a power cut could leave the OLD snapshot beside an emptied
       journal -- revocations, consumed link codes and key rotations rolled back. There the journal is kept whole: every
       line is fsynced, the load skips the ones at or below the snapshot's `seq`, and only the file grows. */
    if (!dirSynced) {
      if (!warnedNoDirSync) {
        warnedNoDirSync = true;
        warn(`  identity store: this platform cannot sync a directory, so compaction keeps ${IDENTITY_JOURNAL_FILE} whole (lines at or below the snapshot's seq are skipped at load)`);
      }
      stats.compactions += 1;
      options.onCompacted?.({ seq, records, bytes });
      return;
    }
    if (journalExists && committedEnd > 0) {
      let handle: StoreFileHandle | null = null;
      try {
        handle = await io.open(journalFile, "r+");
        await handle.truncate(0);
        await handle.sync();
        committedEnd = 0;
        journalRecords = 0;
        bytesAtCompaction = 0;
      } catch (error) {
        /* The snapshot holds everything; the journal's lines are all at or below its `seq` and would be skipped. What
           matters is where the NEXT line goes: if the file is still exactly as long as it was, append after it; if it
           is empty, at 0; anything else is not known -- no more writes until a restart reads the truth. */
        let size: number | null = null;
        try {
          size = handle === null ? null : (await handle.stat()).size;
        } catch {
          size = null;
        }
        if (size === 0) {
          committedEnd = 0;
          journalRecords = 0;
          bytesAtCompaction = 0;
        } else if (size !== committedEnd) {
          poisoned = `the journal could not be truncated after a compaction (${describe(error)})`;
          stats.uncertain += 1;
          options.onRestartRequired?.(poisoned);
        }
        warn(`  identity store: the journal was not truncated after compaction at seq ${seq} (${describe(error)})`);
      } finally {
        if (handle !== null) await handle.close().catch(() => undefined);
      }
    }
    stats.compactions += 1;
    options.onCompacted?.({ seq, records, bytes });
  }

  const commit = (change: IdentityChange, commitOptions?: IdentityCommitOptions): Promise<void> =>
    serial(async () => {
      if (index === null) throw new StoreDefiniteError("the identity store has not been loaded; nothing was written");
      if (poisoned !== null) throw new StoreDefiniteError(`the identity store is held after an unresolved write (${poisoned}); nothing was written`);
      if (options.writerCheck && !(await options.writerCheck().catch(() => false))) {
        stats.definite += 1;
        throw new StoreDefiniteError("this server no longer owns the data directory (its lock was taken over); nothing was written");
      }
      const problem = changeShapeProblem(change) ?? index.check(change, "identity commit") ?? preconditionFailure(index, change.expect);
      if (problem !== null) {
        stats.definite += 1;
        throw new StoreDefiniteError(`${problem}; nothing was written`);
      }
      /* LIVE-5 L5-4 (review F2): the caller's step between this store's checks and its write (its rejection writes nothing). */
      if (commitOptions?.beforeWrite !== undefined) await commitOptions.beforeWrite();
      const seq = lastSeq + 1;
      const bytes = Buffer.from(journalLine(seq, change), "utf8");
      const first = await attempt(bytes, false);
      let settled = first;
      if (first.kind === "uncertain") {
        warn(`  identity store: ${first.detail}; redoing the change at byte ${committedEnd} (LIVE-3 §8.2 step 7)`);
        const redo = await attempt(bytes, true);
        if (redo.kind === "committed") stats.redone += 1;
        settled = redo.kind === "committed" ? redo : { kind: "uncertain", detail: `${first.detail}; the redo failed too: ${(redo as { detail: string }).detail}` };
      }
      if (settled.kind === "definite") {
        stats.definite += 1;
        throw new StoreDefiniteError(settled.detail);
      }
      if (settled.kind === "uncertain") {
        poisoned = settled.detail;
        stats.uncertain += 1;
        options.onRestartRequired?.(settled.detail);
        throw new StoreUncertainError(settled.detail);
      }
      index.apply(change);
      lastSeq = seq;
      committedEnd += bytes.length;
      journalRecords += 1;
      sinceCompaction += 1;
      stats.commits += 1;
      if (sinceCompaction >= compactRecords || committedEnd - bytesAtCompaction >= compactBytes) {
        try {
          await compactNow();
        } catch (error) {
          warn(`  identity store: compaction failed (${describe(error)}); the journal is kept`);
        }
      }
    });

  return {
    file: target,
    journalFile,
    stats,
    load,
    commit,
    compact: () => serial(compactNow),
    health: () => ({
      loaded: index !== null,
      poisoned,
      snapshotSeq,
      lastSeq,
      journalRecords,
      journalBytes: committedEnd,
      compactions: stats.compactions,
      tornBytesRepaired,
      loadedVersion,
      sizes: index?.sizes() ?? { principals: 0, sessions: 0, profiles: 0, links: 0 },
    }),
  };
}
