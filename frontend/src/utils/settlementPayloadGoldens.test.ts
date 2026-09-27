/** @jest-environment node */
// frontend/src/utils/settlementPayloadGoldens.test.ts
//
// ==================================================================
//  SET-0C: THE SET-0A GOLDEN BOARDS, THROUGH THE ONE BUILDER, AGAINST EVERY TRANSCRIPTION OF THE GOLDENS
// ==================================================================
//
// Three files transcribe SET-0A rev 2's expected values: the Rust crate's extract
// (`contracts/escrow/testdata/set0a_payout_vectors_rev2.json`), SET-0B's derived fixture and SET-0B's generated
// cross-language file. This suite requires them to agree field for field, then builds a real `SettlementPayloadV1`
// from each of the thirteen golden boards (rebuilt in-repo, pinned by `terminal_state_hash_v1`) through
// `buildSettlementPayloadV1`, and requires its `appraisal_state_hash`, `settlement_weights`, reason byte, seat order and
// previewed payouts to equal all three. The resulting payloads are pinned as SET-0C's own vector file, which the
// escrow crate (`contracts/escrow/tests/set0c_vectors.rs`) and the Python checker next to it both re-derive.
//
// It also pins the properties the builder exists for: one snapshot for hash and weights, chain seat order never turn
// order, no player or principal id in the bytes, and settlement certified for rules engine v10 only.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

import {
  SettlementPayloadError,
  buildSettlementPayloadV1,
  bytesToHex,
  consentDigestV1,
  decodeSettlementPayloadV1,
  encodeSettlementPayloadV1,
  hexToBytes,
  rosterHashV1,
  settleDigestV1,
  settlementDomainV1,
  settlementPayloadFromWire,
  settlementSeatMapping,
  type BuildSettlementPayloadArgs,
  type BuiltSettlementPayload,
  type SettlementDomainInputs,
  type SettlementPayloadIntent,
} from "../gameEngine/settlementPayload";
import { verifySettlementPayloadV1 } from "../gameEngine/settlementConformance";
import {
  SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS,
  SettlementAppraisalError,
  appraiseSeats,
  type SettlementSeat,
} from "../gameEngine/settlementAppraisal";
import { canonicalStateText, commitAndAppraise, terminalStateHashV1 } from "../gameEngine/settlementDigest";
import { payoutPreview, U128_MAX } from "../gameEngine/settlementPreview";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../gameEngine/rulesVersion";
import { sha256Hex } from "../gameEngine/sha256";
import type { GameStateResponse } from "../gameEngine/gameState";
import { atCertifiedSettlementPin, goldenBoards, SET0A_CERTIFIED_RULES_ENGINE_VERSION } from "./settlementGoldenBoards";
import * as GR from "./gentleRustCertificationGame";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/* ------------------------------------------------------------------ */
/* The three transcriptions                                           */
/* ------------------------------------------------------------------ */

const REPO = join(__dirname, "..", "..", "..");
const FIXTURES = join(__dirname, "__fixtures__", "settlement");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

interface PayoutVector {
  name: string;
  pool_ujuno: string;
  weights: string[];
  payouts_ujuno?: string[];
  dust_ujuno?: string;
  error?: string;
  policy?: unknown;
  requires_wide_intermediate?: boolean;
  u128_overflow?: string[];
}
const rust = readJson(join(REPO, "contracts", "escrow", "testdata", "set0a_payout_vectors_rev2.json")) as {
  payout_vectors: PayoutVector[];
  q16_reconstructed: PayoutVector;
  case_previews: Array<{ name: string; reason: string; vector: string[]; pool_ujuno: string; payouts_ujuno: string[]; dust_ujuno: string; ante_net_ujuno: string }>;
};
const derived = readJson(join(FIXTURES, "SET0A_golden_vectors_rev2.derived.json")) as {
  ante: { ante_net_ujuno: string };
  cases: Array<{ name: string; reason: "BankBroken" | "Bankruptcy"; terminal_state_hash_v1: string; turn_order: string[]; seat_mapping: string[]; vector: string[]; sum: string; pool_ujuno: string; payouts_ujuno: string[]; dust_ujuno: string }>;
  adversarial: Array<{ id: string; result: string }>;
  payout_vectors: PayoutVector[];
};
const crossLanguage = readJson(join(FIXTURES, "settlementCrossLanguageVectors.json")) as {
  cases: Array<{ name: string; reason: string; reason_code: number; appraisal_state_hash: string; seat_mapping: Array<{ seat_index: number; player_id: string }>; settlement_weights: string[]; pool_ujuno: string; payouts_ujuno: string[]; dust_ujuno: string }>;
  payout_vectors: PayoutVector[];
};
const payloadVectors = readJson(join(REPO, "contracts", "escrow", "testdata", "payload_vectors_v1.json")) as {
  roster_vectors: Array<{ name: string; wallets: string[]; roster_hash: string }>;
  domain_vectors: Array<{ name: string; chain_id: string; contract_addr: string; chain_game_id: number; roster: string; roster_hash: string; rules_engine_version: number; variants_digest: string; ante_gross: string; mode: number; domain: string }>;
};

const { boards } = goldenBoards();
const b = (value: string | number) => BigInt(value);
const strings = (values: readonly bigint[]) => values.map((value) => value.toString());
const seatsOf = (ids: readonly string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));
const ANTE_NET = b(derived.ante.ante_net_ujuno);
const TERMS = { pool_net_ujuno: b(0), ante_net_ujuno: ANTE_NET };

function code(run: () => unknown): string {
  try {
    run();
    return "OK";
  } catch (error) {
    if (error instanceof SettlementPayloadError || error instanceof SettlementAppraisalError) return error.code;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Domains for the golden payloads (test values, all recomputable)    */
/* ------------------------------------------------------------------ */

const rosterNamed = (name: string) => payloadVectors.roster_vectors.find((r) => r.name === name)!.wallets;
const rustDomain = (name: string) => payloadVectors.domain_vectors.find((d) => d.name === name)!;
const RUST_2 = rustDomain("mainnet-two-seat-live");
const RUST_7 = rustDomain("mainnet-seven-seat-live");
const SEVEN = rosterNamed("seven-seat");

interface NamedDomain {
  name: string;
  wallets: readonly string[];
  inputs: SettlementDomainInputs;
  domain: string;
  /** The Rust/Python domain vector this equals, when one is supplied. */
  supplied: string | null;
}

/** One domain per seat count, every one with a 2,000,000 ujuno gross ante (so pool = n × 1,950,000 net is the
 *  domain's own economics). n = 2 and n = 7 are EXACTLY the Rust vectors' domains; 3, 4 and 6 are new, recorded in
 *  full and recomputed by the Python checker. */
function domainFor(n: number): NamedDomain {
  const wallets = n === 2 ? rosterNamed("two-seat") : n === 3 ? rosterNamed("three-seat") : SEVEN.slice(0, n);
  const template = n === 7 ? RUST_7 : RUST_2;
  const inputs: SettlementDomainInputs = {
    chain_id: template.chain_id,
    contract_addr: template.contract_addr,
    chain_game_id: n === 2 ? b(RUST_2.chain_game_id) : n === 7 ? b(RUST_7.chain_game_id) : b(n),
    roster_hash: rosterHashV1(wallets),
    rules_engine_version: 10,
    variants_digest: template.variants_digest,
    ante_gross: b(2000000),
    mode: 0,
  };
  const supplied = n === 2 ? RUST_2.name : n === 7 ? RUST_7.name : null;
  return { name: supplied ?? `set0c-juno-1-${n}-seat-live-game-${n}`, wallets, inputs, domain: settlementDomainV1(inputs), supplied };
}

const LOG_HASH = sha256Hex("18JUNO/TEST/log"); // gen_payload_vectors.py's test log hash
const ISSUED_AT = b(1758844800);

/** The seat bindings of a chain-order seat list, on the domain's roster for that seat count. */
const bindingsFor = (seats: readonly SettlementSeat[], wallets: readonly string[] = domainFor(seats.length).wallets) =>
  seats.map((seat, i) => ({ chain_seat_index: i, player_id: seat.player_id, wallet: wallets[i] }));

function argsFor(
  board: GameStateResponse,
  seats: readonly SettlementSeat[],
  intent: SettlementPayloadIntent,
  logLen: number,
  over: Partial<BuildSettlementPayloadArgs> = {},
): BuildSettlementPayloadArgs {
  const domain = domainFor(seats.length);
  return {
    board: { state: board },
    bindings: bindingsFor(seats),
    domain: domain.domain,
    domain_inputs: domain.inputs,
    intent,
    log_len: b(logLen),
    log_hash: LOG_HASH,
    appraisal_log_len: b(logLen),
    state_schema_version: 1,
    signer_key_id: 1,
    issued_at: ISSUED_AT,
    ...over,
  };
}

const build = (board: GameStateResponse, seats: SettlementSeat[], intent: SettlementPayloadIntent, logLen: number): BuiltSettlementPayload =>
  buildSettlementPayloadV1(argsFor(board, seats, intent, logLen));

/* ------------------------------------------------------------------ */
/* 1. The three transcriptions agree                                  */
/* ------------------------------------------------------------------ */

describe("SET-0A rev 2 as transcribed three times (Rust extract, SET-0B derived fixture, SET-0B cross-language file)", () => {
  it("P1-P13: names, pools, weights, payouts, dust, the P5 refusal, policy context and overflow flags agree", () => {
    expect(rust.payout_vectors).toHaveLength(13);
    rust.payout_vectors.forEach((r, i) => {
      const d = derived.payout_vectors[i];
      const c = crossLanguage.payout_vectors[i];
      for (const other of [d, c]) {
        expect(other.name).toBe(r.name);
        expect(other.pool_ujuno).toBe(r.pool_ujuno);
        expect(other.weights).toEqual(r.weights);
        expect(other.payouts_ujuno).toEqual(r.payouts_ujuno);
        expect(other.dust_ujuno).toBe(r.dust_ujuno);
        expect(other.policy).toEqual(r.policy);
        expect(other.requires_wide_intermediate).toEqual(r.requires_wide_intermediate);
        expect(other.u128_overflow).toEqual(r.u128_overflow);
      }
      // P5: the same refusal, spelled by each layer (golden "ZERO_SUM: ...", SET-0B code, Rust ZeroSumWeights).
      if (r.error) {
        expect(r.error).toBe("ZERO_SUM: sum of weights is zero");
        expect(d.error).toBe(r.error);
        expect(c.error).toBe("SETTLEMENT_ZERO_SUM");
      }
    });
  });

  it("the thirteen cases: weights, pool, payouts and dust agree; the hash and seat mapping agree where both carry them", () => {
    expect(rust.case_previews.map((c) => c.name)).toEqual(derived.cases.map((c) => c.name));
    expect(crossLanguage.cases.map((c) => c.name)).toEqual(derived.cases.map((c) => c.name));
    derived.cases.forEach((d, i) => {
      const r = rust.case_previews[i];
      const c = crossLanguage.cases[i];
      expect(r.reason).toBe(d.reason);
      expect(c.reason).toBe(d.reason);
      expect(r.vector).toEqual(d.vector);
      expect(c.settlement_weights).toEqual(d.vector);
      expect([r.pool_ujuno, c.pool_ujuno]).toEqual([d.pool_ujuno, d.pool_ujuno]);
      expect(r.payouts_ujuno).toEqual(d.payouts_ujuno);
      expect(c.payouts_ujuno).toEqual(d.payouts_ujuno);
      expect([r.dust_ujuno, c.dust_ujuno]).toEqual([d.dust_ujuno, d.dust_ujuno]);
      expect(r.ante_net_ujuno).toBe(derived.ante.ante_net_ujuno);
      expect(c.appraisal_state_hash).toBe(d.terminal_state_hash_v1);
      expect(c.seat_mapping).toEqual(d.seat_mapping.map((player_id, seat_index) => ({ seat_index, player_id })));
    });
  });

  it("Q16 (the Rust extract's reconstruction) is what SET-0B's adversarial record says", () => {
    const q16 = derived.adversarial.find((a) => a.id === "Q16")!.result;
    expect(q16).toContain("payouts [999999999999999, 0] dust 1");
    const preview = payoutPreview(b(rust.q16_reconstructed.pool_ujuno), rust.q16_reconstructed.weights.map(b));
    expect(strings(preview.payouts)).toEqual(rust.q16_reconstructed.payouts_ujuno);
    expect(preview.dust.toString()).toBe(rust.q16_reconstructed.dust_ujuno);
  });
});

/* ------------------------------------------------------------------ */
/* 2. P1-P13 through the TypeScript preview, against the RUST values  */
/* ------------------------------------------------------------------ */

describe("P1-P13 re-run: TypeScript bigint (no intermediate cap) == the Rust crate's Uint256 goldens", () => {
  for (const r of rust.payout_vectors) {
    it(r.name, () => {
      if (r.error) {
        expect(code(() => payoutPreview(b(r.pool_ujuno), r.weights.map(b)))).toBe("SETTLEMENT_ZERO_SUM");
        return;
      }
      const preview = payoutPreview(b(r.pool_ujuno), r.weights.map(b));
      expect(strings(preview.payouts)).toEqual(r.payouts_ujuno);
      expect(preview.dust.toString()).toBe(r.dust_ujuno);
    });
  }
  it("P11-P13 exceed u128 in exactly the intermediates the goldens flag, and settle anyway", () => {
    const wide = rust.payout_vectors.filter((r) => r.requires_wide_intermediate);
    expect(wide.map((r) => r.name.split(" ")[0])).toEqual(["P11", "P12", "P13"]);
    for (const r of wide) {
      const pool = b(r.pool_ujuno);
      const weights = r.weights.map(b);
      const sum = weights.reduce((s, w) => s + w, b(0));
      const product = weights.reduce((max, w) => (pool * w > max ? pool * w : max), b(0));
      expect(sum > U128_MAX).toBe(r.u128_overflow!.includes("sum"));
      expect(product > U128_MAX).toBe(r.u128_overflow!.includes("product"));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. The golden boards through the builder                           */
/* ------------------------------------------------------------------ */

interface GoldenPayload {
  name: string;
  source_case: string;
  intent: SettlementPayloadIntent;
  board: GameStateResponse;
  seats: SettlementSeat[];
  log_len: number;
  expect: { hash: string; weights: string[]; pool: string; payouts: string[]; dust: string } | null;
}

const GOLDEN_PAYLOADS: GoldenPayload[] = [
  ...derived.cases.map((d, i) => ({
    name: `${d.name}/terminal-${d.reason}`,
    source_case: d.name,
    intent: { kind: "Terminal", outcome: { reason: d.reason }, terms: TERMS } as SettlementPayloadIntent,
    board: boards[d.name],
    seats: seatsOf(d.seat_mapping),
    log_len: 1000 + 10 * i,
    expect: { hash: d.terminal_state_hash_v1, weights: d.vector, pool: d.pool_ujuno, payouts: d.payouts_ujuno, dust: d.dust_ujuno },
  })),
  {
    name: "SYN-01-CLASSIC-BANKBREAK/terminal-ResolverCorrection",
    source_case: "SYN-01-CLASSIC-BANKBREAK",
    intent: { kind: "Terminal", outcome: { reason: "ResolverCorrection" }, terms: TERMS },
    board: boards["SYN-01-CLASSIC-BANKBREAK"],
    seats: seatsOf(derived.cases[0].seat_mapping),
    log_len: 1000,
    expect: {
      hash: derived.cases[0].terminal_state_hash_v1,
      weights: derived.cases[0].vector,
      pool: derived.cases[0].pool_ujuno,
      payouts: derived.cases[0].payouts_ujuno,
      dust: derived.cases[0].dust_ujuno,
    },
  },
  {
    name: "GR-4-START-OR-3.1/checkpoint",
    source_case: "GR-4 certificationStart (a mid-game v10 board: Operating Round 3.1, phase 3)",
    intent: { kind: "Checkpoint" },
    // DA-8: the GR-4 start is dealt at the current engine; this vector was certified on it at the v10 pin.
    board: atCertifiedSettlementPin(GR.certificationStart()),
    seats: seatsOf(GR.certificationStart().player_addresses),
    log_len: 500,
    expect: null, // pinned below: SET-0B's corpus parity records [2408, 1988, 2404] for this board in turn order
  },
];

describe("golden boards -> buildSettlementPayloadV1: exactly the SET-0A values, in exactly the Rust layout", () => {
  for (const g of GOLDEN_PAYLOADS) {
    describe(g.name, () => {
      const built = build(g.board, g.seats, g.intent, g.log_len);
      const n = g.seats.length;

      it("appraisal_state_hash and settlement_weights come from the golden board (both transcriptions)", () => {
        if (g.expect) {
          expect(built.payload.appraisal_state_hash).toBe(g.expect.hash);
          expect(strings(built.payload.settlement_weights)).toEqual(g.expect.weights);
          const cross = crossLanguage.cases.find((c) => c.name === g.source_case)!;
          expect(built.payload.appraisal_state_hash).toBe(cross.appraisal_state_hash);
          expect(strings(built.payload.settlement_weights)).toEqual(cross.settlement_weights);
          expect(strings(built.payload.settlement_weights)).toEqual(rust.case_previews.find((c) => c.name === g.source_case)!.vector);
        } else {
          expect(strings(built.payload.settlement_weights)).toEqual(["2408", "1988", "2404"]);
          expect(built.payload.appraisal_state_hash).toBe(terminalStateHashV1(g.board));
        }
        expect(built.payload.appraisal_state_hash).toBe(sha256Hex(`18JUNO/STATE/v1\n${built.canonical_text}`));
      });

      it("the reason byte, seq, kind and A1 are the frozen derivations", () => {
        const reason = g.intent.kind === "Checkpoint" ? 0 : ({ BankBroken: 1, Bankruptcy: 2, ResolverCorrection: 5 } as Loose)[g.intent.outcome.reason];
        expect(built.payload.reason).toBe(reason);
        if (g.intent.kind === "Terminal" && g.intent.outcome.reason !== "ResolverCorrection") {
          expect(built.payload.reason).toBe(crossLanguage.cases.find((c) => c.name === g.source_case)!.reason_code);
        }
        expect(built.payload.kind).toBe(g.intent.kind === "Checkpoint" ? 0 : 1);
        expect(built.payload.seq).toBe(b(2 * g.log_len + built.payload.kind));
        expect(built.payload.appraisal_log_len).toBe(built.payload.log_len);
        expect(built.usage).toBe(g.intent.kind === "Checkpoint" ? "Checkpoint" : reason === 5 ? "ResolverReplace" : "Settle");
      });

      it("encodes to 136 + 16·n bytes that decode back to the payload; the digest is over exactly those bytes", () => {
        expect(built.encoded_hex.length).toBe(2 * (136 + 16 * n));
        expect(bytesToHex(encodeSettlementPayloadV1(built.payload))).toBe(built.encoded_hex);
        expect(decodeSettlementPayloadV1(hexToBytes(built.encoded_hex))).toEqual(built.payload);
        expect(settleDigestV1(built.payload)).toBe(built.settle_digest);
        expect(settlementPayloadFromWire(JSON.parse(JSON.stringify(built.wire)))).toEqual(built.payload);
      });

      it("previews the golden payouts and dust from the domain's own pool (n × 1,950,000)", () => {
        const pool = b(n) * ANTE_NET;
        const preview = payoutPreview(pool, built.payload.settlement_weights);
        if (g.expect) {
          expect(pool.toString()).toBe(g.expect.pool);
          expect(strings(preview.payouts)).toEqual(g.expect.payouts);
          expect(preview.dust.toString()).toBe(g.expect.dust);
        }
        expect(preview.payouts.reduce((s, p) => s + p, b(0)) + preview.dust).toBe(pool);
      });

      it("the committed-text entry point builds the identical payload, and the verifier accepts it", () => {
        const again = buildSettlementPayloadV1(argsFor(g.board, g.seats, g.intent, g.log_len, { board: { canonical_text: built.canonical_text } }));
        expect(built.seats).toEqual(g.seats);
        expect(built.roster_hash).toBe(domainFor(n).inputs.roster_hash);
        expect(again.encoded_hex).toBe(built.encoded_hex);
        expect(again.settle_digest).toBe(built.settle_digest);
        const verified = verifySettlementPayloadV1(built.payload, built.canonical_text, g.seats, TERMS);
        expect(verified.appraisal_state_hash).toBe(built.payload.appraisal_state_hash);
        expect(strings(verified.settlement_weights)).toEqual(strings(built.payload.settlement_weights));
        expect(verified.settle_digest).toBe(built.settle_digest);
      });
    });
  }

  it("covers 2, 3, 4, 6 and 7 seats; every reason the builder supports; both kinds", () => {
    expect(new Set(GOLDEN_PAYLOADS.map((g) => g.seats.length))).toEqual(new Set([2, 3, 4, 6, 7]));
    const reasons = GOLDEN_PAYLOADS.map((g) => (g.intent.kind === "Checkpoint" ? "RoundBoundary" : g.intent.outcome.reason));
    expect(new Set(reasons)).toEqual(new Set(["RoundBoundary", "BankBroken", "Bankruptcy", "ResolverCorrection"]));
  });

  it("the two- and seven-seat golden payloads use exactly the Rust/Python domains", () => {
    expect(domainFor(2).domain).toBe(RUST_2.domain);
    expect(domainFor(7).domain).toBe(RUST_7.domain);
    expect(domainFor(2).inputs.roster_hash).toBe(RUST_2.roster_hash);
    expect(domainFor(7).inputs.roster_hash).toBe(RUST_7.roster_hash);
  });
});

/* ------------------------------------------------------------------ */
/* 4. SET-0C's own vector file (generated, pinned, Python-checked)    */
/* ------------------------------------------------------------------ */

describe("the SET-0C golden payload vector file", () => {
  const file = join(FIXTURES, "settlementPayloadVectorsV1.json");

  function generate(): unknown {
    const domains = [2, 3, 4, 6, 7].map(domainFor);
    return {
      format: "18JUNO/SET0C/settlement-payload-vectors/v1",
      source:
        "generated by frontend/src/utils/settlementPayloadGoldens.test.ts: the SET-0A rev 2 golden boards (rebuilt in-repo, pinned by terminal_state_hash_v1) and one mid-game v10 board, through buildSettlementPayloadV1 (commitAndAppraise -> terminalSettlementWeights -> the 136 + 16*n encoder)",
      real_fields: "appraisal_state_hash, settlement_weights, reason, kind and seat order are the boards' real values (equal to SET-0A rev 2)",
      test_fields: `domain inputs, log_len, log_hash (= SHA-256("18JUNO/TEST/log")), state_schema_version, signer_key_id and issued_at are test values`,
      checked_by:
        "contracts/escrow/tests/set0c_vectors.rs (the escrow crate re-derives every domain, byte, digest, shape, payout and dust value; cargo test) and frontend/src/utils/__fixtures__/settlement/verify_set0c_payload_vectors.py (the escrow crate's independent Python encoder, run by hand)",
      domains: domains.map((d) => ({
        name: d.name,
        supplied_by_rust_vectors: d.supplied,
        chain_id: d.inputs.chain_id,
        contract_addr: d.inputs.contract_addr,
        chain_game_id: d.inputs.chain_game_id.toString(),
        roster_wallets: d.wallets,
        roster_hash: d.inputs.roster_hash,
        rules_engine_version: d.inputs.rules_engine_version,
        variants_digest: d.inputs.variants_digest,
        ante_gross: d.inputs.ante_gross.toString(),
        mode: d.inputs.mode,
        domain: d.domain,
      })),
      payload_vectors: GOLDEN_PAYLOADS.map((g) => {
        const built = build(g.board, g.seats, g.intent, g.log_len);
        const pool = b(g.seats.length) * ANTE_NET;
        const preview = payoutPreview(pool, built.payload.settlement_weights);
        return {
          name: g.name,
          source_case: g.source_case,
          usage: built.usage,
          domain_name: domainFor(g.seats.length).name,
          seat_mapping: g.seats.map((seat) => ({ chain_seat_index: seat.seat_index, player_id: seat.player_id })),
          payload: built.wire,
          encoded_len: built.encoded_hex.length / 2,
          encoded: built.encoded_hex,
          settle_digest: built.settle_digest,
          consent_digest: consentDigestV1(built.payload.domain, built.payload.seq, built.settle_digest),
          pool_ujuno: pool.toString(),
          payouts_ujuno: strings(preview.payouts),
          dust_ujuno: preview.dust.toString(),
        };
      }),
    };
  }

  it("is exactly what the builder generates (UPDATE_SETTLEMENT_VECTORS=1 rewrites it)", () => {
    const text = `${JSON.stringify(generate(), null, 1)}\n`;
    if (process.env.UPDATE_SETTLEMENT_VECTORS === "1") writeFileSync(file, text);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe(text); // LF-normalised: autocrlf is not a change
  });
});

/* ------------------------------------------------------------------ */
/* 5. One snapshot for the hash and the weights                       */
/* ------------------------------------------------------------------ */

describe("same snapshot: the hash and the weights of a payload always describe one board", () => {
  const SYN01 = boards["SYN-01-CLASSIC-BANKBREAK"];
  const SEATS = seatsOf(["p2", "p1", "p3"]);
  const TERMINAL: SettlementPayloadIntent = { kind: "Terminal", outcome: { reason: "BankBroken" }, terms: TERMS };
  const copy = (): Loose => JSON.parse(JSON.stringify(SYN01)) as Loose;

  it("a board whose cash answers differently on each read still yields one committed board (hash and weights agree)", () => {
    const target = copy();
    let reads = 0;
    const cashRow = target.player_cash[1] as Loose; // p2
    target.player_cash[1] = new Proxy(cashRow, {
      getOwnPropertyDescriptor: (t, key) => {
        const d = Reflect.getOwnPropertyDescriptor(t, key);
        return key === "cash_vgp" && d && (reads += 1) > 1 ? { ...d, value: "999999" } : d;
      },
    });
    const built = build(target as GameStateResponse, SEATS, TERMINAL, 1000);
    // Whatever value the one read saw, the hash commits to it AND the weights appraise it.
    const committedCash = (JSON.parse(built.canonical_text) as Loose).player_cash[1].cash_vgp as string;
    expect(built.payload.appraisal_state_hash).toBe(sha256Hex(`18JUNO/STATE/v1\n${built.canonical_text}`));
    expect(built.payload.settlement_weights[0]).toBe(b(committedCash) + b(1338 + 150));
    expect(() => verifySettlementPayloadV1(built.payload, built.canonical_text, SEATS)).not.toThrow();
  });

  it("mutating the board after the build changes nothing already built; the old text still verifies, the new one does not", () => {
    const live = copy();
    const built = build(live as GameStateResponse, SEATS, TERMINAL, 1000);
    const before = built.encoded_hex;
    live.player_cash[1].cash_vgp = "5000";
    expect(built.encoded_hex).toBe(before);
    expect(Object.isFrozen(built.payload) && Object.isFrozen(built.payload.settlement_weights)).toBe(true);
    expect(() => verifySettlementPayloadV1(built.payload, built.canonical_text, SEATS)).not.toThrow();
    expect(code(() => verifySettlementPayloadV1(built.payload, canonicalStateText(live as GameStateResponse), SEATS))).toBe(
      "PAYLOAD_APPRAISAL_MISMATCH",
    );
  });

  it("the forbidden two-call pattern (hash of one board, vector of another) is exactly what the verifier refuses", () => {
    const honest = build(SYN01, SEATS, TERMINAL, 1000);
    const mutated = copy();
    mutated.player_cash[1].cash_vgp = "5000";
    const otherVector = commitAndAppraise(mutated as GameStateResponse, SEATS).vector;
    const spliced = { ...honest.payload, settlement_weights: otherVector };
    expect(spliced.appraisal_state_hash).toBe(derived.cases[0].terminal_state_hash_v1);
    let message = "";
    try {
      verifySettlementPayloadV1(spliced, honest.canonical_text, SEATS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("PAYLOAD_APPRAISAL_MISMATCH: settlement_weights[0] is 6488, the appraisal gives 2018");
    const splicedHash = { ...honest.payload, appraisal_state_hash: terminalStateHashV1(mutated as GameStateResponse) };
    expect(code(() => verifySettlementPayloadV1(splicedHash, honest.canonical_text, SEATS))).toBe("PAYLOAD_APPRAISAL_MISMATCH");
  });

  it("the builder takes exactly one board source, and never imports the two separate SET-0A calls", () => {
    const args = argsFor(SYN01, SEATS, TERMINAL, 1);
    const text = canonicalStateText(SYN01);
    expect(code(() => buildSettlementPayloadV1({ ...args, board: { state: SYN01, canonical_text: text } as never }))).toBe("MALFORMED_INPUT");
    expect(code(() => buildSettlementPayloadV1({ ...args, board: {} as never }))).toBe("MALFORMED_INPUT");
    expect(code(() => buildSettlementPayloadV1({ ...args, board: { canonical_text: `${text} ` } }))).toBe("NON_CANONICAL_STATE_TEXT");
    for (const module of ["settlementPayload.ts", "settlementConformance.ts"]) {
      const source = readFileSync(join(__dirname, "..", "gameEngine", module), "utf8");
      expect(source).not.toMatch(/import[^;]*\b(terminalStateHashV1|baseNetWorthVector)\b[^;]*;/);
      expect(source).not.toMatch(/\b(terminalStateHashV1|baseNetWorthVector)\s*\(/);
    }
    const builder = readFileSync(join(__dirname, "..", "gameEngine", "settlementPayload.ts"), "utf8");
    expect(builder).toMatch(/commitAndAppraise\(board\.state as GameStateResponse, mapping\.seats\)/);
    expect(builder).toMatch(/appraiseCommittedState\(text, mapping\.seats\)/);
  });

  it("a getter on the build arguments is read once: the domain checked is the domain encoded", () => {
    const three = domainFor(3);
    let reads = 0;
    const args = argsFor(SYN01, SEATS, TERMINAL, 1) as Loose;
    delete args.domain;
    Object.defineProperty(args, "domain", { enumerable: true, get: () => ((reads += 1) === 1 ? three.domain : "00".repeat(32)) });
    const built = buildSettlementPayloadV1(args as BuildSettlementPayloadArgs);
    expect(reads).toBe(1);
    expect(built.payload.domain).toBe(three.domain);
  });

  it("review L1: the terminal reason is read once -- the reason that picks the policy is the reason encoded", () => {
    let reads = 0;
    const outcome = {
      get reason() {
        reads += 1;
        return reads === 2 ? "Forfeit" : "BankBroken";
      },
    };
    const built = buildSettlementPayloadV1(argsFor(SYN01, SEATS, { kind: "Terminal", outcome: outcome as never, terms: TERMS }, 1));
    expect(reads).toBe(1);
    expect(built.payload.reason).toBe(1);
    expect(built.usage).toBe("Settle");
    expect(code(() => buildSettlementPayloadV1(argsFor(SYN01, SEATS, { kind: "Terminal", outcome: { reason: "AdminVoid" } as never, terms: TERMS }, 1)))).toBe("MALFORMED_INPUT");
    expect(code(() => buildSettlementPayloadV1(argsFor(SYN01, SEATS, { kind: "Terminal", outcome: { reason: "toString" } as never, terms: TERMS }, 1)))).toBe("MALFORMED_INPUT");
  });

  it("review L2: the domain inputs are copied once -- an accessor or a non-plain object is refused, not read twice", () => {
    const three = domainFor(3);
    const tricky = { ...three.inputs } as Loose;
    let reads = 0;
    delete tricky.rules_engine_version;
    Object.defineProperty(tricky, "rules_engine_version", { enumerable: true, get: () => ((reads += 1) === 1 ? 11 : 10) });
    expect(code(() => buildSettlementPayloadV1(argsFor(SYN01, SEATS, TERMINAL, 1, { domain_inputs: tricky as never })))).toBe("MALFORMED_INPUT");
    expect(reads).toBe(0);
    const inherited = Object.create(three.inputs) as SettlementDomainInputs;
    expect(code(() => buildSettlementPayloadV1(argsFor(SYN01, SEATS, TERMINAL, 1, { domain_inputs: inherited })))).toBe("MALFORMED_INPUT");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Seat order and seat identity                                    */
/* ------------------------------------------------------------------ */

describe("chain seat order, never turn order; no player or principal id in the bytes", () => {
  const SYN01 = boards["SYN-01-CLASSIC-BANKBREAK"];
  const TERMINAL: SettlementPayloadIntent = { kind: "Terminal", outcome: { reason: "BankBroken" }, terms: TERMS };

  it("the weights follow the chain mapping: permuting the seats permutes the weights and moves the bytes", () => {
    const mappings = [["p2", "p1", "p3"], ["p1", "p2", "p3"], ["p3", "p2", "p1"]];
    const worth: Record<string, string> = { p1: "2448", p2: "2018", p3: "2409" };
    const encodings = new Set<string>();
    for (const ids of mappings) {
      const built = build(SYN01, seatsOf(ids), TERMINAL, 1000);
      expect(strings(built.payload.settlement_weights)).toEqual(ids.map((id) => worth[id]));
      expect(built.payload.appraisal_state_hash).toBe(derived.cases[0].terminal_state_hash_v1); // same board
      encodings.add(built.encoded_hex);
    }
    expect(encodings.size).toBe(3);
  });

  it("reshuffling the TURN order (player_addresses) leaves the chain-order weights unchanged (the board hash moves, as it must)", () => {
    const seats = seatsOf(["p2", "p1", "p3"]);
    for (const order of [["p1", "p2", "p3"], ["p3", "p1", "p2"], ["p2", "p3", "p1"]]) {
      const shuffled = { ...SYN01, player_addresses: order } as GameStateResponse;
      const built = build(shuffled, seats, TERMINAL, 1000);
      expect(strings(built.payload.settlement_weights)).toEqual(["2018", "2448", "2409"]);
      if (order.join() !== SYN01.player_addresses.join()) {
        expect(built.payload.appraisal_state_hash).not.toBe(derived.cases[0].terminal_state_hash_v1);
      }
    }
  });

  it("settlementSeatMapping: one binding list gives the appraisal seats AND the roster, both in chain order", () => {
    const wallets = rosterNamed("three-seat");
    const mapping = settlementSeatMapping([
      { chain_seat_index: 0, player_id: "p2", wallet: wallets[0] },
      { chain_seat_index: 1, player_id: "p1", wallet: wallets[1] },
      { chain_seat_index: 2, player_id: "p3", wallet: wallets[2] },
    ]);
    expect(mapping.seats).toEqual(seatsOf(["p2", "p1", "p3"]));
    expect(mapping.wallets).toEqual(wallets);
    expect(mapping.roster_hash).toBe(payloadVectors.roster_vectors.find((r) => r.name === "three-seat")!.roster_hash);
    const built = build(SYN01, mapping.seats as SettlementSeat[], TERMINAL, 1000);
    expect(strings(built.payload.settlement_weights)).toEqual(["2018", "2448", "2409"]);
  });

  it("settlementSeatMapping refuses what the contract or the appraiser would: gaps, duplicates, unnormalised wallets, n outside 2..7", () => {
    const w = SEVEN;
    const ok = (i: number, id: string) => ({ chain_seat_index: i, player_id: id, wallet: w[i] });
    expect(code(() => settlementSeatMapping([ok(0, "a"), { ...ok(1, "b"), chain_seat_index: 2 }]))).toBe("MALFORMED_INPUT");
    expect(code(() => settlementSeatMapping([ok(0, "a"), ok(1, "a")]))).toBe("MALFORMED_INPUT");
    expect(code(() => settlementSeatMapping([ok(0, "a"), { ...ok(1, "b"), wallet: w[0] }]))).toBe("MALFORMED_INPUT");
    expect(code(() => settlementSeatMapping([ok(0, "a"), { ...ok(1, "b"), wallet: w[1].toUpperCase() }]))).toBe("MALFORMED_STRING");
    expect(code(() => settlementSeatMapping([ok(0, "a"), { ...ok(1, "b"), wallet: ` ${w[1]}` }]))).toBe("MALFORMED_STRING");
    expect(code(() => settlementSeatMapping([ok(0, "a"), { ...ok(1, "b"), player_id: "" }]))).toBe("MALFORMED_INPUT");
    expect(code(() => settlementSeatMapping([ok(0, "a")]))).toBe("BAD_SEAT_COUNT");
    expect(code(() => settlementSeatMapping(Array.from({ length: 8 }, (_, i) => ({ chain_seat_index: i, player_id: `p${i}`, wallet: `${w[i % 7]}${i}` }))))).toBe("BAD_SEAT_COUNT");
    expect(code(() => settlementSeatMapping(w.map((wallet, i) => ({ chain_seat_index: i, player_id: `p${i}`, wallet }))))).toBe("OK");
  });

  it("neither player ids nor any principal field ever reach the payload bytes or its JSON", () => {
    const g = boards["SYN-05-Z6C-COMPOSED-END"];
    const ids = ["p-lzjh2r6u", "p-6a1qgd0g", "p-je0gw2v0"];
    const built = build(g, seatsOf(ids), TERMINAL, 1000);
    const asciiHex = (text: string) => Array.from(text).map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    for (const id of ids) expect(built.encoded_hex).not.toContain(asciiHex(id));
    const json = JSON.stringify(built.wire);
    for (const id of ids) expect(json).not.toContain(id);
    expect(json).not.toMatch(/player_id|principal|wallet/);
    // The bytes are the same whoever is currently playing a seat: only the chain order matters.
    const renamed = JSON.parse(canonicalStateText(g).split("p-6a1qgd0g").join("p-zzzzzzzz")) as GameStateResponse;
    const rebuilt = build(renamed, seatsOf(["p-lzjh2r6u", "p-zzzzzzzz", "p-je0gw2v0"]), TERMINAL, 1000);
    expect(strings(rebuilt.payload.settlement_weights)).toEqual(strings(built.payload.settlement_weights));
  });
});

/* ------------------------------------------------------------------ */
/* 7. Rules engine v10 only, and the builder's refusals               */
/* ------------------------------------------------------------------ */

describe("settlement is certified for rules engine v10 only -- an axis independent of the gameplay engine (DA-8)", () => {
  it("TRIPWIRE: the certified list is the literal [10] whatever engine the game plays -- a gameplay bump never widens settlement", () => {
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).toEqual([10]);
    /* SET-0C wrote this as `RULES_ENGINE_VERSION === 10` and `SUPPORTED === [10]`, to fail on DA-8's bump. DA-8 took the
       bump (the game plays v11) and the owner ruled the two axes independent: a board is appraised when its pin is
       CERTIFIED, not when this build still plays it. So the tripwire now pins the separation itself -- the certified
       list is a literal that no gameplay constant moves, the golden boards carry the certified pin, and v11 is NOT in
       it. Adding 11 is the v11 settlement recertification's change, in its own reviewed pass. */
    expect(SET0A_CERTIFIED_RULES_ENGINE_VERSION).toBe(10);
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).not.toContain(RULES_ENGINE_VERSION);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).not.toContain(10);
  });

  it("a board pinned to any other engine is refused by the appraisal the builder runs, before any byte is written", () => {
    const SEATS = seatsOf(["p2", "p1", "p3"]);
    for (const pin of [9, 11]) {
      const board = { ...boards["SYN-01-CLASSIC-BANKBREAK"], rules_engine_version: pin } as GameStateResponse;
      expect(() => build(board, SEATS, { kind: "Checkpoint" }, 1)).toThrow(
        `UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=${pin} (supported: 10)`,
      );
    }
    expect(() => appraiseSeats({ ...boards["SYN-01-CLASSIC-BANKBREAK"], rules_engine_version: 11 } as GameStateResponse, SEATS)).toThrow(
      "UNSUPPORTED_RULES_ENGINE_VERSION",
    );
  });

  it("a domain that declares another rules engine than the board's pin is refused; so is a domain that is not its inputs' hash", () => {
    const three = domainFor(3);
    const base = argsFor(boards["SYN-01-CLASSIC-BANKBREAK"], seatsOf(["p2", "p1", "p3"]), { kind: "Checkpoint" }, 1);
    const v11 = { ...three.inputs, rules_engine_version: 11 };
    expect(code(() => buildSettlementPayloadV1({ ...base, domain: settlementDomainV1(v11), domain_inputs: v11 }))).toBe("RULES_ENGINE_VERSION_MISMATCH");
    expect(code(() => buildSettlementPayloadV1({ ...base, domain: domainFor(2).domain }))).toBe("DOMAIN_MISMATCH");
    expect(code(() => buildSettlementPayloadV1(base))).toBe("OK");
  });

  it("the bindings must be the domain's roster, in its order: a permuted or foreign roster is ROSTER_MISMATCH", () => {
    const seats = seatsOf(["p2", "p1", "p3"]);
    const base = argsFor(boards["SYN-01-CLASSIC-BANKBREAK"], seats, { kind: "Checkpoint" }, 1);
    const wallets = domainFor(3).wallets;
    // Same players, wallets rotated: the weights would be paid to the wrong wallets on chain.
    const rotated = bindingsFor(seats, [wallets[1], wallets[2], wallets[0]]);
    expect(code(() => buildSettlementPayloadV1({ ...base, bindings: rotated }))).toBe("ROSTER_MISMATCH");
    const foreign = bindingsFor(seats, SEVEN.slice(0, 3));
    expect(code(() => buildSettlementPayloadV1({ ...base, bindings: foreign }))).toBe("ROSTER_MISMATCH");
    // Re-assigning which PLAYER sits in which chain seat keeps the roster, and permutes the weights with it.
    const swapped = buildSettlementPayloadV1({ ...base, bindings: bindingsFor(seatsOf(["p1", "p2", "p3"])) });
    expect(strings(swapped.payload.settlement_weights)).toEqual(["2448", "2018", "2409"]);
  });
});

describe("the builder's policy boundaries (no server policy is invented here)", () => {
  const SYN01 = boards["SYN-01-CLASSIC-BANKBREAK"];
  const SEATS = seatsOf(["p2", "p1", "p3"]);
  const attempt = (intent: SettlementPayloadIntent, over: Loose = {}, board: GameStateResponse = SYN01) =>
    code(() => buildSettlementPayloadV1(argsFor(board, SEATS, intent, 10, over)));

  it("Forfeit and Clemency stay refused (SET-0B REASON_NOT_SUPPORTED until ESCROW-3c)", () => {
    for (const reason of ["Forfeit", "Clemency"] as const) {
      expect(attempt({ kind: "Terminal", outcome: { reason, offender_seat: 0 }, terms: TERMS }, { appraisal_log_len: b(5) })).toBe("REASON_NOT_SUPPORTED");
    }
  });

  it("an all-zero board is appraised (Q13) but no payload is made of it (Σw = 0; the contract refuses it too)", () => {
    const zero = JSON.parse(JSON.stringify(SYN01)) as Loose;
    for (const row of zero.player_cash) row.cash_vgp = "0";
    for (const c of zero.public_companies) {
      c.player_holdings = [];
      c.ipo_pool_percentage = 100;
      c.bank_pool_percentage = 0;
      c.par_value = null;
    }
    zero.market_positions = {};
    for (const p of zero.private_companies) p.closed = true;
    expect(attempt({ kind: "Checkpoint" }, {}, zero as GameStateResponse)).toBe("SETTLEMENT_ZERO_SUM");
    expect(attempt({ kind: "Terminal", outcome: { reason: "BankBroken" }, terms: TERMS }, {}, zero as GameStateResponse)).toBe("SETTLEMENT_ZERO_SUM");
  });

  it("A1, seq overflow, and number-typed u64 inputs are refused", () => {
    const bankBroken: SettlementPayloadIntent = { kind: "Terminal", outcome: { reason: "BankBroken" }, terms: TERMS };
    expect(attempt(bankBroken, { appraisal_log_len: b(9) })).toBe("BAD_APPRAISAL_LOG_LEN");
    expect(attempt({ kind: "Checkpoint" }, { appraisal_log_len: b(11) })).toBe("BAD_APPRAISAL_LOG_LEN");
    const halfMax = (BigInt(1) << BigInt(63)) - BigInt(1); // 2·halfMax + 1 = u64::MAX: the largest legal terminal
    expect(attempt(bankBroken, { log_len: halfMax, appraisal_log_len: halfMax })).toBe("OK");
    expect(attempt(bankBroken, { log_len: halfMax + BigInt(1), appraisal_log_len: halfMax + BigInt(1) })).toBe("BAD_SEQ");
    expect(attempt(bankBroken, { log_len: 10 })).toBe("MALFORMED_INTEGER");
    expect(attempt(bankBroken, { issued_at: 1758844800 })).toBe("MALFORMED_INTEGER");
    expect(attempt(bankBroken, { log_hash: LOG_HASH.toUpperCase() })).toBe("MALFORMED_HEX");
    expect(attempt(bankBroken, { domain: domainFor(3).domain.slice(2) })).toBe("DOMAIN_MISMATCH"); // proven against its inputs first
    expect(attempt(bankBroken, { state_schema_version: 65536 })).toBe("INTEGER_OUT_OF_RANGE");
    expect(attempt({ kind: "Other" } as never)).toBe("MALFORMED_INPUT");
  });

  it("appraisal refusals surface unchanged (a seat mapping that is not the board's players)", () => {
    expect(code(() => buildSettlementPayloadV1(argsFor(SYN01, seatsOf(["p2", "p1"]), { kind: "Checkpoint" }, 1)))).toBe("ROSTER_LENGTH_MISMATCH");
  });
});
