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

/* ==================================================================
    DESIGN NOTE 1129: 2x OVERSHOT, 1.7x IS THE SIZE
   ==================================================================
   #1124 DOUBLED IT ON AN EYEBALLED GUESS -- "I would guess it needs to be doubled, but 1.5x might barely
   scrape by" -- and 36px came back too big: "it's now too large, I guess we went 2x and maybe 1.7x is the
   right call." 31px is that, rounded from 30.6.
   THE MARK IS NOT THE WHOLE UNIT, which is the other half of the same report: "make sure the 'Powered by Neta
   DAO' is centred to the animated logo so that it reads as a single unit, and perhaps nudge the size of that
   text up slightly to keep them proportional."
   SO THE CREDIT'S TYPE SCALES WITH THE MARK. `micro` beside an 18px mark was proportionate; beside a 31px one
   it reads as a caption someone left next to a logo. The meta surfaces take `small`, the board keeps `micro`
   -- which is the same surface-driven rule the height already follows, applied to the thing standing next
   to it. Two sizes that move together, rather than one growing and the other staying put.
   THE FRAME WAS ALREADY CENTRED and was measured rather than assumed: the orbit's ink bounding box across all
   frames sits at y 1-94 of 96, an offset of half a pixel. `alignItems: center` was doing its job; what made
   the pair read as two objects was the SCALE MISMATCH and the gap, not the alignment. */
const GAME_MARK_HEIGHT = 18;
const META_MARK_HEIGHT = 31;

export interface AppFooterProps {
  /** Design note #1113: the lobby and the waiting room get the moving mark; the board gets the still one.
   *  Named for the SURFACE rather than passed as `animated`, so the call site states where it is and this
   *  file keeps the rule about what that means. */
  surface: "meta" | "game";
}

/* ==================================================================
    DESIGN NOTE 1132: THE MARK NEEDS A GROUND, NOT A PAGE
   ==================================================================
   REPORTED: "the Neta DAO footer logo also appears to now be in a black box and has dropped the 'Powered by
   Neta DAO' string." BOTH ARE THE LOBBY'S NEW PHOTOGRAPH, arriving underneath a footer that had always stood
   on flat ink.
   THE BOX is `mix-blend-mode: screen` with nothing useful behind it. The clip is bright-on-black, and screen
   only erases that black when the backdrop is dark AND reachable -- over a lit photograph, or cut off from it
   by a stacking context, the black stops being erased and becomes a rectangle.
   THE MISSING WORDS are `#8a8a86` at `small`, a tone chosen for a near-black ground, disappearing into a
   brown leather chair.
   SO THE META FOOTER CARRIES ITS OWN INK. An opaque strip is what both halves were always assuming, and
   saying so here is cheaper and far more predictable than requiring every surface that might sit behind this
   footer to be dark. The board's footer is untouched: it never had a photograph to contend with.
   FLUSH LEFT, raised in the same breath -- "maybe the 'Powered by Neta DAO' unit needs to be flush left or
   flush right". Left, because this is a bar now rather than a centred credit, and a bar reads from its
   leading edge. */
export function AppFooter({ surface }: AppFooterProps) {
  return (
    <footer style={{ ...styles.appFooter, ...(surface === "meta" ? styles.appFooterMeta : {}) }}>
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
        style={{
          ...styles.netaCredit,
          ...(surface === "meta" ? styles.netaCreditMeta : {}),
        }}
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
