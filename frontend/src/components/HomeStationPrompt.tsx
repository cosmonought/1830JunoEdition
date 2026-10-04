// Design note #416 (UI half): a floated corporation halts and the President
// places the home token deliberately, rather than it being placed off-screen.
//
// Design note #440: this ANNOUNCES AND HANDS OFF -- `onPlace` means "take me
// there", not "place it". The board is veiled to the single legal hex with the
// cursor armed, so there is nothing to hunt for and the player is shown WHERE.
//
// Blocking and undismissable FOR THE PRESIDENT, safe because the condition is
// DERIVED: `pendingHomeTokens` recomputes from the board every render, so a
// reload raises it again. ONE AT A TIME -- only the operating corporation owes.
//
// Phase 3 W2-H (OD-1, H5): EVERYONE ELSE gets a read-only, non-modal status
// (`WaitingStatusBanner`) naming who must place which corporation's home --
// no scrim, no control, and the board stays usable. K-21 / U-32: the copy no
// longer says the corporation "has floated" -- the home is owed at the start
// of its FIRST OPERATING TURN (#1610), not at the float.
//
// See docs/ai_architecture/state_machine.md, HomeStationPrompt.tsx #416 / #440.

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { CorporateLogo } from "./CorporateLogo";
import { WaitingStatusBanner } from "./WaitingStatusBanner";
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
    /** Design note #1325: more than one entry and the president chooses. */
    options?: ReadonlyArray<{ hexLabel: string; q: number; r: number }>;
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
  /** Places the token. The caller dispatches; this only asks. Design note #1331: `options` carries every
   *  legal home when there is more than one, so the map -- not this card -- takes the choice. */
  onPlace: (
    companyId: number,
    q: number,
    r: number,
    options?: ReadonlyArray<{ hexLabel: string; q: number; r: number }>,
  ) => void;
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
   *  changes is the verb and the absence of a button. Defaults `true` so an existing caller is unaffected.
   *
   *  PHASE 3 W2-H (OD-1): the facts are still one component's, but `false` now renders them as the non-modal
   *  `WaitingStatusBanner` rather than as this card under a full-screen scrim. App decides it with
   *  `homeStationViewerIsPresident` (W1-J), so a watcher or spectator is never handed the President's form. */
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
  const choices =
    pending.options && pending.options.length > 0
      ? pending.options
      : [{ hexLabel: pending.hexLabel, q: pending.q, r: pending.r }];
  const hexes = choices.map((option) => option.hexLabel).join(" or ");

  /* ==================================================================
      PHASE 3 W2-H (OD-1, H5): THE WAITING SEATS GET A STATUS, NOT THE SCRIM
     ==================================================================
     #783 gave the other seats the same card with the verb changed and the button gone -- the right facts, in a
     full-screen `aria-modal` scrim with nothing to focus (the modal audit's H5). OD-1 keeps the facts and drops the
     scrim: who must place it, which corporation, where, and why the table has stopped, in a non-modal status the
     keyboard can reach. Still no control, disabled or otherwise (#783). A watcher and a spectator land here by the
     same rule (`homeStationViewerIsPresident`), never on the President's form.
     TIMING THAT IS TRUE (K-21 / U-32): the stop is the corporation's FIRST OPERATING TURN, which cannot proceed
     until the home is down -- the authority's own hold sentence says exactly that. Not "has floated": the float
     happened in a Stock Round and owed nothing then (#1610). */
  if (!viewerIsPresident) {
    return (
      <WaitingStatusBanner
        heading={`${pending.ticker} must place its home station`}
        accentColor={liveryColor}
        accentInk={liveryInk}
        accentContent={
          <CorporateLogo
            ticker={pending.ticker}
            size={22}
            color={liveryInk}
            title={fullName ?? pending.ticker}
            fallbackStyle={styles.bannerTicker}
          />
        }
        testId="home-station-waiting"
      >
        {/* Says WHO and says the game is waiting rather than broken -- the two things #783's report identified as
           missing. No estimate of how long: this clears on an action, not a timer. */}
        Waiting for {presidentLabel ?? `the ${pending.ticker} President`} to place the {pending.ticker} home station on{" "}
        {hexes}. The {pending.ticker} is starting its first operating turn and cannot operate until its home station
        is on the board. Play resumes as soon as it is down.
      </WaitingStatusBanner>
    );
  }

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
          {/* Design note #783: the heading NAMES the president. Since W2-H only the President's own screen renders
             this card -- every other seat gets the waiting status above -- so it addresses its reader directly. */}
          {presidentLabel ? `${presidentLabel} — place the home station` : "Place the home station"}
        </span>

        <p style={styles.body}>
          {/* K-21 / U-32 (Phase 3 W2-H): WAS "The X has floated." The card no longer appears at the float -- a Stock
             Round float owes nothing (#1610) -- but at the start of the corporation's first operating turn, which
             is held until the home is down. The sentence now says that, in the authority's own terms. */}
          The {pending.ticker} is starting its first operating turn and its home station is not on the board yet.
          As President you place its first station token, free, on its printed home hex before it can operate.
        </p>

        {/* The hex, given the emphasis of the thing the player is being
            asked to act on. Naming it is what makes a confirmation an
            adequate substitute for hunting the map for it. */}
        <div style={styles.hexRow}>
          <span style={styles.hexLabelCaption}>{choices.length > 1 ? "Home hexes" : "Home hex"}</span>
          <span style={styles.hexLabel}>{hexes}</span>
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
            Two different conditions for "is this mine to do" is how the two come apart.
            W2-H: that gate is now the early return above -- the waiting status carries neither this line nor
            the button, and this card is the President's alone. */}
        <span style={styles.consequence}>
          {choices.length > 1
            ? `Printed on the board and fixed by the rules — the ${pending.ticker} may sit in either, and its herald reserves both until it does.`
            : `Printed on the board and fixed by the rules — the ${pending.ticker} has no other legal home.`}
        </span>

        {/* Design note #440: this OPENS THE MAP; it does not place. The
            caller arms the placement cursor, veils the board down to this
            one hex and navigates there, so the token goes down under the
            player's own click on the board it belongs to. */}
        {/* Design note #783: NO BUTTON FOR A WATCHER. A disabled control would invite the click this modal
           exists to explain away, and #763's gate would refuse it silently -- confusion on top of confusion. */}
        {/* Design note #1325 put ONE BUTTON PER HOME here. Design note #1331 (15) takes it back to ONE BUTTON:
           "Place Home Station on K13 or L14", and the map lights both -- the choice is made where the hexes
           are, by the same click a single-home corporation already makes. The card names them; the board
           takes the answer. */}
        <button
          type="button"
          style={styles.confirm}
          onClick={() =>
            onPlace(pending.companyId, choices[0].q, choices[0].r, choices.length > 1 ? choices : undefined)
          }
        >
          Place Home Station on {hexes} &#8250;
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
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
    overflow: "hidden",
    /* ==================================================================
        DESIGN NOTE 926: THE CARD NEEDED A FLOOR
       ==================================================================
       REPORTED: "the Home Station modal for non-president players is missing bottom margin/padding. The edge
       of the 'Home Hex: XXX' panel is touching the absolute bottom edge of the modal."
       AND IT ONLY SHOWS FOR A WATCHER, which is why it survived: the card's children each carry their own
       padding and the last of them was always the BUTTON row, whose padding was doing double duty as the
       card's floor. #783 took the button away from watchers and #912 took the rules line, so the hex panel
       became the last child and there was nothing underneath it.
       ON THE CARD RATHER THAN ON THE HEX PANEL, because the next element to become last should not have to
       rediscover this. `overflow: hidden` plus the livery header's own full-bleed padding means a top pad
       here would double up, so only the bottom is set. */
    paddingBottom: "16px",
  },
  livery: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 20px",
  },
  liveryTicker: { fontSize: FONT_SIZE.heading, fontWeight: 800, letterSpacing: "0.04em" },
  liveryName: { fontSize: FONT_SIZE.body, fontWeight: 700, opacity: 0.9 },
  bannerTicker: { fontSize: FONT_SIZE.small, fontWeight: 800, letterSpacing: "0.04em" },
  heading: { padding: "0 20px", fontSize: FONT_SIZE.heading, fontWeight: 800 },
  body: {
    margin: 0,
    padding: "0 20px",
    fontSize: FONT_SIZE.body,
    lineHeight: 1.5,
    color: "#a8a6a0",
  },
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
  consequence: {
    padding: "0 20px",
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.5,
    color: "#a8a6a0",
  },
  confirm: {
    margin: "0 20px 20px",
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

export default HomeStationPrompt;
