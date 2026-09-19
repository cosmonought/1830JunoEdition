// frontend/src/components/tileTransitionCanvas.ts
//
// VF-5: the tile-lay and tile-upgrade flourish -- the PAINTING half. Everything here takes a context and a
// `TileTransitionFrame` (`tileTransition.ts`) and returns nothing; nothing here decides what moves.
//
// ONE PEN WITH THE BOARD. Rails go through `strokeTrackLayers` at `trackPenWidth` with the same white outline
// and the destination's own layer order and overpasses, and every station outline is the same fattened stroke
// `drawStationCircle` / `drawStationPill` / `drawStationCluster` paint -- ink band at the station radius,
// white inside -- so the last frame of a transition and the authoritative tile that replaces it are the same
// picture, and the hand-over is not a visible event.
//
// THE ONE EXCEPTION IS NEW RAIL WHILE IT ERUPTS (#1469): a portion behind the construction front carries a
// `widthScale`, and is stroked with the same pen at that multiple and its own opacity, in its destination rail's
// layer. It is gone from the frame once it settles, so the settled frame is still the board's pen throughout.
//
// A PROPOSAL AND ITS COMMIT ARE ONE DRAWING, CLIPPED (#1471). A frame with a presentation is painted on each side of
// its commit front. West of it, committed: the destination tier's fill and rim, every element in the tile's own
// colours, and no planned shape. East of it, the proposal: its washed fill and rim, the proposal's own and planned
// elements in the washed palette, and the moving parts in the tile's own colours over them -- in the same layers, so
// a moving rail still passes under a higher one and a centre still covers the rail ends it holds. Each side is the
// same pass under a clip, so nothing is stroked twice; a hairline edge marks the front while it crosses, leaning so the
// commit sweeps left to right and top to bottom, on the fill and under everything else on the tile (#1473). With the front
// off the hex the frame is one side, unclipped, which is why a proposal is exactly its washed tile and the last frame
// of a transition is exactly the tile pass's picture.

import { STANDARD_TRACK_INK } from "./hexBoardData";
import { TRACK_OUTLINE_EXTRA_PX, TRACK_OUTLINE_INK, drawHexPath, strokeTrackLayers, trackPenWidth, withHexClip } from "./hexCanvasPrimitives";
import {
  REVEAL_SLANT,
  REVEAL_SPAN,
  provisionalColor,
  ringCoveredArcs,
  ringUnionArcs,
  type FrameCity,
  type FrameRing,
  type FrameRole,
  type TileTransitionFrame,
  type Vec,
} from "./tileTransition";

type Point = { x: number; y: number };
/** Which side of a commit front a pass paints: a plain frame has no front, and one side. */
type Side = "plain" | "committed" | "provisional";

const toPx = (center: Point, size: number, v: Vec): Point => ({ x: center.x + v.x * size, y: center.y + v.y * size });

/** Paints `paint` on one side of a commit front (#1471): `west` is committed, `east` still the proposal. The board's
 *  value badges use it too, so a printed figure commits exactly where its tile does. The front leans `REVEAL_SLANT`
 *  east per unit down (#1473), so each side is the quadrilateral the leaning line cuts from a box round the hex. */
export function withRevealSide(
  ctx: CanvasRenderingContext2D,
  center: Point,
  size: number,
  front: number,
  side: "west" | "east",
  paint: () => void,
): void {
  const reach = size * 2;
  const top = center.y - reach;
  const bottom = center.y + reach;
  // The committed side reaches a little past the front, so each side's antialiased clip edge lies over the other's
  // drawing and nothing under the tile shows through the seam -- the edge no longer covers it (#1473). Where both are
  // drawn the provisional side, painted second, wins, so the front stays where it is.
  const past = side === "west" ? seamOverlap(ctx) : 0;
  const atTop = center.x + front * size - reach * REVEAL_SLANT + past;
  const atBottom = center.x + front * size + reach * REVEAL_SLANT + past;
  const outer = side === "west" ? center.x - reach * 2 : center.x + reach * 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(outer, top);
  ctx.lineTo(atTop, top);
  ctx.lineTo(atBottom, bottom);
  ctx.lineTo(outer, bottom);
  ctx.closePath();
  ctx.clip();
  paint();
  ctx.restore();
}

/** About a device pixel and a half, in the board's units at the context's current scale: enough for an antialiased
 *  edge to fall wholly over the other side of a seam (#1473). */
function seamOverlap(ctx: CanvasRenderingContext2D): number {
  const transform = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  const scale = transform ? Math.hypot(transform.a, transform.b) : 1;
  return 1.5 / (scale > 0 ? scale : 1);
}

/** Each side of a frame that its front leaves on the hex -- one side, unclipped, when the front is off it. */
function bySide(ctx: CanvasRenderingContext2D, center: Point, size: number, frame: TileTransitionFrame, paint: (side: Side) => void): void {
  const present = frame.present;
  if (!present) {
    paint("plain");
    return;
  }
  if (present.front <= -REVEAL_SPAN) {
    paint("provisional");
    return;
  }
  if (present.front >= REVEAL_SPAN) {
    paint("committed");
    return;
  }
  withRevealSide(ctx, center, size, present.front, "west", () => paint("committed"));
  withRevealSide(ctx, center, size, present.front, "east", () => paint("provisional"));
}

/** The hex's fill and rim, in the tile loop's place: the old tier under the proposal, bottom to top, then the one
 *  rim at the tile loop's own width -- dashed where the board asks, as a proposal not yet sent is (#1145). The commit
 *  front's edge goes between them: it sweeps the tile's bottom layer, under the rim and everything drawn after (#1473). */
export function drawTileTransitionFill(
  ctx: CanvasRenderingContext2D,
  center: Point,
  size: number,
  frame: TileTransitionFrame,
  options: { rimDash?: readonly number[] } = {},
): void {
  bySide(ctx, center, size, frame, (side) => {
    const present = frame.present;
    const committed = present !== null && side === "committed";
    const layers = present !== null && committed ? [{ color: present.committedFill, alpha: 1 }] : frame.fills;
    // A fill under an opaque one is not drawn: under a clip it would only leave its antialiased edge along the seam.
    const opaque = layers.map((fill) => fill.alpha >= 1).lastIndexOf(true);
    const fills = opaque > 0 ? layers.slice(opaque) : layers;
    ctx.save();
    for (const fill of fills) {
      if (fill.alpha <= 0) continue;
      ctx.globalAlpha = fill.alpha;
      drawHexPath(ctx, center, size);
      ctx.fillStyle = fill.color;
      ctx.fill();
    }
    ctx.restore();
  });
  const front = frame.present ? frame.present.front : null;
  if (front !== null && front > -REVEAL_SPAN && front < REVEAL_SPAN) {
    withHexClip(ctx, center, size, () => drawRevealEdge(ctx, center, size, front));
  }
  bySide(ctx, center, size, frame, (side) => {
    const present = frame.present;
    const committed = present !== null && side === "committed";
    const rim = present !== null && committed ? { color: present.committedRim, alpha: 1 } : frame.rim;
    ctx.save();
    if (rim.alpha > 0) {
      ctx.globalAlpha = rim.alpha;
      drawHexPath(ctx, center, size);
      if (options.rimDash) ctx.setLineDash(options.rimDash.slice());
      ctx.strokeStyle = rim.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  });
}

function pathThrough(center: Point, size: number, points: readonly Vec[], closed = false): Path2D {
  const path = new Path2D();
  points.forEach((point, index) => {
    const at = toPx(center, size, point);
    if (index === 0) path.moveTo(at.x, at.y);
    else path.lineTo(at.x, at.y);
  });
  if (closed) path.closePath();
  return path;
}

function coincident(points: readonly Vec[]): boolean {
  return points.every((point) => Math.abs(point.x - points[0].x) < 1e-6 && Math.abs(point.y - points[0].y) < 1e-6);
}

/** Rails then revenue centres, in the order `drawHardcodedTileArtwork` paints them. Call inside the hex clip. The
 *  commit front's edge is not here: it sweeps under all of this, with the fill (#1473). */
export function drawTileTransitionArt(
  ctx: CanvasRenderingContext2D,
  center: Point,
  size: number,
  frame: TileTransitionFrame,
): void {
  const front = frame.present ? frame.present.front : null;
  if (front !== null && front > -REVEAL_SPAN && front < REVEAL_SPAN && laySides(ctx, center, size, frame, front)) return;
  bySide(ctx, center, size, frame, (side) => drawArtSide(ctx, center, size, frame, side));
}

/* While the front crosses, each side's art is painted whole into a scratch layer and laid onto the tile under that
   side's clip (#1473). The art is several strokes deep -- rail outlines under their inks, a city's ink under its white
   -- and a stroke clipped as it is drawn antialiases its clipped edge over the strokes beneath it, which left a faint
   line of those strokes along the seam, across every rail and station. The front's edge used to cover it; the edge
   now runs under the art. A finished layer's clipped edge meets only the other side's finished layer. */
const sideLayers: Array<HTMLCanvasElement | null> = [null, null];

function sideLayer(index: number, width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  let canvas = sideLayers[index];
  if (!canvas) {
    canvas = document.createElement("canvas");
    sideLayers[index] = canvas;
  }
  if (canvas.width < width) canvas.width = width;
  if (canvas.height < height) canvas.height = height;
  const layer = canvas.getContext("2d");
  if (!layer) return null;
  layer.setTransform(1, 0, 0, 1, 0, 0);
  layer.clearRect(0, 0, width, height);
  return layer;
}

/** Lays each side's finished art under its side of the front. False when the context cannot say where it draws or no
 *  scratch layer can be had -- and the caller clips each side as it draws, as before. */
function laySides(ctx: CanvasRenderingContext2D, center: Point, size: number, frame: TileTransitionFrame, front: number): boolean {
  const transform = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  if (!transform) return false;
  const corners = [-1, 1].flatMap((dx) => [-1, 1].map((dy) => ({ x: center.x + dx * size, y: center.y + dy * size })));
  const xs = corners.map((point) => transform.a * point.x + transform.c * point.y + transform.e);
  const ys = corners.map((point) => transform.b * point.x + transform.d * point.y + transform.f);
  const left = Math.floor(Math.min(...xs)) - 2;
  const top = Math.floor(Math.min(...ys)) - 2;
  const width = Math.ceil(Math.max(...xs)) + 2 - left;
  const height = Math.ceil(Math.max(...ys)) + 2 - top;
  if (!(width > 0 && height > 0 && width <= 4096 && height <= 4096)) return false;
  const committed = sideLayer(0, width, height);
  const provisional = sideLayer(1, width, height);
  if (!committed || !provisional) return false;
  const paint = (layer: CanvasRenderingContext2D, side: Side, reveal: "west" | "east") => {
    layer.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e - left, transform.f - top);
    drawArtSide(layer, center, size, frame, side);
    withRevealSide(ctx, center, size, front, reveal, () => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer.canvas, 0, 0, width, height, left, top, width, height);
      ctx.restore();
    });
  };
  paint(committed, "committed", "west");
  paint(provisional, "provisional", "east");
  return true;
}

function drawArtSide(ctx: CanvasRenderingContext2D, center: Point, size: number, frame: TileTransitionFrame, side: Side): void {
  const pen = trackPenWidth(size);
  const ink = frame.ink;
  // The proposal's palette applies ahead of the front, and only to the proposal's own and planned elements.
  const wash = side === "provisional" && frame.present ? frame.present.wash : 0;
  const shows = (role: FrameRole | undefined) => !(side === "committed" && role === "target");
  const washed = (role: FrameRole | undefined) => wash > 0 && role !== undefined;
  const guideInk = wash > 0 ? provisionalColor(ink, wash) : ink;
  const inkOf = (role: FrameRole | undefined) => (washed(role) ? guideInk : ink);

  /* ---- rails ---- */
  ctx.save();
  // Pieces at part strength -- an unexpected pair's leftovers, reduced motion's crossfade, a proposal arriving -- are
  // stroked on their own.
  for (const track of frame.tracks) {
    if (!shows(track.role)) continue;
    if (track.widthScale !== undefined || track.alpha >= 1 || track.alpha <= 0 || track.points.length < 2) continue;
    ctx.save();
    ctx.globalAlpha = track.alpha;
    strokeTrackLayers(ctx, { layers: [[pathThrough(center, size, track.points)]], crossings: [] }, pen, TRACK_OUTLINE_EXTRA_PX, inkOf(track.role));
    ctx.restore();
  }
  // Opaque pieces are gathered by destination rail, so the destination's layers and overpasses apply -- the washed
  // guide's pieces apart from the moving parts', each group one path of subpaths (built point by point: `addPath`
  // may join subpaths).
  const guidePieces = new Map<number, Vec[][]>();
  const activePieces = new Map<number, Vec[][]>();
  const loose: Path2D[] = [];
  // New rail still erupting (#1469), by the layer of the destination rail it is building.
  const eruptingByLayer = new Map<number, EruptingPortion[]>();
  const allErupting: EruptingPortion[] = [];
  for (const track of frame.tracks) {
    if (!shows(track.role) || track.points.length < 2) continue;
    if (track.widthScale !== undefined) {
      if (track.alpha <= 0 || track.destTrack === null) continue;
      const layer = frame.destLayers[track.destTrack] ?? 0;
      const portion = {
        path: eruptingPath(center, size, track.points),
        alpha: Math.min(1, track.alpha),
        widthScale: track.widthScale,
        destTrack: track.destTrack,
      };
      eruptingByLayer.set(layer, [...(eruptingByLayer.get(layer) ?? []), portion]);
      allErupting.push(portion);
      continue;
    }
    if (track.alpha < 1) continue;
    if (track.destTrack === null) {
      loose.push(pathThrough(center, size, track.points));
      continue;
    }
    const group = washed(track.role) ? guidePieces : activePieces;
    group.set(track.destTrack, [...(group.get(track.destTrack) ?? []), track.points]);
  }
  const inkByPath = new Map<Path2D, string>();
  const pathOf = (pieces: Vec[][], color: string) => {
    const path = new Path2D();
    for (const points of pieces) {
      points.forEach((point, index) => {
        const at = toPx(center, size, point);
        if (index === 0) path.moveTo(at.x, at.y);
        else path.lineTo(at.x, at.y);
      });
    }
    inkByPath.set(path, color);
    return path;
  };
  const guidePaths = new Map<number, Path2D>();
  const activePaths = new Map<number, Path2D>();
  guidePieces.forEach((pieces, trackIndex) => guidePaths.set(trackIndex, pathOf(pieces, guideInk)));
  activePieces.forEach((pieces, trackIndex) => activePaths.set(trackIndex, pathOf(pieces, ink)));
  const inkFor = (path: Path2D) => inkByPath.get(path) ?? ink;
  const layerCount = frame.destLayers.reduce((max, layer) => Math.max(max, layer + 1), 0);
  const layers: Path2D[][] = Array.from({ length: layerCount }, () => []);
  // Every guide path of a layer before any moving part's, so a moving part's ink lies over the planned rail it is
  // becoming and never under another's.
  guidePaths.forEach((path, trackIndex) => layers[frame.destLayers[trackIndex] ?? 0].push(path));
  activePaths.forEach((path, trackIndex) => layers[frame.destLayers[trackIndex] ?? 0].push(path));
  const crossings = frame.crossings.flatMap((crossing) => {
    const at = toPx(center, size, crossing);
    return [guidePaths.get(crossing.over), activePaths.get(crossing.over)].flatMap((over) =>
      over ? [{ x: at.x, y: at.y, sinAngle: crossing.sinAngle, over }] : [],
    );
  });
  if (loose.length > 0) strokeTrackLayers(ctx, { layers: [loose], crossings: [] }, pen, TRACK_OUTLINE_EXTRA_PX, ink);
  // Layer by layer, as one `strokeTrackLayers` call would -- with each layer's erupting portions inside the same two
  // passes: their outline goes down before the layer's rails and their ink after, so no white is ever laid over
  // ink of the layer (where a branch leaves a rail that is already there), and a higher layer still crosses over.
  layers.forEach((layer, layerIndex) => {
    const erupting = eruptingByLayer.get(layerIndex) ?? [];
    strokeErupting(ctx, erupting, TRACK_OUTLINE_INK, pen + TRACK_OUTLINE_EXTRA_PX);
    if (layer.length > 0) strokeTrackLayers(ctx, { layers: [layer], crossings: [] }, pen, TRACK_OUTLINE_EXTRA_PX, inkFor);
    strokeErupting(ctx, erupting, ink, pen);
  });
  if (crossings.length > 0) strokeTrackLayers(ctx, { layers: [], crossings }, pen, TRACK_OUTLINE_EXTRA_PX, inkFor);
  // An overpass whose upper rail is still erupting there cuts its gap with that rail's erupting portions, through
  // the same overpass stroke at the portion's own pen and opacity.
  for (const crossing of frame.crossings) {
    for (const portion of allErupting) {
      if (portion.destTrack !== crossing.over) continue;
      const at = toPx(center, size, crossing);
      ctx.save();
      ctx.globalAlpha = portion.alpha;
      strokeTrackLayers(
        ctx,
        { layers: [], crossings: [{ x: at.x, y: at.y, sinAngle: crossing.sinAngle, over: portion.path }] },
        pen * portion.widthScale,
        TRACK_OUTLINE_EXTRA_PX * portion.widthScale,
        ink,
      );
      ctx.restore();
    }
  }
  ctx.restore();

  /* ---- revenue centres: planned shapes underneath, then the rest ---- */
  const planned = (role: FrameRole | undefined) => role === "target";
  for (const city of [...frame.cities.filter((c) => planned(c.role)), ...frame.cities.filter((c) => !planned(c.role))]) {
    if (shows(city.role)) drawCity(ctx, center, size, city, washed(city.role) ? wash : 0);
  }
  ctx.save();
  for (const town of [...frame.towns.filter((c) => planned(c.role)), ...frame.towns.filter((c) => !planned(c.role))]) {
    if (!shows(town.role) || town.radius <= 0 || town.alpha <= 0) continue;
    ctx.fillStyle = washed(town.role) ? provisionalColor("#000000", wash) : "#000000";
    ctx.globalAlpha = town.alpha;
    const at = toPx(center, size, town.at);
    ctx.beginPath();
    ctx.arc(at.x, at.y, town.radius * size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** The commit front's edge (#1471): a light hairline, with a faint shade on its committed side. No glow and no blur.
 *  Inside the hex clip, over the seam where the two fills meet and under everything else on the tile (#1473). */
const REVEAL_EDGE = {
  light: "#fffdf4",
  lightAlpha: 0.85,
  shadeAlpha: 0.2,
  /** Line width as a fraction of the hex size, never under half a pixel: a third of #1471's (#1473). */
  width: 0.01,
  minPx: 0.5,
} as const;

function drawRevealEdge(ctx: CanvasRenderingContext2D, center: Point, size: number, front: number): void {
  const x = center.x + front * size;
  const lean = size * REVEAL_SLANT; // #1473: the top ahead of the bottom, across the hex's full height
  const width = Math.max(REVEAL_EDGE.minPx, size * REVEAL_EDGE.width);
  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineWidth = width;
  ctx.globalAlpha = REVEAL_EDGE.shadeAlpha;
  ctx.strokeStyle = "#000000";
  ctx.beginPath();
  ctx.moveTo(x - lean - width, center.y - size);
  ctx.lineTo(x + lean - width, center.y + size);
  ctx.stroke();
  ctx.globalAlpha = REVEAL_EDGE.lightAlpha;
  ctx.strokeStyle = REVEAL_EDGE.light;
  ctx.beginPath();
  ctx.moveTo(x - lean, center.y - size);
  ctx.lineTo(x + lean, center.y + size);
  ctx.stroke();
  ctx.restore();
}

/** How far, in board pixels, an erupting portion starts back under the rail behind it. Two antialiased cuts that
 *  merely abut let a hairline of the tile show between them; half a pixel of overlap along the rail's own direction
 *  closes it without moving either cut the frame describes. */
const PORTION_SEAM_PX = 0.5;

function eruptingPath(center: Point, size: number, points: readonly Vec[]): Path2D {
  const px = points.map((point) => toPx(center, size, point));
  const [first, second] = px;
  const run = Math.hypot(second.x - first.x, second.y - first.y);
  if (run > 1e-6) {
    px[0] = {
      x: first.x - ((second.x - first.x) / run) * PORTION_SEAM_PX,
      y: first.y - ((second.y - first.y) / run) * PORTION_SEAM_PX,
    };
  }
  const path = new Path2D();
  px.forEach((at, index) => (index === 0 ? path.moveTo(at.x, at.y) : path.lineTo(at.x, at.y)));
  return path;
}

interface EruptingPortion {
  path: Path2D;
  alpha: number;
  widthScale: number;
  destTrack: number;
}

/** One pass of the rail pen over erupting portions (#1469), each at its own opacity and swollen width. Butt-capped
 *  with round joins, as `strokeTrackLayers` strokes every rail, so a portion swells across the rail, not along it. */
function strokeErupting(ctx: CanvasRenderingContext2D, portions: readonly EruptingPortion[], color: string, width: number): void {
  if (portions.length === 0) return;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  ctx.strokeStyle = color;
  for (const portion of portions) {
    ctx.globalAlpha = portion.alpha;
    ctx.lineWidth = width * portion.widthScale;
    ctx.stroke(portion.path);
  }
  ctx.restore();
}

/* All ink bands first, then all white interiors, so shapes that overlap -- a pill extruding into a triangle,
   two cities growing a neck -- read as ONE outline with no ink inside it. Then the slot rings, as the union of
   their circles, so a dividing slot is one pinched outline rather than two rings crossing. A proposal's centre is
   inked in the washed palette; its white is paper and stays white (#1471). */
function drawCity(ctx: CanvasRenderingContext2D, center: Point, size: number, city: FrameCity, wash: number): void {
  if (city.alpha <= 0) return;
  const cityInk = wash > 0 ? provisionalColor(STANDARD_TRACK_INK, wash) : STANDARD_TRACK_INK;
  const markerPx = city.markerScale * size;
  const rim = Math.max(2, markerPx * 0.06);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const pass = (color: string, grow: number) => {
    for (const blob of city.blobs) {
      const radius = blob.radius * size + grow;
      const alpha = city.alpha * (blob.alpha ?? 1);
      if (radius <= 0 || blob.points.length === 0 || alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      if (coincident(blob.points)) {
        const at = toPx(center, size, blob.points[0]);
        ctx.beginPath();
        ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const closed = blob.closed && blob.points.length >= 3;
      const path = pathThrough(center, size, blob.points, closed);
      ctx.lineWidth = radius * 2;
      ctx.stroke(path);
      if (closed) ctx.fill(path);
    }
  };
  pass(cityInk, rim / 2);
  pass("#ffffff", -rim / 2);

  const ringWidth = Math.max(1, markerPx * 0.03);
  ctx.strokeStyle = cityInk;
  const strokeArc = (ring: FrameRing, start: number, end: number, alpha: number) => {
    if (alpha <= 0 || ring.radius <= 0) return;
    const at = toPx(center, size, ring.at);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = ringWidth * ring.lineScale;
    ctx.beginPath();
    ctx.arc(at.x, at.y, ring.radius * size, start, end);
    ctx.stroke();
  };
  if (city.ringsWhole >= 1) {
    // Whole circles, each stroked once -- the printed drawing, crossings included: the old tile's before the slots
    // move, the destination's once they settle.
    for (const ring of city.rings) strokeArc(ring, 0, Math.PI * 2, city.alpha * ring.alpha);
  } else {
    // In between, the union's outline, with the arcs it leaves out -- where one ring runs inside another -- at the
    // circles' wholeness. Those arcs are the union's complement, never a second stroke over it: a ring stroked twice
    // antialiases heavier, and the hand-over to the tile pass would visibly thin every ring on the hex.
    const union = ringUnionArcs(city.rings);
    for (const arc of union) strokeArc(city.rings[arc.ring], arc.start, arc.end, city.alpha * city.rings[arc.ring].alpha);
    if (city.ringsWhole > 0) {
      for (const arc of ringCoveredArcs(city.rings, union)) {
        const ring = city.rings[arc.ring];
        strokeArc(ring, arc.start, arc.end, city.alpha * ring.alpha * city.ringsWhole);
      }
    }
  }
  ctx.restore();
}
