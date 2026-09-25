// frontend/src/utils/yellowSignRunBoundSupport.ts
//
// TEST SUPPORT ONLY for UR-3 (Variant Certification 1B -- Unpredictable Revenue, the Yellow Sign's authority).
// Nothing in the app imports this.
//
// ==================================================================
//  UR-3 (support): CONSTRUCTED BOARDS WITH EARNING ROUTES, AND SEEDS FOUND AGAINST THE PURE SELECTORS
// ==================================================================
//
// The Yellow Sign rides on a run that EARNS: a Mark needs a real reduction (printed >= $30) and a Carcosa a real
// increase, so these boards carry a small legal network instead of GR-4's routeless map. It is the one the Batch-6
// route-authority harness already proves (`routeAuthority.test.ts`): yellow cities I5 - I7 - I9 on the printed map,
// the plain curve I3 and the Gulf off-board at J2 ($30). C&O's station is on I5 (its constructed home), so
//     a 2-train's best is I5-I3-J2 ($50) and a 3-train's is I5-I7-I9 ($60) -- together $110, the authority's own
//     demonstrated best for [2, 3] (S6-3 would refuse anything less);
//     a single 4-, 5- or D-train's best is J2-I3-I5-I7-I9 ($90).
// Every other floated corporation holds its token on its REAL printed home (`STATION_HOME_HEXES`), so no home station
// is owed and no hold stands; none of them has a route on this map.
//
// SEEDS ARE FOUND, NEVER ASSERTED. Each is the first draw from 1 upward whose outcome -- by the pure selectors the
// reducer and the shell both use (`rollTurnRevenue`, `flavorBucketFor`, `revenueFlavourClause`, `carcosaRollHits`) --
// is the stage a case needs, so a change to the flavour payload or the extractions shifts the seed instead of
// silently shifting the game. The predicates read nothing the implementation under test decides.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import { RoomSession } from "./roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import {
  flavorBucketFor,
  resolveVariants,
  revenueFlavourClause,
  rollTurnRevenue,
  type GameVariants,
  type RevenueSeedParts,
} from "../gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { carcosaRollHits, YELLOW_SIGN_MALUS_LINE } from "../gameEngine/yellowSign";
import { marketCellForPrice } from "../gameEngine/marketGeometry";

/** Share prices on one row of the printed chart, highest first. */
const DEFAULT_PRICES = [100, 90, 82, 76, 71, 67, 60];

export const P1 = "p1";
export const P2 = "p2";
export const P3 = "p3";

export const PRR = 1;
export const NYC = 2;
export const CPR = 3;
export const BO = 4;
export const CO = 5;

export const TICKER: Record<number, string> = { 1: "PRR", 2: "NYC", 3: "CPR", 4: "B&O", 5: "C&O", 6: "ERIE", 7: "NNH", 8: "B&M" };

function at(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return { q: hex.q, r: hex.r };
}

type Lay = [label: string, tileId: number, orientation: number];
const gridOf = (lays: Lay[], base: MapGridResponse = { game_id: 1, tiles: [] } as unknown as MapGridResponse): MapGridResponse => ({
  ...base,
  tiles: [...base.tiles, ...lays.map(([label, tile_id, orientation]) => ({ ...at(label), tile_id, orientation }) as MapTileEntry)],
});

/** Three yellow cities in a row, I5 - I7 - I9, each $20 in Yellow. */
export const LINE = gridOf([
  ["I5", 57, 0],
  ["I7", 57, 0],
  ["I9", 57, 0],
]);
/** LINE with the plain curve I3 joining I5 to the Gulf off-board at J2 ($30). */
export const GULF = gridOf([["I3", 8, 4]], LINE);

export type Route = Array<{ hex: string; city_node?: number; bypass?: boolean }>;
export const R = (...hexes: string[]): Route => hexes.map((hex) => ({ hex }));

/** C&O's best two routes for a [2, 3] fleet: the 2-train to the Gulf ($50), the 3-train along the line ($60). */
export const TWO_ROUTE = R("I5", "I3", "J2");
export const THREE_ROUTE = R("I5", "I7", "I9");
/** The whole line for one long train: J2-I3-I5-I7-I9, four revenue centres, $90. */
export const LONG_ROUTE = R("J2", "I3", "I5", "I7", "I9");

export interface Corp {
  id: number;
  president: string | null;
  trains: string[];
  treasury?: number;
  /** Station hexes; the first is the corporation's home. Defaults to its printed home (C&O: I5). */
  tokens?: string[];
  price?: number;
  extra?: Partial<PublicCompanyState>;
}

export interface BoardOptions {
  ur?: boolean;
  gentle?: boolean;
  lpf?: boolean;
  plusTiles?: boolean;
  pinned?: boolean;
  corps: Corp[];
  /** The operating corporation (defaults to the first in `corps`). */
  operating?: number;
  step?: string;
  macro?: number;
  sub?: number;
  sequence?: number;
  round?: "OperatingRound" | "StockRound";
  bank?: number;
  returned?: string[];
  extra?: Partial<GameStateResponse>;
}

/** The home hex a corporation's token sits on in these boards: C&O on I5 (the network), everyone else at home. */
const homeOf = (id: number): string => (id === CO ? "I5" : STATION_HOME_HEXES.find((entry) => entry.companyId === id)!.label);

export function variantsOf(options: Pick<BoardOptions, "ur" | "gentle" | "lpf" | "plusTiles">): GameVariants {
  return resolveVariants({
    unpredictableRevenue: options.ur ?? true,
    gentleRust: options.gentle ?? false,
    levelPlayingField: options.lpf ?? false,
    ...(options.plusTiles ? { plusTiles: true } : {}),
  } as Partial<GameVariants>);
}

export function urBoard(options: BoardOptions): GameStateResponse {
  const order = options.corps.filter((corp) => corp.president !== null).map((corp) => corp.id);
  const operating = options.operating ?? order[0];
  const corp = (spec: Corp): PublicCompanyState => {
    const tokens = spec.tokens ?? [homeOf(spec.id)];
    return {
      company_id: spec.id,
      ticker: TICKER[spec.id],
      is_floated: true,
      treasury: String(spec.treasury ?? 1000),
      total_shares_issued: 10,
      par_value: String(spec.price ?? 100),
      last_route_revenue: "0",
      president: spec.president,
      ipo_pool_percentage: 0,
      bank_pool_percentage: spec.president === null ? 50 : 0,
      player_holdings: spec.president === null ? [] : [{ player: spec.president, percentage: 60 }],
      home_hex_label: tokens[0] ?? homeOf(spec.id),
      station_token_hexes: tokens.map((label) => [at(label).q, at(label).r]),
      station_tokens: tokens.map((label) => [at(label).q, at(label).r, 0]),
      station_token_limit: 4,
      owned_trains: [...spec.trains],
      ...spec.extra,
    } as unknown as PublicCompanyState;
  };
  return {
    game_id: 1,
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: String(options.bank ?? 8000),
    private_companies: [],
    variants: variantsOf(options),
    current_round_type: options.round ?? "OperatingRound",
    macro_round_number: options.macro ?? 3,
    sub_round_index: options.sub ?? 1,
    operating_round_sequence_length: options.sequence ?? 2,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: Math.max(0, order.indexOf(operating)),
    operating_sub_phase: options.step ?? "Routes",
    ...(options.pinned === false ? {} : { rules_engine_version: RULES_ENGINE_VERSION }),
    returned_trains: options.returned ?? [],
    /* ON REAL CHART CELLS (`marketCellForPrice`), one row, distinct prices in listing order unless a case names one --
       the GR-4 harness's rule. A position the chart does not hold is re-derived by a room on its first applied action,
       and that change of atoms would read as "applied" for a message the reducer actually declined (#1685). */
    market_positions: Object.fromEntries(
      options.corps.map((spec, index) => {
        const price = spec.price ?? DEFAULT_PRICES[index % DEFAULT_PRICES.length];
        return [spec.id, { price, ...marketCellForPrice(price)!, enteredAt: index + 1 }];
      }),
    ),
    public_companies: options.corps.map(corp).sort((a, b) => a.company_id - b.company_id),
    ...options.extra,
  } as unknown as GameStateResponse;
}

const m = (msg: unknown) => msg as SandboxLogMsg;

/** A run as the normal UI sends it (#1020 / #1031): routes, trains and fleet slots; the seed is the caller's. */
export function runMsg(
  companyId: number,
  routes: Route[],
  indices: number[] | null,
  models: string[] | null,
  seed?: number,
): SandboxLogMsg {
  return m({
    RunMultipleRoutes: {
      game_id: 1,
      protocol_id: companyId,
      routes,
      ...(models === null ? {} : { trains: models }),
      ...(indices === null ? {} : { train_indices: indices }),
      ...(seed === undefined ? {} : { revenue_seed: seed }),
      payout_strategy: "Withhold",
    },
  });
}
export const signRequest = (companyId: number, extra: Record<string, unknown> = {}) =>
  m({ YellowSignEvent: { game_id: 1, protocol_id: companyId, ...extra } });
export const declare = (companyId: number, amount: number, distribute = false) =>
  m({ DeclareDividends: { game_id: 1, protocol_id: companyId, revenue_amount: String(amount), distribute } });
export const buy = (companyId: number, tier?: string) =>
  m({ BuyHardwareFromPool: { game_id: 1, protocol_id: companyId, ...(tier === undefined ? {} : { model_type: tier }) } });
export const exchange = (companyId: number, model: string) =>
  m({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: companyId, model_type: model } });
export const advance = (companyId: number) => m({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: companyId } });
export const PASS = m({ PassTurn: { game_id: 1 } });

export const partsFor = (turnSeed: number, macroRound = 3, subRound = 1, companyId = CO): RevenueSeedParts => ({
  macroRound,
  subRound,
  companyId,
  turnSeed,
});

/** The first seed from 1 upward that `predicate` accepts. */
export function seedWhere(predicate: (seed: number) => boolean, from = 1): number {
  for (let seed = from; seed < 5_000_000; seed += 1) if (predicate(seed)) return seed;
  throw new Error("no seed satisfies the predicate");
}

/** A natural Mark draw on `printed`: a critical malus (face 1, a real reduction) whose natural line is the Sign's. */
export const isMarkDraw = (printed: number, parts: RevenueSeedParts): boolean => {
  const roll = rollTurnRevenue(printed, parts);
  return flavorBucketFor(roll) === "criticalMalus" && revenueFlavourClause(roll, parts) === YELLOW_SIGN_MALUS_LINE;
};
/** A Carcosa draw on `printed`: a critical bonus (face 6, a real increase) and the 60% roll. */
export const isCarcosaDraw = (printed: number, parts: RevenueSeedParts): boolean =>
  flavorBucketFor(rollTurnRevenue(printed, parts)) === "criticalBonus" && carcosaRollHits(parts);
/** A draw on which no stage could fire: neither the Mark's line nor a critical bonus. */
export const isQuietDraw = (printed: number, parts: RevenueSeedParts): boolean => {
  const roll = rollTurnRevenue(printed, parts);
  return revenueFlavourClause(roll, parts) !== YELLOW_SIGN_MALUS_LINE && flavorBucketFor(roll) !== "criticalBonus";
};

/** The providers a room (or a replay of its log) runs these boards with. The room's engine seeds its market atom from
 *  `initialMarket` (`replayLog.ts`), not from the board -- so the board's own chart travels with it, or the first
 *  applied action would re-derive every position and a message the reducer declined would read as "applied" (#1685's
 *  atoms-unchanged test). A replay or restore of the same log must be handed the same providers. */
export function roomProviders(seed: GameStateResponse, grid: MapGridResponse) {
  return {
    ...sandboxReplayProviders(),
    initialGrid: grid,
    ...(seed.market_positions ? { initialMarket: seed.market_positions } : {}),
  };
}

/** A hosted room over `seed`, on `grid`, whose draws come from `draws` in order (the last one repeats). */
export function hostedRoom(seed: GameStateResponse, grid: MapGridResponse, draws: readonly number[]): RoomSession {
  let minted = 0;
  let drawn = 0;
  return new RoomSession({
    providers: roomProviders(seed, grid),
    seed: { state: seed, waterfall: null },
    build: "ur3",
    mintId: () => `ur3-${(minted += 1)}`,
    now: () => 0,
    mintSeed: () => draws[Math.min(drawn++, draws.length - 1)],
  });
}

export const submitTo = (room: RoomSession, actor: string, msg: SandboxLogMsg) =>
  room.submit({ actor, build: "ur3", host: P1, msg, baseIndex: room.nextIndex - 1 }) as {
    kind: string;
    reason?: string;
    entries?: Array<{ payload: string; derived?: boolean; index: number }>;
  };

export const companyOf = (state: GameStateResponse, id: number): PublicCompanyState =>
  state.public_companies.find((entry) => entry.company_id === id)!;
