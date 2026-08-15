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
import {
  neighbourAcross,
  segmentsTouchingEdge,
  traversalSegments,
  traversalsFrom,
  type SegmentKey,
} from "./trackSegments";

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

/* `connectedNeighbours` is GONE with design note #9 -- it was this file's
   last hex-as-a-node walker, and `bridgeWaypoints` was its last caller.
   `trackSegments.neighbourAcross` keeps the both-sides rule and
   `traversalsFrom` supplies the half it never had: WHICH rail.

   Deleted rather than left unused. It survived the tracer's conversion
   because nothing pointed at it from there any more, and one function
   still quietly calling it is exactly how tile #56 kept bridging its two
   curves for a whole chunk after the bug was declared fixed. */

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

  /* ==================================================================
   *  DESIGN NOTE 9: THE BRIDGE WALKS RAILS TOO
   * ==================================================================
   *
   * REPORTED: with tile #56 on G7, the router bridges H8 to F6 -- across
   * two curves that do not touch.
   *
   * `trackSegments.ts` design note #0 fixed exactly this class of bug in
   * the network reach and in the auto-tracer, and this function was missed.
   * It kept its own hex-to-hex Dijkstra over `connectedNeighbours` -- "does
   * this hex carry rail toward that one" -- which is the hex-as-a-node
   * model that cannot see a crossover. Tile #56 is two separate curves
   * (0-2 and 1-3), and at the orientation where G7's live edges are
   * [0,1,2,5], entering from H8 at edge 5 can only leave by edge 1. The
   * bridge left by edge 2 and reached F6 over track that is not there.
   *
   * Reproduced on the real board with the reported hexes before the fix,
   * which is also why the earlier audit came back clean: `traversalSegments`
   * refuses that crossing at every orientation, and the AUTO tracer asks
   * it. Only the manual bridge did not, so only manual routing hallucinated
   * -- and the previous report had named the auto-router.
   *
   * The walk is over (HEX, ARRIVAL EDGE) states now, exactly as
   * `candidatePathsFrom` is. One hex may legitimately be visited twice by
   * two different rails, so the visited set is keyed on the state rather
   * than the hex.
   */
  interface BridgeState {
    q: number;
    r: number;
    /** `null` only for the start, which the player is standing on and may
     *  leave by any of its rails. */
    arrivalEdge: number | null;
  }
  const stateKey = (state: BridgeState) =>
    `${state.q},${state.r}:${state.arrivalEdge ?? "start"}`;

  const startState: BridgeState = { q: from.q, r: from.r, arrivalEdge: null };
  const dist = new Map<string, number>([[stateKey(startState), 0]]);
  /* Design note #9: `cameFrom` is the predecessor STATE's key, and `nodeAt`
     turns a key back into a hex. The split is load-bearing -- an earlier
     cut stored each node under its own key and walked the chain back
     through it, which reads a node's predecessor as itself and returned
     `null` for every connected pair on the board. */
  const cameFrom = new Map<string, string>();
  const stateAt = new Map<string, BridgeState>([[stateKey(startState), startState]]);
  const nodeAt = new Map<string, TracedHex>([[stateKey(startState), from]]);
  const settled = new Set<string>();

  let arrivedKey: string | null = null;

  for (;;) {
    let bestKey: string | null = null;
    let bestCost = Infinity;
    dist.forEach((cost, key) => {
      if (!settled.has(key) && cost < bestCost) {
        bestCost = cost;
        bestKey = key;
      }
    });
    if (bestKey === null) break;
    const at = stateAt.get(bestKey as string);
    if (!at) break;
    if (at.q === to.q && at.r === to.r) {
      arrivedKey = bestKey;
      break;
    }
    settled.add(bestKey as string);

    /* From the start hex, every rail on it is available -- the player is
       standing in the city. Having arrived on a rail, only the exits that
       rail actually reaches. */
    const exits =
      at.arrivalEdge === null
        ? liveEdgesForHex(mapGrid, at.q, at.r)
        : traversalsFrom(mapGrid, at.q, at.r, at.arrivalEdge).map((transit) => transit.exitEdge);

    for (const edge of exits) {
      const next = neighbourAcross(mapGrid, at.q, at.r, edge);
      if (!next) continue;
      const hexLabel = labelFor(next.q, next.r);
      if (hexLabel === null) continue;

      const isDestination = next.q === to.q && next.r === to.r;
      // The destination is allowed even if `avoid` lists it -- the caller
      // decides what clicking an existing hex means, and that is the undo
      // rule rather than this function's business.
      if (!isDestination && avoid.has(`${next.q},${next.r}`)) continue;

      const nextState: BridgeState = { q: next.q, r: next.r, arrivalEdge: next.arrivalEdge };
      const key = stateKey(nextState);
      if (settled.has(key)) continue;

      /* The DESTINATION's own value is not charged: the player asked for
         it, so its cost is not a reason to route around it. Only hexes the
         bridge passes THROUGH are weighted.

         `hexRouteValue` is `null` for a hex off the value table and `0` for
         plain track; both mean "pays nothing", and only a positive value is
         a revenue centre worth detouring around. */
      const paysHere = (hexRouteValue(next.q, next.r, mapGrid) ?? 0) > 0;
      const step = isDestination || !paysHere ? 1 : CENTRE_DETOUR_COST + 1;
      const cost = bestCost + step;
      if (cost < (dist.get(key) ?? Infinity)) {
        dist.set(key, cost);
        cameFrom.set(key, bestKey as string);
        stateAt.set(key, nextState);
        nodeAt.set(key, { q: next.q, r: next.r, hexLabel });
      }
    }
  }

  if (arrivedKey === null) return null;

  const path: TracedHex[] = [];
  let cursor: string = arrivedKey;
  const startKey = stateKey(startState);
  while (cursor !== startKey) {
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

/* ==================================================================
 *  DESIGN NOTE 6: THE WALK FOLLOWS RAILS, AND SPENDS THEM
 * ==================================================================
 *
 * Two changes to the search, and they are the same change seen from two
 * sides.
 *
 * IT WALKS (HEX, ARRIVAL EDGE) STATES. The old walk asked
 * `connectedNeighbours` for every hex carrying rail toward a neighbour,
 * which treats a hex as a node where all its rails meet. On #20 (two
 * separate straights), the OO tiles and New York that is false, and the
 * tracer would happily route a train in one straight and out the other.
 * `traversalsFrom` resolves the authored rail instead -- see
 * `trackSegments.ts` design note #0 for the whole argument.
 *
 * IT SPENDS SEGMENTS, NOT HEXES. 1830 forbids two of a corporation's trains
 * from reusing the same TRACK. The previous drafter approximated that by
 * barring whole hexes, documented at the time as deliberately stricter than
 * the rule -- and that approximation forbids the commonest legal shape on a
 * built-up board: two trains crossing one hex on two different curves, or
 * reaching the two separate stations of an OO tile. Occupancy is now keyed
 * on the rail itself.
 *
 * A ROUTE ALSO MAY NOT REUSE ITS OWN TRACK, which falls out of the same
 * set: the walk adds each transit's rails to `used` and refuses any step
 * whose rails are already there. The old `visited` hex set enforced a
 * stronger and slightly wrong version of this -- a route may legally touch
 * a hex twice by different rails, and 1830 pays it once either way, which
 * `sandboxRouteBreakdown` already handles by deduplicating.
 */

/** Every rail a finished route occupies, endpoints included.
 *
 *  Exported because occupancy is a fact about a route that two different
 *  callers need -- the assignment search below, and any caller wanting to
 *  know whether two drafted routes actually conflict. */
export function routeSegments(
  mapGrid: MapGridResponse,
  path: readonly TracedHex[],
): Set<SegmentKey> {
  const used = new Set<SegmentKey>();
  if (path.length < 2) return used;

  const edgeBetween = (from: TracedHex, to: TracedHex): number | null => {
    const found = HEX_NEIGHBOR_OFFSETS.findIndex(
      ([dq, dr]) => from.q + dq === to.q && from.r + dr === to.r,
    );
    return found < 0 ? null : found;
  };

  for (let i = 0; i < path.length; i += 1) {
    const previous = path[i - 1];
    const next = path[i + 1];
    const entry = previous ? edgeBetween(path[i], previous) : null;
    const exit = next ? edgeBetween(path[i], next) : null;

    if (entry !== null && exit !== null) {
      // A transit: the rails joining the two edges.
      for (const key of traversalSegments(mapGrid, path[i].q, path[i].r, entry, exit) ?? []) {
        used.add(key);
      }
      continue;
    }
    // An endpoint: the train runs in and stops, so it holds the entry rail.
    const only = entry ?? exit;
    if (only === null) continue;
    for (const key of segmentsTouchingEdge(mapGrid, path[i].q, path[i].r, only)) used.add(key);
  }
  return used;
}

interface SearchResult {
  path: TracedHex[];
  revenue: number;
  segments: Set<SegmentKey>;
}

/** The K best simple paths starting at `start`, bounded by `maxCentres`
 *  revenue centres and by the caps above.
 *
 *  K RATHER THAN ONE, because the assignment search (design note #7) needs
 *  alternatives to choose between: the single best route for a 5-train may
 *  be the one that strands the 3-train, and there is no way to know that
 *  without a second option on the table.
 *
 *  Scored by `sandboxRouteBreakdown` so the tracer and the readout price a
 *  route the same way, and so 1830's pay-a-hex-once rule comes for free
 *  rather than being reimplemented as a running total. */
function candidatePathsFrom(
  mapGrid: MapGridResponse,
  era: TileColorTier,
  start: TracedHex,
  maxCentres: number,
  occupied: ReadonlySet<SegmentKey>,
  keep: number,
): SearchResult[] {
  const found: SearchResult[] = [];
  let expansions = 0;

  const path: TracedHex[] = [];
  const used = new Set<SegmentKey>();
  /** Hexes on the current path, so it stays a SIMPLE path -- a route may
   *  not visit the same hex twice even by different rails, which is a
   *  stricter rule than segment disjointness and is 1830's. */
  const onPath = new Set<string>();

  const record = (candidate: SearchResult) => {
    // Same hex chain, already seen: keep the better scoring one.
    const signature = candidate.path.map((p) => p.hexLabel).join(">");
    const at = found.findIndex((entry) => entry.path.map((p) => p.hexLabel).join(">") === signature);
    if (at >= 0) {
      if (candidate.revenue > found[at].revenue) found[at] = candidate;
      return;
    }
    found.push(candidate);
    found.sort((a, b) => b.revenue - a.revenue);
    if (found.length > keep) found.length = keep;
  };

  const walk = (at: TracedHex, arrivalEdge: number | null) => {
    if (expansions >= MAX_EXPANSIONS) return;
    expansions += 1;

    path.push(at);
    onPath.add(`${at.q},${at.r}`);

    const breakdown = sandboxRouteBreakdown(
      mapGrid,
      path.map((point) => ({ hex: point.hexLabel })),
      era,
    );

    /* A route needs two paying stops to be a route at all -- 1830's
       two-revenue-centre minimum, which the contract enforces too -- and
       design note #3: it has to END somewhere it may end. Towns pay, so
       without the terminus test the best-paying prefix was routinely one
       that stopped on a town, which is not a legal route. */
    if (
      path.length >= 2 &&
      breakdown.centres >= 2 &&
      breakdown.centres <= maxCentres &&
      isRouteTerminusHex(mapGrid, at.hexLabel)
    ) {
      /* Recomputed rather than copied from `used`: that set holds the
         TRANSITS taken so far, and a route also holds the rails it STARTS
         and STOPS on.

         Those two are why this check is here and not only in the walk. The
         walk prunes each transit against `occupied`, but a terminus is not
         a transit -- it is discovered at the moment the route is recorded.
         Without this, a route could legally end on a rail another train was
         already using, and the assignment search would hand back a set that
         violated the disjointness it exists to enforce. Caught by the sweep
         across 150 board patches, which reported the overlap directly. */
      const segments = routeSegments(mapGrid, path);
      let clashes = false;
      segments.forEach((key) => {
        if (occupied.has(key)) clashes = true;
      });
      if (!clashes) record({ path: [...path], revenue: breakdown.revenue, segments });
    }

    if (breakdown.centres < maxCentres && path.length < MAX_PATH_HEXES) {
      /* Design note #6: from a start, every rail on the hex is available --
         the train begins inside the city. Having arrived on a rail, only
         the exits that rail reaches. */
      const exits =
        arrivalEdge === null
          ? liveEdgesForHex(mapGrid, at.q, at.r).map((exitEdge) => ({
              exitEdge,
              segments: [] as readonly SegmentKey[],
            }))
          : traversalsFrom(mapGrid, at.q, at.r, arrivalEdge);

      for (const transit of exits) {
        const next = neighbourAcross(mapGrid, at.q, at.r, transit.exitEdge);
        if (!next) continue;
        if (onPath.has(`${next.q},${next.r}`)) continue;
        // Occupied by another train, or already used by this route.
        if (transit.segments.some((key) => occupied.has(key) || used.has(key))) continue;

        const hexLabel = labelFor(next.q, next.r);
        if (hexLabel === null) continue;

        for (const key of transit.segments) used.add(key);
        walk({ q: next.q, r: next.r, hexLabel }, next.arrivalEdge);
        for (const key of transit.segments) used.delete(key);

        if (expansions >= MAX_EXPANSIONS) break;
      }
    }

    path.pop();
    onPath.delete(`${at.q},${at.r}`);
  };

  walk(start, null);
  return found;
}

export interface AutoTraceInput {
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** The corporation's station token hexes. A route must touch one, so these
   *  are the only legal places to start looking. */
  startHexes: ReadonlyArray<readonly [number, number]>;
  /** The train's capacity in REVENUE CENTRES -- design note #156 in
   *  `sandboxSession.ts`. `999` (the Diesel) is treated as uncapped.
   *
   *  TOWNS COUNT. `sandboxRouteBreakdown` counts every hex that pays as a
   *  centre, towns included, so `City -> Town -> City` is three stops and a
   *  2-train cannot run it. Verified rather than assumed -- see the
   *  regression tests. */
  maxRevenueCentres: number;
  /* ==================================================================
   *  DESIGN NOTE 4: TRACK ANOTHER TRAIN HAS ALREADY TAKEN
   * ==================================================================
   *
   * A corporation runs EVERY train it owns, each on its own route, and two
   * of its trains may not run over the same track.
   *
   * THIS USED TO BAR WHOLE HEXES, and said so: "stricter than the rule,
   * which is the safe direction for a drafting aid". Safe, and expensive --
   * it forbids the commonest legal shape on a built-up board. Two trains
   * may cross one hex on two different curves (#20's straights), and may
   * reach the two separate stations of an OO tile, and 1830 permits both.
   * On a late-game map the approximation was leaving real revenue unrouted.
   *
   * Occupancy is per RAIL now -- see `trackSegments.ts` design note #3 for
   * what a segment key is and why a hex id could not be one. */
  excludeSegments?: ReadonlySet<SegmentKey>;
}

export interface AutoTraceResult {
  path: TracedHex[];
  revenue: number;
  /** The rails this route occupies, for a caller assembling a set. */
  segments: Set<SegmentKey>;
  /** Why nothing was found, when nothing was. Phrased for a player rather
   *  than as an error code -- an Auto Route button that goes quiet is
   *  indistinguishable from one that is still broken. */
  reason: string | null;
}

/** How many alternatives to keep per starting token. Four trains times a
 *  handful of candidates each is a search space the combination step below
 *  crosses in microseconds; going wider buys worse routes. */
const CANDIDATES_PER_TOKEN = 6;

/** Every route worth considering for one train, best first. */
function candidateRoutes(input: AutoTraceInput): SearchResult[] {
  const { mapGrid, era, startHexes, maxRevenueCentres, excludeSegments } = input;
  const cap = maxRevenueCentres >= 999 ? MAX_PATH_HEXES : maxRevenueCentres;
  const occupied = excludeSegments ?? new Set<SegmentKey>();

  const all: SearchResult[] = [];
  for (const [q, r] of startHexes) {
    const hexLabel = labelFor(q, r);
    if (hexLabel === null) continue;
    const token: TracedHex = { q, r, hexLabel };

    const oneArm = candidatePathsFrom(mapGrid, era, token, cap, occupied, CANDIDATES_PER_TOKEN);
    all.push(...oneArm);

    /* Design note #2: A ROUTE RUNS THROUGH A TOKEN far more often than it
       starts at one, so each arm is paired with a second arm going the
       other way and joined through the shared city.
       The second arm is barred from the FIRST arm's rails, which is what
       keeps the joined path a legal single route rather than one that
       doubles back over itself. */
    for (const armA of oneArm) {
      const barred = new Set<SegmentKey>();
      occupied.forEach((key) => barred.add(key));
      armA.segments.forEach((key) => barred.add(key));
      const armsB = candidatePathsFrom(mapGrid, era, token, cap, barred, 2);
      for (const armB of armsB) {
        if (armB.path.length < 2) continue;
        const joined = [...armB.path.slice(1).reverse(), ...armA.path];
        // A joined path must still be simple.
        const seenHexes = new Set(joined.map((p) => `${p.q},${p.r}`));
        if (seenHexes.size !== joined.length) continue;
        const breakdown = sandboxRouteBreakdown(
          mapGrid,
          joined.map((point) => ({ hex: point.hexLabel })),
          era,
        );
        if (breakdown.centres > cap) continue;
        // Re-priced whole rather than summing the two arms: the token hex
        // is in both and would otherwise be paid for twice.
        const segments = routeSegments(mapGrid, joined);
        // The join itself may cross a rail the other train holds.
        if (Array.from(segments).some((key) => occupied.has(key))) continue;
        all.push({ path: joined, revenue: breakdown.revenue, segments });
      }
    }
  }

  all.sort((a, b) => b.revenue - a.revenue);
  // Distinct hex chains only -- two tokens on one network find the same
  // routes, and duplicates crowd out genuine alternatives.
  const seen = new Set<string>();
  const distinct: SearchResult[] = [];
  for (const candidate of all) {
    const signature = candidate.path.map((p) => p.hexLabel).join(">");
    if (seen.has(signature)) continue;
    seen.add(signature);
    distinct.push(candidate);
    if (distinct.length >= CANDIDATES_PER_TOKEN * 2) break;
  }
  return distinct;
}

const NO_TOKEN_REASON =
  "This corporation has no station token on the board yet, so there is no city its trains can run from.";
const NO_ROUTE_REASON =
  "No route found from this corporation's tokens -- its network does not yet reach two paying stops. Lay more track, then try again.";

export function autoTraceRoute(input: AutoTraceInput): AutoTraceResult {
  if (input.startHexes.length === 0) {
    return { path: [], revenue: 0, segments: new Set(), reason: NO_TOKEN_REASON };
  }
  const best = candidateRoutes(input)[0];
  if (!best || best.path.length < 2) {
    return { path: [], revenue: 0, segments: new Set(), reason: NO_ROUTE_REASON };
  }
  return { path: best.path, revenue: best.revenue, segments: best.segments, reason: null };
}

/* ==================================================================
 *  DESIGN NOTE 7: THE BEST SET, NOT THE BEST ROUTE REPEATED
 * ==================================================================
 *
 * REPORTED: auto-route naively assigns routes to the largest train first,
 * missing optimal multi-train sets.
 *
 * It did, and the note that shipped it admitted as much -- "a greedy
 * approximation of that search, not the search". The greedy order was
 * defensible (a big train picks while the network is untouched) and it is
 * still wrong in a way that is easy to state: the highest-paying route for
 * a 5-train may be the only route a 3-train could have run, and giving it
 * away costs more than it gains. Greedy cannot see that, because it decides
 * the 5-train's route before it has looked at the 3-train at all.
 *
 * So each train now proposes SEVERAL candidate routes and the set is chosen
 * jointly, maximising the combined payout under segment disjointness.
 *
 * IT IS AN EXHAUSTIVE SEARCH OVER A DELIBERATELY SMALL SPACE. A corporation
 * holds at most four trains (1830's own limit), each proposing at most a
 * dozen candidates, and the recursion prunes every branch whose rails
 * already clash. That is thousands of combinations in the worst case --
 * microseconds -- and it is exact over the candidates considered.
 *
 * IT IS STILL NOT `trace_best_route_set`. The candidate list is generated
 * per train by a bounded depth-first search, so a route no train proposed
 * cannot be chosen, and the guarantee is "the best combination of the
 * routes we found" rather than "the best combination that exists". That is
 * the honest claim for a drafting aid, and the contract remains the
 * authority on what any of it is worth. Design note #0's list of things
 * this does not check is unchanged.
 *
 * TRAINS THAT GET NOTHING ARE NOT A FAILURE. A three-train corporation on a
 * network supporting two routes should draft two and leave the third empty,
 * which is what the contract would accept. The search treats "no route" as
 * a zero-revenue option for every train rather than a dead end.
 */
export interface RouteSetTrain {
  /** Caller's own identity for this train -- returned untouched. */
  trainIndex: number;
  /** Capacity in revenue centres; `999` for the Diesel. */
  maxRevenueCentres: number;
}

export interface RouteSetInput {
  mapGrid: MapGridResponse;
  era: TileColorTier;
  startHexes: ReadonlyArray<readonly [number, number]>;
  trains: readonly RouteSetTrain[];
}

export interface RouteSetResult {
  /** One entry per train that got a route. Trains with none are absent. */
  assignments: Array<{ trainIndex: number; path: TracedHex[]; revenue: number }>;
  /** Combined payout of the chosen set. */
  totalRevenue: number;
  /** Set when NOTHING could be drafted for any train. */
  reason: string | null;
}

export function assignRouteSet(input: RouteSetInput): RouteSetResult {
  const { mapGrid, era, startHexes, trains } = input;
  if (startHexes.length === 0) {
    return { assignments: [], totalRevenue: 0, reason: NO_TOKEN_REASON };
  }
  if (trains.length === 0) {
    return { assignments: [], totalRevenue: 0, reason: NO_ROUTE_REASON };
  }

  type Choice = { trainIndex: number; path: TracedHex[]; revenue: number };
  type Plan = { choices: Choice[]; total: number };

  const optionsFor = (train: RouteSetTrain, occupied: ReadonlySet<SegmentKey>) =>
    candidateRoutes({
      mapGrid,
      era,
      startHexes,
      maxRevenueCentres: train.maxRevenueCentres,
      excludeSegments: occupied,
    });

  /* ------------------------------------------------------------------
   * STRATEGY A: sequential, in a given train order.
   *
   * This is the OLD algorithm, kept deliberately -- see design note #8 for
   * why the optimiser needs it rather than merely beating it.
   * ------------------------------------------------------------------ */
  const sequential = (order: readonly RouteSetTrain[]): Plan => {
    const used = new Set<SegmentKey>();
    const choices: Choice[] = [];
    let total = 0;
    for (const train of order) {
      const best = optionsFor(train, used)[0];
      if (!best || best.path.length < 2) continue;
      choices.push({ trainIndex: train.trainIndex, path: best.path, revenue: best.revenue });
      total += best.revenue;
      best.segments.forEach((key) => used.add(key));
    }
    return { choices, total };
  };

  /* ------------------------------------------------------------------
   * STRATEGY B: the joint combination search.
   *
   * Every train proposes against an UNTOUCHED board, and the set is chosen
   * together -- which is the only way to see that the big train's best
   * route is the small train's only route.
   * ------------------------------------------------------------------ */
  const joint = (): Plan => {
    const perTrain = trains
      .map((train) => ({ train, options: optionsFor(train, EMPTY_SEGMENTS) }))
      // Widest capacity first: those lists differ most, so committing them
      // early prunes the deepest.
      .sort((a, b) => b.train.maxRevenueCentres - a.train.maxRevenueCentres);

    let bestTotal = -1;
    let bestChoices: Choice[] = [];
    const chosen: Choice[] = [];
    const used = new Set<SegmentKey>();

    const search = (depth: number, runningTotal: number) => {
      if (depth === perTrain.length) {
        if (runningTotal > bestTotal) {
          bestTotal = runningTotal;
          bestChoices = chosen.map((entry) => ({ ...entry }));
        }
        return;
      }
      // Optimistic bound: if every remaining train took its own best
      // candidate unopposed and that still could not beat the incumbent,
      // stop opening this branch.
      let optimistic = runningTotal;
      for (let i = depth; i < perTrain.length; i += 1) {
        optimistic += perTrain[i].options[0]?.revenue ?? 0;
      }
      if (optimistic <= bestTotal) return;

      const { train, options } = perTrain[depth];
      for (const option of options) {
        if (Array.from(option.segments).some((key) => used.has(key))) continue;
        option.segments.forEach((key) => used.add(key));
        chosen.push({ trainIndex: train.trainIndex, path: option.path, revenue: option.revenue });
        search(depth + 1, runningTotal + option.revenue);
        chosen.pop();
        option.segments.forEach((key) => used.delete(key));
      }
      // This train runs nothing -- always available, so a train with no
      // legal option never blocks the ones that have.
      search(depth + 1, runningTotal);
    };

    search(0, 0);
    return { choices: bestChoices, total: Math.max(0, bestTotal) };
  };

  /* ==================================================================
   *  DESIGN NOTE 8: THE OPTIMISER MUST NOT BE ABLE TO LOSE
   * ==================================================================
   *
   * The joint search alone is WORSE than greedy on a lot of real boards,
   * and the reason is worth recording because it is not obvious and it cost
   * a rewrite to find.
   *
   * Every train's candidate list is generated against an untouched board,
   * so all of them crowd around the same few best rails. Commit the widest
   * train to one of those and the other lists can be entirely conflicted
   * out -- every option they proposed used track that is now taken. The
   * sequential algorithm never had that problem: it REGENERATES after each
   * commitment, so it discovers the second-best corridor that the joint
   * search never put on the table.
   *
   * Measured across 150 board patches: the joint search alone tied on 100
   * and LOST on 50, once by $240 to $80. A smarter optimiser that is
   * sometimes three times worse is not an optimiser.
   *
   * So both run, plus the sequential pass in reverse order (a narrow train
   * choosing first sometimes leaves a better remainder), and the best plan
   * wins. Running the old algorithm as one candidate makes "never worse
   * than what we replaced" true by construction rather than by hope --
   * and the joint search still supplies the wins it was added for.
   *
   * A FILL PASS FINISHES THE JOB. Whichever plan wins, any train left
   * without a route gets one more look at what is left over. That is pure
   * upside: it can only add revenue, and it is what lets the joint search's
   * strength (a better core assignment) combine with the sequential one's
   * (finding routes in the leftovers).
   */
  const widestFirst = [...trains].sort((a, b) => b.maxRevenueCentres - a.maxRevenueCentres);
  const plans: Plan[] = [
    sequential(widestFirst),
    sequential([...widestFirst].reverse()),
    joint(),
  ];

  let plan = plans[0];
  for (const candidate of plans) {
    if (candidate.total > plan.total) plan = candidate;
  }

  // The fill pass.
  const used = new Set<SegmentKey>();
  for (const choice of plan.choices) {
    routeSegments(mapGrid, choice.path).forEach((key) => used.add(key));
  }
  const assigned = new Set(plan.choices.map((choice) => choice.trainIndex));
  let total = plan.total;
  const choices = [...plan.choices];
  for (const train of widestFirst) {
    if (assigned.has(train.trainIndex)) continue;
    const best = optionsFor(train, used)[0];
    if (!best || best.path.length < 2) continue;
    choices.push({ trainIndex: train.trainIndex, path: best.path, revenue: best.revenue });
    total += best.revenue;
    best.segments.forEach((key) => used.add(key));
  }

  if (choices.length === 0) {
    return { assignments: [], totalRevenue: 0, reason: NO_ROUTE_REASON };
  }
  return {
    assignments: choices.sort((a, b) => a.trainIndex - b.trainIndex),
    totalRevenue: total,
    reason: null,
  };
}

const EMPTY_SEGMENTS: ReadonlySet<SegmentKey> = new Set<SegmentKey>();
