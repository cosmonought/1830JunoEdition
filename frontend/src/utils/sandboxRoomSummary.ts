// frontend/src/utils/sandboxRoomSummary.ts -- design note #1415.
//
// THE PURE HALF OF THE ROOM'S TERMS: what the host chose before the table existed (`RoomSetup`), and the readers
// the waiting room uses to say how many seats the table takes and needs. Nothing here touches a window, a socket or
// storage. LIVE-2D: the legacy summary (`summariseSandboxRoom`) and the server's normalisers went with the room
// document -- the server builds `RoomSummary` from its GameRecord (`roomProtocol.ts`).

import type { GameVariants } from "../gameEngine/gameVariants";
import { maxPlayersFor } from "../gameEngine/gameSetup";

export type RoomVisibility = "public" | "private";

/** What the host chose before the room existed (#1415). */
export interface RoomSetup {
  visibility: RoomVisibility;
  /** `null`: any number from two up to the board's seats. A number: exactly that many. */
  playerCount: number | null;
  /** The stake each seat would make, as a digit string. LIVE-2 opens no-money tables only: anything but "0" is refused
   *  by the server (`money-games-disabled`). */
  anteUjuno: string;
}

export const DEFAULT_ROOM_SETUP: RoomSetup = { visibility: "public", playerCount: null, anteUjuno: "0" };

/** The fields these readers need -- a structural subset of `RoomView`. */
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
