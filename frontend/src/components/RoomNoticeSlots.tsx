// frontend/src/components/RoomNoticeSlots.tsx
//
/* PHASE 3 W3-C (AUD-14.01): the room strip's two notice slots, drawn from the two-slot model (`roomNotices.ts`) --
   the link's notice (with its kind) and the last refusal of this tab's own action. Each is drawn once, and neither
   repeats the room's standing hold notice (LIVE-3C), which the strip shows on its own line. */

import React from "react";

import { styles } from "../styles/appStyles";
import { standingConnections, type RoomNotices } from "../utils/roomNotices";

/* PHASE 3 W3-J (AUD-25.13, W3-C one-slot NIT): every standing connection notice is drawn -- one per kind, in the
   model's reading order -- so a paused room's notice is no longer replaced by the reconnecting banner. */
export function RoomNoticeSlots({ notices, holdNotice }: { notices: RoomNotices; holdNotice: string | null }) {
  const connections = standingConnections(notices).filter((entry) => entry.text !== holdNotice);
  const refusal =
    notices.refusal !== null && notices.refusal !== holdNotice && !connections.some((entry) => entry.text === notices.refusal)
      ? notices.refusal
      : null;
  return (
    <>
      {connections.map((entry) => (
        <span key={entry.kind} style={styles.roomStripError} data-testid="room-connection-notice" data-kind={entry.kind}>
          {entry.text}
        </span>
      ))}
      {refusal && (
        <span style={styles.roomStripError} data-testid="room-refusal-notice">
          {refusal}
        </span>
      )}
    </>
  );
}

export default RoomNoticeSlots;
