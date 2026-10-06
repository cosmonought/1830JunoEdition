/** @jest-environment jsdom */
// PHASE 3 W2-K (U-15, owner OD-9(b)) + PHASE 3 FINAL §16: Keplr appears with its OFFICIAL brand assets only -- the ICON
// on compact wallet controls (`KeplrMark`) and the WORDMARK on larger explanatory surfaces (`KeplrWordmark`). Neither
// file is in the tree yet, so both slots render nothing and the surfaces keep plain-text "Keplr"; when an official file
// is added it is shown unmodified, decorative beside text that already names the action, at its own aspect ratio.

import fs from "fs";
import path from "path";

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KEPLR_OFFICIAL_ICON, KEPLR_OFFICIAL_LOGO, KEPLR_OFFICIAL_WORDMARK, KeplrMark, KeplrWordmark } from "./KeplrMark";

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

describe("W2-K / PHASE 3 FINAL §16: the Keplr icon and wordmark slots", () => {
  it("ASSET PENDING: no official icon and no official wordmark in the tree, so nothing is drawn in their place", () => {
    /* Flip these pins when the owner's official files are added (see KeplrMark.tsx's placement note). */
    expect(KEPLR_OFFICIAL_ICON).toBeNull();
    expect(KEPLR_OFFICIAL_WORDMARK).toBeNull();
    /* W2-K's name for the compact mark is the icon. */
    expect(KEPLR_OFFICIAL_LOGO).toBe(KEPLR_OFFICIAL_ICON);
    act(() =>
      root.render(
        <>
          <KeplrMark />
          <KeplrWordmark />
        </>,
      ),
    );
    expect(container.innerHTML).toBe("");
    /* Never a stand-in: no image file of any kind beside the slots. */
    const here = path.join(__dirname);
    const images = (dir: string): string[] =>
      fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? images(path.join(dir, entry.name)) : /\.(svg|png|jpe?g|webp|gif)$/i.test(entry.name) ? [entry.name] : [])) : [];
    expect(images(here)).toEqual([]);
  });

  it("shows a supplied icon as given: decorative, scaled to the text at its own ratio", () => {
    act(() => root.render(<KeplrMark asset={{ src: "/static/media/official.svg", width: 120, height: 40 }} size={15} />));
    const img = container.querySelector('[data-testid="keplr-mark"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("/static/media/official.svg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["45", "15"]);
  });

  it("shows a supplied wordmark as given, under its own test id, at its default size of 20", () => {
    act(() => root.render(<KeplrWordmark asset={{ src: "/static/media/wordmark.svg", width: 300, height: 60 }} />));
    const img = container.querySelector('[data-testid="keplr-wordmark"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(container.querySelector('[data-testid="keplr-mark"]')).toBeNull();
    expect(img.getAttribute("src")).toBe("/static/media/wordmark.svg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["100", "20"]);
  });
});
