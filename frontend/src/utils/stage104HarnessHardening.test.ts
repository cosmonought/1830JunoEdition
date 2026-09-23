/** @jest-environment node */
//
// ==================================================================
//  STAGE 10.4: DEVELOPMENT TOOLING / HARNESS HARDENING (S10-22, S10-23)
// ==================================================================
//
// S10-22  `LegacyLogAdapters.apply` judged a supplied legacy `DiscardTrain` refused by IDENTITY. On a charted
//         board a refusal comes back as a fresh state object, so a refused discard read as applied and the loop
//         retried the standing obligation. The criterion is now #1685's `atomsUnchanged` (state + grid by content).
// S10-23  An export whose rows carry no `id` (JUNO-Y8V) normalised every row to the identity `undefined`, and the
//         first `RevertTo` killed the whole file. `entriesFromExport` now gives such a row a deterministic
//         per-ROW identity (`legacyExportId`), never one built from its index alone (#1026).
//
// NEITHER IS A RULE. `effectiveActions` is untouched; the reducer is untouched; `RULES_ENGINE_VERSION` stays 7.
// The corpus section READS the local development corpus (not committed) and writes nothing.

export {};

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const { LegacyLogAdapters, RoomEngine, entriesFromExport, legacyExportId, replayLog, LEGACY_EXPORT_ID_PREFIX, DuplicateExportIdError } =
  require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { effectiveActions, revertTargetOf } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");
const { atomsUnchanged } = require("../gameEngine/actionOutcome") as typeof import("../gameEngine/actionOutcome");
const { DEVELOPMENT_CORPUS_POLICY, RULES_ENGINE_VERSION } =
  require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { pendingTrainDiscards } = require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { stateDigest, canonicalJson } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type ReplayEntry = import("../gameEngine/replayLog").ReplayEntry;
type ExportedEntry = import("../gameEngine/replayLog").ExportedEntry;
type ReplayObserver = Parameters<InstanceType<typeof RoomEngine>["apply"]>[1];

/* ------------------------------------------------------------------ */
/* S10-22: the legacy discard adapter on a charted board                */
/* ------------------------------------------------------------------ */

const H16 = STATIC_BOARD_HEXES.find((entry) => entry.label === "H16")!;
const PRR = 1;
const NYC = 2;
const BO = 4;
const CO = 5;
const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

/** The Batch-4.6 C&O board (`trainDiscard.test.ts`): every printed 4 is out, so NYC's purchase of the first 5
 *  turns the phase (limit 3 -> 2) and leaves C&O over. `boTrains` can put B&O over too -- two owed discards. */
function coBoard(coTrains: string[], boTrains: string[] = ["4", "4"]): GameStateResponse {
  const corps = [
    { id: NYC, ticker: "NYC", president: P2, trains: [] as string[] },
    { id: CO, ticker: "C&O", president: P1, trains: coTrains },
    { id: PRR, ticker: "PRR", president: P3, trains: ["3", "4"] },
    { id: BO, ticker: "B&O", president: P3, trains: boTrains },
  ];
  const order = corps.map((corp) => corp.id);
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(NYC),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
    public_companies: corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "1000",
      owned_trains: corp.trains,
      player_holdings: [{ player: corp.president, percentage: 100 }],
      station_token_hexes: [[H16.q, H16.r]],
      station_tokens: [[H16.q, H16.r, 0]],
      station_token_limit: 3,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const waterfallSeed = () => waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []);
const BUY_NYC: ReplayEntry = {
  index: 0,
  id: "e0",
  actor: P2,
  payload: JSON.stringify({ BuyHardwareFromPool: { game_id: 1, protocol_id: NYC } }),
};
const company = (state: GameStateResponse, id: number) => state.public_companies.find((entry) => entry.company_id === id)!;

/** The REAL `RoomEngine` (charted: it seeds the providers' chart onto the state), wrapped only to (a) count what
 *  the adapter hands it and fail on a spin instead of hanging, and (b) after `acceptDiscards` supplied discards,
 *  turn each further one into a discard the real reducer REFUSES (a model the corporation does not hold). The
 *  refusal itself is the reducer's; nothing is faked about the board. */
class ObservedEngine {
  readonly real: InstanceType<typeof RoomEngine>;
  applies = 0;
  discardsHanded = 0;
  constructor(coTrains: string[], private readonly acceptDiscards: number, boTrains?: string[], private readonly cap = 25) {
    this.real = new RoomEngine(sandboxReplayProviders(), { state: coBoard(coTrains, boTrains), waterfall: waterfallSeed() });
  }
  get snapshot() {
    return this.real.snapshot;
  }
  apply(entry: ReplayEntry, observe?: ReplayObserver): void {
    this.applies += 1;
    if (this.applies > this.cap) throw new Error("spin: the adapter kept retrying a refused discard");
    const msg = JSON.parse(entry.payload) as Record<string, { model_type?: string }>;
    if ("DiscardTrain" in msg) {
      this.discardsHanded += 1;
      if (this.discardsHanded > this.acceptDiscards) {
        entry = { ...entry, payload: JSON.stringify({ DiscardTrain: { ...msg.DiscardTrain, model_type: "D" } }) };
      }
    }
    this.real.apply(entry, observe);
  }
}

const legacyAdapters = () => new LegacyLogAdapters(sandboxReplayProviders(), { kind: "legacy" }, DEVELOPMENT_CORPUS_POLICY);
const run = (engine: ObservedEngine) => {
  const adapters = legacyAdapters();
  adapters.apply(engine as unknown as InstanceType<typeof RoomEngine>, BUY_NYC);
  return adapters;
};

describe("S10-22: the legacy discard adapter recognises a refusal by content, not identity", () => {
  it("premise: on the charted engine a refused discard returns a FRESH state object with UNCHANGED content", () => {
    const engine = new ObservedEngine(["3", "3", "4"], 0);
    engine.real.apply(BUY_NYC);
    expect(pendingTrainDiscards(engine.snapshot.state)?.required.companyId).toBe(CO);
    expect(engine.snapshot.state.market_positions).toBeDefined(); // charted
    const before = { state: engine.snapshot.state, grid: engine.snapshot.grid };
    engine.real.apply({ index: 1, id: "x", actor: P1, payload: JSON.stringify({ DiscardTrain: { game_id: 0, protocol_id: CO, model_type: "D" } }) });
    const after = { state: engine.snapshot.state, grid: engine.snapshot.grid };
    // The old guard's question -- `state === before` -- answers "changed" to this refusal:
    expect(after.state === before.state).toBe(false);
    // #1685's answer is the right one:
    expect(atomsUnchanged(before, after)).toBe(true);
    expect(stateDigest(after.state)).toBe(stateDigest(before.state));
  });

  it("1. a refused synthetic discard on a charted board: recognised, loop breaks, nothing reported as applied", () => {
    const engine = new ObservedEngine(["3", "3", "4"], 0);
    const adapters = run(engine); // the old guard threw "spin" here (cap 25)
    expect(engine.discardsHanded).toBe(1);
    expect(engine.applies).toBe(2); // the stored entry, one refused discard -- no retry
    expect(adapters.legacyDiscards).toEqual([]);
    expect(company(engine.snapshot.state, CO).owned_trains).toEqual(["3", "3", "4"]);
    expect(pendingTrainDiscards(engine.snapshot.state)?.required.excess).toBe(1); // left standing, as before
  });

  it("2. an accepted synthetic discard: the train is removed and the adapter records it", () => {
    const engine = new ObservedEngine(["3", "3", "4"], Number.POSITIVE_INFINITY);
    const adapters = run(engine);
    expect(adapters.legacyDiscards).toEqual([{ afterIndex: 0, companyId: CO, model: "3" }]);
    expect(company(engine.snapshot.state, CO).owned_trains).toEqual(["3", "4"]);
    expect(pendingTrainDiscards(engine.snapshot.state)).toBeNull();
    expect(engine.discardsHanded).toBe(1);
  });

  it("3. multiple owed discards: continues after each success and stops when the obligation is met", () => {
    // C&O and B&O both end over the new limit of 2: two obligations, decided in 6.6.1's order.
    const engine = new ObservedEngine(["3", "3", "4"], Number.POSITIVE_INFINITY, ["4", "4", "3"]);
    const adapters = run(engine);
    expect(adapters.legacyDiscards).toHaveLength(2);
    expect(new Set(adapters.legacyDiscards.map((d) => d.companyId))).toEqual(new Set([CO, BO]));
    expect(adapters.legacyDiscards.every((d) => d.model === "3" && d.afterIndex === 0)).toBe(true);
    expect(company(engine.snapshot.state, CO).owned_trains).toEqual(["3", "4"]);
    expect(company(engine.snapshot.state, BO).owned_trains).toEqual(["4", "4"]);
    expect(pendingTrainDiscards(engine.snapshot.state)).toBeNull();
    expect(engine.discardsHanded).toBe(2);
  });

  it("4. a refusal after one success: the success stands, the refused attempt does not loop", () => {
    const engine = new ObservedEngine(["3", "3", "4"], 1, ["4", "4", "3"]);
    const adapters = run(engine); // the old guard threw "spin" here
    expect(adapters.legacyDiscards).toHaveLength(1);
    const first = adapters.legacyDiscards[0];
    const second = first.companyId === CO ? BO : CO;
    expect(pendingTrainDiscards(engine.snapshot.state)?.required.companyId).toBe(second);
    expect(pendingTrainDiscards(engine.snapshot.state)?.required.excess).toBe(1);
    expect(company(engine.snapshot.state, first.companyId).owned_trains).toHaveLength(2);
    expect(company(engine.snapshot.state, second).owned_trains).toHaveLength(3);
    expect(engine.discardsHanded).toBe(2);
    expect(engine.applies).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* S10-23: id-less export rows                                           */
/* ------------------------------------------------------------------ */

/** `entriesFromExport` as it stood at `55db610` (Stage 10.3), verbatim but for the cast the new optional `id`
 *  needs -- the baseline the corpus comparison below is measured against. */
const headNormalise = (entries: readonly ExportedEntry[]): ReplayEntry[] =>
  entries.map((entry) => ({
    index: entry.index,
    id: entry.id as string,
    actor: entry.actor,
    at: entry.at,
    derived: entry.derived,
    payload: entry.payload ?? JSON.stringify(entry.msg ?? null),
  }));

const row = (index: number, msg: unknown, id?: string): ExportedEntry =>
  ({ index, actor: P1, derived: false, msg, ...(id === undefined ? {} : { id }) }) as ExportedEntry;
const PASS = { PassTurn: { game_id: 0 } };
const REVERT = (index: number) => ({ RevertTo: { index, player: P1, summary: "undo" } });
const sortAsReplayLogDoes = (entries: ReplayEntry[]) => [...entries].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));

describe("S10-23: an export row without an id gets a deterministic identity of its own", () => {
  it("1. an existing non-empty id survives normalisation byte for byte", () => {
    const ids = ["m7f-12", "c1-3 ", "ABC", "legacy-exportish"];
    const out = entriesFromExport(ids.map((id, at) => row(at, PASS, id)));
    expect(out.map((entry) => entry.id)).toEqual(ids);
  });

  it("2. missing (and empty) ids receive deterministic unique identities", () => {
    const out = entriesFromExport([row(0, PASS), row(1, PASS, ""), row(2, PASS)]);
    expect(out.map((entry) => entry.id)).toEqual([legacyExportId(0, 0, 3), legacyExportId(1, 1, 3), legacyExportId(2, 2, 3)]);
    expect(out.map((entry) => entry.id)).toEqual(["legacy-export:0:000000", "legacy-export:1:000001", "legacy-export:2:000002"]);
    expect(new Set(out.map((entry) => entry.id)).size).toBe(3);
    expect(out.every((entry) => entry.id.startsWith(LEGACY_EXPORT_ID_PREFIX))).toBe(true);
  });

  it("3. two id-less rows at the SAME index receive DISTINCT ids, and keep export order under replayLog's sort", () => {
    const out = entriesFromExport([row(4, PASS), row(5, { A: 1 }), row(5, { B: 2 }), row(6, PASS)]);
    expect(out[1].id).not.toBe(out[2].id);
    expect(new Set(out.map((entry) => entry.id)).size).toBe(4);
    expect(sortAsReplayLogDoes(out).map((entry) => entry.payload)).toEqual(out.map((entry) => entry.payload));
  });

  it("4. normalisation is repeatable: the same input yields the same identities", () => {
    const input = [row(0, PASS), row(1, PASS, "real"), row(1, PASS), row(2, REVERT(1))];
    expect(entriesFromExport(input)).toEqual(entriesFromExport(input));
    expect(JSON.stringify(entriesFromExport(input))).toBe(JSON.stringify(entriesFromExport(JSON.parse(JSON.stringify(input)))));
  });

  it("5. RevertTo still defines its RANGE by index", () => {
    const out = entriesFromExport([row(0, { A: 0 }), row(1, { B: 1 }), row(2, { C: 2 }), row(3, REVERT(1)), row(4, { D: 4 })]);
    expect(effectiveActions(out).map((entry) => entry.payload)).toEqual([JSON.stringify({ A: 0 }), JSON.stringify({ D: 4 })]);
    // Before S10-23 the same rows collapsed to nothing: one identity (`undefined`) for all five.
    expect(effectiveActions(headNormalise([row(0, { A: 0 }), row(1, { B: 1 }), row(2, { C: 2 }), row(3, REVERT(1)), row(4, { D: 4 })]))).toEqual([]);
  });

  it("6. #1026: an entry that raced onto a revert's own index is not killed with it", () => {
    const rows = [row(0, { A: 0 }), row(1, { B: 1 }), row(2, { C: 2 }), row(3, REVERT(1)), row(3, { D: 3 })];
    const out = entriesFromExport(rows);
    expect(effectiveActions(out).map((entry) => entry.payload)).toEqual([JSON.stringify({ A: 0 }), JSON.stringify({ D: 3 })]);
    // And a revert that is itself reverted does not take its index-twin with it.
    const undone = entriesFromExport([...rows, row(4, REVERT(3))]);
    expect(effectiveActions(undone).map((entry) => entry.payload)).toEqual([
      JSON.stringify({ A: 0 }),
      JSON.stringify({ B: 1 }),
      JSON.stringify({ C: 2 }),
    ]);
    // Why the fallback is per ROW: an index-only identity would put D on the kill list with the revert.
    const indexOnly = rows.map((entry) => ({ ...headNormalise([entry])[0], id: `legacy-export:${entry.index}` }));
    expect(effectiveActions(indexOnly).map((entry) => entry.payload)).toEqual([JSON.stringify({ A: 0 })]);
  });
});

describe("Stage 10.4a: generated ids are distinct from every real id, and duplicate real ids are refused", () => {
  const ids = (rows: ExportedEntry[]) => entriesFromExport(rows).map((entry) => entry.id);

  it("A. generated ids never collide with each other", () => {
    const out = ids(Array.from({ length: 40 }, (_, at) => row(at % 7, PASS)));
    expect(new Set(out).size).toBe(40);
  });

  it("B. id-less rows sharing an index stay distinct", () => {
    const out = ids([row(3, PASS), row(3, PASS), row(3, PASS)]);
    expect(new Set(out).size).toBe(3);
    expect(out.every((id) => id.startsWith(`${LEGACY_EXPORT_ID_PREFIX}3:`))).toBe(true);
  });

  it("C. a real id equal to the first generated candidate is kept; the id-less row takes the next free one", () => {
    const candidate = legacyExportId(0, 0, 3); // "legacy-export:0:000000"
    const rows = [row(0, PASS), row(1, PASS, candidate), row(2, PASS, `${candidate}~1`)];
    const out = ids(rows);
    expect(out[1]).toBe(candidate);
    expect(out[2]).toBe(`${candidate}~1`);
    expect(out[0]).toBe(`${candidate}~2`);
    expect(new Set(out).size).toBe(3);
    // Reserved even when the real row comes FIRST in source order.
    expect(ids([row(1, PASS, legacyExportId(1, 1, 2)), row(1, PASS)])).toEqual([
      legacyExportId(1, 1, 2),
      `${legacyExportId(1, 1, 2)}~1`,
    ]);
  });

  it("D. repeated normalisation of a mixed input yields the same ids", () => {
    const candidate = legacyExportId(0, 0, 4);
    const rows = [row(0, PASS), row(1, PASS, candidate), row(1, PASS), row(2, REVERT(1))];
    expect(ids(rows)).toEqual(ids(JSON.parse(JSON.stringify(rows))));
    expect(new Set(ids(rows)).size).toBe(4);
  });

  it("E. two rows with the same real id are refused, not collapsed", () => {
    const rows = [row(0, PASS, "a"), row(1, PASS), row(2, PASS, "a")];
    expect(() => entriesFromExport(rows)).toThrow(DuplicateExportIdError);
    expect(() => entriesFromExport(rows)).toThrow('Export rows 0 and 2 carry the same id "a"');
    // An empty id is "no id", never a duplicate of another empty one.
    expect(new Set(ids([row(0, PASS, ""), row(1, PASS, "")])).size).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* The development corpus: old vs new normalisation                      */
/* ------------------------------------------------------------------ */

const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const PREFIX_DIR = join(__dirname, "__fixtures__");
const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as ExportedEntry);
const exportedRows = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};
function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const add = (name: string, entries: ExportedEntry[]) => out.push({ name, entries });
  if (existsSync(FROZEN_DIR)) {
    for (const file of readdirSync(FROZEN_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) add(`golden/${file.replace(".log.jsonl", "")}`, jsonl(join(FROZEN_DIR, file)));
  }
  if (existsSync(SERVER_DIR)) {
    for (const file of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".log.jsonl")).sort()) add(`server/${file.replace(".log.jsonl", "")}`, jsonl(join(SERVER_DIR, file)));
  }
  if (existsSync(EXPORT_DIR)) {
    for (const file of readdirSync(EXPORT_DIR).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort()) {
      add(`export/${file.replace("sandbox-log-", "").replace(".json", "")}`, exportedRows(join(EXPORT_DIR, file)));
    }
  }
  const prefix = join(PREFIX_DIR, "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) add("prefix/JUNO-FCJ-96", jsonl(prefix));
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) add("fixture/JUNO-Z6C-494", exportedRows(z6c));
  return out;
}
const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallSeed(),
});
const hasRealId = (entry: ExportedEntry) => typeof entry.id === "string" && entry.id.length > 0;

interface Measured {
  name: string;
  stored: number;
  idless: number;
  reverts: number;
  duplicateIndices: number;
  normalisationIdentical: boolean;
  oldEffective: number;
  newEffective: number;
  oldApplied: number | string;
  newApplied: number;
  newDropped: number;
  legacyDiscards: number;
  stateSame: boolean;
  gridSame: boolean;
  newDigest: string;
  round: string;
}

function measure(name: string, entries: ExportedEntry[]): Measured {
  const oldList = headNormalise(entries);
  const newList = entriesFromExport(entries);
  const counts: Record<number, number> = {};
  for (const entry of entries) counts[entry.index] = (counts[entry.index] ?? 0) + 1;
  let oldResult: ReturnType<typeof replayLog> | null = null;
  let oldError = "";
  try {
    oldResult = replayLog(oldList, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
  } catch (error) {
    oldError = `threw: ${(error as Error).message}`;
  }
  const newResult = replayLog(newList, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
  const sorted = (list: ReplayEntry[]) => [...list].sort((a, b) => a.index - b.index || String(a.id).localeCompare(String(b.id)));
  const state = newResult.state as GameStateResponse & { current_round_type?: string; macro_round_number?: number };
  return {
    name,
    stored: entries.length,
    idless: entries.filter((entry) => !hasRealId(entry)).length,
    reverts: newList.filter((entry) => revertTargetOf(entry) !== null).length,
    duplicateIndices: Object.values(counts).filter((n) => n > 1).length,
    normalisationIdentical: JSON.stringify(oldList) === JSON.stringify(newList),
    oldEffective: effectiveActions(sorted(oldList)).length,
    newEffective: effectiveActions(sorted(newList)).length,
    oldApplied: oldResult === null ? oldError : oldResult.applied,
    newApplied: newResult.applied,
    newDropped: newResult.dropped,
    legacyDiscards: newResult.legacyDiscards.length,
    stateSame: oldResult !== null && canonicalJson(oldResult.state) === canonicalJson(newResult.state),
    gridSame: oldResult !== null && canonicalJson(oldResult.grid) === canonicalJson(newResult.grid),
    newDigest: stateDigest(newResult.state),
    round: `${state.current_round_type ?? "?"} ${state.macro_round_number ?? "?"}`,
  };
}

const files = corpus();
const measured = files.map(({ name, entries }) => measure(name, entries));

describe("S10-22 / S10-23 on the development corpus (read-only)", () => {
  if (files.length === 0) {
    it("skipped: the development corpus is not present in this checkout", () => expect(files).toEqual([]));
    return;
  }

  it("prints the reconciliation", () => {
    // eslint-disable-next-line no-console
    console.log(
      [
        `engine v${RULES_ENGINE_VERSION}; files ${measured.length}; stored ${measured.reduce((n, m) => n + m.stored, 0)}; ` +
          `legacyDiscards supplied ${measured.reduce((n, m) => n + m.legacyDiscards, 0)}`,
        ...measured.map(
          (m) =>
            `  ${m.name}: stored ${m.stored}, id-less ${m.idless}, reverts ${m.reverts}, dup-idx ${m.duplicateIndices}, ` +
            `normalisation identical ${m.normalisationIdentical}, effective old ${m.oldEffective} / new ${m.newEffective}, ` +
            `applied old ${m.oldApplied} / new ${m.newApplied}, dropped ${m.newDropped}, legacyDiscards ${m.legacyDiscards}, ` +
            `state same ${m.stateSame}, grid same ${m.gridSame}, end ${m.round}, digest ${m.newDigest}`,
        ),
      ].join("\n"),
    );
    expect(measured.length).toBeGreaterThan(0);
  });

  it("S10-22 is replay-neutral: no corpus file is supplied a legacy discard", () => {
    expect(measured.filter((m) => m.legacyDiscards > 0).map((m) => m.name)).toEqual([]);
  });

  it("S10-23: every file whose rows all carry ids normalises and replays EXACTLY as before", () => {
    const identified = measured.filter((m) => m.idless === 0);
    expect(identified.length).toBeGreaterThan(0);
    for (const m of identified) {
      expect({ name: m.name, normalisationIdentical: m.normalisationIdentical, stateSame: m.stateSame, gridSame: m.gridSame, applied: m.newApplied }).toEqual({
        name: m.name,
        normalisationIdentical: true,
        stateSame: true,
        gridSame: true,
        applied: m.oldApplied,
      });
    }
  });

  it("S10-23: no file mixes id-less rows with identified ones (the only id-less file is wholly id-less)", () => {
    expect(measured.filter((m) => m.idless > 0 && m.idless < m.stored).map((m) => m.name)).toEqual([]);
  });

  const y8v = measured.find((m) => m.name === "export/JUNO-Y8V");
  (y8v ? it : it.skip)("S10-23: JUNO-Y8V's 668 rows and 17 reverts reach the engine instead of collapsing to nothing", () => {
    const m = y8v!;
    expect({ stored: m.stored, idless: m.idless, reverts: m.reverts, duplicateIndices: m.duplicateIndices }).toEqual({
      stored: 668,
      idless: 668,
      reverts: 17,
      duplicateIndices: 0,
    });
    expect({ oldEffective: m.oldEffective, oldApplied: m.oldApplied }).toEqual({ oldEffective: 0, oldApplied: 0 });
    expect(m.newEffective).toBeGreaterThan(0);
    expect(m.newApplied).toBe(m.newEffective);
    expect(m.newApplied + m.newDropped).toBe(m.stored);
    // Measured 2026-09-23 (Stage 10.4) under engine v7: a characterization of the unchanged engine, not a rule.
    expect({ applied: m.newApplied, dropped: m.newDropped, end: m.round, digest: m.newDigest }).toEqual({
      applied: 628,
      dropped: 40,
      end: "OperatingRound 13",
      digest: "b4fae877c35604fe",
    });
  });

  (y8v ? it : it.skip)("S10-23: what JUNO-Y8V does once it replays -- reducer no-ops by kind, deterministic, no incompatibility", () => {
    const entries = files.find((f) => f.name === "export/JUNO-Y8V")!.entries;
    const list = entriesFromExport(entries);
    const seen: Array<{ index: number; key: string; digest: string }> = [];
    const result = replayLog(list, sandboxReplayProviders(), seed(), ({ entry, msg, stateBefore }) => {
      seen.push({ index: entry.index, key: Object.keys(msg as object)[0] ?? "(none)", digest: stateDigest(stateBefore) });
    }, DEVELOPMENT_CORPUS_POLICY);
    const final = stateDigest(result.state);
    const noops: Record<string, number> = {};
    let first: number | null = null;
    let count = 0;
    for (let at = 0; at < seen.length; at += 1) {
      const after = at + 1 < seen.length ? seen[at + 1].digest : final;
      if (seen[at].digest !== after) continue;
      count += 1;
      if (first === null) first = seen[at].index;
      noops[seen[at].key] = (noops[seen[at].key] ?? 0) + 1;
    }
    const again = replayLog(list, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    const state = result.state as GameStateResponse & { phase?: unknown };
    // eslint-disable-next-line no-console
    console.log(
      `JUNO-Y8V: observed ${seen.length}, reducer no-ops ${count}, first no-op idx ${first}, ` +
        `by kind ${Object.entries(noops).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}x${n}`).join(" ")}; ` +
        `unparseable ${result.unparseable.length}; legacyHomeStations ${result.legacyHomeStations.length}; ` +
        `trains ${state.public_companies.map((c) => `${c.ticker}[${(c.owned_trains ?? []).join(",")}]`).join(" ")}`,
    );
    expect(stateDigest(again.state)).toBe(final);
    expect(result.unparseable).toEqual([]);
  });
});
