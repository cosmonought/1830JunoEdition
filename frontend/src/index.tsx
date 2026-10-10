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
import { AccountPromptHost } from "./components/AccountDialog";
import { InfoPagesHost } from "./components/InfoPages";
import { SessionEndedNotice } from "./components/SessionEndedNotice";
import { ClientUpdateNotice } from "./components/ClientUpdateNotice";
import { GAME_SERVER_URL } from "./config";
import { createAppSessionPort, installSessionPort } from "./utils/sessionBootstrap";
import { createBrowserClientUpdatePort, installClientUpdatePort } from "./utils/clientUpdate";
import { handleLudumConfirm, handleLudumSignIn } from "./utils/ludumReturn";
import { LudumConfirmHost } from "./components/LudumConfirmHost";

/* LIVE-2B (LIVE-2 §4.3): before any link opens a socket, the session is bootstrapped (`POST /gs/api/session`) -- the
   links ask this port first. A development-identity build (and a build with no game server) needs no bootstrap.
   P3-ACCT (owner, 2026-10-05: PUBLIC FIRST): nothing waits behind it any more. LIVE-2E's `ProfileGate` is gone: the
   homepage renders at once, a visitor browses, reads and watches signed out, and an account is asked for only by an
   action that needs one (`utils/accountPrompt.ts`). */
installSessionPort(createAppSessionPort(GAME_SERVER_URL));
/* LIVE-4 (L4-3): the page's one answer to a server that says this bundle cannot play what it asked for -- reload once
   (keeping the table), follow a checked route, or ask; never a loop (`utils/clientUpdate.ts`). */
installClientUpdatePort(createBrowserClientUpdatePort());
/* LUDUM (§2.1): `?ludum=signin&return=<path>` -- the account dialog, then back to https://ludum.netadao.org<path> (at once
   when already signed in). Only a path matching `^/[a-z0-9/_-]{0,128}$`; anything else stays on Play. */
handleLudumSignIn({ search: window.location.search, navigate: (url) => window.location.assign(url) });
/* LUDUM v1.1: `?ludum=confirm&return=<path>` -- "Confirm it's you" here (the password is only typed on Play), then back. */
handleLudumConfirm({ search: window.location.search, navigate: (url) => window.location.assign(url) });

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
      {/* P3-ACCT: the app renders for everyone; the bootstrap runs in the background (the links ask the port). */}
      <App />
      {/* P3-ACCT: Log in / Create account, opened by an action that needs an account (and resuming it), or by the
          homepage's own buttons; the Rules and Terms reading pages. Each is a NativeModal in the app's modal layer. */}
      <AccountPromptHost />
      <LudumConfirmHost />
      <InfoPagesHost />
      {/* LIVE-2B: the explicit "Continue" decision when the server says the session ended (P3-ACCT: it leads back to
          the homepage, signed out, where Log in brings the account back). */}
      <SessionEndedNotice />
      {/* LIVE-4 (L4-3): shown only when a reload did not help, the page cannot remember that it tried, or a route
          could not be followed -- it says why and offers a Reload button. */}
      <ClientUpdateNotice />
    </React.StrictMode>
  </CrashScreen>,
);
