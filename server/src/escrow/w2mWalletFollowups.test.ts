// server/src/escrow/w2mWalletFollowups.test.ts
//
// ==================================================================
//  PHASE 3 W2-M FOLLOW-UPS (owner-approved, 2026-10-04): AUD-20.13 AND AUD-20.14, THROUGH THE PRODUCTION SURFACE
// ==================================================================
//
// AUD-20.13  the room view carries the standing link's stored proof time (`you.link.proofVerifiedAt`): a same-wallet
//            re-proof renews it while `linkedAt` stays, and a NEW connection (a reload) reads the renewed time.
// AUD-20.14  `wallet-challenge` says, before the wallet signs, which wallet this seat's standing link would replace
//            (`replaces`), so the browser asks first. A hint only: the challenge's single use, the cached answer for a
//            retry of the same signature, `challenge-used`, `challenge-expired` and the link's own `replace-required`
//            are exactly as before.
//
// Same world as `escrow4Money.test.ts`: a profiled browser's cookie, "Confirm it's you", `/gs/api/money/*`, room views
// on fresh sockets, an offline Juno, wallets that sign ADR-036 exactly as Keplr does.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Client, quietConsole } from "../rooms/testSupport";
import { hostCreates, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, type MoneyServer, type Player } from "./escrow4Support";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";

quietConsole();

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;
const HOUR = 60 * 60 * 1000;

async function seatJoiner(world: MoneyServer, name: string, code: string): Promise<{ who: Player; playerId: string }> {
  const who = await player(world, name);
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { who, playerId: (joined.data as { playerId: string }).playerId };
}

/** A bound host escrow and a seated joiner, on a table whose funding stays open for days. */
async function boundTable(world: MoneyServer) {
  const host = await player(world, "Hana");
  const table = await openMoneyTable(host);
  const hostWallet = testWallet("host");
  const hostKey = testConsentKey("host");
  const linked = await linkWallet(host, table.gameId, hostWallet, hostKey);
  assert.equal(linked.status, 200, linked.text);
  await hostCreates(world, host, table.gameId, hostWallet, hostKey, linked.body?.ticket as string);
  await world.observe();
  const joiner = await seatJoiner(world, "Jo", table.code);
  return { host, table, joiner };
}

describe("W2-M AUD-20.13: the room view carries the stored proof time", () => {
  test("a link shows its proof time; a same-wallet re-proof a day later renews it (linkedAt stays) and a reload reads the renewed time", async () => {
    const world = await moneyServer({ fundingPeriodSecs: 3 * 24 * 3600 });
    try {
      const { table, joiner } = await boundTable(world);
      const wallet = testWallet("jo");
      const key = testConsentKey("jo");
      const linkedAtClock = world.clock.now;
      assert.equal((await linkWallet(joiner.who, table.gameId, wallet, key)).status, 200);
      const first = moneyOf(await viewOf(joiner.who.client, table.gameId)).you?.link;
      assert.equal(first?.linkedAt, linkedAtClock);
      assert.equal(first?.proofVerifiedAt, linkedAtClock, "the proof verified at the link");

      world.advance(25 * HOUR);
      await world.observe();
      assert.equal((await joiner.who.api("join-admission", { gameId: table.gameId })).body?.error, "link-first", "the server's own judgement: too old");
      const renewed = await linkWallet(joiner.who, table.gameId, wallet, key);
      assert.equal(renewed.body?.mode, "unchanged", renewed.text);
      const renewedClock = world.clock.now;

      /* A reload: a NEW socket of the same seat rebuilds the view from the server alone. */
      const reload = await Client.openWithCookie(world.port, joiner.who.browser.cookie, "reload");
      const fresh = moneyOf(await viewOf(reload, table.gameId)).you?.link;
      await reload.close();
      assert.equal(fresh?.linkedAt, linkedAtClock, "the link's own time is unchanged by a re-proof");
      assert.equal(fresh?.proofVerifiedAt, renewedClock, "the renewed proof time, from the ledger");
      const grant = (await world.ledger.snapshot(table.gameId)).grants.find((entry) => entry.player_id === joiner.playerId && entry.standing);
      assert.equal(fresh?.proofVerifiedAt, grant?.proof?.verified_at, "exactly the stored value, nothing derived");
      assert.equal((await joiner.who.api("join-admission", { gameId: table.gameId })).status, 200);
    } finally {
      await world.close();
    }
  });

  test("the field is the viewer's own: another seat's view carries no link, and an unlinked seat has none", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner, host } = await boundTable(world);
      const seen = moneyOf(await viewOf(joiner.who.client, table.gameId));
      assert.equal(seen.you?.link, null, "the joiner has no link yet");
      assert.equal(JSON.stringify(seen).includes("proofVerifiedAt"), false, "no other seat's proof time is shown");
      const own = moneyOf(await viewOf(host.client, table.gameId)).you?.link;
      assert.equal(typeof own?.proofVerifiedAt, "number");
    } finally {
      await world.close();
    }
  });
});

describe("W2-M AUD-20.14: wallet-challenge names the wallet a link would replace -- before the wallet signs", () => {
  test("nothing standing: null; the linked wallet again: null; another wallet: the standing one", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const a = testWallet("host");
      const b = testWallet("other");
      await host.confirm();
      const none = await host.api("wallet-challenge", { gameId: table.gameId, wallet: a.address });
      assert.equal(none.status, 200, none.text);
      assert.equal(none.body?.replaces, null);
      assert.equal((await linkWallet(host, table.gameId, a, testConsentKey("host"))).status, 200);
      assert.equal((await host.api("wallet-challenge", { gameId: table.gameId, wallet: a.address })).body?.replaces, null, "the same wallet replaces nothing");
      assert.equal((await host.api("wallet-challenge", { gameId: table.gameId, wallet: b.address })).body?.replaces, a.address);
    } finally {
      await world.close();
    }
  });

  test("asked first, signed once: the replacement links with ONE challenge and ONE signature", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const a = testWallet("host");
      const b = testWallet("other");
      assert.equal((await linkWallet(host, table.gameId, a, testConsentKey("host"))).status, 200);
      await host.confirm();
      const challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: b.address });
      assert.equal(challenge.body?.replaces, a.address);
      /* The player confirmed the replacement before signing: the one signature carries replace. */
      const signed = b.signArbitrary(challenge.body?.text as string);
      const linked = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: testConsentKey("other").pubkey, replace: true });
      assert.equal(linked.status, 200, linked.text);
      assert.equal(linked.body?.wallet, b.address);
      assert.equal(moneyOf(await viewOf(host.client, table.gameId)).you?.link?.wallet, b.address);
    } finally {
      await world.close();
    }
  });

  test("the replay model is unchanged: a hinted challenge is single use, a retry gets the cached answer, a re-sign is challenge-used, a newer mint supersedes it", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const a = testWallet("host");
      const b = testWallet("other");
      const kb = testConsentKey("other");
      assert.equal((await linkWallet(host, table.gameId, a, testConsentKey("host"))).status, 200);
      await host.confirm();
      /* Sent without replace despite the hint: the link's own decision answers, and the challenge is spent. */
      const hinted = await host.api("wallet-challenge", { gameId: table.gameId, wallet: b.address });
      const signed = b.signArbitrary(hinted.body?.text as string);
      const body = { gameId: table.gameId, nonce: hinted.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: kb.pubkey };
      const first = await host.api("wallet-link", body);
      assert.equal(first.status, 409);
      assert.equal(first.body?.error, "replace-required");
      /* The same signed request again -- even asking to replace -- is the cached answer, never a second decision. */
      const retried = await host.api("wallet-link", { ...body, replace: true });
      assert.deepEqual(retried.body, first.body, "a consumed challenge answers only what it answered");
      /* Another signature string on the spent nonce: refused as used (never decided again). */
      const resigned = await host.api("wallet-link", { ...body, signature: testWallet("third").signArbitrary(String(hinted.body?.text), b.address).signature, replace: true });
      assert.equal(resigned.body?.error, "challenge-used", resigned.text);
      assert.equal(moneyOf(await viewOf(host.client, table.gameId)).you?.link?.wallet, a.address, "nothing was replaced");
      /* An unspent hinted challenge is superseded by the next mint (asking first costs no stale request). */
      const unspent = await host.api("wallet-challenge", { gameId: table.gameId, wallet: b.address });
      const next = await host.api("wallet-challenge", { gameId: table.gameId, wallet: b.address });
      const late = b.signArbitrary(unspent.body?.text as string);
      const stale = await host.api("wallet-link", { gameId: table.gameId, nonce: unspent.body?.nonce, pubKey: late.pubKey, signature: late.signature, consentKey: kb.pubkey, replace: true });
      assert.equal(stale.body?.error, "challenge-expired");
      assert.notEqual(next.body?.nonce, unspent.body?.nonce);
    } finally {
      await world.close();
    }
  });

  test("the hint is never a way in: no Confirm it's you, no challenge and no hint; another seat learns nothing of this seat's wallet", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await boundTable(world);
      const jo = testWallet("jo");
      const bare = await joiner.who.api("wallet-challenge", { gameId: table.gameId, wallet: jo.address });
      assert.equal(bare.status, 403);
      assert.equal(bare.body?.replaces, undefined);
      await joiner.who.confirm();
      /* Naming the HOST's wallet: the joiner's own seat stands on nothing, so the hint is null -- not the host's. */
      const probe = await joiner.who.api("wallet-challenge", { gameId: table.gameId, wallet: testWallet("host").address });
      assert.equal(probe.status, 200, probe.text);
      assert.equal(probe.body?.replaces, null);
    } finally {
      await world.close();
    }
  });

  test("a ledger that can't be read just now: the challenge is still minted, without a hint (the link still decides)", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      await host.confirm();
      const ledger = world.ledger as { snapshot: (gameId: string) => Promise<unknown> };
      const real = ledger.snapshot;
      let failOnce = true;
      ledger.snapshot = async (gameId: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("ledger unavailable");
        }
        return real.call(world.ledger, gameId);
      };
      try {
        const challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: testWallet("host").address });
        assert.equal(challenge.status, 200, challenge.text);
        assert.equal("replaces" in (challenge.body ?? {}), false);
      } finally {
        ledger.snapshot = real;
      }
    } finally {
      await world.close();
    }
  });
});
