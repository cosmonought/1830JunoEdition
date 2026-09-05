// frontend/src/components/SpecialPowerBlock.tsx
//
// A private company's special power: one or two bullets, with the full rule behind a click.
//
// ==================================================================
//  DESIGN NOTE 772: BULLETS ON THE CARD, THE PARAGRAPH ON REQUEST
// ==================================================================
//
// REPORTED: "I think the Special Powers on the PC cards needs to be like 1-2 bullet items, and players can
// click a 'Full Rules' to read the full paragraph."
//
// THE AUCTION CARD PRINTED THE WHOLE PARAGRAPH, and six of them are on screen at once during the waterfall --
// which is the moment a player is comparing privates rather than learning one. #661 already made this
// argument for the trade panel and built the summary to fix it; the auction cards, the oldest surface, never
// got the benefit and still rendered `ability` whole.
//
// WHY A COMPONENT RATHER THAN A THIRD COPY OF THE PATTERN. `PrivateTradePanel` grew its own caret-and-detail
// disclosure, and this pass would have added two more inline in `WaterfallAuctionDashboard` -- three
// hand-built answers to "how does a player read a power here", which drift in the usual way: one of them
// gets an aria-controls fix and the others do not. One component, and the surfaces differ only in palette.
//
// PALETTE IS A PROP, NOT A THEME LOOKUP. The auction cards are light parchment and the trade panel is dark
// chrome, so a component that picked its own colours could only be right on one of them. The caller passes
// the three inks it is already using; nothing here reads a global.
//
// THE DISCLOSURE IS A BUTTON WITH `aria-expanded` AND `aria-controls`, and the paragraph it reveals carries
// the id it names. A div with an onClick reads to a screen reader as text that mysteriously changes.

import React, { useId, useState } from "react";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { abilitySummary, type PrivateCatalogEntry } from "../utils/privateCatalog";

export interface SpecialPowerBlockProps {
  entry: PrivateCatalogEntry;
  /** Ink for the bullet text. */
  ink: string;
  /** Ink for the "Special power" caption and the disclosure button. */
  captionInk: string;
  /** Background for the revealed paragraph -- a panel, so the long text reads as a different register. */
  detailBackground: string;
  /** Set false on a card that is only a record of a past sale (the sold card) to keep it compact. */
  showCaption?: boolean;
}

/** One or two bullets plus a "Full Rules" disclosure. Collapsed by default: the bullets are the card's
 *  content, and the paragraph is a thing a player asks for. */
export function SpecialPowerBlock({
  entry,
  ink,
  captionInk,
  detailBackground,
  showCaption = true,
}: SpecialPowerBlockProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  /* `useId` rather than the private's number: two of these can be on screen for the same private (a card and
     a panel), and duplicate ids would point both buttons at one paragraph. */
  const detailId = useId();

  return (
    <div style={styles.block}>
      {showCaption && (
        <span style={{ ...styles.caption, color: captionInk }}>Special power</span>
      )}
      <ul style={styles.list}>
        {entry.abilityBullets.map((bullet) => (
          <li key={bullet} style={{ ...styles.bullet, color: ink }}>
            {/* The marker is drawn, not inherited: inline styles cannot reach `::marker`, and a
                `listStyle` disc indents differently per engine in a card this narrow. */}
            <span aria-hidden="true" style={styles.marker}>
              &bull;
            </span>
            <span style={styles.bulletText}>{bullet}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-controls={detailId}
        style={{ ...styles.disclosure, color: captionInk }}
        title={open ? "Hide the full rule." : "Read the full rule."}
      >
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        {open ? "Hide Rules" : "Full Rules"}
      </button>
      {open && (
        <p
          id={detailId}
          style={{ ...styles.detail, color: ink, backgroundColor: detailBackground }}
        >
          {entry.ability}
        </p>
      )}
    </div>
  );
}

/** The same power as a single line, for a caller with one line to spend. Re-exported here so a surface
 *  choosing between the two shapes finds both in one place. */
export { abilitySummary };

/* ==================================================================
    DESIGN NOTE 1171: THE CARD'S SECTION LABEL, NOW THAT A SECOND SECTION WANTS ONE
   ==================================================================
   REPORTED: "didn't there used to be a table header saying 'Bidder' and 'Amount'... it is a little bit hard
   to tell where that information is when it just rolls under the special powers and Full Rules click."
   THERE NEVER WAS A COLUMN HEADER. The original card carried a `highestBidderLine` -- "Highest bidder: 0x1a2b
   -- 175 VGP" -- above the list, and its style is STILL in `WaterfallAuctionDashboard` as a dead declaration
   nothing renders. So the memory is real and the shape it is remembered in is not.
   AND THE ACTUAL FAULT IS ADJACENCY, not a missing header. This block announces itself with a caption; the
   bid list below it announced nothing at all. One labelled region followed by an unlabelled one reads as a
   continuation of the first, which is exactly the report: the bids "roll under" the powers.
   SO THE CAPTION LEAVES THIS FILE. It is the card's idiom for "a new section starts here" rather than this
   component's private decoration, and a second hand-typed copy of four properties in the dashboard is the
   #891 fault in miniature -- two places stating one rule, drifting the first time either is touched.
   THE INK STAYS A PROP. #772's rule holds: this component is used on parchment and on dark chrome, so the
   colour cannot live with the shape. Callers spread this and set `color` themselves. */
export const CARD_SECTION_CAPTION: React.CSSProperties = {
  fontSize: FONT_SIZE.micro,
  fontWeight: 800,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
};

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 },
  // Design note #1171: the shared token, read rather than restated -- see the export above.
  caption: CARD_SECTION_CAPTION,
  /* `listStyle: none` with a drawn marker rather than a browser disc: the disc's indent is not controllable
     across engines and these sit in a 200px card where four wasted pixels show. */
  list: { display: "flex", flexDirection: "column", gap: "3px", margin: 0, padding: 0, listStyle: "none" },
  /* ==================================================================
      DESIGN NOTE 1167: A STEP UP, BECAUSE THE COLOUR WAS ALREADY THE ONE ASKED FOR
     ==================================================================
     ASKED: "either bump the size of the font a smidge up, or use the font color that's on the Corporation
     cards on the Stocks tab, which seems to be the same size but a darker/sharper contrasting color."
     THE SECOND OPTION HAD NOTHING TO CHANGE. Measured: this text and `StockRoundPanel`'s `privateRules` are
     both `CARD_INK_MUTED` on `CARD_SURFACE` at `FONT_SIZE.micro` -- the same ink, the same ground, the same
     size, 11.09:1 either way. There is no darker colour in use on the corporation card to adopt.
     SO THE DIFFERENCE IS THE FORM, NOT THE INK. The corporation card runs its rules as a paragraph; this runs
     them as short bullets, each behind a marker and a gap, on a denser card -- and broken text at 11px reads
     lighter than continuous text at 11px even when every value matches. That is a real perception with a
     cause, and the cause is not addressable by colour.
     WHICH LEAVES THE FIRST OPTION, and it is one rung: `micro` to `small`. NOT A NEW VALUE -- #1151 spent a
     batch removing twelve of those -- and not `CARD_INK`, which would make this text sharper than the card it
     was asked to match rather than equal to it.
     THE CONSEQUENCE, STATED: these bullets are now one step larger than the corporation card's prose. That is
     a deliberate divergence from the parity the report cited, and the alternative -- raising both -- is a
     change to a surface nobody reported. */
  bullet: {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: "6px",
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
  },
  marker: { flex: "none", lineHeight: 1.45, opacity: 0.7 },
  /* `minWidth: 0` plus `overflowWrap`: "Champlain & St. Lawrence" taught #30 that a long unbroken token in a
     flex child pushes the card's border off the page rather than wrapping. */
  bulletText: { minWidth: 0, overflowWrap: "anywhere" },
  disclosure: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    alignSelf: "flex-start",
    margin: 0,
    padding: 0,
    border: "none",
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.3px",
    textDecoration: "underline",
    cursor: "pointer",
  },
  /* Design note #1167: the long form moves with the bullets. It is the same prose one disclosure deeper, and
     a detail smaller than the summary that opened it would read as a footnote to a footnote. */
  detail: {
    margin: 0,
    padding: "7px 9px",
    borderRadius: RADIUS.control,
    fontSize: FONT_SIZE.small,
    lineHeight: 1.5,
  },
};

export default SpecialPowerBlock;
