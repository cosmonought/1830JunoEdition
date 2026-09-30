// frontend/src/gameEngine/routeAuthority.ts
//
// The authoritative route evaluator: what a corporation's trains may run, and what the run is worth.
//
// ==================================================================
//  DESIGN NOTE 1550: THE REDUCER PRICED ROUTES AND NEVER JUDGED THEM
// ==================================================================
//
// AUDIT C2 (Batch 6). Until this batch the `RunMultipleRoutes` arm took whatever waypoint lists the message
// carried, priced them with `sandboxRouteBreakdown`, and wrote the sum into `last_route_revenue`. Every rule of
// rulebook §6.4 / §6.4.2 -- a station on the route, the train's number, continuity, no reversal at a junction, no
// crossover change, no track reused within or between the corporation's trains, full cities not run through,
// red areas terminal only, each train once, no more runs than trains -- lived in the UI (`runTrainsRules.ts`,
// `routeWaypoints.ts`, `routeConnection.ts`, `routeDraftEdit.ts`, the auto-tracer). A hand-built message went
// through all of it and was paid.
//
// THIS MODULE IS THE ONE JUDGE. `evaluateRouteSet` consumes authoritative state (the fleet, the tokens, every
// corporation's tokens for blocking, the licence), the board (`mapGrid` + the board in effect), the era and the
// message's proposed geometry, and answers either a legal route set with authoritative per-train revenues and
// the total, or one specific refusal. The reducer asks it before the arm (`applySandboxActionCore`) and the arm
// prices from its answer; the socket asks it at ingress (`turnAuthority`) so a hostile client is told why. The UI
// may call it for a preview, and a UI verdict is never authority.
//
// NOTHING HERE IS A SECOND NETWORK MODEL. Every geometric question is put to the primitives the auto-tracer,
// the network walk and the pricing already share: `traversalsFrom` / `neighbourAcross` / `segmentsTouchingEdge`
// (`trackSegments.ts`, the rail-level model of #0/#669/#731), `stopEnteredFrom` / `cityForArrival`
// (`trackReach.ts`, #1022/#1319), `cityBlockerFor` (`cityBlocking.ts`, #729), `stationTokensOf` (#686/#1302),
// `sandboxRouteBreakdown` / `isRouteTerminusHex` (`sandboxSession.ts`, #1318/#737/#1302). A submitted path is
// re-walked through those exact functions; what the walk cannot reproduce, the route did not do.
//
// ------------------------------------------------------------------
//  THE RULES, AS VERIFIED AGAINST THE 2018 LOOKOUT 1830-RE RULEBOOK (Batch 6, Part 1)
// ------------------------------------------------------------------
//
//   §6.4    each train owned may run once; "trains may not be combined or double headed"; a train bought this
//           turn does not run (step order).
//   §6.4.1  the train's number is the maximum number of cities on its route; "city" means a large city, a small
//           city or an off-board red area; a route includes every city it runs through or to and may not skip
//           one; a shorter route is allowed; a route needs at least two cities; a Diesel has no maximum.
//   §6.4.2  a route is a continuous segment of track including at least one city with one of the railroad's
//           stations; it may not reverse at a junction, change track at a crossover, use the same section of
//           track more than once, or include the same city more than once (different cities of one hex are
//           different cities); it may not pass through a red off-board area (start/end only) or through a large
//           city whose circles are all filled with other railroads' stations (§6.3.3 -- start/end is fine, and
//           an empty circle or one's own station lets any train through); two or more trains of one railroad
//           may not use the same track, but may meet or cross at cities and use two separate tracks in one hex.
//   §6.5    revenue is the sum of the values of the cities on the route; the railroad's revenue is the sum of
//           its trains' runs; off-board values switch at the first 5-train (`offboardValueForEra`).
//
// TOWNS ARE TERMINI (S6-10, owner ruling 2026-09-15, #1555). The rulebook's "city" includes a small city and a
// route "may begin or end at any city"; the code's older `SingleCity || DoubleCity` reading (tracer note #3,
// #1286's "unlike small towns") is withdrawn. The correction is made once, in `isRouteTerminusHex`
// (`sandboxSession.ts`), which the tracer, the obligation gate (`hasLegalRouteFor`), the auto-skip, the draft
// editor, the shell's `endsOffTerminus` and this evaluator all read -- so preview, search and authority agree.
//
// OWNER VARIANTS PRESERVED, NOT AUDITED (S6-4, Stage 9): the PRR herald (#1302) is a station root, a revenue
// centre and a terminus for its owner only, and its owner may cross it uncounted (`bypass: true`); Coal River is
// barred without a Kanawha Licence (#1323); LPF warehouses are red areas a route may run through (#1320).

import type { GameStateResponse } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";
import type { MapGridResponse } from "../components/hexContractTypes";
import { tokenCityIndex, type StationTokenCompany } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import { boardMemo } from "../components/hexBoardData";
import type { SegmentKey } from "./trackSegments";
import { stationTokensOf } from "./trackReach";
import { cityBlockerFor } from "./cityBlocking";
import { citySlotCount } from "./stationTokens";
import { barredHexesFor } from "./kanawhaLicense";
import { walkRoute, type ProposedWaypoint, type RouteWalkContext, type WalkedRoute } from "./routeWalk";
import { MOCK_TRAIN_CATALOG } from "./mockFixtures";
import { isUnlimitedReach } from "./trainReach";
import { tileEraFor } from "./gameConstants";
import { operatingCorporationId } from "./dividendGate";
import { maxRouteRevenueFor } from "./derivedActions";

/** One stop of a proposed route, exactly as `RunMultipleRoutes.routes[i][j]` carries it (R12-2: declared beside the
 *  walk, `routeWalk.ts`, and re-exported here for every existing importer). */
export type { ProposedWaypoint } from "./routeWalk";

/** What the reducer needs to know about one legal run. */
export interface AuthoritativeRun {
  /** Position in `owned_trains` -- the train's identity (#275/#1031). */
  trainIndex: number;
  /** The model in that slot, read from the fleet, never from the message. */
  model: string;
  /** The route as the authority will price it: the message's waypoints with `bypass` normalised to the way
   *  through the hex actually offers. Byte-identical to the input for every route that told the truth. */
  path: ProposedWaypoint[];
  /** Printed revenue of this run (rulebook §6.5; before any owner-variant die). */
  revenue: number;
  /** Cities counted against the train's number. */
  centres: number;
  /** Every section of track the run occupies -- what a second train must keep off. */
  segments: ReadonlySet<SegmentKey>;
}

export type RouteSetVerdict =
  | { kind: "legal"; runs: AuthoritativeRun[]; total: number }
  | { kind: "refused"; reason: string; route?: number };

export interface RouteSetInput {
  state: GameStateResponse;
  mapGrid: MapGridResponse;
  /** The tile era for off-board values; `tileEraFor(state)` when the caller has no better snapshot. */
  era?: TileColorTier;
  companyId: number;
  routes: ReadonlyArray<ReadonlyArray<ProposedWaypoint>>;
  /** `RunMultipleRoutes.train_indices` -- which fleet slot runs `routes[i]`. Optional for logs written before
   *  #1031; then the authority pairs routes to trains itself (see `assignTrains`). */
  trainIndices?: ReadonlyArray<number> | null;
  /** `RunMultipleRoutes.trains` -- the models the client claims; must agree with the fleet when present. */
  trains?: ReadonlyArray<string> | null;
}

const labelByCoord = boardMemo(
  (board): ReadonlyMap<string, string> => new Map(board.hexes.map((hex) => [`${hex.q},${hex.r}`, hex.label])),
);

/** The train's number, from the catalog; `null` for a model the catalog does not know. */
export function trainCapacityFor(model: string): number | null {
  const entry = MOCK_TRAIN_CATALOG.find((train) => train.modelType === model);
  return entry ? entry.maxDistance : null;
}

/** Pairs routes to fleet slots when the message did not (logs written before #1031). Largest route to the
 *  largest train: if that pairing does not fit, none does. */
function assignTrains(
  fleet: readonly string[],
  centres: readonly number[],
): number[] | string {
  const trains = fleet
    .map((model, index) => ({ index, capacity: trainCapacityFor(model) }))
    .filter((train): train is { index: number; capacity: number } => train.capacity !== null)
    .sort((a, b) => b.capacity - a.capacity);
  const routes = centres.map((count, index) => ({ index, count })).sort((a, b) => b.count - a.count);
  const assigned: number[] = new Array(centres.length).fill(-1);
  for (let at = 0; at < routes.length; at += 1) {
    const train = trains[at];
    if (!train) return "The corporation has fewer trains than routes.";
    if (!isUnlimitedReach(train.capacity) && routes[at].count > train.capacity) {
      return `A route with ${routes[at].count} stops has no train that can run it.`;
    }
    assigned[routes[at].index] = train.index;
  }
  return assigned;
}

/** THE EVALUATOR. Judges the whole set: the trains named, each route, and the routes together. */
export function evaluateRouteSet(input: RouteSetInput): RouteSetVerdict {
  const { state, mapGrid, companyId, routes } = input;
  const era = input.era ?? tileEraFor(state);
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company) return { kind: "refused", reason: `No corporation #${companyId} is on this board.` };
  const fleet = company.owned_trains;
  if (fleet == null) return { kind: "refused", reason: `${company.ticker}'s fleet is not on the board, so nothing can run.` };
  if (!Array.isArray(routes) || routes.length === 0) {
    return { kind: "refused", reason: "A run must declare at least one route." };
  }
  if (routes.length > fleet.length) {
    return {
      kind: "refused",
      reason: `${company.ticker} owns ${fleet.length} train${fleet.length === 1 ? "" : "s"} and declared ${routes.length} routes; each train runs once.`,
    };
  }
  if (!company.station_token_hexes) {
    return { kind: "refused", reason: `${company.ticker}'s stations are not on the board, so nothing can run.` };
  }

  /* WHICH TRAIN RUNS WHICH ROUTE. Named by the message (#1031) and checked against the fleet, or paired here. */
  let indices: number[];
  const named = input.trainIndices ?? null;
  if (named !== null) {
    if (named.length !== routes.length) {
      return { kind: "refused", reason: "The run names a different number of trains than routes." };
    }
    const seen = new Set<number>();
    for (const index of named) {
      if (!Number.isInteger(index) || index < 0 || index >= fleet.length) {
        return { kind: "refused", reason: `${company.ticker} has no train in slot ${String(index)}.` };
      }
      if (seen.has(index)) {
        return { kind: "refused", reason: `Train ${fleet[index]} (slot ${index}) is named for two routes; each train runs once.` };
      }
      seen.add(index);
    }
    indices = [...named];
  } else {
    indices = [];
  }
  const claimed = input.trains ?? null;
  if (claimed !== null && named !== null) {
    if (claimed.length !== routes.length) {
      return { kind: "refused", reason: "The run names a different number of train models than routes." };
    }
    for (let i = 0; i < routes.length; i += 1) {
      if (claimed[i] !== fleet[indices[i]]) {
        return {
          kind: "refused",
          reason: `Slot ${indices[i]} holds a ${fleet[indices[i]]}-train, not the ${claimed[i]} the run claims.`,
        };
      }
    }
  }

  const tokens = stationTokensOf({ ...company, company_id: company.company_id });
  const blocksThrough = cityBlockerFor({
    actingCompanyId: companyId,
    companies: state.public_companies,
    slotsAt: (q, r, cityIndex) => citySlotCount(mapGrid, q, r, cityIndex),
    cityOf: (holder, q, r) => tokenCityIndex(holder as unknown as StationTokenCompany, q, r),
    barredHexes: barredHexesFor(state, companyId),
  });

  /* R12-2: the one walk (`routeWalk.ts`), which the route search now asks of every route it demonstrates. The
     barred hexes travel beside the blocker so Coal River is closed to an unlicensed corporation even as an END --
     at ingress too, which never asked the reducer's separate gate. */
  const walkContext: RouteWalkContext = {
    mapGrid,
    era,
    companyId,
    tokens,
    blocksThrough,
    barredHexes: barredHexesFor(state, companyId),
  };
  const walkedRoutes: WalkedRoute[] = [];
  for (let i = 0; i < routes.length; i += 1) {
    const verdict = walkRoute(walkContext, routes[i]);
    if (typeof verdict === "string") return { kind: "refused", reason: `Route ${i + 1}: ${verdict}`, route: i };
    walkedRoutes.push(verdict);
  }

  if (named === null) {
    const paired = assignTrains(fleet, walkedRoutes.map((route) => route.centres));
    if (typeof paired === "string") return { kind: "refused", reason: paired };
    indices = paired;
  }

  /* THE TRAIN'S NUMBER (§6.4.1), from the slot's model and nothing the message says. */
  const runs: AuthoritativeRun[] = [];
  for (let i = 0; i < routes.length; i += 1) {
    const model = fleet[indices[i]];
    const capacity = trainCapacityFor(model);
    if (capacity === null) {
      return { kind: "refused", reason: `Slot ${indices[i]} holds a ${model}-train, which no catalog prices.`, route: i };
    }
    const { centres } = walkedRoutes[i];
    if (!isUnlimitedReach(capacity) && centres > capacity) {
      return {
        kind: "refused",
        reason: `Route ${i + 1} counts ${centres} cities, more than a ${model}-train's ${capacity}.`,
        route: i,
      };
    }
    runs.push({
      trainIndex: indices[i],
      model,
      path: walkedRoutes[i].path,
      revenue: walkedRoutes[i].revenue,
      centres,
      segments: walkedRoutes[i].segments,
    });
  }

  /* THE SET TOGETHER (§6.4.2): no two of the corporation's trains on one section of track. Cities and hexes may
     be shared -- a city is a node and a hex may carry two separate tracks -- and both fall out of the segment
     model (#669/#731): only a shared rail stub or a shared hex edge is a shared section of track. */
  const occupied = new Map<SegmentKey, number>();
  for (let i = 0; i < runs.length; i += 1) {
    let clash: { key: SegmentKey; other: number } | null = null;
    runs[i].segments.forEach((key) => {
      const other = occupied.get(key);
      if (other !== undefined && clash === null) clash = { key, other };
      occupied.set(key, i);
    });
    if (clash !== null) {
      const { key, other } = clash as { key: SegmentKey; other: number };
      const hex = key.split("#")[0].split("~")[0];
      const label = labelByCoord().get(hex) ?? hex;
      return {
        kind: "refused",
        reason: `Routes ${other + 1} and ${i + 1} both use the track at ${label}; two of a corporation's trains may share a city but never a section of track.`,
        route: i,
      };
    }
  }

  return { kind: "legal", runs, total: runs.reduce((sum, run) => sum + run.revenue, 0) };
}

/* ------------------------------------------------------------------ */
/* The reducer's and the socket's questions                           */
/* ------------------------------------------------------------------ */

/** Why this `RunMultipleRoutes` may not be applied, or `null` when it may.
 *
 *  ASKED IN TWO PLACES, deliberately (the #1530/#1540 shape): at ingress, so the submitter hears the sentence,
 *  and in `applySandboxActionCore`, so a message that reaches the reducer by any other road is a no-op. Without
 *  a grid the geometry cannot be judged and, on #757's rule, the gate has no opinion -- every live path has a
 *  grid, and a fixture without one is exercising another rule. */
export function routeSetRefusal(
  state: GameStateResponse,
  msg: { protocol_id: number; routes: ReadonlyArray<ReadonlyArray<ProposedWaypoint>>; trains?: ReadonlyArray<string>; train_indices?: ReadonlyArray<number> },
  mapGrid: MapGridResponse | undefined,
  era?: TileColorTier,
): string | null {
  const company = state.public_companies.find((entry) => entry.company_id === msg.protocol_id);
  /* ONE RUN PER TURN, judged on the board rather than on the message's own key (#1183 keeps the key for the
     undo case). `routes_run_this_turn` is turn-scoped (#777), so a second run in one turn is a duplicate
     whatever key it carries -- and a duplicate paid twice is the JUNO-3XD 318/319 case (S6-2). */
  if (company && (company.routes_run_this_turn ?? 0) > 0) {
    return `${company.ticker} has already run its trains this turn.`;
  }
  /* AT THE RUN TRAINS STEP. A run at another step would end the turn's track and token steps on the strength
     of a message sent out of order; an unknown cursor is let through on the gate family's rule (#232). */
  if (state.operating_sub_phase !== undefined && state.operating_sub_phase !== "Routes") {
    return "Trains run at the Run Trains step.";
  }
  if (mapGrid === undefined) return null;
  const verdict = evaluateRouteSet({
    state,
    mapGrid,
    era,
    companyId: msg.protocol_id,
    routes: msg.routes,
    trainIndices: msg.train_indices ?? null,
    trains: msg.trains ?? null,
  });
  if (verdict.kind === "refused") return verdict.reason;
  return demonstratedShortfall(state, msg.protocol_id, mapGrid, verdict.total, era);
}

/* ==================================================================
    DESIGN NOTE 1556: THE HIGHEST-REVENUE COMBINATION, AS A DEMONSTRATED LOWER BOUND (S6-3, ruled 2026-09-15)
   ==================================================================
   Rulebook §6.4: "the combination of routes with the highest revenue should be chosen. If after declaring a
   route for a train, another player can demonstrate another route that earns a higher revenue, the highest
   revenue route must be taken." THE MACHINE PLAYS THE DEMONSTRATING OPPONENT. `maxRouteRevenueFor` runs the
   deterministic route search (`assignRouteSet`) for this corporation's actual fleet under the board's own rules
   -- blocking, the licence, the herald, the era -- and whatever it finds is a CONCRETE legal combination, so a
   submitted set worth less than it is refused with that figure. It is a bounded heuristic, not an optimiser
   (`routeAutoTrace.ts` #892 / #8), so it is a LOWER BOUND ONLY: a legal hand-drawn set worth as much or more
   stands, however the search missed it -- refusing it would make the heuristic's ceiling the rulebook's, which
   is the false reading this design avoids. Compared on the corporation's TOTAL (the rulebook's "combination"),
   printed figures on both sides (the Unpredictable Revenue die applies after). The auto-tracer offers this same
   set to the client, so a normal client never meets the refusal. `null` from the search ("could not tell") is
   no opinion; a search that finds nothing bounds nothing. Cost: one search per submitted run (the auto-skip
   already runs it once per turn); performance / caching is recorded as later work (S6-14), not a rule. */
export function demonstratedShortfall(
  state: GameStateResponse,
  companyId: number,
  mapGrid: MapGridResponse,
  submittedTotal: number,
  /** The era the submitted set was priced at; the demonstration is priced at the same one. */
  era?: TileColorTier,
): string | null {
  const best = maxRouteRevenueFor(state, companyId, mapGrid, era);
  if (best === null || best <= submittedTotal) return null;
  return `Route set earns $${submittedTotal}; a legal combination worth $${best} is available.`;
}

/** AUDIT C1 (S6-2): the dividend pays what the trains ran. `revenue_amount` is kept on the wire for narration
 *  and replay of logs written before this note, and must now agree with `last_route_revenue` to the dollar.
 *  An absent amount (a log from before #752) is judged by `dividendRevenue`'s fallback, which reads the same
 *  field. The forced $0 withhold (#1275) is derived from a board whose field is "0", so it agrees by
 *  construction. */
export function dividendAmountRefusal(
  state: GameStateResponse,
  msg: { protocol_id: number; revenue_amount?: string | null },
): string | null {
  const company = state.public_companies.find((entry) => entry.company_id === msg.protocol_id);
  if (!company) return null;
  const stated = msg.revenue_amount;
  if (stated === undefined || stated === null || stated === "") return null;
  const declared = Number(stated);
  const earned = Number(company.last_route_revenue ?? 0) || 0;
  if (!Number.isFinite(declared) || declared !== earned) {
    return `${company.ticker} ran $${earned} this turn; a dividend declaration of $${String(stated)} does not match it.`;
  }
  return null;
}

/** RUN TRAINS MAY NOT BE SKIPPED WHILE A PAYING ROUTE EXISTS (rulebook §6.4: "the combination of routes with the
 *  highest revenue should be chosen" -- a railroad with a train and a route runs; §6.5: only a railroad with
 *  no train or no route has no revenue). `routeStep.ts` has held this rule in the shell since #414 as the
 *  obligation behind the Skip button; this is the same question asked of the authority, on the same search the
 *  auto-skip already runs (`maxRouteRevenueFor`), so the server never generates a skip this refuses. Which
 *  route, and whether it is the best one, stays the president's (S6-3, deferred). Without a grid: no opinion
 *  (#757). */
export function routeSkipRefusal(
  state: GameStateResponse,
  msg: SandboxLogMsg,
  mapGrid: MapGridResponse | undefined,
): string | null {
  if (!("AdvanceOperatingSubPhase" in msg) && !("PassTurn" in msg)) return null;
  if (mapGrid === undefined) return null;
  if (state.current_round_type !== "OperatingRound" || state.operating_sub_phase !== "Routes") return null;
  const companyId = operatingCorporationId(state);
  if (companyId === null) return null;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company || (company.owned_trains?.length ?? 0) === 0) return null;
  if ((company.routes_run_this_turn ?? 0) > 0) return null;
  const best = maxRouteRevenueFor(state, companyId, mapGrid);
  if (best === null || best <= 0) return null;
  return `${company.ticker} has a route it can run (worth up to $${best}), so it must run before its turn moves on.`;
}
