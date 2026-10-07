// server/src/escrow/jx3bSupport.ts
//
// JX-3B test support (never imported by production code): a money world in the state a live JX-3 run reaches -- a
// host table, a joiner whose laptop links W1, the joiner's phone (signed in with the password: PHASE 3 FINAL -- no recovery
// key exists) re-proving W1 (the OD-JX3-1 re-home), the
// laptop signed out -- with the captured wallet-challenge answers and wallet-link bodies, exactly as devtools would
// show them. Synthetic only: test wallets, a test server; never real user data.

import assert from "node:assert/strict";

import { apiRequest, sessionIdOfCookie, type ApiAnswer } from "../rooms/testSupport";
import { hostCreates, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, type MoneyServer, type Player, type TestWallet } from "./escrow4Support";

const freshCookie = async (world: MoneyServer): Promise<string> => (await apiRequest(world.port, "/gs/api/session", {})).headers["set-cookie"]![0].split(";")[0];

/** A captured link: the wallet-challenge RESPONSE and the wallet-link REQUEST, as devtools shows them. */
export interface Capture {
  readonly challenge: Record<string, unknown>;
  readonly link: Record<string, unknown>;
  readonly answer: ApiAnswer;
}

export async function capturedLink(world: MoneyServer, cookie: string, password: string, gameId: string, wallet: TestWallet, consentLabel: string): Promise<Capture> {
  assert.equal((await apiRequest(world.port, "/gs/api/profile/reauth", { cookie, body: { password } })).status, 200);
  const challenge = await apiRequest(world.port, "/gs/api/money/wallet-challenge", { cookie, body: { gameId, wallet: wallet.address } });
  assert.equal(challenge.status, 200, challenge.text);
  const signed = wallet.signArbitrary(challenge.body?.text as string);
  const link = { gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: testConsentKey(consentLabel).pubkey };
  const answer = await apiRequest(world.port, "/gs/api/money/wallet-link", { cookie, body: link });
  assert.equal(answer.status, 200, answer.text);
  return { challenge: challenge.body as Record<string, unknown>, link, answer };
}

/** A host table, a joiner whose laptop links W1, then the joiner's phone (another family: a sign-in) re-proves W1, then
 *  the laptop signs out. */
export async function evidenceWorld() {
  const world = await moneyServer();
  const host = await player(world, "Hana");
  const table = await openMoneyTable(host);
  const hostWallet = testWallet("host");
  const hostLink = await linkWallet(host, table.gameId, hostWallet, testConsentKey("host"));
  await hostCreates(world, host, table.gameId, hostWallet, testConsentKey("host"), hostLink.body?.ticket as string);
  await world.observe();
  const joiner: Player = await player(world, "Jo");
  const joined = await joiner.client.op({ type: "join", code: table.code, takeSeat: true });
  const playerId = (joined.data as { playerId: string }).playerId;
  const w1 = testWallet("jo");
  const laptop = await capturedLink(world, joiner.browser.cookie, joiner.browser.password, table.gameId, w1, "jo-laptop");
  const signedIn = await apiRequest(world.port, "/gs/api/account/login", { cookie: await freshCookie(world), body: { username: joiner.browser.username, password: joiner.browser.password } });
  assert.equal(signedIn.status, 200, signedIn.text);
  const phoneCookie = signedIn.headers["set-cookie"]![0].split(";")[0];
  const phone = await capturedLink(world, phoneCookie, joiner.browser.password, table.gameId, w1, "jo-phone");
  assert.equal(phone.answer.body?.rehomed, true);
  assert.equal((await apiRequest(world.port, "/gs/api/session/revoke", { cookie: joiner.browser.cookie, body: {} })).status, 204);
  await world.money.idle();
  const families = {
    laptop: world.identity.peekSession(sessionIdOfCookie(joiner.browser.cookie))!.family_id,
    phone: world.identity.peekSession(sessionIdOfCookie(phoneCookie))!.family_id,
  };
  return { world, table, playerId, w1, laptop, phone, families, joiner, phoneCookie };
}

/** Everything that must never appear in an evidence output. */
export function assertRedacted(text: string, secrets: readonly string[]) {
  for (const prefix of ["pr_", "sf_", "se_", "rk_", "pf_", "__Host-", "recovery_selector", "recoveryKey", "recovery_hash"]) assert.equal(text.includes(prefix), false, `the output carries ${prefix}`);
  for (const secret of secrets) assert.equal(text.includes(secret), false, "the output carries a secret it must not");
}

