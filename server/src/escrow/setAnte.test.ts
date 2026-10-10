// server/src/escrow/setAnte.test.ts
//
// PLAY WAITING ROOM (design handoff "play-host-waiting-handoff" §6, §12.1): the host's ante editor -- the new `set-ante`
// room op. The host may change a real-money table's ante per seat UNTIL THE FIRST DEPOSIT, and the server alone decides
// "until": never once the escrow is bound, while a deposit may be on its way (a reported create or join), while the
// host's CreateGame may be in flight (ten minutes after the host's proven link), or unless the chain says conclusively
// that no ante of the host's seat is on it. Every viewer's view follows the change. A CreateGame built at an older ante
// is never bound to the table, and the table then refuses both a new ante and a plain cancel.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { quietConsole } from "../rooms/testSupport";
import { hostCreates, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, STAKE, type MoneyServer } from "./escrow4Support";
import { HOST_CREATE_WINDOW_MS } from "./moneyTables";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";

quietConsole();

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;
const NEW_ANTE = "2500000";

async function withWorld(run: (world: MoneyServer) => Promise<void>): Promise<void> {
  const world = await moneyServer();
  try {
    await run(world);
  } finally {
    await world.close();
  }
}

describe("PLAY WAITING ROOM: set-ante -- the host changes the ante until the first deposit", () => {
  test("before anything is linked or deposited: the record, every viewer's money view and the lobby's stake follow", () =>
    withWorld(async (world) => {
      const host = await player(world, "Ante Host");
      const guest = await player(world, "Ante Guest");
      const table = await openMoneyTable(host, 3);
      assert.equal((await guest.client.op({ type: "join", code: table.code, takeSeat: true })).ok, true);
      const changed = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(changed.ok, true, JSON.stringify(changed));
      assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.money?.ante_gross, NEW_ANTE);
      assert.equal(moneyOf(await viewOf(guest.client, table.gameId)).terms.anteGross, NEW_ANTE, "the guest's view follows");
      assert.equal(moneyOf(await viewOf(host.client, table.gameId)).terms.anteGross, NEW_ANTE);
      host.client.send({ kind: "rooms-watch", on: true });
      const rooms = (await host.client.next((frame) => frame.kind === "rooms", "the list")).rooms as Array<{ gameId: string; stake?: { anteGross: string } }>;
      assert.equal(rooms.find((room) => room.gameId === table.gameId)?.stake?.anteGross, NEW_ANTE, "the lobby's stake follows");
      const same = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(same.ok, true, "the same ante again changes nothing and is not an error");
    }));

  test("only the host; only a valid ante (whole base units, above the escrow's minimum); only a money table", () =>
    withWorld(async (world) => {
      const host = await player(world, "Rule Host");
      const guest = await player(world, "Rule Guest");
      const table = await openMoneyTable(host, 2);
      assert.equal((await guest.client.op({ type: "join", code: table.code, takeSeat: true })).ok, true);
      const byGuest = await guest.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(byGuest.ok, false);
      assert.equal(byGuest.code, "forbidden");
      for (const stake of ["1.5", "0", "-1", "abc", "01000000", "10"]) {
        const refused = await host.client.op({ type: "set-ante", stake }, table.gameId);
        assert.equal(refused.ok, false, stake);
        assert.equal(refused.code, "bad-stake", `${stake}: ${refused.code}`);
      }
      /* A closed frame: an extra field is a schema `bad-frame`, answered as an `error` (never an ack), and nothing runs. */
      host.client.send({ kind: "room-op", requestId: "rq-extra", gameId: table.gameId, op: { type: "set-ante", stake: NEW_ANTE, wallet: "x" } });
      const extra = await host.client.next((frame) => frame.kind === "error", "the bad-frame answer");
      assert.equal(extra.code, "bad-frame");
      assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.money?.ante_gross, STAKE, "nothing changed");
      const free = await host.client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Free" });
      assert.equal(free.ok, true);
      const noAnte = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, (free.data as { gameId: string }).gameId);
      assert.equal(noAnte.ok, false, "a free table has no ante to change");
    }));

  test("the host's proven link fences it for ten minutes (a CreateGame may be in flight), then it may change again", () =>
    withWorld(async (world) => {
      const host = await player(world, "Link Host");
      const table = await openMoneyTable(host, 2);
      const linked = await linkWallet(host, table.gameId, testWallet("link-host"), testConsentKey("link-host"));
      assert.equal(linked.status, 200, linked.text);
      const fenced = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(fenced.ok, false);
      assert.equal(fenced.code, "deposit-in-flight");
      world.advance(HOST_CREATE_WINDOW_MS + 1_000);
      const later = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(later.ok, true, `${later.code}: ${later.reason}`);
    }));

  test("once the host's ante is on Juno (bound, or reported on its way), the ante is fixed", () =>
    withWorld(async (world) => {
      const host = await player(world, "Bound Host");
      const table = await openMoneyTable(host, 2);
      const wallet = testWallet("bound-host");
      const key = testConsentKey("bound-host");
      const linked = await linkWallet(host, table.gameId, wallet, key);
      const ticket = linked.body?.ticket as string;
      await hostCreates(world, host, table.gameId, wallet, key, ticket);
      const reported = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(reported.ok, false);
      assert.match(String(reported.code), /ante-fixed|deposit-in-flight/);
      await world.drive(async () => moneyOf(await viewOf(host.client, table.gameId)).escrow.chainGameId !== null);
      world.advance(HOST_CREATE_WINDOW_MS + 1_000);
      const bound = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(bound.ok, false);
      assert.equal(bound.code, "ante-fixed");
      assert.equal(bound.reason, "A seat has already anted, so the ante is fixed.");
      assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.money?.ante_gross, STAKE);
    }));

  test("a CreateGame built at the OLD ante is never bound; the table then refuses a new ante and a plain cancel", () =>
    withWorld(async (world) => {
      const host = await player(world, "Stale Host");
      const table = await openMoneyTable(host, 2);
      const changed = await host.client.op({ type: "set-ante", stake: NEW_ANTE }, table.gameId);
      assert.equal(changed.ok, true);
      const wallet = testWallet("stale-host");
      const key = testConsentKey("stale-host");
      const linked = await linkWallet(host, table.gameId, wallet, key);
      /* A second device built its CreateGame from a view that still said STAKE: no hint, as if it never reported. */
      await hostCreates(world, host, table.gameId, wallet, key, linked.body?.ticket as string, { hint: false });
      world.advance(HOST_CREATE_WINDOW_MS + 1_000);
      await world.observe();
      assert.equal(moneyOf(await viewOf(host.client, table.gameId)).escrow.chainGameId, null, "an escrow at another ante is not the table's");
      const again = await host.client.op({ type: "set-ante", stake: "3000000" }, table.gameId);
      assert.equal(again.ok, false, "the host's ante is on Juno (at the old amount): the ante is fixed");
      assert.equal(again.code, "ante-fixed");
      const cancel = await host.client.op({ type: "cancel-room" }, table.gameId);
      assert.equal(cancel.ok, false, "never dropped over an escrow holding the host's money");
      assert.equal(cancel.code, "cancel-on-juno");
    }));

  test("two devices of the host change it at once: both are applied in turn, and the record says the last", () =>
    withWorld(async (world) => {
      const host = await player(world, "Twin Host");
      const table = await openMoneyTable(host, 2);
      const [a, b] = await Promise.all([host.client.op({ type: "set-ante", stake: "2000000" }, table.gameId), host.client.op({ type: "set-ante", stake: "3000000" }, table.gameId)]);
      assert.equal(a.ok && b.ok, true);
      assert.ok(["2000000", "3000000"].includes(world.server.rooms.moneyPort.recordOf(table.gameId)?.money?.ante_gross ?? ""));
    }));
});
