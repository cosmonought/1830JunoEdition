// server/src/rooms/gameRecord.ts
//
// ==================================================================
//  LIVE-2C (LIVE-2 §3.2, §5): THE SERVER-OWNED GAME RECORD
// ==================================================================
//
// The room document was last-write-wins and any client could write it. The GameRecord is written ONLY by the server,
// only through a named operation (`roomService.ts`), only as a task on the game's own actor, and only after the store
// has it (durable before visible). Nothing a client sends names a field of it; no op takes a partial document.
//
// THREE IDENTITIES, ON PURPOSE (LIVE-2 §3.1):
//   principal_id  who is authenticated -- private, never projected, never logged, never in a payload;
//   player_id     who acts in the game -- the log's `actor`, the deal's `players[].id`; minted here, stable for the
//                 seat's life, independent of the principal that currently controls it;
//   game_id       the room's durable key (log, record, settlement binding); the join code is only an alias to it.
//
// DERIVED FIELDS COME FROM THE LOG (§5.2): active and completed, started/completed/closed times, the turn order and
// the rules-engine pin are the log's facts, cached here. `effectiveStatus` reads the log first, so a record that lags
// its log (a crash between the deal and the record update) is never believed over it, and the next record write
// repairs it (§14.4).

import { randomBytes, randomInt } from "crypto";

import { base32Lower } from "../identity/ids";
import type { GameVariants } from "../../../frontend/src/gameEngine/gameVariants";
import type { UndoPolicy } from "../../../frontend/src/gameEngine/logRevert";
import type { MyTableMoneySummary, RoomMoneyView, RoomStakeSummary } from "../../../frontend/src/utils/moneyProtocol";
import type { RoomClockView } from "../../../frontend/src/utils/clockProtocol";

/* ---------------------------------------------------------------------------
    IDENTIFIERS (LIVE-2 §3.2)
   --------------------------------------------------------------------------- */

/** `g_` + 26 lowercase Crockford base32 symbols of 16 random bytes (the last symbol's two padding bits zero). */
export const GAME_ID_PATTERN = /^g_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]$/;
/** `p-` + 16 lowercase Crockford base32 symbols of 10 random bytes (80 bits; no padding). */
export const PLAYER_ID_PATTERN = /^p-[0-9a-hjkmnp-tv-z]{16}$/;
/** The read-aloud alphabet the legacy codes already use (`sandboxRoom.ts`): 29 symbols, no 0/O, 1/I/L or 5/S. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
export const JOIN_CODE_PATTERN = /^JUNO-[ABCDEFGHJKMNPQRTUVWXYZ2346789]{4}-[ABCDEFGHJKMNPQRTUVWXYZ2346789]{4}$/;
export const MAX_JOIN_CODE_INPUT = 32;

export type Bytes = (size: number) => Buffer;
export type RandomInt = (max: number) => number;
const cryptoBytes: Bytes = (size) => randomBytes(size);
const cryptoInt: RandomInt = (max) => randomInt(max);

export const mintGameId = (random: Bytes = cryptoBytes): string => `g_${base32Lower(random(16))}`;
export const mintPlayerId = (random: Bytes = cryptoBytes): string => `p-${base32Lower(random(10))}`;

/** `JUNO-XXXX-XXXX`, each symbol `crypto.randomInt(29)`: 29^8 ≈ 5.0e11 codes (≈ 38.9 bits). */
export function mintJoinCode(random: RandomInt = cryptoInt): string {
  let body = "";
  for (let n = 0; n < 8; n += 1) body += JOIN_CODE_ALPHABET[random(JOIN_CODE_ALPHABET.length)];
  return `JUNO-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Forgiving on input (LIVE-2 §7.2): case-insensitive, whitespace and hyphens stripped, an optional `JUNO` prefix;
 *  exactly 8 symbols of the alphabet or `null`. A legacy 3-symbol code is `null` ("That is not a room code"). */
export function parseJoinCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_JOIN_CODE_INPUT) return null;
  let body = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (body.startsWith("JUNO")) body = body.slice(4);
  if (body.length !== 8) return null;
  for (const symbol of body) if (!JOIN_CODE_ALPHABET.includes(symbol)) return null;
  return `JUNO-${body.slice(0, 4)}-${body.slice(4)}`;
}

/* ---------------------------------------------------------------------------
    THE RECORD (LIVE-2 §5.1), field for field
   --------------------------------------------------------------------------- */

export type GameStatus = "waiting" | "active" | "completed" | "cancelled" | "expired";
export type Visibility = "public" | "private";

export interface Seat {
  /** Server-minted; immutable; the log actor. */
  player_id: string;
  /** The controlling principal. NEVER changes: there is no seat transfer, reclaim or rebind (LIVE-2E built none;
   *  recovery and device linking restore the SAME principal -- ESCROW-3A F-2). Never projected. */
  principal_id: string;
  /** Carried, never moved (LIVE-2 reserved it for a rebind that does not exist). */
  binding_epoch: number;
  joined_at: number;
  bound_at: number;
  /** The start gate: set only by the seat's own principal. */
  ready: boolean;
  /** Cosmetic; validated; frozen at the deal (copied into SetupGame). No authorization rule reads it. */
  nickname: string;
  color: string | null;
  /** ESCROW-3 seams, never populated in LIVE-2. */
  payout_address: null;
  chain_seat_index: null;
}

export interface Admission {
  principal_id: string;
  admitted_at: number;
  via: "creator" | "join-code" | "transfer" | "reclaim";
}

export interface RoomPolicy {
  /** LIVE-2 §9 / OD-L2-1: no-money rooms "last-action"; money rooms (ESCROW-3) always "none". */
  host_undo: "last-action" | "none";
  /** OD-L2-4: a private room admits no non-seated reader after the deal. */
  private_spectators: false;
  /** OD-L2-4: spectators never chat. */
  spectator_chat: false;
  /** Non-seated readers per room. */
  max_viewers: number;
}

/* ==================================================================
    ESCROW-4: A REAL-MONEY TABLE'S TERMS (record_schema 2)
   ==================================================================
   A money table's GameRecord says WHAT the host agreed to at creation -- the deployment it is pinned to and the stake
   -- and nothing about the chain: the chain game, the funded seats, the frozen roster and every chain fact live in the
   table's financial record (`games/money/<game_id>.json`, ESCROW-3A/3B) and the wallet-ticket ledger -- the terms here
   COPY the pinned deployment; `FIN.binding.deployment` stays the write-once source of truth. Written once, by the
   create; never changed. A table with `money` is `record_schema: 2`, and that widening travels with financial protocol
   3 (LIVE-4 preflight §16 item 2): an older build classifies it as a NEWER record schema (derived, never corrupt, never
   held), and every no-money record stays exactly `record_schema: 1` (`money: null`), so the hosted protocol is 1. */
export const MONEY_TABLE_FORMAT = "18COSMOS/MONEY-TABLE/v1";

export interface GameMoneyTerms {
  readonly format: typeof MONEY_TABLE_FORMAT;
  readonly backend: "juno-cosmwasm";
  readonly chain_id: string;
  /** From the server's pinned configuration (never a caller's claim). Mainnet money is refused at creation. */
  readonly network_class: "mainnet" | "testnet" | "local";
  readonly contract_address: string;
  readonly code_checksum: string;
  readonly denom: string;
  readonly symbol: string;
  /** Display exponent only (6). */
  readonly exponent: number;
  /** Each seat's gross deposit, base units (canonical decimal). The contract takes its fee from it. */
  readonly ante_gross: string;
  /** The escrow's pace: its funding period and challenge window follow it. */
  readonly mode: "live" | "async";
}

const MONEY_TERMS_KEYS = ["format", "backend", "chain_id", "network_class", "contract_address", "code_checksum", "denom", "symbol", "exponent", "ante_gross", "mode"];

/** A stored money-terms object is exactly this shape (a record carrying anything else is unreadable). */
export function isGameMoneyTerms(value: unknown): value is GameMoneyTerms {
  if (!isObject(value) || !exact(value, MONEY_TERMS_KEYS)) return false;
  return (
    value.format === MONEY_TABLE_FORMAT &&
    value.backend === "juno-cosmwasm" &&
    typeof value.chain_id === "string" &&
    /^[a-z0-9][a-z0-9-]{1,48}$/.test(value.chain_id) &&
    (value.network_class === "mainnet" || value.network_class === "testnet" || value.network_class === "local") &&
    typeof value.contract_address === "string" &&
    /^[a-z0-9]{1,16}1[02-9ac-hj-np-z]{6,90}$/.test(value.contract_address) &&
    typeof value.code_checksum === "string" &&
    /^[0-9a-f]{64}$/.test(value.code_checksum) &&
    typeof value.denom === "string" &&
    /^[a-z][a-z0-9/:._-]{1,127}$/.test(value.denom) &&
    typeof value.symbol === "string" &&
    /^[A-Za-z0-9]{1,16}$/.test(value.symbol) &&
    value.exponent === 6 &&
    typeof value.ante_gross === "string" &&
    /^[1-9][0-9]{0,29}$/.test(value.ante_gross) &&
    (value.mode === "live" || value.mode === "async")
  );
}

export interface GameRecord {
  /** 1: a no-money table (`money: null`). 2 (ESCROW-4): a real-money table (`money` is its terms). */
  record_schema: 1 | 2;
  /** OCC counter: +1 per committed mutation. */
  record_version: number;
  game_id: string;
  join_code: string | null;
  visibility: Visibility;
  status: GameStatus;
  archived_at: number | null;
  host_player_id: string;
  seats: Seat[];
  seat_cap: number;
  exact_players: number | null;
  variants: GameVariants;
  admitted: Admission[];
  kicked_principals: string[];
  turn_order: string[] | null;
  rules_engine_version: number | null;
  protocol_version: null;
  created_at: number;
  created_by_principal: string;
  started_at: number | null;
  completed_at: number | null;
  closed_at: number | null;
  cancelled_at: number | null;
  expires_at: number | null;
  last_activity_at: number;
  /** ESCROW-4: a real-money table's terms (`record_schema: 2`), or null (`record_schema: 1`). The chain binding and every
   *  chain fact are the financial record's, never this record's. */
  money: GameMoneyTerms | null;
  policy: RoomPolicy;
}

export const RECORD_KEYS = [
  "record_schema",
  "record_version",
  "game_id",
  "join_code",
  "visibility",
  "status",
  "archived_at",
  "host_player_id",
  "seats",
  "seat_cap",
  "exact_players",
  "variants",
  "admitted",
  "kicked_principals",
  "turn_order",
  "rules_engine_version",
  "protocol_version",
  "created_at",
  "created_by_principal",
  "started_at",
  "completed_at",
  "closed_at",
  "cancelled_at",
  "expires_at",
  "last_activity_at",
  "money",
  "policy",
] as const;

const SEAT_KEYS = ["player_id", "principal_id", "binding_epoch", "joined_at", "bound_at", "ready", "nickname", "color", "payout_address", "chain_seat_index"];
const ADMISSION_KEYS = ["principal_id", "admitted_at", "via"];
const POLICY_KEYS = ["host_undo", "private_spectators", "spectator_chat", "max_viewers"];

export const WAITING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_UNSEATED_ADMISSIONS = 16;
export const DEFAULT_MAX_VIEWERS = 50;
export const DEFAULT_NICKNAME = "Player";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const time = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timeOrNull = (value: unknown) => value === null || time(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

/** A stored record is exactly the frozen fields, or it is unreadable (never guessed at). */
export function isGameRecord(value: unknown): value is GameRecord {
  if (!isObject(value) || !exact(value, RECORD_KEYS)) return false;
  const seatsOk =
    Array.isArray(value.seats) &&
    value.seats.every(
      (seat) =>
        isObject(seat) &&
        exact(seat, SEAT_KEYS) &&
        typeof seat.player_id === "string" &&
        /^p-[0-9A-Za-z_-]{1,32}$/.test(seat.player_id) &&
        text(seat.principal_id, 64) &&
        Number.isSafeInteger(seat.binding_epoch) &&
        time(seat.joined_at) &&
        time(seat.bound_at) &&
        typeof seat.ready === "boolean" &&
        text(seat.nickname, 64) &&
        (seat.color === null || text(seat.color, 32)) &&
        seat.payout_address === null &&
        seat.chain_seat_index === null,
    );
  const admittedOk =
    Array.isArray(value.admitted) &&
    value.admitted.every(
      (entry) =>
        isObject(entry) &&
        exact(entry, ADMISSION_KEYS) &&
        text(entry.principal_id, 64) &&
        time(entry.admitted_at) &&
        (entry.via === "creator" || entry.via === "join-code" || entry.via === "transfer" || entry.via === "reclaim"),
    );
  const policy = value.policy;
  /* ESCROW-4: schema 1 carries no money; schema 2 carries exactly a money table's terms, no host undo and an exact
     player count (the escrow is funded seat by seat, and the contract reaches FUNDED only when every seat is). */
  const moneyOk =
    value.record_schema === 1
      ? value.money === null
      : value.record_schema === 2 && isGameMoneyTerms(value.money) && isObject(policy) && policy.host_undo === "none" && typeof value.exact_players === "number";
  return (
    moneyOk &&
    Number.isSafeInteger(value.record_version) &&
    (value.record_version as number) >= 1 &&
    typeof value.game_id === "string" &&
    GAME_ID_PATTERN.test(value.game_id) &&
    (value.join_code === null || (typeof value.join_code === "string" && JOIN_CODE_PATTERN.test(value.join_code))) &&
    (value.visibility === "public" || value.visibility === "private") &&
    ["waiting", "active", "completed", "cancelled", "expired"].includes(value.status as string) &&
    timeOrNull(value.archived_at) &&
    text(value.host_player_id, 40) &&
    seatsOk &&
    Number.isSafeInteger(value.seat_cap) &&
    (value.exact_players === null || Number.isSafeInteger(value.exact_players)) &&
    isObject(value.variants) &&
    admittedOk &&
    Array.isArray(value.kicked_principals) &&
    value.kicked_principals.every((id) => text(id, 64)) &&
    (value.turn_order === null || (Array.isArray(value.turn_order) && value.turn_order.every((id) => text(id, 40)))) &&
    (value.rules_engine_version === null || Number.isSafeInteger(value.rules_engine_version)) &&
    value.protocol_version === null &&
    time(value.created_at) &&
    text(value.created_by_principal, 64) &&
    timeOrNull(value.started_at) &&
    timeOrNull(value.completed_at) &&
    timeOrNull(value.closed_at) &&
    timeOrNull(value.cancelled_at) &&
    timeOrNull(value.expires_at) &&
    time(value.last_activity_at) &&
    isObject(policy) &&
    exact(policy, POLICY_KEYS) &&
    (policy.host_undo === "last-action" || policy.host_undo === "none") &&
    policy.private_spectators === false &&
    policy.spectator_chat === false &&
    Number.isSafeInteger(policy.max_viewers)
  );
}

/* ---------------------------------------------------------------------------
    WHAT THE LOG SAYS (derived facts; LIVE-2 §5.2)
   --------------------------------------------------------------------------- */

export interface LogFacts {
  /** An effective `SetupGame` is in the log. */
  dealt: boolean;
  dealAt: number | null;
  /** `SetupGame.players[].id`, in turn order. */
  turnOrder: string[] | null;
  rulesEngineVersion: number | null;
  /** The board reached GameEnd. */
  ended: boolean;
  /** `room_closed` on the board (CloseRoom applied). */
  closed: boolean;
}

export const NO_FACTS: LogFacts = Object.freeze({ dealt: false, dealAt: null, turnOrder: null, rulesEngineVersion: null, ended: false, closed: false });

/** The lifecycle as the log and the record together make it -- the log first (§14.4). */
export function effectiveStatus(record: GameRecord, facts: LogFacts, now: number): GameStatus {
  if (record.status === "cancelled" || record.status === "expired") return record.status;
  if (facts.dealt) return facts.ended ? "completed" : "active";
  if (record.expires_at !== null && now >= record.expires_at) return "expired";
  return "waiting";
}

export const isTerminal = (status: GameStatus): boolean => status === "cancelled" || status === "expired";

export function seatOf(record: GameRecord, principalId: string | null): Seat | null {
  if (principalId === null) return null;
  return record.seats.find((seat) => seat.principal_id === principalId) ?? null;
}

export const isAdmitted = (record: GameRecord, principalId: string | null): boolean =>
  principalId !== null && record.admitted.some((entry) => entry.principal_id === principalId);

export const isKicked = (record: GameRecord, principalId: string | null): boolean =>
  principalId !== null && record.kicked_principals.includes(principalId);

/** The seat capacity: `exact_players` when set, else the cap. */
export const capacityOf = (record: GameRecord): number => record.exact_players ?? record.seat_cap;

/* ---------------------------------------------------------------------------
    PROJECTIONS (LIVE-2 §5.5): the only room shapes on the wire. No principal id of any kind, ever.
   --------------------------------------------------------------------------- */

/** LIVE-3C: why a room will not take a change, as the player is told it -- `null` when it will.
 *    maintenance   a durable hold (or a damaged log): paused until the server's operator restores it
 *    incompatible  this server does not continue the game (#1520; LIVE-4: the continuation verdict or the serving
 *                  decision -- its rules pin or hosted protocol, a money table's escrow, a drain past its deadline):
 *                  no history, no move; derived
 *    read-only     NEVER PRODUCED since LIVE-4 (L4-2) -- it was "dealt on another server build" (#1252); kept in the
 *                  type so the client's union and an older view stay readable
 *    unavailable   the server could not confirm its last write (LIVE-3B): paused until it can, or it restarts */
export type HoldKind = "maintenance" | "incompatible" | "read-only" | "unavailable" | null;

export interface RoomView {
  gameId: string;
  code: string | null;
  joinable: boolean;
  visibility: Visibility;
  status: "waiting" | "playing";
  lifecycle: GameStatus;
  closed: boolean;
  held: boolean;
  /** LIVE-3C: why the room will not take a change (`null`: it will). A projection of the server's state only. */
  holdKind: HoldKind;
  /** LIVE-4 (L4-3), additive and optional: with `holdKind: "incompatible"`, the player's sentence for why this pool does
   *  not continue (or no longer serves) the game -- the `incompatible` frame's own `reason` -- so the standing notice says
   *  the actual reason. Absent otherwise. */
  holdReason?: string;
  hostId: string;
  players: Array<{ id: string; nickname: string; isReady: boolean; color?: string; online: boolean }>;
  playerCount: number | null;
  seatCap: number;
  variants: GameVariants;
  createdAtMs: number;
  /** LIVE-2D: the room's undo policy, so the client's Undo button asks exactly the server's question (LIVE-2 §9.2,
   *  RV-7). A projection of `policy.host_undo` only -- no other policy internal is projected. */
  undoPolicy: UndoPolicy;
  you: {
    role: "host" | "player" | "member" | "viewer";
    playerId: string | null;
    kicked: boolean;
    canStart: boolean;
  };
  /** ESCROW-4 (additive and optional): a real-money table's projection for THIS viewer (`frontend/src/utils/
   *  moneyProtocol.ts`). Absent for a no-money table, whose view is exactly as before. */
  money?: RoomMoneyView;
  /** Phase 3 lane A (AUD-11.04; additive and optional): the gameplay clock, the same for every viewer
   *  (`frontend/src/utils/clockProtocol.ts`, `clockKeeper.ts`). Absent before the deal, while the clock is being read,
   *  and from an older server. Presentation only: nothing in the game reads it. */
  clock?: RoomClockView;
}

export interface RoomSummary {
  gameId: string;
  code: string;
  status: "waiting" | "playing";
  hostNickname: string;
  nicknames: string[];
  readyCount: number;
  seated: number;
  seatCap: number;
  playerCount: number | null;
  variants: GameVariants;
  createdAtMs: number;
  /** ESCROW-4 (additive and optional): a real-money table's stake badge. Absent for a no-money table. */
  stake?: RoomStakeSummary;
}

/* ==================================================================
    LIVE-2F/3D (C9-01): "YOUR TABLES" -- the way back to a seat
   ==================================================================
   The only pointer a browser keeps to its table is the tab's own `sessionStorage`. A private table's code is released
   at the deal and a private table is never in the public list, so a player who closed the tab, linked a device,
   recovered onto a new browser, signed out and in, or pressed "← Lobby" had a seat nothing on screen could reach. This
   is the LIVE-2 design's reserved "my games" read, as a room op on the lobby channel: every table whose RECORD seats
   the caller's principal -- whatever the table's class -- with nothing beyond what a seated player already sees (no
   principal id, no code). Opening one goes through the game's actor like any other open, so an unreconciled table is
   reconciled first and a held one says it is held; the list itself decides and changes nothing. */
export type MyTableState = "waiting" | "playing" | "finished" | "resume" | "paused" | "unavailable" | "cannot-continue" | "watch-only";

export interface MyTableSummary {
  gameId: string;
  state: MyTableState;
  visibility: "public" | "private";
  hostNickname: string;
  nicknames: string[];
  you: "host" | "player";
  createdAtMs: number;
  lastActivityMs: number;
  /** ESCROW-4 (additive and optional): this seat's money line at a real-money table. Absent otherwise. */
  money?: MyTableMoneySummary;
}

export function myTableSummaryOf(record: GameRecord, principalId: string, state: MyTableState, money: MyTableMoneySummary | null = null): MyTableSummary | null {
  const seat = seatOf(record, principalId);
  if (seat === null) return null;
  const host = record.seats.find((candidate) => candidate.player_id === record.host_player_id);
  return {
    gameId: record.game_id,
    state,
    visibility: record.visibility,
    hostNickname: host?.nickname ?? "",
    nicknames: record.seats.map((candidate) => candidate.nickname),
    you: seat.player_id === record.host_player_id ? "host" : "player",
    createdAtMs: record.created_at,
    lastActivityMs: record.last_activity_at,
    ...(record.money !== null && money !== null ? { money } : {}),
  };
}

export function roomViewFor(
  record: GameRecord,
  facts: LogFacts,
  principalId: string,
  context: { now: number; held: boolean; holdKind?: HoldKind; holdReason?: string | null; online: (playerId: string) => boolean; canStart: boolean; money?: RoomMoneyView | null; clock?: RoomClockView | null },
): RoomView {
  const lifecycle = effectiveStatus(record, facts, context.now);
  const seat = seatOf(record, principalId);
  const host = seat !== null && seat.player_id === record.host_player_id;
  const member = isAdmitted(record, principalId);
  const role: RoomView["you"]["role"] = host ? "host" : seat !== null ? "player" : member ? "member" : "viewer";
  const insider = seat !== null || member;
  return {
    gameId: record.game_id,
    code: record.visibility === "public" || insider ? record.join_code : null,
    joinable: lifecycle === "waiting" && record.join_code !== null && record.seats.length < capacityOf(record) && (context.holdKind ?? null) === null,
    visibility: record.visibility,
    status: lifecycle === "waiting" ? "waiting" : "playing",
    lifecycle,
    closed: facts.closed,
    held: context.held,
    holdKind: context.holdKind ?? null,
    ...(context.holdKind === "incompatible" && typeof context.holdReason === "string" && context.holdReason !== "" ? { holdReason: context.holdReason } : {}),
    hostId: record.host_player_id,
    players: record.seats.map((entry) => ({
      id: entry.player_id,
      nickname: entry.nickname,
      isReady: entry.ready,
      ...(entry.color !== null ? { color: entry.color } : {}),
      online: context.online(entry.player_id),
    })),
    playerCount: record.exact_players,
    seatCap: record.seat_cap,
    variants: record.variants,
    createdAtMs: record.created_at,
    undoPolicy: { host_undo: record.policy.host_undo },
    you: { role, playerId: seat?.player_id ?? null, kicked: isKicked(record, principalId), canStart: host && context.canStart },
    ...(record.money !== null && context.money != null ? { money: context.money } : {}),
    ...(context.clock != null ? { clock: context.clock } : {}),
  };
}

/** A public list entry: public rooms in W or A only; names yes, ids no (beyond gameId and code). */
export function roomSummaryOf(record: GameRecord, facts: LogFacts, now: number, stake: RoomStakeSummary | null = null): RoomSummary | null {
  const lifecycle = effectiveStatus(record, facts, now);
  if (record.visibility !== "public" || record.join_code === null || record.archived_at !== null) return null;
  if (lifecycle !== "waiting" && lifecycle !== "active") return null;
  const host = record.seats.find((seat) => seat.player_id === record.host_player_id);
  return {
    gameId: record.game_id,
    code: record.join_code,
    status: lifecycle === "waiting" ? "waiting" : "playing",
    hostNickname: host?.nickname ?? "",
    nicknames: record.seats.map((seat) => seat.nickname),
    readyCount: record.seats.filter((seat) => seat.ready).length,
    seated: record.seats.length,
    seatCap: record.seat_cap,
    playerCount: record.exact_players,
    variants: record.variants,
    createdAtMs: record.created_at,
    ...(record.money !== null && stake !== null ? { stake } : {}),
  };
}
