// server/src/escrow/juno/junoContract.ts
//
// ==================================================================
//  ESCROW-3B: THE FROZEN ESCROW CONTRACT'S ABI, AS THE RELAYER SPEAKS IT -- MESSAGES, QUERIES, ANSWERS, REFUSALS
// ==================================================================
//
// The contract is FROZEN at escrow 2.0.0 (ESCROW-JOIN, 2026-09-28: `Join` carries the server's ADMISSION; the canonical
// wasm is `CANONICAL_JUNO_ESCROW_CHECKSUMS` in junoConfig.ts; `contracts/escrow/src/msg.rs` and `schema/`). The 1.0.0
// artifact `b263277a…9296` is historical: its Join seated any payer. This file is the one place its JSON is written and
// read on the server, and it changes nothing about it:
//
//   execute  (relayer)   start · checkpoint · settle (consents: [] -- relayed one by one, GNOLAND-1 F5) · consent ·
//                        finalize · annul_by_consent. Never funds (every relayer route is non-payable).
//   execute  (wallets)   create_game · join (with the server's admission) · withdraw · cancel · set_consent_key ·
//                        challenge · liveness_settle -- built here for ESCROW-4's WalletRequest; the SERVER never signs
//                        them (it signs only the admission DIGEST a join carries, `escrowService.authorizeJoin`).
//   query                config · game · seats · checkpoints · signer_keys (paged to the end) · settlement_preview.
//
// `chain_game_id` is a JSON INTEGER in the ABI (`u64` in msg.rs); it is written from its decimal string, never through
// a JavaScript number. Payload u64/u128 fields are the SET-0C wire form (`settlementPayloadToWire`: decimal strings,
// lowercase hex) -- exactly `SettlementPayloadV1` in msg.rs.
//
// REFUSALS (GNOLAND-1 F14). wasmd reports a contract refusal as its Display TEXT inside the transaction's log
// ("failed to execute message; message index: 0: <text>: execute wasm contract failed"), never the variant name. The
// classifier below matches the `#[error("…")]` templates of `contracts/escrow/src/error.rs`, most specific first; free
// text variants (`Std`, `InvalidParams`, `MalformedPayload`, `Invariant`) anchor on their fixed prefix; anything that
// matches nothing is a BACKEND_INVARIANT (never retried blindly). `junoContract.test.ts` parses error.rs and fails if
// this table and the templates ever differ.

import { junoContractError } from "../../../../frontend/src/gameEngine/escrow/junoCodecV1";
import { codecDigest, type EscrowError, type EscrowGameView, type EscrowState } from "../../../../frontend/src/gameEngine/escrow/escrowModel";
import type { SettlementPayloadV1Wire } from "../../../../frontend/src/gameEngine/escrow/settlementCoreV1";

export class JunoAbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JunoAbiError";
  }
}

const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const HEX32 = HEX(32);
const HEX64 = HEX(64);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/** A u64 decimal, checked, for writing as a bare JSON integer. */
function u64Json(value: string, where: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > U64_MAX) throw new JunoAbiError(`${where}=${String(value)} is not a u64 decimal`);
  return value;
}

const hexField = (value: string, re: RegExp, where: string): string => {
  if (typeof value !== "string" || !re.test(value)) throw new JunoAbiError(`${where} is not lowercase hex of the right length`);
  return value;
};

/** `{"<variant>":{<fields>}}` with `chain_game_id` spliced as an integer (no JavaScript number in between). */
function execute(variant: string, chainGameId: string | null, fields: Record<string, unknown>): string {
  const rest = JSON.stringify(fields);
  const inner = chainGameId === null ? rest : rest === "{}" ? `{"chain_game_id":${chainGameId}}` : `{"chain_game_id":${chainGameId},${rest.slice(1)}`;
  return `{"${variant}":${inner}}`;
}

export interface SeatSignatureJson {
  readonly seat_index: number;
  readonly signature: string;
}

const seatSignatures = (consents: readonly SeatSignatureJson[]): SeatSignatureJson[] =>
  consents.map((consent, at) => {
    if (!Number.isInteger(consent.seat_index) || consent.seat_index < 0 || consent.seat_index > 6) throw new JunoAbiError(`consents[${at}].seat_index`);
    return { seat_index: consent.seat_index, signature: hexField(consent.signature, HEX64, `consents[${at}].signature`) };
  });

/** Relayer execute messages (the server signs and pays for these; none carries funds). */
export const RELAYER_EXECUTE = Object.freeze({
  start: (chainGameId: string, rosterHash: string) => execute("start", u64Json(chainGameId, "chain_game_id"), { roster_hash: hexField(rosterHash, HEX32, "roster_hash") }),
  checkpoint: (chainGameId: string, payload: SettlementPayloadV1Wire, signatureHex: string) =>
    execute("checkpoint", u64Json(chainGameId, "chain_game_id"), { payload, signature: hexField(signatureHex, HEX64, "signature") }),
  /** GNOLAND-1 F5: `consents` is always empty here -- one bad consent would fail the whole Settle. */
  settle: (chainGameId: string, payload: SettlementPayloadV1Wire, signatureHex: string) =>
    execute("settle", u64Json(chainGameId, "chain_game_id"), { payload, signature: hexField(signatureHex, HEX64, "signature"), consents: [] }),
  consent: (chainGameId: string, seatIndex: number, signatureHex: string) =>
    execute("consent", u64Json(chainGameId, "chain_game_id"), { seat_index: seatSignatures([{ seat_index: seatIndex, signature: signatureHex }])[0].seat_index, signature: hexField(signatureHex, HEX64, "signature") }),
  finalize: (chainGameId: string) => execute("finalize", u64Json(chainGameId, "chain_game_id"), {}),
  annulByConsent: (chainGameId: string, consents: readonly SeatSignatureJson[]) => execute("annul_by_consent", u64Json(chainGameId, "chain_game_id"), { consents: seatSignatures(consents) }),
});

/** Wallet execute messages (ESCROW-4 hands these to the player's wallet; the server never signs them). */
export const WALLET_EXECUTE = Object.freeze({
  createGame: (a: { maxPlayers: number; mode: 0 | 1; rulesEngineVersion: number; variantsDigest: string; consentPubkey: string; joinTicket: string }) => {
    if (!Number.isInteger(a.maxPlayers) || a.maxPlayers < 2 || a.maxPlayers > 7) throw new JunoAbiError("max_players");
    if (!Number.isInteger(a.rulesEngineVersion) || a.rulesEngineVersion < 0 || a.rulesEngineVersion > 0xffffffff) throw new JunoAbiError("rules_engine_version");
    return execute("create_game", null, {
      max_players: a.maxPlayers,
      mode: a.mode === 0 ? "live" : "async",
      rules_engine_version: a.rulesEngineVersion,
      variants_digest: hexField(a.variantsDigest, HEX32, "variants_digest"),
      consent_pubkey: hexField(a.consentPubkey, HEX(33), "consent_pubkey"),
      join_ticket: hexField(a.joinTicket, HEX32, "join_ticket"),
    });
  },
  /** ESCROW-JOIN: the admission is the server's signature for THIS wallet (the transaction's sender), this game and this
   *  ticket until `expiresAt` (Unix seconds, a decimal string: a Uint64 on the wire). Without it the contract refuses. */
  join: (chainGameId: string, consentPubkey: string, joinTicket: string, admission: { readonly expiresAt: string; readonly signature: string }) =>
    execute("join", u64Json(chainGameId, "chain_game_id"), {
      consent_pubkey: hexField(consentPubkey, HEX(33), "consent_pubkey"),
      join_ticket: hexField(joinTicket, HEX32, "join_ticket"),
      admission: { expires_at: u64Json(admission.expiresAt, "admission.expires_at"), signature: hexField(admission.signature, HEX64, "admission.signature") },
    }),
  withdraw: (chainGameId: string) => execute("withdraw", u64Json(chainGameId, "chain_game_id"), {}),
  cancel: (chainGameId: string) => execute("cancel", u64Json(chainGameId, "chain_game_id"), {}),
  setConsentKey: (chainGameId: string, newPubkey: string) => execute("set_consent_key", u64Json(chainGameId, "chain_game_id"), { new_pubkey: hexField(newPubkey, HEX(33), "new_pubkey") }),
  challenge: (chainGameId: string, evidenceHash: string) => execute("challenge", u64Json(chainGameId, "chain_game_id"), { evidence_hash: hexField(evidenceHash, HEX32, "evidence_hash") }),
  livenessSettle: (chainGameId: string, checkpoint: { payload: SettlementPayloadV1Wire; signature: string } | null) =>
    execute("liveness_settle", u64Json(chainGameId, "chain_game_id"), { checkpoint: checkpoint === null ? null : { payload: checkpoint.payload, signature: hexField(checkpoint.signature, HEX64, "signature") } }),
});

export const QUERY = Object.freeze({
  config: () => `{"config":{}}`,
  game: (chainGameId: string) => `{"game":{"chain_game_id":${u64Json(chainGameId, "chain_game_id")}}}`,
  seats: (chainGameId: string) => `{"seats":{"chain_game_id":${u64Json(chainGameId, "chain_game_id")}}}`,
  checkpoints: (chainGameId: string) => `{"checkpoints":{"chain_game_id":${u64Json(chainGameId, "chain_game_id")}}}`,
  signerKeys: (startAfter: number | null, limit: number) => `{"signer_keys":{"start_after":${startAfter === null ? "null" : String(startAfter)},"limit":${limit}}}`,
  settlementPreview: (chainGameId: string) => `{"settlement_preview":{"chain_game_id":${u64Json(chainGameId, "chain_game_id")}}}`,
});

/* ------------------------------------------------------------------ */
/* Answers (strict enough to fail closed on anything unexpected)        */
/* ------------------------------------------------------------------ */

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const need = <T>(ok: boolean, value: T, where: string): T => {
  if (!ok) throw new JunoAbiError(`the contract answered an unexpected ${where}`);
  return value;
};
const str = (value: unknown, where: string): string => need(typeof value === "string", value as string, where);
const dec = (value: unknown, where: string): string => need(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 40, value as string, where);
const int = (value: unknown, where: string, max: number): number => need(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max, value as number, where);
const hexOf = (value: unknown, re: RegExp, where: string): string => {
  /* ESCROW-JOIN review L2: the type is checked BEFORE the value is touched (a 1.0.0 contract has no admission_pubkey). */
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return need(text !== "" && re.test(text), text, where);
};
const orNull = <T>(value: unknown, read: (v: unknown) => T): T | null => (value === null || value === undefined ? null : read(value));
/** A cosmwasm Timestamp is a decimal string of nanoseconds; kept as whole SECONDS (decimal) for deadlines. */
const secondsOf = (value: unknown, where: string): string => (BigInt(dec(value, where)) / BigInt(1_000_000_000)).toString();

const STATES: Readonly<Record<string, EscrowState>> = Object.freeze({
  funding: "FUNDING",
  funded: "FUNDED",
  in_progress: "IN_PROGRESS",
  settleable: "SETTLEABLE",
  disputed: "DISPUTED",
  settled: "SETTLED",
  cancelled: "CANCELLED",
  annulled: "ANNULLED",
});

export interface JunoPayloadRecord {
  readonly seq: string;
  readonly kind: number;
  readonly reason: number;
  readonly log_len: string;
  readonly log_hash: string;
  readonly appraisal_log_len: string;
  readonly appraisal_state_hash: string;
  readonly settlement_weights: readonly string[];
  readonly signer_key_id: number;
  readonly payload_digest: string;
}

export interface JunoSeat {
  readonly wallet: string;
  readonly consent_pubkey: string;
  readonly join_ticket: string;
  readonly gross_deposit: string;
  readonly net_deposit: string;
}

export interface JunoGame {
  readonly chain_game_id: string;
  readonly state: EscrowState;
  readonly creator: string;
  readonly max_players: number;
  readonly mode: 0 | 1;
  readonly rules_engine_version: number;
  readonly variants_digest: string;
  readonly denom: string;
  readonly ante_gross: string;
  readonly ante_net: string;
  readonly pool: string;
  readonly seats: readonly JunoSeat[];
  readonly roster_hash: string | null;
  readonly domain: string | null;
  readonly bond: string | null;
  readonly resolver: string | null;
  readonly last_seq: string;
  readonly settlement: { readonly source: string; readonly payload: JunoPayloadRecord; readonly window_end_secs: string } | null;
  readonly consent_bitmap: number;
  readonly dispute: { readonly challenger: string; readonly evidence_hash: string; readonly bond: string } | null;
  readonly outcome: { readonly route: string; readonly amounts: readonly string[]; readonly dust: string; readonly at_secs: string } | null;
  readonly terms: { readonly challenge_window_secs: string; readonly liveness_window_secs: string; readonly resolver_timeout_secs: string; readonly treasury: string };
}

export interface JunoGameResponse {
  readonly game: JunoGame;
  readonly paused: boolean;
  readonly trusted_seq: string;
  readonly latest_checkpoint: { readonly payload: JunoPayloadRecord; readonly accepted_at_secs: string } | null;
  readonly deadlines: { readonly funding_deadline: string; readonly liveness_available_at: string | null; readonly challenge_window_end: string | null; readonly resolver_timeout_at: string | null };
}

function payloadRecord(value: unknown, where: string): JunoPayloadRecord {
  if (!isObject(value)) throw new JunoAbiError(`${where} is not an object`);
  const weights = value.settlement_weights;
  return {
    seq: dec(value.seq, `${where}.seq`),
    kind: int(value.kind, `${where}.kind`, 255),
    reason: int(value.reason, `${where}.reason`, 255),
    log_len: dec(value.log_len, `${where}.log_len`),
    log_hash: hexOf(value.log_hash, HEX32, `${where}.log_hash`),
    appraisal_log_len: dec(value.appraisal_log_len, `${where}.appraisal_log_len`),
    appraisal_state_hash: hexOf(value.appraisal_state_hash, HEX32, `${where}.appraisal_state_hash`),
    settlement_weights: need(Array.isArray(weights) && weights.length <= 7, weights as unknown[], `${where}.settlement_weights`).map((w, i) => dec(w, `${where}.settlement_weights[${i}]`)),
    signer_key_id: int(value.signer_key_id, `${where}.signer_key_id`, 65535),
    payload_digest: hexOf(value.payload_digest, HEX32, `${where}.payload_digest`),
  };
}

export function parseGameResponse(data: unknown): JunoGameResponse {
  if (!isObject(data) || !isObject(data.game) || !isObject(data.deadlines)) throw new JunoAbiError("the game answer is not a GameResponse");
  const g = data.game;
  const state = STATES[str(g.state, "game.state")];
  if (state === undefined) throw new JunoAbiError(`game.state ${String(g.state)} is not an escrow state`);
  const mode = str(g.mode, "game.mode");
  if (mode !== "live" && mode !== "async") throw new JunoAbiError("game.mode");
  const seats = need(Array.isArray(g.seats) && g.seats.length <= 7, g.seats as unknown[], "game.seats").map((seat, i) => {
    if (!isObject(seat)) throw new JunoAbiError(`game.seats[${i}]`);
    return {
      wallet: str(seat.wallet, `game.seats[${i}].wallet`),
      consent_pubkey: hexOf(seat.consent_pubkey, HEX(33), `game.seats[${i}].consent_pubkey`),
      join_ticket: hexOf(seat.join_ticket, HEX32, `game.seats[${i}].join_ticket`),
      gross_deposit: dec(seat.gross_deposit, `game.seats[${i}].gross_deposit`),
      net_deposit: dec(seat.net_deposit, `game.seats[${i}].net_deposit`),
    };
  });
  const terms = isObject(g.terms) ? g.terms : {};
  const settlement = isObject(g.settlement)
    ? { source: str(g.settlement.source, "settlement.source"), payload: payloadRecord(g.settlement.payload, "settlement.payload"), window_end_secs: secondsOf(g.settlement.window_end, "settlement.window_end") }
    : null;
  const dispute = isObject(g.dispute) ? { challenger: str(g.dispute.challenger, "dispute.challenger"), evidence_hash: hexOf(g.dispute.evidence_hash, HEX32, "dispute.evidence_hash"), bond: dec(g.dispute.bond, "dispute.bond") } : null;
  const outcome = isObject(g.outcome)
    ? {
        route: str(g.outcome.route, "outcome.route"),
        amounts: need(Array.isArray(g.outcome.amounts), g.outcome.amounts as unknown[], "outcome.amounts").map((a, i) => dec(a, `outcome.amounts[${i}]`)),
        dust: dec(g.outcome.dust, "outcome.dust"),
        at_secs: secondsOf(g.outcome.at, "outcome.at"),
      }
    : null;
  const latest = isObject(data.latest_checkpoint) ? { payload: payloadRecord(data.latest_checkpoint.payload, "latest_checkpoint.payload"), accepted_at_secs: secondsOf(data.latest_checkpoint.accepted_at, "latest_checkpoint.accepted_at") } : null;
  const d = data.deadlines;
  return {
    game: {
      chain_game_id: String(int(g.chain_game_id, "game.chain_game_id", Number.MAX_SAFE_INTEGER)),
      state,
      creator: str(g.creator, "game.creator"),
      max_players: int(g.max_players, "game.max_players", 7),
      mode: mode === "live" ? 0 : 1,
      rules_engine_version: int(g.rules_engine_version, "game.rules_engine_version", 0xffffffff),
      variants_digest: hexOf(g.variants_digest, HEX32, "game.variants_digest"),
      denom: str(g.denom, "game.denom"),
      ante_gross: dec(g.ante_gross, "game.ante_gross"),
      ante_net: dec(g.ante_net, "game.ante_net"),
      pool: dec(g.pool, "game.pool"),
      seats,
      roster_hash: orNull(g.roster_hash, (v) => hexOf(v, HEX32, "game.roster_hash")),
      domain: orNull(g.domain, (v) => hexOf(v, HEX32, "game.domain")),
      bond: orNull(g.bond, (v) => dec(v, "game.bond")),
      resolver: orNull(g.resolver, (v) => str(v, "game.resolver")),
      last_seq: dec(g.last_seq, "game.last_seq"),
      settlement,
      consent_bitmap: int(g.consent_bitmap, "game.consent_bitmap", 255),
      dispute,
      outcome,
      terms: {
        challenge_window_secs: String(int(terms.challenge_window_secs, "terms.challenge_window_secs", Number.MAX_SAFE_INTEGER)),
        liveness_window_secs: String(int(terms.liveness_window_secs, "terms.liveness_window_secs", Number.MAX_SAFE_INTEGER)),
        resolver_timeout_secs: String(int(terms.resolver_timeout_secs, "terms.resolver_timeout_secs", Number.MAX_SAFE_INTEGER)),
        treasury: str(terms.treasury, "terms.treasury"),
      },
    },
    paused: need(typeof data.paused === "boolean", data.paused as boolean, "paused"),
    trusted_seq: dec(data.trusted_seq, "trusted_seq"),
    latest_checkpoint: latest,
    deadlines: {
      funding_deadline: secondsOf(d.funding_deadline, "deadlines.funding_deadline"),
      liveness_available_at: orNull(d.liveness_available_at, (v) => secondsOf(v, "deadlines.liveness_available_at")),
      challenge_window_end: orNull(d.challenge_window_end, (v) => secondsOf(v, "deadlines.challenge_window_end")),
      resolver_timeout_at: orNull(d.resolver_timeout_at, (v) => secondsOf(v, "deadlines.resolver_timeout_at")),
    },
  };
}

export interface JunoCheckpointView {
  readonly payload: JunoPayloadRecord;
  readonly signer_key_retired: boolean;
  readonly signer_key_compromised: boolean;
}

export function parseCheckpointsResponse(data: unknown): { readonly checkpoints: readonly JunoCheckpointView[]; readonly liveness_candidate_seq: string | null } {
  if (!isObject(data) || !Array.isArray(data.checkpoints) || data.checkpoints.length > 64) throw new JunoAbiError("the checkpoints answer is not a CheckpointsResponse");
  return {
    checkpoints: data.checkpoints.map((view, i) => {
      if (!isObject(view) || !isObject(view.checkpoint)) throw new JunoAbiError(`checkpoints[${i}]`);
      return {
        payload: payloadRecord(view.checkpoint.payload, `checkpoints[${i}].payload`),
        signer_key_retired: need(typeof view.signer_key_retired === "boolean", view.signer_key_retired as boolean, `checkpoints[${i}].signer_key_retired`),
        signer_key_compromised: need(typeof view.signer_key_compromised === "boolean", view.signer_key_compromised as boolean, `checkpoints[${i}].signer_key_compromised`),
      };
    }),
    liveness_candidate_seq: orNull(data.liveness_candidate_seq, (v) => dec(v, "liveness_candidate_seq")),
  };
}

export interface JunoConfig {
  readonly admin: string;
  readonly operator: string;
  /** ESCROW-JOIN: the join-admission public key the contract verifies every Join against (33-byte compressed hex). */
  readonly admission_pubkey: string;
  readonly resolver: string;
  readonly treasury: string;
  readonly denom: string;
  readonly paused: boolean;
  readonly subsidy_bps: number;
  readonly challenge_window_live_secs: string;
  readonly challenge_window_async_secs: string;
  readonly liveness_window_secs: string;
  readonly resolver_timeout_secs: string;
  readonly contract_name: string;
  readonly contract_version: string;
  readonly next_signer_key_id: number;
}

export function parseConfigResponse(data: unknown): JunoConfig {
  if (!isObject(data) || !isObject(data.config) || !isObject(data.config.params)) throw new JunoAbiError("the config answer is not a ConfigResponse");
  const c = data.config;
  const p = data.config.params as Loose;
  const secs = (v: unknown, w: string) => String(int(v, w, Number.MAX_SAFE_INTEGER));
  return {
    admin: str(c.admin, "config.admin"),
    operator: str(c.operator, "config.operator"),
    admission_pubkey: hexOf(c.admission_pubkey, HEX(33), "config.admission_pubkey"),
    resolver: str(c.resolver, "config.resolver"),
    treasury: str(c.treasury, "config.treasury"),
    denom: str(c.denom, "config.denom"),
    paused: need(typeof c.paused === "boolean", c.paused as boolean, "config.paused"),
    subsidy_bps: int(p.subsidy_bps, "params.subsidy_bps", 10_000),
    challenge_window_live_secs: secs(p.challenge_window_live_secs, "params.challenge_window_live_secs"),
    challenge_window_async_secs: secs(p.challenge_window_async_secs, "params.challenge_window_async_secs"),
    liveness_window_secs: secs(p.liveness_window_secs, "params.liveness_window_secs"),
    resolver_timeout_secs: secs(p.resolver_timeout_secs, "params.resolver_timeout_secs"),
    contract_name: str(data.contract_name, "contract_name"),
    contract_version: str(data.contract_version, "contract_version"),
    next_signer_key_id: int(data.next_signer_key_id, "next_signer_key_id", 65535),
  };
}

export interface JunoSignerKey {
  readonly key_id: number;
  readonly pubkey: string;
  readonly retired: boolean;
  readonly compromised: boolean;
}

export function parseSignerKeysResponse(data: unknown): readonly JunoSignerKey[] {
  if (!isObject(data) || !Array.isArray(data.keys) || data.keys.length > 64) throw new JunoAbiError("the signer_keys answer is not a SignerKeysResponse");
  return data.keys.map((key, i) => {
    if (!isObject(key)) throw new JunoAbiError(`keys[${i}]`);
    return {
      key_id: int(key.key_id, `keys[${i}].key_id`, 65535),
      pubkey: hexOf(key.pubkey, HEX(33), `keys[${i}].pubkey`),
      retired: key.retired_at !== null && key.retired_at !== undefined,
      compromised: need(typeof key.compromised === "boolean", key.compromised as boolean, `keys[${i}].compromised`),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Refusals: error.rs Display templates -> ContractError variant        */
/* ------------------------------------------------------------------ */

/** Every `#[error("…")]` template of the frozen error.rs, by variant (the test pins this table to the file). */
export const JUNO_ERROR_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  Std: "{0}",
  Unauthorized: "unauthorized: only the {role} may do this",
  NotSeated: "sender is not seated in game {chain_game_id}",
  AlreadyJoined: "this wallet is already seated in game {chain_game_id}",
  GameNotFound: "game {chain_game_id} not found",
  WrongState: "wrong state: game is {actual}, this message needs {expected}",
  Paused: "the contract is paused",
  GameFull: "the game has no free seat",
  FundingClosed: "the funding deadline has passed",
  NonPayable: "this message does not accept funds",
  InvalidFunds: "expected exactly one non-zero coin of {denom}",
  BelowMinAnte: "deposit {got} is below the minimum ante {min}",
  WrongAnte: "deposit must equal the game's gross ante {expected}, got {got}",
  WrongBond: "the challenge bond must be exactly {expected}, got {got}",
  BadMaxPlayers: "max_players must be between 2 and 7, got {got}",
  BadLength: "{field} must be {expected} bytes, got {got}",
  BadPubkey: "{field} must be a valid 33-byte compressed secp256k1 public key",
  ConsentKeyInUse: "this consent key is already used by seat {seat_index} of this game",
  RosterHashMismatch: "the roster hash does not match the on-chain roster",
  BadVersion: "unsupported payload version {got}",
  DomainMismatch: "the payload domain does not match this game",
  BadKind: "invalid payload kind {got}",
  WrongKind: "this message needs a {expected} payload",
  UnknownReason: "reason {got} is reserved or unknown",
  ReasonNotAllowed: "reason {reason} is not allowed for this message",
  BadSeq: "seq {seq} does not equal 2*log_len + kind_bit",
  BadAppraisalLogLen: "appraisal_log_len {appraisal_log_len} is not valid for log_len {log_len} and this kind/reason",
  SeatCountMismatch: "seat_count {seat_count} does not match the {weights} settlement weights",
  RosterLengthMismatch: "the payload carries {got} settlement weights, the roster has {expected} seats",
  ZeroSumWeights: "the settlement weights sum to zero",
  StaleSeq: "seq {seq} does not exceed the trusted sequence {trusted_seq}",
  MalformedPayload: "payload is malformed: {reason}",
  UnknownSignerKey: "signer key {key_id} is not registered",
  RetiredSignerKey: "signer key {key_id} is retired",
  CompromisedSettlement: "the stored settlement's signer key {key_id} is compromised; it can no longer be finalized or consented to",
  BadSignatureLength: "a signature must be 64 bytes r||s, got {got}",
  HighS: "the signature is not low-s normalised",
  InvalidSignature: "invalid signature",
  SeatIndexOutOfRange: "seat index {seat_index} is out of range",
  DuplicateConsent: "duplicate signature for seat {seat_index}",
  InvalidConsent: "invalid signature for seat {seat_index}",
  MissingConsent: "every seat must sign; seat {seat_index} is missing",
  WindowOpen: "the challenge window is open until {until}",
  WindowClosed: "the challenge window closed at {closed}",
  LivenessNotReached: "the liveness window has not elapsed; available at {at}",
  ResolverTimeoutNotReached: "the resolver timeout has not elapsed; available at {at}",
  InvalidParams: "invalid parameter: {reason}",
  DuplicateSignerKey: "this public key is already registered as signer key {key_id}",
  KeyIdsExhausted: "the signer key registry is full",
  Overflow: "arithmetic overflow",
  Invariant: "internal invariant violated: {reason}",
  MigrateForeignContract: "cannot migrate from contract {contract}",
  MigrateDowngrade: "cannot migrate from version {from} to older version {to}",
  BadContractVersion: "unparseable contract version {version}",
  InvalidAdmission: "the join admission does not authorize this wallet for this game",
  AdmissionExpired: "the join admission expired at {expires_at}",
  MigrateUnsupported: "cannot migrate from version {from}: its state predates this code; deploy a new contract",
});

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each placeholder matches lazily; the table is tried longest-fixed-text first, so a template that is a prefix of
 *  another (`InvalidSignature` of `InvalidConsent`: "invalid signature" / "invalid signature for seat 3") never
 *  swallows it. */
const CLASSIFIERS: readonly { variant: string; re: RegExp; fixed: number }[] = Object.entries(JUNO_ERROR_TEMPLATES)
  .filter(([variant]) => variant !== "Std")
  .map(([variant, template]) => {
    const parts = template.split(/(\{[a-z_0-9]+\})/);
    const source = parts.map((part) => (/^\{[a-z_0-9]+\}$/.test(part) ? ".+?" : escapeRe(part))).join("");
    const fixed = parts.filter((part) => !/^\{[a-z_0-9]+\}$/.test(part)).join("").length;
    return { variant, re: new RegExp(source), fixed };
  })
  .sort((a, b) => b.fixed - a.fixed);

/** The contract refusal inside a failed transaction's log, as a neutral error. Nothing recognisable is a
 *  BACKEND_INVARIANT (reconcile-first; the relayer HOLDS rather than guessing). */
export function classifyContractFailure(rawLog: string): { readonly variant: string; readonly error: EscrowError } {
  const text = typeof rawLog === "string" ? rawLog.slice(0, 4096) : "";
  for (const candidate of CLASSIFIERS) {
    if (candidate.re.test(text)) return { variant: candidate.variant, error: junoContractError(candidate.variant, text) };
  }
  return { variant: "Std", error: junoContractError("Std", text) };
}

/* ------------------------------------------------------------------ */
/* The neutral view (GNOLAND-1 EscrowGameView) of one Juno game          */
/* ------------------------------------------------------------------ */


/** The chain's answers for one game, normalised for `freezeEscrowRoster` and the deal check. `instance` is the
 *  binding's `escrowInstanceKey` (the caller has already asserted it read THIS contract on THIS chain). */
export function junoGameView(instance: string, response: JunoGameResponse, config: JunoConfig, observed: { readonly height: string; readonly block_time: string }): EscrowGameView {
  const g = response.game;
  const payloadDigest = (record: JunoPayloadRecord) => codecDigest("18JUNO/v1", "settle", record.payload_digest);
  return {
    instance,
    state: g.state,
    paused: response.paused,
    seats: g.seats.map((seat, index) => ({
      chain_seat_index: index,
      payout_address: seat.wallet,
      consent_public_key_hex: seat.consent_pubkey,
      consent_scheme: "secp256k1-ecdsa-prehashed/rs64-low-s" as const,
      join_ticket_hex: seat.join_ticket,
      deposit_gross: seat.gross_deposit,
      deposit_net: seat.net_deposit,
    })),
    max_players: g.max_players,
    mode: g.mode,
    rules_engine_version: g.rules_engine_version,
    variants_digest: g.variants_digest,
    ante_gross: g.ante_gross,
    ante_net: g.ante_net,
    pool: g.pool,
    roster_hash: g.roster_hash,
    domain: g.domain,
    resolver: g.resolver,
    last_seq: g.last_seq,
    trusted_seq: response.trusted_seq,
    latest_checkpoint: response.latest_checkpoint === null ? null : { seq: response.latest_checkpoint.payload.seq, signer_key_id: response.latest_checkpoint.payload.signer_key_id, settle_digest: payloadDigest(response.latest_checkpoint.payload) },
    settlement:
      g.settlement === null
        ? null
        : {
            seq: g.settlement.payload.seq,
            reason: g.settlement.payload.reason,
            signer_key_id: g.settlement.payload.signer_key_id,
            payable: true,
            consented_seats: g.seats.map((_, index) => index).filter((index) => (g.consent_bitmap & (1 << index)) !== 0),
          },
    dispute: g.dispute,
    deadlines: {
      funding_deadline: response.deadlines.funding_deadline,
      challenge_window_end: response.deadlines.challenge_window_end,
      liveness_available_at: response.deadlines.liveness_available_at,
      resolver_timeout_at: response.deadlines.resolver_timeout_at,
    },
    trust: {
      denom: g.denom,
      operator: config.operator,
      resolver_config: config.resolver,
      resolver_game: g.resolver,
      bond: g.bond,
      challenge_window_secs: g.terms.challenge_window_secs,
      liveness_window_secs: g.terms.liveness_window_secs,
      resolver_timeout_secs: g.terms.resolver_timeout_secs,
    },
    observed,
    native: null,
  };
}
