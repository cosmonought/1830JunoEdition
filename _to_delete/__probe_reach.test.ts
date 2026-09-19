import { readFileSync } from "fs";
import { join } from "path";
import { RoomEngine, entriesFromExport, type ExportedEntry } from "../gameEngine/replayLog";
import { effectiveActions } from "../gameEngine/logRevert";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { reachableCities, stationTokensOf } from "../gameEngine/trackReach";
import { citySlotCount, cityCountAt } from "../gameEngine/stationTokens";
import { STATIC_BOARD_HEXES, YELLOW_OO_HEXES } from "../components/hexBoardData";
it("probe", () => {
  const raw = readFileSync(join(__dirname, "__fixtures__", "JUNO-FCJ-prefix96.log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ExportedEntry);
  const live = effectiveActions([...entriesFromExport(raw)].sort((a, b) => a.index - b.index));
  const engine = new RoomEngine(sandboxReplayProviders(), { state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")), waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []) });
  for (const e of live) { if (e.index >= 95) break; engine.apply(e); }
  const s = engine.snapshot.state; const g = engine.snapshot.grid;
  withRules(resolveVariants(s.variants), () => {
    for (const c of s.public_companies) {
      if (!c.is_floated) continue;
      const cities = reachableCities(g, stationTokensOf(c));
      console.log(c.ticker, [...cities].filter((k) => k.startsWith("6,6")));
    }
    const bare = { game_id: 0, tiles: [] } as never;
    for (const label of ["E11", "D10", "H18", "E5", "G19", "E23", "A19", "I15"]) {
      const h = STATIC_BOARD_HEXES.find((x) => x.label === label);
      if (!h) { console.log(label, "absent"); continue; }
      console.log(label, "oo=", YELLOW_OO_HEXES.has(label), "cities=", cityCountAt(bare, h.q, h.r), "slots=", citySlotCount(bare, h.q, h.r, 0), citySlotCount(bare, h.q, h.r, 1));
    }
  });
});
