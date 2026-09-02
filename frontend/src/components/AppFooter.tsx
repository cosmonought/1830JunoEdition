// frontend/src/components/AppFooter.tsx
//
// The one thing at the bottom of the page that is about the app rather than about the game.
//
// ==================================================================
//  DESIGN NOTE 1083: A FOOTER, BECAUSE AN ATTRIBUTION IS NOT A CONTROL
// ==================================================================
//
// RULED: "Move the 'Powered by Neta DAO' text out of the title area and anchor it in the global app footer."
//
// THERE WAS NO GLOBAL APP FOOTER, which is the part worth writing down: this shell has a header, a tab strip,
// a viewport and a fixed status dock, and nothing that means "the page ends here". The credit was in the
// header because the header was the only chrome that existed to put it in, not because it belonged there.
//
// #47's ARGUMENT SURVIVES THE MOVE. It placed the credit beside the brand so "an attribution belongs next to
// the thing attributed" -- and a footer under the whole application is adjacent to the whole application,
// which is if anything the truer reading. What it stops doing is competing for the most valuable strip on
// screen with the room code and the wallet cluster.
//
// IN THE FLOW, NOT FIXED. `statusLineDock` is the fixed thing at the bottom of this shell and it is fixed for
// a reason -- it is a status line a player consults mid-scroll. A credit is read once, so pinning it would
// spend permanent viewport height on a link nobody needs twice. It sits at the end of the document, above the
// root's bottom padding, and the dock floats over the page as it always has.
//
// See docs/ai_architecture/ui_shell_layout.md, AppFooter.tsx #1083.

import React from "react";

import { styles } from "../styles/appStyles";
import NetaMark from "./NetaMark";

/* Inline styles cannot express `:hover` or `:focus-visible`; see design note #46. Moved here verbatim with
   the link it styles -- leaving it in `TopBar` would have left a rule for an element that file no longer
   renders, which is the orphan this batch is clearing out. */
const NETA_CREDIT_CSS = `
.neta-credit { transition: color 120ms ease, text-shadow 120ms ease; }
.neta-credit:hover { color: #f2f0eb; text-shadow: 0 0 8px rgba(255,255,255,0.35); }
.neta-credit:focus-visible { outline: 2px solid #8a8a86; outline-offset: 2px; color: #f2f0eb; }
`;

export function AppFooter() {
  return (
    <footer style={styles.appFooter}>
      <style>{NETA_CREDIT_CSS}</style>
      {/* `rel="noopener noreferrer"` because `target="_blank"` without it hands the new tab a `window.opener`
          handle back into this app -- #47's rule, carried with the link rather than rediscovered. */}
      {/* Design note #1099: the logo and the words are ONE link, not a logo beside a link. Two adjacent
          controls going to the same place is two tab stops and two things to announce for one destination;
          `NetaMark` takes `labelled={false}` for the same reason -- the anchor's own text is the name. */}
      <a
        href="https://netadao.org"
        target="_blank"
        rel="noopener noreferrer"
        className="neta-credit"
        style={styles.netaCredit}
        title="Neta DAO — opens netadao.org in a new tab"
      >
        <NetaMark height={18} labelled={false} />
        Powered by Neta DAO
      </a>
    </footer>
  );
}

export default AppFooter;
