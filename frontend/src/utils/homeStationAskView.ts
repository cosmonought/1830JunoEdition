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

import { viewerIsNamedActor } from "./waitingPromptView";

export interface HomeStationAskInput {
  /** `mode === "spectate"`: a read-only viewer, whatever address its wallet holds. */
  spectator: boolean;
  /** The president the board says owes the home station (`PendingHomeToken.president`). */
  president: string | null | undefined;
  /** This tab's in-game id: the room seat in a room (`""` for a watcher), the wallet address on the chain path. */
  viewerAddress: string | null | undefined;
}

/** True only for the President's own, non-spectating screen.
 *
 *  Phase 3 W2-H: the rule itself moved to `waitingPromptView.ts`, so the home station, the B&O par and the
 *  auction handoff -- and later the emergency purchase -- ask ONE viewer policy rather than three copies of it.
 *  The rule is unchanged: not spectating, a named president, and that president is this viewer. */
export function homeStationViewerIsPresident({ spectator, president, viewerAddress }: HomeStationAskInput): boolean {
  return viewerIsNamedActor({ spectator, actor: president, viewerAddress });
}
