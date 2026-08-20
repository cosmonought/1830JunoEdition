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
  PublicCompanyState,
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
import { depotInventory, derivePhase, type GamePhase } from "./gamePhase";
import { stationTokenPrice } from "./stationTokens";
// Design note #596: the president's certificate changes hands.
import { settlePresidencies } from "./presidencyTransfer";
import type { SandboxMarketMark, SandboxMarketPrices } from "./sandboxState";
// Design note #646: every marker landing is stamped with its arrival here,
// so the operating-order tie-break has a history to read.
import { withArrival } from "./sandboxState";
import {
  HEX_START_VALUE_OVERRIDE,
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

/* `SANDBOX_NOMINAL_TILE_COST` (a flat $20) DELETED by design note #432.
 *
 * It was charged for every tile on every hex, which is not a rule 1830 has:
 * the fee belongs to the GROUND, and `terrainBuildFeeAt` mirrors the
 * contract's real $0 / $80 river / $120 mountain figures.
 *
 * Removed rather than left exported-and-unused, for the reason `palette.ts`
 * records about its own deleted token: a plausible-looking constant that
 * nothing imports is a standing invitation to reintroduce the exact
 * behaviour that was just removed -- and "nominal tile cost" reads like
 * something a tile lay ought to consult. */

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

/* ==================================================================
 *  DESIGN NOTE 411: THE OPERATING QUEUE HAS TO BE BUILT BY SOMEBODY
 * ==================================================================
 *
 * REPORTED: ending a corporation's turn in an Operating Round advances
 * nothing -- not the active company, not the active player -- so the round
 * runs forever.
 *
 * ONE ROOT CAUSE, and it is not in the advance at all. Nothing ever filled
 * `active_operating_order`. Two paths enter an Operating Round and both set
 * the round type without building the queue:
 *
 *   - the Stock Round's own close (`App.tsx`, design note #353's caller
 *     half), which set `current_round_type` and `consecutive_passes`;
 *   - the `BeginOperatingRound` arm below, which set the round type and
 *     reset the cursor to zero.
 *
 * The fixtures ship a hand-written queue (`sandboxState.ts`'s
 * `[1, 8, 2, 3, 6, 7]`), so every scenario that OPENS in an Operating Round
 * worked and hid this completely. A game PLAYED into one from the zero
 * state arrives with `[]`, and from there:
 *
 *   `advanceCorporation` read `queue === 0` and returned the state
 *   untouched -- the infinite round.
 *
 *   `actingSeatIndex` (`gameState.ts`) read `active_operating_order[0]` as
 *   `undefined` and returned `null`, meaning "no seat may act". That is
 *   what locked the president out of Lay Tile while leaving every
 *   unconditioned button -- Skip among them -- live for everyone. The
 *   authorisation predicate was not wrong; it was being handed an empty
 *   queue and correctly concluding that nobody was on turn.
 *
 * So the queue is built where the round begins, and the two entry paths now
 * share one function rather than each doing half the job.
 *
 * ORDER IS BY MARKET PRICE, DESCENDING -- 1830's actual rule. The price
 * lives in the separate market atom (design note #272), which this reducer
 * must not reach into, so the caller injects a lookup. Without one the par
 * value stands in: it is the price every corporation starts at, so a queue
 * built from it is right until the chart first moves and never absurd.
 *
 * ONLY FLOATED CORPORATIONS WITH A PRESIDENT. An unfloated company cannot
 * operate at all, and a floated one with no president on record has nobody
 * entitled to act for it -- `actingSeatIndex` would return `null` on its
 * turn and strand the round exactly as an empty queue does. Both are
 * excluded here rather than skipped later, so the queue cannot contain an
 * entry that stops it. */
export function buildOperatingOrder(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  /* ==================================================================
   *  DESIGN NOTE 647: THE WHOLE MARK, NOT A GROWING LIST OF SCALARS
   * ==================================================================
   *
   * This was `arrivalFor`, added one pass ago for the same-cell tie-break.
   * Rule (iii) needs the COLUMN as well, and a second scalar lookup beside
   * the first would be two ways of asking one question -- and a third the
   * moment a rule needs the row.
   *
   * The mark is the answer to "where is this corporation's token", and every
   * tie-break below is a fact about that position. One lookup, one source.
   *
   * `priceFor` STAYS SEPARATE, deliberately. It is not simply
   * `markFor(...).price`: design note #468's fallback chain reaches past the
   * chart to `par_value` for a corporation that has floated and has no
   * position yet, and folding that into the mark would either lose the
   * fallback or invent a cell the token is not standing on. */
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
): number[] {
  /* ==================================================================
   *  DESIGN NOTE 468: THE PRICE FALLBACK IS LOAD-BEARING
   * ==================================================================
   *
   * REPORTED (critical): a corporation with no matrix coordinate breaks the
   * queue and soft-locks the Operating Round transition.
   *
   * The `??` chain is what stops that, and it is worth naming rather than
   * leaving as an idiom. A corporation floats the moment 60% sells, and its
   * market MARK is written by a separate atom on a separate code path
   * (design note #272) -- so there is a real window, and in the B&O's case
   * there was a persistent state, where a company is legitimately floated
   * and has no price yet.
   *
   * Falling back to PAR rather than to zero is the difference between a
   * queue that is merely approximate for one render and one that is wrong:
   * par is what the corporation is worth until the chart says otherwise, so
   * a queue built on it is in the right order and simply not yet updated.
   * Zero would sort every unmarked corporation to the back regardless of
   * value.
   *
   * `Number(...) || 0` CATCHES THE REST -- a par that is `null`, an empty
   * string, or anything `Number` turns into `NaN`. That matters more than
   * it looks: `NaN` propagates through `sort`'s comparator and produces a
   * comparison that is neither less, greater nor equal, which yields an
   * order that is not total. A queue that is not totally ordered can put
   * the cursor back on a corporation that has already operated -- which is
   * the infinite Operating Round, arriving by a different route than design
   * note #411's empty queue. Every entry here is therefore a finite number
   * before it reaches the sort. */
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
      /* Design note #646: `Infinity` for a corporation whose arrival is not
         recorded, which sorts it AFTER every corporation whose is. A fixture
         board seeded straight onto the chart has no history to read, and
         guessing one would invent a turn order; putting the unknowns last and
         falling through to `company_id` keeps them in a stable, arbitrary
         order without pretending it is the rule. */
      const mark = markFor?.(company.company_id) ?? null;
      const arrival = mark?.enteredAt;
      return {
        companyId: company.company_id,
        price,
        /* Design note #647: `-Infinity` sorts a positionless corporation to
           the LEFT of every real column, which puts it last under a
           rightmost-first rule. That is the same direction design note #646
           takes for a missing arrival, and for the same reason: a corporation
           the chart cannot place should not be handed precedence by the
           absence of information. */
        column: Number.isFinite(mark?.x as number) ? (mark?.x as number) : -Infinity,
        arrival: Number.isFinite(arrival as number) ? (arrival as number) : Infinity,
      };
    });

  /* ==================================================================
   *  DESIGN NOTE 646: PRICE FIRST, THEN WHO GOT THERE FIRST
   * ==================================================================
   *
   * INSTRUCTED: "corporations act in descending market value" and
   * "corporations on the same cell act in the order in which they reached
   * the cell".
   *
   * The first was already right. The second was a placeholder -- ties fell
   * through to `company_id` ascending, which the old note here admitted was
   * chosen for being TOTAL and STABLE rather than for being the rule. It made
   * turn order a function of the contract's roster numbering, so PRR (id 1)
   * beat B&O (id 4) at equal price forever, whichever had parred first.
   *
   * ASCENDING ARRIVAL, so EARLIER goes first: the corporation that reached
   * the cell first operates first, which is the rule as stated.
   *
   * `company_id` SURVIVES AS THE LAST RESORT and still earns its place. Two
   * corporations can share an arrival ordinal only if neither has one
   * recorded, and the sort must still be total -- an incomparable pair makes
   * `sort` produce an order that is not an order, which is how the cursor
   * lands on a corporation that has already operated (the same failure design
   * note #468 guards the price against).
   *
   * ==================================================================
   *  DESIGN NOTE 647: AND RIGHTMOST BEFORE EITHER OF THEM
   * ==================================================================
   *
   * INSTRUCTED: "if two corporations have the same share value but are on
   * different cells, the corporation whose token is furthest right on the
   * matrix goes first."
   *
   * THE THREE RULES ARE DISJOINT, WHICH IS WHY THIS IS A CLEAN THIRD LEVEL
   * rather than a special case. Equal price and DIFFERENT cells is rule
   * (iii); equal price and the SAME cell is rule (ii). A shared cell shares a
   * column, so comparing columns first is a no-op for rule (ii) and decisive
   * for rule (iii) -- neither rule can reach the other's ground.
   *
   * COLUMN, NOT CELL IDENTITY. Two cells in one column can share a price on
   * this chart, and "furthest right" cannot separate them: they are equally
   * right. Those fall through to arrival, which is not the stated rule but is
   * the nearest thing to it and keeps the order total. The rules do not
   * legislate that case and this is the honest place to say so.
   *
   * DESCENDING, unlike every other level here. `b.column - a.column` is the
   * one comparison that reads backwards, because rightmost is first -- worth
   * flagging beside `a.arrival - b.arrival` directly below it, where earliest
   * is first. */
  priced.sort(
    (a, b) =>
      (b.price - a.price) ||
      (b.column - a.column) ||
      (a.arrival - b.arrival) ||
      (a.companyId - b.companyId),
  );
  return priced.map((entry) => entry.companyId);
}

/** Points `active_player_index` at whoever presides over the corporation
 *  currently up.
 *
 *  The seat pointer is not meaningful during an Operating Round -- the
 *  queue names companies -- but it is still the field every seat-driven
 *  consumer reads, and leaving it parked on whoever last acted in the Stock
 *  Round is what made "the active player never changes" a second, separate
 *  symptom of the same bug. Keeping it in step means `actingSeatIndex` and
 *  the raw pointer agree during an OR instead of disagreeing silently.
 *
 *  Left untouched when the presidency cannot be resolved: moving it to zero
 *  would hand the controls to an arbitrary seat, which is worse than
 *  leaving them where they were. */
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

/* ==================================================================
 *  DESIGN NOTE 431: 1830'S OPERATING ROUND COUNTS
 * ==================================================================
 *
 * How many Operating Rounds run between two Stock Rounds, by phase:
 *
 *     Yellow (2-trains)          1 OR
 *     Green  (3- and 4-trains)   2 ORs
 *     Brown  (5-, 6-, Diesel)    3 ORs
 *
 * THE PHASE IS DERIVED FROM THE TRAINS IN PLAY, not read from
 * `current_global_era`. Both are on the state and they answer subtly
 * different questions: `current_global_era` is the contract's TILE colour
 * -- which yellow/green/brown tiles may be laid -- while the OR count is
 * set by the highest train tier anyone owns. They advance together in an
 * ordinary game and they are not the same field, and `derivePhase` is
 * already this app's single answer to "what phase is it" (the badge, the
 * train chips and the rust warnings all read it). Using it here means the
 * OR count cannot disagree with the phase the player can see.
 *
 * `null` phase -- a board whose trains are not reported at all -- yields 1,
 * the Yellow count. That is the SAFE direction: one round too few returns
 * the player to a Stock Round they can act in, while one too many is the
 * bug being fixed, and a game that will not leave the Operating Round is
 * far worse than one that leaves it early.
 *
 * "GRAY" in the requirement is 1830's Diesel phase. This codebase's
 * `PhaseTint` has three values and folds 5/6/D into `brown` (see
 * `gamePhase.ts`'s `TRAIN_TIER_PRESENTATION`), and all of them run 3 ORs,
 * so the three-way tint is sufficient and adding a fourth would be a
 * distinction with no consequence here. */
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

/** Opens an Operating Round: builds the queue, parks the cursor on the
 *  first corporation and seats its president.
 *
 *  Exported because two callers need it -- the `BeginOperatingRound` arm
 *  below and the shell's Stock-Round close -- and a second hand-written
 *  copy is precisely how the queue came to be built by neither of them. */
export function beginOperatingRound(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  /** Design note #646: the arrival lookup the tie-break reads. */
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
  /* ==================================================================
   *  DESIGN NOTE 511: THE SEQUENCE LOCKS AT THE START OF THE CYCLE
   * ==================================================================
   *
   * REPORTED: buying a 3-train during Yellow shifts the game to Green
   * mid-round, and it then expects a SECOND Operating Round before
   * returning to the Stock Round. A cycle that began in Yellow must run one
   * OR and stop.
   *
   * Design note #431 fixed the opposite fault -- the count was read from a
   * state field nothing maintained -- by DERIVING it from the phase. That
   * was right about where the rule lives and wrong about WHEN to ask: it
   * derived live, at the moment the last corporation finished, by which
   * point a train bought three turns earlier may have moved the phase.
   *
   * 1830 fixes the number of Operating Rounds when the cycle OPENS. A phase
   * change during the cycle takes effect for the NEXT one; it does not
   * extend the one in progress. So the count is stamped once, here, and
   * every later reader takes the stored value.
   *
   * `continuingSequence` is what distinguishes the two callers. Opening a
   * cycle (from a Stock Round, or recovering an empty queue) re-derives;
   * opening the SECOND Operating Round of an existing cycle carries the
   * locked number forward. Without the flag this function cannot tell them
   * apart -- it rebuilds the queue identically either way -- and re-deriving
   * on the continuation is exactly how the lock would leak. */
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
    /* Design note #431: WRITTEN, not read. The fixtures hardcode `2` and
       nothing else ever set this, so it was a field that looked
       authoritative and was decorative. Stamping the phase's real count
       here means the readout ("OR n of N") and the loop that ends the round
       are the same number rather than two that can disagree.

       Design note #511: and stamped ONCE PER CYCLE. A continuation keeps
       the number the cycle opened with, whatever the phase has done since. */
    operating_round_sequence_length: continuingSequence
      ? operatingRoundSequenceLength(state)
      : operatingRoundsForPhase(derivePhase(state)),
    /* ==================================================================
     *  DESIGN NOTE 621: THE COUNTER WAS THE ONE FIELD NOBODY STAMPED
     * ==================================================================
     *
     * REPORTED: three corporations floated, all three took their turn in
     * Operating Round 1, "the Operating Round then looped back to B&O" --
     * in Phase 2, which runs exactly one Operating Round.
     *
     * `advanceCorporation` decides with `sub_round_index < sequenceLength`,
     * and design notes #431 and #511 got the RIGHT-HAND side exactly right:
     * the count is the phase's, it is stamped here when the cycle opens, and
     * a mid-cycle phase change cannot lengthen it. Nobody ever set the
     * LEFT-hand side. The Stock Round's close zeroes `sub_round_index`, this
     * function did not touch it, so a cycle opened at 0 and the very first
     * completed queue asked `0 < 1` -- true -- and ran the whole thing again.
     *
     * EVERY PHASE GOT EXACTLY ONE EXTRA ROUND, which is what made it hard to
     * spot: Yellow ran 2, Green 3, Brown 4. The rule looked implemented and
     * was off by one everywhere at once, and the fixtures hid it by shipping
     * `sub_round_index: 1` on any scenario that OPENS in an Operating Round
     * -- the only states anybody had tested from.
     *
     * THIS IS THE THIRD FIELD IN THIS FUNCTION WITH THE SAME STORY.
     * `active_operating_order` (#411) and `operating_round_sequence_length`
     * (#431) were both values that had to be correct, read from a field that
     * nothing wrote. The lesson each time was "stamp it where the round
     * begins", and each time one more field was left out of the stamping. So
     * the round now opens with all three of its bookkeeping values written
     * together, and a reader can see the whole opening position in one
     * object rather than inferring which parts survive from the last round.
     *
     * A CONTINUATION DOES NOT TOUCH IT. `advanceCorporation` owns the
     * increment for the second and third rounds of a cycle -- it is the
     * caller that knows a round just finished -- and writing it here as well
     * would be two hands on one counter. */
    ...(continuingSequence ? {} : { sub_round_index: 1 }),
  });
}

/** The locked sequence length for the cycle in progress -- design note #511.
 *
 *  Falls back to the phase's own count when the field is absent or
 *  nonsensical, which covers a fixture that predates the lock and a state
 *  restored from an older snapshot. A bad stored number must not be able to
 *  strand a cycle: `Math.max(1, ...)` guarantees at least one Operating
 *  Round, so a zero can never end a cycle before it has run. */
export function operatingRoundSequenceLength(state: GameStateResponse): number {
  const stored = Number(state.operating_round_sequence_length);
  if (!Number.isFinite(stored) || stored < 1) {
    return operatingRoundsForPhase(derivePhase(state));
  }
  return Math.max(1, Math.floor(stored));
}

/** Moves the Operating Round corporation cursor on by one, and closes the
 *  round when it runs off the end of the queue.
 *
 *  THE WRAP IS NOW AN EVENT, NOT A LOOP. The note that stood here wrapped
 *  the cursor modulo the queue length and said so deliberately: "the real
 *  end-of-round bookkeeping decides between another sub-round and closing
 *  the macro round using paced scheduling this file has no business
 *  reproducing. Wrapping keeps the hotseat loop running so every
 *  corporation's panel can be reached."
 *
 *  That was a reasonable call when nothing could leave an Operating Round
 *  either. It is not one now that the Stock Round can be entered and left
 *  (design note #353), because the two together make the OR the one round
 *  with no exit -- a corporation queue that cycles forever is the same dead
 *  end #353 removed, just slower to notice.
 *
 *  `sub_round_index` and `operating_round_sequence_length` are both already
 *  on the state and say exactly how many Operating Rounds this phase runs,
 *  so the decision needs no scheduling this file would have to invent: run
 *  the queue again if the sequence has another round in it, otherwise raise
 *  the one-shot flag and let the shell move to the Stock Round.
 *
 *  ==================================================================
 *   DESIGN NOTE 431: THE SEQUENCE LENGTH IS THE PHASE'S, NOT THE STATE'S
 *  ==================================================================
 *
 *  REPORTED: after every corporation operates in the Yellow phase, the game
 *  opens another Operating Round instead of returning to the Stock Round.
 *
 *  Design note #411 above read `operating_round_sequence_length` off the
 *  state and called it settled -- "both already on the state and say exactly
 *  how many Operating Rounds this phase runs". The field exists; nothing
 *  maintains it. `sandboxState.ts` hardcodes `2` into every fixture and no
 *  code path has ever written it since.
 *
 *  So in Yellow -- where 1830 runs exactly ONE Operating Round per cycle --
 *  the check was `sub_round_index (1) < 2`, which is true, so the queue
 *  rebuilt and the round ran again. The Stock Round was reachable only by
 *  accident of the fixture's number happening to match the phase.
 *
 *  This is the same shape of bug as #411 itself: a value that has to be
 *  correct, read from a field that nothing sets. #411 fixed it for
 *  `active_operating_order` by BUILDING the queue where the round begins;
 *  this fixes it for the count by DERIVING it from the phase, which is
 *  where 1830 actually defines it.
 *
 *  `operatingRoundsForPhase` is the rule. The state field is now written to
 *  match on every round open rather than read -- see `beginOperatingRound`
 *  -- so `ContextualSubPanel`, which renders it as "OR n of N", starts
 *  telling the truth instead of always saying 2. */
function advanceCorporation(
  state: GameStateResponse,
  priceFor?: (companyId: number) => number | null,
  // Design note #646: carried through so a rebuilt queue keeps the tie-break.
  markFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined,
): GameStateResponse {
  /* AN EMPTY QUEUE IS RECOVERED, NOT TOLERATED. This returned the state
     unchanged, which is the infinite round in one line. A round that has
     somehow started without a queue is better answered by building the one
     that was missing than by refusing to move -- and if nothing can float,
     the round is genuinely over and the flag below says so. */
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

  /* Every corporation has operated. Another round in the sequence, or out.

     Design note #431 read this from the PHASE, because the state field was
     unmaintained. Design note #511 maintains it -- `beginOperatingRound`
     stamps it when the cycle opens -- so the LOCKED value is what decides,
     and a phase shift during the cycle cannot lengthen it. Deriving live
     here is the reported Yellow-to-Green bug: a 3-train bought mid-cycle
     turned a one-round Yellow cycle into a two-round Green one halfway
     through. */
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

/* ==================================================================
 *  DESIGN NOTE 352: WHO TRADED LAST, AND WHY IT IS TRACKED HERE
 * ==================================================================
 *
 * The Priority Deal after a Stock Round goes to the player SITTING TO THE
 * LEFT of whoever last bought or sold. That is a fact about the round's
 * history, and nothing in `GameStateResponse` records it -- the contract
 * derives it inside `conclude_stock_round` and reports only the result.
 *
 * So the sandbox has to remember it. Kept on the state object rather than
 * in a module-level variable for the reason design note #310 records the
 * hard way: anything the dispatch path writes has to be in the undo
 * snapshot, and the snapshot copies the state. A module variable would
 * survive an undo and hand the deal to somebody who no longer traded.
 *
 * `null` when nobody has traded all round -- an entire Stock Round of
 * passes, which is legal and which 1830 answers by leaving the Priority
 * Deal where it already was.
 */
function markTrader(state: GameStateResponse, actor: string | null): GameStateResponse {
  if (!actor) return state;
  const index = state.player_addresses.indexOf(actor);
  return index === -1 ? state : { ...state, last_trader_index: index };
}

/** Records a pass and, if that completes a full round of them, ends the
 *  Stock Round.
 *
 *  ==================================================================
 *   DESIGN NOTE 353: THE ROUND NOW ACTUALLY ENDS
 *  ==================================================================
 *
 *  REPORTED: the Stock Round never ends, and the Priority Deal starts on
 *  the wrong player.
 *
 *  The note that stood here was candid about the first half -- "the sandbox
 *  marks the boundary by resetting the streak so the loop keeps moving, and
 *  leaves the consequences to the contract" -- which was the right call
 *  when the sandbox had no round transitions at all. It has them now
 *  (`handleProceedToStockRound` opens SR1), and a round that can be entered
 *  but never left is a dead end of exactly the kind design note #271 fixed
 *  for the auction.
 *
 *  WHAT THIS DOES: ends the round, moves the Priority Deal to the seat left
 *  of the last trader, and seats that player to act first in the Operating
 *  Round that follows.
 *
 *  WHAT IT STILL DOES NOT: the sold-out price rise and the lockout
 *  clearing, which are `market.rs`'s and `trading.rs`'s. Those are rules
 *  about VALUE; this is pacing about WHOSE TURN, and the distinction is the
 *  same one this file has drawn since design note #0. */
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

  // A full round of passes. In the auction this runs the waterfall (the
  // `WaterfallPass` arm handles it before reaching here); in a Stock Round
  // it ends the round.
  if (state.current_round_type !== "StockRound") {
    return { ...advanced, consecutive_passes: 0 };
  }

  /* LEFT OF THE LAST TRADER. "Left" is the next seat in turn order, which
     is the same direction `advanceSeat` moves -- so the deal lands on
     whoever would have acted after the last person to trade. With nobody
     having traded, the deal stays where it is: a round in which nothing
     happened has nothing to reorder. */
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
  /* ==================================================================
   *  DESIGN NOTE 549: THE LOG SAYS WHO DID IT, SO THE REDUCER MUST ASK
   * ==================================================================
   *
   * REPORTED: Player 2 bought a president's certificate and it never
   * appeared on Player 1's screen.
   *
   * `applySandboxAction` resolved the acting player as
   * `state.player_addresses[state.active_player_index]` -- the turn cursor
   * ON THE MACHINE DOING THE APPLYING. In a hotseat that is exactly right:
   * one client, one cursor, and whoever is on turn is by definition whoever
   * just clicked.
   *
   * In an event-sourced room it is a determinism bug of the worst kind. The
   * whole design (design note #522) is that every client replays the same
   * ordered log and therefore reaches the same state -- but a reducer that
   * reads identity out of LOCAL state is not a function of the log alone.
   * Let two clients disagree about the cursor by one seat, for any reason,
   * and from then on every replayed purchase is credited to a different
   * player on each of them. Nothing errors. The two games simply stop being
   * the same game, and the first visible symptom arrives several actions
   * later, somewhere unrelated.
   *
   * That divergence is not hypothetical here -- three handlers were writing
   * state without going through the log at all (design note #550), which is
   * exactly how the cursors came apart in the reported game.
   *
   * SO THE AUTHOR TRAVELS WITH THE ACTION. The log already records who
   * appended each entry; this is that value, handed back in on replay. The
   * reducer becomes a pure function of (state, message, author) and the
   * local cursor stops being an input.
   *
   * OMITTED FALLS BACK, deliberately: solo sandbox has no log and no author,
   * and the turn cursor is the right answer there. */
  actor?: string | null;
  mapGrid?: MapGridResponse;
  /** Design note #492a: this is the FIRST `RunManualRoute` of a turn's
   *  batch, so `last_route_revenue` starts from zero rather than adding to
   *  whatever the previous turn left. Read by that arm alone; every other
   *  message ignores it. */
  resetRouteRevenue?: boolean;
  /** Scales red off-board terminals, whose value rises with the era. */
  era?: TileColorTier;
  /** Design note #411: a corporation's current market price, for building
   *  the Operating Round queue in descending price order. Injected for the
   *  same reason `sharePrice` is -- the chart is a separate atom this
   *  reducer must not reach across into, and the caller is the one place
   *  that holds both. Omitted falls back to par value. */
  marketPriceFor?: (companyId: number) => number | null;
  /** Design note #646: when a corporation's marker reached its current cell,
   *  for the operating-order tie-break. Travels beside the price for the same
   *  reason the price does -- the chart is a separate atom the reducer must
   *  not reach into. */
  marketMarkFor?: (companyId: number) => { x: number; y: number; enteredAt?: number } | null | undefined;
  /** Design note #273: what one 10% certificate of the corporation being
   *  traded costs right now, from the live market atom. Handed in rather
   *  than looked up because the market is a SEPARATE mock (design note
   *  #272) and this reducer must not reach across into it -- the caller
   *  advances both and is the one place that sees both.
   *
   *  Omitted falls back to `SANDBOX_NOMINAL_SHARE_PRICE`, which is what
   *  every trade cost before the chart could move. */
  sharePrice?: number;
  /** Design note #351: the par ladder's current selection, for the founding
   *  purchase that sets it. Ignored on every other buy -- once
   *  `par_value` is set the company has a price and the ladder is locked. */
  parValue?: number;
  /** Design note #363: resolves a home hex label to `(q, r)`. Injected --
   *  the board table lives in `components/`, which `utils/` must not
   *  import. Omitted, corporations still float without their token. */
  homeHexToAxial?: (label: string) => readonly [number, number] | null;
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
  /* ==================================================================
   *  DESIGN NOTE 334a: CHARGES ARE A LIST, AND NOT ALWAYS THE ACTOR'S
   * ==================================================================
   *
   * This was one optional `{ player, amount }` -- "what the acting player
   * owes". Design note #336's cascade breaks both halves of that: one
   * purchase can settle several privates, and the auto-awarded ones are
   * charged to the LONE BIDDER, who is not the player who acted.
   *
   * A list of `(player, amount)` says both without overloading either. The
   * first attempt at this reused the payout array with a negative amount
   * and a sentinel id, which typechecked and would have been read as
   * revenue by the first caller that summed it.
   */
  charges: Array<{ player: string; amount: number }>;
  /* ==================================================================
   *  DESIGN NOTE 334: ONE ACTION CAN SELL SEVERAL PRIVATES
   * ==================================================================
   *
   * This was a single `won` object, which was true while the only way to
   * win a private was to buy it or to outlast a contest. Design note #336's
   * auto-resolve cascade breaks that assumption: buying the cheapest
   * private can promote one that already has a lone bid, which resolves
   * instantly, which promotes the next -- and a table that has been bidding
   * for a while can settle three companies off one purchase.
   *
   * A LIST, in resolution order. The alternative was to report only the
   * first and let the others move silently, which is the shape that
   * produced design note #303's vanishing cards: the state changed and the
   * caller was never told, so its own bookkeeping drifted from the
   * reducer's.
   */
  won: Array<{ privateId: number; name: string; player: string; price: number }>;
  /* ==================================================================
   *  DESIGN NOTE 337: THE ALL-PASS PAYOUT, REPORTED NOT PERFORMED
   * ==================================================================
   *
   * 1830: when every player passes in succession, the cheapest private is
   * marked down $5 AND every private already owned pays its revenue to its
   * owner. The markdown was implemented (design note #271); the payout half
   * was not, so a table that stalled got cheaper privates and no income --
   * which removes the main reason a player is ever willing to sit and pass.
   *
   * THIS FILE DOES NOT PAY IT, and that is the same boundary every other
   * arm here respects: `charges` is likewise "what the actor owes" for the
   * caller to apply, because the waterfall atom is a separate document from
   * `GameStateResponse` and does not carry `private_companies` at all. The
   * owner roster, the revenue figures and the bank all live on the game
   * state, so the reducer that owns THAT is the one that can pay.
   *
   * Reporting the flag rather than the payouts also means the credit runs
   * through `applyPrivateRevenue` -- the same function the Operating Round
   * uses (design note #327) -- so the two paths cannot drift on who counts
   * as an owner or on who funds it. A second payout implementation here
   * would be a second set of answers to those questions.
   */
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

/* ==================================================================
 *  DESIGN NOTE 544: THE CONTEST HAS ITS OWN QUEUE, AND ITS OWN ORDER
 * ==================================================================
 *
 * INSTRUCTED: "make sure the Mini-Auction turn order rotates only through
 * eligible players in order of lowest bid."
 *
 * `openMiniAuction` used to build `bidders` in SEAT order, and defended it:
 * "a queue sorted by bid size would rotate through the table in an order
 * the room does not sit in." That is true and it is not the point. A
 * mini-auction is not a lap of the table -- it is a contest among the two
 * or three people who bid, and the question it asks each of them is "you
 * are behind, will you go higher?". Asking the person who is furthest
 * behind first is what makes that question meaningful, and it is the order
 * the contest resolves in.
 *
 * FIXED AT OPENING, NOT RE-SORTED ON EVERY RAISE. Re-sorting would move
 * every player's position in the queue each time anyone raised, so "next"
 * would depend on an ordering that had just changed underneath it -- a
 * player could be asked twice in a row, or skipped entirely, with no bad
 * line of code anywhere. The queue is a running order established when the
 * contest opens; the bids move within it.
 *
 * `nextSeat` COULD NOT DO THIS JOB, and the way it failed is worth keeping.
 * On a drop-out the caller passed the SHRUNKEN list plus the player who had
 * just left it, so `indexOf` returned -1, `(-1 + 1) % n` returned 0, and
 * the cursor silently jumped to the front of the queue every time. With an
 * ascending queue that lands on the lowest remaining bidder, which is very
 * nearly right -- an accident agreeing with the rule is the kind of thing
 * that survives review and then breaks when the ordering changes.
 */
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

/** The next bidder to be asked, skipping `highBidder` -- nobody is invited
 *  to outbid themselves (mirrors `waterfall::skip_leader_turns`). Pass
 *  `after = null` to start the queue from its front.
 *
 *  Returns `highBidder` only when the queue holds nobody else, which is a
 *  resolved contest the caller handles before reaching here. */
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
  /* ==================================================================
   *  DESIGN NOTE 336: THE CASCADE, WHICH WAS DOCUMENTED BUT NEVER RUN
   * ==================================================================
   *
   * REPORTED: a player holds the only bid on the B&O at $225. Another
   * player buys the private directly below it. The waterfall then offers
   * the B&O to the NEXT player at its $220 face value instead of resolving
   * it to the lone bidder.
   *
   * Which is worse than a missing feature -- it offers the company to
   * somebody else for $5 LESS than the standing bid, so the bidder is
   * punished for having bid. Anyone who noticed would simply stop bidding.
   *
   * THE RULE WAS ALREADY WRITTEN DOWN, in `WaterfallAuctionDashboard.tsx`'s
   * own status-badge comment: "0 bids leaves a private simply open, exactly
   * 1 bid is what the next cascade run auto-resolves to that sole bidder
   * ('auto-award'), 2+ bids is what starts a mini-auction." The UI has been
   * rendering an `isAutoAwardPending` badge for that state since design
   * note #14. Nothing ever performed the resolution the badge promised.
   *
   * IT CASCADES, hence the name and hence the loop. Awarding the lone-bid
   * private promotes the next one, which may itself carry a single bid,
   * which resolves in turn -- a table that has been bidding for several
   * rounds can settle three companies off one purchase. A single `if` would
   * have fixed the reported case and left the two-deep case wrong, which is
   * the harder bug to find because it needs a longer game to reach.
   *
   * TERMINATION: every iteration removes exactly one private from a finite
   * list, and the loop stops on 0 bids (buyable) or 2+ (contested). The
   * `privates.length` bound is belt-and-braces against a malformed fixture
   * whose `is_lowest_offered` never advances.
   */
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

    /* Design note #271: buying the cheapest private promotes the next one,
       and if THAT one is already contested the mini-auction opens now. This
       is the ordinary way a mini-auction starts in a real game -- bids
       accumulate on a private while it is too expensive to be the lowest
       offer, and land the moment it becomes one. */
    // Design note #336: the promoted private may be settled already.
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
        /* ==============================================================
         *  DESIGN NOTE 302: A RAISE IS A BID, SO IT GOES IN THE BID LIST
         * ==============================================================
         *
         * REPORTED: the mini-auction card shows the original bids rather
         * than updating, and the player with the LOWEST bid is marked as
         * leader.
         *
         * Both symptoms, one cause. A raise wrote only to
         * `mini_auction.high_bid`/`high_bidder` and left `priv.bids`
         * holding the OPENING bids that started the contest. The card
         * renders `priv.bids`, so the amounts froze at the moment the
         * mini-auction opened.
         *
         * The leader badge then looked wrong for a reason that is worth
         * separating out, because the badge logic was correct all along:
         * it marks whoever `high_bidder` names, and that IS the leader.
         * What was wrong was the NUMBER printed beside them -- their stale
         * opening bid, which in a contest the other player opened higher on
         * is the smaller of the two. A correct badge on a stale figure
         * reads exactly like a badge on the wrong player.
         *
         * So the raise is recorded where a bid belongs. One standing bid
         * per player (the same rule `WaterfallBidHigher` follows), so a
         * raise REPLACES rather than stacking. */
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
          /* ==============================================================
           *  DESIGN NOTE 338: A MINI-AUCTION DOES NOT CONSUME A MAIN TURN
           * ==============================================================
           *
           * REPORTED: mini-auctions break the Seating Order turn cursor --
           * after one ends, the action bar and the seating list highlight
           * the wrong player.
           *
           * This line was `current_turn: nextSeat(players,
           * waterfall.current_turn)`, and it advanced the MAIN rotation a
           * second time.
           *
           * The main cursor has already moved by the time a contest opens:
           * whichever action exposed it -- `WaterfallBidHigher` or
           * `WaterfallBuyLowest` -- advanced the seat as part of its own
           * arm, because that player used their turn. Everything inside the
           * contest then moves `mini_auction.current_turn` and only that,
           * which is correct: a raise is not a waterfall turn, it is a move
           * in a side auction among the bidders.
           *
           * So advancing again on resolution skipped exactly one seat, every
           * time. Four players, A on turn:
           *
           *   A bids on the cheapest      -> cursor B
           *   B bids on it, contest opens -> cursor C
           *   A drops out, B wins         -> cursor D   (C never acted)
           *
           * The seating rail and the hotseat gate both read this field, so
           * they agreed with each other and both pointed at the wrong seat
           * -- which is why the report describes it as a display bug.
           *
           * PRESERVED, not recomputed. `waterfall.current_turn` is already
           * the seat that was next when the contest began; the contest did
           * not touch it, so resuming is simply leaving it alone. */
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

    /* ==================================================================
     *  DESIGN NOTE 313: DROPPING OUT REFUNDS THE BID, SO THE BID GOES
     * ==================================================================
     *
     * REPORTED (with the escrow work): a player who drops out of a
     * mini-auction does not get their escrowed money back.
     *
     * The card's own tooltip has promised "your escrowed bid is refunded in
     * full" since design note #27, and the contest correctly removed them
     * from `mini_auction.bidders` -- but their bid stayed in
     * `privates[].bids`. With the escrow derived from that list
     * (`auctionEscrow.ts` design note #1), the money stayed locked for the
     * rest of the auction: a player could drop out of every contest and end
     * up unable to bid on anything, with a full balance on screen and no
     * available cash behind it.
     *
     * Removing the bid is also what makes the BID LIST honest. It is the
     * roster of who is still committed to this company, and a name in it who
     * has publicly walked away is telling the table something false --
     * `mini_auction.bidders` and `priv.bids` are two views of one contest
     * and they have to shrink together. */
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
          /* Design note #544: `after` is the player who just left, and they
             are no longer IN `remaining` -- so the search starts from the
             front of the shrunken queue, i.e. the lowest bidder still in.
             That is now the stated intent rather than `nextSeat`'s
             -1-index accident. */
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
  /** Where a token moved, and WHY, for the log line.
   *
   *  Design note #435: `reason` is new. Without it the shell had one
   *  sentence for every marker move and it named a sale, so a withheld
   *  dividend was reported as one. Three movers, three words. */
  moved: {
    companyId: number;
    from: number;
    to: number;
    reason: "sale" | "withhold" | "payout";
  } | null;
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
    const mark = prices[protocol_id] ?? null;
    if (mark === null || !ctx?.projectDividend) return unchanged;
    const landed = ctx.projectDividend(mark, distribute ? "pay" : "withhold");
    if (!landed || (landed.x === mark.x && landed.y === mark.y)) return unchanged;
    return {
      // Design note #646: likewise -- a dividend move is an arrival.
      prices: { ...prices, [protocol_id]: withArrival(prices, protocol_id, landed) },
      tradePrice: null,
      /* Design note #435: the REASON travels with the move. The shell
         logged every marker move as "on the sale", because that was the
         only mover when the sentence was written -- so a withheld dividend
         reported a sale that had not happened, on the one screen a player
         checks to understand why their price fell. */
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

/* ==================================================================
 *  DESIGN NOTE 642: THE ROUND MACHINE BELONGS TO THE REDUCER
 * ==================================================================
 *
 * REPORTED, over four separate passes: the Operating Round counter does not
 * increment, a one-round Yellow cycle runs twice, and an undo removes a train
 * without returning the turn to the corporation that bought it.
 *
 * Design notes #431, #511 and #621 each fixed a real defect in
 * `advanceCorporation` and none of them fixed the reported bug, because
 * `advanceCorporation` was never where it lived. Applying a message was split
 * across two places: this reducer changed the game, and then `App.tsx`'s
 * `runGameplayAction` noticed the round-boundary flags and performed the
 * transition itself -- building the Operating Round queue, closing the cycle,
 * incrementing `macro_round_number`.
 *
 * THAT SPLIT IS INVISIBLE UNTIL SOMETHING REPLAYS, and two ordinary things
 * do. A sandbox room reconstructs its board by re-applying the log from index
 * zero; an undo (`RevertTo`) shortens the history and forces exactly that
 * rebuild. Both run the reducer and neither runs the shell. So corporate
 * state came back precisely and round state did not -- a rebuilt board whose
 * corporations were correct and whose ROUND was wherever the last live
 * dispatch had left it. That is the reported undo, exactly: PRR's train came
 * off because the reducer owns trains, and PRR's turn did not come back
 * because the shell owned turns.
 *
 * THE PROJECT'S OWN RULE SAYS THIS: actions are appended to a log and read
 * sequentially by a single reducer path. A second path that also changes the
 * game is not a shortcut, it is a second source of truth -- and the failure
 * mode is not a wrong number, it is a board that cannot be rebuilt from its
 * own history.
 *
 * SO `applySandboxAction` IS NOW TWO STEPS. `applyOneAction` is the whole of
 * the old function, unchanged: it handles the message. `settleRoundTransitions`
 * then consumes any round-boundary flag that step raised. A caller gets one
 * function that takes a message and returns the state the game is genuinely
 * in, with no follow-up required of them.
 *
 * WHAT STAYS IN THE SHELL IS EVERYTHING THAT IS NOT THE GAME: the log line
 * announcing the round change, and the tab the player is looking at. Those
 * are reactions to a transition rather than part of it, they must NOT repeat
 * on every replayed action, and `App.tsx` now detects them by comparing the
 * round type before and after -- a fact about state, which replays correctly
 * by construction. */
export function applySandboxAction(
  state: GameStateResponse,
  msg: GameplayExecuteMsg,
  ctx?: SandboxActionContext,
): GameStateResponse {
  return settleRoundTransitions(applyOneAction(state, msg, ctx), ctx);
}

/* ==================================================================
 *  DESIGN NOTE 642a: THE FLAGS ARE CONSUMED WHERE THEY ARE RAISED
 * ==================================================================
 *
 * `recordPass` raises `stock_round_just_ended` when a full rotation of passes
 * closes the Stock Round; `advanceCorporation` raises
 * `operating_round_just_ended` when the last corporation of the last cycle
 * has operated. Both were designed as one-shot signals for the shell to read.
 *
 * They are still one-shot, and now nobody outside this file reads them: each
 * is consumed in the same dispatch that raised it, and cleared. A flag that
 * survives its own transition fires it again on the next action, which is the
 * other half of how a replay could run a Stock Round close once per remaining
 * message.
 *
 * ONE TRANSITION PER ACTION, deliberately, rather than a loop. A Stock Round
 * closing opens an Operating Round, and that Operating Round cannot also end
 * in the same dispatch -- it has corporations that have not operated yet. If
 * some future rule ever makes a double transition possible, it should be
 * written down and tested rather than absorbed silently by a `while`. */
function settleRoundTransitions(
  state: GameStateResponse,
  ctx?: SandboxActionContext,
): GameStateResponse {
  if (state.stock_round_just_ended) {
    /* Design note #411: the queue is BUILT here. Leaving it to the caller is
       what produced an Operating Round with `active_operating_order: []`,
       which `advanceCorporation` then "recovers" by rebuilding the round from
       scratch -- resetting the cursor to the first corporation while leaving
       the counter alone. That recovery is why a rebuilt board reappeared on
       B&O still calling itself Operating Round 1.1. */
    return {
      ...beginOperatingRound(state, ctx?.marketPriceFor, ctx?.marketMarkFor),
      stock_round_just_ended: false,
    };
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
  /* ==================================================================
   *  DESIGN NOTE 549b: AN UNKNOWN AUTHOR IS NOBODY, NOT WHOEVER IS HANDY
   * ==================================================================
   *
   * The first cut of this was `ctx?.actor ?? cursor`, and a test written
   * against it failed for a reason worth keeping: `??` makes an author the
   * reducer cannot place fall THROUGH to the local cursor -- which is
   * precisely the nondeterminism design note #549 exists to remove, quietly
   * reinstated as a fallback.
   *
   * It matters concretely, not just in principle. Log entries written before
   * design note #549a recorded the author's NICKNAME rather than their id,
   * so any room already in Firestore replays with authors that match no seat
   * at all. Falling back to the cursor would make those entries resolve
   * differently on every client -- the original bug, from data.
   *
   * So the three cases are separated and each says one thing:
   *
   *   undefined  no author was offered. Solo sandbox, where the cursor IS
   *              the actor and there is only one client to disagree.
   *   seated     the author, used.
   *   anything   null. The action applies to nobody and visibly does
   *   else       nothing, identically on every client. A no-op is a bad
   *              outcome; an outcome that differs per browser is a worse
   *              one, and only one of the two can be noticed and reported.
   */
  const logged = ctx?.actor;
  const actor =
    logged === undefined
      ? state.player_addresses[state.active_player_index] ?? null
      : logged !== null && state.player_addresses.includes(logged)
        ? logged
        : null;

  // ---- Passing means two different things, and the phase decides which.
  //
  // In a seat-driven round it is a player declining their turn, and a full
  // round of them ends the round. In an Operating Round the same message is
  // what the "End Operating Turn" button sends -- the CORPORATION is done,
  // and the queue moves to the next company. Treating both as a seat advance
  // would strand the Operating Round on its first corporation forever.
  if ("PassTurn" in msg) {
    return state.current_round_type === "OperatingRound"
      ? advanceCorporation(state, ctx?.marketPriceFor, ctx?.marketMarkFor)
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
    /* ==================================================================
     *  DESIGN NOTE 579: THE PRICE IS IN THE MESSAGE
     * ==================================================================
     *
     * REPORTED: a corporation parred at $67 charged $67 to its founder and
     * $100 to everybody, in the log and in the wallet -- and the same game
     * showed the two players different cash totals for each other.
     *
     * `ctx.parValue` and `ctx.sharePrice` are both assembled by the CALLER,
     * in `App.tsx`, from that browser's own par ladder and market atom. On
     * the acting client the ladder holds the rung the player just picked; on
     * every replaying client it is empty and falls through to
     * `MOCK_BUY_STOCK_PAR_VALUE` -- the string "100". So the founding buy
     * wrote `par_value: "67"` on one machine and `"100"` on the other, and
     * every later price, every cash total and eventually the corporation's
     * float capitalisation ($820 against $1000) followed from that.
     *
     * THE TELL WAS IN THE REPORT: the NNH "tracks correctly for both
     * players". The NNH was parred at $100 -- the fallback. It was not
     * working; it was agreeing with the wrong answer by coincidence.
     *
     * THIS IS THE THIRD TIME (design notes #549 the actor, #553 the ladder,
     * now the price). Same shape every time: a shared fact derived from a
     * per-browser value. The rule that follows, and it is now a rule rather
     * than three fixes: IF THE REDUCER NEEDS IT TO DECIDE, IT TRAVELS IN THE
     * MESSAGE. `ctx` is for things that are the same on every client by
     * construction -- the map, the era -- and for nothing else.
     *
     * `par_value` HAS BEEN IN THE MESSAGE ALL ALONG. `BuyStock` carries it
     * because that is how a founding purchase names its price; the reducer
     * simply was not reading it. */
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

    /* ==================================================================
     *  DESIGN NOTE 351: THE FIRST IPO SHARE IS TWO SHARES
     * ==================================================================
     *
     * REPORTED: when floating an IPO the first purchaser picks a par value,
     * but the UI records a 10% share, does not mark them President, and
     * leaves the par selector open for the next player.
     *
     * All three are one omission. In 1830 the first certificate out of an
     * IPO is the PRESIDENT'S CERTIFICATE: 20% of the company for twice the
     * par price, and with it the presidency and the par price itself, set
     * once and never again. This arm moved a flat `SANDBOX_SHARE_PERCENTAGE`
     * and charged a flat `price` for every purchase, so the founding buy was
     * indistinguishable from the fifth one.
     *
     * The consequences compounded rather than staying cosmetic: with
     * `president` never set, the card kept offering the par ladder (it
     * gates on `par_value === null`), the ledger's certificate count was
     * wrong by one, and `soldToPlayersPercent` under-reported by 10% so the
     * 60% float threshold arrived a purchase late.
     *
     * `StockRoundPanel` has PRICED this correctly all along -- its design
     * note #35 quotes "@ $134" for a $67 par -- so the panel was already
     * telling the player something the reducer then did not do. That gap is
     * what makes it worth writing down: a UI quoting a transaction the
     * state does not perform is the shape this codebase keeps removing.
     *
     * ==================================================================
     *  DESIGN NOTE 587: SHARES WITHOUT A PRESIDENT IS NOW A LEGAL STATE
     * ==================================================================
     *
     * REPORTED: a player holding the PRR share the Camden & Amboy grants
     * tried to buy the PRR's president's certificate. They were asked to set
     * a par and charged twice it -- and received a 10% share, no presidency
     * and no recorded par.
     *
     * The old test was `president === null && !anyHeld`, and design note #36
     * defended the second clause: "a malformed fixture with holders but no
     * president degrades to an ordinary 10% share rather than handing out a
     * second President's Certificate."
     *
     * That was sound when the only way to hold shares was to buy them, so
     * holders-without-a-president really did mean malformed. The C&A's
     * purchase bonus (design note #576) makes it a NORMAL opening position:
     * a corporation nobody has started, with one certificate already in a
     * player's hand. The conservative guard then refuses the founding
     * purchase to the one player most likely to make it.
     *
     * SO THE TEST IS "HAS THIS CORPORATION BEEN STARTED", which is what the
     * rule is actually about -- and `par_value` is the field that answers
     * it. An unstarted company has no price; a started one does, and its
     * president's certificate is already gone. Two fields that move together
     * at the moment of founding, so requiring both is a genuine safety net
     * rather than a second opinion about stray holdings.
     *
     * THE UI AGREED WITH THE OLD TEST, which is why the prompt appeared and
     * the charge was doubled while the grant was not -- `StockRoundPanel`
     * offered a president's purchase the reducer then declined to make. Both
     * now ask the same question.
     */
    const target = state.public_companies.find((c) => c.company_id === protocol_id);
    const isPresidentBuy =
      source !== "Bank" &&
      !!target &&
      target.president === null &&
      (target.par_value === null || target.par_value === undefined) &&
      !!actor;

    const percentage = isPresidentBuy
      ? SANDBOX_PRESIDENT_PERCENTAGE
      : SANDBOX_SHARE_PERCENTAGE;
    const charged = isPresidentBuy ? price * 2 : price;

    const spent = actor ? adjustCash(state, actor, -charged) : state;
    const banked = adjustBank(spent, charged);
    const moved = moveShares(
      banked,
      protocol_id,
      actor,
      source === "Bank" ? "Bank" : "Ipo",
      percentage,
    );

    /* The presidency and the par price, together -- they are set by the
       same act and the panel locks its ladder on `par_value !== null`, so
       writing one without the other would leave the selector open on a
       company that already has a president. `ctx.parValue` is the ladder
       selection the panel had when it dispatched. */
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

    /* Design note #363: buying is the only action that can cross the float
       threshold, so the check rides on it rather than running on every
       dispatch. `ctx.homeHexToAxial` is injected by the caller; without it
       the company still floats, it just gets no token -- which is better
       than not floating at all. */
    const floated = ctx?.homeHexToAxial
      ? applyFloatThreshold(crowned, ctx.homeHexToAxial)
      : crowned;

    /* Design note #596: a purchase can take the presidency off somebody. Run
       AFTER the float check, because a buy that both floats a company and
       crowns a new president must resolve the float against the holdings that
       caused it, not against a board mid-transfer. */
    return advanceSeat(markTrader(settlePresidencies(floated).state, actor));
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
    /* Design note #596: a SALE moves the crown too, and this direction is the
       one players forget -- selling down below another holder hands them the
       presidency whether or not that was the intention. Settled by the same
       function as the buy, so the two cannot disagree about who leads. */
    // Design note #352: selling counts as trading for the Priority Deal.
    return markTrader(
      { ...settlePresidencies(returned).state, consecutive_passes: 0 },
      actor,
    );
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
    /* ================================================================
     *  DESIGN NOTE 432: THE TERRAIN IS WHAT COSTS MONEY
     * ================================================================
     *
     * REPORTED: laying track on the $80 water hex J14 deducted $20.
     *
     * It deducted `SANDBOX_NOMINAL_TILE_COST` -- a flat $20 charged for
     * every tile on every hex, clear ground and mountain alike. The $20
     * was never a rule; it was a placeholder from before the board had
     * terrain, and it survived because a fixed fee looks like a fee.
     *
     * 1830 charges nothing for the tile itself. What it charges for is the
     * GROUND: $80 to bridge a river, $120 to cross a mountain, $0 on clear
     * land. `terrainBuildFeeAt` is the frontend's mirror of
     * `hexmap::terrain_build_fee` and has carried those exact figures all
     * along -- the renderer has been DRAWING $80 on J14 while the reducer
     * charged $20 for it, which is this codebase's recurring failure shape:
     * a UI quoting a transaction the state does not perform.
     *
     * BY COORDINATE, NOT BY TILE. The fee is a property of the hex, not of
     * the tile laid on it, so it comes off `(q, r)` in the message. The
     * report's phrasing -- "grabbing the tile's base revenue value" -- is
     * close to what was happening and worth being exact about: the $20 was
     * not read from the tile at all, it was a constant. Either way the
     * money owed was the hex's and the number charged was not.
     *
     * ZERO IS A REAL ANSWER. Most of the board is clear ground and lays
     * free; `adjustTreasury` with `-0` is a no-op, so an ordinary lay now
     * costs nothing rather than $20, which is also the correction 1830
     * asks for. */
    const { protocol_id, q, r } = msg.LayTile;
    return adjustTreasury(state, protocol_id, -terrainBuildFeeAt(q, r));
  }

  if ("BuyHardwareFromPool" in msg) {
    return buyDepotTrain(state, msg.BuyHardwareFromPool.protocol_id);
  }

  if ("EmergencyBuyHardware" in msg) {
    /* ================================================================
     *  DESIGN NOTE 333: THE PRESIDENT'S MONEY ACTUALLY MOVES
     * ================================================================
     *
     * This arm was `buyDepotTrain` verbatim -- the same call as the
     * ordinary `BuyHardwareFromPool` above it, which charges the TREASURY
     * and nothing else. The emergency case is precisely the one where the
     * treasury cannot pay, and `adjustTreasury` floors at zero, so the
     * corporation paid what it had, the shortfall evaporated, and the
     * president's wallet was untouched.
     *
     * That is the exact failure this codebase keeps removing: a path that
     * REPORTS a transaction it did not perform. `EmergencyTrainPurchaseModal`
     * tells the president they are about to pay $220 of their own money;
     * if the reducer does not take it, the modal is lying to them and the
     * balances on screen quietly disagree with the sentence in the log.
     *
     * So the payment is split the way 1830 splits it: the treasury pays
     * everything it has, and the president covers the remainder from
     * personal cash. `buyDepotTrain` then runs with a treasury topped up
     * to exactly the train's price, so its own arithmetic -- the bank
     * credit, the delivery, the phase check -- is unchanged and there is
     * no second copy of it here.
     *
     * WHAT THIS STILL DOES NOT DO is sell shares. If the president's cash
     * is short too, `adjustCash`'s zero floor means they simply pay what
     * they have and the purchase completes underfunded. The modal will not
     * enable its confirm in that state (`mustRaiseBySelling > 0` disables
     * it), so the sandbox cannot reach it through the UI -- and the real
     * rule needs the forced-sale message that design note #1 in the modal
     * records as missing from `ExecuteMsg`. */
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
    /* Tokens are drawn from `station_token_hexes`, so appending there is what
       makes one appear on the canvas.
       ==================================================================
        DESIGN NOTE 560: RECORDING A CHOICE IS NOT INVENTING A RULE
       ==================================================================

       This used to leave `station_tokens` alone on purpose, and said why:
       "which city slot a token occupies is resolved by
       `hexmap::execute_place_station_token` against real slot counts, and
       guessing it here would be exactly the kind of rule-shaped invention
       design note 0 rules out."

       That is right about GUESSING and it was applied to a case where
       nothing had to be guessed. `city_index` is already in the message --
       the player clicked a specific city and design note #453 resolved which
       one. Declining to write it down is not restraint; it discards
       information the app was given and then falls back to a heuristic that
       picks the first slot on every multi-city tile.

       So the slot is recorded ONLY when the message carries one. Absent, the
       old behaviour stands exactly as before, which is the case design note
       0 was actually protecting. */
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
     * two dividend choices then moves that money, once.
     *
     * ================================================================
     *  DESIGN NOTE 492a: A TURN'S ROUTES ARE A SUM, NOT THE LAST ONE
     * ================================================================
     *
     * This ASSIGNED `String(earned)`, and `RunManualRoute` declares one
     * train (design note #275) -- so a corporation running three trains sent
     * three messages and each overwrote the one before it. The field ended
     * the turn holding the third train's revenue, and the Operating Round
     * table's "Last Route Payout" column under-reported every multi-train
     * run it has ever shown.
     *
     * It ADDS now, and `ctx.resetRouteRevenue` marks the first message of a
     * batch so the sum belongs to this turn rather than growing forever.
     * `App.handleRunTrains` is the only sender and dispatches its whole batch
     * in one loop, so it is the one caller that knows which message is first
     * -- the reducer cannot tell, and guessing from the state would be a
     * heuristic where a fact is available.
     *
     * WHY NOT RESET ON A TURN BOUNDARY INSTEAD. There is no message for one.
     * `AdvanceOperatingSubPhase` fires on a SKIP, inside a turn, and the
     * Routes-to-Dividends step change is `App`-local state that this reducer
     * never sees. A reset keyed to any of those would fire at the wrong
     * moments and zero a total mid-run.
     *
     * THE DIVIDEND MONEY DOES NOT DEPEND ON THIS. `DeclareDividends` below
     * prefers the message's own `revenue_amount`, which `App` fills from the
     * committed total (design note #492). This field is what the LEDGER
     * shows, and it was wrong on its own account. */
    const previous = ctx?.resetRouteRevenue
      ? 0
      : Number(
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

/* ==================================================================
 *  DESIGN NOTE 363: FLOATING PUTS A TOKEN ON THE BOARD
 * ==================================================================
 *
 * REPORTED: when ERIE (or another corporation) floats, the UI neither
 * places nor prompts for its home station marker.
 *
 * It did not, because nothing in the sandbox ever floated anything.
 * `is_floated` was seeded by the fixtures and never written again -- so a
 * corporation could cross 60% sold and stay unfloated forever, with an
 * empty `station_token_hexes` and a treasury that never received its
 * capitalisation. The Stock Round could distribute every certificate in a
 * company and nothing on the board would change.
 *
 * FLOATING IS A THRESHOLD, WHICH IS WHY IT BELONGS HERE. This file's
 * design note #0 draws the line at rules the contract owns, and the float
 * check is on the same side as the phase change (design note #284b) and the
 * all-pass markdown: a counter reaching a number, with a consequence that
 * is bookkeeping. WHAT floats a company (60% sold to players) is the
 * contract's rule and is read from `FLOAT_THRESHOLD_PERCENT`; what happens
 * when it does -- the flag flips, the home token goes down -- is moving
 * pieces.
 *
 * THE TOKEN IS PLACED, NOT PROMPTED. 1830 grants the home station free and
 * puts it on a hex printed on the board; there is no decision for a player
 * to make, so a prompt would be asking a question with one answer. The
 * report says "place or prompt"; place is the correct half.
 *
 * ===================================================================
 *  DESIGN NOTE 376: THE TREASURY, NOW THAT THE MODE IS SETTLED
 * ===================================================================
 *
 * REPORTED: a corporation that floats keeps a $0 treasury.
 *
 * It did, and this note previously said so and declined to fix it: "full
 * capitalisation pays the company 10x its par price, and `par_value` is set
 * but the CAPITALISATION MODE is `market.rs`'s -- 1830 has full,
 * incremental and part variants and this build has not established which
 * the contract implements."
 *
 * The mode is now established as FULL: exactly ten times par, credited the
 * moment the company floats. That was the open question, so the reason for
 * holding back is gone and the credit lands here with the flag and the
 * token, in the one place that knows a corporation just floated.
 *
 * THE BANK PAYS IT. Capitalisation is the corporation selling its shares to
 * the players, and the money the players spent has already gone to the bank
 * (`BuyStock` banks every purchase) -- so this is that money coming back
 * out, not new money appearing. Skipping the debit would inflate the game's
 * total supply and push back the bank-break ending, which is a real 1830
 * end condition (`endgame.ts`'s `bankIsBroken`).
 *
 * NO PAR, NO CREDIT. `par_value` is null for a company that somehow floated
 * without one -- which the B&O private can produce, since it grants the
 * presidency and leaves par for the winner to set (design note #354). Ten
 * times nothing is nothing, and inventing a default here would put a figure
 * in a treasury that every later comparison trusts.
 */
export const FLOAT_THRESHOLD_PERCENT = 60;

/** Design note #376: full capitalisation pays ten times par. */
export const FULL_CAPITALISATION_MULTIPLE = 10;

/** How much of `company` sits in players' hands. */
function soldToPlayersPercent(company: PublicCompanyState): number {
  return company.player_holdings.reduce((sum, entry) => sum + entry.percentage, 0);
}

/**
 * Floats every corporation that has crossed the threshold and drops its
 * home token.
 *
 * Returns the SAME state when nothing changed, so callers can skip a
 * re-render and a log write on identity.
 *
 * `homeHexToAxial` is injected because the label -> `(q, r)` table lives in
 * `components/hexBoardData.ts` and this module resolves board geometry
 * through its caller rather than importing a renderer's data -- the same
 * one-way rule `routeAutoTrace`'s injected helpers follow.
 */
export function applyFloatThreshold(
  state: GameStateResponse,
  homeHexToAxial: (label: string) => readonly [number, number] | null,
): GameStateResponse {
  let changed = false;
  // Design note #376: what the bank pays out this pass, in one debit.
  let capitalised = 0;

  const companies = state.public_companies.map((company) => {
    if (company.is_floated) return company;
    if (soldToPlayersPercent(company) < FLOAT_THRESHOLD_PERCENT) return company;

    changed = true;

    /* Design note #376: ten times par, into a treasury that was empty. Added
       to whatever is there rather than assigned, so a company that somehow
       already holds money is not silently reset by floating. */
    const par = Number(company.par_value);
    const capital =
      Number.isFinite(par) && par > 0 ? par * FULL_CAPITALISATION_MULTIPLE : 0;
    capitalised += capital;
    const treasury = String((Number(company.treasury) || 0) + capital);

    /* ================================================================
     *  DESIGN NOTE 416: THE TOKEN IS PROMPTED, NOT PLACED
     * ================================================================
     *
     * REPORTED: stop auto-placing the home station. When a corporation
     * floats, halt and make the president place it explicitly, even though
     * the destination hex is fixed by the rules.
     *
     * Design note #363 placed it automatically and argued the case: "1830
     * grants the home station free and puts it on a hex printed on the
     * board; there is no decision for a player to make, so a prompt would
     * be asking a question with one answer."
     *
     * That reasoning is about the RULES and the requirement is about the
     * PLAYER, and on this one they come apart. The float is the most
     * consequential thing that happens to a corporation -- it gains a
     * treasury, an operating turn and its first piece on the map -- and
     * placing the token silently meant the single most visible half of it
     * happened while the player was looking at a stock card on another tab.
     * A first token appearing on a board nobody was watching teaches
     * nothing about where that corporation now operates from.
     *
     * The prompt is therefore not asking WHICH hex. It is making the player
     * witness the placement, and it names the hex while doing so. That is
     * why it can be a confirmation rather than a map interaction and still
     * satisfy the requirement.
     *
     * WHAT THIS FUNCTION DOES NOW is float and capitalise, and stop. The
     * token is placed by `placeHomeStationToken` below, dispatched when the
     * prompt is answered. `homeHexToAxial` is still taken -- unused for
     * placement, still the thing that decides whether a home hex RESOLVES,
     * because a company whose label maps to nothing must not raise a prompt
     * that can never be satisfied. */
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

/**
 * Every floated corporation whose printed home hex has no token on it yet.
 *
 * Design note #416: derived from state rather than reported by the reducer,
 * for the reason design note #363 records about floats generally -- the
 * condition is a fact about the board that is true until it is answered, so
 * a poll landing late, twice, or after a reload finds it just the same. A
 * one-shot flag would lose the prompt on refresh and leave a corporation
 * permanently owing a token nothing would ask for again.
 *
 * ORDERED BY `active_operating_order` WHERE ONE EXISTS, so two corporations
 * floating on the same dispatch are prompted in operating order rather than
 * in whatever order `public_companies` happens to hold -- the same order
 * they will act in, which is the one a player can predict.
 *
 * A company with no `home_hex_label`, or one whose label does not resolve,
 * is ABSENT rather than pending: NNH has no home hex on this board (design
 * note #363), and raising a prompt whose hex cannot be named would be a
 * modal with no legal answer.
 */
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

/**
 * Puts a corporation's home station token on its printed hex.
 *
 * Design note #416: the other half of the prompt. Separate from
 * `applyFloatThreshold` because they now happen at different moments -- the
 * float when the 60th percent sells, the token when the president answers
 * -- and folding the second back into the first is exactly how it became
 * automatic in the first place.
 *
 * IDEMPOTENT. Returns the same object when the token is already down, so a
 * double-click, a replayed dispatch or a poll arriving between the click
 * and the state write cannot stack two tokens on one hex.
 */
export function placeHomeStationToken(
  state: GameStateResponse,
  companyId: number,
  q: number,
  r: number,
  /** Design note #560: WHICH city on the hex. `null` leaves the renderer's
   *  heuristic in charge, which is right for a single-city hex and is the
   *  only honest answer when the click could not be resolved. */
  cityIndex: number | null = null,
): GameStateResponse {
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company || !company.is_floated) return state;
  if (company.station_token_hexes.some(([hq, hr]) => hq === q && hr === r)) return state;

  return {
    ...state,
    public_companies: state.public_companies.map((entry) =>
      entry.company_id === companyId
        ? {
            ...entry,
            // Home token first, matching `grant_home_station_token`'s own
            // ordering -- several readers take `[0]` as "the home station".
            station_token_hexes: [[q, r] as [number, number], ...entry.station_token_hexes],
            /* Design note #560: the slot registry, written in the SAME
               order and in the same breath. Two arrays describing one set of
               tokens have to move together or the second becomes a partial,
               stale index of the first -- and a partial index is worse than
               none, because the renderer trusts it. */
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
}

/* ==================================================================
 *  DESIGN NOTE 327: THE PRIVATES NEVER PAID
 * ==================================================================
 *
 * REPORTED: private companies do not pay their per-Operating-Round revenue
 * to their owners.
 *
 * They did not, and nothing in the app was arranged to. `revenue_per_or`
 * has been on `PrivateCompanyState` since the schema was written and every
 * private card has printed it -- as a PROPERTY of the company, like its
 * name. No code path ever turned it into money. So a player who paid $220
 * for the B&O in the auction watched a "$30 / OR" label sit on their card
 * for the rest of the game while their cash never moved, which quietly
 * inverts the auction's whole economics: the expensive privates are
 * expensive precisely because they pay.
 *
 * ===================================================================
 *  DESIGN NOTE 328: ONCE PER ROUND, NOT ONCE PER CORPORATION
 * ===================================================================
 *
 * The subtle way to get this wrong is to pay on every Operating Round
 * TURN. An Operating Round runs one turn per floated corporation, so on a
 * board with six floated companies the privates would pay six times a
 * round -- and the bug would look like generosity rather than an error,
 * which is the kind that survives playtesting.
 *
 * This function is therefore a pure "what does one round of private income
 * look like", and the CALLER owns the trigger. `App.tsx` fires it on the
 * `current_round_type` transition INTO `OperatingRound`, which happens
 * exactly once per round by construction.
 *
 * ===================================================================
 *  DESIGN NOTE 329: WHO PAYS, AND WHO IS SKIPPED
 * ===================================================================
 *
 * THE BANK PAYS. Private revenue is income from outside the game, not a
 * transfer between players, so the bank is debited -- which matters
 * because 1830 ends when the bank breaks, and privates paying out of
 * nowhere would postpone the end of the game indefinitely.
 *
 * THREE PRIVATES ARE SKIPPED, for three different reasons:
 *
 *   UNOWNED    still in the auction. It pays nobody because nobody holds
 *              it; the money simply is not earned yet.
 *   CLOSED     out of the game at Phase 5. `closed` is checked before
 *              `owner`, because a closed private can still carry its last
 *              owner's address and paying on it would be paying for a
 *              certificate that no longer exists.
 *   CORPORATE  `owner_protocol_id` rather than `owner` -- a private bought
 *              by a corporation pays that CORPORATION's treasury, not a
 *              player's wallet. That is a real 1830 rule and it is modelled
 *              here rather than skipped, because the phase-gated corporate
 *              purchase is already implemented (`PrivateTradePanel`) and a
 *              private that stopped paying the moment it was sold to a
 *              company would make that feature look broken.
 */
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

/**
 * One Operating Round's worth of private company income.
 *
 * Returns the SAME state object and an empty list when nothing is owed, so
 * a caller can skip its log write and its re-render on identity.
 */
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

/* ==================================================================
 *  DESIGN NOTE 354: THE B&O PRIVATE CARRIES A PRESIDENCY
 * ==================================================================
 *
 * REPORTED: the player who wins the B&O private in the auction should
 * immediately be credited the 20% B&O President's Certificate and prompted
 * to set its par value -- without paying for the certificate -- and the B&O
 * should still not float until 60% is sold.
 *
 * Every surface has DESCRIBED this since the catalog was written ("the
 * winner receives the 20% B&O President's Certificate free, immediately
 * sets B&O's par value...") and nothing performed it. So the auction's most
 * expensive private, the one a player pays $220 for precisely because it
 * comes with a company, delivered a revenue stream and nothing else.
 *
 * WHAT MOVES AND WHAT DOES NOT, and the split is the whole rule:
 *
 *   MOVES        20% out of the B&O's IPO into the winner's holding, and
 *                `president` to the winner.
 *   DOES NOT     any cash. The certificate is GRANTED, not bought --
 *                charging par here would bill the player twice for one
 *                private.
 *   STAYS PUT    `is_floated`. 1830 floats on 60% SOLD, and 20% is not 60%.
 *                No corporation floats during the Auction Round at all --
 *                the auction sells privates, and no share changes hands in
 *                it. `StockRoundPanel` renders "parred, presided over, not
 *                yet floated" as an ordinary state.
 *
 *                Design note #445: this used to cite that panel's
 *                "Auto-floated by the B&O private" badge as evidence the UI
 *                was "ready for" this position. The badge named a rule 1830
 *                does not have and has been removed; the reducer's
 *                behaviour here was always correct and is what the panel
 *                now agrees with.
 *   SET NOW      `par_value`, from the winner's own choice.
 *
 *                ==================================================
 *                 DESIGN NOTE 399: THE PROMPT HAS TO BE A PROMPT
 *                ==================================================
 *
 *                This note used to read "STAYS UNSET -- the panel's ladder
 *                shows while par is null, which IS the prompt". Playtest
 *                says otherwise, and the reasoning was wrong in two ways
 *                that only show up in play:
 *
 *                  NOBODY IS LOOKING AT THE PANEL. The B&O is won during
 *                  the AUCTION. The Stock Round panel with its ladder is a
 *                  different round on a different tab, so "the ladder is
 *                  the prompt" meant the prompt appeared some minutes
 *                  later, on a screen the player had to navigate to, with
 *                  nothing connecting it to the private they just bought.
 *
 *                  AND THE LADDER STOPPED BEING VISIBLE. Design note #396
 *                  hid every card's actions behind an active-card click, so
 *                  the implicit prompt is now two clicks deep. That change
 *                  was right on its own terms and it removed the last thing
 *                  holding this design up.
 *
 *                An unparred company with a president is also a genuinely
 *                broken state -- design note #387 withholds its market
 *                token and its price, so the B&O would sit presided-over,
 *                priced at "--", and absent from the chart until someone
 *                found the ladder. Taking the par WITH the grant means that
 *                state never exists.
 *
 *                `parValue` is therefore required by this function. The
 *                caller collects it first; see `BoParPrompt`.
 *
 * A NAMED FUNCTION rather than sixty lines inline in the dispatch closure,
 * and that was not the first shape: the inline version passed a whole suite
 * of assertions that only ever read the source text, and survived being
 * switched off entirely. Anything worth this much comment is worth being
 * callable on its own.
 *
 * Returns the SAME state when there is nothing to do -- no B&O, or one that
 * already has a president -- so the caller can skip its log on identity.
 */
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

/**
 * "ERIE floated with $1000 and placed its home station token on E11."
 *
 * ==================================================================
 *  DESIGN NOTE 400 (message half): NAMED, SO IT CAN BE TESTED
 * ==================================================================
 *
 * REPORTED: a company floating skips the home-token placement feedback
 * entirely.
 *
 * The announcement was written inline in `App.tsx`'s dispatch closure, and
 * mutation testing said what design note #354 already learned the hard way
 * about `grantBOPresidency`: an inline version "passed a whole suite of
 * assertions that only ever read the source text, and survived being
 * switched off entirely". Switching the hex branch off here produced the
 * same result -- every source regex still matched, because the strings were
 * still in the file.
 *
 * So the decision that has branches is a function with a return value.
 * `null` for a company that did not just float, which is also what makes
 * "did this float?" answerable without re-deriving the comparison.
 */
/* ==================================================================
 *  DESIGN NOTE 467: THE FLOAT LINE DESCRIBED A WORLD THAT ENDED
 * ==================================================================
 *
 * REPORTED: the activity log says "It has no home hex on this board" when
 * the PRR floats. The PRR has a home hex.
 *
 * This function had two branches, and the wrong one had become
 * unreachable-in-reverse. It reported the token placement when a token had
 * just appeared (`gained`), and fell through to "no home hex" otherwise --
 * which was correct while `applyFloatThreshold` placed the home token as
 * part of floating.
 *
 * Design note #416 stopped it doing that. The token is now PROMPTED, so no
 * float ever gains one in the same breath, `gained` is always false, and
 * every corporation in the game -- home hex or not -- got the sentence
 * written for the one that has none. A true statement about NNH, applied
 * to all eight.
 *
 * THE BRANCHES ARE THE SAME TWO, RE-AIMED. The question is no longer "did a
 * token appear" -- none ever does here -- it is "does this corporation have
 * a home to place one on". That is a property of the company, known
 * immediately, and it splits exactly the two cases the log needs to
 * describe:
 *
 *   HAS A HOME   the placement is now OWED, and saying so is what makes the
 *                prompt that follows make sense rather than arrive
 *                unexplained.
 *   HAS NONE     NNH, which genuinely has no home hex on this board. The
 *                old sentence was always right about this one and is kept
 *                verbatim for it.
 */
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
