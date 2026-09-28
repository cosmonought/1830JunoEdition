// server/src/escrow/escrowPorts.ts
//
// ==================================================================
//  GNOLAND-1: WHAT ESCROW-3 CONSUMES -- ONE BACKEND BUNDLE PER BINDING, SELECTED FROM THE BINDING, NEVER BY game_id
// ==================================================================
//
// Types and two pure functions (settlement-key selection and its config check). No chain client, no KMS client, no
// broadcast: GNOLAND-1 defines the seams; ESCROW-3 implements the Juno side, GNOLAND-4 the Gno side.
//
// The shape, in one breath: the room's immutable `EscrowBindingV2` picks an `EscrowBackend` (registry); the backend
// carries its capabilities (data), its codec (bytes), its transport (chain I/O through durable intents) and its
// deployment policy; the settlement signer is selected from the same binding plus the chain's own signer registry,
// and refuses a digest of any other codec. ESCROW-3's application code is written once against these types.

import type { CodecDigest, EscrowBackendKind, EscrowCodec, EscrowCodecId, SignatureSchemeId } from "../../../frontend/src/gameEngine/escrow/escrowCodec";
import { EscrowInterfaceError, requireDigest } from "../../../frontend/src/gameEngine/escrow/escrowCodec";
import {
  deploymentId,
  type EscrowBindingV2,
  type EscrowCapabilities,
  type EscrowDeployment,
  type EscrowError,
  type EscrowGameView,
  type EscrowIntentV1,
  type EscrowNetworkClass,
  type DeathProof,
  type SignerKeyStatus,
} from "../../../frontend/src/gameEngine/escrow/escrowModel";
import {
  encodeSettlementPayloadV1Hex,
  type BuiltSettlementCoreV1,
  type SettlementPayloadV1,
  type SettlementPayloadV1Wire,
} from "../../../frontend/src/gameEngine/escrow/settlementCoreV1";

/* ------------------------------------------------------------------ */
/* Signatures and signers                                              */
/* ------------------------------------------------------------------ */

/** A signature is never a bare hex string: it names its scheme, the codec and purpose of the digest it signs, and
 *  (for the settlement key) the registry id it will be verified under. */
export interface SchemeSignature {
  readonly scheme: SignatureSchemeId;
  readonly codec: EscrowCodecId;
  readonly purpose: CodecDigest["purpose"];
  readonly digest_hex: string;
  /** Juno: 64 bytes r‖s, low-s. Gno: 64 bytes Ed25519. Lowercase hex. */
  readonly signature_hex: string;
  /** Settlement signatures only: the on-chain registry id (u16). Null for consent signatures. */
  readonly signer_key_id: number | null;
}

/** Application-side verification (sign-then-verify, consent pre-checks). One verifier per scheme; a verifier refuses
 *  a signature object of another scheme before looking at bytes. */
export interface SignatureVerifier {
  readonly scheme: SignatureSchemeId;
  verify(publicKeyHex: string, digest: CodecDigest, signature: SchemeSignature): boolean;
}

/** One configured settlement key: the (backend, chain, deployment, registry id) it may sign for, its scheme, its
 *  KMS handle and the public key the chain registered. A KMS key serves exactly one such tuple. */
export interface SettlementKeyConfig {
  readonly backend: EscrowBackendKind;
  readonly chain_id: string;
  /** Contract address / realm package path (`deploymentId`). */
  readonly deployment_id: string;
  readonly signer_key_id: number;
  readonly scheme: SignatureSchemeId;
  /** e.g. an AWS KMS key ARN: secp256k1 (ECC_SECG_P256K1, ECDSA_SHA_256, DIGEST) for Juno; Ed25519
   *  (ECC_NIST_EDWARDS25519, ED25519_SHA_512, RAW) for Gno. Never shared across backends. */
  readonly kms_key_ref: string;
  readonly public_key_hex: string;
  /** Exactly one `active` entry per (backend, chain, deployment); `standby` entries are pre-registered rotation
   *  targets that sign nothing until promoted by configuration. */
  readonly role: "active" | "standby";
}

/**
 * Signs settlement payloads with one KMS key. The signer never accepts a bare digest (a 32-byte label is not
 * provenance): it takes the BUILT payload, re-derives the digest itself (`settlementDigestToSign`), reserves it in
 * the external signing journal, and only then calls KMS. Implementations: Juno (KMS DIGEST mode → DER → r‖s →
 * low-s) and Gno (KMS RAW Ed25519 over the 32-byte digest). Both verify their own output against
 * `key.public_key_hex` before returning.
 */
export interface SettlementSigner {
  readonly key: SettlementKeyConfig;
  readonly codec: EscrowCodec<unknown>;
  signPayload(input: { readonly instance: string; readonly built: BuiltSettlementCoreV1; readonly frozen_domain: string }): Promise<SchemeSignature>;
}

/**
 * The digest a settlement signer may sign for `built`, or a refusal. Re-encodes the payload and re-derives the SETTLE
 * digest with the signer's own codec (never trusting `built.settle`), and requires: the payload names this key's
 * registry id; the payload's domain is the game's frozen domain; the codec is the key's backend's.
 */
export function settlementDigestToSign(
  key: SettlementKeyConfig,
  codec: EscrowCodec<unknown>,
  built: BuiltSettlementCoreV1,
  frozenDomain: string,
): CodecDigest<"settle"> {
  if (codec.backend !== key.backend || codec.settlementScheme !== key.scheme) refuseSelection(`a ${key.backend}/${key.scheme} key cannot sign for codec ${codec.id}`);
  if (built.codec !== codec.id) throw new EscrowInterfaceError("CODEC_MISMATCH", `the payload was built for ${built.codec}, the key serves ${codec.id}`);
  if (built.payload.signer_key_id !== key.signer_key_id) refuseSelection(`the payload names signer key ${built.payload.signer_key_id}, this key is ${key.signer_key_id}`);
  if (built.payload.domain !== frozenDomain) refuseSelection("the payload's domain is not the game's frozen domain");
  const digest = codec.settleDigest(encodeSettlementPayloadV1Hex(built.payload));
  return requireDigest(digest, codec.id, "settle", "the re-derived digest");
}

/**
 * GNOLAND-1 review fix (F1): a monotone record of everything ever signed or submitted, kept OUTSIDE the game store's
 * restore domain (a separate table in a separate account, or an object-locked bucket), written conditionally
 * BEFORE each KMS call and before each broadcast. A point-in-time restore of the game store rolls back `LOG#`,
 * `CKPT#` and `INTENT#` together; it cannot roll this back, so a restored game whose log is behind the journal (or
 * behind the chain's own `last_seq`) is HELD instead of re-signing a different history at a signed seq.
 */
export interface SigningJournal {
  /** First writer wins per (instance, seq, signer_key_id). `same`: this exact digest was already reserved. */
  reserveSettlement(entry: {
    readonly instance: string;
    readonly seq: string;
    readonly signer_key_id: number;
    readonly digest: CodecDigest<"settle">;
  }): Promise<{ readonly kind: "reserved" | "same" } | { readonly kind: "conflict"; readonly digest_hex: string }>;
  /** Every signed transaction attempt (tx id, account, sequence), before it is broadcast. ESCROW-3B: and the height after
   *  which it can never be included (its `timeout_height`), so a restart can PROVE a forgotten attempt dead. */
  recordAttempt(entry: { readonly intent_id: string; readonly tx_id: string; readonly account: string; readonly account_sequence: string; readonly expires_after_height?: string }): Promise<void>;
  /** The highest seq ever reserved for an instance (the restore check compares `log_len` with `seq >> 1`). */
  highestReserved(instance: string): Promise<{ readonly seq: string } | null>;
}

const refuseSelection = (detail: string): never => {
  throw new EscrowInterfaceError("SIGNER_SELECTION_REFUSED", detail);
};

/**
 * Configuration check, run at startup: every KMS key and every public key serves exactly one backend and scheme,
 * each (backend, chain, deployment) has at most one active key, and every scheme is the backend's. A Juno key can
 * therefore never be configured for Gno (or the reverse), and two backends can never share key material.
 */
export function checkSettlementKeyConfig(config: readonly SettlementKeyConfig[], capabilities: readonly EscrowCapabilities[]): void {
  const schemeOf = new Map<EscrowBackendKind, SignatureSchemeId>();
  for (const caps of capabilities) schemeOf.set(caps.backend, caps.settlementScheme);
  const seenKms = new Set<string>();
  const seenPub = new Set<string>();
  const seenId = new Set<string>();
  const active = new Set<string>();
  for (const entry of config) {
    const scheme = schemeOf.get(entry.backend);
    if (scheme === undefined) refuseSelection(`no capabilities for backend ${entry.backend}`);
    if (entry.scheme !== scheme) refuseSelection(`${entry.kms_key_ref}: scheme ${entry.scheme} is not ${entry.backend}'s ${scheme}`);
    const tuple = JSON.stringify([entry.backend, entry.chain_id, entry.deployment_id]);
    /* One KMS key, one public key: exactly one (backend, chain, deployment, registry id). A testnet stack can never
       hold a key that also signs mainnet, and two backends can never share key material. */
    if (seenKms.has(entry.kms_key_ref)) refuseSelection(`KMS key ${entry.kms_key_ref} is configured more than once`);
    if (seenPub.has(entry.public_key_hex)) refuseSelection("one public key is configured more than once");
    const slot = JSON.stringify([entry.backend, entry.chain_id, entry.deployment_id, entry.signer_key_id]);
    if (seenId.has(slot)) refuseSelection(`registry id ${entry.signer_key_id} is configured twice for ${tuple}`);
    seenKms.add(entry.kms_key_ref);
    seenPub.add(entry.public_key_hex);
    seenId.add(slot);
    if (entry.role === "active") {
      if (active.has(tuple)) refuseSelection(`two active settlement keys for ${tuple}`);
      active.add(tuple);
    }
  }
}

/**
 * Selects the settlement key for one game FROM ITS BINDING and the chain's registry -- never from `game_id`:
 *   1. the configured ACTIVE key for (binding.backend, binding.network.chain_id, deploymentId(binding.deployment));
 *   2. its scheme is the backend's settlement scheme;
 *   3. the chain's registry holds that id with that exact public key, and not retired or compromised.
 * Anything else refuses; there is no fallback key.
 */
export function selectSettlementKey(
  binding: EscrowBindingV2,
  capabilities: EscrowCapabilities,
  registry: readonly SignerKeyStatus[],
  config: readonly SettlementKeyConfig[],
): SettlementKeyConfig {
  if (capabilities.backend !== binding.backend) refuseSelection(`capabilities are ${capabilities.backend}, the binding is ${binding.backend}`);
  const deployment = deploymentId(binding.deployment);
  const candidates = config.filter(
    (entry) =>
      entry.role === "active" &&
      entry.backend === binding.backend &&
      entry.chain_id === binding.network.chain_id &&
      entry.deployment_id === deployment,
  );
  if (candidates.length !== 1) refuseSelection(`${candidates.length} active keys configured for ${binding.backend}|${binding.network.chain_id}|${deployment}`);
  const key = candidates[0];
  if (key.scheme !== capabilities.settlementScheme) refuseSelection(`key scheme ${key.scheme} is not ${capabilities.settlementScheme}`);
  const onChain = registry.filter((entry) => entry.signer_key_id === key.signer_key_id);
  if (onChain.length !== 1) refuseSelection(`signer key ${key.signer_key_id} is not in the deployment's registry`);
  if (onChain[0].scheme !== key.scheme || onChain[0].public_key_hex !== key.public_key_hex) {
    refuseSelection(`the registry's key ${key.signer_key_id} is not the configured public key`);
  }
  if (onChain[0].status !== "active") refuseSelection(`signer key ${key.signer_key_id} is ${onChain[0].status}`);
  /* Every key the chain would accept must be one this server knows: an active registry key that is not configured
     for this deployment is an unmonitored signer (a leaked or forgotten key) -- HOLD and alert, never sign around it.
     `registry` must be the COMPLETE registry (page the query to its end; ESCROW-2 pages at 30 of up to 64). */
  const known = new Set(config.filter((entry) => entry.backend === binding.backend && entry.chain_id === binding.network.chain_id && entry.deployment_id === deployment).map((entry) => entry.signer_key_id));
  const unknownActive = registry.filter((entry) => entry.status === "active" && !known.has(entry.signer_key_id));
  if (unknownActive.length > 0) refuseSelection(`the registry has active keys this server does not hold: ${unknownActive.map((entry) => entry.signer_key_id).join(",")}`);
  return key;
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

export interface NetworkStatus {
  readonly chain_id: string;
  readonly latest_height: string;
  readonly latest_block_time: string;
  /** A node still syncing, or a height older than policy allows, is unavailable for preconditions. */
  readonly healthy: boolean;
}

/** A consent signature for one seat, as the relayer forwards it (verified against the chain's CURRENT consent key
 *  for that seat before it is relayed). */
export interface SeatConsent {
  readonly seat_index: number;
  readonly signature: SchemeSignature;
}

/** Relayer operations, backend-neutral. Each adapter maps them to its native call (a CosmWasm execute message, a Gno
 *  MsgCall); nothing above the adapter sees JSON messages, function names or coin strings. */
export type RelayerOp =
  | { readonly kind: "start"; readonly roster_hash: string }
  | { readonly kind: "checkpoint"; readonly payload: SettlementPayloadV1; readonly signature: SchemeSignature }
  | { readonly kind: "settle"; readonly payload: SettlementPayloadV1; readonly signature: SchemeSignature; readonly consents: readonly SeatConsent[] }
  | { readonly kind: "relay-consent"; readonly consent: SeatConsent }
  | { readonly kind: "finalize" }
  | { readonly kind: "annul-by-consent"; readonly consents: readonly SeatConsent[] };

/** Player-wallet actions. The server builds the request; the player's wallet signs and pays. */
export type WalletAction =
  | { readonly kind: "create"; readonly max_players: number; readonly mode: 0 | 1; readonly consent_public_key_hex: string; readonly join_ticket_hex: string }
  | { readonly kind: "join"; readonly consent_public_key_hex: string; readonly join_ticket_hex: string }
  | { readonly kind: "withdraw" }
  | { readonly kind: "cancel" }
  | { readonly kind: "rotate-consent-key"; readonly new_public_key_hex: string }
  | { readonly kind: "challenge"; readonly evidence_hash: string }
  | { readonly kind: "liveness-settle"; readonly checkpoint: { readonly payload: SettlementPayloadV1; readonly signature: SchemeSignature } | null }
  | { readonly kind: "bind-proof"; readonly nonce_hex: string };

/** What the client's wallet adapter needs. `native` is opaque above the adapter pair (server adapter ↔ client
 *  wallet adapter): Keplr and Adena concepts never enter shared objects. */
export interface WalletRequest {
  readonly backend: EscrowBackendKind;
  readonly chain_id: string;
  /**
   * GNOLAND-1 review fix (F4): the neutral TARGET of the request. The client's wallet adapter checks it against a
   * deployment allowlist PINNED IN THE CLIENT BUILD (never supplied by the server) and against the native payload it
   * decodes before signing; any disagreement refuses. A compromised server therefore cannot point a deposit at
   * another contract or realm.
   */
  readonly target: { readonly deployment_id: string; readonly chain_game_id: string | null };
  readonly action: WalletAction["kind"];
  /** Funds the call must carry, exactly (base units). Null for a non-payable call. */
  readonly attach: { readonly amount: string; readonly denom: string } | null;
  /** The player pays gas unless the backend has fee grants AND policy grants this action. */
  readonly fee_payer: "player" | "operator-grant";
  /** Gno payable calls must be signed and sent by the paying EOA directly (no MsgRun, no intermediary). */
  readonly direct_call_required: boolean;
  readonly native: unknown;
}

/** One attempt's inclusion, as the chain answers it. Timers never produce `dead`. */
export type InclusionStatus =
  | { readonly kind: "included"; readonly success: true; readonly height: string }
  | { readonly kind: "included"; readonly success: false; readonly height: string; readonly error: EscrowError }
  | { readonly kind: "pending" }
  | { readonly kind: "dead"; readonly proof: DeathProof }
  | { readonly kind: "unknown"; readonly reason: string };

/** Durable, epoch-fenced persistence of an attempt: ESCROW-3 passes the LIVE-3 intent store's conditional write. */
export type PersistAttempt = (intent: EscrowIntentV1) => Promise<void>;

export interface EscrowTransport {
  readonly backend: EscrowBackendKind;
  network(): Promise<NetworkStatus>;
  /** Reads the deployment's identity facts FROM THE CHAIN (code id/checksum/admin/cw2; realm path/private
   *  flag/creator/package digest). Never echoes configuration. */
  readDeployment(expected: { readonly chain_id: string; readonly deployment_id: string }): Promise<EscrowDeployment>;
  readGame(binding: EscrowBindingV2): Promise<EscrowGameView | null>;
  readSignerRegistry(binding: EscrowBindingV2): Promise<readonly SignerKeyStatus[]>;
  walletRequest(binding: EscrowBindingV2, action: WalletAction): WalletRequest;
  /**
   * Signs the relayer transaction, calls `persist` with the attempt in phase `signed` (tx id, account sequence and
   * expiry known) and only after `persist` resolves broadcasts it. If `persist` rejects, nothing is broadcast.
   */
  submit(intent: EscrowIntentV1, op: RelayerOp, persist: PersistAttempt): Promise<EscrowIntentV1>;
  /** Where an attempt stands. `dead` only with a proof (expiry passed, or the account sequence consumed). */
  inclusion(intent: EscrowIntentV1): Promise<InclusionStatus>;
  /** Makes a stuck attempt provably dead by consuming its account sequence with a different transaction (a
   *  sequence burn). Mandatory: it is the only proof on a backend without tx expiry, and the fallback on one with. */
  consumeSequence(intent: EscrowIntentV1, persist: PersistAttempt): Promise<EscrowIntentV1>;
  classify(nativeError: unknown): EscrowError;
}

/** Deployment acceptance: product policy over chain-read facts (Juno: code checksum allowlist, admin null or the
 *  admin multisig; Gno: non-private on mainnet, expected creator, package digest allowlist). */
export type DeploymentPolicy = (facts: EscrowDeployment, network: EscrowNetworkClass) => { readonly ok: true } | { readonly ok: false; readonly error: EscrowError };

/** Everything ESCROW-3 needs for one backend. */
export interface EscrowBackend<I = unknown> {
  readonly kind: EscrowBackendKind;
  /** One backend bundle per chain: its transport talks to this chain only and asserts the chain id it reads. */
  readonly chain_id: string;
  readonly capabilities: EscrowCapabilities;
  readonly codec: EscrowCodec<I>;
  readonly transport: EscrowTransport;
  readonly acceptDeployment: DeploymentPolicy;
  /** The only place a binding becomes this backend's domain inputs. */
  domainInputs(binding: EscrowBindingV2, rosterHash: string): I;
  verifier(scheme: SignatureSchemeId): SignatureVerifier;
}

/** The server's backends, looked up from a binding. A backend that is not enabled answers WRONG_BACKEND. */
export interface EscrowBackendRegistry {
  forBinding(binding: EscrowBindingV2): EscrowBackend;
}

/* ------------------------------------------------------------------ */
/* The neutral status the client needs (no wallet concepts)             */
/* ------------------------------------------------------------------ */

/**
 * GNOLAND-1 review fix (F4): what a player's client needs to consent WITHOUT trusting the server. Fast consent pays
 * out at once (no window, no resolver), so the client re-derives the payload from its own replay of the log
 * (`verifySettlementCoreV1` at `appraisal_log_len`), recomputes the domain from the binding facts and its pinned
 * deployment list, checks its own wallet sits at its `chain_seat_index` in the roster, and only then signs the
 * CONSENT digest it computed itself.
 */
export interface ConsentRequest {
  readonly codec: EscrowCodecId;
  readonly instance: string;
  readonly payload: SettlementPayloadV1Wire;
  readonly roster: readonly { readonly chain_seat_index: number; readonly player_id: string; readonly payout_address: string }[];
  readonly domain: string;
  readonly seat_index: number;
}

export interface EscrowStatusForClient {
  readonly backend: EscrowBackendKind;
  readonly network: { readonly chain_id: string; readonly network_class: EscrowNetworkClass };
  readonly asset: { readonly symbol: string; readonly exponent: number };
  readonly state: EscrowGameView["state"];
  readonly paused: boolean;
  /** Per seat, by player_id (principals never leave the server). */
  readonly seats: readonly { readonly player_id: string; readonly funded: boolean; readonly consented: boolean }[];
  readonly deadlines: EscrowGameView["deadlines"];
  /** What the viewer's wallet must do next, if anything. */
  readonly action_required: WalletRequest | null;
  /** A settlement awaiting this viewer's consent, with the material to verify it independently. */
  readonly consent_request: ConsentRequest | null;
  /** The frozen roster and domain (after the freeze), so a client can check its own seat and payout address. */
  readonly roster: readonly { readonly chain_seat_index: number; readonly player_id: string; readonly payout_address: string }[] | null;
  readonly domain: string | null;
  /** Capability notices (e.g. "you pay your own gas", "desktop wallet only"), as stable codes the UI words. */
  readonly notices: readonly ("player-pays-gas" | "no-message-signing" | "settlement-compromised-resolver-required" | "paused")[];
  readonly last_error: EscrowError["code"] | null;
}
