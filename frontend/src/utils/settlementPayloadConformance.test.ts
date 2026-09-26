/** @jest-environment node */
// frontend/src/utils/settlementPayloadConformance.test.ts
//
// ==================================================================
//  SET-0C: TYPESCRIPT == RUST == PYTHON, BYTE FOR BYTE, ON THE ESCROW CRATE'S FROZEN VECTORS
// ==================================================================
//
// `contracts/escrow/testdata/payload_vectors_v1.json` was written by an independent Python implementation of the
// frozen specification (`gen_payload_vectors.py`: hashlib + python-ecdsa) and is reproduced by the Rust contract
// (`tests/vectors.rs`). This suite requires the TypeScript encoder and digests to reproduce the same file: every
// payload's fields, bytes, length, SETTLE and CONSENT digests, every roster hash, every domain, every ANNUL digest.
// The file is read from the Rust crate itself, not copied, so the three implementations cannot drift apart silently.
//
// It also replays the Rust decoder's structural behaviour (which altered byte is a structural refusal and which only
// breaks the signature) and verifies the Python RFC 6979 signatures over the TypeScript-computed digests with
// @cosmjs/crypto -- verification only; this layer signs nothing.

import { readFileSync } from "fs";
import { join } from "path";
import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";

import {
  SETTLEMENT_PAYLOAD_FIELDS,
  SettlementPayloadError,
  annulDigestV1,
  bytesToHex,
  checkSettlementPayloadV1,
  consentDigestV1,
  decodeSettlementPayloadV1,
  encodeSettlementPayloadV1,
  encodeSettlementPayloadV1Hex,
  hexToBytes,
  rosterHashV1,
  settleDigestOfEncodedHex,
  settleDigestV1,
  settlementDomainV1,
  settlementPayloadEncodedLength,
  settlementPayloadFromWire,
  settlementPayloadToWire,
  type SettlementPayloadUse,
  type SettlementPayloadV1,
} from "../gameEngine/settlementPayload";
import { sha256HexOfBytes, utf8Bytes } from "../gameEngine/sha256";

interface PayloadVector {
  name: string;
  description: string;
  payload: Record<string, unknown>;
  encoded_len: number;
  encoded: string;
  settle_digest: string;
  signer_signature: string;
  consent_digest: string;
  consent_signatures: string[];
}
interface DomainVector {
  name: string;
  chain_id: string;
  contract_addr: string;
  chain_game_id: number;
  roster: string;
  roster_hash: string;
  rules_engine_version: number;
  variants_digest: string;
  ante_gross: string;
  mode: number;
  domain: string;
}
interface VectorFile {
  format: string;
  keys: { signer: { label: string; pubkey: string }; seats: Array<{ label: string; pubkey: string }> };
  roster_vectors: Array<{ name: string; wallets: string[]; roster_hash: string }>;
  domain_vectors: DomainVector[];
  payload_vectors: PayloadVector[];
  annul_vectors: Array<{ domain_vector: string; last_seq: string; annul_digest: string; seat_signatures: string[] }>;
}

const RUST_TESTDATA = join(__dirname, "..", "..", "..", "contracts", "escrow", "testdata");
/* Normalised to LF: a Windows checkout with core.autocrlf rewrites the file's line endings, not its content. */
const VECTOR_TEXT = readFileSync(join(RUST_TESTDATA, "payload_vectors_v1.json"), "utf8").replace(/\r\n/g, "\n");
const doc = JSON.parse(VECTOR_TEXT) as VectorFile;

const usageOf = (p: SettlementPayloadV1): SettlementPayloadUse =>
  p.kind === 0 ? "Checkpoint" : p.reason === 5 ? "ResolverReplace" : "Settle";
const domainNamed = (name: string) => doc.domain_vectors.find((d) => d.name === name)!;

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

describe("the frozen vector file itself", () => {
  it("is the ESCROW-2 Python file the Rust crate reproduces (SHA-256 pinned: ESCROW-2 and ESCROW-2.1 reports)", () => {
    expect(doc.format).toBe("18JUNO/ESCROW2/payload-vectors/v1");
    // sha256 of the committed bytes, as recorded by ESCROW-2.1 §13 and reproduced by `gen_payload_vectors.py`.
    expect(sha256HexOfBytes(utf8Bytes(VECTOR_TEXT))).toBe("635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac");
    expect([doc.payload_vectors.length, doc.roster_vectors.length, doc.domain_vectors.length, doc.annul_vectors.length]).toEqual([11, 3, 5, 3]);
  });
});

describe("ROSTER: rosterHashV1 == Python == Rust", () => {
  for (const v of doc.roster_vectors) {
    it(`${v.name} (${v.wallets.length} seats)`, () => {
      expect(rosterHashV1(v.wallets)).toBe(v.roster_hash);
    });
  }
  it("is order-sensitive and length-prefixed (Rust roster_hash_is_order_sensitive_and_length_prefixed)", () => {
    const [a, b] = doc.roster_vectors[0].wallets;
    expect(rosterHashV1([a, b])).not.toBe(rosterHashV1([b, a]));
    expect(rosterHashV1(["ab", "c"])).not.toBe(rosterHashV1(["a", "bc"]));
  });
});

describe("DOMAIN: settlementDomainV1 == Python == Rust", () => {
  for (const v of doc.domain_vectors) {
    it(`${v.name}`, () => {
      const roster = doc.roster_vectors.find((r) => r.name === v.roster)!;
      expect(rosterHashV1(roster.wallets)).toBe(v.roster_hash);
      expect(
        settlementDomainV1({
          chain_id: v.chain_id,
          contract_addr: v.contract_addr,
          chain_game_id: BigInt(v.chain_game_id),
          roster_hash: v.roster_hash,
          rules_engine_version: v.rules_engine_version,
          variants_digest: v.variants_digest,
          ante_gross: BigInt(v.ante_gross),
          mode: v.mode,
        }),
      ).toBe(v.domain);
    });
  }
  it("every input moves the domain (chain id, game id, mode, ante, variants, rules engine, contract, roster)", () => {
    const base = domainNamed("mainnet-two-seat-live");
    const inputs = {
      chain_id: base.chain_id,
      contract_addr: base.contract_addr,
      chain_game_id: BigInt(base.chain_game_id),
      roster_hash: base.roster_hash,
      rules_engine_version: base.rules_engine_version,
      variants_digest: base.variants_digest,
      ante_gross: BigInt(base.ante_gross),
      mode: base.mode,
    };
    const seen = new Set([settlementDomainV1(inputs)]);
    const variants = [
      { ...inputs, chain_id: "uni-7" },
      { ...inputs, chain_game_id: BigInt(2) },
      { ...inputs, mode: 1 },
      { ...inputs, ante_gross: BigInt(2000001) },
      { ...inputs, variants_digest: "00".repeat(32) },
      { ...inputs, rules_engine_version: 11 },
      { ...inputs, contract_addr: `${base.contract_addr}q` },
      { ...inputs, roster_hash: domainNamed("mainnet-three-seat-async").roster_hash },
    ];
    for (const v of variants) {
      const d = settlementDomainV1(v);
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
    // The two Python domains that differ only by chain id / game id really are the vectors' values.
    expect(settlementDomainV1(variants[0])).toBe(domainNamed("testnet-two-seat-live").domain);
    expect(settlementDomainV1(variants[1])).toBe(domainNamed("mainnet-two-seat-live-game-2").domain);
  });
});

describe("SETTLEMENT PAYLOAD: every Python/Rust vector, exactly", () => {
  for (const v of doc.payload_vectors) {
    describe(v.name, () => {
      const payload = settlementPayloadFromWire(v.payload);
      const n = payload.settlement_weights.length;

      it("parses the ABI JSON strictly and writes it back identically, keys in the Rust struct's order", () => {
        const wire = settlementPayloadToWire(payload);
        expect(wire).toEqual(v.payload);
        expect(Object.keys(wire)).toEqual([...SETTLEMENT_PAYLOAD_FIELDS]);
        expect(JSON.stringify(wire)).toBe(JSON.stringify(v.payload));
      });

      it("encodes to the exact bytes, 136 + 16·n long", () => {
        const bytes = encodeSettlementPayloadV1(payload);
        expect(bytes.length).toBe(136 + 16 * n);
        expect(bytes.length).toBe(v.encoded_len);
        expect(settlementPayloadEncodedLength(n)).toBe(v.encoded_len);
        expect(bytesToHex(bytes)).toBe(v.encoded);
        expect(encodeSettlementPayloadV1Hex(payload)).toBe(v.encoded);
      });

      it("hashes to the exact SETTLE and CONSENT digests", () => {
        expect(settleDigestV1(payload)).toBe(v.settle_digest);
        expect(settleDigestOfEncodedHex(v.encoded)).toBe(v.settle_digest);
        expect(consentDigestV1(payload.domain, payload.seq, v.settle_digest)).toBe(v.consent_digest);
      });

      it("decodes the vector's bytes back to the same payload (the strict inverse)", () => {
        const decoded = decodeSettlementPayloadV1(hexToBytes(v.encoded));
        expect(settlementPayloadToWire(decoded)).toEqual(v.payload);
        expect(decoded.seat_count).toBe(n);
      });

      it("passes every game-independent contract rule for its message", () => {
        expect(code(() => checkSettlementPayloadV1(payload, usageOf(payload)))).toBe("OK");
      });

      it("the Python RFC 6979 signatures verify over the TypeScript digests (verification only)", async () => {
        const signer = hexToBytes(doc.keys.signer.pubkey);
        const settle = hexToBytes(settleDigestV1(payload));
        expect(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(hexToBytes(v.signer_signature)), settle, signer)).toBe(true);
        const consent = hexToBytes(consentDigestV1(payload.domain, payload.seq, settleDigestV1(payload)));
        for (let seat = 0; seat < v.consent_signatures.length; seat += 1) {
          const key = hexToBytes(doc.keys.seats[seat].pubkey);
          const sig = Secp256k1Signature.fromFixedLength(hexToBytes(v.consent_signatures[seat]));
          expect(await Secp256k1.verifySignature(sig, consent, key)).toBe(true);
        }
      });
    });
  }

  it("covers 2 and 7 seats, u128::MAX weights, every terminal reason byte, both kinds, and an earlier appraisal", () => {
    const parsed = doc.payload_vectors.map((v) => settlementPayloadFromWire(v.payload));
    const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
    expect(new Set(parsed.map((p) => p.seat_count))).toEqual(new Set([2, 3, 7]));
    expect(parsed.some((p) => p.settlement_weights.filter((w) => w === U128_MAX).length === 2 && p.seat_count === 2)).toBe(true);
    expect(parsed.some((p) => p.settlement_weights.filter((w) => w === U128_MAX).length === 6 && p.seat_count === 7)).toBe(true);
    expect(new Set(parsed.map((p) => p.reason))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(new Set(parsed.map((p) => p.kind))).toEqual(new Set([0, 1]));
    expect(parsed.some((p) => p.appraisal_log_len < p.log_len)).toBe(true);
  });
});

describe("the byte-order sentinel: every field big-endian at its frozen offset (Rust byte_order_sentinel_...)", () => {
  const v = doc.payload_vectors.find((p) => p.name === "two-seat-byte-order-sentinel")!;
  const bytes = encodeSettlementPayloadV1(settlementPayloadFromWire(v.payload));
  const at = (from: number, to: number) => Array.from(bytes.subarray(from, to));
  it("lays out version, kind, reason, lengths, schema, n, weights, key id and issued_at exactly", () => {
    expect(bytes[0]).toBe(1);
    expect(at(41, 42)).toEqual([1]);
    expect(at(42, 43)).toEqual([1]);
    expect(at(43, 51)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(at(83, 91)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(at(123, 125)).toEqual([0x21, 0x22]);
    expect(bytes[125]).toBe(2);
    expect(at(126, 142)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(at(142, 158)).toEqual(Array.from({ length: 16 }, (_, i) => 0x11 + i));
    expect(at(158, 160)).toEqual([0x31, 0x32]);
    expect(at(160, 168)).toEqual([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]);
    // seq = 2·log_len + 1, big-endian, computed in bigint.
    const seq = BigInt(2) * BigInt("0x0102030405060708") + BigInt(1);
    expect(bytesToHex(bytes.subarray(33, 41))).toBe(seq.toString(16).padStart(16, "0"));
  });
  it("a little-endian encoder would differ in every multi-byte integer (the sentinel catches it)", () => {
    const flipped = Array.from(bytes.subarray(43, 51)).reverse();
    expect(flipped).not.toEqual(at(43, 51));
  });
});

describe("ANNUL: annulDigestV1 == Python == Rust, over the TRUSTED sequence (ESCROW-2.1)", () => {
  for (const v of doc.annul_vectors) {
    it(`${v.domain_vector} at seq ${v.last_seq}`, async () => {
      /* The vector field is named `last_seq` because the file predates ESCROW-2.1; the digest is a u64 either way. What
         ESCROW-3 must feed it is `GameResponse.trusted_seq`. */
      const trustedSeq = BigInt(v.last_seq);
      const digest = annulDigestV1(domainNamed(v.domain_vector).domain, trustedSeq);
      expect(digest).toBe(v.annul_digest);
      for (let seat = 0; seat < v.seat_signatures.length; seat += 1) {
        const sig = Secp256k1Signature.fromFixedLength(hexToBytes(v.seat_signatures[seat]));
        expect(await Secp256k1.verifySignature(sig, hexToBytes(digest), hexToBytes(doc.keys.seats[seat].pubkey))).toBe(true);
      }
    });
  }
  it("binds the sequence: an older (raw last_seq) or newer seq gives a different digest", () => {
    const domain = domainNamed("mainnet-three-seat-async").domain;
    const trusted = annulDigestV1(domain, BigInt(1801));
    expect(annulDigestV1(domain, BigInt(2001))).not.toBe(trusted);
    expect(annulDigestV1(domain, BigInt(1800))).not.toBe(trusted);
  });
});

describe("every altered byte: the digest moves, and TS decode refuses exactly where Rust decode refuses", () => {
  /* Rust `every_altered_byte_is_rejected`: flipping any bit changes the SETTLE digest; flipping the low bit of each
     byte is either a structural refusal of `Payload::decode` or a payload whose digest the pinned signature does not
     verify. Rust's decoder judges only the version byte (offset 0) and the `n` byte against the length (offset 125);
     the TypeScript decoder must refuse at exactly those offsets and accept every other alteration. */
  it("for all 11 vectors, all bits, all offsets", () => {
    let structural = 0;
    let signatureOnly = 0;
    for (const v of doc.payload_vectors) {
      const original = hexToBytes(v.encoded);
      const originalDigest = settleDigestOfEncodedHex(v.encoded);
      for (let i = 0; i < original.length; i += 1) {
        for (let bit = 0; bit < 8; bit += 1) {
          const altered = original.slice();
          altered[i] ^= 1 << bit;
          expect(settleDigestOfEncodedHex(bytesToHex(altered))).not.toBe(originalDigest);
        }
        const altered = original.slice();
        altered[i] ^= 0x01;
        const outcome = code(() => decodeSettlementPayloadV1(altered));
        if (i === 0) expect(outcome).toBe("BAD_VERSION");
        else if (i === 125) expect(outcome).toBe("MALFORMED_PAYLOAD");
        else expect(outcome).toBe("OK");
        if (outcome === "OK") signatureOnly += 1;
        else structural += 1;
      }
    }
    expect(structural).toBe(2 * doc.payload_vectors.length);
    expect(signatureOnly).toBe(doc.payload_vectors.reduce((sum, v) => sum + v.encoded_len, 0) - structural);
  });

  it("the decoder's refusal wording is Rust's MalformedPayload reason, verbatim", () => {
    const v = doc.payload_vectors.find((p) => p.name === "two-seat-checkpoint")!;
    const bytes = hexToBytes(v.encoded);
    const detail = (b: Uint8Array) => {
      try {
        decodeSettlementPayloadV1(b);
        return "OK";
      } catch (error) {
        return (error as SettlementPayloadError).message;
      }
    };
    expect(detail(bytes.subarray(0, 100))).toBe("MALFORMED_PAYLOAD: truncated");
    expect(detail(bytes.subarray(0, 0))).toBe("MALFORMED_PAYLOAD: truncated");
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(detail(longer)).toBe("MALFORMED_PAYLOAD: 169 bytes for n = 2, expected exactly 168");
    const n3 = bytes.slice();
    n3[125] = 3;
    expect(detail(n3)).toBe("MALFORMED_PAYLOAD: 168 bytes for n = 3, expected exactly 184");
    const v2 = bytes.slice();
    v2[0] = 2;
    expect(detail(v2)).toBe("BAD_VERSION: version 2");
  });
});
