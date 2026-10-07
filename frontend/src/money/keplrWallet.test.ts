// frontend/src/money/keplrWallet.test.ts
//
// ==================================================================
//  JX-3B (C-1): THE KEPLR ADAPTER ITSELF -- `createKeplrWallet` OVER A FAKE `window.keplr`
// ==================================================================
//
// Every other money suite drives a fake `WalletPort`, so the adapter's own mapping (connect, the chain suggestion, the
// account checks, ADR-036 signing and its failures, the keystore-change subscription) was covered by review only. Here
// a scripted `window.keplr` answers as Keplr does; no real wallet, extension or network is touched. The successful
// signature is a real secp256k1 ADR-036 signature, and the adapter's answer is verified independently (cosmjs's
// secp256k1 over the ADR-036 sign doc, whose bytes `moneyCrypto.test.ts` pins to cosmjs's and the server rebuilds); the
// server-side verification of the same answer runs end to end in `server/src/tools/jx3bEvidence.test.ts`.

import { addressOfPublicKey } from "../../../server/src/escrow/juno/cosmosTx";
import { publicKeyOf, signDigest } from "../../../server/src/escrow/juno/secp256k1";
import { Secp256k1, Secp256k1Signature, sha256 } from "@cosmjs/crypto";
import { fromBase64, toHex } from "@cosmjs/encoding";
import { createHash } from "crypto";

import { adr036SignDocJson, walletLinkChallengeText } from "../gameEngine/escrow/walletLinkChallengeV1";
import { chainInfoFor, createKeplrWallet, keplrProvider, type KeplrProvider } from "./keplrWallet";
import { T0, TEST_CONTRACT, TEST_PIN } from "./moneyTestSupport";

/** A Keplr account: a deterministic secp256k1 key, its `juno` address, and ADR-036 signing exactly as `signArbitrary`. */
function account(label: string) {
  const secret = createHash("sha256").update(`18COSMOS/JX3B/keplr/${label}`).digest();
  const pubkey = publicKeyOf(secret);
  const address = addressOfPublicKey(pubkey, "juno");
  return {
    address,
    pubKeyBase64: pubkey.toString("base64"),
    signArbitrary(signer: string, text: string) {
      const digest = createHash("sha256").update(Buffer.from(adr036SignDocJson(signer, text), "utf8")).digest();
      return { pub_key: { type: "tendermint/PubKeySecp256k1", value: pubkey.toString("base64") }, signature: signDigest(secret, digest).toString("base64") };
    },
  };
}

const K1 = account("k1");
const K2 = account("k2");

type Call = readonly [string, ...unknown[]];

/** A scripted `window.keplr` on an EventTarget window (what the adapter subscribes `keplr_keystorechange` on). */
function fakeKeplr(script: {
  suggest?: (info: unknown) => Promise<void>;
  enable?: (chainId: string) => Promise<void>;
  getKey?: (chainId: string) => Promise<{ name: string; bech32Address: string; isNanoLedger?: boolean }>;
  signArbitrary?: ((chainId: string, signer: string, data: string) => Promise<{ pub_key: { type?: string; value: string }; signature: string }>) | null;
  noSuggest?: boolean;
}) {
  const calls: Call[] = [];
  let current = K1.address;
  const keplr: KeplrProvider = {
    enable: async (chainId) => {
      calls.push(["enable", chainId]);
      if (script.enable !== undefined) await script.enable(chainId);
    },
    getKey: async (chainId) => {
      calls.push(["getKey", chainId]);
      return script.getKey !== undefined ? script.getKey(chainId) : { name: "Test account", bech32Address: current };
    },
    ...(script.noSuggest
      ? {}
      : {
          experimentalSuggestChain: async (info: unknown) => {
            calls.push(["suggest", info]);
            if (script.suggest !== undefined) await script.suggest(info);
          },
        }),
    ...(script.signArbitrary === null
      ? {}
      : {
          signArbitrary: async (chainId: string, signer: string, data: string) => {
            calls.push(["signArbitrary", chainId, signer, data]);
            const scripted = script.signArbitrary;
            if (scripted !== undefined && scripted !== null) return scripted(chainId, signer, data);
            return (signer === K1.address ? K1 : K2).signArbitrary(signer, data);
          },
        }),
  };
  const win = Object.assign(new EventTarget(), { keplr });
  return {
    win,
    calls,
    names: () => calls.map((call) => call[0]),
    /** The player switches Keplr's account (Keplr then fires `keplr_keystorechange`). */
    switchTo(address: string) {
      current = address;
      win.dispatchEvent(new Event("keplr_keystorechange"));
    },
  };
}

const challenge = (wallet: string) =>
  walletLinkChallengeText({ appName: "Project 18XX", site: "https://play.example", chainId: TEST_PIN.chainId, contract: TEST_CONTRACT, gameId: "g_000000000000000000000000jx", playerId: "p-0000000000000001", wallet, nonce: "0123456789abcdef0123456789abcdef", expiresAt: T0 + 5 * 60_000 });

describe("JX-3B C-1: createKeplrWallet -- connect", () => {
  test("1. a non-mainnet pin is suggested to Keplr (the pinned chain info), then enabled, then the account is read", async () => {
    const fake = fakeKeplr({});
    const wallet = createKeplrWallet(fake.win);
    expect(wallet.available()).toBe(true);
    const connected = await wallet.connect(TEST_PIN);
    expect(connected).toEqual({ ok: true, value: { address: K1.address, name: "Test account", isLedger: false } });
    expect(fake.names()).toEqual(["suggest", "enable", "getKey"]);
    const info = fake.calls[0][1] as Record<string, unknown>;
    expect(info).toEqual(chainInfoFor(TEST_PIN));
    expect(info.chainId).toBe("uni-7");
    expect(info.rpc).toBe(TEST_PIN.rpc);
    expect(info.rest).toBe(TEST_PIN.rest);
    expect(info.bip44).toEqual({ coinType: 118 });
    expect((info.bech32Config as Record<string, string>).bech32PrefixAccAddr).toBe("juno");
    expect(fake.calls[1]).toEqual(["enable", "uni-7"]);
    /* Mainnet's juno-1 is built into Keplr: never suggested. */
    const mainnet = fakeKeplr({});
    expect((await createKeplrWallet(mainnet.win).connect({ ...TEST_PIN, chainId: "juno-1" })).ok).toBe(true);
    expect(mainnet.names()).toEqual(["enable", "getKey"]);
    /* A Keplr without the suggestion API: enabled directly. */
    const old = fakeKeplr({ noSuggest: true });
    expect((await createKeplrWallet(old.win).connect(TEST_PIN)).ok).toBe(true);
    expect(old.names()).toEqual(["enable", "getKey"]);
  });

  test("2. the chain suggestion refused: chain-refused, and nothing is enabled", async () => {
    const declined = fakeKeplr({ suggest: async () => Promise.reject(new Error("Request rejected")) });
    expect(await createKeplrWallet(declined.win).connect(TEST_PIN)).toEqual({ ok: false, code: "chain-refused", reason: "Add Juno testnet (uni-7) in Keplr to continue." });
    expect(declined.names()).toEqual(["suggest"]);
    const broken = fakeKeplr({ suggest: async () => Promise.reject(new Error("Invalid chain info: rpc")) });
    const answer = await createKeplrWallet(broken.win).connect(TEST_PIN);
    expect(answer.ok === false && answer.code).toBe("chain-refused");
    expect(answer.ok === false && answer.reason).toMatch(/couldn't add Juno testnet \(uni-7\): Invalid chain info/);
    expect(broken.names()).toEqual(["suggest"]);
  });

  test("3. enable rejected: rejected (declined) or chain-refused (any other failure); the account is not read", async () => {
    const declined = fakeKeplr({ enable: async () => Promise.reject(new Error("User denied the request")) });
    expect(await createKeplrWallet(declined.win).connect(TEST_PIN)).toEqual({ ok: false, code: "rejected", reason: "Keplr didn't connect. Nothing was shared." });
    expect(declined.names()).toEqual(["suggest", "enable"]);
    const locked = fakeKeplr({ enable: async () => Promise.reject(new Error("There is no chain info for uni-7")) });
    const answer = await createKeplrWallet(locked.win).connect(TEST_PIN);
    expect(answer.ok === false && answer.code).toBe("chain-refused");
    expect(answer.ok === false && answer.reason).toMatch(/couldn't connect to Juno testnet: There is no chain info/);
  });

  test("4. getKey: only a canonical juno1 account is accepted; a declined read is rejected; Ledger is recorded (display only)", async () => {
    const bad = ["cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu", K1.address.toUpperCase(), `${K1.address}x`, "juno1short", "", 42];
    for (const bech32Address of bad) {
      const fake = fakeKeplr({ getKey: async () => ({ name: "x", bech32Address: bech32Address as string }) });
      expect([String(bech32Address), await createKeplrWallet(fake.win).account(TEST_PIN)]).toEqual([String(bech32Address), { ok: false, code: "no-account", reason: "Keplr has no Juno account to use." }]);
    }
    const declined = fakeKeplr({ getKey: async () => Promise.reject(new Error("Request rejected")) });
    expect((await createKeplrWallet(declined.win).account(TEST_PIN)).ok === false && (await createKeplrWallet(declined.win).account(TEST_PIN) as { code: string }).code).toBe("rejected");
    const notEnabled = fakeKeplr({ getKey: async () => Promise.reject(new Error("key doesn't exist")) });
    expect(await createKeplrWallet(notEnabled.win).account(TEST_PIN)).toEqual({ ok: false, code: "no-account", reason: "Keplr isn't connected to Juno on this page yet." });
    const ledger = fakeKeplr({ getKey: async () => ({ name: "Nano", bech32Address: K1.address, isNanoLedger: true }) });
    expect(await createKeplrWallet(ledger.win).account(TEST_PIN)).toEqual({ ok: true, value: { address: K1.address, name: "Nano", isLedger: true } });
    /* No Keplr at all (or an object that is not Keplr): not installed, and nothing is asked. */
    expect(keplrProvider({ keplr: { enable: () => undefined } })).toBeNull();
    const none = createKeplrWallet({});
    expect(none.available()).toBe(false);
    expect((await none.connect(TEST_PIN)).ok === false && ((await none.connect(TEST_PIN)) as { code: string }).code).toBe("not-installed");
    expect(((await none.signLink(TEST_PIN, K1.address, challenge(K1.address))) as { code: string }).code).toBe("not-installed");
  });
});

describe("JX-3B C-1: createKeplrWallet -- the ADR-036 link signature", () => {
  test("5. a Keplr without signArbitrary is unsupported (nothing else is asked)", async () => {
    const fake = fakeKeplr({ signArbitrary: null });
    expect(await createKeplrWallet(fake.win).signLink(TEST_PIN, K1.address, challenge(K1.address))).toEqual({ ok: false, code: "unsupported", reason: "This Keplr can't sign a message (only transactions), so it can't link a wallet here." });
    expect(fake.names()).toEqual([]);
  });

  test("6. the player declines the link message: rejected, with the sentence the panel shows", async () => {
    for (const message of ["Request rejected", "User denied", "Signing cancelled", "user declined"]) {
      const fake = fakeKeplr({ signArbitrary: async () => Promise.reject(new Error(message)) });
      expect([message, await createKeplrWallet(fake.win).signLink(TEST_PIN, K1.address, challenge(K1.address))]).toEqual([message, { ok: false, code: "rejected", reason: "You declined the link message. Your wallet isn't linked." }]);
    }
  });

  test("7. the account is re-read before signing: Keplr switched to another account -> wrong-account, nothing signed", async () => {
    const fake = fakeKeplr({});
    const wallet = createKeplrWallet(fake.win);
    fake.switchTo(K2.address);
    const answer = await wallet.signLink(TEST_PIN, K1.address, challenge(K1.address));
    expect(answer).toEqual({ ok: false, code: "wrong-account", reason: `Switch Keplr to ${K1.address} to sign this action. (Keplr is on ${K2.address}.)` });
    expect(fake.names()).toEqual(["getKey"]);
    expect(fake.names()).not.toContain("signArbitrary");
  });

  test("8. Keplr answers with a key that derives ANOTHER address: wrong-account (never passed on); a non-key is unknown", async () => {
    const swapped = fakeKeplr({ signArbitrary: async (_chain, _signer, data) => K2.signArbitrary(K1.address, data) });
    expect(await createKeplrWallet(swapped.win).signLink(TEST_PIN, K1.address, challenge(K1.address))).toEqual({ ok: false, code: "wrong-account", reason: "Keplr signed with another account than the one being linked. Your wallet isn't linked." });
    const garbage = fakeKeplr({ signArbitrary: async () => ({ pub_key: { value: "bm90IGEga2V5" }, signature: "c2ln" }) });
    expect(((await createKeplrWallet(garbage.win).signLink(TEST_PIN, K1.address, challenge(K1.address))) as { code: string }).code).toBe("unknown");
    const empty = fakeKeplr({ signArbitrary: async () => ({}) as never });
    expect(await createKeplrWallet(empty.win).signLink(TEST_PIN, K1.address, challenge(K1.address))).toEqual({ ok: false, code: "unknown", reason: "Keplr's answer wasn't a signature. Your wallet isn't linked." });
  });

  test("9. the successful path: signArbitrary(pinned chain, seat wallet, the exact text); the answer is a valid ADR-036 signature by the seat wallet over exactly that text", async () => {
    const fake = fakeKeplr({});
    const text = challenge(K1.address);
    const answer = await createKeplrWallet(fake.win).signLink(TEST_PIN, K1.address, text);
    if (!answer.ok) throw new Error(answer.reason);
    expect(fake.names()).toEqual(["getKey", "signArbitrary"]);
    expect(fake.calls[1]).toEqual(["signArbitrary", "uni-7", K1.address, text]);
    expect(answer.value.pubKey).toBe(K1.pubKeyBase64);
    const signature = Secp256k1Signature.fromFixedLength(fromBase64(answer.value.signature));
    const signDoc = (signer: string, over: string) => sha256(Buffer.from(adr036SignDocJson(signer, over), "utf8"));
    expect(await Secp256k1.verifySignature(signature, signDoc(K1.address, text), fromBase64(answer.value.pubKey))).toBe(true);
    expect(addressOfPublicKey(Buffer.from(fromBase64(answer.value.pubKey)), "juno")).toBe(K1.address);
    expect(toHex(fromBase64(answer.value.pubKey))).toHaveLength(66);
    /* The same signature over any other text does not verify (the server rebuilds the sign doc from ITS text). */
    expect(await Secp256k1.verifySignature(signature, signDoc(K1.address, challenge(K2.address)), fromBase64(answer.value.pubKey))).toBe(false);
  });

  test("10. keplr_keystorechange: the listener fires on an account switch, the next read is the new account, unsubscribe stops it", async () => {
    const fake = fakeKeplr({});
    const wallet = createKeplrWallet(fake.win);
    const seen: number[] = [];
    const stop = wallet.onAccountChange(() => seen.push(seen.length + 1));
    expect(((await wallet.account(TEST_PIN)) as { value: { address: string } }).value.address).toBe(K1.address);
    fake.switchTo(K2.address);
    expect(seen).toEqual([1]);
    expect(((await wallet.account(TEST_PIN)) as { value: { address: string } }).value.address).toBe(K2.address);
    /* Signing for the seat's K1 is now refused until the player switches back. */
    expect(((await wallet.signLink(TEST_PIN, K1.address, challenge(K1.address))) as { code: string }).code).toBe("wrong-account");
    stop();
    fake.switchTo(K1.address);
    expect(seen).toEqual([1]);
    expect((await wallet.signLink(TEST_PIN, K1.address, challenge(K1.address))).ok).toBe(true);
    /* A window without events: a no-op subscription, never a throw. */
    expect(() => createKeplrWallet({ keplr: fake.win.keplr }).onAccountChange(() => undefined)()).not.toThrow();
  });

  test("11. a Ledger (or any 'not supported') signArbitrary failure maps to unsupported; a decline still reads as rejected; anything else is unknown", async () => {
    const cases: Array<[string, string]> = [
      ["Ledger: signing arbitrary data is not supported", "unsupported"],
      ["Ledger device: unknown instruction", "unsupported"],
      ["This feature is not supported for this key type", "unsupported"],
      ["Ledger: transaction rejected by the user", "rejected"],
      ["Internal error 0x6985", "unknown"],
    ];
    for (const [message, code] of cases) {
      const fake = fakeKeplr({ signArbitrary: async () => Promise.reject(new Error(message)) });
      const answer = await createKeplrWallet(fake.win).signLink(TEST_PIN, K1.address, challenge(K1.address));
      expect([message, answer.ok === false && answer.code]).toEqual([message, code]);
      if (code !== "rejected") expect(answer.ok === false && answer.reason).toMatch(/Your wallet isn't linked\.$/);
    }
  });
});
