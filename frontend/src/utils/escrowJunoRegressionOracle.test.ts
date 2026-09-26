/** @jest-environment node */
// frontend/src/utils/escrowJunoRegressionOracle.test.ts
//
// ==================================================================
//  GNOLAND-1: THE JUNO REGRESSION ORACLE -- THE CHAIN-NEUTRAL INTERFACE CHANGES NOTHING JUNO EXTERNALLY SEES
// ==================================================================
//
// The oracle is the two FROZEN vector files, read and never written:
//   contracts/escrow/testdata/payload_vectors_v1.json          (ESCROW-2, independent Python generator, RFC 6979 sigs)
//   frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json   (SET-0C, re-derived by Rust + Python)
// Every roster hash, DOMAIN, encoded payload, SETTLE / CONSENT / ANNUL digest, payout vector, dust value, ABI wire
// object and signature in them is reproduced THROUGH the new interface (JUNO_CODEC_V1, buildSettlementCoreV1,
// EscrowBinding v2 → domain inputs) and compared byte for byte. Every SET-0C golden board is also rebuilt through
// BOTH the certified `buildSettlementPayloadV1` and `buildSettlementCoreV1(JUNO_CODEC_V1, …)`, and the two must agree
// on every output and on every refusal code. If any of this fails, the abstraction is wrong -- not the vectors.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";

import {
  SettlementPayloadError,
  buildSettlementPayloadV1,
  rosterHashV1,
  settlementDomainV1,
  type BuildSettlementPayloadArgs,
  type SettlementDomainInputs,
  type SettlementPayloadIntent,
} from "../gameEngine/settlementPayload";
import { verifySettlementPayloadV1 } from "../gameEngine/settlementConformance";
import { SettlementAppraisalError, type SettlementSeat } from "../gameEngine/settlementAppraisal";
import { sha256Hex } from "../gameEngine/sha256";
import type { GameStateResponse } from "../gameEngine/gameState";
import {
  buildSettlementCoreV1,
  encodeSettlementPayloadV1Hex,
  settlementPayloadFromWire,
  settlementPayloadToWire,
  settlementPayouts,
  verifySettlementCoreV1,
  type BuildSettlementCoreArgs,
  type SettlementCoreIntent,
} from "../gameEngine/escrow/settlementCoreV1";
import { EscrowInterfaceError, codecCommitment, codecDigest, type EscrowCodec } from "../gameEngine/escrow/escrowCodec";
import { JUNO_CODEC_V1, JUNO_CONTRACT_ERROR_MAP, junoContractError, junoDomainInputsOf } from "../gameEngine/escrow/junoCodecV1";
import { GNO_CODEC_V1_DRAFT, GNO_TAGS_V1_DRAFT } from "../gameEngine/escrow/gnoCodecV1.draft";
import {
  ESCROW_ERROR_RETRY,
  GNO_CAPABILITIES_DRAFT,
  JUNO_CAPABILITIES_V1,
  escrowInstanceKey,
  intentIdOf,
  sameIntentSubject,
  validateEscrowBindingV2,
  type EscrowBindingV2,
  type EscrowDeploymentPolicy,
  type EscrowGameView,
  type EscrowSeatClaim,
  type SignerKeyStatus,
} from "../gameEngine/escrow/escrowModel";
import { freezeEscrowRoster, joinTicketV1, type EscrowTrustPolicy } from "../gameEngine/escrow/escrowRoster";
import { checkSettlementKeyConfig, selectSettlementKey, settlementDigestToSign, type SettlementKeyConfig } from "../../../server/src/escrow/escrowPorts";
import { goldenBoards } from "./settlementGoldenBoards";
import * as GR from "./gentleRustCertificationGame";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const REPO = join(__dirname, "..", "..", "..");
const RUST_FILE = join(REPO, "contracts", "escrow", "testdata", "payload_vectors_v1.json");
const SET0C_FILE = join(__dirname, "__fixtures__", "settlement", "settlementPayloadVectorsV1.json");
const DERIVED_FILE = join(__dirname, "__fixtures__", "settlement", "SET0A_golden_vectors_rev2.derived.json");
const ERROR_RS = join(REPO, "contracts", "escrow", "src", "error.rs");

const fileSha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const rust = readJson(RUST_FILE) as Loose;
const set0c = readJson(SET0C_FILE) as Loose;
const derived = readJson(DERIVED_FILE) as Loose;
const b = (value: string | number) => BigInt(value);
const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const SECP_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/** The Juno scheme, checked independently of the codec: ECDSA secp256k1 over the 32-byte digest itself, r‖s, low-s. */
async function junoVerify(pubkeyHex: string, digestHex: string, sigHex: string): Promise<boolean> {
  expect(sigHex).toMatch(/^[0-9a-f]{128}$/);
  const s = BigInt(`0x${sigHex.slice(64)}`);
  if (s > SECP_N / BigInt(2)) return false; // high-s is refused by the contract (HighS)
  return Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(hexBytes(sigHex)), hexBytes(digestHex), hexBytes(pubkeyHex));
}

const code = (run: () => unknown): string => {
  try {
    run();
    return "OK";
  } catch (error) {
    if (error instanceof SettlementPayloadError || error instanceof SettlementAppraisalError || error instanceof EscrowInterfaceError) return error.code;
    throw error;
  }
};

/* ------------------------------------------------------------------ */
/* 0. The oracle files are the frozen ones                             */
/* ------------------------------------------------------------------ */

describe("the oracle files are exactly the frozen vector files", () => {
  it("payload_vectors_v1.json is ESCROW-2's generator output (SHA-256 635024311c…)", () => {
    expect(fileSha(RUST_FILE)).toBe("635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac");
  });
  it("settlementPayloadVectorsV1.json is SET-0C.1's (SHA-256 b58651de13…)", () => {
    expect(fileSha(SET0C_FILE)).toBe("b58651de13de2c4f91d355c15cca92689001ba4bcbdb2a9fbaa348cbe6a7906c");
  });
});

/* ------------------------------------------------------------------ */
/* 1. ESCROW-2's independent vectors through the Juno codec             */
/* ------------------------------------------------------------------ */

const rosterByName = (name: string): string[] => rust.roster_vectors.find((r: Loose) => r.name === name).wallets;
const rustDomainInputs = (d: Loose): SettlementDomainInputs => ({
  chain_id: d.chain_id,
  contract_addr: d.contract_addr,
  chain_game_id: b(d.chain_game_id),
  roster_hash: d.roster_hash,
  rules_engine_version: d.rules_engine_version,
  variants_digest: d.variants_digest,
  ante_gross: b(d.ante_gross),
  mode: d.mode,
});

/** An EscrowBinding v2 carrying a domain vector's facts (deployment facts other than the address are test values;
 *  they are not domain inputs). */
const TEST_WASM = sha256Hex("GNOLAND-1/test/wasm");
const JUNO_CONTRACTS = Array.from(new Set([...rust.domain_vectors, ...set0c.domains].map((d: Loose) => d.contract_addr as string)));
const TEST_POLICY: EscrowDeploymentPolicy = [
  { backend: "juno-cosmwasm", chain_id: "juno-1", network_class: "mainnet", deployments: JUNO_CONTRACTS.map((contract_address) => ({ kind: "juno-cosmwasm" as const, contract_address, code_checksums: [TEST_WASM], admin: null })) },
  { backend: "juno-cosmwasm", chain_id: "uni-7", network_class: "testnet", deployments: JUNO_CONTRACTS.map((contract_address) => ({ kind: "juno-cosmwasm" as const, contract_address, code_checksums: [TEST_WASM], admin: null })) },
  {
    backend: "gno-realm",
    chain_id: "gnoland-1",
    network_class: "mainnet",
    deployments: [{ kind: "gno-realm", realm_pkgpath: "gno.land/r/test/escrow/v1", realm_address: "g1realm", creator: "g1creator", package_digests: [sha256Hex("pkg")], private_realm_allowed: false }],
  },
  {
    backend: "gno-realm",
    chain_id: "gno-dev",
    network_class: "local",
    deployments: [{ kind: "gno-realm", realm_pkgpath: "gno.land/r/test/escrow/v1", realm_address: "g1realm", creator: "g1creator", package_digests: [sha256Hex("pkg")], private_realm_allowed: true }],
  },
];

function bindingOf(d: Loose, seats: number): EscrowBindingV2 {
  return validateEscrowBindingV2({
    binding_schema: 2,
    backend: "juno-cosmwasm",
    codec: "18JUNO/v1",
    network: { chain_id: d.chain_id, network_class: d.chain_id === "juno-1" ? "mainnet" : "testnet" },
    deployment: {
      kind: "juno-cosmwasm",
      contract_address: d.contract_addr,
      code_id: "4242",
      code_checksum: TEST_WASM,
      contract_name: "eighteen-cosmos-escrow",
      contract_version: "1.0.0",
      admin: null,
    },
    chain_game_id: String(d.chain_game_id),
    custody: { kind: "contract-ledger" },
    asset: { denom: "ujuno", exponent: 6, symbol: "JUNO" },
    terms: { ante_gross: String(d.ante_gross), ante_net: String(b(d.ante_gross) - b(1)), max_players: seats, mode: d.mode as 0 | 1 },
    commitments: { rules_engine_version: d.rules_engine_version, variants_digest: d.variants_digest },
    bound_at: 0,
  }, TEST_POLICY);
}

describe("ESCROW-2 vectors (independent Python) → JUNO_CODEC_V1: byte-identical", () => {
  it.each<[string, Loose]>(rust.roster_vectors.map((r: Loose): [string, Loose] => [r.name, r]))("ROSTER %s", (_name, r: Loose) => {
    const roster = JUNO_CODEC_V1.rosterHash(r.wallets);
    expect(roster).toEqual({ codec: "18JUNO/v1", purpose: "roster", hex: r.roster_hash });
    expect(roster.hex).toBe(rosterHashV1(r.wallets));
  });

  it.each<[string, Loose]>(rust.domain_vectors.map((d: Loose): [string, Loose] => [d.name, d]))("DOMAIN %s (raw inputs, and EscrowBinding v2 → inputs)", (_name, d: Loose) => {
    const bound = JUNO_CODEC_V1.bindDomain(rustDomainInputs(d));
    expect(bound.domain).toEqual({ codec: "18JUNO/v1", purpose: "domain", hex: d.domain });
    expect(bound.roster_hash).toBe(d.roster_hash);
    expect(bound.rules_engine_version).toBe(d.rules_engine_version);
    const binding = bindingOf(d, rosterByName(d.roster).length);
    expect(JUNO_CODEC_V1.bindDomain(junoDomainInputsOf(binding, d.roster_hash)).domain.hex).toBe(d.domain);
  });

  it.each<[string, Loose]>(rust.payload_vectors.map((v: Loose): [string, Loose] => [v.name, v]))("PAYLOAD %s: bytes, SETTLE, CONSENT (every seat), wire, signatures", async (_name, v: Loose) => {
    const payload = settlementPayloadFromWire(v.payload);
    const encoded = encodeSettlementPayloadV1Hex(payload);
    expect(encoded).toBe(v.encoded);
    expect(encoded.length / 2).toBe(v.encoded_len);
    expect(settlementPayloadToWire(payload)).toStrictEqual(v.payload);
    const settle = JUNO_CODEC_V1.settleDigest(encoded);
    expect(settle).toEqual({ codec: "18JUNO/v1", purpose: "settle", hex: v.settle_digest });
    for (let seat = 0; seat < payload.seat_count; seat += 1) {
      const consent = JUNO_CODEC_V1.consentDigest({ domain: payload.domain, seq: payload.seq, settle, seat_index: seat, seat_count: payload.seat_count });
      expect(consent.hex).toBe(v.consent_digest); // Juno v1: the seat is bound by its key, not hashed
    }
    expect(await junoVerify(rust.keys.signer.pubkey, settle.hex, v.signer_signature)).toBe(true);
    expect(await junoVerify(rust.keys.signer.pubkey, v.consent_digest, v.signer_signature)).toBe(false);
    for (let seat = 0; seat < v.consent_signatures.length; seat += 1) {
      expect(await junoVerify(rust.keys.seats[seat].pubkey, v.consent_digest, v.consent_signatures[seat])).toBe(true);
    }
  });

  it.each<[string, Loose]>(rust.annul_vectors.map((v: Loose, i: number): [string, Loose] => [`${v.domain_vector}@${v.last_seq}#${i}`, v]))("ANNUL %s: digest for every seat, and each seat's signature", async (_name, v: Loose) => {
    const d = rust.domain_vectors.find((entry: Loose) => entry.name === v.domain_vector);
    const n = rosterByName(d.roster).length;
    for (let seat = 0; seat < n; seat += 1) {
      const annul = JUNO_CODEC_V1.annulDigest({ domain: d.domain, trusted_seq: b(v.last_seq), seat_index: seat, seat_count: n });
      expect(annul).toEqual({ codec: "18JUNO/v1", purpose: "annul", hex: v.annul_digest });
      expect(await junoVerify(rust.keys.seats[seat].pubkey, annul.hex, v.seat_signatures[seat])).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. SET-0C's vector file through the interface                        */
/* ------------------------------------------------------------------ */

const set0cDomain = (name: string): Loose => set0c.domains.find((d: Loose) => d.name === name);
const set0cInputs = (d: Loose): SettlementDomainInputs => ({ ...rustDomainInputs({ ...d, roster_hash: d.roster_hash }) });

describe("SET-0C vector file → the interface: byte-identical", () => {
  it.each<[string, Loose]>(set0c.domains.map((d: Loose): [string, Loose] => [d.name, d]))("DOMAIN + ROSTER %s", (_name, d: Loose) => {
    expect(JUNO_CODEC_V1.rosterHash(d.roster_wallets).hex).toBe(d.roster_hash);
    expect(JUNO_CODEC_V1.bindDomain(set0cInputs(d)).domain.hex).toBe(d.domain);
    expect(JUNO_CODEC_V1.bindDomain(junoDomainInputsOf(bindingOf(d, d.roster_wallets.length), d.roster_hash)).domain.hex).toBe(d.domain);
  });

  it.each<[string, Loose]>(set0c.payload_vectors.map((v: Loose): [string, Loose] => [v.name, v]))("PAYLOAD %s: bytes, SETTLE, CONSENT, wire, payouts, dust", (_name, v: Loose) => {
    const payload = settlementPayloadFromWire(v.payload);
    const encoded = encodeSettlementPayloadV1Hex(payload);
    expect(encoded).toBe(v.encoded);
    expect(encoded.length / 2).toBe(v.encoded_len);
    expect(settlementPayloadToWire(payload)).toStrictEqual(v.payload);
    const settle = JUNO_CODEC_V1.settleDigest(encoded);
    expect(settle.hex).toBe(v.settle_digest);
    expect(JUNO_CODEC_V1.consentDigest({ domain: payload.domain, seq: payload.seq, settle, seat_index: 0, seat_count: payload.seat_count }).hex).toBe(v.consent_digest);
    const payouts = settlementPayouts(b(v.pool_ujuno), payload.settlement_weights);
    expect(payouts.payouts.map(String)).toEqual(v.payouts_ujuno);
    expect(payouts.dust.toString()).toBe(v.dust_ujuno);
    expect(payload.domain).toBe(set0cDomain(v.domain_name).domain);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Every SET-0C golden board: certified builder vs interface builder */
/* ------------------------------------------------------------------ */

const { boards } = goldenBoards();
const ANTE_NET = b(derived.ante.ante_net_ujuno);
const REASON_NAME: Record<number, "BankBroken" | "Bankruptcy" | "ResolverCorrection"> = { 1: "BankBroken", 2: "Bankruptcy", 5: "ResolverCorrection" };

function boardOf(v: Loose): GameStateResponse {
  return String(v.source_case).startsWith("GR-4") ? GR.certificationStart() : boards[v.source_case];
}

/** The certified builder's arguments for a vector, and the interface builder's equivalent (payout_address for
 *  wallet, neutral terms for the ujuno-named ones). */
function argsPair(v: Loose): { frozen: BuildSettlementPayloadArgs; neutral: BuildSettlementCoreArgs } {
  const d = set0cDomain(v.domain_name);
  const p = v.payload;
  const frozenIntent: SettlementPayloadIntent =
    p.kind === 0
      ? { kind: "Checkpoint" }
      : { kind: "Terminal", outcome: { reason: REASON_NAME[p.reason] }, terms: { pool_net_ujuno: b(0), ante_net_ujuno: ANTE_NET } };
  const neutralIntent: SettlementCoreIntent =
    p.kind === 0 ? { kind: "Checkpoint" } : { kind: "Terminal", outcome: { reason: REASON_NAME[p.reason] }, terms: { pool_net: b(0), ante_net: ANTE_NET } };
  const common = {
    board: { state: boardOf(v) },
    domain: d.domain,
    log_len: b(p.log_len),
    log_hash: p.log_hash,
    appraisal_log_len: b(p.appraisal_log_len),
    state_schema_version: p.state_schema_version,
    signer_key_id: p.signer_key_id,
    issued_at: b(p.issued_at),
  };
  const mapping = v.seat_mapping as { chain_seat_index: number; player_id: string }[];
  return {
    frozen: {
      ...common,
      bindings: mapping.map((s) => ({ chain_seat_index: s.chain_seat_index, player_id: s.player_id, wallet: d.roster_wallets[s.chain_seat_index] })),
      domain_inputs: set0cInputs(d),
      intent: frozenIntent,
    },
    neutral: {
      ...common,
      bindings: mapping.map((s) => ({ chain_seat_index: s.chain_seat_index, player_id: s.player_id, payout_address: d.roster_wallets[s.chain_seat_index] })),
      domain_inputs: set0cInputs(d),
      intent: neutralIntent,
    },
  };
}

describe("golden boards → certified buildSettlementPayloadV1 AND buildSettlementCoreV1(JUNO_CODEC_V1): identical, and = the vector file", () => {
  it.each<[string, Loose]>(set0c.payload_vectors.map((v: Loose): [string, Loose] => [v.name, v]))("%s", (_name, v: Loose) => {
    const { frozen, neutral } = argsPair(v);
    const certified = buildSettlementPayloadV1(frozen);
    const core = buildSettlementCoreV1(JUNO_CODEC_V1, neutral);
    // the vector file
    expect(core.encoded_hex).toBe(v.encoded);
    expect(core.settle).toEqual({ codec: "18JUNO/v1", purpose: "settle", hex: v.settle_digest });
    expect(core.wire).toStrictEqual(v.payload);
    expect(core.usage).toBe(v.usage);
    // the certified builder, output for output
    expect(core.encoded_hex).toBe(certified.encoded_hex);
    expect(core.settle.hex).toBe(certified.settle_digest);
    expect(core.payload).toStrictEqual(certified.payload);
    expect(core.wire).toStrictEqual(certified.wire);
    expect(core.usage).toBe(certified.usage);
    expect(core.canonical_text).toBe(certified.canonical_text);
    expect(core.seats).toStrictEqual(certified.seats);
    expect(core.roster.hex).toBe(certified.roster_hash);
    expect(core.domain.hex).toBe(v.payload.domain);
    expect(core.base_vector).toStrictEqual(certified.base_vector);
    expect(core.appraisals).toStrictEqual(certified.appraisals);
    // CONSENT from the built SETTLE digest
    expect(JUNO_CODEC_V1.consentDigest({ domain: core.payload.domain, seq: core.payload.seq, settle: core.settle, seat_index: 0, seat_count: core.payload.seat_count }).hex).toBe(v.consent_digest);
    // the verifier path: same usage, weights and SETTLE digest as the certified verifier
    const seats: SettlementSeat[] = core.seats.slice();
    const certifiedVerified = verifySettlementPayloadV1(core.payload, core.canonical_text, seats);
    const coreVerified = verifySettlementCoreV1(JUNO_CODEC_V1, core.payload, core.canonical_text, seats);
    expect(coreVerified.settle.hex).toBe(certifiedVerified.settle_digest);
    expect(coreVerified.settlement_weights).toStrictEqual(certifiedVerified.settlement_weights);
    expect(coreVerified.usage).toBe(certifiedVerified.usage);
  });
});

describe("refusal parity: the interface builder refuses exactly what the certified builder refuses, with the same code", () => {
  const base = set0c.payload_vectors[0] as Loose; // SYN-01 terminal BankBroken, 3 seats
  const checkpoint = set0c.payload_vectors.find((v: Loose) => v.usage === "Checkpoint") as Loose;
  const other = set0cDomain("set0c-juno-1-4-seat-live-game-4");
  type Mutation = (a: Loose) => void;
  const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  const swapWallets = (a: Loose) => {
    const key = "wallet" in a.bindings[0] ? "wallet" : "payout_address";
    const first = a.bindings[0][key];
    a.bindings[0] = { ...a.bindings[0], [key]: a.bindings[1][key] };
    a.bindings[1] = { ...a.bindings[1], [key]: first };
  };
  const addressKey = (a: Loose) => ("wallet" in a.bindings[0] ? "wallet" : "payout_address");
  const cases: Array<[string, Loose, Mutation, string]> = [
    ["domain is not the inputs' hash", base, (a) => { a.domain = flip(a.domain); }, "DOMAIN_MISMATCH"],
    ["domain inputs carry an unknown field", base, (a) => { a.domain_inputs = { ...a.domain_inputs, extra: 1 }; }, "MALFORMED_INPUT"],
    ["domain inputs carry a stale SET-0A name", base, (a) => { a.domain_inputs = { ...a.domain_inputs, net_worth: 1 }; }, "MALFORMED_INPUT"],
    ["domain inputs are not a plain object", base, (a) => { a.domain_inputs = Object.assign(Object.create({ inherited: 1 }), a.domain_inputs); }, "MALFORMED_INPUT"],
    ["another game's roster and domain", base, (a) => { a.domain_inputs = set0cInputs(other); a.domain = other.domain; }, "ROSTER_MISMATCH"],
    ["roster permuted (two wallets swapped)", base, swapWallets, "ROSTER_MISMATCH"],
    ["an upper-case wallet", base, (a) => { const k = addressKey(a); a.bindings[1] = { ...a.bindings[1], [k]: a.bindings[1][k].toUpperCase() }; }, "MALFORMED_STRING"],
    ["one player in two seats", base, (a) => { a.bindings[1] = { ...a.bindings[1], player_id: a.bindings[0].player_id }; }, "MALFORMED_INPUT"],
    ["one wallet in two seats", base, (a) => { const k = addressKey(a); a.bindings[1] = { ...a.bindings[1], [k]: a.bindings[0][k] }; }, "MALFORMED_INPUT"],
    ["chain_seat_index out of position", base, (a) => { a.bindings[1] = { ...a.bindings[1], chain_seat_index: 2 }; }, "MALFORMED_INPUT"],
    ["one seat", base, (a) => { a.bindings = a.bindings.slice(0, 1); }, "BAD_SEAT_COUNT"],
    ["domain declares rules engine 11", base, (a) => { a.domain_inputs = { ...a.domain_inputs, rules_engine_version: 11 }; a.domain = settlementDomainV1(a.domain_inputs); }, "RULES_ENGINE_VERSION_MISMATCH"],
    ["Forfeit (not certified yet)", base, (a) => { a.intent = { ...a.intent, outcome: { reason: "Forfeit", offender_seat: 0 } }; }, "REASON_NOT_SUPPORTED"],
    ["unknown terminal reason", base, (a) => { a.intent = { ...a.intent, outcome: { reason: "Timeout" } }; }, "MALFORMED_INPUT"],
    ["unknown intent kind", base, (a) => { a.intent = { kind: "Bogus" }; }, "MALFORMED_INPUT"],
    ["log_len as a number", base, (a) => { a.log_len = 1000; }, "MALFORMED_INTEGER"],
    ["seq overflows u64", base, (a) => { a.log_len = (BigInt(1) << BigInt(64)) - BigInt(1); a.appraisal_log_len = a.log_len; }, "BAD_SEQ"],
    ["A1: checkpoint appraised earlier than log_len", checkpoint, (a) => { a.appraisal_log_len = a.log_len - BigInt(1); }, "BAD_APPRAISAL_LOG_LEN"],
    ["signer_key_id beyond u16", base, (a) => { a.signer_key_id = 70000; }, "INTEGER_OUT_OF_RANGE"],
    ["log_hash upper case", base, (a) => { a.log_hash = a.log_hash.toUpperCase(); }, "MALFORMED_HEX"],
    ["board carries both sources", base, (a) => { a.board = { state: a.board.state, canonical_text: "{}" }; }, "MALFORMED_INPUT"],
  ];
  it.each(cases)("%s", (_label, vector, mutate, expected) => {
    const { frozen, neutral } = argsPair(vector);
    const f = { ...frozen, bindings: frozen.bindings.slice() } as Loose;
    const n = { ...neutral, bindings: neutral.bindings.slice() } as Loose;
    mutate(f);
    mutate(n);
    const frozenCode = code(() => buildSettlementPayloadV1(f as BuildSettlementPayloadArgs));
    expect(frozenCode).toBe(expected);
    expect(code(() => buildSettlementCoreV1(JUNO_CODEC_V1, n as BuildSettlementCoreArgs))).toBe(frozenCode);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The seams hold: no hidden Juno in the core, no replay across codecs */
/* ------------------------------------------------------------------ */

describe("codec guards and the core's neutrality", () => {
  const v = set0c.payload_vectors[0] as Loose;

  it("the Juno address rule is SET-0C's (same accept/refuse set as rosterHashV1)", () => {
    const other = "juno1h34lmpywh4upnjdg90cjf4j70aee6z8qqfspugamjp42e4q28kqsksmtyp";
    const probes = ["juno1abc", "g1abcdef", "JUNO1abc", "juno1 abc", "", "juno1ábc", "juno1\u007f", "a", "~!@#$%^&*()", "juno1abc\n"];
    for (const probe of probes) {
      expect([probe, code(() => JUNO_CODEC_V1.canonicalAddress(probe, "probe"))]).toEqual([probe, code(() => rosterHashV1([probe, other]))]);
    }
  });

  it("a digest from another codec, or of another purpose, is refused before any hashing", () => {
    const encoded = v.encoded as string;
    const settle = JUNO_CODEC_V1.settleDigest(encoded);
    const args = { domain: v.payload.domain, seq: b(v.payload.seq), seat_index: 0, seat_count: 3 };
    expect(code(() => JUNO_CODEC_V1.consentDigest({ ...args, settle: codecDigest("18GNO/v1", "settle", settle.hex) }))).toBe("CODEC_MISMATCH");
    expect(code(() => JUNO_CODEC_V1.consentDigest({ ...args, settle: { hex: settle.hex } as never }))).toBe("CODEC_MISMATCH");
    expect(code(() => JUNO_CODEC_V1.consentDigest({ ...args, settle: codecDigest("18JUNO/v1", "annul", settle.hex) as never }))).toBe("PURPOSE_MISMATCH");
    expect(code(() => JUNO_CODEC_V1.consentDigest({ ...args, settle, seat_index: 3 }))).toBe("SEAT_INDEX_OUT_OF_RANGE");
    expect(code(() => JUNO_CODEC_V1.annulDigest({ domain: args.domain, trusted_seq: b(0), seat_index: -0, seat_count: 3 }))).toBe("SEAT_INDEX_OUT_OF_RANGE");
  });

  it("the core carries no tag: a different codec gets the same payload bytes for the same domain, and its own SETTLE digest", () => {
    const juno = JUNO_CODEC_V1;
    const tag = "18TEST/SETTLE/v1";
    const testCodec: EscrowCodec<SettlementDomainInputs> = {
      ...juno,
      id: "18GNO/v1", // any other id: the point is only that it is not Juno's
      bindDomain: (raw) => {
        const bound = juno.bindDomain(raw);
        return { ...bound, domain: codecCommitment("18GNO/v1", "domain", bound.domain.hex) };
      },
      rosterHash: (addresses) => codecCommitment("18GNO/v1", "roster", juno.rosterHash(addresses).hex),
      settleDigest: (hex) => codecDigest("18GNO/v1", "settle", createHash("sha256").update(Buffer.concat([Buffer.from(tag), Buffer.from(hex, "hex")])).digest("hex")),
    };
    const { neutral } = argsPair(v);
    const viaTest = buildSettlementCoreV1(testCodec, neutral);
    const viaJuno = buildSettlementCoreV1(juno, neutral);
    expect(viaTest.encoded_hex).toBe(viaJuno.encoded_hex);
    expect(viaTest.settle.codec).toBe("18GNO/v1");
    expect(viaTest.settle.hex).not.toBe(viaJuno.settle.hex);
    expect(() => juno.consentDigest({ domain: v.payload.domain, seq: b(v.payload.seq), settle: viaTest.settle, seat_index: 0, seat_count: 3 })).toThrow(EscrowInterfaceError);
  });

  it("the Gno codec is declared but produces no bytes until GNOLAND-2 (every byte method refuses)", () => {
    const gno = GNO_CODEC_V1_DRAFT;
    expect(gno.maturity).toBe("draft");
    const settle = codecDigest("18GNO/v1", "settle", "00".repeat(32));
    for (const run of [
      () => gno.canonicalAddress("g1abc", "x"),
      () => gno.rosterHash(["g1a", "g1b"]),
      () => gno.bindDomain({}),
      () => gno.settleDigest("00"),
      () => gno.consentDigest({ domain: "00".repeat(32), seq: b(1), settle, seat_index: 0, seat_count: 2 }),
      () => gno.annulDigest({ domain: "00".repeat(32), trusted_seq: b(1), seat_index: 0, seat_count: 2 }),
      () => gno.extensions.keyPossession!({ deployment: "gno.land/r/x", chain_game_id: b(1), wallet: "g1a", public_key_hex: "00" }),
    ]) {
      expect(code(run)).toBe("NOT_IMPLEMENTED");
    }
    const junoTags = ["18JUNO/SETTLE/v1", "18JUNO/DOMAIN/v1", "18JUNO/ROSTER/v1", "18JUNO/CONSENT/v1", "18JUNO/ANNUL/v1", "18JUNO/STATE/v1\n"];
    for (const tag of Object.values(GNO_TAGS_V1_DRAFT)) expect(junoTags).not.toContain(tag);
    // A building attempt through the draft codec fails at the domain, before any appraisal or byte is produced.
    expect(code(() => buildSettlementCoreV1(gno, argsPair(v).neutral))).toBe("NOT_IMPLEMENTED");
  });

  it("capabilities state the GNOLAND-0 differences explicitly", () => {
    expect(JUNO_CAPABILITIES_V1.settlementScheme).not.toBe(GNO_CAPABILITIES_DRAFT.settlementScheme);
    expect([JUNO_CAPABILITIES_V1.feeGrant, GNO_CAPABILITIES_DRAFT.feeGrant]).toEqual([true, false]);
    expect([JUNO_CAPABILITIES_V1.txExpiry, GNO_CAPABILITIES_DRAFT.txExpiry]).toEqual(["timeout-height", "none"]);
    expect([JUNO_CAPABILITIES_V1.payableCalls, GNO_CAPABILITIES_DRAFT.payableCalls]).toEqual(["any-sender", "eoa-direct-only"]);
    expect([JUNO_CAPABILITIES_V1.consentBindsSeat, GNO_CAPABILITIES_DRAFT.consentBindsSeat]).toEqual([false, true]);
    expect([JUNO_CODEC_V1.consentBindsSeat, GNO_CODEC_V1_DRAFT.consentBindsSeat]).toEqual([false, true]);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Neutral errors: every Juno ContractError maps                     */
/* ------------------------------------------------------------------ */

describe("the Juno ContractError map is complete and stable", () => {
  const source = readFileSync(ERROR_RS, "utf8");
  const body = source.slice(source.indexOf("pub enum ContractError"));
  const variants = Array.from(body.slice(0, body.indexOf("\n}\n")).matchAll(/^ {4}([A-Z][A-Za-z0-9]*)\s*(?:\{|\(|,)/gm)).map((m) => m[1]);

  it("every variant of error.rs is mapped, and nothing else", () => {
    expect(variants.length).toBe(54);
    expect(Object.keys(JUNO_CONTRACT_ERROR_MAP).sort()).toEqual(variants.slice().sort());
  });
  it("classification carries the neutral code, its retry class, and the native detail", () => {
    const stale = junoContractError("StaleSeq", "seq 10 does not exceed the trusted sequence 12");
    expect(stale).toEqual({ code: "STALE_SEQUENCE", retry: "reconcile-first", native: { backend: "juno-cosmwasm", name: "StaleSeq", message: "seq 10 does not exceed the trusted sequence 12" } });
    expect(junoContractError("CompromisedSettlement", "").code).toBe("SIGNER_COMPROMISED");
    // A seat's consent that no longer verifies is superseded (re-collect), never a hold a player could cause at will.
    expect(junoContractError("InvalidConsent", "").retry).toBe("after-refresh");
    expect(junoContractError("DuplicateConsent", "").code).toBe("CONSENT_REJECTED");
    expect(junoContractError("NoSuchVariant", "").code).toBe("BACKEND_INVARIANT");
    for (const variant of variants) expect(junoContractError(variant, "").retry).toBe(ESCROW_ERROR_RETRY[JUNO_CONTRACT_ERROR_MAP[variant]]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Binding, instance key, intents, key selection, roster freeze       */
/* ------------------------------------------------------------------ */

describe("binding v2, instance keys, intents and settlement-key selection", () => {
  const d2 = rust.domain_vectors[0] as Loose; // juno-1, two seats, game 1
  const binding = bindingOf(d2, 2);
  const valid = (b: EscrowBindingV2) => code(() => validateEscrowBindingV2(b, TEST_POLICY));

  it("binding validation is pinned to the deployment policy (network class, wasm checksum, admin, realm facts, maturity)", () => {
    expect(valid({ ...binding, codec: "18GNO/v1" })).toBe("BINDING_INVALID");
    expect(valid({ ...binding, terms: { ...binding.terms, ante_net: "3000000" } })).toBe("BINDING_INVALID");
    expect(valid({ ...binding, chain_game_id: "007" })).toBe("BINDING_INVALID");
    expect(valid({ ...binding, network: { chain_id: "juno-1", network_class: "testnet" } })).toBe("BINDING_INVALID"); // declared class is not the policy's
    expect(valid({ ...binding, network: { chain_id: "juno-2", network_class: "mainnet" } })).toBe("BINDING_INVALID"); // unknown chain
    expect(valid({ ...binding, deployment: { ...binding.deployment, admin: "juno1attacker" } as never })).toBe("BINDING_INVALID"); // migrate authority
    expect(valid({ ...binding, deployment: { ...binding.deployment, code_checksum: sha256Hex("other wasm") } as never })).toBe("BINDING_INVALID");
    const gno = {
      ...binding,
      backend: "gno-realm" as const,
      codec: "18GNO/v1" as const,
      network: { chain_id: "gno-dev", network_class: "local" as const },
      deployment: { kind: "gno-realm" as const, realm_pkgpath: "gno.land/r/test/escrow/v1", realm_address: "g1realm", private_realm: true, creator: "g1creator", package_digest: sha256Hex("pkg") },
      custody: { kind: "per-game-sub-address" as const, address: "g1sub" },
      asset: { denom: "ugnot", exponent: 6, symbol: "GNOT" },
    };
    expect(valid(gno)).toBe("OK"); // a private realm, a draft codec: only on a local network the policy allows
    expect(valid({ ...gno, network: { chain_id: "gnoland-1", network_class: "mainnet" }, deployment: { ...gno.deployment, private_realm: false } })).toBe("BINDING_INVALID"); // draft codec on mainnet
    expect(valid({ ...gno, deployment: { ...gno.deployment, creator: "g1someoneelse" } })).toBe("BINDING_INVALID");
    expect(valid({ ...gno, terms: { ...gno.terms, ante_gross: "9223372036854775807", ante_net: "1" } })).toBe("BINDING_INVALID"); // pool > int64
  });

  it("the instance key separates deployments and chains that share a chain_game_id, and is injective", () => {
    const testnet = bindingOf(rust.domain_vectors[1], 2); // uni-7, same contract address and game id
    expect(escrowInstanceKey(binding)).not.toBe(escrowInstanceKey(testnet));
    const withChain = (chain_id: string, contract_address: string) =>
      ({ ...binding, network: { ...binding.network, chain_id }, deployment: { ...binding.deployment, contract_address } }) as EscrowBindingV2;
    expect(escrowInstanceKey(withChain("juno-1|juno1c", "x"))).not.toBe(escrowInstanceKey(withChain("juno-1", "juno1c|x")));
  });

  it("intents: one id per slot (never per payload); a different subject at a slot is detectable; seqs are canonical", () => {
    const instance = escrowInstanceKey(binding);
    const settle = codecDigest("18JUNO/v1", "settle", set0c.payload_vectors[0].settle_digest);
    const other = codecDigest("18JUNO/v1", "settle", set0c.payload_vectors[1].settle_digest);
    const a = intentIdOf(instance, { op: "settle", seq: "2001" });
    expect(intentIdOf(instance, { op: "settle", seq: "2001" })).toBe(a);
    expect(intentIdOf(instance, { op: "checkpoint", seq: "2001" })).not.toBe(a);
    expect(intentIdOf(instance, { op: "settle", seq: "2003" })).not.toBe(a);
    expect(intentIdOf(instance, { op: "relay-consent", seq: "2001", seat_index: 0 })).not.toBe(intentIdOf(instance, { op: "relay-consent", seq: "2001", seat_index: 1 }));
    expect(intentIdOf(instance, { op: "start" })).toBe(intentIdOf(instance, { op: "start" }));
    expect(intentIdOf(escrowInstanceKey(bindingOf(rust.domain_vectors[1], 2)), { op: "settle", seq: "2001" })).not.toBe(a);
    expect(code(() => intentIdOf(instance, { op: "settle", seq: "02001" }))).toBe("BINDING_INVALID");
    expect(sameIntentSubject({ kind: "digest", digests: [settle] }, { kind: "digest", digests: [settle] })).toBe(true);
    expect(sameIntentSubject({ kind: "digest", digests: [settle] }, { kind: "digest", digests: [other] })).toBe(false);
    expect(sameIntentSubject({ kind: "digest", digests: [settle] }, { kind: "digest", digests: [codecDigest("18GNO/v1", "settle", settle.hex)] })).toBe(false);
  });

  const junoKey: SettlementKeyConfig = {
    backend: "juno-cosmwasm",
    chain_id: "juno-1",
    deployment_id: d2.contract_addr,
    signer_key_id: 1,
    scheme: "secp256k1-ecdsa-prehashed/rs64-low-s",
    kms_key_ref: "arn:aws:kms:test:key/juno-settlement",
    public_key_hex: rust.keys.signer.pubkey,
    role: "active",
  };
  const registry: SignerKeyStatus[] = [
    { signer_key_id: 1, scheme: "secp256k1-ecdsa-prehashed/rs64-low-s", public_key_hex: rust.keys.signer.pubkey, status: "active", retired_at: null },
  ];

  it("selects the one active key for the binding's backend, chain and deployment, confirmed by the complete chain registry", () => {
    expect(selectSettlementKey(binding, JUNO_CAPABILITIES_V1, registry, [junoKey])).toBe(junoKey);
    const testnet = bindingOf(rust.domain_vectors[1], 2);
    expect(code(() => selectSettlementKey(testnet, JUNO_CAPABILITIES_V1, registry, [junoKey]))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => selectSettlementKey(binding, GNO_CAPABILITIES_DRAFT, registry, [junoKey]))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => selectSettlementKey(binding, JUNO_CAPABILITIES_V1, [{ ...registry[0], status: "compromised" }], [junoKey]))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => selectSettlementKey(binding, JUNO_CAPABILITIES_V1, [{ ...registry[0], public_key_hex: rust.keys.seats[0].pubkey }], [junoKey]))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => selectSettlementKey(binding, JUNO_CAPABILITIES_V1, registry, [junoKey, { ...junoKey, kms_key_ref: "arn:other" }]))).toBe("SIGNER_SELECTION_REFUSED");
    // an active key on chain that this server does not hold is an unmonitored signer: refuse (hold + alert)
    const rogue = { signer_key_id: 2, scheme: "secp256k1-ecdsa-prehashed/rs64-low-s" as const, public_key_hex: rust.keys.seats[1].pubkey, status: "active" as const, retired_at: null };
    expect(code(() => selectSettlementKey(binding, JUNO_CAPABILITIES_V1, [...registry, rogue], [junoKey]))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => selectSettlementKey(binding, JUNO_CAPABILITIES_V1, [...registry, { ...rogue, status: "retired" as never }], [junoKey]))).toBe("OK");
  });

  it("configuration: one KMS key and one public key serve exactly one (backend, chain, deployment, registry id)", () => {
    const gnoKey: SettlementKeyConfig = { ...junoKey, backend: "gno-realm", chain_id: "gnoland-1", deployment_id: "gno.land/r/x/escrow/v1", scheme: "ed25519-pure/sig64", public_key_hex: "11".repeat(32), kms_key_ref: "arn:aws:kms:test:key/gno-settlement" };
    const caps = [JUNO_CAPABILITIES_V1, GNO_CAPABILITIES_DRAFT];
    expect(code(() => checkSettlementKeyConfig([junoKey, gnoKey], caps))).toBe("OK");
    expect(code(() => checkSettlementKeyConfig([junoKey, { ...gnoKey, kms_key_ref: junoKey.kms_key_ref }], caps))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => checkSettlementKeyConfig([junoKey, { ...gnoKey, scheme: "secp256k1-ecdsa-prehashed/rs64-low-s" }], caps))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => checkSettlementKeyConfig([junoKey, { ...junoKey, chain_id: "uni-7" }], caps))).toBe("SIGNER_SELECTION_REFUSED"); // one KMS key for mainnet and testnet
    expect(code(() => checkSettlementKeyConfig([junoKey, { ...junoKey, kms_key_ref: "arn:second", public_key_hex: "02" + "22".repeat(32), role: "standby" }], caps))).toBe("SIGNER_SELECTION_REFUSED"); // registry id twice
    expect(code(() => checkSettlementKeyConfig([junoKey, { ...junoKey, kms_key_ref: "arn:second", public_key_hex: "02" + "22".repeat(32), signer_key_id: 2 }], caps))).toBe("SIGNER_SELECTION_REFUSED"); // two active
  });

  it("the signer signs only a payload it re-derives: its own key id, the frozen domain, its own codec", () => {
    const v = set0c.payload_vectors.find((entry: Loose) => entry.domain_name === "mainnet-two-seat-live") as Loose;
    const { neutral } = argsPair(v);
    const built = buildSettlementCoreV1(JUNO_CODEC_V1, neutral);
    const key = { ...junoKey, deployment_id: set0cDomain(v.domain_name).contract_addr };
    expect(settlementDigestToSign(key, JUNO_CODEC_V1 as EscrowCodec<unknown>, built, built.payload.domain)).toEqual(built.settle);
    expect(code(() => settlementDigestToSign({ ...key, signer_key_id: 2 }, JUNO_CODEC_V1 as EscrowCodec<unknown>, built, built.payload.domain))).toBe("SIGNER_SELECTION_REFUSED");
    expect(code(() => settlementDigestToSign(key, JUNO_CODEC_V1 as EscrowCodec<unknown>, built, "00".repeat(32)))).toBe("SIGNER_SELECTION_REFUSED");
    const gnoKey = { ...key, backend: "gno-realm" as const, scheme: "ed25519-pure/sig64" as const };
    expect(code(() => settlementDigestToSign(gnoKey, JUNO_CODEC_V1 as EscrowCodec<unknown>, built, built.payload.domain))).toBe("SIGNER_SELECTION_REFUSED");
  });
});

describe("the roster freeze maps chain seats onto LIVE player_ids deterministically, or refuses", () => {
  const d3 = set0cDomain("set0c-juno-1-3-seat-live-game-3");
  const binding = bindingOf(d3, 3);
  const wallets: string[] = d3.roster_wallets;
  const players = ["p-aaaaaaaaaaaaaaaa", "p-bbbbbbbbbbbbbbbb", "p-cccccccccccccccc"];
  const GAME = "g_test";
  const ticketOf = (player_id: string, wallet: string) =>
    joinTicketV1({ backend: binding.backend, chain_id: binding.network.chain_id, deployment_id: d3.contract_addr, game_id: GAME, player_id, wallet, secret_hex: "5e".repeat(32) });
  const claims: EscrowSeatClaim[] = [2, 0, 1].map((i) => ({ player_id: players[i], payout_address: wallets[i], evidence: { kind: "join-ticket" as const, ticket_hex: ticketOf(players[i], wallets[i]) }, claimed_at: 1 }));
  const TRUST: EscrowTrustPolicy = { operators: ["juno1operator"], resolvers: ["juno1resolver"], min_challenge_window_secs: BigInt(3600), min_liveness_window_secs: BigInt(86400), min_resolver_timeout_secs: BigInt(86400) };
  const view = (over: Partial<EscrowGameView> = {}, seatTickets: string[] = players.map((p, i) => ticketOf(p, wallets[i])), seatWallets: string[] = wallets): EscrowGameView => ({
    instance: escrowInstanceKey(binding),
    state: "FUNDED",
    paused: false,
    seats: seatWallets.map((w, i) => ({ chain_seat_index: i, payout_address: w, consent_public_key_hex: rust.keys.seats[i].pubkey, consent_scheme: "secp256k1-ecdsa-prehashed/rs64-low-s" as const, join_ticket_hex: seatTickets[i], deposit_gross: binding.terms.ante_gross, deposit_net: binding.terms.ante_net })),
    max_players: 3,
    mode: 0,
    rules_engine_version: 10,
    variants_digest: d3.variants_digest,
    ante_gross: binding.terms.ante_gross,
    ante_net: binding.terms.ante_net,
    pool: "0",
    roster_hash: null,
    domain: null,
    resolver: null,
    last_seq: "0",
    trusted_seq: "0",
    latest_checkpoint: null,
    settlement: null,
    dispute: null,
    deadlines: { funding_deadline: null, challenge_window_end: null, liveness_available_at: null, resolver_timeout_at: null },
    trust: { denom: "ujuno", operator: "juno1operator", resolver_config: "juno1resolver", resolver_game: null, bond: null, challenge_window_secs: "86400", liveness_window_secs: "604800", resolver_timeout_secs: "604800" },
    observed: { height: "1", block_time: "0" },
    native: null,
    ...over,
  });
  const live = players.map((player_id) => ({ player_id }));
  const freeze = (v: EscrowGameView = view(), claimList: EscrowSeatClaim[] = claims, liveSeats = live) =>
    freezeEscrowRoster({ binding, game_id: GAME, codec: JUNO_CODEC_V1, liveSeats, claims: claimList, view: v, ticketOf, trust: TRUST, domainInputs: (rh) => junoDomainInputsOf(binding, rh), now: 7 });
  const refusal = (result: ReturnType<typeof freeze>) => (result.ok ? "OK" : result.refusal.code);

  it("joins by payout address and wallet-bound ticket; roster order is chain order; hash and domain are the codec's (= the SET-0C domain)", () => {
    const result = freeze();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.freeze.roster.map((r) => r.player_id)).toEqual(players);
    expect(result.freeze.roster_hash).toBe(d3.roster_hash);
    expect(result.freeze.expected_domain).toBe(d3.domain);
    expect(result.freeze.roster.map((r) => r.join_ticket_hex)).toEqual(players.map((p, i) => ticketOf(p, wallets[i])));
  });

  it("a ticket copied from another player's pending Join binds nothing (the ticket commits to the wallet)", () => {
    const attacker = "juno1attackerwalletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const victimTicket = ticketOf(players[2], wallets[2]);
    const seatWallets = [wallets[0], wallets[1], attacker];
    const seatTickets = [ticketOf(players[0], wallets[0]), ticketOf(players[1], wallets[1]), victimTicket];
    // even a naive claim that followed the copied ticket to the attacker's wallet is refused at the freeze
    const naive = claims.map((c) => (c.player_id === players[2] ? { ...c, payout_address: attacker, evidence: { kind: "join-ticket" as const, ticket_hex: victimTicket } } : c));
    expect(refusal(freeze(view({}, seatTickets, seatWallets), naive))).toBe("unbound-seat");
  });

  it("refuses: another instance's view, swapped addresses, an unknown deposit, a missing player, drifted terms or trust, not FUNDED, paused, conflicting claims", () => {
    expect(refusal(freeze(view({ instance: "someone-else" })))).toBe("wrong-instance");
    const swapped = claims.map((c) => (c.player_id === players[0] ? { ...c, payout_address: wallets[1] } : c.player_id === players[1] ? { ...c, payout_address: wallets[0] } : c));
    expect(refusal(freeze(view(), swapped))).toBe("unbound-seat");
    expect(refusal(freeze(view(), claims.filter((c) => c.player_id !== players[1])))).toBe("unbound-seat");
    expect(refusal(freeze(view(), claims, [...live.slice(0, 2), { player_id: "p-dddddddddddddddd" }]))).toBe("unbound-seat");
    expect(refusal(freeze(view({ ante_net: "1" })))).toBe("terms-mismatch");
    expect(refusal(freeze(view({ trust: { ...view().trust, resolver_config: "juno1unknownresolver" } })))).toBe("trust-policy");
    expect(refusal(freeze(view({ trust: { ...view().trust, challenge_window_secs: "1" } })))).toBe("trust-policy");
    expect(refusal(freeze(view({ trust: { ...view().trust, denom: "uatom" } })))).toBe("trust-policy");
    expect(refusal(freeze(view({ state: "FUNDING" })))).toBe("not-funded");
    expect(refusal(freeze(view({ paused: true })))).toBe("paused");
    expect(refusal(freeze(view(), [...claims, { ...claims[0], payout_address: "juno1someoneelse" }]))).toBe("claim-conflict");
  });
});
