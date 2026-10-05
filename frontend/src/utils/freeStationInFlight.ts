// frontend/src/utils/freeStationInFlight.ts
//
/* ==================================================================
    PHASE 3 W3-J (AUD-25.04): THE FREE STATION WAITS FOR ITS ANSWER, AND A REFUSED ONE SPENDS NOTHING
   ==================================================================
   The free placements -- the home station and the D&H's station -- go out through `commitFreeStationPlacement`
   (`PlaceHomeStation`, sent `automatic`, so the shell's latch never arms for it). That committer neither waited for the
   room's answer nor took anything back:
     - a REFUSED D&H station left `dh-token` in the shell's fallback set, so the power read as used and the flow modal
       never asked again;
     - the home station's errand is cleared at the press, and the prompt's mount is `homeStationPlacement ? null :
       pendingHomeToken` -- so for the whole round trip (and any link outage, while the submission is queued) the board
       still owed the token and the President was asked AGAIN, inviting a second `PlaceHomeStation`.

   ONE MARKER, THE ROOM'S ANSWER, AND THE BOARD. The press records which corporation's free placement is in flight. The
   room's per-action answer (`runGameplayAction`'s room branch, P3-N020) settles it:
     - `false` -- not applied (refused, stale, dropped, or one of the client's own gates): the marker is released and
       the press's shell writes are taken back (`submissionRefused`);
     - `true`  -- applied: the marker HOLDS until the board itself stops owing that corporation's home token (the drain
       brings the entry). Released on the answer alone, the prompt would flash back for the frames between the
       acknowledgement and the entry -- an accepted placement is never treated as unanswered;
     - anything else (`undefined`: the solo sandbox, which applied inside the click) -- nothing is in flight.
   Nothing here judges legality: the refusal is the server's, and its sentence is in the strip. */

import { submissionRefused } from "./submissionAnswer";

export interface FreeStationInFlight {
  /** The corporation whose free placement was sent. */
  companyId: number;
  kind: "home-station" | "private-station";
}

export type FreeStationSettlement = "refused" | "hold" | "release";

/** What the room's answer does to a free placement in flight. */
export function freeStationSettlement(answer: unknown): FreeStationSettlement {
  if (submissionRefused(answer)) return "refused";
  return answer === true ? "hold" : "release";
}

/** Whether the board has released an applied placement: a home station is done once the board no longer owes THAT
 *  corporation's home token. A D&H station holds no marker past its answer (its fact is `usedPrivateAbilities`). */
export function inFlightReleasedByBoard(
  inFlight: FreeStationInFlight | null,
  owed: { companyId: number } | null,
): boolean {
  if (inFlight === null) return false;
  if (inFlight.kind !== "home-station") return true;
  return owed === null || owed.companyId !== inFlight.companyId;
}

/** The home prompt's `pending`: nothing while the errand is armed (the map is the question then) or while that
 *  corporation's placement is in flight; otherwise the board's debt, exactly as before. */
export function homePromptPending<T extends { companyId: number }>(
  owed: T | null,
  errandArmed: boolean,
  inFlight: FreeStationInFlight | null,
): T | null {
  if (owed === null || errandArmed) return null;
  if (inFlight !== null && inFlight.kind === "home-station" && inFlight.companyId === owed.companyId) return null;
  return owed;
}
