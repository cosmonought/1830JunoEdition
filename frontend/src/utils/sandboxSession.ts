// frontend/src/utils/sandboxSession.ts
//
// The Offline Sandbox's thin local reducer -- enough state motion to play a
// hotseat loop, and deliberately not one line more.
//
// ===================================================================
//  DESIGN NOTE 0: WHAT THIS IS NOT, AND WHY THAT IS THE POINT
// ===================================================================
//
// THIS IS NOT A RULES ENGINE. The Rust CosmWasm contract is the single
// source of truth for every rule in 1830, and nothing in this file may
// become a second opinion about any of them.
//
// The temptation here is obvious and should be resisted explicitly: it
// would not be hard to make the sandbox check the 60% float threshold, or
// move a stock price, or refuse a purchase that breaks the certificate
// limit. Every one of those would be a rule reimplemented in TypeScript,
// living beside a Rust implementation that is authoritative, and the two
// would drift. Not "might drift" -- would. The contract has changed
// substantially across five batches of rules work; a TypeScript mirror of
// it would have silently rotted at every one of them, and the sandbox would
// then teach a developer behaviour the chain does not have. That failure is
// worse than no sandbox at all, because it looks like it works.
//
// So this reducer moves only what it can move WITHOUT knowing any rules:
//
//   - whose turn it is (a pointer into a fixed seat list)
//   - the consecutive-pass streak (a counter, and when it wraps)
//   - the Operating Round corporation cursor (a pointer into a fixed queue)
//   - cash and share counts, by the amount the CALLER states
//
// That last one is the important boundary. When the sandbox processes a
// `BuyStock`, it does not decide what the share costs -- it cannot, because
// price depends on par values, market position and the President's
// Certificate rule, all of which live in Rust. It applies a nominal debit so
// the number on screen visibly changes and the UI re-renders. The figure is
// a plausible placeholder, not a computed price, and `SANDBOX_NOMINAL_*`
// below is named to make that unmistakable at the call site.
//
// ===================================================================
//  DESIGN NOTE 1: WHY A REDUCER AND NOT MUTATION IN PLACE
// ===================================================================
//
// Every function here returns a NEW `GameStateResponse` rather than editing
// the one it was given. React's rendering depends on identity comparison --
// a mutated object is the same object, and half the dashboard would keep
// showing stale values while the other half updated, which is a far more
// confusing bug than a control that does nothing. Returning fresh objects
// costs nothing at four players and removes the failure mode entirely.
//
// ===================================================================
//  DESIGN NOTE 2: WHY IT TAKES THE REAL `GameplayExecuteMsg`
// ===================================================================
//
// The reducer is driven by the exact same message union the live dispatch
// path sends to the chain, not by a parallel "sandbox action" type. That
// means a new `ExecuteMsg` variant cannot be wired into the app while
// silently bypassing the sandbox: it shows up here as a non-exhaustive
// match, and the default arm treats it as a no-op turn-advancing action
// rather than pretending to understand it.

import type {
  GameStateResponse,
  RoundType,
  WaterfallMiniAuctionStatus,
  WaterfallPrivateStatus,
  WaterfallStateResponse,
} from "./gameState";
// NOTE: `actingSeatIndex` ("which seat may act right now") deliberately does
// NOT live here. It is a question about the CONTRACT's state, and the live
// dashboard asks it too (`App.tsx`'s `isMyTurn`) -- defining it in a
// sandbox-only module and importing it into the production path would point
// the dependency the wrong way round. It lives in `gameState.ts`; this file
// does not need it.
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { TILE_CATALOG_BY_ID, type TileColorTier } from "../components/hexTileCatalog";
import { archetypeForHex, hexRouteValue } from "../components/hexGeometry";
import { depotInventory, derivePhase } from "./gamePhase";
import { stationTokenPrice } from "./stationTokens";
import type { SandboxMarketMark, SandboxMarketPrices } from "./sandboxState";
import {
  HEX_START_VALUE_OVERRIDE,
  OFFBOARD_LABELS,
  OFFBOARD_REVENUE,
  STATIC_BOARD_HEXES,
  offboardValueForEra,
} from "../components/hexBoardData";

/** A nominal share price, applied so a `BuyStock`/`SellStock` visibly moves
 *  the cash column. NOT a computed price -- see design note 0. The real
 *  figure depends on par value, market position and whether the purchase is
 *  the 20% President's Certificate, none of which this file knows. */
export const SANDBOX_NOMINAL_SHARE_PRICE = 67;

/** A nominal train cost, same reasoning as the share price above. */
export const SANDBOX_NOMINAL_TRAIN_COST = 80;

/** A nominal terrain cost for a tile lay. */
export const SANDBOX_NOMINAL_TILE_COST = 20;

/** A nominal station-token / private-purchase cost. */
export const SANDBOX_NOMINAL_TOKEN_COST = 40;

/** One certificate, as a percentage of the corporation. 1830's ordinary
 *  share is 10%; the President's 20% double certificate is a rule this
 *  reducer does not model and the contract does. */
export const SANDBOX_SHARE_PERCENTAGE = 10;

/** What a full round of passes knocks off the cheapest private -- design
 *  note #271. `auction::MIN_BID_INCREMENT`'s own $5 step, reused because the
 *  markdown and the bid increment are the same unit of money in this
 *  auction and two different literals would drift. */
export const WATERFALL_PASS_MARKDOWN = 5;

/** A nominal figure for what one route earns, so the Operating Round table's
 *  revenue column visibly fills in. Not a traced route value -- real revenue
 *  comes from `pathfinding.rs`'s search over actual laid track. */
export const SANDBOX_NOMINAL_ROUTE_REVENUE = 90;

/** Adds `delta` to `player`'s cash, flooring at zero.
 *
 *  Cash is a decimal STRING on the wire (`Uint128` does not survive a JS
 *  number), so this parses, adjusts and re-serialises rather than doing
 *  arithmetic on the field directly. Flooring at zero rather than allowing a
 *  negative keeps the sandbox from rendering an impossible balance -- the
 *  real contract would simply have refused the action. */
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

/** Adds `delta` to one corporation's treasury, flooring at zero.
 *
 *  Corporate cash is where every Operating Round action is actually charged,
 *  so without this a tile lay or a train purchase would leave no visible
 *  trace at all and the OR panels would look inert. Same string-arithmetic
 *  and same zero floor as `adjustCash`, for the same reasons. */
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

/** Moves the seat pointer on by one, wrapping, and clears the pass streak.
 *
 *  This is the shape of every committing action in a seat-driven round: the
 *  turn moves and any run of passes is broken. It mirrors
 *  `trading::advance_turn` in the contract, which is the one piece of turn
 *  bookkeeping simple enough to reproduce faithfully. */
function advanceSeat(state: GameStateResponse): GameStateResponse {
  const count = state.player_addresses.length;
  if (count === 0) return state;
  return {
    ...state,
    active_player_index: (state.active_player_index + 1) % count,
    consecutive_passes: 0,
  };
}

/** Moves the Operating Round corporation cursor on by one.
 *
 *  Wraps back to the start of the queue rather than ending the round: the
 *  real end-of-round bookkeeping (`operations::advance_operating_round_turn`)
 *  decides between another sub-round and closing the macro round using paced
 *  scheduling this file has no business reproducing. Wrapping keeps the
 *  hotseat loop running so every corporation's panel can be reached. */
function advanceCorporation(state: GameStateResponse): GameStateResponse {
  const queue = state.active_operating_order.length;
  if (queue === 0) return state;
  return {
    ...state,
    active_corporation_index: (state.active_corporation_index + 1) % queue,
  };
}

/** Records a pass and, if that completes a full round of them, ends the
 *  Stock Round the way the contract does.
 *
 *  The only rule-shaped thing in this file, and it is here because it is not
 *  really a rule -- it is a counter reaching the player count. What it does
 *  NOT do is the part that IS a rule: no sold-out price rise, no Priority
 *  Deal reassignment, no lockout clearing. Those live in
 *  `trading::conclude_stock_round`. */
function recordPass(state: GameStateResponse): GameStateResponse {
  const count = state.player_addresses.length;
  if (count === 0) return state;

  const streak = state.consecutive_passes + 1;
  const advanced: GameStateResponse = {
    ...state,
    active_player_index: (state.active_player_index + 1) % count,
    consecutive_passes: streak,
  };

  if (streak < count) return advanced;

  // A full round of passes. In the auction this runs the waterfall; in a
  // Stock Round it ends the round. The sandbox marks the boundary by
  // resetting the streak so the loop keeps moving, and leaves the
  // consequences to the contract.
  return { ...advanced, consecutive_passes: 0 };
}

/** Applies one dispatched gameplay message to the local sandbox state.
 *
 *  Returns a NEW state object (design note 1). Unknown or unmodelled
 *  messages fall through to the default arm, which advances the turn --
 *  the safest generic behaviour, since almost every gameplay action in 1830
 *  ends the actor's turn, and a hotseat loop that stops moving is the one
 *  outcome that makes the sandbox useless. */
/* ==================================================================
 *  SANDBOX ROUTE REVENUE -- A SUM, NOT A PATHFINDER
 * ==================================================================
 *
 * This TOTALS the printed value of the stops the player selected. It is
 * arithmetic over data already on screen, and it is deliberately not the
 * beginning of a routing engine.
 *
 * WHAT IT DOES NOT DO, and must not grow to do -- every one of these is
 * `pathfinding.rs`'s job and the contract remains the only authority:
 *
 *   - CONNECTIVITY. It never asks whether consecutive stops share track,
 *     or any track at all. Click two opposite corners of the board and it
 *     will happily add them up.
 *   - The two-revenue-centre minimum, or train distance limits.
 *   - Whether the corporation has a token on the route, or may pass
 *     through a city blocked by somebody else's.
 *   - Which of a two-city hex's stations a `city_node` actually reaches --
 *     both cities on one hex price the same here.
 *
 * So the figure answers "what are these stops worth", not "is this a legal
 * route worth this much". That is the honest scope for a tester whose whole
 * job is letting a developer see the selection change a number, and it is
 * why the result feeds `last_route_revenue` -- a display field -- rather
 * than anything that gates an action.
 *
 * PRECEDENCE mirrors `drawTileOverlays`' own: the chain's `MapTileEntry`
 * revenue first (a laid tile carries its real figure), then the catalog
 * mirror, then the board's per-hex printed override, then the off-board
 * terminal's era-scaled box. A hex matching none of those is bare track and
 * scores zero, which is correct rather than a gap.
 */
const HEX_COORDS_BY_LABEL: ReadonlyMap<string, { q: number; r: number }> = new Map(
  STATIC_BOARD_HEXES.map((hex) => [hex.label, { q: hex.q, r: hex.r }]),
);

/* ==================================================================
 *  DESIGN NOTE 190: EVERY ROUTE WAS WORTH $0, AND THE CAUSE WAS A
 *  SECOND OPINION ABOUT WHAT A HEX PAYS
 * ==================================================================
 *
 * This function used to price a hex from three tables it consulted itself:
 * the laid tile's `revenue`, then `HEX_START_VALUE_OVERRIDE`, then the
 * off-board ladder. That is a THIRD implementation of "what is this hex
 * worth" -- `hexGeometry.hexRouteValue` is the one the board's own value
 * badges and hover tooltips already use -- and it disagreed with the board
 * in the two cases a player is most likely to click:
 *
 *   1. PREPRINTED GRAY HEXES. Lansing, Rochester, Richmond, Kingston,
 *      Atlantic City and Mansfield all carry printed track and a real
 *      city/town marker, and NONE of them is in `HEX_START_VALUE_OVERRIDE`
 *      (that table exists for the handful of hexes whose value differs from
 *      the flat terrain bucket). They fell through every branch and scored
 *      zero. Since preprinted track is the only track on a fresh board,
 *      almost every early route was a chain of $0 stops.
 *
 *   2. LAID TILES WITH `revenue: "0"`. `Number.isFinite(0)` is true, so a
 *      plain connector tile RETURNED zero and short-circuited the printed
 *      value underneath it -- upgrading a $30 city to a yellow tile made the
 *      city stop paying.
 *
 * The precedence below is explicit and delegates the board-knowledge half to
 * `hexRouteValue` rather than restating it. Zero is now a FALL-THROUGH at
 * every tier instead of an answer, because no revenue centre in 1830 is
 * worth nothing -- a genuine zero means "this is plain track", which is what
 * the final `return 0` says.
 */

/** One stop's printed value. See the note above for the precedence order
 *  and design note #156 for the long list of things this deliberately does
 *  not check. */
/* ==================================================================
 *  DESIGN NOTE 264: A TOWN IS NOT A TERMINUS
 * ==================================================================
 *
 * REPORTED RULE CORRECTION: the manual route validator accepted towns as
 * route endpoints. 1830 does not.
 *
 * A route runs between two CITIES -- or off-board red areas, which count as
 * cities for this purpose. Towns are passed THROUGH: they add their revenue
 * to a run and cannot begin or end one. The earlier check asked "does this
 * hex pay anything", which is the right question for REVENUE and the wrong
 * one for TERMINATION, and towns are exactly the hexes where the two answers
 * differ.
 *
 * `archetypeForHex` already draws the distinction the board draws -- a white
 * station circle versus a small dark dit -- across all four sources of
 * track, so this asks it rather than re-deriving city-ness from terrain
 * enums, gray-hex markers and tile catalogs separately.
 *
 * OFF-BOARD HEXES ARE TERMINI and are handled first, because
 * `archetypeForHex` reports no city for them: a red area is a destination
 * rather than a station, with its own era-scaled value. Every real route in
 * 1830 that leaves the map ends on one.
 */
/**
 * Whether this hex is a REVENUE CENTRE -- a city, a town, or a red
 * off-board terminal -- and therefore costs a train one of its stops.
 *
 * Design note #289: asked of the board rather than of the price list. The
 * companion to `isRouteTerminusHex` below, which has always worked this way
 * and which this now agrees with: everything that may END a route is a
 * stop, plus towns, which are stops a route may only pass through.
 */
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
  // Off-board terminals first: their value RISES with the era, and
  // `hexRouteValue` deliberately returns `null` for them precisely because
  // that ladder is a different value system from the terrain one.
  const offboard = OFFBOARD_LABELS[hexLabel];
  if (offboard) {
    const tiers = OFFBOARD_REVENUE[offboard];
    if (tiers) return offboardValueForEra(tiers, era);
  }

  const coords = HEX_COORDS_BY_LABEL.get(hexLabel);
  if (!coords) return 0;

  const laid = mapGrid.tiles.find((tile) => tile.q === coords.q && tile.r === coords.r);
  if (laid) {
    // The chain's own figure wins where there is one -- but only when it is
    // an actual figure. A `"0"` is a plain connector, not a priced stop.
    const chainValue = laid.revenue == null ? NaN : Number(laid.revenue);
    if (Number.isFinite(chainValue) && chainValue > 0) return chainValue;
    const entry = TILE_CATALOG_BY_ID.get(laid.tile_id);
    if (typeof entry?.revenue === "number" && entry.revenue > 0) return entry.revenue;
  }

  // The hex's own printed exception (New York $40, Boston/Baltimore $30,
  // Altoona's real $10), ahead of the flat terrain bucket below.
  const printed = HEX_START_VALUE_OVERRIDE[hexLabel];
  if (typeof printed === "number" && printed > 0) return printed;

  // The board's own answer: a laid tile's terrain, a landmark, a gray hex's
  // city/town marker, an OO pair. The single source this file no longer
  // duplicates.
  const boardValue = hexRouteValue(coords.q, coords.r, mapGrid);
  if (typeof boardValue === "number" && boardValue > 0) return boardValue;

  return 0;
}

/* ==================================================================
 *  DESIGN NOTE 156: A TRAIN COUNTS REVENUE CENTRES, NOT HEXES
 * ==================================================================
 *
 * This is the single most commonly misunderstood rule in 18xx, and this
 * frontend had it wrong: it compared a train's number against
 * `routePoints.length - 1`, the count of HOPS between selected hexes. So a
 * 2-train appeared to be limited to travelling two hexes.
 *
 * The real rule -- and the one `pathfinding.rs` already implements -- is
 * that an N-train may visit up to N REVENUE CENTRES, and may cross any
 * amount of plain track in between. A 2-train can legally run clear across
 * the board provided it stops at exactly two paying places.
 *
 * The contract's own version, for comparison: it carries
 * `max_revenue_centres`, increments `route.revenue_centres` only when
 * entering a hex whose `is_revenue_centre` is set, and marks that flag as
 * `!value.is_zero()` -- a hex pays, or it is track. `centres` below is the
 * same predicate over the same per-stop values, which is why the count and
 * the revenue come out of one walk rather than two.
 */
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
  /* ==================================================================
   *  DESIGN NOTE 274: WHICH STOPS PAID, AND HOW MUCH EACH
   * ==================================================================
   *
   * `revenue` is a total, and a total cannot be read back. A player looking
   * at "$90" over a nine-hex route has no way to tell whether that is three
   * cities at $30 or one city and a long walk -- and the route readout was
   * printing every hex it crossed, most of which contribute nothing, so the
   * one thing worth reading was buried in the one thing that is not.
   *
   * The stops carry their own figures now, in route order, so the panel can
   * render "D6 ($30) -> F8 ($20) -> H10 ($40)" and the arithmetic is on
   * screen rather than asserted. Deduplicated exactly as `revenue` is --
   * a hex pays once per pass however many times the route touches it, so a
   * stop appears once here too and the list always sums to `revenue`. */
  stops: ReadonlyArray<{ hex: string; value: number }>;
}

/** One walk, three figures -- see design note #156. */
export function sandboxRouteBreakdown(
  mapGrid: MapGridResponse,
  path: readonly { hex: string; city_node?: number }[],
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
    revenue += hexStopValue(mapGrid, stop.hex, era);
    /* ==================================================================
     *  DESIGN NOTE 289: A STOP IS WHAT A HEX *IS*, NOT WHAT IT PAYS
     * ==================================================================
     *
     * REPORTED: a 2-train is allowed to run E23 -> F24 -> F22.
     *
     * The report blamed F24 -- Fall River, a preprinted gray town -- on the
     * theory that gray towns were not being recognised. Measured, F24 is
     * fine: it prices at $10 and counts. The hex that does not count is
     * F22, a printed CITY that prices at $0, so the route reported two
     * stops for three revenue centres and a 2-train was waved through.
     *
     * The cause is this line, which counted a centre when `value > 0`.
     * That conflates two questions:
     *
     *   IS THIS A STOP?   A property of the hex -- does it hold a city, a
     *                     town, or a red off-board terminal. Fixed by the
     *                     board.
     *   WHAT DOES IT PAY? A number, which varies by era, by tile laid, and
     *                     which this build does not always know.
     *
     * Fourteen of the board's printed cities and seven of its towns carry
     * no value until a tile is laid on them. Every one of those was
     * invisible to the capacity check while being perfectly visible as a
     * route terminus -- `isRouteTerminusHex` has always asked the
     * ARCHETYPE. The two tests disagreed about the same hex, and the
     * capacity one was the lenient half.
     *
     * Counting the archetype makes them agree. A $0 city still costs the
     * train a stop, which is the rule, and it still appears in the readout
     * -- at $0, which is honest about a hex nobody has built up yet. */
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

/** Optional board context for the reducer.
 *
 *  Only `RunManualRoute` reads it, and only to TOTAL the printed values of
 *  the stops the player selected. Optional so every existing caller and
 *  every other message is unaffected, and so the reducer keeps working with
 *  no board at all (falling back to the flat nominal). */
export interface SandboxActionContext {
  mapGrid?: MapGridResponse;
  /** Scales red off-board terminals, whose value rises with the era. */
  era?: TileColorTier;
  /** Design note #273: what one 10% certificate of the corporation being
   *  traded costs right now, from the live market atom. Handed in rather
   *  than looked up because the market is a SEPARATE mock (design note
   *  #272) and this reducer must not reach across into it -- the caller
   *  advances both and is the one place that sees both.
   *
   *  Omitted falls back to `SANDBOX_NOMINAL_SHARE_PRICE`, which is what
   *  every trade cost before the chart could move. */
  sharePrice?: number;
}

/** Moves `percentage` out of one of a corporation's pools and into
 *  `holder`'s holding -- or, with a negative `percentage`, back the other
 *  way.
 *
 *  Pure bookkeeping. It clamps the pool at zero rather than validating: if
 *  a caller asks for more than the pool holds, the sandbox takes what is
 *  there instead of throwing, because refusing would be enforcing a rule
 *  and the contract is the thing that enforces rules. The clamp exists so
 *  the mock state cannot go negative and start rendering nonsense. */
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

/* ==================================================================
 *  DESIGN NOTE 194: A BANK PURCHASE HAS TO CONSUME DEPOT STOCK
 * ==================================================================
 *
 * `BuyHardwareFromPool` charged a flat `SANDBOX_NOMINAL_TRAIN_COST` ($80,
 * the 2-train's price, reached for once and never revisited) and added
 * nothing to the roster. Two things followed from that, both visible:
 *
 *   - EVERY TRAIN COST $80. Buying a 5-train took $80 out of a treasury
 *     that should have lost $450.
 *   - THE DEPOT NEVER EMPTIED. `depotInventory` derives each tier's
 *     remaining stock from what corporations OWN, so a purchase that added
 *     no train left the supply figure frozen. The quantity cap the new
 *     purchase panel enforces would have had nothing to count down, the
 *     phase-shift warning could never fire, and the depot's own
 *     cheapest-first queue could never advance a tier.
 *
 * The tier is not chosen here -- `depotInventory` already applies 1830's
 * strict cheapest-first queue rule, so "the train the depot will sell" is
 * the first row with stock left. Reading it rather than deriving a second
 * answer is what keeps this a bookkeeping helper instead of a rules engine.
 */
/* ==================================================================
 *  DESIGN NOTE 284: A PHASE CHANGE IS AN EVENT, NOT A LABEL
 * ==================================================================
 *
 * REPORTED: phase changes do not purge rusted trains or trim fleets when
 * limits decrease.
 *
 * They did not, and the gap was invisible because everything AROUND it
 * worked. `derivePhase` reads the phase off the highest train in play,
 * `depotInventory` marks a tier `rusted` once the trigger tier is current,
 * and the chips and countdowns all render correctly. So the UI said "2-
 * trains have rusted" while every corporation's roster still held them, and
 * the fleet counter still charged them against the limit.
 *
 * A rust is a STATE CHANGE, and nothing was performing it. The displays
 * were describing a transition the model had never made.
 *
 * THREE THINGS FIRE, IN THIS ORDER, and the order is load-bearing:
 *
 *   1. RUST. The first 4-train destroys every 2-train; the first 6
 *      destroys every 3 AND every 4. `RUSTED_BY` in `gamePhase.ts` is the
 *      one table, read rather than restated.
 *   2. TRIM. 1830's limit falls to 3 in Phase 4 and 2 from Phase 5, and a
 *      corporation over the new limit discards down to it -- cheapest
 *      first, because the rules make the president choose and the cheapest
 *      is the choice a player would defend.
 *   3. Rust before trim, always. Rusting usually does the trimming for
 *      free (the fleet that was over the limit was over it BECAUSE of the
 *      trains that just died), and trimming first would discard a train
 *      the rust was about to take anyway.
 *
 * SCRAPPED TRAINS GO NOWHERE. 1830 returns a discarded train to the bank
 * pool for resale, but this build's depot is derived from what is OWNED
 * (`gamePhase.ts` design note #4) rather than stored as a count -- so
 * removing a train from a roster already puts it back in the depot's
 * arithmetic. Writing it somewhere else as well would double it.
 */

/** Rust order, cheapest first -- the discard preference too. */
const TIER_SEQUENCE: readonly string[] = ["2", "3", "4", "5", "6", "D"];

const TIER_COST: Readonly<Record<string, number>> = {
  "2": 80, "3": 180, "4": 300, "5": 450, "6": 630, D: 1_100,
};

/** Which tiers the arrival of `tier` destroys.
 *
 *  Inverted from `gamePhase.ts`'s `RUSTED_BY` rather than restated: that
 *  table drives every rust readout on screen, and a second copy here is a
 *  second thing to keep in step with 1830. */
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

/**
 * Applies a phase change's consequences to every corporation.
 *
 * `arrivingTier` is the tier just bought. Returns the state unchanged when
 * that purchase triggers nothing, which is the common case -- most
 * purchases are not the first of their tier.
 */
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

  return changed ? { ...state, public_companies: companies } : state;
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

  /* ==================================================================
   *  DESIGN NOTE 284b: ONLY ON THE PURCHASE THAT CHANGES THE PHASE
   * ==================================================================
   *
   * The first cut applied the consequences to EVERY depot purchase, and it
   * deadlocked the sandbox in a way worth recording, because the mechanism
   * is peculiar to this build.
   *
   * The depot's remaining stock is DERIVED from what corporations own
   * (`gamePhase.ts` design note #4) rather than stored as a count. So
   * trimming a fleet does not merely discard a train -- it puts that train
   * back into the depot's arithmetic. A corporation buying its fifth
   * 2-train against a limit of four was trimmed straight back to four, the
   * depot read one more 2-train available, and the next purchase repeated
   * it. Forty purchases later the phase had not moved off 2. Caught by an
   * end-to-end loop that expected a 4-train to arrive and watched it never
   * happen.
   *
   * The rule was always about a phase CHANGE, so it fires on one: the
   * arriving train is compared against the phase before it landed, and
   * nothing happens unless the tier actually advanced. That is also the
   * literal reading of 1830 -- "the FIRST 4-train" -- rather than an
   * approximation of it.
   *
   * Applied AFTER delivery, because the arriving train is what defines the
   * new phase. The buyer's own new train is never at risk: nothing rusts
   * the tier that just arrived. */
  return after !== null && after !== before ? applyPhaseChange(delivered, after) : delivered;
}

/** Moves ONE train of `modelType` from `sellerId` to `buyerId` and `price`
 *  the other way -- design note #191.
 *
 *  Exported because the sandbox's consent flow settles a trade that was
 *  agreed some time after it was proposed, and the panel needs the same
 *  settlement the reducer performs rather than a parallel one.
 *
 *  A seller who does not hold the model is a no-op rather than a throw. The
 *  UI only offers models a corporation actually owns, so reaching this means
 *  the roster changed under an open offer -- in which case doing nothing is
 *  the honest outcome and the contract would refuse it too. */
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

/* ==================================================================
 *  DESIGN NOTE 261: THE AUCTION HAD NO REDUCER AT ALL
 * ==================================================================
 *
 * REPORTED: none of the Auction phase buttons work, blocking sandbox
 * testing entirely.
 *
 * They dispatched correctly and the game-state reducer even advanced the
 * seat pointer. What nothing touched was the `WaterfallStateResponse` -- the
 * shape the auction dashboard actually renders from. In sandbox that came
 * from `sandboxWaterfallState(phase, gameId)`, a frozen hand-authored
 * fixture recomputed only when the phase or game id changed. So the same six
 * privates, the same bids and the same mini-auction were re-rendered after
 * every click, for ever.
 *
 * This is the missing half: a reducer over the auction's own response shape,
 * with exactly the charter the rest of this file has (design note #0). It
 * moves POINTERS, COUNTERS and LISTS -- whose turn it is, which private is
 * lowest, who bid what -- and decides no rules. Specifically it does NOT:
 *
 *   - validate that a bid clears `auction::MIN_BID_INCREMENT`;
 *   - decide when a mini-auction should START (the contract opens one when
 *     the lowest private is bought out from under standing bids);
 *   - enforce that a player can afford what they bid;
 *   - end the auction on N consecutive passes.
 *
 * Every one of those is `waterfall.rs`'s, and a TypeScript second opinion
 * would rot against it exactly as design note #0 describes.
 *
 * THE CASH SIDE IS RETURNED, NOT APPLIED. Player wallets live on
 * `GameStateResponse` and the auction lives on `WaterfallStateResponse` --
 * two separate atoms in the app. Rather than have this function reach into
 * the other one (or the caller re-derive a price this function already
 * knows), it returns the charge it implies and lets the caller apply it
 * through the ordinary `adjustCash` path. One state change per atom, both
 * driven by one call.
 */
export interface SandboxWaterfallResult {
  waterfall: WaterfallStateResponse;
  /** What the acting player owes, if this action bought something. */
  charge: { player: string; amount: number } | null;
  /** A private that just changed hands, for the caller's log line. */
  won: { privateId: number; name: string; player: string; price: number } | null;
}

/** The next seat in turn order, wrapping. */
function nextSeat(players: readonly string[], current: string): string {
  if (players.length === 0) return current;
  const at = players.indexOf(current);
  return players[(at + 1) % players.length];
}

export function applySandboxWaterfallAction(
  waterfall: WaterfallStateResponse,
  msg: GameplayExecuteMsg,
  players: readonly string[],
): SandboxWaterfallResult {
  const unchanged: SandboxWaterfallResult = { waterfall, charge: null, won: null };
  const actor = waterfall.mini_auction?.current_turn ?? waterfall.current_turn;

  /** Drops a private from the offer list and re-marks the new cheapest. The
   *  list is documented as arriving in ascending face value, so "cheapest
   *  remaining" is simply the first entry. */
  const removePrivate = (privateId: number): WaterfallPrivateStatus[] =>
    waterfall.privates
      .filter((entry) => entry.private_id !== privateId)
      .map((entry, index) => ({ ...entry, is_lowest_offered: index === 0 }));

  /* ==================================================================
   *  DESIGN NOTE 271: THE AUCTION HAS TO REACH ITS OWN SCREENS
   * ==================================================================
   *
   * REPORTED: the Waterfall UI cannot be tested because the sandbox does
   * not simulate bids or passes.
   *
   * It simulated more than that suggests -- buy, bid, pass and mini-auction
   * raise/drop-out all had arms. What it could not do was reach a state
   * where the interesting ones matter, because three transitions were
   * missing and each one was a dead end rather than a wrong answer:
   *
   *   A MINI-AUCTION COULD BE RESOLVED BUT NEVER OPENED. Both mini-auction
   *   arms read `waterfall.mini_auction` and returned `unchanged` when it
   *   was null -- which it always was, because nothing in this file ever
   *   assigned one. The most intricate screen in the auction was
   *   unreachable by construction.
   *
   *   PASSES COUNTED UP FOREVER. `consecutive_waterfall_passes` incremented
   *   and nothing read it, so a table that all passed sat there. The real
   *   auction has an answer (the cheapest private gets cheaper), and
   *   without it the sandbox's only exit from a stalled table was a reload.
   *
   *   THE AUCTION NEVER ENDED. `waterfall_auction_active` was seeded `true`
   *   and never written again, so buying the last private left the room in
   *   a phase with nothing left to do in it.
   *
   * ALL THREE ARE PACING, NOT RULES -- the same boundary this file's design
   * note #0 draws. Whether a mini-auction may open, what an all-pass costs
   * and when the auction is over are `waterfall.rs`'s to decide; this
   * reproduces the SHAPE those answers take so the components that render
   * them have something to render. A sandbox that cannot reach a screen is
   * not a conservative sandbox, it is a broken one.
   */

  /** Closes the auction once nothing is left to sell.
   *
   *  Separate from the arms that empty the list so every one of them gets
   *  the same ending -- the last private can leave by outright purchase, by
   *  a resolved mini-auction, or by an all-pass markdown to free. */
  const settle = (next: WaterfallStateResponse): WaterfallStateResponse =>
    next.privates.length === 0
      ? { ...next, waterfall_auction_active: false, mini_auction: null }
      : next;

  /** Opens a mini-auction on `target` when two or more players have standing
   *  bids on it.
   *
   *  1830 resolves a contested private among exactly the players who bid on
   *  it, in seat order, with the current high bidder's turns skipped -- so
   *  `bidders` is the bid list re-sorted into seating order and
   *  `current_turn` is the first of them who is not leading. Returns `null`
   *  when the private is not contested, which the caller reads as "nothing
   *  to open". */
  const openMiniAuction = (
    target: WaterfallPrivateStatus,
  ): WaterfallMiniAuctionStatus | null => {
    if (target.bids.length < 2) return null;
    const highest = target.bids.reduce((best, bid) =>
      Number(bid.bid_amount) > Number(best.bid_amount) ? bid : best,
    );
    // Seat order, not bid order: the dashboard renders `bidders` as a turn
    // queue, and a queue sorted by bid size would rotate through the table
    // in an order the room does not sit in.
    const bidders = players.filter((player) =>
      target.bids.some((bid) => bid.bidder === player),
    );
    const leader = highest.bidder;
    return {
      private_id: target.private_id,
      bidders,
      // `skip_leader_turns`: the leader is never asked to bid against
      // themselves, so the cursor opens on the next bidder who is not them.
      current_turn: bidders.find((player) => player !== leader) ?? leader,
      high_bid: highest.bid_amount,
      high_bidder: leader,
    };
  };

  if ("WaterfallBuyLowest" in msg) {
    const target = waterfall.privates.find((entry) => entry.is_lowest_offered);
    if (!target) return unchanged;
    const price = Number(target.face_value) || 0;

    /* Design note #271: buying the cheapest private promotes the next one,
       and if THAT one is already contested the mini-auction opens now. This
       is the ordinary way a mini-auction starts in a real game -- bids
       accumulate on a private while it is too expensive to be the lowest
       offer, and land the moment it becomes one. */
    const remaining = removePrivate(target.private_id);
    const promoted = remaining.find((entry) => entry.is_lowest_offered);
    const mini = promoted ? openMiniAuction(promoted) : null;

    return {
      waterfall: settle({
        ...waterfall,
        privates: remaining,
        mini_auction: mini,
        current_turn: nextSeat(players, waterfall.current_turn),
        // Buying is not passing, so the streak that would end the auction
        // resets -- a counter, not a rule about what the streak means.
        consecutive_waterfall_passes: 0,
      }),
      charge: { player: actor, amount: price },
      won: { privateId: target.private_id, name: target.name, player: actor, price },
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
      charge: null,
      won: null,
    };
  }

  if ("WaterfallPass" in msg) {
    const passes = waterfall.consecutive_waterfall_passes + 1;
    const wholeTablePassed = players.length > 0 && passes >= players.length;

    /* Design note #271: A FULL ROUND OF PASSES MARKS THE CHEAPEST DOWN.
       Without this the counter was write-only and an all-pass table was a
       dead end. 1830 knocks $5 off the cheapest private each time the table
       declines it, and a private marked all the way down to $0 is taken by
       the next player rather than sitting at zero forever -- which is also
       the only thing that guarantees this loop terminates. */
    if (wholeTablePassed) {
      const target = waterfall.privates.find((entry) => entry.is_lowest_offered);
      if (target) {
        const marked = Math.max(0, (Number(target.face_value) || 0) - WATERFALL_PASS_MARKDOWN);
        const taker = nextSeat(players, waterfall.current_turn);

        if (marked === 0) {
          // Free, so it goes. The next seat takes it at no cost, which is
          // how the real auction stops a worthless private from blocking
          // every remaining turn.
          const remaining = removePrivate(target.private_id);
          const promoted = remaining.find((entry) => entry.is_lowest_offered);
          return {
            waterfall: settle({
              ...waterfall,
              privates: remaining,
              mini_auction: promoted ? openMiniAuction(promoted) : null,
              current_turn: nextSeat(players, taker),
              consecutive_waterfall_passes: 0,
            }),
            charge: null,
            won: { privateId: target.private_id, name: target.name, player: taker, price: 0 },
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
          charge: null,
          won: null,
        };
      }
    }

    return {
      waterfall: {
        ...waterfall,
        current_turn: nextSeat(players, waterfall.current_turn),
        consecutive_waterfall_passes: passes,
      },
      charge: null,
      won: null,
    };
  }

  if ("WaterfallMiniAuctionRaise" in msg) {
    const mini = waterfall.mini_auction;
    if (!mini) return unchanged;
    const amount = Number(msg.WaterfallMiniAuctionRaise.bid_amount) || 0;
    return {
      waterfall: {
        ...waterfall,
        mini_auction: {
          ...mini,
          high_bid: String(amount),
          high_bidder: actor,
          // The high bidder's own turns are auto-skipped, so the cursor
          // moves to the next bidder who is not them.
          current_turn: nextSeat(mini.bidders, actor),
        },
      },
      charge: null,
      won: null,
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
      const stillOffered = removePrivate(mini.private_id);
      const promoted = stillOffered.find((entry) => entry.is_lowest_offered);
      return {
        waterfall: settle({
          ...waterfall,
          privates: stillOffered,
          // Design note #271: resolving one contest can immediately expose
          // another -- the promoted private may already carry bids.
          mini_auction: promoted ? openMiniAuction(promoted) : null,
          current_turn: nextSeat(players, waterfall.current_turn),
          consecutive_waterfall_passes: 0,
        }),
        charge: { player: winner, amount: price },
        won: target
          ? { privateId: target.private_id, name: target.name, player: winner, price }
          : null,
      };
    }

    return {
      waterfall: {
        ...waterfall,
        mini_auction: {
          ...mini,
          bidders: remaining,
          current_turn: nextSeat(remaining, actor),
        },
      },
      charge: null,
      won: null,
    };
  }

  return unchanged;
}

/* ==================================================================
 *  DESIGN NOTE 273: THE STOCK ROUND REDUCER
 * ==================================================================
 *
 * The market half of design note #272. `applySandboxAction` moves the
 * shares and the cash; this moves the token, and the two are driven from
 * the same dispatch so they cannot disagree about what a trade cost.
 *
 * IT PRICES THE TRADE, WHICH IS THE POINT. Buy and sell used a flat
 * `SANDBOX_NOMINAL_SHARE_PRICE` of $67 for every corporation regardless of
 * where its token sat -- so PRR at $112 and NNH at $67 cost the same, and
 * the market chart was decoration next to a price that ignored it. The
 * price now comes from the chart, which makes the chart load-bearing and
 * makes a sandbox trade tell the player something true.
 *
 * WHAT IT DOES NOT DECIDE, and the list is the usual one. Certificate
 * limits, the presidency, the 50%-of-a-company cap, which zone permits
 * what, and the end-of-round sold-out rise are all `trading.rs`'s and
 * `market.rs`'s. This moves a marker down one row per block sold, which is
 * the one market effect a single message fully determines.
 */
export interface SandboxMarketResult {
  prices: SandboxMarketPrices;
  /** What the trade was priced at, so the caller can charge the same figure
   *  it displayed. `null` for a message that moves no money. */
  tradePrice: number | null;
  /** Where a token moved, for the log line. */
  moved: { companyId: number; from: number; to: number } | null;
}

export interface SandboxMarketContext {
  /** `StockMarketRenderer.projectShareSaleMove`, injected -- `utils/` must
   *  not import `components/`, the one-way rule this file's header records.
   *  Omitted, a sale still settles and the token simply does not move.
   *
   *  Takes and returns a CELL, not a price: see `SandboxMarketMark`. */
  projectSale?: (from: SandboxMarketMark, blocks: number) => SandboxMarketMark | null;
  /** `StockMarketRenderer.projectDividendCellMove`, injected the same way.
   *
   *  Design note #291: the dividend decision MOVES THE TOKEN, and until now
   *  nothing in the sandbox did it. `applySandboxAction` settles the cash
   *  and says explicitly that the price is `market.rs`'s -- true of the
   *  ladder's ledges and cliffs, and it left the ORDINARY step unmodelled
   *  too, so a withhold looked identical to no decision at all. That is the
   *  one market move a single message fully determines. */
  projectDividend?: (
    from: SandboxMarketMark,
    choice: "pay" | "withhold",
  ) => SandboxMarketMark | null;
}

export function applySandboxMarketAction(
  prices: SandboxMarketPrices,
  msg: GameplayExecuteMsg,
  ctx?: SandboxMarketContext,
): SandboxMarketResult {
  const unchanged: SandboxMarketResult = { prices, tradePrice: null, moved: null };

  /** What one 10% certificate of this corporation costs right now.
   *
   *  Falls back to the nominal figure for a corporation with no position --
   *  an unfloated company has no market price, and an IPO buy is at par in
   *  the real game. The fallback keeps a buy from being free rather than
   *  claiming to model par correctly. */
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
      prices: { ...prices, [protocol_id]: landed },
      // Priced at the price BEFORE the drop: the seller is paid what the
      // share was worth when they sold it, and the fall is the consequence.
      tradePrice: proceeds,
      moved: { companyId: protocol_id, from: mark.price, to: landed.price },
    };
  }

  if ("DeclareDividends" in msg) {
    /* Design note #291: RIGHT on a payout, LEFT on a withhold. The cash is
       still `applySandboxAction`'s -- this owns only the marker, which is
       the same split every other arm here follows. */
    const { protocol_id, distribute } = msg.DeclareDividends;
    const mark = prices[protocol_id] ?? null;
    if (mark === null || !ctx?.projectDividend) return unchanged;
    const landed = ctx.projectDividend(mark, distribute ? "pay" : "withhold");
    if (!landed || (landed.x === mark.x && landed.y === mark.y)) return unchanged;
    return {
      prices: { ...prices, [protocol_id]: landed },
      tradePrice: null,
      moved: { companyId: protocol_id, from: mark.price, to: landed.price },
    };
  }

  return unchanged;
}

export function applySandboxAction(
  state: GameStateResponse,
  msg: GameplayExecuteMsg,
  ctx?: SandboxActionContext,
): GameStateResponse {
  const actor = state.player_addresses[state.active_player_index] ?? null;

  // ---- Passing means two different things, and the phase decides which.
  //
  // In a seat-driven round it is a player declining their turn, and a full
  // round of them ends the round. In an Operating Round the same message is
  // what the "End Operating Turn" button sends -- the CORPORATION is done,
  // and the queue moves to the next company. Treating both as a seat advance
  // would strand the Operating Round on its first corporation forever.
  if ("PassTurn" in msg) {
    return state.current_round_type === "OperatingRound"
      ? advanceCorporation(state)
      : recordPass(state);
  }

  if ("WaterfallPass" in msg) {
    return recordPass(state);
  }

  // ---- Seat-driven rounds: the Waterfall Auction and the Stock Round.

  if ("BuyStock" in msg) {
    // THE SHARE HAS TO ACTUALLY MOVE.
    //
    // This used to adjust cash and nothing else, which is why buying from
    // the Bank Pool looked broken in sandbox: the money left the player's
    // wallet, the pool percentage did not change, the holding never
    // appeared, and the source button went on reporting the same 10%
    // available. Nothing errored -- the buy simply had no visible effect,
    // which reads as a dead button.
    //
    // Moving a percentage from a pool into a holding is BOOKKEEPING, not a
    // rule: it asserts nothing about whether the purchase was legal (cert
    // limits, ownership caps, zone restrictions and the president's
    // certificate all remain the contract's alone). It is the same class of
    // change as moving cash, which this reducer already did.
    // ONE certificate per message, deliberately. `ExecuteMsg::BuyStock`
    // gained an optional `quantity` in Step 4.5 Batch 1 for the Brown zone's
    // atomic multi-buy, but this frontend's `GameplayExecuteMsg` never
    // mirrored it and `StockRoundPanel` sends N sequential single-share
    // messages instead (its own design note #33). Reading a field the UI
    // does not send would model a purchase shape that cannot occur here.
    const { protocol_id, source } = msg.BuyStock;
    const percentage = SANDBOX_SHARE_PERCENTAGE;
    /* Design note #273: the CHART's price, not a flat $67 for everything.
       `ctx.sharePrice` is the same figure `applySandboxMarketAction`
       reports, handed in rather than recomputed so the money that leaves
       the wallet and the money the log quotes are one number. */
    const price = ctx?.sharePrice ?? SANDBOX_NOMINAL_SHARE_PRICE;

    const spent = actor ? adjustCash(state, actor, -price) : state;
    const banked = adjustBank(spent, price);
    return advanceSeat(
      moveShares(banked, protocol_id, actor, source === "Bank" ? "Bank" : "Ipo", percentage),
    );
  }

  if ("SellStock" in msg) {
    // Selling deliberately does NOT advance the seat -- the real rule
    // (`trading.rs` module doc comment #9) is that a player may sell any
    // number of blocks before the one buy-or-pass that ends their turn.
    // This is turn PACING, not a game rule, so it is safe to model.
    //
    // Sold shares go to the BANK POOL, never back to the IPO. That is what
    // makes the Bank Pool source reachable at all: with the pools frozen,
    // the only bank-pool shares in the sandbox were the ones the mock state
    // happened to start with.
    /* Design note #273: THE MESSAGE SAYS HOW MUCH, so honour it. This read
       only `protocol_id` and always moved one 10% block at the flat nominal
       price, so a player selling 30% watched 10% leave their holding and
       banked a third of what they asked for -- the panel and the ledger
       disagreeing about the same click. */
    const { protocol_id, percentage } = msg.SellStock;
    const sold = Math.max(SANDBOX_SHARE_PERCENTAGE, Math.round(percentage));
    const takings = ctx?.sharePrice ?? SANDBOX_NOMINAL_SHARE_PRICE;

    const proceeds = actor ? adjustCash(state, actor, takings) : state;
    const returned = moveShares(
      adjustBank(proceeds, -takings),
      protocol_id,
      actor,
      "Bank",
      -sold,
    );
    return { ...returned, consecutive_passes: 0 };
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

  // ---- Corporation-driven rounds: the Operating Round.
  //
  // These are charged to the acting CORPORATION's treasury, not to a
  // player's wallet, and none of them end the corporation's turn -- a
  // company lays track, runs, decides dividends and buys trains all in one
  // turn, which only `PassTurn` above closes. The `protocol_id` comes off
  // the message itself rather than from the queue cursor, so a control that
  // acts for a company out of turn still charges the right treasury.

  if ("LayTile" in msg) {
    return adjustTreasury(state, msg.LayTile.protocol_id, -SANDBOX_NOMINAL_TILE_COST);
  }

  if ("BuyHardwareFromPool" in msg) {
    return buyDepotTrain(state, msg.BuyHardwareFromPool.protocol_id);
  }

  if ("EmergencyBuyHardware" in msg) {
    return buyDepotTrain(state, msg.EmergencyBuyHardware.protocol_id);
  }

  if ("BuyTrainFromCorporation" in msg) {
    /* ================================================================
     *  DESIGN NOTE 191: THE REDUCER SETTLES; THE UI DECIDES WHEN TO ASK
     * ================================================================
     *
     * This used to be grouped with the no-op arm below, so a corporate
     * train trade moved neither the train nor the money and the panel
     * reported a sale that had not happened.
     *
     * Settling it is bookkeeping of exactly the same class as
     * `BuyPrivateCompany` above: one train leaves a roster, one joins
     * another, and a price crosses between two treasuries. What this
     * deliberately does NOT decide is whether the counterparty AGREED --
     * that is `train_trade.rs`'s two-party offer flow on chain, and
     * `TrainPurchasePanel`'s consent modal in the sandbox. Both hold this
     * message back until the answer is yes, which is why there is no
     * president check here: by the time this arrives, the question has
     * already been settled by whoever was entitled to answer it.
     *
     * ONE TRAIN, deliberately. `msg.rs` carries a single `model_type` and
     * no count, and the panel limits a trade to one train, so taking the
     * first matching model is the whole transfer rather than a
     * simplification of a bulk move. */
    const { buyer_protocol_id, seller_protocol_id, model_type, price } =
      msg.BuyTrainFromCorporation;
    return settleTrainSale(state, buyer_protocol_id, seller_protocol_id, model_type, price);
  }

  if ("BuyPrivateCompany" in msg) {
    // THE PRIVATE HAS TO ACTUALLY CHANGE HANDS.
    //
    // This charged a flat `SANDBOX_NOMINAL_TOKEN_COST` -- $40, the station
    // token price, reached for as a stand-in and never revisited -- and did
    // nothing else. The seller was not paid, the corporation's treasury
    // moved by the wrong amount, and the private stayed listed as the
    // player's. Every readout in the app therefore went on showing a trade
    // that had, as far as the state was concerned, not happened.
    //
    // Settling it is bookkeeping, not rule-making: money moves from the
    // buying corporation to the selling player, and one ownership field
    // swaps for another. Whether the trade was PERMITTED -- the phase gate,
    // the sub-phase cursor, the president check, the 50-200% band -- stays
    // entirely with `trading.rs::execute_buy_private_company`.
    const { protocol_id, private_id, price } = msg.BuyPrivateCompany;
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
    // Tokens are drawn from `station_token_hexes`, so appending here is what
    // makes one appear on the canvas. The per-CITY registry
    // (`station_tokens`) is deliberately left alone: which city slot a token
    // occupies is resolved by `hexmap::execute_place_station_token` against
    // real slot counts, and guessing it here would be exactly the kind of
    // rule-shaped invention design note 0 rules out.
    const { protocol_id, q, r } = msg.PlaceStationToken;
    // Idempotent per hex. Not a rules claim -- the contract decides whether a
    // second token there is legal. This is so a double-click cannot stack two
    // markers on one hex and charge for both, which would be a rendering bug
    // rather than a simulated rule.
    const owner = state.public_companies.find((company) => company.company_id === protocol_id);
    if (owner?.station_token_hexes.some(([hq, hr]) => hq === q && hr === r)) {
      return state;
    }
    /* ==================================================================
     *  DESIGN NOTE 239: THE PRICE ESCALATES HERE TOO
     * ==================================================================
     *
     * This charged a flat `SANDBOX_NOMINAL_TOKEN_COST` -- $40 -- for every
     * placement, which is 1830's price for exactly the SECOND token. The
     * home token is free and the third onward cost $100, so a corporation
     * placing its fourth was being charged less than half what it owed and
     * the sandbox treasury drifted further from a real game with every
     * token.
     *
     * `stationTokenPrice` is the same schedule the UI quotes (`utils/
     * stationTokens.ts`), read off the count of tokens the company ALREADY
     * holds -- so the figure charged and the figure on the button cannot
     * disagree, which is what a second copy of the ladder here would
     * guarantee eventually.
     */
    const placedCount = owner?.station_token_hexes.length ?? 0;
    const cost = stationTokenPrice(placedCount);
    const placed: GameStateResponse = {
      ...state,
      public_companies: state.public_companies.map((company) =>
        company.company_id === protocol_id
          ? {
              ...company,
              station_token_hexes: [...company.station_token_hexes, [q, r] as [number, number]],
            }
          : company,
      ),
    };
    return adjustBank(adjustTreasury(placed, protocol_id, -cost), cost);
  }

  if ("RunManualRoute" in msg) {
    // Withholding credits the treasury; distributing pays shareholders,
    // which needs a share split this file does not model. Either way the
    // route's earnings are recorded, so the Operating Round table's last
    // column visibly fills in.
    // `payout_strategy` is deliberately NOT read -- design note #192. The
    // caller always sends `Withhold` from the Routes step and the real
    // choice is made one step later, so acting on it here is what produced
    // the double-credit this note records.
    const { protocol_id, path } = msg.RunManualRoute;
    // The flat nominal is now only the FALLBACK. With a map to read, the
    // figure comes from the stops the player actually selected, so building
    // a longer route through richer cities visibly pays more -- which is the
    // entire point of a route tester. See `sandboxRouteRevenue`.
    const earned = ctx?.mapGrid
      ? sandboxRouteRevenue(ctx.mapGrid, path, ctx.era ?? "Yellow")
      : SANDBOX_NOMINAL_ROUTE_REVENUE;
    /* ================================================================
     *  DESIGN NOTE 192: RUNNING A ROUTE RECORDS; DECLARING PAYS
     * ================================================================
     *
     * The treasury credit that used to live here has MOVED to
     * `DeclareDividends` below, and the move is a correctness fix rather
     * than a tidy-up.
     *
     * `App.handleRunTrains` always sends `payout_strategy: "Withhold"` --
     * the payout choice belongs to the Dividends step, which is the very
     * next one -- so this arm credited the treasury, and then the player
     * hit "Withhold to Corporate Treasury" and (once that message stopped
     * being a no-op) credited it a second time. Paying out was worse: the
     * revenue had already been banked into the treasury, so a "Pay
     * Dividends" click handed shareholders money the corporation had
     * simultaneously kept.
     *
     * Running a route now only RECORDS what it earned. Exactly one of the
     * two dividend choices then moves that money, once. */
    return {
      ...state,
      public_companies: state.public_companies.map((company) =>
        company.company_id === protocol_id
          ? { ...company, last_route_revenue: String(earned) }
          : company,
      ),
    };
  }

  if ("DeclareDividends" in msg) {
    /* ================================================================
     *  DESIGN NOTE 193: THE DIVIDEND BUTTONS WERE A NO-OP
     * ================================================================
     *
     * "Pay Dividends" and "Withhold to Corporate Treasury" dispatched,
     * logged a success line, advanced the stepper -- and returned the state
     * unchanged. Nothing on screen moved, which is the exact signature of a
     * dead button: the log says it worked and the board says it did not.
     *
     * Settling it is arithmetic over figures already on the record, and it
     * is the same class of change as every other money move in this file.
     * WITHHOLD credits the corporation. PAY splits the revenue ten ways --
     * one certificate is 10% -- and sends each slice where 1830 sends it:
     *
     *   player holdings  -> that player's cash
     *   the IPO pool     -> the corporation's own treasury (unsold shares
     *                       pay the company, they are not simply skipped)
     *   the bank pool    -> the bank, which is where it already is, so the
     *                       bank's net outlay is the revenue minus that slice
     *
     * WHAT THIS IS STILL NOT. It does not move the share price -- that is
     * `market.rs`'s ladder, with its ledges and cliffs, and the panel's
     * `projectDividendMove` readout is explicitly a projection rather than
     * a second implementation of it. It does not enforce that a route was
     * run first, or that this corporation may act. Those stay with the
     * contract. */
    const { protocol_id, revenue_amount, distribute } = msg.DeclareDividends;
    const company = state.public_companies.find((entry) => entry.company_id === protocol_id);
    const stated = Number(revenue_amount);
    // The caller's figure wins when it is a real one; otherwise fall back to
    // what the corporation's last run actually recorded. A payout of nothing
    // is not an error, it is simply nothing to move.
    const revenue =
      Number.isFinite(stated) && stated > 0
        ? stated
        : Number(company?.last_route_revenue ?? 0) || 0;
    if (revenue <= 0 || !company) return state;

    if (!distribute) {
      return adjustTreasury(adjustBank(state, -revenue), protocol_id, revenue);
    }

    // Floored, matching `App`'s own per-share figure: 1830 pays whole units,
    // and rounding up would have the corporation pay out more than it earned.
    const perShare = Math.floor(revenue / 10);
    let next = state;
    for (const holding of company.player_holdings) {
      next = adjustCash(next, holding.player, perShare * (holding.percentage / 10));
    }
    const treasurySlice = perShare * (company.ipo_pool_percentage / 10);
    if (treasurySlice > 0) next = adjustTreasury(next, protocol_id, treasurySlice);
    const bankSlice = perShare * (company.bank_pool_percentage / 10);
    // The bank funds the payout and keeps its own pool's slice, so the net
    // movement is everything that actually left it.
    return adjustBank(next, -(revenue - bankSlice));
  }

  if (
    "AdvanceOperatingSubPhase" in msg ||
    "AcceptTrainOffer" in msg ||
    "RejectTrainOffer" in msg ||
    "RescindTrainOffer" in msg ||
    "ExecuteOperatingRound" in msg
  ) {
    /* Skipping a step happens INSIDE a corporation's turn -- the queue
     * cursor stays where it is.
     *
     * THE THREE OFFER MESSAGES ARE UNMODELLABLE HERE, not merely unmodelled.
     * `AcceptTrainOffer`/`RejectTrainOffer`/`RescindTrainOffer` address an
     * offer by `offer_id`, and the offer REGISTER is not on
     * `GameStateResponse` at all -- it is its own query (`GetTrainOffers`).
     * A reducer over the game state has no id to resolve, exactly as
     * `applySandboxLayTile` cannot live in here for the tile grid.
     *
     * So the sandbox keeps its pending offers in `App`, and an accepted one
     * settles by dispatching `BuyTrainFromCorporation` -- the message that
     * really does move the train, handled above. These three stay no-ops
     * because by the time they are sent the transfer has already happened
     * through the arm that can perform it. */
    return state;
  }

  if ("BeginOperatingRound" in msg) {
    return {
      ...state,
      current_round_type: "OperatingRound",
      active_corporation_index: 0,
    };
  }

  if ("UndoLastAction" in msg) {
    // Genuinely unmodellable: undo is a full replay of the contract's event
    // log, and the sandbox has no log. An explicit no-op rather than a
    // default-arm turn advance, which would make undo look like an action.
    return state;
  }

  // ---- Anything not named above.
  //
  // Reached by any `ExecuteMsg` variant added to the app without being
  // considered here. Advancing the turn is the least surprising fallback:
  // it keeps the hotseat loop alive, and a turn that moves when it should
  // not is far easier to notice than a control that silently does nothing.
  return advanceSeat(state);
}

/** Whether `phase` is one where seats act in order, as opposed to
 *  corporations. Exported for the toolbar, which labels the auto-follow
 *  target differently in each. */
export function isSeatDrivenRound(phase: RoundType): boolean {
  return phase !== "OperatingRound";
}

/* ------------------------------------------------------------------ */
/* The board: laying a tile in sandbox                                */
/* ------------------------------------------------------------------ */

/** Places (or upgrades) a tile on the local board and returns a NEW
 *  `MapGridResponse`.
 *
 *  **Why this is not part of `applySandboxAction`.** The tile grid is not on
 *  `GameStateResponse` at all -- it is a separate query (`GetMapGrid`) with
 *  its own response shape, polled independently and handed to
 *  `HexGridRenderer` as its own prop. Folding a second, differently-shaped
 *  document into the game-state reducer would mean either widening that
 *  reducer's type to something neither query returns, or returning a tuple
 *  every caller has to destructure. Two documents, two reducers.
 *
 *  **Why the whole `tiles` array is rebuilt.** `HexGridRenderer`'s draw
 *  effect lists `mapGrid` in its dependency array. Pushing onto the existing
 *  array mutates it in place, the reference never changes, and the canvas
 *  simply never repaints -- the exact "I laid a tile and nothing happened"
 *  symptom. A fresh array and a fresh wrapper object are what make the track
 *  appear.
 *
 *  **The entry is a REAL one, not a stub.** `paths` and `revenue` are read
 *  from the local `TILE_CATALOG` mirror, which is the same data the contract
 *  serves from `hexmap::TILE_CATALOG`, so the drawn track splines and the
 *  hex's printed value are genuinely right rather than approximated. What is
 *  NOT checked is whether the placement is LEGAL -- upgrade topology, colour
 *  era, connectivity to the corporation's network. That is
 *  `hexmap::execute_lay_tile`'s job and this file does not second-guess it
 *  (design note 0). A sandbox user can lay a tile the real game would
 *  refuse; the picker labels its offering "Catalog tiles" rather than "Legal
 *  tiles" for exactly that reason. */
export function applySandboxLayTile(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  tileId: number,
  orientation: number,
): MapGridResponse {
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
