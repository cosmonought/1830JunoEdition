// server/src/rooms/live2eContinuity.test.ts
//
// ==================================================================
//  LIVE-2E: MANY SOCKETS, ONE SEAT; AND A HOST WHO STAYS THE HOST
// ==================================================================
//
// The parts of LIVE-2E that are about the room, not the profile:
//   - PRESENCE IS THE SEAT'S. Two tabs (or devices) of one principal are one seat: closing one must not make the seat
//     look gone while the other still reads the table; closing the last one does, and everybody's view says so.
//   - THE VIEWER CAP COUNTS PEOPLE, NOT SOCKETS. One watcher's tabs are one watcher.
//   - THE SESSION CAP. One browser (session) is capped on its own, below the principal's cap across devices.
//   - HOST CONTINUITY. The host role lives in the GameRecord, not on a socket: the host's browser closing hands
//     nothing on, and the host's next socket is the host again.
//   - IN-GAME TRANSFER. `transfer-host` during an active game moves the host role -- and with it the host's undo
//     reach over another seat's last action (UndoPolicy `last-action`) -- and writes nothing to the game log.
//
// Development principals (`?dev_claim=`) here, exactly as the LIVE-2A/2C/2D suites: the room model is the same one
// production runs.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { createMemoryRecordStore } from "./recordStore";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  DEV_ORIGIN,
  controlledStore,
  devSocketUrl,
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
} from "./testSupport";

quietConsole();

const DAVE = "p-dave";

type WireView = {
  hostId: string;
  lifecycle: string;
  players: Array<{ id: string; online: boolean }>;
  you: { role: string; playerId: string | null };
};
const lastView = (client: Client, gameId: string): WireView | undefined =>
  client.frames.filter((frame) => frame.kind === "room" && frame.gameId === gameId).map((frame) => frame.view as WireView).pop();
const lastPresence = (client: Client, gameId: string): Array<{ playerId?: string }> | undefined =>
  client.frames.filter((frame) => frame.kind === "presence" && frame.gameId === gameId).map((frame) => frame.entries as Array<{ playerId?: string }>).pop();

async function dealtTable(claims: readonly string[] = [ALICE, BOB]) {
  const control = controlledStore();
  const records = createMemoryRecordStore();
  const gameId = await seedGame(records, claims, { dealt: true });
  control.logs.set(gameId, storedLog(0)); // the deal only: ALICE (the host) is on turn
  return { control, records, gameId };
}

describe("LIVE-2E: presence and `online` are the seat's, across every socket of its principal", () => {
  test("closing one of two tabs keeps the seat present; closing the last one clears it for everybody", async () => {
    const { control, records, gameId } = await dealtTable();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const bob = await Client.open(port, BOB);
      bob.roomHello(gameId);
      await bob.next((f) => f.kind === "room", "Bob's view");
      const tab1 = await Client.open(port, ALICE);
      const tab2 = await Client.open(port, ALICE);
      for (const tab of [tab1, tab2]) {
        tab.roomHello(gameId);
        await tab.next((f) => f.kind === "room", "Alice's view");
      }
      tab1.send({ kind: "presence-set", gameId, state: { actingCompanyId: null } });
      await until(() => (lastPresence(bob, gameId) ?? []).some((entry) => entry.playerId === ALICE), "Alice's presence at Bob");
      await until(() => lastView(bob, gameId)?.players.find((p) => p.id === ALICE)?.online === true, "Alice online at Bob");

      await tab2.close();
      await sleep(80);
      assert.ok((lastPresence(bob, gameId) ?? []).some((entry) => entry.playerId === ALICE), "one tab closed: Alice is still present");
      assert.equal(lastView(bob, gameId)?.players.find((p) => p.id === ALICE)?.online, true, "one tab closed: Alice is still online");

      await tab1.close();
      await until(() => !(lastPresence(bob, gameId) ?? []).some((entry) => entry.playerId === ALICE), "Alice's presence cleared");
      await until(() => lastView(bob, gameId)?.players.find((p) => p.id === ALICE)?.online === false, "Alice shown offline once her last tab closed");
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2E: the viewer cap counts principals, not sockets", () => {
  test("one watcher's many tabs are one watcher; a second person is refused at a cap of one", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const record = seededRecord([ALICE, BOB], { dealt: true });
    const capped = { ...record, policy: { ...record.policy, max_viewers: 1 } };
    const put = await records.put(capped, null);
    assert.equal(put.kind, "committed");
    control.logs.set(record.game_id, storedLog(0));
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const carolTabs = [await Client.open(port, CAROL), await Client.open(port, CAROL), await Client.open(port, CAROL)];
      for (const tab of carolTabs) {
        tab.roomHello(record.game_id);
        const frame = await tab.next((f) => f.kind === "room" || f.kind === "error", "Carol's answer");
        assert.equal(frame.kind, "room", "each of Carol's tabs is the same one watcher");
        tab.hello(record.game_id);
        const log = await tab.next((f) => f.kind === "catch-up" || f.kind === "error", "Carol's log");
        assert.equal(log.kind, "catch-up", "and so is each tab's log");
      }
      const dave = await Client.open(port, DAVE);
      dave.roomHello(record.game_id);
      const refused = await dave.next((f) => f.kind === "room" || f.kind === "error", "Dave's answer");
      assert.deepEqual([refused.kind, refused.code], ["error", "room-full"], "a second person is a second watcher");
      // A seat always fits.
      const alice = await Client.open(port, ALICE);
      alice.roomHello(record.game_id);
      assert.equal((await alice.next((f) => f.kind === "room" || f.kind === "error")).kind, "room");
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2E: the per-session socket cap", () => {
  test("one browser (session) is refused beyond its own cap, without spending the principal's", async () => {
    const { server, port } = await startServer({ limits: { identity: { maxSocketsPerSession: 2 } } });
    try {
      const one = await Client.open(port, ALICE);
      const two = await Client.open(port, ALICE);
      const status = await new Promise<number>((resolve) => {
        const socket = new WebSocket(devSocketUrl(port, ALICE), { origin: DEV_ORIGIN });
        socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
        socket.on("open", () => {
          socket.close();
          resolve(101);
        });
        socket.on("error", () => undefined);
      });
      assert.equal(status, 429, "the session's third socket is refused");
      // Another principal is untouched.
      const bob = await Client.open(port, BOB);
      assert.ok(bob.open);
      await Promise.all([one.close(), two.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2E: host continuity", () => {
  test("the host's browser closing hands nothing on; the host's next socket is the host again", async () => {
    const { control, records, gameId } = await dealtTable();
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const bob = await Client.open(port, BOB);
      bob.roomHello(gameId);
      const alice = await Client.open(port, ALICE);
      alice.roomHello(gameId);
      await alice.next((f) => f.kind === "room", "Alice's view");
      assert.equal(lastView(alice, gameId)?.you.role, "host");
      await alice.close();
      await until(() => lastView(bob, gameId)?.players.find((p) => p.id === ALICE)?.online === false, "Alice offline at Bob");
      await sleep(100);
      assert.equal(lastView(bob, gameId)?.hostId, ALICE, "no automatic succession on a disconnect");
      assert.equal(lastView(bob, gameId)?.you.role, "player");
      const back = await Client.open(port, ALICE);
      back.roomHello(gameId);
      await back.next((f) => f.kind === "room", "Alice's view again");
      assert.equal(lastView(back, gameId)?.you.role, "host", "the same principal is the host again");
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2E: transfer-host during an active game", () => {
  test("only the host may hand it on; the host's undo reach moves with it; nothing is written to the log", async () => {
    const control = controlledStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      /* A real table (server-minted player ids -- the op's `toPlayerId` must be one), dealt in seat order: the host,
         Alice, is on turn. */
      const { gameId, playerIds } = await openGame(port, ALICE, [BOB]);
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      for (const client of [alice, bob]) {
        client.roomHello(gameId);
        await client.next((f) => f.kind === "room", `${client.claim}'s view`);
        client.hello(gameId);
        await client.next((f) => f.kind === "catch-up", `${client.claim}'s log`);
      }
      // Alice (the host, on turn) buys: entry #1.
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      assert.equal((await alice.answerTo("a-buy")).kind, "applied");
      const revert = (index: number, by: string) => ({ RevertTo: { index, player: by, summary: "undo" } });

      // Bob is not the host: he may not undo Alice's action, and he may not take the role.
      bob.submit(revert(1, playerIds[BOB]), { baseIndex: 1, submissionId: "b-undo-1" });
      assert.equal((await bob.answerTo("b-undo-1")).kind, "refused", "a non-host cannot undo another seat's last action");
      assert.equal((await bob.op({ type: "transfer-host", toPlayerId: playerIds[BOB] }, gameId)).code, "forbidden");

      // The host hands the role on, mid-game.
      const moved = await alice.op({ type: "transfer-host", toPlayerId: playerIds[BOB] }, gameId);
      assert.equal(moved.ok, true);
      await until(() => lastView(bob, gameId)?.you.role === "host", "Bob's view says host");
      await until(() => lastView(alice, gameId)?.you.role === "player", "Alice's view says player");
      assert.equal(lastView(bob, gameId)?.lifecycle, "active");

      // The reach moved with it: Bob (now host) undoes Alice's last action.
      bob.submit(revert(1, playerIds[BOB]), { baseIndex: 1, submissionId: "b-undo-2" });
      assert.equal((await bob.answerTo("b-undo-2")).kind, "applied", "the new host may undo another seat's last action");

      // The log: the deal, the buy, the undo -- no host-transfer entry of any kind.
      const kinds = (control.logs.get(gameId) ?? []).map((entry) => Object.keys(JSON.parse((entry as unknown as { payload: string }).payload))[0]);
      assert.deepEqual(kinds, ["SetupGame", "WaterfallBuyLowest", "RevertTo"]);
      // Alice is a player now: the role is not hers to hand back.
      assert.equal((await alice.op({ type: "transfer-host", toPlayerId: playerIds[ALICE] }, gameId)).code, "forbidden");
    } finally {
      await stopServer(server);
    }
  });
});

// Keep the imported type in use for readers of this file.
export type { Frame };
void BUILD;
