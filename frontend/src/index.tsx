// React 18 entry point: mounts <App /> into the page.
//
// 1. `react-dom/client`'s `createRoot`, not the legacy `ReactDOM.render`, which
//    is deprecated under React 18 and warns.
// 2. ASSUMPTION (unverified in that pass): expects an `index.html` with
//    `<div id="root">`. No `public/` folder was present alongside `src/` when
//    this was written -- update `ROOT_ELEMENT_ID` for a different scaffold.
// 3. `React.StrictMode` for the development-time checks; no effect in
//    production builds.

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
// Design note #761: an uncaught render throw becomes a readable, copyable report instead of a blank page.
import { CrashScreen } from "./components/CrashScreen";
import { SessionEndedNotice } from "./components/SessionEndedNotice";
import { GAME_SERVER_URL } from "./config";
import { createAppSessionPort, installSessionPort } from "./utils/sessionBootstrap";

/* LIVE-2B (LIVE-2 §4.3): before any link opens a socket, the session is bootstrapped (`POST /gs/api/session`) -- the
   links ask this port first. A development-identity build (and a build with no game server) needs no bootstrap. */
installSessionPort(createAppSessionPort(GAME_SERVER_URL));

const ROOT_ELEMENT_ID = "root";

const container = document.getElementById(ROOT_ELEMENT_ID);
if (!container) {
  throw new Error(
    `frontend/src/index.tsx: no element with id "${ROOT_ELEMENT_ID}" was found in the page. ` +
      "Add a matching <div> to index.html (or update ROOT_ELEMENT_ID above) before mounting <App />.",
  );
}

const root = createRoot(container);
root.render(
  /* #761: OUTSIDE StrictMode, so the boundary is the outermost thing in the tree and catches a throw from
     anywhere below -- including one raised by StrictMode's own double-invoked render in development. */
  <CrashScreen>
    <React.StrictMode>
      <App />
      {/* LIVE-2B: the explicit "Continue as a new guest" decision when the server says the session ended. */}
      <SessionEndedNotice />
    </React.StrictMode>
  </CrashScreen>,
);
