// frontend/src/components/InfoPages.tsx
//
// ==================================================================
//  PHASE 3 (P3-ACCT): THE RULES AND THE TERMS -- READING PAGES, OPEN TO EVERYONE
// ==================================================================
//
// RULES: the same reference the table's Rules tab shows (`RulesReference`), with no live game -- the printed game's
// full reference. A visitor reads it without an account (owner, public first).
//
// TERMS (AUD-20.08, OD-16): THE SHELL ONLY. The owner writes the terms of real-money play; this build has none, and this
// page invents none -- it says so, plainly, and names where the facts a depositor needs already are (the deposit's own
// terms on the money panel; Keplr's approval screen). Every money/deposit surface links here (`TermsLink`), so the
// owner's copy, once written, is one file away from every place it must be read. Until then nothing here may read as
// legal text: no clauses, no "by depositing you agree", no jurisdiction, no warranty language.
//
// Both open as a full-window `NativeModal` from `utils/infoPages.ts` (no URL router exists and none is added) and close
// back to where the reader was.

import React from "react";

import { NativeModal } from "./NativeModal";
import { RulesReference } from "./RulesReference";
import { ConductReviewPanel } from "./ConductReviewPanel";
import { closeInfoPage, openInfoPage, useInfoPage } from "../utils/infoPages";
import { profileStyles as styles } from "./profileStyles";
import { SANDBOX_PANEL, SANDBOX_INK, SANDBOX_RULE, SANDBOX_TEXT } from "../styles/palette";
import { FONT_FAMILY, FONT_SIZE, RADIUS } from "../styles/typography";

/** OD-16 / AUD-20.08: what the Terms page says while the owner's copy is pending -- a fact about this build, not terms. */
export const TERMS_PENDING_SENTENCE = "The operator's terms for real-money play have not been published yet.";

export function TermsPage({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <NativeModal name="Terms" dismissible onDismiss={onClose} restoreOpener scrimStyle={pageStyles.scrim} testId="terms-page">
      <div style={pageStyles.page}>
        <div style={pageStyles.header}>
          <h2 style={styles.heading}>Terms</h2>
          <button type="button" style={styles.secondary} onClick={onClose} data-testid="terms-close">
            Close
          </button>
        </div>
        <p style={styles.notice} data-testid="terms-pending">
          {TERMS_PENDING_SENTENCE}
        </p>
        <p style={styles.text}>Until they are, the facts of a deposit are the ones shown where you make it:</p>
        <ul style={pageStyles.list}>
          <li>the table's money panel shows the stake, the escrow fee, the pot, the network and the wallet that is paid;</li>
          <li>Keplr shows the transaction itself before you approve it.</li>
        </ul>
        <p style={pageStyles.faint}>This page is where the operator's terms will appear.</p>
      </div>
    </NativeModal>
  );
}

export function RulesPage({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <NativeModal name="Rules" dismissible onDismiss={onClose} restoreOpener scrimStyle={pageStyles.scrim} testId="rules-page">
      <div style={pageStyles.wide}>
        <div style={pageStyles.header}>
          <h2 style={styles.heading}>Rules</h2>
          {/* Review L3: the Terms are reachable before any money surface -- from the public Rules. */}
          <TermsLink label="Terms of real-money play" testId="rules-terms-link" />
          <button type="button" style={styles.secondary} onClick={onClose} data-testid="rules-close">
            Close
          </button>
        </div>
        <RulesReference />
      </div>
    </NativeModal>
  );
}

/** The one host, mounted in `index.tsx`. */
export function InfoPagesHost(): JSX.Element | null {
  const page = useInfoPage();
  if (page === "terms") return <TermsPage onClose={closeInfoPage} />;
  if (page === "rules") return <RulesPage onClose={closeInfoPage} />;
  if (page === "conduct-review") return <ConductReviewPanel onClose={closeInfoPage} />;
  return null;
}

/** The link every money/deposit surface carries (AUD-20.08). A button, because there is no URL to go to. */
export function TermsLink({ style, label = "Terms", className, testId = "terms-link" }: { style?: React.CSSProperties; label?: string; className?: string; testId?: string }): JSX.Element {
  return (
    <button type="button" className={className} style={{ ...pageStyles.link, ...style }} onClick={() => openInfoPage("terms")} data-testid={testId}>
      {label}
    </button>
  );
}

const pageStyles: Record<"scrim" | "page" | "wide" | "header" | "list" | "faint" | "link", React.CSSProperties> = {
  scrim: {
    position: "fixed",
    inset: 0,
    pointerEvents: "auto",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "16px",
    boxSizing: "border-box",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    overflowY: "auto",
  },
  page: { ...styles.card, maxWidth: "640px" },
  wide: {
    width: "100%",
    maxWidth: "1040px",
    padding: "20px",
    boxSizing: "border-box",
    borderRadius: RADIUS.layer,
    border: `1px solid ${SANDBOX_RULE}`,
    backgroundColor: SANDBOX_PANEL,
    color: SANDBOX_INK,
    fontFamily: FONT_FAMILY,
  },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "8px" },
  list: { margin: "0 0 12px", paddingLeft: "20px", fontSize: FONT_SIZE.body, lineHeight: 1.5, color: SANDBOX_INK },
  faint: { margin: 0, fontSize: FONT_SIZE.small, color: SANDBOX_TEXT },
  link: {
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    fontSize: "inherit",
    color: "#9ec5ff",
    textDecoration: "underline",
    cursor: "pointer",
  },
};
