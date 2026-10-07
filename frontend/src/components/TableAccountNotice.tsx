// frontend/src/components/TableAccountNotice.tsx
//
// ==================================================================
//  PHASE 3 FINAL (§9): "THIS BROWSER IS NOW SIGNED IN AS ..." -- ASKED, NEVER ASSUMED
// ==================================================================
//
// The open table's account changed under it (another tab of this browser signed in, out, or recovered an account --
// `utils/tableAccountGuard.ts`). A forced notice, a native modal so the table behind it is inert, with exactly two ways
// on: continue as the account the browser has now (the table is then that account's: its seat, or a watcher's view) or
// go back to the lobby. It never closes by itself, on Escape or on the scrim: the player chooses who they are playing as.
// Switching Keplr accounts never brings this up -- a wallet is not who anyone is.

import React from "react";

import type { TableAccountChange } from "../utils/tableAccountGuard";
import { NativeModal } from "./NativeModal";
import { profileStyles as styles } from "./profileStyles";

export interface TableAccountNoticeProps {
  /** The change, from `useTableAccountGuard` -- `null` renders nothing. */
  change: TableAccountChange | null;
  onContinue: () => void;
  onLeave: () => void;
}

const { zIndex: _ignored, ...scrim } = styles.overlay as React.CSSProperties & { zIndex?: unknown };

/** The notice's sentence (exported for tests). */
export function tableAccountSentence(change: TableAccountChange): string {
  const opened = change.from === null ? "This table was opened while signed out" : `This table was opened as ${change.from}`;
  const now = change.to === null ? "this browser is now signed out (another tab signed out)" : `this browser is now signed in as ${change.to} (another tab changed account)`;
  const seat = change.to === null ? "You can keep watching signed out, or go back to the lobby." : `Continue to see this table as ${change.to} — their seat if they have one — or go back to the lobby.`;
  return `${opened}, but ${now}. Nothing was sent as either account. ${seat}`;
}

export function TableAccountNotice({ change, onContinue, onLeave }: TableAccountNoticeProps) {
  if (change === null) return null;
  return (
    <NativeModal
      labelledBy="table-account-title"
      describedBy="table-account-text"
      alert
      dismissible={false}
      restoreOpener={false}
      scrimStyle={{ ...scrim, display: "flex" }}
      testId="table-account-notice"
    >
      <div style={{ ...styles.card, maxWidth: "480px" }}>
        <h2 id="table-account-title" style={styles.heading}>
          {change.to === null ? "You signed out in another tab" : `You're now signed in as ${change.to}`}
        </h2>
        <p id="table-account-text" style={styles.text}>
          {tableAccountSentence(change)}
        </p>
        <div style={styles.row}>
          <button type="button" onClick={onContinue} style={styles.primary} data-testid="table-account-continue" autoFocus>
            {change.to === null ? "Keep watching" : `Continue as ${change.to}`}
          </button>
          <button type="button" onClick={onLeave} style={styles.secondary} data-testid="table-account-lobby">
            Back to the lobby
          </button>
        </div>
      </div>
    </NativeModal>
  );
}

export default TableAccountNotice;
