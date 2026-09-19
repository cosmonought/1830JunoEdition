/** @jest-environment node */
// TEMPORARY Stage-9.3 causal probe for the three audited corpus transitions.
export {};

import { readFileSync } from "fs";
import { join } from "path";

const { entriesFromExport, replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { DEVELOPMENT_CORPUS_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { operatingIdentityRefusal } = require("../gameEngine/operatingIdentity") as typeof import("../gameEngine/operatingIdentity");
const { filterSandboxPlacements } = require("../components/sandboxTileLegality") as typeof import("../components/sandboxTileLegality");

type ExportedEntry = import("../gameEngine/replayLog").ExportedEntry;

const jsonl = (file: string): ExportedEntry[] =>
  readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ExportedEntry);

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

const SERVER_DIR = join(__dirname, "..", "..", "..", "server", "data");
const WATCH: Record<string, number[]> = {
  "JUNO-FCJ": [555, 640, 988, 1047],
  "JUNO-Z6C": [378, 399],
};

describe("STAGE-9.3 CAUSE PROBE", () => {
  it("reports the gate that answers each watched entry", () => {
    for (const [room, indices] of Object.entries(WATCH)) {
      const entries = entriesFromExport(jsonl(join(SERVER_DIR, `${room}.log.jsonl`)));
      replayLog(entries, sandboxReplayProviders(), seed(), ((observation: Record<string, unknown>) => {
        const { entry, msg, stateBefore, grid } = observation as never as { entry: { index: number }; msg: unknown; stateBefore: unknown; grid: unknown };
        if (!indices.includes(entry.index)) return;
        const m = msg as { LayTile?: { q: number; r: number; tile_id: number; orientation: number } };
        if (!m.LayTile) return;
        const lay = m.LayTile;
        const identity = operatingIdentityRefusal(stateBefore as never, msg as never);
        const onHex = ((grid as { tiles: Array<{ q: number; r: number; tile_id: number; orientation: number }> }).tiles ?? [])
          .find((t) => t.q === lay.q && t.r === lay.r);
        const geometric: Record<string, boolean> = {};
        for (const e of ["Yellow", "Green", "Brown", "Gray"] as const) {
          geometric[e] =
            filterSandboxPlacements([{ tile_id: lay.tile_id, orientation: lay.orientation }], {
              mapGrid: grid as never,
              q: lay.q,
              r: lay.r,
              era: e,
            }).length > 0;
        }
        const st = stateBefore as unknown as Record<string, unknown>;
        console.log(
          `CAUSE ${room} idx=${entry.index} lay=${lay.tile_id}@${lay.orientation}@(${lay.q},${lay.r}) ` +
            `hexHolds=${onHex ? `${onHex.tile_id}@${onHex.orientation}` : "EMPTY"} ` +
            `identityRefusal=${JSON.stringify(identity)} ` +
            `round=${String(st.current_round_type)} phase=${String(st.phase ?? st.current_phase)} ` +
            `geometricAccept=${JSON.stringify(geometric)}`,
        );
      }) as never, DEVELOPMENT_CORPUS_POLICY);
    }
    expect(true).toBe(true);
  });
});
