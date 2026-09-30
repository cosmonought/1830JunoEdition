// frontend/src/money/moneyTestSupport.ts
//
// ESCROW-4 test support (imported by tests only): a pinned deployment, RoomMoneyView builders for every stage, a fake
// wallet that records what it was asked to sign, in-memory keys and pending records, and a fake session port that
// answers the money routes from a script. Nothing here touches Keplr, IndexedDB or the network.

// Route v12 R12-2 moved the rules engine to 12 (R12-3 certified it for settlement): this page's rules are the engine's.
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { Secp256k1, sha256 } from "@cosmjs/crypto";
import { toHex } from "@cosmjs/encoding";

import type { RoomMoneyView, MoneyYouView } from "../utils/moneyProtocol";
import type { SessionApiAnswer, SessionApiBody, SessionApiPath, SessionPort } from "../utils/sessionBootstrap";
import { createConsentKeys, memoryConsentKeyVault, type ConsentKeys } from "./consentKeys";
import type { PinnedEscrowDeployment } from "./escrowDeployment";
import type { BroadcastOutcome, ConnectedWallet, SignedWalletTx, TxStatus, WalletPort, WalletResult } from "./keplrWallet";
import type { MoneyServices } from "./moneySession";
import { createPendingTxStore, type KeyValueStorage } from "./pendingTx";
import type { ChainGameFacts, WalletMessage } from "./walletChecks";

export const TEST_CONTRACT = "juno14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9skjuwg8";
export const TEST_WALLET = "juno12gdmst084pz888ds7g80nv27p9wadknwdl783a";
export const OTHER_WALLET = "juno1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a";
export const TICKET = "ab".repeat(32);
export const T0 = Date.UTC(2026, 8, 28, 20, 0, 0);

export const TEST_PIN: PinnedEscrowDeployment = Object.freeze({
  backend: "juno-cosmwasm",
  chainId: "uni-7",
  networkClass: "testnet",
  contract: TEST_CONTRACT,
  codeChecksum: "5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8",
  denom: "ujunox",
  symbol: "JUNOX",
  exponent: 6,
  rpc: "https://rpc.uni.example",
  rest: "https://api.uni.example",
  chainName: "Juno testnet",
  gasPrice: "0.075",
  explorerTx: null,
});

export function you(over: Partial<MoneyYouView> = {}): MoneyYouView {
  return { playerId: "p-me", link: null, funding: "none", chainSeatIndex: null, payoutWallet: null, chainConsentKey: null, unlinkedDeposit: null, admissionUntil: null, pending: null, actions: ["link-wallet"], ...over };
}

export function linked(consentKeys: string[] = [], over: Partial<MoneyYouView> = {}): MoneyYouView {
  return you({ link: { wallet: TEST_WALLET, epoch: 1, ticket: TICKET, linkedAt: T0, consentKeys }, funding: "linked", ...over });
}

type ViewOver = Partial<Omit<RoomMoneyView, "terms" | "escrow" | "start">> & { terms?: Partial<RoomMoneyView["terms"]>; escrow?: Partial<RoomMoneyView["escrow"]>; start?: Partial<RoomMoneyView["start"]> };

export function moneyView(over: ViewOver = {}): RoomMoneyView {
  const { terms, escrow, start, ...rest } = over;
  return {
    deployment: { backend: "juno-cosmwasm", chainId: TEST_PIN.chainId, networkClass: "testnet", contract: TEST_CONTRACT, codeChecksum: TEST_PIN.codeChecksum, denom: "ujunox", symbol: "JUNOX", exponent: 6 },
    terms: { anteGross: "1000000", feeBps: 100, anteNet: null, pot: null, mode: "live", seats: 2, minAnte: "1000", rulesEngineVersion: RULES_ENGINE_VERSION, ...terms },
    escrow: { chainGameId: null, state: "unbound", paused: false, fundingDeadline: null, observedAt: T0, fundedSeats: 0, foreignSeats: 0, fullyFundedAt: null, ...escrow },
    seats: [
      { playerId: "p-me", funding: "none" },
      { playerId: "p-other", funding: "none" },
    ],
    start: { state: "not-ready", blocker: "escrow-not-open", anyoneMayStartAt: null, canStart: false, epoch: 0, ...start },
    settlement: null,
    you: you(),
    held: false,
    ...rest,
  };
}

/** A fixed secp256k1 key (tests only). */
export async function testKey(label: string): Promise<{ privkey: Uint8Array; pubkey: string; sign(digestHex: string): Promise<string> }> {
  const privkey = sha256(new TextEncoder().encode(`18COSMOS/TEST/frontend/${label}`));
  const keypair = await Secp256k1.makeKeypair(privkey);
  const pubkey = toHex(Secp256k1.compressPubkey(keypair.pubkey));
  return {
    privkey,
    pubkey,
    async sign(digestHex) {
      const bytes = Uint8Array.from(digestHex.match(/../g)!.map((pair) => parseInt(pair, 16)));
      const signature = await Secp256k1.createSignature(bytes, privkey);
      /* r then s, each padded to 32 bytes, as `consentKeys.ts` signs (never re-wrapped in `Secp256k1Signature`). */
      return toHex(signature.r(32)) + toHex(signature.s(32));
    },
  };
}

/** The key of the fixed signing vectors below (`testKey(LEADING_ZERO_KEY)`). */
export const LEADING_ZERO_KEY = "consent-leading-zero";

/**
 * Fixed CONSENT and ANNUL signing vectors for `testKey(LEADING_ZERO_KEY)`, found once offline (owner broad gate,
 * ESCROW-4 report §21). Each digest has an ordinary signature, one whose 32-byte r begins with 0x00, and one whose
 * 32-byte s does. `new Secp256k1Signature(r(32), s(32))` refused the last two outright. RFC 6979 makes these the same
 * bytes on every run, and the server's own signer (`server/src/escrow/juno/secp256k1.ts`) produces them too.
 */
export const LEADING_ZERO_VECTORS = {
  consent: {
    domain: "aa".repeat(32),
    settleDigest: "cc".repeat(32),
    ordinary: { seq: 1, signature: "f3d8b79feeb93463052a908c7dc9dfd8f114137051c0522f6f8f92425b7e012361a691da450580193063f1e4bbc0f2e60e5f469c829235a94e11b90107d92cb4" },
    rLeadingZero: { seq: 56, signature: "00c5b838a64de5cf19a47649b8e1b220745f387335e0842d66b832ca4468360032b43404b5d3d61f93fa63919145ff5795a40be87860c5bc525b5b0d96bfb9fa" },
    sLeadingZero: { seq: 52, signature: "d005606d9f63a6f9db41b0ed1527812d7539cb8c9a91edc133519f54e3b3d57400a309429c0042d9d3de486cc715ee9cea35e8c8fb03e991d32bb2fcb6566729" },
  },
  annul: {
    domain: "bb".repeat(32),
    ordinary: { seq: 1, signature: "51d3f27498698acb4d57937696ce538208cd33bec1bea7d857dc55d49c2a37023e69e6ffd69d03884fd3057e578008bc643c6967b871cfb7902b6b0e5c84e002" },
    rLeadingZero: { seq: 533, signature: "00fe2f2343240a930d7fd8a651164b7a238d17a30f17263b674a03ccb38ed338175114f6bf98e209dc675931d76aeeece18f20dbcfea63a70635fb1fa1630a56" },
    sLeadingZero: { seq: 226, signature: "f94efff1d058b45846168e26fcce801923335b9520252032d31cba3a79534bbc0062829a96efc586961949e0e7d5e39b01854258cf25a954cc698692ce07026e" },
  },
} as const;

/* ------------------------------------------------------------------ */
/* A fake wallet: records every request; answers from a small script   */
/* ------------------------------------------------------------------ */

export interface FakeWallet extends WalletPort {
  readonly calls: string[];
  readonly signed: WalletMessage[];
  readonly broadcasts: Uint8Array[];
  address: string | null;
  present: boolean;
  broadcastAnswer: BroadcastOutcome;
  status: TxStatus;
  game: ChainGameFacts | null;
  config: { paused: boolean; minAnte: string | null; admissionPubkey: string | null };
  deployment: WalletResult<true>;
  /** Called just before a broadcast (a test checks the pending record is already kept). */
  onBroadcast?: () => void;
  linkAnswer: WalletResult<{ pubKey: string; signature: string }>;
}

export function fakeWallet(): FakeWallet {
  const wallet: FakeWallet = {
    calls: [],
    signed: [],
    broadcasts: [],
    address: TEST_WALLET,
    present: true,
    broadcastAnswer: { kind: "accepted" },
    status: { kind: "pending" },
    game: null,
    config: { paused: false, minAnte: "1000", admissionPubkey: null },
    deployment: { ok: true, value: true },
    linkAnswer: { ok: true, value: { pubKey: "Ai1R5vzeZFvF73ROli+IbV7OuNG7bM6HeI0rthBGJzvf", signature: "c2ln" } },
    available: () => wallet.present,
    ready: async () => wallet.present,
    async connect() {
      wallet.calls.push("connect");
      return account();
    },
    async account() {
      wallet.calls.push("account");
      return account();
    },
    async signLink(_pin, signer, text) {
      wallet.calls.push(`signLink:${signer}:${text.split("\n")[0]}`);
      return wallet.linkAnswer;
    },
    async signTx(_pin, signer, message): Promise<WalletResult<SignedWalletTx>> {
      wallet.calls.push(`signTx:${signer}:${message.kind}`);
      wallet.signed.push(message);
      const bytes = new TextEncoder().encode(`${message.msgJson}|${JSON.stringify(message.funds)}|${wallet.signed.length}`);
      return { ok: true, value: { txHash: toHex(sha256(bytes)).toUpperCase(), txBytes: bytes, timeoutHeight: BigInt(1100) } };
    },
    async broadcast(_pin, bytes) {
      wallet.calls.push("broadcast");
      wallet.onBroadcast?.();
      wallet.broadcasts.push(bytes);
      return wallet.broadcastAnswer;
    },
    async txStatus() {
      wallet.calls.push("txStatus");
      return wallet.status;
    },
    async chainGame(_pin, chainGameId) {
      wallet.calls.push(`chainGame:${chainGameId}`);
      return wallet.game === null ? { ok: false, code: "rpc-unreachable", reason: "Juno couldn't be reached from this browser just now, so nothing was sent." } : { ok: true, value: wallet.game };
    },
    async chainConfig() {
      wallet.calls.push("chainConfig");
      return { ok: true, value: wallet.config };
    },
    async verifyDeployment() {
      wallet.calls.push("verifyDeployment");
      return wallet.deployment;
    },
    onAccountChange: () => () => undefined,
  };
  function account(): WalletResult<ConnectedWallet> {
    if (!wallet.present) return { ok: false, code: "not-installed", reason: "Keplr isn't available in this browser." };
    if (wallet.address === null) return { ok: false, code: "no-account", reason: "Keplr isn't connected to Juno on this page yet." };
    return { ok: true, value: { address: wallet.address, name: "test", isLedger: false } };
  }
  return wallet;
}

export function memoryStorage(): KeyValueStorage & { map: Map<string, string>; failWrites: boolean } {
  const map = new Map<string, string>();
  const storage = {
    map,
    failWrites: false,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.failWrites) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
  return storage;
}

export function testServices(over: { wallet?: FakeWallet; keys?: ConsentKeys; storage?: KeyValueStorage; now?: () => number; pinned?: boolean } = {}): MoneyServices & { wallet: FakeWallet } {
  const wallet = over.wallet ?? fakeWallet();
  const storage = over.storage ?? memoryStorage();
  const now = over.now ?? (() => T0);
  return {
    wallet,
    keys: over.keys ?? createConsentKeys(memoryConsentKeyVault(), now),
    pending: createPendingTxStore(() => storage, now),
    pin: () => (over.pinned === false ? { ok: false, reason: "This build has no Juno escrow configured, so real-money actions can't be signed here." } : { ok: true, pin: TEST_PIN }),
    now,
  };
}

/* ------------------------------------------------------------------ */
/* A fake session port answering the money routes from a script         */
/* ------------------------------------------------------------------ */

export interface ScriptedPort extends SessionPort {
  readonly requests: Array<{ path: SessionApiPath; body: SessionApiBody }>;
  answer(path: SessionApiPath, status: number, body: Record<string, unknown> | ((request: SessionApiBody) => Record<string, unknown>)): void;
}

export function scriptedPort(): ScriptedPort {
  const requests: Array<{ path: SessionApiPath; body: SessionApiBody }> = [];
  const script = new Map<string, Array<{ status: number; body: Record<string, unknown> | ((request: SessionApiBody) => Record<string, unknown>) }>>();
  return {
    state: "ready",
    refreshable: true,
    endedReason: null,
    account: { name: "Brad", otherSessions: 0 },
    ensure: async () => "ready",
    startFresh: async () => "ready",
    subscribe: () => () => undefined,
    requests,
    answer(path, status, body) {
      script.set(path, [...(script.get(path) ?? []), { status, body }]);
    },
    async api(path, body): Promise<SessionApiAnswer> {
      requests.push({ path, body });
      const next = script.get(path)?.shift();
      if (next === undefined) return { kind: "network" };
      return { kind: "answered", status: next.status, body: typeof next.body === "function" ? next.body(body) : next.body };
    },
  };
}
