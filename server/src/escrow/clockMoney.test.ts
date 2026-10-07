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
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, type MoneyServer } from "./escrow4Support";
import { RESTORE_READ_ONLY_SENTENCE } from "./escrowService";

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

describe("Money tables: a TIMED money table fails closed without the dedicated REMEDY signer (owner, 2026-10-06)", () => {
  test("no signer: a timed money table is neither opened nor funded (no settlement-signer fallback); browsing, watching and free tables are unaffected; with the signer the flow proceeds", async () => {
    const signer = { on: false };
    const world = await moneyServer({ clock: true, remedySigner: signer });
    try {
      const host = await player(world, "Hana");
      /* Create: refused for every TIMED money table (Live, an Async pace). */
      const live = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Hana", stake: "1000000" });
      assert.deepEqual([live.ok, live.code], [false, "money-games-disabled"], JSON.stringify(live));
      assert.match(String(live.reason), /can't enforce a timed deadline with stakes/);
      const paced = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: ASYNC, nickname: "Hana", stake: "1000000", deadline: "async-pace", paceSecs: 86_400 });
      assert.deepEqual([paced.ok, paced.code], [false, "money-games-disabled"]);
      /* Not timed, or not money: unaffected (No-deadline money; a free Live table, its view, a watcher's view). */
      const untimed = await openMoneyTable(host, 2, { variants: ASYNC, deadline: "no-deadline", noDeadlineAck: true });
      assert.equal((await clockOf(host.client, untimed.gameId))?.deadline, "no-deadline");
      const free = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Hana" });
      assert.equal(free.ok, true, JSON.stringify(free));
      const freeId = (free.data as { gameId: string }).gameId;
      const watcher = await player(world, "Wes");
      const watched = await viewOf(watcher.client, freeId);
      assert.equal(typeof watched, "object", "a watcher still sees a table");
      /* With the signer: the timed money table opens and its join admission (the deposit's approval) is signed. */
      signer.on = true;
      const table = await openMoneyTable(host, 2);
      const hostWallet = testWallet("host");
      const hostKey = testConsentKey("host");
      const linked = await linkWallet(host, table.gameId, hostWallet, hostKey);
      assert.equal(linked.status, 200, linked.text);
      await hostCreates(world, host, table.gameId, hostWallet, hostKey, linked.body?.ticket as string);
      await world.observe();
      assert.notEqual((await world.financial.load(table.gameId))?.binding?.escrow ?? null, null, "the Live chain game is bound");
      const joiner = await seatJoiner(world, "Jo", table.code);
      assert.equal((await linkWallet(joiner.who, table.gameId, testWallet("jo"), testConsentKey("jo"))).status, 200);
      /* The signer goes away before the joiner funds: no deposit is approved on a deadline nobody can enforce. */
      signer.on = false;
      const refused = await joiner.who.api("join-admission", { gameId: table.gameId });
      assert.equal(refused.status, 503, refused.text);
      assert.equal(refused.body?.error, "money-unavailable", refused.text);
      signer.on = true;
      const admitted = await joiner.who.api("join-admission", { gameId: table.gameId });
      assert.equal(admitted.status, 200, admitted.text);
    } finally {
      await world.close();
    }
  });
});

describe("Consolidated final integration (independent review): the fail-closed REMEDY-signer rule at every money step; the clock held during a restore check", () => {
  test("the signer goes away AFTER the timed table was opened: the host's own ante (challenge and link) and the Start are refused, never frozen; with the signer back each goes through", async () => {
    const signer = { on: true };
    const world = await moneyServer({ clock: true, remedySigner: signer });
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host, 2);
      const hostWallet = testWallet("host-late");
      const hostKey = testConsentKey("host-late");
      /* The host's ante: refused while the signer is away -- before any challenge is minted. */
      signer.on = false;
      await host.confirm();
      const challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: hostWallet.address });
      assert.deepEqual([challenge.status, challenge.body?.error], [503, "money-unavailable"], challenge.text);
      assert.match(String(challenge.body?.reason), /can't enforce this table's deadline/);
      signer.on = true;
      const linked = await linkWallet(host, table.gameId, hostWallet, hostKey);
      assert.equal(linked.status, 200, linked.text);
      await hostCreates(world, host, table.gameId, hostWallet, hostKey, linked.body?.ticket as string);
      await world.observe();
      const joiner = await seatJoiner(world, "Jo", table.code);
      const joWallet = testWallet("jo-late");
      const joKey = testConsentKey("jo-late");
      const joLinked = await linkWallet(joiner.who, table.gameId, joWallet, joKey);
      assert.equal(joLinked.status, 200, joLinked.text);
      await joinerFunds(world, joiner.who, table.gameId, joWallet, joKey, joLinked.body?.ticket as string);
      await world.observe();
      /* Fully funded; the signer goes away: Start is refused and nothing is frozen. */
      signer.on = false;
      const refused = await host.client.op({ type: "start-game" }, table.gameId);
      assert.deepEqual([refused.ok, refused.code], [false, "money-unavailable"], JSON.stringify(refused));
      assert.match(String(refused.reason), /can't enforce this table's deadline right now, so the game was not started/);
      assert.equal((await world.financial.load(table.gameId))?.roster ?? null, null, "no roster was frozen");
      signer.on = true;
      const started = await host.client.op({ type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
    } finally {
      await world.close();
    }
  });

  test("a restored money table awaiting its L6-2 restore check holds its clock (no clock op changes it); the clock answers again once the check passes", async () => {
    const world = await moneyServer({ clock: true });
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host, 2, { variants: ASYNC, deadline: "no-deadline", noDeadlineAck: true });
      const original = world.service.restoreGate;
      world.service.restoreGate = (gameId: string) => (gameId === table.gameId ? RESTORE_READ_ONLY_SENTENCE : original(gameId));
      try {
        const held = await host.client.op({ type: "clock-ack" }, table.gameId);
        assert.equal(held.ok, false, JSON.stringify(held));
        assert.match(String(held.reason), /held; its clock cannot change now/, JSON.stringify(held));
      } finally {
        world.service.restoreGate = original;
      }
      const answered = await host.client.op({ type: "clock-ack" }, table.gameId);
      assert.ok(!/held; its clock cannot change now/.test(String(answered.reason ?? "")), JSON.stringify(answered));
    } finally {
      await world.close();
    }
  });
});
