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
import { BO_PRIVATE_ID, BO_TICKER } from "./gameConstants";
import { PRESIDENT_CERTIFICATE_PERCENT, settlePresidencies } from "./presidencyTransfer";
import { resolveVariants } from "./gameVariants";
import { assessExcess, chartForDivestment, incurableExcess } from "./forcedDivestment";
import { CA_PRIVATE_ID, PLAYER_HOLDING_CAP_PERCENT, applyPrivateBenefitGrant } from "./privateExchange";

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

/* ==================================================================
    DA-3 (DA-F1): AN AUCTION MESSAGE IS JUDGED ONLY WHILE AN AUCTION IS OPEN
   ==================================================================
   FOUND BY DA-1 (`VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md`, probes P2, P4, P5). Every predicate in this
   file judged a message against the atom and never asked whether the atom was RUNNING. Under the Delayed Auction
   the atom is dealt with every private on it and lies dormant from Stock Round 1 onwards, so the Stock Round seat
   could buy the Schuylkill Valley in the atom cursor's name (another player paid), bid in that player's name, or
   mark the SV down with a round of passes; and in EVERY game a `WaterfallPass` sent after the auction still
   counted towards the atom's all-pass and paid a round of private income. The dashboard mounts only in the
   auction round, so the UI was the only gate.
   ONE CONDITION, ASKED FIRST, AT BOTH LOCKS: the round is the auction AND the atom has not been closed.
   `waterfall_auction_active` is written only by the atom's own lifecycle -- `settle` closes it when the last
   private leaves, `settleAuctionLifecycle` deals a delayed auction dormant and arms it when the round reaches it,
   `OpenStockRound` closes it -- so it is the authoritative "is this auction open" in both games, and a later
   rule that cancels an auction (DA-5) closes it through the same field rather than through a bypass here.
   ABSENT READS AS OPEN (#232): a hand-built atom that never wrote the field has said nothing about its state. A
   board with no atom at all has no auction to act in. */
/** Why no auction action can be taken right now, or `null` while an auction is open. */
export function auctionClosedRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
): string | null {
  if (state.current_round_type !== "WaterfallAuction") {
    return "There is no private company auction running — auction actions are taken only in the Auction Round.";
  }
  if (!waterfall || waterfall.waterfall_auction_active === false) {
    return "The private company auction is closed — every private company on offer has been allocated.";
  }
  return null;
}

/* ==================================================================
    DA-3 (DA-F2, DA-F7): THE B&O PRESIDENT'S CERTIFICATE IS THE B&O PRIVATE'S, AND IT IS OWED AT ONCE
   ==================================================================
   Rulebook §3.0 (the BO private): its owner "immediately receives the president's certificate of the B&O railroad
   without further payment and immediately sets a par share value". Two defects hung off that sentence.
   DA-F2 -- `SetBoPar` asked who SENT it, and asked the private's owner only when there was one: while the BO
   private was unsold any seated player could name themselves and take the B&O presidency for nothing (the
   standard auction's window, and the whole of the Delayed Auction's Stock Round 1 onwards -- the #904a lock was
   asked by share purchases alone). THE CERTIFICATE BELONGS TO THE PRIVATE: `SetBoPar` is legal only for the BO
   private's owner, so while it is unsold -- or closed -- nobody takes it by this path, in either game. That is
   private-company state, not a round number or a UI latch, so a later rule that closes an unsold BO private
   (DA-5) removes the path by changing the private, not by adding an exception here.
   DA-F7 -- the par was sequenced by the auction modal only: a handoff sent before it let another player par the
   B&O in the Stock Round and silently collide the owner's grant (#904b). THE OBLIGATION IS DERIVED, NOT
   STORED: the private is held by a player, the B&O has no president, and the certificate is still in the initial
   offering. Replay, restore and `RevertTo` rebuild it from the log with nothing else to keep in step; the
   owner's `SetBoPar` discharges it by giving the B&O a president. A grant `boPresidencyRefusal` would refuse (the
   certificate already gone) is never owed -- an obligation that cannot be discharged would stop the game. */
function boPrivateOf(state: GameStateResponse) {
  return state.private_companies?.find((entry) => entry.private_id === BO_PRIVATE_ID) ?? null;
}

/** The player the B&O President's Certificate and par are owed to right now, or `null`. */
export function boParOwedTo(state: GameStateResponse): string | null {
  const priv = boPrivateOf(state);
  if (!priv || priv.closed || !priv.owner || priv.owner_protocol_id != null) return null;
  const bo = state.public_companies?.find((company) => company.ticker === BO_TICKER);
  if (!bo || bo.president != null) return null;
  if ((Number(bo.ipo_pool_percentage) || 0) < PRESIDENT_CERTIFICATE_PERCENT) return null;
  return priv.owner;
}

/** Why `player` may not take the B&O President's Certificate through `SetBoPar`, or `null`. The presidency
 *  and invented-shares preconditions stay `boPresidencyRefusal`'s (#904b), asked by the arm after this. */
export function boParRefusal(state: GameStateResponse, player: string | null | undefined): string | null {
  const priv = boPrivateOf(state);
  if (!priv || priv.closed) {
    return `The ${BO_TICKER} private company is not in play, so there is no ${BO_TICKER} President's Certificate to hand over.`;
  }
  if (!priv.owner) {
    return `The ${BO_TICKER} private company has not been sold — whoever buys it receives the ${BO_TICKER} President's Certificate and sets the par.`;
  }
  if (priv.owner_protocol_id != null || priv.owner !== player) {
    return `Only the ${BO_TICKER} private's owner pars the ${BO_TICKER}.`;
  }
  return null;
}

/** DA-F7: the auction waits while the B&O par is owed. */
function boParOwedBlock(state: GameStateResponse): string | null {
  return boParOwedTo(state) === null
    ? null
    : `The ${BO_TICKER} par comes first — the ${BO_TICKER} private's owner takes the President's Certificate and sets the par before the auction goes on.`;
}

/** Why the auction cannot hand off to the Stock Round, or `null`. The round and "nothing left unsold" rules are
 *  the ones ingress always asked (now asked by the reducer too); DA-F7 adds the owed B&O par. */
export function auctionHandoffRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
): string | null {
  if (state.current_round_type !== "WaterfallAuction") return "The Stock Round is already open.";
  const unsold = waterfall?.privates.length ?? 0;
  if (unsold > 0) {
    return `The auction is not over yet — ${unsold} private ${unsold === 1 ? "company is" : "companies are"} still for sale.`;
  }
  if (boParOwedTo(state) !== null) {
    return `The ${BO_TICKER} par comes first — the ${BO_TICKER} private's owner takes the President's Certificate and sets the par before the Stock Round opens.`;
  }
  return null;
}

/* ---- the three main-rotation actions --------------------------------------------------------- */

/** Why the lowest-offered private cannot be bought at face value right now, or `null`. DA-5: the purchase is also
 *  a voluntary acquisition (D-58), so the limit check follows the purchase's own rules. */
export function waterfallBuyRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
): string | null {
  return (
    waterfallBuyRuleRefusal(state, waterfall) ??
    acquisitionSolvencyRefusal(state, waterfall, auctionActor(waterfall), lowestOffered(waterfall)?.private_id ?? null)
  );
}

function waterfallBuyRuleRefusal(
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

/** Why this bid cannot be placed, or `null`. DA-5: an initial or increased bid is a voluntary commitment to
 *  acquire (D-57, D-58), judged with the bidder's other standing bids counted as wins (D-59). */
export function waterfallBidRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  bid: { private_id: number; bid_amount: string | number },
): string | null {
  return (
    waterfallBidRuleRefusal(state, waterfall, bid) ??
    acquisitionSolvencyRefusal(state, waterfall, auctionActor(waterfall), bid.private_id)
  );
}

function waterfallBidRuleRefusal(
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

/** Why this mini-auction raise is illegal, or `null`. DA-5: a raise is a voluntary commitment to acquire (D-57). */
export function miniRaiseRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  raise: { bid_amount: string | number },
): string | null {
  return (
    miniRaiseRuleRefusal(state, waterfall, raise) ??
    acquisitionSolvencyRefusal(state, waterfall, auctionActor(waterfall), contestOf(waterfall)?.private_id ?? null)
  );
}

function miniRaiseRuleRefusal(
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
  if ("BidOnPrivate" in msg) return legacyBidRefusal(state);
  if (!isAuctionMessage(msg)) return null;
  /* DA-3 (DA-F1, DA-F7): is an auction open, and is it waiting on the B&O par -- asked of every waterfall message
     before anything about the action itself, so no rule below ever judges a dormant or finished atom. */
  const closed = auctionClosedRefusal(state, waterfall);
  if (closed !== null) return closed;
  const owed = boParOwedBlock(state);
  if (owed !== null) return owed;
  if ("WaterfallBuyLowest" in msg) return waterfallBuyRefusal(state, waterfall);
  if ("WaterfallBidHigher" in msg) return waterfallBidRefusal(state, waterfall, msg.WaterfallBidHigher);
  if ("WaterfallPass" in msg) return waterfallPassRefusal(state, waterfall);
  if ("WaterfallMiniAuctionRaise" in msg) {
    return miniRaiseRefusal(state, waterfall, msg.WaterfallMiniAuctionRaise);
  }
  if ("WaterfallMiniAuctionPass" in msg) return miniPassRefusal(state, waterfall);
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

/* ---- DA-3: the auction's lifecycle, as one gate for the reducer ------------------------------------ */

/** Whether this message is one the auction's lifecycle judges: the auction messages, the handoff and the B&O
 *  par. The reducer's board gate asks `auctionLifecycleRefusal` for exactly these, above both atoms. */
export function isAuctionLifecycleMessage(msg: SandboxLogMsg): boolean {
  return isAuctionMessage(msg) || "OpenStockRound" in msg || "SetBoPar" in msg;
}

/** Why this auction-lifecycle message is illegal right now, or `null`. The same predicates ingress asks
 *  (`turnRefusal`), so the two locks cannot come to differ. */
export function auctionLifecycleRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  msg: SandboxLogMsg,
): string | null {
  if ("OpenStockRound" in msg) return auctionHandoffRefusal(state, waterfall);
  if ("SetBoPar" in msg) {
    const par = (msg as { SetBoPar?: { player?: string | null } }).SetBoPar;
    return boParRefusal(state, par?.player ?? null);
  }
  return auctionRefusal(state, waterfall, msg);
}

/* ---- DA-4: the auction's own pointer -- who opens it, who acts, and who holds the Priority Deal after it ---- */

/* ==================================================================
    DA-4 (DA-F3, DA-F4, DA-F5): ONE POINTER FOR THE AUCTION'S TURN AND ITS PRIORITY DEAL
   ==================================================================
   THE RULE (2018 §1.2, §1.2.2, §1.2.3; the 48-page book's C-2.2, which prints the same text). The buy-bid-turn
   sequence starts with the Priority Deal holder. A face-value purchase of the lowest private gives the Priority
   Deal to "the player to your left", and the sequence goes on from him. The SV marked down to $0 is bought by "the
   next player to take his buy-bid-turn ... (i.e., it is free but is treated as a purchase)" -- a purchase, so the
   card passes to the taker's left as well. A bid award -- a lone bid in the cascade, or a contest's winner --
   does NOT move the card ("The Priority Deal does not change hands after an auction"), and after one "the buy-bid-
   turn sequence then resumes with the player with the priority deal card".

   THE ATOM'S CURSOR ALREADY CARRIES THAT HISTORY, and it is the one pointer the auction owns. A direct purchase
   leaves `current_turn` on the purchaser's left -- the card's new holder (`WaterfallBuyLowest`: `nextSeat` of the
   buyer; the $0 branch: `nextSeat` of the taker). A contest does not move it (#338 preserves it; the main rotation
   is frozen until the contest resolves, S7-15), and neither does the cascade that awards the lone bids. Every
   contest opens INSIDE the cascade of a direct purchase or of the contest before it -- a bid on the lowest private
   is refused (A1 / M2), so there is no other door -- which is why the preserved cursor is still the card's holder
   when a contest ends and the sequence resumes. The auction ENDS only inside such a chain, since its last private
   leaves by a direct purchase or by a resolution cascading from one; nothing else removes a private. So once no
   private remains (the only board `OpenStockRound` applies to, DA-3), the cursor names the player to the left of
   the last direct purchaser -- the Priority Deal the auction hands over -- and no second record of it is kept.

   WHY NOT A NEW FIELD. An explicit "holder" or "last purchaser" on the atom would be a second record of what the
   cursor already says, updated by the same arms; and every standard board carries the atom, so the field would
   change every stored board and the frozen goldens, which DA-4 must not repin. The cursor is authoritative state
   already: rebuilt from the log on every replay, restore and `RevertTo`, and read by `actingAddress` (#1232).

   WHAT CHANGED. The seat (`active_player_index`) was the pointer `OpenStockRound` read (#1235), and the seat is a
   MIRROR: it steps once per main-rotation message, so it drifts wherever the cursor moves by any other amount --
   by two on the $0 taking (DA-F5), and not at all across the Operating Rounds the Delayed Auction follows (DA-F4).
   Now the handoff reads the cursor (`auctionPriorityDealSeat`), the reducer re-seats the mirror on the cursor after
   every main-rotation auction message (`sandboxSession.ts`), and the Delayed Auction's arming seats BOTH on the
   Priority Deal holder going in (DA-F3) -- which the standard deal already does, seat 0 being that holder. */

/** The seat the auction atom's cursor names, or `null` when there is no atom or its cursor names nobody seated
 *  (before a deal, `current_turn` is `""` -- #542). The same guard `actingAddress` applies (#1232). */
export function auctionCursorSeat(state: GameStateResponse): number | null {
  const cursor = state.waterfall?.current_turn;
  if (!cursor) return null;
  const seat = state.player_addresses.indexOf(cursor);
  return seat === -1 ? null : seat;
}

/** DA-4 (DA-F4, DA-F5): the seat the auction hands the Priority Deal to when it closes -- the player to the left of
 *  its last direct purchaser, which is where the atom's cursor stands once no private remains (see the note above).
 *  A board with no seated auction atom has no auction record to read, so the Priority Deal stays where it was. */
export function auctionPriorityDealSeat(state: GameStateResponse): number {
  return auctionCursorSeat(state) ?? state.priority_deal_index;
}

/* ==================================================================
    DA-8 (DA-F12): WHO RESUMES AFTER THE REVENUE ALL-PASS -- THE PRIORITY DEAL'S HOLDER, READ OFF THE BOARD
   ==================================================================
   §1.2.3 (the 48-page book's C-2.2 prints the same text): "If all players pass and the Schuylkill Valley has been
   sold, each of the private companies already bought pays revenue. Then the buy-bid-turn sequence resumes with the
   player with the priority deal card." The engine resumed with the seat AFTER THE LAST PASSER (`nextSeat`, the arm's
   one-step rule). The two agree whenever the passing lap began on the holder -- a lap that follows a direct purchase,
   whose cursor already stands on the buyer's left -- and differ when a BID preceded the lap (DA-4's probe: A buys the
   SV, B bids, C / A / B pass, income is paid, and C acted next instead of B). The three revenue all-passes the stored
   corpus carries (JUNO-G6J; JUNO-Z6C x 2) follow purchases, so they already resumed on the holder
   (`da8RulesV11Closure.test.ts` asserts it at every one).

   WHERE THE HOLDER IS, WITH NO NEW FIELD. DA-4 kept no second record of the card (a field on the atom would move every
   standard board and the frozen goldens -- and, at GameEnd, the certified settlement boards' state hash). The board
   already says who holds it:
     * the card moves only on a DIRECT purchase -- a face-value buy of the lowest private, or the SV taken at $0
       ("treated as a purchase") -- to the purchaser's left; an award (a lone bid in the cascade, a contest's winner)
       never moves it (§1.2.2);
     * the auction settles `settled_price` on every private it sells and nothing else writes it (#1340): the face on a
       buy, $0 on the taking, the winning bid on an award -- and a bid is always at least face + $5 (§1.2.1, #1184,
       asked at both locks), so `settled_price <= cost` IS "sold by a direct purchase";
     * privates leave the auction only from the front of its list (the lowest offered), and the list is the deal's
       `private_companies` order (`waterfallForRoster`, #1320) -- so the LAST direct purchase is the last such private
       in that order.
   The holder is the seat to that purchaser's left; with no direct purchase yet (possible only on a board whose SV is
   not in the auction) it is the card the auction opened on, `priority_deal_index` -- seat 0 at a standard deal, the
   holder going in under the Delayed Auction (DA-4, DA-F3). Rebuilt from the log on every replay, restore and
   `RevertTo`, like everything else the board holds.

   ONLY THE REVENUE ALL-PASS ASKS THIS. The SV's markdown lap names "the next player" for the $0 taking and resumes
   clockwise, as it always did; a contest resumes on the preserved cursor (DA-4); and the handoff reads the cursor,
   which at that moment IS this holder (`auctionPriorityDealSeat`). The rule is every table's (Classic legitimate play
   and the Delayed Auction), taken at the deliberate v10 -> v11 boundary (changelog row 11). */
export function auctionPriorityHolder(state: GameStateResponse): string | null {
  const players = state.player_addresses ?? [];
  if (players.length === 0) return null;
  let lastDirect: string | null = null;
  for (const entry of state.private_companies ?? []) {
    const price = entry.settled_price;
    const face = Number(entry.cost);
    if (typeof price !== "number" || !Number.isFinite(face) || !entry.owner) continue;
    if (price <= face) lastDirect = entry.owner;
  }
  if (lastDirect !== null) {
    const at = players.indexOf(lastDirect);
    if (at !== -1) return players[(at + 1) % players.length];
  }
  return players[state.priority_deal_index] ?? null;
}

/* ---- DA-5: an acquisition a player may not choose (D-57, D-58, D-59) -------------------------------- */

/* ==================================================================
    DA-5 (D-57, D-58, D-59): NO VOLUNTARY ACQUISITION MAY CREATE AN EXCESS THE NEXT STOCK ROUND CANNOT CURE
   ==================================================================
   OWNER RULINGS (Delayed Auction): "A player may not voluntarily acquire a private -- whether by: face-value
   purchase; initial bid; increased bid; competitive-auction win; or single-bid award -- if that acquisition would
   create an excess over the certificate limit or an applicable corporation ownership limit that cannot be cured by
   legal stock sales at the first legal opportunity in the immediately following Stock Round" (D-58, extending D-57).
   Mandatory acquisitions are exempt -- the forced $0 SV taking and the share a private brings with it. And D-59:
   "Bid legality is judged when the bid or raise is accepted"; an award whose excess became incurable through a later
   involuntary event is HONOURED -- so the check at acceptance must count the bidder's OTHER standing bids as wins,
   or his own later awards could create the excess D-58 forbids.

   WHERE IT IS ASKED: at the three voluntary choices, and only there -- the face-value purchase, the bid (initial or
   increased) and the contest raise, through the predicates both locks already ask (`auctionRefusal`: ingress and the
   reducer's board gate, DA-3). A win or a single-bid award is the consequence of a bid already judged, and nothing
   judges it again: that is how D-59 honours it. The $0 taking is a pass's consequence and is never judged.

   WHAT IS ASKED: the board the next Stock Round would open on -- this board, the player owning the private and
   every private he holds a standing bid on, each with its mandatory share (the C&A's reserved PRR certificate, the
   B&O's President's Certificate), crowns settled -- measured by the SAME curable-excess reading the next Stock
   Round's must-sell hold uses (`assessExcess`). The choice is refused when it leaves more incurable excess than the
   same position without it. The prices do not move between the auction and that Stock Round, so they are read as
   they stand; the standard game is exempt by construction (its auction precedes every holding, so no private can
   put anybody over) and by the gate below, since these are the Delayed Auction's rulings. */

/** Every private this player holds a standing bid on. */
function standingBidPrivates(waterfall: WaterfallStateResponse | null, player: string): number[] {
  return (waterfall?.privates ?? [])
    .filter((entry) => entry.bids.some((bid) => bid.bidder === player))
    .map((entry) => entry.private_id);
}

/** The hypothetical B&O President's Certificate a BO private brings: 20% out of the IPO, the owner presiding. The
 *  par is his to choose later, so the corporation stays unpriced here -- which also makes the lone 20% unsellable,
 *  as it is (no other holder could take the crown). */
function withBoPresidentCertificate(board: GameStateResponse, player: string): GameStateResponse {
  const bo = board.public_companies.find((company) => company.ticker === BO_TICKER);
  if (!bo || bo.president !== null || bo.ipo_pool_percentage < PRESIDENT_CERTIFICATE_PERCENT) return board;
  const held = bo.player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
  return {
    ...board,
    public_companies: board.public_companies.map((company) =>
      company.company_id === bo.company_id
        ? {
            ...company,
            president: player,
            ipo_pool_percentage: company.ipo_pool_percentage - PRESIDENT_CERTIFICATE_PERCENT,
            player_holdings: [
              ...company.player_holdings.filter((entry) => entry.player !== player),
              { player, percentage: held + PRESIDENT_CERTIFICATE_PERCENT },
            ],
          }
        : company,
    ),
  };
}

/** The board the next Stock Round would open on if `player` acquired these privates, with their mandatory shares. */
function boardAfterAcquiring(
  state: GameStateResponse,
  player: string,
  privateIds: readonly number[],
): GameStateResponse {
  let board: GameStateResponse = {
    ...state,
    private_companies: state.private_companies.map((entry) =>
      privateIds.includes(entry.private_id) ? { ...entry, owner: player, owner_protocol_id: null } : entry,
    ),
  };
  for (const privateId of privateIds) {
    if (privateId === CA_PRIVATE_ID) board = applyPrivateBenefitGrant(board, privateId, player);
    if (privateId === BO_PRIVATE_ID) board = withBoPresidentCertificate(board, player);
  }
  return { ...settlePresidencies(board).state, current_round_type: "StockRound" };
}

/** DA-5 (D-57, D-58, D-59): why this player may not voluntarily take on this private, or `null`. */
export function acquisitionSolvencyRefusal(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  player: string | null,
  privateId: number | null,
): string | null {
  if (!player || privateId === null) return null;
  if (!resolveVariants(state.variants).delayedAuction) return null;
  const others = standingBidPrivates(waterfall, player).filter((id) => id !== privateId);
  const chart = chartForDivestment(state);
  const incurableWith = (ids: readonly number[]) =>
    incurableExcess(assessExcess({ state: boardAfterAcquiring(state, player, ids), player, ...chart }));
  const without = incurableWith(others);
  const withIt = incurableWith([...others, privateId]);
  const moreCertificates = withIt.certificates - without.certificates;
  const moreCap = withIt.capPercent - without.capPercent;
  if (moreCertificates <= 0 && moreCap <= 0) return null;

  const name = state.private_companies.find((entry) => entry.private_id === privateId)?.name ?? "That private company";
  const counting = others.length > 0 ? ", counting the private companies you already have bids on as won" : "";
  const excess =
    moreCertificates > 0
      ? `${moreCertificates} certificate${moreCertificates === 1 ? "" : "s"} over the limit`
      : `${moreCap}% over the ${PLAYER_HOLDING_CAP_PERCENT}% cap`;
  return `${name} would leave you ${excess}${counting}, and no legal sale in the next Stock Round could bring you back — a private company may not be taken on by choice when that is so.`;
}
