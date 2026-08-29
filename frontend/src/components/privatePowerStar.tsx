// frontend/src/components/privatePowerStar.tsx
//
// ==================================================================
//  DESIGN NOTE 936: ONE STAR, TWO RENDERERS
// ==================================================================
//
// REPORTED: "There is a visually rendered star icon on the map hexes where private powers take effect (e.g.,
// next to the 'DH' text on the Scranton hex). You likely missed it in your grep because it is drawn via an
// inline SVG `<path>` or `<polygon>` within the hex definitions."
//
// THE STAR IS REAL AND I WAS WRONG TO SAY OTHERWISE. #714 put it there, replacing a padlock that stated the
// opposite of the rule. What it is NOT is SVG: the board is a `<canvas>`, and the star is ten vertices
// plotted into a `ctx` path inside `drawReservationBadgeAt`. That is why a grep for `<path>` and `<polygon>`
// found nothing, and it is also why the fix cannot be "export the component the hex already uses" -- there is
// no component, and a canvas cannot render one.
//
// SO WHAT IS SHARED IS THE GEOMETRY, NOT THE ELEMENT. This module owns the construction; `hexCanvasPrimitives`
// walks it into a canvas path and the action bar renders it as an SVG polygon. Two renderers, one shape --
// which is the only arrangement where the button and the hex cannot drift, and drift is the entire point of
// the request: the button is meant to say "this is the thing you saw on the board".
//
// WHY THE RADIUS IS DERIVED FROM A HEIGHT RATHER THAN PASSED IN. Design note #937 below has to make the star
// exactly as tall as the neighbouring cap-height, and a five-pointed star's bounding box is NOT twice its
// circumradius -- the two lower points stop well short of the bottom. Every caller that tried to reason about
// that itself would get it slightly wrong in a different direction, so the conversion lives here, once.

// Design note #975: the type metrics both renderers size a star against. Declared in `typography.ts`
// because they are facts about letters rather than about this shape -- see the re-export below.
import { CAP_HEIGHT_RATIO, X_HEIGHT_RATIO } from "../styles/typography";

/** The five-pointed star's height as a multiple of its circumradius.
 *
 *  ==================================================================
 *   DESIGN NOTE 936: THE BOUNDING BOX IS NOT TWICE THE RADIUS
 *  ==================================================================
 *
 *  The outer vertices sit at -90 degrees plus multiples of 72. The topmost is the point at -90 (one full
 *  radius up); the lowest pair are at 54 and 126 degrees, which reach only `sin(54deg)` -- about 0.809 -- of a
 *  radius down. So the drawn height is `1 + sin(54deg)` radii, roughly 1.809, and treating it as 2 makes the
 *  star about 10% shorter than asked for.
 *
 *  COMPUTED RATHER THAN TYPED AS 1.809, so it stays correct if the construction below is ever changed, and so
 *  a reader can see WHERE it comes from instead of taking a decimal on trust. */
export const STAR_HEIGHT_PER_RADIUS = 1 + Math.sin((54 * Math.PI) / 180);

/** And the width, for the same reason: the widest pair are the points at -18 and 198 degrees, so the star
 *  spans `2 * cos(18deg)` radii -- about 1.902, WIDER than it is tall. The badge's horizontal slot is sized
 *  from this rather than from a guess, or a taller star silently overlaps the acronym beside it. */
export const STAR_WIDTH_PER_RADIUS = 2 * Math.cos((18 * Math.PI) / 180);

/** The circumradius that draws a star exactly `height` tall. */
export function starRadiusForHeight(height: number): number {
  return height / STAR_HEIGHT_PER_RADIUS;
}

/** The width of a star drawn `height` tall. */
export function starWidthForHeight(height: number): number {
  return starRadiusForHeight(height) * STAR_WIDTH_PER_RADIUS;
}

export interface StarPoint {
  x: number;
  y: number;
}

/** The ten vertices, alternating outer and inner radius, starting at the top.
 *
 *  ==================================================================
 *   DESIGN NOTE 936: THE ONE CONSTRUCTION, LIFTED OUT OF THE CANVAS
 *  ==================================================================
 *
 *  Verbatim the loop #714 wrote, moved rather than rewritten: starting at -90 degrees is what keeps a point
 *  upright at every scale, and the alternation is the standard five-pointed construction.
 *
 *  `cy` IS THE CENTRE OF THE CIRCUMCIRCLE, NOT OF THE DRAWN SHAPE, which is worth stating because the two are
 *  not the same for a star and the difference is what makes optical centring fiddly. The top point reaches a
 *  full radius above `cy`; the bottom edge only 0.809 of one below it. A caller centring the star against
 *  text should offset by `verticalCentreOffset` below rather than aligning on `cy`. */
export function starVertices(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRatio = 0.42,
): StarPoint[] {
  const points: StarPoint[] = [];
  for (let point = 0; point < 10; point += 1) {
    const radius = point % 2 === 0 ? outerRadius : outerRadius * innerRatio;
    const angle = -Math.PI / 2 + (point * Math.PI) / 5;
    points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  }
  return points;
}

/** How far BELOW the drawn shape's optical centre the circumcircle centre sits, for a given height.
 *
 *  The drawn shape spans from `cy - radius` to `cy + 0.809 * radius`, so its middle is at
 *  `cy - 0.0955 * radius`. A caller that wants the star's mass centred on a baseline-derived midpoint adds
 *  this to `cy`. Exported because both renderers need it and neither should re-derive it. */
export function starCentreOffset(height: number): number {
  const radius = starRadiusForHeight(height);
  return (radius - radius * Math.sin((54 * Math.PI) / 180)) / 2;
}

/** The vertices as an SVG `points` attribute. */
export function starPolygonPoints(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRatio = 0.42,
): string {
  return starVertices(cx, cy, outerRadius, innerRatio)
    .map((point) => `${round(point.x)},${round(point.y)}`)
    .join(" ");
}

/** Two decimals is well under a device pixel at these sizes and keeps the markup readable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The same gold the hex badge fills with. Exported so the button cannot drift to a near-miss. */
export const PRIVATE_POWER_STAR_FILL = "#f0d074";

/* ==================================================================
 *  DESIGN NOTE 975: HOW TALL, AS A RULE RATHER THAN AS TWO NUMBERS
 * ==================================================================
 *
 * REPORTED: "The star icon on the Action Bar button is currently larger than the star on the board hexes.
 * Scale down the Action Bar button's star so it matches the size of the board hex star perfectly."
 *
 * IT IS LARGER, AND ABSOLUTE PARITY IS THE WRONG TARGET -- which is the one part of this I want to argue
 * with rather than implement. The hex's star is the cap-height of an 8px bold acronym: about 5.8 pixels, and
 * only at full zoom, because `drawReservationBadgeAt` scales its type with the hex and bottoms out around
 * 4.3px zoomed out. Pinning the chip to 5.8px would put a speck beside 15px text, and it would still be
 * "wrong" at every zoom but one. There is no number that matches a thing whose size is a function of the map.
 *
 * WHAT DOES TRANSFER IS #937's RULE: the star is as tall as the text beside it. That is what makes the two
 * marks read as one mark, and it holds at every zoom and every type scale rather than at one pairing.
 *
 * AND APPLYING IT PROPERLY IS WHAT ACTUALLY SHRINKS THE CHIP'S STAR, because the two strings are different
 * KINDS of string. The hex says `DH` -- all capitals, so cap-height IS the word's full visual mass and a
 * cap-height star sits flush with it. The chip says `Use DH Power`, which is mostly lowercase, so a
 * cap-height star towers over the x-height that makes up most of the word. Same rule, same ratio, and it
 * reads as oversized in one place and correct in the other. That is the report, and it is a real defect
 * rather than a preference.
 *
 * SO THE CHIP TAKES THE X-HEIGHT and the hex keeps the cap-height. Both are "as tall as the text beside it";
 * they differ because the text differs.
 *
 * THE HEX MEASURES ITS CAP-HEIGHT FOR REAL (`actualBoundingBoxAscent`) and falls back to a ratio. The chip
 * cannot -- CSS gives no x-height metric to JavaScript without rendering a glyph and measuring it -- so it
 * uses the ratio directly.
 *
 * BOTH RATIOS LIVE IN `typography.ts`, NOT HERE. They are facts about type rather than about this star, and
 * the cap-height one already had three copies across two files when this batch went looking. Re-exported so
 * a reader who arrives at the star's geometry finds them, and so the two consumers that reason about a star
 * do not have to know they came from the type scale. */
export { CAP_HEIGHT_RATIO as STAR_CAP_HEIGHT_RATIO, X_HEIGHT_RATIO as STAR_X_HEIGHT_RATIO };

export interface PrivatePowerStarProps {
  /** Drawn height in pixels -- the dimension #937 matches to a cap-height. */
  height?: number;
  /** Overrides the badge gold. */
  fill?: string;
  /** Screen-reader text. `null` marks the star decorative, which is the right answer beside a button that
   *  already says "Buy Private Company" in words -- the icon repeats the label rather than adding to it. */
  title?: string | null;
}

/** The hex badge's star, as an element.
 *
 *  ==================================================================
 *   DESIGN NOTE 936: THE BUTTON BORROWS THE BOARD'S VOCABULARY
 *  ==================================================================
 *
 *  ASKED FOR: "Apply it to the 'Buy Private Companies' action bar button to bridge the visual vocabulary."
 *
 *  THE VIEWBOX IS THE STAR'S OWN BOUNDING BOX, not a square, so the element occupies exactly the shape's
 *  extent and a caller can size it by height without inheriting empty margin. A square viewBox would have
 *  made `height` mean "the box" rather than "the star", which is the distinction #937 turns on. */
export function PrivatePowerStar({
  height = 12,
  fill = PRIVATE_POWER_STAR_FILL,
  title = null,
}: PrivatePowerStarProps): JSX.Element {
  const radius = starRadiusForHeight(height);
  const width = radius * STAR_WIDTH_PER_RADIUS;
  /* Placed so the shape fills the box: a full radius down from the top for the point, and half the width
     across for the horizontal centre. */
  const points = starPolygonPoints(width / 2, radius, radius);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${round(width)} ${round(height)}`}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title ?? undefined}
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      {title ? <title>{title}</title> : null}
      <polygon points={points} fill={fill} />
    </svg>
  );
}
