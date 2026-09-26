// server/src/identity/identityUnits.test.ts
//
// LIVE-2B: the identity layer's pure parts, as hostile input -- ids, the cookie reader, the stores, the session
// service (expiry, rotation, grace, eviction, activation, write-behind), Origin, client IP, the development
// authenticator, the mode lock and the keyed limiters. The HTTP/WebSocket behaviour is `live2bIdentity.test.ts`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { IpBuckets, KeyedBuckets, MalformedCooldowns } from "../ingress/limits";
import { clearedSessionCookie, readSessionCookie, sessionSetCookie, SESSION_COOKIE_NAME } from "./cookies";
import { clientIpOf, ipKeyOf } from "./clientIp";
import { createDevAuthenticator, devClaimOf, isLoopbackAddress } from "./devAuthenticator";
import { createFileIdentityStore, IDENTITY_FILE } from "./fileStore";
import {
  base32Lower,
  canonicalLinkCode,
  linkCodeHash,
  mintLinkCode,
  mintPrincipalId,
  mintProfileId,
  mintRecoveryKey,
  mintSecret,
  mintSessionId,
  mintUnique,
  parseRecoveryKey,
  PRINCIPAL_ID_PATTERN,
  PROFILE_ID_PATTERN,
  RECOVERY_KEY_PATTERN,
  RECOVERY_SELECTOR_PATTERN,
  secretBytes,
  secretHash,
  secretMatches,
  SESSION_ID_PATTERN,
} from "./ids";
import { resolveServerConfig } from "./mode";
import { isLoopbackHostHeader, originAllowed, parseAllowedOrigins } from "./origins";
import { IdentityService } from "./sessions";
import { createMemoryIdentityStore, IdentityStoreCorruptError } from "./store";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_750_000_000_000;

/** The cookie a Set-Cookie delivers, as the browser would send it back. */
const cookieOf = (setCookie: string | null): string => {
  assert.ok(setCookie, "a Set-Cookie");
  return setCookie.split(";")[0];
};
const readOf = (setCookie: string | null) => readSessionCookie(cookieOf(setCookie));

async function service(policy = {}, store = createMemoryIdentityStore()) {
  const ended: string[][] = [];
  const identity = await IdentityService.open(store, { policy, hooks: { onSessionsEnded: (ids) => ended.push([...ids]) } });
  return { identity, store, ended };
}

describe("LIVE-2B ids", () => {
  test("principal and session ids: pr_/se_ + 26 canonical lowercase Crockford symbols of 16 random bytes", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 2000; n += 1) {
      const principal = mintPrincipalId();
      const session = mintSessionId();
      assert.match(principal, PRINCIPAL_ID_PATTERN);
      assert.match(session, SESSION_ID_PATTERN);
      assert.equal(principal.length, 29);
      seen.add(principal).add(session);
    }
    assert.equal(seen.size, 4000, "no collision in 4,000 mints");
    assert.equal(base32Lower(Buffer.alloc(16, 0xff)), `${"z".repeat(25)}w`, "the two pad bits are zero");
    assert.equal(base32Lower(Buffer.alloc(16, 0)), "0".repeat(26));
    for (const bad of [`pr_${"z".repeat(26)}`, `pr_${"Z".repeat(25)}w`, `pr_${"0".repeat(25)}`, `pr_${"i".repeat(25)}0`, `se_${"0".repeat(27)}`]) {
      assert.ok(!PRINCIPAL_ID_PATTERN.test(bad) && !SESSION_ID_PATTERN.test(bad), bad);
    }
  });

  test("the secret is 32 random bytes, 43 canonical base64url symbols; only its SHA-256 is kept, compared in constant time", () => {
    const secret = mintSecret();
    assert.equal(secret.length, 43);
    assert.equal(secretBytes(secret)?.length, 32);
    const hash = secretHash(secret);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(!hash.includes(secret));
    assert.equal(secretMatches(secret, hash), true);
    assert.equal(secretMatches(mintSecret(), hash), false);
    // Non-canonical spellings of 32 bytes: pad bits set, padding, standard base64, wrong lengths.
    const padBitsSet = `${secret.slice(0, 42)}${secret[42] === "B" ? "C" : "B"}`;
    for (const bad of [padBitsSet, `${secret}=`, secret.slice(0, 42), `${secret}A`, secret.replace(/-/g, "+").replace(/_/g, "/") + (secret.includes("-") || secret.includes("_") ? "" : "+")]) {
      if (bad === secret) continue;
      assert.equal(secretBytes(bad), null, bad);
      assert.equal(secretMatches(bad, hash), false);
    }
    const source = fs.readFileSync(path.join(__dirname, "ids.js"), "utf8");
    assert.match(source, /timingSafeEqual\)\(digest|timingSafeEqual\(digest/, "the verifier compares digests with crypto.timingSafeEqual");
  });

  test("collision handling: a colliding mint is retried, and a random source that keeps colliding is refused", () => {
    const taken = new Set([mintPrincipalId(() => Buffer.alloc(16, 1))]);
    let calls = 0;
    const flaky = (size: number) => (calls++ === 0 ? Buffer.alloc(size, 1) : Buffer.alloc(size, 2));
    const id = mintUnique(() => mintPrincipalId(flaky), (candidate) => taken.has(candidate));
    assert.notEqual(id, [...taken][0]);
    assert.throws(() => mintUnique(() => mintPrincipalId(() => Buffer.alloc(16, 1)), (candidate) => taken.has(candidate)), /not random/);
  });
});

describe("LIVE-2E profile ids, recovery keys and link codes", () => {
  test("a profile id is pf_ + 26 canonical symbols; a recovery key is rk_<selector>.<secret>, parsed only in its canonical spelling", () => {
    assert.match(mintProfileId(), PROFILE_ID_PATTERN);
    const { selector, secret, key } = mintRecoveryKey();
    assert.match(selector, RECOVERY_SELECTOR_PATTERN);
    assert.match(key, RECOVERY_KEY_PATTERN);
    assert.equal(key, `${selector}.${secret}`);
    assert.equal(secretBytes(secret)?.length, 32, "a 256-bit secret, the session cookie's shape");
    assert.deepEqual(parseRecoveryKey(` \n${key}\t `), { selector, secret }, "surrounding whitespace is forgiven");
    const padBitsSet = `${secret.slice(0, 42)}${secret[42] === "B" ? "C" : "B"}`;
    for (const bad of [key.toUpperCase(), `${key}=`, `${key}x`, key.replace(".", ":"), `${selector}.${secret.slice(1)}`, `${selector}.${padBitsSet}`, selector, `pr_${key.slice(3)}`, "", `${" ".repeat(170)}${key}`, 42, null]) {
      assert.equal(parseRecoveryKey(bad), null, String(bad));
    }
  });

  test("a link code: 20 Crockford symbols shown as five groups of four; case, spaces, hyphens and look-alikes forgiven; kept only as a domain-separated digest", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 200; n += 1) {
      const { canonical, display } = mintLinkCode();
      assert.match(canonical, /^[0-9A-HJKMNP-TV-Z]{20}$/);
      assert.match(display, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
      assert.equal(display.replace(/-/g, ""), canonical);
      assert.equal(canonicalLinkCode(display.toLowerCase()), canonical);
      assert.equal(canonicalLinkCode(` ${(canonical.match(/.{5}/g) as string[]).join(" ")} `), canonical);
      seen.add(canonical);
    }
    assert.equal(seen.size, 200);
    assert.equal(canonicalLinkCode("iiii-llll-oooo-0000-1111"), "11111111000000001111", "I and L are 1, O is 0");
    for (const bad of ["", "ABCD-EFGH", "ABCD-EFGH-JKMN-PQRS-TVWXY", "UUUU-UUUU-UUUU-UUUU-UUUU", "ABCD_EFGH_JKMN_PQRS_TVWX", "A".repeat(65), 7, null]) {
      assert.equal(canonicalLinkCode(bad), null, String(bad));
    }
    const code = mintLinkCode().canonical;
    assert.match(linkCodeHash(code), /^[0-9a-f]{64}$/);
    assert.notEqual(linkCodeHash(code), createHash("sha256").update(code).digest("hex"), "domain-separated from a bare SHA-256");
    assert.notEqual(linkCodeHash(code), linkCodeHash(mintLinkCode().canonical));
  });
});

describe("LIVE-2B cookie", () => {
  const sessionId = mintSessionId();
  const secret = mintSecret();
  const value = `v1.${sessionId}.${secret}`;

  test("the Set-Cookie is exactly the frozen one: __Host-, Path=/, Secure, HttpOnly, SameSite=Strict, 180 days, no Domain", () => {
    assert.equal(sessionSetCookie(sessionId, secret), `__Host-gs_session=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000`);
    assert.ok(!/domain/i.test(sessionSetCookie(sessionId, secret)));
    assert.equal(clearedSessionCookie(), "__Host-gs_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0");
  });

  test("the reader: one well-formed cookie reads; every ambiguity fails closed", () => {
    assert.deepEqual(readSessionCookie(undefined), { kind: "none" });
    assert.deepEqual(readSessionCookie("theme=dark; other=1"), { kind: "none" });
    assert.deepEqual(readSessionCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${value}; x=y`), { kind: "session", sessionId, secret });
    const problem = (header: string | string[]) => {
      const read = readSessionCookie(header);
      return read.kind === "malformed" ? read.problem : read.kind;
    };
    assert.equal(problem(`${SESSION_COOKIE_NAME}=${value}; ${SESSION_COOKIE_NAME}=${value}`), "duplicate");
    assert.equal(problem([`${SESSION_COOKIE_NAME}=${value}`, `${SESSION_COOKIE_NAME}=${value}`]), "duplicate");
    assert.equal(problem(`a=${"x".repeat(9000)}; ${SESSION_COOKIE_NAME}=${value}`), "oversized");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=v2.${sessionId}.${secret}`), "version");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=${sessionId}.${secret}`), "version");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=v1.se_short.${secret}`), "selector");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=v1.${sessionId.toUpperCase().replace("SE_", "se_")}.${secret}`), "selector");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=v1.${sessionId}.${secret.slice(1)}`), "secret");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=v1.${sessionId}.${secret}A`), "secret");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=v1.${sessionId}.${secret}.extra`), "secret");
    assert.equal(problem(`${SESSION_COOKIE_NAME}="${value}"`), "encoding");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=v1.${sessionId}.${secret.slice(0, 40)}%41%41%41`), "encoding");
    assert.equal(problem(`${SESSION_COOKIE_NAME}=`), "encoding");
    assert.equal(problem(`__host-gs_session=${value}`), "ambiguous-name");
    assert.equal(problem(`__Host-gs%5Fsession=${value}`), "ambiguous-name");
  });
});

describe("LIVE-2B sessions (the service, on a stepped clock)", () => {
  test("a bootstrap with no cookie mints a provisional guest in memory only -- no store write", async () => {
    const { identity, store } = await service();
    const outcome = await identity.bootstrap({ kind: "none" }, false, T0);
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.kind === "ok" && outcome.created, true);
    assert.equal(store.stats.commits, 0);
    assert.deepEqual(store.snapshot(), { principals: [], sessions: [], profiles: [], links: [] });
    // LIVE-2E: the principal a bootstrap mints is UNPROFILED -- it may reach the profile gate and nothing else.
    const auth = identity.authenticate(readOf(outcome.kind === "ok" ? outcome.setCookie : null), T0);
    assert.ok(auth.kind === "ok");
    assert.equal(identity.peekPrincipal(auth.principalId)?.kind, "unprofiled");
    assert.equal(identity.peekPrincipal(auth.principalId)?.account_link, null);
    assert.equal(identity.isProfiled(auth.principalId), false);
  });

  test("idle expiry at 30 days; the write-behind slides it, at most once per 15 minutes", async () => {
    const { identity, store } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    // `classify` reads without using: an unused session is still good a millisecond before 30 days...
    assert.equal(identity.classify(read, false, T0 + 30 * DAY - 1).kind, "existing");
    // ...and ended at 30 days: no socket, and the bootstrap says `expired`.
    assert.equal(identity.authenticate(read, T0 + 30 * DAY).kind, "refused");
    assert.deepEqual(identity.classify(read, false, T0 + 30 * DAY), { kind: "ended", reason: "expired" });
    // Activated, then used at day 20: the idle window slides to day 50, with one write behind.
    const second = await service();
    const b = await second.identity.bootstrap({ kind: "none" }, false, T0);
    const bread = readOf(b.kind === "ok" ? b.setCookie : null);
    const auth = second.identity.authenticate(bread, T0);
    assert.equal(auth.kind, "ok");
    await second.identity.activate(auth.kind === "ok" ? auth.principalId : "", T0);
    const commitsAfterActivation = second.store.stats.commits;
    assert.equal(second.identity.authenticate(bread, T0 + 10 * 60 * 1000).kind, "ok", "inside 15 minutes: nothing to write");
    await second.identity.sweep(T0 + 10 * 60 * 1000);
    assert.equal(second.store.stats.commits, commitsAfterActivation, "no write inside 15 minutes");
    assert.equal(second.identity.authenticate(bread, T0 + 20 * DAY).kind, "ok");
    await second.identity.sweep(T0 + 20 * DAY);
    assert.equal(second.store.stats.commits, commitsAfterActivation + 1, "one write-behind");
    assert.equal(second.identity.authenticate(bread, T0 + 49 * DAY).kind, "ok", "slid to day 50");
    void store;
  });

  test("absolute expiry at 180 days, however often the session is used", async () => {
    const { identity } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    for (let day = 20; day < 180; day += 20) assert.equal(identity.authenticate(read, T0 + day * DAY).kind, "ok", `day ${day}`);
    assert.equal(identity.authenticate(read, T0 + 180 * DAY).kind, "refused");
  });

  test("rotation only when older than 7 days; the successor keeps the principal; the old one retires `rotated` with rotated_to", async () => {
    const { identity } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    const principal = (identity.authenticate(read, T0) as { principalId: string }).principalId;
    const early = await identity.bootstrap(read, false, T0 + 7 * DAY);
    assert.equal(early.kind === "ok" && early.rotated, false, "exactly 7 days: no rotation");
    assert.equal(early.kind === "ok" && early.setCookie, null);
    const rotated = await identity.bootstrap(read, false, T0 + 7 * DAY + 1);
    assert.ok(rotated.kind === "ok" && rotated.rotated && rotated.setCookie);
    const next = readOf(rotated.kind === "ok" ? rotated.setCookie : null);
    const old = identity.peekSession(read.kind === "session" ? read.sessionId : "");
    assert.equal(old?.revoke_reason, "rotated");
    assert.equal(old?.rotated_to, next.kind === "session" ? next.sessionId : "?");
    const auth = identity.authenticate(next, T0 + 7 * DAY + 2);
    assert.equal(auth.kind === "ok" && auth.principalId, principal, "same principal");
    assert.equal(identity.authenticate(read, T0 + 7 * DAY + 2).kind, "refused", "a rotated session opens no socket");
  });

  test("the 24-hour grace: a rotated cookie still bootstraps (same principal) -- concurrent tabs and a lost Set-Cookie -- then ends", async () => {
    const { identity } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    const principal = (identity.authenticate(read, T0) as { principalId: string }).principalId;
    const at = T0 + 8 * DAY;
    // Two tabs at once, both presenting the week-old cookie.
    const [a, b] = await Promise.all([identity.bootstrap(read, false, at), identity.bootstrap(read, false, at)]);
    for (const outcome of [a, b]) {
      assert.ok(outcome.kind === "ok" && outcome.setCookie, "both tabs get a cookie");
      const auth = identity.authenticate(readOf(outcome.kind === "ok" ? outcome.setCookie : null), at);
      assert.equal(auth.kind === "ok" && auth.principalId, principal, "both on the same principal");
    }
    // A lost Set-Cookie: the old cookie again, 23 hours later.
    const lost = await identity.bootstrap(read, false, at + 23 * 60 * 60 * 1000);
    assert.equal(lost.kind === "ok" && (identity.authenticate(readOf(lost.setCookie), at + 23 * 60 * 60 * 1000) as { principalId: string }).principalId, principal);
    // Past 24 hours: ended, never a new principal.
    const sizes = identity.sizes().principals;
    assert.deepEqual(await identity.bootstrap(read, false, at + DAY), { kind: "ended", reason: "rotated" });
    assert.equal(identity.sizes().principals, sizes);
  });

  test("a KNOWN ended session never becomes a new guest; the wrong secret is ended too; only `fresh` mints", async () => {
    const { identity } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    const before = identity.sizes().principals;
    assert.deepEqual(await identity.bootstrap(read, false, T0 + 31 * DAY), { kind: "ended", reason: "expired" });
    const forged = read.kind === "session" ? { ...read, secret: mintSecret() } : read;
    assert.deepEqual(await identity.bootstrap(forged, false, T0), { kind: "ended", reason: "unreadable" });
    assert.deepEqual(await identity.bootstrap({ kind: "malformed", problem: "duplicate" }, false, T0), { kind: "ended", reason: "unreadable" });
    assert.equal(identity.sizes().principals, before, "nothing minted");
    const sessionId = read.kind === "session" ? read.sessionId : "";
    await identity.revoke(sessionId, "logout", T0 + 1);
    assert.deepEqual(await identity.bootstrap(read, false, T0 + 2), { kind: "ended", reason: "logout" });
    const fresh = await identity.bootstrap(read, true, T0 + 3);
    assert.equal(fresh.kind === "ok" && fresh.created, true, "the explicit new-guest path");
    assert.equal(identity.sizes().principals, before + 1);
    // An unknown selector (a restart forgot a guest who owned nothing) is a new guest -- the design's rule.
    const unknown = await identity.bootstrap({ kind: "session", sessionId: mintSessionId(), secret: mintSecret() }, false, T0);
    assert.equal(unknown.kind === "ok" && unknown.created, true);
  });

  test("at most 10 active sessions per principal: the 11th evicts the oldest, whose sockets are told", async () => {
    const { identity, ended } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const s0 = readOf(created.kind === "ok" ? created.setCookie : null);
    const at = T0 + 8 * DAY;
    const minted: string[] = [];
    for (let n = 0; n < 11; n += 1) {
      const outcome = await identity.bootstrap(s0, false, at + n);
      const next = readOf(outcome.kind === "ok" ? outcome.setCookie : null);
      minted.push(next.kind === "session" ? next.sessionId : "");
    }
    assert.deepEqual(ended, [[minted[0]]], "the oldest successor was evicted");
    assert.equal(identity.peekSession(minted[0])?.revoke_reason, "evicted");
    assert.equal(identity.socketVerdict({ principalId: "x", sessionId: minted[0], sessionExpiresAt: at + DAY }, at + 20), "revoked");
    assert.equal(identity.peekSession(minted[10])?.revoke_reason, null);
  });

  test("provisional guests are an LRU bounded in memory: the least recently used is forgotten, never written", async () => {
    const { identity, store } = await service({ provisionalLimit: 3 });
    const reads = [];
    for (let n = 0; n < 5; n += 1) {
      const outcome = await identity.bootstrap({ kind: "none" }, false, T0 + n);
      reads.push(readOf(outcome.kind === "ok" ? outcome.setCookie : null));
    }
    assert.equal(identity.sizes().provisional, 3);
    assert.equal(identity.authenticate(reads[0], T0 + 10).kind, "refused", "the oldest guest is forgotten");
    assert.equal(identity.authenticate(reads[4], T0 + 10).kind, "ok");
    assert.equal(store.stats.commits, 0);
  });

  test("activation makes a guest durable -- principal and sessions -- idempotently; a failed store refuses it and changes nothing", async () => {
    const { identity, store } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    const principalId = (identity.authenticate(read, T0) as { principalId: string }).principalId;
    store.failNext.push("definite");
    await assert.rejects(identity.activate(principalId, T0), /nothing written/);
    assert.equal(identity.isProvisional(principalId), true, "still provisional");
    assert.equal(identity.stats.storeFailures, 1);
    await identity.activate(principalId, T0 + 1);
    await identity.activate(principalId, T0 + 2);
    assert.equal(identity.isProvisional(principalId), false);
    const snapshot = store.snapshot();
    assert.equal(snapshot.principals.length, 1);
    assert.equal(snapshot.principals[0].activated_at, T0 + 1);
    assert.equal(snapshot.sessions.length, 1);
    assert.ok(!JSON.stringify(snapshot).includes(read.kind === "session" ? read.secret : "?"), "no secret stored");
    assert.deepEqual(Object.keys(snapshot.principals[0]).sort(), ["account_link", "activated_at", "created_at", "kind", "last_seen_at", "principal_id", "status"]);
    // Development principals are synthetic: activation is a no-op, never a write.
    const commits = store.stats.commits;
    await identity.activate("pr_dev_alice", T0);
    assert.equal(store.stats.commits, commits);
  });

  test("revocation of a durable session is written first: a store failure leaves it valid (no half-revoke), and a restart keeps a revoke", async () => {
    const { identity, store, ended } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    const auth = identity.authenticate(read, T0) as { principalId: string; sessionId: string };
    await identity.activate(auth.principalId, T0);
    store.failNext.push("definite");
    await assert.rejects(identity.revoke(auth.sessionId, "logout", T0 + 1));
    assert.equal(identity.authenticate(read, T0 + 2).kind, "ok", "not revoked in memory either");
    assert.deepEqual(ended, []);
    await identity.revoke(auth.sessionId, "logout", T0 + 3);
    assert.deepEqual(ended, [[auth.sessionId]]);
    const restarted = await IdentityService.open(store);
    assert.deepEqual(await restarted.bootstrap(read, false, T0 + 4), { kind: "ended", reason: "logout" }, "no resurrection");
  });

  test("operator disable: every session ends `principal-disabled`, sockets are told, bootstrap answers session-ended", async () => {
    const { identity, ended } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    const auth = identity.authenticate(read, T0) as { principalId: string; sessionId: string; sessionExpiresAt: number };
    await identity.disablePrincipal(auth.principalId, T0 + 1);
    assert.deepEqual(ended, [[auth.sessionId]]);
    assert.equal(identity.socketVerdict(auth, T0 + 2), "revoked");
    assert.deepEqual(await identity.bootstrap(read, false, T0 + 2), { kind: "ended", reason: "principal-disabled" });
  });

  test("ended sessions are kept until no browser can still hold their cookie, then collected", async () => {
    const { identity } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    await identity.sweep(T0 + 100 * DAY);
    assert.deepEqual(identity.classify(read, false, T0 + 100 * DAY), { kind: "ended", reason: "expired" }, "still known at day 100");
    await identity.sweep(T0 + 182 * DAY);
    assert.equal(identity.sizes().sessions, 0, "collected after the cookie's 180 days");
  });

  test("LIVE-2E: createProfile binds THIS principal -- principal, sessions and profile in one commit; a refused commit changes nothing", async () => {
    const { identity, store } = await service();
    const created = await identity.bootstrap({ kind: "none" }, false, T0);
    const read = readOf(created.kind === "ok" ? created.setCookie : null);
    const principalId = (identity.authenticate(read, T0) as { principalId: string }).principalId;
    assert.deepEqual(await identity.createProfile(read, " padded", T0), { kind: "bad-name" }, "the service takes only a cleaned name");
    store.failNext.push("definite");
    assert.deepEqual(await identity.createProfile(read, "Ann", T0), { kind: "unavailable" });
    assert.equal(identity.isProvisional(principalId), true, "still provisional");
    assert.equal(identity.isProfiled(principalId), false);
    assert.equal(store.stats.commits, 0);
    assert.equal((await identity.createProfile(read, "Ann", T0 + 1)).kind, "ok");
    assert.equal(store.stats.commits, 1, "ONE commit");
    const snapshot = store.snapshot();
    assert.deepEqual([snapshot.principals.length, snapshot.sessions.length, snapshot.profiles.length], [1, 1, 1]);
    assert.equal(snapshot.principals[0].principal_id, principalId, "the browser's own principal -- never a new one");
    assert.equal(snapshot.principals[0].activated_at, T0 + 1);
    assert.equal(identity.isProvisional(principalId), false);
    assert.equal(identity.profileName(principalId), "Ann");
    assert.deepEqual(identity.accountView(principalId, read.kind === "session" ? read.sessionId : "", T0 + 1), { name: "Ann", otherSessions: 0 });
    assert.deepEqual(await identity.createProfile(read, "Other", T0 + 2), { kind: "already-profiled", name: "Ann" });
    assert.deepEqual(await identity.createProfile({ kind: "none" }, "Ann", T0), { kind: "not-authenticated" });
    assert.equal(store.stats.commits, 1);
  });
});

describe("LIVE-2B file store", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "live2b-identity-"));

  test("activated identity survives a restart; a provisional one does not; the file never holds a secret", async () => {
    const dir = tmp();
    try {
      const first = await IdentityService.open(createFileIdentityStore(dir));
      const kept = await first.bootstrap({ kind: "none" }, false, T0);
      const forgotten = await first.bootstrap({ kind: "none" }, false, T0);
      const keptRead = readOf(kept.kind === "ok" ? kept.setCookie : null);
      const forgottenRead = readOf(forgotten.kind === "ok" ? forgotten.setCookie : null);
      await first.activate((first.authenticate(keptRead, T0) as { principalId: string }).principalId, T0);
      const text = fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8");
      assert.ok(keptRead.kind === "session" && !text.includes(keptRead.secret), "no secret in the file");
      assert.ok(forgottenRead.kind === "session" && !text.includes(forgottenRead.sessionId), "no provisional guest in the file");
      const second = await IdentityService.open(createFileIdentityStore(dir));
      assert.equal(second.authenticate(keptRead, T0 + 1).kind, "ok", "the activated guest's session holds");
      const again = await second.bootstrap(forgottenRead, false, T0 + 1);
      assert.equal(again.kind === "ok" && again.created, true, "a forgotten guest is a new one (it owned nothing)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("failures surface: before the rename nothing changes; an unsettled rename is redone once, then the store holds itself", async () => {
    const dir = tmp();
    try {
      const faults = { failOpen: 0, failRename: 0 };
      const io: StoreFs = {
        ...nodeStoreFs,
        open: (file, flags) => (flags === "wx" && faults.failOpen-- > 0 ? Promise.reject(new Error("injected ENOSPC")) : nodeStoreFs.open(file, flags)),
        rename: (from, to) => (faults.failRename-- > 0 ? Promise.reject(new Error("injected EIO")) : nodeStoreFs.rename(from, to)),
      };
      const restarts: string[] = [];
      const store = createFileIdentityStore(dir, { fs: io, warn: () => undefined, onRestartRequired: (detail) => restarts.push(detail) });
      const identity = await IdentityService.open(store);
      const created = await identity.bootstrap({ kind: "none" }, false, T0);
      const principalId = (identity.authenticate(readOf(created.kind === "ok" ? created.setCookie : null), T0) as { principalId: string }).principalId;
      faults.failOpen = 1;
      await assert.rejects(identity.activate(principalId, T0), (error: Error) => error.name === "StoreDefiniteError");
      assert.equal(identity.isProvisional(principalId), true);
      faults.failRename = 1; // the first attempt is uncertain; the redo lands
      await identity.activate(principalId, T0);
      assert.equal(store.stats.redone, 1);
      assert.equal(identity.isProvisional(principalId), false);
      const other = await identity.bootstrap({ kind: "none" }, false, T0);
      const otherId = (identity.authenticate(readOf(other.kind === "ok" ? other.setCookie : null), T0) as { principalId: string }).principalId;
      faults.failRename = 2; // the redo fails too: unknown outcome, restart required
      await assert.rejects(identity.activate(otherId, T0), (error: Error) => error.name === "StoreUncertainError");
      assert.equal(restarts.length, 1);
      await assert.rejects(identity.activate(otherId, T0), /held after an unresolved write/);
      assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), "no temporary left behind");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that is not exactly the format refuses to load", async () => {
    const dir = tmp();
    try {
      for (const bad of ["{", "[]", '{"format":"gs-identity","version":2,"principals":[],"sessions":[]}', '{"format":"gs-identity","version":1,"principals":[{"principal_id":"x"}],"sessions":[]}']) {
        fs.writeFileSync(path.join(dir, IDENTITY_FILE), bad);
        await assert.rejects(createFileIdentityStore(dir).load(), (error: Error) => error instanceof IdentityStoreCorruptError);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LIVE-2B Origin", () => {
  test("the allow-list is exact origins only", () => {
    assert.deepEqual(parseAllowedOrigins("https://play.example, https://play.example:8443"), { ok: true, origins: ["https://play.example", "https://play.example:8443"] });
    for (const bad of ["https://play.example/", "https://Play.example", "https://play.example:443", "https://*.example", "null", "https://play.example/path", "ftp://play.example", "play.example", "https://a.example,,https://b.example"]) {
      assert.equal(parseAllowedOrigins(bad).ok, false, bad);
    }
    const allowed = new Set(["https://play.example"]);
    assert.equal(originAllowed("https://play.example", allowed), true);
    for (const bad of [undefined, "null", "https://play.example/", "https://PLAY.example", "https://play.example:444", "http://play.example", "https://evil.example", ["https://play.example", "https://play.example"]]) {
      assert.equal(originAllowed(bad as string | string[] | undefined, allowed), false, String(bad));
    }
  });
});

describe("LIVE-2B trusted client IP", () => {
  const request = (remoteAddress: string, xff?: string | string[]) => ({
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    socket: { remoteAddress } as never,
  });

  test("hops 0 / 1 / 2; spoofed left entries ignored; too few or malformed trusted entries fail closed", () => {
    assert.deepEqual(clientIpOf(request("203.0.113.9", "1.1.1.1"), 0), { ok: true, ip: { key: "v4:203.0.113.9", aggregate: null } });
    assert.deepEqual(clientIpOf(request("127.0.0.1", "6.6.6.6, 198.51.100.7"), 1), { ok: true, ip: { key: "v4:198.51.100.7", aggregate: null } });
    assert.deepEqual(clientIpOf(request("127.0.0.1", "6.6.6.6, 198.51.100.7, 10.0.0.2"), 2), { ok: true, ip: { key: "v4:198.51.100.7", aggregate: null } });
    assert.deepEqual(clientIpOf(request("127.0.0.1", ["garbage, 6.6.6.6", "198.51.100.7"]), 1), { ok: true, ip: { key: "v4:198.51.100.7", aggregate: null } });
    assert.equal(clientIpOf(request("127.0.0.1"), 1).ok, false);
    assert.equal(clientIpOf(request("127.0.0.1", "198.51.100.7"), 2).ok, false);
    assert.equal(clientIpOf(request("127.0.0.1", "1.1.1.1, not-an-ip"), 1).ok, false);
    assert.equal(clientIpOf(request("127.0.0.1", "1.1.1.1, "), 1).ok, false);
  });

  test("IPv4 /32; IPv6 /64 with its /48 aggregate; mapped and zoned forms normalized", () => {
    assert.deepEqual(ipKeyOf("192.0.2.1"), { key: "v4:192.0.2.1", aggregate: null });
    assert.deepEqual(ipKeyOf("::ffff:192.0.2.1"), { key: "v4:192.0.2.1", aggregate: null });
    assert.deepEqual(ipKeyOf("2001:db8:1:2:aaaa::1"), { key: "v6:2001:0db8:0001:0002/64", aggregate: "v6:2001:0db8:0001/48" });
    assert.equal(ipKeyOf("2001:DB8:1:2:ffff:ffff:ffff:ffff")?.key, "v6:2001:0db8:0001:0002/64", "same /64, same key");
    assert.equal(ipKeyOf("fe80::1%eth0")?.key, "v6:fe80:0000:0000:0000/64");
    assert.equal(ipKeyOf("not-an-ip"), null);
    assert.equal(ipKeyOf(""), null);
  });
});

describe("LIVE-2B development authenticator", () => {
  const config = { allowedOrigins: ["http://localhost:3000"], trustedProxyHops: 0 };
  const req = (over: { headers?: Record<string, string>; remoteAddress?: string; url?: string } = {}) => ({
    headers: { origin: "http://localhost:3000", host: "127.0.0.1:8917", ...(over.headers ?? {}) },
    socket: { remoteAddress: over.remoteAddress ?? "127.0.0.1" } as never,
    url: over.url ?? "/?dev_claim=p-alice",
  });
  const withMode = <T>(mode: string | undefined, body: () => T): T => {
    const previous = process.env.GS_MODE;
    if (mode === undefined) delete process.env.GS_MODE;
    else process.env.GS_MODE = mode;
    try {
      return body();
    } finally {
      if (previous === undefined) delete process.env.GS_MODE;
      else process.env.GS_MODE = previous;
    }
  };

  test("constructed only while GS_MODE is development, at call time", () => {
    assert.throws(() => withMode("production", () => createDevAuthenticator()), /refused/);
    assert.throws(() => withMode(undefined, () => createDevAuthenticator()), /refused/);
    assert.throws(() => withMode("Development", () => createDevAuthenticator()), /refused/);
    assert.equal(withMode("development", () => createDevAuthenticator()).kind, "development");
  });

  test("every loopback condition is required; each forwarding header refuses on its own; the claim maps to pr_dev_<claim>", () => {
    const dev = withMode("development", () => createDevAuthenticator());
    const ok = dev.authenticate(req(), config, T0);
    assert.deepEqual(ok, { kind: "ok", principalId: "pr_dev_p-alice", sessionId: "se_dev_p-alice", sessionExpiresAt: T0 + 180 * DAY });
    assert.equal(devClaimOf("pr_dev_p-alice"), "p-alice");
    assert.equal(devClaimOf(mintPrincipalId()), null);
    const status = (result: ReturnType<typeof dev.authenticate>) => (result.kind === "ok" ? 101 : result.status);
    for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]) {
      assert.equal(status(dev.authenticate(req({ headers: { [header]: "127.0.0.1" } }), config, T0)), 403, header);
      assert.equal(status(dev.authenticate(req({ headers: { [header]: "" } }), config, T0)), 403, `${header} (empty)`);
    }
    assert.equal(status(dev.authenticate(req({ remoteAddress: "192.168.1.20" }), config, T0)), 403, "remote peer");
    assert.equal(status(dev.authenticate(req({ remoteAddress: "::ffff:10.0.0.1" }), config, T0)), 403, "remote mapped peer");
    assert.equal(status(dev.authenticate(req({ remoteAddress: "::1" }), config, T0)), 101, "IPv6 loopback peer");
    assert.equal(status(dev.authenticate(req({ headers: { host: "abc.ngrok.app" } }), config, T0)), 403, "tunnel Host");
    assert.equal(status(dev.authenticate(req({ headers: { host: "evil.example@127.0.0.1" } }), config, T0)), 403, "userinfo Host");
    assert.equal(status(dev.authenticate(req({ headers: { origin: "https://abc.ngrok.app" } }), config, T0)), 403, "tunnel Origin");
    assert.equal(status(dev.authenticate(req(), { ...config, trustedProxyHops: 1 }, T0)), 403, "proxy hops");
    assert.equal(status(dev.authenticate(req(), { ...config, allowedOrigins: ["http://localhost:3000", "https://abc.ngrok.app"] }, T0)), 403, "a remote allowed origin");
    assert.equal(status(dev.authenticate(req({ url: "/" }), config, T0)), 401, "no claim");
    assert.equal(status(dev.authenticate(req({ url: "/?dev_claim=a.b" }), config, T0)), 401, "bad claim");
    assert.equal(status(dev.authenticate(req({ url: `/?dev_claim=${"a".repeat(33)}` }), config, T0)), 401, "long claim");
    assert.equal(status(dev.authenticate(req({ url: "/?dev_claim=a&dev_claim=b" }), config, T0)), 401, "two claims");
    // The simulated tunnel: loopback peer (the local proxy), everything else remote.
    assert.equal(
      status(dev.authenticate(req({ headers: { host: "abc.ngrok.app", origin: "https://abc.ngrok.app", "x-forwarded-for": "203.0.113.5" } }), config, T0)),
      403,
    );
    assert.ok(isLoopbackAddress("127.3.4.5") && !isLoopbackAddress("128.0.0.1") && !isLoopbackAddress(undefined));
    assert.ok(isLoopbackHostHeader("[::1]:8917") && isLoopbackHostHeader("localhost") && !isLoopbackHostHeader("localhost.evil.example"));
  });
});

describe("LIVE-2B mode lock", () => {
  const prod = { GS_MODE: "production", GS_ALLOWED_ORIGINS: "https://play.example", GS_TRUSTED_PROXY_HOPS: "1" };
  const reason = (argv: string[], env: Record<string, string | undefined>) => {
    const result = resolveServerConfig(argv, env);
    return result.ok ? "ok" : result.reason;
  };

  test("GS_MODE is required, has no default, and must be one of two values", () => {
    assert.match(reason([], {}), /GS_MODE is not set/);
    assert.match(reason([], { GS_MODE: "" }), /GS_MODE is not set/);
    assert.match(reason([], { GS_MODE: "prod" }), /must be "development" or "production"/);
    assert.match(reason(["--mode", "production"], { GS_MODE: "development" }), /disagree/);
    assert.equal(reason(["--mode", "development"], {}), "ok");
    assert.equal(reason([], prod), "ok");
  });

  test("production refuses every insecure setting -- never a warning", () => {
    assert.match(reason(["--insecure-local-identity"], prod), /--insecure-local-identity/);
    assert.match(reason([], { ...prod, INSECURE_LOCAL_IDENTITY: "1" }), /INSECURE_LOCAL_IDENTITY/);
    assert.match(reason([], { ...prod, INSECURE_LOCAL_IDENTITY: "0" }), /INSECURE_LOCAL_IDENTITY/);
    assert.match(reason([], { ...prod, LEGACY_LOGS: "development-corpus" }), /legacy-logs/);
    assert.match(reason(["--legacy-logs", "development-corpus"], prod), /legacy-logs/);
    assert.match(reason(["--explain-divergence"], prod), /explain-divergence/);
    assert.match(reason([], { ...prod, EXPLAIN_DIVERGENCE: "1" }), /explain-divergence/i);
    assert.match(reason([], { ...prod, GS_ALLOWED_ORIGINS: "" }), /needs GS_ALLOWED_ORIGINS/);
    assert.match(reason([], { ...prod, GS_ALLOWED_ORIGINS: "http://play.example" }), /non-https/);
    assert.match(reason([], { ...prod, GS_TRUSTED_PROXY_HOPS: undefined }), /GS_TRUSTED_PROXY_HOPS/);
    assert.match(reason([], { ...prod, GS_TRUSTED_PROXY_HOPS: "-1" }), /whole number/);
    assert.match(reason([], { ...prod, GS_TRUSTED_PROXY_HOPS: "1x" }), /whole number/);
  });

  test("development is loopback-only: proxy hops refuse, a non-loopback origin refuses", () => {
    const dev = resolveServerConfig([], { GS_MODE: "development" });
    assert.ok(dev.ok && dev.config.trustedProxyHops === 0 && dev.config.allowedOrigins.every((o) => o.startsWith("http://localhost") || o.startsWith("http://127.0.0.1")));
    assert.match(reason([], { GS_MODE: "development", GS_TRUSTED_PROXY_HOPS: "1" }), /loopback-only/);
    assert.match(reason([], { GS_MODE: "development", GS_ALLOWED_ORIGINS: "https://abc.ngrok.app" }), /non-loopback/);
    assert.equal(reason([], { GS_MODE: "development", GS_TRUSTED_PROXY_HOPS: "0", GS_ALLOWED_ORIGINS: "http://localhost:8918" }), "ok");
  });
});

describe("LIVE-2B limiters", () => {
  test("keyed buckets forget full buckets and never hold more than their bound (rate-limit memory)", () => {
    let now = T0;
    const buckets = new KeyedBuckets({ capacity: 2, refillPerSecond: 1 }, () => now, 100);
    for (let n = 0; n < 1000; n += 1) buckets.take(`k${n}`);
    assert.ok(buckets.size <= 100);
    now += 5_000;
    buckets.prune();
    assert.equal(buckets.size, 0, "refilled buckets are forgotten");
    assert.equal(buckets.take("a"), 0);
    assert.equal(buckets.take("a"), 0);
    assert.ok(buckets.take("a") > 0, "burst spent");
  });

  test("an IPv6 /48 aggregate caps a site's /64s at the factor", () => {
    const buckets = new IpBuckets({ capacity: 1, refillPerSecond: 0.0001 }, () => T0, 2, 1000);
    const in48 = (n: number) => ipKeyOf(`2001:db8:1:${n}::1`) as { key: string; aggregate: string | null };
    assert.equal(buckets.take(in48(1)), 0);
    assert.equal(buckets.take(in48(2)), 0);
    assert.ok(buckets.take(in48(3)) > 0, "the /48's budget is spent");
    assert.equal(buckets.take(ipKeyOf("2001:db8:2:1::1") as { key: string; aggregate: string | null }), 0, "another /48 is not");
  });

  test("three malformed closes in ten minutes start a five-minute cooldown", () => {
    let now = T0;
    const cooldowns = new MalformedCooldowns(3, 10 * 60 * 1000, 5 * 60 * 1000, () => now);
    assert.equal(cooldowns.record("v4:1.2.3.4"), false);
    now += 11 * 60 * 1000;
    assert.equal(cooldowns.record("v4:1.2.3.4"), false, "the first fell out of the window");
    assert.equal(cooldowns.record("v4:1.2.3.4"), false);
    assert.equal(cooldowns.record("v4:1.2.3.4"), true);
    assert.equal(cooldowns.remaining("v4:1.2.3.4"), 5 * 60 * 1000);
    now += 5 * 60 * 1000;
    assert.equal(cooldowns.remaining("v4:1.2.3.4"), 0);
  });
});
