import { readFileSync } from "fs";
import { RoomEngine, entriesFromExport, type ExportedEntry } from "../gameEngine/replayLog";
import { effectiveActions } from "../gameEngine/logRevert";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { stateDigest } from "../gameEngine/stateDigest";
const FILES = (process.env.LOGS ?? "").split(",").filter(Boolean);
const KINDS = new Set(["PassTurn", "AdvanceOperatingSubPhase", "EmergencyBuyHardware", "BuyTrainFromCorporation", "BuyHardwareFromPool", "ExchangeTrainForDiesel"]);
function load(path: string): ExportedEntry[] {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ExportedEntry);
  return (JSON.parse(raw) as { actions: ExportedEntry[] }).actions;
}
it("sweeps", () => {
  for (const path of FILES) {
    const live = effectiveActions([...entriesFromExport(load(path))].sort((a, b) => a.index - b.index));
    const engine = new RoomEngine(sandboxReplayProviders(), { state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")), waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []) });
    const out: string[] = [];
    for (const e of live) {
      const m = JSON.parse(e.payload); const k = Object.keys(m)[0];
      const s0 = engine.snapshot.state; const d0 = stateDigest(s0); const r0 = JSON.stringify(s0.returned_trains ?? null);
      engine.apply(e);
      const s1 = engine.snapshot.state;
      if (KINDS.has(k) && stateDigest(s1) === d0) out.push(`  REFUSED ${e.index} ${k} ${JSON.stringify(m[k]).slice(0, 80)} derived=${e.derived ?? false}`);
      const r1 = JSON.stringify(s1.returned_trains ?? null);
      if (r0 !== r1) out.push(`  POOL ${e.index} ${k} ${r0} -> ${r1}`);
    }
    console.log(`${path.split("/").pop()} applied=${live.length}\n${out.join("\n")}`);
  }
});
