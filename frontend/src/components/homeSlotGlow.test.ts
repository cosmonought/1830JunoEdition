// frontend/src/components/homeSlotGlow.test.ts
//
// ==================================================================
//  DESIGN NOTE 584 (harness): THE RING AND THE BADGE, ONE CIRCLE
// ==================================================================
//
// REPORTED: on New York both city circles glowed during the NNH's home
// placement, when only the top-right one is legal -- and, decisively: "you
// have 'preprinted' NNH's home station reservation marker on the correct
// city/station slot -- can you not check it against that?"
//
// That reframed the fix. The obvious implementation was a new table of home
// city indices per corporation, and it would have been a second statement of
// something `stationMarkerPoint` already decides -- the exact shape of this
// codebase's recurring bug (design notes #559, #576, #580: one fact, two
// places, one updated).
//
// So `homeCityIndexAt` derives the index from the marker's own POINT. These
// tests are about that derivation being robust rather than about any
// particular hex, because the thing that must hold is "the ring lands where
// the badge is", whatever the badge decides.

import { homeCityIndexAt } from "./hexCanvasPrimitives";

describe("homeCityIndexAt", () => {
  const twoNodes = [
    { x: 100, y: 40 }, // top-right, New York's marker 0
    { x: 60, y: 90 }, // bottom-left
  ];

  it("picks the node the marker is drawn on", () => {
    expect(homeCityIndexAt(twoNodes, { x: 100, y: 40 })).toBe(0);
    expect(homeCityIndexAt(twoNodes, { x: 60, y: 90 })).toBe(1);
  });

  it("tolerates the two computations landing a pixel or two apart", () => {
    /* THE REASON IT IS "NEAREST" AND NOT EQUALITY. The marker point comes
       from authored artwork offsets; the node comes from averaging slot
       points. They describe the same circle by different routes, so exact
       agreement is not something either side promises -- and a strict match
       would silently fall through to "glow everything". */
    expect(homeCityIndexAt(twoNodes, { x: 102, y: 38 })).toBe(0);
    expect(homeCityIndexAt(twoNodes, { x: 58, y: 93 })).toBe(1);
  });

  it("answers 0 for a single-city hex whatever the marker says", () => {
    // Baltimore, Cleveland and friends: one circle, offset from centre.
    expect(homeCityIndexAt([{ x: 50, y: 70 }], { x: 50, y: 70 })).toBe(0);
    expect(homeCityIndexAt([{ x: 50, y: 70 }], { x: 0, y: 0 })).toBe(0);
  });

  it("returns null when the hex has no cities, rather than 0", () => {
    /* `0` would be an index into an empty array, and the caller's `??`
       fallback would then light every node -- which is the bug this note is
       about, reintroduced by a sloppy default. `null` means "glow nothing". */
    expect(homeCityIndexAt([], { x: 10, y: 10 })).toBeNull();
  });

  it("is decided by distance, not by array order", () => {
    /* A regression guard with teeth: an implementation that returned 0
       unconditionally passes three of the tests above. Here the marker sits
       on the LAST node. */
    const three = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(homeCityIndexAt(three, { x: 99, y: 1 })).toBe(2);
    expect(homeCityIndexAt(three, { x: 51, y: 1 })).toBe(1);
  });
});

describe("a home reservation on a printed two-station city sits in its first slot (design note #1379)", () => {
  /* #1401: Norfolk (L16), the hex this was written against, and Montreal (A19) are both SINGLE-station
     cities after all -- "a preprinted gray single-station city like Norfolk" -- so no printed hex on any
     board carries a pill now. The #1379 rule (a badge sits in a pill's FIRST slot, not the seam) is pinned
     below as source against `stationMarkerPoint`, and the two hexes are pinned as seating their token in the
     one circle. */
  it("a badge on a multi-slot printed city goes to the first slot, not the anchor (#1379, as source)", () => {
    const { readStripped } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
    const PRIMS = readStripped("components/hexCanvasPrimitives.ts");
    const at = PRIMS.indexOf("export function stationMarkerPoint(");
    const body = PRIMS.slice(at, PRIMS.indexOf("\n}\n", at));
    expect(body).toContain("const slots = printedCitySlotPoints(label, center, size);");
    expect(body).toContain("cityIndex ?? 0");
  });

  it.each(["L16", "A19"])("%s is one station, and the token seats in its circle (design note #1401)", (label) => {
    const { activateBoard, STANDARD_BOARD } = require("./hexBoardData") as typeof import("./hexBoardData");
    const { LPF_BOARD } = require("./hexBoardDataLpf") as typeof import("./hexBoardDataLpf");
    const { stationMarkerPoint } = require("./hexCanvasPrimitives") as typeof import("./hexCanvasPrimitives");
    const { printedCitySlotPoints, printedArtwork } = require("./TileGraphics") as typeof import("./TileGraphics");
    const { axialToPixel } = require("./hexGeometry") as typeof import("./hexGeometry");
    activateBoard(LPF_BOARD);
    try {
      const hex = LPF_BOARD.hexes.find((entry) => entry.label === label)!;
      expect(LPF_BOARD.grayHexes[label].slots ?? 1).toBe(1);
      expect(printedArtwork(label)!.marker!.slots ?? 1).toBe(1);
      const size = 40;
      const center = axialToPixel(hex.q, hex.r, size);
      const slots = printedCitySlotPoints(label, center, size);
      expect(slots.length).toBe(1);
      const anchor = printedArtwork(label)!.marker!.at;
      expect(stationMarkerPoint(hex.q, hex.r, size)).toEqual({ x: center.x + size * anchor.x, y: center.y + size * anchor.y });
    } finally {
      activateBoard(STANDARD_BOARD);
    }
  });
});

describe("the printed two-station city draws its pill (design note #1387)", () => {
  it("routes a multi-slot printed city through drawStationPill with the slot geometry's own size and angle", () => {
    const { readStripped } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
    const PRIMS = readStripped("components/hexCanvasPrimitives.ts");
    const printed = PRIMS.slice(PRIMS.indexOf("export function drawPrintedTrack("), PRIMS.indexOf("export function drawPrintedTrack(") + 1600);
    expect(printed).toContain('else if (art.marker.kind === "city" && (art.marker.slots ?? 1) > 1) {');
    expect(printed).toContain("drawStationPill(ctx, point, markerSize, art.marker.slots ?? 1, art.marker.angle ?? 0, art.marker.layout);");
    expect(printed).toContain("const markerSize = markerSizeFor([art.marker], size);");
  });
});
