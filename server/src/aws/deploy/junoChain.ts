// server/src/aws/deploy/junoChain.ts
//
// ==================================================================
//  LIVE-6 RELAYER ROTATION: THE DEPLOY TOOLS' READ-ONLY VIEW OF THE ESCROW CONTRACT ON CHAIN -- WHO MAY CHANGE ITS
//  OPERATOR, WHO ITS OPERATOR IS, AND WHETHER A NEW RELAYER ACCOUNT IS FUNDED
// ==================================================================
//
// The relayer address is the escrow contract's OPERATOR (`Config.operator`): the only account that may `Start` a game
// (`contracts/escrow/src/execute/play.rs`). Changing it is `ExecuteMsg::SetOperator { operator }`
// (`contracts/escrow/src/execute/admin.rs` `set_operator`), guarded by `admin_guard`: the sender must be `Config.admin`
// and the message must carry no funds. Neither relayer key can sign it -- the relayer is the operator, not the admin --
// and nothing in this repository holds or invents the admin's key: the admin signs with its own wallet, outside it.
//
// What this module does, and ONLY this (every call a read; nothing is signed, broadcast or written):
//   - `contractControl`   the contract's `config` query (the server's own `parseConfigResponse`): admin, operator,
//                         paused, name and version;
//   - `setOperatorMessage` the exact message the admin must send (printed, never signed here);
//   - `relayerFunding`    a conservative floor for a NEW relayer account's balance, from the configuration's own gas policy
//                         (integers only);
//   - `deploymentIdentityOf` the deployment a rotation must leave untouched, from a parsed configuration;
//   - `productionJunoChain` the REST binding (`createJunoRest` over the configured endpoints, plus the bank balance read).

import type { JunoBackendConfig, SignerRef } from "../../escrow/juno/junoConfig";
import { parseConfigResponse, QUERY } from "../../escrow/juno/junoContract";
import { checkEndpoint, createJunoRest, DEFAULT_ENDPOINT_LIMITS, fetchTransport, JunoRpcError, type HttpTransport, type JunoRest } from "../../escrow/juno/junoRest";
import type { RotationDeploymentIdentity } from "./gateRecords";

/** How the deploy tools reach the chain (production: `productionJunoChain`; tests: an offline fake). Reads only. */
export interface JunoChainReader {
  /** A REST client over the configuration's own endpoints, pinned to its chain id. */
  rest(config: JunoBackendConfig): JunoRest;
  /** `address`'s balance in the configuration's denomination (base units; 0 when it holds none). Throws when no
   *  configured endpoint on the configured chain answers. */
  balance(config: JunoBackendConfig, address: string): Promise<bigint>;
}

/** The contract's control fields, as its `config` query answers them. */
export interface ContractControl {
  readonly admin: string;
  readonly operator: string;
  readonly paused: boolean;
  readonly contract_name: string;
  readonly contract_version: string;
}

export async function contractControl(rest: JunoRest, config: JunoBackendConfig): Promise<ContractControl> {
  const c = parseConfigResponse(await rest.smart(config.contract, QUERY.config()));
  return { admin: c.admin, operator: c.operator, paused: c.paused, contract_name: c.contract_name, contract_version: c.contract_version };
}

/** The exact admin message (`ExecuteMsg::SetOperator`), as JSON text: what the contract admin signs and sends, with no funds. */
export function setOperatorMessage(operator: string): string {
  return JSON.stringify({ set_operator: { operator } });
}

/**
 * A NEW relayer account's funding floor (base units of the configuration's denomination), derived from the gas policy the
 * relayer itself enforces (`gasPolicy.ts` `decideGas`: every relayer transaction's fee is refused above `gas.max_fee`).
 * The relayer's transactions per money game: one `Start`, one `Checkpoint` per completed round (the gas bench's worst
 * bound is 64), one `Settle` and one `Finalize` -- 67. A failed transaction still pays its fee, so the floor is one whole
 * worst-bound game AT the fee cap: 67 x max_fee (the defaults: 67 x 500,000 ujunox = 33.5 JUNOX). It is a floor for a
 * staging drill, not a forecast (a typical relayer transaction costs a few hundredths of that cap). Integers only.
 */
export const RELAYER_TRANSACTIONS_PER_GAME = BigInt(67);
export function relayerFunding(config: JunoBackendConfig): { readonly denom: string; readonly maxFeePerTransaction: bigint; readonly transactions: bigint; readonly floor: bigint } {
  return { denom: config.gas.feeDenom, maxFeePerTransaction: config.gas.maxFee, transactions: RELAYER_TRANSACTIONS_PER_GAME, floor: RELAYER_TRANSACTIONS_PER_GAME * config.gas.maxFee };
}

/** A signer's public reference: the KMS key ARN (production), never a development key's path. */
export const signerRefText = (ref: SignerRef): string => (ref.kind === "kms" ? ref.key_ref : "development-key");

/** The deployment a relayer rotation must leave untouched, from the configuration the gate judged. */
export function deploymentIdentityOf(config: JunoBackendConfig): RotationDeploymentIdentity {
  return {
    chain_id: config.chainId,
    contract_address: config.contract,
    code_checksums: [...config.codeChecksums].sort(),
    settlement_key: { signer_key_id: config.settlementKey.signerKeyId, public_key_hex: config.settlementKey.publicKeyHex, key_ref: signerRefText(config.settlementKey.signer) },
    admission_key: { public_key_hex: config.admissionKey.publicKeyHex, key_ref: signerRefText(config.admissionKey.signer) },
    from_relayer_key_ref: signerRefText(config.relayer.signer),
  };
}

const ADDRESS = /^[a-z][a-z0-9]{0,15}1[02-9ac-hj-np-z]{38,58}$/;

/** The production binding: the server's own REST client, and a bank balance read on the first endpoint that is on the
 *  configured chain and answers (`/cosmos/bank/v1beta1/balances/<address>/by_denom`). */
export function productionJunoChain(http: HttpTransport = fetchTransport()): JunoChainReader {
  const policy = (config: JunoBackendConfig) => ({ endpoints: config.endpoints, expectedChainId: config.chainId, allowInsecureLocalHttp: config.allowInsecureLocalHttp, timeoutMs: config.timeoutMs, maxResponseBytes: DEFAULT_ENDPOINT_LIMITS.maxResponseBytes, maxCodeBytes: DEFAULT_ENDPOINT_LIMITS.maxCodeBytes });
  return {
    rest: (config) => createJunoRest(policy(config), http),
    async balance(config, address) {
      if (!ADDRESS.test(address)) throw new JunoRpcError("refused", `${JSON.stringify(address.slice(0, 100))} is not an account address`);
      let last: unknown = null;
      const get = async (url: string): Promise<unknown> => {
        const answer = await http({ method: "GET", url, timeoutMs: config.timeoutMs, maxBytes: 64 * 1024 });
        if (answer.status !== 200) throw new JunoRpcError("unavailable", `HTTP ${answer.status}`);
        return JSON.parse(answer.text) as unknown;
      };
      for (const raw of config.endpoints) {
        try {
          const base = checkEndpoint(raw, config.allowInsecureLocalHttp);
          /* As the server's REST client does (ESCROW-3B review #11): an endpoint is used only after IT said it is on the
             configured chain. */
          const info = (await get(`${base}/cosmos/base/tendermint/v1beta1/node_info`)) as { default_node_info?: { network?: unknown } };
          if (info.default_node_info?.network !== config.chainId) throw new JunoRpcError("wrong-chain", `an endpoint is on ${String(info.default_node_info?.network)}, not ${config.chainId}`);
          const json = (await get(`${base}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(config.gas.feeDenom)}`)) as { balance?: { denom?: unknown; amount?: unknown } | null };
          if (json.balance === undefined || json.balance === null) return BigInt(0);
          const amount = json.balance.amount;
          if (json.balance.denom !== config.gas.feeDenom || typeof amount !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(amount)) throw new JunoRpcError("malformed", "the balance answer is not the expected shape");
          return BigInt(amount);
        } catch (error) {
          last = error;
        }
      }
      throw last instanceof JunoRpcError ? new JunoRpcError(last.kind, `the balance read: ${last.message}`) : new JunoRpcError("unavailable", `no endpoint on ${config.chainId} answered the balance read`);
    },
  };
}
