// LUDUM v1 step 0: the route table resolves exactly the four §5 routes, and the stubs answer 503 `unavailable`.

import test from "node:test";
import assert from "node:assert/strict";
import { LUDUM_PREFIX, LUDUM_ROUTES, ludumRouteOf } from "./registry";
import type { LudumPorts } from "./ports";

test("ludum registry: exactly the §5 / §5.1 routes, with their access rules", () => {
  assert.deepEqual(Object.keys(LUDUM_ROUTES).sort(), ["account", "case", "display-name", "game", "games", "moderation-case", "moderation-decide", "moderation-queue", "session"]);
  assert.equal(LUDUM_ROUTES.session.access, "public");
  assert.equal(LUDUM_ROUTES.case.access, "public");
  assert.equal(LUDUM_ROUTES.games.access, "profiled");
  assert.equal(LUDUM_ROUTES.game.access, "profiled");
  /* v1.1 (§5.1) */
  assert.equal(LUDUM_ROUTES.account.access, "profiled");
  assert.equal(LUDUM_ROUTES["display-name"].access, "profiled");
  assert.equal(LUDUM_ROUTES["moderation-queue"].access, "reviewer");
  assert.equal(LUDUM_ROUTES["moderation-case"].access, "reviewer");
  assert.equal(LUDUM_ROUTES["moderation-decide"].access, "reviewer");
  assert.equal(LUDUM_ROUTES.session.handler, null);
  assert.ok(Object.isFrozen(LUDUM_ROUTES));
});

test("ludum registry: exact path match only", () => {
  assert.equal(ludumRouteOf(`${LUDUM_PREFIX}games`)?.name, "games");
  assert.equal(ludumRouteOf(`${LUDUM_PREFIX}case`)?.name, "case");
  for (const path of [
    "/gs/api/ludum/v1",
    LUDUM_PREFIX,
    `${LUDUM_PREFIX}games/`,
    `${LUDUM_PREFIX}games?x=1`,
    `${LUDUM_PREFIX}Games`,
    `${LUDUM_PREFIX}toString`,
    `${LUDUM_PREFIX}__proto__`,
    "/gs/api/ludum/v2/games",
    "/gs/api/account/me",
  ]) assert.equal(ludumRouteOf(path), null, path);
});

/* INTEGRATION (supersedes step 0's "stubs answer 503"): the stubs were replaced by Lane C (`games`, `game`) and Lane B2
   (`case`). The contract is now §5's: profiled routes answer a signed-out caller 401 `signed-out` (the ingress enforces it
   from `access`, and the handlers refuse it again on their own); signed in, they answer from the ports. `case` is public. */
const emptyPorts: LudumPorts = {
  records: () => [],
  seatOf: () => null,
  financial: async () => null,
  financialByChainGameId: async () => null,
  terminalEvidence: async () => null,
  chainGame: async () => null,
  escrowPin: () => null,
  product: () => ({ key: "project-18xx", name: "Project 18XX" }),
  now: () => 0,
};
const errorOf = (json: unknown): string => (json as { error: string }).error;

test("ludum registry: profiled routes refuse a signed-out caller with 401 signed-out (handler-level too)", async () => {
  for (const [name, body] of [["games", {}], ["game", { gameId: "g_00000000000000000000000000" }]] as const) {
    const answer = await LUDUM_ROUTES[name].handler!(body, { principalId: null }, emptyPorts);
    assert.equal(answer.status, 401, name);
    assert.equal(errorOf(answer.json), "signed-out", name);
  }
});

test("ludum registry: signed in, profiled routes answer from the ports (empty list; a game not held is 404)", async () => {
  const caller = { principalId: "pr_00000000000000000000000000" };
  const list = await LUDUM_ROUTES.games.handler!({}, caller, emptyPorts);
  assert.equal(list.status, 200);
  assert.deepEqual((list.json as { games: unknown[]; nextCursor: unknown }).games, []);
  assert.equal((list.json as { nextCursor: unknown }).nextCursor, null);
  const one = await LUDUM_ROUTES.game.handler!({ gameId: "g_00000000000000000000000000" }, caller, emptyPorts);
  assert.equal(one.status, 404);
  assert.equal(errorOf(one.json), "not-found");
  const bad = await LUDUM_ROUTES.games.handler!({ limit: 51 }, caller, emptyPorts);
  assert.equal(bad.status, 400);
  assert.equal(errorOf(bad.json), "bad-request");
});

test("ludum registry: case is public -- a signed-out caller is answered, never 401", async () => {
  const bad = await LUDUM_ROUTES.case.handler!({ chainGameId: 1 }, { principalId: null }, emptyPorts);
  assert.equal(bad.status, 400, "the closed schema: a decimal string only");
  const noPin = await LUDUM_ROUTES.case.handler!({ chainGameId: "1" }, { principalId: null }, emptyPorts);
  assert.equal(noPin.status, 503, "no pinned deployment: unavailable, never guessed");
  assert.equal(errorOf(noPin.json), "unavailable");
  assert.notEqual(noPin.status, 401);
});
