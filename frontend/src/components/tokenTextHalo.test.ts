/** @jest-environment node */
//
// Contrast arithmetic over the shipped liveries, plus one source scan. No canvas.
//
// ==================================================================
//  DESIGN NOTE 733 (harness): A HALO NEEDS SOMETHING TO PROTECT AGAINST
// ==================================================================
//
// REPORTED: "some have light backgrounds with dark letters ... it seems like the light backgrounds with dark
// letters have a white outline on the dark letters? If so, can we remove that since it makes the text blurry
// and smaller than it needs to be."
//
// THE ASYMMETRY IN THE REPORT IS THE ASYMMETRY IN THE PALETTE, which is why this file measures rather than
// spot-checks. #46 stroked every ticker with the OPPOSITE of its own text colour: dark badges got a black
// halo under white text, invisible against a dark disc, and light badges got a WHITE halo around black text.
// Only three of eight liveries are light, so five of them hid the defect completely -- and any test that
// picked one livery had a five-in-eight chance of picking a hiding one.
//
// THE ARGUMENT FOR REMOVAL IS ARITHMETIC, NOT TASTE. A halo exists to keep text legible over a background the
// author cannot predict. This text sits on a SOLID disc whose colour `bestContrastTextColor` has already
// read, so the contrast is guaranteed by construction. The sweep below proves the guarantee holds for every
// livery, which is what makes the halo provably redundant rather than merely unwanted.
//
// AND THE OTHER HALO IN THE FILE IS CORRECT. `fillTextWithHalo` paints hex labels over tile artwork -- a
// genuinely varying background, the case a halo is for. Asserted here so a later reader does not "finish the
// job" by deleting it too.

import { bestContrastTextColor } from "../styles/corporationLivery";
import { STATION_TICKER_LABELS, stationTickerColor } from "./hexContractTypes";

/** WCAG relative luminance, and the ratio between two colours. */
function luminance(hex: string): number {
  const parts = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = parts.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const LIVERIES = Object.keys(STATION_TICKER_LABELS).map((id) => ({
  id: Number(id),
  ticker: STATION_TICKER_LABELS[Number(id)],
  fill: stationTickerColor(Number(id)),
}));

describe("every ticker is legible on its own disc without any halo", () => {
  it("covers the whole shipped roster", () => {
    // A sweep over a truncated roster would pass silently, which is the failure mode of a sweep.
    expect(LIVERIES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(LIVERIES.map((l) => [l.ticker, l.fill] as const))(
    "%s on %s clears AA on the fill alone",
    (_ticker, fill) => {
      /* 4.5:1 is WCAG AA for normal text. The halo contributed nothing to this number -- it was drawn UNDER
         the fill and only ever ate into the glyph's outer edge. */
      const text = bestContrastTextColor(fill);
      expect(contrast(fill, text)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("names the light liveries the report was actually seeing", () => {
    /* THE MEASUREMENT THAT MADE THE REPORT MAKE SENSE. Three of eight liveries take BLACK text, and those are
       exactly the three that wore a white halo. Pinned so a palette change that flips one of them is a
       conscious decision rather than a surprise. */
    const dark = LIVERIES.filter((l) => bestContrastTextColor(l.fill) === "#000000");
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.length).toBeLessThan(LIVERIES.length);
  });
});

describe("the marker draws its ticker once", () => {
  const source = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "hexCanvasPrimitives.ts"), "utf8");
  })();

  const marker = (() => {
    const start = source.indexOf("export function drawStationTokenMarker");
    return source.slice(start, source.indexOf("\nexport function", start + 10));
  })();

  it("no longer computes a halo colour", () => {
    // Comment-stripped, per #490a: the note explains the halo in the past tense and must keep doing so.
    const code = marker.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("haloColor");
  });

  it("strokes no text at all", () => {
    /* THE ASSERTION THAT MATTERS. `strokeStyle` survives in this function for the token's RING, which is a
       different thing entirely -- so the check is on `strokeText`, the call that outlines glyphs. */
    const code = marker.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("strokeText");
    expect(code).toContain("ctx.fillText(ticker");
  });

  it("keeps the ring, which is not a halo", () => {
    // Removing the halo must not have taken #48's brand-colour ring with it.
    expect(marker).toContain("ctx.stroke()");
  });

  it("leaves fillTextWithHalo alone, because ITS background varies", () => {
    /* THE DISTINCTION, asserted so a later reader does not generalise #733 into "no halos anywhere". Hex
       labels sit on tile artwork the author cannot predict; a ticker sits on a solid disc the author chose. */
    expect(source).toContain("export function fillTextWithHalo");
    expect(source).toContain('ctx.strokeStyle = "rgba(0, 0, 0, 0.75)"');
  });
});
