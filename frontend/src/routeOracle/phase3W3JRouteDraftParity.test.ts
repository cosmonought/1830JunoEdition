/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W3-J AUD-25.09: EVERY EXACT AUTO ROUTE DRAFT SURVIVES THE SHELL'S FILTER
// ==================================================================
//
// SCOPE. The S6-13 remainder, Phase-3 player-facing parity portion ONLY. The structural route cleanup -- retiring
// the shell's local route-draft rules (`runnableDrafts`' flags, `editRouteDraft`'s click rules) in favour of the
// authority -- stays Phase 7 / GitHub issue #1. No production code is changed by this file.
//
// WHAT IT PROVES. Every exact Auto Route draft, in BOTH orientations (as searched, and end-for-end), survives
// `runnableDrafts` with the search's own price, the run's total is the search's total, and the set `handleRunTrains`
// would send passes `routeSetRefusal`.
//
// THE #1554 NEGATIVE CONTROL. The exact search never ENDS a corpus route at the PRR herald, and the filter judges
// only the last point's terminus -- so the reversed orientation is what gives the property teeth. Asked with the
// corporation-blind terminus of design note #1554, the reversed corpus loses herald-ended drafts and the run is
// refused with the S6-3 shortfall ("a legal combination worth $N is available"): the stuck turn this file guards.
//
// THE RISK. `runnableDrafts` (utils/runTrainsRules.ts) judges each draft on four flags the shell derives LOCALLY in
// App's `trainDrafts` memo -- price, the train's number, the terminus, and a token / wall sentence assembled from
// `routeTokenBlockReason`, `bypassedStationReason` and `routeBlockedCityReason` -- not by the route authority. The
// Run button counts what it keeps and `handleRunTrains` sends only what it keeps. If it dropped a route of the exact
// Auto Route set, the run would fall short of the demonstrated maximum (S6-3: refused, "a legal combination worth $N
// is available") while Skip stays withdrawn (`routeRunObligation` / `routeSkipRefusal`) -- a stuck turn.
//
// THE PROPERTY, over the route-oracle corpus (the three dense boards x every corporation with a station or a herald
// x the twelve stress fleets, plus every known-defect fixture x its own fleet and the stress fleets): the shell's
// Auto Route set, flagged exactly as App flags it, loses NOTHING to `runnableDrafts`, each kept draft is priced as
// the search priced it, and the set `handleRunTrains` would send is accepted by `routeSetRefusal` -- the same
// question the reducer and ingress ask.
//
// THE MIRROR IS PINNED. This file re-derives App's drafts (it cannot import a memo); the last block asserts App
// still derives them through exactly these helpers, so the two cannot drift apart silently.

import { denseBoards, STRESS_FLEETS } from "./harness/corpus";
import { KNOWN_DEFECT_FIXTURES } from "./harness/knownDefects";
import { probeCaseFor } from "./harness/compare";
import { probeState } from "./harness/productionProbe";
import type { CorpusBoard } from "./harness/corpus";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { assignRouteSet } from "../gameEngine/routeAutoTrace";
import { cityBlockerFor } from "../gameEngine/cityBlocking";
import { citySlotCount } from "../gameEngine/stationTokens";
import { barredHexesFor } from "../gameEngine/kanawhaLicense";
import { cityEnteredFrom, stationTokensOf } from "../gameEngine/trackReach";
import { overrunsReach, reachForDrafting } from "../gameEngine/trainReach";
import { MOCK_TRAIN_CATALOG } from "../gameEngine/mockFixtures";
import { tokenCityIndex, type StationTokenCompany } from "../components/hexContractTypes";
import { hexOffersBypass, withForcedBypass } from "../gameEngine/cityBypass";
import { isRouteTerminusHex, sandboxRouteBreakdown } from "../gameEngine/sandboxSession";
import { routeRulesV12InEffect } from "../components/hexBoardData";
import { routeSetRefusal } from "../gameEngine/routeAuthority";
import { tileEraFor } from "../gameEngine/gameConstants";
import { routeBlockedCityReason, routePointsToWaypoints, routeTokenBlockReason, type RoutePoint } from "../utils/routeWaypoints";
import { bypassedStationReason } from "../utils/manualBypass";
import { runnableDrafts } from "../utils/runTrainsRules";
import { expectOrder, readShell, readStripped, sliceBetween } from "../utils/sourceScan";

interface Job {
  board: CorpusBoard;
  companyId: number;
  fleet: readonly string[];
}

function corpusJobs(): Job[] {
  const jobs: Job[] = [];
  for (const board of denseBoards()) {
    const heraldOwners = new Set(board.board.hexes.flatMap((hex) => (hex.herald ? [hex.herald.companyId] : [])));
    for (const company of board.companies) {
      if (company.tokens.length === 0 && !heraldOwners.has(company.companyId)) continue;
      for (const fleet of STRESS_FLEETS) jobs.push({ board, companyId: company.companyId, fleet });
    }
  }
  for (const fixture of KNOWN_DEFECT_FIXTURES) {
    for (const fleet of [fixture.fleet, ...STRESS_FLEETS]) jobs.push({ board: fixture.board, companyId: fixture.companyId, fleet });
  }
  return jobs;
}

interface Outcome {
  tag: string;
  v12: boolean;
  searched: number;
  drafted: number;
  lost: string[];
  mispriced: string[];
  refusal: string | null;
  sentTotal: number;
}

interface Probe {
  /** Each Auto Route path end-for-end, as a player redrawing it would: the filter judges only the LAST point's
   *  terminus, and the exact search never ENDS a corpus route at the PRR herald (it starts 42 there). */
  reversed: boolean;
  /** NEGATIVE CONTROL ONLY: the corporation-blind terminus of the #1554 bug. Never what App does. */
  blindTerminus?: boolean;
}

/** App's `handleAutoRoute` -> `trainDrafts` -> `handleRunTrains` (up to the dispatch), for one corpus case. */
function shellAutoRun(job: Job, probe: Probe): Outcome {
  const c = probeCaseFor(job.board, job.companyId, job.fleet);
  const state = probeState(c);
  return withRules(resolveVariants(c.variants), () => {
    const mapGrid = c.grid;
    const companyId = c.companyId;
    const corporation = state.public_companies.find((entry) => entry.company_id === companyId)!;
    // App `ownedTrainRoster`.
    const rank = (model: string) => MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
    const roster = (corporation.owned_trains ?? [])
      .map((model, trainIndex) => ({ trainIndex, model, maxDistance: MOCK_TRAIN_CATALOG.find((t) => t.modelType === model)?.maxDistance }))
      .sort((a, b) => (rank(a.model) < 0 ? 99 : rank(a.model)) - (rank(b.model) < 0 ? 99 : rank(b.model)));
    // App `blocksThroughCity`.
    const blocksThrough = cityBlockerFor({
      actingCompanyId: companyId,
      companies: state.public_companies,
      slotsAt: (q, r, cityIndex) => citySlotCount(mapGrid, q, r, cityIndex),
      cityOf: (company, q, r) => tokenCityIndex(company as unknown as StationTokenCompany, q, r),
      barredHexes: barredHexesFor(state, companyId),
    });
    // App: `eraForPhase(currentPhase, tableVariants)` is `tileEraFor(gameState)`.
    const era = tileEraFor(state);
    // App `handleAutoRoute`.
    const result = assignRouteSet({
      blocksThrough,
      mapGrid,
      era,
      startHexes: stationTokensOf(corporation),
      companyId,
      trains: roster.map((train) => ({ trainIndex: train.trainIndex, maxRevenueCentres: reachForDrafting(train.maxDistance) })),
    });
    const routeDrafts: Record<number, RoutePoint[]> = {};
    for (const assignment of result.assignments) {
      const path = probe.reversed ? [...assignment.path].reverse() : assignment.path;
      routeDrafts[assignment.trainIndex] = path.map((point) => ({
        q: point.q,
        r: point.r,
        hexLabel: point.hexLabel,
        ...(point.variant !== undefined ? { variant: point.variant } : {}),
        ...(point.bypass === true ? { bypass: true } : {}),
      }));
    }
    // App `trainDrafts` (`routeTokenHexes` is `stationTokensOf(corporation)`).
    const tokens = stationTokensOf(corporation);
    const drafts = roster.map((train) => {
      const points = withForcedBypass(routeDrafts[train.trainIndex] ?? [], mapGrid, blocksThrough);
      const breakdown = points.length < 2 ? null : sandboxRouteBreakdown(mapGrid, routePointsToWaypoints(points), era, companyId);
      const centres = breakdown?.stops.length ?? 0;
      const last = points[points.length - 1];
      return {
        trainIndex: train.trainIndex,
        model: train.model,
        points,
        hexLabels: points.map((point) => point.hexLabel),
        value: breakdown?.revenue ?? null,
        exceedsMaxDistance: overrunsReach(centres, train.maxDistance),
        endsOffTerminus:
          points.length >= 2 && last !== undefined
            ? !isRouteTerminusHex(mapGrid, last.hexLabel, probe.blindTerminus ? undefined : companyId)
            : false,
        tokenBlockReason:
          routeTokenBlockReason(points, tokens, mapGrid) ??
          bypassedStationReason(points, tokens, mapGrid) ??
          routeBlockedCityReason(
            points,
            blocksThrough,
            () => null,
            (q, r) => hexOffersBypass(mapGrid, q, r),
            (hex, from) => cityEnteredFrom(mapGrid, hex, from),
          ),
      };
    });
    const drafted = drafts.filter((draft) => draft.hexLabels.length > 0);
    const runnable = runnableDrafts(drafts);
    const why = (d: (typeof drafts)[number]) =>
      d.value === null || d.value <= 0
        ? `value ${String(d.value)}`
        : d.exceedsMaxDistance
          ? "exceedsMaxDistance"
          : d.endsOffTerminus
            ? "endsOffTerminus"
            : d.tokenBlockReason !== null
              ? `token: ${d.tokenBlockReason}`
              : "every flag clear: dropped by a rule inside `runnableDrafts` itself";
    const lost = drafted.filter((draft) => !runnable.includes(draft)).map((d) => `${d.model}#${d.trainIndex} ${d.hexLabels.join(">")} (${why(d)})`);
    const mispriced = runnable.flatMap((draft) => {
      const searched = result.assignments.find((assignment) => assignment.trainIndex === draft.trainIndex)?.revenue;
      return searched === draft.value ? [] : [`${draft.model}#${draft.trainIndex}: search $${String(searched)}, shell $${String(draft.value)}`];
    });
    // App `handleRunTrains`: the two-point filter, then the authority's composite question on what is about to be sent.
    const turnRoutes = runnable
      .filter((draft) => draft.points.length >= 2)
      .map((draft) => ({ train: draft.model, trainIndex: draft.trainIndex, path: routePointsToWaypoints(draft.points) }));
    const refusal =
      turnRoutes.length === 0
        ? result.totalRevenue > 0
          ? "nothing sent"
          : null
        : routeSetRefusal(
            state,
            {
              protocol_id: companyId,
              routes: turnRoutes.map((entry) => entry.path),
              trains: turnRoutes.map((entry) => entry.train),
              train_indices: turnRoutes.map((entry) => entry.trainIndex),
            },
            mapGrid,
            tileEraFor(state),
          );
    return {
      tag: `${job.board.id} company ${companyId} [${job.fleet.join(",")}]${probe.reversed ? " reversed" : ""}`,
      v12: routeRulesV12InEffect(),
      searched: result.totalRevenue,
      drafted: drafted.length,
      lost,
      mispriced,
      refusal,
      sentTotal: runnable.reduce((sum, draft) => sum + (draft.value ?? 0), 0),
    };
  });
}

describe("AUD-25.09: the shell's runnable filter keeps every exact Auto Route draft (route-oracle corpus)", () => {
  const jobs = corpusJobs();
  const outcomes = [false, true].flatMap((reversed) => jobs.map((job) => shellAutoRun(job, { reversed })));

  it("covers the corpus on v12 boards, both ways round, with routes to judge", () => {
    expect(outcomes.length).toBeGreaterThan(800);
    expect(outcomes.every((o) => o.v12)).toBe(true);
    expect(outcomes.reduce((sum, o) => sum + o.drafted, 0)).toBeGreaterThan(1200);
  });

  it("NEGATIVE CONTROL: the #1554 corporation-blind terminus WOULD drop herald-ended drafts and strand the run", () => {
    const blind = jobs.map((job) => shellAutoRun(job, { reversed: true, blindTerminus: true }));
    expect(blind.filter((o) => o.lost.some((line) => line.includes("endsOffTerminus"))).length).toBeGreaterThan(0);
    expect(blind.filter((o) => o.refusal !== null && /a legal combination worth \$\d+ is available/.test(o.refusal)).length).toBeGreaterThan(0);
  });

  it("no Auto Route draft is dropped by `runnableDrafts`", () => {
    expect(outcomes.filter((o) => o.lost.length > 0).map((o) => `${o.tag}: ${o.lost.join("; ")}`)).toEqual([]);
  });

  it("every kept draft is priced by the shell exactly as the search priced it, and the run is the whole search total", () => {
    expect(outcomes.filter((o) => o.mispriced.length > 0).map((o) => `${o.tag}: ${o.mispriced.join("; ")}`)).toEqual([]);
    expect(outcomes.filter((o) => o.sentTotal !== o.searched).map((o) => `${o.tag}: sent $${o.sentTotal} of $${o.searched}`)).toEqual([]);
  });

  it("the set the Run button sends is accepted by `routeSetRefusal` (no S6-3 shortfall, no refusal)", () => {
    expect(outcomes.filter((o) => o.refusal !== null).map((o) => `${o.tag}: ${o.refusal}`)).toEqual([]);
  });
});

describe("AUD-25.09: the mirror above is App's own derivation (source pins)", () => {
  const APP = readShell();

  it("Auto Route drafts through `assignRouteSet` with the shell's wall, tokens and drafting reach", () => {
    const block = sliceBetween(APP, "const handleAutoRoute = useCallback(", "const autoDraftedForRef");
    expect(block).toContain("assignRouteSet({");
    expect(block).toContain("blocksThrough: blocksThroughCityRef.current");
    expect(block).toContain("stationTokensOf(corporation)");
    expect(block).toContain("reachForDrafting(train.maxDistance)");
  });

  it("`trainDrafts` flags each draft through exactly the helpers this test calls", () => {
    const block = sliceBetween(APP, "const trainDrafts = useMemo<TrainRouteDraft[]>(", "const [highlightedTrainIndex");
    for (const call of [
      "withForcedBypass(",
      "sandboxRouteBreakdown(",
      "overrunsReach(centres, train.maxDistance)",
      "isRouteTerminusHex(mapGrid, last.hexLabel, actingProtocolId ?? undefined)",
      "routeTokenBlockReason(points, routeTokenHexes, mapGrid)",
      "bypassedStationReason(points, routeTokenHexes, mapGrid)",
      "routeBlockedCityReason(",
      "hexOffersBypass(mapGrid, q, r)",
      "cityEnteredFrom(mapGrid, hex, from)",
    ]) {
      expect([call, block.includes(call)]).toEqual([call, true]);
    }
  });

  it("(review) the INPUTS the mirror re-derives are App's too: tokens, the wall, the roster's order and the era", () => {
    // `routeTokenHexes`: the acting corporation's `stationTokensOf`.
    const tokens = sliceBetween(APP, "const routeTokenHexes = useMemo<ReadonlyArray<StationToken>>(", "const trainDrafts = useMemo<TrainRouteDraft[]>(");
    expect(tokens).toContain("return corporation ? stationTokensOf(corporation) : [];");
    // `blocksThroughCity`: `cityBlockerFor` with the slot count, the token's city and the barred hexes this test passes.
    const wall = sliceBetween(APP, "const citySlotsAt = useCallback(", "blocksThroughCityRef.current = blocksThroughCity;");
    for (const piece of [
      "citySlotCount(mapGrid, q, r, cityIndex)",
      "cityBlockerFor({",
      "actingCompanyId: actingProtocolId,",
      "tokenCityIndex(company as unknown as StationTokenCompany, q, r)",
      "barredHexes: barredHexesFor(gameState, actingProtocolId),",
    ]) {
      expect([piece, wall.includes(piece)]).toEqual([piece, true]);
    }
    // `ownedTrainRoster`: the catalog's order, unknown models last (the sort this test repeats).
    const roster = sliceBetween(APP, "const ownedTrainRoster = useMemo(() => {", "}, [");
    expect(roster).toContain("MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model)");
    expect(roster).toContain(".sort((a, b) => (rank(a.model) < 0 ? 99 : rank(a.model)) - (rank(b.model) < 0 ? 99 : rank(b.model)));");
    // The era: App's `eraForPhase(currentPhase, tableVariants)` with `currentPhase = derivePhase(gameState)` and
    // `tableVariants = resolveVariants(gameState?.variants)` -- which is `tileEraFor(gameState)`, the test's.
    expect(sliceBetween(APP, "const trainDrafts = useMemo<TrainRouteDraft[]>(", "return ownedTrainRoster.map(")).toContain(
      "const era = eraForPhase(currentPhase, tableVariants);",
    );
    expect(APP).toContain("const currentPhase = useMemo(() => derivePhase(gameState), [gameState]);");
    expect(APP).toContain("const tableVariants = useMemo(() => resolveVariants(gameState?.variants), [gameState]);");
    expect(readStripped("gameEngine/gameConstants.ts")).toContain(
      "return eraForPhase(derivePhase(state ?? null), resolveVariants(state?.variants));",
    );
  });

  it("`handleRunTrains` sends `runnableDrafts(trainDrafts)` and asks `routeSetRefusal` first", () => {
    const block = sliceBetween(APP, "const runnable = runnableDrafts(trainDrafts);", "setLiveOrSubPhase(");
    expectOrder(block, "routeSetRefusal(", 'runGameplayAction("RunMultipleRoutes"');
  });
});
