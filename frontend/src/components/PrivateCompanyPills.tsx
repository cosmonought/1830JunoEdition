// frontend/src/components/PrivateCompanyPills.tsx
//
// ==================================================================
//  DESIGN NOTE 423 (UI half): NAMED PILLS, NOT NUMBERED CHIPS
// ==================================================================
//
// REPORTED: replace the generic numerical chips for private companies with
// named acronym pills, laid out horizontally so row height is preserved,
// and make them clickable to reveal their full rules text inline. Wanted in
// both the auction's seating table and the Ledger's Player Assets table.
//
// See `privateCatalog.ts` design note #423 for why `1`..`6` was never the
// company's identity. This is the component both tables render.
//
// ==================================================================
//  WHY ONE COMPONENT FOR TWO TABLES
// ==================================================================
//
// The two surfaces had independently-grown chip renderers -- the auction's
// `seatingPrivateChip` and the Ledger's `holdingChipPrivate` -- which is how
// they came to disagree about what a private looks like in the first place
// (one showed a number, the other a full name and a revenue figure). A
// third hand-rolled pill would have been the third opinion.
//
// So the pill, its expansion, its state and its keyboard handling live here
// once. The two callers differ only in `surface`, because one sits on the
// auction's dark card and the other on the Ledger's dark table, and they
// have different neighbours to contrast against.
//
// ==================================================================
//  ROW HEIGHT IS THE CONSTRAINT, AND IT IS WHY EXPANSION GOES BELOW
// ==================================================================
//
// The requirement names it: horizontal, to preserve row height. Both tables
// are dense, and both have already been bitten by a cell that grows -- the
// auction's `seatingPrivates` carries a fixed `0 0 128px` basis precisely so
// a player winning their first private cannot shove the columns sideways
// (design note #341), and design note #323 reserves the turn slot for the
// same reason.
//
// So the pills never wrap and never grow: they scroll horizontally within
// their cell if a player somehow holds more than fits. The rules text opens
// BELOW the pill row rather than beside it, where it can take the height it
// needs without moving any neighbouring column.
//
// ONE OPEN AT A TIME, per component instance. Two open panels in a table row
// is a row that has become a paragraph, and the question a player asks here
// is about one company at a time.
//
// ==================================================================
//  A BUTTON, NOT A DIV WITH AN ONCLICK
// ==================================================================
//
// These are interactive and they are in a table, which is exactly the
// combination where a `div` with a click handler becomes unreachable by
// keyboard and invisible to a screen reader. `<button>` gets focus, Enter
// and Space for free, and `aria-expanded` tells a reader what the press
// will do. The `title` stays for the hover case, but it is no longer the
// only way to get the information -- which was the real limitation of the
// chips this replaces: their full name lived exclusively in a tooltip.

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
          /* Design note #423: `null` for an id outside the six, and the
             pill then falls back to the full NAME rather than to the
             number this component exists to remove. An unrecognised
             private is a data problem; showing its name is the most
             useful thing to do about it and the least likely to be
             mistaken for a working acronym. */
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
  /* HORIZONTAL AND NON-WRAPPING, which is the requirement's own phrasing
     and the reason the cell's height is stable. `overflowX: auto` rather
     than `hidden`: a player holding more privates than the cell can show
     must still be able to reach them, and a scrollbar in a 128px cell is a
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
