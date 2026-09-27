// server/src/tools/verifySession.ts
//
// LIVE-3C: a stored log replayed exactly as the server's load replays it -- the same session, the same seed, the
// server's replay policy (an unpinned or unsupported pin is refused, never reinterpreted, #1520) -- for the offline
// operator tool's verification. Nothing here reads or writes a file.

import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  waterfallForRoster,
  withEmptyRoster,
} from "../../../frontend/src/gameEngine";
import { SERVER_REPLAY_POLICY } from "../../../frontend/src/gameEngine/rulesVersion";
import { RoomSession, type ServerLogEntry } from "../../../frontend/src/utils/roomSession";

export type SessionVerification =
  | { readonly ok: true; readonly session: RoomSession; readonly incompatible: boolean }
  | { readonly ok: false; readonly reason: string };

export function verifySession(entries: readonly ServerLogEntry[], build: string): SessionVerification {
  let minted = 0;
  const session = new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build,
    mintId: () => `verify-${(minted += 1)}`,
    now: () => Date.now(),
    replayPolicy: SERVER_REPLAY_POLICY,
  });
  try {
    if (entries.length > 0) session.restore(entries);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, session, incompatible: session.incompatible !== null };
}
