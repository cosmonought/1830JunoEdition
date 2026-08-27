// frontend/src/utils/routeAutoTrace.ts
//
// The Auto Route button's tracer -- a client-side SUGGESTION, not an oracle.
//
// Design note #0: a player asking for a route drawn for them is asking the UI to pre-fill the manual builder,
// which needs no chain at all. The result still travels to the contract as the same `RunManualRoute` the
// player could have clicked out by hand, and the contract still validates it.
//
// THE LINE THIS MUST NOT CROSS. `pathfinding.rs` remains the only authority on what a legal route IS, and
// the following are deliberately NOT a to-do list: TOKEN ACCESS (this starts AT a token, which satisfies half
// by construction, and ignores city-slot blocking entirely); CITY SLOTS (a two-city hex is one node here);
// TRAIN COUNT (#7 approximates the allocation problem, it does not solve it); OVERLAP (#4 bars rails, which
// is the rule -- an earlier pass barred whole hexes, which was stricter and therefore safe for a suggestion,
// but was not the rule and must not be mistaken for it).
//
// Design note #1: connectivity is checked from BOTH SIDES. Checking one side only is the classic 18xx map
// bug -- a dead-end stub reads as connected to whatever sits beyond it, and the tracer walks off the rails.
//
// Design notes #2-#9: see `docs/ai_architecture/routing_pathfinding.md`.

import { isUnlimitedReach } from "./trainReach";
import {
  HEX_NEIGHBOR_OFFSETS,
  /* Design note #852: `liveEdgesForHex` is no longer called here, for the reason `trackReach.ts` #686 gives
     for dropping it there: it answers "every rail on this hex", which is the hex-as-a-node model, and the
     start of a route is the last place that model survived. `cityExitEdges` answers the same question for a
     one-city hex and a narrower one for a hex with two. */
  cityExitEdges,
  hexRouteValue,
  /* STILL USED BY `bridgeWaypoints` ALONE, and #852 leaves it there deliberately. The bridge starts at a hex
     the PLAYER CLICKED, not at a token, and a click carries no city -- so scoping it would need waypoints to
     name a city, which is a contract change (`RouteWaypointDto` has no such field) rather than a fix. The gap
     is real and is recorded at that function rather than papered over here: a manual route bridging out of a
     two-city hex can still leave by the wrong arm. */
  liveEdgesForHex,
} from "../components/hexGeometry";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { TileColorTier } from "../components/hexTileCatalog";
import { isRouteTerminusHex, sandboxRouteBreakdown } from "./sandboxSession";
// Design note #730: which city an arrival lands in -- shared with the network walk so both ask one question.
import { cityForArrival, type StationToken } from "./trackReach";
import {
  neighbourAcross,
  segmentsTouchingEdge,
  traversalSegments,
  traversalsFrom,
  type HexTraversal,
  type SegmentKey,
} from "./trackSegments";

/** One traced stop, in the shape `App`'s `RoutePoint` already uses. */
export interface TracedHex {
  q: number;
  r: number;
  hexLabel: string;
  /** Design note #737: which authored way through this hex the route took. `undefined` and `0` both mean the
   *  first, which is every hex on the board except Altoona. Carried so `routeSegments` can name the right
   *  rail -- two trains taking H12's two different tracks hold different keys. */
  variant?: number;
  /** Design note #737: the route crossed this hex WITHOUT reaching its revenue centre.
   *  Set at trace time, where the rail chain is known, and read by `sandboxRouteBreakdown`, where it is not.
   *  A bypassed hex pays nothing AND costs no stop -- the second is what makes the bow worth taking. */
  bypass?: boolean;
}

const LABEL_BY_COORD: ReadonlyMap<string, string> = new Map(
  STATIC_BOARD_HEXES.map((hex) => [`${hex.q},${hex.r}`, hex.label]),
);

function labelFor(q: number, r: number): string | null {
  return LABEL_BY_COORD.get(`${q},${r}`) ?? null;
}

/* `connectedNeighbours` is GONE with design note #9 -- it was this file's last hex-as-a-node walker, and the
   waypoint bridge was its last caller. `trackSegments.neighbourAcross` keeps the both-sides rule and
   `traversalsFrom` supplies the half it never had: WHICH rail.
   Deleted rather than left unused. It survived the tracer's conversion because nothing pointed at it from
   there any more, and one function still quietly calling it is exactly how tile #56 kept bridging its two
   curves for a whole chunk after the bug was declared fixed. */

/* Design note #5: CLICKING TWO CITIES SHOULD NOT MEAN CLICKING NINE HEXES. The builder's only connectivity
   rule was "the next point must be a DIRECT NEIGHBOUR" -- correct about what a route is, wrong about what a
   player is doing when they draw one. Nobody choosing a route is choosing the plain track; they are choosing
   the STOPS. A five-stop route was twenty clicks, nineteen of which had exactly one legal answer.
   IT PREFERS PLAIN TRACK, AND THAT IS THE INTERESTING PART. A bridge that passes through a third city
   silently adds that city's revenue AND spends one of the train's stops, neither of which was asked for -- so
   crossing a revenue centre costs far more than crossing plain track. Where there is no alternative the
   centre IS included, because the train genuinely stops there, and it appears in the stop list with its
   value. What must never happen is a stop appearing in the total that the player cannot see.
   THE MANUAL CLICK STILL WINS: the bridge only fills gaps the player left.
   WHAT THIS IS NOT: token access, city slot capacity, or whether another train has used this track. Same
   list as #0, same owner. */

/** The cost of routing a bridge THROUGH a revenue centre, in units of plain
 *  hexes. Large enough that no realistic detour outweighs it, finite so an
 *  unavoidable centre is still crossed rather than the bridge failing. */
const CENTRE_DETOUR_COST = 1000;

/** The hexes joining `from` to `to` over live track, `to` included and `from` excluded.
 *  `null` when no connected path exists, which the caller reports rather than papering over: two hexes with no
 *  rails between them are not a route, and inventing a straight line across the board is exactly the class of
 *  plausible fiction #216 deleted.
 *  `avoid` is the hexes already on this route. A route is a simple path, so a bridge may not loop back through
 *  one -- without this, clicking a city the route already passed through would produce a chain that visits a
 *  hex twice and prices it once, and the two would disagree. */
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
      DESIGN NOTE 852a: THE BRIDGE STILL LEAVES BY ANY RAIL, AND THAT IS A GAP
     ==================================================================
     #852 scoped the SEARCH's start to the tokened city, because a token knows which city it is in. A BRIDGE
     starts at a hex the player CLICKED, and a click carries no city: `RouteWaypointDto` has a hex and nothing
     else, so there is no city index to scope by and inventing one here would be a guess dressed as a rule.
     THE CONSEQUENCE, NARROWED BY #853. This paragraph originally said a manual route out of a two-city hex
     was accepted and that fixing it needed `RouteWaypointDto` to carry a city -- a contract change. BOTH
     HALVES WERE WRONG, and the correction is kept rather than quietly rewritten:
       WHAT ACCEPTED SUCH A ROUTE was `routeIncludesOwnedToken`, comparing coordinates. #853 makes it ask
       which city the route's own rails belong to, so a run touching New York by the other arm is refused
       whatever drew it.
       NO NEW FIELD WAS NEEDED. The hexes either side of a point determine the edges the route uses at that
       point -- which `hexCanvasPrimitives.ts` #689 has been deriving to DRAW the route all along.
     WHAT SURVIVES HERE is smaller and is about SEARCH rather than legality: this walk may still explore out
     of the wrong arm while looking for a path between two waypoints, so it can propose a bridge the token
     rule will then refuse. A rejected suggestion rather than an illegal route -- worth fixing, not urgent.

     Design note #9: THE BRIDGE WALKS RAILS TOO. Reported: with tile #56 on G7, the router bridges H8 to F6
     across two curves that do not touch. `trackSegments.ts #0` fixed this class of bug in the network reach and
     in the auto-tracer, and this function was missed -- it kept its own hex-to-hex Dijkstra, which is the
     hex-as-a-node model that cannot see a crossover.
     Reproduced on the real board with the reported hexes before the fix, which is also why the earlier audit
     came back clean: the AUTO tracer asks the strict primitive. Only the manual bridge did not, so only manual
     routing hallucinated -- and the previous report had named the auto-router.
     The walk is over (HEX, ARRIVAL EDGE) states now. One hex may legitimately be visited twice by two different
     rails, so the visited set is keyed on the state rather than the hex. */
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
  /* Design note #9: `cameFrom` is the predecessor STATE's key, and `nodeAt` turns a key back into a hex. The
     split is load-bearing -- an earlier cut stored each node under its own key and walked the chain back
     through it, which reads a node's predecessor as itself and returned `null` for every connected pair. */
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

      /* The DESTINATION's own value is not charged: the player asked for it, so its cost is not a reason to route
         around it. Only hexes the bridge passes THROUGH are weighted.
         `hexRouteValue` is `null` off the value table and `0` for plain track -- both mean "pays nothing", and only
         a positive value is a revenue centre worth detouring around. */
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

/** How far the search may wander, and how much work it may do getting there. A depth cap alone is not enough:
 *  a dense late-game board branches, and an unbounded DFS over it is exponential. The expansion budget makes
 *  the worst case a bounded amount of work rather than a frozen tab -- reached, it returns the best route
 *  found so far, which is a suggestion that is merely not optimal rather than one that never arrives. */
const MAX_PATH_HEXES = 14;
const MAX_EXPANSIONS = 20_000;

interface SearchResult {
  path: TracedHex[];
  revenue: number;
}

/* Design note #6: THE WALK FOLLOWS RAILS, AND SPENDS THEM -- two changes that are the same change seen from
   two sides.
   IT WALKS (HEX, ARRIVAL EDGE) STATES. The old walk treated a hex as a node where all its rails meet; on #20
   (two separate straights), the OO tiles and New York that is false, and the tracer would route a train in
   one straight and out the other. `traversalsFrom` resolves the authored rail instead.
   IT SPENDS SEGMENTS, NOT HEXES. Barring whole hexes forbids the commonest legal shape on a built-up board --
   two trains crossing one hex on two different curves, or reaching the two stations of an OO tile -- and on a
   late-game map that approximation was leaving real revenue unrouted.
   A ROUTE ALSO MAY NOT REUSE ITS OWN TRACK, which falls out of the same set. The old `visited` hex set
   enforced a stronger and slightly wrong version: a route may legally touch a hex twice by different rails,
   and 1830 pays it once either way. */

/** Every rail a finished route occupies, endpoints included. Exported because occupancy is a fact about a
 *  route that two callers need -- the assignment search, and any caller wanting to know whether two drafted
 *  routes actually conflict. */
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
      // Design note #737: `variant` picks WHICH way through, so the bow and the through-run hold different keys.
      for (const key of
        traversalSegments(mapGrid, path[i].q, path[i].r, entry, exit, path[i].variant ?? 0) ?? []) {
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

/** The K best simple paths from `start`, bounded by revenue centres and by the caps above.
 *  K RATHER THAN ONE, because the assignment search (#7) needs alternatives: the single best route for a
 *  5-train may be the one that strands the 3-train, and there is no way to know that without a second option.
 *  Scored by `sandboxRouteBreakdown`, so the tracer and the readout price a route the same way and 1830's
 *  pay-a-hex-once rule comes for free rather than being reimplemented as a running total. */
function candidatePathsFrom(
  mapGrid: MapGridResponse,
  era: TileColorTier,
  start: TracedHex,
  /** Design note #852: which city on `start` the token sits in, or `null` for "the whole hex". */
  startCity: number | null,
  maxCentres: number,
  occupied: ReadonlySet<SegmentKey>,
  keep: number,
  blocksThrough?: BlocksThrough,
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
      // Design note #737: the bypass flag travels into the pricing.
      path.map((point) => ({ hex: point.hexLabel, bypass: point.bypass })),
      era,
    );

    /* A route needs two paying stops to be a route at all -- 1830's two-revenue-centre minimum, which the
       contract enforces too -- and design note #3: it has to END somewhere it may end. Towns pay, so without the
       terminus test the best-paying prefix was routinely one that stopped on a town. */
    if (
      path.length >= 2 &&
      breakdown.centres >= 2 &&
      breakdown.centres <= maxCentres &&
      isRouteTerminusHex(mapGrid, at.hexLabel)
    ) {
      /* Recomputed rather than copied from `used`: that set holds the TRANSITS taken so far, and a route also holds
         the rails it STARTS and STOPS on. A terminus is not a transit -- it is discovered at the moment the route
         is recorded -- so without this a route could legally end on a rail another train was already using, and the
         assignment search would hand back a set that violated the disjointness it exists to enforce. Caught by the
         sweep across 150 board patches, which reported the overlap directly. */
      const segments = routeSegments(mapGrid, path);
      let clashes = false;
      segments.forEach((key) => {
        if (occupied.has(key)) clashes = true;
      });
      /* Design note #737: each point COPIED, not the array alone. The walk tags `at` with the variant it is
         about to take and untags it on the way out, so a banked path holding the same object would have its
         hex silently rewritten by a sibling branch. A shallow array copy was enough before there was anything
         mutable on a point. */
      if (!clashes) {
        record({
          path: path.map((point) => ({ ...point })),
          revenue: breakdown.revenue,
          segments,
        });
      }
    }

    /* ==================================================================
     *  DESIGN NOTE 730: A TOKENED-OUT CITY IS A TERMINUS
     * ==================================================================
     *
     * REPORTED: "a corporation's trains are running through tokened out cities when they should be blocked
     * (i.e., the token out city must be treated as a terminus)."
     *
     * THE SAME DEFECT AS #729 AND THE SAME SHAPE OF FIX, in the other tracer. #729 taught the NETWORK walk
     * about tokens; this is the ROUTE search, a separate DFS that also knew only about rails. They had to be
     * fixed together or the board would have promised reach the router then refused -- which is worse than
     * both being wrong, because a player would see a legal-looking hex and a route that would not run to it.
     *
     * "TERMINUS" IS EXACTLY RIGHT and it is why this goes HERE rather than at the top of `walk`. The recording
     * block above has already run, so a path ending in this city is still offered and still priced; what is
     * refused is going any further. Blocking on arrival instead would delete the legal run that stops there.
     *
     * NOT AT A START. `arrivalEdge === null` is the train sitting in its own city, and a corporation is never
     * blocked by the city it holds -- `cityBlocking.ts` rule 2.
     *
     * ==================================================================
     *  DESIGN NOTE 808: A SHUT CITY BARS THE ARMS THAT ENTER IT
     * ==================================================================
     *
     * REPORTED: the auto-router "did not select the highest value route ... it could have run Pittsburgh to
     * Baltimore (bypassing the tokened out Altoona) for $80" and ran a $70 route instead.
     *
     * THE ANSWER WAS RIGHT AND THE QUESTION WAS ASKED TOO EARLY. This is computed on ARRIVAL, which is before
     * the walk has chosen WHICH WAY THROUGH it will take -- and #737's bow is a property of the way through.
     * Used as a gate on the whole expansion loop, it refused every arm because one of them enters the city.
     * MEASURED BEFORE IT WAS CHANGED: with H12's only slot full, the tracer returned `["H14","H12"]` where
     * `["H14","H12","H10"]` over the bow is legal and worth $40. It was not choosing badly on the reported
     * board; it was choosing from a board with a wall across the middle of it.
     *
     * SO THE CITY IS REMEMBERED RATHER THAN ACTED ON, and the refusal moves into the loop below where each
     * arm can answer for itself. `blockedCity` is the city an arrival on this edge lands in when that city is
     * shut, and `null` otherwise -- the two states the loop needs and no more.
     *
     * #730'S TERMINUS RULE IS UNTOUCHED. The recording block above has already run, so a route that ENDS in
     * the shut city is still offered and still priced. What changes is only what may happen after it. */
    const blockedCity =
      arrivalEdge !== null && blocksThrough !== undefined
        ? (() => {
            const city = cityForArrival(mapGrid, at.q, at.r, arrivalEdge);
            return city !== null && blocksThrough(at.q, at.r, city) ? city : null;
          })()
        : null;

    /* ==================================================================
     *  DESIGN NOTE 821: THE STOP BUDGET WAS SPENT BEFORE THE ARM WAS CHOSEN
     * ==================================================================
     *
     * REPORTED, after #808 and #820: "the auto-route feature still stops a route at Altoona instead of
     * bypassing it for a higher value final revenue center."
     *
     * A THIRD GATE WITH THE SECOND ONE'S MISTAKE. #808 moved the BLOCKING test into the loop because the arm
     * decides whether a full city is in the way. This is the CAPACITY test and it has exactly the same shape:
     * `breakdown` prices the path with the current hex counted as a STOP, because at this point in the walk
     * nothing has yet said otherwise -- and a hex crossed on the bow is not a stop at all (#737: "a bypassed
     * hex pays nothing AND costs no stop -- the second is what makes the bow worth taking").
     *
     * SO A TRAIN AT ITS LIMIT STOPPED DEAD AT ALTOONA. Arriving there put it on its last stop; the gate then
     * refused to expand, and the run ended on a $10 city instead of passing it for free and finishing
     * somewhere worth more. Which is the report, in its own words.
     *
     * AND IT WAS NEVER ABOUT BLOCKING, which is why #808 and #820 did not touch it: this happens whether or
     * not the city is shut, so it applies to the PENNSYLVANIA too -- the one corporation for which Altoona is
     * never a wall. The two bugs share a hex and nothing else.
     *
     * THE COUNT IS ADJUSTED RATHER THAN RE-PRICED. `stops` already names the hexes that pay, and the path is
     * simple, so "does this hex pay" is one lookup -- where a second `sandboxRouteBreakdown` per transit
     * would be the same answer at a search's cost. */
    const hexPays = breakdown.stops.some((stop) => stop.hex === at.hexLabel);
    const centresIfBypassed = breakdown.centres - (hexPays ? 1 : 0);

    if (path.length < MAX_PATH_HEXES) {
      /* Design note #6: from a start, every rail on the hex is available --
         the train begins inside the city. Having arrived on a rail, only
         the exits that rail reaches. */
      /* Design note #737: typed as `HexTraversal[]` so the start branch and the transit branch are one shape.
         Left as an inferred literal, the start's `{exitEdge, segments}` widened the union and the variant
         fields became unreachable on both. */
      const exits: HexTraversal[] =
        arrivalEdge === null
          ? /* Design note #852: THE TOKEN'S CITY, NOT THE HEX. `cityExitEdges` returns every live edge when
               `startCity` is `null` -- one city, or a caller that did not say -- so the ordinary board is
               untouched and New York is not. See `AutoTraceInput.startHexes` for the report. */
            cityExitEdges(mapGrid, at.q, at.r, startCity).map((exitEdge) => ({
              exitEdge,
              segments: [] as readonly SegmentKey[],
            }))
          : traversalsFrom(mapGrid, at.q, at.r, arrivalEdge);

      for (const transit of exits) {
        /* Design note #808: THE REFUSAL, PER ARM. A city full of other corporations' tokens says nothing
           about track that goes around it -- the bow does not enter the city, so there is nothing for a full
           city to be full of. Every other arm through this hex reaches the centre and is barred, which is
           #730's rule unchanged; this is the one case where "may I pass" has two different answers on one
           hex, and it exists because 1830 printed it that way. */
        if (blockedCity !== null && transit.bypass !== true) continue;
        /* Design note #821: and the stop budget, per arm. A bypassing transit does not spend this hex, so the
           count it must fit under is the one that excludes it. Every other hex on the board pays the same
           either way and this is `breakdown.centres`, unchanged. */
        if ((transit.bypass === true ? centresIfBypassed : breakdown.centres) >= maxCentres) continue;
        const next = neighbourAcross(mapGrid, at.q, at.r, transit.exitEdge);
        if (!next) continue;
        if (onPath.has(`${next.q},${next.r}`)) continue;
        // Occupied by another train, or already used by this route.
        if (transit.segments.some((key) => occupied.has(key) || used.has(key))) continue;

        const hexLabel = labelFor(next.q, next.r);
        if (hexLabel === null) continue;

        /* Design note #737: the variant belongs to THIS hex -- the one being crossed -- so it is recorded on
           `at` for the duration of the branch and cleared after. `traversalsFrom` yields one entry per way
           through, so two entries with the same `exitEdge` are the two arms of Altoona's fork. */
        const previousVariant = at.variant;
        const previousBypass = at.bypass;
        if (transit.variant !== undefined) at.variant = transit.variant;
        if (transit.bypass !== undefined) at.bypass = transit.bypass;

        for (const key of transit.segments) used.add(key);
        walk({ q: next.q, r: next.r, hexLabel }, next.arrivalEdge);
        for (const key of transit.segments) used.delete(key);

        at.variant = previousVariant;
        at.bypass = previousBypass;

        if (expansions >= MAX_EXPANSIONS) break;
      }
    }

    path.pop();
    onPath.delete(`${at.q},${at.r}`);
  };

  walk(start, null);
  return found;
}

/** Design note #730: whether this corporation may run THROUGH city `cityIndex` on `(q, r)`. The rule is in
 *  `cityBlocking.ts`; this is only its shape, named so the three signatures that take it cannot drift. */
export type BlocksThrough = (q: number, r: number, cityIndex: number) => boolean;

export interface AutoTraceInput {
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** The corporation's station tokens. A route must touch one, so these are the only legal places to start
   *  looking.
   *
   *  ==================================================================
   *   DESIGN NOTE 852: `[q, r]` IS NOT ENOUGH, AND NEW YORK PROVES IT
   *  ==================================================================
   *
   *  REPORTED: "NNH has two 3-trains. In Run Routes, one train runs from its home station (on the upper right
   *  city) to Providence, and the other train is running from the disconnected lower left city. This is
   *  actually two major problems: i) the two cities are not part of NNH's network, and ii) the second train
   *  doesn't run through any NNH station. This had been fixed before and has now returned."
   *
   *  IT WAS FIXED IN THE OTHER TRACER. `trackReach.ts` #686 -- "A TOKEN IS IN A CITY, NOT ON A HEX" -- was
   *  reported on this exact corporation and this exact hex, and it fixed the NETWORK walk. This module is the
   *  ROUTE search, a separate DFS, and it kept the model: from a start it took every live edge on the hex.
   *  New York (G19) is `[{edges:[1]}, {edges:[4]}]`, two cities whose spurs do not touch. NNH's token is in
   *  the top-right city, which owns edge 1. Edge 4 belongs to the other one -- so the search departed from a
   *  city NNH holds nothing in, and every route down that arm satisfies neither half of the rule.
   *
   *  #730 SAW THIS COMING AND SAID SO: "the same defect as #729 and the same shape of fix, in the other
   *  tracer. They had to be fixed together or the board would have promised reach the router then refused."
   *  #686 was the same defect one layer down, and only one tracer was told.
   *
   *  `[q, r]` STILL WORKS and means "the whole hex", which is the right answer for the ~90% of the board with
   *  one city on it and is exactly the pre-#852 behaviour. What must be passed for a two-city hex is
   *  `[q, r, cityIndex]` -- `stationTokensOf` in `trackReach.ts` produces precisely that. */
  startHexes: ReadonlyArray<StationToken>;
  /** The train's capacity in REVENUE CENTRES (`sandboxSession.ts #156`); the Diesel is treated as uncapped.
   *  TOWNS COUNT: every hex that pays is a centre, so `City -> Town -> City` is three stops and a 2-train cannot
   *  run it. Verified rather than assumed -- see the regression tests. */
  maxRevenueCentres: number;
  /* Design note #4: TRACK ANOTHER TRAIN HAS ALREADY TAKEN. A corporation runs every train it owns, each on its
     own route, and two of its trains may not run over the same track.
     THIS USED TO BAR WHOLE HEXES and said so -- "stricter than the rule, which is the safe direction for a
     drafting aid". Safe, and expensive: it forbids two trains crossing one hex on two different curves, and
     reaching the two separate stations of an OO tile, both of which 1830 permits.
     Occupancy is per RAIL now -- `trackSegments.ts #3` for what a segment key is and why a hex id could not be
     one. */
  excludeSegments?: ReadonlySet<SegmentKey>;
  /** Design note #730: cities this corporation may not run THROUGH -- see `cityBlocking.ts` #729. Injected
   *  for the same reason the network walk's copy is: the slot counts and the token owners live in places this
   *  module may not read. Omitted means no blocking, which reproduces every pre-#730 caller. */
  blocksThrough?: BlocksThrough;
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
  /* Design note #881: the sentinel through the one function that owns it. This read `>= 999` while the
     draft flag read `!== 999` -- two spellings of one magic number, which is how a hypothetical 1000-reach
     train would have been unlimited here and over-long there. */
  const cap = isUnlimitedReach(maxRevenueCentres) ? MAX_PATH_HEXES : maxRevenueCentres;
  const occupied = excludeSegments ?? new Set<SegmentKey>();

  const all: SearchResult[] = [];
  for (const entry of startHexes) {
    const [q, r] = entry;
    const hexLabel = labelFor(q, r);
    if (hexLabel === null) continue;
    /* Design note #852: `[q, r, cityIndex]` where the caller knows, `[q, r]` where it does not -- the same
       `StationToken` shape `trackReach.ts` #686 introduced, so the two tracers read one record. `null` means
       "the whole hex", which is right for a one-city hex and is the pre-#852 behaviour everywhere. */
    const startCity = entry.length > 2 ? (entry[2] as number) : null;
    const token: TracedHex = { q, r, hexLabel };

      const oneArm = candidatePathsFrom(
      mapGrid,
      era,
      token,
      startCity,
      cap,
      occupied,
      CANDIDATES_PER_TOKEN,
      // Design note #730: the search may not cross a city this corporation is shut out of.
      input.blocksThrough,
    );
    all.push(...oneArm);

    /* Design note #2: A ROUTE RUNS THROUGH A TOKEN far more often than it starts at one, so each arm is paired
       with a second arm going the other way and joined through the shared city. The second arm is barred from the
       FIRST arm's rails, which is what keeps the joined path a legal single route rather than one that doubles
       back over itself. */
    for (const armA of oneArm) {
      const barred = new Set<SegmentKey>();
      occupied.forEach((key) => barred.add(key));
      armA.segments.forEach((key) => barred.add(key));
      const armsB = candidatePathsFrom(mapGrid, era, token, startCity, cap, barred, 2, input.blocksThrough);
      for (const armB of armsB) {
        if (armB.path.length < 2) continue;
        const joined = [...armB.path.slice(1).reverse(), ...armA.path];
        // A joined path must still be simple.
        const seenHexes = new Set(joined.map((p) => `${p.q},${p.r}`));
        if (seenHexes.size !== joined.length) continue;
        const breakdown = sandboxRouteBreakdown(
          mapGrid,
          joined.map((point) => ({ hex: point.hexLabel, bypass: point.bypass })),
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
  "No route found from this corporation's tokens — its network does not yet reach two paying stops. Lay more track, then try again.";

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

/* Design note #7: THE BEST SET, NOT THE BEST ROUTE REPEATED. The greedy order was defensible and is still
   wrong in a way that is easy to state: the highest-paying route for a 5-train may be the only route a
   3-train could have run, and giving it away costs more than it gains. Greedy cannot see that, because it
   decides the 5-train's route before it has looked at the 3-train at all.
   AN EXHAUSTIVE SEARCH OVER A DELIBERATELY SMALL SPACE: at most four trains, at most a dozen candidates each,
   every clashing branch pruned. Thousands of combinations in the worst case -- microseconds -- and exact over
   the candidates considered.
   IT IS STILL NOT `trace_best_route_set`. Candidates are generated per train by a bounded DFS, so a route no
   train proposed cannot be chosen: the guarantee is "the best combination of the routes we found", which is
   the honest claim for a drafting aid.
   TRAINS THAT GET NOTHING ARE NOT A FAILURE -- a three-train corporation on a network supporting two routes
   should draft two and leave the third empty, which is what the contract would accept. */
export interface RouteSetTrain {
  /** Caller's own identity for this train -- returned untouched. */
  trainIndex: number;
  /** Capacity in revenue centres; `999` for the Diesel. */
  maxRevenueCentres: number;
}

export interface RouteSetInput {
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** Design note #852: tokens, not hexes -- `[q, r]` or `[q, r, cityIndex]`. See `AutoTraceInput`. */
  startHexes: ReadonlyArray<StationToken>;
  trains: readonly RouteSetTrain[];
  /** Design note #730: threaded to every train's search, so a corporation's whole draft respects the walls. */
  blocksThrough?: BlocksThrough;
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
  const { mapGrid, era, startHexes, trains, blocksThrough } = input;
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
      // Design note #730: every train in the set walks the same walls.
      blocksThrough,
    });

  /* STRATEGY A: sequential, in a given train order. This is the OLD algorithm, kept deliberately -- see design
     note #8 for why the optimiser needs it rather than merely beating it. */
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

  /* STRATEGY B: the joint combination search. Every train proposes against an UNTOUCHED board and the set is
     chosen together, which is the only way to see that the big train's best route is the small train's only
     route. */
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

  /* Design note #8: THE OPTIMISER MUST NOT BE ABLE TO LOSE. The joint search alone is WORSE than greedy on a
     lot of real boards, and the reason is not obvious and cost a rewrite to find: every train's candidates are
     generated against an untouched board, so all of them crowd around the same few best rails -- commit the
     widest train to one and the other lists can be entirely conflicted out. The sequential algorithm
     REGENERATES after each commitment, so it discovers the second-best corridor the joint search never put on
     the table.
     Measured across 150 board patches: the joint search alone tied on 100 and LOST on 50, once by $240 to $80.
     A smarter optimiser that is sometimes three times worse is not an optimiser.
     So both run, plus the sequential pass in reverse order (a narrow train choosing first sometimes leaves a
     better remainder), and the best plan wins -- which makes "never worse than what we replaced" true by
     construction rather than by hope.
     A FILL PASS FINISHES THE JOB: any train left without a route gets one more look at what is left over. Pure
     upside, and it is what lets the joint search's strength combine with the sequential one's. */
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
