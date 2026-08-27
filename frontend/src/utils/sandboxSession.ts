// frontend/src/utils/sandboxSession.ts
//
// The sandbox's local reducer. NOT a rules engine: the CosmWasm contract owns
// every 1830 rule, and nothing here may become a second opinion about one.
//
// It moves only what can move without knowing a rule -- turn pointers, the
// pass streak, the OR cursor, and cash/shares by the amount the CALLER states.
// Every function returns a NEW state object (React identity), and it is driven
// by the real GameplayExecuteMsg union so a new variant cannot bypass it.
//
// Charter and full history: docs/ai_architecture/sandbox_reducer.md
// -- sandboxSession.ts #0, #1, #2

import type {
  GameStateResponse,
  RoundType,
  TileColor,
  WaterfallMiniAuctionStatus,
  WaterfallPrivateStatus,
  WaterfallStateResponse,
} from "./gameState";
// Design note #723: the terrain fee is charged on the FIRST build of a hex and never again.
import { terrainFeeDue, withTerrainPaid } from "./terrainFee";
// Design note #736: which arriving tier closes the private companies.
import { closesPrivateCompanies } from "./depotSchedule";
// actingSeatIndex lives in gameState.ts, not here: it asks about CONTRACT state and the
// live dashboard needs it too. See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { TILE_CATALOG_BY_ID, type TileColorTier } from "../components/hexTileCatalog";
import { archetypeForHex, hexValueForEra } from "../components/hexGeometry";
import { depotInventory, derivePhase, type GamePhase } from "./gamePhase";
// Design note #712: the market-zone purchase rules, shared with the Stock Round panel.
import { sharePurchaseBlock, type PriceZone } from "./sharePurchase";
import { hasActedThisTurn } from "./turnAction";
import { roundEndSoldOutRises } from "./soldOutRise";
import { shareSaleBlock } from "./shareSale";
import { metFloatThreshold, FULL_CAPITALISATION_MULTIPLE } from "./floatThreshold";
// Design note #763: a float is not finished until its home token is on the board.
import { homeTokenBlock } from "./homeTokenGate";
import { dividendRefusal } from "./dividendGate";
import { dividendSplit } from "./dividendSplit";
import { layEndsTrackStep } from "./bonusLay";
import { stationTokenPrice } from "./stationTokens";
// Design note #660: the B&O private's two rules, in one place.
import { isSellableToCorporation, settleBaoPrivate } from "./baltimorePrivate";
// Design note #656: the cursor's rules, in a module the reducer can reach.
import {
  nextSubPhase,
  openingSubPhase,
  settleSubPhase,
  type OperatingSubPhase,
} from "./operatingCursor";
// Design note #596: the president's certificate changes hands.
import { settlePresidencies } from "./presidencyTransfer";
import type { SandboxMarketMark, SandboxMarketPrices } from "./sandboxState";
// Design note #646: every marker landing is stamped with its arrival here,
// so the operating-order tie-break has a history to read.
import { withArrival } from "./sandboxState";
import {
  OFFBOARD_LABELS,
  OFFBOARD_REVENUE,
  STATIC_BOARD_HEXES,
  offboardValueForEra,
  terrainBuildFeeAt,
} from "../components/hexBoardData";

/** A nominal share price, applied so a `BuyStock`/`SellStock` visibly moves
 *  the cash column. NOT a computed price -- see design note 0. The real
 *  figure depends on par value, market position and whether the purchase is
 *  the 20% President's Certificate, none of which this file knows. */
export const SANDBOX_NOMINAL_SHARE_PRICE = 67;

/** A nominal train cost, same reasoning as the share price above. */
export const SANDBOX_NOMINAL_TRAIN_COST = 80;

/* SANDBOX_NOMINAL_TILE_COST deleted: the fee belongs to the GROUND (terrainBuildFeeAt), not the tile.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #432 */

/** A nominal station-token / private-purchase cost. */
export const SANDBOX_NOMINAL_TOKEN_COST = 40;

/** One certificate, as a percentage of the corporation. 1830's ordinary
 *  share is 10%; the President's 20% double certificate is a rule this
 *  reducer does not model and the contract does. */
export const SANDBOX_SHARE_PERCENTAGE = 10;

/** Design note #351: the President's Certificate is a DOUBLE share -- 20%
 *  of the company, for twice par. Named rather than written as `10 * 2` so
 *  the two places that need it (the equity moved, and the certificate count
 *  the ledger derives) cannot drift apart. */
export const SANDBOX_PRESIDENT_PERCENTAGE = 20;

/** What a full round of passes knocks off the cheapest private -- design
 *  note #271. `auction::MIN_BID_INCREMENT`'s own $5 step, reused because the
 *  markdown and the bid increment are the same unit of money in this
 *  auction and two different literals would drift. */
export const WATERFALL_PASS_MARKDOWN = 5;

/** A nominal figure for what one route earns, so the Operating Round table's
 *  revenue column visibly fills in. Not a traced route value -- real revenue
 *  comes from `pathfinding.rs`'s search over actual laid track. */
export const SANDBOX_NOMINAL_ROUTE_REVENUE = 90;

/** Cash is a decimal string on the wire; parse, adjust, re-serialise, floor at zero.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
function adjustCash(
  state: GameStateResponse,
  player: string,
  delta: number,
): GameStateResponse {
  return {
    ...state,
    player_cash: state.player_cash.map((entry) => {
      if (entry.player !== player) return entry;
      const current = Number(entry.cash_vgp);
      const next = Number.isFinite(current) ? Math.max(0, current + delta) : 0;
      return { ...entry, cash_vgp: String(next) };
    }),
  };
}

/** Adds `delta` to the bank's cash, flooring at zero. */
function adjustBank(state: GameStateResponse, delta: number): GameStateResponse {
  const current = Number(state.virtual_bank_vgp);
  const next = Number.isFinite(current) ? Math.max(0, current + delta) : 0;
  return { ...state, virtual_bank_vgp: String(next) };
}

/** Corporate treasury, same string arithmetic and same zero floor as adjustCash.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
function adjustTreasury(
  state: GameStateResponse,
  companyId: number,
  delta: number,
): GameStateResponse {
  return {
    ...state,
    public_companies: state.public_companies.map((company) => {
      if (company.company_id !== companyId) return company;
      const current = Number(company.treasury);
      const next = Number.isFinite(current) ? Math.max(0, current + delta) : 0;
      return { ...company, treasury: String(next) };
    }),
  };
}

/** Advance the seat and clear the pass streak -- mirrors trading::advance_turn.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
function advanceSeat(state: GameStateResponse): GameStateResponse {
  const count = state.player_addresses.length;
  if (count === 0) return state;
  return {
    ...state,
    active_player_index: (state.active_player_index + 1) % count,
    consecutive_passes: 0,
    /* Design note #745: the flag is about THE TURN NOW IN PROGRESS, so it dies with the turn. Cleared in both
       seat-moving functions rather than in the arms that call them -- an arm can be added, and the next one
       will inherit this without its author knowing the flag exists. */
    turn_action_taken: false,
  };
}

/* The OR queue is BUILT where the round begins, ordered by market price descending, floated-with-a-president only. Nothing used to fill it, which is the infinite round.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
export function buildOperatingOrder(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  /* The whole mark, not a growing list of scalars -- rule (iii) needs the column too. priceFor stays separate because #468's fallback reaches past the chart.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #647 */
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
): number[] {
  /* Fall back to PAR, never zero, and coerce NaN: a comparator that returns NaN yields an order that is not total, which puts the cursor back on a corporation that already operated.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #468 */
  const priced = state.public_companies
    .filter((company) => company.is_floated && !!company.president)
    .map((company) => {
      const fromMarket = priceFor?.(company.company_id);
      const fromPar = Number(company.par_value ?? 0);
      const price = Number.isFinite(fromMarket as number)
        ? (fromMarket as number)
        : Number.isFinite(fromPar)
          ? fromPar
          : 0;
      /* Infinity for an unrecorded arrival sorts it after every recorded one rather than inventing a turn order.
         See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #646 */
      const mark = markFor?.(company.company_id) ?? null;
      const arrival = mark?.enteredAt;
      return {
        companyId: company.company_id,
        price,
        /* -Infinity sorts a positionless corporation last under the rightmost-first rule, matching #646's direction.
           See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #647 */
        column: Number.isFinite(mark?.x as number) ? (mark?.x as number) : -Infinity,
        arrival: Number.isFinite(arrival as number) ? (arrival as number) : Infinity,
      };
    });

  /* Three disjoint levels: price desc, then column desc (rightmost first, #647), then arrival asc (earliest first). company_id is the last resort and keeps the sort TOTAL.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #646 */
  priced.sort(
    (a, b) =>
      (b.price - a.price) ||
      (b.column - a.column) ||
      (a.arrival - b.arrival) ||
      (a.companyId - b.companyId),
  );
  return priced.map((entry) => entry.companyId);
}

/** Keep the seat pointer in step during an OR so actingSeatIndex and the raw pointer agree. Left untouched when the presidency cannot be resolved.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
function syncSeatToActingCorporation(state: GameStateResponse): GameStateResponse {
  const companyId = state.active_operating_order[state.active_corporation_index];
  if (companyId === undefined) return state;
  const president = state.public_companies.find(
    (company) => company.company_id === companyId,
  )?.president;
  if (!president) return state;
  const seat = state.player_addresses.indexOf(president);
  if (seat === -1 || seat === state.active_player_index) return state;
  return { ...state, active_player_index: seat };
}

/* 1830's OR counts by phase: Yellow 1, Green 2, Brown 3. Derived from the TRAINS in play, not from current_global_era. null yields 1 -- the safe direction.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #431 */
export function operatingRoundsForPhase(phase: GamePhase | null): number {
  switch (phase?.tint) {
    case "green":
      return 2;
    case "brown":
      return 3;
    case "yellow":
    default:
      return 1;
  }
}

/** Exported because two callers need it; a second hand-written copy is how the queue came to be built by neither of them.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
export function beginOperatingRound(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  /** Design note #646: the arrival lookup the tie-break reads. */
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
  /* The sequence length is stamped ONCE when a cycle opens; a mid-cycle phase change takes effect next cycle. continuingSequence tells the two callers apart.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #511 */
  continuingSequence = false,
): GameStateResponse {
  const order = buildOperatingOrder(state, priceFor, markFor);
  return syncSeatToActingCorporation({
    ...state,
    current_round_type: "OperatingRound",
    active_operating_order: order,
    active_corporation_index: 0,
    consecutive_passes: 0,
    operating_round_just_ended: false,
    /* Written, not read -- the fixtures hardcoded 2 and nothing ever set it. #511: stamped once per cycle.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #431 */
    operating_round_sequence_length: continuingSequence
      ? operatingRoundSequenceLength(state)
      : operatingRoundsForPhase(derivePhase(state)),
    /* sub_round_index is stamped here too. Nobody wrote it, so every phase ran exactly one extra round. All three opening values are now written together.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #621 */
    ...(continuingSequence ? {} : { sub_round_index: 1 }),
  });
}

/** Falls back to the phase's count for an absent or nonsensical field; Math.max(1, ...) so a stored zero can never end a cycle before it runs.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #511 */
export function operatingRoundSequenceLength(state: GameStateResponse): number {
  const stored = Number(state.operating_round_sequence_length);
  if (!Number.isFinite(stored) || stored < 1) {
    return operatingRoundsForPhase(derivePhase(state));
  }
  return Math.max(1, Math.floor(stored));
}

/** Wrap is an EVENT, not a loop: run the queue again if the locked sequence has another round in it, otherwise raise the flag. A cycling queue is a round with no exit.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #431 */
function advanceCorporation(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  // Design note #646: carried through so a rebuilt queue keeps the tie-break.
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
): GameStateResponse {
  /* An empty queue is RECOVERED by rebuilding it, not tolerated by returning unchanged -- that was the infinite round in one line.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
  if (state.active_operating_order.length === 0) {
    const rebuilt = beginOperatingRound(state, priceFor, markFor);
    return rebuilt.active_operating_order.length > 0
      ? rebuilt
      : { ...state, operating_round_just_ended: true };
  }

  const next = state.active_corporation_index + 1;
  if (next < state.active_operating_order.length) {
    return syncSeatToActingCorporation({ ...state, active_corporation_index: next });
  }

  /* The LOCKED value decides, not a live re-derivation: a 3-train bought mid-cycle must not turn a one-round Yellow cycle into a two-round Green one.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #511 */
  const sequenceLength = operatingRoundSequenceLength(state);
  if (state.sub_round_index < sequenceLength) {
    return syncSeatToActingCorporation({
      /* `true`: this is the SECOND round of an existing cycle, so it keeps
         the cycle's locked count rather than re-deriving from a phase that
         may have moved. */
      ...beginOperatingRound(state, priceFor, markFor, true),
      sub_round_index: state.sub_round_index + 1,
    });
  }

  return { ...state, operating_round_just_ended: true };
}

/* Priority Deal goes to the seat LEFT of the last trader; nothing in GameStateResponse records that, so it is kept ON THE STATE (an undo snapshot copies state, a module variable would survive it).
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #352 */
function markTrader(state: GameStateResponse, actor: string | null): GameStateResponse {
  if (!actor) return state;
  const index = state.player_addresses.indexOf(actor);
  return index === -1 ? state : { ...state, last_trader_index: index };
}

/** The Stock Round now actually ends: Priority Deal moves and the next player is seated. The sold-out rise and lockout clearing stay with market.rs/trading.rs -- those are rules about VALUE, this is pacing.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #353 */
function recordPass(state: GameStateResponse): GameStateResponse {
  const count = state.player_addresses.length;
  if (count === 0) return state;

  const streak = state.consecutive_passes + 1;
  const advanced: GameStateResponse = {
    ...state,
    active_player_index: (state.active_player_index + 1) % count,
    consecutive_passes: streak,
    // Design note #745: this moves the seat too, so it clears the turn flag on the same rule as `advanceSeat`.
    turn_action_taken: false,
  };

  if (streak < count) return advanced;

  // A full round of passes. In the auction this runs the waterfall (the
  // `WaterfallPass` arm handles it before reaching here); in a Stock Round
  // it ends the round.
  if (state.current_round_type !== "StockRound") {
    return { ...advanced, consecutive_passes: 0 };
  }

  /* Left of the last trader is the direction advanceSeat moves. Nobody traded means nothing to reorder.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #352 */
  const priority =
    state.last_trader_index === null || state.last_trader_index === undefined
      ? state.priority_deal_index
      : (state.last_trader_index + 1) % count;

  return {
    ...advanced,
    consecutive_passes: 0,
    priority_deal_index: priority,
    // The Priority Deal holder opens the next round, which is what makes it
    // worth holding.
    active_player_index: priority,
    last_trader_index: null,
    stock_round_just_ended: true,
  };
}

/** Applies one message; unknown variants fall through to the turn-advancing default. Route revenue TOTALS printed stop values -- it checks no connectivity, distance or token rule.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
const HEX_COORDS_BY_LABEL: ReadonlyMap<string, { q: number; r: number }> = new Map(
  STATIC_BOARD_HEXES.map((hex) => [hex.label, { q: hex.q, r: hex.r }]),
);

/* Price a hex through hexGeometry.hexRouteValue, the board's own answer. A third private copy scored preprinted gray hexes at $0 and let revenue:"0" short-circuit the printed value.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #190 */

/** A route runs between two CITIES (or off-board reds); towns are passed through. archetypeForHex asks what the hex IS rather than what it pays.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #264 */
export function isRevenueCentreHex(mapGrid: MapGridResponse, hexLabel: string): boolean {
  if (OFFBOARD_LABELS[hexLabel]) return true;
  const coords = HEX_COORDS_BY_LABEL.get(hexLabel);
  if (!coords) return false;
  const archetype = archetypeForHex(mapGrid, coords.q, coords.r);
  return archetype !== "Plain";
}

export function isRouteTerminusHex(mapGrid: MapGridResponse, hexLabel: string): boolean {
  if (OFFBOARD_LABELS[hexLabel]) return true;
  const coords = HEX_COORDS_BY_LABEL.get(hexLabel);
  if (!coords) return false;
  const archetype = archetypeForHex(mapGrid, coords.q, coords.r);
  return archetype === "SingleCity" || archetype === "DoubleCity";
}

export function hexStopValue(
  mapGrid: MapGridResponse,
  hexLabel: string,
  era: TileColorTier,
): number {
  /* Design note #741: DELEGATED. This function used to hold the ladder -- chain revenue, then catalog revenue,
     then the printed override, then the board's own answer -- and the hex TOOLTIP held a shorter one that
     stopped at the terrain category. Reported as the tooltip not updating when a tile was laid.
     The ladder moved down into `hexGeometry`, where every table it consults already lives and where the
     tooltip can reach it: this file imports FROM `components/`, so the tooltip could never have imported from
     here without a cycle. What is left is the label-to-coordinate lookup, which is this module's own concern.
     ONE FUNCTION, ONE ANSWER -- the specific failure this codebase keeps finding, closed for hex values. */
  const coords = HEX_COORDS_BY_LABEL.get(hexLabel);
  if (!coords) {
    /* An unknown label may still be an off-board terminal: those are keyed by NAME in `OFFBOARD_REVENUE` and
       need no coordinates. Asked here rather than inside the ladder so the ladder can stay coordinate-based. */
    const offboard = OFFBOARD_LABELS[hexLabel];
    const tiers = offboard ? OFFBOARD_REVENUE[offboard] : undefined;
    return tiers ? offboardValueForEra(tiers, era) : 0;
  }
  return hexValueForEra(mapGrid, coords.q, coords.r, era);
}

/* An N-train visits N REVENUE CENTRES and may cross any amount of plain track. The old code compared against hop count, the classic 18xx misreading.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #156 */
export interface SandboxRouteBreakdown {
  /** Total printed value of the distinct stops. */
  revenue: number;
  /** Distinct stops that actually PAY -- the figure a train's number caps.
   *  Mirrors `pathfinding.rs`'s `is_revenue_centre: !value.is_zero()`. */
  centres: number;
  /** Distinct hexes touched, paying or not. Reported alongside because it
   *  is what a player sees themselves clicking, and showing only the centre
   *  count would look like the app had lost track of half their route. */
  hexes: number;
  /* Stops carry their own figures in route order, so the arithmetic is on screen. Deduplicated exactly as revenue is, so the list always sums to it.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #274 */
  stops: ReadonlyArray<{ hex: string; value: number }>;
}

/** One walk, three figures -- see design note #156. */
export function sandboxRouteBreakdown(
  mapGrid: MapGridResponse,
  path: readonly { hex: string; city_node?: number; bypass?: boolean }[],
  era: TileColorTier,
): SandboxRouteBreakdown {
  // Deduplicated by hex: 1830 prices a hex once per pass however many times
  // a route touches it, which is the same single-visit rule `hexmap.rs`'s
  // `terrain_base_value` note gives for double towns and double cities.
  const seen = new Set<string>();
  const stops: { hex: string; value: number }[] = [];
  let revenue = 0;
  for (const stop of path) {
    if (seen.has(stop.hex)) continue;
    seen.add(stop.hex);

    /* ==================================================================
     *  DESIGN NOTE 737: A BYPASS PAYS NOTHING AND COSTS NO STOP
     * ==================================================================
     *
     * REPORTED of Altoona: "there seems to be no way to get a train to use the bypass around Altoona's measly
     * $10 revenue center."
     *
     * THE ROUTER COULD NOT FIND IT AND THIS FUNCTION COULD NOT PRICE IT, and the second half is the one that
     * made the first pointless to fix alone. Revenue was computed from a list of HEX LABELS: a route said
     * which hexes it touched and nothing about HOW, so a train crossing H12 on the bow was indistinguishable
     * from one stopping at the station. The bypass was not merely unrouted, it was inexpressible.
     *
     * `variant` IS THAT MISSING WORD. It names which authored rail chain the route took through this hex, and
     * a chain that never reaches the marker earns nothing there -- which is the entire point of the bow on
     * cardboard.
     *
     * AND IT COSTS NO STOP EITHER, which matters more than the $10: a 2-train that had to spend one of its two
     * stops on Altoona could not reach past it. Skipping the `stops.push` below is what makes the bypass worth
     * having. */
    /* A FLAG, NOT A RE-DERIVATION. The first draft of this tried to recover the rail chain from the hex label
       here, and could not: a stop knows WHICH hex, never which edges the route entered and left by. The tracer
       does know -- it chose the variant -- so the answer travels with the stop. Recomputing a fact at a point
       that has lost the inputs is how a second, disagreeing answer gets invented. */
    if (stop.bypass === true) continue;

    revenue += hexStopValue(mapGrid, stop.hex, era);
    /* Count the ARCHETYPE, not the value: fourteen printed cities and seven towns pay $0 until a tile is laid, and a $0 city still costs a train a stop.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #289 */
    const centre = isRevenueCentreHex(mapGrid, stop.hex);
    if (centre) stops.push({ hex: stop.hex, value: hexStopValue(mapGrid, stop.hex, era) });
  }
  return { revenue, centres: stops.length, hexes: seen.size, stops };
}

/** Total the selected stops. Exported for the route value readout, which
 *  previews the figure before anything is dispatched. */
export function sandboxRouteRevenue(
  mapGrid: MapGridResponse,
  path: readonly { hex: string; city_node?: number }[],
  era: TileColorTier,
): number {
  return sandboxRouteBreakdown(mapGrid, path, era).revenue;
}

/** Optional board context. Only RunManualRoute reads it, and only to total printed stop values.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
export interface SandboxActionContext {
  /* The author travels WITH the action. Resolving it from the local turn cursor made the reducer a function of local state rather than of the log -- a silent per-client divergence.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #549 */
  actor?: string | null;
  mapGrid?: MapGridResponse;
  /* `resetRouteRevenue` REMOVED by design note #777, and it is worth recording WHY rather than deleting
     quietly: it was a dispatch-time option meant to zero `last_route_revenue` on a turn's first route
     message, and `appendSandboxAction` writes only the message into the log -- so no replay ever saw it, and
     every client applies by replaying. An option the authority can never receive is worse than no option:
     it reads at the call site as a rule that is being enforced. The zeroing is a turn-change event now. */
  /** Scales red off-board terminals, whose value rises with the era. */
  era?: TileColorTier;
  /** Market price injected by the caller: the chart is a separate atom this reducer must not reach into. Omitted falls back to par.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
  marketPriceFor?: (companyId: number) => number | null;
  /** Design note #646: when a corporation's marker reached its current cell,
   *  for the operating-order tie-break. Travels beside the price for the same
   *  reason the price does -- the chart is a separate atom the reducer must
   *  not reach into. */
  /* Design note #746a: WIDENED TO THE WHOLE MARK. It was declared `{x, y, enteredAt?}` while every caller
     already returned a `SandboxMarketMark` -- the `price` was being passed and thrown away by the type. The
     sold-out rise needs it, to report what a token rose FROM. */
  marketMarkFor?: (companyId: number) => SandboxMarketMark | null | undefined;
  /** Design note #746a: `projectRiseMove`, injected on #7's rule -- `utils/` may not import the chart, and
   *  the chart is where the cells live. Absent means no rise is computed, which is the honest answer for a
   *  caller with no market. */
  projectRise?: (
    from: SandboxMarketMark,
  ) => { x: number; y: number; price: number } | null | undefined;
  /** Design note #757: whether this tile at this rotation is an ILLEGAL placement, injected on #7's rule --
   *  the legality engine lives in `components/` and `utils/` may not import it.
   *
   *  Absent means "no opinion", which is the honest answer for a caller with no board rules to hand and the
   *  reason this cannot make an existing test stricter by accident. */
  layRefused?: (q: number, r: number, tileId: number, orientation: number) => boolean;
  /** Share price injected for the same reason (#272). Omitted falls back to the flat nominal.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273 */
  sharePrice?: number;
  /** Design note #351: the par ladder's current selection, for the founding
   *  purchase that sets it. Ignored on every other buy -- once
   *  `par_value` is set the company has a price and the ladder is locked. */
  parValue?: number;
  /** Design note #363: resolves a home hex label to `(q, r)`. Injected --
   *  the board table lives in `components/`, which `utils/` must not
   *  import. Omitted, corporations still float without their token. */
  homeHexToAxial?: (label: string) => readonly [number, number] | null;
  /** Design note #712: the market-zone rules, injected for the same reason the price is -- the price-to-zone
   *  table lives in `components/` and this module may not import it.
   *  OMITTED MEANS UNENFORCED, deliberately: a caller with no chart cannot tell a Normal price from an Orange
   *  one, and guessing would either forbid a legal purchase or wave an illegal one through. Every live path
   *  supplies it; the fixtures that do not are exercising other rules. */
  marketZoneFor?: (companyId: number) => PriceZone;
  /** Live prices per company, for the certificate limit's zone exemption. */
  marketPricesByCompany?: Readonly<Record<number, number | null>> | null;
  zoneForPrice?: (price: number | null | undefined) => string | null;
}

/** Pure bookkeeping: clamps the pool at zero rather than validating, because refusing would be enforcing a rule.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
function moveShares(
  state: GameStateResponse,
  companyId: number,
  holder: string | null,
  pool: "Ipo" | "Bank",
  percentage: number,
): GameStateResponse {
  return {
    ...state,
    public_companies: state.public_companies.map((company) => {
      if (company.company_id !== companyId) return company;
      const key = pool === "Bank" ? "bank_pool_percentage" : "ipo_pool_percentage";
      const available = company[key];
      // Taking more than exists is capped to what exists; returning shares
      // (negative) is never capped.
      const moved = percentage > 0 ? Math.min(percentage, available) : percentage;
      if (moved === 0) return company;

      const holdings = [...company.player_holdings];
      if (holder) {
        const index = holdings.findIndex((entry) => entry.player === holder);
        if (index >= 0) {
          const next = holdings[index].percentage + moved;
          if (next <= 0) holdings.splice(index, 1);
          else holdings[index] = { ...holdings[index], percentage: next };
        } else if (moved > 0) {
          holdings.push({ player: holder, percentage: moved });
        }
      }

      return {
        ...company,
        [key]: available - moved,
        player_holdings: holdings,
        // Kept consistent with the holdings so the Ledger's own totals add
        // up; the contract derives this the same way.
        total_shares_issued: Math.max(
          0,
          company.total_shares_issued + (pool === "Ipo" ? moved / SANDBOX_SHARE_PERCENTAGE : 0),
        ),
      };
    }),
  };
}

/** Rewrites one corporation's `owned_trains`. Pure plumbing behind the two
 *  train helpers below, so neither has to restate the map. */
function withTrains(
  state: GameStateResponse,
  companyId: number,
  next: (trains: readonly string[]) => string[],
): GameStateResponse {
  return {
    ...state,
    public_companies: state.public_companies.map((company) =>
      company.company_id === companyId
        ? { ...company, owned_trains: next(company.owned_trains ?? []) }
        : company,
    ),
  };
}

/* A bank purchase must consume depot stock and charge the real tier price -- depotInventory derives remaining stock from what corporations OWN, so a purchase adding no train froze the supply.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #194 */

/** Rust order, cheapest first -- the discard preference too. */
const TIER_SEQUENCE: readonly string[] = ["2", "3", "4", "5", "6", "D"];

const TIER_COST: Readonly<Record<string, number>> = {
  "2": 80, "3": 180, "4": 300, "5": 450, "6": 630, D: 1_100,
};

/** Inverted from gamePhase.ts's RUSTED_BY rather than restated -- a second copy is a second thing to keep in step with 1830.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #284 */
function tiersRustedBy(tier: string): string[] {
  const rusted: string[] = [];
  for (const candidate of TIER_SEQUENCE) {
    if (RUSTS_ON[candidate] === tier) rusted.push(candidate);
  }
  return rusted;
}

/** `gamePhase.ts`'s `RUSTED_BY`, mirrored -- see `tiersRustedBy`. */
const RUSTS_ON: Readonly<Record<string, string | undefined>> = {
  "2": "4",
  "3": "6",
  "4": "D",
};

/** The train limit once `tier` is the phase -- `TIER_PRESENTATION`'s own
 *  figures, which `depotInventory` already reports per tier. */
function limitForTier(state: GameStateResponse, tier: string): number {
  return depotInventory(state).find((row) => row.tier === tier)?.trainLimit ?? Infinity;
}

/** Applies a phase change's consequences; unchanged state when the purchase triggers nothing.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #284 */
export function applyPhaseChange(
  state: GameStateResponse,
  arrivingTier: string,
): GameStateResponse {
  const doomed = new Set(tiersRustedBy(arrivingTier));
  const limit = limitForTier(state, arrivingTier);

  let changed = false;
  const companies = state.public_companies.map((company) => {
    const owned = company.owned_trains;
    // `undefined` means the chain does not report rosters. Trimming a fleet
    // this build cannot see would invent one.
    if (owned == null) return company;

    // 1. Rust.
    let fleet = doomed.size === 0 ? [...owned] : owned.filter((model) => !doomed.has(model));

    // 2. Trim, cheapest first.
    if (Number.isFinite(limit) && fleet.length > limit) {
      const byValue = [...fleet].sort(
        (a, b) => (TIER_COST[a] ?? 0) - (TIER_COST[b] ?? 0),
      );
      const discard = byValue.slice(0, fleet.length - limit);
      for (const model of discard) {
        const at = fleet.indexOf(model);
        if (at >= 0) fleet.splice(at, 1);
      }
    }

    if (fleet.length === owned.length) return company;
    changed = true;
    return { ...company, owned_trains: fleet };
  });

  /* ==================================================================
   *  DESIGN NOTE 736: PHASE 5 CLOSES THE PRIVATES, IN CODE
   * ==================================================================
   *
   * REPORTED: "a 5-train has been purchased, but ... the private companies are still displayed (and counting
   * toward certificates) ... moreover, the private companies are still paying out to players. We need to
   * enforce the closure in code, not just design diary notes."
   *
   * TEN READERS, NO WRITER. `closed` is consulted correctly all over this codebase -- `applyPrivateRevenue`
   * skips a closed private, `PrivateTradePanel` hides it, `PrivatePowerPanel` greys it, `activeReservations`
   * drops its hex badge -- and not one line anywhere ever set it. The rule lived in a caption and a schedule
   * entry, which is exactly the failure this project keeps finding, in its purest form yet: every consumer
   * right, the producer missing.
   *
   * HERE, BECAUSE THIS IS WHERE THE PHASE TURNS. The alternative was a `BuyHardwareFromPool` arm, and it would
   * have been wrong twice over -- `EmergencyBuyHardware` buys trains too, and a phase reached by any other
   * route would skip the closure. `applyPhaseChange` is called for the arriving tier however it arrived, and
   * it already owns the other two consequences of a phase turning (rust, then trim). Closure is the third.
   *
   * IDEMPOTENT, which matters because the Undo path replays the whole log: closing an already-closed private
   * changes nothing, so a rebuild produces the same state as the play did. */
  const closesPrivates = closesPrivateCompanies(arrivingTier);
  const privates = closesPrivates
    ? state.private_companies.map((priv) => (priv.closed ? priv : { ...priv, closed: true }))
    : state.private_companies;
  const privatesChanged =
    closesPrivates && privates.some((priv, at) => priv !== state.private_companies[at]);

  if (!changed && !privatesChanged) return state;
  return {
    ...state,
    ...(changed ? { public_companies: companies } : {}),
    ...(privatesChanged ? { private_companies: privates } : {}),
  };
}

/** Every private company closed by the arriving tier, for the Activity Log.
 *
 *  Design note #736: SAID OUT LOUD. A player's income silently dropping is the kind of change that reads as a
 *  bug -- and this one takes a certificate off their limit too, which they will notice three turns later and
 *  misattribute. Named separately from the closure so `applyPhaseChange` stays a pure state function and the
 *  shell does the narrating, per #400/#685. */
export function describePrivateClosures(
  before: GameStateResponse,
  after: GameStateResponse,
): string[] {
  const names: string[] = [];
  for (const priv of after.private_companies) {
    if (!priv.closed) continue;
    const was = before.private_companies.find((entry) => entry.private_id === priv.private_id);
    if (was && !was.closed) names.push(priv.name);
  }
  return names;
}

/** What one corporation lost when the phase turned. */
export interface FleetLoss {
  companyId: number;
  ticker: string;
  /** Destroyed by the arriving tier -- 2s on the first 4, 3s on the first 6, 4s on the first Diesel. */
  rusted: readonly string[];
  /** Returned to bring the fleet under the new, lower train limit. Cheapest first. */
  discarded: readonly string[];
}

/** Reads back what `applyPhaseChange` took, by comparing the fleets it rewrote.
 *
 *  Design note #704: THE REDUCER SETTLES, THE SHELL NARRATES -- #400's division, and the same one #685 used
 *  for private revenue. `applyPhaseChange` has trimmed over-limit fleets cheapest-first since #284 and has
 *  never said so: the trains simply left the corporation's chips between one render and the next.
 *
 *  THAT SILENCE ONLY JUST BECAME REACHABLE. Until #703 the Buy Trains panel REFUSED the purchase that would
 *  leave a corporation over the new limit, so the trim ran for bystanders and almost never for the buyer. #703
 *  corrected the rule; this is the consequence that was hiding behind it.
 *
 *  AND IT IS THE BUG FROM #702 MADE REAL. That report was "I actually thought the 3-train purchase had been
 *  swapped out with it because it is so hard to see" -- a misreading, then. A president who buys a 4-train and
 *  finds two chips where three were is now reading correctly, and deserves to be told which train went and
 *  why.
 *
 *  DERIVED RATHER THAN RETURNED, so `applyPhaseChange` stays a pure state -> state function and the sentence
 *  cannot be built for a transition that did not happen. A model that left is a RUST when the arriving tier is
 *  the one that kills it, and a DISCARD otherwise -- re-derived from `RUSTS_ON`, which is the same table the
 *  trim itself consulted. */
export function describeFleetLosses(
  before: GameStateResponse,
  after: GameStateResponse,
): FleetLoss[] {
  const arrivingTier = derivePhase(after)?.tier ?? null;
  const losses: FleetLoss[] = [];

  for (const company of after.public_companies) {
    const was = before.public_companies.find((entry) => entry.company_id === company.company_id);
    const had = was?.owned_trains;
    const has = company.owned_trains;
    // `undefined` on either side is "the chain did not say", never "owns nothing" -- the distinction #232
    // makes, and inventing a loss from it would report trains that were never there.
    if (had == null || has == null) continue;

    /* Multiset difference, not a set one: two 3-trains are two trains, and a corporation that loses one of
       them still holds the other. Splicing from a copy is what keeps the count right. */
    const remaining = [...has];
    const lost: string[] = [];
    for (const model of had) {
      const at = remaining.indexOf(model);
      if (at >= 0) remaining.splice(at, 1);
      else lost.push(model);
    }
    if (lost.length === 0) continue;

    const rusted: string[] = [];
    const discarded: string[] = [];
    for (const model of lost) {
      if (arrivingTier !== null && RUSTS_ON[model] === arrivingTier) rusted.push(model);
      else discarded.push(model);
    }
    losses.push({ companyId: company.company_id, ticker: company.ticker, rusted, discarded });
  }

  return losses;
}

/** One sentence per corporation, or `null` when it lost nothing worth a line. */
export function describeFleetLoss(loss: FleetLoss, trainLimit: number | null): string | null {
  const parts: string[] = [];
  if (loss.rusted.length > 0) {
    parts.push(`${namedTrains(loss.rusted)} rusted`);
  }
  if (loss.discarded.length > 0) {
    /* THE LIMIT IS NAMED, because "discarded its 2-train" without it reads as a choice the president made.
       It is not a choice -- 1830 takes the train, and the only latitude is which one, which is why the rule
       (cheapest first) is stated too. */
    const ceiling = trainLimit === null ? "the new train limit" : `the new limit of ${trainLimit}`;
    parts.push(
      `${namedTrains(loss.discarded)} ${loss.discarded.length === 1 ? "was" : "were"} discarded to meet ${ceiling}`,
    );
  }
  if (parts.length === 0) return null;
  return `${loss.ticker}: ${parts.join(", and ")}.`;
}

/** "its 2-train", "its 3-train and 3-train" -- the tier spelled as players say it (#696). */
function namedTrains(models: readonly string[]): string {
  const named = models.map((model) => `${model}-train`);
  if (named.length === 1) return `its ${named[0]}`;
  if (named.length === 2) return `its ${named[0]} and ${named[1]}`;
  return `its ${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

function buyDepotTrain(state: GameStateResponse, companyId: number): GameStateResponse {
  const tier = depotInventory(state).find(
    (row) => row.remaining === null || row.remaining > 0,
  );
  // An empty depot is not an error to throw at a sandbox tester; it is a
  // purchase with nothing to buy, so nothing moves.
  if (!tier) return state;
  const charged = adjustTreasury(state, companyId, -tier.cost);
  const banked = adjustBank(charged, tier.cost);
  const before = derivePhase(state)?.tier ?? null;
  const delivered = withTrains(banked, companyId, (trains) => [...trains, tier.tier]);
  const after = derivePhase(delivered)?.tier ?? null;

  /* Fires only on the purchase that CHANGES the phase. Applying it to every purchase deadlocked the sandbox, because trimming a fleet returns trains to a depot derived from what is owned.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #284 */
  return after !== null && after !== before ? applyPhaseChange(delivered, after) : delivered;
}

/** Moves one train and the price the other way. Exported so the consent flow settles a trade the same way the reducer does. Absent model is a no-op, not a throw.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #191 */
export function settleTrainSale(
  state: GameStateResponse,
  buyerId: number,
  sellerId: number,
  modelType: string,
  price: string,
): GameStateResponse {
  const seller = state.public_companies.find((entry) => entry.company_id === sellerId);
  const index = (seller?.owned_trains ?? []).indexOf(modelType);
  if (index < 0) return state;

  const paid = Number(price);
  const amount = Number.isFinite(paid) && paid > 0 ? paid : 0;

  const removed = withTrains(state, sellerId, (trains) => {
    const next = [...trains];
    next.splice(index, 1);
    return next;
  });
  const added = withTrains(removed, buyerId, (trains) => [...trains, modelType]);
  // Corporation to corporation: the bank is not involved, so this is one
  // debit and one matching credit rather than a mint.
  return adjustTreasury(adjustTreasury(added, buyerId, -amount), sellerId, amount);
}

/* A reducer over the auction's own response shape, with the same charter: pointers, counters and lists, no rules. The cash side is RETURNED for the caller to apply -- one state change per atom.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #261 */
export interface SandboxWaterfallResult {
  waterfall: WaterfallStateResponse;
  /* Charges are a LIST of (player, amount): a cascade settles several privates and the auto-awarded ones are charged to the lone bidder, not the actor.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #334 */
  charges: Array<{ player: string; amount: number }>;
  /* Wins are a LIST in resolution order -- one purchase can cascade through several lone-bid privates.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #334 */
  won: Array<{ privateId: number; name: string; player: string; price: number }>;
  /* The all-pass payout is REPORTED, not performed: the waterfall atom does not carry private_companies. The caller runs applyPrivateRevenue, the same payout the OR uses.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #337 */
  allPassed: boolean;
  /** The markdown that came with it, for the caller's log line. */
  markdown: { privateId: number; name: string; from: number; to: number } | null;
}

/** The next seat in turn order, wrapping. */
function nextSeat(players: readonly string[], current: string): string {
  if (players.length === 0) return current;
  const at = players.indexOf(current);
  return players[(at + 1) % players.length];
}

/* The contest queue is ordered by LOWEST BID and fixed at opening. Re-sorting on every raise would move players under the cursor; nextSeat's -1 index made it accidentally right.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #544 */
function byAscendingBid(
  bidders: readonly string[],
  bids: readonly { bidder: string; bid_amount: string }[],
): string[] {
  const amountOf = (who: string) =>
    Number(bids.find((bid) => bid.bidder === who)?.bid_amount ?? 0) || 0;
  /* Ties are impossible -- every bid must beat the standing one by the $5
     increment -- so this needs no tiebreak, and `sort` being stable means a
     malformed fixture degrades to input order rather than to nondeterminism. */
  return [...bidders].sort((a, b) => amountOf(a) - amountOf(b));
}

/** Skips the high bidder -- nobody is invited to outbid themselves (waterfall::skip_leader_turns).
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #544 */
function nextMiniTurn(
  bidders: readonly string[],
  highBidder: string,
  after: string | null,
): string {
  if (bidders.length === 0) return highBidder;
  const from = after === null ? -1 : bidders.indexOf(after);
  for (let step = 1; step <= bidders.length; step += 1) {
    const candidate = bidders[(from + step + bidders.length) % bidders.length];
    if (candidate !== highBidder) return candidate;
  }
  return highBidder;
}

export function applySandboxWaterfallAction(
  waterfall: WaterfallStateResponse,
  msg: GameplayExecuteMsg,
  players: readonly string[],
): SandboxWaterfallResult {
  const unchanged: SandboxWaterfallResult = {
    waterfall,
    charges: [],
    won: [],
    allPassed: false,
    markdown: null,
  };
  const actor = waterfall.mini_auction?.current_turn ?? waterfall.current_turn;

  /** Drops a private from the offer list and re-marks the new cheapest. The
   *  list is documented as arriving in ascending face value, so "cheapest
   *  remaining" is simply the first entry. */
  const removePrivate = (privateId: number): WaterfallPrivateStatus[] =>
    waterfall.privates
      .filter((entry) => entry.private_id !== privateId)
      .map((entry, index) => ({ ...entry, is_lowest_offered: index === 0 }));

  /* Three missing transitions made the auction a dead end: a mini-auction could be resolved but never opened, passes counted forever, and the auction never ended. All three are pacing, not rules.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #271 */

  /** One ending for every way the last private can leave -- purchase, resolved contest, or markdown to free.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #271 */
  const settle = (next: WaterfallStateResponse): WaterfallStateResponse =>
    next.privates.length === 0
      ? { ...next, waterfall_auction_active: false, mini_auction: null }
      : next;

  /** The auto-award CASCADES: settling a lone-bid private promotes the next, which may itself resolve. A single if would have left the two-deep case wrong.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #336 */
  const cascade = (
    startingPrivates: WaterfallPrivateStatus[],
  ): {
    privates: WaterfallPrivateStatus[];
    mini: WaterfallMiniAuctionStatus | null;
    won: SandboxWaterfallResult["won"];
    charges: Array<{ player: string; amount: number }>;
  } => {
    let privates = startingPrivates;
    const won: SandboxWaterfallResult["won"] = [];
    const charges: Array<{ player: string; amount: number }> = [];

    for (let guard = 0; guard <= startingPrivates.length; guard += 1) {
      const lowest = privates.find((entry) => entry.is_lowest_offered);
      if (!lowest) return { privates, mini: null, won, charges };

      if (lowest.bids.length >= 2) {
        // Contested: a mini-auction decides it, and the cascade stops here.
        return { privates, mini: openMiniAuction(lowest), won, charges };
      }
      if (lowest.bids.length === 0) {
        // Open at face value. Nothing to resolve; the next player chooses.
        return { privates, mini: null, won, charges };
      }

      // Exactly one bid: it is theirs, at the price they bid -- NOT at face
      // value. The bid is the higher of the two by construction (a bid must
      // exceed face value by the increment), and charging face value would
      // hand them a discount for having been the only one interested.
      const [bid] = lowest.bids;
      const price = Number(bid.bid_amount) || 0;
      won.push({ privateId: lowest.private_id, name: lowest.name, player: bid.bidder, price });
      charges.push({ player: bid.bidder, amount: price });
      privates = privates
        .filter((entry) => entry.private_id !== lowest.private_id)
        .map((entry, index) => ({ ...entry, is_lowest_offered: index === 0 }));
    }
    return { privates, mini: null, won, charges };
  };

  const openMiniAuction = (
    target: WaterfallPrivateStatus,
  ): WaterfallMiniAuctionStatus | null => {
    if (target.bids.length < 2) return null;
    const highest = target.bids.reduce((best, bid) =>
      Number(bid.bid_amount) > Number(best.bid_amount) ? bid : best,
    );
    /* Design note #544: bid order, lowest first. Seeded from the seated
       roster so an unknown bidder cannot enter the queue, then sorted --
       `players.filter` is the membership test, `byAscendingBid` is the
       running order. */
    const bidders = byAscendingBid(
      players.filter((player) => target.bids.some((bid) => bid.bidder === player)),
      target.bids,
    );
    const leader = highest.bidder;
    return {
      private_id: target.private_id,
      bidders,
      // The contest opens on the front of the queue -- the lowest bidder --
      // skipping the leader, who is never asked to outbid themselves.
      current_turn: nextMiniTurn(bidders, leader, null),
      high_bid: highest.bid_amount,
      high_bidder: leader,
    };
  };

  if ("WaterfallBuyLowest" in msg) {
    const target = waterfall.privates.find((entry) => entry.is_lowest_offered);
    if (!target) return unchanged;
    const price = Number(target.face_value) || 0;

    // Buying the cheapest promotes the next, and a contest on it opens now -- the ordinary way a mini-auction starts.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #271
    const resolved = cascade(removePrivate(target.private_id));

    return {
      waterfall: settle({
        ...waterfall,
        privates: resolved.privates,
        mini_auction: resolved.mini,
        current_turn: nextSeat(players, waterfall.current_turn),
        // Buying is not passing, so the streak that would end the auction
        // resets -- a counter, not a rule about what the streak means.
        consecutive_waterfall_passes: 0,
      }),
      // The buyer's own price, then whatever the cascade auto-awarded --
      // each to whoever actually owes it (design note #334a).
      charges: [{ player: actor, amount: price }, ...resolved.charges],
      won: [
        { privateId: target.private_id, name: target.name, player: actor, price },
        ...resolved.won,
      ],
      allPassed: false,
      markdown: null,
    };
  }

  if ("WaterfallBidHigher" in msg) {
    const { private_id, bid_amount } = msg.WaterfallBidHigher;
    const amount = Number(bid_amount) || 0;
    return {
      waterfall: {
        ...waterfall,
        privates: waterfall.privates.map((entry) => {
          if (entry.private_id !== private_id) return entry;
          // One standing bid per player: a raise REPLACES rather than
          // stacking, which is what the real bid table holds.
          const others = entry.bids.filter((bid) => bid.bidder !== actor);
          return {
            ...entry,
            bids: [...others, { bidder: actor, bid_amount: String(amount) }].sort(
              (a, b) => Number(a.bid_amount) - Number(b.bid_amount),
            ),
          };
        }),
        // Design note #271: a second bidder on a private that is ALREADY the
        // lowest offer contests it on the spot -- there is no later moment
        // for it to be promoted into, so without this the one private a
        // player can always reach could never open a mini-auction.
        mini_auction:
          waterfall.mini_auction ??
          (() => {
            const bidOn = waterfall.privates.find((e) => e.private_id === private_id);
            if (!bidOn?.is_lowest_offered) return null;
            const others = bidOn.bids.filter((bid) => bid.bidder !== actor);
            return openMiniAuction({
              ...bidOn,
              bids: [...others, { bidder: actor, bid_amount: String(amount) }],
            });
          })(),
        current_turn: nextSeat(players, waterfall.current_turn),
        consecutive_waterfall_passes: 0,
      },
      // A waterfall bid is ESCROWED rather than spent, and the escrow badge
      // the dashboard already renders reads the bid list -- so no cash moves
      // here. Charging on the bid and refunding on a loss would be this file
      // modelling a rule it has no business owning.
      charges: [],
      won: [],
      allPassed: false,
      markdown: null,
    };
  }

  if ("WaterfallPass" in msg) {
    const passes = waterfall.consecutive_waterfall_passes + 1;
    const wholeTablePassed = players.length > 0 && passes >= players.length;

    /* A full round of passes marks the cheapest private down $5; a private marked to $0 is taken, which is also what guarantees the loop terminates.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #271 */
    if (wholeTablePassed) {
      const target = waterfall.privates.find((entry) => entry.is_lowest_offered);
      if (target) {
        const marked = Math.max(0, (Number(target.face_value) || 0) - WATERFALL_PASS_MARKDOWN);
        const taker = nextSeat(players, waterfall.current_turn);

        if (marked === 0) {
          // Free, so it goes. The next seat takes it at no cost, which is
          // how the real auction stops a worthless private from blocking
          // every remaining turn.
          const freed = cascade(removePrivate(target.private_id));
          return {
            waterfall: settle({
              ...waterfall,
              privates: freed.privates,
              mini_auction: freed.mini,
              current_turn: nextSeat(players, taker),
              consecutive_waterfall_passes: 0,
            }),
            charges: freed.charges,
            won: [
              { privateId: target.private_id, name: target.name, player: taker, price: 0 },
              ...freed.won,
            ],
            // Design note #337: this branch IS an all-pass -- the round of
            // passes that marked the price to zero. The privates pay here
            // too, and forgetting that would make the payout depend on
            // whether the markdown happened to land on a round number.
            allPassed: true,
            markdown: {
              privateId: target.private_id,
              name: target.name,
              from: Number(target.face_value) || 0,
              to: 0,
            },
          };
        }

        return {
          waterfall: {
            ...waterfall,
            privates: waterfall.privates.map((entry) =>
              entry.private_id === target.private_id
                ? { ...entry, face_value: String(marked) }
                : entry,
            ),
            current_turn: nextSeat(players, waterfall.current_turn),
            // The streak restarts against the NEW price: the table has not
            // declined this offer, it has never been made one.
            consecutive_waterfall_passes: 0,
          },
          charges: [],
          won: [],
          // Design note #337: the two halves of the all-pass rule, together.
          allPassed: true,
          markdown: {
            privateId: target.private_id,
            name: target.name,
            from: Number(target.face_value) || 0,
            to: marked,
          },
        };
      }
    }

    return {
      waterfall: {
        ...waterfall,
        current_turn: nextSeat(players, waterfall.current_turn),
        consecutive_waterfall_passes: passes,
      },
      charges: [],
      won: [],
      allPassed: false,
      markdown: null,
    };
  }

  if ("WaterfallMiniAuctionRaise" in msg) {
    const mini = waterfall.mini_auction;
    if (!mini) return unchanged;
    const amount = Number(msg.WaterfallMiniAuctionRaise.bid_amount) || 0;
    return {
      waterfall: {
        ...waterfall,
        /* A raise IS a bid, so it goes in priv.bids -- the card renders that list, and a correct leader badge on a stale figure reads exactly like a badge on the wrong player.
           See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #302 */
        privates: waterfall.privates.map((entry) => {
          if (entry.private_id !== mini.private_id) return entry;
          const others = entry.bids.filter((bid) => bid.bidder !== actor);
          return {
            ...entry,
            bids: [...others, { bidder: actor, bid_amount: String(amount) }].sort(
              (a, b) => Number(a.bid_amount) - Number(b.bid_amount),
            ),
          };
        }),
        mini_auction: {
          ...mini,
          high_bid: String(amount),
          high_bidder: actor,
          // Design note #544: on down the queue from the raiser. They are
          // the leader now, so the skip in `nextMiniTurn` is what stops the
          // cursor coming back to them on the lap.
          current_turn: nextMiniTurn(mini.bidders, actor, actor),
        },
      },
      charges: [],
      won: [],
      allPassed: false,
      markdown: null,
    };
  }

  if ("WaterfallMiniAuctionPass" in msg) {
    const mini = waterfall.mini_auction;
    if (!mini) return unchanged;
    const remaining = mini.bidders.filter((bidder) => bidder !== actor);

    // One bidder left: the mini-auction is over and they take the private at
    // their standing high bid. Removing the last competitor is bookkeeping;
    // WHEN a mini-auction may end is the contract's, and this only reflects
    // the shape the response would then have.
    if (remaining.length <= 1) {
      const winner = remaining[0] ?? mini.high_bidder;
      const target = waterfall.privates.find((entry) => entry.private_id === mini.private_id);
      const price = Number(mini.high_bid) || 0;
      // Design note #271: resolving one contest can immediately expose
      // another. Design note #336: or settle it outright, if the promoted
      // private carries exactly one bid.
      const resolved = cascade(removePrivate(mini.private_id));
      return {
        waterfall: settle({
          ...waterfall,
          privates: resolved.privates,
          mini_auction: resolved.mini,
          /* A mini-auction does not consume a main turn: the seat already advanced when the contest opened, so advancing again skipped exactly one seat every time. Preserved, not recomputed.
             See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #338 */
          current_turn: waterfall.current_turn,
          consecutive_waterfall_passes: 0,
        }),
        charges: [{ player: winner, amount: price }, ...resolved.charges],
        won: [
          ...(target
            ? [{ privateId: target.private_id, name: target.name, player: winner, price }]
            : []),
          ...resolved.won,
        ],
        allPassed: false,
      markdown: null,
      };
    }

    /* Dropping out removes the BID, not just the bidder -- escrow is derived from priv.bids, so the money stayed locked for the rest of the auction.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #313 */
    return {
      waterfall: {
        ...waterfall,
        privates: waterfall.privates.map((entry) =>
          entry.private_id === mini.private_id
            ? { ...entry, bids: entry.bids.filter((bid) => bid.bidder !== actor) }
            : entry,
        ),
        mini_auction: {
          ...mini,
          bidders: remaining,
          /* The departed player is no longer in `remaining`, so the search starts at the front -- the lowest bidder still in, stated rather than nextSeat's -1 accident.
             See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #544 */
          current_turn: nextMiniTurn(remaining, mini.high_bidder, actor),
        },
      },
      charges: [],
      won: [],
      allPassed: false,
      markdown: null,
    };
  }

  return unchanged;
}

/* The Stock Round reducer prices the trade from the chart. A flat $67 for every corporation made the market chart decoration.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273 */
export interface SandboxMarketResult {
  prices: SandboxMarketPrices;
  /** What the trade was priced at, so the caller can charge the same figure
   *  it displayed. `null` for a message that moves no money. */
  tradePrice: number | null;
  /** Where a token moved and WHY, for the log line (#435: three movers, three words).
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273 */
  moved: {
    companyId: number;
    from: number;
    to: number;
    reason: "sale" | "withhold" | "payout";
  } | null;
}

export interface SandboxMarketContext {
  /** projectShareSaleMove injected -- utils/ must not import components/. Takes and returns a CELL, not a price.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273 */
  projectSale?: (from: SandboxMarketMark, blocks: number) => SandboxMarketMark | null;
  /** projectDividendCellMove injected the same way (#291): the ordinary dividend step is the one market move a single message fully determines.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273 */
  projectDividend?: (
    from: SandboxMarketMark,
    choice: "pay" | "withhold",
  ) => SandboxMarketMark | null;
  /** Design note #748a: the sale legality rule, so the CHART refuses what the BOARD refuses.
   *
   *  This atom advances BEFORE the game state (#272/#273), so without it an illegal sale that the reducer
   *  declines still walks the token down. The board and the chart would then disagree permanently, and the
   *  visible symptom is a price drop with no matching change in anybody's holdings -- which reads as a market
   *  bug rather than as a refused action. */
  saleRefused?: (companyId: number, percentage: number) => boolean;
  /** Design note #774: the same split again, for the dividend. This atom advances BEFORE the game state, so
   *  a declaration the reducer refuses would still walk the token left -- which IS the reported symptom, a
   *  price that moved further than anything on the board accounts for. One refusal, asked by both. */
  dividendRefused?: (companyId: number) => boolean;
}

export function applySandboxMarketAction(
  prices: SandboxMarketPrices,
  msg: GameplayExecuteMsg,
  ctx?: SandboxMarketContext,
): SandboxMarketResult {
  const unchanged: SandboxMarketResult = { prices, tradePrice: null, moved: null };

  /** Falls back to the nominal for a corporation with no position, which keeps a buy from being free rather than claiming to model par.
   *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273 */
  const priceOf = (companyId: number): number =>
    prices[companyId]?.price ?? SANDBOX_NOMINAL_SHARE_PRICE;

  if ("BuyStock" in msg) {
    // Buying does not move the token in 1830 -- only selling, dividends and
    // the sold-out check do. So this prices the trade and leaves the chart
    // alone, which is a real rule rather than an omission.
    return { prices, tradePrice: priceOf(msg.BuyStock.protocol_id), moved: null };
  }

  if ("SellStock" in msg) {
    const { protocol_id, percentage } = msg.SellStock;
    // Design note #748a: a sale the reducer will decline moves no token either.
    if (ctx?.saleRefused?.(protocol_id, percentage) === true) return unchanged;
    const blocks = Math.max(1, Math.round(percentage / SANDBOX_SHARE_PERCENTAGE));
    const mark = prices[protocol_id] ?? null;
    const proceeds = priceOf(protocol_id) * blocks;

    if (mark === null || !ctx?.projectSale) {
      return { prices, tradePrice: proceeds, moved: null };
    }
    // Walked from the CELL, not from the price -- design note #272. Two
    // cells share a price on this chart and stepping down from the wrong
    // one lands somewhere the marker never was.
    const landed = ctx.projectSale(mark, blocks);
    if (!landed || (landed.x === mark.x && landed.y === mark.y)) {
      return { prices, tradePrice: proceeds, moved: null };
    }
    return {
      // Design note #646: every landing is stamped with its arrival, so a
      // tie on the new cell resolves by who reached it first.
      prices: { ...prices, [protocol_id]: withArrival(prices, protocol_id, landed) },
      // Priced at the price BEFORE the drop: the seller is paid what the
      // share was worth when they sold it, and the fall is the consequence.
      tradePrice: proceeds,
      moved: { companyId: protocol_id, from: mark.price, to: landed.price, reason: "sale" },
    };
  }

  if ("DeclareDividends" in msg) {
    /* Design note #291: RIGHT on a payout, LEFT on a withhold. The cash is
       still `applySandboxAction`'s -- this owns only the marker, which is
       the same split every other arm here follows. */
    const { protocol_id, distribute } = msg.DeclareDividends;
    // Design note #774: a declaration the reducer will decline moves no token either.
    if (ctx?.dividendRefused?.(protocol_id) === true) return unchanged;
    const mark = prices[protocol_id] ?? null;
    if (mark === null || !ctx?.projectDividend) return unchanged;
    const landed = ctx.projectDividend(mark, distribute ? "pay" : "withhold");
    if (!landed || (landed.x === mark.x && landed.y === mark.y)) return unchanged;
    return {
      // Design note #646: likewise -- a dividend move is an arrival.
      prices: { ...prices, [protocol_id]: withArrival(prices, protocol_id, landed) },
      tradePrice: null,
      /* The reason travels with the move; the shell used to log every marker move as "on the sale".
         See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273 */
      moved: {
        companyId: protocol_id,
        from: mark.price,
        to: landed.price,
        reason: distribute ? "payout" : "withhold",
      },
    };
  }

  return unchanged;
}

/* settleRoundTransitions -- the round machine belongs to the reducer. The shell used to perform transitions, so a replay rebuilt corporations correctly and left the round wherever the last live dispatch had put it.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #642 */
export function applySandboxAction(
  state: GameStateResponse,
  msg: GameplayExecuteMsg,
  ctx?: SandboxActionContext,
): GameStateResponse {
  /* ==================================================================
   *  DESIGN NOTE 757: THE LAY HAD NO AUTHORITY EITHER
   * ==================================================================
   *
   * #756 closed the button on a rotation that crosses an impassable border, and I said at the time that it
   * closed the button and not the door: the reducer applied whatever `LayTile` it was handed. This is the
   * door.
   *
   * IT IS THE SAME GAP #748 FOUND ON THE SELL SIDE, and the same one #712 had already closed for buys. Every
   * placement rule in this game -- the colour step, centre preservation, path preservation, the board's rim,
   * the four barriers -- lived in a filter that decides which chips the radial selector OFFERS. A message
   * built by hand, replayed from a stale tab, or dispatched by any second control written later went
   * straight through.
   *
   * GATED HERE RATHER THAN IN THE ARM, because a lay touches three things: the terrain fee in `applyOneAction`,
   * the sub-phase cursor in `settleOperatingCursor`, and the tile grid, which is a separate atom the shell
   * owns. Refusing in the arm alone would have charged the fee and advanced the step for a tile that was
   * never placed -- the cross-atom split #748a had to solve for the market chart, arriving again.
   *
   * THE SHELL APPLIES THE SAME PREDICATE TO THE GRID, so one answer governs all three.
   *
   * CONNECTIVITY IS DELIBERATELY NOT PART OF IT, and this is the interesting scope decision. The D&H and the
   * C&SL both lay track that legally ignores network connectivity (#725/#726), and this message carries no
   * indication of which power is in play -- so a reducer that enforced connectivity would refuse two real
   * abilities. What it enforces is the set of rules that are facts about the BOARD rather than about whose
   * turn it is, which is exactly the set a hand-built message could otherwise abuse.
   *
   * A REFUSAL RETURNS THE STATE UNCHANGED, on #712's reasoning: a replay must not halt on an entry the log
   * already contains. */
  if ("LayTile" in msg && ctx?.layRefused) {
    const { q, r, tile_id, orientation } = msg.LayTile;
    if (ctx.layRefused(q, r, tile_id, orientation)) return state;
  }

  /* Design note #774: ONE CORPORATION, ONE DIVIDEND DECLARATION, AT THE STEP THAT OWNS THE CHOICE.
     Reported as a share price that "moved two cells left rather than one" after a trainless first Operating
     Round. Two cells is two messages: the forced $0 withhold is dispatched by an effect gated on shared
     state and not on whose turn it is, so every seated browser appended its own copy.
     THE PER-CLIENT GUARD CANNOT SEE THE OTHER CLIENT. `forcedWithholdRef` is a `Set` in one tab; the
     property it is trying to enforce belongs to a shared append-only log. So the rule lives here, where a
     duplicate from ANY source -- a second browser, a stale tab, a hand-built message -- meets the same
     answer. `settleOperatingCursor` has already moved the cursor off Dividends by the time the second one
     arrives, so the check is the ordinary rule rather than a duplicate-detector.
     UNCHANGED ON REFUSAL, on #712's reasoning: a replay must not halt on an entry the log already contains. */
  if ("DeclareDividends" in msg) {
    if (dividendRefusal(state, msg.DeclareDividends.protocol_id) !== null) return state;
  }

  /* Design note #763: NOTHING HAPPENS WHILE A HOME TOKEN IS OWED. Floating a corporation and placing its
     home token are one event in 1830; #416 split them into a prompt so the player would witness the
     placement, and that opened a window the physical game does not have. Everything downstream reads the
     board, so an action settled while a floated corporation has no token is settled against a board that
     cannot exist.
     BEFORE EVERY OTHER ARM, because the point is that no message lands -- including the ones that would
     otherwise be harmless. `homeTokenBlock` lets the placement and Undo through; a gate with no exit turns a
     bad state into an unrecoverable one. */
  if (ctx?.homeHexToAxial) {
    if (homeTokenBlock({ state, homeHexToAxial: ctx.homeHexToAxial, msg }) !== null) return state;
  }

  return settleOperatingCursor(
    state,
    /* Design note #660: the B&O private closes the moment the B&O
       corporation owns a train. Settled here beside the era for the same
       reason (#657) -- it is a function of the board, so no message can
       change the fleet and forget it. */
    settleBaoPrivate(settleEra(settleRoundTransitions(applyOneAction(state, msg, ctx), ctx))),
    msg,
  );
}

/* The era is SETTLED from the trains after every action, never assigned per-arm. It was stamped at seed time and never written, so a Phase 6 game still reported Yellow. The OR count is deliberately untouched (#511).
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #657 */
function settleEra(state: GameStateResponse): GameStateResponse {
  const phase = derivePhase(state);
  /* Unknown phase -- no corporation has reported a fleet at all -- leaves the
     era alone. That is a board we know nothing about rather than a Yellow
     one, and overwriting a seeded scenario's era (`sandboxState.ts` starts
     one in "Green") with a guess would be worse than saying nothing. */
  if (!phase?.known) return state;
  const era = ERA_FOR_TIER[phase.tier];
  if (era === undefined || era === state.current_global_era) return state;
  return { ...state, current_global_era: era };
}

/** 1830's phase table, written out rather than read from TIER_PRESENTATION -- a rule must not be read out of a presentation table.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #657 */
const ERA_FOR_TIER: Readonly<Record<string, TileColor>> = {
  "2": "Yellow",
  "3": "Green",
  "4": "Green",
  "5": "Brown",
  "6": "Brown",
  D: "Brown",
};

/* The OR sub-phase cursor moves HERE, not in an App effect keyed on the era. One place with a stated default (hold) rather than a write in twelve message arms; a turn change beats every step rule.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #656 */
function settleOperatingCursor(
  before: GameStateResponse,
  after: GameStateResponse,
  msg: GameplayExecuteMsg,
): GameStateResponse {
  /* Outside an OR the cursor is CLEARED, not frozen -- a stale Hardware would be handed to the next round's first corporation.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #656 */
  if (after.current_round_type !== "OperatingRound") {
    if (after.operating_sub_phase === undefined) return after;
    return { ...after, operating_sub_phase: undefined };
  }

  const turnChanged =
    before.current_round_type !== after.current_round_type ||
    before.active_corporation_index !== after.active_corporation_index ||
    before.sub_round_index !== after.sub_round_index ||
    before.macro_round_number !== after.macro_round_number;
  if (turnChanged) {
    /* ==================================================================
     *  DESIGN NOTE 777: THE TURN CLEARS THE RUN, BECAUSE THE LOG CAN SAY SO
     * ==================================================================
     *
     * REPORTED: "B&O just ran for $200 and the toast said it paid out at $39 per share", and before that
     * "$190 ... $22 per share". $390 is $200 plus the previous run's $190; $220 is $190 plus the run before
     * that. `last_route_revenue` was carrying turns forward.
     *
     * THE RESET EXISTED AND COULD NEVER ARRIVE. `RunManualRoute` adds to the stored figure -- correct, since
     * one message per train is how a multi-train turn is recorded -- and `ctx.resetRouteRevenue` was supposed
     * to zero it on the batch's first message. But that flag is a DISPATCH-TIME OPTION, and
     * `appendSandboxAction` writes only the message and `derived` into the log. Every client, including the
     * one that pressed the button, applies actions by REPLAYING them, so the flag was never present when the
     * arm read it. The reset was unreachable on every code path in the app.
     *
     * SO THE RULE BECOMES A FACT ABOUT STATE. A corporation's route revenue describes THIS turn; the moment
     * the turn changes it describes a turn that is over. This function already computes `turnChanged` for the
     * cursor, and the same event is what makes the figure stale -- so it is cleared here rather than signalled
     * from outside. Derivable from the log alone, which is #642's standing rule for anything the reducer owns.
     *
     * ALL CORPORATIONS, NOT JUST THE OUTGOING ONE. The field is only ever read for the corporation currently
     * operating, so clearing the rest costs nothing and removes the question of which one to clear -- and a
     * round transition changes the queue itself, where "the outgoing one" is not well defined. */
    const cleared = after.public_companies.some(
      (company) => (company.last_route_revenue ?? "0") !== "0",
    )
      ? after.public_companies.map((company) =>
          (company.last_route_revenue ?? "0") === "0"
            ? company
            : { ...company, last_route_revenue: "0" },
        )
      : after.public_companies;
    return {
      ...after,
      public_companies: cleared,
      operating_sub_phase: openingSubPhase(after),
    };
  }

  const current = after.operating_sub_phase;
  const next = stepAfterMessage(after, current, msg);
  if (next === current) return after;
  return { ...after, operating_sub_phase: next };
}

/** The four explicit arms mirror the CONTRACT's own cursor (hexmap::execute_lay_tile advances off Track on success), not an invented sandbox sequence.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #656 */
function stepAfterMessage(
  state: GameStateResponse,
  current: OperatingSubPhase | undefined,
  msg: GameplayExecuteMsg,
): OperatingSubPhase {
  /* A corporation lays one tile per turn, so the Track step is done.
     Design note #776: UNLESS THE LAY WAS EXTRA. This arm was unconditional, and it is the line that both
     enforces "one tile per turn" and -- wrongly -- ended the Track step on the Champlain & St. Lawrence's
     bonus lay. The cursor is what withdraws the Lay Track controls, so ending the step here is the second
     lay being taken away. `layEndsTrackStep` reads a flag the shell sets; an unflagged lay is ordinary, so
     every message written before #776 behaves exactly as it did. */
  if ("LayTile" in msg) {
    return layEndsTrackStep(msg) ? settleSubPhase(state, "Tokens") : settleSubPhase(state, current);
  }
  // One station placement per turn likewise.
  if ("PlaceStationToken" in msg) return settleSubPhase(state, "Routes");
  /* Running the routes COMPUTES the revenue; declaring dividends chooses
     what to do with it (design note #142). Two steps, so two messages. */
  if ("RunManualRoute" in msg) return settleSubPhase(state, "Dividends");
  if ("DeclareDividends" in msg) return settleSubPhase(state, "Hardware");
  /* The Skip button and the auto-skip (design note #439) both arrive as
     this, and both mean the same thing to the cursor. */
  if ("AdvanceOperatingSubPhase" in msg) {
    return nextSubPhase(state, settleSubPhase(state, current));
  }
  /* The default is to stay put, and it is the important arm: a phase change is not a turn event.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #656 */
  return settleSubPhase(state, current);
}

/* One-shot flags are consumed in the dispatch that raised them. One transition per action, deliberately, rather than a while loop.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #642 */
function settleRoundTransitions(
  state: GameStateResponse,
  ctx?: SandboxActionContext,
): GameStateResponse {
  if (state.stock_round_just_ended) {
    /* ==================================================================
     *  DESIGN NOTE 746a: THE RISE HAPPENS BEFORE THE QUEUE IS ORDERED
     * ==================================================================
     *
     * The operating order sorts floated corporations by market price, and the sold-out rise is an end-of-
     * Stock-Round event -- so a corporation that rises past a rival must operate ahead of it in the very next
     * Operating Round. Applying the rise in the shell after this transition would have built the queue on
     * pre-rise prices and got that ordering wrong for one round, every time.
     *
     * SO THE OVERLAY, rather than a second `buildOperatingOrder` call afterwards. #642 is the reason it is not
     * done in the shell: "the round machine belongs to the reducer. The shell used to perform transitions, so
     * a replay rebuilt corporations correctly and left the round wherever the last live dispatch had put it."
     * A rise that reordered the queue from outside would be that mistake with a new name.
     *
     * THE SHELL STILL COMMITS THE MOVE to the market atom, because that atom is not part of
     * `GameStateResponse` -- it derives the rises from the same pure function with the same injected
     * traversal, so the queue and the chart cannot disagree about where a token landed. */
    const rises = roundEndSoldOutRises(state, ctx?.marketMarkFor, ctx?.projectRise);
    const risenPrice = new Map(rises.map((rise) => [rise.companyId, rise.to]));
    const risenMark = new Map(rises.map((rise) => [rise.companyId, { x: rise.x, y: rise.y }]));

    /* The queue is built here; leaving it to the caller is what produced an OR with an empty order that advanceCorporation then "recovered" back to 1.1.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #411 */
    const opened = {
      ...beginOperatingRound(
        state,
        (companyId) => risenPrice.get(companyId) ?? ctx?.marketPriceFor?.(companyId) ?? null,
        (companyId) => risenMark.get(companyId) ?? ctx?.marketMarkFor?.(companyId) ?? null,
      ),
      stock_round_just_ended: false,
    };
    /* Design note #685: THE PRIVATES ARE PAID HERE, BY THE REDUCER.

       REPORTED as a regression -- "the Private Companies are supposed to pay out their income every Operating
       Round, and in previous playthroughs they have, but in my latest playthrough they did not."

       They were paid by a REACT EFFECT in the shell, watching `current_round_type` for an edge against a ref.
       That is precisely the arrangement design note #1206 above removed for the round machine itself -- "the
       shell used to perform transitions, so a replay rebuilt corporations correctly and left the round wherever
       the last live dispatch had put it" -- and the payout never got the same treatment.

       IT BROKE THE MOMENT A REBUILD BECAME MORE LIKELY. `rebuildSandbox` resets the board but not the shell's
       edge-detector ref, so after a rebuild the ref still said "OperatingRound" while the replay ended in one:
       no edge, no payout, no error. `firebase_middleware.md` #668 replaced a length check with a prefix check,
       which correctly rebuilds in cases the old one missed -- and each of those newly-correct rebuilds silently
       skipped a round of private income.

       AND IT COULD NEVER HAVE BEEN RIGHT IN A ROOM. The money moved outside the log, so a client that rebuilt
       and a client that did not held different treasuries from then on -- the same divergence class the action
       log itself was hardened against.

       HERE IT IS DETERMINISTIC BY CONSTRUCTION: one place, on the one transition that opens an Operating Round,
       replayed identically by every client. No ref to go stale, no effect to miss a batch. */
    return applyPrivateRevenue(opened)?.state ?? opened;
  }

  if (state.operating_round_just_ended) {
    return {
      ...state,
      operating_round_just_ended: false,
      current_round_type: "StockRound" as const,
      macro_round_number: state.macro_round_number + 1,
      // Design note #621: the cycle counter resets, and the next
      // `beginOperatingRound` stamps it back to 1.
      sub_round_index: 0,
      consecutive_passes: 0,
      last_trader_index: null,
      /* Design note #744: THE LOCKOUT ENDS HERE, and this is the only event that ends it. A player who sold
         PRR last round may buy it again now -- the rule bars a sell-then-rebuy within ONE Stock Round, which
         is the window in which the price crater they made is still there to exploit.
         Cleared rather than aged: "which round was this sale in" would be a second fact to keep in step with
         `macro_round_number`, and the round opening is exactly when the answer changes. */
      sold_this_round: {},
      /* Design note #745: and the turn flag, because the seat below is being MOVED without going through
         either seat-moving function. A stale `true` here would let the Priority Deal holder's opening Pass
         slip out of the streak, so the round could not reach its own termination condition. */
      turn_action_taken: false,
      // The Priority Deal holder opens the Stock Round -- design note #353,
      // and the whole point of holding it.
      active_player_index: state.priority_deal_index,
    };
  }

  return state;
}

function applyOneAction(
  state: GameStateResponse,
  msg: GameplayExecuteMsg,
  ctx?: SandboxActionContext,
): GameStateResponse {
  /* Three cases, each saying one thing: undefined means solo (cursor is the actor), a seated author is used, anything else is null. `??` would reinstate the nondeterminism #549 removed.
     See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #549 */
  const logged = ctx?.actor;
  const actor =
    logged === undefined
      ? state.player_addresses[state.active_player_index] ?? null
      : logged !== null && state.player_addresses.includes(logged)
        ? logged
        : null;

  // Passing means two things: a player declining a seat-driven turn, or a CORPORATION ending its OR turn. Treating both as a seat advance strands the OR on its first company.
  // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0
  if ("PassTurn" in msg) {
    if (state.current_round_type === "OperatingRound") {
      return advanceCorporation(state, ctx?.marketPriceFor, ctx?.marketMarkFor);
    }
    /* Design note #745: ENDING A TURN IS NOT PASSING IT. A player who has already sold this turn is pressing
       this button to finish, not to decline -- selling is an action, and 1830 guarantees anyone who acts
       another opportunity before the round closes. `advanceSeat` moves the seat and leaves the streak at
       zero; `recordPass` moves it and counts. One message, two meanings, and the flag says which. */
    return hasActedThisTurn(state) ? advanceSeat(state) : recordPass(state);
  }

  if ("WaterfallPass" in msg) {
    return recordPass(state);
  }

  // ---- Seat-driven rounds: the Waterfall Auction and the Stock Round.

  if ("BuyStock" in msg) {
    // The share has to actually move: adjusting cash alone left the pool, the holding and the source button unchanged, which reads as a dead button. ONE certificate per message.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273
    const { protocol_id, source } = msg.BuyStock;
    /* The reducer reads the MESSAGE's par_value. ctx.parValue is assembled per browser and falls through to "100" on every replaying client -- the third instance of a shared fact derived from a per-browser value.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #579 */
    const messagePar = Number(msg.BuyStock.par_value ?? NaN);
    const parFromMessage = Number.isFinite(messagePar) && messagePar > 0 ? messagePar : null;

    /* IPO buys are priced at par (design note #558), and par is on the
       message -- so this needs no local state at all. A POOL buy is priced
       by the chart, which is a genuinely shared atom, and keeps
       `ctx.sharePrice`. */
    const price =
      source === "Ipo" && parFromMessage !== null
        ? parFromMessage
        : (ctx?.sharePrice ?? SANDBOX_NOMINAL_SHARE_PRICE);

    /* The first IPO share is the 20% President's Certificate at twice par, and it sets the presidency and the par together. #587: the test is "has this corporation been started" (par_value), since the C&A grant makes holders-without-a-president a normal opening position.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #351 */
    const target = state.public_companies.find((c) => c.company_id === protocol_id);
    const isPresidentBuy =
      source !== "Bank" &&
      !!target &&
      target.president === null &&
      (target.par_value === null || target.par_value === undefined) &&
      !!actor;

    /* Design note #712: QUANTITY, so a Brown-zone pool multi-buy settles as ONE action.
       It settled as several before: `App.handleBuyShare` looped and dispatched N `BuyStock` messages, and the
       tail of this branch calls `advanceSeat` -- so three pool shares passed the turn three times and shares
       two and three were made by whoever the seat had moved to.
       ABSENT MEANS ONE, which is what every message written before this field meant and must keep meaning on
       replay. A president's certificate is never multiple: it is one 20% card and there is only ever one. */
    const requested = Math.max(1, Math.floor(Number(msg.BuyStock.quantity ?? 1)));
    /* CAPPED BEFORE THE CHARGE. `moveShares` already refuses to hand out more than the pool holds -- "taking
       more than exists is capped to what exists" -- but the price is computed HERE, so a request for five
       against a pool of three would have charged for five and delivered three. The cap has to be applied to
       the figure the player pays, not only to the certificates they receive. */
    const inSource = target
      ? Math.floor(
          (source === "Bank" ? target.bank_pool_percentage : target.ipo_pool_percentage) /
            SANDBOX_SHARE_PERCENTAGE,
        )
      : 0;
    const certificates = isPresidentBuy ? 1 : Math.max(1, Math.min(requested, inSource));

    const percentage = isPresidentBuy
      ? SANDBOX_PRESIDENT_PERCENTAGE
      : SANDBOX_SHARE_PERCENTAGE * certificates;
    const charged = isPresidentBuy ? price * 2 : price * certificates;

    /* Design note #712: THE REDUCER REFUSES TOO, and that is not belt-and-braces.
       The panel's gate is advice on one screen; this runs on every client that replays the log, so a purchase
       that should not have happened cannot enter the shared state from a stale tab, a hand-built message, or
       a client whose market grid had not loaded when the button was drawn.
       IT REUSES THE SAME FUNCTION, so the button and the board cannot disagree about a rule -- the failure
       this codebase keeps finding when a rule is stated twice. The zone comes from `ctx.marketZoneFor`, which
       is the shared chart rather than any browser's copy of it.
       A REFUSAL RETURNS THE STATE UNCHANGED rather than throwing: a replay must not halt on an entry the log
       already contains, and an illegal buy that somehow got written is best treated as a move that did
       nothing. */
    if (actor && ctx?.marketZoneFor) {
      const blocked = sharePurchaseBlock({
        state,
        buyer: actor,
        companyId: protocol_id,
        source,
        quantity: certificates,
        zone: ctx.marketZoneFor(protocol_id),
        marketPrices: ctx.marketPricesByCompany ?? null,
        zoneForPrice: ctx.zoneForPrice,
      });
      if (blocked !== null) return state;
    }

    const spent = actor ? adjustCash(state, actor, -charged) : state;
    const banked = adjustBank(spent, charged);
    const moved = moveShares(
      banked,
      protocol_id,
      actor,
      source === "Bank" ? "Bank" : "Ipo",
      percentage,
    );

    /* Presidency and par written together -- the panel locks its ladder on par_value !== null.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #351 */
    const crowned = isPresidentBuy
      ? {
          ...moved,
          public_companies: moved.public_companies.map((company) =>
            company.company_id === protocol_id
              ? {
                  ...company,
                  president: actor,
                  /* Design note #579: from the MESSAGE first. `ctx.parValue`
                     is the caller's ladder and is empty on every client but
                     the one that clicked -- which is the reported bug. */
                  par_value: company.par_value ?? String(parFromMessage ?? ctx?.parValue ?? price),
                }
              : company,
          ),
        }
      : moved;

    /* Buying is the only action that can cross the float threshold, so the check rides on it. Without homeHexToAxial the company still floats and simply gets no token.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #363 */
    const floated = ctx?.homeHexToAxial
      ? applyFloatThreshold(crowned, ctx.homeHexToAxial)
      : crowned;

    /* Design note #596: a purchase can take the presidency off somebody. Run
       AFTER the float check, because a buy that both floats a company and
       crowns a new president must resolve the float against the holdings that
       caused it, not against a board mid-transfer. */
    const settledBuy = markTrader(settlePresidencies(floated).state, actor);

    /* ==================================================================
       DESIGN NOTE 769: THE SEAT STAYS WITH THE PRESIDENT UNTIL THE TOKEN IS DOWN
       ==================================================================
       REPORTED: "After a corporation floated, the president player did not immediately know they needed to
       place the station ... It immediately moved to the other player's turn, even though the President player
       hadn't placed their home station: the other player's button clicks were logged in the activity log, but
       nothing happened."
       #763 STOPPED THE OTHER PLAYER ACTING AND LEFT THE SEAT WHERE IT SHOULD NOT BE. The float happens ON this
       purchase, and the purchase ends by advancing the seat -- so the round announced somebody else's turn and
       then refused everything they tried. Two players both stuck, and neither screen said why.
       BEING REFUSED IS NOT THE SAME AS NOT BEING ASKED. A gate that blocks actions is correct and invisible;
       what tells a table whose move it is, is the cursor. So the seat is held rather than advanced, which
       makes the obligation legible from every screen without anybody reading a message.
       ONLY WHEN THIS PURCHASE OWES A TOKEN. A buy that floats nothing advances the seat exactly as before --
       the condition is the debt, not the float, so a corporation with no resolvable home hex (#416) does not
       freeze the round. */
    if (ctx?.homeHexToAxial && pendingHomeTokens(settledBuy, ctx.homeHexToAxial).length > 0) {
      return settledBuy;
    }

    return advanceSeat(settledBuy);
  }

  if ("SellStock" in msg) {
    // Selling does not advance the seat (trading.rs #9) and sold shares go to the BANK POOL, never the IPO. The message says how much, so honour it.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #273
    const { protocol_id, percentage } = msg.SellStock;
    const sold = Math.max(SANDBOX_SHARE_PERCENTAGE, Math.round(percentage));

    /* ==================================================================
     *  DESIGN NOTE 748: THE SELL SIDE HAD NO AUTHORITY AT ALL
     * ==================================================================
     *
     * REPORTED: "P1 had a 10% share and P2 had a 50% share including the 1 President's certificate. P1 sold
     * their 10% share and P2 was then able to sell 40%: this respected the 50% bank pool limit, but it did not
     * respect the rule that a President's certificate can never be sold."
     *
     * `shareSaleBlock` REFUSES THAT SALE, AND HAS SINCE #713. Run against the reported board it returns
     * "Selling 40% would leave you under the 20% President's Certificate, and no other player holds 20% to
     * take it." The rule was right, the message was right, and nothing in the reducer ever asked.
     *
     * ONE CALLER, AND IT WAS THE PANEL. `shareSaleBlock` had exactly one call site -- `App.saleBlockFor`,
     * feeding a disabled state on the Stock Round card. So the rule was advice on one screen while the log
     * accepted anything: a stale tab, a replay, a hand-built message, or any second sell control written
     * later all went straight through. #736's phrasing fits it exactly -- readers with no writer.
     *
     * WHAT MAKES THIS ONE POINTED is that #712 fixed precisely this for the BUY side twenty lines above, and
     * #744 got its enforcement for free BECAUSE that work had been done -- "the reducer already routed buys
     * through `sharePurchaseBlock`, so adding the rule there closed both at once". The sell side never got the
     * same treatment, and nothing on screen distinguished the two.
     *
     * A REFUSAL RETURNS THE STATE UNCHANGED, on #712's reasoning: a replay must not halt on an entry the log
     * already contains, and an illegal sale that somehow got written is best treated as a move that did
     * nothing. */
    if (actor) {
      const refused = shareSaleBlock({
        state,
        seller: actor,
        companyId: protocol_id,
        percentage: sold,
      });
      if (refused !== null) return state;
    }

    const takings = ctx?.sharePrice ?? SANDBOX_NOMINAL_SHARE_PRICE;

    const proceeds = actor ? adjustCash(state, actor, takings) : state;
    const returned = moveShares(
      adjustBank(proceeds, -takings),
      protocol_id,
      actor,
      "Bank",
      -sold,
    );
    // A sale moves the crown too -- selling below another holder hands them the presidency. Same function as the buy, so the two cannot disagree.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #596
    /* Design note #744: AND IT LOCKS THE BUY-BACK. Reported: a player sold and then bought the same
       corporation in the same Stock Round, which is how a stock price is crated and restocked at the bottom.
       Recorded on the SALE rather than checked at the buy, because the buy cannot see backwards: the log has
       the sale, but a reducer arm sees only its own message. The record is the memory. */
    /* Design note #745: AND IT COUNTS AS THIS TURN'S ACTION. `consecutive_passes: 0` below already broke the
       streak, but the seat does not move on a sale -- the player may still buy -- so the Pass that finishes
       the turn was putting the streak straight back to one and erasing the sale. The flag is what survives
       between the two messages. Set here rather than in `moveShares` because a sale is the only Stock Round
       action that leaves the seat where it is; every other one ends the turn itself. */
    const settled = markTrader(
      { ...settlePresidencies(returned).state, consecutive_passes: 0, turn_action_taken: true },
      actor,
    );
    if (!actor) return settled;
    const already = settled.sold_this_round?.[actor] ?? [];
    if (already.includes(protocol_id)) return settled;
    return {
      ...settled,
      sold_this_round: {
        ...(settled.sold_this_round ?? {}),
        [actor]: [...already, protocol_id],
      },
    };
  }

  if (
    "WaterfallBuyLowest" in msg ||
    "WaterfallBidHigher" in msg ||
    "WaterfallMiniAuctionRaise" in msg ||
    "WaterfallMiniAuctionPass" in msg ||
    "BidOnPrivate" in msg
  ) {
    return advanceSeat(state);
  }

  // OR actions charge the acting CORPORATION and none of them end its turn -- only PassTurn does. protocol_id comes off the message, not the queue cursor.
  // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0

  if ("LayTile" in msg) {
    /* The GROUND costs money, not the tile: $0 clear, $80 river, $120 mountain, by coordinate. The flat $20 was a placeholder the renderer had been contradicting on screen.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #432 */
    /* Design note #723: AND IT IS PAID ONCE. Reported twice -- "it is wrong to keep charging the terrain cost
       for every lay track action on a terrain hex". This arm charged unconditionally and always had; the rule
       existed only in `pendingTileCost` (#673), which is the figure the player is SHOWN. So an upgrade over a
       river previewed as free and debited $80, and the only surface anybody could check was the one telling
       them it was fine.
       THE SET LIVES IN STATE, not on the tile grid -- `terrainFee.ts` #723 has the reasoning, and it is about
       replay: `ctx.mapGrid` does not advance action by action inside the Undo rebuild loop, so a board lookup
       here would be right live and wrong on every rebuild. */
    const { protocol_id, q, r, token_city, token_cities } = msg.LayTile;
    const fee = terrainFeeDue(state.terrain_fees_paid, q, r, terrainBuildFeeAt);
    const recorded: GameStateResponse = {
      ...state,
      terrain_fees_paid: withTerrainPaid(state.terrain_fees_paid, q, r, fee),
      /* ==================================================================
         DESIGN NOTE 824: THE TOKEN GOES WHERE THE PRESIDENT PUT IT
         ==================================================================

         REPORTED, of ERIE's home: "in an actual physical game, when a player upgrades ERIE's home hex, the
         station is removed from the board to place the new tile, then the player sets their token where they
         want it. Because there is no marking for 'City 1' vs 'City 2' on the preprinted yellow hex, there is
         no way to debate whether one city or the other is the correct one."

         SO THE INDEX WAS OURS AND NOT THE BOARD'S. `tokenMigration.ts` #824 has the argument; this is the
         half that makes it stick, because a choice the log does not carry is a choice that does not survive
         a replay -- and "the log is the game" (#522).

         EVERY TOKEN ON THE HEX MOVES, not only the acting corporation's. On an unlaid preprinted OO hex the
         cities are indistinguishable for whoever is standing there, so a second occupant's index is exactly
         as arbitrary as the first's. In practice there is one -- nobody else may token these hexes before
         they are upgraded -- but a rule that quietly assumed that would be a rule about the board rather than
         about the cardboard.
         ABSENT MEANS UNCHANGED, which is every ordinary upgrade in the game.

         ==================================================================
          DESIGN NOTE 880: BOTH ARMS OF THAT WERE WRONG
         ==================================================================
         ASKED: "If a tile has multiple stations and a corporation upgrades it, it is necessary that all the
         stations maintain their connectivity, not just the one whose corporation is upgrading."

         "EVERY TOKEN ON THE HEX MOVES" WAS TRUE AND MOVED THEM ALL TO ONE CITY. Right for ERIE's home, where
         only one token stands; on a shared OO hex it stacks two corporations into the same circle.
         "ABSENT MEANS UNCHANGED" WAS THE LIVE BUG. Every ordinary upgrade sent nothing, so no token ever
         moved -- and #878 is the finding that a token's city is NOT preserved across an upgrade, it is
         recomputed from the network. This arm is why the report said "upgrades to OO tiles are not
         preserving corporation station network connectivity": the frontend could compute the right city and
         had no way to say it, and the reducer's default was to do nothing.

         SO THE MAP DECIDES, PER COMPANY, and `token_city` survives only as the old spelling: a log written
         before this must replay to where it landed then (#522, "the log is the game"). */
      public_companies: (() => {
        const perCompany = new Map<number, number>(token_cities ?? []);
        if (perCompany.size === 0 && token_city === undefined) return state.public_companies;
        return state.public_companies.map((company) => {
          /* THE OLD SPELLING APPLIED TO EVERYBODY, which is what it meant when it was written; the new one
             applies to the company it names and leaves the rest alone. */
          const city = perCompany.has(company.company_id)
            ? perCompany.get(company.company_id)
            : perCompany.size === 0
              ? token_city
              : undefined;
          if (city === undefined) return company;
          return {
            ...company,
            station_tokens:
              company.station_tokens?.map((entry) =>
                entry[0] === q && entry[1] === r
                  ? ([entry[0], entry[1], city] as [number, number, number])
                  : entry,
              ) ?? null,
          };
        });
      })(),
    };
    return fee > 0 ? adjustTreasury(recorded, protocol_id, -fee) : recorded;
  }

  if ("BuyHardwareFromPool" in msg) {
    return buyDepotTrain(state, msg.BuyHardwareFromPool.protocol_id);
  }

  if ("EmergencyBuyHardware" in msg) {
    /* The president's money actually moves: treasury pays what it has, president covers the shortfall, then buyDepotTrain runs against an exact balance so its arithmetic is unchanged.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #333 */
    const companyId = msg.EmergencyBuyHardware.protocol_id;
    const tier = depotInventory(state).find(
      (row) => row.remaining === null || row.remaining > 0,
    );
    if (!tier) return state;

    const company = state.public_companies.find((entry) => entry.company_id === companyId);
    const treasury = Number(company?.treasury) || 0;
    const shortfall = Math.max(0, tier.cost - treasury);

    if (shortfall === 0 || !company?.president) return buyDepotTrain(state, companyId);

    // The president's contribution passes THROUGH the treasury, which is
    // what makes `buyDepotTrain`'s single `adjustTreasury(-cost)` correct
    // for both the ordinary and the emergency case.
    const funded = adjustTreasury(
      adjustCash(state, company.president, -shortfall),
      companyId,
      shortfall,
    );
    return buyDepotTrain(funded, companyId);
  }

  if ("BuyTrainFromCorporation" in msg) {
    /* Settle the transfer; whether the counterparty AGREED is train_trade.rs's offer flow and the panel's consent modal. One train, since msg.rs carries no count.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #191 */
    const { buyer_protocol_id, seller_protocol_id, model_type, price } =
      msg.BuyTrainFromCorporation;
    return settleTrainSale(state, buyer_protocol_id, seller_protocol_id, model_type, price);
  }

  if ("BuyPrivateCompany" in msg) {
    // The private has to actually change hands. Whether the trade was PERMITTED stays with trading.rs::execute_buy_private_company.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0
    const { protocol_id, private_id, price } = msg.BuyPrivateCompany;
    /* The B&O private may never be sold to a corporation. Enforced here as well as in the offer filter, because a remote client replays MESSAGES, not button states. A no-op, not a throw.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #660 */
    if (!isSellableToCorporation(private_id)) return state;
    const paid = Number(price) || 0;
    const target = state.private_companies.find((entry) => entry.private_id === private_id);
    const seller = target?.owner ?? null;

    const charged = adjustTreasury(state, protocol_id, -paid);
    const settled = seller ? adjustCash(charged, seller, paid) : charged;

    return {
      ...settled,
      private_companies: settled.private_companies.map((entry) =>
        entry.private_id === private_id
          ? {
              ...entry,
              // `owner` and `owner_protocol_id` are MUTUALLY EXCLUSIVE --
              // `msg.rs::PrivateCompanyState` says so, and the readouts
              // branch on which one is set. Clearing the first while
              // setting the second is the whole transfer.
              owner: null,
              owner_protocol_id: protocol_id,
            }
          : entry,
      ),
    };
  }

  if ("PlaceStationToken" in msg) {
    /* Record the slot ONLY when city_index is in the message -- declining to write down information the app was given is not restraint. Both arrays written in the same order and the same breath.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #560 */
    const { protocol_id, q, r } = msg.PlaceStationToken;
    const placedCityIndex =
      typeof msg.PlaceStationToken.city_index === "number"
        ? msg.PlaceStationToken.city_index
        : null;
    // Idempotent per hex. Not a rules claim -- the contract decides whether a
    // second token there is legal. This is so a double-click cannot stack two
    // markers on one hex and charge for both, which would be a rendering bug
    // rather than a simulated rule.
    const owner = state.public_companies.find((company) => company.company_id === protocol_id);
    if (owner?.station_token_hexes.some(([hq, hr]) => hq === q && hr === r)) {
      return state;
    }
    /* The token price escalates: home free, second $40, third onward $100. stationTokenPrice is the same schedule the button quotes.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #239 */
    const placedCount = owner?.station_token_hexes.length ?? 0;
    const cost = stationTokenPrice(placedCount);
    const placed: GameStateResponse = {
      ...state,
      public_companies: state.public_companies.map((company) =>
        company.company_id === protocol_id
          ? {
              ...company,
              station_token_hexes: [...company.station_token_hexes, [q, r] as [number, number]],
              // Design note #560: together, always.
              station_tokens:
                placedCityIndex === null
                  ? company.station_tokens ?? null
                  : [
                      ...(company.station_tokens ?? []),
                      [q, r, placedCityIndex] as [number, number, number],
                    ],
            }
          : company,
      ),
    };
    return adjustBank(adjustTreasury(placed, protocol_id, -cost), cost);
  }

  if ("RunManualRoute" in msg) {
    // Running a route RECORDS; declaring pays. payout_strategy is deliberately not read here.
    // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #192
    const { protocol_id, path } = msg.RunManualRoute;
    // The flat nominal is now only the FALLBACK. With a map to read, the
    // figure comes from the stops the player actually selected, so building
    // a longer route through richer cities visibly pays more -- which is the
    // entire point of a route tester. See `sandboxRouteRevenue`.
    const earned = ctx?.mapGrid
      ? sandboxRouteRevenue(ctx.mapGrid, path, ctx.era ?? "Yellow")
      : SANDBOX_NOMINAL_ROUTE_REVENUE;
    /* The treasury credit moved to DeclareDividends, or Withhold credited it twice. #492a: a turn's routes ADD
       (one message per train).
       Design note #777: THE ZEROING MOVED TO THE TURN CHANGE and `ctx.resetRouteRevenue` is gone. It was a
       dispatch-time option, and the log carries only the message -- so it was absent on every replay, which
       is every path that reaches this arm. The figure accumulated across turns for the whole game.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #192 */
    const previous =
      Number(
        state.public_companies.find((entry) => entry.company_id === protocol_id)
          ?.last_route_revenue ?? 0,
      ) || 0;
    const running = Math.max(0, previous) + earned;
    return {
      ...state,
      public_companies: state.public_companies.map((company) =>
        company.company_id === protocol_id
          ? { ...company, last_route_revenue: String(running) }
          : company,
      ),
    };
  }

  if ("DeclareDividends" in msg) {
    /* The dividend buttons were a no-op. Withhold credits the corporation; Pay splits ten ways. The price
       ladder stays market.rs's.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #193
       Design note #706 CORRECTED THE SECOND HALF OF THAT SENTENCE, which read "players to cash, IPO to the
       treasury, bank pool to the bank" -- the two pools the wrong way round, stated plainly, for as long as
       this branch has existed. 1830: "Shares in the bank pool pay dividends to the corporate treasury. No
       payments are made for unsold initial offering shares." */
    const { protocol_id, distribute } = msg.DeclareDividends;
    const company = state.public_companies.find((entry) => entry.company_id === protocol_id);

    /* ==================================================================
     *  DESIGN NOTE 752: THE PHANTOM $1000, AND IT WAS A DECLARED ZERO
     * ==================================================================
     *
     * REPORTED: "a corporation's trains rusted with $500 in its treasury and the cheapest next train was
     * $630. On its turn it laid track and then was auto-skipped to Buy Trains, where it miraculously suddenly
     * had $1500 to make the purchase. This amount did not come from the player's cash."
     *
     * MY FIRST GUESS WAS RE-CAPITALISATION, ten times par. REPORTED BACK: "it definitely isn't
     * recapitalization: the company was pared at 72, so I don't know where the $1000 came from." $72 x 10 is
     * $720, which killed it outright -- and the instrument (#750) was already the right call, because the
     * actual writer is three lines below this one.
     *
     * THE CONDITION READ `stated > 0`, so a DECLARED ZERO fell through to the fallback. A trainless
     * corporation is auto-skipped past Routes and the game declares a forced $0 withhold on its behalf
     * (#668). The shell computes that zero correctly -- `dividendDeclaration` exists for exactly this and
     * #484 says so: "a skipped Routes step declares $0, not last turn's revenue". It then sends
     * `revenue_amount: "0"`, and this line threw it away and reached for `last_route_revenue` instead: the
     * figure from the last Operating Round the corporation actually ran, before its trains rusted. A withhold
     * credits the treasury, so the bank paid out $1000 for a run that did not happen.
     *
     * SO #486 WAS FIXED IN THE SHELL AND UNDONE HERE. Its own opening sentence describes this bug --
     * "the dispatch read `last_route_revenue` straight off the corporation -- a PREVIOUS turn's figure for a
     * corporation that skipped Routes, so a forced $0 withhold could move real money for a run that did not
     * happen" -- and the reducer's fallback quietly reinstated it for every client that replays the log. The
     * project's recurring shape once more: a rule corrected at one surface and left standing in the
     * authority.
     *
     * ABSENT IS NOT ZERO. The fallback still exists, because a message written before `revenue_amount` was
     * carried has no figure at all and guessing zero for those would silently cancel real dividends. What
     * changed is that an explicit `"0"` is now a FIGURE rather than a missing one. */
    /* Design note #775: THE ARITHMETIC MOVED TO `dividendSplit`, unchanged. Every rule this branch had
       settled -- #752's explicit zero, the trainless fallback, #706's two pools, the floor -- now lives in
       one module, because the LOG LINE and the TOAST were computing the same figures a second time from
       their own snapshot and getting a different answer. Reported as a payout notice showing double what was
       actually paid: two implementations, one of which moves money.
       THE REDUCER IS STILL THE AUTHORITY. It is the only caller that acts on the result; the describers only
       read it. What changed is that there is now one calculation for them to read. */
    const settlement = dividendSplit(state, protocol_id, msg.DeclareDividends.revenue_amount, distribute);
    if (!settlement || !company) return state;
    const { revenue } = settlement;

    if (!distribute) {
      return adjustTreasury(adjustBank(state, -revenue), protocol_id, revenue);
    }

    /* Design note #706: THE TWO POOLS WERE EXACTLY SWAPPED.
       1830: "Shares in the bank pool pay dividends to the corporate treasury. No payments are made for unsold
       initial offering shares."
       This paid `ipo_pool_percentage` INTO the treasury and let `bank_pool_percentage` stay with the bank --
       both wrong, and wrong in opposite directions, which is why the total still looked plausible. A
       corporation with shares unsold banked a slice it is not owed; one whose shares had been sold back into
       the pool lost a slice it is.
       IT MATTERS MOST EARLY AND LATE. A freshly floated corporation is mostly IPO, so it was collecting on
       nearly every dividend it declared; a corporation players have dumped into the pool is where the real
       rule pays, and it was collecting nothing. The bug rewarded exactly the position 1830 does not.
       THE BANK FUNDS EXACTLY WHAT IT PAID -- players plus the pool's slice, summed rather than reconstructed
       from `revenue` minus other slices. The old expression had to stay in step with two figures computed
       elsewhere, and did not. */
    let next = state;
    for (const share of settlement.players) {
      next = adjustCash(next, share.player, share.amount);
    }
    if (settlement.poolSlice > 0) {
      next = adjustTreasury(next, protocol_id, settlement.poolSlice);
    }
    // `ipo_pool_percentage` is deliberately absent: unsold shares pay nobody.
    return adjustBank(next, -settlement.totalPaid);
  }

  if (
    "AdvanceOperatingSubPhase" in msg ||
    "AcceptTrainOffer" in msg ||
    "RejectTrainOffer" in msg ||
    "RescindTrainOffer" in msg ||
    "ExecuteOperatingRound" in msg
  ) {
    /* The three offer messages are UNMODELLABLE here, not merely unmodelled: they address an offer_id and the register is its own query. An accepted offer settles via BuyTrainFromCorporation.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
    return state;
  }

  if ("BeginOperatingRound" in msg) {
    /* Design note #411: this set the round type and zeroed the cursor, and
       left `active_operating_order` at whatever it already held -- which
       from the zero state is `[]`, the empty queue that made the round
       unadvanceable. `beginOperatingRound` builds it. */
    return beginOperatingRound(state, ctx?.marketPriceFor, ctx?.marketMarkFor);
  }

  if ("UndoLastAction" in msg) {
    // Genuinely unmodellable: undo is a full replay of the contract's event
    // log, and the sandbox has no log. An explicit no-op rather than a
    // default-arm turn advance, which would make undo look like an action.
    return state;
  }

  // Any unconsidered ExecuteMsg variant. Advancing the turn keeps the loop alive, and a turn that moves wrongly is far easier to notice than a control that silently does nothing.
  // See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #2
  return advanceSeat(state);
}

/** Whether `phase` is one where seats act in order, as opposed to
 *  corporations. Exported for the toolbar, which labels the auto-follow
 *  target differently in each. */
export function isSeatDrivenRound(phase: RoundType): boolean {
  return phase !== "OperatingRound";
}

/* Floating is a threshold with a bookkeeping consequence, so it belongs here. #376: full capitalisation is ten times par, paid BY THE BANK -- that money already went in on the share purchases.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #363
   Design note #749: THE CONSTANT AND THE MEASURE MOVED TO `floatThreshold.ts`. They are re-exported so every
   existing importer keeps working, but the arithmetic now lives in one place -- the local
   `soldToPlayersPercent` here and a same-named one in `StockRoundPanel` computed the same wrong quantity two
   different ways, and each read as obviously correct on its own. */
export { FLOAT_THRESHOLD_PERCENT, FULL_CAPITALISATION_MULTIPLE } from "./floatThreshold";

/** Floats every corporation over the threshold. Returns the SAME state when nothing changed so callers can skip on identity. homeHexToAxial is injected (utils/ must not import components/).
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #416 */
export function applyFloatThreshold(
  state: GameStateResponse,
  homeHexToAxial: (label: string) => readonly [number, number] | null,
): GameStateResponse {
  let changed = false;
  // Design note #376: what the bank pays out this pass, in one debit.
  let capitalised = 0;

  const companies = state.public_companies.map((company) => {
    if (company.is_floated) return company;
    /* Design note #749: OUT OF THE IPO, not in players' hands. This read the sum of `player_holdings`, which
       is the same number until somebody sells and permanently smaller afterwards -- so a corporation whose
       shares had reached 60% out of the IPO by way of the Bank Pool never floated, and had no way to. */
    if (!metFloatThreshold(company)) return company;

    changed = true;

    /* Design note #376: ten times par, into a treasury that was empty. Added
       to whatever is there rather than assigned, so a company that somehow
       already holds money is not silently reset by floating. */
    const par = Number(company.par_value);
    const capital =
      Number.isFinite(par) && par > 0 ? par * FULL_CAPITALISATION_MULTIPLE : 0;
    capitalised += capital;
    const treasury = String((Number(company.treasury) || 0) + capital);

    /* The token is PROMPTED, not placed: the prompt is not asking which hex, it is making the player witness the placement. homeHexToAxial still decides whether a home hex RESOLVES.
       See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #416 */
    return { ...company, is_floated: true, treasury };
  });

  if (!changed) return state;
  // Design note #376: one debit for the whole pass, for the same reason
  // design note #329's payout banks once -- `adjustBank` floors at zero and
  // several separate calls against a nearly-empty bank would floor
  // differently from one call for the sum.
  return adjustBank({ ...state, public_companies: companies }, -capitalised);
}

/** A corporation that has floated and still owes its home station token.
 *  Design note #416: what the prompt is raised from. */
export interface PendingHomeToken {
  companyId: number;
  ticker: string;
  hexLabel: string;
  q: number;
  r: number;
  president: string | null;
}

/** Derived from the board, so a reload or a late poll cannot lose the prompt. Ordered by operating order; a company whose label does not resolve is absent rather than pending.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #416 */
export function pendingHomeTokens(
  state: GameStateResponse,
  homeHexToAxial: (label: string) => readonly [number, number] | null,
): PendingHomeToken[] {
  const rank = new Map(state.active_operating_order.map((id, index) => [id, index]));

  const pending = state.public_companies.flatMap((company) => {
    if (!company.is_floated || !company.home_hex_label) return [];
    const axial = homeHexToAxial(company.home_hex_label);
    if (!axial) return [];
    const [q, r] = axial;
    const already = company.station_token_hexes.some(([hq, hr]) => hq === q && hr === r);
    if (already) return [];
    return [
      {
        companyId: company.company_id,
        ticker: company.ticker,
        hexLabel: company.home_hex_label,
        q,
        r,
        president: company.president,
      },
    ];
  });

  return pending.sort(
    (a, b) =>
      (rank.get(a.companyId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.companyId) ?? Number.MAX_SAFE_INTEGER) || a.companyId - b.companyId,
  );
}

/** The other half of the prompt, and IDEMPOTENT -- a double-click or replayed dispatch cannot stack two tokens on one hex.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #416 */
export function placeHomeStationToken(
  state: GameStateResponse,
  companyId: number,
  q: number,
  r: number,
  /** Design note #560: WHICH city on the hex. `null` leaves the renderer's
   *  heuristic in charge, which is right for a single-city hex and is the
   *  only honest answer when the click could not be resolved. */
  cityIndex: number | null = null,
  /** Design note #769a: the board's label lookup, injected on #7's rule. Absent means the seat is not
   *  released -- the honest answer for a caller that cannot tell whether anything is still owed. */
  homeHexToAxial?: (label: string) => readonly [number, number] | null,
): GameStateResponse {
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company || !company.is_floated) return state;
  if (company.station_token_hexes.some(([hq, hr]) => hq === q && hr === r)) return state;

  const placed: GameStateResponse = {
    ...state,
    public_companies: state.public_companies.map((entry) =>
      entry.company_id === companyId
        ? {
            ...entry,
            // Home token first, matching `grant_home_station_token`'s own
            // ordering -- several readers take `[0]` as "the home station".
            station_token_hexes: [[q, r] as [number, number], ...entry.station_token_hexes],
            /* The slot registry, written in the same order and the same breath -- a partial index is worse than none, because the renderer trusts it.
               See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #560 */
            station_tokens:
              cityIndex === null
                ? entry.station_tokens ?? null
                : [
                    [q, r, cityIndex] as [number, number, number],
                    ...(entry.station_tokens ?? []),
                  ],
          }
        : entry,
    ),
  };

  /* ==================================================================
     DESIGN NOTE 769a: THE PLACEMENT COMPLETES THE TURN THE PURCHASE STARTED
     ==================================================================
     #769 holds the seat on the President when their purchase floats a corporation, so the round does not
     announce somebody else's turn and then refuse everything they try. That hold needs a release, and the
     placement is it -- otherwise the President keeps the seat and takes a second turn, which is a worse bug
     than the one #769 fixed.
     ONE TURN, TWO MESSAGES. Floating and placing are a single event in 1830 (#763); we split them into two
     messages so the player witnesses the placement, and this is where the halves are put back together.
     GUARDED ON THE ROUND AND ON THE REMAINING DEBT. A Stock Round only: nothing else advances a seat this
     way. And only when no OTHER corporation still owes a token -- two floats in one purchase is not a board
     1830 reaches, but a release that fired on the first of two would hand the turn on with an obligation
     still outstanding, which is exactly the state this pair of notes exists to prevent. */
  if (state.current_round_type !== "StockRound") return placed;
  if (homeHexToAxial && pendingHomeTokens(placed, homeHexToAxial).length > 0) return placed;
  return advanceSeat(placed);
}

/* Private revenue never became money: revenue_per_or was printed as a property and nothing paid it. #328: once per ROUND, not once per corporation. #329: the bank pays; unowned, closed and corporate-owned are handled distinctly.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #327 */
export interface PrivatePayout {
  privateId: number;
  privateName: string;
  amount: number;
  /** Exactly one of these is set -- see design note #329. */
  toPlayer: string | null;
  toCompanyId: number | null;
}

export interface PrivatePayoutResult {
  state: GameStateResponse;
  payouts: PrivatePayout[];
  /** What left the bank in total, for the caller's summary line. */
  total: number;
}

/** One round's private income. Same state and an empty list when nothing is owed, so the caller can skip its log write on identity.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #327 */
export function applyPrivateRevenue(state: GameStateResponse | null): PrivatePayoutResult | null {
  if (!state) return null;

  const payouts: PrivatePayout[] = [];
  for (const priv of state.private_companies) {
    if (priv.closed) continue;
    const amount = Number(priv.revenue_per_or) || 0;
    if (amount <= 0) continue;

    if (priv.owner_protocol_id !== null && priv.owner_protocol_id !== undefined) {
      payouts.push({
        privateId: priv.private_id,
        privateName: priv.name,
        amount,
        toPlayer: null,
        toCompanyId: priv.owner_protocol_id,
      });
    } else if (priv.owner) {
      payouts.push({
        privateId: priv.private_id,
        privateName: priv.name,
        amount,
        toPlayer: priv.owner,
        toCompanyId: null,
      });
    }
  }

  if (payouts.length === 0) return { state, payouts, total: 0 };

  let next = state;
  let total = 0;
  for (const payout of payouts) {
    total += payout.amount;
    next = payout.toPlayer
      ? adjustCash(next, payout.toPlayer, payout.amount)
      : adjustTreasury(next, payout.toCompanyId as number, payout.amount);
  }
  // Design note #329: the bank funds it, in one write rather than one per
  // private -- `adjustBank` floors at zero, and four separate calls against
  // a nearly-empty bank would floor differently from one call for the sum.
  next = adjustBank(next, -total);

  return { state: next, payouts, total };
}

/* The B&O private grants the 20% President's Certificate free and sets par from the winner's choice; it does NOT float the corporation. #399: the par is taken WITH the grant, because an unparred presided company is a broken state.
   See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #354 */
export function grantBOPresidency(
  state: GameStateResponse,
  winner: string,
  /** Design note #399: the winner's chosen par, collected before this runs.
   *  A company cannot be presided over and priceless at the same time. */
  parValue: string,
  boTicker = "B&O",
): GameStateResponse {
  const bo = state.public_companies.find((entry) => entry.ticker === boTicker);
  if (!bo || bo.president !== null) return state;

  return {
    ...state,
    public_companies: state.public_companies.map((entry) => {
      if (entry.company_id !== bo.company_id) return entry;
      const held =
        entry.player_holdings.find((h) => h.player === winner)?.percentage ?? 0;
      return {
        ...entry,
        president: winner,
        // Design note #399: set here, with the certificate, so the pair
        // cannot come apart.
        par_value: parValue,
        ipo_pool_percentage: Math.max(
          0,
          entry.ipo_pool_percentage - SANDBOX_PRESIDENT_PERCENTAGE,
        ),
        player_holdings: [
          ...entry.player_holdings.filter((h) => h.player !== winner),
          { player: winner, percentage: held + SANDBOX_PRESIDENT_PERCENTAGE },
        ],
        total_shares_issued:
          entry.total_shares_issued +
          SANDBOX_PRESIDENT_PERCENTAGE / SANDBOX_SHARE_PERCENTAGE,
      };
    }),
  };
}

/** A named function with a return value, because an inline version survived being switched off entirely -- every source-text assertion still matched. #467: the branches ask whether the company HAS a home, since #416 means no float ever gains a token here.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #400 */
export function describeFloat(
  previous: { is_floated: boolean; station_token_hexes?: ReadonlyArray<unknown> | null },
  company: {
    ticker: string;
    treasury: string;
    is_floated: boolean;
    home_hex_label?: string | null;
    station_token_hexes?: ReadonlyArray<unknown> | null;
  },
): string | null {
  if (previous.is_floated || !company.is_floated) return null;

  if (company.home_hex_label) {
    return `${company.ticker} floated with $${company.treasury}. Its home station on ${company.home_hex_label} must now be placed.`;
  }

  /* NNH has no home hex on this board (see `applyFloatThreshold`), so it
     floats without one. Said outright rather than leaving the sentence half
     finished, which would read as a placement that failed. */
  return `${company.ticker} floated with $${company.treasury}. It has no home hex on this board, so no home token is placed.`;
}

/** "Schuylkill Valley pays $5 to Alice." One line per payout, because the
 *  Activity Log is a ledger and a summarised "privates paid $70" cannot be
 *  reconciled against any individual balance on screen. */
export function describePrivatePayout(
  payout: PrivatePayout,
  labelForAddress: (address: string) => string,
  labelForCompany: (companyId: number) => string,
): string {
  const recipient = payout.toPlayer
    ? labelForAddress(payout.toPlayer)
    : labelForCompany(payout.toCompanyId as number);
  return `${payout.privateName} pays $${payout.amount} to ${recipient}.`;
}

/* ------------------------------------------------------------------ */
/* The board: laying a tile in sandbox                                */
/* ------------------------------------------------------------------ */

/** The tile grid is a separate query document, so it gets its own reducer. The whole tiles array is rebuilt because the renderer's draw effect watches identity. Legality stays hexmap::execute_lay_tile's.
 *  See docs/ai_architecture/sandbox_reducer.md - sandboxSession.ts #0 */
export function applySandboxLayTile(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  tileId: number,
  orientation: number,
  /** Design note #757: the SAME refusal `applySandboxAction` applies, so the tile grid and the game state
   *  cannot disagree about whether a lay happened. Absent means no opinion. */
  layRefused?: (q: number, r: number, tileId: number, orientation: number) => boolean,
): MapGridResponse {
  /* Unchanged, by identity, for #712's reason -- and because the caller is a `setMapGrid` updater, where
     returning the same reference is also what stops a refused lay from repainting the board. */
  if (layRefused?.(q, r, tileId, orientation) === true) return mapGrid;

  const catalogEntry = TILE_CATALOG_BY_ID.get(tileId);
  const existing = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);

  const placed: MapTileEntry = {
    q,
    r,
    tile_id: tileId,
    orientation,
    // `paths` drives the track splines. Passing the catalog's own base
    // (pre-rotation) pairs matches exactly what the chain returns, so
    // `rotatePaths` downstream behaves identically either way.
    paths: catalogEntry?.paths ?? null,
    // `revenue` is what a stop on this hex pays. Serialised as a STRING on
    // the wire because the backend field is `Uint128`; matching that here
    // keeps `chainTileRevenue`'s single parse site honest rather than
    // handing it a number only the sandbox ever produces.
    revenue: catalogEntry?.revenue === undefined ? undefined : String(catalogEntry.revenue),
    // `landmark` is a property of the HEX, not of the tile sitting on it --
    // Boston is still Boston after its yellow tile is upgraded to green. So
    // an upgrade carries the existing value forward rather than clearing it,
    // and a first lay on a plain hex has none.
    landmark: existing?.landmark ?? null,
  };

  // An upgrade REPLACES the tile already on that hex rather than stacking a
  // second entry on the same coordinate -- two entries at one `(q, r)` would
  // draw both tiles on top of each other, and `hexHasLaidTile`'s membership
  // test would still pass after a hypothetical removal.
  const kept = mapGrid.tiles.filter((tile) => tile !== existing);

  return { ...mapGrid, tiles: [...kept, placed] };
}
