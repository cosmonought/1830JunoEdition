// server/src/persistence/conformance/identitySecurity.conformance.ts
//
// LIVE-5 L5-4: the identity side's two durable security ports, written once and run against every implementation --
//   GRANT  sensitive-auth grants (`SensitiveAuthGrantStore`, identity/grants.ts): put / renew, strong get, the live set,
//          removal; a stale writer is refused, inside the write;
//   SEC    the security-event journal (`SecurityEventJournal`, identity/securityEvents.ts): append-only, first writer wins
//          per event key, never overwritten; a writer on a superseded generation records nothing, inside the write.
// Both keep the store contract every port keeps: durable before acknowledged; DEFINITE only when nothing was written;
// an unknown outcome settled by an identical resend, never guessed.

import assert from "node:assert/strict";

import type { SensitiveAuthGrant, SensitiveAuthGrantStore } from "../../identity/grants";
import { SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent, type SecurityEventJournal } from "../../identity/securityEvents";
import type { Gate } from "./faults";
import { anotherSession, identitySet } from "./fixtures";
import { T0, hook, rejection, stalledAt, type CaseContext, type ConformanceCase, type SubjectBase } from "./harness";

const isDefinite = (error: unknown) => error instanceof Error && error.name === "StoreDefiniteError";

/** The hooks both subjects have. */
interface SecuritySubjectHooks {
  /** Everything the store holds durably, as text -- "nothing was written" is always checked. */
  stored(ctx: CaseContext): Promise<Buffer | string | null>;
  stallNextWrite?(ctx: CaseContext): Gate;
  armLostAnswer?(ctx: CaseContext): void;
  armTransientFailure?(ctx: CaseContext): void;
  writeTokens?(ctx: CaseContext): string[];
  armUnknownThenStallResend?(ctx: CaseContext, landed: boolean): Gate;
}

/* ================================================================== */
/*  Sensitive-auth grants                                              */
/* ================================================================== */

export interface GrantSubject extends SubjectBase, SecuritySubjectHooks {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<SensitiveAuthGrantStore>;
  /** "plant": damage the stored grant of `sessionId` (a later read must refuse, never guess). */
  plant?(ctx: CaseContext, sessionId: string): Promise<void>;
}

export function grantOf(n: number, tag = "grant", expiresAt = T0 + 300_000): SensitiveAuthGrant {
  const set = identitySet(n);
  const session = tag === "grant" ? set.session : anotherSession(set, tag);
  return { session_id: session.session_id, family_id: set.family.family_id, selector: set.profile.recovery_selector, expires_at: expiresAt };
}

async function grantRefused(subject: GrantSubject, ctx: CaseContext, write: Promise<void>, label: string, before: Buffer | string | null): Promise<void> {
  const error = await rejection(write);
  assert.ok(isDefinite(error), `${label}: expected StoreDefiniteError, got ${String(error)}`);
  assert.deepEqual(await subject.stored(ctx), before, `${label}: nothing was written`);
}

export const GRANT_CASES: readonly ConformanceCase<GrantSubject>[] = [
  {
    id: "GRANT-01",
    title: "put, then get returns exactly that grant; a session with none reads null",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.get(grantOf(1).session_id), null);
      await store.put(grantOf(1));
      assert.deepEqual(await store.get(grantOf(1).session_id), grantOf(1));
      assert.equal(await store.get(grantOf(2).session_id), null);
    },
  },
  {
    id: "GRANT-02",
    title: "a renewal replaces the session's grant whole; another session's grant is untouched",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      await store.put(grantOf(1));
      await store.put(grantOf(2));
      const renewed = { ...grantOf(1), expires_at: T0 + 900_000, selector: identitySet(5).profile.recovery_selector };
      await store.put(renewed);
      assert.deepEqual(await store.get(renewed.session_id), renewed);
      assert.deepEqual(await store.get(grantOf(2).session_id), grantOf(2));
    },
  },
  {
    id: "GRANT-03",
    title: "live(now) lists exactly the grants not lapsed at now, by session",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const early = grantOf(1, "grant", T0 + 100);
      const late = grantOf(2, "grant", T0 + 200);
      await store.put(early);
      await store.put(late);
      const bySession = (grants: SensitiveAuthGrant[]) => grants.map((grant) => grant.session_id);
      assert.deepEqual(bySession(await store.live(T0)), [early.session_id, late.session_id].sort());
      assert.deepEqual(bySession(await store.live(T0 + 100)), [late.session_id], "a grant is dead AT its expires_at");
      assert.deepEqual(await store.live(T0 + 200), []);
    },
  },
  {
    id: "GRANT-04",
    title: "a malformed grant -- a bad id, a missing or extra field, a non-time -- is refused DEFINITE; nothing is written",
    needs: ["validates-shape"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      await store.put(grantOf(1));
      const before = await subject.stored(ctx);
      const bad = (value: unknown) => value as SensitiveAuthGrant;
      const cases: Array<[string, SensitiveAuthGrant]> = [
        ["a session id that is not one", bad({ ...grantOf(2), session_id: "se_nope" })],
        ["a family id that is not one", bad({ ...grantOf(2), family_id: grantOf(2).session_id })],
        ["a selector that is not one", bad({ ...grantOf(2), selector: "rk_" })],
        ["a non-time expiry", bad({ ...grantOf(2), expires_at: 1.5 })],
        ["an extra field", bad({ ...grantOf(2), secret: "x" })],
        ["a missing field", bad({ session_id: grantOf(2).session_id, family_id: grantOf(2).family_id, selector: grantOf(2).selector })],
      ];
      for (const [label, grant] of cases) await grantRefused(subject, ctx, store.put(grant), label, before);
    },
  },
  {
    id: "GRANT-05",
    title: "remove forgets exactly the named sessions' grants (a missing one is not an error)",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      for (const n of [1, 2, 3]) await store.put(grantOf(n));
      await store.remove([grantOf(1).session_id, grantOf(3).session_id, grantOf(9).session_id]);
      assert.equal(await store.get(grantOf(1).session_id), null);
      assert.deepEqual(await store.get(grantOf(2).session_id), grantOf(2));
      assert.equal(await store.get(grantOf(3).session_id), null);
      await store.remove([]);
    },
  },
  {
    id: "GRANT-06",
    title: "restart: a reopened store has every grant",
    needs: ["durable"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      await store.put(grantOf(1));
      await store.put(grantOf(2));
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.live(T0), [grantOf(1), grantOf(2)].sort((a, b) => (a.session_id < b.session_id ? -1 : 1)));
    },
  },
  {
    id: "GRANT-07",
    title: "fence: after a takeover the stale writer's put and remove are DEFINITE and write nothing; the new writer continues",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await stale.put(grantOf(1));
      const before = await subject.stored(ctx);
      await ctx.fence.takeOver();
      await grantRefused(subject, ctx, stale.put(grantOf(2)), "the stale put", before);
      await grantRefused(subject, ctx, stale.remove([grantOf(1).session_id]), "the stale removal", before);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await current.put(grantOf(2));
      assert.deepEqual(await current.get(grantOf(2).session_id), grantOf(2));
    },
  },
  {
    id: "GRANT-08",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its put is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await stale.put(grantOf(1));
      const before = await subject.stored(ctx);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx);
      const pending = stale.put(grantOf(2));
      await stalledAt(stall, pending, "the stale put");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal(await pending.then(() => "applied", (error: unknown) => (isDefinite(error) ? "refused" : `unknown: ${String(error)}`)), "refused", "FENCE-IN-WRITE: the stale writer's in-flight grant was applied");
      assert.deepEqual(await subject.stored(ctx), before);
    },
  },
  {
    id: "GRANT-09",
    title: "a put whose answer was lost after it landed resolves: the grant is stored, once",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      await store.put(grantOf(1));
      assert.deepEqual(await (await subject.open(ctx)).live(T0), [grantOf(1)]);
    },
  },
  {
    id: "GRANT-10",
    title: "transient failure: a put that failed before any effect is DEFINITE, writes nothing, and the retry stores it",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const before = await subject.stored(ctx);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx);
      await grantRefused(subject, ctx, store.put(grantOf(1)), "the failed put", before);
      await store.put(grantOf(1));
      assert.deepEqual(await store.get(grantOf(1).session_id), grantOf(1));
    },
  },
  {
    id: "GRANT-11",
    title: "the resend of an unknown outcome carries the SAME client request token as the attempt it repeats",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const tokens = hook(subject.writeTokens, "writeTokens");
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      await store.put(grantOf(1));
      const attempts = tokens(ctx);
      assert.equal(attempts.length, 2);
      assert.equal(attempts[1], attempts[0]);
    },
  },
  {
    id: "GRANT-12",
    title: "a damaged stored grant is refused on read, never guessed at",
    needs: ["plant"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      await store.put(grantOf(1));
      await hook(subject.plant, "plant")(ctx, grantOf(1).session_id);
      await rejection(store.get(grantOf(1).session_id));
      await rejection(store.live(T0));
    },
  },
];

/* ================================================================== */
/*  The security-event journal                                         */
/* ================================================================== */

export interface SecuritySubject extends SubjectBase, SecuritySubjectHooks {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<SecurityEventJournal>;
  /** "plant": damage one stored event of `event`'s principal (a later listing must refuse, never guess). */
  plant?(ctx: CaseContext, event: SecurityEvent): Promise<void>;
}

const eventId = (n: number) => n.toString(16).padStart(32, "0");

/** One event of every kind for identity set `n`, at `T0 + n * 10 + k` (the last confirms the rotation). */
export function eventsOf(n: number): SecurityEvent[] {
  const set = identitySet(n);
  const common = (k: number) => ({ format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: eventId(n * 100 + k), at: T0 + n * 10 + k, principal_id: set.principal.principal_id }) as const;
  const second = anotherSession(set, "second-device", { family_id: identitySet(n + 50).family.family_id });
  return [
    { ...common(1), kind: "profile-created", principal: set.profiledPrincipal, profile: set.profile },
    {
      ...common(2),
      kind: "recovery-key-rotated",
      profile_id: set.profile.profile_id,
      from_selector: set.profile.recovery_selector,
      to_selector: identitySet(n + 70).profile.recovery_selector,
      recovery_hash: identitySet(n + 70).profile.recovery_hash,
      rotated_at: T0 + n * 10 + 2,
    },
    { ...common(3), kind: "family-revoked", family_ids: [set.family.family_id], reason: "logout" },
    { ...common(4), kind: "signed-out-others", kept_family_id: set.family.family_id, family_ids: [second.family_id] },
    { ...common(5), kind: "principal-disabled", family_ids: [set.family.family_id, second.family_id].sort() },
    { ...common(6), kind: "confirmed", confirms: eventId(n * 100 + 2), confirmed_kind: "recovery-key-rotated" },
  ];
}

async function eventRefused(subject: SecuritySubject, ctx: CaseContext, write: Promise<void>, label: string, before: Buffer | string | null): Promise<void> {
  const error = await rejection(write);
  assert.ok(isDefinite(error), `${label}: expected StoreDefiniteError, got ${String(error)}`);
  assert.deepEqual(await subject.stored(ctx), before, `${label}: nothing was written`);
}

export const SEC_CASES: readonly ConformanceCase<SecuritySubject>[] = [
  {
    id: "SEC-01",
    title: "append, then list: the principal's events in time order, exactly as appended; another principal's are not listed",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const mine = eventsOf(1);
      for (const event of [...mine].reverse()) await journal.append(event);
      for (const event of eventsOf(2)) await journal.append(event);
      assert.deepEqual(await journal.eventsOf(mine[0].principal_id), mine);
      assert.deepEqual(await journal.eventsOf(identitySet(3).principal.principal_id), []);
    },
  },
  {
    id: "SEC-02",
    title: "first writer wins: the same event again resolves and is stored once; a DIFFERENT event under its key is refused DEFINITE and the first stands",
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const [event] = eventsOf(1);
      await journal.append(event);
      const before = await subject.stored(ctx);
      await journal.append(event);
      assert.deepEqual(await subject.stored(ctx), before, "a duplicate delivery writes nothing");
      const impostor = { ...eventsOf(1)[2], event_id: event.event_id, at: event.at } as SecurityEvent;
      await eventRefused(subject, ctx, journal.append(impostor), "another event under the first one's key", before);
      assert.deepEqual(await journal.eventsOf(event.principal_id), [event]);
    },
  },
  {
    id: "SEC-03",
    title: "a malformed event -- a wrong format, an unsorted family list, a rotation to the same selector, a mismatched profile, a confirmation of no change -- is refused DEFINITE; nothing is written",
    needs: ["validates-shape"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const events = eventsOf(1);
      await journal.append(events[0]);
      const before = await subject.stored(ctx);
      const bad = (value: unknown) => value as SecurityEvent;
      const cases: Array<[string, SecurityEvent]> = [
        ["another format", bad({ ...events[2], format: "gs-other" })],
        ["a newer version", bad({ ...events[2], version: 2 })],
        ["an event id that is not one", bad({ ...events[2], event_id: "zz" })],
        ["a time past 13 digits", bad({ ...events[2], at: 10_000_000_000_000 })],
        ["an unsorted family list", bad({ ...events[4], family_ids: [...(events[4] as unknown as { family_ids: string[] }).family_ids].reverse() })],
        ["an empty revocation", bad({ ...events[2], family_ids: [] })],
        ["a rotation revocation reason", bad({ ...events[2], reason: "rotated" })],
        ["a rotation to the same selector", bad({ ...events[1], to_selector: (events[1] as unknown as { from_selector: string }).from_selector })],
        ["a sign-out that closes its own family", bad({ ...events[3], family_ids: [(events[3] as unknown as { kept_family_id: string }).kept_family_id] })],
        ["a profile creation for another principal", bad({ ...events[0], principal_id: identitySet(2).principal.principal_id })],
        ["a confirmation of a confirmation", bad({ ...events[5], confirmed_kind: "confirmed" })],
        ["a confirmation naming no event id", bad({ ...events[5], confirms: "zz" })],
        ["a confirmation of itself", bad({ ...events[5], confirms: events[5].event_id })],
        ["an extra field", bad({ ...events[2], secret: "x" })],
      ];
      for (const [label, event] of cases) await eventRefused(subject, ctx, journal.append(event), label, before);
    },
  },
  {
    id: "SEC-04",
    title: "restart: a reopened journal lists every event",
    needs: ["durable"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      for (const event of eventsOf(1)) await journal.append(event);
      assert.deepEqual(await (await subject.open(ctx)).eventsOf(eventsOf(1)[0].principal_id), eventsOf(1));
    },
  },
  {
    id: "SEC-05",
    title: "fence: a writer whose generation was superseded appends nothing (DEFINITE); the current one continues",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const events = eventsOf(1);
      await stale.append(events[0]);
      const before = await subject.stored(ctx);
      await ctx.fence.takeOver();
      await eventRefused(subject, ctx, stale.append(events[1]), "the stale append", before);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await current.append(events[1]);
      assert.equal((await current.eventsOf(events[0].principal_id)).length, 2);
    },
  },
  {
    id: "SEC-06",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its append is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const events = eventsOf(1);
      await stale.append(events[0]);
      const before = await subject.stored(ctx);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx);
      const pending = stale.append(events[1]);
      await stalledAt(stall, pending, "the stale append");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal(await pending.then(() => "applied", (error: unknown) => (isDefinite(error) ? "refused" : `unknown: ${String(error)}`)), "refused", "FENCE-IN-WRITE: the stale writer's in-flight event was recorded");
      assert.deepEqual(await subject.stored(ctx), before);
    },
  },
  {
    id: "SEC-07",
    title: "an append whose answer was lost after it landed resolves: the event is recorded once",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const [event] = eventsOf(1);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      await journal.append(event);
      assert.deepEqual(await (await subject.open(ctx)).eventsOf(event.principal_id), [event]);
    },
  },
  {
    id: "SEC-08",
    title: "transient failure: an append that failed before any effect is DEFINITE, writes nothing, and the retry records it",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const [event] = eventsOf(1);
      const before = await subject.stored(ctx);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx);
      await eventRefused(subject, ctx, journal.append(event), "the failed append", before);
      await journal.append(event);
      assert.deepEqual(await journal.eventsOf(event.principal_id), [event]);
    },
  },
  {
    id: "SEC-09",
    title: "the resend of an unknown outcome carries the SAME client request token as the attempt it repeats",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const tokens = hook(subject.writeTokens, "writeTokens");
      hook(subject.armLostAnswer, "armLostAnswer")(ctx);
      await journal.append(eventsOf(1)[0]);
      const attempts = tokens(ctx);
      assert.equal(attempts.length, 2);
      assert.equal(attempts[1], attempts[0]);
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<SecuritySubject> => ({
      id: `SEC-09-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "a resend never hides a stale writer: an append that LANDED before the generation moved is reported recorded (it is)"
        : "a resend never hides a stale writer: an append that did NOT land before the generation moved is refused DEFINITE, never recorded",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const journal = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        const [event] = eventsOf(1);
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, landed);
        const pending = journal.append(event).then(
          () => "recorded",
          (error: unknown) => (isDefinite(error) ? "definite" : `unknown: ${String(error)}`),
        );
        await stalledAt(resend, pending, "the resend");
        await ctx.fence.takeOver();
        resend.release();
        const outcome = await pending;
        const stored = await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).eventsOf(event.principal_id);
        if (landed) {
          assert.equal(outcome, "recorded");
          assert.deepEqual(stored, [event]);
        } else {
          assert.equal(outcome, "definite");
          assert.deepEqual(stored, []);
        }
      },
    }),
  ),
  {
    id: "SEC-10",
    title: "a damaged stored event refuses the listing: never guessed at, never skipped",
    needs: ["plant"],
    async run(subject, ctx) {
      const journal = await subject.open(ctx);
      const events = eventsOf(1);
      for (const event of events) await journal.append(event);
      await hook(subject.plant, "plant")(ctx, events[2]);
      await rejection(journal.eventsOf(events[0].principal_id));
    },
  },
];
