// frontend/src/components/BoardBehindNotice.tsx
//
/* ==================================================================
    PHASE 3 W3-J (AUD-25.16, OD-19): A BOARD THAT IS NOT THE ROOM'S IS NOT OFFERED AS LIVE
   ==================================================================
   OD-19: "while replay, catch-up or divergence is unresolved, gameplay controls are non-actionable; a stale local view
   of whose turn it is must not enable a move." When the shell knows its board is not the room's -- a drain pass threw
   part-way through what the room sent, or the settle point's digest comparison disagrees (`boardCurrency.ts`) -- this
   forced notice covers the table. It is a native modal dialog, so everything behind it is inert: no bar control, no
   prompt, no offer form and no board click can be reached while it stands. It does not close on Escape or the scrim;
   its one remedy is the one that works, because the log is the game (#522): a reload replays the room's history from
   the start. "Back to the lobby" is the other way out. It goes the moment the board is current again (a later settle
   that agrees).
   The shell's send gate and the room link refuse a move from such a board as well -- this is the surface, not the
   guarantee. */

import React from "react";

import { NativeModal } from "./NativeModal";
import { profileStyles as styles } from "./profileStyles";

export interface BoardBehindNoticeProps {
  /** The reason, from `boardCurrencyFor` -- `null` renders nothing. */
  notice: string | null;
  onReload: () => void;
  onLeave: () => void;
}

const { zIndex: _ignored, ...scrim } = styles.overlay as React.CSSProperties & { zIndex?: unknown };

export function BoardBehindNotice({ notice, onReload, onLeave }: BoardBehindNoticeProps) {
  if (notice === null) return null;
  return (
    <NativeModal
      labelledBy="board-behind-title"
      describedBy="board-behind-text"
      alert
      dismissible={false}
      restoreOpener={false}
      scrimStyle={{ ...scrim, display: "flex" }}
      testId="board-behind-notice"
    >
      <div style={{ ...styles.card, maxWidth: "460px" }}>
        <h2 id="board-behind-title" style={styles.heading}>
          This board is not live
        </h2>
        <p id="board-behind-text" style={styles.text}>
          {notice}
        </p>
        <div style={styles.row}>
          <button type="button" onClick={onReload} style={styles.primary} data-testid="board-behind-reload" autoFocus>
            Reload
          </button>
          <button type="button" onClick={onLeave} style={styles.secondary} data-testid="board-behind-lobby">
            Back to the lobby
          </button>
        </div>
      </div>
    </NativeModal>
  );
}

export default BoardBehindNotice;
