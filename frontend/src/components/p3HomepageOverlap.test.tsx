/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 (P3-ACCT): THE HOMEPAGE OVERLAP -- THE LIST IS LAID OUT BELOW THE DOORS, WHATEVER THE WINDOW
// ==================================================================
//
// REPORTED: at a constrained width or zoom the tables list ran over Host / Join and the account buttons. The doors
// hang at 70% of a `cover` scene that can be far taller than the window, while the list started where the hero
// window ended -- two coordinate systems nobody compared (see `Lobby.tsx`, "THE HOMEPAGE OVERLAP").
//
// What is pinned here (jsdom has no layout, so the real geometry is measured in Chromium against the production
// bundle -- recorded in the slice report -- and THIS pins the mechanism that makes it hold):
//   1. the doors' anchor is clamped INTO the hero window (`--lobby-hero-window`, the viewport-only hero) and never
//      above the title's foot;
//   2. the row is MEASURED and the hero's share of the flow is at least its foot plus a gap -- the list is REFLOWED
//      below the doors, never moved by an absolute collision rule;
//   3. the window the photograph is seen through grows with it (no door on bare ink); the authored composition
//      (#1131's 70% / 20% / 60%) is unchanged.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Lobby, actionsTopFor, heroVars } from "./Lobby";
import { ModalLayerHost } from "./ModalPortal";
import { WalletProvider } from "../context/WalletContext";
import { installSessionPort, readySessionPort } from "../utils/sessionBootstrap";
import { readStripped } from "../utils/sourceScan";

jest.mock("../config/backend", () => ({ isBackendConfigured: () => true, backendConfigError: () => null }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const LOBBY = readStripped("components/Lobby.tsx");

describe("P3-ACCT: the homepage overlap, the mechanism", () => {
  it("clamps the doors into the window, under the title, without moving the authored composition", () => {
    expect(LOBBY).toContain('"--lobby-hero-window": heroWindow,');
    expect(LOBBY).toContain("top: `max(calc(${titleFoot} + ${half + 12}px), min(70%, calc(var(--lobby-hero-window) - ${half + 20}px)))`");
    expect(LOBBY).toContain("const titleFoot = `max(40%, calc(${WORDMARK_HEIGHT_OF_SCENE} + ${utilityRowPx + 16}px))`;");
    /* #1131's coordinates still read as written. */
    expect(LOBBY).toContain('top: "70%"');
    expect(LOBBY).toContain('left: "20%"');
    expect(LOBBY).toContain('width: "60%"');
  });

  it("the hero arithmetic: no measurement yet -> the window alone; measured -> at least the doors' foot plus the gap", () => {
    expect((heroVars(1, 56) as Record<string, string>)["--lobby-hero"]).toBe("min(100vh, max(520px, 74vh))");
    expect((heroVars(1, 56, 700) as Record<string, string>)["--lobby-hero"]).toBe("max(min(100vh, max(520px, 74vh)), 724px)");
    expect((heroVars(1, 56, 700) as Record<string, string>)["--lobby-hero-flow"]).toBe("max(0px, calc(max(min(100vh, max(520px, 74vh)), 724px) - 88px))");
    expect((heroVars(0.63, 56, 700) as Record<string, string>)["--lobby-hero-window"]).toBe(`min(${100 / 0.63}vh, max(520px, ${74 / 0.63}vh))`);
  });

  it("reflows the list below the measured doors: the hero's flow share is at least the row's foot plus a gap", () => {
    expect(LOBBY).toContain("const hero = actionsBottomPx > 0 ? `max(${heroWindow}, ${Math.ceil(actionsBottomPx) + ACTIONS_GAP_PX}px)` : heroWindow;");
    expect(LOBBY).toContain('"--lobby-hero-flow": `max(0px, calc(${hero} - ${utilityRowPx + 32}px))`,');
    expect(LOBBY).toContain("observer?.observe(row);");
    expect(LOBBY).toContain("observer?.observe(page);");
    expect(LOBBY).toContain('window.addEventListener("resize", measure);');
    /* No absolute collision rule anywhere: nothing positions the list against the doors. */
    expect(LOBBY).not.toMatch(/position: "absolute",\s*top: `?calc\(var\(--lobby-actions/);
  });

  it("rendered: a tall, low door row (a wrapped one on a short window) pushes the list's place down by its own foot", () => {
    installSessionPort(readySessionPort());
    const realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const testId = this.getAttribute("data-testid");
      if (testId === "lobby-actions") return { top: 560, bottom: 780, height: 220, left: 0, right: 100, width: 100, x: 0, y: 560, toJSON: () => ({}) } as DOMRect;
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() =>
        root.render(
          <>
            <WalletProvider>
              <Lobby onEnterSandbox={() => undefined} />
            </WalletProvider>
            <ModalLayerHost />
          </>,
        ),
      );
      const page = container.firstElementChild as HTMLElement;
      /* The row's foot (780px) plus the 24px gap: the hero -- and with it the list's place -- is at least 804px. */
      expect(page.style.getPropertyValue("--lobby-hero")).toContain("804px");
      expect(page.style.getPropertyValue("--lobby-hero-flow")).toContain("804px");
      /* And the anchor is clamped by half its measured height (110px) plus the margin (jsdom cannot hold a
         `max()` length, so the value is read from the function that writes it). */
      expect(actionsTopFor(56, 220).top).toBe("max(calc(max(40%, calc(24.6% + 72px)) + 122px), min(70%, calc(var(--lobby-hero-window) - 130px)))");
    } finally {
      act(() => root.unmount());
      container.remove();
      Element.prototype.getBoundingClientRect = realRect;
      installSessionPort(null);
    }
  });
});
