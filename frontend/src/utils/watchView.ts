// frontend/src/utils/watchView.ts
//
/* ==================================================================
    PHASE 3 W3-J (OD-19 RULED, AUD-25.16): THE WATCH TAB'S ROOM VIEW IS A WATCHER'S
   ==================================================================
   The server's RoomView is computed for the signed-in PRINCIPAL (`roomViewFor`): a principal seated at the table is
   `player` (or `host`) with its `playerId`, whichever Lobby door opened the tab. OD-19: "Watch always opens a READ-ONLY
   spectator view, even when the signed-in user already has a seat in that game; Watch must not silently treat the
   viewer as their seated player." So a Watch tab reads the view as a watcher's -- no seat, no host role, no Start, no
   money actions -- and every surface downstream (`localId`, the waiting room, the host control, the settlement band,
   the turn and prompt gates) sees exactly what a principal with no seat would see. Nothing the room SAYS is changed:
   the roster, the lifecycle, the holds and the table's money status are the server's. */

import type { RoomView } from "./roomProtocol";

/** The view a Watch tab presents: the room as the server sent it, with `you` a watcher's. */
export function watcherRoomView(view: RoomView | null): RoomView | null {
  if (view === null) return null;
  return {
    ...view,
    you: { role: "viewer", playerId: null, kicked: false, canStart: false },
    ...(view.money !== undefined ? { money: { ...view.money, you: null } } : {}),
  };
}
