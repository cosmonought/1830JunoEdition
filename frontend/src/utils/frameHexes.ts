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
  /* ==================================================================
      DESIGN NOTE 955: THE HOME STATION FIRST, ON REPORT
     ==================================================================
     REPORTED: "Clicking this button currently scrolls the user to the absolute top of the Rail Map container.
     Update the pan/scroll calculation to instead target the specific DOM node (or grid coordinate) of that
     corporation's Home Station hex, centering that hex in the viewport."
     WHICH REVERSES #888'S ORDERING, and that note's argument is worth keeping in view rather than deleting:
     "a network mid-game is a sprawl, and framing its bounding box can land the camera on a fully-built
     stretch with nothing to do in it", so it preferred the BUILDABLE set -- the decision the player is
     standing in front of.
     THE ARGUMENT IS SOUND AND ANSWERS A DIFFERENT QUESTION. "Where may I build" changes every turn and can
     be anywhere on the board; "where is this corporation" is fixed for the whole game. A jump button whose
     destination moves is one a player cannot form a habit about, and the report is from someone who pressed
     it expecting to be taken somewhere they recognised.
     THE BUILDABLE SET IS STILL HERE, one rung down, because it is the better answer when a corporation has
     no home to name -- and because #888's reasoning would be the right reasoning again if this were ever
     re-scoped to "show me my options" rather than "take me to my railway". */
  home?: string | null;
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
  /* Design note #955: ONE HEX, WHICH IS WHY THE ZOOM LOCK MATTERS. `frameHexes` sizes a single point from
     the padding alone -- and under #911's locked zoom it does not resize at all, it only centres. That is
     exactly "centering that hex in the viewport" and is why this needed no new arithmetic. */
  if (input.home) return [input.home];
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
  /* ==================================================================
      DESIGN NOTE 911: THE CAMERA MAY MOVE; IT MAY NOT ZOOM
     ==================================================================
     REPORTED: "The viewport auto-zooming is jarring ... The camera should still pan/scroll to the network,
     but it must strictly maintain the player's current zoom level."
     AND THE ZOOM WAS THE WHOLE OF #888'S ARITHMETIC, which is why this is an option here rather than a
     subtraction at the call site. The pan is computed FROM the zoom -- `panX: width / 2 - centerX * zoom` --
     so a caller that took the pan and kept its own zoom would be centring at a magnification the pan was
     never solved for, and the network would land off-centre by exactly the ratio between them. The two
     numbers are one answer.
     SO THE CALLER STATES THE ZOOM and this centres at it. `null` keeps #888's fit-to-the-set behaviour, which
     nothing uses today and which is kept because the arithmetic is the interesting part of this module and
     deleting a branch to make a caller tidier is how a module stops being able to answer the next question.
     WHY NOT `minZoom === maxZoom` INSTEAD: it would work, and it would be a lie about what those two fields
     mean -- they are the default pose and the buttons' ceiling, and a reader would have to reverse-engineer
     the intent from two equal numbers. */
  lockedZoom?: number | null;
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

  /* Design note #911: a locked zoom skips the fit entirely rather than being clamped to it. Clamping would
     put it back through `Math.max(minZoom, ...)` and silently raise a player who had zoomed OUT past the
     default pose -- which is a zoom change, which is the thing being removed.
     A NON-FINITE OR NON-POSITIVE LOCK IS IGNORED, because a zero zoom divides the board into a point and a
     caller passing one has already lost track of its own view state. Falling back to the fit is visible;
     honouring it is a blank canvas. */
  const locked = options.lockedZoom;
  const useLocked = locked != null && Number.isFinite(locked) && locked > 0;

  /* CLAMPED BETWEEN THE DEFAULT POSE AND THE ZOOM BUTTONS' CEILING. The floor matters more than it looks:
     a network spanning most of the board would otherwise frame BELOW `minZoom`, showing less than the
     locked default and reading as a control that zoomed out when asked to zoom in. */
  const zoom = useLocked ? locked : Math.min(options.maxZoom, Math.max(options.minZoom, fit));

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
