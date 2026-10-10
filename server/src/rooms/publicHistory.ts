// server/src/rooms/publicHistory.ts
//
// ==================================================================
//  PLAY LOBBY: THE PUBLIC GAME HISTORY OF A LISTED TABLE'S PLAYERS (read-only)
// ==================================================================
//
//   POST /gs/api/lobby/players {gameId}   200 {gameId, players: [{seat, name, host, history}]}
//
// The lobby's seated list (design handoff §5, §6): for a table IN THE PUBLIC LIST right now (public, waiting or playing),
// each seat's public name and that player's public game history. Anyone may ask -- signed in or not -- because the
// table and its seated names are already public. The approved facts, and nothing else:
//   completed   how many completed PUBLIC games the player sat at (this server's records)
//   firstMonth  "YYYY-MM" of the first of them (the public stand-in for account age)
//   wins / places  finishing places, from each game's sealed result (the certified appraisal of its terminal board),
//              for the games whose result could be read here (`placed`; the rest are counted, never guessed)
//   recent      up to three: the day it ended, its edition, the place and the number of players
// NEVER: a principal, profile or player id, a username, account age, a wallet, an amount won or lost, a payout, a
// conduct or moderation fact, a private table. A private or unfinished game counts for nothing. Enforced HERE, by
// construction: the answer is built from these fields only.
//
// The ingress is Play's own (`identity/httpApi.ts` rules): POST, an allow-listed Origin (exact; no CORS), JSON, a
// closed body of at most 1 KiB, a per-address budget; no session is read and nothing is written. Results are cached
// per game (a completed game's result never changes); an unreadable one is retried after a while.

import type { IncomingMessage, ServerResponse } from "http";

import { gameTypeOf, type GameType } from "../../../frontend/src/gameEngine/gameVariants";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { prepareTerminalEvidence, type PrefixReplay } from "../escrow/settlementEvidence";
import { clientIpOf } from "../identity/clientIp";
import { isJson, json, parseBody, readBody, retryAfter } from "../identity/httpApi";
import { originAllowed } from "../identity/origins";
import type { IpBuckets } from "../ingress/limits";
import { GAME_ID_PATTERN, type GameRecord, type RoomSummary } from "./gameRecord";
import { sealOf } from "./lifecycle";

export const LOBBY_PLAYERS_PATH = "/gs/api/lobby/players";
const MAX_BODY_BYTES = 1024;
const RECENT = 3;
/** A game's result that could not be read is tried again after this long. */
const RETRY_UNKNOWN_MS = 10 * 60 * 1000;
/** At most this many of a player's games are replayed for places in one answer (the rest wait for a later one). */
const MAX_REPLAYS_PER_ANSWER = 25;

export interface PublicGameHistory {
  completed: number;
  firstMonth: string | null;
  wins: number;
  /** Finishing places among the `placed` games: 1st, 2nd, 3rd, and 4th or lower. */
  places: { first: number; second: number; third: number; rest: number };
  placed: number;
  recent: Array<{ endedOn: string; edition: GameType; place: number; of: number }>;
}

export interface PublicSeat {
  seat: number;
  name: string;
  host: boolean;
  history: PublicGameHistory;
}

/** One completed game's finishing places, by principal (server-side only), or null: not readable. */
type GameResult = { readonly places: ReadonlyMap<string, number>; readonly of: number } | null;

export interface PublicHistoryDeps {
  readonly records: () => readonly GameRecord[];
  readonly publicRooms: () => readonly RoomSummary[];
  readonly readLog: (gameId: string) => Promise<readonly ServerLogEntry[] | null>;
  readonly replay: PrefixReplay;
  readonly now: () => number;
  /** The terminal evidence of a completed game (tests substitute it; the server's own derivation by default). */
  readonly evidence?: typeof prepareTerminalEvidence;
}

/** A game that counts for public history: public, completed, with its end recorded. */
export function countsForPublicHistory(record: Readonly<GameRecord>): boolean {
  return record.visibility === "public" && record.status === "completed" && record.completed_at !== null && record.cancelled_at === null;
}

/** Finishing places from the appraised totals: 1 + the number of players strictly ahead (a tie shares the place). */
export function placesOf(totals: Readonly<Record<string, string>>): Map<string, number> {
  const entries = Object.entries(totals).map(([playerId, total]) => [playerId, BigInt(total)] as const);
  const places = new Map<string, number>();
  for (const [playerId, total] of entries) places.set(playerId, 1 + entries.filter(([, other]) => other > total).length);
  return places;
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function createPublicHistory(deps: PublicHistoryDeps) {
  const results = new Map<string, { result: GameResult; at: number }>();
  const inFlight = new Map<string, Promise<GameResult>>();

  async function computeResult(record: GameRecord): Promise<GameResult> {
    const entries = await deps.readLog(record.game_id).catch(() => null);
    if (entries === null || entries.length === 0) return null;
    const seal = sealOf(entries, true);
    if (seal === null) return null;
    let outcome: ReturnType<typeof prepareTerminalEvidence>;
    try {
      outcome = (deps.evidence ?? prepareTerminalEvidence)({ gameId: record.game_id, entries, seal, replay: deps.replay });
    } catch {
      return null;
    }
    if (!outcome.ok) return null;
    const byPlayer = placesOf(outcome.evidence.totals);
    const places = new Map<string, number>();
    for (const seat of record.seats) {
      const place = byPlayer.get(seat.player_id);
      if (place !== undefined) places.set(seat.principal_id, place);
    }
    return { places, of: outcome.evidence.players.length };
  }

  /** A completed game's result: cached; an unknown one retried after `RETRY_UNKNOWN_MS`; `undefined` when not yet read
   *  and this answer has no replays left. */
  async function resultOf(record: GameRecord, budget: { left: number }): Promise<GameResult | undefined> {
    const cached = results.get(record.game_id);
    if (cached !== undefined && (cached.result !== null || deps.now() - cached.at < RETRY_UNKNOWN_MS)) return cached.result;
    const running = inFlight.get(record.game_id);
    if (running !== undefined) return running;
    if (budget.left <= 0) return undefined;
    budget.left -= 1;
    const work = computeResult(record).then(
      (result) => {
        results.set(record.game_id, { result, at: deps.now() });
        return result;
      },
      () => {
        results.set(record.game_id, { result: null, at: deps.now() });
        return null;
      },
    );
    inFlight.set(record.game_id, work);
    try {
      return await work;
    } finally {
      inFlight.delete(record.game_id);
    }
  }

  async function historyOf(principalId: string, all: readonly GameRecord[], budget: { left: number }): Promise<PublicGameHistory> {
    const games = all
      .filter((record) => countsForPublicHistory(record) && record.seats.some((seat) => seat.principal_id === principalId))
      .sort((a, b) => (b.completed_at as number) - (a.completed_at as number));
    const history: PublicGameHistory = {
      completed: games.length,
      firstMonth: games.length === 0 ? null : monthOf(Math.min(...games.map((record) => record.completed_at as number))),
      wins: 0,
      places: { first: 0, second: 0, third: 0, rest: 0 },
      placed: 0,
      recent: [],
    };
    for (const record of games) {
      const result = await resultOf(record, budget);
      const place = result?.places.get(principalId);
      if (result === null || result === undefined || place === undefined) continue;
      history.placed += 1;
      if (place === 1) history.wins += 1;
      if (place === 1) history.places.first += 1;
      else if (place === 2) history.places.second += 1;
      else if (place === 3) history.places.third += 1;
      else history.places.rest += 1;
      if (history.recent.length < RECENT) history.recent.push({ endedOn: dayOf(record.completed_at as number), edition: gameTypeOf(record.variants), place, of: result.of });
    }
    return history;
  }

  return {
    /** The listed table's players and their public history, or null: not a table in the public list now. */
    async playersOf(gameId: string): Promise<PublicSeat[] | null> {
      const listed = deps.publicRooms().find((room) => room.gameId === gameId);
      if (listed === undefined) return null;
      const all = deps.records();
      const record = all.find((entry) => entry.game_id === gameId);
      if (record === undefined || record.visibility !== "public") return null;
      const budget = { left: MAX_REPLAYS_PER_ANSWER };
      const out: PublicSeat[] = [];
      for (const [seat, entry] of record.seats.entries()) {
        out.push({
          seat,
          /* The list's own public name (the account display name), so the panel and the row never disagree. */
          name: listed.nicknames[seat] ?? "A player",
          host: entry.player_id === record.host_player_id,
          history: await historyOf(entry.principal_id, all, budget),
        });
      }
      return out;
    },
  };
}

export type PublicHistory = ReturnType<typeof createPublicHistory>;

export interface LobbyHttpApi {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly trustedProxyHops: number;
  readonly history: PublicHistory;
  /** Per client address (`IpBuckets`): a seated list opened, a few names tapped. */
  readonly budget: IpBuckets;
  readonly onError: (what: string, error: unknown) => string;
}

/** Handle `POST /gs/api/lobby/players`; `false` for any other path. */
export function handleLobbyHttp(request: IncomingMessage, response: ServerResponse, api: LobbyHttpApi): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (pathname !== LOBBY_PLAYERS_PATH) return false;
  void serve(request, response, api).catch((error) => {
    const ref = api.onError("a lobby players request", error);
    json(response, 503, { error: "unavailable", ref });
  });
  return true;
}

async function serve(request: IncomingMessage, response: ServerResponse, api: LobbyHttpApi): Promise<void> {
  if (request.method !== "POST") {
    request.resume();
    json(response, 405, { error: "method-not-allowed" }, { Allow: "POST" });
    return;
  }
  if (!originAllowed(request.headers.origin, api.allowedOrigins)) {
    request.resume();
    json(response, 403, { error: "origin-forbidden" });
    return;
  }
  if (!isJson(request.headers["content-type"])) {
    request.resume();
    json(response, 415, { error: "unsupported-media-type" });
    return;
  }
  const client = clientIpOf(request, api.trustedProxyHops);
  if (!client.ok) {
    request.resume();
    json(response, 400, { error: "bad-request" });
    return;
  }
  const wait = api.budget.take(client.ip);
  if (wait > 0) {
    request.resume();
    json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
    return;
  }
  const body = await readBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    json(response, body.status, { error: body.status === 413 ? "too-large" : "bad-request" });
    return;
  }
  const fields = parseBody(body.text, { gameId: { string: 64 } });
  if (fields === null || typeof fields.gameId !== "string" || !GAME_ID_PATTERN.test(fields.gameId)) {
    json(response, 400, { error: "bad-request" });
    return;
  }
  const players = await api.history.playersOf(fields.gameId);
  if (players === null) {
    json(response, 404, { error: "not-found" });
    return;
  }
  json(response, 200, { ok: true, gameId: fields.gameId, players });
}
