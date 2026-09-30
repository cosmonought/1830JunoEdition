/** @jest-environment node */
// frontend/src/utils/settlementV12Certification.test.ts
//
// ==================================================================
//  ROUTE v12 R12-3: RULES ENGINE v12 CERTIFIED FOR SETTLEMENT, BESIDE v10 AND v11 -- NEVER OVER THEM
// ==================================================================
//
// R12-2 moved the gameplay engine to v12 and left settlement at [10, 11] (two axes, DA-8). This file is the v12
// certification evidence that let R12-3 add 12 to `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS`, and it keeps proving
// it. It follows ESCROW-3A's v11 architecture (`settlementV11Certification.test.ts`) and adds what v11 did not need:
// v12 changes ROUTE LAW, so it can change the HISTORY that produces a terminal board, and that is certified on real
// forks rather than assumed from restamped boards.
//
// THE SET-0A AUDIT, RERUN AGAINST v12. The appraiser reads only `rules_engine_version, player_addresses, player_cash,
// public_companies[].{company_id, ticker, player_holdings, ipo_pool_percentage, bank_pool_percentage, par_value},
// market_positions, private_companies[].{private_id, closed, owner, owner_protocol_id, cost}, bankrupt_president,
// current_round_type` (SET-0A §4). Row 12 of the rules changelog names what v12 changed:
//   (1) THE ROUTE LAW -- a red area is one city (IL-5); a bare token / the H12 herald counts only where the route
//       stops (IL-7, IL-3); Coal River refuses an unlicensed END;
//   (2) PRICING -- a bypassed waypoint never uses up its city (IL-11);
//   (3) THE DEMONSTRATION -- re-entry, the herald pass, the join through the stop, every candidate judged by the
//       authority, `maxRouteRevenueFor` only a set the authority accepts (the S6-3 shortfall, the skip refusal, the
//       auto-skip, the forced-purchase probe);
//   (4) BOARD DATA -- Montreal $40/$60 and Norfolk $30/$50 on the 1830+ map, each one city with two circles; tile #62
//       $80 per city (the owner's ruling, folded into v12; the 1830+ / LPF New York tile #883 stays $90);
//   (5) ING-1 -- a paid station on a two-city hex must name its city.
// Every one of them changes WHICH run is legal, WHAT it pays, WHO must run or buy, or WHERE a station may go. None
// changes what a READ field MEANS:
//   * route revenue is not an appraisal input; it reaches the board only through the dividend / withhold ledger
//     (`player_cash`, treasuries -- not read -- and the bank) and the chart's price step (`market_positions`), both
//     unchanged in v12 -- so cash is still whole VGP moved only by the ledger, a mark still the parred corporation's
//     share value on a real chart cell;
//   * holdings, IPO and pool percentages still conserve 100 (no v12 rule moves a certificate);
//   * privates: no v12 rule opens, closes, sells or prices one; `closed` still ends its value, `cost` is still face;
//   * bankruptcy: the demonstration feeds the forced-purchase probe (`hasLegalRouteFor`), so v12 can change WHETHER a
//     president reaches bankruptcy on a given board -- never what `bankrupt_president` means (6.6.3's rule, SET-0A v3);
//   * end conditions: `current_round_type` / bank breaking are unchanged mechanisms.
// So the appraisal formula is unchanged and still the correct reading of a v12 board -- and v12 boards legitimately
// DIFFER from v11 ones, through exactly those channels. The forks (G) show both halves on real turns.
//
// THE EVIDENCE BELOW:
//   A. the v12 golden set (the thirteen SET-0A recipes through the v12 engine, at pin 12): re-stamped at 10 each is
//      its certified v10 board, at 11 its certified v11 board; which recipes are v12 HISTORIES and which are pre-v12
//      corpus replays carried as v12 board shapes is stated, never blurred;
//   B. every vector, component, payout and dust value equals SET-0A rev 2's (and the rankPlayers parity);
//   C. the fifteen SET-0C payloads rebuilt at v12: identical to the frozen v10 bytes -- and to the v11 certification's
//      -- outside [1,33) `domain` and [91,123) `appraisal_state_hash`; same codec, digests, payout arithmetic, contract;
//   D. v10, v11 and v12 coexist, each board settling only under a domain declaring its own pin;
//   E. every uncertified pin (9, 13, 14, …, RULES_ENGINE_VERSION + 1) fails closed; the certified list is a literal;
//   F. SET-0A §14's parity sweep at pin 12 on every board of the five in-repo logs;
//   G. THE v12 FORKS (`settlementV12Forks.ts`): three turns the v11 and v12 laws play differently -- a real PRR turn
//      (re-entry past the herald, the S6-3 demonstration), a real B&O turn (Norfolk's two circles and $30) and a
//      constructed NYC turn over #62 ($80 against $90) -- each played BOTH ways through a server room: the terminal
//      boards differ, and they differ ONLY in cash (each seat by exactly its dividend difference), the bank and the
//      treasury ledger, with the price, holdings and privates identical and VGP conserved; each appraises, matches
//      rankPlayers, and its v12 side is pinned (vector, payouts, dust, payload bytes);
//   H. the v12 evidence file is exactly what the primitives generate; every frozen v10 file AND the v11 evidence file
//      are byte-identical.
//
// The v12 values are pinned in `__fixtures__/settlement/settlementV12CertificationVectors.json`, GENERATED by this file
// (`UPDATE_SETTLEMENT_V12_VECTORS=1` rewrites it) -- a new file beside the frozen v10 and v11 ones, none rewritten.

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
  SET0A_V12_RULES_ENGINE_VERSION,
  V12_RECIPE_HISTORY,
  atV12SettlementPin,
  readExport,
  readJsonl,
  replayBoards,
  v12GoldenBoards,
} from "./settlementGoldenBoards";
import { v12Forks, type ForkSide, type V12Fork } from "./settlementV12Forks";
import * as GR from "./gentleRustCertificationGame";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SETTLEMENT = join(__dirname, "__fixtures__", "settlement");
const REPO = join(__dirname, "..", "..", "..");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const b = (value: string | number) => BigInt(value);
const strings = (values: readonly bigint[]) => values.map((value) => value.toString());
const seatsOf = (ids: readonly string[]): SettlementSeat[] => ids.map((player_id, seat_index) => ({ seat_index, player_id }));

/* The frozen v10 evidence and the v11 certification evidence -- READ, never written. */
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

/* Frozen files this certification must never move, by content hash (LF-normalised): PROJECT_CANONICAL_CONTEXT §D.4's
   five v10 files, and ESCROW-3A's v11 evidence file. */
const FROZEN = [
  ["contracts/escrow/testdata/payload_vectors_v1.json", "635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac"],
  ["frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json", "b58651de13de2c4f91d355c15cca92689001ba4bcbdb2a9fbaa348cbe6a7906c"],
  ["contracts/escrow/testdata/set0a_payout_vectors_rev2.json", "dfe9fbdfa8f88c21bd5cc8eeecbd06f0ef7db4ce6ba8bf72aa4633b7a39d4994"],
  ["frontend/src/utils/__fixtures__/settlement/SET0A_golden_vectors_rev2.derived.json", "c16fb8170d38a6b6870d0e39091337d82d89fc2a54bb29f41b98cc98a5c7721a"],
  ["frontend/src/utils/__fixtures__/settlement/settlementCrossLanguageVectors.json", "50bf34e1374767df4e3273198cfe6537ba7f73fefd51d9a437b0f113c3015d74"],
  ["frontend/src/utils/__fixtures__/settlement/settlementV11CertificationVectors.json", "cf62e6d775a46093039d5c2a1c6137934d3ac594ac702b8c27ee538090c80692"],
] as const;

const { boards, dealtPins, syn01Submissions } = v12GoldenBoards();
const ANTE_NET = b(V10_GOLDEN.ante.ante_net_ujuno);
const TERMS = { pool_net_ujuno: b(0), ante_net_ujuno: ANTE_NET };

const atPin = (board: GameStateResponse, pin: number) => ({ ...board, rules_engine_version: pin }) as GameStateResponse;

/* ------------------------------------------------------------------ */
/* The v12 domains: SET-0C's five domains, the rules engine set to 12   */
/* ------------------------------------------------------------------ */

interface V12Domain {
  name: string;
  v10_name: string;
  wallets: string[];
  inputs: SettlementDomainInputs;
  domain: string;
  v10_domain: string;
  v11_domain: string;
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

const V12_DOMAINS: V12Domain[] = (V10_PAYLOADS.domains as Loose[]).map((d) => {
  const inputs = inputsOf(d, SET0A_V12_RULES_ENGINE_VERSION);
  const v11 = (V11.domains as Loose[]).find((x) => x.v10_domain_name === d.name)!;
  return { name: `${d.name}/rules-v12`, v10_name: d.name, wallets: d.roster_wallets, inputs, domain: settlementDomainV1(inputs), v10_domain: d.domain, v11_domain: v11.domain };
});
const v12DomainFor = (v10Name: string) => V12_DOMAINS.find((d) => d.v10_name === v10Name)!;

/* ------------------------------------------------------------------ */
/* The v12 payloads: SET-0C's fifteen, rebuilt on the v12 boards/domains */
/* ------------------------------------------------------------------ */

const REASON_NAME: Record<number, "BankBroken" | "Bankruptcy" | "ResolverCorrection"> = { 1: "BankBroken", 2: "Bankruptcy", 5: "ResolverCorrection" };

/** The v12 counterpart of a SET-0C source board: the v12 golden board, or the GR-4 start (a mid-game board the room
 *  deals at the current engine) at the v12 pin. */
const v12BoardOf = (v: Loose): GameStateResponse =>
  String(v.source_case).startsWith("GR-4") ? atV12SettlementPin(GR.certificationStart()) : boards[v.source_case];

function v12ArgsFor(v: Loose): BuildSettlementPayloadArgs {
  const d = v12DomainFor(v.domain_name);
  const p = v.payload;
  const intent: SettlementPayloadIntent =
    p.kind === 0 ? { kind: "Checkpoint" } : { kind: "Terminal", outcome: { reason: REASON_NAME[p.reason] }, terms: TERMS };
  const mapping = v.seat_mapping as Array<{ chain_seat_index: number; player_id: string }>;
  return {
    board: { state: v12BoardOf(v) },
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

function code(run: () => unknown): string {
  try {
    run();
    return "OK";
  } catch (error) {
    if (error instanceof SettlementPayloadError || error instanceof SettlementAppraisalError) return error.code;
    throw error;
  }
}

function rankedWorth(state: GameStateResponse): Record<string, number> {
  const marks = (state.market_positions ?? {}) as Record<number, { price: number } | null>;
  const out: Record<string, number> = {};
  for (const row of rankPlayers({ state, priceForCompany: (id) => marks[id]?.price ?? null, labelForAddress: (address) => address, bankruptAddress: state.bankrupt_president ?? null })) {
    out[row.address] = row.netWorth;
  }
  return out;
}

/* ================================================================================================= */
/* A. The v12 golden set                                                                            */
/* ================================================================================================= */

describe("A. the v12 golden set: the SET-0A recipes through the v12 engine, at pin 12, each its certified v10 and v11 board but for the pin", () => {
  it("covers exactly the thirteen SET-0A cases; SYN-01 reaches GameEnd in the recorded 20 submissions", () => {
    expect(Object.keys(boards).sort()).toEqual(V10_GOLDEN.cases.map((entry) => entry.name).sort());
    expect(syn01Submissions).toBe(20);
  });

  it("the room-dealt recipes are DEALT AND PLAYED by the v12 engine (pinned, so under the v12 route law); every board carries pin 12", () => {
    expect([SET0A_CERTIFIED_RULES_ENGINE_VERSION, SET0A_V11_RULES_ENGINE_VERSION, SET0A_V12_RULES_ENGINE_VERSION]).toEqual([10, 11, 12]);
    expect(RULES_ENGINE_VERSION).toBe(12);
    expect(Object.values(dealtPins)).toEqual([12, 12, 12]);
    for (const board of Object.values(boards)) expect(board.rules_engine_version).toBe(12);
  });

  it("what each recipe IS under v12 is stated: nine v12 room games (seven of them grafted), four pre-v12 corpus replays carried as board shapes", () => {
    expect(Object.keys(V12_RECIPE_HISTORY).sort()).toEqual(Object.keys(boards).sort());
    const count = (kind: string) => Object.values(V12_RECIPE_HISTORY).filter((entry) => entry === kind).length;
    expect([count("v12-room-game"), count("v12-room-game+graft"), count("pre-v12-corpus-replay+graft")]).toEqual([2, 7, 4]);
    for (const name of Object.keys(dealtPins)) expect(V12_RECIPE_HISTORY[name]).toMatch(/^v12-room-game/);
  });

  for (const entry of V10_GOLDEN.cases) {
    it(`${entry.name}: at 10 it IS the certified v10 board, at 11 the certified v11 board; at 12 only the pin differs`, () => {
      const v12 = boards[entry.name];
      expect(v12.current_round_type).toBe("GameEnd");
      expect(v12.player_addresses).toEqual(entry.turn_order);
      expect(terminalStateHashV1(atPin(v12, 10))).toBe(entry.terminal_state_hash_v1);
      const v11Case = (V11.cases as Loose[]).find((x) => x.name === entry.name)!;
      expect(terminalStateHashV1(atPin(v12, 11))).toBe(v11Case.appraisal_state_hash);
      const hash12 = terminalStateHashV1(v12);
      expect([hash12 === entry.terminal_state_hash_v1, hash12 === v11Case.appraisal_state_hash]).toEqual([false, false]);
      const text12 = canonicalStateText(v12);
      expect(text12.split('"rules_engine_version":12').length).toBe(2);
      expect(text12.replace('"rules_engine_version":12', '"rules_engine_version":11')).toBe(canonicalStateText(atPin(v12, 11)));
    });
  }
});

/* ================================================================================================= */
/* B. The v12 appraisal of the golden set: every SET-0A value, unchanged                             */
/* ================================================================================================= */

describe("B. the v12 golden boards through the committed-state pipeline: exactly SET-0A rev 2's vectors, components, payouts and dust", () => {
  for (const entry of V10_GOLDEN.cases) {
    it(entry.name, () => {
      const board = boards[entry.name];
      const committed = appraiseCommittedState(canonicalStateText(board), seatsOf(entry.seat_mapping));
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

describe("C. the fifteen SET-0C payloads rebuilt at v12: identical to the frozen v10 bytes and the v11 certification's outside `domain` and `appraisal_state_hash`", () => {
  it("the v12 domains are SET-0C's five with only the u32 rules engine changed -- and it moves each domain off v10's and v11's", () => {
    expect(V12_DOMAINS).toHaveLength(5);
    for (const d of V12_DOMAINS) {
      const v10 = (V10_PAYLOADS.domains as Loose[]).find((x) => x.name === d.v10_name)!;
      expect(settlementDomainV1(inputsOf(v10, 10))).toBe(v10.domain);
      expect(settlementDomainV1(inputsOf(v10, 11))).toBe(d.v11_domain);
      expect(new Set([d.domain, d.v10_domain, d.v11_domain]).size).toBe(3);
      expect(d.domain).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  for (const v of V10_PAYLOADS.payload_vectors as Loose[]) {
    it(`${v.name}: v12 bytes = v10 bytes = v11 bytes except [1,33) domain and [91,123) appraisal_state_hash; same weights, payouts, dust`, () => {
      const built = buildSettlementPayloadV1(v12ArgsFor(v));
      expect(built.usage).toBe(v.usage);
      expect(built.encoded_hex.length / 2).toBe(v.encoded_len);
      const v11 = (V11.payload_vectors as Loose[]).find((x) => x.name === v.name)!;
      for (const other of [v.encoded, v11.encoded]) {
        const differ = differingOffsets(built.encoded_hex, other);
        expect(differ.length).toBeGreaterThan(0);
        expect(onlyPinBytes(differ)).toBe(true);
      }
      expect(built.payload.domain).toBe(v12DomainFor(v.domain_name).domain);
      expect(built.payload.appraisal_state_hash).toBe(terminalStateHashV1(v12BoardOf(v)));
      const { domain: _d, appraisal_state_hash: _h, ...rest12 } = built.wire as Loose;
      const { domain: _d10, appraisal_state_hash: _h10, ...rest10 } = v.payload as Loose;
      void _d;
      void _h;
      void _d10;
      void _h10;
      expect(rest12).toEqual(rest10);
      expect(new Set([built.settle_digest, v.settle_digest, v11.settle_digest]).size).toBe(3);
      expect(code(() => checkSettlementPayloadV1(built.payload, built.usage))).toBe("OK");
      expect(decodeSettlementPayloadV1(hexToBytes(built.encoded_hex))).toEqual(built.payload);
      const preview = payoutPreview(b(v.pool_ujuno), built.payload.settlement_weights);
      expect(strings(preview.payouts)).toEqual(v.payouts_ujuno);
      expect(preview.dust.toString()).toBe(v.dust_ujuno);
      const verified = verifySettlementPayloadV1(built.payload, built.canonical_text, built.seats, TERMS);
      expect(verified.settle_digest).toBe(built.settle_digest);
    });
  }

  it("the chain-neutral core (GNOLAND-1) with the certified Juno codec builds the identical v12 bytes -- no codec change", () => {
    for (const v of V10_PAYLOADS.payload_vectors as Loose[]) {
      const args = v12ArgsFor(v);
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
/* D. v10, v11 and v12 coexist, each bound to its own pin                                            */
/* ================================================================================================= */

describe("D. coexistence: each board settles under a domain declaring its own pin, and never crosswise", () => {
  const v = (V10_PAYLOADS.payload_vectors as Loose[]).find((x) => x.name === "SYN-01-CLASSIC-BANKBREAK/terminal-BankBroken")!;
  const v12Args = v12ArgsFor(v);
  const v10Domain = (V10_PAYLOADS.domains as Loose[]).find((x) => x.name === v.domain_name)!;
  const argsAt = (pin: number): BuildSettlementPayloadArgs => {
    const inputs = inputsOf(v10Domain, pin);
    return { ...v12Args, board: { state: atPin(boards["SYN-01-CLASSIC-BANKBREAK"], pin) }, domain: settlementDomainV1(inputs), domain_inputs: inputs };
  };

  it("all three certified: v10 reproduces the frozen v10 vector, v11 the v11 certification's, v12 builds", () => {
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).toEqual([10, 11, 12]);
    expect(buildSettlementPayloadV1(argsAt(10)).encoded_hex).toBe(v.encoded);
    expect(buildSettlementPayloadV1(argsAt(11)).encoded_hex).toBe((V11.payload_vectors as Loose[]).find((x) => x.name === v.name)!.encoded);
    expect(buildSettlementPayloadV1(argsAt(12)).encoded_hex).toBe(buildSettlementPayloadV1(v12Args).encoded_hex);
  });

  it("every crosswise pair is RULES_ENGINE_VERSION_MISMATCH: the domain's declared engine must be the board's pin", () => {
    for (const boardPin of [10, 11, 12]) {
      for (const domainPin of [10, 11, 12]) {
        if (boardPin === domainPin) continue;
        const args = { ...argsAt(domainPin), board: argsAt(boardPin).board };
        expect([boardPin, domainPin, code(() => buildSettlementPayloadV1(args))]).toEqual([boardPin, domainPin, "RULES_ENGINE_VERSION_MISMATCH"]);
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

  it("the literal is [10, 11, 12], frozen; the gameplay axis is separate (a future bump is refused until certified)", () => {
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS).toEqual([10, 11, 12]);
    expect(Object.isFrozen(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS)).toBe(true);
    expect(SUPPORTED_RULES_ENGINE_VERSIONS).toEqual([RULES_ENGINE_VERSION]);
    const source = readFileSync(join(__dirname, "..", "gameEngine", "settlementAppraisal.ts"), "utf8");
    expect(source).toContain("SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS: readonly number[] = Object.freeze([10, 11, 12]);");
    expect(source).not.toMatch(/from\s+"\.\/rulesVersion"/);
  });

  it("9, 13, 14, 999, 2^31 and RULES_ENGINE_VERSION + 1 are refused before a value is read", () => {
    for (const pin of [9, 13, 14, 999, 2 ** 31, RULES_ENGINE_VERSION + 1]) {
      expect(() => appraiseSeats(atPin(board, pin), seats)).toThrow(`UNSUPPORTED_RULES_ENGINE_VERSION: rules_engine_version=${pin} (supported: 10, 11, 12)`);
    }
  });

  it("a pin that is not a safe integer number is refused too ('12', 12.5, -12, null)", () => {
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: "12" } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: 12.5 } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: -12 } as never, seats))).toBe("UNSUPPORTED_RULES_ENGINE_VERSION");
    expect(code(() => appraiseSeats({ ...board, rules_engine_version: null } as never, seats))).toBe("UNPINNED_BOARD");
  });

  it("a v13 domain on a v13 board is refused by the builder's appraisal: no bytes are ever written for it", () => {
    const v = (V10_PAYLOADS.payload_vectors as Loose[])[0];
    const args = v12ArgsFor(v);
    const d13 = { ...(args.domain_inputs as SettlementDomainInputs), rules_engine_version: 13 };
    expect(code(() => buildSettlementPayloadV1({ ...args, board: { state: atPin(v12BoardOf(v), 13) }, domain: settlementDomainV1(d13), domain_inputs: d13 }))).toBe(
      "UNSUPPORTED_RULES_ENGINE_VERSION",
    );
  });
});

/* ================================================================================================= */
/* F. The SET-0A corpus parity sweep, at pin 12                                                     */
/* ================================================================================================= */

describe("F. SET-0A §14's parity sweep at the v12 pin: rankPlayers equals the appraiser on every corpus board", () => {
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
      const state = atPin(board, 12);
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
    it(`${log.name}: every board appraised at pin 12, 0 mismatches, 0 refusals`, () => {
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
    it(`server/${file}: parity at pin 12 on every board, 0 refusals`, () => {
      const result = sweep(readJsonl(join(SERVER_DATA_DIR, file)));
      expect(result.mismatches).toEqual([]);
      expect(result.refusals).toEqual([]);
    });
  }
});

/* ================================================================================================= */
/* G. The v12 forks: what the v12 law does to a terminal board, and what it does not                 */
/* ================================================================================================= */

const FORKS = v12Forks();
const THREE_SEAT = V12_DOMAINS.find((d) => d.v10_name === "set0c-juno-1-3-seat-live-game-3")!;
const SYN05 = (V10_PAYLOADS.payload_vectors as Loose[]).find((x) => x.name === "SYN-05-Z6C-COMPOSED-END/terminal-BankBroken")!;
const FORK_POOL = b(SYN05.pool_ujuno);

const vgpTotal = (state: GameStateResponse): bigint =>
  state.player_cash.reduce((sum, row) => sum + b(row.cash_vgp), b(0)) +
  state.public_companies.reduce((sum, company) => sum + b((company as Loose).treasury ?? "0"), b(0)) +
  b(state.virtual_bank_vgp);

/** The v12 side's settlement payload: Terminal BankBroken on the three-seat SET-0C domain at rules 12, over the turn's
 *  own entries (SET-0C's remaining test fields -- schema, signer, issued_at -- as SYN-05's frozen vector has them). */
function forkArgs(fork: V12Fork, side: ForkSide = fork.v12, domain: V12Domain = THREE_SEAT): BuildSettlementPayloadArgs {
  const ids = side.terminal.player_addresses;
  const logLen = b(side.entries.length);
  return {
    board: { state: side.terminal },
    bindings: ids.map((player_id, chain_seat_index) => ({ chain_seat_index, player_id, wallet: domain.wallets[chain_seat_index] })),
    domain: domain.domain,
    domain_inputs: domain.inputs,
    intent: { kind: "Terminal", outcome: { reason: "BankBroken" }, terms: TERMS },
    log_len: logLen,
    log_hash: side.log_hash,
    appraisal_log_len: logLen,
    state_schema_version: SYN05.payload.state_schema_version,
    signer_key_id: SYN05.payload.signer_key_id,
    issued_at: b(SYN05.payload.issued_at),
  };
}

/** Every field path at which two boards differ (objects walked, arrays compared per index / per company id). */
function differingPaths(a: unknown, c: unknown, path = "$"): string[] {
  if (JSON.stringify(a) === JSON.stringify(c)) return [];
  if (typeof a !== "object" || typeof c !== "object" || a === null || c === null || Array.isArray(a) !== Array.isArray(c)) return [path];
  if (Array.isArray(a)) {
    const left = a as Loose[];
    const right = c as Loose[];
    if (left.length !== right.length) return [path];
    const key = (row: Loose, i: number) => (row && typeof row === "object" && "company_id" in row ? `[${row.company_id}]` : row && typeof row === "object" && "player" in row ? `[${row.player}]` : `[${i}]`);
    return left.flatMap((row, i) => differingPaths(row, right[i], `${path}${key(row, i)}`));
  }
  const keys = Array.from(new Set([...Object.keys(a as Loose), ...Object.keys(c as Loose)])).sort();
  return keys.flatMap((k) => differingPaths((a as Loose)[k], (c as Loose)[k], `${path}.${k}`));
}

describe("G. the v12 forks: three turns the v11 and v12 laws play differently, played both ways through a server room", () => {
  it("there are three: a real PRR turn (re-entry past the herald), a real B&O turn (Norfolk), a constructed #62 turn", () => {
    expect(FORKS.map((fork) => [fork.name, fork.company_id])).toEqual([
      ["V12-FORK-Z6C-215-PRR", 1],
      ["V12-FORK-Z6C-271-BO", 4],
      ["V12-FORK-GR4-62-NYC", 2],
    ]);
  });

  describe.each(FORKS.map((fork) => [fork.name, fork] as const))("%s", (_name, fork) => {
    const { v11, v12 } = fork;

    it("the two laws disagree at this turn, and each side ran exactly what its own law demonstrates", () => {
      expect(v12.printed).not.toBe(v11.printed);
      expect(v12.revenue).not.toBe(v11.revenue);
      // Each side's run is its own law's demonstration (S6-3): nothing either side ran was short of it (printed).
      expect(v12.printed).toBe(v12.demonstrated);
      expect(v11.printed).toBe(v11.demonstrated);
      // The same board went into both rooms, the pin aside.
      expect(differingPaths(v11.before, v12.before)).toEqual(["$.rules_engine_version"]);
    });

    it("on the real game, the v11 law accepts the RECORDED run; the v12 law refuses it as short of its demonstration", () => {
      if (v11.recordedRunAnswer === null) {
        expect(fork.name).toBe("V12-FORK-GR4-62-NYC"); // constructed: no recorded run
        return;
      }
      expect(v11.recordedRunAnswer.kind).toBe("applied");
      expect(v12.recordedRunAnswer!.kind).not.toBe("applied");
      expect(v12.recordedRunAnswer!.reason).toMatch(new RegExp(`\\$${v12.demonstrated}`));
    });

    it("the terminal boards differ ONLY in cash, the bank, the running corporation's recorded revenue -- never a price, a holding or a private", () => {
      const paths = differingPaths(v11.after, v12.after).filter((path) => path !== "$.rules_engine_version");
      const allowed = (path: string) =>
        /^\$\.player_cash\[[^\]]+\]\.cash_vgp$/.test(path) ||
        path === "$.virtual_bank_vgp" ||
        new RegExp(`^\\$\\.public_companies\\[${fork.company_id}\\]\\.(last_route_revenue|printed_route_revenue|treasury|last_run_breakdown\\[\\d+\\]\\.[a-z_]+)$`).test(path);
      expect(paths.filter((path) => !allowed(path))).toEqual([]);
      expect(paths.some((path) => path.startsWith("$.player_cash"))).toBe(true);
      expect(v12.after.market_positions).toEqual(v11.after.market_positions);
      expect(v12.after.private_companies).toEqual(v11.after.private_companies);
      for (const company of v12.after.public_companies) {
        const other = v11.after.public_companies.find((entry) => entry.company_id === company.company_id)!;
        expect([company.ticker, company.player_holdings, company.ipo_pool_percentage, company.bank_pool_percentage, company.par_value]).toEqual([
          other.ticker,
          other.player_holdings,
          other.ipo_pool_percentage,
          other.bank_pool_percentage,
          other.par_value,
        ]);
      }
    });

    it("VGP is conserved: players + treasuries + bank is the same before the turn and after it, on both sides", () => {
      expect(vgpTotal(v11.after)).toBe(vgpTotal(v11.before));
      expect(vgpTotal(v12.after)).toBe(vgpTotal(v12.before));
    });

    it("both terminal boards appraise (v11 at pin 11, v12 at 12) and equal rankPlayers; the vectors differ by EXACTLY each seat's dividend difference", () => {
      const ids = v12.terminal.player_addresses;
      const a11 = appraiseSeats(v11.terminal, seatsOf(ids));
      const a12 = appraiseSeats(v12.terminal, seatsOf(ids));
      for (const [board, seats] of [[v11.terminal, a11], [v12.terminal, a12]] as const) {
        const ranked = rankedWorth(board);
        for (const seat of seats) expect(ranked[seat.player_id]).toBe(Number(seat.total.toString()));
      }
      const company = v12.after.public_companies.find((entry) => entry.company_id === fork.company_id)!;
      const perShare = b(v12.revenue - v11.revenue) / b(10);
      expect(perShare * b(10)).toBe(b(v12.revenue - v11.revenue)); // whole-dollar per share on every fork
      /* The rest of the dividend difference, where it went: the running corporation's treasury (its pool / IPO share
         of the dividend, per the engine's rule) and the bank that paid it -- the two sides' deltas sum to zero. */
      const treasuryOf = (board: GameStateResponse) => b(((board.public_companies.find((entry) => entry.company_id === fork.company_id) as Loose).treasury ?? "0") as string);
      const seatDelta = a12.reduce((sum, seat, index) => sum + (seat.cash_state - a11[index].cash_state), b(0));
      const treasuryDelta = treasuryOf(v12.after) - treasuryOf(v11.after);
      const bankDelta = b(v12.after.virtual_bank_vgp) - b(v11.after.virtual_bank_vgp);
      expect(seatDelta + treasuryDelta + bankDelta).toBe(b(0));
      const held = company.player_holdings.reduce((sum, row) => sum + row.percentage, 0);
      expect(seatDelta).toBe((b(held) / b(10)) * perShare);
      a12.forEach((seat, index) => {
        const was = a11[index];
        const pct = company.player_holdings.find((row) => row.player === seat.player_id)?.percentage ?? 0;
        expect([seat.player_id, seat.shares - was.shares, seat.privates - was.privates]).toEqual([seat.player_id, b(0), b(0)]);
        expect([seat.player_id, seat.cash_state - was.cash_state, seat.total - was.total]).toEqual([
          seat.player_id,
          (b(pct) / b(10)) * perShare,
          (b(pct) / b(10)) * perShare,
        ]);
      });
    });

    it("the v12 side settles: weights = vector, a payload at the v12 domain that checks, decodes, verifies -- and refuses a v11 domain", () => {
      const built = buildSettlementPayloadV1(forkArgs(fork));
      expect(built.payload.appraisal_state_hash).toBe(terminalStateHashV1(v12.terminal));
      expect(code(() => checkSettlementPayloadV1(built.payload, built.usage))).toBe("OK");
      expect(decodeSettlementPayloadV1(hexToBytes(built.encoded_hex))).toEqual(built.payload);
      expect(verifySettlementPayloadV1(built.payload, built.canonical_text, built.seats, TERMS).settle_digest).toBe(built.settle_digest);
      const v11Domain = { ...THREE_SEAT, inputs: { ...THREE_SEAT.inputs, rules_engine_version: 11 }, domain: THREE_SEAT.v11_domain };
      expect(code(() => buildSettlementPayloadV1(forkArgs(fork, v12, v11Domain)))).toBe("RULES_ENGINE_VERSION_MISMATCH");
      // The v11 side is a certified v11 board and settles under its own domain; the two payloads differ in weights.
      const v11Built = buildSettlementPayloadV1(forkArgs(fork, v11, v11Domain));
      expect(strings(v11Built.payload.settlement_weights)).not.toEqual(strings(built.payload.settlement_weights));
    });
  });
});

/* ================================================================================================= */
/* H. The v12 certification vector file (generated, pinned) -- and the frozen files, unmoved          */
/* ================================================================================================= */

describe("H. the v12 evidence file is exactly what the primitives generate; every frozen v10 file and the v11 evidence file are byte-identical", () => {
  function generate(): unknown {
    return {
      format: "18JUNO/R12-3/settlement-v12-certification/v1",
      rules_engine_version: 12,
      beside:
        "SET0A_golden_vectors_rev2.derived.json + settlementPayloadVectorsV1.json (v10, frozen) and settlementV11CertificationVectors.json (v11, ESCROW-3A); none rewritten",
      source:
        "generated by frontend/src/utils/settlementV12Certification.test.ts: the thirteen SET-0A recipes run by the v12 engine at pin 12 (settlementGoldenBoards.v12GoldenBoards), and the three v12 forks (settlementV12Forks.v12Forks), through the certified pipeline and builder",
      what_differs_from_v10_and_v11:
        "golden set: terminal_state_hash_v1 (the pin is a board field); payload bytes [1,33) domain (u32 rules_engine_version is a domain input) and [91,123) appraisal_state_hash; hence the SETTLE and CONSENT digests. Nothing else: weights, payouts, dust, layout, codec, contract. Forks: the v12 route law changes a turn's revenue, and the terminal board differs from the v11 law's only in cash (each seat by exactly its dividend difference), the bank and the running corporation's ledger fields; prices, holdings and privates are identical and VGP is conserved.",
      cases: V10_GOLDEN.cases.map((entry) => {
        const committed = appraiseCommittedState(canonicalStateText(boards[entry.name]), seatsOf(entry.seat_mapping));
        const weights = terminalSettlementWeights(committed.vector, { reason: entry.reason } as never, TERMS);
        const preview = payoutPreview(b(entry.pool_ujuno), weights);
        return {
          name: entry.name,
          history: V12_RECIPE_HISTORY[entry.name],
          reason: entry.reason,
          reason_code: SETTLEMENT_REASON_CODE[entry.reason],
          appraisal_state_hash: committed.appraisal_state_hash,
          v10_appraisal_state_hash: entry.terminal_state_hash_v1,
          v11_appraisal_state_hash: (V11.cases as Loose[]).find((x) => x.name === entry.name)!.appraisal_state_hash,
          seat_mapping: entry.seat_mapping.map((player_id, seat_index) => ({ seat_index, player_id })),
          settlement_weights: strings(weights),
          pool_ujuno: preview.pool.toString(),
          payouts_ujuno: strings(preview.payouts),
          dust_ujuno: preview.dust.toString(),
        };
      }),
      domains: V12_DOMAINS.map((d) => ({
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
      })),
      payload_vectors: (V10_PAYLOADS.payload_vectors as Loose[]).map((v) => {
        const built = buildSettlementPayloadV1(v12ArgsFor(v));
        const preview = payoutPreview(b(v.pool_ujuno), built.payload.settlement_weights);
        return {
          name: v.name,
          source_case: v.source_case,
          usage: built.usage,
          domain_name: v12DomainFor(v.domain_name).name,
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
      forks: FORKS.map((fork) => {
        const ids = fork.v12.terminal.player_addresses;
        const a11 = appraiseSeats(fork.v11.terminal, seatsOf(ids));
        const a12 = appraiseSeats(fork.v12.terminal, seatsOf(ids));
        const built = buildSettlementPayloadV1(forkArgs(fork));
        const preview = payoutPreview(FORK_POOL, built.payload.settlement_weights);
        const v11Preview = payoutPreview(FORK_POOL, a11.map((seat) => seat.total));
        return {
          name: fork.name,
          source: fork.source,
          company_id: fork.company_id,
          what_v12_changes: fork.what_v12_changes,
          v11_law: {
            printed: fork.v11.printed,
            revenue: fork.v11.revenue,
            recorded_run: fork.v11.recordedRunAnswer?.kind ?? null,
            routes: fork.v11.run.routes,
            vector: strings(a11.map((seat) => seat.total)),
            appraisal_state_hash_at_pin_11: terminalStateHashV1(fork.v11.terminal),
            payouts_ujuno: strings(v11Preview.payouts),
            dust_ujuno: v11Preview.dust.toString(),
          },
          v12_law: {
            printed: fork.v12.printed,
            revenue: fork.v12.revenue,
            recorded_run: fork.v12.recordedRunAnswer?.kind ?? null,
            routes: fork.v12.run.routes,
            appraisal_state_hash: built.payload.appraisal_state_hash,
            seat_mapping: ids.map((player_id, seat_index) => ({ seat_index, player_id })),
            components: a12.map((seat) => ({ player_id: seat.player_id, cash: seat.cash_counted.toString(), shares: seat.shares.toString(), privates: seat.privates.toString(), total: seat.total.toString() })),
            settlement_weights: strings(built.payload.settlement_weights),
            pool_ujuno: preview.pool.toString(),
            payouts_ujuno: strings(preview.payouts),
            dust_ujuno: preview.dust.toString(),
            domain_name: THREE_SEAT.name,
            payload: built.wire,
            encoded: built.encoded_hex,
            settle_digest: built.settle_digest,
            consent_digest: consentDigestV1(built.payload.domain, built.payload.seq, built.settle_digest),
          },
          vector_difference: a12.map((seat, index) => (seat.total - a11[index].total).toString()),
          treasury_difference: (
            b(((fork.v12.after.public_companies.find((entry) => entry.company_id === fork.company_id) as Loose).treasury ?? "0") as string) -
            b(((fork.v11.after.public_companies.find((entry) => entry.company_id === fork.company_id) as Loose).treasury ?? "0") as string)
          ).toString(),
          bank_difference: (b(fork.v12.after.virtual_bank_vgp) - b(fork.v11.after.virtual_bank_vgp)).toString(),
        };
      }),
    };
  }

  it("settlementV12CertificationVectors.json is exactly what the primitives generate (UPDATE_SETTLEMENT_V12_VECTORS=1 rewrites it)", () => {
    const text = `${JSON.stringify(generate(), null, 1)}\n`;
    if (process.env.UPDATE_SETTLEMENT_V12_VECTORS === "1") writeFileSync(V12_FILE, text);
    expect(existsSync(V12_FILE)).toBe(true);
    expect(readFileSync(V12_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(text);
  });

  it("the v12 file names v12 alone; the v11 file still v11 alone; the frozen v10 payload files still v10 alone", () => {
    const pins = (file: string) => new Set(Array.from(readFileSync(file, "utf8").matchAll(/"rules_engine_version":\s*(\d+)/g)).map((m) => Number(m[1])));
    expect(pins(V12_FILE)).toEqual(new Set([12]));
    expect(pins(V11_FILE)).toEqual(new Set([11]));
    expect(pins(join(SETTLEMENT, "settlementPayloadVectorsV1.json"))).toEqual(new Set([10]));
    const rust = join(REPO, "contracts", "escrow", "testdata", "payload_vectors_v1.json");
    if (existsSync(rust)) expect(pins(rust)).toEqual(new Set([10]));
  });

  it("every frozen v10 settlement file and the v11 evidence file are byte-identical to their certified SHA-256 (LF-normalised)", () => {
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
