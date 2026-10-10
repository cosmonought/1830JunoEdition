// frontend/src/components/LudumConfirmHost.tsx
//
// ==================================================================
//  LUDUM v1.1: "CONFIRM IT'S YOU", THEN BACK TO LUDUM (`?ludum=confirm&return=<path>`)
// ==================================================================
//
// A conduct reviewer's decision on Ludum needs this session's live sensitive grant. Ludum never asks for the password:
// it links here, Play's own `ConfirmItsYou` asks (showing which app and site is asking), and on the server's grant the
// browser goes back to the checked Ludum URL (`utils/ludumReturn.ts`). Cancel stays on Play.

import React, { useSyncExternalStore } from "react";

import { ConfirmItsYou } from "./ConfirmItsYou";
import { NativeModal } from "./NativeModal";
import { profileStyles as styles } from "./profileStyles";
import { closeLudumConfirm, ludumConfirmTarget, subscribeLudumConfirm } from "../utils/ludumReturn";
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

export function LudumConfirmHost({ port, navigate = (url) => window.location.assign(url) }: { port?: SessionPort; navigate?: (url: string) => void }): JSX.Element | null {
  const target = useSyncExternalStore(subscribeLudumConfirm, ludumConfirmTarget, ludumConfirmTarget);
  if (target === null) return null;
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
