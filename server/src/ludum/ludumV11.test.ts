// server/src/ludum/ludumV11.test.ts
//
// LUDUM v1.1 (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §5.1, owner request 2026-10-09) over real HTTP, through
// `createGameServer`:
//   A. `account` and `display-name`: the caller's own display name and its one change (unique; never while seated; once),
//      and the facts tablemates see; signed out 401;
//   B. `moderation-*`: reviewers only (everyone else -- signed out, a player, a party -- 404, as an unknown route); a
//      reviewer never sees a case they are party to; a decision needs a live "Confirm it's you" (403 reauth-required
//      with Play's confirmation link), then lands exactly as Play's own review route would;
//   C. the boundaries hold: Play's own conduct and trust routes still refuse Ludum's origin (no CORS was relaxed), and
//      no Ludum answer to a non-reviewer carries a conduct case.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { IdentityService } from "../identity/sessions";
import { createMemoryIdentityStore } from "../identity/store";
import { conductReviewersFromEnv } from "../conduct/conductHttpApi";
import { createMemoryConductCaseStore } from "../conduct/conductStore";
import { createMemoryRecordStore } from "../rooms/recordStore";
import { accountBrowser, apiRequest, Client, PROD_ORIGIN, quietConsole, startServer, stopServer, type AccountBrowser, type ApiAnswer } from "../rooms/testSupport";
import { LUDUM_PREFIX } from "./registry";

quietConsole();

const LUDUM = "https://ludum.example";
const PASSWORD = "correct horse battery";
const MINUTE = 60_000;

const ludum = (port: number, route: string, cookie?: string, body: object = {}) => apiRequest(port, `${LUDUM_PREFIX}${route}`, { origin: LUDUM, cookie, body });
const play = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });
const errorOf = (answer: ApiAnswer) => [answer.status, (answer.body as { error?: string; detail?: string } | null)?.error, (answer.body as { detail?: string } | null)?.detail];

function world() {
  const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
  const clock = { now: Date.now() };
  const auth = { mode: "production" as const, allowedOrigins: [PROD_ORIGIN], ludumOrigins: [LUDUM], trustedProxyHops: 0, now: () => clock.now, service: identity };
  return { identity, clock, auth, records: createMemoryRecordStore(), conduct: createMemoryConductCaseStore() };
}

describe("LUDUM v1.1 A: the account's own page and its one display-name change", () => {
  test("account: the name and its state, the tablemate facts, no role; display-name: once, unique, never while seated; signed out 401", async () => {
    const w = world();
    const { server, port } = await startServer({ identity: w.auth, records: w.records, conduct: { store: w.conduct } });
    try {
      const ann = await accountBrowser(port, "ann-v11", PASSWORD, "Ann");
      const bob = await accountBrowser(port, "bob-v11", PASSWORD, "Bob");

      assert.deepEqual(errorOf(await ludum(port, "account")), [401, "signed-out", undefined]);
      assert.deepEqual(errorOf(await ludum(port, "display-name", undefined, { name: "X" })), [401, "signed-out", undefined]);

      const mine = await ludum(port, "account", ann.cookie);
      assert.equal(mine.status, 200, mine.text);
      assert.deepEqual(mine.body?.displayName, { name: "Ann", state: "changeable", changedAt: null });
      assert.deepEqual(mine.body?.roles, { reviewer: false });
      const facts = mine.body?.tablemates as { value: Record<string, unknown>; provenance: string };
      assert.equal(facts.provenance, "server-recorded");
      assert.deepEqual(Object.keys(facts.value).sort(), ["accountAgeDays", "authorizationWalletSince", "completedMoneyGames", "disputedGames", "establishedOpponents", "inactivityExits", "memberSince", "unresolvedDisputes"]);
      assert.doesNotMatch(mine.text, /pr_|pf_|se_|sf_|ann-v11|juno1/, "no id, username or wallet in the account page answer");
      assert.equal(mine.headers["set-cookie"], undefined);

      /* Bad and taken names are refused without using the change. */
      assert.deepEqual(errorOf(await ludum(port, "display-name", ann.cookie, { name: "   " })), [400, "bad-request", "bad-name"]);
      assert.deepEqual(errorOf(await ludum(port, "display-name", ann.cookie, { name: "BOB" })), [409, "conflict", "taken"]);
      assert.deepEqual(errorOf(await ludum(port, "display-name", ann.cookie, { name: "Ann" })), [409, "conflict", "unchanged"]);
      assert.deepEqual(errorOf(await ludum(port, "display-name", ann.cookie, { name: "Marlowe", extra: 1 })), [400, "bad-request", undefined]);

      const changed = await ludum(port, "display-name", ann.cookie, { name: "Marlowe" });
      assert.equal(changed.status, 200, changed.text);
      assert.deepEqual(changed.body?.displayName, { name: "Marlowe", state: "changed", changedAt: new Date(w.clock.now).toISOString() });
      assert.deepEqual(errorOf(await ludum(port, "display-name", ann.cookie, { name: "Quill" })), [409, "conflict", "already-changed"]);
      assert.equal(((await ludum(port, "session", ann.cookie)).body?.account as { name: string }).name, "Marlowe", "the session (and the account menu) shows the new name");

      /* Bob takes a seat at a waiting table: his name is locked while he sits there. */
      const client = await Client.openWithCookie(port, bob.cookie, "Bob");
      const created = await client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Bob" });
      assert.equal(created.ok, true, JSON.stringify(created));
      assert.equal(((await ludum(port, "account", bob.cookie)).body?.displayName as { state: string }).state, "locked-seated");
      assert.deepEqual(errorOf(await ludum(port, "display-name", bob.cookie, { name: "Robert" })), [409, "conflict", "locked-seated"]);
      assert.deepEqual(errorOf(await ludum(port, "display-name", bob.cookie, { name: "marlowe" })), [409, "conflict", "locked-seated"]);
      await client.close();
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM v1.1 B: conduct review from Ludum -- reviewers only, never their own cases, decisions behind 'Confirm it's you'", () => {
  test("the queue, a case and a decision; 404 for everyone else; 403 reauth-required, then the decision lands", async () => {
    const w = world();
    const browsers: Record<string, AccountBrowser> = {};
    let caseId: string;
    /* The accounts and the report first (reviewers are bound at startup to accounts that already exist). */
    const first = await startServer({ identity: w.auth, records: w.records, conduct: { store: w.conduct } });
    try {
      for (const name of ["Ann", "Ben", "Vic"]) browsers[name] = await accountBrowser(first.port, `${name.toLowerCase()}-mod`, PASSWORD, name);
      const ann = await Client.openWithCookie(first.port, browsers.Ann.cookie, "Ann");
      const created = await ann.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Ann" });
      const gameId = (created.data as { gameId: string }).gameId;
      const ben = await Client.openWithCookie(first.port, browsers.Ben.cookie, "Ben");
      assert.equal((await ben.op({ type: "join", code: (created.data as { code: string }).code, takeSeat: true })).ok, true);
      const reported = await ben.op({ type: "report-player", playerId: (created.data as { playerId: string }).playerId, category: "harassment", note: "Insults in the chat." }, gameId);
      assert.equal(reported.ok, true, JSON.stringify(reported));
      caseId = (await w.conduct.list())[0];
      await Promise.all([ann.close(), ben.close()]);
    } finally {
      await stopServer(first.server);
    }

    const reviewers = conductReviewersFromEnv({ GS_CONDUCT_REVIEWERS: "vic-mod,ben-mod" });
    if (!reviewers.ok) throw new Error(reviewers.reason);
    const { server, port } = await startServer({ identity: w.auth, records: w.records, conduct: { store: w.conduct, reviewers: reviewers.reviewers } });
    try {
      /* Everyone who is not a reviewer: 404 on every moderation route, exactly like a route that does not exist. */
      for (const [label, cookie] of [["signed out", undefined], ["a player (the reported one)", browsers.Ann.cookie]] as const) {
        for (const [route, body] of [["moderation-queue", {}], ["moderation-case", { caseId }], ["moderation-decide", { caseId, revision: 1, status: "under-review" }]] as const) {
          const answer = await ludum(port, route, cookie, body);
          assert.deepEqual(errorOf(answer), [404, "not-found", undefined], `${label}: ${route}`);
          assert.equal(answer.headers["access-control-allow-origin"], LUDUM);
        }
      }
      assert.deepEqual((await ludum(port, "session", browsers.Ann.cookie)).body?.roles, { reviewer: false });
      assert.deepEqual((await ludum(port, "session", browsers.Vic.cookie)).body?.roles, { reviewer: true });

      /* Ben IS a reviewer, but the reporter: the case does not exist for him. */
      const benQueue = await ludum(port, "moderation-queue", browsers.Ben.cookie);
      assert.equal(benQueue.status, 200, benQueue.text);
      assert.deepEqual(benQueue.body?.cases, []);
      assert.deepEqual(errorOf(await ludum(port, "moderation-case", browsers.Ben.cookie, { caseId })), [404, "not-found", undefined]);

      /* Vic reviews it. */
      const queue = await ludum(port, "moderation-queue", browsers.Vic.cookie);
      assert.equal(queue.status, 200, queue.text);
      const cases = queue.body?.cases as Array<{ caseId: string; revision: number; status: string }>;
      assert.deepEqual(cases.map((c) => [c.caseId, c.status]), [[caseId, "open"]]);
      assert.doesNotMatch(queue.text, /pr_|pf_|-mod\b|juno1/, "no principal, username or wallet in a reviewer's answer");
      const opened = await ludum(port, "moderation-case", browsers.Vic.cookie, { caseId });
      assert.equal(opened.status, 200, opened.text);
      assert.equal((opened.body?.case as { caseId: string }).caseId, caseId);

      /* A decision without a live grant (the sign-in's own grant has lapsed): 403 with Play's confirmation link. */
      w.clock.now += 30 * MINUTE;
      const refused = await ludum(port, "moderation-decide", browsers.Vic.cookie, { caseId, revision: cases[0].revision, status: "under-review", note: "Looking at the log." });
      assert.equal(refused.status, 403, refused.text);
      assert.equal(refused.body?.error, "reauth-required");
      assert.equal(refused.body?.confirmUrl, `${PROD_ORIGIN}/?ludum=confirm&return=%2Fmoderation%2F`);
      assert.equal((await w.conduct.load(caseId))?.revision, cases[0].revision, "nothing moved");

      /* "Confirm it's you" on Play, then the decision lands. */
      assert.equal((await play(port, "/gs/api/profile/reauth", browsers.Vic.cookie, { password: PASSWORD })).status, 200);
      const decided = await ludum(port, "moderation-decide", browsers.Vic.cookie, { caseId, revision: cases[0].revision, status: "under-review", note: "Looking at the log." });
      assert.equal(decided.status, 200, decided.text);
      assert.equal((decided.body?.case as { status: string }).status, "under-review");
      /* A stale revision: 409 conflict. */
      assert.deepEqual(errorOf(await ludum(port, "moderation-decide", browsers.Vic.cookie, { caseId, revision: cases[0].revision, status: "no-violation" })).slice(0, 3), [409, "conflict", "stale"]);
      /* A note too long for the route's own body limit is refused before any work. */
      assert.equal((await ludum(port, "moderation-decide", browsers.Vic.cookie, { caseId, revision: 2, status: "no-violation", note: "x".repeat(2001) })).status, 400);
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM v1.1 C: Play's own private routes stay closed to Ludum's origin", () => {
  test("conduct and trust routes: Ludum's Origin is refused with no Access-Control-* header", async () => {
    const w = world();
    const { server, port } = await startServer({ identity: w.auth, records: w.records, conduct: { store: w.conduct } });
    try {
      const ann = await accountBrowser(port, "ann-closed", PASSWORD, "Ann");
      for (const pathname of ["/gs/api/conduct/me", "/gs/api/conduct/review/queue", "/gs/api/account/me", "/gs/api/trust/facts"]) {
        const answer = await apiRequest(port, pathname, { origin: LUDUM, cookie: ann.cookie, body: {} });
        assert.ok(answer.status === 403 || answer.status === 404, `${pathname}: ${answer.status}`);
        assert.deepEqual(Object.keys(answer.headers).filter((name) => name.startsWith("access-control-")), [], pathname);
      }
    } finally {
      await stopServer(server);
    }
  });
});
