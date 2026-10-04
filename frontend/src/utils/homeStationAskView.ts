// frontend/src/utils/homeStationAskView.ts
//
// Whose screen gets the home-station FORM, as opposed to the waiting card.
//
// ==================================================================
//  PHASE 3 W1-J (AUD-06.03 / A-2): A WATCHER IS NEVER THE PRESIDENT
// ==================================================================
//
// THE PROP USED TO HAVE AN ESCAPE ARM. `App.tsx` passed
//
//     !pendingHomeToken?.president || !viewerAddress || pendingHomeToken.president === viewerAddress
//
// to `HomeStationPrompt`'s `viewerIsPresident`. The `!viewerAddress` arm was written for hotseat, where one screen
// IS the president's (#783). Hotseat is gone (#578) -- and in a room a seatless watcher's `viewerAddress` is `""`
// (LIVE-2D: `localId` is learned from the server's RoomView and is empty for a watcher), which is falsy. So the arm
// that meant "hotseat" came to mean "watcher", and a watching tab was handed the President's Place Home Station
// form. The spectate mode had no gate at all.
//
// ONE RULE, NO ESCAPE ARMS: a viewer gets the form only when it is not spectating AND the board names a president
// AND that president is this viewer. Every other viewer -- a seatless watcher, a spectator, a tab that has not yet
// learned its seat, a board that names no president -- gets the waiting card, which is the safe direction: the
// waiting card offers no control, and the President's own client still has the form.

export interface HomeStationAskInput {
  /** `mode === "spectate"`: a read-only viewer, whatever address its wallet holds. */
  spectator: boolean;
  /** The president the board says owes the home station (`PendingHomeToken.president`). */
  president: string | null | undefined;
  /** This tab's in-game id: the room seat in a room (`""` for a watcher), the wallet address on the chain path. */
  viewerAddress: string | null | undefined;
}

/** True only for the President's own, non-spectating screen. */
export function homeStationViewerIsPresident({ spectator, president, viewerAddress }: HomeStationAskInput): boolean {
  if (spectator) return false;
  /* No president on the board, or no seat on this tab: nobody here can be asked. `""` is a watcher's id, so it is
     excluded by the same test rather than by a separate falsy arm. */
  if (typeof president !== "string" || president.length === 0) return false;
  return president === viewerAddress;
}
