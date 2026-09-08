// frontend/src/components/HeraldHomeFloatModal.tsx
//
// The corporation whose home is printed, told so at the moment it floats.
//
// ==================================================================
//  DESIGN NOTE 1332: THE FLOAT THAT ASKS FOR NOTHING
// ==================================================================
//
// REPORTED (11): on the Level Playing Field and 18XX+, PRR floats and nothing happens -- no Home Station
// prompt, no lit hex -- and a president who has learned the eight-corporation flow waits for a modal that
// will not come. #1302 made the herald a station for every rule (reach, routing, price of the next token);
// what it did not do was SAY so where a float is announced.
//
// SO THIS CARD SAYS IT, once, on the transition (`describeFloat`'s own moment in the replay handler), on every
// client, in the shape `HomeStationPrompt` uses -- the livery header, the heading, the hex panel -- so it reads
// as the same ceremony with a different answer. The three facts a president needs:
//   - no home token is placed; the herald on the hex IS the station, and cannot be tokened out;
//   - it pays only the printed figure (Altoona's $10) and stays that figure through every upgrade (11a);
//   - the first token the corporation buys is priced as its SECOND station.
//
// DISMISSABLE, where `HomeStationPrompt` is not: there is nothing to place, so nothing is waiting.

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { CorporateLogo } from "./CorporateLogo";
import { corporationFullName } from "../utils/corporationNames";

export interface HeraldHomeFloatModalProps {
  notice: {
    ticker: string;
    /** The herald's hex, e.g. "H12". */
    hexLabel: string;
    /** The hex as `describeHex` names it, e.g. "Altoona (H12)". */
    place: string;
    /** What the herald pays a run, in dollars. */
    revenue: number;
    /** What the corporation's first placed token will cost. */
    firstTokenCost: number;
  } | null;
  liveryColor: string;
  liveryInk: string;
  onDismiss: () => void;
}

export function HeraldHomeFloatModal({ notice, liveryColor, liveryInk, onDismiss }: HeraldHomeFloatModalProps) {
  React.useEffect(() => {
    if (!notice) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notice, onDismiss]);

  if (!notice) return null;
  const fullName = corporationFullName(notice.ticker);

  return (
    <div style={styles.backdrop} role="presentation" onClick={onDismiss}>
      <div
        style={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={`${notice.ticker} has floated`}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ ...styles.livery, backgroundColor: liveryColor, color: liveryInk }}>
          <CorporateLogo
            ticker={notice.ticker}
            size={26}
            color={liveryInk}
            title={fullName ?? notice.ticker}
            fallbackStyle={styles.liveryTicker}
          />
          {fullName && <span style={styles.liveryName}>{fullName}</span>}
        </div>

        <span style={styles.heading}>{notice.ticker} has floated — no home station to place</span>

        <p style={styles.body}>
          The {notice.ticker}&rsquo;s home is the herald printed on {notice.place}. That herald is its station there:
          its routes may run to or through it, and no other corporation can token it out.
        </p>

        <div style={styles.hexRow}>
          <span style={styles.hexLabelCaption}>Herald home</span>
          <span style={styles.hexLabel}>{notice.hexLabel}</span>
          <span style={styles.hexValue}>pays ${notice.revenue}</span>
        </div>

        <p style={styles.body}>
          It pays the {notice.ticker} <strong>${notice.revenue} only</strong>, and stays ${notice.revenue} through
          every upgrade of the hex. The {notice.ticker} places no free home token; its first station token, at
          its Tokens step, costs <strong>${notice.firstTokenCost}</strong>.
        </p>

        <button type="button" style={styles.confirm} onClick={onDismiss}>
          Understood &#8250;
        </button>
      </div>
    </div>
  );
}

export default HeraldHomeFloatModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 4000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(8, 10, 16, 0.72)",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    width: "min(460px, 100%)",
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
    overflow: "hidden",
    paddingBottom: "16px",
  },
  livery: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 20px" },
  liveryTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.04em" },
  liveryName: { fontSize: FONT_SIZE.body, fontWeight: 700, opacity: 0.9 },
  heading: { padding: "0 20px", fontSize: FONT_SIZE.heading, fontWeight: 800 },
  body: { margin: 0, padding: "0 20px", fontSize: FONT_SIZE.body, lineHeight: 1.5, color: "#a8a6a0" },
  hexRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    margin: "0 20px",
    padding: "10px 14px",
    borderRadius: RADIUS.card,
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
  },
  hexLabelCaption: {
    fontSize: FONT_SIZE.micro,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#a8a6a0",
  },
  hexLabel: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    color: "#f2f0eb",
  },
  hexValue: { marginLeft: "auto", fontSize: FONT_SIZE.small, fontWeight: 700, color: "#e0b062" },
  confirm: {
    margin: "0 20px 4px",
    padding: "11px 16px",
    borderRadius: RADIUS.card,
    border: "1px solid #4d8ee0",
    backgroundColor: "#2f6fb2",
    color: "#f2f0eb",
    font: "inherit",
    fontWeight: 800,
    fontSize: FONT_SIZE.strong,
    cursor: "pointer",
  },
};
