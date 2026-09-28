/** @jest-environment node */
// ESCROW-4: the browser-side cryptography, pinned to independent implementations.
//   - The ADR-036 sign doc the server rebuilds (`adr036SignDocJson`) is byte for byte cosmjs's `serializeSignDoc`
//     (what Keplr's `signArbitrary` signs), for texts with every character class JSON escapes.
//   - A consent key is made and STORED before it is handed back; its signatures are 64-byte low-S r||s that verify
//     against the key over the CONSENT / ANNUL digests this browser computes; removing the keys removes them.
//   - A pending transaction is kept (and read back) before a broadcast may happen; storage that refuses means no record.

import { makeSignDoc, serializeSignDoc } from "@cosmjs/amino";
import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";
import { fromHex, toBase64, toHex } from "@cosmjs/encoding";

import { signDigest as serverSignDigest, verifyDigest as serverVerifyDigest } from "../../../server/src/escrow/juno/secp256k1";
import { adr036SignDocJson } from "../gameEngine/escrow/walletLinkChallengeV1";
import { annulDigestV1, consentDigestV1 } from "../gameEngine/settlementPayload";
import { createConsentKeys, memoryConsentKeyVault, type ConsentKeyVault } from "./consentKeys";
import { createPendingTxStore, PENDING_TX_MAX_AGE_MS, PENDING_TX_STORAGE_KEY, type PendingWalletTx } from "./pendingTx";
import { LEADING_ZERO_KEY, LEADING_ZERO_VECTORS, memoryStorage, testKey, T0, TEST_CONTRACT, TEST_WALLET } from "./moneyTestSupport";

const N_HALF = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");

describe("ESCROW-4: ADR-036 -- the server's sign doc is cosmjs's (what Keplr signs)", () => {
  it("byte for byte, whatever the text holds", () => {
    for (const text of ["18COSMOS/WALLET-LINK/v1\nplain", "ampersand & angle <b> quote \" backslash \\ tab \t", "unicode é 漢字 🂡 and a lone \u2028 separator"]) {
      const cosmjs = new TextDecoder().decode(
        serializeSignDoc(makeSignDoc([{ type: "sign/MsgSignData", value: { signer: TEST_WALLET, data: toBase64(new TextEncoder().encode(text)) } }], { gas: "0", amount: [] }, "", "", 0, 0)),
      );
      expect(adr036SignDocJson(TEST_WALLET, text)).toBe(cosmjs);
    }
  });
});

describe("ESCROW-4 (F-3): the browser's consent key", () => {
  it("is stored before it is returned, signs low-S over this browser's digests, and is removed on request", async () => {
    const vault = memoryConsentKeyVault();
    const keys = createConsentKeys(vault, () => T0);
    const made = await keys.create({ chainId: "uni-7", contract: "juno1c", gameId: "g_1", playerId: "p-1", wallet: TEST_WALLET });
    if (!made.ok) throw new Error(made.reason);
    expect(vault.records.get(made.pubkey)?.privkey).toMatch(/^[0-9a-f]{64}$/);
    expect(await keys.holds(made.pubkey)).toBe(true);
    expect((await keys.forSeat("g_1", "p-1")).map((record) => record.pubkey)).toEqual([made.pubkey]);
    const domain = "aa".repeat(32);
    for (const digest of [consentDigestV1(domain, BigInt(41), "bb".repeat(32)), annulDigestV1(domain, BigInt(40))]) {
      const signature = await keys.signDigest(made.pubkey, digest);
      expect(signature).toMatch(/^[0-9a-f]{128}$/);
      const bytes = fromHex(signature as string);
      expect(BigInt(`0x${(signature as string).slice(64)}`) <= N_HALF).toBe(true); // low-S
      expect(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(bytes), fromHex(digest), fromHex(made.pubkey))).toBe(true);
    }
    expect(await keys.signDigest(`03${"22".repeat(32)}`, consentDigestV1(domain, BigInt(1), "bb".repeat(32)))).toBeNull(); // not held here
    expect(await keys.signDigest(made.pubkey, "not-a-digest")).toBeNull();
    expect(await keys.count()).toBe(1);
    expect(await keys.removeAll()).toBe(1);
    expect(await keys.holds(made.pubkey)).toBe(false);
  });

  it("a vault that doesn't keep the key means no key (and a browser with none can't fund a seat)", async () => {
    const forgetful: ConsentKeyVault = { ...memoryConsentKeyVault(), put: async () => undefined, get: async () => null };
    const answer = await createConsentKeys(forgetful).create({ chainId: "uni-7", contract: "juno1c", gameId: "g_1", playerId: "p-1", wallet: null });
    expect(answer).toEqual({ ok: false, reason: expect.stringMatching(/didn't keep the signing key/) });
    const none = createConsentKeys(null);
    expect(none.available).toBe(false);
    expect(await none.create({ chainId: "uni-7", contract: "juno1c", gameId: "g_1", playerId: "p-1", wallet: null })).toEqual({ ok: false, reason: expect.stringMatching(/can't keep a signing key/) });
  });

  /* Owner broad gate (ESCROW-4 report §21): `signDigest` wrapped the padded halves in `new Secp256k1Signature(r(32),
     s(32))`, which refuses a half that begins with a zero byte -- about one signature in a hundred, and the same one on
     every retry, because RFC 6979 is deterministic. These are FIXED vectors (a fixed key, fixed CONSENT and ANNUL
     digests), so the zero-led cases are exercised on every run rather than by luck. */
  it("signs the exact 64-byte r‖s for fixed CONSENT and ANNUL vectors, including an r or an s that begins with a zero byte", async () => {
    const key = await testKey(LEADING_ZERO_KEY);
    const vault = memoryConsentKeyVault();
    vault.records.set(key.pubkey, { v: 1, chainId: "uni-7", contract: TEST_CONTRACT, gameId: "g_1", playerId: "p-1", wallet: TEST_WALLET, pubkey: key.pubkey, privkey: toHex(key.privkey), createdAt: T0 });
    const keys = createConsentKeys(vault, () => T0);
    const { consent, annul } = LEADING_ZERO_VECTORS;
    const cases = [
      { name: "consent, ordinary", lead: "none", digest: consentDigestV1(consent.domain, BigInt(consent.ordinary.seq), consent.settleDigest), want: consent.ordinary.signature },
      { name: "consent, r led by 00", lead: "r", digest: consentDigestV1(consent.domain, BigInt(consent.rLeadingZero.seq), consent.settleDigest), want: consent.rLeadingZero.signature },
      { name: "consent, s led by 00", lead: "s", digest: consentDigestV1(consent.domain, BigInt(consent.sLeadingZero.seq), consent.settleDigest), want: consent.sLeadingZero.signature },
      { name: "annul, ordinary", lead: "none", digest: annulDigestV1(annul.domain, BigInt(annul.ordinary.seq)), want: annul.ordinary.signature },
      { name: "annul, r led by 00", lead: "r", digest: annulDigestV1(annul.domain, BigInt(annul.rLeadingZero.seq)), want: annul.rLeadingZero.signature },
      { name: "annul, s led by 00", lead: "s", digest: annulDigestV1(annul.domain, BigInt(annul.sLeadingZero.seq)), want: annul.sLeadingZero.signature },
    ];
    for (const { name, lead, digest, want } of cases) {
      const signature = await keys.signDigest(key.pubkey, digest);
      expect([name, signature]).toEqual([name, want]); // byte for byte
      const bytes = fromHex(want);
      expect([name, bytes.length]).toEqual([name, 64]);
      const [r, s] = [bytes.slice(0, 32), bytes.slice(32)];
      /* The vector really is the case it names. */
      expect([name, r[0] === 0 ? "r" : s[0] === 0 ? "s" : "none"]).toEqual([name, lead]);
      /* ...which the old construction refused (and, for an ordinary one, rebuilt to the same bytes). */
      if (lead === "none") expect(toHex(new Secp256k1Signature(r, s).toFixedLength())).toBe(want);
      else expect(() => new Secp256k1Signature(r, s)).toThrow(/unpadded big endian/);
      expect([name, BigInt(`0x${want.slice(64)}`) <= N_HALF]).toEqual([name, true]); // low-S
      expect([name, await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(bytes), fromHex(digest), fromHex(key.pubkey))]).toEqual([name, true]);
      /* The server's own verifier (the CONSENT/ANNUL relay and the offline chain use it) accepts the same bytes, and its
         own signer makes them. */
      expect([name, serverVerifyDigest(Buffer.from(key.pubkey, "hex"), Buffer.from(digest, "hex"), Buffer.from(want, "hex"))]).toEqual([name, true]);
      expect([name, serverSignDigest(key.privkey, Buffer.from(digest, "hex")).toString("hex")]).toEqual([name, want]);
      /* The test double signs through the same path. */
      expect([name, await key.sign(digest)]).toEqual([name, want]);
    }
  });
});

describe("ESCROW-4: the pending wallet transaction", () => {
  const record = (over: Partial<PendingWalletTx> = {}): PendingWalletTx => ({
    v: 1,
    gameId: "g_1",
    playerId: "p-1",
    kind: "join",
    chainId: "uni-7",
    contract: "juno1c",
    sender: TEST_WALLET,
    chainGameId: "7",
    txHash: "AB".repeat(32),
    txBytes: "AAAA",
    timeoutHeight: "1100",
    createdAt: T0,
    stage: "signed",
    consentKey: null,
    ...over,
  });

  it("is kept and read back before any broadcast; storage that refuses keeps nothing", () => {
    const storage = memoryStorage();
    let now = T0;
    const store = createPendingTxStore(() => storage, () => now);
    expect(store.put(record())).toBe(true);
    expect(store.forSeat("g_1", "p-1").map((entry) => entry.txHash)).toEqual(["AB".repeat(32)]);
    store.markSent("AB".repeat(32));
    expect(store.all()[0].stage).toBe("sent");
    storage.failWrites = true;
    expect(store.put(record({ txHash: "CD".repeat(32) }))).toBe(false);
    storage.failWrites = false;
    expect(createPendingTxStore(() => null).put(record())).toBe(false);
    /* A malformed record is never read as one; an old one ages out. */
    expect(store.put(record({ txHash: "lowercase-not-hex" }))).toBe(false);
    storage.setItem(PENDING_TX_STORAGE_KEY, "{not json");
    expect(store.all()).toEqual([]);
    expect(store.put(record())).toBe(true);
    now = T0 + PENDING_TX_MAX_AGE_MS + 1;
    expect(store.all()).toEqual([]);
    now = T0;
    store.remove("AB".repeat(32));
    expect(store.all()).toEqual([]);
  });
});
