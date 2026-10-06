/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 (P3-ACCT / P3-N028): THE HOMEPAGE OVERLAP -- THE MECHANISM
// ==================================================================
//
// REPORTED (P3-ACCT): at a constrained width or zoom the tables list ran over Host / Join and the account buttons.
// FIRST FIX (W3-L): the doors stayed absolutely positioned in the photograph; their foot was MEASURED
// (`getBoundingClientRect` / `ResizeObserver`) and replayed as the height of an empty spacer above the list.
// REOPENED (2026-10-06, the owner, ~300% viewing scale): "Your Tables" covering Host / Join again. A measured boundary is
// a copy that lands a render late -- in real Chromium the list was painted over the doors in the frames after a load, a
// resize and a sign-in (`docs/phase3/evidence/p3acct/homepage_tables_boundary.md`) -- and is wrong wherever the
// measurement is.
//
// What is pinned here is the mechanism that REPLACED it (`Lobby.tsx`, "THE TOP REGION OWNS ITS HEIGHT"): the corner, the
// title and the doors are flow content of one top region that owns its height; the photograph is that region's
// background; the composition is CSS arithmetic of the window, not a measurement. The DOM structure in every homepage
// state is pinned by `p3HomepageTablesBoundary.test.tsx`; the geometry, in real Chromium, by the evidence script.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ACTIONS_MARGIN_TOP, Lobby, TITLE_MARGIN_TOP, topRegionVars } from "./Lobby";
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

describe("P3-N028: the homepage overlap, the mechanism", () => {
  it("measures nothing: the first fix's observers, client rects and spacer are gone", () => {
    expect(LOBBY).not.toContain("ResizeObserver");
    expect(LOBBY).not.toContain("getBoundingClientRect");
    expect(LOBBY).not.toContain("heroVars");
    expect(LOBBY).not.toContain("actionsTopFor");
    expect(LOBBY).not.toContain("--lobby-hero-flow");
    expect(LOBBY).not.toContain('"--lobby-hero":');
    expect(LOBBY).not.toContain("heroFlow");
  });

  it("the top region's lengths are the window's, in layout space (#1144/#1294), and nothing else", () => {
    expect(topRegionVars(1)).toEqual({
      "--lobby-hero-window": "min(100vh, max(520px, 74vh))",
      "--lobby-window-h": "100vh",
      "--lobby-scene-w": "max(100vw, calc(100vh * 1920 / 1072))",
      "--lobby-scene-h": "max(100vh, calc(100vw * 1072 / 1920))",
    });
    const zoomed = topRegionVars(1.25) as Record<string, string>;
    expect(zoomed["--lobby-hero-window"]).toBe("min(80vh, max(520px, 59.2vh))");
    expect(zoomed["--lobby-scene-h"]).toBe("max(80vh, calc(80vw * 1072 / 1920))");
  });

  it("keeps #1131's composition as flow margins: the title's foot at 0.4 of the scene, the doors' centre at 0.7, clamped into the window", () => {
    /* The wordmark: 20% of the scene, at least 230px -- unless the window is so short (~300% zoom) that half its
       height is less; then the corner, the title and the doors still stack inside it instead of overlapping. */
    const width = "max(min(230px, calc(var(--lobby-window-h) * 0.5)), calc(var(--lobby-scene-w) * 0.2))";
    const height = `${width} * 617 / 900`;
    /* The title: its foot aimed at 0.4 of the scene below a one-line corner (44px), never nearer the corner than 16px. */
    expect(TITLE_MARGIN_TOP).toBe(`max(16px, calc(var(--lobby-scene-h) * 0.4 - ${height} - 44px))`);
    /* The doors: their centre aimed at 0.7 of the scene below the title's foot, clamped half a row plus 20px inside the
       hero window (P3-ACCT), never nearer the title than 12px. A margin, so a taller title, corner or row moves them --
       and the tables -- down. */
    const foot = `max(calc(var(--lobby-scene-h) * 0.4), calc(60px + ${height}))`;
    expect(ACTIONS_MARGIN_TOP).toBe(`max(12px, min(calc(var(--lobby-scene-h) * 0.7 - 23px - ${foot}), calc(var(--lobby-hero-window) - 66px - ${foot})))`);
    expect(LOBBY).toContain("const TITLE_FOOT_OF_SCENE = 0.4;");
    expect(LOBBY).toContain("const DOORS_CENTRE_OF_SCENE = 0.7;");
  });

  it("rendered: the doors and the title are flow content of the top region, which has a floor and no ceiling", () => {
    installSessionPort(readySessionPort());
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
      const top = container.querySelector('[data-testid="lobby-top"]') as HTMLElement;
      const actions = container.querySelector('[data-testid="lobby-actions"]') as HTMLElement;
      expect(top.style.minHeight).toBe("var(--lobby-hero-window)");
      expect(top.style.height).toBe("");
      expect(actions.style.position).toBe("");
      expect(actions.style.top).toBe("");
      expect(actions.style.transform).toBe("");
      /* jsdom cannot hold a `max()` length, so the margin is read from the constant that writes it (above). */
      const title = top.querySelector("h1")!.parentElement as HTMLElement;
      expect(title.style.position).toBe("");
      expect(title.style.bottom).toBe("");
    } finally {
      act(() => root.unmount());
      container.remove();
      installSessionPort(null);
    }
  });
});
