// server/src/escrow/juno/junoConfig.ts
//
// ==================================================================
//  ESCROW-3B (brief §19-§20): THE JUNO BACKEND'S CONFIGURATION -- NO SECRETS, EVERY PIN CHECKED, FAIL CLOSED
// ==================================================================
//
// The backend is configured by ONE JSON file (`ESCROW_JUNO_CONFIG=<path>` or `--escrow-config <path>`), so a controlled
// Junox run needs no source edit. The file holds NO secret: the keys are KMS key references, or -- for a development
// signer only -- the PATH of a key file (never a key in the file, in an environment variable's value, or on a command
// line). Nothing public is hard-coded: the REST endpoints are the file's.
//
// Absent: the server runs exactly as before (money games are disabled regardless). Present: the file is checked in two
// stages, and financial mode is REFUSED unless everything agrees:
//
//   static (at startup; a problem refuses the start in production, and turns the backend off in development)
//     - the chain id, network class and address prefix; a mainnet chain id is always class mainnet;
//     - the contract address (bech32 `juno`), and its code checksum is the CANONICAL one this build carries
//       (escrow 2.0.0, ESCROW-JOIN; the 1.0.0 artifact `b263277a…9296` admitted any payer to Join and is refused by
//       name) -- configuration can narrow the accepted set, never widen it;
//     - the endpoints (https; http only for a loopback development node), the gas policy (integers, bounded);
//     - the signing journal: v2 names a directory (absolute, and OUTSIDE the data directory in production, GNOLAND-1
//       F1); v3 (LIVE-5 L5-5) names its KIND -- that file directory, or the DynamoDB ledger by its full table ARN --
//       and nothing defaults: a v3 file without it, or with an unknown kind, is refused, never read as a file journal;
//     - the signers: KMS in production; a development signer only in GS_MODE=development on testnet/local with the
//       explicit switch; a KMS key is named by its KEY ARN (never an alias, which can be repointed; L5-5), and every
//       KMS key of one configuration is in ONE region, taken from the ARNs (never from the environment); the relayer
//       address IS the address the relayer key controls; the settlement key IS the configured public key; the
//       JOIN-ADMISSION key (ESCROW-JOIN) IS its configured public key, and all three keys are different keys;
//     - the build's settlement codec, certified rules versions and financial protocol are the ones pinned here.
//   online (`verifyJunoDeployment`, before any signature or broadcast; retried while the chain is unreachable)
//     - every node answers the configured chain id (a node for another network is refused, never used);
//     - the contract's code id resolves to the canonical checksum, its wasm admin is exactly the configured one, and its
//       cw2 name/version are the escrow's;
//     - the contract's denom is the configured denom, its operator IS the relayer address, its resolver is trusted,
//       and its join-admission key IS this server's admission key (a contract that verifies another key -- or none --
//       would refuse every admitted player, or admit players this server never admitted);
//     - the signer registry (read to its end) holds the settlement key, active, and no active key this server does not
//       hold.
//   A MISMATCH turns financial mode off for the life of the process (loudly); UNAVAILABILITY retries.

import * as path from "path";
import { realpathSync } from "fs";

import { isAwsRegion, parseDynamoTableArn, parseKmsKeyArn } from "../../aws/arns";
import { DEPLOYMENT_SETTLEMENT_CODECS, FINANCIAL_PROTOCOL_VERSION } from "../moneyContinuation";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../../../../frontend/src/gameEngine/settlementAppraisal";
import { JUNO_CAPABILITIES_V1 } from "../../../../frontend/src/gameEngine/escrow/escrowModel";
import type { EscrowTrustPolicy } from "../../../../frontend/src/gameEngine/escrow/escrowRoster";
import { checkSettlementKeyConfig, type SettlementKeyConfig } from "../escrowPorts";
import type { FinancialDeploymentPin } from "../moneyLifecycle";
import { addressOfPublicKey, bech32Decode } from "./cosmosTx";
import { checkGasPolicy, DEFAULT_GAS_POLICY, type GasPolicy } from "./gasPolicy";
import { parseConfigResponse, parseSignerKeysResponse, QUERY } from "./junoContract";
import { checkEndpoint, DEFAULT_ENDPOINT_LIMITS, JunoRpcError, type JunoRest } from "./junoRest";
import { MAINNET_CHAIN_IDS } from "./signer";

/** v2 (ESCROW-JOIN): adds the required `admission_key`. A v1 file names no admission key and is refused. */
export const JUNO_BACKEND_CONFIG_FORMAT = "18COSMOS/JUNO-BACKEND/v2";
/** v3 (LIVE-5 L5-5): v2 with `journal_dir` replaced by `journal: {kind: "file", dir} | {kind: "dynamodb", table_arn}`. v2
 *  stays accepted, exactly as it was (a file journal at `journal_dir`). */
export const JUNO_BACKEND_CONFIG_FORMAT_V3 = "18COSMOS/JUNO-BACKEND/v3";
export const JUNO_BACKEND_CONFIG_FORMATS: readonly string[] = Object.freeze([JUNO_BACKEND_CONFIG_FORMAT, JUNO_BACKEND_CONFIG_FORMAT_V3]);

/** The canonical optimized escrow wasm this build is certified against: escrow 2.0.0 with the join admission
 *  (ESCROW-JOIN, built by the ESCROW-B2 procedure; PROJECT_CANONICAL_CONTEXT §D.3). */
export const CANONICAL_JUNO_ESCROW_CHECKSUMS: readonly string[] = Object.freeze(["5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"]);
/** Historical artifacts that must never hold money (ESCROW-B2 1.0.0: its Join seated any wallet paying the ante). */
export const REFUSED_JUNO_ESCROW_CHECKSUMS: readonly string[] = Object.freeze(["b263277aa5d1d63c33e8e238f27ad2b9ee4749c9a66abe82ef3146d51d119296"]);
/** The contract's cw2 identity (`contracts/escrow/src/contract.rs`). */
export const JUNO_ESCROW_CONTRACT_NAME = "crates.io:eighteen-cosmos-escrow";
export const JUNO_ESCROW_CONTRACT_VERSIONS: readonly string[] = Object.freeze(["2.0.0"]);
/** How long a join admission stays usable on chain (seconds): long enough for a wallet approval and inclusion, short
 *  enough that a superseded or revoked ticket's admission dies quickly (the contract compares block time). */
export const DEFAULT_ADMISSION_TTL_SECS = 600;
export const ADMISSION_TTL_BOUNDS_SECS = Object.freeze([120, 1800] as const);
export const DEV_SIGNER_SWITCH = "allow-unprotected-testnet-key";

export type SignerRef = { readonly kind: "kms"; readonly key_ref: string } | { readonly kind: "development"; readonly key_file: string };

/** LIVE-5 L5-5: where the signing journal lives. `file`: the local adapter's directory (v2's `journal_dir`, or v3's
 *  `journal.dir`). `dynamodb`: the ledger (`aws/ledger/dynamoSigningLedger.ts`), by its full table ARN -- its region is
 *  the ARN's. Opening the ledger is LIVE-5 L5-7's wiring; until then `start.ts` refuses it (`fileJournalDirOf`). */
export type JournalConfig =
  | { readonly kind: "file"; readonly dir: string }
  | { readonly kind: "dynamodb"; readonly tableArn: string; readonly region: string; readonly account: string; readonly table: string };

export interface JunoBackendConfig {
  readonly chainId: string;
  readonly networkClass: "mainnet" | "testnet" | "local";
  readonly endpoints: readonly string[];
  readonly allowInsecureLocalHttp: boolean;
  readonly contract: string;
  readonly codeChecksums: readonly string[];
  readonly wasmAdmin: string | null;
  readonly denom: string;
  readonly symbol: string;
  readonly relayer: { readonly address: string; readonly signer: SignerRef };
  readonly settlementKey: { readonly signerKeyId: number; readonly publicKeyHex: string; readonly signer: SignerRef };
  /** ESCROW-JOIN: the key the contract's `Config.admission_pubkey` must be; signs Join admissions only. */
  readonly admissionKey: { readonly publicKeyHex: string; readonly signer: SignerRef; readonly ttlSecs: number };
  readonly trust: EscrowTrustPolicy;
  readonly gas: GasPolicy;
  readonly timeoutBlocks: number;
  /** The configuration's format (v2 or v3). */
  readonly format: string;
  readonly journal: JournalConfig;
  /** The one region every KMS key of this configuration is in (from their ARNs); `null` when no key is a KMS key. */
  readonly kmsRegion: string | null;
  readonly devSignerAcknowledged: boolean;
  readonly timeoutMs: number;
}

export class JunoConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the Juno backend configuration is refused: ${problems.join("; ")}`);
    this.name = "JunoConfigError";
  }
}

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const DEC = /^(0|[1-9][0-9]{0,19})$/;
const RATIO = /^([1-9][0-9]{0,9})\/([1-9][0-9]{0,9})$/;

/** Parses and checks the file's JSON (the static stage). Every problem is reported at once. */
export function parseJunoBackendConfig(raw: unknown, context: { readonly serverMode: "development" | "production"; readonly dataDir: string }): JunoBackendConfig {
  const problems: string[] = [];
  const need = (ok: boolean, problem: string) => {
    if (!ok) problems.push(problem);
  };
  if (!isObject(raw)) throw new JunoConfigError(["the file is not a JSON object"]);
  need(JUNO_BACKEND_CONFIG_FORMATS.includes(raw.format as string), `format must be ${JUNO_BACKEND_CONFIG_FORMAT} or ${JUNO_BACKEND_CONFIG_FORMAT_V3}`);
  const v3 = raw.format === JUNO_BACKEND_CONFIG_FORMAT_V3;
  const allowed = ["format", "chain_id", "network_class", "rest_endpoints", "allow_insecure_local_http", "contract_address", "code_checksum", "wasm_admin", "denom", "asset_symbol", "relayer", "settlement_key", "admission_key", "trust", "gas", "timeout_blocks", v3 ? "journal" : "journal_dir", "dev_signer", "request_timeout_ms"];
  for (const key of Object.keys(raw)) need(allowed.includes(key), `unknown field ${key} (a misspelt setting is never ignored${key === "journal_dir" || key === "journal" ? `; ${JUNO_BACKEND_CONFIG_FORMAT} names journal_dir, ${JUNO_BACKEND_CONFIG_FORMAT_V3} names journal` : ""})`);

  const chainId = typeof raw.chain_id === "string" && /^[a-z0-9][a-z0-9-]{1,48}$/.test(raw.chain_id) ? raw.chain_id : "";
  need(chainId !== "", "chain_id");
  const networkClass = raw.network_class === "mainnet" || raw.network_class === "testnet" || raw.network_class === "local" ? raw.network_class : "local";
  need(raw.network_class === networkClass, "network_class must be mainnet, testnet or local");
  need(!MAINNET_CHAIN_IDS.includes(chainId) || networkClass === "mainnet", `${chainId} is a mainnet chain and must be declared network_class mainnet`);
  need(networkClass !== "mainnet" || MAINNET_CHAIN_IDS.includes(chainId), `network_class mainnet is only for ${MAINNET_CHAIN_IDS.join(", ")}`);

  const allowHttp = raw.allow_insecure_local_http === true;
  need(!(allowHttp && context.serverMode === "production"), "allow_insecure_local_http is refused in production");
  const endpoints = Array.isArray(raw.rest_endpoints) ? raw.rest_endpoints.filter((entry): entry is string => typeof entry === "string") : [];
  need(endpoints.length >= 1 && endpoints.length === (raw.rest_endpoints as unknown[]).length, "rest_endpoints must be a non-empty list of URLs");
  need(!(networkClass === "mainnet" && endpoints.length < 2), "mainnet needs at least two independent rest_endpoints");
  for (const endpoint of endpoints) {
    try {
      checkEndpoint(endpoint, allowHttp);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  const address = (value: unknown, where: string): string => {
    if (typeof value !== "string") {
      problems.push(`${where} must be a juno address`);
      return "";
    }
    try {
      bech32Decode(value, "juno");
      return value;
    } catch (error) {
      problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  };
  const contract = address(raw.contract_address, "contract_address");
  const checksum = typeof raw.code_checksum === "string" ? raw.code_checksum : "";
  need(!REFUSED_JUNO_ESCROW_CHECKSUMS.includes(checksum), `code_checksum ${checksum} is the historical escrow 1.0.0 artifact, whose Join seats any wallet paying the ante; deploy the canonical 2.0.0 wasm`);
  need(CANONICAL_JUNO_ESCROW_CHECKSUMS.includes(checksum), `code_checksum must be the canonical escrow wasm (${CANONICAL_JUNO_ESCROW_CHECKSUMS[0]})`);
  const wasmAdmin = raw.wasm_admin === null ? null : typeof raw.wasm_admin === "string" ? address(raw.wasm_admin, "wasm_admin") : "";
  need(raw.wasm_admin === null || typeof raw.wasm_admin === "string", "wasm_admin must be null (immutable) or the published admin address (OD-G1-1)");
  const denom = typeof raw.denom === "string" && /^[a-z][a-z0-9/]{2,63}$/.test(raw.denom) ? raw.denom : "";
  need(denom !== "", "denom");
  const symbol = typeof raw.asset_symbol === "string" && /^[A-Z]{2,12}$/.test(raw.asset_symbol) ? raw.asset_symbol : "";
  need(symbol !== "", "asset_symbol");

  /* L5-5: every KMS key by its KEY ARN, all in one region -- the region the KMS client is made for (`createKmsClient`). */
  const kmsRegions = new Set<string>();
  const signerRef = (value: unknown, where: string): SignerRef => {
    if (isObject(value) && value.kind === "kms" && typeof value.key_ref === "string" && value.key_ref.length > 0) {
      const arn = parseKmsKeyArn(value.key_ref);
      if ("problem" in arn) problems.push(`${where}.signer.key_ref: ${arn.problem}`);
      else if (!isAwsRegion(arn.region)) problems.push(`${where}.signer.key_ref: ${arn.region} is not an AWS region`);
      else kmsRegions.add(arn.region);
      return { kind: "kms", key_ref: value.key_ref };
    }
    if (isObject(value) && value.kind === "development" && typeof value.key_file === "string" && path.isAbsolute(value.key_file)) {
      need(context.serverMode === "development", `${where}: a development signer is refused in production (use KMS)`);
      need(networkClass !== "mainnet", `${where}: a development signer never signs for mainnet`);
      need(raw.dev_signer === DEV_SIGNER_SWITCH, `${where}: a development signer needs "dev_signer": "${DEV_SIGNER_SWITCH}"`);
      need(!path.resolve(value.key_file).startsWith(path.resolve(context.dataDir) + path.sep), `${where}: the key file may not live in the data directory`);
      return { kind: "development", key_file: value.key_file };
    }
    problems.push(`${where}.signer must be {"kind":"kms","key_ref":…} or {"kind":"development","key_file":<absolute path>}`);
    return { kind: "kms", key_ref: "" };
  };
  const relayerRaw = isObject(raw.relayer) ? raw.relayer : {};
  const relayer = { address: address(relayerRaw.address, "relayer.address"), signer: signerRef(relayerRaw.signer, "relayer") };
  const keyRaw = isObject(raw.settlement_key) ? raw.settlement_key : {};
  const signerKeyId = typeof keyRaw.signer_key_id === "number" && Number.isInteger(keyRaw.signer_key_id) && keyRaw.signer_key_id >= 1 && keyRaw.signer_key_id <= 64 ? keyRaw.signer_key_id : 0;
  need(signerKeyId !== 0, "settlement_key.signer_key_id must be 1..64");
  const publicKeyHex = typeof keyRaw.public_key_hex === "string" && /^0[23][0-9a-f]{64}$/.test(keyRaw.public_key_hex) ? keyRaw.public_key_hex : "";
  need(publicKeyHex !== "", "settlement_key.public_key_hex must be a 33-byte compressed key (lowercase hex)");
  const settlementKey = { signerKeyId, publicKeyHex, signer: signerRef(keyRaw.signer, "settlement_key") };
  need(JSON.stringify(settlementKey.signer) !== JSON.stringify(relayer.signer), "the settlement key and the relayer key must be different keys");
  /* ESCROW-JOIN: the admission key -- its own key, never the relayer's or the settlement key (a leak of one role's key
     must not grant another role). */
  const admissionRaw = isObject(raw.admission_key) ? raw.admission_key : null;
  need(admissionRaw !== null, "admission_key is required: the contract refuses every Join without this server's admission");
  const admissionAllowed = ["public_key_hex", "signer", "ttl_secs"];
  for (const key of Object.keys(admissionRaw ?? {})) need(admissionAllowed.includes(key), `unknown field admission_key.${key}`);
  const admissionPublicKeyHex = typeof admissionRaw?.public_key_hex === "string" && /^0[23][0-9a-f]{64}$/.test(admissionRaw.public_key_hex) ? admissionRaw.public_key_hex : "";
  need(admissionPublicKeyHex !== "", "admission_key.public_key_hex must be a 33-byte compressed key (lowercase hex)");
  need(admissionPublicKeyHex === "" || admissionPublicKeyHex !== publicKeyHex, "the admission key and the settlement key must be different keys");
  const [ttlMin, ttlMax] = ADMISSION_TTL_BOUNDS_SECS;
  const ttlSecs =
    admissionRaw?.ttl_secs === undefined
      ? DEFAULT_ADMISSION_TTL_SECS
      : typeof admissionRaw.ttl_secs === "number" && Number.isInteger(admissionRaw.ttl_secs) && admissionRaw.ttl_secs >= ttlMin && admissionRaw.ttl_secs <= ttlMax
        ? admissionRaw.ttl_secs
        : (problems.push(`admission_key.ttl_secs must be ${ttlMin}..${ttlMax}`), DEFAULT_ADMISSION_TTL_SECS);
  const admissionKey = { publicKeyHex: admissionPublicKeyHex, signer: admissionRaw === null ? ({ kind: "kms", key_ref: "" } as SignerRef) : signerRef(admissionRaw.signer, "admission_key"), ttlSecs };
  need(JSON.stringify(admissionKey.signer) !== JSON.stringify(relayer.signer), "the admission key and the relayer key must be different keys");
  need(JSON.stringify(admissionKey.signer) !== JSON.stringify(settlementKey.signer), "the admission key and the settlement key must be different keys");

  const trustRaw = isObject(raw.trust) ? raw.trust : {};
  const list = (value: unknown, where: string) => (Array.isArray(value) && value.length > 0 ? value.map((entry, i) => address(entry, `${where}[${i}]`)) : (problems.push(`${where} must list at least one address`), []));
  const secs = (value: unknown, where: string) => (typeof value === "string" && DEC.test(value) ? BigInt(value) : (problems.push(`${where} must be whole seconds (a decimal string)`), BigInt(0)));
  const trust: EscrowTrustPolicy = {
    operators: list(trustRaw.operators, "trust.operators"),
    resolvers: list(trustRaw.resolvers, "trust.resolvers"),
    min_challenge_window_secs: secs(trustRaw.min_challenge_window_secs, "trust.min_challenge_window_secs"),
    min_liveness_window_secs: secs(trustRaw.min_liveness_window_secs, "trust.min_liveness_window_secs"),
    min_resolver_timeout_secs: secs(trustRaw.min_resolver_timeout_secs, "trust.min_resolver_timeout_secs"),
  };
  need(trust.operators.includes(relayer.address), "trust.operators must include the relayer address (it is the contract's operator)");

  const gasRaw = isObject(raw.gas) ? raw.gas : {};
  const ratio = (value: unknown, fallback: [bigint, bigint], where: string): [bigint, bigint] => {
    if (value === undefined) return fallback;
    const m = typeof value === "string" ? RATIO.exec(value) : null;
    if (m === null) {
      problems.push(`${where} must be a ratio of integers like "13/10"`);
      return fallback;
    }
    return [BigInt(m[1]), BigInt(m[2])];
  };
  const int = (value: unknown, fallback: bigint, where: string) => (value === undefined ? fallback : typeof value === "string" && DEC.test(value) ? BigInt(value) : (problems.push(`${where} must be a decimal string`), fallback));
  const [mulNum, mulDen] = ratio(gasRaw.multiplier, [DEFAULT_GAS_POLICY.multiplierNum, DEFAULT_GAS_POLICY.multiplierDen], "gas.multiplier");
  const [priceNum, priceDen] = ratio(gasRaw.gas_price, [DEFAULT_GAS_POLICY.gasPriceNum, DEFAULT_GAS_POLICY.gasPriceDen], "gas.gas_price");
  const gas: GasPolicy = {
    multiplierNum: mulNum,
    multiplierDen: mulDen,
    minGas: int(gasRaw.min_gas, DEFAULT_GAS_POLICY.minGas, "gas.min_gas"),
    maxGas: int(gasRaw.max_gas, DEFAULT_GAS_POLICY.maxGas, "gas.max_gas"),
    gasPriceNum: priceNum,
    gasPriceDen: priceDen,
    maxFee: int(gasRaw.max_fee, DEFAULT_GAS_POLICY.maxFee, "gas.max_fee"),
    feeDenom: denom || "ujuno",
  };
  try {
    checkGasPolicy(gas);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const timeoutBlocks = raw.timeout_blocks === undefined ? 60 : typeof raw.timeout_blocks === "number" && Number.isInteger(raw.timeout_blocks) && raw.timeout_blocks >= 10 && raw.timeout_blocks <= 1000 ? raw.timeout_blocks : (problems.push("timeout_blocks must be 10..1000"), 60);
  const timeoutMs = raw.request_timeout_ms === undefined ? DEFAULT_ENDPOINT_LIMITS.timeoutMs : typeof raw.request_timeout_ms === "number" && Number.isInteger(raw.request_timeout_ms) && raw.request_timeout_ms >= 1000 && raw.request_timeout_ms <= 60_000 ? raw.request_timeout_ms : (problems.push("request_timeout_ms must be 1000..60000"), DEFAULT_ENDPOINT_LIMITS.timeoutMs);

  /* The signing journal. v2: `journal_dir`, a file journal, exactly as before. v3 (L5-5): `journal`, its kind named --
     nothing defaults, and a kind this build does not know is refused (never read as a file journal). */
  const journalRaw: unknown = v3 ? raw.journal : { kind: "file", dir: raw.journal_dir };
  const dirWhere = v3 ? "journal.dir" : "journal_dir";
  let journal: JournalConfig = { kind: "file", dir: "" };
  if (!isObject(journalRaw)) problems.push(`journal must be {"kind":"file","dir":<absolute path>} or {"kind":"dynamodb","table_arn":<the ledger table's ARN>}`);
  else if (journalRaw.kind === "file") {
    if (v3) for (const key of Object.keys(journalRaw)) need(["kind", "dir"].includes(key), `unknown field journal.${key}`);
    const journalDir = typeof journalRaw.dir === "string" && path.isAbsolute(journalRaw.dir) ? path.resolve(journalRaw.dir) : "";
    need(journalDir !== "", `${dirWhere} must be an absolute path`);
    /* Review #15: compared through symlinks where the paths exist (a link into the data directory is inside it). */
    const real = (target: string): string => {
      try {
        return realpathSync(target);
      } catch {
        return path.resolve(target);
      }
    };
    const dataReal = real(context.dataDir);
    const journalReal = journalDir === "" ? "" : real(journalDir);
    const insideData = journalDir !== "" && [path.resolve(context.dataDir), dataReal].some((data) => [journalDir, journalReal].some((dir) => dir === data || dir.startsWith(data + path.sep)));
    need(!(insideData && context.serverMode === "production"), `${dirWhere} must be OUTSIDE the data directory in production (a store restore must not roll it back)`);
    journal = { kind: "file", dir: journalDir };
  } else if (journalRaw.kind === "dynamodb") {
    for (const key of Object.keys(journalRaw)) need(["kind", "table_arn"].includes(key), `unknown field journal.${key}`);
    const arn = parseDynamoTableArn(journalRaw.table_arn);
    if ("problem" in arn) problems.push(`journal.table_arn: ${arn.problem}`);
    else journal = { kind: "dynamodb", tableArn: arn.arn, region: arn.region, account: arn.account, table: arn.table };
  } else problems.push(`journal.kind must be "file" or "dynamodb" (got ${JSON.stringify(journalRaw.kind ?? null)}); nothing defaults to a file journal`);
  need(kmsRegions.size <= 1, `every KMS key of one configuration must be in one region (these name ${[...kmsRegions].sort().join(", ")})`);

  /* The build's own pins: the codec, the certified rules and the financial protocol this backend speaks. */
  need(DEPLOYMENT_SETTLEMENT_CODECS.includes("18JUNO/v1"), "this build does not carry the certified 18JUNO/v1 codec");
  need(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS.length > 0, "this build certifies no rules version for settlement");
  need(FINANCIAL_PROTOCOL_VERSION === 3, "this build's financial protocol is not the one this backend implements (3)");

  if (problems.length > 0) throw new JunoConfigError(problems);
  return {
    chainId,
    networkClass,
    endpoints,
    allowInsecureLocalHttp: allowHttp,
    contract,
    codeChecksums: [checksum],
    wasmAdmin,
    denom,
    symbol,
    relayer,
    settlementKey,
    admissionKey,
    trust,
    gas,
    timeoutBlocks,
    format: raw.format as string,
    journal,
    kmsRegion: kmsRegions.size === 1 ? [...kmsRegions][0] : null,
    devSignerAcknowledged: raw.dev_signer === DEV_SIGNER_SWITCH,
    timeoutMs,
  };
}

/**
 * LIVE-5 L5-5: the directory of a FILE signing journal -- the only journal the FILE (PROCESS) storage mode of `start.ts`
 * opens. A configuration naming the DynamoDB ledger is refused here, loudly: the ledger is opened only by the AWS storage
 * mode (LIVE-5 L5-7, `aws/runtime/`, with its generation, its relayer role and the AWS clients), and a server never falls
 * back to a local file journal for a configuration that names the ledger.
 */
export function fileJournalDirOf(config: JunoBackendConfig): string {
  if (config.journal.kind === "file") return config.journal.dir;
  throw new JunoConfigError([
    `the configuration names the DynamoDB signing ledger (${config.journal.tableArn}); the file storage mode does not open it (the AWS storage mode does: GS_STORAGE=aws, LIVE-5 L5-7) and never falls back to a file journal`,
  ]);
}

/** The deployment pin every money game created here carries. */
export function pinOf(config: JunoBackendConfig): FinancialDeploymentPin {
  return { backend: "juno-cosmwasm", codec: "18JUNO/v1", chain_id: config.chainId, network_class: config.networkClass, contract_address: config.contract, code_checksum: config.codeChecksums[0], denom: config.denom };
}

export function settlementKeyConfigOf(config: JunoBackendConfig, kmsKeyRef: string): SettlementKeyConfig {
  return { backend: "juno-cosmwasm", chain_id: config.chainId, deployment_id: config.contract, signer_key_id: config.settlementKey.signerKeyId, scheme: "secp256k1-ecdsa-prehashed/rs64-low-s", kms_key_ref: kmsKeyRef, public_key_hex: config.settlementKey.publicKeyHex, role: "active" };
}

/** The keys agree with the configuration (the static half that needs the opened signers). */
export function checkSignerIdentities(config: JunoBackendConfig, relayerPublicKey: Buffer, settlementPublicKey: Buffer, settlementKey: SettlementKeyConfig, admissionPublicKey: Buffer): void {
  const problems: string[] = [];
  const controlled = addressOfPublicKey(relayerPublicKey, "juno");
  if (controlled !== config.relayer.address) problems.push(`the relayer key controls ${controlled}, not the configured relayer ${config.relayer.address}`);
  if (settlementPublicKey.toString("hex") !== config.settlementKey.publicKeyHex) problems.push("the settlement key is not the configured settlement public key");
  if (relayerPublicKey.equals(settlementPublicKey)) problems.push("the relayer and settlement keys are the same key");
  if (admissionPublicKey.toString("hex") !== config.admissionKey.publicKeyHex) problems.push("the admission key is not the configured admission public key");
  if (admissionPublicKey.equals(relayerPublicKey) || admissionPublicKey.equals(settlementPublicKey)) problems.push("the admission key is the same key as the relayer or settlement key");
  try {
    checkSettlementKeyConfig([settlementKey], [JUNO_CAPABILITIES_V1]);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0) throw new JunoConfigError(problems);
}

export type DeploymentVerdict = { readonly kind: "verified"; readonly height: string } | { readonly kind: "unavailable"; readonly detail: string } | { readonly kind: "mismatch"; readonly problems: readonly string[] };

/** The online stage: the chain agrees with every pin, or financial mode stays off. */
export async function verifyJunoDeployment(config: JunoBackendConfig, rest: JunoRest): Promise<DeploymentVerdict> {
  const problems: string[] = [];
  try {
    /* Review #11: EVERY configured endpoint is asked for its own chain id; one on another network is a configuration
       error (it would otherwise be a silent failover target for reads, simulation and broadcast). */
    const chains = await rest.endpointChains();
    for (const entry of chains) if (entry.chain_id !== null && entry.chain_id !== config.chainId) problems.push(`endpoint ${entry.endpoint} is on ${entry.chain_id}, not ${config.chainId}`);
    if (problems.length > 0) return { kind: "mismatch", problems };
    if (!chains.some((entry) => entry.chain_id === config.chainId)) return { kind: "unavailable", detail: `no endpoint answered: ${chains.map((entry) => `${entry.endpoint}: ${entry.error ?? "?"}`).join("; ").slice(0, 300)}` };
    const block = await rest.latestBlock(); // throws wrong-chain on another network
    if (await rest.syncing()) return { kind: "unavailable", detail: "the node is still syncing" };
    const contract = await rest.contract(config.contract);
    const checksum = await rest.codeChecksum(contract.code_id);
    if (!config.codeChecksums.includes(checksum)) problems.push(`the contract runs code ${contract.code_id} with checksum ${checksum}, not the canonical escrow`);
    if (contract.admin !== config.wasmAdmin) problems.push(`the contract's wasm admin is ${contract.admin ?? "none"}, not the configured ${config.wasmAdmin ?? "none"}`);
    const escrow = parseConfigResponse(await rest.smart(config.contract, QUERY.config()));
    if (escrow.contract_name !== JUNO_ESCROW_CONTRACT_NAME) problems.push(`the contract is ${escrow.contract_name}, not ${JUNO_ESCROW_CONTRACT_NAME}`);
    if (!JUNO_ESCROW_CONTRACT_VERSIONS.includes(escrow.contract_version)) problems.push(`the contract version ${escrow.contract_version} is not certified here`);
    if (escrow.denom !== config.denom) problems.push(`the contract's denom is ${escrow.denom}, not ${config.denom}`);
    if (escrow.operator !== config.relayer.address) problems.push(`the contract's operator is ${escrow.operator}, not the relayer ${config.relayer.address}`);
    if (!config.trust.resolvers.includes(escrow.resolver)) problems.push(`the contract's resolver ${escrow.resolver} is not a trusted resolver`);
    if (escrow.admission_pubkey !== config.admissionKey.publicKeyHex) problems.push(`the contract's join-admission key is ${escrow.admission_pubkey}, not this server's admission key ${config.admissionKey.publicKeyHex} (every admitted Join would be refused)`);
    const keys = [];
    let after: number | null = null;
    for (let page = 0; page < 8; page += 1) {
      const batch = parseSignerKeysResponse(await rest.smart(config.contract, QUERY.signerKeys(after, 30)));
      keys.push(...batch);
      if (batch.length < 30) break;
      after = batch[batch.length - 1].key_id;
    }
    const mine = keys.find((key) => key.key_id === config.settlementKey.signerKeyId);
    if (mine === undefined || mine.pubkey !== config.settlementKey.publicKeyHex) problems.push(`the registry does not hold signer key ${config.settlementKey.signerKeyId} with the configured public key`);
    else if (mine.retired || mine.compromised) problems.push(`signer key ${config.settlementKey.signerKeyId} is ${mine.compromised ? "compromised" : "retired"} on chain`);
    const foreign = keys.filter((key) => !key.retired && !key.compromised && key.key_id !== config.settlementKey.signerKeyId);
    if (foreign.length > 0) problems.push(`the registry has active keys this server does not hold: ${foreign.map((key) => key.key_id).join(", ")} (an unmonitored signer is a hold, never signed around)`);
    return problems.length > 0 ? { kind: "mismatch", problems } : { kind: "verified", height: block.height };
  } catch (error) {
    if (error instanceof JunoRpcError && error.kind === "wrong-chain") return { kind: "mismatch", problems: [error.message] };
    if (error instanceof JunoRpcError) return { kind: "unavailable", detail: error.message };
    return { kind: "mismatch", problems: [error instanceof Error ? error.message : String(error)] };
  }
}
