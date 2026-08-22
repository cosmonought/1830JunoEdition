// frontend/src/utils/trainOffer.test.ts
//
// ==================================================================
//  DESIGN NOTE 701 (harness): THE OTHER HALF OF #662
// ==================================================================
//
// REPORTED: "the 'Buy Trains from Other Corporations' action offer is not sending the modal notification to
// the selling player. Instead, it is showing up as a modal on the Buyer's screen and they can accept/reject it
// as they wish. I thought this bug had been fixed before?"
//
// IT HAD BEEN -- FOR PRIVATE COMPANIES. Design note #662 found exactly these two faults on the private-trade
// prompt: the proposal was React state in `App.tsx`, so it never left the buyer's machine, and the consent
// prop read `sandbox || ...`, so on the one screen that DID see it the check was forced open. It fixed both,
// wrote `privateOffer.test.ts` to hold them fixed, and left the train prompt alone -- which had the same two
// lines.
//
// SO THE INTERESTING FACT IS NOT THE BUG, IT IS THE SHAPE OF THE MISS. #662's own note opens "Trains have a
// full on-chain offer flow; privates are single-party", which is true ONLINE and was read as though it covered
// both deployments. Offline there is no chain to hold the register, so the train flow was the single-party one
// and nobody checked. This file therefore asserts the SAME properties as `privateOffer.test.ts`, deliberately
// in the same order, so the two features are visibly held to one standard rather than two.
//
// A third fault surfaced on the way and is asserted here too: the seller's ANSWER has to get past a turn gate
// that asks "is it your turn". A consent answer is owed by the player who is NOT operating, so the gate would
// refuse it -- and #662's private flow has that hole as well, reached the same way. `offTurn` is the exemption
// and both flows now pass it.

import {
  isAnswerPrivatePurchaseMsg,
  isAnswerTrainPurchaseMsg,
  isProposeTrainPurchaseMsg,
  isSandboxOnlyMsg,
  type SandboxLogMsg,
} from "./gameSetup";
import { decodeAction, type SandboxAction } from "./sandboxRoom";
import fs from "fs";
import path from "path";

/** What `subscribeSandboxLog` hands a client: the message as JSON text in a Firestore document. The shape the
 *  SELLER's client decodes, which is the shape the whole report turns on. */
function asLoggedAction(msg: SandboxLogMsg, actor: string, index: number): SandboxAction {
  return {
    index,
    id: `doc-${index}`,
    actor,
    payload: JSON.stringify(msg),
    // Design note #668: a player's offer, not the game's own bookkeeping.
    derived: false,
    at: Date.now(),
  };
}

const ALICE = "juno1alice";
const BOB = "juno1bob";

const OFFER: SandboxLogMsg = {
  ProposeTrainPurchase: {
    seller_protocol_id: 4,
    seller_ticker: "NNH",
    seller_president: BOB,
    buyer_protocol_id: 1,
    buyer_ticker: "PRR",
    model_type: "3",
    price: "220",
  },
};

const ACCEPT: SandboxLogMsg = { AnswerTrainPurchase: { seller_protocol_id: 4, accept: true } };
const DECLINE: SandboxLogMsg = { AnswerTrainPurchase: { seller_protocol_id: 4, accept: false } };

describe("the offer travels", () => {
  it("is recognised as a sandbox-only message", () => {
    /* `isSandboxOnlyMsg` is the single predicate #546 built so that adding an event cannot leave a call site
       behind. If the new pair is not in it, the offer is handed to the chain dispatch as though the contract
       knew the message -- and the contract's own train messages are `BuyTrainFromCorporation` and friends,
       none of which this is. */
    expect(isSandboxOnlyMsg(OFFER)).toBe(true);
    expect(isSandboxOnlyMsg(ACCEPT)).toBe(true);
  });

  it("is not mistaken for the contract's own train message", () => {
    /* The near neighbour, specifically. `BuyTrainFromCorporation` IS a contract message and IS what an
       accepted offer eventually dispatches -- so a predicate that swept it up would send the real purchase
       down the sandbox path and lose it. */
    expect(
      isSandboxOnlyMsg({
        BuyTrainFromCorporation: {
          game_id: 1,
          buyer_protocol_id: 1,
          seller_protocol_id: 4,
          model_type: "3",
          price: "220",
        },
      }),
    ).toBe(false);
  });

  it("survives the round trip through the action log", () => {
    /* THE PROPERTY THE REPORT TURNS ON. The seller's client learns about the offer by decoding it out of
       Firestore; if it does not survive the encode/decode it never arrives, which is exactly what "showing up
       as a modal on the Buyer's screen" looked like. */
    const decoded = decodeAction(asLoggedAction(OFFER, ALICE, 1));
    expect(decoded).not.toBeNull();
    expect(isProposeTrainPurchaseMsg(decoded)).toBe(true);
    if (!isProposeTrainPurchaseMsg(decoded)) throw new Error("unreachable");
    expect(decoded.ProposeTrainPurchase.seller_president).toBe(BOB);
    expect(decoded.ProposeTrainPurchase.price).toBe("220");
    expect(decoded.ProposeTrainPurchase.model_type).toBe("3");
  });

  it("carries the seller's WALLET, not a display label", () => {
    /* A label is one client's rendering of a wallet and two clients may resolve it differently -- a room where
       somebody has not set a name shows a truncated address. The consent check compares wallets, so the wallet
       is what has to travel; the label is added at the edge where the prompt is built. */
    expect(OFFER).toHaveProperty("ProposeTrainPurchase.seller_president", BOB);
    expect(JSON.stringify(OFFER)).not.toContain("sellerPresidentLabel");
  });

  it("keeps the price a string all the way through", () => {
    /* `price` is `Uint128` on chain and an accepted offer dispatches it straight into
       `BuyTrainFromCorporation`. A round trip through `Number` anywhere on this path would be a silent
       precision bug -- and unlike the private offer's integer price, this one has a contract to match. */
    const decoded = decodeAction(asLoggedAction(OFFER, ALICE, 1));
    if (!isProposeTrainPurchaseMsg(decoded)) throw new Error("unreachable");
    expect(typeof decoded.ProposeTrainPurchase.price).toBe("string");
  });

  it("distinguishes an acceptance from a refusal", () => {
    /* A refusal is a real event rather than the absence of one: it has to clear the prompt on BOTH screens,
       which a local dismissal could never do. */
    expect(isAnswerTrainPurchaseMsg(ACCEPT)).toBe(true);
    expect(isAnswerTrainPurchaseMsg(DECLINE)).toBe(true);
    const roundTripped = decodeAction(asLoggedAction(DECLINE, BOB, 2));
    if (!isAnswerTrainPurchaseMsg(roundTripped)) throw new Error("unreachable");
    expect(roundTripped.AnswerTrainPurchase.accept).toBe(false);
  });

  it("names the seller in the answer, so a stale answer cannot settle a new offer", () => {
    /* Two clients can answer before either sees the other, and an offer can be replaced between the two. The
       `seller_protocol_id` on the answer is what lets the drain refuse an answer that does not match the offer
       standing in shared state rather than applying it to whatever is there. */
    expect(ACCEPT).toHaveProperty("AnswerTrainPurchase.seller_protocol_id", 4);
  });

  it("does not collide with the private negotiation", () => {
    // Two prompts, two registers, one shell. A predicate that answered both would let one answer clear the
    // other's offer.
    expect(isAnswerPrivatePurchaseMsg(ACCEPT)).toBe(false);
    expect(isAnswerTrainPurchaseMsg({ AnswerPrivatePurchase: { private_id: 3, accept: true } })).toBe(
      false,
    );
  });
});

/* ==================================================================
 *  DESIGN NOTE 701 (harness): READING THE SOURCE, AND WHY
 * ==================================================================
 *
 * `viewerIsSeller` is a JSX prop inside a 10,000-line component, so there is nothing to import. Reading the
 * source is the pattern this codebase already uses for exactly that situation (`ownershipColumnFit.test.ts`,
 * and `privateOffer.test.ts` for the sibling prop), and the property is narrow enough to state in one regex:
 * the consent check must not consult the MODE.
 *
 * A source-text test is a weak instrument and is used here because the alternative is a test that cannot fail
 * -- a locally declared copy of the rule passes whatever the real one does. It is scoped to one prop on one
 * line rather than to formatting in general, so a reformat does not break it and a reintroduced `sandbox ||`
 * does. */
describe("who may answer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");

  it("compares the viewer's wallet to the seller president's", () => {
    expect(source).toContain(
      "liveTrainOffer !== null || sandboxTrainProposal?.sellerPresident === viewerAddress",
    );
  });

  it("does not let the mode stand in for consent", () => {
    /* THE EXPIRED PREMISE, as an assertion. The old expression carried `sandbox ||` in the middle, which made
       the buyer the seller whenever the room was a sandbox -- and since #578 removed solo mode, every room is
       one. #536's note justified it as "Sandbox names the seller so the clicker knows whose decision they
       stand in for", which was true of a hotseat and stopped being true at #536's own "a room is not a
       hotseat". #662 struck the identical clause out of `viewerIsOwner`; this holds the other one out. */
    expect(source).not.toMatch(/viewerIsSeller=\{[^}]*\bsandbox\s*\|\|/);
  });

  it("no longer keeps the proposal in React state", () => {
    /* The first fault, and the one the report describes. A `useState` here is a register of one -- the buyer's
       browser -- which is why the modal appeared there and only there. */
    /* Matched as a CALL, not as a word. Both design notes on this change name the old setter in prose -- the
       drain's and the proposal handler's -- and a test that forbade the name would forbid explaining what was
       fixed, which is the opposite of what this codebase's notes are for. */
    expect(source).not.toMatch(/setSandboxTrainProposal\(/);
    expect(source).toContain("gameState?.train_purchase_offer");
  });
});

describe("the answer is owed by a player who is not on turn", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");

  it("exempts consent answers from the turn gate", () => {
    /* THE THIRD FAULT. The gate asks "is it your turn", which is right for a move and wrong for an answer:
       the counterparty to a trade is by definition not the one operating, so Accept would have returned "It
       is not your turn". */
    expect(source).toMatch(/options\?\.offTurn !== true/);
  });

  it("marks both negotiations, not just the train", () => {
    /* #662's private flow has the same hole, reached the same way -- which is the whole lesson of this note.
       Four call sites: accept and decline, trains and privates. */
    const marked = source.match(/\{ offTurn: true \}/g) ?? [];
    expect(marked).toHaveLength(4);
  });

  it("does not reach for `automatic` instead", () => {
    /* `automatic` also re-attributes the log entry to the ACTING seat, so a consent answer sent that way would
       be recorded as the buyer's. The log is the only place the table can see who agreed to what. */
    expect(source).not.toMatch(/AnswerTrainPurchase[\s\S]{0,220}automatic: true/);
    expect(source).not.toMatch(/AnswerPrivatePurchase[\s\S]{0,220}automatic: true/);
  });
});
