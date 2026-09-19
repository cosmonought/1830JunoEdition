/** @jest-environment node */
// THROWAWAY RESEARCH SCAN -- S9-12, not part of the deliverable. Deleted after use.
export {};

import { readFileSync } from "fs";
import { join } from "path";
import { entriesFromExport, replayLog } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { dhStationRefusal } from "../gameEngine/dhStationAuthority";

const exported = (file: string): any[] => {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return raw.actions ?? raw.entries ?? [];
};

it("replays JUNO-3XD up to idx 115 and diagnoses the D&H free-station entry", () => {
  const EXPORT_DIR = join(__dirname, "..", "..");
  const file = join(EXPORT_DIR, "sandbox-log-JUNO-3XD.json");
  const raw = exported(file);
  const allEntries = entriesFromExport(raw);
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );
  // Replay only through idx 114 (inclusive) -- everything up to and including the LayTile.
  const before = allEntries.slice(0, 115);
  const resultBefore = replayLog(before, sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall }, undefined, DEVELOPMENT_CORPUS_POLICY);
  // eslint-disable-next-line no-console
  console.log(`through idx 114: applied=${resultBefore.applied} dropped=${resultBefore.dropped}`);
  const dh = resultBefore.state.private_companies.find((p: any) => p.private_id === 3);
  // eslint-disable-next-line no-console
  console.log(`D&H at that point: ${JSON.stringify(dh)}`);
  const corp7 = resultBefore.state.public_companies.find((c: any) => c.company_id === 7);
  // eslint-disable-next-line no-console
  console.log(`corp7 is_floated=${corp7?.is_floated} station_token_hexes=${JSON.stringify(corp7?.station_token_hexes)} station_token_limit=${corp7?.station_token_limit}`);
  // eslint-disable-next-line no-console
  console.log(`used_private_abilities=${JSON.stringify(resultBefore.state.used_private_abilities)}`);
  // eslint-disable-next-line no-console
  console.log(`dh_station_pending=${JSON.stringify((resultBefore.state as any).dh_station_pending)}`);
  // eslint-disable-next-line no-console
  console.log(`active_operating_order=${JSON.stringify(resultBefore.state.active_operating_order)} active_corporation_index=${resultBefore.state.active_corporation_index}`);

  const msg115 = allEntries[115];
  // eslint-disable-next-line no-console
  console.log(`entry 115 raw: ${JSON.stringify(msg115)}`);
  const placement = (msg115 as any).action?.PlaceHomeStation ?? (msg115 as any).msg?.PlaceHomeStation ?? (msg115 as any).PlaceHomeStation;
  const reason = dhStationRefusal(resultBefore.state, placement, resultBefore.grid);
  // eslint-disable-next-line no-console
  console.log(`dhStationRefusal at idx 115: ${reason}`);

  // Now apply idx 115 too and see what happened.
  const through115 = allEntries.slice(0, 116);
  const resultAfter = replayLog(through115, sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall }, undefined, DEVELOPMENT_CORPUS_POLICY);
  // eslint-disable-next-line no-console
  console.log(`through idx 115: applied=${resultAfter.applied} dropped=${resultAfter.dropped}`);
  const corp7After = resultAfter.state.public_companies.find((c: any) => c.company_id === 7);
  // eslint-disable-next-line no-console
  console.log(`corp7 station_token_hexes after 115: ${JSON.stringify(corp7After?.station_token_hexes)}`);

  expect(true).toBe(true);
});
