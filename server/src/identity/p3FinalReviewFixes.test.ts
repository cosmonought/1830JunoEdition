// server/src/identity/p3FinalReviewFixes.test.ts
//
// ==================================================================
//  PHASE 3 FINAL -- THE INDEPENDENT SECURITY REVIEW'S IDENTITY FINDINGS, PINNED
// ==================================================================
//
//   M1  "username taken" from the CREATE mint is charged to the address's account-creation budget: a stranger learns no
//       more existing usernames than the accounts it could create, and then every CREATE mint from the address is 429.
//   L2  the operation book never evicts an IN-USE operation, and spent ones go first.
//   NEW-1 (re-review) and no flood can refuse everyone: live CREATE / RECOVER operations are capped per address and per
//       IPv6 /48, and when the book is full a newcomer evicts the biggest holder's oldest OPEN operation; REPLACE (an
//       explicitly confirmed signed-in session) is never bounded by the flood. A mint that still finds no room: 503 busy.
//   L3  (the store conformance, ID-23) the Authorization Wallet's compare-and-swap pins the designation (address AND
//       since) -- see persistence/conformance/identityJournal.conformance.ts.
//   INFO a recovery ends every other open RECOVER of the account (one the wallet already signed elsewhere is dead).
//   INFO a replay of a completed replacement reads "used", not "invalid".

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createAuthorizationBook, LIVE_OPERATIONS_PER_CLIENT, LIVE_OPERATIONS_PER_GROUP } from "./authorizationWallet";
import { IdentityService } from "./sessions";
import { createMemoryIdentityStore } from "./store";
import { TEST_PASSWORD_KDF, player, moneyServer } from "../escrow/escrow4Support";
import { apiRequest, bootstrapCookie, PROD_ORIGIN, quietConsole, startServer, stopServer } from "../rooms/testSupport";
import { keplrAccount } from "../testSupport/authorizationWallets";

quietConsole();

const binding = (sessionId: string) => ({ sessionId, familyId: `sf_${sessionId}`, loginKey: "someone", profileId: null, epoch: null });
const mintFor = (book: ReturnType<typeof createAuthorizationBook>, sessionId: string, now: number) =>
  book.mint({ kind: "recover", binding: binding(sessionId), site: PROD_ORIGIN, account: "someone", wallet: keplrAccount(`book/${sessionId}`).address, replaces: null }, now);

describe("PHASE 3 FINAL review L2: the operation book never evicts a live operation", () => {
  test("past the bound a new mint is refused; spent operations make room first; open and in-use ones survive any flood", () => {
    const book = createAuthorizationBook({ appName: "Project 18XX", max: 3 });
    const now = 1_000_000;
    const victim = mintFor(book, "victim", now);
    assert.ok(victim);
    assert.equal(book.take(victim.operation, "recover", { sessionId: "victim", familyId: "sf_victim" }, now).kind, "open");
    const other = mintFor(book, "other", now);
    const third = mintFor(book, "third", now);
    assert.ok(other && third);
    /* Full of live operations: the flood is refused, nobody's is evicted. */
    for (let flood = 0; flood < 50; flood += 1) assert.equal(mintFor(book, `attacker-${flood}`, now), null);
    assert.equal(book.size(), 3);
    /* The victim's in-use operation is still there to spend. */
    book.spend(victim.operation);
    assert.equal(book.take(victim.operation, "recover", { sessionId: "victim", familyId: "sf_victim" }, now).kind, "used");
    /* A spent one makes room; a session re-minting its own kind replaces its own (never counted twice). */
    assert.ok(mintFor(book, "newcomer", now));
    assert.equal(book.take(other.operation, "recover", { sessionId: "other", familyId: "sf_other" }, now).kind, "open");
    assert.equal(mintFor(book, "flood-after", now), null, "the newcomer took the spent one's place; the bound holds");
    assert.ok(mintFor(book, "third", now), "re-minting its own slot replaces it");
    /* Expiry frees the rest. */
    assert.ok(mintFor(book, "later", now + 5 * 60 * 1000 + 1));
  });

  test("review NEW-1: a flood fills only its own share -- one address is capped, and a newcomer from elsewhere evicts the biggest holder's oldest OPEN operation (never an in-use one)", () => {
    const now = 2_000_000;
    const at = (client: string, aggregate: string | null) => ({ key: client, aggregate });
    const mintAt = (book: ReturnType<typeof createAuthorizationBook>, sessionId: string, client: { key: string; aggregate: string | null }) =>
      book.mint({ kind: "recover", binding: binding(sessionId), site: PROD_ORIGIN, account: "someone", wallet: keplrAccount(`book/${sessionId}`).address, replaces: null, client }, now);
    /* Per address: LIVE_OPERATIONS_PER_CLIENT, then that address alone is refused. */
    const capped = createAuthorizationBook({ appName: "Project 18XX" });
    for (let k = 0; k < LIVE_OPERATIONS_PER_CLIENT; k += 1) assert.ok(mintAt(capped, `one-${k}`, at("v4:203.0.113.9", null)));
    assert.equal(mintAt(capped, "one-over", at("v4:203.0.113.9", null)), null);
    assert.ok(mintAt(capped, "elsewhere", at("v4:198.51.100.7", null)), "another address is not affected");
    /* Per /48: LIVE_OPERATIONS_PER_GROUP across its /64s. */
    const grouped = createAuthorizationBook({ appName: "Project 18XX" });
    for (let k = 0; k < LIVE_OPERATIONS_PER_GROUP; k += 1) assert.ok(mintAt(grouped, `g-${k}`, at(`v6:2001:db8:1:${k.toString(16)}/64`, "v6:2001:db8:1/48")));
    assert.equal(mintAt(grouped, "g-over", at("v6:2001:db8:1:ffff/64", "v6:2001:db8:1/48")), null);
    /* Fair share when the book is full. */
    const book = createAuthorizationBook({ appName: "Project 18XX", max: 6 });
    const flood = [0, 1, 2, 3, 4].map((k) => mintAt(book, `flood-${k}`, at(`v6:2001:db8:2:${k}/64`, "v6:2001:db8:2/48")));
    assert.ok(flood.every((op) => op !== null));
    const victim = mintAt(book, "victim", at("v4:192.0.2.1", null));
    assert.ok(victim);
    assert.equal(book.take(victim.operation, "recover", { sessionId: "victim", familyId: "sf_victim" }, now).kind, "open", "the victim's operation is now IN USE");
    /* The flood can't grow (it is the biggest holder: its own mint is refused) ... */
    assert.equal(mintAt(book, "flood-more", at("v6:2001:db8:2:9/64", "v6:2001:db8:2/48")), null);
    /* ... and a newcomer from elsewhere gets in by evicting the flood's OLDEST open operation. */
    const newcomer = mintAt(book, "newcomer", at("v4:192.0.2.2", null));
    assert.ok(newcomer);
    assert.equal(book.take((flood[0] as { operation: string }).operation, "recover", { sessionId: "flood-0", familyId: "sf_flood-0" }, now).kind, "unknown", "the flood's oldest went");
    assert.equal(book.size(), 6);
    /* The in-use victim operation was never a candidate. */
    book.spend(victim.operation);
    assert.equal(book.take(victim.operation, "recover", { sessionId: "victim", familyId: "sf_victim" }, now).kind, "used");
    /* Second re-review LOW: a small holder (a household's two open RECOVERs) is never evicted, however thinly a flood
       spreads itself -- past the bound the newcomer is refused instead. */
    const thin = createAuthorizationBook({ appName: "Project 18XX", max: 4 });
    const household = [mintAt(thin, "home-1", at("v4:192.0.2.50", null)), mintAt(thin, "home-2", at("v4:192.0.2.50", null))];
    assert.ok(mintAt(thin, "thin-1", at("v4:198.51.100.1", null)) && mintAt(thin, "thin-2", at("v4:198.51.100.2", null)));
    assert.equal(mintAt(thin, "thin-3", at("v4:198.51.100.3", null)), null, "refused, not evicting the household");
    for (const op of household) assert.equal(thin.take((op as { operation: string }).operation, "recover", { sessionId: op === household[0] ? "home-1" : "home-2", familyId: op === household[0] ? "sf_home-1" : "sf_home-2" }, now).kind, "open");
    /* REPLACE is never refused by the bound (an explicitly confirmed signed-in session, one each). */
    const full = createAuthorizationBook({ appName: "Project 18XX", max: 1 });
    assert.ok(mintAt(full, "fill", at("v4:192.0.2.3", null)));
    assert.ok(full.mint({ kind: "replace", binding: { ...binding("signed-in"), profileId: "pf_x", epoch: "e" }, site: PROD_ORIGIN, account: "someone", wallet: keplrAccount("book/new").address, replaces: keplrAccount("book/old").address, client: at("v4:192.0.2.3", null) }, now));
  });

  test("the service and the HTTP route answer a full book 'busy' (503), never by evicting", async () => {
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    (service as unknown as { authorizations: ReturnType<typeof createAuthorizationBook> }).authorizations = createAuthorizationBook({ appName: "Project 18XX", max: 1 });
    const { server, port } = await startServer({ identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, service } });
    try {
      const first = await bootstrapCookie(port);
      const second = await bootstrapCookie(port);
      const wallet = keplrAccount("busy/wallet").address;
      assert.equal((await apiRequest(port, "/gs/api/account/authorization", { cookie: first, body: { purpose: "recover", username: "anyone", wallet } })).status, 200);
      const refused = await apiRequest(port, "/gs/api/account/authorization", { cookie: second, body: { purpose: "recover", username: "anyone", wallet } });
      assert.deepEqual([refused.status, refused.body?.error], [503, "busy"]);
      assert.ok(refused.headers["retry-after"]);
    } finally {
      await stopServer(server);
    }
  });
});

describe("PHASE 3 FINAL review M1: 'username taken' from the CREATE mint spends the address's creation budget", () => {
  test("a stranger probing usernames is stopped by the creation budget; an untaken name costs nothing until the account is made", async () => {
    const known = { browser: { username: "known.user" } };
    /* A server with production-sized creation budgets (5 per address). */
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const { server, port } = await startServer({
      identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, service },
      limits: { identity: { profileCreatesPerIp: { capacity: 5, refillPerSecond: 10 / 3600 } } },
    });
    try {
      /* One real account to probe for. */
      const owner = await bootstrapCookie(port);
      const ownerWallet = keplrAccount("m1/owner");
      const minted = await apiRequest(port, "/gs/api/account/authorization", { cookie: owner, body: { purpose: "create", username: known.browser.username, wallet: ownerWallet.address } });
      assert.equal(minted.status, 200);
      const texts = minted.body?.texts as Array<{ text: string }>;
      const created = await apiRequest(port, "/gs/api/account/create", { cookie: owner, body: { username: known.browser.username, password: "correct horse battery", name: "Known", operation: minted.body?.operation, ...ownerWallet.sign(texts[0].text) } });
      assert.equal(created.status, 201, created.text);
      /* That creation spent one of the address's five. A prober: untaken names are free; each "taken" costs one. */
      const prober = await bootstrapCookie(port);
      const probe = (username: string) => apiRequest(port, "/gs/api/account/authorization", { cookie: prober, body: { purpose: "create", username, wallet: keplrAccount("m1/prober").address } });
      for (let free = 0; free < 10; free += 1) assert.equal((await probe(`nobody-${free}`)).status, 200);
      const answers: number[] = [];
      for (let taken = 0; taken < 8; taken += 1) answers.push((await probe(known.browser.username)).status);
      assert.deepEqual(answers.slice(0, 4), [409, 409, 409, 409], "four more 'taken' answers fit in the address's budget");
      assert.ok(answers.slice(4).every((status) => status === 429), `then the address is out of creation budget: ${answers.join(",")}`);
      assert.equal((await probe("nobody-at-all-else")).status, 429, "and every CREATE mint from it waits");
    } finally {
      await stopServer(server);
    }
  });
});

describe("PHASE 3 FINAL review INFO: a recovery ends the account's other RECOVER operations; a replacement's replay reads 'used'", () => {
  test("two RECOVER texts signed by the wallet: the first recovers, the second is dead", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const mintRecover = async () => {
        const cookie = await bootstrapCookie(world.port);
        const answer = await apiRequest(world.port, "/gs/api/account/authorization", { cookie, body: { purpose: "recover", username: alice.browser.username, wallet: alice.browser.wallet.address } });
        const texts = answer.body?.texts as Array<{ text: string }>;
        return { cookie, operation: answer.body?.operation as string, signed: alice.browser.wallet.sign(texts[0].text) };
      };
      const one = await mintRecover();
      const two = await mintRecover();
      const first = await apiRequest(world.port, "/gs/api/account/recover", { cookie: one.cookie, body: { operation: one.operation, ...one.signed, newPassword: "the first new password" } });
      assert.equal(first.status, 200, first.text);
      const second = await apiRequest(world.port, "/gs/api/account/recover", { cookie: two.cookie, body: { operation: two.operation, ...two.signed, newPassword: "the second new password" } });
      assert.deepEqual([second.status, second.body], [403, { error: "invalid-credential" }]);
    } finally {
      await world.close();
    }
  });

  test("a completed replacement, replayed, answers authorization-used", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      assert.equal((await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: alice.browser.cookie, body: { password: alice.browser.password } })).status, 200);
      const next = keplrAccount("review/replay/next");
      const challenge = await apiRequest(world.port, "/gs/api/account/authorization-wallet/challenge", { cookie: alice.browser.cookie, body: { newWallet: next.address } });
      const texts = challenge.body?.texts as Array<{ text: string }>;
      const approve = alice.browser.wallet.sign(texts[0].text);
      const accept = next.sign(texts[1].text);
      const body = { operation: challenge.body?.operation, approvePubKey: approve.pubKey, approveSignature: approve.signature, acceptPubKey: accept.pubKey, acceptSignature: accept.signature };
      assert.equal((await apiRequest(world.port, "/gs/api/account/authorization-wallet/replace", { cookie: alice.browser.cookie, body })).status, 200);
      const replay = await apiRequest(world.port, "/gs/api/account/authorization-wallet/replace", { cookie: alice.browser.cookie, body });
      assert.deepEqual([replay.status, replay.body?.error], [409, "authorization-used"]);
    } finally {
      await world.close();
    }
  });
});
