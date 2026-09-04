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
    DESIGN NOTE 1137: ONE HEIGHT, AFTER FOUR ATTEMPTS AT TWO
   ==================================================================
   THIS CONSTANT HAS MOVED FOUR TIMES -- 18 everywhere (#1099), 36 on meta (#1124), 31 (#1129), 28 (#1135) --
   and every move was reasoned about ONE screen while a second value sat beside it. The result is the report:
   the credit is "much smaller" in the game than in the lobby, which is not a bug in either value.
   28 IS THE SURVIVING NUMBER, from the lobby where it was last judged by eye. The board's footer grows by
   10px, which is the cost of the standardisation and is worth naming: #1116 and #1124 both defended 18 there,
   and both defended it against MOVEMENT under a hex map rather than against height. The board still draws the
   STILL mark, so that argument is untouched -- it is a taller static logo, not a moving one.

   ==================================================================
    DESIGN NOTE 1140: THE SIZES WERE ALREADY EQUAL, AND ONE SCREEN WAS DRAWING HALF A LOCKUP
   ==================================================================
   ASKED, after the standardisation: "the Lobby and Waiting Room ones look like they could shrink another 10%
   OR the Game Room could grow another 10% to try to get them closer in size."
   THERE IS NO GAP LEFT TO CLOSE. Since #1137 there is ONE height and ONE type size, read by all three
   screens from this constant and from `netaCredit` -- so a 10% move in either direction would not bring them
   together, it would push them apart again and re-create precisely the drift that report was about.
   WHAT WAS ACTUALLY DIFFERENT is in the same message: "'Powered by Neta DAO' doesn't render on the Lobby."
   The lobby was drawing the mark alone while the board drew mark-plus-words, and a lone 28px logo reads as a
   different size from a 28px logo with a caption beside it. The cause is #1140's z-index above; the sizes
   were never the thing.
   SO NOTHING MOVES HERE, deliberately, and this note exists so the next reader does not "fix" a discrepancy
   by editing a number that is already shared. If the three still look unequal once the words are back, the
   change is to THIS constant and it moves all three together. */
/* Design note #1135: "reduce the entire unit by 10%" -- 31 to 28 on the mark (-9.7%) and `small` to `micro`
   on the words (12px to 11px, -8.3%). Both land on real steps of the shared scale rather than on a computed
   fraction, and the RATIO between them barely moves (2.58 to 2.55), which is what keeps #1129's lockup from
   coming apart again at the smaller size. */
const MARK_HEIGHT = 28;

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
        {/* Design note #1137: the SIZE no longer follows the surface -- only the MOVEMENT does, which was
            always the distinction that mattered. #1113 gave the animation to the anteroom screens because a
            thing that moves under a hex map pulls an eye that is counting revenue; that argument is about
            motion and says nothing about height. One size, both surfaces. */}
        <NetaMark height={MARK_HEIGHT} labelled={false} animated={surface === "meta"} />
        Powered by Neta DAO
      </a>
    </footer>
  );
}

export default AppFooter;
