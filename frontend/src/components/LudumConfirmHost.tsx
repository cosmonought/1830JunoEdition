// frontend/src/components/LudumConfirmHost.tsx
//
// ==================================================================
//  LUDUM v1.1: "CONFIRM IT'S YOU", THEN BACK TO LUDUM (`?ludum=confirm&return=<path>`)
// ==================================================================
//
// A conduct reviewer's decision on Ludum needs this session's live sensitive grant. Ludum never asks for the password:
// it links here, Play's own `ConfirmItsYou` asks (showing which app and site is asking), and on the server's grant the
// browser goes back to the checked Ludum URL (`utils/ludumReturn.ts`). Cancel stays on Play.
//
// And `?ludum=signout&return=<path>`: Ludum's "Sign out" -- one press here ends this browser's session (Play's own
// sign-out), then back to Ludum. A link alone never signs anyone out.

import React, { useState, useSyncExternalStore } from "react";

import { ConfirmItsYou } from "./ConfirmItsYou";
import { NativeModal } from "./NativeModal";
import { disabledLook, profileStyles as styles } from "./profileStyles";
import { profileErrorSentence, signOutThisDevice } from "../utils/profileApi";
import { closeLudumConfirm, ludumPrompt, subscribeLudumConfirm } from "../utils/ludumReturn";
import type { SessionPort } from "../utils/sessionBootstrap";

const scrim: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "16px",
  boxSizing: "border-box",
  backgroundColor: "rgba(0, 0, 0, 0.6)",
  overflowY: "auto",
};

function SignOutCard({ port, target, navigate }: { port?: SessionPort; target: string; navigate: (url: string) => void }): JSX.Element {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = async () => {
    setWorking(true);
    setError(null);
    const result = await signOutThisDevice(port);
    setWorking(false);
    if (!result.ok) {
      setError(profileErrorSentence(result));
      return;
    }
    closeLudumConfirm();
    navigate(target);
  };
  return (
    <>
      <h2 style={styles.heading}>Sign out</h2>
      <p style={styles.label}>Sign out of Play and Ludum on this browser? Your other devices stay signed in.</p>
      <div style={styles.row}>
        <button type="button" style={disabledLook(styles.primary, working)} disabled={working} onClick={() => void signOut()} data-testid="ludum-signout-confirm">
          {working ? "Signing out…" : "Sign out"}
        </button>
        <button type="button" style={disabledLook(styles.secondary, working)} disabled={working} onClick={closeLudumConfirm}>
          Stay signed in
        </button>
      </div>
      {error ? (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      ) : null}
    </>
  );
}

export function LudumConfirmHost({ port, navigate = (url) => window.location.assign(url) }: { port?: SessionPort; navigate?: (url: string) => void }): JSX.Element | null {
  const prompt = useSyncExternalStore(subscribeLudumConfirm, ludumPrompt, ludumPrompt);
  if (prompt === null) return null;
  const target = prompt.target;
  if (prompt.mode === "signout") {
    return (
      <NativeModal name="Sign out" dismissible onDismiss={closeLudumConfirm} restoreOpener={false} scrimStyle={scrim} testId="ludum-signout">
        <div style={{ ...styles.card, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }} onClick={(event) => event.stopPropagation()}>
          <SignOutCard port={port} target={target} navigate={navigate} />
        </div>
      </NativeModal>
    );
  }
  return (
    <NativeModal name="Confirm it’s you" dismissible onDismiss={closeLudumConfirm} restoreOpener={false} scrimStyle={scrim} testId="ludum-confirm">
      <div style={{ ...styles.card, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }} onClick={(event) => event.stopPropagation()}>
        <h2 style={styles.heading}>Continue to Ludum</h2>
        <ConfirmItsYou
          purpose="To review conduct cases on Ludum"
          port={port}
          showOrigin
          testIdPrefix="ludum-confirm"
          cancelLabel="Stay on Play"
          onCancel={closeLudumConfirm}
          onConfirmed={() => {
            closeLudumConfirm();
            navigate(target);
          }}
        />
      </div>
    </NativeModal>
  );
}

export default LudumConfirmHost;
