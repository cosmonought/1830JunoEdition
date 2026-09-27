// server/src/rooms/lifecycle.ts
//
// ==================================================================
//  LIVE-3C: A HOSTED GAME'S WHOLE LIFE, AS ONE PURE MODEL
// ==================================================================
//
// LIVE-3A/3B made each mutation of a hosted game durable. LIVE-3C makes the SYSTEM restartable: a normal start must
// find every durable game, say what each one is, serve the ones that can run, hold the ones that cannot, and let
// terminal material age out -- without knowing anything the previous process knew. This file is the vocabulary that
// discovery (`discovery.ts`), reconciliation (`reconcile.ts`), the room host, the operator tool and the diagnostics
// all share. It reads no file and writes none.
//
// TWO STAGES, NEVER ONE. A game's class is a CONCLUSION, and startup discovery (`discovery.ts`) reads only the record,
// the hold and the log's FIRST line -- enough to prove a disagreement (held), an unsupported pin (incompatible), or that
// a table was never dealt (its log is empty), but never enough to prove a started game healthy: whether the rest of
// the log is a valid contiguous committed history, whether its tail is torn or damaged, whether the board has reached
// GameEnd, whether the record's lifecycle and seal agree with the last committed entry. So a started game discovery has
// not replayed is `unreconciled` -- "we have not replayed it yet" NEVER means "the record is assumed correct":
//
//   discovered  --(the game's first load: the whole log scanned and replayed, reconcileLoaded, any repair committed)-->
//       active / completed / read-only / held / incompatible / ...
//
// Loading stays lazy (a thousand games are not replayed to start a process), but an unreconciled game is never
// mutated, never archived, never listed in the public lobby, and never represented to a player from its record: every
// read and every op reaches it through its actor, whose load reconciles it first (roomHost `onActorLoaded`); a repair
// the load could not commit leaves it unreconciled, and every op on it is refused until one lands.
//
// THE CLASSES (every durable game is exactly one of these at any moment):
//
//   unreconciled   STAGE ONE: discovered with a deal (or a record that claims one) and not yet reconciled against its
//                  whole log in this process. Its `code` says what the record claims (`claims-active`,
//                  `claims-completed`) or why the load must decide (`needs-repair`, `log-head-unreadable`,
//                  `log-head-unknown`); none of those is believed until the load says so
//   waiting        healthy, restorable: a waiting room, not dealt
//   active         healthy, restorable, mutable: dealt, not ended
//   completed      TERMINAL: gameplay reached GameEnd -- readable, never mutable again (the seal, below)
//   cancelled      terminal before a deal: the host cancelled, or the last seat left
//   expired        terminal before a deal: the 24 h waiting TTL passed
//   archived       `archived_at` is set: gone to every reader; the offline tool may move it to `archive/` later
//   held           a DURABLE HOLD (holdStore.ts): the durable sources disagree or cannot be read; nothing is served
//                  from the log, nothing changes, and only an operator's verified release lifts it
//   incompatible   this build cannot interpret the game (its deal's rules-engine pin, or a record schema newer than
//                  this build): no history, no move -- derived from durable facts on every load, so a restart of the
//                  same build finds it again; it lifts only under a build that supports the exact pin
//   read-only      dealt on another server build (#1252): history is readable, every move is refused
//   unavailable    RUNTIME only: the store could not be read just now, or holds a write only a restart can settle
//   attention      material with no player behind it that an operator should look at (a log with no record, a hold
//                  file with no game) -- never served, never deleted
//
// THE TERMINAL SEAL (the ESCROW-3 seam, LIVE-3 §19.1). The log is append-only and GameEnd is irreversible (RV-3 refuses
// a revert once the board has ended), so the boundary is a POINTER INTO THE LOG, never a rewrite of it:
//
//   gameplay reaches GameEnd  ->  gameplay mutations close (the server refuses every move but the room-close marker)
//     ->  settlement becomes eligible (`SettlementLifecycle.onGameplayClosed`; nothing for a no-money game)
//     ->  settlement completes or is disputed on its own clock (ESCROW-3; nothing here).
//
// `sealOf` computes the seal from the durable log alone: `log_len` is one past the last entry that is not a
// `CloseRoom` (after GameEnd the engine accepts nothing else), `at` is that entry's time. The record's `completed_at`
// caches `at`; restore recomputes both (they are log-implied, RL-1), so a crash between the ending batch and the
// record's update loses nothing.

import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { GameRecord } from "./gameRecord";

export type GameClass =
  | "unreconciled"
  | "waiting"
  | "active"
  | "completed"
  | "cancelled"
  | "expired"
  | "archived"
  | "held"
  | "incompatible"
  | "read-only"
  | "unavailable"
  | "attention";

export const GAME_CLASSES: readonly GameClass[] = Object.freeze([
  "unreconciled",
  "waiting",
  "active",
  "completed",
  "cancelled",
  "expired",
  "archived",
  "held",
  "incompatible",
  "read-only",
  "unavailable",
  "attention",
]);

/* ==================================================================
    WHY A GAME IS HELD (the durable hold's `code`)
   ==================================================================
   Operator-facing codes. A player never sees one of these, nor the operator's detail line: a held game answers every
   player with the same sentence (`HELD_PLAYER_SENTENCE`), so no hold can say anything about a record's contents. */
export type HoldCode =
  /** The log holds damage beyond a torn final batch (LIVE-3B §8.4): acknowledged history may be behind it. */
  | "log-corrupt"
  /** The GameRecord file cannot be read as exactly the frozen record, or names another game. */
  | "record-unreadable"
  /** A hold file that cannot be read -- held anyway: a hold is never lifted by being unreadable. */
  | "hold-unreadable"
  /** The record says the game was dealt, started, ended or closed, and the log does not hold it. */
  | "record-ahead-of-log"
  /** The deal's players are not exactly the record's seats (or the turn order the record caches differs). */
  | "roster-mismatch"
  /** The log does not begin with the deal, holds a second deal, or holds moves with no deal before them. */
  | "deal-misplaced"
  /** The record is cancelled or expired, and the log holds a deal. */
  | "lifecycle-conflict"
  /** The host seat named by the record is not one of its seats. */
  | "host-not-seated"
  /** A player id or a principal holds two seats, a kicked principal is seated, or more seats than the table takes. */
  | "seat-binding-invalid"
  /** A move after the deal by an actor the deal did not seat. */
  | "foreign-actor"
  /** The record caches a rules-engine version the deal does not carry, or the deal carries none at all. */
  | "rules-pin-mismatch"
  /** Two live records hold the same join code. */
  | "duplicate-join-code"
  /** The log is well framed but does not replay under this build (a payload the engine cannot apply, a divergence). */
  | "replay-failed";

export const HOLD_CODES: readonly HoldCode[] = Object.freeze([
  "log-corrupt",
  "record-unreadable",
  "hold-unreadable",
  "record-ahead-of-log",
  "roster-mismatch",
  "deal-misplaced",
  "lifecycle-conflict",
  "host-not-seated",
  "seat-binding-invalid",
  "foreign-actor",
  "rules-pin-mismatch",
  "duplicate-join-code",
  "replay-failed",
]);

/** Why this build cannot interpret a game (derived; never a hold file). */
export type IncompatibleCode = "rules-version-older" | "rules-version-newer" | "record-schema-newer";

/* ==================================================================
    WHAT A PLAYER READS (LIVE-3C §18: "What does Brad see?")
   ================================================================== */

/** A held game, to every player who may read it, whatever the reason. */
export const HELD_PLAYER_SENTENCE =
  "This game is paused for maintenance. Nothing can change until the server's operator restores it; your seat and the game so far are kept.";

/** The game server could not open the game just now (a read that failed or timed out; not a verdict on the game). */
export const UNAVAILABLE_PLAYER_SENTENCE = "The game server could not open this table right now. Reload in a moment to try again.";

/** A move or change refused because the game's record has not yet caught up with its log (a repair that could not be
 *  written just now): nothing was made, and nothing will appear later -- the player simply tries again. */
export const RECONCILING_SENTENCE = "The game server is still bringing this game's records up to date. Nothing was changed; try again in a moment.";

/** A game that has ended: every move but the room-close marker is refused. */
export const GAME_OVER_SENTENCE = "This game is over. Nothing more can be played in it.";

/** LIVE-2F/3D (C4-05): a room change on a game this server cannot continue (an unsupported rules pin, or a deal made
 *  on another build) -- the game is kept exactly as it was. */
export const FROZEN_GAME_SENTENCE = "This game cannot be continued on this server, so nothing about its table can be changed here.";

/** Why a table is gone, by what ended it -- `gone` answers carry these. */
export const GONE_SENTENCES = Object.freeze({
  cancelled: "The host closed this table before the game started.",
  expired: "This table expired: it waited 24 hours without starting.",
  archived: "This game has been archived and is no longer open.",
  gone: "That game is over and gone.",
});

/* ==================================================================
    THE TERMINAL SEAL
   ================================================================== */

export interface TerminalSeal {
  /** One past the last gameplay entry: every entry below it is the game's result; nothing at or above it is gameplay. */
  readonly log_len: number;
  /** When gameplay ended: the last gameplay entry's time. */
  readonly at: number;
}

const isCloseRoom = (entry: ServerLogEntry): boolean => {
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    return typeof parsed === "object" && parsed !== null && "CloseRoom" in parsed;
  } catch {
    return false;
  }
};

/** The seal of a log whose board is at GameEnd (`ended`), or `null` when it is not. Pure, from the durable log. */
export function sealOf(entries: readonly ServerLogEntry[], ended: boolean): TerminalSeal | null {
  if (!ended || entries.length === 0) return null;
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    if (isCloseRoom(entries[at])) continue;
    const entry = entries[at];
    return { log_len: entry.index + 1, at: typeof entry.at === "number" ? entry.at : 0 };
  }
  return null;
}

/** After the seal the server admits exactly the room-close marker (and `RevertTo`, which RV-3 then refuses in its own
 *  words, so the Undo button and the server keep saying the same sentence). Everything else is refused before it is
 *  speculated. */
export function admissibleAfterSeal(msg: object): boolean {
  return "CloseRoom" in msg || "RevertTo" in msg;
}

/* ==================================================================
    THE SETTLEMENT SEAM (ESCROW-3 plugs in here; nothing is settled in LIVE-3C)
   ================================================================== */

export type RetentionClass =
  /** A no-money game: the §9.7 timers apply -- archived after its terminal wait, moved after 90 days archived. */
  | { readonly kind: "no-money" }
  /** A money game (future): its evidence is kept at least as long as settlement, challenge and dispute require.
   *  Lifecycle tooling never archives, moves or deletes it; only ESCROW-3's settlement state may say when. */
  | { readonly kind: "financial"; readonly reason: string };

export interface SettlementLifecycle {
  /** Gameplay has closed: the seal is durable in the log. AT LEAST ONCE, keyed by `(gameId, seal.log_len)`: called in
   *  the step that records the game as completed (`recovered: false`), and AGAIN whenever a load reconciles a completed
   *  game (`recovered: true`) -- because the in-memory call can be lost to a crash after the record is durable (review
   *  E6), eligibility must be derivable from durable state, never from "we remember calling it". ESCROW-3's
   *  implementation is therefore IDEMPOTENT: it creates its durable settlement item if absent and does nothing
   *  otherwise. For a no-money game there is nothing to settle. Never a rewrite of the log. Must not throw; must not
   *  await (it runs inside a publish). */
  onGameplayClosed(input: { readonly gameId: string; readonly record: Readonly<GameRecord>; readonly seal: TerminalSeal; readonly recovered: boolean }): void;
  /** What lifecycle tooling may do with this game's material. */
  retentionOf(record: Readonly<GameRecord>): RetentionClass;
}

export const FINANCIAL_RETENTION_REASON =
  "A money game is kept until its escrow settlement is terminal and every challenge and dispute window has closed (ESCROW-3).";

export const NO_MONEY_SETTLEMENT: SettlementLifecycle = Object.freeze({
  onGameplayClosed: () => undefined,
  retentionOf: (record: Readonly<GameRecord>): RetentionClass =>
    record.money === null ? { kind: "no-money" } : { kind: "financial", reason: FINANCIAL_RETENTION_REASON },
});

/* ==================================================================
    RETENTION (OD-L3-2, LIVE-3 §9.7; LIVE-2 §12.2's lifecycle timers)
   ================================================================== */

const DAY = 24 * 60 * 60 * 1000;

/** A completed game stays readable this long after it ended, then is archived (gone to readers). */
export const COMPLETED_ARCHIVE_AFTER_MS = 30 * DAY;
/** A cancelled or expired table is archived this long after it ended. */
export const UNPLAYED_ARCHIVE_AFTER_MS = 7 * DAY;
/** An archived game's files stay "hot" (in place) this long, then the offline tool may move them to `archive/`. */
export const ARCHIVE_HOT_MS = 90 * DAY;
/** Tables archived per sweep (the sweep runs every minute); the rest wait for the next one. */
export const ARCHIVE_SWEEP_BUDGET = 20;

/** When a terminal game becomes eligible to be archived (`archived_at` set), or `null` when it never is by this
 *  rule: not terminal, already archived, or not a no-money game. */
export function archiveDueAt(record: Readonly<GameRecord>, retention: RetentionClass): number | null {
  if (retention.kind !== "no-money" || record.archived_at !== null) return null;
  if (record.status === "completed" && record.completed_at !== null) return record.completed_at + COMPLETED_ARCHIVE_AFTER_MS;
  if (record.status === "cancelled") return (record.cancelled_at ?? record.last_activity_at) + UNPLAYED_ARCHIVE_AFTER_MS;
  if (record.status === "expired") return (record.expires_at ?? record.last_activity_at) + UNPLAYED_ARCHIVE_AFTER_MS;
  return null;
}

/** Whether the offline tool may move an archived game's files out of the live directories now. */
export function movableAt(record: Readonly<GameRecord>, retention: RetentionClass): number | null {
  if (retention.kind !== "no-money" || record.archived_at === null) return null;
  return record.archived_at + ARCHIVE_HOT_MS;
}

/** The class a record alone CLAIMS. Believed only where nothing can contradict it: a table whose log is empty, an
 *  archived record (record-owned), or a game this process has reconciled against its whole log and has written every
 *  change to since. Anywhere else the claim is stage one's hint (`unreconciled`), never a conclusion. */
export function classOfRecord(record: Readonly<GameRecord>, now: number): GameClass {
  if (record.archived_at !== null) return "archived";
  switch (record.status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "active":
      return "active";
    default:
      return record.expires_at !== null && now >= record.expires_at && record.started_at === null ? "expired" : "waiting";
  }
}
