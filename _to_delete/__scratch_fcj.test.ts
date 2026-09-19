import { readFileSync } from "fs";
import { RoomEngine, entriesFromExport, type ExportedEntry } from "../gameEngine/replayLog";
import { effectiveActions } from "../gameEngine/logRevert";
import { stateDigest } from "../gameEngine/stateDigest";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { operatingIdentityRefusal } from "../gameEngine/operatingIdentity";
import { stationPlacementRefusal } from "../gameEngine/stationPlacementGate";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";

const FILES = (process.env.LOGS ?? "").split(",").filter(Boolean);
const KINDS = ["LayTile", "PlaceStationToken", "RunMultipleRoutes", "RunManualRoute"];

function load(path: string): ExportedEntry[] {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ExportedEntry);
  return (JSON.parse(raw) as { actions: ExportedEntry[] }).actions;
}

it("counts refusals per log", () => {
  for (const path of FILES) {
    const entries = entriesFromExport(load(path));
    const ordered = [...entries].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    const live = effectiveActions(ordered);
    const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
    const seedWaterfall = waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []);
    const engine = new RoomEngine(sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall });
    const refused: string[] = [];
    let total = 0;
    for (const entry of live) {
      const parsed = JSON.parse(entry.payload) as Record<string, unknown>; const kind = Object.keys(parsed)[0];
      const before = stateDigest(engine.snapshot.state);
      const sBefore = engine.snapshot.state;
      const gBefore = engine.snapshot.grid;
      engine.apply(entry);
      if ([218,219,220,221,222,223,224,225].includes(entry.index)) {
        // eslint-disable-next-line no-console
        console.log(`AT ${entry.index} ${kind} pid=${(parsed as any)[kind]?.protocol_id} derived=${entry.derived} actor=${entry.actor} | before: order=${sBefore.active_operating_order}@${sBefore.active_corporation_index} step=${sBefore.operating_sub_phase} round=${sBefore.current_round_type} macro=${sBefore.macro_round_number}.${sBefore.sub_round_index} | after: order=${engine.snapshot.state.active_operating_order}@${engine.snapshot.state.active_corporation_index} step=${engine.snapshot.state.operating_sub_phase} round=${engine.snapshot.state.current_round_type}`);
      }
      if (KINDS.includes(kind)) {
        total += 1;
        if (stateDigest(engine.snapshot.state) === before) {
          const msg = parsed as never;
          const why = withRules(resolveVariants(sBefore.variants), () => operatingIdentityRefusal(sBefore, msg) ?? (kind === "PlaceStationToken" ? stationPlacementRefusal(sBefore, (parsed as any).PlaceStationToken, gBefore) : null));
          refused.push(`${entry.index}:${kind}:${(parsed as any)[kind].protocol_id} order=${sBefore.active_operating_order}@${sBefore.active_corporation_index} step=${sBefore.operating_sub_phase} round=${sBefore.current_round_type} why=${why}`);
          if (refused.length > 12) break;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`${path.split("/").pop()} applied=${live.length} ops=${total} refused=${refused.length}\n${refused.join("\n")}`);
  }
});
