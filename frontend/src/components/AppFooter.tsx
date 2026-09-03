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

/* Design note #1124: the board's mark is unchanged at #1099's 18px. The meta surfaces double it, which is
   what makes the orbit legible as motion rather than as a flicker -- at 18px the bar travels about nine
   pixels a lap, which is small enough to read as noise. */
const GAME_MARK_HEIGHT = 18;
const META_MARK_HEIGHT = 36;

export interface AppFooterProps {
  /** Design note #1113: the lobby and the waiting room get the moving mark; the board gets the still one.
   *  Named for the SURFACE rather than passed as `animated`, so the call site states where it is and this
   *  file keeps the rule about what that means. */
  surface: "meta" | "game";
}

export function AppFooter({ surface }: AppFooterProps) {
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
        {/* ==================================================================
            DESIGN NOTE 1124: #1116 REFUSED TO GROW THIS AND WAS ANSWERING A DIFFERENT QUESTION
           ==================================================================
           REPORTED: "the animated mark is far too small for its animation to register" -- a guess of 2x, with
           1.5x maybe scraping by.
           #1116 TURNED DOWN EXACTLY THIS AND ITS REASONING STILL HOLDS WHERE IT APPLIED. That note was about
           PARITY: the clip's mark was 49% smaller than the image's at a shared 18px, and it fixed the ratio by
           cropping the asset rather than by growing the element, because "a 36px box in an 18px line is a
           taller footer on every screen."
           ON EVERY SCREEN IS THE PART THAT WAS TOO BROAD. The game footer draws the STILL image -- `animated`
           is false there -- so growing the moving one cannot touch it. And the objection was never really
           about size, it was about a tall footer under a hex map where movement in the corner pulls an eye
           that is counting revenue. The lobby and the waiting room are screens where nothing is being
           counted; they are the surfaces #1113 gave the animation to for that exact reason.
           SO THE SIZE FOLLOWS THE SURFACE, like `animated` already does. 36px on meta, 18px unchanged on the
           board -- the doubling that was asked for, spent only where #1116's objection does not reach. One
           constant, so dialling it back to 1.5x is a single edit. */}
        <NetaMark
          height={surface === "meta" ? META_MARK_HEIGHT : GAME_MARK_HEIGHT}
          labelled={false}
          animated={surface === "meta"}
        />
        Powered by Neta DAO
      </a>
    </footer>
  );
}

export default AppFooter;
