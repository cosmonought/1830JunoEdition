// server/src/escrow/checkpointPolicy.ts
//
// ==================================================================
//  ESCROW-3B (brief §11): WHICH COMMITTED POSITIONS ARE CHECKPOINTED -- GAME SEMANTICS, NEVER UI SCREENS
// ==================================================================
//
// `CHECKPOINT_POLICY` (moneyLifecycle.ts) obliges a signed checkpoint at the deal and at every completed round
// boundary, so a stalled money game pays by the last appraisal instead of refunding (the contract's `LivenessSettle`
// promotes the best trusted checkpoint). Here is the precise rule.
//
// A board's ROUND is `(current_round_type, macro_round_number, sub_round_index)` -- the reducer's own round bookkeeping.
// A committed position is CHECKPOINTED when:
//
//   the deal            the first committed position of a dealt money game whose escrow has started (the board right
//                       after the deal batch): there is no earlier checkpoint;
//   a round boundary    a committed batch after which the round is DIFFERENT from the round of the game's newest
//                       checkpoint. That is exactly: the private auction (WaterfallAuction) giving way to the first
//                       Stock Round; a Stock Round completing into the Operating Rounds; each Operating Round completing
//                       into the next of its set (sub_round_index); the set completing into the next Stock Round
//                       (macro_round_number); the Delayed Auction variant's auction round being entered or left
//                       mid-game (the round type changes); and GameEnd;
//   the terminal seal   `seal.log_len` (GameEnd is the last boundary): posted before the Settle, from the SEALED prefix.
//
// NOT boundaries: a player's turn, a pass, a company's turn within an Operating Round, a forced purchase, a revert of
// the last action (it restores a board whose round the newest checkpoint may already cover -- the position simply is
// not checkpointed again until the round differs), and the room-close marker after the seal.
//
// WHERE, EXACTLY. The checkpoint is taken at the END of the committed batch that crossed the boundary (`log_len` = the
// committed history's length then): the board is the COMMITTED board, never speculative state and never ahead of the
// durable log. A batch that crosses two boundaries at once yields one checkpoint, at its end (the contract only ever
// uses the newest trusted checkpoint). `issued_at` is the batch's last entry's server time in whole seconds (GNOLAND-1
// O-8), so the payload re-derives byte for byte from the durable log.

import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";

/** The reducer's round, as one comparable string. */
export function roundKeyOf(board: Pick<GameStateResponse, "current_round_type" | "macro_round_number" | "sub_round_index">): string {
  return `${String(board.current_round_type)}/${String(board.macro_round_number)}/${String(board.sub_round_index)}`;
}

/** Whether a committed board is a checkpoint position, given the round of the game's newest checkpoint (null: none). */
export function isCheckpointPosition(previousRoundKey: string | null, board: Pick<GameStateResponse, "current_round_type" | "macro_round_number" | "sub_round_index">): boolean {
  return previousRoundKey === null || roundKeyOf(board) !== previousRoundKey;
}

/** A committed position captured synchronously at the commit (text, not a live board), for the signer worker. */
export interface CheckpointSnapshot {
  readonly game_id: string;
  readonly log_len: number;
  readonly round_key: string;
  /** `canonicalStateText` of the committed board: the one commitment the payload's hash and weights come from. */
  readonly canonical_text: string;
  /** The committed history, `log[0 .. log_len)` (frozen entries). */
  readonly entries: readonly ServerLogEntry[];
  /** Whole seconds: the batch's last entry's server time (O-8). */
  readonly issued_at: bigint;
}

export function issuedAtOf(entries: readonly ServerLogEntry[], logLen: number): bigint {
  const entry = entries[logLen - 1];
  const at = entry !== undefined && typeof entry.at === "number" && Number.isSafeInteger(entry.at) && entry.at >= 0 ? entry.at : 0;
  return BigInt(at) / BigInt(1000); // integer division: whole seconds, no floating point
}
