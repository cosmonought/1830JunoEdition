// server/src/rooms/live2dCutover.test.ts
//
// LIVE-2D: THE CLIENT CUTOVER, FROM THE SERVER'S SIDE -- the legacy room protocol is gone, not merely unused.
//
// Negative tests over real sockets to a development-mode server (the mode that used to register the legacy handlers):
// every legacy frame is refused `bad-frame` and neither mutates anything nor returns any room data; the legacy handler
// list is empty and frozen; a client never deals; a frame cannot name the actor of a move; a seat that is not the host
// cannot run the host's operations; a legacy room code, even one planted in the stores, opens nothing. And the client's
// room types are the server's projection (a compile-time check, plus the wire's keys at run time).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { LEGACY_ROOM_HANDLERS } from "../gameServer";
import { BAD_FRAME_REASONS } from "../../../frontend/src/gameEngine/messageSchema";
import type { RoomSummary as ClientRoomSummary, RoomView as ClientRoomView } from "../../../frontend/src/utils/roomProtocol";
import { roomSummaryOf, roomViewFor, NO_FACTS, type GameRecord, type RoomSummary as ServerRoomSummary, type RoomView as ServerRoomView } from "./gameRecord";
import { createMemoryRecordStore, type MemoryRecordStore } from "./recordStore";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  SETUP,
  controlledStore,
  devPrincipal,
  openGame,
  quietConsole,
  seedGame,
  seededRecord,
  sleep,
  startServer,
  stopServer,
  storedLog,
  until,
  type Frame,
  type SeenEntry,
} from "./testSupport";

quietConsole();

/* ==================================================================
    THE CLIENT'S ROOM TYPES ARE THE SERVER'S PROJECTION (compile time)
   ==================================================================
   Assignable in both directions, so a field added, dropped or retyped on either side fails the build. The key lists
   below are exhaustive by type (`Record<keyof ...>`), so the run-time check further down compares the wire against
   exactly the client's declared fields. */
const serverView = roomViewFor(seededRecord(), NO_FACTS, devPrincipal(ALICE), { now: 0, held: false, online: () => false, canStart: false });
const serverSummary = roomSummaryOf({ ...seededRecord(), join_code: "JUNO-AAAA-AAAA" }, NO_FACTS, 0) as ServerRoomSummary;
const _viewToClient: ClientRoomView = serverView;
const _viewToServer: ServerRoomView = _viewToClient;
const _summaryToClient: ClientRoomSummary = serverSummary;
const _summaryToServer: ServerRoomSummary = _summaryToClient;
void [_viewToServer, _summaryToServer];

const VIEW_KEYS: Record<keyof ClientRoomView, true> = {
  gameId: true,
  code: true,
  joinable: true,
  visibility: true,
  status: true,
  lifecycle: true,
  closed: true,
  held: true,
  holdKind: true,
  holdReason: true,
  hostId: true,
  players: true,
  playerCount: true,
  seatCap: true,
  variants: true,
  createdAtMs: true,
  undoPolicy: true,
  you: true,
  money: true,
};
const SUMMARY_KEYS: Record<keyof ClientRoomSummary, true> = {
  gameId: true,
  code: true,
  status: true,
  hostNickname: true,
  nicknames: true,
  readyCount: true,
  seated: true,
  seatCap: true,
  playerCount: true,
  variants: true,
  createdAtMs: true,
  stake: true,
};
const YOU_KEYS: Record<keyof ClientRoomView["you"], true> = { role: true, playerId: true, kicked: true, canStart: true };
/* ESCROW-4 (additive and optional, the LIVE-4 amendment): carried only by a real-money table, so a no-money table's view
   and list entry are exactly what they were before (`escrow4Money.test.ts` pins the money table's own). LIVE-4 (L4-3):
   `holdReason` likewise -- carried only by a view whose `holdKind` is `incompatible` (`live4ClientCompatibility`). */
const OPTIONAL_VIEW_KEYS: ReadonlySet<string> = new Set(["money", "holdReason"]);
const OPTIONAL_SUMMARY_KEYS: ReadonlySet<string> = new Set(["stake"]);

/* ==================================================================
    FIXTURES
   ================================================================== */

/** Frames that carry room data of any kind. A legacy frame must be answered with none of them. */
const ROOM_DATA_KINDS = new Set(["room", "rooms", "catch-up", "applied", "chat", "presence", "seat", "seats", "lobby", "room-ack", "status"]);

/** Every legacy room frame, in the shape the pre-LIVE-2D client sent it, and what the closed schema makes of it:
 *  a kind it has never heard of, or a known kind carrying `room` (a field it does not take) and lacking `gameId`. */
const LEGACY_FRAMES: ReadonlyArray<{ name: string; frame: Record<string, unknown>; reason: string }> = [
  { name: "room-write", frame: { kind: "room-write", room: "JUNO-ABC", write: { op: "host", hostId: ALICE, nickname: "Alice", variants: {} } }, reason: BAD_FRAME_REASONS.unknownKind },
  { name: "seat-pin", frame: { kind: "seat-pin", room: "JUNO-ABC", requestId: "pin-1", playerId: ALICE, pin: "1234" }, reason: BAD_FRAME_REASONS.unknownKind },
  { name: "claim-seat", frame: { kind: "claim-seat", room: "JUNO-ABC", requestId: "claim-1", playerId: ALICE, pin: "1234" }, reason: BAD_FRAME_REASONS.unknownKind },
  { name: "lobby-write", frame: { kind: "lobby-write", write: { op: "upsert", room: "JUNO-ABC", hostId: ALICE } }, reason: BAD_FRAME_REASONS.unknownKind },
  { name: "lobby-watch", frame: { kind: "lobby-watch", on: true }, reason: BAD_FRAME_REASONS.unknownKind },
  { name: "lobby-hello", frame: { kind: "lobby-hello" }, reason: BAD_FRAME_REASONS.unknownKind },
  { name: "hello {room}", frame: { kind: "hello", room: "JUNO-ABC", build: BUILD, baseIndex: -1 }, reason: BAD_FRAME_REASONS.malformed },
  { name: "room-hello {room}", frame: { kind: "room-hello", room: "JUNO-ABC", build: BUILD }, reason: BAD_FRAME_REASONS.malformed },
  { name: "chat-send {room}", frame: { kind: "chat-send", room: "JUNO-ABC", text: "hello" }, reason: BAD_FRAME_REASONS.malformed },
  { name: "presence-set {room}", frame: { kind: "presence-set", room: "JUNO-ABC", state: { routeValues: { 0: 1 } } }, reason: BAD_FRAME_REASONS.malformed },
];

/** A development server over stores the test can read: a dealt game for ALICE (host) and BOB, plus a LEGACY room
 *  planted where the old server kept one -- a log under the legacy code, and the code in the join index -- so a
 *  refusal is not merely "there was nothing there". */
async function world() {
  const control = controlledStore();
  const records = createMemoryRecordStore();
  const gameId = await seedGame(records, [ALICE, BOB], { dealt: true });
  control.logs.set(gameId, storedLog(0));
  control.logs.set("JUNO-ABC", storedLog(1));
  records.codes.set("JUNO-ABC", gameId);
  const { server, port } = await startServer({ store: control.store, records });
  return { control, records, gameId, server, port };
}

const snapshot = (control: ReturnType<typeof controlledStore>, records: MemoryRecordStore) =>
  JSON.stringify({ logs: [...control.logs.entries()], records: [...records.records.entries()], codes: [...records.codes.entries()] });

/* ==================================================================
    THE TESTS
   ================================================================== */

describe("LIVE-2D: the legacy room protocol is gone", () => {
  test("LEGACY_ROOM_HANDLERS is empty and frozen", () => {
    assert.equal(LEGACY_ROOM_HANDLERS.length, 0);
    assert.ok(Object.isFrozen(LEGACY_ROOM_HANDLERS));
    assert.throws(() => (LEGACY_ROOM_HANDLERS as string[]).push("room-write"), TypeError, "nothing can be registered at run time");
    assert.equal(LEGACY_ROOM_HANDLERS.length, 0);
  });

  for (const legacy of LEGACY_FRAMES) {
    test(`\`${legacy.name}\` is refused bad-frame, mutates nothing and returns no room data`, async () => {
      const { control, records, gameId, server, port } = await world();
      try {
        const before = snapshot(control, records);
        const loadsBefore = control.calls.loadLog;
        const client = await Client.open(port, ALICE);
        client.send(legacy.frame);
        const answer = await client.next((f) => f.kind === "error", `the refusal of ${legacy.name}`);
        assert.equal(answer.code, "bad-frame", legacy.name);
        assert.equal(answer.reason, legacy.reason, `${legacy.name}: exactly the schema's fixed sentence`);
        // The same frame naming the real game as well is no better: a `room` field is never accepted beside it.
        client.send({ ...legacy.frame, gameId });
        const second = await client.next((f) => f.kind === "error", `the refusal of ${legacy.name} with a gameId`);
        assert.equal(second.code, "bad-frame");
        await sleep(40);
        assert.deepEqual(client.frames.filter((f) => ROOM_DATA_KINDS.has(f.kind)), [], `${legacy.name} returned room data`);
        assert.equal(JSON.stringify(client.frames).includes("JUNO-ABC"), false, "the legacy code is never echoed");
        assert.equal(snapshot(control, records), before, `${legacy.name} changed a store`);
        assert.equal(control.calls.appendLog, 0);
        assert.equal(control.calls.loadLog, loadsBefore, "no log was read for it");
        assert.equal(server.residentGames(), 0, "no game was loaded for it");
        assert.equal(server.socketCounts().byGame("JUNO-ABC"), 0);
        assert.equal(server.ingress.badFrames, 2);
        await client.close();
      } finally {
        await stopServer(server);
      }
    });
  }

  test("a stored-but-legacy room code cannot be joined, read or subscribed to -- even planted in the join index", async () => {
    const { control, records, server, port } = await world();
    try {
      const before = snapshot(control, records);
      const client = await Client.open(port, CAROL);
      for (const code of ["JUNO-ABC", "juno-abc", "ABC"]) {
        for (const takeSeat of [true, false]) {
          const ack = await client.op({ type: "join", code, takeSeat });
          assert.deepEqual([ack.ok, ack.code], [false, "invalid-or-expired"], `${code} ${takeSeat}`);
        }
      }
      for (const frame of [
        { kind: "hello", gameId: "JUNO-ABC", build: BUILD, baseIndex: -1 },
        { kind: "room-hello", gameId: "JUNO-ABC", build: BUILD },
        { kind: "room-op", requestId: "legacy-take", gameId: "JUNO-ABC", op: { type: "take-seat" } },
      ]) {
        client.send(frame);
      }
      await until(() => client.of("error").filter((f) => f.code === "bad-frame").length === 3, "three bad-frames");
      await sleep(30);
      assert.deepEqual(client.frames.filter((f) => f.kind !== "error" && f.kind !== "room-ack"), [], "no room data");
      assert.ok(client.of("room-ack").every((f) => f.ok === false));
      assert.equal(snapshot(control, records), before);
      assert.equal(control.calls.loadLog, 0, "the legacy log was never read");
      assert.equal(server.residentGames(), 0);
      await client.close();
    } finally {
      await stopServer(server);
    }
  });

  test("a client-sent SetupGame is refused -- from the host, a seat or a watcher, before or after the deal", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const waiting = await seedGame(records, [ALICE, BOB]);
    const dealt = await seedGame(records, [ALICE, BOB], { dealt: true });
    control.logs.set(dealt, storedLog(0));
    const { server, port } = await startServer({ store: control.store, records });
    try {
      let n = 0;
      for (const gameId of [waiting, dealt]) {
        for (const claim of [ALICE, BOB, CAROL]) {
          const client = await Client.open(port, claim);
          client.hello(gameId);
          const hello = await client.next((f) => f.kind === "catch-up");
          const at = ((hello.entries as SeenEntry[]) ?? []).length - 1;
          n += 1;
          client.submit(SETUP, { baseIndex: at, submissionId: `deal-${n}` });
          const answer = await client.answerTo(`deal-${n}`);
          assert.deepEqual([answer.kind, answer.code], ["refused", "bad-frame"], `${claim} on ${gameId === waiting ? "a waiting" : "a dealt"} game`);
          assert.equal(answer.reason, "The deal is made by the server — press Start.");
          await client.close();
        }
      }
      assert.deepEqual(control.indices(waiting), []);
      assert.deepEqual(control.indices(dealt), [0]);
      assert.equal(control.calls.appendLog, 0);
    } finally {
      await stopServer(server);
    }
  });

  test("a submit naming another seat's actor is never attributed to that seat", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const gameId = await seedGame(records, [ALICE, BOB], { dealt: true });
    control.logs.set(gameId, storedLog(0)); // Alice is on turn
    const { server, port } = await startServer({ store: control.store, records, limits: { buckets: { malformed: { capacity: 100, refillPerSecond: 100 } } } });
    try {
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      for (const client of [alice, bob]) {
        client.hello(gameId);
        await client.next((f) => f.kind === "catch-up");
      }
      // The envelope is closed: an `actor`, `player`, `playerId` or `claim` beside the move is a malformed frame.
      for (const [field, n] of [["actor", 1], ["player", 2], ["playerId", 3], ["claim", 4]] as const) {
        bob.send({ kind: "submit", build: BUILD, msg: BUY, baseIndex: 0, submissionId: `spoof-${n}`, [field]: ALICE });
        const answer = await bob.answerTo(`spoof-${n}`);
        assert.deepEqual([answer.kind, answer.code], ["refused", "bad-frame"], field);
      }
      // Inside the move, an undeclared actor is stripped: Bob's purchase is Bob's -- and it is not Bob's turn.
      bob.submit({ WaterfallBuyLowest: { game_id: 0, actor: ALICE, player: ALICE, playerId: ALICE } }, { baseIndex: 0, submissionId: "spoof-body" });
      const body = await bob.answerTo("spoof-body");
      assert.equal(body.kind, "refused", "Bob cannot make Alice's move by naming her");
      assert.deepEqual(control.indices(gameId), [0], "nothing was attributed to Alice's seat");
      // A move whose own fields name a player is committed as the seat that pressed it.
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      const bought = await alice.answerTo("a-buy");
      assert.equal(bought.kind, "applied");
      alice.submit({ RevertTo: { index: 1, player: BOB, summary: "undo" } }, { baseIndex: 1, submissionId: "a-undo" });
      assert.equal((await alice.answerTo("a-undo")).kind, "applied");
      const log = control.log(gameId);
      const byNonce = (id: string) => log.find((entry) => entry.submission_id === id);
      assert.equal(byNonce("a-buy")?.actor, ALICE);
      assert.equal(byNonce("a-undo")?.actor, ALICE);
      assert.equal(JSON.parse(byNonce("a-undo")?.payload ?? "{}").RevertTo.player, ALICE, "the revert names who pressed it, not the frame's claim");
      assert.equal(log.some((entry) => entry.submission_id?.startsWith("spoof")), false);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("the host's operations from a seat that is not the host -- or a watcher -- are refused `forbidden`, and change nothing", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      /* Through the protocol, so the targets are server-minted player ids (the schema takes no other shape). */
      const { gameId, playerIds } = await openGame(port, ALICE, [BOB, CAROL], { start: false }); // every seat ready
      const before = JSON.stringify(await records.load(gameId));
      const bob = await Client.open(port, BOB);
      const watcher = await Client.open(port, "p-watcher");
      for (const client of [bob, watcher]) {
        client.roomHello(gameId);
        await client.next((f) => f.kind === "room");
      }
      const ops: Array<Record<string, unknown>> = [
        { type: "kick", playerId: playerIds[CAROL] },
        { type: "kick", playerId: playerIds[ALICE] },
        { type: "start-game" },
        { type: "transfer-host", toPlayerId: playerIds[BOB] },
        { type: "rotate-code" },
        { type: "set-visibility", visibility: "private" },
        { type: "cancel-room" },
      ];
      for (const client of [bob, watcher]) {
        for (const body of ops) {
          const ack = await client.op(body, gameId);
          assert.deepEqual([ack.ok, ack.code], [false, "forbidden"], `${client.claim}: ${String(body.type)}`);
        }
      }
      assert.equal(JSON.stringify(await records.load(gameId)), before, "the record did not move");
      assert.deepEqual(control.indices(gameId), [], "nothing was dealt");
      const view = bob.of("room").slice(-1)[0].view as ClientRoomView;
      assert.deepEqual([view.you.role, view.you.canStart, view.hostId], ["player", false, playerIds[ALICE]]);
      await Promise.all([bob.close(), watcher.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("on the wire, a room view and a public-list entry carry exactly the client's declared fields", async () => {
    const records = createMemoryRecordStore();
    const listed: GameRecord = { ...seededRecord([ALICE, BOB]), join_code: "JUNO-BBBB-BBBB" };
    assert.equal((await records.put(listed, null)).kind, "committed");
    records.codes.set("JUNO-BBBB-BBBB", listed.game_id);
    const { server, port } = await startServer({ records });
    try {
      const alice = await Client.open(port, ALICE);
      alice.roomHello(listed.game_id);
      const frame = await alice.next((f) => f.kind === "room");
      const view = frame.view as Record<string, unknown>;
      assert.deepEqual(Object.keys(view).sort(), Object.keys(VIEW_KEYS).filter((key) => !OPTIONAL_VIEW_KEYS.has(key)).sort());
      assert.deepEqual(Object.keys(view.you as object).sort(), Object.keys(YOU_KEYS).sort());
      assert.deepEqual(view.undoPolicy, { host_undo: "last-action" });
      alice.send({ kind: "rooms-watch", on: true });
      const rooms = (await alice.next((f: Frame) => f.kind === "rooms")).rooms as Array<Record<string, unknown>>;
      assert.equal(rooms.length, 1);
      assert.deepEqual(Object.keys(rooms[0]).sort(), Object.keys(SUMMARY_KEYS).filter((key) => !OPTIONAL_SUMMARY_KEYS.has(key)).sort());
      assert.equal(/pr_dev_/.test(JSON.stringify(alice.frames)), false, "no principal id on the wire");
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });
});
