// frontend/src/components/money/moneyStyles.ts
//
// ESCROW-4: one look for the money surfaces -- the waiting room's dark ink palette and type scale (the panel sits in
// the waiting room's action area, the band under the game result, the strip in the table's bar). A typed sheet, so a
// misspelled key is a type error.

import type React from "react";

import { FONT_FAMILY_MONO, FONT_SIZE, LINE_HEIGHT, RADIUS } from "../../styles/typography";

const sheet = <T extends Record<string, React.CSSProperties>>(styles: T): T => styles;

export const moneyStyles = sheet({
  /* W2-K (OD-14(i)): the seat's money panel is a REGION of the waiting room, not a box inside it. The waiting room
     groups by structure -- section labels and hairlines, nothing boxed except a transient confirmation (#1443-#1445)
     -- and a blue card here was the one grouping that still nested a surface. The review card and the confirmations
     below stay bounded: they are states, the same exception the room makes for its ante confirmation. */
  panel: { display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 },
  /* PLAY WAITING ROOM: the same steps on your boarding pass (inset there in their own dark look). */
  departure: { display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 },
  /* The waiting room's section label (its `subHeading`): micro, heavy, tracked, the faint step. */
  sectionLabel: { margin: 0, fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8a8a86" },
  /* "Escrow details": a quiet disclosure, read as a control rather than as a sentence. */
  disclosure: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#a8a6a0", cursor: "pointer", width: "fit-content" },
  disclosureBody: { marginTop: "8px" },
  strip: { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 12px", fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: LINE_HEIGHT.normal },
  stakeTag: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#9ec5ff", border: "1px solid #2f4a68", borderRadius: RADIUS.control, padding: "2px 8px", whiteSpace: "nowrap" },
  steps: { display: "flex", flexWrap: "wrap", gap: "4px", margin: 0, padding: 0, listStyle: "none" },
  step: { fontSize: FONT_SIZE.micro, padding: "2px 7px", borderRadius: RADIUS.control, border: "1px solid #2a2a2a", color: "#6e6c68", whiteSpace: "nowrap" },
  stepDone: { fontSize: FONT_SIZE.micro, padding: "2px 7px", borderRadius: RADIUS.control, border: "1px solid #24503f", color: "#7ee0a1", whiteSpace: "nowrap" },
  stepNow: { fontSize: FONT_SIZE.micro, padding: "2px 7px", borderRadius: RADIUS.control, border: "1px solid #38bdf8", color: "#f2f0eb", fontWeight: 800, whiteSpace: "nowrap" },
  headline: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#f2f0eb", overflowWrap: "anywhere" },
  detail: { margin: 0, fontSize: FONT_SIZE.small, color: "#c8c6c0", lineHeight: LINE_HEIGHT.normal, maxWidth: "70ch" },
  faint: { margin: 0, fontSize: FONT_SIZE.small, color: "#8a8a86", lineHeight: LINE_HEIGHT.normal, maxWidth: "70ch" },
  blocker: { margin: 0, fontSize: FONT_SIZE.small, color: "#f0c674", lineHeight: LINE_HEIGHT.normal, maxWidth: "70ch" },
  error: { margin: 0, fontSize: FONT_SIZE.small, color: "#e07a7a", lineHeight: LINE_HEIGHT.normal, maxWidth: "70ch" },
  notice: { margin: 0, fontSize: FONT_SIZE.small, color: "#7ee0a1", lineHeight: LINE_HEIGHT.normal, maxWidth: "70ch" },
  row: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
  primary: { fontSize: FONT_SIZE.control, fontWeight: 800, padding: "8px 18px", borderRadius: RADIUS.card, border: "1px solid #38bdf8", backgroundColor: "#1d3a55", color: "#9ec5ff", cursor: "pointer" },
  secondary: { fontSize: FONT_SIZE.control, fontWeight: 700, padding: "8px 16px", borderRadius: RADIUS.card, border: "1px solid #3a3a3a", backgroundColor: "#1c1c1c", color: "#c8c6c0", cursor: "pointer" },
  danger: { fontSize: FONT_SIZE.control, fontWeight: 700, padding: "8px 16px", borderRadius: RADIUS.card, border: "1px solid #7a3a3a", backgroundColor: "#2a1414", color: "#f0a8a8", cursor: "pointer" },
  quiet: { fontSize: FONT_SIZE.micro, fontWeight: 700, padding: "4px 9px", borderRadius: RADIUS.control, border: "1px solid #2e2e2e", backgroundColor: "transparent", color: "#a8a6a0", cursor: "pointer", whiteSpace: "nowrap" },
  disabled: { opacity: 0.4, cursor: "not-allowed" },
  review: { display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", borderRadius: RADIUS.card, border: "1px solid #2f6f6a", backgroundColor: "#12201f" },
  reviewTitle: { margin: 0, fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#f2f0eb" },
  terms: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", margin: 0, alignItems: "baseline" },
  termLabel: { margin: 0, fontSize: FONT_SIZE.small, color: "#a8a6a0", whiteSpace: "nowrap" },
  termValue: { margin: 0, fontSize: FONT_SIZE.small, color: "#f2f0eb", fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" },
  mono: { fontFamily: FONT_FAMILY_MONO, fontSize: FONT_SIZE.micro, color: "#c8c6c0", overflowWrap: "anywhere" },
  confirm: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: RADIUS.card, border: "1px solid #5a4a2f", backgroundColor: "#1f1a12" },
  band: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #2a2a2a" },
  bandTitle: { margin: 0, fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9ec5ff" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" },
  entry: { display: "flex", flexDirection: "column", gap: "4px", padding: "10px 12px", borderRadius: RADIUS.card, border: "1px solid #2a2a2a", backgroundColor: "#141414" },
  amount: { fontSize: FONT_SIZE.control, padding: "6px 10px", borderRadius: RADIUS.control, border: "1px solid #3a3a3a", backgroundColor: "#141414", color: "#f2f0eb", maxWidth: "220px" },
  optIn: { display: "flex", gap: "8px", alignItems: "center", fontSize: FONT_SIZE.control, color: "#f2f0eb" },
});

export const buttonStyle = (tone: "primary" | "secondary" | "danger", disabled: boolean): React.CSSProperties => ({ ...moneyStyles[tone], ...(disabled ? moneyStyles.disabled : {}) });
