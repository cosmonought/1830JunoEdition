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

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { WebSocket } from "ws";

import { RoomEngine } from "../../../frontend/src/gameEngine/replayLog";
import { undoReachFor } from "../../../frontend/src/gameEngine/logRevert";
import { DEFAULT_INGRESS_LIMITS, excerpt } from "./limits";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  type Frame,
  SETUP,
  controlledStore,
  hostedDoc,
  quietConsole,
  sleep,
  startServer,
  stopServer,
  until,
} from "../rooms/testSupport";

quietConsole();

const ROOM = "L2A";
const OTHER = "L2B";

/** A socket's close code, whenever it comes. */
const closeCode = (client: Client): Promise<number> =>
  new Promise((resolve) => {
    if (client.socket.readyState === WebSocket.CLOSED) resolve(-1);
    client.socket.once("close", (code) => resolve(code));
  });

/** A controlled store with `room` already hosted by Alice. */
function hostedStore(...rooms: string[]) {
  const control = controlledStore();
  for (const room of rooms.length > 0 ? rooms : [ROOM]) control.docs.set(room, JSON.stringify(hostedDoc(room, ALICE)));
  return control;
}

async function roomDoc(port: number, claim: string, room: string): Promise<Client> {
  const client = await Client.open(port, claim);
  client.roomHello(room);
  await client.next((f) => f.kind === "presence", "the room-hello's presence frame");
  return client;
}

async function logClient(port: number, claim: string, room = ROOM): Promise<Client> {
  const client = await Client.open(port, claim);
  client.hello(room);
  await client.next((f) => f.kind === "catch-up", "the hello's catch-up");
  return client;
}

/** Deal ROOM (hosted by Alice) and return Alice's log client and the entries so far. */
async function dealt(port: number): Promise<{ alice: Client; bob: Client; last: number }> {
  const alice = await logClient(port, ALICE);
  const bob = await logClient(port, BOB);
  alice.submit(SETUP, { baseIndex: -1, submissionId: "deal" });
  const answer = await alice.answerTo("deal");
  assert.equal(answer.kind, "applied", JSON.stringify(answer));
  const entries = answer.entries as Array<{ index: number }>;
  return { alice, bob, last: entries[entries.length - 1].index };
}

const lastIndex = (frame: Frame): number => {
  const entries = frame.entries as Array<{ index: number }>;
  return entries[entries.length - 1].index;
};

const payloads = (entries: ReadonlyArray<{ payload: string }>) => entries.map((entry) => entry.payload);

/* ================================================================== */
/*  Transport (LIVE-2 §11.3, §12.2)                                    */
/* ================================================================== */

describe("LIVE-2A transport limits", () => {
  test("1 (§15 #17): a frame over 32 KiB is closed 1009 and not a byte of it is parsed or stored", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      assert.equal(server.limits.maxPayloadBytes, 32 * 1024);
      const alice = await logClient(port, ALICE);
      const closed = closeCode(alice);
      alice.submit({ SetupGame: { players: [], variants: {}, junk: "x".repeat(33 * 1024) } }, { baseIndex: -1, submissionId: "big" });
      assert.equal(await closed, 1009);
      // A three-megabyte frame (LIVE-1's probe committed one) meets the same wall.
      const again = await logClient(port, ALICE);
      const closedAgain = closeCode(again);
      again.send({ kind: "chat-send", room: ROOM, text: "y".repeat(3 * 1024 * 1024) });
      assert.equal(await closedAgain, 1009);
      assert.deepEqual(control.indices(ROOM), []);
    } finally {
      await stopServer(server);
    }
  });

  test("2 (§15 #17): permessage-deflate is not negotiated even when the client offers it", async () => {
    const { server, port } = await startServer();
    try {
      const offered = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
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
      const silent = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false } as unknown as ConstructorParameters<typeof WebSocket>[1]);
      const polite = new WebSocket(`ws://127.0.0.1:${port}`);
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
    const control = hostedStore();
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, limits: { maxPendingFrames: 4 } });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.maxPendingFrames, 64);
      const alice = await logClient(port, ALICE);
      const closed = closeCode(alice);
      alice.submit(SETUP, { baseIndex: -1, submissionId: "held" }); // blocks this socket's chain at the disk
      const held = await control.nextHeldAppend();
      for (let n = 0; n < 6; n += 1) alice.send({ kind: "lobby-hello" });
      assert.equal(await closed, 1008);
      assert.equal(server.ingress.pendingOverflowClosed, 1);
      held.release();
    } finally {
      await stopServer(server);
    }
  });

  test("5 (§11.3): a consumer that stops reading is closed 1013 once its buffer passes the cap", async () => {
    const { server, port } = await startServer({
      limits: {
        maxOutboundBufferedBytes: 64 * 1024,
        maxPendingFrames: 100_000,
        buckets: { chat: { capacity: 100_000, refillPerSecond: 100_000 } },
      },
    });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.maxOutboundBufferedBytes, 8 * 1024 * 1024);
      const watcher = await roomDoc(port, BOB, ROOM);
      (watcher.socket as unknown as { _socket: { pause(): void } })._socket.pause();
      const talker = await roomDoc(port, ALICE, ROOM);
      const line = "z".repeat(480);
      for (let batch = 0; batch < 40 && server.ingress.slowConsumerClosed === 0; batch += 1) {
        const before = talker.of("chat").length;
        for (let n = 0; n < 25; n += 1) talker.send({ kind: "chat-send", room: ROOM, text: line, displayName: "Alice" });
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
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      assert.deepEqual(DEFAULT_INGRESS_LIMITS.buckets.submit, { capacity: 20, refillPerSecond: 3 });
      const bob = await logClient(port, BOB);
      for (let n = 1; n <= 25; n += 1) bob.submit({ PassTurn: { game_id: 0 } }, { baseIndex: -1, submissionId: `s${n}` });
      const answers: Frame[] = [];
      for (let n = 1; n <= 25; n += 1) answers.push(await bob.answerTo(`s${n}`));
      const limited = answers.filter((a) => a.code === "rate-limited");
      assert.ok(limited.length >= 4 && limited.length <= 5, `limited ${limited.length}`);
      assert.ok(answers.slice(0, 20).every((a) => a.code !== "rate-limited"));
      assert.ok(limited.every((a) => a.kind === "refused" && typeof a.retryAfterMs === "number" && (a.retryAfterMs as number) > 0));
      assert.deepEqual(control.indices(ROOM), []);
    } finally {
      await stopServer(server);
    }
  });

  test("chat: burst 5 -- the sixth line is rate-limited and not broadcast", async () => {
    const { server, port } = await startServer();
    try {
      const alice = await roomDoc(port, ALICE, ROOM);
      for (let n = 1; n <= 6; n += 1) alice.send({ kind: "chat-send", room: ROOM, text: `line ${n}`, displayName: "Alice" });
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
    const { server, port } = await startServer();
    try {
      const alice = await roomDoc(port, ALICE, ROOM);
      for (let n = 0; n < 11; n += 1) alice.send({ kind: "presence-set", room: ROOM, state: { routeValues: { 0: n } } });
      await until(() => alice.of("presence").length >= 11, "ten presence broadcasts after the hello's");
      await sleep(30);
      assert.equal(server.ingress.rateLimitedByBucket.presence, 1);
      assert.equal(alice.of("error").length, 0, "a dropped hint is not answered");
    } finally {
      await stopServer(server);
    }
  });

  test("hello: 10 a minute -- the eleventh full catch-up is refused", async () => {
    const { server, port } = await startServer();
    try {
      const alice = await Client.open(port, ALICE);
      for (let n = 0; n < 11; n += 1) alice.hello(ROOM);
      const limited = await alice.next((f) => f.kind === "error" && f.code === "rate-limited", "the hello refusal");
      assert.ok(limited);
      assert.equal(alice.of("catch-up").length, 10);
    } finally {
      await stopServer(server);
    }
  });

  test("control (room-hello / lobby-hello / lobby-watch): 30 a minute -- the 31st is refused", async () => {
    const { server, port } = await startServer();
    try {
      const alice = await Client.open(port, ALICE);
      for (let n = 0; n < 31; n += 1) alice.roomHello(ROOM);
      await alice.next((f) => f.kind === "error" && f.code === "rate-limited", "the room-hello refusal");
      assert.equal(alice.of("room").length, 30);
    } finally {
      await stopServer(server);
    }
  });

  test("room ops: burst 10 -- the eleventh room write is refused in the channel a join listens on", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const alice = await roomDoc(port, ALICE, ROOM);
      for (let n = 0; n < 11; n += 1) {
        alice.roomWrite(ROOM, { op: "upsert-player", player: { id: ALICE, nickname: "Alice", isReady: n % 2 === 0 } });
      }
      const refused = await alice.next((f) => f.kind === "error" && f.code === "room-write-refused", "the room-op refusal");
      assert.match(String(refused.reason), /too quickly/);
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
    const { server, port } = await startServer({
      limits: { maxConsecutiveRateLimited: 3, buckets: { chat: { capacity: 1, refillPerSecond: 0.001 } } },
    });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.maxConsecutiveRateLimited, 20);
      const alice = await roomDoc(port, ALICE, ROOM);
      const closed = closeCode(alice);
      for (let n = 0; n < 5; n += 1) alice.send({ kind: "chat-send", room: ROOM, text: `x${n}` });
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
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const alice = await logClient(port, ALICE);
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
        { baseIndex: -1, submissionId: "deal" },
      );
      const answer = await alice.answerTo("deal");
      assert.equal(answer.kind, "applied", JSON.stringify(answer).slice(0, 300));
      const stored = control.log(ROOM);
      assert.equal(stored.length, 1);
      const payload = stored[0].payload;
      assert.ok(!payload.includes("junk") && !payload.includes("evil"), payload);
      assert.ok(payload.length < 1024, `the committed deal is ${payload.length} bytes, not a multi-kilobyte one`);
      assert.deepEqual(JSON.parse(payload).SetupGame.players, [
        { id: ALICE, nickname: "Alice" },
        { id: BOB, nickname: "Bob" },
      ]);
      assert.equal(server.ingress.stripped, 3);
    } finally {
      await stopServer(server);
    }
  });

  test("10-16, 37 (§11.3, §11.1 item 4, §15 #38): malformed messages and envelopes are refused bad-frame with a fixed sentence", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({
      store: control.store,
      limits: { buckets: { malformed: { capacity: 1000, refillPerSecond: 1000 } } },
    });
    try {
      const bob = await logClient(port, BOB);
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
      assert.deepEqual(control.indices(ROOM), [], "nothing malformed became history");
    } finally {
      await stopServer(server);
    }
  });

  test("37 (§15 #38): control frames are closed -- unknown and inherited kinds, keys and ops are bad-frame, never echoed", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({
      store: control.store,
      limits: { buckets: { malformed: { capacity: 1000, refillPerSecond: 1000 } } },
    });
    try {
      const alice = await roomDoc(port, ALICE, ROOM);
      const texts = [
        `{"kind":"constructor"}`,
        `{"kind":"toString"}`,
        `{"kind":"__proto__"}`,
        `{"kind":"please-echo-me-7731"}`,
        `{"kind":"room-hello","room":"${ROOM}","claim":"${ALICE}","__proto__":{"polluted":1}}`,
        `{"kind":"room-hello","room":"${ROOM}","claim":"${ALICE}","extra-field-7731":1}`,
        `{"kind":"room-write","room":"${ROOM}","write":{"op":"constructor"}}`,
        `{"kind":"room-write","room":"${ROOM}","write":{"op":"__proto__"}}`,
        `{"kind":"presence-set","room":"${ROOM}","state":{"routeDrafts":{"0":[[1,2]]},"sneaky":true}}`,
        `{"kind":"hello","room":"${ROOM}","build":"${BUILD}","claim":"${ALICE}","pin":"1234","debug":true}`,
      ];
      for (const text of texts) alice.socket.send(text);
      await until(() => alice.of("error").filter((f) => f.code === "bad-frame").length === texts.length, "every bad-frame");
      for (const frame of alice.of("error")) {
        assert.ok(!/7731|constructor|toString|__proto__|sneaky|debug|extra-field/.test(String(frame.reason)), String(frame.reason));
      }
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(control.doc(ROOM)?.players.length, 1, "no write landed");
    } finally {
      await stopServer(server);
    }
  });

  test("17 (§15 #19): an exception's text never reaches the client -- a fixed sentence and a reference", async () => {
    const control = hostedStore();
    const original = RoomEngine.prototype.submit;
    let armed = true;
    RoomEngine.prototype.submit = function (this: RoomEngine, ...args: Parameters<typeof original>) {
      if (armed) {
        armed = false;
        throw new Error("SECRET-REDUCER-7731 at /home/server/internal.ts:42");
      }
      return original.apply(this, args);
    } as typeof original;
    const { server, port } = await startServer({
      store: control.store,
      resolveIdentity: async ({ claim }) => {
        if (claim === "p-thrower") throw new Error("SECRET-IDENTITY-7731");
        return typeof claim === "string" && claim !== "" ? claim : null;
      },
    });
    try {
      const alice = await logClient(port, ALICE);
      alice.submit(SETUP, { baseIndex: -1, submissionId: "boom" });
      const answer = await alice.answerTo("boom");
      assert.equal(answer.code, "internal");
      assert.match(String(answer.reason), /\(ref [0-9A-Z]{6}\)$/);
      assert.ok(!JSON.stringify(answer).includes("SECRET"));
      assert.deepEqual(control.indices(ROOM), []);
      // Any handler's throw: the same shape.
      const thrower = await Client.open(port, "p-thrower");
      thrower.roomHello(ROOM);
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
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    const { server, port } = await startServer();
    try {
      const bob = await logClient(port, BOB);
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
/*  The legacy room surface (LIVE-2 §13.4 step 1)                       */
/* ================================================================== */

describe("LIVE-2A legacy room attack surface", () => {
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

  test("20, 21 (§15 #11, #13): the `variants` and `forced-sign` room writes are gone", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const alice = await roomDoc(port, ALICE, ROOM);
      alice.roomWrite(ROOM, { op: "variants", variants: { gentleRust: true, huge: "h".repeat(10_000) } });
      alice.roomWrite(ROOM, { op: "forced-sign", stage: "mark" });
      await until(() => alice.of("error").filter((f) => f.code === "bad-frame").length === 2, "two bad-frames");
      const doc = control.doc(ROOM);
      assert.deepEqual(doc?.variants, {});
      assert.equal(doc?.forcedSign, null);
    } finally {
      await stopServer(server);
    }
  });

  test("22, 23 (§15 #12): status is the server's -- a client cannot set it; the server marks playing when the deal commits", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const host = await roomDoc(port, ALICE, ROOM);
      host.roomWrite(ROOM, { op: "status", status: "anything-at-all" });
      const refused = await host.next((f) => f.kind === "error", "the status refusal");
      assert.equal(refused.code, "room-write-refused");
      host.roomWrite(ROOM, { op: "status", status: "playing" }); // before the deal: an echo, nothing changes
      // The hello's room, the refusal's re-sent room, then the echo -- to the writer alone.
      await until(() => host.of("room").length >= 3, "the echo");
      const rooms = host.of("room");
      assert.equal((rooms[rooms.length - 1].doc as { status: string }).status, "waiting");
      assert.equal(control.doc(ROOM)?.status, "waiting");
      const { alice } = await dealt(port);
      const playing = await host.next((f) => f.kind === "room" && (f.doc as { status?: string } | null)?.status === "playing", "the playing broadcast");
      assert.ok(playing);
      assert.equal(control.doc(ROOM)?.status, "playing");
      // The legacy client's own `playing` write after the deal is still harmless: an echo of what the server set.
      host.roomWrite(ROOM, { op: "status", status: "playing" });
      await sleep(20);
      assert.equal(control.doc(ROOM)?.status, "playing");
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("24 (§15 #2): a room write goes to the socket's own room, never to the room a frame names", async () => {
    const control = hostedStore(ROOM, OTHER);
    const { server, port } = await startServer({ store: control.store });
    try {
      const alice = await roomDoc(port, ALICE, ROOM);
      alice.roomWrite(OTHER, { op: "kick", playerId: BOB });
      alice.roomWrite(OTHER, { op: "upsert-player", player: { id: ALICE, nickname: "Moved in", isReady: true } });
      await until(() => alice.of("error").filter((f) => f.code === "room-write-refused").length === 2, "two refusals");
      assert.deepEqual(control.doc(OTHER), hostedDoc(OTHER, ALICE));
      assert.deepEqual(control.doc(ROOM), hostedDoc(ROOM, ALICE));
    } finally {
      await stopServer(server);
    }
  });

  test("25 (§15 #3): `host` cannot overwrite a room that exists -- answered room-code-taken, and the room is not re-sent", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const mallory = await roomDoc(port, CAROL, ROOM);
      const roomsBefore = mallory.of("room").length;
      mallory.roomWrite(ROOM, { op: "host", hostId: CAROL, nickname: "Mallory", variants: {} });
      const taken = await mallory.next((f) => f.kind === "error", "the refusal");
      assert.equal(taken.code, "room-code-taken");
      await sleep(20);
      assert.equal(mallory.of("room").length, roomsBefore);
      assert.equal(control.doc(ROOM)?.hostId, ALICE);
      assert.equal(control.calls.saveRoomDoc, 0);
      // Nor can a room be hosted in somebody else's name.
      const fresh = await roomDoc(port, CAROL, "FRESH");
      fresh.roomWrite("FRESH", { op: "host", hostId: ALICE, nickname: "Not Alice", variants: {} });
      assert.equal((await fresh.next((f) => f.kind === "error", "the refusal")).code, "room-write-refused");
      assert.equal(control.doc("FRESH"), null);
    } finally {
      await stopServer(server);
    }
  });

  test("26 (§15 #4): upsert-player writes only the writer's own seat", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const bob = await roomDoc(port, BOB, ROOM);
      bob.roomWrite(ROOM, { op: "upsert-player", player: { id: ALICE, nickname: "pwned", isReady: true } });
      const refused = await bob.next((f) => f.kind === "error", "the refusal");
      assert.equal(refused.code, "room-write-refused");
      assert.deepEqual(control.doc(ROOM)?.players, [{ id: ALICE, nickname: ALICE, isReady: false }]);
      // His own seat is his to write -- and the nickname passes the one sanitizer (§11.2).
      bob.roomWrite(ROOM, { op: "upsert-player", player: { id: BOB, nickname: "Bob‮\u0007 the  Builder", isReady: true } });
      await until(() => (control.doc(ROOM)?.players.length ?? 0) === 2, "Bob seated");
      assert.equal(control.doc(ROOM)?.players[1].nickname, "Bob the Builder");
    } finally {
      await stopServer(server);
    }
  });

  test("27, 28, 29 (§15 #9, #10): the deal needs a hosted room and one seat per player; a legal one still deals", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const stranger = await logClient(port, CAROL, "INVENTED");
      stranger.submit({ SetupGame: { players: [{ id: CAROL }, { id: BOB }], variants: {} } }, { baseIndex: -1, submissionId: "docless" });
      const docless = await stranger.answerTo("docless");
      assert.equal(docless.kind, "refused");
      assert.match(String(docless.reason), /no host/);
      assert.deepEqual(control.indices("INVENTED"), []);

      const alice = await logClient(port, ALICE);
      alice.submit({ SetupGame: { players: [{ id: ALICE }, { id: ALICE }], variants: {} } }, { baseIndex: -1, submissionId: "twice" });
      const twice = await alice.answerTo("twice");
      assert.equal(twice.kind, "refused");
      assert.equal(twice.reason, "Every seat at the table must be a different player.");
      assert.deepEqual(control.indices(ROOM), []);

      alice.submit(SETUP, { baseIndex: -1, submissionId: "legal" });
      assert.equal((await alice.answerTo("legal")).kind, "applied");
      assert.deepEqual(control.indices(ROOM), [0]);
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
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const { alice, bob, last } = await dealt(port);
      alice.submit(BUY, { baseIndex: last, submissionId: "a-buy" });
      const aliceBuy = await alice.answerTo("a-buy");
      assert.equal(aliceBuy.kind, "applied");
      bob.submit(BUY, { baseIndex: lastIndex(aliceBuy), submissionId: "b-buy" });
      const bobBuy = await bob.answerTo("b-buy");
      assert.equal(bobBuy.kind, "applied");
      const before = control.indices(ROOM);
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
      assert.deepEqual(control.indices(ROOM), before, "no refused revert appended anything");

      // The button's reach, computed from the same log, is exactly what the server accepts.
      const reach = undoReachFor(control.log(ROOM), ALICE, true, () => "x");
      assert.equal(reach.index, (bobBuy.entries as Array<{ index: number }>)[0].index);
      alice.submit(revert(reach.index as number, BOB), { baseIndex: at, submissionId: "reach" });
      const ok = await alice.answerTo("reach");
      assert.equal(ok.kind, "applied");
      const committed = JSON.parse(control.log(ROOM).find((e) => e.submission_id === "reach")!.payload);
      assert.equal(committed.RevertTo.player, ALICE, "the committed revert names who pressed it, not the frame's claim");
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("35 (§15 #37): undo churn is budgeted -- own reverts and the host's reverts of others, per hour", async () => {
    const control = hostedStore();
    const { server, port } = await startServer({
      store: control.store,
      limits: { selfRevertsPerHour: 2, hostRevertsOfOthersPerHour: 1 },
    });
    try {
      assert.equal(DEFAULT_INGRESS_LIMITS.selfRevertsPerHour, 30);
      assert.equal(DEFAULT_INGRESS_LIMITS.hostRevertsOfOthersPerHour, 10);
      const { alice, last } = await dealt(port);
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
    const control = hostedStore();
    const { server, port } = await startServer({ store: control.store, limits: { logEntryCap: 2 } });
    try {
      const { alice, last } = await dealt(port);
      alice.submit(BUY, { baseIndex: last, submissionId: "buy" });
      const buy = await alice.answerTo("buy");
      assert.equal(buy.kind, "applied");
      const length = control.indices(ROOM).length;
      assert.ok(length >= 2);
      alice.submit({ PassTurn: { game_id: 0 } }, { baseIndex: lastIndex(buy), submissionId: "over" });
      const over = await alice.answerTo("over");
      assert.equal(over.code, "log-full");
      assert.equal(control.indices(ROOM).length, length);
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

  test("39 (§15 #40, as far as legacy identity allows): room, chat and presence pushes reach only the socket's own room", async () => {
    const control = hostedStore(ROOM, OTHER);
    const { server, port } = await startServer({ store: control.store });
    try {
      const here = await roomDoc(port, BOB, ROOM);
      const there = await roomDoc(port, CAROL, OTHER);
      const thereFrames = there.frames.length;
      here.send({ kind: "chat-send", room: ROOM, text: "hello room", displayName: "Bob" });
      here.send({ kind: "presence-set", room: ROOM, state: { routeValues: { 0: 10 } } });
      here.send({ kind: "chat-send", room: OTHER, text: "hello other room", displayName: "Bob" });
      const { alice } = await dealt(port); // the server's own `playing` broadcast for ROOM
      await here.next((f) => f.kind === "room" && (f.doc as { status?: string } | null)?.status === "playing", "ROOM's playing broadcast");
      await sleep(30);
      assert.equal(there.frames.length, thereFrames, "nothing of ROOM's reached OTHER's watcher");
      assert.equal(here.of("error").filter((f) => /room-hello first/.test(String(f.reason))).length, 1, "a chat naming another room is refused");
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });
});
