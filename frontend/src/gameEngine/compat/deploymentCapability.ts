// frontend/src/gameEngine/compat/deploymentCapability.ts
//
// ==================================================================
//  LIVE-4 (L4-1): WHAT ONE RELEASE CAN CONTINUE, AND THE KEY THAT NAMES ITS POOL
// ==================================================================
//
// A DEPLOYMENT CAPABILITY is immutable per RELEASE: the image plus its non-secret configuration. It lists every
// semantic fact of the RELEASE that a game's verdict or a client's acceptance reads -- which rules this release deals,
// replays and settles, which hosted and financial protocols it reads and writes, which settlement codecs and escrow
// contract code it carries, which escrow deployments it is configured to serve, and which client protocols it accepts.
// Nothing else. (What the verdict also reads but is NOT a property of the release stays out: the chain's own answers
// this run, the pool's role and flip time, the clock, and the development-only legacy-log policy -- a pool always runs
// with `refuse`.)
//
// ITS COMPATIBILITY KEY IS THE POOL'S NAME (the LIVE-5 `pool_id` stem):
//
//     "dc1-" + the first 24 hex characters of SHA-256( canonicalJson( the canonical descriptor ) )
//
//   * EQUAL KEYS = one pool: a new release with the same key is a rolling replacement, its tasks continue the same
//     games and its clients reconnect without reloading. That is safe only because the version axes are bumped in BOTH
//     directions (`protocolVersions.ts`, D4-17): equal key means the two releases read and continue each other's writes.
//   * A DIFFERENT KEY = a different pool; the old one keeps only the games no other live pool continues
//     (`continuationVerdict.ts`, `serveDecision`).
//
// WHAT IS NOT IN THE KEY, ON PURPOSE: the build id, the client build id, the commit, the build time, the UI build
// note, the identity-store schema, the Juno config file's format, every key and key id, the endpoints, gas and
// timeouts. Those are `ReleaseDiagnostics`: they say which exact software is running (and must stay exact for audit
// and forensic replay), but not what it can continue. A settlement-key rotation or an RPC change is therefore a
// rolling deploy, and a CSS change moves nothing. Nothing about a build can veto a continuation.
//
// CANONICAL, NOT ACCIDENTAL. The descriptor is a CLOSED schema: an unknown (enumerable) field at any level is refused
// rather than hashed or dropped, so a diagnostic cannot leak into the key and a new semantic field cannot be silently
// left out of it; and the canonical descriptor is REBUILT from the known fields alone, so nothing else -- a property
// hung on an array, a non-enumerable field -- can reach the hash either. Set VALUES are closed too where they can be:
// a settlement codec is one of the known codec ids, a contract code is a 64-hex checksum. Every set is sorted (numbers
// numerically, strings by code unit, deployments by key) and must hold no duplicate; object keys are ordered by
// `canonicalJson`. So the key never depends on the order a caller built anything in.
//
// LISTED ⇒ IMPLEMENTED (preflight §5.1). A value may appear in `rules.supported`, `hosted_protocols`,
// `financial_protocols`, `settlement_codecs` or `client_protocols` only if this build completely implements it -- every
// artifact format of that version, read and written. Listing one it does not is silent reinterpretation. The checks
// below enforce what can be enforced from the descriptor alone: the current rules are supported, every served
// deployment's codec is carried and its contract code is spoken, and financial protocols exist exactly when some
// escrow deployment is served.

import { canonicalJson } from "../stateDigest";
import { sha256Hex } from "../sha256";
import type { EscrowBackendKind, EscrowCodecId } from "../escrow/escrowCodec";
import type { EscrowNetworkClass } from "../escrow/escrowModel";

export const DEPLOYMENT_CAPABILITY_FORMAT = "18COSMOS/DEPLOYMENT-CAPABILITY/v1";
/** The key's own version: `dc1-` names this derivation (the v1 descriptor, canonicalJson, SHA-256, 24 hex). */
export const COMPATIBILITY_KEY_PREFIX = "dc1-";
export const COMPATIBILITY_KEY_HEX_LENGTH = 24;

/* ------------------------------------------------------------------ */
/* The escrow deployment: a key, and the facts of that key             */
/* ------------------------------------------------------------------ */

/** The deployment a money game is pinned to: `FIN.binding.deployment`, chain-read facts (ESCROW-3B's
 *  `FinancialDeploymentPin`, `server/src/escrow/moneyLifecycle.ts`; a server test keeps the two types identical). */
export interface DeploymentPin {
  readonly backend: EscrowBackendKind;
  readonly codec: EscrowCodecId;
  readonly chain_id: string;
  readonly network_class: EscrowNetworkClass;
  readonly contract_address: string;
  readonly code_checksum: string;
  readonly denom: string;
}

const PIN_FIELDS = ["backend", "codec", "chain_id", "network_class", "contract_address", "code_checksum", "denom"] as const;

/** The fields that NAME a deployment. Every other field of a pin is a FACT of that deployment. */
export const DEPLOYMENT_KEY_FIELDS = Object.freeze(["backend", "chain_id", "contract_address"] as const);
/** Every fact of a deployment: the chain-attested ones and the declared ones. */
export const DEPLOYMENT_FACT_FIELDS = Object.freeze(["codec", "network_class", "code_checksum", "denom"] as const);
/** The facts the CHAIN attests for a contract address (`verifyJunoDeployment` reads them: the code checksum behind the
 *  contract's code id, and the denom in its config). A game bound to other values than the chain reports under the same
 *  key is a contradiction -- the only kind of deployment difference that is ever a durable conflict. */
export const CHAIN_ATTESTED_FACT_FIELDS = Object.freeze(["code_checksum", "denom"] as const);
/** The facts a configuration DECLARES and no chain read attests: the network class (a label) and the codec (fixed by
 *  the backend). A difference in one of these is a configuration problem, derived, never a hold. */
export const DECLARED_FACT_FIELDS = Object.freeze(["codec", "network_class"] as const);

/** Length-prefixed join: injective whatever the parts contain. The same framing as `escrowInstanceKey`
 *  (`escrowModel.ts`), of which a deployment key is the prefix: that key without the chain game id. */
const framed = (parts: readonly string[]): string => parts.map((part) => `${part.length}:${part}`).join("|");

/** `(backend, chain_id, contract)`: which escrow a game's money is in. A Gno realm's pin carries its package path in
 *  the same field (GNOLAND-1; parked). */
export function deploymentKey(pin: Pick<DeploymentPin, "backend" | "chain_id" | "contract_address">): string {
  return framed([pin.backend, pin.chain_id, pin.contract_address]);
}

/** The first fact on which two pins of the same key differ, or null when they agree. */
export function deploymentFactDifference(a: DeploymentPin, b: DeploymentPin): (typeof DEPLOYMENT_FACT_FIELDS)[number] | null {
  for (const field of DEPLOYMENT_FACT_FIELDS) if (a[field] !== b[field]) return field;
  return null;
}

export interface ServedDeployment {
  readonly key: string;
  readonly pin: DeploymentPin;
}

export function servedDeployment(pin: DeploymentPin): ServedDeployment {
  const checked = checkPin(pin, "a served deployment");
  return Object.freeze({ key: deploymentKey(checked), pin: checked });
}

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export interface CapabilityRules {
  /** New games are dealt under this (`RULES_ENGINE_VERSION`). */
  readonly current: number;
  /** Replayed and continued (`SUPPORTED_RULES_ENGINE_VERSIONS`): every one physically in the build and faithful. More
   *  than one entry is a dual-support rules bump, allowed only with a replay-equivalence certificate -- the older
   *  version's corpus, goldens and certification game replay byte-identically at its pin under the new build (OD-L4-2,
   *  preflight §3.4); the list then becomes a literal owned by that certificate's test, like the settlement literal. */
  readonly supported: readonly number[];
  /** Appraised and settled (`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS`). Need not be a subset of `supported`. */
  readonly certified: readonly number[];
}

export interface DeploymentCapability {
  readonly format: typeof DEPLOYMENT_CAPABILITY_FORMAT;
  readonly rules: CapabilityRules;
  /** Today [1]. A new deal is stamped with the highest. */
  readonly hosted_protocols: readonly number[];
  /** Today [3] with an escrow backend configured; [] without one (no money lifecycle runs here). */
  readonly financial_protocols: readonly number[];
  /** Today ["18JUNO/v1"]. Only known codec ids (`EscrowCodecId`). */
  readonly settlement_codecs: readonly EscrowCodecId[];
  /** The escrow contract code this build speaks (`CANONICAL_JUNO_ESCROW_CHECKSUMS`): 64-hex SHA-256 checksums. */
  readonly escrow_abi_checksums: readonly string[];
  /** The deployments this release is configured to serve: 0..n, sorted by key. */
  readonly escrow_deployments: readonly ServedDeployment[];
  /** The client protocols accepted (`ACCEPTED_CLIENT_PROTOCOLS`); 0 is the legacy, unannounced wire. */
  readonly client_protocols: readonly number[];
}

/** Every top-level field of the descriptor: the key covers exactly these (and the test moves each one). */
export const CAPABILITY_FIELDS = Object.freeze([
  "format",
  "rules",
  "hosted_protocols",
  "financial_protocols",
  "settlement_codecs",
  "escrow_abi_checksums",
  "escrow_deployments",
  "client_protocols",
] as const);
const RULES_FIELDS = ["current", "supported", "certified"] as const;
const SERVED_FIELDS = ["key", "pin"] as const;

/** The descriptor is refused, not repaired: a capability that is not exactly canonical-able names no pool. */
export class DeploymentCapabilityError extends Error {
  constructor(readonly problem: string) {
    super(`the deployment capability is refused: ${problem}`);
    this.name = "DeploymentCapabilityError";
  }
}

const refuse = (problem: string): never => {
  throw new DeploymentCapabilityError(problem);
};

function closedObject(value: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse(`${what} is not an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) refuse(`${what} has an unknown field "${key}" (diagnostics are not part of a capability)`);
  }
  for (const key of fields) if (!Object.prototype.hasOwnProperty.call(record, key)) refuse(`${what} has no "${key}"`);
  return record;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Every codec id this project knows (`EscrowCodecId`); a new codec is a code change here, never a free string. */
const CODECS: readonly EscrowCodecId[] = Object.freeze(["18JUNO/v1", "18GNO/v1"]);
const CODEC = /^(18JUNO\/v1|18GNO\/v1)$/;
const PRINTABLE = /^[\x21-\x7e]{1,128}$/;

function checkPin(value: unknown, what: string): DeploymentPin {
  const pin = closedObject(value, PIN_FIELDS, what);
  if (pin.backend !== "juno-cosmwasm" && pin.backend !== "gno-realm") refuse(`${what}: backend ${JSON.stringify(pin.backend)}`);
  if (!CODECS.includes(pin.codec as EscrowCodecId)) refuse(`${what}: codec ${JSON.stringify(pin.codec)}`);
  if (pin.network_class !== "mainnet" && pin.network_class !== "testnet" && pin.network_class !== "local") refuse(`${what}: network_class ${JSON.stringify(pin.network_class)}`);
  for (const field of ["chain_id", "contract_address", "denom"] as const) {
    if (typeof pin[field] !== "string" || !PRINTABLE.test(pin[field] as string)) refuse(`${what}: ${field} ${JSON.stringify(pin[field])}`);
  }
  if (typeof pin.code_checksum !== "string" || !HEX64.test(pin.code_checksum)) refuse(`${what}: code_checksum is not 64 lowercase hex`);
  return Object.freeze({
    backend: pin.backend as EscrowBackendKind,
    codec: pin.codec as EscrowCodecId,
    chain_id: pin.chain_id as string,
    network_class: pin.network_class as EscrowNetworkClass,
    contract_address: pin.contract_address as string,
    code_checksum: pin.code_checksum as string,
    denom: pin.denom as string,
  });
}

/** A set of integers: each at least `min`, no duplicate; returned sorted ascending (numerically). */
function integerSet(value: unknown, what: string, min: number, nonEmpty: boolean): readonly number[] {
  if (!Array.isArray(value)) return refuse(`${what} is not a list`);
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < min) refuse(`${what} holds ${JSON.stringify(entry)}, not an integer >= ${min}`);
    if (out.includes(entry as number)) refuse(`${what} holds ${String(entry)} twice`);
    out.push(entry as number);
  }
  if (nonEmpty && out.length === 0) refuse(`${what} is empty`);
  return Object.freeze(out.sort((a, b) => a - b));
}

/** A set of strings matching `pattern`, no duplicate; returned sorted by code unit. */
function stringSet(value: unknown, what: string, pattern: RegExp): readonly string[] {
  if (!Array.isArray(value)) return refuse(`${what} is not a list`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !pattern.test(entry)) refuse(`${what} holds ${JSON.stringify(entry)}`);
    if (out.includes(entry as string)) refuse(`${what} holds ${JSON.stringify(entry)} twice`);
    out.push(entry as string);
  }
  return Object.freeze(out.sort(byCodeUnit));
}

/** Code-unit order, stated rather than left to a locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The canonical descriptor: validated (closed schema, every value a version or a well-formed id, every invariant
 * above), every set sorted, frozen. Order-insensitive; refuses rather than repairs anything else.
 */
export function deploymentCapability(value: DeploymentCapability): DeploymentCapability {
  const record = closedObject(value, CAPABILITY_FIELDS, "the capability");
  if (record.format !== DEPLOYMENT_CAPABILITY_FORMAT) refuse(`format ${JSON.stringify(record.format)}`);

  const rulesIn = closedObject(record.rules, RULES_FIELDS, "rules");
  if (typeof rulesIn.current !== "number" || !Number.isSafeInteger(rulesIn.current) || rulesIn.current < 1) refuse("rules.current is not a version");
  const supported = integerSet(rulesIn.supported, "rules.supported", 1, true);
  const certified = integerSet(rulesIn.certified, "rules.certified", 1, false);
  const current = rulesIn.current as number;
  if (!supported.includes(current)) refuse(`rules.current ${current} is not among rules.supported (a release continues what it deals)`);

  const hosted = integerSet(record.hosted_protocols, "hosted_protocols", 1, true);
  const financial = integerSet(record.financial_protocols, "financial_protocols", 1, false);
  const codecs = stringSet(record.settlement_codecs, "settlement_codecs", CODEC) as readonly EscrowCodecId[];
  const abi = stringSet(record.escrow_abi_checksums, "escrow_abi_checksums", HEX64);
  const clients = integerSet(record.client_protocols, "client_protocols", 0, true);

  if (!Array.isArray(record.escrow_deployments)) refuse("escrow_deployments is not a list");
  const served: ServedDeployment[] = [];
  for (const entry of record.escrow_deployments as unknown[]) {
    const item = closedObject(entry, SERVED_FIELDS, "a served deployment");
    const pin = checkPin(item.pin, "a served deployment's pin");
    const key = deploymentKey(pin);
    if (item.key !== key) refuse(`a served deployment's key ${JSON.stringify(item.key)} is not its pin's key ${JSON.stringify(key)}`);
    if (served.some((other) => other.key === key)) refuse(`the deployment ${key} is served twice`);
    if (!codecs.includes(pin.codec)) refuse(`the deployment ${key} speaks codec ${pin.codec}, which this release does not carry`);
    if (!abi.includes(pin.code_checksum)) refuse(`the deployment ${key} runs code ${pin.code_checksum}, which this release does not speak`);
    served.push(Object.freeze({ key, pin }));
  }
  served.sort((a, b) => byCodeUnit(a.key, b.key));
  /* No escrow deployment served: no money lifecycle runs here, whatever the build could speak. Some served: the
     release must speak a financial protocol for them. So `financial_protocols` has exactly one canonical value for
     a release that serves nothing, and two releases that serve nothing cannot differ in it. */
  if (served.length === 0 && financial.length > 0) refuse("financial_protocols must be empty when no escrow deployment is served");
  if (served.length > 0 && financial.length === 0) refuse("an escrow deployment is served but no financial protocol is spoken");

  return Object.freeze({
    format: DEPLOYMENT_CAPABILITY_FORMAT,
    rules: Object.freeze({ current, supported, certified }),
    hosted_protocols: hosted,
    financial_protocols: financial,
    settlement_codecs: codecs,
    escrow_abi_checksums: abi,
    escrow_deployments: Object.freeze(served),
    client_protocols: clients,
  });
}

/** The exact text the key hashes: `canonicalJson` of the canonical descriptor (keys sorted recursively, sets sorted). */
export function capabilityCanonicalText(value: DeploymentCapability): string {
  return canonicalJson(deploymentCapability(value));
}

/** The pool's name: `dc1-` + 24 hex of SHA-256 over the canonical text. Depends on nothing but the semantic facts. */
export function compatibilityKey(value: DeploymentCapability): string {
  return COMPATIBILITY_KEY_PREFIX + sha256Hex(capabilityCanonicalText(value)).slice(0, COMPATIBILITY_KEY_HEX_LENGTH);
}

/** The highest hosted protocol: what a new no-money deal is stamped with. */
export function newDealHostedProtocol(capability: DeploymentCapability): number {
  const hosted = deploymentCapability(capability).hosted_protocols;
  return hosted[hosted.length - 1];
}

/* ------------------------------------------------------------------ */
/* Diagnostics: exact, and never part of the key                       */
/* ------------------------------------------------------------------ */

/** Which exact software a release is. Stamped and printed (the deal's `build`, holds, audit lines, frames, the startup
 *  banner, divergence reports), never compared by any continuation or acceptance decision. */
export interface ReleaseDiagnostics {
  readonly build_id: string;
  readonly client_build_id: string;
  readonly commit?: string;
  readonly built_at?: string;
  readonly ui_build_note?: number;
  readonly identity_schema?: number;
  readonly juno_config_format?: string;
  /** Rotated operationally: a rotation is a rolling deploy. */
  readonly keys?: {
    readonly relayer_address?: string;
    readonly settlement_key_ids?: readonly number[];
    readonly admission_pubkey?: string;
  };
}

/** A release: its capability (keyed) and its diagnostics (not). */
export interface ReleaseDescriptor {
  readonly capability: DeploymentCapability;
  readonly diagnostics: ReleaseDiagnostics;
}

/** A release's pool key. Reads the capability and nothing else. */
export function releaseCompatibilityKey(release: ReleaseDescriptor): string {
  return compatibilityKey(release.capability);
}
