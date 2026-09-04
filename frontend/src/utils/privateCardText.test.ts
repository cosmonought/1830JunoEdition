/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1167 (harness): TENSE, AND A COLOUR THAT WAS ALREADY RIGHT
// ==================================================================
//
// REPORTED as two things, and only one of them was a difference that existed.
//
//   THE TENSE was real, and it was two bullets rather than a house style. Every other private's power is
//             something its owner may DO later, so those wrote themselves in the present; the C&A's share and
//             the B&O's certificate both arrive AT PURCHASE, so for a player already holding the card the
//             event has happened -- and the sentences slid into the past to match. A log entry's tense on a
//             reference a player reads BEFORE deciding to buy.
//   THE COLOUR was not. Measured, this text and the corporation card's prose are the same ink on the same
//             ground at the same size. What differs is the FORM -- short bullets behind markers versus a
//             paragraph -- which reads lighter at 11px however the values match, and cannot be fixed with a
//             colour. So the report's other option was taken: one rung up the scale.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { PRIVATE_COMPANY_CATALOG } =
  require("./privateCatalog") as typeof import("./privateCatalog");
const { FONT_SIZE } = require("../styles/typography") as typeof import("../styles/typography");

const BLOCK = readStripped("components/SpecialPowerBlock.tsx");
const AUCTION = readStripped("components/WaterfallAuctionDashboard.tsx");
const STOCK = readStripped("components/StockRoundPanel.tsx");

const allBullets = Object.values(PRIVATE_COMPANY_CATALOG).flatMap((entry) => entry.abilityBullets);

describe("the cards describe a power, not a history", () => {
  it("fixes the two bullets that had slipped into the past", () => {
    expect(allBullets).toContain("Its auction buyer is handed a 10% PRR share on purchase.");
    expect(allBullets).toContain("Comes with the B&O president’s certificate and sets its par.");
  });

  it("leaves no past-tense verb anywhere in the bullets", () => {
    /* RUN OVER THE WHOLE CATALOG rather than the two that were reported, because the cause -- a power that
       resolves at purchase reads naturally in the past -- applies to any future private written the same way.
       A SMALL LIST OF VERBS, NOT A GRAMMAR. This looks for the specific past forms these sentences reach for;
       a general tense detector would be a language model in a test file, and would fail on "closed" in a
       sentence about closing the company. */
    const pastForms = [
      " was handed",
      "Came with",
      " was given",
      " received ",
      " granted ",
      " set its ",
      " handed the",
    ];
    for (const bullet of allBullets) {
      for (const form of pastForms) {
        expect([bullet, form, bullet.includes(form)]).toEqual([bullet, form, false]);
      }
    }
  });

  it("keeps the long form and the bullet in the same tense", () => {
    /* THE DRIFT WAS VISIBLE INSIDE ONE ENTRY: the detail behind the disclosure already said "is handed" while
       the bullet above it said "was handed". One private, two tenses, a few lines apart -- which is what makes
       this a drift rather than a policy, and what a future edit could reintroduce one side at a time. */
    for (const entry of Object.values(PRIVATE_COMPANY_CATALOG)) {
      expect([entry.acronym, entry.ability.includes("was handed")]).toEqual([entry.acronym, false]);
      expect([entry.acronym, entry.ability.includes("Came with")]).toEqual([entry.acronym, false]);
    }
  });
});

describe("the rules text is a step larger, and the ink is untouched", () => {
  it("steps the bullets one rung up the scale", () => {
    /* "A smidge" is one rung. NOT a new value -- #1151 removed twelve that were invented exactly this way. */
    const bullet = sliceBetween(BLOCK, "bullet: {", "\n  },");
    expect(bullet).toContain("fontSize: FONT_SIZE.small");
    expect(FONT_SIZE.small).toBe("12px");
    expect(FONT_SIZE.micro).toBe("11px");
  });

  it("takes the long form with it", () => {
    /* The same prose one disclosure deeper. A detail smaller than the summary that opened it reads as a
       footnote to a footnote. */
    expect(sliceBetween(BLOCK, "detail: {", "\n  },")).toContain("fontSize: FONT_SIZE.small");
  });

  it("leaves the ink where it was, because it already matched", () => {
    /* THE HALF OF THE REPORT THAT HAD NO TARGET. Both surfaces pass `CARD_INK_MUTED`; the corporation card's
       own prose declares it. Asserted on BOTH so a future change to either is a change to a stated pair rather
       than a silent divergence -- and so nobody re-fixes the colour looking for a difference that is not
       there. */
    expect(AUCTION).toContain("ink={CARD_INK_MUTED}");
    expect(sliceBetween(STOCK, "privateRules: {", "\n  },")).toContain("color: CARD_INK_MUTED");
  });

  it("does not reach for the sharper ink", () => {
    /* `CARD_INK` would make this text sharper than the card it was asked to MATCH, which is the opposite of
       what was reported even though it would look like an improvement in isolation. */
    const bullet = sliceBetween(BLOCK, "bullet: {", "\n  },");
    expect(bullet).not.toContain("CARD_INK");
  });
});
