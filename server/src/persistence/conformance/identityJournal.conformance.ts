// server/src/persistence/conformance/identityJournal.conformance.ts
//
// LIVE-5 L5-1: the identity port (`IdentityStore`: `load` everything, `commit` one change under its PRECONDITIONS --
// each one becomes a DynamoDB condition in L5-4) and the signing journal (`SigningJournal`: first writer wins per
// (instance, seq, signer key), append-only, never rolled back; the ledger in L5-5).

import assert from "node:assert/strict";

import type { IdentityChange, IdentityPrecondition, IdentityStore } from "../../identity/store";
import type { InspectableSigningJournal } from "../../escrow/signingJournal";
import type { Gate } from "./faults";
import { anotherSession, identitySet, type IdentitySet } from "./fixtures";
import { T0, hook, rejection, stalledAt, type CaseContext, type ConformanceCase, type SubjectBase } from "./harness";

/* ================================================================== */
/*  Identity                                                           */
/* ================================================================== */

export interface IdentitySubject extends SubjectBase {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<IdentityStore>;
  /** Everything the store holds durably, as bytes or text -- "nothing was written" is always checked. */
  stored(ctx: CaseContext): Promise<Buffer | string | null>;
  /** "plant": damage the stored identity (a restart must then refuse to load, never guess). */
  plant?(ctx: CaseContext): Promise<void>;
  /** "stall-write": hold the next commit after the writer's own checks, before it is applied. */
  stallNextWrite?(ctx: CaseContext): Gate;
  /** "inject-lost-answer": the next commit lands, and its answer is lost. */
  armLostAnswer?(ctx: CaseContext): void;
  /** "inject-transient-failure": the next commit fails before it has any effect. */
  armTransientFailure?(ctx: CaseContext): void;
}

const isDefinite = (error: unknown) => error instanceof Error && error.name === "StoreDefiniteError";

/** The change a first profile creation commits (principal, profile, session, family), with its create-if-absent terms. */
const profileCreation = (set: IdentitySet): IdentityChange => ({
  expect: [
    { kind: "principal-absent", principal_id: set.principal.principal_id },
    { kind: "profile-absent", profile_id: set.profile.profile_id },
    { kind: "selector-unused", recovery_selector: set.profile.recovery_selector },
    { kind: "session-absent", session_id: set.session.session_id },
    { kind: "family-absent", family_id: set.family.family_id },
  ],
  principals: [set.profiledPrincipal],
  profiles: [set.profile],
  sessions: [set.session],
  families: [set.family],
});

async function seededIdentity(subject: IdentitySubject, ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }) {
  const store = await subject.open(ctx, options);
  await store.load();
  const set = identitySet(1);
  await store.commit(profileCreation(set));
  return { store, set };
}

async function refused(subject: IdentitySubject, ctx: CaseContext, store: IdentityStore, change: IdentityChange, label: string): Promise<void> {
  const before = JSON.stringify(await store.load());
  const bytes = await subject.stored(ctx);
  const error = await rejection(store.commit(change));
  assert.ok(isDefinite(error), `${label}: expected StoreDefiniteError, got ${String(error)}`);
  assert.equal(JSON.stringify(await store.load()), before, `${label}: nothing was written`);
  assert.deepEqual(await subject.stored(ctx), bytes, `${label}: the stored bytes are unchanged`);
}

export const IDENTITY_CASES: readonly ConformanceCase<IdentitySubject>[] = [
  {
    id: "ID-01",
    title: "an empty store loads an empty identity set",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.deepEqual(await store.load(), { principals: [], sessions: [], profiles: [], links: [], families: [] });
    },
  },
  {
    id: "ID-02",
    title: "create and read: a profile creation is committed whole and loads back exactly",
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      const loaded = await store.load();
      assert.deepEqual(loaded.principals, [set.profiledPrincipal]);
      assert.deepEqual(loaded.profiles, [set.profile]);
      assert.deepEqual(loaded.sessions, [set.session]);
      assert.deepEqual(loaded.families, [set.family]);
    },
  },
  {
    id: "ID-03",
    title: "duplicate delivery: a creation delivered twice is refused DEFINITE by its own create-if-absent terms; nothing changes",
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      await refused(subject, ctx, store, profileCreation(set), "the repeated creation");
    },
  },
  {
    id: "ID-04",
    title: "every precondition kind: a failing term refuses the whole change DEFINITE and writes nothing",
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      const other = identitySet(2);
      const rotated = anotherSession(set, "rotated");
      const cases: Array<[string, IdentityPrecondition]> = [
        ["principal-absent (it exists)", { kind: "principal-absent", principal_id: set.principal.principal_id }],
        ["principal-unprofiled (it is profiled)", { kind: "principal-unprofiled", principal_id: set.principal.principal_id }],
        ["principal-unprofiled (it does not exist)", { kind: "principal-unprofiled", principal_id: other.principal.principal_id }],
        ["profile-absent (it exists)", { kind: "profile-absent", profile_id: set.profile.profile_id }],
        ["selector-unused (it is used)", { kind: "selector-unused", recovery_selector: set.profile.recovery_selector }],
        ["profile-selector (another selector)", { kind: "profile-selector", profile_id: set.profile.profile_id, recovery_selector: other.profile.recovery_selector }],
        ["session-absent (it exists)", { kind: "session-absent", session_id: set.session.session_id }],
        ["session-open (no such session)", { kind: "session-open", session_id: rotated.session_id }],
        ["link-absent -> link-unconsumed (no such link)", { kind: "link-unconsumed", link_hash: set.link.link_hash, at: T0 }],
        ["family-absent (it exists)", { kind: "family-absent", family_id: set.family.family_id }],
        ["family-open (no such family)", { kind: "family-open", family_id: other.family.family_id }],
      ];
      for (const [label, condition] of cases) await refused(subject, ctx, store, { expect: [condition], sessions: [rotated] }, label);
      /* The terms whose refusal needs a stored state first: a link that exists, a session logged out, a family revoked. */
      await store.commit({ expect: [{ kind: "link-absent", link_hash: set.link.link_hash }], links: [set.link] });
      await refused(subject, ctx, store, { expect: [{ kind: "link-absent", link_hash: set.link.link_hash }], links: [{ ...set.link, created_at: T0 + 1 }] }, "link-absent (it exists)");
      const second = anotherSession(set, "second");
      await store.commit({ expect: [{ kind: "session-absent", session_id: second.session_id }], sessions: [second] });
      await store.commit({ expect: [{ kind: "session-open", session_id: second.session_id }], sessions: [{ ...second, revoked_at: T0 + 2, revoke_reason: "logout" }] });
      await refused(subject, ctx, store, { expect: [{ kind: "session-open", session_id: second.session_id }], sessions: [{ ...second, revoked_at: T0 + 3, revoke_reason: "rotated", rotated_to: rotated.session_id }] }, "session-open (logged out: a rotation racing a logout never resurrects it)");
      await store.commit({ expect: [{ kind: "family-open", family_id: set.family.family_id }], families: [{ ...set.family, revoked_at: T0 + 4, revoke_reason: "signed-out-remotely" }] });
      await refused(subject, ctx, store, { expect: [{ kind: "family-open", family_id: set.family.family_id }, { kind: "session-absent", session_id: rotated.session_id }], sessions: [rotated] }, "family-open (revoked: no mint into a closed family)");
    },
  },
  {
    id: "ID-05",
    title: "stale writer: a recovery-key rotation CAS (profile-selector) succeeds once; the second rotation from the same selector is refused",
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      const next = identitySet(3).profile;
      const rotate = (selector: string, to: string): IdentityChange => ({
        expect: [{ kind: "profile-selector", profile_id: set.profile.profile_id, recovery_selector: selector }, { kind: "selector-unused", recovery_selector: to }],
        profiles: [{ ...set.profile, recovery_selector: to, recovery_hash: next.recovery_hash, recovery_rotated_at: ctx.tick() }],
      });
      await store.commit(rotate(set.profile.recovery_selector, next.recovery_selector));
      await refused(subject, ctx, store, rotate(set.profile.recovery_selector, identitySet(4).profile.recovery_selector), "the stale rotation");
      assert.equal((await store.load()).profiles[0].recovery_selector, next.recovery_selector);
    },
  },
  {
    id: "ID-06",
    title: "single use: a link code is consumed once (link-unconsumed), and an expired one never",
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      await store.commit({ expect: [{ kind: "link-absent", link_hash: set.link.link_hash }], links: [set.link] });
      const consume = (tag: string, at: number): IdentityChange => {
        const session = anotherSession(set, tag);
        return {
          expect: [{ kind: "link-unconsumed", link_hash: set.link.link_hash, at }, { kind: "session-absent", session_id: session.session_id }, { kind: "family-open", family_id: set.family.family_id }],
          links: [{ ...set.link, consumed_at: at }],
          sessions: [session],
        };
      };
      await refused(subject, ctx, store, consume("late", set.link.expires_at), "an expired code");
      await store.commit(consume("first", T0 + 1));
      await refused(subject, ctx, store, consume("second", T0 + 2), "a second redemption");
    },
  },
  {
    id: "ID-07",
    title: "a revoked family is closed for good: family-open fails, and it survives a restart",
    needs: ["durable"],
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      await store.commit({
        expect: [{ kind: "family-open", family_id: set.family.family_id }],
        families: [{ ...set.family, revoked_at: T0 + 5, revoke_reason: "logout" }],
        sessions: [{ ...set.session, revoked_at: T0 + 5, revoke_reason: "logout" }],
      });
      const mint = anotherSession(set, "grace");
      const reopened = await subject.open(ctx);
      assert.equal((await reopened.load()).families[0].revoked_at, T0 + 5);
      await refused(subject, ctx, reopened, { expect: [{ kind: "family-open", family_id: set.family.family_id }, { kind: "session-absent", session_id: mint.session_id }], sessions: [mint] }, "a mint into the revoked family");
    },
  },
  {
    id: "ID-08",
    title: "a change that names one record twice, or breaks a relation, is refused DEFINITE",
    needs: ["validates-shape"],
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      await refused(subject, ctx, store, { sessions: [set.session, { ...set.session, last_seen_at: T0 + 1 }] }, "one session twice");
      const orphan = anotherSession(set, "orphan", { family_id: identitySet(9).family.family_id });
      await refused(subject, ctx, store, { sessions: [orphan] }, "a session with no family of its principal");
    },
  },
  {
    id: "ID-09",
    title: "fence: after a takeover the stale writer's commit is DEFINITE and writes nothing",
    needs: ["fence"],
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx, { writerCheck: ctx.fence.writer() });
      await ctx.fence.takeOver();
      const session = anotherSession(set, "after-takeover");
      await refused(subject, ctx, store, { expect: [{ kind: "session-absent", session_id: session.session_id }], sessions: [session] }, "the fenced commit");
      const current = await subject.open(ctx);
      assert.deepEqual((await current.load()).sessions, [set.session]);
    },
  },
  {
    id: "ID-10",
    title: "restart: everything committed loads back; dropped sessions and links stay dropped",
    needs: ["durable"],
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      const extra = anotherSession(set, "extra");
      await store.commit({ sessions: [extra], links: [set.link] });
      await store.commit({ dropSessions: [extra.session_id], dropLinks: [set.link.link_hash] });
      const loaded = await (await subject.open(ctx)).load();
      assert.deepEqual(loaded.sessions, [set.session]);
      assert.deepEqual(loaded.links, []);
      assert.deepEqual(loaded.profiles, [set.profile]);
    },
  },
  {
    id: "ID-11",
    title: "damaged storage refuses to load (the server then refuses to start) -- it is never guessed at",
    needs: ["plant", "durable"],
    async run(subject, ctx) {
      await seededIdentity(subject, ctx);
      await hook(subject.plant, "plant")(ctx);
      const reopened = await subject.open(ctx);
      await rejection(reopened.load());
    },
  },
  {
    id: "ID-12",
    title: "idempotent retry: a commit whose answer was lost after it landed resolves durable, applied once",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      const extra = anotherSession(set, "lost-answer");
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      await store.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] });
      const reopened = await subject.open(ctx);
      assert.deepEqual((await reopened.load()).sessions.map((s) => s.session_id).sort(), [set.session.session_id, extra.session_id].sort());
      await refused(subject, ctx, reopened, { expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] }, "the same change again");
    },
  },
  {
    id: "ID-13",
    title: "transient failure: a commit that failed before any effect is DEFINITE, writes nothing, and the retry commits",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx);
      const extra = anotherSession(set, "transient");
      const change: IdentityChange = { expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] };
      hook(subject.armTransientFailure, "armTransientFailure")(ctx);
      await refused(subject, ctx, store, change, "the failed commit");
      await store.commit(change);
      assert.equal((await store.load()).sessions.length, 2);
    },
  },
  {
    id: "ID-14",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its commit is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const { store, set } = await seededIdentity(subject, ctx, { writerCheck: ctx.fence.writer() });
      const before = await subject.stored(ctx);
      const extra = anotherSession(set, "in-flight");
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx);
      const pending = store.commit({ expect: [{ kind: "session-absent", session_id: extra.session_id }], sessions: [extra] });
      await stalledAt(stall, pending, "the stale commit");
      await ctx.fence.takeOver();
      stall.release();
      const error = await pending.then(() => null, (thrown: unknown) => thrown);
      assert.ok(error !== null && isDefinite(error), "FENCE-IN-WRITE: the stale writer's in-flight commit was applied");
      assert.deepEqual(await subject.stored(ctx), before);
    },
  },
];

/* ================================================================== */
/*  Signing journal                                                    */
/* ================================================================== */

/** What `plant` places (L5-5: semantic, so a DynamoDB ledger and a file journal can each place it their own way).
 *  `torn-tail` is a file concern (a transaction cannot tear): only a subject declaring "torn-tail" is asked for it. */
export type JournalPlant =
  | { readonly kind: "torn-tail" }
  | { readonly kind: "corrupt" | "newer"; readonly instance: string; readonly seq: string; readonly signer_key_id: number }
  | { readonly kind: "corrupt-attempt" | "newer-attempt"; readonly intent_id: string; readonly tx_id: string; readonly account: string; readonly sequence: string };

export interface JournalSubject extends SubjectBase {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<InspectableSigningJournal>;
  /** The journal's stored records (append-only evidence), as bytes or text -- "nothing was written" is always checked.
   *  A ledger's fence items (its generation, its relayer fence) are not records and are not included. */
  stored(ctx: CaseContext): Promise<Buffer | string | null>;
  /** "plant": place stored state the journal did not write (damage, a newer build's record, a torn tail). */
  plant?(ctx: CaseContext, what: JournalPlant): Promise<void>;
  /** "inject-transient-failure": the next write fails before anything is recorded. */
  armTransientFailure?(ctx: CaseContext): void;
  /** "inject-lost-answer": the next write lands, and its answer is lost. */
  armLostAnswer?(ctx: CaseContext): void;
  /** "stall-write": hold the next write after the writer's own checks, before it is applied. */
  stallNextWrite?(ctx: CaseContext): Gate;
  /** "fs-faults": hold the next append at its byte write -- after every check the journal makes before writing. */
  stallAtByteWrite?(ctx: CaseContext): Gate;
  /** "inject-lost-answer" + "fence-in-write": the next write's first attempt ends UNKNOWN to the writer -- having
   *  `landed` or not -- and its resend stalls at the returned gate (a takeover is placed between the two). */
  armUnknownThenStallResend?(ctx: CaseContext, landed: boolean): Gate;
  /** "idempotency-token": the client request token of every write attempt, in order. */
  writeTokens?(ctx: CaseContext): string[];
  /** "inject-unresolved": the next write's outcome stays unknown however it is retried (`landed`: it applied). */
  armUnresolvedWrite?(ctx: CaseContext, landed: boolean): void;
}

const INSTANCE = "5:juno|7:uni-7|4:conf|1:7";
const RELAYER = "juno1relayer";
const digest = (byte: string) => ({ codec: "18JUNO/v1" as const, purpose: "settle" as const, hex: byte.repeat(32) });
const reserve = (journal: InspectableSigningJournal, seq: string, byte: string, key = 1, instance = INSTANCE) => journal.reserveSettlement({ instance, seq, signer_key_id: key, digest: digest(byte) });
const TX = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");
const attempt = (n: number, over: Partial<{ intent_id: string; tx_id: string; account_sequence: string; expires_after_height: string }> = {}) => ({ intent_id: "ab".repeat(32), tx_id: TX(n), account: RELAYER, account_sequence: String(n), expires_after_height: String(100 + n), ...over });
const refusedAs = { kind: "refused" as const };
/** The digest a slot holds after everything settled (`null`: none), read through a journal that opened. */
const slotHolds = async (journal: InspectableSigningJournal, seq: string, key = 1): Promise<string | null> => (await journal.reservations(INSTANCE)).find((entry) => entry.seq === seq && entry.signer_key_id === key)?.digest_hex ?? null;
const signs = (outcome: { kind: string }) => outcome.kind === "reserved" || outcome.kind === "same";

export const JOURNAL_CASES: readonly ConformanceCase<JournalSubject>[] = [
  {
    id: "JNL-01",
    title: "first writer wins per (instance, seq, key): reserved, then the same digest is `same`, another digest a CONFLICT naming the first",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      assert.deepEqual(await reserve(journal, "2", "aa"), { kind: "reserved" });
      assert.deepEqual(await reserve(journal, "2", "aa"), { kind: "same" }, "duplicate delivery of one reservation");
      assert.deepEqual(await reserve(journal, "2", "bb"), { kind: "conflict", digest_hex: "aa".repeat(32) });
      assert.deepEqual(await reserve(journal, "2", "bb", 2), { kind: "reserved" }, "another signer key is another slot");
      assert.deepEqual(await reserve(journal, "2", "bb", 1, `${INSTANCE}x`), { kind: "reserved" }, "another instance is another slot");
      assert.deepEqual((await journal.reservations(INSTANCE)).map((r) => [r.seq, r.signer_key_id, r.digest_hex.slice(0, 2)]), [["2", 1, "aa"], ["2", 2, "bb"]]);
    },
  },
  {
    id: "JNL-02",
    title: "highestReserved orders sequences as numbers (10 > 9), per instance",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      assert.equal(await journal.highestReserved(INSTANCE), null);
      for (const seq of ["9", "10", "2"]) await reserve(journal, seq, "cd");
      assert.deepEqual(await journal.highestReserved(INSTANCE), { seq: "10" });
      assert.equal(await journal.highestReserved(`${INSTANCE}x`), null);
    },
  },
  {
    id: "JNL-02-u64",
    title: "highestReserved stays numeric across the whole u64 range (the chain's seq), whatever the order written",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      for (const seq of ["100000", "18446744073709551615", "9", "18446744073709551614", "10"]) assert.deepEqual(await reserve(journal, seq, "cd"), { kind: "reserved" });
      assert.deepEqual(await journal.highestReserved(INSTANCE), { seq: "18446744073709551615" });
      assert.deepEqual((await journal.reservations(INSTANCE)).map((r) => r.seq).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)), ["9", "10", "100000", "18446744073709551614", "18446744073709551615"]);
    },
  },
  {
    id: "JNL-03",
    title: "a non-canonical sequence is refused and records nothing",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const before = await subject.stored(ctx);
      await rejection(reserve(journal, "007", "aa"));
      await rejection(reserve(journal, "-1", "aa"));
      await rejection(reserve(journal, "1e3", "aa"));
      assert.deepEqual(await journal.reservations(INSTANCE), []);
      assert.deepEqual(await subject.stored(ctx), before);
    },
  },
  {
    id: "JNL-04",
    title: "attempts are recorded once per transaction id, per intent, in order",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      await journal.recordAttempt(attempt(1));
      await journal.recordAttempt(attempt(1));
      await journal.recordAttempt(attempt(2));
      assert.deepEqual((await journal.attemptsOf("ab".repeat(32))).map((a) => a.tx_id), [TX(1), TX(2)]);
      assert.equal((await journal.allAttempts(RELAYER)).length, 2);
      await rejection(journal.recordAttempt({ ...attempt(3), expires_after_height: "01" }));
    },
  },
  {
    id: "JNL-05",
    title: "restart: reservations and attempts survive, and first-writer-wins holds across the restart",
    needs: ["durable"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      await reserve(journal, "4", "aa");
      await journal.recordAttempt({ intent_id: "cd".repeat(32), tx_id: TX(7), account: RELAYER, account_sequence: "7" });
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reserve(reopened, "4", "bb"), { kind: "conflict", digest_hex: "aa".repeat(32) });
      assert.deepEqual(await reopened.highestReserved(INSTANCE), { seq: "4" });
      assert.deepEqual((await reopened.allAttempts(RELAYER)).map((a) => a.tx_id), [TX(7)]);
    },
  },
  {
    id: "JNL-06",
    title: "append-only: every earlier record's bytes stand unchanged after later appends",
    needs: ["durable"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      await reserve(journal, "1", "aa");
      const early = Buffer.from((await subject.stored(ctx)) ?? "");
      await reserve(journal, "2", "bb");
      await reserve(journal, "1", "cc");
      const late = Buffer.from((await subject.stored(ctx)) ?? "");
      assert.ok(late.length > early.length);
      assert.deepEqual(late.subarray(0, early.length), early);
    },
  },
  {
    id: "JNL-07",
    title: "a torn final record (a crash mid-append, never acknowledged) is cut at open; everything before it stands",
    needs: ["durable", "plant", "torn-tail"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      await reserve(journal, "1", "aa");
      await hook(subject.plant, "plant")(ctx, { kind: "torn-tail" });
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reserve(reopened, "1", "aa"), { kind: "same" });
      assert.deepEqual(await reserve(reopened, "2", "bb"), { kind: "reserved" });
    },
  },
  ...(["corrupt", "newer"] as const).map(
    (what): ConformanceCase<JournalSubject> => ({
      id: what === "corrupt" ? "JNL-08" : "JNL-08-newer",
      title:
        what === "corrupt"
          ? "damage fails closed: a damaged reservation refuses the open, or every read and write that touches it -- never guessed at, never overwritten"
          : "a newer build's reservation fails closed the same way: never interpreted, never overwritten",
      needs: ["durable", "plant"],
      async run(subject, ctx) {
        const journal = await subject.open(ctx);
        await reserve(journal, "1", "aa");
        await reserve(journal, "2", "bb");
        await hook(subject.plant, "plant")(ctx, { kind: what, instance: INSTANCE, seq: "1", signer_key_id: 1 });
        const before = await subject.stored(ctx);
        const reopened = await subject.open(ctx).catch(() => null);
        if (reopened !== null) {
          await rejection(reserve(reopened, "1", "aa"));
          await rejection(reserve(reopened, "1", "cc"));
          await rejection(reopened.highestReserved(INSTANCE));
          await rejection(reopened.reservations(INSTANCE));
        }
        assert.deepEqual(await subject.stored(ctx), before, "the damaged state is never overwritten");
      },
    }),
  ),
  ...(["corrupt-attempt", "newer-attempt"] as const).map(
    (what): ConformanceCase<JournalSubject> => ({
      id: what === "corrupt-attempt" ? "JNL-08-attempt" : "JNL-08-attempt-newer",
      title: `a ${what === "corrupt-attempt" ? "damaged" : "newer build's"} attempt record fails closed: the open refuses, or every listing and re-record of it does`,
      needs: ["durable", "plant"],
      async run(subject, ctx) {
        const journal = await subject.open(ctx);
        await journal.recordAttempt(attempt(1));
        await journal.recordAttempt(attempt(2));
        await hook(subject.plant, "plant")(ctx, { kind: what, intent_id: "ab".repeat(32), tx_id: TX(1), account: RELAYER, sequence: "1" });
        const before = await subject.stored(ctx);
        const reopened = await subject.open(ctx).catch(() => null);
        if (reopened !== null) {
          await rejection(reopened.attemptsOf("ab".repeat(32)));
          await rejection(reopened.allAttempts(RELAYER));
          await rejection(reopened.recordAttempt(attempt(1)));
        }
        assert.deepEqual(await subject.stored(ctx), before, "the damaged record is never overwritten");
      },
    }),
  ),
  {
    id: "JNL-09",
    title: "fence: a stale writer reserves and records nothing",
    needs: ["fence"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await reserve(journal, "1", "aa");
      const before = await subject.stored(ctx);
      await ctx.fence.takeOver();
      await rejection(reserve(journal, "2", "bb"));
      await rejection(journal.recordAttempt(attempt(1)));
      assert.deepEqual(await subject.stored(ctx), before);
      assert.equal(await journal.highestReserved(INSTANCE).then((r) => r?.seq), "1");
    },
  },
  {
    id: "JNL-10",
    title: "a failed append records nothing: the retry of the same reservation is `reserved`, never a conflict with itself",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const before = await subject.stored(ctx);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx);
      await rejection(reserve(journal, "3", "aa"));
      assert.deepEqual(await subject.stored(ctx), before);
      assert.deepEqual(await reserve(journal, "3", "aa"), { kind: "reserved" });
    },
  },
  {
    id: "JNL-11",
    title: "an append whose answer was lost never lets a DIFFERENT digest take the slot: the retry is `reserved`/`same` or refused, and after a restart the landed reservation decides",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      await reserve(journal, "1", "aa");
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      const first = await reserve(journal, "2", "aa").catch((error: Error) => ({ kind: "refused" as const, error }));
      assert.ok(first.kind === "reserved" || first.kind === "same" || first.kind === "refused", `a lost answer resolves to the reservation or a refusal: ${JSON.stringify(first)}`);
      const retry = await reserve(journal, "2", "aa").catch(() => refusedAs);
      assert.ok(retry.kind === "reserved" || retry.kind === "same" || retry.kind === "refused", `the retry: ${JSON.stringify(retry)}`);
      const other = await reserve(journal, "2", "bb").catch(() => refusedAs);
      assert.notEqual(other.kind, "reserved", "a different digest never takes a slot whose reservation may have landed");
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reserve(reopened, "2", "bb"), { kind: "conflict", digest_hex: "aa".repeat(32) }, "the landed reservation decides the slot");
      assert.deepEqual(await reserve(reopened, "2", "aa"), { kind: "same" });
    },
  },
  {
    id: "JNL-11-token",
    title: "the resend of an unknown reservation carries the SAME client request token as the attempt it repeats; the next write a fresh one",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const tokens = hook(subject.writeTokens, "writeTokens");
      const before = tokens(ctx).length;
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      assert.deepEqual(await reserve(journal, "2", "aa"), { kind: "reserved" }, "the landed reservation, settled by its resend");
      const attempts = tokens(ctx).slice(before);
      assert.equal(attempts.length, 2, `one attempt and one resend (${attempts.length})`);
      assert.equal(attempts[1], attempts[0], "the resend is the identical request");
      assert.match(attempts[0], /^[\x21-\x7e]{1,36}$/, "a ClientRequestToken is 1-36 printable characters");
      await reserve(journal, "3", "aa");
      const next = tokens(ctx).slice(before + 2);
      assert.equal(next.length, 1);
      assert.notEqual(next[0], attempts[0], "every new logical write has a fresh token");
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<JournalSubject> => ({
      id: `JNL-11-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "a reservation that LANDED before a takeover, its answer lost, is reported reserved on resend (it is) -- and the slot is its digest for the new writer"
        : "a reservation that did NOT land before a takeover is refused on resend, never applied: the new writer finds the slot free",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const journal = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        await reserve(journal, "1", "aa");
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, landed);
        const pending = reserve(journal, "2", "bb").catch(() => refusedAs);
        await stalledAt(resend, pending, "the resend");
        await ctx.fence.takeOver();
        resend.release();
        const outcome = await pending;
        const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        if (landed) {
          assert.equal(outcome.kind, "reserved", `a reservation that landed is committed: ${JSON.stringify(outcome)}`);
          assert.deepEqual(await reserve(current, "2", "cc"), { kind: "conflict", digest_hex: "bb".repeat(32) });
        } else {
          assert.equal(outcome.kind, "refused", `a stale writer's unlanded reservation must be refused on resend: ${JSON.stringify(outcome)}`);
          assert.deepEqual(await reserve(current, "2", "cc"), { kind: "reserved" }, "the stale writer's digest never reached the slot");
        }
      },
    }),
  ),
  {
    id: "JNL-12",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its append is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await reserve(journal, "1", "aa");
      const before = await subject.stored(ctx);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx);
      const pending = reserve(journal, "2", "bb");
      await stalledAt(stall, pending, "the stale reservation");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal(await pending.then(() => "applied", () => "refused"), "refused", "FENCE-IN-WRITE: the stale writer's in-flight reservation was applied");
      assert.deepEqual(await subject.stored(ctx), before);
    },
  },
  {
    id: "JNL-13",
    title: "file journal: an append whose outcome is unknown HOLDS the journal -- nothing more is reserved or recorded until a restart",
    needs: ["fs-faults", "inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      await reserve(journal, "1", "aa");
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      await rejection(reserve(journal, "2", "aa"));
      await rejection(reserve(journal, "3", "cc"));
      await rejection(journal.recordAttempt(attempt(9)));
      assert.deepEqual(await reserve(await subject.open(ctx), "3", "cc"), { kind: "reserved" }, "the restart re-reads the journal and continues");
    },
  },
  {
    id: "JNL-14",
    title: "two writers on one journal: an acknowledged reservation is never lost or overwritten by the other writer",
    needs: ["durable"],
    async run(subject, ctx) {
      const a = await subject.open(ctx);
      const b = await subject.open(ctx);
      assert.deepEqual(await reserve(a, "1", "aa"), { kind: "reserved" });
      const second = await reserve(b, "2", "bb").catch(() => refusedAs);
      assert.ok(second.kind === "reserved" || second.kind === "refused", JSON.stringify(second));
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reserve(reopened, "1", "cc"), { kind: "conflict", digest_hex: "aa".repeat(32) }, "A's acknowledged reservation survives");
      if (second.kind === "reserved") assert.deepEqual(await reserve(reopened, "2", "dd"), { kind: "conflict", digest_hex: "bb".repeat(32) }, "and so does B's, if B was told it was reserved");
    },
  },
  {
    id: "JNL-15",
    title: "two writers racing: a writer stalled past its checks, then applied after the other's acknowledged append, never overwrites it",
    needs: ["fs-faults", "durable"],
    async run(subject, ctx) {
      const a = await subject.open(ctx);
      const b = await subject.open(ctx);
      const stall = hook(subject.stallAtByteWrite, "stallAtByteWrite")(ctx);
      const pendingB = reserve(b, "2", "bb").catch(() => refusedAs);
      await stalledAt(stall, pendingB, "B's append");
      assert.deepEqual(await reserve(a, "1", "aa"), { kind: "reserved" });
      stall.release();
      const second = await pendingB;
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reserve(reopened, "1", "cc"), { kind: "conflict", digest_hex: "aa".repeat(32) }, "A's acknowledged reservation survives the race");
      if (second.kind === "reserved") assert.deepEqual(await reserve(reopened, "2", "dd"), { kind: "conflict", digest_hex: "bb".repeat(32) }, "and so does B's");
    },
  },
  {
    id: "JNL-16",
    title: "fence inside the write, for attempts: a relayer takeover after the stale relayer's own checks, before its attempt is recorded, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await journal.recordAttempt(attempt(1));
      const before = await subject.stored(ctx);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx);
      const pending = journal.recordAttempt(attempt(2));
      await stalledAt(stall, pending, "the stale attempt");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal(await pending.then(() => "applied", () => "refused"), "refused", "FENCE-IN-WRITE: the stale writer's in-flight attempt was applied");
      assert.deepEqual(await subject.stored(ctx), before);
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<JournalSubject> => ({
      id: `JNL-16-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "an attempt that LANDED before a relayer takeover, its answer lost, is reported recorded on resend (it is): the new relayer sees it"
        : "an attempt that did NOT land before a relayer takeover is refused on resend, never recorded -- so it is never broadcast",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const journal = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        await journal.recordAttempt(attempt(1));
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, landed);
        const pending = journal.recordAttempt(attempt(2)).then(() => ({ kind: "recorded" as const }), () => refusedAs);
        await stalledAt(resend, pending, "the resend");
        await ctx.fence.takeOver();
        resend.release();
        const outcome = await pending;
        const listed = (await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).attemptsOf("ab".repeat(32))).map((a) => a.tx_id);
        if (landed) {
          assert.equal(outcome.kind, "recorded");
          assert.deepEqual(listed, [TX(1), TX(2)]);
        } else {
          assert.equal(outcome.kind, "refused", "a stale relayer's unlanded attempt must be refused on resend");
          assert.deepEqual(listed, [TX(1)]);
        }
      },
    }),
  ),
  {
    id: "JNL-17",
    title: "an attempt whose answer was lost is recorded once: the retry is idempotent by transaction id (or refused), and a restart lists it exactly once",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      const first = await journal.recordAttempt(attempt(4)).then(() => "recorded", () => "refused");
      const retry = await journal.recordAttempt(attempt(4)).then(() => "recorded", () => "refused");
      assert.ok([first, retry].every((kind) => kind === "recorded" || kind === "refused"));
      const reopened = await subject.open(ctx);
      assert.deepEqual((await reopened.attemptsOf("ab".repeat(32))).map((a) => a.tx_id), [TX(4)], "the landed attempt, exactly once");
      assert.deepEqual((await reopened.allAttempts(RELAYER)).map((a) => a.tx_id), [TX(4)]);
    },
  },
  {
    id: "JNL-17-token",
    title: "the resend of an unknown attempt carries the SAME client request token; the next attempt a fresh one",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const tokens = hook(subject.writeTokens, "writeTokens");
      const before = tokens(ctx).length;
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      await journal.recordAttempt(attempt(5));
      const attempts = tokens(ctx).slice(before);
      assert.equal(attempts.length, 2, `one attempt and one resend (${attempts.length})`);
      assert.equal(attempts[1], attempts[0], "the resend is the identical request");
      await journal.recordAttempt(attempt(6));
      const next = tokens(ctx).slice(before + 2);
      assert.equal(next.length, 1);
      assert.notEqual(next[0], attempts[0]);
    },
  },
  {
    id: "JNL-18",
    title: "an attempt that failed before any effect records nothing; the retry records it once",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const before = await subject.stored(ctx);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx);
      await rejection(journal.recordAttempt(attempt(3)));
      assert.deepEqual(await subject.stored(ctx), before);
      await journal.recordAttempt(attempt(3));
      assert.deepEqual((await journal.attemptsOf("ab".repeat(32))).map((a) => a.tx_id), [TX(3)]);
    },
  },
  {
    id: "JNL-19",
    title: "two writers racing ONE slot with different digests: the one stalled past its own checks is never told `reserved` once the other holds the slot",
    needs: ["stall-write", "durable"],
    async run(subject, ctx) {
      const a = await subject.open(ctx);
      const b = await subject.open(ctx);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx);
      const pendingB = reserve(b, "5", "bb").catch(() => refusedAs);
      await stalledAt(stall, pendingB, "B's reservation");
      assert.deepEqual(await reserve(a, "5", "aa"), { kind: "reserved" });
      stall.release();
      const second = await pendingB;
      assert.ok(second.kind === "refused" || (second.kind === "conflict" && second.digest_hex === "aa".repeat(32)), `B must not also hold the slot: ${JSON.stringify(second)}`);
      assert.equal(await slotHolds(await subject.open(ctx), "5"), "aa".repeat(32));
    },
  },
  {
    id: "JNL-20",
    title: "a transaction id is one attempt: another intent, sequence or expiry for a recorded tx id never alters the first record",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      await journal.recordAttempt(attempt(5));
      const other = await journal.recordAttempt(attempt(5, { intent_id: "cd".repeat(32) })).then(() => "recorded", () => "refused");
      await journal.recordAttempt(attempt(5, { account_sequence: "6" })).catch(() => undefined);
      await journal.recordAttempt(attempt(5, { expires_after_height: "999" })).catch(() => undefined);
      assert.deepEqual(await journal.attemptsOf("ab".repeat(32)), [{ tx_id: TX(5), account: RELAYER, sequence: "5", expires_after_height: "105" }], "the first record stands, exactly");
      if (other === "recorded") assert.ok((await journal.attemptsOf("cd".repeat(32))).some((a) => a.tx_id === TX(5)), "a record that was acknowledged is listed");
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<JournalSubject> => ({
      id: `JNL-21-${landed ? "landed" : "unlanded"}`,
      title: `a reservation whose every answer is lost (${landed ? "it landed" : "it never landed"}): whoever is told reserved/same holds the slot, and never two digests`,
      needs: ["inject-unresolved", "durable"],
      async run(subject, ctx) {
        const journal = await subject.open(ctx);
        hook(subject.armUnresolvedWrite, "armUnresolvedWrite")(ctx, landed);
        const first = await reserve(journal, "4", "aa").catch(() => refusedAs);
        const second = await reserve(journal, "4", "bb").catch(() => refusedAs);
        const holds = await slotHolds(await subject.open(ctx), "4");
        if (signs(first)) assert.equal(holds, "aa".repeat(32), "a digest reported reserved is the slot's");
        if (signs(second)) assert.equal(holds, "bb".repeat(32), "a digest reported reserved is the slot's");
        assert.ok(!(signs(first) && signs(second)), "never two digests for one slot");
        if (landed) assert.equal(holds, "aa".repeat(32), "the write that landed holds the slot");
      },
    }),
  ),
];
