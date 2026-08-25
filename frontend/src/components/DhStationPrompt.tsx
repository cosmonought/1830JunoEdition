// frontend/src/components/DhStationPrompt.tsx
//
// The D&H's free station: taken, or forfeited, and never by accident.
//
// ==================================================================
//  DESIGN NOTE 818: A QUESTION, BECAUSE THE ANSWER CANNOT BE UNDONE
// ==================================================================
//
// REQUESTED: "a modal pops up and asks them 'Do you want to place a Station Marker on this tile for free? If
// you do not use this power now, it will be forfeited.'"
//
// I PROPOSED DOING WITHOUT IT and was corrected: "I fear without the station marker modal that players may
// not realize they are forfeiting the special power." The alternative was to arm the placement automatically
// and let the confirmation ring's red X decline it -- fewer clicks, and wrong for a reason that generalises
// past this power. A red X dismisses EVERYWHERE ELSE in this app: nothing happened, come back later. Giving
// it a second job here, on the one screen where the mistake is permanent, would teach a player the opposite
// of what they have already learned. `dhPower.ts` #818 carries the full argument.
//
// NO CLOSE BUTTON AND NO BACKDROP DISMISS, which is the one place this departs from the app's other modals
// (`AutoPassModal` has both). Those are settings, and a settings dialog dismissed unanswered leaves the world
// as it was. This one cannot: a dismissal here is either an acceptance or a forfeit, and there is no third
// thing for an X in the corner to mean. Two buttons, both labelled with what they do.
//
// THE FORFEIT IS THE LOUD HALF, not the decline button. #725a's self-lay warning made the same call for the
// same reason -- the cost a player cannot see coming is the one that needs the sentence, and the button only
// needs to be honest about which sentence it belongs to.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import {
  DH_HEX_LABEL,
  DH_STATION_PROMPT_BODY,
  DH_STATION_PROMPT_FORFEIT,
  DH_STATION_PROMPT_TITLE,
} from "../utils/dhPower";

export interface DhStationPromptProps {
  /** The corporation that laid the tile, for the sentence that names it. */
  ticker: string;
  /** How many unplaced station tokens it still holds, or `null` when the room has not reported them.
   *
   *  Design note #818: FREE IS NOT COSTLESS, and this is the number that says so. The token comes out of the
   *  corporation's own supply (#725: "free means no cash, not no token"), so a corporation down to its last
   *  marker is making a real choice between Scranton and somewhere it would rather be. Absent rather than
   *  guessed when unknown -- the same rule #250 sets for a treasury figure. */
  tokensLeft: number | null;
  onAccept: () => void;
  onDecline: () => void;
}

export function DhStationPrompt({
  ticker,
  tokensLeft,
  onAccept,
  onDecline,
}: DhStationPromptProps): React.ReactElement {
  return (
    <div style={styles.backdrop} role="alertdialog" aria-modal="true" aria-label={DH_STATION_PROMPT_TITLE}>
      <div style={styles.card}>
        <span style={styles.heading}>{DH_STATION_PROMPT_TITLE}</span>

        <p style={styles.body}>{DH_STATION_PROMPT_BODY}</p>

        {/* Design note #818: the supply, where the decision is. A president deciding this needs to know
            whether saying yes costs them a marker they were saving. */}
        {tokensLeft !== null && (
          <p style={styles.supply}>
            {ticker} has {tokensLeft} station {tokensLeft === 1 ? "token" : "tokens"} left to place.
            {tokensLeft === 0
              ? " With none in hand there is nothing to place, so this power cannot be taken."
              : " The token comes out of that supply — free means no cash, not no token."}
          </p>
        )}

        <p style={styles.forfeit}>{DH_STATION_PROMPT_FORFEIT}</p>

        <div style={styles.actions}>
          {/* DECLINE FIRST, and named. "No" beside "Yes" makes a player read the question again to find out
              which is which; "Forfeit it" says what the button does, which is the whole point of the modal. */}
          <button
            type="button"
            style={{ ...styles.button, ...styles.decline }}
            onClick={onDecline}
            title={`The D&H's free station is given up for the rest of the game. ${ticker} still places its normal token this turn.`}
          >
            Forfeit it
          </button>
          <button
            type="button"
            style={{
              ...styles.button,
              ...(tokensLeft === 0 ? styles.buttonDisabled : styles.accept),
            }}
            disabled={tokensLeft === 0}
            onClick={onAccept}
            title={
              tokensLeft === 0
                ? `${ticker} has no station token left to place.`
                : `Arms ${DH_HEX_LABEL} for a free token. You still confirm it on the board, and you can come back here.`
            }
          >
            Place it on {DH_HEX_LABEL}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 72,
    backgroundColor: "rgba(6, 9, 16, 0.66)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  card: {
    width: "min(460px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    borderRadius: "12px",
    border: "1px solid #3a4150",
    backgroundColor: "#141a26",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
  },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#e2e6ee" },
  body: { margin: 0, fontSize: FONT_SIZE.body, color: "#aab0bc", lineHeight: 1.55 },
  supply: { margin: 0, fontSize: FONT_SIZE.small, color: "#c1c7d3", lineHeight: 1.5 },
  /* Amber, and the only amber on the card. #725a's self-lay warning uses the same tone for the same
     sentence-shaped fact: this is what it costs, said before it costs it. */
  forfeit: {
    margin: 0,
    padding: "8px 10px",
    borderRadius: "6px",
    backgroundColor: "#2a2415",
    border: "1px solid #4a3f1c",
    fontSize: FONT_SIZE.small,
    color: "#e6cf7a",
    lineHeight: 1.45,
  },
  actions: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: "8px",
    marginTop: "4px",
  },
  button: {
    padding: "9px 18px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  accept: { backgroundColor: "#16a34a", borderColor: "#4ade80", color: "#ffffff" },
  /* NOT RED. Declining is a legitimate choice -- a corporation with two markers left may well want them
     elsewhere -- and painting it as the destructive option would push players into taking a token they did
     not want. The amber paragraph above carries the consequence; the button only has to be honest. */
  decline: { backgroundColor: "#232936", borderColor: "#4a5163", color: "#c8cdd8" },
  buttonDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
    backgroundColor: "#1f2937",
    borderColor: "#374151",
    color: "#6b7280",
  },
};

export default DhStationPrompt;
