// frontend/src/components/WaitingStatusBanner.tsx
//
/* ==================================================================
    PHASE 3 W2-H (OD-1, H5): THE WAITING SEATS GET A STATUS, NOT A SCRIM
   ==================================================================
   THE AUDIT'S H5. A non-president facing a home station that is owed, and every seat facing the auction's handoff
   while the B&O par was owed, got an `aria-modal` full-screen scrim with ZERO tabbable controls, no Escape, no close
   and no backdrop dismissal. Focus stayed wherever it was, outside the dialog, and Tab walked the page hidden behind
   the scrim. These are legitimate waiting states, so the fix was a product decision rather than a mechanical one.

   OD-1 (owner, 2026-10-03) TOOK IT: the actor gets the controls; everyone else gets a READ-ONLY status card with a
   focus target. Ordinary inactive-player behaviour is not redesigned -- in particular, during Run Routes and
   Dividends the other seats keep seeing the operating corporation's trains, routes and dividend choice exactly as
   before. This surface is only for the prompts that stop the whole table.

   WHAT THIS IS:
     - NOT MODAL. No scrim, no `aria-modal`, nothing made inert: the board, the tabs, the chart and the Activity Log
       stay usable, because a waiting player is entitled to look at the game they are waiting in.
     - A FOCUS TARGET. A labelled `<section>` (an ARIA region, named by its own visible heading) with `tabIndex={0}`,
       so the keyboard can reach the sentence that explains the stop. Focus is NOT moved here on appearance: the
       waiting player may be typing in chat, and taking their focus for somebody else's decision would be the old
       scrim's mistake in a smaller form.
     - A LIVE STATUS. The sentence sits in `role="status"`, so a screen reader hears who the table is waiting on
       when it appears or changes, politely.
     - NO CONTROLS. Not a disabled one either: a greyed button invites the click the card exists to explain away,
       and the authority would refuse it (#783's rule, kept).

   ONE COMPONENT FOR EVERY WAITING PROMPT, so the home station and the auction cannot drift into two presentations
   of one situation; each prompt supplies its own facts (who, which corporation, what happens next). */

import React, { useId } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";

export interface WaitingStatusBannerProps {
  /** The visible heading, which also names the region. */
  heading: string;
  /** The status sentence(s): who the table is waiting on, and what follows. Plain text or inline markup only. */
  children: React.ReactNode;
  /** An optional livery stripe (the corporation the stop is about). */
  accentColor?: string;
  /** Ink that contrasts with `accentColor`. */
  accentInk?: string;
  /** Rendered inside the stripe, e.g. the corporation's logo. */
  accentContent?: React.ReactNode;
  testId?: string;
}

/** The `data-` attribute tests and the shell find a waiting surface by. */
export const WAITING_STATUS_ATTRIBUTE = "data-waiting-status";

export function WaitingStatusBanner({
  heading,
  children,
  accentColor,
  accentInk,
  accentContent,
  testId,
}: WaitingStatusBannerProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      tabIndex={0}
      data-testid={testId}
      {...{ [WAITING_STATUS_ATTRIBUTE]: "true" }}
      style={styles.banner}
    >
      {accentColor && (
        <div style={{ ...styles.stripe, backgroundColor: accentColor, color: accentInk ?? "#f2f0eb" }}>
          {accentContent}
        </div>
      )}
      <div style={styles.body}>
        <span id={headingId} style={styles.heading}>
          {heading}
        </span>
        <p role="status" aria-live="polite" style={styles.text}>
          {children}
        </p>
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /* Top-centre, under the header, and narrow: it must not cover the Action Bar (bottom) or the toasts (bottom,
     4000), and it must leave the board usable. Below the toast layer so a refusal or a link banner is never hidden
     by it. Placement is a first cut for the owner's visual pass, not a measured layout. */
  banner: {
    position: "fixed",
    top: "64px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 3900,
    display: "flex",
    alignItems: "stretch",
    width: "min(520px, calc(100vw - 32px))",
    borderRadius: RADIUS.card,
    border: "1px solid #5a4d2e",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
    overflow: "hidden",
  },
  stripe: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 10px",
    flex: "0 0 auto",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "10px 14px",
    minWidth: 0,
  },
  heading: { fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#d9c08a" },
  text: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: 1.45, color: "#c8c6c0" },
};

export default WaitingStatusBanner;
