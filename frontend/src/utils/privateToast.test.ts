/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1047-1048 (harness): THE TOAST THAT WAITS
// ==================================================================
//
// REPORTED: "there can be so much variability in what's on them that there's no good way to standardize a time
// for them ... the payouts are to the players rather than the corporations, but the toasts happen during the
// corporation's first action subphase ... I worry the toast that disappears suggests the information is less
// strategic than it actually is."
//
// AND THE FILE ALREADY HELD THE EVIDENCE. `PRIVATE_REVENUE_TOAST_MS` has been tuned in BOTH directions --
// #967 raised it to 1.5x standard because "this is the one toast in the app that is a LIST rather than a
// sentence", #1013 lowered it again after it was reported as staying up far too long. Two corrections in
// opposite directions on one number is what "no good way to standardize a time" looks like from inside the
// source, and the constant is deliberately left in place as that record.

export {};

const { sumRows } = require("../components/ActionToast") as typeof import("../components/ActionToast");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const TOAST = readStripped("components/ActionToast.tsx");
const APP = readStripped("App.tsx");

/* ------------------------------------------------------------------ */
/* Waiting instead of expiring                                         */
/* ------------------------------------------------------------------ */

describe("the payout toast has no clock", () => {
  it("starts no timer when it is persistent", () => {
    /* THE WHOLE FIX. Every other toast keeps its window; this one stops guessing at a number that does not
       exist for content whose length depends on how many privates a player holds. */
    expect(TOAST).toContain("if (persistent) return undefined;");
  });

  it("leaves every other toast on its timer", () => {
    /* THE CONTROL. A change that dropped the timeout for ALL toasts would pass the case above and turn four
       receipts into four things the player has to clear by hand. */
    expect(TOAST).toContain("const timer = window.setTimeout(onDismiss, durationMs);");
  });

  it("keeps the old duration constant as the record", () => {
    /* NOT DELETED, DELIBERATELY. It is the evidence for why this toast waits -- two attempts at a number,
       in opposite directions -- and a reader who finds only the persistence would reasonably wonder whether
       anybody had tried a longer window. */
    expect(readStripped("components/ActionToast.tsx")).toContain("PRIVATE_REVENUE_TOAST_MS = 3200");
  });

  it("is only the private payout that waits", () => {
    /* One `true` at one call site; the era toast and the dividend receipt still expire.
       DESIGN NOTE 1049: AND THERE IS NO LONGER A CALLER PASSING `true` AT ALL, because the payout became a
       modal. This case is unchanged and still passes, which is worth a sentence rather than a silent pass:
       what it asserts is that the shell threads the flag through ONE render of `ActionToast`, so persistence
       can never become a property some toasts have by accident. That is true of zero waiting toasts exactly
       as it was of one. The capability is deliberately kept -- see `ActionToast.tsx` #1049 for the condition
       on keeping it. */
    expect(APP.split("persistent={actionToast?.persistent ?? false}").length - 1).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* One live target in an inert panel                                   */
/* ------------------------------------------------------------------ */

describe("the close button is the only thing that receives a click", () => {
  it("re-enables pointer events on the button alone", () => {
    /* THE CONFLICT THIS RESOLVES. The toast is deliberately click-through -- "it reports; it does not
       receive. Clicks fall through to whatever it is covering, so a toast can never eat the next purchase."
       An X needs the opposite, so the exception is scoped to about twenty pixels. */
    expect(TOAST).toContain('pointerEvents: "auto"');
    expect(TOAST).toContain('pointerEvents: "none"');
  });

  it("does not widen the exception to the panel", () => {
    /* THE TIDIER-LOOKING EDIT, which would reintroduce the swallowed click the inert panel exists to
       prevent. Asserted as a count: exactly one `auto` in the file, and it belongs to the button. */
    expect(TOAST.split('pointerEvents: "auto"').length - 1).toBe(1);
  });

  it("only renders the button when the toast waits", () => {
    // A close button on a toast that vanishes in 3.7s is a target nobody can hit on purpose.
    expect(TOAST).toContain("{persistent && (");
  });

  it("dismisses through the same callback the timer used", () => {
    /* ONE EXIT, TWO TRIGGERS. A second dismissal path would be a second place for the shell's state to get
       out of step with what is on screen. */
    expect(TOAST).toContain("onClick={onDismiss}");
  });
});

/* ------------------------------------------------------------------ */
/* The total                                                           */
/* ------------------------------------------------------------------ */

describe("the list adds itself up", () => {
  it("sums the figures in the column", () => {
    expect(sumRows([{ value: "$25" }, { value: "$10" }, { value: "$5" }])).toBe("$40");
  });

  it("ignores anything that is not a figure", () => {
    /* PARSED RATHER THAN TRUSTED. `detailRows` is a display shape (#984) and always has been -- a row with no
       digits must contribute nothing rather than `NaN`, which would poison the whole sum and print "$NaN"
       where a player expects their income. */
    expect(sumRows([{ value: "$25" }, { value: "--" }])).toBe("$25");
    expect(sumRows([])).toBe("$0");
  });

  it("survives a suffix on the figure", () => {
    expect(sumRows([{ value: "$25/OR" }, { value: "$5/OR" }])).toBe("$30");
  });

  it("is derived from the rows rather than passed in", () => {
    /* A CALLER-SUPPLIED TOTAL COULD DISAGREE WITH THE COLUMN ABOVE IT, and a total that does not match its
       own rows is worse than no total -- the player checks it by adding, and finds the app wrong. */
    expect(TOAST).toContain("{sumRows(detailRows)}");
  });

  it("stays away when there is nothing to add up", () => {
    /* ONE PRIVATE IS ITS OWN TOTAL. A "Total" row under a single line restates it, which is the shape #697
       argues against for the ordinary receipt. */
    expect(TOAST).toContain("detailRows.length > 1 &&");
  });
});

/* ------------------------------------------------------------------ */
/* Whose toast this is                                                 */
/* ------------------------------------------------------------------ */

describe("the identity edge", () => {
  it("shares the auction cards' surface rather than matching it by eye", () => {
    /* #1030 PICKED `#f6f1e4` INDEPENDENTLY and the auction cards use `CARD_SURFACE` at `#f7f5f0` -- two
       hand-chosen creams a shade apart, meaning one thing, free to drift. Now one constant. */
    expect(TOAST).toContain("backgroundColor: CARD_SURFACE,");
    expect(TOAST).not.toContain('backgroundColor: "#f6f1e4"');
  });

  it("wears the private cards' paper on the payout panel", () => {
    /* ==================================================================
        DESIGN NOTE 1049: THE PANEL MOVED, THE FAMILY RESEMBLANCE DID NOT
       ==================================================================
       THIS PINNED `CARD_ACCENT,` IN `App.tsx` -- the accent the payout toast was given so it would read as
       the same family of object as the cards a player bid on in the auction. `App.tsx` no longer raises that
       toast, so the constant is no longer imported there and the assertion could only have been kept by
       asserting something the file has no reason to contain.
       THE REQUEST IT ANSWERS IS UNCHANGED: "may I ask that the toast notification be the white/cream/whatever
       background the PC cards have in the Auction Round". The panel still takes `CARD_SURFACE`, and it takes
       it as the shared constant rather than as a hex, which is the #891 point #1048 was making.
       ASSERTED ON THE MODAL, which is where the surface now lives. */
    expect(readStripped("components/PrivateRevenueModal.tsx")).toContain(
      "backgroundColor: CARD_SURFACE,",
    );
  });

  it("wears the viewer's seat colour on the toast about their own cash", () => {
    /* THE ONE OTHER PLAYER-FOCUSED TOAST. Asked for "all other player-focused toasts in the player-color",
       and that set has exactly one member today -- the dividend receipt. */
    expect(APP).toContain('seatColor(viewerAddressRef.current ?? "", seatAt)');
  });

  it("leaves the era toast unmarked", () => {
    /* IT IS A FACT ABOUT THE TABLE, not about anybody, so it carries no identity colour. Defaulting the
       parameter is what keeps that call site untouched. */
    expect(APP).toContain("accentColor: string | null = null,");
  });

  it("colours an edge rather than the ground", () => {
    /* A DELIBERATE DEVIATION FROM THE LITERAL REQUEST. Seat colours are chosen to be distinguishable from
       each other, not to carry dark text: #702 measured one livery pair at 1.00:1 against its intended ink,
       and #1030 exists because this very toast once blended into what it sat on. The colour goes on a 5px
       left rule -- the same edge the auction card carries -- and the measured ground/ink pair survives. */
    expect(TOAST).toContain('borderLeftWidth: "5px"');
    expect(TOAST).not.toContain("backgroundColor: accentColor");
  });
});
