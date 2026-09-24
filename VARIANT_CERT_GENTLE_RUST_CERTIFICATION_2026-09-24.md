# Variant Certification 1A — Gentle Rust: GR-4 certification evidence

**2026-09-24 · GR-4 — CERTIFICATION / EVIDENCE SLICE.** Tests and documents, plus — after the owner's U-9 review — one
derived-statistics correction (`frontend/src/utils/gameHistory.ts`, design note **#1704**). No gameplay / reducer code
changed. No golden, fixture, log or export rewritten or repinned. `RULES_ENGINE_VERSION` untouched (**8**). Nothing
committed or pushed. Design notes **#1703** (certification) and **#1704** (U-9).

**Revision.** r1 (first GR-4 report) classified U-9 as B (mark-time counting, documented). **That classification was not
supported by the older explicit statistics authority** — `gameHistory.ts` #1414 ("a rusted train is one that actually left
the roster") and #1422 (the Gravedigger *sends* trains to the scrapheap; the Rust Belt *lost* them) — and the owner has
since **ruled destruction-time accounting** (§L). r2 (this revision) records the ruling and its implementation; GR-4 was
NOT ready for the owner gate between the ruling and this correction. Gameplay-clause certification is unaffected.

This document is **evidence, not specification**. The specification is
`VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` (§3 GR-S1…GR-S30, §4 SR-1…SR-9, §11 invariants A–H). Where the two
ever disagree, the audit (and the owner rulings it records) wins.

**GR-4 verdict (r2): READY FOR OWNER GATE / READY FOR GR-5.** Every standalone normative clause except GR-S26 is
CERTIFIED by behavioural evidence; GR-S26 is DEFERRED BY SPEC. **Gentle Rust is NOT yet certified**: GR-5 owns the
deliberate `RULES_ENGINE_VERSION` 8 → 9 boundary and final closure. Combined Gentle Rust + Unpredictable Revenue stays
uncertified until UR certification settles OD-GR-3.

---

## A. Baseline

| item | value |
|---|---|
| branch | `main` |
| HEAD | `4f4844ad87e3586367f114edbfe4978deb6c181e` ("Gentle Rust GR-3: align UI and rules presentation") |
| `origin/main` | `4f4844ad87e3586367f114edbfe4978deb6c181e` — HEAD == origin/main |
| tracked tree at start | clean (only untracked `.claude/`); no `.git/index.lock` seen; later git calls with `GIT_OPTIONAL_LOCKS=0` |
| `RULES_ENGINE_VERSION` | `8` (`frontend/src/gameEngine/rulesVersion.ts:65`) |
| slice history | GR-1 `0ca01be` · GR-2 `b755a7b` · DT-1 `936bacc` · GR-3 `4f4844a` (all owner-gated, committed) |

Work was done in a cloud clone of `4f4844a` (corpus files copied in from the owner's machine, md5-verified) and moved to
the owner's tree by writing the changed files; blob hashes verified equal.

## B. Authority

`VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` rev 4 (rev 4 = this slice's status update only; no clause changed).
Scratch probes of Appendix A are **no longer the only evidence** of anything: every probe is now a durable test (§F).

## C. Clause matrix (GR-S1 … GR-S30)

Evidence kinds: **B** behavioural (messages through the reducer / a `RoomSession`), **R** rendered, **U** unit on the
authority helper, **S** source scan (secondary only). "Game" = `utils/gentleRustCertificationGame.test.ts` (§G);
"Cert" = `utils/gentleRustCertification.test.ts`; "GR-1" = `utils/gentleRustGraceTurn.test.ts`; "GR-2" =
`utils/gentleRustTransactionLocks.test.ts`; "DT-1" = `utils/dieselExchangeAutoSkip.test.ts`; "GR-3" =
`utils/gentleRustPresentation.test.ts` + `components/gentleRustPresentation.test.tsx`; "Stats" =
`utils/gentleRustCertificationStats.test.ts`.

| clause | rule (short) | authority | behavioural evidence | what it proves | standard / negative control | status |
|---|---|---|---|---|---|---|
| **GR-S1** | `variants.gentleRust`, resolved, absent = false | CONFIRMED #902 | `gameVariants.test.ts:75–95`, `variantWiring.test.ts:229–246` (U); Game G0 (`resolveVariants({gentleRust:true})` drives every mark); Game G6 / GR-1 T11 (flag off → standard) | the flag is the one decider, end to end | G6, T11 | CERTIFIED |
| **GR-S2** | 2s at first 4, 3s at first 6, 4s at first D | INHERITED | Game G1 / G3 / G4 (`expectEveryCopyMarked`: every held copy of exactly that tier marked, no other tier added); GR-1 T10; Cert LPF / 18XX+ | all three boundaries, in one game, no neighbouring tier | Game G6 (all three boundaries destroy at once) | CERTIFIED |
| **GR-S3** | delay, never exemption | CONFIRMED #906 + derived | GR-2 S1–S8, D1–D8, D(room); Game G4 (refused trade-in); Game G5 (final board: no 2/3/4 anywhere; no obsolete tier ever in the pool) | no path turns a doomed train permanent | GR-2 S6 | CERTIFIED |
| **GR-S4** | trigger = the purchase (depot, emergency, exchange) | INHERITED; #1303/#1314 | Game G1 (depot), G4 (first-D exchange: traded ordinary 4 leaves before the phase turns), Cert GR-S4 (emergency purchase of the first 4); GR-2 D5 | every trigger kind | Cert GR-S4 control; G6 | CERTIFIED |
| **GR-S5** | every held copy, the buyer's own included | DERIVED | Game G1 (PRR's own 2 as this turn's doom), G3 (NYC's own 3), G4 (B&O's own 4); GR-1 T1/T3 | buyer and rivals alike | G6 | CERTIFIED |
| **GR-S6** | Bank Pool copies destroyed at the phase change, no reprieve | DERIVED / INHERITED | Game G3 (pool 3 scrapped), G4 (pool 4 and the traded 4 scrapped), G5 (no obsolete tier in the pool on any board); GR-1 T5 (pool 2s — REPRESENTATION: no legal board has a pooled 2 before the first 4, see §G), T10 (pool 4s) | 3s and 4s in play; 2s on a labelled board | G6 (pool copies gone in standard too) | CERTIFIED |
| **GR-S7** | remains owned | CONFIRMED | GR-1 T6; Cert A; Game G1 (B&O owns 2, counts 0) | owned on every surface the reducer reads | — | CERTIFIED |
| **GR-S8** | remains operable | CONFIRMED | GR-1 "route" (real mark by `BuyHardwareFromPool`; `RunMultipleRoutes` with both reprieved 2s accepted) | runs on its grace turn | GR-1 route control (unreprieved twin) | CERTIFIED |
| **GR-S9** | only-reprieved corp is not trainless | CONFIRMED SR-1/SR-3 | Cert A (Routes skip refused: owns trains + paying route), Cert E (PROBE: End Turn accepted, emergency purchase refused), GR-1 T6, Game G5 (every board: owns > 0 ⇒ no obligation) | through messages; **mutation-verified** (§E) | Cert B control | CERTIFIED |
| **GR-S10** | exempt from the maximum-limit count | CONFIRMED #1034 | Cert D (two purchases → owns 5 under limit 3; third refused by the ordinary trains); Game G1 (owned 4 > limit 3, room ends Buy Trains at the limit, no discard), G5 (count = ordinary trains on all 91 boards); DT-1 DT7/DT8 | purchase gate, auto-skip, obligation — by messages | Cert D control | CERTIFIED |
| **GR-S11** | not an excess-discard candidate | DERIVED, SR-8 | Game G2 (in play: choices [3,3,4] exclude the Final Run 2; `DiscardTrain 2` refused; the 3 goes to the pool; mark stays); GR-2 X; Cert "discard" (one slot per mark, not per model); G5 (debt = max(0, ordinary − limit) everywhere) | live `pendingTrainDiscards` / `DiscardTrain` authority | GR-3 U-5 control | CERTIFIED |
| **GR-S12** | no sale / transfer | **CONFIRMED OD-GR-1** | GR-2 S1 (P6 closed), S1-offer (proposal/answer/settlement), S2 (real self-trigger, every rival turn), S3/S4 (multiset), S5, S7 (room + replay), S8 (no Blood Price) | refused atomically everywhere; ordinary copy still sells | GR-2 S6, B | CERTIFIED |
| **GR-S13** | no Diesel trade-in | **CONFIRMED OD-GR-2** | GR-2 D1–D8, D(room); Game G4 (in play, refused with the sentence, board untouched); Cert LPF | $800 and LPF $750; ordinary 4/5/6 still trade | GR-2 D6/D16 | CERTIFIED |
| **GR-S14** | priced / pays like any train | DERIVED | GR-1 "route" ($90 two-2 GULF run = the unreprieved control, train for train; destroyed on entering Dividends *after* earning; the declaration pays the run) | route + revenue + pay/withhold. The UR die clause: its input (the printed breakdown) is shown identical; the roll itself belongs to combined GR+UR certification | GR-1 route control | CERTIFIED (standalone) |
| **GR-S15** | grace turn = first turn beginning after the doom (A/B/D/E) | CONFIRMED SR-5 | GR-1 T1 (A), T2 (B), T4 (D), T5 (E); Game G1 (A: B&O, C&O; B: NYC), G3 (A: PRR, CPR), G4 (B: PRR across the SR) | §5 below | — | CERTIFIED |
| **GR-S16** | self-trigger → next future turn | CONFIRMED SR-5 | GR-1 T3 (×4), T4, T5, T9; Game G1 (PRR, first 4), G3 (NYC, first 6, across the SR), G4 (B&O, first D) | all three boundaries | GR-1 T11 | CERTIFIED |
| **GR-S17** | a turn, not a run | CONFIRMED SR-4 | Game (every grace turn expires with no route: room-derived Routes skip + forced $0 withhold); GR-1 T8 (reprieved 2 left unassigned, expires); GR-1 T1 (advance through Routes without running); T5 P5b (turn ended at Track → fallback) | §6 below | — | CERTIFIED |
| **GR-S18** | destruction at end of Run Routes | CONFIRMED #1102 | GR-1 T1/T3; Game (every expiry at the cursor entering Dividends) | exact point | — | CERTIFIED |
| **GR-S19** | fallback only for the qualifying turn | CONFIRMED SR-6 | GR-1 T3 ("survives the end of the turn that doomed it"), T5 P5b (owed mark taken); Cert "arms" (turn-change and leaving-the-round fallbacks); Game (three self-dooms survive their turn ends) | both directions | — | CERTIFIED |
| **GR-S20** | destruction removes train + mark, one per mark | DERIVED | GR-1 T9; Cert multiset (ordinary twin survives); Game G3 (CPR's two 3s, exactly two) | multiset exact | — | CERTIFIED |
| **GR-S21** | not pooled, not revived, one loss | DERIVED | Game G5 (no expiry reaches the pool; no obsolete tier purchasable); GR-1 T9 (no re-mark); Stats (booked once, at the destruction — owner ruling U-9) | §L for the loss-count rule | — | CERTIFIED |
| **GR-S22** | trainless only after destruction | CONFIRMED SR-3 | Cert A→B; GR-1 T6→T7, T8; Game (B&O, C&O, CPR: own trains until their Run Routes end, trainless after) | both sides of the boundary | T8 | CERTIFIED |
| **GR-S23** | ordinary forced purchase afterwards | CONFIRMED SR-3 | GR-1 T7; Cert B (End Turn refused with the ordinary sentence; `EmergencyBuyHardware` executes with the president's money; then End Turn accepted); Game (no route ⇒ ordinary prerequisite fails ⇒ not owed) | no Gentle Rust purchase rule | **Cert B control: standard-rust trainlessness gives the identical obligation, sentence and emergency train** | CERTIFIED |
| **GR-S24** | multiset; doomed ⊆ marks ⊆ owned after every arm | CONFIRMED #1032 | Game G5 (all 91 boards + final); GR-2 (every accepted movement); Cert multiset / discard / arms; GR-1 T9 | §H | — | CERTIFIED |
| **GR-S25** | coexisting trigger groups | DERIVED | GR-1 T10; **Game G3 (in play: PRR's self-doomed 2 from the first 4 + a rival-doomed 3 from the first 6, one turn, destroyed together)** | §8 below | — | CERTIFIED |
| **GR-S26** | Yellow Sign × reprieve | **DEFERRED — OD-GR-3** | — | → Unpredictable Revenue certification | — | **DEFERRED BY SPEC** |
| **GR-S27** | narration at destruction; log at marking; no limit mislabel | CONFIRMED #1002/#1003/#896/#1099 | GR-1 T1/T3/T10 (`describeReprieveExpiries`: rusted, never discarded); GR-3 UI14–UI17 (U-6: trade-in no longer a limit discard); `gentleRustLimit.test.ts` "still says a rust happened"; `batch28`/`batch37` (S: modal queues) | narrator authorities behaviourally; modal wiring S (UI clause) | GR-3 UI14 (standard) | CERTIFIED |
| **GR-S28** | presentation | CONFIRMED #1004/#1033/#1034 | GR-3 UI1–UI3 (timing from the board), U-5, U-11 (sale/exchange greying from the authorities), R: `components/gentleRustPresentation.test.tsx` | rendered / shared-authority | GR-3 "answers nothing for a standard game" | CERTIFIED |
| **GR-S29** | determinism | CONFIRMED #902 | GR-1 T12; **Game G7** (log replayed twice: every intermediate digest equal; an independent room writes the identical log); GR-2 S7 replay | §G.4 | — | CERTIFIED |
| **GR-S30** | standard control | INHERITED | GR-1 T11; **Game G6 (all three boundaries on the game's own boards)**; Cert GR-S4 / D / B controls; GR-2 S6 | §I | — | CERTIFIED |

**Totals: 29 CERTIFIED, 1 DEFERRED BY SPEC (GR-S26), 0 BLOCKED.**

**Clauses whose behavioural evidence was absent, indirect or incomplete before GR-4, and what closed them:**
GR-S4 (no emergency-purchase trigger test → Cert GR-S4); GR-S6 for the 3-tier (no pool-3 scrap under Gentle Rust in play
→ Game G3); GR-S9/E (helper calls only → Cert A / E probe, mutation-verified); GR-S10 (helper-level only → Cert D and Game
G1/G5 through purchases and the room's auto-skip); GR-S11 (live authority tested only on isolated boards; the useful trim
expectation lived on a dead helper → Game G2, Cert "discard"); GR-S20 with an ordinary twin (helper contract only → Cert
multiset); GR-S23 (no proof that the obligation is the *ordinary* one → Cert B standard control; the emergency purchase
had never been executed after an expiry → Cert B); GR-S24 after the fallbacks and a pool purchase (→ Cert "arms"),
and on every board of a whole game (→ Game G5); GR-S25 in composition (→ Game G3); GR-S29 for a multi-phase game (→
Game G7); GR-S30 for the first 6 and first D (→ Game G6).

## D. GR-S26

**GR-S26 — DEFERRED BY SPEC — OD-GR-3 → UNPREDICTABLE REVENUE CERTIFICATION.** Not probed, not changed. Yellow Sign
arms (`applyYellowSignOutcome` fog / Mark / gift, `sandboxSession.ts:6472–6620`) are category C in §H. Standalone Gentle
Rust certification proceeds with this explicit deferment; **Gentle Rust + Unpredictable Revenue remains uncertified**
until UR certification closes OD-GR-3.

## E. Invariants A–H (§11)

| inv. | evidence | result |
|---|---|---|
| **A** only reprieved | GR-1 T6 (real mark: owns trains, not trainless, count 0, no discard, no purchase, routeable, paying route); GR-1 route (they run on the grace turn); Cert A (messages: Routes skip refused); Cert E probe (End Turn accepted, emergency refused); Game G1 (B&O: owns 2 / counts 0 / not trainless) | **GREEN** |
| **B** expiry of the last | GR-1 T7; Cert B (Run Routes → destroyed; End Turn refused with the ordinary sentence; `EmergencyBuyHardware` executes with the president's $160; End Turn then accepted); Game (B&O / C&O / CPR expire to zero; no route ⇒ ordinary prerequisite absent ⇒ not owed) | **GREEN** |
| **C** ordinary + reprieved | GR-1 T8 (the 3 remains; not trainless; no purchase; End Turn accepted) | **GREEN** |
| **D** limit capacity | Cert D (+ standard control); Game G1 (owned 4 > limit 3, no discard, room's limit auto-skip), G5 (all boards) | **GREEN** |
| **E** no helper conflation | Cert E probe + GR-1 T6 (behavioural); GR-1 invariant-E scans (secondary). **Mutation check (scratch, reverted, hash-verified):** `trainObligationFor` rewritten to ask `countableTrainCount` instead of the raw fleet → **3 failures**: Cert "E (PROBE)", GR-1 "T6", GR-1 "invariant E … capacity helper" | **GREEN** |
| **F** sale | GR-2 S1–S8 (not duplicated) | **GREEN** |
| **G** Diesel trade-in | GR-2 D1–D8, D(room); Game G4; DT-1 DT7/DT8/DT12/room; Cert LPF | **GREEN** |
| **H** self-trigger | GR-1 T3 (×4), T4, T5 (×2), T9; Game G1 (PRR, first 4), G3 (NYC, first 6: survives turn end **and the Stock Round**), G4 (B&O, first D); `pending_rust_doomed_this_turn` written at the purchase and released at that turn's end (Game G1 case C) | **GREEN** |

**Cases A–E** (mark created → qualifying turn → expiry point):

| case | dedicated test | in the game |
|---|---|---|
| A rival before target | GR-1 T1: NYC's first 4 → PRR's later turn same OR → entering Dividends | B&O / C&O (first 4, OR 3.1 → same round); PRR / CPR (first 6, OR 3.2 → same round) |
| B rival after target | GR-1 T2: NYC's first 4 after PRR operated → PRR's first turn of the next set (across the SR) | NYC (first 4 in 3.1 → 3.2); PRR (first D in 3.2 → 4.1, across the SR) |
| C self-trigger | GR-1 T3: PRR's own first 4 → PRR's next turn (round 2) | PRR (first 4), NYC (first 6), B&O (first D) |
| D last corp self-trigger | GR-1 T4: last corporation of the set → survives the SR → next set's turn; GR-3 UI4 | NYC's self-doomed 3 crosses the SR (not the last corporation) |
| E one-corporation OR | GR-1 T5 (set end and in-set) | — |

**One turn, not one run (GR-S17):** "available but unassigned" — GR-1 T8 (C&O runs only its 3; its reprieved 2 expires
anyway); "cannot earn" — every grace turn of the constructed game (no earnable route; the room skips Routes and forces the
$0 withhold; the trains still go at Dividends entry); "turn ended before Run Routes" — GR-1 T5 P5b (fallback). The rule was
not changed.

**Identical-train multiset:** GR-1 T9 (three 2s marked once each; a re-applied tier adds nothing to either list; exactly
three removed); Game (NYC {2,2}, B&O {2,2}, CPR {3,3} marked and removed exactly); Cert multiset (ordinary twin survives
an expiry); Cert "discard" and GR-2 S3/S4/D3 (eligibility subtracts marked multiplicity, never model-wide); Game G5 (no
phantom mark on any board).

**Multiple phase changes before the next turn:** GR-1 T10 (3s by first 6 + 4s by first D, PRR idle between) and Game G3
(PRR's 2 from the first 4 + 3 from the first 6): both groups coexist, both owned, both excluded from the count, both
available for the one turn, destroyed together, marks cleared; no later event overwrote an earlier group.

## F. Appendix-A probes → durable tests

| probe | durable test(s) | disposition |
|---|---|---|
| P1 self-trigger mid-OR | GR-1 T3 (×4); Game G1 case C | previously WRONG → corrected (GR-1), pinned |
| P1b unpinned board | GR-1 T3 (the correction is not gated on the pin); §M (no unpinned corpus board ever marks a train) | superseded: pinned boards are the supported shape (#1520) |
| P1c standard control | GR-1 T11; Game G6 | already correct → pinned |
| P3 already operated | GR-1 T2; Game G1 case B (NYC), G4 (PRR across the SR) | already correct → pinned |
| P4 end of set (others) | GR-1 T4 | already correct → pinned |
| P4-self | GR-1 T4 | previously WRONG → corrected |
| P5 one-corporation OR | GR-1 T5 (two cases) | previously WRONG → corrected |
| P5b fallback owed mark | GR-1 T5 third case; Cert "arms" | already correct → pinned |
| P6 sale of a marked train | GR-2 S1, S1-offer, S2, S7 (room + replay) | previously WRONG → corrected (GR-2) |
| P7 excess discard with a mark | GR-2 X; Game G2 (in play); Cert "discard" | already correct → pinned |
| P8 two phase changes | GR-1 T10; Game G3 | already correct → pinned |
| P9 Diesel trade-in of a marked 4 | GR-2 D5+D2+D9, D(room); Game G4 | previously WRONG → corrected (GR-2) |
| P9n trade-in narration | GR-3 UI14/UI15; `gentleRustExchangeStats.test.ts` | previously WRONG → corrected (GR-3 U-6) |
| corpus probe (3XD) | §M | re-measured |

## G. The constructed legal certification game

**Files:** `frontend/src/utils/gentleRustCertificationGame.ts` (test support: starting board, fixed script, room runner)
and `frontend/src/utils/gentleRustCertificationGame.test.ts` (34 tests). A **constructed legal certification game**, not a
historical game and not a golden: never exported, not in the development corpus.

### G.1 Starting-state provenance (every nontrivial fact)

* **Rules:** `resolveVariants({ gentleRust: true })`; pinned `rules_engine_version: 8` (log "undealt", replayed under
  `SERVER_REPLAY_POLICY` — no legacy adapter).
* **Cursor:** Operating Round 3.1 of a two-round set, NYC (first in price order) at the start of its turn (Lay Track); the
  round's opening (order, private income) already happened.
* **Phase 3, limit 4.** All six 2s and all five 3s owned; Bank Pool empty (phase 2 → 3 does not drop the limit, so no
  excess discard can have happened; this is also why **no legal board can hold a pooled 2 at the first 4** — GR-S6's 2-tier
  pool case is therefore pinned only on GR-1 T5's labelled board). Depot head: first 4.
* **Corporations:** NYC [2,2,3] $1,500 · PRR [2,3,3] $700 · CPR [3,3] $600 · B&O [2,2] $2,000 · C&O [2] $1,000; each
  token on its **real 1830 home hex** (`STATION_HOME_HEXES`: E19, H12, A19, I15, F6), no home owed; 10 shares issued, all
  held by players (percentages sum to 100). ERIE, NNH, B&M unfloated (100% IPO, no token, no train).
* **Share prices** on real chart cells of one row: 112 / 100 / 90 / 82 / 76 = operating order.
* **Privates:** all sold; the B&O private closed (#660: the B&O has bought a train); the other five player-owned and open.
* **Money:** bank + player cash + treasuries = **$12,000**.
* **Map:** printed board, no tile. The first message lays Albany (NYC's home) through `LayTile` — track but no second
  revenue location, so nobody has an earnable route (an *empty* grid would be read as "not loaded" by
  `earnableRevenueVerdict`).

G0 asserts each of these facts. After the start the game advances **only** by `RoomSession.submit` with the acting
president / Stock Round seat as the author; the room appends its own derived entries. No board is patched between steps.

### G.2 Significant actions (91 log entries: 38 submitted, 53 derived; 2 submissions refused and not logged)

| OR | action | consequence |
|---|---|---|
| 3.1 | NYC lays Albany; ends | NYC has operated (case B target) |
| 3.1 | **PRR buys the FIRST 4** | phase 4 / limit 3; marks PRR {2} (self, doomed this turn), NYC {2,2}, B&O {2,2}, C&O {2}; PRR owns 4, counts 3 → room ends its Buy Trains at the limit; no discard |
| 3.1 | CPR buys a 4 | at limit → room ends turn |
| 3.1 | B&O grace turn (case A) | Routes skipped (no route), forced $0 withhold, both 2s gone entering Dividends; trainless, no route → no obligation |
| 3.1 | B&O buys 4, 4, **the FIRST 5** | phase 5 / limit 2; every private closes; discards owed PRR (choices [3,3,4] — its Final Run 2 excluded), CPR, B&O |
| 3.1 | PRR `DiscardTrain 2` **refused**; PRR discards 3; CPR discards 4; B&O discards its 5 | pool [3,4,5]; PRR's mark intact; phase stays 5 |
| 3.1 | C&O grace (case A) → 2 gone; buys 5, 5 | 5s sold out → depot head 6 |
| 3.2 | NYC grace (case B) → 2s gone; **buys the FIRST 6**, then the last 6 | phase 6; marks NYC {3} (self), PRR {2,3} (**two groups**), CPR {3,3}; pool 3 scrapped → [4,5] |
| 3.2 | PRR grace → 2 and 3 gone together; CPR grace → both 3s gone | — |
| 3.2 | **B&O trades an ordinary 4 for the FIRST D** ($800) | phase D; marks B&O {4} (self), PRR {4} (case B); pool 4 and traded 4 scrapped → pool [5] |
| 3.2 | B&O `ExchangeTrainForDiesel 4` **refused** ("B&O's 4-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.") | board untouched |
| SR 4 | three passes | NYC's 3, PRR's 4, B&O's 4 cross the Stock Round, owned and marked |
| 4.1 | NYC → 3 gone; PRR → 4 gone; B&O → self-doomed 4 gone | final: NYC [6,6], PRR [], CPR [], B&O [D], C&O [5,5]; pool [5]; no marks |

### G.3 Required observations

1 first 4 marks 2s — G1 · 2 Final Run — G1 (B&O, C&O, NYC, PRR) · 3 marked 2s later lost — G1 · 4 no permanent 2 — G5 ·
5 first 6 marks 3s — G3 · 6 3s survive to the right turn — G3 (incl. across the SR) · 7 3s then disappear — G3 · 8 first D
marks 4s — G4 · 9 ordinary Diesel exchange legal — G4 · 10 reprieved 4 cannot be the trade-in — G4 · 11 4s get their grace
and go — G4 · 12 no obsolete 2/3/4 in the pool after its phase — G5 (+ G3/G4 scraps) · 13 limit counts exclude marks — G1,
G5 · 14 ownership includes them — G1, G5 · 15 no mark without a train — G5 (every board) · 16 no permanent obsolete train
— G5. Also present: three self-triggers, rival-before (A) and rival-after (B) targets, identical copies (2s and 3s),
coexisting groups, an in-play excess discard beside a Final Run train, private closure at the first 5, money conserved
at $12,000 on every board.

### G.4 Deterministic replay

G7: the room's log replayed **twice** through `replayLog`: every entry's `(index, kind, derived, stateDigest(before))`
identical; both finals equal the room's (`bc622db0c160eb09`); grid identical. A **second independent room** fed the same
start and script writes the identical log (index, actor, payload, derived) and passes through identical boards; fleets,
marks, cursor, phase, treasuries and bank equal. The runner injects `mintId`, `now` and `mintSeed`; no randomness or UI
state enters.

**Sensitivity (scratch worktrees, not committed):** at `b755a7b` (GR-2, before DT-1) the game fails at "3.2 B&O trades an
ordinary 4 for the FIRST D" — B&O at [4,4] is auto-passed at its limit although the exchange is legal (the DT-1 defect).
At `b846307` (before GR-1) the suite cannot load (`gentleRustGrace` absent). The game therefore exercises DT-1 as well as
GR-1/GR-2.

## H. Train-moving arm inventory

`sS` = `frontend/src/gameEngine/sandboxSession.ts` at `4f4844a`.

| arm | where | class | invariant evidence |
|---|---|---|---|
| depot purchase (`BuyHardwareFromPool`) + phase change | `buyDepotTrain` sS:1789 → `applyPhaseChange` sS:1109 | A | Game G5 (every board), GR-1, Cert D |
| Bank Pool purchase (`returned_model_type`) | `buyReturnedTrain` sS:1871 | A | Cert "arms" |
| emergency purchase (`EmergencyBuyHardware`) | sS:5846 → `buyDepotTrain` | A | Cert B, Cert GR-S4 |
| intercorporate sale (direct / offer settlement / derived / under obligation) | `settleTrainSale` sS:1893; gate `trainSaleRefusal` | A (ordinary copy) / **B** (reprieved copy refused) | GR-2 (after every accepted movement) |
| Diesel trade-in (`ExchangeTrainForDiesel`) | arm sS:5740; gate sS:3611 | A (ordinary) / **B** (reprieved refused) | Game G4, GR-2 D* |
| excess discard (`DiscardTrain`) | arm sS:5829; gate sS:3354 | A (countable) / **B** (reprieved never a choice) | Game G2, GR-2 X, Cert "discard" |
| rust marking / standard destruction / Bank Pool rust | `applyPhaseChange` sS:1109–1374 | A | Game G1/G3/G4/G5, G6 |
| expiry at Dividends entry | `expireReprieveFor` sS:3901 via sS:4247 | A | Game G5, GR-1 |
| fallback at a turn change | sS:3999 (+ `releaseDoomedThisTurn` sS:3977) | A | Cert "arms", GR-1 T3 |
| fallback leaving the Operating Round | sS:4096 | A | Cert "arms", GR-1 T5 |
| route run (`RunMultipleRoutes`) | reads the roster; its Run Routes end is the expiry above | A (no fleet write of its own) | GR-1 route |
| Yellow Sign fog / Mark / gift | `applyYellowSignOutcome` sS:6472–6620 | **C** — OD-GR-3 → UR | not decided here |
| deal / LPF corporations / sandbox scenarios | `gameSetup.ts:709`, `levelPlayingField.ts:57`, `sandboxState.ts` | D (setup fixtures; no reprieve can exist) | — |
| `RevertTo` / undo | rebuild by replay of the arms above | D (inherits) | Game G7, GR-2 S7 |

`pending_rust_doomed_this_turn ⊆ pending_rust_trains ⊆ owned_trains` (by model and count) holds after every category-A
path. **No ordinary non-Yellow-Sign path orphans or launders a mark.** No new defect.

## I. Standard-mode negative controls

First 4 / first 6 / first D destroy held copies at once and write no pending field: GR-1 T11 (first 4) and Game G6 (all
three, on the constructed game's own boards; pool copies gone; limit counts the whole fleet). Emergency trigger: Cert GR-S4
control. Limit capacity: Cert D control. Forced purchase: Cert B control (identical obligation). No Final Run transaction
restriction exists without Final Run state: GR-2 S6 / B, D6/D16, `dieselExchange.test.ts`. Route / forced-purchase
semantics otherwise unchanged: the standard-rules suites in §K's focused run are green.

## J. Level Playing Field / 18XX+ intersections

* LPF: the 7-train rusts nothing; the first D bought outright at **$900** marks every held 4 (the buyer's own as this turn's
  doom); the limit is the table's 2; a Final Run 4 frees its slot (Cert LPF). LPF trade-in **$750** for an ordinary train
  (GR-2 D7, DT-1 DT2/DT5–6) and refused for a Final Run 4 (GR-2 D8, Cert LPF).
* Project 18XX+ (expanded map + tiles, no LPF): the first D by an **$800** trade-in marks the remaining 4s exactly as on the
  standard table (Cert 18XX+). The Diesel exchange is on every table (#1439), so there is no other 18XX+ interaction.
* No other intersection exists (map/tiles do not touch rust, limits or the transaction locks).

## K. U-1 … U-11

| item | disposition | evidence |
|---|---|---|
| U-1 chip tooltip | RESOLVED (GR-3) | GR-3 UI1–UI3 + rendered chips |
| U-2 Final Run badge timing | RESOLVED (GR-3) | GR-3 UI2 |
| U-3 purchase-warning timing | RESOLVED / re-audited (GR-3) | GR-3 UI4 |
| U-4 Rules Reference | RESOLVED (GR-3) | `components/gentleRustPresentation.test.tsx` "carries every concept of the rule (audit U-4 A–H)" |
| U-5 discard prompt | RESOLVED (GR-3) | GR-3 U-5 |
| U-6 trade-in narration | RESOLVED (GR-3) | GR-3 UI14–UI17; `gentleRustExchangeStats` |
| U-7 limit-drop copy | RESOLVED (GR-3) | GR-3 U-7 |
| U-8 | SEPARATE — VISUAL_FLOURISH K-1 (unchanged) | — |
| **U-9** statistics | **OWNER-RULED (destruction-time) and IMPLEMENTED** — r1's "B" withdrawn (§L) | Stats; `gentleRustExchangeStats` |
| U-10 not-trainless copy | RESOLVED (GR-3) | Rules Reference concept "still owned → not trainless"; limit tooltip |
| U-11 sale / exchange greying | RESOLVED (GR-3) | GR-3 UI6–UI13 |

All GR-3 suites are green in this slice's focused run: no regression.

**Rules Reference / presentation (§26):** the rendered Rules Reference block (GR-3, pinned concept by concept) states:
ordinary triggers unchanged; one qualifying future Operating Turn; self-trigger → next future turn; still owned; still
usable; not counted against the maximum train limit; therefore not trainless; removed after Run Routes in the Final Run
turn; never a discard choice; no sale; no Diesel trade-in; Bank Pool gets no Final Run; ordinary forced purchase only after
actual removal. No copy was rewritten; no factual regression found.

## L. U-9 — statistics disposition (owner ruling: destruction-time accounting)

* **Fields / labels:** `gameHistory.ts` tallies `trainsLostValue/Count` (accolade **The Rust Belt**, "Lost the most, in
  dollars, to rust and the train limit."), `trainsSentValue/Count` (**The Gravedigger**, "Bought the trains that sent the
  most of the table's rolling stock to the scrapheap."), and the fleet ledger's `fates.rusted` (#1431).
* **The authority conflict r1 missed.** #1414 (the tallies are diffs): "a rusted train is one that actually left the
  roster". #1422 (the two obsolescence awards, "ruled apart"): the Gravedigger "SENDS trains to the scrapheap", the Rust Belt
  "LOST the most to it". Under Gentle Rust the code booked the *mark* (the fleet-loss diff's `rusted` = models newly added to
  `pending_rust_trains`, #979) — a train still in the roster, not yet on the scrapheap. #979's "the reprieve is the rust
  event" is a **narration** rule (the Activity Log line, GR-S27), not a ruling about these tallies; r1 over-read it.
* **Owner ruling (2026-09-24).** "U-9 uses DESTRUCTION-TIME accounting. A Gentle Rust train counts as RUSTED / LOST for the
  fleet ledger, Rust Belt and Gravedigger only when the train is actually permanently removed at the end of its qualifying
  Final Run. Merely entering `pending_rust_trains` / Final Run does NOT yet count … If the game ends while the Final Run train
  still exists in `owned_trains`, that train is KEPT, not both RUSTED and KEPT." Gameplay is unchanged: the train still rusts
  and enters its Final Run at the phase event, stays owned and usable, and the Activity Log may still say it rusted.
* **Implementation (#1704, `gameHistory.ts` only).** On a Gentle Rust table the fleet-loss diff's `rusted` list books
  nothing; the destruction books it, read off `describeReprieveExpiries` (the shared answer the Rust modal fires on, #1099:
  only marked copies that actually left the roster, by multiset, at the Run Routes expiry or either turn-end fallback). At
  that entry: fate "rusted"; the **loss** to the corporation's president **at destruction**; the **credit** to
  `rustCauseByTier[rusting tier]` — the actor of the entry under which the phase first reached the tier that rusts this
  model (4 for 2s, 6 for 3s, D for 4s; read from `depotInventory(...).rustedBy`).
* **Why the tier identifies the cause (no train identity, no new state).** Each model rusts at exactly one event, and every
  copy held then is marked by it (GR-S5); no copy of a doomed model can be acquired afterwards (queue rule, pool scrap,
  OD-GR-1). So the purchase that brought in the rusting tier is the one purchase that doomed every destroyed copy of that
  model, whatever corporation and however many copies. It is reconstructed while the history replays the log (the same
  phase-move test the Phase Rusher already uses). **No reducer state, no persisted field, no train identity, no
  architecture change; multiplicity preserved by counting each destroyed copy.** If a log begins after the rusting tier
  arrived, that cause is not in the log and no Gravedigger credit is given for those copies (the Rust Belt loss still is).
* **Standard tables:** untouched — marking and destruction coincide and the old branch runs. **Measured:** the compiled
  history module of `4f4844a` vs the working tree over all 18 corpus logs — accolades, autopsy (fleet ledger) and round
  samples **identical 18/18**, including JUNO-Z6C's standard rust (Gravedigger $480, Rust Belt $240). JUNO-3XD (Gentle
  Rust) never marks a train, so it is unchanged too.
* **Evidence** (`gentleRustCertificationStats.test.ts`, 9 cases over the constructed game and two scripted boards):
  - *marking* (cut after the first 4): no Rust Belt, no Gravedigger, no "rusted" fate anywhere;
  - *destruction* (cut after B&O's grace turn): loss P3 $160 (B&O's president), credit P1 $160 (who bought the first 4) — not
    the expiry entry's actor;
  - *identical copies*: CPR's two 3s add exactly 2 × $180 to P2;
  - *two groups in one entry + self-trigger*: PRR's 2 (P1's own first 4) and 3 (P2's first 6) destroyed together — P1 sent
    all six 2s ($480), P2 exactly the 3 ($180); P1 is also the Rust Belt victim ($340) of the 2 it sent;
  - *game ends during grace* (cut after the first D): the doomed 4s are kept 1 / rusted 0, and P3 has no credit for them;
  - *finished game*: every doomed train destroyed, each booked once (Gravedigger P2 $720 / P3 $600; Rust Belt P3 $820 /
    P1 $640);
  - *controls*: the Diesel trade-in stays "traded", an intercorporate sale "sold", the president's excess discards never
    "rusted"; a standard table still books its rust at the purchase, to the buyer.
  GR-3's `gentleRustExchangeStats` Gentle Rust case (which pinned "the reprieve is the rust") is updated to the ruling; its
  standard case is unchanged.
* **Versioning:** replay-neutral. `gameHistory.ts` is the epilogue's derived reading of a replay — it is not in the reducer,
  the server build, a message, the state or any digest. The reducer dist is byte-identical to `4f4844a`; the corpus sweep
  (§M) is unaffected. The GR-5 v9 list is unchanged (§N).
* **Classification (r2): OWNER-RULED, IMPLEMENTED — resolved.** (r1's "B" is withdrawn.)
* **Pre-existing finding, not changed (outside the ruling, standard tables too):** since #1530 a president's `DiscardTrain`
  is narrated by the action and spliced out of the fleet-loss diff, so the history records **no** ledger fate and no Rust
  Belt / Gravedigger amount for an excess discard (in the constructed game, CPR's discarded 4 and B&O's discarded 5 show
  rusted 0 / discarded 0 / kept 0). #1431 lists "discarded to the limit" as a fate and #1422 counts "the train limit" in both
  awards. Restoring it would change standard-game statistics, so it is left for an owner decision; the smallest fix is to
  book the `DiscardTrain` message's model as "discarded", charge it to that president, and credit the purchaser whose
  phase change dropped the limit. **Tracked durably as `RULES_HARDENING_BACKLOG.md` Part C U-41** (candidate only; deferred
  to a dedicated statistics / residual pass; not a certification blocker).

## M. Corpus reconciliation (18 files)

Scratch builds (outside the repository) of `4f4844a` (git archive) and of the working tree, each compiled with
`server/tsconfig.json`; the two dist trees are byte-identical (no reducer or server-build file changed; the r2 statistics
module `gameHistory.ts` is not in that build — re-measured after r2: still byte-identical). Every file replayed under
`DEVELOPMENT_CORPUS_POLICY`, recording per engine application the pre-entry state digest, grid hash, cursor and the
derived-action answer.

| measure | result |
|---|---|
| files | 18 |
| stored / applied / dropped | **4,105 / 3,731 / 374** |
| engine applications | **3,763** |
| state / grid / cursor differences (HEAD vs tree) | **0 / 0 / 0** |
| derived-action differences | **0** of 3,763 pre-entry boards + 18 finals |
| final boards equal | **18/18** |
| JUNO-Y8V | 668 / 628 / 40, `OperatingRound 13`, **`b4fae877c35604fe`** |
| JUNO-3XD | Gentle Rust ON; 322 / 320 / 2, 323 applications, final `StockRound 12`, **`74db6e4bad736fec`**; never leaves phase 2; 0 marks observed on any board → exercises no Final Run |
| legacy discards supplied | 0 |

Per file (stored / applied / dropped / applications / final digest): golden/7NZ 1/1/0/1 `2bec63ba91a01f41`; golden/CV4
177/141/36/143 `634e59689c701d41`; golden/G6J 10/10/0/10 `bde799dd7250d3a4`; server/7NZ 1/1/0/1 `2bec63ba91a01f41`;
server/8E8 33/31/2/31 `6c1a10776682f986`; server/CV4 177/141/36/143 `634e59689c701d41`; server/CW7 124/118/6/120
`8bc920d2b650bfd7`; server/FCJ 1106/932/174/935 `25dfca52e2201519`; server/G6J 30/28/2/28 `708534641fa857e5`; server/TQQ
1/1/0/1 `225d78c7a1cdf8ac`; server/Z6C 615/604/11/609 `beae165e157d0763`; export/3XD 322/320/2/323 `74db6e4bad736fec`;
export/CV4 150/120/30/122 `2d84a9a17c1e9648`; export/JJD 6/6/0/6 `8571bb7d1fc1fca0`; export/QVC 93/70/23/73
`7e457761dc6d8ae6`; export/Y8V 668/628/40/632 `b4fae877c35604fe`; prefix/FCJ-96 96/92/4/93 `1381bd89f93002a0`;
fixture/Z6C-494 495/487/8/492 `37f96a9f765e6d84`. **No file rewritten, repinned, patched or regenerated.**

## N. Replay / version handoff to GR-5

GR-4 changed **no gameplay semantics** (tests, documents and one derived-statistics module; the reducer dist is
byte-identical to `4f4844a`). The semantic set
GR-5 must place behind the deliberate **8 → 9** boundary is exactly:

1. **GR-1** — self-trigger grace timing / qualifying-turn correction (`pending_rust_doomed_this_turn`; fallbacks spend only
   the qualifying turn's marks).
2. **GR-2** — reprieved-train sale refusal (OD-GR-1).
3. **GR-2** — reprieved-train Diesel trade-in refusal (OD-GR-2).
4. **DT-1** — Buy-Trains auto-skip no longer ends a corporation's turn at the train limit while a legal one-for-one Diesel
   exchange remains.

GR-3: replay-neutral (UI / copy / narration; one derived statistics fate — a standard first-D trade-in "traded" rather than
"rusted" — which is presentation, not reducer state). GR-4: measurement / tests / documents, plus the U-9 statistics
correction (#1704), which is likewise derived post-game history and not a replay semantic: no board, message or digest
changes, so it needs no rules-engine version.

Still owed at certification closure (GR-5 / final gate, not GR-4): the backlog Part D entries for OD-GR-1 / OD-GR-2 / OD-GR-3
(audit §11 gate item 1); the single version bump (item 7); full Jest and build at the certification commit (item 8).

**Recorded separately (not expanded here):** `trimToTrainLimit` (`trainLimit.ts:275`) is globally dead in production — its
only import (`sandboxSession.ts:49`) is unused. Its Gentle Rust tests are relabelled "DEAD HELPER, not live authority"
(`gentleRustLimit`, `gentleRustExemption`, `batch37`) and their useful expectation is re-proved on the live authority (Cert
"discard", Game G2); `stage95GhostLimit.test.ts` keeps it as a Yellow Sign counter-example. Removing the helper and the
unused import is a separate code-removal item. A stale `variantRules.test.ts` case titled "counts the reprieved trains
against the train limit" (#979's rule) is relabelled SUPERSEDED BY #1034 and now also asserts the train-limit count.

## O. GR-4 verdict

**READY FOR OWNER GATE / READY FOR GR-5 (r2).** 29 of 30 clauses CERTIFIED behaviourally; GR-S26 DEFERRED BY SPEC;
invariants A–H green; P1–P9 durable; the constructed legal game reaches the first 4, first 6 and first D and replays
deterministically; corpus 18/18 unchanged; no gameplay code changed. U-9 is owner-ruled (destruction-time) and implemented
in derived statistics (#1704). One pre-existing, non-Gentle-Rust statistics gap (excess discards unrecorded since #1530) is
reported for an owner decision, not changed — backlog Part C U-41. **Gentle Rust is NOT fully certified until GR-5.**

### Validation (container clone; the owner runs the full suite)

* Focused (r1): **150 suites / 3,147 tests pass**; after the U-9 correction (r2): **151 suites / 3,159 tests pass** — the same set plus `ceremonySounds`, a history
  consumer (new:
  `gentleRustCertificationGame` 34, `gentleRustCertification` 13, `gentleRustCertificationStats` 9; GR-1 24, GR-2 26, DT-1 19, GR-3 28 + 23 + 3; lifecycle, route, forced purchase / emergency
  funding, train limit / discard, sales, Diesel, LPF, replay (incl. `replayGolden`, `replayJuno3XD`,
  `stage104HarnessHardening` with the corpus present), variant wiring, fleet-loss narration, statistics / history,
  Rules Reference, RoomSession).
* `frontend tsc --noEmit` exit 0; `server tsc --noEmit` exit 0.
* Frontend production build exit 0 (49 warning lines, as at HEAD) — re-run after r2: exit 0, 49 warning lines, none in
  `gameHistory.ts`.
* r2 history comparison: compiled `gameHistory` of `4f4844a` vs the working tree over the 18 corpus logs — accolades,
  autopsy and round samples identical 18/18 (§L).
* 18-file corpus: §M. Constructed game: §G.4. `git diff --check`: clean.
