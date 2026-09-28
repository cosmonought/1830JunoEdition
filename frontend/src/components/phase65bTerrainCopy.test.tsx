/** @jest-environment jsdom */
//
// ==================================================================
//  6.5-B (RR-2 COPY) HARNESS: THE RULES REFERENCE STOPS SAYING UPGRADES ARE ALWAYS FREE
// ==================================================================
//
// Owner rulings RR-2 (G19) and OD-A-3 (D10 and E5 follow G19): a hex that begins with preprinted yellow track AND
// carries an unpaid printed terrain cost pays that cost on its FIRST upgrade to green, once; later upgrades pay
// nothing. The engine already charges exactly that (`terrainFee.ts` #723; proved by play in 6.5-A §2). The copy said
// otherwise in four places. This asserts the rendered page: the four false statements are gone, the generalized rule
// is on the page, and the hexes it names are the board's own preprinted-yellow terrain hexes. No engine behaviour is
// touched or asserted here (that regression is 6.5-E's).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RulesReference from "./RulesReference";
import { STATIC_BOARD_HEXES } from "./hexBoardData";

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

const click = (node: Element | null) => {
  if (!node) throw new Error("nothing to click");
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

/** The whole reference, every page visited, as one text. `atLayTrack` supplies the live Operating Round step, which is
 *  what puts the Lay Track quick bullets on the Overview ("Current Action"). */
function everyPageText(atLayTrack = false): string {
  act(() => {
    root.render(
      atLayTrack ? (
        <RulesReference roundType="OperatingRound" roundLabel="OR 2.1" operatingSubPhase="Track" activeCorporation={{ ticker: "PRR" }} playerCount={4} />
      ) : (
        <RulesReference />
      ),
    );
  });
  const texts: string[] = [];
  const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="rules-page-"]')).map((tab) => tab.dataset.testid as string);
  expect(pages.length).toBeGreaterThan(1);
  for (const id of pages) {
    click(container.querySelector(`[data-testid="${id}"]`));
    texts.push(container.textContent ?? "");
  }
  return texts.join("\n");
}

const RULE =
  "Ordinary tile upgrades do not pay terrain costs. However, when a hex begins with preprinted yellow track and also carries an unpaid printed terrain cost, that printed terrain cost is paid on the first upgrade to green. It is paid only once; later upgrades pay no terrain cost.";

describe("RR-2: the four 'upgrades are free' statements are corrected", () => {
  it("none of the categorical statements survives anywhere on the reference", () => {
    const text = everyPageText() + everyPageText(true);
    expect(text).not.toContain("Tile upgrades are free.");
    expect(text).not.toContain("No terrain cost is paid for an upgrade.");
    expect(text).not.toContain("Free, regardless of terrain");
    expect(text).not.toContain("must be paid when placing a new tile:");
  });

  it("the owner's generalized rule is on the page, with the quick bullet, the terrain line and the lookup row agreeing", () => {
    const text = everyPageText();
    expect(text).toContain(RULE);
    // The quick bullet is the Overview's "Current Action" while a corporation is at Lay Track.
    expect(everyPageText(true)).toContain("Upgrades pay no terrain cost — except a preprinted yellow hex's unpaid printed terrain cost, paid once on its first green upgrade.");
    expect(text).toContain("once on its first upgrade to green");
    expect(text).toContain("which pays it once");
  });

  it("the hexes it names are exactly the standard board's preprinted-yellow terrain hexes (G19, D10, E5), each $80 water", () => {
    const preprintedTerrain = STATIC_BOARD_HEXES.filter(
      (hex) => (hex as { printedColor?: string }).printedColor === "Yellow" && (hex as { type?: string }).type !== "Plain",
    )
      .map((hex) => `${hex.label}:${(hex as { type?: string }).type}`)
      .sort();
    expect(preprintedTerrain).toEqual(["D10:River", "E5:River", "G19:River"]);
    const text = everyPageText();
    expect(text).toContain("G19 (New York), D10 (Hamilton & Toronto) and E5 (Detroit & Windsor)");
    expect(text).toContain("$80 water cost");
  });
});
