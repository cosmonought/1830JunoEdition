// frontend/src/utils/replayLog.ts
//
// The reducer, run outside React.
//
// ==================================================================
//  DESIGN NOTE 1186: THE PROVIDER BUNDLE IS THE MIGRATION'S SCOPE
// ==================================================================
//
// PHASE 0 OF THE SERVER MIGRATION, and it deliberately writes no game logic. `App.tsx` owns the only call
// site of `applySandboxAction` in the project (#536: "one order of operations for every client"), and that
// call site is ~300 lines of React interleaved with logging, modals and refs. Nothing else can execute the
// reducer -- so nothing that is not a browser can answer a question about a recorded game.
//
// THIS IS THAT CALL SITE WITH THE REACT TAKEN OUT. Same order, same injections, same atoms.
//
// `ReplayProviders` BELOW IS THE POINT OF THE FILE. Every field on it is a value the reducer cannot compute
// for itself and must be handed -- and the reason each one is injected is recorded at its own declaration in
// `SandboxActionContext` (#411, #646, #746a, #757, #273: "utils/ may not import components/"). Collected in
// one place they stop being seven scattered exceptions and become an inventory:
//
//   SEVEN OF THEM COME FROM THE MARKET CHART, and the chart is an atom the SHELL owns, maintained separately
//   by every client. That is the whole of the handoff's open root cause. `buildOperatingOrder` sorts on
//   price, column and arrival; all three arrive through this bundle; two clients whose charts differ produce
//   different turn orders. Proven at indices 310/311 of `sandbox-log-JUNO-3XD.json`.
//
//   SO PHASE 1 IS MEASURABLE: it is finished when the market fields below are gone from this interface,
//   because they have become part of the state the reducer owns and the log produces. Anything still here is
//   still a way for two clients to disagree.
//
// THE FILE OBEYS #273 RATHER THAN ROUTING AROUND IT. The rule is narrower than "no imports from
// `components/`" -- `sandboxSession.ts` itself imports the hex catalog and geometry from there. What it
// forbids is `utils/` reaching for THE CHART and THE LEGALITY ENGINE, because those are stateful surfaces
// the shell owns. So types come from `components/hexContractTypes` as they do next door, and every chart
// projection and the lay predicate arrive as parameters -- exactly as they arrive at the reducer. That keeps
// the seam visible instead of laundering it through a helper.
//
// WHAT THIS DOES NOT YET DO, stated plainly rather than discovered later:
//
//   SIX `isSandboxOnlyMsg` MESSAGES ARE STILL SHELL-OWNED (#1189): the two negotiation pairs and
//   `CloseRoom`. None of them appears in `JUNO-3XD`, so this replay does not exercise them -- which is not
//   the same as their being done.
//
//   THE AUCTION'S CASH IS NOW APPLIED (#1192), AND IT WAS THE PHASE 2 LOCK. The note that used to sit here
//   said player cash was untrustworthy, and that this did not matter for the first question because route
//   revenue depends on the grid and the era rather than on the auction's money. The first half was true.
//   The second was wrong in an instructive way: revenue is indeed independent of the auction, but the PHASE
//   is not. Unapplied charges left corporate treasuries too thin to buy past the 2-trains, so the phase
//   froze at 2, `operatingRoundsForPhase` locked every Operating Round set at one round, and the cursor
//   drifted a full macro round -- which fed different inputs to `rollTurnRevenue` and changed the revenue
//   after all. A gap declared harmless on the strength of what it directly touched, doing its damage three
//   steps downstream. Worth remembering the next time this file says something does not matter yet.

import {
  applySandboxAction,
  applySandboxLayTile,
  applySandboxMarketAction,
  applySandboxWaterfallAction,
  type SandboxActionContext,
  type SandboxMarketContext,
} from "./sandboxSession";
import type { SandboxMarketPrices } from "./sandboxState";

import {
  applyPrivateExchange,
  CA_BONUS_TICKER,
  CA_PRIVATE_ID,
} from "./privateExchange";
import { isOpenStockRoundMsg } from "./gameSetup";
import { nextDerivedAction } from "./derivedActions";
import { operatingCorporationId } from "./dividendGate";
import { turnGuardKey } from "./turnGuardKey";
import { effectiveActions } from "./logRevert";
import { derivePhase } from "./gamePhase";
import { ERA_FOR_PHASE_TINT } from "./gameConstants";
import type { GameStateResponse, WaterfallStateResponse } from "./gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";

/** One entry as the log stores it. Structurally `SandboxAction`, restated so this module does not depend on
 *  the Firestore layer -- a log read from a file and a log read from a room must replay identically, and a
 *  shared type is the cheapest way to be sure they do. */
export interface ReplayEntry {
  index: number;
  id: string;
  actor: string;
  /** Design note #1 in `sandboxRoom.ts`: JSON TEXT, not a nested map. Firestore rejects nested arrays and
   *  `RunManualRoute.path` is one -- so the payload is stringified once by the dispatching client and
   *  distributed verbatim, and every client applies structurally identical bytes.
   *
   *  THAT ACCIDENT IS WHAT MAKES SETTLEMENT HASHABLE. The migration plan's log commitment is taken over
   *  these strings in `(index, id)` order; because nobody re-serializes, there is no key-ordering drift to
   *  guard against. Recorded here because a future refactor "tidying" this into a nested object would break
   *  the settlement hash silently, months later. */
  payload: string;
  at?: number;
  derived?: boolean;
}

/** One entry as the DEBUG EXPORTER writes it, which is not the shape the log stores.
 *
 *  ==================================================================
 *   DESIGN NOTE 1188: THE EXPORT AND THE LOG DISAGREE ABOUT ONE FIELD
 *  ==================================================================
 *
 *  FOUND BY THE HARNESS ON ITS FIRST RUN, which is what it was built for. `SandboxAction.payload` is JSON
 *  TEXT; Ctrl+Shift+L emits `msg` as a NESTED OBJECT. So every consumer of an export -- this replay,
 *  `revertTargetOf`, `seedAlreadyRolled` -- reads `undefined` and silently does nothing. The revert at index
 *  20 of `JUNO-3XD` replayed as a no-op until this was noticed.
 *
 *  AND IT MATTERS BEYOND THE HARNESS. The migration plan's settlement hash is taken over `payload` STRINGS,
 *  precisely because those bytes are minted once by the dispatching client and never re-serialized. An export
 *  that drops them means a player cannot independently recompute the hash from what they were given -- which
 *  is the entire point of letting them export. `JSON.stringify` of a reparsed object is usually identical and
 *  is not guaranteed to be, and "usually" is the failure mode that shows up on one browser months later.
 *
 *  SO THE EXPORTER SHOULD CARRY `payload` VERBATIM before anything depends on the hash. Recorded here rather
 *  than fixed here: the exporter lives in the shell, and this file is not allowed to be the place a wire
 *  format is decided. */
export interface ExportedEntry {
  index: number;
  id: string;
  actor: string;
  at?: number;
  derived?: boolean;
  /** The stored form. Present in a Firestore read, absent from a Ctrl+Shift+L export. */
  payload?: string;
  /** The exported form. Present in a Ctrl+Shift+L export, absent from a Firestore read. */
  msg?: unknown;
}

/** Normalise either shape into what the replay reads.
 *
 *  RE-SERIALIZES ONLY WHEN IT MUST, and says so above. An entry that already carries `payload` is passed
 *  through untouched, so a log read from the room keeps its exact bytes. */
export function entriesFromExport(entries: readonly ExportedEntry[]): ReplayEntry[] {
  return entries.map((entry) => ({
    index: entry.index,
    id: entry.id,
    actor: entry.actor,
    at: entry.at,
    derived: entry.derived,
    payload: entry.payload ?? JSON.stringify(entry.msg ?? null),
  }));
}

/** Everything the reducer cannot compute for itself.
 *
 *  See the file header: this interface is the migration's scope document.
 *
 *  THE TWO CONTEXT BUILDERS ARE WHAT PHASE 1 DELETES. They are handed the state and the chart and return the
 *  injections `App.tsx` assembles inline -- kept as whole objects rather than field-by-field parameters
 *  because the reducer's own context types are the authority on their shape, and a second hand-maintained
 *  copy of that shape here would be #1184's mistake in a new place: a mirror that drifts.
 *
 *  When the chart is part of authoritative state, `marketContext` and `chartInjections` both return nothing
 *  and this interface is `initialGrid` and `layRefused`. That is how Phase 1 knows it is finished. */
export interface ReplayProviders {
  // ---- the board -------------------------------------------------------
  /** The tile grid the room starts from. Accumulates as `LayTile` entries replay. */
  initialGrid: MapGridResponse;
  /** Design note #757: the same refusal the tile grid applies, so the fee and the cursor agree.
   *  Lives in `components/sandboxTileLegality.ts`, so it arrives as a parameter (#273). */
  layRefused: (
    grid: MapGridResponse,
    q: number,
    r: number,
    tileId: number,
    orientation: number,
    era: TileEra,
  ) => boolean;

  // ---- the market chart: PHASE 1 DELETES EVERYTHING BELOW ---------------
  /** The chart the room boots with. */
  initialMarket: SandboxMarketPrices;
  /** The market atom's own context -- sale, rise, blood price and dividend geometry, all of which live in
   *  `components/StockMarketRenderer.tsx`. Rebuilt per entry because `projectDividend` closes over the
   *  declaring corporation's revenue on the state the declaration was made against (#908). */
  marketContext: (
    state: GameStateResponse,
    msg: GameplayExecuteMsg,
    actor: string,
  ) => Omit<SandboxMarketContext, "dividendRefused" | "saleRefused">;
  /** The chart-derived half of the reducer's own context: prices, zones, marks and the rise projection.
   *  #411, #646, #712, #746a, #1177. */
  /** What is LEFT of the chart injections once the positions live on the state: the board's label table,
   *  and the price/zone resolvers the arms other than the queue still read. Each one now derives from
   *  `state.market_positions` rather than from a caller's private copy. */
  chartInjections: (state: GameStateResponse) => Partial<SandboxActionContext>;
  /* ==================================================================
      DESIGN NOTE 1193: THE PAR MARKS, AND WHY THE QUEUE WAS WRONG WITHOUT THEM
     ==================================================================
     `applySandboxMarketAction`'s `BuyStock` arm returns the chart UNTOUCHED and says why -- buying does not
     move a token in 1830. True, and it leaves something unsaid: a corporation being parred for the first
     time needs a token PLACED, which is not a move. `reconcileParMarks` is what does it, and `App.tsx` runs
     it after the action as a separate step.
     THE HARNESS DID NOT, AND IT COST THE WHOLE REPLAY. With no marks, `marketMarkFor` answered `null` for
     every corporation, so `buildOperatingOrder`'s column fell to `-Infinity` and its arrival to `Infinity`
     for all of them -- every tie-break neutralised at once, collapsing the operating order onto the last
     resort, `company_id` ascending. The live game ordered 4, 7, 1; the replay ordered 1 first.
     EVERYTHING ELSE FOLLOWED FROM THAT. `trainPurchaseRefusal` asks `operatingCorporationId`, got the wrong
     corporation, and refused every purchase with "only the operating corporation buys trains" -- while the
     treasuries sat at 920-1000, which is why the funds hypothesis was wrong. No trains, no phase advance,
     one-round sets, a drifting cursor.
     AND IT IS §5a IN MINIATURE. The operating order was decided by chart state the reducer does not own, and
     two parties holding different chart state produced different queues. Here the two parties were a browser
     and this file; in `JUNO-3XD` at indices 310/311 they were two browsers. Same fault, same shape. */
  /** #1193/#415: the par box resolver, handed to the reducer rather than applied here. */
  parCellFor: (parPrice: number) => { x: number; y: number } | null;
}

type TileEra = (typeof ERA_FOR_PHASE_TINT)[keyof typeof ERA_FOR_PHASE_TINT];

function eraFor(state: GameStateResponse | null): TileEra {
  return ERA_FOR_PHASE_TINT[derivePhase(state)?.tint ?? "yellow"];
}

export interface ReplaySeed {
  state: GameStateResponse;
  waterfall: WaterfallStateResponse | null;
}

export interface ReplayResult {
  state: GameStateResponse;
  market: SandboxMarketPrices;
  waterfall: WaterfallStateResponse | null;
  grid: MapGridResponse;
  /** Entries actually applied, after `effectiveActions` removed reverted ones. */
  applied: number;
  /** Entries dropped by a `RevertTo`, plus the reverts themselves. */
  dropped: number;
  /** Payloads that would not parse. Never throws -- `logRevert.ts` and `turnSeed.ts` both take the line that
   *  an entry nobody can parse must not be able to break the game, and a harness that dies on one bad row is
   *  useless for diagnosing the log that contains it. */
  unparseable: number[];
}

/** Replay a log into final state.
 *
 *  ORDER IS THE POINT AND IT MIRRORS `App.tsx` EXACTLY: the tile grid moves first (a lay must be visible to
 *  the legality check of the lay after it, #757), then the auction atom (#261), then the market chart
 *  (#272/#273 -- "advanced BEFORE the game state because the game state needs the price it reports"), then
 *  the reducer. Reordering any pair here reproduces a bug this project has already shipped. */
/** Called before each entry is applied, with the state the reducer is about to see.
 *
 *  ==================================================================
 *   DESIGN NOTE 1191: THE LOG CARRIES ITS OWN ANSWER KEY
 *  ==================================================================
 *
 *  A replay can be wrong in two ways: it can throw, or it can quietly produce a different game. The second
 *  is the one that matters and end-state comparison barely detects it -- a cursor one sub-round off shows up
 *  as a revenue figure being slightly wrong, four hundred entries later, with nothing to say where it began.
 *
 *  BUT SOME MESSAGES RECORD WHAT THE LIVE GAME BELIEVED AT THE MOMENT THEY WERE SENT. `RunMultipleRoutes`
 *  carries `revenue_turn` -- `macro.sub.company`, minted by the dispatching client from ITS state (#1051).
 *  So for every run in a log there is a checkable claim about the cursor, stamped by the game that actually
 *  happened. Comparing it to the replay's own cursor at that instant turns "the numbers came out wrong" into
 *  "they diverged at index 154", which is the difference between a diagnosis and a shrug.
 *
 *  AN OBSERVER RATHER THAN AN ASSERTION, because this module must not decide what a mismatch means. A
 *  divergence might be the harness, a missing arm, or a genuine bug -- `replayLog` reports, the caller
 *  judges. */
export type ReplayObserver = (event: {
  entry: ReplayEntry;
  msg: GameplayExecuteMsg;
  /** The state the reducer is about to be handed -- after the grid and chart moved, before the arm ran. */
  stateBefore: GameStateResponse;
}) => void;


/** One room's live state, advanced an action at a time.
 *
 *  ==================================================================
 *   DESIGN NOTE 1201: THE SERVER APPLIES ONE ACTION; THE HARNESS APPLIES A LOG
 *  ==================================================================
 *
 *  PHASE 2 NEEDS AN INCREMENTAL APPLIER. A server receives one action, appends it and answers; it never has
 *  the whole history in hand the way a replay does. That is a genuinely different shape from `replayLog`,
 *  and the obvious way to get it -- write a second loop that does the same steps -- is the mistake this
 *  project has made three times and paid for three times (#1184, #1193, #1194).
 *
 *  SO `replayLog` IS NOW A LOOP OVER THIS CLASS. Batch and incremental are not two implementations tested
 *  against each other; they are one implementation, and the golden master covers both because the golden
 *  master runs through here. A divergence between "replayed on load" and "applied live" -- which is exactly
 *  the class of bug this migration exists to end -- has no room left to exist.
 *
 *  THE ORDER INSIDE `apply` IS THE ORDER `App.tsx` ESTABLISHED and #272/#273 fixed: the tile grid moves
 *  first (a lay must be visible to the legality check of the lay after it, #757), then the auction atom
 *  (#261), then the board -- which now performs the chart step itself (#1197). Every one of those orderings
 *  was learned from a reported bug.
 *
 *  WHAT IT DOES NOT DO IS DECIDE WHEN TO EMIT. A settle point is the end of a burst -- a player action plus
 *  the derived consequences that follow it -- and the server cannot know a burst has ended until it
 *  GENERATES those consequences itself. That logic (`autoSkipReason` and the forced withhold) is still in
 *  the shell, reading route reachability and station legality memos, and moving it is its own piece of work.
 *  Until then this class reports what it applied and lets the transport decide what to send. Inventing a
 *  settle rule that cannot yet be implemented correctly would be worse than not having one. */
export class RoomEngine {
  private state: GameStateResponse;
  private waterfall: WaterfallStateResponse | null;
  private grid: MapGridResponse;
  private readonly providers: ReplayProviders;
  /** Indices whose payload would not parse. Never thrown: `turnSeed.ts` and `logRevert.ts` both take the
   *  line that an entry nobody can parse must not be able to break the game, and a server that died on one
   *  bad row would be worse than a client that ignored it. */
  private readonly unparseable: number[] = [];

  constructor(providers: ReplayProviders, seed: ReplaySeed) {
    this.providers = providers;
    /* #1197: the chart is seeded onto the state ONCE and the reducer carries it from there. */
    this.state = { ...seed.state, market_positions: providers.initialMarket };
    this.waterfall = seed.waterfall;
    this.grid = providers.initialGrid;
  }

  /** Apply one entry. Returns nothing: the board is the answer, and it is read from `snapshot`. */
  apply(entry: ReplayEntry, observe?: ReplayObserver): void {
  let msg: GameplayExecuteMsg;
  try {
    msg = JSON.parse(entry.payload) as GameplayExecuteMsg;
  } catch {
    this.unparseable.push(entry.index);
    return;
  }

  /* ==================================================================
      DESIGN NOTE 1189: THE SHIM THAT WAS HERE IS NOW A REDUCER ARM
     ==================================================================
     THIS FILE BRIEFLY REIMPLEMENTED `SetupGame`, because the reducer had no arm for it and a replay that
     never deals the game reaches nothing. The shim is gone: `applyOneAction` now owns `SetupGame` and
     `OpenStockRound`, so this loop hands every message to one authority and reimplements none of them.
     THAT WAS THE WHOLE POINT OF THE HARNESS. A shim here would have made the replay work and left the
     reducer exactly as unable to drive a game as it was -- which is the failure the migration is trying to
     avoid, one layer earlier. Anything this file has to special-case is a gap in the reducer, and belongs
     there instead. Seven of the ten `isSandboxOnlyMsg` messages are still outstanding. */

  /* SNAPSHOTTED TOGETHER, per #766's "a snapshot, not a reorder": both halves of the legality predicate
     must judge the same instant. `App.tsx` learned this the hard way -- it gave the GRID a ref and left
     the PHASE reading this.state, so one rule was asked of one of its two inputs. */
  const gridBefore = this.grid;
  const eraBefore = eraFor(this.state);

  if ("LayTile" in msg) {
    const lay = msg.LayTile;
    this.grid = applySandboxLayTile(
      gridBefore,
      lay.q,
      lay.r,
      lay.tile_id,
      lay.orientation,
      (q: number, r: number, tileId: number, orientation: number) =>
        this.providers.layRefused(gridBefore, q, r, tileId, orientation, eraBefore),
    );
  }

  /* ==================================================================
      DESIGN NOTE 1192a: THE AUCTION HAS TO BE TOLD IT IS OVER
     ==================================================================
     CAUGHT BY #1192 MAKING THINGS WORSE. Wiring the charges dropped the board from four trains to one,
     which is the opposite of the intended effect and therefore the useful kind of failure.
     BECAUSE THE ATOM NEVER CLOSED. `App.tsx`'s `OpenStockRound` handler flips `waterfall_auction_active`
     to false; the reducer arm #1189 moved does not, because the auction is a separate atom the reducer
     must not reach into. So this loop kept handing every later message to a still-live auction, and every
     one that looked like a bid charged somebody again -- draining the players who should have been buying
     shares, which is why capitalisation got worse rather than better.
     CLOSED HERE, IN THE COMPOSITION LAYER, for #1192's reason exactly: the board's arm and the atom's
     close are two halves of one event, and this file is the only place that holds both. */
  if (this.waterfall && isOpenStockRoundMsg(msg) && this.waterfall.waterfall_auction_active) {
    this.waterfall = { ...this.waterfall, waterfall_auction_active: false };
  }

  if (this.waterfall) {
    /* ==================================================================
        DESIGN NOTE 1192: THE AUCTION'S MONEY, AND WHY IT LIVES HERE
       ==================================================================
       `applySandboxWaterfallAction` RETURNS the cash it implies rather than reaching into wallets (#261),
       because the auction is its own atom and the wallets are on the board. Somebody has to compose the
       two, and until now that somebody was only ever `App.tsx`.
       THIS IS NOT A SHIM, UNLIKE THE ONE #1189 REMOVED. `SetupGame` was a gap in the reducer and belonged
       in the reducer. This is a CROSS-ATOM COMPOSITION, and this file is the composition layer -- it
       already sequences the this.grid, the chart, the auction and the board. The server will do exactly this,
       in exactly this order, for the same reason.
       AND ITS ABSENCE WAS THE PHASE 2 LOCK. Unapplied charges left every player holding their full opening
       cash through the auction, so the board's money was wrong from index 1 -- and #1189's replay froze at
       phase 2 with four trains because corporate treasuries, fed by share purchases at par, never grew
       enough to buy past the 2-trains. */
    const result = applySandboxWaterfallAction(this.waterfall, msg, this.state.player_addresses ?? []);
    this.waterfall = result.waterfall;

    /* #334a: a LIST, and not all of them the actor's -- an auto-awarded private is charged to its lone
       bidder, who may not be the player who just moved. */
    for (const { player, amount } of result.charges) {
      this.state = {
        ...this.state,
        player_cash: this.state.player_cash.map((entry) =>
          entry.player === player
            ? { ...entry, cash_vgp: String(Math.max(0, (Number(entry.cash_vgp) || 0) - amount)) }
            : entry,
        ),
      };
    }

    /* #303: the reducer REPORTS a win; the owner is written where both atoms are in hand. A list, because
       one purchase can cascade (#334). */
    for (const { privateId, player } of result.won) {
      this.state = {
        ...this.state,
        private_companies: this.state.private_companies.map((entry) =>
          entry.private_id === privateId ? { ...entry, owner: player } : entry,
        ),
      };

      /* #576: a CONSEQUENCE is derived by every client, never appended by each of them -- appending inside
         a replay is how one win issued two certificates. The C&A's free PRR share is that consequence, and
         the private survives: closing it would cost its owner $25 an Operating Round for the rest of the
         game. */
      if (privateId === CA_PRIVATE_ID) {
        const prr = this.state.public_companies.find((c) => c.ticker === CA_BONUS_TICKER);
        if (prr) {
          this.state = applyPrivateExchange(this.state, {
            ok: true,
            privateId,
            companyId: prr.company_id,
            ticker: CA_BONUS_TICKER,
            player,
            source: prr.ipo_pool_percentage >= 10 ? "Ipo" : "Bank",
            keepOpen: true,
          });
        }
      }
    }
  }

  /* ==================================================================
      DESIGN NOTE 1197: THE TWO-ATOM DANCE IS NOT THIS FILE'S JOB ANY MORE
     ==================================================================
     THIS LOOP USED TO DO WHAT `App.tsx` DOES -- advance the chart, publish it onto the this.state, then call
     the reducer -- and getting that sequence right was worth two separate bugs (#1193's missing
     `reconcileParMarks`, #1194's hand-written `marketContext`), each of which silently rearranged the
     operating order.
     THE REDUCER OWNS IT NOW. `applySandboxAction` sees `market_positions` on the this.state and performs the
     whole sequence itself, in the order #272/#273 fixed long ago. What is left here is the GEOMETRY,
     handed in once, and the ordering can no longer be got wrong by a caller because there is no ordering
     left for a caller to get wrong.
     WHICH IS THE POINT OF PHASE 1, VISIBLE IN A DIFF. */

  /* ==================================================================
      DESIGN NOTE 1208: A REBUILD MUST REMEMBER WHAT THE GAME ALREADY SENT
     ==================================================================
     FOUND BY ASKING WHAT HAPPENS WHEN A SERVER DIES MID-BURST, and it is a real bug rather than a
     hypothetical. `submit` records each derived action's key in `emitted` so the game does not owe it twice.
     `apply` did not -- so a server that restarted and rebuilt from the log came back with an EMPTY set,
     looked at a turn whose auto-skip was already in the history, and owed it again. One crash, one duplicate
     forced withhold, and #774's two-cells-rather-than-one arriving from a completely new direction.
     THE LOG ALREADY CARRIES THE ANSWER. A derived entry is marked `derived`, and `turnGuardKey` is built
     from the round, the sub-round and the corporation index -- all on the state this entry is about to be
     applied to. So the key is recomputable from the history, and the guard survives a restart with nothing
     persisted beside it. #1145 keyed it that way for a different reason; this is the first thing to need it.
     COMPUTED BEFORE THE ARM RUNS, against the board the game was looking at when it decided -- the same
     instant `nextDerivedAction` used. Afterwards the cursor has moved and the key names a different turn. */
  if (entry.derived) {
    const owed = operatingCorporationId(this.state);
    const step = this.state.operating_sub_phase;
    if (owed !== null && step !== undefined) {
      this.emitted.add(turnGuardKey(this.state, owed, step));
    }
  }

  /* #1191: observed HERE -- after the this.grid and the chart have moved, before the arm runs -- because that
     is precisely the this.state the reducer is judged on. Observing earlier would report a board the reducer
     never saw. */
  observe?.({ entry, msg, stateBefore: this.state });

  this.state = applySandboxAction(this.state, msg, {
    ...this.providers.chartInjections(this.state),
    // #549: the log's author. The one injection that was ALREADY log-derived.
    actor: entry.actor,
    mapGrid: this.grid,
    era: eraFor(this.state),
    /* #1197: the ladder's shape, handed in once. `sharePrice` is gone from here -- the reducer prices the
       trade itself now, so the wallet and the chart cannot be handed two different figures. */
    marketContext: this.providers.marketContext(this.state, msg, entry.actor),
    parCellFor: this.providers.parCellFor,
    /* #579/#398: the par comes from the MESSAGE's own `protocol_id` and `par_value`, never from an ambient
       ladder selection -- there is no ambient anything in a replay, which is the point. */
    parValue: (() => {
      if (!("BuyStock" in msg)) return undefined;
      const fromMsg = Number(msg.BuyStock.par_value ?? NaN);
      return Number.isFinite(fromMsg) && fromMsg > 0 ? fromMsg : undefined;
    })(),
    // #757: the same refusal the this.grid applied, judged on the same snapshot.
    layRefused: (q: number, r: number, tileId: number, orientation: number) =>
      this.providers.layRefused(gridBefore, q, r, tileId, orientation, eraBefore),
  });

  /* #1193: AFTER the action, because a par is set BY an action -- a corporation parred by this `BuyStock`
     has no mark until the board says it is parred. Idempotent by construction (`placeParMark` no-ops on a
     company that already has one), so running it every entry costs a walk and cannot disturb a token that
     has since moved. */
  }

  /* ==================================================================
      DESIGN NOTE 1203: REPLAY APPLIES DERIVED ACTIONS; LIVE PLAY GENERATES THEM
     ==================================================================
     THE DISTINCTION THE SETTLE POINT RESTS ON, and getting it backwards would double every automatic action
     in the game. A recorded log ALREADY HOLDS its derived entries -- `JUNO-3XD` carries thirty-five of them,
     `derived: true`, appended by whichever client was acting. Replaying that log must APPLY them and
     generate nothing. A live room has no such entries yet, so the server must GENERATE them and append.
     SO `apply` IS FOR HISTORY AND `submit` IS FOR PLAY. Two entry points, one engine; a replay that
     generated would double-apply, and a live room that only applied would stall on the first step nobody can
     act on.
     AND THIS IS WHERE A SETTLE POINT FINALLY BECOMES DEFINABLE. A burst is a player's action plus everything
     the game owes in consequence, and it is over when `nextDerivedAction` returns `null`. That is not a
     heuristic or a debounce -- it is the same question the shell asks, answered until it stops saying yes.
     THE IDEMPOTENCY IS #774's SURVIVING HALF. The shell needed `isMyTurn` because every seated browser
     reached the same conclusion and each appended its own copy; one writer cannot race itself, so that guard
     is gone. What remains is `emitted`, and it exists for the other case: a server restarted mid-turn, or
     rebuilt from a log, must not re-send what the log already holds. `turnGuardKey` is built from the round,
     the sub-round and the corporation index, so a rebuild reproduces the same keys for free (#1145). */
  private readonly emitted = new Set<string>();

  /** Live play: apply a player's action, then everything the game owes in consequence.
   *
   *  `mint` BELONGS TO THE CALLER because index and id allocation is the log store's business, not the
   *  engine's -- `sandboxRoom.ts` allocates inside a Firestore transaction (#1026) and the engine has no
   *  opinion about that. Returning the minted entries rather than appending them keeps this class free of
   *  persistence, which is what lets one instance serve a test, a CLI and a server. */
  submit(
    entry: ReplayEntry,
    mint: (msg: GameplayExecuteMsg, reason: string) => ReplayEntry,
    options?: { mapGrid?: MapGridResponse; extraStationAvailable?: boolean },
  ): { derived: ReplayEntry[]; state: GameStateResponse } {
    this.apply(entry);
    return { derived: this.settleOwed(mint, options), state: this.state };
  }

  /** Generate and apply everything the game owes RIGHT NOW, without a player action first.
   *
   *  SPLIT OUT OF `submit` FOR THE CRASH CASE (#1209). A server that died between appending a move and
   *  appending the auto-skip it owed comes back with the first fact in the log and the second missing. There
   *  is no player action to attach the repair to -- the board simply owes something, and that is exactly the
   *  question `nextDerivedAction` answers. Calling `submit` with a synthetic action would put a move in the
   *  history that nobody made. */
  settleOwed(
    mint: (msg: GameplayExecuteMsg, reason: string) => ReplayEntry,
    options?: { mapGrid?: MapGridResponse; extraStationAvailable?: boolean },
  ): ReplayEntry[] {
    const derived: ReplayEntry[] = [];
    /* A CAP, AND IT IS NOT DEFENSIVE PROGRAMMING. Each answer is computed against the board the previous one
       produced, so a rule that failed to advance the cursor would spin forever and take the room with it --
       the shape #876 describes, where a skip fired against the last step and moved nothing. The guard set
       makes that terminate anyway; this is the second lock, and it is cheap. */
    for (let guard = 0; guard < 32; guard += 1) {
      const next = nextDerivedAction({
        state: this.state,
        mapGrid: options?.mapGrid ?? this.grid,
        emitted: this.emitted,
        extraStationAvailable: options?.extraStationAvailable,
      });
      if (!next) break;
      this.emitted.add(next.key);
      const minted = mint(next.msg, next.reason);
      this.apply(minted);
      derived.push(minted);
    }

    // The burst is over. THIS is the settle point, and the caller emits here and nowhere else.
    return derived;
  }

  get snapshot(): {
    state: GameStateResponse;
    waterfall: WaterfallStateResponse | null;
    grid: MapGridResponse;
    unparseable: number[];
  } {
    return {
      state: this.state,
      waterfall: this.waterfall,
      grid: this.grid,
      unparseable: [...this.unparseable],
    };
  }
}

export function replayLog(
  entries: readonly ReplayEntry[],
  providers: ReplayProviders,
  seed: ReplaySeed,
  observe?: ReplayObserver,
): ReplayResult {
  /* `RevertTo` IS AN INSTRUCTION ABOUT THE LOG, NOT A GAME ACTION (#1026), so it is resolved before the
     reducer ever sees the history. `effectiveActions` also drops reverts that were themselves reverted.
     THAT IS WHY THIS STAYS A FUNCTION AND NOT A METHOD: resolving reverts needs the WHOLE log, which a
     server appending one action at a time does not have. A room rebuilds through here; a room in play
     advances through `RoomEngine.apply`. */
  const ordered = [...entries].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  const live = effectiveActions(ordered);

  const engine = new RoomEngine(providers, seed);
  for (const entry of live) engine.apply(entry, observe);

  const { state, waterfall, grid, unparseable } = engine.snapshot;
  return {
    state,
    market: state.market_positions ?? providers.initialMarket,
    waterfall,
    grid,
    applied: live.length,
    dropped: ordered.length - live.length,
    unparseable,
  };
}

