// frontend/src/config/backend.ts
//
// Whether this build has a real-time backend, and the sentence to show when it does not.
//
// ==================================================================
//  DESIGN NOTE 1361: ONE BACKEND, ONE SWITCH
// ==================================================================
//
// This file replaces `config/firebase.ts`. That module initialised the Firebase app and Firestore lazily and
// answered `isFirebaseConfigured()` for every surface that needed to label itself honestly when the real-time
// layer was missing. The real-time layer is the game server now -- the log (#1213), the roster (#1215), chat
// and presence (#1361a) and the staging lobby (#1361b) all ride `REACT_APP_GAME_SERVER_URL` -- so the question
// "is there a backend?" has exactly one answer and it is the same switch `roomDocOnServer()` reads.
//
// Reading config never throws (the rule `config.ts #0` set): an unset URL degrades the real-time features and
// labels them, and the rail map, the tile catalogue and every on-chain query still work without it.

import { GAME_SERVER_URL } from "../config";

/** The configuration problem, or `null` when the game server is reachable in principle. Safe to call
 *  anywhere and never throws -- what the UI uses to explain itself. */
export function backendConfigError(): string | null {
  if (!GAME_SERVER_URL) {
    return (
      "[server] REACT_APP_GAME_SERVER_URL is not set, so real-time chat, rooms and the lobby are " +
      "unavailable. Add it to frontend/.env.local and RESTART the dev server — react-scripts substitutes " +
      "REACT_APP_* at build time. The rail map, tile catalog and every on-chain query work without it."
    );
  }
  if (!/^wss?:\/\//.test(GAME_SERVER_URL)) {
    return (
      `[server] REACT_APP_GAME_SERVER_URL is set to "${GAME_SERVER_URL}", which is not a ws:// or wss:// URL.`
    );
  }
  return null;
}

/** `false` means real-time features are off. Use it to LABEL the UI honestly, not to hide the failure. */
export function isBackendConfigured(): boolean {
  return backendConfigError() === null;
}
