// frontend/src/utils/settlementV12Forks.ts
//
// TEST SUPPORT ONLY for ROUTE v12 R12-3 (the v12 settlement certification). Nothing in the app imports this.
//
// ==================================================================
//  R12-3: WHAT THE v12 ROUTE LAW DOES TO A GAME'S TERMINAL BOARD -- CERTIFIED ON FORKS, NEVER ASSUMED
// ==================================================================
//
// The thirteen SET-0A recipes cannot show it: the GR-4 rooms have no earnable route, UR-7's Gulf line touches no rule
// v12 changed, and the corpus recipes replay unpinned logs, which play the pre-v12 law by R12-2's pin-presence rule.
// So each fork below takes ONE decision point at which the v12 law and the v11 law (the `*_BOARD_PRE_V12` twins, the v11
// law byte for byte) disagree, and plays that turn BOTH ways through the same `RoomSession` a server runs -- ingress,
// reducer, derived entries -- from the same board:
//
//   V12-FORK-Z6C-215-PRR   the real JUNO-Z6C game (1830+ / LPF), Operating Round 6.1, PRR at Run Trains. The v11 law
//                          accepts the recorded $190 run; the v12 demonstration is $210 (IL-11 re-entry past PRR's own
//                          H12 herald, uncounted), so v12 refuses $190 as a shortfall (S6-3) and PRR runs $210.
//   V12-FORK-Z6C-271-BO    the same game, OR 7.1, B&O at Run Trains. v11: the recorded $230. v12: Norfolk (L16) is one
//                          city with TWO circles at $30 (owner data), so B&O runs through it for $240 and $230 is short.
//   V12-FORK-GR4-62-NYC    CONSTRUCTED (the GR-4 start, standard 1830): New York (G19) carries brown #62, NYC holds a
//                          constructed second station in its far city, and the only run is G19 -> H18. v11: #62 at $90,
//                          $130. v12 (the owner's #62 ruling): $80, $120. The construction is named, as UR-7's is: the
//                          grid (#62 on G19, #59 on H18, #55 on F20), NYC's G19 station and the Routes cursor reached by
//                          NYC's own advances; nothing else is set.
//
// Each side then declares the SAME dividend decision (full distribution, the recorded one on Z6C) and stops. The terminal
// fields are then grafted exactly as SET-0A's recipes graft them (GameEnd, bank broken) at the pin of the law that
// played the turn: 12 for the v12 side, 11 for the v11 side. The certification then asks what changed and what it means.

import { join } from "path";

import { entriesFromExport, replayLog, type ExportedEntry, type ReplayEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules, type RouteRulesRevision } from "../gameEngine/boardSelection";
import { assignRouteSet } from "../gameEngine/routeAutoTrace";
import { cityBlockerFor } from "../gameEngine/cityBlocking";
import { citySlotCount } from "../gameEngine/stationTokens";
import { barredHexesFor } from "../gameEngine/kanawhaLicense";
import { stationTokensOf } from "../gameEngine/trackReach";
import { reachForDrafting } from "../gameEngine/trainReach";
import { MOCK_TRAIN_CATALOG } from "../gameEngine/mockFixtures";
import { maxRouteRevenueFor } from "../gameEngine/derivedActions";
import { tileEraFor } from "../gameEngine/gameConstants";
import { logHash } from "../gameEngine/logHash";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry, StationTokenCompany } from "../components/hexContractTypes";
import { tokenCityIndex } from "../components/hexContractTypes";
import { STANDARD_BOARD } from "../components/hexBoardData";
import { RoomSession, type ServerLogEntry } from "./roomSession";
import * as GR from "./gentleRustCertificationGame";
import { readExport } from "./settlementGoldenBoards";

type Board = GameStateResponse;
type Revision = RouteRulesRevision;
type Waypoint = { hex: string; bypass?: true };

/** One side of a fork: the turn as one law played it. */
export interface ForkSide {
  revision: Revision;
  /** The board before the turn, as the room was seeded (the same on both sides but for the pin). */
  before: Board;
  /** The v11 side submits the recorded / v11-demonstrated set; the v12 side the v12-demonstrated set. */
  run: { routes: Waypoint[][]; train_indices: number[]; trains: string[] };
  /** The run's PRINTED total (what the route law priced; Unpredictable Revenue's die applies after). */
  printed: number;
  /** What the trains RAN -- `last_route_revenue`, the figure the dividend must match (S6-2): the printed total after the
   *  server's draw, which both sides of a Z6C fork take from the recorded entry (the game has Unpredictable Revenue). */
  revenue: number;
  /** The demonstration (`maxRouteRevenueFor`) under this side's law, on `before` at Run Trains. */
  demonstrated: number | null;
  /** When the recorded run was offered to this side first: the room's answer. */
  recordedRunAnswer: { kind: string; reason?: string } | null;
  /** The board after the dividend, before any graft. */
  after: Board;
  /** SET-0A's terminal graft at this side's pin (11 or 12). */
  terminal: Board;
  /** The room's own entries: the turn as played on this side. */
  entries: readonly ServerLogEntry[];
  log_hash: string;
}

export interface V12Fork {
  name: string;
  source: string;
  company_id: number;
  what_v12_changes: string;
  v11: ForkSide;
  v12: ForkSide;
}

/* ------------------------------------------------------------------ */
/* The demonstrated set, asked of one law                              */
/* ------------------------------------------------------------------ */

/** The route set production's own search demonstrates for `companyId`, under `revision`'s law -- `derivedActions.ts`'s
 *  `routeSearchFor` inputs, rebuilt from the same exported pieces (it is private there). The reducer is the judge: the
 *  set is only ever SUBMITTED, and the certification asserts its total equals `maxRouteRevenueFor` under the same law. */
export function demonstratedSet(state: Board, companyId: number, grid: MapGridResponse, revision: Revision): { total: number; demonstrated: number | null; routes: Waypoint[][]; train_indices: number[] } {
  return withRules(
    resolveVariants(state.variants),
    () => {
      const company = state.public_companies.find((entry) => entry.company_id === companyId)!;
      const rank = (model: string) => MOCK_TRAIN_CATALOG.findIndex((train) => train.modelType === model);
      const roster = (company.owned_trains ?? [])
        .map((model, trainIndex) => ({ trainIndex, model, maxDistance: MOCK_TRAIN_CATALOG.find((train) => train.modelType === model)?.maxDistance }))
        .sort((a, b) => (rank(a.model) < 0 ? 99 : rank(a.model)) - (rank(b.model) < 0 ? 99 : rank(b.model)));
      const result = assignRouteSet({
        blocksThrough: cityBlockerFor({
          actingCompanyId: companyId,
          companies: state.public_companies,
          slotsAt: (q: number, r: number, cityIndex: number) => citySlotCount(grid, q, r, cityIndex),
          cityOf: (holder, q, r) => tokenCityIndex(holder as unknown as StationTokenCompany, q, r),
          barredHexes: barredHexesFor(state, companyId),
        }),
        mapGrid: grid,
        era: tileEraFor(state),
        startHexes: stationTokensOf(company),
        companyId,
        trains: roster.map((train) => ({ trainIndex: train.trainIndex, maxRevenueCentres: reachForDrafting(train.maxDistance) })),
      });
      return {
        total: result.totalRevenue,
        demonstrated: maxRouteRevenueFor(state, companyId, grid),
        routes: result.assignments.map((assignment) =>
          assignment.path.map((point) => (point.bypass === true ? { hex: point.hexLabel, bypass: true as const } : { hex: point.hexLabel })),
        ),
        train_indices: result.assignments.map((assignment) => assignment.trainIndex),
      };
    },
    revision,
  );
}

/* ------------------------------------------------------------------ */
/* One turn, played through a room                                     */
/* ------------------------------------------------------------------ */

const pinned = (board: Board, revision: Revision): Board => {
  const copy = { ...board } as Board & { rules_engine_version?: number };
  if (revision === "v12") copy.rules_engine_version = 12;
  else delete copy.rules_engine_version; // the pre-v12 twin: R12-2's pin-presence rule
  return copy;
};

/** SET-0A's terminal graft, at the pin of the law that played the turn. */
const terminalAt = (board: Board, pin: 11 | 12): Board => ({ ...board, current_round_type: "GameEnd", bank_broken: true, rules_engine_version: pin }) as Board;

interface Seed {
  state: Board;
  waterfall: Board["waterfall"] | null;
  grid: MapGridResponse;
  market: Board["market_positions"];
}

function roomFor(seed: Seed, revision: Revision, name: string, draw: number): RoomSession {
  let minted = 0;
  return new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: seed.grid, initialMarket: seed.market as never },
    seed: { state: pinned(seed.state, revision), waterfall: (seed.waterfall ?? null) as never },
    build: "r12-3",
    mintId: () => `${name}-${revision}-${(minted += 1)}`,
    now: () => 0,
    mintSeed: () => draw,
  });
}

function playSide(
  name: string,
  seed: Seed,
  revision: Revision,
  companyId: number,
  opts: { recordedRun?: Record<string, unknown>; distribute: boolean; revenueTurn: string; draw: number },
): ForkSide {
  // The server's revenue draw is the RECORDED one on both sides, so the die is not what differs between them.
  const room = roomFor(seed, revision, name, opts.draw);
  const president = room.state.public_companies.find((entry) => entry.company_id === companyId)!.president!;
  const host = room.state.player_addresses[0];
  const submit = (msg: unknown) => room.submit({ actor: president, build: "r12-3", host, msg: msg as never, baseIndex: room.nextIndex - 1 }) as { kind: string; reason?: string };
  const operating = () => room.state.active_operating_order[room.state.active_corporation_index];
  if (room.state.current_round_type !== "OperatingRound" || operating() !== companyId) throw new Error(`${name}: ${companyId} is not operating`);
  for (let guard = 0; room.state.operating_sub_phase !== "Routes"; guard += 1) {
    if (guard > 4) throw new Error(`${name}: never reached Run Trains`);
    const answer = submit({ AdvanceOperatingSubPhase: { game_id: room.state.game_id, protocol_id: companyId } });
    if (answer.kind !== "applied") throw new Error(`${name}: advance refused: ${answer.reason ?? ""}`);
  }
  const before = room.state;
  // Advancing lays nothing, so the grid at Run Trains is the seed's.
  const found = demonstratedSet(before, companyId, seed.grid, revision);

  let recordedRunAnswer: { kind: string; reason?: string } | null = null;
  let run: ForkSide["run"];
  if (opts.recordedRun) {
    recordedRunAnswer = submit(opts.recordedRun);
  }
  const company = room.state.public_companies.find((entry) => entry.company_id === companyId)!;
  if (recordedRunAnswer?.kind === "applied") {
    const body = (opts.recordedRun as { RunMultipleRoutes: { routes: Waypoint[][]; train_indices: number[]; trains: string[] } }).RunMultipleRoutes;
    run = { routes: body.routes, train_indices: body.train_indices, trains: body.trains };
  } else {
    run = { routes: found.routes, train_indices: found.train_indices, trains: found.train_indices.map((index) => (company.owned_trains ?? [])[index]) };
    const answer = submit({
      RunMultipleRoutes: { game_id: room.state.game_id, protocol_id: companyId, payout_strategy: "Withhold", revenue_turn: opts.revenueTurn, ...run },
    });
    if (answer.kind !== "applied") throw new Error(`${name} (${revision}): the demonstrated set was refused: ${answer.reason ?? ""}`);
  }
  const ran = room.state.public_companies.find((entry) => entry.company_id === companyId)! as unknown as { last_route_revenue?: string; printed_route_revenue?: string };
  const revenue = Number(ran.last_route_revenue ?? "0");
  const printed = Number(ran.printed_route_revenue ?? ran.last_route_revenue ?? "0");
  const declared = submit({ DeclareDividends: { game_id: room.state.game_id, protocol_id: companyId, distribute: opts.distribute, revenue_amount: String(revenue) } });
  if (declared.kind !== "applied") throw new Error(`${name} (${revision}): the dividend was refused: ${declared.reason ?? ""}`);
  const after = room.state;
  // The log hash covers the turn the room played (its own entries); the board behind it is named by the fork's `source`.
  const entries = [...room.entries];
  return {
    revision,
    before,
    run,
    printed,
    revenue,
    demonstrated: found.demonstrated,
    recordedRunAnswer,
    after,
    terminal: terminalAt(after, revision === "v12" ? 12 : 11),
    entries,
    log_hash: logHash(entries),
  };
}

/* ------------------------------------------------------------------ */
/* The Z6C forks: the real game, replayed to the turn                  */
/* ------------------------------------------------------------------ */

const z6cEntries = (): ExportedEntry[] => readExport(join(__dirname, "__fixtures__z6cLog.json"));

/** The Z6C game replayed (development-corpus policy, as SYN-05 is) through every entry before `index`. */
function z6cSeedBefore(index: number): { seed: Seed; recorded: ReplayEntry[] } {
  const all = entriesFromExport(z6cEntries());
  const prefix = all.filter((entry) => entry.index < index);
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []);
  const result = replayLog(prefix, sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall }, undefined, DEVELOPMENT_CORPUS_POLICY);
  return {
    seed: { state: result.state, waterfall: result.waterfall as never, grid: result.grid, market: result.market as never },
    recorded: all.filter((entry) => entry.index >= index),
  };
}

function z6cFork(name: string, runIndex: number, companyId: number, what: string): V12Fork {
  const { seed, recorded } = z6cSeedBefore(runIndex);
  const runEntry = recorded.find((entry) => entry.index === runIndex)!;
  const recordedRun = JSON.parse(runEntry.payload) as { RunMultipleRoutes: Record<string, unknown> };
  const declare = (JSON.parse(recorded.find((entry) => entry.index === runIndex + 1)!.payload) as { DeclareDividends: { distribute: boolean } }).DeclareDividends;
  if (Number(recordedRun.RunMultipleRoutes.protocol_id) !== companyId) throw new Error(`${name}: entry ${runIndex} is not ${companyId}'s run`);
  const opts = {
    recordedRun,
    distribute: declare.distribute,
    revenueTurn: String(recordedRun.RunMultipleRoutes.revenue_turn),
    draw: Number(recordedRun.RunMultipleRoutes.revenue_seed),
  };
  return {
    name,
    source: `JUNO-Z6C (utils/__fixtures__z6cLog.json), replayed through entry ${runIndex - 1}; the turn is entries ${runIndex} (run) and ${runIndex + 1} (dividend)`,
    company_id: companyId,
    what_v12_changes: what,
    v11: playSide(name, seed, "pre-v12", companyId, opts),
    v12: playSide(name, seed, "v12", companyId, opts),
  };
}

/* ------------------------------------------------------------------ */
/* The #62 fork: constructed on the GR-4 start                        */
/* ------------------------------------------------------------------ */

const at = (label: string) => STANDARD_BOARD.hexes.find((hex) => hex.label === label)!;

/** G19 New York with brown #62 turned 1 (its cities on edges 1-2 and 3-4), H18 with #59 turned 1 (city 0 facing G19),
 *  F20 with #55: the ING-1 fixture's network (`routeOracle/harness/knownDefects.ts`) with New York upgraded to #62. */
export const GR62_GRID: MapGridResponse = {
  game_id: 1,
  tiles: ([["G19", 62, 1], ["H18", 59, 1], ["F20", 55, 0]] as const).map(
    ([label, tile_id, orientation]) => ({ q: at(label).q, r: at(label).r, tile_id, orientation, landmark: null }) as MapTileEntry,
  ),
};

function gr62Seed(): Seed {
  const state = GR.certificationStart() as Board;
  const nyc = state.public_companies.find((entry) => entry.company_id === GR.NYC)!;
  const g19 = at("G19");
  // CONSTRUCTED: NYC's second station, in New York's far city (city 1), as UR-7 constructs C&O's I5 station.
  nyc.station_token_hexes = [...nyc.station_token_hexes, [g19.q, g19.r]];
  (nyc as unknown as { station_tokens: Array<[number, number, number]> }).station_tokens = [
    ...((nyc as unknown as { station_tokens: Array<[number, number, number]> }).station_tokens ?? []),
    [g19.q, g19.r, 1],
  ];
  return { state, waterfall: null, grid: GR62_GRID, market: state.market_positions };
}

function gr62Fork(): V12Fork {
  const seed = gr62Seed();
  const opts = { distribute: true, revenueTurn: "3.1.1", draw: 1 }; // GR-4: Unpredictable Revenue off; the draw is inert
  return {
    name: "V12-FORK-GR4-62-NYC",
    source: "CONSTRUCTED on the GR-4 start (utils/gentleRustCertificationGame.ts): GR62_GRID and NYC's G19 station; NYC advances to Run Trains itself",
    company_id: GR.NYC,
    what_v12_changes: "tile #62 pays $80 per city (owner ruling, folded into v12); the v11 law priced it $90",
    v11: playSide("V12-FORK-GR4-62-NYC", gr62Seed(), "pre-v12", GR.NYC, opts),
    v12: playSide("V12-FORK-GR4-62-NYC", seed, "v12", GR.NYC, opts),
  };
}

/* ------------------------------------------------------------------ */
/* The three                                                           */
/* ------------------------------------------------------------------ */

let cache: readonly V12Fork[] | null = null;

export function v12Forks(): readonly V12Fork[] {
  if (cache) return cache;
  cache = [
    z6cFork(
      "V12-FORK-Z6C-215-PRR",
      215,
      1,
      "IL-11: a route may re-enter a hex on distinct track and pass PRR's own counted H12 herald uncounted, so the v12 demonstration is $210 and the recorded $190 is a shortfall (S6-3)",
    ),
    z6cFork(
      "V12-FORK-Z6C-271-BO",
      271,
      4,
      "Norfolk (L16) is ONE city with TWO circles at $30 / $50 on the 1830+ map (owner data); the v11 law priced it a flat $20 with one circle",
    ),
    gr62Fork(),
  ];
  return cache;
}
