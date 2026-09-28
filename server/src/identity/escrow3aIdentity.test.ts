// server/src/identity/escrow3aIdentity.test.ts
//
// ==================================================================
//  ESCROW-3A (brief §10): IDENTITY HARDENING BEFORE A WALLET CAN BE BOUND
// ==================================================================
//
//   A. SESSION FAMILY (IR-03): one browser's rotation lineage is one durable family; a sign-out closes the family, so a
//      grace successor minted from an old cookie by a sibling tab -- linked to nothing the sign-out used to walk -- ends
//      with it, in whichever order the two arrive; "Sign out other devices" closes every other family; a mint into a
//      closed family is refused by the STORE's precondition too (the LIVE-5 conditional write); families survive a
//      restart and compaction; a LIVE-3C (v3) directory is migrated explicitly, before any new journal line.
//   B. SENSITIVE-ACTION RE-AUTHENTICATION: a live session alone cannot rotate the recovery key or sign out other devices;
//      the recovery key presented again grants THIS session a short-lived grant that another session cannot borrow and
//      a key rotation makes stale.
//   E. (owner review) THE LOST-CREATE-RESPONSE RESCUE replaces the one-hour creator exemption: not a time window but a
//      one-time capability of the creating SESSION holding the creating page's receipt, closed by the page's
//      acknowledgement, by any rotation or re-authentication, by ten minutes, and by a restart.
//   C. FINANCIAL-CREDENTIAL STANDING (F-2's identity side): what a wallet ticket is issued under, and every security event
//      that must end it.
//   D. The HTTP surface of the re-authentication.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

import { apiRequest, bootstrapCookie, cookieFromAnswer, profiledBrowser, quietConsole, startServer, stopServer, PROD_ORIGIN } from "../rooms/testSupport";
import { readSessionCookie, type SessionCookieRead } from "./cookies";
import { IDENTITY_FILE } from "./fileStore";
import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoveryKey, mintSecret, mintSessionId, secretHash } from "./ids";
import { createJournalIdentityStore, IDENTITY_JOURNAL_FILE, IDENTITY_SNAPSHOT_VERSION, journalLine } from "./journalStore";
import { IdentityService } from "./sessions";
import { createMemoryIdentityStore, IdentityStoreCorruptError, type IdentityStore, type MemoryIdentityStore, type Session } from "./store";

quietConsole();

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = 1_760_000_000_000;
const quiet = { warn: () => undefined };

const readOf = (setCookie: string | null): SessionCookieRead => {
  assert.ok(setCookie, "a Set-Cookie");
  return readSessionCookie(setCookie.split(";")[0]);
};
const sessionIdOf = (read: SessionCookieRead): string => (read.kind === "session" ? read.sessionId : "");

async function openService<S extends IdentityStore = MemoryIdentityStore>(store: S = createMemoryIdentityStore() as unknown as S, policy = {}) {
  const ended: string[][] = [];
  const events: Array<{ kind: string; familyIds: readonly string[] }> = [];
  const identity = await IdentityService.open(store, {
    policy,
    hooks: { onSessionsEnded: (ids) => ended.push([...ids]), onSecurityEvent: (event) => events.push({ kind: event.kind, familyIds: event.familyIds }) },
  });
  return { identity, store, ended, events };
}

/** A new browser that creates its profile (with the creating page's receipt, when given): its cookie, its key. */
async function creator(identity: IdentityService, now: number, name = "Ann", receipt?: string): Promise<{ read: SessionCookieRead; key: string }> {
  const boot = await identity.bootstrap({ kind: "none" }, false, now);
  assert.equal(boot.kind, "ok");
  const read = readOf((boot as { setCookie: string | null }).setCookie);
  const created = await identity.createProfile(read, name, now, receipt);
  assert.equal(created.kind, "ok");
  return { read, key: (created as { recoveryKey: string }).recoveryKey };
}

/** A new browser recovered onto the profile (a second device). */
async function recovered(identity: IdentityService, key: string, now: number): Promise<SessionCookieRead> {
  const boot = await identity.bootstrap({ kind: "none" }, false, now);
  const temp = readOf((boot as { setCookie: string | null }).setCookie);
  const outcome = await identity.recover(temp, key, now);
  assert.equal(outcome.kind, "ok");
  return readOf((outcome as { setCookie: string }).setCookie);
}

const familyOf = (identity: IdentityService, read: SessionCookieRead): string => (identity.peekSession(sessionIdOf(read)) as Session).family_id;

/* ================================================================================================= */
/* A. Session families (IR-03)                                                                       */
/* ================================================================================================= */

describe("ESCROW-3A A: session families close IR-03", () => {
  test("rotation and grace successors inherit the family; recovery and linking found new ones; ids are private and derived", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const family = familyOf(identity, ann.read);
    assert.equal(family, familyIdOf(sessionIdOf(ann.read)), "named after the founding session");
    assert.match(family, /^sf_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]$/);
    assert.equal(identity.peekFamily(family)?.origin, "bootstrap");
    const rotated = await identity.bootstrap(ann.read, false, T0 + 8 * DAY);
    assert.equal((rotated as { rotated: boolean }).rotated, true);
    const successor = readOf((rotated as { setCookie: string }).setCookie);
    assert.equal(familyOf(identity, successor), family, "a rotation successor joins the lineage");
    const grace = await identity.bootstrap(ann.read, false, T0 + 8 * DAY + 1000);
    const graceRead = readOf((grace as { setCookie: string }).setCookie);
    assert.notEqual(sessionIdOf(graceRead), sessionIdOf(successor));
    assert.equal(familyOf(identity, graceRead), family, "so does a grace successor minted from the old cookie");
    const phone = await recovered(identity, ann.key, T0 + 8 * DAY + 2000);
    assert.notEqual(familyOf(identity, phone), family);
    assert.equal(identity.peekFamily(familyOf(identity, phone))?.origin, "recovery");
  });

  test("IR-03: a sign-out ends the grace successor a sibling tab minted from the old cookie -- the survivor LIVE-2F/3D recorded", async () => {
    const { identity, store, events } = await openService();
    const ann = await creator(identity, T0);
    const t = T0 + 8 * DAY;
    const tab1 = readOf(((await identity.bootstrap(ann.read, false, t)) as { setCookie: string }).setCookie); // S0 -> S1
    const tab2 = readOf(((await identity.bootstrap(ann.read, false, t + 5)) as { setCookie: string }).setCookie); // grace S2 from S0
    const s2 = sessionIdOf(tab2);
    assert.equal(identity.peekSession(sessionIdOf(ann.read))?.rotated_to, sessionIdOf(tab1), "S2 is not on S0's rotated_to chain");
    assert.equal(await identity.revoke(sessionIdOf(tab1), "logout", t + 10), true);
    // S2 is ended: in memory, at the socket check, at the bootstrap, and in the store.
    assert.equal(identity.authenticate(tab2, t + 20).kind, "refused");
    assert.deepEqual(identity.classify(tab2, false, t + 20), { kind: "ended", reason: "logout" });
    assert.equal(identity.socketVerdict({ principalId: identity.peekSession(s2)!.principal_id, sessionId: s2, sessionExpiresAt: t + DAY }, t + 20), "revoked");
    const stored = store.snapshot();
    assert.equal(stored.sessions.find((x) => x.session_id === s2)?.revoke_reason, "logout");
    assert.equal(stored.families.find((f) => f.family_id === familyOf(identity, ann.read))?.revoke_reason, "logout");
    assert.deepEqual(events.map((e) => e.kind), ["family-revoked"]);
  });

  test("the sign-out and the grace mint RACING (queued together, both orders): no survivor either way", async () => {
    for (const order of ["signout-first", "mint-first"] as const) {
      const { identity } = await openService();
      const ann = await creator(identity, T0);
      const t = T0 + 8 * DAY;
      const tab1 = readOf(((await identity.bootstrap(ann.read, false, t)) as { setCookie: string }).setCookie);
      const signout = () => identity.revoke(sessionIdOf(tab1), "logout", t + 10);
      const mint = () => identity.bootstrap(ann.read, false, t + 10);
      const [first, second] = order === "signout-first" ? [signout(), mint()] : [mint(), signout()];
      const results = await Promise.all([first, second]);
      const minted = results.find((r) => typeof r === "object" && r !== null && "kind" in r) as { kind: string; setCookie?: string };
      if (minted.kind === "ok") {
        assert.equal(identity.authenticate(readOf(minted.setCookie as string), t + 20).kind, "refused", `${order}: the successor minted first ended with its family`);
      } else {
        assert.equal(minted.kind, "ended", `${order}: no successor is minted into a closed family`);
      }
      assert.equal(identity.authenticate(ann.read, t + 20).kind, "refused");
      assert.equal(identity.authenticate(tab1, t + 20).kind, "refused");
    }
  });

  test("sign-out-others racing another device's grace successor: every other family closes, so nothing survives in either order", async () => {
    for (const order of ["others-first", "mint-first"] as const) {
      const { identity } = await openService();
      const ann = await creator(identity, T0);
      const phone = await recovered(identity, ann.key, T0 + 1000);
      const t = T0 + 8 * DAY;
      readOf(((await identity.bootstrap(phone, false, t)) as { setCookie: string }).setCookie); // the phone rotates
      assert.equal((await identity.reauthenticate(ann.read, ann.key, t)).kind, "ok");
      const others = () => identity.signOutOthers(ann.read, t + 10);
      const mint = () => identity.bootstrap(phone, false, t + 10); // the phone's other tab, old cookie, in grace
      const results = order === "others-first" ? await Promise.all([others(), mint()]) : (await Promise.all([mint(), others()])).reverse();
      assert.equal((results[0] as { kind: string }).kind, "ok");
      const minted = results[1] as { kind: string; setCookie?: string };
      if (minted.kind === "ok") assert.equal(identity.authenticate(readOf(minted.setCookie as string), t + 20).kind, "refused", order);
      else assert.equal(minted.kind, "ended", order);
      assert.equal(identity.authenticate(ann.read, t + 20).kind, "ok", "the device that signed the others out stays");
      assert.equal(identity.peekFamily(familyOf(identity, phone))?.revoke_reason, "signed-out-remotely");
    }
  });

  test("the STORE refuses a mint into a closed family (`family-open`) -- the condition LIVE-5's transaction carries", async () => {
    const { identity, store } = await openService();
    const ann = await creator(identity, T0);
    const family = familyOf(identity, ann.read);
    const t = T0 + 8 * DAY;
    await identity.bootstrap(ann.read, false, t); // S0 rotated, still in grace
    await identity.revoke(sessionIdOf(ann.read), "logout", t + 1);
    const snapshot = store.snapshot();
    const principal = snapshot.sessions[0].principal_id;
    const sessionId = mintSessionId();
    const late: Session = { ...snapshot.sessions[0], session_id: sessionId, revoked_at: null, revoke_reason: null, rotated_to: null, family_id: family, principal_id: principal };
    await assert.rejects(store.commit({ expect: [{ kind: "family-open", family_id: family }, { kind: "session-absent", session_id: sessionId }], sessions: [late] }), /family-open/);
    // The journal store (production's) also refuses to REOPEN a revoked family, whatever the change's preconditions.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-reopen-"));
    try {
      const journal = createJournalIdentityStore(dir, quiet);
      await journal.load();
      const principals = snapshot.principals;
      await journal.commit({ principals, profiles: snapshot.profiles, sessions: snapshot.sessions, families: snapshot.families });
      const closed = snapshot.families.find((f) => f.family_id === family)!;
      assert.notEqual(closed.revoked_at, null);
      await assert.rejects(journal.commit({ families: [{ ...closed, revoked_at: null, revoke_reason: null }] }), /reopen a revoked family/);
      await assert.rejects(journal.commit({ families: [{ ...closed, origin: "link" }] }), /change its origin/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("families are durable: a restart and a compaction keep every session's family and every family's revocation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-fam-"));
    try {
      const first = await openService(createJournalIdentityStore(dir, quiet));
      const ann = await creator(first.identity, T0);
      await first.identity.activate(first.identity.peekSession(sessionIdOf(ann.read))!.principal_id, T0);
      const phone = await recovered(first.identity, ann.key, T0 + 1000);
      const tab = readOf(((await first.identity.bootstrap(ann.read, false, T0 + 8 * DAY)) as { setCookie: string }).setCookie);
      await first.identity.revoke(sessionIdOf(phone), "logout", T0 + 8 * DAY + 1);
      const families = { ann: familyOf(first.identity, ann.read), phone: familyOf(first.identity, phone) };
      const again = await openService(createJournalIdentityStore(dir, quiet));
      assert.equal(familyOf(again.identity, tab), families.ann, "the rotation successor's family, after a restart");
      assert.equal(again.identity.peekFamily(families.phone)?.revoke_reason, "logout");
      assert.equal(again.identity.authenticate(phone, T0 + 8 * DAY + 2).kind, "refused");
      const store = createJournalIdentityStore(dir, quiet);
      const third = await openService(store);
      await store.compact();
      const fourth = await openService(createJournalIdentityStore(dir, quiet));
      assert.equal(familyOf(fourth.identity, tab), families.ann, "and after a compaction");
      assert.equal(fourth.identity.peekFamily(families.phone)?.revoke_reason, "logout");
      assert.equal(third.identity.sizes().families, fourth.identity.sizes().families);
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8")) as { version: number; families: unknown[] };
      assert.equal(snapshot.version, IDENTITY_SNAPSHOT_VERSION);
      assert.ok(snapshot.families.length >= 2);
      const text = fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8") + (fs.existsSync(path.join(dir, IDENTITY_JOURNAL_FILE)) ? fs.readFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), "utf8") : "");
      assert.ok(!text.includes(ann.key.split(".")[1]), "no key secret on disk");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a LIVE-3C v3 directory is migrated explicitly: lineage families derived, the v4 snapshot written before any new line, and a sign-out then closes the whole lineage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-v3-"));
    try {
      const principalId = mintPrincipalId();
      const profileId = mintProfileId();
      const key = mintRecoveryKey();
      const legacy = (id: string, over: Record<string, unknown> = {}) => ({
        session_id: id,
        principal_id: principalId,
        secret_hash: secretHash(mintSecret()),
        created_at: T0,
        last_seen_at: T0,
        expires_at: T0 + 30 * DAY,
        revoked_at: null,
        revoke_reason: null,
        rotated_to: null,
        ...over,
      });
      const [a, b, c, other] = [mintSessionId(), mintSessionId(), mintSessionId(), mintSessionId()];
      const snapshotV3 = {
        format: "gs-identity",
        version: 3,
        seq: 0,
        principals: [{ principal_id: principalId, kind: "profile", status: "active", created_at: T0, activated_at: T0, last_seen_at: T0, account_link: profileId }],
        profiles: [
          { profile_id: profileId, principal_id: principalId, display_name: "Ann", created_at: T0, status: "active", recovery_selector: key.selector, recovery_hash: secretHash(key.secret), recovery_rotated_at: T0, schema: 1 },
        ],
        links: [],
        sessions: [legacy(a, { revoked_at: T0 + 1, revoke_reason: "rotated", rotated_to: b }), legacy(b), legacy(other)],
      };
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), `${JSON.stringify(snapshotV3)}\n`);
      // A v3 journal line: b rotated into c (legacy records, no family).
      const line = journalLine(1, { expect: [{ kind: "session-open", session_id: b }], sessions: [legacy(b, { revoked_at: T0 + 2, revoke_reason: "rotated", rotated_to: c }), legacy(c, { created_at: T0 + 2 })] } as never);
      fs.writeFileSync(path.join(dir, IDENTITY_JOURNAL_FILE), line);
      const store = createJournalIdentityStore(dir, quiet);
      const loaded = await store.load();
      const fam = familyIdOf(a);
      assert.deepEqual(
        loaded.sessions.filter((s) => s.session_id !== other).map((s) => s.family_id),
        [fam, fam, fam],
        "a -> b -> c is one lineage, named after its founder",
      );
      assert.equal(loaded.sessions.find((s) => s.session_id === other)?.family_id, familyIdOf(other));
      assert.ok(loaded.families.every((f) => f.origin === "legacy" && f.revoked_at === null));
      const written = JSON.parse(fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8")) as { version: number; seq: number };
      assert.deepEqual([written.version, written.seq], [IDENTITY_SNAPSHOT_VERSION, 1], "v4 at the journal's end, before any new line");
      assert.equal(store.health().loadedVersion, 3);
      const identity = await IdentityService.fromSnapshot(store, loaded);
      await identity.revoke(c, "logout", T0 + 10);
      const reloaded = await createJournalIdentityStore(dir, quiet).load();
      assert.equal(reloaded.families.find((f) => f.family_id === fam)?.revoke_reason, "logout");
      assert.equal(reloaded.sessions.find((s) => s.session_id === other)?.revoked_at, null, "another lineage (another device) is untouched");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("review #5: a v3 snapshot repeating a session id is refused as corrupt -- never resolved by keeping one (a revoked session would come back)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-v3dup-"));
    try {
      const principalId = mintPrincipalId();
      const id = mintSessionId();
      const legacy = (over: Record<string, unknown>) => ({
        session_id: id,
        principal_id: principalId,
        secret_hash: secretHash(mintSecret()),
        created_at: T0,
        last_seen_at: T0,
        expires_at: T0 + 30 * DAY,
        revoked_at: null,
        revoke_reason: null,
        rotated_to: null,
        ...over,
      });
      const snapshotV3 = {
        format: "gs-identity",
        version: 3,
        seq: 0,
        principals: [{ principal_id: principalId, kind: "unprofiled", status: "active", created_at: T0, activated_at: T0, last_seen_at: T0, account_link: null }],
        profiles: [],
        links: [],
        sessions: [legacy({ revoked_at: T0 + 1, revoke_reason: "logout" }), legacy({})],
      };
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), `${JSON.stringify(snapshotV3)}\n`);
      await assert.rejects(createJournalIdentityStore(dir, quiet).load(), IdentityStoreCorruptError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("review #4 (superseded by the owner review): a browser from before families that creates its profile after the upgrade uses the SAME receipt rescue -- no family origin grants anything", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-v3creator-"));
    try {
      const guest = mintPrincipalId();
      const guestSession = mintSessionId();
      const guestSecret = mintSecret();
      const snapshotV3 = {
        format: "gs-identity",
        version: 3,
        seq: 0,
        /* A durable UNPROFILED browser (it made a table before profiles existed): a legacy family after migration. */
        principals: [{ principal_id: guest, kind: "unprofiled", status: "active", created_at: T0, activated_at: T0, last_seen_at: T0, account_link: null }],
        profiles: [],
        links: [],
        sessions: [
          { session_id: guestSession, principal_id: guest, secret_hash: secretHash(guestSecret), created_at: T0, last_seen_at: T0, expires_at: T0 + 30 * DAY, revoked_at: null, revoke_reason: null, rotated_to: null },
        ],
      };
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), `${JSON.stringify(snapshotV3)}\n`);
      const store = createJournalIdentityStore(dir, quiet);
      const identity = await IdentityService.fromSnapshot(store, await store.load());
      const guestRead: SessionCookieRead = { kind: "session", sessionId: guestSession, secret: guestSecret };
      const t = T0 + 20 * MIN;
      const receipt = randomBytes(32).toString("hex");
      assert.equal((await identity.createProfile(guestRead, "Gus", t, receipt)).kind, "ok", "the create response is lost on the way back");
      assert.deepEqual(await identity.rotateRecoveryKey(guestRead, t + 1), { kind: "reauth-required" }, "the legacy family alone grants nothing");
      assert.equal((await identity.rotateRecoveryKey(guestRead, t + 2, receipt)).kind, "ok", "the creating page's receipt does, once");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================================================= */
/* B. Sensitive-action re-authentication                                                             */
/* ================================================================================================= */

describe("ESCROW-3A B: a live session alone cannot rotate the key or sign out other devices", () => {
  test("a stolen session (another device, or the creator's cookie after its hour) is refused `reauth-required`, and nothing changes", async () => {
    const { identity, store } = await openService();
    const ann = await creator(identity, T0);
    const stolen = await recovered(identity, ann.key, T0 + 1000); // any second session: the thief's copy
    const before = JSON.stringify(store.snapshot().profiles);
    assert.deepEqual(await identity.rotateRecoveryKey(stolen, T0 + 2000), { kind: "reauth-required" });
    assert.deepEqual(await identity.signOutOthers(stolen, T0 + 2000), { kind: "reauth-required" });
    assert.equal(JSON.stringify(store.snapshot().profiles), before);
    assert.equal(identity.authenticate(ann.read, T0 + 2000).kind, "ok", "the owner is still signed in");
    // The creator's own cookie, copied a moment after the profile was made: there is no time-window exemption.
    assert.deepEqual(await identity.rotateRecoveryKey(ann.read, T0 + 2 * 1000), { kind: "reauth-required" });
    assert.equal(identity.stats.reauthRequired, 3);
  });

  test("the recovery key re-authenticates THIS session: wrong keys and another profile's valid key are one `invalid`; the right one grants a short, unborrowable grant", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const bea = await creator(identity, T0, "Bea");
    const phone = await recovered(identity, ann.key, T0 + 1000);
    const t = T0 + 2 * 60 * MIN;
    for (const wrong of [bea.key, `${ann.key.split(".")[0]}.${mintSecret()}`, `${mintRecoveryKey().key}`, "rk_nonsense", 42, null]) {
      assert.deepEqual(await identity.reauthenticate(phone, wrong, t), { kind: "invalid" });
    }
    assert.deepEqual(await identity.signOutOthers(phone, t), { kind: "reauth-required" });
    const granted = await identity.reauthenticate(phone, ann.key, t);
    assert.deepEqual(granted, { kind: "ok", expiresAt: t + 5 * MIN });
    // Not borrowable: the laptop (another session, another family) has no grant.
    assert.deepEqual(await identity.signOutOthers(ann.read, t + 1), { kind: "reauth-required" });
    assert.equal(identity.hasSensitiveAuth(ann.read, t + 1), false);
    assert.equal(identity.hasSensitiveAuth(phone, t + 1), true);
    // It lapses.
    assert.equal(identity.hasSensitiveAuth(phone, t + 5 * MIN), false);
    assert.deepEqual(await identity.signOutOthers(phone, t + 5 * MIN), { kind: "reauth-required" });
    // Re-granted, it works; the laptop is signed out.
    await identity.reauthenticate(phone, ann.key, t + 6 * MIN);
    assert.deepEqual(await identity.signOutOthers(phone, t + 6 * MIN), { kind: "ok", signedOut: 1 });
    assert.equal(identity.authenticate(ann.read, t + 6 * MIN).kind, "refused");
  });

  test("a key rotation makes every grant stale -- the rotating session's own included, and another device's", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const phone = await recovered(identity, ann.key, T0 + 1000);
    const t = T0 + 2 * 60 * MIN;
    await identity.reauthenticate(ann.read, ann.key, t);
    await identity.reauthenticate(phone, ann.key, t);
    const rotated = await identity.rotateRecoveryKey(phone, t + 1);
    assert.equal(rotated.kind, "ok");
    assert.equal(identity.hasSensitiveAuth(phone, t + 2), false, "the rotating session's grant was made under the old key");
    assert.equal(identity.hasSensitiveAuth(ann.read, t + 2), false, "so was the laptop's");
    assert.deepEqual(await identity.signOutOthers(ann.read, t + 2), { kind: "reauth-required" });
    assert.deepEqual(await identity.reauthenticate(ann.read, ann.key, t + 3), { kind: "invalid" }, "the old key re-authenticates nothing");
    assert.equal((await identity.reauthenticate(ann.read, (rotated as { recoveryKey: string }).recoveryKey, t + 3)).kind, "ok");
  });

  test("concurrent valid recovery (§15): two browsers recovering with the same key at once both land on the SAME principal, each in its own family", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const temps = await Promise.all([1, 2].map(async (n) => readOf(((await identity.bootstrap({ kind: "none" }, false, T0 + n)) as { setCookie: string }).setCookie)));
    const outcomes = await Promise.all(temps.map((temp) => identity.recover(temp, ann.key, T0 + 5)));
    assert.deepEqual(outcomes.map((o) => o.kind), ["ok", "ok"]);
    const reads = outcomes.map((o) => readOf((o as { setCookie: string }).setCookie));
    const principal = identity.securityContextOf(ann.read, T0 + 6)!.principalId;
    assert.deepEqual(reads.map((read) => identity.securityContextOf(read, T0 + 6)?.principalId), [principal, principal], "recovery restores the same principal");
    const families = reads.map((read) => familyOf(identity, read));
    assert.notEqual(families[0], families[1]);
    assert.ok(!families.includes(familyOf(identity, ann.read)));
    assert.equal(identity.authenticate(ann.read, T0 + 6).kind, "ok", "the creator's browser is untouched");
  });

  test("sign-out-other-devices has NO creation rescue: a receipt is not even read by it", async () => {
    const { identity } = await openService();
    const receipt = randomBytes(32).toString("hex");
    const ann = await creator(identity, T0, "Ann", receipt);
    await recovered(identity, ann.key, T0 + 1);
    assert.deepEqual(await identity.signOutOthers(ann.read, T0 + 2), { kind: "reauth-required" });
    assert.equal(identity.hasOpenCreationRescue(ann.read, T0 + 2), true, "the rescue (for the key alone) is untouched by the refusal");
  });
});

/* ================================================================================================= */
/* E. The lost-create-response rescue (owner review: no time-window exemption)                       */
/* ================================================================================================= */

describe("ESCROW-3A E: the lost-create-response rescue is one-time, bound to the creating session and its page's receipt, and fails closed", () => {
  const receiptOf = () => randomBytes(32).toString("hex");

  test("1. a freshly created session whose page RECEIVED the key (acknowledged): rotation needs re-authentication, even with the receipt", async () => {
    const { identity } = await openService();
    const receipt = receiptOf();
    const ann = await creator(identity, T0, "Ann", receipt);
    assert.equal(identity.hasOpenCreationRescue(ann.read, T0), true);
    assert.deepEqual(await identity.acknowledgeKeyDelivery(ann.read, receipt, T0 + 1), { kind: "ok" });
    assert.equal(identity.hasOpenCreationRescue(ann.read, T0 + 1), false, "acknowledged: closed for good");
    assert.deepEqual(await identity.rotateRecoveryKey(ann.read, T0 + 2), { kind: "reauth-required" });
    assert.deepEqual(await identity.rotateRecoveryKey(ann.read, T0 + 3, receipt), { kind: "reauth-required" }, "the receipt opens nothing once the key arrived");
    /* A client that sends no receipt never opens a rescue at all. */
    const bea = await creator(identity, T0, "Bea");
    assert.equal(identity.hasOpenCreationRescue(bea.read, T0), false);
    assert.deepEqual(await identity.rotateRecoveryKey(bea.read, T0 + 1), { kind: "reauth-required" });
    /* The real path: re-authenticate with the key, then rotate. */
    await identity.reauthenticate(ann.read, ann.key, T0 + 4);
    assert.equal((await identity.rotateRecoveryKey(ann.read, T0 + 5)).kind, "ok");
    assert.equal(identity.stats.creationRescues, 0);
  });

  test("2. a stolen-equivalent live session (the creator's exact cookie, seconds old, rescue still open) cannot rotate without the page's receipt -- and never after the ack", async () => {
    const { identity, store } = await openService();
    const receipt = receiptOf();
    const ann = await creator(identity, T0, "Ann", receipt);
    const stolen: SessionCookieRead = { ...(ann.read as { kind: "session"; sessionId: string; secret: string }) }; // a byte-exact copy of the cookie
    const before = JSON.stringify(store.snapshot().profiles);
    assert.deepEqual(await identity.rotateRecoveryKey(stolen, T0 + 1), { kind: "reauth-required" }, "the cookie alone");
    assert.deepEqual(await identity.rotateRecoveryKey(stolen, T0 + 1, receiptOf()), { kind: "reauth-required" }, "a guessed receipt");
    assert.deepEqual(await identity.rotateRecoveryKey(stolen, T0 + 1, "0".repeat(64)), { kind: "reauth-required" });
    assert.deepEqual(await identity.acknowledgeKeyDelivery(stolen, receiptOf(), T0 + 1), { kind: "ok" }, "a thief's ack is answered the same ...");
    assert.equal(identity.hasOpenCreationRescue(ann.read, T0 + 1), true, "... and closes nothing");
    assert.equal(JSON.stringify(store.snapshot().profiles), before, "the key is unchanged");
    await identity.acknowledgeKeyDelivery(ann.read, receipt, T0 + 2);
    assert.deepEqual(await identity.rotateRecoveryKey(stolen, T0 + 3, receipt), { kind: "reauth-required" }, "even a thief who later learned the receipt");
  });

  test("3. a genuinely lost create response: the creating session with its page's receipt replaces the unseen key exactly once; the new key works, the unseen one never does", async () => {
    const { identity } = await openService();
    const receipt = receiptOf();
    const ann = await creator(identity, T0, "Ann", receipt); // the 201 carrying ann.key is "lost": the page never saw it
    const wrong = await identity.rotateRecoveryKey(ann.read, T0 + 1, receiptOf());
    assert.deepEqual(wrong, { kind: "reauth-required" }, "a wrong receipt consumes nothing ...");
    const rescued = await identity.rotateRecoveryKey(ann.read, T0 + 2, receipt);
    assert.equal(rescued.kind, "ok", "... and the right one replaces the key");
    const fresh = (rescued as { recoveryKey: string }).recoveryKey;
    assert.notEqual(fresh, ann.key);
    assert.equal(identity.stats.creationRescues, 1);
    assert.deepEqual(await identity.reauthenticate(ann.read, ann.key, T0 + 3), { kind: "invalid" }, "the unseen key is dead");
    assert.equal((await identity.reauthenticate(ann.read, fresh, T0 + 3)).kind, "ok", "the delivered one is the profile's key");
    const phone = await recovered(identity, fresh, T0 + 4);
    assert.equal(identity.securityContextOf(phone, T0 + 4)?.principalId, identity.securityContextOf(ann.read, T0 + 4)?.principalId, "the same principal");
  });

  test("4. a linked or recovered device, and the creating session's own rotation successor, never have the rescue -- even holding the receipt", async () => {
    const { identity } = await openService(createMemoryIdentityStore() as unknown as MemoryIdentityStore, { rotateAfterMs: MIN, creationRescueMs: 60 * MIN });
    const receipt = receiptOf();
    const ann = await creator(identity, T0, "Ann", receipt);
    const phone = await recovered(identity, ann.key, T0 + 1);
    assert.deepEqual(await identity.rotateRecoveryKey(phone, T0 + 2, receipt), { kind: "reauth-required" }, "a recovered device");
    const code = await identity.createLinkCode(ann.read, T0 + 3);
    const tabletTemp = readOf(((await identity.bootstrap({ kind: "none" }, false, T0 + 4)) as { setCookie: string }).setCookie);
    const tablet = readOf(((await identity.redeemLink(tabletTemp, (code as { code: string }).code, T0 + 4)) as { setCookie: string }).setCookie);
    assert.deepEqual(await identity.rotateRecoveryKey(tablet, T0 + 5, receipt), { kind: "reauth-required" }, "a linked device");
    /* The creating cookie, past its rotation age, rotates into a successor in the SAME family: still not the creating session. */
    const rotated = await identity.bootstrap(ann.read, false, T0 + 2 * MIN);
    assert.equal((rotated as { rotated: boolean }).rotated, true);
    const successor = readOf((rotated as { setCookie: string }).setCookie);
    assert.equal(familyOf(identity, successor), familyOf(identity, ann.read));
    assert.deepEqual(await identity.rotateRecoveryKey(successor, T0 + 2 * MIN + 1, receipt), { kind: "reauth-required" }, "a rotation successor");
    assert.equal(identity.stats.creationRescues, 0);
  });

  test("5. consumed: after its one use the rescue is gone -- the same receipt, the same session, cannot replace the key again", async () => {
    const { identity } = await openService();
    const receipt = receiptOf();
    const ann = await creator(identity, T0, "Ann", receipt);
    assert.equal((await identity.rotateRecoveryKey(ann.read, T0 + 1, receipt)).kind, "ok");
    assert.equal(identity.hasOpenCreationRescue(ann.read, T0 + 1), false);
    assert.deepEqual(await identity.rotateRecoveryKey(ann.read, T0 + 2, receipt), { kind: "reauth-required" });
    /* Every other resolution closes it too: a re-authentication (the key was received) and the ten-minute bound. */
    const bea = await creator(identity, T0, "Bea", receipt);
    await identity.reauthenticate(bea.read, bea.key, T0 + 1);
    assert.equal(identity.hasOpenCreationRescue(bea.read, T0 + 1), false, "a re-authentication proves the key arrived");
    const cyd = await creator(identity, T0, "Cyd", receipt);
    assert.deepEqual(await identity.rotateRecoveryKey(cyd.read, T0 + 10 * MIN, receipt), { kind: "reauth-required" }, "ten minutes");
    /* And a sign-out of the creating session: nothing is left to present it. */
    const dee = await creator(identity, T0, "Dee", receipt);
    await identity.revoke(sessionIdOf(dee.read), "logout", T0 + 1);
    assert.deepEqual(await identity.rotateRecoveryKey(dee.read, T0 + 2, receipt), { kind: "not-authenticated" });
  });

  test("6. a restart forgets every open rescue (memory only, by design): the restarted server needs re-authentication", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-rescue-restart-"));
    try {
      const receipt = receiptOf();
      const first = await openService(createJournalIdentityStore(dir, quiet));
      const ann = await creator(first.identity, T0, "Ann", receipt);
      assert.equal(first.identity.hasOpenCreationRescue(ann.read, T0 + 1), true);
      const second = await openService(createJournalIdentityStore(dir, quiet));
      assert.equal(second.identity.authenticate(ann.read, T0 + 2).kind, "ok", "the session itself survives the restart");
      assert.equal(second.identity.hasOpenCreationRescue(ann.read, T0 + 2), false);
      assert.deepEqual(await second.identity.rotateRecoveryKey(ann.read, T0 + 3, receipt), { kind: "reauth-required" });
      /* Nothing about the receipt reached the disk either. */
      for (const name of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, name), "utf8").includes(receipt), name);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================================================= */
/* C. What a financial credential is issued under, and what ends it                                 */
/* ================================================================================================= */

describe("ESCROW-3A C: financial-credential standing follows every security event", () => {
  test("logout, sign-out-others, key rotation and a disabled principal each end a credential issued under the old context", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const phone = await recovered(identity, ann.key, T0 + 1000);
    const t = T0 + 2 * 60 * MIN;
    const onPhone = identity.securityContextOf(phone, t)!;
    const onLaptop = identity.securityContextOf(ann.read, t)!;
    assert.equal(onPhone.principalId, onLaptop.principalId);
    assert.notEqual(onPhone.familyId, onLaptop.familyId);
    assert.deepEqual(identity.securityStanding(onPhone), { kind: "standing" });
    // The phone signs out: ITS credentials end; the laptop's stand.
    await identity.revoke(sessionIdOf(phone), "logout", t + 1);
    assert.deepEqual(identity.securityStanding(onPhone), { kind: "ended", why: "family" });
    assert.deepEqual(identity.securityStanding(onLaptop), { kind: "standing" });
    // Another device signs in and out-signs the laptop: the laptop's end.
    const tablet = await recovered(identity, ann.key, t + 2);
    const onTablet = identity.securityContextOf(tablet, t + 2)!;
    await identity.reauthenticate(tablet, ann.key, t + 3);
    await identity.signOutOthers(tablet, t + 3);
    assert.deepEqual(identity.securityStanding(onLaptop), { kind: "ended", why: "family" });
    // A key rotation ends EVERY credential issued under the old key, the rotating device's too.
    await identity.rotateRecoveryKey(tablet, t + 4);
    assert.deepEqual(identity.securityStanding(onTablet), { kind: "ended", why: "recovery-key" });
    const fresh = identity.securityContextOf(tablet, t + 5)!;
    assert.deepEqual(identity.securityStanding(fresh), { kind: "standing" });
    await identity.disablePrincipal(fresh.principalId, t + 6);
    assert.deepEqual(identity.securityStanding(fresh), { kind: "ended", why: "principal" });
  });
});

/* ================================================================================================= */
/* D. The HTTP surface                                                                               */
/* ================================================================================================= */

describe("ESCROW-3A D: POST /gs/api/profile/reauth", () => {
  test("200 {expiresAt} for the right key; one 403 for every wrong one; 403 profile-required unprofiled; 401 without a session; and a sensitive action says reauth-required", async () => {
    const { server, port } = await startServer({ identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => Date.now() } });
    try {
      const ann = await profiledBrowser(port, "Ann");
      const phoneTemp = await bootstrapCookie(port);
      const phone = cookieFromAnswer(await apiRequest(port, "/gs/api/profile/recover", { cookie: phoneTemp, body: { recoveryKey: ann.recoveryKey } })) as string;
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/sign-out-others", { cookie: phone, body: {} })).body, { error: "reauth-required" });
      const wrong = await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { recoveryKey: `${mintRecoveryKey().key}` } });
      const wrongSelector = await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { recoveryKey: `${ann.recoveryKey.split(".")[0]}.${mintSecret()}` } });
      assert.deepEqual([wrong.status, wrong.body], [403, { error: "invalid-credential" }]);
      assert.deepEqual([wrongSelector.status, wrongSelector.body], [wrong.status, wrong.body]);
      const ok = await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { recoveryKey: ann.recoveryKey } });
      assert.equal(ok.status, 200);
      assert.equal(typeof (ok.body as { expiresAt: unknown }).expiresAt, "number");
      assert.deepEqual(Object.keys(ok.body as object).sort(), ["expiresAt", "ok"], "no id, no key, nothing else");
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/sign-out-others", { cookie: phone, body: {} })).body, { ok: true, signedOut: 1 });
      const unprofiled = await bootstrapCookie(port);
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/reauth", { cookie: unprofiled, body: { recoveryKey: ann.recoveryKey } })).body, { error: "profile-required" });
      assert.equal((await apiRequest(port, "/gs/api/profile/reauth", { body: { recoveryKey: ann.recoveryKey } })).status, 401);
      assert.equal((await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { recoveryKey: ann.recoveryKey, extra: 1 } })).status, 400, "a closed body");
    } finally {
      await stopServer(server);
    }
  });

  test("the rescue over the wire: a lost create answer is replaced once by the creating page's receipt; an acknowledged one never; sign-out-others takes no receipt", async () => {
    const { server, port } = await startServer({ identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => Date.now() } });
    try {
      /* Lost: the 201 never reached the page (the test simply ignores it); the page still holds its receipt. */
      const receipt = randomBytes(32).toString("hex");
      const lost = await bootstrapCookie(port);
      const created = await apiRequest(port, "/gs/api/profile", { cookie: lost, body: { name: "Ann", creationReceipt: receipt } });
      assert.equal(created.status, 201);
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/recovery-key", { cookie: lost, body: {} })).body, { error: "reauth-required" }, "the cookie alone");
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/sign-out-others", { cookie: lost, body: { creationReceipt: receipt } })).status, 400, "sign-out-others takes no receipt at all");
      const rescued = await apiRequest(port, "/gs/api/profile/recovery-key", { cookie: lost, body: { creationReceipt: receipt } });
      assert.equal(rescued.status, 200);
      assert.notEqual((rescued.body as { recoveryKey: string }).recoveryKey, created.body?.recoveryKey);
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/recovery-key", { cookie: lost, body: { creationReceipt: receipt } })).body, { error: "reauth-required" }, "once");
      /* Delivered: the page acknowledges its key at once; the receipt is worthless from then on. */
      const receipt2 = randomBytes(32).toString("hex");
      const okBrowser = await bootstrapCookie(port);
      assert.equal((await apiRequest(port, "/gs/api/profile", { cookie: okBrowser, body: { name: "Bea", creationReceipt: receipt2 } })).status, 201);
      const ack = await apiRequest(port, "/gs/api/profile/key-received", { cookie: okBrowser, body: { creationReceipt: receipt2 } });
      assert.equal(ack.status, 204);
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/recovery-key", { cookie: okBrowser, body: { creationReceipt: receipt2 } })).body, { error: "reauth-required" });
      assert.equal((await apiRequest(port, "/gs/api/profile/key-received", { cookie: okBrowser, body: { creationReceipt: receipt2, extra: 1 } })).status, 400, "a closed body");
      assert.equal((await apiRequest(port, "/gs/api/profile/key-received", { body: { creationReceipt: receipt2 } })).status, 401);
      /* No receipt, and nothing about one, appears in a response. */
      assert.ok(!JSON.stringify([created.body, rescued.body, ack.text]).includes(receipt));
    } finally {
      await stopServer(server);
    }
  });
});
