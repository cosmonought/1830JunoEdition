// frontend/src/utils/roundReplay.ts
//
/* ==================================================================
    DESIGN NOTE 1425: THE BOARD AS IT STOOD AT THE END OF ANY ROUND
   ==================================================================
   ASKED: a round replayer on the final board -- a scrubber with one tick per round; dragging it shows the
   board, market and ledger as they stood at that round's end, read-only.
   THE LOG IS THE GAME (#522), SO ANY ROUND IS A PREFIX OF IT. `gameHistoryFrom` already records the log index
   at which each round opened; the board at the END of round i is the log replayed up to, but not including,
   the entry that opened round i+1 (the entry that flips the round is round i's last action and leaves the
   state labelled i+1 -- so it is excluded, and the replayed state still says "OR 6.2"). The last round runs
   to the end of the log and is the live board.
   THE SAME ENGINE, THE SAME SEED, THE SAME REVERTS as every client replays with -- so a scrubbed board is one
   the table actually saw, not a reconstruction. A 600-entry log replays in well under a second; the shell
   caches each round it has visited. */

import { RoomEngine, entriesFromExport } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { effectiveActions } from "../gameEngine/logRevert";
import type { GameStateResponse, WaterfallStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { SandboxAction } from "./sandboxRoom";
import type { RoundSample } from "./gameHistory";

export interface ReplaySnapshot {
  state: GameStateResponse;
  waterfall: WaterfallStateResponse | null;
  grid: MapGridResponse;
  /** The round the snapshot shows -- the label the scrubber prints. */
  label: string;
}

/** The first log index NOT part of round `at`: the next round's opening entry, or `Infinity` for the last. */
export function roundEndExclusive(rounds: readonly RoundSample[], at: number): number {
  const next = rounds[at + 1];
  return next ? next.atIndex : Number.POSITIVE_INFINITY;
}

/** The board at the end of round `at`. */
export function replaySnapshotAtRound(
  log: readonly SandboxAction[],
  rounds: readonly RoundSample[],
  at: number,
): ReplaySnapshot | null {
  const round = rounds[at];
  if (!round) return null;
  const end = roundEndExclusive(rounds, at);
  const scenario = sandboxScenario(DEFAULT_SANDBOX_SCENARIO);
  const engine = new RoomEngine(sandboxReplayProviders(), {
    state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(sandboxWaterfallState(scenario.phase, 0, scenario.zeroState === true), []),
  });
  for (const entry of effectiveActions(entriesFromExport(log))) {
    if (entry.index >= end) break;
    engine.apply(entry);
  }
  const snapshot = engine.snapshot;
  return { state: snapshot.state, waterfall: snapshot.waterfall, grid: snapshot.grid, label: round.label };
}
