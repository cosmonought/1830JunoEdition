// server/src/aws/deploy/junoChain.ts
//
// ==================================================================
//  LIVE-6 RELAYER ROTATION: THE DEPLOY TOOLS' READ-ONLY VIEW OF THE ESCROW CONTRACT ON CHAIN -- WHO MAY CHANGE ITS
//  OPERATOR, WHO ITS OPERATOR IS, AND WHETHER A RELAYER ACCOUNT HOLDS ITS ONE-GAME PLANNING RESERVE
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
//   - `relayerFunding`    the one-game operational planning reserve an ACTIVE relayer account must hold before it can be
//                         given new money work, derived from the configuration's own gas policy (`perTransactionFeeCap`;
//                         integers only; LIVE-6 L6-12D);
//   - `deploymentIdentityOf` the deployment a rotation must leave untouched, from a parsed configuration;
//   - `productionJunoChain` the REST binding (`createJunoRest` over the configured endpoints, plus the bank balance read).

import { ceilDiv, type GasPolicy } from "../../escrow/juno/gasPolicy";
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
 * The largest fee the relayer can EVER sign for one transaction, from the gas policy it enforces itself (`gasPolicy.ts`
 * `decideGas`): every gas limit is refused above `max_gas`, and every fee is `ceil(gas_limit x gas_price)`, refused above
 * `max_fee`. So the fee of an accepted transaction is at most
 *
 *     min( max_fee, ceil(max_gas x gas_price_num / gas_price_den) )
 *
 * (the defaults: min(500,000, ceil(1,500,000 x 75/1000) = 112,500) = 112,500 ujunox). `max_fee` alone is NOT the bound
 * when the gas-derived ceiling is lower -- the pre-L6-12D floor multiplied by `max_fee`, a fee the default policy can
 * never produce (L6-12C). Integers only, rounding exactly as `decideGas` does (its own `ceilDiv`); the policy itself is
 * not changed here.
 */
export function perTransactionFeeCap(gas: GasPolicy): bigint {
  const gasDerived = gasDerivedMaxFee(gas);
  return gas.maxFee < gasDerived ? gas.maxFee : gasDerived;
}

/** `ceil(max_gas x gas_price_num / gas_price_den)`: the fee `decideGas` computes at the largest gas limit it accepts. */
export function gasDerivedMaxFee(gas: GasPolicy): bigint {
  return ceilDiv(gas.maxGas * gas.gasPriceNum, gas.gasPriceDen);
}

/**
 * The relayer transactions ONE money game is PLANNED for (LIVE-6 L6-12D; L6-12C's recount):
 *
 *     Start 1 + Checkpoint 64 + Settle 1 + Consent 6 + Finalize 1 = 73
 *
 *   - Checkpoint 64 is an OPERATIONAL PLANNING ALLOWANCE, not a protocol or contract limit: the contract does not cap
 *     how many Checkpoint TRANSACTIONS a game sends. (64 borrows the contract's bound on STORED checkpoints -- one per
 *     signer key, `CHECKPOINTS: Map<(game, key_id)>`, `MAX_SIGNER_KEYS` = 64 -- the gas bench's worst-bound scan shape;
 *     it bounds storage, not transactions.) The server checkpoints at the deal, at every round boundary and at the
 *     terminal seal (`checkpointPolicy.ts`); a typical 1830 game has fewer boundaries than 64, but a long one is not
 *     proven to stay under it.
 *   - Consent 6: each seat's consent is relayed as its own relayer transaction, and a money table seats at most 6
 *     (`moneyTables.ts`). The pre-L6-12D count of 67 omitted them.
 *   - Retries are NOT included. A failed DeliverTx pays at most the per-transaction cap; repeated failures are bounded
 *     operationally by the relayer's existing hold-and-page machinery (an intent is held after its failure budget and the
 *     operator is paged), not by this reserve.
 * The annul path (Start, checkpoints, AnnulByConsent) is smaller.
 */
export const RELAYER_TRANSACTIONS_PER_GAME = BigInt(73);

/** The derivation of the relayer planning reserve, every term reported (base units of `denom`; integers only). */
export interface RelayerFunding {
  readonly denom: string;
  /** `gas.max_fee`: the policy's explicit per-transaction fee refusal. */
  readonly maxFee: bigint;
  /** The policy terms of the gas-derived ceiling. */
  readonly maxGas: bigint;
  readonly gasPriceNum: bigint;
  readonly gasPriceDen: bigint;
  /** `ceil(max_gas x gas_price)`: the fee at the largest accepted gas limit. */
  readonly maxGasFee: bigint;
  /** min(maxFee, maxGasFee): the effective per-transaction cap (`perTransactionFeeCap`). */
  readonly perTransactionCap: bigint;
  /** The transaction planning count (`RELAYER_TRANSACTIONS_PER_GAME`). */
  readonly transactions: bigint;
  /** transactions x perTransactionCap: the one-game operational planning reserve. */
  readonly floor: bigint;
}

/**
 * The ONE-GAME OPERATIONAL PLANNING RESERVE (LIVE-6 L6-12D): what the ACTIVE relayer account must hold before it can be
 * given new money work -- one planned game (`RELAYER_TRANSACTIONS_PER_GAME`) with every transaction at the effective
 * per-transaction cap (`perTransactionFeeCap`). The defaults: 73 x 112,500 = 8,212,500 ujunox = 8.2125 JUNOX.
 *
 * It is NOT an absolute maximum possible game cost (the checkpoint count is a planning allowance and retries are
 * excluded) and NOT a contract, runtime or certification requirement of the chain: it is an operational readiness policy,
 * enforced by `set-operator-plan` (and, for a rotation, the post-rotation proof). The safety model around it is the
 * relayer's hold-and-page behaviour plus operator replenishment. It is a readiness floor, not a forecast: a typical
 * relayer transaction costs a fraction of the cap. Integers only.
 */
export function relayerFunding(config: JunoBackendConfig): RelayerFunding {
  const gas = config.gas;
  const perTransactionCap = perTransactionFeeCap(gas);
  return {
    denom: gas.feeDenom,
    maxFee: gas.maxFee,
    maxGas: gas.maxGas,
    gasPriceNum: gas.gasPriceNum,
    gasPriceDen: gas.gasPriceDen,
    maxGasFee: gasDerivedMaxFee(gas),
    perTransactionCap,
    transactions: RELAYER_TRANSACTIONS_PER_GAME,
    floor: RELAYER_TRANSACTIONS_PER_GAME * perTransactionCap,
  };
}

/** The derivation, as the tools print it: the per-transaction cap, then the reserve (integers; `symbol` for display). */
export function relayerFundingDerivation(funding: RelayerFunding, symbol: string): readonly string[] {
  return [
    `per-tx cap = min(max_fee ${String(funding.maxFee)}, ceil(max_gas ${String(funding.maxGas)} x ${String(funding.gasPriceNum)}/${String(funding.gasPriceDen)}) = ${String(funding.maxGasFee)}) = ${String(funding.perTransactionCap)} ${funding.denom}`,
    `planning reserve = ${String(funding.transactions)} x ${String(funding.perTransactionCap)} = ${String(funding.floor)} ${funding.denom} = ${displayUnits(funding.floor)} ${symbol}`,
    `  (${String(funding.transactions)} = Start 1 + Checkpoint 64 [an operational planning allowance, not a contract cap] + Settle 1 + Consent up to 6 + Finalize 1; retries excluded -- bounded by hold-and-page)`,
  ];
}

/** Base units as a decimal of the display unit (6 decimals, integer arithmetic): 8212500 -> "8.2125". */
export function displayUnits(units: bigint): string {
  const negative = units < BigInt(0);
  const abs = negative ? -units : units;
  const whole = abs / BigInt(1_000_000);
  const frac = (abs % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`}`;
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
