// frontend/src/components/tileTransition.ts
//
// VF-5: the tile-lay and tile-upgrade flourish -- the DESCRIPTION half. Pure: no canvas, no React, no Path2D.
// It also describes the proposal a lay is chosen as and confirmed from (#1471).
// The painter is `tileTransitionCanvas.ts`; the staging (when a transition starts, what supersedes it, when
// the authoritative tile takes over) lives in `HexGridRenderer.tsx`.
//
// ==================================================================
//  DESIGN NOTE 1460: A TRANSITION IS TWO ARTWORKS AND THE GEOMETRY BETWEEN THEM
// ==================================================================
//
// ASKED FOR: a confirmed lay or upgrade that visibly transforms the old hex into the new one -- "existing
// infrastructure persists -> city geometry mutates where necessary -> genuinely new track rapidly constructs
// itself -> final geometry settles -> destination tile colour washes in as the completion cue". (#1471: the cue is
// now a commit reveal, and a lay confirmed on this board starts from its proposal rather than from the old hex.)
//
// EVERYTHING HERE IS READ OFF THE ARTWORK THE BOARD ALREADY DRAWS, and nothing is read off a rule. A laid tile
// is `TILE_GRAPHICS_CATALOG` at its orientation; an unlaid hex is exactly what `HexGridRenderer`'s printed
// passes paint there (a landmark's printed track, an OO pair, a town or city designation, or nothing). Both
// become one `HexArt`: rails as sampled polylines and revenue centres as markers, in BOARD unit-hex space
// (rotation applied), so the two sides of a transition are comparable point for point.
//
// WHAT THIS MODULE DOES NOT DO, and must not grow into: decide whether an upgrade was legal, which orientation
// was chosen, where a token belongs, or which city a corporation's network reaches. The transition is built
// from an old/new pair that has already happened; tokens are positioned by the renderer from authoritative
// state and only MOVED here (#1466). If the artwork cannot describe either side the plan is `null` and the
// board simply draws the authoritative tile.
//
// ==================================================================
//  DESIGN NOTE 1461: A RAIL IS SPLIT AT ITS REVENUE CENTRES, AND ONLY UNMATCHED PIECES ARE BUILT
// ==================================================================
//
// THE UNIT OF COMPARISON IS A PIECE, not an authored track. Tile #57 authors ONE straight through its city;
// #14 authors FOUR spokes into it. Compared as tracks they share nothing; compared as pieces between nodes --
// an edge midpoint or a revenue centre -- #57 is `edge0<->city` and `city<->edge3`, and #14 carries both of
// those unchanged plus two more. So every authored rail is cut wherever a marker sits on it (every marker in
// the catalog lies on its own rail to within 0.002 unit, measured), and a piece is named by its two nodes.
//
// THREE CLASSES, and the renderer treats them three ways:
//   PERSISTENT    the same nodes and the same pixels -- drawn still, never redrawn as construction.
//   RECONFIGURED  the same nodes (after city correspondence, #1462) but different geometry: Baltimore's printed
//                 curve becoming #53's spokes, New York's stubs becoming #54's curves, two towns' rails
//                 straightening into #88's hub. Morphed point for point, never "built".
//   ADDED         no counterpart -- the only pieces that construct themselves (#1467, #1469).
// A piece of the OLD tile with no counterpart fades; a legal upgrade never produces one, and the arm exists so
// an unexpected pair resolves to the destination rather than leaving an orphaned stroke.
//
// PERSISTENCE OF NETWORK MEANING, NOT OF PIXELS: a reconfigured piece keeps its identity because its NODES
// persist, which is why a city that moves drags its rails with it instead of the rails being rebuilt.

import { TILE_CATALOG_BY_ID, type TileColorTier } from "./hexTileCatalog";
import {
  PILL_SLOT_SPACING,
  SLOT_RING_RATIO,
  STATION_RADIUS_RATIO,
  TILE_GRAPHICS_CATALOG,
  markerSizeFor,
  printedMarkersFor,
  printedTracksFor,
  slotOffsets,
  trackCrossingsFor,
  trackLayersFor,
  type TileArtworkMarker,
} from "./TileGraphics";
import {
  COLOR_TIER_STROKE,
  ERA_TILE_FILL,
  LANDMARK_HEXES,
  STATIC_BOARD_HEXES,
  STANDARD_TRACK_INK,
  TILE_TRACK_INK,
  YELLOW_OO_HEXES,
} from "./hexBoardData";
import { twoNodePositions } from "./hexGeometry";

/* ------------------------------------------------------------------ */
/* Geometry primitives                                                */
/* ------------------------------------------------------------------ */

export interface Vec {
  x: number;
  y: number;
}

/* Exact at both ends, so the first frame IS the old art and the last frame IS the new art -- no float residue for
   the hand-over to reveal. */
const lerp = (a: number, b: number, t: number) => (t <= 0 ? a : t >= 1 ? b : a + (b - a) * t);
const lerpVec = (a: Vec, b: Vec, t: number): Vec => (t <= 0 ? a : t >= 1 ? b : { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });

/** Where `t` sits inside `[start, end]`, clamped to 0..1. */
export function windowProgress(t: number, start: number, end: number): number {
  if (end <= start) return t >= end ? 1 : 0;
  return clamp01((t - start) / (end - start));
}

export function smoothstep(u: number): number {
  const v = clamp01(u);
  return v * v * (3 - 2 * v);
}

/** A CSS-style cubic Bezier easing (x1, y1, x2, y2), solved for `x` by Newton steps with a bisection fallback. */
function cubicBezierEasing(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const coord = (a: number, b: number, s: number) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  const slope = (a: number, b: number, s: number) =>
    3 * a * (1 - s) * (1 - s) + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  return (u: number) => {
    const x = clamp01(u);
    if (x === 0 || x === 1) return x;
    let s = x;
    for (let i = 0; i < 6; i += 1) {
      const error = coord(x1, x2, s) - x;
      const d = slope(x1, x2, s);
      if (Math.abs(error) < 1e-6) break;
      if (Math.abs(d) < 1e-6) break;
      s = clamp01(s - error / d);
    }
    if (Math.abs(coord(x1, x2, s) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 30; i += 1) {
        s = (lo + hi) / 2;
        if (coord(x1, x2, s) < x) lo = s;
        else hi = s;
      }
    }
    return coord(y1, y2, s);
  };
}

/* ==================================================================
 *  DESIGN NOTE 1464: THE TIMELINE -- GEOMETRY FIRST, THE COMMIT AS THE COMPLETION CUE
 * ==================================================================
 * One table for every time in the module. "Do not treat these as fixed percentages unless the architecture makes
 * that appropriate" -- they are named here so a playtest can move them in one place, and nothing else in the
 * module states a time.
 *
 * GEOMETRY RUNS ON A LONG SETTLE. The ease is a soft-start, long-tail curve, so by the moment the completion cue
 * begins (0.68 of the full sequence) roughly nine tenths of every movement has happened and what remains is
 * settling. That remainder finishes under the cue, so the cue is never a separate pause after the geometry has
 * stopped. (#1471 replaced the cue: it was a 512 ms destination-colour wash, and is a 240 ms commit reveal.)
 *
 * CONSTRUCTION HAS SETTLED BEFORE THE CUE BEGINS, so nothing is committed while a rail is still being laid.
 *
 * MACRO SPACING, MICRO SNAP (revised: 850 ms became 1600 ms). Asked for: "stretch the spacing and travel of major
 * events; do not turn every small pop into slow motion." So the table holds two kinds of time.
 *   MACRO -- fractions of the full sequence's 1600 ms span: when the old tile starts to give way, when construction
 *     starts and how far its front travels, how long outlines extend and slots spread, when the cue arrives. A
 *     longer span spaces these out, and every one keeps its place in the sequence and its overlaps.
 *   MICRO -- `BEAT_MS`, absolute milliseconds: the shake, a slot's pulse with the split and the gained slot
 *     inside it, the rings appearing, one rail portion erupting, the reveal. Each is hung on a macro placement and
 *     keeps the length it was approved at, so a longer span moves the beat without slowing it.
 * THE TABLE IS THE FULL SEQUENCE -- new rail, a station mutation, geometry and the commit all at once: the shake
 * 32-168 ms while the hex still reads as it did; construction from 200 ms; a slot's pulse from 320 ms, a 2 -> 3
 * city's gained slot emerging from 388 ms and slots splitting from 439 ms; the reveal from 1088 ms; everything
 * committed at 1328 ms. A transition without some of those parts runs only as long as its own parts need (#1470).
 * Reduced motion keeps its own short fade and uses none of this. */
/** The full sequence the table is written against: every macro placement is a fraction of this span (#1464). */
export const TIMELINE_SPAN_MS = 1600;
/** Reduced motion: a quick local fade (#1465, #1471). */
export const TILE_TRANSITION_REDUCED_MS = 240;

/** The micro beats: local effects whose LENGTH is absolute (see above), each the length it had when approved. */
export const BEAT_MS = {
  /** A city gaining capacity, or merging, shakes one and a half cycles in this long. */
  tension: 136,
  /** A slot's pulse. */
  pulse: 187,
  /** A lone circle's slot rings fade in this fast as its pulse begins. */
  ringsAppear: 85,
  /** This far into the pulse a gained slot starts to emerge from the gathered system, and merging cities start
   *  growing their neck. */
  gainedSlot: 68,
  /** This far into the pulse the slots start to separate. */
  split: 119,
  /** This far into the pulse gathering slots have closed in. */
  gathered: 170,
  /** One portion of new rail, from the front reaching it to settled at exactly the board's pen (#1469). */
  portionSettle: 68,
  /** The least a transition holds before its first change: the lead the full sequence itself gives before any of its
   *  geometry moves (0.08 of the span). A confirmed proposal's changing centres recede behind their own moving parts
   *  over it, and a lay nobody proposed on this board shows its proposal over it (#1471). Only a transition with
   *  nothing to change but its commit begins the reveal here (#1470). */
  lead: 128,
  /** The commit reveal: one narrow front crossing the hex, the completion cue (#1471). */
  reveal: 240,
} as const;

/** A micro beat as a fraction of the span. */
const beat = (ms: number) => ms / TIMELINE_SPAN_MS;
/** The macro placements the micro beats hang from. */
const TENSION_AT = 0.02;
const PULSE_AT = 0.2;

export const TIMELINE = {
  /** A city gaining capacity, or merging, tenses briefly before it moves. */
  tension: [TENSION_AT, TENSION_AT + beat(BEAT_MS.tension)],
  /** City migration, reconfigured rails, and the enclosing outline: long settles whose last tenth is finished under
   *  the reveal (#1471). */
  geometry: [0.08, 1.0],
  outline: [0.12, 1.0],
  /** A single station slot pulses before it divides; several gather first. The pulse, the split and the gathered
   *  moment are micro beats inside it; the spreading that follows the split is macro. */
  pulse: [PULSE_AT, PULSE_AT + beat(BEAT_MS.pulse)],
  gather: [0.14, PULSE_AT + beat(BEAT_MS.gathered)],
  divide: [PULSE_AT + beat(BEAT_MS.split), 1.0],
  /** Merging cities grow a shared neck. */
  fuse: [PULSE_AT + beat(BEAT_MS.gainedSlot), 1.0],
  /** Genuinely new rail. A construction wave travels each added piece from its origin; a piece that continues from
   *  where another arrives starts when that wave arrives, and every wave has settled by the full sequence's reveal,
   *  so building never holds a transition past the full sequence (#1467, #1469, #1470). */
  construct: [0.125, 0.68],
  /** The longest the wave takes to travel one piece -- shorter only when a chain of pieces must fit the window. */
  constructTravel: 0.34,
  /** One portion of new rail, from the front reaching it to settled at exactly the board's width: a micro beat. */
  constructSettle: beat(BEAT_MS.portionSettle),
  /** A revenue centre with no predecessor appears; one with no successor goes. */
  emerge: [0.16, 0.62],
  vanish: [0.1, 0.55],
  /** The commit reveal starts here in the full sequence -- where the colour wash began (#1464) -- once construction
   *  has settled and every movement is about nine tenths done (#1471). */
  reveal: 0.68,
} as const;

/** The full sequence's length: its reveal's start, then the reveal (#1471). */
export const TILE_TRANSITION_MS = Math.round(TIMELINE.reveal * TIMELINE_SPAN_MS) + BEAT_MS.reveal;

const settleEase = cubicBezierEasing(0.32, 0, 0.14, 1);

/** How much of its long settle the existing geometry has travelled when new rail may start erupting out of it
 *  (#1475): enough for the reconfiguration to read as a repositioning, and far short of finished, so the two run
 *  together for the rest of the transition. */
export const RECONFIGURE_ESTABLISHED = 0.25;

/** When that moment falls, as a fraction of the span (#1475). Read back off `settleEase` over the geometry window --
 *  the very curve the migration and the morph are drawn on -- so the stagger moves with the table and states no
 *  second time of its own. The blend into the reveal (`settleInto`) begins long after this, and does not reach it. */
function reconfigureEstablishedAt(): number {
  const [start, end] = TIMELINE.geometry;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (settleEase(mid) < RECONFIGURE_ESTABLISHED) lo = mid;
    else hi = mid;
  }
  return start + ((lo + hi) / 2) * (end - start);
}

/** A macro window of the table in milliseconds. */
const spanMs = (window: readonly [number, number]): [number, number] => [window[0] * TIMELINE_SPAN_MS, window[1] * TIMELINE_SPAN_MS];
/** Where `ms` sits inside a macro window of the table, 0..1. */
const inWindow = (ms: number, window: readonly [number, number]): number => {
  const [start, end] = spanMs(window);
  return windowProgress(ms, start, end);
};

/** One transition's own clock (#1470, #1471). Every placement in the table keeps its milliseconds in every
 *  transition; what depends on the transition is only when its reveal starts and when it ends. */
export interface TransitionClock {
  /** The commit reveal begins, ms. */
  revealStart: number;
  /** The reveal has crossed the hex and the transition is over, ms. */
  end: number;
}

/* ==================================================================
 *  DESIGN NOTE 1470: A TRANSITION TAKES THE TIME ITS OWN CHANGES NEED
 * ==================================================================
 * REPORTED: under one fixed 1600 ms clock the wash waits until 1088 ms whatever the transition holds, so a lay that
 * only changes colour "could appear to do essentially nothing for more than a second before its only meaningful
 * animation begins". ASKED FOR: 1600 ms is the FULL sequence, not a length every transition must fill -- "do not
 * reserve time for animation components that do not exist in the transition"; the completion cue still comes last,
 * but last after THIS transition's meaningful geometry.
 *
 * THE PARTS ARE READ OFF THE PLAN, never off a tile and never from a table of recipes. A transition has
 * CONSTRUCTION when it has added rail; a STATION MUTATION when a city's slot rings divide, reorganise or merge (the
 * choreographies of #1463, chosen by `ringChoreography`, which the frame uses too); GEOMETRY when rail reconfigures
 * or fades, or a revenue centre migrates, reshapes, merges, emerges or vanishes -- the plan's own classes, with
 * their own tolerances, and no new threshold.
 *
 * THE CUE BEGINS WHEN THE LAST PART PRESENT IS READY FOR IT, and the transition ends when the cue does. The cue
 * was the wash and is the commit reveal (#1471); the moment it begins is unchanged:
 *   nothing to change but the commit: after `BEAT_MS.lead`;
 *   construction: as its last rail portion settles (812 ms in every currently accepted lay that only builds);
 *   a station mutation or geometry: where the full sequence starts it, 1088 ms. Their movements settle on a long
 *     tail, and the full sequence starts the cue when they are about nine tenths done; any earlier and they would
 *     still be visibly moving under it. Keeping their look keeps that start.
 * So the full sequence ends at 1328 ms, construction alone at 1052 ms, a commit alone at 368 ms, and a mutation or
 * migration at 1328 ms -- its own movement, not an absent part, fills that time.
 *
 * NOTHING MOVES IN ABSOLUTE TIME. Every placement and every micro beat keeps its milliseconds whatever the
 * transition's length; the long settles finish under the reveal, wherever it falls. Construction therefore starts
 * at 200 ms and travels at the approved pace in every transition that builds.
 *
 * THE SEMANTIC BEATS audio attaches to (#1474) are the plan's `beats`, in milliseconds from the start:
 * `constructionStart` (the first added rail begins), `stationEmergence` (new slots begin to emerge: a 1 -> 2 or
 * 1 -> 3 city's split, a 2 -> 3 city's gained slot, a merge's added slots -- not the tension or the pulse before
 * them), `revealStart` (the commit reveal begins; #1471 renamed it from `colorWashStart`). Reduced motion builds
 * nothing and splits nothing, and its commit begins with its first frame. */
/* ==================================================================
 *  DESIGN NOTE 1475: THE EXISTING RAILROAD MOVES FIRST, AND NEW RAIL GROWS OUT OF IT
 * ==================================================================
 * REPORTED, of the transitions where existing geometry reconfigures AND new rail is added -- above all a B-style
 * upgrade, where a city and the track it carries move to another part of the hex: the two processes overlapped so
 * heavily that they did not read as one act of railroad work. Measured before this note, on Baltimore's printed
 * curve into #53: the geometry's long settle opens at 128 ms, construction erupts at 200 ms, and at that moment the
 * settle has carried the city 0.9% of its way -- under a hundredth of a pixel. New rail grew out of a network still
 * standing exactly where it had always stood.
 *
 * ASKED FOR: "existing infrastructure starts moving/reforming first -> the viewer understands the new base geometry
 * -> new rail construction begins out of that reorganizing network -> the latter part of migration may overlap
 * construction -> commit reveal" -- a STAGGERED OVERLAP, not a serial sequence, and no new waiting period for an
 * ordinary lay that has nothing to reconfigure.
 *
 * SO CONSTRUCTION WAITS FOR THE RECONFIGURATION TO ESTABLISH ITSELF, and only where there is one. A transition
 * RECONFIGURES when existing infrastructure repositions or reforms: `trackWork` (below), or a revenue centre with a
 * predecessor whose drawing MOVES at least as far as a reformed rail does. Distance, not the event's name: a centre
 * with no predecessor is not existing infrastructure; a city that gains a slot where it stands is a station mutation
 * (#1463), not a repositioning; and a city re-laid in its own place with slightly different slots moves nothing at
 * all and waits for nothing. In such a transition the construction window opens where
 * the settle has carried the existing geometry `RECONFIGURE_ESTABLISHED` of its way, read back off the settle itself
 * rather than stated as a second time; every other transition keeps the table's own 200 ms, unchanged.
 *
 * THE OVERLAP IS THE POINT. The stagger is a quarter of the settle -- the reconfiguration is a quarter travelled and
 * three quarters still to come when the first rail erupts, so the two run together for the rest of the transition
 * and converge on the same geometry. Construction's travel, its portions, the eruption and every other beat keep
 * their own lengths, and the stagger fits inside the construction window the table already reserves, so no
 * transition grows: the reveal of a reconfiguring transition is its geometry's, at 1088 ms, as it always was.
 *
 * RAILROAD WORK IS ONE CUE, NOT TWO (#1474's `track.mp3`). The clip no longer means "genuinely new rail begins"; it
 * means MEANINGFUL RAILROAD TRACK WORK HAS BEGUN -- existing rail reforming, rail being taken up, or new rail
 * erupting -- so `railroadWorkStart` is the earliest of those a transition has, and the clip sounds there, once. A
 * B-style upgrade sounds it as its track starts to reform and adds nothing when the eruption follows; an ordinary
 * lay sounds it exactly where it did, at the eruption. What is NOT railroad work: a station's rings changing
 * capacity, a token or a reservation marker moving, the commit front, a city changing shape while its rails are
 * only redrawn, a transition that changes nothing but its colour. `trackWork` is the classification's own answer
 * (#1461) with one threshold: a reconfigured piece that moves at least half a rail width has physically reformed,
 * and one that moves less is the same rail redrawn. */
export interface TransitionComponents {
  /** Genuinely added rail builds (#1467, #1469). */
  construction: boolean;
  /** A city's slot rings divide, reorganise or merge (#1463). */
  stationMutation: boolean;
  /** Rail reconfigures or fades, or a revenue centre migrates, reshapes, merges, emerges or vanishes (#1461, #1462). */
  geometry: boolean;
  /** EXISTING rail physically reforms: a reconfigured piece that moves at least half a rail width, or a piece taken
   *  up. Railroad work, like building -- and the same cue (#1475). */
  trackWork: boolean;
  /** Existing infrastructure repositions or reforms, so new rail has something to grow out of: `trackWork`, or a
   *  revenue centre whose drawing moves at least half a rail width (#1475). */
  reconfiguration: boolean;
}

/** The moments audio attaches to, in milliseconds from the start of the transition (#1470, #1471). */
export interface TransitionBeats {
  /** Meaningful railroad work begins: the earliest of existing track reforming, rail being taken up and the first
   *  added rail. Null when the transition does no track work at all (#1475). */
  railroadWorkStart: number | null;
  /** The first genuinely added rail begins to build; null when nothing is built. In a transition that reconfigures,
   *  this is the staggered start -- after the reconfiguration has established itself (#1475). */
  constructionStart: number | null;
  /** New station slots begin to emerge; null when no city gains a slot. */
  stationEmergence: number | null;
  /** The commit reveal begins. */
  revealStart: number;
}

/** The easings the renderer needs outside the frame (token and reservation motion). */
export interface TransitionEasings {
  /** Migration, reconfiguration and a token's ride with its city: the long settle, finished under the reveal. */
  geometry: number;
  /** Slots spreading after a split, and a token's move within its city. */
  slots: number;
  /** The commit: 0 until the reveal begins, 1 once it has crossed -- or, under reduced motion, the fade. */
  reveal: number;
}

/** A long movement's ease (#1464), its last tenth finished under the reveal (#1471): exactly the approved settle
 *  until the reveal begins, and exactly 1 when the transition ends. */
function settleInto(plan: TileTransitionPlan, ms: number, window: readonly [number, number]): number {
  const [start, end] = spanMs(window);
  const raw = settleEase(windowProgress(ms, start, end));
  const u = windowProgress(ms, plan.clock.revealStart, plan.clock.end);
  return u >= 1 ? 1 : raw + (1 - raw) * smoothstep(u);
}

/** Where the hand-overs that close a transition stand: the slot rings closing into whole circles, a merge's
 *  outlines giving way to the one shape they became. They run with the reveal. */
function settling(plan: TileTransitionPlan, ms: number): number {
  return smoothstep(windowProgress(ms, plan.clock.revealStart, plan.clock.end));
}

export function transitionEasings(plan: TileTransitionPlan, t: number): TransitionEasings {
  if (plan.reducedMotion) {
    const a = smoothstep(t);
    return { geometry: a, slots: a, reveal: a };
  }
  const ms = clamp01(t) * plan.durationMs;
  return {
    geometry: settleInto(plan, ms, TIMELINE.geometry),
    slots: settleInto(plan, ms, TIMELINE.divide),
    reveal: settling(plan, ms),
  };
}

/* ------------------------------------------------------------------ */
/* One hex's artwork, in board unit-hex space                          */
/* ------------------------------------------------------------------ */

export interface ArtMarker {
  kind: "city" | "town";
  /** Board unit-hex space, the tile's rotation applied. */
  at: Vec;
  /** Station slots; 1 for a town. */
  slots: number;
  /** The slot cluster's axis in board space -- the authored angle minus the tile's turn. */
  angle: number;
  layout: "pill" | "triangle" | "square";
  /** The marker size as a fraction of the hex (`markerSizeFor`), which is what every radius scales from. */
  scale: number;
}

export interface ArtTrack {
  /** The authored `d` string in the artwork's own (unrotated) space -- the layer and crossing derivations read it. */
  d: string;
  /** Dense uniform-parameter samples in board space. */
  samples: Vec[];
}

export interface HexArt {
  tracks: ArtTrack[];
  markers: ArtMarker[];
  /** The tile tier painted on the hex, or `null` where the board itself shows (an unlaid hex). */
  tier: TileColorTier | null;
  /** Degrees the authored artwork is turned by -- the tile's orientation times -60, or 0 for printed art. */
  turnDeg: number;
}

const TRACK_SAMPLES = 120;

function rotateVec(v: Vec, deg: number): Vec {
  if (deg === 0) return v;
  const radians = (deg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

/** Samples one authored rail. The catalog authors every rail as one `M` plus one `L` or `C` (#244); anything
 *  else returns `null`, which makes the whole plan `null` rather than a guessed shape. */
function sampleTrack(d: string, turnDeg: number): Vec[] | null {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let at: (t: number) => Vec;
  if (/\sL\s/.test(d) && n.length === 4) {
    at = (t) => ({ x: lerp(n[0], n[2], t), y: lerp(n[1], n[3], t) });
  } else if (/\sC\s/.test(d) && n.length === 8) {
    at = (t) => {
      const u = 1 - t;
      return {
        x: u * u * u * n[0] + 3 * u * u * t * n[2] + 3 * u * t * t * n[4] + t * t * t * n[6],
        y: u * u * u * n[1] + 3 * u * u * t * n[3] + 3 * u * t * t * n[5] + t * t * t * n[7],
      };
    };
  } else {
    return null;
  }
  const out: Vec[] = [];
  for (let i = 0; i <= TRACK_SAMPLES; i += 1) out.push(rotateVec(at(i / TRACK_SAMPLES), turnDeg));
  return out;
}

function markerFrom(marker: TileArtworkMarker, turnDeg: number, markerScale: number): ArtMarker {
  return {
    kind: marker.kind,
    at: rotateVec(marker.at, turnDeg),
    slots: marker.kind === "town" ? 1 : Math.max(1, marker.slots ?? 1),
    angle: (marker.angle ?? 0) + turnDeg,
    layout: marker.layout ?? "pill",
    scale: markerScale,
  };
}

function buildArt(
  tracks: readonly string[],
  markers: ArtMarker[],
  tier: TileColorTier | null,
  turnDeg: number,
): HexArt | null {
  const built: ArtTrack[] = [];
  for (const d of tracks) {
    const samples = sampleTrack(d, turnDeg);
    if (!samples) return null;
    built.push({ d, samples });
  }
  return { tracks: built, markers, tier, turnDeg };
}

/** A laid tile's artwork at its orientation, or `null` for an id with no authored artwork. */
export function hexArtForTile(tileId: number, orientation: number): HexArt | null {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  if (!art || !entry) return null;
  const rot = ((orientation % 6) + 6) % 6;
  const turnDeg = -60 * rot;
  const markerScale = markerSizeFor(art.markers, 1);
  return buildArt(
    art.tracks,
    art.markers.map((marker) => markerFrom(marker, turnDeg, markerScale)),
    entry.color,
    turnDeg,
  );
}

/** What `HexGridRenderer` paints on an UNLAID hex, as artwork -- the same tables, in the same order its
 *  printed passes consult them: a landmark's printed track and stations, then the yellow OO pair, then a town
 *  or city designation, and otherwise nothing at all. Gray and off-board hexes are never laid on and are not
 *  described. `null` only for a label this board does not know. */
export function hexArtForPrinted(label: string): HexArt | null {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  const landmark = LANDMARK_HEXES.some((entry) => entry.label === label);
  if (!hex && !landmark) return null;

  if (landmark) {
    const markers = printedMarkersFor(label);
    const markerScale = markerSizeFor(markers, 1);
    return buildArt(
      printedTracksFor(label) ?? [],
      markers.map((marker) => markerFrom(marker, 0, markerScale)),
      null,
      0,
    );
  }
  const [node0, node1] = twoNodePositions({ x: 0, y: 0 }, 1);
  const point = (at: Vec, kind: "city" | "town", markerScale: number): ArtMarker => ({
    kind,
    at,
    slots: 1,
    angle: 0,
    layout: "pill",
    scale: markerScale,
  });
  // `drawOOCityMarkers`: two full-size circles on the shared diagonal, no track.
  if (hex && YELLOW_OO_HEXES.has(label)) {
    return buildArt([], [point(node0, "city", 1), point(node1, "city", 1)], null, 0);
  }
  // The designation passes: two dits at 0.85 on the diagonal, one dit or one circle at the centre.
  if (hex?.townDesignation === "double") {
    return buildArt([], [point(node0, "town", 0.85), point(node1, "town", 0.85)], null, 0);
  }
  if (hex?.townDesignation === "single") return buildArt([], [point({ x: 0, y: 0 }, "town", 1)], null, 0);
  if (hex?.cityDesignation) return buildArt([], [point({ x: 0, y: 0 }, "city", 1)], null, 0);
  return buildArt([], [], null, 0);
}

/* ------------------------------------------------------------------ */
/* Pieces                                                             */
/* ------------------------------------------------------------------ */

export type PieceNode = { kind: "edge"; edge: number } | { kind: "marker"; index: number } | { kind: "free"; id: number };

export interface Piece {
  from: PieceNode;
  to: PieceNode;
  /** Arc-length resampled, oriented `from` -> `to`. */
  points: Vec[];
  /** Index into the art's `tracks`. */
  track: number;
}

const PIECE_POINTS = 24;
/** A marker counts as ON a rail within this distance; the catalog's worst is 0.0016 (#1461). */
const ON_RAIL = 0.02;
const EDGE_MIDPOINT_RADIUS = Math.sqrt(3) / 2;

function edgeAt(point: Vec): number | null {
  for (let edge = 0; edge < 6; edge += 1) {
    const angle = (-60 * edge * Math.PI) / 180;
    const mid = { x: EDGE_MIDPOINT_RADIUS * Math.cos(angle), y: EDGE_MIDPOINT_RADIUS * Math.sin(angle) };
    if (dist(point, mid) < 0.03) return edge;
  }
  return null;
}

function polylineLength(points: readonly Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i]);
  return total;
}

/** `count` points spaced evenly by arc length along `points`. */
export function resample(points: readonly Vec[], count: number): Vec[] {
  if (points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: count }, () => points[0]);
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) cumulative.push(cumulative[i - 1] + dist(points[i - 1], points[i]));
  const total = cumulative[cumulative.length - 1];
  const out: Vec[] = [];
  let segment = 1;
  for (let k = 0; k < count; k += 1) {
    const target = count === 1 ? 0 : (total * k) / (count - 1);
    while (segment < points.length - 1 && cumulative[segment] < target) segment += 1;
    const a = cumulative[segment - 1];
    const b = cumulative[segment];
    const u = b - a < 1e-12 ? 0 : (target - a) / (b - a);
    out.push(lerpVec(points[segment - 1], points[segment], clamp01(u)));
  }
  out[0] = points[0];
  out[count - 1] = points[points.length - 1];
  return out;
}

/** Every rail of `art`, cut at the markers that sit on it. */
export function piecesOf(art: HexArt): Piece[] {
  const pieces: Piece[] = [];
  let freeId = 0;
  art.tracks.forEach((track, trackIndex) => {
    const samples = track.samples;
    const last = samples.length - 1;
    const nodeAtEnd = (point: Vec): PieceNode => {
      const edge = edgeAt(point);
      if (edge !== null) return { kind: "edge", edge };
      const marker = art.markers.findIndex((m) => dist(m.at, point) < ON_RAIL);
      if (marker >= 0) return { kind: "marker", index: marker };
      freeId += 1;
      return { kind: "free", id: freeId };
    };
    const startNode = nodeAtEnd(samples[0]);
    const endNode = nodeAtEnd(samples[last]);

    const cuts: Array<{ index: number; marker: number }> = [];
    art.markers.forEach((marker, markerIndex) => {
      if (startNode.kind === "marker" && startNode.index === markerIndex) return;
      if (endNode.kind === "marker" && endNode.index === markerIndex) return;
      let best = -1;
      let bestDistance = Infinity;
      samples.forEach((point, index) => {
        const d = dist(point, marker.at);
        if (d < bestDistance) {
          bestDistance = d;
          best = index;
        }
      });
      if (best > 0 && best < last && bestDistance < ON_RAIL * 4) cuts.push({ index: best, marker: markerIndex });
    });
    cuts.sort((a, b) => a.index - b.index);

    const bounds: Array<{ index: number; node: PieceNode; at: Vec }> = [
      { index: 0, node: startNode, at: samples[0] },
      ...cuts.map((cut) => ({ index: cut.index, node: { kind: "marker", index: cut.marker } as PieceNode, at: art.markers[cut.marker].at })),
      { index: last, node: endNode, at: samples[last] },
    ];
    for (let b = 1; b < bounds.length; b += 1) {
      const from = bounds[b - 1];
      const to = bounds[b];
      if (to.index <= from.index) continue;
      const raw = samples.slice(from.index, to.index + 1);
      raw[0] = from.at;
      raw[raw.length - 1] = to.at;
      if (polylineLength(raw) < 0.02) continue;
      pieces.push({ from: from.node, to: to.node, points: resample(raw, PIECE_POINTS), track: trackIndex });
    }
  });
  return pieces;
}

/** Edges each marker reaches directly through one piece. */
function markerEdges(art: HexArt, pieces: readonly Piece[]): Array<Set<number>> {
  const edges = art.markers.map(() => new Set<number>());
  for (const piece of pieces) {
    const ends = [piece.from, piece.to];
    const marker = ends.find((node) => node.kind === "marker") as { kind: "marker"; index: number } | undefined;
    const edge = ends.find((node) => node.kind === "edge") as { kind: "edge"; edge: number } | undefined;
    if (marker && edge) edges[marker.index].add(edge.edge);
  }
  return edges;
}

/* ==================================================================
 *  DESIGN NOTE 1462: CITIES CORRESPOND BY THE RAILS THEY OWN, THEN BY WHERE THEY STAND
 * ==================================================================
 * A revenue centre on the old art is the SAME centre on the new art when the edges it reaches are still
 * reached by one centre of the same kind. That is the whole test, and it is geometry: it asks which edges a
 * marker's own pieces touch, which the drawing already fixes.
 *
 * WHAT FALLS OUT OF IT, rather than being listed:
 *   one city whose slot count changes -- CAPACITY (#57 -> #14, #63 -> #513, #53 -> #884);
 *   one city whose marker moves -- MIGRATION (Baltimore/Boston to #53, New York's stubs to #54, the OO spurs
 *     to the brown OO curves, #3's apex town to #141's hub);
 *   several centres whose edges all land on one, leaving fewer centres of their kind -- a GENUINE MERGE
 *     (#54 -> #883; every double town to #87/#88/#204);
 *   a centre with no predecessor -- it EMERGES. Of the transitions the placement filter currently accepts, only
 *     #59 -> brown OO facings that put both #59 cities' rails into one brown city produce one; fixed OO, the
 *     rule this implementation plays, keeps each #59 city its own brown city, so those facings are rules-illegal
 *     (VISUAL_FLOURISH_BACKLOG.md D-22). The matcher describes such a pair as its geometry reads, a merge beside
 *     an emergence; nothing here takes that as a merge.
 * Slot count is never how a city is identified: a two-slot city is one city, and #883's four slots are one.
 *
 * AN UNCONNECTED CENTRE HAS NO EDGES TO ASK -- the printed OO circles and the designation dits. Those pair
 * with the nearest unclaimed centre of their kind, one to one, which is a statement about where things are
 * drawn and nothing else. Tokens never follow this pairing; they follow authoritative state (#1466). */
export interface CityPlan {
  kind: "city" | "town";
  /** The destination marker (index into the destination art's markers). */
  dest: number;
  /** Source marker indices on the old art. */
  sources: number[];
  event: "static" | "migrate" | "capacity" | "reshape" | "merge" | "emerge";
  /** A capacity change that also moves. */
  migrates: boolean;
}

function assignMarkers(fromArt: HexArt, fromPieces: readonly Piece[], toArt: HexArt, toPieces: readonly Piece[]): Array<number | null> {
  const fromEdges = markerEdges(fromArt, fromPieces);
  const toEdges = markerEdges(toArt, toPieces);
  const mapping: Array<number | null> = fromArt.markers.map(() => null);

  fromArt.markers.forEach((marker, i) => {
    const own = fromEdges[i];
    if (own.size === 0) return;
    let best: { j: number; contains: boolean; overlap: number; d: number } | null = null;
    toArt.markers.forEach((candidate, j) => {
      if (candidate.kind !== marker.kind) return;
      const theirs = toEdges[j];
      let overlap = 0;
      own.forEach((edge) => {
        if (theirs.has(edge)) overlap += 1;
      });
      if (overlap === 0) return;
      const contains = overlap === own.size;
      const d = dist(marker.at, candidate.at);
      const better =
        best === null ||
        (contains && !best.contains) ||
        (contains === best.contains && (overlap > best.overlap || (overlap === best.overlap && d < best.d)));
      if (better) best = { j, contains, overlap, d };
    });
    if (best !== null) mapping[i] = (best as { j: number }).j;
  });

  // Unconnected centres: nearest unclaimed of their kind, one to one, closest pairs first.
  const claimed = new Set<number>();
  mapping.forEach((j) => {
    if (j !== null) claimed.add(j);
  });
  const pairs: Array<{ i: number; j: number; d: number }> = [];
  fromArt.markers.forEach((marker, i) => {
    if (mapping[i] !== null) return;
    toArt.markers.forEach((candidate, j) => {
      if (candidate.kind === marker.kind && !claimed.has(j)) pairs.push({ i, j, d: dist(marker.at, candidate.at) });
    });
  });
  pairs.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);
  const usedFrom = new Set<number>();
  for (const pair of pairs) {
    if (usedFrom.has(pair.i) || claimed.has(pair.j)) continue;
    mapping[pair.i] = pair.j;
    usedFrom.add(pair.i);
    claimed.add(pair.j);
  }
  // Anything still unpaired joins the nearest centre of its kind (a revenue centre persists; it does not vanish).
  fromArt.markers.forEach((marker, i) => {
    if (mapping[i] !== null) return;
    let bestJ: number | null = null;
    let bestD = Infinity;
    toArt.markers.forEach((candidate, j) => {
      if (candidate.kind !== marker.kind) return;
      const d = dist(marker.at, candidate.at);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    });
    mapping[i] = bestJ;
  });
  return mapping;
}

/* ------------------------------------------------------------------ */
/* Station geometry                                                   */
/* ------------------------------------------------------------------ */

function slotSpacing(marker: ArtMarker): number {
  return PILL_SLOT_SPACING * marker.scale * STATION_RADIUS_RATIO;
}

/** Slot centres in board unit space, in the order `tileCitySlotPoints` returns them. */
export function slotCentres(marker: ArtMarker): Vec[] {
  if (marker.kind === "town" || marker.slots <= 1) return [marker.at];
  return slotOffsets(marker.slots, marker.layout, slotSpacing(marker), marker.angle).map((offset) => add(marker.at, offset));
}

/** The path the station outline is the fattened stroke of: one point for a circle, the two end slots for a
 *  pill, and the slot centres in cluster order (closed) for a triangle or square -- exactly what
 *  `drawStationCircle`, `drawStationPill` and `drawStationCluster` draw. */
export function outlineOf(marker: ArtMarker): { points: Vec[]; closed: boolean } {
  if (marker.kind === "town" || marker.slots <= 1) return { points: [marker.at], closed: false };
  const centres = slotCentres(marker);
  if (marker.layout === "triangle" || marker.layout === "square") return { points: centres, closed: true };
  return { points: [centres[0], centres[centres.length - 1]], closed: false };
}

/** Cheapest one-to-one pairing of `from` onto `to` (small sets: exhaustive up to 6, greedy beyond). */
function assignPoints(from: readonly Vec[], to: readonly Vec[]): number[] {
  const n = from.length;
  const m = to.length;
  if (n === 0) return [];
  if (n <= m && m <= 6) {
    let best: number[] = [];
    let bestCost = Infinity;
    const used: boolean[] = to.map(() => false);
    const current: number[] = [];
    const search = (i: number, cost: number) => {
      if (cost >= bestCost) return;
      if (i === n) {
        bestCost = cost;
        best = current.slice();
        return;
      }
      for (let j = 0; j < m; j += 1) {
        if (used[j]) continue;
        used[j] = true;
        current.push(j);
        search(i + 1, cost + dist(from[i], to[j]));
        current.pop();
        used[j] = false;
      }
    };
    search(0, 0);
    return best;
  }
  // More sources than targets (or large sets): each source to its nearest target.
  return from.map((point) => {
    let bestJ = 0;
    let bestD = Infinity;
    to.forEach((target, j) => {
      const d = dist(point, target);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    });
    return bestJ;
  });
}

function centroid(points: readonly Vec[]): Vec {
  if (points.length === 0) return { x: 0, y: 0 };
  const total = points.reduce((sum, p) => add(sum, p), { x: 0, y: 0 });
  return scale(total, 1 / points.length);
}

/* ------------------------------------------------------------------ */
/* The plan                                                           */
/* ------------------------------------------------------------------ */

export type TrackClass = "persistent" | "reconfigured" | "added" | "removed";

export interface TrackPlan {
  cls: TrackClass;
  /** Destination piece (for persistent / reconfigured / added). */
  to: Piece | null;
  /** Source piece (for persistent / reconfigured / removed), oriented to match `to`. */
  from: Piece | null;
  /** Added pieces: when the construction wave reaches the piece and how long it takes to settle there, in
   *  milliseconds from the start of the transition, and which end construction starts from. */
  startMs: number;
  durationMs: number;
  growsFromEnd: boolean;
  level: number;
}

export interface TileTransitionRequest {
  from: { kind: "tile"; tileId: number; orientation: number } | { kind: "printed"; label: string | null };
  to: { tileId: number; orientation: number };
  /** Board edges of this hex where a neighbour's rail arrives -- construction prefers to start there. */
  externalEdges?: readonly number[];
  reducedMotion?: boolean;
  /** The lay was confirmed from a proposal of exactly this tile at exactly this facing, drawn on the hex until this
   *  moment (#1471): the transition starts from that proposal rather than from the old tile. */
  provisional?: boolean;
}

export interface TileTransitionPlan {
  fromArt: HexArt;
  toArt: HexArt;
  tracks: TrackPlan[];
  cities: CityPlan[];
  /** Old markers with no destination at all (only an unexpected pair produces one). */
  vanishing: number[];
  /** The source marker each old marker became, for token anchoring. */
  markerMapping: Array<number | null>;
  fromTier: TileColorTier | null;
  toTier: TileColorTier;
  reducedMotion: boolean;
  /** Starts from the proposal the player confirmed (#1471). Otherwise the hex shows the old tile, which gives way to
   *  the proposal over the lead. */
  provisional: boolean;
  /** This transition's own length: its reveal's start and the reveal (#1470, #1471). */
  durationMs: number;
  /** Which parts it animates, its clock, and its semantic beats (#1470). */
  components: TransitionComponents;
  clock: TransitionClock;
  beats: TransitionBeats;
  /** Destination layer per destination track, and the destination's overpasses (board unit space). */
  destLayers: number[];
  destCrossings: Array<{ x: number; y: number; sinAngle: number; over: number }>;
}

const PERSIST_TOLERANCE = 0.015;

function nodeKey(node: PieceNode, mapping: ReadonlyArray<number | null> | null): string {
  if (node.kind === "edge") return `e${node.edge}`;
  if (node.kind === "free") return `f${node.id}`;
  if (mapping === null) return `m${node.index}`;
  const mapped = mapping[node.index];
  return mapped === null || mapped === undefined ? `o${node.index}` : `m${mapped}`;
}

function oriented(piece: Piece, mapping: ReadonlyArray<number | null> | null): { key: string; piece: Piece } {
  const a = nodeKey(piece.from, mapping);
  const b = nodeKey(piece.to, mapping);
  if (a <= b) return { key: `${a}|${b}`, piece };
  return {
    key: `${b}|${a}`,
    piece: { from: piece.to, to: piece.from, points: piece.points.slice().reverse(), track: piece.track },
  };
}

function maxPointDistance(a: readonly Vec[], b: readonly Vec[]): number {
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) worst = Math.max(worst, dist(a[i], b[i]));
  return worst;
}

/** The whole description of one old -> new transition, or `null` when either side has no artwork. */
export function planTileTransition(request: TileTransitionRequest): TileTransitionPlan | null {
  const fromArt =
    request.from.kind === "tile"
      ? hexArtForTile(request.from.tileId, request.from.orientation)
      : request.from.label === null
        ? buildArt([], [], null, 0)
        : hexArtForPrinted(request.from.label);
  const toArt = hexArtForTile(request.to.tileId, request.to.orientation);
  const toEntry = TILE_CATALOG_BY_ID.get(request.to.tileId);
  if (!fromArt || !toArt || !toEntry) return null;

  const fromPieces = piecesOf(fromArt);
  const toPieces = piecesOf(toArt);
  const mapping = assignMarkers(fromArt, fromPieces, toArt, toPieces);

  /* ---- cities ---- */
  const cities: CityPlan[] = toArt.markers.map((dest, j) => {
    const sources = mapping.flatMap((mapped, i) => (mapped === j ? [i] : []));
    let event: CityPlan["event"] = "static";
    let migrates = false;
    if (sources.length === 0) event = "emerge";
    else if (sources.length > 1) event = "merge";
    else {
      const source = fromArt.markers[sources[0]];
      migrates = dist(source.at, dest.at) > 0.01;
      if (dest.kind === "city" && source.slots !== dest.slots) event = "capacity";
      else if (migrates) event = "migrate";
      else if (dest.kind === "city") {
        const a = slotCentres(source);
        const b = slotCentres(dest);
        const order = assignPoints(a, b);
        const moved = a.some((point, k) => dist(point, b[order[k]]) > 0.005) || Math.abs(source.scale - dest.scale) > 1e-6;
        event = moved ? "reshape" : "static";
      }
    }
    return { kind: dest.kind, dest: j, sources, event, migrates };
  });
  const vanishing = mapping.flatMap((mapped, i) => (mapped === null ? [i] : []));

  /* ---- tracks ---- */
  const fromByKey = new Map<string, Piece[]>();
  fromPieces.forEach((piece) => {
    const { key, piece: o } = oriented(piece, mapping);
    fromByKey.set(key, [...(fromByKey.get(key) ?? []), o]);
  });
  const tracks: TrackPlan[] = [];
  const blank = { startMs: 0, durationMs: 0, growsFromEnd: false, level: 0 };
  toPieces.forEach((piece) => {
    const { key, piece: o } = oriented(piece, null);
    const candidates = fromByKey.get(key) ?? [];
    if (candidates.length === 0) {
      tracks.push({ cls: "added", to: o, from: null, ...blank });
      return;
    }
    let bestIndex = 0;
    let bestDistance = Infinity;
    candidates.forEach((candidate, index) => {
      const d = maxPointDistance(candidate.points, o.points);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = index;
      }
    });
    const [match] = candidates.splice(bestIndex, 1);
    tracks.push({ cls: bestDistance < PERSIST_TOLERANCE ? "persistent" : "reconfigured", to: o, from: match, ...blank });
  });
  fromByKey.forEach((left) => left.forEach((piece) => tracks.push({ cls: "removed", to: null, from: piece, ...blank })));

  planConstruction(tracks, cities, request.externalEdges ?? [], reconfiguringIn(fromArt, toArt, tracks, cities));

  const layers = trackLayersFor(toArt.tracks.map((track) => track.d));
  const destLayers = toArt.tracks.map(() => 0);
  layers.forEach((layer, layerIndex) => layer.forEach((trackIndex) => (destLayers[trackIndex] = layerIndex)));
  const destCrossings = trackCrossingsFor(
    toArt.tracks.map((track) => track.d),
    layers,
  ).map((crossing) => {
    const at = rotateVec({ x: crossing.x, y: crossing.y }, toArt.turnDeg);
    return { x: at.x, y: at.y, sinAngle: crossing.sinAngle, over: crossing.over };
  });

  const reducedMotion = request.reducedMotion === true;
  const timing = timeTransition(fromArt, toArt, tracks, cities, vanishing, reducedMotion);
  return {
    fromArt,
    toArt,
    tracks,
    cities,
    vanishing,
    markerMapping: mapping,
    fromTier: fromArt.tier,
    toTier: toEntry.color,
    reducedMotion,
    provisional: request.provisional === true,
    durationMs: timing.durationMs,
    components: timing.components,
    clock: timing.clock,
    beats: timing.beats,
    destLayers,
    destCrossings,
  };
}

/** How far a reconfigured piece's own points travel between the two tiles -- the morph the frame draws, point for
 *  point (#1461). */
function reconfiguredMove(track: TrackPlan): number {
  if (track.cls !== "reconfigured" || !track.from || !track.to) return 0;
  return maxPointDistance(track.from.points, track.to.points);
}

/** #1475: existing rail physically REFORMS -- a reconfigured piece that moves at least half a rail width, or a piece
 *  taken up. A reconfigured piece that moves less is the same rail redrawn, and is not railroad work. */
function trackWorkIn(tracks: readonly TrackPlan[]): boolean {
  return tracks.some((track) => track.cls === "removed" || reconfiguredMove(track) >= RECONFIGURED_TRACK_MOVE);
}

/** How far a revenue centre's drawing moves between the two tiles: the furthest its sources travel to it (#1475). */
function centreMove(fromArt: HexArt, toArt: HexArt, city: CityPlan): number {
  const dest = toArt.markers[city.dest];
  return city.sources.reduce((furthest, i) => Math.max(furthest, dist(fromArt.markers[i].at, dest.at)), 0);
}

/** #1475: existing infrastructure repositions or reforms, so construction has a network to grow out of -- track work,
 *  or a centre with a predecessor that moves at least as far as a reformed rail does. A centre with no predecessor
 *  (`emerge`) is not existing infrastructure; a city that gains capacity where it stands is a station mutation
 *  (#1463); a city re-laid in its own place moves nothing and stages nothing. */
function reconfiguringIn(
  fromArt: HexArt,
  toArt: HexArt,
  tracks: readonly TrackPlan[],
  cities: readonly CityPlan[],
): boolean {
  return (
    trackWorkIn(tracks) ||
    cities.some((city) => city.sources.length > 0 && centreMove(fromArt, toArt, city) >= RECONFIGURED_TRACK_MOVE)
  );
}

/** Which ring choreography a city plays (#1463), from its slot counts alone -- shared by the frame and the clock. */
function ringChoreography(fromArt: HexArt, toArt: HexArt, city: CityPlan): "none" | "mitosis" | "reorganise" | "travel" {
  const sources = city.sources.map((i) => fromArt.markers[i]);
  const dest = toArt.markers[city.dest];
  const sourceSlots = sources.reduce((count, source) => count + slotCentres(source).length, 0);
  const destSlots = slotCentres(dest).length;
  if (!sources.some((source) => source.slots > 1) && dest.slots <= 1) return "none";
  if (city.event !== "merge" && sourceSlots === 1 && destSlots > 1) return "mitosis";
  if (city.event !== "merge" && sourceSlots !== destSlots) return "reorganise";
  return "travel";
}

/** The parts a transition animates, its length, its clock and its semantic beats (#1470, #1471). Runs once
 *  construction is planned. */
function timeTransition(
  fromArt: HexArt,
  toArt: HexArt,
  tracks: TrackPlan[],
  cities: readonly CityPlan[],
  vanishing: readonly number[],
  reducedMotion: boolean,
): { components: TransitionComponents; durationMs: number; clock: TransitionClock; beats: TransitionBeats } {
  const added = tracks.filter((track) => track.cls === "added");
  const choreography = cities.map((city) => (city.kind === "city" && city.sources.length > 0 ? ringChoreography(fromArt, toArt, city) : "none"));
  const slotCount = (city: CityPlan) => ({
    from: city.sources.reduce((count, i) => count + slotCentres(fromArt.markers[i]).length, 0),
    to: slotCentres(toArt.markers[city.dest]).length,
  });
  const components: TransitionComponents = {
    construction: added.length > 0,
    stationMutation: cities.some(
      (city, k) => choreography[k] === "mitosis" || choreography[k] === "reorganise" || (choreography[k] === "travel" && city.event === "merge"),
    ),
    geometry:
      tracks.some((track) => track.cls === "reconfigured" || track.cls === "removed") ||
      vanishing.length > 0 ||
      cities.some((city) => city.migrates || city.event === "migrate" || city.event === "reshape" || city.event === "merge" || city.event === "emerge"),
    trackWork: trackWorkIn(tracks),
    reconfiguration: reconfiguringIn(fromArt, toArt, tracks, cities),
  };
  if (reducedMotion) {
    // Reduced motion builds nothing, reforms nothing and splits nothing: it has no railroad work to announce (#1475).
    const beats = { railroadWorkStart: null, constructionStart: null, stationEmergence: null, revealStart: 0 };
    return { components, durationMs: TILE_TRANSITION_REDUCED_MS, clock: { revealStart: 0, end: TILE_TRANSITION_REDUCED_MS }, beats };
  }

  // Beats and the reveal's start are whole milliseconds: what audio schedules against, clear of rounding noise.
  const ms = (fraction: number) => Math.round(fraction * TIMELINE_SPAN_MS);
  // New slots begin: the split of a lone slot, a gained slot out of a gathered system, a merge's added slots.
  const emergences = cities.flatMap((city, k) => {
    const slots = slotCount(city);
    if (choreography[k] === "mitosis") return [TIMELINE.divide[0]];
    if (choreography[k] === "reorganise" && slots.to > slots.from) return [TIMELINE.pulse[0] + beat(BEAT_MS.gainedSlot)];
    if (choreography[k] === "travel" && city.event === "merge" && slots.to > slots.from) return [TIMELINE.divide[0]];
    return [];
  });
  const constructionStart = added.length > 0 ? Math.round(Math.min(...added.map((track) => track.startMs))) : null;
  const stationEmergence = emergences.length > 0 ? ms(Math.min(...emergences)) : null;
  /* #1475: railroad work is the earliest of the three physical track events -- existing rail morphing on the
     geometry settle, a piece being taken up as it fades, and the first added rail erupting. Each is read from the
     window that draws it, so the cue cannot drift from the picture. */
  const railroadWork = [
    ...(tracks.some((track) => reconfiguredMove(track) >= RECONFIGURED_TRACK_MOVE) ? [ms(TIMELINE.geometry[0])] : []),
    ...(tracks.some((track) => track.cls === "removed") ? [ms(TIMELINE.vanish[0])] : []),
    ...(constructionStart === null ? [] : [constructionStart]),
  ];
  const railroadWorkStart = railroadWork.length > 0 ? Math.min(...railroadWork) : null;

  // The reveal waits for the last part present to be ready for it.
  let revealStart: number = BEAT_MS.lead;
  if (components.construction) revealStart = Math.max(revealStart, ...added.map((track) => Math.round(track.startMs + track.durationMs)));
  if (components.stationMutation || components.geometry) revealStart = Math.max(revealStart, ms(TIMELINE.reveal));
  const end = revealStart + BEAT_MS.reveal;
  return {
    components,
    durationMs: end,
    clock: { revealStart, end },
    beats: { railroadWorkStart, constructionStart, stationEmergence, revealStart },
  };
}

/* ==================================================================
 *  DESIGN NOTE 1474: THREE SOUNDS, EACH ON THE BEAT IT NAMES
 * ==================================================================
 * ASKED FOR: `track.mp3` where genuinely new rail begins, `mutation.mp3` where a station's capacity really changes,
 * and `upgrade.mp3` where the commit sweep begins -- each once per transition, timed by `plan.beats` alone, and every
 * lay's combination falling out of three independent triggers rather than a table of recipes.
 *
 * EACH CUE IS ITS OWN TRIGGER, AND EACH READS THE PLAN AND NOTHING ELSE.
 *   `track` sounds at `constructionStart`, a beat that exists only when the classification found Added rail
 *     (`components.construction`). Persistent or reconfigured rail, a migration, a merge that builds nothing -- New
 *     York's -- and a commit alone have no such beat. One cue however many rails, branches or origins build.
 *   `mutation` sounds at `stationEmergence`, which exists only when a city gains a slot: a 1 -> 2 or 1 -> 3 split, a
 *     2 -> 3 city's gained slot, a merge's added slots. A migration, a reshaped city, a city appearing, rail, and a
 *     merge that gains no slot have none. Nor does a city losing one (#592 -> #61's 2 -> 1): the plan names no moment
 *     for it, so it is silent rather than timed by a figure of this file's own.
 *   `upgrade` sounds at `revealStart`, which every plan has: a new lay, an upgrade, a same-tier replacement, rail
 *     alone, a centre alone, a commit alone.
 *
 * REDUCED MOTION IS THE SAME RULE, NOT A MIX OF ITS OWN. Nothing builds or splits, so neither beat exists and neither
 * sound plays; the commit still presents -- the 240 ms fade, from its first frame -- so `upgrade` sounds at 0, as the
 * dividend register still rings for a reader who asked for less motion (#1060).
 *
 * A CUE IS DUE ONCE. `cuesReached` says which cues a playhead has reached past the ones already dealt with, and hands
 * back the new count; whoever holds the count holds the cues' identity, so it lives on the running transition. The
 * clips' own lengths are nobody's business here: a tail may run past the tile's last frame, and nothing waits for
 * it. */
export type TileTransitionCue = "track" | "mutation" | "upgrade";

/** The clips, by their names in `public/audio` (#1062: named with their owner). */
export const TILE_TRANSITION_SFX: Readonly<Record<TileTransitionCue, string>> = {
  track: "track.mp3",
  mutation: "mutation.mp3",
  upgrade: "upgrade.mp3",
};

export interface TileTransitionCueAt {
  cue: TileTransitionCue;
  /** Milliseconds from the start of the transition: one of the plan's beats. */
  at: number;
}

/** The cues a transition sounds, in the order its beats fall (#1474, #1475). */
export function tileTransitionCues(plan: TileTransitionPlan): TileTransitionCueAt[] {
  const { railroadWorkStart, stationEmergence, revealStart } = plan.beats;
  const cues: TileTransitionCueAt[] = [];
  if (railroadWorkStart !== null) cues.push({ cue: "track", at: railroadWorkStart });
  if (plan.components.stationMutation && stationEmergence !== null) cues.push({ cue: "mutation", at: stationEmergence });
  cues.push({ cue: "upgrade", at: revealStart });
  return cues.sort((a, b) => a.at - b.at);
}

/** Which of `cues` a playhead at `elapsedMs` has reached beyond the first `dealt` of them (#1474): each once, in order,
 *  with the count that now covers them. */
export function cuesReached(
  cues: readonly TileTransitionCueAt[],
  dealt: number,
  elapsedMs: number,
): { due: TileTransitionCue[]; dealt: number } {
  const due: TileTransitionCue[] = [];
  let next = Math.max(0, dealt);
  while (next < cues.length && cues[next].at <= elapsedMs) {
    due.push(cues[next].cue);
    next += 1;
  }
  return { due, dealt: next };
}

/* ==================================================================
 *  DESIGN NOTE 1467: CONSTRUCTION STARTS FROM WHAT ALREADY STANDS
 * ==================================================================
 * "Where there is a natural attachment to existing track or a city, construction should visually propagate
 * from that existing infrastructure toward the new destination." So an added piece grows from an ANCHORED
 * end, and its far end becomes an anchor once construction reaches it -- a fork's second arm starts where, and
 * when, the first one arrived.
 *
 * ANCHORS THAT STAND FROM THE START (level 0): every node a persistent or reconfigured piece touches; every
 * centre that has a predecessor; every edge where a neighbour's rail arrives (supplied by the renderer, which
 * alone can see the neighbours -- a picture of where the network comes from, not a connectivity verdict). When
 * both ends are anchored at the same level the CENTRE wins, so an upgraded city builds outward, then a rail
 * already inside the tile, then the neighbour's edge. A piece with no anchored end at all starts at its centre
 * if it has one, else at its lowest edge -- deterministic, and only reachable by an unconnected lay.
 *
 * WHEN EACH PIECE STARTS (#1469). A piece whose origin stands from the start begins with the construction
 * window, so branches from different anchors -- or several spokes from one city -- build at the same time
 * instead of queueing; so does an unconnected piece, which has nothing to wait for. A piece whose origin was
 * itself built begins the moment the wave arrives there, so the front passes from one piece into the next. The
 * travel time is the same for every piece of a transition, shortened only as far as the longest such chain
 * needs to settle inside the window. */
function planConstruction(
  tracks: TrackPlan[],
  cities: readonly CityPlan[],
  externalEdges: readonly number[],
  /** #1475: existing infrastructure repositions or reforms in this transition, so the wave waits for it to establish
   *  itself before erupting out of it. */
  reconfiguring: boolean,
): void {
  const added = tracks.filter((track) => track.cls === "added" && track.to !== null);
  if (added.length === 0) return;
  type Anchor = { level: number; rank: number };
  // rank: 0 centre, 1 internal edge, 2 external edge
  const anchors = new Map<string, Anchor>();
  const anchor = (key: string, level: number, rank: number) => {
    const existing = anchors.get(key);
    if (!existing || level < existing.level || (level === existing.level && rank < existing.rank)) {
      anchors.set(key, { level, rank });
    }
  };
  for (const track of tracks) {
    if ((track.cls === "persistent" || track.cls === "reconfigured") && track.to) {
      [track.to.from, track.to.to].forEach((node) => anchor(nodeKey(node, null), 0, node.kind === "marker" ? 0 : 1));
    }
  }
  cities.forEach((city) => {
    if (city.sources.length > 0) anchor(`m${city.dest}`, 0, 0);
  });
  externalEdges.forEach((edge) => anchor(`e${edge}`, 0, 2));
  const standing = new Set(anchors.keys());

  // In picking order, so a node's arrival is known before any piece starts from it.
  const picks: Array<{ track: TrackPlan; near: string; far: string; unanchored: boolean }> = [];
  const pending = added.slice();
  let maxLevel = 0;
  while (pending.length > 0) {
    let pick = -1;
    let pickFromEnd = false;
    let pickAnchor: Anchor | null = null;
    pending.forEach((track, index) => {
      const piece = track.to as Piece;
      const ends: Array<{ key: string; fromEnd: boolean; isMarker: boolean; edge: number }> = [
        { key: nodeKey(piece.from, null), fromEnd: false, isMarker: piece.from.kind === "marker", edge: piece.from.kind === "edge" ? piece.from.edge : 9 },
        { key: nodeKey(piece.to, null), fromEnd: true, isMarker: piece.to.kind === "marker", edge: piece.to.kind === "edge" ? piece.to.edge : 9 },
      ];
      for (const end of ends) {
        const found = anchors.get(end.key);
        if (!found) continue;
        const better =
          pickAnchor === null ||
          found.level < pickAnchor.level ||
          (found.level === pickAnchor.level && found.rank < pickAnchor.rank);
        if (better) {
          pick = index;
          pickFromEnd = end.fromEnd;
          pickAnchor = found;
        }
      }
    });
    const unanchored = pick < 0;
    if (unanchored) {
      // Nothing anchored: start the first pending piece at its centre, else its lowest edge.
      pick = 0;
      const piece = pending[0].to as Piece;
      const fromRank = piece.from.kind === "marker" ? -1 : piece.from.kind === "edge" ? piece.from.edge : 99;
      const toRank = piece.to.kind === "marker" ? -1 : piece.to.kind === "edge" ? piece.to.edge : 99;
      pickFromEnd = toRank < fromRank;
      pickAnchor = { level: added.length === pending.length ? 0 : maxLevel + 1, rank: 0 };
    }
    const [track] = pending.splice(pick, 1);
    const piece = track.to as Piece;
    const level = (pickAnchor as Anchor).level;
    track.level = level;
    track.growsFromEnd = pickFromEnd;
    maxLevel = Math.max(maxLevel, level);
    const far = pickFromEnd ? piece.from : piece.to;
    const near = pickFromEnd ? piece.to : piece.from;
    anchor(nodeKey(near, null), level, near.kind === "marker" ? 0 : 1);
    anchor(nodeKey(far, null), level + 1, far.kind === "marker" ? 0 : 1);
    picks.push({ track, near: nodeKey(near, null), far: nodeKey(far, null), unanchored });
  }

  // How many pieces the wave crosses to finish each one: 1 from a standing (or unanchored) origin, one more than
  // the piece that reached a built origin first.
  const startsFresh = (pick: (typeof picks)[number]) => pick.unanchored || standing.has(pick.near);
  const depthAt = new Map<string, number>();
  let deepest = 1;
  for (const pick of picks) {
    const depth = startsFresh(pick) ? 1 : (depthAt.get(pick.near) ?? 0) + 1;
    depthAt.set(pick.far, Math.min(depthAt.get(pick.far) ?? Infinity, depth));
    deepest = Math.max(deepest, depth);
  }

  /* #1475: where nothing existing is moving, the table's own start -- an ordinary lay waits for nothing new. Where
     something is, the window opens once the reconfiguration has travelled `RECONFIGURE_ESTABLISHED` of its settle;
     the window's end, the travel and every portion are unchanged, and the wave still settles by the reveal. */
  const [tableStart, windowEnd] = TIMELINE.construct;
  const windowStart = reconfiguring ? Math.max(tableStart, reconfigureEstablishedAt()) : tableStart;
  const settle = TIMELINE.constructSettle;
  const travel = Math.min(TIMELINE.constructTravel, (windowEnd - windowStart - settle) / deepest);
  const emergingCentres = new Set(cities.filter((city) => city.sources.length === 0).map((city) => `m${city.dest}`));
  const arrival = new Map<string, number>();
  for (const pick of picks) {
    let start = startsFresh(pick) ? windowStart : (arrival.get(pick.near) ?? windowStart);
    // A centre with no predecessor appears before rail leaves it.
    if (emergingCentres.has(pick.near)) start = Math.max(start, TIMELINE.emerge[0] + 0.1);
    start = Math.min(start, windowEnd - settle - travel);
    pick.track.startMs = start * TIMELINE_SPAN_MS;
    pick.track.durationMs = (travel + settle) * TIMELINE_SPAN_MS;
    if (pick.unanchored) arrival.set(pick.near, Math.min(arrival.get(pick.near) ?? Infinity, start));
    arrival.set(pick.far, Math.min(arrival.get(pick.far) ?? Infinity, start + travel));
  }
}

/* ------------------------------------------------------------------ */
/* Frames                                                             */
/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 1471: THE TILE BEING CHOSEN IS A PROPOSAL, AND THE CONFIRM BUILDS INTO IT
 * ==================================================================
 * ASKED FOR: the tile shown while the player is choosing and turning it "should look clearly provisional, then
 * confirmation should transform that same proposed tile into the committed tile through the existing
 * construction/mutation animation" -- never a finished-looking candidate, then the old tile, then the same tile
 * animating back in. And "replace the existing long color wash with a fast commit/reveal line".
 *
 * A PROPOSAL IS THE WHOLE DESTINATION TILE, WASHED. Every colour the tile prints -- fill, rim, rail ink, station
 * ink, town dots -- mixed one amount toward one light neutral; paper white stays white. Nothing is see-through
 * (#167) and nothing is fainter than washed ink, so rail, city positions, slots and the value stay legible. Never
 * the old tile and the new one together.
 *
 * THE CONFIRM KEEPS THE PROPOSAL AND MAKES ITS DIFFERENCES ACTIVE. A confirmed proposal's first frame is the
 * proposal, with what the lay changes drawn over it in the tile's own colours and played exactly as before:
 *   PERSISTENT rail, and a revenue centre that is the same drawing on both tiles, are the proposal's own elements
 *     (role `static`): still, and washed until the commit reaches them.
 *   ADDED rail keeps its construction wave (#1469). The proposal already shows the rail, washed, and each portion
 *     erupts over it in full ink, so the wave solidifies the planned rail. Nothing that is not added is rebuilt.
 *   RECONFIGURED rail keeps its morph out of the old geometry, and the proposal's copy stays beneath it as the shape
 *     it is heading for (role `target`). Its class is the plan's, unchanged.
 *   A CHANGING CENTRE -- a split, a reorganisation, a migration, a merge -- plays from its old drawing over its
 *     planned one, which recedes over the lead to a faint outline: a 1 -> 2 split never reads as three rings, and a
 *     moving city migrates into its planned place rather than two cities standing at once.
 * Nothing here is keyed to a tile: the roles are the plan's classes (#1461, #1462), so a pair the plan describes
 * with merges, emergences or leftovers takes the same treatment, and a pair it cannot describe has no transition.
 *
 * THE COMMIT IS A FRONT, NOT A COLOUR. West of a narrow front crossing the hex the tile is committed -- the
 * destination's fill and rim, every element in its own colours, no planned shape; east of it, still the proposal.
 * It commits a new lay, an upgrade and a same-tier replacement alike: what it resolves is provisional to committed,
 * not one tier to another. Nothing rotates, turns over, blurs or glows; its edge is a light line with a faint shade
 * (`tileTransitionCanvas.ts`). Since #1473 the front leans a little -- its top ahead of its bottom, 20 degrees off
 * vertical (`REVEAL_SLANT`) -- so it sweeps left to right and top to bottom rather than as a scanner's vertical strip,
 * in the same 240 ms; and its edge is a hairline on the tile's fill, under the rim, the rails, the centres and
 * everything the board draws over a tile.
 *
 * A LAY NOBODY PROPOSED ON THIS BOARD -- another seat's, a replay's -- starts from the old tile, which gives way to
 * the proposal over the lead, and then plays the same sequence.
 *
 * TOKENS ARE NOT ON THE TILE. The renderer draws them after every tile (#222), never washed. While a tile is being
 * chosen they are drawn where the lay would put them (#822, #886); from the confirm they are pieces seated in the
 * city that is changing, and ride it into those places (#1466 as revised by #1472). A token the lay moves is shown at
 * that place as a planned place, faint, like the rest of the proposal (#1473).
 *
 * REDUCED MOTION fades a confirmed proposal to committed over its 240 ms, and crossfades a lay nobody proposed from
 * the old tile, as before.
 *
 * The numbers are starting points for a playtest, not tuned values. */
export const PROVISIONAL = {
  /** The light neutral a proposal's colours are mixed toward. */
  neutral: "#e8e4da",
  /** How far: fill, rim, rail ink, station ink, town dots. Rail outlines and station faces are paper white already. */
  wash: 0.45,
  /** A changing centre's planned shape, once its own centre is drawn over it. */
  targetCentreAlpha: 0.35,
  /** A proposal's printed value. */
  badgeAlpha: 0.6,
  /** Where the lay puts a token it moves: its planned place, drawn under the pieces (#1473). */
  pieceAlpha: 0.4,
} as const;

/** How far the commit front leans (#1473): for every unit down the hex it stands this much further EAST -- negative, so
 *  its top is ahead of its bottom and the commit sweeps left to right and top to bottom, 20 degrees off vertical.
 *  Understated on purpose: the track's own change is the effect. */
export const REVEAL_SLANT = -Math.tan((20 * Math.PI) / 180);

/** How far the commit front travels either side of the hex's centre, unit hex, measured where it crosses the centre
 *  row: the flat sides stand at sqrt(3)/2, their corners half a unit up and down, which the leaning front reaches
 *  half its slant early or late -- and the margin keeps the rim and the front's edge off the hex as it enters and
 *  leaves. */
export const REVEAL_SPAN = Math.sqrt(3) / 2 + Math.abs(REVEAL_SLANT) / 2 + 0.08;

/** The commit front, unit-hex x where it crosses the hex's centre row, at `reveal` 0..1 -- entering at the west,
 *  leaving at the east. Everywhere else it stands `REVEAL_SLANT` further east per unit down. */
export function revealFront(reveal: number): number {
  if (reveal <= 0) return -REVEAL_SPAN;
  if (reveal >= 1) return REVEAL_SPAN;
  return -REVEAL_SPAN + 2 * REVEAL_SPAN * reveal;
}

/** `color` as a proposal prints it: mixed `wash` of the way toward the provisional neutral, exact at 0. */
export function provisionalColor(color: string, wash: number): string {
  return mixColor(color, PROVISIONAL.neutral, wash);
}

/** How an element of a frame is presented (#1471). Absent: drawn as it is, in the tile's own colours -- a
 *  transition's moving parts, and everything in a plain frame.
 *    `static`  the proposal's own element, unchanged by the lay: provisional ahead of the commit front, committed
 *              behind it.
 *    `target`  the planned shape of something still changing: drawn only ahead of the front, provisional, at its
 *              own opacity, with the changing element over it. */
export type FrameRole = "static" | "target";

export interface FrameFill {
  color: string;
  alpha: number;
}

/** The hex's one rim, stroked once: the proposal's, or the old tier's carried to it. */
export interface FrameRim {
  color: string;
  alpha: number;
}

export interface FrameTrack {
  points: Vec[];
  alpha: number;
  /** Destination track this belongs to (for layering and overpasses), or `null` for a fading old piece. */
  destTrack: number | null;
  /** Only on a portion of new rail that is still erupting (#1469): its pen -- outline and ink -- at this multiple of
   *  the board's, at `alpha`. Absent is the board's own pen. */
  widthScale?: number;
  role?: FrameRole;
}

export interface FrameBlob {
  points: Vec[];
  closed: boolean;
  /** Station radius (centre to the middle of the rim), unit space. */
  radius: number;
  /** Absent is opaque. A merging city's own outline fades once the shape it joined has taken over (#1463). */
  alpha?: number;
}

export interface FrameRing {
  at: Vec;
  radius: number;
  lineScale: number;
  alpha: number;
}

export interface FrameCity {
  blobs: FrameBlob[];
  rings: FrameRing[];
  /** 1 while the slot rings are whole circles -- the old tile's before its slots move, the destination's once they
   *  settle -- and 0 while they are drawn as one dividing outline. */
  ringsWhole: number;
  /** Marker size fraction, for the rim width in pixels. */
  markerScale: number;
  alpha: number;
  role?: FrameRole;
}

export interface FrameTown {
  at: Vec;
  radius: number;
  alpha: number;
  role?: FrameRole;
}

/** A frame's presentation (#1471): how washed its proposal is, and where its commit front stands. */
export interface FramePresentation {
  /** Static and target elements mix this far toward `PROVISIONAL.neutral` ahead of the front; 0 is the tile's own
   *  colours. The provisional side's fills and rim carry their own colours already. */
  wash: number;
  /** The commit front, unit-hex x where it crosses the hex's centre row, leaning `REVEAL_SLANT` east per unit down:
   *  committed west of it, provisional east of it. At `-REVEAL_SPAN` or below nothing is committed, at `REVEAL_SPAN`
   *  or above everything is. */
  front: number;
  /** The committed side's fill and rim: the destination tier's own. */
  committedFill: string;
  committedRim: string;
}

export interface TileTransitionFrame {
  /** The provisional side's fills, bottom to top -- a plain frame's only side. */
  fills: FrameFill[];
  rim: FrameRim;
  tracks: FrameTrack[];
  crossings: Array<{ x: number; y: number; sinAngle: number; over: number }>;
  destLayers: number[];
  cities: FrameCity[];
  towns: FrameTown[];
  ink: string;
  /** `null` for a plain frame: reduced motion's crossfade of a lay nobody proposed here. */
  present: FramePresentation | null;
}

/** `#rrggbb` towards `#rrggbb`, exact at both ends. Anything else changes over at the midpoint. */
function mixColor(from: string, to: string, w: number): string {
  if (w <= 0) return from;
  if (w >= 1) return to;
  const hex = /^#[0-9a-fA-F]{6}$/;
  if (!hex.test(from) || !hex.test(to)) return w < 0.5 ? from : to;
  let out = "#";
  for (const offset of [1, 3, 5]) {
    const value = Math.round(lerp(parseInt(from.slice(offset, offset + 2), 16), parseInt(to.slice(offset, offset + 2), 16), w));
    out += (value < 16 ? "0" : "") + value.toString(16);
  }
  return out;
}

/** How far a lay nobody proposed here has become its proposal; a confirmed proposal already is one (#1471). */
function proposalAt(plan: TileTransitionPlan, ms: number): number {
  return plan.provisional ? 1 : smoothstep(windowProgress(ms, 0, BEAT_MS.lead));
}

/* The fills are layers: the old tier under the proposal is a crossfade. The rim is not -- two rims stroked over each
   other antialias into a heavier line than either -- so it is one stroke, its colour carried. */
function proposalFills(plan: TileTransitionPlan, proposal: number): FrameFill[] {
  const proposed = { color: provisionalColor(ERA_TILE_FILL[plan.toTier], PROVISIONAL.wash), alpha: proposal };
  if (plan.provisional || !plan.fromTier) return [proposed];
  return [{ color: ERA_TILE_FILL[plan.fromTier], alpha: 1 }, proposed];
}

function proposalRim(plan: TileTransitionPlan, proposal: number): FrameRim {
  const proposed = provisionalColor(COLOR_TIER_STROKE[plan.toTier], PROVISIONAL.wash);
  if (plan.provisional) return { color: proposed, alpha: 1 };
  if (plan.fromTier) return { color: mixColor(COLOR_TIER_STROKE[plan.fromTier], proposed, proposal), alpha: 1 };
  return { color: proposed, alpha: proposal };
}

/* ==================================================================
 *  DESIGN NOTE 1469: NEW RAIL ERUPTS PORTION BY PORTION, BEHIND A TRAVELLING FRONT
 * ==================================================================
 * ASKED FOR: "a travelling eruption/construction wave, not a whole-path fade" -- from the piece's origin (#1467),
 * along its own geometry, successive small portions each fading rapidly in, briefly slightly larger and heavier,
 * then easing back to exactly the board's rail while the front moves on.
 *
 * A PIECE IS CUT BY ARC LENGTH, not by sample index, into portions about one rail-width long (the pen is 0.12 of
 * the hex size, and so is a portion): a curve builds along the curve at the same grain as a straight, and a
 * longer piece has more portions rather than longer ones. Never fewer than six on a short rail, the grain the wave
 * was approved at -- and that floor is a count, not something worked out from the clock: when the transition grew
 * from 850 ms to 1600 ms the front was slowed, not the rail cut finer ("do not create more rail portions simply to
 * fill the longer timeline"). So on a rail shorter than about one hex unit the front now rests for a moment between
 * portions, each of which still snaps in over its absolute settle. The count comes from the piece's own length,
 * fixed for its whole life, so a piece stretched by a migrating centre keeps its cuts as fractions of itself.
 *
 * The front reaches portion `i` of `n` at `start + travel * i / (n - 1)` -- the first erupts at the origin the
 * moment the piece starts, the last at the far node the moment the wave arrives there, which is when a piece
 * continuing from that node starts.
 *
 * A PORTION'S LOOK IS ITS AGE since the front reached it, in `constructSettle`s -- `BEAT_MS.portionSettle`, an
 * absolute 68 ms, so the eruption keeps its snap whatever the travel (#1464): hidden before, `eruption(age)`
 * during -- opacity up fast, width swelling to `1 + overshoot` and easing back to exactly 1 -- and SETTLED once
 * the age passes 1. Settled portions are always one prefix of the piece, pushed as ordinary rail with its
 * destination track, so layers and overpasses hold for everything already built; when the last portion
 * settles the piece is pushed as its whole polyline, the frame it always was.
 *
 * NOTHING IS MOVED TO MAKE THE ERUPTION. Every portion is a slice of the piece's own polyline -- its own points,
 * with an interpolated point at each cut -- so ends, curves and connections are the destination's exactly.
 * The overshoot is in the pen, not the path: the painter strokes an erupting portion's outline and ink wider,
 * butt-capped, so it swells across the rail, not along it. (Its one liberty is to start each portion half a pixel
 * back under the rail behind it, which closes an antialiasing seam and moves no cut.)
 *
 * The numbers are starting points for a playtest, not tuned values. */
export const CONSTRUCTION_WAVE = {
  /** Portion length along the piece, unit hex: about one rail width. */
  portion: 0.12,
  /** Fewest portions a rail is built in: the grain short rails were approved at. A count, fixed, so a longer
   *  timeline slows the front rather than adding portions. */
  minPortions: 6,
  /** Peak extra width of an erupting portion, as a fraction of the board's pen. */
  overshoot: 0.15,
  /** Share of a portion's settle spent fading in. */
  fadeIn: 0.35,
  /** Share of a portion's settle at which it is widest. */
  peak: 0.3,
} as const;

/** #1475: a reconfigured rail has physically REFORMED, rather than been redrawn within its own line, once some point
 *  of it moves half a rail width -- the pen the board strokes it with (`CONSTRUCTION_WAVE.portion`, #1469). Used by
 *  the classification's railroad-work questions above; declared here, with the width it is half of. */
const RECONFIGURED_TRACK_MOVE = CONSTRUCTION_WAVE.portion / 2;

/** How many portions a piece of `length` builds in: about one per rail width, never fewer than `minPortions`, and
 *  nothing to do with how long the transition runs. */
export function constructionPortions(length: number): number {
  return Math.max(CONSTRUCTION_WAVE.minPortions, Math.round(length / CONSTRUCTION_WAVE.portion));
}

/** One portion's look at `age`: 0 as the front reaches it, 1 once it has settled to exactly the board's rail. */
export function eruption(age: number): { alpha: number; widthScale: number } {
  if (age <= 0) return { alpha: 0, widthScale: 1 };
  if (age >= 1) return { alpha: 1, widthScale: 1 };
  const { fadeIn, peak, overshoot } = CONSTRUCTION_WAVE;
  const swell = age < peak ? smoothstep(age / peak) : 1 - smoothstep((age - peak) / (1 - peak));
  return { alpha: smoothstep(age / fadeIn), widthScale: 1 + overshoot * swell };
}

/** The stretch of `points` between arc lengths `from` and `to`, cut at interpolated points on its own segments. */
export function slicePolyline(points: readonly Vec[], from: number, to: number): Vec[] {
  const out: Vec[] = [];
  let run = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const step = dist(a, b);
    const next = run + step;
    if (next > from && run < to) {
      if (out.length === 0) out.push(step < 1e-12 ? a : lerpVec(a, b, (from - run) / step));
      if (next >= to) {
        out.push(step < 1e-12 ? b : lerpVec(a, b, (to - run) / step));
        return out;
      }
      out.push(b);
    }
    run = next;
  }
  return out;
}

/** An added piece at `t`, drawn from its origin (`points[0]`): the settled prefix, the portions erupting behind the
 *  front, and nothing beyond it (#1469). `restLength` is the piece's own length on the destination tile; `t`, `start`,
 *  `duration` and `portionSettle` are milliseconds. */
function pushConstructionWave(
  frame: TileTransitionFrame,
  points: Vec[],
  restLength: number,
  destTrack: number,
  t: number,
  start: number,
  duration: number,
  portionSettle: number,
): void {
  if (t >= start + duration) {
    frame.tracks.push({ points, alpha: 1, destTrack });
    return;
  }
  const settle = Math.min(portionSettle, duration / 2);
  const travel = duration - settle;
  const length = polylineLength(points);
  const count = constructionPortions(restLength);
  const ageOf = (i: number) => (t - (start + (count === 1 ? 0 : (travel * i) / (count - 1)))) / settle;
  let settled = 0;
  while (settled < count && ageOf(settled) >= 1) settled += 1;
  if (settled === count) {
    frame.tracks.push({ points, alpha: 1, destTrack });
    return;
  }
  const cut = (i: number) => (length * i) / count;
  if (settled > 0) frame.tracks.push({ points: slicePolyline(points, 0, cut(settled)), alpha: 1, destTrack });
  for (let i = settled; i < count; i += 1) {
    const age = ageOf(i);
    if (age <= 0) break;
    const look = eruption(age);
    frame.tracks.push({ points: slicePolyline(points, cut(i), cut(i + 1)), alpha: look.alpha, destTrack, widthScale: look.widthScale });
  }
}

function markerPositionAt(plan: TileTransitionPlan, city: CityPlan, geometry: number): Vec {
  const dest = plan.toArt.markers[city.dest];
  if (city.sources.length === 0) return dest.at;
  const source = centroid(city.sources.map((i) => plan.fromArt.markers[i].at));
  return lerpVec(source, dest.at, geometry);
}

function cityForMarker(plan: TileTransitionPlan, destMarker: number): CityPlan {
  return plan.cities[destMarker];
}

/** A small shake along `axis`, enveloped so it starts and ends at rest. */
function tension(ms: number, axis: Vec): Vec {
  const u = inWindow(ms, TIMELINE.tension);
  if (u <= 0 || u >= 1) return { x: 0, y: 0 };
  const amplitude = 0.014 * Math.sin(Math.PI * u) * Math.sin(Math.PI * 2 * 1.5 * u);
  return scale(axis, amplitude);
}

/** How far gathering slots close in on their city's centre (#1463). One number for the rings and for the tokens
 *  seated in them (#1472). */
const GATHER_REACH = 0.8;

/** Where a city's centre stands at `ms`, and how the city shakes: what its slots move with, and so what a token
 *  seated in one of them moves with (#1463, #1472). */
function cityMotion(plan: TileTransitionPlan, city: CityPlan, ms: number, easing: TransitionEasings): { anchor: Vec; shake: Vec } {
  const destSlots = slotCentres(plan.toArt.markers[city.dest]);
  const destAxis = destSlots.length > 1 ? sub(destSlots[destSlots.length - 1], destSlots[0]) : { x: 1, y: 0 };
  const axisLength = Math.hypot(destAxis.x, destAxis.y) || 1;
  const axis = scale(destAxis, 1 / axisLength);
  const tense = city.event === "capacity" || city.event === "merge";
  return { anchor: markerPositionAt(plan, city, easing.geometry), shake: tense ? tension(ms, axis) : { x: 0, y: 0 } };
}

/** Circles' outline arcs that no other circle covers -- the ring system drawn as one shape while it divides. */
export function ringUnionArcs(rings: readonly FrameRing[]): Array<{ ring: number; start: number; end: number }> {
  const arcs: Array<{ ring: number; start: number; end: number }> = [];
  rings.forEach((ring, i) => {
    if (ring.alpha <= 0 || ring.radius <= 0) return;
    // Covered angular intervals, as [start, end] with start in [0, 2pi).
    const covered: Array<[number, number]> = [];
    let hidden = false;
    rings.forEach((other, j) => {
      if (i === j || other.alpha < 0.5 || other.radius <= 0) return;
      const d = dist(ring.at, other.at);
      if (d < 1e-6) {
        // Coincident: the earlier ring draws, the later is hidden.
        if (j < i) hidden = true;
        return;
      }
      if (d >= ring.radius + other.radius) return;
      if (d + ring.radius <= other.radius) {
        hidden = true;
        return;
      }
      if (d + other.radius <= ring.radius) return;
      const cosHalf = (ring.radius * ring.radius + d * d - other.radius * other.radius) / (2 * ring.radius * d);
      const half = Math.acos(Math.max(-1, Math.min(1, cosHalf)));
      const toward = Math.atan2(other.at.y - ring.at.y, other.at.x - ring.at.x);
      covered.push([toward - half, toward + half]);
    });
    if (hidden) return;
    if (covered.length === 0) {
      arcs.push({ ring: i, start: 0, end: Math.PI * 2 });
      return;
    }
    // Normalise, then walk the complement.
    const TAU = Math.PI * 2;
    const spans: Array<[number, number]> = [];
    covered.forEach(([a, b]) => {
      const s = ((a % TAU) + TAU) % TAU;
      const e = s + (b - a);
      if (e > TAU) {
        spans.push([s, TAU]);
        spans.push([0, e - TAU]);
      } else spans.push([s, e]);
    });
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [s, e] of spans) {
      if (s > cursor + 1e-6) arcs.push({ ring: i, start: cursor, end: s });
      cursor = Math.max(cursor, e);
    }
    if (cursor < TAU - 1e-6) arcs.push({ ring: i, start: cursor, end: TAU });
  });
  return arcs;
}

/** The arcs of each ring that `ringUnionArcs` leaves out -- where it runs inside another ring -- so a settling city
 *  can close its circles without stroking any arc twice. With the union: every drawn ring's full turn, once. */
export function ringCoveredArcs(
  rings: readonly FrameRing[],
  union: ReadonlyArray<{ ring: number; start: number; end: number }> = ringUnionArcs(rings),
): Array<{ ring: number; start: number; end: number }> {
  const TAU = Math.PI * 2;
  const arcs: Array<{ ring: number; start: number; end: number }> = [];
  rings.forEach((ring, i) => {
    if (ring.alpha <= 0 || ring.radius <= 0) return;
    const own = union.filter((arc) => arc.ring === i).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const arc of own) {
      if (arc.start > cursor + 1e-6) arcs.push({ ring: i, start: cursor, end: arc.start });
      cursor = Math.max(cursor, arc.end);
    }
    if (cursor < TAU - 1e-6) arcs.push({ ring: i, start: cursor, end: TAU });
  });
  return arcs;
}

/* ==================================================================
 *  DESIGN NOTE 1463: STATION SLOTS DIVIDE, GATHER AND FUSE; THE CITY'S OUTLINE LEADS THEM
 * ==================================================================
 * THE OUTLINE MOVES FIRST, THE SLOTS FOLLOW. The enclosing shape begins extending at `outline`, the slot
 * rings pulse at `pulse` and separate over `divide`, and both finish on the destination's exact geometry --
 * "city begins extending -> station pulsates/splits slightly afterward -> city and slots settle together".
 *
 * THREE CHOREOGRAPHIES, chosen by the slot counts rather than by a tile id:
 *   ONE SLOT BECOMING MORE (1 -> 2, 1 -> 3): the lone ring pulses where it stands and divides; every
 *     destination slot starts from it. Mitosis.
 *   SEVERAL BECOMING ANOTHER NUMBER (2 -> 3, and #592's 2 -> 1): the rings gather toward the natural centre
 *     -- the city's own anchor as it moves -- pulse as one combined system, and reorganise outward. No
 *     existing ring is designated as the one that "creates" the new one.
 *   A MERGE: each source city's outline stretches toward the part of the destination nearest it, the cities
 *     reach for each other across the gaps between them until the shapes are one (`fuse`, #1473), and existing
 *     slots travel directly to their nearest destination slots; slots the merged city adds emerge from its centre.
 * Everything is derived from the destination's own `slotOffsets` geometry -- the pill's axis, the triangle's
 * apex, the square's order -- so no shape is invented here.
 *
 * TOKENS ARE NOT SLOTS. Nothing in this section moves, splits, merges or creates a corporation token; the
 * renderer moves each token by itself from where it stood to where authoritative state puts it (#1466). */
function cityFrame(plan: TileTransitionPlan, city: CityPlan, ms: number, easing: TransitionEasings): FrameCity {
  const dest = plan.toArt.markers[city.dest];
  const destOutline = outlineOf(dest);
  const destSlots = slotCentres(dest);
  const destRadius = dest.scale * STATION_RADIUS_RATIO;
  const destRingRadius = destRadius * SLOT_RING_RATIO;
  const sources = city.sources.map((i) => plan.fromArt.markers[i]);
  const outlineEase = settleInto(plan, ms, TIMELINE.outline);
  const { anchor, shake } = cityMotion(plan, city, ms, easing);

  if (sources.length === 0) {
    // Emerges in place: the outline grows from its anchor.
    const grow = settleEase(inWindow(ms, TIMELINE.emerge));
    if (grow <= 0) return { blobs: [], rings: [], ringsWhole: 1, markerScale: dest.scale, alpha: 0 };
    return {
      blobs: [
        {
          points: destOutline.points.map((point) => lerpVec(dest.at, point, grow)),
          closed: destOutline.closed,
          radius: destRadius * grow,
        },
      ],
      rings:
        dest.slots > 1
          ? destSlots.map((slot) => ({ at: lerpVec(dest.at, slot, grow), radius: destRingRadius * grow, lineScale: 1, alpha: grow }))
          : [],
      ringsWhole: grow,
      markerScale: dest.scale,
      alpha: smoothstep(grow * 3),
    };
  }

  const radius = lerp(centroidScale(sources), dest.scale, easing.geometry) * STATION_RADIUS_RATIO;
  const markerScale = lerp(centroidScale(sources), dest.scale, easing.geometry);

  /* ---- outlines ---- */
  const blobs: FrameBlob[] = [];
  if (sources.length === 1) {
    blobs.push(morphOutline(outlineOf(sources[0]), destOutline, outlineEase, radius, shake));
  } else {
    // Partition the destination outline among the sources, nearest source anchor first.
    const nearestSource = (point: Vec) => {
      let best = 0;
      let bestD = Infinity;
      sources.forEach((source, s) => {
        const d = dist(point, source.at);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      });
      return best;
    };
    const owners = destOutline.points.map(nearestSource);
    const blobPoints: Vec[][] = sources.map(() => []);
    const allPoints: Vec[] = [];
    // Once the neck is the whole shape, each source's own outline is only a second stroke along part of it.
    const handOver = 1 - settling(plan, ms);
    sources.forEach((source, s) => {
      let subset = destOutline.points.filter((_, k) => owners[k] === s);
      if (subset.length === 0) {
        // More cities than outline points (two circles fusing into one): a source that owns no point of the
        // destination still travels to the nearest one and fuses there.
        let nearest = destOutline.points[0];
        destOutline.points.forEach((point) => {
          if (dist(point, source.at) < dist(nearest, source.at)) nearest = point;
        });
        subset = [nearest];
      }
      const morph = morphOutline(outlineOf(source), { points: subset, closed: destOutline.closed && subset.length >= 3 }, outlineEase, radius, shake);
      blobs.push({ ...morph, alpha: handOver });
      blobPoints[s] = morph.points;
    });
    // The neck: the destination outline, in destination order, through the owning blobs' current points.
    const cursor = sources.map(() => 0);
    const pointOwners: number[] = [];
    destOutline.points.forEach((_, k) => {
      const s = owners[k];
      const points = blobPoints[s];
      allPoints.push(points[Math.min(cursor[s], points.length - 1)]);
      pointOwners.push(s);
      cursor[s] += 1;
    });
    // Blobs that own no destination point are joined to the neck at their own current position.
    sources.forEach((_, s) => {
      if (owners.includes(s)) return;
      allPoints.push(blobPoints[s][0]);
      pointOwners.push(s);
    });
    const fuse = settleInto(plan, ms, TIMELINE.fuse);
    const neckClosed = destOutline.closed || allPoints.length >= 3;
    if (fuse >= 1) blobs.push({ points: allPoints, closed: neckClosed, radius: radius * fuse });
    else if (fuse > 0) blobs.push(...reachingNeck(allPoints, pointOwners, neckClosed, fuse, radius));
  }

  /* ---- rings ---- */
  const rings: FrameRing[] = [];
  const [pulseStart, pulseEnd] = spanMs(TIMELINE.pulse);
  const pulseU = windowProgress(ms, pulseStart, pulseEnd);
  const pulse = pulseU > 0 && pulseU < 1 ? Math.sin(Math.PI * pulseU) : 0;
  const ringRadiusNow = lerp(centroidScale(sources), dest.scale, easing.geometry) * STATION_RADIUS_RATIO * SLOT_RING_RATIO;
  const sourceSlots = sources.flatMap((source) => slotCentres(source));
  const sourceHasRings = sources.some((source) => source.slots > 1);
  const destHasRings = dest.slots > 1;
  const changes = sourceSlots.length !== destSlots.length || city.event === "merge";
  // A ring is drawn on a multi-slot city only; a lone circle's slot is its whole face.
  const ringAlphaIn = sourceHasRings ? 1 : smoothstep(windowProgress(ms, pulseStart, pulseStart + BEAT_MS.ringsAppear));
  const ringAlphaOut = destHasRings ? 1 : 1 - settling(plan, ms);
  const ringAlpha = Math.min(changes ? ringAlphaIn : sourceHasRings ? 1 : 0, ringAlphaOut);
  const choreography = ringChoreography(plan.fromArt, plan.toArt, city);

  if (choreography === "none") {
    // One-slot cities on both sides -- migrating, or merging into one circle: a lone circle's slot is its whole
    // face, so there is no ring to draw and the outlines carry the whole change.
  } else if (choreography === "mitosis") {
    // Mitosis.
    const divide = easing.slots;
    destSlots.forEach((slot) => {
      rings.push({
        at: add(lerpVec(anchor, slot, divide), shake),
        radius: ringRadiusNow * (1 + 0.14 * pulse),
        lineScale: 1 + 0.6 * pulse,
        alpha: ringAlpha,
      });
    });
  } else if (choreography === "reorganise") {
    // Gather, pulse as one system, reorganise.
    const gather = smoothstep(inWindow(ms, TIMELINE.gather));
    const divide = easing.slots;
    const gathered = sourceSlots.map((slot) => lerpVec(slot, anchor, GATHER_REACH * gather));
    const order = assignPoints(destSlots.length >= gathered.length ? gathered : destSlots, destSlots.length >= gathered.length ? destSlots : gathered);
    const startFor: Vec[] = destSlots.map(() => anchor);
    if (destSlots.length >= gathered.length) {
      order.forEach((destIndex, sourceIndex) => (startFor[destIndex] = gathered[sourceIndex]));
    } else {
      order.forEach((sourceIndex, destIndex) => (startFor[destIndex] = gathered[sourceIndex]));
      // Sources that are not continued converge into the slot nearest them and fade.
      gathered.forEach((point, sourceIndex) => {
        if (order.includes(sourceIndex)) return;
        let nearest = 0;
        let nearestD = Infinity;
        destSlots.forEach((slot, k) => {
          const d = dist(point, slot);
          if (d < nearestD) {
            nearestD = d;
            nearest = k;
          }
        });
        rings.push({
          at: add(lerpVec(point, destSlots[nearest], divide), shake),
          radius: ringRadiusNow * (1 + 0.14 * pulse),
          lineScale: 1 + 0.6 * pulse,
          alpha: ringAlpha * (1 - divide),
        });
      });
    }
    const continued = new Set<number>(destSlots.length >= gathered.length ? order : destSlots.map((_, k) => k));
    // A slot the city gains appears out of the gathered system at the height of its pulse, never before.
    const emergence = smoothstep(windowProgress(ms, pulseStart + BEAT_MS.gainedSlot, pulseEnd));
    destSlots.forEach((slot, k) => {
      const gained = !continued.has(k);
      rings.push({
        at: add(lerpVec(startFor[k], slot, divide), shake),
        radius: ringRadiusNow * (1 + 0.14 * pulse) * (gained ? lerp(0.3, 1, emergence) : 1),
        lineScale: 1 + 0.6 * pulse,
        alpha: gained ? ringAlpha * emergence : ringAlpha,
      });
    });
  } else {
    // Same count, or a merge: slots travel directly; a merge's extra slots emerge from the centre.
    const travel = city.event === "merge" ? easing.slots : easing.geometry;
    const pairs = assignPoints(
      sourceSlots.length <= destSlots.length ? sourceSlots : destSlots,
      sourceSlots.length <= destSlots.length ? destSlots : sourceSlots,
    );
    const startFor: Array<Vec | null> = destSlots.map(() => null);
    if (sourceSlots.length <= destSlots.length) pairs.forEach((destIndex, sourceIndex) => (startFor[destIndex] = sourceSlots[sourceIndex]));
    else pairs.forEach((sourceIndex, destIndex) => (startFor[destIndex] = sourceSlots[sourceIndex]));
    const mergePulse = city.event === "merge" ? pulse : 0;
    if (sourceSlots.length > destSlots.length) {
      // Surplus source slots converge on their nearest destination slot and fade into it.
      sourceSlots.forEach((point, sourceIndex) => {
        if (pairs.includes(sourceIndex)) return;
        let nearest = 0;
        let nearestD = Infinity;
        destSlots.forEach((slot, k) => {
          const d = dist(point, slot);
          if (d < nearestD) {
            nearestD = d;
            nearest = k;
          }
        });
        rings.push({
          at: add(lerpVec(point, destSlots[nearest], travel), shake),
          radius: ringRadiusNow,
          lineScale: 1,
          alpha: ringAlpha * (1 - travel),
        });
      });
    }
    destSlots.forEach((slot, k) => {
      const start = startFor[k];
      const emerging = start === null;
      rings.push({
        at: add(emerging ? lerpVec(anchor, slot, travel) : lerpVec(start as Vec, slot, travel), shake),
        radius: ringRadiusNow * (emerging ? travel : 1) * (1 + 0.14 * mergePulse),
        lineScale: 1 + 0.6 * mergePulse,
        alpha: emerging ? Math.min(ringAlpha, travel) : ringAlpha,
      });
    });
  }

  /* Whole circles at both ends. A city that had rings starts from its own printed circles and lets their crossings go
     over the beat it tenses, as its slots begin to move; a city whose rings never move keeps them whole throughout;
     every city closes them again as it settles. */
  const departure = sourceHasRings
    ? city.event === "static"
      ? 1
      : 1 - smoothstep(inWindow(ms, TIMELINE.tension))
    : 0;
  const settled = settling(plan, ms);
  return { blobs, rings, ringsWhole: Math.max(departure, settled), markerScale, alpha: 1 };
}

/* ==================================================================
 *  DESIGN NOTE 1473: MERGING CITIES REACH FOR EACH OTHER AS BODIES
 * ==================================================================
 * REPORTED: a frozen frame of New York's merge (#54 -> #883) "reads as: a new piece of track has been drawn between
 * two cities rather than: the two city bodies are merging into one larger city". ASKED FOR: city body -> fusion ->
 * track continuity; "the connection should broaden into city area rather than remaining a narrow rail-like stroke";
 * restrained, no goo, no wobble; generic, never keyed to New York.
 *
 * THE CAUSE WAS THE NECK, NOT THE RAIL. #54 -> #883 builds no rail at all: its four rails are reconfigured and none is
 * added, so nothing there erupts. The neck was the merged outline stroked at `fuse` times a city's radius from the
 * moment `fuse` began. Early on every point of that outline still sits in one of the two old cities, so it ran
 * straight from one city to the other, and a city is drawn as an ink band with white inside: a stroke thinner than
 * the band is all ink -- a black stroke about as wide as a rail, city to city, with no white inside it until about
 * 600 ms at hex size 40.
 *
 * SO THE NECK IS NEVER THINNER THAN A CITY. Every stretch of the merged outline that one city already holds is drawn at
 * that city's own width, and across each gap between two cities a reach grows from either side at the same width,
 * `fuse` of the way to the gap's middle. The cities bulge toward each other, touch, and fuse, and the slots the merged
 * city adds emerge from its centre into city that is already there. At `fuse` 1 the reaches have met and the neck is
 * the whole outline, drawn as the one shape it was before, so the settled frame is unchanged. `fuse`, its window and
 * every other time are unchanged; so are the outlines, the slots and the rails.
 *
 * WHICH MERGES. Every centre with several sources that is a city: New York's two circles into a four-slot square, and
 * the rules-illegal #59 facings that join two circles into one (D-22). Towns merge without a neck -- their dits travel
 * together and fuse in `townFrame` -- and are untouched. */

/** Merging cities' neck while it forms (see above): every stretch of the merged outline one city's body already holds,
 *  at that body's width, and across each gap between two cities a reach from either side, `reach` of the way to the
 *  gap's middle -- so the neck is never narrower than a city, and at `reach` 1 the runs are the whole outline. */
function reachingNeck(points: readonly Vec[], owners: readonly number[], closed: boolean, reach: number, radius: number): FrameBlob[] {
  const count = points.length;
  const edges: Array<[number, number]> = [];
  for (let k = 0; k + 1 < count; k += 1) edges.push([k, k + 1]);
  if (closed && count >= 3) edges.push([count - 1, 0]);
  const firstGap = edges.findIndex(([a, b]) => owners[a] !== owners[b]);
  if (firstGap < 0) return [{ points: points.slice(), closed, radius }];
  const tip = (from: Vec, to: Vec) => lerpVec(from, lerpVec(from, to, 0.5), reach);
  // A closed outline is walked from just past its first gap, so every run starts and ends at a reach.
  const walk = closed && count >= 3 ? [...edges.slice(firstGap + 1), ...edges.slice(0, firstGap + 1)] : edges;
  const runs: Vec[][] = [];
  let run: Vec[] = closed && count >= 3 ? [tip(points[edges[firstGap][1]], points[edges[firstGap][0]]), points[edges[firstGap][1]]] : [points[0]];
  walk.forEach(([a, b], index) => {
    if (owners[a] === owners[b]) {
      run.push(points[b]);
      return;
    }
    run.push(tip(points[a], points[b]));
    runs.push(run);
    const closesTheLoop = closed && count >= 3 && index === walk.length - 1;
    run = closesTheLoop ? [] : [tip(points[b], points[a]), points[b]];
  });
  if (run.length > 0) runs.push(run);
  return runs.map((stretch) => ({ points: stretch, closed: false, radius }));
}

function centroidScale(sources: readonly ArtMarker[]): number {
  if (sources.length === 0) return 1;
  return sources.reduce((sum, source) => sum + source.scale, 0) / sources.length;
}

/** One outline becoming another: matched points travel, extra destination points extrude from the source's
 *  centre, surplus source points collapse onto their nearest destination point. Drawn in the destination's
 *  order, so the last frame is the destination's own path. */
function morphOutline(
  from: { points: Vec[]; closed: boolean },
  to: { points: Vec[]; closed: boolean },
  u: number,
  radius: number,
  shake: Vec,
): FrameBlob {
  if (to.points.length === 0) {
    return { points: from.points.map((point) => add(point, shake)), closed: from.closed, radius };
  }
  if (from.points.length <= to.points.length) {
    const order = assignPoints(from.points, to.points);
    const start: Vec[] = to.points.map(() => centroid(from.points));
    order.forEach((destIndex, sourceIndex) => (start[destIndex] = from.points[sourceIndex]));
    return {
      points: to.points.map((point, k) => add(lerpVec(start[k], point, u), shake)),
      closed: to.closed,
      radius,
    };
  }
  const order = assignPoints(from.points, to.points);
  return {
    points: from.points.map((point, k) => add(lerpVec(point, to.points[order[k]], u), shake)),
    closed: from.closed,
    radius,
  };
}

function townFrame(plan: TileTransitionPlan, city: CityPlan, easing: TransitionEasings, ms: number): FrameTown[] {
  const dest = plan.toArt.markers[city.dest];
  const destRadius = dest.scale * 0.14;
  if (city.sources.length === 0) {
    const grow = settleEase(inWindow(ms, TIMELINE.emerge));
    return [{ at: dest.at, radius: destRadius * grow, alpha: 1 }];
  }
  // Each source dit travels to the destination; merging dits meet and fuse there -- and, once met, are one dit:
  // every dit after the first fades as the shape settles, so the settled frame draws the town once.
  const handOver = 1 - settling(plan, ms);
  return city.sources.map((i, k) => {
    const source = plan.fromArt.markers[i];
    return {
      at: lerpVec(source.at, dest.at, easing.geometry),
      radius: lerp(source.scale * 0.14, destRadius, easing.geometry),
      alpha: k === 0 ? 1 : handOver,
    };
  });
}

/** Moves a piece's point `k` so an end attached to a moving centre stays attached to it. */
function attachToMovingCentres(
  plan: TileTransitionPlan,
  piece: Piece,
  points: Vec[],
  geometry: number,
  fromStartOfPiece: boolean,
): Vec[] {
  const offsetFor = (node: PieceNode): Vec | null => {
    if (node.kind !== "marker") return null;
    const city = cityForMarker(plan, node.index);
    if (!city || city.sources.length === 0) return null;
    const now = markerPositionAt(plan, city, geometry);
    const final = plan.toArt.markers[node.index].at;
    const offset = sub(now, final);
    return Math.hypot(offset.x, offset.y) < 1e-6 ? null : offset;
  };
  const startOffset = offsetFor(piece.from);
  const endOffset = offsetFor(piece.to);
  if (!startOffset && !endOffset) return points;
  const count = PIECE_POINTS - 1;
  return points.map((point, index) => {
    // `index` counts along the drawn polyline; map it back onto the piece's own parameter.
    const along = fromStartOfPiece ? index / count : 1 - index / count;
    let moved = point;
    if (startOffset) moved = add(moved, scale(startOffset, 1 - along));
    if (endOffset) moved = add(moved, scale(endOffset, along));
    return moved;
  });
}

/** The picture at `t` in 0..1. `t >= 1` is the committed destination exactly; the renderer hands over before that. */
export function sampleTileTransition(plan: TileTransitionPlan, tRaw: number): TileTransitionFrame {
  const t = clamp01(tRaw);
  const easing = transitionEasings(plan, t);
  if (plan.reducedMotion) {
    return plan.provisional ? destinationFrame(plan, PROVISIONAL.wash * (1 - easing.reveal)) : crossfadeFrame(plan, easing.reveal);
  }
  const ms = t * plan.durationMs;
  const proposal = proposalAt(plan, ms);
  // A changing centre's planned shape recedes behind the centre itself over the lead (#1471).
  const targetCentreAlpha = proposal * lerp(1, PROVISIONAL.targetCentreAlpha, smoothstep(windowProgress(ms, 0, BEAT_MS.lead)));
  const frame: TileTransitionFrame = {
    fills: proposalFills(plan, proposal),
    rim: proposalRim(plan, proposal),
    tracks: [],
    crossings: plan.destCrossings,
    destLayers: plan.destLayers,
    cities: [],
    towns: [],
    ink: TILE_TRACK_INK[plan.toTier] ?? STANDARD_TRACK_INK,
    present: {
      wash: PROVISIONAL.wash * proposal,
      front: revealFront(easing.reveal),
      committedFill: ERA_TILE_FILL[plan.toTier],
      committedRim: COLOR_TIER_STROKE[plan.toTier],
    },
  };

  // Planned shapes follow everything else in the frame; the painter puts them underneath.
  const targetTracks: FrameTrack[] = [];
  for (const track of plan.tracks) {
    if (track.cls === "removed" && track.from) {
      const fade = 1 - smoothstep(inWindow(ms, TIMELINE.vanish));
      if (fade > 0) frame.tracks.push({ points: track.from.points, alpha: fade, destTrack: null });
      continue;
    }
    const piece = track.to as Piece;
    if (track.cls === "persistent") {
      frame.tracks.push({ points: piece.points, alpha: 1, destTrack: piece.track, role: "static" });
      continue;
    }
    if (proposal > 0) targetTracks.push({ points: piece.points, alpha: proposal, destTrack: piece.track, role: "target" });
    if (track.cls === "reconfigured" && track.from) {
      const from = track.from.points;
      frame.tracks.push({
        points: piece.points.map((point, k) => lerpVec(from[k], point, easing.geometry)),
        alpha: 1,
        destTrack: piece.track,
      });
    } else if (track.cls === "added") {
      if (ms <= track.startMs) continue;
      const drawn = track.growsFromEnd ? piece.points.slice().reverse() : piece.points;
      const attached = attachToMovingCentres(plan, piece, drawn, easing.geometry, !track.growsFromEnd);
      pushConstructionWave(frame, attached, polylineLength(piece.points), piece.track, ms, track.startMs, track.durationMs, BEAT_MS.portionSettle);
    }
  }
  frame.tracks.push(...targetTracks);

  const targetCentres: Array<FrameCity | FrameTown> = [];
  for (const city of plan.cities) {
    const dest = plan.toArt.markers[city.dest];
    if (staysPut(plan, city)) {
      pushCentre(frame, staticCentre(dest, 1, "static"));
      continue;
    }
    if (targetCentreAlpha > 0) targetCentres.push(staticCentre(dest, targetCentreAlpha, "target"));
    if (city.kind === "town") frame.towns.push(...townFrame(plan, city, easing, ms));
    else frame.cities.push(cityFrame(plan, city, ms, easing));
  }
  const vanish = 1 - settleEase(inWindow(ms, TIMELINE.vanish));
  for (const index of plan.vanishing) {
    const marker = plan.fromArt.markers[index];
    if (vanish <= 0) break;
    if (marker.kind === "town") frame.towns.push({ at: marker.at, radius: marker.scale * 0.14 * vanish, alpha: 1 });
    else {
      const outline = outlineOf(marker);
      frame.cities.push({
        blobs: [{ points: outline.points, closed: outline.closed, radius: marker.scale * STATION_RADIUS_RATIO * vanish }],
        rings: [],
        ringsWhole: 1,
        markerScale: marker.scale,
        alpha: 1,
      });
    }
  }
  targetCentres.forEach((centre) => pushCentre(frame, centre));
  return frame;
}

/** A revenue centre that is the same drawing on both tiles: one source, where it stood, with the same slots at the
 *  same size. It is the proposal's own element and never moves (#1471). */
function staysPut(plan: TileTransitionPlan, city: CityPlan): boolean {
  if (city.event !== "static" || city.sources.length !== 1) return false;
  return Math.abs(plan.fromArt.markers[city.sources[0]].scale - plan.toArt.markers[city.dest].scale) < 1e-6;
}

/** One marker drawn where it stands, as the tile pass draws it. */
function staticCentre(marker: ArtMarker, alpha: number, role?: FrameRole): FrameCity | FrameTown {
  if (marker.kind === "town") return { at: marker.at, radius: marker.scale * 0.14, alpha, role };
  const outline = outlineOf(marker);
  const radius = marker.scale * STATION_RADIUS_RATIO;
  return {
    blobs: [{ points: outline.points, closed: outline.closed, radius }],
    rings: marker.slots > 1 ? slotCentres(marker).map((at) => ({ at, radius: radius * SLOT_RING_RATIO, lineScale: 1, alpha: 1 })) : [],
    ringsWhole: 1,
    markerScale: marker.scale,
    alpha,
    role,
  };
}

function pushCentre(frame: TileTransitionFrame, centre: FrameCity | FrameTown): void {
  if (centre.alpha <= 0) return;
  if ("blobs" in centre) frame.cities.push(centre);
  else frame.towns.push(centre);
}

/** The whole destination at rest -- a proposal washed `wash` of the way, or the committed tile at 0 (#1471). */
function destinationFrame(plan: TileTransitionPlan, wash: number): TileTransitionFrame {
  const frame: TileTransitionFrame = {
    fills: [{ color: provisionalColor(ERA_TILE_FILL[plan.toTier], wash), alpha: 1 }],
    rim: { color: provisionalColor(COLOR_TIER_STROKE[plan.toTier], wash), alpha: 1 },
    tracks: [],
    crossings: plan.destCrossings,
    destLayers: plan.destLayers,
    cities: [],
    towns: [],
    ink: TILE_TRACK_INK[plan.toTier] ?? STANDARD_TRACK_INK,
    present: { wash, front: -REVEAL_SPAN, committedFill: ERA_TILE_FILL[plan.toTier], committedRim: COLOR_TIER_STROKE[plan.toTier] },
  };
  for (const track of plan.tracks) {
    if (track.to) frame.tracks.push({ points: track.to.points, alpha: 1, destTrack: track.to.track, role: "static" });
  }
  plan.toArt.markers.forEach((marker) => pushCentre(frame, staticCentre(marker, 1, "static")));
  return frame;
}

/** Reduced motion, for a lay nobody proposed here: a quick crossfade of the two tiles (#1465). */
function crossfadeFrame(plan: TileTransitionPlan, a: number): TileTransitionFrame {
  const toRim = COLOR_TIER_STROKE[plan.toTier];
  const frame: TileTransitionFrame = {
    fills: [
      ...(plan.fromTier ? [{ color: ERA_TILE_FILL[plan.fromTier], alpha: 1 }] : []),
      { color: ERA_TILE_FILL[plan.toTier], alpha: a },
    ],
    rim: plan.fromTier ? { color: mixColor(COLOR_TIER_STROKE[plan.fromTier], toRim, a), alpha: 1 } : { color: toRim, alpha: a },
    tracks: [],
    crossings: plan.destCrossings,
    destLayers: plan.destLayers,
    cities: [],
    towns: [],
    ink: TILE_TRACK_INK[plan.toTier] ?? STANDARD_TRACK_INK,
    present: null,
  };
  for (const track of plan.tracks) {
    if (track.from) frame.tracks.push({ points: track.from.points, alpha: 1 - a, destTrack: null });
    if (track.to) frame.tracks.push({ points: track.to.points, alpha: a, destTrack: track.to.track });
  }
  // Stations are opaque, so they swap at the midpoint rather than crossfading into a see-through pair.
  plan.fromArt.markers.forEach((marker) => pushCentre(frame, staticCentre(marker, a < 0.5 ? 1 : 0)));
  plan.toArt.markers.forEach((marker) => pushCentre(frame, staticCentre(marker, a < 0.5 ? 0 : 1)));
  return frame;
}

const proposals = new Map<string, TileTransitionFrame | null>();

/** The tile being chosen on a hex, drawn as the proposal it is (#1471): the whole destination tile at that facing,
 *  washed, and nothing of the tile beneath it -- the frame a confirmed lay starts from. Frames are shared and must
 *  not be changed. `null` for a tile with no describable artwork. */
export function proposedTileFrame(tileId: number, orientation: number): TileTransitionFrame | null {
  const facing = ((orientation % 6) + 6) % 6;
  const key = `${tileId}@${facing}`;
  const known = proposals.get(key);
  if (known !== undefined) return known;
  const plan = planTileTransition({ from: { kind: "tile", tileId, orientation: facing }, to: { tileId, orientation: facing } });
  const frame = plan ? destinationFrame(plan, PROVISIONAL.wash) : null;
  proposals.set(key, frame);
  return frame;
}

/** How a hex's printed value is presented (#1471), for the board's badge pass, which draws it after the tile. */
export interface BadgePresentation {
  /** The value the hex printed before a lay nobody proposed here: it goes as the proposal arrives. */
  outgoingAlpha: number;
  /** The destination's value where it is still a proposal. */
  provisionalAlpha: number;
  /** The commit front, as a frame's (`FramePresentation.front`): west of it the value is committed, at full strength. */
  front: number;
}

/** A proposal's value, before any confirm. */
export const PROPOSED_BADGE: BadgePresentation = { outgoingAlpha: 0, provisionalAlpha: PROVISIONAL.badgeAlpha, front: -REVEAL_SPAN };

export function badgePresentationAt(plan: TileTransitionPlan, t: number): BadgePresentation {
  const easing = transitionEasings(plan, clamp01(t));
  if (plan.reducedMotion) {
    return plan.provisional
      ? { outgoingAlpha: 0, provisionalAlpha: lerp(PROVISIONAL.badgeAlpha, 1, easing.reveal), front: -REVEAL_SPAN }
      : { outgoingAlpha: 1 - easing.reveal, provisionalAlpha: easing.reveal, front: -REVEAL_SPAN };
  }
  const proposal = proposalAt(plan, clamp01(t) * plan.durationMs);
  return { outgoingAlpha: 1 - proposal, provisionalAlpha: PROVISIONAL.badgeAlpha * proposal, front: revealFront(easing.reveal) };
}

/* ==================================================================
 *  DESIGN NOTE 1466: A TOKEN IS A PIECE SEATED IN ITS STATION, AND KEEPS ITS OWN IDENTITY
 * ==================================================================
 * A placed corporation token is an object with an owner, not a station slot. The renderer resolves where it
 * stood before (the old tile, the old city index) and where authoritative state puts it now (the new tile, the new
 * city index), both through the board's own token placement geometry, and hands all four here. Nothing here
 * decides a destination, a city or a slot.
 *
 * REVISED BY #1472. This note first had the token ride its city's anchor and swing to its new place about it, never
 * joining the gather of #1463 -- and #1471 then held a confirmed proposal's tokens at their final places while the
 * city moved beneath them. ASKED FOR instead: "Tokens should behave like physical pieces seated in the station slots
 * being transformed" -- a token "follows the station slot / city geometry that currently contains it until the
 * transformation resolves into its authoritative final slot"; never parked at its final place, never duplicated,
 * and allowed to overlap another token at a gather.
 *
 * SO A TOKEN RIDES ITS SEAT THROUGH ITS CITY'S OWN CHOREOGRAPHY, between its own two authoritative ends:
 *   ONE SLOT BECOMING MORE (mitosis): it sits in the lone slot while the city tenses and pulses, and leaves with the
 *     split toward its final slot -- along the branch that ends there. The other branch stays empty.
 *   SEVERAL BECOMING ANOTHER NUMBER (reorganise): it gathers inward with its slot, so the two tokens of a full
 *     two-slot city converge and overlap at the gather, and separates with the reorganisation to its own final slot.
 *     A gained slot stays empty.
 *   SLOTS TRAVELLING (a moving or reshaping city, a merge): it travels with its slot, at the slots' own pace, so the
 *     tokens of merging cities stay distinct pieces and arrive in their final slots as the merged city forms.
 *   A LONE CIRCLE ON BOTH SIDES (a migration): it sits in the circle as the circle moves.
 *   A CITY THAT DOES NOT CHANGE AT ALL: nothing moves it -- except where the board orders the same slots differently
 *     on the two tiles (#15 or #619 -> #63, #810 -> #882 at some facings), so that the token's authoritative slot is
 *     the other one. There is no transformation to ride: a confirmed proposal already drew the token in that slot and
 *     it stays; a lay nobody proposed swings it about the city's centre into place (the first motion of this note),
 *     finished before the commit begins.
 * The anchor, the shake, the gather's reach and every easing are the rings' own (`cityMotion`, `GATHER_REACH`), so
 * a token and the slot holding it cannot drift apart in time, and nothing here moves `stationEmergence`.
 *
 * IDENTITY IS NEVER GEOMETRY'S. The rings pair old slots with new ones by distance, because rings are
 * indistinguishable; a token's two ends are its own, per company, from authoritative state. Two tokens that overlap
 * at a gather therefore leave it for their own slots, and a symmetric destination cannot swap them.
 *
 * WHERE THERE IS NO SEAT TO READ -- the old city the token stood in is not a source of the city it now stands in;
 * either city index is unknown on a hex with several cities (the rail-less printed OO circles, whose token's city is
 * the president's choice, #824, D-21); or the token is not drawn in a slot of the city its index names (printed New
 * York draws every token in its first circle, #221) -- the token moves as it did before: with the anchors of its own
 * two cities. A seat is read, never guessed.
 *
 * NOTHING HERE DRAWS A TOKEN. One token, one position, per frame; the renderer draws each once, over the tile, in its
 * own fixed order.
 *
 * REVISED BY #1473, TWICE.
 *   A HOME RESERVATION MARKER RIDES THE SAME SEAT. It is not a token and has no identity to keep, but it is drawn in a
 *     city -- on its centre, or in one of its slots -- and "should not sit at the authoritative destination while
 *     its city moves underneath". A reservation carries no city index, so its city is read from where the board
 *     draws it: the one city whose centre or slot it stands on, on each tile (`reservationPositionAt`). It then rides
 *     exactly a token's seat. A marker on a city's centre stays on that centre through a split or a reorganisation
 *     -- it never follows a branch, so new capacity cannot split it -- and travels with a migrating or merging city.
 *     Where no city is read, or the old city is not a source of the new one (an OO home's second margin marker, whose
 *     circle becomes the other city, D-21), it moves straight to its place, as #1466 moved it.
 *   A TOKEN THE LAY MOVES HAS A PLANNED PLACE. "This is where the token is planned to end up -> confirm -> this is the
 *     real physical token moving there." While a tile is being chosen, a token the lay will move is drawn only at its
 *     planned place, faint (`PROVISIONAL.pieceAlpha`); from the confirm that planned place stays, under every piece,
 *     while the token itself rides in from where it stood, and it is gone once the token has settled into it with the
 *     commit (`pieceTargetPresence`). A token the lay does not move -- nowhere along its ride further than a shake from
 *     its place (`pieceMoves`) -- has no planned place and is drawn as it always was. A RESERVATION MARKER IS THE
 *     EXCEPTION: it is already drawn as a faded token, so it gets no second, fainter copy. While a tile is being chosen
 *     a marker the lay will move is left out of the proposal; from the confirm the real marker rides in from where it
 *     stood; a marker the lay does not move stays as it was. Reduced motion rides nothing and shows no planned place.
 *
 * REVISED BY #1474: A PLANNED PLACE ANSWERS A PROPOSAL, SO ONLY A PROPOSED LAY HAS ONE. #1473 also showed it on a lay
 * nobody proposed here -- another seat's, a replay's -- arriving with that lay's proposal over the lead, where it
 * answered no choice the viewer had made; the ruling was to remove it from "lays that the local player did not
 * actually preview/propose". Such a lay's tokens start from their seats on the tile the hex showed, ride their city
 * exactly as before, and settle into their places with nothing waiting there. A confirmed proposal is unchanged. */
export interface TokenMotion {
  from: Vec;
  fromRadius: number;
  /** The anchor of the city the token stood in, when known -- only for where no seat can be read. */
  fromAnchor?: Vec;
  to: Vec;
  toRadius: number;
  toAnchor?: Vec;
  /** The city the token stood in on the old side, and the one it stands in on the new side, by CITY index (towns not
   *  counted): authoritative state's answer, never the geometry's (#1472). */
  fromCity?: number;
  toCity?: number;
}

/** How near one of its city's slot centres a token must stand to be seated there, unit hex. The board's token slot
 *  points and `slotCentres` agree to within 1e-6 on every tile, facing and city. */
const SEAT_TOLERANCE = 1e-3;

/** Whether `at` is one of `marker`'s slots -- where the board draws a token seated in that city. */
function seatedIn(marker: ArtMarker | undefined, at: Vec): boolean {
  return marker !== undefined && slotCentres(marker).some((slot) => dist(slot, at) < SEAT_TOLERANCE);
}

/** The index in `art.markers` of the `cityIndex`-th city, towns not counted. With no index, a hex with exactly one
 *  city answers that city -- a token there can stand nowhere else. */
function cityMarkerIndex(art: HexArt, cityIndex: number | undefined): number | undefined {
  const cities = art.markers.flatMap((marker, index) => (marker.kind === "city" ? [index] : []));
  if (cityIndex === undefined) return cities.length === 1 ? cities[0] : undefined;
  return cities[cityIndex];
}

/** Where a token is at `t`, seated in its station (see above). `t >= 1` is exactly its authoritative place. */
export function tokenPositionAt(plan: TileTransitionPlan, t: number, motion: TokenMotion): { at: Vec; radius: number } {
  const fromMarker = cityMarkerIndex(plan.fromArt, motion.fromCity);
  const toMarker = cityMarkerIndex(plan.toArt, motion.toCity);
  const seated =
    fromMarker !== undefined &&
    toMarker !== undefined &&
    seatedIn(plan.fromArt.markers[fromMarker], motion.from) &&
    seatedIn(plan.toArt.markers[toMarker], motion.to);
  return rideAt(plan, t, motion, seated ? fromMarker : undefined, seated ? toMarker : undefined);
}

/** A home reservation marker's two places, unit hex (#1473). */
export interface ReservationMotion {
  from: Vec;
  to: Vec;
}

/** The city a piece is drawn in, read from where it stands: the one city whose centre, or one of whose slots, it
 *  stands on (#1473). */
function cityMarkerAt(art: HexArt, at: Vec): number | undefined {
  const index = art.markers.findIndex((marker) => marker.kind === "city" && (dist(marker.at, at) < SEAT_TOLERANCE || seatedIn(marker, at)));
  return index < 0 ? undefined : index;
}

/** Where a home reservation marker is at `t`, riding the seat it is drawn in (see above). `t >= 1` is exactly `to`. */
export function reservationPositionAt(plan: TileTransitionPlan, t: number, motion: ReservationMotion): Vec {
  const piece: TokenMotion = { from: motion.from, fromRadius: 0, to: motion.to, toRadius: 0 };
  return rideAt(plan, t, piece, cityMarkerAt(plan.fromArt, motion.from), cityMarkerAt(plan.toArt, motion.to)).at;
}

/** A piece's ride between its two places, seated in the city `fromMarker` becomes when both are given and the plan
 *  makes the one a source of the other, and otherwise with its two cities' anchors. */
function rideAt(
  plan: TileTransitionPlan,
  t: number,
  motion: TokenMotion,
  fromMarker: number | undefined,
  toMarker: number | undefined,
): { at: Vec; radius: number } {
  const clamped = clamp01(t);
  const easing = transitionEasings(plan, clamped);
  const final = { at: motion.to, radius: motion.toRadius };
  if (plan.reducedMotion) {
    // No city is shown changing, so there is no seat to ride: a lay nobody proposed swaps at the midpoint, as its
    // stations do; a confirmed proposal already drew its pieces where the lay puts them, and they stay there.
    if (plan.provisional) return final;
    return easing.reveal < 0.5 ? { at: motion.from, radius: motion.fromRadius } : final;
  }
  if (clamped >= 1) return final;
  const radius = lerp(motion.fromRadius, motion.toRadius, easing.slots);
  const city = toMarker === undefined ? undefined : plan.cities[toMarker];
  if (!city || fromMarker === undefined || !city.sources.includes(fromMarker)) {
    return { at: anchoredRide(easing, motion), radius };
  }
  const ms = clamped * plan.durationMs;
  if (staysPut(plan, city)) {
    if (plan.provisional) return final;
    const { revealStart } = plan.clock;
    const reseat = settleEase(windowProgress(ms, Math.min(spanMs(TIMELINE.geometry)[0], revealStart / 2), revealStart));
    if (reseat <= 0) return { at: motion.from, radius: motion.fromRadius };
    if (reseat >= 1 || dist(motion.from, motion.to) < 1e-9) return final;
    const centre = plan.toArt.markers[city.dest].at;
    return { at: swing(centre, centre, motion.from, motion.to, 1, reseat), radius: lerp(motion.fromRadius, motion.toRadius, reseat) };
  }
  const { anchor, shake } = cityMotion(plan, city, ms, easing);
  const choreography = ringChoreography(plan.fromArt, plan.toArt, city);
  let seat: Vec;
  if (choreography === "mitosis") {
    // In the lone slot, which rides the city's centre, until the split carries it to its own branch.
    seat = lerpVec(add(motion.from, sub(anchor, markerPositionAt(plan, city, 0))), motion.to, easing.slots);
  } else if (choreography === "reorganise") {
    // In its slot as the slots gather, then out with the reorganisation to its own final slot.
    const gathered = lerpVec(motion.from, anchor, GATHER_REACH * smoothstep(inWindow(ms, TIMELINE.gather)));
    seat = lerpVec(gathered, motion.to, easing.slots);
  } else if (choreography === "travel") {
    seat = lerpVec(motion.from, motion.to, city.event === "merge" ? easing.slots : easing.geometry);
  } else {
    // A lone circle: its centre moves with the circle's own outline.
    seat = lerpVec(motion.from, motion.to, settleInto(plan, ms, TIMELINE.outline));
  }
  return { at: add(seat, shake), radius };
}

/** How far a piece may stand from its place and still not count as moved by the flourish, unit hex: more than a city's
 *  shake (0.014), less than anything a player would see travel. */
const PIECE_STILL = 0.02;

/** Whether the flourish moves a piece at all (#1473): whether, sampled every 8 ms of its ride, it ever stands further
 *  than `PIECE_STILL` from `to`. Only a token it moves has a planned place; a reservation marker it moves is left out
 *  of the proposal instead. */
export function pieceMoves(plan: TileTransitionPlan, to: Vec, positionAt: (t: number) => Vec): boolean {
  const steps = Math.max(1, Math.ceil(plan.durationMs / 8));
  for (let step = 0; step < steps; step += 1) {
    if (dist(positionAt(step / steps), to) > PIECE_STILL) return true;
  }
  return false;
}

/** How much of a moving token's planned place shows at `t` (#1473), 0..1: all of it from a confirmed proposal's first
 *  frame, and gone as the commit settles the token into it. None for a lay nobody proposed here (#1474), which had no
 *  proposal to plan it, and none under reduced motion, where nothing rides. */
export function pieceTargetPresence(plan: TileTransitionPlan, t: number): number {
  if (plan.reducedMotion || !plan.provisional) return 0;
  const ms = clamp01(t) * plan.durationMs;
  return proposalAt(plan, ms) * (1 - settling(plan, ms));
}

/** #1466's first motion, kept for a token whose seat cannot be read: its city's anchor travels, and it moves from
 *  its old place about that anchor to its new one in polar terms. */
function anchoredRide(easing: TransitionEasings, motion: TokenMotion): Vec {
  return swing(motion.fromAnchor ?? motion.from, motion.toAnchor ?? motion.to, motion.from, motion.to, easing.geometry, easing.slots);
}

/** From `from` about `fromAnchor` to `to` about `toAnchor`: the anchor travels by `travel`, and the offset turns and
 *  stretches by `turn` -- so two pieces trading places about one centre go round it, never through each other. */
function swing(fromAnchor: Vec, toAnchor: Vec, from: Vec, to: Vec, travel: number, turn: number): Vec {
  if (travel <= 0 && turn <= 0) return from;
  if (travel >= 1 && turn >= 1) return to;
  const anchor = lerpVec(fromAnchor, toAnchor, travel);
  const a = sub(from, fromAnchor);
  const b = sub(to, toAnchor);
  const ra = Math.hypot(a.x, a.y);
  const rb = Math.hypot(b.x, b.y);
  let offset: Vec;
  if (ra < 0.02 || rb < 0.02) {
    offset = lerpVec(a, b, turn);
  } else {
    const angleA = Math.atan2(a.y, a.x);
    let delta = Math.atan2(b.y, b.x) - angleA;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const angle = angleA + delta * turn;
    const r = lerp(ra, rb, turn);
    offset = { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  }
  return add(anchor, offset);
}

/** A city's anchor on either side of the plan, by CITY index (towns excluded), for token motion. */
export function cityAnchor(plan: TileTransitionPlan, side: "from" | "to", cityIndex: number | undefined): Vec | undefined {
  if (cityIndex === undefined) return undefined;
  const art = side === "from" ? plan.fromArt : plan.toArt;
  const cities = art.markers.filter((marker) => marker.kind === "city");
  return cities[cityIndex]?.at;
}

/* ------------------------------------------------------------------ */
/* Presented-tile diffing, for the renderer's staging (#1465)          */
/* ------------------------------------------------------------------ */

export interface PresentedTile {
  tileId: number;
  orientation: number;
}

const TIER_RANK: Readonly<Record<TileColorTier, number>> = { Yellow: 0, Green: 1, Brown: 2, Gray: 3 };

/** Whether an old -> new change of the tile presented on a hex is one this flourish plays.
 *  A lay (nothing -> tile) and a replacement that does not drop a tier are; a removal, a downgrade, and a
 *  re-facing of the same tile (which only a replay or an undo produces) are not -- those snap. */
export function isAnimatableChange(from: PresentedTile | null, to: PresentedTile | null): boolean {
  if (to === null) return false;
  if (from === null) return true;
  if (from.tileId === to.tileId) return false;
  const a = TILE_CATALOG_BY_ID.get(from.tileId);
  const b = TILE_CATALOG_BY_ID.get(to.tileId);
  if (!a || !b) return false;
  return TIER_RANK[b.color] >= TIER_RANK[a.color];
}

/** Summary of a plan's classification -- what the batch report and the tests read. */
export function describeTransition(plan: TileTransitionPlan): {
  persistent: number;
  reconfigured: number;
  added: number;
  removed: number;
  cities: Array<{ kind: "city" | "town"; event: CityPlan["event"]; fromSlots: number[]; toSlots: number; migrates: boolean }>;
} {
  const count = (cls: TrackClass) => plan.tracks.filter((track) => track.cls === cls).length;
  return {
    persistent: count("persistent"),
    reconfigured: count("reconfigured"),
    added: count("added"),
    removed: count("removed"),
    cities: plan.cities.map((city) => ({
      kind: city.kind,
      event: city.event,
      fromSlots: city.sources.map((i) => plan.fromArt.markers[i].slots),
      toSlots: plan.toArt.markers[city.dest].slots,
      migrates: city.migrates,
    })),
  };
}
