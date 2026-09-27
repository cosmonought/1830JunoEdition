# Batch 7 — Transaction, cash and auction authority: design / reconstruction pass

Date: 2026-09-15. Baseline: Batch 6 committed (`215eb29`), 355 suites / 5545 tests, `RULES_ENGINE_VERSION` 4.
**No gameplay code was changed. Nothing was committed. The full Jest suite was not run.** Two throw-away probe
scripts were run against the built engine (`server/dist`, rebuilt from the Batch-6 tree) and are described in §4
and §6; they live outside the repository.

> **Bottom line.** Every transaction authority gap the audit named (C3, C5, M1, M2, M13, M14, m8, m9) is confirmed
> live, and the probe found four more that are worse than anything in the ledger: (i) a president can take any
> other corporation's train, or any other player's private company, **without consent and for $0** by sending the
> settlement message directly; (ii) the offer messages trust the counterparty's name from the payload, so a
> proposer can name himself as the owner/seller-president and **answer his own offer**; (iii) `BuyStock` prices an
> IPO purchase from the message's `par_value` (a $1 share) and has no round gate (stock bought and sold during
> Operating Rounds and during the auction); (iv) **money is destroyed** — auction proceeds and terrain fees are
> debited from players/treasuries and never credited to the bank, so the bank is short by the whole auction and
> breaks early in every game. Stage 7 needs `RULES_ENGINE_VERSION` 5. The work divides cleanly: one state-machine
> design (pending offers + consent + settlement) that should stay on Fable, and four mechanically specified batches
> that are safe to hand to Opus once the owner answers the twelve rulings in §11.
>
> **Revision 2 (2026-09-15, after the owner's rulings).** §10/§11 now record the rulings (all thirteen answered);
> §7.1 gains the bank-break latch (the bank break was found *not* to be latched — §7.1a); §7.2's president/par rule
> is rewritten without the contradiction; §7.6a adds the player ↔ player private-company sale as the third offer
> kind (Q12); §12a lists the two genuine ambiguities the rulings created. **Batch 7.1 is frozen and safe to hand to
> Opus.**
>
> **Revision 3 (2026-09-15, final before implementation).** N1 accepted and N2 overridden (§7.6a, D-26/D-27); the
> overall certificate limit added to the player ↔ player trade predicate with its 7.4 tests (§7.6a rule 8); the
> UI-parity classification finalised (§12b, Part C U-19 … U-28) with the owner's Playtest Readiness gate wording
> and the retrospective Batch 1–6 audit as a durable task (U-28). No ambiguity remains. Batch 7.1 unchanged.

---

## 1. Verified rule requirements matrix (1830-RE 2018, Lookout)

**How verified.** The owner's local PDF is not in the connected folders and the container/VM egress denies
`lookout-spiele.de`, so the rulebook was read through the fetch tool's question-and-answer interface against
Lookout's own copy (`en_1830re.html_Rules_1830-RE_EN.pdf`), section by section, with short supporting quotes; the
§6.6.2 / §6.6.3 / §3.0 / §3.1 rows reuse the verbatim quotes Batch 5 took from the same file. Rows marked **(q)**
carry a quote; rows marked **(p)** are paraphrase; rows marked **(silent)** are things the rulebook does not say.
Nothing below was taken from generic 18xx expectation. If the owner wants a stricter pass, dropping the PDF into
either connected folder lets the implementation batch quote page and line.

### 1a. Stock transactions

| # | Rule | § | Machine today | Stage 7 |
|---|---|---|---|---|
| S1 | Turn = "Sell any … Buy 1 … Sell any"; one certificate bought per turn **(q)** | 5.0 | `bought_this_turn` + `turn_action_taken` (authoritative); `stock_turn_stage` is pacing only | keep; the authoritative facts are already state |
| S2 | Brown-box exception: "any number of certificates from the bank pool of **one** corporation" in one purchase **(q)**; orange does not allow it | 4.4 | one message with `quantity`, and a second message allowed when Brown+Bank — not tied to the same corporation | second message must name the same corporation (§11 Q9) |
| S3 | "Certificates may not be sold in the first stock round" **(q)** | 5.1 | absent (S8-7) | refuse `SellStock` when `current_round_type==="StockRound" && macro_round_number===1` |
| S4 | Sales to the Bank Pool at market price; ≤ 5 certificates in the pool; "you may not later buy … in the same stock round" **(q)** | 5.1 | pool cap 50 % (m7), `sold_this_round` lock — implemented | unchanged |
| S5 | "You may not sell the president's certificate"; presidency passes on selling down below another holder **(q)** | 5.1 / 5.4 | successor rule (`shareSaleBlock`), `settlePresidencies` | unchanged (tie order is S8-2) |
| S6 | Buy from the IPO at par or the pool at market price **(q)**; cash is physical — no credit (6.1 note applies to corporations; for players it is implicit) | 5.2 / 4.1 | IPO price **from the message's `par_value`**; pool price from `market_positions`; **no affordability check** (C3) | price derived from state; `cash ≥ charged` |
| S7 | First certificate = president's 20 %, par ∈ {67,71,76,82,90,100}, "You must pay twice this value" **(q)** | 5.2 / 4.2 | par written from the message, unvalidated (m8/S8-9); charged 2×message par | par ∈ ladder in effect; charged 2×par; cash gate |
| S8 | 60 % cap (orange/brown waive); overall certificate limit (yellow/orange/brown exempt); conform "during the player's next turn in a stock round" **(q)** | 4.3 / 4.4 | `sharePurchaseBlock`, `divestmentDebt` — implemented | unchanged |
| S9 | A pool/IPO purchase requires a certificate to exist there (physical) | 5.2 | `ordinaryPurchaseRefusal` checks only the double certificate; a buy from an empty source charges and delivers nothing (m9) | refuse when the source holds < the certificates asked |
| S10 | Float at 60 %; treasury 10×par "at the end of the stock round" **(q)** | 5.3 | paid on the crossing purchase (m4, recorded) | unchanged |
| S11 | Shares granted by C&A / M&H "cannot be sold until the president's certificate has been purchased" **(q)** | p.15 | absent (M8/S8-8) | refuse a sale when `par_value === null` |
| S12 | Priority Deal to the left of the last buyer/seller; consecutive passes end the round **(q)** | 5.0 | `recordPass` / `markTrader` — implemented | unchanged |
| S13 | Private companies "may be sold between players for any mutually agreed price at any time during the buyer's or the seller's turn of a stock round (other than the first)" **(q)** — a §3.1 private-company rule, not a §5 certificate rule; the ½–2× band of §3.1's corporation sentence does not apply | 3.1 | no message (S7-9) | **ruled Q12: implement** as the third offer kind of the pending-offer machinery (§7.6a) |
| S14 | Buying and selling are Stock Round actions (the OR has its own sequence; the auction is its own round) **(p)** | 5.0 / 6.1 | **no round gate**: `BuyStock`/`SellStock` apply in an OR and in the auction (probe §6) | refuse outside `StockRound` (forced §6.6.3 sale excepted) |

### 1b. Private company purchases by corporations

| # | Rule | § | Machine today | Stage 7 |
|---|---|---|---|---|
| P1 | "During phases 3 and 4, a railroad may buy a private company at any time during its turn in an operating round" **(q)** | 3.0 | no phase / turn / step check on `BuyPrivateCompany` (M13, S7-6/7) | phase ∈ {3,4}; buyer = operating corporation; any step of its turn |
| P2 | Price "not … less than half or more than twice the face value … and must be publicly declared" **(q)** | 3.1 | band exists (`privatePriceBand.ts`) but applied only to the emergency sale | band on every ordinary purchase; the declared price is the message/offer price |
| P3 | Corporation treasury pays; the player receives **(p)** | 3.1 | `transferPrivateToCorporation`: treasury → `owner` when it is a player; **when the seller is a corporation or nobody, the treasury is debited and nobody is paid** | seller must be a player; treasury ≥ price |
| P4 | "Private companies may be bought by railroad corporations but not sold by them" **(q)** | 3.1 | the arm accepts `owner_protocol_id` sellers | refuse |
| P5 | "The BO private company may not be sold to any corporation" **(q)**; closes when the B&O buys its first train | 3.1 / p.27 | `isSellableToCorporation`, `settleBaoPrivate` — implemented | unchanged |
| P6 | All privates close at the first 5-train; none may be closed voluntarily or sold to the pool **(q)** | 2.5 / 3.2 | implemented | refuse a purchase of a `closed` private (currently no check) |
| P7 | Consent: a sale between a player and a corporation with different principals needs both **(p — the game's own #701 model)** | — | the direct message settles without consent; the offer's `owner` is the payload's | consent predicate (§7) |

### 1c. Intercorporate train sales

| # | Rule | § | Machine today | Stage 7 |
|---|---|---|---|---|
| T1 | "A train may be purchased from another railroad for any price that is mutually agreed to by the president(s)"; "The minimum price … is $1" **(q)** | 6.6 | `settleTrainSale` accepts any price; ≤ 0 becomes a free transfer; a negative price is discarded | integer ≥ 1 |
| T2 | "The entire transaction must be completed during the purchasing railroad's turn", at step 5 (Purchase Trains) **(q/p)** | 6.6 / 6.1 | no check (M14) | buyer = operating corporation at `Hardware`; the *proposal* too (see §7 for why) |
| T3 | Both presidents agree **(q)** | 6.6 | direct settlement needs no offer; the offer's `seller_president` is the payload's | consent predicate (§7) |
| T4 | "A railroad may buy another railroad's last train" **(q)** | 6.6 | allowed | allowed (unchanged) |
| T5 | "If the railroad already meets or exceeds the current phase's limit … it may not purchase a train" **(q)** | 6.6 | limit gate (Stage 4) | unchanged |
| T6 | "Purchases must be made with available money. Credit is not allowed" **(q)**; the president's money enters only in the forced case (§6.6.2) **(p)** | 6.1 note / 6.6.2 | no treasury check; `adjustTreasury` floors | treasury ≥ price for a voluntary purchase; D-6 unchanged for the forced case |
| T7 | Forced case: "the price paid for a train from another railroad may not exceed the train's face value" when the president contributes **(q)** | 6.6.2 | `fundedTradeRefusal` (D-6) | unchanged |
| T8 | "a train may not run on the turn it is purchased" **(q)** | 6.4 note | step order | proposals only at `Hardware`, so a settlement can never land before Run Trains (§7) |
| T9 | Trains are bought one at a time; several per turn allowed **(q)** | 6.6 | one train per message | unchanged |

### 1d. The initial Private Company auction

| # | Rule | § | Machine today | Stage 7 |
|---|---|---|---|---|
| A1 | Options: pass; buy the lowest-face unsold private at face; bid on a private **other than** the lowest **(q)** | 1.2 | a bid on the lowest is accepted and opens a mini-auction at once (M2) | refuse a bid on `is_lowest_offered` |
| A2 | Bid ≥ face (or the standing bid) + $5, "a multiple of $1" **(q)** | 1.2.1 | `minimumBidFor` enforced (#1184); integer by schema | unchanged |
| A3 | "place the bid money in front of him … not use it for any other purpose until ownership … is resolved" **(q)** | 1.2.1 | escrow is *derived* (`auctionEscrow.ts`) and used only by the UI; the reducer never asks | `amount − ownStanding ≤ availableCash` on every bid/raise; `availableCash ≥ face` on a buy |
| A4 | Lowest has one bid → that bidder buys at the bid; ≥ 2 bids → auction **(q)** | 1.2.2 | `cascade` — implemented | unchanged |
| A5 | Mini-auction: only prior bidders; lowest bidder starts; clockwise; raise ≥ $5; "may pass and still bid later if the auction does not end"; ends when "all of the bidders pass consecutively"; high bidder pays "the money he originally bid and additional money if necessary" **(q)** | 1.2.2 | pass **removes** the bidder and his bid (M1); no $5 minimum on a raise; no cash check | passes counted since the last raise; bidder and bid stay; end at `bidders − 1` consecutive passes; raise ≥ high + 5; escrow-aware |
| A6 | "As soon as the auction is resolved, it is checked if the next private company also has bids on it" **(q)** | 1.2.2 | `cascade` — implemented | unchanged |
| A7 | After a face-value purchase "The player to your left gets the priority deal card"; "The priority deal card does not change hands after an auction" **(q)** | 1.2 / 1.2.2 | rotation model: `current_turn` preserved across a contest (#338/#1232) — equivalent | unchanged |
| A8 | All pass, SV unsold → SV −$5 **(q)**; at $0 "the next player … must buy the SV … treated as a purchase" **(q)** | 1.2.3 | marks down **whichever private is lowest** (C5); $0 branch OK | markdown only when the lowest is the SV |
| A9 | All pass, SV sold → "each of the private companies already bought pays revenue … Then the buy-bid-turn sequence resumes" **(q)**; no markdown | 1.2.3 | revenue paid on **every** all-pass, markdown too (C5, m12) | revenue only when the SV is owned; no markdown then |
| A10 | Losers' money released when resolved **(q)** | 1.2.1 | derived escrow — implicit | unchanged (a passer's bid now stays escrowed until resolution, per A5) |
| A11 | Auction ends when all are bought; SR1 opens with the priority holder **(q)** | 1.2 | `OpenStockRound` (#1235) | unchanged |
| A12 | Raising one's **own** standing bid during the buy-bid sequence: permitted — the §1.2.3 note that a player gains little benefit from bidding twice on the same company presupposes that repeated bids on one company are legal **(p, owner's reading, Q3)** | 1.2 / 1.2.3 | allowed (a raise replaces) | keep; recorded as an owner ruling (Part D) |
| A13 | Money paid for a private goes to the bank **(p — the bank is the counterparty of every purchase)** | 1.2 / p.5 | **never credited** (see §4) | credit the bank |
| A14 | Main-rotation actions are not taken while a contest is live **(p)** | 1.2.2 | `WaterfallPass`/`BuyLowest`/`BidHigher` are applied by the mini-auction's current player during a live contest, moving the main rotation | refuse main-rotation messages while `mini_auction` is live |

### 1e. Owner decisions preserved unchanged (must survive)

D-5 (emergency private sale: player → corporation directed offer, buyer's own-turn timing relaxed only, phases 3–4,
band, treasury, B&O ban, no corporate resale, rescued corporation not a buyer, optional, settlement revalidated) and
D-6 (forced intercorporate purchase only when treasury + president's current cash covers the price, treasury first,
face cap when the president contributes, otherwise refused and resolved through the Bank) are **not** touched by
anything below. The ordinary predicates in §7 exclude `funding: true` offers exactly as `AnswerPrivatePurchase`
already does, and `fundedTradeRefusal` keeps its place in the core ahead of the ordinary train predicate.

---

## 2. Ledger items and audit findings this stage owns

| Ledger | Audit | Verified state (this pass) | Closed by |
|---|---|---|---|
| S7-1 zero floors | C3, m9, m11 | confirmed: `adjustCash`/`adjustTreasury`/`adjustBank` floor; every corpus log with a Stock Round shows minted purchases (§4, §6) | Batch 7.1 + 7.2 |
| S7-2 all-pass markdown/revenue | C5, m12 | confirmed: JUNO-Z6C 9/12 (B&O marked 220→215→210 with SV sold), JUNO-G6J 7 (JK marked, golden) | 7.3 |
| S7-3 mini-auction pass removes the bidder | M1 | confirmed in the arm; corpus has 2-bidder contests only (outcome identical) | 7.3 |
| S7-4 bid on lowest; escrow-blind; raise minimum | M2 | confirmed by probe (bid $9999 with $1160; raise +$1) | 7.3 |
| S7-5 train sale: operating at Hardware, ≥ $1, treasury | M14 | confirmed; plus consent and negative price (new) | 7.4 |
| S7-6 ordinary `BuyPrivateCompany` gates | M13 | confirmed; plus consent, corporate seller paid into the void (new) | 7.4 |
| S7-7 `BuyPrivateCompany.protocol_id` operating check | M13 | confirmed (accepted in a Stock Round, buyer not operating) | 7.4 |
| S7-8 pending-offer authority | — | confirmed: offers trust payload names; no rescission; outlive the turn/round (FCJ 232→234, 273→274 answered in a Stock Round) | 7.4 |
| S7-9 player↔player private sales | UNCLEAR | rulebook confirms the rule exists (S13) — **ruled Q12: implement** | 7.4 (§7.6a) |
| S8-7 first-SR sale ban | M7 | confirmed absent (probe) — **absorbed into Stage 7 (Q2)** | 7.2 |
| S8-8 unparred share sale | M8 | the sale half absorbed (Q2): a C&A/M&H-granted share cannot be sold before the corporation is parred; the `priceOf` fallback prose stays in Stage 8 | 7.2 |
| S8-9 par ladder / silent president conversion | m8 | confirmed (par 999 accepted; no-par IPO buy converted) — **absorbed (Q2)** | 7.2 |
| (new) S7-20 bank break not latched | — | §7.1a: the ending is re-derived from `bank ≤ 0` at the set boundary; a bank that recovers before then never ends the game (probe-free, by inspection) | 7.1 |
| S10-1 refusal transport | — | **every reducer refusal on a board with `market_positions` returns a new object** (`applySandboxActionAfterAuction` allocates `settled` before the core runs), so identity-based refusal detection is dead on every pinned board; Stage 7 tests must compare `stateDigest` | note only; tests |
| S10-9 price field types | — | unchanged; the reducer validates numerically, the wire keeps both spellings | note |
| S10-18 auction escrow at the reducer | — | covered by 7.3 tests | 7.3 |

New findings for the ledger (proposed ids S7-10 … S7-18) are listed in §14.

---

## 3. Current architecture (as built)

Pipeline for every client message: `gameServer.ts` (frame kind → `validateSubmitEnvelope` → `validateGameplayMessage`,
shape only) → `RoomSession.submit` (build pin, retry dedupe, staleness, `settleOwed`, **`turnRefusal`**, append) →
`RoomEngine.apply` (`applySandboxAction` with `chartInjections` + `actor` + `mapGrid` + `marketContext` + `parValue`
+ `layRefused`) → `settleOwed` (`nextDerivedAction` loop). `applySandboxAction` = `applyAuctionStep` (the waterfall
atom, charges, wins, all-pass revenue) → market step (`applySandboxMarketAction`: token moves and `tradePrice`) →
`applySandboxActionCore` (holds and gates, then `applyOneAction`, then `settleRoundTransitions` / `settleEra` /
`settleBaoPrivate` / `settleOperatingCursor` / `settleBankruptcy`) → sold-out rises / `reconcileParMarks` →
`settleAuctionLifecycle`.

| Flow | UI dispatch | Ingress (shape) | Authorization (`turnRefusal`) | Reducer legality | Mutation | Settlement / derived | Replay |
|---|---|---|---|---|---|---|---|
| `BuyStock` | `App.handleBuyShare` with the company's par | `protocol_id int, source enum, par_value string\|null?, quantity int?, certificate` | seat (`actingAddress`) | `sharePurchaseBlock` (zones, limits, lockout, one-per-turn, double) — **no round, price, availability, cash** | `adjustCash −charged`, `adjustBank +charged`, `moveShares`, presidency/par write, float, `settlePresidencies` | seat stays (Sell-Buy-Sell) or home-token hold | price from message par / chart; legacy logs replay old seat rules |
| `SellStock` | shell | `percentage finite` | seat; emergency owner check | `shareSaleBlock` (holding, pool cap, successor, double); forced-sale rules — **no round, SR1, parred, ×10** | market step moves the token first (`saleRefused` closure), then cash/bank/shares, `sold_this_round` | — | proceeds from `market_positions` |
| President's certificate / par | `BuyStock{source:Ipo, par_value}` on an unparred corporation | as above | seat | `isPresidentBuy` when president & par null — **par unvalidated; absent par → 67** | par written from message; 2× charged | `applyFloatThreshold` (10×par from the bank) | — |
| `SetBoPar` | after the B&O private is won | `player string, par_value string` | owner by name (`roomMessageRefusal`) | `boPresidencyRefusal` (president null, IPO ≥ 20 %) — **par unvalidated** | 20 % to the winner, no cash | — | — |
| `BuyPrivateCompany` (direct) | shell, when the buyer's president owns the private | `protocol_id, private_id, price string` | seat = operating president | **B&O ban + owner idempotency only** (`transferPrivateToCorporation`) | `adjustTreasury −price`, `adjustCash +price` to `owner` (a corporation/nobody seller is paid nothing) | clears a matching offer | price from message |
| `ProposePrivatePurchase` → `AnswerPrivatePurchase` → derived `BuyPrivateCompany` | shell (different principals) | payload carries `owner`, `price finite` | proposer = buyer's president (#1450); answer = **`offer.owner` from the payload** | **none at proposal; none at answer; none at settlement** | proposal overwrites any standing offer; answer sets `accepted`; derived purchase minted by `nextDerivedAction` | the derived purchase runs the same unchecked arm | offer state rebuilt by replay; no rescission message exists |
| `BuyTrainFromCorporation` (direct) | shell, same president both sides | `buyer, seller, model_type, price string` | seat = operating president | limit gate (Stage 4), D-6 funded-trade gate — **no consent, operating, step, ≥ $1, treasury** | `settleTrainSale`: train moves, `adjustTreasury` both sides (price ≤ 0 → $0) | clears a matching offer | — |
| `ProposeTrainPurchase` → `AnswerTrainPurchase` → derived `BuyTrainFromCorporation` | shell | payload carries `seller_president` | proposer = buyer's president; answer = **`offer.seller_president` from the payload** | none at any of the three moments beyond the limit/D-6 gates | as above | `AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer` are chain-era no-ops (`offer_id`) | no rescission |
| Auction (`WaterfallBuyLowest` / `BidHigher` / `Pass` / `MiniAuctionRaise` / `MiniAuctionPass`) | dashboard | ids/amount strings | `actingAddress` = mini cursor, else `waterfall.current_turn` | sub-reducer: minimum bid only | `applyAuctionStep`: player cash `Math.max(0, cash − amount)`; **bank never credited**; wins written; C&A grant; `applyPrivateRevenue` on every all-pass | `settleAuctionLifecycle` | actor is the atom's cursor, not the entry's |
| `BidOnPrivate` (legacy) | nobody | `private_id, bid_amount` | seat | none | `advanceSeat` (state) while the waterfall atom stands still | — | absent from the corpus |

Distinguishing the four layers as the brief asks: (1) structural schema — complete and correct for every message
above; (2) actor authorization — seat/owner/consent at ingress, **but the consent half reads names the proposer
wrote**; (3) reducer legality — present for zones/limits/lockout/limit-in-force/D-6, absent for price, cash, round,
consent, phase, step, band, availability; (4) mutation — three floored adjusters, two of which are reached without
a precondition in front of them.

---

## 4. Money-flow / affordability table

`action → payer → recipient → amount source → affordability gate → mutation helper → status`. "Floor dead" means a
gate in front of the helper makes the floor unreachable; "floor live" means the floor is the only thing standing.

| Action | Payer → recipient | Amount source | Gate | Helper | Status |
|---|---|---|---|---|---|
| `BuyStock` (IPO, ordinary) | player → bank | **message `par_value`** (else chart, else $67) | none | `adjustCash`, `adjustBank` | **floor live; price forged** — probe: $1 share |
| `BuyStock` (president) | player → bank | 2 × message par | none | same | **floor live; par forged** — probe: par 999 mints $1,048; par 1 pays $2 |
| `BuyStock` (pool) | player → bank | `market_positions` price × certificates | none; availability not checked | same | **floor live**; empty pool charges for nothing (m9) |
| `BuyStock` double (LPF) | player → bank | 2 × price | `doublePurchaseRefusal` (placement) | same | floor live — Z6C 193 minted $89 |
| `SellStock` | bank → player | chart price × certificates (pre-drop) | `shareSaleBlock`, forced-sale rules | `adjustCash +`, `adjustBank −` | bank floor after break only (m11) |
| Float capitalisation | bank → treasury | 10 × `par_value` | none (par unvalidated) | `adjustBank −`, treasury + | floor on the bank; a forged par capitalises a forged amount |
| Auction buy / win / $0 taker | player → **nobody** | face / bid / 0 | none | inline `Math.max(0, cash − amount)` | **floor live; bank never credited** (bank constant through every purchase in all six server logs that hold an auction) |
| Auction bids | escrow (derived) | bid | UI only | none | reducer blind to escrow |
| All-pass private revenue | bank → owners | catalog revenue | — | `applyPrivateRevenue` | paid on every all-pass (C5) |
| `SetBoPar` | — | — | — | — | no money; par unvalidated |
| `BuyPrivateCompany` (direct / derived) | treasury → player `owner` | message / offer price | B&O ban, idempotency | `adjustTreasury −`, `adjustCash +` | **floor live** (probe: $1 from an empty treasury mints $1; price −500 reverses the flow and mints $205); corporation/none seller paid into the void |
| Emergency private sale (D-5) | treasury → player | offer price | `fundingPrivateSaleRefusal` twice | same helper | floor dead (gate in front) |
| `BuyTrainFromCorporation` (voluntary) | treasury → treasury | message price, ≤ 0 → 0 | limit only | `adjustTreasury` ×2 | **floor live**; $0 grabs |
| `BuyTrainFromCorporation` (forced, D-6) | president → treasury → treasury | offer price | `fundedTradeRefusal` | `adjustCash`, `adjustTreasury` | floor dead |
| Depot / pool train | treasury → bank | `DEPOT_COST` | `trainPurchaseRefusal(requireFunds)` | `adjustTreasury`, `adjustBank` | floor dead |
| `EmergencyBuyHardware` | president → treasury → bank | derived | `emergencyPurchaseRefusal`; cash ≥ shortfall | same | floor dead (Batch 4/5) |
| Diesel exchange | treasury → bank | `dieselExchangeCostFor` | `dieselExchangeRefusal` | same | floor dead |
| `PlaceStationToken` | treasury → bank | `stationTokenPrice` | `stationPlacementGate` (treasury ≥ cost) | same | floor dead |
| `LayTile` terrain fee | treasury → **nobody** | `terrainFeeDue` | #891 (treasury ≥ fee) | `adjustTreasury −` only | floor dead; **bank never credited** |
| Kanawha licence (LPF) | treasury → bank | constant | `kanawhaLicenseRefusal` | same | floor dead |
| Dividends / withhold | bank → players / treasury | evaluator (Batch 6) | C1 | `adjustCash`, `adjustTreasury`, `adjustBank −` | bank floor after break only |
| OR private revenue | bank → owners | catalog | — | `applyPrivateRevenue` | as above |
| `YellowSignEvent` award | nobody → treasury | message `cash` | — | treasury + | mints (Stage 9, S9-1 — not absorbed) |

**Conservation evidence.** A probe summing bank + every player + every treasury after each replayed entry found the
total changes on: every auction purchase (bank not credited), every terrain-fee lay (bank not credited), every
unaffordable `BuyStock` (floor minting — JUNO-3XD 28, 31, 211, 291–300; JUNO-Z6C 193, 261, 264, 347–354, 473–483;
JUNO-FCJ 106, 109, 150, 181–194, 288–303, 379), and Yellow-Sign awards (Z6C 203). Nothing else moves the total,
which is the positive result: trains, tokens, dividends, revenue, float and the emergency paths conserve.

---

## 5. Authority holes still present (proved by the probe, §6 has the transcript)

1. `BuyStock` prices an IPO purchase from the message: `par_value: "1"` on a parred corporation buys a share for
   $1; the company's `par_value` is never consulted for the price.
2. A president's purchase accepts any positive par (`999` accepted; `1` accepted); an IPO buy with no `par_value`
   on an unparred corporation silently becomes the president's purchase at $67 (m8).
3. No cash check on any stock purchase (C3) — $100 share with $50 in hand: cash → 0, bank +100.
4. A pool/IPO purchase with nothing in the source charges and delivers nothing (m9).
5. `BuyStock` / `SellStock` have no round gate: applied during an Operating Round by the operating president and
   during the auction by the auction's current player (a president's certificate bought mid-auction).
6. No first-Stock-Round sale ban (M7); unparred shares sell at $67 (M8); `percentage: 15` is accepted and leaves a
   5 % holding.
7. `BuyPrivateCompany` sent directly by the operating president takes **any player's** private for **any** price
   (probe: SV for $1 in phase 2; price `-500` pays the treasury $500 and zeroes the owner) — no consent, no
   phase, no band, no operating check, no treasury check; a corporation-owned private transfers corp → corp with
   the price paid to nobody.
8. `ProposePrivatePurchase.owner` and `ProposeTrainPurchase.seller_president` are trusted: the proposer names
   himself, answers his own offer, and the derived settlement lands (probe: SV taken for $1 through the offer
   path). Direct `BuyTrainFromCorporation` with no offer and a different seller president takes the train for $0.
9. A proposal overwrites any standing offer; there is no rescission; nothing clears an offer at turn or round end
   (FCJ 232/273 were answered in a later Stock Round); nothing blocks progression while an offer waits.
10. Auction: a bid on the lowest-offered private is accepted; bids and raises ignore cash and escrow ($9,999 with
    $1,160); a mini-auction raise of +$1 is accepted; a face-value buy with $10 in hand succeeds; the mini-auction
    pass expels the bidder; the all-pass marks down whichever private is lowest and pays revenue every time;
    main-rotation messages are applied by the contest's current player while the contest is live.
11. Money destroyed: auction proceeds and terrain fees leave the game (§4).
12. `BidOnPrivate` (legacy, undispatched) advances the seat cursor without touching the auction atom.

What is **not** a hole: seat authority (ingress refused every wrong-actor probe), the Stage-4/5 train-purchase and
emergency paths, token/terrain/licence affordability, the sold-this-round lockout, one purchase per turn (rule 4
fires — `boughtThisTurn` is passed), the B&O bans, the Batch-6 route/dividend authority.

---

## 6. Probe transcript (headless, built engine, JUNO-CV4 prefixes)

Method: replay `server/data/JUNO-CV4.log.jsonl` to index 12 (Stock Round 1 open), 27 (B&O operating, Tokens
step) and 3/6 (auction, mini-auction) under the development-corpus policy; apply crafted messages through
`applySandboxAction` with the same context `RoomEngine.apply` builds; ask `turnRefusal` alongside. "APPLIED"
below means the returned object differs — on a board with `market_positions` that is always true (S10-1), so the
verdicts were read from the printed cash/holdings, not from identity.

```
SR1  IPO buy of parred B&O with par_value "1"          ingress ALLOWED  cash 950→949, holding +10%
SR1  president purchase of PRR, par_value "999"         ingress ALLOWED  cash 950→0, PRR par 999, money total +1048
SR1  president purchase of PRR, par_value "1"           ingress ALLOWED  cash 950→948, PRR par 1
SR1  IPO buy of unparred PRR with no par_value          ingress ALLOWED  cash 950→816, PRR par 67, president set
SR1  buy B&O IPO at $100 with $50                       ingress ALLOWED  cash 50→0, bank +100
SR1  legal-looking 10% sale in the first Stock Round    reducer applied  cash 695→795, pool 10
SR1  BuyStock from an empty pool                        ingress ALLOWED  cash 950→850, nothing delivered
SR1  wrong actor buys                                   ingress "It is not your turn."   (reducer applied)
SR1  BuyPrivateCompany during the Stock Round           ingress ALLOWED  private → corporation, treasury 0→0, seller +1
OR   operating president buys another player's SV, $1  ingress ALLOWED  owner +1, treasury −1, private → B&O (phase 2)
OR   BuyPrivateCompany price "-500"                     ingress ALLOWED  treasury 920→1420, owner 295→0
OR   ProposePrivatePurchase owner=self for SV           ingress ALLOWED  offer recorded with the forged owner
OR   …proposer answers his own offer                    ingress ALLOWED  accepted:true; derived BuyPrivateCompany owed and settles
OR   direct BuyTrainFromCorporation, $0, no offer       ingress ALLOWED  PRR's 2-train → B&O, treasuries unchanged
OR   ProposeTrainPurchase seller_president=self         ingress ALLOWED  …and the self-answer is accepted
OR   BuyStock by the operating president                ingress ALLOWED  cash 575→475, IPO 20→10
OR   SellStock by the operating president               ingress ALLOWED  cash 575→675, pool 10
AUC  bid on the lowest offered (M&H)                    ingress ALLOWED  bid recorded
AUC  bid $9999 with $1160                               ingress ALLOWED  bid recorded
AUC  buy lowest ($110) with $10                         ingress ALLOWED  cash 10→0, bank unchanged, private owned
MINI raise +$1 over $130                                ingress ALLOWED  high 131
MINI raise to $9999 with $1050                          ingress ALLOWED  high 9999
MINI BuyStock by the contest's current player           ingress ALLOWED  PRR presidency taken mid-auction
```

---

## 7. Proposed authoritative design

### 7.1 Money primitives (`gameEngine/cashLedger.ts`) — replaces the three floored adjusters

- `debitPlayer / creditPlayer / debitTreasury / creditTreasury / debitBank / creditBank`, and `transfer(state, from,
  to, amount)` with `from`/`to` ∈ `{player: id} | {corporation: id} | bank`. `amount` must be a non-negative
  integer; a debit that the balance cannot cover returns `{ ok: false, reason }` and the arm returns the state it
  was handed (identity refusal) — **never a throw in production**, because the server appends before it applies
  and a throw would leave an entry that crashes every rebuild. Tests get `assertMoneyConserved(before, after)` and
  `moneyTotal(state)`; the existing conservation tests in `emergencyFunding.test.ts` are the shape.
- **Rule: no debit without an affordability refusal in front of it, asked in `applySandboxActionCore` (identity)
  and at ingress (reason).** The ledger's own refusal is the last line, not the rule.
- The bank is a signed integer (may go negative after the break) — **ruled Q1b**. This is the representation that
  makes conservation testable and removes m11's "paper tracking". It requires the latch in §7.1a.
- Bank crediting: auction charges and terrain fees credit the bank — **ruled Q1a**. `applyAuctionStep`'s inline
  floor goes; the cascade's charges use the ledger.
- `transferPrivateToCorporation` requires a player seller (refuses otherwise) and credits that player.

### 7.1a The bank-break latch (owner's required architectural check, answered)

**Is bank exhaustion stored or latched independently of `bank ≤ 0` today? No.** The whole machinery is:
`endgame.bankIsBroken(state)` = `Number(state.virtual_bank_vgp) <= 0`, asked in exactly one place —
`settleRoundTransitions`, inside the `operating_round_just_ended` branch (#898, `sandboxSession.ts` ~3507): when
an Operating Round set has just finished and `bankIsBroken` is true at that instant, the round becomes `GameEnd`.
Nothing writes a flag when the bank first runs out; `App.tsx` 12548 draws the "bank broken" badge from the same
live predicate. So the ending is **re-derived at the set boundary from the balance at that moment**, and a bank
that has recovered by then (today: floored to 0 by a payout, then refilled by the set's train, token and share
purchases, all of which pay the bank) does **not** end the game — the owner's example
`$10 → pays $30 → −$20 → receives $100 → $80` would play on under either flooring or signed accounting. This is
a live defect independent of Stage 7's representation change and is filed as **S7-20**.

**Batch 7.1 amendment (required).** The ledger's bank debit sets a permanent latch:
- new state field `bank_broken?: true` (absent = never broken; `#232`'s rule — absent is "not said"), written by
  `debitBank` the first time a debit leaves the balance `≤ 0` (the threshold the existing predicate uses:
  "runs out of money", §7.0), and **never cleared by any mutation**. Only a `RevertTo` past the breaking payout
  removes it, because the rebuilt state never reaches it — the latch is a function of the log like everything else.
- `bankIsBroken(state)` becomes `state.bank_broken === true || Number(state.virtual_bank_vgp) <= 0`. On a
  version-5 board the second half is redundant (a non-positive balance can only arise through a debit that set
  the latch); it stays for fixtures and legacy states that carry no field.
- `settleRoundTransitions` keeps its single ask, unchanged in shape; the UI badge reads the same function; the
  #898 timing (finish the set; a break during a Stock Round finishes the next set) is unchanged.
- Version 5 changelog row: "the bank break is latched (`bank_broken`) the moment a payout empties the bank, and
  credits no longer un-break it". Corpus: a sweep must report every log in which the old engine's bank touched 0
  and recovered before a set boundary — under version 5 such a game ends at that boundary. (Under Q1a the bank is
  also richer by the auction and the terrain fees, so breaks move later; both effects are reported per log.)

**Required regression (7.1 acceptance tests).** (a) bank $10 → a $30 dividend → `virtual_bank_vgp` `-20`,
`bank_broken: true` → a $100 train purchase → `virtual_bank_vgp` `80`, `bank_broken` still `true` →
`operating_round_just_ended` → `GameEnd`. (b) The same board with the debit refunded by `RevertTo` past the
dividend rebuilds without the field and plays on. (c) A legacy/fixture state with no field and a positive bank is
not broken; with a non-positive bank it is. (d) The badge and the reducer agree (both read `bankIsBroken`).
(e) Conservation holds across the whole sequence (the signed bank is what makes (a)'s arithmetic checkable).

### 7.2 Stock transaction authority (`gameEngine/stockTransactionAuthority.ts`)

One predicate per message, asked in the core (identity), at ingress (reason), and — for sales — inside the market
step's `saleRefused` closure so a refused sale moves no token (the #748a two-atom rule).

`stockPurchaseRefusal(state, buy, actor, ctx)` in this order:
1. `current_round_type === "StockRound"` (no auction, no OR); existing holds (discard, funding, home token) first.
2. corporation exists; B&O lock (existing); `certificate === "double"` placement (existing).
3. **President's purchase** (the *corporation's* state decides which kind of purchase this is; the *message*
   supplies the par, and only here). The purchase is the president's certificate purchase when `source === "Ipo"`
   and the corporation's stored state has **no president and no established par** (`company.president === null &&
   company.par_value == null`). For that purchase, in order: the message's `buy.par_value` must be present; it must
   be an integer; it must correspond to a legal par cell in the market chart currently in use (`parCellFor(par)
   !== null` — the chart's own ladder, dynamic row included, one source for the ladder, the mark and the price);
   the 20 % president's certificate must actually be in the IPO (`ipo_pool_percentage ≥ 20`); `quantity` must be 1
   and `certificate` must not be `double`; the buyer must be able to pay exactly `2 × par` (`cash ≥ 2 × par`).
   Settlement charges `2 × par` to the bank and records that par and that president together. **There is no
   fallback**: an IPO purchase of an unparred corporation without a valid `par_value` is refused, never converted
   to a president's purchase at $67 (m8) — ruled Q4.
4. **Ordinary IPO purchase** (the corporation's stored state has a president and a par): the price is the
   corporation's stored `par_value`, full stop; a message-carried `par_value` is narration and is ignored whether
   present, absent or wrong — ruled Q4. **Pool purchase**: price = `market_positions[id].price`; refused when the
   corporation has no market position.
5. Availability: the source holds ≥ certificates × 10 % (or the double); `ordinaryPurchaseRefusal`. A purchase
   from a source that cannot deliver every certificate asked is refused outright — never capped, never charged
   less, never charged for nothing (ruled Q13).
6. `sharePurchaseBlock` unchanged (cap, limit, divestment, lockout, one-per-turn, Brown).
7. Brown continuation: a second `BuyStock` in the same turn is legal only as the Brown Bank-Pool continuation and
   must name the corporation recorded in `bought_this_turn_company` (new optional field, written on the first
   purchase of the turn, cleared wherever `bought_this_turn` is cleared); it remains one purchase for turn
   purposes (ruled Q9).
8. `cash(actor) ≥ charged`.

`stockSaleRefusal(state, sell, actor, mapGrid)`:
1. round: `StockRound`, **or** `OperatingRound` while `emergencyFundingFor` names `actor` (the §6.6.3 forced sale —
   `forcedSaleRefusal` then applies on top, unchanged).
2. `percentage` a positive integer multiple of 10 (the double's 20 semantics unchanged).
3. first Stock Round: refuse when `macro_round_number === 1` — Delayed Auction's SR1 is still the first Stock Round;
   SR3 (after the delayed auction) is not.
4. `par_value !== null` (S11/S8-8).
5. `shareSaleBlock`, `doubleSaleEffect` (existing); proceeds only from `market_positions` (no nominal fallback on a
   pinned board).

Seat authority stays at ingress (`turnRefusal`). Evidence for not moving it into the reducer: JUNO-3XD's Stock
Round 1 was seated under the pre-#1235 constant, so every SR1 buy in that legacy log has `actor ≠ seat` on the
log-derived board; a reducer seat check would refuse the whole round of a development-corpus log for no rules
reason (D-9). The round gates above are functions of the log and are safe.

`SetBoPar.par_value`: ladder in effect (same predicate as 3).

### 7.3 Par authority (folded into 7.2)

Legal par spaces = the chart's par cells (`parCellFor`), one source for the ladder, the mark and the price. Cash
required = 2 × par. Exact charge = 2 × par to the bank. Capitalisation stays on the crossing purchase (m4,
unchanged), now 10 × a validated par. A crafted message cannot par off-ladder, cannot par for less than 2 × par,
cannot par without cash, cannot par by omitting the field.

### 7.4 Ordinary private purchase authority (`gameEngine/privatePurchaseAuthority.ts`)

`privatePurchaseRefusal(state, { buyerId, privateId, price }, actor, mapGrid)` — the shape of
`fundingPrivateSaleRefusal`, reused at all three moments (direct message, proposal, derived settlement):
1. existing holds first (discard, funding, home token, pending offer of §7.6);
2. `OperatingRound`; `buyerId === operatingCorporationId(state)`; any step of its turn (P1);
3. phase ∈ {3, 4} (`privatePurchasePhaseOpen(derivePhase(state).tier)`);
4. the private exists, is open, `isSellableToCorporation`, and its `owner` is a **player** (`owner_protocol_id`
   null);
5. `price` integer within `privatePriceBounds(face)` — the band is §3.1's rule for a *corporation* buying from a
   player; it does not govern the player ↔ player sale of §7.6a;
6. buyer floated with a president; `treasury ≥ price`;
7. **consent**: legal as a direct `BuyPrivateCompany` only when `actor === owner && actor === buyer.president` (one
   party — the shell's existing same-president dispatch); otherwise only as the derived settlement of a
   `private_purchase_offer` with `accepted: true`, matching `private_id`, `buyer_protocol_id`, `price`, and whose
   `owner` equals the private's **current** owner.
A refused settlement retires the offer (the #1247 pattern) and transfers nothing. D-5's `funding: true` offers are
excluded from this predicate and keep theirs.

### 7.5 Intercorporate train sale (`gameEngine/trainSaleAuthority.ts`)

`trainSaleRefusal(state, { buyerId, sellerId, model, price }, actor, mapGrid)`, reused at proposal, answer-time
revalidation and settlement:
1. holds first; then D-6's `fundedTradeRefusal` exactly where it is today;
2. `OperatingRound`; `buyerId === operatingCorporationId(state)`; `operating_sub_phase === "Hardware"` — **for the
   proposal too**, because the settlement is derived the instant the seller accepts, and a proposal made at Track
   would otherwise settle before Run Trains and let the train run this turn (T8). Corpus proposals at Hardware:
   FCJ 145, CW7 121, QVC 59; the one at Tokens (FCJ 232) was declined;
3. `buyerId !== sellerId`; the seller owns `model` (a slot); the seller is floated;
4. `price` integer ≥ 1; the voluntary purchase is paid by the treasury alone (`treasury ≥ price`; §11 Q7) — the
   president's money enters only through D-6;
5. limit in force (existing gate, unchanged; last train allowed, T4);
6. **consent**: legal as a direct message only when `actor` presides over **both** corporations; otherwise only as
   the derived settlement of a `train_purchase_offer` with `accepted: true` matching seller, buyer, model **and
   price**.

### 7.6 Pending-offer policy (all ordinary offers — three kinds; funding offers keep D-5's)

- **One offer at a time**, of any of the three kinds (`private_purchase_offer`, `train_purchase_offer`, the new
  `private_trade_offer` of §7.6a), never beside a funding offer; a proposal while one stands is refused (ruled Q6).
- **The hold** (`pendingOfferBlock`, the #1541 shape, asked in the core and at ingress): while an ordinary offer
  stands — whether awaiting an answer or `accepted` and awaiting its derived settlement — only the answer (by the
  counterparty), the rescission (by the proposer), the derived settlement, `RevertTo` and `CloseRoom` pass.
  Turn and round advancement, other purchases, sales, a second offer: refused. This is the playtest backlog's
  "blocks progression until answered or cancelled".
- **Who answers**: the private's *current* owner / the seller's *current* president, re-derived from the state at
  answer time; the payload's `owner` / `seller_president` become narration and are ignored (the proposal
  predicate already required the private to be player-owned and the seller to have a president).
- **Who rescinds**: the buyer's current president, via two new messages `RescindPrivatePurchase { private_id }`
  and `RescindTrainPurchase { seller_protocol_id }` (schema 44 → 46; the chain-era `RescindTrainOffer { offer_id }`
  stays a no-op and is refused on pinned boards, §11 Q11).
- **Stale-state revalidation**: the derived settlement runs the full predicate on the current board; a failure
  retires the offer and moves nothing. With the hold, the board cannot change between offer and settlement in
  play; the revalidation is the authority, the hold is the convenience (D-5's wording).
- **Lifetime**: the hold makes "an offer outlives the turn" unreachable; a test asserts it (an offer + `PassTurn`
  → refused). No turn-end clearing code is added (it would be dead).
- **`RevertTo`**: log-level, unchanged; a revert before a proposal removes it, a revert to a point between
  proposal and answer restores the pending offer and its hold by construction (state is a function of the log).
  Who may revert an accepted-and-settled trade is Stage 10's consent question (2.5d), not changed here.
- **Ingress**: every refusal above is answered `refused` with its sentence (the Batch-6 shape); the reducer is the
  second lock.

### 7.6a Player ↔ player private-company sale — the third offer kind (ruled Q12; rulebook §3.1, S13)

A §3.1 private-company rule, not a §5 certificate rule: "sold between players for any mutually agreed price at any
time during the buyer's or the seller's turn of a stock round (other than the first)". The ½–2× face band belongs to
§3.1's *corporation* sentence and does not apply here.

**Messages** (schema +3; with §7.6's two rescissions the union grows 44 → 49):
`ProposePrivateTrade { game_id?, private_id: int, seller: string, buyer: string, price: int }` —
`AnswerPrivateTrade { game_id?, private_id: int, accept: bool }` —
`RescindPrivateTrade { game_id?, private_id: int }`.
**State**: `private_trade_offer?: { private_id, private_name, seller, buyer, price, proposer } | null` — a third field
beside the two existing offers (not a discriminator on `private_purchase_offer`, whose shape is a corporation
buyer); the one-offer hold of §7.6 spans all three.

**Legality predicate** `privateTradeRefusal(state, { private_id, seller, buyer, price }, actor)`, re-derived at
proposal, at answer and at settlement, in this order:
1. the existing holds first (discard, funding, home token, the one-offer hold);
2. `current_round_type === "StockRound"` and `macro_round_number !== 1` (the same first-Stock-Round predicate as
   §7.2's sale ban; the Delayed-Auction SR1 counts as the first);
3. the current seat (`player_addresses[active_player_index]`) is the buyer or the seller — the rule's "during the
   buyer's or the seller's turn" is a fact about the round, read from state, not a seat-authority duplicate
   (Q10): the *actor's* right to send is still ingress's — at ingress the proposer must be the seat holder **and**
   one of the two parties; the answerer is the other party, off-turn, through the consent-answer exemption;
4. `buyer !== seller`, both seated players;
5. the private exists, is open (not `closed`), and its `owner === seller` (`owner_protocol_id` null) — the
   private catalog's B&O / C&A / M&H entries are ordinary privates for this rule (see §12a for the one question);
6. `price` is an integer ≥ 0 ("any mutually agreed price"; $0 is a gift and is legal);
7. `cash(buyer) ≥ price`;
8. **overall certificate limit** (owner ruling, 2026-09-15): the buyer must remain within the applicable overall
   certificate limit after acquiring the private — the rulebook counts each private company as one certificate
   (§4.3), and `certificateBreakdown` already counts every open private the player owns as one *counted*
   certificate (never zone-exempt). The gate is `certificateBreakdown(buyer, state, marketPrices,
   zoneForPrice).counted + 1 > limit → refuse` (a `null` limit — no roster — refuses nothing, #232). Checked at
   proposal, at answer/acceptance and at final settlement/revalidation; if holdings have gone stale so that the
   buyer would exceed the limit, the transaction is refused/retired without moving money or ownership. The
   seller's count falls by one on settlement in the ordinary way (the private leaves his `owner`).
**Consent**: the proposer may be either party (`proposer` recorded); only the *other* party may answer; only the
proposer may rescind. **Settlement** happens in the answer arm on `accept: true` (the D-5 shape — there is no
existing single-party settlement message to derive, and inventing one would add a derived key for no reason):
the predicate is re-run on the current board; a failure refuses the answer (identity) and leaves the offer
standing for a rescind or a later legal answer; success moves `price` buyer → seller through the ledger
(conserved), rewrites `owner`, and clears the offer.
**What travels with the card — owner ruling N1 (accepted, D-26).** Ownership of the private company transfers,
including every still-unexercised ownership-dependent power: the M&H's exchange ability follows the M&H (it
belongs to the current owner until exercised); the CS, D&H, JK and comparable still-live abilities follow the
private (`used_private_abilities` is per private and stays as it is — a used ability stays used). Already-vested
one-time benefits neither transfer nor trigger again: the C&A's already-issued PRR share stays with whoever holds
that share, and a later sale of the C&A issues nothing; the B&O's already-issued president's certificate and par
stay with the auction winner, and a later sale of the BO private retriggers nothing (`SetBoPar` is not re-owed).
The BO private itself **may** be sold player → player — the printed prohibition is against selling it to a
corporation (`isSellableToCorporation` is not consulted here). `settleBaoPrivate` (closes when the B&O buys its
first train) is unaffected by who holds the card.
**Pacing — owner ruling N2 (overridden, D-27).** The trade **counts as Stock Round transaction activity by the
current-turn player** (the buyer or the seller whose turn it is — not the answerer as such), without consuming
the one corporation-stock purchase. Exact bookkeeping on settlement: `turn_action_taken: true` for the seat's
turn (so the End Turn that follows is `advanceSeat`, never `recordPass` — the existing #745 marker, nothing new);
`consecutive_passes: 0` (the sale arm's existing reset); `last_trader_index` = the current-turn player
(`markTrader(state, seat)` — the priority deal treats that player as the latest trader under the digital reading
of §5.0); `bought_this_turn` and `bought_this_turn_company` **untouched** (a private changing hands is not the
turn's certificate purchase); the seat cursor untouched (the counterparty's acceptance is an off-turn consent
answer, not a Stock Round turn); `stock_turn_stage` untouched. Settlement happens inside the answer arm, so all
five writes are made by that arm on `accept: true` and nothing is written on a refusal, a rejection or a rescind.
**`RevertTo`**: log-level, unchanged — the offer, its hold and its settlement are state and rebuild exactly as
the other two kinds. **Ingress**: every refusal answered with its sentence. **Replay**: version 5 (new messages,
new field); absent from every stored log, so no adapter.
**Focused 7.4 tests required (owner):** buyer exactly at the certificate limit before acquiring a private →
proposal refused (and an answer/settlement refused when the limit is reached later); buyer one below the limit →
legal; an offer legal when proposed whose buyer reaches the limit before settlement (a stock purchase is
impossible under the hold, so the fixture mutates holdings directly, as Batch 5's eleven-way test did) →
settlement refuses and retires without moving money or ownership; selling a private reduces the seller's counted
certificates by one; plus the N1 matrix (M&H exchange by the new owner; used D&H ability stays used; C&A sale
issues no share; BO private sale moves no certificate and re-owes no par; BO private saleable player → player) and
the N2 matrix (End Turn after a trade is not a pass; `last_trader_index` = the seat; `bought_this_turn` unchanged;
the seat unmoved by the acceptance; a rejected offer writes none of the markers).

### 7.7 Auction repair (keep the representation; repair the arms)

The waterfall atom (`privates[].bids`, `is_lowest_offered`, `mini_auction`, derived escrow) is a sound state
machine; it needs five repairs, not a replacement:
1. `WaterfallBidHigher`: refuse when the target `is_lowest_offered` (A1); `amount − ownStanding ≤ availableCash`
   (A3; `availableCash` = cash − standing bids on unsold privates, from the state); own re-bid stays legal (A12).
2. `WaterfallBuyLowest` / the $0 taker / every win: `availableCash ≥ price` for a buy; charges through the ledger
   to the bank.
3. `WaterfallPass` all-pass: if the lowest offered is the SV (`private_id === SV_PRIVATE_ID`) → −$5, no revenue;
   at $0 → the next seat takes it, cascade, PD to that seat's left (unchanged); if the SV is not on offer (sold) →
   `applyPrivateRevenue`, no markdown, sequence resumes. LPF's extra private changes nothing (§11 Q8).
4. Mini-auction: `bidders` fixed at opening (unchanged); new `passes_since_raise` on `mini_auction` (absent = 0);
   `MiniAuctionPass` keeps the bidder and his bid, increments the counter, resolves when it reaches
   `bidders.length − 1`, else moves to the next bidder after the actor skipping the high bidder;
   `MiniAuctionRaise` requires `amount ≥ high_bid + 5` and escrow-aware cash, resets the counter, replaces the
   raiser's bid. Winner pays `high_bid` (nothing was deducted before); losers' escrow releases when the private
   leaves the list (unchanged).
5. Refuse `WaterfallBuyLowest` / `BidHigher` / `Pass` while `mini_auction` is live (A14); refuse `BidOnPrivate` on
   pinned boards.
Corpus contests are all two-bidder (CV4 8, 8E8 10/15, JJD 5): under both rules one pass resolves them, and the
`mini_auction` is null afterwards, so their digests are unchanged.

### 7.8 Hostile-client invariants — where each is closed

| Invariant (brief §10) | Closed by |
|---|---|
| buying stock without cash | 7.2 rule 8 |
| buying/parring at a forged price | 7.2 rules 3–4, 7.3 |
| paying an auction bid the player cannot afford | 7.7 (1)(2)(4) |
| spending the same auction cash twice | 7.7 escrow-aware refusals + 7.2 round gate (no stock action during the auction) |
| corporate private purchase without treasury | 7.4 rule 6 |
| intercorporate train purchase without funds | 7.5 rule 4 |
| accepting a now-stale transaction | 7.6 revalidation |
| negative / malformed prices | integer ≥ bound checks in 7.2 / 7.4 / 7.5 / 7.7 |
| progressing around a blocking offer | 7.6 hold |
| wrong actor | ingress (existing) + consent predicates 7.4 (7) / 7.5 (6) + re-derived answerers 7.6 |
| additional: seller paid into the void; corp → corp private; train grabbed for $0; forged counterparty; offer overwrite; main-rotation action during a contest; empty-source purchase; fractional sale; off-round stock actions; money destroyed | 7.1 / 7.4 / 7.5 / 7.6 / 7.7 / 7.2 as marked |

---

## 8. Replay / version-5 implications

Version 5 is required. Changes that alter what a stored log replays to (each a "bump" row):
- refusal-added: unaffordable stock purchases; forged/absent par; off-round `BuyStock`/`SellStock`; first-SR
  sales; unparred sales; empty-source buys; fractional bundles; private purchases outside phase 3–4 / band /
  operating corporation / player seller / consent; train sales outside Hardware / < $1 / unfunded / unconsented;
  proposals outside the buyer's turn or step, or beside a standing offer; bids on the lowest; escrow-blind bids;
  sub-$5 raises; main-rotation messages during a contest; `BidOnPrivate` and the `AcceptTrainOffer` family on
  pinned boards;
- replay-semantic: C5 (markdown target, revenue condition); mini-auction pass semantics (new `passes_since_raise`
  field); auction proceeds and terrain fees credited to the bank (Q1a); bank allowed negative (Q1b); **the
  bank-break latch `bank_broken` (§7.1a — a game whose bank touched 0 and recovered before a set boundary now
  ends at that boundary)**; `bought_this_turn_company`; the new `private_trade_offer` field and its three messages
  (§7.6a) plus the two rescissions (schema 44 → 49); the four chain-era/legacy messages refused on pinned boards
  (Q11).
Every other transaction keeps its meaning; the pin travels on the state as before; a version-4 room is refused
before replay (`SUPPORTED = [5]`), never reinterpreted (D-9).

Payload sufficiency: every stored IPO `BuyStock` carries the company's par (`par_value` present on 100 % of the 188
IPO buys across the eight server logs; none mismatches the company's par on the log-derived board); every stored
private/train settlement carries its price; no legacy entry needs a new field. The one representational risk is the
new offer messages (rescission): absent from every log, so no adapter is needed.

`RevertTo` reconstructs offers, holds and auction state by rebuild; the restore path (`apply`, never `submit`) does
not mint settlements, and the purchase arms clear the offers they settle, so a rebuilt board owes nothing twice.

---

## 9. Predicted corpus-sensitive changes (17 logs; to be re-swept by the implementation batch and filed in Part E)

| Log | First Stage-7 difference | Why |
|---|---|---|
| **JUNO-3XD** (sandbox export; `replayJuno3XD.test.ts`, `trainDiscard.test.ts`) | **idx 28** (was 175 after Batch 6) | Stock Round 1: a $100 IPO purchase with $60 in hand — the old engine minted $40; refused now, so the float/queue of every later round differs. Filed table re-pinned again with the reason. |
| **JUNO-Z6C** | **idx 9** (was 140) | all-pass with the SV sold marked the B&O 220 → 215 (and 210 at 12); the fix leaves it at 220, the buyer at 14 pays $10 more; cascade. Later: 261/264/347–354/473–483 unaffordable purchases refused; 388 a `SellStock` at an OR's Routes step refused. `gameHistory.test.ts` (shape assertions) to re-check. |
| **JUNO-G6J** (golden) | **idx 7** | all-pass with the SV sold marked the JK 120 → 115 (LPF roster); stays 120; the golden fixture is re-baselined (price, buyer cash, bank). |
| **JUNO-FCJ** | already diverged at 74 (S6-10); additional refusals from 83 (`BuyStock` in an OR), 106/109 minting, 163/177/279/314/468/614/768/784/975 direct trades whose buyer is not operating or whose actor presides over one side only on the log-derived board; 205/232/273 proposals refused (all were declined, so the post-answer board is unchanged) | reported, not absorbed; no test replays FCJ past 96 |
| **JUNO-CV4** (golden + `replayJunoCV4.test.ts`) | no gameplay change; **bank field differs** if §11 Q1a is adopted (auction proceeds + terrain fees) | golden re-baselined for the bank alone; 8's contest unchanged |
| JUNO-8E8, CW7, JJD, QVC, 7NZ, TQQ, Y8V | no gameplay change; bank field differs under Q1a (7NZ/TQQ: single-entry, identical) | — |
| every log (latch, §7.1a) | to be reported by the 7.5 sweep: any log in which the old engine's bank touched 0 and then recovered before a set boundary ends at that boundary under version 5 — Z6C's bank reached 0 at 613 under version 3 (no longer under 4, and later still under Q1a's richer bank); the sweep states, per log, the first index at which `bank_broken` is written and whether the set boundary that follows now ends the game | replay-semantic |

Every stored `BuyStock` in the corpus was gameplay-legal on price (no forged par), so the price/par authority costs
nothing historically; the cost is C3 and C5, which were real minting and real mispricing in real playtests.

---

## 10. Owner rulings (received 2026-09-15; all thirteen answered — recorded in the ledger's Part D as D-15 … D-25)

| # | Question | Ruling |
|---|---|---|
| Q1a | Credit the bank with auction proceeds and terrain fees? | **YES.** Money paid to the bank must increase authoritative bank funds. |
| Q1b | Signed bank accounting after the break instead of flooring? | **YES**, with a required check: bank exhaustion must be permanently latched — a later receipt cannot un-break the bank. Answered in §7.1a (not latched today; latch added to 7.1; regression required). |
| Q2 | Absorb S8-7, S8-8's sale half, S8-9 into Stage 7? | **YES.** Resolved by Batch 7.2 with cross-references; the unrelated Stage-8 presidency/timing work stays in Stage 8. |
| Q3 | Raising one's own standing bid in the buy-bid sequence? | **YES.** And the report's "rulebook silent" is corrected: §1.2.3's note that a player gains little by bidding twice on the same company supports repeated bids (A12). |
| Q4 | Ordinary IPO purchase: ignore a message `par_value`? | **YES.** Corporation state prices it; the payload is narration. The president's purchase requires the par and validates it against the legal par spaces (§7.2 rule 3, rewritten). |
| Q5 | Private proposals at any OR step of the buyer's turn; train proposals at Hardware only? | **YES.** |
| Q6 | A pending ordinary offer freezes progression until answered, rescinded or settled; `RevertTo` / `CloseRoom` still pass? | **YES.** |
| Q7 | Voluntary intercorporate purchase paid entirely from the buyer's treasury? | **YES.** Presidential cash only through the forced rules / D-6. |
| Q8 | LPF all-pass markdown applies only to the SV? | **YES.** JK or any other lowest unsold private does not inherit it. |
| Q9 | Keep multi-message Brown pool purchases, with `bought_this_turn_company`? | **YES.** Every continuation names the same corporation; one purchase for turn purposes. |
| Q10 | Seat/turn authority stays at ingress only? | **YES.** Reducer rules add round/action legality, never historical seat authority. |
| Q11 | Refuse `BidOnPrivate`, `AcceptTrainOffer`, `RejectTrainOffer`, `RescindTrainOffer` on pinned boards now? | **YES.** Type/schema cleanup stays S10-8. |
| Q12 | Player ↔ player private-company sales? | **IMPLEMENT** as the third bilateral offer kind on the pending-offer machinery, without the ½–2× band; semantics in §7.6a; Fable High with the rest of 7.4; S7-9 is no longer an open decision. |
| Q13 | Empty-source stock purchase? | **Refuse outright.** No silent cap, no reduced charge, no charge for nothing. |

Recorded, not for ruling: the Stage-8 presidency tie/challenger order (S8-2) is untouched and is not needed by any
Stage-7 gate (`settlePresidencies` runs after the purchase exactly as before); MH exchange (S8-10) untouched.

## 12a. Ambiguities created by the rulings — both ruled (owner, 2026-09-15; revision 3)

| # | Ambiguity | Ruling | Recorded |
|---|---|---|---|
| N1 | What travels with a private sold player → player? | **ACCEPTED** as proposed: the card and every still-unexercised ownership-dependent power transfer (M&H exchange, CS/D&H/JK and comparable); already-vested one-time benefits (the C&A's issued PRR share, the B&O's issued certificate/par) neither transfer nor retrigger; the BO private is saleable player → player — the printed ban is on selling it to a corporation. Full text in §7.6a. | D-26; tests in 7.4 |
| N2 | Does the trade count as the Stock Round turn's action? | **OVERRIDDEN**: it **does** count as transaction activity by the current-turn player — not a pass, pass streak reset, that player is the latest trader for the priority deal — but does not consume the one stock purchase (`bought_this_turn` untouched) and the counterparty's acceptance moves no cursor. Exact bookkeeping in §7.6a. | D-27; tests in 7.4 |

Added by the same rulings: the overall certificate limit applies to the private-company trade (rulebook §4.3: a
private is one certificate) — §7.6a rule 8, checked at proposal, answer and settlement. Resolved without a ruling
(stated so it is not re-asked): the latch threshold is `≤ 0`, the threshold `bankIsBroken` has always used ("runs
out of money"); the private trade price floor is `$0` ("any mutually agreed price"); the Delayed-Auction SR1 is
the first Stock Round for both §7.2's sale ban and §7.6a. **No genuinely new ambiguity remains.**

---

## 11. Implementation sequence and ownership

| Batch | Content | Owner | Why |
|---|---|---|---|
| **7.1 Money ledger** | `cashLedger.ts`; retire the three adjusters; bank crediting (Q1a); signed bank (Q1b); **the `bank_broken` latch and `bankIsBroken` reading it (§7.1a, regression (a)–(e))**; `transferPrivateToCorporation` player-seller rule; conservation harness over the corpus (`moneyTotal` invariant after every entry, whitelisting `SetupGame` and `YellowSignEvent`); every existing debit site switched behind its existing gate. Version pin and corpus reporting stay in 7.5, but 7.1's sweep must already list the first-latch index per log. | **SAFE FOR OPUS — frozen** | Q1a/Q1b answered; the latch question answered by inspection (§7.1a); the invariant tests and the latch regression are the acceptance criteria |
| **7.2 Stock + par authority** | `stockTransactionAuthority.ts` per §7.2–7.3; wired in the core, at ingress, and in the market step's `saleRefused`; `SetBoPar` ladder; S8-7/S8-8/S8-9 absorbed (Q2); `bought_this_turn_company`; tests per rule ± $1 and per round; digest-based refusal assertions. | **SAFE FOR OPUS** — with one FABLE review point: the order market-step → core for `SellStock` (a refused sale must move no token; the same predicate must be the one the closure asks) | rules are a checklist; the two-atom wiring is the only subtlety |
| **7.3 Auction repair** | §7.7 (1)–(5); `passes_since_raise`; escrow-aware refusals from the state; C5; ingress reasons; tests: the brief's A raise / B pass / C raise / B raise; A raise / B pass / C pass → A wins; all-pass SV unsold vs sold; $0 taker; bid on lowest; escrow; contest-time rotation messages. | **SAFE FOR OPUS** | the state machine is specified to the field |
| **7.4 Pending offers, consent, settlement** | `privatePurchaseAuthority.ts`, `trainSaleAuthority.ts`, **`privateTradeAuthority.ts` and the third offer kind (§7.6a: `ProposePrivateTrade` / `AnswerPrivateTrade` / `RescindPrivateTrade`, `private_trade_offer`, settlement in the answer arm, N1/N2 defaults)**, `pendingOfferBlock` spanning all three fields, the two ordinary rescission messages, re-derived answerers, derived-settlement revalidation and offer retirement, direct-message consent, interaction with the discard hold / funding hold / home-token hold / `RevertTo` / `settleOwed` loop (a refused settlement must not spin), D-5/D-6 preserved. | **KEEP ON FABLE HIGH** for the state machine and the core/ingress/derived wiring (now including the player ↔ player kind); **then OPUS** for the test matrix (each rule ± one fact; eleven-way board mutation between offer and settlement, as Batch 5 did; the three kinds × propose/answer/rescind/revert) | three holds, two derived loops, one answer-arm settlement and a log-level revert interact; getting the order of gates wrong is exactly how #1019/#1513 were found |
| **7.5 Version 5, corpus, ledger** | `RULES_ENGINE_VERSION` 5 + changelog; `SUPPORTED=[5]`; corpus sweep with per-index first-difference reporting (the §9 table is the expectation); golden re-baselines (CV4, G6J) with the reason in the test header; `replayJuno3XD` / `trainDiscard` / `gameHistory` re-pins with reasons; ledger Part A/B/D/E rows; batch write-up. | **OPUS for the sweep and re-pins; FABLE for the ledger text and the divergence review** | re-pins must be explained, never silent |

Recommended order 7.1 → 7.2 → 7.3 → 7.4 → 7.5; 7.2 and 7.3 are independent of each other and could run in
parallel worktrees; 7.4 depends on 7.1 (ledger) and on 7.2's first-Stock-Round predicate (shared with §7.6a).
Each batch runs its focused suites; the owner runs the full suite once at 7.5. The split is unchanged by the
rulings except that 7.1 now carries the latch and 7.4 now carries the third offer kind.

---

## 12. Scope confirmation

Not absorbed: S8-1 (pre-rise OR order), S8-2 (presidency tie — `settlePresidencies` is untouched), S8-5/S8-6
(home token), S8-10 (MH exchange), Stock Round UX (U-3, U-6), LPF certificate/licence corrections (S9-8), 1830+
board data, Yellow Sign (S9-1 — its cash award is the one remaining non-conserving mutation and is listed as such),
settlement/Juno, Rules Reference, Game Over/audio/layout. The uncommitted working-tree changes in
`RulesReference.tsx`, `audio.ts` and the three `rules*.test.tsx` files are the owner's and were not read or touched.

---

## 12b. UI parity tracking (owner requirement, 2026-09-15; durable copies in the ledger's Part C as U-19 … U-27)

Every Batch 7 rule/change is classified by its frontend consequence: `NONE` (the normal UI already exposes and
reflects it), `LEGALITY SYNC` (existing action UI must use the authoritative predicate for availability / choices /
price / warnings), `NEW ACTION` (a legal engine action has no normal UI), `STATE VISIBILITY` (an authoritative
state, hold or refusal needs visible representation), `RULES REFERENCE` (player-facing rules text needs adding or
correcting). The UI is **not** implemented in Batch 7 unless inseparable from correct message wiring; the point of
this table is that nothing is lost. Verified against `StockRoundPanel.tsx`, `ContextualActionBar.tsx`,
`PrivateTradePanel.tsx`, `TrainPurchasePanel.tsx`, `TrainTradePanel.tsx`, `WaterfallAuctionDashboard.tsx` and the
`App.tsx` gate callbacks (`purchaseBlockFor`, `saleBlockFor`, the offer dispatch sites) on 2026-09-15.

| Batch 7 rule / change | Ledger | UI today (verified) | Classification | Part C |
|---|---|---|---|---|
| Player ↔ player private-company sale (§7.6a) | S7-9 / D-24 | nothing: no initiation, no counterparty prompt, no price entry, no answer, no rescission, no pending state | **NEW ACTION** + **STATE VISIBILITY** + **RULES REFERENCE** | U-19 |
| Ordinary player → corporation private purchase: phase 3–4, any OR step, band, player seller, open private, treasury, consent (§7.4) | S7-6 / S7-7 / S7-12 / D-18 | `ProposePrivatePurchase` panel opens in an Operating Round for the acting president in phases 3–4 (`privatesBuyableNow`), at any step (not step-gated), with a typed price inside the ½–2× band and the owner's accept/reject prompt off-turn; same-president case settles at once. Not read from an authoritative predicate: treasury ≥ price, `closed`, player-owned seller (a corporation-owned private is offered), buyer = operating corporation | **LEGALITY SYNC** (read `privatePurchaseRefusal`) + **NEW ACTION** (`RescindPrivatePurchase` — no withdraw control; U-6 already asks for one) + **STATE VISIBILITY** (proposer's "awaiting" line and the hold) | U-20 |
| Intercorporate train sale: Hardware only, ≥ $1, treasury, consent, rescission (§7.5) | S7-5 / S7-8 / S7-12 / D-18 / D-20 / D-23 | proposal panel renders on `orStep === "Hardware"` only (NONE for timing); price/treasury/≥ $1 not read from a predicate; the answer prompt exists; the on-chain `TrainTradePanel` "Rescind" dispatches `RescindTrainOffer { offer_id }`, a sandbox no-op that Q11 now refuses | **LEGALITY SYNC** + **NEW ACTION** (`RescindTrainPurchase` wired where the dead Rescind is) + **STATE VISIBILITY** | U-21 |
| Pending-offer global hold (§7.6) | S7-8 / S7-14 / D-19 | nothing blocks End Turn / Pass / Skip / other purchases while an ordinary offer waits; the funding-offer freeze (Batch 5) has a "waiting on X" surface in `EmergencyTrainPurchaseModal` / `FundingPrivateOfferPrompt` — the shape to reuse | **STATE VISIBILITY** (progression controls disabled with the hold sentence, on every seat) | U-22 |
| First-Stock-Round sale ban (§7.2 sale rule 3) | S8-7 | Sell disabled in SR1 by the panel's own `macroRoundNumber === 1` (#356) — a local restatement, not the authority — with the tooltip "No selling in the first Stock Round — Project 18XX opens the market to sales from SR2 onward", which presents a rulebook rule (§5.1) as a house variant; Delayed-Auction SR1 unverified; the player↔player trade's SR1 exclusion (§7.6a) has no UI yet (U-19) | **LEGALITY SYNC** (the control reads `stockSaleRefusal`, one predicate for SR1, unparred and bundle rules) + **RULES REFERENCE** (copy correction; Rules Reference SR text) | U-23 |
| Unparred-share sale ban (§7.2 sale rule 4) | S8-8 | the Sell control is live for the holder of a C&A/M&H-granted share before par (no price to quote, but the button dispatches) | **LEGALITY SYNC** (read `stockSaleRefusal`; disabled with the reason) | U-24 |
| Par ladder, president's purchase cost, affordability, empty source, fractional bundles (§7.2 / §7.3, Q4 / Q13) | S8-9 / S7-1 / S7-13 / S7-16 / D-17 / D-25 | ladder = `PAR_BOX_PRICES` (local copy of the engine ladder; dynamic-market row to verify), `cannotAfford` = the panel's own arithmetic (#357), availability by `multiBuyMax` / source toggle, bundle sizes from `SELL_PERCENTAGE_OPTIONS` — all local restatements of rules the reducer will now own | **LEGALITY SYNC** (`purchaseBlockFor` / `saleBlockFor` become thin wrappers over `stockPurchaseRefusal` / `stockSaleRefusal`; the ladder control reads `parCellFor`) | U-25 |
| Empty IPO / Bank-Pool source (Q13 / D-25) | S7-1 (m9) | the source toggle and `multiBuyMax` are computed from the panel's own reading of `ipo_pool_percentage` / `bank_pool_percentage`; whether a 0 % source still offers Buy is decided locally, not by the predicate | **LEGALITY SYNC** (the Buy control reads `stockPurchaseRefusal`, which refuses an undeliverable purchase outright) | U-25 |
| Brown-zone continuation naming the same corporation (Q9 / D-22) | S7-18 | the shell sends one `BuyStock` with `quantity`, and under Sell-Buy-Sell the buy stage ends after a purchase, so no continuation message is dispatched today; the panel's `multiBuyMax` / quantity control does not know `bought_this_turn_company`, so any future continuation control (or a legacy-revision game where the stage does not end) would offer the wrong corporation | **LEGALITY SYNC** (the quantity/continuation control reads the predicate, which names the recorded corporation) | U-25 |
| Auction: escrow-aware affordability, minimum raise, no bid on the lowest, mini-auction pass with re-entry, SV-only markdown, own-bid raise (§7.7, Q3, Q8) | S7-2 / S7-3 / S7-4 / S7-15 / D-16 / D-21 | dashboard gates bids by `auctionFunds` + `bidRejectionReason` + `minimumBidFor` (same helpers the reducer will call — NONE once shared); the lowest card offers Buy only (NONE); the mini-auction button is "Drop-out" and the passer disappears from the contest; "One bid per private company" refuses the own-bid raise the owner ruled legal; markdown / revenue narration derived by the shell from two states | **LEGALITY SYNC** (pass label/semantics; own-bid raise allowed) + **STATE VISIBILITY** (a passed bidder still in the contest and re-prompted on his turn; passes-since-raise; SV-only markdown line, revenue line only when the SV is sold) + **RULES REFERENCE** (auction text: SV-only markdown, re-entry, escrow, no bid on the lowest) | U-26 |
| Bank crediting, signed bank, bank-break latch (§7.1 / §7.1a, D-15) | S7-10 / S7-20 | **Badge: NONE, confirmed** — `App.tsx` 12548 renders the badge from the shared `bankIsBroken(gameState)` (imported from `gameEngine/endgame`, the same function `settleRoundTransitions` asks), so once that function reads the latch the badge is correct with no UI change and no duplicate logic; 7.1's regression (d) pins the shared call. What remains is narrow: the bank figure can now go below zero and nothing formats a negative balance | **NONE** for the badge (documented confirmation) + a narrow **STATE VISIBILITY** for the negative balance ("Bank broken — owes $N") + **RULES REFERENCE** (bank-break timing text to check) | U-27 |
| Retrospective Batch 1–6 UI-parity audit (owner, 2026-09-15) | all Batch 1–6 items | not performed in this session; the Batch 1–6 reports were written before the classification existed (board legality such as private-company hex blocking, S6-7, is one known candidate) | **Playtest Readiness task**: inspect the completed Batch 1–6 reports against the current frontend and add every missed Part C item | U-28 |
| Stock actions refused outside the Stock Round; private purchases outside phases 3–4; train proposals outside Hardware; forged messages; chain-era messages (Q11) | S7-13 / S7-19 / D-23 | controls are hidden outside their round/step (#417, `privatesBuyableNow`, Hardware gate); forged payloads are not reachable from the shell; the only reachable chain-era control is the `TrainTradePanel` family (folded into U-21) | **NONE** (except U-21) | — |
| Every new ingress refusal | all | the room banner shows an ingress `refused` sentence (S10-1: reducer no-ops are silent) — so every Stage-7 refusal must be answered at ingress with its sentence, which §7 already requires | **STATE VISIBILITY** (by construction of the design; verify in 7.5 that no Stage-7 rule refuses only in the core) | folds into U-22 / S10-1 |

**Standing requirement (Stages 8–10).** Every engine-hardening item receives the same five-way classification
when it is resolved, in its batch write-up and as Part C entries for every non-`NONE` result, linked to the S-item.

**Playtest Readiness gate (owner, 2026-09-15, canonical wording in the ledger's Part F).** Before substantive
playtesting resumes, every authoritative rule introduced or changed during Batches 1–10 must either have a correct
normal UI path/representation or a resolved Part C item. A legal ordinary action must not require crafted
messages, and common illegal actions should not be presented as apparently legal where the client can determine
legality. Every Part C UI-parity item (U-19 … U-28 and successors) is fixed, verified obsolete, or explicitly
adjudicated by the owner — never merely deferred to final polish. The ledger's Part C is the one UI backlog; no
batch report substitutes for it and no second list is kept.

Also recorded in §12a/§7.6a: the player ↔ player trade's SR1 availability rule (U-19), and the classification for
S7-9 is `NEW ACTION` + `STATE VISIBILITY` (+ `RULES REFERENCE`) as the owner specified.

## 13. Files read (for the implementation batch's orientation)

`gameEngine/sandboxSession.ts` (adjusters 195–234; `applyAuctionStep` 2439; market step 2289; core 2633; arms:
`BuyStock` 4119, `SellStock` 4326, waterfall 1840–2229, `BuyTrainFromCorporation` 4764, `BuyPrivateCompany` 4796,
`transferPrivateToCorporation` 3613, `settleTrainSale` 1699, offers 3870–3937, `OpenStockRound` 3779,
`grantBOPresidency` 5662), `turnAuthority.ts` (whole), `messageSchema.ts` (whole), `derivedActions.ts` 100–190,
`auctionEscrow.ts`, `sharePurchase.ts`, `shareSale.ts`, `emergencyFunding.ts` 215–551, `privatePriceBand.ts`,
`trainPurchaseGate.ts`, `stationPlacementGate.ts` (treasury check 79–85), `replayLog.ts` 380–640,
`replayProviders.ts` (`chartInjections`), `utils/roomSession.ts` 370–519, `gameState.ts` 296–415 / 651–691,
`logRevert.ts` (`effectiveActions`), `sandboxState.ts` 505–740, `App.tsx` 9325–9835 (dispatch sites).

## 14. Ledger entries added (written into `RULES_HARDENING_BACKLOG.md` under Stage 7, uncommitted; project copy synced)

- **S7-10.** Auction proceeds and terrain fees are debited and never credited to the bank; the bank is short by the
  whole auction in every game and breaks early. `OPEN` (C3 family). Replay: bank differs in every log — bump.
- **S7-11.** `ProposePrivatePurchase.owner` / `ProposeTrainPurchase.seller_president` are trusted from the payload;
  the proposer can name himself, answer his own offer, and the derived settlement lands. `OPEN`. Probe-proved.
- **S7-12.** Direct `BuyTrainFromCorporation` / `BuyPrivateCompany` settle without consent, from any seller, at any
  price (≤ 0 → free; negative reverses the private's payment); a corporation/none seller is paid nothing. `OPEN`.
- **S7-13.** `BuyStock` / `SellStock` have no round gate (accepted in Operating Rounds and during the auction);
  `BuyStock` prices an IPO share from the message's `par_value`. `OPEN`. (S8-9's par half absorbed here.)
- **S7-14.** No ordinary-offer rescission exists; offers outlive the turn and the round (FCJ 232/273 answered in a
  later Stock Round); a proposal overwrites a standing offer; nothing blocks progression while one waits. `OPEN`.
- **S7-15.** Main-rotation waterfall messages are applied by the contest's current player while a mini-auction is
  live. `OPEN`.
- **S7-16.** `SellStock` accepts a percentage that is not a multiple of 10 (fractional holdings). `OPEN`.
- **S7-17.** Refusal-by-identity is dead on every board with `market_positions` (`applySandboxActionAfterAuction`
  allocates before the core runs); Stage-7 tests compare digests. `OPEN` (cross-reference S10-1).
- **S7-18.** A Brown-zone second pool message need not name the corporation of the first. `OPEN`.
- **S7-19.** `BidOnPrivate` (legacy, undispatched) advances the seat without the auction atom; the
  `AcceptTrainOffer` family are chain-era no-ops reachable on a pinned board. `OPEN` (with S10-8).
- **S7-20.** (revision 2) The bank break is not latched: `bankIsBroken` is `virtual_bank_vgp ≤ 0` re-derived at the
  set boundary; a bank refilled by purchases before then never ends the game. `OPEN`; owned by Batch 7.1 (§7.1a).

Also written in revision 2: S7-9 re-filed as owned by Batch 7.4 (Q12); S8-7 / S8-8 (sale half) / S8-9 annotated
"absorbed by Stage 7, Batch 7.2" (Q2); the thirteen rulings as Part D entries D-15 … D-25.
