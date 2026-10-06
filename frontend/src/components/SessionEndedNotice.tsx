// frontend/src/components/SessionEndedNotice.tsx
//
// LIVE-2B (LIVE-2 §4.1): THE EXPLICIT DECISION AFTER A SESSION ENDS. When the server says this browser's session has
// ended (`401 session-ended`), the links stop and this notice asks the player. Only the button replaces the session
// -- `POST /gs/api/session {"fresh": true}` -- and then the page reloads. There is no automatic path and no
// console-only one.
//
// LIVE-2E / P3-ACCT: "Continue" never starts anybody new: it gives this browser a fresh, signed-out session and the
// reload lands on the public homepage, where "Log in" (username and password; "Forgot password?" with the account's
// Authorization Wallet) brings the SAME account back, with its seats, which the server kept all along. (PHASE 3 FINAL: a
// `retired` session belonged to an account made before Authorization Wallets -- its owner makes a new account.)

import { forgetActiveTable } from "../utils/activeGame";
import React, { useState } from "react";

import { sessionEndedSentence, sessionPort, type SessionPort } from "../utils/sessionBootstrap";
import { useSession } from "../utils/useSession";
import { disabledLook, profileStyles as styles } from "./profileStyles";

export function SessionEndedNotice({ port = sessionPort() }: { port?: SessionPort }): JSX.Element | null {
  const { state, endedReason } = useSession(port);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (state !== "ended") return null;
  const continueFresh = async () => {
    setBusy(true);
    setFailed(false);
    const next = await port.startFresh();
    if (next === "unprofiled" || next === "ready") {
      forgetActiveTable();
      window.location.reload();
      return;
    }
    setBusy(false);
    setFailed(true);
  };
  return (
    <div role="alertdialog" aria-labelledby="session-ended-title" style={styles.overlay}>
      <div style={{ ...styles.card, maxWidth: "440px" }}>
        <h2 id="session-ended-title" style={styles.heading}>
          You're signed out on this browser
        </h2>
        <p style={styles.text}>{sessionEndedSentence(endedReason)}</p>
        <p style={styles.text}>Your account and its seats are kept. Continue, then log in again to play on this browser.</p>
        <button
          type="button"
          onClick={() => void continueFresh()}
          disabled={busy}
          style={disabledLook(styles.primary, busy)}
          data-testid="session-ended-continue"
        >
          {busy ? "Continuing…" : "Continue"}
        </button>
        {failed ? (
          <p role="alert" style={styles.error}>
            The game server could not be reached. Try again in a moment.
          </p>
        ) : null}
      </div>
    </div>
  );
}
