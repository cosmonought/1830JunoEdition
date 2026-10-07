// server/src/identity/p3FinalAccountWallet.test.ts
//
// ==================================================================
//  PHASE 3 FINAL ACCOUNT / WALLET IDENTITY -- THE ADVERSARIAL SUITE (brief §17-§20)
// ==================================================================
//
// The owner's model, tested end to end over real HTTP, real sockets, production identity and the offline Juno chain
// (`escrow4Support.ts`'s world):
//
//   THE PROFILE / ACCOUNT IS THE PLAYER. A Keplr wallet is not. An account is a username, a password and ONE designated
//   AUTHORIZATION WALLET. Ordinary login is the username and password. The Authorization Wallet signs only CREATE,
//   "Forgot password?" (RECOVER) and its own replacement (REPLACE-APPROVE by the current wallet + REPLACE-ACCEPT by the new
//   one, under an explicit "Confirm it's you"). A seat's wallet is chosen per table, and once anted it is that seat's
//   deposit/payout wallet for good. Every player game is anted.
//
//   §17  account and recovery: what creates, signs in, recovers and replaces -- and every forgery, replay, expiry,
//        cross-account and cross-purpose use refused, with no answer that tells a stranger which username exists.
//   §18  profile vs wallet: no wallet -- the Authorization Wallet, a seat's game wallet, another account's -- ever answers
//        "who is this"; recovery and replacement never touch a seat, its wallet, trust history or escrow ownership.
//        (The RED reproduction of the defect is `p3FinalWalletSwitch.test.ts`.)
//   §19  multi-game, multi-wallet: Game 1 -> Wallet A, Game 2 -> Wallet B, Authorization Wallet C; play needs no wallet;
//        a signing operation at a game asks for THAT game's wallet; nothing changes a seat.
//   §20  payout immutability (once anted, the seat's wallet is fixed: relink the same wallet, never another), and no free
//        player mode (a production room host refuses a no-ante table's create, seat and start; watching stays open).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { parseProfileAuthorization } from "../../../frontend/src/utils/profileAuthorizationV1";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, type MoneyServer, type Player } from "../escrow/escrow4Support";
import { createMemoryRecordStore } from "../rooms/recordStore";
import { BUY, Client, apiRequest, bootstrapCookie, cookieFromAnswer, loginOnFreshBrowser, quietConsole, startServer, stopServer, until, type ApiAnswer } from "../rooms/testSupport";
import { keplrAccount, type KeplrAccount } from "../testSupport/authorizationWallets";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";

quietConsole();

const NEW_PASSWORD = "a brand new long password";
/** This package's TypeScript sources (the suite runs from dist/server/src/identity). */
const SERVER_SRC = path.join(__dirname, "..", "..", "..", "..", "src");
/** Past a seat's join admission (600 s) and its clock skew: a funded seat's own deposit is then what decides a link. */
const PAST_ADMISSION_MS = 12 * 60 * 1000;
const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;
const lastIndexSeen = (client: Client): number => client.seen().reduce((max, entry) => Math.max(max, entry.index), -1);

/* ------------------------------------------------------------------ */
/* Browser steps over HTTP                                             */
/* ------------------------------------------------------------------ */

type Minted = { operation: string; texts: Array<{ purpose: string; signer: string; text: string }>; expiresAt: number };

async function mint(world: { port: number }, cookie: string, purpose: "create" | "recover", username: string, wallet: string): Promise<{ answer: ApiAnswer; minted: Minted | null }> {
  const answer = await apiRequest(world.port, "/gs/api/account/authorization", { cookie, body: { purpose, username, wallet } });
  return { answer, minted: answer.status === 200 ? (answer.body as unknown as Minted) : null };
}

async function createWith(world: { port: number }, cookie: string, input: { username: string; password?: string; name?: string; operation: string; pubKey: string; signature: string }): Promise<ApiAnswer> {
  return apiRequest(world.port, "/gs/api/account/create", { cookie, body: { username: input.username, password: input.password ?? "correct horse battery", name: input.name ?? input.username.slice(0, 24), operation: input.operation, pubKey: input.pubKey, signature: input.signature } });
}

async function recoverWith(world: { port: number }, cookie: string, operation: string, signed: { pubKey: string; signature: string }, newPassword = NEW_PASSWORD): Promise<ApiAnswer> {
  return apiRequest(world.port, "/gs/api/account/recover", { cookie, body: { operation, ...signed, newPassword } });
}

/** "Forgot password?" on a fresh browser: mint RECOVER for (username, wallet), signed by `signer`. */
async function forgotPassword(world: { port: number }, username: string, wallet: KeplrAccount, signer: KeplrAccount = wallet, newPassword = NEW_PASSWORD): Promise<{ answer: ApiAnswer; cookie: string | null }> {
  const fresh = await bootstrapCookie(world.port);
  const { minted } = await mint(world, fresh, "recover", username, wallet.address);
  assert.ok(minted, "RECOVER is minted for any well-formed username and wallet (it looks nothing up)");
  const answer = await recoverWith(world, fresh, minted.operation, signer.sign(minted.texts[0].text), newPassword);
  return { answer, cookie: answer.status === 200 ? cookieFromAnswer(answer) : null };
}

async function accountOf(world: { port: number }, cookie: string): Promise<ApiAnswer> {
  return apiRequest(world.port, "/gs/api/account/me", { cookie, body: {} });
}

const authorizationWalletOf = (answer: ApiAnswer): { address: string; since: number } | null =>
  ((answer.body?.account as { authorizationWallet?: { address: string; since: number } } | undefined)?.authorizationWallet ?? null);

async function replaceChallenge(world: { port: number }, cookie: string, newWallet: string): Promise<{ answer: ApiAnswer; minted: Minted | null }> {
  const answer = await apiRequest(world.port, "/gs/api/account/authorization-wallet/challenge", { cookie, body: { newWallet } });
  return { answer, minted: answer.status === 200 ? (answer.body as unknown as Minted) : null };
}

async function replaceWith(world: { port: number }, cookie: string, operation: string, approve: { pubKey: string; signature: string }, accept: { pubKey: string; signature: string }): Promise<ApiAnswer> {
  return apiRequest(world.port, "/gs/api/account/authorization-wallet/replace", {
    cookie,
    body: { operation, approvePubKey: approve.pubKey, approveSignature: approve.signature, acceptPubKey: accept.pubKey, acceptSignature: accept.signature },
  });
}

const reauth = (world: { port: number }, cookie: string, password: string) => apiRequest(world.port, "/gs/api/profile/reauth", { cookie, body: { password } });

/** A Player for a cookie a later step issued (a login, a recovery). */
async function playerOn(world: MoneyServer, cookie: string, base: Player, password: string): Promise<Player> {
  const client = await Client.openWithCookie(world.port, cookie, `${base.name}-again`);
  return {
    browser: { ...base.browser, cookie, password },
    client,
    name: base.name,
    api: (route, body = {}) => apiRequest(world.port, `/gs/api/money/${route}`, { cookie, body }),
    async confirm() {
      const answer = await reauth(world, cookie, password);
      if (answer.status !== 200) throw new Error(`reauth: ${answer.status} ${answer.text}`);
    },
  };
}

async function seat(world: MoneyServer, who: Player, code: string): Promise<string> {
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return (joined.data as { playerId: string }).playerId;
}

/** A funded two-seat table: `host` antes from `hostWallet` (CreateGame), `joiner` from `joinerWallet` (Join). */
async function fundedTable(world: MoneyServer, host: Player, joiner: Player, hostWallet: ReturnType<typeof testWallet>, joinerWallet: ReturnType<typeof testWallet>, label: string) {
  const table = await openMoneyTable(host);
  const hostKey = testConsentKey(`${label}/host`);
  const hostLink = await linkWallet(host, table.gameId, hostWallet, hostKey);
  assert.equal(hostLink.status, 200, hostLink.text);
  const chainGameId = await hostCreates(world, host, table.gameId, hostWallet, hostKey, hostLink.body?.ticket as string);
  await world.observe();
  const joinerPlayerId = await seat(world, joiner, table.code);
  const joinerKey = testConsentKey(`${label}/joiner`);
  const joinerLink = await linkWallet(joiner, table.gameId, joinerWallet, joinerKey);
  assert.equal(joinerLink.status, 200, joinerLink.text);
  await joinerFunds(world, joiner, table.gameId, joinerWallet, joinerKey, joinerLink.body?.ticket as string);
  await world.observe();
  return { ...table, chainGameId, joinerPlayerId };
}

/* ================================================================== */
/* §17 -- ACCOUNT CREATION, SIGN-IN, RECOVERY, REPLACEMENT             */
/* ================================================================== */

describe("PHASE 3 FINAL §17: an account is made only with its Authorization Wallet's signature over THIS browser's CREATE text", () => {
  test("the text says what it is; a wrong signer, a wrong username, another browser's text, a tampered text, an expired one and a replay are all refused; the right one makes the account", async () => {
    const world = await moneyServer();
    try {
      const wallet = keplrAccount("p3final/create/C");
      const stranger = keplrAccount("p3final/create/X");
      const browser = await bootstrapCookie(world.port);

      /* The text: the domain tag, the purpose, this site, the account, the wallet that signs, and that it moves nothing. */
      const first = await mint(world, browser, "create", "Carla", wallet.address);
      assert.equal(first.answer.status, 200, first.answer.text);
      const minted = first.minted as Minted;
      assert.equal(minted.texts.length, 1);
      const fields = parseProfileAuthorization(minted.texts[0].text);
      assert.ok(fields !== null);
      assert.equal(fields.purpose, "CREATE");
      assert.equal(fields.site, "https://play.example");
      assert.equal(fields.account, "Carla");
      assert.equal(fields.signer, wallet.address);
      assert.equal(fields.authorizationWallet, wallet.address);
      assert.match(minted.texts[0].text, /^18COSMOS\/PROFILE-AUTHORIZATION\/v1\n/);
      assert.match(minted.texts[0].text, /This is not a transaction: it moves no funds and grants no permission to spend\./);
      assert.doesNotMatch(minted.texts[0].text, /1830/, "design note 708: no player reads 1830");

      /* Signed by another wallet than the text's signer. */
      const wrongSigner = await createWith(world, browser, { username: "Carla", operation: minted.operation, ...stranger.sign(minted.texts[0].text) });
      assert.deepEqual([wrongSigner.status, wrongSigner.body?.error], [403, "authorization-invalid"]);
      /* A tampered text (the signature is over other bytes). */
      const again = (await mint(world, browser, "create", "Carla", wallet.address)).minted as Minted;
      const tampered = await createWith(world, browser, { username: "Carla", operation: again.operation, ...wallet.sign(again.texts[0].text.replace("Purpose: CREATE", "Purpose: RECOVER")) });
      assert.deepEqual([tampered.status, tampered.body?.error], [403, "authorization-invalid"]);
      /* The right signature for ANOTHER username than the one asked for. */
      const forCarla = (await mint(world, browser, "create", "Carla", wallet.address)).minted as Minted;
      const otherName = await createWith(world, browser, { username: "Mallory", operation: forCarla.operation, ...wallet.sign(forCarla.texts[0].text) });
      assert.equal(otherName.status, 403, otherName.text);
      /* Another browser's operation. */
      const elsewhere = await bootstrapCookie(world.port);
      const theirs = (await mint(world, elsewhere, "create", "Carla", wallet.address)).minted as Minted;
      const stolen = await createWith(world, browser, { username: "Carla", operation: theirs.operation, ...wallet.sign(theirs.texts[0].text) });
      assert.equal(stolen.status, 403, stolen.text);
      /* An expired one (five minutes). */
      const late = (await mint(world, browser, "create", "Carla", wallet.address)).minted as Minted;
      world.advance(5 * 60 * 1000 + 1_000);
      const expired = await createWith(world, browser, { username: "Carla", operation: late.operation, ...wallet.sign(late.texts[0].text) });
      assert.equal(expired.status, 403, expired.text);
      /* Nothing above made an account. */
      assert.equal((await loginOnFreshBrowser(world.port, "Carla", "correct horse battery")).answer.status, 403);

      /* The right one. */
      const good = (await mint(world, browser, "create", "Carla", wallet.address)).minted as Minted;
      const signed = wallet.sign(good.texts[0].text);
      const created = await createWith(world, browser, { username: "Carla", operation: good.operation, ...signed });
      assert.equal(created.status, 201, created.text);
      assert.equal("recoveryKey" in (created.body ?? {}), false, "no recovery key exists");
      const cookie = cookieFromAnswer(created) as string;
      const me = await accountOf(world, cookie);
      assert.deepEqual(authorizationWalletOf(me), { address: wallet.address, since: world.clock.now });
      /* A replay: the operation is spent, and the old browser's temporary cookie was replaced by the sign-in. */
      const replay = await createWith(world, browser, { username: "Carla", operation: good.operation, ...signed });
      assert.notEqual(replay.status, 201);
      const replayElsewhere = await createWith(world, elsewhere, { username: "Carla2", operation: good.operation, ...signed });
      assert.notEqual(replayElsewhere.status, 201);
    } finally {
      await world.close();
    }
  });

  test("a username is told 'taken' before Keplr is asked to sign; no account exists without its Authorization Wallet", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const browser = await bootstrapCookie(world.port);
      const taken = await mint(world, browser, "create", alice.browser.username, keplrAccount("p3final/taken").address);
      assert.deepEqual([taken.answer.status, taken.answer.body?.error], [409, "username-taken"]);
      /* A create with no proof at all is malformed (closed body: every field required). */
      const bare = await apiRequest(world.port, "/gs/api/account/create", { cookie: browser, body: { username: "Nobody", password: "correct horse battery", name: "Nobody" } });
      assert.ok([400, 403].includes(bare.status), `refused (${bare.status} ${bare.text})`);
      /* Every account in the store holds exactly one Authorization Wallet. */
      for (const profile of world.identityStore.snapshot().profiles ?? []) {
        assert.equal(profile.schema, 3);
        assert.match(String(profile.wallet_address), /^juno1/);
      }
    } finally {
      await world.close();
    }
  });
});

describe("PHASE 3 FINAL §17 / §5: ordinary sign-in is the username and password -- never a wallet", () => {
  test("login takes exactly {username, password}; a wallet or signature field is refused; one answer for every wrong credential", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const fresh = await bootstrapCookie(world.port);
      const withWallet = await apiRequest(world.port, "/gs/api/account/login", { cookie: fresh, body: { username: alice.browser.username, password: alice.browser.password, wallet: alice.browser.wallet.address } });
      assert.equal(withWallet.status, 400, "a login body is closed: no wallet field exists");
      const signedIn = await loginOnFreshBrowser(world.port, alice.browser.username, alice.browser.password);
      assert.equal(signedIn.answer.status, 200, signedIn.answer.text);
      assert.deepEqual(authorizationWalletOf(await accountOf(world, signedIn.cookie as string))?.address, alice.browser.wallet.address);
      const wrong = await loginOnFreshBrowser(world.port, alice.browser.username, "not the password at all");
      const unknown = await loginOnFreshBrowser(world.port, "nobody-at-all", "not the password at all");
      assert.deepEqual([wrong.answer.status, wrong.answer.body], [unknown.answer.status, unknown.answer.body], "a wrong password and an unknown username answer alike");
    } finally {
      await world.close();
    }
  });
});

describe("PHASE 3 FINAL §17 / §6: \"Forgot password?\" is the Authorization Wallet's -- nothing else recovers, and no answer tells a stranger anything", () => {
  test("a seat's game wallet, another account's Authorization Wallet, a wrong signer and an unknown username are refused with ONE answer; RECOVER is minted for any username", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const bob = await player(world, "Bob");
      /* Alice's GAME wallet: linked at one of her seats (proven by its own signature) -- still not her account's authority. */
      const table = await openMoneyTable(alice);
      const gameWallet = testWallet("p3final/alice/game");
      assert.equal((await linkWallet(alice, table.gameId, gameWallet, testConsentKey("p3final/alice"))).status, 200);
      const gameKeplr: KeplrAccount = { secret: gameWallet.secret, pubkey: gameWallet.pubkey, address: gameWallet.address, sign: (text) => gameWallet.signArbitrary(text) };

      const refusals: Array<[string, ApiAnswer]> = [];
      refusals.push(["the seat's game wallet", (await forgotPassword(world, alice.browser.username, gameKeplr)).answer]);
      refusals.push(["Bob's Authorization Wallet", (await forgotPassword(world, alice.browser.username, bob.browser.wallet)).answer]);
      refusals.push(["a text for Alice's wallet signed by Bob's", (await forgotPassword(world, alice.browser.username, alice.browser.wallet, bob.browser.wallet)).answer]);
      refusals.push(["an unknown username", (await forgotPassword(world, "nobody-here-at-all", alice.browser.wallet)).answer]);
      refusals.push(["Alice's wallet for Bob's username", (await forgotPassword(world, bob.browser.username, alice.browser.wallet)).answer]);
      for (const [why, answer] of refusals) assert.deepEqual([why, answer.status, answer.body], [why, 403, { error: "invalid-credential" }], why);
      /* Nothing changed: both still sign in with their own passwords. */
      assert.equal((await loginOnFreshBrowser(world.port, alice.browser.username, alice.browser.password)).answer.status, 200);
      assert.equal((await loginOnFreshBrowser(world.port, bob.browser.username, bob.browser.password)).answer.status, 200);
      /* The RECOVER text names the account and the wallet it was asked for -- whatever the username (no lookup). */
      const stranger = await mint(world, await bootstrapCookie(world.port), "recover", "nobody-here-at-all", alice.browser.wallet.address);
      const real = await mint(world, await bootstrapCookie(world.port), "recover", alice.browser.username, alice.browser.wallet.address);
      assert.deepEqual([stranger.answer.status, Object.keys(stranger.answer.body ?? {}).sort()], [real.answer.status, Object.keys(real.answer.body ?? {}).sort()]);
    } finally {
      await world.close();
    }
  });

  test("the right wallet recovers: every device of the account is signed out, the browser is signed in fresh -- and the seat, its wallet, the Authorization Wallet and trust are untouched", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const alice = await player(world, "Alice");
      const walletA = testWallet("p3final/recover/A");
      const table = await fundedTable(world, host, alice, testWallet("p3final/recover/host"), walletA, "p3final/recover");
      world.advance(PAST_ADMISSION_MS);
      await world.observe();
      const phone = await loginOnFreshBrowser(world.port, alice.browser.username, alice.browser.password);
      assert.equal(phone.answer.status, 200);
      const trustBefore = await apiRequest(world.port, "/gs/api/trust/me", { cookie: alice.browser.cookie, body: {} });
      const viewBefore = moneyOf(await viewOf(alice.client, table.gameId));
      assert.equal(viewBefore.you?.payoutWallet, walletA.address);
      const chainBefore = JSON.stringify(world.chain.games.get(Number(table.chainGameId)));

      const recovered = await forgotPassword(world, alice.browser.username, alice.browser.wallet);
      assert.equal(recovered.answer.status, 200, recovered.answer.text);
      assert.ok(recovered.cookie);
      /* Every earlier session of the account is over (the laptop's socket closes 4401; the phone's cookie is dead). */
      assert.equal(await alice.client.closed, 4401);
      assert.equal((await accountOf(world, alice.browser.cookie)).status, 401);
      assert.equal((await accountOf(world, phone.cookie as string)).status, 401);
      assert.equal((await loginOnFreshBrowser(world.port, alice.browser.username, alice.browser.password)).answer.status, 403, "the old password is gone");
      assert.equal((await loginOnFreshBrowser(world.port, alice.browser.username, NEW_PASSWORD)).answer.status, 200);

      /* The account and everything bound to it are the same. */
      const me = await accountOf(world, recovered.cookie as string);
      assert.equal(authorizationWalletOf(me)?.address, alice.browser.wallet.address, "the Authorization Wallet is kept");
      const again = await playerOn(world, recovered.cookie as string, alice, NEW_PASSWORD);
      try {
        const tables = ((await again.client.op({ type: "my-tables" })).data as { tables: Array<{ gameId: string }> }).tables.map((entry) => entry.gameId);
        assert.deepEqual(tables, [table.gameId], "the seat is the account's");
        const view = await viewOf(again.client, table.gameId);
        assert.equal((view.you as { playerId: string }).playerId, table.joinerPlayerId, "the same seat");
        assert.equal(JSON.stringify(world.chain.games.get(Number(table.chainGameId))), chainBefore, "escrow ownership on Juno is untouched");
        /* The seat's deposit is still from Wallet A; after a security event the link is relinked with the SAME wallet, free. */
        const other = await linkWallet(again, table.gameId, testWallet("p3final/recover/B"), testConsentKey("p3final/recover/B"));
        assert.equal(other.status, 409, other.text);
        assert.equal(other.body?.error, "withdraw-or-relink-first");
        const relinked = await linkWallet(again, table.gameId, walletA, testConsentKey("p3final/recover/A2"));
        assert.equal(relinked.status, 200, relinked.text);
        await world.observe();
        assert.equal(moneyOf(await viewOf(again.client, table.gameId)).you?.payoutWallet, walletA.address);
        const trustAfter = await apiRequest(world.port, "/gs/api/trust/me", { cookie: recovered.cookie as string, body: {} });
        assert.deepEqual(trustAfter.body, trustBefore.body, "trust history is untouched");
      } finally {
        await again.client.close();
      }
    } finally {
      await world.close();
    }
  });

  test("a RECOVER operation is single use, and a RECOVER signature is not a CREATE or REPLACE one", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const fresh = await bootstrapCookie(world.port);
      const { minted } = await mint(world, fresh, "recover", alice.browser.username, alice.browser.wallet.address);
      assert.ok(minted);
      const signed = alice.browser.wallet.sign(minted.texts[0].text);
      /* Used as a CREATE proof for a new username: refused. */
      const asCreate = await createWith(world, fresh, { username: "Recovered-As-New", operation: minted.operation, ...signed });
      assert.notEqual(asCreate.status, 201);
      /* Used as a REPLACE approval by a signed-in Alice: refused. */
      assert.equal((await reauth(world, alice.browser.cookie, alice.browser.password)).status, 200);
      const replacement = (await replaceChallenge(world, alice.browser.cookie, keplrAccount("p3final/xp/N").address)).minted as Minted;
      const crossed = await replaceWith(world, alice.browser.cookie, replacement.operation, signed, keplrAccount("p3final/xp/N").sign(replacement.texts[1].text));
      assert.equal(crossed.status, 403, crossed.text);
      assert.equal(authorizationWalletOf(await accountOf(world, alice.browser.cookie))?.address, alice.browser.wallet.address);
    } finally {
      await world.close();
    }
  });
});

describe("PHASE 3 FINAL §17 / §7: changing the Authorization Wallet -- the password alone is never enough; the current wallet approves and the new one accepts", () => {
  test("the sign-in grant is not enough; wrong approver or acceptor refused; both right signatures replace it; the old wallet stops recovering, even a RECOVER minted before", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const current = alice.browser.wallet;
      const next = keplrAccount("p3final/replace/N");
      /* A RECOVER for the current wallet, minted (not yet answered) before the replacement. */
      const pendingBrowser = await bootstrapCookie(world.port);
      const pending = (await mint(world, pendingBrowser, "recover", alice.browser.username, current.address)).minted as Minted;

      const tooSoon = await replaceChallenge(world, alice.browser.cookie, next.address);
      assert.deepEqual([tooSoon.answer.status, tooSoon.answer.body?.error], [403, "reauth-required"], "a sign-in's automatic grant never opens a replacement");
      assert.equal((await reauth(world, alice.browser.cookie, alice.browser.password)).status, 200);
      const same = await replaceChallenge(world, alice.browser.cookie, current.address);
      assert.deepEqual([same.answer.status, same.answer.body?.error], [409, "same-wallet"]);

      const first = (await replaceChallenge(world, alice.browser.cookie, next.address)).minted as Minted;
      assert.deepEqual(first.texts.map((text) => [text.purpose, text.signer]), [["REPLACE-APPROVE", current.address], ["REPLACE-ACCEPT", next.address]]);
      /* The new wallet signing both texts (no approval from the current one). */
      const noApproval = await replaceWith(world, alice.browser.cookie, first.operation, next.sign(first.texts[0].text), next.sign(first.texts[1].text));
      assert.deepEqual([noApproval.status, noApproval.body?.error], [403, "authorization-invalid"]);
      const second = (await replaceChallenge(world, alice.browser.cookie, next.address)).minted as Minted;
      /* The current wallet signing both (no acceptance by the new one). */
      const noAcceptance = await replaceWith(world, alice.browser.cookie, second.operation, current.sign(second.texts[0].text), current.sign(second.texts[1].text));
      assert.deepEqual([noAcceptance.status, noAcceptance.body?.error], [403, "authorization-invalid"]);
      assert.equal(authorizationWalletOf(await accountOf(world, alice.browser.cookie))?.address, current.address, "nothing changed yet");

      const third = (await replaceChallenge(world, alice.browser.cookie, next.address)).minted as Minted;
      const approve = current.sign(third.texts[0].text);
      const accept = next.sign(third.texts[1].text);
      const replaced = await replaceWith(world, alice.browser.cookie, third.operation, approve, accept);
      assert.equal(replaced.status, 200, replaced.text);
      assert.equal(authorizationWalletOf(await accountOf(world, alice.browser.cookie))?.address, next.address);
      /* A replay of the same pair changes nothing more. */
      assert.notEqual((await replaceWith(world, alice.browser.cookie, third.operation, approve, accept)).status, 200);

      /* The RECOVER minted for the old wallet before the replacement is dead; so is a fresh one; the new wallet recovers. */
      const stale = await recoverWith(world, pendingBrowser, pending.operation, current.sign(pending.texts[0].text));
      assert.deepEqual([stale.status, stale.body], [403, { error: "invalid-credential" }]);
      assert.equal((await forgotPassword(world, alice.browser.username, current)).answer.status, 403);
      assert.equal((await forgotPassword(world, alice.browser.username, next)).answer.status, 200);
    } finally {
      await world.close();
    }
  });

  test("no operator override and nothing without the Authorization Wallet: every retired recovery route answers 410, and the only password reset needs the wallet's signature", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const fresh = await bootstrapCookie(world.port);
      for (const route of ["/gs/api/profile", "/gs/api/profile/recover", "/gs/api/profile/link", "/gs/api/profile/link-code", "/gs/api/profile/recovery-key", "/gs/api/profile/key-received", "/gs/api/account/credentials", "/gs/api/account/forget-wallet", "/gs/api/account/reset"]) {
        const answer = await apiRequest(world.port, route, { cookie: fresh, body: { username: alice.browser.username, recoveryKey: "rk_x", newPassword: NEW_PASSWORD } });
        assert.deepEqual([route, answer.status, answer.body?.error], [route, 410, "retired"]);
      }
      const unsigned = await apiRequest(world.port, "/gs/api/account/recover", { cookie: fresh, body: { username: alice.browser.username, newPassword: NEW_PASSWORD } });
      assert.equal(unsigned.status, 400, "a recovery without an operation and its signature is not a request");
      assert.equal((await loginOnFreshBrowser(world.port, alice.browser.username, alice.browser.password)).answer.status, 200, "the password is unchanged");
      /* The source: no identity route besides the Authorization Wallet's RECOVER replaces a password while signed out. */
      const httpApi = fs.readFileSync(path.join(SERVER_SRC, "identity", "httpApi.ts"), "utf8");
      assert.equal(/operator|override|adminReset|forceReset/i.test(httpApi.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), false);
    } finally {
      await world.close();
    }
  });
});

/* ================================================================== */
/* §18 -- PROFILE VS WALLET: NO WALLET IS "WHO"                        */
/* ================================================================== */

describe("PHASE 3 FINAL §18: who a browser is comes from its session; a wallet never answers it", () => {
  test("Keplr on another account at a table changes nothing: the seat, the player and the account stay; a different wallet at a linked seat is only ever an explicit replacement", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const table = await openMoneyTable(alice);
      const walletA = testWallet("p3final/who/A");
      const walletB = testWallet("p3final/who/B");
      assert.equal((await linkWallet(alice, table.gameId, walletA, testConsentKey("p3final/who/A"))).status, 200);
      const before = await viewOf(alice.client, table.gameId);
      /* "Keplr switched to B": a challenge for B at the same seat is a REPLACEMENT the server asks about, never a new identity. */
      const unasked = await linkWallet(alice, table.gameId, walletB, testConsentKey("p3final/who/B"));
      assert.deepEqual([unasked.status, unasked.body?.error], [409, "replace-required"]);
      const after = await viewOf(alice.client, table.gameId);
      assert.deepEqual((after.you as Record<string, unknown>).playerId, (before.you as Record<string, unknown>).playerId);
      assert.equal(moneyOf(after).you?.link?.wallet, walletA.address, "the seat keeps Wallet A");
      assert.equal(authorizationWalletOf(await accountOf(world, alice.browser.cookie))?.address, alice.browser.wallet.address);
      /* Bob proving Alice's Authorization Wallet at HIS seat binds it to HIS seat -- it never makes him Alice. */
      const bob = await player(world, "Bob");
      await seat(world, bob, table.code);
      const aliceWallet = alice.browser.wallet;
      const asTest = { secret: aliceWallet.secret, pubkey: aliceWallet.pubkey, address: aliceWallet.address, signArbitrary: (text: string) => aliceWallet.sign(text) };
      const linked = await linkWallet(bob, table.gameId, asTest, testConsentKey("p3final/who/bob"));
      assert.equal(linked.status, 200, linked.text);
      const bobView = await viewOf(bob.client, table.gameId);
      assert.notEqual((bobView.you as { playerId: string }).playerId, (after.you as { playerId: string }).playerId);
      const bobMe = await accountOf(world, bob.browser.cookie);
      assert.equal((bobMe.body?.account as { username: string }).username, bob.browser.username, "Bob is still Bob");
      assert.equal(authorizationWalletOf(bobMe)?.address, bob.browser.wallet.address, "and his Authorization Wallet is still his");
    } finally {
      await world.close();
    }
  });

  test("the server's identity layer never maps a wallet to a principal: no index, no lookup, no persisted game wallet", () => {
    const root = path.join(SERVER_SRC, "identity");
    const sessions = fs.readFileSync(path.join(root, "sessions.ts"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(/associateWallet|profileWallet|forgetWallet|byWallet|walletIndex|profileOfWallet/.test(sessions), false);
    const money = fs.readFileSync(path.join(root, "..", "escrow", "moneyTables.ts"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(/associateWallet|profileWallet/.test(money), false, "a seat link never writes anything to the account");
  });
});

/* ================================================================== */
/* §19 -- MULTI-GAME, MULTI-WALLET                                     */
/* ================================================================== */

describe("PHASE 3 FINAL §19: Game 1 on Wallet A, Game 2 on Wallet B, Authorization Wallet C -- one player, no switching to play", () => {
  test("both tables fund and deal; Alice moves at both on one socket with no wallet; each seat keeps its own wallet; a signing step at a game names THAT game's wallet; C changes neither", async () => {
    const world = await moneyServer();
    try {
      const alice = await player(world, "Alice");
      const bob = await player(world, "Bob");
      const walletA = testWallet("p3final/multi/A");
      const walletB = testWallet("p3final/multi/B");
      /* Game 1: Alice hosts on A; Bob joins. Game 2: Bob hosts; Alice joins on B. */
      const game1 = await fundedTable(world, alice, bob, walletA, testWallet("p3final/multi/bob1"), "p3final/multi/1");
      const game2 = await fundedTable(world, bob, alice, testWallet("p3final/multi/bob2"), walletB, "p3final/multi/2");
      assert.equal(moneyOf(await viewOf(alice.client, game1.gameId)).you?.payoutWallet, walletA.address);
      assert.equal(moneyOf(await viewOf(alice.client, game2.gameId)).you?.payoutWallet, walletB.address);
      assert.equal(authorizationWalletOf(await accountOf(world, alice.browser.cookie))?.address, alice.browser.wallet.address, "C is neither A nor B");

      assert.equal((await alice.client.op({ type: "start-game" }, game1.gameId)).ok, true);
      assert.equal((await bob.client.op({ type: "start-game" }, game2.gameId)).ok, true);
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(game1.gameId)?.status === "active" && world.server.rooms.moneyPort.recordOf(game2.gameId)?.status === "active");

      /* Play: the session is the authority; no frame names a wallet and none is asked for. */
      alice.client.hello(game1.gameId);
      await until(() => alice.client.seen().length > 0, "alice's catch-up at game 1");
      alice.client.submit(BUY, { baseIndex: lastIndexSeen(alice.client), submissionId: "g1-a" });
      assert.equal((await alice.client.answerTo("g1-a")).kind, "applied");
      const bobGame2 = await Client.openWithCookie(world.port, bob.browser.cookie, "bob-g2");
      try {
        bobGame2.hello(game2.gameId);
        await until(() => bobGame2.seen().length > 0, "bob's catch-up at game 2");
        bobGame2.submit(BUY, { baseIndex: lastIndexSeen(bobGame2), submissionId: "g2-b" });
        assert.equal((await bobGame2.answerTo("g2-b")).kind, "applied");
      } finally {
        await bobGame2.close();
      }
      const aliceGame2 = await Client.openWithCookie(world.port, alice.browser.cookie, "alice-g2");
      try {
        aliceGame2.hello(game2.gameId);
        await until(() => lastIndexSeen(aliceGame2) >= 1, "alice's catch-up at game 2");
        aliceGame2.submit(BUY, { baseIndex: lastIndexSeen(aliceGame2), submissionId: "g2-a" });
        assert.equal((await aliceGame2.answerTo("g2-a")).kind, "applied");
      } finally {
        await aliceGame2.close();
      }

      /* Signing operations: each table's seat answers only for its own wallet, and a started seat's wallet never moves. */
      const view1 = moneyOf(await viewOf(alice.client, game1.gameId));
      const view2 = moneyOf(await viewOf(alice.client, game2.gameId));
      assert.equal(view1.you?.payoutWallet, walletA.address);
      assert.equal(view2.you?.payoutWallet, walletB.address);
      for (const [gameId, wallet] of [[game1.gameId, walletB], [game2.gameId, walletA]] as const) {
        const crossed = await linkWallet(alice, gameId, wallet, testConsentKey(`p3final/multi/cross/${gameId}`), { replace: true });
        assert.equal(crossed.status, 409, crossed.text);
        assert.ok(["frozen", "wrong-state"].includes(String(crossed.body?.error)), `a started seat's payout wallet can't change (${crossed.text})`);
      }
      /* Replacing C changes neither seat. */
      assert.equal((await reauth(world, alice.browser.cookie, alice.browser.password)).status, 200);
      const nextC = keplrAccount("p3final/multi/C2");
      const replacement = (await replaceChallenge(world, alice.browser.cookie, nextC.address)).minted as Minted;
      assert.equal((await replaceWith(world, alice.browser.cookie, replacement.operation, alice.browser.wallet.sign(replacement.texts[0].text), nextC.sign(replacement.texts[1].text))).status, 200);
      assert.equal(moneyOf(await viewOf(alice.client, game1.gameId)).you?.payoutWallet, walletA.address);
      assert.equal(moneyOf(await viewOf(alice.client, game2.gameId)).you?.payoutWallet, walletB.address);
      const roster1 = (await world.financial.load(game1.gameId))?.roster;
      const roster2 = (await world.financial.load(game2.gameId))?.roster;
      assert.ok(JSON.stringify(roster1).includes(walletA.address) && !JSON.stringify(roster1).includes(walletB.address));
      assert.ok(JSON.stringify(roster2).includes(walletB.address) && !JSON.stringify(roster2).includes(walletA.address));
      assert.ok(!JSON.stringify(roster1).includes(alice.browser.wallet.address) && !JSON.stringify(roster2).includes(alice.browser.wallet.address), "the Authorization Wallet is no seat's payout wallet");
    } finally {
      await world.close();
    }
  });
});

/* ================================================================== */
/* §20 -- PAYOUT IMMUTABILITY; NO FREE PLAYER MODE                     */
/* ================================================================== */

describe("PHASE 3 FINAL §20: once anted, a seat's deposit/payout wallet is fixed", () => {
  test("a joiner's funded seat refuses another wallet (linked or not, before and after a recovery); the host's CreateGame binds even after its link stopped standing; after Start nothing moves", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const jo = await player(world, "Jo");
      const hostWallet = testWallet("p3final/pay/host");
      const joWallet = testWallet("p3final/pay/jo");
      const table = await fundedTable(world, host, jo, hostWallet, joWallet, "p3final/pay");
      world.advance(PAST_ADMISSION_MS);
      await world.observe();
      /* The joiner, linked and funded with its wallet: another wallet is refused. */
      const swap = await linkWallet(jo, table.gameId, testWallet("p3final/pay/jo2"), testConsentKey("p3final/pay/jo2"), { replace: true });
      assert.deepEqual([swap.status, swap.body?.error], [409, "already-funded"]);
      /* The host signs out its other devices from a phone: the host's link stops standing -- and its CreateGame still binds. */
      const phone = await loginOnFreshBrowser(world.port, host.browser.username, host.browser.password);
      assert.equal((await reauth(world, phone.cookie as string, host.browser.password)).status, 200);
      assert.equal((await apiRequest(world.port, "/gs/api/profile/sign-out-others", { cookie: phone.cookie as string, body: {} })).status, 200);
      const hostPhone = await playerOn(world, phone.cookie as string, host, host.browser.password);
      try {
        const hostSwap = await linkWallet(hostPhone, table.gameId, testWallet("p3final/pay/host2"), testConsentKey("p3final/pay/host2"));
        assert.deepEqual([hostSwap.status, hostSwap.body?.error], [409, "withdraw-or-relink-first"]);
        assert.match(String(hostSwap.body?.reason ?? ""), new RegExp(`already on Juno from ${hostWallet.address}`));
        const hostRelink = await linkWallet(hostPhone, table.gameId, hostWallet, testConsentKey("p3final/pay/host3"));
        assert.equal(hostRelink.status, 200, hostRelink.text);
        await world.observe();
        /* The joiner recovers its account: its link stops standing; another wallet is still refused; the same one relinks. */
        const recovered = await forgotPassword(world, jo.browser.username, jo.browser.wallet);
        assert.equal(recovered.answer.status, 200);
        const joAgain = await playerOn(world, recovered.cookie as string, jo, NEW_PASSWORD);
        try {
          const afterRecovery = await linkWallet(joAgain, table.gameId, testWallet("p3final/pay/jo3"), testConsentKey("p3final/pay/jo3"), { replace: true });
          assert.deepEqual([afterRecovery.status, afterRecovery.body?.error], [409, "withdraw-or-relink-first"]);
          assert.equal((await linkWallet(joAgain, table.gameId, joWallet, testConsentKey("p3final/pay/jo4"))).status, 200);
          await world.observe();
          /* Start: the roster is the depositors, frozen; after it nothing re-binds, whatever wallet or account action. */
          assert.equal((await hostPhone.client.op({ type: "start-game" }, table.gameId)).ok, true);
          await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
          const roster = JSON.stringify((await world.financial.load(table.gameId))?.roster);
          assert.ok(roster.includes(hostWallet.address) && roster.includes(joWallet.address), roster);
          const frozen = await linkWallet(joAgain, table.gameId, testWallet("p3final/pay/jo6"), testConsentKey("p3final/pay/jo5"), { replace: true });
          assert.equal(frozen.status, 409, frozen.text);
          assert.ok(["frozen", "wrong-state"].includes(String(frozen.body?.error)), frozen.text);
          const seats = world.chain.games.get(Number(table.chainGameId))?.seats.map((entry) => entry.wallet);
          assert.deepEqual([...(seats ?? [])].sort(), [hostWallet.address, joWallet.address].sort(), "the escrow pays its depositors");
        } finally {
          await joAgain.client.close();
        }
      } finally {
        await hostPhone.client.close();
      }
    } finally {
      await world.close();
    }
  });
});

describe("PHASE 3 FINAL §20 / §13: no free player mode -- a production room host refuses a no-ante table's create, seat and start", () => {
  test("freeTables:false -- create without a stake refused; an existing no-ante table can be watched but not sat at or started; a staked create works", async () => {
    const records = createMemoryRecordStore();
    /* An internal (development) server made the no-ante table -- the historical fixture case. */
    const before = await startServer({ records });
    let code: string;
    let gameId: string;
    try {
      const alice = await Client.open(before.port, "alice");
      const made = await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "alice" });
      assert.equal(made.ok, true, JSON.stringify(made));
      ({ code, gameId } = made.data as { code: string; gameId: string });
      await alice.close();
    } finally {
      await stopServer(before.server);
    }
    const after = await startServer({ records, freeTables: false });
    try {
      const alice = await Client.open(after.port, "alice");
      const bob = await Client.open(after.port, "bob");
      const carol = await Client.open(after.port, "carol");
      const created = await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "alice" });
      assert.deepEqual([created.ok, created.code], [false, "ante-required"]);
      const joined = await bob.op({ type: "join", code, takeSeat: true });
      assert.deepEqual([joined.ok, joined.code], [false, "ante-required"]);
      const watched = await carol.op({ type: "join", code, takeSeat: false });
      assert.equal(watched.ok, true, `watching stays open: ${JSON.stringify(watched)}`);
      const took = await carol.op({ type: "take-seat" }, gameId);
      assert.deepEqual([took.ok, took.code], [false, "ante-required"]);
      const started = await alice.op({ type: "start-game" }, gameId);
      assert.deepEqual([started.ok, started.code], [false, "ante-required"]);
      await Promise.all([alice.close(), bob.close(), carol.close()]);
    } finally {
      await stopServer(after.server);
    }
    /* With an ante, a production room host creates the table (the money world runs freeTables:false too). */
    const world = await moneyServer({ freeTables: false });
    try {
      const host = await player(world, "Hana");
      const free = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Hana" });
      assert.deepEqual([free.ok, free.code], [false, "ante-required"]);
      const table = await openMoneyTable(host);
      assert.match(table.gameId, /./);
    } finally {
      await world.close();
    }
  });

  test("every production entry point runs the room host with freeTables:false", () => {
    const src = SERVER_SRC;
    const start = fs.readFileSync(path.join(src, "start.ts"), "utf8");
    assert.match(start, /freeTables: config\.mode === "development"/);
    const aws = fs.readFileSync(path.join(src, "aws", "runtime", "awsRuntime.ts"), "utf8");
    assert.match(aws, /freeTables: false/);
  });
});
