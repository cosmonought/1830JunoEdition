/** @jest-environment jsdom */
// frontend/src/tutorial/TutorialCoach.test.tsx -- PHASE 3 FINAL PLAY TUTORIAL: PRESENTATION (the real coach, rendered).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TutorialLayer, resolveAnchorBox } from "./TutorialCoach";
import type { LessonId } from "./lessons";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const calls: string[] = [];

/** jsdom lays nothing out; give an element a real-looking box. */
function giveBox(element: Element, rect: { top: number; left: number; width: number; height: number }) {
  (element as HTMLElement).getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;
}

function Board({ presented, subject }: { presented: LessonId | null; subject?: number }) {
  return (
    <>
      <div data-testid="board">
        <button type="button" data-tutorial-anchor="action-go-to-map" onClick={() => calls.push("lay")}>
          Lay Track
        </button>
        <input data-testid="chat" />
      </div>
      <TutorialLayer
        presented={presented ? { id: presented, subject } : null}
        scope={{}}
        onAcknowledge={() => calls.push("ack")}
        onTurnOff={() => calls.push("off")}
        onOpenLibrary={() => calls.push("library")}
        onShowMarket={() => calls.push("market")}
        onOpenRules={(page, anchor) => calls.push(`rules:${page}:${anchor ?? ""}`)}
      />
    </>
  );
}

function render(presented: LessonId | null, subject?: number) {
  act(() => root.render(<Board presented={presented} subject={subject} />));
}

const coach = () => document.querySelector<HTMLElement>("[data-tutorial-coach]");
const spotlight = () => document.querySelector<HTMLElement>("[data-tutorial-spotlight]");
const button = (label: RegExp) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) => label.test(node.textContent ?? ""))!;

beforeEach(() => {
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a non-modal coach", () => {
  it("is a labelled region, never aria-modal, never a dialog, with no scrim and no inert board", () => {
    render("orientation.goal");
    const card = coach()!;
    expect(card.tagName).toBe("SECTION"); // a labelled section: the region landmark, implicitly
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("aria-modal")).toBeNull();
    expect(card.querySelector("h2")?.textContent).toBe("What you are playing");
    // Named "Tutorial" + the lesson title.
    const labelledBy = card.getAttribute("aria-labelledby")!.split(" ");
    expect(labelledBy).toContain(card.querySelector("h2")!.id);
    expect(labelledBy.map((id) => document.getElementById(id)?.textContent).join(" ")).toBe("Tutorial What you are playing");
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    // Rendered outside the shell (a portal to the body), not inside the zoomed tree.
    expect(host.contains(card)).toBe(false);
  });

  it("does not steal focus, and the board stays usable under it", () => {
    const chat = () => document.querySelector<HTMLInputElement>("[data-testid='chat']")!;
    render(null);
    act(() => chat().focus());
    render("operating.track");
    expect(document.activeElement).toBe(chat());
    act(() => button(/^Lay Track$/).click());
    expect(calls).toEqual(["lay"]);
  });

  it("announces each new lesson once through an always-mounted polite live region", async () => {
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    render(null);
    const announcer = document.querySelector("[data-testid='tutorial-announcer']")!;
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("");
    render("stock.primer");
    await settle();
    expect(announcer.textContent).toContain("Tutorial: The Stock Round.");
    expect(announcer.textContent).toContain("Alt+Shift+T");
    // Suspended and restored (a dialog opened and closed): not read out again.
    render("orientation.goal");
    await settle();
    expect(announcer.textContent).toContain("What you are playing");
    render(null);
    render("stock.primer");
    await settle();
    expect(announcer.textContent).toContain("What you are playing");
  });
});

describe("the spotlight", () => {
  it("highlights a mounted anchor without intercepting input, and says what it highlights", () => {
    render(null);
    giveBox(document.querySelector("[data-tutorial-anchor='action-go-to-map']")!, { top: 40, left: 300, width: 100, height: 30 });
    render("operating.track");
    const ring = spotlight()!;
    expect(ring).not.toBeNull();
    expect(ring.style.pointerEvents).toBe("none");
    expect(ring.getAttribute("aria-hidden")).toBe("true");
    expect(ring.style.top).toBe("36px");
    expect(coach()!.textContent).toContain("Highlighted: The Lay Track button on the action bar.");
    expect(coach()!.getAttribute("data-placement")).toBe("below");
  });

  it("falls back to an unanchored card when the target is not mounted or not visible", () => {
    render("trains.phases"); // its anchor (the phase badge) is not on this board
    expect(spotlight()).toBeNull();
    expect(coach()!.getAttribute("data-placement")).toBe("floating");
    expect(coach()!.textContent).not.toContain("Highlighted:");
    // A mounted anchor with no box (jsdom's default, or a hidden element) counts as not visible.
    expect(resolveAnchorBox(["action-go-to-map"])).toBeNull();
  });

  it("a market lesson points at the moved corporation's token, and offers -- never takes -- the chart", () => {
    render(null);
    const token = document.createElement("span");
    token.setAttribute("data-tutorial-anchor", "market-token-7");
    document.body.appendChild(token);
    giveBox(token, { top: 300, left: 300, width: 20, height: 20 });
    render("market.moves", 7);
    expect(spotlight()).not.toBeNull();
    expect(calls).toEqual([]);
    act(() => button(/Show the Stock Market/).click());
    expect(calls).toEqual(["market"]);
    token.remove();
  });
});

describe("keyboard", () => {
  it("Escape inside the coach answers it, and is consumed there -- no other layer sees it", () => {
    const outer: boolean[] = [];
    const onWindow = (event: KeyboardEvent) => outer.push(event.key === "Escape");
    window.addEventListener("keydown", onWindow);
    render("stock.primer");
    const ok = button(/^Got it$/);
    act(() => ok.focus());
    act(() => {
      ok.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(calls).toEqual(["ack"]);
    expect(outer).toEqual([]);
    window.removeEventListener("keydown", onWindow);
  });

  it("Escape anywhere else is never the coach's", () => {
    render("stock.primer");
    const chat = document.querySelector<HTMLInputElement>("[data-testid='chat']")!;
    act(() => chat.focus());
    act(() => {
      chat.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(calls).toEqual([]);
    expect(coach()).not.toBeNull();
  });

  it("Alt+Shift+T moves focus into the coach, and answering it returns focus where it was", () => {
    render("stock.primer");
    const lay = button(/^Lay Track$/);
    act(() => lay.focus());
    const shortcut = () =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyT", key: "T", altKey: true, shiftKey: true, bubbles: true }));
      });
    shortcut();
    expect(coach()!.contains(document.activeElement)).toBe(true);
    act(() => button(/^Got it$/).click());
    expect(calls).toEqual(["ack"]);
    expect(document.activeElement).toBe(lay);
  });

  it("Alt+Shift+T is left alone while the player is typing", () => {
    render("stock.primer");
    const chat = document.querySelector<HTMLInputElement>("[data-testid='chat']")!;
    act(() => chat.focus());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyT", key: "T", altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(chat);
  });

  it("leaving the coach by Tab-reached controls hands focus to the shell's fallback, never to the body", () => {
    const heading = document.createElement("h1");
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    act(() =>
      root.render(
        <TutorialLayer
          presented={{ id: "stock.primer" }}
          scope={{}}
          onAcknowledge={() => calls.push("ack")}
          onTurnOff={() => calls.push("off")}
          onOpenLibrary={() => undefined}
          fallbackFocus={() => heading}
        />,
      ),
    );
    act(() => button(/^Got it$/).focus());
    act(() => button(/^Got it$/).click());
    expect(document.activeElement).toBe(heading);
    heading.remove();
  });
});

describe("the coach's controls", () => {
  it("More shows the deeper text; the links reach the rule, the library, and the off switch", () => {
    render("operating.primer");
    expect(coach()!.textContent).not.toContain("side action, not a sixth step");
    const more = button(/^More$/);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(coach()!.textContent).toContain("side action, not a sixth step");
    act(() => button(/^Rules Reference$/).click());
    act(() => button(/^Tutorials$/).click());
    act(() => button(/Turn off automatic tutorials/).click());
    expect(calls).toEqual(["rules:overview:", "library", "off"]);
  });
});
