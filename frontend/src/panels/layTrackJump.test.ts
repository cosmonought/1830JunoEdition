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

import { readSource, sliceBetween, stripComments } from "../utils/sourceScan";

const BAR = stripComments(readSource("panels/ContextualActionBar.tsx"));
const APP = stripComments(readSource("App.tsx"));
const BOARD = stripComments(readSource("components/HexGridRenderer.tsx"));

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

describe("the camera survives the round change (design note #927)", () => {
  /* ==================================================================
      REPORTED THREE TIMES, AND THE FIRST TWO HUNTS LOOKED FOR THE WRONG THING
     ==================================================================
     "The start of OR 3.1 triggered an extreme zoom-out ... find the unguarded `fitBounds` or zoom trigger in
     the round transition logic and strip it."
     THERE IS NO SUCH TRIGGER. `HexGridRenderer` is rendered conditionally on `activeMainTab === "map"`, and
     #213 switches the tab on every round transition -- to the Stock Market for a Stock Round and back for an
     Operating Round. So the board is UNMOUNTED and REMOUNTED across SR -> OR, and a remount restores
     `useState`'s initial values: `detailedView` to `false`, which locks the camera to `fitView`. The zoom-out
     is the default pose reasserting itself, not a call anybody made -- which is exactly why grepping for a
     zoom call found nothing, twice.
     SO THE ASSERTIONS ARE ABOUT THE SEEDS. A remembered pose that the initialisers do not read, or an
     initialiser that reads a constant, is the bug returning. */
  const RENDERER = stripComments(readSource("components/HexGridRenderer.tsx"));

  it("keeps the pose somewhere that outlives one mounting", () => {
    /* Module scope, not a ref: a ref dies with the component instance, which is the thing being unmounted. */
    expect(RENDERER).toContain("const rememberedCamera");
  });

  it("seeds both the view and the lock from it", () => {
    /* BOTH, or the restore is worse than useless: remembering the pan while `detailedView` resets to `false`
       would restore a pan and then have the fit-sync effect overwrite it on the very next commit. */
    expect(RENDERER).toContain("rememberedCamera.view ??");
    expect(RENDERER).toContain("useState(() => rememberedCamera.detailedView)");
  });

  it("writes the pose back on every change", () => {
    /* A store nothing writes to is a store that always reads its initial value -- which would leave this
       whole mechanism looking present and doing nothing. */
    expect(RENDERER).toContain("rememberedCamera.view = view;");
    expect(RENDERER).toContain("rememberedCamera.detailedView = detailedView;");
  });

  it("still lets the locked camera follow the fit", () => {
    /* THE CONTROL. A restore that also pinned `detailedView` true would strand a player who had never zoomed
       at a stale pan; the sync effect must survive, so a locked camera still tracks `fitView` on a resize. */
    expect(RENDERER).toContain("if (detailedView) return;");
    expect(RENDERER).toContain("setView(fitView);");
  });
});

