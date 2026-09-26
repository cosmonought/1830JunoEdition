// server/src/rooms/roomService.ts
//
// ==================================================================
//  LIVE-2C (LIVE-2 §6.3, §7.5, §8, §9.5): THE NAMED ROOM OPERATIONS, AS PURE FUNCTIONS
// ==================================================================
//
// Every mutation of a GameRecord is one of these functions: given the COMMITTED record, the log's facts and the
// caller's principal, it answers a refusal or the next record (version + 1). No op accepts a field name, a partial
// document or a patch, and none takes a host id except `transfer-host`, whose authority is the current host. The
// server runs each one as a task on the game's actor (check-and-mutate in one step, then `commitRecord`, durable
// before visible), so two ops on one game never interleave and nothing is visible before the store has it.
//
// START (§8): the host sends `start-game` and nothing else. The server plans the roster through a `RosterSource`
// (no-money: the authoritative seats), shuffles it with `crypto.randomInt` Fisher-Yates, and builds a `SetupGame` in
// exactly the shape the reducer already reads -- `{players: [{id, nickname, color?}], variants, build}` -- whose ids
// are the seats' server-minted `player_id`s. A client-sent `SetupGame` is refused on this path.
//
// NOT HERE (LIVE-2E): transfer codes, reclaim, and the binding-epoch rebind. `binding_epoch` is carried, never moved.

import { randomInt } from "crypto";

import { CURRENT_RULES_REVISION, type GameVariants } from "../../../frontend/src/gameEngine/gameVariants";
import { MIN_PLAYERS, maxPlayersFor, type SetupGameMsg } from "../../../frontend/src/gameEngine/gameSetup";
import { sanitizeName } from "../../../frontend/src/gameEngine/messageSchema";
import { SEAT_COLORS } from "../../../frontend/src/utils/playerLabels";
import { authorize, type AuthzResult, type RoomOp } from "./roomAuthz";
import {
  DEFAULT_MAX_VIEWERS,
  DEFAULT_NICKNAME,
  MAX_UNSEATED_ADMISSIONS,
  WAITING_TTL_MS,
  capacityOf,
  isAdmitted,
  isKicked,
  seatOf,
  type GameRecord,
  type LogFacts,
  type Seat,
  type Visibility,
} from "./gameRecord";

export const MAX_NICKNAME_LENGTH = 24;

export interface OpEnv {
  record: GameRecord;
  facts: LogFacts;
  principalId: string;
  now: number;
  held: boolean;
  /** A fresh `player_id` (the op checks it is unused in this record). */
  mintPlayerId: () => string;
}

export interface OpEffects {
  /** A join code the op needs claimed in the index BEFORE its record commits. */
  claimCode?: string;
  /** A join code to release AFTER the record committed without it. */
  releaseCode?: string;
  /** Principals whose sockets must lose this game now (kicked; dropped from a room that went private). */
  evicted?: string[];
  /** A `leave` after the deal: unsubscribe only, nothing to commit. */
  unsubscribeOnly?: boolean;
}

export type OpOutcome =
  | { readonly ok: false; readonly code: string; readonly reason: string }
  | { readonly ok: true; readonly record: GameRecord | null; readonly data?: Record<string, unknown>; readonly effects?: OpEffects };

const refused = (code: string, reason: string): OpOutcome => ({ ok: false, code, reason });
const fromAuthz = (verdict: AuthzResult): OpOutcome | null => (verdict.ok ? null : refused(verdict.code, verdict.reason));
const gate = (op: RoomOp, env: OpEnv) =>
  fromAuthz(authorize(op, { record: env.record, facts: env.facts, principalId: env.principalId, now: env.now, held: env.held }));

/** The next version of a record: copied, `record_version` + 1, `last_activity_at` now. */
function next(record: GameRecord, now: number, change: (draft: GameRecord) => void): GameRecord {
  const draft = JSON.parse(JSON.stringify(record)) as GameRecord;
  change(draft);
  draft.record_version = record.record_version + 1;
  draft.last_activity_at = now;
  return draft;
}

/** A name, cleaned TO A FIXPOINT (review M2): the shared sanitizer is not idempotent on every input (it collapses
 *  whitespace before it strips format characters), so it is applied until the result stops changing -- a stored name
 *  is always one the sanitizer leaves alone. An input that never settles is refused (empty). */
export function cleanNickname(raw: unknown): string {
  let out = sanitizeName(raw, MAX_NICKNAME_LENGTH);
  for (let pass = 0; pass < 8; pass += 1) {
    const next = sanitizeName(out, MAX_NICKNAME_LENGTH);
    if (next === out) return out;
    out = next;
  }
  return "";
}

function freshPlayerId(env: OpEnv): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = env.mintPlayerId();
    if (!env.record.seats.some((seat) => seat.player_id === id)) return id;
  }
  throw new Error("player id collisions -- the random source is not random");
}

function newSeat(env: OpEnv, nickname: string, color: string | null): Seat {
  return {
    player_id: freshPlayerId(env),
    principal_id: env.principalId,
    binding_epoch: 0,
    joined_at: env.now,
    bound_at: env.now,
    ready: false,
    nickname,
    color,
    payout_address: null,
    chain_seat_index: null,
  };
}

/* ---------------------------------------------------------------------------
    CREATE (#7)
   --------------------------------------------------------------------------- */

export interface CreateInput {
  gameId: string;
  joinCode: string;
  principalId: string;
  now: number;
  visibility: Visibility;
  exactPlayers: number | null;
  variants: GameVariants;
  nickname: unknown;
  color: string | null;
  hostPlayerId: string;
}

/** The first record of a game: the creator's host seat, admitted (private), waiting for 24 h. */
export function createRecord(input: CreateInput): OpOutcome {
  const seatCap = maxPlayersFor(input.variants);
  if (input.exactPlayers !== null && (!Number.isSafeInteger(input.exactPlayers) || input.exactPlayers < MIN_PLAYERS || input.exactPlayers > seatCap)) {
    return refused("bad-frame", `A table is for ${MIN_PLAYERS} to ${seatCap} players.`);
  }
  if (input.color !== null && !(SEAT_COLORS as readonly string[]).includes(input.color)) return refused("bad-frame", "That is not a seat colour.");
  const nickname = cleanNickname(input.nickname) || "Host";
  const record: GameRecord = {
    record_schema: 1,
    record_version: 1,
    game_id: input.gameId,
    join_code: input.joinCode,
    visibility: input.visibility,
    status: "waiting",
    archived_at: null,
    host_player_id: input.hostPlayerId,
    seats: [
      {
        player_id: input.hostPlayerId,
        principal_id: input.principalId,
        binding_epoch: 0,
        joined_at: input.now,
        bound_at: input.now,
        ready: false,
        nickname,
        color: input.color,
        payout_address: null,
        chain_seat_index: null,
      },
    ],
    seat_cap: seatCap,
    exact_players: input.exactPlayers,
    variants: input.variants,
    admitted: input.visibility === "private" ? [{ principal_id: input.principalId, admitted_at: input.now, via: "creator" }] : [],
    kicked_principals: [],
    turn_order: null,
    rules_engine_version: null,
    protocol_version: null,
    created_at: input.now,
    created_by_principal: input.principalId,
    started_at: null,
    completed_at: null,
    closed_at: null,
    cancelled_at: null,
    expires_at: input.now + WAITING_TTL_MS,
    last_activity_at: input.now,
    money: null,
    policy: { host_undo: "last-action", private_spectators: false, spectator_chat: false, max_viewers: DEFAULT_MAX_VIEWERS },
  };
  return { ok: true, record, data: { gameId: input.gameId, code: input.joinCode, playerId: input.hostPlayerId } };
}

/* ---------------------------------------------------------------------------
    MEMBERSHIP (#8-#11)
   --------------------------------------------------------------------------- */

/** #9 take a seat. Idempotent for an already-seated principal. */
export function takeSeat(env: OpEnv): OpOutcome {
  /* The gate FIRST (§6.2): a kicked principal of a private room is an outsider, answered `not-found` like anyone. */
  const denied = gate("take-seat", env);
  if (denied) return denied;
  const existing = seatOf(env.record, env.principalId);
  if (existing !== null) return { ok: true, record: null, data: { gameId: env.record.game_id, playerId: existing.player_id } };
  if (isKicked(env.record, env.principalId)) return refused("kicked", "You were removed from this table.");
  if (env.record.seats.length >= capacityOf(env.record)) return refused("room-full", "Every seat at this table is taken.");
  const seat = newSeat(env, DEFAULT_NICKNAME, null);
  return {
    ok: true,
    record: next(env.record, env.now, (draft) => {
      draft.seats.push(seat);
    }),
    data: { gameId: env.record.game_id, playerId: seat.player_id },
  };
}

/** #8 join by code (the code already resolved to this record and checked against it by the caller). */
export function joinByCode(env: OpEnv, takeSeatToo: boolean): OpOutcome {
  const denied = gate("join", env);
  if (denied) return denied;
  const existing = seatOf(env.record, env.principalId);
  if (existing !== null) return { ok: true, record: null, data: { gameId: env.record.game_id, playerId: existing.player_id, code: env.record.join_code } };
  if (isKicked(env.record, env.principalId)) return refused("kicked", "You were removed from this table.");
  const waiting = env.record.status === "waiting" && !env.facts.dealt;
  const needsAdmission = env.record.visibility === "private" && !isAdmitted(env.record, env.principalId);
  if (needsAdmission) {
    const unseated = env.record.admitted.filter((entry) => seatOf(env.record, entry.principal_id) === null).length;
    if (unseated >= MAX_UNSEATED_ADMISSIONS) return refused("room-full", "This table has as many guests waiting as it takes.");
  }
  const seatWanted = takeSeatToo && waiting && env.record.seats.length < capacityOf(env.record);
  if (!needsAdmission && !seatWanted) return { ok: true, record: null, data: { gameId: env.record.game_id, playerId: null, code: env.record.join_code } };
  const seat = seatWanted ? newSeat(env, DEFAULT_NICKNAME, null) : null;
  return {
    ok: true,
    record: next(env.record, env.now, (draft) => {
      if (needsAdmission) draft.admitted.push({ principal_id: env.principalId, admitted_at: env.now, via: "join-code" });
      if (seat !== null) draft.seats.push(seat);
    }),
    data: { gameId: env.record.game_id, playerId: seat?.player_id ?? null, code: env.record.join_code },
  };
}

/** Host succession (§9.5): the earliest remaining seat, or the room is cancelled when nobody is left. */
function withoutSeat(draft: GameRecord, playerId: string, now: number): { releaseCode?: string } {
  const leavingHost = draft.host_player_id === playerId;
  draft.seats = draft.seats.filter((seat) => seat.player_id !== playerId);
  if (!leavingHost) return {};
  if (draft.seats.length === 0) {
    const code = draft.join_code;
    draft.status = "cancelled";
    draft.cancelled_at = now;
    draft.join_code = null;
    draft.expires_at = null;
    return code === null ? {} : { releaseCode: code };
  }
  const successor = [...draft.seats].sort((a, b) => a.joined_at - b.joined_at || (a.player_id < b.player_id ? -1 : 1))[0];
  draft.host_player_id = successor.player_id;
  return {};
}

/** #10 release a seat (waiting only). The admission stays (a private room's member may take a seat again). */
export function releaseSeat(env: OpEnv): OpOutcome {
  const denied = gate("release-seat", env);
  if (denied) return denied;
  const seat = seatOf(env.record, env.principalId) as Seat;
  let effects: OpEffects = {};
  const record = next(env.record, env.now, (draft) => {
    effects = withoutSeat(draft, seat.player_id, env.now);
  });
  return { ok: true, record, effects };
}

/** #11 leave: waiting -- seat and admission go; later -- unsubscribe only (a dealt seat is never abandoned). */
export function leave(env: OpEnv): OpOutcome {
  const denied = gate("leave", env);
  if (denied) return denied;
  const waiting = !env.facts.dealt;
  if (!waiting) return { ok: true, record: null, effects: { unsubscribeOnly: true } };
  const seat = seatOf(env.record, env.principalId);
  if (seat === null && !isAdmitted(env.record, env.principalId)) return { ok: true, record: null, effects: { unsubscribeOnly: true } };
  let effects: OpEffects = { unsubscribeOnly: true };
  const record = next(env.record, env.now, (draft) => {
    draft.admitted = draft.admitted.filter((entry) => entry.principal_id !== env.principalId);
    if (seat !== null) effects = { ...withoutSeat(draft, seat.player_id, env.now), unsubscribeOnly: true };
  });
  return { ok: true, record, effects };
}

/* ---------------------------------------------------------------------------
    THE SEAT'S OWN (#13, #14)
   --------------------------------------------------------------------------- */

export function setReady(env: OpEnv, ready: boolean): OpOutcome {
  const denied = gate("set-ready", env);
  if (denied) return denied;
  const seat = seatOf(env.record, env.principalId) as Seat;
  if (seat.ready === ready) return { ok: true, record: null };
  return {
    ok: true,
    record: next(env.record, env.now, (draft) => {
      (draft.seats.find((entry) => entry.player_id === seat.player_id) as Seat).ready = ready;
    }),
  };
}

export function setProfile(env: OpEnv, profile: { nickname?: unknown; color?: unknown }): OpOutcome {
  const denied = gate("set-profile", env);
  if (denied) return denied;
  const seat = seatOf(env.record, env.principalId) as Seat;
  let nickname = seat.nickname;
  if (profile.nickname !== undefined) {
    nickname = cleanNickname(profile.nickname);
    if (nickname === "") return refused("bad-frame", "A name is 1 to 24 characters.");
  }
  let color = seat.color;
  if (profile.color !== undefined) {
    if (profile.color !== null && !(SEAT_COLORS as readonly unknown[]).includes(profile.color)) return refused("bad-frame", "That is not a seat colour.");
    color = profile.color as string | null;
    /* #1337: first write wins -- a colour another seat holds is refused. */
    if (color !== null && env.record.seats.some((entry) => entry.player_id !== seat.player_id && entry.color === color)) {
      return refused("color-taken", "Another player has that colour.");
    }
  }
  if (nickname === seat.nickname && color === seat.color) return { ok: true, record: null };
  return {
    ok: true,
    record: next(env.record, env.now, (draft) => {
      const target = draft.seats.find((entry) => entry.player_id === seat.player_id) as Seat;
      target.nickname = nickname;
      target.color = color;
    }),
  };
}

/* ---------------------------------------------------------------------------
    THE HOST'S (#16, #17, #23, #24, #28)
   --------------------------------------------------------------------------- */

/** #16: to private rotates the code (the published one dies), admits the seated, and drops every other viewer. */
export function setVisibility(env: OpEnv, visibility: Visibility, freshCode: string): OpOutcome {
  const denied = gate("set-visibility", env);
  if (denied) return denied;
  if (env.record.visibility === visibility) return { ok: true, record: null };
  if (visibility === "public") {
    return { ok: true, record: next(env.record, env.now, (draft) => void (draft.visibility = "public")) };
  }
  const old = env.record.join_code;
  const record = next(env.record, env.now, (draft) => {
    draft.visibility = "private";
    draft.join_code = freshCode;
    const seated = new Set(draft.seats.map((seat) => seat.principal_id));
    draft.admitted = draft.seats.map((seat) => ({ principal_id: seat.principal_id, admitted_at: env.now, via: "creator" as const }));
    draft.admitted = draft.admitted.filter((entry) => seated.has(entry.principal_id));
  });
  return { ok: true, record, effects: { claimCode: freshCode, ...(old !== null ? { releaseCode: old } : {}) } };
}

/** #17: a new code; the old one dies at once; unseated admissions are purged. */
export function rotateCode(env: OpEnv, freshCode: string): OpOutcome {
  const denied = gate("rotate-code", env);
  if (denied) return denied;
  const old = env.record.join_code;
  const purged = env.record.admitted.filter((entry) => seatOf(env.record, entry.principal_id) === null).map((entry) => entry.principal_id);
  const record = next(env.record, env.now, (draft) => {
    draft.join_code = freshCode;
    draft.admitted = draft.admitted.filter((entry) => seatOf(draft, entry.principal_id) !== null);
  });
  return {
    ok: true,
    record,
    data: { code: freshCode },
    effects: { claimCode: freshCode, ...(old !== null ? { releaseCode: old } : {}), ...(record.visibility === "private" && purged.length > 0 ? { evicted: purged } : {}) },
  };
}

/** #23: the host removes a seat, waiting only; the principal can never come back to this table. */
export function kick(env: OpEnv, playerId: string): OpOutcome {
  const denied = gate("kick", env);
  if (denied) return denied;
  if (playerId === env.record.host_player_id) return refused("forbidden", "The host cannot remove the host's own seat.");
  const target = env.record.seats.find((seat) => seat.player_id === playerId);
  if (target === undefined) return { ok: true, record: null };
  const record = next(env.record, env.now, (draft) => {
    draft.seats = draft.seats.filter((seat) => seat.player_id !== playerId);
    draft.admitted = draft.admitted.filter((entry) => entry.principal_id !== target.principal_id);
    if (!draft.kicked_principals.includes(target.principal_id)) draft.kicked_principals.push(target.principal_id);
  });
  return { ok: true, record, effects: { evicted: [target.principal_id] } };
}

/** #24: the host role moves to another seated player; nothing else changes (the log never names the host). */
export function transferHost(env: OpEnv, toPlayerId: string): OpOutcome {
  const denied = gate("transfer-host", env);
  if (denied) return denied;
  if (toPlayerId === env.record.host_player_id) return { ok: true, record: null };
  if (!env.record.seats.some((seat) => seat.player_id === toPlayerId)) return refused("not-found", "That player is not seated at this table.");
  return { ok: true, record: next(env.record, env.now, (draft) => void (draft.host_player_id = toPlayerId)) };
}

/** #28: cancelled, the code released, everybody told the room is gone. */
export function cancelRoom(env: OpEnv): OpOutcome {
  const denied = gate("cancel-room", env);
  if (denied) return denied;
  const code = env.record.join_code;
  const record = next(env.record, env.now, (draft) => {
    draft.status = "cancelled";
    draft.cancelled_at = env.now;
    draft.join_code = null;
    draft.expires_at = null;
  });
  return { ok: true, record, effects: code === null ? {} : { releaseCode: code } };
}

/* ---------------------------------------------------------------------------
    START (§8): the roster source, the shuffle, the deal
   --------------------------------------------------------------------------- */

export interface StartPlan {
  /** The seats in turn order. */
  turnOrder: Seat[];
  variants: GameVariants;
}

export type StartRefusal = { refusal: "not-ready" | "wrong-state"; code: "need-players" | "need-ready" | "wrong-state"; reason: string };

/** Where the roster comes from. No-money rooms: the authoritative seats. ESCROW-3 plugs an escrow roster in here
 *  (verified chain seats, their payout addresses) without touching `start-game`'s authority. */
export interface RosterSource {
  plan(record: GameRecord, ctx: { shuffle: <T>(items: readonly T[]) => T[]; now: number }): Promise<StartPlan | StartRefusal>;
}

/** The waiting room's own conditions (`sandboxRoom.ts` `waitingRoomBlock`), in its order and its words. */
export function waitingBlock(record: GameRecord): StartRefusal | null {
  const needed = record.exact_players !== null && record.exact_players >= MIN_PLAYERS ? Math.min(record.exact_players, record.seat_cap) : MIN_PLAYERS;
  if (record.seats.length < needed) {
    return {
      refusal: "not-ready",
      code: "need-players",
      reason:
        needed > MIN_PLAYERS
          ? `Waiting for more players — the host set this table for exactly ${needed}.`
          : `Waiting for more players — Project 18XX needs at least ${MIN_PLAYERS}.`,
    };
  }
  if (!record.seats.every((seat) => seat.ready)) {
    return { refusal: "not-ready", code: "need-ready", reason: "Waiting for the other players to mark themselves ready." };
  }
  return null;
}

export class NoMoneyRosterSource implements RosterSource {
  async plan(record: GameRecord, ctx: { shuffle: <T>(items: readonly T[]) => T[] }): Promise<StartPlan | StartRefusal> {
    if (record.money !== null) return { refusal: "wrong-state", code: "wrong-state", reason: "This table is not a no-money table." };
    const blocked = waitingBlock(record);
    if (blocked !== null) return blocked;
    if (record.exact_players !== null && record.seats.length !== record.exact_players) {
      return { refusal: "not-ready", code: "need-players", reason: `Waiting for more players — the host set this table for exactly ${record.exact_players}.` };
    }
    if (record.seats.length > maxPlayersFor(record.variants)) {
      return { refusal: "not-ready", code: "need-players", reason: "There are more players seated than this map takes." };
    }
    return { turnOrder: ctx.shuffle(record.seats), variants: record.variants };
  }
}

/** Fisher-Yates with `crypto.randomInt` -- never `Math.random`. `random(max)` is injectable for tests. */
export function cryptoShuffle<T>(items: readonly T[], random: (max: number) => number = (max) => randomInt(max)): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The deal, in exactly the shape the client builds today (`App.tsx`: `{players, variants: {...variants, rules},
 *  build}`), with the seats' server-minted ids. The rules-engine version is stamped by `normalizeForCommit`. */
export function buildSetupGame(plan: StartPlan, build: string): SetupGameMsg {
  return {
    SetupGame: {
      players: plan.turnOrder.map((seat) => ({ id: seat.player_id, nickname: seat.nickname, ...(seat.color !== null ? { color: seat.color } : {}) })),
      variants: { ...plan.variants, rules: CURRENT_RULES_REVISION },
      build,
    },
  };
}

/** §8.2 step 7: a deal that breaks one of these is a server bug, never a client error. */
export function assertDeal(record: GameRecord, deal: SetupGameMsg): void {
  const players = deal.SetupGame.players;
  const ids = players.map((player) => player.id);
  if (players.length < MIN_PLAYERS || players.length > maxPlayersFor(record.variants)) throw new Error("the deal's roster size is not legal");
  if (new Set(ids).size !== ids.length) throw new Error("the deal names a player twice");
  if (!ids.every((id) => record.seats.some((seat) => seat.player_id === id))) throw new Error("the deal names a player who holds no seat");
  /* Each player exactly as its seat holds it -- the seat's own cleaned name, never re-cleaned here (review M2). */
  for (const player of players) {
    const seat = record.seats.find((entry) => entry.player_id === player.id);
    if (seat === undefined || player.nickname !== seat.nickname || player.nickname === "") {
      throw new Error("the deal carries a name that is not its seat's");
    }
  }
}
