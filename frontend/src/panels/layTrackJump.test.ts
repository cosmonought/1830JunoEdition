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

describe("the button points at the track, not at the pane", () => {
  it("no longer greys itself on whether a quarter of the pane is visible", () => {
    /* THE REPORTED BUG, AS AN ABSENCE. `mapInView` was the gate and it answered a question about layout.
       Asserted across the whole file rather than inside the button, because the failure mode is somebody
       reinstating it anywhere -- and the binding is gone entirely, so any occurrence is a regression. */
    expect(BAR).not.toContain("mapInView");
  });

  it("gates on having somewhere to frame instead", () => {
    /* BOUNDED AT THE END OF THE ARRAY, not at the first `},`. The first draft used `"},"` and stopped at the
       close of the `onClick` arrow function INSIDE the entry -- so the slice was real, non-empty, and simply
       did not reach the property being asserted. `sliceBetween` throws on a MISSING anchor; it cannot know
       that a present one matched too soon, which is the residual form of this trap and worth naming here.
       BOUNDED AT THE NEXT `case` INSTEAD, which is a landmark outside the entry rather than a punctuation
       mark inside it -- `"];"` worked until a comment block containing one moved in above the property. The
       lesson generalises: an anchor made of punctuation is an anchor that a comment can satisfy. */
    const button = sliceBetween(BAR, 'key: "go-to-map"', 'case "BuyPrivate":');
    expect(button).toContain("disabled: !canFrameNetwork");
    /* #797's RULE, kept: a control pointing at nothing is worse than no control. The reason is in the title
       rather than left to the greying, because "why is this off" is the question a disabled button raises.
       AND THE REASON IS ABOUT MOVEMENT. The first draft said "No hex is open to this corporation right now",
       which `stepJumpButton.test.ts` refused -- a legality answer on a navigation control is the second
       meaning that block exists to keep off this channel, and #716 owns that refusal on the hex itself. */
    expect(button).toContain("Nothing to show on the map yet.");
  });

  it("still travels before it frames", () => {
    /* BOTH HALVES, IN ORDER. A framed camera behind the Stock Market tab helps nobody, so `goToMap` still
       switches tabs and scrolls the page; the frame is what happens on arrival. Asserted as ordering inside
       one bounded slice -- `sliceBetween` throws on a missing anchor, so neither index can be -1 and the
       comparison cannot be vacuous. */
    const click = sliceBetween(BAR, "onClick: () => {", "},");
    const travel = click.indexOf("goToMap()");
    const frame = click.indexOf("onFrameNetwork?.()");
    expect(travel).toBeGreaterThan(-1);
    expect(frame).toBeGreaterThan(travel);
  });
});

describe("the shell chooses what to frame", () => {
  it("asks the shared chooser rather than picking a set inline", () => {
    /* THE ORDER OF PREFERENCE IS A RULE with three branches and a note explaining each, and
       `frameHexes.test.ts` exercises all three. Re-deciding it here would be the two-authorities failure
       this project keeps finding; the shell's job is to supply the three candidate sets. */
    const memo = sliceBetween(APP, "const layTrackFrameKeys = useMemo(", "}, [layTrackFocus");
    expect(memo).toContain("chooseFrameKeys({");
    expect(memo).toContain("buildable: layTrackFocus?.highlighted,");
    expect(memo).toContain("network: layTrackFocus?.network,");
    expect(memo).toContain("stationTokensOf(corporation)");
  });

  it("raises the request as a one-shot token", () => {
    /* #873's SHAPE. A standing request would be re-answered every render, so the board would snap back to
       the framed pose the instant the player panned away from it -- #866's collision, in a camera. */
    const handler = sliceBetween(APP, "const handleFrameNetwork = useCallback(", "}, [layTrackFrameKeys]);");
    expect(handler).toContain("frameTokenRef.current += 1;");
    expect(handler).toContain("token: frameTokenRef.current");
    /* AND IT REFUSES TO FIRE ON AN EMPTY SET, which is the same rule the disabled button states -- belt and
       braces on purpose, because the button is not the only thing that could ever call this. */
    expect(handler).toContain("if (layTrackFrameKeys.length === 0) return;");
  });
});

describe("the board answers it once, and the way back survives", () => {
  it("acts on a changed token and not on a re-render", () => {
    const effect = sliceBetween(BOARD, "const lastFrameTokenRef = useRef", "}, [frameHexRequest");
    expect(effect).toContain("if (lastFrameTokenRef.current === frameHexRequest.token) return;");
  });

  it("clamps the pose the same way a drag is clamped", () => {
    /* WITHOUT THIS, a frame near the board's edge leaves half the canvas empty -- and this would be the one
       camera move in the component that can sit outside its own bounds, which is exactly the kind of
       inconsistency that reads as a rendering fault rather than as a bug. */
    const effect = sliceBetween(BOARD, "const lastFrameTokenRef = useRef", "}, [frameHexRequest");
    expect(effect).toContain("clampPanToBoard(");
    expect(effect).toContain("setDetailedView(true);");
  });

  it("leaves Fit to Screen able to undo it", () => {
    /* THE ASSERTION THIS FILE IS REALLY FOR. Zooming a player's camera on a button press is only acceptable
       because the reverse is one visible, idempotent control away. `handleFitToScreen` re-locks the camera
       AND restores the pose, and it is the removal of either half that would strand somebody. */
    const fit = sliceBetween(BOARD, "const handleFitToScreen = useCallback(", "}, [fitView, scheduleDraw]);");
    expect(fit).toContain("setDetailedView(false);");
    expect(fit).toContain("setView(fitView);");
  });
});

describe("the framing keeps the player's own zoom (design note #911)", () => {
  /* ==================================================================
      THE WIRING, NOT THE ARITHMETIC
     ==================================================================
     `frameHexes.test.ts` proves a locked zoom is honoured. It cannot prove the RENDERER passes one -- and a
     negative control that replaced `lockedZoom: view.zoom` with `null` left every case in that file green,
     which is #910's shape exactly: both sides correct, the join between them open and untested.
     A SOURCE SCAN, because "which value is handed to this option" is a wiring question, and wiring is what a
     unit test of either side cannot see. */
  const RENDERER = stripComments(readSource("components/HexGridRenderer.tsx"));

  it("is really the renderer", () => {
    expect(RENDERER).toContain("frameHexes(points");
  });

  it("hands the frame the player's current zoom", () => {
    /* `view.zoom` rather than `fitView.zoom` or `minZoom`: the effect at #13 keeps `view` synced to `fitView`
       while the camera is locked, so this one value is the magnification on screen in BOTH camera modes. */
    expect(RENDERER).toContain("lockedZoom: view.zoom");
  });

  it("does no zoom arithmetic of its own at the call site", () => {
    /* THE MUTATION BEING REMOVED. `setView` here takes the framed pan and the zoom it was handed back; any
       arithmetic on the zoom here would be a second place the camera decides magnification, which is how the
       two come to disagree. */
    expect(RENDERER).toContain("setView({ zoom: framed.zoom");
    expect(RENDERER).not.toContain("setView({ zoom: minZoom");
  });
});

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

