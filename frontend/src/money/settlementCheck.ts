// frontend/src/money/settlementCheck.ts
//
// ==================================================================
//  ESCROW-4 (review S-H1): "APPROVE PAYOUT NOW" ONLY FOR A PAYOUT THIS DEVICE RE-DERIVED ITSELF
// ==================================================================
//
// Early approval skips the challenge window -- the players' defence against a wrong payout -- so a device offers it
// only when it has recomputed the recorded settlement from its OWN copy of the game, the way the server made it
// (`server/src/escrow/settlementEvidence.ts`) and the way a resolver checks it (`settlementConformance.ts`):
//
//   1. the payload is a server TERMINAL settlement (kind Terminal, `appraisal_log_len == log_len`, A1);
//   2. this device's log covers it exactly: the first `log_len` entries hash to `log_hash`, and every entry after them
//      is a room-close marker (nothing played after the seal);
//   3. those `log_len` entries, replayed here exactly as the server replays them (`replaySealedPrefix`: the default
//      seed, the server's replay policy), end at GameEnd;
//   4. that board's certified appraisal, laid out in the frozen roster's chain seat order, IS the payload's
//      `appraisal_state_hash` and `settlement_weights` (`verifySettlementPayloadV1`, which also applies every contract
//      rule for a Settle);
//   5. the roster the server reports puts THIS player on the chain seat this device can see is its own -- read from
//      Juno through the pinned endpoint (the seat carrying the signing key this device holds, or the seat's wallet) --
//      so no weight of this seat can have been swapped with another's. A swap among OTHER seats is caught by their own
//      devices, which then don't approve (early release needs every seat) and can dispute in the window.
//
// Anything this device cannot establish is "unavailable" (no early approval; the payout still goes out when the window
// closes). Only a demonstrated disagreement is "mismatch" (the band then leads with Dispute).

import { canonicalStateText } from "../gameEngine/settlementDigest";
import { verifySettlementPayloadV1 } from "../gameEngine/settlementConformance";
import { SETTLEMENT_PAYLOAD_KIND, SettlementPayloadError, type SettlementPayloadV1 } from "../gameEngine/settlementPayload";
import { logHash, type HashableLogEntry } from "../gameEngine/logHash";
import type { GameStateResponse } from "../gameEngine/gameState";
import { DEFAULT_SANDBOX_SCENARIO, sandboxReplayProviders, sandboxScenario, sandboxScenarioState, sandboxWaterfallState, waterfallForRoster, withEmptyRoster } from "../gameEngine";
import { SERVER_REPLAY_POLICY } from "../gameEngine/rulesVersion";
import { RoomSession, type ServerLogEntry } from "../utils/roomSession";

/** Replays exactly the sealed prefix to its board (null: this device can't). */
export type SealedReplay = (prefix: readonly HashableLogEntry[]) => GameStateResponse | null;

/** The server's own replay (`server/src/tools/verifySession.ts`), run here: the same seed, the same providers, the
 *  server's replay policy (an unpinned or unsupported pin is refused, never reinterpreted). */
export const replaySealedPrefix: SealedReplay = (prefix) => {
  let minted = 0;
  try {
    const session = new RoomSession({
      providers: sandboxReplayProviders(),
      seed: {
        state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
        waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
      },
      /* A label on frames this session never sends: nothing compares it. */
      build: "settlement-check",
      mintId: () => `check-${(minted += 1)}`,
      now: () => 0,
      replayPolicy: SERVER_REPLAY_POLICY,
    });
    if (prefix.length > 0) session.restore(prefix as readonly ServerLogEntry[]);
    return session.incompatible === null ? session.state : null;
  } catch {
    return null;
  }
};

export interface RosterSeat {
  readonly playerId: string;
  readonly chainSeatIndex: number;
}

export interface TerminalCheckInput {
  readonly payload: SettlementPayloadV1;
  /** This device's whole log of the game (entries from index 0). */
  readonly log: readonly HashableLogEntry[];
  /** The frozen roster, as the server reports it: every seat's chain position. */
  readonly roster: readonly RosterSeat[];
  /** This seat's player id and the chain seat Juno shows as this seat's (read here, not from the server). */
  readonly playerId: string;
  readonly chainSeatIndex: number;
  readonly replay?: SealedReplay;
}

export type TerminalCheck = { readonly result: "match" | "mismatch" | "unavailable"; readonly detail: string };

const isCloseRoom = (entry: HashableLogEntry): boolean => {
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    return typeof parsed === "object" && parsed !== null && "CloseRoom" in parsed;
  } catch {
    return false;
  }
};

export function checkTerminalSettlement(input: TerminalCheckInput): TerminalCheck {
  const { payload, log, roster } = input;
  const unavailable = (detail: string): TerminalCheck => ({ result: "unavailable", detail });
  const mismatch = (detail: string): TerminalCheck => ({ result: "mismatch", detail });
  if (payload.kind !== SETTLEMENT_PAYLOAD_KIND.Terminal || payload.appraisal_log_len !== payload.log_len) {
    return unavailable("The recorded payout isn't this server's final settlement, so this device doesn't approve it early.");
  }
  const logLen = Number(payload.log_len);
  if (!Number.isSafeInteger(logLen) || logLen < 1) return mismatch("The recorded payout covers no moves.");
  if (log.length < logLen) return unavailable("This device doesn't hold the whole game to re-check it.");
  for (let at = 0; at < log.length; at += 1) {
    if (log[at].index !== at) return unavailable("This device's copy of the game has a gap, so it can't re-check the payout.");
  }
  for (let at = logLen; at < log.length; at += 1) {
    if (!isCloseRoom(log[at])) return mismatch("The recorded payout ends before the last move this device saw.");
  }
  let history: string;
  try {
    history = logHash(log, logLen);
  } catch {
    return unavailable("This device's copy of the game couldn't be hashed.");
  }
  if (history !== payload.log_hash) return mismatch("The payout Juno recorded doesn't cover the moves this device played.");
  /* The roster: one seat per chain position 0..n-1, one position per seated player, this player where Juno says. */
  const n = payload.settlement_weights.length;
  const byIndex = new Map<number, string>();
  for (const seat of roster) {
    if (!Number.isInteger(seat.chainSeatIndex) || seat.chainSeatIndex < 0 || seat.chainSeatIndex >= n || byIndex.has(seat.chainSeatIndex)) return mismatch("The table's roster doesn't match the recorded payout's seats.");
    byIndex.set(seat.chainSeatIndex, seat.playerId);
  }
  if (byIndex.size !== n || new Set(roster.map((seat) => seat.playerId)).size !== n) return mismatch("The table's roster doesn't match the recorded payout's seats.");
  if (byIndex.get(input.chainSeatIndex) !== input.playerId) return mismatch("The recorded payout doesn't put your result on your seat on Juno.");
  const replay = input.replay ?? replaySealedPrefix;
  const board = replay(log.slice(0, logLen));
  if (board === null) return unavailable("This device couldn't replay the game to re-check the payout.");
  if (board.current_round_type !== "GameEnd") return mismatch("The recorded payout is for a game that hadn't ended at that move.");
  const players = new Set(board.player_addresses ?? []);
  if (players.size !== n || roster.some((seat) => !players.has(seat.playerId))) return mismatch("The table's roster doesn't match the game's players.");
  const seats = Array.from(byIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([seat_index, player_id]) => ({ seat_index, player_id }));
  try {
    verifySettlementPayloadV1(payload, canonicalStateText(board), seats, undefined, "Settle");
  } catch (error) {
    if (error instanceof SettlementPayloadError && error.code === "PAYLOAD_APPRAISAL_MISMATCH") return mismatch("The payout Juno recorded doesn't match this device's own count of the final standings.");
    if (error instanceof SettlementPayloadError) return mismatch("The payout Juno recorded breaks the settlement rules.");
    return unavailable("This device can't appraise this game's final board (its rules aren't certified here).");
  }
  return { result: "match", detail: "Checked on this device: the recorded payout is exactly this game's final standings, counted here." };
}
