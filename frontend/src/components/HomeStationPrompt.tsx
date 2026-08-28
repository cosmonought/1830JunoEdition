// Design note #416 (UI half): a floated corporation halts and the President
// places the home token deliberately, rather than it being placed off-screen.
//
// Design note #440: this ANNOUNCES AND HANDS OFF -- `onPlace` means "take me
// there", not "place it". The board is veiled to the single legal hex with the
// cursor armed, so there is nothing to hunt for and the player is shown WHERE.
//
// Blocking and undismissable, safe because the condition is DERIVED:
// `pendingHomeTokens` recomputes from the board every render. ONE AT A TIME --
// several corporations can float on one dispatch.
//
// See docs/ai_architecture/state_machine.md, HomeStationPrompt.tsx #416 / #440.

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
  /** Design note #783: WHETHER THIS VIEWER IS THE ONE BEING ASKED.
   *
   *  REPORTED: "when another player buys the share that floats your corporation, the screen just hangs on
   *  that player's turn until the corporation president places the home station. This is confusing players
   *  who think they still need to do something."
   *
   *  THE GAME STOPS FOR EVERYONE AND ONLY ONE PERSON IS TOLD WHY. #763 refuses every action while a home
   *  token is owed and #769 holds the seat on the President -- both correct, and both silent. A table of four
   *  watches a turn that will not advance with no statement anywhere that it is waiting on somebody.
   *
   *  THE SAME CARD, NOT A SECOND COMPONENT. The other players need the identical facts -- which corporation,
   *  whose move -- and a separate "waiting" modal would be a second place for that copy to drift. What
   *  changes is the verb and the absence of a button. Defaults `true` so an existing caller is unaffected. */
  viewerIsPresident?: boolean;
}

export function HomeStationPrompt({
  pending,
  presidentLabel,
  liveryColor,
  liveryInk,
  onPlace,
  viewerIsPresident = true,
}: HomeStationPromptProps) {
  if (!pending) return null;

  const fullName = corporationFullName(pending.ticker);

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={
        viewerIsPresident
          ? `Place the ${pending.ticker} home station token`
          : `Waiting for the ${pending.ticker} home station token`
      }
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
          {/* Design note #783: the heading already NAMED the president, which is most of what a watching
             player needs -- it just addressed them as if they were that person. */}
          {viewerIsPresident
            ? presidentLabel
              ? `${presidentLabel} — place the home station`
              : "Place the home station"
            : `${pending.ticker} has floated`}
        </span>

        <p style={styles.body}>
          {viewerIsPresident ? (
            <>
              The {pending.ticker} has floated. As President you place its first station token, free, on its
              printed home hex.
            </>
          ) : (
            <>
              {/* Says WHO and says the game is waiting rather than broken -- the two things the report
                 identifies as missing. No estimate of how long: this clears on an action, not a timer. */}
              Waiting for {presidentLabel ?? `the ${pending.ticker} President`} to place its first station
              token. Play resumes as soon as it is down.
            </>
          )}
        </p>

        {/* The hex, given the emphasis of the thing the player is being
            asked to act on. Naming it is what makes a confirmation an
            adequate substitute for hunting the map for it. */}
        <div style={styles.hexRow}>
          <span style={styles.hexLabelCaption}>Home hex</span>
          <span style={styles.hexLabel}>{pending.hexLabel}</span>
        </div>

        {/* Design note #440: the route sentence is GONE. It read "Every route it runs
           must touch a city it holds a token in, starting here" -- and a route does not
           have to START at a token, nor involve this hex at all once further tokens are
           placed. The surviving half, that the hex is printed and fixed, is the fact
           this prompt exists to convey. */}
        {/* ==================================================================
             DESIGN NOTE 912: THE RULE IS FOR WHOEVER HAS TO OBEY IT
            ==================================================================
            REPORTED: remove this line for players who are not the president of the floating corporation.
            IT ANSWERS A QUESTION ONLY THE PRESIDENT IS ASKING. "The hex is fixed and you have no choice" is
            the sentence that stops a president hunting for an alternative before they click -- and #440 kept
            it for exactly that. A watcher is not choosing anything; for them it is a rules lecture attached
            to somebody else's turn, on a modal #783 already trimmed to "who is doing what, and why you are
            waiting".
            SAME GATE AS THE BUTTON, deliberately. `viewerIsPresident` already decides whether this modal
            offers an action; the explanation of why the action has no alternatives belongs with the action.
            Two different conditions for "is this mine to do" is how the two come apart. */}
        {viewerIsPresident && (
          <span style={styles.consequence}>
            Printed on the board and fixed by the rules — the {pending.ticker} has no other
            legal home.
          </span>
        )}

        {/* Design note #440: this OPENS THE MAP; it does not place. The
            caller arms the placement cursor, veils the board down to this
            one hex and navigates there, so the token goes down under the
            player's own click on the board it belongs to. */}
        {/* Design note #783: NO BUTTON FOR A WATCHER. A disabled control would invite the click this modal
           exists to explain away, and #763's gate would refuse it silently -- confusion on top of confusion. */}
        {viewerIsPresident && (
          <button
            type="button"
            style={styles.confirm}
            onClick={() => onPlace(pending.companyId, pending.q, pending.r)}
          >
            Place the {pending.ticker} station on {pending.hexLabel} &#8250;
          </button>
        )}
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
