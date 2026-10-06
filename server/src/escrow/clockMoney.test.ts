// server/src/escrow/clockMoney.test.ts
//
// PHASE 3 FINAL CLOCKS on REAL-MONEY tables, through the server's sockets and money routes (`escrow4Support.ts` with
// its table clock wired as `start.ts` wires one):
//
//   - a money table's deadline is fixed at its creation, before any escrow exists: a Live table is Live; an Async table
//     must name its pace (12 h .. 7 d) or No-deadline -- the host cannot change it afterwards;
//   - No-deadline: the owner's disclosure ("This game has no action deadline. If it does not finish and all players do
//     not agree to annul it, your escrowed funds may remain locked indefinitely.") is acknowledged by the host with the
//     create and by every joiner BEFORE the server signs their join admission; the acknowledgements are persisted;
//   - the async chain game binds only when its funded deadline is exactly the table's (the pace's allowance, or
//     `no_deadline`), and a joiner's admission is signed only after that joiner acknowledged.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { NO_DEADLINE_DISCLOSURE, type RoomClockView } from "../../../frontend/src/utils/clockProtocol";
import { quietConsole } from "../rooms/testSupport";
import { hostCreates, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, type MoneyServer } from "./escrow4Support";

quietConsole();

const ASYNC = { mode: "async" };

async function seatJoiner(world: MoneyServer, name: string, code: string) {
  const who = await player(world, name);
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { who, playerId: (joined.data as { playerId: string }).playerId };
}

const clockOf = async (client: Parameters<typeof viewOf>[0], gameId: string) => (await viewOf(client, gameId)).clock as RoomClockView | undefined;

describe("Money tables: the deadline is fixed at creation", () => {
  test("an Async money table must name its pace or No-deadline; No-deadline needs the host's acknowledgement with the create", async () => {
    const world = await moneyServer({ clock: true });
    try {
      const host = await player(world, "Hana");
      const bare = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: ASYNC, nickname: "Hana", stake: "1000000" });
      assert.equal(bare.ok, false);
      assert.match(String(bare.reason), /pace .* or No deadline/);
      const live = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: ASYNC, nickname: "Hana", stake: "1000000", deadline: "live" });
      assert.equal(live.ok, false, "an Async table is never Live");
      const unacked = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: ASYNC, nickname: "Hana", stake: "1000000", deadline: "no-deadline" });
      assert.equal(unacked.ok, false);
      assert.equal(unacked.code, "acknowledge-no-deadline");
      assert.ok(String(unacked.reason).startsWith(NO_DEADLINE_DISCLOSURE), "the owner's disclosure, verbatim");
      const table = await openMoneyTable(host, 2, { variants: ASYNC, deadline: "no-deadline", noDeadlineAck: true });
      const clock = await clockOf(host.client, table.gameId);
      assert.equal(clock?.deadline, "no-deadline");
      assert.deepEqual(clock?.noDeadlineAcks, [table.playerId], "the host's acknowledgement is persisted with the table");
      const changed = await host.client.op({ type: "clock-policy", deadline: "async-pace", paceSecs: 86_400 }, table.gameId);
      assert.equal(changed.ok, false, "a money table's deadline never changes after its creation");
      const paced = await openMoneyTable(host, 2, { variants: ASYNC, deadline: "async-pace", paceSecs: 172_800 });
      const pacedClock = await clockOf(host.client, paced.gameId);
      assert.deepEqual([pacedClock?.deadline, pacedClock?.paceSecs, pacedClock?.money], ["async-pace", 172_800, true]);
    } finally {
      await world.close();
    }
  });
});

describe("Money tables: No-deadline acknowledgement before every ante", () => {
  test("the async chain game binds only under the table's deadline; a joiner gets no join admission until it acknowledged", async () => {
    const world = await moneyServer({ clock: true });
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host, 2, { variants: ASYNC, deadline: "no-deadline", noDeadlineAck: true });
      const hostWallet = testWallet("host");
      const hostKey = testConsentKey("host");
      const linked = await linkWallet(host, table.gameId, hostWallet, hostKey);
      assert.equal(linked.status, 200, linked.text);
      const ticket = linked.body?.ticket as string;
      /* A chain game funded under ANOTHER deadline (a 24 h pace) is never this table's escrow. */
      await hostCreates(world, host, table.gameId, hostWallet, hostKey, ticket, { variants: ASYNC, deadline: { async_pace: { allowance_secs: 86_400 } } });
      await world.observe();
      assert.equal((await world.financial.load(table.gameId))?.binding?.escrow ?? null, null, "a paced chain game is not a No-deadline table's escrow");
      const own = await hostCreates(world, host, table.gameId, hostWallet, hostKey, ticket, { variants: ASYNC, deadline: { no_deadline: {} }, hint: false });
      await world.observe();
      assert.equal((await world.financial.load(table.gameId))?.binding?.escrow?.chain_game_id, own, "the no_deadline chain game is bound");
      const joiner = await seatJoiner(world, "Jo", table.code);
      const joinerWallet = testWallet("jo");
      const joinerKey = testConsentKey("jo");
      assert.equal((await linkWallet(joiner.who, table.gameId, joinerWallet, joinerKey)).status, 200);
      const refused = await joiner.who.api("join-admission", { gameId: table.gameId });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body?.error, "acknowledge-no-deadline", refused.text);
      const ack = await joiner.who.client.op({ type: "clock-ack" }, table.gameId);
      assert.equal(ack.ok, true, JSON.stringify(ack));
      const clock = await clockOf(joiner.who.client, table.gameId);
      assert.deepEqual([...(clock?.noDeadlineAcks ?? [])].sort(), [table.playerId, joiner.playerId].sort());
      const admitted = await joiner.who.api("join-admission", { gameId: table.gameId });
      assert.equal(admitted.status, 200, admitted.text);
    } finally {
      await world.close();
    }
  });
});
