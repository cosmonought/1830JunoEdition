// frontend/src/components/MyTablesList.tsx
//
/* ==================================================================
    LIVE-2F/3D (C9-01): "YOUR TABLES" -- THE WAY BACK TO A SEAT
   ==================================================================
   A seat belongs to the profile, not to the tab: recovery, a linked device and a new browser all restore the same
   principal, and the server keeps every seat. What a browser did NOT keep was a way to reach one -- the only pointer is
   the tab's own `sessionStorage`, a private table's code is released at the deal, and private tables are never in the
   public list. So a player who closed the tab (or pressed "← Lobby", signed out and in, or recovered onto a new
   browser) had a seat nothing on screen could open. This list is the server's answer to "which tables am I seated
   at?" (`room-op {type:"my-tables"}`), and each row opens its table exactly as Host, Join and Watch do: by game id,
   through `onEnterSandbox` -- the server authorizes the open against the record, as it does any other.
   Hidden when there is nothing to show: a player with no tables sees the lobby exactly as before. */

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { INK_TEXT, INK_TEXT_FAINT, INK_TEXT_MUTED } from "../styles/palette";
import { myTableLabel, type MyTableSummary } from "../utils/roomProtocol";

export interface MyTablesListProps {
  tables: MyTableSummary[];
  error: string | null;
  onOpen: (gameId: string) => void;
}

/** The row's name: the host's table, and who else sits there. */
export function myTableTitle(table: MyTableSummary): string {
  const host = table.hostNickname.trim() || "A table";
  const others = table.nicknames.filter((name) => name !== table.hostNickname);
  const who = table.you === "host" ? "Your table" : `${host}'s table`;
  return others.length === 0 ? who : `${who} · with ${others.join(", ")}`;
}

export function MyTablesList({ tables, error, onOpen }: MyTablesListProps) {
  if (tables.length === 0 && error === null) return null;
  return (
    <section style={styles.section} aria-label="Your tables" data-testid="my-tables">
      <div style={styles.head}>
        <h2 style={styles.heading}>Your tables</h2>
        {tables.length > 0 && <span style={styles.count}>{tables.length}</span>}
      </div>
      {error !== null && <p style={styles.warning}>{error}</p>}
      {tables.length > 0 && (
        <ul style={styles.list}>
          {tables.map((table) => {
            const label = myTableLabel(table.state);
            return (
              <li key={table.gameId} style={styles.row} data-testid="my-table-row">
                <div style={styles.main}>
                  <span style={styles.name}>{myTableTitle(table)}</span>
                  <span style={styles.meta}>
                    {label.status} · {table.visibility === "private" ? "Private" : "Public"}
                  </span>
                </div>
                <button type="button" style={styles.button} onClick={() => onOpen(table.gameId)}>
                  {label.action}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: { display: "flex", flexDirection: "column", gap: "10px", width: "100%", minWidth: 0 },
  head: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "8px 12px" },
  heading: { margin: 0, fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.01em", color: INK_TEXT },
  count: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: INK_TEXT_MUTED,
    padding: "1px 8px",
    borderRadius: RADIUS.pill,
    border: "1px solid #2a2a2a",
  },
  warning: { margin: 0, fontSize: FONT_SIZE.small, color: "#e0b062", lineHeight: 1.5 },
  list: { listStyle: "none", margin: 0, padding: 0, minWidth: 0 },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "9px 0",
    borderBottom: "1px solid #1d1d1a",
    minWidth: 0,
  },
  main: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  name: { fontSize: FONT_SIZE.body, fontWeight: 800, color: INK_TEXT, overflowWrap: "anywhere" },
  meta: { fontSize: FONT_SIZE.micro, color: INK_TEXT_FAINT, overflowWrap: "anywhere" },
  button: {
    padding: "6px 15px",
    borderRadius: RADIUS.control,
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
};
