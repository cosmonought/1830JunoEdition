// server/src/rooms/playLobby.test.ts
//
// PLAY LOBBY (design handoff "play-lobby-handoff"): what the public lobby may show, enforced by the server.
//   - the public list names seats by their ACCOUNT display name (never a chosen nickname), says which seat hosts, when a
//     playing table was dealt and its deadline, and each seat's ante as funded yes / no -- nothing else is added;
//   - the public game history (`rooms/publicHistory.ts`): only completed PUBLIC games; wins, places and recent results
//     from each game's sealed result; no id, username, account age, wallet, amount, conduct or private table;
//   - `POST /gs/api/lobby/players` over real HTTP: no session needed, Play's origin rules, a closed body, 404 for a table
//     not in the public list, a per-address budget.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { TerminalSettlementEvidence } from "../escrow/settlementEvidence";
import { gameIdOf, recordOf } from "../ludum/history/historyTestSupport";
import { roomSummaryOf, type GameRecord, type LogFacts } from "./gameRecord";
import { countsForPublicHistory, createPublicHistory, placesOf, type PublicSeat } from "./publicHistory";
import { apiRequest, Client, DEV_ORIGIN, quietConsole, startServer, stopServer, until, type Frame } from "./testSupport";

quietConsole();

const NO_FACTS: LogFacts = { dealt: false, dealAt: null, turnOrder: null, rulesEngineVersion: null, ended: false, closed: false };
const DEALT: LogFacts = { dealt: true, dealAt: 1, turnOrder: null, rulesEngineVersion: 1, ended: false, closed: false };
const DAY = 24 * 60 * 60 * 1000;
const T = Date.UTC(2026, 4, 3, 12); // 3 May 2026

function publicRecord(over: Parameters<typeof recordOf>[0] & { visibility?: "public" | "private"; code?: string | null } = {}): GameRecord {
  const record = recordOf({ money: false, ...over });
  return { ...record, visibility: over.visibility ?? "public", join_code: over.code === undefined ? "JUNO-ABCD-EFGH" : over.code };
}

describe("PLAY LOBBY: the public list entry", () => {
  test("seats are named by the account name (not the nickname), the host's seat is given, a playing table its deal time", () => {
    const waiting = { ...publicRecord({ status: "waiting", startedAt: null, completedAt: null }) };
    waiting.seats[1] = { ...waiting.seats[1], nickname: "Alice" }; // Bob's seat calls itself "Alice"
    const accounts: Record<string, string> = { pr_alice: "Alice A", pr_bob: "Bob B", pr_carol: "Carol C" };
    const summary = roomSummaryOf(waiting, NO_FACTS, T, null, { nameOf: (seat) => accounts[seat.principal_id], clock: { deadline: "async-pace", paceSecs: 86_400 } });
    assert.ok(summary !== null);
    assert.deepEqual(summary.nicknames, ["Alice A", "Bob B", "Carol C"]);
    assert.equal(summary.hostNickname, "Alice A");
    assert.equal(summary.hostSeat, 0);
    assert.equal(summary.startedAtMs, undefined, "a waiting table has no deal time");
    assert.deepEqual(summary.clock, { deadline: "async-pace", paceSecs: 86_400 });

    const playing = publicRecord({ status: "active", startedAt: T + 5_000, completedAt: null });
    const live = roomSummaryOf(playing, DEALT, T + 6_000, null, { nameOf: (seat) => accounts[seat.principal_id] });
    assert.equal(live?.status, "playing");
    assert.equal(live?.startedAtMs, T + 5_000);
    assert.equal(live?.clock, undefined, "an unknown deadline is left out, never guessed");
    const json = JSON.stringify(live);
    for (const secret of ["pr_alice", "p-alice", "principal", "player_id", "juno1"]) assert.ok(!json.includes(secret), secret);
  });

  test("private, archived, finished and code-less tables are never listed", () => {
    assert.equal(roomSummaryOf(publicRecord({ visibility: "private", status: "waiting", startedAt: null, completedAt: null }), NO_FACTS, T), null);
    assert.equal(roomSummaryOf(publicRecord({ status: "waiting", startedAt: null, completedAt: null, code: null }), NO_FACTS, T), null);
    assert.equal(roomSummaryOf(publicRecord({ status: "completed" }), { ...DEALT, ended: true }, T), null);
    assert.equal(roomSummaryOf(publicRecord({ status: "waiting", startedAt: null, completedAt: null, archivedAt: T }), NO_FACTS, T), null);
  });
});

describe("PLAY LOBBY: public game history", () => {
  test("finishing places: one more than the players strictly ahead; a tie shares the place", () => {
    assert.deepEqual([...placesOf({ a: "900", b: "1200", c: "900", d: "100" })].sort(), [["a", 2], ["b", 1], ["c", 2], ["d", 4]].sort());
  });

  test("only completed PUBLIC games count", () => {
    assert.equal(countsForPublicHistory(publicRecord()), true);
    assert.equal(countsForPublicHistory(publicRecord({ visibility: "private" })), false);
    assert.equal(countsForPublicHistory(publicRecord({ status: "active", completedAt: null })), false);
    assert.equal(countsForPublicHistory({ ...publicRecord({ status: "cancelled", completedAt: null }), cancelled_at: T }), false);
  });

  /** A world: a listed table seating Alice, Bob and Carol; Alice's finished games with results from `totals`. */
  function world(games: Array<{ record: GameRecord; totals: Record<string, string> | null }>) {
    const listed = publicRecord({ gameId: gameIdOf(), status: "waiting", startedAt: null, completedAt: null });
    const records = [listed, ...games.map((g) => g.record)];
    const replays: string[] = [];
    const history = createPublicHistory({
      records: () => records,
      publicRooms: () => [roomSummaryOf(listed, NO_FACTS, T, null, { nameOf: (seat) => `${seat.nickname} (account)` })!],
      readLog: async (gameId) => {
        const game = games.find((g) => g.record.game_id === gameId);
        return game === undefined || game.totals === null ? null : [{ index: 0, payload: "{}", at: 1 } as never];
      },
      replay: () => ({ ok: false, reason: "not used" }),
      now: () => T,
      evidence: ({ gameId }) => {
        replays.push(gameId);
        const game = games.find((g) => g.record.game_id === gameId)!;
        const evidence = { players: Object.keys(game.totals!), totals: game.totals! } as unknown as TerminalSettlementEvidence;
        return { ok: true, evidence };
      },
    });
    return { history, listed, replays };
  }

  test("completed games, the first month, wins, places and three recent results -- and nothing else", async () => {
    const g = (daysAgo: number, totals: Record<string, string> | null, over: Partial<GameRecord> = {}) => ({
      record: { ...publicRecord({ gameId: gameIdOf(), completedAt: T - daysAgo * DAY, createdAt: T - daysAgo * DAY - 3_600_000 }), ...over },
      totals,
    });
    const { history, listed, replays } = world([
      g(400, { "p-alice": "100", "p-bob": "50", "p-carol": "10" }), // Alice 1st (the first game: Mar 2025)
      g(30, { "p-alice": "10", "p-bob": "50", "p-carol": "20" }), // Alice 3rd
      g(20, { "p-alice": "60", "p-bob": "50", "p-carol": "70" }), // Alice 2nd
      g(10, null), // result unreadable here: counted, not placed
      g(5, { "p-alice": "90", "p-bob": "10", "p-carol": "5" }), // Alice 1st
      g(2, { "p-alice": "1", "p-bob": "1", "p-carol": "1" }, { visibility: "private" }), // private: never counted
    ]);
    const players = (await history.playersOf(listed.game_id)) as PublicSeat[];
    assert.equal(players.length, 3);
    const alice = players[0];
    assert.deepEqual(Object.keys(alice).sort(), ["history", "host", "name", "seat"]);
    assert.equal(alice.name, "Alice (account)");
    assert.equal(alice.host, true);
    assert.equal(players[1].host, false);
    assert.deepEqual(alice.history, {
      completed: 5,
      firstMonth: new Date(T - 400 * DAY).toISOString().slice(0, 7),
      wins: 2,
      places: { first: 2, second: 1, third: 1, rest: 0 },
      placed: 4,
      recent: [
        { endedOn: new Date(T - 5 * DAY).toISOString().slice(0, 10), edition: "standard", place: 1, of: 3 },
        { endedOn: new Date(T - 20 * DAY).toISOString().slice(0, 10), edition: "standard", place: 2, of: 3 },
        { endedOn: new Date(T - 30 * DAY).toISOString().slice(0, 10), edition: "standard", place: 3, of: 3 },
      ],
    });
    const text = JSON.stringify(players);
    for (const secret of ["pr_", "p-alice", "juno1", "username", "principal", "wallet", "amount", "createdAt", "memberSince"]) assert.ok(!text.includes(secret), secret);
    /* A finished game's result is read once, whoever asks next. */
    const before = replays.length;
    await history.playersOf(listed.game_id);
    assert.equal(replays.length, before);
  });

  test("a player with no completed public games: zero, no month; a table not in the public list: null", async () => {
    const { history, listed } = world([]);
    const players = (await history.playersOf(listed.game_id)) as PublicSeat[];
    assert.deepEqual(players[2].history, { completed: 0, firstMonth: null, wins: 0, places: { first: 0, second: 0, third: 0, rest: 0 }, placed: 0, recent: [] });
    assert.equal(await history.playersOf(gameIdOf()), null);
  });
});

describe("PLAY LOBBY: POST /gs/api/lobby/players over HTTP", () => {
  async function lobbyWorld() {
    const { server, port } = await startServer();
    const host = await Client.open(port, "lobby-host");
    requests += 1;
    host.send({ kind: "room-op", requestId: `lp-${requests}`, op: { type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Not My Name" } });
    await until(() => host.frames.some((frame: Frame) => frame.kind === "room-ack"), "the create");
    const ack = host.frames.find((frame: Frame) => frame.kind === "room-ack") as Frame;
    const gameId = (ack.data as { gameId: string }).gameId;
    return { server, port, host, gameId };
  }
  let requests = 0;
  const post = (port: number, body: object | string, options: { origin?: string | null; contentType?: string | null; method?: string } = {}) =>
    apiRequest(port, "/gs/api/lobby/players", { body, origin: DEV_ORIGIN, ...options });

  test("anyone may read a listed table's players (no session), by account name; the answer is exactly the approved fields", async () => {
    const { server, port, host, gameId } = await lobbyWorld();
    try {
      const answer = await post(port, { gameId });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.headers["cache-control"], "no-store");
      assert.equal(answer.headers["access-control-allow-origin"], undefined, "no CORS");
      assert.equal(answer.headers["set-cookie"], undefined, "no session is made");
      const players = (answer.body as { players: PublicSeat[] }).players;
      assert.equal(players.length, 1);
      assert.equal(players[0].name, "lobby-host", "the account's name, not the seat's chosen nickname");
      assert.equal(players[0].host, true);
      assert.deepEqual(Object.keys(answer.body ?? {}).sort(), ["gameId", "ok", "players"]);
    } finally {
      host.close();
      await stopServer(server);
    }
  });

  test("refusals: another origin (403, no CORS), not JSON (415), not POST (405), a malformed or open body (400), a table not listed (404)", async () => {
    const { server, port, host, gameId } = await lobbyWorld();
    try {
      for (const origin of ["https://evil.example", "https://ludum.netadao.org", null]) {
        const refused = await post(port, { gameId }, { origin });
        assert.equal(refused.status, 403, String(origin));
        assert.equal(refused.headers["access-control-allow-origin"], undefined);
      }
      assert.equal((await post(port, { gameId }, { contentType: "text/plain" })).status, 415);
      assert.equal((await post(port, "", { method: "GET" })).status, 405);
      assert.equal((await post(port, { gameId, extra: 1 })).status, 400);
      assert.equal((await post(port, { gameId: "not-a-game" })).status, 400);
      assert.equal((await post(port, { gameId: gameIdOf() })).status, 404);
    } finally {
      host.close();
      await stopServer(server);
    }
  });

  test("a per-address budget: past it, 429 with Retry-After", async () => {
    const { server, port, host, gameId } = await lobbyWorld();
    try {
      let limited = null;
      for (let n = 0; n < 40 && limited === null; n += 1) {
        const answer = await post(port, { gameId });
        if (answer.status === 429) limited = answer;
      }
      assert.ok(limited !== null, "the budget answers 429");
      assert.ok(Number(limited.headers["retry-after"]) >= 1);
    } finally {
      host.close();
      await stopServer(server);
    }
  });
});
