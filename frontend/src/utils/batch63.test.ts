/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1098 (harness): THE PLAYER CARD'S HEADER, ON THE THIRD SURFACE THAT NEEDED IT
// ==================================================================
//
// REPORTED: the dividend payout panel "only has the player color in one tiny spot by the player name, the rest
// of the panel is in the app's overall dark blue theme."
//
// THE TINY SPOT WAS A 9px DOT, and #1060 chose it on a measured argument: seat colours as INK on a dark panel
// fail, because they were picked against a light card. That argument is sound and it does not cover a STRIPE,
// where the colour is the ground and `bestContrastTextColor` picks the ink per seat. Two different proposals,
// and only the first was ever rejected.
//
// THE MEASUREMENT IS THE SPINE OF THIS FILE, because the whole change turns on it: against the app's own
// picker all six seats clear 4.5:1. #1050's "three of the six under threshold" was true of WHITE INK
// specifically, and the picker answers black for Moss, Ochre and Teal. That distinction is asserted here so
// nobody re-derives the wrong half of it.
//
// AND ONE RULE IS OBEYED THAT I BROKE FIRST. #1052 -- on the sibling payout surface, one batch earlier --
// records the user reporting a total on the stripe and removes it: "the same number twice, four lines apart",
// and "the player card's header carries no figure either." My first draft of this panel put the new total on
// the stripe. The identical mistake, one surface over, caught by the person who had already ruled on it.
// The case below asserts the rule rather than the instance.

export {};

const { readStripped, sliceBetween, anchorIndex } =
  require("./sourceScan") as typeof import("./sourceScan");
const { SEAT_COLORS } = require("./playerLabels") as typeof import("./playerLabels");
const { bestContrastTextColor } =
  require("../styles/corporationLivery") as typeof import("../styles/corporationLivery");
const {
  CARD_SURFACE,
  CARD_INK,
  CARD_INK_MUTED,
  CARD_INK_POSITIVE,
} = require("../styles/palette") as typeof import("../styles/palette");

const MACHINE = readStripped("components/DividendMoneyMachine.tsx");
const MODAL = readStripped("components/PrivateRevenueModal.tsx");
const CARDS = readStripped("components/PlayerCards.tsx");

/* ------------------------------------------------------------------ */
/* Contrast, computed rather than asserted from memory                 */
/* ------------------------------------------------------------------ */

const luminance = (hex: string) => {
  const raw = hex.replace("#", "");
  const channel = (pair: string) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(raw.slice(0, 2)) +
    0.7152 * channel(raw.slice(2, 4)) +
    0.0722 * channel(raw.slice(4, 6))
  );
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/* ------------------------------------------------------------------ */
/* The stripe                                                          */
/* ------------------------------------------------------------------ */

describe("the seat stripe carries identity and only identity", () => {
  it("puts the name on the seat colour with the per-seat ink", () => {
    /* THE PLAYER CARD'S OWN MECHANISM, borrowed rather than matched by eye -- the borrowing IS the change.
       #569: "colour in exactly one place is decoration; colour meaning the same thing in several places is a
       language." */
    expect(MACHINE).toContain("bestContrastTextColor(event.seatColor)");
    expect(MACHINE).toContain("{event.playerName}");
    const stripe = sliceBetween(MACHINE, "<header", "</header>");
    expect(stripe).toContain("event.seatColor");
  });

  it("carries no figure, which is the rule I broke first", () => {
    /* ==================================================================
        #1052's RULE, ASSERTED AS A RULE
       ==================================================================
       IT WAS REPORTED ONCE ALREADY, on `PrivateRevenueModal`: "the sum does not need to be listed in the
       player color stripe since it's printed a few lines below that." That note's conclusion is general --
       "the player card's header carries no figure either" -- and my first draft of THIS panel put the new
       total on the stripe anyway.
       ASSERTED ON THE REGION, not on the absence of one string: a stripe that carried `shown`, `amount`, or a
       dollar sign at all would fail, whichever of them somebody reached for. */
    const stripe = sliceBetween(MACHINE, "<header", "</header>");
    expect(stripe).not.toContain("shown");
    expect(stripe).not.toContain("amount");
    expect(stripe).not.toContain("$");
  });

  it("matches what the other two stripes carry", () => {
    /* ==================================================================
        #490a's TRAP, WALKED INTO A THIRD TIME
       ==================================================================
       THE FIRST DRAFT SLICED THE PLAYER CARD ON `"---- Name stripe"` -- a JSX COMMENT, which `readStripped`
       removes, so `sliceBetween` threw. `polishWave9` carries a note recording me doing exactly this once
       before ("anchored on code, not on a comment"), and `sourceScan.ts` #886 exists because of it. Written
       down again here because the note evidently was not enough on its own.
       IT THREW RATHER THAN PASSING, which is the whole reason `sliceBetween` throws: an anchor that rots
       takes the case down with it instead of quietly reducing it to an assertion about the empty string.
       ANCHORED ON CODE AT BOTH ENDS NOW -- `stripeIdentity` opens the card's stripe and `styles.body` opens
       what follows it.
       AND THE CLAIM IS ASKED OF THE SIBLINGS so this cannot pass by all three drifting together: none of the
       three headers carries a figure, which is the rule #1052 stated and this file obeys. */
    expect(sliceBetween(MODAL, "<header", "</header>")).not.toContain("$");
    const cardStripe = sliceBetween(CARDS, "styles.stripeIdentity", "styles.body");
    expect(cardStripe).toContain("styles.stripeName");
    expect(cardStripe).not.toContain("$");
    /* Bounded, so a future edit that swallowed the card's whole body would fail here rather than quietly
       widening what this negative is denying. */
    expect(cardStripe.length).toBeLessThan(1200);
  });

  it("clears the body-text floor on every seat", () => {
    /* ==================================================================
        THE MEASUREMENT #1060 DID NOT MAKE, AND #1050 MADE ABOUT WHITE
       ==================================================================
       #1050 FOUND "three of the six under the 4.5:1 body-text threshold, and that was against WHITE" -- Ochre
       3.3, Teal 4.0, Moss 4.1 -- and concluded the stripe was safe only at the 3:1 large-text threshold.
       AGAINST THE PICKER ALL SIX CLEAR 4.5:1, because it answers BLACK for exactly those three. So the name
       needs no size or weight promise to be legible, which is what lets this be a plain header.
       COMPUTED FROM THE LIVE PALETTE AND THE LIVE PICKER, so a seventh seat or a retuned hue fails here. */
    for (const seat of SEAT_COLORS) {
      expect(contrast(seat, bestContrastTextColor(seat))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("flips to black on the three that need it", () => {
    /* THE POSITIVE CONTROL for the case above: a picker that returned white for everything would still pass a
       floor test if the floor were low enough, and would be wrong about half the roster. */
    /* Design note #1097 re-cut three seat colours, and these three hexes are no longer among them. They are
       KEPT AS INPUTS ANYWAY: what this case tests is the function's threshold behaviour on mid-lightness
       colours, and these are still good examples of it. Relabelled rather than replaced, because the new
       seat colours are all dark enough to take white and would turn a "flips to black" case into a
       "returns white" one -- deleting the coverage instead of updating it. */
    expect(bestContrastTextColor("#a88a3f")).toBe("#000000"); // mid gold
    expect(bestContrastTextColor("#4f8a5c")).toBe("#000000"); // mid green
    expect(bestContrastTextColor("#3f8a94")).toBe("#000000"); // mid teal
    expect(bestContrastTextColor("#3f6fa8")).toBe("#FFFFFF"); // Slate blue, still a seat colour
  });

  it("gives an unplaceable seat the muted paper, never a guessed hue", () => {
    /* #232's RULE: absence is not an answer. The same one the modal gives for the same case. */
    expect(MACHINE).toContain("styles.stripeUnknown");
    expect(MACHINE).toContain("stripeUnknown: { backgroundColor: CARD_DIVIDER");
  });
});

/* ------------------------------------------------------------------ */
/* The ground, and the figure that had to move with it                 */
/* ------------------------------------------------------------------ */

describe("the panel is the card's paper now", () => {
  it("takes the card surface and the card border", () => {
    expect(MACHINE).toContain("backgroundColor: CARD_SURFACE");
    expect(MACHINE).toContain("border: `1px solid ${CARD_BORDER}`");
  });

  it("drops the blur that existed to soften a translucency", () => {
    /* #1060 WANTED "a distinct background so the text is fully legible against the game board and colored
       heralds" and reached for a near-opaque wash plus a blur. Paper meets that requirement more strongly --
       fully opaque, and the lightest thing on a dark board. A blur behind an opaque layer is work nobody can
       see. */
    expect(MACHINE).not.toContain("backdropFilter");
    expect(MACHINE).not.toContain("rgba(18, 21, 29");
  });

  it("swaps the green rather than keeping a token that would vanish", () => {
    /* THE ONE FIGURE ON THIS PANEL THAT MUST NOT BE INVISIBLE. `#5fd39a` was 9.8:1 on the old dark ground and
       is 1.7:1 on paper. `CARD_INK_POSITIVE` is the palette's answer at ~6:1, already used by the sibling
       modal for exactly this -- a swap of register, not a new colour, and #670's "green means money arriving"
       is untouched. */
    expect(MACHINE).toContain("color: CARD_INK_POSITIVE");
    expect(MACHINE).not.toContain("#5fd39a");
    expect(contrast(CARD_SURFACE, CARD_INK_POSITIVE)).toBeGreaterThanOrEqual(4.5);
    // And the figure it replaced would genuinely have failed, which is why this case exists.
    expect(contrast(CARD_SURFACE, "#5fd39a")).toBeLessThan(3);
  });

  it("re-inks the rest of the panel for the new ground", () => {
    /* A GROUND CHANGE THAT LEFT ANY DARK-PANEL INK BEHIND would be a legibility bug on whichever line was
       forgotten -- so the old inks are asserted gone as a set rather than one at a time. */
    for (const darkInk of ["#e8ecf4", "#aab3c4", "#4a5164"]) {
      expect(MACHINE).not.toContain(darkInk);
    }
    expect(contrast(CARD_SURFACE, CARD_INK)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(CARD_SURFACE, CARD_INK_MUTED)).toBeGreaterThanOrEqual(4.5);
  });

  it("lets the stripe reach both edges", () => {
    /* THE STRIPE IS A BAND, NOT A PILL, which is a fact about the PANEL's padding rather than the stripe's:
       a horizontally padded parent would inset it and it would float. The rows carry their own padding
       instead, and `overflow: hidden` clips the stripe's square top to the panel's radius. */
    const panel = sliceBetween(MACHINE, "panel: {", "boxShadow");
    expect(panel).toContain('padding: "0 0 9px"');
    expect(panel).toContain('overflow: "hidden"');
  });
});

/* ------------------------------------------------------------------ */
/* The merge, which is the thing that must NOT have changed            */
/* ------------------------------------------------------------------ */

describe("the payout still falls onto the total", () => {
  it("keeps the total in the body, below the payer", () => {
    /* ==================================================================
        WHY THE RULE ABOVE AND THIS CASE ARE THE SAME CASE
       ==================================================================
       THE MERGE IMITATES ARITHMETIC ON PAPER: addend above, sum below, the way every column sum, receipt and
       ledger is written -- and #1082's own phase names, `holding`/`falling`/`landed`, say which way it is
       meant to go. A total on the stripe would sit ABOVE the payer and force the drop to run upward, against
       the one convention every reader already has.
       ASSERTED BY POSITION, which is the only form that catches it: the payer row must precede the holder
       row in the file. `anchorIndex` throws on a rotted anchor rather than comparing against -1 (#1090). */
    expect(anchorIndex(MACHINE, "styles.payerRow")).toBeLessThan(
      anchorIndex(MACHINE, "styles.holderRow"),
    );
    expect(anchorIndex(MACHINE, "<header")).toBeLessThan(anchorIndex(MACHINE, "styles.payerRow"));
  });

  it("leaves the three phases and their classes alone", () => {
    /* THE ANIMATION IS UNTOUCHED, which is the claim this whole restyle rests on. The stripe is a header that
       takes no part in it -- #1082's three states still drive the payer row and nothing else. */
    for (const cls of [
      "app-money-machine-waiting",
      "app-money-machine-fall",
      "app-money-machine-landed",
    ]) {
      expect(MACHINE).toContain(cls);
    }
    expect(sliceBetween(MACHINE, "<header", "</header>")).not.toContain("app-money-machine");
  });

  it("rules the total off from the payer above it", () => {
    /* THE LINE UNDER A COLUMN OF ADDENDS. It is what makes the drop read as a sum landing in a total rather
       than two figures that happen to be adjacent -- the same convention the animation is imitating. */
    expect(sliceBetween(MACHINE, "holderRow: {", "},")).toContain("borderTop");
  });
});

describe("what the name's departure left behind", () => {
  it("deletes the dot and the name style rather than orphaning them", () => {
    /* #1060's DOT WAS A SUBSTITUTE for a colour it could not otherwise show; the stripe shows it. An orphaned
       style for a thing this panel has stopped doing is how the thing comes back -- `appStyles` #998's rule,
       and #660a's dead prop in miniature. */
    expect(MACHINE).not.toContain("seatDot");
    expect(MACHINE).not.toContain("holderName");
  });

  it("labels the total, and says so", () => {
    /* AN ADDITION, FLAGGED. No caption existed before; the name leaving the body row emptied its gutter and
       cost the row the label/figure rhythm the payer row keeps. It is here because the layout asked, not
       because the report did -- which is the distinction #1052 drew about the figure I had added to a
       borrowed component, and the reason this case names it as mine. */
    /* ==================================================================
        DESIGN NOTE 1163 KEPT THE CAPTION AND DROPPED ONE WORD OF IT
       ==================================================================
       IT PINNED "your cash", and the possessive is the half that did not survive: REPORTED as "the 'your
       cash' string seems unnecessary since it already has the player name and color strip above it".
       AND THIS CASE'S OWN ARGUMENT IS WHY. It records that the caption exists because "the name leaving the
       body row emptied its gutter and cost the row the label/figure rhythm" -- a claim about RHYTHM, which a
       one-word caption satisfies exactly as well. The word that went was the one duplicating the stripe the
       same note moved the name into.
       SO THE ASSERTION FOLLOWS THE CLAIM: there is a caption, and it is in the label's own style. */
    expect(MACHINE).toContain(">Cash</span>");
    expect(MACHINE).toContain("styles.holderLabel");
  });
});
