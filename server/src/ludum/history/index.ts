// LUDUM v1 -- player history (Lane C): the `games` and `game` handlers (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §2.3,
// §4, §5). Both are profiled: a signed-out caller gets 401 `signed-out`. Both read only through `LudumPorts`. The
// exported names and types are fixed by ../registry.ts.
//
// `games` -- every game whose RECORD seats the caller, every status (archived included), no cap, newest first
// (`created_at` desc, then `game_id` desc), paged by an opaque cursor: base64url of `{"createdAt":<ISO>,"gameId":<id>}`,
// the last item of the previous page. The limit is 1..50, default 20.
//
// THE SCAN IS O(n). There is no account -> games index anywhere (§1.5), so each call walks the whole in-memory
// `recordIndex` (`ports.records()`), filters by `seatOf`, sorts the caller's games and slices one page; only the page's
// games then read their financial record, evidence and chain game. The filter is a string compare per seat, so ~10^4
// records cost a few milliseconds per call and ~10^5 stay tolerable for a rate-limited read route. An
// `ACCT#<principal>` index (written with the seat, sorted by `created_at`) becomes necessary when the record index no
// longer holds every game in memory (archived records paged off-line, several servers) or past roughly 10^5 records,
// when every page costs a full scan and sort. It is NOT built here (§7: "a durable account -> games index" is later).
//
// `game` -- §5 `GameDetail` for one game, 404 `not-found` unless the caller holds a seat in it (a game that exists but
// seats someone else answers exactly like one that does not exist).

import type { GamesResponse, GameSummary } from "../contract";
import type { LudumHandler, LudumPorts } from "../ports";
import { GAME_ID_PATTERN, type GameRecord, type Seat } from "../../rooms/gameRecord";
import { detailOf, summaryOf } from "./projection";
import { transactionsOf } from "../transactions";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
const MAX_CURSOR = 256;

type Answer = { status: number; json: unknown };
const fail = (status: number, error: "bad-request" | "signed-out" | "not-found" | "unavailable", detail?: string): Answer => ({ status, json: { error, ...(detail !== undefined ? { detail } : {}) } });
const signedOut = (): Answer => fail(401, "signed-out");

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

export interface CursorKey {
  readonly createdAt: string;
  readonly gameId: string;
}

export const encodeCursor = (key: CursorKey): string => Buffer.from(JSON.stringify({ createdAt: key.createdAt, gameId: key.gameId }), "utf8").toString("base64url");

/** The cursor's key, or null when it is not one this server issues (a closed shape: exactly the two keys). */
export function decodeCursor(cursor: string): CursorKey | null {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(value) || Object.keys(value).length !== 2 || typeof value.createdAt !== "string" || typeof value.gameId !== "string") return null;
  const ms = Date.parse(value.createdAt);
  if (!GAME_ID_PATTERN.test(value.gameId) || !Number.isFinite(ms) || new Date(ms).toISOString() !== value.createdAt) return null;
  return { createdAt: value.createdAt, gameId: value.gameId };
}

interface Seated {
  readonly record: GameRecord;
  readonly seat: Seat;
  readonly created: number;
  readonly gameId: string;
}

/** Newest first: `created_at` desc, then `game_id` desc (a total order, so a cursor is never ambiguous). */
const newestFirst = (a: { created: number; gameId: string }, b: { created: number; gameId: string }): number =>
  b.created !== a.created ? b.created - a.created : a.gameId < b.gameId ? 1 : a.gameId > b.gameId ? -1 : 0;

/** Every game whose record seats this principal: one O(n) pass over the record index. */
function seatedGames(ports: LudumPorts, principalId: string): Seated[] {
  const out: Seated[] = [];
  for (const record of ports.records()) {
    const seat = ports.seatOf(record, principalId);
    if (seat !== null) out.push({ record, seat, created: record.created_at, gameId: record.game_id });
  }
  return out.sort(newestFirst);
}

export const games: LudumHandler = async (body, caller, ports) => {
  if (caller.principalId === null) return signedOut();
  if (!isObject(body) || !onlyKeys(body, ["cursor", "limit"])) return fail(400, "bad-request", "the body is { cursor?, limit? }");
  let limit = DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_LIMIT) return fail(400, "bad-request", `limit is an integer 1..${MAX_LIMIT}`);
    limit = body.limit;
  }
  let after: CursorKey | null = null;
  if (body.cursor !== undefined) {
    if (typeof body.cursor !== "string") return fail(400, "bad-request", "cursor is a string");
    after = decodeCursor(body.cursor);
    if (after === null) return fail(400, "bad-request", "cursor is not valid");
  }
  let mine: Seated[];
  try {
    mine = seatedGames(ports, caller.principalId);
  } catch {
    return fail(503, "unavailable", "the game records could not be read");
  }
  if (after !== null) {
    const key = { created: Date.parse(after.createdAt), gameId: after.gameId };
    mine = mine.filter((item) => newestFirst(key, item) < 0);
  }
  const page = mine.slice(0, limit);
  const summaries: GameSummary[] = await Promise.all(page.map((item) => summaryOf(ports, item.record, item.seat)));
  const last = page[page.length - 1];
  const response: GamesResponse = {
    games: summaries,
    nextCursor: mine.length > limit && last !== undefined ? encodeCursor({ createdAt: new Date(last.created).toISOString(), gameId: last.gameId }) : null,
    asOf: new Date(ports.now()).toISOString(),
  };
  return { status: 200, json: response };
};

export const game: LudumHandler = async (body, caller, ports) => {
  if (caller.principalId === null) return signedOut();
  if (!isObject(body) || !onlyKeys(body, ["gameId"]) || typeof body.gameId !== "string") return fail(400, "bad-request", "the body is { gameId }");
  if (!GAME_ID_PATTERN.test(body.gameId)) return fail(400, "bad-request", "gameId is not a game id");
  let found: { record: GameRecord; seat: Seat } | null = null;
  try {
    for (const record of ports.records()) {
      if (record.game_id !== body.gameId) continue;
      const seat = ports.seatOf(record, caller.principalId);
      if (seat !== null) found = { record, seat };
      break;
    }
  } catch {
    return fail(503, "unavailable", "the game records could not be read");
  }
  if (found === null) return fail(404, "not-found");
  /* v1.1: the transactions this server relayed for the game (the docket's hashes). */
  const detail = await detailOf(ports, found.record, found.seat);
  return { status: 200, json: { ...detail, transactions: await transactionsOf(ports, found.record.money === null ? null : found.record.game_id) } };
};
