/** @jest-environment node */
// frontend/src/utils/settlementV13Certification.test.ts
//
// ==================================================================
//  PHASE 3: THE DEDICATED RULES-v13 SETTLEMENT CERTIFICATION -- BESIDE v10, v11 AND v12, NEVER OVER THEM
// ==================================================================
//
// W3-K moved the gameplay engine to v13 (rules revision 2) and left settlement at [10, 11, 12] (two axes, DA-8). This
// file is the evidence pass `docs/phase3/V13_SETTLEMENT_CERTIFICATION_VECTORS.md` asks for: whether settlement may
// safely accept a rules-engine-v13 terminal board. It follows R12-3's architecture (`settlementV12Certification.test.ts`)
// and adds what v12 did not need: v13 changes WHICH TERMINAL BOARDS EXIST (the automatic bankruptcy and its liquidation,
// the window, the private-funding relevance, the atomic portfolio), so the v13 terminals are reached by GAMEPLAY -- every
// vector a constructed, named starting board played through the same `RoomSession` a server runs (ingress, reducer,
// derived entries), its terminal produced by `RoomEngine` and never edited -- and appraised by three readers that share
// no code: the certified appraiser, `rankPlayers` and an independent oracle (below, and in Python beside the fixture).
//
// THE SET-0A AUDIT, RERUN AGAINST v13. The appraiser reads only `rules_engine_version, player_addresses, player_cash,
// public_companies[].{company_id, ticker, player_holdings, ipo_pool_percentage, bank_pool_percentage, par_value},
// market_positions, private_companies[].{private_id, closed, owner, owner_protocol_id, cost}, bankrupt_president,
// current_round_type`. Row 13 of the rules changelog names what v13 changed, all under rules revision 2:
//   (1) OD-2 -- one `PassTurn` ends a Stock Round turn: WHICH message sequences end a turn. No field's meaning moves.
//   (2) SBS-3 / SBS-4 -- the Brown Bank Pool continuation (`brown_pool_continuation_company`, closed by any accepted turn
//       action of the active player): WHICH purchases are legal. A certificate bought is still a holding row, priced
//       and conserved as before; the continuation field is not read.
//   (3) OD-4 -- automatic emergency funding: the window, the automatic purchase, the one atomic `EmergencySellPortfolio`,
//       private funding relevant only on an exact legal path, and the AUTOMATIC BANKRUPTCY, which liquidates every
//       legally saleable share (each an ordinary sale: price drops, the Bank Pool cap, presidencies) and hands the
//       president's whole cash to the obligated corporation before `GameEnd`. What this changes on a terminal board:
//       holdings, Bank Pool percentages and prices (by ordinary sales), one treasury (not read), the bankrupt's cash
//       (counted 0 for the bankrupt anyway), and a new `bankruptcy_record` (not read; hashed). `bankrupt_president`
//       still means exactly 6.6.3's bankrupt president, scored by the shares he could not sell -- the meaning SET-0A v3
//       certified. No field the appraiser reads changes MEANING.
// So the formula is unchanged and still the correct reading of a v13 board, and v13 boards differ from v12 ones through
// those channels only. The vectors (G) show it on real turns, including every bankruptcy shape the spec requires.
//
// THE LITERAL, AND HOW THIS FILE IS GREEN ON BOTH SIDES OF IT. The evidence is built WITHOUT the certified list's
// consent: the appraiser reads `rules_engine_version` in its pin gate and nowhere else, so a v13 board's appraisal is
// the certified appraiser's answer on the same board with the pin token read as 12 (section B proves the two canonical
// texts differ in that one token), and the payload bytes are composed from the certified primitives (the domain over
// the u32 rules engine 13, `terminal_state_hash_v1` of the pin-13 board, the codec). `EXPECTED_SETTLEMENT_LITERAL`
// below names the literal this file expects. While it is [10, 11, 12] every production path (the appraiser, the
// builder, the conformance verifier, the GNOLAND core, the browser's re-derivation) must REFUSE a v13 board; once the
// literal commit adds 13, the same paths must reproduce the pinned evidence byte for byte. Nothing pinned moves.
//
// THE EVIDENCE BELOW:
//   A. the v13 golden set (the thirteen SET-0A recipes through the v13 engine, at pin 13): re-stamped at 10, 11 and 12
//      each is its certified board; what each recipe IS under v13 is stated (revision 0 histories, not v13 ones);
//   B. the pin-independence of the appraisal, and every SET-0A vector, component, payout and dust value at pin 13;
//   C. the fifteen SET-0C payloads at five v13 domains: v10's / v11's / v12's bytes outside [1,33) and [91,123);
//   D. v10, v11, v12 and v13 coexist, each board settling only under a domain declaring its own pin;
//   E. every uncertified pin fails closed; the certified list is a literal;
//   F. SET-0A §14's parity sweep at pin 13 on every board of the five in-repo logs;
//   G. THE v13 VECTORS (`settlementV13Vectors.ts`): V13-01 ... V13-21, twenty-five terminals reached by play, each
//      appraised three ways, its integer payouts, its payload, its determinism (live, cold restore, replay, snapshot,
//      RevertTo) and the rule it pins; the v12-log refusal; v13 round-boundary checkpoints;
//   H. the v13 evidence files are exactly what the primitives generate; every frozen v10 file and the v11 and v12
//      evidence files are byte-identical.
//
// The v13 values are pinned in `__fixtures__/settlement/settlementV13CertificationVectors.json` and the terminal boards'
// canonical text in `__fixtures__/settlement/settlementV13TerminalBoards.json`, both GENERATED by this file
// (`UPDATE_SETTLEMENT_V13_VECTORS=1` rewrites them) -- new files beside the frozen ones, none rewritten -- and re-derived
// independently by `__fixtures__/settlement/verify_v13_settlement_vectors.py`.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS,
  SettlementAppraisalError,
  appraiseSeats,
  type SeatAppraisal,
  type SettlementSeat,
} from "../gameEngine/settlementAppraisal";
import {
  SettlementPayloadError,
  buildSettlementPayloadV1,
  checkSettlementPayloadV1,
  consentDigestV1,
  decodeSettlementPayloadV1,
  encodeSettlementPayloadV1Hex,
  hexToBytes,
  settleDigestV1,
  settlementDomainV1,
  settlementPayloadToWire,
  SETTLEMENT_PAYLOAD_KIND,
  SETTLEMENT_PAYLOAD_REASON,
  type BuildSettlementPayloadArgs,
  type SettlementDomainInputs,
  type SettlementPayloadIntent,
  type SettlementPayloadV1,
} from "../gameEngine/settlementPayload";
import { verifySettlementPayloadV1 } from "../gameEngine/settlementConformance";
import { canonicalStateText, terminalStateHashV1 } from "../gameEngine/settlementDigest";
import { terminalSettlementWeights, SETTLEMENT_REASON_CODE, type TerminalReason } from "../gameEngine/settlementPolicy";
import { payoutPreview } from "../gameEngine/settlementPreview";
import { buildSettlementCoreV1 } from "../gameEngine/escrow/settlementCoreV1";
import { JUNO_CODEC_V1 } from "../gameEngine/escrow/junoCodecV1";
import { rankPlayers } from "../gameEngine/endgame";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS, RULES_ENGINE_VERSION_FIELD, replayCompatibility, replayRefusal, SERVER_REPLAY_POLICY } from "../gameEngine/rulesVersion";
import { RoomEngine, replayLog } from "../gameEngine/replayLog";
import { emergencyFundingFor, emergencyPortfolioRefusal, fundedTradeRefusal } from "../gameEngine/emergencyFunding";
import { trainSaleRefusal } from "../gameEngine/trainSaleAuthority";
import { derivedEntryKey, nextDerivedAction } from "../gameEngine/derivedActions";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { marketCellForPrice, marketZoneForPrice, projectShareSaleMove } from "../gameEngine/marketGeometry";
import { stateDigest } from "../gameEngine/stateDigest";
import { logHash } from "../gameEngine/logHash";
import { STANDARD_VARIANTS } from "../gameEngine/gameVariants";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { ExportedEntry } from "../gameEngine/replayLog";
import { checkTerminalSettlement, replaySealedPrefix } from "../money/settlementCheck";
import {
  FIXTURES_DIR,
  FROZEN_LOG_DIR,
  SERVER_DATA_DIR,
  SET0A_CERTIFIED_RULES_ENGINE_VERSION,
  SET0A_V11_RULES_ENGINE_VERSION,
  SET0A_V12_RULES_ENGINE_VERSION,
  SET0A_V13_RULES_ENGINE_VERSION,
  V13_RECIPE_HISTORY,
  atV13SettlementPin,
  readExport,
  readJsonl,
  replayBoards,
  v13GoldenBoards,
} from "./settlementGoldenBoards";
import {
  BO,
  CA,
  CO,
  CPR,
  CSL,
  DH,
  MH,
  NYC,
  P1,
  P2,
  P3,
  PRR,
  SV,
  bankruptcyProofBoard,
  boardAfter,
  crashRestart,
  determinismOf,
  restoredBoard,
  v13Vectors,
  type DeterminismEvidence,
  type VectorGame,
} from "./settlementV13Vectors";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import * as GR from "./gentleRustCertificationGame";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SETTLEMENT = join(__dirname, "__fixtures__", "settlement");
const REPO = join(__dirname, "..", "..", "..");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const b = (value: string | number | bigint) => BigInt(value);
const strings = (values: readonly bigint[]) => values.map((value) => value.toString());
const seatsOf = (ids: readonly string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));
const atPin = (board: GameStateResponse, pin: number) => ({ ...board, rules_engine_version: pin }) as GameStateResponse;

/* ------------------------------------------------------------------ */
/* The literal this evidence expects                                   */
/* ------------------------------------------------------------------ */

/** The certified literal this file expects. The evidence commits: [10, 11, 12] (v13 PENDING). The literal commit adds
 *  13 to `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS`; the commit after it re-pins this expectation. */
const EXPECTED_SETTLEMENT_LITERAL: readonly number[] = [10, 11, 12];
/** Whether the production paths admit a v13 board -- read off the real literal, never assumed. */
const V13_ADMITTED = SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS.includes(13);
const UNSUPPORTED_13 = `UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=13 (supported: ${SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS.join(", ")})`;

/* The frozen v10 evidence and the v11 / v12 certification evidence -- READ, never written. */
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
const V11 = readJson(V11_FILE) as Loose;
const V12_FILE = join(SETTLEMENT, "settlementV12CertificationVectors.json");
const V12 = readJson(V12_FILE) as Loose;
const V13_FILE = join(SETTLEMENT, "settlementV13CertificationVectors.json");
const V13_BOARDS_FILE = join(SETTLEMENT, "settlementV13TerminalBoards.json");

/* Frozen files this certification must never move, by content hash (LF-normalised): PROJECT_CANONICAL_CONTEXT §D.4's
   five v10 files, ESCROW-3A's v11 evidence file and R12-3 / R12-4's v12 evidence file. */
const FROZEN = [
  ["contracts/escrow/testdata/payload_vectors_v1.json", "635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac"],
  ["frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json", "b58651de13de2c4f91d355c15cca92689001ba4bcbdb2a9fbaa348cbe6a7906c"],
  ["contracts/escrow/testdata/set0a_payout_vectors_rev2.json", "dfe9fbdfa8f88c21bd5cc8eeecbd06f0ef7db4ce6ba8bf72aa4633b7a39d4994"],
  ["frontend/src/utils/__fixtures__/settlement/SET0A_golden_vectors_rev2.derived.json", "c16fb8170d38a6b6870d0e39091337d82d89fc2a54bb29f41b98cc98a5c7721a"],
  ["frontend/src/utils/__fixtures__/settlement/settlementCrossLanguageVectors.json", "50bf34e1374767df4e3273198cfe6537ba7f73fefd51d9a437b0f113c3015d74"],
  ["frontend/src/utils/__fixtures__/settlement/settlementV11CertificationVectors.json", "cf62e6d775a46093039d5c2a1c6137934d3ac594ac702b8c27ee538090c80692"],
  ["frontend/src/utils/__fixtures__/settlement/settlementV12CertificationVectors.json", "f65726adf333141c10088415b74c5b330eb446f5ebe0acfb61a141dee70a7ef5"],
] as const;

const { boards, dealtPins, syn01Submissions } = v13GoldenBoards();
const ANTE_NET = b(V10_GOLDEN.ante.ante_net_ujuno);
const TERMS = { pool_net_ujuno: b(0), ante_net_ujuno: ANTE_NET };
const SYN05 = (V10_PAYLOADS.payload_vectors as Loose[]).find((x) => x.name === "SYN-05-Z6C-COMPOSED-END/terminal-BankBroken")!;

function code(run: () => unknown): string {
  try {
    run();
    return "OK";
  } catch (error) {
    if (error instanceof SettlementPayloadError || error instanceof SettlementAppraisalError) return error.code;
    throw error;
  }
}

function rankedWorth(state: GameStateResponse): Record<string, { netWorth: number; rank: number }> {
  const marks = (state.market_positions ?? {}) as Record<number, { price: number } | null>;
  const out: Record<string, { netWorth: number; rank: number }> = {};
  for (const row of rankPlayers({ state, priceForCompany: (id) => marks[id]?.price ?? null, labelForAddress: (address) => address, bankruptAddress: state.bankrupt_president ?? null })) {
    out[row.address] = { netWorth: row.netWorth, rank: row.rank };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The pin-independent v13 appraisal, and an oracle that shares no code */
/* ------------------------------------------------------------------ */

/** The certified appraiser's reading of a pin-13 board WITHOUT the certified list's consent: the same canonical bytes but
 *  the pin token read as 12 (proved below to be the only difference), then -- once 13 is admitted -- the direct
 *  appraisal, which must be the same answer. Before that, the direct appraisal must refuse. */
function appraiseV13(board: GameStateResponse, seats: readonly SettlementSeat[]): readonly SeatAppraisal[] {
  expect(board.rules_engine_version).toBe(13);
  const text13 = canonicalStateText(board);
  expect(text13.split('"rules_engine_version":13').length).toBe(2);
  expect(text13.replace('"rules_engine_version":13', '"rules_engine_version":12')).toBe(canonicalStateText(atPin(board, 12)));
  const viaPin12 = appraiseSeats(atPin(board, 12), seats);
  if (V13_ADMITTED) {
    expect(appraiseSeats(board, seats)).toEqual(viaPin12);
  } else {
    expect(() => appraiseSeats(board, seats)).toThrow(UNSUPPORTED_13);
  }
  return viaPin12;
}

/** AN INDEPENDENT ORACLE: NW(p) written from the rulebook's sentence and SET-0A §4, reading the board's raw fields with
 *  no validation and no shared helper -- cash + Σ (pct / 10) × price for a parred corporation + Σ face of the open
 *  privates the player owns; for the bankrupt president the share term alone (6.6.3). */
function oracleNetWorth(board: GameStateResponse, seats: readonly SettlementSeat[]): Array<{ player_id: string; cash: bigint; shares: bigint; privates: bigint; total: bigint }> {
  const raw = JSON.parse(canonicalStateText(board)) as Loose;
  return seats.map(({ player_id }) => {
    const bankrupt = raw.bankrupt_president === player_id;
    const cashRow = (raw.player_cash as Loose[]).find((row) => row.player === player_id);
    const cash = bankrupt ? b(0) : b(cashRow?.cash_vgp ?? "0");
    let shares = b(0);
    for (const company of raw.public_companies as Loose[]) {
      if (company.par_value === null || company.par_value === undefined) continue;
      const price = b((raw.market_positions as Loose)[String(company.company_id)].price);
      for (const holding of company.player_holdings as Loose[]) if (holding.player === player_id) shares += (b(holding.percentage) / b(10)) * price;
    }
    let privates = b(0);
    if (!bankrupt) for (const priv of raw.private_companies as Loose[]) if (!priv.closed && priv.owner === player_id) privates += b(priv.cost);
    return { player_id, cash, shares, privates, total: cash + shares + privates };
  });
}

/** floor(pool · w_i / Σw) and the dust, recomputed here in BigInt (no shared code with `payoutPreview`). */
function oraclePayouts(pool: bigint, weights: readonly bigint[]): { payouts: bigint[]; dust: bigint } {
  const sum = weights.reduce((acc, w) => acc + w, b(0));
  const payouts = weights.map((w) => (pool * w) / sum);
  return { payouts, dust: pool - payouts.reduce((acc, p) => acc + p, b(0)) };
}

/* ------------------------------------------------------------------ */
/* The v13 domains: SET-0C's five domains, the rules engine set to 13   */
/* ------------------------------------------------------------------ */

interface V13Domain {
  name: string;
  v10_name: string;
  wallets: string[];
  inputs: SettlementDomainInputs;
  domain: string;
  v10_domain: string;
  v11_domain: string;
  v12_domain: string;
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

const V13_DOMAINS: V13Domain[] = (V10_PAYLOADS.domains as Loose[]).map((d) => {
  const inputs = inputsOf(d, SET0A_V13_RULES_ENGINE_VERSION);
  const v11 = (V11.domains as Loose[]).find((x) => x.v10_domain_name === d.name)!;
  const v12 = (V12.domains as Loose[]).find((x) => x.v10_domain_name === d.name)!;
  return { name: `${d.name}/rules-v13`, v10_name: d.name, wallets: d.roster_wallets, inputs, domain: settlementDomainV1(inputs), v10_domain: d.domain, v11_domain: v11.domain, v12_domain: v12.domain };
});
const v13DomainFor = (v10Name: string) => V13_DOMAINS.find((d) => d.v10_name === v10Name)!;
const v13DomainForSeats = (n: number) => V13_DOMAINS.find((d) => d.wallets.length === n)!;
const atDomainPin = (d: V13Domain, pin: number) => {
  const inputs = { ...d.inputs, rules_engine_version: pin };
  return { ...d, inputs, domain: settlementDomainV1(inputs) };
};

const REASON_NAME: Record<number, "BankBroken" | "Bankruptcy" | "ResolverCorrection"> = { 1: "BankBroken", 2: "Bankruptcy", 5: "ResolverCorrection" };
const DOMAIN_BYTES: readonly [number, number] = [1, 33];
const APPRAISAL_HASH_BYTES: readonly [number, number] = [91, 123];

function differingOffsets(aHex: string, bHex: string): number[] {
  const a = hexToBytes(aHex);
  const c = hexToBytes(bHex);
  expect(a.length).toBe(c.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== c[i]) out.push(i);
  return out;
}
const onlyPinBytes = (offsets: readonly number[]) =>
  offsets.every((at) => (at >= DOMAIN_BYTES[0] && at < DOMAIN_BYTES[1]) || (at >= APPRAISAL_HASH_BYTES[0] && at < APPRAISAL_HASH_BYTES[1]));

/* ------------------------------------------------------------------ */
/* The composed v13 payload (the certified primitives, no gate)        */
/* ------------------------------------------------------------------ */

interface ComposedPayload {
  payload: SettlementPayloadV1;
  encoded_hex: string;
  settle_digest: string;
  consent_digest: string;
}

/** A v13 payload composed from the certified primitives: the domain over rules 13, `terminal_state_hash_v1` of the
 *  pin-13 board, the weights from the pin-independent appraisal and the policy, the codec. It is what
 *  `buildSettlementPayloadV1` writes for the same arguments once 13 is certified -- asserted wherever it is admitted. */
function composeV13(args: BuildSettlementPayloadArgs): ComposedPayload {
  const board = (args.board as { state: GameStateResponse }).state;
  expect(settlementDomainV1(args.domain_inputs)).toBe(args.domain);
  expect(args.domain_inputs.rules_engine_version).toBe(board.rules_engine_version);
  const seats = args.bindings.map((binding) => ({ seat_index: binding.chain_seat_index, player_id: binding.player_id }));
  const vector = appraiseV13(board, seats).map((seat) => seat.total);
  const intent = args.intent;
  const terminal = intent.kind === "Terminal";
  const weights = intent.kind === "Terminal" ? terminalSettlementWeights(vector, intent.outcome, TERMS) : vector;
  const kind = terminal ? SETTLEMENT_PAYLOAD_KIND.Terminal : SETTLEMENT_PAYLOAD_KIND.Checkpoint;
  const reason = intent.kind === "Terminal" ? SETTLEMENT_REASON_CODE[intent.outcome.reason] : SETTLEMENT_PAYLOAD_REASON.RoundBoundary;
  const payload: SettlementPayloadV1 = {
    version: 1,
    domain: args.domain,
    seq: b(2) * args.log_len + b(kind),
    kind,
    reason,
    log_len: args.log_len,
    log_hash: args.log_hash,
    appraisal_log_len: args.appraisal_log_len,
    appraisal_state_hash: terminalStateHashV1(board),
    state_schema_version: args.state_schema_version,
    seat_count: weights.length,
    settlement_weights: weights.slice(),
    signer_key_id: args.signer_key_id,
    issued_at: args.issued_at,
  };
  checkSettlementPayloadV1(payload, terminal ? (reason === SETTLEMENT_PAYLOAD_REASON.ResolverCorrection ? "ResolverReplace" : "Settle") : "Checkpoint");
  const encoded_hex = encodeSettlementPayloadV1Hex(payload);
  const settle_digest = settleDigestV1(payload);
  return { payload, encoded_hex, settle_digest, consent_digest: consentDigestV1(payload.domain, payload.seq, settle_digest) };
}

/** Once 13 is admitted the production builder writes the composed bytes; before, it refuses the v13 board. */
function expectBuilderAgrees(args: BuildSettlementPayloadArgs, composed: ComposedPayload): void {
  if (V13_ADMITTED) {
    const built = buildSettlementPayloadV1(args);
    expect(built.encoded_hex).toBe(composed.encoded_hex);
    expect(built.settle_digest).toBe(composed.settle_digest);
    expect(built.payload).toEqual(decodeSettlementPayloadV1(hexToBytes(composed.encoded_hex)));
    const usage = built.usage;
    const verified = verifySettlementPayloadV1(built.payload, built.canonical_text, built.seats, TERMS, usage);
    expect(verified.settle_digest).toBe(composed.settle_digest);
  } else {
    expect(code(() => buildSettlementPayloadV1(args))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    const board = (args.board as { state: GameStateResponse }).state;
    const seats = args.bindings.map((binding) => ({ seat_index: binding.chain_seat_index, player_id: binding.player_id }));
    expect(code(() => verifySettlementPayloadV1(decodeSettlementPayloadV1(hexToBytes(composed.encoded_hex)), canonicalStateText(board), seats, TERMS))).toBe(
      "UNSUPPORTED_RULES_ENGINE_VERSION",
    );
  }
}

/* ------------------------------------------------------------------ */
/* The v13 SET-0C payloads                                              */
/* ------------------------------------------------------------------ */

const v13BoardOf = (v: Loose): GameStateResponse =>
  String(v.source_case).startsWith("GR-4") ? atV13SettlementPin(GR.certificationStart()) : boards[v.source_case];

function v13ArgsFor(v: Loose): BuildSettlementPayloadArgs {
  const d = v13DomainFor(v.domain_name);
  const p = v.payload;
  const intent: SettlementPayloadIntent =
    p.kind === 0 ? { kind: "Checkpoint" } : { kind: "Terminal", outcome: { reason: REASON_NAME[p.reason] }, terms: TERMS };
  const mapping = v.seat_mapping as Array<{ chain_seat_index: number; player_id: string }>;
  return {
    board: { state: v13BoardOf(v) },
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

/* ================================================================================================= */
/* A. The v13 golden set                                                                            */
/* ================================================================================================= */

describe("A. the v13 golden set: the SET-0A recipes through the v13 engine, at pin 13, each its certified v10, v11 and v12 board but for the pin", () => {
  it("covers exactly the thirteen SET-0A cases; SYN-01 reaches GameEnd in the recorded 20 submissions", () => {
    expect(Object.keys(boards).sort()).toEqual(V10_GOLDEN.cases.map((entry) => entry.name).sort());
    expect(syn01Submissions).toBe(20);
  });

  it("the room-dealt recipes are dealt by the v13 engine (pin 13, revision 0); every board carries pin 13", () => {
    expect([SET0A_CERTIFIED_RULES_ENGINE_VERSION, SET0A_V11_RULES_ENGINE_VERSION, SET0A_V12_RULES_ENGINE_VERSION, SET0A_V13_RULES_ENGINE_VERSION]).toEqual([10, 11, 12, 13]);
    expect(RULES_ENGINE_VERSION).toBe(13);
    expect(Object.values(dealtPins)).toEqual([13, 13, 13]);
    for (const board of Object.values(boards)) expect(board.rules_engine_version).toBe(13);
    // Revision 0: none of v13's revision-2 corrections is in force on these histories (the vectors in G are revision 2).
    for (const name of Object.keys(dealtPins)) expect((boards[name].variants as Loose).rules ?? 0).toBe(0);
  });

  it("what each recipe IS under v13 is stated: nine revision-0 room games (seven grafted), four pre-v12 corpus replays", () => {
    expect(Object.keys(V13_RECIPE_HISTORY).sort()).toEqual(Object.keys(boards).sort());
    const count = (kind: string) => Object.values(V13_RECIPE_HISTORY).filter((entry) => entry === kind).length;
    expect([count("v13-room-game-revision-0"), count("v13-room-game-revision-0+graft"), count("pre-v12-corpus-replay+graft")]).toEqual([2, 7, 4]);
  });

  for (const entry of V10_GOLDEN.cases) {
    it(`${entry.name}: at 10, 11 and 12 it IS the certified board; at 13 only the pin differs`, () => {
      const v13 = boards[entry.name];
      expect(v13.current_round_type).toBe("GameEnd");
      expect(v13.player_addresses).toEqual(entry.turn_order);
      expect(terminalStateHashV1(atPin(v13, 10))).toBe(entry.terminal_state_hash_v1);
      expect(terminalStateHashV1(atPin(v13, 11))).toBe((V11.cases as Loose[]).find((x) => x.name === entry.name)!.appraisal_state_hash);
      const v12Case = (V12.cases as Loose[]).find((x) => x.name === entry.name)!;
      expect(terminalStateHashV1(atPin(v13, 12))).toBe(v12Case.appraisal_state_hash);
      const text13 = canonicalStateText(v13);
      expect(text13.split('"rules_engine_version":13').length).toBe(2);
      expect(text13.replace('"rules_engine_version":13', '"rules_engine_version":12')).toBe(canonicalStateText(atPin(v13, 12)));
    });
  }
});

/* ================================================================================================= */
/* B. The appraisal at pin 13: pin-independent, and every SET-0A value unchanged                     */
/* ================================================================================================= */

describe("B. the appraisal reads the pin in its gate alone: the golden boards at pin 13 give exactly SET-0A rev 2's vectors, components, payouts and dust", () => {
  it("the appraisal source reads `rules_engine_version` in exactly one place: the pin gate", () => {
    const source = readFileSync(join(__dirname, "..", "gameEngine", "settlementAppraisal.ts"), "utf8");
    const reads = Array.from(source.matchAll(/own\(state, "rules_engine_version"\)/g));
    expect(reads).toHaveLength(1);
    expect(source).toMatch(/function checkPin\(state: Record<string, unknown>\): void \{\n  const version = own\(state, "rules_engine_version"\);/);
    expect(source.match(/rules_engine_version/g)!.length).toBeLessThanOrEqual(4); // the gate, its message, and comments
  });

  for (const entry of V10_GOLDEN.cases) {
    it(entry.name, () => {
      const board = boards[entry.name];
      const seats = seatsOf(entry.seat_mapping);
      const appraisals = appraiseV13(board, seats);
      expect(strings(appraisals.map((seat) => seat.total))).toEqual(entry.vector);
      appraisals.forEach((seat, index) => {
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
      });
      const oracle = oracleNetWorth(board, seats);
      expect(oracle.map((row) => row.total.toString())).toEqual(entry.vector);
      const weights = terminalSettlementWeights(appraisals.map((seat) => seat.total), { reason: entry.reason } as never, TERMS);
      const preview = payoutPreview(b(entry.pool_ujuno), weights);
      expect(strings(preview.payouts)).toEqual(entry.payouts_ujuno);
      expect(preview.dust.toString()).toBe(entry.dust_ujuno);
      const ranked = rankedWorth(board);
      for (const seat of appraisals) expect(ranked[seat.player_id].netWorth).toBe(Number(seat.total.toString()));
    });
  }
});

/* ================================================================================================= */
/* C. Payload bytes: same codec, same layout; the domain and the appraisal hash are the only moves   */
/* ================================================================================================= */

describe("C. the fifteen SET-0C payloads at v13: identical to the frozen v10 bytes and the v11 / v12 certifications' outside `domain` and `appraisal_state_hash`", () => {
  it("the v13 domains are SET-0C's five with only the u32 rules engine changed -- and it moves each domain off v10's, v11's and v12's", () => {
    expect(V13_DOMAINS).toHaveLength(5);
    for (const d of V13_DOMAINS) {
      const v10 = (V10_PAYLOADS.domains as Loose[]).find((x) => x.name === d.v10_name)!;
      expect(settlementDomainV1(inputsOf(v10, 10))).toBe(v10.domain);
      expect(settlementDomainV1(inputsOf(v10, 11))).toBe(d.v11_domain);
      expect(settlementDomainV1(inputsOf(v10, 12))).toBe(d.v12_domain);
      expect(new Set([d.domain, d.v10_domain, d.v11_domain, d.v12_domain]).size).toBe(4);
      expect(d.domain).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  for (const v of V10_PAYLOADS.payload_vectors as Loose[]) {
    it(`${v.name}: v13 bytes = v10 = v11 = v12 bytes except [1,33) domain and [91,123) appraisal_state_hash; same weights, payouts, dust`, () => {
      const args = v13ArgsFor(v);
      const composed = composeV13(args);
      expect(composed.encoded_hex.length / 2).toBe(v.encoded_len);
      const v11 = (V11.payload_vectors as Loose[]).find((x) => x.name === v.name)!;
      const v12 = (V12.payload_vectors as Loose[]).find((x) => x.name === v.name)!;
      for (const other of [v.encoded, v11.encoded, v12.encoded]) {
        const differ = differingOffsets(composed.encoded_hex, other);
        expect(differ.length).toBeGreaterThan(0);
        expect(onlyPinBytes(differ)).toBe(true);
      }
      expect(composed.payload.domain).toBe(v13DomainFor(v.domain_name).domain);
      expect(composed.payload.appraisal_state_hash).toBe(terminalStateHashV1(v13BoardOf(v)));
      const { domain: _d, appraisal_state_hash: _h, ...rest13 } = settlementPayloadToWire(composed.payload) as Loose;
      const { domain: _d10, appraisal_state_hash: _h10, ...rest10 } = v.payload as Loose;
      void _d;
      void _h;
      void _d10;
      void _h10;
      expect(rest13).toEqual(rest10);
      expect(new Set([composed.settle_digest, v.settle_digest, v11.settle_digest, v12.settle_digest]).size).toBe(4);
      expect(decodeSettlementPayloadV1(hexToBytes(composed.encoded_hex))).toEqual(composed.payload);
      const preview = payoutPreview(b(v.pool_ujuno), composed.payload.settlement_weights);
      expect(strings(preview.payouts)).toEqual(v.payouts_ujuno);
      expect(preview.dust.toString()).toBe(v.dust_ujuno);
      expectBuilderAgrees(args, composed);
    });
  }

  it("the chain-neutral core (GNOLAND-1) with the certified Juno codec: the identical v13 bytes once admitted, a refusal before", () => {
    for (const v of V10_PAYLOADS.payload_vectors as Loose[]) {
      const args = v13ArgsFor(v);
      const intent = args.intent.kind === "Checkpoint" ? args.intent : { kind: "Terminal" as const, outcome: args.intent.outcome, terms: { pool_net: b(0), ante_net: ANTE_NET } };
      const run = () =>
        buildSettlementCoreV1(JUNO_CODEC_V1, {
          ...args,
          bindings: args.bindings.map((s) => ({ chain_seat_index: s.chain_seat_index, player_id: s.player_id, payout_address: s.wallet })),
          intent,
        });
      if (V13_ADMITTED) {
        const core = run();
        expect([v.name, core.encoded_hex]).toEqual([v.name, composeV13(args).encoded_hex]);
      } else {
        expect([v.name, code(run)]).toEqual([v.name, "UNSUPPORTED_RULES_ENGINE_VERSION"]);
      }
    }
  });
});

/* ================================================================================================= */
/* D. v10, v11, v12 and v13 coexist, each bound to its own pin                                       */
/* ================================================================================================= */

describe("D. coexistence: each board settles under a domain declaring its own pin, and never crosswise", () => {
  const v = (V10_PAYLOADS.payload_vectors as Loose[]).find((x) => x.name === "SYN-01-CLASSIC-BANKBREAK/terminal-BankBroken")!;
  const v13Args = v13ArgsFor(v);
  const v10Domain = (V10_PAYLOADS.domains as Loose[]).find((x) => x.name === v.domain_name)!;
  const argsAt = (pin: number): BuildSettlementPayloadArgs => {
    const inputs = inputsOf(v10Domain, pin);
    return { ...v13Args, board: { state: atPin(boards["SYN-01-CLASSIC-BANKBREAK"], pin) }, domain: settlementDomainV1(inputs), domain_inputs: inputs };
  };

  it("v10 reproduces the frozen v10 vector, v11 the v11 certification's, v12 the v12 certification's; v13 composes (and builds once admitted)", () => {
    expect(buildSettlementPayloadV1(argsAt(10)).encoded_hex).toBe(v.encoded);
    expect(buildSettlementPayloadV1(argsAt(11)).encoded_hex).toBe((V11.payload_vectors as Loose[]).find((x) => x.name === v.name)!.encoded);
    expect(buildSettlementPayloadV1(argsAt(12)).encoded_hex).toBe((V12.payload_vectors as Loose[]).find((x) => x.name === v.name)!.encoded);
    expectBuilderAgrees(argsAt(13), composeV13(v13Args));
  });

  it("every crosswise pair is RULES_ENGINE_VERSION_MISMATCH -- a v13 board is refused UNSUPPORTED first while 13 is not admitted", () => {
    for (const boardPin of [10, 11, 12, 13]) {
      for (const domainPin of [10, 11, 12, 13]) {
        if (boardPin === domainPin) continue;
        const args = { ...argsAt(domainPin), board: argsAt(boardPin).board };
        const want = boardPin === 13 && !V13_ADMITTED ? "UNSUPPORTED_RULES_ENGINE_VERSION" : "RULES_ENGINE_VERSION_MISMATCH";
        expect([boardPin, domainPin, code(() => buildSettlementPayloadV1(args))]).toEqual([boardPin, domainPin, want]);
      }
    }
  });
});

/* ================================================================================================= */
/* E. Everything else fails closed; the certified list is a literal                                   */
/* ================================================================================================= */

describe("E. uncertified pins fail closed; the certified list is an explicit literal, never the gameplay engine", () => {
  const board = boards["SYN-01-CLASSIC-BANKBREAK"];
  const seats = seatsOf(["p2", "p1", "p3"]);

  it("the literal is exactly EXPECTED_SETTLEMENT_LITERAL, frozen, a source literal; the gameplay axis is separate", () => {
    expect([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS]).toEqual([...EXPECTED_SETTLEMENT_LITERAL]);
    expect(Object.isFrozen(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS)).toBe(true);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    const source = readFileSync(join(__dirname, "..", "gameEngine", "settlementAppraisal.ts"), "utf8");
    expect(source).toContain(`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS: readonly number[] = Object.freeze([${EXPECTED_SETTLEMENT_LITERAL.join(", ")}]);`);
    expect(source).not.toMatch(/from\s+"\.\/rulesVersion"/);
  });

  it("9, 14, 15, 999, 2^31 and RULES_ENGINE_VERSION + 1 are refused before a value is read (and 13 too while it is not admitted)", () => {
    const pins = [9, 14, 15, 999, 2 ** 31, RULES_ENGINE_VERSION + 1, ...(V13_ADMITTED ? [] : [13])];
    for (const pin of pins) {
      expect(() => appraiseSeats(atPin(board, pin), seats)).toThrow(`UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=${pin} (supported: ${EXPECTED_SETTLEMENT_LITERAL.join(", ")})`);
    }
  });

  it("a pin that is not a safe integer number is refused too ('13', 13.5, -13, null)", () => {
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: "13" } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: 13.5 } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: -13 } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: null } as never, seats))).toBe("UNPINNED_BOARD");
  });

  it("a v14 domain on a v14 board is refused by the builder's appraisal: no bytes are ever written for it", () => {
    const v = (V10_PAYLOADS.payload_vectors as Loose[])[0];
    const args = v13ArgsFor(v);
    const d14 = { ...(args.domain_inputs as SettlementDomainInputs), rules_engine_version: 14 };
    expect(code(() => buildSettlementPayloadV1({ ...args, board: { state: atPin(v13BoardOf(v), 14) }, domain: settlementDomainV1(d14), domain_inputs: d14 }))).toBe(
      "UNSUPPORTED_RULES_ENGINE_VERSION",
    );
  });
});

/* ================================================================================================= */
/* F. The SET-0A corpus parity sweep, at pin 13                                                     */
/* ================================================================================================= */

describe("F. SET-0A §14's parity sweep at the v13 pin: rankPlayers equals the appraiser on every corpus board", () => {
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
      const state = atPin(board, 13);
      try {
        const ranked = rankedWorth(state);
        // The pin-independent v13 appraisal (the gate is the only reader of the pin); direct once admitted.
        const seats = seatsOf(board.player_addresses);
        const appraised = V13_ADMITTED ? appraiseSeats(state, seats) : appraiseSeats(atPin(board, 12), seats);
        for (const seat of appraised) {
          if (ranked[seat.player_id].netWorth !== Number(seat.total.toString())) out.mismatches.push(`idx ${index} ${seat.player_id}`);
        }
      } catch (error) {
        if (!(error instanceof SettlementAppraisalError)) throw error;
        out.refusals.push(`idx ${index}: ${error.message}`);
      }
    });
    return out;
  }

  for (const log of LOGS) {
    it(`${log.name}: every board appraised at pin 13, 0 mismatches, 0 refusals`, () => {
      const result = sweep(log.entries());
      expect(result.boards).toBe(log.boards);
      expect(result.mismatches).toEqual([]);
      expect(result.refusals).toEqual([]);
    });
  }

  const serverData = existsSync(SERVER_DATA_DIR) ? readdirSync(SERVER_DATA_DIR).filter((f) => f.endsWith(".log.jsonl")).sort() : [];
  if (serverData.length === 0) {
    it.skip("server/data: no logs in this checkout -- rerun on the owner's machine", () => undefined);
  }
  for (const file of serverData) {
    it(`server/${file}: parity at pin 13 on every board, 0 refusals`, () => {
      const result = sweep(readJsonl(join(SERVER_DATA_DIR, file)));
      expect(result.mismatches).toEqual([]);
      expect(result.refusals).toEqual([]);
    });
  }
});

/* ================================================================================================= */
/* G. The v13 vectors                                                                               */
/* ================================================================================================= */

const GAMES = v13Vectors();
const game = (id: string): VectorGame => {
  const hit = GAMES.find((entry) => entry.id === id);
  if (!hit) throw new Error(`no vector ${id}`);
  return hit;
};
const DETERMINISM = new Map<string, DeterminismEvidence>(GAMES.map((entry) => [entry.id, determinismOf(entry)]));

/** The chain seat order of a vector: the turn order rotated by the vector's position (so chain order and turn order
 *  differ on most vectors -- a weight laid out in the wrong order would show). */
const seatMappingOf = (g: VectorGame): string[] => {
  const ids = g.terminal.player_addresses;
  const shift = GAMES.indexOf(g) % ids.length;
  return [...ids.slice(shift), ...ids.slice(0, shift)];
};
const EXTRA_POOLS = [b("1000000007"), (b(1) << b(64)) + b(13)];
const poolOf = (n: number) => b(n) * ANTE_NET;

function vectorArgs(g: VectorGame, board: GameStateResponse = g.terminal, logLen: number = g.entries.length, intent?: SettlementPayloadIntent): BuildSettlementPayloadArgs {
  const mapping = seatMappingOf(g);
  const d = v13DomainForSeats(mapping.length);
  const len = b(logLen);
  return {
    board: { state: board },
    bindings: mapping.map((player_id, chain_seat_index) => ({ chain_seat_index, player_id, wallet: d.wallets[chain_seat_index] })),
    domain: d.domain,
    domain_inputs: d.inputs,
    intent: intent ?? { kind: "Terminal", outcome: { reason: g.reason }, terms: TERMS },
    log_len: len,
    log_hash: logHash(g.entries, logLen),
    appraisal_log_len: len,
    state_schema_version: SYN05.payload.state_schema_version,
    signer_key_id: SYN05.payload.signer_key_id,
    issued_at: b(SYN05.payload.issued_at),
  };
}

const vgpTotal = (state: GameStateResponse): bigint =>
  state.player_cash.reduce((sum, row) => sum + b(row.cash_vgp), b(0)) +
  state.public_companies.reduce((sum, company) => sum + b((company as Loose).treasury ?? "0"), b(0)) +
  b(state.virtual_bank_vgp);
const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;
const held = (state: GameStateResponse, id: number, player: string) => company(state, id).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const cashOf = (state: GameStateResponse, player: string) => Number(state.player_cash.find((entry) => entry.player === player)!.cash_vgp);
const treasuryOf = (state: GameStateResponse, id: number) => Number(company(state, id).treasury);
const priceOf = (state: GameStateResponse, id: number) => (state.market_positions as Loose)[id].price as number;
const privateOf = (state: GameStateResponse, id: number) => state.private_companies.find((entry) => entry.private_id === id)!;
const kinds = (entries: readonly { payload: string; derived?: boolean }[]) => entries.map((entry) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`);
const fallen = (price: number, certificates: number) => projectShareSaleMove(marketCellForPrice(price)!, certificates)!.price;

/** Every field path at which two boards differ (objects walked, arrays compared per index / per company id). */
function differingPaths(a: unknown, c: unknown, path = "$"): string[] {
  if (JSON.stringify(a) === JSON.stringify(c)) return [];
  if (typeof a !== "object" || typeof c !== "object" || a === null || c === null || Array.isArray(a) !== Array.isArray(c)) return [path];
  if (Array.isArray(a)) {
    const left = a as Loose[];
    const right = c as Loose[];
    if (left.length !== right.length) return [path];
    const key = (row: Loose, i: number) =>
      row && typeof row === "object" && "company_id" in row ? `[${row.company_id}]` : row && typeof row === "object" && "private_id" in row ? `[p${row.private_id}]` : row && typeof row === "object" && "player" in row ? `[${row.player}]` : `[${i}]`;
    return left.flatMap((row, i) => differingPaths(row, right[i], `${path}${key(row, i)}`));
  }
  const keys = Array.from(new Set([...Object.keys(a as Loose), ...Object.keys(c as Loose)])).sort();
  return keys.flatMap((k) => differingPaths((a as Loose)[k], (c as Loose)[k], `${path}.${k}`));
}

describe("G. the v13 vectors: V13-01 ... V13-21, twenty-five terminals reached by play through a server room", () => {
  it("the inventory: every vector of the specification is here (V13-13 and V13-14 are cross-cutting: determinism and the v12 log)", () => {
    const ids = GAMES.map((g) => g.id);
    expect(ids).toEqual([
      "V13-01", "V13-02", "V13-03", "V13-04", "V13-05", "V13-06", "V13-07", "V13-08", "V13-09", "V13-10", "V13-11",
      "V13-12a", "V13-12b", "V13-15", "V13-16a", "V13-16b", "V13-17a", "V13-17b", "V13-18a", "V13-18b", "V13-19",
      "V13-20a", "V13-20b", "V13-21a", "V13-21b",
    ]);
    const bankruptcies = GAMES.filter((g) => g.reason === "Bankruptcy").map((g) => g.id);
    // The specification's required bankruptcy shapes: V13-03 .. V13-09, V13-15, V13-16 (a), and V13-12 where it applies.
    expect(bankruptcies).toEqual(["V13-03", "V13-04", "V13-05", "V13-06", "V13-07", "V13-08", "V13-09", "V13-12a", "V13-15", "V13-16a"]);
  });

  describe.each(GAMES.map((g) => [g.name, g] as const))("%s", (_name, g) => {
    const mapping = seatMappingOf(g);
    const seats = seatsOf(mapping);
    const terminal = g.terminal;

    it("is a v13 board (pin 13, rules revision 2) the room played to GameEnd -- its ending is the one the vector names", () => {
      expect(g.seedBoard.rules_engine_version).toBe(13);
      expect((g.seedBoard.variants as Loose).rules).toBe(2);
      expect(terminal.rules_engine_version).toBe(13);
      expect((terminal.variants as Loose).rules).toBe(2);
      expect(terminal.current_round_type).toBe("GameEnd");
      if (g.reason === "Bankruptcy") {
        expect(terminal.bankrupt_president).toBe(P1);
        expect((terminal as Loose).bankruptcy_record?.president).toBe(P1);
      } else {
        expect(terminal.bankrupt_president ?? null).toBeNull();
        expect((terminal as Loose).bankruptcy_record ?? null).toBeNull();
        expect((terminal as Loose).bank_broken).toBe(true);
      }
      // Every scripted refusal was refused by the room and appended nothing; every entry is the room's.
      for (const step of g.played) if (step.kind !== "applied") expect(step.entries).toEqual([]);
      expect(g.entries.length).toBe(g.played.reduce((sum, step) => sum + step.entries.length, 0));
    });

    it("VGP is conserved: players + treasuries + bank is the same on the seed and on the terminal", () => {
      expect(vgpTotal(terminal)).toBe(vgpTotal(g.seedBoard));
    });

    it("three readers agree: the certified appraiser (pin-independent), the independent oracle and rankPlayers", () => {
      const appraisals = appraiseV13(terminal, seats);
      const oracle = oracleNetWorth(terminal, seats);
      const ranked = rankedWorth(terminal);
      appraisals.forEach((seat, index) => {
        expect([seat.player_id, seat.cash_counted, seat.shares, seat.privates, seat.total]).toEqual([oracle[index].player_id, oracle[index].cash, oracle[index].shares, oracle[index].privates, oracle[index].total]);
        expect(ranked[seat.player_id].netWorth).toBe(Number(seat.total.toString()));
        if (seat.bankrupt) expect([seat.cash_counted, seat.privates]).toEqual([b(0), b(0)]);
      });
    });

    it("integer payouts sum exactly: Σ payouts + dust = pool, 0 <= dust < n, payout_i = floor(pool·w_i/Σw), on three pools", () => {
      const weights = terminalSettlementWeights(appraiseV13(terminal, seats).map((seat) => seat.total), { reason: g.reason } as never, TERMS);
      for (const pool of [poolOf(seats.length), ...EXTRA_POOLS]) {
        const preview = payoutPreview(pool, weights);
        const oracle = oraclePayouts(pool, weights);
        expect(preview.payouts).toEqual(oracle.payouts);
        expect(preview.dust).toBe(oracle.dust);
        expect(preview.payouts.reduce((sum, p) => sum + p, b(0)) + preview.dust).toBe(pool);
        expect(preview.dust >= b(0) && preview.dust < b(seats.length)).toBe(true);
      }
    });

    it("the canonical state hash is stable: live, cold restore, replay, snapshot rebuild and RevertTo all reach the same terminal bytes (V13-13)", () => {
      const d = DETERMINISM.get(g.id)!;
      expect([d.restore, d.replay, d.snapshot, d.revert.terminal, d.revert.restored]).toEqual([d.live, d.live, d.live, d.live, d.live]);
      expect(d.live).toBe(terminalStateHashV1(terminal));
      expect(stateDigest(restoredBoard(g))).toBe(stateDigest(terminal));
      // The revert really undid something: the reverted board is not the terminal.
      expect(d.revert.reverted_board).not.toBe(d.live);
      // The stored log keeps the undone entries, the revert, and the action made again: N + 1 + the step's entries.
      const revertedStep = g.played.find((entry) => entry.label === d.revert.reverted_label)!;
      expect(d.revert.log_len).toBe(g.entries.length + 1 + revertedStep.entries.length);
    });

    it("its payload: the v12 twin's bytes but for [1,33) domain and [91,123) appraisal_state_hash; decodes, checks; the builder agrees once admitted", () => {
      const args = vectorArgs(g);
      const composed = composeV13(args);
      expect(decodeSettlementPayloadV1(hexToBytes(composed.encoded_hex))).toEqual(composed.payload);
      expect(composed.payload.reason).toBe(SETTLEMENT_REASON_CODE[g.reason]);
      // The v12 twin: the same terminal at pin 12 under the same roster at rules 12, built by the CERTIFIED builder.
      const d12 = atDomainPin(v13DomainForSeats(mapping.length), 12);
      const twin = buildSettlementPayloadV1({ ...args, board: { state: atPin(terminal, 12) }, domain: d12.domain, domain_inputs: d12.inputs });
      const differ = differingOffsets(composed.encoded_hex, twin.encoded_hex);
      expect(onlyPinBytes(differ)).toBe(true);
      expect(differ.some((at) => at < DOMAIN_BYTES[1])).toBe(true);
      expect(differ.some((at) => at >= APPRAISAL_HASH_BYTES[0])).toBe(true);
      expect(twin.payload.settlement_weights).toEqual(composed.payload.settlement_weights);
      expectBuilderAgrees(args, composed);
    });

    it("the browser's re-derivation (`checkTerminalSettlement`): a match once admitted, `unavailable` (not certified) before", () => {
      const composed = composeV13(vectorArgs(g));
      const roster = mapping.map((playerId, chainSeatIndex) => ({ playerId, chainSeatIndex }));
      const result = checkTerminalSettlement({
        payload: decodeSettlementPayloadV1(hexToBytes(composed.encoded_hex)),
        log: g.entries,
        roster,
        playerId: mapping[0],
        chainSeatIndex: 0,
        replay: (prefix) => restoredBoard(g, prefix as readonly ServerLogEntry[]),
      });
      expect(result.result).toBe(V13_ADMITTED ? "match" : "unavailable");
    });
  });

  /* ---------------------------------------------------------------- */
  /* What each vector pins                                            */
  /* ---------------------------------------------------------------- */

  it("V13-01: an ordinary v13 bank break is SYN-01's certified board but for the rules revision -- the v12 formula carries over unchanged", () => {
    const g = game("V13-01");
    const syn01 = boards["SYN-01-CLASSIC-BANKBREAK"];
    expect(differingPaths(syn01, g.terminal)).toEqual(["$.variants.rules"]);
    const entry = V10_GOLDEN.cases.find((c) => c.name === "SYN-01-CLASSIC-BANKBREAK")!;
    const appraisals = appraiseV13(g.terminal, seatsOf(entry.seat_mapping));
    expect(strings(appraisals.map((seat) => seat.total))).toEqual(entry.vector);
    expect(strings(payoutPreview(b(entry.pool_ujuno), appraisals.map((seat) => seat.total)).payouts)).toEqual(entry.payouts_ujuno);
    expect(g.played.filter((step) => step.kind === "applied")).toHaveLength(20);
  });

  it("V13-02: one-click PassTurn turns, a Brown continuation and an all-pass ending, then a bank break -- path only", () => {
    const g = game("V13-02");
    const [buy1, poolBo, buy2, endTurn, p2Pass, p3Sell, p3End, pass1, pass2, pass3] = g.played;
    expect(buy1.after.brown_pool_continuation_company).toBe(CO);
    // B&O is Brown too, its certificate in the Bank Pool: refused by the v13 rule alone (the continuation is C&O's).
    expect(marketZoneForPrice(priceOf(buy1.after, BO))).toBe("Brown");
    expect(company(buy1.after, BO).bank_pool_percentage).toBeGreaterThan(0);
    expect(poolBo.kind).not.toBe("applied");
    expect(poolBo.reason).toContain("several Bank Pool certificates of that one corporation");
    expect(buy2.kind).toBe("applied");
    expect(held(buy2.after, CO, P1)).toBe(20);
    expect([endTurn.after.active_player_index, endTurn.after.consecutive_passes]).toEqual([1, 0]); // one message, acted
    expect(endTurn.after.brown_pool_continuation_company ?? null).toBeNull();
    expect(p2Pass.after.consecutive_passes).toBe(1); // a true pass counts
    expect(p3Sell.kind).toBe("applied");
    expect([p3End.after.active_player_index, p3End.after.consecutive_passes]).toEqual([0, 0]); // acted: the streak resets
    expect([pass1.after.consecutive_passes, pass2.after.consecutive_passes]).toEqual([1, 2]);
    expect(pass3.before.current_round_type).toBe("StockRound");
    expect(pass3.after.current_round_type).toBe("OperatingRound"); // the all-pass ending
    // Path only: the revision-2 turn fields are cleared by the terminal, and the appraiser never reads them anyway.
    for (const field of ["brown_pool_continuation_company", "emergency_funding_marks", "bankruptcy_record"]) {
      expect((g.terminal as Loose)[field] ?? null).toBeNull();
    }
    expect(held(g.terminal, CO, P1)).toBe(20);
  });

  /** The bankruptcy vectors' shared proof: the reducer's record is exactly the liquidation the engine's own analysis
   *  computed on the board it proved the bankruptcy on, every dollar went to the obligated treasury, the residue stayed
   *  in the bankrupt's hand and is valued at the terminal prices. */
  function bankruptcyProof(g: VectorGame) {
    const { board: proof, grid } = bankruptcyProofBoard(g);
    const funding = emergencyFundingFor(proof, grid)!;
    expect(funding).not.toBeNull();
    expect(funding.bankrupt).toBe(true);
    const record = (g.terminal as Loose).bankruptcy_record;
    const rescue = funding.automatic!.rescue;
    expect(record.company_id).toBe(CO);
    expect(record.sold).toEqual(rescue.maximumLiquidation.map((leg) => ({ company_id: leg.protocol_id, percentage: leg.percentage })));
    expect(record.liquidation_proceeds).toBe(rescue.maximumProceeds);
    expect(rescue.canFund).toBe(false);
    expect(record.handed_over).toBe(funding.presidentCash + rescue.maximumProceeds);
    expect(treasuryOf(g.terminal, CO)).toBe(treasuryOf(proof, CO) + record.handed_over);
    expect(cashOf(g.terminal, P1)).toBe(0);
    for (const leg of rescue.maximumLiquidation) {
      expect(held(g.terminal, leg.protocol_id, P1)).toBe(held(proof, leg.protocol_id, P1) - leg.percentage);
      expect(priceOf(g.terminal, leg.protocol_id)).toBe(fallen(priceOf(proof, leg.protocol_id), leg.percentage / 10));
    }
    return { proof, funding, record, rescue };
  }

  it("V13-03: full liquidation -- every legal leg sold, still short; cash 0 and privates 0 for the bankrupt; the treasury credited; rival prices after the drops", () => {
    const g = game("V13-03");
    const { record, funding } = bankruptcyProof(g);
    // p1's Schuylkill Valley is open and his, but no corporation can pay its $10 minimum: no private path, counted 0.
    expect(funding.legalPrivateSales).toEqual([]);
    expect([privateOf(g.terminal, SV).owner, privateOf(g.terminal, SV).closed]).toEqual([P1, false]);
    expect(record.sold).toEqual([{ company_id: PRR, percentage: 10 }, { company_id: NYC, percentage: 10 }, { company_id: CO, percentage: 10 }]);
    // The residue is the rescued corporation's crown alone.
    expect(g.terminal.public_companies.filter((c) => held(g.terminal, c.company_id, P1) > 0).map((c) => [c.company_id, held(g.terminal, c.company_id, P1)])).toEqual([[CO, 20]]);
    const p1 = appraiseV13(g.terminal, seatsOf(g.terminal.player_addresses)).find((seat) => seat.player_id === P1)!;
    expect([p1.cash_counted, p1.privates, p1.shares]).toEqual([b(0), b(0), b(2 * priceOf(g.terminal, CO))]);
  });

  it("V13-04: the presidency rule keeps shares unsold, and the kept shares count in the share term (O-6)", () => {
    const g = game("V13-04");
    const { rescue, record } = bankruptcyProof(g);
    const prr = rescue.corporations.find((c) => c.companyId === PRR)!;
    expect(prr.options.map((o) => o.percentage)).toEqual([10, 20]);
    expect(prr.restriction).toMatch(/presiden/i);
    expect(record.sold).toEqual([{ company_id: PRR, percentage: 20 }, { company_id: NYC, percentage: 10 }]);
    expect([held(g.terminal, PRR, P1), held(g.terminal, CO, P1)]).toEqual([20, 20]);
    expect(company(g.terminal, PRR).president).toBe(P1);
    const p1 = appraiseV13(g.terminal, seatsOf(g.terminal.player_addresses)).find((seat) => seat.player_id === P1)!;
    expect(p1.shares).toBe(b(2 * priceOf(g.terminal, PRR) + 2 * priceOf(g.terminal, CO)));
  });

  it("V13-05: the 50% Bank Pool cap limits a leg in liquidation; the remainder is kept and valued", () => {
    const g = game("V13-05");
    const { rescue, record } = bankruptcyProof(g);
    const nyc = rescue.corporations.find((c) => c.companyId === NYC)!;
    expect(nyc.options.map((o) => o.percentage)).toEqual([10]);
    expect(nyc.restriction).toMatch(/Bank Pool/);
    expect(record.sold).toEqual([{ company_id: NYC, percentage: 10 }, { company_id: CPR, percentage: 10 }]);
    expect(company(g.terminal, NYC).bank_pool_percentage).toBe(50);
    expect(held(g.terminal, NYC, P1)).toBe(20);
    const p1 = appraiseV13(g.terminal, seatsOf(g.terminal.player_addresses)).find((seat) => seat.player_id === P1)!;
    expect(p1.shares).toBe(b(2 * priceOf(g.terminal, NYC) + 2 * priceOf(g.terminal, CO)));
  });

  it("V13-06: no saleable share at all -- the portfolio is untouched; only the cash moves", () => {
    const g = game("V13-06");
    const { rescue, record } = bankruptcyProof(g);
    expect(rescue.corporations).toEqual([]);
    expect(record.sold).toEqual([]);
    expect(record.handed_over).toBe(40);
    for (const c of g.seedBoard.public_companies) expect([c.company_id, held(g.terminal, c.company_id, P1)]).toEqual([c.company_id, held(g.seedBoard, c.company_id, P1)]);
    expect([cashOf(g.seedBoard, P1), cashOf(g.terminal, P1)]).toEqual([40, 0]);
    expect(treasuryOf(g.terminal, CO)).toBe(40);
    // The bankrupt's privates (SV and D&H, open: phase 2, nobody may buy them) count 0.
    expect([privateOf(g.terminal, SV).owner, privateOf(g.terminal, DH).owner]).toEqual([P1, P1]);
  });

  it("V13-07: bankruptcy after ForgoTrainTrade -- the window held the game, a liquidation-sized trade was refused, the forgo ended it; no trade-funded terminal", () => {
    const g = game("V13-07");
    const waiting = g.played[0].after;
    const funding = emergencyFundingFor(waiting, g.grid)!;
    expect([funding.automatic!.tradeWindow, funding.bankrupt, waiting.current_round_type]).toEqual(["open", false, "OperatingRound"]);
    expect(g.played[1].kind).not.toBe("applied");
    expect(g.played[1].reason).toMatch(/without selling shares/);
    expect(g.played[2].entries).toEqual(["ForgoTrainTrade"]);
    const { record } = bankruptcyProof(g);
    expect(record).toMatchObject({ sold: [], handed_over: 30 });
    expect(company(g.terminal, NYC).owned_trains).toEqual(["2"]);
    expect(company(g.terminal, CO).owned_trains).toEqual([]);
  });

  it("V13-08: bankruptcy after ForgoPrivateFunding -- the bankrupt's privates count 0, the others' are counted", () => {
    const g = game("V13-08");
    const waiting = g.played[0].after;
    expect(emergencyFundingFor(waiting, g.grid)!.automatic!.privateFunding).toBe("relevant");
    expect(g.played[1].entries).toEqual(["ForgoPrivateFunding"]);
    bankruptcyProof(g);
    expect([privateOf(g.terminal, CA).owner, privateOf(g.terminal, CA).closed]).toEqual([P1, false]);
    const appraisals = appraiseV13(g.terminal, seatsOf(g.terminal.player_addresses));
    expect(appraisals.find((seat) => seat.player_id === P1)!.privates).toBe(b(0));
    expect(appraisals.find((seat) => seat.player_id === P2)!.privates).toBe(b(20 + 70)); // SV + D&H
    expect(appraisals.find((seat) => seat.player_id === P3)!.privates).toBe(b(40 + 110)); // C&StL + M&H
  });

  it("V13-09: irrelevant private funding -- immediate bankruptcy with the bankrupt's privates still open, excluded for him alone", () => {
    const g = game("V13-09");
    expect(g.played.map((step) => step.entries[0])).toEqual(["PassTurn", "AdvanceOperatingSubPhase"]); // ended in the C&O's first burst
    const { funding } = bankruptcyProof(g);
    expect(funding.automatic!.privateFunding).toBe("irrelevant");
    expect(funding.automatic!.privateFundingUpperBound).toBeLessThan(funding.shortfall);
    expect([privateOf(g.terminal, SV).owner, privateOf(g.terminal, CSL).owner, privateOf(g.terminal, SV).closed, privateOf(g.terminal, CSL).closed]).toEqual([P1, P1, false, false]);
    const appraisals = appraiseV13(g.terminal, seatsOf(g.terminal.player_addresses));
    expect(appraisals.find((seat) => seat.player_id === P1)!.privates).toBe(b(0));
    expect(appraisals.find((seat) => seat.player_id === P2)!.privates).toBe(b(70 + 160)); // D&H + C&A
    expect(appraisals.find((seat) => seat.player_id === P3)!.privates).toBe(b(110)); // M&H
  });

  it("V13-10: a rescue by EmergencySellPortfolio (the smallest legal overshoot), then play to a bank break -- an ordinary terminal; the overshoot cash counted", () => {
    const g = game("V13-10");
    const waiting = g.played[0].after;
    const funding = emergencyFundingFor(waiting, g.grid)!;
    expect(funding.shortfall).toBe(80);
    expect(emergencyPortfolioRefusal(waiting, funding, [{ protocol_id: NYC, percentage: 10 }], P1)).toContain("raises $40");
    expect(emergencyPortfolioRefusal(waiting, funding, [{ protocol_id: PRR, percentage: 10 }], P1)).toContain("raises $50");
    expect(emergencyPortfolioRefusal(waiting, funding, [{ protocol_id: NYC, percentage: 10 }, { protocol_id: PRR, percentage: 10 }], P1)).toBeNull();
    expect(g.played[1].entries).toEqual(["EmergencySellPortfolio", "EmergencyBuyHardware*"]);
    expect(cashOf(g.played[1].after, P1)).toBe(10);
    expect(company(g.terminal, CO).owned_trains).toEqual(["2"]);
    expect(g.played.length).toBeGreaterThan(3); // play continued after the rescue
    const p1 = appraiseV13(g.terminal, seatsOf(g.terminal.player_addresses)).find((seat) => seat.player_id === P1)!;
    expect(p1.cash_counted).toBe(b(10));
  });

  it("V13-11: the automatic EmergencyBuyHardware is derived and keyed; a rebuild, a crash either side of it and a repeated settle never buy twice", () => {
    const g = game("V13-11");
    const purchase = g.entries.findIndex((entry) => "EmergencyBuyHardware" in JSON.parse(entry.payload));
    expect(g.entries[purchase].derived).toBe(true);
    expect(kinds(g.entries).filter((k) => k.startsWith("EmergencyBuyHardware"))).toEqual(["EmergencyBuyHardware*"]);
    const before = boardAfter(g, purchase).board;
    const owed = nextDerivedAction({ state: before, mapGrid: g.grid, emitted: new Set() })!;
    expect(owed.kind).toBe("forced-purchase");
    expect(derivedEntryKey(before, JSON.parse(g.entries[purchase].payload))).toBe(owed.key);
    expect(owed.key).toMatch(/^emergency-purchase:/);
    // A player may not send it: it is the game's.
    expect(turnRefusal({ state: before, waterfall: null, actor: P1, msg: JSON.parse(g.entries[purchase].payload), mapGrid: g.grid })).toContain("made automatically");
    // A crash before the purchase was appended re-derives it once; a crash after it derives nothing more.
    for (const cut of [purchase, purchase + 1]) {
      const room = crashRestart(g, cut);
      expect(kinds(room.entries)).toEqual(kinds(g.entries));
      expect(room.entries.map((entry) => entry.payload)).toEqual(g.entries.map((entry) => entry.payload));
      expect(logHash(room.entries)).toBe(g.log_hash);
      expect(terminalStateHashV1(room.state)).toBe(terminalStateHashV1(g.terminal));
    }
    // After the purchase the board owes nothing, whatever the guard set holds.
    expect(nextDerivedAction({ state: boardAfter(g, purchase + 1).board, mapGrid: g.grid, emitted: new Set() })).toBeNull();
    // And after a RESCUE: a crash before the portfolio, between the portfolio and the game's purchase, or after both.
    for (const id of ["V13-10", "V13-17a", "V13-19", "V13-21b"]) {
      const rescued = game(id);
      const at = rescued.entries.findIndex((entry) => "EmergencySellPortfolio" in JSON.parse(entry.payload));
      expect([id, kinds(rescued.entries).slice(at, at + 2)]).toEqual([id, ["EmergencySellPortfolio", "EmergencyBuyHardware*"]]);
      for (const cut of [at, at + 1, at + 2]) {
        const room = crashRestart(rescued, cut);
        expect([id, cut, room.entries.map((entry) => entry.payload)]).toEqual([id, cut, rescued.entries.map((entry) => entry.payload)]);
        expect([id, cut, logHash(room.entries)]).toEqual([id, cut, rescued.log_hash]);
        expect([id, cut, terminalStateHashV1(room.state)]).toEqual([id, cut, terminalStateHashV1(rescued.terminal)]);
      }
    }
  });

  it("V13-12: ties at the top -- the bankrupt ties P2 (a), and two seats tie in a four-seat bank break (b): equal weights, equal payouts, a shared first rank", () => {
    const a = game("V13-12a");
    const b12 = game("V13-12b");
    for (const [g, tied] of [[a, [P1, P2]], [b12, [P2, P3]]] as const) {
      const ids = seatMappingOf(g);
      const appraisals = appraiseV13(g.terminal, seatsOf(ids));
      const top = appraisals.reduce((max, seat) => (seat.total > max ? seat.total : max), b(0));
      expect(appraisals.filter((seat) => seat.total === top).map((seat) => seat.player_id).sort()).toEqual([...tied].sort());
      const ranked = rankedWorth(g.terminal);
      expect(tied.map((player) => ranked[player].rank)).toEqual([1, 1]);
      for (const pool of [poolOf(ids.length), ...EXTRA_POOLS]) {
        const preview = payoutPreview(pool, appraisals.map((seat) => seat.total));
        const payout = (player: string) => preview.payouts[ids.indexOf(player)];
        expect(payout(tied[0])).toBe(payout(tied[1]));
      }
    }
    expect(appraiseV13(a.terminal, seatsOf(a.terminal.player_addresses)).find((seat) => seat.player_id === P1)!.bankrupt).toBe(true);
    expect(b12.terminal.player_addresses).toHaveLength(4);
  });

  it("V13-15: the maximal legal liquidation mixing a Pool-capped leg, a presidency-locked holding and a fully sold one, in public_companies order", () => {
    const g = game("V13-15");
    const { rescue, record } = bankruptcyProof(g);
    expect(record.sold).toEqual([{ company_id: NYC, percentage: 20 }, { company_id: CPR, percentage: 20 }]);
    expect(rescue.corporations.find((c) => c.companyId === NYC)!.restriction).toMatch(/Bank Pool/);
    expect(rescue.corporations.find((c) => c.companyId === PRR)).toBeUndefined(); // the President's Certificate nobody can take
    expect([held(g.terminal, PRR, P1), held(g.terminal, NYC, P1), held(g.terminal, CPR, P1), held(g.terminal, CO, P1)]).toEqual([20, 10, 0, 20]);
    expect(company(g.terminal, NYC).bank_pool_percentage).toBe(50);
    expect(treasuryOf(g.terminal, CO)).toBe(record.liquidation_proceeds);
    const p1 = appraiseV13(g.terminal, seatsOf(g.terminal.player_addresses)).find((seat) => seat.player_id === P1)!;
    expect(p1.shares).toBe(b(2 * priceOf(g.terminal, PRR) + priceOf(g.terminal, NYC) + 2 * priceOf(g.terminal, CO)));
  });

  it("V13-16: exact legal private-funding possibility, not the loose bound, holds the game -- (a) ends at once, (b) waits and rescues; the boards differ exactly there", () => {
    const a = game("V13-16a");
    const bb = game("V13-16b");
    // The two seeds differ only in P1's privates and NYC's treasury.
    const seedDiff = differingPaths(a.seedBoard, bb.seedBoard);
    expect(seedDiff.every((path) => /^\$\.private_companies\[p[345]\]\.owner$/.test(path) || path === `$.public_companies[${NYC}].treasury` || path === "$.virtual_bank_vgp")).toBe(true);
    const { funding } = bankruptcyProof(a);
    expect(funding.automatic!.privateFundingUpperBound).toBeGreaterThanOrEqual(funding.shortfall);
    expect(funding.automatic!.privateFundingMaximum).toBeLessThan(funding.shortfall);
    expect(funding.automatic!.privateFunding).toBe("irrelevant");
    expect(a.played).toHaveLength(2); // the prior corporation's end of turn, then the C&O's one burst
    const waiting = bb.played[1].after;
    const bFunding = emergencyFundingFor(waiting, bb.grid)!;
    expect([waiting.current_round_type, bFunding.automatic!.privateFunding, bFunding.bankrupt]).toEqual(["OperatingRound", "relevant", false]);
    expect(bFunding.automatic!.privateFundingMaximum).toBeGreaterThanOrEqual(bFunding.shortfall);
    expect(bb.played[3].entries).toEqual(["AnswerFundingPrivateOffer", "EmergencyBuyHardware*"]);
    expect([privateOf(bb.terminal, CA).owner, privateOf(bb.terminal, CA).owner_protocol_id]).toEqual([null, NYC]);
    expect(treasuryOf(bb.terminal, NYC)).toBe(300);
    expect([a.terminal.bankrupt_president, bb.terminal.bankrupt_president ?? null]).toEqual([P1, null]);
  });

  it("V13-17: a private sale then a portfolio (a), and two private sales to two buyers (b), each completes a rescue; buyer treasuries and corporate owners on the terminal", () => {
    const a = game("V13-17a");
    expect(emergencyFundingFor(a.played[2].after, a.grid)!.shortfall).toBe(40);
    expect(a.played[3].entries).toEqual(["EmergencySellPortfolio", "EmergencyBuyHardware*"]);
    expect([privateOf(a.terminal, DH).owner, privateOf(a.terminal, DH).owner_protocol_id, treasuryOf(a.terminal, NYC), cashOf(a.played[3].after, P1)]).toEqual([null, NYC, 500 - 140, 10]);
    const bb = game("V13-17b");
    expect(emergencyFundingFor(bb.played[2].after, bb.grid)!.shortfall).toBe(80);
    expect(bb.played[4].entries).toEqual(["AnswerFundingPrivateOffer", "EmergencyBuyHardware*"]);
    expect([privateOf(bb.terminal, MH).owner_protocol_id, privateOf(bb.terminal, DH).owner_protocol_id]).toEqual([NYC, PRR]);
    expect([treasuryOf(bb.terminal, NYC), treasuryOf(bb.terminal, PRR)]).toEqual([0, 20]);
  });

  it("V13-18: a Brown continuation interrupted by the active player's accepted trade (a) or M&H exchange (b) -- the next Pool purchase refused; an off-turn rejection does not interrupt", () => {
    const a = game("V13-18a");
    expect(a.played[0].after.brown_pool_continuation_company).toBe(CO);
    expect(a.played[2].after.brown_pool_continuation_company).toBe(CO); // after P2's off-turn rejection
    expect(a.played[3].kind).toBe("applied"); // the continuation survived
    expect(a.played[5].after.brown_pool_continuation_company ?? null).toBeNull(); // the accepted trade closed it
    expect(a.played[6].kind).not.toBe("applied");
    expect(a.played[6].reason).toMatch(/One certificate purchase per turn/);
    expect(privateOf(a.terminal, SV).owner).toBe(P2);
    const bb = game("V13-18b");
    expect(bb.played[1].after.brown_pool_continuation_company ?? null).toBeNull();
    expect(privateOf(bb.played[1].after, MH).closed).toBe(true);
    expect(bb.played[2].kind).not.toBe("applied");
    expect(bb.played[2].reason).toMatch(/One certificate purchase per turn/);
  });

  it("V13-19: an atomic portfolio of three corporations in the submitted order, with a presidency change inside it -- one entry, today's prices per leg", () => {
    const g = game("V13-19");
    const step = g.played[1];
    expect(step.entries).toEqual(["EmergencySellPortfolio", "EmergencyBuyHardware*"]);
    const legs = (JSON.parse(g.entries.find((entry) => "EmergencySellPortfolio" in JSON.parse(entry.payload))!.payload) as Loose).EmergencySellPortfolio.sales;
    expect(legs).toEqual([{ protocol_id: PRR, percentage: 10 }, { protocol_id: NYC, percentage: 20 }, { protocol_id: CPR, percentage: 10 }]);
    const before = step.before;
    expect([company(before, NYC).president, company(step.after, NYC).president]).toEqual([P1, P2]);
    const raised = priceOf(before, PRR) * 1 + priceOf(before, NYC) * 2 + priceOf(before, CPR) * 1;
    expect(raised).toBe(195);
    expect(cashOf(step.after, P1)).toBe(raised - 180);
    // The legs moved their tokens in the submitted order (the chart's arrivals read it).
    const arrival = (id: number) => (step.after.market_positions as Loose)[id].enteredAt as number;
    expect(arrival(PRR) < arrival(NYC) && arrival(NYC) < arrival(CPR)).toBe(true);
    expect(company(g.terminal, CO).owned_trains).toEqual(["3"]);
  });

  it("V13-20: the smallest legal overshoot both ways -- one obligation rescued by the $100 card in one log and the $60 card in another; two certified terminals", () => {
    const a = game("V13-20a");
    const bb = game("V13-20b");
    expect(canonicalStateText(a.seedBoard)).toBe(canonicalStateText(bb.seedBoard));
    const waiting = a.played[0].after;
    const funding = emergencyFundingFor(waiting, a.grid)!;
    expect(funding.shortfall).toBe(50);
    expect(emergencyPortfolioRefusal(waiting, funding, [{ protocol_id: PRR, percentage: 10 }], P1)).toBeNull();
    expect(emergencyPortfolioRefusal(waiting, funding, [{ protocol_id: NYC, percentage: 10 }], P1)).toBeNull();
    expect(emergencyPortfolioRefusal(waiting, funding, [{ protocol_id: PRR, percentage: 10 }, { protocol_id: NYC, percentage: 10 }], P1)).toContain("Only enough");
    expect([cashOf(a.played[1].after, P1), cashOf(bb.played[1].after, P1)]).toEqual([50, 10]);
    expect(terminalStateHashV1(a.terminal)).not.toBe(terminalStateHashV1(bb.terminal));
    expect(priceOf(a.terminal, PRR)).toBeLessThan(priceOf(bb.terminal, PRR));
    expect(priceOf(bb.terminal, NYC)).toBeLessThan(priceOf(a.terminal, NYC));
  });

  it("V13-21: a trade inside the window (a), and the same obligation after a liquidation closed it (b) -- no liquidation-funded trade terminal exists", () => {
    const a = game("V13-21a");
    const bb = game("V13-21b");
    expect(canonicalStateText(a.seedBoard)).toBe(canonicalStateText(bb.seedBoard));
    const waiting = a.played[0].after;
    expect(emergencyFundingFor(waiting, a.grid)!.automatic!.tradeWindow).toBe("open");
    // Two presidents: p1 offers for the C&O, p2 accepts for NYC; the accepted offer settles as the room's derived entry.
    expect([company(waiting, NYC).president, company(waiting, CO).president]).toEqual([P2, P1]);
    expect(a.played[1].entries).toEqual(["ProposeTrainPurchase"]);
    expect(a.played[2].entries).toEqual(["AnswerTrainPurchase", "BuyTrainFromCorporation*"]);
    expect([company(a.terminal, CO).owned_trains, company(a.terminal, NYC).owned_trains]).toEqual([["2"], []]);
    expect(treasuryOf(a.terminal, NYC)).toBe(100 + 60);
    expect([treasuryOf(a.played[2].after, CO), cashOf(a.played[2].after, P1)]).toEqual([0, 0]); // $30 + $30
    // (b): the board between the portfolio and the game's purchase -- the window is closed and a trade is refused.
    expect(bb.played[1].entries).toEqual(["EmergencySellPortfolio", "EmergencyBuyHardware*"]);
    const portfolioAt = bb.entries.findIndex((entry) => "EmergencySellPortfolio" in JSON.parse(entry.payload));
    const { board: between, grid } = boardAfter(bb, portfolioAt + 1);
    const closed = emergencyFundingFor(between, grid)!;
    expect(closed.automatic!.tradeWindow).toBe("closed");
    expect(fundedTradeRefusal(between, closed, CO, 50, 80)).toContain("never with money raised by selling");
    expect(trainSaleRefusal(between, { buyerId: CO, sellerId: NYC, model: "2", price: 50 }, P1, grid, "settlement")).toContain("never with money raised by selling");
    expect([company(bb.terminal, CO).owned_trains, company(bb.terminal, NYC).owned_trains]).toEqual([["2"], ["2"]]);
    expect(kinds(bb.entries).some((k) => k.startsWith("BuyTrainFromCorporation") || k.startsWith("ProposeTrainPurchase"))).toBe(false);
  });

  it("V13-13 / RevertTo: every revert is LIVE, and on every rescue it undoes the emergency decision itself, with the game's derived purchase", () => {
    const decisions = ["EmergencySellPortfolio", "AnswerFundingPrivateOffer", "AnswerTrainPurchase", "ForgoTrainTrade"];
    for (const g of GAMES) {
      const d = DETERMINISM.get(g.id)!;
      const step = g.played.find((entry) => entry.label === d.revert.reverted_label)!;
      expect([g.id, step.after.current_round_type]).not.toEqual([g.id, "GameEnd"]);
      if (g.reason === "BankBroken" && g.played.some((entry) => entry.entries.includes("EmergencyBuyHardware*"))) {
        expect([g.id, decisions.includes(step.entries[0]), step.entries[step.entries.length - 1]]).toEqual([g.id, true, "EmergencyBuyHardware*"]);
      }
      if (g.reason === "Bankruptcy") {
        // Immediate bankruptcies undo the previous corporation's end of turn; V13-07 / 08 the walk into the obligation.
        expect([g.id, step.entries[0]]).toEqual([g.id, g.id === "V13-07" || g.id === "V13-08" ? "AdvanceOperatingSubPhase" : "PassTurn"]);
      }
    }
  });

  it("V13-13: the same log through RoomEngine.apply (live), a cold restore, the batch replay and a snapshot rebuild ends at one digest -- on every vector", () => {
    for (const g of GAMES) {
      const d = DETERMINISM.get(g.id)!;
      expect([g.id, new Set([d.live, d.restore, d.replay, d.snapshot]).size]).toEqual([g.id, 1]);
      expect(d.snapshot_after).toBeGreaterThan(0);
      expect(d.snapshot_after).toBeLessThan(g.entries.length);
    }
  });
});


/* ---------------------------------------------------------------- */
/* V13-14: a v12-pinned log offered to the v13 engine                 */
/* ---------------------------------------------------------------- */

describe("G. V13-14: a v12-pinned log is refused before the first apply -- never reinterpreted, no settlement path", () => {
  const seed = () => ({
    state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
  });
  const dealt = (() => {
    let minted = 0;
    const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "v13-cert", mintId: () => `deal-${(minted += 1)}`, now: () => 0 });
    const deal = { SetupGame: { players: [{ id: P1, nickname: "A" }, { id: P2, nickname: "B" }, { id: P3, nickname: "C" }], variants: { ...STANDARD_VARIANTS }, build: "v13-cert" } };
    expect(room.submit({ actor: P1, build: "v13-cert", msg: deal as never, baseIndex: -1 }).kind).toBe("applied");
    return room;
  })();
  const repinned = (version: number, revision: number) =>
    dealt.entries.map((row) => {
      const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
      if (!parsed.SetupGame) return { ...row };
      return { ...row, payload: JSON.stringify({ ...parsed, SetupGame: { ...parsed.SetupGame, [RULES_ENGINE_VERSION_FIELD]: version, variants: { ...(parsed.SetupGame.variants as object), rules: revision } } }) };
    });

  it("the control: a v13 deal (revision 2) is stamped 13 and restores and replays to the live board", () => {
    expect(dealt.rulesEngineVersion()).toBe(13);
    expect((dealt.state.variants as Loose).rules).toBe(2);
    expect(replaySealedPrefix(dealt.entries)).not.toBeNull();
    expect(stateDigest(replaySealedPrefix(dealt.entries)!)).toBe(stateDigest(dealt.state));
  });

  it("the same log re-pinned to 12 (a v12-era revision-1 deal): held before a single RoomEngine.apply; the replay throws; the settlement replay has no board", () => {
    const atTwelve = repinned(12, 1);
    expect(replayRefusal(replayCompatibility(atTwelve), SERVER_REPLAY_POLICY)).toContain("rules engine version 12");
    const applySpy = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const old = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "v13-cert", mintId: () => "x", now: () => 0 });
      old.restore(atTwelve as ServerLogEntry[]);
      expect(applySpy).not.toHaveBeenCalled();
      expect(old.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 12, supported: [13] });
      expect(replaySealedPrefix(atTwelve)).toBeNull();
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
    }
    expect(() => replayLog(atTwelve, sandboxReplayProviders(), seed(), undefined, SERVER_REPLAY_POLICY)).toThrow();
    // Re-pinned to 11 or 10 as well: refused the same way.
    for (const pin of [11, 10]) expect(replayRefusal(replayCompatibility(repinned(pin, 1)), SERVER_REPLAY_POLICY)).toContain(`rules engine version ${pin}`);
  });

  it("the browser's settlement check of a v12 log replayed under v13 is `unavailable`: no v13 board exists to appraise", () => {
    const atTwelve = repinned(12, 1);
    const v = (V12.payload_vectors as Loose[]).find((x) => x.name === "SYN-01-CLASSIC-BANKBREAK/terminal-BankBroken")!;
    const payload = decodeSettlementPayloadV1(hexToBytes(v.encoded));
    const forged = { ...payload, log_len: b(atTwelve.length), seq: b(2 * atTwelve.length + 1), appraisal_log_len: b(atTwelve.length), log_hash: logHash(atTwelve) };
    const result = checkTerminalSettlement({
      payload: forged,
      log: atTwelve,
      roster: [{ playerId: "p2", chainSeatIndex: 0 }, { playerId: "p1", chainSeatIndex: 1 }, { playerId: "p3", chainSeatIndex: 2 }],
      playerId: "p2",
      chainSeatIndex: 0,
    });
    expect(result.result).toBe("unavailable");
  });
});

/* ---------------------------------------------------------------- */
/* v13 round-boundary checkpoints                                     */
/* ---------------------------------------------------------------- */

interface CheckpointCase {
  name: string;
  game: VectorGame;
  log_len: number;
  board: GameStateResponse;
}

/** The checkpoint positions of a vector (`checkpointPolicy.ts`): the end of every batch after which the reducer's round
 *  differs from the newest checkpoint's -- the terminal excluded (it is the terminal payload's). */
function checkpointsOf(g: VectorGame): CheckpointCase[] {
  const out: CheckpointCase[] = [];
  let roundKey = `${g.seedBoard.current_round_type}/${g.seedBoard.macro_round_number}/${g.seedBoard.sub_round_index}`;
  let length = 0;
  for (const step of g.played) {
    length += step.entries.length;
    const key = `${step.after.current_round_type}/${step.after.macro_round_number}/${step.after.sub_round_index}`;
    if (key !== roundKey && step.after.current_round_type !== "GameEnd") out.push({ name: `${g.name}/checkpoint@${length}`, game: g, log_len: length, board: step.after });
    roundKey = key;
  }
  return out;
}
const CHECKPOINTS: CheckpointCase[] = checkpointsOf(game("V13-02"));

describe("G. v13 round-boundary checkpoints: the Checkpoint payload of a mid-game v13 board", () => {
  it("V13-02 crosses two boundaries before its end: the Stock Round into OR 4.1, and OR 4.1 into OR 4.2", () => {
    expect(CHECKPOINTS.map((c) => `${c.board.current_round_type}/${c.board.macro_round_number}/${c.board.sub_round_index}`)).toEqual(["OperatingRound/4/1", "OperatingRound/4/2"]);
  });

  for (const c of CHECKPOINTS) {
    it(`${c.name}: a Checkpoint (kind 0, reason 0), weights = the appraisal, the builder agrees once admitted`, () => {
      expect(stateDigest(boardAfter(c.game, c.log_len).board)).toBe(stateDigest(c.board));
      const args = vectorArgs(c.game, c.board, c.log_len, { kind: "Checkpoint" });
      const composed = composeV13(args);
      expect([composed.payload.kind, composed.payload.reason]).toEqual([0, 0]);
      expect(composed.payload.seq).toBe(b(2 * c.log_len));
      expect(composed.payload.settlement_weights).toEqual(oracleNetWorth(c.board, seatsOf(seatMappingOf(c.game))).map((row) => row.total));
      expectBuilderAgrees(args, composed);
    });
  }
});

/* ================================================================================================= */
/* H. The v13 certification files (generated, pinned) -- and the frozen files, unmoved                */
/* ================================================================================================= */

describe("H. the v13 evidence files are exactly what the primitives generate; every frozen v10 file and the v11 / v12 evidence files are byte-identical", () => {
  function generate(): { vectors: unknown; boards: unknown } {
    const vectorEntries = GAMES.map((g) => {
      const mapping = seatMappingOf(g);
      const seats = seatsOf(mapping);
      const appraisals = appraiseV13(g.terminal, seats);
      const args = vectorArgs(g);
      const composed = composeV13(args);
      const d = DETERMINISM.get(g.id)!;
      return {
        id: g.id,
        name: g.name,
        seed: g.seedName,
        pins: g.pins,
        history: "a constructed v13 starting board (pin 13, rules revision 2; settlementV13Vectors.ts), played through a RoomSession: ingress, the reducer, the room's derived entries; the terminal is RoomEngine's, never edited",
        reason: g.reason,
        reason_code: SETTLEMENT_REASON_CODE[g.reason],
        steps: g.played.map((step) => ({ label: step.label, actor: step.actor, answer: step.kind, ...(step.kind === "applied" ? {} : { reason: step.reason }), entries: step.entries })),
        log_len: g.entries.length,
        log_hash: g.log_hash,
        terminal: {
          state_digest: stateDigest(g.terminal),
          appraisal_state_hash: terminalStateHashV1(g.terminal),
          bankrupt_president: g.terminal.bankrupt_president ?? null,
          bankruptcy_record: (g.terminal as Loose).bankruptcy_record ?? null,
        },
        determinism: d,
        seat_mapping: mapping.map((player_id, seat_index) => ({ seat_index, player_id })),
        components: appraisals.map((seat) => ({ player_id: seat.player_id, bankrupt: seat.bankrupt, cash_in_state: seat.cash_state.toString(), cash: seat.cash_counted.toString(), shares: seat.shares.toString(), privates: seat.privates.toString(), total: seat.total.toString() })),
        vector: strings(appraisals.map((seat) => seat.total)),
        pools: [poolOf(seats.length), ...EXTRA_POOLS].map((pool) => {
          const preview = payoutPreview(pool, composed.payload.settlement_weights);
          return { pool_ujuno: pool.toString(), payouts_ujuno: strings(preview.payouts), dust_ujuno: preview.dust.toString() };
        }),
        domain_name: v13DomainForSeats(mapping.length).name,
        payload: settlementPayloadToWire(composed.payload),
        encoded: composed.encoded_hex,
        settle_digest: composed.settle_digest,
        consent_digest: composed.consent_digest,
      };
    });
    const checkpointEntries = CHECKPOINTS.map((c) => {
      const composed = composeV13(vectorArgs(c.game, c.board, c.log_len, { kind: "Checkpoint" }));
      const mapping = seatMappingOf(c.game);
      return {
        name: c.name,
        vector_id: c.game.id,
        log_len: c.log_len,
        round: `${c.board.current_round_type}/${c.board.macro_round_number}/${c.board.sub_round_index}`,
        appraisal_state_hash: terminalStateHashV1(c.board),
        seat_mapping: mapping.map((player_id, seat_index) => ({ seat_index, player_id })),
        vector: strings(composed.payload.settlement_weights),
        domain_name: v13DomainForSeats(mapping.length).name,
        payload: settlementPayloadToWire(composed.payload),
        encoded: composed.encoded_hex,
        settle_digest: composed.settle_digest,
        consent_digest: composed.consent_digest,
      };
    });
    const vectors = {
      format: "18JUNO/PHASE3/settlement-v13-certification/v1",
      rules_engine_version: 13,
      beside:
        "SET0A_golden_vectors_rev2.derived.json + settlementPayloadVectorsV1.json (v10, frozen), settlementV11CertificationVectors.json (v11, ESCROW-3A) and settlementV12CertificationVectors.json (v12, R12-3 / R12-4); none rewritten",
      source:
        "generated by frontend/src/utils/settlementV13Certification.test.ts: the thirteen SET-0A recipes run by the v13 engine at pin 13 (settlementGoldenBoards.v13GoldenBoards), and the v13 vectors V13-01 .. V13-21 played through a RoomSession (settlementV13Vectors.v13Vectors); payload bytes composed from the certified primitives (the v13 appraisal is the certified appraiser's, which reads the pin in its gate alone)",
      checked_by: "frontend/src/utils/__fixtures__/settlement/verify_v13_settlement_vectors.py (an independent Python appraisal over the terminal boards' canonical text, and the escrow crate's independent encoder; run by hand)",
      what_differs_from_v12:
        "golden set: terminal_state_hash_v1 (the pin is a board field); payload bytes [1,33) domain (u32 rules_engine_version is a domain input) and [91,123) appraisal_state_hash; hence the SETTLE and CONSENT digests. Nothing else: weights, payouts, dust, layout, codec, contract. Vectors: rules revision 2 changes which terminal boards are reachable (the automatic bankruptcy's liquidation and handover, the one-click Stock Round turn, the Brown continuation, the window, exact private-funding relevance, the atomic portfolio) -- through holdings, pool percentages, prices, treasuries and cash moved by ordinary sales and transfers, and the hashed bankruptcy_record; no field the appraiser reads changes meaning, and each vector's payload equals its v12 twin's (the same board at pin 12) outside [1,33) and [91,123).",
      cases: V10_GOLDEN.cases.map((entry) => {
        const appraisals = appraiseV13(boards[entry.name], seatsOf(entry.seat_mapping));
        const weights = terminalSettlementWeights(appraisals.map((seat) => seat.total), { reason: entry.reason } as never, TERMS);
        const preview = payoutPreview(b(entry.pool_ujuno), weights);
        return {
          name: entry.name,
          history: V13_RECIPE_HISTORY[entry.name],
          reason: entry.reason,
          reason_code: SETTLEMENT_REASON_CODE[entry.reason],
          appraisal_state_hash: terminalStateHashV1(boards[entry.name]),
          v10_appraisal_state_hash: entry.terminal_state_hash_v1,
          v11_appraisal_state_hash: (V11.cases as Loose[]).find((x) => x.name === entry.name)!.appraisal_state_hash,
          v12_appraisal_state_hash: (V12.cases as Loose[]).find((x) => x.name === entry.name)!.appraisal_state_hash,
          seat_mapping: entry.seat_mapping.map((player_id, seat_index) => ({ seat_index, player_id })),
          settlement_weights: strings(weights),
          pool_ujuno: preview.pool.toString(),
          payouts_ujuno: strings(preview.payouts),
          dust_ujuno: preview.dust.toString(),
        };
      }),
      domains: V13_DOMAINS.map((d) => ({
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
        v11_domain: d.v11_domain,
        v12_domain: d.v12_domain,
      })),
      payload_vectors: (V10_PAYLOADS.payload_vectors as Loose[]).map((v) => {
        const composed = composeV13(v13ArgsFor(v));
        const preview = payoutPreview(b(v.pool_ujuno), composed.payload.settlement_weights);
        return {
          name: v.name,
          source_case: v.source_case,
          usage: v.usage,
          domain_name: v13DomainFor(v.domain_name).name,
          seat_mapping: v.seat_mapping,
          payload: settlementPayloadToWire(composed.payload),
          encoded_len: composed.encoded_hex.length / 2,
          encoded: composed.encoded_hex,
          settle_digest: composed.settle_digest,
          consent_digest: composed.consent_digest,
          v10_differing_byte_ranges: [DOMAIN_BYTES, APPRAISAL_HASH_BYTES],
          pool_ujuno: preview.pool.toString(),
          payouts_ujuno: strings(preview.payouts),
          dust_ujuno: preview.dust.toString(),
        };
      }),
      vectors: vectorEntries,
      checkpoints: checkpointEntries,
    };
    const terminalBoards = {
      format: "18JUNO/PHASE3/settlement-v13-terminal-boards/v1",
      rules_engine_version: 13,
      source: "generated by frontend/src/utils/settlementV13Certification.test.ts: canonicalStateText of every v13 vector's terminal board and of every v13 checkpoint board",
      boards: Object.fromEntries(GAMES.map((g) => [g.name, canonicalStateText(g.terminal)])),
      checkpoints: Object.fromEntries(CHECKPOINTS.map((c) => [c.name, canonicalStateText(c.board)])),
    };
    return { vectors, boards: terminalBoards };
  }

  it("settlementV13CertificationVectors.json and settlementV13TerminalBoards.json are exactly what the primitives generate (UPDATE_SETTLEMENT_V13_VECTORS=1 rewrites them)", () => {
    const generated = generate();
    const vectorsText = `${JSON.stringify(generated.vectors, null, 1)}\n`;
    const boardsText = `${JSON.stringify(generated.boards, null, 1)}\n`;
    if (process.env.UPDATE_SETTLEMENT_V13_VECTORS === "1") {
      writeFileSync(V13_FILE, vectorsText);
      writeFileSync(V13_BOARDS_FILE, boardsText);
    }
    expect(existsSync(V13_FILE)).toBe(true);
    expect(readFileSync(V13_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(vectorsText);
    expect(existsSync(V13_BOARDS_FILE)).toBe(true);
    expect(readFileSync(V13_BOARDS_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(boardsText);
  });

  it("the pinned evidence re-derives: each terminal board's text hashes to its appraisal_state_hash and appraises to its vector", () => {
    const pinned = readJson(V13_FILE) as Loose;
    const texts = (readJson(V13_BOARDS_FILE) as Loose).boards as Record<string, string>;
    for (const entry of pinned.vectors as Loose[]) {
      const text = texts[entry.name];
      expect([entry.name, terminalStateHashV1(JSON.parse(text) as GameStateResponse)]).toEqual([entry.name, entry.terminal.appraisal_state_hash]);
      const seats = (entry.seat_mapping as Loose[]).map((s) => ({ seat_index: s.seat_index, player_id: s.player_id }));
      expect([entry.name, oracleNetWorth(JSON.parse(text) as GameStateResponse, seats).map((row) => row.total.toString())]).toEqual([entry.name, entry.vector]);
    }
  });

  it("the v13 files name v13 alone; the v12 file still v12 alone; the v11 file v11 alone; the frozen v10 payload files v10 alone", () => {
    const pins = (file: string) => new Set(Array.from(readFileSync(file, "utf8").matchAll(/"rules_engine_version":\s*(\d+)/g)).map((m) => Number(m[1])));
    expect(pins(V13_FILE)).toEqual(new Set([13]));
    expect(pins(V12_FILE)).toEqual(new Set([12]));
    expect(pins(V11_FILE)).toEqual(new Set([11]));
    expect(pins(join(SETTLEMENT, "settlementPayloadVectorsV1.json"))).toEqual(new Set([10]));
    const boardsFile = readFileSync(V13_BOARDS_FILE, "utf8");
    expect(new Set(Array.from(boardsFile.matchAll(/\\"rules_engine_version\\":(\d+)/g)).map((m) => Number(m[1])))).toEqual(new Set([13]));
    const rust = join(REPO, "contracts", "escrow", "testdata", "payload_vectors_v1.json");
    if (existsSync(rust)) expect(pins(rust)).toEqual(new Set([10]));
  });

  it("every frozen v10 settlement file and the v11 and v12 evidence files are byte-identical to their certified SHA-256 (LF-normalised)", () => {
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

