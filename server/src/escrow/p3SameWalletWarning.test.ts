// server/src/escrow/p3SameWalletWarning.test.ts
//
// OWNER RULING (2026-10-07): A PLAYER'S AUTHORIZATION WALLET MAY ALSO BE THAT PLAYER'S FINANCIAL (ANTE) WALLET.
//
// Allowed -- never refused, never selected or bound for the player -- and warned once in the browser before that same
// address is first bound to a seat. The server's part: the wallet challenge SAYS (to the account's own session) when the
// wallet about to be linked is the account's own Authorization Wallet (`authorizationWallet: true`), and says nothing
// otherwise; the link, the deposit and the game run exactly as with any other wallet; the account's Authorization
// Wallet, its profile and the seat's identity never move; and no wallet is ever bound to a seat from account state.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, type MoneyServer, type Player, type TestWallet } from "./escrow4Support";
import { apiRequest, quietConsole } from "../rooms/testSupport";
import type { KeplrAccount } from "../testSupport/authorizationWallets";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";

quietConsole();

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;

/** The account's Authorization Wallet (a Keplr account in the tests) as the money layer's test wallet. */
const asWallet = (account: KeplrAccount): TestWallet => ({ secret: account.secret, pubkey: account.pubkey, address: account.address, signArbitrary: (text) => account.sign(text) });

async function accountOf(world: MoneyServer, who: Player): Promise<{ name: string; username: string; authorizationWallet: { address: string; since: number } }> {
  const answer = await apiRequest(world.port, "/gs/api/account/me", { cookie: who.browser.cookie, body: {} });
  assert.equal(answer.status, 200, answer.text);
  return answer.body?.account as { name: string; username: string; authorizationWallet: { address: string; since: number } };
}

async function seat(who: Player, code: string): Promise<string> {
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return (joined.data as { playerId: string }).playerId;
}

/** A funded two-seat table: the host antes from `hostWallet` (CreateGame), the joiner from `joinerWallet` (Join). Each
 *  link is the player's own explicit choice of wallet (`linkWallet` with that wallet's signature). */
async function fundedTable(world: MoneyServer, host: Player, joiner: Player, hostWallet: TestWallet, joinerWallet: TestWallet, label: string) {
  const table = await openMoneyTable(host);
  const hostKey = testConsentKey(`${label}/host`);
  const hostLink = await linkWallet(host, table.gameId, hostWallet, hostKey);
  assert.equal(hostLink.status, 200, hostLink.text);
  await hostCreates(world, host, table.gameId, hostWallet, hostKey, hostLink.body?.ticket as string);
  await world.observe();
  await seat(joiner, table.code);
  const joinerKey = testConsentKey(`${label}/joiner`);
  const joinerLink = await linkWallet(joiner, table.gameId, joinerWallet, joinerKey);
  assert.equal(joinerLink.status, 200, joinerLink.text);
  await joinerFunds(world, joiner, table.gameId, joinerWallet, joinerKey, joinerLink.body?.ticket as string);
  await world.observe();
  return table;
}

describe("owner ruling 2026-10-07: the Authorization Wallet as a game's financial wallet -- said, allowed, never chosen", () => {
  test("the wallet challenge says `authorizationWallet: true` for the account's own Authorization Wallet -- and for no other wallet (another account's included)", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const bob = await player(world, "Bob");
      const table = await openMoneyTable(alice);
      const own = await alice.api("wallet-challenge", { gameId: table.gameId, wallet: alice.browser.wallet.address });
      assert.equal(own.status, 200, own.text);
      assert.equal(own.body?.authorizationWallet, true, "the same address: the browser warns before it is bound");
      await alice.confirm();
      const other = await alice.api("wallet-challenge", { gameId: table.gameId, wallet: testWallet("same-wallet/other").address });
      assert.equal(other.status, 200, other.text);
      assert.ok(!("authorizationWallet" in (other.body ?? {})), "another wallet: nothing said");
      const bobs = await alice.api("wallet-challenge", { gameId: table.gameId, wallet: bob.browser.wallet.address });
      assert.equal(bobs.status, 200, bobs.text);
      assert.ok(!("authorizationWallet" in (bobs.body ?? {})), "ANOTHER account's Authorization Wallet is not this account's");
    } finally {
      await world.close();
    }
  });

  test("same-address use is NOT refused: Authorization Wallet C links, funds and plays one game; the account (C, since, name), the profile and the seat's identity are unchanged", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const bob = await player(world, "Bob");
      const before = await accountOf(world, alice);
      const walletC = asWallet(alice.browser.wallet);
      assert.equal(walletC.address, before.authorizationWallet.address);
      const table = await openMoneyTable(alice);
      const seatBefore = moneyOf(await viewOf(alice.client, table.gameId)).you;
      const playerIdBefore = ((await viewOf(alice.client, table.gameId)).you as { playerId: string }).playerId;
      assert.equal(seatBefore?.link ?? null, null, "nothing is bound before the player links");
      /* The player's own choice -- C's fresh signature authorizes its own link (no password): allowed. */
      const hostKey = testConsentKey("same-wallet/C/host");
      const linked = await linkWallet(alice, table.gameId, walletC, hostKey, { confirm: false });
      assert.equal(linked.status, 200, `the Authorization Wallet as the financial wallet is allowed: ${linked.text}`);
      await hostCreates(world, alice, table.gameId, walletC, hostKey, linked.body?.ticket as string);
      await world.observe();
      await seat(bob, table.code);
      const bobWallet = testWallet("same-wallet/C/bob");
      const bobKey = testConsentKey("same-wallet/C/bob");
      const bobLink = await linkWallet(bob, table.gameId, bobWallet, bobKey);
      assert.equal(bobLink.status, 200, bobLink.text);
      await joinerFunds(world, bob, table.gameId, bobWallet, bobKey, bobLink.body?.ticket as string);
      await world.observe();
      assert.equal(moneyOf(await viewOf(alice.client, table.gameId)).you?.payoutWallet, walletC.address, "this game's money wallet is C, by the player's choice");
      assert.equal((await alice.client.op({ type: "start-game" }, table.gameId)).ok, true);
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
      const roster = (await world.financial.load(table.gameId))?.roster?.roster ?? [];
      assert.ok(roster.some((entry) => entry.payout_address === walletC.address), "the frozen roster pays this seat's chosen wallet (C)");
      /* The roles stay apart: the account is exactly as it was; the seat is the same seat. */
      assert.deepEqual(await accountOf(world, alice), before, "the account's Authorization Wallet, its designation time and name are unchanged");
      assert.equal(((await viewOf(alice.client, table.gameId)).you as { playerId: string }).playerId, playerIdBefore, "the seat is the same seat");
    } finally {
      await world.close();
    }
  });

  test("multi-game: Authorization Wallet C, Game 1 on wallet A, Game 2 on wallet B, Game 3 deliberately on C -- each seat keeps its own wallet; C stays the account's and only Game 3's", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const bob = await player(world, "Bob");
      const before = await accountOf(world, alice);
      const walletA = testWallet("same-wallet/multi/A");
      const walletB = testWallet("same-wallet/multi/B");
      const walletC = asWallet(alice.browser.wallet);
      const game1 = await fundedTable(world, alice, bob, walletA, testWallet("same-wallet/multi/bob1"), "same-wallet/multi/1");
      const game2 = await fundedTable(world, bob, alice, testWallet("same-wallet/multi/bob2"), walletB, "same-wallet/multi/2");
      const game3 = await fundedTable(world, alice, bob, walletC, testWallet("same-wallet/multi/bob3"), "same-wallet/multi/3");
      assert.equal(moneyOf(await viewOf(alice.client, game1.gameId)).you?.payoutWallet, walletA.address);
      assert.equal(moneyOf(await viewOf(alice.client, game2.gameId)).you?.payoutWallet, walletB.address);
      assert.equal(moneyOf(await viewOf(alice.client, game3.gameId)).you?.payoutWallet, walletC.address);
      assert.deepEqual(await accountOf(world, alice), before, "C is still the account's Authorization Wallet, unchanged");
      for (const game of [game1, game2, game3]) {
        const started = await (game === game2 ? bob : alice).client.op({ type: "start-game" }, game.gameId);
        assert.equal(started.ok, true, JSON.stringify(started));
      }
      await world.drive(async () => [game1, game2, game3].every((game) => world.server.rooms.moneyPort.recordOf(game.gameId)?.status === "active"));
      const rosterOf = async (gameId: string) => JSON.stringify((await world.financial.load(gameId))?.roster ?? null);
      const [r1, r2, r3] = [await rosterOf(game1.gameId), await rosterOf(game2.gameId), await rosterOf(game3.gameId)];
      assert.ok(r1.includes(walletA.address) && !r1.includes(walletC.address), "Game 1 pays A, not C");
      assert.ok(r2.includes(walletB.address) && !r2.includes(walletC.address), "Game 2 pays B, not C");
      assert.ok(r3.includes(walletC.address), "Game 3 pays C -- the player chose it there");
      assert.deepEqual(await accountOf(world, alice), before);
    } finally {
      await world.close();
    }
  });

  test("nothing binds a wallet from account state: a seat has no link until its player links one, and C linked at one table binds no other", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const bob = await player(world, "Bob");
      const mine = await openMoneyTable(alice);
      const theirs = await openMoneyTable(bob);
      await seat(alice, theirs.code);
      for (const gameId of [mine.gameId, theirs.gameId]) {
        const you = moneyOf(await viewOf(alice.client, gameId)).you;
        assert.equal(you?.link ?? null, null, `no link at ${gameId} from the account alone`);
        assert.equal(you?.payoutWallet ?? null, null);
      }
      const snapshotBefore = await world.ledger.snapshot(theirs.gameId);
      assert.deepEqual(snapshotBefore.grants, [], "no wallet grant exists for a seat nobody linked");
      /* C linked at ONE table (the player's choice there) ... */
      const linked = await linkWallet(alice, mine.gameId, asWallet(alice.browser.wallet), testConsentKey("same-wallet/one"), { confirm: false });
      assert.equal(linked.status, 200, linked.text);
      /* ... binds nothing at the other. */
      assert.equal(moneyOf(await viewOf(alice.client, theirs.gameId)).you?.link ?? null, null);
      assert.deepEqual((await world.ledger.snapshot(theirs.gameId)).grants, []);
    } finally {
      await world.close();
    }
  });
});
