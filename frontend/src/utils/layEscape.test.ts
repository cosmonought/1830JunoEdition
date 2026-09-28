/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 874 (harness): AN EXIT NOBODY CAN FIND IS NOT AN EXIT
// ==================================================================
//
// REPORTED: "For CSL and DH, once a player selects the Lay Track power, there is no 'escape.' Selecting the
// red X on the tileselector preview tile does not escape the private power. ... a red X on that menu would
// need to either cancel the Private Power action or return them to the modal (which also needs a way to
// escape/cancel its use if a player hasn't used any of its powers)."
//
// THIS IS THE THIRD TIME THIS SHAPE HAS BEEN REPORTED and the fix has moved closer to the player each time.
// #817 gave the errand a cancel and put it on the action bar. #849 found the same fault one report later --
// "There was a cancel on the action bar (#817) and the player was looking at the map; the modal's X is where
// they are" -- and moved it to the modal. Now the player is looking at the RING.
//
// SO THE RULE IS "THE X GOES BACK ONE STEP", at all three levels, rather than a third special case.
import { readSource, stripComments, readShell, sliceBetween, sliceFrom } from "./sourceScan";

export {};

const APP = readShell();
const RING = stripComments(readSource("components/RadialTileSelector.tsx"));
const FLOW = stripComments(readSource("privatePowerFlow.ts".replace(/^/, "utils/")));

describe("the X goes back one step", () => {
  it("shows at the candidate stage only when there is somewhere to go back to", () => {
    /* STILL ABSENT FOR AN ORDINARY LAY, which is #471's rule kept: there the X would duplicate click-away
       and there is no power to abandon. */
    expect(RING).toContain("showCancel={previewing || canEscape}");
    expect(RING).toContain("const canEscape = onEscape !== null;");
  });

  it("keeps the preview X meaning discard, not escape", () => {
    /* #2's meaning, unchanged. From a preview, "back" is the candidate ring -- the player is choosing WHICH
       tile, and taking them out of the power entirely would answer a question they did not ask. */
    expect(RING).toContain("onCancel={previewing ? onCancel : (onEscape ?? onDismiss)}");
    expect(RING).toContain('"Discard this preview and go back to the tile options."');
  });

  it("names where the escape goes", () => {
    /* A BACK BUTTON THAT DOES NOT NAME ITS DESTINATION is the thing being fixed -- the player pressed an X
       and could not tell what it had done. */
    expect(RING).toContain("escapeTitle ?? \"Close.\"");
    expect(APP).toContain('escapeTitle="Cancel this lay and go back to the power — nothing is spent."');
  });

  it("offers it only for the tile errand", () => {
    /* A `private-station` errand opens no picker at all (#866), and a HOME station is compulsory -- #817:
       "there is nothing to cancel and nowhere else to go". Neither is reachable from this ring. */
    expect(APP).toContain('homeStationPlacement?.kind === "private-tile" ? handleDismissRadial : null');
  });
});

describe("leaving the picker leaves the power", () => {
  it("disarms the errand as well as closing the ring", () => {
    /* THE BUG, IN ONE LINE: the ring and the errand were two states and only one of them closed. */
    const body = sliceBetween(APP, "const handleDismissRadial", "}, []);");
    expect(body).toContain("setRadialSelector(null)");
    expect(body).toContain('current?.kind === "private-tile" ? null : current');
  });

  it("leaves a compulsory home placement alone", () => {
    /* THE GUARD THAT MAKES THE ABOVE SAFE. `setHomeStationPlacement(null)` unconditionally would cancel a
       HOME station errand -- compulsory, with the whole table waiting on it (#783) -- because a player
       dismissed a tile picker that was never part of it. */
    const body = sliceBetween(APP, "const handleDismissRadial", "}, []);");
    expect(body).not.toMatch(/setHomeStationPlacement\(null\)/);
  });

  it("lets the modal come back on its own", () => {
    /* NO RE-RAISING NEEDED, and that is why this is safe rather than clever: arming never cleared
       `privatePowerRequest`, so `activePowerFlow` still derives a flow and the modal's own render condition
       is what was hiding it. */
    /* SCOPED TO THE LAY BRANCH, and the first draft was not -- it sliced the whole callback and caught the
       M&H's `exchange` arm, which clears the request on purpose (#871: the exchange fires and the question is
       over). A whole-function absence would have been an assertion about the wrong branch that happened to
       be red for the right reason. */
    /* From the lay branch to 400 characters past its arming call. `sliceBetween` requires the arming call
       after the branch, in the same file; the window then runs on 400 characters past it, as it always did.
       `allowEmpty` because the call is the branch's first statement (only whitespace between them once the
       note is stripped): `head` is a length, never asserted on -- `lay` is, and it is not empty. */
    const head = sliceBetween(APP, 'if (step === "lay") {', "armPrivateHexErrand(", { allowEmpty: true });
    const lay = sliceFrom(APP, 'if (step === "lay") {', { length: head.length + 400 });
    expect(lay).toContain("armPrivateHexErrand(");
    expect(lay).not.toContain("setPrivatePowerRequest(null)");
    expect(APP).toContain("homeStationPlacement === null &&");
  });
});

describe("the modal is escapable while nothing is spent", () => {
  it("offers its X before either power commits", () => {
    /* THE PARENTHETICAL IN THE REPORT: "which also needs a way to escape/cancel its use if a player hasn't
       used any of its powers". It already did -- `cancellable` is computed, not constant -- and this pins it
       so the new exit below does not become the only one. */
    expect(FLOW).toContain("cancellable: !layDone,");
    expect(FLOW).toContain("cancellable: !layDone && station === \"pending\",");
  });

  it("withdraws it once the tile is down", () => {
    /* #847's rule, and the reason the ring's escape matters: after the lay there IS no way back, so the exit
       has to be reachable BEFORE it -- which is exactly the window the player could not find. */
    expect(FLOW).toContain("cancellable: !layDone");
  });
});
