// frontend/src/styles/corporationLivery.test.ts
//
// ==================================================================
//  DESIGN NOTE 428 (harness): ONE TABLE, AND PROOF IT STAYS ONE
// ==================================================================
//
// TD-1 removed three hand-kept copies of the corporation palette. The thing
// worth testing is not that the colours are right today -- a table of
// constants is self-evidently whatever it says. It is that a FOURTH copy
// cannot quietly appear, because that is the failure the previous
// arrangement had and the one a comment could not prevent.
//
// So the central test here reads the source tree and asserts the hex values
// appear in exactly one file. It is unusual for a unit test to grep the
// filesystem, and it is the only mechanism that actually catches the
// regression: a duplicate table typechecks, lints, renders correctly on the
// screen its author is looking at, and drifts silently months later.
//
// The contrast assertions pin design note #408's audit, which until now was
// a paragraph claiming the numbers had been checked by hand. A claim about
// measurements belongs in a test.

import fs from "fs";
import path from "path";

import {
  CORPORATION_LIVERY_COLORS,
  CORPORATION_LIVERY_FALLBACK,
  bestContrastTextColor,
  corporationLiveryColor,
  relativeLuminance,
} from "./corporationLivery";
import {
  STATION_TICKER_COLORS,
  STATION_FALLBACK_TICKER_COLOR,
  stationTickerColor,
} from "../components/hexContractTypes";

const IDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** WCAG contrast ratio between two hex colours. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the palette is one table", () => {
  it("re-exports the very same object through hexContractTypes", () => {
    // Identity, not deep equality: two structurally-equal objects is exactly
    // what three hand-kept mirrors looked like.
    expect(STATION_TICKER_COLORS).toBe(CORPORATION_LIVERY_COLORS);
    expect(STATION_FALLBACK_TICKER_COLOR).toBe(CORPORATION_LIVERY_FALLBACK);
  });

  it("resolves identically through both readers", () => {
    for (const id of [...IDS, 0, 99, -1]) {
      expect(stationTickerColor(id)).toBe(corporationLiveryColor(id));
    }
  });

  it("falls back rather than returning undefined for an unknown company", () => {
    expect(corporationLiveryColor(99)).toBe(CORPORATION_LIVERY_FALLBACK);
  });

  /* ==================================================================
   *  THE GUARD LOOKS FOR A TABLE, NOT FOR A COLOUR
   * ==================================================================
   *
   * The first cut of this test asserted each hex appeared in exactly one
   * file, and it failed -- correctly, and on a false positive worth
   * recording. `#1a1a1a` (NYC's black) also appears in
   * `HexGridRenderer.tsx`, inside an SVG data-URI for the station-token
   * cursor, and three times in `hexBoardData.ts` as the Yellow/Green/Brown
   * tile-tier stroke. Neither has anything to do with the New York Central;
   * `#1a1a1a` is simply a common dark grey.
   *
   * Forbidding a colour outright would therefore have made this test a
   * nuisance that the next person edits away -- which is worse than no
   * guard, because it removes the guard while looking like diligence.
   *
   * What actually distinguishes a MIRROR from a coincidence is CARDINALITY.
   * A duplicated palette carries all eight values; the worst genuine
   * coincidence in this tree carries one. A threshold of three sits far
   * from both, so the test fails loudly on a real duplicate and never on a
   * shared grey. */
  it("carries no second copy of the palette table", () => {
    const root = path.join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(root);

    const palette = Object.values(CORPORATION_LIVERY_COLORS);
    const suspects = files
      .map((file) => {
        const source = fs.readFileSync(file, "utf8");
        return {
          file: path.relative(root, file),
          hits: palette.filter((hex) => source.includes(`"${hex}"`)).length,
        };
      })
      .filter((entry) => entry.hits >= 3)
      .map((entry) => entry.file);

    expect(suspects).toEqual([path.join("styles", "corporationLivery.ts")]);
  });

  it("holds all eight liveries in that one table", () => {
    // Pairs with the guard above: it proves nothing ELSE has three or more,
    // and this proves the canonical file has all eight rather than having
    // been thinned out while the mirrors survived.
    expect(Object.keys(CORPORATION_LIVERY_COLORS).map(Number)).toEqual(IDS);
  });
});

describe("design note #408's contrast audit", () => {
  it("clears WCAG AA (4.5:1) for every corporation", () => {
    for (const id of IDS) {
      const fill = corporationLiveryColor(id);
      expect(contrastRatio(fill, bestContrastTextColor(fill))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("puts the lowest at B&M green, above 5.3:1", () => {
    // #408 records B&M as the floor at 5.35:1. Pinned so a future recolour
    // that lowers the floor has to notice.
    const ratios = IDS.map((id) => {
      const fill = corporationLiveryColor(id);
      return { id, ratio: contrastRatio(fill, bestContrastTextColor(fill)) };
    });
    const lowest = ratios.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
    expect(lowest.id).toBe(8); // B&M
    expect(lowest.ratio).toBeGreaterThan(5.3);
  });

  it("flips the ink to black for exactly C&O, ERIE and NNH", () => {
    // #408: "the helper doing its job on new inputs, and it is asserted per
    // colour rather than trusted." This is that assertion.
    const black = IDS.filter((id) => bestContrastTextColor(corporationLiveryColor(id)) === "#000000");
    expect(black).toEqual([5, 6, 7]);
  });

  it("keeps NYC off pure black", () => {
    // #408: pure black would be indistinguishable from the card borders and
    // the chart's gridlines.
    expect(corporationLiveryColor(2)).not.toBe("#000000");
  });
});

describe("contrast helpers", () => {
  it("returns white on black and black on white", () => {
    expect(bestContrastTextColor("#000000")).toBe("#FFFFFF");
    expect(bestContrastTextColor("#ffffff")).toBe("#000000");
  });

  it("computes the standard sRGB luminance endpoints", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });
});
