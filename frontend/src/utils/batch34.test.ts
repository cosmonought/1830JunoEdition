/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1027-1030 (harness): BATCH 34
// ==================================================================
//
// Four items from one playtest. Two are rules and are driven; two are copy and colour and are asserted on the
// source that produces them.

export {};

const { privatePowerOfferAt, PRIVATE_POWER_SUB_PHASE } =
  require("./privatePowerOffer") as typeof import("./privatePowerOffer");
const { readStripped, readSource, sliceBetween } =
  require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");

/* ------------------------------------------------------------------ */
/* Item 1 -- design note #1027                                        */
/* ------------------------------------------------------------------ */

describe("a hex power is only offered at the step that can use it", () => {
  const offers = [
    { hexKey: "3,4", abilityKey: "dhTrack" },
  ] as unknown as Parameters<typeof privatePowerOfferAt>[0]["offers"];

  const ask = (subPhase?: string | null) =>
    privatePowerOfferAt({
      hexKey: "3,4",
      actingViewer: true,
      errandArmed: false,
      offers,
      subPhase,
    });

  it("offers it during Lay Track", () => {
    expect(ask(PRIVATE_POWER_SUB_PHASE)).not.toBeNull();
  });

  it("refuses it during Buy Private", () => {
    /* THE REPORT. "A player clicked a special Private Company hex during the 'Buy/Skip Private' subphase. The
       'Use Private Power' modal popped up prematurely. Lying track failed." The powers this raises are
       lay-track actions; offered a step early, the player accepts and the lay then has nowhere to go. */
    expect(ask("BuyPrivate")).toBeNull();
  });

  it("refuses it at every other step too", () => {
    /* NAMED INDIVIDUALLY rather than assumed from one case: the gate is an equality against one step, and a
       gate written as "not BuyPrivate" would pass the case above and fail every other way. */
    for (const step of ["Tokens", "Routes", "Dividends", "Hardware"]) {
      expect(ask(step)).toBeNull();
    }
  });

  it("still offers it when the caller cannot say which step it is", () => {
    /* `operating_sub_phase` IS OPTIONAL ON THE RESPONSE and `dividendGate` treats an absent cursor as
       permissive for exactly that reason -- refusing on a missing field would brick a seeded or legacy board
       on the strength of an absence. Both spellings, because `undefined` and `null` reach here by different
       routes. */
    expect(ask(undefined)).not.toBeNull();
    expect(ask(null)).not.toBeNull();
  });

  it("keeps the two rules it already had", () => {
    /* THE CONTROL. A phase gate that also broke the watcher rule or the armed-errand rule would pass every
       case above -- #845 and #725 are why those exist and neither is superseded. */
    const base = { hexKey: "3,4", offers, subPhase: PRIVATE_POWER_SUB_PHASE };
    expect(privatePowerOfferAt({ ...base, actingViewer: false, errandArmed: false })).toBeNull();
    expect(privatePowerOfferAt({ ...base, actingViewer: true, errandArmed: true })).toBeNull();
  });

  it("is asked with the cursor from the shell", () => {
    // #1006's lesson: a gate the deciding caller never supplies an argument to is not a gate.
    expect(APP).toContain("subPhase: orSubPhaseRef.current,");
    expect(APP).toContain("orSubPhaseRef.current = orSubPhase;");
  });

  it("clears a parked request when the step turns", () => {
    /* THE SECOND HALF OF THE REPORT: "clicking the UI button applied the power but failed to show the modal."
       `setPrivatePowerRequest(sameKey)` is a no-op to React, so a key parked by the premature click meant the
       button at the correct step changed nothing. */
    expect(APP).toContain("setPrivatePowerRequest(null);");
  });
});

/* ------------------------------------------------------------------ */
/* Item 2 -- design note #1029                                        */
/* ------------------------------------------------------------------ */

describe("the log stops narrating the tile count", () => {
  it("prints nothing for an ordinary lay", () => {
    /* REPORTED: "[OR 6.2--Lay Track] Board -- Board now holds 15 tiles (was 14)." One line per tile ever
       placed, to say the board grew by the one tile the player just watched arrive. */
    expect(APP).toContain("if (gridChange?.unexplained) {");
    expect(APP).not.toContain('gridChange.unexplained ? "Board (unexplained)" : "Board",');
  });

  it("keeps the alarm", () => {
    /* SUPPRESSED, NOT DELETED. #768 built this to catch a board LOSING a tile -- "a fall is unconditionally a
       bug and this is the line that will name it" -- and a corrupted board is the one class of failure this
       project cannot recover from. The classifier still runs; only the boring case stops printing. */
    expect(APP).toContain("describeGridChange(msg, mapGridRef.current, nextGrid, fallbackLabel)");
    expect(APP).toContain('logInfo("Board (unexplained)", gridChangeLine(gridChange));');
  });

  it("leaves the module that classifies it alone", () => {
    // The rule is unchanged; only one caller's appetite for it is. A deleted classifier would be the fix
    // answering the report by removing the instrument.
    expect(readStripped("utils/gridProvenance.ts")).toContain("export function gridChangeLine");
  });
});

/* ------------------------------------------------------------------ */
/* Item 3 -- design note #1028                                        */
/* ------------------------------------------------------------------ */

describe("every corporation keeps its own last run", () => {
  const REDUCER = readStripped("utils/sandboxSession.ts");
  const PANEL = readStripped("components/StockRoundPanel.tsx");

  it("files the figure away in the same expression that clears it", () => {
    /* THE DIAGNOSIS, which the report sharpened mid-batch: "it was only printing the Last Run value of the
       last corporation to run." #777 clears `last_route_revenue` on every turn change -- rightly -- so the
       only card still holding a figure was whichever corporation was mid-turn. */
    expect(REDUCER).toContain("last_completed_run_revenue: company.last_route_revenue");
    expect(REDUCER).toContain('last_route_revenue: "0",');
  });

  it("does not overwrite a real figure with a zero", () => {
    /* A TURN THAT EARNED NOTHING must not file $0 over the last figure the corporation actually earned --
       "Last run $0" is a different claim from "this corporation has run before". */
    expect(REDUCER).toContain("Number(company.last_route_revenue ?? 0) > 0");
  });

  it("never clears the persistent field", () => {
    /* THE PROPERTY THE WHOLE FIX RESTS ON. A second clear would reproduce the bug with an extra field, and
       this is the assertion that would catch one being added. */
    expect(REDUCER).not.toContain('last_completed_run_revenue: "0"');
  });

  it("prefers the live figure for the corporation now operating", () => {
    /* ITS RUN HAS HAPPENED AND HAS NOT YET BEEN FILED, so the stale one would be a card disagreeing with the
       board in front of the player. */
    expect(PANEL).toContain("const lastRun = liveRun > 0 ? liveRun : filedRun;");
  });

  it("renders the resolved figure rather than the raw field", () => {
    /* ASSERTED AS THE INTERPOLATED NAME, not as the whole JSX expression. The panel writes `$` immediately
       before `${lastRun}`, so a reassembled literal has to carry TWO dollar signs -- one text, one syntax --
       and the first draft of this case carried one and failed. The name being interpolated is the claim
       anyway; the punctuation around it belongs to the renderer. */
    expect(PANEL).toContain("{lastRun}");
    expect(PANEL).not.toContain("{company.last_route_revenue}");
  });


  it("keeps a corporation that has never run on a dash", () => {
    /* #232 AND #447 TOGETHER: `undefined` is "this build cannot say", "0" is "it earned nothing", and a
       company that never operated reports one of the two. The honest test is still a positive figure. */
    expect(PANEL).toContain("const hasRunRoutes = lastRun > 0;");
  });

  it("declares the field with the rest of the company state", () => {
    expect(readStripped("utils/gameState.ts")).toContain("last_completed_run_revenue?: string;");
  });
});

/* ------------------------------------------------------------------ */
/* Item 4 -- design note #1030                                        */
/* ------------------------------------------------------------------ */

describe("the toast stands off the board", () => {
  const TOAST = readStripped("components/ActionToast.tsx");
  const body = sliceBetween(TOAST, "  toast: {", "  },");

  it("is a light ground with dark text", () => {
    /* ==================================================================
        DESIGN NOTE 1048: THE GROUND IS A SHARED CONSTANT NOW, NOT A LITERAL
       ==================================================================
       THIS PINNED `#f6f1e4`, the hex #1030 chose to get the toast off the dark map. The auction's private
       cards were independently using `CARD_SURFACE` at `#f7f5f0` -- two hand-picked creams one shade apart,
       meaning the same thing and free to drift, which is #891's shape in a palette. The toast now takes the
       shared constant, so the resemblance is a statement rather than a coincidence.
       WHAT THIS CASE IS FOR SURVIVES INTACT: a LIGHT ground with DARK text, which is the pair #1030 measured
       and the reason the toast is legible over the board at all. The ink is still asserted literally, because
       it has no shared constant to point at -- and the negative case below still forbids the dark green.
       ASSERTED AS THE CONSTANT rather than as its value, deliberately. Re-pinning `#f7f5f0` here would put a
       third copy of the colour in the tree and defeat the point of sharing it. */
    expect(body).toContain("backgroundColor: CARD_SURFACE,");
    /* Design note #1092: THE INK NOW HAS A CONSTANT, so this asserts the constant rather than a value --
       which is what the paragraph above already argued for the ground and could not yet do for the ink.
       The pair #1030 measured is intact and stronger: dark on light, 17.59:1 against the original 13.93:1.
       Both halves of the pairing now come from one module and cannot drift apart. */
    expect(body).toContain("color: CARD_INK,");
  });

  it("no longer wears the dark green that blended in", () => {
    expect(body).not.toContain('backgroundColor: "#16211a"');
    expect(body).not.toContain('border: "1px solid #3f7a55"');
  });

  it("darkens every foreground that sat on the old ground", () => {
    /* THE HALF A BACKGROUND SWAP FORGETS. Four colours were chosen against near-black; left alone on cream
       they range from washed out to invisible, and the detail rows are where the figures live. */
    expect(TOAST).not.toContain('color: "#9fb8a4"');
    expect(TOAST).not.toContain('color: "#d8e6da"');
    expect(TOAST).not.toContain('color: "#8a90a0"');
  });

  it("keeps the tick green, deepened for the new ground", () => {
    /* #670's RULE SURVIVES: green means money or a thing arriving. What changes is the shade, because the old
       one was picked against a ground that no longer exists. */
    expect(TOAST).toContain('check: { color: "#1f7a4d"');
  });

  it("still lets clicks fall through", () => {
    // It reports; it does not receive. A restyle must not turn a notice into something that eats a purchase.
    expect(body).toContain('pointerEvents: "none"');
  });

  it("records why the livery option was declined", () => {
    /* #490a: the claim goes against RAW text. The report offered corporation-colour tinting and this chose
       not to -- a decision worth finding rather than re-proposing. */
    expect(readSource("components/ActionToast.tsx")).toContain("NOT THE ACTING CORPORATION'S LIVERY");
  });
});
