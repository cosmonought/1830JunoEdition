/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 910 (harness): THE SCHEMA WAS WIRED DOWN A ROAD NOBODY DRIVES
// ==================================================================
//
// REPORTED: "there are no options visible in the Lobby to actually select them."
//
// AND EVERY EXISTING TEST PASSED THE WHOLE TIME. `gameVariants.test.ts` proves `resolveVariants` is right;
// `variantRules.test.ts` proves each rule fires when the config says so; the reducer takes the config off the
// `SetupGame` message correctly. What none of them asked is whether anything ever PUTS a variant into that
// message -- and on the path a sandbox table actually uses, nothing did. `handleStartSandboxGame` dispatched
// `SetupGame: { players: seated }` and the controls lived on a different lobby's create-room form.
//
// SO THIS FILE TESTS THE CHAIN RATHER THAN THE LINKS. Three claims, each about a JOIN between two modules
// that were individually correct:
//   the room document carries the variants, so every seat sees the same terms;
//   the setup dispatch reads them off the room rather than off local state;
//   the five the Lobby offers are exactly the five the schema defines.
//
// A SOURCE SCAN FOR THE LAST TWO, deliberately. "Does the dispatch include the field" and "does the panel
// render a control per flag" are questions about wiring, and wiring is what a unit test of either side cannot
// see -- which is the whole reason the bug survived four batches of green suites.

import { readStripped, sliceBetween } from "./sourceScan";
import {
  resolveVariants,
  STANDARD_VARIANTS,
  VARIANT_BLURB,
  type GameVariants,
} from "./gameVariants";

/** Every boolean flag in the schema, derived from the standard config rather than typed out -- so a sixth
 *  variant is covered by these cases the day it is added rather than the day somebody remembers. */
const BOOLEAN_FLAGS = (Object.keys(STANDARD_VARIANTS) as Array<keyof GameVariants>).filter(
  (key) => typeof STANDARD_VARIANTS[key] === "boolean",
);

describe("the room document carries the table's house rules (design note #910)", () => {
  const source = readStripped("utils/sandboxRoom.ts");

  it("is really the module", () => {
    // #490a: an absence proves nothing about a file that failed to load.
    expect(source).toContain("SandboxRoomDoc");
  });

  it("reads variants off the document rather than defaulting per client", () => {
    /* THE POINT OF PUTTING THEM ON THE ROOM. Every seat is subscribed to it, so the host and the guests are
       looking at one answer -- and a guest pressing Ready is agreeing to terms they can see. Held in the
       host's component state instead, they would be visible to one person and applied to everybody. */
    expect(source).toContain("resolveVariants(data.variants");
  });

  it("has a writer for them", () => {
    expect(source).toContain("setSandboxRoomVariants");
  });

  it("opens a new room on the printed game", () => {
    /* A room that opened on `undefined` would deal 1830 anyway -- `resolveVariants` sees to that -- but the
       waiting room would render its controls from a config nobody had chosen. */
    expect(source).toContain("variants: STANDARD_VARIANTS");
  });
});

describe("the setup dispatch carries them (design note #910)", () => {
  const source = readStripped("App.tsx");

  it("puts the room's variants into the SetupGame action", () => {
    /* ==================================================================
        THE ASSERTION WHOSE ABSENCE WAS THE BUG
       ==================================================================
       This dispatch read `SetupGame: { players: seated }`. Every client deals from that one action, so a
       config that is not IN it does not exist -- and the reducer, which handles `msg.SetupGame.variants`
       perfectly, was being handed `undefined` on every game this path started. */
    expect(source).toContain("SetupGame: { players: seated, variants: sandboxRoom.variants }");
  });

  it("takes them from the room and not from a local selection", () => {
    /* #550's rule: a decision only one browser holds is a decision only one browser plays. Asserted as the
       ABSENCE of the tempting alternative as well as the presence of the right one, because both would make
       the case above pass on a day when a local `variants` state also existed. */
    expect(source).not.toContain("SetupGame: { players: seated, variants }");
  });
});

describe("the waiting room offers every variant the schema defines (design note #910)", () => {
  const source = readStripped("components/SandboxWaitingRoom.tsx");

  it("is really the panel", () => {
    expect(source).toContain("SandboxWaitingRoom");
    expect(source).toContain("House rules");
  });

  it("binds a control to each boolean flag", () => {
    /* THE COUNT IS THE ASSERTION, and it is derived from the schema rather than fixed at four. The reported
       bug was two flags rendered out of five -- a number nobody would notice being wrong in a review, and
       one this case makes impossible to get wrong silently. */
    expect(BOOLEAN_FLAGS.length).toBeGreaterThan(0);
    for (const flag of BOOLEAN_FLAGS) {
      expect([flag, source.includes(`key: "${flag}"`)]).toEqual([flag, true]);
    }
  });

  it("offers the bank length as its own control", () => {
    /* Not a boolean, so it is not in the loop above and would be exactly the field a schema-derived check
       quietly skips. */
    expect(source).toContain("BANK_SIZE_BY_LENGTH");
    expect(source).toContain("GAME_LENGTH_BLURB");
  });

  it("renders the toggles from the table rather than by hand", () => {
    /* WHY THE DATA TABLE EXISTS. Five hand-written blocks is five chances to forget the sixth, which is this
       bug at the scale of one row instead of one panel. */
    /* Design note #924 put a `.filter` between the table and the `.map`, so the anchor is the table's use
       rather than the exact call -- what this case is about is that the rows come from data. */
    expect(source).toContain("VARIANT_TOGGLES.filter");
    expect(source).toContain(").map((toggle) =>");
  });

  it("shows a guest the terms in force, and only those (design note #924)", () => {
    /* #910 SAID "terms only the host can read are not terms" and made every seat read the whole MENU. A guest
       is agreeing to a game, not reviewing a settings screen: four unticked boxes are not terms either.
       THE FILTER IS THE ASSERTION, and it is written so the host is exempt -- the host is choosing rather
       than agreeing, and needs the options that are off in order to turn them on. */
    expect(source).toContain("canEditVariants || variants[toggle.key]");
    expect(source).toContain("disabled={!canEditVariants}");
    expect(source).toContain("Only the host can change these");
  });

  it("says so when a guest's filtered list would be empty", () => {
    /* A heading with nothing under it reads as a loading state rather than as a settled table. */
    expect(source).toContain("playing 1830 as printed");
  });

  it("gives the rules text a legible treatment (design note #924)", () => {
    /* REPORTED: "too small and too gray against the dark background." These descriptions are the CONTENT of
       the decision, not a caption on a control whose label already carries it, so they take this app's body
       treatment rather than `AutoPassModal`'s micro/grey captions. */
    const note = sliceBetween(source, "variantNote: {", "},");
    expect(note).toContain("FONT_SIZE.small");
    expect(note).not.toContain("FONT_SIZE.micro");
    expect(note).toContain("#c8cdd8");
  });

  it("tells a table what the rounding rule does to their dividends (design notes #922 -> #961)", () => {
    /* ==================================================================
        THE RULE SURVIVES; THE SENTENCE IT NAMED DOES NOT
       ==================================================================
       THIS ASSERTED `"rounded to the nearest whole dollar"`, which was #922's per-share rounding -- and that
       is not how the variant has worked since #938 replaced it with rounding the TURN TOTAL to the nearest
       ten. The assertion was pinning a sentence that had become false about the game, which is worse than
       pinning nothing: it would have blocked the correction.
       AND THE SENTENCE WAS ONLY EVER IN ONE OF THE TWO PLACES. #961 found this text in the waiting room and a
       shorter version in the Lobby, already a whole clause apart. The blurbs now live in `gameVariants`
       beside the rules, in one copy that both surfaces read.
       #922'S ACTUAL RULE IS UNCHANGED AND IS WHAT IS ASSERTED NOW: "The variant changes how money is divided,
       and the one place a player agrees to it is this description." So the description must still name the
       rounding -- and `variantCopy.test.ts` checks that the figure it names is the one the arithmetic
       produces, which is the half this case could never have caught. */
    expect(source).toContain("VARIANT_BLURB.unpredictableRevenue");
    expect(VARIANT_BLURB.unpredictableRevenue).toContain("rounded to the nearest $10");
  });

  it("stops accepting changes once the game is running", () => {
    // The variants travel in `SetupGame`; editing them afterwards would describe a game nobody is playing.
    expect(source).toContain('room?.status === "waiting"');
  });
});

describe("the schema still resolves what the panel writes", () => {
  it("round-trips a fully non-standard table", () => {
    /* The join at the other end: whatever the host ticks must survive `resolveVariants` unchanged, or the
       panel and the reducer disagree about the game. */
    const chosen: GameVariants = {
      length: "long",
      delayedAuction: true,
      gentleRust: true,
      unpredictableRevenue: true,
      dynamicStockMarket: true,
    };
    expect(resolveVariants(chosen)).toEqual(chosen);
  });
});

describe("the dividend pays what was banked (design notes #917 -> #934)", () => {
  /* ==================================================================
      THE DISCONNECT, AND WHY NO EXISTING TEST SAW IT
     ==================================================================
     REPORTED: "the Unpredictable Revenue variant is calculating the +/- modifier for the Activity Log, but
     the actual Dividends phase is still paying out based on the standard printed route value."
     TWO CORRECT MODULES, ONE OPEN JOIN -- #910's shape again. The reducer applies the die and banks the
     modified figure in `last_route_revenue`; `dividendDeclaration` prefers a COMMITTED total; and the shell
     was building that total by summing `draft.value`, the planner's printed figure. Every unit test of every
     piece passed while the log said $84 and the treasury received $70.
     A SOURCE SCAN, because this is a wiring question: which of two available figures the shell hands on.

     ------------------------------------------------------------------
      SUPERSEDED BY DESIGN NOTE 934, AND THE ORIGINAL ASSERTIONS ARE RECORDED HERE RATHER THAN DELETED
     ------------------------------------------------------------------
     #917 fixed this by having the shell read `last_route_revenue` into the committed total instead of summing
     the planner's figures, and these cases pinned that wiring:
         expect(APP).toContain("?.last_route_revenue,");
         expect(APP).toContain("const committedTotal = Number.isFinite(bankedTotal)");
         expect(commitBlock).toContain("runnable.reduce");
     THE AUTHORITY WAS RIGHT AND THE CLOCK WAS WRONG. That read happens the instant the dispatch loop
     finishes, and in a sandbox ROOM `runGameplayAction` appends the action to the log and returns -- the
     reducer runs later, from the snapshot. So a three-train turn committed whatever had landed by then,
     usually one train, and the commitment CAPPED the dividend at it. Reported as "$150 ran, $50 paid".
     SO THE CACHE IS GONE ENTIRELY rather than being read at a better moment. Both of #492's reasons for it
     were fixed in the field itself -- #903 accumulates instead of overwriting, #777 clears on the turn change
     -- which leaves `last_route_revenue` as the single authority, read where it is SPENT.
     WHAT SURVIVES OF #917 IS ITS RULE, NOT ITS MECHANISM: the shell may read the reducer's answer and must
     never compute its own. That is what the cases below assert now, and it is the half worth keeping. */
  const APP = readStripped("App.tsx");

  it("commits no total of its own at Run Routes", () => {
    /* THE CACHE, ASSERTED ABSENT. `committedRouteRevenue` is removed, so the only mention left in the shell
       is #934's own note explaining why -- which is why this asks for the STATE and the setter rather than
       the bare word (#490a: an absence check that also matches its own explanation proves nothing). */
    expect(APP).not.toContain("setCommittedRouteRevenue(");
    expect(APP).not.toContain("committedRouteRevenueRef");
  });

  it("hands the dividend step nothing to prefer over the field", () => {
    /* `dividendDeclaration` still TAKES a commitment -- #492's zero case is a real rule and the function must
       keep expressing it. The shell simply no longer has one to give, and that must be stated at both call
       sites or the one left behind reintroduces the cap. */
    expect(APP.match(/committedRevenue: null,/g)?.length ?? 0).toBe(2);
  });

  it("does not roll the die a second time in the shell", () => {
    /* THE FIX THAT WOULD HAVE LOOKED RIGHT, and the reason #934 removed the cache rather than filling it from
       a recomputed roll. Applying the modifier here too would make the figures agree and put two
       implementations of one rule in the codebase, one of which moves money -- #775's exact failure.
       SCOPED TO THE RUN-TRAINS CALLBACK, because the shell legitimately rolls elsewhere: #907's flavour line
       narrates the die, and #935's log sentence reports the modified figure. Neither moves money. */
    const runBlock = sliceBetween(APP, "const runnable = runnableDrafts(", "setLiveOrSubPhase(");
    expect(runBlock).not.toContain("rollRouteRevenue");
    expect(runBlock).not.toContain("applyRevenuePercent");
  });

  it("still dispatches one route per runnable draft", () => {
    /* THE LOOP ITSELF, pinned because #934 deleted the lines directly beneath it and an edit that took the
       loop with them would produce a turn that pays correctly and runs nothing. */
    const runBlock = sliceBetween(APP, "const runnable = runnableDrafts(", "setLiveOrSubPhase(");
    expect(runBlock).toContain("for (const draft of runnable)");
    expect(runBlock).toContain("RunManualRoute");
  });
});

describe("a batch of actions gets a batch of indices (design note #916)", () => {
  /* ==================================================================
      REPORTED AS A LOG BUG; IT IS AN ACTION-LOG BUG
     ==================================================================
     "When a corporation runs multiple trains in a single turn, the Activity Log is only printing the run for
     one train." The cause is that `appliedIndexRef.current` advances on the SNAPSHOT, while
     `appendSandboxAction` awaits only the write -- so three routes dispatched in one loop were appended at
     one index. `index` is what `orderBy` sorts on and what `effectiveActions` matches a `RevertTo` against,
     so this was an ambiguous ordering in the structure #522 calls the game itself. */
  const APP = readStripped("App.tsx");

  it("advances the cursor on a successful append", () => {
    expect(APP).toContain("appliedIndexRef.current = appendAt + 1;");
  });

  it("appends at a captured index rather than re-reading the ref", () => {
    /* The write and the advance must agree about which slot was taken; reading the ref twice would let a
       snapshot landing mid-await move it between them. */
    expect(APP).toContain("const appendAt = appliedIndexRef.current;");
    expect(APP).toContain("            appendAt,");
  });

  it("does not advance on a failed write", () => {
    /* A refused append must leave the slot free, or the next action skips a position and the log carries a
       hole that `effectiveActions` would read as a missing entry. */
    expect(APP).toContain("} else if (appliedIndexRef.current === appendAt) {");
  });

  it("still lets the snapshot be the authority", () => {
    /* THE CONTROL ON THE OPTIMISM. The ref is recomputed from the log on every snapshot; this only fills the
       gap between writes in one tick. If that recomputation went, the client would drift from the log it is
       supposed to be replaying. */
    expect(APP).toContain("actions.length > 0 ? actions[actions.length - 1].index + 1 : 0");
  });
});

describe("the polish wave's smaller fixes (design notes #928 / #929 / #931 / #932)", () => {
  const toast = readStripped("components/ActionToast.tsx");
  const prompt = readStripped("components/PrivateTradePanel.tsx");
  const sheet = readStripped("styles/appStyles.ts");

  it("gives the toast time to be read", () => {
    /* The receipts grew into this complaint: #923's headline carries three figures and #738's detail line a
       treasury transition, against a duration set for a one-clause receipt. */
    expect(toast).toContain("durationMs = 3700");
  });

  it("draws the era change rather than only stating it", () => {
    /* A descriptor, not a node -- the toast's state stays plain data and this component keeps sole ownership
       of what a Green hex looks like. */
    expect(toast).toContain("eraTransition");
    expect(toast).toContain("ERA_HEX_FILL");
    expect(toast).toContain("function EraHex");
  });

  it("keeps the trade prompt in the corner and makes it an alert", () => {
    /* THE POSITION WAS NEVER THE PROBLEM. `bottom: 20px` stays; the palette moves from this app's ordinary
       panel ink to its "waiting on you" amber, plus a coloured glow so it is the only lit object down there. */
    const root = sliceBetween(prompt, "promptRoot: {", "},");
    expect(root).toContain('bottom: "20px"');
    expect(root).toContain("#c9a227");
    expect(root).toContain("rgba(201, 162, 39");
  });

  it("projects the recipient's cash in the house format", () => {
    expect(prompt).toContain("Cash: ${recipientCash} &gt; ${recipientCash + proposal.price}");
    /* #670: absent rather than guessed when the figure is unknown. */
    expect(prompt).toContain("recipientCash !== null");
  });

  it("strengthens the private mark without turning it into a border", () => {
    /* #884 refused a gradient border on two grounds that both still hold -- the border is a STATE channel,
       and a gradient needs `borderImage`, which cannot participate in a `borderColor` longhand. The mark gets
       louder instead, and picks up the canvas halo. Asserted as an absence too, since "make it a border" is
       the request this note is declining. */
    const mark = sliceBetween(sheet, "actionBarPowerChipMark: {", "},");
    expect(mark).toContain("boxShadow");
    expect(mark).toContain("PRIVATE_POWER_GLOW_STOPS");
    expect(mark).not.toContain("borderImage");
  });
});

