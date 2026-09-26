// frontend/src/gameEngine/settlementPayload.ts
//
// ==================================================================
//  SET-0C: SettlementPayloadV1 -- THE EXACT BYTES THE ESCROW CONTRACT RE-ENCODES AND VERIFIES
// ==================================================================
//
// WHAT THIS IS. The TypeScript side of the settlement wire: the one canonical encoder of `SettlementPayloadV1`, the
// frozen `18JUNO/*/v1` digests (SETTLE, DOMAIN, ROSTER, CONSENT, ANNUL), the strict JSON form the contract's ABI
// takes, the game-independent shape rules, and `buildSettlementPayloadV1` -- the one path ESCROW-3 builds a payload
// through. It computes bytes and digests only: no signing, no key material, no chain client, no transport.
//
// THE AUTHORITY IS THE RUST CRATE AND ITS FROZEN VECTORS, not this file. `contracts/escrow/src/payload.rs` and
// `src/crypto.rs` (ESCROW-2, corrected by ESCROW-2.1) define the layout; `contracts/escrow/testdata/
// payload_vectors_v1.json`, written by an independent Python generator, is what three implementations must agree on
// byte for byte (`settlementPayloadConformance.test.ts`). The layout (ESCROW-1.5 §6.1 as amended by SET-0A rev 2 §21):
//
//   version 1 | domain 32 | seq 8 BE | kind 1 | reason 1 | log_len 8 BE | log_hash 32 |
//   appraisal_log_len 8 BE | appraisal_state_hash 32 | state_schema_version 2 BE | n 1 |
//   settlement_weights 16·n (u128 BE each) | signer_key_id 2 BE | issued_at 8 BE          = 136 + 16·n bytes
//
// FIELD NAMES ARE THE AMENDED ONES. `appraisal_state_hash` (never the rev-1 `terminal_state_hash`) and
// `settlement_weights` (never `net_worth`); an object carrying a stale name is refused, not silently ignored.
//
// INTEGERS. Every u64 and u128 field is a `bigint` and ONLY a `bigint`: a JS `number` there is refused even when it
// happens to be safe, so no value ever passes through float arithmetic or `Number` truncation. The u8/u16/u32 fields
// are JS numbers (provably exact) and must be integers in range, `-0` refused. Bytes are written by bigint shifts into
// a `Uint8Array`: no `Buffer`, no `DataView.setBigUint64`, no implicit conversion. ES5 target: no bigint literals, no
// `**` (it downlevels to `Math.pow`), constants built with `BigInt(...)`.
//
// HEX. Byte fields are lowercase hex strings of exactly the field's length. The contract's `HexBinary` also accepts
// upper case on input and always writes lower case; this layer accepts only the form the contract writes, so two
// spellings of one value can never both circulate.
//
// WHERE THE PAYLOAD'S NUMBERS COME FROM. `buildSettlementPayloadV1` takes the board ONCE through SET-0B's
// `commitAndAppraise` (or the committed canonical text through `appraiseCommittedState`), so `appraisal_state_hash`
// and `settlement_weights` are derived from the same bytes. It never calls `terminalStateHashV1` and
// `baseNetWorthVector` separately on a live object.

import type { GameStateResponse } from "./gameState";
import { sha256HexOfBytes, utf8Bytes } from "./sha256";
import {
  MAX_SETTLEMENT_SEATS,
  MIN_SETTLEMENT_SEATS,
  type SeatAppraisal,
  type SettlementSeat,
} from "./settlementAppraisal";
import { appraiseCommittedState, commitAndAppraise } from "./settlementDigest";
import {
  SETTLEMENT_REASON_CODE,
  terminalSettlementWeights,
  type EscrowTerms,
  type TerminalOutcome,
} from "./settlementPolicy";

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

/** Wire-layer refusals. Where the Rust contract has the same refusal, the code is its `ContractError` name in
 *  SCREAMING_CASE (`BadSeq` -> `BAD_SEQ`) and fires in the same order. */
export type SettlementPayloadErrorCode =
  // argument / value shapes
  | "MALFORMED_INPUT"
  | "MALFORMED_INTEGER"
  | "INTEGER_OUT_OF_RANGE"
  | "MALFORMED_HEX"
  | "BAD_LENGTH"
  | "MALFORMED_STRING"
  | "MALFORMED_WIRE"
  // payload structure (Rust `TryFrom<&SettlementPayloadV1>` and `Payload::decode`)
  | "SEAT_COUNT_MISMATCH"
  | "MALFORMED_PAYLOAD"
  // shape rules (Rust `Payload::check_shape`, same order)
  | "BAD_VERSION"
  | "BAD_KIND"
  | "UNKNOWN_REASON"
  | "REASON_NOT_ALLOWED"
  | "WRONG_KIND"
  | "BAD_SEQ"
  | "BAD_APPRAISAL_LOG_LEN"
  // game-independent payload rules (Rust `check_payload_for_game`, minus the chain-state checks)
  | "BAD_SEAT_COUNT"
  | "SETTLEMENT_ZERO_SUM"
  // builder / verifier cross-checks
  | "DOMAIN_MISMATCH"
  | "ROSTER_MISMATCH"
  | "RULES_ENGINE_VERSION_MISMATCH"
  | "PAYLOAD_APPRAISAL_MISMATCH";

/** A refusal. `message` is `CODE: detail`, the SET-0B convention. */
export class SettlementPayloadError extends Error {
  readonly code: SettlementPayloadErrorCode;
  readonly detail: string;

  constructor(code: SettlementPayloadErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SettlementPayloadError";
    this.code = code;
    this.detail = detail;
    // ES5 target: restore the prototype so `instanceof` holds for a subclassed Error.
    Object.setPrototypeOf(this, SettlementPayloadError.prototype);
  }
}

const refuse = (code: SettlementPayloadErrorCode, detail: string): never => {
  throw new SettlementPayloadError(code, detail);
};

/** A refusal-safe rendering of any value (`JSON.stringify` throws on a bigint). */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value); // NaN / Infinity, not "null"
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* ------------------------------------------------------------------ */
/* Frozen constants                                                   */
/* ------------------------------------------------------------------ */

/** The only payload format (Rust `PAYLOAD_VERSION`). */
export const SETTLEMENT_PAYLOAD_VERSION = 1;

/** The `kind` byte (Rust `KIND_CHECKPOINT` / `KIND_TERMINAL`). */
export const SETTLEMENT_PAYLOAD_KIND = Object.freeze({ Checkpoint: 0, Terminal: 1 } as const);
export type SettlementPayloadKindName = keyof typeof SETTLEMENT_PAYLOAD_KIND;

/** The frozen reason enum (ESCROW-1.5 §5.3; Rust `REASON_*`). 6..255 are reserved and refused. Terminal reasons
 *  1..5 are SET-0B's `SETTLEMENT_REASON_CODE`, re-used rather than restated. */
export const SETTLEMENT_PAYLOAD_REASON = Object.freeze({
  RoundBoundary: 0,
  BankBroken: SETTLEMENT_REASON_CODE.BankBroken,
  Bankruptcy: SETTLEMENT_REASON_CODE.Bankruptcy,
  Forfeit: SETTLEMENT_REASON_CODE.Forfeit,
  Clemency: SETTLEMENT_REASON_CODE.Clemency,
  ResolverCorrection: SETTLEMENT_REASON_CODE.ResolverCorrection,
} as const);
export type SettlementPayloadReasonName = keyof typeof SETTLEMENT_PAYLOAD_REASON;

/** Bytes of every field except the weights (Rust `FIXED_ENCODED_LEN`). */
export const SETTLEMENT_PAYLOAD_FIXED_LEN = 136;
/** Bytes per weight (Rust `WEIGHT_ENCODED_LEN`). */
export const SETTLEMENT_PAYLOAD_WEIGHT_LEN = 16;

/** `136 + 16·n` for `n` in 0..255 (the `n` byte's range). */
export function settlementPayloadEncodedLength(seatCount: number): number {
  const n = smallUint(seatCount, 0xff, "seat_count");
  return SETTLEMENT_PAYLOAD_FIXED_LEN + SETTLEMENT_PAYLOAD_WEIGHT_LEN * n;
}

/** The domain-separation tags (Rust `crypto::TAG_*`): ASCII, no terminator. */
export const SETTLE_TAG_V1 = "18JUNO/SETTLE/v1";
export const DOMAIN_TAG_V1 = "18JUNO/DOMAIN/v1";
export const ROSTER_TAG_V1 = "18JUNO/ROSTER/v1";
export const CONSENT_TAG_V1 = "18JUNO/CONSENT/v1";
export const ANNUL_TAG_V1 = "18JUNO/ANNUL/v1";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const EIGHT = BigInt(8);
const BYTE_MASK = BigInt(0xff);
/** 2^64 − 1 and 2^128 − 1, by shifts (no `**`, which ES5 downlevels to `Math.pow`). */
export const U64_MAX = (ONE << BigInt(64)) - ONE;
const U128_MAX_LOCAL = (ONE << BigInt(128)) - ONE;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const LOWER_HEX = /^[0-9a-f]*$/;

/* ------------------------------------------------------------------ */
/* Integer and byte primitives                                        */
/* ------------------------------------------------------------------ */

/** A u8/u16/u32 carried as a JS number: an integer in [0, max], never `-0`, never a bigint or a numeric string. */
function smallUint(value: unknown, max: number, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Object.is(value, -0)) {
    return refuse("MALFORMED_INTEGER", `${where}=${describe(value)} is not an integer number`);
  }
  if (value < 0 || value > max) return refuse("INTEGER_OUT_OF_RANGE", `${where}=${value} is outside 0..${max}`);
  return value;
}

/** A u64/u128 carried as a bigint, and only a bigint (a JS number is refused even when it is safe). */
function bigUint(value: unknown, max: bigint, bits: number, where: string): bigint {
  if (typeof value !== "bigint") {
    return refuse("MALFORMED_INTEGER", `${where}=${describe(value)} is a ${typeof value}; u${bits} fields take a bigint`);
  }
  if (value < ZERO || value > max) {
    return refuse("INTEGER_OUT_OF_RANGE", `${where}=${value.toString()} is not a u${bits}`);
  }
  return value;
}

const u8 = (value: unknown, where: string): number => smallUint(value, 0xff, where);
const u16 = (value: unknown, where: string): number => smallUint(value, 0xffff, where);
const u32 = (value: unknown, where: string): number => smallUint(value, 0xffffffff, where);
const u64 = (value: unknown, where: string): bigint => bigUint(value, U64_MAX, 64, where);
const u128 = (value: unknown, where: string): bigint => bigUint(value, U128_MAX_LOCAL, 128, where);

/** Big-endian bytes of a non-negative bigint in exactly `width` bytes; refuses a value that does not fit. */
function beBytes(value: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let rest = value;
  for (let at = width - 1; at >= 0; at -= 1) {
    out[at] = Number(rest & BYTE_MASK); // 0..255: exact
    rest >>= EIGHT;
  }
  if (rest !== ZERO || value < ZERO) {
    // Every caller range-checks first; reaching this is a bug in this file, not bad input.
    throw new Error(`beBytes invariant broken: ${value.toString()} does not fit ${width} bytes`);
  }
  return out;
}

/** The unsigned value of big-endian bytes. */
function beValue(bytes: Uint8Array, from: number, width: number): bigint {
  let value = ZERO;
  for (let at = from; at < from + width; at += 1) value = (value << EIGHT) | BigInt(bytes[at]);
  return value;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (let at = 0; at < parts.length; at += 1) length += parts[at].length;
  const out = new Uint8Array(length);
  let pos = 0;
  for (let at = 0; at < parts.length; at += 1) {
    out.set(parts[at], pos);
    pos += parts[at].length;
  }
  return out;
}

/** Lowercase hex of bytes. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let at = 0; at < bytes.length; at += 1) hex += (bytes[at] < 16 ? "0" : "") + bytes[at].toString(16);
  return hex;
}

/** Bytes of a lowercase hex string of exactly `length` bytes. Upper case, odd length, `0x`, whitespace: refused. */
function hexBytes(value: unknown, length: number, where: string): Uint8Array {
  if (typeof value !== "string") return refuse("MALFORMED_HEX", `${where}=${describe(value)} is not a hex string`);
  if (!LOWER_HEX.test(value) || value.length % 2 !== 0) {
    return refuse("MALFORMED_HEX", `${where}=${describe(value)} is not lowercase hex of whole bytes`);
  }
  if (value.length !== 2 * length) {
    return refuse("BAD_LENGTH", `${where} must be ${length} bytes, got ${value.length / 2}`);
  }
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += 1) out[at] = parseInt(value.substr(2 * at, 2), 16);
  return out;
}

/** The FORMAT half of `hexBytes`: a lowercase hex string of whole bytes, any length (the length is judged later). */
function hexFormat(value: unknown, where: string): string {
  if (typeof value !== "string" || !LOWER_HEX.test(value) || value.length % 2 !== 0) {
    return refuse("MALFORMED_HEX", `${where}=${describe(value)} is not lowercase hex of whole bytes`);
  }
  return value;
}

/** Bytes of any lowercase hex string (a whole encoded payload), with no fixed length. */
export function hexToBytes(value: unknown, where = "hex"): Uint8Array {
  if (typeof value !== "string" || !LOWER_HEX.test(value) || value.length % 2 !== 0) {
    return refuse("MALFORMED_HEX", `${where}=${describe(value)} is not lowercase hex of whole bytes`);
  }
  return hexBytes(value, value.length / 2, where);
}

const sha256 = (parts: readonly Uint8Array[]): Uint8Array => hexBytes(sha256HexOfBytes(concatBytes(parts)), 32, "sha256");

/** UTF-8 of a string that HAS a UTF-8 form: a lone surrogate (which `utf8Bytes` would write as U+FFFD, so two JS
 *  strings would share bytes) is refused, as is anything longer than a `u16` length prefix can describe. */
function utf8Field(value: unknown, where: string): Uint8Array {
  if (typeof value !== "string") return refuse("MALFORMED_STRING", `${where}=${describe(value)} is not a string`);
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = at + 1 < value.length ? value.charCodeAt(at + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        at += 1;
        continue;
      }
      return refuse("MALFORMED_STRING", `${where} has a lone surrogate at ${at}`);
    }
    if (code >= 0xdc00 && code <= 0xdfff) return refuse("MALFORMED_STRING", `${where} has a lone surrogate at ${at}`);
  }
  const bytes = utf8Bytes(value);
  if (bytes.length > 0xffff) return refuse("MALFORMED_STRING", `${where} is ${bytes.length} bytes; the length prefix is a u16`);
  return bytes;
}

/** An on-chain address exactly as the contract stores it: `addr_validate` output is non-empty, normalised (lower
 *  case) and printable ASCII. A differently spelled address hashes to a different roster/domain, so it is refused
 *  here rather than discovered as a `DomainMismatch` on chain. No bech32 checksum is judged. */
function addressField(value: unknown, where: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    return refuse("MALFORMED_STRING", `${where}=${describe(value)} is not a non-empty address`);
  }
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < 0x21 || code > 0x7e || (code >= 0x41 && code <= 0x5a)) {
      return refuse("MALFORMED_STRING", `${where}=${describe(value)} is not a normalised (lower-case, printable ASCII) address`);
    }
  }
  return utf8Field(value, where);
}

/* ------------------------------------------------------------------ */
/* The payload                                                        */
/* ------------------------------------------------------------------ */

/** `SettlementPayloadV1` in memory: field names and order are the Rust struct's (`msg::SettlementPayloadV1`). */
export interface SettlementPayloadV1 {
  readonly version: number;
  /** 32 bytes, lowercase hex: the game's settlement domain (`Game.domain` on chain). */
  readonly domain: string;
  /** `2·log_len + kind`. */
  readonly seq: bigint;
  readonly kind: number;
  readonly reason: number;
  readonly log_len: bigint;
  /** 32 bytes, lowercase hex: `logHash(entries, log_len)`. */
  readonly log_hash: string;
  readonly appraisal_log_len: bigint;
  /** 32 bytes, lowercase hex: `terminal_state_hash_v1` of the board at `appraisal_log_len`. */
  readonly appraisal_state_hash: string;
  readonly state_schema_version: number;
  /** Must equal `settlement_weights.length` (the explicit `n` byte). */
  readonly seat_count: number;
  /** Unsigned u128 weights in `chain_seat_index` order. */
  readonly settlement_weights: readonly bigint[];
  readonly signer_key_id: number;
  readonly issued_at: bigint;
}

/** The contract ABI's JSON for the payload (cosmwasm `Uint64`/`Uint128` are decimal strings, `HexBinary` is hex). */
export interface SettlementPayloadV1Wire {
  version: number;
  domain: string;
  seq: string;
  kind: number;
  reason: number;
  log_len: string;
  log_hash: string;
  appraisal_log_len: string;
  appraisal_state_hash: string;
  state_schema_version: number;
  seat_count: number;
  settlement_weights: string[];
  signer_key_id: number;
  issued_at: string;
}

/** The fourteen fields, in the Rust struct's (and the byte layout's) order. */
export const SETTLEMENT_PAYLOAD_FIELDS: readonly string[] = Object.freeze([
  "version",
  "domain",
  "seq",
  "kind",
  "reason",
  "log_len",
  "log_hash",
  "appraisal_log_len",
  "appraisal_state_hash",
  "state_schema_version",
  "seat_count",
  "settlement_weights",
  "signer_key_id",
  "issued_at",
]);

/** Rev-1 / pre-amendment names (SET-0A rev 2 §21 A1/A2). A payload object carrying one is refused by name. */
const STALE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  terminal_state_hash: "appraisal_state_hash",
  net_worth: "settlement_weights",
  state_digest: "appraisal_state_hash",
});

interface Fields {
  version: number;
  domain: Uint8Array;
  seq: bigint;
  kind: number;
  reason: number;
  log_len: bigint;
  log_hash: Uint8Array;
  appraisal_log_len: bigint;
  appraisal_state_hash: Uint8Array;
  state_schema_version: number;
  weights: bigint[];
  signer_key_id: number;
  issued_at: bigint;
}

/**
 * The own data fields of a PLAIN object (prototype `Object.prototype` or `null`), each read EXACTLY ONCE from its
 * property descriptor. Refused: anything else, a symbol key, a non-enumerable or accessor property, a stale SET-0A
 * name and any key outside `allowed`. Nothing is read through the prototype chain, so neither an inherited field nor
 * a polluted `Object.prototype` can supply a value; nothing is read twice, so neither a getter nor a Proxy trap can
 * show one reader one value and another reader another.
 */
function ownDataFields(
  value: unknown,
  allowed: readonly string[],
  where: string,
  code: SettlementPayloadErrorCode,
): Record<string, unknown> {
  // A null-prototype map: reading a field the caller did not supply gives `undefined`, never an inherited value.
  const out = Object.create(null) as Record<string, unknown>;
  try {
    // Inside the try: even `Array.isArray` throws on a revoked Proxy.
    if (!isRecord(value)) return refuse(code, `${where} is not an object`);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) refuse(code, `${where} is not a plain object`);
    const keys = Reflect.ownKeys(value);
    for (let at = 0; at < keys.length; at += 1) {
      const key = keys[at];
      if (typeof key === "symbol") refuse(code, `${where} has a symbol key`);
      const name = key as string;
      if (Object.prototype.hasOwnProperty.call(STALE_FIELDS, name)) {
        refuse(code, `${where} carries the stale field ${name}; SET-0A rev 2 renamed it ${STALE_FIELDS[name]}`);
      }
      if (allowed.indexOf(name) < 0) refuse(code, `${where} carries an unknown field ${name}`);
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined) refuse(code, `${where}.${name} vanished while it was read`);
      if (!descriptor!.enumerable) refuse(code, `${where}.${name} is not enumerable`);
      if (descriptor!.get !== undefined || descriptor!.set !== undefined) refuse(code, `${where}.${name} is an accessor`);
      out[name] = descriptor!.value;
    }
  } catch (error) {
    if (error instanceof SettlementPayloadError) throw error;
    // A revoked Proxy or a throwing trap: not a payload, and a coded refusal rather than a raw TypeError.
    return refuse(code, `${where} could not be read (${error instanceof Error ? error.name : "error"})`);
  }
  return out;
}

/**
 * Reads every field once (`ownDataFields`) and checks it in the Rust structured path's order, in three phases:
 *   1. each field's TYPE and RANGE, and hex FORMAT -- what serde refuses before `TryFrom` runs;
 *   2. `seat_count` against the number of weights -- `TryFrom`'s `SeatCountMismatch`;
 *   3. each byte field's LENGTH (domain, log_hash, appraisal_state_hash) -- `TryFrom`'s `BadLength`.
 * This is the whole structural check the encoder makes; `kind`/`reason`/`seq` semantics are
 * `checkSettlementPayloadShape`'s, exactly as `Payload::encode` and `Payload::check_shape` are separate in Rust.
 */
function readFields(payload: unknown, code: SettlementPayloadErrorCode = "MALFORMED_INPUT", where = "the payload"): Fields {
  try {
    return readFieldsUnguarded(payload, code, where);
  } catch (error) {
    if (error instanceof SettlementPayloadError) throw error;
    // A revoked Proxy as a field value (e.g. the weights array): a coded refusal, not a raw TypeError.
    return refuse(code, `${where} could not be read (${error instanceof Error ? error.name : "error"})`);
  }
}

function readFieldsUnguarded(payload: unknown, code: SettlementPayloadErrorCode, where: string): Fields {
  const raw = ownDataFields(payload, SETTLEMENT_PAYLOAD_FIELDS, where, code);
  // Phase 1: types, ranges, hex format.
  const version = u8(raw.version, "version");
  const domainHex = hexFormat(raw.domain, "domain");
  const seq = u64(raw.seq, "seq");
  const kind = u8(raw.kind, "kind");
  const reason = u8(raw.reason, "reason");
  const logLen = u64(raw.log_len, "log_len");
  const logHashHex = hexFormat(raw.log_hash, "log_hash");
  const appraisalLogLen = u64(raw.appraisal_log_len, "appraisal_log_len");
  const stateHashHex = hexFormat(raw.appraisal_state_hash, "appraisal_state_hash");
  const stateSchemaVersion = u16(raw.state_schema_version, "state_schema_version");
  const seatCount = u8(raw.seat_count, "seat_count");
  const weightsRaw = raw.settlement_weights;
  if (!Array.isArray(weightsRaw)) return refuse(code, "settlement_weights is not an array");
  const length = weightsRaw.length;
  /* AN INDEX LOOP, NOT map: `map` skips holes, and a hole is a seat with no weight. */
  const weights: bigint[] = [];
  for (let at = 0; at < length; at += 1) {
    if (!(at in weightsRaw)) refuse(code, `settlement_weights[${at}] is missing`);
    weights.push(u128(weightsRaw[at], `settlement_weights[${at}]`));
  }
  const signerKeyId = u16(raw.signer_key_id, "signer_key_id");
  const issuedAt = u64(raw.issued_at, "issued_at");
  // Phase 2: the explicit n byte against the weights.
  if (seatCount !== length) refuse("SEAT_COUNT_MISMATCH", `seat_count ${seatCount} but ${length} settlement weights`);
  // Phase 3: byte lengths.
  return {
    version,
    domain: hexBytes(domainHex, 32, "domain"),
    seq,
    kind,
    reason,
    log_len: logLen,
    log_hash: hexBytes(logHashHex, 32, "log_hash"),
    appraisal_log_len: appraisalLogLen,
    appraisal_state_hash: hexBytes(stateHashHex, 32, "appraisal_state_hash"),
    state_schema_version: stateSchemaVersion,
    weights,
    signer_key_id: signerKeyId,
    issued_at: issuedAt,
  };
}

function encodeFields(f: Fields): Uint8Array {
  const n = f.weights.length;
  const parts: Uint8Array[] = [
    beBytes(BigInt(f.version), 1),
    f.domain,
    beBytes(f.seq, 8),
    beBytes(BigInt(f.kind), 1),
    beBytes(BigInt(f.reason), 1),
    beBytes(f.log_len, 8),
    f.log_hash,
    beBytes(f.appraisal_log_len, 8),
    f.appraisal_state_hash,
    beBytes(BigInt(f.state_schema_version), 2),
    beBytes(BigInt(n), 1),
  ];
  for (let at = 0; at < n; at += 1) parts.push(beBytes(f.weights[at], SETTLEMENT_PAYLOAD_WEIGHT_LEN));
  parts.push(beBytes(BigInt(f.signer_key_id), 2), beBytes(f.issued_at, 8));
  const out = concatBytes(parts);
  if (out.length !== SETTLEMENT_PAYLOAD_FIXED_LEN + SETTLEMENT_PAYLOAD_WEIGHT_LEN * n) {
    throw new Error(`encoder invariant broken: ${out.length} bytes for n = ${n}`);
  }
  return out;
}

/**
 * THE canonical encoding: `136 + 16·n` bytes, big-endian, byte-identical to Rust `Payload::encode`.
 *
 * Refuses (and never truncates or coerces): a non-object, an unknown or stale field, a wrong-typed or out-of-range
 * integer (a `number` for a u64/u128 field included), hex that is not lowercase or not the field's length,
 * `seat_count` ≠ the number of weights, a hole in the weights, and `version` ≠ 1 (this is the V1 encoder; Rust's
 * decoder and shape check refuse any other version too). It does NOT judge `kind`/`reason`/`seq` coupling -- that is
 * `checkSettlementPayloadShape`, as in Rust -- so a mutated field is visible as a changed digest.
 */
export function encodeSettlementPayloadV1(payload: SettlementPayloadV1): Uint8Array {
  const fields = readFields(payload);
  if (fields.version !== SETTLEMENT_PAYLOAD_VERSION) refuse("BAD_VERSION", `version ${fields.version}`);
  return encodeFields(fields);
}

/** `encodeSettlementPayloadV1` as lowercase hex. */
export function encodeSettlementPayloadV1Hex(payload: SettlementPayloadV1): string {
  return bytesToHex(encodeSettlementPayloadV1(payload));
}

/* ------------------------------------------------------------------ */
/* Shape rules (Rust `Payload::check_shape`) and payload rules        */
/* ------------------------------------------------------------------ */

/** Which contract message the payload is for (Rust `PayloadUse`). */
export type SettlementPayloadUse = "Checkpoint" | "Settle" | "ResolverReplace";

function checkShapeFields(f: Fields, usage: SettlementPayloadUse): void {
  const { Checkpoint, Terminal } = SETTLEMENT_PAYLOAD_KIND;
  const R = SETTLEMENT_PAYLOAD_REASON;
  if (f.version !== SETTLEMENT_PAYLOAD_VERSION) refuse("BAD_VERSION", `version ${f.version}`);
  if (f.kind !== Checkpoint && f.kind !== Terminal) refuse("BAD_KIND", `kind ${f.kind}`);
  if (f.reason > R.ResolverCorrection) refuse("UNKNOWN_REASON", `reason ${f.reason}`);
  // ESCROW-1.5 §5.4: a Checkpoint with reason != 0 or a Terminal with reason == 0 is refused.
  const coupled = f.kind === Checkpoint ? f.reason === R.RoundBoundary : f.reason !== R.RoundBoundary;
  if (!coupled) refuse("REASON_NOT_ALLOWED", `reason ${f.reason} with kind ${f.kind}`);
  switch (usage) {
    case "Checkpoint":
      if (f.kind !== Checkpoint) refuse("WRONG_KIND", "expected checkpoint");
      break;
    case "Settle":
      if (f.kind !== Terminal) refuse("WRONG_KIND", "expected terminal");
      // §9.1 Settle: reason 1..4. ResolverCorrection is resolver-only.
      if (f.reason < R.BankBroken || f.reason > R.Clemency) refuse("REASON_NOT_ALLOWED", `reason ${f.reason} for Settle`);
      break;
    case "ResolverReplace":
      if (f.kind !== Terminal) refuse("WRONG_KIND", "expected terminal");
      if (f.reason !== R.ResolverCorrection) refuse("REASON_NOT_ALLOWED", `reason ${f.reason} for Replace`);
      break;
    default:
      refuse("MALFORMED_INPUT", `unknown payload use ${describe(usage)}`);
  }
  // §5.2: seq = 2·log_len + kind (checked, never wrapped: Rust `checked_mul`/`checked_add`).
  const expectedSeq = TWO * f.log_len + BigInt(f.kind);
  if (expectedSeq > U64_MAX || expectedSeq !== f.seq) refuse("BAD_SEQ", `seq ${f.seq.toString()}`);
  // A1: appraisal_log_len <= log_len, with equality for Checkpoint and reasons 1, 2, 5.
  const mustEqual =
    f.kind === Checkpoint || f.reason === R.BankBroken || f.reason === R.Bankruptcy || f.reason === R.ResolverCorrection;
  const ok = mustEqual ? f.appraisal_log_len === f.log_len : f.appraisal_log_len <= f.log_len;
  if (!ok) {
    refuse(
      "BAD_APPRAISAL_LOG_LEN",
      `appraisal_log_len ${f.appraisal_log_len.toString()} with log_len ${f.log_len.toString()}`,
    );
  }
}

/** The game-independent structural rules, in Rust `check_shape`'s order (version → kind → reason → coupling → the
 *  message's kind/reason → seq → A1). */
export function checkSettlementPayloadShape(payload: SettlementPayloadV1, usage: SettlementPayloadUse): void {
  checkShapeFields(readFields(payload), usage);
}

function checkPayloadFields(f: Fields, usage: SettlementPayloadUse): void {
  checkShapeFields(f, usage);
  const n = f.weights.length;
  if (n < MIN_SETTLEMENT_SEATS || n > MAX_SETTLEMENT_SEATS) {
    refuse("BAD_SEAT_COUNT", `n=${n} (the contract's roster bound is ${MIN_SETTLEMENT_SEATS}..${MAX_SETTLEMENT_SEATS})`);
  }
  let sum = ZERO;
  for (let at = 0; at < n; at += 1) sum += f.weights[at];
  if (sum === ZERO) refuse("SETTLEMENT_ZERO_SUM", "sum of weights is zero");
}

/**
 * Everything the contract checks about a payload that does not need chain state: the shape rules, `n` within the
 * roster bound 2..7 and Σw > 0 (Rust `check_payload_for_game` minus domain equality, roster-length equality and
 * `seq > trusted_seq`, which need the game and are ESCROW-3's to compare against the chain).
 */
export function checkSettlementPayloadV1(payload: SettlementPayloadV1, usage: SettlementPayloadUse): void {
  checkPayloadFields(readFields(payload), usage);
}

/* ------------------------------------------------------------------ */
/* The wire JSON (contract ABI)                                        */
/* ------------------------------------------------------------------ */

function wireDecimal(value: unknown, max: bigint, bits: number, where: string): bigint {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    return refuse("MALFORMED_WIRE", `${where}=${describe(value)} is not a canonical decimal string`);
  }
  return bigUint(BigInt(value), max, bits, where);
}

/** The payload as the contract's JSON (`ExecuteMsg::{Checkpoint, Settle, LivenessSettle}.payload`), keys in the Rust
 *  struct's order. Validates like the encoder. */
export function settlementPayloadToWire(payload: SettlementPayloadV1): SettlementPayloadV1Wire {
  const f = readFields(payload);
  if (f.version !== SETTLEMENT_PAYLOAD_VERSION) refuse("BAD_VERSION", `version ${f.version}`);
  return {
    version: f.version,
    domain: bytesToHex(f.domain),
    seq: f.seq.toString(),
    kind: f.kind,
    reason: f.reason,
    log_len: f.log_len.toString(),
    log_hash: bytesToHex(f.log_hash),
    appraisal_log_len: f.appraisal_log_len.toString(),
    appraisal_state_hash: bytesToHex(f.appraisal_state_hash),
    state_schema_version: f.state_schema_version,
    seat_count: f.weights.length,
    settlement_weights: f.weights.map((weight) => weight.toString()),
    signer_key_id: f.signer_key_id,
    issued_at: f.issued_at.toString(),
  };
}

/**
 * Strictly parses the contract's JSON into a frozen `SettlementPayloadV1`: exactly the fourteen keys (cw_serde denies
 * unknown fields), JSON numbers for u8/u16, CANONICAL decimal strings for u64/u128 (stricter than Rust, which also
 * reads `"007"` and `"+7"`), lowercase hex. `seat_count` must equal the number of weights.
 */
export function settlementPayloadFromWire(wire: unknown): SettlementPayloadV1 {
  const raw = ownDataFields(wire, SETTLEMENT_PAYLOAD_FIELDS, "the payload JSON", "MALFORMED_WIRE");
  for (let at = 0; at < SETTLEMENT_PAYLOAD_FIELDS.length; at += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, SETTLEMENT_PAYLOAD_FIELDS[at])) {
      refuse("MALFORMED_WIRE", `the payload JSON has no ${SETTLEMENT_PAYLOAD_FIELDS[at]}`);
    }
  }
  const weightsRaw = raw.settlement_weights;
  if (!Array.isArray(weightsRaw)) return refuse("MALFORMED_WIRE", "settlement_weights is not an array");
  const weights: bigint[] = [];
  for (let at = 0; at < weightsRaw.length; at += 1) {
    if (!(at in weightsRaw)) refuse("MALFORMED_WIRE", `settlement_weights[${at}] is missing`);
    weights.push(wireDecimal(weightsRaw[at], U128_MAX_LOCAL, 128, `settlement_weights[${at}]`));
  }
  /* The decimal strings become bigints here; everything else -- u8/u16 types, hex format, then the seat count, then
     the byte lengths -- is judged by readFields in the Rust structured path's order. */
  const f = readFields(
    {
      version: raw.version,
      domain: raw.domain,
      seq: wireDecimal(raw.seq, U64_MAX, 64, "seq"),
      kind: raw.kind,
      reason: raw.reason,
      log_len: wireDecimal(raw.log_len, U64_MAX, 64, "log_len"),
      log_hash: raw.log_hash,
      appraisal_log_len: wireDecimal(raw.appraisal_log_len, U64_MAX, 64, "appraisal_log_len"),
      appraisal_state_hash: raw.appraisal_state_hash,
      state_schema_version: raw.state_schema_version,
      seat_count: raw.seat_count,
      settlement_weights: weights,
      signer_key_id: raw.signer_key_id,
      issued_at: wireDecimal(raw.issued_at, U64_MAX, 64, "issued_at"),
    },
    "MALFORMED_WIRE",
    "the payload JSON",
  );
  return fieldsToPayload(f);
}

/** A frozen plain `SettlementPayloadV1` of fields that have already passed `readFields`. */
function fieldsToPayload(f: Fields): SettlementPayloadV1 {
  return Object.freeze({
    version: f.version,
    domain: bytesToHex(f.domain),
    seq: f.seq,
    kind: f.kind,
    reason: f.reason,
    log_len: f.log_len,
    log_hash: bytesToHex(f.log_hash),
    appraisal_log_len: f.appraisal_log_len,
    appraisal_state_hash: bytesToHex(f.appraisal_state_hash),
    state_schema_version: f.state_schema_version,
    seat_count: f.weights.length,
    settlement_weights: Object.freeze(f.weights.slice()),
    signer_key_id: f.signer_key_id,
    issued_at: f.issued_at,
  });
}

/* ------------------------------------------------------------------ */
/* The frozen digests (Rust `crypto.rs`)                               */
/* ------------------------------------------------------------------ */

/** `SHA-256("18JUNO/SETTLE/v1" ‖ bytes)` over bytes already encoded (lowercase hex in, lowercase hex out). */
export function settleDigestOfEncodedHex(encodedHex: string): string {
  return bytesToHex(sha256([utf8Bytes(SETTLE_TAG_V1), hexToBytes(encodedHex, "encoded payload")]));
}

/** `settle = SHA-256("18JUNO/SETTLE/v1" ‖ encode(payload))`: what the settlement key signs and what consents bind. */
export function settleDigestV1(payload: SettlementPayloadV1): string {
  return bytesToHex(sha256([utf8Bytes(SETTLE_TAG_V1), encodeSettlementPayloadV1(payload)]));
}

/** `consent = SHA-256("18JUNO/CONSENT/v1" ‖ domain ‖ u64(seq) ‖ settle)`: what one seat's consent key signs. */
export function consentDigestV1(domain: string, seq: bigint, settleDigest: string): string {
  return bytesToHex(
    sha256([
      utf8Bytes(CONSENT_TAG_V1),
      hexBytes(domain, 32, "domain"),
      beBytes(u64(seq, "seq"), 8),
      hexBytes(settleDigest, 32, "settle_digest"),
    ]),
  );
}

/**
 * `annul = SHA-256("18JUNO/ANNUL/v1" ‖ domain ‖ u64(trusted_seq))`: what EVERY seat's consent key signs to annul.
 *
 * ESCROW-2.1 (OD-ESC2-3): the sequence is the game's TRUSTED sequence -- `GameResponse.trusted_seq`, the highest seq
 * among the game's evidence whose signer key is not compromised -- NOT the raw `Game.last_seq`. They are equal until a
 * signer key is marked compromised; after that, signatures over the raw `last_seq` are refused (`InvalidConsent`).
 * The byte layout is ESCROW-2's; only the value bound changed. (The Python vector file still names this field
 * `last_seq`: it predates 2.1 and is just a u64.)
 */
export function annulDigestV1(domain: string, trustedSeq: bigint): string {
  return bytesToHex(
    sha256([utf8Bytes(ANNUL_TAG_V1), hexBytes(domain, 32, "domain"), beBytes(u64(trustedSeq, "trusted_seq"), 8)]),
  );
}

/**
 * `roster_hash = SHA-256("18JUNO/ROSTER/v1" ‖ u8(n) ‖ for each seat: u16(len) ‖ address)`, the wallets in
 * `chain_seat_index` order. Addresses only, so consent-key rotation never moves it. 2..7 seats (the contract bound);
 * each address exactly as the contract stores it (see `addressField`).
 */
export function rosterHashV1(wallets: readonly string[]): string {
  if (!Array.isArray(wallets)) return refuse("MALFORMED_INPUT", "the roster is not an array");
  const n = wallets.length;
  if (n < MIN_SETTLEMENT_SEATS || n > MAX_SETTLEMENT_SEATS) refuse("BAD_SEAT_COUNT", `roster n=${n}`);
  const parts: Uint8Array[] = [utf8Bytes(ROSTER_TAG_V1), beBytes(BigInt(n), 1)];
  for (let at = 0; at < n; at += 1) {
    if (!(at in wallets)) refuse("MALFORMED_INPUT", `roster[${at}] is missing`);
    const bytes = addressField(wallets[at], `roster[${at}]`);
    parts.push(beBytes(BigInt(bytes.length), 2), bytes);
  }
  return bytesToHex(sha256(parts));
}

/** Inputs of the settlement domain, frozen at `Start` (Rust `crypto::DomainInputs`). */
export interface SettlementDomainInputs {
  /** The exact chain id the node reports (`env.block.chain_id`), e.g. `juno-1`. */
  chain_id: string;
  /** The escrow contract's address (`env.contract.address`). */
  contract_addr: string;
  chain_game_id: bigint;
  /** 32 bytes, lowercase hex: `rosterHashV1(wallets)`. */
  roster_hash: string;
  /** The game's declared rules engine (u32): must equal the appraised board's `rules_engine_version`. */
  rules_engine_version: number;
  /** 32 bytes, lowercase hex. */
  variants_digest: string;
  /** The gross ante in ujuno (u128). */
  ante_gross: bigint;
  /** 0 = live, 1 = async. */
  mode: number;
}

/** `domain = SHA-256("18JUNO/DOMAIN/v1" ‖ u16(len) ‖ chain_id ‖ u16(len) ‖ contract_addr ‖ u64(chain_game_id) ‖
 *  roster_hash ‖ u32(rules_engine_version) ‖ variants_digest ‖ u128(ante_gross) ‖ u8(mode))`. */
export function settlementDomainV1(inputs: SettlementDomainInputs): string {
  if (!isRecord(inputs)) return refuse("MALFORMED_INPUT", "the domain inputs are not an object");
  const chain = utf8Field(inputs.chain_id, "chain_id");
  const contract = addressField(inputs.contract_addr, "contract_addr");
  const mode = u8(inputs.mode, "mode");
  if (mode !== 0 && mode !== 1) refuse("INTEGER_OUT_OF_RANGE", `mode=${mode} is neither 0 (live) nor 1 (async)`);
  return bytesToHex(
    sha256([
      utf8Bytes(DOMAIN_TAG_V1),
      beBytes(BigInt(chain.length), 2),
      chain,
      beBytes(BigInt(contract.length), 2),
      contract,
      beBytes(u64(inputs.chain_game_id, "chain_game_id"), 8),
      hexBytes(inputs.roster_hash, 32, "roster_hash"),
      beBytes(BigInt(u32(inputs.rules_engine_version, "rules_engine_version")), 4),
      hexBytes(inputs.variants_digest, 32, "variants_digest"),
      beBytes(u128(inputs.ante_gross, "ante_gross"), 16),
      beBytes(BigInt(mode), 1),
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Seats: one list feeds the appraisal order AND the roster order      */
/* ------------------------------------------------------------------ */

/** One money seat as ESCROW-3 knows it. `wallet` is the immutable payout address the contract seated at
 *  `chain_seat_index`; `player_id` is the log's seat id. The current `principal_id` (who is playing the seat now) is
 *  deliberately absent: it is server state, never contract bytes. */
export interface SettlementSeatBinding {
  chain_seat_index: number;
  player_id: string;
  wallet: string;
}

/** The appraisal seats and the roster, both in `chain_seat_index` order, from ONE binding list. */
export interface SettlementSeatMapping {
  seats: readonly SettlementSeat[];
  wallets: readonly string[];
  roster_hash: string;
}

/**
 * Derives the appraisal seats (`settlement_weights[i]` belongs to `seats[i]`) and the on-chain roster (the contract
 * pays `settlement_weights[i]` to seat i's wallet, and hashes the wallets in that order) from one list, so the two
 * orders cannot drift apart. 2..7 bindings, `chain_seat_index === position`, player ids unique and non-empty, wallets
 * unique (the contract refuses `AlreadySeated`) and normalised. Turn order is never an input.
 */
export function settlementSeatMapping(bindings: readonly SettlementSeatBinding[]): SettlementSeatMapping {
  if (!Array.isArray(bindings)) return refuse("MALFORMED_INPUT", "the seat bindings are not an array");
  const n = bindings.length;
  if (n < MIN_SETTLEMENT_SEATS || n > MAX_SETTLEMENT_SEATS) refuse("BAD_SEAT_COUNT", `n=${n}`);
  const seats: SettlementSeat[] = [];
  const wallets: string[] = [];
  for (let at = 0; at < n; at += 1) {
    const binding: unknown = bindings[at];
    if (!isRecord(binding)) return refuse("MALFORMED_INPUT", `bindings[${at}] is not a seat binding`);
    const index = binding.chain_seat_index;
    const player = binding.player_id;
    const wallet = binding.wallet;
    if (index !== at) refuse("MALFORMED_INPUT", `position ${at} carries chain_seat_index ${describe(index)}`);
    if (typeof player !== "string" || player.length === 0) {
      refuse("MALFORMED_INPUT", `bindings[${at}].player_id=${describe(player)}`);
    }
    addressField(wallet, `bindings[${at}].wallet`);
    for (let before = 0; before < at; before += 1) {
      if (seats[before].player_id === player) refuse("MALFORMED_INPUT", `player ${player as string} holds two seats`);
      if (wallets[before] === wallet) refuse("MALFORMED_INPUT", `wallet ${wallet as string} holds two seats`);
    }
    seats.push(Object.freeze({ seat_index: at, player_id: player as string }));
    wallets.push(wallet as string);
  }
  return Object.freeze({
    seats: Object.freeze(seats),
    wallets: Object.freeze(wallets),
    roster_hash: rosterHashV1(wallets),
  });
}

/* ------------------------------------------------------------------ */
/* The builder: the ESCROW-3 path                                     */
/* ------------------------------------------------------------------ */

/** Which payload, and for a terminal the policy's inputs. */
export type SettlementPayloadIntent =
  | { kind: "Checkpoint" }
  | { kind: "Terminal"; outcome: TerminalOutcome; terms: EscrowTerms };

const DOMAIN_INPUT_FIELDS: readonly string[] = Object.freeze([
  "chain_id",
  "contract_addr",
  "chain_game_id",
  "roster_hash",
  "rules_engine_version",
  "variants_digest",
  "ante_gross",
  "mode",
]);

export interface BuildSettlementPayloadArgs {
  /** The sealed board at `appraisal_log_len`: a board object (its canonical text is taken ONCE, by
   *  `commitAndAppraise`) or canonical text already committed (appraised by `appraiseCommittedState`). */
  board: { state: GameStateResponse } | { canonical_text: string };
  /** The money seats in chain seat order. They give BOTH the appraisal order (`settlement_weights[i]` belongs to
   *  `bindings[i].player_id`) and the roster the contract pays (`bindings[i].wallet`), which must hash to
   *  `domain_inputs.roster_hash`: a weight vector cannot be built in an order the chain does not pay in. */
  bindings: readonly SettlementSeatBinding[];
  /** The game's settlement domain as stored on chain (`Game.domain`), lowercase hex. */
  domain: string;
  /** The domain's inputs: `domain` must be their hash, their roster the bindings' wallets, and their rules engine
   *  the board's pin (the appraiser separately requires that pin to be certified for settlement). */
  domain_inputs: SettlementDomainInputs;
  intent: SettlementPayloadIntent;
  /** Raw log entries covered: `[0, log_len)`. */
  log_len: bigint;
  /** `logHash(entries, log_len)`, lowercase hex. */
  log_hash: string;
  /** The board's own log position. Equal to `log_len` for a checkpoint and reasons 1, 2, 5 (A1). */
  appraisal_log_len: bigint;
  state_schema_version: number;
  signer_key_id: number;
  /** Informational unix seconds (the contract never compares it). */
  issued_at: bigint;
}

/** A built payload: its bytes, its digest, and the committed appraisal it came from. Every field is immutable. */
export interface BuiltSettlementPayload {
  payload: SettlementPayloadV1;
  wire: SettlementPayloadV1Wire;
  usage: SettlementPayloadUse;
  /** `136 + 16·n` bytes, lowercase hex. */
  encoded_hex: string;
  /** `settleDigestV1(payload)`: the digest the settlement key signs (ESCROW-3). */
  settle_digest: string;
  /** The exact committed bytes `appraisal_state_hash` is the hash of. */
  canonical_text: string;
  /** The appraisal seats and the roster the weights were built for, in chain seat order. */
  seats: readonly SettlementSeat[];
  roster_hash: string;
  /** The base vector (identity for every reason supported today) and its per-seat components. */
  base_vector: readonly bigint[];
  appraisals: readonly SeatAppraisal[];
}

/**
 * Builds, checks and encodes a `SettlementPayloadV1` from ONE committed snapshot. Throws `SettlementAppraisalError`
 * for a board, seat or policy refusal (SET-0B: e.g. `UNSUPPORTED_RULES_ENGINE_VERSION`, `REASON_NOT_SUPPORTED` for
 * Forfeit/Clemency) and `SettlementPayloadError` for a wire or cross-check refusal.
 *
 * What it decides: nothing that is policy. `seq = 2·log_len + kind` and the reason byte follow from the intent;
 * `appraisal_state_hash` and the base vector come from the one commitment; the weights are the base vector for a
 * checkpoint and `terminalSettlementWeights` for a terminal. What it proves before encoding: the on-chain domain is
 * the hash of the stated inputs, the bindings' wallets are that domain's roster in that order, and the domain's rules
 * engine is the board's pin. Everything else is the caller's input, checked.
 */
export function buildSettlementPayloadV1(args: BuildSettlementPayloadArgs): BuiltSettlementPayload {
  if (!isRecord(args)) return refuse("MALFORMED_INPUT", "the build arguments are not an object");
  /* EVERY ARGUMENT READ ONCE, into locals: a getter cannot show a check one value and the payload another. */
  const board: unknown = args.board;
  const bindings: unknown = args.bindings;
  const domain: unknown = args.domain;
  const domainInputsRaw: unknown = args.domain_inputs;
  const intent: unknown = args.intent;
  const logLenRaw: unknown = args.log_len;
  const logHash: unknown = args.log_hash;
  const appraisalLogLen: unknown = args.appraisal_log_len;
  const stateSchemaVersion: unknown = args.state_schema_version;
  const signerKeyId: unknown = args.signer_key_id;
  const issuedAt: unknown = args.issued_at;
  if (!isRecord(board)) return refuse("MALFORMED_INPUT", "board is not { state } or { canonical_text }");
  const hasState = Object.prototype.hasOwnProperty.call(board, "state");
  const hasText = Object.prototype.hasOwnProperty.call(board, "canonical_text");
  if (hasState === hasText) return refuse("MALFORMED_INPUT", "board must carry exactly one of state / canonical_text");

  /* THE CHAIN SIDE, PROVEN FIRST. The domain inputs are copied once into a plain object, hashed, and compared from
     that one copy; the bindings give the seats and the roster from one list. */
  const inputs = ownDataFields(domainInputsRaw, DOMAIN_INPUT_FIELDS, "domain_inputs", "MALFORMED_INPUT") as unknown as SettlementDomainInputs;
  const computed = settlementDomainV1(inputs);
  if (computed !== domain) refuse("DOMAIN_MISMATCH", `domain ${describe(domain)} is not the inputs' ${computed}`);
  const mapping = settlementSeatMapping(bindings as readonly SettlementSeatBinding[]);
  if (mapping.roster_hash !== inputs.roster_hash) {
    refuse("ROSTER_MISMATCH", `the bindings' wallets hash to ${mapping.roster_hash}, the domain's roster is ${inputs.roster_hash}`);
  }

  /* THE INTENT, READ ONCE: the reason that picks the policy is the reason that is encoded. */
  if (!isRecord(intent)) return refuse("MALFORMED_INPUT", "intent is not an object");
  const intentKind: unknown = intent.kind;
  let outcome: TerminalOutcome | null = null;
  let terms: EscrowTerms | null = null;
  if (intentKind === "Terminal") {
    const outcomeRaw: unknown = intent.outcome;
    terms = intent.terms as EscrowTerms;
    if (!isRecord(outcomeRaw)) return refuse("MALFORMED_INPUT", "intent.outcome is not an object");
    const reasonName: unknown = outcomeRaw.reason;
    if (typeof reasonName !== "string" || !Object.prototype.hasOwnProperty.call(SETTLEMENT_REASON_CODE, reasonName)) {
      return refuse("MALFORMED_INPUT", `intent.outcome.reason=${describe(reasonName)} is not a terminal reason`);
    }
    outcome =
      reasonName === "Forfeit" || reasonName === "Clemency"
        ? { reason: reasonName, offender_seat: outcomeRaw.offender_seat as number }
        : ({ reason: reasonName } as TerminalOutcome);
  } else if (intentKind !== "Checkpoint") {
    return refuse("MALFORMED_INPUT", `intent.kind=${describe(intentKind)}`);
  }

  /* THE ONE COMMITMENT. Both branches hash exactly the bytes they appraise (SET-0B §11); the hash and the vector
     below are never taken from two reads of a live object. */
  let committed: {
    canonical_text: string;
    appraisal_state_hash: string;
    vector: readonly bigint[];
    appraisals: readonly SeatAppraisal[];
    state: GameStateResponse;
  };
  if (hasState) {
    committed = commitAndAppraise(board.state as GameStateResponse, mapping.seats);
  } else {
    const text = board.canonical_text as string;
    committed = { ...appraiseCommittedState(text, mapping.seats), canonical_text: text };
  }
  const pin = (committed.state as unknown as { rules_engine_version?: unknown }).rules_engine_version;
  if (inputs.rules_engine_version !== pin) {
    refuse(
      "RULES_ENGINE_VERSION_MISMATCH",
      `the domain declares rules engine ${describe(inputs.rules_engine_version)}, the board is pinned to ${describe(pin)}`,
    );
  }

  let kind: number;
  let reason: number;
  let weights: readonly bigint[];
  let usage: SettlementPayloadUse;
  if (outcome === null) {
    kind = SETTLEMENT_PAYLOAD_KIND.Checkpoint;
    reason = SETTLEMENT_PAYLOAD_REASON.RoundBoundary;
    weights = committed.vector; // A checkpoint appraises its own boundary: the base vector, unmodified.
    usage = "Checkpoint";
  } else {
    weights = terminalSettlementWeights(committed.vector, outcome, terms as EscrowTerms); // refuses 3/4 today
    kind = SETTLEMENT_PAYLOAD_KIND.Terminal;
    reason = SETTLEMENT_REASON_CODE[outcome.reason];
    usage = outcome.reason === "ResolverCorrection" ? "ResolverReplace" : "Settle";
  }

  const logLen = u64(logLenRaw, "log_len");
  const seq = TWO * logLen + BigInt(kind);
  if (seq > U64_MAX) refuse("BAD_SEQ", `2·log_len + kind = ${seq.toString()} is not a u64`);

  const fields = readFields({
    version: SETTLEMENT_PAYLOAD_VERSION,
    domain,
    seq,
    kind,
    reason,
    log_len: logLen,
    log_hash: logHash,
    appraisal_log_len: appraisalLogLen,
    appraisal_state_hash: committed.appraisal_state_hash,
    state_schema_version: stateSchemaVersion,
    seat_count: weights.length,
    settlement_weights: weights.slice(),
    signer_key_id: signerKeyId,
    issued_at: issuedAt,
  });
  checkPayloadFields(fields, usage);
  const encoded = encodeFields(fields);
  const payload = fieldsToPayload(fields);
  return Object.freeze({
    payload,
    wire: Object.freeze(settlementPayloadToWire(payload)),
    usage,
    encoded_hex: bytesToHex(encoded),
    settle_digest: bytesToHex(sha256([utf8Bytes(SETTLE_TAG_V1), encoded])),
    canonical_text: committed.canonical_text,
    seats: mapping.seats,
    roster_hash: mapping.roster_hash,
    base_vector: committed.vector,
    appraisals: committed.appraisals,
  });
}

/* ------------------------------------------------------------------ */
/* The strict decoder (Rust `Payload::decode`)                         */
/* ------------------------------------------------------------------ */

/**
 * The exact inverse of the encoder, with Rust `Payload::decode`'s refusals in its order and wording: version ≠ 1
 * (`BAD_VERSION`), too few bytes (`MALFORMED_PAYLOAD: truncated`), a length that is not `136 + 16·n` for the `n` byte
 * (`MALFORMED_PAYLOAD: <len> bytes for n = <n>, expected exactly <136+16n>`). Like Rust it judges structure only:
 * `kind`, `reason` and `seq` are returned as found for `checkSettlementPayloadShape` to judge. An off-chain
 * verification tool and the conformance oracle; the contract itself never decodes client bytes.
 */
export function decodeSettlementPayloadV1(bytes: Uint8Array): SettlementPayloadV1 {
  if (!(bytes instanceof Uint8Array)) return refuse("MALFORMED_INPUT", "the encoded payload is not a Uint8Array");
  let pos = 0;
  const take = (width: number): number => {
    if (pos + width > bytes.length) refuse("MALFORMED_PAYLOAD", "truncated");
    const at = pos;
    pos += width;
    return at;
  };
  const small = (width: number): number => Number(beValue(bytes, take(width), width));
  const big = (width: number): bigint => beValue(bytes, take(width), width);
  const hex32 = (): string => bytesToHex(bytes.subarray(take(32), pos));

  const version = small(1);
  if (version !== SETTLEMENT_PAYLOAD_VERSION) refuse("BAD_VERSION", `version ${version}`);
  const domain = hex32();
  const seq = big(8);
  const kind = small(1);
  const reason = small(1);
  const logLen = big(8);
  const logHash = hex32();
  const appraisalLogLen = big(8);
  const appraisalStateHash = hex32();
  const stateSchemaVersion = small(2);
  const n = small(1);
  const expected = SETTLEMENT_PAYLOAD_FIXED_LEN + SETTLEMENT_PAYLOAD_WEIGHT_LEN * n;
  if (bytes.length !== expected) {
    refuse("MALFORMED_PAYLOAD", `${bytes.length} bytes for n = ${n}, expected exactly ${expected}`);
  }
  const weights: bigint[] = [];
  for (let at = 0; at < n; at += 1) weights.push(big(SETTLEMENT_PAYLOAD_WEIGHT_LEN));
  const signerKeyId = small(2);
  const issuedAt = big(8);
  if (pos !== bytes.length) refuse("MALFORMED_PAYLOAD", "trailing bytes");
  return Object.freeze({
    version,
    domain,
    seq,
    kind,
    reason,
    log_len: logLen,
    log_hash: logHash,
    appraisal_log_len: appraisalLogLen,
    appraisal_state_hash: appraisalStateHash,
    state_schema_version: stateSchemaVersion,
    seat_count: n,
    settlement_weights: Object.freeze(weights),
    signer_key_id: signerKeyId,
    issued_at: issuedAt,
  });
}
