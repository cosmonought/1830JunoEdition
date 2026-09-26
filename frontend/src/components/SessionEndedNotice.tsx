// frontend/src/components/SessionEndedNotice.tsx
//
// LIVE-2B (LIVE-2 §4.1): THE EXPLICIT NEW-GUEST DECISION. When the server says this browser's session has ended
// (`401 session-ended`), the links stop and this notice asks the player. Only the button replaces the identity
// -- `POST /gs/api/session {"fresh": true}` -- and then the page reloads under the new guest. There is no
// automatic path and no console-only one. Seat transfer and recovery are LIVE-2E's; this says so plainly.

import React, { useEffect, useState } from "react";

import { sessionEndedSentence, sessionPort, type SessionPort } from "../utils/sessionBootstrap";

export function SessionEndedNotice({ port = sessionPort() }: { port?: SessionPort }): JSX.Element | null {
  const [state, setState] = useState(port.state);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setState(port.state);
    return port.subscribe(() => setState(port.state));
  }, [port]);
  if (state !== "ended") return null;
  const continueFresh = async () => {
    setBusy(true);
    setFailed(false);
    const next = await port.startFresh();
    if (next === "ready") {
      window.location.reload();
      return;
    }
    setBusy(false);
    setFailed(true);
  };
  return (
    <div
      role="alertdialog"
      aria-labelledby="session-ended-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.6)",
      }}
    >
      <div style={{ maxWidth: 420, padding: 24, borderRadius: 8, background: "#1d2230", color: "#f2f2f2", fontFamily: "sans-serif" }}>
        <h2 id="session-ended-title" style={{ marginTop: 0 }}>
          Your session on this browser has ended
        </h2>
        <p>{sessionEndedSentence(port.endedReason)}</p>
        <p>
          Continuing starts over as a new guest. Seats held by the old session stay with it; moving a seat to a new
          session is not available yet.
        </p>
        <button type="button" onClick={() => void continueFresh()} disabled={busy} style={{ padding: "8px 16px", fontSize: 16 }}>
          {busy ? "Starting…" : "Continue as a new guest"}
        </button>
        {failed ? <p role="alert">The game server could not be reached. Try again in a moment.</p> : null}
      </div>
    </div>
  );
}
