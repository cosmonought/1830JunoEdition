// LUDUM v1 -- player history (Lane C): the `games` / `game` handlers -- access, the closed request schema, the cursor,
// and what may leave the server.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { GameDetail, GamesResponse } from "../contract";
import { LUDUM_ROUTES } from "../registry";
import { decodeCursor, encodeCursor, game, games } from "./index";
import { PEOPLE, T0, gameIdOf, moneyTable, recordOf, worldOf } from "./historyTestSupport";

const [ALICE, BOB, CAROL] = PEOPLE;
const call = (handler: typeof games, body: unknown, principalId: string | null, world = worldOf()) => handler(body, { principalId }, world.ports);

describe("history handlers: access", () => {
  test("the registry routes games/game to these handlers", () => {
    assert.equal(LUDUM_ROUTES.games.handler, games);
    assert.equal(LUDUM_ROUTES.game.handler, game);
  });

  test("a signed-out caller gets 401 signed-out on both routes", async () => {
    for (const [handler, body] of [[games, {}], [game, { gameId: gameIdOf() }]] as const) {
      const answer = await call(handler, body, null);
      assert.equal(answer.status, 401);
      assert.deepEqual(answer.json, { error: "signed-out" });
    }
  });

  test("another account's game answers 404, exactly like a game that does not exist", async () => {
    const world = worldOf();
    const theirs = recordOf({ people: 2 }); // Alice and Bob only
    world.records.push(theirs);
    const foreign = await game({ gameId: theirs.game_id }, { principalId: CAROL.principal }, world.ports);
    const missing = await game({ gameId: gameIdOf() }, { principalId: CAROL.principal }, world.ports);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign, missing);
    assert.equal((await game({ gameId: theirs.game_id }, { principalId: BOB.principal }, world.ports)).status, 200);
  });

  test("closed request schema: unknown keys, wrong types, bad ids and bad limits are 400", async () => {
    for (const body of [null, [], "x", { gameId: gameIdOf(), extra: 1 }, { gameId: 7 }, { gameId: "g_nope" }, {}]) {
      assert.equal((await call(game, body, ALICE.principal)).status, 400, JSON.stringify(body));
    }
    for (const body of [null, { limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: "5" }, { cursor: 5 }, { cursor: "!!" }, { cursor: "" }, { page: 1 }]) {
      assert.equal((await call(games, body, ALICE.principal)).status, 400, JSON.stringify(body));
    }
  });

  test("the records port failing answers 503 unavailable", async () => {
    const world = worldOf();
    const ports = { ...world.ports, records: () => { throw new Error("down"); } };
    assert.equal((await games({}, { principalId: ALICE.principal }, ports)).status, 503);
    assert.equal((await game({ gameId: gameIdOf() }, { principalId: ALICE.principal }, ports)).status, 503);
  });
});

describe("history handlers: games", () => {
  test("every status, archived included; only the caller's games; newest first; no 50 cap", async () => {
    const world = worldOf();
    const statuses = [
      recordOf({ createdAt: T0 + 1, status: "waiting", startedAt: null, completedAt: null }),
      recordOf({ createdAt: T0 + 2, status: "active", completedAt: null }),
      recordOf({ createdAt: T0 + 3, status: "completed" }),
      recordOf({ createdAt: T0 + 4, status: "cancelled", startedAt: null, completedAt: null }),
      recordOf({ createdAt: T0 + 5, status: "expired", startedAt: null, completedAt: null }),
      recordOf({ createdAt: T0 + 6, status: "completed", archivedAt: T0 + 9 }),
    ];
    world.records.push(...statuses, recordOf({ createdAt: T0 + 7, money: false, people: 1 })); // the last seats Alice only
    for (let i = 0; i < 60; i += 1) world.records.push(recordOf({ createdAt: T0 - 1000 - i, money: false, people: 2 }));
    const first = (await games({ limit: 50 }, { principalId: BOB.principal }, world.ports)).json as GamesResponse;
    assert.equal(first.games.length, 50);
    assert.deepEqual(first.games.slice(0, 6).map((g) => g.table.value), ["archived", "expired", "cancelled", "completed", "active", "waiting"]);
    for (const g of first.games) assert.equal(g.table.provenance, "server-recorded");
    assert.ok(first.nextCursor !== null);
    const second = (await games({ limit: 50, cursor: first.nextCursor }, { principalId: BOB.principal }, world.ports)).json as GamesResponse;
    assert.equal(second.games.length, 16);
    assert.equal(second.nextCursor, null);
    const all = [...first.games, ...second.games];
    assert.equal(new Set(all.map((g) => g.gameId)).size, 66, "no game twice, none lost");
    const times = all.map((g) => Date.parse(g.createdAt));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    assert.equal(second.asOf, new Date(T0 + 10_000).toISOString());
  });

  test("default limit 20; equal created_at is ordered by game id and the cursor never skips or repeats", async () => {
    const world = worldOf();
    for (let i = 0; i < 25; i += 1) world.records.push(recordOf({ createdAt: T0, money: false }));
    const ids: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = (await games(cursor === undefined ? {} : { cursor }, { principalId: ALICE.principal }, world.ports)).json as GamesResponse;
      if (pages === 0) assert.equal(page.games.length, 20);
      ids.push(...page.games.map((g) => g.gameId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 5);
    assert.equal(ids.length, 25);
    assert.deepEqual(ids, [...ids].sort().reverse());
  });

  test("the cursor is base64url of exactly {createdAt, gameId}", () => {
    const key = { createdAt: new Date(T0).toISOString(), gameId: gameIdOf() };
    const cursor = encodeCursor(key);
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), key);
    assert.deepEqual(decodeCursor(cursor), key);
    const extra = Buffer.from(JSON.stringify({ ...key, x: 1 })).toString("base64url");
    assert.equal(decodeCursor(extra), null);
    assert.equal(decodeCursor(Buffer.from(JSON.stringify({ ...key, createdAt: "yesterday" })).toString("base64url")), null);
  });

  test("a summary carries the money block and the seat, with no account data", async () => {
    const world = worldOf();
    moneyTable(world);
    const page = (await games({}, { principalId: ALICE.principal }, world.ports)).json as GamesResponse;
    const [g] = page.games;
    assert.equal(g.product.key, "project-18xx");
    assert.equal(g.seat.displayName, "Alice");
    assert.equal(g.playerCount, 3);
    assert.equal(g.money?.contract, "juno19vd5hphghprl2m8agchctyav8pmeh6p4x3vud6cfhd2y6ulwtf0s0jrk7x");
    assert.deepEqual(g.money?.anteGross, { amount: "2000000", denom: "ujunox" });
    assert.equal(g.variant, "standard · live · delayed auction");
    assertNoAccountData(JSON.stringify(page));
  });
});

describe("history handlers: game", () => {
  test("the other seats' display names, and nothing else about their accounts", async () => {
    const world = worldOf();
    const { gameId } = moneyTable(world);
    const answer = await game({ gameId }, { principalId: BOB.principal }, world.ports);
    const d = answer.json as GameDetail;
    assert.deepEqual(d.seats.map((s) => [s.displayName, s.you]), [["Alice", false], ["Bob", true], ["Carol", false]]);
    for (const s of d.seats) assert.deepEqual(Object.keys(s).sort(), ["chainSeatIndex", "displayName", "finalNetWorth", "rank", "you"]);
    assertNoAccountData(JSON.stringify(d));
  });
});

/** No principal id, player id or wallet of anyone on the wire. */
function assertNoAccountData(text: string): void {
  for (const p of PEOPLE) {
    assert.ok(!text.includes(p.principal), `principal ${p.principal} leaked`);
    assert.ok(!text.includes(p.player), `player id ${p.player} leaked`);
    assert.ok(!text.includes(p.wallet), `wallet ${p.wallet} leaked`);
  }
  assert.ok(!text.includes("pr_"), "a principal id leaked");
}
