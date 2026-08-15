// frontend/src/utils/routeAutoTrace.ts
//
// The Auto Route button's tracer -- a client-side SUGGESTION, not an oracle.
//
// ===================================================================
//  DESIGN NOTE 0: WHAT THIS IS, AND THE ONE THING IT MUST NEVER BECOME
// ===================================================================
//
// The Auto Route button had been disabled since Audit G-13 removed
// `ExecuteOperatingRound`, on the reasoning that the contract's own
// pathfinder (`pathfinding::trace_best_route_set`) no longer had a message
// reaching it. That reasoning is correct about the CONTRACT and wrong about
// the button: a player asking for a route drawn for them is asking the UI to
// pre-fill the manual builder, which is a client-side convenience that needs
// no chain at all. The result still travels to the contract as the same
// `RunManualRoute` the player could have clicked out by hand, and the
// contract still validates it.
//
// So this fills in `routePoints`. It does not decide revenue, it does not
// authorise anything, and its answer is explicitly labelled a suggestion in
// the UI. `sandboxRouteBreakdown` prices whatever comes out, exactly as it
// prices a hand-built chain.
//
// THE LINE THIS MUST NOT CROSS. `pathfinding.rs` remains the only authority
// on what a legal route IS. The list of things below is deliberately not a
// to-do:
//
//   - TOKEN ACCESS. A route must run through a city the corporation has a
//     token in, and may not pass through a city whose slots are full of
//     other companies' tokens. This starts AT a token hex, which satisfies
//     the first half by construction, and ignores the second entirely.
//   - CITY SLOTS. A two-city hex is one node here. Which of its stations a
//     train actually reaches is `city_node`'s question and this never sets
//     one.
//   - TRAIN COUNT. One route, for one train. The multi-train ALLOCATION
//     problem (`trace_best_route_set`) -- choosing the best SET of routes
//     jointly -- is still not attempted. The caller drafts one train at a
//     time and hands each one the hexes its predecessors took (design note
//     #4), which is a greedy approximation of that search, not the search.
//   - OVERLAP. Two trains may not reuse the same track SEGMENT. Design note
//     #4 bars whole HEXES instead, which is stricter and therefore safe for
//     a suggestion, but it is not the rule and must not be mistaken for it.
//
// ===================================================================
//  DESIGN NOTE 1: CONNECTIVITY IS CHECKED FROM BOTH SIDES
// ===================================================================
//
// Two hexes are joined when A carries a live edge pointing at B AND B
// carries the matching live edge pointing back. Checking one side only is
// the classic 18xx map bug: a dead-end stub (Richmond's single edge, New
// York's two disconnected one-edge stubs) reads as connected to whatever
// happens to sit beyond it, and the tracer walks off the end of the rails.
//
// `liveEdgesForHex` already resolves the four sources of track -- a laid
// tile's rotated mask, a preprinted gray hex, an off-board terminal's stub,
// a landmark's segments -- so this file asks it rather than knowing about
// any of them.

import {
  HEX_NEIGHBOR_OFFSETS,
  hexRouteValue,
  liveEdgesForHex,
} from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { TileColorTier } from "../components/hexTileCatalog";
import { isRouteTerminusHex, sandboxRouteBreakdown } from "./sandboxSession";

/** One traced stop, in the shape `App`'s `RoutePoint` already uses. */
export interface TracedHex {
  q: number;
  r: number;
  hexLabel: string;
}

const LABEL_BY_COORD: ReadonlyMap<string, string> = new Map(
  STATIC_BOARD_HEXES.map((hex) => [`${hex.q},${hex.r}`, hex.label]),
);

function labelFor(q: number, r: number): string | null {
  return LABEL_BY_COORD.get(`${q},${r}`) ?? null;
}

/** Design note #1: joined only when both hexes agree. */
function connectedNeighbours(mapGrid: MapGridResponse, q: number, r: number): TracedHex[] {
  const mine = new Set(liveEdgesForHex(mapGrid, q, r));
  const out: TracedHex[] = [];
  for (const edge of Array.from(mine)) {
    const offset = HEX_NEIGHBOR_OFFSETS[edge];
    if (!offset) continue;
    const nq = q + offset[0];
    const nr = r + offset[1];
    const hexLabel = labelFor(nq, nr);
    // Off the authentic board: there is no hex there to run to, whatever the
    // edge says.
    if (hexLabel === null) continue;
    const theirs = liveEdgesForHex(mapGrid, nq, nr);
    if (!theirs.includes((edge + 3) % 6)) continue;
    out.push({ q: nq, r: nr, hexLabel });
  }
  return out;
}

/* ==================================================================
 *  DESIGN NOTE 5: CLICKING TWO CITIES SHOULD NOT MEAN CLICKING NINE HEXES
 * ==================================================================
 *
 * REPORTED: manual routing forces the player to click every plain track hex
 * between two cities.
 *
 * It did, because the builder's only connectivity rule was "the next point
 * must be a DIRECT NEIGHBOUR of the last one". That rule is correct about
 * what a route is -- a connected chain of hexes -- and wrong about what a
 * player is doing when they draw one. Nobody choosing a route is choosing
 * the plain track; they are choosing the STOPS, and the track between them
 * is a consequence. A five-stop route across a built-up board was twenty
 * clicks, nineteen of which had exactly one legal answer.
 *
 * `bridgeWaypoints` resolves that consequence. Click a city, click the next
 * city, and the hexes in between are filled in.
 *
 * IT PREFERS PLAIN TRACK, AND THAT IS THE INTERESTING PART. The shortest
 * path by hex count is not always the one the player meant: a bridge that
 * happens to pass through a third city silently adds that city's revenue
 * AND spends one of the train's stops, neither of which was asked for. So
 * the search is weighted -- crossing a revenue centre costs far more than
 * crossing plain track, so a detour of several blank hexes is preferred to
 * a shortcut through a city. Where there is no alternative the centre IS
 * included, because the train genuinely stops there; it then appears in the
 * panel's stop list with its value, which is the honest outcome. What must
 * never happen is a stop appearing in the total that the player cannot see.
 *
 * THE MANUAL CLICK STILL WINS. Any hex the player clicks is added exactly
 * as before when it is adjacent, so disambiguating a branch by clicking
 * through it works unchanged -- the bridge only fills gaps the player left.
 *
 * WHAT THIS IS NOT. It does not check token access, city slot capacity, or
 * whether another train has already used this track. Same list as design
 * note #0, same owner: `pathfinding.rs`. This finds A connected path over
 * live rails, and the contract still judges whether the route is legal.
 */

/** The cost of routing a bridge THROUGH a revenue centre, in units of plain
 *  hexes. Large enough that no realistic detour outweighs it, finite so an
 *  unavoidable centre is still crossed rather than the bridge failing. */
const CENTRE_DETOUR_COST = 1000;

/**
 * The hexes joining `from` to `to` over live track, `to` included and
 * `from` excluded -- ready to append to a route that currently ends at
 * `from`.
 *
 * `null` when no connected path exists, which the caller reports rather
 * than papering over: two hexes with no rails between them are not a route,
 * and inventing a straight line across the board is exactly the class of
 * plausible fiction design note #216 deleted.
 *
 * `avoid` is the hexes already on this route. A route is a simple path, so
 * a bridge may not loop back through one -- without this, clicking a city
 * the route already passed through would produce a chain that visits a hex
 * twice and prices it once, and the two would disagree.
 */
export function bridgeWaypoints(
  mapGrid: MapGridResponse,
  from: TracedHex,
  to: TracedHex,
  avoid: ReadonlySet<string> = new Set(),
): TracedHex[] | null {
  const fromKey = `${from.q},${from.r}`;
  const toKey = `${to.q},${to.r}`;
  if (fromKey === toKey) return null;

  /* Dijkstra rather than a plain BFS, because the edges are not equal
     weight -- see the note above on why a centre costs more than a hex.
     The board is under a hundred nodes, so the linear scan for the next
     frontier node is cheaper than the heap it would replace. */
  const dist = new Map<string, number>([[fromKey, 0]]);
  /* TWO maps, and the split is load-bearing. The first cut stored the NODE
     under its own key and then tried to walk the chain back through it --
     which reads a node's predecessor as itself, loops, and (thanks to the
     length guard below) returned `null` for every connected pair on the
     board. `cameFrom` is the predecessor's key; `nodeAt` is how a key turns
     back into a hex with its label. */
  const cameFrom = new Map<string, string>();
  const nodeAt = new Map<string, TracedHex>([[fromKey, from]]);
  const settled = new Set<string>();

  for (;;) {
    let bestKey: string | null = null;
    let bestCost = Infinity;
    dist.forEach((cost, key) => {
      if (!settled.has(key) && cost < bestCost) {
        bestCost = cost;
        bestKey = key;
      }
    });
    if (bestKey === null) return null;
    if (bestKey === toKey) break;
    settled.add(bestKey);

    const [bq, br] = (bestKey as string).split(",").map(Number);
    for (const next of connectedNeighbours(mapGrid, bq, br)) {
      const key = `${next.q},${next.r}`;
      if (settled.has(key)) continue;
      // The destination is allowed even if `avoid` lists it -- the caller
      // decides what clicking an existing hex means, and that is the undo
      // rule rather than this function's business.
      if (key !== toKey && avoid.has(key)) continue;
      /* The DESTINATION's own value is not charged: the player asked for
         it, so its cost is not a reason to route around it. Only hexes the
         bridge passes THROUGH are weighted. */
      // `hexRouteValue` is `null` for a hex off the value table and `0` for
      // plain track; both mean "pays nothing", and only a positive value is
      // a revenue centre worth detouring around.
      const paysHere = (hexRouteValue(next.q, next.r, mapGrid) ?? 0) > 0;
      const step = key === toKey || !paysHere ? 1 : CENTRE_DETOUR_COST + 1;
      const cost = bestCost + step;
      if (cost < (dist.get(key) ?? Infinity)) {
        dist.set(key, cost);
        cameFrom.set(key, bestKey as string);
        nodeAt.set(key, next);
      }
    }
  }

  const path: TracedHex[] = [];
  let cursor = toKey;
  while (cursor !== fromKey) {
    const node = nodeAt.get(cursor);
    const previous = cameFrom.get(cursor);
    if (!node || previous === undefined) return null;
    path.unshift(node);
    cursor = previous;
    // A corrupt predecessor chain would spin forever; the board is finite
    // and no simple path can exceed it.
    if (path.length > MAX_BRIDGE_HEXES) return null;
  }
  return path;
}

/** No simple path over the authentic board can be longer than the board. */
const MAX_BRIDGE_HEXES = 120;

/** How far the search may wander, and how much work it may do getting there.
 *
 *  A depth cap alone is not enough: a dense late-game board branches, and an
 *  unbounded depth-first search over it is exponential. The expansion budget
 *  makes the worst case a bounded amount of work rather than a frozen tab --
 *  reached, it simply returns the best route found so far, which is a
 *  suggestion that is merely not optimal rather than one that never arrives. */
const MAX_PATH_HEXES = 14;
const MAX_EXPANSIONS = 20_000;

interface SearchResult {
  path: TracedHex[];
  revenue: number;
}

/** Best simple path STARTING at `start`, bounded by `maxCentres` revenue
 *  centres and by the caps above.
 *
 *  Depth-first with an explicit visited set, scored by
 *  `sandboxRouteBreakdown` so the tracer and the readout price a route the
 *  same way. Scoring the whole path rather than accumulating per step costs
 *  a little and buys the deduplication rule for free -- 1830 pays a hex once
 *  however many times a route touches it, and a running total would have to
 *  reimplement that. */
function bestPathFrom(
  mapGrid: MapGridResponse,
  era: TileColorTier,
  start: TracedHex,
  maxCentres: number,
  blocked: ReadonlySet<string>,
): SearchResult {
  let best: SearchResult = { path: [start], revenue: 0 };
  let expansions = 0;

  const visited = new Set<string>(blocked);
  const path: TracedHex[] = [];

  const walk = (at: TracedHex) => {
    if (expansions >= MAX_EXPANSIONS) return;
    expansions += 1;

    const key = `${at.q},${at.r}`;
    visited.add(key);
    path.push(at);

    const breakdown = sandboxRouteBreakdown(
      mapGrid,
      path.map((point) => ({ hex: point.hexLabel })),
      era,
    );
    /* A route needs two paying stops to be a route at all -- 1830's
       two-revenue-centre minimum, which the contract enforces too.

       DESIGN NOTE 3: AND IT HAS TO END SOMEWHERE IT MAY END.

       The tracer scored every prefix of its walk, so the best-paying
       candidate was routinely one that stopped on a town -- a town pays, so
       adding one always raised the total, and the search had no reason not
       to stop there. That is not a legal route: 1830 terminates only at
       cities and red off-board hexes, and towns pay only in passing.

       Adding the check at SUBMIT would have caught it, but that is the wrong
       place for a route the player did not draw. Auto Route would have
       filled the builder with a path and then refused it, and the player has
       no obvious move from there -- they did not choose the last hex, so
       "extend it to a city" is advice about someone else's mistake.

       So the candidate is only recorded when its own last hex is a terminus.
       The walk still passes THROUGH towns freely, and still counts their
       revenue; it just will not stop on one and call that the answer. The
       start needs no check: every start is a token hex, and tokens only sit
       in cities. */
    const endsLegally = isRouteTerminusHex(mapGrid, at.hexLabel);
    if (endsLegally && breakdown.centres >= 2 && breakdown.revenue > best.revenue) {
      best = { path: [...path], revenue: breakdown.revenue };
    }

    // The train is full, or the path is as long as the search will follow.
    // Stopping here is not a claim that the route ends -- only that this
    // tracer will not extend it further.
    if (breakdown.centres < maxCentres && path.length < MAX_PATH_HEXES) {
      for (const next of connectedNeighbours(mapGrid, at.q, at.r)) {
        if (visited.has(`${next.q},${next.r}`)) continue;
        walk(next);
        if (expansions >= MAX_EXPANSIONS) break;
      }
    }

    path.pop();
    visited.delete(key);
  };

  walk(start);
  return best;
}

export interface AutoTraceInput {
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** The corporation's station token hexes. A route must touch one, so these
   *  are the only legal places to start looking. */
  startHexes: ReadonlyArray<readonly [number, number]>;
  /** The train's capacity in REVENUE CENTRES -- design note #156 in
   *  `sandboxSession.ts`. `999` (the Diesel) is treated as uncapped. */
  maxRevenueCentres: number;
  /* ==================================================================
   *  DESIGN NOTE 4: HEXES ANOTHER TRAIN HAS ALREADY TAKEN
   * ==================================================================
   *
   * A corporation runs EVERY train it owns, each on its own route, and two
   * of its trains may not run over the same track. Drafting all of them
   * therefore cannot be N independent calls to this tracer -- run three
   * times from the same tokens with the same board, it returns the same
   * best route three times, and a player pressing Auto-Route on a
   * three-train corporation would get one route drawn on top of itself.
   *
   * So each successive train is told what the earlier ones took.
   *
   * THIS BARS WHOLE HEXES, WHICH IS STRICTER THAN THE RULE. 1830 forbids
   * reusing a track SEGMENT; two trains may legally pass through the same
   * hex, and through the same city, by different rails. Modelling that
   * needs per-segment occupancy and is `pathfinding.rs`'s
   * `trace_best_route_set` -- the exact thing design note #0 says this must
   * never become.
   *
   * Being stricter is the safe direction for a DRAFTING aid: every route it
   * proposes is still one the contract can accept, and the cost is that it
   * sometimes proposes a worse set than a human could find by hand. That is
   * a suggestion being modest, not a suggestion being wrong -- and the
   * manual builder is right there for the player who sees better.
   *
   * The token hex itself is exempt: every route must touch one, so barring
   * it after the first train would leave every later train with no legal
   * start at all. */
  excludeHexes?: ReadonlySet<string>;
}

export interface AutoTraceResult {
  path: TracedHex[];
  revenue: number;
  /** Why nothing was found, when nothing was. Phrased for a player rather
   *  than as an error code -- an Auto Route button that goes quiet is
   *  indistinguishable from one that is still broken. */
  reason: string | null;
}

/* ==================================================================
 *  DESIGN NOTE 2: TWO ARMS, BECAUSE A ROUTE RUNS THROUGH A TOKEN
 * ==================================================================
 *
 * A first cut searched outward from the token and stopped, which only ever
 * produced routes with the token at one END. Real routes run THROUGH a
 * token far more often than they start at one -- the token sits in the
 * corporation's home city, in the middle of its network.
 *
 * So the trace is done twice from the same hex: the best arm in one
 * direction, then the best arm in another with the first arm's hexes barred
 * (a route is a simple path -- it may not revisit a hex). Reversing the
 * second and joining it through the token gives a path with the token in the
 * middle, which is both a legal shape and a materially better-paying one.
 *
 * This is a HEURISTIC, and greedy in the ordinary sense: arm one is chosen
 * without knowing what arm two would have wanted. It can therefore be beaten
 * by hand, which is exactly why the manual builder stays and this fills it in
 * rather than replacing it.
 */
export function autoTraceRoute(input: AutoTraceInput): AutoTraceResult {
  const { mapGrid, era, startHexes, maxRevenueCentres, excludeHexes } = input;
  const cap = maxRevenueCentres >= 999 ? MAX_PATH_HEXES : maxRevenueCentres;

  if (startHexes.length === 0) {
    return {
      path: [],
      revenue: 0,
      reason:
        "This corporation has no station token on the board yet, so there is no city its trains can run from.",
    };
  }

  let best: SearchResult = { path: [], revenue: 0 };

  for (const [q, r] of startHexes) {
    const hexLabel = labelFor(q, r);
    if (hexLabel === null) continue;
    const token: TracedHex = { q, r, hexLabel };

    /* Design note #4: the hexes earlier trains claimed, minus this token --
       which must stay walkable or this train has nowhere to begin. */
    const barred = new Set<string>();
    excludeHexes?.forEach((key) => {
      if (key !== `${q},${r}`) barred.add(key);
    });

    const armA = bestPathFrom(mapGrid, era, token, cap, barred);
    if (armA.revenue > best.revenue) best = armA;

    // Design note #2: the second arm, barred from every hex the first used
    // except the token they share.
    const usedByA = new Set(barred);
    for (const point of armA.path) {
      if (point.q !== q || point.r !== r) usedByA.add(`${point.q},${point.r}`);
    }
    if (usedByA.size === barred.size) continue;
    const armB = bestPathFrom(mapGrid, era, token, cap, usedByA);
    if (armB.path.length < 2) continue;

    // Reverse arm B and join through the shared token, then re-price the
    // whole thing rather than adding the two figures -- the token hex is in
    // both arms and would otherwise be paid for twice.
    const joined = [...armB.path.slice(1).reverse(), ...armA.path];
    const breakdown = sandboxRouteBreakdown(
      mapGrid,
      joined.map((point) => ({ hex: point.hexLabel })),
      era,
    );
    if (breakdown.centres <= cap && breakdown.revenue > best.revenue) {
      best = { path: joined, revenue: breakdown.revenue };
    }
  }

  if (best.path.length < 2) {
    return {
      path: [],
      revenue: 0,
      reason:
        "No route found from this corporation's tokens -- its network does not yet reach two paying stops. Lay more track, then try again.",
    };
  }

  return { path: best.path, revenue: best.revenue, reason: null };
}
