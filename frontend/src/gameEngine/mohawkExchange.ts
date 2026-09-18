// frontend/src/gameEngine/mohawkExchange.ts
//
// The Mohawk & Hudson's exchange: when it may be asked for, when it happens, and what it does.
//
// ==================================================================
//  DESIGN NOTE 1630 (Slice 8.4, S8-10): THE POWER HAD A MESSAGE AND NO AUTHORITY
// ==================================================================
//
// Rulebook p. 27: "A player owning the MH may exchange it for a 10% share of the NYC from the bank or the
// bank pool, provided he may hold another share of the NYC and there is a NYC share available in the bank or
// the pool. The exchange may be made during the player's turn of a stock round or between the turns of other
// players or railroads in either stock or operating rounds. This action closes the MH."
//
// WHAT THE REDUCER DID WITH THAT. `sandboxSession.ts`'s `ExchangePrivate` arm applied whatever the message
// said and re-derived nothing -- its own comment: "this arm applies a decision rather than re-deriving one".
// So the source, the corporation, `keep_open`, the ownership, the 60% cap, the certificate limit, the share's
// physical availability, the timing window, the float threshold and the presidency were ALL unjudged, and
// ingress asked only "is the M&H yours". A hand-built message could take a certificate out of an empty pile
// (`applyPrivateExchange` clamps with `Math.max(0, …)`), keep the M&H open, name a corporation that is not
// the NYC, or push its owner past 60%.
//
// AND ONE OF THE GAPS IS VISIBLE IN THE STORED CORPUS. JUNO-3XD 288 is a real M&H exchange that takes NYC's
// IPO from 50% to 40% -- sixty percent out of the IPO, which is 5.3's float condition -- and NYC does not
// float, because `applyFloatThreshold` ran only in the `BuyStock` arm (#363). NYC floats one entry later, on
// 289's purchase. Slice 8.4 moves that helper to `floatThreshold.ts` (#1631) and asks it here too.
//
// ==================================================================
//  OWNER RULINGS THIS MODULE IMPLEMENTS (Stage-8 review 2026-09-16, frozen; §0 of the design)
// ==================================================================
//
// R1 -- A FREE INTERJECTION, WITH A QUEUED OFF-TURN TIMING MODEL.
//   The exchange does not consume the owner's one Stock Round purchase, does not set or consume
//   `bought_this_turn`, does not change Sell -> Buy -> Sell, does not touch the consecutive-pass streak, does
//   not move Priority Deal, does not move the seat, and is not the turn's action (`turn_action_taken`). The
//   owner may still make their normal purchase before or after it, and a player who has already bought may
//   still use it.
//
//   *Why a timing model is needed at all.* At a table the players supply the "between turns" moment. THIS
//   SERVER HAS NO PERSISTENT BETWEEN-TURNS STATE: `advanceSeat` / `recordPass` / `advanceCorporation` move
//   from one turn straight into the next inside a single entry, and the two flags that mark a round boundary
//   (`stock_round_just_ended`, `operating_round_just_ended`) are raised and cleared within that same entry by
//   `settleRoundTransitions`. There is no board a client can address on which "nobody's turn is underway" is
//   true -- which is why `mhExchangeDisposition` below has exactly two answers and not three.
//
//   So: on the owner's own Stock Round turn the exchange EXECUTES AT ONCE. Anywhere else -- another player's
//   Stock Round turn, or any corporation's Operating Round turn, including one the owner presides over -- the
//   request is QUEUED: recorded as `pending_mh_exchange`, never executed mid-turn, never interrupting the
//   actor, never prompting anybody at a transition. The reducer settles it automatically at the next legal
//   between-turns boundary, after revalidating the WHOLE exchange against the authoritative board.
//
//   QUEUING VESTS NOTHING, and that is the load-bearing half. The request reserves no certificate, no
//   certificate-limit headroom and no continued existence for the M&H. Between the request and the boundary
//   another player may take the chosen share, the M&H may change hands, NYC may float or change president,
//   and the first 5-train may close every private in the game. At settlement the board is asked again from
//   scratch; a request that is no longer legal is retired without effect.
//
// R2 -- THE SOURCE IS THE OWNER'S CHOICE. When both the IPO and the Bank Pool hold a legal ordinary 10%, the
//   owner picks. When only one does, only that one is legal. There is NO silent IPO-first rule in this
//   authority, and -- the consequence that matters -- NO AUTOMATIC SUBSTITUTION AT SETTLEMENT: a queued
//   request whose chosen pile has since emptied is CANCELLED, never quietly rerouted to the other pile.
//   (The current panel still preselects the IPO before dispatching; offering the choice is U-35's NEW ACTION
//   and is deliberately not smuggled in here. What this module guarantees is that whatever source arrives is
//   the one used, or the request is refused.)
//
// ==================================================================
//  THE THREE QUESTIONS, KEPT APART
// ==================================================================
//
//   A. `mhExchangeRefusal`      -- is this exchange LEGAL against this board? (asked at request time AND
//                                  again, unchanged, at settlement)
//   B. `mhExchangeDisposition`  -- if legal now, does it EXECUTE or QUEUE?
//   C. `settleMhExchange`       -- at a boundary, does the standing request execute or retire?
//
// REQUEST LEGALITY AND SETTLEMENT LEGALITY ARE THE SAME PREDICATE ASKED TWICE, never two predicates. That is
// the whole of "queuing vests nothing": if the second asking could be weaker than the first, the queue would
// confer something. And a request that is ILLEGAL NOW is refused outright rather than parked in the hope it
// becomes legal later -- a queue of hopeful requests is a second rules engine.
//
// ==================================================================
//  WHAT IS DELIBERATELY NOT REUSED FROM `BuyStock`
// ==================================================================
//
// AN EXCHANGE IS NOT A PURCHASE, so `sharePurchaseBlock` is NOT called wholesale. Not applicable here:
// affordability and the stock price (nothing is paid); `bought_this_turn` and the one-purchase-per-turn rule
// (R1: not a purchase); the #744 sold-this-round buy-back lockout (that rule exists to stop a player
// crashing a price and restocking at the bottom of their own crater -- an exchange moves no price and pays
// nothing, and the M&H is spent either way); the seat and turn-ownership rules (the power is explicitly
// off-turn); and the ordinary activity markers. What IS reused is exactly the two rules §4.3 states as
// "provided he may hold another share": the 60% per-corporation cap with its Orange/Brown waiver
// (`exceeds60Allowed`), and the overall certificate limit with its Yellow/Orange/Brown exemption
// (`certificateBreakdown`). Both are asked of the PROJECTED board -- see `mhCertificateRefusal`.
//
// THE HOLDS ARE NOT ASKED HERE, and that is a dependency fact rather than a rule decision:
// `authoritativeHoldRefusal` lives in `sandboxSession.ts`, which imports this module. Both askers -- the
// reducer (`applySandboxActionOnBoard`, #1613) and ingress (`turnRefusal`, #1530/#1540/#1590/#1612) -- already
// run the four holds AHEAD of this predicate for every message, `ExchangePrivate` included, and neither hold
// allow-list contains it. So a request arriving while a hold stands is refused by the hold, with the hold's
// own established sentence, and no pending request is created (owner ruling, §4 of the Slice-8.4 brief); and
// the settlement call site re-asks the same function before settling a request that was queued earlier.
//
// See STAGE8_AUTHORITY_DESIGN_2026-09-16.md §6, RULES_HARDENING_BACKLOG.md S8-10 / U-35.

import {
  certificateBreakdown,
  type GameStateResponse,
  type PendingMhExchange,
  type PublicCompanyState,
} from "./gameState";
import {
  applyPrivateExchange,
  EXCHANGE_SHARE_PERCENT,
  MH_PRIVATE_ID,
  PLAYER_HOLDING_CAP_PERCENT,
  PRIVATE_EXCHANGES,
} from "./privateExchange";
import { exceeds60Allowed, type PriceZone } from "./sharePurchase";
import { chartContextFromState, ordinaryPercentAvailable } from "./stockTransactionAuthority";
import { applyFloatThreshold } from "./floatThreshold";
import { settlePresidencies } from "./presidencyTransfer";

/** The corporation the M&H exchanges into. Read from the catalogue rather than spelled again. */
export const MH_EXCHANGE_TICKER = PRIVATE_EXCHANGES[MH_PRIVATE_ID].ticker;

/** An M&H exchange as a message asks for it -- `ExchangePrivate`'s body, and the shape a queued request is
 *  stored in (minus `keep_open`, which a legal request never carries). */
export interface MhExchangeRequest {
  private_id: number;
  company_id: number;
  player: string;
  source: "Ipo" | "Bank";
  keep_open?: boolean;
}

/** How a legal request is disposed of, given the board it arrives on (question B). */
export type MhExchangeDisposition = "execute" | "queue";

/** The home-hex table `applyFloatThreshold` needs. Injected exactly as the reducer injects it (#363/#416):
 *  a caller with no table still floats the corporation and simply places no token. */
export type HomeHexToAxial = (label: string) => readonly [number, number] | null;

/* ---- 1. the board's own answers, read once ------------------------------------------------------ */

/** The private the request names, or `null`. */
function privateFor(state: GameStateResponse, privateId: number) {
  return state.private_companies.find((entry) => entry.private_id === privateId) ?? null;
}

/** NYC's zone on the chart this board carries.
 *
 *  STATE-DERIVED, NEVER INJECTED -- #1196's rule. `chartContextFromState` reads `market_positions`, which
 *  every room, replay and shell board carries and which the reducer itself writes, so ingress and the reducer
 *  reach the same zone without either being handed a private copy of the chart. A board with NO chart (unit
 *  fixtures only) yields `null`, which is #7's deliberate conservative answer rather than a degraded one:
 *  the cap holds and every certificate counts. */
function zoneOf(state: GameStateResponse, companyId: number): PriceZone {
  return (chartContextFromState(state).marketZoneFor?.(companyId) ?? null) as PriceZone;
}

/* ---- 2. question A: is this exchange legal against THIS board? --------------------------------- */

/** Whether `source` physically holds an ORDINARY 10% certificate of this corporation.
 *
 *  Design note #1630: THE PILE IS ASKED, NOT THE ARITHMETIC. `applyPrivateExchange` subtracts with
 *  `Math.max(0, …)`, so an exchange against an empty pile would clamp to zero and hand out a certificate the
 *  game does not have -- a mint, and the exact failure `moveShares`' own comment warns about ("a share that
 *  appears in a hand without leaving a pile is a share this game has one too many of"). The clamp stays where
 *  it is and becomes unreachable, which is the arrangement #712 established for the buy side.
 *
 *  ==================================================================
 *   DESIGN NOTE 1634 (Slice 8.4 follow-up): "ORDINARY" IS `ordinaryPercentAvailable`'S READING, NOT A SECOND ONE
 *  ==================================================================
 *  THIS ASKED THE PURCHASE SIDE'S HELPERS AND THEY ARE THE WRONG PAIR. `ordinaryPercentIn` +
 *  `ordinaryPurchaseRefusal` (`doubleCertificate.ts`) subtract the Level Playing Field's standard 20% card and
 *  NOTHING ELSE -- they were written for a pool, where the President's Certificate never is (#448). The IPO is
 *  the pile where it always is until the corporation is started, so on a board whose IPO holds only the
 *  President's 20%, `ordinaryPercentIn` answers 20 and this refusal would have let the exchange take HALF THE
 *  PRESIDENT'S CARD as a 10% share. Unreachable in ordinary play -- an unstarted corporation's IPO is 100%,
 *  because nothing can be bought before the president's certificate and no share of an unparred corporation
 *  can be sold into the pool (`stockSaleRefusal` rule 4) -- and reachable by a hand-built or replayed message,
 *  which is the entire reason this predicate exists.
 *
 *  `ordinaryPercentAvailable` IS ALREADY THE ANSWER, and it is the one `stockPurchaseRefusal` asks: "the 20%
 *  president's certificate, which sits in the IPO while the presidency is unsold and never reaches the Bank
 *  Pool (#448), and the LPF double (#1324)" both subtracted, in the unit a purchase -- or an exchange -- is
 *  expressed in. Asked here rather than re-derived, so the exchange and the purchase cannot come to disagree
 *  about what a pile physically holds, and no certificate arithmetic is written twice.
 *
 *  WHAT THIS DOES NOT IMPORT, and the reason the helper is named rather than copied: it carries no
 *  President's-Certificate-first rule, no par requirement, no affordability, no one-purchase-per-turn and no
 *  sold-this-round lockout. Those live in `stockPurchaseRefusal` around it, and an exchange is not a purchase
 *  (see the header). So an exchange BEFORE NYC's President's Certificate has been bought is legal, which is
 *  the printed rule (p. 15 / p. 27) and is pinned in the authority suite. */
export function mhSourceRefusal(
  company: PublicCompanyState,
  source: "Ipo" | "Bank",
): string | null {
  const where = source === "Bank" ? "Bank Pool" : "IPO";
  const held = source === "Bank" ? company.bank_pool_percentage : company.ipo_pool_percentage;
  if (!Number.isFinite(Number(held)) || Number(held) < EXCHANGE_SHARE_PERCENT) {
    return `The ${where} holds no ${company.ticker} certificate to exchange for.`;
  }
  if (ordinaryPercentAvailable(company, source) < EXCHANGE_SHARE_PERCENT) {
    /* The pile is not empty, but what is in it is not an ordinary share: the President's Certificate while
       the corporation is unstarted, or the Level Playing Field's 20% card. Neither is exchangeable for. */
    return (
      `The ${where} holds no ordinary 10% ${company.ticker} certificate to exchange for — ` +
      `the President's Certificate is not an ordinary share.`
    );
  }
  return null;
}

/** Why the exchange would leave this player holding more of the corporation than 1830 allows, or `null`.
 *
 *  §4.3's first half, and the same waiver `sharePurchaseBlock` applies: Orange and Brown lift the cap. */
export function mhHoldingRefusal(
  company: PublicCompanyState,
  player: string,
  zone: PriceZone,
): string | null {
  const held = company.player_holdings
    .filter((entry) => entry.player === player)
    .reduce((sum, entry) => sum + entry.percentage, 0);
  if (exceeds60Allowed(zone)) return null;
  if (held + EXCHANGE_SHARE_PERCENT <= PLAYER_HOLDING_CAP_PERCENT) return null;
  return (
    `You already hold ${held}% of the ${company.ticker} and no player may exceed ` +
    `${PLAYER_HOLDING_CAP_PERCENT}%. The Orange and Brown zones lift this cap.`
  );
}

/** Why the exchange would leave this player over the certificate limit, or `null`.
 *
 *  ==================================================================
 *   DESIGN NOTE 1630a: THE LIMIT IS JUDGED ON THE BOARD THE EXCHANGE LEAVES, NOT ON "CURRENT + 1"
 *  ==================================================================
 *  A PRIVATE COMPANY IS A CERTIFICATE. `certificateBreakdown` counts every OPEN private its owner holds, and
 *  a successful exchange CLOSES the M&H. So the ordinary case is a one-for-one replacement -- one card out,
 *  one card in -- and the naive test "does this player's count plus one exceed the limit" would refuse a
 *  player sitting exactly ON the limit for a move that does not change their count at all. That refusal would
 *  be wrong in the one situation the power is most wanted.
 *
 *  SO THE PROJECTION IS THE WHOLE TEST. `applyPrivateExchange` is asked for the board the exchange produces
 *  -- the same function the arm applies, not a model of it -- and the canonical breakdown is read off THAT.
 *  Closing the M&H removes its card; the arriving NYC 10% is added as `counted` or as `exempt` exactly as the
 *  zone rules say (#7: Yellow, Orange and Brown certificates do not count, and a private never can because it
 *  has no price and therefore no zone).
 *
 *  AN ALREADY-ILLEGAL BOARD GETS NO LOOPHOLE. The comparison is on the PROJECTED counted total against the
 *  limit, so a player already over it is refused unless the exchange itself brings them back within it --
 *  which is conformity, not an escape. The Batch-5 divestment debt is deliberately NOT reused: that is
 *  #759 rule (iii)'s bar on BUYING and on passing, and an exchange is neither (see the header).
 *
 *  A ROOM SIZE THE PRINTED TABLE DOES NOT COVER HAS NO CEILING (`limit === null`), which is #526's answer and
 *  not this module's to invent. */
export function mhCertificateRefusal(
  state: GameStateResponse,
  request: MhExchangeRequest,
  companyId: number,
): string | null {
  const chart = chartContextFromState(state);
  const projected = applyPrivateExchange(state, {
    ok: true,
    privateId: request.private_id,
    companyId,
    ticker: MH_EXCHANGE_TICKER,
    player: request.player,
    source: request.source,
  });
  const after = certificateBreakdown(
    request.player,
    projected,
    chart.marketPricesByCompany ?? null,
    chart.zoneForPrice,
  );
  if (after.limit === null || after.counted <= after.limit) return null;
  return (
    `That would leave you at ${after.counted} certificates against a limit of ${after.limit} — ` +
    `closing the ${privateFor(state, request.private_id)?.name ?? "private"} does not free enough room. ` +
    `Shares priced in the Yellow, Orange or Brown zones do not count.`
  );
}

/** Why this M&H exchange may not happen against this board, or `null`.
 *
 *  ONE PREDICATE, THREE ASKERS: ingress (`turnRefusal`), the reducer's arm, and the settlement of a queued
 *  request. #784's rule -- one refusal, every surface -- and here it is also what makes "queuing vests
 *  nothing" true by construction, because the settlement asks the identical question.
 *
 *  `actor` is the AUTHENTICATED sender where one is known (`ctx.actor`, the server's socket identity).
 *  `null`/`undefined` means "this caller cannot say", which is the solo-play and bare-harness case (#549b),
 *  and the ownership rule below still binds the message's own `player` to the private's owner.
 *
 *  THE HOLDS ARE NOT HERE -- see the header. The window rule below is the round, not the seat: whether the
 *  request executes now or waits is `mhExchangeDisposition`'s question, deliberately separate, because a
 *  request that must wait is still a LEGAL request. */
export function mhExchangeRefusal(
  state: GameStateResponse,
  request: MhExchangeRequest,
  actor?: string | null,
): string | null {
  /* ---- the private ------------------------------------------------------------------------- */
  if (request.private_id !== MH_PRIVATE_ID) {
    /* Design note #576: the Camden & Amboy's PRR share is a purchase bonus granted where the auction
       resolves, and the B&O private's grant is the B&O par -- neither is an exchange, and neither has ever
       been dispatched as one. The M&H is the only exchange in this game. */
    return "Only the Mohawk & Hudson can be exchanged for a share.";
  }
  const priv = privateFor(state, request.private_id);
  if (!priv) return "That private company is not in this game.";
  if (priv.closed) return `The ${priv.name} has already been exchanged or closed.`;
  /* A private a CORPORATION owns has no exchange: the power is the PLAYER's (p. 27, "a player owning the
     MH"), and `owner_protocol_id` is what says a corporation bought it (mutually exclusive with `owner`). */
  if (priv.owner_protocol_id !== null && priv.owner_protocol_id !== undefined) {
    return `The ${priv.name} belongs to a corporation; only a player can exchange it.`;
  }
  if (priv.owner === null || priv.owner !== request.player) {
    return `The ${priv.name} is not yours to exchange.`;
  }
  /* INGRESS PARITY, ASKED AGAIN HERE. `roomMessageRefusal` (#1249) binds the sender to the named owner at the
     socket; a forged or replayed message that reaches the reducer by another route must meet the same rule,
     or the reducer would be trusting a check it does not perform (#1184's shape, inverted). */
  if (actor !== null && actor !== undefined && actor !== request.player) {
    return `Only the ${priv.name}'s owner can exchange it.`;
  }

  /* ---- what it is exchanged FOR ------------------------------------------------------------- */
  const company = state.public_companies.find((entry) => entry.company_id === request.company_id) ?? null;
  if (!company) return "That corporation is not in this game.";
  if (company.ticker !== MH_EXCHANGE_TICKER) {
    return `The ${priv.name} exchanges for a ${MH_EXCHANGE_TICKER} certificate, not a ${company.ticker} one.`;
  }
  /* Design note #576: `keep_open` is the flag a grant that leaves its private OPEN would carry. The M&H's
     exchange CLOSES it (p. 27, "This action closes the MH"), so a message asserting otherwise is refused
     rather than obeyed -- a client must not be able to keep a private alive by setting a field. */
  if (request.keep_open === true) {
    return `The ${priv.name} closes when it is exchanged; it cannot be kept open.`;
  }
  if (request.source !== "Ipo" && request.source !== "Bank") {
    return "An exchange must name the IPO or the Bank Pool as its source.";
  }

  /* ---- the window (the ROUND; the turn is `mhExchangeDisposition`'s) ------------------------ */
  if (state.current_round_type !== "StockRound" && state.current_round_type !== "OperatingRound") {
    /* p. 27 names exactly two rounds. The private auction has no turns of the kind the rule speaks of (and
       the M&H may not even be owned yet), and a finished game has none at all. */
    return `The ${priv.name} can only be exchanged during a Stock Round or an Operating Round.`;
  }

  /* ---- what the exchange would leave behind -------------------------------------------------- */
  const sourceRefusal = mhSourceRefusal(company, request.source);
  if (sourceRefusal !== null) return sourceRefusal;
  const holding = mhHoldingRefusal(company, request.player, zoneOf(state, company.company_id));
  if (holding !== null) return holding;
  return mhCertificateRefusal(state, request, company.company_id);
}

/** Why a NEW request may not be recorded, or `null` -- `mhExchangeRefusal` plus the one-at-a-time rule.
 *
 *  Design note #1630b: THERE IS ONE M&H, SO THERE IS AT MOST ONE MEANINGFUL PENDING REQUEST. A second request
 *  while one stands is REFUSED rather than allowed to overwrite the first, and the reason is the source: a
 *  silent overwrite would let a second click change which pile the first request will draw from, which is the
 *  one thing R2 says belongs to the owner as a deliberate choice. Refusing is also the answer that survives a
 *  replay unchanged -- an overwrite would make the board depend on which of two entries the log holds last,
 *  which it does deterministically, but the rule would then be "the last click wins" and nobody asked for
 *  that. No cancel action is invented in this slice (U-35 owns the surface that would need one). */
export function mhExchangeRequestRefusal(
  state: GameStateResponse,
  request: MhExchangeRequest,
  actor?: string | null,
): string | null {
  const standing = state.pending_mh_exchange ?? null;
  if (standing !== null) {
    return "An M&H exchange request is already pending; it settles at the next legal opening.";
  }
  return mhExchangeRefusal(state, request, actor);
}

/* ---- 3. question B: execute now, or queue? ------------------------------------------------------ */

/** Whether a legal request executes at once or is recorded for the next boundary.
 *
 *  ==================================================================
 *   DESIGN NOTE 1630c: A TURN THAT HAS BEGUN IS UNDERWAY, WHETHER OR NOT ANYBODY HAS CLICKED
 *  ==================================================================
 *  The tempting shortcut is "has the seated player acted yet?" -- `turn_action_taken === false` and no
 *  `stock_turn_stage` would look like a gap between turns. IT IS NOT ONE. Those fields are cleared BY
 *  `advanceSeat` / `recordPass` as the next turn opens, so their falsity is the first moment of somebody
 *  ELSE'S turn, not a moment belonging to nobody. Treating it as "between turns" would let the M&H owner act
 *  inside another player's turn -- exactly what R1 forbids -- and would make the answer depend on how quickly
 *  that player moved.
 *
 *  THE SAME ON THE OPERATING SIDE, and with one more trap: the corporation's turn is underway until
 *  `advanceCorporation` actually moves the cursor, and it is the CORPORATION'S turn even when the M&H owner
 *  is its president. The rule is about the railroad's turn boundary, not about who presides -- so a president
 *  does not get to interject into their own corporation's turn any more than into anybody else's.
 *
 *  AND THERE IS NO THIRD ANSWER. A genuine externally-addressable between-turns state would execute
 *  immediately; this engine has none (see the header), so an honest implementation has two branches. If one is
 *  ever introduced, it belongs here and nowhere else. */
export function mhExchangeDisposition(
  state: GameStateResponse,
  request: MhExchangeRequest,
): MhExchangeDisposition {
  if (state.current_round_type !== "StockRound") return "queue";
  const seated = state.player_addresses[state.active_player_index] ?? null;
  return seated !== null && seated === request.player ? "execute" : "queue";
}

/* ---- 4. execution: one board, or none ----------------------------------------------------------- */

/** The board a successful exchange produces, or `null` when it does not apply.
 *
 *  ==================================================================
 *   DESIGN NOTE 1630d: THE SIX EFFECTS ARE ONE WRITE
 *  ==================================================================
 *  In order, and the order is the rule:
 *    1. the certificate leaves the SELECTED pile and arrives in the owner's hand;
 *    2. the M&H closes and its owner is released -- `applyPrivateExchange` does 1 and 2 in one object, which
 *       is what takes the private out of the powers panel, the ledger and the certificate count together;
 *    3. the float threshold is settled from the resulting distribution -- `applyFloatThreshold`, the SAME
 *       helper `BuyStock` calls, now shared (#1631) rather than copied;
 *    4. the presidency is settled by `settlePresidencies`, the canonical Stage-8.3 authority -- AFTER the
 *       float, for #596's reason: a change that both floats a corporation and crowns a president must resolve
 *       the float against the holdings that caused it, not against a board mid-transfer;
 *    5. nothing else moves. No seat, no pass streak, no Priority Deal, no purchase marker (R1);
 *    6. the caller clears the pending request, if this settled one.
 *
 *  ATOMIC BY CONSTRUCTION, not by care: every step is a pure function of the previous board, and the ONE
 *  refusal point is ahead of all of them. A caller handed `null` still holds the board it passed in, so there
 *  is no partial state in which a share has moved and the private is still open, or the private has closed
 *  and no share arrived. */
export function applyMhExchange(
  state: GameStateResponse,
  request: MhExchangeRequest,
  homeHexToAxial?: HomeHexToAxial,
): GameStateResponse | null {
  const company = state.public_companies.find((entry) => entry.company_id === request.company_id) ?? null;
  if (!company) return null;
  /* The physical check again, at the boundary that actually moves the certificate. `mhExchangeRefusal` has
     already asked it; this is the guard that makes the `Math.max(0, …)` clamp in `applyPrivateExchange`
     unreachable from THIS path whatever a future caller forgets. */
  if (mhSourceRefusal(company, request.source) !== null) return null;

  const exchanged = applyPrivateExchange(state, {
    ok: true,
    privateId: request.private_id,
    companyId: request.company_id,
    ticker: company.ticker,
    player: request.player,
    /* R2: the source the owner chose, never a substitution. */
    source: request.source,
    /* p. 27: the exchange CLOSES the M&H. Never `keep_open` -- the refusal above has already rejected a
       message that asked for it, and spelling `false` here means a future caller cannot inherit one. */
    keepOpen: false,
  });
  // `applyPrivateExchange` returns the board it was handed when the private is missing or closed.
  if (exchanged === state) return null;

  /* #1631: the float settlement, shared with `BuyStock`. Without a home-hex table the corporation still
     floats and simply gets no token -- #363's rule, unchanged and not re-decided here. */
  const floated = homeHexToAxial ? applyFloatThreshold(exchanged, homeHexToAxial) : exchanged;
  /* #1620/#1622: the canonical presidency authority, with its clockwise tie-break and its Scenario-D
     certificate exchange. NO SECOND SELECTOR LIVES IN THIS FILE. */
  return settlePresidencies(floated).state;
}

/** The board after `request` has been recorded as pending. Records INTENT and nothing else. */
export function withPendingMhExchange(
  state: GameStateResponse,
  request: MhExchangeRequest,
): GameStateResponse {
  const pending: PendingMhExchange = {
    player: request.player,
    private_id: request.private_id,
    company_id: request.company_id,
    source: request.source,
  };
  return { ...state, pending_mh_exchange: pending };
}

/* ---- 5. question C: settlement at a between-turns boundary -------------------------------------- */

/** What a standing request does at a boundary -- for a caller that wants to know before it acts, and for the
 *  tests, which should be able to assert the DECISION separately from the board it produces. */
export type MhSettlement =
  | { kind: "none" }
  | { kind: "executed"; state: GameStateResponse }
  | { kind: "retired"; reason: string };

/** Settle the standing request against the board as it now is.
 *
 *  ==================================================================
 *   DESIGN NOTE 1630e: REVALIDATION IS THE SECOND ASKING, NOT THE FIRST
 *  ==================================================================
 *  Everything the request depended on is asked again, of the CURRENT board, by the SAME predicate that
 *  admitted it: the M&H still open and still this player's, the chosen pile still holding an ordinary 10%,
 *  the resulting holding and certificate position still legal, the round still one the power belongs to.
 *
 *  THE FIRST 5-TRAIN IS THE CASE THIS EXISTS FOR (owner ruling, §0 and §5 of the brief). A corporation buys
 *  the first 5 during its Operating turn; Phase 5 closes every private immediately, the M&H included; at the
 *  next boundary this function finds `priv.closed` and RETIRES the request. The earlier click never vested
 *  the exchange, no NYC share moves, and the private is not resurrected. Nothing here special-cases the
 *  5-train: it falls out of asking the ordinary question again.
 *
 *  A RETIREMENT IS NOT A FAILED TURN. It clears the request and touches nothing else -- no seat, no streak,
 *  no Priority Deal, no purchase marker -- and the game continues into the next turn without pausing to ask
 *  the owner for a replacement choice and without switching to the other source (R2). */
export function mhSettlementFor(
  state: GameStateResponse,
  homeHexToAxial?: HomeHexToAxial,
): MhSettlement {
  const pending = state.pending_mh_exchange ?? null;
  if (!pending) return { kind: "none" };
  const request: MhExchangeRequest = {
    private_id: pending.private_id,
    company_id: pending.company_id,
    player: pending.player,
    source: pending.source,
  };
  /* The actor is the REQUESTER, re-bound to the private's current owner by the predicate itself: a request
     whose M&H has changed hands fails the ownership rule and retires. It is never transferred to the new
     owner -- the power was exercised by a player, not attached to the company. */
  const refusal = mhExchangeRefusal(state, request, pending.player);
  if (refusal !== null) return { kind: "retired", reason: refusal };
  const applied = applyMhExchange(state, request, homeHexToAxial);
  if (applied === null) {
    /* Unreachable behind the predicate above; retiring rather than holding keeps a malformed board from
       parking a request forever. */
    return { kind: "retired", reason: "The exchange could not be settled against the current board." };
  }
  return { kind: "executed", state: applied };
}

/** `mhSettlementFor`, as a board. Returns the state UNCHANGED (by identity) when nothing was pending, so a
 *  caller can put this on a hot path and skip on identity. */
export function settleMhExchange(
  state: GameStateResponse,
  homeHexToAxial?: HomeHexToAxial,
): GameStateResponse {
  const settlement = mhSettlementFor(state, homeHexToAxial);
  if (settlement.kind === "none") return state;
  const board = settlement.kind === "executed" ? settlement.state : state;
  return { ...board, pending_mh_exchange: null };
}
