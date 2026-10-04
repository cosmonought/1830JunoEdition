/** @jest-environment jsdom */
//
// ==================================================================
//  6.5-B HARNESS: THE CONSENT SLOT -- K-10 (ONE FUNDING PROMPT) AND K-09 (REJECT FOR THE ANSWERING SEAT ONLY)
// ==================================================================
//
// Every offer here is made through a real room (ingress + reducer), and every prompt is rendered from that room's
// board with the shell's own derivations and the shell's own prop expressions (`App.tsx`):
//   PrivateTradePrompt        proposal = ordinaryPrivateProposalView(...), viewerIsOwner = proposal?.ownerAddress === viewer
//   TrainTradePrompt          viewerIsSeller = proposal?.sellerPresident === viewer
//   FundingPrivateOfferPrompt viewerIsBuyerPresident = offer.buyerPresident === viewer
// The assertions are on the rendered buttons: which seat has a LIVE answer control, and what the room says to it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PrivateTradePrompt } from "./PrivateTradePanel";
import { FundingPrivateOfferPrompt, TrainTradePrompt } from "./TrainPurchasePanel";
import type { GameStateResponse } from "../gameEngine/gameState";
import { ordinaryPrivateProposalView } from "../utils/privateProposalView";
import * as F from "../utils/offerFixtures74";
import * as S from "../utils/offerMatrix74Support";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { P1, P2, P3, PRR, NYC, CO, DH, CA } = F;
const { M } = S;
const LABELS: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [P3]: "Carol" };
const label = (address: string) => LABELS[address] ?? address;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (node: React.ReactElement) => act(() => root.render(node));
const click = (node: Element | null | undefined) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
const button = (text: string) => buttons().find((entry) => entry.textContent === text);
const live = () => buttons().filter((entry) => !entry.disabled);

/* ================================================================== */
/* K-10                                                                 */
/* ================================================================== */

/** The shell's slot, reduced to the two prompts a private offer can raise, with App's own derivations. */
function PrivateOfferSlot({
  state,
  viewer,
  onFundingAnswer,
  onOrdinaryAnswer,
}: {
  state: GameStateResponse;
  viewer: string | null;
  onFundingAnswer: (privateId: number, accept: boolean) => void;
  onOrdinaryAnswer: (accept: boolean) => void;
}) {
  const offer = state.private_purchase_offer ?? null;
  // App.tsx `fundingPrivateOffer`: the funding offer as the BUYING president sees it.
  const buyer = offer?.funding ? state.public_companies.find((entry) => entry.company_id === offer.buyer_protocol_id) : undefined;
  const funding =
    offer && offer.funding
      ? {
          privateId: offer.private_id,
          privateName: offer.private_name,
          sellerLabel: label(offer.owner),
          buyerTicker: offer.buyer_ticker,
          buyerPresident: buyer?.president ?? null,
          buyerPresidentLabel: label(buyer?.president ?? ""),
          price: Number(offer.price),
        }
      : null;
  // App.tsx `privateProposal`.
  const proposal = ordinaryPrivateProposalView(offer, label);
  return (
    <>
      <FundingPrivateOfferPrompt
        offer={funding}
        viewerIsBuyerPresident={funding !== null && funding.buyerPresident === viewer}
        onAnswer={onFundingAnswer}
      />
      <PrivateTradePrompt
        proposal={proposal}
        viewerIsOwner={proposal?.ownerAddress === viewer}
        consentIsBinding
        onAccept={() => onOrdinaryAnswer(true)}
        onReject={() => onOrdinaryAnswer(false)}
      />
    </>
  );
}

describe("K-10: an emergency funding offer raises exactly one prompt, answered with the funding message", () => {
  const funded = () => {
    // `emergencyFunding.test.ts`'s board: C&O (Alice) owes a train it cannot fund; Alice owns the D&H and offers it to
    // NYC, whose president is Bob.
    const t = S.roomFor(S.fundingBoard(100, { privates: [{ id: DH, owner: P1, cost: "70" }] }), S.corridor());
    expect(t.submit(P1, M.fundingOffer(DH, NYC, 70)).kind).toBe("applied");
    expect(t.room.state.private_purchase_offer).toMatchObject({ funding: true, private_id: DH, owner: P1 });
    return t;
  };

  it("the ordinary prompt's view is null for a funding offer (and still present for an ordinary one)", () => {
    const t = funded();
    expect(ordinaryPrivateProposalView(t.room.state.private_purchase_offer, label)).toBeNull();
    const ordinary = S.roomFor(F.operatingBoard());
    expect(ordinary.submit(P1, M.proposePrivate(CA, PRR, 160)).kind).toBe("applied");
    expect(ordinaryPrivateProposalView(ordinary.room.state.private_purchase_offer, label)).toMatchObject({
      privateId: CA,
      ownerAddress: P3,
      ownerLabel: "Carol",
      buyerTicker: "PRR",
      price: 160,
    });
  });

  it("every seat sees ONE prompt; only the buying president has live controls; its Accept sends the funding answer, which settles", () => {
    const t = funded();
    const fundingAnswers: Array<[number, boolean]> = [];
    const ordinaryAnswers: boolean[] = [];
    for (const viewer of [P1, P2, P3, null]) {
      render(
        <PrivateOfferSlot
          state={t.room.state}
          viewer={viewer}
          onFundingAnswer={(id, accept) => fundingAnswers.push([id, accept])}
          onOrdinaryAnswer={(accept) => ordinaryAnswers.push(accept)}
        />,
      );
      expect(host.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
      expect(host.querySelector('[aria-label="Private company offered"]')).not.toBeNull();
      expect(live()).toHaveLength(viewer === P2 ? 2 : 0);
    }
    render(<PrivateOfferSlot state={t.room.state} viewer={P2} onFundingAnswer={(id, accept) => fundingAnswers.push([id, accept])} onOrdinaryAnswer={(accept) => ordinaryAnswers.push(accept)} />);
    click(button("Accept"));
    expect(fundingAnswers).toEqual([[DH, true]]);
    expect(ordinaryAnswers).toEqual([]);
    // App's `handleAnswerFundingPrivateOffer` message, from the buying president: applied, and the sale settles.
    expect(t.submit(P2, { AnswerFundingPrivateOffer: { game_id: 0, private_id: DH, accept: true } }).kind).toBe("applied");
    expect(t.room.state.private_purchase_offer ?? null).toBeNull();
    expect(S.priv(t.room.state, DH)).toMatchObject({ owner_protocol_id: NYC });
  });

  it("what the duplicate prompt's Accept and Reject would have sent is refused by the funding hold", () => {
    const t = funded();
    const handed = t.room.entries.length;
    for (const accept of [true, false]) {
      const answer = t.submit(P1, M.answerPrivate(DH, accept)) as { kind: string; reason?: string };
      expect(answer.kind).toBe("refused");
      expect(answer.reason).toBe("Private 3 is on offer to NYC; nothing else can happen until its president answers or the seller withdraws.");
    }
    expect(t.room.entries).toHaveLength(handed);
    expect(t.room.state.private_purchase_offer).toMatchObject({ funding: true });
  });
});

/* ================================================================== */
/* K-09                                                                 */
/* ================================================================== */

describe("K-09: Reject is live only for the seat the authority lets answer", () => {
  it("the ordinary private offer: the owner's Reject is live and applied; the proposer's, a third seat's and a watcher's are disabled -- and refused", () => {
    // PRR (Alice) offers $160 for Carol's C&A.
    const t = S.roomFor(F.operatingBoard());
    expect(t.submit(P1, M.proposePrivate(CA, PRR, 160)).kind).toBe("applied");
    const proposal = ordinaryPrivateProposalView(t.room.state.private_purchase_offer, label)!;
    const rejects: string[] = [];
    for (const viewer of [P1, P2, P3, null]) {
      render(
        <PrivateTradePrompt
          proposal={proposal}
          viewerIsOwner={proposal.ownerAddress === viewer}
          consentIsBinding
          onAccept={() => undefined}
          onReject={() => rejects.push(String(viewer))}
        />,
      );
      const reject = button("Reject")!;
      const accept = button("Accept")!;
      expect(reject.disabled).toBe(viewer !== P3);
      expect(accept.disabled).toBe(viewer !== P3);
      if (viewer !== P3) expect(reject.title).toBe("Only Carol can answer this offer.");
      click(reject);
    }
    // A disabled button does not fire: only the owner's Reject reached the handler.
    expect(rejects).toEqual([P3]);
    // And what each seat's Reject would have sent, the authority answers the same way.
    expect(t.submit(P1, M.answerPrivate(CA, false))).toMatchObject({ kind: "refused", reason: "Only the private company's owner can answer that offer." });
    expect(t.submit(P2, M.answerPrivate(CA, false))).toMatchObject({ kind: "refused", reason: "Only the private company's owner can answer that offer." });
    expect(t.submit(P3, M.answerPrivate(CA, false)).kind).toBe("applied");
    expect(t.room.state.private_purchase_offer ?? null).toBeNull();
  });

  it("the train offer: the selling president's Reject is live and applied; the buyer's president's, a third seat's and a watcher's are disabled -- and refused", () => {
    // PRR (Alice) offers $150 for one of NYC's (Bob's) 3-trains.
    const t = S.roomFor(S.withCorp(F.operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] }));
    expect(t.submit(P1, M.proposeTrain(NYC, PRR, "3", "150")).kind).toBe("applied");
    const offer = t.room.state.train_purchase_offer!;
    const proposal = {
      sellerProtocolId: offer.seller_protocol_id,
      sellerTicker: offer.seller_ticker,
      sellerPresident: offer.seller_president,
      sellerPresidentLabel: label(offer.seller_president ?? ""),
      buyerProtocolId: offer.buyer_protocol_id,
      buyerTicker: offer.buyer_ticker,
      modelType: offer.model_type,
      price: offer.price,
    };
    const rejects: string[] = [];
    for (const viewer of [P1, P2, P3, null]) {
      render(
        <TrainTradePrompt
          proposal={proposal}
          viewerIsSeller={proposal.sellerPresident === viewer}
          onAccept={() => undefined}
          onReject={() => rejects.push(String(viewer))}
        />,
      );
      const reject = button("Reject")!;
      expect(reject.disabled).toBe(viewer !== P2);
      expect(button("Accept")!.disabled).toBe(viewer !== P2);
      if (viewer !== P2) expect(reject.title).toBe("Only Bob can answer this offer.");
      click(reject);
    }
    expect(rejects).toEqual([P2]);
    expect(t.submit(P1, M.answerTrain(NYC, false))).toMatchObject({ kind: "refused", reason: "Only the selling corporation's president can answer that offer." });
    expect(t.submit(P3, M.answerTrain(NYC, false))).toMatchObject({ kind: "refused", reason: "Only the selling corporation's president can answer that offer." });
    expect(t.submit(P2, M.answerTrain(NYC, false)).kind).toBe("applied");
    expect(t.room.state.train_purchase_offer ?? null).toBeNull();
  });

  it("a seat that is not the proposer is never offered a Rescind (K-05 landed in Phase 3 W1-D: `phase3W1dOfferRescind`)", () => {
    const t = S.roomFor(F.operatingBoard());
    t.submit(P1, M.proposePrivate(CA, PRR, 160));
    const proposal = ordinaryPrivateProposalView(t.room.state.private_purchase_offer, label)!;
    render(
      <PrivateTradePrompt
        proposal={proposal}
        viewerIsOwner={false}
        viewerIsProposer={false}
        consentIsBinding
        onAccept={() => undefined}
        onReject={() => undefined}
        onRescind={() => undefined}
      />,
    );
    expect(buttons().map((entry) => entry.textContent)).toEqual(["Reject", "Accept"]);
    void CO;
  });
});
