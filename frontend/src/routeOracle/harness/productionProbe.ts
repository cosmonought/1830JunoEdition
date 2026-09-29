// frontend/src/routeOracle/harness/productionProbe.ts
//
// ==================================================================
//  ROUTE v12 R12-1: ASKING PRODUCTION THE SAME QUESTION (TEST HARNESS)
// ==================================================================
//
// TEST-ONLY, and deliberately OUTSIDE the oracle: this is the one place the R12-1 harness calls production
// route code, so that the oracle (`../oracle*.ts`) never does. It builds a minimal operating-round state at the
// Run Trains step for the case's corporation, then asks production four things under the TABLE'S OWN board
// scope (`withRules`, as the reducer does):
//
//   1. the demonstrated value -- `maxRouteRevenueFor` (the S6-3 shortfall / skip / auto-skip figure);
//   2. the demonstrated SET -- `assignRouteSet` with exactly the inputs `routeSearchFor` gives it (private in
//      `derivedActions.ts`, so rebuilt here from the same exported pieces; its total is asserted equal to (1));
//   3. the authority's verdict on that set -- `evaluateRouteSet` plus the reducer's own Coal River gate;
//   4. optionally, the REDUCER itself: does it apply the set, the skip, and a given legal set (stranding).
//
// A reducer refusal is proven by digest, never by identity (`routeAuthority.test.ts`'s rule).

import type { GameStateResponse } from "../../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry, StationTokenCompany } from "../../components/hexContractTypes";
import { tokenCityIndex } from "../../components/hexContractTypes";
import type { BoardDefinition } from "../../components/hexBoardData";
import type { TileColorTier } from "../../components/hexTileCatalog";
import { withRules } from "../../gameEngine/boardSelection";
import { resolveVariants } from "../../gameEngine/gameVariants";
import { maxRouteRevenueFor } from "../../gameEngine/derivedActions";
import { assignRouteSet } from "../../gameEngine/routeAutoTrace";
import { cityBlockerFor } from "../../gameEngine/cityBlocking";
import { citySlotCount } from "../../gameEngine/stationTokens";
import { barredHexesFor, mayCrossCoalRiver, routeCrossesCoalRiver } from "../../gameEngine/kanawhaLicense";
import { stationTokensOf } from "../../gameEngine/trackReach";
import { reachForDrafting } from "../../gameEngine/trainReach";
import { MOCK_TRAIN_CATALOG } from "../../gameEngine/mockFixtures";
import { evaluateRouteSet, routeSkipRefusal, type ProposedWaypoint } from "../../gameEngine/routeAuthority";
import { applySandboxAction } from "../../gameEngine/sandboxSession";
import { stateDigest } from "../../gameEngine/stateDigest";
import { RULES_ENGINE_VERSION } from "../../gameEngine/rulesVersion";

export const TICKERS: Readonly<Record<number, string>> = {
  1: "PRR",
  2: "NYC",
  3: "CPR",
  4: "B&O",
  5: "C&O",
  6: "ERIE",
  7: "NNH",
  8: "B&M",
  9: "PMQ",
  10: "N&W",
};

export interface ProbeCompany {
  companyId: number;
  /** Raw station tokens: `[q, r]` when recorded without a city, `[q, r, city]` otherwise. */
  tokens: ReadonlyArray<readonly [number, number] | readonly [number, number, number]>;
  licences: number;
  trains: readonly string[];
}

export interface ProbeCase {
  board: BoardDefinition;
  variants: Record<string, unknown>;
  grid: MapGridResponse;
  companies: readonly ProbeCompany[];
  companyId: number;
  era: TileColorTier;
}

export interface SubmittedSet {
  routes: ProposedWaypoint[][];
  trainIndices: number[];
}

const PRESIDENT = "p-probe";

/** The minimal operating-round state at the case corporation's Run Trains step. */
export function probeState(c: ProbeCase): GameStateResponse {
  const order = c.companies.map((company) => company.companyId);
  return {
    game_id: 1,
    player_addresses: [PRESIDENT],
    player_cash: [{ player: PRESIDENT, cash_vgp: "500" }],
    virtual_bank_vgp: "10000",
    private_companies: [],
    variants: { ...c.variants },
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(c.companyId),
    operating_sub_phase: "Routes",
    rules_engine_version: RULES_ENGINE_VERSION,
    market_positions: Object.fromEntries(order.map((id, index) => [id, { price: 100 - index, x: 5 + index, y: 6, enteredAt: index + 1 }])),
    public_companies: c.companies.map((company) => ({
      company_id: company.companyId,
      ticker: TICKERS[company.companyId] ?? `C${company.companyId}`,
      is_floated: true,
      president: PRESIDENT,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "300",
      owned_trains: company.companyId === c.companyId ? [...company.trains] : [],
      player_holdings: [{ player: PRESIDENT, percentage: 60 }],
      station_token_hexes: company.tokens.map(([q, r]) => [q, r]),
      station_tokens: company.tokens.filter((token) => token.length === 3).map((token) => [token[0], token[1], token[2]]),
      station_token_limit: 4,
      kanawha_licenses: company.licences,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const inScope = <T,>(c: ProbeCase, fn: () => T): T => withRules(resolveVariants(c.variants), fn);

/** Production's own search, with exactly `routeSearchFor`'s inputs; returns the set it would demonstrate. */
export function productionSearch(c: ProbeCase, state = probeState(c)) {
  return inScope(c, () => {
    const company = state.public_companies.find((entry) => entry.company_id === c.companyId)!;
    const startHexes = stationTokensOf(company);
    const rank = (model: string) => MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
    const roster = (company.owned_trains ?? [])
      .map((model, trainIndex) => ({ trainIndex, model, maxDistance: MOCK_TRAIN_CATALOG.find((t) => t.modelType === model)?.maxDistance }))
      .sort((a, b) => (rank(a.model) < 0 ? 99 : rank(a.model)) - (rank(b.model) < 0 ? 99 : rank(b.model)));
    const blocksThrough = cityBlockerFor({
      actingCompanyId: c.companyId,
      companies: state.public_companies,
      slotsAt: (q: number, r: number, cityIndex: number) => citySlotCount(c.grid, q, r, cityIndex),
      cityOf: (holder, q, r) => tokenCityIndex(holder as unknown as StationTokenCompany, q, r),
      barredHexes: barredHexesFor(state, c.companyId),
    });
    const started = Date.now();
    const result = assignRouteSet({
      blocksThrough,
      mapGrid: c.grid,
      era: c.era,
      startHexes,
      companyId: c.companyId,
      trains: roster.map((train) => ({ trainIndex: train.trainIndex, maxRevenueCentres: reachForDrafting(train.maxDistance) })),
    });
    const ms = Date.now() - started;
    const set: SubmittedSet = {
      routes: result.assignments.map((assignment) =>
        assignment.path.map((point) => (point.bypass === true ? { hex: point.hexLabel, bypass: true } : { hex: point.hexLabel })),
      ),
      trainIndices: result.assignments.map((assignment) => assignment.trainIndex),
    };
    return { total: result.totalRevenue, set, ms };
  });
}

export function productionDemonstrated(c: ProbeCase, state = probeState(c)): number | null {
  return inScope(c, () => maxRouteRevenueFor(state, c.companyId, c.grid, c.era));
}

export type AuthorityVerdict = { kind: "legal"; total: number } | { kind: "refused"; reason: string };

/** `evaluateRouteSet` and the reducer's Coal River gate (`sandboxSession.ts` core gate), under the table's
 *  scope -- the authority's own law, without the S6-3 shortfall. */
export function productionAuthority(c: ProbeCase, set: SubmittedSet, state = probeState(c)): AuthorityVerdict {
  return inScope(c, () => {
    const verdict = evaluateRouteSet({ state, mapGrid: c.grid, era: c.era, companyId: c.companyId, routes: set.routes, trainIndices: set.trainIndices });
    if (verdict.kind === "refused") return { kind: "refused", reason: verdict.reason };
    if (!mayCrossCoalRiver(state, c.companyId) && set.routes.some((route) => routeCrossesCoalRiver(route))) {
      return { kind: "refused", reason: "COAL-RIVER GATE: the reducer refuses any unlicensed route touching L8." };
    }
    return { kind: "legal", total: verdict.total };
  });
}

function runMessage(c: ProbeCase, set: SubmittedSet, state: GameStateResponse) {
  const company = state.public_companies.find((entry) => entry.company_id === c.companyId)!;
  return {
    RunMultipleRoutes: {
      game_id: 1,
      protocol_id: c.companyId,
      routes: set.routes,
      train_indices: set.trainIndices,
      trains: set.trainIndices.map((index) => (company.owned_trains ?? [])[index]),
      revenue_turn: "3.1.x",
    },
  } as never;
}

/** Whether the REDUCER applies this run (full pipeline: identity, Coal River gate, route set, S6-3 shortfall). */
export function reducerApplies(c: ProbeCase, set: SubmittedSet, state = probeState(c)): boolean {
  const after = applySandboxAction(state, runMessage(c, set, state), { mapGrid: c.grid, era: c.era });
  return stateDigest(after) !== stateDigest(state);
}

/** Whether the reducer lets the corporation leave Run Trains without running (the skip). */
export function reducerAllowsSkip(c: ProbeCase, state = probeState(c)): boolean {
  const skip = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: c.companyId } } as never;
  const after = applySandboxAction(state, skip, { mapGrid: c.grid, era: c.era });
  return stateDigest(after) !== stateDigest(state);
}

/** The scoped skip refusal sentence (ingress asks the same predicate). */
export function skipRefusal(c: ProbeCase, state = probeState(c)): string | null {
  return inScope(c, () => routeSkipRefusal(state, { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: c.companyId } } as never, c.grid));
}

/** A grid in the wire's shape from bare lays (no chain `revenue` / `paths` fields: the catalog prices them). */
export function gridOf(tiles: ReadonlyArray<{ q: number; r: number; tile_id: number; orientation: number; printed?: boolean }>): MapGridResponse {
  return {
    game_id: 1,
    tiles: tiles.map((tile) => ({ q: tile.q, r: tile.r, tile_id: tile.tile_id, orientation: tile.orientation, landmark: null, ...(tile.printed ? { printed: true } : {}) }) as MapTileEntry),
  };
}
