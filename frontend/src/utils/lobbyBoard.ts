// frontend/src/utils/lobbyBoard.ts
//
// ==================================================================
//  PLAY LOBBY (approved design, "play-lobby-handoff"): THE BOARDS' FACTS, DERIVED ONCE
// ==================================================================
//
// Pure: everything the Departures and Under way boards and the seated list show, worked out from the server's public
// `RoomSummary` (`rooms-watch`) and the public players answer (`POST /gs/api/lobby/players`). No invented data: a fact
// the server did not send is left out (an unknown async deadline reads plain "Async"; an unobserved seat's funding has
// no tag), never guessed. Play's rules are not restated here: who may join is `canJoin`, the same rule the list has
// always used (#1441, PHASE 3 FINAL §13).

import { gameTypeOf, resolveVariants, type GameType, type GameVariants } from "../gameEngine/gameVariants";
import { ruleTitlesFor } from "../components/LobbyRoomList";
import { formatAmount } from "./moneyProtocol";
import type { RoomSummary } from "./roomProtocol";

/* ------------------------------------------------------------------ the editions */

export const EDITION_NAME: Readonly<Record<GameType, string>> = { standard: "18XX", plus: "18XX+", levelPlayingField: "18XX+ LPF" };
export const EDITION_COLOR: Readonly<Record<GameType, string>> = { standard: "#D7B56E", plus: "#59B578", levelPlayingField: "#5B8EF0" };
export const EDITIONS: readonly GameType[] = ["standard", "plus", "levelPlayingField"];
const BANK: Readonly<Record<GameVariants["length"], string>> = { short: "Short", standard: "Standard", long: "Long" };
export const PACE_LABEL: Readonly<Record<number, string>> = { 43_200: "12h", 86_400: "24h", 172_800: "2d", 259_200: "3d", 604_800: "7d" };

export type EditionFilter = "all" | GameType;
export type ModeFilter = "all" | "live" | "async";

/* ------------------------------------------------------------------ one row */

export type BoardStatus = "boarding" | "final-call" | "full" | "under-way";
export const STATUS_WORD: Readonly<Record<BoardStatus, string>> = { boarding: "Boarding", "final-call": "Final call", full: "Full", "under-way": "Under way" };

export interface BoardRow {
  gameId: string;
  code: string;
  /** The last four characters of the code: what the flaps show. */
  codeTail: string;
  status: RoomSummary["status"];
  edition: GameType;
  editionName: string;
  color: string;
  bank: string;
  mode: "live" | "async";
  /** "Live", "Async: 24h", or "Async" (no deadline, or not yet known). */
  modeLabel: string;
  rules: string[];
  host: string;
  /** Seat order: each seated player's public (account) name; the host's index; funded yes / no / unknown. */
  seats: Array<{ name: string; host: boolean; funded: boolean | null }>;
  seated: number;
  /** The seats the table holds: an exact table's count, else the board's maximum. */
  capacity: number;
  exactCount: boolean;
  full: boolean;
  createdAtMs: number;
  startedAtMs: number | null;
  stake: null | { ante: string; anteGross: string; exponent: number; symbol: string; funded: number; seats: number };
}

export function boardRowOf(room: RoomSummary): BoardRow {
  const variants = resolveVariants(room.variants);
  const edition = gameTypeOf(variants);
  const capacity = typeof room.playerCount === "number" && room.playerCount >= 2 ? Math.min(room.playerCount, room.seatCap) : room.seatCap;
  const hostSeat = typeof room.hostSeat === "number" ? room.hostSeat : room.nicknames.indexOf(room.hostNickname);
  const funded = room.stake?.seatFunded;
  const pace = room.clock?.deadline === "async-pace" && room.clock.paceSecs !== null ? PACE_LABEL[room.clock.paceSecs] : undefined;
  return {
    gameId: room.gameId,
    code: room.code,
    codeTail: room.code.slice(-4),
    status: room.status,
    edition,
    editionName: EDITION_NAME[edition],
    color: EDITION_COLOR[edition],
    bank: BANK[variants.length] ?? "Standard",
    mode: variants.mode === "async" ? "async" : "live",
    modeLabel: variants.mode === "async" ? (pace !== undefined ? `Async: ${pace}` : "Async") : "Live",
    rules: ruleTitlesFor(variants),
    host: room.hostNickname,
    seats: room.nicknames.map((name, index) => ({
      name,
      host: index === hostSeat,
      funded: room.stake === undefined || !Array.isArray(funded) || typeof funded[index] !== "boolean" ? null : funded[index],
    })),
    seated: room.seated,
    capacity,
    exactCount: room.playerCount !== null,
    full: room.seated >= capacity,
    createdAtMs: room.createdAtMs,
    startedAtMs: typeof room.startedAtMs === "number" ? room.startedAtMs : null,
    stake:
      room.stake === undefined
        ? null
        : {
            ante: groupAmount(formatAmount(room.stake.anteGross, room.stake.exponent, room.stake.symbol)),
            anteGross: room.stake.anteGross,
            exponent: room.stake.exponent,
            symbol: room.stake.symbol,
            funded: room.stake.funded,
            seats: room.stake.seats,
          },
  };
}

/** Status, from the summary alone (no backend field): Under way (playing, or departing), Full, Final call (an exact
 *  table with one seat left), else Boarding. */
export function statusOf(row: Pick<BoardRow, "status" | "seated" | "capacity" | "exactCount">, departing = false): BoardStatus {
  if (row.status === "playing" || departing) return "under-way";
  if (row.seated >= row.capacity) return "full";
  if (row.exactCount && row.capacity - row.seated === 1) return "final-call";
  return "boarding";
}

/** Play's own Join rule, unchanged (#1441; PHASE 3 FINAL §13): a waiting table with a free seat -- and, where every
 *  player game is anted, a table with an ante. Never while it departs. Watch is always offered. */
export function canJoin(row: Pick<BoardRow, "status" | "full" | "stake">, noAnteSeats: boolean, departing = false): boolean {
  return row.status === "waiting" && !departing && !row.full && (row.stake !== null || noAnteSeats);
}

export function shown(row: Pick<BoardRow, "edition" | "mode">, edition: EditionFilter, mode: ModeFilter): boolean {
  return (edition === "all" || row.edition === edition) && (mode === "all" || row.mode === mode);
}

/** Departures oldest first (by opened time); Under way by start time. Both orders come from facts that never change,
 *  so a row never moves because its contents changed, and a newer table joins the bottom. */
export function departuresOrder(rows: readonly BoardRow[]): BoardRow[] {
  return rows.slice().sort((a, b) => a.createdAtMs - b.createdAtMs || (a.gameId < b.gameId ? -1 : 1));
}
export function underWayOrder(rows: readonly BoardRow[]): BoardRow[] {
  const at = (row: BoardRow) => row.startedAtMs ?? row.createdAtMs;
  return rows.slice().sort((a, b) => at(a) - at(b) || (a.gameId < b.gameId ? -1 : 1));
}

/** What a row's flash compares: the seats, their names and funding, the status. */
export function rowSignature(row: BoardRow): string {
  return JSON.stringify([row.status, row.seated, row.capacity, row.seats, row.stake?.funded ?? null, row.modeLabel]);
}

/** Between two snapshots: the rows that changed or are new (to flash), and the tables that moved from waiting to
 *  playing (to depart). The first snapshot flashes nothing. */
export function diffSnapshots(previous: ReadonlyMap<string, BoardRow> | null, next: readonly BoardRow[]): { changed: Set<string>; departed: Set<string> } {
  const changed = new Set<string>();
  const departed = new Set<string>();
  if (previous === null) return { changed, departed };
  for (const row of next) {
    const before = previous.get(row.gameId);
    if (before === undefined) changed.add(row.gameId);
    else if (before.status === "waiting" && row.status === "playing") departed.add(row.gameId);
    else if (rowSignature(before) !== rowSignature(row)) changed.add(row.gameId);
  }
  return { changed, departed };
}

/* ------------------------------------------------------------------ times and amounts */

/** "05:23" (UTC), or a weekday ("Thu") for anything more than 20 hours old. */
export function boardTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return "--:--";
  if (now - ms > 20 * 3_600_000) return new Date(ms).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return new Date(ms).toISOString().slice(11, 16);
}
export const clockText = (now: number): string => `${new Date(now).toISOString().slice(11, 19)} UTC`;

/** "3500 JUNOX" -> "3,500 JUNOX" (the whole part grouped; the fraction untouched). */
export function groupAmount(text: string): string {
  return text.replace(/^(\d+)(?=(\.\d+)?\s)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
}
/** The ante times `n` seats, formatted (gross, before any fee). */
export function anteTimes(stake: NonNullable<BoardRow["stake"]>, n: number): string {
  if (!/^[0-9]{1,40}$/.test(stake.anteGross)) return `— ${stake.symbol}`;
  return groupAmount(formatAmount(BigInt(stake.anteGross) * BigInt(Math.max(0, n)), stake.exponent, stake.symbol));
}
/** "20 of 40 JUNOX": the ante times `n`, without its symbol, of the ante times `m`. */
export function anteOf(stake: NonNullable<BoardRow["stake"]>, n: number, m: number): string {
  return `${anteTimes(stake, n).replace(` ${stake.symbol}`, "")} of ${anteTimes(stake, m)}`;
}

/* ------------------------------------------------------------------ the public game history */

export interface PublicGameHistory {
  completed: number;
  firstMonth: string | null;
  wins: number;
  places: { first: number; second: number; third: number; rest: number };
  placed: number;
  recent: Array<{ endedOn: string; edition: GameType; place: number; of: number }>;
}
export interface PublicSeatHistory {
  seat: number;
  name: string;
  host: boolean;
  history: PublicGameHistory;
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The players answer, strictly read: anything not exactly the approved shape is dropped. */
export function publicPlayersOf(body: unknown): PublicSeatHistory[] | null {
  const players = body !== null && typeof body === "object" ? (body as { players?: unknown }).players : undefined;
  if (!Array.isArray(players)) return null;
  const out: PublicSeatHistory[] = [];
  for (const raw of players) {
    if (raw === null || typeof raw !== "object") return null;
    const p = raw as Record<string, unknown>;
    const h = p.history as Record<string, unknown> | null;
    if (!count(p.seat) || typeof p.name !== "string" || typeof p.host !== "boolean" || h === null || typeof h !== "object") return null;
    const places = h.places as Record<string, unknown> | null;
    if (!count(h.completed) || !count(h.wins) || !count(h.placed) || places === null || typeof places !== "object") return null;
    if (![places.first, places.second, places.third, places.rest].every(count)) return null;
    if (!(h.firstMonth === null || (typeof h.firstMonth === "string" && MONTH.test(h.firstMonth)))) return null;
    if (!Array.isArray(h.recent)) return null;
    const recent: PublicGameHistory["recent"] = [];
    for (const r of h.recent.slice(0, 3)) {
      const e = r as Record<string, unknown>;
      if (typeof e?.endedOn !== "string" || !DAY.test(e.endedOn) || !EDITIONS.includes(e.edition as GameType) || !count(e.place) || !count(e.of)) return null;
      recent.push({ endedOn: e.endedOn, edition: e.edition as GameType, place: e.place as number, of: e.of as number });
    }
    out.push({
      seat: p.seat as number,
      name: p.name,
      host: p.host,
      history: {
        completed: h.completed as number,
        firstMonth: h.firstMonth as string | null,
        wins: h.wins as number,
        places: { first: places.first as number, second: places.second as number, third: places.third as number, rest: places.rest as number },
        placed: h.placed as number,
        recent,
      },
    });
  }
  return out;
}

export const ordinal = (n: number): string => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** "2025-05" -> "May 2025". */
export const monthLabel = (month: string): string => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
/** "2026-10-09" -> "9 Oct". */
export const dayLabel = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The history panel's lines, in order. */
export function historyLines(h: PublicGameHistory): { none: true } | { none: false; summary: string; wins: string; standings: string[]; partial: string | null; recent: Array<{ day: string; edition: string; result: string }> } {
  if (h.completed === 0) return { none: true };
  return {
    none: false,
    summary: `${plural(h.completed, "completed game")}${h.firstMonth !== null ? ` since ${monthLabel(h.firstMonth)}` : ""}`,
    wins: plural(h.wins, "win"),
    standings: [`1st ×${h.places.first}`, `2nd ×${h.places.second}`, `3rd ×${h.places.third}`, `4th or lower ×${h.places.rest}`],
    partial: h.placed < h.completed ? `Places known for ${h.placed} of ${h.completed} games.` : null,
    recent: h.recent.map((r) => ({ day: dayLabel(r.endedOn), edition: EDITION_NAME[r.edition], result: `${ordinal(r.place)} of ${r.of}` })),
  };
}

/* ------------------------------------------------------------------ the split-flap drum */

/* PLAY WAITING ROOM (handoff §2): the drum adds "$ , ." so amounts can flip (the sign's ante, "At this count"). */
export const FLAP_DRUM = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/·+-$,.";
export const FLAP_STEP_MS = 55;
export const FLAP_STAGGER_MS = 40;
export const FLAP_MAX_STEPS = 14;

/** The characters a cell shows on its way from `from` to `to` (the last is `to`); a long way starts 6-11 short. */
export function flapPath(from: string, to: string, random: () => number = Math.random): string[] {
  const D = FLAP_DRUM;
  let at = Math.max(0, D.indexOf(from));
  const target = Math.max(0, D.indexOf(to));
  let steps = (target - at + D.length) % D.length;
  if (steps > FLAP_MAX_STEPS) {
    at = (target - 6 - Math.floor(random() * 6) + D.length) % D.length;
    steps = (target - at + D.length) % D.length;
  }
  const path: string[] = [];
  for (let k = 0; k < steps; k += 1) {
    at = (at + 1) % D.length;
    path.push(D[at]);
  }
  if (path.length === 0 || path[path.length - 1] !== to) path.push(to);
  return path;
}

/** A flap field's text: upper case, padded or cut to `width`, unknown characters as spaces. */
export function flapText(text: string, width: number): string {
  return Array.from(String(text).toUpperCase().padEnd(width, " ").slice(0, width)).map((c) => (FLAP_DRUM.includes(c) ? c : " ")).join("");
}
