/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1171 (harness): A HEADER THAT NEVER EXISTED, FOR A PROBLEM THAT DID
// ==================================================================
//
// REPORTED: "didn't there used to be a table header saying 'Bidder' and 'Amount' or something similar? It is
// a little bit hard to tell where that information is when it just rolls under the special powers and Full
// Rules click."
//
// THE MEMORY WAS OF A DIFFERENT THING. `git show` on the first version of the card finds a
// `highestBidderLine` -- "Highest bidder: 0x1a2b -- 175 VGP" -- rendered above the list, and its STYLE was
// still declared in the file with nothing rendering it. No column header has ever existed.
//
// THE COMPLAINT WAS RIGHT ANYWAY, and about adjacency rather than columns: `SpecialPowerBlock` announces
// itself with a caption and ends in an underlined "Full Rules" button, and the bid rows started immediately
// underneath with no label. So the fix is the card's own caption idiom applied to the section that lacked it,
// not a header row inside a list that #21 caps at ~104px.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { CARD_CAPTION_GOLD } = require("../styles/palette") as typeof import("../styles/palette");
const { CARD_SECTION_CAPTION } =
  require("../components/SpecialPowerBlock") as typeof import("../components/SpecialPowerBlock");

const AUCTION = readStripped("components/WaterfallAuctionDashboard.tsx");
const BLOCK = readStripped("components/SpecialPowerBlock.tsx");

describe("the bid list says what it is", () => {
  it("captions the section", () => {
    /* Design note #1185 split this element across lines to hang the high bid off it, so the caption and its
       text are asserted separately -- pinning the one-line form would fail on formatting rather than on the
       claim, which is that the section is captioned at all. */
    expect(AUCTION).toContain("<span style={styles.bidSectionCaption}>");
    expect(AUCTION).toContain("Standing bids");
  });

  it("states the high bid the input is defaulting against", () => {
    /* ==================================================================
        DESIGN NOTE 1185: THE READOUT THAT WOULD HAVE CAUGHT #1184
       ==================================================================
       REPORTED: "clicking Bid is registering everyone with the same bid ... it seems connected to stripping
       out the Highest Bidder information."
       THE REMOVAL WAS NOT #1171's. `git log -S styles.highestBidderLine` puts it in `d86bf95`, the project's
       second commit; #1171 deleted only the orphaned style that had outlived the markup by months. The
       instinct was right anyway: the bid input DEFAULTS to the legal minimum, so a card a round trip stale
       shows an authoritative-looking number that is wrong, and a stated high bid is the only thing on the
       card that contradicts it. */
    expect(AUCTION).toContain("styles.bidSectionHigh");
    expect(AUCTION).toContain("{standingHigh > 0 && (");
  });

  it("hides the figure rather than printing a zero when nothing is bid", () => {
    /* #232: absent is not a value. "high $0" on an unbid private states a fact that is not true -- the floor
       there is the face value, not zero. */
    const at = AUCTION.indexOf("{standingHigh > 0 && (");
    expect(at).toBeGreaterThan(-1);
    expect(AUCTION.indexOf("styles.bidSectionCaption")).toBeLessThan(at);
  });

  it("puts the caption OUTSIDE the scroller, so it cannot scroll away from its own rows", () => {
    /* `privateCardBids` is `overflowY: auto`. A caption inside it would be the first thing to leave the
       viewport on a contested private -- exactly when the label is most needed. */
    const section = AUCTION.indexOf("<div style={styles.bidSection}>");
    const caption = AUCTION.indexOf("styles.bidSectionCaption");
    const scroller = AUCTION.indexOf("<div style={styles.privateCardBids}");
    expect(section).toBeGreaterThan(-1);
    expect(caption).toBeGreaterThan(section);
    expect(scroller).toBeGreaterThan(caption);
  });

  it("does not spend a row of the capped list on a header", () => {
    /* #21's cap is the reason column headings were turned down: about three and a half rows are visible, and
       a header inside the scroller costs one of them on all six cards -- empty ones included. */
    const list = sliceBetween(AUCTION, "privateCardBids: {", "\n  },");
    expect(list).toContain('maxHeight: "104px"');
    expect(list).toContain('overflowY: "auto"');
    expect(AUCTION).not.toContain(">Bidder<");
    expect(AUCTION).not.toContain(">Amount<");
  });

  it("reads as a sibling of the powers block, at the same two distances", () => {
    /* 5px caption-to-content inside the section and the card's own 9px between sections. Matching
       `SpecialPowerBlock.block` is what makes the pair read as two sections rather than as a stray label. */
    const section = sliceBetween(AUCTION, "bidSection: {", "\n  },");
    const block = sliceBetween(BLOCK, "block: {", "},");
    expect(section).toContain('gap: "5px"');
    expect(block).toContain('gap: "5px"');
    expect(sliceBetween(AUCTION, "privateCard: {", "\n  },")).toContain('gap: "9px"');
  });

  it("lets the scroller keep shrinking through the new wrapper", () => {
    /* A flex child defaults to `min-height: auto` and will not shrink below its content, so the wrapper has
       to pass the permission down or `maxHeight` is the only thing holding the card's height. */
    expect(sliceBetween(AUCTION, "bidSection: {", "\n  },")).toContain("minHeight: 0");
    expect(sliceBetween(AUCTION, "privateCardBids: {", "\n  },")).toContain("minHeight: 0");
  });
});

describe("the caption is one shape and one colour, stated once", () => {
  it("is the token the powers block already used, not a second copy of it", () => {
    /* Four properties typed twice is the #891 fault in miniature: the copies drift the first time either is
       touched, and nothing fails when they do. */
    expect(CARD_SECTION_CAPTION).toEqual({
      fontSize: "11px",
      fontWeight: 800,
      letterSpacing: "0.5px",
      textTransform: "uppercase",
    });
    expect(BLOCK).toContain("caption: CARD_SECTION_CAPTION");
    expect(AUCTION).toContain("bidSectionCaption: { ...CARD_SECTION_CAPTION, color: CARD_CAPTION_GOLD }");
  });

  it("names the gold instead of typing it a third time", () => {
    expect(CARD_CAPTION_GOLD).toBe("#8a7332");
    /* Both `SpecialPowerBlock` call sites on this surface, plus the new caption, now read the constant. */
    expect(AUCTION).not.toContain("#8a7332");
    expect(AUCTION).not.toContain("rgba(138, 115, 50, 0.09)");
    expect(AUCTION.split("captionInk={CARD_CAPTION_GOLD}").length - 1).toBe(2);
  });

  it("leaves the tile chip's border alone, which happens to share the value", () => {
    /* `TileSelectionPopup` uses the same hex for a BORDER. Renaming it would assert a relationship that does
       not exist and would make a future change to one silently change the other. */
    const popup = readStripped("components/TileSelectionPopup.tsx");
    expect(popup).toContain('border: "1px solid #8a7332"');
    expect(popup).not.toContain("CARD_CAPTION_GOLD");
  });
});

describe("nothing on the card says the caption twice", () => {
  it("drops the words the caption now carries from the empty line", () => {
    expect(AUCTION).toContain('"None — buy outright at face value" : "None yet"');
    expect(AUCTION).not.toContain('"No standing bids"');
  });

  it("keeps the half of the empty line that is a different fact", () => {
    /* The lowest offer can be TAKEN at face value. That is an affordance, not an absence, and losing it with
       the redundant half would remove the only place the card says so. */
    expect(AUCTION).toContain("buy outright at face value");
  });

  it("retires the dead style the report was actually remembering", () => {
    /* Declared, rendered by nothing since the card's first version. Left in place it would be a fourth answer
       to "how does this card label a section" for somebody to pick up. */
    expect(AUCTION).not.toContain("highestBidderLine");
  });
});


describe("the bid minimum is one rule, read by the button and the board", () => {
  /* ==================================================================
      DESIGN NOTE 1184: A RULE THAT LIVED IN THE CONTROL
     ==================================================================
     `MIN_BID_INCREMENT` sat in `WaterfallAuctionDashboard` under a comment calling itself a "hand-kept mirror
     of `auction::MIN_BID_INCREMENT`" -- so the button computed the legal minimum and the reducer took
     whatever arrived. Invisible in ordinary play; two clients that have not seen each other's bid both
     compute `face + 5`, both submit it, and both are accepted.
     THE THIRD TIME THIS CODEBASE HAS FOUND THIS SHAPE: #712's zone rules, #1172's purchase count, and now
     this. Each was a rule encoded where the control lives and never where the state moves. */
  const ESCROW = readStripped("utils/auctionEscrow.ts");
  const REDUCER = readStripped("utils/sandboxSession.ts");

  it("keeps the increment in one module", () => {
    expect(ESCROW).toContain("export const MIN_BID_INCREMENT = 5;");
    expect(AUCTION).not.toContain("const MIN_BID_INCREMENT = 5;");
  });

  it("has the button read it rather than restate it", () => {
    expect(AUCTION).toContain("const minimumBid = minimumBidFor({ faceValue: priv.face_value, bids: priv.bids });");
  });

  it("has the board ask the same question", () => {
    expect(REDUCER).toContain(
      "minimumBidFor({ faceValue: bidOnEntry.face_value, bids: bidOnEntry.bids })",
    );
  });

  it("refuses by leaving the auction unchanged, so a replay never halts", () => {
    /* #712's rule, and the reason a retroactive rule is survivable at all: an entry the log already contains
       must not be able to stop a rebuild. */
    const at = REDUCER.indexOf("minimumBidFor({ faceValue: bidOnEntry.face_value");
    expect(REDUCER.slice(at, at + 200)).toContain("return unchanged;");
  });

  it("opens at face value plus the increment, not at face value", () => {
    /* Design note #22: a bid at face is worth what the lowest offer can be bought outright for, so it offers
       the seller nothing. Asserted as arithmetic rather than as source. */
    const { minimumBidFor, MIN_BID_INCREMENT } =
      require("./auctionEscrow") as typeof import("./auctionEscrow");
    expect(minimumBidFor({ faceValue: 100, bids: [] })).toBe(100 + MIN_BID_INCREMENT);
    expect(minimumBidFor({ faceValue: 100, bids: [{ bid_amount: "165" }] })).toBe(
      165 + MIN_BID_INCREMENT,
    );
  });

  it("counts the leader's own bid toward the high", () => {
    /* Excluding it would let whoever holds the high bid re-submit their current amount -- which is the
       reported symptom seen from one seat instead of two. */
    const { minimumBidFor } = require("./auctionEscrow") as typeof import("./auctionEscrow");
    expect(minimumBidFor({ faceValue: 20, bids: [{ bid_amount: "45" }, { bid_amount: "40" }] })).toBe(50);
  });
});
