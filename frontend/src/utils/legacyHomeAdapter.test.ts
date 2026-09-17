/** @jest-environment node */
//
// ==================================================================
//  STAGE 8, SLICE 8.2 -- THE DEVELOPMENT CORPUS'S HOME-CHOICE ADAPTER (OWNER RULING R3 / D-31, #1614)
// ==================================================================
//
// Every corpus log was played on the engine that demanded the home token at the float, so its home placements sit
// in Stock Rounds and today's reducer refuses them as untimely. Under `DEVELOPMENT_CORPUS_POLICY` only, `replayLog`
// remembers the last such entry's CANDIDATE home choice for each corporation and tries it ONCE, through the reducer,
// when that corporation first owes its home -- judged by the current authority on the board of that moment. The
// remembered choice is data, not grandfathered legality: an illegal one is never forced and never exchanged for
// the other circle or the other city. Production replay (the server's policy, a room's rebuild) never adapts.
//
// Two layers. The adapter's memory (`LegacyHomeChoices`) is asked directly on hand-built boards, with each synthetic
// entry applied by the reducer exactly as a room engine applies it. The loop is asked on the frozen JUNO-CV4 golden
// log (a Level Playing Field game: B&O floats at 19 and places at 20; C&O floats at 58 and places Cleveland at 59;
// their first operating turns open after 26 and after 62) and on the JUNO-Z6C fixture (PMQ's Detroit/Windsor circle).
// Variants of CV4 change a payload IN MEMORY for one case; no stored log is rewritten.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES, STANDARD_BOARD, activateBoard } from "../components/hexBoardData";
import { CO_COMPANY_ID, PMQ_COMPANY_ID } from "../components/hexBoardDataLpf";
import { entriesFromExport, LegacyHomeChoices, replayLog, type ExportedEntry, type ReplayEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY, SERVER_REPLAY_POLICY } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { stateDigest } from "../gameEngine/stateDigest";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import { boardHomeHexToAxial, homeStationHold, legalHomeTargets, owedHomeStation } from "../gameEngine/homeStationAuthority";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import { applySandboxLayTile } from "../gameEngine/sandboxSession";
import { stationPlacementRefusal } from "../gameEngine/stationPlacementGate";
import { readStripped } from "./sourceScan";
import { board, P1, P2, P3, PRR, NYC } from "./offerFixtures74";
import { applyAsRoom, corp, same, withCorp, withState } from "./offerMatrix74Support";

const BO = 4;
const ERIE = 6;
const CO = CO_COMPANY_ID;
const PMQ = PMQ_COMPANY_ID;
const LPF = resolveVariants({ levelPlayingField: true });
const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
const table = boardHomeHexToAxial;

afterAll(() => activateBoard(STANDARD_BOARD));

const hexAt = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no ${label} on the board in effect`);
  return hex;
};
const at = (label: string): [number, number] => [hexAt(label).q, hexAt(label).r];
const row = (index: number, actor: string, msg: unknown): ReplayEntry => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
const home = (companyId: number, label: string, cityIndex: number | null = null, kind = "home") => ({
  PlaceHomeStation: { game_id: 0, company_id: companyId, q: hexAt(label).q, r: hexAt(label).r, kind, city_index: cityIndex, hex_label: label },
});

/* ================================================================== */
/* the memory, asked directly                                                                               */
/* ================================================================== */

/** Standard board: ERIE (P3, home E11) and B&O (P2, home I15) floated without tokens; PRR (P1) has its home. */
function standard(round: "StockRound" | "OperatingRound", operating: number = PRR): GameStateResponse {
  const state = board({
    round,
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], price: 100 },
      { id: ERIE, ticker: "ERIE", president: P3, trains: [], price: 80 },
      { id: BO, ticker: "B&O", president: P2, trains: [], price: 90 },
      { id: NYC, ticker: "NYC", president: P1, trains: [], price: 71 },
    ],
    operating,
    step: "Track",
  });
  let out = withCorp(state, PRR, { home_hex_label: "H12", station_token_hexes: [at("H12")] });
  out = withCorp(out, ERIE, { home_hex_label: "E11" });
  out = withCorp(out, BO, { home_hex_label: "I15" });
  out = withCorp(out, NYC, { home_hex_label: "E19", station_token_hexes: [at("E19")] });
  return out;
}

/** Level Playing Field Operating board: C&O (P2, F6/K13) and PMQ (P3, E5) owe nothing yet; NYC (P1) has its home. */
function lpf(operating: number): GameStateResponse {
  return withRules(LPF, () => {
    const state = board({
      round: "OperatingRound",
      corps: [
        { id: NYC, ticker: "NYC", president: P1, trains: ["2"], price: 90 },
        { id: CO, ticker: "C&O", president: P2, trains: [], price: 80 },
        { id: PMQ, ticker: "PMQ", president: P3, trains: [], price: 71 },
      ],
      operating,
      step: "Track",
      over: { variants: LPF },
    });
    let out = withCorp(state, NYC, { home_hex_label: "E19", station_token_hexes: [at("E19")] });
    out = withCorp(out, CO, { home_hex_label: "F6" });
    out = withCorp(out, PMQ, { home_hex_label: "E5", station_token_limit: 2 });
    return out;
  });
}

describe("§32 the adapter's memory: what is remembered, and what is tried at the first turn (#1614)", () => {
  const providers = sandboxReplayProviders();

  it("remembers an untimely placement on a candidate home -- as data, nothing placed", () => {
    const memory = new LegacyHomeChoices(providers);
    const sr = standard("StockRound");
    const choice = memory.untimelyChoice(row(10, P2, home(BO, "I15")), sr, GRID);
    expect(choice).toEqual({ companyId: BO, q: hexAt("I15").q, r: hexAt("I15").r, cityIndex: null, hexLabel: "I15" });
    memory.remember(choice!, 10, sr);
    expect(memory.pending.get(BO)).toMatchObject({ recordedAt: 10, cityIndex: null });
    expect(corp(sr, BO).station_token_hexes).toEqual([]);
  });

  it("does not remember an off-home placement, a timely one, one for a corporation with its home, or a D&H station", () => {
    const memory = new LegacyHomeChoices(providers);
    const sr = standard("StockRound");
    expect(memory.untimelyChoice(row(1, P2, home(BO, "F16")), sr, GRID)).toBeNull();
    expect(memory.untimelyChoice(row(2, P3, home(ERIE, "E11")), sr, GRID)).toBeNull(); // E11 needs a named circle
    expect(memory.untimelyChoice(row(3, P2, home(BO, "I15")), standard("OperatingRound", BO), GRID)).toBeNull(); // owed now
    expect(memory.untimelyChoice(row(4, P1, home(PRR, "H12")), sr, GRID)).toBeNull(); // PRR already has its home
    expect(memory.untimelyChoice(row(5, P2, home(BO, "I15", null, "dh")), sr, GRID)).toBeNull();
    expect(memory.untimelyChoice({ index: 6, id: "e6", actor: P2, payload: "{not json" }, sr, GRID)).toBeNull();
  });

  it("keeps the last recorded choice for a corporation, and forgets nothing it did not replace", () => {
    const memory = new LegacyHomeChoices(providers);
    const sr = standard("StockRound");
    memory.remember(memory.untimelyChoice(row(10, P3, home(ERIE, "E11", 0)), sr, GRID)!, 10, sr);
    memory.remember(memory.untimelyChoice(row(11, P2, home(BO, "I15")), sr, GRID)!, 11, sr);
    memory.remember(memory.untimelyChoice(row(12, P3, home(ERIE, "E11", 1)), sr, GRID)!, 12, sr);
    expect(memory.pending.get(ERIE)).toMatchObject({ recordedAt: 12, cityIndex: 1 });
    expect(memory.pending.get(BO)).toMatchObject({ recordedAt: 11 });
  });

  it("Erie's remembered circle is tried once at its first turn, authored by its president, and lands where it was chosen", () => {
    const memory = new LegacyHomeChoices(providers);
    const sr = standard("StockRound");
    memory.remember(memory.untimelyChoice(row(12, P3, home(ERIE, "E11", 1)), sr, GRID)!, 12, sr);
    expect(memory.syntheticFor(standard("OperatingRound", PRR), { index: 20, id: "e20" })).toBeNull(); // not Erie's turn
    const turn = standard("OperatingRound", ERIE);
    const attempt = memory.syntheticFor(turn, { index: 21, id: "e21" })!;
    expect(attempt.entry).toEqual({
      index: 21,
      id: "e21:legacy-home-1",
      actor: P3,
      payload: JSON.stringify({ PlaceHomeStation: { game_id: 0, company_id: ERIE, q: hexAt("E11").q, r: hexAt("E11").r, kind: "home", city_index: 1, hex_label: "E11" } }),
    });
    expect(memory.syntheticFor(turn, { index: 21, id: "e21" })).toBeNull(); // spent
    const placed = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P3, GRID);
    expect(corp(placed, ERIE).station_tokens).toEqual([[hexAt("E11").q, hexAt("E11").r, 1]]);
    expect(memory.outcome(attempt, 21, placed)).toMatchObject({ recordedAt: 12, afterIndex: 21, companyId: ERIE, cityIndex: 1, applied: true });
  });

  it("an Erie circle taken before its first turn is not forced and not exchanged for the other circle: the hold stands", () => {
    const memory = new LegacyHomeChoices(providers);
    const sr = standard("StockRound");
    memory.remember(memory.untimelyChoice(row(12, P3, home(ERIE, "E11", 1)), sr, GRID)!, 12, sr);
    const [q, r] = at("E11");
    const turn = withCorp(standard("OperatingRound", ERIE), NYC, { station_token_hexes: [at("E19"), [q, r]], station_tokens: [[q, r, 1]] });
    const attempt = memory.syntheticFor(turn, { index: 21, id: "e21" })!;
    expect(JSON.parse(attempt.entry.payload).PlaceHomeStation.city_index).toBe(1);
    const after = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P3, GRID);
    expect(same(after, turn)).toBe(true);
    expect(memory.outcome(attempt, 21, after).applied).toBe(false);
    expect(homeStationHold(after, { PassTurn: { game_id: 0 } } as never, table)).toContain("ERIE is starting its first operating turn");
    expect(legalHomeTargets(after, GRID, table).map((target) => target.cityIndex)).toEqual([0]); // legal, and nobody chose it
    expect(memory.syntheticFor(after, { index: 22, id: "e22" })).toBeNull();
  });

  /* S8-14 (#1617): once an OO home hex carries a laid tile, no other corporation may place a station there until the
     home is placed -- so a remembered circle can no longer be taken from under the adapter after the tile, and a
     circle taken BEFORE the tile is still taken. Either way the synthetic placement is judged by the current
     authority on the board of that moment. */
  it("S8-14: on a tiled E11 no other corporation may take ERIE's remembered circle, and the choice lands at its first turn", () => {
    const memory = new LegacyHomeChoices(providers);
    const sr = standard("StockRound");
    memory.remember(memory.untimelyChoice(row(12, P3, home(ERIE, "E11", 1)), sr, GRID)!, 12, sr);
    const [q, r] = at("E11");
    const tiled = applySandboxLayTile(GRID, q, r, 59, 0, () => false);
    const prrAtTokens = withState(withCorp(standard("OperatingRound", PRR), PRR, { home_hex_label: undefined, station_token_hexes: [], station_tokens: [] }), {
      operating_sub_phase: "Tokens",
    });
    expect(stationPlacementRefusal(prrAtTokens, { protocol_id: PRR, q, r, city_index: 1 }, GRID)).toBeNull(); // before the tile: legal
    expect(stationPlacementRefusal(prrAtTokens, { protocol_id: PRR, q, r, city_index: 1 }, tiled)).toBe(
      "ERIE has not placed its home station on E11 yet and a tile has been laid there, so no other corporation may place a station on E11 until it does.",
    );
    const turn = standard("OperatingRound", ERIE);
    const attempt = memory.syntheticFor(turn, { index: 21, id: "e21" })!;
    const placed = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P3, tiled);
    expect(corp(placed, ERIE).station_tokens).toEqual([[q, r, 1]]);
    expect(memory.outcome(attempt, 21, placed).applied).toBe(true);
  });

  it("S8-14: a remembered circle taken before the tile is still taken after it -- not forced, not exchanged, the hold stands", () => {
    const memory = new LegacyHomeChoices(providers);
    const sr = standard("StockRound");
    memory.remember(memory.untimelyChoice(row(12, P3, home(ERIE, "E11", 1)), sr, GRID)!, 12, sr);
    const [q, r] = at("E11");
    const tiled = applySandboxLayTile(GRID, q, r, 59, 0, () => false);
    const turn = withCorp(standard("OperatingRound", ERIE), NYC, { station_token_hexes: [at("E19"), [q, r]], station_tokens: [[q, r, 1]] });
    const attempt = memory.syntheticFor(turn, { index: 21, id: "e21" })!;
    const after = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P3, tiled);
    expect(same(after, turn)).toBe(true);
    expect(memory.outcome(attempt, 21, after).applied).toBe(false);
    expect(legalHomeTargets(after, tiled, table).map((target) => target.cityIndex)).toEqual([0]);
    expect(homeStationHold(after, { PassTurn: { game_id: 0 } } as never, table)).toContain("ERIE is starting its first operating turn");
  });

  it("S8-14: PMQ's remembered E5 circle on a tiled hex cannot be taken by another corporation and lands at PMQ's first turn", () => {
    withRules(LPF, () => {
      const memory = new LegacyHomeChoices(providers);
      const sr = withState(lpf(NYC), { current_round_type: "StockRound", operating_sub_phase: undefined });
      memory.remember(memory.untimelyChoice(row(30, P3, home(PMQ, "E5", 0)), sr, GRID)!, 30, sr);
      const [q, r] = at("E5");
      const tiled = applySandboxLayTile(GRID, q, r, 59, 0, () => false);
      const nycAtTokens = withState(lpf(NYC), { operating_sub_phase: "Tokens" });
      expect(stationPlacementRefusal(nycAtTokens, { protocol_id: NYC, q, r, city_index: 0 }, tiled)).toBe(
        "PMQ has not placed its home station on E5 yet and a tile has been laid there, so no other corporation may place a station on E5 until it does.",
      );
      const turn = lpf(PMQ);
      const attempt = memory.syntheticFor(turn, { index: 40, id: "e40" })!;
      const placed = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P3, tiled);
      expect(corp(placed, PMQ).station_tokens).toEqual([[q, r, 0]]);
      expect(memory.outcome(attempt, 40, placed).applied).toBe(true);
    });
  });

  it("PMQ's remembered Detroit/Windsor circle, once taken, is not exchanged for the other one either", () => {
    withRules(LPF, () => {
      const memory = new LegacyHomeChoices(providers);
      const sr = withState(lpf(NYC), { current_round_type: "StockRound", operating_sub_phase: undefined });
      memory.remember(memory.untimelyChoice(row(30, P3, home(PMQ, "E5", 1)), sr, GRID)!, 30, sr);
      const [q, r] = at("E5");
      const turn = withCorp(lpf(PMQ), NYC, { station_token_hexes: [at("E19"), [q, r]], station_tokens: [[q, r, 1]] });
      const attempt = memory.syntheticFor(turn, { index: 40, id: "e40" })!;
      const after = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P3, GRID);
      expect(same(after, turn)).toBe(true);
      expect(corp(after, PMQ).station_token_hexes).toEqual([]);
      expect(owedHomeStation(after, table)?.ticker).toBe("PMQ");
      expect(memory.syntheticFor(after, { index: 41, id: "e41" })).toBeNull();
    });
  });

  it("C&O's remembered Cleveland, closed out before its first turn, is not forced and not silently changed to Richmond", () => {
    withRules(LPF, () => {
      const memory = new LegacyHomeChoices(providers);
      const sr = withState(lpf(NYC), { current_round_type: "StockRound", operating_sub_phase: undefined });
      memory.remember(memory.untimelyChoice(row(59, P2, home(CO, "F6")), sr, GRID)!, 59, sr);
      const turn = withCorp(lpf(CO), NYC, { station_token_hexes: [at("E19"), at("F6")], station_tokens: [[hexAt("F6").q, hexAt("F6").r, 0]] });
      const attempt = memory.syntheticFor(turn, { index: 62, id: "e62" })!;
      expect(JSON.parse(attempt.entry.payload).PlaceHomeStation.hex_label).toBe("F6");
      const after = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P2, GRID);
      expect(same(after, turn)).toBe(true);
      expect(memory.outcome(attempt, 62, after).applied).toBe(false);
      expect(legalHomeTargets(after, GRID, table).map((target) => target.hexLabel)).toEqual(["K13"]); // Richmond is legal...
      expect(corp(after, CO).station_token_hexes).toEqual([]); // ...and was not chosen for anybody
      expect(homeStationHold(after, { PassTurn: { game_id: 0 } } as never, table)).toContain("C&O is starting its first operating turn");
      expect(memory.syntheticFor(after, { index: 63, id: "e63" })).toBeNull();
    });
  });

  it("C&O's remembered Richmond is supplied when it is still legal", () => {
    withRules(LPF, () => {
      const memory = new LegacyHomeChoices(providers);
      const sr = withState(lpf(NYC), { current_round_type: "StockRound", operating_sub_phase: undefined });
      memory.remember(memory.untimelyChoice(row(59, P2, home(CO, "K13")), sr, GRID)!, 59, sr);
      const turn = lpf(CO);
      const attempt = memory.syntheticFor(turn, { index: 62, id: "e62" })!;
      const after = applyAsRoom(turn, JSON.parse(attempt.entry.payload), P2, GRID);
      expect(corp(after, CO).station_token_hexes).toEqual([at("K13")]);
      expect(memory.outcome(attempt, 62, after).applied).toBe(true);
    });
  });
});

/* ================================================================== */
/* the loop, on the corpus                                                                                  */
/* ================================================================== */

const GOLDEN_CV4 = join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl");
const Z6C_FIXTURE = join(__dirname, "__fixtures__z6cLog.json");
const cv4Rows = (): ExportedEntry[] =>
  readFileSync(GOLDEN_CV4, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);
const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});
/** Replays `rows`; `before[i]` is the board stored entry `i` was handed (synthetic entries are not indexed). */
const replay = (rows: readonly ExportedEntry[], policy = DEVELOPMENT_CORPUS_POLICY) => {
  const before: Record<number, GameStateResponse> = {};
  const result = replayLog(
    entriesFromExport(rows),
    sandboxReplayProviders(),
    seed(),
    ({ entry, stateBefore }) => {
      if (!entry.id.includes(":legacy-")) before[entry.index] = stateBefore;
    },
    policy,
  );
  return { result, before };
};
const tokensOf = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!.station_token_hexes;
const withPayload = (rows: ExportedEntry[], index: number, payload: unknown): ExportedEntry[] =>
  rows.map((entry) => (entry.index === index ? { ...entry, payload: JSON.stringify(payload) } : entry));
const cv4Home = (companyId: number, label: string, q: number, r: number) => ({
  PlaceHomeStation: { city_index: null, company_id: companyId, hex_label: label, kind: "home", q, r },
});

describe("§32 the loop on the frozen JUNO-CV4 log (#1614)", () => {
  it("(1-3, 6) the Stock-Round placements are remembered, the tokens are absent until each first turn, and the choices are supplied there", () => {
    const { result, before } = replay(cv4Rows());
    expect(result.legacyHomeStations).toEqual([
      { recordedAt: 20, afterIndex: 26, companyId: BO, q: 3, r: 8, cityIndex: null, applied: true },
      { recordedAt: 59, afterIndex: 62, companyId: CO, q: 0, r: 5, cityIndex: null, applied: true },
    ]);
    for (const index of [21, 22, 23, 24, 25, 26]) expect([index, tokensOf(before[index], BO)]).toEqual([index, []]);
    expect(tokensOf(before[27], BO)).toEqual([[3, 8]]);
    for (const index of [60, 61, 62]) expect([index, tokensOf(before[index], CO)]).toEqual([index, []]);
    expect(tokensOf(before[72], CO)).toEqual([[0, 5]]);
  });

  it("(7) a recorded Richmond is supplied at C&O's first turn instead", () => {
    const { result, before } = replay(withPayload(cv4Rows(), 59, cv4Home(CO, "K13", 1, 10)));
    expect(result.legacyHomeStations[1]).toEqual({ recordedAt: 59, afterIndex: 62, companyId: CO, q: 1, r: 10, cityIndex: null, applied: true });
    expect(tokensOf(before[72], CO)).toEqual([[1, 10]]);
  });

  it("(8) the last recorded choice wins", () => {
    const rows = cv4Rows();
    const at59 = rows.find((entry) => entry.index === 59)!;
    const at60 = rows.find((entry) => entry.index === 60)!;
    const later: ExportedEntry = { ...at59, index: 60, id: `${at60.id}~later`, payload: JSON.stringify(cv4Home(CO, "K13", 1, 10)) };
    const { result, before } = replay([...rows, later]);
    expect(result.legacyHomeStations[1]).toMatchObject({ recordedAt: 60, companyId: CO, q: 1, r: 10, applied: true });
    expect(tokensOf(before[72], CO)).toEqual([[1, 10]]);
  });

  it("(9, 14) an off-home placement is not remembered: C&O's hold stands at its first turn and its turn is refused", () => {
    const { result, before } = replay(withPayload(cv4Rows(), 59, cv4Home(CO, "F16", 5, 5)));
    expect(result.legacyHomeStations.map((entry) => entry.companyId)).toEqual([BO]);
    expect(owedHomeStation(before[72], sandboxReplayProviders().chartInjections(before[72]).homeHexToAxial!)?.ticker).toBe("C&O");
    expect(tokensOf(before[72], CO)).toEqual([]);
    expect(stateDigest(before[73])).toBe(stateDigest(before[72])); // 72, C&O's LayTile, is held
  });

  it("(15) production replay never adapts: the server's policy refuses, and a room's rebuild holds B&O at its first turn", () => {
    expect(SERVER_REPLAY_POLICY.legacyHomeTokens).toBe("refuse");
    expect(DEVELOPMENT_CORPUS_POLICY.legacyHomeTokens).toBe("defer-to-first-turn");
    const refused = replay(cv4Rows(), { ...DEVELOPMENT_CORPUS_POLICY, legacyHomeTokens: "refuse" });
    expect(refused.result.legacyHomeStations).toEqual([]);
    expect(tokensOf(refused.result.state, BO)).toEqual([]);
    expect(owedHomeStation(refused.result.state, table)?.ticker).toBe("B&O");
    const room = new RoomSession({ providers: sandboxReplayProviders(), seed: seed(), build: "b", mintId: () => "x", replayPolicy: DEVELOPMENT_CORPUS_POLICY });
    room.restore(cv4Rows() as unknown as ServerLogEntry[]);
    expect(owedHomeStation(room.state, table)?.ticker).toBe("B&O");
    expect(tokensOf(room.state, BO)).toEqual([]);
    /* #1614a: every production walk of a log calls the adapters' step with no policy, or does not reach them at all.
       The shell's epilogue and round scrubber take an optional policy for the corpus tests and are handed none; a
       room's rebuild applies entries straight to its engine; the server hands a room a policy that only admits or
       refuses a log. Only the development replay CLI names the corpus policy, and it says so on stderr (#1520). */
    const app = readStripped("App.tsx");
    expect(app).toContain("gameHistoryFrom(sandboxLogRef.current);");
    expect(app).toContain("replaySnapshotAtRound(replayLogRef.current, history.rounds, replayCursor);");
    expect(app).not.toContain("DEVELOPMENT_CORPUS_POLICY");
    expect(app).not.toContain("LegacyLogAdapters");
    const roomSession = readStripped("utils/roomSession.ts");
    expect(roomSession).toContain("for (const entry of effectiveActions(this.log)) this.engine.apply(entry);");
    expect(roomSession).not.toContain("LegacyLogAdapters");
    expect(roomSession).not.toContain("LegacyHomeChoices");
    expect(readStripped("../../server/src/gameServer.ts")).not.toContain("LegacyLogAdapters");
  });

  it("(16) a rebuild reconstructs the same memory from the surviving entries, deterministically", () => {
    const first = replay(cv4Rows());
    const second = replay(cv4Rows());
    expect(stateDigest(second.result.state)).toBe(stateDigest(first.result.state));
    expect(second.result.legacyHomeStations).toEqual(first.result.legacyHomeStations);
    const rows = cv4Rows();
    const last = rows[rows.length - 1];
    const revert = (index: number): ExportedEntry => ({ ...last, index: last.index + 1, id: `revert-${index}`, derived: false, payload: JSON.stringify({ RevertTo: { index, player: last.actor, summary: "undo" } }) });
    // Reverting to 73 keeps C&O's first turn: the same two choices, supplied at the same moments.
    expect(replay([...rows, revert(73)]).result.legacyHomeStations).toEqual(first.result.legacyHomeStations);
    // Reverting to 59 removes C&O's recorded choice: only B&O's survives.
    expect(replay([...rows, revert(59)]).result.legacyHomeStations.map((entry) => entry.companyId)).toEqual([BO]);
  });
});

describe("§32 (5) PMQ's recorded Detroit/Windsor circle on the JUNO-Z6C fixture", () => {
  it("is supplied at PMQ's first turn in the circle the player chose", () => {
    if (!existsSync(Z6C_FIXTURE)) return;
    const raw = JSON.parse(readFileSync(Z6C_FIXTURE, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
    const { result } = replay(raw.actions ?? raw.entries ?? []);
    expect(result.legacyHomeStations.find((entry) => entry.companyId === PMQ)).toEqual({
      recordedAt: 343,
      afterIndex: 362,
      companyId: PMQ,
      q: 0,
      r: 4,
      cityIndex: 1,
      applied: true,
    });
  });
});
