// server/src/escrow/escrow4Money.test.ts
//
// ==================================================================
//  ESCROW-4: REAL-MONEY TABLES END TO END -- PRODUCTION IDENTITY, KEPLR-EXACT WALLET PROOFS, THE OFFLINE JUNO
// ==================================================================
//
// Every step a player takes goes through the production surface: a profiled browser's cookie (PHASE 3 FINAL: an account
// with its Authorization Wallet; a second device signs in with the username and password), "Confirm it's you"
// (`/gs/api/profile/reauth`, the password), `/gs/api/money/*`, the room socket's ops and views. The chain is `FakeJunoChain`, which
// verifies the relayer's real transactions and the server's real Join admissions; the players' wallets sign ADR-036
// exactly as Keplr's `signArbitrary` does. What is asserted is what the brief's §26 names: the wallet proof and its
// replays, W-13, the Join admission and R-J1, W-2 in-flight protection, the funding observer, Start and its rollback,
// the security-event push and the relink.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseWalletLinkChallenge } from "../../../frontend/src/gameEngine/escrow/walletLinkChallengeV1";
import { parseSigningKeyChallenge } from "../../../frontend/src/gameEngine/escrow/signingKeyChallengeV1";
import { BUILD, quietConsole, storedLog } from "../rooms/testSupport";
import { apiRequest } from "../rooms/testSupport";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, viewOf, PROD_ORIGIN, STAKE, type MoneyServer, type Player } from "./escrow4Support";
import { currentMoneyContinuation, THIS_DEPLOYMENT } from "./moneyContinuation";
import { HOST_CREATE_WINDOW_MS, MAX_ADMISSIONS_PER_SEAT, START_GRACE_MS } from "./moneyTables";
import { serverPrefixReplay } from "./settlementEvidence";
import { replaySealedPrefix } from "../../../frontend/src/money/settlementCheck";
import { canonicalStateText } from "../../../frontend/src/gameEngine/settlementDigest";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { ADMISSION_CLOCK_SKEW_MS } from "./walletTickets";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";

quietConsole();

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;

async function seatJoiner(world: MoneyServer, name: string, code: string): Promise<{ who: Player; playerId: string }> {
  const who = await player(world, name);
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return { who, playerId: (joined.data as { playerId: string }).playerId };
}

/** A table with a bound host escrow and a seated joiner (not yet funded). */
async function hostOpened(world: MoneyServer) {
  const host = await player(world, "Hana");
  const table = await openMoneyTable(host);
  const hostWallet = testWallet("host");
  const hostKey = testConsentKey("host");
  const linked = await linkWallet(host, table.gameId, hostWallet, hostKey);
  assert.equal(linked.status, 200, linked.text);
  const chainGameId = await hostCreates(world, host, table.gameId, hostWallet, hostKey, linked.body?.ticket as string);
  await world.observe();
  const joiner = await seatJoiner(world, "Jo", table.code);
  return { host, table, hostWallet, hostKey, chainGameId, joiner };
}

describe("ESCROW-4: creating a real-money table", () => {
  test("a stake opens a record_schema 2 table pinned to the server's deployment -- only when enabled, never on mainnet, with an exact player count", async () => {
    const off = await moneyServer({ enabled: false });
    try {
      const host = await player(off, "Off");
      const refused = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Off", stake: STAKE });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "money-games-disabled");
      const config = await host.api("config");
      assert.equal(config.status, 200);
      assert.equal(config.body?.enabled, false);
    } finally {
      await off.close();
    }
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const noCount = await host.client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Hana", stake: STAKE });
      assert.equal(noCount.code, "exact-players-required");
      const tooSmall = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Hana", stake: "10" });
      assert.equal(tooSmall.code, "bad-stake", "below the contract's min_ante");
      const malformed = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Hana", stake: "1.5" });
      assert.equal(malformed.code, "bad-stake", "never turned into zero");
      const table = await openMoneyTable(host);
      const record = world.server.rooms.moneyPort.recordOf(table.gameId);
      assert.equal(record?.record_schema, 2);
      assert.equal(record?.policy.host_undo, "none", "a money table never lets the host undo");
      assert.deepEqual({ ...record?.money }, {
        format: "18COSMOS/MONEY-TABLE/v1",
        backend: "juno-cosmwasm",
        chain_id: world.chain.chainId,
        network_class: "testnet",
        contract_address: world.chain.options.contract,
        code_checksum: world.chain.options.codeChecksum,
        denom: "ujunox",
        symbol: "JUNOX",
        exponent: 6,
        ante_gross: STAKE,
        mode: "live",
      });
      const fin = await world.financial.load(table.gameId);
      assert.equal(fin?.phase, "funding", "the financial record exists with the table");
      assert.equal(fin?.binding?.deployment.contract_address, world.chain.options.contract);
      const view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.escrow.state, "unbound");
      assert.equal(view.start.blocker, "escrow-not-open");
      assert.deepEqual(view.you?.actions, ["link-wallet"]);
      assert.equal(view.you?.link, null);
      assert.equal(JSON.stringify(view).includes("pr_"), false, "no principal id in the view");
      /* Ready does not exist at a money table: the deposit is. */
      const ready = await host.client.op({ type: "set-ready", ready: true }, table.gameId);
      assert.equal(ready.ok, false);
      /* Additive projections (the LIVE-4 amendment): the money table's list entry and "Your tables" line carry a money
         field; a no-money table's carry none (`live2dCutover.test.ts`). */
      host.client.send({ kind: "rooms-watch", on: true });
      const rooms = (await host.client.next((frame) => frame.kind === "rooms", "the list")).rooms as Array<Record<string, unknown>>;
      assert.deepEqual(rooms.find((room) => room.gameId === table.gameId)?.stake, { anteGross: STAKE, symbol: "JUNOX", exponent: 6, networkClass: "testnet", funded: 0, seats: 2, seatFunded: [false] });
      const mine = await host.client.op({ type: "my-tables" });
      const line = (mine.data as { tables: Array<Record<string, unknown>> }).tables.find((entry) => entry.gameId === table.gameId);
      assert.deepEqual(line?.money, { anteGross: STAKE, symbol: "JUNOX", exponent: 6, networkClass: "testnet", status: "link-wallet", actionNeeded: true });
    } finally {
      await world.close();
    }
  });

  test("mainnet is refused whatever the switch says", async () => {
    const world = await moneyServer({ pin: { ...(await import("./escrow3bSupport")).PIN, network_class: "mainnet" } });
    try {
      const host = await player(world, "Main");
      const refused = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Main", stake: STAKE });
      assert.equal(refused.code, "money-games-disabled");
      assert.match(String(refused.reason), /mainnet/);
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4 / LIVE-4 amendment §4: money creation checks the settlement certification first", () => {
  test("rules vNext, certified only below it: the create is refused rules-not-certified and no money identity is written", async () => {
    /* The build would deal a rules engine that settlement does not certify yet (a bump awaiting ESCROW-3A's
       certification): no table may freeze an identity its own deployment cannot settle. */
    const next = RULES_ENGINE_VERSION + 1;
    const world = await moneyServer({
      continuation: {
        current: (codec) => ({ ...currentMoneyContinuation(codec), rules_engine_version: next }),
        deployment: { ...THIS_DEPLOYMENT, supportedRules: [next], certifiedRules: THIS_DEPLOYMENT.certifiedRules.filter((version) => version < next) },
      },
    });
    try {
      const host = await player(world, "Next");
      const refused = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Next", stake: STAKE });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "rules-not-certified");
      assert.deepEqual(await world.financial.list(), [], "no financial record (no money continuation identity) was written");
      assert.deepEqual(world.server.rooms.moneyPort.moneyRecords(), [], "no money GameRecord either");
      const config = await host.api("config");
      assert.equal(config.body?.enabled, false);
      assert.equal(config.body?.why, "rules-not-certified");
      /* The service refuses by itself too, before it writes (the seam LIVE-4 routes through its canonical verdict). */
      const direct = await world.service.createMoneyGame("g_direct");
      assert.equal(direct.ok ? "created" : direct.code, "rules-not-certified");
      assert.equal(await world.financial.load("g_direct"), null);
      assert.deepEqual(await world.financial.list(), []);
    } finally {
      await world.close();
    }
    /* The same world with the real constants creates it, under financial protocol 4 (3 until Phase 3's escrow 2.1). */
    const real = await moneyServer();
    try {
      const host = await player(real, "Now");
      const table = await openMoneyTable(host);
      const fin = await real.financial.load(table.gameId);
      assert.deepEqual(fin?.continuation, { format: "18COSMOS/MONEY-CONTINUATION/v1", rules_engine_version: RULES_ENGINE_VERSION, hosted_protocol: 1, financial_protocol: 4, settlement_codec: "18JUNO/v1" });
    } finally {
      await real.close();
    }
  });
});

describe("ESCROW-4: the wallet proof (ADR-036), its bindings and its replays", () => {
  test("PHASE 4: no password in normal play -- the challenge needs only the signed-in session; it names this site, network, contract, table, seat and wallet", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const wallet = testWallet("host");
      /* PHASE 4 (owner): past the sign-in's 5-minute grant, with no "Confirm it's you", the challenge is still minted --
         what links a wallet is the wallet's own signature over it (the cases below), never the session alone. */
      world.advance(6 * 60_000);
      const unconfirmed = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      assert.equal(unconfirmed.status, 200, unconfirmed.text);
      const bad = await host.api("wallet-challenge", { gameId: table.gameId, wallet: "juno1notanaddress" });
      assert.equal(bad.body?.error, "bad-wallet");
      const extra = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address, playerId: "p-0000000000000000" });
      assert.equal(extra.status, 400, "a body never names a seat");
      const receipt = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address, creationReceipt: "00".repeat(32) });
      assert.equal(receipt.status, 400, "INV-CR: the creation receipt is not an authority here");
      const challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      assert.equal(challenge.status, 200, challenge.text);
      const fields = parseWalletLinkChallenge(challenge.body?.text as string);
      assert.ok(fields !== null);
      assert.equal(fields?.site, PROD_ORIGIN);
      assert.equal(fields?.chainId, world.chain.chainId);
      assert.equal(fields?.contract, world.chain.options.contract);
      assert.equal(fields?.gameId, table.gameId);
      assert.equal(fields?.playerId, table.playerId);
      assert.equal(fields?.wallet, wallet.address);
      assert.equal(fields?.nonce, challenge.body?.nonce);
    } finally {
      await world.close();
    }
  });

  test("a spoofed proof, a proof by another wallet, a replayed or foreign nonce: refused; the right signature links once and a lost answer is answered again", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const wallet = testWallet("host");
      const other = testWallet("other");
      const key = testConsentKey("host");
      await host.confirm();
      /* Signed by another key for the same address: the address derived from the key is not the wallet. */
      let challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      let signed = other.signArbitrary(challenge.body?.text as string, wallet.address);
      let linked = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey });
      assert.equal(linked.status, 403);
      assert.equal(linked.body?.error, "invalid-proof");
      /* The nonce is single use: even the RIGHT signature for it is refused now. */
      signed = wallet.signArbitrary(challenge.body?.text as string);
      linked = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey });
      assert.equal(linked.body?.error, "challenge-used");
      /* A signature over a DIFFERENT text (a forged challenge naming another table) never verifies. */
      challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      signed = wallet.signArbitrary(String(challenge.body?.text).replace(table.gameId, "g_0000000000000000000000000w"));
      linked = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey });
      assert.equal(linked.body?.error, "invalid-proof");
      /* Another browser's (another session's) nonce is nobody's here. */
      const intruder = await player(world, "Ivy");
      await intruder.confirm();
      challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      signed = wallet.signArbitrary(challenge.body?.text as string);
      const foreign = await intruder.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey });
      assert.equal(foreign.status, 403, "not seated");
      /* The right one links; the same (nonce, signature) again -- a lost answer -- gets the same answer. */
      linked = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey });
      assert.equal(linked.status, 200, linked.text);
      assert.equal(linked.body?.mode, "issued");
      assert.equal(linked.body?.wallet, wallet.address);
      const again = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey });
      assert.deepEqual(again.body, linked.body, "idempotent retry");
      const grant = (await world.ledger.snapshot(table.gameId)).grants.find((entry) => entry.player_id === table.playerId);
      assert.equal(grant?.proof?.kind, "adr036");
      assert.equal(grant?.proof?.wallet, wallet.address);
      assert.deepEqual(grant?.consent_keys, [key.pubkey]);
      const view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.you?.link?.wallet, wallet.address);
      assert.equal(view.you?.link?.ticket, linked.body?.ticket, "the viewer's own ticket, so a reload can still deposit (W-6)");
      assert.deepEqual(view.you?.actions, ["open-escrow", "link-wallet"], "open the escrow, or change the wallet before it is opened");
      /* Another seat never sees the ticket. */
      const { who: jo } = await seatJoiner(world, "Jo", table.code);
      const seen = moneyOf(await viewOf(jo.client, table.gameId));
      assert.equal(JSON.stringify(seen).includes(linked.body?.ticket as string), false);
    } finally {
      await world.close();
    }
  });

  test("PHASE 4: a link long after any grant needs only the wallet's own signature (repeated Ante past five minutes); a signed-out session's challenge is dead", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const wallet = testWallet("host");
      world.advance(4 * 60_000);
      const challenge = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      assert.equal(challenge.status, 200, challenge.text);
      world.advance(2 * 60_000); // past the sign-in's 5-minute grant; the challenge (5 minutes from its own issue) is live
      const stranger = testWallet("stranger").signArbitrary(challenge.body?.text as string);
      const spoofed = await host.api("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: stranger.pubKey, signature: stranger.signature, consentKey: testConsentKey("h").pubkey });
      assert.equal(spoofed.body?.error, "invalid-proof", "the session alone never links: only the named wallet's signature");
      const again = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      const signed = wallet.signArbitrary(again.body?.text as string);
      const late = await host.api("wallet-link", { gameId: table.gameId, nonce: again.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: testConsentKey("h").pubkey });
      assert.equal(late.status, 200, late.text);
      assert.equal(late.body?.mode, "issued");
      /* Much later (an hour), the same wallet is proven again with no password: the free re-proof. */
      world.advance(60 * 60_000);
      const third = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      const reproof = wallet.signArbitrary(third.body?.text as string);
      const renewed = await host.api("wallet-link", { gameId: table.gameId, nonce: third.body?.nonce, pubKey: reproof.pubKey, signature: reproof.signature, consentKey: testConsentKey("h").pubkey });
      assert.equal(renewed.body?.mode, "unchanged", renewed.text);
      /* Signed out: the session is gone, so its challenges are dead with it. */
      const fresh = await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address });
      assert.equal((await apiRequest(world.port, "/gs/api/session/revoke", { cookie: host.browser.cookie, body: {} })).status, 204);
      const dead = wallet.signArbitrary(fresh.body?.text as string);
      const afterOut = await host.api("wallet-link", { gameId: table.gameId, nonce: fresh.body?.nonce, pubKey: dead.pubKey, signature: dead.signature, consentKey: testConsentKey("h").pubkey });
      assert.notEqual(afterOut.status, 200);
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: W-13 -- the host's CreateGame binds only when it is exactly the table's", () => {
  test("a copied CreateGame (another creator, the same ticket and terms) is never bound; the host's own is, from the hint or from the chain alone", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const hostWallet = testWallet("host");
      const key = testConsentKey("host");
      const linked = await linkWallet(host, table.gameId, hostWallet, key);
      const ticket = linked.body?.ticket as string;
      /* An outsider front-runs the host with a verbatim copy: same ticket, variants and ante, another wallet. */
      const outsider = testWallet("outsider");
      const copy = await hostCreates(world, host, table.gameId, outsider, testConsentKey("x"), ticket);
      await world.observe();
      let fin = await world.financial.load(table.gameId);
      assert.equal(fin?.binding?.escrow, null, `the copy (chain game ${copy}) is not bound`);
      /* The host's own CreateGame, with NO hint (a lost browser answer): the observer finds it on chain. */
      const own = await hostCreates(world, host, table.gameId, hostWallet, key, ticket, { hint: false });
      await world.observe();
      fin = await world.financial.load(table.gameId);
      assert.equal(fin?.binding?.escrow?.chain_game_id, own, "bound from chain truth alone");
      const view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.escrow.state, "FUNDING");
      assert.equal(view.you?.funding, "funded");
      assert.equal(view.escrow.fundedSeats, 1);
      assert.equal(view.terms.anteNet, "990000", "the contract's 1% fee on the deposit");
      assert.equal(view.terms.pot, "1980000");
      /* The host is the escrow's creator: it leaves by Cancel (every deposit back), never by Withdraw (review R-H1). */
      assert.ok(view.you?.actions.includes("cancel-escrow"));
      assert.ok(!view.you?.actions.includes("withdraw"), "a creator's withdrawal would leave an escrow its table can never fill");
      /* The service refuses the copy by name when asked directly. */
      const direct = await world.service.bindHostChainGame(table.gameId, copy, world.server.rooms.moneyPort.recordOf(table.gameId)!.variants, { creator: hostWallet.address, ticket, anteGross: STAKE, maxPlayers: 2, mode: 0 });
      assert.equal(direct.ok, false);
    } finally {
      await world.close();
    }
  });

  test("a CreateGame under an EARLIER ticket of the host (a duplicate escrow) is not bound; Your deposits lists it with Cancel", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const hostWallet = testWallet("host");
      const walletB = testWallet("host-b");
      const key = testConsentKey("host");
      const first = await linkWallet(host, table.gameId, hostWallet, key);
      /* The host replaces the link (explicitly) with another wallet, then ALSO signs a CreateGame under the old one. */
      world.advance(HOST_CREATE_WINDOW_MS + 1_000);
      const replaced = await linkWallet(host, table.gameId, walletB, key, { replace: true });
      assert.equal(replaced.status, 200, replaced.text);
      const stale = await hostCreates(world, host, table.gameId, hostWallet, key, first.body?.ticket as string, { hint: false });
      await world.observe();
      assert.equal((await world.financial.load(table.gameId))?.binding?.escrow, null, "a stale ticket's escrow never binds");
      const deposits = await host.api("deposits");
      assert.equal(deposits.status, 200, deposits.text);
      const entries = deposits.body?.deposits as Array<Record<string, unknown>>;
      const dup = entries.find((entry) => entry.chainGameId === stale);
      assert.ok(dup !== undefined, "the duplicate escrow is reachable");
      assert.equal(dup?.relation, "duplicate");
      assert.ok((dup?.actions as string[]).includes("cancel-escrow"));
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: the Join admission and R-J1 -- the seat is locked while an admission can land", () => {
  test("link -> admission -> Join on chain -> funded; the host can't kick or the joiner release while the admission is live, nor once funded", async () => {
    const world = await moneyServer();
    try {
      const { host, table, joiner } = await hostOpened(world);
      const jWallet = testWallet("jo");
      const jKey = testConsentKey("jo");
      /* The host needs no admission. */
      assert.equal((await host.api("join-admission", { gameId: table.gameId })).body?.error, "host-creates");
      /* Without a link, no admission. */
      assert.equal((await joiner.who.api("join-admission", { gameId: table.gameId })).body?.error, "link-first");
      const linked = await linkWallet(joiner.who, table.gameId, jWallet, jKey);
      assert.equal(linked.status, 200, linked.text);
      const ticket = linked.body?.ticket as string;
      const asked = await joiner.who.api("join-admission", { gameId: table.gameId });
      assert.equal(asked.status, 200, asked.text);
      const admission = asked.body?.admission as Record<string, string>;
      assert.equal(admission.wallet, jWallet.address);
      assert.equal(admission.join_ticket, ticket);
      /* R-J1: while the admission can land, the seat does not move -- not by a kick, not by the seat itself. */
      const kick = await host.client.op({ type: "kick", playerId: joiner.playerId }, table.gameId);
      assert.equal(kick.ok, false);
      assert.equal(kick.code, "admission-outstanding");
      /* W2-K (OD-9(a)): the player reads how long, never a clock in a zone that isn't theirs. */
      assert.match(String(kick.reason), /for about (a minute|\d+ minutes|\d+ hours) more/);
      assert.doesNotMatch(String(kick.reason), /\d\d:\d\d|UTC/);
      const release = await joiner.who.client.op({ type: "release-seat" }, table.gameId);
      assert.equal(release.code, "admission-outstanding");
      /* Nor can the seat's link be replaced (a second wallet admitted for one seat). */
      const other = await linkWallet(joiner.who, table.gameId, testWallet("jo-2"), jKey, { replace: true });
      assert.equal(other.body?.error, "admission-outstanding");
      /* Leave is an unsubscribe: the seat stays. */
      const left = await joiner.who.client.op({ type: "leave" }, table.gameId);
      assert.equal(left.ok, true);
      assert.ok(world.server.rooms.moneyPort.recordOf(table.gameId)?.seats.some((seat) => seat.player_id === joiner.playerId), "the seat is still there");
      /* The Join lands (no hint: the browser's answer was lost) -- the observer sees it. */
      world.chain.join(admission.chain_game_id, { wallet: jWallet.address, consent_pubkey: jKey.pubkey, join_ticket: ticket }, { expires_at: admission.expires_at, signature: admission.signature });
      await world.observe();
      const view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.escrow.state, "FUNDED");
      assert.equal(view.seats.find((seat) => seat.playerId === joiner.playerId)?.funding, "funded");
      assert.equal(view.start.state, "ready");
      assert.equal(view.start.canStart, true, "the host may start at once");
      /* Past the admission (and its margin): the seat is still locked -- it is FUNDED on chain now (W-2). */
      world.advance((Number(admission.expires_at) * 1000 - world.clock.now) + ADMISSION_CLOCK_SKEW_MS + 1_000);
      const late = await host.client.op({ type: "kick", playerId: joiner.playerId }, table.gameId);
      assert.equal(late.code, "withdraw-first");
    } finally {
      await world.close();
    }
  });

  test("an admission that expires unused: the seat becomes mutable again (the chain shows no deposit)", async () => {
    const world = await moneyServer();
    try {
      const { host, table, joiner } = await hostOpened(world);
      const linked = await linkWallet(joiner.who, table.gameId, testWallet("jo"), testConsentKey("jo"));
      const asked = await joiner.who.api("join-admission", { gameId: table.gameId });
      const admission = asked.body?.admission as Record<string, string>;
      assert.equal((await host.client.op({ type: "kick", playerId: joiner.playerId }, table.gameId)).code, "admission-outstanding");
      world.advance((Number(admission.expires_at) * 1000 - world.clock.now) + ADMISSION_CLOCK_SKEW_MS + 1_000);
      const kicked = await host.client.op({ type: "kick", playerId: joiner.playerId }, table.gameId);
      assert.equal(kicked.ok, true, JSON.stringify(kicked));
      void linked;
    } finally {
      await world.close();
    }
  });

  test("a copied or expired admission seats nobody; a deposit hint makes the seat 'sent' but never 'funded'", async () => {
    const world = await moneyServer();
    try {
      const { host, table, joiner } = await hostOpened(world);
      const jWallet = testWallet("jo");
      const jKey = testConsentKey("jo");
      const linked = await linkWallet(joiner.who, table.gameId, jWallet, jKey);
      const ticket = linked.body?.ticket as string;
      const asked = await joiner.who.api("join-admission", { gameId: table.gameId });
      const admission = asked.body?.admission as Record<string, string>;
      /* Copied by an outsider: the admission names the joiner's wallet (the contract's digest uses the sender). */
      const thief = testWallet("thief");
      const stolen = world.chain.join(admission.chain_game_id, { wallet: thief.address, consent_pubkey: testConsentKey("t").pubkey, join_ticket: ticket }, { expires_at: admission.expires_at, signature: admission.signature });
      assert.equal(stolen.ok, false);
      /* A hint alone is 'sent', never 'funded'. */
      const hinted = await joiner.who.api("deposit-sent", { gameId: table.gameId, kind: "join", txHash: "CD".repeat(32) });
      assert.equal(hinted.status, 202);
      await world.money.idle();
      let view = moneyOf(await viewOf(joiner.who.client, table.gameId));
      assert.equal(view.you?.funding, "sent");
      assert.equal(view.escrow.state, "FUNDING");
      /* The hinted seat is protected while the hint is unresolved (W-2). */
      assert.equal((await host.client.op({ type: "kick", playerId: joiner.playerId }, table.gameId)).code, "admission-outstanding");
      /* Expired: the chain refuses it. */
      world.advance((Number(admission.expires_at) * 1000 - world.clock.now) + 1_000);
      const late = world.chain.join(admission.chain_game_id, { wallet: jWallet.address, consent_pubkey: jKey.pubkey, join_ticket: ticket }, { expires_at: admission.expires_at, signature: admission.signature });
      assert.equal(late.ok, false);
      await world.observe();
      view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.escrow.state, "FUNDING", "nothing funded it");
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: the host of a real-money table is the chain creator (W-3)", () => {
  test("no host transfer before the deal; cancel-room is refused while the escrow is open, and mirrors the chain's CANCELLED", async () => {
    const world = await moneyServer();
    try {
      const { host, table, joiner, hostWallet, chainGameId } = await hostOpened(world);
      const transfer = await host.client.op({ type: "transfer-host", toPlayerId: joiner.playerId }, table.gameId);
      assert.equal(transfer.code, "money-host-fixed");
      const release = await host.client.op({ type: "release-seat" }, table.gameId);
      assert.equal(release.code, "host-cancel-on-juno");
      const cancel = await host.client.op({ type: "cancel-room" }, table.gameId);
      assert.equal(cancel.code, "cancel-on-juno");
      /* The creator cancels on chain: the table mirrors it, the financial record closes. */
      assert.ok(world.chain.cancel(chainGameId, hostWallet.address).ok);
      await world.observe();
      await world.observe();
      assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.status, "cancelled");
      assert.equal((await world.financial.load(table.gameId))?.phase, "cancelled");
    } finally {
      await world.close();
    }
  });

  test("an unbound table whose host linked a wallet moments ago cannot be cancelled until Juno answers (the CreateGame may be in flight)", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      await linkWallet(host, table.gameId, testWallet("host"), testConsentKey("host"));
      assert.equal((await host.client.op({ type: "cancel-room" }, table.gameId)).code, "deposit-in-flight");
      world.advance(HOST_CREATE_WINDOW_MS + 1_000);
      const cancelled = await host.client.op({ type: "cancel-room" }, table.gameId);
      assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
      await world.observe();
      assert.equal((await world.financial.load(table.gameId))?.phase, "cancelled", "an unbound table's record closes with it");
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: Start -- the reversible freeze, the relayer's Start, the deal after the chain's confirmation", () => {
  async function funded(world: MoneyServer) {
    const opened = await hostOpened(world);
    const jWallet = testWallet("jo");
    const jKey = testConsentKey("jo");
    const linked = await linkWallet(opened.joiner.who, opened.table.gameId, jWallet, jKey);
    await joinerFunds(world, opened.joiner.who, opened.table.gameId, jWallet, jKey, linked.body?.ticket as string);
    await world.observe();
    return { ...opened, jWallet, jKey };
  }

  test("fully funded -> Start (starting) -> the chain starts it (the broadcast answer lost) -> the server deals", async () => {
    const world = await moneyServer();
    try {
      const { host, table, joiner } = await funded(world);
      /* The joiner cannot start before the host's grace. */
      const early = await joiner.who.client.op({ type: "start-game" }, table.gameId);
      assert.equal(early.ok, false);
      assert.equal(early.code, "host-grace");
      assert.match(String(early.reason), /any funded player can in about (a minute|\d+ minutes)\.$/);
      assert.doesNotMatch(String(early.reason), /\d\d:\d\d|UTC/);
      const started = await host.client.op({ type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.deepEqual(started.data, { starting: true });
      let view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.start.state, "starting");
      /* Seats locked: nothing moves (3B's frozen roster). */
      assert.equal((await host.client.op({ type: "kick", playerId: joiner.playerId }, table.gameId)).ok, false);
      world.chain.loseNextBroadcastAnswer = 1;
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
      view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.start.state, "started");
      assert.equal(world.chain.games.get(1)?.state, "in_progress");
    } finally {
      await world.close();
    }
  });

  test("any funded player may start once the host's grace has passed", async () => {
    const world = await moneyServer({ fundingPeriodSecs: 7200 });
    try {
      const { table, joiner } = await funded(world);
      world.advance(START_GRACE_MS + 1_000);
      await world.observe();
      const view = moneyOf(await viewOf(joiner.who.client, table.gameId));
      assert.equal(view.start.canStart, true);
      const started = await joiner.who.client.op({ type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
    } finally {
      await world.close();
    }
  });

  test("a Start the chain proves can never land (a seat withdrew) rolls back to the funded pre-Start state", async () => {
    const world = await moneyServer();
    try {
      const { host, table, jWallet, chainGameId } = await funded(world);
      const started = await host.client.op({ type: "start-game" }, table.gameId);
      assert.equal(started.ok, true);
      /* Before the relayer sends it, the joiner's wallet withdraws (pre-Start, the contract allows it). */
      assert.ok(world.chain.withdraw(chainGameId, jWallet.address).ok);
      await world.drive(async () => {
        const fin = await world.financial.load(table.gameId);
        return fin !== null && fin.roster === null && fin.roster_epoch === 1;
      });
      const view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.start.state, "rolled-back");
      assert.equal(view.start.blocker, "need-funding");
      assert.ok(view.you?.actions.includes("cancel-escrow"), "the host's exit reappears (Cancel on Juno)");
      assert.ok(view.you?.actions.includes("start") === false, "not while a seat is unfunded");
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: security events push, and a deposit is relinked (never reassigned)", () => {
  test("sign out other devices ends a pre-freeze link: the view says so at once; a fresh proof relinks the same deposit free", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      const jWallet = testWallet("jo");
      const jKey = testConsentKey("jo");
      const linked = await linkWallet(joiner.who, table.gameId, jWallet, jKey);
      await joinerFunds(world, joiner.who, table.gameId, jWallet, jKey, linked.body?.ticket as string);
      await world.observe();
      assert.equal(moneyOf(await viewOf(joiner.who.client, table.gameId)).you?.funding, "funded");
      /* The same account on a phone signs out every other device (including the one that linked). PHASE 3 FINAL: the
         phone signs in with the username and password (the recovery-key route is retired: 410). */
      const { loginOnFreshBrowser } = await import("../rooms/testSupport");
      const retired = await apiRequest(world.port, "/gs/api/profile/recover", { cookie: (await apiRequest(world.port, "/gs/api/session", {})).headers["set-cookie"]![0].split(";")[0], body: {} });
      assert.deepEqual([retired.status, retired.body?.error], [410, "retired"]);
      const signedIn = await loginOnFreshBrowser(world.port, joiner.who.browser.username, joiner.who.browser.password);
      assert.equal(signedIn.answer.status, 200, signedIn.answer.text);
      const phone = signedIn.cookie as string;
      assert.equal((await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: phone, body: { password: joiner.who.browser.password } })).status, 200);
      assert.equal((await apiRequest(world.port, "/gs/api/profile/sign-out-others", { cookie: phone, body: {} })).status, 200);
      await world.money.idle();
      await world.observe();
      const phoneClient = await (await import("../rooms/testSupport")).Client.openWithCookie(world.port, phone, "phone");
      const view = moneyOf(await viewOf(phoneClient, table.gameId));
      assert.equal(view.you?.funding, "unlinked", "the deposit is on chain, its link no longer stands");
      assert.deepEqual(view.you?.unlinkedDeposit, { wallet: jWallet.address });
      assert.ok(view.you?.actions.includes("relink"));
      assert.equal(view.start.blocker, "unlinked-deposit");
      /* The phone relinks the SAME wallet: a fresh proof, a new epoch re-adopting the deposit's ticket. */
      const phoneApi = (route: string, body: object) => apiRequest(world.port, `/gs/api/money/${route}`, { cookie: phone, body });
      const challenge = await phoneApi("wallet-challenge", { gameId: table.gameId, wallet: jWallet.address });
      assert.equal(challenge.status, 200, challenge.text);
      const signed = jWallet.signArbitrary(challenge.body?.text as string);
      const relinked = await phoneApi("wallet-link", { gameId: table.gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: testConsentKey("phone").pubkey });
      assert.equal(relinked.status, 200, relinked.text);
      assert.equal(relinked.body?.mode, "relinked");
      assert.equal(relinked.body?.ticket, linked.body?.ticket, "the deposit's own ticket, re-adopted");
      await world.observe();
      const after = moneyOf(await viewOf(phoneClient, table.gameId));
      assert.equal(after.you?.funding, "funded");
      assert.equal(after.start.state, "ready");
      await phoneClient.close();
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: consent keys and the CONSENT / ANNUL relay (the signature is the authority)", () => {
  /** A started, dealt table whose escrow holds a stored settlement THIS server signed (its settle intent at that seq):
   *  the state a finished game reaches, set directly (a whole game to GameEnd is not a fixture). */
  async function settleable(world: MoneyServer) {
    const opened = await hostOpened(world);
    const jWallet = testWallet("jo");
    const jKey = testConsentKey("jo");
    const linked = await linkWallet(opened.joiner.who, opened.table.gameId, jWallet, jKey);
    await joinerFunds(world, opened.joiner.who, opened.table.gameId, jWallet, jKey, linked.body?.ticket as string);
    await world.observe();
    assert.equal((await opened.host.client.op({ type: "start-game" }, opened.table.gameId)).ok, true);
    await world.drive(async () => world.server.rooms.moneyPort.recordOf(opened.table.gameId)?.status === "active");
    const fin = await world.financial.load(opened.table.gameId);
    const binding = fin!.binding!.escrow!;
    const game = world.chain.games.get(Number(binding.chain_game_id))!;
    const digest = "7e".repeat(32);
    const seq = "21";
    game.state = "settleable";
    game.settlement = {
      source: "terminal_payload",
      payload: { seq, kind: 1, reason: 1, log_len: "10", log_hash: "11".repeat(32), appraisal_log_len: "10", appraisal_state_hash: "22".repeat(32), state_schema_version: 1, settlement_weights: ["3", "1"], signer_key_id: 1, issued_at: "0", payload_digest: digest },
      accepted_at: world.chain.time,
      window_end: world.chain.time + 3600,
    };
    const { newChainIntent } = await import("./chainIntents");
    const { escrowInstanceKey } = await import("../../../frontend/src/gameEngine/escrow/escrowModel");
    const own = newChainIntent({ game_id: opened.table.gameId, instance: escrowInstanceKey(binding), key: { op: "settle", seq }, subject: { kind: "digest", digests: [] }, op: { kind: "settle", chain_game_id: binding.chain_game_id, seq, log_len: 10, settle_digest: digest, signer_key_id: 1 }, msg_json: "{}", now: world.clock.now });
    await world.intents.create({ ...own, status: "confirmed", confirmation: { how: "chain-state", tx_hash: null, height: null, detail: "test", at: world.clock.now } });
    await world.observe();
    return { ...opened, jWallet, jKey, domain: game.domain as string, seq, digest, chainGameId: binding.chain_game_id };
  }

  test("a valid consent is relayed WITHOUT Confirm it's you; a wrong key is refused; a repeat is idempotent; every seat's consent pays out", async () => {
    const world = await moneyServer();
    try {
      const { host, hostKey, joiner, jKey, table, domain, seq, digest, chainGameId } = await settleable(world);
      const view = moneyOf(await viewOf(joiner.who.client, table.gameId));
      assert.equal(view.settlement?.status, "recorded");
      assert.ok(view.you?.actions.includes("approve-payout"));
      /* S-H1: the frozen roster, for a seated device to lay its own count of the standings out in chain order. */
      const details = await joiner.who.api("escrow-details", { gameId: table.gameId });
      assert.deepEqual(details.body?.roster, [
        { playerId: table.playerId, chainSeatIndex: 0 },
        { playerId: joiner.playerId, chainSeatIndex: 1 },
      ]);
      /* Another key's signature: refused. */
      const wrong = await joiner.who.api("consent", { gameId: table.gameId, signature: testConsentKey("someone").consent(domain, seq, digest) });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body?.error, "wrong-key");
      /* Over another settlement: refused. */
      const other = await joiner.who.api("consent", { gameId: table.gameId, signature: jKey.consent(domain, "23", digest) });
      assert.equal(other.body?.error, "wrong-key");
      /* The seat's own key, no re-authentication anywhere in this session. */
      const ok = await joiner.who.api("consent", { gameId: table.gameId, signature: jKey.consent(domain, seq, digest) });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.body?.status, "queued");
      const again = await joiner.who.api("consent", { gameId: table.gameId, signature: jKey.consent(domain, seq, digest) });
      assert.equal(again.body?.status, "relayed", "the same (seq, seat, key) is the same work");
      await world.drive(async () => (world.chain.games.get(Number(chainGameId))!.consent_bitmap & 2) !== 0);
      /* The host consents too: the escrow pays out at once (consent_completed). */
      const hostConsent = await host.api("consent", { gameId: table.gameId, signature: hostKey.consent(domain, seq, digest) });
      assert.equal(hostConsent.status, 200, hostConsent.text);
      await world.drive(async () => world.chain.games.get(Number(chainGameId))!.state === "settled");
      assert.equal(world.chain.games.get(Number(chainGameId))!.outcome?.route, "consent_completed");
      await world.drive(async () => (await world.financial.load(table.gameId))?.phase === "closed");
      const closed = moneyOf(await viewOf(joiner.who.client, table.gameId));
      assert.equal(closed.settlement?.status, "paid");
      assert.deepEqual(closed.settlement?.amounts, ["1485000", "495000"]);
    } finally {
      await world.close();
    }
  });

  test("PHASE 4: moving the signing key needs the SEAT'S WALLET's signature (no password); after SetConsentKey the old key's consent is refused and the new one relays", async () => {
    const world = await moneyServer();
    try {
      const { joiner, jWallet, table, domain, seq, digest, chainGameId } = await settleable(world);
      const moved = testConsentKey("jo-phone");
      world.advance(6 * 60_000); // no grant: the session alone
      const unsigned = await joiner.who.api("consent-key", { gameId: table.gameId, pubkey: moved.pubkey });
      assert.equal(unsigned.status, 403);
      assert.equal(unsigned.body?.error, "signature-required", "the session alone never registers a key");
      const challenge = await joiner.who.api("signing-key-challenge", { gameId: table.gameId, pubkey: moved.pubkey });
      assert.equal(challenge.status, 200, challenge.text);
      const fields = parseSigningKeyChallenge(challenge.body?.text as string);
      assert.deepEqual([fields?.wallet, fields?.signingKey, fields?.gameId, fields?.site], [jWallet.address, moved.pubkey, table.gameId, PROD_ORIGIN]);
      assert.equal(parseWalletLinkChallenge(challenge.body?.text as string), null, "never a wallet-link text");
      const other = testWallet("not-the-seat").signArbitrary(challenge.body?.text as string);
      const wrong = await joiner.who.api("consent-key", { gameId: table.gameId, pubkey: moved.pubkey, nonce: challenge.body?.nonce, pubKey: other.pubKey, signature: other.signature });
      assert.equal(wrong.body?.error, "invalid-proof", "another wallet's signature registers nothing");
      const retry = await joiner.who.api("signing-key-challenge", { gameId: table.gameId, pubkey: moved.pubkey });
      const signed = jWallet.signArbitrary(retry.body?.text as string);
      const asLink = await joiner.who.api("wallet-link", { gameId: table.gameId, nonce: retry.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: moved.pubkey });
      assert.notEqual(asLink.status, 200, "a signing-key nonce is not a wallet link");
      const ok = await joiner.who.api("consent-key", { gameId: table.gameId, pubkey: moved.pubkey, nonce: retry.body?.nonce, pubKey: signed.pubKey, signature: signed.signature });
      assert.equal(ok.status, 200, ok.text);
      const replay = await joiner.who.api("consent-key", { gameId: table.gameId, pubkey: moved.pubkey, nonce: retry.body?.nonce, pubKey: other.pubKey, signature: other.signature });
      assert.equal(replay.body?.error, "challenge-used", "single use");
      /* The wallet moves it on chain (the contract's own authorization). */
      assert.ok(world.chain.setConsentKey(chainGameId, jWallet.address, moved.pubkey).ok);
      await world.observe();
      const old = await joiner.who.api("consent", { gameId: table.gameId, signature: testConsentKey("jo").consent(domain, seq, digest) });
      assert.equal(old.body?.error, "wrong-key");
      const fresh = await joiner.who.api("consent", { gameId: table.gameId, signature: moved.consent(domain, seq, digest) });
      assert.equal(fresh.status, 200, fresh.text);
      /* A key set on chain that the seat never registered through Confirm it's you is not relayed. */
      const rogue = testConsentKey("rogue");
      assert.ok(world.chain.setConsentKey(chainGameId, jWallet.address, rogue.pubkey).ok);
      const refused = await joiner.who.api("consent", { gameId: table.gameId, signature: rogue.consent(domain, seq, digest) });
      assert.equal(refused.body?.error, "key-not-registered");
    } finally {
      await world.close();
    }
  });

  test("ANNUL: each seat's signature is collected; with every seat's, one annul is relayed and the escrow refunds", async () => {
    const world = await moneyServer();
    try {
      const { host, hostKey, joiner, jKey, table, domain, chainGameId } = await settleable(world);
      /* What an ANNUL binds: the escrow's TRUSTED sequence (the client reads it from the view). */
      const trustedSeq = moneyOf(await viewOf(joiner.who.client, table.gameId)).settlement?.trustedSeq as string;
      assert.match(trustedSeq, /^[0-9]+$/);
      const first = await joiner.who.api("annul", { gameId: table.gameId, signature: jKey.annul(domain, trustedSeq) });
      assert.equal(first.status, 200, first.text);
      assert.deepEqual(first.body?.collected, [1]);
      assert.equal(first.body?.submitted, false);
      const wrong = await host.api("annul", { gameId: table.gameId, signature: hostKey.annul(domain, String(BigInt(trustedSeq) + BigInt(2))) });
      assert.equal(wrong.body?.error, "wrong-key");
      const second = await host.api("annul", { gameId: table.gameId, signature: hostKey.annul(domain, trustedSeq) });
      assert.equal(second.body?.submitted, true);
      await world.drive(async () => world.chain.games.get(Number(chainGameId))!.state === "annulled");
      await world.drive(async () => (await world.financial.load(table.gameId))?.phase === "closed");
      assert.equal(moneyOf(await viewOf(host.client, table.gameId)).settlement?.status, "annulled");
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: reloads -- every stage is rebuilt from the server's truth on a fresh socket", () => {
  test("not linked -> linked -> sent -> funded -> starting -> started, each seen by a NEW connection of the same seat", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner, host } = await hostOpened(world);
      const reload = async () => {
        const { Client } = await import("../rooms/testSupport");
        const fresh = await Client.openWithCookie(world.port, joiner.who.browser.cookie, "reload");
        const view = moneyOf(await viewOf(fresh, table.gameId));
        await fresh.close();
        return view;
      };
      let view = await reload();
      assert.equal(view.you?.funding, "none");
      assert.deepEqual(view.you?.actions, ["link-wallet"]);
      const jWallet = testWallet("jo");
      const jKey = testConsentKey("jo");
      const linked = await linkWallet(joiner.who, table.gameId, jWallet, jKey);
      view = await reload();
      assert.equal(view.you?.funding, "linked");
      assert.equal(view.you?.link?.ticket, linked.body?.ticket);
      assert.deepEqual(view.you?.actions.filter((action) => action === "deposit"), ["deposit"]);
      const asked = await joiner.who.api("join-admission", { gameId: table.gameId });
      const admission = asked.body?.admission as Record<string, string>;
      await joiner.who.api("deposit-sent", { gameId: table.gameId, kind: "join", txHash: "EF".repeat(32) });
      await world.money.idle();
      view = await reload();
      assert.equal(view.you?.funding, "sent", "the hint survives a reload (never 'funded' from it)");
      assert.equal(typeof view.you?.admissionUntil, "number");
      world.chain.join(admission.chain_game_id, { wallet: jWallet.address, consent_pubkey: jKey.pubkey, join_ticket: linked.body?.ticket as string }, { expires_at: admission.expires_at, signature: admission.signature });
      await world.observe();
      view = await reload();
      assert.equal(view.you?.funding, "funded");
      assert.equal(view.you?.payoutWallet, jWallet.address);
      assert.equal(view.you?.chainConsentKey, jKey.pubkey, "the browser compares this with the key it holds");
      assert.equal((await host.client.op({ type: "start-game" }, table.gameId)).ok, true);
      view = await reload();
      assert.equal(view.start.state, "starting");
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
      view = await reload();
      assert.equal(view.start.state, "started");
      assert.ok(view.you?.actions.includes("move-signing-key"));
    } finally {
      await world.close();
    }
  });

  test("an old security family proves nothing: after 'sign out other devices' the phone gets no admission until it relinks", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      await linkWallet(joiner.who, table.gameId, testWallet("jo"), testConsentKey("jo"));
      const { loginOnFreshBrowser } = await import("../rooms/testSupport");
      /* PHASE 3 FINAL: the phone signs in with the username and password (its own session family). */
      const signedIn = await loginOnFreshBrowser(world.port, joiner.who.browser.username, joiner.who.browser.password);
      assert.equal(signedIn.answer.status, 200, signedIn.answer.text);
      const phone = signedIn.cookie as string;
      assert.equal((await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: phone, body: { password: joiner.who.browser.password } })).status, 200);
      assert.equal((await apiRequest(world.port, "/gs/api/profile/sign-out-others", { cookie: phone, body: {} })).status, 200);
      const refused = await apiRequest(world.port, "/gs/api/money/join-admission", { cookie: phone, body: { gameId: table.gameId } });
      assert.equal(refused.status, 409);
      assert.equal(refused.body?.error, "link-first", "the link made under the signed-out family no longer stands");
      /* The signed-out device's own cookie is dead everywhere. */
      assert.equal((await joiner.who.api("join-admission", { gameId: table.gameId })).status, 401);
    } finally {
      await world.close();
    }
  });
});

describe("ESCROW-4: source pins", () => {
  test("the money layer binds only through W-13, and never names the creation rescue (INV-CR)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    let repo = __dirname;
    while (!fs.existsSync(path.join(repo, "contracts", "escrow")) || !fs.existsSync(path.join(repo, "server", "src", "escrow"))) {
      const up = path.dirname(repo);
      if (up === repo) throw new Error("the repository root was not found");
      repo = up;
    }
    const root = path.join(repo, "server", "src");
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes("Support") ? [path.join(dir, entry.name)] : []));
    const sources = walk(root);
    assert.ok(sources.length > 50, `found the sources (${sources.length})`);
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      if (!file.endsWith(`${path.sep}escrowService.ts`)) assert.equal(/\bbindChainGame\s*\(/.test(text), false, `${file} binds a chain game without W-13`);
    }
    for (const name of ["moneyTables.ts", "moneyHttpApi.ts", "walletProof.ts"]) {
      const text = fs.readFileSync(path.join(root, "escrow", name), "utf8");
      assert.equal(/creationRescue|creationReceipt|rotateRecoveryKey/.test(text), false, `${name} never touches the creation rescue`);
    }
  });
});

describe("ESCROW-4 review fixes (security S-*, reachability R-*)", () => {
  /** A second session of the joiner's account (a phone): it signs in (PHASE 3 FINAL: username + password), confirms,
   *  and signs out every other device. */
  async function phoneSignsOutOthers(world: MoneyServer, who: Player) {
    const { apiRequest, Client, loginOnFreshBrowser } = await import("../rooms/testSupport");
    const signedIn = await loginOnFreshBrowser(world.port, who.browser.username, who.browser.password);
    assert.equal(signedIn.answer.status, 200, signedIn.answer.text);
    const phone = signedIn.cookie as string;
    const confirm = async () => assert.equal((await apiRequest(world.port, "/gs/api/profile/reauth", { cookie: phone, body: { password: who.browser.password } })).status, 200);
    await confirm();
    assert.equal((await apiRequest(world.port, "/gs/api/profile/sign-out-others", { cookie: phone, body: {} })).status, 200);
    await world.money.idle();
    await world.observe();
    const api = (route: string, body: object) => apiRequest(world.port, `/gs/api/money/${route}`, { cookie: phone, body });
    const link = async (gameId: string, wallet: ReturnType<typeof testWallet>, key: ReturnType<typeof testConsentKey>, replace = false) => {
      await confirm();
      const challenge = await api("wallet-challenge", { gameId, wallet: wallet.address });
      assert.equal(challenge.status, 200, challenge.text);
      const signed = wallet.signArbitrary(challenge.body?.text as string);
      return api("wallet-link", { gameId, nonce: challenge.body?.nonce, pubKey: signed.pubKey, signature: signed.signature, consentKey: key.pubkey, ...(replace ? { replace: true } : {}) });
    };
    const client = await Client.openWithCookie(world.port, phone, "phone");
    return { api, link, client };
  }

  test("S-M1: a relink does not reopen the seat to a second wallet while the first wallet's admission can still land", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner, chainGameId } = await hostOpened(world);
      const w1 = testWallet("jo");
      const k1 = testConsentKey("jo");
      const linked = await linkWallet(joiner.who, table.gameId, w1, k1);
      const { admission } = await joinerFunds(world, joiner.who, table.gameId, w1, k1, linked.body?.ticket as string);
      await world.observe();
      /* A security event ends the link; the phone relinks W1 (a newer grant re-adopting the ticket). */
      const phone = await phoneSignsOutOthers(world, joiner.who);
      const relinked = await phone.link(table.gameId, w1, testConsentKey("phone"));
      assert.equal(relinked.body?.mode, "relinked", relinked.text);
      const grants = (await world.ledger.snapshot(table.gameId)).grants.filter((grant) => grant.player_id === joiner.playerId);
      assert.equal(grants.find((grant) => grant.epoch === 2)?.admitted_until_secs, Number(admission.expires_at), "the relink carries the admission forward");
      /* W1 withdraws; W2 asks to replace it while A1 can still seat W1 again: refused (R-J1 over every grant). */
      assert.ok(world.chain.withdraw(chainGameId, w1.address).ok);
      await world.observe();
      const w2 = testWallet("jo-2");
      const replaced = await phone.link(table.gameId, w2, testConsentKey("phone-2"), true);
      assert.equal(replaced.status, 409, replaced.text);
      assert.equal(replaced.body?.error, "admission-outstanding");
      /* Once A1 can no longer land, the replacement is the player's to make. */
      world.advance((Number(admission.expires_at) * 1000 - world.clock.now) + ADMISSION_CLOCK_SKEW_MS + 1_000);
      const later = await phone.link(table.gameId, w2, testConsentKey("phone-2"), true);
      assert.equal(later.status, 200, later.text);
      await phone.client.close();
    } finally {
      await world.close();
    }
  });

  test("S-M2: a hint is only the sending seat's own kind and never locks a joiner's seat; admissions per seat are budgeted", async () => {
    const world = await moneyServer();
    try {
      const { host, table, joiner } = await hostOpened(world);
      assert.equal((await joiner.who.api("deposit-sent", { gameId: table.gameId, kind: "create", txHash: "C1".repeat(32) })).status, 400, "only the host opens the escrow");
      assert.equal((await host.api("deposit-sent", { gameId: table.gameId, kind: "join", txHash: "C2".repeat(32) })).status, 400, "the host doesn't join");
      const w1 = testWallet("jo");
      await linkWallet(joiner.who, table.gameId, w1, testConsentKey("jo"));
      const asked = await joiner.who.api("join-admission", { gameId: table.gameId });
      const admission = asked.body?.admission as Record<string, string>;
      /* A hint just before the admission lapses (the browser's word, a hash the chain never sees)... */
      world.advance((Number(admission.expires_at) * 1000 - world.clock.now) - 30_000);
      assert.equal((await joiner.who.api("deposit-sent", { gameId: table.gameId, kind: "join", txHash: "C3".repeat(32) })).status, 202);
      await world.money.idle();
      /* ...locks nothing once no Join can land (the admission lapsed, with the clock margin). */
      world.advance(30_000 + ADMISSION_CLOCK_SKEW_MS + 1_000);
      const kicked = await host.client.op({ type: "kick", playerId: joiner.playerId }, table.gameId);
      assert.equal(kicked.ok, true, JSON.stringify(kicked));
      /* A seat that asks again and again: at most MAX_ADMISSIONS_PER_SEAT approvals, then a sentence. */
      const again = await seatJoiner(world, "Ivy", table.code);
      await linkWallet(again.who, table.gameId, testWallet("ivy"), testConsentKey("ivy"));
      for (let n = 0; n < MAX_ADMISSIONS_PER_SEAT; n += 1) assert.equal((await again.who.api("join-admission", { gameId: table.gameId })).status, 200);
      const over = await again.who.api("join-admission", { gameId: table.gameId });
      assert.equal(over.status, 409);
      assert.equal(over.body?.error, "too-many-admissions");
    } finally {
      await world.close();
    }
  });

  test("S-M3: relinking the SAME wallet renews its proof, so an aged proof never strands a joiner", async () => {
    const world = await moneyServer({ fundingPeriodSecs: 3 * 24 * 3600 });
    try {
      const { table, joiner } = await hostOpened(world);
      const w1 = testWallet("jo");
      const k1 = testConsentKey("jo");
      const first = await linkWallet(joiner.who, table.gameId, w1, k1);
      assert.equal(first.status, 200, first.text);
      world.advance(25 * 60 * 60 * 1000);
      await world.observe();
      const stale = await joiner.who.api("join-admission", { gameId: table.gameId });
      assert.equal(stale.body?.error, "link-first", stale.text);
      const renewed = await linkWallet(joiner.who, table.gameId, w1, k1);
      assert.equal(renewed.body?.mode, "unchanged", renewed.text);
      assert.equal(renewed.body?.ticket, first.body?.ticket, "the same ticket and epoch");
      const grant = (await world.ledger.snapshot(table.gameId)).grants.find((entry) => entry.player_id === joiner.playerId && entry.standing);
      assert.equal(grant?.proof?.verified_at, world.clock.now);
      assert.equal((await joiner.who.api("join-admission", { gameId: table.gameId })).status, 200);
    } finally {
      await world.close();
    }
  });

  test("R-H1: the host leaves by Cancel, never Withdraw -- and a host whose deposit left the escrow still has Cancel", async () => {
    const world = await moneyServer();
    try {
      const { host, table, hostWallet, chainGameId, joiner } = await hostOpened(world);
      let view = moneyOf(await viewOf(host.client, table.gameId));
      assert.ok(view.you?.actions.includes("cancel-escrow"));
      assert.ok(!view.you?.actions.includes("withdraw"));
      const hostDeposits = await host.api("deposits");
      assert.deepEqual((hostDeposits.body?.deposits as Array<{ actions: string[] }>).map((entry) => entry.actions), [["cancel-escrow", "open-table"]]);
      /* The creator withdrew anyway (the contract allows it): the escrow can never fill; Cancel is still offered. */
      assert.ok(world.chain.withdraw(chainGameId, hostWallet.address).ok);
      await world.observe();
      view = moneyOf(await viewOf(host.client, table.gameId));
      assert.equal(view.you?.funding, "linked");
      assert.deepEqual(view.you?.actions, ["cancel-escrow"]);
      /* The joiner, meanwhile, withdraws as ever; and a cancelled escrow is no longer "your deposit". */
      const w1 = testWallet("jo");
      const linked = await linkWallet(joiner.who, table.gameId, w1, testConsentKey("jo"));
      await joinerFunds(world, joiner.who, table.gameId, w1, testConsentKey("jo"), linked.body?.ticket as string);
      await world.observe();
      const joinerDeposits = await joiner.who.api("deposits");
      assert.deepEqual((joinerDeposits.body?.deposits as Array<{ actions: string[] }>).map((entry) => entry.actions), [["withdraw", "open-table"]]);
      assert.ok(world.chain.cancel(chainGameId, hostWallet.address).ok);
      world.advance(6_000); // past the deposits answer's reuse
      await world.observe();
      assert.deepEqual((await joiner.who.api("deposits")).body?.deposits, [], "refunded: nothing of the joiner's is in an escrow now");
    } finally {
      await world.close();
    }
  });

  test("R-H2: a time-only change is pushed -- ten minutes after full funding a funded joiner is offered Start without asking", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      const w1 = testWallet("jo");
      const linked = await linkWallet(joiner.who, table.gameId, w1, testConsentKey("jo"));
      await joinerFunds(world, joiner.who, table.gameId, w1, testConsentKey("jo"), linked.body?.ticket as string);
      await world.observe();
      const before = moneyOf(await viewOf(joiner.who.client, table.gameId));
      assert.equal(before.start.canStart, false);
      assert.equal(typeof before.start.anyoneMayStartAt, "number", "the time is said, so the panel can say it");
      const seen = joiner.who.client.frames.length;
      world.advance(START_GRACE_MS + 1_000);
      await world.observe();
      const pushed = await joiner.who.client.next((frame) => frame.kind === "room" && frame.gameId === table.gameId && joiner.who.client.frames.indexOf(frame) >= seen, "a pushed view");
      const view = (pushed.view as Record<string, unknown>).money as RoomMoneyView;
      assert.equal(view.start.canStart, true);
      assert.ok(view.you?.actions.includes("start"));
    } finally {
      await world.close();
    }
  });

  test("verification pass: a later withdrawal's hint never replaces the seat's deposit hint", async () => {
    const world = await moneyServer();
    try {
      const { table, joiner } = await hostOpened(world);
      await linkWallet(joiner.who, table.gameId, testWallet("jo"), testConsentKey("jo"));
      assert.equal((await joiner.who.api("join-admission", { gameId: table.gameId })).status, 200);
      assert.equal((await joiner.who.api("deposit-sent", { gameId: table.gameId, kind: "join", txHash: "D1".repeat(32), timeoutHeight: "999999" })).status, 202);
      assert.equal((await joiner.who.api("deposit-sent", { gameId: table.gameId, kind: "withdraw", txHash: "D2".repeat(32) })).status, 202);
      await world.money.idle();
      assert.deepEqual(world.money.hintsOf(table.gameId).map((hint) => [hint.kind, hint.txHash]).sort(), [["join", "D1".repeat(32)], ["withdraw", "D2".repeat(32)]]);
      assert.equal(moneyOf(await viewOf(joiner.who.client, table.gameId)).you?.funding, "sent");
    } finally {
      await world.close();
    }
  });

  test("S-H1: the browser's replay of a sealed prefix is the server's, byte for byte", () => {
    const entries = storedLog(3);
    const server = serverPrefixReplay(BUILD)(entries);
    assert.ok(server.ok);
    const browser = replaySealedPrefix(entries);
    assert.ok(browser !== null);
    assert.equal(canonicalStateText(browser), canonicalStateText(server.board));
  });
});
