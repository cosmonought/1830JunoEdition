// server/src/identity/p3FinalWalletSwitch.test.ts
//
// ==================================================================
//  PHASE 3 FINAL §9 / §18: THE RED REPRODUCTION -- A WALLET USED AT A TABLE BECAME THE ACCOUNT'S WALLET
// ==================================================================
//
// The owner's model: THE PROFILE / ACCOUNT IS THE PLAYER; a Keplr wallet is not. Through caad745 the account kept a
// "verified payout wallet" that FOLLOWED whichever wallet was last linked at any seat (`moneyTables.ts` persisted every
// grant-authorized link through `associateWallet`): switching Keplr to Wallet B and linking it at a second table silently
// changed the wallet the account showed as its own (the menu's "Payout wallet", the trust facts' "verified wallet", the
// wallet that then linked without "Confirm it's you"). This test is written against what BOTH builds expose -- the
// account's own wallet in `POST /gs/api/account/me` (`wallet` at caad745, `authorizationWallet` from this pass) -- so the
// same file ran RED at caad745 (evidence: docs/phase3/evidence/p3final/) and is GREEN here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { accountPlayer, linkWallet, moneyServer, openMoneyTable, testConsentKey, testWallet } from "../escrow/escrow4Support";
import { apiRequest, quietConsole } from "../rooms/testSupport";

quietConsole();

/** The wallet the account holds as ITS OWN, as its own session reads it (either build's field). */
function accountWalletOf(body: Record<string, unknown> | null | undefined): string | null {
  const account = (body?.account ?? {}) as { authorizationWallet?: { address?: string } | null; wallet?: { address?: string } | null };
  return account.authorizationWallet?.address ?? account.wallet?.address ?? null;
}

test("§9 RED → GREEN: linking Wallet A at Game 1 and Wallet B at Game 2 never changes the account's own wallet", async () => {
  const world = await moneyServer();
  try {
    const alice = await accountPlayer(world, "alice");
    const me = async () => {
      const answer = await apiRequest(world.port, "/gs/api/account/me", { cookie: alice.browser.cookie, body: {} });
      assert.equal(answer.status, 200, answer.text);
      return { wallet: accountWalletOf(answer.body), username: (answer.body?.account as { username?: string }).username };
    };
    const before = await me();

    const game1 = await openMoneyTable(alice);
    const walletA = testWallet("p3final/game1/A");
    const linkedA = await linkWallet(alice, game1.gameId, walletA, testConsentKey("p3final/game1"));
    assert.equal(linkedA.status, 200, linkedA.text);
    const afterA = await me();

    const game2 = await openMoneyTable(alice);
    const walletB = testWallet("p3final/game2/B");
    const linkedB = await linkWallet(alice, game2.gameId, walletB, testConsentKey("p3final/game2"));
    assert.equal(linkedB.status, 200, linkedB.text);
    const afterB = await me();

    assert.equal(afterA.username, before.username, "the account is the same account");
    assert.equal(afterB.username, before.username, "the account is the same account");
    assert.deepEqual(
      { afterGame1: afterA.wallet, afterGame2: afterB.wallet },
      { afterGame1: before.wallet, afterGame2: before.wallet },
      `the account's own wallet must not follow the wallet a seat linked (before ${before.wallet}; Wallet A ${walletA.address}; Wallet B ${walletB.address})`,
    );
  } finally {
    await world.close();
  }
});
