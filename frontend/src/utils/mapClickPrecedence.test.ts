// frontend/src/utils/mapClickPrecedence.test.ts
//
// Phase 3 W1-F (AUD-01.05 A-21, AUD-05.02 A-7, P3-N012): a home-station click opens only the station ring; a refused
// station click says why where the player is looking; the hex click indicator sits under the pointer at every
// uiScale.

import { HEX_INDICATOR_OFFSET_PX, hexIndicatorPosition } from "../styles/appStyles";
import { UI_SCALE_DESIGN, UI_SCALE_DEFAULT } from "./uiScale";
import { readShell, readSource, sliceBetween, stripComments } from "./sourceScan";

const APP = readShell();
const BOARD = stripComments(readSource("components/HexGridRenderer.tsx"));

/** Where a `position: fixed` box inside the root carrying `zoom: scale` lands on screen: its lengths are multiplied
 *  by the zoom (the board pane cancels the zoom, so the pointer's coordinates are already screen pixels). */
const onScreen = (cssPx: number, scale: number) => cssPx * scale;

describe("W1-F (A-21): the hex indicator sits under the pointer at every scale", () => {
  const SCALES = [UI_SCALE_DESIGN, UI_SCALE_DEFAULT, 1.5];
  const POINTERS: Array<[number, number]> = [
    [0, 0],
    [412, 287],
    [1600, 900],
    [2559, 1439],
  ];

  it("lands within 2 px of the pointer (plus the fixed offset) at 63%, 100% and 150%", () => {
    expect(UI_SCALE_DESIGN).toBe(0.63);
    for (const scale of SCALES) {
      for (const [x, y] of POINTERS) {
        const { left, top } = hexIndicatorPosition(x, y, scale);
        expect(Math.abs(onScreen(left, scale) - (x + HEX_INDICATOR_OFFSET_PX))).toBeLessThanOrEqual(2);
        expect(Math.abs(onScreen(top, scale) - (y + HEX_INDICATOR_OFFSET_PX))).toBeLessThanOrEqual(2);
      }
    }
  });

  it("the old `clientX + 16` was right only at 100% -- the regression this replaces", () => {
    const [x, y] = [1600, 900];
    expect(Math.abs(onScreen(x + 16, 1) - (x + 16))).toBe(0);
    expect(Math.abs(onScreen(x + 16, 0.63) - (x + 16))).toBeGreaterThan(2);
    expect(Math.abs(onScreen(y + 16, 1.5) - (y + 16))).toBeGreaterThan(2);
  });

  it("an unreadable scale is read as 1 rather than producing NaN or Infinity", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hexIndicatorPosition(100, 50, bad)).toEqual({ left: 116, top: 66 });
    }
  });

  it("every indicator in the shell is placed through the helper with the live scale", () => {
    expect(APP).not.toContain("hexClickQuery.clientX + 16");
    expect(APP).not.toContain("hexClickQuery.clientY + 16");
    expect(APP.split("...hexIndicatorPosition(hexClickQuery.clientX, hexClickQuery.clientY, uiScale)").length - 1).toBe(3);
    // The premise: the indicators are inside the zoomed root, and the board pane cancels that zoom.
    expect(APP).toContain("...chromeZoomFor(uiScale),");
    expect(APP).toContain("<div style={{ ...styles.boardPane, zoom: 1 / uiScale }} ref={setBoardEl}>");
  });
});

describe("W1-F (A-7): a home-station errand's click never also opens the tile ring", () => {
  const MOUNT = sliceBetween(APP, "<HexGridRenderer", "cursorMode={");
  const HOME_ERRAND = '(homeStationPlacement !== null && homeStationPlacement.kind !== "private-tile") ||';

  it("withholds gameId and protocolId while a station errand is armed (render time)", () => {
    const gameIdProp = sliceBetween(MOUNT, "gameId={", ": gameId");
    const protocolIdProp = sliceBetween(MOUNT, "protocolId={", ": actingProtocolId");
    expect(gameIdProp).toContain(HOME_ERRAND);
    expect(protocolIdProp).toContain(HOME_ERRAND);
    // The query client already was (#440/#444); all three now agree, so no route to the picker survives.
    expect(sliceBetween(MOUNT, "queryClient={", ": queryClient")).toContain("homeStationPlacement.kind !== \"private-tile\"");
    // No ref was introduced for the gate: it is the render's own state.
    expect(MOUNT).not.toMatch(/homeStationPlacementRef|homeErrandRef/);
  });

  it("the renderer stops before the picker exactly when either prop is missing, after reporting the click", () => {
    const report = BOARD.indexOf("onHexClick?.({");
    const stop = BOARD.indexOf("if (gameId === undefined || protocolId === undefined) {");
    const picker = BOARD.indexOf("GetLegalTilePlacements: { game_id: gameId, protocol_id: protocolId, q, r }");
    expect(report).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(report); // the station handler still hears the click
    expect(picker).toBeGreaterThan(stop); // and the chain query sits behind the stop
    const offline = BOARD.indexOf('status: "offline"');
    expect(offline).toBeGreaterThan(stop); // and so does the sandbox's offline catalog path
  });

  it("the tile errand keeps its picker", () => {
    expect(HOME_ERRAND).toContain('kind !== "private-tile"');
  });
});

describe("W1-F (P3-N012): a refused station click explains itself on the map", () => {
  const HANDLER = sliceBetween(APP, "const handleTokenHexClick = useCallback(", "const handleConfirmTokenPlacement");

  it("writes the evaluator's reason through the general action toast, not the Routes-only slot", () => {
    expect(HANDLER).toContain("if (!placement.allowed) {\n        showActionToast(\n          placement.reason ??");
    expect(HANDLER).not.toContain("setRouteFeedback(");
    expect(HANDLER).toContain("[mapGrid, activeStationCompany, gameState, showActionToast]");
  });

  it("the sentence is still the evaluator's own", () => {
    expect(HANDLER).toContain("evaluateStationPlacement({");
  });

  it("leaves the stationVeil chooser seam exactly as pinned", () => {
    expect(APP).toContain("tokenTargetMode\n                            ? handleTokenHexClick");
  });
});
