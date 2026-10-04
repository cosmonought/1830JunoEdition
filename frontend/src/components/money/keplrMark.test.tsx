/** @jest-environment jsdom */
// PHASE 3 W2-K (U-15, owner OD-9(b)): Keplr appears with its OFFICIAL logo only. The asset is PENDING (the owner has
// not supplied it), so the slot renders nothing and the surfaces keep plain-text "Keplr"; when the official file is
// added it is shown unmodified, decorative beside text that already names the action, at its own aspect ratio.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KEPLR_OFFICIAL_LOGO, KeplrMark } from "./KeplrMark";

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
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("W2-K: the Keplr mark slot", () => {
  it("ASSET PENDING: no official logo in the tree, so nothing is drawn in its place", () => {
    /* Flip this pin when the owner supplies the official asset (see KeplrMark.tsx). */
    expect(KEPLR_OFFICIAL_LOGO).toBeNull();
    act(() => root.render(<KeplrMark />));
    expect(container.innerHTML).toBe("");
  });

  it("shows a supplied asset as given: decorative, scaled to the text at its own ratio", () => {
    act(() => root.render(<KeplrMark asset={{ src: "/static/media/official.svg", width: 120, height: 40 }} size={15} />));
    const img = container.querySelector('[data-testid="keplr-mark"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("/static/media/official.svg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["45", "15"]);
  });
});
