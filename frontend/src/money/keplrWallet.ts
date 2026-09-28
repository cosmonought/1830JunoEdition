// frontend/src/money/keplrWallet.ts
//
// ==================================================================
//  ESCROW-4: THE KEPLR ADAPTER -- THE MINIMUM A MONEY SEAT NEEDS, WITH EXPLICIT STATES, AND NOTHING SERVER-MADE SIGNED
// ==================================================================
//
// Keplr only: the browser extension, and the Keplr app's in-app browser where it injects the same `window.keplr`. No
// wallet framework. What a money seat needs, and nothing else:
//
//   detect     is `window.keplr` here (after the page's load, when Keplr injects)?
//   connect    suggest the PINNED chain to Keplr (not needed for mainnet's `juno-1`), `enable` it, read the account;
//   link       ADR-036 `signArbitrary` over the server's challenge text -- after `walletChecks.checkLinkChallenge` has
//              read it -- and a check that the key Keplr answers with IS the account's (`pubkeyToAddress`);
//   transact   build the `MsgExecuteContract` from the EXACT execute JSON this browser made (`walletChecks.ts`),
//              simulate for gas, sign with a `timeout_height` (a signed transaction that has not landed by then never
//              can), and hand back the SIGNED BYTES and their hash -- the caller keeps them (`pendingTx.ts`) before it
//              calls `broadcast`. The execute JSON goes in as bytes, so its u64 integers are signed exactly as built.
//   observe    the chain's own answers: a transaction by hash, the height, the table's escrow game, the contract's
//              configuration, and the deployment itself (the chain id, and the contract's code checksum against the
//              pin) -- all read through the PINNED RPC, never through the game server.
//
// Every failure is a code and a sentence (`WalletFailure`); nothing here throws to a caller. The account Keplr is on is
// re-read before every signature: if the player switched accounts, nothing is signed for the wrong wallet.

import { pubkeyToAddress } from "@cosmjs/amino";
import { CosmWasmClient, SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { sha256 } from "@cosmjs/crypto";
import { toBase64, toHex, toUtf8 } from "@cosmjs/encoding";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import { BroadcastTxError, calculateFee, GasPrice } from "@cosmjs/stargate";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import type { PinnedEscrowDeployment } from "./escrowDeployment";
import { chainGameFactsOf, type ChainGameFacts, type WalletMessage } from "./walletChecks";

export type WalletErrorCode =
  | "not-installed"
  | "rejected"
  | "chain-refused"
  | "wrong-network"
  | "wrong-account"
  | "no-account"
  | "unsupported"
  | "rpc-unreachable"
  | "deployment-mismatch"
  | "insufficient-funds"
  | "contract-refused"
  | "unknown";

export interface WalletFailure {
  readonly ok: false;
  readonly code: WalletErrorCode;
  readonly reason: string;
}
export type WalletResult<T> = { readonly ok: true; readonly value: T } | WalletFailure;
const fail = (code: WalletErrorCode, reason: string): WalletFailure => ({ ok: false, code, reason });

export interface ConnectedWallet {
  readonly address: string;
  /** Keplr's account name (display only). */
  readonly name: string;
  readonly isLedger: boolean;
}

export interface SignedWalletTx {
  /** Upper-case hex SHA-256 of `txBytes`. */
  readonly txHash: string;
  readonly txBytes: Uint8Array;
  /** The last block that may include it. */
  readonly timeoutHeight: bigint;
}

export type BroadcastOutcome =
  | { readonly kind: "accepted" }
  /** The network refused it outright (it can never land, e.g. fees or sequence): nothing moved. */
  | { readonly kind: "refused"; readonly reason: string }
  /** No answer: it may or may not land. Keep the record; the chain will say. */
  | { readonly kind: "unknown" };

export type TxStatus =
  | { readonly kind: "included"; readonly ok: boolean; readonly log: string | null }
  | { readonly kind: "pending" }
  /** The chain is past the transaction's timeout height without it: it can never land. */
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" };

/** What a money seat asks of a wallet (Keplr in the browser; a fake in a test). */
export interface WalletPort {
  /** Whether Keplr is present in this browser. */
  available(): boolean;
  /** Wait (briefly) for Keplr to inject on a page that is still loading. */
  ready(): Promise<boolean>;
  connect(pin: PinnedEscrowDeployment): Promise<WalletResult<ConnectedWallet>>;
  /** The account Keplr is on now (no prompt once enabled). */
  account(pin: PinnedEscrowDeployment): Promise<WalletResult<ConnectedWallet>>;
  signLink(pin: PinnedEscrowDeployment, wallet: string, text: string): Promise<WalletResult<{ readonly pubKey: string; readonly signature: string }>>;
  signTx(pin: PinnedEscrowDeployment, wallet: string, message: WalletMessage, memo: string): Promise<WalletResult<SignedWalletTx>>;
  broadcast(pin: PinnedEscrowDeployment, txBytes: Uint8Array): Promise<BroadcastOutcome>;
  txStatus(pin: PinnedEscrowDeployment, txHash: string, timeoutHeight: string): Promise<TxStatus>;
  chainGame(pin: PinnedEscrowDeployment, chainGameId: string): Promise<WalletResult<ChainGameFacts>>;
  /** The escrow's configuration as Juno itself says it (through the pinned endpoint): paused, the minimum ante, and the
   *  join-admission key the contract verifies Join against (review S-L2: never the server's word for it). */
  chainConfig(pin: PinnedEscrowDeployment): Promise<WalletResult<{ readonly paused: boolean; readonly minAnte: string | null; readonly admissionPubkey: string | null }>>;
  /** The chain is the pinned chain and the contract runs the pinned code (checked once per page). */
  verifyDeployment(pin: PinnedEscrowDeployment): Promise<WalletResult<true>>;
  /** Keplr switched accounts (or locked): the listener re-reads the account. */
  onAccountChange(listener: () => void): () => void;
}

/** How long a signed transaction may wait to be included (blocks; about ten minutes at Juno's ~6 s blocks). */
export const TX_TIMEOUT_BLOCKS = 100;

/* ------------------------------------------------------------------ */
/* Keplr's provider, typed loosely here (no new dependency)            */
/* ------------------------------------------------------------------ */

interface KeplrKey {
  readonly name: string;
  readonly bech32Address: string;
  readonly isNanoLedger?: boolean;
}

export interface KeplrProvider {
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<KeplrKey>;
  signArbitrary?(chainId: string, signer: string, data: string): Promise<{ readonly pub_key: { readonly type?: string; readonly value: string }; readonly signature: string }>;
  experimentalSuggestChain?(info: unknown): Promise<void>;
  getOfflineSignerAuto?(chainId: string): Promise<OfflineSigner>;
  getOfflineSigner?(chainId: string): OfflineSigner;
}

/** `window.keplr`, if Keplr injected it (read loosely: the legacy wallet context declares its own narrower type). */
export function keplrProvider(win: unknown = typeof window === "undefined" ? undefined : window): KeplrProvider | null {
  const candidate = (win as { keplr?: unknown } | undefined)?.keplr;
  if (typeof candidate !== "object" || candidate === null) return null;
  const k = candidate as Partial<KeplrProvider>;
  return typeof k.enable === "function" && typeof k.getKey === "function" ? (candidate as KeplrProvider) : null;
}

/** Keplr's chain description for the pinned deployment (what `experimentalSuggestChain` adds to Keplr). */
export function chainInfoFor(pin: PinnedEscrowDeployment): Record<string, unknown> {
  /* Keplr's fee UI takes numbers here; it never enters any amount this app computes (fees are `GasPrice` decimals). */
  const price = Number(pin.gasPrice);
  const currency = { coinDenom: pin.symbol, coinMinimalDenom: pin.denom, coinDecimals: pin.exponent };
  return {
    chainId: pin.chainId,
    chainName: pin.chainName,
    rpc: pin.rpc,
    rest: pin.rest,
    bip44: { coinType: 118 },
    bech32Config: {
      bech32PrefixAccAddr: "juno",
      bech32PrefixAccPub: "junopub",
      bech32PrefixValAddr: "junovaloper",
      bech32PrefixValPub: "junovaloperpub",
      bech32PrefixConsAddr: "junovalcons",
      bech32PrefixConsPub: "junovalconspub",
    },
    currencies: [currency],
    feeCurrencies: [{ ...currency, gasPriceStep: { low: price, average: price, high: price * 2 } }],
    stakeCurrency: currency,
    features: ["cosmwasm"],
  };
}

const rejectedText = (error: unknown): boolean => /reject|denied|cancel|declin/i.test(error instanceof Error ? error.message : String(error));
const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 160);
};

/** The chain's words for a refused simulation or transaction, as one of our codes. */
export function classifyChainError(error: unknown): WalletFailure {
  const text = messageOf(error);
  if (/insufficient funds|insufficient fee|does not exist on chain|account .* not found/i.test(text)) {
    return fail("insufficient-funds", "Your wallet doesn't have enough JUNO for this (the deposit plus the network fee). Nothing was sent.");
  }
  if (/execute wasm contract failed|contract error|Generic error|codespace wasm/i.test(text)) {
    return fail("contract-refused", `The escrow contract refused it (${text}). Nothing was sent.`);
  }
  if (/fetch|network|ECONN|timed out|timeout|Failed to fetch|socket/i.test(text)) {
    return fail("rpc-unreachable", "Juno couldn't be reached from this browser just now. Nothing was sent; try again in a moment.");
  }
  return fail("unknown", `Keplr stopped without finishing (it said: '${text}'). Nothing was sent.`);
}

export function createKeplrWallet(win: unknown = typeof window === "undefined" ? undefined : window): WalletPort {
  const verified = new Set<string>();
  const provider = () => keplrProvider(win);
  const queryClients = new Map<string, Promise<CosmWasmClient>>();
  const readClient = (pin: PinnedEscrowDeployment): Promise<CosmWasmClient> => {
    let client = queryClients.get(pin.rpc);
    if (client === undefined) {
      client = CosmWasmClient.connect(pin.rpc).catch((error) => {
        queryClients.delete(pin.rpc);
        throw error;
      });
      queryClients.set(pin.rpc, client);
    }
    return client;
  };

  async function account(pin: PinnedEscrowDeployment): Promise<WalletResult<ConnectedWallet>> {
    const keplr = provider();
    if (keplr === null) return fail("not-installed", "Keplr isn't available in this browser.");
    try {
      const key = await keplr.getKey(pin.chainId);
      if (typeof key?.bech32Address !== "string" || !/^juno1[02-9ac-hj-np-z]{38}$/.test(key.bech32Address)) return fail("no-account", "Keplr has no Juno account to use.");
      return { ok: true, value: { address: key.bech32Address, name: typeof key.name === "string" ? key.name : "", isLedger: key.isNanoLedger === true } };
    } catch (error) {
      return rejectedText(error) ? fail("rejected", "Keplr didn't share your account. Nothing was shared.") : fail("no-account", "Keplr isn't connected to Juno on this page yet.");
    }
  }

  async function sameAccount(pin: PinnedEscrowDeployment, wallet: string): Promise<WalletFailure | null> {
    const now = await account(pin);
    if (!now.ok) return now;
    if (now.value.address !== wallet) return fail("wrong-account", `Keplr is on ${now.value.address}, but this seat uses ${wallet}. Switch accounts in Keplr to continue.`);
    return null;
  }

  return {
    available: () => provider() !== null,
    async ready() {
      if (provider() !== null) return true;
      const w = win as { document?: Document; addEventListener?: Window["addEventListener"]; removeEventListener?: Window["removeEventListener"] } | undefined;
      if (w?.document === undefined || w.document.readyState === "complete" || typeof w.addEventListener !== "function") return provider() !== null;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        w.addEventListener?.("load", done, { once: true });
        setTimeout(done, 3_000);
      });
      return provider() !== null;
    },
    async connect(pin) {
      const keplr = provider();
      if (keplr === null) return fail("not-installed", "Keplr isn't available in this browser. You can keep playing here; deposits need Keplr (the desktop extension or the Keplr app's browser).");
      if (pin.chainId !== "juno-1" && typeof keplr.experimentalSuggestChain === "function") {
        try {
          await keplr.experimentalSuggestChain(chainInfoFor(pin));
        } catch (error) {
          return fail("chain-refused", rejectedText(error) ? `Add ${pin.chainName} (${pin.chainId}) in Keplr to continue.` : `Keplr couldn't add ${pin.chainName} (${pin.chainId}): ${messageOf(error)}`);
        }
      }
      try {
        await keplr.enable(pin.chainId);
      } catch (error) {
        return fail(rejectedText(error) ? "rejected" : "chain-refused", rejectedText(error) ? "Keplr didn't connect. Nothing was shared." : `Keplr couldn't connect to ${pin.chainName}: ${messageOf(error)}`);
      }
      return account(pin);
    },
    account,
    async signLink(pin, wallet, text) {
      const keplr = provider();
      if (keplr === null) return fail("not-installed", "Keplr isn't available in this browser.");
      if (typeof keplr.signArbitrary !== "function") return fail("unsupported", "This Keplr can't sign a message (only transactions), so it can't link a wallet here.");
      const wrong = await sameAccount(pin, wallet);
      if (wrong !== null) return wrong;
      let signed: Awaited<ReturnType<NonNullable<KeplrProvider["signArbitrary"]>>>;
      try {
        signed = await keplr.signArbitrary(pin.chainId, wallet, text);
      } catch (error) {
        if (rejectedText(error)) return fail("rejected", "You declined the link message. Your wallet isn't linked.");
        return fail(/ledger|not support/i.test(messageOf(error)) ? "unsupported" : "unknown", `Keplr couldn't sign the link message (it said: '${messageOf(error)}'). Your wallet isn't linked.`);
      }
      const pubKey = signed?.pub_key?.value;
      if (typeof pubKey !== "string" || typeof signed?.signature !== "string") return fail("unknown", "Keplr's answer wasn't a signature. Your wallet isn't linked.");
      try {
        if (pubkeyToAddress({ type: "tendermint/PubKeySecp256k1", value: pubKey }, "juno") !== wallet) return fail("wrong-account", "Keplr signed with another account than the one being linked. Your wallet isn't linked.");
      } catch {
        return fail("unknown", "Keplr's key wasn't a Juno key. Your wallet isn't linked.");
      }
      return { ok: true, value: { pubKey, signature: signed.signature } };
    },
    async signTx(pin, wallet, message, memo) {
      const keplr = provider();
      if (keplr === null) return fail("not-installed", "Keplr isn't available in this browser.");
      const wrong = await sameAccount(pin, wallet);
      if (wrong !== null) return wrong;
      let signer: OfflineSigner;
      try {
        signer = typeof keplr.getOfflineSignerAuto === "function" ? await keplr.getOfflineSignerAuto(pin.chainId) : (keplr.getOfflineSigner as (chainId: string) => OfflineSigner)(pin.chainId);
      } catch (error) {
        return fail("unsupported", `Keplr couldn't sign for ${pin.chainName} here (${messageOf(error)}).`);
      }
      let client: SigningCosmWasmClient;
      const gasPrice = GasPrice.fromString(`${pin.gasPrice}${pin.denom}`);
      try {
        client = await SigningCosmWasmClient.connectWithSigner(pin.rpc, signer, { gasPrice });
        if ((await client.getChainId()) !== pin.chainId) return fail("wrong-network", `This site's Juno connection isn't on ${pin.chainName}, so nothing was sent.`);
      } catch {
        return fail("rpc-unreachable", "Juno couldn't be reached from this browser just now. Nothing was sent; try again in a moment.");
      }
      const encoded = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({ sender: wallet, contract: pin.contract, msg: toUtf8(message.msgJson), funds: message.funds.map((coin) => ({ denom: coin.denom, amount: coin.amount })) }),
      };
      let gasUsed: number;
      let height: number;
      try {
        gasUsed = await client.simulate(wallet, [encoded], memo);
        height = await client.getHeight();
      } catch (error) {
        return classifyChainError(error);
      }
      /* Gas units (never money): a 40% margin over the simulation, in integers. */
      const gasLimit = Math.floor((Math.max(1, Math.floor(gasUsed)) * 14) / 10) + 1;
      const fee = calculateFee(gasLimit, gasPrice);
      const timeoutHeight = BigInt(height + TX_TIMEOUT_BLOCKS);
      let raw: TxRaw;
      try {
        raw = await client.sign(wallet, [encoded], fee, memo, undefined, timeoutHeight);
      } catch (error) {
        if (rejectedText(error)) return fail("rejected", "You declined in Keplr. No JUNO was sent.");
        return classifyChainError(error);
      }
      const txBytes = TxRaw.encode(raw).finish();
      return { ok: true, value: { txHash: toHex(sha256(txBytes)).toUpperCase(), txBytes, timeoutHeight } };
    },
    async broadcast(pin, txBytes) {
      let client: CosmWasmClient;
      try {
        client = await readClient(pin);
      } catch {
        return { kind: "unknown" };
      }
      try {
        await client.broadcastTxSync(txBytes);
        return { kind: "accepted" };
      } catch (error) {
        if (error instanceof BroadcastTxError) {
          /* Already in the mempool or already committed: it is on its way (or there). */
          if (error.code === 19 || /already in (mempool|cache)|tx already exists/i.test(error.log ?? "")) return { kind: "accepted" };
          return { kind: "refused", reason: classifyChainError(new Error(error.log ?? `code ${error.code}`)).reason };
        }
        return { kind: "unknown" };
      }
    },
    async txStatus(pin, txHash, timeoutHeight) {
      try {
        const client = await readClient(pin);
        const found = await client.getTx(txHash);
        if (found !== null) return { kind: "included", ok: found.code === 0, log: found.code === 0 ? null : (found.rawLog ?? null) };
        const height = await client.getHeight();
        return BigInt(height) > BigInt(timeoutHeight) ? { kind: "expired" } : { kind: "pending" };
      } catch {
        return { kind: "unknown" };
      }
    },
    async chainGame(pin, chainGameId) {
      const id = Number(chainGameId);
      if (!/^[1-9][0-9]{0,15}$/.test(chainGameId) || !Number.isSafeInteger(id)) return fail("unknown", "That escrow game id can't be read.");
      try {
        const facts = chainGameFactsOf(await (await readClient(pin)).queryContractSmart(pin.contract, { game: { chain_game_id: id } }));
        return facts === null ? fail("unknown", "Juno's answer about this table's escrow wasn't understood, so nothing was sent.") : { ok: true, value: facts };
      } catch {
        return fail("rpc-unreachable", "Juno couldn't be reached from this browser just now, so nothing was sent. Try again in a moment.");
      }
    },
    async chainConfig(pin) {
      try {
        const raw = (await (await readClient(pin)).queryContractSmart(pin.contract, { config: {} })) as { config?: { paused?: unknown; params?: { min_ante?: unknown }; admission_pubkey?: unknown } };
        const paused = raw?.config?.paused;
        if (typeof paused !== "boolean") return fail("unknown", "Juno's escrow configuration wasn't understood, so nothing was sent.");
        const minAnte = raw?.config?.params?.min_ante;
        const admission = raw?.config?.admission_pubkey;
        const admissionPubkey = typeof admission === "string" && /^0[23][0-9a-fA-F]{64}$/.test(admission) ? admission.toLowerCase() : null;
        return { ok: true, value: { paused, minAnte: typeof minAnte === "string" && /^[0-9]{1,40}$/.test(minAnte) ? minAnte : null, admissionPubkey } };
      } catch {
        return fail("rpc-unreachable", "Juno couldn't be reached from this browser just now, so nothing was sent. Try again in a moment.");
      }
    },
    async verifyDeployment(pin) {
      const key = `${pin.chainId}|${pin.contract}|${pin.codeChecksum}`;
      if (verified.has(key)) return { ok: true, value: true };
      try {
        const client = await readClient(pin);
        if ((await client.getChainId()) !== pin.chainId) return fail("wrong-network", `This site's Juno connection isn't on ${pin.chainName}, so nothing will be signed.`);
        const contract = await client.getContract(pin.contract);
        const code = await client.getCodeDetails(contract.codeId);
        if (code.checksum.toLowerCase() !== pin.codeChecksum) return fail("deployment-mismatch", "The escrow contract on Juno isn't the code this app was built for, so nothing will be signed.");
      } catch {
        return fail("rpc-unreachable", "Juno couldn't be reached from this browser to check the escrow. Nothing was signed; try again in a moment.");
      }
      verified.add(key);
      return { ok: true, value: true };
    },
    onAccountChange(listener) {
      const w = win as { addEventListener?: Window["addEventListener"]; removeEventListener?: Window["removeEventListener"] } | undefined;
      if (typeof w?.addEventListener !== "function") return () => undefined;
      w.addEventListener("keplr_keystorechange", listener);
      return () => w.removeEventListener?.("keplr_keystorechange", listener);
    },
  };
}

/** Base64 of signed bytes, for the pending record (and the bytes back, for a re-send). */
export const txBytesToBase64 = (bytes: Uint8Array): string => toBase64(bytes);
