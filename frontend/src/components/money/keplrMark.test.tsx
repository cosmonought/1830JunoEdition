/** @jest-environment jsdom */
// PHASE 3 W2-K (U-15, owner OD-9(b)) + PHASE 3 FINAL §16: Keplr appears with its OFFICIAL brand assets only -- the ICON
// on compact wallet controls (`KeplrMark`) and the WORDMARK on larger explanatory surfaces (`KeplrWordmark`). Both are
// Keplr's own brand-kit SVGs in `brand/`, byte for byte (pinned by digest here), shown unmodified, decorative beside text
// that already names the action, at their own aspect ratio.

import crypto from "crypto";
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
  it("the official files are in the tree, unmodified: Keplr's brand-kit icon and logo, and nothing else beside them", () => {
    const brand = path.join(__dirname, "brand");
    const digest = (name: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(brand, name))).digest("hex");
    /* keplr brand kit/SVGs/keplr-icon-radii.svg ("Keplr Original Icon") and keplr-logo-icon.svg ("Keplr Original Logo"). */
    expect(digest("keplr-icon.svg")).toBe("bb89b5f4914314c97b020037ddb3fe311f55809926517b611fc1de1b03a5dbce");
    expect(digest("keplr-wordmark.svg")).toBe("40a4f81686d3807175986458c84269178618b7912bf7cad7c0cb609c93fce950");
    expect(fs.readFileSync(path.join(brand, ".gitattributes"), "utf8")).toMatch(/^\*\.svg -text$/m);
    /* Never a stand-in: no other image file anywhere beside the slots. */
    const images = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? images(path.join(dir, entry.name)) : /\.(svg|png|jpe?g|webp|gif)$/i.test(entry.name) ? [path.relative(__dirname, path.join(dir, entry.name)).split(path.sep).join("/")] : []));
    expect(images(__dirname).sort()).toEqual(["brand/keplr-icon.svg", "brand/keplr-wordmark.svg"]);
    /* Imported, never inlined or redrawn: the component carries no artwork of its own. */
    const source = fs.readFileSync(path.join(__dirname, "KeplrMark.tsx"), "utf8");
    expect(source).toContain('import keplrIcon from "./brand/keplr-icon.svg";');
    expect(source).toContain('import keplrWordmark from "./brand/keplr-wordmark.svg";');
    expect(source).not.toMatch(/<svg|<path|data:image|ASSET PENDING/);
  });

  it("the default icon and wordmark are the official files at their own sizes; the compact mark is the icon", () => {
    expect(KEPLR_OFFICIAL_ICON).toEqual({ src: expect.stringContaining("keplr-icon.svg"), width: 100, height: 101 });
    expect(KEPLR_OFFICIAL_WORDMARK).toEqual({ src: expect.stringContaining("keplr-wordmark.svg"), width: 220, height: 67 });
    expect(KEPLR_OFFICIAL_LOGO).toBe(KEPLR_OFFICIAL_ICON);
    act(() =>
      root.render(
        <>
          <KeplrMark />
          <KeplrWordmark />
        </>,
      ),
    );
    const icon = container.querySelector('[data-testid="keplr-mark"]') as HTMLImageElement;
    const wordmark = container.querySelector('[data-testid="keplr-wordmark"]') as HTMLImageElement;
    expect(icon.getAttribute("src")).toContain("keplr-icon.svg");
    expect([icon.getAttribute("width"), icon.getAttribute("height")]).toEqual(["16", "16"]);
    expect([icon.getAttribute("alt"), icon.getAttribute("aria-hidden")]).toEqual(["", "true"]);
    expect(wordmark.getAttribute("src")).toContain("keplr-wordmark.svg");
    expect([wordmark.getAttribute("width"), wordmark.getAttribute("height")]).toEqual(["66", "20"]);
    expect([wordmark.getAttribute("alt"), wordmark.getAttribute("aria-hidden")]).toEqual(["", "true"]);
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
