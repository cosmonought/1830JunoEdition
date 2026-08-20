// frontend/src/utils/privateOffer.test.ts
//
// ==================================================================
//  DESIGN NOTE 662 (harness): AN OFFER THE OWNER CAN SEE
// ==================================================================
//
// REPORTED: "P1 sent an offer to buy P2's Private Company, but the decision
// modal appeared on P1's screen and allowed them to accept it."
//
// Two symptoms, one cause. The proposal was `privateProposal`, React state in
// `App.tsx`, so it never left the buyer's machine -- and `viewerIsOwner` read
// `sandbox || ownerAddress === viewerAddress`, so on the one screen that DID
// see it the consent check was forced open.
//
// Design note #205 explains both, and its reasoning was right when written:
// the local stand-in existed "for exactly ONE deployment: the offline
// sandbox, which has no chain to record an offer in and no second client to
// show it to." Design note #578 removed solo mode and that premise expired
// without either line being revisited. This is the third time in this
// codebase a rule has outlived the condition that justified it -- the others
// being the $350 trigger (#652) and the sandbox's opening-step shortcut
// (#656a) -- so what is asserted here is the CONDITION, not just the fix.
//
// What is testable without a renderer is the message plumbing: that the
// offer is a log entry both clients replay, and that the consent rule is a
// function of the wallet rather than of the mode.

import {
  isAnswerPrivatePurchaseMsg,
  isProposePrivatePurchaseMsg,
  isSandboxOnlyMsg,
  type SandboxLogMsg,
} from "./gameSetup";
import { decodeAction, type SandboxAction } from "./sandboxRoom";
import fs from "fs";
import path from "path";

/** What `subscribeSandboxLog` hands a client: the message as JSON text in a
 *  Firestore document. Built here rather than imported because the write
 *  side lives inside a Firestore call -- what this file needs is the SHAPE
 *  the seller's client decodes, and that shape is `payload`. */
function asLoggedAction(msg: SandboxLogMsg, actor: string, index: number): SandboxAction {
  return { index, id: `doc-${index}`, actor, payload: JSON.stringify(msg), at: Date.now() };
}

const ALICE = "juno1alice";
const BOB = "juno1bob";

const OFFER: SandboxLogMsg = {
  ProposePrivatePurchase: {
    private_id: 3,
    private_name: "Delaware & Hudson",
    owner: BOB,
    buyer_protocol_id: 1,
    buyer_ticker: "PRR",
    price: 90,
  },
};

const ACCEPT: SandboxLogMsg = { AnswerPrivatePurchase: { private_id: 3, accept: true } };
const DECLINE: SandboxLogMsg = { AnswerPrivatePurchase: { private_id: 3, accept: false } };

describe("the offer travels", () => {
  it("is recognised as a sandbox-only message", () => {
    /* `isSandboxOnlyMsg` is the single predicate design note #546 built so
       that adding an event cannot leave a call site behind. If the new pair
       is not in it, the offer is handed to the chain dispatch as though the
       contract knew the message -- which is the failure #539 records. */
    expect(isSandboxOnlyMsg(OFFER)).toBe(true);
    expect(isSandboxOnlyMsg(ACCEPT)).toBe(true);
  });

  it("is not mistaken for a contract message", () => {
    expect(isSandboxOnlyMsg({ PassTurn: { game_id: 1 } })).toBe(false);
  });

  it("survives the round trip through the action log", () => {
    /* THE PROPERTY THE REPORT TURNS ON. The seller's client learns about the
       offer by decoding it out of Firestore; if it does not survive the
       encode/decode it never arrives, which is exactly what "the modal
       appeared on P1's screen" looked like. */
    const decoded = decodeAction(asLoggedAction(OFFER, ALICE, 1));
    expect(decoded).not.toBeNull();
    expect(isProposePrivatePurchaseMsg(decoded)).toBe(true);
    if (!isProposePrivatePurchaseMsg(decoded)) throw new Error("unreachable");
    expect(decoded.ProposePrivatePurchase.owner).toBe(BOB);
    expect(decoded.ProposePrivatePurchase.price).toBe(90);
    expect(decoded.ProposePrivatePurchase.private_name).toBe("Delaware & Hudson");
  });

  it("carries the owner's WALLET, not a display label", () => {
    /* A label is one client's rendering of a wallet and two clients may
       resolve it differently -- a room where somebody has not set a name
       shows a truncated address. The consent check compares wallets, so the
       wallet is what has to travel; the label is added at the edge where the
       prompt is built. */
    expect(OFFER).toHaveProperty("ProposePrivatePurchase.owner", BOB);
    expect(JSON.stringify(OFFER)).not.toContain("ownerLabel");
  });

  it("distinguishes an acceptance from a refusal", () => {
    /* A refusal is a real event rather than the absence of one: it has to
       clear the prompt on BOTH screens, which a local dismissal could never
       do -- the defect design note #565 fixed for the B&O par prompt, which
       was this same bug on a different modal. */
    expect(isAnswerPrivatePurchaseMsg(ACCEPT)).toBe(true);
    expect(isAnswerPrivatePurchaseMsg(DECLINE)).toBe(true);
    const roundTripped = decodeAction(asLoggedAction(DECLINE, BOB, 2));
    if (!isAnswerPrivatePurchaseMsg(roundTripped)) throw new Error("unreachable");
    expect(roundTripped.AnswerPrivatePurchase.accept).toBe(false);
  });

  it("names the private in the answer, so a stale answer cannot settle a new offer", () => {
    /* Two clients can answer before either sees the other, and an offer can
       be replaced between the two. The `private_id` on the answer is what
       lets the drain refuse an answer that does not match the offer on the
       board rather than applying it to whatever is standing. */
    expect(ACCEPT).toHaveProperty("AnswerPrivatePurchase.private_id", 3);
  });
});

/* ==================================================================
 *  DESIGN NOTE 662 (harness): READING THE SOURCE, AND WHY
 * ==================================================================
 *
 * The first draft of this block declared its own `viewerIsOwner` and tested
 * that -- which asserts nothing about the app. A local copy of a rule passes
 * whatever the real one does, and would have gone on passing through the
 * exact regression it was written to catch. It read like coverage and was
 * decoration, which is the same species as the dead
 * `eligiblePrivatesForPurchase` this chunk deleted an hour ago.
 *
 * `viewerIsOwner` is a JSX prop inside a 10,000-line component, so there is
 * nothing to import. Reading the source is the pattern this codebase already
 * uses for exactly that situation (`ownershipColumnFit.test.ts`), and the
 * property is narrow enough to state in one regex: the consent check must
 * not consult the MODE.
 *
 * A source-text test is a weak instrument and is used here because the
 * alternative is a test that cannot fail. It is scoped to one prop on one
 * line rather than to formatting in general, so a reformat does not break it
 * and a reintroduced `sandbox ||` does. */
describe("who may answer", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "App.tsx"),
    "utf8",
  );

  it("compares the viewer's wallet to the owner's", () => {
    expect(source).toContain("viewerIsOwner={privateProposal?.ownerAddress === viewerAddress}");
  });

  it("does not let the mode stand in for consent", () => {
    /* THE EXPIRED PREMISE, as an assertion. The old expression was
       `viewerIsOwner={sandbox || privateProposal?.ownerAddress === viewerAddress}`,
       which made the buyer the owner whenever the room was a sandbox -- and
       since design note #578 removed solo mode, every room is one.

       Design note #2 in `PrivateTradePanel.tsx` justified the bypass on the
       grounds that the sandbox was "one human at one wallet" and that
       otherwise "the only place this flow can run end to end is the one
       place it cannot be tested". Both clauses were true and both stopped
       being true. Stated here so a future pass reaching for a mode flag in a
       consent check has something to fail against. */
    expect(source).not.toMatch(/viewerIsOwner=\{\s*sandbox\s*\|\|/);
  });
});
