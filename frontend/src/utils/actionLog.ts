// frontend/src/utils/actionLog.ts
//
// Turns a dispatched `ExecuteMsg` into a line a player can read.
//
// ===================================================================
//  DESIGN NOTE 0: THE LOG WAS WRITTEN FOR THE PERSON WHO WROTE IT
// ===================================================================
//
// Every entry in the Activity Log was the contract's own variant name, hand
// typed at the call site: "RunManualRoute", "BuyHardwareFromPool (mock)",
// "DeclareDividends: Pay (mock)". Three problems, and the third is the one
// that makes the log useless rather than merely ugly.
//
//   IT NAMED A MESSAGE, NOT AN EVENT. "BuyStock" is what the client sent.
//   What happened is that somebody bought a share of something.
//
//   IT LEAKED THE BACKEND. A player has no idea what `BuyHardwareFromPool`
//   is, and the "(mock)" suffixes were notes to a developer about wiring
//   that has since been finished -- stale as well as internal.
//
//   IT NEVER SAID WHO. This is the fatal one. In a four-player hotseat with
//   eight corporations, a log of twenty entries that names no actor is not a
//   history of the game; it is a list of verbs. "Who bought that train?" was
//   unanswerable from the one surface built to answer it.
//
// So the label is DERIVED from the message and the state it acted on, rather
// than being passed in. That choice is deliberate: a hand-written label at
// each call site is a second thing to keep in step with the message, and it
// was already drifting (the "(mock)" suffixes outlived their mocks).
// `runGameplayAction` describes what it is about to send, so a new dispatch
// site gets a readable line for free and cannot forget to write one.
//
// ===================================================================
//  DESIGN NOTE 1: THE BEFORE STATE IS ALWAYS THERE
// ===================================================================
//
// `gameState` is the state BEFORE the action applies. That is the only state
// every caller is guaranteed to have at dispatch time -- the reducer has not
// run yet, and on a live chain the result will not be known for a block or
// two. So it is the required argument, and every line can be written from it
// alone.
//
// This note originally went on to claim the before-state was also the more
// useful one to REPORT: that "depot 2/5 remaining" reads as a purchase
// against the supply it came out of, and that "1/5" answered a question
// nobody asked. That was wrong, and QA caught it. A player clicking Buy
// watches the log to find out what the depot holds NOW -- and 2/5 does not
// merely answer a different question, it contradicts the depot panel sitting
// next to it, which has already redrawn to 1/5. See design note #2 for the
// distinction that actually holds.
//
// Where a figure only exists after the fact -- the exact per-player dividend
// split, say -- it is computed here from the before-state rather than
// waited for, because the arithmetic is fully determined by what is already
// known.

import type { GameStateResponse } from "./gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { TileColorTier } from "../components/hexTileCatalog";
import { boardHexLabel } from "../components/hexGeometry";
import { depotInventory } from "./gamePhase";
import { sandboxRouteBreakdown } from "./sandboxSession";
import { stationTokenPrice } from "./stationTokens";

export interface ActionLogContext {
  /** The board and room as they stand BEFORE this action -- design note #1. */
  gameState: GameStateResponse | null;
  /* ==================================================================
   *  DESIGN NOTE 2: THE RESOLVED STATE, WHEN THERE IS ONE
   * ==================================================================
   *
   * Design note #1 argued for describing the BEFORE state because it is the
   * only one available at dispatch time. That holds on a chain, where the
   * result is a block away, and does not hold in the sandbox, whose reducer
   * is synchronous -- so the resolved state is one call away and the log was
   * reporting a prediction where it could have reported a fact.
   *
   * The distinction that survives is which side of an action a given figure
   * belongs to, and it is not uniform:
   *
   *   AFTER  the depot's remaining stock, a treasury balance -- the reader
   *          wants to know where things stand now.
   *   BEFORE what a thing COST, which corporation acted, who held what --
   *          facts about the action rather than its consequences.
   *
   * So both are available and each figure takes the one that fits.
   * `undefined` on a live chain, where the before-derived phrasing stands. */
  afterState?: GameStateResponse | null;
  mapGrid: MapGridResponse;
  era: TileColorTier;
  /** Renders a wallet as a readable name. */
  labelForAddress: (address: string) => string;
  /** Current market price by `company_id`, for the dividend line's
   *  before/after. `undefined` when the chart is not available, and the line
   *  then omits the price move rather than inventing one. */
  marketPrices?: Readonly<Record<number, number | undefined>>;
  /** Where the price would land if this corporation pays out. Supplied by
   *  the caller because the projection lives with the chart. */
  projectPrice?: (price: number, choice: "pay" | "withhold") => number | null;
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

/**
 * One human sentence for `msg`, or `null` when this message has nothing
 * worth reporting beyond its own name.
 *
 * `null` rather than a generic fallback: the caller keeps its own label for
 * those, and a sentence that says less than the variant name would be a
 * downgrade dressed as an improvement.
 */
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
    return (
      `${corp(gameState, protocol_id)} ran a $${breakdown.revenue} route` +
      (train ? ` with a ${train}-train` : "") +
      ` through ${stops.join(" -> ")}.`
    );
  }

  if ("DeclareDividends" in msg) {
    const { protocol_id, revenue_amount, distribute } = msg.DeclareDividends;
    const company = gameState?.public_companies.find(
      (entry) => entry.company_id === protocol_id,
    );
    const stated = Number(revenue_amount);
    const revenue =
      Number.isFinite(stated) && stated > 0
        ? stated
        : Number(company?.last_route_revenue ?? 0) || 0;
    const ticker = corp(gameState, protocol_id);

    // The price move, appended only when the chart can say where the token
    // is. An invented "moved from ? to ?" would be worse than silence.
    const price = context.marketPrices?.[protocol_id];
    const moved =
      price !== undefined && context.projectPrice
        ? context.projectPrice(price, distribute ? "pay" : "withhold")
        : null;
    const priceSentence =
      price !== undefined && moved !== null && moved !== price
        ? ` Share price moved from $${price} to $${moved}.`
        : price !== undefined
          ? ` Share price held at $${price}.`
          : "";

    if (!distribute) {
      return `${ticker} withheld $${revenue} into its treasury.${priceSentence}`;
    }

    // 1830 splits ten ways -- one certificate is 10%.
    const perShare = Math.floor(revenue / 10);
    const split = (company?.player_holdings ?? [])
      .slice()
      .sort((a, b) => b.percentage - a.percentage)
      .map(
        (holding) =>
          `$${perShare * (holding.percentage / 10)} to ${context.labelForAddress(holding.player)}`,
      );
    return (
      `${ticker} paid dividends on $${revenue}` +
      (split.length > 0 ? `: ${split.join(", ")}.` : " — no shareholders on record.") +
      priceSentence
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

    /* Design note #2: the SUPPLY is an after-figure and the PRICE is a
       before-figure, in one sentence. Reading the resolved state rather than
       subtracting one from the old one also means the log cannot disagree
       with the depot panel about what is left -- both ask
       `depotInventory` of the same state. */
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

  /* ==================================================================
   *  DESIGN NOTE 361: PRIVATES ARE KNOWN BY NUMBER AS WELL AS NAME
   * ==================================================================
   *
   * REPORTED: the log prints "Schuylkill Valley" where it should print
   * "1. Schuylkill Valley".
   *
   * The auction cards have been numbered 1-6 since design note #304, on the
   * reasoning that 1830 players refer to these companies by waterfall order
   * as much as by name -- "the 3" is how a table talks about the Delaware &
   * Hudson. The log was the one surface still using bare names, so a player
   * reading back what happened had to translate between two vocabularies.
   *
   * ONE HELPER, used by every arm that names a private, so the log cannot
   * develop two formats. Falls back to the bare id when the room does not
   * report the company -- "private #3" is still better than "undefined",
   * and it is the same fallback design note #307 established. */
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
    return `${corp(gameState, msg.AdvanceOperatingSubPhase.protocol_id)} skipped a step.`;
  }

  /* ---- Stock Round and the auction: the player acts. ---- */

  if ("BuyStock" in msg) {
    const { protocol_id, source } = msg.BuyStock;
    return (
      `${actingPlayer(context)} bought a 10% share of ${corp(gameState, protocol_id)} ` +
      `from the ${source === "Ipo" ? "IPO" : "bank pool"}.`
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
    /* Design note #307: NAME IT. "private #3" is the contract's identifier
       and means nothing at the table. Design note #361 added the number
       back in front of the name, which is how players actually refer to
       these companies -- the lookup that used to sit here is now inside
       `namePrivate`, so both arms format identically. */
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

  if ("PassTurn" in msg) return `${actingPlayer(context)} passed the turn.`;
  if ("UndoLastAction" in msg) return `${actingPlayer(context)} undid the last action.`;
  if ("BeginOperatingRound" in msg) return "The Operating Round began.";

  // `ExecuteOperatingRound` and anything added later: the caller's own label
  // stands. Design note #0 -- a vaguer sentence than the variant name would
  // be a downgrade.
  return null;
}
