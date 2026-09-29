// server/src/identity/l5_4SecuritySubstrate.test.ts
//
// ==================================================================
//  LIVE-5 L5-4: THE IDENTITY SERVICE'S DURABLE SECURITY SUBSTRATE (journal first; durable grants, OD-5-4)
// ==================================================================
//
// Over the in-memory store and the in-memory reference models of the two ports (the DynamoDB adapters pass the same
// port cases; the service over DynamoDB is `identityDynamoLocal.properties.test.ts` F):
//
//   A. JOURNAL FIRST. Each durable security change -- a profile created, "Sign out other devices", a recovery-key
//      rotation, a sign-out that closes a family, a principal disabled -- appends its event BEFORE its identity change is
//      written, from inside the store's commit once the store's own checks have passed (review F2), with exactly the
//      facts a replay needs and no secret; once committed, a `confirmed` event names it. An append that fails --
//      definitely or with an unknown outcome -- stops the change: nothing is committed, the service's own state does not
//      move, no hook fires, and the action answers as any store failure does. A change the store refuses on its own
//      checks leaves NO event; a write refused or unresolved after its event leaves the event UNCONFIRMED (a phantom,
//      the safe direction); a confirmation that cannot be written is reported and the action still succeeds. No event
//      for what is not durable, or not a security change.
//   B. DURABLE GRANTS (OD-5-4). A re-authentication is also a grant item; a restart reloads the live ones and honours
//      them exactly as before (this session, its family open, the key unrotated, before the expiry) -- so a reloaded
//      grant never adds a capability. A grant that could not be written is still honoured in this process (today's
//      behaviour) and reported; only its survival across a restart is lost.
//   C. WITHOUT THE SUBSTRATE nothing is written anywhere new and every answer is as before.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readSessionCookie, type SessionCookieRead } from "./cookies";
import { createMemoryGrantStore, type MemoryGrantStore } from "./grants";
import { isSecurityEvent, createMemorySecurityJournal, type MemorySecurityJournal, type SecurityEvent } from "./securityEvents";
import { IdentityService, type IdentityServiceOptions } from "./sessions";
import { createMemoryIdentityStore, type IdentityChange, type IdentityCommitOptions, type IdentityStore, type MemoryIdentityStore, type Session } from "./store";
import { StoreDefiniteError, StoreUncertainError } from "../persistence/storeResult";

const T0 = 1_780_000_000_000;
const MIN = 60 * 1000;

const readOf = (setCookie: string | null | undefined): SessionCookieRead => {
  assert.ok(setCookie, "a Set-Cookie");
  return readSessionCookie(setCookie.split(";")[0]);
};
const sessionIdOf = (read: SessionCookieRead): string => (read.kind === "session" ? read.sessionId : "");

/** How the recording store treats the next commits (in order), beyond the memory store's own `failNext`:
 *  "refuse-after-hook" -- its checks pass and the hook runs, then the write is refused (a condition only the table
 *  checks: a phantom); "skip-hook" -- a store that breaks the port and writes without calling the hook. */
type StoreQuirk = "refuse-after-hook" | "skip-hook";

/** A store and a journal that share one ordered log of what reached them: "commit" when a commit arrives, "event:<kind>"
 *  for each append, "written" once a commit resolved. */
function recorded(store: MemoryIdentityStore, journal: MemorySecurityJournal) {
  const order: string[] = [];
  const quirks: StoreQuirk[] = [];
  /** Failures for the next CONFIRMATION appends only. */
  const confirmationFaults: Array<"definite" | "uncertain"> = [];
  /** While set, a CONFIRMATION append waits for it (after it is logged). */
  const stall: { gate: Promise<void> | null } = { gate: null };
  const recordingStore: IdentityStore = {
    load: () => store.load(),
    async commit(change: IdentityChange, options?: IdentityCommitOptions) {
      order.push("commit");
      const quirk = quirks.shift();
      if (quirk === "refuse-after-hook") {
        await options?.beforeWrite?.();
        throw new StoreDefiniteError("refused by a condition of the write (test); nothing was written");
      }
      await store.commit(change, quirk === "skip-hook" ? undefined : options);
      order.push("written");
    },
  };
  const recordingJournal = {
    async append(event: SecurityEvent) {
      order.push(`event:${event.kind}`);
      if (event.kind === "confirmed") {
        if (stall.gate !== null) await stall.gate;
        const fault = confirmationFaults.shift();
        if (fault === "definite") throw new StoreDefiniteError("injected confirmation failure (nothing written)");
        if (fault === "uncertain") throw new StoreUncertainError("injected confirmation failure (outcome unknown)");
      }
      return journal.append(event);
    },
    eventsOf: (principalId: string) => journal.eventsOf(principalId),
  };
  return { order, quirks, confirmationFaults, stall, recordingStore, recordingJournal };
}

/** Wait (bounded) until `done` holds, yielding to the event loop between looks. */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let look = 0; look < 1000 && !done(); look += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(done(), `timed out waiting for ${label}`);
}

/** A security flow's trace: the commit arrives, its event is appended, the change is written, its confirmation. */
const SECURE = (kind: string) => ["commit", `event:${kind}`, "written", "event:confirmed"];

/** Each change event of `events` is followed at once by its confirmation (same principal and time). */
function assertConfirmedPairs(events: readonly SecurityEvent[]): void {
  assert.equal(events.length % 2, 0, `pairs: ${events.map((event) => event.kind).join(",")}`);
  for (let at = 0; at < events.length; at += 2) {
    const [change, confirmation] = [events[at], events[at + 1]];
    assert.equal(confirmation.kind, "confirmed");
    const confirmed = confirmation as Extract<SecurityEvent, { kind: "confirmed" }>;
    assert.equal(confirmed.confirms, change.event_id);
    assert.equal(confirmed.confirmed_kind, change.kind);
    assert.equal(confirmed.at, change.at);
    assert.equal(confirmed.principal_id, change.principal_id);
  }
}

const changeKinds = (events: readonly SecurityEvent[]) => events.filter((event) => event.kind !== "confirmed").map((event) => event.kind);

async function world(options: { journal?: boolean; grants?: boolean } = { journal: true, grants: true }) {
  const store = createMemoryIdentityStore();
  const journal = createMemorySecurityJournal();
  const grants = createMemoryGrantStore();
  const { order, quirks, confirmationFaults, stall, recordingStore, recordingJournal } = recorded(store, journal);
  const failures: string[] = [];
  const events: string[] = [];
  let clock = T0;
  const optionsOf = (): IdentityServiceOptions => ({
    security: { ...(options.journal ? { journal: recordingJournal } : {}), ...(options.grants ? { grants } : {}), clock: () => clock },
    hooks: { onStoreFailure: (what) => failures.push(what), onSecurityEvent: (event) => events.push(event.kind) },
  });
  const identity = await IdentityService.open(recordingStore, optionsOf());
  return {
    store,
    journal,
    grants,
    order,
    quirks,
    confirmationFaults,
    stall,
    failures,
    events,
    identity,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
    restart: () => IdentityService.open(recordingStore, optionsOf()),
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function creator(w: World, identity = w.identity, name = "Ann"): Promise<{ read: SessionCookieRead; key: string; principalId: string }> {
  const boot = await identity.bootstrap({ kind: "none" }, false, w.now());
  const read = readOf((boot as { setCookie: string | null }).setCookie);
  const created = await identity.createProfile(read, name, w.now());
  assert.equal(created.kind, "ok");
  return { read, key: (created as { recoveryKey: string }).recoveryKey, principalId: (identity.peekSession(sessionIdOf(read)) as Session).principal_id };
}

async function recovered(identity: IdentityService, key: string, now: number): Promise<SessionCookieRead> {
  const boot = await identity.bootstrap({ kind: "none" }, false, now);
  const outcome = await identity.recover(readOf((boot as { setCookie: string | null }).setCookie), key, now);
  assert.equal(outcome.kind, "ok");
  return readOf((outcome as { setCookie: string }).setCookie);
}

/* ================================================================================================= */
/* A. Journal first                                                                                  */
/* ================================================================================================= */

describe("L5-4 A: security events are journaled FIRST", () => {
  test("every security flow appends its event before its change is written, with the facts a replay needs and no secret; a confirmation follows each", async () => {
    const w = await world();
    const ann = await creator(w);
    assert.deepEqual(w.order, SECURE("profile-created"));
    const phone = await recovered(w.identity, ann.key, w.now());
    assert.deepEqual(w.order.slice(4), ["commit", "written"], "a recovery is not a security event (the provisional browser's family was never durable)");
    w.advance(MIN);
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "ok");
    w.advance(MIN);
    const rotation = await w.identity.rotateRecoveryKey(ann.read, w.now());
    assert.equal(rotation.kind, "ok");
    w.advance(MIN);
    assert.equal(await w.identity.revoke(sessionIdOf(ann.read), "logout", w.now()), true);
    assert.deepEqual(w.order.slice(6), [...SECURE("signed-out-others"), ...SECURE("recovery-key-rotated"), ...SECURE("family-revoked")]);

    const all = await w.journal.eventsOf(ann.principalId);
    assertConfirmedPairs(all);
    const events = all.filter((event) => event.kind !== "confirmed");
    assert.deepEqual(
      events.map((event) => event.kind),
      ["profile-created", "signed-out-others", "recovery-key-rotated", "family-revoked"],
    );
    for (const event of all) assert.ok(isSecurityEvent(event));
    const stored = w.store.snapshot();
    const profile = stored.profiles[0];
    const created = events[0] as Extract<SecurityEvent, { kind: "profile-created" }>;
    assert.equal(created.profile.profile_id, profile.profile_id);
    assert.equal(created.principal.account_link, profile.profile_id);
    const phoneFamily = (w.identity.peekSession(sessionIdOf(phone)) as Session).family_id;
    const annFamily = (w.identity.peekSession(sessionIdOf(ann.read)) as Session).family_id;
    assert.deepEqual((events[1] as Extract<SecurityEvent, { kind: "signed-out-others" }>).family_ids, [phoneFamily]);
    assert.equal((events[1] as Extract<SecurityEvent, { kind: "signed-out-others" }>).kept_family_id, annFamily);
    const rotated = events[2] as Extract<SecurityEvent, { kind: "recovery-key-rotated" }>;
    assert.equal(rotated.from_selector, ann.key.split(".")[0]);
    assert.equal(rotated.to_selector, profile.recovery_selector, "the chain: from the old selector to the one now stored");
    assert.equal(rotated.recovery_hash, profile.recovery_hash);
    assert.deepEqual((events[3] as Extract<SecurityEvent, { kind: "family-revoked" }>).family_ids, [annFamily]);
    assert.equal((events[3] as Extract<SecurityEvent, { kind: "family-revoked" }>).reason, "logout");
    const text = JSON.stringify(all);
    const newKey = (rotation as { recoveryKey: string }).recoveryKey;
    for (const secret of [ann.key.split(".")[1], newKey.split(".")[1], ann.read.kind === "session" ? ann.read.secret : "", phone.kind === "session" ? phone.secret : ""]) {
      assert.ok(secret.length > 0 && !text.includes(secret), "no secret is journaled");
    }
    assert.deepEqual(w.events, ["family-revoked", "recovery-key-rotated", "family-revoked"], "the hooks fire after the commits, as before");
  });

  test("within one writer the journal's order is the order of the changes, even in one millisecond", async () => {
    const w = await world();
    const ann = await creator(w);
    await recovered(w.identity, ann.key, w.now());
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    /* the same `now` for all three */
    assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "ok");
    assert.equal((await w.identity.rotateRecoveryKey(ann.read, w.now())).kind, "ok");
    assert.equal(await w.identity.revoke(sessionIdOf(ann.read), "logout", w.now()), true);
    const all = await w.journal.eventsOf(ann.principalId);
    assertConfirmedPairs(all);
    assert.deepEqual(changeKinds(all), ["profile-created", "signed-out-others", "recovery-key-rotated", "family-revoked"]);
  });

  test("an operator's disable of a principal is journaled first, naming the families it closes", async () => {
    const w = await world();
    const ann = await creator(w);
    await recovered(w.identity, ann.key, w.now());
    const families = [...new Set(w.store.snapshot().families.map((family) => family.family_id))].sort();
    w.advance(MIN);
    assert.equal(await w.identity.disablePrincipal(ann.principalId, w.now()), true);
    const events = await w.journal.eventsOf(ann.principalId);
    assertConfirmedPairs(events);
    const disabled = events[events.length - 2] as Extract<SecurityEvent, { kind: "principal-disabled" }>;
    assert.equal(disabled.kind, "principal-disabled");
    assert.deepEqual(disabled.family_ids, families);
    assert.deepEqual(w.order.slice(-4), SECURE("principal-disabled"));
  });

  for (const fault of ["definite", "uncertain"] as const) {
    test(`an append that fails (${fault}) stops the change: nothing committed, nothing applied, no hook; the action fails as a store failure does`, async () => {
      const w = await world();
      const ann = await creator(w);
      const phone = await recovered(w.identity, ann.key, w.now());
      assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
      const before = JSON.stringify(w.store.snapshot());
      const committed = w.store.stats.commits;
      const hooks = w.events.length;

      w.journal.failNext.push(fault);
      assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "unavailable");
      assert.equal(w.identity.authenticate(phone, w.now()).kind, "ok", "the other device is still signed in");
      w.journal.failNext.push(fault);
      assert.equal((await w.identity.rotateRecoveryKey(ann.read, w.now())).kind, "unavailable");
      assert.equal(w.identity.peekProfileOf(ann.principalId)?.recovery_selector, ann.key.split(".")[0], "the key did not move");
      w.journal.failNext.push(fault);
      await assert.rejects(w.identity.revoke(sessionIdOf(ann.read), "logout", w.now()), (error: Error) => error instanceof (fault === "definite" ? StoreDefiniteError : StoreUncertainError));
      assert.equal(w.identity.authenticate(ann.read, w.now()).kind, "ok", "this device is still signed in");
      w.journal.failNext.push(fault);
      await assert.rejects(w.identity.disablePrincipal(ann.principalId, w.now()));
      assert.equal(w.identity.peekPrincipal(ann.principalId)?.status, "active");

      assert.equal(w.store.stats.commits, committed, "no identity change was committed");
      assert.equal(JSON.stringify(w.store.snapshot()), before);
      assert.equal(w.events.length, hooks, "no security hook fired");
      assert.ok(w.failures.filter((what) => what.endsWith(": its security event")).length === 4, JSON.stringify(w.failures));
      /* A profile creation too. */
      const boot = await w.identity.bootstrap({ kind: "none" }, false, w.now());
      w.journal.failNext.push(fault);
      assert.equal((await w.identity.createProfile(readOf((boot as { setCookie: string | null }).setCookie), "Bo", w.now())).kind, "unavailable");
      assert.equal(w.store.snapshot().profiles.length, 1);
    });
  }

  test("review F2: a change the store refuses on its OWN checks leaves no event at all; the action fails", async () => {
    const w = await world();
    const ann = await creator(w);
    await recovered(w.identity, ann.key, w.now());
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    const before = JSON.stringify(w.store.snapshot());
    const journaled = w.journal.snapshot().length;
    w.store.failNext.push("definite"); // the memory store's refusal before it writes
    assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "unavailable");
    w.store.failNext.push("definite");
    assert.equal((await w.identity.rotateRecoveryKey(ann.read, w.now())).kind, "unavailable");
    w.store.failNext.push("definite");
    await assert.rejects(w.identity.revoke(sessionIdOf(ann.read), "logout", w.now()), StoreDefiniteError);
    assert.equal(JSON.stringify(w.store.snapshot()), before);
    assert.equal(w.journal.snapshot().length, journaled, "no event for a change the store refused before writing");
    assert.ok(!w.order.includes("event:signed-out-others") && !w.order.includes("event:recovery-key-rotated") && !w.order.includes("event:family-revoked"));
    assert.equal(w.failures.filter((what) => what.includes("security event")).length, 0, "reported as the store's failures, not the journal's");
  });

  test("a write refused AFTER its event (a condition only the table checks) leaves the event UNCONFIRMED -- a phantom, the safe direction; nothing written, the action fails", async () => {
    const w = await world();
    const ann = await creator(w);
    const phone = await recovered(w.identity, ann.key, w.now());
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    const before = JSON.stringify(w.store.snapshot());
    w.quirks.push("refuse-after-hook");
    assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "unavailable");
    assert.equal(JSON.stringify(w.store.snapshot()), before);
    assert.equal(w.identity.authenticate(phone, w.now()).kind, "ok", "the other device is still signed in: nothing happened");
    const events = await w.journal.eventsOf(ann.principalId);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["profile-created", "confirmed", "signed-out-others"],
      "the sign-out is journaled with no confirmation: a replay may end more, never less",
    );
    /* The retry commits, and is confirmed -- under its own event. */
    assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "ok");
    const after = await w.journal.eventsOf(ann.principalId);
    assert.deepEqual(after.slice(3).map((event) => event.kind), ["signed-out-others", "confirmed"]);
    assert.equal((after[4] as Extract<SecurityEvent, { kind: "confirmed" }>).confirms, after[3].event_id);
  });

  test("a write whose outcome is unknown after its event: the event stays unconfirmed; the action fails as a store failure", async () => {
    const w = await world();
    const ann = await creator(w);
    await recovered(w.identity, ann.key, w.now());
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    w.store.failNext.push("uncertain");
    assert.equal((await w.identity.rotateRecoveryKey(ann.read, w.now())).kind, "unavailable");
    const events = await w.journal.eventsOf(ann.principalId);
    assert.deepEqual(events.map((event) => event.kind), ["profile-created", "confirmed", "recovery-key-rotated"], "no confirmation for an unknown outcome");
  });

  for (const fault of ["definite", "uncertain"] as const) {
    test(`a confirmation that cannot be written (${fault}): the change is committed, the action succeeds, and the failure is reported`, async () => {
      const w = await world();
      const ann = await creator(w);
      const phone = await recovered(w.identity, ann.key, w.now());
      assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
      w.confirmationFaults.push(fault);
      assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "ok");
      assert.equal(w.identity.authenticate(phone, w.now()).kind === "ok", false, "the other device is signed out");
      assert.deepEqual(w.failures, ["signing out other devices: its security event's confirmation"]);
      const kinds = (await w.journal.eventsOf(ann.principalId)).map((event) => event.kind);
      assert.deepEqual(kinds, ["profile-created", "confirmed", "signed-out-others"]);
      assert.ok(w.store.snapshot().families.some((family) => family.revoke_reason === "signed-out-remotely"), "committed");
    });
  }

  test("re-review N2: a committed change is ENFORCED before its confirmation is written -- a stalled confirmation delays the answer, never the sign-out", async () => {
    const w = await world();
    const ann = await creator(w);
    const phone = await recovered(w.identity, ann.key, w.now());
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    let release: () => void = () => undefined;
    w.stall.gate = new Promise<void>((resolve) => (release = resolve));
    const hooks = w.events.length;
    const logged = w.order.length;
    const pending = w.identity.signOutOthers(ann.read, w.now());
    await until(() => w.order.slice(logged).includes("event:confirmed"), "the confirmation's append");
    assert.notEqual(w.identity.authenticate(phone, w.now()).kind, "ok", "the other device is already signed out in memory");
    assert.equal(w.identity.socketVerdict({ principalId: ann.principalId, sessionId: sessionIdOf(phone), sessionExpiresAt: (w.identity.peekSession(sessionIdOf(phone)) as Session).expires_at }, w.now()), "revoked");
    assert.deepEqual(w.events.slice(hooks), ["family-revoked"], "and its hooks (the sockets' closing) have fired");
    release();
    w.stall.gate = null;
    assert.equal((await pending).kind, "ok");
    assertConfirmedPairs(await w.journal.eventsOf(ann.principalId));
  });

  test("a store that writes WITHOUT calling beforeWrite breaks the port: the service still journals the event (after), and reports the breach", async () => {
    const w = await world();
    const ann = await creator(w);
    await recovered(w.identity, ann.key, w.now());
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    w.quirks.push("skip-hook");
    assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "ok");
    assert.deepEqual(w.order.slice(-4), ["commit", "written", "event:signed-out-others", "event:confirmed"]);
    assert.deepEqual(w.failures, ["signing out other devices: the store committed without its security event first"]);
    assertConfirmedPairs(await w.journal.eventsOf(ann.principalId));
  });

  test("no event for what is not durable or not a security change: a provisional guest's sign-out, a session rotation, a link code, a sweep", async () => {
    const w = await world();
    const guest = readOf(((await w.identity.bootstrap({ kind: "none" }, false, w.now())) as { setCookie: string | null }).setCookie);
    assert.equal(await w.identity.revoke(sessionIdOf(guest), "logout", w.now()), true, "a provisional guest's sign-out writes nothing");
    const ann = await creator(w);
    const count = w.journal.snapshot().length;
    w.advance(8 * 24 * 60 * MIN);
    const rotation = await w.identity.bootstrap(ann.read, false, w.now());
    assert.equal((rotation as { rotated: boolean }).rotated, true);
    const current = readOf((rotation as { setCookie: string | null }).setCookie);
    assert.equal((await w.identity.createLinkCode(current, w.now())).kind, "ok");
    await w.identity.sweep(w.now() + MIN);
    assert.equal(w.journal.snapshot().length, count, "only the profile creation was journaled");
    assert.equal(count, 2, "the creation and its confirmation");
  });
});

/* ================================================================================================= */
/* B. Durable grants                                                                                 */
/* ================================================================================================= */

describe("L5-4 B: sensitive-auth grants survive a restart of the identity writer (OD-5-4), and nothing else changes", () => {
  test("a re-authentication is written durably; a restart honours it for THIS session only, until its expiry", async () => {
    const w = await world();
    const ann = await creator(w);
    const phone = await recovered(w.identity, ann.key, w.now());
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    const stored = w.grants.snapshot();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].session_id, sessionIdOf(ann.read));
    assert.equal(stored[0].selector, ann.key.split(".")[0]);
    assert.equal(stored[0].expires_at, w.now() + 5 * MIN);
    w.advance(MIN);
    const restarted = await w.restart();
    assert.equal(restarted.hasSensitiveAuth(ann.read, w.now()), true, "the restart kept the grant");
    assert.equal(restarted.hasSensitiveAuth(phone, w.now()), false, "no other session borrows it");
    w.advance(4 * MIN);
    assert.equal(restarted.hasSensitiveAuth(ann.read, w.now()), false, "it lapses at its expiry, as before");
    assert.equal((await w.restart()).hasSensitiveAuth(ann.read, w.now()), false, "and a lapsed grant is not reloaded");
  });

  test("a reloaded grant never adds a capability: dead after a key rotation, a sign-out of its family, or a disabled principal", async () => {
    for (const ending of ["rotation", "sign-out", "disable"] as const) {
      const w = await world();
      const ann = await creator(w);
      assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
      const phone = await recovered(w.identity, ann.key, w.now());
      assert.equal((await w.identity.reauthenticate(phone, ann.key, w.now())).kind, "ok");
      /* The phone ends ann's standing in one of three ways; the stored grant of ann stays behind. */
      if (ending === "rotation") assert.equal((await w.identity.rotateRecoveryKey(phone, w.now())).kind, "ok");
      if (ending === "sign-out") assert.equal((await w.identity.signOutOthers(phone, w.now())).kind, "ok");
      if (ending === "disable") assert.equal(await w.identity.disablePrincipal(ann.principalId, w.now()), true);
      assert.ok(w.grants.snapshot().some((grant) => grant.session_id === sessionIdOf(ann.read)), "the item is still stored (deleting it is only hygiene)");
      const restarted = await w.restart();
      assert.equal(restarted.hasSensitiveAuth(ann.read, w.now()), false, `after a ${ending}, the reloaded grant is dead`);
      assert.equal((await restarted.rotateRecoveryKey(ann.read, w.now())).kind === "ok", false);
    }
  });

  test("a grant that cannot be written is still honoured in this process, reported, and not there after a restart", async () => {
    const w = await world();
    const ann = await creator(w);
    w.grants.failNext.push("definite");
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    assert.equal(w.identity.hasSensitiveAuth(ann.read, w.now()), true);
    assert.deepEqual(w.failures, ["recording a re-authentication"]);
    assert.equal((await w.restart()).hasSensitiveAuth(ann.read, w.now()), false);
  });

  test("the reload keeps only grants of known sessions (a grant can never name a session into existence)", async () => {
    const w = await world();
    const ann = await creator(w);
    const set = { session_id: "se_0000000000000000000000000w", family_id: "sf_0000000000000000000000000w", selector: ann.key.split(".")[0], expires_at: w.now() + MIN };
    await w.grants.put(set);
    const restarted = await w.restart();
    assert.equal(restarted.sizes().grants, 0);
  });
});

/* ================================================================================================= */
/* C. Without the substrate                                                                          */
/* ================================================================================================= */

describe("L5-4 C: without the substrate, the service is exactly the pre-LIVE-5 service", () => {
  test("no journal and no grant store: nothing is appended or stored anywhere new, and a restart drops the grant (as before)", async () => {
    const w = await world({});
    const ann = await creator(w);
    assert.equal((await w.identity.reauthenticate(ann.read, ann.key, w.now())).kind, "ok");
    assert.equal((await w.identity.signOutOthers(ann.read, w.now())).kind, "ok");
    assert.deepEqual(w.order, ["commit", "written"], "only the store heard anything (sign-out-others with no other device wrote nothing)");
    assert.deepEqual(w.journal.snapshot(), []);
    assert.deepEqual(w.grants.snapshot(), []);
    assert.equal((await w.restart()).hasSensitiveAuth(ann.read, w.now()), false, "restart drops the grant, as ESCROW-3A had it");
  });
});
