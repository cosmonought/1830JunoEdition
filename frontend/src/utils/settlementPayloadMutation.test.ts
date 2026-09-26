/** @jest-environment node */
// frontend/src/utils/settlementPayloadMutation.test.ts
//
// ==================================================================
//  SET-0C: EVERY FIELD MUTATED -- THE BYTES MOVE WHERE THEY SHOULD, AND ONLY THERE, OR THE PAYLOAD IS REFUSED BY NAME
// ==================================================================
//
// One valid payload per base (the escrow crate's byte-order sentinel, whose every integer has distinct bytes, and a
// real SET-0A golden payload), then one field changed at a time. For each: either the encoding changes in exactly
// that field's byte range (and the SETTLE digest moves), or the encoder / the shape rules / the decoder refuse it with
// the code the Rust contract uses for the same refusal (`BadSeq` -> `BAD_SEQ`, ...). Then the TypeScript-only hazards:
// unsafe numbers, malformed hex, stale SET-0A field names, strings with no UTF-8 form, getters that answer twice.
//
// The wire-representable cases (the `judged` ones) are mirrored, in order, under the same names and with the same
// expected outcome, by `contracts/escrow/tests/set0c_vectors.rs` (`Payload::try_from` + `check_shape` + the 2..7 and
// sum rules). `SET0C_MUTATION_EXPORT=<file>` writes them and their TypeScript outcome as JSON for a by-hand diff
// against that table; a case added here belongs there too.

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  SettlementPayloadError,
  annulDigestV1,
  bytesToHex,
  checkSettlementPayloadShape,
  checkSettlementPayloadV1,
  consentDigestV1,
  decodeSettlementPayloadV1,
  encodeSettlementPayloadV1,
  hexToBytes,
  rosterHashV1,
  settleDigestV1,
  settlementDomainV1,
  settlementPayloadEncodedLength,
  settlementPayloadFromWire,
  settlementPayloadToWire,
  type SettlementPayloadUse,
  type SettlementPayloadV1,
} from "../gameEngine/settlementPayload";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RUST = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "contracts", "escrow", "testdata", "payload_vectors_v1.json"), "utf8"),
) as Loose;
const SET0C = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "settlement", "settlementPayloadVectorsV1.json"), "utf8")) as Loose;

const SENTINEL = settlementPayloadFromWire(RUST.payload_vectors.find((v: Loose) => v.name === "two-seat-byte-order-sentinel").payload);
const GOLDEN_7 = settlementPayloadFromWire(SET0C.payload_vectors.find((v: Loose) => v.name === "SYN-12-SEVEN-PLAYERS-LPF/terminal-BankBroken").payload);
const FORFEIT = settlementPayloadFromWire(RUST.payload_vectors.find((v: Loose) => v.name === "three-seat-forfeit-earlier-appraisal").payload);
const b = (value: string | number) => BigInt(value);
const U64_MAX = (b(1) << b(64)) - b(1);
const U128_MAX = (b(1) << b(128)) - b(1);

function code(run: () => unknown): string {
  try {
    run();
    return "OK";
  } catch (error) {
    if (!(error instanceof SettlementPayloadError)) throw error;
    expect(error.message).toBe(`${error.code}: ${error.detail}`);
    return error.code;
  }
}
const mutate = (base: SettlementPayloadV1, over: Loose): SettlementPayloadV1 => ({ ...base, ...over }) as SettlementPayloadV1;
const flipHexByte = (hex: string, at: number): string =>
  hex.slice(0, 2 * at) + (parseInt(hex.substr(2 * at, 2), 16) ^ 0x01).toString(16).padStart(2, "0") + hex.slice(2 * at + 2);
/** The byte offsets at which two equal-length encodings differ. */
function diffOffsets(a: Uint8Array, c: Uint8Array): number[] {
  expect(a.length).toBe(c.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== c[i]) out.push(i);
  return out;
}
const within = (offsets: number[], from: number, to: number) => offsets.length > 0 && offsets.every((o) => o >= from && o < to);

/* Wire-representable cases and their outcome (mirrored by the Rust table in contracts/escrow/tests/set0c_vectors.rs). */
const exported: Array<{ name: string; usage: SettlementPayloadUse; wire: Loose; ts: string }> = [];
function judged(name: string, payload: SettlementPayloadV1, usage: SettlementPayloadUse): string {
  const outcome = code(() => checkSettlementPayloadV1(payload, usage));
  let wire: Loose | null = null;
  try {
    wire = settlementPayloadToWire(payload);
  } catch {
    wire = null; // not representable in the contract's JSON (e.g. version 2 is refused by the V1 writer)
  }
  if (wire) exported.push({ name, usage, wire, ts: outcome });
  return outcome;
}
afterAll(() => {
  const target = process.env.SET0C_MUTATION_EXPORT;
  if (target) writeFileSync(target, `${JSON.stringify(exported, null, 1)}\n`);
});

describe("each field category, mutated on the byte-order sentinel and on a real 7-seat golden payload", () => {
  const bases: Array<[string, SettlementPayloadV1]> = [
    ["sentinel", SENTINEL],
    ["golden-7", GOLDEN_7],
  ];
  for (const [label, base] of bases) {
    const n = base.seat_count;
    const baseBytes = encodeSettlementPayloadV1(base);
    const baseDigest = settleDigestV1(base);
    const tail = 126 + 16 * n; // signer_key_id offset

    describe(label, () => {
      it("the base itself is valid", () => {
        expect(judged(`${label}/base`, base, "Settle")).toBe("OK");
      });

      it("version: refused by the V1 encoder and by the shape rules (Rust BadVersion)", () => {
        const v2 = mutate(base, { version: 2 });
        expect(code(() => encodeSettlementPayloadV1(v2))).toBe("BAD_VERSION");
        expect(code(() => settleDigestV1(v2))).toBe("BAD_VERSION");
        expect(code(() => checkSettlementPayloadShape(v2, "Settle"))).toBe("BAD_VERSION");
        const bytes = baseBytes.slice();
        bytes[0] = 2;
        expect(code(() => decodeSettlementPayloadV1(bytes))).toBe("BAD_VERSION");
      });

      it("one domain byte: only that byte moves; SETTLE and CONSENT digests move; the shape is still valid", () => {
        for (const at of [0, 17, 31]) {
          const m = mutate(base, { domain: flipHexByte(base.domain, at) });
          expect(diffOffsets(baseBytes, encodeSettlementPayloadV1(m))).toEqual([1 + at]);
          expect(settleDigestV1(m)).not.toBe(baseDigest);
          expect(consentDigestV1(m.domain, m.seq, settleDigestV1(m))).not.toBe(consentDigestV1(base.domain, base.seq, baseDigest));
          expect(judged(`${label}/domain-byte-${at}`, m, "Settle")).toBe("OK"); // domain equality is the chain's check
        }
      });

      it("seq: bytes 33..41 move; refused BAD_SEQ (seq = 2·log_len + kind)", () => {
        for (const delta of [1, 2, -1]) {
          const m = mutate(base, { seq: base.seq + b(delta) });
          expect(within(diffOffsets(baseBytes, encodeSettlementPayloadV1(m)), 33, 41)).toBe(true);
          expect(judged(`${label}/seq${delta > 0 ? "+" : ""}${delta}`, m, "Settle")).toBe("BAD_SEQ");
        }
      });

      it("kind: byte 41 moves; 2..255 BAD_KIND, a checkpoint kind on a terminal reason REASON_NOT_ALLOWED, the wrong message WRONG_KIND", () => {
        for (const kind of [2, 255]) {
          const m = mutate(base, { kind });
          expect(diffOffsets(baseBytes, encodeSettlementPayloadV1(m))).toEqual([41]);
          expect(judged(`${label}/kind-${kind}`, m, "Settle")).toBe("BAD_KIND");
        }
        expect(judged(`${label}/kind-0-reason-1`, mutate(base, { kind: 0 }), "Checkpoint")).toBe("REASON_NOT_ALLOWED");
        expect(judged(`${label}/as-checkpoint-message`, base, "Checkpoint")).toBe("WRONG_KIND");
        const checkpoint = mutate(base, { kind: 0, reason: 0, seq: base.seq - b(1) });
        expect(judged(`${label}/checkpoint-ok`, checkpoint, "Checkpoint")).toBe("OK");
        expect(judged(`${label}/checkpoint-via-settle`, checkpoint, "Settle")).toBe("WRONG_KIND");
        expect(judged(`${label}/checkpoint-odd-seq`, mutate(checkpoint, { seq: base.seq }), "Checkpoint")).toBe("BAD_SEQ");
      });

      it("reason: byte 42 moves; 6..255 UNKNOWN_REASON; 0 on a terminal and a message's wrong reason REASON_NOT_ALLOWED", () => {
        for (const reason of [6, 200, 255]) {
          const m = mutate(base, { reason });
          expect(diffOffsets(baseBytes, encodeSettlementPayloadV1(m))).toEqual([42]);
          expect(judged(`${label}/reason-${reason}`, m, "Settle")).toBe("UNKNOWN_REASON");
        }
        expect(judged(`${label}/reason-0-terminal`, mutate(base, { reason: 0 }), "Settle")).toBe("REASON_NOT_ALLOWED");
        expect(judged(`${label}/reason-5-via-settle`, mutate(base, { reason: 5 }), "Settle")).toBe("REASON_NOT_ALLOWED");
        expect(judged(`${label}/reason-5-via-replace`, mutate(base, { reason: 5 }), "ResolverReplace")).toBe("OK");
        expect(judged(`${label}/reason-1-via-replace`, base, "ResolverReplace")).toBe("REASON_NOT_ALLOWED");
        expect(judged(`${label}/reason-2`, mutate(base, { reason: 2 }), "Settle")).toBe("OK");
      });

      it("log_len: bytes 43..51 move; alone it breaks seq (BAD_SEQ); with seq following it breaks A1 (BAD_APPRAISAL_LOG_LEN)", () => {
        const m = mutate(base, { log_len: base.log_len + b(1) });
        expect(within(diffOffsets(baseBytes, encodeSettlementPayloadV1(m)), 43, 51)).toBe(true);
        expect(judged(`${label}/log_len+1`, m, "Settle")).toBe("BAD_SEQ");
        const both = mutate(m, { seq: base.seq + b(2) });
        expect(judged(`${label}/log_len+1-seq-follows`, both, "Settle")).toBe("BAD_APPRAISAL_LOG_LEN");
      });

      it("one log_hash byte: only that byte moves (bytes 51..83)", () => {
        const m = mutate(base, { log_hash: flipHexByte(base.log_hash, 9) });
        expect(diffOffsets(baseBytes, encodeSettlementPayloadV1(m))).toEqual([51 + 9]);
        expect(settleDigestV1(m)).not.toBe(baseDigest);
        expect(judged(`${label}/log_hash-byte`, m, "Settle")).toBe("OK");
      });

      it("appraisal_log_len: bytes 83..91 move; any inequality refused for BankBroken (A1)", () => {
        for (const delta of [-1, 1]) {
          const m = mutate(base, { appraisal_log_len: base.appraisal_log_len + b(delta) });
          expect(within(diffOffsets(baseBytes, encodeSettlementPayloadV1(m)), 83, 91)).toBe(true);
          expect(judged(`${label}/appraisal_log_len${delta > 0 ? "+" : ""}${delta}`, m, "Settle")).toBe("BAD_APPRAISAL_LOG_LEN");
        }
      });

      it("one appraisal_state_hash byte: only that byte moves (bytes 91..123)", () => {
        const m = mutate(base, { appraisal_state_hash: flipHexByte(base.appraisal_state_hash, 31) });
        expect(diffOffsets(baseBytes, encodeSettlementPayloadV1(m))).toEqual([91 + 31]);
        expect(settleDigestV1(m)).not.toBe(baseDigest);
      });

      it("state_schema_version: only bytes 123..125 move", () => {
        const m = mutate(base, { state_schema_version: base.state_schema_version ^ 0x0101 });
        expect(diffOffsets(baseBytes, encodeSettlementPayloadV1(m))).toEqual([123, 124]);
        expect(judged(`${label}/state_schema_version`, m, "Settle")).toBe("OK");
      });

      it("seat_count: refused against the weights (Rust SeatCountMismatch); the n byte alone breaks the decoder", () => {
        for (const seat_count of [n - 1, n + 1, 0, 255]) {
          expect(code(() => encodeSettlementPayloadV1(mutate(base, { seat_count })))).toBe("SEAT_COUNT_MISMATCH");
        }
        const bytes = baseBytes.slice();
        bytes[125] = n + 1;
        expect(code(() => decodeSettlementPayloadV1(bytes))).toBe("MALFORMED_PAYLOAD");
      });

      it("one weight: only its 16 bytes move; out-of-range, negative, Number and hole refused; all-zero weights SETTLEMENT_ZERO_SUM", () => {
        const at = n - 1;
        const w = base.settlement_weights.slice();
        w[at] = w[at] === U128_MAX ? w[at] - b(1) : w[at] + b(1);
        const m = mutate(base, { settlement_weights: w });
        expect(within(diffOffsets(baseBytes, encodeSettlementPayloadV1(m)), 126 + 16 * at, 126 + 16 * (at + 1))).toBe(true);
        expect(judged(`${label}/weight-${at}`, m, "Settle")).toBe("OK");
        const set = (value: unknown) => {
          const copy: unknown[] = base.settlement_weights.slice();
          copy[at] = value;
          return mutate(base, { settlement_weights: copy });
        };
        expect(code(() => encodeSettlementPayloadV1(set(U128_MAX + b(1))))).toBe("INTEGER_OUT_OF_RANGE");
        expect(code(() => encodeSettlementPayloadV1(set(b(-1))))).toBe("INTEGER_OUT_OF_RANGE");
        expect(code(() => encodeSettlementPayloadV1(set(5)))).toBe("MALFORMED_INTEGER");
        expect(code(() => encodeSettlementPayloadV1(set("5")))).toBe("MALFORMED_INTEGER");
        const holey = base.settlement_weights.slice();
        delete (holey as unknown as Record<number, bigint>)[0];
        expect(code(() => encodeSettlementPayloadV1(mutate(base, { settlement_weights: holey })))).toBe("MALFORMED_INPUT");
        const zero = mutate(base, { settlement_weights: base.settlement_weights.map(() => b(0)) });
        expect(code(() => encodeSettlementPayloadV1(zero))).toBe("OK");
        expect(judged(`${label}/all-zero-weights`, zero, "Settle")).toBe("SETTLEMENT_ZERO_SUM");
      });

      it("signer_key_id: only its 2 bytes move; 65536, -1, 1.5, '1' and 1n refused", () => {
        const m = mutate(base, { signer_key_id: base.signer_key_id ^ 0x0001 });
        expect(diffOffsets(baseBytes, encodeSettlementPayloadV1(m))).toEqual([tail + 1]);
        expect(judged(`${label}/signer_key_id`, m, "Settle")).toBe("OK");
        expect(code(() => encodeSettlementPayloadV1(mutate(base, { signer_key_id: 65536 })))).toBe("INTEGER_OUT_OF_RANGE");
        expect(code(() => encodeSettlementPayloadV1(mutate(base, { signer_key_id: -1 })))).toBe("INTEGER_OUT_OF_RANGE");
        for (const bad of [1.5, "1", b(1), NaN, -0]) {
          expect(code(() => encodeSettlementPayloadV1(mutate(base, { signer_key_id: bad })))).toBe("MALFORMED_INTEGER");
        }
      });

      it("issued_at: only its 8 bytes move; 2^64 and a Number refused", () => {
        const m = mutate(base, { issued_at: base.issued_at + b(1) });
        expect(within(diffOffsets(baseBytes, encodeSettlementPayloadV1(m)), tail + 2, tail + 10)).toBe(true);
        expect(judged(`${label}/issued_at+1`, m, "Settle")).toBe("OK");
        expect(code(() => encodeSettlementPayloadV1(mutate(base, { issued_at: U64_MAX + b(1) })))).toBe("INTEGER_OUT_OF_RANGE");
        expect(code(() => encodeSettlementPayloadV1(mutate(base, { issued_at: 1758844800 })))).toBe("MALFORMED_INTEGER");
      });

      it("byte order: a little-endian log_len decodes to another value and breaks seq; the big-endian round trip is exact", () => {
        const bytes = baseBytes.slice();
        bytes.set(Array.from(baseBytes.subarray(43, 51)).reverse(), 43);
        const decoded = decodeSettlementPayloadV1(bytes);
        if (bytesToHex(bytes) !== bytesToHex(baseBytes)) {
          expect(decoded.log_len).not.toBe(base.log_len);
          expect(code(() => checkSettlementPayloadShape(decoded, "Settle"))).toBe("BAD_SEQ");
        }
        expect(decodeSettlementPayloadV1(baseBytes)).toEqual(decodeSettlementPayloadV1(encodeSettlementPayloadV1(decodeSettlementPayloadV1(baseBytes))));
      });

      it("truncated at every length: refused (Rust decode_refuses_truncation_and_trailing_bytes)", () => {
        for (let cut = 0; cut < baseBytes.length; cut += 1) {
          expect(code(() => decodeSettlementPayloadV1(baseBytes.subarray(0, cut)))).toBe("MALFORMED_PAYLOAD");
        }
      });

      it("one trailing byte: refused", () => {
        const longer = new Uint8Array(baseBytes.length + 1);
        longer.set(baseBytes);
        expect(code(() => decodeSettlementPayloadV1(longer))).toBe("MALFORMED_PAYLOAD");
      });
    });
  }

  it("Forfeit and Clemency may appraise an earlier board (≤ log_len), never a later one", () => {
    expect(judged("forfeit/earlier", FORFEIT, "Settle")).toBe("OK");
    expect(judged("forfeit/appraisal-0", mutate(FORFEIT, { appraisal_log_len: b(0) }), "Settle")).toBe("OK");
    expect(judged("forfeit/appraisal-equal", mutate(FORFEIT, { appraisal_log_len: FORFEIT.log_len }), "Settle")).toBe("OK");
    expect(judged("forfeit/appraisal-later", mutate(FORFEIT, { appraisal_log_len: FORFEIT.log_len + b(1) }), "Settle")).toBe("BAD_APPRAISAL_LOG_LEN");
    expect(judged("clemency/earlier", mutate(FORFEIT, { reason: 4 }), "Settle")).toBe("OK");
  });

  it("the roster bound: 1 and 8 weights are refused by the payload rules (the contract's 2..7)", () => {
    const one = mutate(SENTINEL, { seat_count: 1, settlement_weights: [b(5)] });
    const eight = mutate(SENTINEL, { seat_count: 8, settlement_weights: Array.from({ length: 8 }, () => b(1)) });
    expect(code(() => encodeSettlementPayloadV1(one))).toBe("OK"); // the byte layout itself allows any u8 n
    expect(judged("n=1", one, "Settle")).toBe("BAD_SEAT_COUNT");
    expect(judged("n=8", eight, "Settle")).toBe("BAD_SEAT_COUNT");
    expect(settlementPayloadEncodedLength(2)).toBe(168);
    expect(settlementPayloadEncodedLength(7)).toBe(248);
    expect(code(() => settlementPayloadEncodedLength(256))).toBe("INTEGER_OUT_OF_RANGE");
  });
});

describe("TypeScript-only hazards", () => {
  it("unsafe and float-y numbers never reach a u64/u128 field: every such field refuses a Number, safe or not", () => {
    for (const field of ["seq", "log_len", "appraisal_log_len", "issued_at"]) {
      for (const bad of [0, 7, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 2 ** 64, 1.5, NaN, Infinity, "7"]) {
        expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { [field]: bad })))).toBe("MALFORMED_INTEGER");
      }
      expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { [field]: U64_MAX + b(1) })))).toBe("INTEGER_OUT_OF_RANGE");
    }
    expect(code(() => annulDigestV1(SENTINEL.domain, 1801 as unknown as bigint))).toBe("MALFORMED_INTEGER");
    expect(code(() => consentDigestV1(SENTINEL.domain, 3 as unknown as bigint, settleDigestV1(SENTINEL)))).toBe("MALFORMED_INTEGER");
    expect(code(() => annulDigestV1(SENTINEL.domain, U64_MAX + b(1)))).toBe("INTEGER_OUT_OF_RANGE");
    expect(code(() => annulDigestV1(SENTINEL.domain, U64_MAX))).toBe("OK");
  });

  it("u64::MAX and u128::MAX encode as all-ones; 2 and 7 seats have the exact lengths", () => {
    const max = mutate(SENTINEL, { issued_at: U64_MAX, settlement_weights: [U128_MAX, U128_MAX] });
    const bytes = encodeSettlementPayloadV1(max);
    expect(bytesToHex(bytes.subarray(126, 158))).toBe("ff".repeat(32));
    expect(bytesToHex(bytes.subarray(160, 168))).toBe("ff".repeat(8));
    expect(encodeSettlementPayloadV1(SENTINEL).length).toBe(168);
    expect(encodeSettlementPayloadV1(GOLDEN_7).length).toBe(248);
  });

  it("malformed hex is refused: upper case, odd length, 0x, whitespace, non-hex, non-string; a wrong length is BAD_LENGTH", () => {
    const d = SENTINEL.domain;
    for (const bad of [d.toUpperCase(), `${d}0`, `0x${d.slice(2)}`, ` ${d.slice(1)}`, `${d.slice(0, 63)}g`, 42, null, undefined]) {
      expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { domain: bad })))).toBe("MALFORMED_HEX");
    }
    for (const bad of [d.slice(2), `${d}00`, ""]) {
      expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { domain: bad })))).toBe("BAD_LENGTH");
      expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { log_hash: bad })))).toBe("BAD_LENGTH");
      expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { appraisal_state_hash: bad })))).toBe("BAD_LENGTH");
    }
    expect(code(() => hexToBytes("ABCD"))).toBe("MALFORMED_HEX");
    expect(code(() => annulDigestV1(d.toUpperCase(), b(1)))).toBe("MALFORMED_HEX");
  });

  it("stale SET-0A rev-1 names are refused by name, never silently ignored; unknown fields too", () => {
    const withStale = (extra: Loose) => ({ ...SENTINEL, ...extra });
    let message = "";
    try {
      encodeSettlementPayloadV1(withStale({ terminal_state_hash: SENTINEL.appraisal_state_hash }) as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("MALFORMED_INPUT: the payload carries the stale field terminal_state_hash; SET-0A rev 2 renamed it appraisal_state_hash");
    expect(code(() => encodeSettlementPayloadV1(withStale({ net_worth: SENTINEL.settlement_weights }) as never))).toBe("MALFORMED_INPUT");
    expect(code(() => encodeSettlementPayloadV1(withStale({ player_id: "p1" }) as never))).toBe("MALFORMED_INPUT");
    const renamed = { ...SENTINEL } as Loose;
    renamed.net_worth = renamed.settlement_weights;
    delete renamed.settlement_weights;
    expect(code(() => encodeSettlementPayloadV1(renamed as never))).toBe("MALFORMED_INPUT");
    expect(code(() => settlementPayloadFromWire({ ...settlementPayloadToWire(SENTINEL), terminal_state_hash: "00" }))).toBe("MALFORMED_WIRE");
  });

  it("review L4: only own, enumerable DATA fields of a plain object are read -- accessors, hidden or inherited fields refused", () => {
    let reads = 0;
    const getter = { ...SENTINEL } as Loose;
    delete getter.seq;
    Object.defineProperty(getter, "seq", { enumerable: true, get: () => ((reads += 1) === 1 ? SENTINEL.seq : SENTINEL.seq + b(2)) });
    expect(code(() => encodeSettlementPayloadV1(getter as SettlementPayloadV1))).toBe("MALFORMED_INPUT");
    expect(reads).toBe(0);
    const hidden = { ...SENTINEL } as Loose;
    Object.defineProperty(hidden, "net_worth", { value: SENTINEL.settlement_weights, enumerable: false });
    expect(code(() => encodeSettlementPayloadV1(hidden as SettlementPayloadV1))).toBe("MALFORMED_INPUT");
    const inherited = Object.create({ ...SENTINEL, terminal_state_hash: SENTINEL.appraisal_state_hash }) as Loose;
    Object.assign(inherited, SENTINEL);
    expect(code(() => encodeSettlementPayloadV1(inherited as SettlementPayloadV1))).toBe("MALFORMED_INPUT");
    const withSymbol = { ...SENTINEL, [Symbol("x")]: 1 } as Loose;
    expect(code(() => encodeSettlementPayloadV1(withSymbol as SettlementPayloadV1))).toBe("MALFORMED_INPUT");
    // A polluted Object.prototype cannot supply a missing field.
    const missing = { ...SENTINEL } as Loose;
    delete missing.issued_at;
    (Object.prototype as Loose).issued_at = SENTINEL.issued_at;
    try {
      expect(code(() => encodeSettlementPayloadV1(missing as SettlementPayloadV1))).toBe("MALFORMED_INTEGER");
    } finally {
      delete (Object.prototype as Loose).issued_at;
    }
    // A Proxy whose get trap lies is read through its descriptors, once: the bytes are the target's.
    const liar = new Proxy({ ...SENTINEL } as Loose, { get: (t, key) => (key === "seq" ? SENTINEL.seq + b(2) : t[key as string]) });
    expect(bytesToHex(encodeSettlementPayloadV1(liar as SettlementPayloadV1))).toBe(bytesToHex(encodeSettlementPayloadV1(SENTINEL)));
    const { proxy, revoke } = Proxy.revocable({ ...SENTINEL } as Loose, {});
    revoke();
    expect(code(() => encodeSettlementPayloadV1(proxy as SettlementPayloadV1))).toBe("MALFORMED_INPUT");
    const dead = Proxy.revocable([b(1), b(2)], {});
    dead.revoke();
    expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { settlement_weights: dead.proxy })))).toBe("MALFORMED_INPUT");
  });

  it("review L3: the wire parser refuses in Rust's order -- types and hex format, then seat_count, then byte lengths", () => {
    const wire = settlementPayloadToWire(SENTINEL) as Loose;
    // seat_count mismatch AND a 31-byte domain: Rust TryFrom answers SeatCountMismatch first.
    expect(code(() => settlementPayloadFromWire({ ...wire, seat_count: 3, domain: wire.domain.slice(2) }))).toBe("SEAT_COUNT_MISMATCH");
    // ...but a hex FORMAT error is serde's, before TryFrom.
    expect(code(() => settlementPayloadFromWire({ ...wire, seat_count: 3, domain: wire.domain.toUpperCase() }))).toBe("MALFORMED_HEX");
    // Lengths in field order: domain, then log_hash, then appraisal_state_hash.
    let message = "";
    try {
      settlementPayloadFromWire({ ...wire, log_hash: wire.log_hash.slice(2), appraisal_state_hash: "00" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("BAD_LENGTH: log_hash must be 32 bytes, got 31");
    // The in-memory encoder uses the same three phases.
    expect(code(() => encodeSettlementPayloadV1(mutate(SENTINEL, { seat_count: 3, domain: SENTINEL.domain.slice(2) })))).toBe("SEAT_COUNT_MISMATCH");
  });

  it("the wire parser is strict: missing/extra keys, non-canonical decimals, JSON numbers for u64, strings for u8, upper-case hex", () => {
    const wire = settlementPayloadToWire(SENTINEL) as Loose;
    const without = { ...wire };
    delete without.issued_at;
    const cases: Array<[Loose, string]> = [
      [without, "MALFORMED_WIRE"],
      [{ ...wire, extra: 1 }, "MALFORMED_WIRE"],
      [{ ...wire, seq: `0${wire.seq}` }, "MALFORMED_WIRE"],
      [{ ...wire, seq: `+${wire.seq}` }, "MALFORMED_WIRE"],
      [{ ...wire, log_len: "-1" }, "MALFORMED_WIRE"],
      [{ ...wire, log_len: 5 }, "MALFORMED_WIRE"],
      [{ ...wire, issued_at: "1e9" }, "MALFORMED_WIRE"],
      [{ ...wire, settlement_weights: [1, 2] }, "MALFORMED_WIRE"],
      [{ ...wire, settlement_weights: [U128_MAX.toString(), (U128_MAX + b(1)).toString()] }, "INTEGER_OUT_OF_RANGE"],
      [{ ...wire, seq: (U64_MAX + b(1)).toString() }, "INTEGER_OUT_OF_RANGE"],
      [{ ...wire, version: "1" }, "MALFORMED_INTEGER"],
      [{ ...wire, kind: 1.5 }, "MALFORMED_INTEGER"],
      [{ ...wire, reason: 256 }, "INTEGER_OUT_OF_RANGE"],
      [{ ...wire, seat_count: 3 }, "SEAT_COUNT_MISMATCH"],
      [{ ...wire, domain: wire.domain.toUpperCase() }, "MALFORMED_HEX"],
      [{ ...wire, log_hash: wire.log_hash.slice(2) }, "BAD_LENGTH"],
      [[], "MALFORMED_WIRE"],
      [{ ...wire }, "OK"],
    ];
    for (const [input, want] of cases) expect(code(() => settlementPayloadFromWire(input))).toBe(want);
  });

  it("domain and roster inputs: no UTF-8 form, unnormalised addresses, bad mode / rules engine / roster size are refused", () => {
    const dv = RUST.domain_vectors[0] as Loose;
    const roster = RUST.roster_vectors[0].wallets as string[];
    const inputs = {
      chain_id: dv.chain_id,
      contract_addr: dv.contract_addr,
      chain_game_id: b(dv.chain_game_id),
      roster_hash: dv.roster_hash,
      rules_engine_version: 10,
      variants_digest: dv.variants_digest,
      ante_gross: b(dv.ante_gross),
      mode: 0,
    };
    expect(settlementDomainV1(inputs)).toBe(dv.domain);
    const bad: Array<[Loose, string]> = [
      [{ chain_id: "juno-\ud800" }, "MALFORMED_STRING"],
      [{ chain_id: 1 }, "MALFORMED_STRING"],
      [{ contract_addr: dv.contract_addr.toUpperCase() }, "MALFORMED_STRING"],
      [{ contract_addr: "" }, "MALFORMED_STRING"],
      [{ mode: 2 }, "INTEGER_OUT_OF_RANGE"],
      [{ rules_engine_version: -1 }, "INTEGER_OUT_OF_RANGE"],
      [{ rules_engine_version: 2 ** 32 }, "INTEGER_OUT_OF_RANGE"],
      [{ chain_game_id: 1 }, "MALFORMED_INTEGER"],
      [{ ante_gross: 2000000 }, "MALFORMED_INTEGER"],
      [{ roster_hash: dv.roster_hash.slice(2) }, "BAD_LENGTH"],
    ];
    for (const [over, want] of bad) expect(code(() => settlementDomainV1({ ...inputs, ...over } as never))).toBe(want);
    expect(code(() => rosterHashV1([roster[0]]))).toBe("BAD_SEAT_COUNT");
    expect(code(() => rosterHashV1(Array.from({ length: 8 }, (_, i) => `${roster[0]}${i}`)))).toBe("BAD_SEAT_COUNT");
    expect(code(() => rosterHashV1([roster[0], `${roster[1]} `]))).toBe("MALFORMED_STRING");
    expect(code(() => rosterHashV1([roster[0], roster[1].toUpperCase()]))).toBe("MALFORMED_STRING");
  });
});
