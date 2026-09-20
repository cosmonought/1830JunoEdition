/** @jest-environment node */
export {};

import { readFileSync } from "fs";
import { join } from "path";

import { entriesFromExport, replayLog, type ExportedEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";

const DATA_DIR = join(__dirname, "..", "..", "..", "server", "data");

function loadRaw(file: string): ExportedEntry[] {
  return readFileSync(join(DATA_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);
}

function replayPrefix(file: string, count: number) {
  const all = entriesFromExport(loadRaw(file));
  const entries = all.slice(0, count);
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );
  return replayLog(entries, sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall }, undefined, DEVELOPMENT_CORPUS_POLICY);
}

describe("S9-13 corpus scan (temporary)", () => {
  it("JUNO-FCJ: did protocol_id=6 SellStock(849/851) actually change anything?", () => {
    const before849 = replayPrefix("JUNO-FCJ.log.jsonl", 849);
    const after849 = replayPrefix("JUNO-FCJ.log.jsonl", 850);
    const before851 = replayPrefix("JUNO-FCJ.log.jsonl", 851);
    const after851 = replayPrefix("JUNO-FCJ.log.jsonl", 852);

    console.log("applied/dropped 849:", after849.applied, after849.dropped);
    console.log("applied/dropped 851:", after851.applied, after851.dropped);

    const c = (r: typeof before849, id: number) => r.state.public_companies.find((x) => x.company_id === id);
    console.log("company6 before849:", JSON.stringify(c(before849, 6)));
    console.log("company6 after849 :", JSON.stringify(c(after849, 6)));
    console.log("company6 before851:", JSON.stringify(c(before851, 6)));
    console.log("company6 after851 :", JSON.stringify(c(after851, 6)));
    console.log("market6 after849:", JSON.stringify(after849.state.market_positions?.[6]));
    console.log("market6 after851:", JSON.stringify(after851.state.market_positions?.[6]));
    console.log("cash actor before849:", JSON.stringify(before849.state.player_cash.find((p)=>p.player==="p-9692z98k")));
    console.log("cash actor after849:", JSON.stringify(after849.state.player_cash.find((p)=>p.player==="p-9692z98k")));

    // also print what ticker company id 6 has generally, and all companies at before849
    console.log("all companies before849:", JSON.stringify(before849.state.public_companies.map(x=>({id:x.company_id, ticker:x.ticker, pres:x.president, dc:(x as any).double_certificate}))));

    expect(true).toBe(true);
  });
});
