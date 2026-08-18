// frontend/src/utils/gameState.ts
//
// A hand-kept TypeScript mirror of `src/msg.rs`'s `QueryMsg::GetGameState`
// response shape (`GameStateResponse` and every nested type), plus a small
// polling hook (`useGameStatePolling`) so every new dashboard panel this
// pass adds (Chatbox's turn alert, the Stock/Operating Round contextual
// sub-panel, the Financial Ledger tab) can share ONE live query instead of
// each re-implementing its own `queryContractSmart` call the way
// `App.tsx`'s pre-existing `refreshVgpBalance` did for just `player_cash`.
//
// Design notes:
// 1. **Hand-kept mirror, not codegen -- same DESIGN GAP as every other
//    contract-data mirror in this codebase** (see `HexGridRenderer.tsx`
//    design note #2, `StockMarketRenderer.tsx` design note #1): there is no
//    schema-derived TS type for `GameStateResponse`, so this file's fields
//    must be kept in exact sync with `src/msg.rs` by hand any time that
//    struct changes. Verified field-for-field against `src/msg.rs` for this
//    pass (`GameStateResponse`, `PlayerCashEntry`, `PlayerShareEntry`,
//    `PublicCompanyState`, `PrivateCompanyState`).
// 2. **What this file deliberately does NOT expose, because the backend
//    doesn't either.** `src/state.rs` genuinely models hardware/train
//    inventory (`HardwareAsset`, `HARDWARE_POOL`, `COMPANY_HARDWARE`,
//    `TRAINS_PURCHASED_COUNT`) and route-tracing (`pathfinding.rs`,
//    referenced by `ExecuteMsg::ExecuteOperatingRound`'s own doc comment in
//    `src/msg.rs`) -- but NO `QueryMsg` variant returns any of it.
//    `PublicCompanyState` has no hardware/train/route field at all. This
//    file does not invent one; every panel that would want that data (the
//    Operating Round contextual sub-panel's "routes and train sheets", the
//    Financial Ledger's "Hardware Shop inventory") must render an honest
//    "not yet exposed by the contract" state instead of a fabricated
//    number -- see `ContextualSubPanel.tsx`/`FinancialLedger.tsx`.
// 3. **Certificates are DERIVED but EXACT -- not a backend count.**
//    `src/state.rs` has an internal `count_player_certificates()` helper,
//    but it is used only inside `trading.rs`/`auction.rs`'s own limit
//    checks -- no query surfaces its result. `certificateCount` below
//    reconstructs the count exactly from what genuinely is
//    queryable (`private_companies[].owner`, `public_companies[].player_
//    holdings`/`.president`). A player's president's 20% certificate in a
//    company counts as exactly ONE certificate against the limit -- verified
//    against three independent sources (official Lookout Games rulebook,
//    18xx.net rules text, and the open-source `tobymao/18xx` engine's own
//    `num_certs`/`cert_size` implementation; see the Rules Reference tab's
//    own design note #4 for the full citations) -- NOT two, despite
//    representing double the ownership. An earlier pass of this comment
//    said this rule was deliberately left unimplemented because it hadn't
//    been confirmed against source; that premise no longer holds on either
//    count -- the rule itself is now confirmed, and the code below
//    implements it: `holding.percentage` is split into the president's own
//    20% (counted as 1 certificate, when `company.president` matches
//    `playerAddress`) plus whatever percentage the player holds beyond
//    that, each ordinary 10% block of which still counts as 1 certificate.
//    Every caller of this function should still present its result as "~N
//    (est.)", not a bare number -- it remains a client-side reconstruction,
//    not a query straight off `count_player_certificates()` itself.
// 4. **Polling, not a subscription.** CosmWasm has no push/subscription
//    query mechanism reachable from a browser the way this project is
//    wired (a plain `CosmWasmClient`/`SigningCosmWasmClient` over RPC) --
//    `useGameStatePolling` re-fires `GetGameState` on a fixed interval
//    (default 6s) plus once immediately whenever `client`/`contractAddress`/
//    `gameId` change, mirroring `App.tsx`'s pre-existing
//    `refreshVgpBalance` one-shot-plus-manual-refresh pattern but now
//    interval-driven and shared. A monotonic request-sequence guard
//    (mirroring `HexGridRenderer.tsx`'s click-interceptor staleness guard,
//    design note #7 there) discards a stale in-flight response if a newer
//    poll already resolved first.
// 5. **Station Tokens (`HexGridRenderer.tsx` design note #36).** Added
//    `PublicCompanyState.home_hex_label`/`station_token_hexes`/
//    `station_token_limit`, mirroring `msg.rs::PublicCompanyState`'s own
//    same-named fields exactly -- needed so `App.tsx` can pass
//    `state.public_companies` straight into `HexGridRenderer`'s new
//    `publicCompanies` prop (typed there as the narrower
//    `StationTokenCompany[]`; this wider `PublicCompanyState[]` is
//    structurally assignable to it, no conversion needed).
// 6. **Player Net Worth (`FinancialLedger.tsx`).** Added
//    `PlayerNetWorthResponse`, mirroring `msg.rs::PlayerNetWorthResponse`
//    exactly, plus `usePlayerNetWorths` -- a SEPARATE polling hook from
//    `useGameStatePolling` above, not a field folded into
//    `GameStateResponse`, because `QueryMsg::PlayerNetWorth` takes a
//    per-player `wallet_address` argument `GetGameState` has no equivalent
//    for; one room-wide `GameStateResponse` poll can't answer "what is
//    EACH player's net worth" in a single call the way it already answers
//    "what is each player's cash" (`player_cash`) or "each company's
//    holdings" (`public_companies[].player_holdings`). `usePlayerNetWorths`
//    instead fires one `PlayerNetWorth` query per address in
//    `playerAddresses` (via `Promise.all`, so they resolve concurrently,
//    not one-by-one) on the same fixed-interval-plus-monotonic-guard
//    pattern `useGameStatePolling` established. Its `refresh` callback
//    depends on `playersKey` (`playerAddresses.join(",")`) rather than
//    `playerAddresses` itself, so a `GameStateResponse` poll returning a
//    same-content-but-new-array-reference `player_addresses` (as every
//    poll does, being a fresh JSON parse) doesn't tear down and rebuild
//    this hook's own interval every 6 seconds in lockstep -- only an
//    actual membership change (a player joining) does.

import { useCallback, useEffect, useRef, useState } from "react";

// Design note #526: the one printed-limits table.
import { certLimitForPlayers } from "./gameSetup";

/* ------------------------------------------------------------------ */
/* Contract data mirror -- see design note #1                         */
/* ------------------------------------------------------------------ */

/** Hover text for the inline Priority Deal `#1` marker.
 *
 *  Defined once and shared by every surface that renders the marker
 *  (`FinancialLedger`'s Player Assets table, `ContextualSubPanel`'s Stock
 *  Round Player Index) so the two cannot drift into explaining the same
 *  indicator two different ways -- which is exactly what happens when a
 *  tooltip string is retyped per call site. */
export const PRIORITY_DEAL_TOOLTIP = "Priority Deal: Starts the next Stock Round.";

export type TileColor = "Yellow" | "Green" | "Brown";
/** Pre-Game Waterfall Auction (`waterfall.rs`): every room now genesis-starts
 *  in `"WaterfallAuction"`, before `"StockRound"` is ever reachable -- see
 *  `WaterfallAuctionDashboard.tsx`, which is the only panel that renders
 *  anything while this value is current. Mirrors `state.rs`'s `RoundType`
 *  enum exactly. */
export type RoundType = "WaterfallAuction" | "StockRound" | "OperatingRound";

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
  /** Total revenue this corporation's trains earned on their most recent
   *  route run -- `msg.rs::PublicCompanyState.last_route_revenue`.
   *
   *  Written by `operations::execute_run_manual_route` on EVERY run, paid
   *  out or withheld alike, and reset to zero by a run that found no legal
   *  route. So it always reads as "what it earned last time", never a stale
   *  high-water mark. `"0"` for a corporation that has never run.
   *
   *  Optional because a contract predating the field returns no key at all,
   *  and `undefined` must stay distinguishable from a real `"0"`: the first
   *  means "this build cannot tell you", the second means "it earned
   *  nothing". `LastRoutePayout` renders the two differently. */
  last_route_revenue?: string;
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
  /* ==================================================================
   *  DESIGN NOTE 560: A HEX IS NOT A CITY
   * ==================================================================
   *
   * REPORTED: placing ERIE's home station, the player clicked the TOP-RIGHT
   * city and the token landed on the bottom-left one.
   *
   * `station_token_hexes` above is `(q, r)` and cannot express the
   * difference. ERIE's home hex carries two separate cities; so does New
   * York, and so does every OO tile. With only a hex to go on, the renderer
   * falls back to a heuristic, and the heuristic picks the first slot --
   * which is the bottom-left one, every time, for every corporation.
   *
   * So the answer the player gave is recorded. `hexContractTypes.ts` has
   * declared this field since design note #134 (backend Audit G-12) and the
   * renderer already PREFERS it over the heuristic; nothing on this side
   * ever wrote it, so the preference never had anything to prefer.
   *
   * OPTIONAL, and the three states stay distinguishable: absent means "this
   * chain predates G-12, fall back to the heuristic"; an entry means "this
   * slot, definitively"; and a hex present in `station_token_hexes` with no
   * entry here means the same as absent for that token specifically. What it
   * must never mean is "no token", which is why the two arrays are written
   * together and never one without the other. */
  station_tokens?: Array<[number, number, number]> | null;
  /** This company's total Station Token limit, home token included -- see
   *  `hexmap::station_token_limit`. Mirrors `msg.rs::PublicCompanyState.
   *  station_token_limit` exactly. */
  station_token_limit: number;
  /** Audit G-15c: the MODEL of every train this corporation owns, e.g.
   *  `["2", "2", "4"]`. Duplicates are meaningful.
   *
   *  OPTIONAL, and the optionality carries meaning the UI must respect:
   *  `undefined` means a contract predating the field, i.e. "unknown", NOT
   *  "owns nothing". A UI that conflates the two would grey out every train
   *  on every corporation against an older chain and make trading look
   *  broken rather than unsupported. */
  owned_trains?: string[] | null;
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
  /** Real field, but per `src/state.rs`'s own doc comment currently static
   *  `0` for every room -- nothing yet reassigns it during play on chain.
   *  The SANDBOX reassigns it at the end of a Stock Round (design note #353
   *  in `sandboxSession.ts`), which is the rule the contract will apply
   *  when it implements `conclude_stock_round`'s own half. */
  priority_deal_index: number;
  /* ==================================================================
   *  SANDBOX-ONLY FIELDS
   * ==================================================================
   *
   * Neither of these comes off the wire. `GetGameState` does not report
   * them and a live room leaves them `undefined`, which every reader below
   * treats as "not applicable" rather than as a value -- see design note
   * #352 for why they live on the state object at all rather than in module
   * scope (the undo snapshot copies the state; it cannot copy a closure).
   *
   * Marked optional rather than added to the mirror of the contract's
   * response shape, so nothing here can be mistaken for a field the chain
   * will one day send.
   */
  /** Design note #352: the seat that last bought or sold this Stock Round,
   *  for the Priority Deal handover. `null` when nobody has traded. */
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

/** The seat that should be holding the controls right now, given the phase.
 *
 *  Two different pointers answer "who acts next" in 1830, and which one is
 *  correct depends entirely on the round:
 *
 *  - **Waterfall Auction and Stock Round** are seat-driven. Players act in
 *    seating order, so `active_player_index` is the answer directly.
 *  - **Operating Rounds** are corporation-driven. The queue
 *    (`active_operating_order`) names companies, not people, and the human
 *    who may act is whoever presides over the company currently up. The seat
 *    pointer is not meaningful here and can easily point at a player with
 *    nothing to do.
 *
 *  Returns `null` when the acting seat cannot be resolved -- an Operating
 *  Round whose current corporation has no president on record, for
 *  instance. Callers should leave the seat where it is rather than guess. */
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


/* ==================================================================
 *  DESIGN NOTE 544: A MINI-AUCTION SUSPENDS THE TURN ORDER
 * ==================================================================
 *
 * REPORTED: a player bought a private, which opened a mini-auction they
 * were the lowest bidder in. The mini-auction card named them as being on
 * turn. The Turn Order named them. The Auction Round ACTION PANEL named
 * somebody else -- and only that somebody else could do anything.
 *
 * `actingSeatIndex` above returns `active_player_index` during the auction,
 * and that field is right about the WATERFALL and knows nothing about a
 * contest running on top of it. The mini-auction's cursor lives on a
 * different document (`WaterfallStateResponse.mini_auction.current_turn`),
 * on a different atom, fetched by a different query. So the two halves of
 * the screen were each reading a pointer that was correct about a different
 * question, and neither was wrong on its own terms.
 *
 * THE SUSPENSION IS THE WHOLE RULE. While a contest is live the main
 * rotation does not advance and nobody may take a waterfall action -- the
 * reducer has preserved `waterfall.current_turn` across a contest since
 * design note #338 precisely so it can be resumed untouched afterwards.
 * That makes it a STALE pointer for the duration, not a live one, and
 * anything asking "who may act" has to prefer the contest's cursor.
 *
 * WHY AN ADDRESS AND NOT A SEAT INDEX. A mini-auction bidder is identified
 * by address; mapping back to a seat only to have callers map forward again
 * would add a lookup that can fail (a bidder missing from
 * `player_addresses`) to a path that currently cannot.
 *
 * `actingSeatIndex` IS LEFT ALONE. It answers a narrower question -- which
 * SEAT the phase points at -- and the sandbox seat-switcher and the
 * Operating Round president lookup both still want exactly that. Widening
 * it would have meant threading the waterfall document through every
 * caller, including several that have no business knowing an auction
 * exists.
 */
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

/** Whether `address` is shut out of the contest currently running -- i.e. a
 *  seat at the table who is not one of its bidders. `false` whenever no
 *  mini-auction is live, because there is then nothing to be excluded from.
 *
 *  Design note #545 (`ContextualActionBar`): drives the greyed-out roster
 *  pills, and states a real fact about the game rather than a visual one --
 *  these players cannot act, and cannot be acted for, until the contest
 *  resolves. */
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

/**
 * EXACT certificate count for `playerAddress`.
 *
 * Renamed from `estimateCertificateCount`, and the "~N" presentation it
 * required is gone with it. The name was inherited from a pass where the
 * president's-certificate rule was unconfirmed and the count really was a
 * guess. That rule is now confirmed against three independent sources
 * (design note #3) and implemented below, and every input --
 * `private_companies[].owner`, `public_companies[].player_holdings`,
 * `.president` -- is queryable exact state. Nothing here approximates
 * anything.
 *
 * Equivalent to `(total public % / 10) - presidencies held + privates
 * held`: a president's 20% share is a single physical certificate, so it
 * counts once rather than twice.
 *
 * The one thing it still cannot do is see a certificate the QUERIES do not
 * expose -- but no such certificate exists in the current schema, so that
 * is a statement about future changes, not about present accuracy.
 */
export function certificateCount(playerAddress: string, state: GameStateResponse): number {
  let count = 0;
  for (const priv of state.private_companies) {
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

/* Design note #526: the local copy is GONE. It carried its own doc comment
   saying "Mirrors `RulesReference.tsx`'s `CERT_LIMIT_BY_PLAYERS`" -- a
   correctness requirement enforced by a sentence, which is the arrangement
   TD-1 catalogued and design note #507 hit again. `utils/gameSetup.ts` is
   the one table now; multiplayer initialisation needed it too, and a third
   copy is what this delegation exists to avoid. */

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

/* ==================================================================
 *  DESIGN NOTE 7: THE CERTIFICATE LIMIT EXEMPTION
 * ==================================================================
 *
 * Shares of a corporation whose market price sits in the Yellow, Orange or
 * Brown zone do not count toward a player's certificate limit. That is a
 * MARKET-POSITION rule, not an ownership rule: the same certificate counts
 * today and stops counting tomorrow if the price moves up into a zone, with
 * nothing about the certificate itself changing.
 *
 * WHY THE ZONE ARRIVES AS A CALLBACK. The zone table lives in
 * `StockMarketRenderer.tsx` (`marketZoneForPrice`), and `utils/` may not
 * import from `components/` -- the one-way rule this codebase holds. Taking
 * `zoneForPrice` as a parameter keeps that boundary intact AND keeps this
 * function pure and testable, rather than copying the price-to-zone table
 * into a second place where it could drift from the board a player is
 * looking at.
 *
 * OMITTING THE CALLBACK IS A VALID CALL, not a degraded one: the caller
 * simply has no market data (an unfloated-only room, or a live game where
 * `GetMarketGrid` has not been wired). Everything is then counted, which is
 * the correct conservative answer -- a corporation with no market position
 * is not in any zone.
 *
 * PRIVATE COMPANIES ARE NEVER EXEMPT. They have no market price at all, so
 * there is no zone for them to be in; they always count.
 */
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

/* ==================================================================
 *  DESIGN NOTE 497: THE LEDGER SAID "NOT CONNECTED" TO ITS OWN DATA
 * ==================================================================
 *
 * REPORTED: the Game Ledger's Player Assets table shows "not connected" for
 * Stock Value and Net Worth, masking local Sandbox figures behind a
 * wallet-connection check.
 *
 * It did. `netWorthsEnabled` is `queryClient && contractAddress && gameId`,
 * and a sandbox has none of the three -- design note #24 in `App.tsx` is
 * explicit that "sandbox never touches the network at all". So both columns
 * fell to the `!netWorthsEnabled` placeholder for the whole of offline mode,
 * on the one screen whose job is to total up what everybody owns.
 *
 * `FinancialLedger`'s design note #4 is why, and it was right WHEN WRITTEN:
 *
 *   "This panel can't compute it itself from `gameState` alone:
 *    `GameStateResponse` carries each company's `par_value` but not its live
 *    market price (that's a separate `GetMarketGrid` query), so reproducing
 *    the real figure client-side would mean either a second query plus
 *    duplicating the backend's own valuation math, or silently substituting
 *    par value for market price -- both worse than just calling the
 *    dedicated endpoint."
 *
 * The premise expired. `marketGrid` has since become a PROP of that panel
 * (its own design note #14, for the Corporation Assets table's Market Price
 * column), and `PlayerAssetsSection` already unpacks it into a
 * `marketPrices` map to decide certificate exemptions. The live prices the
 * note says would need a second query are sitting in the same function that
 * prints "not connected".
 *
 * So the valuation is derivable, and the note's own escape clause -- do not
 * substitute par value for market price -- is honoured below: this reads the
 * live price and returns `null` for a corporation that has none, rather than
 * quietly pricing it at par.
 *
 * ==================================================================
 *  DESIGN NOTE 497a: AN ESTIMATE THAT KNOWS IT IS ONE
 * ==================================================================
 *
 * This does NOT replace `QueryMsg::PlayerNetWorth`. The chain's figure stays
 * authoritative wherever there is a chain to ask, and the caller prefers it.
 * What this replaces is the BLANK -- and the distinction matters, because
 * the two can legitimately differ: the contract may value things this does
 * not know about, and a client-side total presented as authoritative would
 * be the "silently substituting" failure the note above warns against
 * wearing a different hat.
 *
 * `null` PROPAGATES rather than being coerced to zero. A player holding a
 * corporation with no market position has an UNKNOWN portfolio value, not a
 * zero one, and reporting "$0 net worth" for someone holding five
 * certificates is worse than reporting nothing at all.
 */

/** One 1830 certificate is 10% of a corporation, and a market price is
 *  quoted per certificate -- so a 30% holding is three certificates at that
 *  price. Named rather than inlined as `/ 10`, because the divisor is a rule
 *  rather than an arithmetic convenience. */
const PERCENT_PER_CERTIFICATE = 10;

/** What `playerAddress`'s shares are worth at live market prices, or `null`
 *  when any corporation they hold has no price to value them at.
 *
 *  `marketPrices` is keyed by `company_id`, exactly as `FinancialLedger`'s
 *  own `marketPrices` map already is. */
export function estimateStockPortfolioValue(
  playerAddress: string,
  state: GameStateResponse,
  marketPrices: Readonly<Record<number, number | null>>,
): number | null {
  let total = 0;
  for (const holding of playerCompanyHoldings(playerAddress, state)) {
    const price = marketPrices[holding.company.company_id];
    /* Unknown price, unknown total. Skipping the corporation instead would
       under-report the portfolio by however much it is worth, and an
       under-report is indistinguishable from a correct smaller number --
       which is exactly the kind of wrong figure a player would act on. */
    if (price == null || !Number.isFinite(price)) return null;
    total += (holding.percentage / PERCENT_PER_CERTIFICATE) * price;
  }
  return total;
}

/** Liquid cash plus portfolio value, or `null` when either is unknown. */
export function estimatePlayerNetWorth(
  playerAddress: string,
  state: GameStateResponse,
  marketPrices: Readonly<Record<number, number | null>>,
): { stockValue: number; netWorth: number } | null {
  const stockValue = estimateStockPortfolioValue(playerAddress, state, marketPrices);
  if (stockValue === null) return null;
  const entry = state.player_cash.find((row) => row.player === playerAddress);
  const cash = Number(entry?.cash_vgp ?? NaN);
  // No cash record is not zero cash -- same argument as the `null` above.
  if (!Number.isFinite(cash)) return null;
  return { stockValue, netWorth: cash + stockValue };
}

/* ==================================================================
 *  DESIGN NOTE 379: A PRIVATE CAN BELONG TO A COMPANY, NOT A PLAYER
 * ==================================================================
 *
 * REPORTED: when a corporation buys a private company from a player, there
 * is nowhere in the UI to see that the corporation now owns it.
 *
 * `PrivateCompanyState` has carried BOTH owners since the schema was
 * written -- `owner` for a player and `owner_protocol_id` for a
 * corporation, "mutually exclusive" per its own doc comment -- and the
 * phase-gated corporate purchase that sets the second one has been
 * implemented since `PrivateTradePanel`. Every reader in the app looked
 * only at `owner`. So the moment a private crossed from a player to a
 * company it left the seller's ledger row and arrived nowhere: it paid
 * revenue to a treasury (design note #329) that no surface attributed to
 * it.
 *
 * ONE HELPER, so the ledger column and the Operating Round strip cannot
 * disagree about what a corporation owns -- the same reason
 * `playerPrivateCompanies` exists for the other half of the pair.
 *
 * CLOSED PRIVATES ARE EXCLUDED, matching `playerSellablePrivateCompanies`
 * and the reservation badges: a closed company is off the board, pays
 * nothing, and listing it would show an asset the corporation no longer
 * has. */
export function corporationPrivateCompanies(
  companyId: number,
  state: GameStateResponse,
): PrivateCompanyState[] {
  return state.private_companies.filter(
    (priv) => !priv.closed && priv.owner_protocol_id === companyId,
  );
}

/** Every private company `playerAddress` currently owns -- the other half
 *  of a Financial Ledger "certificate tree". Includes closed privates still
 *  on this player's own ledger (e.g. a Phase 5-closed private they held at
 *  closure) -- use `playerSellablePrivateCompanies` below instead when the
 *  goal is specifically what a corporation could still buy from them. */
export function playerPrivateCompanies(
  playerAddress: string,
  state: GameStateResponse,
): PrivateCompanyState[] {
  return state.private_companies.filter((p) => p.owner === playerAddress);
}

/** Every private company `playerAddress` currently owns AND could still
 *  sell to a corporation via `BuyPrivateCompany` -- i.e. `playerPrivateCompanies`
 *  minus any already `closed` (a closed private permanently rejects
 *  `execute_buy_private_company`, per `trading.rs` module doc comment #17,
 *  so offering one here would just produce a guaranteed-failing tx). The
 *  "Buy Private Company" action tray (`App.tsx`'s `ContextualActionBar`)
 *  uses this, not the plain list above, to populate its dropdown. */
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
  /** Set on the most recent failed query; NOT cleared just because an
   *  earlier successful `gameState` is still being displayed -- callers
   *  that want "stale but still show the last good state" behavior (most
   *  of this dashboard) can keep rendering `gameState` while also
   *  surfacing `error` as a small inline note, matching this codebase's
   *  established "never silently hide a failure" discipline (see
   *  `App.tsx`'s pre-existing `vgpBalanceNote` pattern). */
  error: string | null;
  refresh: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 6000;

/** Polls `QueryMsg::GetGameState` on a fixed interval -- see design note #4.
 *  Returns `null` `gameState` (not a thrown error) whenever `client` is
 *  absent, matching `HexGridRenderer.tsx`'s own "omit the query props to
 *  keep this query-free" convention rather than forcing every caller to
 *  guard against a client-less render. */
export function useGameStatePolling(
  client: QueryCapableClient | null | undefined,
  /** OFFLINE-AWARE. `null`/`undefined` means the app has no configured
   *  contract (`config.CONTRACT_ADDRESS` unset), which is a supported state,
   *  not an error -- the same offline mode `HexGridRenderer`'s tile-catalog
   *  fallback runs in. The hook then behaves exactly as it does with no
   *  client: it clears state, stops loading, and never queries. Typed
   *  optional rather than coerced to `""` at the call site so the offline
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

/** Polls `QueryMsg::PlayerNetWorth` for every address in `playerAddresses`
 *  on a fixed interval -- see design note #6 for why this is a distinct
 *  hook from `useGameStatePolling` rather than a field on
 *  `GameStateResponse`. Every address's query fires concurrently via
 *  `Promise.all`, not sequentially, so this scales to a full player table
 *  in one round-trip-latency's worth of time, not N of them. */
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

/* ------------------------------------------------------------------ */
/* Pre-Game Waterfall Auction (`waterfall.rs`) -- see design note #7    */
/* ------------------------------------------------------------------ */
//
// 7. **Waterfall Auction state (`WaterfallAuctionDashboard.tsx`).** Mirrors
//    `msg.rs`'s `WaterfallStateResponse`/`WaterfallPrivateStatus`/
//    `WaterfallBidEntry`/`WaterfallMiniAuctionStatus` exactly, plus a THIRD,
//    independent polling hook (`useWaterfallStatePolling`) on the same
//    fixed-interval-plus-monotonic-guard pattern as `useGameStatePolling`/
//    `usePlayerNetWorths` above -- a separate hook rather than folding this
//    into `GameStateResponse` because `QueryMsg::GetWaterfallState` is its
//    own query and, unlike `PlayerNetWorth`, is only ever meaningful while
//    `current_round_type === "WaterfallAuction"`; every other panel in this
//    dashboard can keep polling `GetGameState` alone without ever paying for
//    a query whose response it never renders.

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
  /** The competing bidders, in the order they will be asked to act:
   *  ascending by the bid each held when the contest opened, so the lowest
   *  bidder is always first to answer. See `sandboxSession.ts` design note
   *  #544 for why the queue is fixed at that moment rather than re-sorted
   *  after every raise. */
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

/** Polls `QueryMsg::GetWaterfallState` on a fixed interval -- see design
 *  note #7. Callers should gate rendering on `enabled` (typically
 *  `gameState?.current_round_type === "WaterfallAuction"`) rather than
 *  unconditionally polling every game room forever; when `enabled` is
 *  `false` this hook tears down its interval and clears `waterfallState`
 *  rather than continuing to query a phase that's already over. */
/** Mirrors `msg::TrainOfferEntry`. */
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

/** Audit G-15: polls `GetTrainOffers`.
 *
 *  Its own hook rather than a field on the main game-state poll, following
 *  the same pattern `useWaterfallStatePolling` established. Offers change on
 *  a different rhythm from the board -- they appear and vanish on two
 *  players' actions rather than on turn boundaries -- and a seller needs to
 *  see one arrive while it is emphatically NOT their turn, so this cannot key
 *  off turn state. */
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
  /** OFFLINE-AWARE. `null`/`undefined` means the app has no configured
   *  contract (`config.CONTRACT_ADDRESS` unset), which is a supported state,
   *  not an error -- the same offline mode `HexGridRenderer`'s tile-catalog
   *  fallback runs in. The hook then behaves exactly as it does with no
   *  client: it clears state, stops loading, and never queries. Typed
   *  optional rather than coerced to `""` at the call site so the offline
   *  case cannot be mistaken for a real address that happens to be empty. */
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


/* ==================================================================
 *  DESIGN NOTE 553: A CORPORATION'S PAR IS THE CORPORATION'S, NOT YOURS
 * ==================================================================
 *
 * REPORTED: the president founds a corporation at $67 and their Buy button
 * goes on saying $67. Every other player is shown $100 and pays $100 -- and
 * the two clients then place the corporation's market token in different
 * boxes.
 *
 * `parValueFor` read the local par LADDER (`srParValues`), falling back to a
 * hardcoded "100" when this browser had never touched it. The ladder is a UI
 * selection: it exists so the founding buyer can choose a price. It is
 * per-browser by design and it is empty on every client but the one that
 * made the choice, so everybody else fell through to the default -- which
 * happens to be the top rung, which is why the wrong number looked like a
 * plausible one.
 *
 * SO THE LADDER IS AN INPUT, AND THE PAR IS A FACT. Once the founding
 * purchase lands, `PublicCompanyState.par_value` holds the answer, it came
 * off the shared state, and every client has it. The ladder is consulted
 * only while that field is still empty -- which is exactly what design note
 * #351 already said the rule was ("once `par_value` is set the company has a
 * price and the ladder is locked"); the reducer honoured it and the price
 * the UI quoted and dispatched did not.
 *
 * THE SAME BUG AS DESIGN NOTE #549, one layer up. There the reducer resolved
 * WHO from local state; here the UI resolved HOW MUCH from local state. Both
 * are the same mistake -- deriving a shared fact from a per-browser value --
 * and both produce the same shape of failure: no error, two clients that
 * disagree, and a symptom that surfaces somewhere else entirely (here, the
 * stock market chart).
 */
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
