/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1010-1018 (harness): BATCH 33
// ==================================================================
//
// Ten items from one playtest. The three copy fixes and the camera lock are asserted on source text, because
// that is what they are; the two state-machine bugs are driven through the real reducer, because a rules bug
// asserted on source text is a rules bug asserted by restating it.

export {};

const { readSource, readStripped, sliceBetween } =
  require("./sourceScan") as typeof import("./sourceScan");
const { VARIANT_COPY } = require("./gameVariants") as typeof import("./gameVariants");
const { earnableRevenueVerdict, skipReasonFor } =
  require("./earnableRevenue") as typeof import("./earnableRevenue");
const { feedItemText } = require("../components/TopTicker") as typeof import("../components/TopTicker");
const { MAP_TOUCH_ACTION } = require("./mapGesture") as typeof import("./mapGesture");
const { SFX_VOLUME, RADIO_VOLUME } = require("./audio") as typeof import("./audio");
const { PRIVATE_REVENUE_TOAST_MS } =
  require("../components/ActionToast") as typeof import("../components/ActionToast");
const {
  applyPrivateRevenue,
  openOperatingRound,
  beginOperatingRound,
} = require("./sandboxSession") as typeof import("./sandboxSession");

const APP = readStripped("App.tsx");
const RENDERER = readStripped("components/HexGridRenderer.tsx");
const TICKER = readStripped("components/TopTicker.tsx");
const TOAST = readStripped("components/ActionToast.tsx");

/* ------------------------------------------------------------------ */
/* Item 1 -- design note #1010                                        */
/* ------------------------------------------------------------------ */

describe("the lobby and the action bar agree on one word", () => {
  it("says double move, not double jump", () => {
    const blurb = VARIANT_COPY.dynamicStockMarket.blurb;
    expect(blurb).toContain("double move increase");
    expect(blurb).toContain("double move decrease");
    expect(blurb).not.toContain("double jump");
  });

  it("matches the word the Market Move line already used", () => {
    /* #998 SETTLED THIS WORD ONE SURFACE OVER and the lobby kept the old one, so a player met two names for
       one rule. Asserted as a JOIN between the two surfaces rather than as two separate literals -- two
       hand-written strings that must agree is exactly how they came apart. */
    const bar = readStripped("panels/ContextualActionBar.tsx");
    expect(bar).toContain("(double move)");
    expect(VARIANT_COPY.dynamicStockMarket.blurb).toContain("double move");
  });

  it("keeps the thresholds interpolated rather than typed", () => {
    // #996's guard, unchanged by a copy edit: the numbers still come from the constants.
    // `no-template-curly-in-string` rightly objects to a literal `${...}`, so it is assembled -- #1007's dodge.
    const DOLLAR = String.fromCharCode(36);
    expect(readSource("utils/gameVariants.ts")).toContain(
      DOLLAR + "{PAY_DOUBLE_JUMP_MULTIPLE}x the share price",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Item 2 -- design note #1011                                        */
/* ------------------------------------------------------------------ */

describe("a chat line is not in quotation marks", () => {
  const chat = {
    kind: "chat" as const,
    id: "1",
    timestampMs: 0,
    timestampLabel: "3:27:00 PM",
    chatAuthor: "P1",
    chatText: "Hello",
    seq: 0,
  };

  it("renders exactly the specified format", () => {
    // The report's own example, verbatim.
    expect(feedItemText(chat as never)).toBe("[3:27 PM] P1: Hello");
  });

  it("leaves a message containing its own quotes alone", () => {
    /* THE CASE THE WRAPPING QUOTES MADE WORST. A player quoting somebody produced nested marks that read as
       mis-punctuation, and the delimiter was never carrying information the colon does not. */
    const quoted = { ...chat, chatText: 'he said "no"' };
    expect(feedItemText(quoted as never)).toBe('[3:27 PM] P1: he said "no"');
  });

  it("keeps the gutter that the log and the chat share", () => {
    // #477: the interleaved feed is a column, and a chat line that dropped the prefix would break it.
    expect(feedItemText(chat as never).startsWith("[3:27 PM] ")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Item 3 -- design note #1012                                        */
/* ------------------------------------------------------------------ */

describe("the expand arrows point the way the panel opens", () => {
  it("offers UP when collapsed and DOWN when expanded", () => {
    /* THE DOCK IS ANCHORED TO THE BOTTOM EDGE (App.tsx #614: "the expanded history grows UPWARD"), so the
       arrow beside the verb has to point the way the press will travel. */
    expect(TICKER).toContain('{isExpanded ? "▼ Collapse" : "▲ Expand"}');
  });

  it("no longer points the old way", () => {
    expect(TICKER).not.toContain('{isExpanded ? "▲ Collapse" : "▼ Expand"}');
  });

  it("leaves the state-reporting carets alone", () => {
    /* TWO CONVENTIONS, ON PURPOSE. The roster carets report a STATE and have no verb beside them (right when
       shut, down when open); this one is an instruction. Reversing those too would have been the fix
       over-applied -- asserted so a later reader does not "finish the job". */
    expect(readStripped("components/PlayerCards.tsx")).toContain('{open ? "▾" : "▸"}');
    expect(readStripped("components/TrainPurchasePanel.tsx")).toContain('{corporateOpen ? "▼" : "▶"}');
  });
});

/* ------------------------------------------------------------------ */
/* Item 4 -- design note #1013                                        */
/* ------------------------------------------------------------------ */

describe("the whistle sits above the radio in the mix", () => {
  it("puts the effect at the top of the range and the bed below it", () => {
    expect(SFX_VOLUME).toBe(1);
    expect(RADIO_VOLUME).toBeLessThan(SFX_VOLUME);
  });

  it("leaves the bed audible rather than merely quieter", () => {
    /* A BALANCE, NOT A MUTE. The report asked for a mix, and a music channel dropped to a whisper answers the
       whistle complaint by removing the feature that prompted it. */
    expect(RADIO_VOLUME).toBeGreaterThan(0.25);
  });

  it("sets both on the elements, not at each play", () => {
    const audio = readStripped("utils/audio.ts");
    expect(audio).toContain("element.volume = SFX_VOLUME;");
    expect(audio).toContain("element.volume = RADIO_VOLUME;");
  });
});

/* ------------------------------------------------------------------ */
/* Item 5 -- design note #1014                                        */
/* ------------------------------------------------------------------ */

describe("the camera is locked and the controls are gone", () => {
  it("has no zoom handlers left", () => {
    /* DELETED, NOT GATED -- #67's rule for wheel-zoom, applied to the rest: "removed entirely, not merely
       gated, so no dead path can be re-enabled." */
    expect(RENDERER).not.toContain("handleZoomStep");
    expect(RENDERER).not.toContain("handleZoomIn");
    expect(RENDERER).not.toContain("handleZoomOut");
    expect(RENDERER).not.toContain("handleFitToScreen");
  });

  it("has no unlock flag left", () => {
    expect(RENDERER).not.toContain("detailedView");
    expect(RENDERER).not.toContain("setDetailedView");
  });

  it("has no camera buttons left", () => {
    expect(RENDERER).not.toContain("Fit to Screen");
    expect(RENDERER).not.toContain('aria-label="Zoom in"');
    expect(RENDERER).not.toContain('aria-label="Zoom out"');
  });

  it("keeps the layer toggle, which was never a camera control", () => {
    // The one button in that cluster that is about what is DRAWN rather than where it is drawn from.
    expect(RENDERER).toContain("setShowCityNames");
  });

  it("stops remembering a pose there is no longer any way to set", () => {
    expect(RENDERER).not.toContain("rememberedCamera");
  });

  it("still computes the fit, because a board must be scaled to its canvas", () => {
    /* THE BOUNDARY OF THIS REMOVAL. `view` is the draw transform every hit test and tooltip anchor reads;
       deleting it would be deleting the board, not its zoom. */
    expect(RENDERER).toContain("const fitView");
    expect(RENDERER).toContain("setView(fitView);");
  });

  it("locks the page against scaling as well as the board", () => {
    const html = readSource("../public/index.html");
    expect(html).toContain("maximum-scale=1.0");
    expect(html).toContain("user-scalable=no");
  });

  it("refuses the pinch on the canvas", () => {
    expect(MAP_TOUCH_ACTION).toBe("pan-x pan-y");
  });
});

/* ------------------------------------------------------------------ */
/* Items 6 and 10 -- design notes #1015 / #1016                       */
/* ------------------------------------------------------------------ */

describe("the private payout toast is readable and out of the way", () => {
  it("gives the table time to be read", () => {
    /* #1000 SIZED THIS OFF THE MIDDLE CASE and the three-row case is the common one. Asserted as a
       relationship to the entrance rather than as a bare number, so the animation and the window cannot drift
       apart the way they did at 400ms. */
    expect(PRIVATE_REVENUE_TOAST_MS).toBeGreaterThanOrEqual(3000);
    const atRest = PRIVATE_REVENUE_TOAST_MS - 180;
    expect(atRest).toBeGreaterThan(1.5 * 1400);
  });

  it("anchors in the corner through an explicit prop", () => {
    /* NOT INFERRED FROM `detailRows`. Position is its own decision; keying it off the one caller that happens
       to pass a table is this codebase's fifth recurring bug shape.
       ==================================================================
        DESIGN NOTE 1049: THE CALLER THAT WANTED THE CORNER IS GONE, THE ARGUMENT IS NOT
       ==================================================================
       THIS ALSO PINNED `"bottom-right"` IN `App.tsx`, which was the one caller asking for the corner -- the
       private payout, now a modal. `App.tsx` passes no anchor at all today and every remaining toast takes
       the default.
       WHAT THIS CASE IS FOR IS THE MECHANISM, AND IT IS INTACT: the anchor is a PROP with a default, not a
       thing derived from whether a caller happened to pass rows. Both assertions that check that still stand,
       and the corner variant is still built and still clears the centring transform (the case below).
       THE APP ASSERTION IS DROPPED RATHER THAN INVERTED. `not.toContain('"bottom-right"')` would pin the
       ABSENCE of a caller, which is not a property worth defending -- the next toast that wants the corner is
       welcome to it. */
    expect(TOAST).toContain("anchor = \"center\"");
    expect(TOAST).toContain("styles.toastCorner");
  });

  it("clears the centring transform in the corner", () => {
    /* THE HALF A SPREAD WOULD MISS. `left: 50%` survives an additive override, and a toast with both `left`
       and `right` set goes off the edge. */
    const corner = sliceBetween(TOAST, "toastCorner: {", "},");
    expect(corner).toContain('left: "auto"');
    expect(corner).toContain('transform: "none"');
  });

  it("gives the corner its own keyframe", () => {
    // The centred keyframe bakes `translate(-50%)` into both ends; that is the centring, not the animation.
    expect(TOAST).toContain("@keyframes app-action-toast-in-corner");
    expect(TOAST).toContain("app-action-toast-corner");
  });
});

/* ------------------------------------------------------------------ */
/* Item 10 (addendum) -- design note #1015, through the reducer       */
/* ------------------------------------------------------------------ */

describe("the privates pay every Operating Round, not every set", () => {
  it("routes both openings through the paying helper", () => {
    /* THE MECHANISM, pinned where it is decidable. `advanceCorporation` opens rounds two and three of a set
       and called `beginOperatingRound` directly, so they opened without paying -- which is why the toast that
       follows the payout appeared once and then never again. */
    const reducer = readStripped("utils/sandboxSession.ts");
    expect(reducer).toContain("...openOperatingRound(state, priceFor, markFor, true),");
    expect(reducer).toContain("...openOperatingRound(");
  });

  it("leaves the empty-queue REPAIR unpaid", () => {
    /* AN OPENING AND A REPAIR LOOK ALIKE AND ARE NOT. `advanceCorporation`'s recovery rebuilds the order for a
       round already in progress; paying there would hand out a second round of income for one round. */
    const reducer = readStripped("utils/sandboxSession.ts");
    const recovery = sliceBetween(
      reducer,
      "const rebuilt = beginOperatingRound(state, priceFor, markFor);",
      "operating_round_just_ended: true }",
    );
    expect(recovery).not.toContain("openOperatingRound");
  });

  it("actually moves the money when a round opens", () => {
    /* THE BEHAVIOURAL HALF, so this cannot pass on the strength of a renamed call. `openOperatingRound` is
       `beginOperatingRound` plus the payout, and the difference is a treasury. */
    const state = {
      game_id: 1,
      current_round_type: "OperatingRound",
      macro_round_number: 1,
      sub_round_index: 1,
      active_operating_order: [],
      active_corporation_index: 0,
      active_player_index: 0,
      player_addresses: ["p1"],
      player_cash: [{ player: "p1", cash_vgp: "100" }],
      bank_cash_vgp: "12000",
      public_companies: [],
      private_companies: [
        {
          private_id: 1,
          name: "Schuylkill Valley",
          revenue_per_or: 5,
          owner: "p1",
          owner_protocol_id: null,
          closed: false,
        },
      ],
    } as unknown as Parameters<typeof applyPrivateRevenue>[0];

    const paid = applyPrivateRevenue(state);
    expect(paid?.total).toBe(5);
    expect(paid?.payouts).toHaveLength(1);
  });

  it("keeps `beginOperatingRound` exported and payment-free", () => {
    /* NAMED APART SO THE NEXT CALLER CANNOT REACH FOR THE WRONG ONE -- the two differ by whether money moves,
       which is not visible at a call site. */
    expect(typeof beginOperatingRound).toBe("function");
    expect(typeof openOperatingRound).toBe("function");
  });
});

/* ------------------------------------------------------------------ */
/* Item 8 -- design note #1017                                        */
/* ------------------------------------------------------------------ */

describe("the variant sentence reaches every seat", () => {
  it("is raised from the dispatch path, not from the click handler", () => {
    /* THE REPORTED BUG, AND THE USER'S OWN DIAGNOSIS: "the variant texts may only be printing in the Activity
       Log for the local player who's the president." `logInfo` appends to a LOCAL feed, and only one browser
       runs a click handler; every client replays `runGameplayAction`. */
    /* Design note #1056: the guard moved to the RUN -- see `batch51.test.ts` for why. What this case asserts
       is unchanged and is the half that matters: the block is on the shared dispatch path (`before`, `after`
       and `msg`, which every client has when replaying) rather than in a click handler only one browser runs. */
    expect(APP).toContain('"RunMultipleRoutes" in msg &&');
    expect(APP).toContain("resolveVariants(before.variants).unpredictableRevenue");
  });

  it("no longer narrates from the run-trains handler", () => {
    /* ANCHORED ON A COUNT, NOT ON A SLICE. The first draft sliced from "DESIGN NOTE 1017" -- a COMMENT, which
       `readStripped` has already removed by the time the slice runs, so `sliceBetween` threw. #490a's rule,
       walked into again: scan a stripped copy for code and assert the note separately against raw text.
       ONE CALL SITE IS THE CLAIM ANYWAY. The bug was that the sentence was raised somewhere only one browser
       runs; "there is exactly one place that raises it, and it is the shared one" says that completely, and
       says it without depending on where any comment sits. */
    expect(APP.split("turnRevenueSentence(").length - 1).toBe(1);
    expect(APP.split("setRevenueFlash({").length - 1).toBe(1);
  });

  it("seeds the roll from the replayed state, not from render state", () => {
    /* A REPLAYING CLIENT HAS NO RENDER STATE THAT MATCHES THE ACTION IT IS REPLAYING. A seed off `gameState`
       would give a different face on every browser, which is worse than the missing line being fixed. */
    expect(APP).toContain("macroRound: before.macro_round_number ?? 0,");
    expect(APP).toContain("subRound: before.sub_round_index ?? 0,");
  });

  it("keeps the flash with the sentence", () => {
    // #941's own title: one roll, one flash, one sentence. Splitting them was never on offer.
    const block = sliceBetween(
      APP,
      // Design note #1056: the flavour block lives on the run now, not on the dividend.
      '"RunMultipleRoutes" in msg &&',
      'if (after && "DeclareDividends" in msg',
    );
    expect(block).toContain("turnRevenueSentence(");
    expect(block).toContain("setRevenueFlash({");
  });

  it("records why it moved, in the note rather than only in the diff", () => {
    // #490a: the claim goes against RAW text, because a stripped copy has no notes in it.
    const raw = readSource("App.tsx");
    expect(raw).toContain("DESIGN NOTE 1017");
    expect(raw).toContain("only the acting president ever invokes");
  });

  it("declines when nothing ran", () => {
    // A forced withhold declares dividends with no routes behind it; there is no run to narrate.
    expect(APP).toContain("if (printedTurnTotal > 0) {");
  });
});

/* ------------------------------------------------------------------ */
/* Item 9 -- design note #1018                                        */
/* ------------------------------------------------------------------ */

describe("the auto-skip refuses to answer before it can", () => {
  const board = { game_id: 1, tiles: [{ q: 0, r: 0, tile_id: 57, orientation: 0 }] } as never;
  const bare = { game_id: 1, tiles: [] } as never;

  it("skips a corporation that provably owns no trains", () => {
    const verdict = earnableRevenueVerdict({
      ownedTrains: [],
      stationTokenCount: 1,
      mapGrid: board,
      searchRevenue: () => 0,
    });
    expect(verdict.kind).toBe("cannot-earn");
    expect(skipReasonFor(verdict)).toMatch(/owns no trains/);
  });

  it("skips a corporation whose trains provably reach nothing", () => {
    const verdict = earnableRevenueVerdict({
      ownedTrains: ["2"],
      stationTokenCount: 1,
      mapGrid: board,
      searchRevenue: () => 0,
    });
    expect(verdict.kind).toBe("cannot-earn");
  });

  it("does NOT skip while the board is still empty", () => {
    /* THE REPORTED BUG. `mapGrid` starts as `MOCK_MAP_GRID`, whose `tiles` is `[]` -- and a route search over
       a bare board answers zero for a corporation that has track everywhere. The auto-skip commits its first
       answer permanently, so an unsettled input is not corrected, it is acted on. */
    const verdict = earnableRevenueVerdict({
      ownedTrains: ["2"],
      stationTokenCount: 1,
      mapGrid: bare,
      searchRevenue: () => 0,
    });
    expect(verdict.kind).toBe("unknown");
    expect(skipReasonFor(verdict)).toBeNull();
  });

  it("does NOT skip when the chain has not reported the fleet", () => {
    // #232: `undefined` means "the chain did not say", never "there are none".
    const verdict = earnableRevenueVerdict({
      ownedTrains: undefined,
      stationTokenCount: 1,
      mapGrid: board,
      searchRevenue: () => 0,
    });
    expect(skipReasonFor(verdict)).toBeNull();
  });

  it("does NOT skip when the search itself declines", () => {
    /* #414's "could not tell, never zero", carried through instead of flattened. `assignRouteSet` returns
       `totalRevenue: 0` for three different situations and the old code read all three as a refusal. */
    const verdict = earnableRevenueVerdict({
      ownedTrains: ["2"],
      stationTokenCount: 1,
      mapGrid: board,
      searchRevenue: () => null,
    });
    expect(verdict.kind).toBe("unknown");
    expect(skipReasonFor(verdict)).toBeNull();
  });

  it("lets a corporation that can earn through untouched", () => {
    const verdict = earnableRevenueVerdict({
      ownedTrains: ["2"],
      stationTokenCount: 1,
      mapGrid: board,
      searchRevenue: () => 70,
    });
    expect(verdict.kind).toBe("can-earn");
    expect(skipReasonFor(verdict)).toBeNull();
  });

  it("is what the shell actually consults", () => {
    // The #1006 lesson: a rule tested where it lives and never where it is asked is a rule with a door beside it.
    expect(APP).toContain("const earnableVerdict = useMemo(");
    expect(APP).toContain("skipReasonFor(earnableVerdict)");
  });
});
