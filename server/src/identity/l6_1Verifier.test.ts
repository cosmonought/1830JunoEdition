// server/src/identity/l6_1Verifier.test.ts
//
// LIVE-6 L6-1: the identity verifier (`identity/verifier.ts`) -- the non-writer identity path -- against the WRITER itself.
// The records are written by a real `IdentityService` (the identity writer) over a memory store; the verifier reads the
// store's committed records one at a time, as the DynamoDB reader does (its own DynamoDB Local suite is
// `persistence/conformance/l6_1Routing.dynamoLocal.test.ts`):
//
//   - the SAME answer as the writer for every cookie and every state the writer can put a session in: current, rotated,
//     in its grace, logged out, its family revoked by "sign out other devices", its principal disabled, expired, a wrong
//     secret, an unknown selector, a malformed cookie, no cookie, an unprofiled principal -- and the same per-frame
//     verdict (`socketVerdict`) for a socket opened on each;
//   - it answers from the records AS THEY ARE NOW (a revocation committed by the writer is seen at the very next
//     question: nothing is kept between two questions);
//   - it FAILS CLOSED: a read that fails, damage, a session without its family or principal, a family of another
//     principal, a profiled principal without its profile -- `unavailable`, never `ok`;
//   - it never writes (the store's commit count is unchanged; the port has no write) and never reads more than one record
//     for a cookie whose secret does not match.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readSessionCookie, type SessionCookieRead } from "./cookies";
import { IdentityService } from "./sessions";
import { createMemoryIdentityStore, type Principal, type Profile, type Session, type SessionFamily } from "./store";
import { createSessionVerifier, IdentityRecordUnreadableError, snapshotRecordReader, type IdentityRecordReader } from "./verifier";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_760_000_000_000;

const readOf = (setCookie: string | null | undefined): SessionCookieRead => {
  assert.ok(setCookie, "a Set-Cookie");
  return readSessionCookie(setCookie.split(";")[0]);
};

/** The verifier over the store's records AS THEY ARE at each read (never a copy kept), counting the reads. */
function liveReader(store: ReturnType<typeof createMemoryIdentityStore>) {
  const reads: string[] = [];
  const reader: IdentityRecordReader = {
    session: async (id) => (reads.push("session"), store.snapshot().sessions.find((r) => r.session_id === id) ?? null),
    principal: async (id) => (reads.push("principal"), store.snapshot().principals.find((r) => r.principal_id === id) ?? null),
    family: async (id) => (reads.push("family"), store.snapshot().families.find((r) => r.family_id === id) ?? null),
    profile: async (id) => (reads.push("profile"), store.snapshot().profiles.find((r) => r.profile_id === id) ?? null),
  };
  return { reader, reads };
}

async function world() {
  const store = createMemoryIdentityStore();
  const writer = await IdentityService.open(store);
  const { reader, reads } = liveReader(store);
  return { store, writer, verifier: createSessionVerifier(reader), reads };
}

async function profiled(writer: IdentityService, now: number, name = "Ann"): Promise<{ read: SessionCookieRead; key: string }> {
  const boot = await writer.bootstrap({ kind: "none" }, false, now);
  assert.equal(boot.kind, "ok");
  const read = readOf((boot as { setCookie: string | null }).setCookie);
  const created = await writer.createProfile(read, name, now);
  assert.equal(created.kind, "ok");
  return { read, key: (created as { recoveryKey: string }).recoveryKey };
}

/** The writer's answer to an upgrade (step 5 + 5b), in the verifier's terms. */
function writerAnswer(writer: IdentityService, read: SessionCookieRead, now: number) {
  const auth = writer.authenticate(read, now);
  if (auth.kind !== "ok") return { kind: auth.kind, why: auth.why };
  return { kind: auth.kind, principalId: auth.principalId, sessionId: auth.sessionId, profiled: writer.isProfiled(auth.principalId), expiresAt: auth.sessionExpiresAt };
}

describe("L6-1 identity verifier: the writer's answers, from the durable records, without writing", () => {
  test("every cookie in every state the writer can make: the verifier answers exactly as the writer does (upgrade and frame)", async () => {
    const { store, writer, verifier } = await world();
    const ann = await profiled(writer, T0, "Ann");
    const bob = await profiled(writer, T0 + 1, "Bob");
    const cat = await profiled(writer, T0 + 2, "Cat");
    const dan = await profiled(writer, T0 + 3, "Dan");
    /* Ann's phone: a second device by the recovery key (its own family). */
    const phoneBoot = await writer.bootstrap({ kind: "none" }, false, T0 + 4);
    const phoneTemp = readOf((phoneBoot as { setCookie: string }).setCookie);
    const phone = readOf(((await writer.recover(phoneTemp, ann.key, T0 + 4)) as { setCookie: string }).setCookie);
    /* Bob's tab rotates after a week: the old cookie is rotated (grace for a day), the successor is current. */
    const bobRotatedAt = T0 + 8 * DAY;
    const bobNext = readOf(((await writer.bootstrap(bob.read, false, bobRotatedAt)) as { setCookie: string }).setCookie);
    /* Cat logs out. */
    const catSession = cat.read.kind === "session" ? cat.read.sessionId : "";
    assert.equal(await writer.revoke(catSession, "logout", T0 + 9 * DAY), true);
    /* Ann signs out her other devices from her first browser: the phone's family is revoked. */
    const reauth = await writer.reauthenticate(ann.read, ann.key, T0 + 9 * DAY);
    assert.equal(reauth.kind, "ok");
    const others = await writer.signOutOthers(ann.read, T0 + 9 * DAY);
    assert.equal(others.kind, "ok");
    /* Dan is disabled by an operator. */
    const danPrincipal = (writer.peekSession(dan.read.kind === "session" ? dan.read.sessionId : "") as Session).principal_id;
    assert.equal(await writer.disablePrincipal(danPrincipal, T0 + 9 * DAY), true);
    /* A durable UNPROFILED principal (activated by a room action before any profile). */
    const guestBoot = await writer.bootstrap({ kind: "none" }, false, T0 + 9 * DAY);
    const guest = readOf((guestBoot as { setCookie: string }).setCookie);
    await writer.activate((writer.peekSession(guest.kind === "session" ? guest.sessionId : "") as Session).principal_id, T0 + 9 * DAY);
    /* A cookie with Ann's selector and a wrong secret; an unknown selector; malformed; none. */
    const wrongSecret: SessionCookieRead = ann.read.kind === "session" ? { kind: "session", sessionId: ann.read.sessionId, secret: bob.read.kind === "session" ? bob.read.secret : "" } : ann.read;
    const unknown: SessionCookieRead = bob.read.kind === "session" ? { kind: "session", sessionId: "se_" + "A".repeat(26), secret: bob.read.secret } : bob.read;
    const reads: Array<[string, SessionCookieRead]> = [
      ["ann (current)", ann.read],
      ["ann's phone (family signed out remotely)", phone],
      ["bob's rotated cookie (in its grace)", bob.read],
      ["bob's successor", bobNext],
      ["cat (logged out)", cat.read],
      ["dan (disabled)", dan.read],
      ["an unprofiled durable guest", guest],
      ["a wrong secret", wrongSecret],
      ["an unknown selector", unknown],
      ["malformed", readSessionCookie("__Host-gs_session=v1.x.y")],
      ["no cookie", { kind: "none" }],
    ];
    assert.ok(store.stats.commits > 0);
    const commitsBefore = store.stats.commits;
    for (const at of [T0 + 9 * DAY + 1, T0 + 9 * DAY + 2 * DAY, T0 + 200 * DAY]) {
      for (const [label, read] of reads) {
        const expected = writerAnswer(writer, read, at);
        const got = await verifier.authenticate(read, at);
        if (expected.kind === "ok") {
          assert.equal(got.kind, "ok", `${label} @${at - T0}: ${JSON.stringify(got)}`);
          if (got.kind !== "ok") continue;
          assert.deepEqual([got.principalId, got.sessionId, got.profiled], [expected.principalId, expected.sessionId, expected.profiled], label);
          /* The durable expiry: never later than the writer's (whose sliding expiry may not be flushed yet). */
          assert.ok(got.sessionExpiresAt <= (expected.expiresAt as number), `${label}: the verifier's expiry is never later than the writer's`);
          /* The frame's re-check agrees with the writer's per-frame verdict for a socket opened on it. */
          const ctx = { principalId: got.principalId, sessionId: got.sessionId, sessionExpiresAt: got.sessionExpiresAt };
          const frame = await verifier.recheck(ctx, at);
          assert.equal(frame.kind, writer.socketVerdict(ctx, at), `${label}: the frame verdict`);
        } else {
          assert.deepEqual(got, { kind: "refused", why: expected.why }, `${label} @${at - T0}`);
        }
      }
    }
    assert.equal(store.stats.commits, commitsBefore, "the verifier wrote nothing (and so did the writer's reads)");
  });

  test("a revocation the writer commits is seen at the very next question -- no copy is kept between two questions", async () => {
    const { writer, verifier } = await world();
    const ann = await profiled(writer, T0);
    const opened = await verifier.authenticate(ann.read, T0 + 1);
    assert.equal(opened.kind, "ok");
    if (opened.kind !== "ok") return;
    const ctx = { principalId: opened.principalId, sessionId: opened.sessionId, sessionExpiresAt: opened.sessionExpiresAt };
    assert.deepEqual(await verifier.recheck(ctx, T0 + 2), { kind: "ok", profiled: true });
    assert.equal(await writer.revoke(opened.sessionId, "logout", T0 + 3), true);
    assert.deepEqual(await verifier.recheck(ctx, T0 + 4), { kind: "revoked" }, "the socket is closed at its next frame");
    assert.deepEqual(await verifier.authenticate(ann.read, T0 + 4), { kind: "refused", why: "ended" });
    assert.deepEqual(await verifier.recheck(ctx, ctx.sessionExpiresAt), { kind: "expired" }, "the frozen expiry, first");
  });

  test("defence in depth, as the writer's: a revoked FAMILY ends an open member session, a disabled PRINCIPAL ends an open session -- at the upgrade and at a frame", async () => {
    /* Records the writer's own commits never leave (its revocations close every member too), but which its checks
       still refuse -- a grace successor a walk missed, a restored table. The verifier must refuse them the same way. */
    const { store, writer } = await world();
    const ann = await profiled(writer, T0, "Ann");
    const bob = await profiled(writer, T0 + 1, "Bob");
    const snapshot = store.snapshot();
    const sessionOf = (read: SessionCookieRead) => snapshot.sessions.find((record) => read.kind === "session" && record.session_id === read.sessionId) as Session;
    const annSession = sessionOf(ann.read);
    const bobSession = sessionOf(bob.read);
    const damagedLike = {
      ...snapshot,
      families: snapshot.families.map((family) => (family.family_id === annSession.family_id ? { ...family, revoked_at: T0 + 5, revoke_reason: "signed-out-remotely" as const } : family)),
      principals: snapshot.principals.map((principal) => (principal.principal_id === bobSession.principal_id ? { ...principal, status: "disabled" as const } : principal)),
    };
    const writerOver = IdentityService.fromSnapshot(createMemoryIdentityStore(damagedLike), damagedLike);
    const verifier = createSessionVerifier(snapshotRecordReader(damagedLike));
    for (const [label, read, session] of [["a revoked family", ann.read, annSession], ["a disabled principal", bob.read, bobSession]] as const) {
      assert.equal(writerOver.authenticate(read, T0 + 6).kind, "refused", `${label}: the writer refuses it`);
      assert.deepEqual(await verifier.authenticate(read, T0 + 6), { kind: "refused", why: "ended" }, `${label}: so does the verifier`);
      const ctx = { principalId: session.principal_id, sessionId: session.session_id, sessionExpiresAt: session.expires_at };
      assert.equal(writerOver.socketVerdict(ctx, T0 + 6), "revoked", `${label}: the writer's frame verdict`);
      assert.deepEqual(await verifier.recheck(ctx, T0 + 6), { kind: "revoked" }, `${label}: the verifier's`);
    }
  });

  test("fail closed: a failed read, damage, and records that disagree are `unavailable` -- never `ok`", async () => {
    const { store, writer } = await world();
    const ann = await profiled(writer, T0);
    const snapshot = store.snapshot();
    const session = snapshot.sessions[0] as Session;
    const principal = snapshot.principals[0] as Principal;
    const family = snapshot.families[0] as SessionFamily;
    const profile = snapshot.profiles[0] as Profile;
    const ctx = { principalId: principal.principal_id, sessionId: session.session_id, sessionExpiresAt: session.expires_at };
    const verifierOver = (over: Partial<IdentityRecordReader>) => createSessionVerifier({ ...snapshotRecordReader(snapshot), ...over });
    const cases: Array<[string, Partial<IdentityRecordReader>]> = [
      ["the session read fails", { session: async () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })) }],
      ["the session is damaged", { session: async () => Promise.reject(new IdentityRecordUnreadableError("identity table: a session item is not a well-formed session record")) }],
      ["the principal read fails", { principal: async () => Promise.reject(new Error("throttled")) }],
      ["the session's principal is missing", { principal: async () => null }],
      ["the session's family is missing", { family: async () => null }],
      ["the family belongs to another principal", { family: async () => ({ ...family, principal_id: "pr_" + "B".repeat(26) }) }],
      ["the profiled principal's profile is missing", { profile: async () => null }],
      ["the profile names another principal", { profile: async () => ({ ...profile, principal_id: "pr_" + "C".repeat(26) }) }],
      ["the profile read fails", { profile: async () => Promise.reject(new Error("AccessDenied")) }],
    ];
    for (const [label, over] of cases) {
      const verifier = verifierOver(over);
      const auth = await verifier.authenticate(ann.read, T0 + 1);
      assert.equal(auth.kind, "unavailable", `${label}: the upgrade (${JSON.stringify(auth)})`);
      const frame = await verifier.recheck(ctx, T0 + 1);
      assert.equal(frame.kind, "unavailable", `${label}: the frame (${JSON.stringify(frame)})`);
      /* The detail names a record class or a failure, never an id or a secret. */
      const detail = (auth as { detail: string }).detail;
      assert.doesNotMatch(detail, /se_|pr_|pf_|sf_/);
    }
    /* A session gone from the records at a frame's re-check is not `ok` either. */
    assert.equal((await verifierOver({ session: async () => null }).recheck(ctx, T0 + 1)).kind, "unavailable");
  });

  test("it never writes and reads the least it can: one read for a cookie whose secret does not match; the port has no write", async () => {
    const { store, writer, verifier, reads } = await world();
    const ann = await profiled(writer, T0);
    const bob = await profiled(writer, T0 + 1, "Bob");
    const commits = store.stats.commits;
    reads.length = 0;
    const forged: SessionCookieRead = ann.read.kind === "session" && bob.read.kind === "session" ? { kind: "session", sessionId: ann.read.sessionId, secret: bob.read.secret } : ann.read;
    assert.deepEqual(await verifier.authenticate(forged, T0 + 2), { kind: "refused", why: "unknown" });
    assert.deepEqual(reads, ["session"], "a wrong secret costs one read and reveals nothing");
    reads.length = 0;
    assert.equal((await verifier.authenticate(ann.read, T0 + 2)).kind, "ok");
    assert.deepEqual([...reads].sort(), ["family", "principal", "profile", "session"]);
    assert.deepEqual(Object.keys(verifier).sort(), ["authenticate", "recheck"], "the verifier's whole surface: two questions, no write");
    assert.equal(store.stats.commits, commits);
  });
});
