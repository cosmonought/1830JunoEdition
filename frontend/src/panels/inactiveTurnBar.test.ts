// frontend/src/panels/inactiveTurnBar.test.ts
//
// ==================================================================
//  DESIGN NOTE 691 (harness): SOMEBODY ELSE'S TURN IS NOT A VIEW
// ==================================================================
//
// REPORTED: "on the non-active players' turn during the Operating Round, the
// Action Bar displays all the actions and views of the current player -- when
// the current player enters Buy Train, the inactive players' screens are filled
// with the Buy Train action panels."
//
// Design note #740 had already settled the principle and applied it to exactly
// one thing. Its own sentence -- "eight greyed buttons on four screens describe
// somebody else's decision" -- understates what was left behind it: a depot
// table, a payout ledger, a route planner and a train-purchase panel are far
// more screen than eight buttons.
//
// THIS IS THE THIRD TIME A TURN RULE HAS BEEN HALF-APPLIED in this codebase,
// which is why it gets a harness rather than a fix. #418 enforced the SR1 sell
// ban on the size selector and left the button live. #681 found `isMyTurn`
// arriving at the Stock Round panel and being spent on a header hint. Now #740.
// Every one was correct about the rule and incomplete about the surface, and
// none of them could fail a test, because "this renders when it should not" is
// invisible to `tsc` and to ESLint alike.
//
// SO THE ASSERTION IS STRUCTURAL: every Operating Round action surface in this
// file is gated on `mayActThisTurn`, and the list of what counts as one is
// written down rather than inferred. A new panel added without the gate fails
// here with the name of the thing that is missing.
//
// SOURCE-LEVEL, for the reason `subPhaseTrail.test.ts` records: this JSX needs a
// game state and a rendered tree, and what is under test is structural.

import fs from "fs";
import path from "path";

const SOURCE = fs.readFileSync(path.join(__dirname, "ContextualActionBar.tsx"), "utf8");
/** The shell, for the two consent prompts that must NOT be in the bar. */
const SHELL = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
/* Design notes here discuss the removed and the gated forms by name and at
   length. Absence checks read the stripped copy, the same trap the card and
   sub-phase harnesses document. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every render condition in the Operating Round branch that puts an ACTION on
 *  screen. Written out, because the failure mode is a new one being added and
 *  nobody noticing -- an inferred list would grow silently with the bug. */
/* ==================================================================
    DESIGN NOTE 862: THIS LIST WAS THE LAST TO HEAR ABOUT TWO CHANGES
   ==================================================================

   FOUND WHILE VERIFYING #859/#860/#861 -- three of these four had been red at HEAD, and neither of the two
   causes was a regression. Both were this session's dominant pattern in its twelfth form: A RULE RESTATED IN
   ONE AUTHORITY AND NEVER ASKED IN ITS SIBLING. Recorded rather than quietly repaired, because the list's
   whole premise is that it is written out by hand and so it can only be as current as its last reader.

   CAUSE ONE -- A TIGHTENING THE HARNESS READ AS AN ABSENCE. The two Hardware surfaces moved from `orSubPhase`
   to `orStep`, which line 1427 defines as `roundType === "OperatingRound" ? orSubPhase : null`: strictly
   narrower, and made for #841's reason that unqualified sub-phase questions were firing outside the Operating
   Round. The gate these tests defend was never touched. A `search` that returns -1 cannot tell "the surface
   lost its gate" from "the surface is spelled differently now", and it reports both as the first.

   CAUSE TWO -- A SURFACE THAT STOPPED BEING AN ACTION. The condensed drafted-routes row is on this list
   because in #740's day the chips WERE the draft cursor. #815 split that in two: `isOpen` ("this chip's route
   is showing") belongs to every viewer, `isDrafting` ("map clicks land on this train") belongs to the
   president. The row is now reference whose actionable half is gated INLINE -- `mayActThisTurn && draft...`
   on the cursor, and `if (mayActThisTurn) onSelectRouteTrain(...)` in the handler. Gating the whole row on
   the turn would DELETE a readout #802 built for watchers, so the old assertion did not merely fail, it
   asked for the wrong thing. It moves to "what an inactive player keeps" and takes its real rule with it.
   THE ORIGINAL ENTRY IS KEPT ABOVE IN PROSE because the reasoning that put it here was correct when written;
   what changed is the surface, not the judgement. */
const ACTION_SURFACES: ReadonlyArray<{ what: string; marker: RegExp }> = [
  { what: "the train purchase panel", marker: /orStep === "Hardware" && trainPurchase/ },
  { what: "the must-buy-a-train notice", marker: /orStep === "Hardware" && mustBuyTrain/ },
  /* ==================================================================
      DESIGN NOTE 890: THE DIVIDEND READOUT LEAVES THIS LIST
     ==================================================================
     THE ENTRY READ `{ what: "the dividend payout panel", marker: /orSubPhase === "Dividends" &&/ }`, and
     this table's rule is that the marked surface must have `mayActThisTurn` immediately in front of it.
     #691 PUT IT HERE AND THE REPORT WITHDREW THE REASON: "the payout table and the two market moves are the
     INPUTS to Pay and Withhold. With those buttons gone on an inactive screen, the inputs describe a choice
     the reader is not making." Asked for directly -- "non-active players can see the operating corporation's
     payout and withhold information ... without the action buttons" -- because the table also says what
     every OTHER player is about to be paid, which is a fact about their own cash stated nowhere else before
     it happens.
     THIS IS THE SAME SHAPE AS CAUSE TWO ABOVE, one surface later: a readout that was listed as an action
     because in #691's day it only ever appeared beside one. The buttons keep their gate; the numbers do not
     need it. Moved to "what an inactive player keeps", where its real rule now lives. */
];

describe("an inactive player's Operating Round bar", () => {
  it.each(ACTION_SURFACES)("gates $what on mayActThisTurn", ({ marker }) => {
    const at = CODE.search(marker);
    expect(at).toBeGreaterThan(-1);
    /* The gate leads the condition, so it is the first thing a reader meets and
       the first thing evaluated. A window rather than an exact string, because
       the conditions differ and only the gate has to be shared. */
    expect(CODE.slice(Math.max(0, at - 40), at)).toContain("mayActThisTurn");
  });

  it("gates the whole Run Routes interface through one flag", () => {
    /* Auto Route, Run Routes and `RoutePlannerPanel` all read `showRouteToggle`,
       so the gate belongs in it -- three separate conditions would be three
       chances to miss one, which is the shape of every bug this file has had. */
    expect(CODE).toMatch(
      /showRouteToggle\s*=\s*\n?\s*roundType === "OperatingRound" && orSubPhase === "Routes" && mayActThisTurn/,
    );
  });

  it("still empties the contextual buttons", () => {
    // #740's original half. Unchanged, and asserted so a refactor of the new
    // gates cannot quietly drop the old one.
    expect(CODE).toContain("if (!mayActThisTurn) contextualButtons = [];");
  });
});

describe("what an inactive player keeps", () => {
  it("sees the dividend readout, without the controls that act on it", () => {
    /* Design note #890: the half of the old ACTION_SURFACES entry that survives. The readout travels to
       every seat; Pay and Withhold do not, and #740's rule -- "eight greyed buttons on four screens describe
       somebody else's decision" -- is about exactly that pair. Asserted together so a future pass cannot
       read the ungated readout as permission to ungate the buttons. */
    expect(CODE).toContain('{orSubPhase === "Dividends" && (');
    expect(CODE).toMatch(/mayActThisTurn && orSubPhase !== "Hardware"/);
  });

  it("is told who is operating", () => {
    /* The report asks for the current player and corporation, and #740 relies on
       it too -- "the acting corporation is already named across the top of the
       bar". If that line ever goes, the hiding becomes a blank panel. */
    /* Design note #890: the guard gained a clause -- `!mayActThisTurn && orSubPhase !== "Dividends"`. In
       that step the payout readout is now in the centre column saying far more than this sentence does. The
       regex is widened rather than re-pinned, because what this test protects is that the line is TURN-GATED
       and present, not the exact set of steps it sits out. */
    expect(CODE).toMatch(/!mayActThisTurn &&/);
    expect(SOURCE).toMatch(/is operating — its president has the controls/);
  });

  it("keeps the sub-phase trail, which asks nothing about the turn", () => {
    /* Design note #672 made the trail render in both the pinned and expanded
       forms; it must not acquire a turn gate here, because "where are they in
       the turn" is precisely what a waiting player is watching. */
    const at = CODE.indexOf("styles.subPhaseTrail");
    expect(at).toBeGreaterThan(-1);
    expect(CODE.slice(Math.max(0, at - 300), at)).not.toContain("mayActThisTurn");
  });

  it("keeps the drafted-routes chips, and gates only the cursor inside them", () => {
    /* MOVED HERE BY #862 from `ACTION_SURFACES`, where it asked for the row to disappear. #815's split is the
       reason: the chips carry TWO facts and only one of them is an action.
         SHOWN TO EVERYONE  -- `isOpen`, "this chip's route is on the map", which is the whole point of the
                               readout #802 built for watchers.
         THE PRESIDENT ONLY -- `isDrafting`, "map clicks land on this train", and the dispatch behind it.
       So the gate is INSIDE the row rather than on it, and this asserts the two places it has to appear. A
       row-level gate would pass a naive version of this test while removing the readout. */
    const at = CODE.indexOf('aria-label="Drafted routes"');
    expect(at).toBeGreaterThan(-1);
    const row = CODE.slice(at, at + 1600);
    expect(row).toContain("mayActThisTurn && draft.trainIndex === activeTrainIndex");
    expect(row).toContain("if (mayActThisTurn) onSelectRouteTrain(draft.trainIndex);");
    /* AND THE ROW ITSELF IS NOT GATED. The condition that renders it asks about the sub-phase and about
       whether there is anything to show -- never about whose turn it is.
       THE FIRST DRAFT OF THIS CHECK WAS VACUOUS, and it is kept in description because it is the session's
       standing trap wearing a new hat. It read `lastIndexOf('orSubPhase === "Routes"', at)` and searched from
       there to the row -- but a gate is written BEFORE the condition it guards, so `mayActThisTurn && orSub...`
       puts the gate UPSTREAM of the anchor and the slice could never contain it. The negative control caught
       it: adding the gate left all thirteen green. AN ANCHOR HAS TO SIT OUTSIDE WHAT IT IS LOOKING FOR, so
       this takes the whole render line instead, and proves it found the right line before judging it. */
    const opens = CODE.lastIndexOf('orSubPhase === "Routes"', at);
    expect(opens).toBeGreaterThan(-1);
    const line = CODE.slice(CODE.lastIndexOf("\n", opens) + 1, CODE.indexOf("\n", opens));
    expect(line).toContain("trainDrafts.length > 0");
    expect(line).not.toContain("mayActThisTurn");
  });

  it("keeps Undo ungated by the turn", () => {
    /* #592c/#592d: Undo is an instruction about the LOG, not a move, so it
       answers to `undoBlockedReason` alone. The host uses it to take back
       somebody else's action, which is the one control that has to survive
       exactly the case this file is about. */
    const at = CODE.indexOf("undoBlockedReason");
    expect(at).toBeGreaterThan(-1);
    expect(CODE).not.toMatch(/mayActThisTurn[^\n]{0,40}undoBlockedReason/);
  });
});

describe("what an inactive player can still DO", () => {
  /* Asked directly, and worth pinning rather than answering once: "make sure the
     (inactive) seller can also respond to a buy private company offer".

     They can, and the reason is structural rather than lucky -- but it is the
     kind of structure a later "tidy the action bar" pass would undo, because
     both prompts LOOK like they belong beside the controls that create them.
     Design note #165/#166 already says why they do not: "shell level rather than
     inside the action bar because both outlive the panel that opened them; the
     prompt in particular has to survive the sub-phase advancing." A prompt moved
     into the bar would inherit #691's gate and vanish for the one person it is
     addressed to -- silently, because the offer would still be recorded and the
     seller would simply never be asked.

     THE TWO OFFERS ARE THE ONLY ACTIONS A NON-ACTING PLAYER HAS in an Operating
     Round, which is exactly why they are the ones to guard. */

  it("keeps BOTH consent prompts out of the action bar", () => {
    expect(SOURCE).not.toContain("<PrivateTradePrompt");
    expect(SOURCE).not.toContain("<TrainTradePrompt");
    expect(SHELL).toContain("<PrivateTradePrompt");
    expect(SHELL).toContain("<TrainTradePrompt");
  });

  it("gates the private prompt on OWNERSHIP, not on the turn", () => {
    /* The owner answers whether or not it is their turn -- it never is, by
       construction, since the offer comes from the corporation that IS acting. */
    expect(SHELL).toMatch(
      /viewerIsOwner=\{privateProposal\?\.ownerAddress === viewerAddress\}/,
    );
  });

  it("gates the train prompt on being the seller, not on the turn", () => {
    expect(SHELL).toMatch(/viewerIsSeller=\{/);
  });

  it("derives the private offer from GAME STATE, so it reaches every client", () => {
    /* `private_purchase_offer` is a field on `GameStateResponse`. Shell state
       would reach only the browser that composed the offer -- which is the buyer,
       i.e. precisely the wrong one. */
    expect(SHELL).toContain("gameState?.private_purchase_offer");
  });
});
