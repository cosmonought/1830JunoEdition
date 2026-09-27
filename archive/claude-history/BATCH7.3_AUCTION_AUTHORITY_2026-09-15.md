# Batch 7.3 — authoritative private-auction repair

Date: 2026-09-15. Baseline: Batch 7.2 committed (`a927e5f419851e8ab85dc22a68ecdafdd635bdaa`).
`RULES_ENGINE_VERSION` **4 — deliberately not bumped** (the 4 → 5 bump belongs to Batch 7.5).
Design: `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` §7.7 (the five repairs, frozen), owner rulings
D-16 (Q3, the own-bid raise), D-21 (Q8, SV-only markdown), D-23 (Q11, the legacy messages), and the audit's
C5 / M1 / M2 with ledger items S7-2, S7-3, S7-4, S7-15, S7-19.

**Reviewed and accepted by the owner, 2026-09-15**, including §14(a): when consecutive passes reduce an
unsold SV to $0, no private-company revenue is paid — the SV is still unsold at that point, and the next
buy-bid-turn is the forced $0 purchase. Revenue-on-pass applies only after the SV has already been bought.
Three narrow bookkeeping points were resolved before committing (§15).
**The full Jest suite was not run. No golden, replay or corpus expectation was re-baselined — those belong
exclusively to Batch 7.5. The waterfall representation is unchanged. No frontend component was touched.
Every unrelated owner working-tree change is untouched.**

> **Bottom line.** The auction keeps its state machine and gains an authority: `auctionAuthority.ts`, asked by
> the reducer (by identity, *above* the auction atom) and at ingress (with the sentence). A bid on the cheapest
> card is refused because that card is a purchase; every bid, raise and face-value buy is escrow-aware through
> the **existing** `auctionEscrow.ts` helpers the dashboard already calls; a raise must beat the high bid by $5;
> and nothing in the main rotation moves while a contest is live. Inside the contest, a pass stopped being an
> execution: `passes_since_raise` counts consecutive passes, the bidder and his bid stay, a raise resets the
> count, and the contest ends at `bidders.length − 1`. And §1.2.3's two rules are finally separate — the
> markdown is the Schuylkill Valley's while it is unsold, and private income is paid only once the SV has sold.
> **One new suite of 42 cases; 46 focused suites, 848 tests, all passing.** Against `a927e5f` the
> corpus cost is two rooms' end states — **JUNO-Z6C from idx 9** and **JUNO-G6J from idx 7**, both C5, both
> predicted by the frozen design — plus three transient differences that re-converge.

---

## 1. Files changed

| File | What |
|---|---|
| **`frontend/src/gameEngine/auctionAuthority.ts`** (new, 307 lines) | The authority: `auctionRefusal` and the six per-message predicates, `auctionActor`, `standingBidOn`, `lowestOffered`. Design note #1580. |
| `frontend/src/gameEngine/sandboxSession.ts` | The gate in `applySandboxActionOnBoard` (above the auction atom); the mini-auction pass rewritten as a count (#1581); the raise's $5 floor and counter reset; the all-pass split into §1.2.3's two rules (#1580). |
| `frontend/src/gameEngine/gameState.ts` | `mini_auction.passes_since_raise?: number`, with its note. |
| `frontend/src/gameEngine/gameConstants.ts` | `SV_PRIVATE_ID`, beside `BO_PRIVATE_ID` and for the same reason (a cross-table join, not an index). |
| `frontend/src/gameEngine/turnAuthority.ts` | Ingress reasons for all six auction messages — one call, no auction rule of its own. |
| `frontend/src/gameEngine/index.ts` | The authority exported on the engine's surface. |
| `frontend/src/utils/auctionTransition.ts` | The shell's narration reads the payout off the **bank** instead of assuming it from the all-pass (§10). |
| **`frontend/src/utils/auctionAuthority.test.ts`** (new) | **42 tests** — the hostile-client matrix, the three-bidder sequences, conservation, refusal atomicity, the JUNO-3XD 6 no-seat-movement regression (§15b), and the two locks' agreement. |
| `frontend/src/utils/miniAuctionTurn.test.ts` | One **focused behavioural expectation updated** to the repaired contest rule, with the reason (§11c). Hand-built fixtures; no corpus, golden or replay content. |
| `frontend/src/utils/atomicReducer.test.ts` | One **focused behavioural expectation updated** — its all-pass case split into §1.2.3's two rules, with the reason (§11c). Hand-built fixtures; no corpus, golden or replay content. |
| `RULES_HARDENING_BACKLOG.md` | S7-2 / S7-3 / S7-4 / S7-15 → `RESOLVED`; S7-19 → `PARTIAL` (its `BidOnPrivate` half); U-26 given its Batch 7.3 outcome; a Part E row. |
| **`BATCH7.3_AUCTION_AUTHORITY_2026-09-15.md`** (new) | This report. |

**The representation is untouched, as the frozen design requires:** `privates[].bids`, `is_lowest_offered`,
`mini_auction`, and derived escrow all keep their shapes and their meanings. The only field added is
`passes_since_raise`, which §7.7(4) specifies by name.

**Untouched, and not read:** every `components/` file, `App.tsx`, and the owner's in-flight
`stockTransferFocus` / `stockCardFocus` / `utils/stockTransaction*` / `rules*.test.tsx` work.

---

## 2. The authoritative predicates introduced

`frontend/src/gameEngine/auctionAuthority.ts`. Pure functions, reasons rather than booleans, nothing throws.

```ts
auctionActor(waterfall): string | null            // mini_auction?.current_turn ?? current_turn
standingBidOn(waterfall, privateId, player): number
lowestOffered(waterfall): WaterfallPrivateStatus | null

waterfallBuyRefusal(state, waterfall): string | null
waterfallBidRefusal(state, waterfall, { private_id, bid_amount }): string | null
waterfallPassRefusal(state, waterfall): string | null
miniRaiseRefusal(state, waterfall, { bid_amount }): string | null
miniPassRefusal(state, waterfall): string | null
legacyBidRefusal(state): string | null

auctionRefusal(state, waterfall, msg): string | null   // the one entry point both locks ask
isAuctionMessage(msg): boolean
```

| Message | Rules asked, in order |
|---|---|
| `WaterfallBuyLowest` | contest not live → a private is on offer → escrow-aware `available ≥ face` |
| `WaterfallBidHigher` | contest not live → the private exists → **not `is_lowest_offered`** → whole dollars → `bidRejectionReason(funds, amount, minimumBidFor(...), ownStandingBid)` |
| `WaterfallPass` | contest not live |
| `WaterfallMiniAuctionRaise` | a contest is live → whole dollars → the actor is one of its bidders → `amount ≥ high_bid + $5` → escrow-aware, net of the raiser's own standing bid |
| `WaterfallMiniAuctionPass` | a contest is live → the actor is one of its bidders. **Nothing else** — a pass is never illegal; what changed is what it *does* |
| `BidOnPrivate` | refused on a board carrying a `rules_engine_version` (D-9 leaves a legacy board alone) |

**The actor is the atom's cursor**, not the message and not the seat: `applySandboxWaterfallAction` applies
every auction action as `mini_auction?.current_turn ?? current_turn` (#1232/#544), so a predicate judging a
different player would be judging a different action. Ingress has already established that the sender *is*
that player, because `actingAddress` reads the same two fields.

**`turnAuthority.ts` states no auction rule of its own** — one call to `auctionRefusal`, verified by static
search (§11d).

---

## 3. Escrow, and the own-rebid treatment

**Not reimplemented.** `auctionEscrow.ts` has computed this since design note #0 and the dashboard has called
it all along; this batch makes the reducer call the *same* functions:

```
escrowedBids(waterfall, player) = Σ standing bids on every still-unsold private
availableCash                   = max(0, totalCash − escrowedBids)
```

**A raise of one's own bid is charged only the increment.** `bidRejectionReason(funds, amount, minimum,
raisingFrom)` takes `raisingFrom` = this player's standing bid on that private, and asks
`amount − raisingFrom ≤ available`. Written out, that is `amount ≤ total − (otherEscrow)` — the new bid must
fit inside the player's cash alongside everything he has committed *elsewhere*, and the money already on this
card is not charged twice. Without it a leader could not defend his own bid (owner ruling D-16/Q3 makes that
raise legal, so it has to be affordable the right way).

**The face-value purchase gets the same allowance**, for the same arithmetic reason: a standing bid on the
card being bought would be released by the purchase, so it is not held against the buyer. In ordinary play
that bid cannot exist (A1 forbids bidding on the cheapest); on a legacy board it can.

Pinned at the boundary: $9,999 on $1,160 of cash → refused, $1,160 → legal; the same dollar on two privates →
refused; $300 + $300 on $600 → legal, and one more dollar → refused; a $400 raise of a $300 bid on $400 of
cash → legal, $401 → refused; in a contest, A with $200 and $80 already on the card may raise to $200 and not
$205, and with a further $60 standing elsewhere may raise to $140 and not $145.

---

## 4. The all-pass, corrected (C5)

Rulebook §1.2.3 states two rules with one trigger, and the engine ran both every time:

| All-pass, and the SV is… | Markdown | Private income |
|---|---|---|
| unsold and on offer | **the SV only**, −$5 | **none** |
| unsold, marked to $0 | the SV is **taken by the next seat for $0** (cascade and priority deal unchanged) | **none** — it was unsold when the table passed |
| already sold | **none** — not the JK, not the B&O, not whatever is cheapest | **paid** to every private already bought |

Implemented as two separate conditions rather than one branch: the markdown asks whether the private on offer
*is* `SV_PRIVATE_ID`; the income asks whether the SV is still in `privates` at all. In a game those are two
faces of one fact — the SV is the cheapest private, so it is on offer for exactly as long as it is unsold — and
separating them is what makes the Level Playing Field right **without a variant branch**: the James River &
Kanawha is never the SV, so it is never marked down (D-21/Q8). A board with a non-SV private on offer and the
SV unsold (no legal sequence reaches it; a fixture can) marks nothing down and pays nobody, which is the
conservative reading of both rules.

The `WATERFALL_PASS_MARKDOWN` constant, the $0-taker branch, the cascade and the priority-deal handling are
all unchanged.

---

## 5. `passes_since_raise`, and the proof that a passed bidder re-enters

`mini_auction.passes_since_raise?: number`, **absent = 0** (#232 — which is what keeps every stored log
replaying, since a contest rebuilt from a log that predates the field has had no passes at all).

- `WaterfallMiniAuctionPass` increments it, keeps the bidder in `bidders`, keeps his bid in `privates[].bids`,
  and moves the cursor to the next bidder after the actor, skipping the high bidder (`nextMiniTurn`, #544).
- Any legal `WaterfallMiniAuctionRaise` sets it to 0 — §1.2.2 ends a contest on passes that are *consecutive*,
  so a new bid has to be answered from scratch by everyone, including whoever had already passed.
- The contest resolves when it reaches `bidders.length − 1`. The winner is the **high bidder** at his own
  `high_bid`, stated rather than arrived at by elimination (the old arm's `remaining[0] ?? high_bidder` was the
  same player only because elimination had removed everyone else first).

**Tested with three bidders, deliberately.** Every contest in the stored corpus is a two-bidder one, where
`bidders.length − 1` is 1 and one pass resolves it under the old rule and the new alike — so the corpus can
neither expose the bug nor defend the fix.

| Frozen sequence | What the test runs (the cursor decides whose action a message is) | Result |
|---|---|---|
| **A** — A raises, B passes, C raises, **B raises** | A raises → B passes → C raises → A passes → **B raises** | B's raise is **legal**: `bidders` still `[A,B,C]`, B's $90 still standing after his pass, and his raise takes the high bid. Nobody has paid anything — a bid is escrow |
| **B** — A raises, B passes, C passes → **A wins** | the same three messages | resolves on the second pass: private to **A** at $120, A's cash −$120, **B and C charged nothing**, bank +$120 exactly once |

Also pinned: a three-bidder contest does **not** resolve on the first pass (the old bug, stated as a test); a
two-bidder contest still resolves on one pass (why the corpus is unmoved); and the high bidder is never handed
the cursor.

---

## 6. The contest freeze, and `BidOnPrivate`

**S7-15.** `WaterfallBuyLowest`, `WaterfallBidHigher` and `WaterfallPass` are refused while `mini_auction` is
live, at both locks, with the sentence naming the contested private. The seat rule could never have caught
this, and that is the point: during a contest `actingAddress` names the *contest's* current player (#1232), so
the one person who could move the main rotation mid-contest is exactly the one the seat check waves through.
The control asserts all three become legal again the moment the contest resolves.

**S7-19 (its `BidOnPrivate` half).** Refused on a board carrying a `rules_engine_version`; a legacy board keeps
the arm it was played on (D-9), exactly as `RunManualRoute` does. The test asserts the seat does not move —
which was the whole fault: the arm was `advanceSeat` while `applySandboxWaterfallAction` ignored the message,
desynchronising the seat from `waterfall.current_turn` (#1232's lock-up, reachable by message). The schema and
the type stay until S10-8, and the `AcceptTrainOffer` family is **Batch 7.4's** — this batch did not broaden
into offer machinery.

---

## 7. Where the gate lives, and why it is higher than 7.2's

Batch 7.2's stock gates sit in `applySandboxActionCore`, ahead of every settle stage (#1019). **The auction
needs one layer higher.** #1340 put the auction atom *in front of* the board:

```
applySandboxActionOnBoard:
    [#1580 gate]  <- here
    applyAuctionStep(state, msg)          // charges the buyer, writes the winner, pays the all-pass
    applySandboxActionAfterAuction(...)   // market step -> core -> applyOneAction -> settle chain
    settleAuctionLifecycle(...)
```

A refusal asked in the core would arrive **after** the money had moved. Worse, it would reproduce a partial
application that existed before this batch: when the 7.1 ledger declined an auction charge, `applyAuctionStep`
returned the board it was handed and `applyOneAction` still advanced the seat — a purchase that did not happen
that nonetheless ended a turn. The same shape is visible in the corpus at JUNO-3XD 6 (§12), where #1184's
minimum-bid refusal left the bid undone and the seat advanced anyway.

So the whole message is refused, by identity, before either atom sees it: no auction state, no cash, no
ownership, no priority deal, no pass streak, no seat, and no `settleAuctionLifecycle`.

**The settlement path needs no separate check.** Every winner and every payment is derived inside
`applyAuctionStep` from the atom the gate has already judged, and all three money paths — the face-value
purchase, the mini-auction win and the $0 taker — go through the 7.1 ledger's `transfer(player → BANK)`.

---

## 8. Ledger and conservation

No inline `Math.max(0, …)` remains in the auction's money path (7.1 removed it; verified by static search —
the one surviving `Math.max(0, …)` in the auction arm is the *price* floor that caps the SV markdown at $0,
which is the rule). Bidding moves no money at all; only a resolution does.

| Path | Money | Asserted |
|---|---|---|
| face-value purchase | player → bank, once, at the authoritative price | cash −$20, bank +$20, `moneyConservationBreach` null |
| mini-auction win | winner → bank, once, at `high_bid` | A −$120, bank +$120, **B and C unchanged** |
| losing bidders | nothing, ever | their cash unchanged through the whole contest; escrow releases because the private leaves `privates`, not by a refund |
| $0 SV acquisition | nothing | taker's cash unchanged, bank unchanged, `moneyTotal(before) === moneyTotal(after)` |
| all-pass income | bank → owners, in one write | +$5 and +$10 to two owners, bank −$15 |
| all-pass markdown | **nothing** | every player's cash and the bank unchanged |

---

## 9. Refusal atomicity

Ten refused hostile actions each assert **`[]` differing fields** across `fieldDigests` and literal whole-state
equality (`expect(after).toEqual(before)`), plus `moneyConservationBreach === null`: a bid on the lowest, an
unaffordable bid, a sub-minimum bid, an unaffordable buy, a buy / bid / main-pass during a contest, a +$1
raise, a raise beyond the raiser's cash, and the legacy `BidOnPrivate`.

One of them is then spelled out field by field, because a digest is only as good as its reader: player cash,
bank, private ownership, the listed face value, the bid list, the contest's `bidders` / `high_bid` /
`high_bidder` / `passes_since_raise`, `waterfall.current_turn`, `consecutive_waterfall_passes`,
`active_player_index`, `priority_deal_index` and the round type — all unchanged.

**Settle-chain normalisation is accounted for rather than tripped over.** The boards carry
`current_global_era` up front (7.1 §9a proved that field and `operating_sub_phase` are the pipeline's, not the
transaction's), and because the gate returns by identity *above* both atoms, no settle stage runs at all for a
refused auction message — which is why these assertions are `[]` and not a named list.

**And a control**: the same boards accept the legal version of each action, so no case can pass vacuously.

---

## 10. `auctionTransition.ts` — presentation synchronised with the authoritative board

**This is not an auction rule and does not decide one.** §1.2.3's condition — when private income is paid —
belongs to the reducer alone. `utils/auctionTransition.ts` exists to describe what an action DID by reading
the two boards (#1340a), for the shell's sentences.

What changed is that it stopped assuming. It computed `payouts = applyPrivateRevenue(after).payouts` on
**every** all-pass, which was a faithful reading of the board only while the reducer paid on every all-pass;
once the reducer gained a branch that pays nobody, the same line became a claim rather than an observation,
and would have printed a payout line for money that never moved — #778's failure shape ("a log that cannot
distinguish 'did it' from 'declined it'") in the narration layer.

So it now determines **whether a payout occurred** from the actual before/after state: private income is
funded by the bank in one write (#329/#1560), so a bank that did not fall did not pay. No rule is restated to
read that. `allPassed` keeps its meaning ("everyone passed" — true in both branches) and its doc comment now
says so; `payouts` carries the money. A markdown-only all-pass and the $0 taker both report no payout, whatever
the rule behind them happens to be.

Recorded in Part C under the existing **U-26** (annotated, not duplicated) and classified **NONE**: no UI work
is owed for it.

---

## 11. Validation

**Only focused suites were run. The full Jest suite was not run.**

### 11a. New and repaired suites

| Suite | Tests |
|---|---|
| `utils/auctionAuthority.test.ts` (new) | **42** passed |
| `utils/miniAuctionTurn.test.ts` | 19 passed (one focused expectation updated) |
| `utils/atomicReducer.test.ts` | 6 passed (one focused expectation split into two) |

### 11b. Focused suites — 46 suites, 848 tests, all passing

`auctionAuthority`, `miniAuctionTurn`, `auctionSeating`, `auctionCashMovement`, `atomicReducer`, `autoPass`,
`gameSetup`, `levelPlayingField`, `replayJunoCV4`, `roomSession`, `bidSectionLabel`, `divergenceWatch`,
`shellNarration`, `turnAuthority`, `messageSchema`, `privateOrdinal`, `boFloatRule`, `privateRevenue`,
`privateExchange`, `baltimorePrivate`, `privateClosure`, `cashLedger`, `stockTransactionAuthority`,
`stockRefusalAtomicity`, `refusalAtomicity`, `bankBreakLatch`, `emergencyFunding`, `emergencyTrainFlow`,
`logRevert`, `logExport`, `derivedActions`, `serverProtocol`, `replayEquivalence`, `replayAttribution`,
`operatingCursorReplay`, `stateDigest`, `trainDiscard`, `batch36`, `forcedDivestment`, `variantRules`,
`rulesVersion`, `roundLabel`, `joinFlash`, `polishWave7`, `turnGateSource`.

### 11c. Two focused behavioural expectations updated — see §15a

**Not re-pins.** Both are hand-built-fixture behavioural suites that asserted the behaviour this batch
corrects; neither reads a stored log, a golden fixture or any corpus board. §15a states the check.

| Suite / case | Was | Now, and why |
|---|---|---|
| `miniAuctionTurn.test.ts` "passes to the lowest bidder still in after a drop-out" | `bidders` had **shrunk** to `[BEN, ADA]` — the passer expelled | `bidders` stays `[DOT, BEN, ADA]`, DOT's $120 still standing, `passes_since_raise` 1 — and the **cursor** assertion the case is actually about (`current_turn === BEN`) is unchanged (§1.2.2 / M1) |
| `atomicReducer.test.ts` "the all-pass marks the cheapest down and pays private income" | markdown **and** income, always | split into §1.2.3's two rules: with the SV sold (this fixture's first seat buys it) income is paid and **nothing** is marked down; a second case covers the SV unsold — the SV loses $5 and **nobody** is paid (C5) |

### 11d. Stale expectations left for Batch 7.5, with the delta this batch adds

Batch 7.2 committed with **4 suites / 6 cases** stale (verified then against the 7.1 tree). Batch 7.3 makes it
**5 suites / 10 cases**, and every added case is JUNO-Z6C's C5 divergence moving from idx 193 to idx 9.

| Suite | Cases | Owner |
|---|---|---|
| `replayGolden.test.ts` | JUNO-CV4 (bank only — 7.1's), **JUNO-G6J** (7.1's bank, **plus 7.3's** `player_cash` 985 → 980 and bank 9550 → 10305: the JK is no longer discounted $5) | 7.1 + **7.3** |
| `replayJuno3XD.test.ts` | 2 | 7.1 (idx 28) |
| `gameHistory.test.ts` | **4** (was 1) | 7.1 (Z6C 193) + **7.3** (Z6C 9) |
| `roundReplay.test.ts` | 1 | 7.1 |
| `moneyConservation.test.ts` | **1** (was 0) — "the Yellow Sign award is still the one minting rule left": on the re-diverged Z6C that entry is no longer reached, so the list is empty. **The invariant is not weakened** — nothing in the corpus mints at all now | **7.3** |

### 11e. Typecheck, build, lint, static searches

| Check | Result |
|---|---|
| `node …/tsc -p server/tsconfig.json --noEmit` (the whole engine) | **clean** |
| `npx tsc --noEmit -p frontend/tsconfig.json` | **clean for this batch's files**; the four errors it reports are the owner's in-flight `StockRoundPanel.tsx` / `stockTransferFocus` / `stockCardFocus` work, unchanged from the state Batch 7.2 handed over |
| `react-app-rewired build` (production webpack, `GENERATE_SOURCEMAP=false`) | **succeeds** (built to a `BUILD_PATH` outside the repository — this session's filesystem bridge cannot unlink, and CRA empties its output directory first, so `frontend/build/` is untouched) |
| `npx eslint` on every file this batch touched | **identical to the baseline**: 1 error + 3 warnings, all pre-existing in `sandboxSession.ts`. The three new/changed files are clean |
| static: does `turnAuthority` restate an auction rule? | **no** — one call to `auctionRefusal`; the only match for `minimumBidFor` / `is_lowest_offered` / `mini_auction` in that file is a comment |
| static: how many escrow implementations? | **one** — `auctionEscrow.ts`, called by `App.tsx`, `WaterfallAuctionDashboard.tsx` and now `auctionAuthority.ts` |
| static: inline money floors in the auction path | **none**; the surviving `Math.max(0, …)` there is the SV markdown's **price** floor at $0, which is the rule |
| static: `passes_since_raise` readers/writers | `gameState.ts` (the field), `sandboxSession.ts` (raise resets, pass increments, resolution reads) — and nothing else guesses at it |

---

## 12. Corpus divergence — 7.3 only, measured against `a927e5f`

**Method.** The committed 7.2 tree (`git archive a927e5f`) and this tree were each compiled with
`server/tsconfig.json` and every corpus file replayed through both, capturing `stateDigest`, `fieldDigests`,
`moneyTotal` and the bank before every applied entry (the observer runs after the grid and chart move and
before the arm, #1191) and at the end. Eighteen files. **Every difference below is 7.3-only by construction:
the baseline is 7.2, not 7.1 and not Batch 6.** Throw-away probes, outside the repository.

### 12a. End-state divergences — two rooms, both C5

| File | Entry | Action | First differing fields | Reason |
|---|---|---|---|---|
| **`server/JUNO-Z6C`** | **idx 9** | `WaterfallPass` by `p-je0gw2v0` (the third of three passes) | `waterfall` → then the whole game | The SV was already sold and the B&O ($220) was the only card left on offer. 7.2 marked it **220 → 215**; §1.2.3's markdown is the SV's, so it **stays 220**. Income was paid in both (the SV is sold). Final: 21 fields |
| **`server/JUNO-G6J`** and **`golden/JUNO-G6J`** | **idx 7** | `WaterfallPass` by `p-lzjh2r6u` (the second of two) | `waterfall` | LPF roster: the SV was sold and the **James River & Kanawha** ($120) was lowest. 7.2 marked it **120 → 115**; the JK is not the SV, so it **stays 120** (D-21/Q8). Final: `player_cash` (985 → 980 — the buyer pays the $5 back), `private_companies`, `virtual_bank_vgp` (9550 → 10305) |

Both were predicted by the frozen design's §9 table, at these exact indices.

### 12b. Transient divergences — three rooms, identical at the end

| File | Entry | Action | First differing fields | Reason |
|---|---|---|---|---|
| `server/JUNO-8E8` | idx 8 | `WaterfallMiniAuctionRaise` $125 | `waterfall` | the live `mini_auction` now carries `passes_since_raise: 0`. The contest resolves two entries later and the field goes with it |
| `server/JUNO-CV4`, `export/JUNO-CV4`, `golden/JUNO-CV4` | idx 7 | `WaterfallMiniAuctionRaise` $135 | `waterfall` | the same |
| **`export/JUNO-3XD`** | **idx 6** | `WaterfallBidHigher` $165 on private 5 by `p-h96t6pld` | **`active_player_index`** | that player already had **$165 standing on private 5**, so the bid is below `minimumBidFor` ($170) and #1184 already refused it in 7.2 — but only inside the sub-reducer, so `applyOneAction` still ran `advanceSeat`. 7.3 refuses the whole message, so the seat stays put until the rotation re-converges. **A pre-existing partial application, closed by where the gate sits (§7)** |

### 12c. Unchanged

`server/JUNO-7NZ`, `server/JUNO-CW7`, `server/JUNO-FCJ`, `server/JUNO-TQQ`, `export/JUNO-JJD`,
`export/JUNO-QVC`, `export/JUNO-Y8V`, `golden/JUNO-7NZ`, `fixture/JUNO-FCJ-prefix96` — identical at every step.

**No golden, replay or corpus expectation was re-baselined.** `RULES_ENGINE_VERSION` is still 4;
`SUPPORTED_RULES_ENGINE_VERSIONS` untouched. The stale cases in §11d are left failing for Batch 7.5.

---

## 13. UI-parity bookkeeping

No frontend component was changed. **U-26** (the existing Batch-7 auction Part C item) is annotated with this
batch's outcome rather than duplicated; no new Part C item was created, because every consequence this batch
produces falls inside U-26's stated scope:

| Consequence | Classification |
|---|---|
| escrow-aware affordability and the minimum bid | **NONE, confirmed and now genuinely shared** — the reducer calls the dashboard's own `auctionFunds` / `bidRejectionReason` / `minimumBidFor`, so there is one implementation rather than two |
| the own-standing-bid raise on the **main** bid control | **LEGALITY SYNC** — `WaterfallAuctionDashboard` 480 omits `raisingFrom` and a `repeatBidReason` refuses the own-bid raise outright, while the contest's raise control at 481 does pass `ownRaiseEscrow`. The engine now allows it everywhere and charges only the increment (D-16/Q3) |
| the mini-auction pass | **LEGALITY SYNC** — the button says "Drop-out" and the passer vanishes from the card; he now stays, keeps his bid and is re-prompted |
| `passes_since_raise` | **STATE VISIBILITY** — nothing renders how close a contest is to resolving |
| the contest freeze | **STATE VISIBILITY** — Buy / Bid / Pass should be disabled on every seat while a contest is live; today they are refused instead of greyed |
| buy-vs-bid on the lowest card | **NONE** — the card offers Buy only (verified) |
| the all-pass narration | **NONE** — `auctionTransition.ts` was corrected here (§10) as presentation synchronised with the authoritative board: it reads whether a payout occurred from the before/after bank and decides no rule of its own. No UI work is owed; annotated under U-26 rather than filed as a new item |
| auction rules text | **RULES REFERENCE** — SV-only markdown, income only once the SV has sold, re-entry after a pass, escrow, no bid on the cheapest (folds into U-11's WIP) |

---

## 14. Ambiguities, interactions and judgement calls

**(a) RULED — the `$0` SV branch pays no income (owner, 2026-09-15).** §7.7(3) reads "if the lowest offered
is the SV → −$5, no revenue; at $0 → the next seat takes it, cascade, PD to that seat's left (unchanged)",
without saying in as many words whether the $0 case pays. I read the "$0" clause as a *continuation* of the
unsold case, and the owner has accepted it: **when consecutive passes reduce an unsold SV to $0, no private
company revenue is paid — the SV is still unsold at that point, and the next buy-bid-turn is the forced $0
purchase. Revenue-on-pass applies only after the SV has already been bought.** #337's old reasoning survives
intact ("the payout must not depend on whether the markdown happened to land on a round number"): under the
repair neither markdown branch pays. Pinned by `auctionAuthority.test.ts` "hands the SV to the next seat for
$0 once it is marked down that far, and pays nobody".

**(b) The fourth combination is answered conservatively.** The design names three cases; a board where the SV
is *unsold but not the private on offer* is a fourth. No legal sequence reaches it — the SV is the cheapest
private and only gets cheaper — but a fixture can build it. It marks nothing down (only the SV marks down) and
pays nobody (the SV has not sold). Both halves follow the rule each is written from.

**(c) A stored corpus entry was already being half-applied, and that is how it showed up.** JUNO-3XD 6 (§12b)
is a sub-minimum bid that #1184 refused in 7.2 while `advanceSeat` ran anyway. The gate's position fixes it as
a side effect. It is worth flagging because the same shape existed for *every* auction refusal the ledger made
in 7.1, and 7.4's offer settlements will have the same question to answer.

**(d) A pass is never illegal, so `miniPassRefusal` states almost nothing.** It refuses only when no contest is
live or when the atom's cursor names somebody the contest does not list (a malformed atom, not a player). The
high bidder is never handed the cursor, so there is no "you are winning, you may not pass" rule to write.

**(e) The sub-reducer keeps a defensive copy of two rules.** `applySandboxWaterfallAction` is exported and
called directly by tests and fixtures, so the $5 raise floor and #1184's bid minimum stay inside it as well as
in the authority — the same function, not a second implementation, and the reason is that a caller reaching the
sub-reducer directly should not be able to raise by a dollar. The `is_lowest_offered` branch at #271 (a bid on
the cheapest opening a contest on the spot) is now **unreachable** through `applySandboxAction`; it is left in
place because that is where #271's record lives, and because the sub-reducer's direct callers still exercise it.

**(f) Not done, by instruction.** 7.4's pending offers, consent and the `AcceptTrainOffer` family; Stage 8;
the `RULES_ENGINE_VERSION` bump; the golden and replay re-baselines; every Part C UI item.

---

## 15. Review bookkeeping (owner, 2026-09-15) — three narrow points, resolved

### 15a. "Re-pinned" was the wrong word, and the check behind it

The first draft of this report said both "nothing re-pinned" and "two test files re-pinned". Both files are
**ordinary focused behavioural expectations updated to the newly authoritative 7.3 auction rules** — not
re-pins, and not re-baselines. **No golden, replay or corpus expectation was re-baselined in Batch 7.3; those
belong exclusively to Batch 7.5.** The terminology is corrected throughout (§1, §11a, §11c).

Checked rather than asserted — what each file reads, and what it asserts:

| File | Where its boards come from | Corpus / golden / replay content | Verdict |
|---|---|---|---|
| `utils/miniAuctionTurn.test.ts` | `openContest` / `threeWay` build a `WaterfallStateResponse` literal in the file; the calls go straight to `applySandboxWaterfallAction` | **none** — no `readFileSync`, no `JUNO-*`, no `__fixtures__`, no `.jsonl`, no `replayLog`, no snapshot | focused behavioural expectation |
| `utils/atomicReducer.test.ts` | `dealt()` = `withEmptyRoster(sandboxScenarioState(...))` + a two-player `SetupGame` — a board this test deals for itself | **none.** Its only `JUNO-Z6C` mention is prose in a comment explaining the defect, and its one `readStripped("gameEngine/replayLog.ts")` is a **source-text** scan (#1340's "neither caller composes the auction any more"), not a replayed board | focused behavioural expectation |

What changed in each is in §11c. The two genuinely corpus-facing expectations this batch moves — `replayGolden`
JUNO-G6J and the Z6C-driven `gameHistory` / `moneyConservation` cases — are **left failing**, listed in §11d,
and belong to 7.5.

### 15b. JUNO-3XD idx 6, pinned as a regression

Confirmed, point by point, and now covered by `auctionAuthority.test.ts` "refuses a sub-minimum bid
ATOMICALLY — the seat does not advance either (JUNO-3XD 6)":

| Claim | Status |
|---|---|
| the authoritative auction gate catches the message **above** `applyAuctionStep` | **yes** — `applySandboxActionOnBoard` asks `auctionRefusal` before either atom runs (§7) |
| the message is refused **atomically** | **yes** — the test asserts literal whole-state equality (`expect(after).toEqual(before)`) |
| the seat / cursor does **not** advance | **yes** — `active_player_index` and `waterfall.current_turn` are each asserted unchanged, named one at a time because they are two atoms and the old fault moved one of them |
| the 7.3-vs-7.2 transient difference is therefore the **removal of the old partial application** | **yes** — #1184 refused this bid in 7.2 as well; what differed was that `applyOneAction` still ran `advanceSeat` for it. Nothing about the bid's legality changed in 7.3 |
| later actions **reconverge** the log | **yes** — the sweep reports `export/JUNO-3XD` as end-state identical between `a927e5f` and this tree (§12b) |

The regression is built on the same shape as the stored entry — a re-bid at the player's own standing amount,
below `minimumBidFor` — and carries a control in which a legal bid **does** advance both pointers, so "neither
moved" is a fact about the refusal rather than about the fixture.

### 15c. `auctionTransition.ts`, documented as synchronisation

The correction is kept and reframed (§10): it is **presentation/transition synchronisation with the
authoritative board state**, not an independent auction rule. It determines whether a payout *occurred* from
the actual before/after bank; it does not decide when §1.2.3 pays revenue — that stays the reducer's; and
because of it a markdown-only all-pass no longer falsely narrates a payout. The module's own design note says
this in place. Part C's **U-26** is annotated with it and classified **NONE**; no duplicate backlog item was
created.
