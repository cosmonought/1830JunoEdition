// frontend/src/components/MarketPeekModal.tsx
//
// ==================================================================
//  DESIGN NOTE 1141: THE FRAME AROUND THE MINI-CAMERA
// ==================================================================
//
// SPLIT FROM `StockMarketPreview` DELIBERATELY. That component draws a 5x5 window of the chart and knows
// nothing about how it is presented; this one is the dialog -- the backdrop, the Escape key, the focus
// return -- and knows nothing about the market. The Stock Round will summon the same preview from a
// different control, and a preview welded to its own modal could not be reused there without bringing a
// backdrop it did not want.
//
// THE DIALOG RULES ARE `TileSelectionPopup`'s AND `ConnectWalletButton`'s, not new ones: Escape closes, a
// click on the backdrop closes, the panel itself swallows the click so a press inside does not dismiss it,
// and focus goes back where it came from. Restated here rather than imported because those two implement it
// against their own markup; what is shared is the RULE, and it is short enough that a helper indirecting
// three listeners would cost more to read than it saves.

import React from "react";

import StockMarketPreview from "./StockMarketPreview";
import { type MarketPositionEntry } from "./StockMarketRenderer";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { INK_TEXT, INK_TEXT_MUTED, RULE } from "../styles/palette";

export interface MarketPeek {
  company: { company_id: number; ticker: string };
  startNode: { x: number; y: number };
  projectedNode: { x: number; y: number } | null;
  action: "pay" | "withhold" | "sell";
}

const TITLE: Readonly<Record<MarketPeek["action"], string>> = {
  pay: "If you pay dividends",
  withhold: "If you withhold",
  sell: "If you sell",
};

export function MarketPeekModal({
  peek,
  positions,
  onClose,
}: {
  peek: MarketPeek;
  positions: readonly MarketPositionEntry[];
  onClose: () => void;
}) {
  /* Design note #1141: focus goes back to the control that opened this. Without it a keyboard player who
     closes the dialog is returned to the top of the document, several hundred elements from the button they
     pressed -- which on this panel means finding the dividend columns again. */
  const openerRef = React.useRef<Element | null>(null);
  React.useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={styles.backdrop}
      role="presentation"
      onClick={onClose}
    >
      <div
        style={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={`${TITLE[peek.action]}: ${peek.company.ticker} on the market chart`}
        /* The panel swallows its own clicks, or every press inside the dialog would reach the backdrop and
           dismiss it -- including the press that starts a drag on the chart. */
        onClick={(event) => event.stopPropagation()}
      >
        <div style={styles.head}>
          <span style={styles.title}>
            {TITLE[peek.action]} &middot;{" "}
            <span style={styles.ticker}>{peek.company.ticker}</span>
          </span>
          <button type="button" style={styles.close} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <StockMarketPreview
          company={peek.company}
          startNode={peek.startNode}
          projectedNode={peek.projectedNode}
          positions={positions}
          action={peek.action}
        />
      </div>
    </div>
  );
}

export default MarketPeekModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* Above `statusLineDock` and the sticky action bar, both of which are pinned and would otherwise sit on
       top of a dialog summoned from the panel between them. */
    zIndex: 30000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(8, 8, 8, 0.72)",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    /* ==================================================================
        DESIGN NOTE 1156: THE DIALOG GREW SO THE CHART DID NOT HAVE TO SHRINK
       ==================================================================
       420px was sized for #1141's 5x5 window. The whole board is 19 columns, which at that width is 22px a
       column -- narrower than a token and far too narrow for a three-digit price -- so showing all of it
       needed the dialog to grow rather than the cells to disappear.
       `min(96vw, ...)` KEEPS THE PHONE CASE HONEST: on a narrow screen the dialog is the screen and the chart
       scrolls inside it, which is better than 120 cells rendered below legibility. */
    maxWidth: "min(96vw, 900px)",
    maxHeight: "min(88vh, 620px)",
    overflow: "auto",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  title: { fontSize: FONT_SIZE.small, color: INK_TEXT_MUTED, fontWeight: 600 },
  ticker: { color: INK_TEXT, fontWeight: 800 },
  close: {
    width: "24px",
    height: "24px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    fontSize: FONT_SIZE.heading,
    lineHeight: 1,
    borderRadius: RADIUS.control,
    border: `1px solid ${RULE}`,
    backgroundColor: "transparent",
    color: INK_TEXT_MUTED,
    cursor: "pointer",
  },
};
