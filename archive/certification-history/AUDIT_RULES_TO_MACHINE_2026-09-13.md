# Rules-to-Game-Machine Audit — 2026-09-13

**Authority:** `en_1830re_Rules_1830-RE_EN.pdf` (Lookout Spiele, 2018). Section numbers below are the rulebook's.
**Machine audited:** the TypeScript reducer `frontend/src/utils/sandboxSession.ts` and its rule modules, as executed by
`server/src/gameServer.ts` → `RoomSession.submit` → `RoomEngine.apply`. Per `MIGRATION_PLAN.md` the Rust game logic
(`src/*.rs`) is being retired; it is cited here only as a harvest source. The Rules Reference was **not** used as an authority.
**First pass:** no gameplay code was changed. Nothing was committed.

**Legality boundary as built.** Three layers decide whether a message is legal: (1) `turnAuthority.turnRefusal` — seat
identity and room-message ownership only; (2) the reducer arms, which refuse by returning the state **unchanged**
(`actionWasRefused` detects refusal by identity — `refusedAction.ts` #778); (3) `filterSandboxPlacements`
(`components/sandboxTileLegality.ts`), injected as `layRefused` by `replayProviders.ts`. Anything not refused by one of
these three is accepted by the server, regardless of what the UI shows. That boundary is the reference point for every
UI-ONLY verdict below.

**Not executed:** the Jest suite (~4,650 tests) and `src/tests.rs`. Test coverage claims below come from reading test
file names and the modules they import, not from running them. Where a rule's tests were not located this says so.

---

## Executive Summary

| Status | Count |
|---|---|
| PASS | 80 |
| PASS / TEST GAP | 5 |
| PARTIAL | 18 |
| FAIL | 10 |
| MISSING | 3 |
| UI-ONLY | 18 |
| UNCLEAR | 4 |
| **Total rows in matrix** | **138** |

Counts are tallied from the matrix rows below (the private-company and variant tables count one row per company/configuration). The critical/major lists group several rows into one finding, so they do not sum to these figures.

The machine is strong on the **stock market**: zone rules, float, pool cap, presidency block, sell-then-rebuy lockout,
priority deal, market geometry, dividend split, and OR count are implemented in the reducer and mostly well-tested.

The machine is weak on **the Operating Round as an authority**. Design note #1182 (`dividendGate.ts`) records that the
operating-corporation and sub-phase gates on `LayTile`, `PlaceStationToken` and `RunMultipleRoutes` were deliberately
reverted because the operating order was chart-derived and differed between clients. Since #1196/#1197 folded the chart
into `state.market_positions`, the order is a function of the log and that justification has expired — but the gates
were never restored. The consequence is that route legality, station legality, tile connectivity, one-lay-per-turn,
one-token-per-turn, corporation identity on a lay, and the dividend amount are all decided by the client.

Two rule families are absent from the machine entirely: **player bankruptcy** (no end path, no forced-purchase
enforcement, no forced sale) and **the excess-train discard as a president's choice into a purchasable Bank Pool**.

---

## Critical Findings (can produce an incorrect game result on the authoritative server)

**C1. Dividend amount is trusted from the message.** `DeclareDividends` pays `msg.revenue_amount`
(`dividendSplit.ts:dividendRevenue`) and never compares it to `last_route_revenue` written by `RunMultipleRoutes`.
Any client can declare any revenue. FAIL.

**C2. Routes are priced but never validated.** The `RunMultipleRoutes` arm (`sandboxSession.ts` ~4731) refuses only a
Coal River crossing and a duplicate `revenue_turn`. None of 6.4.2 is checked: station on route, train capacity, continuity,
no reversal, no track reuse, no shared track between trains, red areas terminal only, blocked cities, one run per train,
runs ≤ trains owned. All of it lives in the UI (`routeAutoTrace.ts`, `runTrainsRules.ts`, `routeConnection.ts`). UI-ONLY.

**C3. `BuyStock` has no affordability check** (`sharePurchaseBlock` covers zones, limits, lockout, debt — not cash) and
`adjustCash` floors at zero, so an unaffordable purchase mints money. The same floor swallows overspend on auction
charges (`applyAuctionStep`) and on `BuyPrivateCompany`, `PlaceStationToken`, and `settleTrainSale` (`adjustTreasury`).
Only `LayTile` (#891) and depot train purchases (`trainPurchaseRefusal`) check funds. FAIL.

**C4. Player bankruptcy does not exist in the machine.** No message ends the game on bankruptcy; `GameEnd` is reached
only by bank break (`settleRoundTransitions`). `PassTurn` in an OR always advances (`advanceCorporation`), so a trainless
corporation with a legal route can skip the mandatory purchase (6.6.2). `EmergencyBuyHardware` charges the president's
shortfall through the zero floor, so a president who cannot pay still gets the train. `rankPlayers(bankruptAddress)` is a
display concept only. MISSING.

**C5. Auction all-pass stacks two rules and misapplies both.** `applySandboxWaterfallAction` (`WaterfallPass` branch)
marks down *whichever private is lowest-offered* and pays private revenue on *every* all-pass. Rulebook 1.2.3: only the
**SV** is marked down, only while it is unsold; revenue is paid only once the SV has sold, with no markdown. Under the
machine, CS/DH/MH/CA/BO become cheaper every time the table passes. FAIL.

**C6. Excess trains are discarded automatically, cheapest-first, and vanish.** `applyPhaseChange` →
`trimToTrainLimit` (`trainLimit.ts:261`). Rulebook 6.6.1: the **president chooses**, highest-valued railroad decides
first, and the discarded train goes to the **Bank Pool** where it may be bought at face value (6.6). FAIL + MISSING.

---

## Major Findings

**M1.** Mini-auction pass removes the bidder permanently (`WaterfallMiniAuctionPass`); rulebook 1.2.2: "may pass and still
bid later." A player who passes after A's raise cannot re-enter when C raises. FAIL.

**M2.** `WaterfallBidHigher` accepts a bid on the lowest-offered private (opens a mini-auction on it if ≥2 bids) and does not
check escrowed/available cash; `minimumBidFor` is the only gate. Rulebook 1.2 (3) and 1.2.1. UI-ONLY.

**M3.** `LayTile` does not check that `protocol_id` is the operating corporation, the sub-phase, or one-lay-per-turn.
A message naming another corporation charges that corporation's treasury. One-lay-per-turn is enforced only by the cursor
withdrawing controls (`stepAfterMessage` → Tokens); `bonus_lay: true` on any message keeps the Track step open. UI-ONLY.

**M4.** Server `layRefused` (`replayProviders.ts`) calls `filterSandboxPlacements` without `networkHexes`/`networkPorts`,
so 6.2.1 (1) / 6.2.2 (1) — an unblocked route from a station to the new tile — is not enforced. UI-ONLY.

**M5.** 6.2.1 (4): no tile may be laid on a hex holding a **player-owned** private (SV G15, CS B20, DH F16, MH D18, CA H18,
BO I13/I15). Not implemented anywhere; `privateReservations.ts` is a badge. MISSING.

**M6.** `PlaceStationToken` arm checks only "not already here" and charges. Token limit, empty circle, connectivity, home
reservation, blocking (6.3.2/6.3.3) are all in `stationTokens.evaluateStationPlacement`, which the reducer never calls
(only `derivedActions` does, for auto-skip). One-token-per-turn is cursor-only. UI-ONLY.

**M7.** No "no sales in the first Stock Round" rule (5.1) in `shareSaleBlock` or the `SellStock` arm. UI-ONLY.

**M8.** ~~Selling shares of an **unparred** corporation (C&A's PRR share, M&H's NYC share before a president) is accepted
and priced at `SANDBOX_NOMINAL_SHARE_PRICE` ($67) by `applySandboxMarketAction` `priceOf` fallback. Rulebook p.15: cannot
be sold until the president's certificate is bought. FAIL.~~ **RESOLVED — the sale half by Batch 7.2 (#1570), the
projection half by Stage 8, Slice 8.5 (#1640).** `stockSaleRefusal` rule 4 refuses every sale of a corporation with no
par, in a Stock Round and in the Operating Round's forced-sale exception alike — which is also why a share of an
unstarted corporation has no reachable history in the Bank Pool. Slice 8.5 then took the nominal out of the 6.6.3
forced-sale projection: `sharePriceFor` returns `null` for an unparred corporation on every board, `forcedSaleRefusal`
says so before any "only enough" arithmetic, and `legalForcedSales` skips what it cannot price. Backlog **S8-8**
`RESOLVED`. PASS.

**M9.** Emergency purchase buys the cheapest **depot** tier only (`EmergencyBuyHardware` → `depotInventory` first row;
`buyReturnedTrain` refuses when `requireFunds=false`). Rulebook 6.6.2 "cheapest train available" includes the Bank Pool
(returned/discarded trains) — a $300 returned 4-train would be skipped for a $630 6. PARTIAL.

**M10.** Presidency tie-break among equal challengers takes the first in `player_holdings` order (`presidentFor`);
rulebook 5.4: closest **clockwise from the current president**. FAIL (edge, but decides control).

**M11.** `rankPlayers` (`endgame.ts` #5) makes the bankrupt player unable to win. Rulebook 6.6.3 note: "It is possible,
but unlikely, that a bankrupt player can win"; their score is the value of shares they could not sell. FAIL.

**M12.** Emergency funding excludes **all** shares of the rescued corporation (`sellableHoldings(excludeCompanyId)`).
Rulebook 6.6.3 only forbids sales that would change that corporation's presidency. The machine rejects legal sales, and
"may only sell enough to make the purchase" is not enforced anywhere. PARTIAL.

**M13.** `BuyPrivateCompany` checks only "not the BO" and "not already this corporation's". Missing: phase ≥ 3 (3.1),
price within 50%–200% of face (3.1), buyer is the operating corporation, treasury covers price, seller is a **player**
(a corporation may not sell a private — the arm accepts `owner_protocol_id` of another corporation). PARTIAL/UI-ONLY.

**M14.** `settleTrainSale` (inter-corporate purchase) checks nothing: not the buyer's train limit, not ≥ $1, not that the
buyer is operating at the Buy Trains step, not funds. Rulebook 6.6. UI-ONLY.

**M15.** Home token is placed **at float during the Stock Round** (`pendingHomeTokens` holds the seat, #769) rather than at
the start of the corporation's first operating turn (6.3.1). Effects: Erie's slot choice and route blocking through the
home city occur one OR-turn early; "may not block the home station of a railroad that has not yet operated" (6.3.2) is
approximated by `homeReservationStands` on the UI side. PARTIAL. Also `placeHomeStationToken` accepts **any** hex for a
single-home corporation (comment: "keeps replaying to wherever it recorded"). UI-ONLY.

**M16.** The "1830+" board implemented (`hexBoardDataPlus.ts`, notes #1300/#1301 "REQUESTED, verbatim") is the owner's
Project 18XX+ spec, not the rulebook's 1830+ (p.25): H12 is printed green **#24** (rulebook: green **23**, PRR home base
anywhere on the hex), Montréal is one station (rulebook: double circle), no D24 preprinted 29, no E5 Detroit exit, B20
double town ✓. Flagged as a rulebook deviation; the owner's spec may be the intended authority for this variant. FAIL vs
rulebook / UNCLEAR vs intent.

---

## Minor Findings

- **m1.** ~~Operating-order tie-break for equal price **and** equal column falls to arrival ordinal; rulebook 6.0 says
  "furthest up" first. Reachable: $67 sits at x=6 on rows y=3, 4 and 5. PARTIAL.~~ **RESOLVED — #1531, and relocated to
  `operatingOrder.compareOperatingOrder` by Stage 8, Slice 8.1 (#1600).** The comparator now has five disjoint levels:
  price desc, column desc, **row desc**, arrival asc, company id. Pinned as a table in `stage85Matrices.test.ts` §11.1.
  PASS.
- **m2.** Order is fixed at OR open; the 6.1 note ("if a railroad's share value changes for a railroad that has not yet
  operated, the new share value is used") is not applied mid-round. PARTIAL.
- **m3.** Sold-out rise iterates `state.public_companies` in company order; 4.5 says highest-priced token first (matters
  for stack order when two risers meet). PASS / TEST GAP — no test pins the order.
- **m4.** Float capitalisation is paid on the purchase that crosses 60% (`applyFloatThreshold`), not at the end of the SR
  (5.3). Harmless — the treasury cannot be spent before the OR and bank-break timing is unchanged — but a difference.
- **m5.** Divestment debt (`forcedDivestment.ts`) blocks buying and passing until sold down. Rulebook 4.3 requires
  conformance "during your next turn"; forcing sell-first is stricter than necessary but not incorrect in effect.
- **m6.** M&H exchange always takes the IPO share before the pool (`resolvePrivateExchange`); rulebook lets the owner take
  from "the bank or the pool". Affects float progress. PARTIAL.
- **m7.** Bank Pool cap is 50% (`BANK_POOL_CAP_PERCENT`); rulebook is "5 certificates". Identical for standard
  corporations; differs for LPF corporations carrying a 20% double certificate.
- **m8.** `BuyStock` from IPO on an unparred corporation is silently converted into the president's purchase and, if the
  message carries no `par_value`, pars at `ctx.parValue ?? 67`. Legal par values (67/71/76/82/90/100) are not validated in
  the reducer. UI-ONLY.
- **m9.** `moveShares` clamps a pool draw to what exists but `charged` is computed beforehand, so a buy from an empty pool
  charges for a share it does not deliver. UI-ONLY edge.
- **m10.** CSL power is treated as forfeited when another corporation tiles B20 (`cslPowerState`); the rulebook states that
  lapse for the **DH** only. UNCLEAR (rulebook does not say whether the CS exception survives as an upgrade right).
- **m11.** `adjustBank` floors at zero; after a break the bank pays the full amount while its balance reads $0. This is the
  digital "paper tracking" and is acceptable; `bankIsBroken` (≤ 0) still fires. Note only.
- **m12.** `applyPrivateRevenue` runs on the auction all-pass even when SV is unsold (harmless: nobody owns anything yet).

---

## Test Gaps (implementation appears correct; proof missing or unverified)

| Rule | Where the gap is |
|---|---|
| Sold-out rise order, highest first | `soldOutRise.test.ts` covers the single-rise case; no two-riser ordering test found |
| `DeclareDividends` must reject an amount ≠ `last_route_revenue` | no test exists because no rule exists (see C1) |
| First-SR sale refusal | `sellBuySell.test.ts`, `shareSale.test.ts` — no machine-level first-round case found |
| Presidency tie clockwise from incumbent | `presidencyTransfer.test.ts` tests strictly-more; no tie-order test |
| Operating order: same price, same column, higher row first | `operatingOrderTieBreak.test.ts` covers column + arrival only |
| Auction: bid on lowest offered refused; escrow-aware cash | `auctionEscrow` tests are UI-arithmetic; none drive the reducer |
| Forced purchase picks 5 over 6 over D **including pool trains** | `emergencyTrainFlow.test.ts` should add a returned-train case |
| Phase change immediately on purchase, limit trims *that* buyer | `trainLimit.test.ts`, `depotSchedule.test.ts` — happy path only as far as names indicate |
| Terrain fee once, none on upgrade | `terrainFeeOnce.test.ts` exists — PASS / TEST GAP only for the upgrade-of-preprinted case |

**Brittle tests to review:** `variantCopy.test.ts`, `privateCardText.test.ts`, `dividendNarration.test.ts` and the
`batchNN.test.ts` family pin rendered strings; they will not catch a rule regression whose text is unchanged.
`src/tests.rs` (17.5k lines) should be mined for auction-interrupt and forced-purchase cases before retirement
(MIGRATION_PLAN §4).

---

## Architectural Risks

1. **The #1182 revert is now unjustified.** Corporation/sub-phase gates on `LayTile`, `PlaceStationToken`,
   `RunMultipleRoutes` were removed because `active_corporation_index` depended on a client-local chart. `buildOperatingOrder`
   now reads `state.market_positions` first. Restoring the gates is safe on the same argument the note itself makes.
2. **Legality split across `components/` and `utils/`.** `filterSandboxPlacements` and `evaluateStationPlacement` are the real
   rules; the reducer reaches one through an injection missing half its inputs and the other not at all. The `utils/`-may-not-
   import-`components/` boundary (#273) is why. Either move the two engines to `utils/` or inject them completely.
3. **Zero floors as implicit refusals.** `adjustCash`/`adjustBank`/`adjustTreasury` clamp at 0. #891 fixed this for the tile
   fee only. Every other debit site can overspend silently.
4. **Message-carried facts the reducer could derive:** `DeclareDividends.revenue_amount`, `LayTile.bonus_lay`,
   `BuyStock.par_value` (accepted unvalidated), `PlaceHomeStation` hex for single-home corporations, `RunMultipleRoutes`
   paths. Each is a place a client asserts a rule outcome.
5. **Duplicated constants/logic (flag, do not refactor yet):**
   - `SANDBOX_SHARE_PERCENTAGE`/`PRESIDENT_PERCENTAGE` (`sandboxSession.ts`), `SHARE_BLOCK_PERCENT`/`PRESIDENT_BLOCK_PERCENT`
     (`endgame.ts`), `SHARE_PERCENT`/`PRESIDENT_SHARE_PERCENT` (`sharePurchase.ts`), local copies in `doubleCertificate.ts`.
   - `isExemptZone` (`sharePurchase.ts`) mirrors `isCertificateExemptZone` (`StockMarketRenderer.tsx`); `capWaived`
     (`forcedDivestment.ts`) mirrors `exceeds60Allowed`.
   - `PLAYER_HOLDING_CAP_PERCENT` lives in `privateExchange.ts` and is imported by the stock modules.
   - Train limits: `TIER_PRESENTATION[tier].trainLimit` (`gamePhase.ts`) and `limitForTier` (`sandboxSession.ts`).
   - Token costs: `stationTokens.ts` constants and `heraldHexFor`-adjusted pricing in the arm.
   - Private face values/revenue: `privateCatalog.ts` **and** the fixture's `private_companies` (`sandboxState.ts`) and
     `waterfall.privates.face_value`; the auction marks down the fixture copy.
   - OR sub-phase label table hand-copied in `RulesReference.tsx` (#7).
6. **Phase derived from fleet ownership** (`derivePhase`: highest tier owned). Correct for "immediately on purchase", but
   depot stock is `total − owned`, so a train that leaves a fleet without entering `returned_trains` (the trim in C6)
   reappears as depot stock under the queue rule rather than as a pool train.

---

## Full Traceability Matrix

Columns: Rule · Rulebook § · Implementation · Enforcement point · Tests (by file name) · Status · Notes.
"arm" = a `"X" in msg` branch of `applyOneAction` in `sandboxSession.ts`.

### A. Game setup

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Player counts 2–6 | p.7 | `gameSetup.isLegalPlayerCount`, `MIN_PLAYERS`/`maxPlayersFor` | `SetupGame` arm returns state on `null` deal | `gameSetup.test.ts` | PASS | LPF allows 7 (owner variant) |
| Starting cash 1200/800/600/480/400 | p.7/27 | `STARTING_CASH_BY_PLAYER_COUNT` | `dealSandboxGame` | `gameSetup.test.ts` | PASS | |
| Cert limits 28/20/16/13/11 | 4.3 | `CERT_LIMIT_BY_PLAYER_COUNT` | `certificateBreakdown` → `sharePurchaseBlock` | `certLimitAgreement.test.ts` | PASS | LPF table separate ✓ |
| Bank $12,000, players dealt from it | p.5 | `BANK_SIZE_BY_LENGTH.standard`, `bankRemaining` | deal | `gameSetup.test.ts` | PASS | short/long banks are owner variants |
| Turn order random; PD to seat 1 | 1.1 | host-side shuffle in payload (#526a); `priority_deal_index: 0` | deal | `auctionSeating.test.ts`, `rosterOrder.test.ts` | PASS | |
| Six privates, prices/revenues | p.9 | `privateCatalog.ts`, fixture `sandboxState.ts` | — | `privateCatalog`, `privateRevenue.test.ts` | PASS / TEST GAP | two copies (risk 5) |
| Eight corporations, tokens 4/4/4/3/3/3/2/2, homes | p.28 | fixture `station_token_limit`, `home_hex_label` | — | not located | UNCLEAR | fixture not read in this pass |
| Stock market grid & par ladder | 4.0/4.2 | `marketChart.ts REAL_MARKET_ROWS`, `PAR_VALUE_LADDER` | geometry | `marketChart.test.ts`, `parBoxCoordinates.test.ts` | PASS | matches 18xx.games; Dynamic row only under its variant |
| Depot 6/5/4/3/2/∞, prices 80/180/300/450/630/1100 | p.5 | `DEPOT_TOTALS`, `DEPOT_COST` | `depotInventory` | `depotSchedule.test.ts` | PASS | |
| No shares in pool at start | 1.0 | fixture | — | — | PASS | |

### B. Private Company Auction

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Pass / buy lowest at face / bid on other | 1.2 | `applySandboxWaterfallAction` | arm | `miniAuctionTurn.test.ts`, `auctionCashMovement.test.ts` | PARTIAL | bid on lowest accepted (M2) |
| Bid ≥ face (or high bid) + $5, whole dollars | 1.2.1 | `minimumBidFor` (`auctionEscrow.ts`) | `WaterfallBidHigher` refuses below minimum | `auctionEscrow` tests | PASS | integer-ness not checked |
| Bid money set aside; cannot overcommit | 1.2.1 | `availableCash`/`bidRejectionReason` | **UI only**; reducer charges through zero floor | `auctionEscrow` tests | UI-ONLY | C3 |
| Buyer pays face; PD to left | 1.2 (2) | `WaterfallBuyLowest`; PD implicit in rotation | arm | `miniAuctionTurn.test.ts` | PASS | rotation model shown equivalent |
| Lowest has bids → pause; one bidder buys at bid | 1.2.2 | `cascade` | arm | `miniAuctionTurn.test.ts` | PASS | |
| Multiple bidders → auction, start at high bid, lowest bidder first, clockwise | 1.2.2 | `openMiniAuction`, `byAscendingBid`, `nextMiniTurn` | arm | `miniAuctionTurn.test.ts` | PASS | |
| Min raise $5 in mini-auction | 1.2.2 | `WaterfallMiniAuctionRaise` — **no minimum check** | — | — | UI-ONLY | raise arm accepts any amount |
| Pass and re-enter later | 1.2.2 | pass removes bidder | arm | `miniAuctionTurn.test.ts` pins current behaviour | FAIL | M1 |
| Ends when all bidders pass; high bidder pays | 1.2.2 | `remaining.length <= 1` → winner | arm | ✓ | PARTIAL | consequence of M1 |
| PD unchanged after auction; resume with PD holder | 1.2.2 | `current_turn` preserved (#338) | arm | `passedSeats`, #1232 tests | PASS | |
| Check next private for bids immediately; chain | 1.2.2 | `cascade` loop | arm | ✓ | PASS | |
| Losers' money released | 1.2.1 | derived escrow (`auctionEscrow` #1) | n/a | ✓ | PASS | |
| All pass, SV unsold → SV −$5 | 1.2.3 | markdown applied to *lowest offered* | arm | `batch*` markdown tests | FAIL | C5 |
| SV reaches $0 → next player takes it, treated as purchase | 1.2.3 | `marked === 0` → `taker`, PD advances | arm | ✓ | PASS | |
| All pass, SV sold → privates pay revenue, no markdown | 1.2.3 | `applyPrivateRevenue` on every all-pass **and** markdown | arm | — | FAIL | C5 |
| Auction ends → first Stock Round | 1.2 | `settle` + `OpenStockRound` arm | `turnRefusal` requires 0 unsold | `hostJoinFlow`, replay goldens | PASS | |
| C&A grants PRR 10% at purchase, stays open | p.11 | `applyPrivateExchange(keepOpen)` in `applyAuctionStep` | arm | `privateExchange.test.ts` | PASS | |
| B&O grants president's cert + par immediately | p.11 | `grantBOPresidency`, `SetBoPar` | `boPresidencyRefusal`, `turnRefusal` owner check | `boFloatRule.test.ts` | PASS | |
| Delayed Auction (owner variant) | — | SR1 first; auction after the OR set of the first 3-train; B&O locked | `settleRoundTransitions`, `boIsLocked` | `variantRules.test.ts` | PASS | consistent with its own spec (#905) |

### C. Stock Round

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Sell → Buy 1 → Sell | 5.0 | `stock_turn_stage`, `sellBuySellInForce` | `PassTurn`/`BuyStock` arms | `sellBuySell.test.ts` | PASS | legacy logs replay old rule |
| Consecutive passes end round | 5.0 | `recordPass` streak ≥ count | arm | `passedSeats.test.ts` | PASS | |
| PD to left of last buyer/seller; unchanged if none | 5.0 | `markTrader`, `recordPass` | arm | `sellIsNotAPass.test.ts` | PASS | |
| No sales in first SR | 5.1 | none | — | — | UI-ONLY | M7 |
| Sales to Bank Pool, ≤5 certs in pool | 5.1/4.3 | `BANK_POOL_CAP_PERCENT=50`, `shareSaleBlock` | arm | `shareSale.test.ts` | PASS | m7 |
| Multiple certs of one corp: one price, then drop per share | 5.1 | `saleProceeds`, `projectShareSaleMove` | market step | `shareSale.test.ts`, `marketTraversal.test.ts` | PASS | |
| Seller chooses order across corps | 5.1 | one `SellStock` per bundle | n/a | — | PASS | |
| Cannot rebuy a corp sold this SR | 5.1/5.2 | `sold_this_round`, `soldThisRound` | `sharePurchaseBlock` | `sellThenBuyLock.test.ts` | PASS | |
| President's cert never sold; transfer on exceeding | 5.1/5.4 | `shareSaleBlock` successor rule; `settlePresidencies` | arm | `presidentCertificateSale.test.ts` | PASS | |
| Cannot sell unparred shares | p.15 | `stockSaleRefusal` rule 4 (no par → no sale); `sharePriceFor` returns `null` | arm + 6.6.3 projection | `stockTransactionAuthority.test.ts`, `mohawkExchangeAuthority.test.ts` §13, `stage85Closure.test.ts` §4 | PASS | M8 closed by Batch 7.2 + Slice 8.5 |
| Buy from IPO at par / pool at market | 4.1/5.2 | `BuyStock` price from `par_value` message / chart | arm | `parFromMessage.test.ts` | PASS / TEST GAP | relies on shell sending `par_value` for IPO buys |
| First cert is president's at 2×par; par ∈ ladder | 5.2/4.2 | `isPresidentBuy`, `charged = price*2` | arm | `presidentPurchase.test.ts`, `parPrice.test.ts` | PARTIAL | m8: ladder not validated in reducer |
| Cash required | 5.2 (implicit) | none | — | — | FAIL | C3 |
| Individual limit 60%; orange/brown waive | 4.3/4.4 | `sharePurchaseBlock` (1), `exceeds60Allowed` | arm | `sharePurchase.test.ts` | PASS | |
| Overall cert limit; yellow/orange/brown exempt | 4.3/4.4 | `certificateBreakdown`, `isExemptZone` | arm | `certLimitAgreement.test.ts` | PASS | |
| Brown pool multi-buy as one purchase | 4.4 | `allowsExtraPoolBuys` | arm | `quantityOptions.test.ts` | PASS | |
| One purchase per turn | 5.0 | `bought_this_turn` | arm | `doubleActionWindow.test.ts` | PASS | |
| Conform to limits next SR turn | 4.3 | `divestmentDebt` | `sharePurchaseBlock`, `PassTurn` | `forcedDivestment.test.ts` | PASS | m5 |
| President change on exceed, immediate swap | 5.4 | `presidentFor` strictly-more; `settlePresidencies` after buy/sell | arm | `presidencyTransfer.test.ts` | PASS | |
| Tie among challengers → clockwise from president | 5.4 | seating-order `find` | arm | — | FAIL | M10 |
| Float at 60% out of IPO incl. pool & private grants | 5.3 | `metFloatThreshold` (`floatThreshold.ts`) | `applyFloatThreshold` | `floatThreshold.test.ts` | PASS | |
| Treasury = 10×par at end of SR | 5.3 | paid at the crossing purchase | arm | ✓ | PASS | m4 |
| Home token at first OR turn | 6.3.1 | placed at float in SR | `PlaceHomeStation`, `homeTokenBlock` | `homeTokenGate.test.ts` | PARTIAL | M15 |
| Sold-out corps rise 1 at SR end, highest first | 4.5 | `roundEndSoldOutRises` | `settleRoundTransitions` | `soldOutRise.test.ts` | PASS / TEST GAP | m3 |
| Market edge behaviour (top/bottom/350) | 4.5 | `projectShareSaleMove`, `projectRiseMove`, `dividendStepFrom` | market step | `marketTraversal.test.ts` | PASS | |
| Arriving token goes to bottom of stack | 4.2/4.5 | `withArrival`, `stackOrder` | market step | `marketStack` tests | PASS | |
| M&H exchange: <60%, share available, SR turn or between turns, closes M&H | p.11 | `resolvePrivateExchange`, `ExchangePrivate` arm | `turnRefusal` owner check | `privateExchange.test.ts` | PARTIAL | m6 (IPO forced first) |
| Private sales between players (not first SR) | 3.1 | not found | — | — | UNCLEAR | no message located for player-to-player private sale |

### D/E. Operating Round order and turn

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Privates pay first each OR | 6.0 | `openOperatingRound` → `applyPrivateRevenue` | transition | `privateRevenue.test.ts`, #1015 tests | PASS | |
| Order by share value desc; same cell top first; same value → rightmost; same column → higher | 6.0 | `buildOperatingOrder` (price, column, arrival) | `beginOperatingRound` | `operatingOrderTieBreak.test.ts` | PARTIAL | m1 |
| New value used if changed before operating | 6.1 note | order fixed at open | — | — | PARTIAL | m2 |
| 1/2/3 ORs by phase, starting after the next SR | 2.x/6.1 | `operatingRoundsForPhase`, `operating_round_sequence_length` locked | `advanceCorporation` | `operatingRoundCycleCount.test.ts`, `operatingRoundPhaseLoop.test.ts` | PASS | |
| Sequence Track → Token → Run → Dividends → Buy Trains | 6.1 | `stepAfterMessage` cursor | cursor advances; **no arm refuses out-of-step** except dividends & train buys | `subPhaseTrail.test.ts`, `operatingRoundTurn.test.ts` | UI-ONLY | M3, M6 |
| Buy private not a mandatory step; any time from phase 3 | 6.1 | offer/answer flow | — | `buyPrivateWindow.test.ts` | PARTIAL | phase gate not in reducer (M13) |
| Only president acts | 6.0 | `turnRefusal` vs `actingAddress` | server | `turnAuthority.test.ts` | PASS | |
| Per-turn state reset | — | `settleOperatingCursor` (`turnChanged` clears) | transition | `routeRevenueReset.test.ts` | PASS | |

### F. Track

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| One lay or one upgrade per turn | 6.2 | cursor only | — | `oneLayPerTurn.test.ts` (cursor) | UI-ONLY | M3 |
| Route from a station to new tile, any length | 6.2.1 (1) | `orientationJoinsNetwork` when `networkHexes` supplied | **not supplied by server** | `layableGlow.test.ts` (UI) | UI-ONLY | M4 |
| Exceptions CS B20, DH 57 F16, NYC 57 E19, Erie 59 E11; anyone may tile them normally | 6.2.1 | connectivity is not enforced at all, so exceptions are vacuously honoured | — | `dhPower.test.ts`, `layAuthority.test.ts` | PASS / TEST GAP | becomes a real requirement once M4 is fixed |
| DH power lapses when another corp tiles F16 | p.11 | `dhPowerState.forfeited` | UI/derived | `dhPower.test.ts` | PASS | |
| No track off-grid / into blank gray / solid red side | 6.2.1 (2) | `staysOnBoard`, `crossesImpassableBorder` | `filterSandboxPlacements` | `impassableBorders.test.ts`, `grayRedTrack.test.ts` | PASS | |
| Terrain cost $80/$120 once; no cost on upgrade | 6.2.1 (3)/6.2.2 (7) | `terrainFeeDue`, `terrain_fees_paid` | `LayTile` arm (refuses if unaffordable, #891) | `terrainFeeOnce.test.ts`, `terrainAffordability.test.ts` | PASS | |
| No tile on player-owned private hex | 6.2.1 (4) | none | — | — | MISSING | M5 |
| City count/size match; labels OO/B/NY | 6.2.1 (5,7) | `hexCentres`/`tileCentres`, `hexLabelRestriction` | `filterSandboxPlacements` | `tileUpgrades.test.ts`, `plusTiles.test.ts`, `stage93TileAuthority.test.ts` | PASS | **Slice 9.3 added the naming authority these tables were missing (S9-21), ON THE LIVE CATALOG.** `TileCatalogEntry.canonicalId` (#1630) carries the canonical rules/display identity of the three tiles whose printed OLD NUMBERS the official errata voids — **oo1 = #8861** (deprecated identifier `#626`), **oo13** and **oo14** canonical by Lookout ID with **no valid old-system number** (deprecated identifiers `#36`, `#35`). *The errata voids numbers, not tiles: all three are valid, owner-confirmed tiles.* **The invariant: an errata-invalid old NUMBER may remain a stable MACHINE KEY for compatibility, and is no longer treated as a canonical RULES IDENTITY.** The integers 626 / 36 / 35 stay the **stable historical storage / ABI key** — `tile_id` is the replay ABI, and newly written state serializes them too (`applySandboxLayTile` puts `tile_id` straight into the grid), so they are NOT "input-only aliases". `canonicalTileName(tileId)` from `hexTileCatalog.ts` is the one naming authority, falling through to `#<id>` for the other 73 tiles unchanged, and **three real production consumers read it**: the Activity Log sentence (`utils/actionLog.ts` `describeGameplayAction`), the hex-finished click/glow message (`components/hexGeometry.ts` `evaluateHexForTileLaying`) and the tile-picker tooltip (`components/TileSelectionPopup.tsx`). No persisted representation changed, no log or golden moved, and the corpus is 18/18 identical to baseline. Three player-visible surfaces in owner-dirty files still print the raw integer (`App.tsx:3340`, `hexCanvasPrimitives.ts:1063`, `TileReference.tsx`) — display-only, filed as **U-38**. oo1's non-upgradeability is a SEPARATE errata fact and is pinned against the real derived graph |
| Yellow on tan; green on yellow; brown on green; phase availability | 6.2/2.x | `TIER_RANK`, `existingRank + 1`, `eraRank` | `filterSandboxPlacements` | `eraTracksPhase.test.ts` | PASS | |
| Upgrade preserves all segments and stations | 6.2.2 (3,4) | `preservesRouting` (segment superset) + `separationPreserved` (#1628, rule 5b), token migration in arm, `stationAnchorRefusal` in the reducer | `filterSandboxPlacements` | `stage93TileAuthority.test.ts`, `stage92BoardAuthority.test.ts`, `tileUpgrades.test.ts`, `homeReservationClears` | **PASS** (Slice 9.3, 2026-09-18, uncommitted; was PARTIAL) | **RESOLVED BY SLICE 9.3 — the third and last gap is closed.** 6.2.2 ❹'s second sentence is now in the authoritative predicate: `TileCatalogEntry.separateSystems` (design note **#1628**) carries the clause as **tile metadata** on old **#59** alone, `priorTopologyAt` rotates its `cityGroups` onto `HexTopology.separateSystems`, and `separationPreserved` is **rule 5b** of `filterSandboxPlacements` — the first rule in that file to compare CONNECTIVITY (union-find over the destination's rotated `paths`) rather than segments. **No tile id appears in the predicate**, and the rule did NOT generalize: the legal merge family (New York's two printed cities → green #54, the town merges, Baltimore's chain) is untouched and machine-guarded by a control measuring **> 500 legal component-merging upgrades still accepted**. Measured before → after: of 288 candidate `#59` successor/facing combinations, **114 accepted → 72**, the **42** refused being §8b's seven audited (tile, facing) pairs at all six source rotations; every Classic successor keeps exactly two legal facings, so nothing became unreachable. **Corpus-neutral, measured 18/18** — the three stored transitions §14b adjudicates are refused by the 9.3 predicate but never reach it in live replay, `operatingIdentityRefusal` refusing each upstream and identically at baseline. Pinned by `utils/stage93TileAuthority.test.ts` (42 tests). **The 9.1b/9.2 record below stands as the history of what was wrong.** — **SLICE 9.2 CLOSED TWO OF THE THREE GAPS BELOW.** Board-printed track is now preserved: `priorTopologyAt` (#1621) resolves the hex's live topology in `liveEdgesForHex`'s own order — laid tile ▸ gray ▸ off-board ▸ landmark — and feeds rule 5, closing **F-2**; and ❹'s station half is now authoritative, `stationAnchorRefusal` (#1623) in `applySandboxActionCore` ahead of every mutation, closing **S9-17**. **The row stays PARTIAL for one reason only: 6.2.2 ❹'s second sentence (#59's pre-printed exits may never be connected) is still not implemented — S9-19, Slice 9.3**, whose current behaviour Slice 9.2 characterizes by test so the change is visible when it lands. The original 9.1b text stands below. — Proved only the laid-tile segment superset and token migration. **Re-scoped against the 2018 revised rulebook, located 2026-09-18.** Three gaps, all filed: board-printed track is not preserved (**S9-10**, F-2); **6.2.2 ❹'s second sentence is not implemented** — "the pre-printed exits on a (59) tile can never be connected in the tile upgrade", and seven (tile, facing) pairs accepted today break it (**S9-19**) — so the earlier note "#59's spurs treated as terminus-may-connect ✓" is **half right**: design note #676's terminus relaxation is correct for *track survival* and insufficient on its own, because nothing then refuses a facing that merges the two systems; and ❹'s station half is enforced only in the shell (**S9-17**, `planTokenUpgrade` gates `legalRotations`, not `layRefused`). The explicitly legal expanded topology changes ARE now manifested and are a closed set of four — one city merge (#54 → #883), one capacity shrink (#592 → #61), eight double-town greens, zero splits — see `STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md` §7 |
| Tile supply counts | p.28 | `inTray`, `trayCountOf` vs board | `filterSandboxPlacements` | `tileSupply.test.ts`, `plusTiles.test.ts`, `stage93TileAuthority.test.ts` | PASS | **Slice 9.3 corrected one PHYSICAL count (S9-15).** `tileTrayPlus.RECOUNTED` held `[63, 1]` where T-09 prints C15/#63 as `3 +1` and the errata correction sheet says *"40 value added to 1830+ side of all four C15 tiles"*; the list is TOTALS (`counts.set`, replacement), so the "+1" transcription deleted the three Classic copies. Now `[63, 4]`, fixed **ahead of every scenario removal** so both derived trays inherit it: Classic **3** · 1830+ **4** · published Scenario D **4** · Project 18XX LPF **4**. Complete measured delta 9.2 → 9.3: `PLUS_TRAY` 135 → 138 copies, `LPF_TRAY` 127 → 130, `STANDARD_TRAY` unchanged, **and `#63: 1 → 4` is the only per-tile difference in the whole inventory** — pinned by a whole-inventory literal. The frozen TO override (#810/#882 retained on LPF, design note #1395) is untouched. Corpus-neutral: the tray is never exhausted in any log |
| No tiles on gray/red | 6.2 | `evaluateHexForTileLaying` refuses `RedOffboard`, `printedColor "Gray"/"Coal"` and `GRAY_HEXES` membership — **UI-only** | **not on the authoritative path**: `layRefused` is `operatingIdentityRefusal ‖ authoritativeHoldRefusal ‖ filterSandboxPlacements`, and `sandboxTileLegality.ts` reads none of those tables | `grayRedTrack.test.ts` (artwork + routing only; **no lay test**) | **PASS** (Slice 9.2, 2026-09-18, uncommitted; was MISSING, was UNCLEAR) | **RESOLVED BY SLICE 9.2.** `hexGeometry.immutableHexRefusal(q, r)` (design note #1620) is the extracted Gate-1/2a/2b predicate, asked BOTH by `evaluateHexForTileLaying` and — as rule **0**, ahead of every geometric rule — by `filterSandboxPlacements`, so the authoritative path and the message a player sees are one answer. Ported in `hexmap.rs`'s order (off-board `:2317` first, then gray `:2331`), and `src/tests.rs:5205`'s assertion is ported with it. Measured before → after across all three boards at all four eras: **standard 79 → 0, 1830+ 106 → 0, LPF 87 → 0**, with no ordinary placement newly refused anywhere. Pinned by `utils/stage92BoardAuthority.test.ts`. Corpus-neutral, as predicted. **The 9.1 evidence below stands as the record of what was wrong.** — 2026-09-18 Stage 9.1 resolved the earlier doubt: there is no refusal on the authoritative path. Measured on the standard board, `filterSandboxPlacements` accepts **79 (hex, tile, facing) lays on hexes that can never be built on** — 62 across nine of the twelve printed gray hexes (54 of them deleting printed track: E9 18/17, C15 18/17, F6 6/6, D14 6/6, H12 6/4, A17 3/2, D24 3/2, I19 1/0, F24 1/0) and 17 across the seven red off-board areas. Under LPF the same gap reaches the Coalfields hex (L8) and the five warehouses. Corpus-neutral: zero stored lays depend on it. **The rule IS enforced in the contract and was lost in the migration**: `src/hexmap.rs:2317` `OffboardHexNotBuildable` and `:2331` `GrayHexNotUpgradeable` (module doc #19), asserted at `src/tests.rs:5205` — but `server/src/gameServer.ts:356` runs `sandboxReplayProviders()`, whose `layRefused` is `filterSandboxPlacements` alone, so the fix is a port rather than a new rule. See `STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md` §5 and `RULES_HARDENING_BACKLOG.md` S9-10 (finding F-1) |

### G. Stations

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Home token free at first turn; Erie either city | 6.3.1 | `placeHomeStationToken` | `turnRefusal` president; hex unchecked for single-home | `homeSlotChoice.test.ts`, `heraldHome.test.ts` | PARTIAL | M15 |
| $40 then $100 | 6.3.2 | `stationTokenPrice` | arm | `tokenSpendNote.test.ts` | PASS | funds not checked (C3) |
| Route from another station to the city | 6.3.2 | `evaluateStationPlacement` | **UI/derived only** | `stationConnectivity.test.ts` | UI-ONLY | M6 |
| Empty circle only; one per hex per corp; token count limit | 6.3.2 | same | arm checks only same-hex | `stationTokenWall.test.ts` | UI-ONLY | M6 |
| Not block an un-operated home | 6.3.2 | `homeReservationStands` | UI | `homeReservationClears.test.ts` | UI-ONLY | |
| Full city blocks pass-through, not start/end | 6.3.3 | `cityBlocking.ts` in `reachableTrack` | UI route search | `cityBlocking.test.ts`, `routeCityBlocking.test.ts` | UI-ONLY | (C2) |
| One token per turn | 6.3.2 | cursor | — | — | UI-ONLY | |
| DH free token on F16 turn of lay | p.11 | `PlaceHomeStation{kind:"dh"}` | `turnRefusal` owner | `dhTokenStep.test.ts` | PASS | |

### H. Routes

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Each train once; ≥2 cities; a station on route; city limit | 6.4/6.4.1 | `routeAutoTrace`, `runTrainsRules`, `routeTruncate` | UI | `oneRunPerTurn`, `routeTokenRule`, `trainReach`, `dieselRouteCap` tests | UI-ONLY | C2 |
| Continuous; no reverse at junction; no crossover change; no track reuse | 6.4.2 | `trackSegments`, `routeConnection`, `forkedTrackReuse` | UI | `trackContinuity`, `forkedTrackReuse`, `visitOnce` tests | UI-ONLY | C2 |
| Red areas terminal only | 6.4.2 | `isRouteTerminusHex`, `offboardTerminality` | UI (`sandboxRouteBreakdown` prices, doesn't refuse) | `offboardTerminality.test.ts` | UI-ONLY | |
| Enter/exit city on different track; different sections same tile; different cities same hex counted | 6.4.2 | `cityVisitedAt` per-city dedupe | reducer pricing ✓ | `perCityRevenue.test.ts`, `sharedCityRouting.test.ts` | PASS | pricing half is in the machine |
| No shared track between trains; may meet at cities | 6.4.2 | `multiTrainRouting` | UI | `multiTrainRouting.test.ts` | UI-ONLY | |
| No double-heading | 6.4.1 note | one route per train in UI | UI | — | UI-ONLY | |
| Train may not run the turn it is bought | 6.4 note | order of steps (Run before Buy) | cursor | — | PASS | |

### I. Revenue & dividends

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Revenue = sum of city values; off-board lesser/greater by first 5-train | 6.5 | `hexStopValue`, `offboardValueForEra` (Brown era = phase 5+) | reducer | `chipRunRevenue.test.ts`, `hexValueAgreement.test.ts` | PASS | |
| Highest-revenue combination if demonstrated | 6.4 | `maxRouteRevenueFor` (derived-actions only) | not enforced | — | PARTIAL | machine neither chooses nor checks |
| Dividends 10% per share; pool → treasury; IPO unpaid | 6.5 | `dividendSplit` | arm | `dividendPools.test.ts`, `dividendSplit` tests | PASS | |
| Withhold → treasury | 6.5 | arm | arm | `doubleWithhold.test.ts` | PASS | |
| Declared amount = run revenue | 6.5 | message-trusted | — | — | FAIL | C1 |
| No dividend on $0; token moves left | 6.5/4.5 | forced withhold derived action | `nextDerivedAction` | `phantomDividend.test.ts` | PASS | |
| Right/up on pay, left/down on withhold | 4.5 | `dividendStepFrom` | market step | `marketTraversal.test.ts`, `dividendLedge.test.ts` | PASS | |
| Corp-owned private revenue → treasury, not dividendable | 6.5 note | `applyPrivateRevenue` | transition | `privateRevenue.test.ts` | PASS | |
| Purchases cash-only; revenue not usable until step 4 | 6.1 note | step order; treasury credited at Dividends | cursor | — | PASS | |

### J. Trains & phases

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Buy in increasing order from bank; one at a time | 6.6 | `openDepotTiers` queue rule; each purchase one message | `buyDepotTrain` | `depotSurface.test.ts`, `upcomingTier.test.ts` | PASS | |
| Diesel available after first 6; $1100 / $800 trade-in of 4/5/6; legal at limit; traded train to pool | 6.6 | `STANDARD_OPEN_SHELF`, `dieselExchange.ts`, `returned_trains` | arm + `dieselExchangeRefusal` | `dieselExchange.test.ts` | PASS | |
| Phase change immediately on first train of a type | 2.0 note | `derivePhase` from fleet; `applyPhaseChange` inside `buyDepotTrain` | arm | `phaseEraToast.test.ts`, `trainLimit.test.ts` | PASS | |
| Train limits 4/4/3/2/2/2 apply immediately | 2.x/6.6.1 | `TIER_PRESENTATION.trainLimit`, `trainPurchaseRefusal`, trim | arm | `trainLimit.test.ts` | PASS | |
| Excess: president chooses; discard to pool; highest-valued decides first | 6.6.1 | automatic cheapest-first, discarded lost | arm | `fleetDiscard.test.ts` pins auto behaviour | FAIL | C6 |
| Rust 2s at first 4, 3s at first 6, 4s at first D | 2.4/2.6/2.7 | `tiersRustedBy` in `applyPhaseChange` | arm | `rustChipEscalation`, `gentleRust*` tests | PASS | Gentle Rust variant separate ✓ |
| Privates close at first 5 | 2.5/3.2 | `closesPrivateCompanies("5")` | `applyPhaseChange` | `privateClosure.test.ts` | PASS | |
| Off-board greater values from first 5 | 2.5 | era-based | pricing | `hexValueAgreement.test.ts` | PASS | |
| Pool trains purchasable at face any time | 6.6 | `buyReturnedTrain` (diesel trade-ins only) | arm | `trainOffer.test.ts` | PARTIAL | discarded excess trains never enter the pool (C6) |
| Buy from another railroad, agreed price ≥ $1, during buyer's turn, may take last train | 6.6 | `Propose/AnswerTrainPurchase` → `settleTrainSale` | consent owner check only | `trainOffer.test.ts` | UI-ONLY | M14 |
| Buyer at limit may not buy | 6.6 | `trainPurchaseRefusal` (depot) only | arm | ✓ for depot | PARTIAL | not applied to inter-corporate sale |
| Newly bought train cannot run this turn | 6.4 note | step order | cursor | — | PASS | |

### K. Forced / emergency purchase

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Forced only if legal route and no train | 6.6.2 | `trainObligation.trainPurchaseRefusal` (UI), `earnableRevenueVerdict` | **UI**; `PassTurn` always advances | `emergencyTrainFlow.test.ts` | UI-ONLY | C4 |
| Cheapest available (bank, pool, other railroad offers) | 6.6.2 | first depot tier with stock | arm | — | PARTIAL | M9: 5 chosen over 6/D ✓; pool ignored |
| Treasury first, then president | 6.6.2 | `EmergencyBuyHardware` shortfall | arm | `emergencyTrainFlow.test.ts` | PASS / TEST GAP | |
| President may not pay above face to another railroad | 6.6.2 | none | — | — | MISSING | |
| Cannot cover → forced share sales; only enough; no presidency change of the rescued corp | 6.6.3 | `resolveEmergencyFunding`, `sellableHoldings` (UI model) | UI | `playerLiquidity.test.ts` | PARTIAL | M12 |
| Not obliged to buy another corp's cheaper train | 6.6.2 note | n/a (not modelled) | — | — | PASS | vacuous |

### L. Bankruptcy & game end

| Rule | § | Implementation | Enforcement | Tests | Status | Notes |
|---|---|---|---|---|---|---|
| Bank breaks → finish OR set (or SR + set) → end | 7.0 | `bankIsBroken` at `operating_round_just_ended` | transition | `bankBreakEnding.test.ts`, `gameEndCondition.test.ts` | PASS | |
| Bank keeps paying after break | 7.0 | zero floor + players credited | — | — | PASS | m11 |
| Player bankruptcy ends game immediately | 6.7/7.1 | none | — | `gameOutro.test.ts` (UI) | MISSING | C4 |
| Winner = cash + shares×value + face of open privates; corp-owned/closed privates $0 | 7.0 | `rankPlayers` | UI | `playerNetWorth.test.ts` | PASS | treasuries excluded ✓ |
| Bankrupt player can win; score = unsellable shares | 6.6.3 note | "bankrupt never wins" | UI | `accolades.test.ts` | FAIL | M11 |
| Ties | 7.0 | shared rank | UI | ✓ | PASS | rulebook silent |
| No house end trigger ($350) | — | removed from frontend (#652); `market.rs` still has it | — | `gameEndCondition.test.ts` | PASS | Rust only |

### M. Private companies

| Company | Rules checked | Status | Notes |
|---|---|---|---|
| SV | revenue $5, no power, markdown behaviour | PARTIAL | markdown misapplied to others (C5) |
| CS | extra lay on B20 unconnected; two tiles that turn | PASS | `bonusLay.ts`, `cslPowerState`; m10 on lapse |
| DH | yellow 57 on F16 for $120, free token same turn, counts as the lay, lapses when others tile F16 | PASS | `dhPower.ts`, `PlaceHomeStation{dh}` |
| MH | NYC 10% from bank or pool if <60% and available; SR turn or between turns; closes | PASS | `mohawkExchange.ts` (Slice 8.4, #1630–#1634): m6's `source` is on the message and is the owner's choice, never switched for them; the between-turns window is a queued request revalidated at the next legal boundary; sale-before-par enforced (M8 closed) |
| CA | PRR 10% to auction buyer; stays open; share unsellable until PRR parred | PASS | unsellable-until-parred enforced by `stockSaleRefusal` rule 4 (M8 closed by Batch 7.2 + Slice 8.5) |
| BO | president's cert + par; never to a corporation; stays with owner on presidency loss; closes on B&O's first train | PASS | `grantBOPresidency`, `isSellableToCorporation`, `settleBaoPrivate` |
| All | corporations may buy privates phase 3–4 at 50–200% face, any time in their turn; never sell them; closed at first 5; cannot close voluntarily or sell to pool | PARTIAL | M13; closure ✓ |

### N. Variants

| Configuration | Finding | Status |
|---|---|---|
| Standard | Standard tables (`STANDARD_VARIANTS`) yield the printed game; LPF entities only under `withLevelPlayingFieldEntities`; Dynamic Market row only under `chartFor(dynamicStockMarket)`; 7-train and $750 exchange only under LPF (`onOpenShelf`, `dieselExchangeCostFor`). No leak found. | PASS |
| 1830+ | Implemented board is the owner's Project 18XX+ delta, not the rulebook's p.25 board. | FAIL vs rulebook / UNCLEAR intent (M16) |
| Level Playing Field | ~~Owner-defined (7 seats, N&W/PMQ, JK, 20% double, 7-trains). Internally consistent with `gameVariants.ts`; the rulebook has no counterpart.~~ **Corrected 2026-09-16 (Stage 8, Slice 8.2):** printed as Scenario D, S-1.0 "A Level Playing Field", in the full 48-page Lookout/Mayfair rulebook (`1830 FULL RULES with variants.pdf`, pp. 34–36; Table T-08, p. 47) — N&W/PMQ, JK, the 20% second certificate, 7-trains and up to 7 players are printed there. Source split: the revised 2018 book stays the Classic authority where it covers the subject; the full book governs Scenario-D material it does not contain; owner readings and variations are listed in the backlog's S9-5. Internally consistent with `gameVariants.ts`. Double-certificate half-sale rule (`doubleCertificate.ts`) encoded as ruled. | PASS (vs owner spec — to be read against the printed scenario and S9-5's recorded readings) |
| Delayed Auction | Owner-defined; SR1 opens without privates, auction after the OR set of the first 3-train, B&O locked (`boIsLocked`). | PASS (vs owner spec) |
| Gentle Rust / Unpredictable Revenue / Yellow Sign | Owner-defined; outside the rulebook; not audited for correctness beyond noting they are gated on their flags. | UNCLEAR |

---

## Corrections and tests for every FAIL / PARTIAL / MISSING / UI-ONLY item

Format: requirement → current behaviour → location → why it differs → recommended correction → tests to add.

**C1 Dividend amount** — 6.5: revenue is what the trains ran. Current: `revenue_amount` from message. `sandboxSession.ts`
`DeclareDividends` arm, `dividendSplit.ts:dividendRevenue`. Differs because #752 chose the message to keep the toast and
the reducer on one figure. Correction: in `applySandboxActionCore`, refuse when `Number(revenue_amount) !==
Number(company.last_route_revenue)` (allow "0" when `routes_run_this_turn===0`); keep the field for narration only.
Tests: reducer accepts matching amount; refuses mismatched; refuses positive amount after no run.

**C2 Route validation** — 6.4/6.4.2. Current: arm prices path, validates nothing. Correction: move the validators the UI
already has (`runTrainsRules`, `routeConnection`, `trackSegments`, `cityBlocking`) behind one `routeRefusal(state, grid,
companyId, routes, trains)` in `utils/` and call it in `applySandboxActionCore` before the arm, refusing by identity. Cover:
station on route, capacity per named train, ≤ trains owned, distinct trains, continuity, no reversal, no track reuse
within or across routes, red terminal-only, blocked pass-through. Tests: one refusal per rule using the p.22 example board
(FE/FCBE/FIJ legal; FCG, FCBAD, DE, FEBCF, EFE, FED+FEH illegal).

**C3 Cash gates** — Correction: `sharePurchaseBlock` gets `charged` vs `cash_vgp`; `applyAuctionStep` refuses a buy/win
whose charge exceeds `availableCash`; `PlaceStationToken`, `BuyPrivateCompany`, `settleTrainSale` refuse when treasury
< price; replace `Math.max(0, …)` in the three adjusters with an invariant check that throws in tests. Tests: each arm
refuses at cash−1, accepts at exact cash; bank never floors during an ordinary game replay (assert on goldens).

**C4 Bankruptcy** — Correction: (a) refuse `PassTurn`/`AdvanceOperatingSubPhase` at Hardware when `trainObligation`
says a purchase is owed; (b) add a `DeclareBankruptcy`-style derived action (or fold into `EmergencyBuyHardware`) that,
when treasury + president cash + `sellableHoldings` proceeds < cheapest available train, sets `current_round_type =
"GameEnd"` with a `game_end_reason` field; (c) `EmergencyBuyHardware` refuses when president cash < shortfall. Tests:
trainless corp with route cannot end turn; trainless corp without route can; underfunded president → GameEnd immediately,
no further actions accepted; funded via sales succeeds.

**C5 Auction all-pass** — Correction: in `WaterfallPass` all-pass branch, mark down only if `target.private_id === SV` (or
`face_value` is the lowest printed face in this game's roster); pay revenue only when SV has an owner. Tests: SV unsold →
SV −5, no revenue; SV sold, CS lowest → CS unchanged, revenue paid.

**C6 Excess trains** — Correction: replace the automatic trim with a pending-discard obligation per corporation
(`pending_train_discard: n`), resolved by a president-sent `DiscardTrain{model}` (highest share value first, enforced via
turn authority), placing the model in `returned_trains`. Tests: phase 5 with three trains → obligation, cursor blocked until
discarded, chosen train appears in depot at face value and is purchasable by another corp; two corps → order by price.

**M1 Mini-auction re-entry** — Correction: passes do not remove bidders; track `consecutive_mini_passes`; end when it
reaches `bidders.length − 1` after the last raise. Tests: A raise, B pass, C raise, B raise accepted; A raise, B pass, C pass → A wins.

**M2 Bids** — refuse `WaterfallBidHigher` on `is_lowest_offered`; refuse when `amount − ownStandingBid > availableCash`.
**M3/M6 OR gates** — in `applySandboxActionCore`, refuse `LayTile`/`PlaceStationToken`/`RunMultipleRoutes`/
`RunManualRoute` whose `protocol_id ≠ operatingCorporationId(state)` or whose step ≠ Track/Tokens/Routes; refuse a second
`LayTile` unless `bonus_lay` **and** the corporation owns CSL and the hex is B20 (derive, don't trust the flag).
**M4** — pass `networkHexes`/`networkPorts` from `trackReach` into the server's `layRefused`; honour the four exceptions.
**M5** — add to `filterSandboxPlacements`: refuse when the hex is a private's hex and that private has a player `owner`.
**M7** — `shareSaleBlock`: refuse when `macro_round_number === 1 && current_round_type === "StockRound"` (delayed-auction
tables: refuse only the first SR, not SR after the auction).
**M8** — `shareSaleBlock`: refuse when `par_value` is null; `priceOf` must not fall back to a nominal price on a sale.
**M9** — emergency: choose min over open depot tiers ∪ `returned_trains`, and allow `buyReturnedTrain` with `requireFunds=false`.
**M10** — `presidentFor`: order challengers by seat distance clockwise from `company.president`. **DONE — Stage 8,
Slice 8.3 (#1620):** one selector, `presidentFor(company, seating)`, with the clockwise tie-break measured from the
incumbent's seat and percentage always ahead of it; the forced-sale projection asks the same function.
**M11** — `rankPlayers`: drop the champion rule; keep `isBankrupt` as a label.
**M12** — `sellableHoldings`: for the rescued corp, allow sales down to the point where no other holder would exceed the
president; cap total proceeds at the shortfall.
**M13** — `BuyPrivateCompany`: refuse unless phase ∈ {3,4}, `0.5·face ≤ price ≤ 2·face`, buyer is operating, seller is a
player, treasury ≥ price.
**M14** — `settleTrainSale`: refuse unless buyer is operating at Hardware, price ≥ 1, buyer under limit, treasury ≥ price.
**M15** — decide: either keep float-time placement as an explicit house rule (document it in the Rules Reference) or move
the obligation to the corporation's first OR turn (`openingSubPhase` gate). Validate the hex against `home_hex_label`.
**DECIDED AND DONE — owner ruling R3, Stage 8, Slice 8.2 (#1610 / #1611 / #1612):** the obligation moved to the start of
the corporation's first operating turn and is derived on the Operating Round cursor; one placement predicate answers at
both locks; the development corpus's float-time placements are carried by the `legacyHomeTokens` adapter (#1614).
**M16** — owner decision: label the board "Project 18XX+" everywhere, or implement the p.25 board as a separate variant.
**m1** — add row (`mark.y`) as the third key. **m6** — add `source` to `ExchangePrivate`. **m8** — validate `par_value ∈
PAR_VALUE_LADDER` in the arm.

---

## Recommended order of work

1. C1, C3, C4(a,c) — one-line refusals with outsized integrity value.
2. M3/M6 gates (restore #1182 now that the order is log-derived); M4; M5.
3. C2 route refusal (largest job; the validators exist).
4. C5, M1, M2 auction fixes (all in one function).
5. C6 discard obligation; M9; C4(b) bankruptcy end path.
6. M7, M8, M10, M11, M12, M13, M14.
7. Decide M15/M16 as rules questions, then implement.
