// server/src/identity/identityJournal.test.ts
//
// LIVE-3C (LIVE-2E review M3): the identity store as a snapshot and a journal -- the load, every crash point of a
// commit and of a compaction, the preconditions, the incremental check against the whole-set check, the migration
// from LIVE-2E's file, and the LIVE-2E account flows (profile, link, recovery rotation, revocation, several devices)
// across restarts over the real HTTP surface.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { nodeStoreFs, type StoreFileHandle, type StoreFs } from "../fileLogStore";
import { StoreDefiniteError, StoreUncertainError } from "../persistence/storeResult";
import { apiRequest, bootstrapCookie, cookieFromAnswer, cookieRead, PROD_ORIGIN, quietConsole, startServer, stopServer } from "../rooms/testSupport";
import { createFileIdentityStore, IDENTITY_FILE } from "./fileStore";
import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoveryKey, mintSecret, mintSessionId, secretHash } from "./ids";
import {
  COMPACT_AFTER_RECORDS,
  createJournalIdentityStore,
  IDENTITY_JOURNAL_FILE,
  IDENTITY_SNAPSHOT_VERSION,
  journalLine,
  scanJournal,
} from "./journalStore";
import { IdentityService } from "./sessions";
import {
  applyChange,
  checkSnapshot,
  IdentityIndex,
  IdentityStoreCorruptError,
  type FullIdentitySnapshot,
  type IdentityChange,
  type LinkCredential,
  type Principal,
  type Profile,
  type Session,
  type SessionFamily,
} from "./store";

quietConsole();

const T0 = 1_760_000_000_000;
const quiet = { warn: () => undefined };
const tmp = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `live3c-idj-${tag}-`));
function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = tmp(tag);
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
const snapshotFile = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8")) as Record<string, unknown> & { version: number; seq: number };
const journalBytes = (dir: string) => (fs.existsSync(path.join(dir, IDENTITY_JOURNAL_FILE)) ? fs.readFileSync(path.join(dir, IDENTITY_JOURNAL_FILE)) : Buffer.alloc(0));
const sorted = (snapshot: FullIdentitySnapshot) => JSON.stringify(applyChange(snapshot, {}));

/* ---- records ---- */
function principal(over: Partial<Principal> = {}): Principal {
  return { principal_id: mintPrincipalId(), kind: "unprofiled", status: "active", created_at: T0, activated_at: T0, last_seen_at: T0, account_link: null, ...over };
}
function session(principalId: string, over: Partial<Session> = {}): Session {
  const sessionId = over.session_id ?? mintSessionId();
  return {
    session_id: sessionId,
    principal_id: principalId,
    secret_hash: secretHash(mintSecret()),
    created_at: T0,
    last_seen_at: T0,
    expires_at: T0 + 30 * 86_400_000,
    revoked_at: null,
    revoke_reason: null,
    rotated_to: null,
    family_id: familyIdOf(sessionId),
    ...over,
  };
}
/** ESCROW-3A: the (open) family a session founds -- committed with it. */
const fam = (s: Session): SessionFamily => ({ family_id: s.family_id, principal_id: s.principal_id, created_at: s.created_at, origin: "bootstrap", revoked_at: null, revoke_reason: null });
/** A change carrying sessions, with the families they found. */
const withFam = (change: IdentityChange): IdentityChange => ({ ...change, families: [...(change.families ?? []), ...(change.sessions ?? []).map(fam).filter((f, at, all) => all.findIndex((g) => g.family_id === f.family_id) === at)] });
function profiled(): { principal: Principal; profile: Profile } {
  const profileId = mintProfileId();
  const p = principal({ kind: "profile", account_link: profileId });
  const key = mintRecoveryKey();
  return {
    principal: p,
    profile: {
      profile_id: profileId,
      principal_id: p.principal_id,
      display_name: "Ann",
      created_at: T0,
      status: "active",
      recovery_selector: key.selector,
      recovery_hash: secretHash(key.secret),
      recovery_rotated_at: T0,
      schema: 1,
    },
  };
}
function link(profileId: string, over: Partial<LinkCredential> = {}): LinkCredential {
  return { link_hash: secretHash(mintSecret()), profile_id: profileId, created_at: T0, expires_at: T0 + 600_000, consumed_at: null, ...over };
}

/** A small, varied identity set, committed change by change. */
function seedChanges(): IdentityChange[] {
  const a = principal();
  const { principal: b, profile } = profiled();
  return [
    withFam({ principals: [a], sessions: [session(a.principal_id)] }),
    withFam({ principals: [b], profiles: [profile], sessions: [session(b.principal_id), session(b.principal_id)] }),
    { links: [link(profile.profile_id)] },
  ];
}

/* ---- a POSIX file system, wherever the suite runs ----
   The truncating compaction happens only once the new snapshot's directory entry is known durable (review E14); a
   Windows checkout cannot sync a directory, so the suites that are ABOUT the truncation say "linux" and give the
   directory a sync that succeeds. (The win32 behaviour has a test of its own.) */
function posixDirs(io: StoreFs = nodeStoreFs): StoreFs {
  return {
    ...io,
    async open(file, flags) {
      if (flags === "r" && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) {
        return { write: async () => ({ bytesWritten: 0 }), stat: async () => ({ size: 0 }), truncate: async () => undefined, sync: async () => undefined, close: async () => undefined };
      }
      return io.open(file, flags);
    },
  };
}
const POSIX = { platform: "linux", fs: posixDirs() };

/* ---- a file system whose next calls can fail ---- */
interface Faults {
  /** Fail the n-th positional write of the journal (1-based) -- after writing `partial` bytes of it. */
  journalWrite?: { n: number; partial: number; times?: number };
  /** Fail the journal's `sync` on the n-th call. */
  journalSync?: { n: number; times?: number };
  /** Fail `truncate` on the journal. */
  journalTruncate?: boolean;
  /** Fail the snapshot's temporary write (definite). */
  snapshotWrite?: boolean;
}
function faultyFs(faults: Faults): { io: StoreFs; counts: { writes: number; syncs: number } } {
  const counts = { writes: 0, syncs: 0 };
  const io: StoreFs = {
    ...nodeStoreFs,
    async open(file, flags) {
      const real = await nodeStoreFs.open(file, flags);
      const journal = file.endsWith(IDENTITY_JOURNAL_FILE);
      const temporary = file.includes(`${IDENTITY_FILE}.`) && file.endsWith(".tmp");
      const handle: StoreFileHandle = {
        async write(buffer, offset, length, position) {
          if (temporary && faults.snapshotWrite) throw Object.assign(new Error("injected ENOSPC on the snapshot"), { code: "ENOSPC" });
          if (!journal) return real.write(buffer, offset, length, position);
          counts.writes += 1;
          const fault = faults.journalWrite;
          if (fault && counts.writes >= fault.n && counts.writes < fault.n + (fault.times ?? 1)) {
            if (fault.partial > 0) await real.write(buffer, offset, Math.min(fault.partial, length), position);
            throw Object.assign(new Error("injected EIO part-way"), { code: "EIO" });
          }
          return real.write(buffer, offset, length, position);
        },
        stat: () => real.stat(),
        async truncate(length) {
          if (journal && faults.journalTruncate && length === 0) throw Object.assign(new Error("injected EIO on truncate"), { code: "EIO" });
          return real.truncate(length);
        },
        async sync() {
          if (journal) {
            counts.syncs += 1;
            const fault = faults.journalSync;
            if (fault && counts.syncs >= fault.n && counts.syncs < fault.n + (fault.times ?? 1)) throw Object.assign(new Error("injected fsync EIO"), { code: "EIO" });
          }
          return real.sync();
        },
        close: () => real.close(),
      };
      return handle;
    },
  };
  return { io, counts };
}

/* ==================================================================
    THE LOAD, THE MIGRATION AND THE ROLLBACK FENCE
   ================================================================== */

describe("LIVE-3C identity journal: load and migration", () => {
  test("a fresh directory: the load writes an empty v3 snapshot before anything else; each change is one synced line; a restart reads the same set", () =>
    withDir("fresh", async (dir) => {
      const store = createJournalIdentityStore(dir, quiet);
      assert.deepEqual(await store.load(), { principals: [], sessions: [], profiles: [], links: [], families: [] });
      assert.deepEqual([snapshotFile(dir).version, snapshotFile(dir).seq], [IDENTITY_SNAPSHOT_VERSION, 0]);
      assert.equal(journalBytes(dir).length, 0, "no journal until the first change");
      const changes = seedChanges();
      for (const change of changes) await store.commit(change);
      const lines = journalBytes(dir).toString("utf8").trim().split("\n");
      assert.equal(lines.length, changes.length, "one line per change");
      assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2, 3]);
      assert.equal(snapshotFile(dir).seq, 0, "the snapshot is not rewritten by a commit");
      const expected = changes.reduce<FullIdentitySnapshot>((acc, change) => applyChange(acc, change), { principals: [], sessions: [], profiles: [], links: [], families: [] });
      const again = await createJournalIdentityStore(dir, quiet).load();
      assert.equal(sorted(again), sorted(expected));
    }));

  test("a LIVE-2E v2 file is migrated at the load, before any journal line -- and LIVE-2E's store then REFUSES the directory (a rollback cannot miss the journal)", () =>
    withDir("migrate", async (dir) => {
      const v2 = createFileIdentityStore(dir, quiet);
      await v2.load();
      for (const change of seedChanges()) await v2.commit(change);
      const before = await createFileIdentityStore(dir, quiet).load();
      assert.equal(snapshotFile(dir).version, 2);
      const store = createJournalIdentityStore(dir, quiet);
      const loaded = await store.load();
      assert.equal(sorted(loaded), sorted(before), "the same set");
      assert.deepEqual([snapshotFile(dir).version, snapshotFile(dir).seq], [IDENTITY_SNAPSHOT_VERSION, 0]); // v4 since ESCROW-3A (families)
      assert.equal(store.health().loadedVersion, 2);
      await store.commit({ principals: [principal()] });
      await assert.rejects(createFileIdentityStore(dir, quiet).load(), IdentityStoreCorruptError, "the older store refuses a v4 snapshot rather than ignoring its journal");
    }));

  test("a journal beside no snapshot, or beside a v2 snapshot, is a disagreement: the load refuses and changes nothing", () =>
    withDir("orphan", async (dir) => {
      fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), journalLine(1, { principals: [principal()] }));
      await assert.rejects(createJournalIdentityStore(dir, quiet).load(), /beside no snapshot/);
      assert.ok(!fs.existsSync(path.join(dir, IDENTITY_FILE)), "no snapshot was written");
      const v2 = createFileIdentityStore(dir, quiet);
      await v2.load();
      await v2.commit({ principals: [principal()] });
      await assert.rejects(createJournalIdentityStore(dir, quiet).load(), /beside a v2 snapshot/);
      assert.equal(snapshotFile(dir).version, 2, "untouched");
    }));

  test("a torn final change -- unterminated, garbled, or failing its digest -- is truncated; the acknowledged changes stand", async () => {
    for (const damage of ["unterminated", "garbled", "digest"] as const) {
      await withDir(`torn-${damage}`, async (dir) => {
        const store = createJournalIdentityStore(dir, quiet);
        await store.load();
        const changes = seedChanges();
        for (const change of changes.slice(0, 2)) await store.commit(change);
        const good = journalBytes(dir);
        const next = journalLine(3, changes[2]);
        const tail =
          damage === "unterminated"
            ? next.slice(0, 40)
            : damage === "garbled"
              ? `${next.slice(0, 30)}\u0000\u0000${next.slice(32)}`
              : next.replace(/"sha256":"[0-9a-f]{8}/, '"sha256":"00000000');
        fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), Buffer.concat([good, Buffer.from(tail, "utf8")]));
        const again = createJournalIdentityStore(dir, quiet);
        const loaded = await again.load();
        const expected = changes.slice(0, 2).reduce<FullIdentitySnapshot>((acc, change) => applyChange(acc, change), { principals: [], sessions: [], profiles: [], links: [], families: [] });
        assert.equal(sorted(loaded), sorted(expected), damage);
        assert.ok(journalBytes(dir).equals(good), `${damage}: cut back to the last whole, verified line`);
        assert.ok(again.health().tornBytesRepaired > 0);
        await again.commit(changes[2]);
        assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(applyChange(expected, changes[2])), "and the next change lands at the cut");
      });
    }
  });

  test("damage with a valid line AFTER it is not a torn write: the load refuses, and the files are left exactly as found", () =>
    withDir("corrupt", async (dir) => {
      const store = createJournalIdentityStore(dir, quiet);
      await store.load();
      const changes = seedChanges();
      for (const change of changes) await store.commit(change);
      const lines = journalBytes(dir).toString("utf8").split("\n");
      lines[1] = `${lines[1].slice(0, 20)}#${lines[1].slice(21)}`;
      fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), lines.join("\n"));
      const before = journalBytes(dir);
      await assert.rejects(createJournalIdentityStore(dir, quiet).load(), /follows damage/);
      assert.ok(journalBytes(dir).equals(before), "untouched");
      // A gap in the sequence, and a change that would half-bind a profile, refuse too.
      fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), journalLine(1, changes[0]) + journalLine(3, changes[2]));
      await assert.rejects(createJournalIdentityStore(dir, quiet).load(), /does not continue/);
      const { principal: p, profile } = profiled();
      fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), journalLine(1, { principals: [p] })); // a profile principal, no profile
      await assert.rejects(createJournalIdentityStore(dir, quiet).load(), /both ways/);
      void profile;
    }));
});

/* ==================================================================
    COMMITS: DEFINITE, UNCERTAIN, REDONE, FENCED
   ================================================================== */

describe("LIVE-3C identity journal: every commit outcome", () => {
  test("a write that fails part-way is REDONE at the same offset (never read back): committed once, one line on disk", () =>
    withDir("redo", async (dir) => {
      const { io } = faultyFs({ journalWrite: { n: 2, partial: 17 } });
      const store = createJournalIdentityStore(dir, { ...quiet, fs: io });
      await store.load();
      const [first, second] = seedChanges();
      await store.commit(first);
      await store.commit(second);
      assert.equal(store.stats.redone, 1);
      assert.equal(journalBytes(dir).toString("utf8").trim().split("\n").length, 2);
      assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(applyChange(applyChange({ principals: [], sessions: [], profiles: [], links: [], families: [] }, first), second)));
    }));

  test("an fsync failure is uncertain even with the bytes readable: redone; if the redo fails too the store is poisoned, asks for a restart, and writes nothing more", () =>
    withDir("poison", async (dir) => {
      let restart: string | null = null;
      const { io } = faultyFs({ journalSync: { n: 2, times: 2 } });
      const store = createJournalIdentityStore(dir, { ...quiet, fs: io, onRestartRequired: (detail) => (restart = detail) });
      await store.load();
      const [first, second, third] = seedChanges();
      await store.commit(first);
      await assert.rejects(store.commit(second), StoreUncertainError);
      assert.ok(restart !== null, "a restart was asked for");
      assert.equal(store.health().poisoned !== null, true);
      const bytesAfter = journalBytes(dir);
      await assert.rejects(store.commit(third), StoreDefiniteError, "poisoned: every later change is refused, nothing written");
      assert.ok(journalBytes(dir).equals(bytesAfter));
      // The restart reads what the disk holds: here the redone line is whole and verified, so it stands (the change
      // was never acknowledged -- the caller was told it failed -- and it is exactly one line: all or nothing).
      const loaded = await createJournalIdentityStore(dir, quiet).load();
      assert.equal(sorted(loaded), sorted(applyChange(applyChange({ principals: [], sessions: [], profiles: [], links: [], families: [] }, first), second)));
    }));

  test("a failure before a byte could be written is DEFINITE; a fenced process (the lock taken over) writes nothing", () =>
    withDir("fenced", async (dir) => {
      let owned = true;
      const store = createJournalIdentityStore(dir, { ...quiet, writerCheck: async () => owned });
      await store.load();
      const [first, second] = seedChanges();
      await store.commit(first);
      owned = false;
      const before = journalBytes(dir);
      await assert.rejects(store.commit(second), (error: Error) => error instanceof StoreDefiniteError && /no longer owns/.test(error.message));
      assert.ok(journalBytes(dir).equals(before));
    }));

  test("preconditions: each one that does not hold refuses the change -- definite, nothing written; one record twice in a change is refused", () =>
    withDir("expect", async (dir) => {
      const store = createJournalIdentityStore(dir, quiet);
      await store.load();
      const unprofiled = principal();
      const live = session(unprofiled.principal_id);
      const revoked = session(unprofiled.principal_id, { revoked_at: T0 + 1, revoke_reason: "logout" });
      const { principal: owner, profile } = profiled();
      const used = link(profile.profile_id, { consumed_at: T0 + 5 });
      const fresh = link(profile.profile_id);
      await store.commit(withFam({ principals: [unprofiled, owner], sessions: [live, revoked], profiles: [profile], links: [used, fresh] }));
      const bytes = journalBytes(dir);
      const refused: IdentityChange[] = [
        { expect: [{ kind: "principal-absent", principal_id: unprofiled.principal_id }], principals: [unprofiled] },
        { expect: [{ kind: "principal-unprofiled", principal_id: owner.principal_id }], principals: [owner] },
        { expect: [{ kind: "profile-absent", profile_id: profile.profile_id }], profiles: [profile] },
        { expect: [{ kind: "selector-unused", recovery_selector: profile.recovery_selector }] },
        { expect: [{ kind: "profile-selector", profile_id: profile.profile_id, recovery_selector: "rk_0000000000000000000000000" }] },
        { expect: [{ kind: "session-absent", session_id: live.session_id }], sessions: [live] },
        { expect: [{ kind: "session-open", session_id: revoked.session_id }], sessions: [{ ...revoked, revoke_reason: "rotated" }] },
        { expect: [{ kind: "session-open", session_id: mintSessionId() }] },
        { expect: [{ kind: "link-absent", link_hash: fresh.link_hash }], links: [fresh] },
        { expect: [{ kind: "link-unconsumed", link_hash: used.link_hash, at: T0 + 10 }], links: [{ ...used }] },
        { expect: [{ kind: "link-unconsumed", link_hash: fresh.link_hash, at: fresh.expires_at }], links: [{ ...fresh, consumed_at: fresh.expires_at }] },
        { sessions: [live, { ...live }] },
        { links: [fresh], dropLinks: [fresh.link_hash] },
      ];
      for (const [at, change] of refused.entries()) {
        await assert.rejects(store.commit(change), StoreDefiniteError, `change #${at}`);
      }
      assert.ok(journalBytes(dir).equals(bytes), "nothing written by any of them");
      // And the same preconditions, holding, let the changes through.
      await store.commit({ expect: [{ kind: "link-unconsumed", link_hash: fresh.link_hash, at: T0 + 10 }], links: [{ ...fresh, consumed_at: T0 + 10 }] });
      await store.commit({ expect: [{ kind: "session-open", session_id: live.session_id }], sessions: [{ ...live, revoked_at: T0 + 20, revoke_reason: "logout" }] });
    }));
});

/* ==================================================================
    COMPACTION AND ITS CRASH POINTS
   ================================================================== */

describe("LIVE-3C identity journal: compaction", () => {
  const changesOf = (n: number): IdentityChange[] => Array.from({ length: n }, () => ({ principals: [principal()] }));
  const expectedOf = (changes: IdentityChange[]) =>
    changes.reduce<FullIdentitySnapshot>((acc, change) => applyChange(acc, change), { principals: [], sessions: [], profiles: [], links: [], families: [] });

  test("every N changes the journal is folded into a new snapshot and truncated; the set is unchanged across restarts", () =>
    withDir("compact", async (dir) => {
      const compacted: number[] = [];
      const store = createJournalIdentityStore(dir, { ...quiet, ...POSIX, compactAfterRecords: 5, onCompacted: (info) => compacted.push(info.seq) });
      await store.load();
      const changes = changesOf(12);
      for (const change of changes) await store.commit(change);
      assert.deepEqual(compacted, [5, 10]);
      assert.equal(snapshotFile(dir).seq, 10);
      assert.equal(journalBytes(dir).toString("utf8").trim().split("\n").length, 2, "only the changes since");
      assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(expectedOf(changes)));
      assert.equal(COMPACT_AFTER_RECORDS, 1_000, "the production interval");
    }));

  test("where a directory cannot be synced (win32), compaction writes the snapshot but keeps the journal whole -- an old snapshot beside it still loads everything", () =>
    withDir("no-dir-sync", async (dir) => {
      const compacted: number[] = [];
      const store = createJournalIdentityStore(dir, { ...quiet, platform: "win32", compactAfterRecords: 5, onCompacted: (info) => compacted.push(info.seq) });
      await store.load();
      const snapshotBefore = fs.readFileSync(path.join(dir, IDENTITY_FILE));
      const changes = changesOf(12);
      for (const change of changes) await store.commit(change);
      assert.deepEqual(compacted, [5, 10]);
      assert.equal(snapshotFile(dir).seq, 10, "the snapshot advanced");
      assert.equal(journalBytes(dir).toString("utf8").trim().split("\n").length, 12, "and the journal was never emptied");
      assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(expectedOf(changes)));
      // The power cut the kept journal is for: the new snapshot's rename lost, the OLD snapshot back beside the journal.
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), snapshotBefore);
      assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(expectedOf(changes)), "nothing rolled back");
    }));

  test("a crash after the new snapshot's rename, before the truncation: the journal's folded lines are skipped at the load", () =>
    withDir("after-rename", async (dir) => {
      const store = createJournalIdentityStore(dir, { ...quiet, ...POSIX });
      await store.load();
      const changes = changesOf(4);
      for (const change of changes) await store.commit(change);
      const journal = journalBytes(dir);
      await store.compact(); // the snapshot at seq 4 and a truncated journal
      fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), journal); // put the folded lines back: the crash's shape
      const again = createJournalIdentityStore(dir, quiet);
      assert.equal(sorted(await again.load()), sorted(expectedOf(changes)));
      const more = changesOf(1);
      await again.commit(more[0]);
      assert.equal(JSON.parse(journalBytes(dir).toString("utf8").trim().split("\n").pop() as string).seq, 5, "appended after the folded lines, seq 5");
      assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(expectedOf([...changes, ...more])));
      // Folded lines out of order are not a crash's shape: refused.
      fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), journalLine(2, changes[1]) + journalLine(1, changes[0]));
      await assert.rejects(createJournalIdentityStore(dir, quiet).load(), /not contiguous/);
    }));

  test("a snapshot write that fails keeps the whole journal (nothing truncated); a truncation that fails is appended after", async () => {
    await withDir("snapshot-fails", async (dir) => {
      const failing = faultyFs({ snapshotWrite: true });
      await createJournalIdentityStore(dir, quiet).load(); // the v3 snapshot at seq 0, written before the fault is armed
      const store = createJournalIdentityStore(dir, { ...quiet, fs: failing.io, compactAfterRecords: 3 });
      await store.load();
      const changes = changesOf(5);
      for (const change of changes) await store.commit(change);
      assert.equal(store.stats.compactions, 0, "the compaction could not happen");
      assert.equal(snapshotFile(dir).seq, 0, "the old snapshot stands");
      assert.equal(journalBytes(dir).toString("utf8").trim().split("\n").length, 5, "and the whole journal with it");
      assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(expectedOf(changes)));
    });
    await withDir("truncate-fails", async (dir) => {
      const { io } = faultyFs({ journalTruncate: true });
      const store = createJournalIdentityStore(dir, { ...quiet, platform: "linux", fs: posixDirs(io), compactAfterRecords: 3 });
      await store.load();
      const changes = changesOf(5);
      for (const change of changes) await store.commit(change);
      assert.equal(snapshotFile(dir).seq, 3, "the snapshot was replaced");
      assert.equal(store.health().poisoned, null, "the journal was untouched, so the next line simply follows it");
      assert.deepEqual(
        journalBytes(dir).toString("utf8").trim().split("\n").map((line) => JSON.parse(line).seq),
        [1, 2, 3, 4, 5],
      );
      assert.equal(sorted(await createJournalIdentityStore(dir, quiet).load()), sorted(expectedOf(changes)));
    });
  });

  test("the scan is pure: lines at or below the snapshot are skipped, the rest must continue it", () => {
    const changes = changesOf(3);
    const bytes = Buffer.from(changes.map((change, at) => journalLine(at + 1, change)).join(""), "utf8");
    assert.deepEqual([scanJournal(bytes, 0).changes.length, scanJournal(bytes, 0).skipped], [3, 0]);
    assert.deepEqual([scanJournal(bytes, 2).changes.length, scanJournal(bytes, 2).skipped], [1, 2]);
    assert.deepEqual([scanJournal(bytes, 3).changes.length, scanJournal(bytes, 3).skipped], [0, 3]);
    assert.equal(scanJournal(bytes, 5).classification, "clean", "a snapshot ahead of every line: all folded");
    assert.equal(scanJournal(Buffer.from(journalLine(3, changes[0]), "utf8"), 1).classification, "corrupt", "a gap after the snapshot");
  });
});

/* ==================================================================
    THE INCREMENTAL CHECK IS THE WHOLE-SET CHECK
   ================================================================== */

describe("LIVE-3C identity journal: O(change) validation", () => {
  test("random changes, valid and broken: the incremental check refuses exactly what the whole-set check refuses (2,000 changes)", () => {
    let seed = 0x3c3c3c3c;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    let state: FullIdentitySnapshot = { principals: [], sessions: [], profiles: [], links: [], families: [] };
    let index = IdentityIndex.from(state);
    let agreed = 0;
    let refused = 0;
    for (let step = 0; step < 2_000; step += 1) {
      const principals = state.principals;
      const profiles = state.profiles;
      const choice = Math.floor(random() * 11);
      let change: IdentityChange;
      if (choice === 0 || principals.length === 0) change = { principals: [principal()] };
      else if (choice === 1) {
        const { principal: p, profile } = profiled();
        change = random() < 0.5 ? { principals: [p], profiles: [profile] } : random() < 0.5 ? { principals: [p] } : { profiles: [profile] };
      } else if (choice === 2) change = withFam({ sessions: [session(pick(principals).principal_id)] });
      else if (choice === 3) change = withFam({ sessions: [session(mintPrincipalId())] }); // names no principal
      else if (choice === 4 && profiles.length > 0) change = { links: [link(pick(profiles).profile_id)] };
      else if (choice === 5) change = { links: [link(mintProfileId())] }; // names no profile
      else if (choice === 6 && profiles.length > 0) {
        const target = pick(profiles);
        change = random() < 0.5 ? { profiles: [{ ...target, recovery_selector: mintRecoveryKey().selector }] } : { profiles: [{ ...target, principal_id: pick(principals).principal_id }] };
      } else if (choice === 7 && profiles.length > 1) {
        const [a, b] = [pick(profiles), pick(profiles)];
        change = { profiles: [{ ...a, recovery_selector: b.recovery_selector }] }; // a selector twice (or itself)
      } else if (choice === 8) {
        const target = pick(principals);
        change = random() < 0.5 ? { principals: [{ ...target, kind: "unprofiled", account_link: null }] } : { principals: [{ ...target, last_seen_at: target.last_seen_at + 1 }] };
      } else if (choice === 9 && state.sessions.length > 0) change = { dropSessions: [pick(state.sessions).session_id] };
      else change = { principals: [{ ...principal(), activated_at: null }] }; // never activated
      const incremental = index.check(change, "random") === null;
      let whole: boolean;
      try {
        checkSnapshot(applyChange(state, change), "random");
        whole = true;
      } catch {
        whole = false;
      }
      assert.equal(incremental, whole, `step ${step}: ${JSON.stringify(change).slice(0, 200)}`);
      agreed += 1;
      if (whole) {
        state = applyChange(state, change);
        index.apply(change);
      } else {
        refused += 1;
      }
      if (step % 250 === 0) index = IdentityIndex.from(checkSnapshot(state, "rebuilt")); // the rebuilt index agrees too
    }
    assert.equal(agreed, 2_000);
    assert.ok(refused > 200 && refused < 1_800, `a real mix of verdicts (${refused} refused)`);
  });

  test("a commit's cost does not grow with the set: 20,000 profiles, and each change writes one line and leaves the snapshot alone", () =>
    withDir("scale", async (dir) => {
      const store = createJournalIdentityStore(dir, quiet);
      await store.load();
      const big: IdentityChange = { principals: [], profiles: [] };
      const principalsOut: Principal[] = [];
      const profilesOut: Profile[] = [];
      for (let n = 0; n < 20_000; n += 1) {
        const pair = profiled();
        principalsOut.push(pair.principal);
        profilesOut.push(pair.profile);
      }
      await store.commit({ principals: principalsOut, profiles: profilesOut });
      await store.compact();
      const snapshotBefore = fs.statSync(path.join(dir, IDENTITY_FILE));
      assert.ok(snapshotBefore.size > 5_000_000, `a large snapshot (${snapshotBefore.size} bytes)`);
      const journalBefore = journalBytes(dir).length;
      const started = Date.now();
      for (let n = 0; n < 50; n += 1) await store.commit(withFam({ sessions: [session(principalsOut[n].principal_id)] }));
      const took = Date.now() - started;
      const snapshotAfter = fs.statSync(path.join(dir, IDENTITY_FILE));
      assert.equal(snapshotAfter.mtimeMs, snapshotBefore.mtimeMs, "the snapshot was not rewritten by any of the 50 changes");
      const grown = journalBytes(dir).length - journalBefore;
      assert.ok(grown < 50 * 1_000, `the journal grew by one small line per change (${grown} bytes for 50)`);
      assert.equal(store.health().sizes.profiles, 20_000);
      void big;
      void took;
    }));
});

/* ==================================================================
    THE LIVE-2E ACCOUNT FLOWS OVER THE JOURNAL, ACROSS RESTARTS
   ================================================================== */

describe("LIVE-3C identity journal: the LIVE-2E account across restarts", () => {
  const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });

  async function journalServer(dir: string, compactAfterRecords = COMPACT_AFTER_RECORDS) {
    const store = createJournalIdentityStore(dir, { ...quiet, compactAfterRecords });
    const service = await IdentityService.open(store);
    const started = await startServer({ identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, service } });
    return { ...started, store, service };
  }

  test("profile, two devices, a rotated recovery key, a revoked session, a consumed and an outstanding link code -- all as they were after each restart, through a compaction", () =>
    withDir("flows", async (dir) => {
      let run = await journalServer(dir, 4);
      try {
        await flows();
      } finally {
        await stopServer(run.server).catch(() => undefined);
      }
      async function flows(): Promise<void> {
      const deviceA = await bootstrapCookie(run.port);
      const created = await post(run.port, "/gs/api/profile", deviceA, { name: "Ann" });
      assert.equal(created.status, 201);
      const firstKey = (created.body as { recoveryKey: string }).recoveryKey;
      // A second device, by a link code (consumed); then a third code left outstanding.
      const code1 = (await post(run.port, "/gs/api/profile/link-code", deviceA)).body as { code: string };
      const deviceBBoot = await bootstrapCookie(run.port);
      const linked = await post(run.port, "/gs/api/profile/link", deviceBBoot, { code: code1.code });
      assert.equal(linked.status, 200);
      const deviceB = cookieFromAnswer(linked) as string;
      // A third device signs in and is signed out again (its cookie is revoked).
      const code2 = (await post(run.port, "/gs/api/profile/link-code", deviceA)).body as { code: string };
      const deviceCBoot = await bootstrapCookie(run.port);
      const deviceC = cookieFromAnswer(await post(run.port, "/gs/api/profile/link", deviceCBoot, { code: code2.code })) as string;
      assert.equal((await post(run.port, "/gs/api/session/revoke", deviceC)).status, 204);
      // The recovery key is rotated (after re-authenticating with it -- ESCROW-3A).
      assert.equal((await post(run.port, "/gs/api/profile/reauth", deviceA, { recoveryKey: firstKey })).status, 200);
      const rotated = await post(run.port, "/gs/api/profile/recovery-key", deviceA);
      assert.equal(rotated.status, 200);
      const secondKey = (rotated.body as { recoveryKey: string }).recoveryKey;
      // An outstanding code, issued last (after the rotation retired every earlier one).
      const outstanding = (await post(run.port, "/gs/api/profile/link-code", deviceA)).body as { code: string };
      assert.ok(run.store.stats.compactions >= 1, "at least one compaction happened along the way");
      const principalA = run.service.authenticate(cookieRead(deviceA), Date.now());
      await stopServer(run.server);

      for (let restart = 0; restart < 2; restart += 1) {
        run = await journalServer(dir, 4);
        const who = run.service.authenticate(cookieRead(deviceA), Date.now());
        assert.equal(who.kind, "ok", `device A's session is still valid (restart ${restart})`);
        assert.equal(run.service.authenticate(cookieRead(deviceB), Date.now()).kind, "ok", "device B too");
        assert.deepEqual(who.kind === "ok" && principalA.kind === "ok" ? who.principalId === principalA.principalId : false, true, "the same principal");
        assert.deepEqual((await post(run.port, "/gs/api/session", deviceC)).status, 401, "the revoked cookie stays ended");
        const oldKey = await post(run.port, "/gs/api/profile/recover", await bootstrapCookie(run.port), { recoveryKey: firstKey });
        assert.equal(oldKey.status, 403, "the rotated-away key stays dead");
        const replay = await post(run.port, "/gs/api/profile/link", await bootstrapCookie(run.port), { code: code1.code });
        assert.equal(replay.status, 403, "the consumed code stays consumed");
        await stopServer(run.server);
      }
      run = await journalServer(dir, 4);
      const redeemed = await post(run.port, "/gs/api/profile/link", await bootstrapCookie(run.port), { code: outstanding.code });
      assert.equal(redeemed.status, 200, "the outstanding code, issued before two restarts, still signs a device in");
      const recovered = await post(run.port, "/gs/api/profile/recover", await bootstrapCookie(run.port), { recoveryKey: secondKey });
      assert.equal(recovered.status, 200, "the rotated key works");
      await stopServer(run.server);
      const files = [IDENTITY_FILE, IDENTITY_JOURNAL_FILE].map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
      for (const secret of [firstKey, secondKey, code1.code, outstanding.code, deviceA.split(".")[2], deviceB.split(".")[2]]) {
        assert.ok(!files.includes(secret), "no credential in the clear on disk");
      }
      }
    }));
});
