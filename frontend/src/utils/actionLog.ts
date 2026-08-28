// frontend/src/utils/actionLog.ts
//
// Turns a dispatched ExecuteMsg into a line a player can read.
//
// The label is DERIVED from the message and the state it acted on, never passed
// in: hand-written labels at each call site named the contract's variants, leaked
// the backend, and never said WHO acted -- which made the log a list of verbs.
//
// `gameState` is the BEFORE state, the only one every caller has at dispatch
// time; `afterState` is the resolved one where a synchronous reducer offers it.
// Each figure takes the side it belongs to -- see #2.
//
// See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #0, #1

import type { GameStateResponse } from "./gameState";
import { dividendSplit } from "./dividendSplit";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import { boardHexLabel } from "../components/hexGeometry";
import {
  OPERATING_SUB_PHASE_LABELS,
  type OperatingSubPhase,
} from "../components/OperatingSubPhaseStepper";
import { depotInventory } from "./gamePhase";
import { hasActedThisTurn } from "./turnAction";
import { sandboxRouteBreakdown } from "./sandboxSession";
import { stationTokenPrice } from "./stationTokens";

export interface ActionLogContext {
  /** The board and room as they stand BEFORE this action -- design note #1. */
  gameState: GameStateResponse | null;
  /* AFTER for where things stand now (depot stock, a balance); BEFORE for facts about the action (what it cost, who acted). undefined on a live chain, where the before-derived phrasing stands.
     See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #2 */
  afterState?: GameStateResponse | null;
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** Renders a wallet as a readable name. */
  labelForAddress: (address: string) => string;
  /** Current market price by `company_id`, for the dividend line's
   *  before/after. `undefined` when the chart is not available, and the line
   *  then omits the price move rather than inventing one. */
  marketPrices?: Readonly<Record<number, number | undefined>>;
  /* `projectPrice` REMOVED by design note #775, and #434's warning is why it is worth recording rather than
     just deleting. That note fixed this callback to step from the CELL because a price-keyed search "quoted a
     destination the token never reached" -- the right fix to the wrong question. The sentence should not have
     been projecting a destination at all: `Market Move` reports the one the atom actually reached. A
     projection is the correct tool for a PREVIEW, where the player has not yet chosen; it is never the
     correct tool for a record of something that already happened. */
  /* An OR is corporation-driven, so the line names the CORPORATION and the step it declined. The step is not on GameStateResponse, so it is passed in and stays optional.
     See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
  orSubPhase?: OperatingSubPhase | null;
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six"] as const;

/** "two 3-trains", "one 3-train". Small counts read better as words in a
 *  sentence, and every count this log reports is small by construction --
 *  the depot never holds more than six of a tier. */
export function countPhrase(count: number, singular: string): string {
  const word = count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
  return `${word} ${singular}${count === 1 ? "" : "s"}`;
}

/** A corporation's ticker, or a readable stand-in. Never a bare id: "#4 laid
 *  a tile" is the same failure as naming the message. */
function corp(state: GameStateResponse | null, companyId: number): string {
  return (
    state?.public_companies.find((entry) => entry.company_id === companyId)?.ticker ??
    `Corporation #${companyId}`
  );
}

/** Whoever the room says is acting right now -- the actor for every
 *  player-driven message, none of which carry an address of their own. */
function actingPlayer(context: ActionLogContext): string {
  const state = context.gameState;
  const address = state?.player_addresses[state.active_player_index];
  return address ? context.labelForAddress(address) : "A player";
}

/** Whoever is acting, as the round defines it. Exported because App.tsx needs the same answer when recording what an Undo would revert.
 *  See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
export function actingActor(context: ActionLogContext): string {
  const state = context.gameState;
  if (state?.current_round_type === "OperatingRound") {
    const companyId = state.active_operating_order[state.active_corporation_index];
    if (companyId !== undefined) return corp(state, companyId);
  }
  return actingPlayer(context);
}

/** The verb-led name of the step the cursor is on -- "Lay Track", not
 *  "Track". Design note #478: the strip's own `stepLabel`, so the log and
 *  the stepper cannot describe the same step differently. */
function stepName(context: ActionLogContext): string | null {
  const step = context.orSubPhase;
  return step ? OPERATING_SUB_PHASE_LABELS[step].stepLabel : null;
}

/** " Treasury now $X." for a corporation that just spent, or "" when the
 *  resolved state is not available (a live chain -- design note #2). */
function treasurySuffix(context: ActionLogContext, companyId: number): string {
  const treasury = context.afterState?.public_companies.find(
    (entry) => entry.company_id === companyId,
  )?.treasury;
  return treasury === undefined ? "" : ` Treasury now $${treasury}.`;
}

function hexName(mapGrid: MapGridResponse, q: number, r: number): string {
  void mapGrid;
  return boardHexLabel(q, r) ?? `(${q}, ${r})`;
}

/** null rather than a generic fallback: the caller keeps its own label, and a sentence saying less than the variant name is a downgrade dressed as an improvement.
 *  See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #0 */
export function describeGameplayAction(
  msg: GameplayExecuteMsg,
  context: ActionLogContext,
): string | null {
  const { gameState, mapGrid, era } = context;

  /* ---- Operating Round: the corporation acts. ---- */

  if ("LayTile" in msg) {
    const { protocol_id, tile_id, q, r } = msg.LayTile;
    return (
      `${corp(gameState, protocol_id)} laid Tile #${tile_id} on ${hexName(mapGrid, q, r)}.` +
      treasurySuffix(context, protocol_id)
    );
  }

  if ("PlaceStationToken" in msg) {
    const { protocol_id, q, r } = msg.PlaceStationToken;
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === protocol_id,
    );
    // Design note #1: priced from the BEFORE state, so this is what the
    // token about to be placed costs -- not what the next one will.
    const cost = stationTokenPrice(company?.station_token_hexes.length ?? 0);
    return (
      `${corp(gameState, protocol_id)} placed a station on ${hexName(mapGrid, q, r)} for $${cost}.` +
      treasurySuffix(context, protocol_id)
    );
  }

  if ("RunManualRoute" in msg) {
    const { protocol_id, path } = msg.RunManualRoute;
    const breakdown = sandboxRouteBreakdown(mapGrid, path, era);
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === protocol_id,
    );
    // The biggest train it owns is the one a route is run with -- the same
    // derivation the route builder defaults to.
    const train = (company?.owned_trains ?? []).slice().sort().pop();
    const stops = path
      .map((stop) => stop.hex)
      .filter((hex, index, all) => all.indexOf(hex) === index);

    /* ==================================================================
     *  DESIGN NOTE 941: THIS LINE NAMES THE TRACK; THE TURN'S LINE NAMES THE MONEY
     * ==================================================================
     *
     * #939 PUT THE VARIANT'S THREE SENTENCES HERE, and that was right while the die was rolled per route.
     * The die is now rolled once per TURN (#941), so a four-train corporation would have printed four bonus
     * sentences about one roll -- the reported complaint in a second currency.
     * SO THIS ARM GOES BACK TO BEING FACTUAL and says the only thing it is uniquely placed to say: which
     * track this train ran, and what that track prints. `turnRevenueSentence` carries the modifier, once,
     * from the shell -- which is the only place that can see the end of the dispatch loop.
     * THE FIGURE IS THE PRINTED ONE, deliberately, and it is not a return to #935's bug. That note found the
     * log quoting a printed figure while the reducer banked a modified one FOR THE SAME QUANTITY. These are
     * two different quantities now: this sentence is about one route, the turn's sentence is about the sum.
     * A route's printed value is a fact about the board and is not modified by anything. */
    return (
      `${corp(gameState, protocol_id)} ran a $${breakdown.revenue} route` +
      (train ? ` with a ${train}-train` : "") +
      ` through ${stops.join(" -> ")}.`
    );
  }

  if ("DeclareDividends" in msg) {
    const { protocol_id, revenue_amount, distribute } = msg.DeclareDividends;
    const ticker = corp(gameState, protocol_id);

    /* ==================================================================
     *  DESIGN NOTE 775: THIS SENTENCE REPORTS; IT NO LONGER RECOMPUTES
     * ==================================================================
     *
     * THE PRICE CLAUSE IS GONE, and it was the reported bug. It read the corporation's CURRENT price and
     * then projected a dividend step from it -- but by the time this line is built the market atom has
     * already made that step, so the sentence quoted the destination of a SECOND move that never happened.
     * The log showed it exactly: `Market Move — C&O fell from $82 to $76` beside `C&O withheld $0 ... Share
     * price moved from $76 to $71`. $76 is where the token had just landed.
     *
     * ONE QUESTION, ONE ANSWER, AND `Market Move` IS IT. #435 built that line from
     * `applySandboxMarketAction`'s own `moved` result -- the authority's report of what it did, not a second
     * opinion about what it should do -- and it is the line that came out right in every log. Confirmed by
     * the report: "The Market Move log is the correct movement for the corporation's share price."
     *
     * WHAT IS LOST, STATED PLAINLY: the "Share price held at $X" case, for a token already at the edge of
     * the chart. `Market Move` is silent when nothing moves, so a clamped step now goes unremarked. That is
     * a rare, visible-on-the-chart situation, and it is a much smaller cost than a sentence that regularly
     * names a price the token never reached.
     *
     * THE SPLIT COMES FROM `dividendSplit` for the same reason: the payout toast was reporting double what
     * was actually paid, because this branch re-derived the revenue and re-split it from its own snapshot
     * while the reducer split it from the state the action applied to. Now both read one calculation. */
    const settlement = dividendSplit(gameState, protocol_id, revenue_amount, distribute);
    const revenue = settlement?.revenue ?? 0;

    if (!distribute) {
      return `${ticker} withheld $${revenue} into its treasury.`;
    }

    /* Sorted for READING only -- largest holding first. The amounts are the reducer's own, so the order
       here cannot change what anybody is paid. */
    const split = [...(settlement?.players ?? [])]
      .sort((a, b) => b.amount - a.amount)
      .map((share) => `$${share.amount} to ${context.labelForAddress(share.player)}`);
    return (
      `${ticker} paid dividends on $${revenue}` +
      (split.length > 0 ? `: ${split.join(", ")}.` : " — no shareholders on record.")
    );
  }

  if ("BuyHardwareFromPool" in msg || "EmergencyBuyHardware" in msg) {
    const protocolId =
      "BuyHardwareFromPool" in msg
        ? msg.BuyHardwareFromPool.protocol_id
        : msg.EmergencyBuyHardware.protocol_id;
    // The depot sells cheapest-first, so the tier bought is the first row
    // with stock BEFORE the purchase -- the same `find` the panel makes.
    const tier = depotInventory(gameState).find(
      (row) => row.remaining === null || row.remaining > 0,
    );
    if (!tier) return `${corp(gameState, protocolId)} tried to buy a train from an empty depot.`;

    /* Supply is an after-figure and price is a before-figure, in one sentence. Reading the resolved state means the log cannot disagree with the depot panel.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #2 */
    const settled = context.afterState
      ? depotInventory(context.afterState).find((row) => row.tier === tier.tier)
      : undefined;
    const left = settled ? settled.remaining : Math.max(0, (tier.remaining ?? 1) - 1);
    const remaining = left === null ? "unlimited" : `${left}/${tier.total}`;
    const treasury = context.afterState?.public_companies.find(
      (entry) => entry.company_id === protocolId,
    )?.treasury;
    return (
      `${corp(gameState, protocolId)} bought a ${tier.tier}-train for $${tier.cost}. ` +
      `Remaining depot supply: ${remaining}.` +
      (treasury !== undefined ? ` Treasury now $${treasury}.` : "")
    );
  }

  if ("BuyTrainFromCorporation" in msg) {
    const { buyer_protocol_id, seller_protocol_id, model_type, price } =
      msg.BuyTrainFromCorporation;
    return (
      `${corp(gameState, buyer_protocol_id)} offered $${price} to ` +
      `${corp(gameState, seller_protocol_id)} for a ${model_type}-train.`
    );
  }

  if ("AcceptTrainOffer" in msg) return `${actingPlayer(context)} accepted a train offer.`;
  if ("RejectTrainOffer" in msg) return `${actingPlayer(context)} rejected a train offer.`;
  if ("RescindTrainOffer" in msg) return `${actingPlayer(context)} withdrew a train offer.`;

  /* Privates are named "3. Delaware & Hudson" -- players refer to them by waterfall order as much as by name. One helper, so the log cannot develop two formats.
     See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #361 */
  const namePrivate = (privateId: number): string => {
    const entry = context.gameState?.private_companies.find(
      (row) => row.private_id === privateId,
    );
    return entry ? `${entry.private_id}. ${entry.name}` : `private #${privateId}`;
  };

  if ("BuyPrivateCompany" in msg) {
    const { protocol_id, private_id, price } = msg.BuyPrivateCompany;
    const target = gameState?.private_companies.find(
      (entry) => entry.private_id === private_id,
    );
    const seller = target?.owner ? context.labelForAddress(target.owner) : "its owner";
    return (
      `${corp(gameState, protocol_id)} bought ${namePrivate(private_id)} ` +
      `from ${seller} for $${price}.`
    );
  }

  if ("AdvanceOperatingSubPhase" in msg) {
    /* The one message whose whole content IS which step, and the step was the only part left out. The cursor has not moved at dispatch time.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
    const ticker = corp(gameState, msg.AdvanceOperatingSubPhase.protocol_id);
    const step = stepName(context);
    return step ? `${ticker} passed ${step}.` : `${ticker} skipped a step.`;
  }

  /* ---- Stock Round and the auction: the player acts. ---- */

  if ("BuyStock" in msg) {
    /* The price is the one figure a reader cannot reconstruct afterwards. From the message first (par_value travels in the purchase), then the chart. SILENT when unknown -- an invented figure is worse than an omission.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #554 */
    const { protocol_id, source, par_value: parValue } = msg.BuyStock;
    const fromIpo = source === "Ipo";
    const priced = Number(parValue);
    const price =
      fromIpo && Number.isFinite(priced) && priced > 0
        ? priced
        : context.marketPrices?.[protocol_id];
    /* ==================================================================
       DESIGN NOTE 770: THE OPENING PURCHASE IS NOT A 10% SHARE
       ==================================================================
       REPORTED: "When a player first buys a share in a company in the Stock Round, the Activity Log reads:
       'Player bought a 10% share of C&O from the IPO for $100.' This should state that Player bought the 20%
       President's share from the IPO and set par at $x."
       THE LINE WAS WRONG ON ALL THREE COUNTS. The first purchase of an unopened corporation is the President's
       Certificate: 20%, not 10%; bought at TWICE par, so $200 rather than $100 at a par of $100; and it is the
       act that SETS the par, which is the single most consequential decision in a Stock Round and was not
       being recorded at all. A player scrolling back to ask "what did C&O par at" found a line that did not
       say.
       THE OPENING PURCHASE IS IDENTIFIED THE WAY THE REDUCER IDENTIFIES IT -- an untouched IPO and no
       president yet (`trading.rs`: "the first purchase of an unopened corporation is the 20% card at exactly
       twice par"). Read off the state BEFORE the action, which is what `gameState` is here (#1). */
    const target = gameState?.public_companies.find((entry) => entry.company_id === protocol_id);
    const opening =
      fromIpo &&
      !!target &&
      target.president === null &&
      (target.par_value === null || target.par_value === undefined);

    if (opening) {
      const par = Number.isFinite(priced) && priced > 0 ? priced : null;
      /* SILENT ON AN UNKNOWN PAR rather than inventing one -- #554's rule, and the par is precisely the figure
         a reader cannot reconstruct afterwards. */
      const parPhrase = par === null ? "" : `, setting par at $${par}`;
      const paid = par === null ? "" : ` for $${par * 2}`;
      return (
        `${actingPlayer(context)} bought the 20% President's Certificate of ` +
        `${corp(gameState, protocol_id)} from the IPO${paid}${parPhrase}.`
      );
    }

    const cost = typeof price === "number" && price > 0 ? ` for $${price}` : "";
    return (
      `${actingPlayer(context)} bought a 10% share of ${corp(gameState, protocol_id)} ` +
      `from the ${fromIpo ? "IPO" : "bank pool"}${cost}.`
    );
  }

  if ("SellStock" in msg) {
    const { protocol_id, percentage } = msg.SellStock;
    return `${actingPlayer(context)} sold ${percentage}% of ${corp(gameState, protocol_id)}.`;
  }

  if ("WaterfallBuyLowest" in msg) {
    return `${actingPlayer(context)} bought the cheapest private company at face value.`;
  }

  if ("WaterfallBidHigher" in msg) {
    const { private_id, bid_amount } = msg.WaterfallBidHigher;
    /* "private #3" is the contract's identifier and means nothing at the table; the lookup lives in namePrivate so both arms format identically.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #361 */
    return `${actingPlayer(context)} bid $${bid_amount} on ${namePrivate(private_id)}.`;
  }

  if ("WaterfallMiniAuctionRaise" in msg) {
    return `${actingPlayer(context)} raised to $${msg.WaterfallMiniAuctionRaise.bid_amount}.`;
  }

  if ("WaterfallMiniAuctionPass" in msg) {
    return `${actingPlayer(context)} passed in the mini-auction.`;
  }

  if ("WaterfallPass" in msg) return `${actingPlayer(context)} passed.`;
  if ("BidOnPrivate" in msg) {
    return `${actingPlayer(context)} bid $${msg.BidOnPrivate.bid_amount} on a private company.`;
  }

  if ("PassTurn" in msg) {
    /* In an OR, Pass ends the CORPORATION's turn from a step; outside one it really is a seated player passing and the original wording is right.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #478 */
    if (gameState?.current_round_type === "OperatingRound") {
      const step = stepName(context);
      return step
        ? `${actingActor(context)} passed ${step}.`
        : `${actingActor(context)} passed its turn.`;
    }
    /* Design note #745: a turn the player already acted in is ENDED, not passed, and the log must say so --
       it is the record players scroll back through to work out why a round closed when it did. The state
       here is the one BEFORE the message applies, which is exactly when the flag is still set. */
    return hasActedThisTurn(gameState ?? {})
      ? `${actingPlayer(context)} ended the turn.`
      : `${actingPlayer(context)} passed the turn.`;
  }
  if ("UndoLastAction" in msg) {
    /* Online the client does not know what it undid -- a live chain resolves undo a block or two later, so naming an action would be a guess printed as a fact.
       See docs/ai_architecture/ui_shell_layout.md - actionLog.ts #479 */
    return `${actingActor(context)} reverted their last action.`;
  }
  if ("BeginOperatingRound" in msg) return "The Operating Round began.";

  // `ExecuteOperatingRound` and anything added later: the caller's own label
  // stands. Design note #0 -- a vaguer sentence than the variant name would
  // be a downgrade.
  return null;
}
