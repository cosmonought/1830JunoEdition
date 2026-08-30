/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 888 (harness): THE WIRING, WHERE THE ARITHMETIC IS ELSEWHERE
// ==================================================================
//
// REPORTED: "The 'Lay 1 Track' button in the Lay Track subphase of the Operating Round currently
// auto-scrolls to the rail map, which when players are at the top of the screen is trivially true so it
// remains grayed out/disabled unless they are scrolled all the way down to the corporation and player
// subpanels. Would it make more sense for this button to auto-scroll them to their network on the map?"
//
// THE POSE ITSELF IS TESTED BY CALLING IT -- `frameHexes.test.ts` asks the arithmetic thirteen questions,
// none of which a source scan could have asked. What is left for this file is the part that is genuinely
// about WIRING: which predicate gates the button, that the press does both halves, that the request is a
// one-shot token, and that the way back still exists.
//
// THE LAST ONE IS THE ONE WORTH HAVING. A button that zooms the player's camera is only acceptable because
// `handleFitToScreen` is on screen and idempotent; if that control were ever removed, this change would
// strand a player inside a pose with no way out, and nothing else in the suite would notice.

import { readSource, stripComments } from "../utils/sourceScan";

/* Design note #1014: `BAR`, `APP`, `BOARD` and `sliceBetween` are GONE. They were left behind by an earlier
   pass that deleted the cases reading them -- unused before this batch and flagged only when the linter was
   pointed at this file again. The one describe here builds its own `RENDERER`. */

/* ==================================================================
    DESIGN NOTE 987: EVERYTHING ABOUT THE FRAMING IS GONE FROM THIS FILE
   ==================================================================
   RULED: "the map is auto-zooming and panning into empty space. This is a desktop-first game. Strip out the
   map auto-zoom functionality completely" -- and, of the button that raised it, "its attempt to center on the
   home station is broken (it scrolls to the top of the page)."
   WHAT THESE BLOCKS TESTED: that the button gated on having somewhere to frame rather than on pane
   visibility (#888); that the shell asked `chooseFrameKeys` rather than picking a set inline; that the
   request was a one-shot token; that the board acted on a changed token only; that the pose was clamped like
   a drag; that Fit to Screen could undo it; and that the frame kept the player's own zoom (#911).
   ALL OF IT DESCRIBED A FEATURE THAT NO LONGER EXISTS, so all of it goes. A suite that stays green over
   deleted behaviour is worse than no suite: it reads as a commitment, and the next person to want a camera
   move will find seven passing cases telling them one is already there.
   WHAT SURVIVES IS BELOW, and it is a different thing wearing a similar name. #927's `rememberedCamera`
   carries the PLAYER'S OWN pose across a remount so a round change does not throw away their zoom. It
   initiates nothing. It is the one piece of camera state this batch deliberately keeps, and separating it
   from the framing is the reason this file was not simply deleted. */

describe("the camera survives the round change (design note #1014, superseding #927)", () => {
  /* ==================================================================
      #927's BUG IS GONE BECAUSE ITS SUBJECT IS GONE
     ==================================================================
     REPORTED THREE TIMES: "the start of OR 3.1 triggered an extreme zoom-out ... find the unguarded
     `fitBounds` or zoom trigger in the round transition logic and strip it."

     THERE WAS NO SUCH TRIGGER, and that diagnosis still stands and is still worth keeping. `HexGridRenderer`
     is rendered conditionally on `activeMainTab === "map"` and #213 switches the tab on every round
     transition, so the board is UNMOUNTED and REMOUNTED across SR -> OR. A remount restores `useState`'s
     initial values, `detailedView` went back to `false`, and the camera snapped to the fit. The zoom-out was
     the default pose reasserting itself rather than a call anybody made -- which is exactly why grepping for
     a zoom call found nothing, twice.

     #927 ANSWERED IT BY REMEMBERING THE POSE. #1014 answers it by removing the pose: with the camera locked
     there is only one, every mount computes the same `fitView` from the same bounds, and a remount is
     therefore invisible. The reported symptom cannot recur because there is nothing left for it to snap away
     FROM.

     SO THESE CASES NOW ASSERT THE ABSENCE, not the store. Kept rather than deleted because the report is
     three deep and the next reader deserves to find out here that the mechanism was retired deliberately --
     a suite that simply vanished would leave "does the board keep its zoom across a round change" answerable
     only by reading the renderer. */
  const RENDERER = stripComments(readSource("components/HexGridRenderer.tsx"));

  it("no longer remembers a pose, because there is only one", () => {
    expect(RENDERER).not.toContain("rememberedCamera");
  });

  it("has no lock left to restore", () => {
    expect(RENDERER).not.toContain("detailedView");
  });

  it("computes the same fit on every mount", () => {
    /* THE PROPERTY THAT REPLACES THE STORE. `fitView` is derived from the board bounds and the canvas size,
       both of which survive a remount -- so the pose after one is the pose before it, with nothing to carry. */
    expect(RENDERER).toContain("const fitView");
    expect(RENDERER).toContain("setView(fitView);");
  });

  it("syncs unconditionally, so a resize still reaches the camera", () => {
    /* #927's CONTROL, INVERTED. It asserted the sync was GUARDED so an unlocked camera kept the player's pan;
       there is no unlocked camera, so the guard would now be an arm that can never be taken (#788). What the
       control was protecting -- a locked camera still tracking `fitView` on a resize -- is what an
       unconditional sync gives unconditionally. */
    expect(RENDERER).not.toContain("if (detailedView) return;");
  });
});

