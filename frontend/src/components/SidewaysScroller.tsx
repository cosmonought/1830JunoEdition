// A region that scrolls sideways, and says so -- but only when it actually does.
//
// ==================================================================
//  DESIGN NOTE 1433: THE TABLE THAT KEPT ITS LAST COLUMN A SECRET
// ==================================================================
//
// REPORTED, off the 430px capture of the Game Ledger: Bank Treasury's `Value` column is off-screen, and the
// Bank Depot and Corporation Assets tables "continue sideways without a clear indication". MEASURED before
// anything was written: at 430 the three tables are 480, 986 and 1265 CSS px inside a 309px region, putting
// their last columns 171, 677 and 956px past the right edge. At 1024 the first fits and the other two still
// hide 83 and 362px. Nothing on screen said so, and a trackpad draws no scrollbar until it is used.
//
// THE CUE IS THE ONE THE RULES REFERENCE ALREADY USES, deliberately -- "Scroll sideways for the rest of the
// table" in the same muted line, because a player who has met it on that tab should not have to learn a
// second vocabulary for the same fact. This file does NOT import it from there: `RulesReference.tsx` keeps a
// private `useScrollsSideways` of its own and this pass was scoped away from that file. The duplication is
// deliberate, small and temporary -- when `RulesReference` is next in scope it should import from here and
// delete its copy. `ledgerScrollCue.test.ts` pins the two spellings together so they cannot drift meanwhile.
//
// MEASURED, NOT MEDIA-QUERIED. A width threshold would be a guess about when a table is wider than its pane,
// and the answer moves with the chrome's zoom, the column set and the tab. This reads `scrollWidth` against
// `clientWidth` and re-reads it whenever the box resizes.
//
// AND THE REGION IS REACHABLE BY KEYBOARD. A `overflow-x: auto` div is not a tab stop in every engine, so a
// keyboard-only player could see the cue and have no way to act on it. `tabIndex={0}` with `role="region"`
// and a name makes it focusable, arrow-scrollable, and announced as the thing it is.

import React, { useLayoutEffect, useRef, useState } from "react";

import { FONT_SIZE } from "../styles/typography";
import { INK_TEXT_FAINT } from "../styles/palette";

/** Whether a box is wider than the space it has. `token` re-measures when the CONTENT changes rather than
 *  the box -- a `ResizeObserver` on a full-width region never fires when its own children change. */
export function useScrollsSideways(ref: React.RefObject<HTMLElement | null>, token = ""): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setScrolls(node.scrollWidth > node.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, token]);
  return scrolls;
}

export const SIDEWAYS_CUE = "Scroll sideways for the rest of the table →";

const styles: Record<string, React.CSSProperties> = {
  region: {
    overflowX: "auto",
    width: "100%",
    minWidth: 0,
    /* ==================================================================
        DESIGN NOTE 1436: THE CLIPPED TABLE STILL WIDENED THE PAGE
       ==================================================================
       REPORTED, and the one defect #1433 left behind: at 430 the Game Ledger scrolled the WHOLE PAGE sideways
       -- `documentElement.scrollWidth` 583 against a 430 viewport, and `window.scrollX` really reaching 153.
       WHAT IT IS NOT, each ruled out by measurement rather than by reasoning:
         - not a box sticking out. Every ancestor of the widest table ends inside the viewport: 371, 385, 410,
           430, 430. No element in the document has a right edge past 430 that is not already clipped.
         - not something drawn out there. Scrolled to x=153, `elementsFromPoint(429, y)` returns bare `<html>`
           at every y down the page: the extra 153px is empty. The scroller IS clipping the paint.
         - not `<details display:flex>` leaking through its UA slot, which was the standing theory. Setting the
           sections to `display: block` changes nothing.
         - not a missing `min-width: 0`, and not a clip: `overflow-x: clip` on the region, on the Ledger's own
           root and on the shell's pane all leave it at 583.
       WHAT IT IS: a clipped scroller's descendants still contribute their intrinsic width to the INITIAL
       CONTAINING BLOCK's scrollable overflow. The 986px table is painted inside 309px and counted at 986.
       `contain: layout` is the fix that matches the cause -- it makes this box an independent layout context,
       so what happens inside it stops being the viewport's business. Measured: 583 -> 430 and scrollX 153 -> 0,
       with all three scrollers unchanged at 309/480, 309/986 and 309/1265.
       `layout`, NOT `paint`, DELIBERATELY. Both fix the number. `paint` would additionally clip everything
       drawn inside to this box, and these cells carry train chips and private-company pills that are entitled
       to overhang; `layout` isolates the geometry and leaves the painting alone.
       AND IT IS ON THIS BOX, not on the document or the shell. A blanket `overflow-x: hidden` up there would
       hide the symptom for every tab -- including the Rail Map, whose own panning depends on that overflow. */
    contain: "layout",
  },
  cue: { display: "block", fontSize: FONT_SIZE.small, color: INK_TEXT_FAINT, lineHeight: 1.4, paddingTop: "4px" },
};

/** The scrolling region plus its cue. `label` names the region for a screen reader and for the focus ring. */
export function SidewaysScroller({
  label,
  token,
  children,
}: {
  label: string;
  /** Anything that changes the CONTENT's width -- a row count, a variant -- so the measure runs again. */
  token?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrolls = useScrollsSideways(ref, token ?? "");
  return (
    <>
      <div
        ref={ref}
        style={styles.region}
        /* Only a scrollable region is a region: an announced landmark around a table that fits would be
           noise, and a tab stop that does nothing is worse than none. */
        role={scrolls ? "region" : undefined}
        aria-label={scrolls ? `${label} — scrolls sideways` : undefined}
        tabIndex={scrolls ? 0 : undefined}
      >
        {children}
      </div>
      {scrolls && (
        <span style={styles.cue} data-testid="ledger-scroll-cue">
          {SIDEWAYS_CUE}
        </span>
      )}
    </>
  );
}
