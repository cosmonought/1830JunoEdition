/** @jest-environment jsdom */
// W3-H: the static warning marks.
//
//   VF J-6 (OD-14(h) "use static rust/discard icon treatment"): the discard's static mark -- VF-8's blade at a
//          fixed seed, a straight cut against the rust mark's fracture -- built and shown on the train-limit
//          prompt.
//   VF I-10: the rust half of OD-14(h) is `RustMark`, built by the warning-marks pass from `crackPath(41, 3)`
//          (its identity with the generator is pinned in `warningMarks.test.tsx`); recorded here as the pair.
//   VF K-6: "Whoever next edits `crackPath`: rasterise the badge as well as the chip." The badge's identity with
//          the generator is already asserted, so a generator change moves it silently. This is the guard at the
//          badge's real size (~12.6px at uiScale 1.0, K-2): the mark is rasterised and must still read as a
//          BREAK -- a fork that survives, a bend off the straight run, nothing collapsing into one pixel.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DiscardMark, RustMark, discardMarkGeometry, rustMarkPath } from "./WarningMarks";
import { discardCut } from "./trainDiscardFlourish";
import { TrainDiscardPrompt } from "./TrainPurchasePanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ---- path geometry ------------------------------------------------------------------------------------------- */

type Pt = [number, number];
/** The subpaths of an `M x y L x y ...` path (the only commands the marks' fractures and blades use). */
function subpaths(d: string): Pt[][] {
  const out: Pt[][] = [];
  for (const match of Array.from(d.matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g))) {
    const point: Pt = [Number(match[2]), Number(match[3])];
    if (match[1] === "M") out.push([point]);
    else out[out.length - 1].push(point);
  }
  return out;
}
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt) => Math.hypot(v[0], v[1]);
const angle = (v: Pt) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
const turn = (a: Pt, b: Pt) => {
  const d = Math.abs(angle(a) - angle(b)) % 360;
  return d > 180 ? 360 - d : d;
};
function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)));
  return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]));
}

const MARK_BOX = 22; // the marks' viewBox
const FRACTURE_STROKE = 2.2; // RustMark's fracture stroke, in mark units

/** Rasterise polylines at `px` device pixels for the 22-unit box: a pixel is lit when at least 40% of a 5x5
 *  subsample grid lies within half the stroke of a segment. Returns the lit pixel keys. */
function rasterise(lines: Pt[][], px: number): Set<string> {
  const scale = px / MARK_BOX;
  const half = (FRACTURE_STROKE * scale) / 2;
  const lit = new Set<string>();
  for (let y = 0; y < Math.ceil(px); y += 1) {
    for (let x = 0; x < Math.ceil(px); x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 5; sy += 1) {
        for (let sx = 0; sx < 5; sx += 1) {
          const p: Pt = [x + (sx + 0.5) / 5, y + (sy + 0.5) / 5];
          const near = lines.some((line) =>
            line.slice(1).some((b, index) => {
              const a = line[index];
              return distanceToSegment(p, [a[0] * scale, a[1] * scale], [b[0] * scale, b[1] * scale]) <= half;
            }),
          );
          if (near) hits += 1;
        }
      }
      if (hits >= 10) lit.add(`${x},${y}`);
    }
  }
  return lit;
}

interface BreakReading {
  branchPx: number;
  branchOffMainDeg: number;
  bendPx: number;
  maxTurnDeg: number;
  minVertexGapPx: number;
  branchOnlyPixels: number;
  offChordPixels: number;
}

/** What makes the mark read as a break at `px`, measured. */
function readBreak(d: string, px: number): BreakReading {
  const scale = px / MARK_BOX;
  const [main, ...branches] = subpaths(d);
  const branch = branches[0] ?? [];
  const chordA = main[0];
  const chordB = main[main.length - 1];
  const bend = Math.max(0, ...main.slice(1, -1).map((p) => distanceToSegment(p, chordA, chordB)));
  const turns = main.slice(1, -1).map((p, index) => turn(sub(p, main[index]), sub(main[index + 2], p)));
  const gaps = main.slice(1).map((p, index) => len(sub(p, main[index])));
  let branchOffMain = 0;
  if (branch.length >= 2) {
    const root = main.findIndex((p) => p[0] === branch[0][0] && p[1] === branch[0][1]);
    const run = root > 0 && root < main.length - 1 ? sub(main[root + 1], main[root - 1]) : sub(chordB, chordA);
    branchOffMain = turn(sub(branch[1], branch[0]), run);
  }
  const mainPixels = rasterise([main], px);
  const branchPixels = rasterise(branch.length >= 2 ? [branch] : [], px);
  const chordPixels = rasterise([[chordA, chordB]], px);
  const all = rasterise([main, ...branches.filter((b) => b.length >= 2)], px);
  return {
    branchPx: branch.length >= 2 ? len(sub(branch[1], branch[0])) * scale : 0,
    branchOffMainDeg: branchOffMain,
    bendPx: bend * scale,
    maxTurnDeg: Math.max(0, ...turns),
    minVertexGapPx: Math.min(...gaps) * scale,
    branchOnlyPixels: Array.from(branchPixels).filter((key) => !mainPixels.has(key)).length,
    offChordPixels: Array.from(all).filter((key) => !chordPixels.has(key)).length,
  };
}

/** The floors, at the badge's real size. Measured for `crackPath(41, 3)` at 12.6px (W3-H): branch 2.0px at 54
 *  degrees off the run, bend 1.34px, sharpest turn 29 degrees, shortest segment 3.3px, 3 pixels lit by the
 *  fork alone, 11 off the chord. Each floor sits below that with room and above what a straight or collapsed
 *  figure scores (the bite case below). At 8px (uiScale 0.63) the same mark measures branch 1.28px, bend
 *  0.85px, 1 fork-only pixel -- under these floors, which is K-2's open playtest question, not this guard's. */
const BADGE_PX = 12.6;
function expectReadsAsBreak(reading: BreakReading): void {
  expect(reading.branchPx).toBeGreaterThanOrEqual(1.5); // the fork survives as more than a dot
  expect(reading.branchOffMainDeg).toBeGreaterThanOrEqual(35); // and leaves the run, not along it
  expect(reading.bendPx).toBeGreaterThanOrEqual(1.0); // the run bends off its chord by a pixel
  expect(reading.maxTurnDeg).toBeGreaterThanOrEqual(20); // a zig, not a smooth staircase
  expect(reading.minVertexGapPx).toBeGreaterThanOrEqual(1.5); // no vertex collapses into its neighbour
  expect(reading.branchOnlyPixels).toBeGreaterThanOrEqual(1); // the rasterised fork lights its own pixel
  expect(reading.offChordPixels).toBeGreaterThanOrEqual(2); // the rasterised figure is not a straight line
}

describe("VF K-6: the rust mark still reads as a break at the badge's size", () => {
  it("crackPath(41, 3), as the badge draws it, clears every floor at 12.6px", () => {
    expectReadsAsBreak(readBreak(rustMarkPath(), BADGE_PX));
  });

  it("the guard bites: a straight slash, a lost fork and a collapsed zig each fail it", () => {
    const fails = (d: string) => {
      expect(() => expectReadsAsBreak(readBreak(d, BADGE_PX))).toThrow();
    };
    fails("M3 6 L19 16.3"); // a plain diagonal in a box -- a prohibition sign
    fails("M3 6 L8.3 12.2 L13.7 14.2 L19 16.3"); // the fork removed
    fails("M3 6 L11 11.2 L11.3 11.4 L19 16.3 M11 11.2 L11.2 11.6"); // vertices bunched, fork a dot
  });

  it("the mark stays inside its tile: contained by it, never slashed through it", () => {
    for (const line of subpaths(rustMarkPath())) {
      for (const [x, y] of line) {
        expect([x >= 3 && x <= 19, y >= 3 && y <= 19]).toEqual([true, true]);
      }
    }
  });
});

describe("VF J-6: the discard's static mark is VF-8's blade at a fixed seed", () => {
  it("one straight, unbranched blade, edge to edge, at discardCut's position for its seed", () => {
    const { blade } = discardMarkGeometry();
    const lines = subpaths(blade);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(2); // a single segment: no vertex, no fork
    const [[topX, topY], [bottomX, bottomY]] = lines[0];
    expect(topY).toBeLessThan(3); // reaches past the tile's top edge...
    expect(bottomY).toBeGreaterThan(19); // ...and its bottom one
    // Centred on the generator's own answer (x 50% of the 16-unit interior, inset 3 -> 11).
    const { xPercent } = discardCut(110);
    expect((topX + bottomX) / 2).toBeCloseTo(3 + (xPercent / 100) * 16, 0);
  });

  it("the tile is parted at the blade: neither half touches it", () => {
    const { blade, left, right } = discardMarkGeometry();
    const [[a, b]] = subpaths(blade);
    const ends = (d: string) => {
      const nums = Array.from(d.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)).map((m) => [Number(m[1]), Number(m[2])] as Pt);
      return [nums[0], nums[nums.length - 1]];
    };
    for (const point of [...ends(left), ...ends(right)]) {
      expect(distanceToSegment(point, a, b)).toBeGreaterThan(0.8);
    }
  });

  it("and it is distinct from the rust mark in the one property the two vocabularies keep apart", () => {
    const rust = subpaths(rustMarkPath());
    const cut = subpaths(discardMarkGeometry().blade);
    expect(rust.length).toBeGreaterThan(1); // the fracture forks
    expect(rust[0].length).toBeGreaterThan(2); // and bends
    expect(cut.length).toBe(1); // the cut does neither
    expect(cut[0].length).toBe(2);
  });
});

describe("the marks render, and the train-limit prompt carries the discard mark", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("RustMark and DiscardMark are decorative SVGs (the badge or title carries the words)", () => {
    act(() =>
      root.render(
        <>
          <RustMark />
          <DiscardMark />
        </>,
      ),
    );
    const svgs = Array.from(host.querySelectorAll("svg"));
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("the train-limit prompt's title shows the discard mark beside its words", () => {
    act(() =>
      root.render(
        <TrainDiscardPrompt
          due={{
            ticker: "PRR",
            companyId: 1,
            excess: 1,
            limit: 3,
            choices: ["2", "3"],
            presidentLabel: "Alice",
          } as unknown as React.ComponentProps<typeof TrainDiscardPrompt>["due"]}
          viewerIsPresident
          onDiscard={jest.fn()}
        />,
      ),
    );
    const dialog = host.querySelector('[role="alertdialog"][aria-label="Train limit"]');
    expect(dialog).not.toBeNull();
    const title = Array.from(dialog!.querySelectorAll("span")).find((node) =>
      (node.textContent ?? "").includes("Train limit"),
    );
    expect(title).toBeDefined();
    const blade = title!.querySelector("svg path:last-of-type")?.getAttribute("d") ?? null;
    expect(blade).toBe(discardMarkGeometry().blade);
  });
});
