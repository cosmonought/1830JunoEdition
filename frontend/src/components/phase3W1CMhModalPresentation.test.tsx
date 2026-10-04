/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 WAVE-1 INTEGRATION: THE M&H MODAL'S PRESENTATION (W1-C follow-up)
// ==================================================================
//
// Presentation only -- the flow's steps, their keys and what a press sends are W1-C's and are unchanged:
//   * the single "No, Keep the Private" answers the WHOLE question, so it is drawn under every pile's choice, outside
//     the step boxes, rather than inside the last pile's row (where it read as "not from this pile");
//   * when only one pile is legal, the other pile's reason (the authority's sentence) is shown BEFORE the question,
//     not appended after "Are you sure?".
// The D&H's sequence keeps its forfeit inside its own step: that decline belongs to that step.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModalLayerHost } from "./ModalPortal";
import { PrivatePowerFlowModal } from "./PrivatePowerFlowModal";
import { privatePowerFlow, type ExchangeSourceOption, type PowerFlow } from "../utils/privatePowerFlow";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const POOL_EMPTY = "The Bank Pool holds no NYC certificate to exchange for.";
const QUESTION = "Exchanging this Private Company for an NYC share forfeits its $20/OR revenue. Are you sure?";
const mh = (sources: readonly ExchangeSourceOption[]) =>
  privatePowerFlow({ abilityKey: "mh-exchange", holder: "Ann", revenuePerOr: 20, sources });

let layerHost: HTMLDivElement;
let layerRoot: Root;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot.render(<ModalLayerHost />));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  act(() => layerRoot.unmount());
  host.remove();
  layerHost.remove();
});

function renderFlow(flow: PowerFlow, sink: string[] = []) {
  act(() =>
    root.render(
      <PrivatePowerFlowModal
        flow={flow}
        ticker="NNH"
        tokensLeft={2}
        onAct={(key) => sink.push(`act:${key}`)}
        onDecline={(key) => sink.push(`decline:${key}`)}
        onCancel={() => sink.push("cancel")}
      />,
    ),
  );
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
const button = (text: string) => buttons().find((entry) => entry.textContent === text);
const paragraph = (text: string) =>
  Array.from(document.querySelectorAll<HTMLParagraphElement>("p")).find((entry) => entry.textContent === text);
/** The nearest ancestor of `node` that also holds a button labelled `label` -- the box the two share. */
const sharedBox = (node: Element, label: RegExp) => {
  let at: Element | null = node.parentElement;
  while (at && !Array.from(at.querySelectorAll("button")).some((entry) => label.test(entry.textContent ?? ""))) {
    at = at.parentElement;
  }
  return at;
};
const precedes = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("the M&H's one No answers the whole question", () => {
  it("both piles legal: one No, drawn after both choices and outside either pile's box", () => {
    const sink: string[] = [];
    renderFlow(mh([{ source: "Ipo", refusal: null }, { source: "Bank", refusal: null }]), sink);
    const noes = buttons().filter((entry) => entry.textContent === "No, Keep the Private");
    expect(noes).toHaveLength(1);
    const no = noes[0];
    const ipo = button("Exchange for IPO Share")!;
    const bank = button("Exchange for Bank Pool Share")!;
    // After both choices in reading order.
    expect(precedes(ipo, no)).toBe(true);
    expect(precedes(bank, no)).toBe(true);
    // Not inside either pile's row: the smallest box holding the No and a pile's button holds BOTH piles' buttons.
    const box = sharedBox(no, /^Exchange for /)!;
    expect(box.contains(ipo) && box.contains(bank)).toBe(true);
    // The press is unchanged: it declines through the step that carries the flow's decline.
    act(() => no.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(sink).toEqual(["decline:exchange-bank"]);
    expect(no.title).toBe("Closes this question. The private company and its power are untouched.");
  });

  it("one pile legal: still one No, outside the pile's own box", () => {
    renderFlow(mh([{ source: "Ipo", refusal: null }, { source: "Bank", refusal: POOL_EMPTY }]));
    const no = button("No, Keep the Private")!;
    const ipo = button("Exchange for IPO Share")!;
    const pileRow = ipo.parentElement!; // the step's action row
    expect(pileRow.contains(no)).toBe(false);
    expect(precedes(ipo, no)).toBe(true);
  });

  it("the D&H's forfeit stays in its own step (a sequence's decline belongs to its step)", () => {
    renderFlow(privatePowerFlow({ abilityKey: "dh-tile", holder: "NNH", hexLabel: "F16", layDone: true, station: "pending" }));
    const forfeit = button("Forfeit Free Placement")!;
    expect(forfeit.parentElement!.contains(button("Place Station Token")!)).toBe(true);
  });
});

describe("the missing pile's reason comes before the question", () => {
  it("one pile legal: the authority's sentence, then the question, then the choice", () => {
    renderFlow(mh([{ source: "Ipo", refusal: null }, { source: "Bank", refusal: POOL_EMPTY }]));
    const note = paragraph(POOL_EMPTY)!;
    const question = paragraph(QUESTION)!;
    expect(note).toBeTruthy();
    expect(question).toBeTruthy();
    expect(precedes(note, question)).toBe(true);
    expect(precedes(question, button("Exchange for IPO Share")!)).toBe(true);
    expect(note.getAttribute("role")).toBe("status");
  });

  it("both piles legal: no note, the question asks for the choice", () => {
    renderFlow(mh([{ source: "Ipo", refusal: null }, { source: "Bank", refusal: null }]));
    expect(document.body.textContent).not.toContain(POOL_EMPTY);
    expect(paragraph(`${QUESTION} Choose where the share comes from.`)).toBeTruthy();
  });
});
