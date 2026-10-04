// frontend/src/components/RoomNoticeSlots.tsx
//
/* PHASE 3 W3-C (AUD-14.01): the room strip's two notice slots, drawn from the two-slot model (`roomNotices.ts`) --
   the link's notice (with its kind) and the last refusal of this tab's own action. Each is drawn once, and neither
   repeats the room's standing hold notice (LIVE-3C), which the strip shows on its own line. */

import React from "react";

import { styles } from "../styles/appStyles";
import type { RoomNotices } from "../utils/roomNotices";

export function RoomNoticeSlots({ notices, holdNotice }: { notices: RoomNotices; holdNotice: string | null }) {
  const connection = notices.connection && notices.connection.text !== holdNotice ? notices.connection : null;
  const refusal = notices.refusal !== null && notices.refusal !== holdNotice && notices.refusal !== connection?.text ? notices.refusal : null;
  return (
    <>
      {connection && (
        <span style={styles.roomStripError} data-testid="room-connection-notice" data-kind={connection.kind}>
          {connection.text}
        </span>
      )}
      {refusal && (
        <span style={styles.roomStripError} data-testid="room-refusal-notice">
          {refusal}
        </span>
      )}
    </>
  );
}

export default RoomNoticeSlots;
