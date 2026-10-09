// LUDUM v1 step 0: the route table resolves exactly the four §5 routes, and the stubs answer 503 `unavailable`.

import test from "node:test";
import assert from "node:assert/strict";
import { LUDUM_PREFIX, LUDUM_ROUTES, ludumRouteOf } from "./registry";
import type { LudumPorts } from "./ports";

const noPorts = {} as LudumPorts;

test("ludum registry: exactly the §5 routes, with their access rules", () => {
  assert.deepEqual(Object.keys(LUDUM_ROUTES).sort(), ["case", "game", "games", "session"]);
  assert.equal(LUDUM_ROUTES.session.access, "public");
  assert.equal(LUDUM_ROUTES.case.access, "public");
  assert.equal(LUDUM_ROUTES.games.access, "profiled");
  assert.equal(LUDUM_ROUTES.game.access, "profiled");
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

test("ludum registry: step-0 stubs answer 503 unavailable", async () => {
  for (const name of ["games", "game", "case"] as const) {
    const answer = await LUDUM_ROUTES[name].handler!({}, { principalId: null }, noPorts);
    assert.equal(answer.status, 503);
    assert.equal((answer.json as { error: string }).error, "unavailable");
  }
});
