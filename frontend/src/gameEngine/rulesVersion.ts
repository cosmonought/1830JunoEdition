// frontend/src/gameEngine/rulesVersion.ts
//
// The authoritative rules-engine version a game is dealt under, and whether this engine may replay it.
//
// ==================================================================
//  DESIGN NOTE 1520: THREE IDENTITIES, NOT ONE STRING
// ==================================================================
//
// THE PROBLEM BATCH 3 FOUND AND BATCH 4 CONFIRMED. A room is rebuilt from its log on every server restart,
// on every `RevertTo` (#1233) and on every rejoin after a restart, through `RoomSession.restore` ->
// `rebuild()` -> `RoomEngine.apply`. The reducer that rebuilds it is whichever reducer the running server
// carries. So a correction to the rules -- Batch 3 refusing a lay the log holds, Batch 4 sending a discard
// to the pool -- silently rewrote every stored game's board the next time it was loaded. Nothing pinned a
// game to the rules it was played under.
//
// THE THREE THINGS THAT WERE CONFLATED, kept apart from here on:
//
//   CLIENT BUILD (`CLIENT_BUILD_ID` / the server's `--build`, #1206, #1252). Which deployment a browser and a
//   server are. Answers "may these two talk" (build-skew: the state digest covers every field, so two builds
//   disagree about non-divergences) and "may this server continue this room" (the deal-build pin). It
//   changes on every deployment, CSS-only ones included, and in practice it is `"dev"` on both sides -- so
//   the pin has never held anything.
//   LIVE-4 AMENDMENT: both answers above are now HISTORY for current software. A protocol-1 client is judged by
//   its announced protocol and rules (`compat/clientCompatibility.ts`), never its build; only a legacy
//   protocol-0 tab keeps the build-skew compare. A room continues by its deal's semantic identity
//   (`compat/continuationVerdict.ts`); the deal's build is diagnostic (#1252's pin is retired, L4-2). The build
//   is not part of the deployment's compatibility key.
//
//   RULES REVISION (`variants.rules`, #1443). A per-table switch the reducer BRANCHES ON (`sellBuySellInForce`)
//   so that one reducer plays both the old and the new Stock Round. It is a house-rules field the client
//   stamps at the deal; the reducer supports every value of it at once. It is not a compatibility boundary.
//
//   RULES-ENGINE VERSION (this file). Which authoritative reducer a game's log is a program for. It changes
//   ONLY when a deployment makes stored gameplay logs mean something different -- a refusal an old log
//   would now meet, a state field an old log would now produce differently -- and never for a UI change.
//   The server stamps it into the deal; a game keeps it for life; and nothing replays a log this engine does
//   not explicitly support.
//
// A HAND-BUMPED INTEGER, ON PURPOSE. A git hash would bump on every commit and re-create the client-build
// problem under a new name; a package version would need a release process this project does not have. The
// number moves when somebody decides the semantics moved, and the changelog below is where they say why.
//
// WHERE IT LIVES: in the `SetupGame` entry of the log, as `rules_engine_version`, written BY THE SERVER over
// whatever the client sent (`RoomSession.submit`). The log is the one artifact every rebuild path reads
// first -- the file store, the CLI, the golden corpus, an export -- so the pin travels with the history and
// cannot be separated from it. It is read from the EFFECTIVE log (#1252's rule for the build): a deal that
// was reverted pins nothing, and the next deal pins afresh.
//
// LEGACY LOGS: every log written before this note carries no version. "Unversioned" is NOT read as "the
// current version" -- that would be the original fault with a new name. It is its own compatibility answer,
// `legacy`, and what to do with it is a POLICY the caller states: the server refuses (a production-style
// room is not reinterpreted because the field is missing); the development replay corpus opts in, by name,
// in the test files and the CLI that carry it (`DEVELOPMENT_CORPUS_POLICY`), which is a statement that those
// logs are replayed under today's reducer as fixtures, not a claim that they were ever pinned. A local
// server may take the same opt-in explicitly (`start.ts --legacy-logs development-corpus`), and says so at
// startup and on every room it admits. A deal pinned to a version this engine does not carry is refused
// under EVERY policy: the opt-in admits the unpinned, never the differently pinned.
//
// WHEN IT IS ASKED: once per rebuild, before the first `RoomEngine.apply` -- in `RoomSession.rebuild` (a
// restore, a `RevertTo`, a `discardAfter`) and in `replayLog` (the CLI, the golden corpus). A live reconnect
// to a room already in memory is a `catchUp` and rebuilds nothing, so it is not asked there; a held room
// answers `catchUp` with the same `incompatible` frame it answers `submit` with, so a client is never handed
// a history the server will not interpret.

import type { ReplayEntry } from "./replayLog";
import { effectiveActions } from "./logRevert";

/** The rules engine this build carries. Bump it, and add a line below, when a deployment changes what a
 *  stored log replays to. Do NOT bump it for UI, protocol or narration changes. */
export const RULES_ENGINE_VERSION = 13;

/** Every version this engine can replay faithfully. One entry until somebody builds a versioned reducer;
 *  the point of the list is that "supported" is an explicit statement rather than "whatever is running". */
export const SUPPORTED_RULES_ENGINE_VERSIONS: readonly number[] = [RULES_ENGINE_VERSION];

/** Why each version exists. The number is meaningless without this. */
export const RULES_ENGINE_CHANGELOG: ReadonlyArray<{ version: number; note: string }> = [
  {
    version: 1,
    note:
      "Batch 4.5 (2026-09-14): the first pinned engine. Includes Batch 3 (operating-corporation identity, " +
      "station legality in the authority) and Batch 4 (train availability with the Bank Pool, the mandatory " +
      "purchase gate, discards to the pool). Logs dealt before this are legacy: unversioned, and never " +
      "reinterpreted by a server.",
  },
  {
    version: 2,
    note:
      "Batch 4.6 (2026-09-14, #1530): automatic cheapest-first excess-train trimming at a phase change is " +
      "replaced by the president's explicit `DiscardTrain` actions (rulebook 6.6.1: the president chooses; " +
      "highest share value decides first; the train goes to the Bank Pool). A version-1 log carries no such " +
      "choices -- its excess trains were removed by the reducer, not by an entry -- so it is not replay-" +
      "compatible with this semantics and is refused, never reinterpreted.",
  },
  {
    version: 3,
    note:
      "Batch 5 (2026-09-14, #1540): the forced train purchase is an interactive, derived obligation " +
      "(rulebook 6.6.2/6.6.3/6.7). The president's contribution is authoritative (the corporation spends " +
      "all its money, the president covers the difference); forced stock sales are the ordinary SellStock " +
      "under 6.6.3's rules (the rescued corporation's presidency may not change; only enough is sold; no " +
      "sale once treasury and cash cover the price); bankruptcy is derived when no legal forced sale " +
      "remains and ends the game at once (`GameEnd`, `bankrupt_president`); the bankrupt player is scored " +
      "by the shares he could not sell and may win; ordinary play is held while the obligation stands and " +
      "after the end. No new message type. A version-2 log has no forced sales, no president-only " +
      "authority on the emergency purchase and no reducer-recorded ending, so it is refused, never " +
      "reinterpreted.",
  },
  {
    version: 4,
    note:
      "Batch 6 (2026-09-15, #1550-#1553): routes and revenue are authoritative. `RunMultipleRoutes` is " +
      "judged by the engine's route evaluator (`routeAuthority.ts`, rulebook 6.4/6.4.1/6.4.2/6.3.3/6.5): " +
      "every train named must be the corporation's, named once, no more routes than trains; each route is " +
      "re-walked on the board's rail model (continuous, no reversal at a junction, no crossover change, no " +
      "track reused within or between the corporation's routes, full cities not run through, red areas " +
      "terminal only, a station of the corporation on the route, no city counted twice, at least two " +
      "cities, no more than the train's number; a route begins and ends at any city -- large, small (a town) " +
      "or a red area, per 6.4 / 6.4.2, S6-10); a run worth less than the combination the route search " +
      "demonstrates for the same fleet is refused (6.4, S6-3 -- a lower bound, never a ceiling); revenue is " +
      "the evaluator's, never the message's; one run per turn. `DeclareDividends.revenue_amount` must equal `last_route_revenue` (audit C1). At Run " +
      "Trains, a skip or end of turn is refused while a paying route exists. `RunManualRoute` is refused on " +
      "a pinned board (legacy replay only). `SetupGame` copies the pin onto the state " +
      "(`rules_engine_version`). A version-3 log carries runs the reducer priced without judging and " +
      "dividends it paid from the message, so it is refused, never reinterpreted.",
  },
  {
    version: 5,
    note:
      "Batch 7 (7.1-7.5, 2026-09-15/16, #1560-#1598): transactions, cash and the auction are authoritative. " +
      "7.1: one money ledger (`cashLedger.ts`) -- no floored adjuster mints or destroys money; auction " +
      "proceeds and terrain fees are credited to the Bank; the Bank is signed and `bank_broken` is latched by " +
      "the debit that empties it and never cleared by a receipt; a purchase the payer cannot cover is refused. " +
      "7.2: `BuyStock` / `SellStock` are Stock Round actions (the 6.6.3 forced sale excepted); the IPO price " +
      "is the corporation's par and the pool price the chart's; the President's Certificate needs a ladder " +
      "par; an undeliverable source is refused; first-Stock-Round and unparred sales are refused; the Brown " +
      "continuation names `bought_this_turn_company`. 7.3: no bid on the lowest private; escrow-aware bids " +
      "and a $5 minimum raise; the main rotation is frozen during a contest; a contest pass keeps the bidder " +
      "(`passes_since_raise`); the all-pass markdown is the Schuylkill Valley's alone and private income is " +
      "paid only once the SV has sold; a refused auction message is refused whole. 7.4: one ordinary offer " +
      "at a time under a global hold; corporate private purchases, intercorporate train sales and the " +
      "player-to-player private trade are judged at proposal, answer and settlement, with consent and " +
      "counterparties re-derived from the board; direct unconsented settlements are refused; every ordinary " +
      "offer carries a log-derived `instance` (`offer_serial`) that keys its derived settlement; " +
      "`BidOnPrivate` and the `AcceptTrainOffer` family are refused on pinned boards. A version-4 log carries " +
      "purchases, auction steps and settlements the reducer let through without these rules, so it is " +
      "refused, never reinterpreted.",
  },
  {
    version: 6,
    note:
      "Stage 8 (8.1-8.5, 2026-09-16/17, #1600-#1640): the Operating Round's order, the home station, the " +
      "presidency and the Mohawk & Hudson are authoritative. 8.1: the operating order is settled once per " +
      "entry on the COMMITTED post-rise chart (rulebook 6.0/6.1) -- round membership and the operated / " +
      "operating prefix are frozen, the not-yet-operated tail is re-sorted whenever a token moves, and the " +
      "6.0 tie-break is price, then rightmost column, then uppermost row, then earliest arrival; the " +
      "end-of-Stock-Round sold-out rise is committed before the opening queue is read, so a riser that " +
      "overtakes a rival operates ahead of it. 8.2: a corporation's home station is placed at the start of " +
      "its FIRST OPERATING TURN (6.3.1), not at its float -- the obligation, its legality (a candidate home " +
      "hex, a legal circle) and its hold are one authority asked by the reducer and by ingress alike, the " +
      "Stock-Round seat hold is retired, and the four mandatory holds are asked ABOVE the auction and chart " +
      "atoms so a held message cannot move the market before it is refused; the Erie's (and, under the Level " +
      "Playing Field, the PMQ's) two-city home hex is closed to every other corporation's station once a tile " +
      "is on it and until the home is placed, and the C&O's first home is its owner's choice of Cleveland or " +
      "Richmond with Richmond reserved until then. 8.3: the presidency is settled immediately from the " +
      "holdings (5.4) -- a challenger must hold strictly more, and tied challengers are resolved CLOCKWISE " +
      "from the displaced president's seat rather than by the order the holdings array happens to carry; the " +
      "transfer is certificate-safe on a Scenario-D corporation, where the successor may return the printed " +
      "other-20 card instead of two ordinary tens, and a half-sale of that card requires a 10% certificate " +
      "already in the Bank Pool. 8.4: the M&H exchange is judged rather than applied -- ownership, the NYC " +
      "target, `keep_open`, the physical availability of an ORDINARY 10% certificate, the 60% cap and the " +
      "projected certificate limit, at the reducer and at ingress; it is a free interjection that consumes no " +
      "purchase and moves no seat, streak or Priority Deal; the owner's chosen source is used and never " +
      "substituted; a request made while another player's or corporation's turn is underway is recorded as " +
      "`pending_mh_exchange` and settled -- after full revalidation -- at the next between-turns boundary, " +
      "before any new Operating Round membership is built; and the exchange settles the float threshold " +
      "(shared with `BuyStock`) and the presidency. 8.5: the share-price nominal is gone from the forced-sale " +
      "projection -- an unparred corporation has no price, so it is skipped rather than valued (S8-8). " +
      "A version-5 log carries an operating order frozen on a stale chart, home tokens placed at the float, " +
      "presidencies settled by holdings order and M&H exchanges applied unjudged, so it is refused, never " +
      "reinterpreted.",
  },
  {
    version: 7,
    note:
      "Stage 9 (9.1-9.5, 2026-09-18/19, #1620-#1673): the board, the tile catalog and the Yellow Sign are " +
      "authoritative, and the turn's randomness is the server's. 9.2: `immutableHexRefusal` is rule 0 of the " +
      "placement filter, ported from `hexmap.rs` and shared with the click gate so the message a player is " +
      "shown and the refusal a replay applies cannot drift; `priorTopologyAt` feeds rule 5 the hex's LIVE " +
      "topology, so board-PRINTED track is preserved on a first lay and not only track a tile laid; revised " +
      "6.2.2 (4)'s station anchoring and slot capacity move from the shell into the reducer " +
      "(`stationAnchorAuthority`), ahead of every mutation; and the Level Playing Field gains T-02's seventh " +
      "board tile, the printed straight at M-11, which is in the INITIAL grid and therefore changes the board " +
      "every LPF log is replayed against from index 0. 9.3: revised 6.2.2 (4)'s separation clause is tile " +
      "metadata on old #59 alone, and `separationPreserved` is rule 5b of the filter -- the first rule to " +
      "compare CONNECTIVITY rather than segments, so the two pre-printed exits of a #59 can never be joined " +
      "by an upgrade; #63's physical supply is corrected 1 -> 4 ahead of every scenario removal; and the " +
      "three tiles whose printed old numbers the official errata voids carry a canonical rules identity, " +
      "with the integers kept as the stable storage key. 9.4a: a Blood Price landing is stamped as a market " +
      "ARRIVAL, so the 6.0 tie-break can see it. 9.4b: the D&H's free station is judged by the D&H's own " +
      "conditions at both locks -- its hex, the owning corporation, once, and the base game's rule that a " +
      "station not placed on the turn the tile is laid needs an ordinary connected one -- and a refusal no " +
      "longer consumes the private's power. 9.4c: the stock market steps once per PHYSICAL CERTIFICATE rather " +
      "than once per 10%, so the Scenario-D other-20 sold as a block drops the token one row and not two; " +
      "proceeds stay percentage-based. 9.4d: the Yellow Sign's outcome is DERIVED by the authoritative " +
      "reducer from the committed board -- the stage, the corporation's train, the Mark's award and the gift " +
      "are no longer carried on the message, and a client cannot choose the result of a random event; the " +
      "turn's draw and turn key are supplied by the SERVER at ingress before the entry is committed, so a " +
      "crafted client can no longer grind seeds, and the playtest waiver is dropped at ingress and refused " +
      "by the reducer on any pinned board. 9.5: the Bank Pool caps at FIVE PHYSICAL CERTIFICATES rather than " +
      "50 percentage points (the Scenario-D other-20 is one card); the C&SL's special is a bonus LAY with no " +
      "upgrade right; the Mark nullifies only the vanished train's run and the fleet's other legal revenue " +
      "still pays; and the Carcosa lifecycle is corrected -- the gilded train's train-limit exemption lasts " +
      "as long as the gilding instead of expiring at the next Operating Round boundary (which had been " +
      "trimming an ORDINARY train in its place), the doom clock starts on whichever of the gift and the first " +
      "REAL Diesel purchase lands second, the gift's model is the depot's lowest-value train rather than the " +
      "phase's tier, and a Blood Price carries the train's SYNTHETIC provenance to the buyer while burning " +
      "the gilding off. A version-6 log carries tile lays judged without the board's printed topology, " +
      "station placements judged only in the shell, Yellow Sign outcomes chosen by a client and market steps " +
      "walked per ten percent, so it is refused, never reinterpreted.",
  },
  {
    version: 8,
    note:
      "Stage 10 (10.1-10.6, 2026-09-22/23, #1681-#1697): a declined action leaves every authoritative atom where it " +
      "stood, the tile lay is one atomic authority, and the server composes the reducer's context exactly as the " +
      "browser does. REPLAY SEMANTICS. 10.1 / 10.1b (#1681-#1684): `LayTile` legality is composed BEFORE any " +
      "mutation (`layTileLegalityRefusal`: identity, Lay Track timing, geometry, station anchoring, the JK, the " +
      "terrain fee) and asked by the reducer's gate block, both grid steps and live ingress, so a refused lay no " +
      "longer lands on the grid, spends a power or the JK, or advances the operating cursor; on a pinned board a lay " +
      "off the Lay Track step is refused (unpinned history keeps its representation). 10.2 (#1686): an author-less " +
      "duplicate corporation-train settlement is refused unless the board's own consent stands. 10.3 (#1690): " +
      "`App.tsx` and `RoomEngine` build the reducer's context with one builder (`sandboxActionContext`), so the " +
      "server's authority now receives the Carcosan-sale context and the SERVER charges the Blood Price on a legal " +
      "Carcosan transfer (it never did), while no client charges it for a refused one. 10.3b (#1691): the chart step " +
      "is a transaction with the core -- a speculative stock-market move is discarded when the core declines the " +
      "action, closing the dividend-amount and author-less-sale chart leaks. 10.5 (S10-9): a new " +
      "`ProposePrivatePurchase` writes the canonical whole-VGP string price; a stored numeric price stays " +
      "replay-compatible and is kept verbatim; a malformed spelling such as \"1e2\" is no longer accepted as an " +
      "equivalent whole-VGP private-purchase price. 10.6 (#1692-#1697), ON PINNED BOARDS (#1696, " +
      "`stage106LayAuthorityInForce`): a lay must connect to the corporation's network; a C&SL, D&H or JK claim is " +
      "validated from the board, so a forged bonus cannot manufacture an extra lay or keep Track open, and the " +
      "C&SL's bonus and the ordinary lay may come in either order, each once; a player-owned private's hex is barred " +
      "(SV G15, C&SL B20, M&H D18, C&A H18, B&O I13 / I15, and the JK's K9 / K11 under the Level Playing Field, " +
      "separate from its Coal River power), except the D&H's F16, where an ordinary connected lay is allowed and " +
      "forfeits the D&H's special effect. Gray and red bare lays were already refused by 9.2's immutable-hex rule. " +
      "TRANSPORT AND TOOLING, NOT RULES, named so the row is not read as them: 10.2's refusal transport (#1685 -- a " +
      "submission whose authoritative content is unchanged is answered `refused`, never appended as a game action, " +
      "and its nonce may be retried; harmless duplicate answers stay applied), 10.4's smoke harness, " +
      "discard-adapter and id-less-export repairs (S10-5, S10-22, S10-23: deterministic collision-safe ids, " +
      "duplicate real ids rejected) and 10.5's one log-wide message type (`SandboxLogMsg`). The canonical " +
      "development corpus is unpinned and replays unchanged. A version-7 log carries lays judged after they had " +
      "moved the board, lays neither connected nor claim-checked, player-owned private hexes built on and a server " +
      "that never charged the Blood Price, so it is refused, never reinterpreted.",
  },
  {
    version: 9,
    note:
      "Gentle Rust certification closure (GR-5, 2026-09-24, #1705): the standalone Gentle Rust variant is certified, " +
      "and the replay semantics of GR-1, GR-2 and DT-1 (#1699-#1701) take this one bump. REPLAY SEMANTICS, exactly " +
      "four. (A) GR-1 (#1699): a SELF-TRIGGER -- a corporation buying the phase-changing train in its own Buy Trains " +
      "step -- no longer expires the trains it dooms at the end of that same turn; they survive the turn's end (and " +
      "the Stock Round, when the set ends) into the corporation's NEXT FUTURE Operating Turn, which is their grace " +
      "turn (`pending_rust_doomed_this_turn`: the Run Routes expiry and both turn-end fallbacks spend only the " +
      "qualifying turn's marks). (B) GR-2 (#1700, OD-GR-1): a reprieved / Final Run train may no longer be sold or " +
      "transferred to another corporation -- refused at proposal, answer and settlement, by multiset, so an ordinary " +
      "copy of the same model still sells. (C) GR-2 (#1700, OD-GR-2): a reprieved / Final Run train may no longer be " +
      "used as a Diesel trade-in, at the $800 exchange or the Level Playing Field's $750, by multiset. (D) DT-1 " +
      "(#1701, a base-game correction on every table): being at the train limit no longer auto-ends Buy Trains while " +
      "a legal one-for-one Diesel exchange remains available. None of the four asks the pin's value. NOT RULES, named " +
      "so the row is not read as them: GR-3's UI, copy, Rules Reference and narration (#1702); GR-4's certification " +
      "tests, documents and constructed legal certification game (#1703); and GR-4's owner-ruled U-9 post-game " +
      "statistics correction (#1704: a Gentle Rust train is booked as lost when it is destroyed, not when it is " +
      "marked -- derived history only). None of them moves a board, a message or a digest. NOT DECIDED HERE: " +
      "OD-GR-3 (the Yellow Sign's cheapest-train removal against a reprieved train) belongs to Unpredictable Revenue " +
      "certification, so combined Gentle Rust + Unpredictable Revenue is not certified by this row. The canonical " +
      "development corpus is unpinned and replays unchanged. A version-8 log can carry self-doomed trains destroyed " +
      "at the end of the turn that doomed them, reprieved trains sold or traded in for a Diesel, and Buy Trains " +
      "steps auto-ended at the limit with a legal exchange still open, so it is refused, never reinterpreted.",
  },
  {
    version: 10,
    note:
      "Unpredictable Revenue certification closure (UR-8, 2026-09-25): the Unpredictable Revenue variant -- standalone and " +
      "with Gentle Rust (OD-GR-3) -- is certified, and the replay semantics of UR-3, UR-4 and UR-7 (`9d0cf3a`, `a6183b5`, " +
      "`ff7a04b`) take this one bump. REPLAY SEMANTICS, exactly eight. (1) UR-3 (OD-UR-1): on a pinned Unpredictable " +
      "Revenue table the Yellow Sign is an AUTOMATIC consequence of the accepted run, resolved and applied inside the run's " +
      "own entry (`settleRunYellowSign`, recorded as `last_run_yellow_sign`); on every pinned table, with the variant or " +
      "without it, a client `YellowSignEvent` is refused at ingress and in the reducer. (2) UR-3 (OD-GR-3): the Mark judges " +
      "the POST-SETTLEMENT fleet -- a Gentle Rust Final Run train is retired first and is never a candidate -- and nullifies " +
      "only the taken train's own route, the run's breakdown being the authority's pairing. (3) UR-3 (OD-UR-2): the " +
      "gold-trimmed train leaves at the END of Operating Round set N+1, at the set boundary (`fogAtSetEnd`), never on a " +
      "run. (4) UR-3 (OD-UR-3), every table: a synthetic Carcosa train never advances the phase (`derivePhase`); the first " +
      "REAL train of its tier does. (5) UR-3 (OD-UR-7), every table: a gilded train is never a Diesel trade-in, at the $800 " +
      "exchange or the Level Playing Field's $750; an ordinary copy of the same model still trades. (6) UR-4 (OD-UR-5), " +
      "every table: the Blood Price names the COPY -- an optional `gilded` on `BuyTrainFromCorporation` / " +
      "`ProposeTrainPurchase`, an unnamed sale of a model the seller holds both gilded and ordinary refused, only the gilded " +
      "copy's sale the Blood Price; the BUYER's marker moves Left 1 / Down 1 and the seller's never; the cured train is an " +
      "ordinary additional train whose synthetic origin is supply provenance only, kept through the Bank Pool " +
      "(`returned_ghost_trains`) so the Depot tally, the phase and the real-D check never count it as printed stock. (7) " +
      "UR-7 (OD-UR-10 = 10-C), every table: an exact $5 tie of the modified revenue rounds toward the printed total " +
      "(`roundRevenueTowardPrinted`); every other amount rounds to the nearest $10 as before. (8) UR-3 (OD-UR-13): the " +
      "Mark's taken train is permanently removed from the game (`removed_trains`, never the Bank Pool) -- counted toward the " +
      "phase and off the depot, never purchasable -- so phase progression is monotonic. None of the eight asks the pin's " +
      "value. NOT RULES, named so the row is not read as them: the Mark's award stays minted (OD-UR-4, unchanged); UR-5's " +
      "statistics basis (OD-UR-6: paid corporation revenue, printed completed routes per train, a Mark-nullified route " +
      "nothing, the gift no purchase, the Blood Price the buyer's -- derived history only); UR-6's UI, copy, Rules " +
      "Reference and naming (OD-UR-8, OD-UR-12); UR-7's Rules Reference tie sentence, the debug chip's visibility " +
      "(UR-N62), the certification tests, documents and constructed certification game; the undo rule (OD-UR-11, " +
      "unchanged); and the seed source (OD-UR-9, deferred to AWS / live multiplayer -- recorded draws replay identically). " +
      "None of them moves a board, a message or a digest. Unpinned (Firestore-era) boards keep the legacy Yellow Sign " +
      "request path (S10-11). The canonical development corpus is unpinned and replays unchanged. A version-9 log can carry " +
      "client-sent, omitted or redirected Yellow Sign requests, a Mark that took a Final Run train or returned its train to " +
      "the depot, a gold-trimmed train removed on a run, a gift that turned the phase, a gilded trade-in, a model-level " +
      "Blood Price that moved the seller and a +10% tie paid half up, so it is refused, never reinterpreted.",
  },
  {
    version: 11,
    note:
      "Delayed Auction certification closure (DA-8, 2026-09-27): the Delayed Auction variant is certified (DA-7, `79d6f10`, " +
      "`14d0c64`), and the replay semantics of DA-3, DA-4, DA-5, Phase 2A's RR2A-F1 and DA-8's DA-F12 (`66847e0`, `387ade9`, " +
      "`a6ef5e7`, `445b9a4`, this closure) take this one bump. Phase 2's rules-engine closure. REPLAY SEMANTICS, exactly ten. " +
      "(1) DA-3 (DA-F1), every table: an auction message is refused at ingress and in the reducer unless the auction is " +
      "live -- the round being played, its atom active -- so a dormant or finished atom is never moved, and a forged " +
      "`WaterfallPass` after an auction no longer pays private income or counts as a Stock Round pass. (2) DA-3 (DA-F2), " +
      "every table: `SetBoPar` names the B&O private's owner and is refused while the B&O is locked. (3) DA-3 (DA-F7), " +
      "every table: the B&O par is owed before the auction hands off (`OpenStockRound` refused while it is owed) and the " +
      "President's Certificate is the BO owner's. (4) DA-4 (DA-F3), Delayed Auction: the auction opens on the Priority " +
      "Deal holder (the atom's cursor and the board's seat), not on dealt seat 0. (5) DA-4 (DA-F4, DA-F5), every table: " +
      "the Priority Deal the auction hands to the Stock Round is the seat left of its last DIRECT purchaser, read from the " +
      "atom's cursor (`auctionPriorityDealSeat`), and the seat re-seats on the cursor after every main-rotation auction " +
      "message -- so a $0 Schuylkill Valley taking no longer leaves Stock Round 1 with the taker. (6) DA-5 (D-52, DA-F6), " +
      "Delayed Auction: one 10% PRR certificate is reserved in the IPO for the C&A from the deal " +
      "(`reserved_certificate`), no ordinary purchase takes it, and the grant moves exactly it and settles the float and " +
      "the presidency at once; on every table a grant never mints from a pile holding less than 10%. (7) DA-5 (D-53, D-57, " +
      "D-58, D-59): the must-sell debt is its CURABLE part only, on every table, and holds the Stock Round pass at both " +
      "locks (#759 (iii)), not in the shell alone; at a Delayed Auction table a voluntary face-value purchase, bid or " +
      "raise that would leave an excess the next Stock Round cannot cure is refused, and an award from a bid legal when " +
      "accepted is honoured. (8) DA-5 (D-55, DA-F9), Delayed Auction: the first 5-train while the auction is still owed " +
      "cancels it for good -- `private_auction_complete`, the unsold privates closed and no longer offered, the " +
      "reservation released, the B&O unlocked. (9) RR2A-F1 (Phase 2A), every pinned table: `BeginOperatingRound` is " +
      "refused in every round and a Stock Round / Operating Round `PassTurn` inside the auction is refused " +
      "(`roundTransitionRefusal`) -- rounds advance only by themselves. (10) DA-8 (DA-F12), every table: after the " +
      "revenue all-pass (the SV sold) the buy-bid-turn sequence resumes with the Priority Deal holder, the seat left of the " +
      "last direct purchaser (`auctionPriorityHolder`), not with the seat after the last passer. (9), and (7)'s reading " +
      "of a sale's chart price, ask whether a pin EXISTS (#1698's presence rule, as the 10.6 lay seam does); none of the " +
      "ten asks the pin's value. NOT RULES, named so " +
      "the row is not read as them: DA-6's UI, copy, tutorials, Rules Reference and Activity Log lines (DA-F8, DA6-N1, " +
      "DA6-N2's sentence, DA6-O1, DA6-O2); C2-02 (`79d6f10`: a harmless duplicate consent answer is settled for its " +
      "sender and no longer appended -- a stored one replays as the no-op it always was); LIVE-2's ingress, schema, " +
      "revert-reach (RV-2 ... RV-7) and room authority, which judge what may be APPENDED and never what a stored entry " +
      "means; RR2A-F2 and DA-7's certification tests, documents and certification game G-DA; and DA7-L1 (a refusal's " +
      "wording at ingress, deferred). None of them moves a board, a message or a digest. SETTLEMENT IS A SEPARATE AXIS: " +
      "`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` stays [10] -- v10 boards appraise byte-for-byte as certified, and " +
      "money settlement of a v11 board is refused until the appraisal is recertified for v11 (owner ruling, DA-8). The " +
      "canonical development corpus is unpinned and replays unchanged (its three revenue all-passes already resume on the " +
      "holder; it holds no $0 taking). A version-10 log can carry auction messages sent outside the auction, a B&O par " +
      "taken by a non-owner or skipped at the handoff, a Delayed Auction opened on seat 0 or handing the Priority Deal to " +
      "the wrong seat, a C&A grant that minted a share or left the float and presidency waiting, a Stock Round passed " +
      "over a curable excess, an owed auction that outlived the first 5-train, an Operating Round started by message " +
      "and an auction resumed on the wrong seat, so it is refused, never reinterpreted.",
  },
  {
    version: 12,
    note:
      "Route v12 R12-2 (2026-09-29): the production route engine repaired against the independent R12-1 oracle and the " +
      "owner's route rulings. REPLAY SEMANTICS, every one asked only on a PINNED board (#1698's presence rule, carried as " +
      "the board in effect: `boardFor(variants, routeRulesRevisionOf(state))`); an unpinned development-corpus board " +
      "keeps the pre-v12 law, search and board data (`*_BOARD_PRE_V12`), so it replays unchanged and the frozen SET-0A " +
      "settlement goldens built from it (SYN-05, SYN-07) are byte-identical. (1) THE ROUTE LAW (`routeWalk.ts`, the one " +
      "walk the authority and the search both ask): a red off-board area is ONE city across its hexes, so the same area " +
      "may not be both ends of a route (Canadian West A9 + A11, the Gulf I1 + J2, Chattanooga K1 + L2; rulebook 6.4.2's " +
      "DABCFED; IL-5); a station recorded without a city, and PRR's H12 herald, count only where the route VISITS the " +
      "stop, never at a bypass (IL-7: Altoona's bow; IL-3 NO: an uncounted herald pass is not PRR's home); Coal River " +
      "(L8) is closed to an unlicensed corporation as an END as well as a pass (at ingress too). (2) PRICING: a bypassed " +
      "waypoint is skipped before the per-city dedupe, so a stop passed and later counted on distinct track is paid once " +
      "(IL-11). (3) THE DEMONSTRATION (S6-3's shortfall, the skip refusal, the auto-skip, the forced-purchase probe): the " +
      "search re-enters a plain hex on its other section of track (IL-11: CROSS_TWICE) and may pass the owner's herald " +
      "again after counting it; it joins two arms at a station only where the rails join them through the stop (S6-16: " +
      "the H12 fork; ING-1: New York's two cities); it keys red areas by area and never touches a barred hex; every " +
      "candidate is judged by the authority's own walk before it can be demonstrated, and `maxRouteRevenueFor` returns " +
      "only a set `evaluateRouteSet` accepts -- so no demonstrated figure is one the authority refuses, and no corporation " +
      "is stranded at Run Trains by one. (3a) EXACT OPTIMALITY (Route v12 R12-4, 2026-09-30, folded into v12 before it " +
      "merged): the demonstration is the TRUE maximum, no longer a bounded heuristic's lower bound (`routeExactSearch.ts`): " +
      "every route the authority's walk accepts (grown out of each station point, pruned only where the walk refuses " +
      "every extension), then the best compatible set by exact branch and bound (admissible bound, identical-train " +
      "symmetry), each chosen route re-judged by the walk and the set by `evaluateRouteSet` -- a disagreement or an " +
      "explicit search ceiling is raised, never answered with a smaller figure. Ties go to the first set in a fixed order " +
      "(routes by revenue, then waypoint text; trains widest first). So S6-3's shortfall, the skip refusal, the auto-skip, " +
      "the forced-purchase probe and Auto Route all read one exact figure, and on a v12 board a submitted set below it " +
      "is refused where R12-2's figure let it through (the R12-1 oracle's $170 against $150). (4) BOARD DATA, 1830+ and the Level " +
      "Playing Field (owner-confirmed from the physical board, R12-1 closure): Montreal A19 pays $40 / $60 and Norfolk " +
      "L16 $30 / $50 (the lesser until the first 5-train; `printedCityTiers`), and each is ONE city with TWO station " +
      "circles, for placement as for blocking (`stationSlotCount` believes a printed city's `slots`) -- superseding " +
      "#1401's single-station ruling -- so a second corporation may station there and one foreign token no longer shuts either to " +
      "through-running (N&W's home takes one of Norfolk's). (5) ING-1: a paid station placement on a hex with two cities " +
      "must name its city. (6) TILE #62 (owner ruling 2026-09-29, folded into v12 before it merged): brown New York #62 " +
      "pays $80 per city, not the $90 the catalog carried -- a conflation with the 1830+ / LPF New York tile #883, which " +
      "stays $90 (`tileRevenue.ts`, the one revenue accessor; pre-v12 boards keep $90). NOT RULES, named so the row is not read as them: hosted ingress now opens the table's own " +
      "board once at `turnRefusal`'s entry (S6-15, F-1) -- it decides what may be APPENDED, never what an entry means; " +
      "the renderer's era-aware Montreal / Norfolk badge and restored two-circle pill; the oracle's test pins. NOT " +
      "CHANGED: the standard map's flat $40 Montreal; tile #883's $90. SETTLEMENT IS A SEPARATE AXIS: R12-2 left " +
      "`SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` at [10, 11], so a v12 board was refused for money settlement until " +
      "v12's own certification pass -- R12-3 (2026-09-29), which added 12 on its own evidence (`settlementV12Certification`). A version-11 log can carry a run from one red area to the same area's other hex, a run " +
      "counting a bare token at a bypassed city or an uncounted herald as its station, an unlicensed run ending at Coal " +
      "River, dividends priced on Montreal / Norfolk's flat figures or on #62 at $90, a run past a one-circle Norfolk or Montreal a v12 " +
      "board no longer shuts, shortfall and skip refusals against the old (heuristic) demonstration, and a city-less placement on " +
      "New York, so it is refused, never reinterpreted.",
  },
  {
    version: 13,
    note:
      "Phase 3 W3-K (2026-10-03): the Stock Round turn and emergency-funding corrections the Phase-3 verification " +
      "(V13_SCOPE_VERIFICATION) resolved, all switched by RULES REVISION 2 (`variants.rules >= 2`; `passEndsStockTurn`, " +
      "`brownPoolContinuationInForce`, `automaticEmergencyFundingInForce` in `gameVariants.ts`), which every hosted v13 " +
      "deal is stamped with -- so unpinned development history (revision 0 / 1) replays unchanged. (1) OD-2: ONE " +
      "`PassTurn` ends a Stock Round turn (no stage move first); a sale stays legal before and after the one ordinary " +
      "purchase; a true pass (no action this turn) counts toward the all-pass streak and an acted turn end does not; " +
      "must-sell, the sold-this-round lockout, Priority Deal and rotation are unchanged. (2) SBS-3 / SBS-4, THE OFFICIAL " +
      "BROWN RULE: an explicit turn-scoped continuation (`brown_pool_continuation_company`) opened only by a Brown-zone " +
      "purchase from the Bank Pool; it admits further Bank Pool certificates of that ONE corporation and closes on any " +
      "sale, `PassTurn`, seat advance, round end, every purchase-state reset and (owner ruling 2026-10-04) any other " +
      "accepted state-changing turn action of the active player -- an accepted private trade, an M&H exchange -- but " +
      "never on another player's off-turn answer or on derived bookkeeping; IPO then Pool, Pool then IPO, Pool / " +
      "sell / Pool, Pool in one corporation then Pool in another, and any second non-Brown purchase are refused. NOT " +
      "IMPLEMENTED: V-6.3 'Buy All'. (3) OD-4, EMERGENCY FUNDING: the intercorporate trade window is budgeted at treasury " +
      "plus the president's cash and is closed for the obligation by any decision (`ForgoTrainTrade`, a private offer, " +
      "a sale) and never reopens -- a trade funded by liquidation is refused; the treasury-plus-cash purchase is made " +
      "automatically (a derived `EmergencyBuyHardware`, keyed per operating turn); share raising is ONE atomic " +
      "`EmergencySellPortfolio` (submitted order kept, every leg an ordinary sale, simulated and proven before any " +
      "board moves, 'only enough' judged over the whole portfolio with the smallest legal overshoot, a portfolio that " +
      "cannot fund the purchase refused -- no self-made bankruptcy) and the single forced `SellStock` is refused; " +
      "private-company funding stays optional (`ForgoPrivateFunding` declines it) and holds the game only while a " +
      "legally valid private sale or sequence of sales could complete a rescue (judged exactly, never by a loose bound); " +
      "bankruptcy is AUTOMATIC once the " +
      "exact insolvency oracle proves no window, offer, private or portfolio can fund the train: everything legally " +
      "saleable is sold, the president's cash goes to the obligated corporation, and the game ends (`bankrupt_president`). " +
      "`DeclareBankruptcy` is refused on a board of rules revision 2. Per-obligation marks: `emergency_funding_marks`. NOT RULES, " +
      "named so the row is not read as them: the closed schema's three new kinds (52) and the hosted ingress refusals. " +
      "NOT IN THIS ROW: DH-1, GR-1 / S10-27, GR-1b (UI only), D-18 (invalid), D-22 (already correct), RR-4. LIVE LIST: " +
      "[13] alone (owner policy: pinned v12 rooms are drained before deployment, no dual support). SETTLEMENT IS A " +
      "SEPARATE AXIS: `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` stays [10, 11, 12], so a v13 board is refused for " +
      "money settlement until v13's own certification pass (`docs/phase3/V13_SETTLEMENT_CERTIFICATION_VECTORS.md`). A " +
      "version-12 log can carry a two-message Stock Round turn end, a Brown Bank Pool purchase continued after a sale " +
      "(SBS-3), after an IPO purchase (SBS-4) or across another turn action, a single forced sale, a president-sent " +
      "emergency purchase and a declared bankruptcy, so it is refused, never reinterpreted. (A second Brown Pool " +
      "purchase in ANOTHER corporation is not among them: #1570's same-corporation guard has refused it on every board " +
      "that records `bought_this_turn_company`; only history older than that guard can hold one.)",
  },
];

/** The log's SetupGame field. Named apart from `build` (client identity) and `variants.rules` (a house-rules
 *  revision the reducer branches on) because it is neither. */
export const RULES_ENGINE_VERSION_FIELD = "rules_engine_version";

/* ==================================================================
    DESIGN NOTE 1696 (Stage 10.6): THE LEGACY / PINNED SEAM FOR THE STAGE-10.6 LAY AUTHORITY
   ==================================================================
   OWNER RULING (Stage 10.6, after the corpus stop): the three `LayTile` rules Stage 10.6 adds -- connectivity to the
   network (S6-5, #1692), the validated private-power claim and the one-ordinary-lay entitlement (S6-6, #1693) and
   the player-owned private's hex (S6-7, #1694) -- are asked ONLY on a PINNED board, one carrying a numeric
   `rules_engine_version`. Every room a server has dealt since #1520 is pinned, so every live table is judged.

   A LEGACY board -- no pin -- is a development record written before the rules engine was pinned, and it keeps the
   interpretation it was played under. Measured, unconditionally imposed, the three rules change 15 distinct stored
   lays in four legacy rooms (CV4, FCJ, Z6C, Y8V), which the corpus carries as 21 file-occurrences across seven files
   -- the Stage-10.6 ledger in `RULES_HARDENING_BACKLOG.md` (S6-5) itemises them. *(Stage-10 closure, #1698: an
   earlier draft of this note said "20 stored lays in six histories", a miscount of the same probe.)* They are
   EVIDENCE of the historical authority gaps, not new legacy replay expectations: no golden is repinned. Exactly the
   #1684 (the Lay Track step) / #1551 (`RunManualRoute`) precedent.

   PRESENCE, NOT A VERSION NUMBER (Stage-10 closure, #1698). The seam asks whether a pin EXISTS, never which one: the
   question it answers is "pinned engine history" versus "legacy unpinned history", not "v8" versus "before v8". The
   7 -> 8 bump therefore leaves it exactly as written -- a v8 board is judged because it is pinned, and a v7 board
   never reaches it on a v8 server because `replayRefusal` holds the room before a single entry is applied. Do not
   rewrite it as `version >= 8`.

   ONE PREDICATE. The `LayTile` authority (`layTileAuthority.ts`), the player-owned-private status that the board
   draws and the click answers (`privateReservations.ts`), and the cursor's entitlement bookkeeping
   (`sandboxSession.ts`) all ask this function -- so the UI cannot mark a legacy hex the replay deliberately leaves
   open. Every rule that existed BEFORE 10.6 (the holds, identity, timing on a pinned board, geometry, the Stage-9.2
   immutable gray / red hexes, anchoring, the JK, the terrain fee) is untouched by it. */
export function stage106LayAuthorityInForce(
  state: { rules_engine_version?: number | null } | null | undefined,
): boolean {
  return typeof state?.rules_engine_version === "number";
}

export type ReplayCompatibility =
  /** The deal names a version this engine supports. */
  | { kind: "compatible"; version: number }
  /** The deal names a version this engine does not support. */
  | { kind: "incompatible"; version: number; supported: readonly number[] }
  /** The deal carries no version: written before #1520. */
  | { kind: "legacy" }
  /** No deal stands in the effective log -- nothing to be compatible with yet. */
  | { kind: "undealt" };

/** How a caller treats a log that predates the pin. Stated, never defaulted to "allow". */
export interface ReplayPolicy {
  legacyLogs: "refuse" | "development-corpus";
  /** #1530: what a LEGACY log's excess trains mean -- BEST-EFFORT DEVELOPMENT-CORPUS COMPATIBILITY, NOT
   *  HISTORICAL-FIDELITY REPLAY, AND DEVELOPMENT-ONLY. Every log before version 2 was played on an engine that
   *  removed excess trains itself, cheapest-first, and wrote no entry for it, so the log is silent exactly
   *  where version 2 expects a `DiscardTrain`. `"engine-chose-cheapest"` has `replayLog` supply that one
   *  choice, as `DiscardTrain` entries applied through today's arm and appended nowhere, so the golden and
   *  replay fixtures can still be read end to end. It does NOT make the replay faithful to the engine that
   *  played the log: every other version-2 rule (the limit judged in force at the purchase, the pool counting
   *  toward the phase) still applies, and a legacy log can diverge from its own play for those reasons
   *  (JUNO-FCJ, index 474). `"refuse"` -- the default, and the only value the server ever carries -- leaves
   *  the obligation standing, where it blocks the rest of the log; that is what "not replay-compatible"
   *  means. Only consulted for a `legacy` log; a log pinned to version 1 is refused outright, whatever this
   *  says. Never a production restore policy: `start.ts --legacy-logs` does not reach it (a legacy room
   *  admitted on a local server holds at its first past-trim discard until a president resolves it). */
  legacyExcessTrains?: "refuse" | "engine-chose-cheapest";
  /** #1614 (Slice 8.2, owner ruling R3 / D-31): what a LEGACY log's Stock-Round home placements mean --
   *  DEVELOPMENT-CORPUS ONLY, NEVER A PRODUCTION RESTORE POLICY. Every log before Slice 8.2 was played on the
   *  engine that demanded the home token at the float; the current reducer places it at the start of the
   *  corporation's first operating turn and refuses the old entries as untimely. `"defer-to-first-turn"` has
   *  `replayLog` REMEMBER the last such entry's candidate home choice (hex / circle) for each corporation and
   *  attempt it once, as a synthetic `PlaceHomeStation` through today's arm, when that corporation first
   *  owes its home -- judged by the CURRENT authority on the board of that moment, never forced, never
   *  substituted, appended nowhere. `"refuse"` -- the default, and the only value the server carries --
   *  replays the old entries as the refusals they now are, so the corporation's hold stands at its first turn.
   *  Only consulted for a `legacy` log. */
  legacyHomeTokens?: "refuse" | "defer-to-first-turn";
}

/** The server's policy: a room the field does not pin is not interpreted. */
export const SERVER_REPLAY_POLICY: ReplayPolicy = {
  legacyLogs: "refuse",
  legacyExcessTrains: "refuse",
  // #1614: no legacy home-choice adapter on a server, ever.
  legacyHomeTokens: "refuse",
};

/** The development corpus's policy: the stored and golden logs under `frontend/` predate the pin and are
 *  replayed under the current engine AS FIXTURES. Passing this is the visible statement that a test or the
 *  CLI knows the log it holds was never pinned. */
export const DEVELOPMENT_CORPUS_POLICY: ReplayPolicy = {
  legacyLogs: "development-corpus",
  // #1530: best-effort corpus compatibility (the corpus was played under the automatic trim); not fidelity.
  legacyExcessTrains: "engine-chose-cheapest",
  /* #1614 (R3): the corpus's float-time home placements are the players' recorded choices, tried at the first
     operating turn under the current rules -- data, not grandfathered legality. */
  legacyHomeTokens: "defer-to-first-turn",
};

/** The version the effective deal names: a number, `null` for a deal without one, `undefined` for no deal. */
export function rulesEngineVersionOf(entries: readonly ReplayEntry[]): number | null | undefined {
  for (const entry of effectiveActions(entries)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.payload);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && "SetupGame" in parsed) {
      const setup = (parsed as { SetupGame: Record<string, unknown> }).SetupGame;
      const version = setup[RULES_ENGINE_VERSION_FIELD];
      return typeof version === "number" && Number.isInteger(version) ? version : null;
    }
  }
  return undefined;
}

export function replayCompatibility(entries: readonly ReplayEntry[]): ReplayCompatibility {
  const version = rulesEngineVersionOf(entries);
  if (version === undefined) return { kind: "undealt" };
  if (version === null) return { kind: "legacy" };
  if (SUPPORTED_RULES_ENGINE_VERSIONS.includes(version)) return { kind: "compatible", version };
  return { kind: "incompatible", version, supported: SUPPORTED_RULES_ENGINE_VERSIONS };
}

/** Why this log must not be replayed by this engine under this policy, or `null` if it may be. */
export function replayRefusal(
  compatibility: ReplayCompatibility,
  policy: ReplayPolicy,
): string | null {
  switch (compatibility.kind) {
    case "compatible":
    case "undealt":
      return null;
    case "incompatible":
      return (
        `This game was dealt under rules engine version ${compatibility.version}; this server supports ` +
        `version${compatibility.supported.length === 1 ? "" : "s"} ${compatibility.supported.join(", ")}. ` +
        "It cannot be continued here without reinterpreting its history, so it is left untouched."
      );
    case "legacy":
      return policy.legacyLogs === "development-corpus"
        ? null
        : "This game was dealt before rules-engine versioning and carries no version. It is not reinterpreted " +
            "under the current rules. A local server may admit it explicitly (--legacy-logs development-corpus); " +
            "otherwise start a new game.";
  }
}

/** The deal as the server records it: whatever the client sent, with the version this engine carries. */
export function stampRulesEngineVersion<T extends { SetupGame: Record<string, unknown> }>(msg: T): T {
  return {
    ...msg,
    SetupGame: { ...msg.SetupGame, [RULES_ENGINE_VERSION_FIELD]: RULES_ENGINE_VERSION },
  };
}

/** A typed error for the headless paths (`replayLog`, the CLI), which have no frame to answer with. */
export class ReplayIncompatibleError extends Error {
  readonly compatibility: ReplayCompatibility;
  constructor(compatibility: ReplayCompatibility, reason: string) {
    super(reason);
    this.name = "ReplayIncompatibleError";
    this.compatibility = compatibility;
  }
}
