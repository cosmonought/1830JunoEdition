// frontend/src/components/AutoBuyModal.tsx
//
// Which corporations to buy into, and how far. See `autoBuy.ts` #1240 and its graduation #1333.
//
// Borrows `AutoPassModal`'s frame and rhythm (#717) for the reason that modal gives: this control acts on the
// player's behalf while they are not looking, so what it will do is put in front of them at the moment they
// arm it, every time. The list is the ROSTER rather than a fixed set of conditions, and each row says what the
// tool can see about that corporation right now -- your holding, what is on offer, and its own cap.
//
// Design note #1333 (10a): THE UNPARRED ARE NOT LISTED. A row that says "skipped until someone pars it" is a
// row the tool will never act on; a line under the list counts them instead. Each ticked row gets its own cap,
// seeded from the "up to" figure so one shared cap is still one click.

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { bestContrastTextColor, corporationLiveryColor } from "../styles/corporationLivery";
import { CorporateLogo } from "./CorporateLogo";
import {
  AUTO_BUY_CAPS,
  type AutoBuySettings,
  type AutoBuySourcePreference,
  type AutoBuyTarget,
} from "../utils/autoBuy";

export interface AutoBuyCorporationRow {
  companyId: number;
  ticker: string;
  /** This player's holding now, whole percent. */
  holdingPercent: number;
  /** `null` reads "not yet parred" -- hidden from the list, counted below it (#1333). */
  parValue: string | null;
  ipoPercent: number;
  bankPoolPercent: number;
  /** The pool price now, for the row's caption; `null` when unknown. */
  marketPrice: number | null;
}

export interface AutoBuyModalProps {
  open: boolean;
  corporations: readonly AutoBuyCorporationRow[];
  /** Last time's choices, so re-arming does not re-ask from scratch. */
  initial?: AutoBuySettings;
  onArm: (settings: AutoBuySettings) => void;
  onClose: () => void;
}

const SOURCE_LABELS: ReadonlyArray<{ value: AutoBuySourcePreference; label: string; title: string }> = [
  { value: "Ipo", label: "IPO", title: "From the IPO at par; the pool only when the IPO is empty." },
  { value: "Bank", label: "Bank pool", title: "From the bank pool at market; the IPO only when the pool is empty." },
  { value: "Cheapest", label: "Cheapest", title: "Whichever of the two is cheaper this turn; IPO on a tie." },
];

export function AutoBuyModal({ open, corporations, initial, onArm, onClose }: AutoBuyModalProps) {
  /* Order of ticking is order of preference (#1240), so an array rather than a set. */
  const [targets, setTargets] = useState<AutoBuyTarget[]>([...(initial?.targets ?? [])]);
  /* ==================================================================
      DESIGN NOTE 1383: NO SHARED CAP -- EACH ROW IS SET BY HAND
     ==================================================================
     RULED: "The global 'Buy up to %' should be removed. Players should set their purchases manually."
     #1333 seeded every ticked row from one shared figure so a single click set six caps at once; the table
     found that a cap it had not chosen per corporation was a cap it had not chosen. A newly ticked row now
     opens at the default and the player sets it on the row, which is the only place a cap lives. */
  const DEFAULT_CAP = 60;
  const [source, setSource] = useState<AutoBuySourcePreference>(initial?.source ?? "Ipo");
  const [stopOnPar, setStopOnPar] = useState(initial?.stopOnPar ?? true);
  const [stopOnSale, setStopOnSale] = useState(initial?.stopOnSale ?? true);

  if (!open) return null;

  const parred = corporations.filter((row) => row.parValue !== null);
  const unparredCount = corporations.length - parred.length;

  const toggle = (companyId: number, on: boolean) =>
    setTargets((current) =>
      on
        ? current.some((t) => t.companyId === companyId)
          ? current
          : [...current, { companyId, maxPercent: DEFAULT_CAP }]
        : current.filter((t) => t.companyId !== companyId),
    );
  const setCap = (companyId: number, maxPercent: number) =>
    setTargets((current) => current.map((t) => (t.companyId === companyId ? { ...t, maxPercent } : t)));

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Auto-Buy settings"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.heading}>Auto-Buy this Stock Round</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
            &#10006;
          </button>
        </div>

        <p style={styles.body}>
          On each of your turns this buys one share of the first ticked corporation you hold less than its cap
          in. When nothing qualifies it switches itself off and the turn is yours; it never passes for you. It
          also stops when the Stock Round ends.
        </p>

        {/* #1383: the shared "Buy up to" is gone; every cap is on its row. */}
        <div style={styles.capRow}>
          <span style={styles.rowLabel}>Buy from</span>
          <div style={styles.segment} role="radiogroup" aria-label="Source">
            {SOURCE_LABELS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={source === option.value}
                title={option.title}
                style={{ ...styles.segmentButton, ...(source === option.value ? styles.segmentButtonOn : {}) }}
                onClick={() => setSource(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.list}>
          {parred.map((row) => {
            const offer = [
              row.ipoPercent > 0 ? `${row.ipoPercent}% in IPO at $${row.parValue}` : null,
              row.bankPoolPercent > 0
                ? `${row.bankPoolPercent}% in pool${row.marketPrice !== null ? ` at $${row.marketPrice}` : ""}`
                : null,
            ]
              .filter((part): part is string => part !== null)
              .join(", ");
            const order = targets.findIndex((t) => t.companyId === row.companyId);
            const target = order >= 0 ? targets[order] : null;
            /* ==================================================================
                DESIGN NOTE 1384: THE ROW WEARS THE LIVERY, AND THE LIVERY FADES OUT
               ==================================================================
               ASKED: "the corporations need their herald. I think they could also have their corp color
               stripe, but have it fade to 0% around the 75% width point?" The herald sits where the ticker
               was, with the ticker beside it (#465's pairing); the row's ground is the livery running from
               the left edge and gone by three quarters, so the checkbox and the cap control on the right
               sit on the card's own surface. Ink on the coloured part is the livery's contrast ink. */
            const livery = corporationLiveryColor(row.companyId);
            const liveryInk = bestContrastTextColor(livery);
            return (
              <div
                key={row.companyId}
                style={{
                  ...styles.row,
                  background: `linear-gradient(90deg, ${livery} 0%, ${livery} 30%, transparent 75%)`,
                }}
              >
                <label style={styles.rowMain}>
                  <input
                    type="checkbox"
                    checked={order >= 0}
                    onChange={(event) => toggle(row.companyId, event.target.checked)}
                    style={styles.checkbox}
                  />
                  <span style={styles.rowText}>
                    <span style={{ ...styles.rowLabel, ...styles.rowIdentity, color: liveryInk }}>
                      <CorporateLogo
                        ticker={row.ticker}
                        size={20}
                        color={liveryInk}
                        title={row.ticker}
                        fallbackStyle={styles.heraldFallback}
                      />
                      {row.ticker}
                      {order >= 0 && <span style={{ ...styles.order, color: liveryInk }}> #{order + 1}</span>}
                    </span>
                    <span style={styles.rowCaption}>
                      {`You hold ${row.holdingPercent}%. `}
                      {offer === "" ? "Nothing on offer." : `${offer}.`}
                    </span>
                  </span>
                </label>
                {target && (
                  <label style={styles.rowCap} title={`Buy ${row.ticker} while you hold less than this.`}>
                    <span style={styles.rowCaption}>up to</span>
                    <select
                      value={target.maxPercent}
                      onChange={(event) => setCap(row.companyId, Number(event.target.value))}
                      style={styles.select}
                    >
                      {AUTO_BUY_CAPS.map((cap) => (
                        <option key={cap} value={cap}>
                          {cap}%
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            );
          })}
          {parred.length === 0 && <span style={styles.rowCaption}>No corporation has a par price yet.</span>}
        </div>
        {unparredCount > 0 && (
          <span style={styles.rowCaption}>
            {unparredCount === 1
              ? "1 corporation is not yet parred and is not listed; par it by hand and it will appear."
              : `${unparredCount} corporations are not yet parred and are not listed; par one by hand and it will appear.`}
          </span>
        )}

        <div style={styles.switches}>
          <label style={styles.switchRow}>
            <input type="checkbox" checked={stopOnPar} onChange={(event) => setStopOnPar(event.target.checked)} />
            <span style={styles.rowCaption}>Switch off when anyone pars a corporation</span>
          </label>
          <label style={styles.switchRow}>
            <input type="checkbox" checked={stopOnSale} onChange={(event) => setStopOnSale(event.target.checked)} />
            <span style={styles.rowCaption}>Switch off when anyone sells shares of a ticked corporation</span>
          </label>
        </div>
        <p style={styles.warning}>
          It will not defend a presidency or par a corporation for you.
        </p>

        <div style={styles.footer}>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...styles.primaryButton, ...(targets.length === 0 ? styles.primaryButtonDisabled : {}) }}
            onClick={() => onArm({ targets, source, stopOnPar, stopOnSale })}
            disabled={targets.length === 0}
            title={
              targets.length === 0
                ? "Tick at least one corporation."
                : "Buy automatically on each of your turns until the caps or the end of this Stock Round."
            }
          >
            Start Auto-Buy
          </button>
        </div>
      </div>
    </div>
  );
}

export default AutoBuyModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 3600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.72)",
  },
  card: {
    width: "min(520px, 100%)",
    maxHeight: "84vh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800 },
  closeButton: {
    background: "none",
    border: "none",
    color: "#8a8a86",
    cursor: "pointer",
    fontSize: FONT_SIZE.body,
    lineHeight: 1,
  },
  body: { fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: 1.45, margin: 0 },
  capRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  select: {
    padding: "4px 8px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.small,
  },
  list: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" },
  row: {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: "10px",
    // #1384: padded so the livery gradient has an edge to run from, and rounded like the card's controls.
    padding: "6px 8px",
    borderRadius: RADIUS.card,
  },
  rowIdentity: { display: "inline-flex", alignItems: "center", gap: "7px" },
  heraldFallback: { fontSize: FONT_SIZE.micro, fontWeight: 800 },
  rowMain: { display: "flex", flexDirection: "row", gap: "10px", cursor: "pointer", flex: 1, minWidth: 0 },
  rowCap: { display: "inline-flex", alignItems: "center", gap: "6px", flex: "none" },
  segment: { display: "inline-flex", gap: "0", border: "1px solid #3a3a3a", borderRadius: RADIUS.card, overflow: "hidden" },
  segmentButton: {
    padding: "4px 10px",
    border: "none",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
  },
  segmentButtonOn: { backgroundColor: "#1d4030", color: "#e6f5ec", fontWeight: 700 },
  switches: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" },
  switchRow: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" },
  checkbox: { marginTop: "3px", flex: "none" },
  rowText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  rowLabel: { fontSize: FONT_SIZE.small, fontWeight: 700 },
  order: { color: "#6fbf8b", fontWeight: 600 },
  rowCaption: { fontSize: FONT_SIZE.micro, color: "#8a8a86", lineHeight: 1.4 },
  warning: { fontSize: FONT_SIZE.micro, color: "#e0b062", lineHeight: 1.4, margin: "2px 0 0" },
  footer: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "6px" },
  secondaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#c8c6c0",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
  },
  primaryButton: {
    padding: "7px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  primaryButtonDisabled: {
    borderColor: "#3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#6e6c68",
    cursor: "not-allowed",
  },
};
