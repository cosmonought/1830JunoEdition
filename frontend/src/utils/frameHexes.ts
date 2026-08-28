// frontend/src/utils/frameHexes.ts
//
// ==================================================================
//  DESIGN NOTE 888: THE CAMERA POSE THAT PUTS A SET OF HEXES ON SCREEN
// ==================================================================
//
// REPORTED: "The 'Lay 1 Track' button ... currently auto-scrolls to the rail map, which when players are at
// the top of the screen is trivially true so it remains grayed out/disabled ... Would it make more sense for
// this button to auto-scroll them to their network on the map?"
//
// AND THE PREMISE NEEDED CORRECTING BEFORE THE FIX COULD BE RIGHT. There is nothing to scroll TO on the map:
// `HexGridRenderer` opens with `detailedView = false`, which locks the camera at `fitView` -- the whole board
// fitted to the pane's width and centred on its own bounds -- and only unlocks when the player presses a zoom
// control. In the pose a new player is actually in, their network is already framed. It is not off screen; it
// is SMALL.
//
// SO THE MOVE IS A ZOOM, NOT A SCROLL, and that is what this module computes.
//
// ------------------------------------------------------------------
//  WHAT WAS ACTUALLY BROKEN, WHICH IS A DIFFERENT THING
// ------------------------------------------------------------------
//
// `mapInView` greyed the button, and it is an IntersectionObserver at `threshold: 0.25` on the board PANE.
// So the button said "you can already see the map" whenever a quarter of a DOM element was on screen -- a
// fact about layout, not about whether the player can see where they may build. #833 chose that subject when
// the map genuinely needed FINDING; the map does not need finding any more, it needs READING, and the
// predicate never moved with the question. A proxy that stopped standing for its subject.
//
// ------------------------------------------------------------------
//  WHY A PURE MODULE RATHER THAN A FEW LINES INSIDE THE RENDERER
// ------------------------------------------------------------------
//
// Design note #887's argument, applied on purpose this time rather than in arrears: a camera pose is a
// calculation with an answer, and a calculation with an answer should be callable. Inside `HexGridRenderer`
// it would be reachable only by a source scan asserting that some arithmetic exists -- and the failure modes
// here are all ARITHMETIC (a zoom that inverts on one hex, a pan that centres the bounding box of an empty
// set, a clamp applied before the centring rather than after), which is exactly the class a scan cannot see.

/** A point in BOARD space -- the coordinate system `axialToPixel` produces, before pan and zoom. */
export interface BoardPoint {
  x: number;
  y: number;
}

/** Which hexes the Lay Track jump should frame, in order of preference.
 *
 *  ==================================================================
 *   DESIGN NOTE 888: "WHERE YOU MAY BUILD", NOT "YOUR NETWORK"
 *  ==================================================================
 *
 *  ASKED FOR AS "their network", and the buildable set is the better answer to the question actually being
 *  asked at this step. A network mid-game is a sprawl, and framing its bounding box can land the camera on a
 *  fully-built stretch with nothing to do in it. `highlighted` is `layableHexes`'s answer to "is there a tile
 *  that fits, now, in this era, connecting to this network" (#716) -- the decision the player is standing in
 *  front of. It is also adjacent to the network by construction, so framing it shows the track anyway.
 *
 *  THE FALLBACKS ARE ORDERED BY HOW MUCH THEY ANSWER. No legal placement is a real state -- a boxed-in
 *  corporation in a late era -- and then the useful thing is still "here is your track". With neither, there
 *  is nothing to say and the caller disables the control rather than framing the empty board.
 *
 *  A SET IS RETURNED AS AN ARRAY because the caller iterates it once; `ReadonlySet` in and out would make
 *  the empty-check and the mapping two passes over the same three cases. */
export function chooseFrameKeys(input: {
  /** `layTrackFocus.highlighted` -- where a tile fits this turn. */
  buildable?: ReadonlySet<string>;
  /** `layTrackFocus.network` -- the hexes that actually carry this corporation's track. */
  network?: ReadonlySet<string>;
  /** The acting corporation's station tokens, as `"q,r"`. The last resort, and the one that is non-empty
   *  from the moment a corporation floats: its home token is placed automatically. */
  stations?: readonly string[];
}): readonly string[] {
  /* `forEach` INTO AN ARRAY, not a spread: this project targets ES5 without `downlevelIteration`, so
     spreading a `Set` does not compile. `HexGridRenderer`'s reservation pass carries the same note. */
  const drain = (set: ReadonlySet<string>): string[] => {
    const out: string[] = [];
    set.forEach((key) => out.push(key));
    return out;
  };
  if (input.buildable && input.buildable.size > 0) return drain(input.buildable);
  if (input.network && input.network.size > 0) return drain(input.network);
  return input.stations ?? [];
}

/** The canvas's own pixel size. */
export interface Viewport {
  width: number;
  height: number;
}

/** Mirrors `HexGridRenderer`'s `ViewTransform` exactly. Redeclared rather than imported because that type
 *  lives inside a 3,000-line component this module must not depend on -- the dependency would run the wrong
 *  way, and the shape is three numbers. */
export interface FramedView {
  panX: number;
  panY: number;
  zoom: number;
}

export interface FrameOptions {
  /** Board-space padding kept around the framed set, so a hex at the edge of the group is not flush against
   *  the canvas edge. */
  padding: number;
  /** The fit-the-whole-board zoom. A framing that came out BELOW this would be showing less than the default
   *  pose, which is never what "show me my track" means. */
  minZoom: number;
  /** `minZoom * MAX_ZOOM_MULTIPLIER` at the call site -- the same ceiling the zoom buttons obey, so a frame
   *  cannot reach a magnification the player has no control to return from. */
  maxZoom: number;
}

/** The camera pose that puts `points` on screen, or `null` when there is nothing to frame.
 *
 *  `null` RATHER THAN A FALLBACK POSE. An empty set means the caller has no answer to give -- no buildable
 *  hexes, no home token -- and inventing a pose would move the board for a press that should not have been
 *  offered. The caller disables the control instead, which is #797's rule: a control pointing at nothing is
 *  worse than no control.
 *
 *  A SINGLE POINT IS THE COMMON CASE, not an edge one: at the start of the game a corporation's whole network
 *  is one home token, which is precisely the moment the report is about. Its bounding box has zero extent, so
 *  the zoom comes from the padding alone -- which is why `padding` is required rather than defaulted, and why
 *  a zero padding would divide by zero rather than merely look tight. */
export function frameHexes(
  points: readonly BoardPoint[],
  viewport: Viewport,
  options: FrameOptions,
): FramedView | null {
  if (points.length === 0) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  /* THE PADDING IS ADDED TO THE EXTENT, NOT SUBTRACTED FROM THE VIEWPORT, so a one-hex set frames at a
     sensible magnification instead of dividing by an extent of zero. */
  const spanX = maxX - minX + options.padding * 2;
  const spanY = maxY - minY + options.padding * 2;

  /* THE SMALLER OF THE TWO FITS, because fitting the larger would push the other axis off screen -- the
     ordinary bounding-box mistake, and the one that would put a north-south network's ends outside the
     canvas while reporting success. */
  const fit = Math.min(viewport.width / spanX, viewport.height / spanY);

  /* CLAMPED BETWEEN THE DEFAULT POSE AND THE ZOOM BUTTONS' CEILING. The floor matters more than it looks:
     a network spanning most of the board would otherwise frame BELOW `minZoom`, showing less than the
     locked default and reading as a control that zoomed out when asked to zoom in. */
  const zoom = Math.min(options.maxZoom, Math.max(options.minZoom, fit));

  /* CENTRED AFTER THE ZOOM IS DECIDED. Doing it the other way -- centring on a provisional zoom and then
     clamping -- leaves the pan describing a magnification the view no longer has, which is off-centre by
     exactly the amount the clamp moved. */
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    zoom,
    panX: viewport.width / 2 - centerX * zoom,
    panY: viewport.height / 2 - centerY * zoom,
  };
}
