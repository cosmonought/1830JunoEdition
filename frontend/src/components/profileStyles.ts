// frontend/src/components/profileStyles.ts
//
// LIVE-2E: one look for the profile screens (the gate, the recovery-key reveal, the profile menu) -- the lobby's
// dark sandbox palette, its type scale and its radii. A typed sheet (`sheet` below) rather than a
// `Record<string, CSSProperties>`, so a misspelled key is a type error instead of a style that spreads to nothing.

import type React from "react";

import {
  CARD_SURFACE,
  INK,
  SANDBOX_INK,
  SANDBOX_PANEL,
  SANDBOX_RAISED,
  SANDBOX_RULE,
  SANDBOX_RULE_STRONG,
  SANDBOX_TEXT,
  SANDBOX_TITLE,
} from "../styles/palette";
import { CONTROL_PADDING, FONT_FAMILY, FONT_FAMILY_MONO, FONT_SIZE, RADIUS } from "../styles/typography";

const sheet = <T extends Record<string, React.CSSProperties>>(styles: T): T => styles;

export const profileStyles = sheet({
  screen: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px 16px",
    boxSizing: "border-box",
    backgroundColor: SANDBOX_PANEL,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY,
  },
  card: {
    width: "100%",
    maxWidth: "520px",
    padding: "24px",
    borderRadius: RADIUS.layer,
    backgroundColor: SANDBOX_RAISED,
    border: `1px solid ${SANDBOX_RULE}`,
    boxSizing: "border-box",
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY,
  },
  heading: { margin: "0 0 8px", fontSize: "22px", fontWeight: 700, color: SANDBOX_TITLE },
  subheading: { margin: "0 0 8px", fontSize: FONT_SIZE.control, fontWeight: 700, color: SANDBOX_TITLE },
  lead: { margin: "0 0 16px", fontSize: FONT_SIZE.body, lineHeight: 1.5, color: SANDBOX_TEXT },
  text: { margin: "0 0 12px", fontSize: FONT_SIZE.body, lineHeight: 1.5, color: SANDBOX_INK },
  choices: { display: "flex", flexWrap: "wrap", gap: "8px", margin: "0 0 16px" },
  form: { display: "flex", flexDirection: "column", gap: "10px" },
  label: { fontSize: FONT_SIZE.small, color: SANDBOX_TEXT },
  input: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_PANEL,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY,
  },
  monoInput: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.input,
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_PANEL,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY_MONO,
  },
  secret: {
    display: "block",
    padding: "12px",
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_PANEL,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY_MONO,
    fontSize: FONT_SIZE.body,
    wordBreak: "break-all",
    userSelect: "all",
    margin: "0 0 12px",
  },
  code: {
    display: "block",
    padding: "12px",
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: SANDBOX_PANEL,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY_MONO,
    fontSize: "24px",
    letterSpacing: "2px",
    textAlign: "center",
    userSelect: "all",
    margin: "0 0 12px",
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", margin: "0 0 12px" },
  check: { display: "flex", alignItems: "center", gap: "8px", fontSize: FONT_SIZE.body, margin: "0 0 12px" },
  primary: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.control,
    border: "1px solid transparent",
    backgroundColor: CARD_SURFACE,
    color: INK,
    cursor: "pointer",
  },
  secondary: {
    fontSize: FONT_SIZE.control,
    padding: CONTROL_PADDING.button,
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: "transparent",
    color: SANDBOX_INK,
    cursor: "pointer",
  },
  tab: {
    fontSize: FONT_SIZE.body,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_RULE_STRONG}`,
    backgroundColor: "transparent",
    color: SANDBOX_INK,
    cursor: "pointer",
  },
  tabSelected: {
    fontSize: FONT_SIZE.body,
    padding: CONTROL_PADDING.buttonSmall,
    borderRadius: RADIUS.control,
    border: `1px solid ${SANDBOX_TITLE}`,
    backgroundColor: SANDBOX_RULE,
    color: SANDBOX_INK,
    fontWeight: 700,
    cursor: "pointer",
  },
  error: { margin: "8px 0 0", fontSize: FONT_SIZE.body, color: "#ffb4a8" },
  notice: { margin: "0 0 12px", fontSize: FONT_SIZE.body, color: SANDBOX_TITLE },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
});

/** Design note #3 (`Lobby.tsx`): a control that is disabled has to look it. */
export function disabledLook(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  return disabled ? { ...base, opacity: 0.4, cursor: "not-allowed" } : base;
}
