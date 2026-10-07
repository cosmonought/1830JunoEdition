// server/src/escrow/settlementEvidence.ts
//
// ==================================================================
//  ESCROW-3A (brief §5): THE TERMINAL SETTLEMENT EVIDENCE -- DERIVED FROM EXACTLY THE SEALED PREFIX
// ==================================================================
//
// Everything a terminal settlement will commit to, derived ONCE from `log[0 .. seal.log_len)` (`sealedPrefix`) and
// nothing after it: the log hash over exactly that prefix, the board it replays to, that board's
// `terminal_state_hash_v1` (the payload's `appraisal_state_hash`, A1: `appraisal_log_len == log_len` for the reasons a
// sealed game can end by), the rules pin and whether settlement is certified for it, the terminal reason, and the
// certified appraisal's per-player totals. A trailing `CloseRoom` -- or ten -- changes the log, its hash and the live
// board (`room_closed`); it changes none of this, and `settlementLifecycle.test` pins that.
//
// What this does NOT do (ESCROW-3B): read the chain, choose chain seat order (the weights in chain order come from
// `SetupGame.escrow`'s bindings), build or sign a payload, or invent a transaction. The per-player totals here are the
// appraisal's own (turn order, keyed by the log's `player_id`s -- no principal); 3B maps them to chain seats through the
// frozen roster and rebuilds the payload with `buildSettlementCoreV1`, which must agree.

/* Phase 3 final clocks: the CUMULATIVE log hash (segment checkpoints) -- exactly `logHash`, without re-reading a long
   history at every boundary. */
import { cumulativeLogHash as logHash } from "../../../frontend/src/gameEngine/logHash";
import { appraiseCommittedState, canonicalStateText, terminalStateHashV1 } from "../../../frontend/src/gameEngine/settlementDigest";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS, SettlementAppraisalError } from "../../../frontend/src/gameEngine/settlementAppraisal";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { sealedPrefix, SealedPrefixError, type TerminalSeal } from "../rooms/lifecycle";
import { verifySession } from "../tools/verifySession";
import type { FinancialHoldCode } from "./moneyLifecycle";

export const SETTLEMENT_EVIDENCE_FORMAT = "18COSMOS/SETTLEMENT-EVIDENCE/v1";

export interface TerminalSettlementEvidence {
  readonly format: typeof SETTLEMENT_EVIDENCE_FORMAT;
  readonly game_id: string;
  /** THE IDENTITY of this terminal history: `(game_id, log_len)`. */
  readonly log_len: number;
  readonly sealed_at: number;
  /** `logHash(entries, log_len)` over the RAW prefix (SET-0C §18 obligation 1). */
  readonly log_hash: string;
  /** == log_len for BankBroken / Bankruptcy (A1). */
  readonly appraisal_log_len: number;
  /** `terminal_state_hash_v1` of the board after entry `log_len - 1`. */
  readonly appraisal_state_hash: string;
  readonly rules_engine_version: number;
  readonly terminal_reason: "BankBroken" | "Bankruptcy";
  /** The deal's seat order (log `player_id`s; never a principal). */
  readonly players: readonly string[];
  /** The certified appraisal of the sealed board, whole VGP as decimal strings, by `player_id`. */
  readonly totals: Readonly<Record<string, string>>;
}

export type EvidenceOutcome =
  | { readonly ok: true; readonly evidence: TerminalSettlementEvidence }
  | { readonly ok: false; readonly code: FinancialHoldCode; readonly detail: string };

/** How the prefix is replayed to its board -- the server's own load path by default; a test seam may substitute. */
export type PrefixReplay = (prefix: readonly ServerLogEntry[]) => { ok: true; board: GameStateResponse } | { ok: false; reason: string };

export const serverPrefixReplay =
  (build: string): PrefixReplay =>
  (prefix) => {
    const replay = verifySession(prefix, build);
    if (!replay.ok) return { ok: false, reason: replay.reason };
    if (replay.incompatible) return { ok: false, reason: "the deal's rules pin is not supported on this deployment" };
    return { ok: true, board: replay.session.state };
  };

/** The terminal evidence of `(gameId, seal)`, or the hold it calls for. Pure but for the replay. */
export function prepareTerminalEvidence(input: {
  readonly gameId: string;
  readonly entries: readonly ServerLogEntry[];
  readonly seal: TerminalSeal;
  readonly replay: PrefixReplay;
}): EvidenceOutcome {
  let prefix: readonly ServerLogEntry[];
  let sealedAt: number;
  try {
    const history = sealedPrefix(input.entries, input.seal);
    prefix = history.prefix;
    sealedAt = history.seal.at;
  } catch (error) {
    if (error instanceof SealedPrefixError) return { ok: false, code: "sealed-prefix-refused", detail: error.message };
    throw error;
  }
  const replayed = input.replay(prefix);
  if (!replayed.ok) return { ok: false, code: "replay-failed", detail: replayed.reason.slice(0, 400) };
  const board = replayed.board;
  if (board.current_round_type !== "GameEnd") return { ok: false, code: "board-not-terminal", detail: `the sealed prefix replays to ${String(board.current_round_type)}` };
  const bankrupt = (board as { bankrupt_president?: string | null }).bankrupt_president ?? null;
  const broken = (board as { bank_broken?: boolean }).bank_broken === true;
  if (bankrupt === null && !broken) return { ok: false, code: "board-not-terminal", detail: "GameEnd with neither a bankrupt president nor a broken bank" };
  const pin = board.rules_engine_version;
  if (typeof pin !== "number" || !SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS.includes(pin)) {
    return { ok: false, code: "rules-not-certified", detail: `rules engine ${String(pin)} is not settlement-certified (certified: ${SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS.join(", ")})` };
  }
  const players = [...board.player_addresses];
  const text = canonicalStateText(board);
  let appraised: ReturnType<typeof appraiseCommittedState>;
  try {
    appraised = appraiseCommittedState(text, players.map((player_id, seat_index) => ({ seat_index, player_id })));
  } catch (error) {
    if (error instanceof SettlementAppraisalError) return { ok: false, code: "appraisal-refused", detail: error.message.slice(0, 400) };
    throw error;
  }
  /* One snapshot: the hash of the text the appraisal read (SET-0C §14), checked against the board object's own hash. */
  if (appraised.appraisal_state_hash !== terminalStateHashV1(board)) return { ok: false, code: "appraisal-refused", detail: "the committed text and the board disagree" };
  const totals: Record<string, string> = {};
  for (const seat of appraised.appraisals) totals[seat.player_id] = seat.total.toString();
  return {
    ok: true,
    evidence: {
      format: SETTLEMENT_EVIDENCE_FORMAT,
      game_id: input.gameId,
      log_len: input.seal.log_len,
      sealed_at: sealedAt,
      log_hash: logHash(prefix, input.seal.log_len),
      appraisal_log_len: input.seal.log_len,
      appraisal_state_hash: appraised.appraisal_state_hash,
      rules_engine_version: pin,
      terminal_reason: bankrupt !== null ? "Bankruptcy" : "BankBroken",
      players,
      totals,
    },
  };
}
