// frontend/src/utils/sandboxRoomSummary.ts -- design note #1415.
//
// THE PURE HALF OF THE ROOM'S TERMS, in a module of its own so the server can import it as a value. `sandboxRoom.ts`
// re-exports everything here and is the file callers on the client keep importing; but it also imports the socket
// (`roomDocLink`) and the seat identity, and the server -- which needs `roomSeatCap` to refuse a seventh joiner and
// `summariseSandboxRoom` to build the public list -- imports that file as TYPES ONLY, on purpose. Nothing here
// touches a window, a socket or storage.

import type { GameVariants } from "../gameEngine/gameVariants";
import { maxPlayersFor } from "../gameEngine/gameSetup";

export type RoomVisibility = "public" | "private";

/** The status a room document carries; mirrored from `SandboxRoomDoc` so this module owes it nothing. */
export type SandboxRoomStatusLike = "waiting" | "playing";

/** What the host chose before the room existed (#1415). */
export interface RoomSetup {
  visibility: RoomVisibility;
  /** `null`: any number from two up to the board's seats. A number: exactly that many. */
  playerCount: number | null;
  /** The deposit each seat makes on Ready, in ujuno, as a digit string. "0" until the wallet is wired. */
  anteUjuno: string;
}

export const DEFAULT_ROOM_SETUP: RoomSetup = { visibility: "public", playerCount: null, anteUjuno: "0" };

/** The fields these readers need -- a structural subset of `SandboxRoomDoc`. */
export interface RoomTermsLike {
  visibility?: RoomVisibility;
  playerCount?: number | null;
  variants: GameVariants;
}

export function roomVisibility(room: Pick<RoomTermsLike, "visibility"> | null | undefined): RoomVisibility {
  return room?.visibility === "private" ? "private" : "public";
}

const MAX_PLAYERS_FALLBACK = 6;

/** How many seats this room will take: the host's exact count, else the board's maximum. */
export function roomSeatCap(room: Pick<RoomTermsLike, "playerCount" | "variants"> | null | undefined): number {
  if (!room) return MAX_PLAYERS_FALLBACK;
  const exact = room.playerCount;
  const boardMax = maxPlayersFor(room.variants);
  if (typeof exact === "number" && Number.isFinite(exact) && exact >= 2) return Math.min(exact, boardMax);
  return boardMax;
}

/** #1415: how many seats must be filled before this room may start -- the host's exact count, else the
 *  game's minimum. The number the start gate and the guest's line both read. */
export function seatsNeeded(
  room: Pick<RoomTermsLike, "playerCount" | "variants"> | null | undefined,
  minPlayers: number,
): number {
  const exact = room?.playerCount;
  if (typeof exact === "number" && Number.isFinite(exact) && exact >= minPlayers) return roomSeatCap(room);
  return minPlayers;
}

/** A valid exact player count for these variants, or `null` for "any". Untrusted input goes through here. */
export function normalisePlayerCount(raw: unknown, variants: GameVariants): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < 2 || raw > maxPlayersFor(variants)) return null;
  return raw;
}

/** A digit string, or "0". The ante is carried as text so no client ever rounds it. */
export function normaliseAnte(raw: unknown): string {
  return typeof raw === "string" && /^\d{1,30}$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : "0";
}

/** The public-list summary of a room, as the server broadcasts it (#1415). Summaries only: the roster's names
 *  and readiness, the cap, the variants, the ante -- what a card shows and nothing a seat would rather keep. */
export interface SandboxRoomSummary {
  code: string;
  status: SandboxRoomStatusLike;
  hostNickname: string;
  players: ReadonlyArray<{ id: string; nickname: string; isReady: boolean }>;
  seatCap: number;
  playerCount: number | null;
  variants: GameVariants;
  anteUjuno: string;
  createdAtMs: number;
}

export function summariseSandboxRoom(room: {
  code: string;
  status: SandboxRoomStatusLike;
  hostId: string;
  players: ReadonlyArray<{ id: string; nickname: string; isReady: boolean }>;
  variants: GameVariants;
  playerCount?: number | null;
  anteUjuno?: string;
  createdAtMs?: number;
}): SandboxRoomSummary {
  return {
    code: room.code,
    status: room.status,
    hostNickname: room.players.find((player) => player.id === room.hostId)?.nickname ?? "Host",
    players: room.players.map((player) => ({ id: player.id, nickname: player.nickname, isReady: player.isReady })),
    seatCap: roomSeatCap(room),
    playerCount: room.playerCount ?? null,
    variants: room.variants,
    anteUjuno: room.anteUjuno ?? "0",
    createdAtMs: room.createdAtMs ?? 0,
  };
}
