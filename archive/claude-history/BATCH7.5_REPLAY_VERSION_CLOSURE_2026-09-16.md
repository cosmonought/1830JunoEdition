# Batch 7.5 — Batch-7 closure: engine version 5, replay / corpus reconciliation, documented re-pins

Date: 2026-09-16. Baseline: Batch 7.4 committed, **`6ecdfb1f8d9810e0c016498b7d9c99ae24429a5f`**.
Inputs read: `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md`, `BATCH7.1_MONEY_LEDGER_2026-09-15.md`,
`BATCH7.2_STOCK_AUTHORITY_2026-09-15.md`, `BATCH7.3_AUCTION_AUTHORITY_2026-09-15.md`,
`BATCH7.4_PENDING_OFFERS_2026-09-15.md`, the project docs `claude/batch7.4-opus-matrix-review-2026-09-15.md`,
`claude/batch7.4-r74b-o1-repair-2026-09-15.md`, `claude/batch7.4-opus-final-verification-2026-09-16.md`,
`RULES_HARDENING_BACKLOG.md`, `AUDIT_RULES_TO_MACHINE_2026-09-13.md` (by reference from the ledger), `BATCH4.5_RULES_VERSION_2026-09-14.md`,
and the commits `08a59ec` (7.1), `a927e5f` (7.2), `d0a0792` (7.3), `6ecdfb1` (7.4), plus `215eb29` (Batch 6, the
version-4 engine the stale expectations were pinned against).

**Nothing is committed. The full Jest suite was NOT run — it remains the owner's post-commit gate. Stage 8 was not
started; nothing from Stage 9 was implemented; no visual-flourish / UI file was touched. Every unrelated owner
working-tree change is preserved.**

> **Bottom line.** `RULES_ENGINE_VERSION` is **5** (`SUPPORTED = [5]`, changelog row 5). Batch 7.5 changes no
> engine semantics: on all eighteen corpus files the version-5 tree is digest-identical to the committed 7.4
> engine at every replayed entry, and deterministic across repeated replays. Every stale expectation was traced,
> slice by slice, to a named Batch-7 rule before it was touched: **the golden CV4 and G6J boards** (7.1 bank
> credit; 7.3 C5), **`replayJuno3XD`**'s cursor and filed-run tables (7.1 affordability at 28; 7.2 round gate at
> 140), **`moneyConservation`**'s Yellow Sign case, and one version-only case in `routeAuthority`. One finding the
> earlier reports had not spelled out: under 7.3 **JUNO-Z6C freezes at index 33** behind the authoritative
> home-token hold, which made the Z6C epilogue fixture useless as a completed game and had silently broken six
> more cases (`accolades` ×5, `gameOutro` ×1) that the 7.3 / 7.4 stale lists never named. Per the owner's
> ruling those completed-game tests were **re-homed** to the frozen JUNO-CV4 golden log, one Z6C
> characterization was added, and the Z6C-only accolade coverage was **deferred to S10-21** rather than re-pinned
> to a frozen board. Money is conserved by every one of 3,103 replayed entries. **No unexplained divergence was
> normalized.** 52 focused suites, 1,137 of 1,138 tests pass; the single failure is not 7.5's — the owner's
> uncommitted `App.tsx` has dropped the committed 7.4 `acceptedOfferSentRef` reset (§10c).

---

## 1. Baseline and method

**Trees.** Each commit was extracted with `git archive` into scratch space outside the repository (`215eb29`,
`08a59ec`, `a927e5f`, `d0a0792`, `6ecdfb1`), the uncommitted local corpus copied in, and each compiled with
`server/tsconfig.json` (the whole engine to CommonJS). The version-5 working tree was compiled the same way.

**Corpus** (18 files, 12 rooms; sha256 recorded before and after — unchanged): `golden/` JUNO-7NZ, CV4, G6J
(`frontend/src/utils/__fixtures__/replayGolden/logs/`); `server/data` JUNO-7NZ, 8E8, CV4, CW7, FCJ, G6J, TQQ, Z6C;
`frontend/sandbox-log-` JUNO-3XD, CV4, JJD, QVC, Y8V; `prefix/JUNO-FCJ-96`; `fixture/JUNO-Z6C-494`
(`__fixtures__z6cLog.json`). **No corpus log carries a `rules_engine_version`** — all are legacy — so the bump itself
cannot move a corpus digest.

**Probe.** Every file replayed through every engine under `DEVELOPMENT_CORPUS_POLICY`, recording for every entry:
index, id, kind, actor, payload, a per-top-level-field hash of the board **before** the entry (the #1191 observer),
`moneyTotal` and the bank, plus the final board. "The effect of entry *i*" = the board before *i+1*. An entry is a
**no-op** when its effect equals the board it was handed. Consecutive engines were compared entry by entry, so
every difference below belongs to exactly one slice. Undefined-valued keys are skipped, as in `JSON.stringify`.
Refusal sentences quoted below are the version-5 ingress answers (`turnRefusal`) to the stored entry on its
log-derived board.

**The ledger was built on the committed 7.4 engine before any expectation was edited** (§3). The stale set on
`6ecdfb1`, measured by running every corpus-reading suite on the clean archive:

| Suite | Failing cases on `6ecdfb1` | Previously reported |
|---|---|---|
| `replayGolden` | 2 (CV4, G6J) | yes |
| `replayJuno3XD` | 2 | yes |
| `gameHistory` | 4 | yes |
| `roundReplay` | 1 | yes |
| `moneyConservation` | 1 (Yellow Sign case) | yes |
| **`accolades`** | **5** | **no** — stale since 7.3 (passes on `a927e5f`, fails on `d0a0792`) |
| **`gameOutro`** | **1** | **no** — same |
| **total** | **16 cases / 7 suites** | 10 / 5 |

Corpus-reading suites that were green on `6ecdfb1` and stayed green: `replayJunoCV4`, `trainDiscard`, `turnClock`,
`stationLegality`, `messageSchema`, and the board-fixture suites `dieselRouteCap`, `stationCityReach`,
`reenterOtherCity`.

---

## 2. Version 4 → 5

| File | Change | Class |
|---|---|---|
| `frontend/src/gameEngine/rulesVersion.ts` | `RULES_ENGINE_VERSION = 4` → **`5`**; `RULES_ENGINE_CHANGELOG` row 5 (Batch 7.1–7.5: ledger / signed bank / latch; stock round gate, par and price, undeliverable source, sale rules, Brown continuation; SV-only markdown, escrow, $5 raise, contest freeze, `passes_since_raise`; offer hold, consent, three authorities, offer `instance`; chain-era messages refused). `SUPPORTED_RULES_ENGINE_VERSIONS` is `[RULES_ENGINE_VERSION]` and so becomes `[5]` without an edit | A |

**Every place that touches the version, inspected:**

| Where | What it does | 7.5 action |
|---|---|---|
| `rulesVersion.ts` `stampRulesEngineVersion` | server overwrites the deal's pin | none — stamps 5 |
| `sandboxSession.ts` `SetupGame` arm | copies the pin onto the board (#1551) | none |
| `replayCompatibility` / `replayRefusal` | `compatible` / `incompatible` / `legacy` / `undealt` | none — a version-4 pin is now `incompatible` under **every** policy |
| `RoomSession.rebuild`, `submit` 1a, `catchUp`; `replayLog`; `gameServer` restore; `replayCli`; `start.ts` banner | the boundary and its messages | none — they read the constant |
| `DEVELOPMENT_CORPUS_POLICY` (`legacyLogs: "development-corpus"`, `legacyExcessTrains: "engine-chose-cheapest"`) | the one development bridge: admits **unpinned** logs only | none — unchanged, and pinned by `batch75Closure` |
| engine readers of `state.rules_engine_version` (`auctionAuthority` 271, `pendingOfferHold` 196, `stockTransactionAuthority` 113, `sandboxSession` 3287 / 3294, `turnAuthority` 369) | all test `typeof === "number"` ("a pinned board"), never a value | none — **no engine branch depends on the number** |
| tests pinning the number | `routeAuthority` 23 (`toBe(4)`, `[4]`) | **relaxed to `>= 4`** (the Batch-5 / Batch-6 precedent) — class A |
| tests using the number relatively | `emergencyFunding` 22, `trainDiscard` 14, `rulesVersion` | none — already `>=` / constant-relative; pass |
| hand-built fixtures writing `rules_engine_version: 4` as a "pinned board" marker (`auctionAuthority.test.ts` 105, `stockRefusalAtomicity.test.ts` 88, `stockTransactionAuthority.test.ts` 107) | reducer-level boards, never replayed through the compatibility boundary | **not changed** — the engine reads only `typeof`, and changing a marker would be churn |
| new: `utils/batch75Closure.test.ts` | the version-5 case (§8) | A (new) |

Production protection is not weakened: no `SUPPORTED` list was widened, no second compatibility scheme exists, and
the version-4 refusal is asserted before the reducer sees an entry (`RoomEngine.prototype.apply` spy) under the
server policy **and** under the development-corpus policy.

---

## 3. The Batch-7 divergence ledger (built on the committed engines, before any edit)

Old behaviour = Batch 6 (`215eb29`, version 4). Each row is the slice that moved it, measured against the committed
tree immediately before it. "Refused +/applied +" counts every entry whose no-op status flipped, cascade included.

### 3a. 7.1 — the money ledger (`215eb29` → `08a59ec`)

| File | First differing entry | First meaningful field(s) | Old → new | Rule | Reconverges? | Final state | Disposition |
|---|---|---|---|---|---|---|---|
| golden / server / export **JUNO-CV4** | 1 `WaterfallBuyLowest` | `virtual_bank_vgp` | the $20 purchase destroyed → credited to the Bank; later terrain fees 27 / 78 / 163 likewise | S7-10 / D-15 Q1a | no (bank only) | bank 8516 → 9511 (+$755 auction, +$240 terrain; export copy 8572 → 9487); **no gameplay field differs** | EXPECTED — RE-PIN (golden CV4) |
| golden / server **JUNO-G6J** | 1 `WaterfallBuyLowest` | `virtual_bank_vgp` | auction proceeds credited | S7-10 | no | bank +$750 only | EXPECTED — RE-PIN (golden G6J, with 3c) |
| JUNO-8E8, CW7, JJD, QVC, FCJ-prefix96 | 1 `WaterfallBuyLowest` | `virtual_bank_vgp` | credited | S7-10 | no | bank only (+$830, +$905, +$140, +$780, +$820) | EXPECTED — no test pins these boards |
| JUNO-7NZ ×2, TQQ, Y8V | — | — | identical | — | — | identical | — |
| **server/JUNO-FCJ** | 1 (bank); **gameplay 106** `BuyStock` C&O (protocol 5, par $90) by p-raylt1ra | `player_cash`, `public_companies`, `market_positions`, … | minted the shortfall → refused ("p-raylt1ra holds $85 and cannot pay $180", 7.1 §7c) | S7-1 | no | 10 fields; refused +61 / applied +18 | EXPECTED — no test replays FCJ past 96 |
| **server/JUNO-Z6C**, fixture Z6C-494 | 2 (bank); **gameplay 193** `BuyStock` (double certificate) by p-lzjh2r6u | `player_cash`, `public_companies`, `active_player_index` | minted → refused ("holds $111 and cannot pay $200") | S7-1 | no | 19 / 22 fields; refused +166 / +114. Superseded by 3c |
| **export/JUNO-3XD** | 7 (bank); **gameplay 28** `BuyStock` NNH by p-h96t6pld | `player_cash`, `public_companies` | minted $40 → refused ("That purchase costs $100 and you hold $60.") | S7-1 | no | 18 fields; refused +120. NNH never floats in SR 1; the first OR queue is [B&O, PRR] not [B&O, NNH, PRR] | EXPECTED — RE-PIN (`replayJuno3XD`) |
| every log | — | `bank_broken` | never written | S7-20 | — | no latch in any log | — |

### 3b. 7.2 — stock and par authority (`08a59ec` → `a927e5f`)

| File | First differing entry | Field(s) | Old → new | Rule | Reconverges? | Final | Disposition |
|---|---|---|---|---|---|---|---|
| **server/JUNO-FCJ** | **83** `BuyStock` B&O by p-9692z98k during an Operating Round | `player_cash`, `public_companies`, … | applied → refused ("Shares can only be bought during a Stock Round.") | S7-13 | no | 12 fields; refused +21 / applied +246 (entries 7.1 had refused become affordable) | EXPECTED — no test |
| **export/JUNO-3XD** | **140** `BuyStock` C&O by p-h96t6pld during an OR | `player_cash`, `public_companies` | applied → refused | S7-13 | no | 12 fields; refused +27 / applied +9 (the direct stock refusals are 140, 141, 219, 284 — as 7.2 §12a; 7.2 counted 26 cascaded refusals by its own method, this whole-state test counts 27) | EXPECTED — RE-PIN (`replayJuno3XD` cursor table from 175) |
| **prefix/JUNO-FCJ-96** | **83** (same entry) | cash, companies | applied → refused | S7-13 | no cascade (prefix ends) | 6 fields | EXPECTED — `stationLegality` does not read the changed fields; green |
| every log with a Stock Round (CV4 ×3 19, 8E8 23, CW7 11, FCJ 15, G6J 22, Z6C 31, 3XD 24, QVC 15) | first `BuyStock` | `bought_this_turn_company` | absent → the purchase's corporation, cleared at the seat change | D-22 / Q9 lifecycle field | **yes**, at the next seat change (Z6C's store copy ends mid-turn, so its final board carries it) | identical except where a log ends mid-turn | EXPECTED TRANSIENT — lifecycle, no re-pin (7.2 §12c saw only its `undefined` writes; where the purchase is live the value is real) |
| Z6C, 8E8, CV4, CW7, G6J, JJD, QVC, 7NZ, TQQ, Y8V (gameplay) | — | — | identical | — | — | — | — |

### 3c. 7.3 — auction authority (`a927e5f` → `d0a0792`)

| File | First differing entry | Field(s) | Old → new | Rule | Reconverges? | Final | Disposition |
|---|---|---|---|---|---|---|---|
| golden / server **JUNO-G6J** | **7** `WaterfallPass` by p-lzjh2r6u (all-pass, SV sold) | `waterfall` | JK (private 7) marked 120 → 115 → **stays 120** | S7-2 C5 / D-21 Q8 | no | `player_cash` p-lzjh2r6u 985 → **980** (bought at 9 for $120, not $115), bank 10300 → **10305** | EXPECTED — RE-PIN (golden G6J) |
| **server/JUNO-Z6C**, fixture Z6C-494 | **9** `WaterfallPass` by p-je0gw2v0 (all-pass, SV sold, B&O = private 6 on offer) | `waterfall` | B&O marked 220 → 215 (9) → 210 (12) → **stays 220** | S7-2 C5 | no | see the cascade below; refused +249 | EXPECTED — fixture migration (§6) + RE-PIN (`moneyConservation`) |
| golden / server / export JUNO-CV4 | 7 `WaterfallMiniAuctionRaise` $135 | `waterfall` | live contest gains `passes_since_raise: 0` | S7-3 | **yes, at 8** | identical | EXPECTED TRANSIENT — no re-pin |
| server/JUNO-8E8 | 8 `WaterfallMiniAuctionRaise` $125 | `waterfall` | same | S7-3 | **yes, at 10** (and a second contest 14 → 15) | identical | EXPECTED TRANSIENT — no re-pin |
| export/JUNO-3XD | **6** `WaterfallBidHigher` $165 by p-h96t6pld (own standing $165, minimum $170) | `active_player_index` | the refused bid still advanced the seat (partial application) → whole message refused, seat stays | S7-4 / #1184 gate position | **yes, at 35** | identical | EXPECTED TRANSIENT — no re-pin (pinned already by `auctionAuthority` "JUNO-3XD 6") |
| CW7, FCJ, TQQ, JJD, QVC, Y8V, 7NZ ×2, FCJ-prefix | — | — | identical | — | — | — | — |

**The Z6C cascade under 7.3 — verified entry by entry, and the one thing the 7.3 report did not spell out:**

| idx | Entry | Version-5 board |
|---|---|---|
| 9, 12 | `WaterfallPass` ×2 (SV already p-lzjh2r6u's) | private income paid both times; the B&O stays **$220** (7.2: $215, $210) |
| 14 | `WaterfallBuyLowest` by p-lzjh2r6u | pays **$220** (cash 705 → 485; 7.2: → 495) |
| 31 | `BuyStock` B&O by p-lzjh2r6u | holds **$95**, share costs $100 → refused ("That purchase costs $100 and you hold $95."); B&O stays at 50 % IPO, unfloated |
| 32 | `PlaceHomeStation` B&O I15 | B&O unfloated → places nothing (the stored placement is no longer timely) |
| 33 | `BuyStock` B&O by p-je0gw2v0 | applies (seat authority is ingress-only, Q10) → B&O **floats** |
| 34 → 604 | every remaining entry | `homeTokenBlock`: "B&O has floated and its home station is not on the board yet. p-lzjh2r6u must place it on I15 before play continues." No later entry places it → **every entry is a reducer no-op**; the log-derived timeline is `[SR 1, Final]`; the Yellow Sign at 203 is never reached |

Not a replay bug: each step is an approved Batch-7 rule (C5, affordability) or the pre-existing home-token hold, and
the owner has ruled the freeze an expected historical-log incompatibility under version 5 (§6).

### 3d. 7.4 — offer authority and replay-safe identity (`d0a0792` → `6ecdfb1`)

| File | First differing entry (effect of) | Field(s) | Old → new | Rule | Reconverges? | Final | Disposition |
|---|---|---|---|---|---|---|---|
| **server/JUNO-CW7** | **121** `ProposeTrainPurchase` B&M ← B&O 2-train $10 (answered 122, declined) | `offer_serial`, `train_purchase_offer` | offer without identity → `instance: 1`, `offer_serial: 1` | #1597 (S7-21) | offer field yes (cleared at 122's answer); `offer_serial` persists by design | **`offer_serial` only** | EXPECTED — lifecycle field; no test pins CW7; pinned by `batch75Closure` |
| **export/JUNO-QVC** | **59** `ProposeTrainPurchase` PRR ← B&O 2-train $80 (accepted 60, settled 82) | `offer_serial`, `train_purchase_offer` | same | #1597 | same | **`offer_serial` only** | EXPECTED — as above |
| **server/JUNO-FCJ** | **145** `ProposeTrainPurchase` (B&O owns no 2-train on the log-derived board) | `train_purchase_offer` | offer recorded → refused ("B&O does not own a 2-train to sell."); also 205 / 273 ("Only the operating corporation may buy a private company …"), 232 ("… only during the buyer's turn of an Operating Round.") | S7-5 / S7-7 / S7-8 | offer fields null-vs-absent through 308 | — | EXPECTED |
| server/JUNO-FCJ (gameplay) | **309** `BuyPrivateCompany` B&O ← JK $60 by p-9692z98k in a Stock Round | `player_cash`, `public_companies`, `private_companies`, `jk_license_granted` | applied → refused ("A corporation buys a private company only during its own turn of an Operating Round.") | S7-6 / S7-12 | no | 8 fields (incl. offer fields null vs absent); refused +32 / applied +23; money 20,000 both | EXPECTED — no test replays FCJ past 96 |
| all other files | — | — | identical | — | — | — | — |

O1 (#1598) leaves no replay trace (only a restore's derived loop changes). **7.4 moves no tested expectation.**

### 3e. Version 5 (`6ecdfb1` → working tree)

All eighteen files **digest-identical at every entry and at the end**; a second replay of every file reproduces
every per-entry field hash. The owner's in-flight presentation edits to `gamePhase.ts`, `depotSchedule.ts` and
`gameVariants.ts` (phase names, blurbs) move no board.

### 3f. PRE-EXISTING / BUG

**No divergence was classified PRE-EXISTING or BUG.** The frozen Z6C board depends on the pre-existing home-token
hold (S8-5 / S8-12 territory), but the divergence itself is caused by 7.3 C5 plus affordability, and the hold behaves
as designed.

---

## 4. Every actual expectation change

### 4a. Class A — engine-version expectation

| Test | Old | New | Why |
|---|---|---|---|
| `routeAuthority.test.ts` case 23 | `RULES_ENGINE_VERSION` `toBe(4)`; `SUPPORTED` `[4]`; changelog `[1,2,3,4]`; fresh room / board pin `4`; version-3 refusal `supported: [4]` | `>= 4`; `[RULES_ENGINE_VERSION]`; `.slice(0, 4)` = `[1,2,3,4]`; `RULES_ENGINE_VERSION`; `supported: [RULES_ENGINE_VERSION]` | the bump; Batch 6's own case keeps asserting Batch 6's row and the refusal of version 3 (same relaxation Batch 6 applied to Batch 5's case 22) |

### 4b. Class B — replay-semantic re-pins

| Fixture / test | Old expected | New expected | Slice / rule |
|---|---|---|---|
| `__fixtures__/replayGolden/JUNO-CV4.json` (data-only) | `virtual_bank_vgp` `"8516"` | `"9511"` | **7.1** S7-10: +$755 auction proceeds (idx 1, 2, 3, 6, 8, 9, 10) + $240 terrain (27, 78, 163). No other byte changes — the file is byte-identical to the one the suite regenerates on the 7.4 engine |
| `__fixtures__/replayGolden/JUNO-G6J.json` (data-only) | `virtual_bank_vgp` `"9550"`; p-lzjh2r6u `cash_vgp` `"985"` | `"10305"`; `"980"` | **7.1** S7-10 (+$750) and **7.3** C5 (idx 7: the JK is not marked to $115; bought at 9 for $120, +$5 to the Bank). Byte-identical to the regenerated fixture |
| `replayJuno3XD.test.ts` "agrees with the live game about which turn each run belonged to" | `mismatches` `[]` (29 / 29 reproduced) | the exact 24-row table `index logged -> replayed` (71 `2.1.1 -> 3.0.1` … 319 `7.1.7 -> 11.0.7`) and the five that still agree `[61, 81, 86, 102, 108]` | **7.1** S7-1 (28 / 31: NNH unfloated, the calendar runs one set ahead from 71); **7.2** S7-13 (140 moves the claims from 175 on). Identical under 7.2, 7.3, 7.4, version 5 |
| `replayJuno3XD.test.ts` "prints filed run against declared amount" | PRR `260`, NYC —, B&O `350`, C&O `220`, NNH `90` | PRR —, NYC —, **B&O `50`**, C&O —, NNH — | **7.1** S7-1. On the version-5 board only B&O's run at 61 ($50) is ever accepted: 71 is PRR's run with no train, 81 B&O's run at PRR's Tokens step, and so on. 7.2 / 7.3 / 7.4 leave this table unchanged |
| `moneyConservation.test.ts` "the Yellow Sign award is still the one minting rule left, and it is Stage 9's (S9-1)" | `server/JUNO-Z6C` minted list `["203 YellowSignEvent +90"]` | list `[]`, **and** the board before 34 equals the board before 203 and the final board (the freeze), **and** a hand-built Mark still adds exactly $90 with `moneyConservationBreach` non-null | **7.3** C5 cascade (§3c). The S9-1 tripwire is preserved on a board that reaches the Mark, so closing S9-1 still fails this case |

### 4c. Fixture migration caused by an intentional replay-semantic cascade (owner ruling, 2026-09-16)

`__fixtures__z6cLog.json` is unchanged. The completed-game tests that read it were inspected **assertion by
assertion**:

| Case (suite) | Status on `6ecdfb1` | Disposition | Where it runs now |
|---|---|---|---|
| "samples once per round boundary, in order, and ends on Final" (`gameHistory`) | failing | **moved to CV4**; Z6C's `"OR 5.1"` / `> 10 ORs` became CV4's exact 14-label timeline and 7 ORs | JUNO-CV4 golden |
| "names a Robber Baron, a Master of the Line, a Track Boss and a Market Manipulator on a played game" (`gameHistory`) | failing | **moved to CV4** (all four held; Master of the Line "$90 on C&O's 3-train (OR 5.1)") | CV4 |
| "every corporation carries a payback and a ledger whose rows add up to its train spend" (`gameHistory`) | failing | **moved to CV4** (three fleet ledgers) | CV4 |
| "each OR sample carries what each player was paid in it …" (`gameHistory`) | failing | **moved to CV4** | CV4 |
| "replays to a board still labelled with that round, and its prices match the next sample's opening" (`roundReplay`) | failing | **moved to CV4**: Z6C's `OR 7.2` → CV4's `OR 4.1` (the same shape — an OR whose next sample opens a Stock Round, with tiles still to lay: 10 of 14) | CV4 |
| "the Workhorse is the autopsy's top lifetime revenue" (`accolades`) | failing | **moved to CV4** (PRR $250) | CV4 |
| "the anti-awards and the corporate five come off the same replay (#1429)" (`accolades`) | failing | **split**: Hobo, Juggernaut ≥ Master, Golden Goose, Dividend Machine, Capitalist Pig, Railroad Baron ≥ Mr. Monopoly, White Elephant **moved to CV4**; the **Farmhand** line **removed → S10-21**; the conditional Bagholder / Little Engine format lines kept but now vacuous (CV4 awards neither) and their coverage **listed under S10-21** | CV4 / S10-21 |
| "the ceremony is a subset of the accolades, in show order, ending on the Robber Baron" (`accolades`) | failing | **moved to CV4** | CV4 |
| "Z6C's C&O president is a Carcosan -- the Mark, never redeemed (#1421)" (`accolades`) | failing | **removed → S10-21** (CV4 has no Yellow Sign) | — |
| "obsolescence is two awards in dollars: the Gravedigger sent, the Rust Belt lost (#1422)" (`accolades`) | failing | **removed → S10-21** (CV4 ends in phase 3; nothing rusts) | — |
| "the OR's runs land on the OR's own sample, so the revenue chart has figures" (`gameOutro`) | failing | **moved to CV4** | CV4 |

The completed-game cases in the same `describe` blocks that still *passed* on the frozen Z6C board did so vacuously
(two samples, one B&O with no fleet) and were moved with their block, unchanged: `gameHistory` "carries every player
and every corporation on every sample", "prices come off the chart …", "the autopsy covers exactly the floated
corporations …", "a player's equity by corporation sums …", "samples carry the phase …"; `roundReplay` "a round's
end is the next round's opening entry …", "the last round is the live board", "an out-of-range round is null";
`accolades` "computes all thirty-seven …", "the Shell Corporation …", "Mr. Monopoly …", "Scrooge and the Paper
Millionaire …", "the Early Adopter, if any …" (vacuous on both logs — neither ever had an Early Adopter). Source-scan
cases in those files are untouched.

**The Z6C characterization** (new, `gameHistory.test.ts` "JUNO-Z6C under rules engine version 5: an expected
historical-log incompatibility (Batch 7.5)") pins: timeline `[SR 1, Final]`; the B&O on offer at $220 before 9, 12
and 14 with the SV already sold (the 7.3 C5 correction); $220 paid at 14; $95 and B&O unfloated at 31, 31 a no-op;
32 a no-op with B&O unfloated; B&O floated after 33; the home-token hold's own sentence at 34; and the board before
every entry from 34 on equal to the final board. It says in place that this is an expected historical incompatibility
and not a gameplay failure.

**Displaced coverage (S10-21, not implemented):** Carcosan Railways / Redeemer (#1421); Gravedigger and Rust Belt
formats and values (#1422); Farmhand; Bagholder and Little Engine detail formats; the phase-5, multi-OR-set, >10-OR
timeline and snapshot. **No award was re-pinned to "nobody".**

### 4d. Class C — wording / metadata

None separately. The explanatory comments added beside the class-B re-pins are the project's established practice
for test files (Batch 6); the two JSON fixtures stay data-only and their reasons live here and in Part E.

### 4e. New tests

`utils/batch75Closure.test.ts` (6 cases, §8).

---

## 5. Version-only vs semantic vs transient

- **Version-only:** `routeAuthority` 23. The corpus is entirely legacy, so no replay expectation is version-only.
- **Semantic (re-pinned):** golden CV4, golden G6J, `replayJuno3XD` ×2, `moneyConservation` Yellow Sign.
- **Semantic (fixture migration):** the 11 Z6C completed-game cases (§4c).
- **Transient, reconverged, NOT re-pinned:** 7.3 `passes_since_raise` (CV4 ×3 at 7 → 8; 8E8 at 8 → 10, 14 → 15);
  7.3 JUNO-3XD 6 seat (→ 35); 7.2 `bought_this_turn_company` (to each seat change); 7.4 `train_purchase_offer.instance`
  on CW7 / QVC (to the answer). The persistent `offer_serial: 1` on CW7 / QVC is a deliberate lifecycle field that no
  test pins except the new closure test.

---

## 6. Money-conservation closure

18 files, 12 rooms, **3,103 replayed entries** checked (every applied entry's before/after `moneyTotal`, plus the
final board).

| Engine | Non-`SetupGame` breaches | Categories |
|---|---|---|
| Batch 6 `215eb29` | 163 (the 7.1 report's 114 over its 13 files, plus the golden, prefix and 494 copies) | unpaid auction proceeds, unpaid terrain fees, minted share purchases, the Yellow Sign |
| 7.1 `08a59ec`, 7.2 `a927e5f` | 2 (`server/JUNO-Z6C` 203 and `fixture/JUNO-Z6C-494` 203, `YellowSignEvent` +$90) | the Yellow Sign (S9-1) only |
| 7.3 `d0a0792`, 7.4 `6ecdfb1`, **version 5** | **0** | none |

- Non-conserving categories under version 5: **`SetupGame` only.** The Yellow Sign mint is not reached because
  Z6C freezes at 34 (§3c); **S9-1 is not fixed** — `markKeepsRun.test.ts` and the re-pinned `moneyConservation`
  case both still show the Mark adding cash with no payer.
- **No new unexplained non-conserving message.**
- Bank latch: no log writes `bank_broken` under any Batch-7 engine; the lowest post-deal bank under version 5 is
  $8,720 (`export/JUNO-QVC`). No stored game's ending moves for the latch.

---

## 7. Stage-7 ingress parity (design §12b, "verify in 7.5")

Static check of `sandboxSession.ts` (core) against `turnAuthority.ts` (ingress): every Stage-7 predicate the core
asks — `stockPurchaseRefusal`, `stockSaleRefusal`, `parLadderRefusal`, `auctionRefusal`, `privatePurchaseRefusal`,
`trainSaleRefusal`, `propose/answer/rescind` for private purchases, train sales and trades, `pendingOfferBlock`,
`legacyOfferMessageRefusal` — is also asked at ingress. The only core-only refusal is the `cashLedger` boundary,
which sits behind those predicates by design (U-29).

---

## 8. Offer / replay determinism after the bump

| Check | Evidence | Result |
|---|---|---|
| Historical corporation offers replay deterministically | `batch75Closure`: CW7 (121 / 122) and QVC (59 / 60) replayed twice — identical final digests; the answer's board carries `instance: 1`, `offer_serial: 1`, the stored seller / buyer; final `offer_serial` 1 | pass |
| Serials / instances identical across repeated replay | the same case, plus the corpus probe run twice over all 18 files (every per-entry field hash equal) | pass |
| `RevertTo` rebuild deterministic | `batch75Closure`: `RevertTo` the proposal → no `offer_serial`, no offer; `RevertTo` the answer → the same pending instance 1, twice alike; `offerVerify74Final` V§4 (committed tree) and `offerMatrix74Settlement` §15 | pass |
| Production incompatibility | `batch75Closure`: a version-4 room held on restore (`incompatible {4, [5]}`), `replayLog` throws under server **and** corpus policy, `RoomEngine.apply` never entered; `rulesVersion`, `emergencyFunding` 22, `trainDiscard` 14, `routeAuthority` 23 | pass |
| Development bridge unchanged | `batch75Closure`: the golden CV4 log throws "before rules-engine versioning" under the server policy, replays 141 entries under `DEVELOPMENT_CORPUS_POLICY`, and its board acquires no pin | pass |
| The bump does not touch settlement identity | `batch75Closure`: `trainOfferKey` / `derivedEntryKey` identical on boards pinned 4 and 5 (`offer:train:7`); `privateOfferKey` `offer:private:2` | pass |
| Instance-less legacy fallback | `offerVerify74Final` V§6 (2 cases), `offerMatrix74*` | pass |

---

## 9. Final focused suite totals (working tree, after the re-pins)

| Group | Suites | Tests |
|---|---|---|
| Changed / closure: `batch75Closure` 6, `replayGolden` 4, `replayJuno3XD` 5, `moneyConservation` 33, `gameHistory` 13, `roundReplay` 7, `accolades` 24, `gameOutro` 16 | 8 | **108 / 108** |
| Version + corpus consumers: `routeAuthority` 50, `rulesVersion` 15, `emergencyFunding` 29, `trainDiscard` 21, `replayJunoCV4` 5, `turnClock` 8, `stationLegality` 28, `messageSchema` 25 | 8 | **181 / 181** |
| Board-fixture consumers: `dieselRouteCap`, `stationCityReach`, `reenterOtherCity` | 3 | **22 / 22** |
| Offer / replay identity: `offerMatrix74*` ×6, `offerAuthority`, `offerVerify74Final` | 8 | **372 / 373** — see §10c |
| Replay / room / derived: `roomSession`, `stateDigest`, `logRevert`, `derivedActions`, `replayEquivalence`, `replayAttribution`, `operatingCursorReplay`, `divergenceWatch`, `logExport`, `logHash`, `serverProtocol`, `shellMessageArms`, `turnAuthority` | 13 | **191 / 191** |
| Transaction authority: `auctionAuthority`, `stockTransactionAuthority`, `stockRefusalAtomicity`, `refusalAtomicity`, `cashLedger`, `bankBreakLatch`, `atomicReducer`, `miniAuctionTurn`, `trainLifecycle`, `emergencyTrainFlow`, `markKeepsRun`, `gameSetup` | 12 | **263 / 263** |
| **Total** | **52** | **1,137 / 1,138** |

Before the re-pins, the four migrated suites were also run on the clean 7.4 archive with their new contents:
60 / 60.

| Check | Result |
|---|---|
| `npx tsc --noEmit -p frontend/tsconfig.json` (whole tree, owner's in-flight files included) | **clean** |
| `tsc -p server/tsconfig.json --noEmit` | **clean** |
| `tsc -p server/tsconfig.json` build (to a directory outside the repository) | **clean** |
| `eslint` on every touched file | 0 errors; 19 warnings, **identical to the same files at HEAD** (unused imports in `replayJuno3XD`, template-string warnings in `accolades` / `gameOutro`) |

---

## 10. Files, blockers and housekeeping

### 10a. Files changed by Batch 7.5

| File | Class |
|---|---|
| `frontend/src/gameEngine/rulesVersion.ts` | A — version 5 + changelog row |
| `frontend/src/utils/__fixtures__/replayGolden/JUNO-CV4.json` | B — 1 line |
| `frontend/src/utils/__fixtures__/replayGolden/JUNO-G6J.json` | B — 2 lines |
| `frontend/src/utils/replayJuno3XD.test.ts` | B — two tables, with reasons |
| `frontend/src/utils/moneyConservation.test.ts` | B — the Yellow Sign case |
| `frontend/src/utils/routeAuthority.test.ts` | A — case 23 |
| `frontend/src/utils/gameHistory.test.ts` | fixture migration + Z6C characterization |
| `frontend/src/utils/roundReplay.test.ts` | fixture migration |
| `frontend/src/utils/accolades.test.ts` | fixture migration; two cases and one line displaced to S10-21 |
| `frontend/src/utils/gameOutro.test.ts` | fixture migration (one case) |
| `frontend/src/utils/batch75Closure.test.ts` (new) | version-5 and determinism closure |
| `RULES_HARDENING_BACKLOG.md` | roadmap row 7; version paragraph; Stage-7 closure note; S7-1 `RESOLVED`; S7-20 latch result; **S10-21** (new); Part E version-5 row and the 7.x rows' SHAs |
| `BATCH7.5_REPLAY_VERSION_CLOSURE_2026-09-16.md` (new) | this report (project copy: `claude/batch7.5-replay-version-closure-2026-09-16.md`) |

### 10b. Confirmation

Every re-pin and migration above traces to a committed Batch-7 rule through §3. **No unexplained divergence was
normalized; no stored log or corpus file was modified; no engine semantics changed.**

### 10c. Blocker / finding outside 7.5's scope — the owner's `App.tsx`

`offerVerify74Final.test.ts` "V§4 shell twin" fails **in the working tree only**. The owner's uncommitted
`frontend/src/App.tsx` (saved 2026-09-16 04:14 UTC, ten minutes after the 7.4 commit) no longer contains the
committed 7.4 hunk in `rebuildSandbox`:

```ts
/* Batch 7.4 final verification (#1597 x #887): … */
acceptedOfferSentRef.current = new Set();
```

`git diff HEAD -- frontend/src/App.tsx` shows those five lines removed. On the committed tree the suite passes
12 / 12. **7.5 did not touch `App.tsx`.** It looks like an editor buffer from before the commit overwrote the fix.
If so, re-adding those lines (or restoring that hunk from HEAD) clears it; otherwise the owner's full Jest gate will
show this one failure.

### 10d. Housekeeping

- `git status` on the mounted folder left a `.git/index.lock` the bridge cannot delete; it was renamed
  `.git/index.lock.stale-batch7.5` (the 7.3 / 7.4 convention). Later git reads used `--no-optional-locks`.
- Three lint scratch copies of HEAD test files were written into `frontend/src/utils/` by mistake and could not be
  deleted. They were renamed out of Jest's reach to `_to_delete/batch75scratch/*.test.ts.txt`, so the owner can
  delete that folder.
- The owner's working tree kept changing during the session (`activeGame.ts`, `seatPin.ts`, `palette.ts`,
  `sandboxWatchIntent.test.ts`, …). None of it was read or modified.

---

## 11. Carried forward — not implemented

- **Stage 8:** S8-5 (home token at float vs first OR — moving it would change Z6C's replay again, and the
  characterization would announce it), S8-6, S8-12 (O6: ingress does not mirror the home-token hold), S8-2 …
- **Stage 9:** S9-1 (Yellow Sign authority — still mints), S9-10 (authoritative tile-upgrade topology preservation:
  universal old-track preservation and required station connectivity; topology changes only from the actual
  source → destination upgrade family and active ruleset; fixed OO old #59 keeps its two systems separate; Variable
  OO Cities OFF; expanded 1830+ / LPF legal unusual transitions such as two small cities → one; Stage 9 opens with a
  manifest / catalog audit before `preservesRouting` changes; old tile numbers in project-facing text — wording
  unchanged by 7.5).
- **Stage 10:** S10-20 (O2, null-actor derived settlement), **S10-21** (new: a completed version-5 Yellow Sign
  fixture), S7-17 with S10-1 (refusal transport).
- **Part C:** U-19 … U-31, including U-28's retrospective Batch 1–6 UI-parity audit.

---

## 12. Not run

**The full project Jest suite was NOT run.** It remains the owner's gate after 7.5 commits. Expected owner-visible
difference from this report's focused runs: only §10c, unless it is fixed first.
