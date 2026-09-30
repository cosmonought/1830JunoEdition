// frontend/src/gameEngine/routeExactSearch.ts
//
// ==================================================================
//  ROUTE v12 R12-4: THE EXACT MAXIMUM -- EVERY LEGAL ROUTE, THEN THE BEST COMPATIBLE SET
// ==================================================================
//
// R12-2 made the route search SOUND: every route it demonstrated was one the authority accepts. It stayed a bounded
// heuristic (top-N arms joined at a token, a path leash, an expansion budget, three packing strategies and a fill
// pass), so its figure was a LOWER BOUND (S6-3): the independent R12-1 oracle found legal sets it missed ($150 against
// $170, $850 against $990). This module replaces it, on a v12 board, with an EXACT search in two halves.
//
// A. ENUMERATION -- every route the authority's own single-route judge (`walkRoute`) accepts, and nothing else.
//
//    A legal route has at least one STATION POINT: a waypoint the walk's station rule (step 7) counts -- a city
//    holding this corporation's token, or its herald, VISITED, never bypassed. Split the route there and it is two
//    rail walks out of one anchor. So for every anchor hex and every ROLE the anchor can play -- the route's FIRST
//    point (leaving by edge e), its LAST point (entered by e), or an INTERIOR point (entered by e1, left by e2) -- the
//    search grows the halves one hex at a time, and at every hex offers exactly the choices a waypoint can express:
//    END here (a terminus), or CROSS by each way the walk resolves for the waypoint's bypass flag (absent / true).
//    Every point is judged in the FINAL route's orientation (a left half is grown outward but read as the walk will
//    read it: entered by the edge it is grown out of), so each test below is the walk's own test on the walk's own
//    inputs -- the same edges, the same `traversalsFrom` ways, the same flag resolution, the same stop.
//
//    NOTHING IS PRUNED BUT BY THE LAW. A branch is abandoned only where the walk would refuse EVERY route that
//    contains it: a section of track claimed twice (step 2), the same city counted twice (step 6, `routeCityKey`, red
//    areas by area), a red area run through, a full city entered not bypassed (step 3), a barred (unlicensed) hex
//    (step 1), an end that is not a terminus (step 4), or MORE revenue centres than the widest train can count. That
//    last one is exact, not a heuristic: a legal route's centre count is the number of its non-bypass centre points
//    (step 6 makes their pricing keys distinct), the count only grows as points are added, and a route counting more
//    than every train's capacity is a route no train may run (`evaluateRouteSet`'s capacity rule). No path leash, no
//    top-N, no revenue cutoff, no expansion budget that returns early.
//
//    PRICING is incremental and is `sandboxRouteBreakdown`'s own sum: a non-bypass point pays `heraldValueFor ??
//    hexStopValue` the first time its key `hex:stop` appears, and counts as a centre if it is the herald or
//    `isRevenueCentreHex` -- a sum over distinct keys, so the order points join in cannot change it. It is not
//    trusted alone: every route the packing CHOOSES is re-judged by `walkRoute` itself (text, revenue, centres and
//    track must all agree, or `RouteSearchInconsistencyError` is thrown), and the test suite re-judges EVERY
//    enumerated route (`validate: "all"`) on every fixture and dense-corpus board.
//
//    COMPLETENESS. Let R = (p0..pn) be any route the walk accepts, and p_i its FIRST station point (step 7 guarantees
//    one). If i = 0 the START role with e = edge(p0 -> p1) grows exactly R's points; if i = n the END role with
//    e = edge(pn -> p_{n-1}); otherwise the INTERIOR role with e1 = edge(p_i -> p_{i-1}), e2 = edge(p_i -> p_{i+1})
//    (the walk's flag-absent way there visits the station, and a bypassed point is never a station point). At every
//    point the search offers the (way, bypass) the walk resolved for R there -- both flag values are offered -- and
//    every test that could abandon the branch is one the walk applied to R and R passed (the capacity test: R is only
//    worth finding if some train can count it), except one, which R passes because i is its FIRST station point: a
//    LEFT half (the points before the anchor) never holds a station point -- a route that has one earlier is grown
//    from that earlier anchor instead, so every route is generated from exactly one anchor role, once. So R's points
//    are reached and R is emitted as its normalised waypoints. SOUNDNESS: an emitted route passed every one of the
//    walk's tests at every point, so the walk accepts it -- and that is not taken on trust (the witness /
//    validate-all checks above).
//
//    REVERSAL TWINS. Most routes are legal read from either end, with the same track, revenue and centre count. Such
//    a pair is interchangeable in every set (same track, same train fit, same figure), and the reading whose text
//    sorts first also comes first in the tie-break order, so the later reading can never be the one a first maximum
//    uses. It is dropped from the candidates -- only when both readings were enumerated and agree EXACTLY on revenue,
//    centres and track. This halves the packing's lists and changes no answer and no tie.
//
// B. PACKING -- the best set of those routes the fleet can run together: each train one route it can count (or
//    none), no two routes on one section of track (`evaluateRouteSet`'s set rule, on the walk's own segment keys, and
//    none on track the caller says is already `occupied`). Depth-first branch and bound over the trains, widest
//    first:
//      * ADMISSIBLE BOUND: the running total plus, for every remaining train, the revenue of the best list position it
//        could still take -- within a group of identical trains the m-th takes a strictly later position, so it is
//        bounded by the revenue at `floor + m` of its revenue-ordered list. Never below the true best completion, so a
//        pruned branch never held a STRICTLY better set (the incumbent is replaced only on strictly more, so a branch
//        that can at best tie is not needed); and it only falls along a list, so a scan may stop where it fails;
//      * IDENTICAL-TRAIN SYMMETRY: trains of equal capacity have identical route lists, and every assignment to them
//        is a permutation of one whose list positions strictly increase with idle trains last -- the search
//        enumerates only those, and a permutation has the same total and the same routes;
//      * no other pruning, no budget that returns early. (The clash test is word-parallel -- a bitset per section of
//        track over each list's positions -- which is how the scan is fast, not what it may skip.)
//    Two reductions before the tree, both proven: ONE TRAIN needs no tree -- its answer is the first route in the
//    order among those it can run, found in the enumeration pass itself without keeping the others (`bestLegalRoute`);
//    and REVENUE FLOORS -- with B_i train i's best route alone and S their sum, any legal set is worth at least
//    L0 = max B_i, so in every maximum set train i's route earns at least L0 - (S - B_i); a route below the floor of
//    every train that could run it is in no maximum set and is never materialised (the kept routes keep their order,
//    so the first maximum is unchanged; identical trains' floors are 0, so nothing is filtered there).
//    PACKING EXACTNESS: every legal set is (up to identical-train permutation) a leaf of this tree or lies under a
//    node the bound proved cannot beat the incumbent; the incumbent is always a legal set (a route is offered only if
//    it clashes with no section already held; capacity by the per-train lists). So the returned total is the maximum.
//
// DETERMINISM AND THE TIE-BREAK. Routes are ordered by revenue (highest first), then by their normalised waypoint
// text (`H10>H12*>H14`, plain code-unit comparison, ascending); trains by capacity (widest first), then fleet slot.
// The packing explores in that order with "idle" last and replaces its incumbent only at a leaf and only on a
// STRICTLY higher total, so among equal maxima it returns the lexicographically first assignment in that order:
// the widest train's richest route (text order among equals), then the next train's, and so on. Equal inputs, equal
// output, on every platform (no hash-order, no floating point, no clock in any decision).
//
// EXPLICIT CEILINGS, NEVER A FALLBACK. `RouteSearchLimitError` is thrown past `EXACT_SEARCH_MAX_*` (hex arrivals,
// legal routes, packing nodes, and the packing's route examinations -- so the guard bounds the work between nodes too)
// -- far above anything a recorded position has needed (the R12-4 report measures the corpus worst case). A search that
// meets one fails loudly; it never answers with a smaller figure.
//
// ONLY ON A v12 BOARD. `assignRouteSet` / `autoTraceRoute` ask this where the board in effect plays the v12 route
// rules; an unpinned legacy board keeps the heuristic it was played with, so a stored log replays unchanged.
//
// INDEPENDENCE. This is production code: it imports nothing from `routeOracle/**` (a source guard pins that).

import type { MapGridResponse } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import { liveEdgesForHex } from "../components/hexGeometry";
import { boardMemo, heraldAt, routeRulesV12InEffect } from "../components/hexBoardData";
import { heraldValueFor, hexStopValue, isRevenueCentreHex, isRouteTerminusHex } from "./sandboxSession";
import { routeCityKey, walkRoute, type ProposedWaypoint, type RouteWalkContext } from "./routeWalk";
import { cityForArrival, stopForArrival, type StationToken } from "./trackReach";
import { isUnlimitedReach } from "./trainReach";
import { isOffboardTerminal, neighbourAcross, segmentsTouchingEdge, traversalsFrom, type HexTraversal, type SegmentKey } from "./trackSegments";

/** One traced stop -- `routeAutoTrace.TracedHex`'s shape (declared here to keep this module free of that one). */
export interface ExactTracedHex {
  q: number;
  r: number;
  hexLabel: string;
  variant?: number;
  bypass?: boolean;
}

/** One legal route, as the search priced it (and, for a chosen one, as the walk re-judged it). Its waypoints, traced
 *  path and track are materialised on first read: tens of thousands of candidates are enumerated, and the packing
 *  reads the track of only those it examines. */
export class ExactRoute {
  private waypointsMemo?: ProposedWaypoint[];
  private pathMemo?: ExactTracedHex[];
  private segmentIdsMemo?: number[];
  constructor(
    /** The waypoint text: `H10>H12*>H14` (`*` = bypass). The route's identity and its tie-break key. */
    readonly key: string,
    readonly revenue: number,
    readonly centres: number,
    private readonly steps: readonly Step[],
  ) {}
  /** The normalised waypoints, exactly as a `RunMultipleRoutes` route carries them. */
  get waypoints(): ProposedWaypoint[] {
    if (!this.waypointsMemo) this.waypointsMemo = this.steps.map((pt) => (pt.bypass ? { hex: pt.label, bypass: true } : { hex: pt.label }));
    return this.waypointsMemo;
  }
  /** The same route as traced hexes (with the authored variant of each crossing). */
  get path(): ExactTracedHex[] {
    if (!this.pathMemo) {
      this.pathMemo = this.steps.map((pt) => {
        const traced: ExactTracedHex = { q: pt.q, r: pt.r, hexLabel: pt.label };
        if (pt.variant !== undefined) traced.variant = pt.variant;
        if (pt.bypass) traced.bypass = true;
        return traced;
      });
    }
    return this.pathMemo;
  }
  /** Its sections of track, as ids into the enumeration's `segmentKeys`. */
  get segmentIds(): readonly number[] {
    if (!this.segmentIdsMemo) {
      const ids: number[] = [];
      for (const pt of this.steps) for (const id of pt.segs) ids.push(id);
      this.segmentIdsMemo = ids;
    }
    return this.segmentIdsMemo;
  }
}

export interface ExactSearchStats {
  anchors: number;
  /** Hex arrivals the enumeration made. */
  expansions: number;
  /** Distinct legal routes enumerated (within the fleet's capacity), both readings of a reversible route counted. */
  legalRoutes: number;
  /** Of which below every train's revenue floor (`exactRouteSet`): provably in no maximum set, never materialised. */
  belowFloor: number;
  /** Of which later reversal twins, dropped as exactly interchangeable; the packing chooses from the rest. */
  reversedTwins: number;
  /** Routes re-judged by `walkRoute` (the chosen witnesses; every route under `validate: "all"`). */
  walkValidated: number;
  /** Nodes of the packing search. */
  packingStates: number;
  /** Routes the packing examined (a node's list scan, clashing routes included). */
  packingWork: number;
  enumerateMs: number;
  packMs: number;
}

/** A route search too large for its explicit ceiling. Raised, never swallowed: the search never answers with less than
 *  the maximum it was asked for. */
export class RouteSearchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteSearchLimitError";
    Object.setPrototypeOf(this, RouteSearchLimitError.prototype);
  }
}

/** The search and the authority's walk disagree about a route -- a defect, never a figure to use. */
export class RouteSearchInconsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteSearchInconsistencyError";
    Object.setPrototypeOf(this, RouteSearchInconsistencyError.prototype);
  }
}

/** Explicit ceilings (see `RouteSearchLimitError`). The measured corpus worst case is two orders of magnitude below. */
export const EXACT_SEARCH_MAX_EXPANSIONS = 10_000_000;
export const EXACT_SEARCH_MAX_ROUTES = 1_000_000;
export const EXACT_SEARCH_MAX_PACKING_STATES = 20_000_000;
/** Route examinations inside the packing (the work between its nodes: a clashing route is examined and skipped). */
export const EXACT_SEARCH_MAX_PACKING_WORK = 100_000_000;

export interface ExactEnumerationInput {
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** The corporation's station roots (`stationTokensOf`: tokens, and its herald). */
  tokens: ReadonlyArray<StationToken>;
  companyId: number | undefined;
  blocksThrough: (q: number, r: number, cityIndex: number) => boolean;
  barredHexes?: ReadonlySet<string>;
  /** The most revenue centres any train that will choose from these routes can count (`Infinity`: a Diesel). */
  maxCentres: number;
  /** `"all"`: re-judge EVERY enumerated route with `walkRoute` (tests); default: only the packed witnesses. */
  validate?: "witness" | "all";
  /** Lower ceilings than the `EXACT_SEARCH_MAX_*` defaults -- for the tests that prove a ceiling FAILS rather than
   *  answers. No production caller passes it. */
  limits?: Partial<ExactSearchLimits>;
}

export interface ExactSearchLimits {
  expansions: number;
  routes: number;
  packingStates: number;
  packingWork: number;
}

const limitsOf = (limits: Partial<ExactSearchLimits> | undefined): ExactSearchLimits => ({
  expansions: Math.min(limits?.expansions ?? EXACT_SEARCH_MAX_EXPANSIONS, EXACT_SEARCH_MAX_EXPANSIONS),
  routes: Math.min(limits?.routes ?? EXACT_SEARCH_MAX_ROUTES, EXACT_SEARCH_MAX_ROUTES),
  packingStates: Math.min(limits?.packingStates ?? EXACT_SEARCH_MAX_PACKING_STATES, EXACT_SEARCH_MAX_PACKING_STATES),
  packingWork: Math.min(limits?.packingWork ?? EXACT_SEARCH_MAX_PACKING_WORK, EXACT_SEARCH_MAX_PACKING_WORK),
});

export interface ExactEnumeration {
  /** The candidates, in the tie-break order: every legal route but a later reversal twin. */
  routes: ExactRoute[];
  /** Segment id -> the walk's segment key. */
  segmentKeys: readonly SegmentKey[];
  stats: ExactSearchStats;
}

const labelByCoord = boardMemo(
  (board): ReadonlyMap<string, string> => new Map(board.hexes.map((hex) => [`${hex.q},${hex.r}`, hex.label])),
);

const now = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

/** One point of a route under construction, in the FINAL route's orientation, with everything the walk's tests and
 *  the pricing need precomputed and interned. */
interface Step {
  q: number;
  r: number;
  label: string;
  bypass: boolean;
  variant?: number;
  /** Track this point claims (interned; distinct within the step). */
  segs: readonly number[];
  /** The walk's step-6 city key (interned), or -1 where the point is no counted centre. */
  walkKey: number;
  /** The pricing's `hex:stop` key (interned), or -1 for a bypass (which pays and counts nothing). */
  priceKey: number;
  priceValue: number;
  priceCentre: boolean;
  /** The walk's station rule (step 7) holds here: this corporation's first root on the hex, visited in its stop. */
  station: boolean;
}

/** Called once for every legal route (normalised points, the pricing's revenue and centre count). `points` may be a
 *  live buffer: a sink that keeps it copies it. */
type RouteSink = (points: readonly Step[], revenue: number, centres: number) => void;

/** THE ENUMERATION (header, A): hands every legal route counting at most `maxCentres` revenue centres, and using none
 *  of the `occupied` track, to `sink` -- each exactly once (its first station point's role generates it). */
function traverseLegalRoutes(
  input: ExactEnumerationInput & { occupied?: ReadonlySet<SegmentKey> },
  sink: RouteSink,
): { segmentKeys: SegmentKey[]; anchors: number; expansions: number; generated: number } {
  // The v12 law only: its city keys (`routeCityKey`) and station rule are v12's. The pre-v12 board keeps its heuristic.
  if (!routeRulesV12InEffect()) throw new Error("routeExactSearch: asked on a board that does not play the v12 route rules.");
  const { mapGrid, era, tokens, companyId, blocksThrough, barredHexes } = input;
  const maxCentres = input.maxCentres;
  const limits = limitsOf(input.limits);

  /* ---- interning ---- */
  const segIdOf = new Map<SegmentKey, number>();
  const segmentKeys: SegmentKey[] = [];
  const segId = (key: SegmentKey) => {
    let id = segIdOf.get(key);
    if (id === undefined) {
      id = segmentKeys.length;
      segIdOf.set(key, id);
      segmentKeys.push(key);
    }
    return id;
  };
  const keyIdOf = new Map<string, number>();
  const keyId = (key: string) => {
    let id = keyIdOf.get(key);
    if (id === undefined) keyIdOf.set(key, (id = keyIdOf.size));
    return id;
  };

  /* ---- the board as a node table (per call: pure functions of board, grid, company, licence) ---- */
  const labels = labelByCoord();
  interface HexNode {
    q: number;
    r: number;
    label: string | undefined;
    barred: boolean;
    offboard: boolean;
    live: readonly number[];
    /** Neighbour node across each edge (-1: no joined rail; -2: not yet asked). */
    nb: number[];
    end: Array<Step | null | undefined>;
    cross: Array<readonly Step[] | undefined>;
  }
  const nodeIndex = new Map<string, number>();
  const nodes: HexNode[] = [];
  const nodeAt = (q: number, r: number): number => {
    const key = `${q},${r}`;
    let index = nodeIndex.get(key);
    if (index === undefined) {
      index = nodes.length;
      nodeIndex.set(key, index);
      nodes.push({
        q,
        r,
        label: labels.get(key),
        barred: barredHexes !== undefined && barredHexes.has(key),
        offboard: isOffboardTerminal(q, r),
        live: liveEdgesForHex(mapGrid, q, r),
        nb: [-2, -2, -2, -2, -2, -2],
        end: new Array(6),
        cross: new Array(36),
      });
    }
    return index;
  };
  /** `neighbourAcross`: the hex across `edge` when both carry rail to it (entered there by the opposite edge). */
  const neighbourOf = (n: number, edge: number): number => {
    const node = nodes[n];
    let v = node.nb[edge];
    if (v === -2) {
      const across = neighbourAcross(mapGrid, node.q, node.r, edge);
      v = across ? nodeAt(across.q, across.r) : -1;
      node.nb[edge] = v;
    }
    return v;
  };
  const terminusCache = new Map<string, boolean>();
  const terminus = (label: string) => {
    let value = terminusCache.get(label);
    if (value === undefined) terminusCache.set(label, (value = isRouteTerminusHex(mapGrid, label, companyId)));
    return value;
  };
  const heraldOwner = (label: string) => companyId !== undefined && heraldAt(label)?.companyId === companyId;

  /** The walk's station rule (step 7) at one visited point: the FIRST root on the hex, as the walk reads it. */
  const holdsStation = (q: number, r: number, stop: number | null) => {
    const match = tokens.find(([tq, tr]) => tq === q && tr === r);
    if (!match) return false;
    if (match.length < 3) return true;
    return stop === null || stop === match[2];
  };

  /** A point's interned step, or `null` if its own track repeats a section (then no route can contain it). */
  const makeStep = (q: number, r: number, label: string, bypass: boolean, variant: number | undefined, segments: readonly SegmentKey[], stop: number | null): Step | null => {
    const segs: number[] = [];
    for (const key of segments) {
      const id = segId(key);
      if (segs.includes(id)) return null;
      segs.push(id);
    }
    const counted = !bypass && isRevenueCentreHex(mapGrid, label, companyId);
    const herald = heraldValueFor(label, companyId);
    const step: Step = {
      q,
      r,
      label,
      bypass,
      segs,
      walkKey: counted ? keyId(`walk|${routeCityKey(label, stop)}`) : -1,
      priceKey: bypass ? -1 : keyId(`price|${label}:${stop ?? 0}`),
      priceValue: bypass ? 0 : herald ?? hexStopValue(mapGrid, label, era),
      priceCentre: !bypass && (herald !== null || isRevenueCentreHex(mapGrid, label)),
      station: !bypass && holdsStation(q, r, stop),
    };
    if (variant !== undefined) step.variant = variant;
    return step;
  };

  /** The route's end at a node, holding only the rail on `edge` (the walk's endpoint branch: a terminus). */
  const endStep = (n: number, edge: number): Step | null => {
    const node = nodes[n];
    let step = node.end[edge];
    if (step === undefined) {
      const { q, r, label } = node;
      step = label !== undefined && terminus(label) && node.live.includes(edge) ? makeStep(q, r, label, false, undefined, segmentsTouchingEdge(mapGrid, q, r, edge), stopForArrival(mapGrid, q, r, edge)) : null;
      node.end[edge] = step;
    }
    return step;
  };

  /** Every way the walk can resolve a waypoint crossing (q, r) entered by `entry` and left by `exit` (step 2's flag
   *  resolution, both flag values), minus a visit of a city full of others (step 3). The flag-absent resolution is
   *  first. A red area is never crossed. */
  const crossSteps = (n: number, entry: number, exit: number): readonly Step[] => {
    const node = nodes[n];
    let steps = node.cross[entry * 6 + exit];
    if (steps !== undefined) return steps;
    const { q, r } = node;
    const label = node.label!;
    const out: Step[] = [];
    if (!node.offboard) {
      const ways = traversalsFrom(mapGrid, q, r, entry).filter((way) => way.exitEdge === exit);
      if (ways.length > 0) {
        const resolved: Array<{ way: HexTraversal; bypass: boolean }> = [];
        // Flag absent: the way that visits the centre, else (normalised) the first way, as a bypass.
        const visiting = ways.find((way) => way.bypass !== true);
        resolved.push(visiting ? { way: visiting, bypass: false } : { way: ways[0], bypass: true });
        // Flag true: the way round the centre, else -- for the herald's owner -- the ordinary way, uncounted.
        let round = ways.find((way) => way.bypass === true);
        if (!round && heraldOwner(label)) round = ways.find((way) => way.bypass !== true) ?? ways[0];
        if (round && !(resolved[0].way === round && resolved[0].bypass)) resolved.push({ way: round, bypass: true });
        let shut: boolean | undefined;
        for (const { way, bypass } of resolved) {
          if (!bypass) {
            if (shut === undefined) {
              const city = cityForArrival(mapGrid, q, r, entry);
              shut = city === null ? blocksThrough(q, r, 0) : blocksThrough(q, r, city);
            }
            if (shut) continue;
          }
          const step = makeStep(q, r, label, bypass, way.variant, way.segments, bypass ? null : stopForArrival(mapGrid, q, r, entry));
          if (step) out.push(step);
        }
      }
    }
    node.cross[entry * 6 + exit] = steps = out;
    return steps;
  };

  /* ---- the route under construction ---- */
  let segUsed = new Uint8Array(1024);
  let walkUsed = new Uint8Array(256);
  let priceCount = new Int32Array(256);
  let revenue = 0;
  let centres = 0;
  let expansions = 0;
  const ensure = () => {
    if (segmentKeys.length > segUsed.length) {
      const grown = new Uint8Array(segmentKeys.length * 2);
      grown.set(segUsed);
      segUsed = grown;
    }
    if (keyIdOf.size > walkUsed.length) {
      const w = new Uint8Array(keyIdOf.size * 2);
      w.set(walkUsed);
      walkUsed = w;
      const p = new Int32Array(keyIdOf.size * 2);
      p.set(priceCount);
      priceCount = p;
    }
  };

  /** Adds a point if the walk could still accept a route containing it (track, city twice, capacity). */
  const apply = (step: Step): boolean => {
    ensure();
    const segs = step.segs;
    for (let i = 0; i < segs.length; i += 1) if (segUsed[segs[i]] !== 0) return false;
    if (step.walkKey >= 0 && walkUsed[step.walkKey] !== 0) return false;
    const firstPrice = step.priceKey >= 0 && priceCount[step.priceKey] === 0;
    const addsCentre = firstPrice && step.priceCentre;
    if (addsCentre && centres + 1 > maxCentres) return false;
    for (let i = 0; i < segs.length; i += 1) segUsed[segs[i]] = 1;
    if (step.walkKey >= 0) walkUsed[step.walkKey] = 1;
    if (step.priceKey >= 0) {
      priceCount[step.priceKey] += 1;
      if (firstPrice) {
        revenue += step.priceValue;
        if (addsCentre) centres += 1;
      }
    }
    return true;
  };
  const unapply = (step: Step) => {
    const segs = step.segs;
    for (let i = 0; i < segs.length; i += 1) segUsed[segs[i]] = 0;
    if (step.walkKey >= 0) walkUsed[step.walkKey] = 0;
    if (step.priceKey >= 0) {
      priceCount[step.priceKey] -= 1;
      if (priceCount[step.priceKey] === 0) {
        revenue -= step.priceValue;
        if (step.priceCentre) centres -= 1;
      }
    }
  };

  /* ---- track already held elsewhere: claimed before the walk starts, so no route can use it ---- */
  if (input.occupied && input.occupied.size > 0) {
    input.occupied.forEach((key) => segId(key));
    ensure();
    input.occupied.forEach((key) => {
      segUsed[segId(key)] = 1;
    });
  }

  /* ---- emission ---- */
  let generated = 0;
  const emit = (points: readonly Step[]) => {
    if (centres < 2) return; // the pricing's "at least two cities"
    generated += 1;
    if (generated > limits.routes) {
      throw new RouteSearchLimitError(`The exact route search passed ${limits.routes} legal routes.`);
    }
    sink(points, revenue, centres);
  };

  const right: Step[] = [];
  const left: Step[] = [];

  /** Grows one half out of node `from` across `growthExit`. `dir` says how the final route reads it: 0 (right) in
   *  growth order, 1 (left) reversed -- so a left point is ENTERED by the edge it is grown out of. */
  const grow = (dir: 0 | 1, from: number, growthExit: number, onEnd: () => void): void => {
    expansions += 1;
    if (expansions > limits.expansions) {
      throw new RouteSearchLimitError(`The exact route search passed ${limits.expansions} hex arrivals.`);
    }
    const n = neighbourOf(from, growthExit);
    if (n < 0) return;
    const node = nodes[n];
    if (node.label === undefined || node.barred) return;
    const half = dir === 0 ? right : left;
    const a = (growthExit + 3) % 6; // `neighbourAcross`'s arrival edge

    // END here: the run stops inside this hex and holds only the rail it came in on.
    const end = endStep(n, a);
    if (end && !(dir === 1 && end.station) && apply(end)) {
      half.push(end);
      onEnd();
      half.pop();
      unapply(end);
    }

    // CROSS this hex, leaving by every other live edge (never a red area).
    if (node.offboard) return;
    for (const b of node.live) {
      if (b === a) continue;
      const steps = dir === 0 ? crossSteps(n, a, b) : crossSteps(n, b, a);
      for (const step of steps) {
        if (dir === 1 && step.station) continue; // an earlier station point: that anchor's role finds this route
        if (!apply(step)) continue;
        half.push(step);
        grow(dir, n, b, onEnd);
        half.pop();
        unapply(step);
      }
    }
  };

  const anchorHexes: Array<{ q: number; r: number; label: string }> = [];
  for (const [q, r] of tokens) {
    if (anchorHexes.some((hex) => hex.q === q && hex.r === r)) continue;
    const label = labels.get(`${q},${r}`);
    if (label !== undefined) anchorHexes.push({ q, r, label });
  }

  const emitRight = () => emit(right);
  const emitLeft = () => {
    const points: Step[] = [];
    for (let i = left.length - 1; i >= 0; i -= 1) points.push(left[i]);
    emit(points);
  };
  const emitBoth = () => {
    const points: Step[] = [];
    for (let i = left.length - 1; i >= 0; i -= 1) points.push(left[i]);
    for (const pt of right) points.push(pt);
    emit(points);
  };

  for (const anchor of anchorHexes) {
    const { q, r } = anchor;
    const n = nodeAt(q, r);
    if (nodes[n].barred) continue;
    const edges = nodes[n].live;

    // START and END: the anchor is an end of the route, holding the rail it leaves (enters) by.
    for (const edge of edges) {
      if (neighbourOf(n, edge) < 0) continue;
      const step = endStep(n, edge);
      if (!step || !step.station) continue;
      if (!apply(step)) continue;
      right.push(step);
      grow(0, n, edge, emitRight);
      right.pop();
      left.push(step);
      grow(1, n, edge, emitLeft);
      left.pop();
      unapply(step);
    }

    // INTERIOR: entered by e1, left by e2, visiting the station (the walk's flag-absent way, not a bypass).
    for (const e1 of edges) {
      if (neighbourOf(n, e1) < 0) continue;
      for (const e2 of edges) {
        if (e2 === e1 || neighbourOf(n, e2) < 0) continue;
        const step = crossSteps(n, e1, e2)[0];
        if (!step || !step.station) continue; // (a bypass is never a station point)
        if (!apply(step)) continue;
        right.push(step);
        grow(0, n, e2, () => grow(1, n, e1, emitBoth));
        right.pop();
        unapply(step);
      }
    }
  }

  return { segmentKeys, anchors: anchorHexes.length, expansions, generated };
}

/** The waypoint text of a point list: `H10>H12*>H14`. */
const keyOf = (points: readonly Step[]): string => {
  let key = "";
  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i];
    key += i === 0 ? pt.label : `>${pt.label}`;
    if (pt.bypass) key += "*";
  }
  return key;
};

/** EVERY LEGAL ROUTE this corporation can run counting at most `maxCentres` revenue centres, in the tie-break order,
 *  less the later reading of each exact reversal twin (header, A). */
export function enumerateLegalRoutes(
  input: ExactEnumerationInput & {
    occupied?: ReadonlySet<SegmentKey>;
    /** A PROVEN filter (`exactRouteSet`'s revenue floors): routes it rejects are counted, never materialised. */
    keep?: (revenue: number, centres: number) => boolean;
  },
): ExactEnumeration {
  const started = now();
  const byKey = new Map<string, ExactRoute>();
  let belowFloor = 0;
  const keep = input.keep;
  const walked = traverseLegalRoutes(input, (points, revenue, centres) => {
    if (keep !== undefined && !keep(revenue, centres)) {
      belowFloor += 1;
      return;
    }
    const key = keyOf(points);
    // Each route is generated once; the map is a guard, not a filter (a duplicate would be a generator defect).
    if (byKey.has(key)) throw new RouteSearchInconsistencyError(`The exact route search generated ${key} twice.`);
    byKey.set(key, new ExactRoute(key, revenue, centres, points.slice()));
  });
  const { segmentKeys } = walked;
  const routes = Array.from(byKey.values());
  // The tie-break order: revenue (highest first), then the waypoint text (code-unit order).
  routes.sort((x, y) => y.revenue - x.revenue || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

  const stats: ExactSearchStats = {
    anchors: walked.anchors,
    expansions: walked.expansions,
    legalRoutes: routes.length + belowFloor,
    belowFloor,
    reversedTwins: 0,
    walkValidated: 0,
    packingStates: 0,
    packingWork: 0,
    enumerateMs: 0,
    packMs: 0,
  };
  if (input.validate === "all") {
    const ctx = walkContextOf(input);
    for (const route of routes) verifyAgainstWalk(ctx, route, segmentKeys);
    stats.walkValidated = routes.length;
  }

  /* REVERSAL TWINS (a sound reduction, see the header). A route read from its other end is usually legal too, with the
     same track, revenue and centre count; the two are interchangeable in every set, and the one whose text sorts first
     also comes first in the tie-break order. The later twin is dropped -- only when it is EXACTLY interchangeable
     (both enumerated, equal revenue, equal centres, the same sections of track). */
  // A route never claims a section twice, so equal lengths and containment are set equality.
  const stamp = new Int32Array(Math.max(1, segmentKeys.length));
  let generation = 0;
  const sameTrack = (x: ExactRoute, y: ExactRoute) => {
    const a = x.segmentIds;
    const b = y.segmentIds;
    if (a.length !== b.length) return false;
    generation += 1;
    for (let i = 0; i < a.length; i += 1) stamp[a[i]] = generation;
    for (let i = 0; i < b.length; i += 1) if (stamp[b[i]] !== generation) return false;
    return true;
  };
  const candidates: ExactRoute[] = [];
  for (const route of routes) {
    const reverseKey = route.key.split(">").reverse().join(">");
    if (reverseKey < route.key) {
      const twin = byKey.get(reverseKey);
      if (twin && twin.revenue === route.revenue && twin.centres === route.centres && sameTrack(twin, route)) {
        stats.reversedTwins += 1;
        continue;
      }
    }
    candidates.push(route);
  }
  stats.enumerateMs = Math.round(now() - started);
  return { routes: candidates, segmentKeys, stats };
}

/** ONE TRAIN: the first route in the tie-break order among those it can run -- the most revenue, then the least
 *  waypoint text -- found in the same single pass over every legal route, WITHOUT keeping the others. Exactly what the
 *  packing answers for a one-train fleet (its list's first position), at a fraction of the memory: a route only
 *  becomes an object when it is at least as rich as the best so far. */
export function bestLegalRoute(input: ExactEnumerationInput & { occupied?: ReadonlySet<SegmentKey> }): { route: ExactRoute | null; segmentKeys: readonly SegmentKey[]; stats: ExactSearchStats } {
  const started = now();
  let best: ExactRoute | null = null;
  const walked = traverseLegalRoutes(input, (points, revenue, centres) => {
    if (best !== null && revenue < best.revenue) return;
    const key = keyOf(points);
    if (best !== null && revenue === best.revenue && !(key < best.key)) return;
    best = new ExactRoute(key, revenue, centres, points.slice());
  });
  const stats: ExactSearchStats = {
    anchors: walked.anchors,
    expansions: walked.expansions,
    legalRoutes: walked.generated,
    belowFloor: 0,
    reversedTwins: 0,
    walkValidated: 0,
    packingStates: 0,
    packingWork: 0,
    enumerateMs: Math.round(now() - started),
    packMs: 0,
  };
  return { route: best, segmentKeys: walked.segmentKeys, stats };
}

const walkContextOf = (input: Omit<ExactEnumerationInput, "maxCentres">): RouteWalkContext => ({
  mapGrid: input.mapGrid,
  era: input.era,
  companyId: input.companyId,
  tokens: input.tokens,
  blocksThrough: input.blocksThrough,
  barredHexes: input.barredHexes,
});

/** Re-judges one enumerated route with the authority's walk: it must accept it, and agree on the text, the revenue, the
 *  centre count and the track. Answers the walk's track. */
export function verifyAgainstWalk(ctx: RouteWalkContext, route: ExactRoute, segmentKeys: readonly SegmentKey[]): Set<SegmentKey> {
  const verdict = walkRoute(ctx, route.waypoints);
  if (typeof verdict === "string") {
    throw new RouteSearchInconsistencyError(`The exact route search produced ${route.key}, which the walk refuses: ${verdict}`);
  }
  const text = verdict.path.map((wp) => (wp.bypass ? `${wp.hex}*` : wp.hex)).join(">");
  const mine = new Set(route.segmentIds.map((id) => segmentKeys[id]));
  const sameTrack = mine.size === verdict.segments.size && Array.from(mine).every((key) => verdict.segments.has(key));
  if (text !== route.key || verdict.revenue !== route.revenue || verdict.centres !== route.centres || !sameTrack || mine.size !== route.segmentIds.length) {
    throw new RouteSearchInconsistencyError(
      `The exact route search and the walk disagree on ${route.key}: search $${route.revenue} / ${route.centres} centres / ${route.segmentIds.length} sections, walk ${text} $${verdict.revenue} / ${verdict.centres} centres / ${verdict.segments.size} sections.`,
    );
  }
  return verdict.segments;
}

/* ------------------------------------------------------------------ */
/* B. The exact packing                                                */
/* ------------------------------------------------------------------ */

export interface ExactTrain {
  /** The caller's identity for the train (its fleet slot) -- returned untouched. */
  trainIndex: number;
  /** Revenue centres it can count (`>= UNLIMITED_REACH`: a Diesel). */
  maxRevenueCentres: number;
}

export interface ExactAssignment {
  trainIndex: number;
  route: ExactRoute;
  /** The route's track, as the walk named it (witnesses are walk-validated). */
  segments: Set<SegmentKey>;
}

export interface ExactPackingResult {
  assignments: ExactAssignment[];
  total: number;
  packingStates: number;
}

const capOf = (train: ExactTrain) => (isUnlimitedReach(train.maxRevenueCentres) ? Number.POSITIVE_INFINITY : train.maxRevenueCentres);

/** The maximum-revenue set of `routes` the fleet can run together (see the header, B). `routes` must be in the
 *  tie-break order `enumerateLegalRoutes` returns; `blocked` marks segment ids already occupied. Answers, per train in
 *  fleet-slot order, the chosen route index (or -1).
 *
 *  THE SCAN IS WORD-PARALLEL, NOT A SHORTCUT. Each train's list keeps, per section of track, a bitset of the list
 *  positions whose route uses that section. The routes that clash with the set so far are the OR of the bitsets of
 *  the sections it holds, so 32 list positions are judged at once and a clashing route is skipped exactly as the
 *  route-by-route test skipped it: the same candidates, in the same order, under the same bound. */
export function packExactRouteSet(
  routes: readonly ExactRoute[],
  segmentCount: number,
  fleet: readonly ExactTrain[],
  blocked?: Uint8Array,
  maxStates: number = EXACT_SEARCH_MAX_PACKING_STATES,
  maxWork: number = EXACT_SEARCH_MAX_PACKING_WORK,
): { choice: Array<{ trainIndex: number; routeIndex: number }>; total: number; packingStates: number; packingWork: number } {
  const trains = [...fleet].sort((x, y) => capOf(y) - capOf(x) || x.trainIndex - y.trainIndex);
  const usable = (route: ExactRoute) => {
    if (!blocked) return true;
    const ids = route.segmentIds;
    for (let i = 0; i < ids.length; i += 1) if (blocked[ids[i]] !== 0) return false;
    return true;
  };

  /** One capacity's candidates: list positions -> route, revenue, prefix sums, and (built on first use, when a set
   *  already holds track) per-section position bitsets. */
  interface Lane {
    list: Int32Array;
    revenue: Int32Array;
    /** prefix[x] = the revenue of list positions [0, x) (whole dollars; exact in a double far past any board). */
    prefix: Float64Array;
    words: number;
    /** Section id -> the list positions using it: `positions[start[id] .. start[id + 1])`. */
    start?: Int32Array;
    positions?: Int32Array;
    bits: Array<Int32Array | undefined>;
  }
  const laneCache = new Map<number, Lane>();
  const laneFor = (cap: number): Lane => {
    let lane = laneCache.get(cap);
    if (lane) return lane;
    const indices: number[] = [];
    for (let index = 0; index < routes.length; index += 1) {
      if (routes[index].centres <= cap && usable(routes[index])) indices.push(index);
    }
    const list = Int32Array.from(indices);
    const revenue = new Int32Array(list.length);
    const prefix = new Float64Array(list.length + 1);
    list.forEach((index, position) => {
      revenue[position] = routes[index].revenue;
      prefix[position + 1] = prefix[position] + routes[index].revenue;
    });
    lane = { list, revenue, prefix, words: (list.length + 31) >>> 5, bits: new Array(segmentCount) };
    laneCache.set(cap, lane);
    return lane;
  };
  const NONE = new Int32Array(0);
  /** The positions of `lane` whose route uses section `id`, as a bitset (the index and each bitset built on first use). */
  const bitsOf = (lane: Lane, id: number): Int32Array => {
    let bits = lane.bits[id];
    if (bits !== undefined) return bits;
    if (lane.start === undefined || lane.positions === undefined) {
      const count = new Int32Array(segmentCount + 1);
      lane.list.forEach((index) => {
        for (const segment of routes[index].segmentIds) count[segment + 1] += 1;
      });
      for (let x = 0; x < segmentCount; x += 1) count[x + 1] += count[x];
      const fill = count.slice(0, segmentCount);
      const positions = new Int32Array(count[segmentCount]);
      lane.list.forEach((index, position) => {
        for (const segment of routes[index].segmentIds) positions[fill[segment]++] = position;
      });
      lane.start = count;
      lane.positions = positions;
    }
    const from = lane.start[id];
    const to = lane.start[id + 1];
    if (from === to) bits = NONE;
    else {
      bits = new Int32Array(lane.words);
      for (let x = from; x < to; x += 1) bits[lane.positions[x] >>> 5] |= 1 << (lane.positions[x] & 31);
    }
    lane.bits[id] = bits;
    return bits;
  };
  const lanes = trains.map((train) => laneFor(capOf(train)));
  /* THE ADMISSIBLE BOUND. Trains of equal capacity form a GROUP (the fleet is sorted, so a group is contiguous), and
     within a group the running trains take strictly increasing list positions (the symmetry rule below). So the m-th
     train of a group, choosing from position `floor` on, earns at most the revenue at list position `floor + m` --
     the list is revenue-ordered. A group entered fresh is bounded by the revenues of its list's first positions, one per
     train. Never below the true best completion; tighter than "every train its best route" wherever a fleet repeats. */
  const groupEnd = trains.map((train, i) => {
    let j = i + 1;
    while (j < trains.length && capOf(trains[j]) === capOf(train)) j += 1;
    return j;
  });
  /** The revenue of list positions [from, from + count) of train i's list (clamped to the list). */
  const window = (i: number, from: number, count: number) => {
    const sums = lanes[i].prefix;
    const end = Math.min(sums.length - 1, from + count);
    return from >= end ? 0 : sums[end] - sums[from];
  };
  const fresh = new Array<number>(trains.length + 1).fill(0);
  for (let i = trains.length - 1; i >= 0; i -= 1) fresh[i] = window(i, 0, groupEnd[i] - i) + fresh[groupEnd[i]];
  const identicalNext = trains.map((_train, i) => groupEnd[i] > i + 1);

  /** The sections held by the set so far (a stack: pushed with a route, popped after its subtree). */
  const held: number[] = [];
  const chosen: number[] = new Array(trains.length).fill(-1);
  let best = -1;
  let bestChoice: number[] = [];
  let states = 0;
  let work = 0;
  const spend = () => {
    work += 1;
    if (work > maxWork) throw new RouteSearchLimitError(`The exact route-set packing passed ${maxWork} route examinations.`);
  };
  /** `floor`: the smallest list position this train may take (identical-train symmetry); `idleOnly`: an identical
   *  predecessor ran nothing, so this train runs nothing too (idle is last in the order). */
  const search = (i: number, total: number, floor: number, idleOnly: boolean): void => {
    states += 1;
    if (states > maxStates) {
      throw new RouteSearchLimitError(`The exact route-set packing passed ${maxStates} states.`);
    }
    if (i === trains.length) {
      if (total > best) {
        best = total;
        bestChoice = [...chosen];
      }
      return;
    }
    const end = groupEnd[i];
    // Admissible: this train and the rest of its group from `floor` on, then every later group fresh.
    if (total + (idleOnly ? 0 : window(i, floor, end - i)) + fresh[end] <= best) return;
    if (!idleOnly) {
      const lane = lanes[i];
      const n = lane.list.length;
      const after = end - i - 1; // identical trains still to choose after this one
      // The held sections' bitsets for this lane, resolved once: the set is restored after every subtree below.
      const clashes: Int32Array[] = [];
      for (const id of held) {
        const bits = bitsOf(lane, id);
        if (bits.length > 0) clashes.push(bits);
      }
      const prefix = lane.prefix;
      const revenues = lane.revenue;
      const list = lane.list;
      const rest = fresh[end];
      /** Admissible bound of taking position k: its revenue, the identical trains after it at k+1.., the later groups. */
      const reach = (k: number) => {
        const top = k + 1 + after < n ? k + 1 + after : n;
        return total + revenues[k] + (prefix[top] - prefix[k + 1 < n ? k + 1 : n]) + rest;
      };
      // (floor < n: a list already passed has nothing to offer, and its bound would read past the end.)
      scan: for (let w = floor >>> 5; floor < n && w < lane.words; w += 1) {
        const first = (w << 5) > floor ? w << 5 : floor;
        // Revenue-ordered, so this bound only falls with the position: nothing from here on can do better.
        if (reach(first) <= best) break;
        spend();
        let clash = 0;
        for (let h = 0; h < clashes.length && clash !== -1; h += 1) clash |= clashes[h][w];
        let free = ~clash;
        if ((first & 31) !== 0) free &= -1 << (first & 31);
        const valid = n - (w << 5);
        if (valid < 32) free &= (1 << valid) - 1;
        while (free !== 0) {
          const low = free & -free;
          free ^= low;
          const k = (w << 5) + (31 - Math.clz32(low));
          spend();
          if (reach(k) <= best) break scan;
          const index = list[k];
          const ids = routes[index].segmentIds;
          const mark = held.length;
          for (let s = 0; s < ids.length; s += 1) held.push(ids[s]);
          chosen[i] = index;
          search(i + 1, total + revenues[k], identicalNext[i] ? k + 1 : 0, false);
          chosen[i] = -1;
          held.length = mark;
        }
      }
    }
    // This train runs nothing (always available, and last).
    search(i + 1, total, 0, identicalNext[i]);
  };
  search(0, 0, 0, false);

  const choice = trains.map((train, i) => ({ trainIndex: train.trainIndex, routeIndex: bestChoice[i] ?? -1 }));
  choice.sort((x, y) => x.trainIndex - y.trainIndex);
  return { choice, total: Math.max(0, best), packingStates: states, packingWork: work };
}

/** The richest legal route at each centre count (index = centres), in one pass that keeps no route. */
function surveyLegalRoutes(input: ExactEnumerationInput & { occupied?: ReadonlySet<SegmentKey> }): number[] {
  const best: number[] = [];
  traverseLegalRoutes(input, (_points, revenue, centres) => {
    if (!(revenue <= (best[centres] ?? -1))) best[centres] = revenue;
  });
  return best;
}

/** A: enumerate, then B: pack, then have the walk re-judge every chosen route. The one exact answer every v12 caller
 *  asks. `occupied`: track already held (by routes fixed elsewhere) -- no chosen route may use it. A one-train fleet
 *  takes `bestLegalRoute` (the packing's own answer for one train, without keeping the other candidates). */
export function exactRouteSet(
  input: Omit<ExactEnumerationInput, "maxCentres"> & { trains: readonly ExactTrain[]; occupied?: ReadonlySet<SegmentKey> },
): ExactPackingResult & { routes: ExactRoute[]; stats: ExactSearchStats } {
  const maxCentres = input.trains.reduce((most, train) => Math.max(most, capOf(train)), 0);
  const ctx = walkContextOf(input);
  if (input.trains.length === 1) {
    const { route, segmentKeys, stats } = bestLegalRoute({ ...input, maxCentres });
    const assignments: ExactAssignment[] = route ? [{ trainIndex: input.trains[0].trainIndex, route, segments: verifyAgainstWalk(ctx, route, segmentKeys) }] : [];
    return {
      assignments,
      total: route ? route.revenue : 0,
      packingStates: 0,
      routes: route ? [route] : [],
      stats: { ...stats, walkValidated: assignments.length },
    };
  }
  /* REVENUE FLOORS (a proven filter, not a cutoff). Let B_i be train i's best route alone and S = sum B_i. Any legal
     set is worth at least L0 = max B_i (one train running its best route), so in every MAXIMUM set the route on
     train i earns at least L0 - (S - B_i): the other trains together earn at most S - B_i. A route below the floor of
     every train that could run it is in no maximum set, so it is never materialised -- and since the kept routes keep
     their order, the packing's first maximum is unchanged. (Identical trains' floors are 0: nothing is filtered.) */
  const surveyStarted = now();
  const survey = surveyLegalRoutes({ ...input, maxCentres });
  const surveyMs = now() - surveyStarted;
  const bestAlone = input.trains.map((train) => {
    const cap = capOf(train);
    let most = 0;
    survey.forEach((revenue, centres) => {
      if (centres <= cap && revenue > most) most = revenue;
    });
    return most;
  });
  const sum = bestAlone.reduce((a, b) => a + b, 0);
  const lowerBound = bestAlone.reduce((a, b) => Math.max(a, b), 0);
  const floors = input.trains.map((train, i) => ({ cap: capOf(train), floor: lowerBound - (sum - bestAlone[i]) }));
  const keep = (revenue: number, centres: number) => floors.some(({ cap, floor }) => centres <= cap && revenue >= floor);
  const { routes, segmentKeys, stats } = enumerateLegalRoutes({ ...input, maxCentres, keep });
  const started = now();
  const limits = limitsOf(input.limits);
  const packed = packExactRouteSet(routes, segmentKeys.length, input.trains, undefined, limits.packingStates, limits.packingWork);
  const assignments: ExactAssignment[] = [];
  for (const { trainIndex, routeIndex } of packed.choice) {
    if (routeIndex < 0) continue;
    const route = routes[routeIndex];
    assignments.push({ trainIndex, route, segments: verifyAgainstWalk(ctx, route, segmentKeys) });
  }
  const walkValidated = stats.walkValidated > 0 ? stats.walkValidated : assignments.length;
  return {
    assignments,
    total: packed.total,
    packingStates: packed.packingStates,
    routes,
    stats: {
      ...stats,
      walkValidated,
      packingStates: packed.packingStates,
      packingWork: packed.packingWork,
      enumerateMs: Math.round(stats.enumerateMs + surveyMs),
      packMs: Math.round(now() - started),
    },
  };
}
