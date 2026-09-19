/** @jest-environment node */
// TEMPORARY Stage-9.3 corpus snapshot probe. Writes a JSON snapshot; asserts nothing.
export {};

import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const { entriesFromExport, replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { stateDigest, fieldDigests, canonicalJson, digestOf } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");

type ExportedEntry = import("../gameEngine/replayLog").ExportedEntry;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;

const FROZEN_DIR = join(__dirname, "__fixtures__", "replayGolden", "logs");
const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const EXPORT_DIR = join(__dirname, "..", "..");
const PREFIX_DIR = join(__dirname, "__fixtures__");

const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ExportedEntry);
const exported = (file: string): ExportedEntry[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { actions?: ExportedEntry[]; entries?: ExportedEntry[] };
  return raw.actions ?? raw.entries ?? [];
};

function corpus(): Array<{ name: string; entries: ExportedEntry[] }> {
  const out: Array<{ name: string; entries: ExportedEntry[] }> = [];
  const add = (name: string, entries: ExportedEntry[]) => out.push({ name, entries });
  if (existsSync(FROZEN_DIR))
    for (const f of readdirSync(FROZEN_DIR).filter((f) => f.endsWith(".log.jsonl")).sort())
      add(`golden/${f.replace(".log.jsonl", "")}`, jsonl(join(FROZEN_DIR, f)));
  if (existsSync(SERVER_DIR))
    for (const f of readdirSync(SERVER_DIR).filter((f) => f.endsWith(".log.jsonl")).sort())
      add(`server/${f.replace(".log.jsonl", "")}`, jsonl(join(SERVER_DIR, f)));
  if (existsSync(EXPORT_DIR))
    for (const f of readdirSync(EXPORT_DIR).filter((f) => /^sandbox-log-JUNO-.*\.json$/.test(f)).sort())
      add(`export/${f.replace("sandbox-log-", "").replace(".json", "")}`, exported(join(EXPORT_DIR, f)));
  const prefix = join(PREFIX_DIR, "JUNO-FCJ-prefix96.log.jsonl");
  if (existsSync(prefix)) add("prefix/JUNO-FCJ-96", jsonl(prefix));
  const z6c = join(__dirname, "__fixtures__z6cLog.json");
  if (existsSync(z6c)) add("fixture/JUNO-Z6C-494", exported(z6c));
  return out;
}

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

const gridDigest = (grid: MapGridResponse): string =>
  digestOf(canonicalJson([...(grid.tiles ?? [])].sort((a, b) => a.q - b.q || a.r - b.r)));

const gridMap = (grid: MapGridResponse): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const t of grid.tiles ?? []) out[`${t.q},${t.r}`] = `${t.tile_id}@${t.orientation}${(t as { printed?: boolean }).printed ? "P" : ""}`;
  return out;
};

describe("STAGE-9.3 CORPUS SNAPSHOT", () => {
  it("writes the snapshot", () => {
    const target = process.env.STAGE93_SNAPSHOT;
    expect(target).toBeTruthy();
    const files: unknown[] = [];
    for (const { name, entries } of corpus()) {
      const replayEntries = entriesFromExport(entries);
      const observed: Array<{ index: number; kind: string; state: string; grid: string; gridMap: Record<string, string>; lay?: unknown }> = [];
      let result;
      try {
        result = replayLog(replayEntries, sandboxReplayProviders(), seed(), ({ entry, msg, stateBefore, grid }) => {
          const kind = Object.keys(msg as Record<string, unknown>)[0] ?? "?";
          const rec: { index: number; kind: string; state: string; grid: string; gridMap: Record<string, string>; lay?: unknown } = {
            index: entry.index,
            kind,
            state: stateDigest(stateBefore),
            grid: gridDigest(grid),
            gridMap: gridMap(grid),
          };
          if (kind === "LayTile") rec.lay = (msg as { LayTile: unknown }).LayTile;
          observed.push(rec);
        }, DEVELOPMENT_CORPUS_POLICY);
      } catch (err) {
        files.push({ name, error: String(err) });
        continue;
      }
      // Acceptance of each lay: did the grid change between this entry and the next observation / the end?
      const finalMap = gridMap(result.grid);
      const lays: unknown[] = [];
      observed.forEach((rec, i) => {
        if (rec.kind !== "LayTile") return;
        const after = i + 1 < observed.length ? observed[i + 1].gridMap : finalMap;
        const lay = rec.lay as { q: number; r: number; tile_id: number; orientation: number };
        const key = `${lay.q},${lay.r}`;
        lays.push({
          index: rec.index,
          q: lay.q, r: lay.r, tile_id: lay.tile_id, orientation: lay.orientation,
          before: rec.gridMap[key] ?? null,
          after: after[key] ?? null,
          accepted: after[key] === `${lay.tile_id}@${lay.orientation}`,
        });
      });
      files.push({
        name,
        stored: result.stored,
        applied: result.applied,
        dropped: result.dropped,
        unparseable: result.unparseable.length,
        entries: observed.map((o) => ({ index: o.index, kind: o.kind, state: o.state, grid: o.grid })),
        lays,
        finalState: stateDigest(result.state),
        finalFields: fieldDigests(result.state),
        finalGrid: gridDigest(result.grid),
        finalGridMap: finalMap,
      });
    }
    writeFileSync(target!, JSON.stringify(files, null, 1));
    console.log(`SNAPSHOT files=${files.length} -> ${target}`);
    expect(files.length).toBe(18);
  });
});
