# Variant Certification — Delayed Auction — DA-1 audit and certification design

**Revision:** rev 2 (2026-09-25, owner review) — DA-1 accepted for implementation planning; owner decisions OD-DA-1 …
OD-DA-4 and the lobby-copy ruling recorded (§19; ledger D-52 … D-56); two review corrections applied — DA-4's
standard-game obligation (§22) and the pre-closure v10 log scan (§23). rev 1 is the audit as reviewed; its analysis is kept
unchanged below except where marked *(rev 2)*.
**rev 3** (2026-09-25): OD-DA-2b decided on owner review (§19; ledger D-57); one wording check noted for DA-5.

**Date:** 2026-09-25 · **Pass:** DA-1 (audit / design only — no gameplay code changed) · **Status of the variant:**
`DEFERRED — PRE-LAUNCH VARIANT CERTIFICATION REQUIRED` (S9-7). **NOT certified.**

**Starting state (verified before any work):** branch `main`; local HEAD `8d42d68011fb18c73611e5ebd4941b28b1c50501`
("Certify Unpredictable Revenue at rules engine v10") == `origin/main` (0 ahead / 0 behind; the remote was also
confirmed at `8d42d68` by `git ls-remote`); `RULES_ENGINE_VERSION = 10` (`frontend/src/gameEngine/rulesVersion.ts:65`);
tracked tree clean; only untracked file `.claude/settings.local.json`; no `.git/index.lock`.

**Verdict in one paragraph.** The owner spec is intact and the delayed trigger itself is correct: the auction is
inserted exactly at the end of the Operating Round set in which the first 3-train is bought, once, as a pure reducer
consequence, and it replays, restores and undoes by log rebuild. The general auction procedure (M1, M2, SV markdown,
cascade, escrow) is correctly implemented and inherited unchanged. **But the variant is not certifiable as built:**
eight defects were found — five HIGH, each confirmed by an executed probe: the dormant auction
atom accepts auction messages outside the auction (DA-F1), `SetBoPar` bypasses the B&O lock and the private's
ownership (DA-F2), the delayed auction does not start with the Priority Deal holder (DA-F3) and hands the Priority
Deal to the wrong player afterwards (DA-F4), and the Camden & Amboy grant can create a PRR share and skips the
presidency and float consequences of the share it grants until some later share trade (DA-F6); two MEDIUM defects were also probe-confirmed (DA-F5,
DA-F7) and one LOW edge was traced in code (DA-F9). Three are reachable in the standard game by a forged client (DA-F1,
DA-F2, DA-F7), and **one is a standard-game rules defect reachable in legitimate play** (DA-F5: after the SV is marked
down to $0 and taken, Stock Round 1 opens with the wrong player). Three genuine owner decisions were raised (OD-DA-1 … OD-DA-3); *(rev 2)* they and a fourth (OD-DA-4) were decided on owner review — §19. **Audit verdict: COMPLETE — READY FOR OWNER DECISIONS / IMPLEMENTATION PLANNING.**

---

## 1. Scope and authority hierarchy

1. **Owner rulings / specifications for Delayed Auction** (binding): the three anchors (§2), the design notes that
   record them in code (#904, #904a, #905, #1228), the owner ruling Q2 of 2026-09-15 recorded at S8-7 (the delayed
   SR1 is the first Stock Round), D-10 (owner-defined variants are judged against their own spec), D-16, D-21, D-26.
2. **2018 revised Lookout 1830 rulebook** (`en_1830re.html_Rules_1830-RE_EN.pdf`, the Classic authority named at
   `RULES_HARDENING_BACKLOG.md:45-52`) for the auction, Stock Round, private-company and corporation mechanics.
3. **Existing certified implementation** only where consistent with 1–2.
4. Comments, older docs and tests are evidence only.

**Sources actually read.**

| Source | How read | What was used |
|---|---|---|
| `1830 FULL RULES with variants.pdf` (48-page Lookout/Mayfair book, repository root) | page images read directly: pp. 7–16, 25–29, 46–47 | 1.3 + sidebar; 2.0; 3.0–3.7; 4.0–4.2; 5.0–5.5; 6.0–6.4; 7.0; **C-2.2 (the Classic buy-bid auction, the text the 2018 book revises)**; V-1.8 auction variants; T-05 … T-08 and the private-company effects |
| 2018 revised rulebook, publisher copy `lookout-spiele.de/upload/en_1830re.html_Rules_1830-RE_EN.pdf` | the owner's local copy is not in the repository or a connected folder; the publisher file was read through the web tool, which returns **short quotations only** (full transcription refused on copyright grounds) | §1.2, 1.2.1, 1.2.2, 1.2.3; §2.1–2.5 phases; §3.0 / 3.1 private companies and sale; §4.3 certificate limits; §5.0–5.4 Stock Round, sales, purchases, floating, change of president; §6.0 private revenue at OR start |
| Code at `8d42d68` | read directly (device repository; identical container clone for tooling) | every citation below |
| `RULES_HARDENING_BACKLOG.md`, `AUDIT_RULES_TO_MACHINE_2026-09-13.md`, `BATCH7.3_AUCTION_AUTHORITY_2026-09-15.md`, `src/tests.rs` | read | §17 routing dispositions (backlog line numbers cited in this document are those of `8d42d68`, before DA-1's own additions) |

**Limitation, and why it does not block.** The 2018 text was verified in short quotations, not read end to end. Every
rule this audit relies on is supported by **both** a 2018 quotation **and** the 48-page Classic text (C-2.2 and the
base sections), and no finding depends on wording where the two differ. The 2018 revisions that matter here, all
confirmed by quotation: option 3 is "Bid for an unsold private company **other than the one with the lowest face
value**" (§1.2); a bid must exceed face or the standing bid "by at least $5 **and a multiple of $1**" (§1.2.1);
"**The priority deal card does not change hands after an auction**" (§1.2.2); and "**Only if the next company has no
bid on it**, the buy-bid-turn sequence then resumes with the player with the priority deal card" (§1.2.2 — the
cascade). The stop condition "rulebook unavailable and a finding depends on exact rule text" is therefore **not**
triggered.

---

## 2. Owner-defined Delayed Auction specification

**The three anchors are confirmed in the durable record and are not contradicted anywhere.**

| # | Anchor | Where the record states it |
|---|---|---|
| A1 | Stock Round 1 opens without the private auction having occurred | `gameVariants.ts:454` (#904: "The game opens on Stock Round 1 with no privates in play"); `sandboxSession.ts:4905-4938` (#1228, the reducer deals SR1, `private_auction_complete: false`, macro 1) |
| A2 | The auction begins **after the Operating Round set in which the first 3-train is bought** | `gameVariants.ts:454-457`, `726-733` (#905, "corrected mid-build" from "immediately before Stock Round 3"); `sandboxSession.ts:4676-4729` ("at the exact end of the Operating Round set in which the first 3-train is purchased"); `BO_LOCKED_REASON` `gameVariants.ts:769-770` |
| A3 | The B&O is locked before the delayed auction | `gameVariants.ts:451-488` (#904), `740-765` (#904a `boIsLocked`: "the B&O is not a tradeable company until the auction concludes" — "cannot be parred, bought or sold") |

**Superseded wording (not a contradiction).** "Immediately before Stock Round 3" (the first build) is explicitly
corrected by #905; it survives only in stale comments (listed in §24) and one test name
(`stockTransactionAuthority.test.ts:619`).
The lobby blurb "the start of Phase 3" (`gameVariants.ts:283`, owner-supplied verbatim per #1168) is copy, not a rule,
and is imprecise against A2 (DA-F8a).

**Other binding rulings that touch the variant.** S8-7 / owner ruling Q2 (2026-09-15): the delayed SR1 is the first
Stock Round; the Stock Round after the auction is ordinary (`RULES_HARDENING_BACKLOG.md:971-981`). D-16 (own-bid
raise), D-21 (SV-only markdown), D-26 (the C&A share and the B&O certificate are issued at the initial purchase only).

**Mechanical consequences of A1–A3 plus the rulebook (classified without asking).**
- Phase 2's rules (yellow tiles, 4-train limit, 1 OR per set, no private purchase) apply from SR1 even though phase 2
  is printed as "introduced by: privates sold" (Table T-07; 2018 §2.2). There is no phase-1 game time; the auction
  runs in phase 3 or later. The Rules Reference already renders this (`RulesReference.tsx:1545-1559`).
- The OR set in which the first 3-train is bought is a **one-OR set**: its length is locked when it opens in phase 2
  (`sandboxSession.ts:495-497`, "a 3-train bought mid-cycle must not turn a one-round Yellow cycle into a two-round
  Green one"; 2018 §2.3 "2 operating rounds … starting after the stock round following the purchase of a 3-train").
- The auction occupies a macro-round slot: the Stock Round that follows it is SR N+1 where N is the set of the first
  3-train (SR3 in the fastest game) (`sandboxSession.ts:4689-4693`).
- Private revenue is paid "to its owner" (2018 §6.0); an unsold private has no owner and pays nothing.
- Corporations buy privates from players (2018 §3.1); an unsold private cannot be bought by a corporation.
- If no 3-train is ever bought the auction never happens (acknowledged at `sandboxSession.ts:4712-4714`).

---

## 3. Relevant base-rulebook rules (as supported by the sources)

| Rule | 2018 § (quoted) | 48-page ref |
|---|---|---|
| First buy-bid-turn is the Priority Deal holder; clockwise | §1.2 "Beginning with the player with the priority deal card and proceeding clockwise, each player takes a buy-bid-turn." | C-2.2 |
| Options: pass / pay face for the lowest-face unsold private / bid on an unsold private **other than the lowest** | §1.2 | C-2.2 (older wording "another as yet unsold private") |
| A face-value buyer's left neighbour gets the Priority Deal | §1.2 "The player to your left gets the priority deal card." | C-2.2 |
| Minimum bid: face or standing bid + $5, whole dollars | §1.2.1 | C-2.2 |
| Bid money set aside, unusable until ownership is resolved; any number of players may bid on one company; a player may hold bids on several companies (worked example: Gerald bids on CA and DH) | §1.2.1 + example | C-2.2 + example |
| Lowest-face private with ≥1 bid pauses the sequence; one bidder buys at his bid; several → auction among bidders only, starting at the highest bid, +$5, lowest bidder first, clockwise, "may pass and still bid later", ends when all bidders pass consecutively | §1.2.2 | C-2.2 |
| **The Priority Deal does not change hands after an auction**; the sequence resumes with the PD holder **only if the next company has no bid** (cascade) | §1.2.2 | C-2.2 (example) |
| All pass, SV unsold → SV −$5; at $0 the next player must take it (treated as a purchase) | §1.2.3 | C-2.2 |
| All pass, SV sold → every bought private pays revenue; resume with the PD holder | §1.2.3 | C-2.2 |
| When all privates are bought a Stock Round begins | §1.2 | C-2.2 |
| Certificates may not be sold in the first Stock Round | §5.1 | 6.1 |
| Private sales between players: any SR "other than the first" | §3.1 | 4.1 |
| Corporations buy privates (from players) from the first 3-train, at ½–2× face, during their OR turn; phases 3–4 | §3.0 / §3.1 / §2.3–2.4 | 4.0 / 4.1, T-07 |
| All privates close with the first 5-train | §2.5 | 3.5 / 4.2 |
| BO private: owner immediately receives the B&O President's Certificate and immediately sets a par (process of buying a president's certificate, unpaid); never sold to a corporation; does not change hands with the presidency; closes on the B&O's first train | §3.0 effects, §5.2 | p. 11 sidebar, 4.2, 6.2 |
| CA private: the initial purchaser immediately receives a 10% PRR share without payment; CA stays open; "The PRR railroad will not be running at this point"; the share cannot be sold until the PRR president's certificate has been bought | §3.0 effects, p. 15 note | p. 11 sidebar, 6.1 note |
| Float at 60% sold from IPO; shares obtained through BO / CA / MH count; capital at the end of the SR in which it floats | §5.3 | 6.3 |
| Change of president when another player **exceeds** the president's holding — "take these steps immediately" | §5.4 | 6.4 |
| Certificate limit includes privates; conform "during the player's next turn in a stock round" | §4.3 | 5.3 |
| Private revenue at the beginning of each OR, to the owner | §6.0 | 7.0 |
| Priority Deal at SR end: left of the last player to buy or sell; unchanged if nobody did | §5.0 | 6.0 |

---

## 4. Current implementation architecture

- **One reducer, one log.** `applySandboxAction` → `applySandboxActionOnBoard` (`sandboxSession.ts:2898-3077`):
  (1) `boardGateRefusal` (holds, then `auctionRefusal` by identity, `3169-3177`); (2) `applyAuctionStep`
  (`2939-2992`: the auction sub-reducer `applySandboxWaterfallAction` `2226-2660`, ledger `transfer` to the Bank,
  owner + `settled_price`, the C&A grant, the all-pass revenue); (3) chart step + core arms; (4)
  `settleAuctionLifecycle` (`2995-3020`: close on `OpenStockRound`, re-seat on `SetupGame`, dealt-inactive under the
  variant, **arm** when the round is `WaterfallAuction`, privates remain and the auction is owed).
- **The auction atom rides on the state** (`state.waterfall`, #1340): `privates[{private_id, name, face_value,
  is_lowest_offered, bids[{bidder, bid_amount}]}]`, `current_turn` (the atom's cursor), `consecutive_waterfall_passes`,
  `mini_auction{private_id, bidders, high_bid, high_bidder, current_turn, passes_since_raise}`,
  `waterfall_auction_active`. Board fields: `current_round_type`, `macro_round_number`, `active_player_index` (the
  seat), `priority_deal_index`, `private_auction_complete`, `private_companies[].owner / settled_price / closed`,
  `player_cash`.
- **Authority modules.** `auctionAuthority.ts` (one predicate per auction message, asked by reducer and ingress);
  `auctionEscrow.ts` (escrow derived from the bid list); `turnAuthority.ts` (seat identity via `actingAddress`,
  room-message owner rules for `OpenStockRound` / `SetBoPar`); `gameVariants.ts` (`boIsLocked`,
  `DELAYED_AUCTION_TRIGGER_TIER`); `sharePurchase.ts` (#904a lock, first rule); `stockTransactionAuthority.ts`
  (`isFirstStockRound`, sale rule 3); `privateTradeAuthority.ts` (first-SR private trades); `privateExchange.ts`
  (C&A / M&H share grants); `presidencyTransfer.ts` (`settlePresidencies`); `floatThreshold.ts`.
- **Server.** `server/src/gameServer.ts` → `RoomSession.submit` (`frontend/src/utils/roomSession.ts:348-571`:
  build/version checks, nonce + stale-index catch-up, `turnRefusal`, `normalizeForCommit`, append, `engine.submit`,
  refusal detected by content and the entry popped) → `RoomEngine.apply` (`replayLog.ts:542-552`). The stored log
  (`{index, id, actor, payload, …}`) is the only source of truth; restore and `RevertTo` rebuild from the seed by
  replaying `effectiveActions(log)` (`roomSession.ts:212-272`, `511-521`; `logRevert.ts:81-113`). #1281's
  server-side all-pass payout is gone — the payout is in the reducer (`sandboxSession.ts:2988-2990`).

---

## 5. Transition timing trace (the primary target)

| Step | What happens | Code |
|---|---|---|
| Purchase of the first 3-train | phase 3 immediately (`applyPhaseChange`); train limit 4, green tiles; private purchase "allowed" but no private is owned | `sandboxSession.ts:~1300-1360`; `gamePhase.ts` `derivePhase` |
| Remainder of the current OR | later corporations operate in share-value order, may lay green, may buy more 3-trains (and 4-trains, phase 4); a `BuyPrivateCompany` for an unsold private is refused (`moneyConservation.test.ts:385`); the UI still offers the button (DA-F8k) | core arms; `operatingSubPhase.ts:100-143` |
| Remainder of the OR set | none — the set is a locked one-OR set | `sandboxSession.ts:495-497` |
| End of set | `advanceCorporation` raises `operating_round_just_ended` only when `sub_round_index ≥` the locked length (`491-535`); the seat is left on the last operating president (`operatingOrder.ts:211-221`) | |
| End-of-set processing, in order | (1) UR fog due at this boundary falls first and re-enters (`4667`); (2) bank broken → `GameEnd` (`4668-4674`) — **no auction**; (3) **delayed branch** (`4715-4729`): variant on, auction owed, tier ≥ "3" → `current_round_type: "WaterfallAuction"`, `macro_round_number + 1`, `sub_round_index 0`, `consecutive_passes 0` — **seat, Priority Deal and the atom's cursor are not touched**; (4) otherwise the ordinary SR opening (`#909` reset seats the PD holder) | `sandboxSession.ts:4657-4750` |
| Arming | same entry: `settleAuctionLifecycle` sets `waterfall_auction_active: true` if privates remain; **no re-seat** — the cursor is still the dealt seat 0 from `SetupGame` (`gameSetup.ts:763`) | `sandboxSession.ts:3010-3018` |
| Delayed auction | Waterfall* messages; `actingAddress` reads the atom's cursor in this round (`gameState.ts:944-980`) | |
| Handoff | `OpenStockRound`: ingress requires round = auction and 0 unsold (`turnAuthority.ts:552-559`, anyone may send); reducer sets `StockRound`, `private_auction_complete: true` (**the B&O unlocks here**), `priority_deal_index := active_player_index`, `openingStockRoundReset` (`sandboxSession.ts:4970-5019`) | |
| Next round | SR N+1 (B&O tradeable; first-SR rules do not apply; private trades allowed); then 2-OR sets (phase 3) | |

**Answers the brief asks for.**
- **Exact trigger:** tier ≥ 3 at the end of a set, variant on, `private_auction_complete !== true`. The "no flag"
  design (#905) is sound: the phase reaches 3 only by a 3-train purchase, and the completion flag makes it one-shot.
- **Idempotent / can it fire twice:** no second firing — `private_auction_complete` is written only by `SetupGame`
  (false) and `OpenStockRound` (true) (`4935`, `5015`); inside the auction round no set can end. Tested on hand-built
  boards (`variantRules.test.ts:230`). **PASS.**
- **Can it be skipped or manufactured:** the flip is a pure consequence of the OR `PassTurn` (player-sent or
  server-derived, `derivedActions.ts:321-328`); a forged `OpenStockRound` outside the auction is refused at ingress
  and a no-op in the reducer. **But the auction's contents can be pre-empted** before the trigger through DA-F1
  (privates bought, bids placed, the SV marked down in SR1 — probe P2/P4). **BUG (DA-F1).**
- **First 3-train by the last vs an earlier corporation:** identical — the trigger reads the phase at set end.
  **Later 3-/4-train purchases in the same set:** still fires (tier ≥ 3; `variantRules.test.ts:258`). **PASS.**
- **Reconnect at the boundary:** `hello` → `catchUp(baseIndex)` returns log entries; the client replays them; no
  snapshot. **PASS.**
- **Replay / undo across the boundary:** rebuild from the seed; reverting before the 3-train removes the auction;
  reverting into it rebuilds the atom and its escrow from the remaining entries; `OpenStockRound` is never derived
  and must be re-sent. **PASS by construction; MISSING TEST (DA).**
- **Simultaneous conflicts:** bank break in the trigger set → `GameEnd`, no auction (rulebook-consistent: the game
  ends when the set ends). Bankruptcy is immediate (App arm) and precedes. UR fog falls first (UR-3 ruling). The first
  5-train inside the trigger set closes the privates but the atom still offers them — **BUG (DA-F9, LOW)**.

---

## 6. Auction state-machine trace

**Per-command path** (every command: ingress = `gameServer.ts:1259-1303` shape + identity → `RoomSession.submit` →
`turnRefusal`; mutation in the reducer; transport = `applied{entries,digest}` to the submitter, entries + digest
broadcast; log = the canonical message; restore / undo = rebuild from the log).

| Command | Refusal / legality (both locks) | Canonical mutation | Notes |
|---|---|---|---|
| `WaterfallBuyLowest` | `waterfallBuyRefusal` (`auctionAuthority.ts:120-148`): no live contest; a lowest private exists; the **atom's cursor** can pay face net of escrow | `sandboxSession.ts:2326-2355`: remove the lowest, cascade lone bids / open a contest, cursor +1, pass streak 0; charges to Bank; owner + settled price; C&A grant; core `advanceSeat` | PD moves implicitly by rotation |
| `WaterfallBidHigher` | `waterfallBidRefusal` (`151-188`): no contest; target exists and **is not the lowest** (2018 option 3); whole dollars; ≥ standing + $5; escrow-aware incl. own-bid raise (D-16) | `2357-2427`: replace the player's bid, cursor +1, streak 0; **no cash moves** (escrow derived) | |
| `WaterfallPass` | `waterfallPassRefusal` (`191-196`): no contest | `2429-2541`: streak +1; whole table → SV −$5 (only the SV, D-21) or $0 taking; SV sold → all-pass revenue; core `recordPass` | |
| `WaterfallMiniAuctionRaise` | `miniRaiseRefusal` (`201-240`): contest live; bidder; ≥ high + $5; funds net of own bid | `2543-2586`: new high; `passes_since_raise = 0`; seat untouched | |
| `WaterfallMiniAuctionPass` | `miniPassRefusal` (`243-258`): contest live; bidder | `2588-2658`: passes +1; at `bidders − 1` the high bidder wins at his high bid; cascade; main cursor preserved | M1 fix (S7-3) |
| `SetBoPar` | ingress owner rule only when an owner exists (`turnAuthority.ts:561-567`); reducer: par ladder (`3858-3862`) + `boPresidencyRefusal` (`7273-7292`: B&O exists, no president, IPO ≥ 20%) | `grantBOPresidency` (`7294-7346`) | **DA-F2** |
| `OpenStockRound` | ingress: auction round + 0 unsold, anyone (`552-559`); reducer: round only | `4970-5019` (PD from the seat at `5011`) | **DA-F4, DA-F5, DA-F7** |

**Rule-by-rule result against §3.** Lowest is buy-only — PASS. Bid minimum / whole dollars — PASS. Escrow — PASS (§7).
Bids on several companies — PASS (escrow sums across privates; `auctionAuthority.test.ts:204, 220, 473`). Cascade on
the lowest first, lone bid auto-award, 2+ bids open a contest — PASS (`cascade`, `2259-2324`; JUNO-G6J golden).
Contest: bidders only, starts at the high bid, +$5, lowest bidder first (`byAscendingBid`), pass-and-still-in, ends
at `bidders − 1` passes since the last raise, high bidder pays his high bid, losers pay nothing — PASS (S7-3,
`auctionAuthority.test.ts:390-431`). Main rotation frozen during a contest — PASS (S7-15). SV markdown only for the
SV, $0 taking, all-pass revenue only once the SV has sold — PASS (S7-2, D-21). Auction ends when all privates are
bought (`settle`; `OpenStockRound` gate) — PASS.

**Seat / cursor / Priority Deal — three pointers, and where they disagree.**
- The atom's cursor decides who acts in the auction; the seat (`active_player_index`) is a mirror that advances by one
  per main-rotation action (`advanceSeat` / `recordPass`); `OpenStockRound` takes the Priority Deal from the **seat**.
- Standard game: both start at dealt seat 0 = the PD holder (`priority_deal_index: 0`, `4950`), so the mirror holds
  — except that the $0-SV branch moves the cursor two seats (`2463`, `2475`) and the seat one (**DA-F5**).
- Delayed game: the cursor is still dealt seat 0; the seat is the last operating president; the PD holder is whoever
  earned it in the last Stock Round. Nothing reconciles them (**DA-F3, DA-F4**).

**Probes executed (container clone of `8d42d68`, temporary files deleted; nothing added to the repository).**

| Probe | Setup | Observed | Finding |
|---|---|---|---|
| P1 | 3-player delayed deal | SR1, macro 1, `private_auction_complete` false, atom inactive with 6 privates, cursor = seat A | A1 PASS |
| P2 | A passes twice (seat → B, cursor stays A); **B** sends `WaterfallBuyLowest` in SR1 | ingress `null`; SV owner **A**; **A charged $20**, B unchanged | DA-F1 |
| P3 | C sends `SetBoPar{player: C, par 100}` in SR1, BO private unowned | ingress `null`; **C is B&O president at par 100, 20%**, `private_auction_complete` false | DA-F2 |
| P4 | three `WaterfallPass` in a fresh delayed SR1 | all accepted; **SV face 20 → 15** in SR1 (and the three passes ended SR1) | DA-F1 |
| P5 | standard game, auction finished, SR1: three `WaterfallPass` | all accepted; **an extra round of private income paid** (A +50, B +70, C +90 = 2× each owner's income: the forged all-pass plus the legitimate OR1 payout) | DA-F1 (Classic) |
| Q1 | delayed set end with a 3-train; PD holder **B**, last president **C** | auction armed; **acting player A** (not B); after six face-value buys (A,B,C,A,B,C) `OpenStockRound` gives the **PD to C, the last buyer himself** | DA-F3, DA-F4 |
| Q2 | C&A bought in a delayed auction with PRR IPO 0% / pool 0% | grantee 40 → 50%; **PRR totals 110%**; president (20%) unchanged | DA-F6 |
| Q3 | C&A grant takes PRR from 50% to 60% sold; grantee 30 → 40% > president 20% | **not floated; president not transferred** | DA-F6 |
| R1 | **standard game**: 12 passes walk the SV to $0 (taken by A); then B, C, A, B, C buy | cursor B but seat A after the taking (desync); `OpenStockRound` gives the **PD to C, the last buyer** — left of him is A | DA-F5 |
| R2 | **standard game**: all six bought, **no `SetBoPar`**, `OpenStockRound` sent; A (not the BO owner C) buys the B&O President's Certificate at par 100 in SR1 | handoff accepted; **A becomes B&O president**; C's later `SetBoPar` passes ingress and is refused by the reducer (in a room the submitter gets the collision sentence, `refusedAction.ts:313`) | DA-F7 |

---

## 7. Escrow / cash authority (S10-18(B))

- **Model.** Escrow is derived, not stored: `escrowedBids = Σ standing bids on still-unsold privates`,
  `available = max(0, cash − escrow)` (`auctionEscrow.ts:24-35, 96-153`). Bidding moves no money; only a resolution
  charges, through the ledger's `transfer(player → BANK)` (`sandboxSession.ts:2959-2963`), all-or-nothing.
- **Committed cash unavailable for other bids / purchases:** yes for every auction action (buy, bid, raise), including
  the own-bid increment rule (D-16). During the auction round share purchases are refused
  (`stockTransactionAuthority.ts:400-403`), so no other cash use exists. **PASS.**
- **Multiple simultaneous bids:** summed. **Raises after prior commitments:** checked net of the raiser's own standing
  bid. **Losing funds restored exactly once:** nothing is ever taken from a loser, so nothing can be returned twice.
  **Winner settlement:** charged once at resolution (`auctionAuthority.test.ts:390-431`). **PASS.**
- **Malformed / duplicate / stale requests:** schema requires integer bids; whole dollars re-checked; duplicate
  submission ids and stale base indices get a catch-up, not a second application (`roomSession.ts:405-419`). **PASS.**
- **Replay / undo / reconnect:** escrow is a pure function of the atom, which is rebuilt from the log. **PASS.**
- **The one hole is DA-F1:** before the trigger (and in any Stock or Operating Round) a forged `WaterfallBidHigher`
  places a bid in the **atom cursor's** name — escrow on another player's cash, outside the auction, where share and
  train purchases do not read escrow. The DA-F1 round gate closes it; no escrow change is needed.
- **S10-18(B) is covered at the reducer for the standard game** (`auctionAuthority.test.ts:194-325, 442-496`); the
  ledger line claiming no machine-level test is stale. Residual: one delayed-auction escrow assertion in the
  certification game (DA-T4) and the server path (DA-T12).

---

## 8. First Stock Round

- **Sale restriction (M7 / S8-7):** `isFirstStockRound = StockRound && macro_round_number === 1`
  (`stockTransactionAuthority.ts:496-503`, rule 3 at `535`); the delayed SR1 is macro 1 → refused; the SR after the
  auction is macro N+1 → ordinary. Matches owner ruling Q2. Reducer-tested for the delayed board
  (`stockTransactionAuthority.test.ts:619-630`). **PASS; MISSING TEST** for the ingress lock on a delayed board and
  for a real run into the post-auction SR (DA-T1).
- **Private trades between players** use the same predicate (`privateTradeAuthority.ts:65`): none can exist in SR1;
  allowed in the post-auction SR ("other than the first"). Same reading as Q2. **PASS.**
- **Buying / par:** ordinary for every corporation except the B&O (locked, §9). **PASS.**
- **Priority Deal:** SR1 opens at `priority_deal_index 0` (`4950`) — the dealt starting player, as C-2.1 prescribes
  (random seats, "the player with the '1' marker … takes the priority deal card"). **PASS.**
- **Auction messages in SR1** are accepted (DA-F1).

---

## 9. B&O

| Surface | Before the delayed auction | Evidence | Status |
|---|---|---|---|
| Par through `BuyStock` of the President's Certificate | refused, `BO_LOCKED_REASON` first | `sharePurchase.ts:107-116` | PASS |
| Ordinary IPO purchase | refused (same rule) | same; `variantRules.test.ts:91` (predicate-level) | PASS; MISSING TEST at reducer + ingress (DA-T2) |
| Bank Pool purchase | unreachable (nobody can hold B&O to sell) | — | PASS |
| Sale / presidency transfer | unreachable (no holdings) | — | PASS |
| **`SetBoPar`** | **accepted from any player while the BO private is unowned** — ingress owner rule skipped, reducer never asks ownership or `boIsLocked` | `turnAuthority.ts:561-567`; `sandboxSession.ts:5021-5034`, `7273-7292`; probe P3 | **BUG DA-F2** |
| Setup / debug | `SetupGame` after the deal refused at ingress (`turnAuthority.ts:547`); no debug message grants shares | | PASS |
| Replay | the lock is `boIsLocked(variants, private_auction_complete)`, derived | `gameVariants.ts:756-765` | PASS |

**Lifecycle after the auction.** The BO winner's client sends `SetBoPar` (App-raised prompt, `App.tsx:7020`,
`9486-9505`); `grantBOPresidency` gives 20% free with a par and does not float (`boFloatRule.test.ts:89-125`). The IPO
necessarily still holds 100% because of the lock, so the "invented shares" refusal (`7285-7289`) cannot bite on a
legitimate path. **But nothing requires the par before `OpenStockRound`, and nothing reserves the President's
Certificate for the BO owner once the B&O unlocks (DA-F7)** — the "par before handoff" rule lives only in the modal
(`AuctionPromptModal.tsx:56, 117-137`; `App.tsx:13464-13480`). Float (60% incl. the 20% grant), presidency changes and
"the BO private does not change hands with the presidency" (`isSellableToCorporation`, `settleBaoPrivate`) and closure
on the B&O's first train (`baltimorePrivate.test.ts:181`) are the standard machinery and apply unchanged. The lock
lifts at `OpenStockRound`, i.e. when the auction concludes — exactly anchor A3 and `BO_LOCKED_REASON`.

---

## 10. Camden & Amboy and other private-company effects

**C&A.** The grant runs inside `applyAuctionStep` for every C&A win (`sandboxSession.ts:2972-2985`):
`source: ipo ≥ 10 ? "Ipo" : "Bank"`, then `applyPrivateExchange(keepOpen)` (`privateExchange.ts:152-200`).
- Duplicate creation / wrong source: **when the PRR IPO holds < 10% the pool is used without checking it holds 10%;
  both piles are floored at 0, so a share is created** (probe Q2: 110%). In the standard game the IPO always holds
  the share (PRR is unparred at the auction), so this is DA-only. **BUG DA-F6**; *which* pile, if any, should supply
  the share is **OD-DA-1**.
- Presidency side effects: the grant can make the grantee exceed a sitting PRR president (PRR may be parred and running
  under the variant). §5.4 requires an immediate change; `settlePresidencies` runs only after `BuyStock`, `SellStock`
  and the M&H exchange (`sandboxSession.ts:5612, 5728`; `mohawkExchange.ts:465`). It scans every corporation, so the
  change happens **late** — at the next share purchase or sale of any corporation in SR N+1 — not at the grant. Probe
  Q2/Q3: no transfer at the grant. **BUG DA-F6.**
- Float: shares obtained through the CA count toward 60% (§5.3); `applyFloatThreshold` runs only in `BuyStock` and the
  M&H exchange (`5573`; `mohawkExchange.ts:462`), again for every corporation. Probe Q3: PRR at 60% sold stays unfloated
  until some later `BuyStock`; if nobody buys in SR N+1, PRR enters the OR set unfloated. **BUG DA-F6.**
- The C&A path also skips the 60% cap the M&H exchange applies (`privateExchange.ts:106-117`) — see OD-DA-2.
- Certificate limits: the grant can push the grantee over the certificate limit or 60%. The divestment debt
  (`forcedDivestment.ts`) is recomputed from the board and bites at the player's next Stock Round turn — the §4.3
  "conform during the next turn" reading. Whether that is the intended rule for the delayed auction is **OD-DA-2**.
- Timing: at the moment of the win, inside the auction — correct. "The share cannot be sold until the PRR president's
  certificate has been bought" is enforced (`stockSaleRefusal` rule 4); under the variant PRR may already be parred, in
  which case the share is sellable in the post-auction SR. PASS.
- "The PRR railroad will not be running at this point" is false under the variant; that sentence is copy
  (`privateCatalog.ts:230`, DA-F8i), not a rule.

**Private revenue before the auction.** `applyPrivateRevenue` pays owners only; an unsold private pays nothing
(`privateRevenue.test.ts:157`). The all-pass revenue inside the auction pays owners of privates already sold. **PASS**
(mechanical; §2).

**Private-company location hexes before the auction.** The Stage 10.6 restriction (owner ruling S6-7, 2018 §6.2.1(4))
bars a hex holding a private **owned by a player**; an unsold private restricts nothing
(`privateReservations.ts:296-303`; `stage106LayTileClosure.test.ts:531`). The code itself notes that in the standard
game "no tile is laid before the auction has sold everything" — the delayed variant creates Operating Rounds with
unsold privates for the first time. Pre-auction lays on G15, B20, D18, H18, I13/I15 (and a lay on F16 that forfeits
the D&H's power before it is sold) are allowed today. **OD-DA-3.** (This also answers S8-5's standing request to
re-check the Delayed-Auction path: the B&O home obligation arises at its first OR turn, which cannot precede the
auction; the only delayed-specific interaction is this hex question.)

---

## 11. Phase / train / private timing and corporate purchase

- **Before the auction** no corporation can buy a private: `BuyPrivateCompany` needs a player owner
  (`moneyConservation.test.ts:385`), consistent with §3.1 (corporations buy from players). **PASS.** The OR action bar
  nevertheless shows "Buy Private Company" from the first 3-train until the auction (DA-F8k).
- **After the auction** the next ORs are phase ≥ 3: corporations may buy immediately, ½–2× face, with consent
  (`offerMatrix74PrivatePurchase.test.ts:99-102, 196-303`). **PASS by construction; MISSING TEST (DA-T8).**
- **First 5-train** closes all privates (`applyPhaseChange`, `sandboxSession.ts:1349-1356`); the BO private closes on
  the B&O's first train. **PASS** — except the edge where the first 5-train arrives inside the trigger set (DA-F9).
- **No hidden temporal contradiction** was found beyond DA-F9 and the three owner decisions. The OR-count rule,
  phase-2-from-SR1 and the SR N+1 numbering are consistent (§2).

---

## 12. Replay / restore / undo / version

- Restore and undo rebuild from the seed by replaying the effective log; no authoritative field is restored from a
  snapshot (`roomSession.ts:212-272, 511-521`). Every delayed-auction fact (trigger, arming, escrow,
  `private_auction_complete`, the lock, the phase) is re-derived. **PASS by construction.**
- `RULES_ENGINE_VERSION` is 10 and gates no delayed-auction behaviour; the changelog (`rulesVersion.ts:72-312`) has
  no delayed-auction entry; `SetupGame` is stamped at commit (`serverIngress.ts:77-80`). The only auction pin check is
  `legacyBidRefusal`.
- **Stored logs:** no fixture, golden or corpus log in the repository has `delayedAuction: true` (10 files carry the
  field, all `false`; the four stored logs are unpinned legacy logs). Live room logs (`DATA_DIR`, default `./data`)
  are not in the repository — whether real delayed-auction rooms exist cannot be determined here.
- **Semantics since v10:** unchanged — DA-1 changed no code.
- **Would the fixes be replay-semantic?** Yes: DA-F3/F4 change who acts and who holds the PD in any delayed log;
  DA-F6 changes holdings / presidency / float in delayed logs; DA-F5 changes SR1's PD in any standard log with a
  $0 SV taking; DA-F1/F2/F7 are refusal-added (no legitimate client sends those messages; a corpus sweep must confirm
  none is stored). See §23.

---

## 13. Server / room authority

- Identity comes from the connection, shape from `messageSchema.ts`, seat from `turnRefusal`, legality from the same
  predicates the reducer asks; refusals are detected by content and the entry is popped; the store append is
  fsync'd before anyone is answered (`gameServer.ts:1259-1384`; `roomSession.ts:348-571`). **PASS.**
- `refusalReasonFor` has no arm for auction messages (generic sentence for a reducer-level auction refusal); ingress
  asks `auctionRefusal` first and returns its sentence, so this only matters for a message that passes ingress and is
  refused later. Cosmetic.
- **Presentation state deciding legality (all UI-only today):** round-gating of auction actions (the dashboard mounts
  only in the auction round — DA-F1); "par before handoff" (DA-F7); who is prompted to par (client-derived,
  `auctionTransition.ts:58-68`); handoff timing (client-initiated `OpenStockRound`; the server never derives it).
  The authority boundary (`AUDIT_RULES_TO_MACHINE` preamble) makes each of these a server-accepted action.

---

## 14. UI / copy (recorded for a later pass — nothing changed here)

| ID | Surface (file:line) | Current text / behaviour | Verdict |
|---|---|---|---|
| DA-F8a | `gameVariants.ts:283` (Lobby `Lobby.tsx:1430-1431`, Waiting Room `SandboxWaitingRoom.tsx:250-251`, Host setup `HostSetupCard.tsx:487`) | "Delays the private company auction and B&O open to the start of Phase 3. …" — owner-supplied verbatim (#1168, whose rationale "is the definition of Phase 3" is wrong) | STALE COPY — replacement wording decided *(rev 2: D-56, §19)* |
| DA-F8b | `AuctionPromptModal.tsx:113-114, 133, 136` | "Stock Round 1 opens next …", "open Stock Round 1", "Proceed to Stock Round 1 ›" shown at the end of every auction | STALE (hard-coded SR1) |
| DA-F8c | `ContextualSubPanel.tsx:155, 158-159` | "Pre-Game Waterfall Auction"; "… before Stock Round 1 opens" | ASSUMES PRE-GAME AUCTION |
| DA-F8d | `WaterfallAuctionDashboard.tsx:259` | "Pre-game private company waterfall" | ASSUMES PRE-GAME AUCTION |
| DA-F8e | `RulesReference.tsx:3250` (Overview "This round" lead, from `1186`) | "Before the first Stock Round, the Private Companies are sold …" with no variant branch (the Auction page has one, `4765-4771`) | ASSUMES PRE-GAME AUCTION |
| DA-F8f | `RulesReference.tsx:3092` (Overview "Current phase") | Phase 2 reads "All private companies purchased" under the variant; the Tables page's override ("Start of the game", `1559`) is not read | ASSUMES PRE-GAME AUCTION |
| DA-F8g | `RulesReference.tsx:2700-2745` | game-flow chain draws Auction → Stock Round; only the "Delayed" state word differs | IMPRECISE |
| DA-F8h | `TutorialModal.tsx:144-146, 156-160, 420` (and 136, 242, 254-255) | "Now that the Private Company auction is complete …" opens on the delayed SR1; "You start this Auction with … $600 …"; "before the game proper starts" | ASSUMES PRE-GAME AUCTION |
| DA-F8i | `privateCatalog.ts:230` (rendered by `SpecialPowerBlock`, auction cards, player cards, StockRoundPanel, PrivateTradePanel, PrivateCompanyPills) | "The PRR will not be operating yet …" | ASSUMES PRE-GAME AUCTION |
| DA-F8j | `gameVariants.ts:791` `BO_LOCKED_CARD_NOTE` (`StockRoundPanel.tsx:1450-1453, 2219`) | "Inactive until the BO private company is purchased in the Auction Round." — the lock lifts at auction end, not at the BO purchase; pinned verbatim by `polishWave5.test.ts:216-220` | IMPRECISE |
| DA-F8k | `ContextualActionBar.tsx:3335-3358` via `privatesBuyableNow` (`operatingSubPhase.ts:136-143`) | "Buy Private Company" offered after the first 3-train while every private is unsold | FALSE AFFORDANCE (the reducer refuses) |
| DA-F8l | `PrivateTradePanel.tsx:93, 280-281, 413` | "still unsold in the auction" before the auction has run | IMPRECISE |
| DA-F8m | Activity Log: no line announces the delayed auction opening at the set boundary; `App.tsx:8681-8720` round-change lines have no auction branch (not reached in rooms); deal line (`6608-6611`) says nothing about the delayed start; no purchase warning that the next 3-train schedules the auction | GAP |
| DA-F8n | Variant name drift: "Delayed private auction (harder)" / "Delayed Auction" / "Delayed auction" (`gameVariants.ts:281`, `HostSetupCard.tsx:74`, `LobbyRoomList.tsx:50`, `RulesReference.tsx:113`) | INCONSISTENT |

Accurate and to keep: `BO_LOCKED_REASON`; the Rules Reference variant note (`1188-1191`), Auction-page variant
branches, phase-table overrides, private-status cell ("Not yet in play / Delayed Auction pending"), live-phase logic
(phase 1 never current under the variant); the Activity Log's handoff line (`actionLog.ts:504-512`, computed SR
number); `roundLabel.ts`. Tests that pin strings a copy pass will touch: `variantCopy.test.ts:119-124, 167-187`,
`polishWave5.test.ts:216-233`, `rulesAuction.test.tsx:233-249, 296-316`, `rulesOverview.test.tsx:297-307, 406-435`,
`rulesTables.test.tsx:282-314`, `shellNarration.test.ts:73-86`; global guard `appNaming.test.ts:117-131`.

---

## 15. Standard-game controls (risk of each fix to Classic)

| Finding | Classic exposure today | Risk of the fix to the standard game | Guard required |
|---|---|---|---|
| DA-F1 | forged `WaterfallPass` after the auction pays extra private income and counts as a Stock Round pass even after the player acted (probe P5) | the gate must admit every legitimate standard-auction message (round `WaterfallAuction`, from the deal until `OpenStockRound`) | standard auction replay goldens (CV4, G6J, FCJ) byte-equal; corpus sweep for Waterfall* outside the auction |
| DA-F2 | during the standard auction, any player can take the B&O President's Certificate before the BO private sells | `turnAuthority.test.ts:333` and `parMarkArrival.test.ts:134-152` pin the permissive behaviour and must be changed deliberately | goldens with `SetBoPar` (CV4, FCJ-96) unchanged |
| DA-F3 | none (standard cursor = seat 0 = PD holder at the deal) | none if the re-seat applies only to the delayed arming | standard deal tests `auctionSeating.test.ts:128-147` |
| DA-F4 / DA-F5 | SR1 PD off by one after a $0 SV taking — **legitimate play** (probe R1) | changing how the PD is derived must reproduce #1235's results on every standard log without a $0 taking | `auctionSeating.test.ts:325-343`; corpus sweep for $0 takings |
| DA-F6 | none (IPO always full at the standard auction) | none if the grant path is shared; the settle calls are no-ops on standard boards | `privateExchange.test.ts:217`; goldens with a C&A win |
| DA-F7 | a forged / early `OpenStockRound` lets another player par the B&O in SR1 before the winner does | legitimate clients already par first; refusal-added | goldens: both stored logs par first (CV4 idx 12 `SetBoPar`, 13 `OpenStockRound`; FCJ-96 idx 9, 10) |
| DA-F8 | copy only | standard strings must stay as they are | the standard-branch copy tests listed in §14 |
| DA-F9 | none | none | — |

Note for DA-F7: both stored standard logs that reach the handoff send `SetBoPar` before `OpenStockRound` (JUNO-CV4
idx 12 → 13; JUNO-FCJ-prefix96 idx 9 → 10; FCJ-96's later `OpenStockRound` entries at idx 12 and 14 fall outside the
auction round and are no-ops). A "par before handoff" gate is therefore refusal-added with no stored-log effect in the
repository corpus; the live `DATA_DIR` sweep must still confirm it. The alternative shape — refuse a `BuyStock` of the
B&O President's Certificate by anyone but the BO owner while the par is owed — is equally available.

---

## 16. Variant composition (structural, not combinatorial)

| Intersection | Gentle Rust | Unpredictable Revenue | GR + UR | Risk |
|---|---|---|---|---|
| First-3 timing / phase transition | rust marks at phase changes in the trigger set do not affect `derivePhase` (ghost trains skipped, `gamePhase.ts:708-740`) | none | none | LOW |
| OR-set boundary | none | the fog due at the set end falls **before** the delayed exit, by ruling (`sandboxSession.ts:4657-4667`) | same | LOW — untested with the variant (DA-T10) |
| Train purchase after the trigger | grace trains unaffected | none | none | LOW |
| Auction insertion / private ownership / SR transition | none | none | none | NONE found |
| Replay / version stamping | one engine version; no per-variant pin | same | same | NONE (see §23) |

Also noted: under the Level Playing Field the JK ($120) joins the delayed auction and its K9/K11 location falls under
OD-DA-3.

---

## 17. Prior backlog routing — dispositions

| Item | Current definition (ledger) | DA-1 disposition |
|---|---|---|
| **S9-7** | Delayed Auction `DEFERRED — PRE-LAUNCH VARIANT CERTIFICATION REQUIRED` (`RULES_HARDENING_BACKLOG.md:1810-2164`) | **Still DEFERRED; DA-1 audit complete; NOT certified.** New findings DA-F1 … DA-F11 and OD-DA-1 … 3 recorded. |
| **S10-6 (A)** | mine `src/tests.rs` for auction-interrupt cases (`3425-3431`, routing `3269`) | **Mined by DA-1.** Rust has 13 auction tests; interrupt cases: single-bid cascade (`tests.rs:10216`), contest (`10315`), SV markdown (`10465`), all-pass revenue (`17070`), $0 forced taking (`17150`). TS equivalents exist for the contest, the all-pass revenue and (partially) the markdown and $0 taking; **no dedicated TS test** for the lone-bid cascade, a cascade resolving several companies, a $0 taking followed by a cascade, a contest cascading into a contest, or the PD after an auction ending in a cascade / contest (Rust uses "left of the last winner", `waterfall.rs:461-482`; TS "left of the last actor", #1235 — neither is §1.2's rule exactly, see DA-F4/F5). Rust has no delayed auction. The resulting tests are DA-T6/DA-T7; (B) stays with the Phase-4 Rust retirement preflight. |
| **S10-18 (B)** | reducer auction-escrow coverage (`3637-3648`, routing `3289`) | Covered at the reducer for the standard game since Batch 7.3 (`auctionAuthority.test.ts:194-325, 442-496`); the "no machine-level test" wording is stale. Residual: DA-context and server-path assertions (DA-T4, DA-T12). Not closed — it closes with the DA certification tests. |
| **M1** (mini-auction re-entry) | S7-3 `RESOLVED` Batch 7.3 (#1581) | Fixed and certified in the general auction; inherited unchanged by the delayed auction. Not reopened. PASS. |
| **M2** (bid legality / cash) | S7-4 `RESOLVED` Batch 7.3 (#1580) | Fixed; PASS. DA-relevant residue is DA-F1 (bids accepted outside the auction), not a defect in M2's rules. |
| **M7** (first-SR sale restriction) | S8-7 `RESOLVED` Batch 7.2 (#1570), owner ruling Q2 | Fixed; applies to the true SR1 only, as ruled. PASS; ingress / real-run test gap DA-T1 (overlaps S10-18(A)). |
| S7-2 / S8-7 "name Delayed-Auction cases" | `2164` | S7-2's delayed re-check: the delayed auction runs the same atom and rule — PASS. S8-7: above. |
| S8-5 "re-check the Delayed-Auction path" | `915` | Done by reading (§10): no delayed-specific home-token path; the related question is OD-DA-3. |

---

## 18. Findings table

**Requirement trace** (status vocabulary per the brief).

| # | Requirement | Authority | Code path | Current behaviour | Tests | Status |
|---|---|---|---|---|---|---|
| R1 | SR1 opens without the auction | A1 | `sandboxSession.ts:4927-4938` | SR1, macro 1, auction owed, atom dealt inactive | `auctionSeating.test.ts:164` | PASS |
| R2 | Auction after the OR set of the first 3-train | A2 | `4715-4729`; `491-535` | fires at set end, tier ≥ 3, once | `variantRules.test.ts:207-272` (hand-built) | PASS; MISSING TEST (real run, DA-T3) |
| R3 | Trigger cannot fire twice / be manufactured | A2 | `4935`, `5015`; ingress `552-559` | one-shot; pure consequence | `variantRules.test.ts:230` | PASS |
| R4 | Auction contents cannot be touched before the trigger | A1/A2 + §1.2 | `auctionAuthority.ts:281-295`; `applyAuctionStep 2939-2941` | **accepted in SR/OR** | none | **BUG DA-F1** |
| R5 | Auction begins with the PD holder | §1.2; #905 note | `gameSetup.ts:763`; `3010-3018` | begins with dealt seat 0 | none | **BUG DA-F3** |
| R6 | PD after the auction: left of the last face-value buyer; unchanged by bid resolutions | §1.2, §1.2.2 | `4970-5019` (`priority := active_player_index`) | wrong under the variant; off by one after a $0 taking in any game | standard only (`auctionSeating.test.ts:325-343`) | **BUG DA-F4 / DA-F5** |
| R7 | Buy / bid / pass / contest / cascade / SV / all-pass rules | §1.2–1.2.3 | `auctionAuthority.ts`; `2226-2660` | correct | `auctionAuthority.test.ts` (42), `miniAuctionTurn`, `atomicReducer`, goldens | PASS (inherited) |
| R8 | Escrow | §1.2.1 | `auctionEscrow.ts` | derived, correct | `auctionAuthority.test.ts` §2/§3/§5 | PASS; MISSING TEST (DA context) |
| R9 | First-SR sale ban on the true SR1 only | §5.1 + ruling Q2 | `stockTransactionAuthority.ts:496-503, 535` | correct | `stockTransactionAuthority.test.ts:608-630` | PASS; MISSING TEST (ingress / real run) |
| R10 | B&O locked for par / buy / sell | A3 | `sharePurchase.ts:107-116` | refused | `variantRules.test.ts:91-165` (predicate) | PASS; MISSING TEST (reducer + ingress) |
| R11 | B&O locked for `SetBoPar` / par only by the BO owner | A3; §3.0, §5.2 | `turnAuthority.ts:561-567`; `5021-5034`; `7273-7292` | **anyone, while unowned** | pinned permissive (`turnAuthority.test.ts:333`) | **BUG DA-F2** |
| R12 | B&O par immediate; certificate reserved for the BO owner | §3.0 "immediately" | UI-only | not enforced | none | **BUG DA-F7** |
| R13 | B&O unlocks when the auction concludes | A3 | `5015` | at `OpenStockRound` | none end-to-end | PASS; MISSING TEST |
| R14 | C&A grant conserves shares | §3.0 | `2972-2985`; `privateExchange.ts:176-183` | **creates a share when piles are short** | none | **BUG DA-F6**; source → OD-DA-1 *(rev 2: decided — reserved certificate, D-52)* |
| R15 | Grant → immediate presidency change; float at 60% | §5.4, §5.3 | no `settlePresidencies` / `applyFloatThreshold` after the grant | **both late** — only at the next `BuyStock` (either) / `SellStock` (presidency) of any corporation | none | **BUG DA-F6** |
| R16 | Private revenue only to owners | §6.0 | `applyPrivateRevenue` | correct | `privateRevenue.test.ts:157` | PASS |
| R17 | No corporate purchase of unsold privates | §3.1 | `BuyPrivateCompany` owner check | refused | `moneyConservation.test.ts:385` | PASS; UI false affordance DA-F8k |
| R18 | Corporate window after the auction (phases 3–4, ½–2×) | §3.1 | offer authority | correct | `offerMatrix74PrivatePurchase.test.ts` | PASS; MISSING TEST (DA) |
| R19 | Privates close with the first 5-train, also unsold ones | §2.5 | `1349-1356` | closed in `private_companies`, **still offered by the atom** | none | **BUG DA-F9 (LOW)** — *(rev 2)* intended behaviour decided (D-55: the delayed auction is cancelled) |
| R20 | Certificate limit / 60% when the auction pushes a player over | §4.3 (silent for this case) | divestment debt | allowed; conform at next SR turn | none | **OWNER DECISION OD-DA-2** — *(rev 2)* decided (D-53; OD-DA-2b → D-57, rev 3) |
| R21 | Private hexes before the auction | §6.2.1(4) + S6-7 / #1694 (recorded reading: an unsold private releases — made on the premise that no tile is laid before the auction) | `privateReservations.ts:296-303` | open | `stage106LayTileClosure.test.ts:531` | **OWNER DECISION OD-DA-3** — *(rev 2)* decided (D-54): current behaviour stands; rationale amended |
| R22 | Bank break in the trigger set → end, no auction | §8 / rulebook end rule | `4668-4674` | GameEnd first | none (DA) | PASS; MISSING TEST |
| R23 | Replay / restore / undo | architecture | rebuild from log | correct by construction | standard only | PASS; MISSING TEST |
| R24 | Server / room parity | architecture | `RoomSession` → reducer | same predicates | standard only | PASS; MISSING TEST |
| R25 | Player-facing copy | A1–A3 | §14 | several stale | pinned strings §14 | **STALE COPY/UI DA-F8** |
| R26 | No 3-train ever → no auction | A2 (mechanical) | `4712-4714` | privates never in play | none | DEFERRED NONBLOCKER (DA-F11: document + short-bank test) |
| R27 | Composition with GR / UR / GR+UR | S9-7 | §16 | no defect found | schema only | PASS; MISSING TEST (DA-T10) |

**Defect list.**

| ID | Severity | Scope | Summary | Evidence |
|---|---|---|---|---|
| **DA-F1** | HIGH | DA (buy / bid / markdown) + Classic (pass) | No round or activity gate on Waterfall* messages: the dormant atom is live in SR1/SR2/ORs; actions apply as the **atom's cursor** (another player); a forged `WaterfallPass` after any auction pays extra private income and counts as an SR pass after acting | `auctionAuthority.ts:281-295`; `sandboxSession.ts:2939-2941, 5430-5432, 5770-5772`; `turnAuthority.ts:357-364, 412-414`; `gameState.ts:915-980`; probes P2, P4, P5 |
| **DA-F2** | HIGH | DA + Classic (auction window) | `SetBoPar` needs neither the BO private's ownership nor `boIsLocked`; any player can take the B&O presidency while the private is unsold (all of SR1 → the auction under the variant) | `turnAuthority.ts:561-567`; `sandboxSession.ts:3854-3862, 5021-5034, 7273-7292`; probe P3 |
| **DA-F3** | HIGH | DA-only | The delayed auction's first actor is dealt seat 0, not the PD holder | `gameSetup.ts:763`; `sandboxSession.ts:3010-3018, 4715-4729`; probe Q1 |
| **DA-F4** | HIGH | DA-only | The PD after the delayed auction comes from the seat pointer, which steps once per main-rotation action but **starts from the last operating president** instead of the auction's first actor (probe: the PD went to the last buyer himself) | `sandboxSession.ts:4970-5019`; `operatingOrder.ts:211-221`; probe Q1 |
| **DA-F5** | MEDIUM | **Classic (legitimate play)** and DA | The $0-SV branch moves the cursor two seats and the seat one; the SR PD after such an auction is the last buyer instead of his left neighbour | `sandboxSession.ts:2463, 2475` vs `547-590`; probe R1 |
| **DA-F6** | HIGH | DA-only | C&A grant: share creation when IPO < 10% and pool < 10%; presidency and float not settled at the grant (only at a later share trade) | `sandboxSession.ts:2972-2985`; `privateExchange.ts:176-183`; probes Q2, Q3 |
| **DA-F7** | MEDIUM | Classic + DA | B&O par not required before the handoff; President's Certificate not reserved for the BO owner once the B&O unlocks | `turnAuthority.ts:552-559`; `sandboxSession.ts:4970-5019`; `sharePurchase.ts:107-116`; UI-only gate; probe R2 |
| **DA-F8** | — | UI | Stale / pre-game-assuming copy and one false affordance (§14, a–n) | §14 |
| **DA-F9** | LOW | DA-only edge | First 5-train inside the trigger set closes the privates, but the atom still offers them | `sandboxSession.ts:1349-1356` vs atom `privates`; code-traced |
| **DA-F10** | — | tests | No end-to-end delayed-auction test, no delayed fixture (§20) | test inventory |
| **DA-F11** | DEFERRED NONBLOCKER | DA | No 3-train ever → auction never happens (acknowledged by #905); document in the Rules Reference and test on a short bank | `sandboxSession.ts:4712-4714` |

**Counts.** Requirement rows: PASS 15 of 27 (ten with a MISSING TEST rider) · BUG 8 rows · OWNER DECISION 2 rows
(R20, R21; OD-DA-1 rides on R14) · STALE COPY/UI 1 row · DEFERRED NONBLOCKER 1 row. Findings: **BUG — 8 defects**
(DA-F1 … DA-F7, DA-F9: five HIGH — F1, F2, F3, F4, F6; two MEDIUM — F5, F7; all seven probe-confirmed; one LOW — F9,
code-traced) · **MISSING TEST — 12** (DA-T1 … T12)
· **STALE COPY/UI — 14 surfaces** (DA-F8a–n) · **OWNER DECISION — 3** (OD-DA-1 … 3) · **DEFERRED NONBLOCKER — 1**
(DA-F11). *(rev 2: every OWNER DECISION above is now decided — §19 — except OD-DA-2b, the residual scope of
OD-DA-2; OD-DA-4 was raised and decided on review.)* *(rev 3: OD-DA-2b decided — D-57.)*

**Stop-condition note.** DA-F1, DA-F2, DA-F5 and DA-F7 reach the standard game; DA-F5 does so in legitimate play
(probe R1). None invalidates the certification premise: the auction's own buy / bid / contest / markdown / revenue rules
(§6) are correct; the defects are missing gates (round, ownership, par-before-handoff) and one seat-pointer desync in
how the Priority Deal is read off after the auction, each fixable locally and each testable against the standard
goldens (no stored log walks the SV to $0 or skips the par). The owner may prefer to treat DA-F1, DA-F2, DA-F5 and DA-F7
as general-authority fixes rather than variant work; §22 schedules them first for that reason.

---

## 19. Owner decisions — decided on owner review *(rev 2)*

**Recorded 2026-09-25 from the owner's review of DA-1. These are the binding rulings (ledger Part D, D-52 … D-56); the
rev-1 analysis that follows is kept as the record of the options considered.**

- **OD-DA-1 — C&A / PRR share — DECIDED (D-52).** "Reserve one specific 10% PRR certificate from setup until C&A's initial
  purchase. It is unavailable for ordinary stock purchase while reserved. When C&A is acquired, transfer that reserved
  certificate to the buyer and run the ordinary post-share consequences, including float and presidency reconciliation if
  applicable. The reserved certificate counts as sold only when granted." This is option (c) below. It removes DA-F6's
  share-creation case at its source; DA-F6's presidency / float half is delivered as the ordinary post-share consequences.
  *Observation, not part of the ruling:* in the standard game the reservation is consumed by the opening auction before any
  Stock Round, so no standard purchase can meet it. Implementation: DA-5.
- **OD-DA-2 — certificate limit / 60% cap — DECIDED (D-53).** "A forced C&A share grant may temporarily place the recipient
  over the certificate limit and/or 60% ownership cap. The recipient must cure the violation at the first legal opportunity
  in the immediately following Stock Round and may not make an ordinary stock purchase while illegally over the applicable
  limit." DA-5 checks that the existing divestment debt (`forcedDivestment.ts`; S8-11 m5 — it blocks buying and passing)
  implements "first legal opportunity" exactly, including a turn on which no legal sale exists.
  **OD-DA-2b — DECIDED (D-57, rev 3).** "A player may acquire a private company through the delayed auction even if
  that acquisition, or a mandatory share benefit attached to it, temporarily puts the player over the overall
  certificate limit or an applicable corporation ownership limit. This applies to: a competitive auction win; a
  single-bid award; a forced $0 SV acquisition; mandatory stock/share consequences of the acquired private. The player
  must cure every curable excess at the first legal opportunity during their next Stock Round turn and may not make an
  ordinary stock purchase while illegally over a limit. However, a player may not voluntarily place or increase a bid
  if winning that private would create an excess that cannot be cured by legal stock sales in the immediately
  following Stock Round. Mandatory acquisitions, especially the forced $0 SV taking, remain allowed even if they
  create such an overage; the game must not deadlock." Implementation (DA-5): a bid / raise refusal for an incurable
  excess (auction authority, both locks); the divestment debt limited to curable excess — today it blocks buying and
  passing until sold down (S8-11 m5), which would deadlock a player with no legal sale; and a no-deadlock guarantee
  after a mandatory acquisition. *Wording check for DA-5 (not a new decision):* the curability restriction names bids
  and raises; a voluntary face-value purchase of the lowest private (§1.2 option 2) falls under the general allowance
  as worded — confirm before implementing if the restriction is meant to reach it.
- **OD-DA-3 — unsold private-company hexes — DECIDED (D-54).** "Before the delayed auction, ordinary track construction is
  governed by the ordinary track rules. An unsold private does not create a blanket prohibition on laying ordinary track on
  its printed hex. Ownership-specific private powers remain unavailable until that private is owned. Amend the prior
  #1694/S6-7 rationale accordingly." Current behaviour already matches. The ledger's S6-7 entry is amended; the
  `privateReservations.ts:296-303` comment (the superseded premise "in the standard game no tile is laid before the auction
  has sold everything") is corrected in the implementing pass (DA-6), not in DA-1. #1694a (F16) is unchanged by the ruling.
- **OD-DA-4 — first 5-train before the delayed auction — DECIDED (D-55).** "Phase 5 wins. If the first 5-train is bought
  before the pending delayed auction occurs, unsold privates close and the delayed auction is cancelled. Any
  reserved/attached stock associated with an unsold private returns to ordinary corporate stock supply. In particular, the
  reserved C&A PRR certificate returns to normal PRR supply and B&O must no longer remain locked merely because its private
  can no longer be sold." This fixes the intended behaviour for DA-F9 (today the armed atom would still offer the closed
  privates). Implementation: DA-5.
- **Lobby copy — DECIDED (D-56).** Replace the stale "start of Phase 3" description with wording equivalent to: "after the
  Operating Round set in which the first 3-train is purchased, immediately before the next Stock Round." The ruling
  addresses the timing description; the closing sentence ("Watch your cash carefully …", pinned by
  `variantCopy.test.ts:182-187`) is not addressed by it. Implementation: DA-6 (DA-F8a).

**Review corrections recorded (rev 2).** (1) DA-4's standard-game proof obligation is: "Standard auction behavior and
replay remain unchanged except for the explicitly certified DA-F5 Priority Deal correction." — it must not claim that all
standard logs remain unchanged (§22). (2) Before the v10 → v11 closure, scan **all** relevant v10 room / corpus logs — not
only delayed-auction rooms — for an SV marked down to $0 followed by the forced $0 purchase, because DA-F5 affects
legitimate Classic play; old v10 rooms must not be silently reinterpreted under v11 semantics (§23).

### Original DA-1 analysis (rev 1), kept as the record of the options considered

Only questions where two or more materially different behaviours are compatible with the owner spec and the rulebook.

**OD-DA-1 — Source of the Camden & Amboy's PRR share when the PRR initial offering cannot supply it.**
- *Situation:* under the variant PRR may be parred and bought in SR1…SR N; if players have bought every ordinary PRR
  certificate from the IPO, the C&A winner's "10% share of PRR without further payment" has no IPO certificate
  (and possibly no pool certificate either). Unreachable in the standard game, so the rulebook is silent.
- *Current:* pool if IPO < 10%, and a share is created if the pool is short too (a BUG regardless — DA-F6).
- *Choices:* **(a)** IPO, else Bank Pool, else no share (the C&A is still sold; its bonus lapses). **(b)** IPO only,
  else no share. **(c)** Reserve one PRR 10% certificate for the C&A until the auction concludes — the last ordinary
  IPO certificate cannot be bought before then (the B&O lock's shape, applied to one certificate). **(d)** IPO, else
  pool, else defer the grant until a certificate reaches the pool. **(e)** The grantee chooses the pile when both hold a
  certificate (precedent D-30 for the M&H: when both piles hold a legal share "the owner chooses … No silent IPO-first
  rule", `RULES_HARDENING_BACKLOG.md:4522-4525`), else whichever holds one, else no share. The M&H resolver
  (`privateExchange.ts:119-136`: IPO, else pool, else refuse) already has the shape of (a) / (e).
- *Mechanical consequences:* (a) keeps PRR buyable to 100% and prices the C&A's bonus by the market state; (b) makes
  the bonus vanish more often; (c) changes SR1/SR2 buying (a player may be refused the last PRR IPO share), guarantees
  the bonus, and preserves "the 10% comes from the initial offering"; (d) adds a pending obligation to the state; (e) adds a choice to the auction win (a prompt, like the B&O par).
- *Implementation-risk observation (not a ruling):* (c) removes the case at its source and mirrors #904a; (a) is the
  smallest change. Either needs the presidency / float settlement of DA-F6.

**OD-DA-2 — Certificate limit and the 60% holding cap during the delayed auction.**
- *Situation:* players hold shares when the delayed auction runs. Buying or winning a private (a certificate) can
  exceed the certificate limit; the C&A grant can exceed 60% of PRR. The rulebook never meets this case.
- *Current:* acquisitions are allowed; the divestment debt then blocks buying and passing at the player's next Stock
  Round turn until sold down (`forcedDivestment.ts`; S8-11 m5: "stricter than §4.3's 'during your next turn' but not
  incorrect"). Precedents pointing the other way: S7-9 (owner, 2026-09-15 — the buyer in a player-to-player private trade
  must stay within the certificate limit) and the M&H exchange's 60% refusal (`privateExchange.ts:106-117`).
- *Choices:* **(a)** keep: allow, conform at the next SR turn. **(b)** refuse a face-value buy or a bid that would put
  the player over the certificate limit (a forced $0 SV taking, a lone-bid award and the C&A grant would still need
  rule (a) because they cannot be refused cleanly). **(c)** exempt auction acquisitions from the limit until the end of
  the following Stock Round.
- *Mechanical consequences:* (a) no code change, possible forced share dumping in SR N+1 (a real cost of the "harder"
  variant); (b) new auction refusals plus a residual (a) path; (c) a timed exemption the divestment code would have to
  learn.
- *Implementation-risk observation:* (a) is the lowest-risk and is already consistent with the conforming rule; it
  needs only tests and a Rules Reference sentence.

**OD-DA-3 — Private-company location hexes while the privates are unsold (before the delayed auction): confirm or
amend #1694 for this variant.**
- *Situation:* the Stage 10.6 restriction bars a hex holding a private **owned by a player** (S6-7, 2018 §6.2.1(4)).
  Under the variant, Operating Rounds run with every private unsold — never the case in the standard game.
- *Current:* open — any railroad may lay on G15, B20, D18, H18, I13/I15 (and K9/K11 under LPF); a lay on F16 forfeits
  the D&H's power before the D&H is sold. This **is** the recorded reading (#1694, `privateReservations.ts:291-303`; the
  resolved S6-7 entry, `RULES_HARDENING_BACKLOG.md:295`: "corporation-owned, closed and unsold release"), but it was
  recorded on the stated premise that "in the standard game no tile is laid before the auction has sold everything" —
  a premise this variant removes. The question is therefore whether the ruling extends to the variant, not a gap in it.
- *Choices:* **(a)** keep the literal reading (open until sold). **(b)** Treat an unsold, unclosed private like a
  player-owned one (barred until a corporation buys it or it closes; F16 keeps its forfeiting exception). **(c)** (b)
  for the location restriction, but protect the D&H's power at F16 until the D&H is sold.
- *Mechanical consequences:* (a) early track can occupy Baltimore (I13/I15), the C&A and C&SL hexes and pre-empt the
  C&SL / D&H powers; (b) the early map is more constrained, matching the standard game's map at the same point;
  (c) a narrower change.
- *Implementation-risk observation:* (b) is one predicate change in `privateHexStatuses` (+ markers); (a) is no change.

**Owner copy sign-off (not a rules decision).** The lobby blurb is the owner's own verbatim text (#1168) and says "the
start of Phase 3". The rule is determined (A2); only the wording is the owner's to approve in the UI pass (DA-F8a).

**No sign-off needed on the Priority Deal rule.** #1235 (implemented from a playtest report) says "left of the last
player who acted"; §1.2 / §1.2.2 say "left of the last face-value buyer, unchanged by bid resolutions". An auction can only
end on a purchase (the SV always leaves first, so a $0 taking is never the last), so the two coincide at every reachable
auction end; DA-F4 and DA-F5 are defects under either wording, and the fix should reproduce #1235's outcomes wherever the
seat was not desynchronised.

Everything else in this audit is determined by the spec, the rulebook or their mechanical combination and is
classified without asking — in particular: who starts the delayed auction (§1.2: the PD holder; #905's own note),
the PD after it (§1.2 / §1.2.2), the SR number after it, the first-SR reading (ruled Q2), private revenue before it,
the corporate window after it, and the closure of unsold privates by the first 5-train.

---

## 20. Test gaps

| ID | Gap | Class |
|---|---|---|
| DA-T1 | Delayed SR1 sale refused at **ingress** and in a real run; post-auction SR sale allowed (overlaps S10-18(A)) | first-SR |
| DA-T2 | B&O lock through the reducer and ingress for `BuyStock` (par and ordinary) and `SetBoPar` (after DA-F2) | B&O-lock / refusal |
| DA-T3 | Real run: deal → SR1 → OR1 → SR2 → OR with the first 3-train → auction armed → handoff (not hand-built boards); first 3 by an earlier vs the last corporation; later 3/4 in the same set | delayed-trigger |
| DA-T4 | Escrow in a delayed auction with shares and cash already in play (S10-18(B) residue) | escrow |
| DA-T5 | Auction messages refused outside the auction round, in both games (after DA-F1) | refusal-authority |
| DA-T6 | S10-6: lone-bid cascade; multi-company cascade; $0 taking followed by a cascade; contest cascading into a contest | state-machine |
| DA-T7 | PD after an auction ending in a cascade / contest / after a $0 taking — standard and delayed (DA-F3/F4/F5) | state-machine |
| DA-T8 | Corporate purchase of a private in the first OR after the delayed auction; BO closure on B&O's first train after a delayed auction | rule-semantics |
| DA-T9 | C&A grant: share conservation invariant; presidency change; float at 60% (DA-F6 + OD-DA-1) | rule-semantics |
| DA-T10 | Composition: GR + UR on the trigger set (fog order, grace trains) | composition |
| DA-T11 | Bank break inside the trigger set → GameEnd with the auction owed; first 5-train inside the trigger set (DA-F9) | edge |
| DA-T12 | Server-room parity + `RevertTo` across the boundary for a delayed game (`RoomSession`, digest) | server / replay-undo |

Low-value permutation tests deliberately not listed.

---

## 21. Certification-game design (to build in DA-7; nothing built here)

**Main path — G-DA (3 players, `delayedAuction: true`, standard bank, pinned).**
1. Deal → SR1: B&O refused (buy, par, `SetBoPar`); Waterfall* refused; SR1 sales refused; PRR and NYC parred; the PD
   moves off seat 0 by the end of SR1 (needed to exercise DA-F3).
2. OR1 (phase 2, one OR): no private income; a `BuyPrivateCompany` attempt refused (unowned).
3. SR2: sales allowed; PRR ownership arranged so the C&A grant will change PRR's presidency (DA-F6).
4. OR2: an **earlier** corporation buys the first 3-train; a later one buys a second 3; the set ends.
5. Boundary: `WaterfallAuction`, macro 3, auction armed, **first actor = PD holder**; B&O still locked.
6. Auction: SV bought at face; two bids on the D&H and one on the M&H (multi-company escrow asserted); a buy triggers the
   cascade: D&H contest with pass-and-still-in, winner pays once, loser uncharged; M&H lone-bid award; C&A won → PRR
   share from the IPO, presidency changes immediately; BO won → par set before handoff; `OpenStockRound` → **PD left of
   the last face-value buyer**; `private_auction_complete` true.
7. SR3: B&O unlocked (bought); the C&A's PRR share sellable; divestment per OD-DA-2 if constructed.
8. OR3.1 / OR3.2: a corporation buys a private from its president at a legal price; the B&O buys its first train → BO
   private closes.
9. Replay / restore / undo: the room's log replays byte-equal (digest); `RevertTo` before the first 3-train removes the
   auction; `RevertTo` into the auction rebuilds escrow and the cursor.

**Deterministic tails.** T1 SV marked to $0 and forced taking in a delayed auction (PD after it). T2 all-pass revenue in
the delayed auction. T3 C&A with PRR IPO exhausted (OD-DA-1 outcome; conservation). T4 first 3-train bought by the last
corporation; a set that reaches phase 4. T5 bank break in the trigger set. T6 GR + UR on the trigger set. T7 pre-auction
lay on a private hex per OD-DA-3. T8 **standard-game control**: the same auction script in a standard game (PD, escrow,
$0 path, `SetBoPar` ownership, Waterfall* gate). T9 synthetic board: first 5-train before the auction (DA-F9).

---

## 22. Proposed implementation / certification roadmap

| Pass | Scope | Model | Depends on | Replay-semantic? | Owner gate |
|---|---|---|---|---|---|
| **DA-2** | Owner rulings OD-DA-1 … 3; copy sign-off for DA-F8a — *(rev 2)* **done on owner review 2026-09-25** (D-52 … D-56); OD-DA-2b decided (D-57, rev 3) | — (owner) | DA-1 | — | the rulings |
| **DA-3** | Authority gates: DA-F1 (round / activity gate for every auction message, both locks), DA-F2 (`SetBoPar` requires the named player to own the BO private + `boIsLocked`), DA-F7 (B&O par owed before handoff / certificate reserved); standard-game goldens and a corpus sweep for refusal-added effects | **Extra** (mechanical, but touches Classic authority — review the corpus sweep carefully) | DA-1 | refusal-added (Classic + DA) | full-suite gate |
| **DA-4** | Seating and Priority Deal: DA-F3 (seed the delayed auction from the PD holder), DA-F4 + DA-F5 (derive the post-auction PD from the auction's own record of the last face-value purchase, not from the seat mirror), reconciling #905 / #1235 in one rule for both openings | **MAX** (touches the standard auction's PD and #1235's reasoning; proof obligation *(rev 2 review correction)*: "Standard auction behavior and replay remain unchanged except for the explicitly certified DA-F5 Priority Deal correction.") | DA-3 | yes (DA logs; standard logs with a $0 taking) | full-suite gate |
| **DA-5** | Private-grant consequences: DA-F6 (conservation, presidency, float) implementing D-52 (reserved PRR certificate), D-53, D-54 (no behaviour change; comment rationale) and D-55 (the first 5-train cancels the pending auction, releases the reservation, unlocks the B&O — DA-F9) *(rev 2)*; D-57 (auction overage rule: bid / raise refusal for an incurable excess, curable-only divestment, no deadlock) *(rev 3)* | **Extra** | DA-2, DA-3 | yes (DA only; OD-DA-3 possibly both) | full-suite gate |
| **DA-6** | UI / copy: DA-F8a–n (DA-F8a per D-56 *(rev 2)*), Rules Reference variant branches, the false affordance, the Activity Log line at the boundary | **Extra** | DA-2 … DA-5 | no | owner copy review |
| **DA-7** | Certification game G-DA + tails + DA-T1 … T12; S10-6(A) / S10-18(B) residue closed by tests | **Extra** (MAX only if the game design needs rework) | DA-3 … DA-6 | no (tests) | full-suite gate |
| **DA-8** | Version closure v10 → v11, changelog, backlog closure, certification record | **Extra** | DA-7 | the boundary itself | owner full-suite gate + commit |

Six implementation passes after the owner decisions; DA-5 and DA-6 may merge if the rulings are simple.

---

## 23. Version-boundary recommendation

**A deliberate v10 → v11 boundary at DA closure (DA-8), not before.** DA-3, DA-4 and DA-5 are replay-semantic for
delayed logs (who acts, who holds the PD, holdings / presidency / float) and, narrowly, for standard logs (a $0 SV
taking's PD; refusal-added gates). The project's pattern (Gentle Rust → 9, Unpredictable Revenue → 10) is one bump per
certified variant at its closure. No fix in DA-3 … DA-7 should bump on its own. Two cautions for DA-8: (1) a bump holds
every v10 room, not only delayed ones (`rulesVersion.ts:429-459`) — the same trade-off accepted at 9 and 10; (2) *(rev 2 review correction)* before the closure, scan **all** relevant v10 room and corpus logs — not only
delayed-auction rooms, and including the live `DATA_DIR` — for an SV marked down to $0 followed by the forced $0
purchase, because DA-F5 changes legitimate Classic play (the repository corpus has no delayed log at all); **old v10 rooms
must not be silently reinterpreted under v11 semantics**. `RULES_ENGINE_VERSION` remains 10 after DA-1.

---

## 24. Open / deferred non-blockers

- DA-F11 — no 3-train ever → no auction (documented behaviour; Rules Reference sentence + short-bank test).
- `refusalReasonFor` has no auction arm (generic sentence on a reducer-only auction refusal) — cosmetic.
- Stale comments naming "Stock Round 3" / "SR3" (`gameVariants.ts:459-461`; `sandboxSession.ts:3006, 4680-4685,
  4920, 4979`; `stockTransactionAuthority.ts:501-502`; `AuctionPromptModal.tsx:1-2`; `WaterfallAuctionDashboard.tsx:3-4`)
  and the #1168 rationale — fix with DA-6.
- S10-6(B) (remaining Rust mining) stays with the Phase-4 Rust retirement preflight.
- The 2018 rulebook should be added to the repository or a connected folder for future passes (it is the named
  authority but only the 48-page book is in the tree).

---

## 25. Final audit verdict

**AUDIT COMPLETE — READY FOR OWNER DECISIONS / IMPLEMENTATION PLANNING.**

*(rev 2, owner review 2026-09-25: accepted for implementation planning; OD-DA-1 … OD-DA-4 and the lobby copy decided —
D-52 … D-56; OD-DA-2b open; review corrections recorded in §22 and §23. Still NOT certified.)*
*(rev 3: OD-DA-2b decided — D-57.)*

Delayed Auction remains `DEFERRED — PRE-LAUNCH VARIANT CERTIFICATION REQUIRED` and is **not certified**. The owner spec
is confirmed and consistently implemented at the trigger; the general auction is sound; eight defects (five HIGH, two
MEDIUM, one LOW), fourteen copy surfaces and twelve test gaps stand between the variant and certification, with three
owner decisions to take first. No production gameplay code, test, fixture, golden, corpus file or `RULES_ENGINE_VERSION` was
changed by DA-1; full Jest was not run; nothing was committed or pushed.

*Focused tests run (existing suites only, on the owner's checkout):* 28 suites / 751 tests, all passing —
`auctionAuthority`, `auctionSeating`, `stockTransactionAuthority`, `turnAuthority`, `miniAuctionTurn`, `atomicReducer`,
`variantRules`, `boFloatRule`, `privateRevenue`, `privateExchange`, `privateClosure`, `baltimorePrivate`,
`offerMatrix74PrivatePurchase`, `bankBreakTicket`, `shellNarration`, `parMarkArrival`, `presidentPurchase`,
`variantCopy`, `polishWave5`, `gameVariants`, `variantWiring`, `gameSetup`, `rulesAuction`, `rulesOverview`,
`rulesTables`, `roomSession`, `stage103CompositionCoupling`, `moneyConservation`. The passing suite is itself evidence:
no existing test detects any of DA-F1 … F7 (two tests pin DA-F2's permissive behaviour: `turnAuthority.test.ts:333`,
`parMarkArrival.test.ts:134-152`).
