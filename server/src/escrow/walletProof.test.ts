// server/src/escrow/walletProof.test.ts
//
// ESCROW-4: the ADR-036 wallet proof. The reference vector below was produced by cosmjs 0.32 (`@cosmjs/amino`
// `makeSignDoc` + `serializeSignDoc`, `@cosmjs/crypto` `Secp256k1.createSignature`) -- the serialization Keplr's
// `signArbitrary` uses -- so the server's own rebuild of the sign doc is pinned to an independent implementation.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { adr036SignDocJson, parseWalletLinkChallenge, walletLinkChallengeText, WALLET_LINK_TTL_MS } from "../../../frontend/src/gameEngine/escrow/walletLinkChallengeV1";
import { canonicalJunoWallet, createChallengeBook, verifyAdr036 } from "./walletProof";
import { testWallet } from "./escrow4Support";

/** cosmjs 0.32.4, secret SHA-256("18COSMOS/TEST/wallet/keplr-vector"). */
const COSMJS_VECTOR = Object.freeze({
  address: "juno12gdmst084pz888ds7g80nv27p9wadknwdl783a",
  pubKey: "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf",
  signature: "X5eMwfSS7VZsD4Z2Wb774JiwGp3HWosF1t0yx5umEAw5odNTctXpkEbf232OTK9D/pjz4keHOkaCXhn8AE45tg==",
  text:
    "18COSMOS/WALLET-LINK/v1\nProject 18XX: link this wallet to your seat. This is not a transaction and moves no funds.\nSite: https://play.example\nNetwork: uni-7\n" +
    "Escrow contract: juno14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9skjuwg8\nGame: g_0000000000000000000000000w\nSeat: p-0000000000000000\n" +
    "Wallet: juno12gdmst084pz888ds7g80nv27p9wadknwdl783a\nNonce: 00112233445566778899aabbccddeeff\nExpires: 2026-09-28T21:30:00.000Z",
  docJson:
    '{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"MThDT1NNT1MvV0FMTEVULUxJTksvdjEKUHJvamVjdCAxOFhYOiBsaW5rIHRoaXMgd2FsbGV0IHRvIHlvdXIgc2VhdC4gVGhpcyBpcyBub3QgYSB0cmFuc2FjdGlvbiBhbmQgbW92ZXMgbm8gZnVuZHMuClNpdGU6IGh0dHBzOi8vcGxheS5leGFtcGxlCk5ldHdvcms6IHVuaS03CkVzY3JvdyBjb250cmFjdDoganVubzE0aGoydGF2cThmcGVzZHd4eGN1NDRydHkzaGg5MHZodWpydmNtc3RsNHpyM3R4bWZ2dzlza2p1d2c4CkdhbWU6IGdfMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMHcKU2VhdDogcC0wMDAwMDAwMDAwMDAwMDAwCldhbGxldDoganVubzEyZ2Rtc3QwODRwejg4OGRzN2c4MG52MjdwOXdhZGtud2RsNzgzYQpOb25jZTogMDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmYKRXhwaXJlczogMjAyNi0wOS0yOFQyMTozMDowMC4wMDBa","signer":"juno12gdmst084pz888ds7g80nv27p9wadknwdl783a"}}],"sequence":"0"}',
});

describe("ESCROW-4: ADR-036 verification, pinned to cosmjs (what Keplr signs)", () => {
  test("the server rebuilds cosmjs's exact sign doc and accepts its signature; the proof records the key and the text", () => {
    assert.equal(adr036SignDocJson(COSMJS_VECTOR.address, COSMJS_VECTOR.text), COSMJS_VECTOR.docJson);
    const verdict = verifyAdr036({ wallet: COSMJS_VECTOR.address, text: COSMJS_VECTOR.text, pubKeyBase64: COSMJS_VECTOR.pubKey, signatureBase64: COSMJS_VECTOR.signature, now: 5 });
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    if (verdict.ok) {
      assert.equal(verdict.proof.wallet, COSMJS_VECTOR.address);
      assert.equal(verdict.proof.pubkey, Buffer.from(COSMJS_VECTOR.pubKey, "base64").toString("hex"));
      assert.equal(verdict.proof.verified_at, 5);
      assert.match(verdict.proof.proof_hash, /^[0-9a-f]{64}$/);
    }
    assert.ok(parseWalletLinkChallenge(COSMJS_VECTOR.text) !== null, "the vector is a well-formed challenge");
  });

  test("anything else is refused: another text, a tampered signature, another wallet, a malformed key or signature", () => {
    const base = { wallet: COSMJS_VECTOR.address, text: COSMJS_VECTOR.text, pubKeyBase64: COSMJS_VECTOR.pubKey, signatureBase64: COSMJS_VECTOR.signature, now: 0 };
    assert.deepEqual(verifyAdr036({ ...base, text: base.text.replace("uni-7", "juno-1") }), { ok: false, why: "bad-signature" }, "the network is signed");
    const sig = Buffer.from(base.signatureBase64, "base64");
    sig[10] ^= 1;
    assert.deepEqual(verifyAdr036({ ...base, signatureBase64: sig.toString("base64") }), { ok: false, why: "bad-signature" });
    const other = testWallet("other");
    assert.deepEqual(verifyAdr036({ ...base, wallet: other.address }), { ok: false, why: "wrong-wallet" }, "the key is not the wallet's");
    assert.deepEqual(verifyAdr036({ ...base, pubKeyBase64: "AAAA" }), { ok: false, why: "bad-key" });
    assert.deepEqual(verifyAdr036({ ...base, pubKeyBase64: Buffer.alloc(33, 9).toString("base64") }), { ok: false, why: "bad-key" });
    assert.deepEqual(verifyAdr036({ ...base, signatureBase64: "xyz" }), { ok: false, why: "bad-signature" });
    /* The server's own test wallet signs exactly as cosmjs does (a second, independent signer over the same bytes). */
    const mine = testWallet("mine");
    const text = walletLinkChallengeText({ appName: "Project 18XX", site: "https://play.example", chainId: "uni-7", contract: "juno1contract", gameId: "g_x", playerId: "p-x", wallet: mine.address, nonce: "ab".repeat(16), expiresAt: 1_800_000_000_000 });
    const signed = mine.signArbitrary(text);
    assert.equal(verifyAdr036({ wallet: mine.address, text, pubKeyBase64: signed.pubKey, signatureBase64: signed.signature, now: 0 }).ok, true);
  });

  test("a Juno wallet is lowercase bech32 `juno` with a 20-byte account: nothing else is linkable", () => {
    assert.equal(canonicalJunoWallet(COSMJS_VECTOR.address), COSMJS_VECTOR.address);
    assert.equal(canonicalJunoWallet(COSMJS_VECTOR.address.toUpperCase()), null);
    assert.equal(canonicalJunoWallet("cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a"), null);
    assert.equal(canonicalJunoWallet("juno1notanaddress"), null);
    assert.equal(canonicalJunoWallet(42), null);
  });
});

describe("ESCROW-4: the challenge text and the challenge book", () => {
  test("the browser's parser accepts exactly the server's text and nothing edited", () => {
    const fields = { appName: "Project 18XX", site: "https://play.example", chainId: "uni-7", contract: "juno1contract", gameId: "g_x", playerId: "p-x", wallet: "juno1wallet", nonce: "cd".repeat(16), expiresAt: 1_800_000_000_000 };
    const text = walletLinkChallengeText(fields);
    assert.deepEqual(parseWalletLinkChallenge(text), fields);
    assert.equal(parseWalletLinkChallenge(`${text}\n`), null);
    assert.equal(parseWalletLinkChallenge(text.replace("Seat: p-x", "Seat: p-y\nSeat: p-x")), null);
    assert.equal(parseWalletLinkChallenge(text.replace("18COSMOS/WALLET-LINK/v1", "18COSMOS/WALLET-LINK/v2")), null);
    assert.equal(parseWalletLinkChallenge(text.replace("Nonce: " + fields.nonce, "Nonce: XYZ")), null);
    assert.throws(() => walletLinkChallengeText({ ...fields, gameId: "g_x\nSeat: p-evil" }), /single printable line/);
  });

  test("a nonce is single use, bound to its session, family, selector and game, and expires", () => {
    let now = 1_000;
    const book = createChallengeBook({ now: () => now, appName: "Project 18XX", random: () => Buffer.from("00112233445566778899aabbccddeeff", "hex") });
    const context = { sessionId: "se_1", familyId: "sf_1", recoverySelector: "rk_1", principalId: "pr_1" };
    const minted = book.mint({ context, gameId: "g_a", playerId: "p-1", wallet: "juno1w", site: "https://play.example", chainId: "uni-7", contract: "juno1c" });
    assert.equal(book.take(minted.nonce, { ...context, familyId: "sf_2" }, "g_a").kind, "unknown", "another family (a signed-in-again device)");
    assert.equal(book.take(minted.nonce, { ...context, recoverySelector: "rk_2" }, "g_a").kind, "unknown", "the key rotated since");
    assert.equal(book.take(minted.nonce, { ...context, sessionId: "se_2" }, "g_a").kind, "unknown", "another session");
    assert.equal(book.take(minted.nonce, context, "g_b").kind, "unknown", "another game");
    assert.equal(book.take(minted.nonce, context, "g_a").kind, "open");
    book.spend(minted.nonce, "sig-1", { ok: true });
    const spent = book.take(minted.nonce, context, "g_a");
    assert.deepEqual(spent, { kind: "spent", signature: "sig-1", result: { ok: true } });
    now += WALLET_LINK_TTL_MS + 1;
    assert.equal(book.take(minted.nonce, context, "g_a").kind, "unknown", "expired");
    assert.equal(book.size(), 0);
  });
});
