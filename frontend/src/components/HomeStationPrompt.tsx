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
//  DESIGN NOTE 440: IT IS A MAP CLICK NOW
// ==================================================================
//
// This prompt used to BE the placement: one button, one confirmation, token
// down. The note that stood here argued for that and against the map --
// "a map interaction that accepts exactly one hex and rejects the other
// eighty is not a choice, it is a scavenger hunt with a modal's worth of
// instructions attached."
//
// The objection was to the SEARCH, and the search turns out to be
// avoidable. The board can be veiled down to the single legal hex with the
// placement cursor already armed, so there is nothing to hunt for: one lit
// hex on an otherwise dark map IS the answer, and clicking it is one
// gesture. That turns the old objection into a description of how this is
// implemented rather than an argument against it.
//
// What a confirmation could never do is show the player WHERE. A modal
// naming "E11" hands a new president a coordinate; a map with E11 lit and
// everything else dark shows them where their corporation stands on the
// board they are about to operate on. This is the first thing that ever
// happens to a corporation, and it now happens on the map.
//
// SO THIS COMPONENT ANNOUNCES AND HANDS OFF. `onPlace` no longer means
// "place it" -- it means "take me there". The signature is unchanged
// because it already carries exactly what both readings need: the
// corporation and the hex.
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

        {/* ==================================================
             DESIGN NOTE 440: THE ROUTE SENTENCE WAS WRONG
            ==================================================

             REPORTED: remove the misleading rules text from this prompt.

             It read "Every route it runs must touch a city it holds a token
             in, starting here." Two claims, and the load-bearing half is
             false. A route must include at least one city the corporation
             has a token in -- it does not have to START at one, and once
             the corporation places further tokens it need not involve THIS
             hex at all. Told at the moment the home token goes down, the
             sentence reads as "your trains will always run from here",
             which is a wrong mental model handed to a player at exactly
             the moment they are forming one.

             The surviving half -- that the hex is printed and fixed -- is
             the fact this prompt exists to convey, so it stays and the
             route rule goes. A placement confirmation is not the place to
             teach a routing rule, and certainly not a garbled one. */}
        <span style={styles.consequence}>
          Printed on the board and fixed by the rules — the {pending.ticker} has no other
          legal home.
        </span>

        {/* Design note #440: this OPENS THE MAP; it does not place. The
            caller arms the placement cursor, veils the board down to this
            one hex and navigates there, so the token goes down under the
            player's own click on the board it belongs to. */}
        <button
          type="button"
          style={styles.confirm}
          onClick={() => onPlace(pending.companyId, pending.q, pending.r)}
        >
          Place the {pending.ticker} station on {pending.hexLabel} &#8250;
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
