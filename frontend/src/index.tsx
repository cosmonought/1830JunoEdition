// frontend/src/index.tsx
//
// React 18 entry point: mounts <App /> (see ./App.tsx) into the page.
//
// Design notes:
// 1. Uses `react-dom/client`'s `createRoot` (the React 18 concurrent-root
//    API), not the legacy `react-dom` `ReactDOM.render` -- the latter is
//    deprecated under React 18 and prints a console warning if used.
// 2. ASSUMPTION (unverified in this pass): this expects an `index.html`
//    with a `<div id="root"></div>` mount node, the standard scaffold for
//    both Create React App and Vite. No `index.html`/`public/` folder was
//    present alongside `src/` at the time this file was written -- if your
//    scaffold uses a different mount element id, or doesn't have an
//    `index.html` yet at all, update `ROOT_ELEMENT_ID` below (or add the
//    missing `index.html`) to match.
// 3. Wrapped in `React.StrictMode` for the usual development-time benefits
//    (extra checks, double-invoked effects to surface impure code) -- has
//    no effect on production builds.

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";

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
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
