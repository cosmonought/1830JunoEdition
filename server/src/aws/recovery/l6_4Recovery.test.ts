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
//      disable); a profile created after T exists (confirmed, and unconfirmed-last); a retired key never resolves again;
//      the confirmed chain's head is the key; an UNCONFIRMED rotation -- committed with its confirmation lost, before or
//      after T, or a phantom -- retires its old key, never installs its new one, and sends the profile to review
//      (disabled; the head kept only when not implicated, else a quarantine key nobody holds).
//   R2 idempotent (a second plan changes nothing), resumable (interrupted after ANY prefix of the changes, the replay
//      converges to the same table), deterministic and independent of the journal's order and of duplicated reads.
//   R3 strict: a malformed or contradictory journal refuses the whole replay (fail closed).
//   R4 no secret, selector or key digest in what an operator is shown.
//   G  the APPGEN, adoption-history and SYSTEM/GENERATION codecs: strict, newer refused, damage refused.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import { readSessionCookie, type SessionCookieRead } from "../../identity/cookies";
import { createMemoryGrantStore } from "../../identity/grants";
import { createMemorySecurityJournal, parseSecurityEventBody, type SecurityEvent } from "../../identity/securityEvents";
import { canonicalJournal, planSecurityReplay, quarantineKeyOf, SecurityReplayError, type ReplayPlan } from "../../identity/securityReplay";
import { IdentityService } from "../../identity/sessions";
import { createMemoryIdentityStore, type FullIdentitySnapshot, type IdentityChange, type IdentityCommitOptions, type IdentityStore, type Session } from "../../identity/store";
import { StoreDefiniteError } from "../../persistence/storeResult";
import { bootstrapGenerationMarker, generationMarkerItem, generationMarkerProblem, GenerationMarkerUnreadableError, parseGenerationMarker, preparationProblem } from "../game/generationMarker";
import { adoptionRequestProblem, AppGenerationUnreadableError, appgenHistoryKey, parseAdoptionRecord, parseAppGeneration } from "../ledger/appGeneration";
import { assertPrintable } from "./recoveryOps";
import { parseFlags, UsageError } from "./recoveryCli";

const T0 = 1_780_000_000_000;
const MIN = 60 * 1000;
const RESTORE = "drill-1";

const readOf = (setCookie: string | null | undefined): SessionCookieRead => {
  assert.ok(setCookie, "a Set-Cookie");
  return readSessionCookie(setCookie.split(";")[0]);
};
const sessionIdOf = (read: SessionCookieRead): string => (read.kind === "session" ? read.sessionId : "");
const selectorOf = (key: string) => key.split(".")[0];

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

interface Player {
  read: SessionCookieRead;
  key: string;
  principalId: string;
  keys: string[];
}

/** The world: a journaled identity service over the memory store; actions before and after a restore point T. */
async function scenario() {
  const store = createMemoryIdentityStore();
  const journal = createMemorySecurityJournal();
  const { quirks, wrapped } = quirky(store);
  let clock = T0;
  const identity = await IdentityService.open(wrapped, { security: { journal, grants: createMemoryGrantStore(), clock: () => clock } });
  const now = () => clock;
  const tick = () => (clock += MIN);

  const create = async (name: string): Promise<Player> => {
    tick();
    const boot = await identity.bootstrap({ kind: "none" }, false, now());
    const read = readOf((boot as { setCookie: string | null }).setCookie);
    const created = await identity.createProfile(read, name, now());
    assert.equal(created.kind, "ok", name);
    await identity.settled();
    const key = (created as { recoveryKey: string }).recoveryKey;
    return { read, key, principalId: (identity.peekSession(sessionIdOf(read)) as Session).principal_id, keys: [key] };
  };
  const rotate = async (who: Player): Promise<string> => {
    tick();
    assert.equal((await identity.reauthenticate(who.read, who.key, now())).kind, "ok");
    const rotated = await identity.rotateRecoveryKey(who.read, now());
    assert.equal(rotated.kind, "ok");
    await identity.settled();
    who.key = (rotated as { recoveryKey: string }).recoveryKey;
    who.keys.push(who.key);
    return who.key;
  };
  const recover = async (key: string): Promise<SessionCookieRead> => {
    tick();
    const boot = await identity.bootstrap({ kind: "none" }, false, now());
    const outcome = await identity.recover(readOf((boot as { setCookie: string | null }).setCookie), key, now());
    assert.equal(outcome.kind, "ok");
    return readOf((outcome as { setCookie: string }).setCookie);
  };

  /* ---------------- before T ---------------- */
  const ann = await create("Ann");
  const annPhone = await recover(ann.key);
  const carol = await create("Carol");
  const dave = await create("Dave");
  const eve = await create("Eve");
  const frank = await create("Frank");
  await rotate(frank); // K1 -> K2, confirmed, before T: already in the table
  const gina = await create("Gina");
  await rotate(gina); // G1 -> G2, committed before T; its confirmation is lost below
  const kim = await create("Kim");
  const T = store.snapshot();
  const readsAtT = [ann.read, annPhone, carol.read, dave.read, eve.read, frank.read, gina.read];

  /* ---------------- after T ---------------- */
  tick();
  assert.equal((await identity.reauthenticate(ann.read, ann.key, now())).kind, "ok");
  assert.equal((await identity.signOutOthers(ann.read, now())).kind, "ok"); // the phone's family
  await rotate(ann); // A1 -> A2
  await rotate(ann); // A2 -> A3
  tick();
  assert.equal(await identity.revoke(sessionIdOf(ann.read), "logout", now()), true);
  const bob = await create("Bob"); // a profile created after T, confirmed
  tick();
  assert.equal(await identity.disablePrincipal(carol.principalId, now()), true);
  await rotate(dave); // D1 -> D2 committed; its confirmation is lost below
  tick();
  assert.equal((await identity.reauthenticate(eve.read, eve.key, now())).kind, "ok");
  quirks.push("phantom");
  const phantom = await identity.rotateRecoveryKey(eve.read, now()); // E1 -> X: the event is written, the change refused
  assert.equal(phantom.kind, "unavailable");
  await rotate(frank); // K2 -> K3, confirmed, after T
  const hal = await create("Hal"); // created after T; its confirmation is lost below
  await rotate(kim); // K0 -> K1, confirmed
  await rotate(kim); // K1 -> K2, committed; its confirmation is lost below (a gap in the MIDDLE of a chain)
  await rotate(kim); // K2 -> K3, confirmed
  tick();
  const ivyBoot = await identity.bootstrap({ kind: "none" }, false, now());
  quirks.push("phantom");
  assert.equal((await identity.createProfile(readOf((ivyBoot as { setCookie: string | null }).setCookie), "Ivy", now())).kind, "unavailable"); // a phantom creation
  await identity.settled();

  /* Lose three confirmations: Dave's and Gina's rotations, Hal's creation (their changes DID commit). */
  const all = () => [...journal.bodies.values()].map((body) => parseSecurityEventBody(body) as SecurityEvent);
  const lose = (principalId: string, kind: SecurityEvent["kind"]) => {
    const target = all().filter((event) => event.principal_id === principalId && event.kind === kind).pop() as SecurityEvent;
    for (const [key, body] of journal.bodies) {
      const event = parseSecurityEventBody(body) as SecurityEvent;
      if (event.kind === "confirmed" && event.confirms === target.event_id) journal.bodies.delete(key);
    }
    return target.event_id;
  };
  const lost = { dave: lose(dave.principalId, "recovery-key-rotated"), gina: lose(gina.principalId, "recovery-key-rotated"), hal: lose(hal.principalId, "profile-created"), kim: "" };
  {
    const middle = all().filter((event) => event.principal_id === kim.principalId && event.kind === "recovery-key-rotated").sort((a, b) => a.at - b.at || (a.event_id < b.event_id ? -1 : 1))[1];
    for (const [key, body] of journal.bodies) {
      const event = parseSecurityEventBody(body) as SecurityEvent;
      if (event.kind === "confirmed" && event.confirms === middle.event_id) journal.bodies.delete(key);
    }
    lost.kim = middle.event_id;
  }
  const events = all();
  const ivyPrincipal = events.find((event) => event.kind === "profile-created" && event.profile.display_name === "Ivy")?.principal_id as string;
  const evePhantom = events.find((event) => event.kind === "recovery-key-rotated" && event.principal_id === eve.principalId)?.event_id as string;
  return { T, events, readsAtT, players: { ann, carol, dave, eve, frank, gina, bob, hal, kim }, annPhone, ivyPrincipal, lost, evePhantom, now };
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

async function recoverWith(identity: IdentityService, key: string, now: number): Promise<string> {
  const boot = await identity.bootstrap({ kind: "none" }, false, now);
  return (await identity.recover(readOf((boot as { setCookie: string | null }).setCookie), key, now)).kind;
}

describe("L6-4 R1: the replay's rules, end to end through a fresh identity service", () => {
  test("every session signed out; terminal actions re-applied; profiles created after T exist; the confirmed chain holds; unconfirmed rotations go to review; nothing retired resolves", async () => {
    const s = await scenario();
    const plan = replay(s);
    const table = await applyPlan(s.T, plan);
    const { ann, carol, dave, eve, frank, gina, bob, hal, kim } = s.players;

    /* Every session and family of the restored table is ended. */
    for (const session of table.sessions) assert.notEqual(session.revoked_at, null, "every session signed out");
    for (const family of table.families) assert.notEqual(family.revoked_at, null, "every family closed");
    const reason = (read: SessionCookieRead) => table.families.find((family) => family.family_id === table.sessions.find((session) => session.session_id === sessionIdOf(read))?.family_id)?.revoke_reason;
    assert.equal(reason(s.annPhone), "signed-out-remotely", "Ann's sign-out-others re-applied");
    assert.equal(reason(ann.read), "logout", "Ann's logout re-applied");
    assert.equal(table.principals.find((principal) => principal.principal_id === carol.principalId)?.status, "disabled", "Carol's disable re-applied");
    assert.equal(reason(carol.read), "principal-disabled");

    const identity = await IdentityService.open(createMemoryIdentityStore(table));
    const later = AT + MIN;
    for (const read of s.readsAtT) assert.notEqual(identity.authenticate(read, later).kind, "ok", "no session of the restored table authenticates");

    /* Keys: the confirmed chain's head; every retired key dead; unconfirmed outcomes never accepted. */
    assert.equal(await recoverWith(identity, ann.keys[2], later), "ok", "Ann's A3 (the confirmed chain's head)");
    for (const key of ann.keys.slice(0, 2)) assert.equal(await recoverWith(identity, key, later), "invalid", "Ann's retired keys");
    assert.equal(await recoverWith(identity, frank.keys[2], later), "ok", "Frank's K3");
    for (const key of frank.keys.slice(0, 2)) assert.equal(await recoverWith(identity, key, later), "invalid");
    assert.equal(await recoverWith(identity, bob.key, later), "ok", "Bob's profile, created after T, is back with its key");
    assert.equal(await recoverWith(identity, hal.key, later), "ok", "Hal's (unconfirmed, last) creation is back");
    assert.equal(await recoverWith(identity, carol.key, later), "invalid", "Carol is disabled");
    for (const key of [...dave.keys, ...eve.keys, ...gina.keys, ...kim.keys]) assert.equal(await recoverWith(identity, key, later), "invalid", "a profile under review accepts NO key");
    assert.ok(table.profiles.some((profile) => profile.principal_id === s.ivyPrincipal), "Ivy's phantom creation (the only one) is made: a player's only way back");

    /* The reviews: exactly the three profiles with an unconfirmed rotation, each disabled. */
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
    assert.equal(ginaTableKey, selectorOf(gina.keys[1]), "the restored table held Gina's unconfirmed new key ...");
    assert.notEqual(table.profiles.find((profile) => profile.principal_id === gina.principalId)?.recovery_selector, ginaTableKey, "... and it is taken out, not accepted");
    assert.deepEqual(byPrincipal.get(eve.principalId)?.unconfirmed_events, [s.evePhantom]);
    assert.deepEqual(byPrincipal.get(kim.principalId)?.unconfirmed_events, [s.lost.kim]);
    assert.equal(byPrincipal.get(kim.principalId)?.evidence.later_confirmed_from_unconfirmed, true, "K2 -> K3 is confirmed: the gap did commit (evidence for the operator)");
    /* Neither side of an unconfirmed rotation is any profile's key. */
    const live = new Set(table.profiles.map((profile) => profile.recovery_selector));
    for (const key of [...dave.keys, ...eve.keys, ...gina.keys]) assert.ok(!live.has(selectorOf(key)));
    /* Every link code is dropped. */
    assert.deepEqual(table.links, []);
  });

  test("an unconfirmed rotation whose old key is NOT the confirmed head keeps the head (disabled, under review; reversible by an operator)", async () => {
    const s = await scenario();
    const frank = s.players.frank;
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
      from_selector: selectorOf(frank.keys[0]),
      to_selector: quarantineKeyOf("other", "pf_x").selector,
      recovery_hash: "a".repeat(64),
      rotated_at: AT - MIN,
    };
    const plan = replay(s, s.T, [...s.events, stale]);
    const review = plan.reviews.find((entry) => entry.principal_id === frank.principalId);
    assert.equal(review?.selector_state, "confirmed-head-retained");
    const table = await applyPlan(s.T, plan);
    const profile = table.profiles.find((entry) => entry.principal_id === frank.principalId);
    assert.equal(profile?.recovery_selector, selectorOf(frank.keys[2]), "K3 kept as the key");
    assert.equal(profile?.status, "disabled", "but the profile is under review");
  });
});

describe("L6-4 R1b: which creation makes a profile the restored table does not hold", () => {
  /** Another creation of `principalId`'s profile: a phantom, `delta` ms from the real one, with its own ids and key. */
  const phantomCreation = (real: Extract<SecurityEvent, { kind: "profile-created" }>, delta: number, id: string): Extract<SecurityEvent, { kind: "profile-created" }> => {
    const profileId = `pf_${id.repeat(25).slice(0, 25)}0`;
    return {
      ...real,
      event_id: id.repeat(32).slice(0, 32),
      at: real.at + delta,
      principal: { ...real.principal, account_link: profileId },
      profile: { ...real.profile, profile_id: profileId, recovery_selector: quarantineKeyOf("phantom", profileId).selector },
    };
  };
  const creationOf = (s: Scenario, principalId: string) => s.events.find((event) => event.kind === "profile-created" && event.principal_id === principalId) as Extract<SecurityEvent, { kind: "profile-created" }>;

  test("no confirmed creation: the LAST one (by the journal's key order) is made -- an earlier phantom is not", async () => {
    const s = await scenario();
    const hal = s.players.hal;
    const real = creationOf(s, hal.principalId); // unconfirmed (its confirmation was lost)
    const plan = replay(s, s.T, [...s.events, phantomCreation(real, -1, "a")]);
    const table = await applyPlan(s.T, plan);
    assert.equal(table.profiles.find((profile) => profile.principal_id === hal.principalId)?.profile_id, real.profile.profile_id);
  });

  test("a confirmed creation is made even when an unconfirmed one comes after it", async () => {
    const s = await scenario();
    const bob = s.players.bob;
    const real = creationOf(s, bob.principalId); // confirmed
    const plan = replay(s, s.T, [...s.events, phantomCreation(real, +1, "b")]);
    const table = await applyPlan(s.T, plan);
    assert.equal(table.profiles.find((profile) => profile.principal_id === bob.principalId)?.profile_id, real.profile.profile_id);
  });

  test("a profile the restored table holds stands (proof of commit); a CONFIRMED creation of another profile contradicts it: refused", async () => {
    const s = await scenario();
    const ann = s.players.ann;
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
    const gina = s.players.gina;
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
    assert.equal(profile?.recovery_selector, selectorOf(gina.keys[1]), "her confirmed key G2 (only the replay's quarantine had retired it)");
    /* Without the knowledge of its own review a replay may not re-enable anything: a disabled profile stays disabled. */
    assert.equal(planSecurityReplay({ snapshot: partial, events, restoreId: RESTORE, at: AT }).principals.find((entry) => entry.principal_id === gina.principalId)?.dropReview ?? null, null);
  });
});

describe("L6-4 R2d: a withdrawn review restores exactly the status the profile had before it", () => {
  test("a profile already disabled at the restore point (say, kept disabled by an operator) stays disabled when this restore withdraws its own review", async () => {
    const s = await scenario();
    const gina = s.players.gina;
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

describe("L6-4 R2c: gaps in a key chain, and a table restored after an earlier restore's reviews", () => {
  test("a table already at the head of a chain with a lost confirmation in its middle: the head is kept (confirmed), the profile is reviewed -- never refused", async () => {
    const s = await scenario();
    const kim = s.players.kim;
    const rotations = s.events.filter((event): event is Extract<SecurityEvent, { kind: "recovery-key-rotated" }> => event.kind === "recovery-key-rotated" && event.principal_id === kim.principalId);
    const last = rotations.find((rotation) => rotation.to_selector === selectorOf(kim.keys[3])) as Extract<SecurityEvent, { kind: "recovery-key-rotated" }>;
    const atHead: FullIdentitySnapshot = { ...s.T, profiles: s.T.profiles.map((profile) => (profile.principal_id === kim.principalId ? { ...profile, recovery_selector: last.to_selector, recovery_hash: last.recovery_hash, recovery_rotated_at: last.rotated_at } : profile)) };
    const plan = replay(s, atHead);
    const review = plan.reviews.find((entry) => entry.principal_id === kim.principalId);
    assert.equal(review?.selector_state, "confirmed-head-retained");
    const table = await applyPlan(atHead, plan);
    const profile = table.profiles.find((entry) => entry.principal_id === kim.principalId);
    assert.deepEqual([profile?.recovery_selector, profile?.status], [selectorOf(kim.keys[3]), "disabled"]);
  });

  test("a second restore of a table that carries an earlier restore's quarantine and open review: replayed (never refused); the profile stays disabled while the earlier review is open, even once every rotation is confirmed", async () => {
    const s = await scenario();
    const gina = s.players.gina;
    const first = replay(s);
    const t1 = await applyPlan(s.T, first);
    const earlier = first.reviews.map((review) => ({ profile_id: review.profile_id, restore_id: RESTORE, resolved_at: null, prior_status: review.prior_status }));
    const second = planSecurityReplay({ snapshot: t1, events: s.events, restoreId: "drill-2", at: AT + MIN, reviews: earlier });
    const t2 = await applyPlan(t1, second);
    const g2 = t2.profiles.find((profile) => profile.principal_id === gina.principalId);
    assert.equal(g2?.status, "disabled");
    assert.ok(!gina.keys.map(selectorOf).includes(g2?.recovery_selector as string), "no key of an unknown outcome");
    const lateConfirmation: SecurityEvent = { format: "gs-security-event", version: 1, event_id: "f".repeat(32), at: T0 + 30 * MIN, principal_id: gina.principalId, kind: "confirmed", confirms: s.lost.gina, confirmed_kind: "recovery-key-rotated" };
    const settled = planSecurityReplay({ snapshot: t1, events: [...s.events, lateConfirmation], restoreId: "drill-2", at: AT + MIN, reviews: earlier });
    const t3 = await applyPlan(t1, settled);
    const g3 = t3.profiles.find((profile) => profile.principal_id === gina.principalId);
    assert.deepEqual([g3?.recovery_selector, g3?.status], [selectorOf(gina.keys[1]), "disabled"], "the confirmed key, but still disabled: the earlier restore's review is not this replay's to withdraw");
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

  test("a key rotation naming another principal's profile; two rotations installing one key; a family of another principal", async () => {
    const s = await scenario();
    const rotation = s.events.find((event) => event.kind === "recovery-key-rotated" && event.principal_id === s.players.ann.principalId) as Extract<SecurityEvent, { kind: "recovery-key-rotated" }>;
    const other = s.T.profiles.find((profile) => profile.principal_id === s.players.dave.principalId)?.profile_id as string;
    assert.throws(() => replay(s, s.T, [...s.events, { ...rotation, event_id: "c".repeat(32), profile_id: other }]), /another profile/);
    assert.throws(() => replay(s, s.T, [...s.events, { ...rotation, event_id: "c".repeat(32), from_selector: quarantineKeyOf("x", "y").selector }]), /same key/);
    const revoked = s.events.find((event) => event.kind === "family-revoked") as Extract<SecurityEvent, { kind: "family-revoked" }>;
    const daveFamily = s.T.families.find((family) => family.principal_id === s.players.dave.principalId)?.family_id as string;
    assert.throws(() => replay(s, s.T, [...s.events, { ...revoked, event_id: "b".repeat(32), family_ids: [daveFamily] }]), /another principal/);
  });

  test("the canonical journal refuses a malformed stored event and names no content", () => {
    assert.throws(() => canonicalJournal([{ nope: true } as unknown as SecurityEvent]), (error: unknown) => error instanceof SecurityReplayError && /#0 is not a well-formed/.test((error as Error).message));
  });
});

describe("L6-4 R4: nothing secret is shown", () => {
  test("the report and the review summaries carry no key, selector, key digest, session id or session secret", async () => {
    const s = await scenario();
    const plan = replay(s);
    const shown = JSON.stringify({ report: plan.report, reviews: plan.reviews, journal: plan.journal });
    assertPrintable(shown);
    for (const player of Object.values(s.players)) {
      for (const key of player.keys) {
        assert.ok(!shown.includes(selectorOf(key)) && !shown.includes(key.split(".")[1]), "no key or selector");
      }
      if (player.read.kind === "session") assert.ok(!shown.includes(player.read.sessionId) && !shown.includes(player.read.secret));
    }
    for (const profile of s.T.profiles) assert.ok(!shown.includes(profile.recovery_hash));
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
