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
//   B. SENSITIVE-ACTION RE-AUTHENTICATION: a live session alone cannot begin replacing the Authorization Wallet or sign
//      out other devices; "Confirm it's you" with the PASSWORD grants THIS session a short-lived grant that another
//      session cannot borrow, and that ends with the session's family (a password change on another device, a
//      recovery). PHASE 3 FINAL: the recovery key that used to re-authenticate (and whose rotation moved the credential
//      epoch) is gone; a sign-in's own grant covers the ordinary sensitive actions, never the wallet replacement.
//   E. (owner review) THE LOST-CREATE-RESPONSE RESCUE is retired with the recovery key: a lost create answer loses
//      nothing the player cannot type again (the username and password sign the same principal in).
//   C. FINANCIAL-CREDENTIAL STANDING (F-2's identity side): what a wallet ticket is issued under, and every security event
//      that must end it -- and the account operations that must NOT.
//   D. The HTTP surface of the re-authentication (and the retired rescue routes).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { accountBrowser, apiRequest, bootstrapCookie, loginOnFreshBrowser, profiledBrowser, quietConsole, startServer, stopServer, PROD_ORIGIN } from "../rooms/testSupport";
import { createAccountWith, keplrAccount, recoverWith, replaceWith, TEST_SITE, type KeplrAccount } from "../testSupport/authorizationWallets";
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
    policy: { passwordKdf: TEST_PASSWORD_KDF, ...policy },
    hooks: { onSessionsEnded: (ids) => ended.push([...ids]), onSecurityEvent: (event) => events.push({ kind: event.kind, familyIds: event.familyIds }) },
  });
  return { identity, store, ended, events };
}

/** PHASE 3 FINAL: an account and the browser that created it. `read` is the FRESH session the create signed it in on;
 *  `temporary` the browser's own (now `replaced`) bootstrap session. */
interface Account {
  readonly read: SessionCookieRead;
  readonly temporary: SessionCookieRead;
  readonly username: string;
  readonly password: string;
  readonly wallet: KeplrAccount;
}

const freshBrowser = async (identity: IdentityService, now: number): Promise<SessionCookieRead> => {
  const boot = await identity.bootstrap({ kind: "none" }, false, now);
  assert.equal(boot.kind, "ok");
  return readOf((boot as { setCookie: string | null }).setCookie);
};

/** A new browser that creates its account (username, password, Authorization Wallet). */
async function creator(identity: IdentityService, now: number, name = "Ann"): Promise<Account> {
  const temporary = await freshBrowser(identity, now);
  const username = name.toLowerCase();
  const password = `${name} correct horse battery`;
  const wallet = keplrAccount(`escrow3a/${username}`);
  const created = await createAccountWith(identity, temporary, { username, password, displayName: name, wallet }, now);
  assert.equal(created.kind, "ok");
  return { read: readOf((created as { setCookie: string }).setCookie), temporary, username, password, wallet };
}

/** A second device: a new browser signs in with the username and password (its own family). */
async function loggedIn(identity: IdentityService, account: { username: string; password: string }, now: number): Promise<SessionCookieRead> {
  const temporary = await freshBrowser(identity, now);
  const outcome = await identity.login(temporary, { username: account.username, password: account.password }, now);
  assert.equal(outcome.kind, "ok");
  return readOf((outcome as { setCookie: string }).setCookie);
}

/** "Forgot password?" on a new browser, signed by `wallet` (the account's Authorization Wallet, unless a test says not). */
async function recovered(identity: IdentityService, account: Account, newPassword: string, now: number, wallet: KeplrAccount = account.wallet) {
  const temporary = await freshBrowser(identity, now);
  const outcome = await recoverWith(identity, temporary, { username: account.username, wallet, newPassword }, now);
  return { outcome, read: outcome.kind === "ok" ? readOf(outcome.setCookie) : temporary };
}

const familyOf = (identity: IdentityService, read: SessionCookieRead): string => (identity.peekSession(sessionIdOf(read)) as Session).family_id;
const reauth = (identity: IdentityService, read: SessionCookieRead, password: unknown, now: number) => identity.reauthenticateWithPassword(read, password, now);
const replacementOf = (identity: IdentityService, read: SessionCookieRead, now: number) =>
  identity.mintReplacement(read, { newWallet: keplrAccount("escrow3a/another-wallet").address, site: TEST_SITE }, now);

/* ================================================================================================= */
/* A. Session families (IR-03)                                                                       */
/* ================================================================================================= */

describe("ESCROW-3A A: session families close IR-03", () => {
  test("rotation and grace successors inherit the family; a sign-in and a recovery found new ones; ids are private and derived", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const family = familyOf(identity, ann.read);
    assert.equal(family, familyIdOf(sessionIdOf(ann.read)), "named after the founding session");
    assert.match(family, /^sf_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]$/);
    /* PHASE 3 FINAL: the account is signed in on a FRESH session that founds its own family; the browser's temporary
       session and its family end `replaced`. */
    assert.equal(identity.peekFamily(family)?.origin, "login");
    assert.equal(identity.peekFamily(familyOf(identity, ann.temporary))?.revoke_reason, "replaced");
    const rotated = await identity.bootstrap(ann.read, false, T0 + 8 * DAY);
    assert.equal((rotated as { rotated: boolean }).rotated, true);
    const successor = readOf((rotated as { setCookie: string }).setCookie);
    assert.equal(familyOf(identity, successor), family, "a rotation successor joins the lineage");
    const grace = await identity.bootstrap(ann.read, false, T0 + 8 * DAY + 1000);
    const graceRead = readOf((grace as { setCookie: string }).setCookie);
    assert.notEqual(sessionIdOf(graceRead), sessionIdOf(successor));
    assert.equal(familyOf(identity, graceRead), family, "so does a grace successor minted from the old cookie");
    const phone = await loggedIn(identity, ann, T0 + 8 * DAY + 2000);
    assert.notEqual(familyOf(identity, phone), family);
    assert.equal(identity.peekFamily(familyOf(identity, phone))?.origin, "login", "another device signs in: a new family");
    /* "Forgot password?" by the Authorization Wallet: the recovering browser founds a `recovery` family, and every
       earlier family of the account closes. */
    const recovery = await recovered(identity, ann, "a brand new password", T0 + 8 * DAY + 3000);
    assert.equal(recovery.outcome.kind, "ok");
    assert.equal(identity.peekFamily(familyOf(identity, recovery.read))?.origin, "recovery");
    for (const read of [ann.read, phone]) assert.equal(identity.peekFamily(familyOf(identity, read))?.revoke_reason, "signed-out-remotely");
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
      const phone = await loggedIn(identity, ann, T0 + 1000);
      const t = T0 + 8 * DAY;
      readOf(((await identity.bootstrap(phone, false, t)) as { setCookie: string }).setCookie); // the phone rotates
      assert.equal((await reauth(identity, ann.read, ann.password, t)).kind, "ok");
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
      await first.identity.activate(first.identity.peekSession(sessionIdOf(ann.read))!.principal_id, T0); // a no-op: an account is durable
      const phone = await loggedIn(first.identity, ann, T0 + 1000);
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
      assert.ok(!text.includes(ann.password), "no password on disk");
      assert.ok(ann.read.kind === "session" && !text.includes(ann.read.secret), "no session secret on disk");
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


  test("review #4 (PHASE 3 FINAL): a browser from before families that creates its account after the upgrade signs in on a fresh family -- its legacy family ends, and no family origin grants anything a sign-in does not", async () => {
    /* The receipt rescue this test used to exercise is retired with the recovery key (nothing is lost with a create
       answer any more: the username and password sign the account in again). */
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
      const identity = IdentityService.fromSnapshot(store, await store.load(), { policy: { passwordKdf: TEST_PASSWORD_KDF } });
      const guestRead: SessionCookieRead = { kind: "session", sessionId: guestSession, secret: guestSecret };
      const legacyFamily = familyOf(identity, guestRead);
      assert.equal(identity.peekFamily(legacyFamily)?.origin, "legacy");
      const t = T0 + 20 * MIN;
      assert.deepEqual(replacementOf(identity, guestRead, t), { kind: "profile-required" }, "the legacy family alone grants nothing");
      const created = await createAccountWith(identity, guestRead, { username: "gus", password: "Gus correct horse battery", displayName: "Gus", wallet: keplrAccount("escrow3a/gus") }, t);
      assert.equal(created.kind, "ok", "a durable browser may create its account (its tables come with it)");
      const fresh = readOf((created as { setCookie: string }).setCookie);
      assert.equal(identity.securityContextOf(fresh, t)?.principalId, guest, "the same principal: its tables are its own");
      assert.equal(identity.peekFamily(familyOf(identity, fresh))?.origin, "login", "a fresh family, not the legacy one");
      assert.equal(identity.peekFamily(legacyFamily)?.revoke_reason, "replaced", "the legacy family ends with the temporary session");
      assert.deepEqual(identity.classify(guestRead, false, t + 1), { kind: "ended", reason: "replaced" });
      /* The sign-in's own grant covers the ordinary sensitive actions; the Authorization Wallet's replacement asks for an
         explicit "Confirm it's you" whatever family the browser came from. */
      assert.equal(identity.hasSensitiveAuth(fresh, t + 1), true);
      assert.deepEqual(replacementOf(identity, fresh, t + 1), { kind: "reauth-required" });
      assert.equal((await reauth(identity, fresh, "Gus correct horse battery", t + 2)).kind, "ok");
      assert.equal(replacementOf(identity, fresh, t + 2).kind, "ok");
      /* Durable: the legacy family's end and the new family are on disk. */
      const reloaded = await createJournalIdentityStore(dir, quiet).load();
      assert.equal(reloaded.families.find((f) => f.family_id === legacyFamily)?.revoke_reason, "replaced");
      assert.equal(reloaded.families.find((f) => f.family_id === familyOf(identity, fresh))?.revoked_at, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================================================= */
/* B. Sensitive-action re-authentication                                                             */
/* ================================================================================================= */

describe("ESCROW-3A B: a live session alone cannot begin replacing the Authorization Wallet or sign out other devices", () => {
  test("a stolen session (another device past its sign-in's grant, or the creator's own cookie) is refused `reauth-required`, and nothing changes", async () => {
    const { identity, store } = await openService();
    const ann = await creator(identity, T0);
    const stolen = await loggedIn(identity, ann, T0 + 1000); // any second session: the thief's copy
    const t = T0 + 1000 + 5 * MIN; // the sign-in's own grant has lapsed
    const before = JSON.stringify(store.snapshot().profiles);
    assert.deepEqual(replacementOf(identity, stolen, t), { kind: "reauth-required" });
    assert.deepEqual(await identity.signOutOthers(stolen, t), { kind: "reauth-required" });
    assert.equal(JSON.stringify(store.snapshot().profiles), before);
    assert.equal(identity.authenticate(ann.read, t).kind, "ok", "the owner is still signed in");
    /* The creator's own cookie, copied a moment after the account was made. P3-ACCT POLICY: the sign-in that just
       happened IS a recent authentication for the ordinary sensitive actions -- but never for the highest-authority one:
       replacing the Authorization Wallet needs an explicit "Confirm it's you". */
    assert.equal(identity.hasSensitiveAuth(ann.read, T0 + 2000), true);
    assert.deepEqual(replacementOf(identity, ann.read, T0 + 2000), { kind: "reauth-required" });
    assert.equal(identity.stats.reauthRequired, 3);
  });

  test("the password re-authenticates THIS session: wrong passwords and another account's valid password are one `invalid`; the right one grants a short, unborrowable grant", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const bea = await creator(identity, T0, "Bea");
    const phone = await loggedIn(identity, ann, T0 + 1000);
    const t = T0 + 2 * 60 * MIN;
    for (const wrong of [bea.password, `${ann.password} `, ann.password.toUpperCase(), ann.username, "", "x".repeat(5000), 42, null]) {
      assert.deepEqual(await reauth(identity, phone, wrong, t), { kind: "invalid" });
    }
    assert.equal(identity.stats.reauthFailures, 8);
    assert.deepEqual(await identity.signOutOthers(phone, t), { kind: "reauth-required" });
    const granted = await reauth(identity, phone, ann.password, t);
    assert.deepEqual(granted, { kind: "ok", expiresAt: t + 5 * MIN });
    // Not borrowable: the laptop (another session, another family) has no grant.
    assert.deepEqual(await identity.signOutOthers(ann.read, t + 1), { kind: "reauth-required" });
    assert.equal(identity.hasSensitiveAuth(ann.read, t + 1), false);
    assert.equal(identity.hasSensitiveAuth(phone, t + 1), true);
    // It lapses.
    assert.equal(identity.hasSensitiveAuth(phone, t + 5 * MIN), false);
    assert.deepEqual(await identity.signOutOthers(phone, t + 5 * MIN), { kind: "reauth-required" });
    // Re-granted, it works; the laptop is signed out.
    await reauth(identity, phone, ann.password, t + 6 * MIN);
    assert.deepEqual(await identity.signOutOthers(phone, t + 6 * MIN), { kind: "ok", signedOut: 1 });
    assert.equal(identity.authenticate(ann.read, t + 6 * MIN).kind, "refused");
  });

  test("a password change ends every other device's grant with its family, and leaves the changer only a sign-in's grant -- the old password confirms nothing", async () => {
    /* PHASE 3 FINAL: this test used to be "a key rotation makes every grant stale". No action moves the credential epoch
       any more (sessions.ts); what ends a grant is the end of its session or family. */
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const phone = await loggedIn(identity, ann, T0 + 1000);
    const t = T0 + 2 * 60 * MIN;
    await reauth(identity, ann.read, ann.password, t);
    await reauth(identity, phone, ann.password, t);
    assert.equal(identity.hasSensitiveAuth(ann.read, t), true);
    assert.equal(identity.hasSensitiveAuth(phone, t), true);
    const epoch = identity.securityContextOf(phone, t)?.recoverySelector;
    const changed = await identity.changePassword(phone, { currentPassword: ann.password, newPassword: "Ann's new password" }, t + 1);
    assert.equal(changed.kind, "ok");
    assert.equal((changed as { signedOut: number }).signedOut, 1, "the laptop was signed out");
    const phoneNext = readOf((changed as { setCookie: string }).setCookie);
    assert.equal(familyOf(identity, phoneNext), familyOf(identity, phone), "the changer goes on in ITS OWN family");
    assert.equal(identity.authenticate(phone, t + 2).kind, "refused", "on a fresh session: the one it replaced ends");
    assert.equal(identity.hasSensitiveAuth(phone, t + 2), false, "and its confirmation with it");
    assert.equal(identity.authenticate(ann.read, t + 2).kind, "refused");
    assert.equal(identity.hasSensitiveAuth(ann.read, t + 2), false, "the laptop's grant ended with its family");
    assert.equal(identity.peekFamily(familyOf(identity, ann.read))?.revoke_reason, "signed-out-remotely");
    assert.equal(identity.hasSensitiveAuth(phoneNext, t + 2), true, "the change is itself a sign-in: the fresh session's own grant ...");
    assert.deepEqual(replacementOf(identity, phoneNext, t + 2), { kind: "reauth-required" }, "... never a 'Confirm it's you'");
    assert.deepEqual(await reauth(identity, phoneNext, ann.password, t + 3), { kind: "invalid" }, "the old password re-authenticates nothing");
    assert.equal((await reauth(identity, phoneNext, "Ann's new password", t + 3)).kind, "ok");
    assert.equal(replacementOf(identity, phoneNext, t + 3).kind, "ok");
    assert.equal(identity.securityContextOf(phoneNext, t + 3)?.recoverySelector, epoch, "the credential epoch did not move");
  });

  test("a recovery by the Authorization Wallet ends every family and every grant; a replacement of the wallet ends none and moves no epoch -- and the replaced wallet recovers nothing", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const phone = await loggedIn(identity, ann, T0 + 1000);
    const t = T0 + 2 * 60 * MIN;
    assert.equal((await reauth(identity, ann.read, ann.password, t)).kind, "ok");
    const epoch = identity.securityContextOf(ann.read, t)?.recoverySelector;
    const next = keplrAccount("escrow3a/ann-next");
    // REPLACE: the laptop confirmed with the password; the current wallet approves, the new one accepts.
    assert.deepEqual(await replaceWith(identity, ann.read, { current: ann.wallet, next }, t + 1), { kind: "ok", authorizationWallet: { address: next.address, since: t + 1 } });
    assert.equal(identity.authenticate(phone, t + 2).kind, "ok", "no session ends");
    assert.equal(identity.hasSensitiveAuth(ann.read, t + 2), true, "no grant ends");
    assert.equal(identity.securityContextOf(ann.read, t + 2)?.recoverySelector, epoch, "the credential epoch is unchanged");
    // The replaced wallet recovers nothing (one `invalid`, as for any wallet that is not the account's).
    const stale = await recovered(identity, ann, "a brand new password", t + 3, ann.wallet);
    assert.deepEqual(stale.outcome, { kind: "invalid" });
    assert.equal(identity.authenticate(ann.read, t + 3).kind, "ok", "a refused recovery changes nothing");
    // RECOVER by the designated wallet: every family of the account ends, every grant with it.
    const recovery = await recovered(identity, { ...ann, wallet: next }, "a brand new password", t + 4);
    assert.equal(recovery.outcome.kind, "ok");
    assert.equal((recovery.outcome as { signedOut: number }).signedOut, 2);
    for (const read of [ann.read, phone]) {
      assert.equal(identity.authenticate(read, t + 5).kind, "refused");
      assert.equal(identity.hasSensitiveAuth(read, t + 5), false);
      assert.equal(identity.peekFamily(familyOf(identity, read))?.revoke_reason, "signed-out-remotely");
    }
    assert.equal(identity.hasSensitiveAuth(recovery.read, t + 5), true, "the recovering browser is signed in (a sign-in's grant) ...");
    assert.deepEqual(replacementOf(identity, recovery.read, t + 5), { kind: "reauth-required" }, "... which never replaces the wallet");
    assert.equal(identity.securityContextOf(recovery.read, t + 5)?.recoverySelector, epoch, "a recovery does not move the credential epoch either");
    assert.equal(identity.authorizationWallet(identity.securityContextOf(recovery.read, t + 5)!.principalId)?.address, next.address, "the Authorization Wallet is kept");
  });

  test("concurrent sign-ins (§15) both land on the SAME principal, each in its own family; concurrent recoveries race on the password generation -- exactly one wins", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const temps = await Promise.all([1, 2].map((n) => freshBrowser(identity, T0 + n)));
    const outcomes = await Promise.all(temps.map((temp) => identity.login(temp, { username: ann.username, password: ann.password }, T0 + 5)));
    assert.deepEqual(outcomes.map((o) => o.kind), ["ok", "ok"]);
    const reads = outcomes.map((o) => readOf((o as { setCookie: string }).setCookie));
    const principal = identity.securityContextOf(ann.read, T0 + 6)!.principalId;
    assert.deepEqual(reads.map((read) => identity.securityContextOf(read, T0 + 6)?.principalId), [principal, principal], "a sign-in is the same principal");
    const families = reads.map((read) => familyOf(identity, read));
    assert.notEqual(families[0], families[1]);
    assert.ok(!families.includes(familyOf(identity, ann.read)));
    assert.equal(identity.authenticate(ann.read, T0 + 6).kind, "ok", "the creator's browser is untouched");
    /* Two browsers recovering with the same Authorization Wallet at once: each proof is valid, but each was decided
       against the same password generation -- the first to commit replaces it, the other is refused (one `invalid`). */
    const recoverers = await Promise.all([1, 2].map((n) => freshBrowser(identity, T0 + 6 + n)));
    const minted = recoverers.map((temp) => identity.mintAuthorization(temp, { purpose: "recover", username: ann.username, wallet: ann.wallet.address, site: TEST_SITE }, T0 + 9));
    const raced = await Promise.all(
      minted.map((op, at) => {
        assert.equal(op.kind, "ok");
        const ok = op as { operation: string; texts: readonly { text: string }[] };
        return identity.recoverAccount(recoverers[at], { operation: ok.operation, ...ann.wallet.sign(ok.texts[0].text), newPassword: `recovered password ${at}` }, T0 + 10);
      }),
    );
    assert.deepEqual(raced.map((o) => o.kind).sort(), ["invalid", "ok"]);
    const winner = readOf((raced.find((o) => o.kind === "ok") as { setCookie: string }).setCookie);
    assert.equal(identity.securityContextOf(winner, T0 + 11)?.principalId, principal);
    for (const read of [ann.read, ...reads]) assert.equal(identity.authenticate(read, T0 + 11).kind, "refused", "every earlier device is signed out");
  });

  /* "sign-out-other-devices has NO creation rescue": the rescue is retired with the recovery key (section E). */
});

/* ================================================================================================= */
/* E. The lost create response (owner review) -- PHASE 3 FINAL: nothing to rescue                    */
/* ================================================================================================= */

describe("ESCROW-3A E: a lost create response needs no rescue", () => {
  /* The six rescue tests (receipt, acknowledgement, one-time replacement of an unseen recovery key, ten minutes, a
     restart) are retired with the recovery key: an account holds nothing the player has not typed or signed. */
  test("the page never saw the create answer: its temporary cookie has ended, and the username and password sign the same principal in -- before and after a restart; nothing typed reaches the disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3a-lost-create-"));
    try {
      const first = await openService(createJournalIdentityStore(dir, quiet));
      const ann = await creator(first.identity, T0); // the 201 carrying ann.read is "lost": the page holds only its temporary cookie
      const principal = first.identity.securityContextOf(ann.read, T0)!.principalId;
      assert.deepEqual(first.identity.classify(ann.temporary, false, T0 + 1), { kind: "ended", reason: "replaced" }, "the temporary cookie never signs in as the account");
      assert.equal(first.identity.authenticate(ann.temporary, T0 + 1).kind, "refused");
      const again = await loggedIn(first.identity, ann, T0 + 2);
      assert.equal(first.identity.securityContextOf(again, T0 + 2)?.principalId, principal, "the same principal");
      assert.deepEqual(replacementOf(first.identity, again, T0 + 3), { kind: "reauth-required" }, "and no time-window exemption for the highest-authority action");
      const second = await openService(createJournalIdentityStore(dir, quiet));
      assert.equal(second.identity.authenticate(ann.read, T0 + 4).kind, "ok", "the (lost) session itself survives the restart");
      assert.equal(second.identity.hasSensitiveAuth(ann.read, T0 + 4), false, "a sign-in's grant is memory only");
      const afterRestart = await loggedIn(second.identity, ann, T0 + 5);
      assert.equal(second.identity.securityContextOf(afterRestart, T0 + 5)?.principalId, principal);
      for (const name of fs.readdirSync(dir)) {
        const text = fs.readFileSync(path.join(dir, name), "utf8");
        assert.ok(!text.includes(ann.password), `${name}: no password`);
        for (const read of [ann.read, ann.temporary, again, afterRestart]) assert.ok(read.kind === "session" && !text.includes(read.secret), `${name}: no session secret`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================================================= */
/* C. What a financial credential is issued under, and what ends it                                 */
/* ================================================================================================= */

describe("ESCROW-3A C: financial-credential standing follows every security event", () => {
  test("logout, sign-out-others, a password change (elsewhere), a recovery and a disabled principal each end a credential issued under the old context; the changer's own family and a wallet replacement do not", async () => {
    const { identity } = await openService();
    const ann = await creator(identity, T0);
    const phone = await loggedIn(identity, ann, T0 + 1000);
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
    const tablet = await loggedIn(identity, ann, t + 2);
    const onTablet = identity.securityContextOf(tablet, t + 2)!;
    await reauth(identity, tablet, ann.password, t + 3);
    assert.equal((await identity.signOutOthers(tablet, t + 3)).kind, "ok");
    assert.deepEqual(identity.securityStanding(onLaptop), { kind: "ended", why: "family" });
    // A password change on the tablet: every OTHER device's credentials end; the tablet goes on in its own family.
    const desk = await loggedIn(identity, ann, t + 4);
    const onDesk = identity.securityContextOf(desk, t + 4)!;
    const changed = await identity.changePassword(tablet, { currentPassword: ann.password, newPassword: "Ann's second password" }, t + 5);
    assert.equal(changed.kind, "ok");
    const tabletNext = readOf((changed as { setCookie: string }).setCookie);
    assert.deepEqual(identity.securityStanding(onDesk), { kind: "ended", why: "family" });
    assert.deepEqual(identity.securityStanding(onTablet), { kind: "standing" }, "the changer's seat links made here keep standing");
    // Replacing the Authorization Wallet touches nothing a game's credential is bound to.
    await reauth(identity, tabletNext, "Ann's second password", t + 6);
    const next = keplrAccount("escrow3a/ann-next");
    assert.equal((await replaceWith(identity, tabletNext, { current: ann.wallet, next }, t + 6)).kind, "ok");
    assert.deepEqual(identity.securityStanding(onTablet), { kind: "standing" });
    // "Forgot password?" by the Authorization Wallet ends EVERY family: the tablet's credentials too.
    const recovery = await recovered(identity, { ...ann, wallet: next }, "Ann's third password", t + 7);
    assert.equal(recovery.outcome.kind, "ok");
    assert.deepEqual(identity.securityStanding(onTablet), { kind: "ended", why: "family" });
    const fresh = identity.securityContextOf(recovery.read, t + 8)!;
    assert.deepEqual(identity.securityStanding(fresh), { kind: "standing" });
    assert.equal(fresh.recoverySelector, onTablet.recoverySelector, "no account operation moves the credential epoch");
    // A credential issued under ANOTHER epoch (e.g. read back from before an identity restore) never stands.
    const otherEpoch = mintRecoveryKey().selector;
    assert.notEqual(otherEpoch, fresh.recoverySelector);
    assert.deepEqual(identity.securityStanding({ ...fresh, recoverySelector: otherEpoch }), { kind: "ended", why: "recovery-key" });
    await identity.disablePrincipal(fresh.principalId, t + 9);
    assert.deepEqual(identity.securityStanding(fresh), { kind: "ended", why: "principal" });
  });
});

/* ================================================================================================= */
/* D. The HTTP surface                                                                               */
/* ================================================================================================= */

describe("ESCROW-3A D: POST /gs/api/profile/reauth", () => {
  async function server() {
    const clock = { now: T0 };
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const started = await startServer({ identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service } });
    return { ...started, clock };
  }

  test("200 {expiresAt} for the right password; one 403 for every wrong one; 403 profile-required unprofiled; 401 without a session; and a sensitive action says reauth-required", async () => {
    const { server: running, port, clock } = await server();
    try {
      const ann = await profiledBrowser(port, "Ann");
      const bea = await accountBrowser(port, "bea-escrow3a", "Bea's own password");
      const signedIn = await loginOnFreshBrowser(port, ann.username, ann.password);
      assert.equal(signedIn.answer.status, 200);
      const phone = signedIn.cookie as string;
      clock.now += 5 * MIN; // the sign-in's own grant lapses
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/sign-out-others", { cookie: phone, body: {} })).body, { error: "reauth-required" });
      const wrong = await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { password: "not the password at all" } });
      const othersPassword = await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { password: bea.password } });
      assert.deepEqual([wrong.status, wrong.body], [403, { error: "invalid-credential" }]);
      assert.deepEqual([othersPassword.status, othersPassword.body], [wrong.status, wrong.body]);
      const ok = await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { password: ann.password } });
      assert.equal(ok.status, 200);
      assert.equal((ok.body as { expiresAt: unknown }).expiresAt, clock.now + 5 * MIN);
      assert.deepEqual(Object.keys(ok.body as object).sort(), ["expiresAt", "ok"], "no id, no password, nothing else");
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/sign-out-others", { cookie: phone, body: {} })).body, { ok: true, signedOut: 1 });
      const unprofiled = await bootstrapCookie(port);
      assert.deepEqual((await apiRequest(port, "/gs/api/profile/reauth", { cookie: unprofiled, body: { password: ann.password } })).body, { error: "profile-required" });
      assert.equal((await apiRequest(port, "/gs/api/profile/reauth", { body: { password: ann.password } })).status, 401);
      assert.equal((await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { password: ann.password, extra: 1 } })).status, 400, "a closed body");
      assert.equal((await apiRequest(port, "/gs/api/profile/reauth", { cookie: phone, body: { recoveryKey: `${mintRecoveryKey().key}` } })).status, 400, "the recovery key is not a field any more");
    } finally {
      await stopServer(running);
    }
  });

  test("the rescue over the wire is retired: the create, rotate and key-received routes answer 410 `retired` and read nothing; sign-out-others takes no receipt", async () => {
    const { server: running, port } = await server();
    try {
      const receipt = randomBytes(32).toString("hex");
      const browser = await bootstrapCookie(port);
      const answers = [];
      for (const pathname of ["/gs/api/profile", "/gs/api/profile/recovery-key", "/gs/api/profile/key-received"]) {
        const answer = await apiRequest(port, pathname, { cookie: browser, body: { name: "Ann", creationReceipt: receipt } });
        assert.deepEqual([answer.status, answer.body], [410, { error: "retired" }], pathname);
        answers.push(answer.text);
      }
      const ann = await profiledBrowser(port, "Ann");
      const others = await apiRequest(port, "/gs/api/profile/sign-out-others", { cookie: ann.cookie, body: { creationReceipt: receipt } });
      assert.equal(others.status, 400, "sign-out-others takes no receipt at all");
      answers.push(others.text);
      assert.ok(!answers.join("\n").includes(receipt), "no receipt, and nothing about one, appears in a response");
    } finally {
      await stopServer(running);
    }
  });
});
