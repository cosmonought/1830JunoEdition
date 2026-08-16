// frontend/src/components/HomeStationPrompt.tsx
//
// ==================================================================
//  DESIGN NOTE 416 (UI half): PLACE THE HOME STATION, DELIBERATELY
// ==================================================================
//
// REPORTED: stop auto-placing the Erie's home station. When it floats, halt
// and prompt the President to place the token explicitly, even though the
// destination hex is fixed by the rules.
//
// See `sandboxSession.ts` design note #416 for why the rules being
// unambiguous does not settle this. The short version: the float is the
// most consequential moment in a corporation's life and its most visible
// half was happening off-screen, on a tab the player was not looking at.
//
// ==================================================================
//  WHY THIS IS A CONFIRMATION AND NOT A MAP CLICK
// ==================================================================
//
// The requirement says "click/place", and a literal reading is that the
// player should click the hex on the Rail Map. This does not do that, and
// the reason is that the hex is FIXED: a map interaction that accepts
// exactly one hex and rejects the other eighty is not a choice, it is a
// scavenger hunt with a modal's worth of instructions attached. A player
// who does not already know where the Erie starts would hunt; one who does
// would resent the extra step.
//
// So the prompt names the hex, says it is printed on the board, and asks
// for one deliberate confirmation. The player witnesses the placement --
// which is the requirement's actual purpose -- without being made to
// perform a search whose answer the app already knows.
//
// IF A LATER PASS WANTS THE MAP INTERACTION, this component is the place to
// start: it already holds the `(q, r)` the token is bound for, so wiring it
// to highlight that hex and wait for a click is additive rather than a
// rewrite. The `onPlace` contract does not change.
//
// ==================================================================
//  BLOCKING, AND WHY THAT IS SAFE HERE
// ==================================================================
//
// Modal and undismissable, the same shape as `BoParPrompt` and for a
// related reason: there is no legal state on the other side of cancelling.
// The corporation has floated, the token is owed, and 1830 has no branch
// where a floated company declines its home station.
//
// It is safe to block because the condition is DERIVED, not flagged --
// `pendingHomeTokens` recomputes it from the board every render, so a
// reload, a late poll or a double dispatch all land on the same answer.
// A one-shot flag would risk the opposite failure: a modal that vanishes
// with the token still unplaced and nothing left to ask for it.
//
// ONE AT A TIME. Several corporations can float on a single dispatch (a
// waterfall cascade, or a multi-buy crossing two thresholds). The caller
// passes the head of the queue and the next appears as soon as this one is
// answered -- one decision per screen, in operating order.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import { CorporateLogo } from "./CorporateLogo";
import { corporationFullName } from "../utils/corporationNames";

export interface HomeStationPromptProps {
  /** The corporation owing a token, or `null` when none is outstanding --
   *  the modal then renders nothing. */
  pending: {
    companyId: number;
    ticker: string;
    hexLabel: string;
    q: number;
    r: number;
  } | null;
  /** The president's display name, for the heading. `null` when the
   *  presidency is not on record -- the copy drops to the corporation. */
  presidentLabel: string | null;
  /** The corporation's livery, so the prompt is unmistakably about THIS
   *  company rather than being generic chrome. */
  liveryColor: string;
  /** Ink that contrasts with `liveryColor`, computed by the caller with the
   *  same helper every other corporate surface uses. */
  liveryInk: string;
  /** Places the token. The caller dispatches; this only asks. */
  onPlace: (companyId: number, q: number, r: number) => void;
}

export function HomeStationPrompt({
  pending,
  presidentLabel,
  liveryColor,
  liveryInk,
  onPlace,
}: HomeStationPromptProps) {
  if (!pending) return null;

  const fullName = corporationFullName(pending.ticker);

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`Place the ${pending.ticker} home station token`}
    >
      <div style={styles.card}>
        {/* The livery stripe, the same treatment the stock card and the
            action bar use (design note #389), so the corporation announces
            itself here exactly as it does everywhere else. */}
        <div style={{ ...styles.livery, backgroundColor: liveryColor, color: liveryInk }}>
          <CorporateLogo
            ticker={pending.ticker}
            size={26}
            color={liveryInk}
            title={fullName ?? pending.ticker}
            fallbackStyle={styles.liveryTicker}
          />
          {fullName && <span style={styles.liveryName}>{fullName}</span>}
        </div>

        <span style={styles.heading}>
          {presidentLabel
            ? `${presidentLabel} — place the home station`
            : "Place the home station"}
        </span>

        <p style={styles.body}>
          The {pending.ticker} has floated. As President you place its first station token,
          free, on its printed home hex.
        </p>

        {/* The hex, given the emphasis of the thing the player is being
            asked to act on. Naming it is what makes a confirmation an
            adequate substitute for hunting the map for it. */}
        <div style={styles.hexRow}>
          <span style={styles.hexLabelCaption}>Home hex</span>
          <span style={styles.hexLabel}>{pending.hexLabel}</span>
        </div>

        <span style={styles.consequence}>
          Printed on the board and fixed by the rules — the {pending.ticker} has no other legal
          home. Every route it runs must touch a city it holds a token in, starting here.
        </span>

        <button
          type="button"
          style={styles.confirm}
          onClick={() => onPlace(pending.companyId, pending.q, pending.r)}
        >
          Place the {pending.ticker} station on {pending.hexLabel}
        </button>
      </div>
    </div>
  );
}

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
    borderRadius: "12px",
    border: "1px solid #3a4150",
    backgroundColor: "#161b26",
    color: "#e2e6ee",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
    overflow: "hidden",
  },
  livery: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 20px",
  },
  liveryTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.04em" },
  liveryName: { fontSize: FONT_SIZE.body, fontWeight: 700, opacity: 0.9 },
  heading: { padding: "0 20px", fontSize: FONT_SIZE.heading, fontWeight: 800 },
  body: {
    margin: 0,
    padding: "0 20px",
    fontSize: FONT_SIZE.body,
    lineHeight: 1.5,
    color: "#aeb6c4",
  },
  hexRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    margin: "0 20px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid #3a4150",
    backgroundColor: "#1b2130",
  },
  hexLabelCaption: {
    fontSize: FONT_SIZE.micro,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#8f98a8",
  },
  hexLabel: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    color: "#ffffff",
  },
  consequence: {
    padding: "0 20px",
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.5,
    color: "#8f98a8",
  },
  confirm: {
    margin: "0 20px 20px",
    padding: "11px 16px",
    borderRadius: "8px",
    border: "1px solid #4d8ee0",
    backgroundColor: "#2f6fb2",
    color: "#f2f7ff",
    font: "inherit",
    fontWeight: 800,
    fontSize: FONT_SIZE.strong,
    cursor: "pointer",
  },
};

export default HomeStationPrompt;
