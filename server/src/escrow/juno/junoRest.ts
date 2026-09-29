// server/src/escrow/juno/junoRest.ts
//
// ==================================================================
//  ESCROW-3B: THE ONE NARROW DOOR TO A JUNO NODE -- COSMOS REST (gRPC-GATEWAY), CONFIGURED ENDPOINTS, FAIL CLOSED
// ==================================================================
//
// Every chain read and every broadcast the server makes goes through `JunoRest`. Nothing else in the server builds a
// URL, parses a node's JSON or decides what a node's silence means. The capabilities are exactly what the relayer and
// the reconciliation need:
//
//   network        node_info (its chain id), the latest block (height, time, chain id), whether it is syncing
//   account        account number and sequence (the AUTHORITATIVE sequence: never trusted from memory)
//   deployment     contract info (code id, admin) and the code's checksum (read from the chain, never configured)
//   contract       smart queries (the escrow's own answers)
//   transactions   simulate (bounded gas), broadcast (SYNC: the CheckTx answer only), lookup by hash, and lookup by
//                  the ante handler's `tx.acc_seq` event (who used a given account sequence -- the death proof's
//                  "consumed by" when an index has it)
//
// ENDPOINT POLICY. Endpoints come from configuration only (nothing public is hard-coded). A base URL must be https --
// http only for an explicitly local development node -- with no credentials, query or fragment. Redirects are an
// error (a node that redirects is not the node configured; no downgrade can follow one). Each request has a timeout
// and a response-size cap; a body that is not the expected JSON is `malformed`, never a guess. Every block read checks
// the chain id: a node for another network answers `wrong-chain`, and nothing built from it is used.
//
// FAILURE VOCABULARY. `unavailable` (connection refused/reset, 5xx, timeout) and `malformed` are TRANSPORT facts: they
// say nothing about whether a transaction landed, so callers treat them as "unknown" and look again later. `not-found`
// is a node's answer about ITS view (a pruned or unindexed node says it too), never a proof of death.

import { createHash } from "crypto";

/** A contract instance as the chain describes it (never as configuration claims it). */
export interface JunoContractFacts {
  readonly address: string;
  readonly code_id: string;
  readonly admin: string | null;
  readonly creator: string;
  readonly label: string;
}

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly text: string;
  /** The height the node answered at, when it says (`x-cosmos-block-height`). */
  readonly height?: string | null;
}

/** One HTTP exchange. Rejects on a network failure, a timeout, a redirect or an oversize body. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export type JunoRpcFailure = "unavailable" | "timeout" | "malformed" | "wrong-chain" | "refused" | "too-large";

export class JunoRpcError extends Error {
  constructor(
    readonly kind: JunoRpcFailure,
    message: string,
    readonly endpoint: string | null = null,
  ) {
    super(message);
    this.name = "JunoRpcError";
  }
}

/** The production HTTP transport: global `fetch`, no redirects, an abort timer, and a streamed size cap. */
export function fetchTransport(): HttpTransport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: request.method,
          redirect: "error",
          signal: controller.signal,
          headers: request.body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
          ...(request.body !== undefined ? { body: request.body } : {}),
        });
      } catch (error) {
        if (controller.signal.aborted) throw new JunoRpcError("timeout", `no answer within ${request.timeoutMs} ms`);
        throw new JunoRpcError("unavailable", `the request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > request.maxBytes) throw new JunoRpcError("too-large", `the answer declares ${declared} bytes (cap ${request.maxBytes})`);
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader !== undefined) {
        for (;;) {
          let read: { done: boolean; value?: Uint8Array };
          try {
            read = await reader.read();
          } catch (error) {
            if (controller.signal.aborted) throw new JunoRpcError("timeout", `the answer did not finish within ${request.timeoutMs} ms`);
            throw new JunoRpcError("unavailable", `the answer was cut off: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (read.done) break;
          size += read.value?.length ?? 0;
          if (size > request.maxBytes) {
            controller.abort();
            throw new JunoRpcError("too-large", `the answer exceeds ${request.maxBytes} bytes`);
          }
          if (read.value !== undefined) chunks.push(read.value);
        }
      }
      const heightHeader = response.headers.get("x-cosmos-block-height") ?? response.headers.get("grpc-metadata-x-cosmos-block-height");
      return { status: response.status, text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), height: heightHeader !== null && /^[0-9]{1,20}$/.test(heightHeader) ? heightHeader : null };
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface JunoEndpointPolicy {
  /** REST base URLs, tried in order for reads; broadcast goes to the first that answers. */
  readonly endpoints: readonly string[];
  readonly expectedChainId: string;
  /** Development only: allow `http://` for a loopback node. */
  readonly allowInsecureLocalHttp: boolean;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** The code download fallback (a wasm is ~0.5 MB; base64 ~0.7 MB). */
  readonly maxCodeBytes: number;
}

export const DEFAULT_ENDPOINT_LIMITS = Object.freeze({ timeoutMs: 10_000, maxResponseBytes: 256 * 1024, maxCodeBytes: 4 * 1024 * 1024 });

/** Refuses a base URL the policy does not allow; returns it normalised (no trailing slash). */
export function checkEndpoint(raw: string, allowInsecureLocalHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JunoRpcError("refused", `endpoint ${JSON.stringify(raw)} is not a URL`);
  }
  if (url.username !== "" || url.password !== "") throw new JunoRpcError("refused", "an endpoint may not carry credentials in its URL");
  if (url.search !== "" || url.hash !== "") throw new JunoRpcError("refused", "an endpoint base URL has no query or fragment");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !(allowInsecureLocalHttp && loopback)) throw new JunoRpcError("refused", `endpoint ${url.origin} is not https (plain http is allowed only for a loopback development node)`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new JunoRpcError("refused", `endpoint scheme ${url.protocol} is not allowed`);
  return url.toString().replace(/\/+$/, "");
}

export interface AccountView {
  /** The height the answering node read it at, when the node says. */
  readonly height: string | null;
  readonly address: string;
  readonly account_number: string;
  readonly sequence: string;
  /** The account's registered public key (hex), or null before its first transaction. */
  readonly pub_key: string | null;
}

export interface BlockView {
  readonly chain_id: string;
  readonly height: string;
  /** RFC 3339 block time. */
  readonly time: string;
}

export interface TxResultView {
  readonly txhash: string;
  readonly height: string;
  readonly code: number;
  readonly codespace: string;
  readonly raw_log: string;
}

export type SimulateResult = { readonly ok: true; readonly gas_used: string } | { readonly ok: false; readonly code: number; readonly log: string };

export interface JunoRest {
  readonly chainId: string;
  nodeChainId(): Promise<string>;
  latestBlock(): Promise<BlockView>;
  syncing(): Promise<boolean>;
  account(address: string): Promise<AccountView | null>;
  contract(address: string): Promise<JunoContractFacts>;
  codeChecksum(codeId: string): Promise<string>;
  smart(contract: string, queryJson: string): Promise<unknown>;
  /** A smart query and the height the answering node read it at (null when the node does not say). */
  smartAt(contract: string, queryJson: string): Promise<{ readonly data: unknown; readonly height: string | null }>;
  /** ESCROW-4: the same smart query from every configured endpoint, agreeing (two or more when two or more are
   *  configured), or `unavailable`. Optional for test doubles (callers fall back to `smart`). */
  smartQuorum?(contract: string, queryJson: string): Promise<unknown>;
  /** Every configured endpoint's own chain id (each asked separately; null when it did not answer). An endpoint that
   *  answers for another network is never used for anything (reads, simulation or broadcast). */
  endpointChains(): Promise<ReadonlyArray<{ readonly endpoint: string; readonly chain_id: string | null; readonly error: string | null }>>;
  /** LIVE-4 (L4-4): a VERIFICATION-GRADE read of one contract's chain-attested facts -- the code checksum behind its
   *  code id, and its config query's answer (the caller takes the denom from it). EVERY configured endpoint must answer,
   *  each on the configured chain and not syncing, and two or more must agree exactly; anything less is `unavailable`,
   *  never one failover answer. The continuation verdict concludes a deployment CONFLICT (a durable hold) only from
   *  facts read this way. Optional for test doubles (absent: no verification-grade fact is ever read). */
  verifiedContractFacts?(contract: string, configQueryJson: string): Promise<{ readonly code_checksum: string; readonly config: unknown }>;
  simulate(txBytes: Uint8Array): Promise<SimulateResult>;
  /** SYNC broadcast: the CheckTx answer (code 0 = accepted into the mempool), never inclusion. */
  broadcast(txBytes: Uint8Array): Promise<TxResultView>;
  /** The transaction by hash, or null when THIS node does not have it (never proof it does not exist). */
  tx(hash: string): Promise<TxResultView | null>;
  /** Transactions that used `address/sequence` (the ante handler's `tx.acc_seq` event), or null when the node has no
   *  index for it. */
  txsBySequence(address: string, sequence: string): Promise<readonly TxResultView[] | null>;
}

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const DEC = /^(0|[1-9][0-9]{0,19})$/;

export function createJunoRest(policy: JunoEndpointPolicy, http: HttpTransport = fetchTransport()): JunoRest {
  if (policy.endpoints.length === 0) throw new JunoRpcError("refused", "no Juno endpoint is configured");
  const endpoints = policy.endpoints.map((endpoint) => checkEndpoint(endpoint, policy.allowInsecureLocalHttp));
  if (new Set(endpoints).size !== endpoints.length) throw new JunoRpcError("refused", "an endpoint is configured twice");
  /** Logs, errors and status name an endpoint by its origin only (a provider's key can sit in a URL path). */
  const shown = (base: string): string => {
    const url = new URL(base);
    return url.pathname === "/" || url.pathname === "" ? url.origin : `${url.origin}/…`;
  };
  /** Each endpoint's chain id, asked of THAT endpoint once (a failure to answer is not cached; another chain is). */
  const endpointChain = new Map<string, string>();

  async function call(base: string, method: "GET" | "POST", path: string, body?: unknown, maxBytes = policy.maxResponseBytes): Promise<{ status: number; json: unknown; height: string | null }> {
    let response: HttpResponse;
    try {
      response = await http({ method, url: `${base}${path}`, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), timeoutMs: policy.timeoutMs, maxBytes });
    } catch (error) {
      if (error instanceof JunoRpcError) throw new JunoRpcError(error.kind, error.message, shown(base));
      throw new JunoRpcError("unavailable", error instanceof Error ? error.message : String(error), shown(base));
    }
    if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) throw new JunoRpcError("unavailable", `HTTP ${response.status}`, shown(base));
    let json: unknown;
    try {
      json = JSON.parse(response.text);
    } catch {
      if (response.status >= 500) throw new JunoRpcError("unavailable", `HTTP ${response.status}`, shown(base));
      throw new JunoRpcError("malformed", `HTTP ${response.status} with a body that is not JSON`, shown(base));
    }
    const height = response.height ?? null;
    return { status: response.status, json, height: height !== null && DEC.test(height) ? height : null };
  }

  async function nodeInfoOf(base: string): Promise<string> {
    const { json } = await call(base, "GET", "/cosmos/base/tendermint/v1beta1/node_info");
    const network = isObject(json) && isObject(json.default_node_info) ? json.default_node_info.network : undefined;
    if (typeof network !== "string") return malformed("node_info", base);
    return network;
  }

  /** ESCROW-3B review #11: an endpoint is used only after IT said it is on the configured chain. */
  async function verifiedChain(base: string): Promise<void> {
    let chain = endpointChain.get(base);
    if (chain === undefined) {
      chain = await nodeInfoOf(base);
      endpointChain.set(base, chain);
    }
    if (chain !== policy.expectedChainId) throw new JunoRpcError("wrong-chain", `the endpoint is on ${chain}, not ${policy.expectedChainId}`, shown(base));
  }

  /** A read, tried on each endpoint in order until one answers (a transport failure moves on; an answer stops). An
   *  endpoint on another chain is skipped; if every endpoint is, the answer is `wrong-chain`. */
  async function read<T>(label: string, run: (base: string) => Promise<T>): Promise<T> {
    let last: unknown = null;
    for (const base of endpoints) {
      try {
        await verifiedChain(base);
        return await run(base);
      } catch (error) {
        if (error instanceof JunoRpcError && (error.kind === "unavailable" || error.kind === "timeout" || error.kind === "malformed" || error.kind === "too-large" || error.kind === "wrong-chain")) {
          last = error;
          continue;
        }
        throw error;
      }
    }
    throw last instanceof JunoRpcError ? last : new JunoRpcError("unavailable", `${label}: no endpoint answered`);
  }

  const malformed = (what: string, base: string): never => {
    throw new JunoRpcError("malformed", `${what}: the node's answer is not the expected shape`, shown(base));
  };

  /** ESCROW-3B review #7: a result without a numeric code (or, for an INCLUDED transaction, without a positive height)
   *  is malformed -- never a default that reads as success. */
  const txResult = (value: unknown, base: string, included: boolean): TxResultView => {
    if (!isObject(value) || typeof value.txhash !== "string" || !/^[0-9A-F]{64}$/.test(value.txhash)) return malformed("tx_response", base);
    if (typeof value.code !== "number" || !Number.isSafeInteger(value.code) || value.code < 0) return malformed("tx_response.code", base);
    const height = typeof value.height === "string" && DEC.test(value.height) ? value.height : null;
    if (included && (height === null || height === "0")) return malformed("tx_response.height", base);
    return { txhash: value.txhash, height: height ?? "0", code: value.code, codespace: typeof value.codespace === "string" ? value.codespace : "", raw_log: typeof value.raw_log === "string" ? value.raw_log.slice(0, 4096) : "" };
  };

  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

  /** The checksum of `codeId`'s wasm as ONE endpoint serves it: wasmd's code-info first; else the code itself, hashed
   *  HERE (never only its label). */
  async function checksumAt(base: string, codeId: string): Promise<string> {
    const small = await call(base, "GET", `/cosmwasm/wasm/v1/code-info/${codeId}`).catch(() => null);
    if (small !== null && small.status === 200 && isObject(small.json) && typeof small.json.checksum === "string") {
      const hex = small.json.checksum.startsWith("0x") ? small.json.checksum.slice(2) : /^[0-9a-fA-F]{64}$/.test(small.json.checksum) ? small.json.checksum : Buffer.from(small.json.checksum, "base64").toString("hex");
      if (/^[0-9a-fA-F]{64}$/.test(hex)) return hex.toLowerCase();
    }
    const { status, json } = await call(base, "GET", `/cosmwasm/wasm/v1/code/${codeId}`, undefined, policy.maxCodeBytes);
    if (status !== 200 || !isObject(json) || !isObject(json.code_info) || typeof json.data !== "string") return malformed("code", base);
    const data = Buffer.from(json.data, "base64");
    const computed = createHash("sha256").update(data).digest("hex");
    const declared = typeof json.code_info.data_hash === "string" ? json.code_info.data_hash.toLowerCase() : "";
    if (declared !== "" && declared !== computed) throw new JunoRpcError("malformed", "the node's code hash does not match the code it served", shown(base));
    return computed;
  }

  /** LIVE-4 (L4-4): ONE endpoint's full verification-grade answer, or why it cannot give one. Its chain id is asked
   *  afresh (never the cache), then whether it is syncing, then the contract's code id, its code's checksum and the
   *  config query -- all from this endpoint alone. */
  async function contractFactsAt(base: string, contract: string, configQueryJson: string): Promise<{ readonly ok: true; readonly text: string; readonly code_checksum: string; readonly config: unknown } | { readonly ok: false; readonly why: string }> {
    try {
      const chain = await nodeInfoOf(base);
      endpointChain.set(base, chain);
      if (chain !== policy.expectedChainId) return { ok: false, why: `${shown(base)} is on ${chain}` };
      const syncing = (await call(base, "GET", "/cosmos/base/tendermint/v1beta1/syncing")).json;
      if (!isObject(syncing) || typeof syncing.syncing !== "boolean") return { ok: false, why: `${shown(base)}: no syncing answer` };
      if (syncing.syncing) return { ok: false, why: `${shown(base)} is still syncing` };
      const info = await call(base, "GET", `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}`);
      if (info.status !== 200 || !isObject(info.json) || info.json.address !== contract || !isObject(info.json.contract_info)) return { ok: false, why: `${shown(base)}: no contract info` };
      const codeId = info.json.contract_info.code_id;
      if (typeof codeId !== "string" || !DEC.test(codeId)) return { ok: false, why: `${shown(base)}: no code id` };
      const codeChecksum = await checksumAt(base, codeId);
      const smart = await call(base, "GET", `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/smart/${b64(Buffer.from(configQueryJson, "utf8"))}`);
      if (smart.status !== 200 || !isObject(smart.json) || !("data" in smart.json)) return { ok: false, why: `${shown(base)}: no config answer` };
      return { ok: true, text: JSON.stringify({ code_id: codeId, code_checksum: codeChecksum, config: smart.json.data }), code_checksum: codeChecksum, config: smart.json.data };
    } catch (error) {
      return { ok: false, why: error instanceof Error ? error.message.slice(0, 200) : String(error) };
    }
  }

  async function smartAt(contract: string, queryJson: string): Promise<{ readonly data: unknown; readonly height: string | null }> {
    return read("smart query", async (base) => {
      const { status, json, height } = await call(base, "GET", `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/smart/${b64(Buffer.from(queryJson, "utf8"))}`);
      if (status !== 200 || !isObject(json) || !("data" in json)) {
        const message = isObject(json) && typeof json.message === "string" ? json.message : `HTTP ${status}`;
        if (status >= 500 || status === 429) throw new JunoRpcError("unavailable", `smart query: ${message.slice(0, 300)}`, shown(base));
        throw new JunoRpcError("refused", `smart query refused: ${message.slice(0, 300)}`, shown(base));
      }
      return { data: json.data, height };
    });
  }

  return {
    chainId: policy.expectedChainId,
    async nodeChainId() {
      return read("node_info", (base) => nodeInfoOf(base));
    },
    async endpointChains() {
      const out: Array<{ endpoint: string; chain_id: string | null; error: string | null }> = [];
      for (const base of endpoints) {
        try {
          const chain = await nodeInfoOf(base);
          endpointChain.set(base, chain);
          out.push({ endpoint: shown(base), chain_id: chain, error: null });
        } catch (error) {
          out.push({ endpoint: shown(base), chain_id: null, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        }
      }
      return out;
    },
    async latestBlock() {
      return read("latest block", async (base) => {
        const { json } = await call(base, "GET", "/cosmos/base/tendermint/v1beta1/blocks/latest");
        const block = isObject(json) ? (isObject(json.sdk_block) ? json.sdk_block : json.block) : undefined;
        const header = isObject(block) ? block.header : undefined;
        if (!isObject(header) || typeof header.chain_id !== "string" || typeof header.height !== "string" || !DEC.test(header.height) || typeof header.time !== "string") return malformed("latest block", base);
        if (header.chain_id !== policy.expectedChainId) throw new JunoRpcError("wrong-chain", `the node is on ${header.chain_id}, not ${policy.expectedChainId}`, shown(base));
        return { chain_id: header.chain_id, height: header.height, time: header.time };
      });
    },
    async syncing() {
      return read("syncing", async (base) => {
        const { json } = await call(base, "GET", "/cosmos/base/tendermint/v1beta1/syncing");
        if (!isObject(json) || typeof json.syncing !== "boolean") return malformed("syncing", base);
        return json.syncing;
      });
    },
    async account(address) {
      return read("account", async (base) => {
        const { status, json, height } = await call(base, "GET", `/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`);
        if (status === 404 || (isObject(json) && json.code === 5)) return null;
        const account = isObject(json) ? json.account : undefined;
        if (!isObject(account)) return malformed("account", base);
        /* A BaseAccount, or one nested in a vesting/module wrapper's `base_account`. */
        const baseAccount = isObject(account.base_account) ? account.base_account : isObject(account.base_vesting_account) && isObject(account.base_vesting_account.base_account) ? account.base_vesting_account.base_account : account;
        const number = baseAccount.account_number;
        const sequence = baseAccount.sequence;
        if (baseAccount.address !== address || typeof number !== "string" || !DEC.test(number) || typeof sequence !== "string" || !DEC.test(sequence)) return malformed("account", base);
        let pubKey: string | null = null;
        if (isObject(baseAccount.pub_key)) {
          const key = baseAccount.pub_key.key;
          if (baseAccount.pub_key["@type"] !== "/cosmos.crypto.secp256k1.PubKey" || typeof key !== "string") return malformed("account.pub_key", base);
          pubKey = Buffer.from(key, "base64").toString("hex");
        }
        return { height, address, account_number: number, sequence, pub_key: pubKey };
      });
    },
    async contract(address) {
      return read("contract info", async (base) => {
        const { status, json } = await call(base, "GET", `/cosmwasm/wasm/v1/contract/${encodeURIComponent(address)}`);
        if (status !== 200 || !isObject(json) || json.address !== address || !isObject(json.contract_info)) return malformed("contract info", base);
        const info = json.contract_info;
        if (typeof info.code_id !== "string" || !DEC.test(info.code_id)) return malformed("contract info", base);
        return { address, code_id: info.code_id, admin: typeof info.admin === "string" && info.admin !== "" ? info.admin : null, creator: typeof info.creator === "string" ? info.creator : "", label: typeof info.label === "string" ? info.label : "" };
      });
    },
    async codeChecksum(codeId) {
      if (!DEC.test(codeId)) throw new JunoRpcError("refused", "code id");
      return read("code checksum", (base) => checksumAt(base, codeId));
    },
    async smart(contract, queryJson) {
      return (await smartAt(contract, queryJson)).data;
    },
    smartAt,
    /* ESCROW-4: a smart query asked of EVERY configured endpoint (each only after it said it is on the configured chain).
       One endpoint configured: its answer. Two or more: at least two must answer and every answer must be the same
       JSON -- a disagreement (a lagging node, a lying one) is `unavailable`: "unknown, look again", never a guess. The
       money layer's write-once decisions (binding a host's CreateGame) and its funding reads go through this. */
    async smartQuorum(contract, queryJson) {
      if (endpoints.length === 1) return (await smartAt(contract, queryJson)).data;
      const answers: string[] = [];
      let data: unknown = null;
      await Promise.all(
        endpoints.map(async (base) => {
          try {
            await verifiedChain(base);
            const { status, json } = await call(base, "GET", `/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/smart/${b64(Buffer.from(queryJson, "utf8"))}`);
            if (status === 200 && isObject(json) && "data" in json) {
              answers.push(JSON.stringify(json.data));
              data = json.data;
            }
          } catch {
            /* an endpoint that does not answer does not vote */
          }
        }),
      );
      if (answers.length < 2) throw new JunoRpcError("unavailable", `quorum read: ${answers.length} of ${endpoints.length} endpoints answered (2 needed)`);
      if (answers.some((answer) => answer !== answers[0])) throw new JunoRpcError("unavailable", "quorum read: the endpoints disagree (a lagging or inconsistent node); read again later");
      return data;
    },
    /* LIVE-4 (L4-4): the verification-grade read (see the interface). Every endpoint, in parallel; all must answer. */
    async verifiedContractFacts(contract, configQueryJson) {
      const answers = await Promise.all(endpoints.map((base) => contractFactsAt(base, contract, configQueryJson)));
      const failed = answers.filter((answer): answer is { readonly ok: false; readonly why: string } => !answer.ok);
      if (failed.length > 0) {
        throw new JunoRpcError("unavailable", `verification-grade read: ${answers.length - failed.length} of ${answers.length} endpoints answered on ${policy.expectedChainId}, not syncing (${failed.map((answer) => answer.why).join("; ").slice(0, 400)})`);
      }
      const agreed = answers as ReadonlyArray<{ readonly ok: true; readonly text: string; readonly code_checksum: string; readonly config: unknown }>;
      if (agreed.some((answer) => answer.text !== agreed[0].text)) throw new JunoRpcError("unavailable", "verification-grade read: the endpoints disagree about the contract (a lagging or inconsistent node); read again later");
      return { code_checksum: agreed[0].code_checksum, config: agreed[0].config };
    },
    async simulate(txBytes) {
      return read("simulate", async (base) => {
        const { status, json } = await call(base, "POST", "/cosmos/tx/v1beta1/simulate", { tx_bytes: b64(txBytes) });
        if (status === 200 && isObject(json) && isObject(json.gas_info) && typeof json.gas_info.gas_used === "string" && DEC.test(json.gas_info.gas_used)) {
          return { ok: true as const, gas_used: json.gas_info.gas_used };
        }
        if (isObject(json) && typeof json.message === "string" && (status === 400 || status === 500)) {
          return { ok: false as const, code: typeof json.code === "number" ? json.code : -1, log: json.message.slice(0, 4096) };
        }
        return malformed("simulate", base);
      });
    },
    async broadcast(txBytes) {
      return read("broadcast", async (base) => {
        const { json } = await call(base, "POST", "/cosmos/tx/v1beta1/txs", { tx_bytes: b64(txBytes), mode: "BROADCAST_MODE_SYNC" });
        if (!isObject(json) || !isObject(json.tx_response)) return malformed("broadcast", base);
        return txResult(json.tx_response, base, false);
      });
    },
    async tx(hash) {
      if (!/^[0-9A-F]{64}$/.test(hash)) throw new JunoRpcError("refused", "a tx hash is 64 upper-case hex");
      return read("tx", async (base) => {
        const { status, json } = await call(base, "GET", `/cosmos/tx/v1beta1/txs/${hash}`);
        if (status === 404 || (isObject(json) && (json.code === 5 || (typeof json.message === "string" && /not found/i.test(json.message))))) return null;
        if (!isObject(json) || !isObject(json.tx_response)) return malformed("tx", base);
        const result = txResult(json.tx_response, base, true);
        if (result.txhash !== hash) return malformed("tx (another hash)", base);
        return result;
      });
    },
    async txsBySequence(address, sequence) {
      if (!DEC.test(sequence)) throw new JunoRpcError("refused", "sequence");
      return read("txs by sequence", async (base) => {
        const event = encodeURIComponent(`tx.acc_seq='${address}/${sequence}'`);
        for (const param of ["query", "events"]) {
          const { status, json } = await call(base, "GET", `/cosmos/tx/v1beta1/txs?${param}=${event}&pagination.limit=5`);
          if (status === 200 && isObject(json) && Array.isArray(json.tx_responses)) return json.tx_responses.map((entry) => txResult(entry, base, true));
        }
        return null;
      });
    },
  };
}
