// Design note #423 (UI half): named acronym pills for private companies,
// clickable to reveal their rules text, shared by the auction's seating table
// and the Ledger's Player Assets table.
//
// ONE component for both, because two independently-grown chip renderers are how
// the two surfaces came to disagree about what a private looks like. Row height
// is the constraint: pills never wrap and never grow, and the rules text opens
// BELOW the row rather than beside it. One open at a time per instance.
//
// A `<button>`, not a div with an onClick -- interactive elements inside a table
// are exactly where that becomes keyboard-unreachable and screen-reader
// invisible, and `aria-expanded` says what the press will do.
//
// See docs/ai_architecture/contract_economy.md, PrivateCompanyPills.tsx #423.

import React, { useState } from "react";

import { FONT_SIZE } from "../styles/typography";
import { PRIVATE_COMPANY_CATALOG, privateAcronym } from "../utils/privateCatalog";

/** The shape both tables already hold -- a subset of `PrivateCompanyState`,
 *  narrowed so a caller does not have to pass fields this never reads. */
export interface PrivatePillCompany {
  private_id: number;
  name: string;
  revenue_per_or: string;
}

export interface PrivateCompanyPillsProps {
  privates: readonly PrivatePillCompany[];
  /** Which dark surface these sit on. Only the pill's resting fill and
   *  border differ; the open panel is the same on both. */
  surface?: "card" | "table";
  /** Rendered when the player or corporation holds none. */
  emptyLabel?: string;
}

export function PrivateCompanyPills({
  privates,
  surface = "card",
  emptyLabel = "none",
}: PrivateCompanyPillsProps) {
  const [openId, setOpenId] = useState<number | null>(null);

  if (privates.length === 0) {
    return <span style={styles.empty}>{emptyLabel}</span>;
  }

  const open = privates.find((priv) => priv.private_id === openId) ?? null;
  const openEntry = open ? PRIVATE_COMPANY_CATALOG[open.private_id] : undefined;

  return (
    <span style={styles.root}>
      <span style={styles.pillRow}>
        {privates.map((priv) => {
          /* Design note #423: `null` for an id outside the six, and the pill falls back to
             the full NAME rather than the number this component exists to remove. An
             unrecognised private is a data problem; its name is the most useful thing to
             show and the least likely to be mistaken for a working acronym. */
          const acronym = privateAcronym(priv.private_id) ?? priv.name;
          const isOpen = priv.private_id === openId;
          return (
            <button
              key={priv.private_id}
              type="button"
              aria-expanded={isOpen}
              style={{
                ...styles.pill,
                ...(surface === "table" ? styles.pillTable : styles.pillCard),
                ...(isOpen ? styles.pillOpen : {}),
              }}
              title={`${priv.name} — $${priv.revenue_per_or} per Operating Round. Click for its rules text.`}
              onClick={() => setOpenId(isOpen ? null : priv.private_id)}
            >
              {acronym}
            </button>
          );
        })}
      </span>

      {/* Opens BELOW the row, never beside it -- see the note above on why
          row height is the binding constraint here. */}
      {open && (
        <span style={styles.panel}>
          <span style={styles.panelHead}>
            <span style={styles.panelName}>{open.name}</span>
            <span style={styles.panelRevenue}>${open.revenue_per_or}/OR</span>
          </span>
          {/* The rulebook's own words -- `privateCatalog.ts` design note
              #360 is explicit that this text is a verbatim quotation, so it
              is rendered whole rather than truncated with an ellipsis. */}
          <span style={styles.panelAbility}>
            {openEntry?.ability ?? "No rules text on record for this private company."}
          </span>
        </span>
      )}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
  empty: { fontSize: FONT_SIZE.micro, color: "#5c626e" },
  /* Horizontal and non-wrapping, which is what keeps the cell's height stable.
     `overflowX: auto` rather than `hidden`: a player holding more privates than
     fits must still be able to reach them, and a scrollbar in a 128px cell is a
     better answer than a hidden asset. */
  pillRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "nowrap",
    gap: "3px",
    minWidth: 0,
    overflowX: "auto",
  },
  pill: {
    flexShrink: 0,
    padding: "1px 6px",
    borderRadius: "4px",
    borderWidth: "1px",
    borderStyle: "solid",
    font: "inherit",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    lineHeight: 1.6,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  pillCard: { backgroundColor: "#2a3142", borderColor: "#3a4055", color: "#c8cbd6" },
  pillTable: { backgroundColor: "#232a38", borderColor: "#39415280", color: "#c2c8d4" },
  /* The open pill reads as a pressed control rather than merely a
     highlighted one -- it is the thing the panel below belongs to, and
     with several pills in a row that link has to be unambiguous. */
  pillOpen: { backgroundColor: "#3a4661", borderColor: "#5b7099", color: "#ffffff" },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "6px 8px",
    borderRadius: "6px",
    border: "1px solid #39415280",
    backgroundColor: "#1a2029",
    maxWidth: "340px",
  },
  panelHead: { display: "flex", alignItems: "baseline", gap: "8px" },
  panelName: { fontSize: FONT_SIZE.micro, fontWeight: 800, color: "#e2e6ee" },
  panelRevenue: {
    marginLeft: "auto",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#7ee0a1",
    fontVariantNumeric: "tabular-nums",
  },
  panelAbility: {
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.5,
    color: "#9aa2b1",
    whiteSpace: "normal",
  },
};

export default PrivateCompanyPills;
