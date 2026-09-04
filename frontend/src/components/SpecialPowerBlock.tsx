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

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 },
  caption: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
  },
  /* `listStyle: none` with a drawn marker rather than a browser disc: the disc's indent is not controllable
     across engines and these sit in a 200px card where four wasted pixels show. */
  list: { display: "flex", flexDirection: "column", gap: "3px", margin: 0, padding: 0, listStyle: "none" },
  bullet: {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: "6px",
    fontSize: FONT_SIZE.micro,
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
  detail: {
    margin: 0,
    padding: "7px 9px",
    borderRadius: RADIUS.control,
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.5,
  },
};

export default SpecialPowerBlock;
