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
// PHASE 3 FINAL PLAY TUTORIAL: the tutorials are the canonical lesson registry now (`tutorial/lessons.ts`); a
// Delayed Auction table reads them through `lessonText(lesson, { delayedAuction: true })`.
import { LESSONS, LIBRARY_TOPICS, lessonById, lessonText } from "../tutorial/lessons";

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
  const delayed = (id: string) => lessonText(lessonById(id)!, { delayedAuction: true });
  const standard = (id: string) => lessonText(lessonById(id)!, {});

  it("rewrites only the lessons written for an opening auction", () => {
    const cash = delayed("auction.cash");
    expect(cash.title).toBe("Watch your cash");
    expect(cash.summary).not.toContain("Everyone starts with the same cash");
    expect(cash.summary).toContain("in the middle of the game");
    expect(standard("auction.cash").summary).toContain("Everyone starts with the same cash");

    expect(delayed("auction.primer").summary).toContain("first 3-train");
    expect(standard("auction.primer").summary).toContain("Before any corporation exists");
    expect((delayed("stock.primer").detail ?? []).join(" ")).toContain("first 3-train");
    expect((standard("stock.primer").detail ?? []).join(" ")).not.toContain("first 3-train");

    expect(delayed("orientation.flow").summary).toContain("opens with a Stock Round");
    expect(standard("orientation.flow").summary).toContain("opens with an auction of private companies");
    const rewritten = new Set(["auction.cash", "auction.primer", "stock.primer", "orientation.flow"]);
    for (const lesson of LESSONS) {
      if (rewritten.has(lesson.id)) continue;
      expect([lesson.id, delayed(lesson.id)]).toEqual([lesson.id, standard(lesson.id)]);
    }
  });

  it("the library names no opening auction a Delayed Auction table never has", () => {
    const auction = LIBRARY_TOPICS.find((topic) => topic.id === "auction")!;
    expect(auction.blurb).not.toContain("before the game proper starts");
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
