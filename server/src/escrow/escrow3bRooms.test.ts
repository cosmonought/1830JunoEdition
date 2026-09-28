// server/src/escrow/escrow3bRooms.test.ts
//
// ==================================================================
//  ESCROW-3B (brief §12, §16): THE ROOM HOST'S ESCROW SEAM -- COMMITTED BOARDS OUT, A FROZEN ROSTER NEVER MOVES
// ==================================================================
//
// A real game server with the escrow seam stubbed: which tables have a frozen financial roster, and what the seam is
// told. Money games stay disabled (a stake is refused); a frozen table here is a no-money table the stub says is frozen,
// which is exactly what the room host can see of one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BUY, Client, openGame, quietConsole, startServer, stopServer, until } from "../rooms/testSupport";
import { FROZEN_ROSTER_SENTENCE } from "../rooms/roomHost";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";

quietConsole();

const lastIndexSeen = (client: Client): number => client.seen().reduce((max, entry) => Math.max(max, entry.index), -1);

describe("ESCROW-3B: the room host's escrow seam", () => {
  test("a frozen table's seats never move (take, leave, kick, rename, cancel); the deal and each move reach the seam as COMMITTED boards", async () => {
    const frozen = new Set<string>();
    const told: Array<{ gameId: string; length: number; round: string; entries: readonly ServerLogEntry[] }> = [];
    const { server, port } = await startServer({
      escrow: {
        isRosterFrozen: (gameId) => frozen.has(gameId),
        onGameplayCommitted: ({ gameId, entries, board }) => told.push({ gameId, length: entries.length, round: (board as GameStateResponse).current_round_type, entries }),
      },
    });
    try {
      const table = await openGame(port, "alice", ["bob"], { start: false });
      frozen.add(table.gameId);
      const alice = await Client.open(port, "alice");
      const bob = await Client.open(port, "bob");
      const carol = await Client.open(port, "carol");
      const refused = async (client: Client, body: Record<string, unknown>) => {
        const answer = await client.op(body, table.gameId);
        assert.equal(answer.ok, false, `${String(body.type)} was not refused`);
        assert.equal(answer.code, "wrong-state", String(body.type));
        assert.equal(answer.reason, FROZEN_ROSTER_SENTENCE);
      };
      await refused(alice, { type: "kick", playerId: table.playerIds.bob });
      await refused(bob, { type: "release-seat" });
      await refused(alice, { type: "cancel-room" });
      await refused(bob, { type: "set-profile", nickname: "Robert" });
      const joined = await carol.op({ type: "join", code: table.code, takeSeat: true });
      assert.equal(joined.ok, false, "no new seat (or admission) on a frozen table");
      const left = await bob.op({ type: "leave" }, table.gameId);
      assert.equal(left.ok, true, "leave only unsubscribes");
      assert.equal(told.length, 0, "nothing was committed yet");

      /* The deal (the room's roster source decides it; here the no-money one) reaches the seam with the committed log. */
      const started = await alice.op({ type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
      await until(() => told.length === 1, "the deal told to the seam");
      assert.equal(told[0].gameId, table.gameId);
      assert.equal(told[0].length, 1);
      assert.equal(told[0].round, "WaterfallAuction");
      assert.ok(Object.isFrozen(told[0].entries), "the committed (frozen) entries, never a live array");

      /* A move: committed first, then told -- with the board it committed. */
      alice.hello(table.gameId);
      await until(() => alice.seen().length > 0, "alice's catch-up");
      alice.submit(BUY, { baseIndex: lastIndexSeen(alice), submissionId: "m1" });
      assert.equal((await alice.answerTo("m1")).kind, "applied");
      await until(() => told.length === 2, "the move told to the seam");
      assert.equal(told[1].length, 2);

      /* A table the seam does not know is never told anything. */
      frozen.delete(table.gameId);
      alice.submit(BUY, { baseIndex: lastIndexSeen(alice), submissionId: "m2" });
      await alice.answerTo("m2");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(told.length, 2);
      await Promise.all([alice.close(), bob.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("a stake is still refused: money games stay disabled whatever the backend", async () => {
    const { server, port } = await startServer({ escrow: { isRosterFrozen: () => true, onGameplayCommitted: () => undefined } });
    try {
      const host = await Client.open(port, "alice");
      const created = await host.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "alice", stake: "1000000" });
      assert.equal(created.ok, false);
      assert.equal(created.code, "money-games-disabled");
      await host.close();
    } finally {
      await stopServer(server);
    }
  });
});
