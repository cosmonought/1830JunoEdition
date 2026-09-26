// server/src/ingress/live2aIngress.test.ts
//
// ==================================================================
//  LIVE-2A: THE INGRESS AND LEGACY-ROOM ATTACK SUITE (LIVE-2 §11, §12, §13.4, §15)
// ==================================================================
//
// Every case runs against the real server (`createGameServer`) over real WebSockets, frames sent back to back as
// a browser sends them (#1216). Numbers in the test names are the LIVE-2A brief's mandatory list; the §15 row each
// one certifies is named beside it. What LIVE-2 assigns to later passes is said where it would otherwise be looked
// for (the dev authenticator's proxy checks are LIVE-2B's, §4.8 / §16).
//
// LIVE-2D: the games are server-owned (GameRecords seating ALICE and BOB, `testSupport.seedGame`), every frame names a
// `gameId`, and the deal is the server's. The legacy room surface (§15 #2-#4, #9-#13) is now asserted REFUSED: each
// of its frames is an unknown kind or a malformed one to the closed schema -- `bad-frame`, nothing written -- and the
// property each case certified is asked again of the server-owned protocol that replaced it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { WebSocket } from "ws";

import { RoomEngine } from "../../../frontend/src/gameEngine/replayLog";
import { undoReachFor } from "../../../frontend/src/gameEngine/logRevert";
import { DEFAULT_INGRESS_LIMITS, excerpt } from "./limits";
import { mintGameId, type GameRecord } from "../rooms/gameRecord";
import { createMemoryRecordStore, type MemoryRecordStore } from "../rooms/recordStore";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  DEV_ORIGIN,
  devSocketUrl,
  type Frame,
  SETUP,
  controlledStore,
  openGame,
  quietConsole,
  seedGame,
  sleep,
  startServer,
  stopServer,
  storedLog,
  until,
} from "../rooms/testSupport";

quietConsole();

/** A socket's close code, whenever it comes. */
const closeCode = (client: Client): Promise<number> =>
  new Promise((resolve) => {
    if (client.socket.readyState === WebSocket.CLOSED) resolve(-1);
    client.socket.once("close", (code) => resolve(code));
  });

/** LIVE-2D: a controlled log store and a record store holding one server-owned game, Alice hosting and Bob seated.
 *  `dealt` (the default): its deal already durable at index 0, Alice on turn. Otherwise waiting, both seats ready. */
async function ownedGame(over: { dealt?: boolean } = {}) {
  const control = controlledStore();
  const records = createMemoryRecordStore();
  const dealt = over.dealt !== false;
  const gameId = await seedGame(records, [ALICE, BOB], { dealt });
  if (dealt) control.logs.set(gameId, storedLog(0));
  return { control, records, gameId };
}

async function roomDoc(port: number, claim: string, gameId: string): Promise<Client> {
  const client = await Client.open(port, claim);
  client.roomHello(gameId);
  await client.next((f) => f.kind === "presence", "the room-hello's presence frame");
  return client;
}

async function logClient(port: number, claim: string, gameId: string): Promise<Client> {
  const client = await Client.open(port, claim);
  client.hello(gameId);
  await client.next((f) => f.kind === "catch-up", "the hello's catch-up");
  return client;
}

/** Alice's and Bob's log clients on a dealt game, and the last index (the deal's). */
async function dealt(port: number, gameId: string): Promise<{ alice: Client; bob: Client; last: number }> {
  const alice = await logClient(port, ALICE, gameId);
  const bob = await logClient(port, BOB, gameId);
  const last = alice.seen().reduce((max, entry) => Math.max(max, entry.index), -1);
  assert.equal(last, 0, "the deal is the whole log");
  return { alice, bob, last };
}

const lastIndex = (frame: Frame): number => {
  const entries = frame.entries as Array<{ index: number }>;
  return entries[entries.length - 1].index;
};

const record = async (records: MemoryRecordStore, gameId: string): Promise<GameRecord> => (await records.load(gameId)) as GameRecord;

/* ================================================================== */
/*  Transport (LIVE-2 §11.3, §12.2)                                    */
/* ================================================================== */

describe("LIVE-2A transport limits", () => {
  test("1 (§15 #17): a frame over 32 KiB is closed 1009 and not a byte of it is parsed or stored", async () => {
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      assert.equal(server.limits.maxPayloadBytes, 32 * 1024);
      const alice = await logClient(port, ALICE, gameId);
      const closed = closeCode(alice);
      alice.submit({ WaterfallBuyLowest: { game_id: 0, junk: "x".repeat(33 * 1024) } }, { baseIndex: 0, submissionId: "big" });
      assert.equal(await closed, 1009);
      // A three-megabyte frame (LIVE-1's probe committed one) meets the same wall.
      const again = await logClient(port, ALICE, gameId);
      const closedAgain = closeCode(again);
      again.send({ kind: "chat-send", gameId, text: "y".repeat(3 * 1024 * 1024) });
      assert.equal(await closedAgain, 1009);
      assert.deepEqual(control.indices(gameId), [0]);
    } finally {
      await stopServer(server);
    }
  });

  test("2 (§15 #17): permessage-deflate is not negotiated even when the client offers it", async () => {
    const { server, port } = await startServer();
    try {
      const offered = new WebSocket(devSocketUrl(port, ALICE), { perMessageDeflate: true, origin: DEV_ORIGIN });
      await new Promise<void>((resolve, reject) => {
        offered.once("open", () => resolve());
        offered.once("error", reject);
      });
      assert.equal(offered.extensions, "", "no extension was agreed");
      offered.terminate();
    } finally {
      await stopServer(server);
    }
  });

  test("3 (§12.2 keepalive): a socket that never answers a ping is terminated; one that does stays", async () => {
    const { server, port } = await startServer({ limits: { pingIntervalMs: 40, pongTimeoutMs: 150 } });
    try {
      const silent = new WebSocket(devSocketUrl(port, ALICE), { autoPong: false, origin: DEV_ORIGIN } as unknown as ConstructorParameters<typeof WebSocket>[1]);
      const polite = new WebSocket(devSocketUrl(port, BOB), { origin: DEV_ORIGIN });
      await Promise.all(
        [silent, polite].map((socket) => new Promise<void>((resolve) => socket.once("open", () => resolve()))),
      );
      const silentClosed = new Promise<number>((resolve) => silent.once("close", (code) => resolve(code)));
      assert.equal(await silentClosed, 1006, "terminated, not closed politely");
      assert.ok(server.ingress.keepaliveTerminated >= 1);
      assert.equal(polite.readyState, WebSocket.OPEN, "the socket that answers its pings is kept");
      polite.terminate();
    } finally {
      await stopServer(server);
    }
  });

  test("4 (§11.3): more than the pending-frame cap in flight closes the socket 1008", async () => {
    const { control, records, gameId } = await ownedGame();
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records, limits: { maxPendingFrames: 4 } });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.maxPendingFrames, 64);
      const alice = await logClient(port, ALICE, gameId);
      const closed = closeCode(alice);
      alice.submit(BUY, { baseIndex: 0, submissionId: "held" }); // blocks this socket's chain at the disk
      const held = await control.nextHeldAppend();
      for (let n = 0; n < 6; n += 1) alice.send({ kind: "rooms-watch", on: true });
      assert.equal(await closed, 1008);
      assert.equal(server.ingress.pendingOverflowClosed, 1);
      held.release();
    } finally {
      await stopServer(server);
    }
  });

  test("5 (§11.3): a consumer that stops reading is closed 1013 once its buffer passes the cap", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({
      records,
      limits: {
        maxOutboundBufferedBytes: 64 * 1024,
        maxPendingFrames: 100_000,
        buckets: { chat: { capacity: 100_000, refillPerSecond: 100_000 } },
        rooms: { chatPerSeat: { capacity: 100_000, refillPerSecond: 100_000 } },
      },
    });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.maxOutboundBufferedBytes, 8 * 1024 * 1024);
      const watcher = await roomDoc(port, BOB, gameId);
      (watcher.socket as unknown as { _socket: { pause(): void } })._socket.pause();
      const talker = await roomDoc(port, ALICE, gameId);
      const line = "z".repeat(480);
      for (let batch = 0; batch < 40 && server.ingress.slowConsumerClosed === 0; batch += 1) {
        const before = talker.of("chat").length;
        for (let n = 0; n < 25; n += 1) talker.send({ kind: "chat-send", gameId, text: line });
        await until(() => talker.of("chat").length >= before + 25, "the talker's own chat frames");
      }
      assert.equal(server.ingress.slowConsumerClosed, 1, "the paused watcher was closed as a slow consumer");
      assert.equal(talker.open, true, "the reader that keeps up is untouched");
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2A per-socket buckets (§12.2, test 6)", () => {
  test("submit: burst 20 -- the 21st back-to-back submit is rate-limited, answered by id, and nothing is appended (§15 #29)", async () => {
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      assert.deepEqual(DEFAULT_INGRESS_LIMITS.buckets.submit, { capacity: 20, refillPerSecond: 3 });
      const bob = await logClient(port, BOB, gameId);
      for (let n = 1; n <= 25; n += 1) bob.submit({ PassTurn: { game_id: 0 } }, { baseIndex: -1, submissionId: `s${n}` });
      const answers: Frame[] = [];
      for (let n = 1; n <= 25; n += 1) answers.push(await bob.answerTo(`s${n}`));
      const limited = answers.filter((a) => a.code === "rate-limited");
      assert.ok(limited.length >= 4 && limited.length <= 5, `limited ${limited.length}`);
      assert.ok(answers.slice(0, 20).every((a) => a.code !== "rate-limited"));
      assert.ok(limited.every((a) => a.kind === "refused" && typeof a.retryAfterMs === "number" && (a.retryAfterMs as number) > 0));
      assert.deepEqual(control.indices(gameId), [0]);
    } finally {
      await stopServer(server);
    }
  });

  test("chat: burst 5 -- the sixth line is rate-limited and not broadcast", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ records });
    try {
      const alice = await roomDoc(port, ALICE, gameId);
      for (let n = 1; n <= 6; n += 1) alice.send({ kind: "chat-send", gameId, text: `line ${n}` });
      const limited = await alice.next((f) => f.kind === "error" && f.code === "rate-limited", "the chat refusal");
      assert.equal(typeof limited.retryAfterMs, "number");
      await sleep(30);
      const chats = alice.of("chat");
      const transcript = chats[chats.length - 1].messages as unknown[];
      assert.equal(transcript.length, 5);
    } finally {
      await stopServer(server);
    }
  });

  test("presence: burst 10 -- the eleventh hint is dropped, silently", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ records });
    try {
      const alice = await roomDoc(port, ALICE, gameId);
      for (let n = 0; n < 11; n += 1) alice.send({ kind: "presence-set", gameId, state: { routeValues: { 0: n } } });
      await until(() => alice.of("presence").length >= 11, "ten presence broadcasts after the hello's");
      await sleep(30);
      assert.equal(server.ingress.rateLimitedByBucket.presence, 1);
      assert.equal(alice.of("error").length, 0, "a dropped hint is not answered");
    } finally {
      await stopServer(server);
    }
  });

  test("hello: 10 a minute -- the eleventh full catch-up is refused", async () => {
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await Client.open(port, ALICE);
      for (let n = 0; n < 11; n += 1) alice.hello(gameId);
      const limited = await alice.next((f) => f.kind === "error" && f.code === "rate-limited", "the hello refusal");
      assert.ok(limited);
      assert.equal(alice.of("catch-up").length, 10);
    } finally {
      await stopServer(server);
    }
  });

  test("control (room-hello / rooms-watch): 30 a minute -- the 31st is refused", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ records });
    try {
      const alice = await Client.open(port, ALICE);
      for (let n = 0; n < 31; n += 1) alice.roomHello(gameId);
      await alice.next((f) => f.kind === "error" && f.code === "rate-limited", "the room-hello refusal");
      await sleep(30);
      assert.equal(alice.of("chat").length, 30, "thirty room-hellos answered (one transcript each), the 31st not");
      assert.equal(server.ingress.rateLimitedByBucket.control, 1);
    } finally {
      await stopServer(server);
    }
  });

  test("room ops: burst 10 -- the eleventh room operation is refused in the channel it listens on", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ records });
    try {
      const alice = await roomDoc(port, ALICE, gameId);
      const ids: string[] = [];
      for (let n = 0; n < 11; n += 1) ids.push(alice.roomOp({ type: "set-ready", ready: n % 2 === 0 }, gameId));
      const acks: Frame[] = [];
      for (const id of ids) acks.push(await alice.ack(id));
      const refused = acks.filter((ack) => ack.ok === false);
      assert.equal(refused.length, 1);
      assert.equal(refused[0].code, "rate-limited");
      assert.equal(typeof refused[0].retryAfterMs, "number");
      assert.match(String(refused[0].reason), /too quickly/);
    } finally {
      await stopServer(server);
    }
  });

  test("malformed: ten a minute -- the eleventh malformed frame closes the socket 1008", async () => {
    const { server, port } = await startServer();
    try {
      const alice = await Client.open(port, ALICE);
      const closed = closeCode(alice);
      for (let n = 0; n < 11; n += 1) alice.socket.send("{not json");
      assert.equal(await closed, 1008);
      assert.equal(alice.of("error").filter((f) => f.code === "bad-frame").length, 10);
      assert.equal(server.ingress.malformedClosed, 1);
    } finally {
      await stopServer(server);
    }
  });

  test("consecutive rate-limited answers close the socket 4429", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({
      records,
      limits: { maxConsecutiveRateLimited: 3, buckets: { chat: { capacity: 1, refillPerSecond: 0.001 } } },
    });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.maxConsecutiveRateLimited, 20);
      const alice = await roomDoc(port, ALICE, gameId);
      const closed = closeCode(alice);
      for (let n = 0; n < 5; n += 1) alice.send({ kind: "chat-send", gameId, text: `x${n}` });
      assert.equal(await closed, 4429);
      assert.equal(server.ingress.rateLimitClosed, 1);
    } finally {
      await stopServer(server);
    }
  });
});

/* ================================================================== */
/*  The gameplay parse (LIVE-2 §11.1, §11.2, §11.3)                     */
/* ================================================================== */

describe("LIVE-2A gameplay parse, over the wire", () => {
  test("7, 8, 9 (§15 #18): unknown fields -- top-level and nested -- are stripped from what the log commits", async () => {
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await logClient(port, ALICE, gameId);
      /* LIVE-2D: a client's deal is refused (the server deals at start-game) -- but only AFTER the parse, so its
         nested and top-level junk is stripped and counted before the refusal, and nothing of it is committed. */
      alice.submit(
        {
          SetupGame: {
            players: [
              { id: ALICE, nickname: "Alice", evil: "e".repeat(4000) },
              { id: BOB, nickname: "Bob" },
            ],
            variants: { gentleRust: false, evil: { deep: "d".repeat(4000) } },
            junk: "j".repeat(20_000),
          },
        },
        { baseIndex: 0, submissionId: "deal" },
      );
      const refusedDeal = await alice.answerTo("deal");
      assert.deepEqual([refusedDeal.kind, refusedDeal.code], ["refused", "bad-frame"]);
      assert.equal(server.ingress.stripped, 3);
      // A move the log does commit, carrying an undeclared field: committed without it.
      alice.submit({ WaterfallBuyLowest: { game_id: 0, evil: "e".repeat(4000) } }, { baseIndex: 0, submissionId: "buy" });
      const answer = await alice.answerTo("buy");
      assert.equal(answer.kind, "applied", JSON.stringify(answer).slice(0, 300));
      const stored = control.log(gameId);
      assert.equal(stored.length, 2);
      const payload = stored[1].payload;
      assert.ok(!payload.includes("junk") && !payload.includes("evil"), payload);
      assert.ok(payload.length < 1024, `the committed move is ${payload.length} bytes, not a multi-kilobyte one`);
      assert.deepEqual(JSON.parse(payload), { WaterfallBuyLowest: { game_id: 0 } });
      assert.equal(server.ingress.stripped, 4);
    } finally {
      await stopServer(server);
    }
  });

  test("10-16, 37 (§11.3, §11.1 item 4, §15 #38): malformed messages and envelopes are refused bad-frame with a fixed sentence", async () => {
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({
      store: control.store,
      records,
      limits: { buckets: { malformed: { capacity: 1000, refillPerSecond: 1000 } } },
    });
    try {
      const bob = await logClient(port, BOB, gameId);
      const cases: Array<[string, object]> = [
        ["10 unsafe integer", { BuyStock: { protocol_id: 1e300, source: "Ipo" } }],
        ["11 overlong id", { DiscardTrain: { protocol_id: 1, model_type: "m".repeat(33) } }],
        ["11 overlong summary", { RevertTo: { index: 1, player: BOB, summary: "s".repeat(161) } }],
        ["11 overlong narration", { SetBoPar: { player: "p".repeat(65), par_value: "100" } }],
        ["12 oversized array", { RunMultipleRoutes: { protocol_id: 1, routes: [], trains: Array(17).fill("2") } }],
        ["12 oversized roster", { SetupGame: { players: Array.from({ length: 17 }, (_, n) => ({ id: `p-${n}` })) } }],
        ["13 malformed waypoint", { RunManualRoute: { protocol_id: 1, path: [{ hex: 5 }], payout_strategy: "Withhold" } }],
        ["13 malformed player", { SetupGame: { players: [{ nickname: "no id" }] } }],
        ["13 malformed token city", { LayTile: { protocol_id: 1, q: 0, r: 0, tile_id: 7, orientation: 0, token_cities: [[1, 2, 3]] } }],
      ];
      cases.forEach(([, msg], n) => bob.submit(msg, { baseIndex: -1, submissionId: `c-${n}` }));
      for (let n = 0; n < cases.length; n += 1) {
        const answer = await bob.answerTo(`c-${n}`);
        assert.equal(answer.kind, "refused", cases[n][0]);
        assert.equal(answer.code, "bad-frame", cases[n][0]);
      }
      // 16, 37: inherited keys, anywhere -- written as raw JSON, because an object literal's `__proto__` sets the
      // prototype instead of carrying the key.
      const raw = [
        `{"kind":"submit","build":"${BUILD}","baseIndex":-1,"submissionId":"p1","msg":{"PassTurn":{"__proto__":{"polluted":"yes"}}}}`,
        `{"kind":"submit","build":"${BUILD}","baseIndex":-1,"submissionId":"p2","msg":{"constructor":{}}}`,
        `{"kind":"submit","build":"${BUILD}","baseIndex":-1,"submissionId":"p3","msg":{"toString":{}}}`,
        `{"kind":"submit","build":"${BUILD}","baseIndex":-1,"submissionId":"p4","msg":{"PassTurn":{"prototype":1}}}`,
      ];
      for (const text of raw) bob.socket.send(text);
      for (const id of ["p1", "p2", "p3", "p4"]) {
        const answer = await bob.answerTo(id);
        assert.equal(answer.code, "bad-frame", id);
        assert.ok(!/constructor|toString|__proto__|prototype|polluted/.test(String(answer.reason)), String(answer.reason));
      }
      assert.equal(({} as Record<string, unknown>).polluted, undefined, "no prototype was touched");
      // 14, 15: the submission id is required and bounded -- and a bad one is never echoed back.
      bob.send({ kind: "submit", build: BUILD, baseIndex: -1, msg: { PassTurn: { game_id: 0 } } });
      const missing = await bob.next((f) => f.kind === "refused" && f.inReplyTo === undefined, "the missing-id refusal");
      assert.equal(missing.code, "bad-frame");
      const long = "i".repeat(65);
      bob.send({ kind: "submit", build: BUILD, baseIndex: -1, submissionId: long, msg: { PassTurn: { game_id: 0 } } });
      const oversized = await bob.next((f) => f.kind === "refused" && f.code === "bad-frame", "the long-id refusal");
      assert.equal(oversized.inReplyTo, undefined);
      assert.ok(!JSON.stringify(oversized).includes(long));
      assert.deepEqual(control.indices(gameId), [0], "nothing malformed became history");
    } finally {
      await stopServer(server);
    }
  });

  test("37 (§15 #38): control frames are closed -- unknown and inherited kinds, keys and ops are bad-frame, never echoed", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({
      records,
      limits: { buckets: { malformed: { capacity: 1000, refillPerSecond: 1000 } } },
    });
    try {
      const before = await record(records, gameId);
      const alice = await roomDoc(port, ALICE, gameId);
      const texts = [
        `{"kind":"constructor"}`,
        `{"kind":"toString"}`,
        `{"kind":"__proto__"}`,
        `{"kind":"please-echo-me-7731"}`,
        `{"kind":"room-hello","gameId":"${gameId}","__proto__":{"polluted":1}}`,
        `{"kind":"room-hello","gameId":"${gameId}","extra-field-7731":1}`,
        `{"kind":"room-op","requestId":"r-7731","gameId":"${gameId}","op":{"type":"constructor"}}`,
        `{"kind":"room-op","requestId":"r-7732","gameId":"${gameId}","op":{"type":"__proto__"}}`,
        `{"kind":"room-op","requestId":"r-7733","gameId":"${gameId}","op":{"type":"set-ready","ready":true,"debug":true}}`,
        `{"kind":"presence-set","gameId":"${gameId}","state":{"routeDrafts":{"0":[[1,2]]},"sneaky":true}}`,
        `{"kind":"hello","gameId":"${gameId}","build":"${BUILD}","pin":"1234","debug":true}`,
      ];
      for (const text of texts) alice.socket.send(text);
      await until(() => alice.of("error").filter((f) => f.code === "bad-frame").length === texts.length, "every bad-frame");
      for (const frame of alice.of("error")) {
        assert.ok(!/7731|7732|7733|constructor|toString|__proto__|sneaky|debug|extra-field/.test(String(frame.reason)), String(frame.reason));
      }
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(alice.of("room-ack").length, 0, "a malformed operation is not answered as one");
      assert.deepEqual(await record(records, gameId), before, "no operation landed");
    } finally {
      await stopServer(server);
    }
  });

  test("17 (§15 #19): an exception's text never reaches the client -- a fixed sentence and a reference", async () => {
    const { control, records, gameId } = await ownedGame();
    const original = RoomEngine.prototype.submit;
    let armed = false;
    RoomEngine.prototype.submit = function (this: RoomEngine, ...args: Parameters<typeof original>) {
      if (armed) {
        armed = false;
        throw new Error("SECRET-REDUCER-7731 at /home/server/internal.ts:42");
      }
      return original.apply(this, args);
    } as typeof original;
    /* LIVE-2B: identity is no longer resolved inside a handler (it is the upgrade's), so the handler that throws
       here is `room-hello`'s game lookup: a record store whose read of one game fails with a secret in its message. */
    const throwing = mintGameId();
    const load = records.load.bind(records);
    records.load = async (id: string) => {
      if (id === throwing) throw new Error("SECRET-STORE-7731 at /home/server/internal.ts:42");
      return load(id);
    };
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await logClient(port, ALICE, gameId);
      armed = true; // after the load, which replays the stored deal through the same engine
      alice.submit(BUY, { baseIndex: 0, submissionId: "boom" });
      const answer = await alice.answerTo("boom");
      assert.equal(answer.code, "internal");
      assert.match(String(answer.reason), /\(ref [0-9A-Z]{6}\)$/);
      assert.ok(!JSON.stringify(answer).includes("SECRET"));
      assert.deepEqual(control.indices(gameId), [0]);
      // Any handler's throw: the same shape.
      const thrower = await Client.open(port, "p-thrower");
      thrower.roomHello(throwing);
      const generic = await thrower.next((f) => f.kind === "error", "the generic internal error");
      assert.equal(generic.code, "internal");
      assert.match(String(generic.reason), /\(ref [0-9A-Z]{6}\)$/);
      assert.ok(!JSON.stringify(thrower.frames).includes("SECRET"));
    } finally {
      RoomEngine.prototype.submit = original;
      await stopServer(server);
    }
  });

  test("18 (§11.6): a logged payload is an excerpt of at most 512 bytes, whatever arrived", async () => {
    assert.equal(DEFAULT_INGRESS_LIMITS.logExcerptBytes, 512);
    assert.ok(Buffer.byteLength(excerpt("é".repeat(30_000), 512)) <= 512);
    assert.ok(Buffer.byteLength(excerpt({ big: "x".repeat(30_000) }, 512)) <= 512);
    const { control, records, gameId } = await ownedGame();
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const bob = await logClient(port, BOB, gameId);
      bob.socket.send(`{"kind":"submit","nonsense":"${"n".repeat(30_000)}"}`);
      bob.submit({ BuyStock: { protocol_id: "x".repeat(30_000), source: "Ipo" } }, { baseIndex: -1, submissionId: "big-bad" });
      await bob.answerTo("big-bad");
      await sleep(20);
    } finally {
      Object.assign(console, saved);
      await stopServer(server);
      quietConsole();
    }
    const longest = Math.max(...lines.map((line) => Buffer.byteLength(line)));
    assert.ok(lines.some((line) => line.includes("bad-frame")), "the malformed frames were logged");
    assert.ok(longest < 1024, `the longest server line is ${longest} bytes`);
  });
});

/* ================================================================== */
/*  The legacy room surface (LIVE-2 §13.4 step 1) -- LIVE-2D: refused  */
/* ================================================================== */

describe("LIVE-2A legacy room attack surface (LIVE-2D: every legacy frame refused)", () => {
  /** Each legacy frame, sent once, is answered `bad-frame` -- an unknown kind, or a `room`-keyed frame the closed
   *  schema does not take -- and nothing more. */
  async function refusedAll(client: Client, frames: readonly object[]): Promise<void> {
    const before = client.of("error").filter((f) => f.code === "bad-frame").length;
    for (const frame of frames) client.send(frame);
    await until(() => client.of("error").filter((f) => f.code === "bad-frame").length === before + frames.length, `${frames.length} bad-frames`);
  }

  test("19 (§15 #6): `find-seats` is not a frame this server answers -- no PIN oracle", async () => {
    const { server, port } = await startServer();
    try {
      const probe = await Client.open(port, CAROL);
      probe.send({ kind: "find-seats", requestId: "r1", pin: "1234" });
      const answer = await probe.next((f) => f.kind === "error", "the refusal");
      assert.equal(answer.code, "bad-frame");
      await sleep(20);
      assert.equal(probe.of("seats").length, 0);
      const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "server", "src", "gameServer.ts"), "utf8");
      assert.ok(!source.includes('frame.kind === "find-seats"'), "the handler is deleted");
    } finally {
      await stopServer(server);
    }
  });

  test("20, 21 (§15 #11, #13): `room-write` is gone -- `variants` and `forced-sign` with it; the variants are the record's, fixed at create", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ records });
    try {
      const before = await record(records, gameId);
      const alice = await roomDoc(port, ALICE, gameId);
      await refusedAll(alice, [
        { kind: "room-write", room: gameId, write: { op: "variants", variants: { gentleRust: true, huge: "h".repeat(10_000) } } },
        { kind: "room-write", room: gameId, write: { op: "forced-sign", stage: "mark" } },
        { kind: "room-op", requestId: "rv", gameId, op: { type: "variants", variants: { gentleRust: true } } },
      ]);
      assert.deepEqual(await record(records, gameId), before, "nothing about the game moved");
    } finally {
      await stopServer(server);
    }
  });

  test("22, 23 (§15 #12): status is the server's -- no frame sets it; the server marks the game playing when its deal commits", async () => {
    const { control, records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const host = await roomDoc(port, ALICE, gameId);
      await refusedAll(host, [
        { kind: "room-write", room: gameId, write: { op: "status", status: "anything-at-all" } },
        { kind: "room-write", room: gameId, write: { op: "status", status: "playing" } },
        { kind: "room-op", requestId: "st", gameId, op: { type: "status", status: "playing" } },
      ]);
      assert.equal((await record(records, gameId)).status, "waiting");
      const views = host.of("room");
      assert.equal((views[views.length - 1].view as { status: string }).status, "waiting");
      assert.equal((await host.op({ type: "start-game" }, gameId)).ok, true);
      await host.next((f) => f.kind === "room" && (f.view as { status?: string }).status === "playing", "the playing broadcast");
      assert.equal(control.indices(gameId).length, 1, "the server's deal is durable before the view says playing");
      await until(() => (records.records.get(gameId) as GameRecord).status === "active", "the record following its log");
      // A legacy `playing` write after the deal is still just an unknown kind.
      await refusedAll(host, [{ kind: "room-write", room: gameId, write: { op: "status", status: "waiting" } }]);
      assert.equal((await record(records, gameId)).status, "active");
    } finally {
      await stopServer(server);
    }
  });

  test("24 (§15 #2): an operation reaches only a game the socket's principal holds a role in -- never one a frame merely names", async () => {
    const records = createMemoryRecordStore();
    const mine = await seedGame(records, [ALICE, BOB]);
    const { server, port } = await startServer({ records });
    try {
      /* Through the protocol, so the targets are server-minted player ids (the schema takes no other shape). */
      const { gameId: theirs, playerIds } = await openGame(port, CAROL, [BOB], { start: false });
      const before = await record(records, theirs);
      const alice = await roomDoc(port, ALICE, mine);
      await refusedAll(alice, [
        { kind: "room-write", room: theirs, write: { op: "kick", playerId: BOB } },
        { kind: "room-write", room: theirs, write: { op: "upsert-player", player: { id: ALICE, nickname: "Moved in", isReady: true } } },
      ]);
      // The server-owned operations name the game, and are authorized against the caller's role in THAT game.
      const kick = await alice.op({ type: "kick", playerId: playerIds[BOB] }, theirs);
      const transfer = await alice.op({ type: "transfer-host", toPlayerId: playerIds[BOB] }, theirs);
      const cancel = await alice.op({ type: "cancel-room" }, theirs);
      for (const refused of [kick, transfer, cancel]) assert.deepEqual([refused.ok, refused.code], [false, "forbidden"]);
      assert.deepEqual(await record(records, theirs), before);
      assert.deepEqual((await record(records, mine)).seats.map((seat) => seat.player_id), [ALICE, BOB]);
    } finally {
      await stopServer(server);
    }
  });

  test("25 (§15 #3): no frame can take over a game that exists, or make one in somebody else's name", async () => {
    const records = createMemoryRecordStore();
    const { server, port } = await startServer({ records });
    try {
      const { gameId } = await openGame(port, ALICE, [BOB], { start: false });
      const before = await record(records, gameId);
      const mallory = await roomDoc(port, CAROL, gameId);
      const roomsBefore = mallory.of("room").length;
      await refusedAll(mallory, [
        { kind: "room-write", room: gameId, write: { op: "host", hostId: CAROL, nickname: "Mallory", variants: {} } },
        // `create` names no game and no host: the creator is the caller, and the id is minted.
        { kind: "room-op", requestId: "c1", op: { type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "M", hostId: ALICE } },
        { kind: "room-op", requestId: "c2", gameId, op: { type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "M", gameId } },
      ]);
      await sleep(20);
      assert.equal(mallory.of("room").length, roomsBefore);
      assert.deepEqual(await record(records, gameId), before);
      const bobsSeat = before.seats[1].player_id;
      assert.equal((await mallory.op({ type: "transfer-host", toPlayerId: bobsSeat }, gameId)).code, "forbidden");
      assert.equal((await mallory.op({ type: "kick", playerId: bobsSeat }, gameId)).code, "forbidden");
      // A create is always a NEW game, hosted by its caller.
      const made = await mallory.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Mallory" });
      assert.equal(made.ok, true);
      assert.notEqual((made.data as { gameId: string }).gameId, gameId);
      assert.deepEqual(await record(records, gameId), before);
    } finally {
      await stopServer(server);
    }
  });

  test("26 (§15 #4): a seat's profile is written only by the seat's own principal", async () => {
    const { records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ records });
    try {
      const bob = await roomDoc(port, BOB, gameId);
      await refusedAll(bob, [
        { kind: "room-write", room: gameId, write: { op: "upsert-player", player: { id: ALICE, nickname: "pwned", isReady: true } } },
        // `set-profile` carries no player id: the seat is the caller's.
        { kind: "room-op", requestId: "sp", gameId, op: { type: "set-profile", playerId: ALICE, nickname: "pwned" } },
      ]);
      assert.equal((await record(records, gameId)).seats[0].nickname, ALICE);
      // His own seat is his to write -- and the nickname passes the one sanitizer (§11.2).
      assert.equal((await bob.op({ type: "set-profile", nickname: "Bob‮\u0007 the  Builder" }, gameId)).ok, true);
      const seats = (await record(records, gameId)).seats;
      assert.deepEqual(seats.map((seat) => seat.nickname), [ALICE, "Bob the Builder"]);
    } finally {
      await stopServer(server);
    }
  });

  test("27, 28, 29 (§15 #9, #10): no client deals -- a `SetupGame` is refused whoever sends it; the server's deal seats one player per seat", async () => {
    const { control, records, gameId } = await ownedGame({ dealt: false });
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const stranger = await logClient(port, CAROL, gameId);
      stranger.submit({ SetupGame: { players: [{ id: CAROL }, { id: BOB }], variants: {} } }, { baseIndex: -1, submissionId: "stranger" });
      const alice = await logClient(port, ALICE, gameId);
      alice.submit({ SetupGame: { players: [{ id: ALICE }, { id: ALICE }], variants: {} } }, { baseIndex: -1, submissionId: "twice" });
      alice.submit(SETUP, { baseIndex: -1, submissionId: "legal-looking" });
      for (const [client, id] of [[stranger, "stranger"], [alice, "twice"], [alice, "legal-looking"]] as const) {
        const answer = await client.answerTo(id);
        assert.deepEqual([answer.kind, answer.code], ["refused", "bad-frame"], id);
        assert.match(String(answer.reason), /press Start/, id);
      }
      assert.deepEqual(control.indices(gameId), []);

      assert.equal((await alice.op({ type: "start-game" }, gameId)).ok, true);
      await until(() => control.indices(gameId).length === 1, "the server's deal");
      const deal = JSON.parse(control.log(gameId)[0].payload).SetupGame as { players: Array<{ id: string }> };
      assert.deepEqual(deal.players.map((player) => player.id), [ALICE, BOB], "one player per seat, each the seat's own id");
    } finally {
      await stopServer(server);
    }
  });
});

/* ================================================================== */
/*  Undo authority (LIVE-2 §9.2) and the log's bounds (§12.2)           */
/* ================================================================== */

describe("LIVE-2A undo and revert authority", () => {
  test("30, 31, 34 (§15 #15): the deal is a floor, a target must be live, and a crafted RevertTo reaches no further than the button", async () => {
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const { alice, bob, last } = await dealt(port, gameId);
      alice.submit(BUY, { baseIndex: last, submissionId: "a-buy" });
      const aliceBuy = await alice.answerTo("a-buy");
      assert.equal(aliceBuy.kind, "applied");
      bob.submit(BUY, { baseIndex: lastIndex(aliceBuy), submissionId: "b-buy" });
      const bobBuy = await bob.answerTo("b-buy");
      assert.equal(bobBuy.kind, "applied");
      const before = control.indices(gameId);
      const at = lastIndex(bobBuy);
      const revert = (index: number, player: string) => ({ RevertTo: { index, player, summary: "undo" } });

      const cases: Array<[Client, number, string, RegExp]> = [
        [alice, 0, "rv-deal", /The deal cannot be undone/],
        [alice, -5, "rv-before", /nothing at that point/],
        [alice, 99, "rv-past", /nothing at that point/],
        [alice, (aliceBuy.entries as Array<{ index: number }>)[0].index, "rv-deep", /Only the most recent action can be undone/],
        [bob, (aliceBuy.entries as Array<{ index: number }>)[0].index, "rv-not-his", /Only the host can undo/],
      ];
      for (const [who, index, id] of cases) who.submit(revert(index, who.claim), { baseIndex: at, submissionId: id });
      for (const [who, , id, reason] of cases) {
        const answer = await who.answerTo(id);
        assert.equal(answer.kind, "refused", id);
        assert.match(String(answer.reason), reason, id);
      }
      assert.deepEqual(control.indices(gameId), before, "no refused revert appended anything");

      // The button's reach, computed from the same log, is exactly what the server accepts.
      const reach = undoReachFor(control.log(gameId), ALICE, true, () => "x");
      assert.equal(reach.index, (bobBuy.entries as Array<{ index: number }>)[0].index);
      alice.submit(revert(reach.index as number, BOB), { baseIndex: at, submissionId: "reach" });
      const ok = await alice.answerTo("reach");
      assert.equal(ok.kind, "applied");
      const committed = JSON.parse(control.log(gameId).find((e) => e.submission_id === "reach")!.payload);
      assert.equal(committed.RevertTo.player, ALICE, "the committed revert names who pressed it, not the frame's claim");
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("35 (§15 #37): undo churn is budgeted -- own reverts and the host's reverts of others, per hour", async () => {
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({
      store: control.store,
      records,
      limits: { selfRevertsPerHour: 2, hostRevertsOfOthersPerHour: 1 },
    });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.selfRevertsPerHour, 30);
      assert.equal(DEFAULT_INGRESS_LIMITS.hostRevertsOfOthersPerHour, 10);
      const { alice, last } = await dealt(port, gameId);
      let at = last;
      let n = 0;
      const step = async (who: Client, msg: object): Promise<Frame> => {
        n += 1;
        who.submit(msg, { baseIndex: at, submissionId: `m${n}` });
        const answer = await who.answerTo(`m${n}`);
        if (answer.kind === "applied") at = lastIndex(answer);
        return answer;
      };
      for (let round = 1; round <= 3; round += 1) {
        const buy = await step(alice, BUY);
        assert.equal(buy.kind, "applied");
        const target = (buy.entries as Array<{ index: number }>)[0].index;
        const undo = await step(alice, { RevertTo: { index: target, player: ALICE, summary: "undo" } });
        if (round <= 2) assert.equal(undo.kind, "applied", `revert ${round}`);
        else {
          assert.equal(undo.code, "rate-limited", "the third self-revert in the hour");
          assert.equal(typeof undo.retryAfterMs, "number");
        }
      }
      assert.equal(server.ingress.revertBudgetRefused, 1);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("36 (§12.2): the log has a length cap -- a submit past it is refused log-full and appends nothing", async () => {
    assert.equal(DEFAULT_INGRESS_LIMITS.logEntryCap, 10_000);
    assert.equal(DEFAULT_INGRESS_LIMITS.logEntryAlarm, 5_000);
    const { control, records, gameId } = await ownedGame();
    const { server, port } = await startServer({ store: control.store, records, limits: { logEntryCap: 2 } });
    try {
      const { alice, last } = await dealt(port, gameId);
      alice.submit(BUY, { baseIndex: last, submissionId: "buy" });
      const buy = await alice.answerTo("buy");
      assert.equal(buy.kind, "applied");
      const length = control.indices(gameId).length;
      assert.ok(length >= 2);
      alice.submit({ PassTurn: { game_id: 0 } }, { baseIndex: lastIndex(buy), submissionId: "over" });
      const over = await alice.answerTo("over");
      assert.equal(over.code, "log-full");
      assert.equal(control.indices(gameId).length, length);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });
});

/* ================================================================== */
/*  Identity posture and push scope                                    */
/* ================================================================== */

describe("LIVE-2A identity posture and push scope", () => {
  test("38 (§15 #39 is LIVE-2B's): the dev identity path trusts no forwarding header, and the server is loopback-only", async () => {
    /* LIVE-2 §4.8 / §16 place the dev authenticator's loopback-peer and no-forwarding-header checks in LIVE-2B, with
       `authenticateUpgrade`; enforcing them here would cut the sanctioned tunnelled playtest (proxy -> 127.0.0.1)
       before 2B's production mode exists (§19 R6). What 2A certifies is that it added no new trust: nothing in the
       server reads a forwarded address or host, and the socket is bound to loopback (LIVE-0). */
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "server", "src", "gameServer.ts"), "utf8");
    assert.ok(!/x-forwarded|x-real-ip|\bforwarded\b/i.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    const { server } = await startServer();
    try {
      const bound = server.http.address();
      assert.equal(typeof bound === "object" && bound !== null ? bound.address : null, "127.0.0.1");
    } finally {
      await stopServer(server);
    }
  });

  test("39 (§15 #40): room, chat and presence pushes reach only the readers of their own game", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const here = await seedGame(records, [ALICE, BOB]);
    const elsewhere = await seedGame(records, [CAROL, "p-dave"]);
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const bob = await roomDoc(port, BOB, here);
      const carol = await roomDoc(port, CAROL, elsewhere);
      const carolFrames = carol.frames.length;
      bob.send({ kind: "chat-send", gameId: here, text: "hello room" });
      bob.send({ kind: "presence-set", gameId: here, state: { routeValues: { 0: 10 } } });
      // A chat naming a game this socket does not read is refused -- not delivered there.
      bob.send({ kind: "chat-send", gameId: elsewhere, text: "hello other room" });
      const alice = await roomDoc(port, ALICE, here);
      assert.equal((await alice.op({ type: "start-game" }, here)).ok, true); // the server's own `playing` push for `here`
      await bob.next((f) => f.kind === "room" && (f.view as { status?: string }).status === "playing", "the playing broadcast");
      await sleep(30);
      assert.equal(carol.frames.length, carolFrames, "nothing of one game's reached the other's reader");
      const refusals = bob.of("error").filter((f) => f.code === "forbidden");
      assert.equal(refusals.length, 1, "a chat naming another game is refused");
      assert.match(String(refusals[0].reason), /Open the table first/);
      const lines = carol.of("chat").flatMap((f) => f.messages as Array<{ text: string }>);
      assert.equal(lines.some((line) => /hello/.test(line.text)), false);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });
});
