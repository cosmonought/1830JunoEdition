/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-J (AUD-06.03 / A-2): THE WATCHER'S HOME-STATION FORM
// ==================================================================
//
// A seatless watcher in a room has `viewerAddress === ""`. The old prop had a `!viewerAddress ||` arm (hotseat's,
// #783), so that watcher was handed the President's Place Home Station form. The rule now lives in
// `homeStationAskView.ts` -- `!spectator && president === viewerAddress`, with no escape arm -- and App passes it
// straight through. Three layers are pinned here:
//   1. the rule itself, as a truth table over every seat type;
//   2. what the card RENDERS for the watcher (no control at all) and for the President (the one button);
//   3. that App calls the rule and the escape arm is gone from the prop.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { HomeStationPrompt } from "../components/HomeStationPrompt";
import { homeStationViewerIsPresident } from "./homeStationAskView";
import { readShell, readStripped, sliceBetween } from "./sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const PRESIDENT = "p-alice";

describe("the rule: only the President's own, non-spectating screen is asked", () => {
  it("asks the President", () => {
    expect(homeStationViewerIsPresident({ spectator: false, president: PRESIDENT, viewerAddress: PRESIDENT })).toBe(true);
  });

  it("does not ask a seatless watcher in a room (id \"\") -- the A-2 regression", () => {
    expect(homeStationViewerIsPresident({ spectator: false, president: PRESIDENT, viewerAddress: "" })).toBe(false);
  });

  it("does not ask a viewer that has no id yet (null / undefined)", () => {
    expect(homeStationViewerIsPresident({ spectator: false, president: PRESIDENT, viewerAddress: null })).toBe(false);
    expect(homeStationViewerIsPresident({ spectator: false, president: PRESIDENT, viewerAddress: undefined })).toBe(false);
  });

  it("does not ask another seated player", () => {
    expect(homeStationViewerIsPresident({ spectator: false, president: PRESIDENT, viewerAddress: "p-bob" })).toBe(false);
  });

  it("does not ask a spectator, even one whose wallet IS the president's", () => {
    expect(homeStationViewerIsPresident({ spectator: true, president: PRESIDENT, viewerAddress: PRESIDENT })).toBe(false);
    expect(homeStationViewerIsPresident({ spectator: true, president: PRESIDENT, viewerAddress: "" })).toBe(false);
  });

  it("asks nobody when the board names no president (no null === null, no \"\" === \"\")", () => {
    for (const president of [null, undefined, ""]) {
      for (const viewerAddress of [null, undefined, "", PRESIDENT]) {
        expect(homeStationViewerIsPresident({ spectator: false, president, viewerAddress })).toBe(false);
      }
    }
  });
});

describe("what the card renders", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (viewerAddress: string, spectator = false) => {
    const onPlace = jest.fn();
    act(() => {
      root.render(
        <HomeStationPrompt
          pending={{ companyId: 1, ticker: "PRR", hexLabel: "H12", q: 0, r: 0 }}
          presidentLabel="Alice"
          liveryColor="#0f0f0f"
          liveryInk="#eaf2ff"
          onPlace={onPlace}
          viewerIsPresident={homeStationViewerIsPresident({ spectator, president: PRESIDENT, viewerAddress })}
        />,
      );
    });
    return onPlace;
  };

  it("gives a seatless watcher the waiting card and no control", () => {
    render("");
    expect(container.textContent).toContain("Waiting for Alice");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toContain("As President you place");
  });

  it("gives a spectator the waiting card and no control", () => {
    render(PRESIDENT, true);
    expect(container.textContent).toContain("Waiting for Alice");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("still gives the President the form and its one button", () => {
    const onPlace = render(PRESIDENT);
    expect(container.textContent).toContain("As President you place its first station token");
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    act(() => buttons[0].click());
    expect(onPlace).toHaveBeenCalledTimes(1);
  });
});

describe("App passes the rule, with no escape arm", () => {
  const APP = readShell();
  /** The `HomeStationPrompt` mount, up to the next prop after the one under test. */
  const MOUNT = sliceBetween(APP, "<HomeStationPrompt", "liveryColor=");

  it("decides the prop with the rule", () => {
    expect(MOUNT).toContain("viewerIsPresident={homeStationViewerIsPresident({");
    expect(MOUNT).toContain("spectator,");
    expect(MOUNT).toContain("president: pendingHomeToken?.president,");
    expect(MOUNT).toContain("viewerAddress,");
  });

  it("has dropped the `!viewerAddress` arm and the no-president arm", () => {
    expect(MOUNT).not.toContain("!viewerAddress");
    expect(MOUNT).not.toContain("!pendingHomeToken?.president ||");
  });

  it("keeps the rule free of a falsy escape arm", () => {
    /* Phase 3 W2-H: the rule's body moved to the shared viewer policy (`waitingPromptView.ts`), which the B&O par
       and the auction handoff ask too; the home-station rule delegates to it unchanged. */
    const ASK = readStripped("utils/homeStationAskView.ts");
    expect(ASK).toContain("return viewerIsNamedActor({ spectator, actor: president, viewerAddress });");
    const RULE = readStripped("utils/waitingPromptView.ts");
    expect(RULE).toContain("if (spectator) return false;");
    expect(RULE).toContain("return actor === viewerAddress;");
    expect(RULE).not.toMatch(/!\s*viewerAddress\s*\|\|/);
    expect(ASK).not.toMatch(/!\s*viewerAddress\s*\|\|/);
  });
});
