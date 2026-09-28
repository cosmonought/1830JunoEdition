// server/src/escrow/juno/junoCrypto.test.ts
//
// ==================================================================
//  ESCROW-3B: THE BYTES THE BACKEND SIGNS -- secp256k1, THE COSMOS TRANSACTION, BECH32, DER, THE CONTRACT'S REFUSALS
// ==================================================================
//
// Three implementations agree: this module's RFC 6979 reproduces EVERY signature of ESCROW-2's independent Python
// generator (the frozen `payload_vectors_v1.json`, read, never written) from its published test secrets, and Node's own
// OpenSSL verifies what it signs and signs what it verifies. The protobuf encoding is pinned by known answers here and
// byte for byte against CosmJS in `frontend/src/utils/escrow3bCosmosTxParity.test.ts`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { derToCompact, isLowS, normalizeLowS, publicKeyOf, SECP256K1_N, signDigest, verifyDigest, bigIntTo32 } from "./secp256k1";
import { addressOfPublicKey, assembleTx, bech32Decode, bech32Encode, encodeSignDoc, prepareExecuteTx, txHashOf, u64Of } from "./cosmosTx";
import { decodeRelayerTx } from "./fakeJunoChain";
import { classifyContractFailure, JUNO_ERROR_TEMPLATES, QUERY, RELAYER_EXECUTE, WALLET_EXECUTE } from "./junoContract";
import { compressedKeyFromSpki, deriveSecp256k1FromSeed, developmentDigestSigner, openKmsDigestSigner, secretFromKeyText, SignerError, checkDevelopmentSignerAllowed } from "./signer";
import { decideGas, DEFAULT_GAS_POLICY } from "./gasPolicy";
import { JUNO_CONTRACT_ERROR_MAP } from "../../../../frontend/src/gameEngine/escrow/junoCodecV1";

/** The repository root, found from wherever the compiled test runs (`server/dist/server/src/...`). */
const REPO = (() => {
  let dir = __dirname;
  for (let up = 0; up < 10; up += 1) {
    if (fs.existsSync(path.join(dir, "contracts", "escrow", "src", "error.rs"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("the repository root was not found above the test");
})();
const VECTORS = path.join(REPO, "contracts", "escrow", "testdata", "payload_vectors_v1.json");
const ERROR_RS = path.join(REPO, "contracts", "escrow", "src", "error.rs");
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest();

describe("ESCROW-3B: secp256k1 over a digest agrees with the frozen Python vectors and with OpenSSL", () => {
  const vectors = JSON.parse(fs.readFileSync(VECTORS, "utf8"));

  test("the vector file is the frozen one (SHA-256 635024311c…)", () => {
    assert.equal(createHash("sha256").update(fs.readFileSync(VECTORS)).digest("hex"), "635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac");
  });

  test("every settlement-signer and consent signature is reproduced byte for byte (RFC 6979, low-s)", () => {
    const signer = sha(vectors.keys.signer.label);
    assert.equal(publicKeyOf(signer).toString("hex"), vectors.keys.signer.pubkey);
    let consents = 0;
    for (const vector of vectors.payload_vectors) {
      assert.equal(signDigest(signer, Buffer.from(vector.settle_digest, "hex")).toString("hex"), vector.signer_signature, vector.name);
      assert.ok(verifyDigest(Buffer.from(vectors.keys.signer.pubkey, "hex"), Buffer.from(vector.settle_digest, "hex"), Buffer.from(vector.signer_signature, "hex")));
      vector.consent_signatures.forEach((signature: string, seat: number) => {
        const secret = sha(vectors.keys.seats[seat].label);
        assert.equal(publicKeyOf(secret).toString("hex"), vectors.keys.seats[seat].pubkey);
        assert.equal(signDigest(secret, Buffer.from(vector.consent_digest, "hex")).toString("hex"), signature, `${vector.name} seat ${seat}`);
        consents += 1;
      });
    }
    assert.ok(consents >= 36);
  });

  test("OpenSSL verifies ours and we verify OpenSSL's (both directions, many keys)", () => {
    for (let n = 0; n < 8; n += 1) {
      const pair = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
      const secret = Buffer.from(pair.privateKey.export({ format: "jwk" }).d as string, "base64url");
      const publicKey = publicKeyOf(secret);
      const message = Buffer.from(`escrow-3b parity ${n}`);
      const digest = sha(message);
      const ours = signDigest(secret, digest);
      assert.ok(isLowS(ours));
      assert.ok(nodeVerify("sha256", message, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, ours), "OpenSSL verifies our signature");
      const theirs = normalizeLowS(nodeSign("sha256", message, { key: pair.privateKey, dsaEncoding: "ieee-p1363" }));
      assert.ok(verifyDigest(publicKey, digest, theirs), "we verify OpenSSL's signature");
      assert.ok(verifyDigest(publicKey, digest, derToCompact(nodeSign("sha256", message, pair.privateKey))), "DER (KMS's form) -> r||s, low-s");
      assert.equal(verifyDigest(publicKey, sha(Buffer.from("other")), ours), false);
      const spki = pair.publicKey.export({ format: "der", type: "spki" });
      assert.equal(compressedKeyFromSpki(spki).toString("hex"), publicKey.toString("hex"), "the KMS public key form");
    }
  });

  test("high-s is refused where the chain refuses it; malformed DER is refused", () => {
    const secret = sha("k");
    const digest = sha("d");
    const low = signDigest(secret, digest);
    const s = BigInt(`0x${low.subarray(32).toString("hex")}`);
    const high = Buffer.concat([low.subarray(0, 32), bigIntTo32(SECP256K1_N - s)]);
    assert.equal(verifyDigest(publicKeyOf(secret), digest, high), false);
    assert.equal(verifyDigest(publicKeyOf(secret), digest, high, false), true);
    assert.equal(normalizeLowS(high).toString("hex"), low.toString("hex"));
    for (const bad of ["3000", "30060201000201", "3006020100020100", "300802020001020101", "3007020101020101ff"]) {
      assert.throws(() => derToCompact(Buffer.from(bad, "hex")));
    }
  });
});

describe("ESCROW-3B: the relayer's transaction, bech32 and HD keys", () => {
  test("bech32 round trips; an upper-case, mis-prefixed or bad-checksum address is refused", () => {
    const bytes = sha("address").subarray(0, 20);
    const address = bech32Encode("juno", bytes);
    assert.match(address, /^juno1[02-9ac-hj-np-z]{38}$/);
    assert.deepEqual(bech32Decode(address, "juno").bytes, bytes);
    assert.throws(() => bech32Decode(address.toUpperCase()));
    assert.throws(() => bech32Decode(address, "cosmos"));
    assert.throws(() => bech32Decode(`${address.slice(0, -1)}${address.endsWith("q") ? "p" : "q"}`));
  });

  test("the address a key controls is bech32(RIPEMD-160(SHA-256(key))) (a vector computed by CosmJS)", () => {
    const pub = Buffer.from("02950e1cdfcb133d6024109fd489f734eeb4502418e538c28481f22bce276f248c", "hex");
    assert.equal(addressOfPublicKey(pub, "cosmos"), "cosmos10s4mg25tu6termrk8egltfyme4q7sg3her239u");
    assert.throws(() => addressOfPublicKey(pub.subarray(1), "juno"));
  });

  test("a BIP-39 mnemonic derives the m/44'/118'/0'/0/0 key (the standard test mnemonic's known cosmos address)", () => {
    const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const secret = secretFromKeyText(words);
    /* The widely published cosmos address of the all-"abandon" test mnemonic at m/44'/118'/0'/0/0. */
    assert.equal(addressOfPublicKey(publicKeyOf(secret), "cosmos"), "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4");
    assert.equal(publicKeyOf(secret).toString("hex"), "024f4e2ad99c34d60b9ba6283c9431a8418af8673212961f97a77b6377fcd05b62");
    assert.equal(secretFromKeyText(`0x${"11".repeat(32)}`).toString("hex"), "11".repeat(32));
    assert.throws(() => secretFromKeyText("not a key"), SignerError);
    assert.throws(() => deriveSecp256k1FromSeed(Buffer.alloc(64), "44'/118'"), SignerError);
  });

  test("the transaction encodes deterministically, its hash is SHA-256 of the bytes, and it decodes back", () => {
    const secret = sha("relayer");
    const publicKey = publicKeyOf(secret);
    const sender = addressOfPublicKey(publicKey, "juno");
    const msg = RELAYER_EXECUTE.finalize("7");
    const prepared = prepareExecuteTx({ chainId: "uni-7", accountNumber: "12", sequence: "3", sender, contract: "juno1contract", msgJson: msg, publicKey, gasLimit: "200000", fee: { denom: "ujunox", amount: "15000" }, timeoutHeight: "1060", memo: "" });
    const again = prepareExecuteTx({ chainId: "uni-7", accountNumber: "12", sequence: "3", sender, contract: "juno1contract", msgJson: msg, publicKey, gasLimit: "200000", fee: { denom: "ujunox", amount: "15000" }, timeoutHeight: "1060", memo: "" });
    assert.deepEqual(prepared.signDoc, again.signDoc);
    const signed = assembleTx(prepared, signDigest(secret, prepared.digest));
    assert.equal(signed.txHash, txHashOf(signed.txBytes));
    assert.equal(signed.txHash, createHash("sha256").update(signed.txBytes).digest("hex").toUpperCase());
    const decoded = decodeRelayerTx(signed.txBytes);
    assert.equal(decoded.msgJson, msg);
    assert.equal(decoded.sequence, BigInt(3));
    assert.equal(decoded.timeoutHeight, BigInt(1060));
    assert.equal(decoded.gasLimit, BigInt(200000));
    assert.equal(decoded.fee, BigInt(15000));
    const signDoc = encodeSignDoc({ bodyBytes: decoded.bodyBytes, authInfoBytes: decoded.authInfoBytes, chainId: "uni-7", accountNumber: BigInt(12) });
    assert.ok(verifyDigest(publicKey, sha(signDoc), decoded.signature), "the signature verifies over the SignDoc the chain re-derives");
    /* Another chain id or account number is another SignDoc: the signature does not carry over. */
    assert.equal(verifyDigest(publicKey, sha(encodeSignDoc({ bodyBytes: decoded.bodyBytes, authInfoBytes: decoded.authInfoBytes, chainId: "juno-1", accountNumber: BigInt(12) })), decoded.signature), false);
    assert.throws(() => u64Of("01", "x"));
    assert.throws(() => u64Of("18446744073709551616", "x"));
  });

  test("the execute messages are the frozen ABI (integers for chain_game_id, never a JavaScript number)", () => {
    assert.equal(RELAYER_EXECUTE.start("18446744073709551615", "ab".repeat(32)), `{"start":{"chain_game_id":18446744073709551615,"roster_hash":"${"ab".repeat(32)}"}}`);
    assert.equal(RELAYER_EXECUTE.finalize("9"), `{"finalize":{"chain_game_id":9}}`);
    assert.match(RELAYER_EXECUTE.settle("9", { x: 1 } as never, "cd".repeat(64)), /"consents":\[\]\}\}$/);
    assert.equal(QUERY.game("5"), `{"game":{"chain_game_id":5}}`);
    assert.equal(QUERY.signerKeys(null, 30), `{"signer_keys":{"start_after":null,"limit":30}}`);
    assert.throws(() => RELAYER_EXECUTE.finalize("1.5"));
    assert.throws(() => RELAYER_EXECUTE.start("1", "AB".repeat(32)), "upper-case hex is refused");
    assert.match(WALLET_EXECUTE.createGame({ maxPlayers: 4, mode: 0, rulesEngineVersion: 11, variantsDigest: "00".repeat(32), consentPubkey: `02${"11".repeat(32)}`, joinTicket: "22".repeat(32) }), /^\{"create_game":\{"max_players":4,"mode":"live","rules_engine_version":11,/);
  });
});

describe("ESCROW-3B (GNOLAND-1 F14): contract refusals are classified from their Display text, pinned to error.rs", () => {
  const source = fs.readFileSync(ERROR_RS, "utf8");
  const parsed = new Map<string, string>();
  const re = /#\[error\("((?:[^"\\]|\\.)*)"\)\]\s*\n\s*([A-Z][A-Za-z]*)/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) parsed.set(m[2], m[1]);

  test("the template table is exactly error.rs's (every variant, every word)", () => {
    assert.deepEqual([...parsed.keys()].sort(), Object.keys(JUNO_ERROR_TEMPLATES).sort());
    for (const [variant, template] of parsed) assert.equal(JUNO_ERROR_TEMPLATES[variant], template, variant);
    assert.deepEqual(Object.keys(JUNO_CONTRACT_ERROR_MAP).sort(), [...parsed.keys()].sort(), "the neutral map covers the same variants");
  });

  test("an instance of every template classifies to its own variant inside wasmd's wrapping", () => {
    const sample: Record<string, string> = { role: "operator", chain_game_id: "7", actual: "in_progress", expected: "funded", denom: "ujuno", got: "3", min: "100", field: "roster_hash", seat_index: "2", reason: "4", seq: "12", appraisal_log_len: "5", log_len: "6", seat_count: "3", weights: "2", trusted_seq: "14", key_id: "1", until: "1760000000.000000000", closed: "1760000000.000000000", at: "1760000000.000000000", contract: "x", from: "1.0.0", to: "0.9.0", version: "zz" };
    for (const [variant, template] of Object.entries(JUNO_ERROR_TEMPLATES)) {
      if (variant === "Std") continue;
      let text = template.replace(/\{([a-z_0-9]+)\}/g, (_, name: string) => sample[name] ?? "x");
      if (variant === "WrongKind") text = "this message needs a checkpoint payload";
      if (variant === "MalformedPayload" || variant === "InvalidParams" || variant === "Invariant") text = template.replace("{reason}", "something odd");
      const wrapped = `failed to execute message; message index: 0: ${text}: execute wasm contract failed`;
      assert.equal(classifyContractFailure(wrapped).variant, variant, `${variant}: ${text}`);
    }
    assert.equal(classifyContractFailure("Generic error: whatever").error.code, "BACKEND_INVARIANT");
    assert.equal(classifyContractFailure("seq 12 does not exceed the trusted sequence 14").error.code, "STALE_SEQUENCE");
    assert.equal(classifyContractFailure("invalid signature for seat 3").error.code, "CONSENT_REJECTED");
    assert.equal(classifyContractFailure("invalid signature").error.code, "SIGNATURE_INVALID");
  });
});

describe("ESCROW-3B: signers and gas are bounded and fail closed", () => {
  test("a development signer is refused in production, on mainnet, and without the explicit switch", () => {
    const ok = { serverMode: "development" as const, networkClass: "testnet" as const, chainId: "uni-7", acknowledged: true };
    assert.doesNotThrow(() => checkDevelopmentSignerAllowed(ok));
    assert.throws(() => checkDevelopmentSignerAllowed({ ...ok, serverMode: "production" }), /production/);
    assert.throws(() => checkDevelopmentSignerAllowed({ ...ok, networkClass: "mainnet" }), /mainnet/);
    assert.throws(() => checkDevelopmentSignerAllowed({ ...ok, chainId: "juno-1" }), /mainnet/);
    assert.throws(() => checkDevelopmentSignerAllowed({ ...ok, acknowledged: false }), /explicitly/);
    assert.throws(() => developmentDigestSigner(sha("x"), "x", { ...ok, serverMode: "production" }), SignerError);
  });

  test("KMS: the public key comes from GetPublicKey, the DER answer is normalised and VERIFIED before use", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const other = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    let wrong = false;
    const kms = {
      getPublicKey: async () => pair.publicKey.export({ format: "der", type: "spki" }),
      signDigest: async (_ref: string, digest: Uint8Array) => {
        /* A real KMS signs the digest as given; Node needs the preimage, so the fake signs with the prehash trick: */
        const secret = Buffer.from((wrong ? other : pair).privateKey.export({ format: "jwk" }).d as string, "base64url");
        const compact = signDigest(secret, Buffer.from(digest));
        const r = compact.subarray(0, 32);
        const s = compact.subarray(32);
        const int = (b: Buffer) => (b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
        const strip = (b: Buffer) => {
          let at = 0;
          while (at < b.length - 1 && b[at] === 0 && !(b[at + 1] & 0x80)) at += 1;
          return b.subarray(at);
        };
        const R = int(strip(r));
        const S = int(strip(s));
        return Buffer.concat([Buffer.from([0x30, 4 + R.length + S.length, 0x02, R.length]), R, Buffer.from([0x02, S.length]), S]);
      },
    };
    const signer = await openKmsDigestSigner(kms, "arn:aws:kms:test");
    const digest = sha("payload");
    assert.ok(verifyDigest(signer.publicKey, digest, await signer.sign(digest)));
    wrong = true;
    await assert.rejects(() => signer.sign(digest), /does not verify/);
    await assert.rejects(() => openKmsDigestSigner({ ...kms, getPublicKey: async () => Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex") }, "arn:p256"), SignerError);
  });

  test("gas: simulated × 13/10, bounded; an absurd or zero answer, or a fee over the cap, is refused", () => {
    const policy = { ...DEFAULT_GAS_POLICY, feeDenom: "ujuno" };
    assert.deepEqual(decideGas("100000", policy), { ok: true, gasLimit: BigInt(130000), fee: BigInt(9750) });
    assert.deepEqual(decideGas("10", policy), { ok: true, gasLimit: BigInt(80000), fee: BigInt(6000) });
    assert.equal(decideGas("99999999999", policy).ok, false);
    assert.equal(decideGas("0", policy).ok, false);
    assert.equal(decideGas("-5", policy).ok, false);
    assert.equal(decideGas("1.5", policy).ok, false);
    assert.equal(decideGas("1000000", { ...policy, maxFee: BigInt(1) }).ok, false);
  });
});
