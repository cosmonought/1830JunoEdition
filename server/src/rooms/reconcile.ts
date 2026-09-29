// server/src/rooms/reconcile.ts
//
// ==================================================================
//  LIVE-3C (LIVE-3 §14.3, §14.4): RECONCILING A GAME'S DURABLE SOURCES -- THE LOG WINS, AND A DISAGREEMENT HOLDS
// ==================================================================
//
// A hosted game has three durable sources: the GameRecord (room metadata: seats, host, lifecycle), the committed
// gameplay log (the authority for everything that happened), and -- LIVE-3C -- an optional durable hold. They are
// written at different moments (RL-1: a batch commits first, the record's log-implied fields follow as a task of
// their own), so a crash can leave the record BEHIND its log. That is expected, and repaired from the log. What is
// never expected is a record AHEAD of its log, or a record that describes a different game from the one its log
// dealt: those mean acknowledged history was lost, or something outside the protocol wrote. They are HELD, never
// guessed at -- no seat is edited, no log is rewritten, and nothing is served from the log until an operator has
// looked (the verified release in `tools/gamesDoctor.ts`).
//
// PURE. Two entry points, one table:
//   reconcileHead    at startup discovery, from the record and the log's FIRST LINE only (the deal is always index
//                    0 of a server-owned game): cheap enough for every game, no replay
//   reconcileLoaded  at the actor's load, from the record, the WHOLE durable log and the replayed board
//
// THE TABLE (both tiers apply every row they have the facts for; the first hold wins, in this order):
//
//   record alone
//     host-not-seated        a live record (waiting, active, completed) whose host is not one of its seats
//     seat-binding-invalid   a player id or principal twice, a kicked principal seated, more seats than the table takes
//   record against log
//     deal-misplaced         the first entry is not the deal; a second deal; (loaded) moves with no deal before them
//     lifecycle-conflict     cancelled or expired, and the log holds a deal
//     record-ahead-of-log    no deal, yet the record is active/completed, has started/ended/closed times or a turn
//                            order; (loaded) completed or closed while the board is not
//     roster-mismatch        the deal's players are not exactly the seats; the cached turn order is not the deal's
//     rules-pin-mismatch     the deal carries no rules-engine pin (a server-owned deal always does), or the record
//                            caches a different one
//     foreign-actor          (loaded) an entry whose actor the deal did not seat
//   repairs (the log wins; `syncRecord` writes them, audited)
//     waiting while dealt; started_at / turn_order / rules_engine_version missing; ended or closed on the board but
//     not in the record; an end time other than the seal's (the log's last gameplay entry); a private room's join
//     code or unseated admissions still held after the deal; a TTL still set after the deal
//
// WHAT IS NOT HERE: whether this pool continues the game at all -- the canonical continuation verdict (LIVE-4: the
// deal's rules pin and hosted protocol, a money table's money facts), which the session asks at every rebuild and the
// view carries as `incompatible`. It is derived on every load from the same durable facts, so it needs no hold to
// survive a restart. (The build pin, #1252, is retired: the deal's `build` is diagnostic only.)

import { effectiveActions } from "../../../frontend/src/gameEngine/logRevert";
import { RULES_ENGINE_VERSION_FIELD, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/rulesVersion";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { capacityOf, type GameRecord } from "./gameRecord";
import { sealOf, type HoldCode, type IncompatibleCode } from "./lifecycle";

/** What the deal says, read from its payload (never through the reducer). */
export interface DealInfo {
  /** The deal entry's own index (0 for every deal the server made). */
  readonly index: number;
  readonly actor: string;
  readonly at: number | null;
  /** `SetupGame.players[].id`, in turn order. */
  readonly players: readonly string[];
  /** The rules-engine pin: an integer, or `null` when the deal carries none (or a non-integer). */
  readonly pin: number | null;
  /** The build the deal names (#1252), or `null`. LIVE-4 (L4-2): diagnostic only -- no classification reads it. */
  readonly build: string | null;
}

/** The deal a log entry carries, or `null` when the entry is not a deal. `undefined` when its payload is not JSON. */
export function dealInfoOf(entry: ServerLogEntry): DealInfo | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("SetupGame" in parsed)) return null;
  const setup = (parsed as { SetupGame: unknown }).SetupGame;
  if (typeof setup !== "object" || setup === null) return null;
  const record = setup as Record<string, unknown>;
  const players = Array.isArray(record.players)
    ? record.players.map((player) => (typeof player === "object" && player !== null ? String((player as { id?: unknown }).id) : ""))
    : [];
  const pin = record[RULES_ENGINE_VERSION_FIELD];
  return {
    index: entry.index,
    actor: entry.actor,
    at: typeof entry.at === "number" ? entry.at : null,
    players,
    pin: typeof pin === "number" && Number.isInteger(pin) ? pin : null,
    build: typeof record.build === "string" && record.build !== "" ? record.build : null,
  };
}

export type Verdict =
  | { readonly kind: "ok" }
  /** The record lags its log; these log-implied fields are to be rewritten from the log. */
  | { readonly kind: "repair"; readonly fields: readonly string[] }
  | { readonly kind: "hold"; readonly code: HoldCode; readonly detail: string };

const OK: Verdict = Object.freeze({ kind: "ok" });
const hold = (code: HoldCode, detail: string): Verdict => ({ kind: "hold", code, detail });

/** How a rules-engine pin stands against this build: `null` when supported. */
export function pinCompatibility(pin: number): IncompatibleCode | null {
  if (SUPPORTED_RULES_ENGINE_VERSIONS.includes(pin)) return null;
  return pin > Math.max(...SUPPORTED_RULES_ENGINE_VERSIONS) ? "rules-version-newer" : "rules-version-older";
}

/* ---------------------------------------------------------------------------
    THE RECORD ALONE
   --------------------------------------------------------------------------- */

/** Holds the record alone justifies, or `null`. Never names a principal id in its detail (operator logs included). */
export function checkRecordAlone(record: Readonly<GameRecord>): Verdict | null {
  const live = record.status === "waiting" || record.status === "active" || record.status === "completed";
  if (live && !record.seats.some((seat) => seat.player_id === record.host_player_id)) {
    return hold("host-not-seated", `the host seat ${record.host_player_id} is not one of the record's ${record.seats.length} seats`);
  }
  const players = new Set<string>();
  const principals = new Set<string>();
  for (const [at, seat] of record.seats.entries()) {
    if (players.has(seat.player_id)) return hold("seat-binding-invalid", `seat #${at} repeats player ${seat.player_id}`);
    if (principals.has(seat.principal_id)) return hold("seat-binding-invalid", `seat #${at} (${seat.player_id}) is a second seat of one principal`);
    if (record.kicked_principals.includes(seat.principal_id)) return hold("seat-binding-invalid", `seat #${at} (${seat.player_id}) is held by a principal the host kicked`);
    players.add(seat.player_id);
    principals.add(seat.principal_id);
  }
  if (live && record.seats.length > capacityOf(record)) {
    return hold("seat-binding-invalid", `${record.seats.length} seats at a table that takes ${capacityOf(record)}`);
  }
  return null;
}

/* ---------------------------------------------------------------------------
    THE RECORD AGAINST THE DEAL (both tiers)
   --------------------------------------------------------------------------- */

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));

function checkAgainstDeal(record: Readonly<GameRecord>, deal: DealInfo | null): Verdict | null {
  if (deal === null) {
    const claims: string[] = [];
    if (record.status === "active" || record.status === "completed") claims.push(`status ${record.status}`);
    if (record.started_at !== null) claims.push("a start time");
    if (record.completed_at !== null) claims.push("an end time");
    if (record.closed_at !== null) claims.push("a close time");
    if (record.turn_order !== null) claims.push("a turn order");
    if (claims.length > 0) return hold("record-ahead-of-log", `the record claims ${claims.join(", ")} but the log holds no deal`);
    return null;
  }
  if (deal.index !== 0) return hold("deal-misplaced", `the deal is at index ${deal.index}; a server-owned game is dealt at index 0`);
  if (record.status === "cancelled" || record.status === "expired") {
    return hold("lifecycle-conflict", `the record is ${record.status} but the log holds a deal`);
  }
  const seats = record.seats.map((seat) => seat.player_id);
  if (!sameSet(deal.players, seats)) {
    return hold("roster-mismatch", `the deal seats [${deal.players.join(", ")}] and the record seats [${seats.join(", ")}]`);
  }
  if (record.turn_order !== null && (record.turn_order.length !== deal.players.length || record.turn_order.some((id, at) => id !== deal.players[at]))) {
    return hold("roster-mismatch", "the record's turn order is not the deal's");
  }
  if (deal.pin === null) return hold("rules-pin-mismatch", "the deal carries no rules-engine version (every server-owned deal is pinned)");
  if (record.rules_engine_version !== null && record.rules_engine_version !== deal.pin) {
    return hold("rules-pin-mismatch", `the record caches rules-engine version ${record.rules_engine_version}, the deal is pinned to ${deal.pin}`);
  }
  return null;
}

/** The log-implied fields a record lags on, given what the log says (both tiers; `board` only when loaded; `sealAt`
 *  the seal's time when the board has ended and the log carries one). */
function lagging(record: Readonly<GameRecord>, deal: DealInfo | null, board: { ended: boolean; closed: boolean } | null, sealAt: number | null = null): string[] {
  if (deal === null) return [];
  const fields: string[] = [];
  const expected = board === null ? null : board.ended ? "completed" : "active";
  if (record.status === "waiting") fields.push("status");
  else if (expected !== null && record.status !== expected) fields.push("status");
  if (record.started_at === null) fields.push("started_at");
  if (record.turn_order === null) fields.push("turn_order");
  if (record.rules_engine_version === null) fields.push("rules_engine_version");
  if (record.expires_at !== null) fields.push("expires_at");
  if (record.visibility === "private" && record.join_code !== null) fields.push("join_code");
  if (record.visibility === "private") {
    const seated = new Set(record.seats.map((seat) => seat.principal_id));
    if (record.admitted.some((entry) => !seated.has(entry.principal_id))) fields.push("admitted");
  }
  /* The seal (lifecycle.ts) is a pointer into the log; `completed_at` only caches its time, so a record that names
     another time (an older build stamped its own clock) is repaired to the log's -- never believed over it. */
  if (board !== null && board.ended && (record.completed_at === null || (sealAt !== null && record.completed_at !== sealAt))) fields.push("completed_at");
  if (board !== null && board.closed && record.closed_at === null) fields.push("closed_at");
  return fields;
}

/* ---------------------------------------------------------------------------
    TIER 1: DISCOVERY, FROM THE LOG'S FIRST LINE
   --------------------------------------------------------------------------- */

export interface LogHead {
  /** The log file exists and holds at least one byte. */
  readonly present: boolean;
  /** The first line, parsed as an entry -- `null` when the file is empty, `undefined` when that line does not parse
   *  (a torn deal batch is repaired at the load; only the full scan can tell it from damage). */
  readonly first: ServerLogEntry | null | undefined;
}

/** Discovery's verdict from the record and the log head. A head that does not parse is left to the load. */
export function reconcileHead(record: Readonly<GameRecord>, head: LogHead): Verdict {
  const alone = checkRecordAlone(record);
  if (alone !== null) return alone;
  if (head.first === undefined) return OK; // decided at the load, from the whole file
  let deal: DealInfo | null = null;
  if (head.first !== null) {
    const info = dealInfoOf(head.first);
    if (info === undefined || info === null || head.first.index !== 0) {
      return hold("deal-misplaced", `the log's first entry (index ${head.first.index}) is not the deal`);
    }
    deal = info;
  }
  const against = checkAgainstDeal(record, deal);
  if (against !== null) return against;
  const fields = lagging(record, deal, null);
  return fields.length > 0 ? { kind: "repair", fields } : OK;
}

/* ---------------------------------------------------------------------------
    TIER 2: THE LOAD, FROM THE WHOLE LOG AND THE REPLAYED BOARD
   --------------------------------------------------------------------------- */

export interface LoadedFacts {
  readonly entries: readonly ServerLogEntry[];
  /** The replayed board, or `null` when the session could not interpret the log (an incompatible pin). */
  readonly board: { readonly ended: boolean; readonly closed: boolean } | null;
}

export function reconcileLoaded(record: Readonly<GameRecord>, facts: LoadedFacts): Verdict {
  const alone = checkRecordAlone(record);
  if (alone !== null) return alone;
  const { entries } = facts;
  let deal: DealInfo | null = null;
  let deals = 0;
  for (const entry of entries) {
    const info = dealInfoOf(entry);
    if (info === undefined) continue; // an unreadable payload is the engine's to judge; it is not a deal
    if (info !== null) {
      deals += 1;
      deal ??= info;
    }
  }
  if (entries.length > 0 && (deal === null || deal.index !== entries[0].index || entries[0].index !== 0)) {
    return hold("deal-misplaced", deal === null ? `the log holds ${entries.length} entries and no deal` : `the log's first entry (index ${entries[0].index}) is not the deal`);
  }
  if (deals > 1) return hold("deal-misplaced", `the log holds ${deals} deals`);
  /* The effective deal (a server-owned deal cannot be reverted, RV-5, so it is the first entry). */
  if (deal !== null && effectiveActions(entries)[0]?.index !== deal.index) {
    return hold("deal-misplaced", "the deal is not in force in the effective log");
  }
  const against = checkAgainstDeal(record, deal);
  if (against !== null) return against;
  if (deal !== null) {
    const seated = new Set(deal.players);
    for (const entry of entries) {
      if (!seated.has(entry.actor)) return hold("foreign-actor", `entry ${entry.index} is by ${entry.actor}, whom the deal did not seat`);
    }
  }
  const board = facts.board;
  if (board !== null) {
    if (record.status === "completed" && !board.ended) return hold("record-ahead-of-log", "the record is completed but the log's board has not ended");
    if (record.completed_at !== null && !board.ended) return hold("record-ahead-of-log", "the record has an end time but the log's board has not ended");
    if (record.closed_at !== null && !board.closed) return hold("record-ahead-of-log", "the record has a close time but the log's room is not closed");
  }
  const seal = board !== null && board.ended ? sealOf(entries, true) : null;
  const fields = lagging(record, deal, board, seal !== null && seal.at > 0 ? seal.at : null);
  return fields.length > 0 ? { kind: "repair", fields } : OK;
}
