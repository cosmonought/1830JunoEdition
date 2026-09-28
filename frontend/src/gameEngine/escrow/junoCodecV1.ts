// frontend/src/gameEngine/escrow/junoCodecV1.ts
//
// ==================================================================
//  GNOLAND-1: THE JUNO CODEC -- A PURE DELEGATION TO THE CERTIFIED SET-0C FUNCTIONS
// ==================================================================
//
// Every byte this codec produces is produced by the frozen SET-0C function that already produced it before
// GNOLAND-1 (`rosterHashV1`, `settlementDomainV1`, `settleDigestOfEncodedHex`, `consentDigestV1`, `annulDigestV1`).
// Nothing is re-implemented; nothing is renamed; the `18JUNO/*/v1` tags are SET-0C's constants. The only code of its
// own is (a) the tagged-digest guard, (b) the one-read copy of the domain inputs that `buildSettlementPayloadV1`
// also makes, and (c) the address rule `addressField` applies (repeated here because SET-0C does not export it; the
// oracle test pins the two to the same accept/refuse set). escrowJunoRegressionOracle.test.ts proves the identity
// against the frozen vector files.

import {
  SettlementPayloadError,
  annulDigestV1,
  consentDigestV1,
  rosterHashV1,
  settleDigestOfEncodedHex,
  settlementDomainV1,
  type SettlementDomainInputs,
} from "../settlementPayload";
import {
  codecCommitment,
  codecDigest,
  requireDigest,
  requireSeatIndex,
  type CodecCommitment,
  type CodecDigest,
  type DomainBinding,
  type EscrowCodec,
} from "./escrowCodec";
import type { EscrowBackendKind, JoinAdmissionInput } from "./escrowCodec";
import { joinAdmissionDigestV1 } from "./junoJoinAdmissionV1";
import type { EscrowBindingV2, EscrowError, EscrowErrorCode, JunoDeploymentV1 } from "./escrowModel";
import { ESCROW_ERROR_RETRY } from "./escrowModel";

const ID = "18JUNO/v1" as const;

/** The eight domain-input fields, in `crypto::DomainInputs` order (the same list `buildSettlementPayloadV1` reads). */
const JUNO_DOMAIN_FIELDS: readonly string[] = Object.freeze([
  "chain_id",
  "contract_addr",
  "chain_game_id",
  "roster_hash",
  "rules_engine_version",
  "variants_digest",
  "ante_gross",
  "mode",
]);

/** SET-0A rev-1 names `buildSettlementPayloadV1` refuses by name inside any object it reads field by field. */
const STALE_FIELDS: readonly string[] = Object.freeze(["terminal_state_hash", "net_worth", "state_digest"]);

const refuse = (code: "MALFORMED_INPUT" | "MALFORMED_STRING", detail: string): never => {
  throw new SettlementPayloadError(code, detail);
};

/**
 * The domain inputs, copied ONCE from a plain object's own enumerable data properties (no prototype read, no getter,
 * no Proxy trap read twice): the same discipline as SET-0C's `ownDataFields`, with the same refusal code.
 */
function copyDomainInputs(value: unknown): SettlementDomainInputs {
  const out = Object.create(null) as Record<string, unknown>;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("MALFORMED_INPUT", "domain_inputs is not an object");
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) refuse("MALFORMED_INPUT", "domain_inputs is not a plain object");
    const keys = Reflect.ownKeys(value);
    for (let at = 0; at < keys.length; at += 1) {
      const key = keys[at];
      if (typeof key === "symbol") refuse("MALFORMED_INPUT", "domain_inputs has a symbol key");
      const name = key as string;
      if (STALE_FIELDS.indexOf(name) >= 0) refuse("MALFORMED_INPUT", `domain_inputs carries the stale field ${name}`);
      if (JUNO_DOMAIN_FIELDS.indexOf(name) < 0) refuse("MALFORMED_INPUT", `domain_inputs carries an unknown field ${name}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined) refuse("MALFORMED_INPUT", `domain_inputs.${name} vanished while it was read`);
      if (!descriptor!.enumerable) refuse("MALFORMED_INPUT", `domain_inputs.${name} is not enumerable`);
      if (descriptor!.get !== undefined || descriptor!.set !== undefined) refuse("MALFORMED_INPUT", `domain_inputs.${name} is an accessor`);
      out[name] = descriptor!.value;
    }
  } catch (error) {
    if (error instanceof SettlementPayloadError) throw error;
    return refuse("MALFORMED_INPUT", `domain_inputs could not be read (${error instanceof Error ? error.name : "error"})`);
  }
  return Object.freeze(out) as unknown as SettlementDomainInputs;
}

/** SET-0C `addressField`: non-empty, normalised (no upper case), printable ASCII, a u16 length. */
function junoAddress(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) return refuse("MALFORMED_STRING", `${where} is not a non-empty address`);
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < 0x21 || code > 0x7e || (code >= 0x41 && code <= 0x5a)) {
      return refuse("MALFORMED_STRING", `${where} is not a normalised (lower-case, printable ASCII) address`);
    }
  }
  if (value.length > 0xffff) refuse("MALFORMED_STRING", `${where} is ${value.length} bytes; the length prefix is a u16`);
  return value;
}

/** The Juno codec, `18JUNO/v1`: SET-0C / ESCROW-2.x, certified. */
export const JUNO_CODEC_V1: EscrowCodec<SettlementDomainInputs> = Object.freeze({
  id: ID,
  backend: "juno-cosmwasm" as EscrowBackendKind,
  maturity: "certified" as const,
  settlementScheme: "secp256k1-ecdsa-prehashed/rs64-low-s" as const,
  consentScheme: "secp256k1-ecdsa-prehashed/rs64-low-s" as const,
  admissionScheme: "secp256k1-ecdsa-prehashed/rs64-low-s" as const,
  consentBindsSeat: false,
  annulBindsSeat: false,

  canonicalAddress(value: unknown, where: string): string {
    return junoAddress(value, where);
  },

  rosterHash(addresses: readonly string[]): CodecCommitment<"roster"> {
    return codecCommitment(ID, "roster", rosterHashV1(addresses));
  },

  bindDomain(raw: unknown): DomainBinding<SettlementDomainInputs> {
    const inputs = copyDomainInputs(raw);
    const domain = codecCommitment(ID, "domain", settlementDomainV1(inputs));
    return Object.freeze({
      inputs,
      domain,
      roster_hash: inputs.roster_hash,
      rules_engine_version: inputs.rules_engine_version,
    });
  },

  settleDigest(encodedHex: string): CodecDigest<"settle"> {
    return codecDigest(ID, "settle", settleDigestOfEncodedHex(encodedHex));
  },

  consentDigest(args: {
    readonly domain: string;
    readonly seq: bigint;
    readonly settle: CodecDigest<"settle">;
    readonly seat_index: number;
    readonly seat_count: number;
  }): CodecDigest<"consent"> {
    const settle = requireDigest(args.settle, ID, "settle", "consent.settle");
    // Juno v1 binds the seat through its per-seat consent KEY (unique within a game), not in the digest: the seat is
    // range-checked here and deliberately not hashed -- hashing it would move every certified CONSENT digest.
    requireSeatIndex(args.seat_index, args.seat_count, "consent");
    return codecDigest(ID, "consent", consentDigestV1(args.domain, args.seq, settle.hex));
  },

  annulDigest(args: {
    readonly domain: string;
    readonly trusted_seq: bigint;
    readonly seat_index: number;
    readonly seat_count: number;
  }): CodecDigest<"annul"> {
    requireSeatIndex(args.seat_index, args.seat_count, "annul");
    return codecDigest(ID, "annul", annulDigestV1(args.domain, args.trusted_seq));
  },

  /** ESCROW-JOIN: escrow 2.0.0's `crypto::join_admission_digest` (junoJoinAdmissionV1.ts). The deployment is the contract
   *  address; the wallet must already be canonical (the chain's sender is lower-case bech32). */
  joinAdmissionDigest(input: JoinAdmissionInput): CodecDigest<"join-admission"> {
    return codecDigest(
      ID,
      "join-admission",
      joinAdmissionDigestV1({
        chain_id: input.chain_id,
        contract_addr: junoAddress(input.deployment, "join admission deployment"),
        chain_game_id: input.chain_game_id,
        wallet: junoAddress(input.wallet, "join admission wallet"),
        join_ticket: input.join_ticket_hex,
        expires_at: input.expires_at,
      }),
    );
  },

  extensions: Object.freeze({}),
});

/**
 * SET-0C domain inputs from an EscrowBinding v2 and the frozen roster hash. The ONLY place a Juno binding becomes
 * domain bytes, so nothing else can spell the contract address, the ante or the mode differently.
 */
export function junoDomainInputsOf(binding: EscrowBindingV2, rosterHash: string): SettlementDomainInputs {
  if (binding.backend !== "juno-cosmwasm" || binding.deployment.kind !== "juno-cosmwasm") {
    throw new SettlementPayloadError("MALFORMED_INPUT", `a ${binding.backend} binding has no Juno domain`);
  }
  const deployment = binding.deployment as JunoDeploymentV1;
  /* Strict: the binding was validated when it was written, but a domain is never computed from a spelling the
     contract would not produce ("0x7", "", "07" are refused, not coerced by BigInt). */
  const decimal = (value: string, where: string): bigint => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new SettlementPayloadError("MALFORMED_INTEGER", `${where}=${String(value)} is not a canonical decimal`);
    return BigInt(value);
  };
  return {
    chain_id: binding.network.chain_id,
    contract_addr: junoAddress(deployment.contract_address, "contract_address"),
    chain_game_id: decimal(binding.chain_game_id, "chain_game_id"),
    roster_hash: rosterHash,
    rules_engine_version: binding.commitments.rules_engine_version,
    variants_digest: binding.commitments.variants_digest,
    ante_gross: decimal(binding.terms.ante_gross, "ante_gross"),
    mode: binding.terms.mode,
  };
}

/* ------------------------------------------------------------------ */
/* ContractError → neutral error (complete; the oracle test parses error.rs to keep it complete)           */
/* ------------------------------------------------------------------ */

export const JUNO_CONTRACT_ERROR_MAP: Readonly<Record<string, EscrowErrorCode>> = Object.freeze({
  Std: "BACKEND_INVARIANT",
  Unauthorized: "UNAUTHORIZED",
  NotSeated: "UNAUTHORIZED",
  AlreadyJoined: "SEATING_REFUSED",
  GameNotFound: "GAME_NOT_FOUND",
  WrongState: "INVALID_LIFECYCLE",
  Paused: "PAUSED",
  GameFull: "SEATING_REFUSED",
  FundingClosed: "INVALID_LIFECYCLE",
  NonPayable: "UNDERFUNDED",
  InvalidFunds: "UNDERFUNDED",
  BelowMinAnte: "UNDERFUNDED",
  WrongAnte: "UNDERFUNDED",
  WrongBond: "UNDERFUNDED",
  BadMaxPlayers: "REQUEST_INVALID",
  BadLength: "REQUEST_INVALID",
  BadPubkey: "REQUEST_INVALID",
  ConsentKeyInUse: "SEATING_REFUSED",
  RosterHashMismatch: "ROSTER_MISMATCH",
  BadVersion: "PAYLOAD_INVALID",
  DomainMismatch: "DOMAIN_MISMATCH",
  BadKind: "PAYLOAD_INVALID",
  WrongKind: "PAYLOAD_INVALID",
  UnknownReason: "PAYLOAD_INVALID",
  ReasonNotAllowed: "PAYLOAD_INVALID",
  BadSeq: "PAYLOAD_INVALID",
  BadAppraisalLogLen: "PAYLOAD_INVALID",
  SeatCountMismatch: "PAYLOAD_INVALID",
  RosterLengthMismatch: "ROSTER_MISMATCH",
  ZeroSumWeights: "PAYLOAD_INVALID",
  StaleSeq: "STALE_SEQUENCE",
  MalformedPayload: "PAYLOAD_INVALID",
  UnknownSignerKey: "SIGNER_UNKNOWN",
  RetiredSignerKey: "SIGNER_RETIRED",
  CompromisedSettlement: "SIGNER_COMPROMISED",
  BadSignatureLength: "SIGNATURE_INVALID",
  HighS: "SIGNATURE_INVALID",
  InvalidSignature: "SIGNATURE_INVALID",
  SeatIndexOutOfRange: "REQUEST_INVALID",
  DuplicateConsent: "CONSENT_REJECTED",
  InvalidConsent: "CONSENT_REJECTED",
  MissingConsent: "CONSENT_INCOMPLETE",
  WindowOpen: "WINDOW_OPEN",
  WindowClosed: "WINDOW_CLOSED",
  LivenessNotReached: "LIVENESS_NOT_AVAILABLE",
  ResolverTimeoutNotReached: "RESOLVER_TIMEOUT_NOT_REACHED",
  InvalidParams: "ADMIN_REFUSED",
  DuplicateSignerKey: "ADMIN_REFUSED",
  KeyIdsExhausted: "ADMIN_REFUSED",
  Overflow: "BACKEND_INVARIANT",
  Invariant: "BACKEND_INVARIANT",
  MigrateForeignContract: "ADMIN_REFUSED",
  MigrateDowngrade: "ADMIN_REFUSED",
  BadContractVersion: "ADMIN_REFUSED",
  // ESCROW-JOIN (escrow 2.0.0): a Join the server did not admit for this wallet, or admitted too long ago.
  InvalidAdmission: "ADMISSION_REFUSED",
  AdmissionExpired: "ADMISSION_EXPIRED",
  MigrateUnsupported: "ADMIN_REFUSED",
});

/** A Juno `ContractError` (by variant name) as a neutral error. An unknown name is a BACKEND_INVARIANT: the
 *  deployed contract is not the one this server was built for, which is never retried blindly. */
export function junoContractError(variant: string, message: string): EscrowError {
  const code: EscrowErrorCode = Object.prototype.hasOwnProperty.call(JUNO_CONTRACT_ERROR_MAP, variant)
    ? JUNO_CONTRACT_ERROR_MAP[variant]
    : "BACKEND_INVARIANT";
  return Object.freeze({
    code,
    retry: ESCROW_ERROR_RETRY[code],
    native: Object.freeze({ backend: "juno-cosmwasm" as EscrowBackendKind, name: variant, message }),
  });
}
