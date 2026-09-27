// frontend/src/utils/rulesBoundaryScan.ts
//
// ==================================================================
//  DA-8: THE v10 -> v11 BOUNDARY SCAN -- WHICH STORED v10 ENTRIES WOULD MEAN SOMETHING ELSE NOW (read-only)
// ==================================================================
//
// Rules engine 11 carries the Delayed Auction's semantics (changelog row 11). A room pinned to 10 is HELD by a v11 server
// -- never reinterpreted -- so no stored v10 entry is ever silently re-read. This scan answers the question the boundary
// leaves for the operator: of the v10 games a data directory actually holds, which entries are the ones the new
// semantics touch? It is what `gamesDoctor scan-v10` runs over a DATA_DIR, and what `da8RulesV11Closure.test.ts` runs over
// the repository's copies.
//
// INSPECTION, NEVER A RESTORE. It replays a pinned log through a bare `RoomEngine` -- the reducer, entry by entry, with
// the server's seed and providers -- WITHOUT asking `replayRefusal`, because the question is exactly what this engine
// would make of history it will not continue. Nothing it builds is kept, served or written; it never repairs, rewrites
// or re-pins anything. What it reports about the board BEFORE a flagged entry is the current reducer's reading of the
// prefix -- exact up to the first flagged entry, which is where any divergence would begin.
//
// WHAT IS FLAGGED (the patterns the DA audit, Phase 2A and DA-7 routed to this boundary):
//   A  `BeginOperatingRound` committed on a pinned board -- refused in every round since RR2A-F1; the round it was sent
//      in is reported (auction / Stock Round / Operating Round / GameEnd).
//   B  a Stock / Operating Round `PassTurn` committed while the board was the private auction (RR2A-F1).
//   C  DA-F5's shape, exactly as the audit words it (§23): the Schuylkill Valley marked down to $0 and taken by the next
//      seat -- the pass that moved it from the auction to a player at `settled_price` 0. DA-4 moved the Priority Deal such
//      an auction hands off (the taker's left, not the taker).
//   F12  a revenue all-pass (the SV sold, the table passed round) after which the sequence resumed somewhere other than
//      the seat after the last passer -- i.e. where DA-8's DA-F12 correction (resume on the Priority Deal holder) differs
//      from what the v10 engine did.
//   X  any other committed entry the current reducer leaves UNCHANGED -- it would now be refused (DA-3's auction and B&O
//      gates, DA-5's must-sell pass hold, ...). This is the generic detector: a v10 entry the new rules would not apply.
//   D  (informational) a harmless duplicate consent answer (C2-02): it replays as the no-op it always was; DA-7 only
//      stopped appending new ones.
// A, B, C, F12 and X are the entries whose meaning differs under v11; D is log shape only.

import type { GameStateResponse } from "../gameEngine/gameState";
import { RoomEngine, type ReplayEntry } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { effectiveActions } from "../gameEngine/logRevert";
import { rulesEngineVersionOf } from "../gameEngine/rulesVersion";
import { stateDigest } from "../gameEngine/stateDigest";
import { SV_PRIVATE_ID } from "../gameEngine/gameConstants";
import { harmlessDuplicateAnswer } from "../gameEngine/harmlessDuplicate";

/** The version whose stored history this boundary is about. */
export const BOUNDARY_SCAN_VERSION = 10;

export type BoundaryPattern = "A" | "B" | "C" | "F12" | "X" | "D";

/** Which patterns mean the entry reads differently under v11 (D is log shape only). */
export const SEMANTIC_PATTERNS: readonly BoundaryPattern[] = ["A", "B", "C", "F12", "X"];

export interface BoundaryHit {
  readonly pattern: BoundaryPattern;
  /** The entry's own log index. */
  readonly index: number;
  /** The message kind (`BeginOperatingRound`, `PassTurn`, ...). Never an actor: principal ids are not reported. */
  readonly kind: string;
  /** The board's round immediately before the entry, as the current reducer reads the prefix. */
  readonly roundBefore: string | null;
  readonly detail: string;
}

export interface GameBoundaryScan {
  readonly name: string;
  /** The deal's pin: a number, `null` for an unpinned (legacy) deal, `undefined` for a log with no deal. */
  readonly pin: number | null | undefined;
  /** Whether the game is pinned to the scanned version (and was therefore replayed). */
  readonly scanned: boolean;
  readonly entries: number;
  readonly effective: number;
  /** Revenue all-passes seen (the population F12 is asked of). */
  readonly revenueAllPasses: number;
  readonly hits: readonly BoundaryHit[];
  /** Set when the replay itself failed; the hits before it stand. */
  readonly error?: string;
}

const seed = () => ({
  state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});

const boardOf = (engine: RoomEngine): GameStateResponse =>
  ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as GameStateResponse;

const svOf = (board: GameStateResponse) => board.private_companies.find((entry) => entry.private_id === SV_PRIVATE_ID) ?? null;

function nextSeat(players: readonly string[], current: string): string | null {
  const at = players.indexOf(current);
  return at === -1 || players.length === 0 ? null : players[(at + 1) % players.length];
}

/** Scans one stored log. Replays only a log pinned to `version` (default 10); any other log is reported by its pin. */
export function scanPinnedHistory(
  name: string,
  entries: readonly ReplayEntry[],
  options: { version?: number } = {},
): GameBoundaryScan {
  const version = options.version ?? BOUNDARY_SCAN_VERSION;
  const pin = rulesEngineVersionOf(entries);
  const live = effectiveActions(entries);
  const base = { name, pin, entries: entries.length, effective: live.length };
  if (pin !== version) return { ...base, scanned: false, revenueAllPasses: 0, hits: [] };

  const engine = new RoomEngine(sandboxReplayProviders(), seed() as never);
  const hits: BoundaryHit[] = [];
  let revenueAllPasses = 0;
  for (const entry of live) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(entry.payload) as Record<string, unknown>;
    } catch {
      hits.push({ pattern: "X", index: entry.index, kind: "(unparseable)", roundBefore: null, detail: "the payload is not JSON" });
      continue;
    }
    const kind = typeof msg === "object" && msg !== null ? (Object.keys(msg)[0] ?? "(empty)") : "(not an object)";
    const before = boardOf(engine);
    const digestBefore = stateDigest(before);
    const roundBefore = before.current_round_type ?? null;
    try {
      engine.apply(entry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ...base, scanned: true, revenueAllPasses, hits, error: `entry ${entry.index} (${kind}): ${reason}` };
    }
    const after = boardOf(engine);
    const unchanged = stateDigest(after) === digestBefore;
    const flag = (pattern: BoundaryPattern, detail: string) => hits.push({ pattern, index: entry.index, kind, roundBefore, detail });

    if (kind === "BeginOperatingRound") {
      flag("A", `sent in the ${roundBefore ?? "unknown"} round; ${unchanged ? "refused" : "applied"} by the current engine`);
      continue;
    }
    if (kind === "PassTurn" && roundBefore === "WaterfallAuction") {
      flag("B", `a Stock / Operating Round pass inside the private auction; ${unchanged ? "refused" : "applied"} by the current engine`);
      continue;
    }
    if (kind === "WaterfallPass") {
      const svBefore = svOf(before);
      const svAfter = svOf(after);
      if (svBefore && !svBefore.owner && svAfter?.owner && svAfter.settled_price === 0) {
        const delayed = (before.variants as { delayedAuction?: unknown } | undefined)?.delayedAuction === true;
        flag("C", `the SV marked down to $0 and taken (${delayed ? "Delayed Auction" : "standard auction"}); DA-4 hands the Priority Deal to the taker's left`);
        continue;
      }
      const atom = before.waterfall ?? null;
      const players = before.player_addresses ?? [];
      if (
        atom !== null &&
        !unchanged &&
        roundBefore === "WaterfallAuction" &&
        !atom.mini_auction &&
        !atom.privates.some((entry) => entry.private_id === SV_PRIVATE_ID) &&
        players.length > 0 &&
        atom.consecutive_waterfall_passes + 1 >= players.length
      ) {
        revenueAllPasses += 1;
        const legacy = nextSeat(players, atom.current_turn);
        const resumed = after.waterfall?.current_turn ?? "";
        if (legacy !== null && resumed !== legacy) {
          flag("F12", `a revenue all-pass: v10 resumed on seat ${players.indexOf(legacy)}, v11 on the Priority Deal holder, seat ${players.indexOf(resumed)}`);
        }
        continue;
      }
    }
    if (unchanged) {
      if (harmlessDuplicateAnswer(before, msg)) flag("D", "a harmless duplicate consent answer (C2-02): it replays as the no-op it always was");
      else flag("X", "a committed entry the current engine leaves unchanged -- it would be refused now");
    }
  }
  return { ...base, scanned: true, revenueAllPasses, hits };
}

export interface BoundaryScanSummary {
  readonly logs: number;
  readonly byPin: Readonly<Record<string, number>>;
  readonly scanned: number;
  readonly revenueAllPasses: number;
  readonly counts: Readonly<Record<BoundaryPattern, number>>;
  readonly errors: number;
  /** No semantic hit and no replay error in any scanned game. */
  readonly clean: boolean;
}

export function summarizeBoundaryScan(games: readonly GameBoundaryScan[]): BoundaryScanSummary {
  const byPin: Record<string, number> = {};
  const counts: Record<BoundaryPattern, number> = { A: 0, B: 0, C: 0, F12: 0, X: 0, D: 0 };
  let scanned = 0;
  let revenueAllPasses = 0;
  let errors = 0;
  for (const game of games) {
    const key = game.pin === undefined ? "undealt" : game.pin === null ? "unpinned" : `v${game.pin}`;
    byPin[key] = (byPin[key] ?? 0) + 1;
    if (game.scanned) scanned += 1;
    revenueAllPasses += game.revenueAllPasses;
    if (game.error) errors += 1;
    for (const hit of game.hits) counts[hit.pattern] += 1;
  }
  const semantic = SEMANTIC_PATTERNS.reduce((sum, pattern) => sum + counts[pattern], 0);
  return { logs: games.length, byPin, scanned, revenueAllPasses, counts, errors, clean: semantic === 0 && errors === 0 };
}
