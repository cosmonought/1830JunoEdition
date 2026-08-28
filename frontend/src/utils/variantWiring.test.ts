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
import { resolveVariants, STANDARD_VARIANTS, type GameVariants } from "./gameVariants";

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
    expect(source).toContain("VARIANT_TOGGLES.map");
  });

  it("shows the terms to a guest instead of hiding them", () => {
    /* A guest is about to agree to this game by pressing Ready. The controls are DISABLED for them, not
       absent -- terms only the host can read are not terms. */
    expect(source).toContain("disabled={!canEditVariants}");
    expect(source).toContain("Only the host can change these");
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

describe("the dividend pays what was banked (design note #917)", () => {
  /* ==================================================================
      THE DISCONNECT, AND WHY NO EXISTING TEST SAW IT
     ==================================================================
     REPORTED: "the Unpredictable Revenue variant is calculating the +/- modifier for the Activity Log, but
     the actual Dividends phase is still paying out based on the standard printed route value."
     TWO CORRECT MODULES, ONE OPEN JOIN -- #910's shape again. The reducer applies the die and banks the
     modified figure in `last_route_revenue`; `dividendDeclaration` prefers a COMMITTED total; and the shell
     was building that total by summing `draft.value`, the planner's printed figure. Every unit test of every
     piece passed while the log said $84 and the treasury received $70.
     A SOURCE SCAN, because this is a wiring question: which of two available figures the shell hands on. */
  const APP = readStripped("App.tsx");

  it("reads the banked total off the reducer's own field", () => {
    expect(APP).toContain("?.last_route_revenue,");
    expect(APP).toContain("const committedTotal = Number.isFinite(bankedTotal)");
  });

  it("does not roll the die a second time in the shell", () => {
    /* THE FIX THAT WOULD HAVE LOOKED RIGHT. Applying the modifier here too would make the figures agree and
       put two implementations of one rule in the codebase, one of which moves money -- #775's exact failure.
       Asserted as an absence: the shell may READ the reducer's answer and must not compute its own. */
    const commitBlock = sliceBetween(APP, "const bankedTotal = Number(", "setCommittedRouteRevenue(");
    expect(commitBlock).not.toContain("rollRouteRevenue");
    expect(commitBlock).not.toContain("applyRevenuePercent");
  });

  it("keeps the planner sum as the fallback and not as the answer", () => {
    /* #232: a chain that does not report `last_route_revenue` cannot say, and an unmodified figure is right
       under standard rules and wrong under the variant -- the better of the two ways to be wrong. It must be
       the fallback arm, though, or the bug returns for every game. */
    const commitBlock = sliceBetween(APP, "const bankedTotal = Number(", "setCommittedRouteRevenue(");
    expect(commitBlock).toContain("runnable.reduce");
    expect(commitBlock.indexOf("bankedTotal")).toBeLessThan(commitBlock.indexOf("runnable.reduce"));
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

