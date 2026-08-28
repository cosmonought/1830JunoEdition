/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 873 (harness): THE HEX WAS ALREADY CHOSEN
// ==================================================================
//
// ASKED: "When a player indicates that they want to use the CSL or DH Lay Track power, why don't we have the
// tileselector radial menu automatically pop up on the designated hex? Forcing them to click Yes on the
// modal, then click on the hex, feels like it has an unnecessary step."
//
// THE SAME OBSERVATION AS #866 WITH ONE DIFFERENCE THAT MATTERS. There the click carried no information and
// was removed outright; here the PICKER still has to open, because which tile to lay is a real choice. What
// carries nothing is the gesture that opens it -- the veil has already reduced the board to one lit hex.
import { readSource, stripComments } from "./sourceScan";

export {};

const APP = stripComments(readSource("App.tsx"));
const BOARD = stripComments(readSource("components/HexGridRenderer.tsx"));

describe("selecting a hex is separable from clicking one", () => {
  it("splits the pointer arithmetic from what a selection means", () => {
    /* THE EXTRACTION, and the line it is drawn on: the handler works out WHICH hex from a pointer, and
       `selectHex` works out what selecting a hex MEANS. Two copies of the eligibility gates and the query
       lifecycle would be two chances to answer one question differently. */
    expect(BOARD).toContain("const selectHex = useCallback(");
    const at = BOARD.indexOf("const handlePointerUp = useCallback(");
    expect(at).toBeGreaterThan(-1);
    const handler = BOARD.slice(at, at + 2000);
    expect(handler).toContain("pixelToAxial(contentX, contentY, hexSize)");
    expect(handler).toContain("selectHex({");
    // The gates and the query left the pointer handler entirely.
    expect(handler).not.toContain("onHexClickQuery?.(");
    expect(handler).not.toContain("evaluateHexForTileLaying");
  });

  it("reports no city when there was no pointer", () => {
    /* `cityIndex` answers "which city was hit", and nothing was hit. `null` is what that field means when
       the geometry cannot say (#453) -- a guessed `0` would be a confident wrong answer on an OO hex. */
    const at = BOARD.indexOf("if (!autoSelectHex) {");
    expect(at).toBeGreaterThan(-1);
    const effect = BOARD.slice(at, at + 1200);
    expect(effect).toContain("cityIndexAtPoint2: null");
  });

  it("gives the shell a real screen point to hang its status on", () => {
    /* App positions the query's toast from `clientX` (`hexClickQuery.clientX + 16`), so a synthesized zero
       would park it in the corner. The hex's own centre on screen is where the player is looking, and it is
       the point a click in the middle of that hex would have produced. */
    const at = BOARD.indexOf("if (!autoSelectHex) {");
    const effect = BOARD.slice(at, at + 1200);
    expect(effect).toContain("left + centre.x * view.zoom + view.panX");
    expect(effect).toContain("top + centre.y * view.zoom + view.panY");
  });
});

describe("the request is a one-shot, not a standing question", () => {
  it("is keyed on a token so the same hex can be armed twice", () => {
    /* THE CASE A COORDINATE KEY LOSES: cancel the C&SL's lay, then ask for it again. Same hex, so a
       coordinate-keyed effect compares equal and the picker never reopens. */
    expect(APP).toContain("autoSelectTokenRef.current += 1;");
    expect(BOARD).toContain("if (lastAutoSelectRef.current === autoSelectHex.token) return;");
  });

  it("does not re-fire on a pan, unlike the station anchor", () => {
    /* THE DIFFERENCE FROM #866, and the reason these two look alike but are not. `autoStageStation` is
       re-answered on every view change so the confirmation ring follows the board; this one ISSUES A QUERY,
       so the same treatment would be one request per frame of a drag. */
    const at = BOARD.indexOf("if (!autoSelectHex) {");
    const effect = BOARD.slice(at, BOARD.indexOf("const handlePointerUp", at));
    expect(effect).toContain("lastAutoSelectRef.current = autoSelectHex.token;");
    const stage = BOARD.indexOf("if (!autoStageStation || !onAutoStageStation) return;");
    expect(stage).toBeGreaterThan(-1);
    expect(BOARD.slice(stage, stage + 900)).not.toContain("lastAutoSelectRef");
  });
});

describe("the errand survives, and so does the prompt's gate", () => {
  it("arms the errand as well as opening the picker", () => {
    /* THE ERRAND IS NOT REPLACED. It lifts the connectivity gate (#725), feeds the cancel banner (#817) and
       tells `errandClickIntent` what a click elsewhere means. Opening the picker is an addition. */
    const at = APP.indexOf("const armPrivateHexErrand");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, at + 2200);
    expect(body).toContain("setHomeStationPlacement({");
    expect(body).toContain("setAutoSelectHex({");
  });

  it("leaves the station errand alone", () => {
    /* A `private-station` errand opens no picker at all -- #866 stages its token directly. Auto-selecting
       its hex would open a TILE picker over a token confirmation, which is #850's reported bug rebuilt. */
    const at = APP.indexOf("const armPrivateHexErrand");
    const body = APP.slice(at, at + 2200);
    expect(body).toContain('if (abilityKey !== "dh-token")');
  });

  it("makes the errand ref true within the arming commit (design note #873a)", () => {
    /* THE BUG THIS FORECLOSES, and it is not hypothetical: the board's auto-select is a CHILD effect, so it
       calls back into `handleHexClickQuery` before App's own effect has mirrored the errand.
       `privatePowerOfferAt` reads that ref to decide whether the marked hex raises the power prompt -- with a
       stale `null` it raises it, so pressing "Lay Track on F16" would close the modal and immediately reopen
       it instead of opening the picker. */
    const at = APP.indexOf("const armPrivateHexErrand");
    const body = APP.slice(at, at + 2200);
    expect(body).toContain("privateTileHexKeyRef.current = ");
    /* AND THE EFFECT REMAINS THE AUTHORITY -- #725's argument, which the synchronous write adds to rather
       than replaces: it is still the only thing that CLEARS the ref. */
    expect(APP).toContain("privateTileHexKeyRef.current =\n      homeStationPlacement?.kind === \"private-tile\"");
  });

  it("stops sending the player hex-hunting", () => {
    /* THE OLD LOG LINE said "click F16 on the Rail Map, the only hex left lit" -- a sentence whose own
       wording admits the destination was already decided. */
    expect(APP).not.toContain("the only hex left lit");
    expect(APP).toContain("the tile picker is open on ");
  });
});
