// frontend/src/gameEngine/auctionAuthority.ts
//
// ==================================================================
//  DESIGN NOTE 1580: THE PRIVATE AUCTION HAS AN AUTHORITY NOW (Batch 7.3)
// ==================================================================
//
// WHAT THE PROBE FOUND, and it is five faults wearing one name (ledger S7-2, S7-3, S7-4, S7-15, S7-19;
// audit C5, M1, M2):
//
//   A BID ON THE LOWEST-OFFERED PRIVATE WAS ACCEPTED. §1.2.1 gives a player three options -- pass, buy the
//   cheapest unsold private at face, or bid on one that is NOT the cheapest. The cheapest is a BUY decision;
//   letting it be bid on opened a mini-auction on the one private everybody can always reach.
//
//   NOTHING ASKED WHETHER THE MONEY EXISTED. §1.2.1: "place the bid money in front of him ... and not use it
//   for any other purpose until ownership is resolved." The escrow was DERIVED (`auctionEscrow.ts`) and read
//   only by the dashboard; the reducer never asked, so the probe bid $9,999 with $1,160 in hand and stood
//   the same dollar on three privates at once.
//
//   A MINI-AUCTION PASS EXPELLED THE BIDDER AND DELETED HIS BID (M1). §1.2.2 is the opposite: a bidder "may
//   pass and still bid later if the auction does not end", and the contest ends only when "all of the
//   bidders pass consecutively". A raise of +$1 was accepted too -- §1.2.2's $5 increment was the dashboard's
//   arithmetic and nothing else's.
//
//   THE ALL-PASS MARKED DOWN WHOEVER WAS CHEAPEST AND PAID REVENUE EVERY TIME (C5). Both halves belong to the
//   Schuylkill Valley: it is the SV that loses $5 while unsold, and it is the SV being SOLD that turns an
//   all-pass into a revenue payment. See `SV_PRIVATE_ID` (#1580 in `gameConstants.ts`).
//
//   AND THE MAIN ROTATION KEPT MOVING DURING A CONTEST (S7-15). `WaterfallBuyLowest` / `BidHigher` / `Pass`
//   had no idea a mini-auction was live, so the contest's current player -- who passes the ingress seat check,
//   because `actingAddress` names them -- could buy a private, bid on another, or pass the main sequence
//   while the contest waited.
//
// ONE PREDICATE PER MESSAGE, ASKED IN TWO PLACES. `auctionRefusal` is asked by the reducer (by identity,
// ABOVE the auction atom -- see `applySandboxActionOnBoard`, because that atom runs before the board and a
// refusal that arrived later would leave the seat advanced for a purchase that did not happen) and at ingress
// (with the sentence the room banner shows). The reducer remains canonical law; ingress owns no rule.
//
// THE ACTOR IS THE ATOM'S CURSOR, not the message and not the seat. `applySandboxWaterfallAction` applies
// every auction action as `mini_auction?.current_turn ?? current_turn` (#1232/#544), so a predicate that
// judged a different player would be judging a different action. Ingress has already established that the
// sender IS that player (`actingAddress` reads the same two fields), so both locks ask about one person.
//
// THE ESCROW ARITHMETIC IS NOT REIMPLEMENTED HERE. `auctionEscrow.ts` has computed it since design note #0 --
// `auctionFunds`, `bidRejectionReason`, `minimumBidFor` -- and the dashboard has been calling those helpers
// all along. This module calls the SAME functions, which is why the button and the board cannot disagree
// about a bid (the #1184 shape, avoided by construction rather than by care).
//
// See BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md §7.7 and §1.2/§1.2.1/§1.2.2/§1.2.3 of the rulebook;
// owner rulings D-16 (Q3, the own-bid raise), D-21 (Q8, SV-only markdown), D-23 (Q11, the legacy messages).

import type {
  GameStateResponse,
  WaterfallMiniAuctionStatus,
  WaterfallPrivateStatus,
  WaterfallStateResponse,
} from "./gameState";
import {
  MIN_BID_INCREMENT,
  auctionFunds,
  bidRejectionReason,
  minimumBidFor,
} from "./auctionEscrow";
import type { SandboxLogMsg } from "./gameSetup";

/** The player the auction atom is waiting on -- the same derivation `applySandboxWaterfallAction` applies
 *  every action under, so the rule and the mutation judge one person (#1232/#544). */
export function auctionActor(waterfall: WaterfallStateResponse | null): string | null {
  if (!waterfall) return null;
  return waterfall.mini_auction?.current_turn || waterfall.current_turn || null;
}

/** This player's standing bid on one private, or 0. One bid per player per private is the atom's rule (a
 *  raise REPLACES rather than stacks), so this is a lookup and not a sum. */
export function standingBidOn(
  waterfall: WaterfallStateResponse | null,
  privateId: number,
  player: string | null,
): number {
  if (!waterfall || !player) return 0;
  const entry = waterfall.privates.find((priv) => priv.private_id === privateId);
  if (!entry) return 0;
  return Number(entry.bids.find((bid) => bid.bidder === player)?.bid_amount ?? 0) || 0;
}

/** The private the main sequence is offering: the cheapest still unsold. */
export function lowestOffered(
  waterfall: WaterfallStateResponse | null,
): WaterfallPrivateStatus | null {
  return waterfall?.privates.find((entry) => entry.is_lowest_offered) ?? null;
}

const whole = (value: unknown): boolean => {
  const amount = Number(value);
  return Number.isFinite(amount) && Number.isInteger(amount);
};

/** The contest, when one is live. */
const contestOf = (waterfall: WaterfallStateResponse | null): WaterfallMiniAuctionStatus | null =>
  waterfall?.mini_auction ?? null;

/** Why a main-rotation auction action cannot be taken while a contest is live, or `null`.
 *
 *  A14 / S7-15. The mini-auction is a sub-sequence: until it resolves the main rotation is suspended on BOTH
 *  atoms (#338 preserves `waterfall.current_turn` across it for exactly that reason), so a buy, a bid or a
 *  pass sent now is an action in a sequence that is not running. The contest's own current player is who
 *  `actingAddress` names, so the ingress seat check does NOT catch this -- which is how the probe moved the
 *  main rotation mid-contest. */
function contestBlock(waterfall: WaterfallStateResponse | null): string | null {
  const contest = contestOf(waterfall);
  if (!contest) return null;
  const name =
    waterfall?.privates.find((entry) => entry.private_id === contest.private_id)?.name ??
    "a private company";
  return `The auction for ${name} is still being contested — it is settled with a raise or a pass, and nothing else in the auction happens until it is.`;
}

/* ---- the three main-rotation actions --------------------------------------------------------- */

/** Why the lowest-offered private cannot be bought at face value right now, or `null`. */
export function waterfallBuyRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
): string | null {
  const held = contestBlock(waterfall);
  if (held !== null) return held;

  const target = lowestOffered(waterfall);
  if (!target) return "There is no private company left to buy.";

  const actor = auctionActor(waterfall);
  if (!actor) return null; // #232: an atom that names nobody has said nothing about the turn.

  const price = Number(target.face_value) || 0;
  /* §1.2.1's escrow, read as a rule for the first time. The buyer's own standing bid ON THIS PRIVATE would be
     released by the purchase, so it is not held against him -- the same allowance `bidRejectionReason` makes
     for a raise. In ordinary play that bid cannot exist (A1 forbids bidding on the lowest); on a legacy board
     it can, and charging it twice would refuse a purchase the player can plainly afford. */
  const funds = auctionFunds(state, waterfall, actor);
  if (funds === null) return null; // unknown funds: defer, exactly as `bidRejectionReason` does
  const released = standingBidOn(waterfall, target.private_id, actor);
  const available = Math.max(0, funds.total - (funds.escrowed - released));
  if (price > available) {
    return funds.escrowed > 0
      ? `${target.name} costs $${price} and only $${available} of your $${funds.total} is free — the rest is committed to standing bids.`
      : `${target.name} costs $${price} and you hold $${funds.total}.`;
  }
  return null;
}

/** Why this bid cannot be placed, or `null`. */
export function waterfallBidRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  bid: { private_id: number; bid_amount: string | number },
): string | null {
  const held = contestBlock(waterfall);
  if (held !== null) return held;

  const target = waterfall?.privates.find((entry) => entry.private_id === bid.private_id) ?? null;
  if (!target) return "That private company is not for sale in this auction.";

  /* ---- A1: the cheapest is a BUY, never a bid ------------------------------------------------
     Rulebook §1.2: the three options are pass, "buy the cheapest unsold private company at face value", or
     "bid on a private company OTHER than the cheapest one". A bid on the cheapest is not a more aggressive
     version of the purchase -- it is a different option applied to the wrong card, and accepting it opened a
     mini-auction on the one private every player can always reach (M2). */
  if (target.is_lowest_offered) {
    return `${target.name} is the cheapest private company on offer, so it is bought at its $${Number(target.face_value) || 0} face value rather than bid on.`;
  }

  if (!whole(bid.bid_amount)) {
    return `A bid is a whole number of dollars — “${String(bid.bid_amount)}” is not one.`;
  }
  const amount = Number(bid.bid_amount);

  const actor = auctionActor(waterfall);
  if (!actor) return null;

  /* §1.2.1's minimum and §1.2.1's escrow, from the two helpers the dashboard already uses. `raisingFrom` is
     this player's own standing bid on this private: that money is ALREADY committed, so raising one's own bid
     (legal — owner ruling D-16/Q3) only has to cover the difference. */
  return bidRejectionReason(
    auctionFunds(state, waterfall, actor),
    amount,
    minimumBidFor({ faceValue: target.face_value, bids: target.bids }),
    standingBidOn(waterfall, bid.private_id, actor),
  );
}

/** Why the main sequence cannot be passed right now, or `null`. */
export function waterfallPassRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
): string | null {
  return contestBlock(waterfall);
}

/* ---- the contest ------------------------------------------------------------------------------ */

/** Why this mini-auction raise is illegal, or `null`. */
export function miniRaiseRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  raise: { bid_amount: string | number },
): string | null {
  const contest = contestOf(waterfall);
  if (!contest) return "No private company is being contested, so there is nothing to raise.";

  if (!whole(raise.bid_amount)) {
    return `A bid is a whole number of dollars — “${String(raise.bid_amount)}” is not one.`;
  }
  const amount = Number(raise.bid_amount);

  const actor = auctionActor(waterfall);
  if (!actor) return null;
  /* The cursor is the authority on WHOSE raise this is (#544/#1232), and the atom applies it as that player;
     a bidder the contest does not list cannot be the cursor, so this is a statement about a malformed atom
     rather than about a player. */
  if (!contest.bidders.includes(actor)) {
    return "Only the bidders in this contest can raise.";
  }

  /* §1.2.2: "each raise must be at least $5 more than the previous high bid". The dashboard has enforced this
     since #1184 and the contest arm never has -- a +$1 raise was accepted. */
  const minimum = (Number(contest.high_bid) || 0) + MIN_BID_INCREMENT;
  if (amount < minimum) {
    return `A raise must beat the $${Number(contest.high_bid) || 0} high bid by at least $${MIN_BID_INCREMENT} — $${minimum} is the least you may bid.`;
  }

  const funds = auctionFunds(state, waterfall, actor);
  if (funds === null) return null;
  const raisingFrom = standingBidOn(waterfall, contest.private_id, actor);
  const needed = Math.max(0, amount - raisingFrom);
  if (needed > funds.available) {
    return funds.escrowed > raisingFrom
      ? `Only $${funds.available + raisingFrom} of your $${funds.total} can reach this contest — the rest is committed to standing bids on other private companies.`
      : `You hold $${funds.total}, which is not enough for a $${amount} bid.`;
  }
  return null;
}

/** Why this mini-auction pass is illegal, or `null`. */
export function miniPassRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
): string | null {
  const contest = contestOf(waterfall);
  if (!contest) return "No private company is being contested, so there is nothing to pass on.";
  const actor = auctionActor(waterfall);
  if (actor !== null && !contest.bidders.includes(actor)) {
    return "Only the bidders in this contest can pass in it.";
  }
  /* A PASS IS NOT A DROP-OUT (M1). §1.2.2: a bidder "may pass and still bid later if the auction does not
     end". Nothing about passing is refused -- what changed is what a pass DOES, which is the atom's
     (`passes_since_raise`), not this predicate's. The high bidder is never asked (`nextMiniTurn` skips him),
     so there is no "you are winning, you may not pass" rule to state. */
  return null;
}

/* ---- the legacy message ------------------------------------------------------------------------ */

/** Why `BidOnPrivate` is refused, or `null` on a board old enough to have meant it.
 *
 *  S7-19 / ruling D-23 (Q11). `BidOnPrivate` is a chain-era message nothing has dispatched since the
 *  waterfall atom existed: its arm is `advanceSeat` while `applySandboxWaterfallAction` ignores it entirely,
 *  so a hand-built copy desynchronises the seat from `waterfall.current_turn` and leaves the auction pointing
 *  at somebody it is not waiting for -- #1232's lock-up, reachable by message. Refused on a board this engine
 *  dealt; a legacy log keeps the arm it was played on (D-9), exactly as `RunManualRoute` does. The schema and
 *  the type stay until S10-8. */
export function legacyBidRefusal(state: GameStateResponse): string | null {
  if (typeof state.rules_engine_version !== "number") return null;
  return "BidOnPrivate is a legacy message; this auction is played with WaterfallBidHigher and WaterfallBuyLowest.";
}

/* ---- the one entry point both locks ask ------------------------------------------------------- */

/** Why this auction message is illegal right now, or `null` when it is not an auction message or is legal.
 *
 *  ONE FUNCTION so the reducer and the ingress boundary cannot come to differ about an auction rule, and so
 *  a seventh auction message added later has exactly one place to be judged. */
export function auctionRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  msg: SandboxLogMsg,
): string | null {
  if ("WaterfallBuyLowest" in msg) return waterfallBuyRefusal(state, waterfall);
  if ("WaterfallBidHigher" in msg) return waterfallBidRefusal(state, waterfall, msg.WaterfallBidHigher);
  if ("WaterfallPass" in msg) return waterfallPassRefusal(state, waterfall);
  if ("WaterfallMiniAuctionRaise" in msg) {
    return miniRaiseRefusal(state, waterfall, msg.WaterfallMiniAuctionRaise);
  }
  if ("WaterfallMiniAuctionPass" in msg) return miniPassRefusal(state, waterfall);
  if ("BidOnPrivate" in msg) return legacyBidRefusal(state);
  return null;
}

/** Whether this message is one the auction owns -- used by the reducer to decide whether to ask at all. */
export function isAuctionMessage(msg: SandboxLogMsg): boolean {
  return (
    "WaterfallBuyLowest" in msg ||
    "WaterfallBidHigher" in msg ||
    "WaterfallPass" in msg ||
    "WaterfallMiniAuctionRaise" in msg ||
    "WaterfallMiniAuctionPass" in msg ||
    "BidOnPrivate" in msg
  );
}
