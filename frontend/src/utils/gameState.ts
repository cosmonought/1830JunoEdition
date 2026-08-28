// frontend/src/utils/gameState.ts
//
// A hand-kept TypeScript mirror of `msg.rs`'s `QueryMsg::GetGameState` response shape, plus the polling
// hooks every dashboard panel shares instead of re-implementing its own query.
//
// Design note #1: hand-kept, not codegen -- there is no schema-derived TS type, so these fields must be
// kept in exact sync with `src/msg.rs` by hand. Same DESIGN GAP as every other contract mirror here.
//
// Design note #2: what this deliberately does NOT expose, because the backend does not either. `state.rs`
// genuinely models hardware/train inventory and route-tracing, but NO `QueryMsg` returns any of it. Every
// panel that would want it renders an honest "not yet exposed by the contract" state.
//
// Design note #4: polling, not a subscription -- CosmWasm has no browser-reachable push mechanism, so each
// hook re-fires on a fixed interval with a monotonic sequence guard that discards a stale response.
//
// Design notes #3/#6/#7 and #352/#379/#526/#544/#553/#656/#662: see `docs/ai_architecture/utils_layer.md`.

import { useCallback, useEffect, useRef, useState } from "react";

// Design note #526: the one printed-limits table.
import { certLimitForPlayers } from "./gameSetup";
import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";
import type { GameVariants } from "./gameVariants";

/* ------------------------------------------------------------------ */
/* Contract data mirror -- see design note #1                         */
/* ------------------------------------------------------------------ */

/** Hover text for the inline Priority Deal marker. Defined once and shared by every surface that renders
 *  it, so two panels cannot drift into explaining the same indicator two different ways -- which is exactly
 *  what happens when a tooltip string is retyped per call site. */
export const PRIORITY_DEAL_TOOLTIP = "Priority Deal: Starts the next Stock Round.";

export type TileColor = "Yellow" | "Green" | "Brown";
/** Pre-Game Waterfall Auction (`waterfall.rs`): every room genesis-starts here, before `"StockRound"` is
 *  ever reachable. Mirrors `state.rs`'s `RoundType` exactly. */
/** Design note #898: `GameEnd` is a ROUND, and putting it here is what makes the ending survive a replay.
 *  The game's end was previously a derivation in the shell -- "is the bank at zero right now" -- which had no
 *  way to express "and the current set finishes first", and no way to be undone. A terminal round type is a
 *  fact the log produces, so every client reaches it at the same action. */
export type RoundType = "WaterfallAuction" | "StockRound" | "OperatingRound" | "GameEnd";

export interface PlayerCashEntry {
  player: string;
  cash_vgp: string;
}

/** Omitted entirely from `PublicCompanyState.player_holdings` for any
 *  player holding exactly 0% -- mirrors `src/msg.rs`'s own doc comment on
 *  `PlayerShareEntry`. */
export interface PlayerShareEntry {
  player: string;
  percentage: number;
}

export interface PublicCompanyState {
  company_id: number;
  ticker: string;
  is_floated: boolean;
  treasury: string;
  total_shares_issued: number;
  par_value: string | null;
  /** Total revenue this corporation's trains earned on their most recent run. Written on EVERY run, paid out
   *  or withheld alike, and reset to zero by a run that found no legal route -- so it always reads as "what it
   *  earned last time", never a stale high-water mark.
   *  Optional because a contract predating the field returns no key, and `undefined` must stay distinguishable
   *  from a real `"0"`: the first means "this build cannot tell you", the second "it earned nothing". */
  last_route_revenue?: string;
  /* ==================================================================
      DESIGN NOTE 941: THE PRINTED SUM, KEPT BECAUSE THE ROLL IS ON THE TOTAL
     ==================================================================
     RULED: one die per corporation's turn, "applied to the total aggregated printed revenue of all trains
     combined".
     WHICH THE ARM CANNOT DO FROM `last_route_revenue` ALONE. That field holds the MODIFIED figure, and the
     modification is lossy -- #938 rounds to the nearest ten, so $77 and $80 and $84 all become $80 and no
     amount of arithmetic recovers the printed total from it. A turn's second train therefore has nothing to
     add to.
     SO THE RAW SUM IS KEPT BESIDE IT. Each `RunManualRoute` adds this train's printed value here, then
     recomputes `last_route_revenue` as the turn's one roll applied to the WHOLE of it. That makes every
     dispatch produce the correct aggregate for the trains run so far, with no train needing to know whether
     it is the last -- which is the only way this works over a loop the reducer cannot see the end of.
     OPTIONAL, AND #232'S RULE APPLIES: `undefined` means "this build does not report it", never "zero".
     Turn-scoped, and cleared beside `last_route_revenue` by #777's turn-change rule. */
  printed_route_revenue?: string;
  president: string | null;
  ipo_pool_percentage: number;
  bank_pool_percentage: number;
  player_holdings: PlayerShareEntry[];
  /** Station Tokens (`hexmap.rs` module doc comment #23): this company's
   *  preprinted home hex label (e.g. `"H12"`), or `null` for the one core
   *  company with none assigned on this custom board (NNH). Mirrors
   *  `msg.rs::PublicCompanyState.home_hex_label` exactly. */
  home_hex_label: string | null;
  /** `(q, r)` pairs, home hex first (if granted, via `grant_home_station_token`
   *  at float) -- mirrors `msg.rs::PublicCompanyState.station_token_hexes`
   *  exactly. Empty before this company floats. */
  station_token_hexes: Array<[number, number]>;
  /* Design note #560: A HEX IS NOT A CITY. `station_token_hexes` is `(q, r)` and cannot express which of a
     two-city hex holds a token -- ERIE's home, New York and every OO tile carry two -- so the renderer falls
     back to a heuristic, and the heuristic picks the first slot every time for every corporation.
     So the answer the player gave is recorded. `hexContractTypes.ts` has declared this field since #134 and
     the renderer already PREFERS it; nothing on this side ever wrote it, so the preference never had anything
     to prefer.
     OPTIONAL, with three distinguishable states: absent means "this chain predates G-12, use the heuristic";
     an entry means "this slot, definitively"; a hex in `station_token_hexes` with no entry means the same as
     absent for that token. What it must never mean is "no token" -- which is why the two arrays are written
     together and never one without the other. */
  station_tokens?: Array<[number, number, number]> | null;
  /** This company's total Station Token limit, home token included -- see
   *  `hexmap::station_token_limit`. Mirrors `msg.rs::PublicCompanyState.
   *  station_token_limit` exactly. */
  station_token_limit: number;
  /** Audit G-15c: the MODEL of every train this corporation owns, e.g. `["2", "2", "4"]` -- duplicates are
   *  meaningful. OPTIONAL, and the optionality carries meaning the UI must respect: `undefined` means a
   *  contract predating the field, i.e. UNKNOWN, not "owns nothing". Conflating the two would grey out every
   *  train on every corporation against an older chain and make trading look broken rather than unsupported. */
  owned_trains?: string[] | null;
  /** Design note #903: how many trains this corporation has already run THIS turn. It exists to give each
   *  train its own die under Unpredictable Revenue -- two 4-trains are two runs and may roll differently, and
   *  keying the roll by train MODEL would hand both the same face.
   *  Turn-scoped, and cleared beside `last_route_revenue` by the same turn-change rule (#777). */
  routes_run_this_turn?: number;
  /** Design note #906: trains under Gentle Rust that are living on borrowed time.
   *
   *  NOT IN `owned_trains`, and that is the whole mechanism: every surface that counts a corporation's trains
   *  counts that array, so moving a doomed train here is what implements the ruling that a pending-rust train
   *  occupies no train-limit slot -- without a single one of those surfaces learning a new rule.
   *  They still RUN. `settleRoundTransitions` clears them at the end of that corporation's next Operating
   *  Round turn (#906a), which is after its revenue has been recorded. */
  pending_rust_trains?: readonly string[];
}

export interface PrivateCompanyState {
  private_id: number;
  name: string;
  cost: string;
  revenue_per_or: string;
  owner: string | null;
  /** Phase-Gated Corporate Purchase Protocol (`trading.rs` module doc
   *  comment #17): the `company_id` this private is owned by, if a
   *  corporation bought it -- mutually exclusive with `owner`. Mirrors
   *  `msg.rs::PrivateCompanyState.owner_protocol_id` exactly. */
  owner_protocol_id: number | null;
  /** Whether this private has been permanently closed (B&O Special Closure
   *  or Phase 5 Private Closure -- `hardware.rs` module doc comments
   *  #11/#12). A closed private can never be bought or sold again. Mirrors
   *  `msg.rs::PrivateCompanyState.closed` exactly. */
  closed: boolean;
}

/** A corporation's standing offer for a private company -- design note #662. Snake_case to match everything
 *  else on `GameStateResponse` even though no contract sends it: a reader scanning this object should not
 *  have to work out which fields came off the wire from their casing. */
export interface PrivatePurchaseOffer {
  private_id: number;
  /** Carried, not re-derived, so every client's prompt names what the buyer
   *  was looking at. */
  private_name: string;
  /** The wallet whose consent is required. */
  owner: string;
  buyer_protocol_id: number;
  buyer_ticker: string;
  price: number;
}

/** Design note #701: the train-trade offer awaiting the seller president's answer. The train equivalent of
 *  `PrivatePurchaseOffer`, and here for the same reason: a proposal is something the OTHER player has to see,
 *  and the sandbox's shared state is the only thing both clients hold.
 *  Sandbox-only. Online the contract keeps a real offer register and `GetTrainOffers` reaches the counterparty
 *  already -- which is why this went unnoticed for so long. Both paths render the same prompt, and only one of
 *  them had a register behind it. */
export interface TrainPurchaseOffer {
  seller_protocol_id: number;
  seller_ticker: string;
  seller_president: string | null;
  buyer_protocol_id: number;
  buyer_ticker: string;
  model_type: string;
  /** String, matching the contract's `Uint128` -- see `ProposeTrainPurchaseMsg`. */
  price: string;
}

export interface GameStateResponse {
  game_id: number;
  creator: string;
  is_active: boolean;
  total_juno_pool: string;
  virtual_bank_vgp: string;
  virtual_bank_start: string;
  max_players: number;
  player_addresses: string[];
  /** Index into `player_addresses` -- whose turn it currently is. Advanced
   *  by `ExecuteMsg::PassTurn`. */
  active_player_index: number;
  /** Real field, but per `state.rs`'s own doc comment currently static `0` for every room -- nothing yet
   *  reassigns it during play on chain. The SANDBOX reassigns it at the end of a Stock Round
   *  (`sandboxSession.ts #353`), which is the rule the contract will apply when it implements its own half. */
  priority_deal_index: number;
  /* SANDBOX-ONLY FIELDS. Neither comes off the wire: `GetGameState` does not report them and a live room
     leaves them `undefined`, which every reader treats as "not applicable" rather than as a value. They live
     on the state object rather than in module scope because the undo snapshot copies the state and cannot
     copy a closure (#352). Marked optional rather than added to the mirror, so nothing here can be mistaken
     for a field the chain will one day send.
     Design note #352: the seat that last bought or sold this Stock Round, for the Priority Deal handover. */
  last_trader_index?: number | null;
  /** Design note #353: set for one dispatch when a full round of passes
   *  closed the Stock Round, so the shell can log the handover and move to
   *  the Operating Round. Consumed and cleared by the caller. */
  stock_round_just_ended?: boolean;
  /** Design note #411: the mirror of `stock_round_just_ended` for the other
   *  direction -- set for one dispatch when the last corporation in the
   *  operating queue finished its turn and the macro round closed. Consumed
   *  and cleared by the caller, which owns the log and the tab. */
  operating_round_just_ended?: boolean;
  /** Design note #899: the room is closed and the payout has been dispatched.
   *
   *  IN STATE RATHER THAN IN THE SHELL because it is what makes `CloseRoom` idempotent: every client runs its
   *  own auto-close timer and every one of them dispatches, so the reducer has to be able to tell the first
   *  from the fourth. A flag the shell held would make each client's answer its own.
   *  NOT `?? false` ANYWHERE IT IS WRITTEN BACK -- #232's rule and #897's correction. Absent means an older
   *  log that predates room closure, which is a different thing from a room that is open. */
  room_closed?: boolean;
  /** Design note #902: the house rules this game is being played under, recorded at setup so a replay uses
   *  the same ones. Absent on every game logged before variants existed, which `resolveVariants` reads as the
   *  standard game. */
  variants?: Partial<GameVariants>;
  /** Design note #904a: whether the private company auction has concluded.
   *
   *  Written by the one transition that closes it (`OpenStockRound`), so it is true from the first Stock
   *  Round of a standard game and stays false through SR1 and SR2 of a delayed-auction game. It is what the
   *  B&O lock asks -- see `boIsLocked` for why the auction and not the round number.
   *  ABSENT MEANS COMPLETE, for logs written before the field existed: those are standard games whose auction
   *  did happen, and reading absence as "incomplete" would lock the B&O across every historical replay. */
  private_auction_complete?: boolean;
  /** Design note #656: WHICH STEP of its turn the acting corporation is on. This was React state in `App.tsx`
   *  re-seeded by an effect keyed on the era and phase tier -- so buying a train that advanced the phase sent
   *  the buying corporation back to the top of its own turn. A cursor held outside the reducer is also not in
   *  the action log, so a client that joined or undid mid-turn rebuilt every treasury exactly and then showed
   *  whichever step its own effect seeded. Same split #642 found one layer down.
   *  Sandbox-only: a live room leaves it `undefined` because the CONTRACT owns the cursor there (`or_phase`,
   *  and `WrongOperatingSubPhase` when a client disagrees). Readers treat `undefined` as "ask the opening
   *  rule", never as a step. */
  operating_sub_phase?: OperatingSubPhase;
  /** Design note #662: the private-company purchase awaiting its owner's answer. On the STATE rather than in
   *  a React ref because a proposal is something the other player has to see, and the sandbox's shared state
   *  is the only thing both clients hold -- it was a ref in `App.tsx`, so the seller was never asked and the
   *  buyer answered their own offer.
   *  Sandbox-only: the contract's `BuyPrivateCompany` is single-party (it reads `private.owner` and never
   *  consults them), so there is no chain-side offer for this to mirror. */
  private_purchase_offer?: PrivatePurchaseOffer | null;
  /** Design note #701: the train-trade offer awaiting its seller's answer. Sandbox-only, for the reason on
   *  `TrainPurchaseOffer` -- online this lives in the contract's offer register. */
  train_purchase_offer?: TrainPurchaseOffer | null;
  /** Design note #723: every hex whose TERRAIN FEE has already been charged, as `"q,r"` keys.
   *
   *  In state rather than derived from the tile grid, because the grid is a separate atom that this reducer
   *  does not own and cannot replay. During an Undo rebuild the log is replayed while `mapGrid` is a React
   *  value captured at render, so asking it "does this hex have a tile" answers about a board from some other
   *  moment -- charging every hex again, or nothing at all, depending on where the render landed. A fact the
   *  reducer must decide has to travel in the state the reducer replays.
   *
   *  A hex appears here IF AND ONLY IF its fee has been paid, so a lay on clear ground adds nothing: the
   *  question is "has this ground been paid for", not "has anything been built here". */
  terrain_fees_paid?: readonly string[];
  /** Design note #744: per player, the corporations they have SOLD in the current Stock Round -- and may
   *  therefore not buy back until the next one.
   *
   *  IN STATE FOR #723'S REASON: the Undo path replays the whole log, so a rule about "what has happened this
   *  round" has to be a function of the log rather than of anything a client remembers. Cleared when a Stock
   *  Round opens, which is the only event that ends the lockout. */
  sold_this_round?: Readonly<Record<string, readonly number[]>>;
  /** Design note #745: has the seat now acting already DONE something this turn? True after a sale, false
   *  again the moment the seat moves.
   *
   *  IT IS A SEPARATE FIELD FROM `sold_this_round` BECAUSE THE TWO HAVE DIFFERENT LIVES. #744's record lasts
   *  the whole round on purpose -- that is what makes the buy-back lockout a lockout. This one must expire at
   *  the end of the turn that set it, or a player who sold on their first turn would never be able to pass at
   *  all: every later Pass would be read as "they acted", and the Stock Round would not end.
   *
   *  IN STATE FOR #723'S REASON, like #744's: Undo replays the log, so anything the reducer must decide
   *  travels in the state the reducer replays. */
  turn_action_taken?: boolean;
  consecutive_passes: number;
  current_global_era: TileColor;
  /** Operating Round Corporation Turn Queue -- `company_id`s in turn order. */
  active_operating_order: number[];
  active_corporation_index: number;
  current_round_type: RoundType;
  macro_round_number: number;
  sub_round_index: number;
  operating_round_sequence_length: number;
  player_cash: PlayerCashEntry[];
  public_companies: PublicCompanyState[];
  private_companies: PrivateCompanyState[];
}

/** The seat that should be holding the controls right now, given the phase. Two pointers answer "who acts
 *  next" in 1830 and which is correct depends entirely on the round: the Waterfall Auction and Stock Round
 *  are SEAT-driven, so `active_player_index` is the answer directly; Operating Rounds are
 *  CORPORATION-driven, and the seat pointer is not meaningful there and can easily point at a player with
 *  nothing to do.
 *  Returns `null` when the acting seat cannot be resolved. Callers should leave the seat where it is rather
 *  than guess. */
export function actingSeatIndex(state: GameStateResponse): number | null {
  if (state.player_addresses.length === 0) return null;

  if (state.current_round_type === "OperatingRound") {
    const companyId = state.active_operating_order[state.active_corporation_index];
    if (companyId === undefined) return null;
    const company = state.public_companies.find((c) => c.company_id === companyId);
    const president = company?.president;
    if (!president) return null;
    const seat = state.player_addresses.indexOf(president);
    return seat === -1 ? null : seat;
  }

  return state.active_player_index;
}


/* Design note #544: A MINI-AUCTION SUSPENDS THE TURN ORDER. `actingSeatIndex` returns
   `active_player_index` during the auction, and that field is right about the WATERFALL and knows nothing
   about a contest running on top of it -- the contest's cursor lives on a different document, on a
   different atom, fetched by a different query. So the two halves of the screen each read a pointer that
   was correct about a different question, and neither was wrong on its own terms.
   THE SUSPENSION IS THE WHOLE RULE: while a contest is live the main rotation does not advance and nobody
   may take a waterfall action -- the reducer has preserved `waterfall.current_turn` across a contest since
   #338 precisely so it can be resumed untouched, which makes it a STALE pointer for the duration.
   WHY AN ADDRESS AND NOT A SEAT INDEX: a bidder is identified by address, and mapping back only to have
   callers map forward again would add a lookup that can fail to a path that currently cannot.
   `actingSeatIndex` IS LEFT ALONE -- it answers a narrower question, and widening it would thread the
   waterfall document through callers that have no business knowing an auction exists. */
export function actingAddress(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
): string | null {
  const contest =
    state.current_round_type === "WaterfallAuction" ? waterfall?.mini_auction : null;
  if (contest) return contest.current_turn || null;

  const seat = actingSeatIndex(state);
  if (seat === null) return null;
  return state.player_addresses[seat] ?? null;
}

/** Whether `address` is shut out of the contest currently running -- a seat at the table who is not one of
 *  its bidders. `false` whenever no mini-auction is live, because there is then nothing to be excluded from.
 *  `ContextualActionBar #545`: states a real fact about the game rather than a visual one -- these players
 *  cannot act, and cannot be acted for, until the contest resolves. */
export function isSidelinedByMiniAuction(
  state: GameStateResponse,
  waterfall: WaterfallStateResponse | null,
  address: string,
): boolean {
  const contest =
    state.current_round_type === "WaterfallAuction" ? waterfall?.mini_auction : null;
  if (!contest) return false;
  return !contest.bidders.includes(address);
}


/** `QueryMsg::PlayerNetWorth`'s response -- mirrors
 *  `msg.rs::PlayerNetWorthResponse` exactly. See design note #6. */
export interface PlayerNetWorthResponse {
  game_id: number;
  player: string;
  cash_vgp: string;
  stock_portfolio_value: string;
  net_worth: string;
}

/** Structural query-client shape -- same pattern as
 *  `HexGridRenderer.tsx`'s `QueryCapableClient` (design note #7 there),
 *  re-declared locally rather than imported so this utils file has no
 *  dependency on a specific component. */
export interface QueryCapableClient {
  queryContractSmart(contractAddress: string, queryMsg: Record<string, unknown>): Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* Derived helpers -- see design note #3                              */
/* ------------------------------------------------------------------ */

/** EXACT certificate count for `playerAddress`. Renamed from `estimateCertificateCount`, and the "~N"
 *  presentation went with it: the name was inherited from a pass where the president's-certificate rule was
 *  unconfirmed and the count really was a guess. That rule is now confirmed against three independent
 *  sources (design note #3) and every input is queryable exact state. Nothing here approximates anything.
 *  Equivalent to `(total public % / 10) - presidencies held + privates held`: a president's 20% share is a
 *  single physical certificate, so it counts once rather than twice.
 *  The one thing it cannot do is see a certificate the QUERIES do not expose -- but no such certificate
 *  exists in the current schema, so that is a statement about future changes, not present accuracy. */
/** Design note #734: THE ZONE-BLIND COUNT, and it is no longer what any surface displays.
 *
 *  Kept because `presidencyTransfer` reasons about it -- a presidency changing hands moves no percentages, so
 *  a physical-card count is the right instrument for asserting that -- and because `certificateBreakdown`'s
 *  `total` is defined as what this returns.
 *
 *  NOT FOR A LIMIT. A certificate limit is measured against `certificateBreakdown(...).counted`, which knows
 *  about the yellow/orange/brown exemptions (#712). This function does not and never did; the Player Card read
 *  it for a limit and told players they were full when they were not. If you are about to compare this to
 *  `certLimitForPlayers`, you want the breakdown instead. */
export function certificateCount(playerAddress: string, state: GameStateResponse): number {
  let count = 0;
  for (const priv of state.private_companies) {
    // Design note #736: a CLOSED private is off the board and off the limit. It was still being counted.
    if (priv.closed) continue;
    if (priv.owner === playerAddress) count += 1;
  }
  for (const pub of state.public_companies) {
    const holding = pub.player_holdings.find((h) => h.player === playerAddress);
    if (holding && holding.percentage > 0) {
      if (pub.president === playerAddress) {
        // The president's 20% certificate is a single physical card and
        // counts as exactly 1 certificate -- see design note #3. Anything
        // held beyond that 20% is ordinary 10% certificates, each still
        // counting as 1.
        const presidentCertificate = 1;
        const remainderPercentage = Math.max(0, holding.percentage - 20);
        count += presidentCertificate + Math.ceil(remainderPercentage / 10);
      } else {
        count += Math.max(1, Math.ceil(holding.percentage / 10));
      }
    }
  }
  return count;
}

/* Design note #526: the local copy is GONE. It carried a doc comment saying "mirrors `RulesReference`'s
   table" -- a correctness requirement enforced by a sentence, the arrangement TD-1 catalogued and #507 hit
   again. `utils/gameSetup.ts` is the one table now; a third copy is what this delegation exists to avoid. */

/** How many certificates a player may hold, given the room's size.
 *  `null` for a player count the printed table does not cover, so a caller
 *  renders "--" rather than inventing a ceiling. */
export function certificateLimit(state: GameStateResponse): number | null {
  return certLimitForPlayers(state.player_addresses.length);
}

export interface CertificateBreakdown {
  /** Certificates that count against the limit. */
  counted: number;
  /** Certificates held in a Yellow, Orange or Brown zone corporation, which
   *  are exempt from the limit. */
  exempt: number;
  /** `counted + exempt` -- what `certificateCount` returns. */
  total: number;
  /** The room's ceiling, or `null` if the player count is off the table. */
  limit: number | null;
}

/* Design note #7: THE CERTIFICATE LIMIT EXEMPTION. Shares priced in the Yellow, Orange or Brown zone do not
   count toward the limit -- a MARKET-POSITION rule, not an ownership one: the same certificate counts today
   and stops counting tomorrow if the price moves, with nothing about the certificate changing.
   WHY THE ZONE ARRIVES AS A CALLBACK: the table lives in `StockMarketRenderer.tsx` and `utils/` may not
   import from `components/`. Taking it as a parameter keeps that boundary intact AND keeps this pure and
   testable, rather than copying the price-to-zone table where it could drift from the board.
   OMITTING THE CALLBACK IS A VALID CALL, not a degraded one -- the caller has no market data, everything is
   counted, and that is the correct conservative answer. PRIVATE COMPANIES ARE NEVER EXEMPT: no price, no
   zone. */
export function certificateBreakdown(
  playerAddress: string,
  state: GameStateResponse,
  /** Live market price per `company_id`. Omit when unknown. */
  marketPrices?: Readonly<Record<number, number | null>> | null,
  /** Price -> zone. Pass `marketZoneForPrice`; see design note #7 for why
   *  this is injected rather than imported. */
  zoneForPrice?: (price: number | null | undefined) => string | null,
): CertificateBreakdown {
  let counted = 0;
  let exempt = 0;

  for (const priv of state.private_companies) {
    /* Design note #736: likewise here, and this is the half the report saw -- "the private companies are
       still displayed (and counting toward certificates)". `playerPrivateCompanies` already filtered closed
       ones out of the DISPLAY list, so the two disagreed the moment anything set the flag. */
    if (priv.closed) continue;
    if (priv.owner === playerAddress) counted += 1;
  }

  for (const pub of state.public_companies) {
    const holding = pub.player_holdings.find((h) => h.player === playerAddress);
    if (!holding || holding.percentage <= 0) continue;

    // Same physical-card arithmetic as `certificateCount` -- the
    // president's 20% is ONE card, the rest are 10% cards.
    const cards =
      pub.president === playerAddress
        ? 1 + Math.ceil(Math.max(0, holding.percentage - 20) / 10)
        : Math.max(1, Math.ceil(holding.percentage / 10));

    const zone =
      marketPrices && zoneForPrice ? zoneForPrice(marketPrices[pub.company_id]) : null;
    if (zone === "Yellow" || zone === "Orange" || zone === "Brown") exempt += cards;
    else counted += cards;
  }

  return { counted, exempt, total: counted + exempt, limit: certificateLimit(state) };
}

/** `"4 (+2 exempt) / 13"`, or `"4 / 13"` when nothing is exempt, or
 *  `"4"` when the room size has no printed limit. One formatter so the
 *  Player Index and the Game Ledger cannot render the same fact two ways. */
export function formatCertificateCount(breakdown: CertificateBreakdown): string {
  const head =
    breakdown.exempt > 0
      ? `${breakdown.counted} (+${breakdown.exempt} exempt)`
      : `${breakdown.counted}`;
  return breakdown.limit === null ? head : `${head} / ${breakdown.limit}`;
}

/** Every public company `playerAddress` currently holds any nonzero share
 *  of, paired with that holding -- the building block for a Financial
 *  Ledger "certificate tree" (see `FinancialLedger.tsx`). */
export function playerCompanyHoldings(
  playerAddress: string,
  state: GameStateResponse,
): Array<{ company: PublicCompanyState; percentage: number }> {
  const holdings: Array<{ company: PublicCompanyState; percentage: number }> = [];
  for (const company of state.public_companies) {
    const holding = company.player_holdings.find((h) => h.player === playerAddress);
    if (holding && holding.percentage > 0) {
      holdings.push({ company, percentage: holding.percentage });
    }
  }
  return holdings;
}

/* Design note #497: THE LEDGER SAID "NOT CONNECTED" TO ITS OWN DATA. The gate is
   `queryClient && contractAddress && gameId`, and a sandbox has none of the three -- so both money columns
   fell to the placeholder for the whole of offline mode, on the screen whose job is to total up what
   everybody owns.
   `FinancialLedger #4` was why, and it was right WHEN WRITTEN: reproducing the figure would have meant a
   second query plus duplicating the backend's valuation math, or substituting par for market price. THE
   PREMISE EXPIRED -- `marketGrid` is a prop of that panel now and is already unpacked into a price map, so
   the live prices are sitting in the same function that printed "not connected".
   Design note #497a: AN ESTIMATE THAT KNOWS IT IS ONE. This does not replace `PlayerNetWorth`; the chain's
   figure stays authoritative and the caller prefers it. What this replaces is the BLANK -- and the two can
   legitimately differ, so a client-side total presented as authoritative would be the "silently
   substituting" failure wearing a different hat.
   `null` PROPAGATES rather than being coerced to zero: an unknown portfolio value is not a zero one, and
   reporting "$0 net worth" for someone holding five certificates is worse than reporting nothing. */

/** One 1830 certificate is 10% of a corporation, and a market price is
 *  quoted per certificate -- so a 30% holding is three certificates at that
 *  price. Named rather than inlined as `/ 10`, because the divisor is a rule
 *  rather than an arithmetic convenience. */
const PERCENT_PER_CERTIFICATE = 10;

/** What `playerAddress`'s shares are worth at live market prices, or `null` when any corporation they hold
 *  has no price to value them at. Keyed by `company_id`, exactly as `FinancialLedger`'s own map is. */
/** What one 10% certificate of this corporation is worth, and therefore what it would sell for.
 *
 *  Design note #711: AN UNPARRED SHARE IS WORTH $0, NOT "UNKNOWN".
 *
 *  REPORTED: "if a share has no market price it is unsellable, so it should either be excluded or count as
 *  $0 -- and the only case in which this can ever happen is the 10% PRR share granted by the private company
 *  before PRR pars/sells its President's Share. Regarding Net Worth: unsellable shares ... are effectively
 *  worth $0."
 *
 *  THAT IS THE FACT THE OLD CODE WAS MISSING: a corporation acquires a price the moment its President's Share
 *  is sold at a par. So "no price" is not a gap in what this client knows, it is a statement about the board
 *  -- nobody has parred the corporation, its shares cannot be sold to anyone at any figure, and $0 is the
 *  answer rather than a refusal to answer. In practice it happens once per game, to the certificate a private
 *  company grants.
 *
 *  PARRED, NOT FLOATED, and the distinction is the one #562a already had to make from the other side: "a
 *  started-but-unfloated corporation sits at its par position and its shares sell perfectly well". Floating is
 *  about how many shares have sold; pricing happens at the par, before any of that.
 *
 *  SO THE THREE READINGS COLLAPSE INTO ONE LADDER. `estimateStockPortfolioValue` returned `null` on an unknown
 *  price; #566 added a par fallback for the card only, on the grounds that "a corporation whose president has
 *  set a par but whose token is not yet on the chart is not unpriced"; and the Ledger kept the stricter
 *  reading. All three were circling the same ladder -- market, then par, then nothing to sell -- and the
 *  disagreement was only about where it stopped.
 *
 *  WHICH RETIRES #566's SPLIT. There is no longer a looser reading and a stricter one for the two surfaces to
 *  choose between, because par is not a fallback: it is the price, whenever the chart has not moved off it. */
export function sharePriceFor(
  company: PublicCompanyState,
  marketPrices: Readonly<Record<number, number | null>>,
): number {
  const market = marketPrices[company.company_id];
  if (market != null && Number.isFinite(market)) return market;
  const par = Number(company.par_value ?? NaN);
  if (Number.isFinite(par) && par > 0) return par;
  // Unparred: no IPO price, no chart position, no buyer. Design note #711.
  return 0;
}

export function estimateStockPortfolioValue(
  playerAddress: string,
  state: GameStateResponse,
  marketPrices: Readonly<Record<number, number | null>>,
): number {
  let total = 0;
  for (const holding of playerCompanyHoldings(playerAddress, state)) {
    /* Design note #711: no `null` branch any more. It read "unknown price, unknown total ... an under-report
       is indistinguishable from a correct smaller number", which is sound reasoning about a MISSING FIGURE and
       was being applied to a share that has no value. Counting it as zero is not under-reporting; it is the
       report. */
    total += (holding.percentage / PERCENT_PER_CERTIFICATE) * sharePriceFor(holding.company, marketPrices);
  }
  return total;
}

/** Liquid cash plus portfolio value, or `null` when the player's CASH is unknown -- which is now the only
 *  thing that can make this unanswerable (design note #711). */
export function estimatePlayerNetWorth(
  playerAddress: string,
  state: GameStateResponse,
  marketPrices: Readonly<Record<number, number | null>>,
): { stockValue: number; netWorth: number } | null {
  const stockValue = estimateStockPortfolioValue(playerAddress, state, marketPrices);
  const entry = state.player_cash.find((row) => row.player === playerAddress);
  const cash = Number(entry?.cash_vgp ?? NaN);
  // No cash record is not zero cash -- a player the state has not reported is not a player with nothing.
  if (!Number.isFinite(cash)) return null;
  return { stockValue, netWorth: cash + stockValue };
}

/* Design note #379: A PRIVATE CAN BELONG TO A COMPANY, NOT A PLAYER. `PrivateCompanyState` has carried
   both owners since the schema was written -- `owner` for a player, `owner_protocol_id` for a corporation,
   mutually exclusive per its own doc comment -- and every reader in the app looked only at `owner`. So the
   moment a private crossed from a player to a company it left the seller's ledger row and arrived nowhere:
   it paid revenue to a treasury (#329) that no surface attributed to it.
   ONE HELPER, so the ledger column and the Operating Round strip cannot disagree about what a corporation
   owns. CLOSED PRIVATES ARE EXCLUDED -- a closed company is off the board, pays nothing, and listing it
   would show an asset the corporation no longer has. */
export function corporationPrivateCompanies(
  companyId: number,
  state: GameStateResponse,
): PrivateCompanyState[] {
  return state.private_companies.filter(
    (priv) => !priv.closed && priv.owner_protocol_id === companyId,
  );
}

/** Every private `playerAddress` currently owns -- the other half of a certificate tree. Includes closed
 *  privates still on this player's own ledger; use the sellable list below when the goal is specifically
 *  what a corporation could still buy from them. */
export function playerPrivateCompanies(
  playerAddress: string,
  state: GameStateResponse,
): PrivateCompanyState[] {
  /* Design note #736: CLOSED ONES ARE OFF THE BOARD, and this list is what the Player Card and the Ledger
     render. Its corporate twin `corporationPrivateCompanies` has excluded them since it was written -- "a
     closed company is off the board, pays nothing, and listing it would show an asset the corporation no
     longer has" -- and every word of that applies to a player. The two disagreed only because nothing ever
     set `closed`, so the asymmetry was invisible until #736 made the flag real. */
  return state.private_companies.filter((p) => !p.closed && p.owner === playerAddress);
}

/** Every private `playerAddress` owns AND could still sell via `BuyPrivateCompany` -- the list above minus
 *  any already `closed`. A closed private permanently rejects `execute_buy_private_company` (`trading.rs`
 *  module doc #17), so offering one would just produce a guaranteed-failing tx. The Buy Private Company
 *  tray uses this, not the plain list. */
export function playerSellablePrivateCompanies(
  playerAddress: string,
  state: GameStateResponse,
): PrivateCompanyState[] {
  return state.private_companies.filter((p) => p.owner === playerAddress && !p.closed);
}

/* ------------------------------------------------------------------ */
/* Polling hook -- see design note #4                                 */
/* ------------------------------------------------------------------ */

export interface UseGameStatePollingResult {
  gameState: GameStateResponse | null;
  loading: boolean;
  /** Set on the most recent failed query; NOT cleared just because an earlier successful state is still being
   *  displayed -- callers wanting "stale but still show the last good state" can keep rendering while
   *  surfacing this as an inline note, matching this codebase's "never silently hide a failure" discipline. */
  error: string | null;
  refresh: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 6000;

/** Polls `QueryMsg::GetGameState` on a fixed interval -- design note #4. Returns `null` rather than throwing
 *  whenever `client` is absent, matching `HexGridRenderer.tsx`'s "omit the query props to keep this
 *  query-free" convention rather than forcing every caller to guard against a client-less render. */
export function useGameStatePolling(
  client: QueryCapableClient | null | undefined,
  /** OFFLINE-AWARE. `null`/`undefined` means the app has no configured contract, which is a supported state,
   *  not an error -- the same offline mode the tile-catalog fallback runs in. The hook clears state, stops
   *  loading and never queries. Typed optional rather than coerced to `""` at the call site, so the offline
   *  case cannot be mistaken for a real address that happens to be empty. */
  contractAddress: string | null | undefined,
  gameId: number,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseGameStatePollingResult {
  const [gameState, setGameState] = useState<GameStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic guard against a slow, stale poll resolving after a newer one
  // already has -- same pattern as HexGridRenderer.tsx's click interceptor
  // (design note #7 there).
  const requestSeqRef = useRef(0);

  const refresh = useCallback(() => {
    if (!client || !contractAddress) {
      setGameState(null);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    client
      .queryContractSmart(contractAddress, { GetGameState: { game_id: gameId } })
      .then((response) => {
        if (requestSeqRef.current !== seq) return;
        setGameState(response as GameStateResponse);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying GetGameState.");
        setLoading(false);
      });
  }, [client, contractAddress, gameId]);

  useEffect(() => {
    refresh();
    if (!client) return;
    const handle = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(handle);
  }, [client, refresh, intervalMs]);

  return { gameState, loading, error, refresh };
}

/* ------------------------------------------------------------------ */
/* Player Net Worth polling hook -- see design note #6                */
/* ------------------------------------------------------------------ */

export interface UsePlayerNetWorthsResult {
  /** Keyed by player address -- absent for any address that hasn't
   *  resolved a `PlayerNetWorth` query yet (e.g. the very first render, or
   *  a brand-new player who just joined mid-poll-cycle). */
  netWorths: Record<string, PlayerNetWorthResponse>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_NET_WORTH_POLL_INTERVAL_MS = 6000;

/** Polls `QueryMsg::PlayerNetWorth` for every address on a fixed interval -- design note #6 for why this is
 *  a distinct hook rather than a field on `GameStateResponse`. Every query fires concurrently via
 *  `Promise.all`, so this scales to a full player table in one round-trip-latency's worth of time, not N. */
export function usePlayerNetWorths(
  client: QueryCapableClient | null | undefined,
  contractAddress: string,
  gameId: number,
  playerAddresses: readonly string[],
  intervalMs: number = DEFAULT_NET_WORTH_POLL_INTERVAL_MS,
): UsePlayerNetWorthsResult {
  const [netWorths, setNetWorths] = useState<Record<string, PlayerNetWorthResponse>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic guard against a slow, stale poll resolving after a newer one
  // already has -- same pattern as `useGameStatePolling` above.
  const requestSeqRef = useRef(0);
  // See design note #6: keys `refresh`'s own identity off the ADDRESS SET,
  // not the `playerAddresses` array reference itself, so a same-content
  // re-parse of `GameStateResponse.player_addresses` (every poll, being
  // fresh JSON) doesn't rebuild this hook's interval every cycle.
  const playersKey = playerAddresses.join(",");

  const refresh = useCallback(() => {
    if (!client || playerAddresses.length === 0) {
      setNetWorths({});
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    Promise.all(
      playerAddresses.map((player) =>
        client
          .queryContractSmart(contractAddress, {
            PlayerNetWorth: { game_id: gameId, wallet_address: player },
          })
          .then((response) => [player, response as PlayerNetWorthResponse] as const),
      ),
    )
      .then((entries) => {
        if (requestSeqRef.current !== seq) return;
        setNetWorths(Object.fromEntries(entries));
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying PlayerNetWorth.");
        setLoading(false);
      });
    // `playerAddresses` itself is intentionally omitted below -- `playersKey`
    // (its joined content) is the real dependency; see this hook's own
    // design note #6 comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, contractAddress, gameId, playersKey]);

  useEffect(() => {
    refresh();
    if (!client) return;
    const handle = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(handle);
  }, [client, refresh, intervalMs]);

  return { netWorths, loading, error, refresh };
}

// Pre-Game Waterfall Auction (`waterfall.rs`) -- design note #7. Mirrors `WaterfallStateResponse` and its
// nested types exactly, plus a THIRD independent polling hook on the same fixed-interval-plus-monotonic-
// guard pattern. Separate rather than folded into `GameStateResponse` because `GetWaterfallState` is its
// own query and, unlike `PlayerNetWorth`, is only meaningful while the auction is current -- so every other
// panel keeps polling `GetGameState` alone without paying for a response it never renders.

/** One standing bid on a private company -- mirrors `msg.rs`'s
 *  `WaterfallBidEntry` exactly. */
export interface WaterfallBidEntry {
  bidder: string;
  bid_amount: string;
}

/** One still-unowned core private company's live Waterfall Auction status --
 *  mirrors `msg.rs`'s `WaterfallPrivateStatus` exactly. */
export interface WaterfallPrivateStatus {
  private_id: number;
  name: string;
  face_value: string;
  /** `true` only for whichever private is currently the cheapest
   *  still-unowned one -- the only one `WaterfallBuyLowest` can target, and
   *  the only one that can never itself be bid on. */
  is_lowest_offered: boolean;
  bids: WaterfallBidEntry[];
}

/** The currently-in-progress mini-auction's live status (2+ competing bidders on
 *  a single private) -- mirrors `msg.rs`'s `WaterfallMiniAuctionStatus`
 *  exactly. `null` on `WaterfallStateResponse.mini_auction` whenever no
 *  mini-auction is active. */
export interface WaterfallMiniAuctionStatus {
  private_id: number;
  /** The competing bidders, in the order they will be asked to act: ascending by the bid each held when the
   *  contest opened, so the lowest bidder is always first to answer. See `sandboxSession.ts #544` for why the
   *  queue is fixed at that moment rather than re-sorted after every raise. */
  bidders: string[];
  /** Whose turn it currently is within `bidders` -- always someone other
   *  than `high_bidder`, whose own turns are auto-skipped. */
  current_turn: string;
  high_bid: string;
  high_bidder: string;
}

/** `QueryMsg::GetWaterfallState`'s response -- mirrors `msg.rs`'s
 *  `WaterfallStateResponse` exactly. */
export interface WaterfallStateResponse {
  game_id: number;
  waterfall_auction_active: boolean;
  /** Every still-unowned core private company, in ascending face-value
   *  order -- empty once all six have been won. */
  privates: WaterfallPrivateStatus[];
  /** Whose turn it is in the main Waterfall Auction turn order. Stays fixed
   *  (not meaningfully actionable) while a mini-auction is in progress --
   *  use `mini_auction.current_turn` instead in that case. */
  current_turn: string;
  /** Non-`null` only while a 2+-bidder mini-auction is currently
   *  resolving. */
  mini_auction: WaterfallMiniAuctionStatus | null;
  /** How many consecutive `WaterfallPass` calls have occurred so far --
   *  reaching `player_addresses.length` ends the auction early. */
  consecutive_waterfall_passes: number;
}

export interface UseWaterfallStatePollingResult {
  waterfallState: WaterfallStateResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_WATERFALL_POLL_INTERVAL_MS = 4000;

/** Polls `QueryMsg::GetWaterfallState` -- design note #7. Callers should gate on `enabled` rather than
 *  polling every room forever; when it is `false` the hook tears down its interval and clears state rather
 *  than continuing to query a phase that is already over.
 *  Mirrors `msg::TrainOfferEntry`. */
export interface TrainOfferEntry {
  offer_id: number;
  buyer_protocol_id: number;
  seller_protocol_id: number;
  model_type: string;
  /** `Uint128` -- a JSON string. Never parsed to a number. */
  price: string;
  seller_president: string | null;
  buyer_president: string | null;
}

export interface TrainOffersResponse {
  game_id: number;
  offers: TrainOfferEntry[];
}

export interface UseTrainOffersPollingResult {
  offers: TrainOfferEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Audit G-15: polls `GetTrainOffers`. Its own hook rather than a field on the main poll, following the
 *  pattern the waterfall hook established: offers change on a different rhythm from the board -- they appear
 *  and vanish on two players' actions rather than on turn boundaries -- and a seller needs to see one arrive
 *  while it is emphatically NOT their turn, so this cannot key off turn state. */
export function useTrainOffersPolling(
  client: QueryCapableClient | null | undefined,
  contractAddress: string | null | undefined,
  gameId: number,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseTrainOffersPollingResult {
  const [offers, setOffers] = useState<TrainOfferEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(() => {
    if (!client || !contractAddress) {
      setOffers([]);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    client
      .queryContractSmart(contractAddress, { GetTrainOffers: { game_id: gameId } })
      .then((response) => {
        if (requestSeqRef.current !== seq) return;
        setOffers((response as TrainOffersResponse).offers ?? []);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying GetTrainOffers.");
        setLoading(false);
      });
  }, [client, contractAddress, gameId]);

  useEffect(() => {
    refresh();
    const handle = setInterval(refresh, intervalMs);
    return () => clearInterval(handle);
  }, [refresh, intervalMs]);

  return { offers, loading, error, refresh };
}

export function useWaterfallStatePolling(
  client: QueryCapableClient | null | undefined,
  /** OFFLINE-AWARE, exactly as the game-state hook is: no configured contract is a supported state, the hook
   *  clears and never queries, and the prop is typed optional rather than coerced to `""` so the offline case
   *  cannot be mistaken for a real address that happens to be empty. */
  contractAddress: string | null | undefined,
  gameId: number,
  enabled: boolean,
  intervalMs: number = DEFAULT_WATERFALL_POLL_INTERVAL_MS,
): UseWaterfallStatePollingResult {
  const [waterfallState, setWaterfallState] = useState<WaterfallStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(() => {
    if (!client || !enabled || !contractAddress) {
      setWaterfallState(null);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    client
      .queryContractSmart(contractAddress, { GetWaterfallState: { game_id: gameId } })
      .then((response) => {
        if (requestSeqRef.current !== seq) return;
        setWaterfallState(response as WaterfallStateResponse);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestSeqRef.current !== seq) return;
        setError(e instanceof Error ? e.message : "Unknown error querying GetWaterfallState.");
        setLoading(false);
      });
  }, [client, contractAddress, gameId, enabled]);

  useEffect(() => {
    refresh();
    if (!client || !enabled) return;
    const handle = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(handle);
  }, [client, enabled, refresh, intervalMs]);

  return { waterfallState, loading, error, refresh };
}


/* Design note #553: A CORPORATION'S PAR IS THE CORPORATION'S, NOT YOURS. The resolver read the local par
   LADDER, falling back to a hardcoded "100" when this browser had never touched it. The ladder is a UI
   selection -- per-browser by design, and empty on every client but the one that made the choice -- so
   everybody else fell through to the default, which happens to be the top rung, which is why the wrong
   number looked like a plausible one.
   SO THE LADDER IS AN INPUT, AND THE PAR IS A FACT: once the founding purchase lands
   `PublicCompanyState.par_value` holds the answer and every client has it. The ladder is consulted only
   while that field is empty -- exactly what #351 already said the rule was; the reducer honoured it and the
   price the UI quoted and dispatched did not.
   THE SAME BUG AS #549, one layer up: there the reducer resolved WHO from local state, here the UI resolved
   HOW MUCH. Both produce the same failure -- no error, two clients that disagree, and a symptom that
   surfaces somewhere else entirely. */
export function parPriceFor(
  state: GameStateResponse | null,
  companyId: number,
  ladderSelection?: string,
  fallback = "100",
): string {
  const set = state?.public_companies.find((c) => c.company_id === companyId)?.par_value;
  /* A par of 0 is not a price -- treat it as unset. The contract sends the
     field as a string or null, and "0" is what an uninitialised numeric
     column looks like on the way through. */
  if (set !== null && set !== undefined && Number(set) > 0) return String(set);
  return ladderSelection ?? fallback;
}
