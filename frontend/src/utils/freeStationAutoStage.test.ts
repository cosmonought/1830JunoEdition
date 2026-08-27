/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 866 (harness): A PLACEMENT WITH ONE ANSWER
// ==================================================================
//
// REPORTED: "On DH's private power, clicking F16 to place the free station token is still calling up the
// tileselector radial menu. Why don't we just have the station automatically placed there with the green
// checkmark and red x above it, since there's no other placement possible in this private power? The only
// caveat is we need to make sure clicking X returns players to the modal where they click 'Forfeit' for the
// station placement."
//
// THE COLLISION HAD A CAUSE THE GUARD COULD NOT SEE. `onHexClick` and `onHexClickQuery` are both wired, so
// one click reached the station stager AND the tile inspector. #850 guarded exactly this with
// `pendingTokenRef.current !== null` -- but that only fires once a token IS staged, and on the first click
// there is nothing staged to see. The guard was correct and was looking one moment too late.
//
// SO THE ARITHMETIC IS TESTED, NOT THE PIXELS. `stationSlotAnchor` is pure and can be checked against the
// transform it claims to apply; the wiring is a source scan, in this file's usual shape.

import { stationSlotAnchor, soleCityIndex } from "./stationTokens";
import type { MapGridResponse } from "../components/hexContractTypes";

const read = (rel: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
};
const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** F16 -- Scranton, per `hexBoardData`. A bare grid, so the hex has its preprinted geometry only. */
const F16 = { q: 5, r: 5 };
const BARE: MapGridResponse = { game_id: 1, tiles: [] };

describe("the anchor a free station is staged on", () => {
  it("moves with the board's pan", () => {
    /* THE REASON THE REQUEST IS STATE RATHER THAN A ONE-SHOT. The anchor is board-relative pixels, so a pan
       while the confirmation is open changes it -- and a ring resolved once would sit over empty board. */
    const still = stationSlotAnchor({
      mapGrid: BARE, publicCompanies: [], q: F16.q, r: F16.r,
      cityIndex: 0, hexSize: 40, zoom: 1, panX: 0, panY: 0,
    });
    const panned = stationSlotAnchor({
      mapGrid: BARE, publicCompanies: [], q: F16.q, r: F16.r,
      cityIndex: 0, hexSize: 40, zoom: 1, panX: 120, panY: -35,
    });
    expect(panned.nodeX).toBeCloseTo(still.nodeX + 120);
    expect(panned.nodeY).toBeCloseTo(still.nodeY - 35);
  });

  it("scales with the board's zoom", () => {
    const one = stationSlotAnchor({
      mapGrid: BARE, publicCompanies: [], q: F16.q, r: F16.r,
      cityIndex: 0, hexSize: 40, zoom: 1, panX: 0, panY: 0,
    });
    const two = stationSlotAnchor({
      mapGrid: BARE, publicCompanies: [], q: F16.q, r: F16.r,
      cityIndex: 0, hexSize: 40, zoom: 2, panX: 0, panY: 0,
    });
    /* NOT A TAUTOLOGY: the point is computed in content space and transformed, so doubling the zoom doubles
       the offset only if the transform is applied to the RESOLVED node rather than to the hex centre. */
    expect(two.nodeX).toBeCloseTo(one.nodeX * 2);
    expect(two.nodeY).toBeCloseTo(one.nodeY * 2);
  });

  it("is a real point, not the origin", () => {
    // Guards every assertion above: 0 * 2 === 0 and 0 + 120 === 120 would both pass on a degenerate anchor.
    const at = stationSlotAnchor({
      mapGrid: BARE, publicCompanies: [], q: F16.q, r: F16.r,
      cityIndex: 0, hexSize: 40, zoom: 1, panX: 0, panY: 0,
    });
    expect(Math.abs(at.nodeX) + Math.abs(at.nodeY)).toBeGreaterThan(0);
  });
});

describe("auto-staging refuses where the choice is real", () => {
  it("names F16's single city", () => {
    /* THE PREMISE OF THE WHOLE CHANGE, asserted rather than assumed: "there's no other placement possible in
       this private power" is only true while F16 has one city. */
    expect(soleCityIndex(BARE, F16.q, F16.r, 40)).toBe(0);
  });

  it("returns null for a hex with two cities", () => {
    /* #858'S LESSON POINTED FORWARDS. A two-city hex is a genuine question and auto-staging one of the pair
       would be that report's bug with no click to blame. G19 -- New York -- carries two once its hub tile is
       laid, which is the case that has to answer `null`. */
    const twoCity: MapGridResponse = {
      game_id: 1,
      tiles: [{ q: 6, r: 6, tile_id: 54, orientation: 0, era: "Green", landmark: null }],
    } as unknown as MapGridResponse;
    expect(soleCityIndex(twoCity, 6, 6, 40)).toBeNull();
  });
});

describe("the click is gone and the modal knows it", () => {
  const APP = strip(read("App.tsx"));
  const BOARD = strip(read("components/HexGridRenderer.tsx"));

  it("stages the station instead of sending the player to click it", () => {
    /* THE LINE THAT CHANGED. It read `armPrivateHexErrand(DH_PRIVATE_ID, "dh-token", ...)` inside
       `handlePowerFlowAct`, which lit F16 and waited for a pointer. */
    const at = APP.indexOf("const handlePowerFlowAct");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf("const handlePowerFlowDecline", at));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("setAutoStageStation({ q: hex.q, r: hex.r })");
    expect(body).not.toContain('armPrivateHexErrand(DH_PRIVATE_ID, "dh-token"');
  });

  it("keeps the click errand as the two-city fallback", () => {
    /* NOT DELETED. The previous test asserts the flow no longer arms it; this asserts the shell still can,
       so `soleCityIndex` returning null has somewhere to go. */
    const at = APP.indexOf("const handleAutoStageStation");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, at + 1800);
    expect(body).toContain("if (info.cityIndex === null)");
    expect(body).toContain('armPrivateHexErrand(DH_PRIVATE_ID, "dh-token"');
  });

  it("hides the flow modal while a placement is waiting for an answer", () => {
    /* #850's RULE ONE LAYER UP. The modal is a standing obligation, so without this it would render over the
       confirmation it just produced. */
    expect(APP).toContain("pendingToken === null &&");
  });

  it("clears the standing request at every exit, named one by one", () => {
    /* A BARE COUNT WAS THE FIRST DRAFT AND IT WAS WRONG -- it said three and the answer is four, because the
       two-city fallback also has to stop the board re-answering before it hands over to the click errand.
       Kept as a note because the count would have been the weaker assertion either way: four calls in the
       wrong four places would satisfy it.
       THE REQUEST IS ANSWERED ON EVERY VIEW CHANGE, so any path that ends a placement and leaves it set
       re-stages the token on the next frame. The X is the one that was asked about by name -- "we need to
       make sure clicking X returns players to the modal" -- and it is the one that would look broken. */
    const inside = (start: string, end: string) => {
      const at = APP.indexOf(start);
      expect(at).toBeGreaterThan(-1);
      const stop = APP.indexOf(end, at);
      expect(stop).toBeGreaterThan(at);
      return APP.slice(at, stop);
    };
    // The X.
    expect(inside("const handleCancelTokenPlacement", "}, [])")).toContain(
      "setAutoStageStation(null)",
    );
    // The green tick.
    expect(inside("const handleConfirmTokenPlacement", "commitFreeStationPlacement")).toContain(
      "setAutoStageStation(null)",
    );
    // Forfeit Free Placement.
    expect(inside("const handlePowerFlowDecline", "}, [])")).toContain(
      "setAutoStageStation(null)",
    );
    // And the hand-off to the click errand, so the board stops answering a question the player now owns.
    expect(inside("const handleAutoStageStation", "setPendingToken({")).toContain(
      "setAutoStageStation(null)",
    );
  });

  it("resolves the anchor through one function, not two copies", () => {
    /* The click path and the auto path must land on the same pixel. Two copies of the fallback chain is the
       failure this codebase keeps finding (#686, #852, #862). */
    expect(BOARD).toContain("stationSlotAnchor({");
    expect((BOARD.match(/stationSlotAnchor\(\{/g) ?? []).length).toBe(2);
    expect(BOARD).not.toContain("nextCitySlotPoint(");
  });
});
