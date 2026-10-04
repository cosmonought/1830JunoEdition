/** @jest-environment jsdom */
//
// PHASE 3 W2-E -- RR-6 (isolated Rules Reference hunk). The MH catalog row on the Auction & Privates page states
// what the authority (`mohawkExchange.ts`, #1630) enforces and the page used to omit: the Orange/Brown 60%
// waiver, the certificate limit, the owner's choice of pile, and the queued timing. Copy only.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference, { type RulesReferenceProps } from "./RulesReference";

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

describe("RR-6: the MH catalog row states what the authority enforces", () => {
  const LIVE_AUCTION: RulesReferenceProps = {
    roundType: "WaterfallAuction",
    playerCount: 4,
    phase: { label: "Phase 2", tier: "2", trainLimit: 4 },
  };

  it("names the waiver, the certificate limit, the owner's pile and the queued timing", () => {
    act(() => {
      root.render(<RulesReference {...LIVE_AUCTION} />);
    });
    const tab = container.querySelector('[data-testid="rules-page-auction"]');
    if (!tab) throw new Error("no auction page tab");
    act(() => {
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const row = container.querySelector<HTMLElement>('[data-testid="rules-private-MH"]');
    if (!row) throw new Error("no MH catalog row");
    const text = row.textContent ?? "";
    expect(text).toContain("unless NYC is in the Orange or Brown zone");
    expect(text).toContain("the exchange must not leave the player over the certificate limit");
    expect(text).toContain("in the pile the owner chooses, the IPO or the Bank Pool");
    expect(text).toContain(
      "On the owner's own Stock Round turn the exchange executes at once. Requested during any other turn, it is queued and executes at the next turn boundary, after every condition above is checked again.",
    );
  });
});
