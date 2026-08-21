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
const ACTION_SURFACES: ReadonlyArray<{ what: string; marker: RegExp }> = [
  { what: "the train purchase panel", marker: /orSubPhase === "Hardware" && trainPurchase/ },
  { what: "the must-buy-a-train notice", marker: /orSubPhase === "Hardware" && mustBuyTrain/ },
  { what: "the dividend payout panel", marker: /orSubPhase === "Dividends" &&/ },
  { what: "the condensed drafted-routes row", marker: /orSubPhase === "Routes" && condensed/ },
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
  it("is told who is operating", () => {
    /* The report asks for the current player and corporation, and #740 relies on
       it too -- "the acting corporation is already named across the top of the
       bar". If that line ever goes, the hiding becomes a blank panel. */
    expect(CODE).toMatch(/!mayActThisTurn && \(/);
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
