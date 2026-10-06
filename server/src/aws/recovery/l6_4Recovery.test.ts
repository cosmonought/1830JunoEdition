// server/src/aws/recovery/l6_4Recovery.test.ts
//
// ==================================================================
//  LIVE-6 L6-4: THE IDENTITY RESTORE'S JOURNAL REPLAY (pure) -- AND THE STRICT CODECS OF THE GENERATION ITEMS
// ==================================================================
//
// A real journal, written by the real identity service (journal first, confirmations after) over the memory store; the
// store's content at a restore point T taken as "the restored table"; the whole journal replayed into it
// (`planSecurityReplay`, applied through the memory store, which checks every precondition as the table does); then a
// fresh identity service over the result, and what it accepts:
//
//   R1 every session and family signed out; the journal's terminal actions re-applied (sign-out-others, logout,
//      disable, "Forgot password?"); a profile created after T exists (confirmed, and unconfirmed-last); PHASE 3 FINAL --
//      every account's PASSWORD chain (change password, "Forgot password?" by the Authorization Wallet) and AUTHORIZATION
//      WALLET chain (replacements) is followed: the confirmed step, else the last one, confirmed or not (no review); a
//      retired password or Authorization Wallet never works again. LEGACY recovery-key profiles (schema 1, made by an
//      earlier build: this build makes none, and serves none) still have their journaled key rotations replayed: the
//      confirmed chain's head is the key; an UNCONFIRMED rotation -- committed with its confirmation lost, before or
//      after T, or a phantom -- retires its old key, never installs its new one, and sends the profile to review
//      (disabled; the head kept only when not implicated, else a quarantine key nobody holds).
//   R2 idempotent (a second plan changes nothing), resumable (interrupted after ANY prefix of the changes, the replay
//      converges to the same table), deterministic and independent of the journal's order and of duplicated reads.
//   R3 strict: a malformed or contradictory journal refuses the whole replay (fail closed).
//   R4 no secret, selector, key or password digest, or password in what an operator is shown.
//   G  the APPGEN, adoption-history and SYSTEM/GENERATION codecs: strict, newer refused, damage refused.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import { sealedRecoveryDigest } from "../../identity/accountCredentials";
import { readSessionCookie, type SessionCookieRead } from "../../identity/cookies";
import { createMemoryGrantStore } from "../../identity/grants";
import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoveryKey, mintSecret, mintSessionId, secretHash } from "../../identity/ids";
import { createMemorySecurityJournal, parseSecurityEventBody, SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent } from "../../identity/securityEvents";
import { canonicalJournal, planSecurityReplay, quarantineKeyOf, SecurityReplayError, type ReplayPlan } from "../../identity/securityReplay";
import { IdentityService, type SecurityEventDraft } from "../../identity/sessions";
import { createMemoryIdentityStore, type FullIdentitySnapshot, type IdentityChange, type IdentityCommitOptions, type IdentityStore, type Principal, type Profile, type Session, type SessionFamily } from "../../identity/store";
import { StoreDefiniteError } from "../../persistence/storeResult";
import { createAccountWith, keplrAccount, recoverWith, replaceWith, type KeplrAccount } from "../../testSupport/authorizationWallets";
import { bootstrapGenerationMarker, generationMarkerItem, generationMarkerProblem, GenerationMarkerUnreadableError, parseGenerationMarker, preparationProblem } from "../game/generationMarker";
import { adoptionRequestProblem, AppGenerationUnreadableError, appgenHistoryKey, parseAdoptionRecord, parseAppGeneration } from "../ledger/appGeneration";
import { assertPrintable } from "./recoveryOps";
import { parseFlags, UsageError } from "./recoveryCli";

const T0 = 1_780_000_000_000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const RESTORE = "drill-1";
/** Cheap scrypt parameters for the test world (a stored hash carries its own). */
const POLICY = { passwordKdf: { logN: 10, r: 1, p: 1 } };

const readOf = (setCookie: string | null | undefined): SessionCookieRead => {
  assert.ok(setCookie, "a Set-Cookie");
  return readSessionCookie(setCookie.split(";")[0]);
};
const sessionIdOf = (read: SessionCookieRead): string => (read.kind === "session" ? read.sessionId : "");
/** A legacy recovery key's digest (hex SHA-256), as an earlier build stored it. */
const keyDigest = (key: string): string => createHash("sha256").update(key).digest("hex");

/** The memory store behind the service, with one quirk: "phantom" -- the store's checks pass and the service's step (its
 *  security event) runs, then the write is refused (a condition only the table checks): the event has no change. */
function quirky(store: ReturnType<typeof createMemoryIdentityStore>) {
  const quirks: Array<"phantom"> = [];
  const wrapped: IdentityStore = {
    load: () => store.load(),
    async commit(change: IdentityChange, options?: IdentityCommitOptions) {
      if (quirks.shift() === "phantom") {
        await options?.beforeWrite?.();
        throw new StoreDefiniteError("refused by a condition of the write (test); nothing was written");
      }
      await store.commit(change, options);
    },
  };
  return { quirks, wrapped };
}

/** PHASE 3 FINAL: an account of this build -- a username, a password, ONE Authorization Wallet. */
interface Account {
  /** Its first browser's CURRENT session (a password change hands the browser a fresh one). */
  read: SessionCookieRead;
  principalId: string;
  username: string;
  /** Every password it had, oldest first: the last is the one the account holds. */
  passwords: string[];
  /** Every Authorization Wallet it had, oldest first: the last is the one the account holds. */
  wallets: KeplrAccount[];
}

/** A LEGACY player: a schema-1 recovery-key profile as an EARLIER build made it -- its records in the table and its
 *  events in the journal, written here exactly as that build wrote them. This build makes none (no recovery key exists)
 *  and serves none (a legacy profile is retired), but an identity restore still replays what that build journaled. */
interface LegacyPlayer {
  read: SessionCookieRead;
  principalId: string;
  profileId: string;
  /** Its recovery-key SELECTORS, oldest first (`keys[0]` the creation's). */
  keys: string[];
}

/** The world: a journaled identity service over the memory store; actions before and after a restore point T. */
async function scenario() {
  const store = createMemoryIdentityStore();
  const journal = createMemorySecurityJournal();
  const { quirks, wrapped } = quirky(store);
  let clock = T0;
  const identity = await IdentityService.open(wrapped, { policy: POLICY, security: { journal, grants: createMemoryGrantStore(), clock: () => clock } });
  const now = () => clock;
  const tick = () => (clock += MIN);
  const fresh = async (): Promise<SessionCookieRead> => readOf(((await identity.bootstrap({ kind: "none" }, false, now())) as { setCookie: string | null }).setCookie);

  /* ---------------- this build's accounts ---------------- */
  const create = async (name: string): Promise<Account> => {
    tick();
    const username = name.toLowerCase();
    const password = `${username} password 0`;
    const wallet = keplrAccount(`l6-4/${username}/0`);
    const created = await createAccountWith(identity, await fresh(), { username, password, displayName: name, wallet }, now());
    assert.equal(created.kind, "ok", name);
    await identity.settled();
    const read = readOf((created as { setCookie: string }).setCookie);
    return { read, principalId: (identity.peekSession(sessionIdOf(read)) as Session).principal_id, username, passwords: [password], wallets: [wallet] };
  };
  const signIn = async (who: Account): Promise<SessionCookieRead> => {
    tick();
    const outcome = await identity.login(await fresh(), { username: who.username, password: who.passwords[who.passwords.length - 1] }, now());
    assert.equal(outcome.kind, "ok");
    return readOf((outcome as { setCookie: string }).setCookie);
  };
  /** "Change password" on the account's first browser (which goes on with a fresh cookie). */
  const change = async (who: Account): Promise<string> => {
    tick();
    const next = `${who.username} password ${who.passwords.length}`;
    const changed = await identity.changePassword(who.read, { currentPassword: who.passwords[who.passwords.length - 1], newPassword: next }, now());
    await identity.settled();
    who.passwords.push(next);
    if (changed.kind === "ok") who.read = readOf(changed.setCookie);
    return changed.kind;
  };
  /** "Forgot password?" on a new browser, signed by the account's Authorization Wallet. */
  const forgot = async (who: Account): Promise<SessionCookieRead> => {
    tick();
    const next = `${who.username} password ${who.passwords.length}`;
    const recovered = await recoverWith(identity, await fresh(), { username: who.username, wallet: who.wallets[who.wallets.length - 1], newPassword: next }, now());
    assert.equal(recovered.kind, "ok");
    await identity.settled();
    who.passwords.push(next);
    return readOf((recovered as { setCookie: string }).setCookie);
  };
  /** "Change Authorization Wallet" (after "Confirm it's you"): the current wallet approves, the next one accepts. */
  const replace = async (who: Account): Promise<string> => {
    tick();
    assert.equal((await identity.reauthenticateWithPassword(who.read, who.passwords[who.passwords.length - 1], now())).kind, "ok");
    const next = keplrAccount(`l6-4/${who.username}/${who.wallets.length}`);
    const replaced = await replaceWith(identity, who.read, { current: who.wallets[who.wallets.length - 1], next }, now());
    await identity.settled();
    who.wallets.push(next);
    return replaced.kind;
  };

  /* ---------------- an earlier build's legacy profiles (records and journal as it wrote them) ---------------- */
  let legacyEvents = 0;
  const appendLegacy = async (draft: SecurityEventDraft, confirmed: boolean): Promise<string> => {
    const event = { format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: `ee${(legacyEvents += 1).toString(16).padStart(6, "0")}${"0".repeat(24)}`, ...draft } as SecurityEvent;
    await journal.append(event);
    if (confirmed) {
      const confirmation = { format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: `ee${(legacyEvents += 1).toString(16).padStart(6, "0")}${"0".repeat(24)}`, kind: "confirmed", at: event.at, principal_id: event.principal_id, confirms: event.event_id, confirmed_kind: event.kind };
      await journal.append(confirmation as SecurityEvent);
    }
    return event.event_id;
  };
  const legacy = async (name: string): Promise<LegacyPlayer> => {
    tick();
    const at = now();
    const [principalId, profileId, sessionId, secret, key] = [mintPrincipalId(), mintProfileId(), mintSessionId(), mintSecret(), mintRecoveryKey()];
    const familyId = familyIdOf(sessionId);
    const principal: Principal = { principal_id: principalId, kind: "profile", status: "active", created_at: at, activated_at: at, last_seen_at: at, account_link: profileId };
    const profile: Profile = { profile_id: profileId, principal_id: principalId, display_name: name, created_at: at, status: "active", recovery_selector: key.selector, recovery_hash: keyDigest(key.key), recovery_rotated_at: at, schema: 1 };
    const session: Session = { session_id: sessionId, principal_id: principalId, secret_hash: secretHash(secret), created_at: at, last_seen_at: at, expires_at: at + 30 * DAY, revoked_at: null, revoke_reason: null, rotated_to: null, family_id: familyId };
    const family: SessionFamily = { family_id: familyId, principal_id: principalId, created_at: at, origin: "bootstrap", revoked_at: null, revoke_reason: null };
    await store.commit({
      expect: [
        { kind: "principal-absent", principal_id: principalId },
        { kind: "profile-absent", profile_id: profileId },
        { kind: "selector-unused", recovery_selector: key.selector },
        { kind: "session-absent", session_id: sessionId },
        { kind: "family-absent", family_id: familyId },
      ],
      principals: [principal],
      profiles: [profile],
      sessions: [session],
      families: [family],
    });
    await appendLegacy({ kind: "profile-created", at, principal_id: principalId, principal, profile }, true);
    return { read: { kind: "session", sessionId, secret }, principalId, profileId, keys: [key.selector] };
  };
  /** A legacy key rotation as that build made it: its event first; then (`committed`) the table's change; then
   *  (`confirmed`) its confirmation. Not committed: a phantom (its new key never reached the player). */
  const rotate = async (who: LegacyPlayer, how: { committed: boolean; confirmed: boolean } = { committed: true, confirmed: true }): Promise<string> => {
    tick();
    const at = now();
    const next = mintRecoveryKey();
    const event = await appendLegacy(
      { kind: "recovery-key-rotated", at, principal_id: who.principalId, profile_id: who.profileId, from_selector: who.keys[who.keys.length - 1], to_selector: next.selector, recovery_hash: keyDigest(next.key), rotated_at: at },
      how.confirmed,
    );
    if (how.committed) {
      const current = store.snapshot().profiles.find((profile) => profile.profile_id === who.profileId) as Profile;
      await store.commit({ expect: [{ kind: "selector-unused", recovery_selector: next.selector }], profiles: [{ ...current, recovery_selector: next.selector, recovery_hash: keyDigest(next.key), recovery_rotated_at: at }] });
      who.keys.push(next.selector);
    }
    return event;
  };

  /* ---------------- before T ---------------- */
  const ann = await create("Ann");
  const annPhone = await signIn(ann);
  const carol = await create("Carol");
  const pat = await create("Pat");
  assert.equal(await change(pat), "ok"); // P0 -> P1, confirmed, before T: already in the table
  const quinn = await create("Quinn");
  assert.equal(await change(quinn), "ok"); // P0 -> P1, committed before T; its confirmation is lost below
  const ray = await create("Ray");
  const sam = await create("Sam");
  const tess = await create("Tess");
  const uma = await create("Uma");
  assert.equal(await replace(uma), "ok"); // W0 -> W1, confirmed, before T: already in the table
  const vic = await create("Vic");
  const wes = await create("Wes");
  const dave = await legacy("Dave");
  const eve = await legacy("Eve");
  const frank = await legacy("Frank");
  await rotate(frank); // K1 -> K2, confirmed, before T: already in the table
  const gina = await legacy("Gina");
  await rotate(gina, { committed: true, confirmed: false }); // G1 -> G2, committed before T; its confirmation is lost
  const kim = await legacy("Kim");
  const T = store.snapshot();
  const readsAtT = [ann.read, annPhone, carol.read, pat.read, quinn.read, ray.read, sam.read, tess.read, uma.read, vic.read, wes.read, dave.read, eve.read, frank.read, gina.read, kim.read];

  /* ---------------- after T ---------------- */
  tick();
  assert.equal((await identity.reauthenticateWithPassword(ann.read, ann.passwords[0], now())).kind, "ok");
  assert.equal((await identity.signOutOthers(ann.read, now())).kind, "ok"); // the phone's family
  assert.equal(await change(ann), "ok"); // P0 -> P1
  assert.equal(await change(ann), "ok"); // P1 -> P2
  tick();
  assert.equal(await identity.revoke(sessionIdOf(ann.read), "logout", now()), true);
  const bob = await create("Bob"); // an account created after T, confirmed
  tick();
  assert.equal(await identity.disablePrincipal(carol.principalId, now()), true);
  assert.equal(await change(pat), "ok"); // P1 -> P2, confirmed, after T
  assert.equal(await change(ray), "ok"); // P0 -> P1 committed; its confirmation is lost below
  quirks.push("phantom");
  assert.equal(await change(sam), "unavailable"); // P0 -> P1: the event is written, the change refused
  assert.equal(await change(tess), "ok"); // P0 -> P1, confirmed
  assert.equal(await change(tess), "ok"); // P1 -> P2, committed; its confirmation is lost below (a gap in the MIDDLE)
  assert.equal(await change(tess), "ok"); // P2 -> P3, confirmed
  assert.equal(await replace(uma), "ok"); // W1 -> W2 committed; its confirmation is lost below
  const vicRescue = await forgot(vic); // "Forgot password?" by the Authorization Wallet: P0 -> P1, every family closed
  tick();
  assert.equal((await identity.reauthenticateWithPassword(wes.read, wes.passwords[0], now())).kind, "ok");
  quirks.push("phantom");
  const wesPhantom = await replaceWith(identity, wes.read, { current: wes.wallets[0], next: keplrAccount("l6-4/wes/1") }, now()); // W0 -> X: the event is written, the change refused
  assert.equal(wesPhantom.kind, "unavailable");
  wes.wallets.push(keplrAccount("l6-4/wes/1"));
  await identity.settled();
  await rotate(dave, { committed: true, confirmed: false }); // D1 -> D2 committed; its confirmation is lost
  await rotate(eve, { committed: false, confirmed: false }); // E1 -> X: a phantom (the event, no change)
  await rotate(frank); // K2 -> K3, confirmed, after T
  const hal = await create("Hal"); // created after T; its confirmation is lost below
  await rotate(kim); // K0 -> K1, confirmed
  await rotate(kim, { committed: true, confirmed: false }); // K1 -> K2, committed; its confirmation is lost (a gap in the MIDDLE of a chain)
  await rotate(kim); // K2 -> K3, confirmed
  tick();
  quirks.push("phantom");
  const ivy = { username: "ivy", password: "ivy password 0" };
  assert.equal((await createAccountWith(identity, await fresh(), { username: ivy.username, password: ivy.password, displayName: "Ivy", wallet: keplrAccount("l6-4/ivy/0") }, now())).kind, "unavailable"); // a phantom creation
  await identity.settled();

  /* Lose confirmations of changes that DID commit: Quinn's, Ray's and Tess's middle password change, Uma's second
     wallet replacement, Hal's creation. */
  const all = () => [...journal.bodies.values()].map((body) => parseSecurityEventBody(body) as SecurityEvent);
  const loseConfirmationOf = (eventId: string) => {
    for (const [key, body] of journal.bodies) {
      const event = parseSecurityEventBody(body) as SecurityEvent;
      if (event.kind === "confirmed" && event.confirms === eventId) journal.bodies.delete(key);
    }
    return eventId;
  };
  const ofKind = (principalId: string, kind: SecurityEvent["kind"]) => all().filter((event) => event.principal_id === principalId && event.kind === kind).sort((a, b) => a.at - b.at || (a.event_id < b.event_id ? -1 : 1));
  const lost = {
    quinn: loseConfirmationOf((ofKind(quinn.principalId, "password-replaced").pop() as SecurityEvent).event_id),
    ray: loseConfirmationOf((ofKind(ray.principalId, "password-replaced").pop() as SecurityEvent).event_id),
    tess: loseConfirmationOf(ofKind(tess.principalId, "password-replaced")[1].event_id),
    uma: loseConfirmationOf((ofKind(uma.principalId, "authorization-wallet-replaced").pop() as SecurityEvent).event_id),
    hal: loseConfirmationOf((ofKind(hal.principalId, "profile-created").pop() as SecurityEvent).event_id),
    dave: (ofKind(dave.principalId, "recovery-key-rotated").pop() as SecurityEvent).event_id,
    gina: (ofKind(gina.principalId, "recovery-key-rotated").pop() as SecurityEvent).event_id,
    kim: ofKind(kim.principalId, "recovery-key-rotated")[1].event_id,
  };
  const events = all();
  const ivyPrincipal = events.find((event) => event.kind === "profile-created" && event.profile.display_name === "Ivy")?.principal_id as string;
  const evePhantom = ofKind(eve.principalId, "recovery-key-rotated")[0] as Extract<SecurityEvent, { kind: "recovery-key-rotated" }>;
  return {
    T,
    events,
    readsAtT,
    accounts: { ann, carol, pat, quinn, ray, sam, tess, uma, vic, wes, bob, hal },
    legacy: { dave, eve, frank, gina, kim },
    annPhone,
    vicRescue,
    ivy,
    ivyPrincipal,
    lost,
    evePhantom: evePhantom.event_id,
    evePhantomKey: evePhantom.to_selector,
    now,
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** Apply a plan's changes through the memory store (every precondition checked as the table checks it). */
async function applyPlan(start: FullIdentitySnapshot, plan: ReplayPlan, limit = Infinity): Promise<FullIdentitySnapshot> {
  const store = createMemoryIdentityStore(start);
  let applied = 0;
  for (const entry of plan.principals) {
    if (applied >= limit) break;
    if (entry.change !== null) await store.commit(entry.change);
    applied += 1;
  }
  return store.snapshot();
}

const AT = T0 + 24 * 60 * MIN;
/** The review records a replay has written for the first `prefix` entries of `plan` (it writes each before its change). */
const recordsOf = (plan: ReplayPlan, prefix = Infinity) =>
  plan.principals.slice(0, prefix).flatMap((entry) => (entry.review === null ? [] : [{ profile_id: entry.review.profile_id, restore_id: RESTORE, resolved_at: null, prior_status: entry.review.prior_status }]));
const replay = (s: Scenario, snapshot: FullIdentitySnapshot = s.T, events: readonly SecurityEvent[] = s.events, reviews: ReturnType<typeof recordsOf> = []) => planSecurityReplay({ snapshot, events, restoreId: RESTORE, at: AT, reviews });

/** A sign-in on a new browser of the fresh service: what a password opens after the restore. */
async function loginWith(identity: IdentityService, username: string, password: string, now: number): Promise<string> {
  const boot = await identity.bootstrap({ kind: "none" }, false, now);
  return (await identity.login(readOf((boot as { setCookie: string | null }).setCookie), { username, password }, now)).kind;
}

describe("L6-4 R1: the replay's rules, end to end through a fresh identity service", () => {
  test("every session signed out; terminal actions re-applied; accounts created after T exist; password and Authorization Wallet chains followed; legacy unconfirmed rotations go to review; nothing retired works", async () => {
    const s = await scenario();
    const plan = replay(s);
    const table = await applyPlan(s.T, plan);
    const { ann, carol, pat, quinn, ray, sam, tess, uma, vic, wes, bob, hal } = s.accounts;
    const { dave, eve, frank, gina, kim } = s.legacy;

    /* Every session and family of the restored table is ended. */
    for (const session of table.sessions) assert.notEqual(session.revoked_at, null, "every session signed out");
    for (const family of table.families) assert.notEqual(family.revoked_at, null, "every family closed");
    const reason = (read: SessionCookieRead) => table.families.find((family) => family.family_id === table.sessions.find((session) => session.session_id === sessionIdOf(read))?.family_id)?.revoke_reason;
    assert.equal(reason(s.annPhone), "signed-out-remotely", "Ann's sign-out-others re-applied");
    assert.equal(reason(s.readsAtT[0]), "logout", "Ann's logout re-applied (the family her password changes kept)");
    assert.equal(reason(s.readsAtT[9]), "signed-out-remotely", "Vic's \"Forgot password?\" closed every family the table held");
    assert.equal(table.principals.find((principal) => principal.principal_id === carol.principalId)?.status, "disabled", "Carol's disable re-applied");
    assert.equal(reason(carol.read), "principal-disabled");

    const identity = await IdentityService.open(createMemoryIdentityStore(table), { policy: POLICY });
    const later = AT + MIN;
    for (const read of [...s.readsAtT, s.vicRescue]) assert.notEqual(identity.authenticate(read, later).kind, "ok", "no session of the restored table authenticates");

    /* Passwords: each account's chain is followed to its head; every retired password is dead. */
    const head = async (who: { username: string; passwords: string[] }, at: number, label: string) => {
      assert.equal(await loginWith(identity, who.username, who.passwords[at], later), "ok", `${label}: password #${at} opens the account`);
      for (const [index, password] of who.passwords.entries()) if (index !== at) assert.equal(await loginWith(identity, who.username, password, later), "invalid", `${label}: password #${index} is retired`);
    };
    await head(ann, 2, "Ann (two confirmed changes after T)");
    await head(pat, 2, "Pat (one change before T, one after)");
    await head(quinn, 1, "Quinn (a change before T whose confirmation was lost: the table's is kept, no review)");
    await head(ray, 1, "Ray (a change after T whose confirmation was lost: its LAST step is followed, no review)");
    await head(sam, 1, "Sam (a PHANTOM change: its last step is followed -- the new password is one its own player chose; \"Forgot password?\" is the remedy)");
    await head(tess, 3, "Tess (a lost confirmation in the MIDDLE of a chain: followed through, no review)");
    await head(vic, 1, "Vic (\"Forgot password?\" by the Authorization Wallet after T)");
    await head(bob, 0, "Bob (created after T, confirmed)");
    await head(hal, 0, "Hal (created after T, its confirmation lost: the last creation is made)");
    assert.equal(await loginWith(identity, s.ivy.username, s.ivy.password, later), "ok", "Ivy's phantom creation (the only one) is made: a player's only way back");
    assert.equal(await loginWith(identity, carol.username, carol.passwords[0], later), "invalid", "Carol is disabled");
    assert.ok(table.profiles.some((profile) => profile.principal_id === s.ivyPrincipal));

    /* Authorization Wallets: each account's chain is followed to its head; a retired one never recovers the account. */
    assert.equal(identity.authorizationWallet(uma.principalId)?.address, uma.wallets[2].address, "Uma: W0 -> W1 (before T) -> W2 (its confirmation lost): followed");
    assert.equal(identity.authorizationWallet(wes.principalId)?.address, wes.wallets[1].address, "Wes: a PHANTOM replacement is followed (both wallets signed it)");
    assert.equal(identity.authorizationWallet(ann.principalId)?.address, ann.wallets[0].address, "Ann never replaced hers");
    for (const retired of uma.wallets.slice(0, 2)) {
      const boot = await identity.bootstrap({ kind: "none" }, false, later);
      assert.equal((await recoverWith(identity, readOf((boot as { setCookie: string | null }).setCookie), { username: uma.username, wallet: retired, newPassword: "a password nobody keeps" }, later)).kind, "invalid", "a retired Authorization Wallet recovers nothing");
    }
    const umaBoot = await identity.bootstrap({ kind: "none" }, false, later);
    assert.equal((await recoverWith(identity, readOf((umaBoot as { setCookie: string | null }).setCookie), { username: uma.username, wallet: uma.wallets[2], newPassword: "uma password after restore" }, later)).kind, "ok", "the head recovers it");
    assert.equal(plan.report.authorization_wallets_advanced, 2, "Uma's and Wes's");
    assert.equal(plan.report.passwords_advanced, 6, "Ann's, Pat's, Ray's, Sam's, Tess's and Vic's (Quinn's table already held its head)");

    /* Legacy keys (schema 1): the confirmed chain's head; unconfirmed outcomes never accepted -- the profile to review. */
    const legacyProfile = (who: { principalId: string }) => table.profiles.find((profile) => profile.principal_id === who.principalId) as Profile;
    assert.deepEqual([legacyProfile(frank).recovery_selector, legacyProfile(frank).status], [frank.keys[2], "active"], "Frank's K3 (the confirmed chain's head)");
    for (const who of [dave, eve, gina, kim]) assert.equal(legacyProfile(who).status, "disabled", "a legacy profile under review is disabled");
    for (const read of [dave.read, frank.read]) assert.notEqual(identity.authenticate(read, later).kind, "ok", "a legacy profile is retired in this build anyway");

    /* The reviews: exactly the four legacy profiles with an unconfirmed rotation, each disabled. No credential change of
       this build's accounts (password, Authorization Wallet) ever opens one. */
    const reviewed = plan.reviews.map((review) => review.principal_id).sort();
    assert.deepEqual(reviewed, [dave.principalId, eve.principalId, gina.principalId, kim.principalId].sort(), "Kim: a confirmation lost in the MIDDLE of a chain is a gap between two confirmed segments -- reviewed, never refused");
    for (const review of plan.reviews) {
      const profile = table.profiles.find((entry) => entry.profile_id === review.profile_id);
      assert.equal(profile?.status, "disabled");
      assert.equal(review.selector_state, "quarantined", "each head was implicated (a retired from, or an unknown-outcome to)");
      assert.equal(profile?.recovery_selector, quarantineKeyOf(RESTORE, review.profile_id).selector);
    }
    const byPrincipal = new Map(plan.reviews.map((review) => [review.principal_id, review] as const));
    assert.deepEqual(byPrincipal.get(dave.principalId)?.unconfirmed_events, [s.lost.dave]);
    assert.deepEqual(byPrincipal.get(gina.principalId)?.unconfirmed_events, [s.lost.gina]);
    const ginaTableKey = s.T.profiles.find((profile) => profile.principal_id === gina.principalId)?.recovery_selector;
    assert.equal(ginaTableKey, gina.keys[1], "the restored table held Gina's unconfirmed new key ...");
    assert.notEqual(legacyProfile(gina).recovery_selector, ginaTableKey, "... and it is taken out, not accepted");
    assert.deepEqual(byPrincipal.get(eve.principalId)?.unconfirmed_events, [s.evePhantom]);
    assert.deepEqual(byPrincipal.get(kim.principalId)?.unconfirmed_events, [s.lost.kim]);
    assert.equal(byPrincipal.get(kim.principalId)?.evidence.later_confirmed_from_unconfirmed, true, "K2 -> K3 is confirmed: the gap did commit (evidence for the operator)");
    /* Neither side of an unconfirmed rotation is any profile's key. */
    const live = new Set(table.profiles.map((profile) => profile.recovery_selector));
    for (const key of [...dave.keys, ...eve.keys, ...gina.keys, s.evePhantomKey]) assert.ok(!live.has(key));
    /* Every link code is dropped. */
    assert.deepEqual(table.links, []);
  });

  test("a legacy unconfirmed rotation whose old key is NOT the confirmed head keeps the head (disabled, under review; reversible by an operator)", async () => {
    const s = await scenario();
    const frank = s.legacy.frank;
    const events = s.events.filter((event) => event.principal_id === frank.principalId);
    const created = events.find((event) => event.kind === "profile-created") as Extract<SecurityEvent, { kind: "profile-created" }>;
    /* A phantom rotation from Frank's ORIGINAL key (K1, retired before T by a confirmed rotation): K1 is already dead,
       the confirmed head K3 is not implicated. */
    const stale: SecurityEvent = {
      format: "gs-security-event",
      version: 1,
      event_id: "ffffffff" + "0".repeat(24),
      at: AT - MIN,
      principal_id: frank.principalId,
      kind: "recovery-key-rotated",
      profile_id: created.profile.profile_id,
      from_selector: frank.keys[0],
      to_selector: quarantineKeyOf("other", "pf_x").selector,
      recovery_hash: "a".repeat(64),
      rotated_at: AT - MIN,
    };
    const plan = replay(s, s.T, [...s.events, stale]);
    const review = plan.reviews.find((entry) => entry.principal_id === frank.principalId);
    assert.equal(review?.selector_state, "confirmed-head-retained");
    const table = await applyPlan(s.T, plan);
    const profile = table.profiles.find((entry) => entry.principal_id === frank.principalId);
    assert.equal(profile?.recovery_selector, frank.keys[2], "K3 kept as the key");
    assert.equal(profile?.status, "disabled", "but the profile is under review");
  });
});

describe("L6-4 R1b: which creation makes a profile the restored table does not hold", () => {
  /** Another creation of `principalId`'s profile: a phantom, `delta` ms from the real one, with its own ids and (its
   *  credential epoch, with the sealed digest a schema-3 profile carries) its own epoch. */
  const phantomCreation = (real: Extract<SecurityEvent, { kind: "profile-created" }>, delta: number, id: string): Extract<SecurityEvent, { kind: "profile-created" }> => {
    const profileId = `pf_${id.repeat(25).slice(0, 25)}0`;
    const selector = quarantineKeyOf("phantom", profileId).selector;
    return {
      ...real,
      event_id: id.repeat(32).slice(0, 32),
      at: real.at + delta,
      principal: { ...real.principal, account_link: profileId },
      profile: { ...real.profile, profile_id: profileId, recovery_selector: selector, recovery_hash: sealedRecoveryDigest(selector) },
    };
  };
  const creationOf = (s: Scenario, principalId: string) => s.events.find((event) => event.kind === "profile-created" && event.principal_id === principalId) as Extract<SecurityEvent, { kind: "profile-created" }>;

  test("no confirmed creation: the LAST one (by the journal's key order) is made -- an earlier phantom is not", async () => {
    const s = await scenario();
    const hal = s.accounts.hal;
    const real = creationOf(s, hal.principalId); // unconfirmed (its confirmation was lost)
    const plan = replay(s, s.T, [...s.events, phantomCreation(real, -1, "a")]);
    const table = await applyPlan(s.T, plan);
    assert.equal(table.profiles.find((profile) => profile.principal_id === hal.principalId)?.profile_id, real.profile.profile_id);
  });

  test("a confirmed creation is made even when an unconfirmed one comes after it", async () => {
    const s = await scenario();
    const bob = s.accounts.bob;
    const real = creationOf(s, bob.principalId); // confirmed
    const plan = replay(s, s.T, [...s.events, phantomCreation(real, +1, "b")]);
    const table = await applyPlan(s.T, plan);
    assert.equal(table.profiles.find((profile) => profile.principal_id === bob.principalId)?.profile_id, real.profile.profile_id);
  });

  test("a profile the restored table holds stands (proof of commit); a CONFIRMED creation of another profile contradicts it: refused", async () => {
    const s = await scenario();
    const ann = s.accounts.ann;
    const real = creationOf(s, ann.principalId);
    const plan = replay(s, s.T, [...s.events, phantomCreation(real, +1, "c")]);
    assert.equal((await applyPlan(s.T, plan)).profiles.find((profile) => profile.principal_id === ann.principalId)?.profile_id, real.profile.profile_id);
    const other = phantomCreation(real, +1, "d");
    const confirmation: SecurityEvent = { format: "gs-security-event", version: 1, event_id: "e".repeat(32), at: other.at, principal_id: ann.principalId, kind: "confirmed", confirms: other.event_id, confirmed_kind: "profile-created" };
    assert.throws(() => replay(s, s.T, [...s.events, other, confirmation]), /two confirmed profile creations|another profile/);
  });
});

describe("L6-4 R2: idempotent, resumable, deterministic, order-independent", () => {
  test("a second plan over the replayed table changes NOTHING (reviews stay, identical)", async () => {
    const s = await scenario();
    const first = replay(s);
    const table = await applyPlan(s.T, first);
    const second = replay(s, table, s.events, recordsOf(first));
    assert.deepEqual(second.principals.filter((entry) => entry.change !== null), [], "nothing left to do");
    assert.deepEqual(second.reviews, first.reviews, "the same review records");
    assert.equal(second.journal.digest, first.journal.digest);
  });

  test("interrupted after ANY prefix of its changes, the replay converges to exactly the same table", async () => {
    const s = await scenario();
    const plan = replay(s);
    const full = await applyPlan(s.T, plan);
    for (let prefix = 0; prefix <= plan.principals.length; prefix += 1) {
      const partial = await applyPlan(s.T, plan, prefix);
      const resumed = replay(s, partial, s.events, recordsOf(plan, prefix));
      const done = await applyPlan(partial, resumed);
      assert.deepEqual(done, full, `resumed after ${prefix} of ${plan.principals.length}`);
      assert.deepEqual(resumed.reviews, plan.reviews, `the same reviews after ${prefix}`);
    }
  });

  test("the journal's order and duplicated reads change nothing; the same input gives the same plan", async () => {
    const s = await scenario();
    const plan = replay(s);
    assert.deepEqual(replay(s), plan, "deterministic");
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 5; round += 1) {
      const shuffled = [...s.events, ...s.events.filter(() => random() < 0.3)].map((event) => JSON.parse(JSON.stringify(event)) as SecurityEvent);
      for (let at = shuffled.length - 1; at > 0; at -= 1) {
        const other = Math.floor(random() * (at + 1));
        [shuffled[at], shuffled[other]] = [shuffled[other], shuffled[at]];
      }
      assert.deepEqual(replay(s, s.T, shuffled), plan, `round ${round}`);
    }
    /* The restored table's own record order does not matter either. */
    const reversed: FullIdentitySnapshot = { principals: [...s.T.principals].reverse(), sessions: [...s.T.sessions].reverse(), profiles: [...s.T.profiles].reverse(), links: [...s.T.links].reverse(), families: [...s.T.families].reverse() };
    assert.deepEqual(replay(s, reversed), plan);
  });
});

describe("L6-4 R2b: a confirmation that lands AFTER a replay began: the resumed replay converges on what the journal now says", () => {
  test("a profile quarantined for a rotation whose confirmation arrives later is released on the resume -- the same table as a replay that saw the confirmation from the start", async () => {
    const s = await scenario();
    const gina = s.legacy.gina;
    /* Run 1 sees Gina's rotation unconfirmed (the scenario lost its confirmation): quarantine, review. */
    const first = replay(s);
    const partial = await applyPlan(s.T, first);
    assert.equal(first.reviews.some((review) => review.principal_id === gina.principalId), true);
    /* The confirmation lands (best effort, late). The resumed replay knows its own review of Gina. */
    const lateConfirmation: SecurityEvent = { format: "gs-security-event", version: 1, event_id: "f".repeat(32), at: T0 + 30 * MIN, principal_id: gina.principalId, kind: "confirmed", confirms: s.lost.gina, confirmed_kind: "recovery-key-rotated" };
    const events = [...s.events, lateConfirmation];
    const own = first.reviews.map((review) => ({ profile_id: review.profile_id, restore_id: RESTORE, resolved_at: null, prior_status: review.prior_status }));
    const resumed = planSecurityReplay({ snapshot: partial, events, restoreId: RESTORE, at: AT, reviews: own });
    const ginaEntry = resumed.principals.find((entry) => entry.principal_id === gina.principalId);
    assert.ok(ginaEntry?.dropReview !== null && ginaEntry?.dropReview !== undefined, "its own review is withdrawn");
    const done = await applyPlan(partial, resumed);
    const fresh = await applyPlan(s.T, planSecurityReplay({ snapshot: s.T, events, restoreId: RESTORE, at: AT }));
    assert.deepEqual(done, fresh, "the same table as a replay that saw the confirmation from the start");
    const profile = done.profiles.find((entry) => entry.principal_id === gina.principalId);
    assert.equal(profile?.status, "active");
    assert.equal(profile?.recovery_selector, gina.keys[1], "her confirmed key G2 (only the replay's quarantine had retired it)");
    /* Without the knowledge of its own review a replay may not re-enable anything: a disabled profile stays disabled. */
    assert.equal(planSecurityReplay({ snapshot: partial, events, restoreId: RESTORE, at: AT }).principals.find((entry) => entry.principal_id === gina.principalId)?.dropReview ?? null, null);
  });
});

describe("L6-4 R2d: a withdrawn review restores exactly the status the profile had before it", () => {
  test("a profile already disabled at the restore point (say, kept disabled by an operator) stays disabled when this restore withdraws its own review", async () => {
    const s = await scenario();
    const gina = s.legacy.gina;
    const disabledAtT: FullIdentitySnapshot = { ...s.T, profiles: s.T.profiles.map((profile) => (profile.principal_id === gina.principalId ? { ...profile, status: "disabled" } : profile)) };
    const first = planSecurityReplay({ snapshot: disabledAtT, events: s.events, restoreId: RESTORE, at: AT });
    assert.equal(first.reviews.find((review) => review.principal_id === gina.principalId)?.prior_status, "disabled");
    const partial = await applyPlan(disabledAtT, first);
    const lateConfirmation: SecurityEvent = { format: "gs-security-event", version: 1, event_id: "f".repeat(32), at: T0 + 30 * MIN, principal_id: gina.principalId, kind: "confirmed", confirms: s.lost.gina, confirmed_kind: "recovery-key-rotated" };
    const events = [...s.events, lateConfirmation];
    const own = first.reviews.map((review) => ({ profile_id: review.profile_id, restore_id: RESTORE, resolved_at: null, prior_status: review.prior_status }));
    const done = await applyPlan(partial, planSecurityReplay({ snapshot: partial, events, restoreId: RESTORE, at: AT, reviews: own }));
    const fresh = await applyPlan(disabledAtT, planSecurityReplay({ snapshot: disabledAtT, events, restoreId: RESTORE, at: AT }));
    assert.equal(done.profiles.find((profile) => profile.principal_id === gina.principalId)?.status, "disabled");
    assert.deepEqual(done, fresh, "the same table as a replay that saw the confirmation from the start");
  });
});

describe("L6-4 R2c: gaps in a (legacy) key chain, and a table restored after an earlier restore's reviews", () => {
  test("a table already at the head of a chain with a lost confirmation in its middle: the head is kept (confirmed), the profile is reviewed -- never refused", async () => {
    const s = await scenario();
    const kim = s.legacy.kim;
    const rotations = s.events.filter((event): event is Extract<SecurityEvent, { kind: "recovery-key-rotated" }> => event.kind === "recovery-key-rotated" && event.principal_id === kim.principalId);
    const last = rotations.find((rotation) => rotation.to_selector === kim.keys[3]) as Extract<SecurityEvent, { kind: "recovery-key-rotated" }>;
    const atHead: FullIdentitySnapshot = { ...s.T, profiles: s.T.profiles.map((profile) => (profile.principal_id === kim.principalId ? { ...profile, recovery_selector: last.to_selector, recovery_hash: last.recovery_hash, recovery_rotated_at: last.rotated_at } : profile)) };
    const plan = replay(s, atHead);
    const review = plan.reviews.find((entry) => entry.principal_id === kim.principalId);
    assert.equal(review?.selector_state, "confirmed-head-retained");
    const table = await applyPlan(atHead, plan);
    const profile = table.profiles.find((entry) => entry.principal_id === kim.principalId);
    assert.deepEqual([profile?.recovery_selector, profile?.status], [kim.keys[3], "disabled"]);
  });

  test("a second restore of a table that carries an earlier restore's quarantine and open review: replayed (never refused); the profile stays disabled while the earlier review is open, even once every rotation is confirmed", async () => {
    const s = await scenario();
    const gina = s.legacy.gina;
    const first = replay(s);
    const t1 = await applyPlan(s.T, first);
    const earlier = first.reviews.map((review) => ({ profile_id: review.profile_id, restore_id: RESTORE, resolved_at: null, prior_status: review.prior_status }));
    const second = planSecurityReplay({ snapshot: t1, events: s.events, restoreId: "drill-2", at: AT + MIN, reviews: earlier });
    const t2 = await applyPlan(t1, second);
    const g2 = t2.profiles.find((profile) => profile.principal_id === gina.principalId);
    assert.equal(g2?.status, "disabled");
    assert.ok(!gina.keys.includes(g2?.recovery_selector as string), "no key of an unknown outcome");
    const lateConfirmation: SecurityEvent = { format: "gs-security-event", version: 1, event_id: "f".repeat(32), at: T0 + 30 * MIN, principal_id: gina.principalId, kind: "confirmed", confirms: s.lost.gina, confirmed_kind: "recovery-key-rotated" };
    const settled = planSecurityReplay({ snapshot: t1, events: [...s.events, lateConfirmation], restoreId: "drill-2", at: AT + MIN, reviews: earlier });
    const t3 = await applyPlan(t1, settled);
    const g3 = t3.profiles.find((profile) => profile.principal_id === gina.principalId);
    assert.deepEqual([g3?.recovery_selector, g3?.status], [gina.keys[1], "disabled"], "the confirmed key, but still disabled: the earlier restore's review is not this replay's to withdraw");
  });
});

describe("L6-4 R3: strict -- a journal that cannot be read without guessing stops the replay", () => {
  const cases: Array<[string, (events: SecurityEvent[]) => unknown[]]> = [
    ["a non-event", (events) => [...events, { kind: "family-revoked" }]],
    ["two different events under one key", (events) => {
      const target = events.find((event) => event.kind === "family-revoked") as Extract<SecurityEvent, { kind: "family-revoked" }>;
      return [...events, { ...target, reason: "operator" }];
    }],
    ["one event id at two times", (events) => {
      const target = events.find((event) => event.kind === "family-revoked") as SecurityEvent;
      return [...events, { ...target, at: target.at + 1 }];
    }],
    ["a confirmation of nothing", (events) => {
      const confirmation = events.find((event) => event.kind === "confirmed") as Extract<SecurityEvent, { kind: "confirmed" }>;
      return [...events, { ...confirmation, event_id: "e".repeat(32), confirms: "d".repeat(32) }];
    }],
    ["a confirmation of another kind", (events) => {
      const confirmation = events.find((event) => event.kind === "confirmed" && event.confirmed_kind === "profile-created") as Extract<SecurityEvent, { kind: "confirmed" }>;
      return [...events.filter((event) => event !== confirmation), { ...confirmation, confirmed_kind: "family-revoked" }];
    }],
  ];
  for (const [label, damage] of cases) {
    test(label, async () => {
      const s = await scenario();
      assert.throws(() => replay(s, s.T, damage([...s.events]) as SecurityEvent[]), SecurityReplayError);
    });
  }

  test("a (legacy) key rotation naming another principal's profile; two rotations installing one key; a family of another principal", async () => {
    const s = await scenario();
    const rotation = s.events.find((event) => event.kind === "recovery-key-rotated" && event.principal_id === s.legacy.frank.principalId) as Extract<SecurityEvent, { kind: "recovery-key-rotated" }>;
    const other = s.T.profiles.find((profile) => profile.principal_id === s.legacy.dave.principalId)?.profile_id as string;
    assert.throws(() => replay(s, s.T, [...s.events, { ...rotation, event_id: "c".repeat(32), profile_id: other }]), /another profile/);
    assert.throws(() => replay(s, s.T, [...s.events, { ...rotation, event_id: "c".repeat(32), from_selector: quarantineKeyOf("x", "y").selector }]), /same key/);
    const revoked = s.events.find((event) => event.kind === "family-revoked") as Extract<SecurityEvent, { kind: "family-revoked" }>;
    const daveFamily = s.T.families.find((family) => family.principal_id === s.legacy.dave.principalId)?.family_id as string;
    assert.throws(() => replay(s, s.T, [...s.events, { ...revoked, event_id: "b".repeat(32), family_ids: [daveFamily] }]), /another principal/);
  });

  test("PHASE 3 FINAL: a password or Authorization Wallet replacement naming another principal's profile; two CONFIRMED replacements from one password or one designation", async () => {
    const s = await scenario();
    const { pat, uma } = s.accounts;
    const patProfile = s.T.profiles.find((profile) => profile.principal_id === pat.principalId)?.profile_id as string;
    const password = s.events.find((event) => event.kind === "password-replaced" && event.principal_id === s.accounts.ann.principalId) as Extract<SecurityEvent, { kind: "password-replaced" }>;
    assert.throws(() => replay(s, s.T, [...s.events, { ...password, event_id: "c".repeat(32), profile_id: patProfile }]), /another profile/);
    const wallet = s.events.find((event) => event.kind === "authorization-wallet-replaced" && event.principal_id === uma.principalId) as Extract<SecurityEvent, { kind: "authorization-wallet-replaced" }>;
    assert.throws(() => replay(s, s.T, [...s.events, { ...wallet, event_id: "c".repeat(32), profile_id: patProfile }]), /another profile/);
    const confirm = (event: SecurityEvent, id: string): SecurityEvent => ({ format: "gs-security-event", version: 1, event_id: id.repeat(32), at: event.at, principal_id: event.principal_id, kind: "confirmed", confirms: event.event_id, confirmed_kind: event.kind as Extract<SecurityEvent, { kind: "confirmed" }>["confirmed_kind"] });
    /* Pat's change after T (confirmed; the chain is walked from the password the table holds), and a second CONFIRMED
       change from that same password to another one. */
    const [patFirst, patSecond] = s.events.filter((event): event is Extract<SecurityEvent, { kind: "password-replaced" }> => event.kind === "password-replaced" && event.principal_id === pat.principalId).sort((a, b) => a.at - b.at);
    const fork = { ...patSecond, event_id: "d".repeat(32), to_hash: patFirst.from_hash };
    assert.throws(() => replay(s, s.T, [...s.events, fork, confirm(fork, "e")]), /two confirmed password replacements start from one password/);
    /* Uma's replacement after T (from the designation the table holds; its confirmation was lost -- here it arrives), and
       a second CONFIRMED one from that same designation to another wallet. */
    const umaSecond = s.events.filter((event): event is Extract<SecurityEvent, { kind: "authorization-wallet-replaced" }> => event.kind === "authorization-wallet-replaced" && event.principal_id === uma.principalId).sort((a, b) => a.at - b.at)[1];
    const walletFork = { ...umaSecond, event_id: "d".repeat(32), to_wallet: keplrAccount("l6-4/uma/fork").address };
    assert.throws(() => replay(s, s.T, [...s.events, confirm(umaSecond, "f"), walletFork, confirm(walletFork, "e")]), /two confirmed wallet replacements start from one designation/);
  });

  test("PHASE 3 FINAL: a key rotation naming an Authorization Wallet account (schema 3, no recovery key) is refused by the PLAN -- before any store write", async () => {
    const s = await scenario();
    const pat = s.accounts.pat;
    const profile = s.T.profiles.find((entry) => entry.principal_id === pat.principalId) as Profile;
    assert.equal(profile.schema, 3, "Pat's account is an Authorization Wallet account");
    /* A forged (or damaged) rotation of Pat's internal credential epoch: no build ever journals one for such an account. */
    const forged: Extract<SecurityEvent, { kind: "recovery-key-rotated" }> = {
      format: "gs-security-event",
      version: 1,
      event_id: "fe" + "0".repeat(30),
      at: AT - MIN,
      principal_id: pat.principalId,
      kind: "recovery-key-rotated",
      profile_id: profile.profile_id,
      from_selector: profile.recovery_selector,
      to_selector: quarantineKeyOf("forged", profile.profile_id).selector,
      recovery_hash: "a".repeat(64),
      rotated_at: AT - MIN,
    };
    const confirmation: SecurityEvent = { format: "gs-security-event", version: 1, event_id: "ff" + "0".repeat(30), at: forged.at, principal_id: pat.principalId, kind: "confirmed", confirms: forged.event_id, confirmed_kind: "recovery-key-rotated" };
    /* The table the restore would write: it must see no write at all. */
    const target = createMemoryIdentityStore(s.T);
    for (const [label, events] of [["unconfirmed", [...s.events, forged]], ["confirmed", [...s.events, forged, confirmation]]] as const) {
      assert.throws(
        () => replay(s, target.snapshot(), events),
        (error: unknown) => error instanceof SecurityReplayError && /names an Authorization Wallet account, which has no recovery key/.test((error as Error).message),
        `${label}: refused up front, as a SecurityReplayError`,
      );
    }
    assert.equal(target.stats.commits, 0, "nothing was written");
    assert.deepEqual(target.snapshot(), s.T, "the table is exactly as restored");
    /* The same journal without the forged rotation still plans (the refusal is that event's, not the scenario's). */
    assert.ok(replay(s).principals.length > 0);
  });

  test("the canonical journal refuses a malformed stored event and names no content", () => {
    assert.throws(() => canonicalJournal([{ nope: true } as unknown as SecurityEvent]), (error: unknown) => error instanceof SecurityReplayError && /#0 is not a well-formed/.test((error as Error).message));
  });
});

describe("L6-4 R4: nothing secret is shown", () => {
  test("the report and the review summaries carry no key, selector, key or password digest, password, session id or session secret", async () => {
    const s = await scenario();
    const plan = replay(s);
    const shown = JSON.stringify({ report: plan.report, reviews: plan.reviews, journal: plan.journal });
    assertPrintable(shown);
    for (const player of Object.values(s.legacy)) {
      for (const key of player.keys) assert.ok(!shown.includes(key), "no legacy key selector");
      if (player.read.kind === "session") assert.ok(!shown.includes(player.read.sessionId) && !shown.includes(player.read.secret));
    }
    for (const account of Object.values(s.accounts)) {
      for (const password of account.passwords) assert.ok(!shown.includes(password), "no password");
      if (account.read.kind === "session") assert.ok(!shown.includes(account.read.sessionId) && !shown.includes(account.read.secret));
    }
    for (const profile of s.T.profiles) {
      assert.ok(!shown.includes(profile.recovery_hash), "no key digest (legacy) or sealed epoch digest");
      assert.ok(!shown.includes(profile.recovery_selector), "no selector or credential epoch");
      if (typeof profile.password_hash === "string") assert.ok(!shown.includes(profile.password_hash), "no password hash");
    }
    assert.throws(() => assertPrintable(JSON.stringify({ x: quarantineKeyOf("a", "b").selector })), /recovery selector/);
    assert.throws(() => assertPrintable(JSON.stringify({ recovery_hash: "x" })), /key or secret field/);
  });
});

describe("L6-4 G: the generation items' strict codecs", () => {
  const S = (value: string): AttributeValue => ({ S: value });
  const N = (value: number): AttributeValue => ({ N: String(value) });
  const claim = "0f0e0d0c-0b0a-4908-8706-050403020100";

  test("APPGEN: the bootstrap and adopted forms read; anything else refused -- a newer schema as newer, never overwritten", () => {
    const boot = { pk: S("APPGEN"), sk: S("APPGEN"), schema: N(1), current_generation: N(3) };
    assert.deepEqual(parseAppGeneration(boot), { current_generation: 3, adoption: null });
    const adopted = { ...boot, current_generation: N(4), previous_generation: N(3), adopted_at: N(5), adopted_by: S("op-run"), restore_id: S("r-1a"), game_table: S("gs-x-game-g4"), claim: S(claim) };
    assert.equal(parseAppGeneration(adopted).adoption?.previous_generation, 3);
    assert.throws(() => parseAppGeneration({ ...boot, schema: N(2) }), (error: unknown) => error instanceof AppGenerationUnreadableError && error.format === "newer");
    for (const damaged of [{ ...boot, extra: S("x") }, { ...boot, current_generation: N(0) }, { ...adopted, previous_generation: N(4) }, { ...adopted, claim: S("not-a-token") }, { ...boot, schema: S("1") }]) {
      assert.throws(() => parseAppGeneration(damaged as Record<string, AttributeValue>), (error: unknown) => error instanceof AppGenerationUnreadableError && error.format === "corrupt");
    }
    const history = { ...appgenHistoryKey(4), schema: N(1), kind: S("appgen-adoption"), generation: N(4), previous_generation: N(3), adopted_at: N(5), adopted_by: S("op-run"), restore_id: S("r-1a"), game_table: S("gs-x-game-g4"), claim: S(claim) };
    assert.equal(parseAdoptionRecord(history).generation, 4);
    assert.throws(() => parseAdoptionRecord({ ...history, generation: N(5) }), AppGenerationUnreadableError);
  });

  test("an adoption request never moves backwards or stays, and names a well-formed table, restore and operator", () => {
    const ok = { expected: 3, generation: 4, gameTable: "gs-x-game-g4", restoreId: "r-1a", by: "op-run" };
    assert.equal(adoptionRequestProblem(ok), null);
    assert.match(adoptionRequestProblem({ ...ok, generation: 3 }) ?? "", /does not move forward/);
    assert.match(adoptionRequestProblem({ ...ok, generation: 2 }) ?? "", /does not move forward/);
    assert.match(adoptionRequestProblem({ ...ok, restoreId: "R 1" }) ?? "", /restore id/);
    assert.match(adoptionRequestProblem({ ...ok, by: "has space" }) ?? "", /by/);
  });

  test("SYSTEM/GENERATION: strict; the startup's rule; a preparation always moves to a NEW, higher table", () => {
    const marker = bootstrapGenerationMarker({ generation: 1, gameTable: "gs-x-game-g1", by: "l5-8", now: 1 });
    const item = generationMarkerItem(marker);
    assert.deepEqual(parseGenerationMarker(item), marker);
    assert.throws(() => parseGenerationMarker({ ...item, fmt: N(2) }), /newer build/);
    assert.throws(() => parseGenerationMarker({ ...item, extra: S("x") }), GenerationMarkerUnreadableError);
    assert.throws(() => parseGenerationMarker({ ...item, restore_id: S("r-1a") }), /bootstrap but names a restore/);
    assert.equal(generationMarkerProblem(marker, { generation: 1, gameTable: "gs-x-game-g1" }), null);
    assert.match(generationMarkerProblem(null, { generation: 1, gameTable: "gs-x-game-g1" }) ?? "", /no generation marker/);
    assert.match(generationMarkerProblem(marker, { generation: 2, gameTable: "gs-x-game-g1" }) ?? "", /holds app generation 1/);
    const request = { gameTable: "gs-x-game-g2", generation: 2, restoredFrom: { generation: 1, table: "gs-x-game-g1" }, restorePoint: 5, restoreId: "r-1a", by: "op", now: 9 };
    assert.equal(preparationProblem(request), null);
    assert.match(preparationProblem({ ...request, generation: 1 }) ?? "", /does not move forward/);
    assert.match(preparationProblem({ ...request, gameTable: "gs-x-game-g1" }) ?? "", /NEW table/);
  });

  test("the operator CLI's flags: a command first; a flag without a value is a switch", () => {
    const parsed = parseFlags(["appgen-adopt", "--expected", "3", "--apply", "--stopped"]);
    assert.equal(parsed.command, "appgen-adopt");
    assert.equal(parsed.flags.get("expected"), "3");
    assert.equal(parsed.flags.get("apply"), true);
    assert.throws(() => parseFlags(["--apply"]), UsageError);
    assert.throws(() => parseFlags(["x", "loose"]), UsageError);
  });
});

describe("L6-4 S: a serving task never creates, repairs or follows a generation record", () => {
  test("the runtime and the ownership layer only READ APPGEN and SYSTEM/GENERATION: no adoption, preparation, bootstrap, history or restore write is reachable from them", () => {
    const root = path.resolve(__dirname, "../../../../../src"); // dist/server/src/aws/recovery -> server/src
    const files = ["aws/runtime", "aws/ownership"].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => `${dir}/${name}`));
    assert.ok(files.length >= 10, `found the serving sources (${files.length})`);
    const forbidden = [/adoptGeneration/, /prepareRestoredTable/, /bootstrapGenerationMarker/, /generationMarkerItem/, /APPGEN#HISTORY|appgenHistoryKey/, /applyIdentityRestore/, /takeOverRelayer\(\)[^;]*generation/, /aws\/recovery|\.\.\/recovery\//];
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      for (const pattern of forbidden) if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
    }
    assert.deepEqual(offenders, []);
    /* The generation a task serves is its configuration's, fixed: the runtime compares, it never assigns what it read. */
    const runtime = fs.readFileSync(path.join(root, "aws/runtime/awsRuntime.ts"), "utf8");
    assert.match(runtime, /if \(adopted !== config\.generation\)/);
    assert.match(runtime, /generationMarkerProblem\(marker, \{ generation: config\.generation, gameTable: config\.gameTable \}\)/);
    assert.doesNotMatch(runtime, /config\.generation\s*=|generation:\s*adopted/);
  });
});
