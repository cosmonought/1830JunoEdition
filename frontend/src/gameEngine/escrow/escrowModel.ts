// frontend/src/gameEngine/escrow/escrowModel.ts
//
// ==================================================================
//  GNOLAND-1: THE CHAIN-NEUTRAL ESCROW MODEL (binding, capabilities, states, actions, errors, intents)
// ==================================================================
//
// Pure data and pure functions. What ESCROW-3's server code and the eventual status UI read, whatever the backend.
// Nothing here talks to a chain, signs, or decides gameplay: the reducer is the only gameplay authority, and nothing
// in this file can carry a chain answer into the game log (a chain answer only ever reaches `record.money`, the
// escrow side of the GameRecord, never `SetupGame` beyond the start binding and never an action).
//
// NAMING. Persisted strings (backend kinds, codec ids, state names, error codes) are spelled once here and never
// change meaning; a new meaning gets a new string.

import {
  codecDigest,
  refuseInterface,
  type CodecDigest,
  type EscrowBackendKind,
  type EscrowCodecId,
  type SignatureSchemeId,
} from "./escrowCodec";
import { sha256HexOfBytes, utf8Bytes } from "../sha256";

/* ------------------------------------------------------------------ */
/* Versions (independent of RULES_ENGINE_VERSION)                      */
/* ------------------------------------------------------------------ */

/** SettlementCoreV1's semantic version: SET-0A rev 2 appraisal + SET-0B policy + SET-0C payload rules. Moves only
 *  when what a payload MEANS moves (never for a new backend, a new rules engine or a new tag namespace). */
export const SETTLEMENT_CORE_VERSION = 1;
/** EscrowBinding's persisted schema. v1 was LIVE-2's reserved `juno-escrow-v1` sketch (never persisted). */
export const ESCROW_BINDING_SCHEMA = 2;
/** The intent record's schema. */
export const ESCROW_INTENT_SCHEMA = 1;

/* ------------------------------------------------------------------ */
/* Capabilities: explicit differences, never fake commonality          */
/* ------------------------------------------------------------------ */

/**
 * What a backend can and cannot do, as data. ESCROW-3 branches on a capability (or calls a strategy), never on the
 * backend's name. A capability a backend lacks is never emulated by weakening a rule: an operation that needs it
 * answers UNSUPPORTED_CAPABILITY.
 */
export interface EscrowCapabilities {
  readonly backend: EscrowBackendKind;
  readonly codec: EscrowCodecId;
  readonly maturity: "certified" | "draft";
  readonly settlementScheme: SignatureSchemeId;
  readonly consentScheme: SignatureSchemeId;
  readonly consentBindsSeat: boolean;
  readonly annulBindsSeat: boolean;
  /** Can the operator pay a player's fees (Cosmos x/feegrant)? Gno: no -- players pay their own gas. */
  readonly feeGrant: boolean;
  /** How a wallet proves it controls an address off-chain. `none`: only an on-chain transaction can. */
  readonly walletMessageSigning: "adr036" | "none";
  /** How an unbound deposit is linked to a player (ESCROW-1.5 §4.7). The join ticket covers the normal path. */
  readonly walletProof: "adr036-signature" | "bind-proof-transaction";
  /** Can a relayer transaction carry a height after which it can never be included? Without it, "provably dead"
   *  needs the relayer's account sequence to be consumed (a sequence-burn transaction), never a timer. */
  readonly txExpiry: "timeout-height" | "none";
  /** How inclusion is learned. Both backends are polled by tx id; Juno can also subscribe. */
  readonly inclusion: "subscribe-or-poll" | "poll-only";
  /** Who may attach funds to a payable call. Gno: the signing EOA directly (GNOLAND-0 G1-G4), never via MsgRun or
   *  an intermediate realm; the wallet request must be a direct call. */
  readonly payableCalls: "any-sender" | "eoa-direct-only";
  /** Where a game's funds sit. `per-game-sub-address`: a compartment address per game (OD-GNO-2). */
  readonly custody: "contract-ledger" | "per-game-sub-address";
  /** The deployment models the backend can have; the ACTUAL one is a verified binding fact. */
  readonly deploymentModels: readonly ("wasm-admin-migratable" | "wasm-immutable" | "realm-immutable" | "realm-private-redeployable")[];
  /** Chain seat positions move while funding (ESCROW-2 `Withdraw` removes a seat and shifts the rest). The
   *  chain_seat_index ↔ player_id map is therefore fixed only at the roster freeze (start intent), never before. */
  readonly seatIndexStableBeforeStart: false;
  /** The largest pool the asset can express (Gno coin amounts are int64). */
  readonly poolBound: "u128" | "i64";
}

export const JUNO_CAPABILITIES_V1: EscrowCapabilities = Object.freeze({
  backend: "juno-cosmwasm",
  codec: "18JUNO/v1",
  maturity: "certified",
  settlementScheme: "secp256k1-ecdsa-prehashed/rs64-low-s",
  consentScheme: "secp256k1-ecdsa-prehashed/rs64-low-s",
  consentBindsSeat: false,
  annulBindsSeat: false,
  feeGrant: true,
  walletMessageSigning: "adr036",
  walletProof: "adr036-signature",
  txExpiry: "timeout-height",
  inclusion: "subscribe-or-poll",
  payableCalls: "any-sender",
  custody: "contract-ledger",
  deploymentModels: Object.freeze(["wasm-admin-migratable", "wasm-immutable"] as const),
  seatIndexStableBeforeStart: false,
  poolBound: "u128",
} as const);

/** GNOLAND-0's findings as a DRAFT capability set: GNOLAND-2/4 confirm each against a pinned toolchain. */
export const GNO_CAPABILITIES_DRAFT: EscrowCapabilities = Object.freeze({
  backend: "gno-realm",
  codec: "18GNO/v1",
  maturity: "draft",
  settlementScheme: "ed25519-pure/sig64",
  consentScheme: "ed25519-pure/sig64",
  consentBindsSeat: true,
  annulBindsSeat: true,
  feeGrant: false,
  walletMessageSigning: "none",
  walletProof: "bind-proof-transaction",
  txExpiry: "none",
  inclusion: "poll-only",
  payableCalls: "eoa-direct-only",
  custody: "per-game-sub-address",
  deploymentModels: Object.freeze(["realm-immutable", "realm-private-redeployable"] as const),
  seatIndexStableBeforeStart: false,
  poolBound: "i64",
} as const);

/* ------------------------------------------------------------------ */
/* EscrowBinding v2: the write-once identity of `record.money`          */
/* ------------------------------------------------------------------ */

export type EscrowNetworkClass = "mainnet" | "testnet" | "local";

/** A CosmWasm deployment, as verified from the chain at bind time (never from configuration alone). */
export interface JunoDeploymentV1 {
  readonly kind: "juno-cosmwasm";
  /** Bech32, lowercase, exactly as `env.contract.address` spells it (it is hashed into the domain). */
  readonly contract_address: string;
  /** u64 decimal. */
  readonly code_id: string;
  /** SHA-256 of the stored wasm as the chain reports it (32 bytes, lowercase hex). */
  readonly code_checksum: string;
  /** cw2 `ContractVersion`. */
  readonly contract_name: string;
  readonly contract_version: string;
  /** The wasm admin (who can `migrate`), or null. Accepted values are product policy, re-verified before every
   *  relayer submission: a migration under a live game is a DEPLOYMENT_MISMATCH hold, never followed silently. */
  readonly admin: string | null;
}

/** A Gno realm deployment (DRAFT: GNOLAND-2 fixes how each fact is read and hashed). */
export interface GnoDeploymentDraft {
  readonly kind: "gno-realm";
  /** e.g. `gno.land/r/<namespace>/escrow/v1`: hashed into the domain. */
  readonly realm_pkgpath: string;
  /** The realm's derived address: hashed into the domain. */
  readonly realm_address: string;
  /** OD-GNO-5: production requires `false` (non-private realms are immutable). Read from the deployed
   *  `gnomod.toml` (vm/qfile), never assumed. */
  readonly private_realm: boolean;
  /** The deployer, read from the chain. */
  readonly creator: string;
  /** Digest of the deployed package files (GNOLAND-2 defines the exact construction). */
  readonly package_digest: string;
}

export type EscrowDeployment = JunoDeploymentV1 | GnoDeploymentDraft;

/** The asset the pool is held in. `denom` is the chain's base denomination; amounts are base-unit integers. */
export interface EscrowAsset {
  readonly denom: string;
  /** Display exponent (6 for ujuno and ugnot). Never used in arithmetic. */
  readonly exponent: number;
  readonly symbol: string;
}

/** Where this game's funds are held. */
export type EscrowCustody =
  | { readonly kind: "contract-ledger" }
  | { readonly kind: "per-game-sub-address"; readonly address: string };

/**
 * The binding's IMMUTABLE half: written once (`money = null` condition), never edited. Everything that decides
 * which chain, which deployment, which game, which asset, which terms and which commitments a settlement can bind.
 * Deliberately absent: `principal_id` (never chain-facing), any KMS key id (keys rotate on chain; the signer is
 * SELECTED from this identity, never stored in it), and any seat position (not stable before the roster freeze).
 */
export interface EscrowBindingV2 {
  readonly binding_schema: 2;
  readonly backend: EscrowBackendKind;
  readonly codec: EscrowCodecId;
  readonly network: { readonly chain_id: string; readonly network_class: EscrowNetworkClass };
  readonly deployment: EscrowDeployment;
  /** The backend's game counter (u64 decimal). Never the LIVE `game_id`. */
  readonly chain_game_id: string;
  readonly custody: EscrowCustody;
  readonly asset: EscrowAsset;
  /** Base-unit decimals, exactly as the chain snapshotted them at CreateGame. */
  readonly terms: {
    readonly ante_gross: string;
    readonly ante_net: string;
    readonly max_players: number;
    /** 0 = live, 1 = async (hashed into the domain). */
    readonly mode: 0 | 1;
  };
  /** The game commitments the domain binds; equal to the record's locked pin and variants. */
  readonly commitments: { readonly rules_engine_version: number; readonly variants_digest: string };
  readonly bound_at: number;
}

/** How a chain seat was tied to a LIVE player_id. Never a principal. */
export type SeatClaimEvidence =
  /** The deposit carried `joinTicketV1(secret, {binding facts, game_id, player_id, wallet})`: the ticket commits to
   *  the wallet, so a ticket copied out of another player's pending Join is worthless for any other wallet. */
  | { readonly kind: "join-ticket"; readonly ticket_hex: string }
  /** An unbound deposit linked afterwards by a proof that names exactly this game, player and wallet. */
  | {
      readonly kind: "wallet-proof";
      readonly method: "adr036-signature" | "bind-proof-transaction";
      readonly proof_hash: string;
      readonly bound_game_id: string;
      readonly bound_player_id: string;
      readonly bound_wallet: string;
    };

/** One funded seat, keyed by its payout address (stable) -- NOT by its chain position (unstable until the freeze). */
export interface EscrowSeatClaim {
  readonly player_id: string;
  readonly payout_address: string;
  readonly evidence: SeatClaimEvidence;
  readonly claimed_at: number;
}

/** The frozen roster: fixed in the start-intent task from ONE chain read, committed with the intent. */
export interface EscrowRosterFreeze {
  /** `roster[i]` is chain seat i. */
  readonly roster: readonly {
    readonly chain_seat_index: number;
    readonly player_id: string;
    readonly payout_address: string;
    /** As read at the freeze; the deal re-reads and compares (a withdraw + rejoin keeps the roster hash). */
    readonly join_ticket_hex: string;
    readonly consent_public_key_hex: string;
  }[];
  /** The codec's roster commitment over `roster[].payout_address` in order. */
  readonly roster_hash: string;
  /** The domain the codec computes for this binding + roster; confirmed equal to the chain's after Start. */
  readonly expected_domain: string;
  readonly frozen_at: number;
}

/** The binding's VERSIONED half (moves with `record_version`, OCC). The chain wins over every cached field. */
export interface EscrowBindingState {
  readonly claims: readonly EscrowSeatClaim[];
  readonly freeze: EscrowRosterFreeze | null;
  /** The latest verified chain read (a cache for display and preconditions; never an authority). */
  readonly chain_status: EscrowStatusCache | null;
}

/** What ESCROW-3 widens `GameRecord.money` to (record_schema 2). */
export interface EscrowMoney {
  readonly binding: EscrowBindingV2;
  readonly state: EscrowBindingState;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX32 = /^[0-9a-f]{64}$/;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const I64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);

const bad = (detail: string): never => refuseInterface("BINDING_INVALID", detail);

function decimalWithin(value: unknown, max: bigint, where: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) return bad(`${where}=${String(value)} is not a canonical decimal`);
  const parsed = BigInt(value);
  if (parsed > max) bad(`${where}=${value} is out of range`);
  return parsed;
}

const CODEC_OF: Readonly<Record<EscrowBackendKind, EscrowCodecId>> = Object.freeze({
  "juno-cosmwasm": "18JUNO/v1",
  "gno-realm": "18GNO/v1",
});

/** Codec maturity. A `draft` codec is bindable only on a `local` network (never testnet, never mainnet). */
export const ESCROW_CODEC_MATURITY: Readonly<Record<EscrowCodecId, "certified" | "draft">> = Object.freeze({
  "18JUNO/v1": "certified",
  "18GNO/v1": "draft",
});

/**
 * The server's PINNED deployment policy, one entry per chain it will bind on (shipped configuration, reviewed like
 * code). The network class comes from here, never from the caller; a deployment is bindable only if every
 * chain-read identity fact equals an accepted rule. This is where the trust roots are named: a Juno wasm `admin`
 * (null = immutable, or the published admin multisig) and a Gno realm's creator.
 */
export interface EscrowNetworkPolicy {
  readonly backend: EscrowBackendKind;
  readonly chain_id: string;
  readonly network_class: EscrowNetworkClass;
  readonly deployments: readonly EscrowDeploymentRule[];
}

export type EscrowDeploymentRule =
  | {
      readonly kind: "juno-cosmwasm";
      readonly contract_address: string;
      /** Accepted wasm checksums (an admin migration to any other code makes the binding invalid). */
      readonly code_checksums: readonly string[];
      /** The exact admin required: null (no one can migrate) or the published admin multisig. */
      readonly admin: string | null;
    }
  | {
      readonly kind: "gno-realm";
      readonly realm_pkgpath: string;
      readonly realm_address: string;
      readonly creator: string;
      readonly package_digests: readonly string[];
      /** OD-GNO-5: only ever true for a `local` network. */
      readonly private_realm_allowed: boolean;
    };

export type EscrowDeploymentPolicy = readonly EscrowNetworkPolicy[];

/**
 * The rules every persisted binding must satisfy, against the pinned policy:
 *  - identity is consistent (backend ↔ codec ↔ deployment kind), and a draft codec only binds on `local`;
 *  - the chain is one the policy names for this backend, and the declared network class is the policy's;
 *  - the deployment's chain-read facts equal an accepted rule (Juno: address, wasm checksum, exact admin; Gno: path,
 *    address, creator, package digest, non-private unless the rule allows it on `local`);
 *  - amounts are canonical and within the backend's bound (Gno coin amounts are int64).
 * The facts themselves come from the transport's `readDeployment` (a chain read), never from configuration.
 */
export function validateEscrowBindingV2(binding: EscrowBindingV2, policy: EscrowDeploymentPolicy): EscrowBindingV2 {
  if (typeof binding !== "object" || binding === null) return bad("the binding is not an object");
  if (binding.binding_schema !== ESCROW_BINDING_SCHEMA) bad(`binding_schema ${String(binding.binding_schema)}`);
  const expectedCodec = CODEC_OF[binding.backend];
  if (expectedCodec === undefined) bad(`unknown backend ${String(binding.backend)}`);
  if (binding.codec !== expectedCodec) bad(`backend ${binding.backend} does not use codec ${String(binding.codec)}`);
  if (binding.deployment === null || typeof binding.deployment !== "object" || binding.deployment.kind !== binding.backend) {
    bad(`the deployment is not a ${binding.backend} deployment`);
  }
  const chainId = binding.network?.chain_id;
  if (typeof chainId !== "string" || chainId.length === 0 || chainId.length > 64 || !/^[\x21-\x7e]+$/.test(chainId)) bad("chain_id");
  const rules = policy.filter((entry) => entry.backend === binding.backend && entry.chain_id === chainId);
  if (rules.length !== 1) bad(`the policy names ${rules.length} entries for ${binding.backend} on ${chainId}`);
  const network = rules[0];
  if (binding.network.network_class !== network.network_class) bad(`network_class ${String(binding.network.network_class)} is not the policy's ${network.network_class}`);
  if (ESCROW_CODEC_MATURITY[binding.codec] !== "certified" && network.network_class !== "local") {
    bad(`codec ${binding.codec} is a draft; drafts bind only on a local network`);
  }
  decimalWithin(binding.chain_game_id, U64_MAX, "chain_game_id");
  const poolMax = binding.backend === "gno-realm" ? I64_MAX : U128_MAX;
  const gross = decimalWithin(binding.terms?.ante_gross, poolMax, "terms.ante_gross");
  const net = decimalWithin(binding.terms.ante_net, poolMax, "terms.ante_net");
  if (net > gross || net === BigInt(0)) bad("terms.ante_net must be positive and at most ante_gross");
  const max = binding.terms.max_players;
  if (!Number.isInteger(max) || max < 2 || max > 7) bad(`terms.max_players ${String(max)}`);
  if (gross * BigInt(max) > poolMax) bad("the full pool does not fit the backend's amount bound");
  if (binding.terms.mode !== 0 && binding.terms.mode !== 1) bad(`terms.mode ${String(binding.terms.mode)}`);
  const pin = binding.commitments?.rules_engine_version;
  if (!Number.isInteger(pin) || pin < 1 || pin > 0xffffffff) bad(`rules_engine_version ${String(pin)}`);
  if (!HEX32.test(String(binding.commitments.variants_digest))) bad("variants_digest");
  if (binding.backend === "juno-cosmwasm") {
    const d = binding.deployment as JunoDeploymentV1;
    if (typeof d.contract_address !== "string" || !/^[\x21-\x40\x5b-\x7e]+$/.test(d.contract_address)) bad("contract_address");
    decimalWithin(d.code_id, U64_MAX, "code_id");
    if (!HEX32.test(String(d.code_checksum))) bad("code_checksum");
    if (binding.custody.kind !== "contract-ledger") bad("Juno custody is the contract ledger");
    const accepted = network.deployments.some(
      (rule) =>
        rule.kind === "juno-cosmwasm" &&
        rule.contract_address === d.contract_address &&
        rule.code_checksums.indexOf(d.code_checksum) >= 0 &&
        rule.admin === d.admin,
    );
    if (!accepted) bad("the Juno deployment (address, wasm checksum, admin) is not one the policy accepts");
  } else {
    const d = binding.deployment as GnoDeploymentDraft;
    if (typeof d.realm_pkgpath !== "string" || d.realm_pkgpath.length === 0) bad("realm_pkgpath");
    if (typeof d.realm_address !== "string" || d.realm_address.length === 0) bad("realm_address");
    if (typeof d.private_realm !== "boolean") bad("private_realm must be a verified boolean");
    if (binding.custody.kind !== "per-game-sub-address") bad("Gno custody is a per-game sub-address (OD-GNO-2)");
    const accepted = network.deployments.some(
      (rule) =>
        rule.kind === "gno-realm" &&
        rule.realm_pkgpath === d.realm_pkgpath &&
        rule.realm_address === d.realm_address &&
        rule.creator === d.creator &&
        rule.package_digests.indexOf(d.package_digest) >= 0 &&
        (!d.private_realm || (rule.private_realm_allowed && network.network_class === "local")),
    );
    if (!accepted) bad("OD-GNO-5: the Gno realm (path, address, creator, package, private flag) is not one the policy accepts");
  }
  return binding;
}

/** The deployment's identity string: the contract address or the realm package path. */
export function deploymentId(deployment: EscrowDeployment): string {
  return deployment.kind === "juno-cosmwasm" ? deployment.contract_address : deployment.realm_pkgpath;
}

/** Length-prefixed join: injective whatever the parts contain (a `|` in a chain id cannot forge another key). */
const framed = (parts: readonly string[]): string => parts.map((part) => `${part.length}:${part}`).join("|");

/**
 * The ONE key that names an escrow game instance: backend, network, deployment and backend game id. Signer
 * selection, intent keys and chain caches are keyed by this, never by `game_id` alone and never by
 * `chain_game_id` alone (two deployments -- or two chains -- both have a game 1).
 */
export function escrowInstanceKey(binding: EscrowBindingV2): string {
  return framed([binding.backend, binding.network.chain_id, deploymentId(binding.deployment), binding.chain_game_id]);
}

/* ------------------------------------------------------------------ */
/* Neutral state view                                                 */
/* ------------------------------------------------------------------ */

/** ESCROW-2's eight states, one-to-one on both backends (GNOLAND-0 §7). Terminal: SETTLED, CANCELLED, ANNULLED. */
export type EscrowState = "FUNDING" | "FUNDED" | "IN_PROGRESS" | "SETTLEABLE" | "DISPUTED" | "SETTLED" | "CANCELLED" | "ANNULLED";

export const ESCROW_TERMINAL_STATES: readonly EscrowState[] = Object.freeze(["SETTLED", "CANCELLED", "ANNULLED"]);

/** A signer key as the backend's registry holds it (ids 1..64, never reused). */
export interface SignerKeyStatus {
  readonly signer_key_id: number;
  readonly scheme: SignatureSchemeId;
  readonly public_key_hex: string;
  readonly status: "active" | "retired" | "compromised";
  readonly retired_at: number | null;
}

/** What a backend reports about one game, normalised. `native` keeps the backend's own response for logs. */
export interface EscrowGameView {
  readonly instance: string;
  readonly state: EscrowState;
  /** Global pause (admin). Checkpoint still lands while paused (ESCROW-2.2); most other operations do not. */
  readonly paused: boolean;
  /** Chain order. Before Start the positions are provisional (capabilities.seatIndexStableBeforeStart). */
  readonly seats: readonly {
    readonly chain_seat_index: number;
    readonly payout_address: string;
    readonly consent_public_key_hex: string;
    readonly consent_scheme: SignatureSchemeId;
    /** The join ticket the deposit carried, as the chain stores it (links the seat to an issued LIVE seat). */
    readonly join_ticket_hex: string;
    readonly deposit_gross: string;
    readonly deposit_net: string;
  }[];
  readonly max_players: number;
  readonly mode: 0 | 1;
  readonly rules_engine_version: number;
  readonly variants_digest: string;
  readonly ante_gross: string;
  readonly ante_net: string;
  readonly pool: string;
  /** Frozen at Start. */
  readonly roster_hash: string | null;
  readonly domain: string | null;
  /** ESCROW-2.2: the resolver is snapshotted per game at Start. */
  readonly resolver: string | null;
  readonly last_seq: string;
  /** The sequence authority: highest seq among evidence whose signer key is not compromised (ESCROW-2.1). */
  readonly trusted_seq: string;
  readonly latest_checkpoint: { readonly seq: string; readonly signer_key_id: number; readonly settle_digest: CodecDigest<"settle"> | null } | null;
  /** A stored terminal awaiting consent or the window. `payable` is false when its signer key is compromised
   *  (ESCROW-2.2 `CompromisedSettlement`): only the resolver can move it (Uphold is the deliberate exception). */
  readonly settlement: {
    readonly seq: string;
    readonly reason: number;
    readonly signer_key_id: number;
    readonly payable: boolean;
    readonly consented_seats: readonly number[];
  } | null;
  readonly dispute: { readonly challenger: string; readonly evidence_hash: string; readonly bond: string } | null;
  /** Unix seconds (decimal strings) from the chain's own clock; null when not applicable. */
  readonly deadlines: {
    readonly funding_deadline: string | null;
    readonly challenge_window_end: string | null;
    readonly liveness_available_at: string | null;
    readonly resolver_timeout_at: string | null;
  };
  /** When and where this was read. */
  /** Trust facts OUTSIDE the domain that still decide who can move this game's money: checked against policy at
   *  the freeze (deployment config) and at the deal (the per-game snapshot). */
  readonly trust: {
    readonly denom: string;
    readonly operator: string;
    /** The deployment's resolver now, and (after Start) the resolver snapshotted for this game (ESCROW-2.2). */
    readonly resolver_config: string;
    readonly resolver_game: string | null;
    /** The challenge bond (null before Start) and the windows in seconds, as this game will apply them. */
    readonly bond: string | null;
    readonly challenge_window_secs: string;
    readonly liveness_window_secs: string;
    readonly resolver_timeout_secs: string;
  };
  readonly observed: { readonly height: string; readonly block_time: string };
  readonly native: unknown;
}

/** A cached view (the chain wins; `verified_at` is the server clock when it was read). */
export interface EscrowStatusCache {
  readonly view: EscrowGameView;
  readonly verified_at: number;
}

/* ------------------------------------------------------------------ */
/* Neutral actions                                                    */
/* ------------------------------------------------------------------ */

/** Who submits an action. The role decides the key and the process, never the backend. */
export type EscrowActor = "player-wallet" | "relayer" | "resolver" | "admin";

export type EscrowActionKind =
  // player wallet (built by the server as an opaque WalletRequest; signed and paid by the player)
  | "create"
  | "join"
  | "withdraw"
  | "cancel"
  | "rotate-consent-key"
  | "challenge"
  | "liveness-settle"
  | "bind-proof"
  // relayer (server, through a durable intent)
  | "start"
  | "checkpoint"
  | "settle"
  | "relay-consent"
  | "finalize"
  | "annul-by-consent"
  // resolver (separate process and key)
  | "resolve-uphold"
  | "resolve-replace"
  | "resolve-annul";

export const ESCROW_ACTION_ACTOR: Readonly<Record<EscrowActionKind, EscrowActor>> = Object.freeze({
  create: "player-wallet",
  join: "player-wallet",
  withdraw: "player-wallet",
  cancel: "player-wallet",
  "rotate-consent-key": "player-wallet",
  challenge: "player-wallet",
  "liveness-settle": "player-wallet",
  "bind-proof": "player-wallet",
  start: "relayer",
  checkpoint: "relayer",
  settle: "relayer",
  "relay-consent": "relayer",
  finalize: "relayer",
  "annul-by-consent": "relayer",
  "resolve-uphold": "resolver",
  "resolve-replace": "resolver",
  "resolve-annul": "resolver",
});

/* ------------------------------------------------------------------ */
/* Neutral errors                                                     */
/* ------------------------------------------------------------------ */

/** The application's escrow error vocabulary. UI and retry logic read ONLY these; native detail is for logs. */
export type EscrowErrorCode =
  | "WRONG_BACKEND"
  | "WRONG_NETWORK"
  | "DEPLOYMENT_MISMATCH"
  | "GAME_NOT_FOUND"
  | "INVALID_LIFECYCLE"
  | "PAUSED"
  | "UNAUTHORIZED"
  | "UNDERFUNDED"
  | "SEATING_REFUSED"
  | "ROSTER_MISMATCH"
  | "DOMAIN_MISMATCH"
  | "STALE_SEQUENCE"
  | "PAYLOAD_INVALID"
  | "REQUEST_INVALID"
  | "SIGNATURE_INVALID"
  | "CONSENT_INCOMPLETE"
  | "CONSENT_REJECTED"
  | "SIGNER_UNKNOWN"
  | "SIGNER_RETIRED"
  | "SIGNER_COMPROMISED"
  | "WINDOW_OPEN"
  | "WINDOW_CLOSED"
  | "CHALLENGE_REQUIRED"
  | "RESOLVER_REQUIRED"
  | "RESOLVER_TIMEOUT_NOT_REACHED"
  | "LIVENESS_NOT_AVAILABLE"
  | "TX_REJECTED"
  | "TX_OUTCOME_UNKNOWN"
  | "BACKEND_UNAVAILABLE"
  | "UNSUPPORTED_CAPABILITY"
  | "ADMIN_REFUSED"
  | "BACKEND_INVARIANT";

/**
 * What a caller may do next.
 *  never            a bug or a policy refusal: do not resend the same thing (HOLD for server-originated ops);
 *  after-refresh    re-read the chain, rebuild from the fresh view, then decide (never resend blindly);
 *  after-deadline   wait for a chain deadline (a window, the liveness or resolver timeout), then retry;
 *  backoff          transient (paused, unavailable): retry the SAME intent later;
 *  reconcile-first  the outcome is unknown or the chain disagrees with the record: reconcile before anything.
 */
export type EscrowRetry = "never" | "after-refresh" | "after-deadline" | "backoff" | "reconcile-first";

export interface EscrowError {
  readonly code: EscrowErrorCode;
  readonly retry: EscrowRetry;
  /** The backend's own error, kept for operator logs. Never shown to players, never branched on by the UI. */
  readonly native: { readonly backend: EscrowBackendKind; readonly name: string; readonly message: string };
}

export const ESCROW_ERROR_RETRY: Readonly<Record<EscrowErrorCode, EscrowRetry>> = Object.freeze({
  WRONG_BACKEND: "never",
  WRONG_NETWORK: "never",
  DEPLOYMENT_MISMATCH: "never",
  GAME_NOT_FOUND: "reconcile-first",
  INVALID_LIFECYCLE: "after-refresh",
  PAUSED: "backoff",
  UNAUTHORIZED: "never",
  UNDERFUNDED: "never",
  SEATING_REFUSED: "after-refresh",
  ROSTER_MISMATCH: "reconcile-first",
  DOMAIN_MISMATCH: "never",
  STALE_SEQUENCE: "reconcile-first",
  PAYLOAD_INVALID: "never",
  REQUEST_INVALID: "never",
  SIGNATURE_INVALID: "never",
  CONSENT_INCOMPLETE: "after-refresh",
  /** A seat's consent no longer verifies (its key rotated, or ANNUL signed over a trusted_seq that moved): drop that
   *  signature and re-collect from a fresh read. Never a hold: a player can cause it at will. */
  CONSENT_REJECTED: "after-refresh",
  SIGNER_UNKNOWN: "never",
  SIGNER_RETIRED: "after-refresh",
  SIGNER_COMPROMISED: "never",
  WINDOW_OPEN: "after-deadline",
  WINDOW_CLOSED: "never",
  CHALLENGE_REQUIRED: "never",
  RESOLVER_REQUIRED: "never",
  RESOLVER_TIMEOUT_NOT_REACHED: "after-deadline",
  LIVENESS_NOT_AVAILABLE: "after-deadline",
  TX_REJECTED: "after-refresh",
  TX_OUTCOME_UNKNOWN: "reconcile-first",
  BACKEND_UNAVAILABLE: "backoff",
  UNSUPPORTED_CAPABILITY: "never",
  ADMIN_REFUSED: "never",
  BACKEND_INVARIANT: "reconcile-first",
});

/* ------------------------------------------------------------------ */
/* Idempotent intents (LIVE-3 §11.4 / §19, made backend-neutral)        */
/* ------------------------------------------------------------------ */

/** The relayer operations that go through a durable intent. */
export type EscrowIntentOp = "start" | "checkpoint" | "settle" | "relay-consent" | "finalize" | "annul-by-consent";

/**
 * WHERE an intent lives: one key per logical slot, never per payload. Two different payloads for one slot collide on
 * the key (the conditional put fails) instead of becoming two intents that could both broadcast; the payload's
 * identity is the guarded `subject` attribute, and a different subject at an occupied key is a HOLD, never a second
 * submission. Start has one slot per game instance.
 */
export type EscrowIntentKey =
  | { readonly op: "start" }
  | { readonly op: "checkpoint" | "settle" | "finalize"; readonly seq: string }
  | { readonly op: "relay-consent"; readonly seq: string; readonly seat_index: number }
  | { readonly op: "annul-by-consent"; readonly trusted_seq: string };

/** WHAT the intent submits: the frozen roster hash (start) or the codec digests it relays. */
export type EscrowIntentSubject =
  | { readonly kind: "roster"; readonly roster_hash: string }
  | { readonly kind: "digest"; readonly digests: readonly CodecDigest[] };

/**
 * An intent's lifecycle. The rule that makes restart decidable: the transaction's id (hash), account sequence and
 * expiry are durable in `signed` BEFORE the bytes are broadcast -- in the game store AND in the external signing
 * journal (outside the store's restore domain) -- so no transaction can exist on the network that the record does
 * not name, even after a store rollback. `prepared` with no journal attempt therefore proves "never broadcast".
 */
export type EscrowIntentPhase =
  | "prepared" // preconditions checked, nothing signed: provably never broadcast (journal agrees)
  | "signed" // tx bytes signed, id + account sequence + expiry durable; may or may not have been broadcast
  | "broadcast" // handed to a node (CheckTx answer recorded when there was one)
  | "included-success" // in a block, succeeded: its effect is on chain
  | "included-failure" // in a block, failed: classified; its account sequence is consumed
  | "dead" // provably never includable, with the proof
  | "held"; // the chain contradicts the intent (e.g. another payload at this seq): operator/resolver

/**
 * Why a transaction can never be included. Timers, "not found" answers and failed preconditions are never proof.
 *  expiry-passed      a height beyond the attempt's timeout was observed AND at that height the relayer account's
 *                     next sequence was still the attempt's (so nothing with that sequence was included);
 *  sequence-consumed  the attempt's account sequence was used by an identified, different transaction (for a
 *                     backend without tx expiry, the relayer burns the sequence deliberately to obtain this);
 *  never-signed       the intent never reached `signed` in the store nor in the external journal.
 */
export type DeathProof =
  | { readonly kind: "never-signed" }
  | {
      readonly kind: "expiry-passed";
      readonly timeout_height: string;
      readonly observed_height: string;
      readonly attempt_sequence: string;
      readonly account_next_sequence_at_observed: string;
    }
  | { readonly kind: "sequence-consumed"; readonly account_sequence: string; readonly consumed_by_tx: string; readonly consumed_at_height: string };

export interface EscrowIntentV1 {
  readonly intent_schema: 1;
  /** Deterministic: `intentIdOf(instance, key)`. The store's conditional-put key. */
  readonly intent_id: string;
  /** LIVE durable id: the game this intent belongs to (and the actor it is fenced by). */
  readonly game_id: string;
  /** `escrowInstanceKey(binding)`. */
  readonly instance: string;
  readonly key: EscrowIntentKey;
  /** Guarded: fixed at creation; a different subject for this key is a HOLD. */
  readonly subject: EscrowIntentSubject;
  /** Preconditions read from the chain before `prepared`: the states it may run in and the trusted seq seen. */
  readonly expected: { readonly states: readonly EscrowState[]; readonly trusted_seq: string | null };
  /** Which role submits (and therefore which key and account). */
  readonly submitter: "relayer" | "resolver";
  /** Attempts in order; at most one is ever not terminal (signed/broadcast). */
  readonly attempts: readonly {
    readonly tx_id: string | null;
    readonly account: string;
    readonly account_sequence: string | null;
    readonly expiry: { readonly kind: "timeout-height"; readonly height: string } | { readonly kind: "none" };
    readonly phase: EscrowIntentPhase;
    readonly error: EscrowError | null;
    readonly death: DeathProof | null;
  }[];
  /** LIVE-3: every intent transition carries a ConditionCheck on the writer epoch that created it. */
  readonly writer_epoch: number;
  readonly created_at: number;
  readonly updated_at: number;
}

const INTENT_TAG = "18COSMOS/INTENT/v1";

const canonicalU64 = (value: string, where: string): string => {
  decimalWithin(value, U64_MAX, where);
  return value;
};

/**
 * The intent id: SHA-256 over a length-prefixed encoding of the instance key and the slot. Deterministic across
 * restarts and processes; one per slot; never derived from a clock, a counter or the payload.
 */
export function intentIdOf(instance: string, key: EscrowIntentKey): string {
  const parts: string[] = [INTENT_TAG, instance, key.op];
  switch (key.op) {
    case "start":
      break;
    case "checkpoint":
    case "settle":
    case "finalize":
      parts.push(canonicalU64(key.seq, "seq"));
      break;
    case "relay-consent":
      if (!Number.isInteger(key.seat_index) || key.seat_index < 0 || key.seat_index > 6) bad(`seat_index ${String(key.seat_index)}`);
      parts.push(canonicalU64(key.seq, "seq"), String(key.seat_index));
      break;
    case "annul-by-consent":
      parts.push(canonicalU64(key.trusted_seq, "trusted_seq"));
      break;
    default:
      throw new Error(`intentIdOf: unknown intent op ${String((key as { op?: unknown }).op)}`);
  }
  return sha256HexOfBytes(utf8Bytes(framed(parts)));
}

/** Whether an existing intent at this key carries exactly this subject (else the caller HOLDs). */
export function sameIntentSubject(a: EscrowIntentSubject, b: EscrowIntentSubject): boolean {
  if (a.kind === "roster" || b.kind === "roster") return a.kind === b.kind && (a as { roster_hash: string }).roster_hash === (b as { roster_hash: string }).roster_hash;
  if (a.digests.length !== b.digests.length) return false;
  return a.digests.every((d, i) => d.codec === b.digests[i].codec && d.purpose === b.digests[i].purpose && d.hex === b.digests[i].hex);
}

/* Re-exported so server code imports the digest stamp from one place. */
export { codecDigest };
