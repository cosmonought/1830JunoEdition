/**
 * JUNO-CV4 -- the Level Playing Field playtest of 8 September 2026, replayed headless.
 *
 * ==================================================================
 *  DESIGN NOTE 1279 (harness): THE LAY THE REFRESHED TAB DROPPED
 * ==================================================================
 *
 * REPORTED: one tab, after a refresh, lacked PRR's tile lay at index 137 (tile 619 on H14), and the divergence
 * alarm named `public_companies` -- PRR's `last_completed_run_revenue` was absent there and "120" on the
 * server. This file pins the SERVER's reading of the log, which is the authority: the lay stands, the route
 * at 147 runs across it, and the completed run is recorded at the turn's end.
 *
 * The client fault was the shell judging the lay against the board and tray in effect during a render-free
 * rebuild (`App.tsx` #1279); the source scan at the foot of this file pins that the check is scoped now.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { LegacyLogAdapters, RoomEngine, entriesFromExport, replayLog, type ExportedEntry, type ReplayEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY, replayCompatibility } from "../gameEngine/rulesVersion";
import { effectiveActions } from "../gameEngine/logRevert";
import { readStripped as readSource } from "./sourceScan";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { readStripped, sliceBetween } from "./sourceScan";

const GAME_ID = 0;
const PRR = 1;

function loadLog(): { actions: ExportedEntry[] } {
  const path = join(__dirname, "..", "..", "sandbox-log-JUNO-CV4.json");
  return JSON.parse(readFileSync(path, "utf8")) as { actions: ExportedEntry[] };
}

describe("JUNO-CV4 replays headless on the Level Playing Field", () => {
  const entries = entriesFromExport(loadLog().actions);
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, GAME_ID, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, GAME_ID, true),
    [],
  );
  /* #1520: THIS LOG PREDATES THE RULES-ENGINE PIN. It is replayed as a development fixture under
     `DEVELOPMENT_CORPUS_POLICY`, which is the one policy that admits a deal with no `rules_engine_version`.
     A live server refuses the same log. The policy is passed here, visibly, so nobody reads a passing golden
     test as "the server would continue this game". */
  const result = replayLog(
    entries,
    sandboxReplayProviders(),
    { state: seedState, waterfall: seedWaterfall },
    undefined,
    DEVELOPMENT_CORPUS_POLICY,
  );

  it("applies every entry that a revert did not kill", () => {
    expect(entries).toHaveLength(150);
    expect(result.unparseable).toEqual([]);
    expect(result.applied).toBe(120);
    expect(result.dropped).toBe(30);
  });

  it("keeps PRR's tile 619 on H14 -- the lay the refreshed tab lost", () => {
    const tile = result.grid.tiles.find((entry) => entry.q === 4 && entry.r === 7);
    expect(tile?.tile_id).toBe(619);
  });

  it("records PRR's completed run, which is what the alarm named", () => {
    const prr = result.state.public_companies.find((company) => company.company_id === PRR);
    expect(prr?.last_completed_run_revenue).toBe("120");
    expect(prr?.treasury).toBe("740");
  });

  it("owes C&O a Tokens step after its lay at 131, not a skip (design note #1287)", () => {
    /* REPORTED: "C&O has two valid city markers where it can place stations. After laying track, it
       autoskips to Run Routes." Index 132 in this log is that skip -- derived, i.e. the server's verdict.
       The server decided what the game owed with the STANDARD board in effect (nothing on a bare Node
       process activates one), so C&O's LPF network reached nothing and "nowhere to place" was the answer.
       `settleOwed` now asks under the game's own rules. Replayed to 131 and asked afresh: the first thing
       the game owes must not be an advance off the Tokens step. */
    const live = effectiveActions(
      [...entries].sort((a, b) => a.index - b.index).filter((entry) => entry.index <= 131),
    );
    const providers = sandboxReplayProviders();
    const engine = new RoomEngine(providers, { state: seedState, waterfall: seedWaterfall });
    /* Slice 8.2 (#1614a): walked through the development corpus's adapters -- the policy the golden replay above
       passes by name. A bare `engine.apply` walk replays a policy nobody passed: since #1610 B&O's home placement
       at 20 (a Stock Round) is refused as untimely, the walk stops behind B&O's home hold at its first operating
       turn (after 26), and it never reaches C&O's lay at 131. Through the adapters each remembered choice is tried
       at its corporation's first turn (B&O after 26, C&O after 62), exactly as `replayLog` tries it. Measured
       against the pre-8.2 walk of this test: the board at 131 is the same state and the same grid, field for field. */
    const adapters = new LegacyLogAdapters(providers, replayCompatibility(live), DEVELOPMENT_CORPUS_POLICY);
    for (const entry of live) adapters.apply(engine, entry);
    expect(adapters.legacyHomeStations.map((attempt) => [attempt.companyId, attempt.applied])).toEqual([
      [4, true],
      [5, true],
    ]);
    expect(engine.snapshot.state.operating_sub_phase).toBe("Tokens");
    let n = 0;
    const mint = (msg: unknown, reason: string): ReplayEntry => ({
      index: 1000 + n,
      id: `derived-${(n += 1)}`,
      actor: "p-vmlqoi42",
      payload: JSON.stringify(msg),
      derived: true,
      at: 0,
    });
    const owed = engine.settleOwed(mint);
    const first = owed[0] ? (JSON.parse(owed[0].payload) as Record<string, unknown>) : null;
    expect(first === null || !("AdvanceOperatingSubPhase" in first)).toBe(true);
    expect(readSource("gameEngine/replayLog.ts")).toContain(
      "const next = withRules(resolveVariants(this.state.variants), () =>",
    );
  });

  it("judges a lay in the shell under the same rules the reducer uses", () => {
    /* THE CLIENT HALF. `filterSandboxPlacements` reads the board and tray in effect; the shell now puts this
       game's in effect for the instant of the check rather than trusting the last render to have done so. */
    const app = readStripped("App.tsx");
    const check = sliceBetween(app, "const rulesBeforeAction =", "if (\"LayTile\" in msg)");
    expect(check).toContain("withRules(");
    /* Stage 10.1 (#1683): the geometry is `boardLayRefused` -- the engine providers' own `filterSandboxPlacements`
       call, exported from `replayProviders.ts` -- and the authority verdict is scoped by `withRules` too. */
    expect(check).toContain("boardLayRefused(");
    expect(readStripped("gameEngine/replayProviders.ts")).toContain("layRefused: boardLayRefused,");
  });
});
