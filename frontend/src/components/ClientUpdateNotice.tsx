// frontend/src/components/ClientUpdateNotice.tsx
//
// LIVE-4 (L4-3): WHAT THE PAGE SAYS WHEN IT WILL NOT RELOAD (OR ROUTE) BY ITSELF. The links end a link the server told
// `reload` or `route` and hand the decision to the page's port (`utils/clientUpdate.ts`). Usually the page simply
// reloads once, and this notice never shows. It shows when that did not help -- the same answer came back after the
// reload -- or when the page cannot remember that it already tried (no storage), or when a route could not be followed:
// then it says why, in plain words, and the player decides. Reload reloads the page (the table is kept); for an answer
// about one table, "Back to the lobby" forgets which table this tab was at and reloads into the lobby -- nothing is sent
// to the server and the seat stays the player's. Mounted beside `SessionEndedNotice` (`index.tsx`), outside the app, so
// it covers whatever screen the answer found.

import React, { useCallback, useSyncExternalStore } from "react";

import { clientUpdateNotice, clientUpdatePort, type ClientUpdatePort } from "../utils/clientUpdate";
import { profileStyles as styles } from "./profileStyles";

export function ClientUpdateNotice({ port = clientUpdatePort() }: { port?: ClientUpdatePort }): JSX.Element | null {
  const subscribe = useCallback((notify: () => void) => port.subscribe(notify), [port]);
  /* A primitive snapshot (the state's JSON): React compares strings, so a new-but-equal state renders nothing new. */
  useSyncExternalStore(subscribe, () => JSON.stringify(port.state));
  const notice = clientUpdateNotice(port.state);
  if (notice === null) return null;
  return (
    <div role="alertdialog" aria-labelledby="client-update-title" style={styles.overlay} data-testid="client-update-notice">
      <div style={{ ...styles.card, maxWidth: "440px" }}>
        <h2 id="client-update-title" style={styles.heading}>
          {notice.title}
        </h2>
        <p style={styles.text}>{notice.body}</p>
        <div style={styles.row}>
          <button type="button" onClick={() => port.reloadNow()} style={styles.primary} data-testid="client-update-reload">
            Reload
          </button>
          {notice.lobby ? (
            <button type="button" onClick={() => port.backToLobby()} style={styles.secondary} data-testid="client-update-lobby">
              Back to the lobby
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
