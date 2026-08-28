/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 888 (harness): THE ARITHMETIC, ASKED
// ==================================================================
//
// Every failure mode of a camera-framing calculation is a NUMBER being wrong -- a zoom that inverts on a
// single point, a fit taken on the wrong axis, a pan describing a magnification the clamp has since changed.
// None of those is visible to a source scan, which is why #887's argument said this belongs in a module
// rather than inside `HexGridRenderer`. This file is the return on that.
//
// THE VIEWPORT IS DELIBERATELY NOT SQUARE in every test that could be fooled by a square one: a 400x200
// canvas tells a width-fit from a height-fit, and a 100x100 cannot.

import { chooseFrameKeys, frameHexes } from "./frameHexes";

const VIEWPORT = { width: 400, height: 200 };
const OPTS = { padding: 10, minZoom: 0.5, maxZoom: 1.5 };

describe("frameHexes", () => {
  it("returns null for an empty set", () => {
    /* #797's rule one layer down: the caller disables the control rather than being handed a pose for a
       press it should not have offered. A fallback pose here would move the board for nothing. */
    expect(frameHexes([], VIEWPORT, OPTS)).toBeNull();
  });

  it("returns null for a viewport with no area", () => {
    // A canvas measured before layout. Dividing by it produces Infinity, which clamps to maxZoom and frames
    // a board nobody can see -- a plausible-looking pose from a measurement that had not happened yet.
    expect(frameHexes([{ x: 0, y: 0 }], { width: 0, height: 200 }, OPTS)).toBeNull();
    expect(frameHexes([{ x: 0, y: 0 }], { width: 400, height: 0 }, OPTS)).toBeNull();
  });

  it("centres a single point in the viewport", () => {
    /* THE COMMON CASE, NOT AN EDGE ONE: at the start of the game a corporation's whole network is one home
       token, which is exactly the moment the report is about. A bounding box of zero extent is why the
       padding is added to the SPAN rather than subtracted from the viewport. */
    const view = frameHexes([{ x: 100, y: 50 }], VIEWPORT, OPTS)!;
    expect(view).not.toBeNull();
    /* THE POINT LANDS AT THE CENTRE OF THE CANVAS, which is the whole promise. Asserted through the
       transform the renderer actually applies -- `screen = board * zoom + pan` -- rather than by
       re-deriving the formula, so a sign error in the module cannot be mirrored by a sign error here. */
    expect(100 * view.zoom + view.panX).toBeCloseTo(VIEWPORT.width / 2);
    expect(50 * view.zoom + view.panY).toBeCloseTo(VIEWPORT.height / 2);
  });

  it("centres the bounding box of a spread-out set", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 200, y: 100 },
    ];
    const view = frameHexes(points, VIEWPORT, OPTS)!;
    expect(100 * view.zoom + view.panX).toBeCloseTo(VIEWPORT.width / 2);
    expect(50 * view.zoom + view.panY).toBeCloseTo(VIEWPORT.height / 2);
  });

  it("is unmoved by the order the points arrive in", () => {
    /* A BOUNDING BOX IS ORDER-FREE and the loop that computes it must be too -- an implementation seeded
       with `points[0]` and then comparing wrongly would work for a sorted set and fail for a reversed one,
       which is a bug that hides behind any fixture that happens to be sorted. */
    const forward = frameHexes(
      [
        { x: -50, y: -20 },
        { x: 0, y: 0 },
        { x: 130, y: 60 },
      ],
      VIEWPORT,
      OPTS,
    );
    const backward = frameHexes(
      [
        { x: 130, y: 60 },
        { x: 0, y: 0 },
        { x: -50, y: -20 },
      ],
      VIEWPORT,
      OPTS,
    );
    expect(forward).toEqual(backward);
  });

  it("fits the constraining axis, not whichever one is listed first", () => {
    /* THE ORDINARY BOUNDING-BOX MISTAKE. On a 400x200 canvas a TALL set is constrained by height and a WIDE
       one by width; taking the wrong axis pushes the other one off screen while reporting success.
       ASSERTED BY CONTAINMENT rather than by reproducing the `Math.min`: every corner of the set has to land
       inside the canvas. That is the property; the formula is one way to get it. */
    const wide = frameHexes(
      [
        { x: 0, y: 0 },
        { x: 300, y: 10 },
      ],
      VIEWPORT,
      { ...OPTS, minZoom: 0.01, maxZoom: 100 },
    )!;
    const tall = frameHexes(
      [
        { x: 0, y: 0 },
        { x: 10, y: 300 },
      ],
      VIEWPORT,
      { ...OPTS, minZoom: 0.01, maxZoom: 100 },
    )!;
    for (const [view, points] of [
      [wide, [{ x: 0, y: 0 }, { x: 300, y: 10 }]],
      [tall, [{ x: 0, y: 0 }, { x: 10, y: 300 }]],
    ] as const) {
      for (const point of points) {
        const screenX = point.x * view.zoom + view.panX;
        const screenY = point.y * view.zoom + view.panY;
        expect(screenX).toBeGreaterThanOrEqual(0);
        expect(screenX).toBeLessThanOrEqual(VIEWPORT.width);
        expect(screenY).toBeGreaterThanOrEqual(0);
        expect(screenY).toBeLessThanOrEqual(VIEWPORT.height);
      }
    }
    /* AND THE TWO POSES DIFFER, which is what proves the axis was chosen rather than fixed. Without this,
       an implementation always fitting width would satisfy the containment above for the wide set and be
       caught only by the tall one -- so both halves are needed and this states why. */
    expect(wide.zoom).not.toBeCloseTo(tall.zoom);
  });

  it("never frames below the fit-the-whole-board zoom", () => {
    /* THE FLOOR MATTERS MORE THAN IT LOOKS. A network spanning most of the board would otherwise frame BELOW
       `minZoom` -- showing LESS than the locked default pose, so a button asked to show your track would
       visibly zoom out. */
    const huge = frameHexes(
      [
        { x: -10000, y: -10000 },
        { x: 10000, y: 10000 },
      ],
      VIEWPORT,
      OPTS,
    )!;
    expect(huge.zoom).toBe(OPTS.minZoom);
  });

  it("never frames above the zoom buttons' ceiling", () => {
    /* A single home token would otherwise frame at whatever magnification the padding implies, which on a
       small pad is enormous -- and the player would have no control that returns from it, because the zoom
       buttons stop at `maxZoom`. */
    const tiny = frameHexes([{ x: 0, y: 0 }], VIEWPORT, { ...OPTS, padding: 0.001 })!;
    expect(tiny.zoom).toBe(OPTS.maxZoom);
  });

  it("stays centred at both clamps", () => {
    /* THE ORDER-OF-OPERATIONS BUG THIS EXISTS FOR: centring on a provisional zoom and then clamping leaves
       the pan describing a magnification the view no longer has, off-centre by exactly the amount the clamp
       moved. Both clamps are exercised, because the floor and the ceiling are separate arms. */
    const clampedLow = frameHexes(
      [
        { x: -10000, y: -10000 },
        { x: 10000, y: 10000 },
      ],
      VIEWPORT,
      OPTS,
    )!;
    expect(0 * clampedLow.zoom + clampedLow.panX).toBeCloseTo(VIEWPORT.width / 2);
    expect(0 * clampedLow.zoom + clampedLow.panY).toBeCloseTo(VIEWPORT.height / 2);

    const clampedHigh = frameHexes([{ x: 40, y: 25 }], VIEWPORT, { ...OPTS, padding: 0.001 })!;
    expect(40 * clampedHigh.zoom + clampedHigh.panX).toBeCloseTo(VIEWPORT.width / 2);
    expect(25 * clampedHigh.zoom + clampedHigh.panY).toBeCloseTo(VIEWPORT.height / 2);
  });

  it("keeps the padding outside the set, not inside it", () => {
    /* THE PADDING IS SLACK, so a hex at the edge of the group is not flush against the canvas edge. A
       padding folded into the centring instead of the span would move the board rather than loosen it --
       visible as a network sitting off to one side. */
    const padded = frameHexes([{ x: 0, y: 0 }, { x: 100, y: 0 }], VIEWPORT, {
      ...OPTS,
      padding: 50,
      minZoom: 0.01,
      maxZoom: 100,
    })!;
    const leftEdge = 0 * padded.zoom + padded.panX;
    const rightEdge = 100 * padded.zoom + padded.panX;
    expect(leftEdge).toBeGreaterThan(0);
    expect(rightEdge).toBeLessThan(VIEWPORT.width);
    /* AND STILL CENTRED: the slack is equal on both sides. */
    expect(leftEdge).toBeCloseTo(VIEWPORT.width - rightEdge);
  });
});

describe("chooseFrameKeys", () => {
  it("prefers where a tile fits this turn", () => {
    /* THE QUESTION THE STEP ASKS. `network` is deliberately non-empty and DIFFERENT here -- a fixture where
       the two sets overlapped could not tell a preference from a union. */
    expect(
      chooseFrameKeys({
        buildable: new Set(["1,1"]),
        network: new Set(["9,9"]),
        stations: ["5,5"],
      }),
    ).toEqual(["1,1"]);
  });

  it("falls back to the corporation's own track when nothing is legal", () => {
    /* A BOXED-IN CORPORATION IN A LATE ERA is a real state, not a defensive branch. "Here is your track" is
       still the useful answer; framing nothing would be a press with no outcome. */
    expect(
      chooseFrameKeys({ buildable: new Set(), network: new Set(["9,9"]), stations: ["5,5"] }),
    ).toEqual(["9,9"]);
  });

  it("falls back to the station tokens when there is no track yet", () => {
    /* THE FIRST OPERATING TURN, which is the moment the report is about: a freshly floated corporation has
       a home token and nothing else. */
    expect(chooseFrameKeys({ buildable: new Set(), network: new Set(), stations: ["5,5"] })).toEqual([
      "5,5",
    ]);
  });

  it("returns nothing when there is nothing to say", () => {
    // The caller disables the control on this, rather than framing an empty board.
    expect(chooseFrameKeys({})).toEqual([]);
    expect(chooseFrameKeys({ buildable: new Set(), network: new Set(), stations: [] })).toEqual([]);
  });

  it("treats an absent set and an empty one the same way", () => {
    /* `layTrackFocus` is `undefined` outside the Track step and when the reach is unconstrained, so both
       spellings of "no answer" arrive in normal play. A check on presence rather than on size would take
       the first branch with an empty set and frame nothing while reporting success. */
    expect(chooseFrameKeys({ buildable: new Set(), stations: ["5,5"] })).toEqual(["5,5"]);
    expect(chooseFrameKeys({ stations: ["5,5"] })).toEqual(["5,5"]);
  });
});

describe("the frame pans but never zooms (design note #911)", () => {
  /* ==================================================================
      REPORTED: "The viewport auto-zooming is jarring ... it must strictly maintain the player's current
      zoom level."
     ==================================================================
     THE PAN IS COMPUTED FROM THE ZOOM, which is why this is an option inside the module rather than a
     subtraction at the call site: a caller that kept its own zoom and took this pan would centre at a
     magnification the pan was never solved for. These cases pin that the two stay one answer. */
  const viewport = { width: 800, height: 600 };
  const options = { padding: 30, minZoom: 0.5, maxZoom: 4 };
  const spread = [
    { x: 0, y: 0 },
    { x: 400, y: 300 },
  ];

  it("returns exactly the zoom it was given", () => {
    for (const lockedZoom of [0.25, 0.5, 1, 2.75, 4, 9]) {
      expect(frameHexes(spread, viewport, { ...options, lockedZoom })?.zoom).toBe(lockedZoom);
    }
  });

  it("does not clamp a locked zoom back up to the default pose", () => {
    /* THE CASE A NAIVE IMPLEMENTATION GETS WRONG. Running the lock through the existing
       `Math.max(minZoom, ...)` would silently raise a player who had zoomed OUT past the default -- which is
       a zoom change, which is the thing being removed. `0.25` is below `minZoom` on purpose. */
    expect(frameHexes(spread, viewport, { ...options, lockedZoom: 0.25 })?.zoom).toBe(0.25);
  });

  it("does not clamp a locked zoom down to the buttons' ceiling either", () => {
    expect(frameHexes(spread, viewport, { ...options, lockedZoom: 9 })?.zoom).toBe(9);
  });

  it("still centres the set, at that zoom", () => {
    /* THE HALF THAT MUST KEEP WORKING. "Pan but do not zoom" is only useful if the pan is right: the set's
       own centre has to land on the canvas centre, solved at the LOCKED magnification rather than at the
       fit. Checked by transforming the centre through the returned pose. */
    const lockedZoom = 2;
    const framed = frameHexes(spread, viewport, { ...options, lockedZoom })!;
    const centreX = (spread[0].x + spread[1].x) / 2;
    const centreY = (spread[0].y + spread[1].y) / 2;
    expect(centreX * framed.zoom + framed.panX).toBeCloseTo(viewport.width / 2, 6);
    expect(centreY * framed.zoom + framed.panY).toBeCloseTo(viewport.height / 2, 6);
  });

  it("ignores a nonsense lock rather than blanking the canvas", () => {
    /* A zero or negative zoom collapses the board to a point. Falling back to the fit is visible and
       diagnosable; honouring it is an empty canvas with no error. */
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const framed = frameHexes(spread, viewport, { ...options, lockedZoom: bad });
      expect(framed).not.toBeNull();
      expect(framed!.zoom).toBeGreaterThan(0);
      expect(Number.isFinite(framed!.zoom)).toBe(true);
    }
  });

  it("keeps fitting the set when no lock is given", () => {
    /* THE CONTROL. #888's behaviour is still reachable and still clamped between the default pose and the
       ceiling -- a lock that had quietly become mandatory would satisfy every case above. */
    const fitted = frameHexes(spread, viewport, options)!;
    expect(fitted.zoom).toBeGreaterThanOrEqual(options.minZoom);
    expect(fitted.zoom).toBeLessThanOrEqual(options.maxZoom);
    expect(frameHexes(spread, viewport, { ...options, lockedZoom: null })!.zoom).toBe(fitted.zoom);
  });
});

