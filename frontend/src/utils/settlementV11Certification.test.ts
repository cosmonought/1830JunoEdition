/** @jest-environment node */
// frontend/src/utils/settlementV11Certification.test.ts
//
// ==================================================================
//  ESCROW-3A (ENTRY GATE): RULES ENGINE v11 RECERTIFIED FOR SETTLEMENT, BESIDE v10 -- NEVER OVER IT
// ==================================================================
//
// DA-8 separated two version axes (owner ruling): the gameplay engine plays v11, and settlement is certified per rules
// version, explicitly -- `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` is a literal, never derived from
// `RULES_ENGINE_VERSION`. v10 stays certified byte for byte (its goldens, payload vectors, cross-language vectors and
// the Juno oracle are frozen and untouched). This file is the v11 certification evidence that let ESCROW-3A add 11 to
// that literal, and it keeps proving it.
//
// WHAT "CERTIFIED FOR SETTLEMENT" GUARANTEES (SET-0A rev 2, SET-0B, SET-0C). For a board pinned to a certified version:
//   1. SEAT APPRAISAL: the SET-0A §4 wealth function -- cash + Σ pct/10 · share value (unparred $0) + face of open,
//      player-owned privates; the bankrupt president his unsellable shares only -- over exactly the fields SET-0A §4
//      lists, fail-closed on every structurally impossible board (§18's matrix);
//   2. WEIGHTS: whole-VGP u128 in chain seat order, identity policy for BankBroken / Bankruptcy / ResolverCorrection;
//   3. THE PAYLOAD: SettlementPayloadV1 (136 + 16·n bytes), the frozen SETTLE / CONSENT / ANNUL / ROSTER / DOMAIN
//      digests, floor(pool·w/Σw) with dust to the treasury -- all version-independent CODE, in which the rules engine
//      appears ONLY as the domain's u32 input, which must equal the board's pin (RULES_ENGINE_VERSION_MISMATCH);
//   4. REFUSAL: every other pin is refused before a value is read (UNSUPPORTED_RULES_ENGINE_VERSION).
//
// THE SET-0A AUDIT, RERUN AGAINST v11 (the questions that could move an appraisal). The appraiser reads only
// `rules_engine_version, player_addresses, player_cash, public_companies[].{company_id, ticker, player_holdings,
// ipo_pool_percentage, bank_pool_percentage, par_value}, market_positions, private_companies[].{private_id, closed,
// owner, owner_protocol_id, cost}, bankrupt_president, current_round_type` (SET-0A §4). Row 11 of the rules changelog
// names the ten replay semantics v11 changed: DA-F1/F2/F7 (auction ingress and the B&O par), DA-F3 (the delayed opener),
// DA-F4/F5 ($0 taking), D-52/DA-F6 (the C&A grant never mints a certificate), D-53/57/58/59 (curable must-sell), D-55/
// DA-F9 (the first 5-train cancels the owed auction), RR2A-F1 (no BeginOperatingRound escape) and DA-F12 (the Priority
// Deal holder after the revenue all-pass). Each changes WHICH boards a game can reach and WHO may act; none changes what
// any read field MEANS -- cash is still whole VGP moved only by the ledger, holdings still whole percent conserving 100,
// a mark still the parred corporation's share value, `closed` still ends a private's value, the bankrupt rule still
// v3's. The one appraisal-relevant consequence is favourable: SET-0A F-7 (DA-F6 could MINT a PRR certificate, so a
// Delayed Auction board could fail PERCENT_NOT_CONSERVED and be unsettleable) is CLOSED at v11 -- DA-7's real
// Delayed Auction game, dealt at v11 and played to GameEnd, appraises (`da7DelayedAuctionCertification` DA-T11).
//
// THE EVIDENCE BELOW:
//   A. the v11 golden set (the same thirteen SET-0A recipes, run by the v11 reducer, at pin 11) differs from the
//      certified v10 set in exactly one byte-level fact -- the pin: each v11 board re-stamped at 10 hashes to its
//      certified v10 `terminal_state_hash_v1`, and its canonical text differs only in `"rules_engine_version":11`;
//   B. every vector, component, payout and dust value equals SET-0A rev 2's;
//   C. THE FOUR THINGS THAT ARE NOT THE SAME, KEPT APART:
//        gameplay/state hash  (`terminal_state_hash_v1`)   DIFFERS -- the pin is a board field and the hash covers it;
//        settlement payload bytes                          DIFFER in exactly two fields: `domain` (offsets 1..33, the
//                                                          domain hashes u32 rules_engine_version) and
//                                                          `appraisal_state_hash` (91..123); every other byte -- version,
//                                                          seq, kind, reason, log_len, log_hash, appraisal_log_len,
//                                                          state_schema_version, n, every weight, signer_key_id,
//                                                          issued_at -- is IDENTICAL to the frozen v10 vector's;
//        settlement digests (SETTLE, CONSENT)              DIFFER, because they cover those bytes;
//        chain contract bytes / codec / arithmetic         UNCHANGED -- same encoder, same digest constructions, same
//                                                          payout function, same Juno codec; the contract takes the
//                                                          rules engine as an opaque u32 at CreateGame and hashes it
//                                                          into the domain it already computes; the canonical wasm is
//                                                          not rebuilt and nothing under contracts/ changes;
//   D. v10 and v11 coexist: each board settles only under a domain declaring its own pin;
//   E. every uncertified pin (9, 12, 13, …, RULES_ENGINE_VERSION + 1) fails closed, and the certified list is a literal;
//   F. the SET-0A corpus parity sweep (rankPlayers vs the appraiser, every board of the five in-repo logs), at pin 11.
//
// The v11 values are pinned in `__fixtures__/settlement/settlementV11CertificationVectors.json`, GENERATED by this file
// (`UPDATE_SETTLEMENT_V11_VECTORS=1` rewrites it) -- a new file beside the frozen v10 ones, none of which is rewritten.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS,
  SettlementAppraisalError,
  appraiseSeats,
  type SettlementSeat,
} from "../gameEngine/settlementAppraisal";
import {
  SettlementPayloadError,
  buildSettlementPayloadV1,
  checkSettlementPayloadV1,
  consentDigestV1,
  decodeSettlementPayloadV1,
  hexToBytes,
  settlementDomainV1,
  type BuildSettlementPayloadArgs,
  type SettlementDomainInputs,
  type SettlementPayloadIntent,
} from "../gameEngine/settlementPayload";
import { verifySettlementPayloadV1 } from "../gameEngine/settlementConformance";
import { appraiseCommittedState, canonicalStateText, terminalStateHashV1 } from "../gameEngine/settlementDigest";
import { terminalSettlementWeights, SETTLEMENT_REASON_CODE, type TerminalReason } from "../gameEngine/settlementPolicy";
import { payoutPreview } from "../gameEngine/settlementPreview";
import { buildSettlementCoreV1 } from "../gameEngine/escrow/settlementCoreV1";
import { JUNO_CODEC_V1 } from "../gameEngine/escrow/junoCodecV1";
import { rankPlayers } from "../gameEngine/endgame";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../gameEngine/rulesVersion";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { ExportedEntry } from "../gameEngine/replayLog";
import {
  FIXTURES_DIR,
  FROZEN_LOG_DIR,
  SERVER_DATA_DIR,
  SET0A_CERTIFIED_RULES_ENGINE_VERSION,
  SET0A_V11_RULES_ENGINE_VERSION,
  atV11SettlementPin,
  readExport,
  readJsonl,
  replayBoards,
  v11GoldenBoards,
} from "./settlementGoldenBoards";
import * as GR from "./gentleRustCertificationGame";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SETTLEMENT = join(__dirname, "__fixtures__", "settlement");
const REPO = join(__dirname, "..", "..", "..");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const b = (value: string | number) => BigInt(value);
const strings = (values: readonly bigint[]) => values.map((value) => value.toString());
const seatsOf = (ids: readonly string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));

/* The frozen v10 evidence -- READ, never written. */
const V10_GOLDEN = readJson(join(SETTLEMENT, "SET0A_golden_vectors_rev2.derived.json")) as {
  ante: { ante_net_ujuno: string };
  cases: Array<{
    name: string;
    reason: TerminalReason;
    terminal_state_hash_v1: string;
    turn_order: string[];
    seat_mapping: string[];
    components: Array<{ player_id: string; bankrupt: boolean; cash_in_state: string; cash: string; shares: string; privates: string; total: string; private_ids: number[]; holdings: Array<[string, number, string | null, string]> }>;
    vector: string[];
    sum: string;
    pool_ujuno: string;
    payouts_ujuno: string[];
    dust_ujuno: string;
  }>;
};
const V10_PAYLOADS = readJson(join(SETTLEMENT, "settlementPayloadVectorsV1.json")) as Loose;
const V11_FILE = join(SETTLEMENT, "settlementV11CertificationVectors.json");

/* The frozen files this gate must never move (PROJECT_CANONICAL_CONTEXT §D.4), by content hash. */
const FROZEN = [
  ["contracts/escrow/testdata/payload_vectors_v1.json", "635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac"],
  ["frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json", "b58651de13de2c4f91d355c15cca92689001ba4bcbdb2a9fbaa348cbe6a7906c"],
  ["contracts/escrow/testdata/set0a_payout_vectors_rev2.json", "dfe9fbdfa8f88c21bd5cc8eeecbd06f0ef7db4ce6ba8bf72aa4633b7a39d4994"],
  ["frontend/src/utils/__fixtures__/settlement/SET0A_golden_vectors_rev2.derived.json", "c16fb8170d38a6b6870d0e39091337d82d89fc2a54bb29f41b98cc98a5c7721a"],
  ["frontend/src/utils/__fixtures__/settlement/settlementCrossLanguageVectors.json", "50bf34e1374767df4e3273198cfe6537ba7f73fefd51d9a437b0f113c3015d74"],
] as const;

const { boards, dealtPins, syn01Submissions } = v11GoldenBoards();
const ANTE_NET = b(V10_GOLDEN.ante.ante_net_ujuno);
const TERMS = { pool_net_ujuno: b(0), ante_net_ujuno: ANTE_NET };

/** The v10 board this v11 board must equal but for its pin. */
const atPin = (board: GameStateResponse, pin: number) => ({ ...board, rules_engine_version: pin }) as GameStateResponse;

/* ------------------------------------------------------------------ */
/* The v11 domains: SET-0C's five domains, the rules engine set to 11   */
/* ------------------------------------------------------------------ */

interface V11Domain {
  name: string;
  v10_name: string;
  wallets: string[];
  inputs: SettlementDomainInputs;
  domain: string;
  v10_domain: string;
}

const inputsOf = (d: Loose, rules: number): SettlementDomainInputs => ({
  chain_id: d.chain_id,
  contract_addr: d.contract_addr,
  chain_game_id: b(d.chain_game_id),
  roster_hash: d.roster_hash,
  rules_engine_version: rules,
  variants_digest: d.variants_digest,
  ante_gross: b(d.ante_gross),
  mode: d.mode,
});

const V11_DOMAINS: V11Domain[] = (V10_PAYLOADS.domains as Loose[]).map((d) => {
  const inputs = inputsOf(d, SET0A_V11_RULES_ENGINE_VERSION);
  return { name: `${d.name}/rules-v11`, v10_name: d.name, wallets: d.roster_wallets, inputs, domain: settlementDomainV1(inputs), v10_domain: d.domain };
});
const v11DomainFor = (v10Name: string) => V11_DOMAINS.find((d) => d.v10_name === v10Name)!;

/* ------------------------------------------------------------------ */
/* The v11 payloads: SET-0C's fifteen, rebuilt on the v11 boards/domains */
/* ------------------------------------------------------------------ */

const REASON_NAME: Record<number, "BankBroken" | "Bankruptcy" | "ResolverCorrection"> = { 1: "BankBroken", 2: "Bankruptcy", 5: "ResolverCorrection" };

/** The v11 counterpart of a SET-0C source board: the v11 golden board, or the GR-4 start (a mid-game board dealt by the
 *  room at the current engine) at the v11 pin. */
const v11BoardOf = (v: Loose): GameStateResponse =>
  String(v.source_case).startsWith("GR-4") ? atV11SettlementPin(GR.certificationStart()) : boards[v.source_case];

/** Exactly the frozen v10 vector's builder arguments, on the v11 board and the v11 domain. */
function v11ArgsFor(v: Loose): BuildSettlementPayloadArgs {
  const d = v11DomainFor(v.domain_name);
  const p = v.payload;
  const intent: SettlementPayloadIntent =
    p.kind === 0 ? { kind: "Checkpoint" } : { kind: "Terminal", outcome: { reason: REASON_NAME[p.reason] }, terms: TERMS };
  const mapping = v.seat_mapping as Array<{ chain_seat_index: number; player_id: string }>;
  return {
    board: { state: v11BoardOf(v) },
    bindings: mapping.map((s) => ({ chain_seat_index: s.chain_seat_index, player_id: s.player_id, wallet: d.wallets[s.chain_seat_index] })),
    domain: d.domain,
    domain_inputs: d.inputs,
    intent,
    log_len: b(p.log_len),
    log_hash: p.log_hash,
    appraisal_log_len: b(p.appraisal_log_len),
    state_schema_version: p.state_schema_version,
    signer_key_id: p.signer_key_id,
    issued_at: b(p.issued_at),
  };
}

/** The byte ranges of SettlementPayloadV1 that name the rules engine, directly or through a hash (SET-0C §5). */
const DOMAIN_BYTES: readonly [number, number] = [1, 33];
const APPRAISAL_HASH_BYTES: readonly [number, number] = [91, 123];

/** Every byte offset at which two encodings differ. */
function differingOffsets(aHex: string, bHex: string): number[] {
  const a = hexToBytes(aHex);
  const c = hexToBytes(bHex);
  expect(a.length).toBe(c.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== c[i]) out.push(i);
  return out;
}

function code(run: () => unknown): string {
  try {
    run();
    return "OK";
  } catch (error) {
    if (error instanceof SettlementPayloadError || error instanceof SettlementAppraisalError) return error.code;
    throw error;
  }
}

/* ================================================================================================= */
/* A. The v11 golden set is the v10 set, the pin aside                                               */
/* ================================================================================================= */

describe("A. the v11 golden set: the SET-0A recipes run by the v11 reducer, differing from the certified v10 set only in the pin", () => {
  it("covers exactly the thirteen SET-0A cases; SYN-01 reaches GameEnd in the recorded 20 submissions", () => {
    expect(Object.keys(boards).sort()).toEqual(V10_GOLDEN.cases.map((entry) => entry.name).sort());
    expect(syn01Submissions).toBe(20);
  });

  it("the room-dealt recipes are dealt by the current engine, and the v11 set carries the v11 pin on every board", () => {
    expect(SET0A_V11_RULES_ENGINE_VERSION).toBe(11);
    expect(SET0A_CERTIFIED_RULES_ENGINE_VERSION).toBe(10); // the v10 set's own pin, unmoved
    expect(Object.values(dealtPins)).toEqual([RULES_ENGINE_VERSION, RULES_ENGINE_VERSION, RULES_ENGINE_VERSION]);
    for (const board of Object.values(boards)) expect(board.rules_engine_version).toBe(11);
  });

  for (const entry of V10_GOLDEN.cases) {
    it(`${entry.name}: re-stamped at 10 it IS the certified v10 board (its terminal_state_hash_v1); at 11 only the pin differs`, () => {
      const v11 = boards[entry.name];
      expect(v11.current_round_type).toBe("GameEnd");
      expect(v11.player_addresses).toEqual(entry.turn_order);
      // The certified v10 bytes, reproduced by the v11 reducer's board with the pin set back.
      expect(terminalStateHashV1(atPin(v11, 10))).toBe(entry.terminal_state_hash_v1);
      // The pin is a board field, and the state hash covers it: the v11 hash is a different hash.
      expect(terminalStateHashV1(v11)).not.toBe(entry.terminal_state_hash_v1);
      // ... and the canonical texts differ in exactly that one token.
      const text11 = canonicalStateText(v11);
      const text10 = canonicalStateText(atPin(v11, 10));
      expect(text11.split('"rules_engine_version":11').length).toBe(2);
      expect(text11.replace('"rules_engine_version":11', '"rules_engine_version":10')).toBe(text10);
    });
  }
});

/* ================================================================================================= */
/* B. The v11 appraisal: every SET-0A value, unchanged                                               */
/* ================================================================================================= */

function rankedWorth(state: GameStateResponse): Record<string, number> {
  const marks = (state.market_positions ?? {}) as Record<number, { price: number } | null>;
  const out: Record<string, number> = {};
  for (const row of rankPlayers({ state, priceForCompany: (id) => marks[id]?.price ?? null, labelForAddress: (address) => address, bankruptAddress: state.bankrupt_president ?? null })) {
    out[row.address] = row.netWorth;
  }
  return out;
}

describe("B. the v11 boards through the committed-state pipeline: exactly SET-0A rev 2's vectors, components, payouts and dust", () => {
  for (const entry of V10_GOLDEN.cases) {
    it(entry.name, () => {
      const board = boards[entry.name];
      const seats = seatsOf(entry.seat_mapping);
      const committed = appraiseCommittedState(canonicalStateText(board), seats);
      expect(committed.appraisal_state_hash).toBe(terminalStateHashV1(board));
      expect(strings(committed.vector)).toEqual(entry.vector);
      expect(committed.vector.reduce((a, c) => a + c, b(0)).toString()).toBe(entry.sum);
      committed.appraisals.forEach((seat, index) => {
        const want = entry.components[index];
        expect([seat.player_id, seat.bankrupt, seat.cash_state.toString(), seat.cash_counted.toString(), seat.shares.toString(), seat.privates.toString(), seat.total.toString()]).toEqual([
          want.player_id,
          want.bankrupt,
          want.cash_in_state,
          want.cash,
          want.shares,
          want.privates,
          want.total,
        ]);
        expect(seat.private_lines.map((line) => line.private_id)).toEqual(want.private_ids);
        expect(seat.holdings.map((line) => [line.ticker, line.percent, line.share_value === null ? null : line.share_value.toString(), line.value.toString()])).toEqual(want.holdings);
      });
      const weights = terminalSettlementWeights(committed.vector, { reason: entry.reason } as never, TERMS);
      expect(weights).toEqual(committed.vector);
      const preview = payoutPreview(b(entry.pool_ujuno), weights);
      expect(strings(preview.payouts)).toEqual(entry.payouts_ujuno);
      expect(preview.dust.toString()).toBe(entry.dust_ujuno);
      const ranked = rankedWorth(board);
      for (const seat of committed.appraisals) expect(ranked[seat.player_id]).toBe(Number(seat.total.toString()));
    });
  }
});

/* ================================================================================================= */
/* C. Payload bytes: same codec, same layout; the domain and the appraisal hash are the only moves   */
/* ================================================================================================= */

describe("C. the fifteen SET-0C payloads rebuilt on v11: identical to the frozen v10 bytes outside `domain` and `appraisal_state_hash`", () => {
  it("the v11 domains are SET-0C's five with only the u32 rules engine changed -- and it moves each domain", () => {
    expect(V11_DOMAINS).toHaveLength(5);
    for (const d of V11_DOMAINS) {
      const v10 = (V10_PAYLOADS.domains as Loose[]).find((x) => x.name === d.v10_name)!;
      expect(v10.rules_engine_version).toBe(10);
      expect(settlementDomainV1(inputsOf(v10, 10))).toBe(v10.domain); // the frozen v10 domain, recomputed
      expect(d.domain).not.toBe(d.v10_domain);
      expect(d.domain).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  for (const v of V10_PAYLOADS.payload_vectors as Loose[]) {
    it(`${v.name}: v11 bytes = v10 bytes except [1,33) domain and [91,123) appraisal_state_hash; same weights, payouts, dust`, () => {
      const built = buildSettlementPayloadV1(v11ArgsFor(v));
      expect(built.usage).toBe(v.usage);
      expect(built.encoded_hex.length / 2).toBe(v.encoded_len);
      const differ = differingOffsets(built.encoded_hex, v.encoded);
      expect(differ.length).toBeGreaterThan(0);
      for (const at of differ) {
        const inDomain = at >= DOMAIN_BYTES[0] && at < DOMAIN_BYTES[1];
        const inHash = at >= APPRAISAL_HASH_BYTES[0] && at < APPRAISAL_HASH_BYTES[1];
        expect([at, inDomain || inHash]).toEqual([at, true]);
      }
      expect(built.payload.domain).toBe(v11DomainFor(v.domain_name).domain);
      expect(built.payload.appraisal_state_hash).toBe(terminalStateHashV1(v11BoardOf(v)));
      expect(built.payload.appraisal_state_hash).not.toBe(v.payload.appraisal_state_hash);
      // Every other field of the wire payload is the frozen vector's, value for value.
      const { domain: _d, appraisal_state_hash: _h, ...rest11 } = built.wire as Loose;
      const { domain: _d10, appraisal_state_hash: _h10, ...rest10 } = v.payload as Loose;
      void _d;
      void _h;
      void _d10;
      void _h10;
      expect(rest11).toEqual(rest10);
      // The digests cover those bytes, so they move; the rules the contract applies to the payload do not.
      expect(built.settle_digest).not.toBe(v.settle_digest);
      expect(consentDigestV1(built.payload.domain, built.payload.seq, built.settle_digest)).not.toBe(v.consent_digest);
      expect(code(() => checkSettlementPayloadV1(built.payload, built.usage))).toBe("OK");
      expect(decodeSettlementPayloadV1(hexToBytes(built.encoded_hex))).toEqual(built.payload);
      const pool = b(v.pool_ujuno);
      const preview = payoutPreview(pool, built.payload.settlement_weights);
      expect(strings(preview.payouts)).toEqual(v.payouts_ujuno);
      expect(preview.dust.toString()).toBe(v.dust_ujuno);
      // The verifier a client or resolver runs re-derives it from the committed v11 text.
      const verified = verifySettlementPayloadV1(built.payload, built.canonical_text, built.seats, TERMS);
      expect(verified.settle_digest).toBe(built.settle_digest);
    });
  }

  it("the chain-neutral core (GNOLAND-1) with the certified Juno codec builds the identical v11 bytes -- no codec change", () => {
    for (const v of V10_PAYLOADS.payload_vectors as Loose[]) {
      const args = v11ArgsFor(v);
      const certified = buildSettlementPayloadV1(args);
      const intent = args.intent.kind === "Checkpoint" ? args.intent : { kind: "Terminal" as const, outcome: args.intent.outcome, terms: { pool_net: b(0), ante_net: ANTE_NET } };
      const core = buildSettlementCoreV1(JUNO_CODEC_V1, {
        ...args,
        bindings: args.bindings.map((s) => ({ chain_seat_index: s.chain_seat_index, player_id: s.player_id, payout_address: s.wallet })),
        intent,
      });
      expect([v.name, core.encoded_hex]).toEqual([v.name, certified.encoded_hex]);
      expect(core.settle.hex).toBe(certified.settle_digest);
    }
  });
});

/* ================================================================================================= */
/* D. v10 and v11 coexist, each bound to its own pin                                                 */
/* ================================================================================================= */

describe("D. coexistence: a v10 board settles under a v10 domain, a v11 board under a v11 domain, and never crosswise", () => {
  const v = (V10_PAYLOADS.payload_vectors as Loose[]).find((x) => x.name === "SYN-01-CLASSIC-BANKBREAK/terminal-BankBroken")!;
  const v11Args = v11ArgsFor(v);
  const v10Domain = (V10_PAYLOADS.domains as Loose[]).find((x) => x.name === v.domain_name)!;
  const v10Args: BuildSettlementPayloadArgs = { ...v11Args, board: { state: atPin(boards["SYN-01-CLASSIC-BANKBREAK"], 10) }, domain: v10Domain.domain, domain_inputs: inputsOf(v10Domain, 10) };

  it("both certified: the v10 build reproduces the frozen v10 vector byte for byte; the v11 build is accepted", () => {
    // [10, 11] at ESCROW-3A; 12 added by Route v12 R12-3's own certification (`settlementV12Certification.test.ts`).
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).toEqual([10, 11, 12]);
    expect(buildSettlementPayloadV1(v10Args).encoded_hex).toBe(v.encoded);
    expect(code(() => buildSettlementPayloadV1(v11Args))).toBe("OK");
  });

  it("crosswise is RULES_ENGINE_VERSION_MISMATCH: the domain's declared engine must be the board's pin", () => {
    expect(code(() => buildSettlementPayloadV1({ ...v11Args, board: v10Args.board }))).toBe("RULES_ENGINE_VERSION_MISMATCH");
    expect(code(() => buildSettlementPayloadV1({ ...v10Args, board: v11Args.board }))).toBe("RULES_ENGINE_VERSION_MISMATCH");
  });
});

/* ================================================================================================= */
/* E. Everything else fails closed; the certified list is a literal                                   */
/* ================================================================================================= */

describe("E. uncertified pins fail closed; the certified list is an explicit literal, never the gameplay engine", () => {
  const board = boards["SYN-01-CLASSIC-BANKBREAK"];
  const seats = seatsOf(["p2", "p1", "p3"]);

  it("the literal is explicit ([10, 11] at ESCROW-3A, [10, 11, 12] since R12-3); the gameplay axis is separate (a future bump is refused until certified)", () => {
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).toEqual([10, 11, 12]);
    expect(Object.isFrozen(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS)).toBe(true);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    const source = readFileSync(join(__dirname, "..", "gameEngine", "settlementAppraisal.ts"), "utf8");
    expect(source).toContain("SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS: readonly number[] = Object.freeze([10, 11, 12]);");
    // The appraisal module never reads the gameplay version: a bump cannot widen settlement by itself.
    expect(source).not.toMatch(/from\s+"\.\/rulesVersion"/);
  });

  it("9, 13, 999, 2^31 and RULES_ENGINE_VERSION + 1 are refused before a value is read (12 was, until R12-3 certified it)", () => {
    for (const pin of [9, 13, 999, 2 ** 31, RULES_ENGINE_VERSION + 1]) {
      expect(() => appraiseSeats(atPin(board, pin), seats)).toThrow(`UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=${pin} (supported: 10, 11, 12)`);
    }
  });

  it("a pin that is not a safe integer number is refused too ('11', 11.5, -11, null)", () => {
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: "11" } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: 11.5 } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: -11 } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: null } as never, seats))).toBe("UNPINNED_BOARD");
  });

  it("an uncertified domain on its own board (v13 since R12-3 certified 12) is refused by the builder's appraisal: no bytes are ever written for it", () => {
    const v = (V10_PAYLOADS.payload_vectors as Loose[])[0];
    const args = v11ArgsFor(v);
    const d13 = { ...(args.domain_inputs as SettlementDomainInputs), rules_engine_version: 13 };
    expect(code(() => buildSettlementPayloadV1({ ...args, board: { state: atPin(v11BoardOf(v), 13) }, domain: settlementDomainV1(d13), domain_inputs: d13 }))).toBe(
      "UNSUPPORTED_RULES_ENGINE_VERSION",
    );
  });
});

/* ================================================================================================= */
/* F. The SET-0A corpus parity sweep, at pin 11                                                     */
/* ================================================================================================= */

describe("F. SET-0A §14's parity sweep at the v11 pin: rankPlayers equals the appraiser on every corpus board", () => {
  const LOGS: Array<{ name: string; entries: () => ExportedEntry[]; boards: number }> = [
    { name: "golden/JUNO-7NZ", entries: () => readJsonl(join(FROZEN_LOG_DIR, "JUNO-7NZ.log.jsonl")), boards: 1 },
    { name: "golden/JUNO-G6J", entries: () => readJsonl(join(FROZEN_LOG_DIR, "JUNO-G6J.log.jsonl")), boards: 10 },
    { name: "golden/JUNO-CV4", entries: () => readJsonl(join(FROZEN_LOG_DIR, "JUNO-CV4.log.jsonl")), boards: 143 },
    { name: "prefix/JUNO-FCJ-96", entries: () => readJsonl(join(FIXTURES_DIR, "JUNO-FCJ-prefix96.log.jsonl")), boards: 93 },
    { name: "Z6C-through-494", entries: () => readExport(join(__dirname, "__fixtures__z6cLog.json")), boards: 492 },
  ];

  function sweep(entries: ExportedEntry[]): { boards: number; mismatches: string[]; refusals: string[] } {
    const out = { boards: 0, mismatches: [] as string[], refusals: [] as string[] };
    replayBoards(entries, (index, board) => {
      if (board.player_addresses.length === 0) return;
      out.boards += 1;
      const state = atPin(board, 11);
      try {
        const ranked = rankedWorth(state);
        for (const seat of appraiseSeats(state, seatsOf(board.player_addresses))) {
          if (ranked[seat.player_id] !== Number(seat.total.toString())) out.mismatches.push(`idx ${index} ${seat.player_id}`);
        }
      } catch (error) {
        if (!(error instanceof SettlementAppraisalError)) throw error;
        out.refusals.push(`idx ${index}: ${error.message}`);
      }
    });
    return out;
  }

  for (const log of LOGS) {
    it(`${log.name}: every board appraised at pin 11, 0 mismatches, 0 refusals`, () => {
      const result = sweep(log.entries());
      expect(result.boards).toBe(log.boards);
      expect(result.mismatches).toEqual([]);
      expect(result.refusals).toEqual([]);
    });
  }

  /* The owner's development corpus (`server/data`), when present -- as `settlementCorpusParity` sweeps it at pin 10. */
  const serverData = existsSync(SERVER_DATA_DIR) ? readdirSync(SERVER_DATA_DIR).filter((f) => f.endsWith(".log.jsonl")).sort() : [];
  if (serverData.length === 0) {
    it.skip("server/data: no logs in this checkout -- rerun on the owner's machine", () => undefined);
  }
  for (const file of serverData) {
    it(`server/${file}: parity at pin 11 on every board, 0 refusals`, () => {
      const result = sweep(readJsonl(join(SERVER_DATA_DIR, file)));
      expect(result.mismatches).toEqual([]);
      expect(result.refusals).toEqual([]);
    });
  }
});

/* ================================================================================================= */
/* G. The v11 certification vector file (generated, pinned) -- and the frozen v10 files, unmoved      */
/* ================================================================================================= */

describe("G. the v11 evidence file is exactly what the primitives generate; every frozen v10 file is byte-identical", () => {
  function generate(): unknown {
    return {
      format: "18JUNO/ESCROW3A/settlement-v11-certification/v1",
      rules_engine_version: 11,
      beside: "SET0A_golden_vectors_rev2.derived.json + settlementPayloadVectorsV1.json (v10, frozen; not rewritten)",
      source:
        "generated by frontend/src/utils/settlementV11Certification.test.ts: the thirteen SET-0A recipes run by the v11 reducer at pin 11 (settlementGoldenBoards.v11GoldenBoards), through the certified pipeline and builder",
      what_differs_from_v10:
        "terminal_state_hash_v1 (the pin is a board field); payload bytes [1,33) domain (u32 rules_engine_version is a domain input) and [91,123) appraisal_state_hash; hence the SETTLE and CONSENT digests. Nothing else: weights, payouts, dust, layout, codec, contract.",
      cases: V10_GOLDEN.cases.map((entry) => {
        const committed = appraiseCommittedState(canonicalStateText(boards[entry.name]), seatsOf(entry.seat_mapping));
        const weights = terminalSettlementWeights(committed.vector, { reason: entry.reason } as never, TERMS);
        const preview = payoutPreview(b(entry.pool_ujuno), weights);
        return {
          name: entry.name,
          reason: entry.reason,
          reason_code: SETTLEMENT_REASON_CODE[entry.reason],
          appraisal_state_hash: committed.appraisal_state_hash,
          v10_appraisal_state_hash: entry.terminal_state_hash_v1,
          seat_mapping: entry.seat_mapping.map((player_id, seat_index) => ({ seat_index, player_id })),
          settlement_weights: strings(weights),
          pool_ujuno: preview.pool.toString(),
          payouts_ujuno: strings(preview.payouts),
          dust_ujuno: preview.dust.toString(),
        };
      }),
      domains: V11_DOMAINS.map((d) => ({
        name: d.name,
        v10_domain_name: d.v10_name,
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
        v10_domain: d.v10_domain,
      })),
      payload_vectors: (V10_PAYLOADS.payload_vectors as Loose[]).map((v) => {
        const built = buildSettlementPayloadV1(v11ArgsFor(v));
        const preview = payoutPreview(b(v.pool_ujuno), built.payload.settlement_weights);
        return {
          name: v.name,
          source_case: v.source_case,
          usage: built.usage,
          domain_name: v11DomainFor(v.domain_name).name,
          seat_mapping: v.seat_mapping,
          payload: built.wire,
          encoded_len: built.encoded_hex.length / 2,
          encoded: built.encoded_hex,
          settle_digest: built.settle_digest,
          consent_digest: consentDigestV1(built.payload.domain, built.payload.seq, built.settle_digest),
          v10_differing_byte_ranges: [DOMAIN_BYTES, APPRAISAL_HASH_BYTES],
          pool_ujuno: preview.pool.toString(),
          payouts_ujuno: strings(preview.payouts),
          dust_ujuno: preview.dust.toString(),
        };
      }),
    };
  }

  it("settlementV11CertificationVectors.json is exactly what the primitives generate (UPDATE_SETTLEMENT_V11_VECTORS=1 rewrites it)", () => {
    const text = `${JSON.stringify(generate(), null, 1)}\n`;
    if (process.env.UPDATE_SETTLEMENT_V11_VECTORS === "1") writeFileSync(V11_FILE, text);
    expect(existsSync(V11_FILE)).toBe(true);
    expect(readFileSync(V11_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(text);
  });

  it("the v11 file names v11 alone; the frozen v10 payload files still name v10 alone", () => {
    const pins = (file: string) => new Set(Array.from(readFileSync(file, "utf8").matchAll(/"rules_engine_version":\s*(\d+)/g)).map((m) => Number(m[1])));
    expect(pins(V11_FILE)).toEqual(new Set([11]));
    expect(pins(join(SETTLEMENT, "settlementPayloadVectorsV1.json"))).toEqual(new Set([10]));
    const rust = join(REPO, "contracts", "escrow", "testdata", "payload_vectors_v1.json");
    if (existsSync(rust)) expect(pins(rust)).toEqual(new Set([10]));
  });

  it("every frozen v10 settlement file is byte-identical to its certified SHA-256 (LF-normalised)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require("crypto") as typeof import("crypto");
    for (const [file, sha] of FROZEN) {
      const path = join(REPO, file);
      if (!existsSync(path)) continue; // a checkout without contracts/ (never the owner's)
      const bytes = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      expect([file, createHash("sha256").update(bytes, "utf8").digest("hex")]).toEqual([file, sha]);
    }
  });
});
