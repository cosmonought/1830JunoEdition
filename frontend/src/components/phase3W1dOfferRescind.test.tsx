/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-D HARNESS: PROPOSER RESCIND, AUTHORITY-DERIVED ANSWERER, NO CHAIN-ERA CONTROLS, THE LATCH
// ==================================================================
//
// Every offer here is made through a real room (`RoomSession`: ingress + reducer), and every prompt is rendered
// from that room's board with the shell's own derivations (`ordinaryPrivateProposalView`,
// `privateOfferConsentRoles`, `trainOfferConsentRoles`) and the shell's own prop expressions:
//   PrivateTradePrompt  viewerIsOwner = privateOfferRoles.viewerIsAnswerer, viewerIsProposer = ....viewerIsProposer
//   TrainTradePrompt    viewerIsSeller = trainOfferRoles.viewerIsAnswerer,  viewerIsProposer = ....viewerIsProposer
// Each seat's live control is then sent to the room exactly as `App.tsx` builds it, and the room's verdict is the
// assertion: what the prompt offers a seat is what the authority lets that seat do.
// What only the shell's source can show (the handlers, the slot's wiring, the retired mount) is scanned at the end.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PrivateTradePrompt } from "./PrivateTradePanel";
import { FundingPrivateOfferPrompt, TrainDiscardPrompt, TrainTradePrompt, type TrainTradeProposal } from "./TrainPurchasePanel";
import type { GameStateResponse } from "../gameEngine/gameState";
import { SANDBOX_GAME_ID } from "../utils/activeGame";
import { answerPrivatePurchaseRefusal } from "../gameEngine/privatePurchaseAuthority";
import { answerTrainPurchaseRefusal } from "../gameEngine/trainSaleAuthority";
import { ordinaryPrivateProposalView } from "../utils/privateProposalView";
import {
  CONSENT_IN_FLIGHT_TITLE,
  privateOfferConsentRoles,
  trainOfferConsentRoles,
} from "../utils/offerConsentView";
import { readShell, sliceBetween } from "../utils/sourceScan";
import * as F from "../utils/offerFixtures74";
import * as S from "../utils/offerMatrix74Support";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const { P1, P2, P3, PRR, NYC, CA } = F;
const { M } = S;
const LABELS: Record<string, string> = { [P1]: "Alice", [P2]: "Bob", [P3]: "Carol" };
const label = (address: string) => LABELS[address] ?? address;
/** The four seats every scenario is rendered for: proposer, the other player, answerer, and a watcher. */
const SEATS = [P1, P2, P3, null] as const;

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
const live = () => buttons().filter((entry) => !entry.disabled).map((entry) => entry.textContent);

/* The shell's messages, built exactly as `handleRescindPrivateOffer` / `handleRescindSandboxTrainOffer` build them. */
const RESCIND_PRIVATE = (privateId: number) => ({ RescindPrivatePurchase: { game_id: SANDBOX_GAME_ID, private_id: privateId } });
const RESCIND_TRAIN = (seller: number) => ({ RescindTrainPurchase: { game_id: SANDBOX_GAME_ID, seller_protocol_id: seller } });

/** App.tsx `sandboxTrainProposal`, reduced to the fields the prompt reads, with its W1-D answerer. */
function trainProposalFrom(state: GameStateResponse): TrainTradeProposal {
  const offer = state.train_purchase_offer!;
  const answerer = trainOfferConsentRoles(state, null).answerer;
  return {
    sellerProtocolId: offer.seller_protocol_id,
    sellerTicker: offer.seller_ticker,
    sellerPresident: answerer,
    sellerPresidentLabel: label(answerer ?? offer.seller_president ?? ""),
    buyerProtocolId: offer.buyer_protocol_id,
    buyerTicker: offer.buyer_ticker,
    modelType: offer.model_type,
    price: offer.price,
  };
}

/* ================================================================== */
/* The private offer                                                    */
/* ================================================================== */

describe("W1-D: the ordinary private offer -- the proposer may rescind, only the owner may answer", () => {
  // PRR (Alice) offers $160 for Carol's C&A. Bob is the third seat.
  const offered = () => {
    const t = S.roomFor(F.operatingBoard());
    expect(t.submit(P1, M.proposePrivate(CA, PRR, 160)).kind).toBe("applied");
    return t;
  };

  const renderFor = (state: GameStateResponse, viewer: string | null, sink: string[]) => {
    const proposal = ordinaryPrivateProposalView(state.private_purchase_offer, label)!;
    const roles = privateOfferConsentRoles(state, viewer);
    render(
      <PrivateTradePrompt
        proposal={proposal}
        viewerIsOwner={roles.viewerIsAnswerer}
        viewerIsProposer={roles.viewerIsProposer}
        consentIsBinding
        onAccept={() => sink.push(`accept:${viewer}`)}
        onReject={() => sink.push(`reject:${viewer}`)}
        onRescind={() => sink.push(`rescind:${viewer}`)}
        actionInFlight={false}
      />,
    );
  };

  it("proposer: Rescind is live and Accept/Reject are not; answerer: Accept/Reject and no Rescind; third seat and watcher: nothing live", () => {
    const t = offered();
    const sink: string[] = [];
    const seen: Record<string, (string | null)[]> = {};
    for (const viewer of SEATS) {
      renderFor(t.room.state, viewer, sink);
      seen[String(viewer)] = live();
      // Rescind exists on the proposer's screen only -- never rendered disabled for anybody else.
      expect(button("Rescind") !== undefined).toBe(viewer === P1);
      for (const text of ["Rescind", "Reject", "Accept"]) {
        const target = button(text);
        if (target) click(target);
      }
    }
    expect(seen).toEqual({
      [P1]: ["Rescind"],
      [P2]: [],
      [P3]: ["Reject", "Accept"],
      null: [],
    });
    // Only live buttons fire.
    expect(sink).toEqual([`rescind:${P1}`, `reject:${P3}`, `accept:${P3}`]);
  });

  it("the proposer's Rescind, sent as the shell sends it, is applied on turn; nobody else's is", () => {
    const t = offered();
    for (const other of [P2, P3]) {
      expect(t.submit(other, RESCIND_PRIVATE(CA))).toMatchObject({ kind: "refused" });
    }
    expect(t.room.state.private_purchase_offer).toMatchObject({ private_id: CA });
    const response = t.submit(P1, RESCIND_PRIVATE(CA));
    expect(response.kind).toBe("applied");
    expect(t.kinds(response)).toEqual(["RescindPrivatePurchase"]);
    expect(t.room.state.private_purchase_offer ?? null).toBeNull();
    // Withdrawn means gone from every seat's slot: the view the prompt renders from is null.
    expect(ordinaryPrivateProposalView(t.room.state.private_purchase_offer, label)).toBeNull();
    expect(privateOfferConsentRoles(t.room.state, P1)).toMatchObject({ viewerIsProposer: false, viewerIsAnswerer: false });
  });

  it("the answerer's live answer is applied; the proposer's and the third seat's would be refused", () => {
    const t = offered();
    expect(t.submit(P1, M.answerPrivate(CA, false))).toMatchObject({ kind: "refused", reason: "Only the private company's owner can answer that offer." });
    expect(t.submit(P2, M.answerPrivate(CA, false))).toMatchObject({ kind: "refused", reason: "Only the private company's owner can answer that offer." });
    expect(t.submit(P3, M.answerPrivate(CA, false)).kind).toBe("applied");
    expect(t.room.state.private_purchase_offer ?? null).toBeNull();
  });

  it("the answerer is the private's CURRENT owner, not the offer's recorded `owner` (P3-N006)", () => {
    const t = offered();
    // Narration that disagrees with the board: the offer says Bob owns the C&A; the board says Carol does.
    const stale: GameStateResponse = {
      ...t.room.state,
      private_purchase_offer: { ...t.room.state.private_purchase_offer!, owner: P2 },
    };
    expect(privateOfferConsentRoles(stale, P3)).toMatchObject({ answerer: P3, viewerIsAnswerer: true });
    expect(privateOfferConsentRoles(stale, P2)).toMatchObject({ viewerIsAnswerer: false });
    // ... which is the seat the authority lets answer.
    expect(answerPrivatePurchaseRefusal(stale, { private_id: CA, accept: false }, P3)).toBeNull();
    expect(answerPrivatePurchaseRefusal(stale, { private_id: CA, accept: false }, P2)).not.toBeNull();
    const sink: string[] = [];
    renderFor(stale, P2, sink);
    expect(live()).toEqual([]);
    renderFor(stale, P3, sink);
    expect(live()).toEqual(["Reject", "Accept"]);
  });
});

/* ================================================================== */
/* The train offer                                                      */
/* ================================================================== */

describe("W1-D: the train offer -- the buying president may rescind, only the selling president may answer", () => {
  // PRR (Alice) offers $150 for one of NYC's (Bob's) 3-trains. Carol is the third seat.
  const offered = () => {
    const t = S.roomFor(S.withCorp(F.operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] }));
    expect(t.submit(P1, M.proposeTrain(NYC, PRR, "3", "150")).kind).toBe("applied");
    return t;
  };

  const renderFor = (state: GameStateResponse, viewer: string | null, sink: string[]) => {
    const roles = trainOfferConsentRoles(state, viewer);
    render(
      <TrainTradePrompt
        proposal={trainProposalFrom(state)}
        viewerIsSeller={roles.viewerIsAnswerer}
        viewerIsProposer={roles.viewerIsProposer}
        onAccept={() => sink.push(`accept:${viewer}`)}
        onReject={() => sink.push(`reject:${viewer}`)}
        onRescind={() => sink.push(`rescind:${viewer}`)}
        actionInFlight={false}
      />,
    );
  };

  it("proposer: Rescind only; seller's president: Accept/Reject only; third seat and watcher: nothing live", () => {
    const t = offered();
    const sink: string[] = [];
    const seen: Record<string, (string | null)[]> = {};
    for (const viewer of SEATS) {
      renderFor(t.room.state, viewer, sink);
      seen[String(viewer)] = live();
      expect(button("Rescind") !== undefined).toBe(viewer === P1);
      for (const text of ["Rescind", "Reject", "Accept"]) {
        const target = button(text);
        if (target) click(target);
      }
    }
    expect(seen).toEqual({
      [P1]: ["Rescind"],
      [P2]: ["Reject", "Accept"],
      [P3]: [],
      null: [],
    });
    expect(sink).toEqual([`rescind:${P1}`, `reject:${P2}`, `accept:${P2}`]);
  });

  it("the proposer's Rescind, sent as the shell sends it, is applied on turn; nobody else's is", () => {
    const t = offered();
    for (const other of [P2, P3]) {
      expect(t.submit(other, RESCIND_TRAIN(NYC))).toMatchObject({ kind: "refused" });
    }
    expect(t.room.state.train_purchase_offer).toMatchObject({ seller_protocol_id: NYC });
    const response = t.submit(P1, RESCIND_TRAIN(NYC));
    expect(response.kind).toBe("applied");
    expect(t.kinds(response)).toEqual(["RescindTrainPurchase"]);
    expect(t.room.state.train_purchase_offer ?? null).toBeNull();
    // The seller keeps both 3-trains: a withdrawal moves nothing.
    expect(t.room.state.public_companies.find((entry) => entry.company_id === NYC)?.owned_trains).toEqual(["3", "3", "2"]);
  });

  it("the chain-era withdrawal the retired ledger sent is refused on this board", () => {
    const t = offered();
    expect(t.submit(P1, { RescindTrainOffer: { game_id: SANDBOX_GAME_ID, offer_id: 0 } })).toMatchObject({ kind: "refused" });
    expect(t.room.state.train_purchase_offer).toMatchObject({ seller_protocol_id: NYC });
  });

  it("the answerer is the seller's CURRENT president, not the offer's recorded `seller_president` (P3-N006)", () => {
    const t = offered();
    const stale: GameStateResponse = {
      ...t.room.state,
      train_purchase_offer: { ...t.room.state.train_purchase_offer!, seller_president: P3 },
    };
    expect(trainOfferConsentRoles(stale, P2)).toMatchObject({ answerer: P2, viewerIsAnswerer: true });
    expect(trainOfferConsentRoles(stale, P3)).toMatchObject({ viewerIsAnswerer: false });
    expect(answerTrainPurchaseRefusal(stale, { seller_protocol_id: NYC, accept: false }, P2, undefined)).toBeNull();
    expect(answerTrainPurchaseRefusal(stale, { seller_protocol_id: NYC, accept: false }, P3, undefined)).not.toBeNull();
    const sink: string[] = [];
    renderFor(stale, P3, sink);
    expect(live()).toEqual([]);
    // The prompt names the president who actually answers.
    expect(host.textContent).toContain("Waiting on Bob");
    renderFor(stale, P2, sink);
    expect(live()).toEqual(["Reject", "Accept"]);
  });
});

/* ================================================================== */
/* The latch                                                            */
/* ================================================================== */

describe("W1-D: all four consent prompts are latched while the viewer's last action is in flight", () => {
  it("a second press on the private prompt sends nothing (answerer and proposer)", () => {
    const t = S.roomFor(F.operatingBoard());
    t.submit(P1, M.proposePrivate(CA, PRR, 160));
    const proposal = ordinaryPrivateProposalView(t.room.state.private_purchase_offer, label)!;
    const sent: string[] = [];
    for (const viewer of [P3, P1]) {
      const roles = privateOfferConsentRoles(t.room.state, viewer);
      const at = (inFlight: boolean) =>
        render(
          <PrivateTradePrompt
            proposal={proposal}
            viewerIsOwner={roles.viewerIsAnswerer}
            viewerIsProposer={roles.viewerIsProposer}
            consentIsBinding
            onAccept={() => sent.push(`accept:${viewer}`)}
            onReject={() => sent.push(`reject:${viewer}`)}
            onRescind={() => sent.push(`rescind:${viewer}`)}
            actionInFlight={inFlight}
          />,
        );
      const control = viewer === P3 ? "Accept" : "Rescind";
      at(false);
      click(button(control));
      // The shell arms `actionInFlight` on the press (#1173); the prompt re-renders latched.
      at(true);
      expect(live()).toEqual([]);
      expect(button(control)!.title).toBe(CONSENT_IN_FLIGHT_TITLE);
      click(button(control));
      click(button(control));
    }
    expect(sent).toEqual([`accept:${P3}`, `rescind:${P1}`]);
  });

  it("the train prompt: the seller's answer and the buyer's Rescind are greyed in flight", () => {
    const t = S.roomFor(S.withCorp(F.operatingBoard(), NYC, { owned_trains: ["3", "3", "2"] }));
    t.submit(P1, M.proposeTrain(NYC, PRR, "3", "150"));
    const sent: string[] = [];
    for (const viewer of [P2, P1]) {
      const roles = trainOfferConsentRoles(t.room.state, viewer);
      render(
        <TrainTradePrompt
          proposal={trainProposalFrom(t.room.state)}
          viewerIsSeller={roles.viewerIsAnswerer}
          viewerIsProposer={roles.viewerIsProposer}
          onAccept={() => sent.push("accept")}
          onReject={() => sent.push("reject")}
          onRescind={() => sent.push("rescind")}
          actionInFlight
        />,
      );
      expect(buttons().length).toBeGreaterThan(0);
      expect(live()).toEqual([]);
      for (const entry of buttons()) click(entry);
    }
    expect(sent).toEqual([]);
  });

  it("the funding offer prompt and the discard prompt are greyed in flight for the seat that must answer", () => {
    const sent: string[] = [];
    const funding = { privateId: 3, privateName: "D&H", sellerLabel: "Alice", buyerTicker: "NYC", buyerPresidentLabel: "Bob", price: 70 };
    render(<FundingPrivateOfferPrompt offer={funding} viewerIsBuyerPresident onAnswer={(_, accept) => sent.push(`funding:${accept}`)} actionInFlight />);
    expect(live()).toEqual([]);
    expect(button("Accept")!.title).toBe(CONSENT_IN_FLIGHT_TITLE);
    for (const entry of buttons()) click(entry);
    render(<FundingPrivateOfferPrompt offer={funding} viewerIsBuyerPresident onAnswer={(_, accept) => sent.push(`funding:${accept}`)} actionInFlight={false} />);
    expect(live()).toEqual(["Reject", "Accept"]);

    const due = { ticker: "PRR", limit: 3, excess: 1, choices: ["2", "3"], presidentLabel: "Alice" };
    render(<TrainDiscardPrompt due={due} viewerIsPresident onDiscard={(model) => sent.push(`discard:${model}`)} actionInFlight />);
    expect(live()).toEqual([]);
    expect(button("Discard 2-train")!.title).toBe(CONSENT_IN_FLIGHT_TITLE);
    for (const entry of buttons()) click(entry);
    render(<TrainDiscardPrompt due={due} viewerIsPresident onDiscard={(model) => sent.push(`discard:${model}`)} actionInFlight={false} />);
    expect(live()).toEqual(["Discard 2-train", "Discard 3-train"]);
    expect(sent).toEqual([]);
  });
});

/* ================================================================== */
/* The shell's wiring (source scan: `AppShell` is not exported)         */
/* ================================================================== */

describe("W1-D: the shell sends the rescissions on turn, retires the chain-era controls, and narrates nothing early", () => {
  const APP = readShell();

  it("the two rescind handlers send the room's messages with no off-turn exemption", () => {
    const priv = sliceBetween(APP, "const handleRescindPrivateOffer = useCallback(", "}, [privateProposal, runGameplayAction, gameId]);");
    expect(priv).toContain("RescindPrivatePurchase: { game_id: gameId, private_id: privateProposal.privateId }");
    expect(priv).not.toContain("offTurn");
    expect(priv).not.toContain("automatic");
    const train = sliceBetween(APP, "const handleRescindSandboxTrainOffer = useCallback(", "}, [sandboxTrainProposal, runGameplayAction, gameId]);");
    expect(train).toContain("RescindTrainPurchase: { game_id: gameId, seller_protocol_id: sandboxTrainProposal.sellerProtocolId }");
    expect(train).not.toContain("offTurn");
    expect(train).not.toContain("automatic");
  });

  it("the consent slot gives each offer prompt its proposer and Rescind, and all four prompts the latch", () => {
    const train = sliceBetween(APP, "<TrainTradePrompt", "/>");
    expect(train).toContain("proposal={sandboxTrainProposal}");
    expect(train).toContain("viewerIsSeller={trainOfferRoles.viewerIsAnswerer}");
    expect(train).toContain("viewerIsProposer={trainOfferRoles.viewerIsProposer}");
    expect(train).toContain("onRescind={handleRescindSandboxTrainOffer}");
    expect(train).toContain("actionInFlight={actionInFlight}");
    const priv = sliceBetween(APP, "<PrivateTradePrompt", "/>");
    expect(priv).toContain("viewerIsOwner={privateOfferRoles.viewerIsAnswerer}");
    expect(priv).toContain("viewerIsProposer={privateOfferRoles.viewerIsProposer}");
    expect(priv).toContain("onRescind={handleRescindPrivateOffer}");
    expect(priv).toContain("actionInFlight={actionInFlight}");
    expect(sliceBetween(APP, "<FundingPrivateOfferPrompt", "/>")).toContain("actionInFlight={actionInFlight}");
    expect(sliceBetween(APP, "<TrainDiscardPrompt", "/>")).toContain("actionInFlight={actionInFlight}");
  });

  it("no chain-era train-trade control is mounted or wired", () => {
    expect(APP).not.toContain("<TrainTradePanel");
    expect(APP).not.toMatch(/import TrainTradePanel\b/);
    for (const retired of ["RescindTrainOffer", "AcceptTrainOffer", "RejectTrainOffer", "liveTrainOffer", "viewerTrainOffers"]) {
      expect(APP).not.toContain(retired);
    }
  });

  it("no completion is narrated before the action lands", () => {
    expect(APP).not.toContain("completed immediately");
    expect(APP).not.toMatch(/Awaiting \$\{proposal\.sellerPresidentLabel\}/);
  });
});
