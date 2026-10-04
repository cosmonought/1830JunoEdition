/** @jest-environment jsdom */
//
// ==================================================================
//  DA-6: THE DELAYED AUCTION'S RENDERED SURFACES (DA-F8b, e, f, g, h, the Phase 3 notice)
// ==================================================================
//
// What a player at a Delayed Auction table actually reads, rendered: the handoff card, the Phase 3 notice, the
// tutorials, and the Rules Reference's Overview and Auction & Privates pages. Each Delayed Auction reading is
// asserted beside the standard game's, which must render exactly as before.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AuctionPromptModal } from "./AuctionPromptModal";
import { ModalLayerHost } from "./ModalPortal";
import { PhaseThreeNoticeModal } from "./PhaseThreeNoticeModal";
import RulesReference, { type RulesReferenceProps } from "./RulesReference";
import {
  DELAYED_STOCK_ROUND_TUTORIAL,
  DELAYED_WATERFALL_AUCTION_TUTORIAL,
  STOCK_ROUND_TUTORIAL,
  TUTORIAL_LIBRARY,
  WATERFALL_AUCTION_TUTORIAL,
  tutorialLibraryFor,
} from "./TutorialModal";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactElement) {
  act(() => {
    root.render(node);
  });
}
const text = () => document.body.textContent ?? "";
function required(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`not rendered: ${id}`);
  return found;
}
function click(node: Element | null) {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const handoff = (extra: Record<string, unknown> = {}) => (
  <AuctionPromptModal
    parPending={false}
    parWinnerLabel=""
    onConfirmPar={() => undefined}
    handoffPending
    awaitingParFrom={null}
    onProceed={() => undefined}
    {...extra}
  />
);

/* ================================================================================================== */
describe("DA-F8b: the handoff names the Stock Round it opens", () => {
  /* Phase 3 W2-H: the actor's handoff card is a `NativeModal` now, rendered through the modal layer the application
     mounts beside the screen -- committed first, on its own root, exactly as the Phase 3 notice below is. */
  let layerHost: HTMLDivElement;
  let layerRoot: Root;
  beforeEach(() => {
    layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    layerRoot = createRoot(layerHost);
    act(() => {
      layerRoot.render(<ModalLayerHost />);
    });
  });
  afterEach(() => {
    act(() => {
      root.render(<></>);
    });
    act(() => layerRoot.unmount());
    layerHost.remove();
  });

  it("the standard game's card is unchanged -- Stock Round 1", () => {
    render(handoff());
    expect(text()).toContain("The Waterfall Auction is complete");
    expect(text()).toContain("Stock Round 1 opens next");
    expect(text()).toContain("Proceed to Stock Round 1");
  });

  it("the Delayed Auction's card names the round it really opens, and the B&O opening", () => {
    render(handoff({ nextStockRound: 4, delayedAuction: true }));
    expect(text()).toContain("The private company auction is complete");
    expect(text()).toContain("Stock Round 4 opens next");
    expect(text()).toContain("the B&O is now open for trading");
    expect(text()).toContain("Proceed to Stock Round 4");
    expect(text()).not.toContain("Stock Round 1");
    expect(document.querySelector("button[title]")?.getAttribute("title")).toBe("Close the auction and open Stock Round 4.");
  });
});

/* ================================================================================================== */
describe("the Phase 3 notice under the Delayed Auction", () => {
  /* The notice is a `NativeModal`, rendered through the modal layer the application mounts beside the screen
     (`GameRouter`); committed first, on its own root, as `noticeModalDismissal.test.tsx` does (#1651). */
  let layerHost: HTMLDivElement;
  let layerRoot: Root;
  beforeEach(() => {
    layerHost = document.createElement("div");
    document.body.appendChild(layerHost);
    layerRoot = createRoot(layerHost);
    act(() => {
      layerRoot.render(<ModalLayerHost />);
    });
  });
  afterEach(() => {
    act(() => {
      root.render(<></>);
    });
    act(() => layerRoot.unmount());
    layerHost.remove();
  });

  it("keeps the standard notice where the privates really are for sale", () => {
    render(<PhaseThreeNoticeModal open onAcknowledge={() => undefined} />);
    expect(text()).toContain("Private companies are for sale");
    expect(text()).toContain("From now on a corporation may buy a private company");
  });

  it("says the auction is next -- never 'for sale' -- while the delayed auction is still owed", () => {
    render(<PhaseThreeNoticeModal open onAcknowledge={() => undefined} delayedAuctionPending />);
    expect(text()).toContain("The private company auction is next");
    expect(text()).toContain("When this Operating Round set ends");
    expect(text()).toContain("After the auction");
    expect(text()).not.toContain("Private companies are for sale");
    expect(text()).not.toContain("From now on");
  });
});

/* ================================================================================================== */
describe("DA-F8h: the tutorials a Delayed Auction table reads", () => {
  it("replaces only the two pages written for an opening auction", () => {
    expect(DELAYED_WATERFALL_AUCTION_TUTORIAL).toHaveLength(WATERFALL_AUCTION_TUTORIAL.length);
    expect(DELAYED_WATERFALL_AUCTION_TUTORIAL.slice(0, -1)).toEqual(WATERFALL_AUCTION_TUTORIAL.slice(0, -1));
    const cash = DELAYED_WATERFALL_AUCTION_TUTORIAL[DELAYED_WATERFALL_AUCTION_TUTORIAL.length - 1];
    expect(cash.title).toBe("Watch your cash");
    expect(cash.body).not.toContain("You start this Auction");
    expect(cash.body).toContain("in the middle of the game");

    expect(DELAYED_STOCK_ROUND_TUTORIAL.slice(1)).toEqual(STOCK_ROUND_TUTORIAL.slice(1));
    expect(DELAYED_STOCK_ROUND_TUTORIAL[0].body).not.toContain("Now that the Private Company auction is complete");
    expect(DELAYED_STOCK_ROUND_TUTORIAL[0].body).toContain("first 3-train");
  });

  it("the library: the standard one is untouched; the delayed one drops 'before the game proper starts'", () => {
    expect(tutorialLibraryFor(false)).toBe(TUTORIAL_LIBRARY);
    const auction = tutorialLibraryFor(true).find((topic) => topic.topicKey === "waterfall-auction")!;
    expect(auction.blurb).not.toContain("before the game proper starts");
    expect(auction.pages).toBe(DELAYED_WATERFALL_AUCTION_TUTORIAL);
    expect(tutorialLibraryFor(true).find((topic) => topic.topicKey === "stock-round")!.pages).toBe(DELAYED_STOCK_ROUND_TUTORIAL);
  });
});

/* ================================================================================================== */
describe("the Rules Reference on a Delayed Auction table (DA-F8e, f, g; the auction's rulings)", () => {
  const VARIANTS = (delayedAuction: boolean): RulesReferenceProps["variants"] => ({
    expandedMap: false,
    levelPlayingField: false,
    delayedAuction,
    gentleRust: false,
    unpredictableRevenue: false,
    dynamicStockMarket: false,
    plusTiles: false,
  });
  const PHASE_2: RulesReferenceProps["phase"] = { label: "Phase 2", tier: "2", trainLimit: 4 };
  const PHASE_3: RulesReferenceProps["phase"] = { label: "Phase 3", tier: "3", trainLimit: 4 };

  it("DA-F8f: Phase 2's 'Current phase' note is the delayed reading -- not 'All private companies purchased'", () => {
    render(<RulesReference roundType="StockRound" roundLabel="SR1" playerCount={4} phase={PHASE_2} variants={VARIANTS(true)} auctionComplete={false} />);
    const strip = required("rules-glance-strip").textContent ?? "";
    expect(strip).toContain("Start of the game");
    expect(strip).not.toContain("All private companies purchased");
  });

  it("…and the standard game's note is unchanged", () => {
    render(<RulesReference roundType="StockRound" roundLabel="SR1" playerCount={4} phase={PHASE_2} variants={VARIANTS(false)} auctionComplete />);
    expect(required("rules-glance-strip").textContent ?? "").toContain("All private companies purchased");
  });

  it("DA-F8e: the live delayed auction's 'This round' lead drops the base game's timing", () => {
    render(<RulesReference roundType="WaterfallAuction" playerCount={4} phase={PHASE_3} variants={VARIANTS(true)} auctionComplete={false} />);
    expect(text()).toContain("The Private Companies are sold through a buy-bid-turn sequence");
    expect(text()).not.toContain("Before the first Stock Round, the Private Companies are sold");
    expect(text()).not.toContain("Pre-game"); // the auction card's tag is not a rendered claim on this table
  });

  it("DA-F8g: the game flow says what follows the delayed auction", () => {
    render(<RulesReference roundType="StockRound" roundLabel="SR1" playerCount={4} phase={PHASE_2} variants={VARIANTS(true)} auctionComplete={false} />);
    click(required("rules-game-flow-toggle"));
    expect(required("rules-game-flow-open").textContent).toContain("just before the next Stock Round");
  });

  it("the Auction page states the delayed auction's rulings: the cancellation, the reserved share, the overage", () => {
    render(<RulesReference roundType="StockRound" roundLabel="SR1" playerCount={4} phase={PHASE_2} variants={VARIANTS(true)} auctionComplete={false} />);
    click(required("rules-page-auction"));
    const notes = required("rules-auction-variants").textContent ?? "";
    expect(notes).toContain("If the first 5-train is bought before it runs, the auction is cancelled"); // D-55
    expect(notes).toContain("One 10% PRR share stays in the Initial Offering for whoever buys the C&A"); // D-52
    expect(notes).toContain("whatever a legal sale can fix before buying or passing"); // D-53, D-58
    expect(notes).toContain("an excess no sale can fix is not owed"); // D-58
    expect(notes).toContain("A buy or a bid is refused if winning would leave an excess no sale"); // D-57, D-58
    expect(required("rules-auction-ends").textContent).toContain("and the next Stock Round follows");
    expect(text()).not.toContain("Pre-game");
  });

  it("the standard game's Auction page shows none of them", () => {
    render(<RulesReference roundType="StockRound" roundLabel="SR1" playerCount={4} phase={PHASE_2} variants={VARIANTS(false)} auctionComplete />);
    click(required("rules-page-auction"));
    expect(document.querySelector('[data-testid="rules-auction-variants"]')).toBeNull();
    expect(required("rules-auction-ends").textContent).toContain("The first Stock Round follows");
  });
});
