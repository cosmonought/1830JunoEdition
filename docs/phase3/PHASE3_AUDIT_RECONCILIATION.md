# Phase 3 — audit reconciliation matrix

**What this is.** A one-to-one reconciliation of every substantive item in the authoritative Phase-3 UI/UX audit
([`PHASE3_UIUX_AUDIT_2026-10-03.md`](PHASE3_UIUX_AUDIT_2026-10-03.md)) against current source and against the parallel
execution-map draft ([`archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md`](archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md)).
The execution plan that implements these dispositions is [`PHASE3_EXECUTION_PLAN.md`](PHASE3_EXECUTION_PLAN.md).
The machine-checkable form is [`phase3_accounting.json`](phase3_accounting.json), checked by
[`check_phase3_accounting.py`](check_phase3_accounting.py).

**Authority order.**
1. The audit is the authoritative statement of the known backlog. The plan may reorganize its items; it may not drop one.
2. Current source at the planning snapshot decides whether a described implementation fact is still true.
3. The execution-map draft is a proposed decomposition only. Its real source findings that the audit lacks are kept below as
   **NEW-SOURCE-FINDINGS** (`P3-N###`).

**Planning snapshot (source facts only — NOT the implementation base).** `recon/phase1-remainder-hardening` at
`8e897f9c5196f825a69c492dfb7c29088123cf67`. The Phase-3 implementation base is **TBD — the final canonical integrated head
after Phase 2 closes** (OD-0 in the plan).
Wave 1 was built on `8f33f0fb72d462c381a572015de7860a93fbd198` by the owner's brief and integrated provisionally on
`phase3/wave1-integration` (see "Wave-1 integration status" below). The CURRENT-SOURCE STATUS column still records the
planning snapshot; each row's progress since is its `status`.

**Snapshot facts, measured.**
- The audit read `7b1a956` (`live6/live-closure-candidate-w1`). Between `7b1a956` and `8e897f9`, `frontend/src` differs only by
  two added test files (`money/keplrWallet.test.ts`, `utils/jx2aKmsSigningParity.test.ts`). No production frontend file changed.
  **So no audit item can be "resolved since the audit".** Items whose source already contradicted the audit when it was
  written are marked `RESOLVED (audit text stale)` with evidence and disposition **F**.
- The draft read `083d066`; its `frontend/src` is byte-identical to `8e897f9`'s. Its line numbers therefore hold at `8e897f9`
  (`App.tsx` = 15,558 lines), apart from the corrections recorded in the rows.

**How rows were verified.** Every row marked CONFIRMED / PARTIAL / RESOLVED was checked by reading `8e897f9` source on
2026-10-03 (about 110 claims). NOT RE-VERIFIED means a behavioural claim that needs a runtime reproduction; NOT CODE means an
observation, decision or process item.

## Disposition key

- **A** — PHASE-3 IMPLEMENTATION — mapped to an existing W-slice
- **B** — PHASE-3 IMPLEMENTATION — new W-slice or explicit addition to an existing slice
- **C** — PHASE-3 OWNER DECISION — gated by the named OD
- **D** — PHASE-4 PLAYTEST DISCOVERY — the audit explicitly says playtest
- **E** — LATER PHASE — only where the owner already placed it later
- **F** — ALREADY RESOLVED / RESOLVED (audit text stale) — with source evidence
- **G** — BLOCKED / NEEDS RECONCILIATION — audit and source genuinely disagree

## Totals

| Block | Rows | Dispositions |
|---|---|---|
| Audit items (`AUD-*`) | 167 | A 61 · B 45 · C 14 · D 22 · E 2 · F 23 · G 0 |
| Flourish-ledger items the audit counts (`VF/*`: 47 PLAYTEST, 21 recorded owner decisions, 23 OPEN) | 91 | A 0 · B 17 · C 6 · D 47 · E 0 · F 21 · G 0 |
| **Substantive audit items, total** | **258** | A 61 · B 62 · C 20 · D 69 · E 2 · F 44 · G 0 |
| Execution-map-only NEW-SOURCE-FINDINGS (`P3-N*`) | 26 | A 23 · B 0 · C 0 · D 0 · E 1 · F 2 · G 0 |

- **G = 0 among the audit's own items.** Where the audit and source disagree, the source evidence was unambiguous and the
  row is **F**, re-confirmed at the final integrated head in W3-F. P3-N024 (SBS-4) was G after the owner's OD-2 ruling
  (needs a precise reproduction); the v13 scope verification reproduced it precisely and W3-K implemented it (G → A).
- **Totals after the Wave-1 integration (2026-10-03):** AUD-09.10 (RR-4) moved C → B when OD-7 was ruled and implemented as
  copy; P3-N024 moved C → G under OD-2. The planning-snapshot totals were A 61 · B 59 · C 23 (audit) and C 2 · G 0 (P3-N).
- **Totals after the safe Wave-2 integration (2026-10-03):** AUD-07.03 (K-06 / U-17) moved C → B when OD-11 was ruled (build) and W3-E landed; AUD-20.01 (U-44) moved C → B when OD-9(a) was ruled and W2-K landed. AUD-18.05 (the Keplr logo) stays C, ASSET PENDING.
- **Totals after W3-K (rules v13, 2026-10-03):** P3-N023 (SBS-3) C → A and P3-N024 (SBS-4) G → A, both IMPLEMENTED on
  `phase3/w3-k-rules-v13`. The audit rows keep their dispositions (DH-1, GR-1, VF D-18 and D-22 stay C with updated
  status; OD-10(a) ruled them out of v13).
- **Every audit bullet** (123 bullets in §1–§21) and every item-bearing statement outside them (scope, gate, highest-risk,
  the Phase-4 list, the closing remark) maps to at least one row; every `AUD-*` / `VF/*` row is reached from the audit. See
  the bullet map at the end and `check_phase3_accounting.py`.
- **One row, one disposition.** Where the audit names an item twice (U-22 in §4 and §11; RR-7 in §9 and §21; U-35's gotcha in
  §10 and §21; I-1/R4 in §2/§3 and §19), there is one row with both references. Where one audit bullet holds several
  distinct defects, it is split into several rows.

## Wave-1 integration status (2026-10-03)

**Branch** `phase3/wave1-integration` from base `8f33f0fb72d462c381a572015de7860a93fbd198` (the owner's Wave-1 brief). **PROVISIONAL — integrated, owner broad gate #1 pending; not merged to main.** Planning record:
`6455b6ecad5754a9e980c64e1cee2a4a417bc447 (phase3/reconciled-execution-plan)`. Wave 1 was implemented on 8f33f0f by the owner's brief. Whether 8f33f0f is the OD-0 pin, or Wave 1 is carried onto the final post-Phase-2 head, is the owner's call; OD-0's drift check against the final pin is still owed.

| Lane | Branch @ head | Slices |
|---|---|---|
| L1 | `phase3/w1-stock-auction` @ `76056b7` | P0 S1, W1-A, W1-B |
| L2 | `phase3/w1-private-powers` @ `6f42dca` | W1-C, W1-M |
| L3 | `phase3/w1-offers-rescind` @ `3dbf02b` | W1-D |
| L4 | `phase3/w1-map-route` @ `bee2717` | W1-E, W1-F, W1-G |
| L5 | `phase3/w1-shell-status` @ `fee2f66` | W1-I (unconditional), W1-J |
| L6 | `phase3/w1-refusals-reference` @ `8d6f1e9` | W1-H, W1-L (unconditional) |
| L7 | `phase3/w1-endgame-hostgame` @ `b19dff5` | W1-N (non-RED), W1-O (non-RulesReference) |

Integration commits: RED R2 (OD-12, W1-N) `87d63c4`; W1-N follow-up (comments only) `819a204`; OD-7 Rules Reference copy (RR-4) `ca73834`; cross-lane reconciliation `8dc79e0`; shared pin repairs (actionReceipt, sellThenBuyLock, sourceGuards G2) `7199b07`; review fix: one contest-end count (auction dashboard) `d6fe5a6`.

**Slice status** (machine copy: `slice_status` in `phase3_accounting.json`; wave-2 and wave-3 slices not listed are NOT STARTED):

| Slice | Status |
|---|---|
| P0 | PARTIAL — only the S1 seam landed (L1 `42c67ee`); the OD-0 drift check, the conventions publication and the roadmap-order update (AUD-00.02) were not run |
| W1-A | COMPLETE — L1 `82c1de9` (Stock Round reads one authority) |
| W1-B | COMPLETE — L1 `f0a7183` + review fixes `76056b7` |
| W1-C | COMPLETE — L2 `91b537f`; modal presentation follow-up at the integration (`8dc79e0`) |
| W1-D | COMPLETE — L3 `94e5df1` + review fixes `3dbf02b`; rescind Activity Log lines at the integration (`8dc79e0`) |
| W1-E | COMPLETE — L4 `43a641f` + review follow-ups `bee2717`; canonical tile name in the ring refusal at the integration (`8dc79e0`) |
| W1-F | COMPLETE — L4 `9baf4da` |
| W1-G | COMPLETE — L4 `a8b9f27` + review follow-ups `bee2717` |
| W1-H | COMPLETE — L6 `2e0700b` + review fixes `cb0c49c` |
| W1-I | PARTIAL — the unconditional portion is complete (L5 `9dcad19`, `b9fd1bf`, `82b93ca`, `beac07a`, `3904533`, `fee2f66`); OD-14(a) remains (the fit-probe removal, AUD-01.01, waits on it, and W1-I-b exists only if it is ruled in) |
| W1-J | COMPLETE — L5 `5a56987` |
| W1-K | NOT STARTED — not one of the seven Wave-1 lane branches |
| W1-L | COMPLETE — unconditional portion, L6 `de22084` + review fix `8d6f1e9`; RR-4 copy per OD-7 at the integration (`ca73834`). AUD-18.07 stays owner-gated (OD-14(e)) |
| W1-M | COMPLETE — L2 `6f42dca` |
| W1-N | COMPLETE — L7 `9d9376b` + review fixes `06c3a91`; the OD-12 RED R2 call-site deletion `87d63c4` (+ comment follow-up `819a204`); tie-aware game-over strip at the integration (`8dc79e0`) |
| W1-O | COMPLETE — L7 `2c3134f` + review fix `b19dff5`; the RulesReference breakpoint hunk at the integration (`8dc79e0`) |
| W3-K | COMPLETE — ACCEPTED (owner, 2026-10-04) and INTEGRATED on `phase3/wave2a-v13-integration` (2026-10-04): `phase3/w3-k-rules-v13` @ `be1fd10` merged `--no-ff` onto `phase3/wave2a-integration` @ `96ccb22`, its 9 commits carried unchanged (same SHAs). OD-2, SBS-3, SBS-4, OD-4 with the owner's 2026-10-04 rulings 1-5 and the four review findings. The ledger's PARTIAL (held only for the shared row AUD-03.04) lifted with W2-B's one-click "Pass Turn" control, integrated on `phase3/wave2-bcg-v13cert-integration` (merge `181e51e`). v13 settlement certification PASS / CERTIFIED and INTEGRATED there (merge `69c7496` of `phase3/v13-settlement-certification` @ `7916763`). RULES_ENGINE_VERSION 13; supported live [13]; settlement-certified [10, 11, 12, 13]. Not deployable until drained v12 rooms and the final integrated owner gate (W2-D / W2-F and other open slices are tracked separately) |

*(At the Wave-1 integration: W2-A, W2-B and W2-F were not started and W3-K had not landed.)* Since then W2-A is COMPLETE and integrated ("Wave-2A integration status"), and W3-K is ACCEPTED and INTEGRATED, its ledger PARTIAL lifted with W2-B; W2-B, W2-C, W2-G and the v13 settlement certification are COMPLETE and integrated ("Wave-2 B+C+G + v13 certification integration status"); W2-D and W2-F are NOT STARTED, UNLOCKED. Every W1 row's own status (`IMPLEMENTED`, `PRE-WORK DONE`,
`OPEN`, `NOT STARTED`, `RULED`, `NEEDS PRECISE REPRODUCTION / CLARIFICATION`) is the `status` field of its JSON row; the
checker verifies that a COMPLETE slice has no unimplemented A/B row and that each status agrees with its disposition.

**Owner rulings recorded (2026-10-03)** — full text in the plan, §7.3:

- **OD-1 — AUTHORITATIVE HOLD PRESENTATION.** Recorded only. Not implemented in the Wave-1 integration: W2-A and W2-F implement it (W2-G and W2-H take its viewer scope). The Routes/Dividends spectator visibility is unchanged by Wave 1.
- **OD-2 — STOCK ROUND PASS.** Recorded as RESOLVED; NOT implemented in the Wave-1 integration (no rules or version change). SBS-2 goes to the v13 rules slice (W3-K is its vehicle) with its own settlement certification; W2-B presents the one-click "Pass Turn". P3-N024 (SBS-4) becomes G: needs precise reproduction / clarification. The rules version stays v12.
- **OD-7 — FORCED TRAIN PURCHASE.** Implemented as copy at the Wave-1 integration (`ca73834`): every RR-4 site in `components/RulesReference.tsx` corrected; the engine (which already allowed any legal treasury-funded purchase) is unchanged. AUD-09.10 C → B, IMPLEMENTED. W2-J and W3-K no longer carry RR-4.
- **OD-12 — RED REGIONS.** W1-N's R2 call site deleted as its own commit (`87d63c4`, independently reviewed: APPROVE WITH NITS, comment nits fixed outside RED in `819a204`). The remaining OD-12 candidates (W2-J K-18; W3-C, W3-B, W3-I, W3-A, W3-H) each still land as one separately reviewed RED commit under §5.1's serialization rule.
- **OD-4 — EMERGENCY FUNDING (AUTOMATIC BANKRUPTCY).** Implemented in W3-K on `phase3/w3-k-rules-v13` (rules v13, gated on rules revision 2). W2-G (AUD-09.05/06/07, P3-N017/018) must be reconciled to the v13 authority before it starts. Settlement certification for 13: PASS / CERTIFIED on `phase3/v13-settlement-certification` (bankruptcy vectors included; not yet integrated). The 2026-10-04 rulings 1, 4 and 5 and the four review findings are implemented on the same branch.
- **OD-10 — V13 RULES BATCH IN PHASE 3.** W3-K implemented on `phase3/w3-k-rules-v13` (branch only). AUD-04.04 and AUD-08.01 leave W3-K (owner placement open; no version bump needed). P3-N023 and P3-N024 C/G → A, IMPLEMENTED. OD-10(b) stays open. The 2026-10-04 rulings 2 and 3 are implemented on the same branch. v13 settlement certification: PASS / CERTIFIED on `phase3/v13-settlement-certification` (not yet integrated).
- **OD-17 — TILE-UPGRADE CROSS-REFERENCES.** VF/D-18 and VF/D-22 stay C (the ledger still lists them OPEN) with status RULED — no change; the ledger and comment cleanup is a docs task (closure contract item 12).

Remaining Wave-1 owner blocker: **OD-14(a)** (W1-I's fit-probe removal and the optional W1-I-b). W1-K was not in Wave 1.

## Safe Wave-2 integration status (2026-10-03)

**Branch** `phase3/wave2-safe-integration` from `phase3/wave1-integration` @ `4e51cff`. **PROVISIONAL — integrated, owner broad
gate pending; not merged to main.** Each input's delta after its accepted Wave-1 parent was merged `--no-ff`; every slice delta and
Wave-1's own integration edits reverse-apply on the result.

| Slice | Branch @ head (parent) | Merge |
|---|---|---|
| W2-H | `phase3/w2-waiting-prompts` @ `461d4f0` (L5 `fee2f66`) | `66977d5` |
| W2-E | `phase3/w2-mh-queued-visibility` @ `91037ce` (L2 `6f42dca`) | `09fcb25` |
| W2-L | `phase3/w2-postgame-statistics` @ `e16aa5a` (`8f33f0f`) | `615e183` |
| W3-E | `phase3/w3-manual-city-bypass` @ `6d7cfa1` (L4 `bee2717`) | `a860178` |
| W2-K | `phase3/w2-money-copy` @ `e223f64` — exact SHA `e223f647bf544ed2fffaf3d56bc9b5c96994ed98` verified (L7 `b19dff5`) | `fb4eee5` |

Integration commit: `8d6feaa` — `utils/tileRingView.test.ts` `import/first` hygiene (Wave-1 residue; test-only, no semantic change).

**Slice status:** W2-H, W2-E, W2-L and W3-E COMPLETE (their A/B rows IMPLEMENTED; AUD-07.03 C → B under OD-11). W2-K:
PARTIAL — integrated (AUD-20.01 C → B under OD-9(a)); **the official Keplr logo is ASSET PENDING** (AUD-18.05).
**W2-G: IN PROGRESS — implemented (`695afe9`, UI accepted) but HELD, NOT integrated** (it removes the bankruptcy button while v12
still has authority states that require it; it lands with the OD-4 v13 work). **W3-K is not complete and settlement v13 is not
certified**; `phase3/v13-scope-verification` is not merged — its evidence is reconciled during W3-K. The tutorial architecture
remains later spotlight / whitebox work. Rules version unchanged (v12).

**Owner rulings recorded:** OD-9(a) and OD-11 (plan §7.3). OD-3, OD-13, OD-14(d) and OD-14(i) were applied by W2-E / W2-L / W2-K as
given to those slices; not transcribed (their text is not in the integration brief).

## Wave-2A integration status (2026-10-04)

**Branch** `phase3/wave2a-integration` from `phase3/wave2-safe-integration` @ `bfb7635` — **the current provisional Phase-3 integration
baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** W2-A is **ACCEPTED and INTEGRATED**: its two
commits (`e5fcfcc` code, `2d0fd0a` tracking; slice branch `phase3/w2-a-authoritative-holds`) are carried linearly and unchanged, followed by
one tracking-only integration commit. Rules version unchanged (v12); no runtime code beyond the reviewed W2-A commits.

**Lanes after W2-A:** W2-B NOT STARTED — **BLOCKED** on W3-K's v13 semantics (OD-2). W2-C, W2-D and W2-F NOT STARTED — **UNLOCKED**.
W2-G remains HELD. W3-K remains BLOCKED pending owner rulings / review (nothing of it is integrated here).

### W2-A slice record

**Slice branch** `phase3/w2-a-authoritative-holds` @ `2d0fd0a` (code `e5fcfcc`) from `bfb7635`; integrated as above. One pure hold answer, `utils/dockHoldView.ts`, asks
`authoritativeHoldRefusal` once per control with the message kind it sends; `App.tsx` derives it once (`dockHold`) and threads it to
the bar's new `turnHoldReason` (Skip, End Turn, Pay / Withhold, Run Trains), the Stock Round / auction Pass, the tile-lay gate, the
token ring, the train panel (`blockedReason`, new `bankBlockedReason`, returned trains, Diesel) and the private-purchase panel.
Resolvers keep their prompts; Routes / Dividends informational readouts for non-active seats are unchanged (OD-1). AUD-04.01,
AUD-06.02, P3-N001, P3-N002 and P3-N009 IMPLEMENTED. Residue outside its rows: the Stock Round share controls and the M&H chip still
read `privateTradeHoldReason` (the same answer on every reachable board) -- W2-C / W2-F. W2-B / C / D / F not started; W2-G held;
W3-K not complete. Rules version unchanged (v12).

## Wave-2A v13 integration status (2026-10-04)

**Branch** `phase3/wave2a-v13-integration` from `phase3/wave2a-integration` @ `96ccb22` — **the current provisional Phase-3 integration
baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** W3-K is **ACCEPTED and INTEGRATED**: `phase3/w3-k-rules-v13`
@ `be1fd10` merged `--no-ff` (`ed5e69a`), its 9 commits carried unchanged; one explicit reconciliation commit (`447e28d`, test-only: the W2-E
queued-M&H fixture walked revision 1's two-Pass turn on a current-revision board; under OD-2 one Pass Turn is the boundary); then one
tracking-only commit. Code merged without textual conflict; in each shared file (App.tsx, RulesReference.tsx, actionLog.ts,
phase65bShellWiring.test.ts) the result is Wave-2A plus exactly W3-K's own delta. W2-A, W2-H, W2-E, W2-L, W3-E and W2-K behaviour is preserved.

**Versions:** `RULES_ENGINE_VERSION` 13; live list `[13]`; settlement-certified `[10, 11, 12]` UNCHANGED; v13 settlement certification
**PENDING** ([`V13_SETTLEMENT_CERTIFICATION_VECTORS.md`](V13_SETTLEMENT_CERTIFICATION_VECTORS.md)).

**Lanes:** W2-B **UNLOCKED** for implementation against the integrated v13 semantics. W2-G **UNLOCKED FOR v13 UI RECONCILIATION** (not
accepted, not integrated). W2-C, W2-D and W2-F remain **UNLOCKED**. Not deployable until W2-B, the v13-reconciled W2-G, the v13 settlement
certification, drained v12 rooms and the final integrated owner gate.

**Independent verification (2026-10-04, separate session, nothing pushed):** the merge was rebuilt from `96ccb22` + `be1fd10` and its
code tree equals `ed5e69a`; the development-corpus closures were run WITH the owner's 13 gitignored corpus files (the canonical 18-file
corpus: 10 files, 206/206). **Residue recorded, not fixed (no code here):** (R1, W2-G / W2-C) on a revision-2 board the train panel's
Propose stays live after the trade window closes (`fundedTradeRefusal` refuses it; `dockHold.proposeTrainPurchase` asks only the hold,
which lets `ProposeTrainPurchase` through) — W2-A's funding-hold matrix runs only at revision 0; (R2, inherited from W3-K, owner placement)
the post-game statistics (`gameHistory.ts`) count `SellStock` only, so `EmergencySellPortfolio` legs and the automatic liquidation are not
seen, and the president's emergency contribution is booked by the `EmergencyBuyHardware` actor, which on the derived path can be another
seat.

## W2-B slice status (2026-10-04)

**Branch** `phase3/w2-b-stock-round-v13-ui` (code `90d5588`, review fix `ca68b43`, #1274 fix `794e03c` / `699160c`) from `phase3/wave2a-v13-integration` @ `868bd83`. **COMPLETE on its slice branch;
NOT integrated** into the provisional baseline (integration and owner broad gate pending). *(Written as branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave2-bcg-v13cert-integration`, merge `181e51e` — see "Wave-2 B+C+G + v13 certification integration status" below.)* OD-2 presented over the integrated v13 reducer,
with no reducer change: the action bar's Stock Round control is one "Pass Turn" that sends one `PassTurn` in every state (its title says
whether the press ends an acted turn or is a true pass, off `turn_action_taken`); #1443's stage button, the `stockStage` / `onShowStocks`
props and the revision-1 copy ("Done selling…", "Buy a Share", "End Turn", "Skip Buy Share") are gone; Sell / Buy availability stays the
stock authority's on the Stocks tab (the second ordinary Buy greys with its sentence, Sell stays live). Auto-Buy's obsolete stage Pass is
removed, and it sends no Pass after its purchase (#1274: a standing instruction to buy is not one to pass): `autoBuyTurnStep` buys at once
and, once the turn's one purchase is committed, hands the turn back -- the seat stays with the player, who may sell and then presses Pass
Turn; the plan stays armed for their next turn. The must-sell banner
(AUD-03.07) reads the viewer's `divestmentDebt`, the same reading that greys the Pass (not drawn while scrubbing the epilogue replay).
W2-A's holds unchanged. **Accepted limitation:** on a legacy revision-1 board -- reachable only as a development-corpus replay on a
local server (live rules are `[13]`) -- the one Pass Turn's first press walks that board's own Sell -> Buy stage, as its reducer revision
says; there is no v12 shim (OD-2). Independent review: APPROVE WITH NITS; nits 1, 2 and 4 fixed in `ca68b43`. Owner review blocker (#1274: the post-buy `PassTurn`) fixed in
`794e03c`; its narrow review (APPROVE WITH NITS) followed up in `699160c` (the hand-back keeps the Auto-Buy watch current, so the
player's own post-buy sale does not stop the plan). AUD-03.04 and AUD-03.07
IMPLEMENTED. **W3-K ledger reconciliation:** AUD-03.04 was the only row holding W3-K at PARTIAL, so on this branch the ledger reads W3-K
COMPLETE; no W3-K work changed, and on the provisional baseline that follows W2-B's integration. Rules 13, live `[13]`, settlement
`[10, 11, 12]` unchanged.

## W2-G v13 reconciliation status (2026-10-04)

**Branch** `phase3/w2-g-v13-emergency-ui` from `phase3/wave2a-v13-integration` @ `868bd83`: code `112fa71`, independent-review
fixes `02d73b8`, then this tracking commit. **W2-G: COMPLETE on its slice branch — NOT integrated**, not merged to main, no broad owner gate. *(Written as branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave2-bcg-v13cert-integration`, merge `b84247f`.)*

- **Reused from `695afe9` (accepted UI):** the non-dismissible president-only modal (OD-4 / OD-1), the intercorporate step first,
  the K-25 "Bank Pool" / "Bank Depot" from `train.source`, the automatic treasury / cash ledger, the authority-judged trade and
  private offers (`proposeTrainPurchaseRefusal`, `fundingPrivateOfferRefusal`), the in-modal answer when the president presides
  over the buyer, the press latch, the waiting sentence for every other seat and watcher.
- **Discarded v12 assumptions:** the presentation-only Skip (now the real `ForgoTrainTrade`, with the authority's projected
  consequence); one `SellStock` per press (now ONE `EmergencySellPortfolio` judged by `emergencyPortfolioRefusal`); the
  president's Buy (`EmergencyBuyHardware` is derived by the game; W3-K's no-server forwarding untouched); the "faces bankruptcy"
  guess; the private section shown whenever a private could be offered (now only while `automatic.privateFunding` is relevant);
  `DeclareBankruptcy` (no control or message anywhere). A legacy (revision < 2) board gets no forced dialog and no v12 control.
- **Waiting surface:** W2-H's `WaitingStatusBanner` (not modal, focusable, no controls). W2-A holds unchanged.
- **Rows implemented:** AUD-09.05, AUD-09.06, AUD-09.07, P3-N017, P3-N018. The AUD-14.06 latch residue stays W3-B's.
- **Residue (not W2-G's surface):** the bar / `TrainPurchasePanel` still declare the now-unpassed `onEmergencyPurchase` /
  `emergencyAvailable` props (W2-A's bar test feeds them); removal belongs to a later bar pass.
- **Versions:** rules 13 UNCHANGED; settlement-certified `[10, 11, 12]` UNCHANGED. No AWS, no JUNO.

## W3-K status (rules v13, 2026-10-03)

**Branch** `phase3/w3-k-rules-v13` from `phase3/wave1-integration` @ `4e51cff`; not merged to main. *(Written as branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave2a-v13-integration` — see "Wave-2A v13 integration status" above.)*

- **Resolved and implemented (rules revision 2):** OD-2 (one `PassTurn` ends a Stock Round turn), SBS-3 and SBS-4 (the
  official Brown Bank Pool continuation), OD-4 (automatic emergency funding: `EmergencySellPortfolio`, `ForgoTrainTrade`,
  `ForgoPrivateFunding`, the automatic purchase and the automatic bankruptcy; `DeclareBankruptcy` refused).
- **Out of W3-K:** DH-1 and GR-1 / S10-27 (derivation-only, no version bump); GR-1b (UI only); D-18 (invalid: the printed
  rule); D-22 (already correct since Stage 9.3); RR-4 (copy, OD-7); V-6.3 "Buy All" (not implemented).
- **Owner rulings 2026-10-04 (implemented):** "only enough" is no redundant / oversized leg, never a global minimum
  overshoot (1); an active-player turn action closes the Brown continuation, an off-turn answer does not (2); the M&H
  exchange stays outside stock-turn accounting (3); one leg per corporation (4); private funding relevance is exact (5).
  Review findings fixed: bankruptcy narration, no-server derived purchase, Rules Reference copy, changelog wording.
- **Versions:** `RULES_ENGINE_VERSION` 13; live list `[13]`; settlement literal `[10, 11, 12]` — v13 certification PENDING *(at W3-K; since 2026-10-04 CERTIFIED and integrated: `[10, 11, 12, 13]`, see below)*
  ([`V13_SETTLEMENT_CERTIFICATION_VECTORS.md`](V13_SETTLEMENT_CERTIFICATION_VECTORS.md)).
- **Not deployable alone.** Still required before deployment: W2-B with the Auto-Buy correction; W2-G reconciled to
  the v13 UI authority; the dedicated v13 settlement certification; pinned v12 rooms drained; the final integrated owner
  gate. (W2-A and the safe integration reconciliation are done on `phase3/wave2a-v13-integration`.)

## W2-C slice status (2026-10-04)

**Branch** `phase3/w2-c-offer-authority` @ `0975c04` (code `e629687`, independent-review fixes `0975c04`) from `phase3/wave2a-integration` @
`96ccb22`. **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending). *(Written as branch-only on the pre-v13 base; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave2-bcg-v13cert-integration`, merge `904598a`, reconciled onto v13 with no code change.)* A pure binding,
`utils/offerAuthorityView.ts`, hands each offer panel the engine's own predicate, bound once per board (beside `dockHold`) to the
seat and the operating corporation: the Buy Private Company panel asks `proposePrivatePurchaseRefusal` (card availability at the
band's floor, the submit at the typed price); the corporate train roster asks `proposeTrainPurchaseRefusal`, or `trainSaleRefusal`
at "settlement" for the same-president sale the shell sends directly (each badge at the $1 opening offer, the form at the typed
price). The panels' local copies of the law are deleted (`offerPriceProblem`, `privatePurchaseBlockReason`, `trainPriceError`, the
roster's train-limit arm); refusals are the authority's sentences. W2-A's hold answer is unchanged and still asked first: under a
hold the predicates are not consulted and every card / badge carries the hold's sentence. The embedded `ProposePrivatePurchase`
submit is latched (the shell's in-flight latch plus a same-commit latch). Corporation-owned privates remain unlisted, now pinned.
AUD-09.02 and AUD-09.03 IMPLEMENTED. Tests: `phase3W2COfferAuthority`, `phase3W2COfferPanels`; moved pins `privateRowDensity`,
`baltimorePrivate`. Not taken: the Stock Round share controls / M&H chip residue W2-A assigned to "W2-C / W2-F" (outside W2-C's
surfaces). Rules version unchanged (v12); settlement unchanged.

## Wave-2 B+C+G + v13 certification integration status (2026-10-04)

**Branch** `phase3/wave2-bcg-v13cert-integration` from `phase3/wave2a-v13-integration` @ `16b79b2` — **the current provisional Phase-3
integration baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** Four accepted lines merged `--no-ff`,
every accepted commit carried unchanged (same SHAs), in the order W2-B, W2-C, W2-G, certification:

| Input | Accepted head | Merge |
|---|---|---|
| W2-B (Stock Round v13 UI, #1274 Auto-Buy fix) | `phase3/w2-b-stock-round-v13-ui` @ `3fc3d0e` | `181e51e` |
| W2-C (offer authority) | `phase3/w2-c-offer-authority` @ `c3db730` | `904598a` |
| W2-G (v13 emergency UI) | `phase3/w2-g-v13-emergency-ui` @ `17ab21f` | `b84247f` |
| v13 settlement certification | `phase3/v13-settlement-certification` @ `7916763` | `69c7496` |

Then one test-only integration commit (`70483ef`, the C+G train-window regression) and this tracking commit.

- **Code merged without a textual conflict.** `App.tsx`'s merged delta over `16b79b2` is exactly the union of W2-B's, W2-C's and W2-G's
  own deltas; `ContextualActionBar.tsx`'s exactly W2-B's plus W2-C's (one Pass Turn, no stage walk, W2-C's forwarded authority props,
  W2-A's holds). Every other code file only one input changed equals that input's tip.
- **Conflicts were tracking-only** (this file, `phase3_accounting.json`, `PROJECT_CANONICAL_CONTEXT.md`, `README.md`): independent
  sections kept; stale branch-only lines superseded here.
- **W2-C onto v13, and R1 closed.** W2-C was built on the pre-v13 Wave-2A base and needed no code change: on a revision-2 board
  `proposeTrainPurchaseRefusal` → `trainSaleRefusal` → `fundedTradeRefusal` refuses once the emergency trade window is closed, so the
  corporate roster follows the window through the authority, not through a local test. `phase3W2CGTrainWindow.test.tsx` proves it with
  the real reducer and the real panel bound as the shell binds it: OPEN — a legal candidate is offered and sent once; CLOSED by
  `ForgoTrainTrade` and CLOSED by `EmergencySellPortfolio` — no usable badge or submit, nothing sent, the authority's own sentence, while
  W2-A's hold still passes `ProposeTrainPurchase`. With the W2-C binding removed both closed cases fail. **R1 is CLOSED.**
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` `[10, 11, 12, 13]` —
  v13 settlement certification **PASS / CERTIFIED and INTEGRATED**. Compatibility keys unchanged from `7916763`
  (`dc1-e8d0b4792a7ba07e67199ad2` no escrow, `dc1-32fcc4967978e78f10874490` the fixture pin); fixtures not regenerated; frozen v10 / v11 / v12
  evidence unchanged.
- **Lanes:** W2-B, W2-C, W2-G and the v13 settlement certification **COMPLETE and INTEGRATED**. W2-D and W2-F remain **UNLOCKED** (not
  started). Not deployable until drained v12 rooms and the final integrated owner gate.
- **Follow-ups (non-blocking, not implemented here):** bankruptcy `executeEmergencyLegs` fail-loud hardening; post-game statistics miss
  `EmergencySellPortfolio` legs and the automatic liquidation (R2); the older `escrow3bAdversarial` uncertified-board assertion is weak;
  the now-unpassed `onEmergencyPurchase` / `emergencyAvailable` bar props (W2-G residue).

## Scope and closing remark

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-00.01** · — · Scope<br>The audit did not read GitHub issues (the session could not reach the API). | scope gap | NOT CODE — process gap. | W3-G | **B** | — | — | W3-G (U-28 closure) triages open GitHub issues for player-facing defects not in this matrix; each finding is added here as a new row before closure. |
| **AUD-00.02** · — · Closing remark<br>ROADMAP_3_2_REMAINING_WORK.md, PROJECT_CANONICAL_CONTEXT.md §B and backlog Part F still place UI/UX after the frontend refactor. | doc order | CONFIRMED — `PROJECT_CANONICAL_CONTEXT.md` §B lists 7: frontend cleanup before 9/10 UI/UX. | P0 | **B** | — | — | This pass adds only a pointer to PROJECT_CANONICAL_CONTEXT.md. P0 updates the roadmap file and Part F to the fixed Phase 1–7 order. |

## §1 Game shell / overall layout

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-01.01** · U-16 · §1<br>Temporary fit probe `useStickyFitProbe` in the action bar must be removed. | [UX] | CONFIRMED — `panels/ContextualActionBar.tsx`:713, 715-806, 1465, 4566-4570 ("TEMPORARY … this comes out"); renders with no dev gate. | W1-I | **A** | OD-14(a) (probe readout may inform it first) | — | Part C U-16: "Decide, then remove it either way." The removal happens whatever OD-14(a) decides, but only after it is recorded, because the probe is the instrument for that decision (AUD-01.02). |
| **AUD-01.02** · U-16 · §1<br>Decide whether the step panels move back into the action bar. | [UX] decision | NOT CODE — layout decision; the probe is its instrument. | W1-I (conditional sub-scope W1-I-b) | **C** | OD-14(a) | — | If OD-14(a) = move into the bar, lane 5 adds W1-I-b in wave 2 (3–5 h). If it = keep, no work. |
| **AUD-01.03** · Batch 4B · §1, §13<br>The game screen has no heading (focus target) or game-status region. | [UX] ★ | PARTIAL — tab-level `<h2>`s and `role="status"`/`aria-live` regions exist (e.g. `components/ActionToast.tsx`:368); no game-screen heading/`<h1>` focus target in the shell. | W3-A | **A** | OD-5 | — | The heading is the forced-notice focus target that AUD-13.02 needs. |
| **AUD-01.04** · A-14 · §1<br>Status-dock height fixed at 96 px because the dock's ResizeObserver never attaches. | [D] | CONFIRMED — `frontend/src/App.tsx`:3104-3123 (`useState(96)`, `useEffect(…, [])` returns while the ref is null; rooms render a gate first). | W1-I | **B** | — | — | Not in the draft map. Fix in the effect only (attach when the ref appears); no layout change. |
| **AUD-01.05** · A-21 · §1<br>Hex click indicators are misplaced at any uiScale other than 1. | [D] | CONFIRMED — `frontend/src/App.tsx`:14949-14989; `styles/appStyles.ts`:2432-2443 (`position: fixed`, `left: clientX + 16` inside the zoomed root; no uiScale correction). | W1-F | **B** | — | — | — |
| **AUD-01.06** · A-13 · §1<br>Tutorials reset on every AppShell mount. | [D] | CONFIRMED — `frontend/src/App.tsx`:1080-1083 (`replayTutorials` whenever the sandbox is in zero state; the default scenario is zero state). | W3-A | **A** | OD-5 (re-arm policy) | — | — |
| **AUD-01.07** · — · §1<br>The game id is not shown anywhere. | [UX] | PARTIAL — hosted tables show the room code only (`frontend/src/App.tsx`:13748, 13776); `StockMarketRenderer.tsx`:844 shows "Game #…" on the legacy path. | W2-I | **C** | OD-6 | — | LIVE-2 §7.2 says the game id is never displayed, so showing it is a product decision. |
| **AUD-01.08** · — · §1<br>The "UI build #640" stamp is stale. | [UX] | CONFIRMED — `utils/buildStamp.ts`:21 `UI_BUILD_NOTE = 640`; `components/RulesReference.tsx`:5412-5415. `CLIENT_BUILD_ID` exists (`config.ts`:129-132). | W1-I | **A** | — | — | Where the build id appears is part of OD-6; replacing the stale constant with `CLIENT_BUILD_ID` is not gated. |
| **AUD-01.09** · — · §1<br>Log export only through hidden Ctrl+Shift+L; a visible "Copy game log" button is wanted, including on the crash screen. | [UX] | CONFIRMED — `frontend/src/App.tsx`:9104-9144 (keydown → `copySandboxLog`, the only caller); `components/CrashScreen.tsx` has "Reload and replay" and "Copy error details" only. | W1-N | **B** | — | — | Not in the draft map. |

## §2 Auction / privates

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-02.01** · K-02 / U-26 · §2<br>The main bid control refuses raising your own standing bid. | [D] | CONFIRMED — `components/WaterfallAuctionDashboard.tsx`:24-29, 492-498 ("One bid per private company"); engine allows it (`gameEngine/auctionAuthority.ts`:311, D-16). | W1-B | **A** | — | — | — |
| **AUD-02.02** · K-15 · §2<br>The contest's "Drop out … refunded in full" control is wrong (a passer stays in the contest): label, behaviour, bidder list; Undo label "the last drop-out". | [D] | CONFIRMED — `WaterfallAuctionDashboard.tsx`:811-813; `frontend/src/App.tsx`:8998. | W1-B | **A** | — | — | — |
| **AUD-02.03** · — · §2<br>During a live contest, other seats' controls are not explained, and nothing shows how close the contest is to ending (`passes_since_raise`). | [UX] | PARTIAL — sibling controls ARE greyed (opacity) but read "Not your turn yet" (`WaterfallAuctionDashboard.tsx`:249-252, 844, 898); `passes_since_raise` has no UI reader (hint at 763-767). | W1-B | **A** | — | — | The greying half is not reproduced; the contest sentence and the ending indicator remain. |
| **AUD-02.04** · H-04 · §2, §14<br>A double-click on the auction dashboard sends twice (latch does not cover it). | [D] | CONFIRMED — `frontend/src/App.tsx`:14399/14416 `sessionReady={controlsEnabled}` without `actionInFlight`. | W1-B | **A** | — | — | — |
| **AUD-02.05** · I-1 · §2, §19<br>A second B&O par press after a reconnect produces an error banner (the first, queued, send lands later). | [D] | NOT RE-VERIFIED at runtime — mechanism per 6.5-B §11.5: needs the link's queued-submission state in the modal. | W3-I | **B** | OD-12 (only if the submit half or link drain must change) | — | The draft map deferred this to Phase 4; it is a known defect, so it stays in Phase 3. |
| **AUD-02.06** · I-2 · §2<br>The "not reached the table yet" note can flash after a send that did land. | [D] | CONFIRMED (copy present) — `components/AuctionPromptModal.tsx` `PAR_NOT_LANDED_NOTE`; timing per 6.5-B §11.5. | W3-I | **B** | — | — | The draft map called this cosmetic and deferred it; a known defect stays in Phase 3. |
| **AUD-02.07** · H5 (auction) · §2<br>The auction prompt's handoff state has no focusable control; blocked on the same product decision as the home-station prompt. | [UX] | CONFIRMED — modal audit H5; `AuctionPromptModal` handoffPending renders zero tabbable controls. | W2-H | **A** | OD-1 (RULED 2026-10-03) | — | — |
| **AUD-02.08** · — · §2<br>No standing "auction owed" indicator; a first-5-train cancellation of the Delayed Auction appears only as a log line. | [UX] | CONFIRMED by reading — no persistent indicator component found; the cancellation is narration only. | W2-I | **B** | — | — | Not in the draft map. Not gated by OD-6. |
| **AUD-02.09** · DA6-O1 · §2<br>The auction tutorial page "When everybody passes" is wrong. | [D] | RESOLVED (audit text stale) — closed at DA-7 (`RULES_HARDENING_BACKLOG.md`:3666, 3678); `components/TutorialModal.tsx`:120-133 states §1.2.3's two exclusive outcomes. | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-02.10** · H-02 · §2<br>B&O par prompt derived from the board. | [R] | RESOLVED — `boParOwedTo(liveState)` (6.5-B §1.2). | — | **F** | — | — | — |
| **AUD-02.11** · — · §2<br>All-pass narration fixed. | [R] | RESOLVED per audit; no contrary source found. | — | **F** | — | — | — |
| **AUD-02.12** · U-42 · §2<br>Blood Price surfaces fixed. | [R] | RESOLVED — Part C U-42 `RESOLVED` (UR-4/UR-6). | — | **F** | — | — | — |
| **AUD-02.13** · D-56 · §2<br>Delayed Auction blurb fixed. | [R] | RESOLVED per audit. | — | **F** | — | — | — |

## §3 Stock round

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-03.01** · U-23 / K-19 · §3<br>The first-Stock-Round sale ban is restated inside the panel, and its tooltip presents rulebook §5.1 as a house rule. | [D] | CONFIRMED (wording differs) — `components/StockRoundPanel.tsx` local `sellingForbidden`; tooltip "…Project 18XX opens the market to sales from SR2 onward" (a project rule, not §5.1). | W1-A | **A** | — | — | — |
| **AUD-03.02** · U-25 · §3<br>Par ladder, affordability, share source and multi-buy limit are computed locally; a 0% source still offers Buy. | [D] | PARTIAL — locals at `StockRoundPanel.tsx`:2333, 2412, 2426, 2557-2597, 2861, 2982; an empty source is disabled, but an IPO that is entirely C&A-reserved can be enabled. Engine `maxPurchaseQuantity` / `ordinaryPercentAvailable` exist unused. | W1-A | **A** | — | — | — |
| **AUD-03.03** · U-39 / K-07 · §3<br>Level Playing Field: a legal fifth certificate cannot be sold into the Bank Pool (panel keeps its own 50% cap). | [D] | CONFIRMED — `StockRoundPanel.tsx` `BANK_POOL_CAP_PERCENT`. | W1-A | **A** | — | — | — |
| **AUD-03.04** · SBS-1 / SBS-2 · §3<br>Forced sell → Pass → buy walk; ending a turn takes two Pass presses; target one Pass/End Turn control. | [UX] ★ | CONFIRMED — `frontend/src/App.tsx`:14042-14046; `panels/ContextualActionBar.tsx`:4151-4207; `gameEngine/sandboxSession.ts`:5590-5592. | W2-B (the one-click "Pass Turn" control) + W3-K (v13: PassTurn ends the turn) | **A** | OD-2 (RULED 2026-10-03: Sell whenever legal; at most one Buy; after buying, Sell remains; one-click "Pass Turn"; v13 rules slice + settlement certification) | — | The old Sell → Buy → Sell stage walk is superseded on rules revision 2 (W3-K). Wave-1's `sellBuySell` pins now pin revision-1 boards only. The audit cites OD-A-4 here; the 6.5-A register files the Pass question as OD-A-2; OD-2 answered OD-A-2. SBS-4 is P3-N024 (implemented in W3-K). **Status:** IMPLEMENTED — both halves: the rule in W3-K (rules v13 / revision 2: one `PassTurn` ends the Stock Round turn; integrated on `phase3/wave2a-v13-integration`) and the presentation in W2-B `90d5588` + review fix `ca68b43` + #1274 fix `794e03c` / `699160c` (`phase3/w2-b-stock-round-v13-ui`, integrated on `phase3/wave2-bcg-v13cert-integration`, merge `181e51e`): one "Pass Turn" control sending one `PassTurn`; the stage button, `stockStage` and the revision-1 copy removed; Auto-Buy's stage Pass removed, and no Pass after its purchase (#1274). |
| **AUD-03.05** · K-12 · §3<br>Auto-Buy never checks cash, so it stalls. | [D] | CONFIRMED — `frontend/src/App.tsx`:9888-9969; no cash test in `utils/autoBuy.ts` / `sharePurchase.ts`. | W1-A | **A** | — | See AUD-24.03 (the stall's UX is observed in Phase 4). | — |
| **AUD-03.06** · SBS-5 · §3<br>Auto-Buy passes the stage before checking the must-sell rule. | [D] | CONFIRMED — `frontend/src/App.tsx`:9917-9923 (stage pass) before 9927-9935 (divestment). | W1-A | **A** | — | — | — |
| **AUD-03.07** · — · §3<br>The must-sell hold is shown only in tooltips. | [UX] | CONFIRMED by reading — `divestmentRefusal` reaches `title` attributes only. | W2-B | **A** | — | — | **Status:** IMPLEMENTED — W2-B `90d5588` + review fix `ca68b43` (`phase3/w2-b-stock-round-v13-ui`; integrated on `phase3/wave2-bcg-v13cert-integration`, merge `181e51e`): a must-sell banner at the top of `StockRoundPanel`, from the viewer's `divestmentDebt` (`mustSellBannerOf`) -- the same reading and sentence that greys the Pass. |
| **AUD-03.08** · K-18 / U-36 · §3<br>The sold-out price-rise log line describes a further, hypothetical rise (mirror written before the line). | [D] | CONFIRMED — `frontend/src/App.tsx`:7000-7002 sets the mirror before `soldOutRises` at 7111-7123 (inside the RED apply half). | W2-J | **A** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | — |
| **AUD-03.09** · K-22 / U-37 · §3<br>A float is not logged until the corporation's first OR turn. | [D] | CONFIRMED — `utils/actionLog.ts`:470-486; `gameEngine/sandboxSession.ts`:7522. | W2-J | **A** | OD-8 | — | — |
| **AUD-03.10** · I-3 · §3<br>The 400 px prompt pointer overlaps the Private Companies card. | [D] | CONFIRMED — `components/PrivateCompaniesSection.tsx`:575-580 (`min(400px, …)`, fixed bottom-right; same at `PrivateTradePanel.tsx`:1071, `TrainPurchasePanel.tsx`:2469). | W2-F | **B** | — | — | The draft map deferred this as cosmetic; it stays in Phase 3. |
| **AUD-03.11** · R4 · §3, §19<br>The typed offer form is lost if a send is dropped. | [UX] | CONFIRMED — `PrivateCompaniesSection.tsx`:348-349 `onPropose(intent); setDraft(null);` unconditionally. | W3-I | **B** | — | — | The draft map deferred this; it stays in Phase 3. |
| **AUD-03.12** · S-4 · §3, Phase-4 list<br>The UI may be stricter than the engine about turn stages. | [PT] | CONFIRMED as a mechanism — shell-only stage refusals `frontend/src/App.tsx`:9569-9577, 9604-9612. | W1-A (pre-work) | **D** | — | After W1-A: in SR2+, sell, buy, sell again within one turn, and try a Pool buy after a sale. Record every control that is greyed while the server would accept. | — |
| **AUD-03.13** · K-01 / U-19 · §3<br>Player↔player private trade. | [R] | RESOLVED — 6.5-B `PrivateCompaniesSection.tsx`. | — | **F** | — | — | — |
| **AUD-03.14** · K-08 / U-24 · §3<br>Sale of an unparred granted share greyed. | [R] | RESOLVED — `utils/stockRoundSaleBlock.ts` (6.5-B). | — | **F** | — | — | — |
| **AUD-03.15** · K-10 · §3<br>Duplicate funding prompt. | [R] | RESOLVED — `utils/privateProposalView.ts` (6.5-B). | — | **F** | — | — | — |

## §4 Operating round / action bar

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-04.01** · K-13 / U-22 · §4, §11<br>While an OR offer (or any authoritative hold) stands, End Turn / Skip / Buy stay enabled; the hold's sentence must show on every seat. | [UX] ★ | CONFIRMED — `panels/ContextualActionBar.tsx`:1826-2117 and 3488-3505 take no hold reason; `authoritativeHoldRefusal` (`gameEngine/authoritativeHolds.ts`:36) has no UI reader. | W2-A | **A** | OD-1 (RULED 2026-10-03) | — | — |
| **AUD-04.02** · A-17 · §4<br>Run Trains is marked as run even when nothing was sent. | [D] | CONFIRMED — `frontend/src/App.tsx`:10019, 10086, 10118, 10279, 10283 (empty `turnRoutes` skips dispatch but sets `ran:true` and Dividends). Outside every RED region. | W1-G | **B** | — | — | The draft map excluded this as RED and deferred it to Phase 4. The nothing-sent case is in `handleRunTrains`, not RED, so it stays in W1-G. The refused-run rollback is a separate finding (P3-N020). |
| **AUD-04.03** · A-8 · §4<br>The JK chip shows outside the Operating Round (and its armed state carries over). | [D] | CONFIRMED — `frontend/src/App.tsx`:2123-2135 (`jkPowerOffer` has no round-type check, unlike its siblings at 2060 and 2100; only an `orSubPhase !== "Track"` guard, and `orSubPhase` falls back to "Track"), 14110; `panels/ContextualActionBar.tsx`:4377 (rendered in the non-OR rail). | W2-D | **B** | — | — | Not in the draft map. |
| **AUD-04.04** · DH-1 · §4<br>The D&H owner's Tokens step is never auto-skipped in later turns. | [D] (routed to rules batch) | CONFIRMED — `gameEngine/dhPower.ts`:418-438 `dhFreeStationAvailableFor` ignores the one-turn window (checked only at `dhStationAuthority.ts`:149). | — (out of W3-K: derivation-only, no version bump; slice placement is the owner's) | **C** | OD-10(a) (RULED 2026-10-03: one v13 batch; this item excluded from it) | — | Corrected by the v13 scope verification (§4.1): the earlier "replay-affecting: v13" does not hold. A derivation-only fix; it may land in any server/derivation slice with no version bump. Not a UI fix. **Status:** OPEN — V13_SCOPE_VERIFICATION §4: APPROVED DEFECT, but derivation-only (`RoomEngine.apply` never derives; stored logs replay identically), so not v13; the owner's W3-K brief excluded it. |
| **AUD-04.05** · U-2 / A-3 · §4, Phase-4 list<br>Retest: the bar sticking on the previous step. | [PT] | NOT CODE — 6.5-A attributes U-2 to the pre-#1287 board mismatch; SI-H01 removed the hosted freeze. | — | **D** | — | R1/H-01 probes: reload during holds; record the bar's step vs `operating_sub_phase`. | — |
| **AUD-04.06** · U-12 · §4, Phase-4 list<br>Retest: a purchase tagged with the wrong step. | [PT] | NOT CODE — unreproduced report. | — | **D** | — | Export the log (AUD-01.09) after every train purchase; check the step tag. | — |
| **AUD-04.07** · U-13 · §4, Phase-4 list<br>Retest: a laid tile appears, then vanishes. | [PT] | NOT CODE — unreproduced report. | — | **D** | — | Screen-record tile lays on two seats; note any vanish with the log index. | — |
| **AUD-04.08** · SI-H01 · §4<br>The hosted bar shows the live step. | [R] | RESOLVED — `utils/displayedOperatingStep.ts` (6.5-B). | — | **F** | — | — | — |

## §5 Track / tile interaction

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-05.01** · U-38 · §5<br>Errata-voided tile numbers still show on the hex face, the Tiles reference tab and the "no upgrade" toast. | [D] | PARTIAL — `frontend/src/App.tsx`:3811 and `RadialTileSelector.tsx`:653, 685 use the raw id; `TileReference.tsx`:90-364 `#{tileId}`. The board face draws a number only on the unknown-tile placeholder (`hexCanvasPrimitives.ts`:1104). | W1-E + W1-L | **A** | — | — | W1-E owns the receipt and aria labels; W1-L owns `TileReference.tsx`. |
| **AUD-05.02** · A-7 · §5<br>A home-station click opens the tile ring. | [D] | CONFIRMED — `frontend/src/App.tsx`:14665-14707 passes `gameId`/`protocolId` regardless of the armed errand; `HexGridRenderer.tsx`:3911-3928. | W1-F | **A** | — | — | — |
| **AUD-05.03** · — · §5<br>The tile picker has no Escape key. | [D] | RESOLVED (audit text stale) — the live picker handles Escape (`RadialTileSelector.tsx`:365-369 "Escape always closes outright"). The component without Escape, `TileSelectionPopup`, is not rendered (`frontend/src/App.tsx`:197). | W3-F (confirm at the final head) | **F** | — | — | The audit's code check appears to have matched the unrendered popup (modal audit L5). |
| **AUD-05.04** · — · §5, Phase-4 list<br>The tile ring's first facing on a tokened upgrade. | [PT] | CONFIRMED as a mechanism — the first facing is the ring's raw `firstOrientation` (`frontend/src/App.tsx`:15355-15408), not `stationLegalFacings`. | W1-E (pre-work) | **D** | — | Upgrade Erie E11 or New York, press Confirm without rotating; record the facing shown and any refusal. | W1-E seeds the legal facing and guards Confirm (P3-N010); Phase 4 confirms the experience. |
| **AUD-05.05** · RR-2 · §5<br>Terrain-cost copy. | [R] | RESOLVED — 6.5-B §1.7. | — | **F** | — | — | — |
| **AUD-05.06** · — · §5<br>Canonical tile names in the log and picker. | [R] | RESOLVED — `canonicalTileName` used in `actionLog` and the picker. | — | **F** | — | — | — |

## §6 Tokens / stations

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-06.01** · K-21 / U-32 · §6<br>The home-station prompt still says "has floated" although it now appears at the first OR turn. | [D] | CONFIRMED — `components/HomeStationPrompt.tsx`:114, 120; pinned by `utils/homeStationWait.test.ts`:84-88. | W2-H | **A** | — | — | — |
| **AUD-06.02** · K-21 · §6<br>Skip stays live during home-station placement. | [D] | CONFIRMED — `panels/ContextualActionBar.tsx`:3488-3499 Skip disabled only by `!sessionReady`; `homeTokenBlock` gates Pass only. | W2-A | **A** | OD-1 (RULED 2026-10-03) | — | — |
| **AUD-06.03** · A-2 · §6<br>A watching seat that is not president gets the home-station form. | [UX] ★ | CONFIRMED — `frontend/src/App.tsx`:13549-13553 (`!viewerAddress` is true for a seatless watcher; no spectator gate). | W1-J | **A** | — | — | The draft map's exec-only finding "watcher sees live Place Home Station" is this item. |
| **AUD-06.04** · H5 (home station) · §6<br>A non-president gets a scrim with no exit; needs a product decision. | [UX] ★ | CONFIRMED — modal audit H5 (`tabbableCount: 0`). | W2-H | **A** | OD-1 (RULED 2026-10-03) | — | — |
| **AUD-06.05** · A-5 · §6<br>A reload between the D&H tile lay and the station makes the free station unreachable. | [D] | CONFIRMED — `usedPrivateAbilities` / `dhStationForfeited` are `useState` (`frontend/src/App.tsx`:1090, 3389-3436); `utils/activePrivatePower.ts`:199-216 needs `dh-tile` in that set; the UI never reads `dh_station_pending`. | W1-M | **B** | — | — | Not in the draft map. Fix shape: also offer the station when the board's `dh_station_pending` names the D&H; leave the local set (DH-3 invariant) otherwise. |
| **AUD-06.06** · DH-2 · §6, Phase-4 list<br>Whether the D&H modal re-offers the free station later. | [PT] | NOT CODE — reachable only if a lay turn ends with the station neither placed nor forfeited. | — | **D** | — | Record any later-turn D&H re-offer with the log index. | — |
| **AUD-06.07** · — · §6<br>The Rules Reference marks Lay Track as the current step while the home token is owed. | [UX] | CONFIRMED — `RulesReference.tsx`:84, 972-979, 3386-3390 (no home-token step); `frontend/src/App.tsx`:14921 passes `orSubPhase`. | W1-I | **A** | — | — | — |

## §7 Route building / display

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-07.01** · K-11 · §7<br>A hand-drawn route set below the maximum is offered, then refused. | [D] | CONFIRMED — pre-check calls `evaluateRouteSet`, not `routeSetRefusal` (`frontend/src/App.tsx`:10093-10116; `gameEngine/routeAuthority.ts`:302-332). | W1-G | **A** | — | — | — |
| **AUD-07.02** · K-26 · §7<br>The route tooltip says revenue is withheld before the dividend choice. | [D] | CONFIRMED — live at `panels/ContextualActionBar.tsx`:3449 ("Revenue is withheld into the treasury…"); also in the unmounted `RoutePlannerPanel.tsx`. | W1-G | **A** | — | — | — |
| **AUD-07.03** · U-17 / K-06 · §7<br>No control for bypassing a city on a route; the engine already supports it. | [UX] | PARTIAL — `gameEngine/cityBypass.ts`; bypass is sent automatically (auto-route, `withForcedBypass`) but there is no voluntary control. | W3-E (OD-11 ruled: build; landed at the safe Wave-2 integration) | **B** | OD-11 (RULED 2026-10-03: manual route only; automatic route optimality unchanged; Stop/Bypass only where the exact crossing supports both arms; a forced bypass stays forced; whole-set `routeSetRefusal` stays authoritative) | — | `utils/manualBypass.ts`: a Stop / Bypass pair on an interior waypoint whose actual crossing the rails offer both ways (Altoona's bow); a forced bypass is stated, not offered; the existing `bypass: true` waypoint flag, no engine, schema or auto-route change. `manualCityBypass.test.tsx`. |
| **AUD-07.04** · S6-13 · §7, U-28<br>The panel's route validators duplicate the engine's, so click feedback can disagree. | [UX] | CONFIRMED — `RoutePlannerPanel.tsx`:166-200 `isRunnableDraft` vs `routeAuthority.ts`:151, 302. | W1-G | **A** | — | — | — |
| **AUD-07.05** · RR-1 · §7<br>Copy implies a human must demonstrate a better route. | [UX] | CONFIRMED — `RulesReference.tsx`:613. | W1-L | **A** | — | — | — |
| **AUD-07.06** · S6-15 / S6-16 · §7<br>Fixed by rules v12. | [R] | RESOLVED — v12 (`gameEngine/rulesVersion.ts`), present at 8e897f9. | — | **F** | — | — | — |

## §8 Dividends

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-08.01** · GR-1 · §8<br>A refused derived withhold is still logged (Gentle Rust). | [D] | PARTIAL — no Gentle-Rust-specific code; the general mechanism: the derived loop appends a minted action without checking refusal (`utils/replayLog.ts`:641-655, `derivedActions.ts`:283-308). | — (out of W3-K: derivation-only, no version bump; slice placement is the owner's) | **C** | OD-10(a) (RULED 2026-10-03: one v13 batch; this item excluded from it) | — | Corrected by the v13 scope verification (§4.2): it is backlog S10-27, a derivation / append-policy fix, not v13. GR-1b (new: the shell's no-server forced-withhold sends the run's $40 as a withhold) is a UI-only defect, routed to a UI slice, not v13. **Status:** OPEN — V13_SCOPE_VERIFICATION §4: APPROVED DEFECT, but derivation-only (`RoomEngine.apply` never derives; stored logs replay identically), so not v13; the owner's W3-K brief excluded it. |
| **AUD-08.02** · U-14 · §8, Phase-4 list<br>Retest: an undo from Buy Trains showed the wrong dividend figure (waiting on a log). | [PT] | NOT CODE — unreproduced. | — | **D** | — | Undo from Buy Trains after a dividend; export the log; compare the figure. | — |
| **AUD-08.03** · — · §8<br>Dividend animation timing needs watching (the route-pulse half is VF/F-1, F-2, F-8). | [PT] | NOT CODE — visual judgement. | — | **D** | — | Watch three dividend payouts at 100% and 63% scale; note the timing feel. | — |

## §9 Train buying / emergency / discard

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-09.01** · U-21 · §9<br>The room's Rescind button sends the chain-era `RescindTrainOffer`, which pinned boards refuse. | [D] | CONFIRMED — `frontend/src/App.tsx`:11060-11088; `RescindTrainPurchase` exists (`messageSchema.ts`:571-572) but no UI sends it. | W1-D | **A** | — | — | — |
| **AUD-09.02** · U-21 · §9<br>The train-sale panel does not read the engine's refusal (`trainSaleRefusal` / `proposeTrainPurchaseRefusal`). | [D] | CONFIRMED — `TrainPurchasePanel.tsx`:573-611 local checks; the engine predicates are never imported. | W2-C | **A** | — | — | — |
| **AUD-09.03** · U-20 · §9<br>The private-purchase panel offers corporation-owned privates and does not read its authority. | [UX] | PARTIAL — corporation-owned privates are NOT offered at 8e897f9 (`PrivateTradePanel.tsx` `purchasablePrivatesInPlay` filters `owner_protocol_id === null`); legality is local (`PrivateTradePanel.tsx`:76-125), `proposePrivatePurchaseRefusal` unused. | W2-C | **A** | — | — | W2-C adds a regression proving corporation-owned privates are not offered (the half the audit stated, not reproduced). |
| **AUD-09.04** · K-05 · §9<br>The proposer has no rescind control for OR train or private offers. | [UX] | CONFIRMED — `frontend/src/App.tsx`:15185-15247 (only `PlayerPrivateTradePrompt` has `onRescind`). | W1-D | **A** | — | — | — |
| **AUD-09.05** · K-25 · §9<br>The emergency modal says "Bank Depot" when the train is in the Bank Pool. | [D] | CONFIRMED — `components/EmergencyTrainPurchaseModal.tsx`:183. | W2-G | **A** | — | — | — |
| **AUD-09.06** · A-9 · §9<br>The emergency modal cannot be closed. | [D] | CONFIRMED — `EmergencyTrainPurchaseModal.tsx`:110 (props: no `onClose`), :169 (`dismissible={false}`). | W2-G | **A** | OD-4 (RULED 2026-10-03: automatic emergency funding, v13) | — | W2-G must be reconciled to the v13 authority before it starts: no player "Declare bankruptcy" (refused on revision 2), one `EmergencySellPortfolio` instead of single forced sales, `ForgoTrainTrade` / `ForgoPrivateFunding`, an automatic purchase and an automatic bankruptcy (`emergencyFundingFor(...).automatic`). |
| **AUD-09.07** · U-4 · §9<br>The emergency-funding UI is minimal. | [UX] ★ | CONFIRMED — Part C U-4 `DEFERRED` (minimal by design in Batch 5). | W2-G | **A** | OD-4 (RULED 2026-10-03: automatic emergency funding, v13) | — | W2-G must be reconciled to the v13 authority before it starts: no player "Declare bankruptcy" (refused on revision 2), one `EmergencySellPortfolio` instead of single forced sales, `ForgoTrainTrade` / `ForgoPrivateFunding`, an automatic purchase and an automatic bankruptcy (`emergencyFundingFor(...).automatic`). |
| **AUD-09.08** · U-5 · §9<br>The discard UI is minimal. | [UX] ★ | CONFIRMED — Part C U-5 ("fold into U-6"). | W2-F | **A** | OD-1 (RULED 2026-10-03) | — | — |
| **AUD-09.09** · U-6 · §9<br>The table needs one "waiting on X" surface for every pending offer. | [UX] ★ | CONFIRMED — four prompts each print their own waiting sentence; `describeStandingOffer` (`pendingOfferHold.ts`:89) unused by UI. | W2-F | **A** | OD-1 (RULED 2026-10-03) | — | — |
| **AUD-09.10** · RR-4 · §9<br>Forced-purchase copy: "cheapest" when the treasury can pay. | [UX] (owner ruling) | CONFIRMED — "must buy the cheapest available train" at `RulesReference.tsx`:677, 736, 1728, 1764; the engine allows any legal purchase. | W1-L (RR-4 copy per OD-7; landed at the Wave-1 integration) | **B** | OD-7 (RULED 2026-10-03: copy only — ordinary choice when the treasury can pay; "cheapest" only in the emergency purchase; no engine change, no v13) | — | Corrected at all four sites (Buy Trains quick line, Forced train purchase detail, Tables > Forced Train Purchase, the gotcha / Watch For). The engine already allowed any legal treasury-funded purchase; `w1lRulesCopy.test.tsx` proves it on a room. No longer in W2-J or W3-K. |
| **AUD-09.11** · RR-7 · §9, §21<br>Emergency private-sale copy omits phases 3–4, ½–2× face value, never the B&O. | [UX] | CONFIRMED — `RulesReference.tsx`:~1730 ("Still short — President sells shares or private companies…"). | W1-L | **A** | — | — | — |

## §10 Presidency / share exchange

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-10.01** · K-20 / U-33 · §10<br>No log line when the presidency changes, and no stated tie-break reason. | [D] | CONFIRMED — `utils/actionLog.ts`:1075-1128 never mentions presidency; `presidencyHandoff` drives only a flourish. | W2-J | **A** | — | — | — |
| **AUD-10.02** · U-35 (i/ii) · §10<br>The M&H exchange uses a client-side check (`resolvePrivateExchange`) instead of `mhExchangeRequestRefusal`. | [D] | CONFIRMED — `frontend/src/App.tsx`:5831-5860; `gameEngine/privateExchange.ts`:83-147 (flat cap, no zone waiver, no certificate check) vs `mohawkExchange.ts`:353-369. | W1-C | **A** | — | — | `resolvePrivateExchange` is used only by App.tsx; the other `privateExchange.ts` exports are reducer imports and stay. |
| **AUD-10.03** · K-17 · §10<br>A queued M&H exchange is logged as executed. | [D] | CONFIRMED — `utils/actionLog.ts`:514-522 unconditional; no UI reader of `pending_mh_exchange`. | W2-E | **A** | OD-3 | — | — |
| **AUD-10.04** · K-03 · §10<br>No choice between IPO and Bank Pool for the M&H share (owner ruled it required). | [UX] | CONFIRMED — `utils/privatePowerFlow.ts`:213-255 (IPO first, single step). | W1-C | **A** | — | — | — |
| **AUD-10.05** · K-04 · §10<br>No M&H request during an Operating Round. | [UX] | CONFIRMED — `utils/activePrivatePower.ts`:128-131 returns no offer outside the SR. | W2-D | **A** | — | — | — |
| **AUD-10.06** · U-35 (iv) · §10<br>No queued, executed or cancelled status for an exchange. | [UX] | CONFIRMED — `pending_mh_exchange` has zero readers outside `gameEngine/`. | W2-E | **A** | OD-3 | — | — |
| **AUD-10.07** · U-35 (v) / RR-6 · §10, §21<br>No M&H "gotcha" copy; the Rules Reference omits the zone waiver, certificate check and queued semantics. | [UX] | CONFIRMED — `RulesReference.tsx`:1392-1419. | W2-E | **A** | — | — | — |

## §11 Round / status information

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-11.01** · K-16 · §11<br>The Priority Deal tooltip can name the wrong opener mid-round. | [D] | CONFIRMED — `PlayerCards.tsx`:201-209 and `gameEngine/gameState.ts`:32 `PRIORITY_DEAL_TOOLTIP`; index moves only at round end / auction close. | W1-B | **A** | — | — | — |
| **AUD-11.02** · — · §11<br>One-shot notices (the Phase 3 modal, rust) are lost on reload. | [D] | CONFIRMED — Herald / PhaseThree / PrivateRevenue are plain `useState` (`frontend/src/App.tsx`:2075, 2519, 5541). | W3-A | **A** | OD-5 | — | — |
| **AUD-11.03** · — · §11<br>The Rules Reference has no game-over state. | [UX] | CONFIRMED — `RulesReference.tsx`:83, 2409-2414, 3310; `frontend/src/App.tsx`:14912-14919 passes `null` ("No live round"). | W2-I | **A** | — | — | Copy only; the draft's OD-6 sub-question is removed (not a product decision). |
| **AUD-11.04** · U-10 · §11<br>Clock / live-vs-async UX. | [UX] (deferred) | NOT CODE — Part C U-10 `DEFERRED` (the UI half of S10-10's 2.5g). | — | **C** | OD-18 | — | The audit says U-10 "stays deferred", but no owner ruling placing it later is on record, and Part F says deferral alone does not count. OD-18 asks the owner to confirm a later placement (then E) or scope it into Phase 3. |
| **AUD-11.05** · H-05 · §11, Phase-4 list<br>The Delayed Auction arming line on every seat. | [PT] | NOT CODE. | — | **D** | — | In a Delayed Auction game, screenshot every seat at the arming moment. | — |
| **AUD-11.06** · U-34 · §11, Phase-4 list<br>Dynamic operating order. | [PT] | NOT CODE (note wording is P3-N016). | W1-I (pre-work) | **D** | — | Across two ORs with price changes, record the displayed order vs the order played. | — |

## §12 Player / company information / ledger

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-12.01** · K-23 / U-27 · §12<br>After a bank break the ledger shows "$0 remaining", "$-20" and >100% paid out. | [D] | CONFIRMED — `components/FinancialLedger.tsx`:161-189 (no clamp); `gameEngine/cashLedger.ts`:249. | W1-I | **A** | — | — | — |
| **AUD-12.02** · U-41 · §12<br>Post-game statistics do not record a train-limit discard. | [D] | CONFIRMED (Part C) — `utils/gameHistory.ts` `describeFleetLosses` splices the discard out. | W2-L | **B** | OD-13 | — | The draft map sent this to "its own pass" without an owner placement; the audit budgets it in Phase 3. |
| **AUD-12.03** · U-43 · §12<br>Four post-game statistics residuals (Salvager pool purchase; refused RunMultipleRoutes booked; RunManualRoute not booked; Cowboy legacy seed). | [D] | CONFIRMED (Part C) — `utils/gameHistory.ts`. | W2-L | **B** | OD-13 | — | — |
| **AUD-12.04** · H-06 · §12<br>On a tie, only the first player gets the WINNER badge. | [D] | CONFIRMED — `gameEngine/endgame.ts`:401-416 (`champion = sorted[0]`); `components/GameOverModal.tsx`:316. | W1-N | **B** | — | — | Not in the draft map. Fix in the display (badge every rank-1 row); do not change ranking. |
| **AUD-12.05** · U-7 · §12<br>Palette / player-card wash not reaching the cash slide-out and payout modal. | [UX] owner call | NOT CODE — Part C U-7 `DEFERRED`, "owner to say". | W3-H (if ruled in) | **C** | OD-14(b) | — | — |
| **AUD-12.06** · U-8 · §12<br>Seven-seat LPF wraps the six-colour palette. | [UX] owner call | NOT CODE — Part C U-8 `DEFERRED`. | W3-H (if ruled in) | **C** | OD-14(c) | — | The draft map assumed "U-8 closed"; that is an owner call and is not defaulted. |
| **AUD-12.07** · GR-3 label · §12<br>"traded" vs "rusted" label for a first-Diesel trade-in in the fleet ledger. | [UX] owner call | CONFIRMED — `utils/gameHistory.ts`:152, 661-667 implements "traded" (#1702); the GR-3 report asked the owner to flag if the old label should stay. | W2-L (only if OD-14(d) restores "rusted") | **C** | OD-14(d) | — | — |

## §13 Modals / dialogs

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-13.01** · — · §13<br>Native dialog surfaces with focus traps and Escape policies. | [R] | RESOLVED — 14 `<NativeModal` call sites at 8e897f9 (the audit said 15). | — | **F** | — | — | — |
| **AUD-13.02** · Batch 4B · §13<br>After acknowledging Private Revenue or Fleet Loss, focus lands on the page body; needs a notice-chaining policy and a heading. | [UX] ★ | CONFIRMED — `PrivateRevenueModal.tsx`:214, `FleetLossModal.tsx`:81 `restoreOpener={false}`. | W3-A | **A** | OD-5 | — | — |
| **AUD-13.03** · — · §13<br>The seat PIN dialog is not a native dialog. | [UX] | RESOLVED (audit text stale) — seat PINs removed in LIVE-2D (`SandboxWaitingRoom.tsx`:497, `SandboxRoomBar.tsx`:205, `App.tsx`:13721). | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-13.04** · — · §13<br>Tutorials are not native dialogs. | [UX] | CONFIRMED — `components/TutorialModal.tsx`:593-597 `<div role="dialog">`. | W3-D | **A** | — | — | — |
| **AUD-13.05** · — · §13<br>The intro overlay's scale contract is unsettled. | [UX] | CONFIRMED — `components/GameIntroOverlay.tsx`:346 `zoom: 1 / uiScale` on an `aria-modal` div. | W3-D | **C** | OD-15(a) | — | — |
| **AUD-13.06** · — · §13<br>Whether the portal / inert layer is still needed is undecided. | [UX] | CONFIRMED — `components/ModalPortal.tsx`:6-11, 43-45 disowns inert and any open-modal registry. | W3-D | **C** | OD-15(b) | — | — |
| **AUD-13.07** · A-20 · §13<br>Several native modals can stack at once. | [D] | CONFIRMED — each `NativeModal` calls `showModal()` independently (`NativeModal.tsx`:202-204, 322-327); no stack manager. | W3-A | **B** | OD-5 | — | Not in the draft map. Policy = which notice yields; see OD-5. |
| **AUD-13.08** · — · §13, Phase-4 list<br>Firefox and Safari dialog behaviour. | [PT] | NOT CODE. | — | **D** | — | Open every NativeModal on Firefox and Safari; check Escape, focus trap, restore. | — |

## §14 Error / validation feedback

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-14.01** · — · §14<br>One error-banner slot with ~28 writers, cleared by exact-text match; needs a unified banner model. | [UX] ★ | CONFIRMED — `setSandboxRoomError` (`frontend/src/App.tsx`:4180) + 27 call sites; exact-text clears at 6426, 12526, 12621, 12635. | W3-C | **A** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | — |
| **AUD-14.02** · S10-1 · §14<br>Reducer refusals are answered "applied", so the REFUSED receipt never fires in room play. | [D] | RESOLVED (audit text stale) — Stage 10.2 #1685: `utils/roomSession.ts`:775-778, 900-932 return `refused`; `utils/serverLink.ts`:774-800 routes it to `onRefused`. Backlog line 3358 lists S10-1 `RESOLVED`. | W3-F (confirm at the final head) | **F** | — | — | W3-G re-confirms with a focused room test that a reducer refusal reaches `onRefused`. |
| **AUD-14.03** · U-30 · §14<br>Replayed stock refusals carry no reason. | [D] | PARTIAL — `utils/refusedAction.ts`:185-347 has BuyStock/SellStock arms, but the server path passes no `marketZoneFor` (`roomSession.ts`:915), so BuyStock refusals read generically. | W1-H | **A** | — | — | — |
| **AUD-14.04** · U-29 · §14<br>Refused private and train purchases look like a button that did nothing. | [UX] | CONFIRMED (Part C U-29) — no arms for the proposal/rescind messages in `refusedAction.ts`. | W1-H | **A** | — | — | — |
| **AUD-14.05** · ING-2 / I-6 · §14<br>Generic refusal wording; client wording that differs from the server's. | [UX] | CONFIRMED (6.5-A register) — e.g. Pass with a train owed gets a generic refusal. | W1-H | **B** | — | — | Not explicit in the draft map. |
| **AUD-14.06** · — · §14<br>The in-flight latch covers only the action bar and the SR panel; dashboard, token and tile confirms, private-power modal, route edits and consent answers can double-send. | [UX] ★ | CONFIRMED — `actionInFlight` reaches the bar, `StockRoundPanel` and `PlayerPrivateTradePrompt` only (`frontend/src/App.tsx`:4219, 13960, 14555, 15241). | W3-B | **A** | — | — | Latching is distributed: W1-B (dashboard), W1-D (consent prompts), W1-E (ring confirm), W2-C (embedded proposal), W2-G (emergency); W3-B closes the residue and owns the coverage test. |

## §15 Animation / audio (non-ledger items)

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-15.01** · A-19 · §15<br>Background radio stays ducked. | [D] | CONFIRMED (path-specific) — `utils/audio.ts`:341-380 `duckRadio` returns a release; a new haunting clears the timer without calling the previous release (`frontend/src/App.tsx`:7580-7614, 2719-2722). | W3-H | **B** | OD-12 (only if the fix must touch the apply half) | — | Preferred fix is inside `utils/audio.ts` (a new duck supersedes the previous one), which needs no RED edit. |

## §16 Mobile / responsive / scaling

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-16.01** · — · §16<br>Default scale 100%, pinch zoom, no horizontal overflow at 360–430 px on listed screens. | [R] | RESOLVED per audit. | — | **F** | — | — | — |
| **AUD-16.02** · — · §16<br>At narrow widths the Host Game footer sits below the fold. | [UX] | CONFIRMED — `components/HostSetupCard.tsx`:412, 522, 860 (in-flow footer). | W1-O | **B** | — | — | — |
| **AUD-16.03** · — · §16<br>The scale readout doesn't say whether the player chose the value or the app guessed it. | [UX] | CONFIRMED — `components/UiScalePicker.tsx`:38, 56 (`${Math.round(scale*100)}%` only). | W1-O | **B** | — | — | — |
| **AUD-16.04** · — · §16<br>A scale chosen in private browsing is lost on reload. | [UX] | CONFIRMED — `utils/uiScale.ts`:87-104 (try/catch, "the default stands"); no notice to the player. | W1-O | **B** | — | — | Persistence is impossible there; the fix is telling the player. |
| **AUD-16.05** · — · §16<br>Breakpoints ignore the zoom. | [UX] | CONFIRMED — viewport-width `@media` rules independent of uiScale (`RulesReference.tsx`:5508-5587; the game shell has none). | W1-O | **B** | — | — | W1-O makes the existing breakpoints zoom-aware. Whether the game shell itself gets a phone-width layout is OD-10(b) (AUD-16.09). |
| **AUD-16.06** · — · §16, Phase-4 list<br>No real device, iOS, Android or Firefox testing. | [PT] | NOT CODE. | — | **D** | — | One full SR and OR on an iPhone (Safari), an Android phone (Chrome) and desktop Firefox; screenshot each screen. | — |
| **AUD-16.07** · — · §16, Phase-4 list<br>44 px touch targets at reduced scale are untested. | [PT] | NOT CODE. | — | **D** | — | At 63% and 80% scale on a phone, measure the hit area of the bar, ring and dashboard controls. | — |
| **AUD-16.08** · — · §16, Phase-4 list<br>Ctrl+wheel zoom is untested. | [PT] | NOT CODE. | — | **D** | — | Ctrl+wheel through 50–200% on Chrome/Firefox/Edge; record overflow or misplaced overlays. | — |
| **AUD-16.09** · — · §16, Phase-4 list<br>The in-game SR and OR screens at phone width are untested. | [PT] | NOT CODE. | — | **D** | OD-10(b) (whether phone width is a target) | At 360/390/430 px, play one SR turn and one OR turn; record every unreachable control. | — |

## §17 Accessibility / readability

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-17.01** · — · §17<br>Host Game lacks `aria-describedby` links to its descriptive text. | [UX] | CONFIRMED — `HostSetupCard.tsx`:570-605. | W1-O | **B** | — | — | — |
| **AUD-17.02** · — · §17<br>Host Game's radio group ignores Home/End. | [UX] | CONFIRMED — `HostSetupCard.tsx` `ARROW_STEP` covers arrows only. | W1-O | **B** | — | — | — |
| **AUD-17.03** · — · §17<br>The focus outline hides the tab accent. | [UX] | CONFIRMED (Host Game) — `HostSetupCard.tsx`:699-706 `:focus-visible { outline: 2px solid #8a8a86 }`. | W1-O | **B** | — | — | W1-O also checks MainTabBar's focus style. |
| **AUD-17.04** · — · §17, Phase-4 list<br>No screen-reader testing has been done. | [PT] | NOT CODE. | — | **D** | — | NVDA (Windows) and VoiceOver (macOS/iOS): lobby → Host Game → one SR turn → one OR turn; log every unlabelled control. | — |

## §18 Lobby / session / start-game flow

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-18.01** · A-12 · §18<br>Game Over's "Leave" goes to the sandbox gate, not the Lobby. | [D] | CONFIRMED — `frontend/src/App.tsx`:13654 `onLeaveGame={handleLeaveSandboxRoom}`; 12768-12781, 13284-13310. | W1-N | **B** | — | — | — |
| **AUD-18.02** · A-10 · §18<br>The auto-close timer restarts on refresh. | [D] | CONFIRMED — `frontend/src/App.tsx`:2152-2160, 2169 (tab-local `Date.now()`). | W1-N | **B** | — | — | — |
| **AUD-18.03** · A-11 · §18<br>Close Room reappears while scrubbing. | [D] | CONFIRMED — `frontend/src/App.tsx`:1384, 2142, 13657 (`roomClosed` read from the scrubbed snapshot). | W1-N | **B** | — | — | — |
| **AUD-18.04** · U-40 · §18<br>The "Project 18XX" naming pass (readiness: player-facing 1830 terms, the Rules Reference's standing as final authority). | [UX] | PARTIAL — ~0 player-facing "1830" strings; "Project 18XX" ~20 player-facing; authority sentence not yet written. | W1-L | **A** | — | — | The owner's S9-4 ruling already fixes the policy; the draft's OD-8 sub-question is removed. |
| **AUD-18.05** · U-15 · §18<br>The Keplr logo. | [UX] | CONFIRMED — no Keplr logo asset in `public/` or `src/`. | W2-K | **C** | OD-9(b) | — | — |
| **AUD-18.06** · DA6-n · §18<br>Name-case drift. | [UX] | NOT RE-VERIFIED — per audit. | W1-L | **B** | — | — | — |
| **AUD-18.07** · — · §18<br>The waiting room's extra description line awaits an owner decision. | [UX] owner call | CONFIRMED — `components/SandboxWaitingRoom.tsx`:590. | W1-L (if changed) | **C** | OD-14(e) | — | — |
| **AUD-18.08** · — · §18<br>Public rooms with Join and Watch, waiting-room layout, Host Game Escape and focus. | [R] | RESOLVED per audit. | — | **F** | — | — | — |

## §19 Spectating / reconnect / recovery

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-19.01** · I-1 / R4 · §19<br>Forms don't show that a submission is still queued on the link. | [UX] ★ | CONFIRMED by reading — no form reads the link's queue state. | W3-I | **B** | OD-12 (only if the submit half or link drain must change) | — | The draft map deferred this to Phase 4; it stays in Phase 3. |
| **AUD-19.02** · U-45 · §19<br>Two tabs can both reach Keplr, creating a duplicate escrow. | [D] | CONFIRMED — `money/pendingTx.ts`:7-22, 157 (record written only after signing); no `navigator.locks` / lease. | W1-K | **A** | — | — | — |
| **AUD-19.03** · R1–R12 · §19, Phase-4 list<br>Recovery scenarios: refresh, network loss, two tabs, second device, stale modal, divergence banner. | [PT] | NOT CODE. | — | **D** | — | Run each R-scenario from the 6.5 preflight on the Phase-4 baseline; record banner text, recovery path and log export. | — |
| **AUD-19.04** · — · §19<br>No host succession and no clock for an absent seat. | recorded limit | NOT CODE — the audit records these as limits (also the 6.5 preflight's "Known limits"). | — | **C** | OD-18 | — | Recorded product limits. OD-18 asks the owner to confirm their later placement (then E). |

## §20 Money / escrow UI

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-20.01** · U-44 · §20<br>The server writes "HH:MM UTC" while the client shows unlabelled local times. | [UX] | CONFIRMED — three `hhmm` copies (`money/moneyFlow.ts`:106-109, `components/money/MoneyPanel.tsx`:41-44, `SettlementBand.tsx`:42-45); `server/src/escrow/moneyTables.ts`:1027, 1150. | W2-K (OD-9(a) ruled; landed at the safe Wave-2 integration) | **B** | OD-9(a) (RULED 2026-10-03: persistent player UI — local absolute time + explicit time zone; server refusal copy — relative duration; machine evidence stays UTC) | — | One formatter `money/moneyTime.ts` (`formatMoneyTime`) replaces the three `hhmm` copies; the two server refusal sentences in `server/src/escrow/moneyTables.ts` give the time remaining; instants, codes, wire and logs unchanged. |
| **AUD-20.02** · JX-3A E-1 · §20<br>A stale wallet proof still shows "Wallet linked". | [UX] | CONFIRMED — `money/moneyFlow.ts`:121-122 reads server `funding === "linked"` without freshness. | W2-M | **B** | — | — | — |
| **AUD-20.03** · JX-3A E-2 · §20<br>Replacing a wallet takes two Keplr prompts. | [UX] | CONFIRMED — `money/moneyActions.ts`:167-197 (`replace-required` then `linkWallet({replace:true})`). | W2-M | **B** | — | — | — |
| **AUD-20.04** · JX-3A E-3 · §20<br>Expiry messages are generic. | [UX] | CONFIRMED by reading — `money/useMoneyTable.ts`:240-241, 294. | W2-M | **B** | — | — | — |
| **AUD-20.05** · JX-3A B-3 · §20<br>A Keplr rejection can read as "unknown". | [UX] | CONFIRMED — `money/keplrWallet.ts`:167, 174-185 `classifyChainError` has no rejection arm. | W2-M | **B** | — | — | — |
| **AUD-20.06** · JX-6C · §20<br>The browser should re-read the chain before a Challenge. | [UX] | CONFIRMED — `money/moneyActions.ts`:591-627 builds from `ctx.view`. | W2-M | **B** | — | — | — |
| **AUD-20.07** · JX-6E · §20<br>The dispute confirm gives no deadline time; the band shows no dispute record. | [UX] | PARTIAL — `SettlementBand.tsx`:70 shows `hhmm(resolverTimeoutAt) \|\| 'its deadline'`; the record is one generic line (`money/moneyFlow.ts`:468). | W2-M | **B** | — | — | — |
| **AUD-20.08** · S10-12 · §20<br>An owner-authored Terms page is needed before the first real deposit. | [UX] | CONFIRMED — no Terms page, route or string in `frontend/src` or `frontend/public`. | W2-M (hosting only) | **C** | OD-16 | — | — |
| **AUD-20.09** · K-24 · §20<br>No-money table: placeholder payout computed (floating point) and fired as a console stub. | [D] | CONFIRMED — `gameEngine/endgame.ts`:329 `PLACEHOLDER_TOTAL_ANTE = 100`, 417-418; `utils/closeRoomPayout.ts`:5-10; the call is at `App.tsx`:7828-7834 (RED apply half). | W1-N | **B** | OD-12 (RULED 2026-10-03; the call site is deleted, `87d63c4`) | — | The draft map defaulted this to Phase 5; no owner placement exists, so it stays in Phase 3. Neutralise in `endgame.ts` / `closeRoomPayout.ts`; deleting the call site needs OD-12. |
| **AUD-20.10** · K-24 · §20<br>No-money table: Close Room tooltip. | [D] | RESOLVED (audit text stale) — `panels/ContextualActionBar.tsx`:2112-2114 "Close the room. Any player may do this; it closes on its own if nobody does." (no payout claim). | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-20.12** · K-24 · §20<br>No-money table: the "settled on-chain" copy appears to be fixed. | [R] (in a [D] bullet) | RESOLVED — `components/GameOverModal.tsx`:338 records the removed "settled on-chain when the room closes" copy; no such string remains on the no-money path. | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-20.11** · I-4 · §20<br>A dispute's evidence reads the live board. | [R] | RESOLVED — integrated closure (`SettlementBand` mounts receive `liveState`). | — | **F** | — | — | — |

## §21 Rules Reference / tutorials

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-21.01** · — · §21<br>Rules Reference redesign implemented. | [R] | RESOLVED per audit. | — | **F** | — | — | — |
| **AUD-21.02** · DA6-O2 · §21<br>Must-sell copy lacks the curable-only qualifier. | [D] | PARTIAL — DA6-O2's site is fixed (`RulesReference.tsx`:1221, 1916 carry "as far as a legal sale can fix it"; closed at DA-7) but `RulesReference.tsx`:1903 (the M&H over-limit sentence) still lacks it. | W1-L | **B** | — | — | — |
| **AUD-21.03** · RR-3 · §21<br>Float capitalisation timing copy ("End of the Stock Round"). | [UX] | CONFIRMED (6.5 preflight §4.5). | W1-L | **A** | — | — | — |
| **AUD-21.04** · RR-5 · §21<br>Level Playing Field station and Diesel prices copy. | [UX] | CONFIRMED (6.5 preflight §4.5: $40/$1,100/$800 vs engine $100/$900/$750). | W1-L | **A** | — | — | — |
| **AUD-21.05** · U-32 · §21<br>Home-station timing text in the Rules Reference. | [UX] | CONFIRMED by reading — the static "First turn only" aside does not state the first-OR-turn timing. | W1-L | **B** | — | — | — |
| **AUD-21.06** · U-33 · §21<br>The presidency tie rule text. | [UX] | PARTIAL — `RulesReference.tsx`:1897, 1900 already state "a tie changes nothing"; W1-L verifies against the engine. | W1-L | **B** | — | — | — |
| **AUD-21.07** · UR-F20 · §21<br>The exact-$5 revenue rounding tie copy. | [D] | RESOLVED (audit text stale) — UR-F20 `RESOLVED` in UR-7 (backlog line 1974); `RulesReference.tsx`:854-861 "rounded toward the printed route total". | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-21.08** · S10-14 · §21<br>The hand-copied OR step-label table. | [D] | CONFIRMED — `RulesReference.tsx`:1121-1128 duplicates `gameEngine/operatingSubPhase.ts`:56-66. | Phase 5 | **E** | — | — | Consolidating duplicated constants is refactor work: the owner's fixed roadmap places the major frontend refactor in Phase 5 (plan §1), and backlog Part B's Stage-10 routing map (line 3448) routes S10-14 to it. W1-L adds a parity test so the copy cannot drift before then. |

## Gate item

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-22.01** · U-28 · Gate<br>Retrospective Batch 1–6 UI-parity audit — a Phase-3 closure gate. | gate | OPEN — Part C U-28 `OPEN (gate item)`. | W3-G | **B** | — | — | Its findings are fixed (W3-J), proven obsolete, or owner-ruled before W3-F can close Phase 3. |

## Highest-risk systems (characterization carried as an item)

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-23.01** · — · Highest-risk #2<br>Nine separate whose-turn derivations in the shell. | characterization | CONFIRMED (App decomposition audit) — not re-counted. | Phase 5 | **E** | — | — | Consolidating them is App.tsx refactor work; the owner's fixed roadmap (plan §1) places the major App.tsx refactor in Phase 5. Phase-3 slices read authority at every site they touch. |

## "Leave for Phase 4" list (items not stated in §1–§21)

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-24.01** · U-1 · Phase-4 list<br>Retest #1237 / #1238 on a freshly rebuilt server. | [PT] | NOT CODE. | — | **D** | — | Fresh server; scrub live vs history frame; buy a train; record the toast. | — |
| **AUD-24.02** · U-9 · Phase-4 list<br>Mirror instrumentation (two tabs, different subpanel prices). | [PT] | NOT CODE — awaits a `[mirror]` console line. | — | **D** | — | Two tabs per seat for one SR; capture any `[mirror]` console line. | — |
| **AUD-24.03** · K-12 stall · Phase-4 list<br>Whether Auto-Buy without cash stalls (UX). | [PT] | NOT CODE — the cash defect itself is AUD-03.05. | W1-A (pre-work) | **D** | — | Arm Auto-Buy for an unaffordable share after W1-A; expect it to disarm with a reason. | — |
| **AUD-24.04** · RR checkpoints · Phase-4 list<br>The 12 Rules Reference checkpoints (preflight §10). | [PT] | NOT CODE. | — | **D** | — | At each of the 12 moments press "Go to current →"; record page, step, rule match, usefulness. | — |
| **AUD-24.05** · DA cancel · Phase-4 list<br>Whether the Delayed Auction's 5-train cancellation can be reached by legal play. | [PT] | NOT CODE. | — | **D** | — | Attempt a constructed legal line to a first 5-train before the auction; record whether it is reachable. | — |

## §15 Flourish ledger items (`VISUAL_FLOURISH_BACKLOG.md`)

The audit counts 47 PLAYTEST, 21 recorded OWNER DECISION and 23 OPEN entries. Measured at `8e897f9`: exactly 47 / 21 / 23
(plus 14 RESOLVED and 1 NOT REACHABLE, which the audit does not count). Flourish IDs are prefixed `VF/` because they collide
with other ledgers' IDs (`VF/D-12` is not decision D-12; `VF/K-4` is not register item K-04).

- **PLAYTEST (47) → D.** The audit lists them for Phase-4 discovery. Each entry's own text names what to watch.
- **OWNER DECISION (21) → F.** Already decided and recorded; only a new owner ruling re-opens one.
- **OPEN (23).** Known presentation defects or gaps, budgeted by the audit in Phase 3 ("Animation residuals 3–6 h"). The draft
  map deferred "the flourish backlog" with no owner placement; that deferral is overturned. 17 → **B** (new slice W3-H), 6 →
  **C** (owner calls OD-14 / OD-17).

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **VF/C-1** · VF C-1 · §15 (§5, §8 where tile / route-pulse)<br>Card focus border weight. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 980) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/C-3** · VF C-3 · §15 (§5, §8 where tile / route-pulse)<br>Takeover length. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 994) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/C-4** · VF C-4 · §15 (§5, §8 where tile / route-pulse)<br>The 200 ms resolve point. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 998) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/C-5** · VF C-5 · §15 (§5, §8 where tile / route-pulse)<br>The landing row's ink. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1003) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/C-9** · VF C-9 · §15 (§5, §8 where tile / route-pulse)<br>Reduced motion. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1026) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-1** · VF D-1 · §15 (§5, §8 where tile / route-pulse)<br>Length and beats. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1049) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-4** · VF D-4 · §15 (§5, §8 where tile / route-pulse)<br>Tension before a city changes. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1071) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-5** · VF D-5 · §15 (§5, §8 where tile / route-pulse)<br>The ring pinch. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1076) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-6** · VF D-6 · §15 (§5, §8 where tile / route-pulse)<br>Busy merges. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1081) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-7** · VF D-7 · §15 (§5, §8 where tile / route-pulse)<br>Tokens in a reorganising city. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1090) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-11** · VF D-11 · §15 (§5, §8 where tile / route-pulse)<br>The room round trip. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1121) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-14** · VF D-14 · §15 (§5, §8 where tile / route-pulse)<br>Reservation markers ride with their city. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1140) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-23** · VF D-23 · §15 (§5, §8 where tile / route-pulse)<br>The construction wave. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1285) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-24** · VF D-24 · §15 (§5, §8 where tile / route-pulse)<br>Tile-transition audio. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1301) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-25** · VF D-25 · §15 (§5, §8 where tile / route-pulse)<br>How long each kind of lay takes. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1318) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-26** · VF D-26 · §15 (§5, §8 where tile / route-pulse)<br>The proposal's wash. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1328) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-27** · VF D-27 · §15 (§5, §8 where tile / route-pulse)<br>Planned shapes under moving parts. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1338) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-28** · VF D-28 · §15 (§5, §8 where tile / route-pulse)<br>The commit reveal. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1349) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-32** · VF D-32 · §15 (§5, §8 where tile / route-pulse)<br>Tokens are pieces seated in their stations. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1389) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-34** · VF D-34 · §15 (§5, §8 where tile / route-pulse)<br>A token's planned place. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1417) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-40** · VF D-40 · §15 (§5, §8 where tile / route-pulse)<br>The reconfiguration's head start, and what the track cue now covers. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1466) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/D-39** · VF D-39 · §15 (§5, §8 where tile / route-pulse)<br>Three cues against a three-clip cap. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1476) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/E-1** · VF E-1 · §15 (§5, §8 where tile / route-pulse)<br>The translate/scale/flip is unmeasured by any test. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1489) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/E-2** · VF E-2 · §15 (§5, §8 where tile / route-pulse)<br>Four playtest variables, none watched yet. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1498) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/F-1** · VF F-1 · §15 (§5, §8 where tile / route-pulse)<br>Signal speed and pulse duration are first-guess numbers, unwatched. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1537) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/F-2** · VF F-2 · §15 (§5, §8 where tile / route-pulse)<br>Traveling band geometry is unmeasured against a real board. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1547) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/F-8** · VF F-8 · §15 (§5, §8 where tile / route-pulse)<br>Pop scale, timing and undershoot are first-guess numbers, unwatched. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1578) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/G-2** · VF G-2 · §15 (§5, §8 where tile / route-pulse)<br>The timings are first-guess numbers. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1615) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/G-3** · VF G-3 · §15 (§5, §8 where tile / route-pulse)<br>The perspective figure. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1623) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/G-4** · VF G-4 · §15 (§5, §8 where tile / route-pulse)<br>The tint channel currently carries no pixels. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1631) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/G-6** · VF G-6 · §15 (§5, §8 where tile / route-pulse)<br>The Phase 2 → 3 sequencing, end to end. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1644) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/H-3** · VF H-3 · §15 (§5, §8 where tile / route-pulse)<br>The ticket silhouette at actual Action Bar scale. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1708) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/H-4** · VF H-4 · §15 (§5, §8 where tile / route-pulse)<br>The stamp's 960 ms, and whether the hold is long enough to read. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1716) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/H-5** · VF H-5 · §15 (§5, §8 where tile / route-pulse)<br>The rainbow ring at badge scale, and its contrast. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1724) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/H-7** · VF H-7 · §15 (§5, §8 where tile / route-pulse)<br>Two tickets on screen at once. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1740) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/I-5** · VF I-5 · §15 (§5, §8 where tile / route-pulse)<br>The timings are first-guess numbers. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1826) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/I-6** · VF I-6 · §15 (§5, §8 where tile / route-pulse)<br>The crack at actual chip size. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1834) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/I-7** · VF I-7 · §15 (§5, §8 where tile / route-pulse)<br>The oxide against eight liveries. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1841) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/I-9** · VF I-9 · §15 (§5, §8 where tile / route-pulse)<br>Rust outranks both warning animations, and nothing was watched. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1858) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/J-2** · VF J-2 · §15 (§5, §8 where tile / route-pulse)<br>The timings are first-guess numbers, and the transfer is the long part. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1897) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/J-3** · VF J-3 · §15 (§5, §8 where tile / route-pulse)<br>The cut at actual chip size. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1905) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/J-8** · VF J-8 · §15 (§5, §8 where tile / route-pulse)<br>A corporation two over the limit discards twice in a row. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1948) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/K-2** · VF K-2 · §15 (§5, §8 where tile / route-pulse)<br>The crack at uiScale 0.63. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1969) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/K-3** · VF K-3 · §15 (§5, §8 where tile / route-pulse)<br>Whether the tile reads as a train chip or as a box. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1978) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/K-5** · VF K-5 · §15 (§5, §8 where tile / route-pulse)<br>`4→3` beside a label that does not carry the figures. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 1993) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/K-7** · VF K-7 · §15 (§5, §8 where tile / route-pulse)<br>The chip in pieces, at 24px and at speed. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 2009) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/K-8** · VF K-8 · §15 (§5, §8 where tile / route-pulse)<br>Perceptual loudness across the three cues. | [PT] PLAYTEST | PLAYTEST in `VISUAL_FLOURISH_BACKLOG.md` (line 2021) | — | **D** | — | Watch the entry's named variables on the Phase-4 baseline; record pass / re-tune. | — |
| **VF/C-2** · VF C-2 · §15<br>Dimming covers the ownership table only. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 987) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/C-6** · VF C-6 · §15<br>Presidency cue has no category of its own. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1009) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/C-8** · VF C-8 · §15<br>Staging covers the whole card, including the float badge. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1020) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/C-11** · VF C-11 · §15<br>A mid-sequence remount replays the whole presentation. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1037) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/D-8** · VF D-8 · §15<br>Reduced motion is a fade. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1101) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/D-9** · VF D-9 · §15<br>What plays, and what snaps. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1111) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/D-10** · VF D-10 · §15<br>Supersession is a snap. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1117) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/D-29** · VF D-29 · §15<br>A lay nobody proposed here shows its proposal first. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1362) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/D-31** · VF D-31 · §15<br>The proposal replaced #822's ghost pass. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1381) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/D-37** · VF D-37 · §15<br>A station change the plan gives no moment is silent. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1449) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/D-38** · VF D-38 · §15<br>The board reads a mirror of the master switch. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1457) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/E-3** · VF E-3 · §15<br>The centring target is the roster grid, not the viewport or the whole panel. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1506) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/E-4** · VF E-4 · §15<br>VF-1 and VF-3 compose rather than choose one. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1513) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/G-5** · VF G-5 · §15<br>Two badges, two copies of one flip. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1638) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/H-1** · VF H-1 · §15<br>#901's Top Bar badge is removed, and the one coverage hole is filled. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1663) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/H-8** · VF H-8 · §15<br>The countdown is rounds, not turns. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1747) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/I-2** · VF I-2 · §15<br>Tutorial mode gained a control, because it now decides something. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1783) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/I-4** · VF I-4 · §15<br>No stagger between corporations, and why. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1816) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/J-4** · VF J-4 · §15<br>The Bank Pool receiving reaction is Option B, and usually invisible. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1914) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/J-7** · VF J-7 · §15<br>Two staging sources now share one chip row, and rust wins the tie. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1939) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/K-1** · VF K-1 · §15<br>The Gentle Rust final-run badge takes the rust mark. | recorded owner decision | OWNER DECISION in `VISUAL_FLOURISH_BACKLOG.md` (line 1960) | — | **F** | (recorded) | May be re-tuned only by a new owner ruling. | — |
| **VF/C-7** · VF C-7 · §15<br>An off-screen card still animates. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1015) | W3-H | **B** | — | — | Gate the proxy on viewport visibility (one fix shape with E-6, F-5). |
| **VF/C-10** · VF C-10 · §15<br>The row glide has never been observed. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1032) | W3-H | **B** | — | — | W3-H records a real-browser trace (Playwright) of the FLIP; Phase 4 judges the feel. |
| **VF/D-12** · VF D-12 · §15, §5<br>What switches on the first frame (terrain icon, name label, cost badge snap). | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1128) | W3-H | **B** | — | — | — |
| **VF/D-13** · VF D-13 · §15, §5<br>Overlays are not staged during a tile flourish. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1135) | W3-H | **B** | — | — | — |
| **VF/D-16** · VF D-16 · §15, §5<br>The hand-over at pixel level. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1161) | W3-H | **B** | — | — | — |
| **VF/D-17** · VF D-17 · §15, §5<br>Whole-board repaint while a flourish runs. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1172) | W3-H | **B** | — | Low-end device frame-rate during a lay. | Measure with a throttled-CPU trace in W3-H; Phase 4 adds a low-end device. |
| **VF/D-18** · VF D-18 · §15<br>Rules cross-reference: New York's four-slot city (#54→#883 vs #62→#883). | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1177) | — (no change: out of W3-K) | **C** | OD-17 (RULED 2026-10-03: no change) | — | Tile-upgrade legality is the printed rule; nothing to build. **Status:** RULED — no change: V13_SCOPE_VERIFICATION §6.1 found it INVALID (the printed T-09 upgrade path); the ledger's OPEN entry and comment cleanup are owed to a docs pass. |
| **VF/D-21** · VF D-21 · §15<br>Rail-less printed centres pair by position; some facings tie. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1252) | W3-H | **B** | — | — | — |
| **VF/D-22** · VF D-22 · §15<br>Rules cross-reference: #59 → brown OO facings that break fixed OO (256 accepted transitions). | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1271) | — (no change: out of W3-K) | **C** | OD-17 (RULED 2026-10-03: no change) | — | Placement-filter legality already enforced; the 256 count reproduces only with rule 5b removed. **Status:** RULED — no change: V13_SCOPE_VERIFICATION §6.2 found it ALREADY CORRECT (Stage 9.3 rule 5b, rules v7; 0 accepted transitions today); the ledger's OPEN entry and the D-15 / D-21 / D-24 wording are owed to a docs pass. |
| **VF/D-30** · VF D-30 · §15, §5<br>Clip antialiasing while the front crosses. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1370) | W3-H | **B** | — | — | — |
| **VF/D-35** · VF D-35 · §15, §5<br>An OO home's reservation has no city to ride. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1432) | W3-H | **B** | — | — | — |
| **VF/E-5** · VF E-5 · §15<br>The stacking-context claim is reasoned, not screenshotted. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1521) | W3-H | **B** | — | — | W3-H takes the screenshot. |
| **VF/E-6** · VF E-6 · §15<br>Off-screen / inactive-tab cost (same shape as C-7). | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1528) | W3-H | **B** | — | — | — |
| **VF/F-5** · VF F-5 · §15<br>Traveling signal and per-hex badge lookup run whenever any route overlay exists. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1591) | W3-H | **B** | — | — | — |
| **VF/G-1** · VF G-1 · §15<br>Audio is unanswered; the phase flip is silent. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1602) | W3-H (if ruled in) | **C** | OD-14(f) | — | Needs an owner-approved cue. |
| **VF/G-7** · VF G-7 · §15<br>A phase change while the bar is unmounted is missed. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1652) | W3-H (if ruled in) | **C** | OD-14(g) | — | The ledger records it as acceptable; the owner either closes it as designed or asks for a replay. |
| **VF/H-6** · VF H-6 · §15<br>The mini-auction card writes the palette out by hand. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1732) | W3-H | **B** | — | — | Import `PRIVATE_POWER_GLOW_STOPS`. |
| **VF/I-8** · VF I-8 · §15<br>Ledger tables do not receive the rust event. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1848) | W3-H | **B** | — | — | — |
| **VF/I-10** · VF I-10 · §15<br>Rust's static badge icon is not implemented. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1865) | W3-H (if ruled in) | **C** | OD-14(h) | — | — |
| **VF/J-5** · VF J-5 · §15<br>Ledger tables do not receive the discard event. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1925) | W3-H | **B** | — | — | — |
| **VF/J-6** · VF J-6 · §15<br>The discard's static badge icon is not implemented. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1932) | W3-H (if ruled in) | **C** | OD-14(h) | — | — |
| **VF/K-4** · VF K-4 · §15<br>The fallback capacity glyph has never been rendered in the product. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1986) | W3-H | **B** | — | — | Render it in a harness screenshot. |
| **VF/K-6** · VF K-6 · §15<br>The rust mark and VF-7's chips can disagree about a fracture. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 2001) | W3-H | **B** | — | — | Add a guard test at the badge size. |

## NEW-SOURCE-FINDINGS from the execution-map draft (`P3-N###`)

Real source findings in the draft that the audit does not state, verified at `8e897f9`. They get new stable IDs and never
reuse U/K/H/A IDs; any legacy alias is shown.

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **P3-N001** · draft §0.4 "dead arms" · draft execution map<br>`passDisabledReason`'s home-hold and train-obligation arms are dead: Pass renders only outside the OR. | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:14001-14036; `panels/ContextualActionBar.tsx`:2786, 4180-4207. | W2-A | **A** | — | — | P0's S1 seam hoists `passDisabledReason` into a const first; W2-A then removes the dead arms. |
| **P3-N002** · draft NEW-2 (OR bar) · draft execution map<br>The OR bar knows no authoritative hold at all (discard, funding, home token, offer). | NEW-SOURCE-FINDING | CONFIRMED — `panels/ContextualActionBar.tsx`:1826-2117, 3488-3505. | W2-A | **A** | OD-1 (RULED 2026-10-03) | — | Broader than K-13 (offers only); W2-A's `turnHoldReason` covers all four holds. |
| **P3-N003** · draft M1 · draft execution map<br>The M&H Stock Round chip is greyed off-turn (`sessionReady` includes `isMyTurn`), contradicting design note #884 ("NOT TURN-GATED"). | NEW-SOURCE-FINDING | CONFIRMED — `panels/ContextualActionBar.tsx`:2236, 2239; `frontend/src/App.tsx`:13960. | W2-D | **A** | — | — | — |
| **P3-N004** · draft NEW-2 (sticky) · draft execution map<br>A non-turn server refusal stays in the room strip (only `TURN_REFUSAL` is cleared). | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:6426 (RED submit half); refusals from `onRefused` (12569) and `onError` (12264) persist. | W3-C | **A** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | — |
| **P3-N005** · draft A1-new · draft execution map<br>The auction dashboard never asks `acquisitionSolvencyRefusal` (DA-5), so Bid/Buy can show enabled when the engine would refuse. | NEW-SOURCE-FINDING | CONFIRMED — `WaterfallAuctionDashboard.tsx`:497-505, 834, 876; `gameEngine/auctionAuthority.ts`:235, 278, 662. | W1-B | **A** | — | — | — |
| **P3-N006** · draft W1-D · draft execution map<br>Trade-prompt answerer identity comes from narration fields (`offer.owner`, `offer.seller_president`) instead of `currentPrivateOwner` / `sellerPresident`. | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:4053-4060, 15185-15247; `utils/privateProposalView.ts`:33. | W1-D | **A** | — | — | — |
| **P3-N007** · draft W1-D · draft execution map<br>Optimistic "completed immediately" log lines are written before a non-awaited dispatch lands. | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:10430-10442, 10949-10953. | W1-D | **A** | — | — | — |
| **P3-N008** · K-14 (6.5 register) · draft execution map<br>The chain-era `TrainTradePanel` stays mounted (never renders in rooms) with chain-era Accept/Reject/Rescind handlers. | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:11060-11120, 14460-14484. | W1-D | **A** | — | — | The 6.5 register routed K-14 to Rust retirement; retiring dead UI here is behaviour-preserving. |
| **P3-N009** · draft NEW-1 (blockedReason) · draft execution map<br>`trainPurchase.blockedReason` reads the dead chain-era `trainOffers` (always `[]` in rooms). | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:14188-14192, 1714, 1227. | W2-A | **A** | — | — | — |
| **P3-N010** · draft W1-E · draft execution map<br>The tile ring's Confirm never asks `layTileRefusal`; `tileLayDisabledReason` is a local restatement; two comments claim filtering that does not happen. | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:15347, 11742-11773, 12157-12162, 15355-15357; `RadialTileSelector.tsx`:513-518, 629. | W1-E | **A** | — | — | `utils/stationConnectivity.test.ts` pins exactly 3 matches of `derivePreviewLandings(` followed by a line break (true at 8e897f9; a plain-text count finds 4). W1-E must not add a multi-line call. |
| **P3-N011** · LOW-4 (R12-2 report) · draft execution map<br>The lay preview's `layTileRefusal` call uses `withRules` without the board's rules revision. | NEW-SOURCE-FINDING | CONFIRMED per R12-2 §5 (harmless today: the revision changes no tile-lay rule). | W1-E | **A** | — | — | W1-E introduces the preview memo, so it passes the revision there. The draft deferred LOW-4 to Phase 4. |
| **P3-N012** · draft NEW-1-map · draft execution map<br>A refused station click writes its reason to the Routes-only `routeFeedback` slot, so it is invisible on the map. | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:10644-10650; shown only in `RouteChipDetail` (`panels/ContextualActionBar.tsx`:3777-3790). | W1-F | **A** | — | — | Implementation default: `showActionToast` (`App.tsx`:5521). Not an owner decision. |
| **P3-N013** · draft W1-G · draft execution map<br>`RoutePlannerPanel` is never mounted but carries a second refusal order and the K-26 copy. | NEW-SOURCE-FINDING | CONFIRMED — `components/RoutePlannerPanel.tsx`:521 and its unmounted render. | W1-G | **A** | — | — | — |
| **P3-N014** · draft NEW-5 · draft execution map<br>Developer text in player tooltips: Skip ("Dispatches AdvanceOperatingSubPhase — the contract moves its own cursor") and "$0 dividend". | NEW-SOURCE-FINDING | CONFIRMED — `panels/ContextualActionBar.tsx`:3501, 1988 (the latter pinned by `appNaming`). | W1-I | **A** | — | — | — |
| **P3-N015** · draft W1-I · draft execution map<br>The action dock has no landmark role or label. | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:13829. | W1-I | **A** | — | — | — |
| **P3-N016** · draft W1-I (U-34 note) · draft execution map<br>`operatingOrderView.ts`'s note says the queue is "frozen for the whole round, which is 1830's rule". | NEW-SOURCE-FINDING | PARTIAL — `utils/operatingOrderView.ts`:12-17, 82-90. | W1-I | **A** | — | — | — |
| **P3-N017** · draft OD-4 · draft execution map<br>Every seat sees "Declare bankruptcy" in the emergency modal (no viewer/president scope). | NEW-SOURCE-FINDING | CONFIRMED — `EmergencyTrainPurchaseModal.tsx`:429-441 (gated only by `canDeclareBankruptcy && sandbox`). | W2-G | **A** | OD-4 (RULED 2026-10-03: automatic emergency funding, v13) | — | On a revision-2 board `DeclareBankruptcy` is refused (`retiredDeclarationRefusal`) and `canDeclareBankruptcy` is false; the button must go. W2-G must be reconciled to the v13 authority before it starts: no player "Declare bankruptcy" (refused on revision 2), one `EmergencySellPortfolio` instead of single forced sales, `ForgoTrainTrade` / `ForgoPrivateFunding`, an automatic purchase and an automatic bankruptcy (`emergencyFundingFor(...).automatic`). |
| **P3-N018** · draft W2-G · draft execution map<br>The emergency modal's funding-offer legality is computed locally, not by `fundingPrivateOfferRefusal`. | NEW-SOURCE-FINDING | CONFIRMED — `EmergencyTrainPurchaseModal.tsx`:368-375; `gameEngine/emergencyFunding.ts`:321. | W2-G | **A** | — | — | — |
| **P3-N019** · draft NEW-1 (fleet loss) · draft execution map<br>The FleetLoss notice replays history in a fresh tab (dismissal is per-tab `sessionStorage`). | NEW-SOURCE-FINDING | CONFIRMED — `frontend/src/App.tsx`:11295-11405 (inside RED OR-verdict region), `rememberDismissed` (sessionStorage). | W3-A | **A** | OD-5; OD-12 if the prune region must change | — | The draft placed this fix in 11295-11405 without flagging that the range is inside its own RED region 11136-11659. Prefer a fix in the dismissal store. |
| **P3-N020** · draft §9 rollbacks · draft execution map<br>Refused-action rollbacks: an ability/JK spend survives a refused lay; `ran:true` and the step advance survive a refused run. | NEW-SOURCE-FINDING | CONFIRMED by reading — needs a per-action refusal signal from the link callbacks (RED). | W3-C | **A** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | The draft deferred this to Phase 4. It is a known defect; it stays in Phase 3 behind OD-12. |
| **P3-N021** · draft §9 press latch · draft execution map<br>The `press:true` latch does not cover the automatic presses (OpenStockRound, M&H exchange, Undo, PlaceHomeStation, SetBoPar). | NEW-SOURCE-FINDING | CONFIRMED by reading — `utils/doubleActionWindow.test.ts` pins the submit-half text. | W3-B | **A** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | — |
| **P3-N022** · SI ledger / DH-3 / draft §9 · draft execution map<br>Shell-local OR facts: `routesRunThisTurn`, `mustBuyTrain`, the D&H optimistic ability set and `dhStationForfeited` (DH-3), client auto-skip verdicts vs `nextDerivedAction`. | NEW-SOURCE-FINDING | CONFIRMED (App decomposition audit, 6.5-A §5.5). | Phase 5 (Pass E) | **E** | — | On every derived skip, compare the bar's step with the server's `operating_sub_phase` (export the log). | These are the refactor's behaviour passes (App decomposition plan "Pass E"); the owner's fixed roadmap (plan §1) places the major App.tsx refactor in Phase 5. |
| **P3-N023** · SBS-3 (6.5-A) · draft execution map<br>Brown Pool Buy → Sell → Buy is accepted (authority too loose). | NEW-SOURCE-FINDING | CONFIRMED — V13_SCOPE_VERIFICATION §4.3 (APPROVED DEFECT, reproduced at 6455b6e). | W3-K (rules v13) | **A** | OD-10(a) (RULED 2026-10-03: in the v13 batch, the official Brown rule) | — | Official Brown rule only; V-6.3 "Buy All" is NOT implemented. **Status:** IMPLEMENTED — W3-K, `phase3/w3-k-rules-v13` (integrated on `phase3/wave2a-v13-integration`, merge `ed5e69a`): the turn-scoped Brown Bank Pool continuation closes on any sale; Pool → Sell → Pool refused (`rulesV13StockRound.test.ts`). |
| **P3-N024** · SBS-4 / OD-A-4 · draft execution map<br>A Brown IPO first purchase opens the Pool continuation. | NEW-SOURCE-FINDING | CONFIRMED — V13_SCOPE_VERIFICATION §5 precise reproduction: the first purchase of the turn from a STARTED Brown-zone corporation's IPO opened the Pool continuation (the owner's par-space objection applies only to a corporation's first-ever purchase). | W3-K (rules v13) | **A** | OD-2 (SBS-4 part) resolved by the precise reproduction + OD-10(a) (RULED 2026-10-03) | — | Formerly G (needs a precise reproduction); reproduced in V13_SCOPE_VERIFICATION §5, then implemented. **Status:** IMPLEMENTED — W3-K, `phase3/w3-k-rules-v13` (integrated on `phase3/wave2a-v13-integration`, merge `ed5e69a`): only a Brown-zone Bank Pool purchase opens the continuation; IPO → Pool and Pool → IPO refused (`rulesV13StockRound.test.ts`). |
| **P3-N025** · ING-1 · draft execution map<br>City-less token on a two-city hex can strand Routes (draft listed it for a v13 batch). | NEW-SOURCE-FINDING | RESOLVED — v12 refuses creating such a state (`gameEngine/rulesVersion.ts`:396; R12-2 §3). | — | **F** | — | — | — |
| **P3-N026** · OD-A-3 · draft execution map<br>D10 / E5 follow G19's first-upgrade terrain charge (draft listed it for a v13 batch). | NEW-SOURCE-FINDING | RESOLVED — owner ruling recorded in 6.5-B ("D10 and E5 follow G19"); engine already charges; copy updated (`RULES_HARDENING_BACKLOG.md`:4757). | — | **F** | — | — | — |

### Draft findings that are the same defect as an audit item (merged, no new ID)

| Draft finding | Merged into |
|---|---|
| Watcher sees a live **Place Home Station** (`App.tsx`:13549-13553, `!viewerAddress`) | AUD-06.03 (A-2) |
| Tutorials re-arm on every table mount (`App.tsx`:1080-1083) | AUD-01.06 (A-13) |
| Shell-only stage refusals in `purchaseBlockFor` / `saleBlockFor` | AUD-03.04 (SBS-1/2) and AUD-03.12 (S-4) |
| Sibling auction cards say "Not your turn" during a contest (the draft's W1-B tag `A2-new`, by elimination; `A1-new` is P3-N005) | AUD-02.03 |
| Undo label "the last drop-out" (`App.tsx`:8998) | AUD-02.02 (K-15) |
| M&H local rule ignores the 60% zone waiver and the certificate limit ("M2-new") | AUD-10.02 (U-35 i/ii) |
| Route pre-dispatch uses `evaluateRouteSet`, not `routeSetRefusal` ("NEW-2-routes") | AUD-07.01 (K-11) |
| Map click precedence ("map-precedence") | AUD-05.02 (A-7) |
| Consent prompts and the embedded `ProposePrivatePurchase` unlatched ("NEW-4" in W2-C) | AUD-14.06 |
| Connection banner overwrites a refusal in the strip ("NEW-4" in W3-C) | AUD-14.01 |
| No UI reader of `pending_mh_exchange` | AUD-10.03 / AUD-10.06 |
| The derived loop appends a minted action without checking refusal (`replayLog.ts`:641-655) | AUD-08.01 (GR-1) |
| Server-path BuyStock refusals lack `marketZoneFor` (`roomSession.ts`:915) | AUD-14.03 (U-30) |
| "Home-token step marker" in the Rules Reference | AUD-06.07 |
| The draft's W1-D tag `NEW-3` (undefined in the draft; W1-D's scope beyond K-05 / U-20 / U-21 / K-14) | P3-N006, P3-N007 |

### Draft deferrals overturned (known defects kept in Phase 3)

The draft moved these to Phase 4 or "later" without an audit playtest label or an owner placement. Each is back in Phase 3:

| Draft deferral | Now |
|---|---|
| `ran:true` correction "is RED" (A-17) | AUD-04.02 → W1-G (the nothing-sent case is outside every RED region) |
| Refused-action rollbacks | P3-N020 → W3-C behind OD-12 |
| `press:true` latch for automatic presses | P3-N021 → W3-B behind OD-12 |
| I-1 queued-submission state; R4 dropped form; I-2 / I-3 "cosmetics" | AUD-02.05, AUD-19.01, AUD-03.11, AUD-02.06, AUD-03.10 → W3-I / W2-F |
| LOW-4 | P3-N011 → W1-E |
| K-24 float placeholder "→ Phase 5" | AUD-20.09 → W1-N |
| Statistics U-41 / U-43 "→ their own pass" | AUD-12.02 / AUD-12.03 → W2-L behind OD-13 |
| U-7 card wash; "U-8 closed" default | AUD-12.05 / AUD-12.06 → OD-14 (not defaulted) |
| "The flourish backlog" | VF OPEN rows → W3-H / OD-14 / OD-17 |
| U-4 polish | AUD-09.07 → W2-G |
| Phone-width layout and keyboard map access "→ Phase 5" | OD-10(b) (owner decides; not defaulted); zoom-aware breakpoints AUD-16.05 → W1-O |
| "Money-panel styling" (a Part C U-44 note, not an audit item) | OD-14(i) → W2-K if ruled in |
| "Instrumentation I-1…I-7, only if Phase 4 asks" (the 6.5 preflight's §9 instrumentation IDs — not the 6.5-B review items I-1…I-4, and not `VF/I-5`, `VF/I-7`) | Not a defect: a Phase-4 tooling option, recorded in the plan's §8 |
| "First to cut if Phase 3 runs long: W3-A, W3-C, W3-E" | Overturned: nothing is cut without an owner ruling. W3-E is conditional on OD-11; W3-A and W3-C carry known defects |
| Draft W3-F's named checklist rows (A-3, A-5, S-3, S-4, S-11, O-1, O-8, O-9, O-12) | W3-F re-expresses them in `docs/phase3/PHASE4_PLAYTEST_CHECKLIST.md` |

## Audit bullet → row map

Bullets are numbered `section.ordinal` in the order they appear in the preserved audit (sub-bullets counted in order).

| Audit bullet | Rows |
|---|---|
| 1.1 | AUD-01.01, AUD-01.02 |
| 1.2 | AUD-01.03 |
| 1.3 | AUD-01.04 |
| 1.4 | AUD-01.05 |
| 1.5 | AUD-01.06 |
| 1.6 | AUD-01.07, AUD-01.08 |
| 1.7 | AUD-01.09 |
| 2.1 | AUD-02.01 |
| 2.2 | AUD-02.02 |
| 2.3 | AUD-02.03 |
| 2.4 | AUD-02.04 |
| 2.5 | AUD-02.05 |
| 2.6 | AUD-02.06 |
| 2.7 | AUD-02.07 |
| 2.8 | AUD-02.08 |
| 2.9 | AUD-02.09 |
| 2.10 | AUD-02.10, AUD-02.11, AUD-02.12, AUD-02.13 |
| 3.1 | AUD-03.01 |
| 3.2 | AUD-03.02 |
| 3.3 | AUD-03.03 |
| 3.4 | AUD-03.04 |
| 3.5 | AUD-03.05, AUD-03.06 |
| 3.6 | AUD-03.07 |
| 3.7 | AUD-03.08 |
| 3.8 | AUD-03.09 |
| 3.9 | AUD-03.10 |
| 3.10 | AUD-03.11 |
| 3.11 | AUD-03.12 |
| 3.12 | AUD-03.13, AUD-03.14, AUD-03.15 |
| 4.1 | AUD-04.01 |
| 4.2 | AUD-04.02 |
| 4.3 | AUD-04.03 |
| 4.4 | AUD-04.04 |
| 4.5 | AUD-04.05, AUD-04.06, AUD-04.07 |
| 4.6 | AUD-04.08 |
| 5.1 | AUD-05.01 |
| 5.2 | AUD-05.02 |
| 5.3 | AUD-05.03 |
| 5.4 | VF/D-13, VF/D-12, VF/D-16, VF/D-30, VF/D-17, VF/D-35 |
| 5.5 | AUD-05.04, VF/D-1, VF/D-4, VF/D-5, VF/D-6, VF/D-7, … (18 rows; see JSON) |
| 5.6 | AUD-05.05, AUD-05.06 |
| 6.1 | AUD-06.01, AUD-06.02 |
| 6.2 | AUD-06.03, AUD-06.04 |
| 6.3 | AUD-06.05 |
| 6.4 | AUD-06.06 |
| 6.5 | AUD-06.07 |
| 7.1 | AUD-07.01 |
| 7.2 | AUD-07.02 |
| 7.3 | AUD-07.03 |
| 7.4 | AUD-07.04 |
| 7.5 | AUD-07.05 |
| 7.6 | AUD-07.06 |
| 8.1 | AUD-08.01 |
| 8.2 | AUD-08.02, AUD-08.03, VF/F-1, VF/F-2, VF/F-8 |
| 9.1 | AUD-09.01, AUD-09.02 |
| 9.2 | AUD-09.03, AUD-09.04 |
| 9.3 | AUD-09.05 |
| 9.4 | AUD-09.06 |
| 9.5 | AUD-09.07, AUD-09.08, AUD-09.09 |
| 9.6 | AUD-09.10, AUD-09.11 |
| 10.1 | AUD-10.01 |
| 10.2 | AUD-10.02 |
| 10.3 | AUD-10.03 |
| 10.4 | AUD-10.04 |
| 10.5 | AUD-10.05 |
| 10.6 | AUD-10.06, AUD-10.07 |
| 11.1 | AUD-11.01 |
| 11.2 | AUD-11.02 |
| 11.3 | AUD-04.01, AUD-11.03, AUD-11.04 |
| 11.4 | AUD-11.05, AUD-11.06 |
| 12.1 | AUD-12.01 |
| 12.2 | AUD-12.02, AUD-12.03 |
| 12.3 | AUD-12.04 |
| 12.4 | AUD-12.05, AUD-12.06, AUD-12.07 |
| 13.1 | AUD-13.01 |
| 13.2 | AUD-13.02, AUD-01.03 |
| 13.3 | AUD-13.03, AUD-13.04, AUD-13.05, AUD-13.06 |
| 13.4 | AUD-13.07 |
| 13.5 | AUD-13.08 |
| 14.1 | AUD-14.01 |
| 14.2 | AUD-14.02 |
| 14.3 | AUD-14.03 |
| 14.4 | AUD-14.04 |
| 14.5 | AUD-14.05 |
| 14.6 | AUD-14.06, AUD-02.04 |
| 15.1 | VF/C-1, VF/C-3, VF/C-4, VF/C-5, VF/C-9, VF/D-1, … (68 rows; see JSON) |
| 15.2 | VF/C-7, VF/C-10, VF/D-12, VF/D-13, VF/D-16, VF/D-17, … (23 rows; see JSON) |
| 15.3 | VF/C-7, VF/E-6, VF/F-5 |
| 15.4 | VF/C-10 |
| 15.5 | VF/G-1 |
| 15.6 | VF/I-8, VF/J-5 |
| 15.7 | VF/I-10, VF/J-6 |
| 15.8 | VF/H-6 |
| 15.9 | AUD-15.01 |
| 16.1 | AUD-16.01 |
| 16.2 | AUD-16.02, AUD-16.03, AUD-16.04, AUD-16.05 |
| 16.3 | AUD-16.06, AUD-16.07, AUD-16.08, AUD-16.09 |
| 17.1 | AUD-17.01, AUD-17.02, AUD-17.03 |
| 17.2 | AUD-17.04 |
| 18.1 | AUD-18.01 |
| 18.2 | AUD-18.02 |
| 18.3 | AUD-18.03 |
| 18.4 | AUD-18.04, AUD-18.05, AUD-18.06, AUD-18.07 |
| 18.5 | AUD-18.08 |
| 19.1 | AUD-19.01, AUD-03.11 |
| 19.2 | AUD-19.02 |
| 19.3 | AUD-19.03 |
| 19.4 | AUD-19.04 |
| 20.1 | AUD-20.01 |
| 20.2 | AUD-20.02, AUD-20.03, AUD-20.04, AUD-20.05 |
| 20.3 | AUD-20.06, AUD-20.07 |
| 20.4 | AUD-20.08 |
| 20.5 | AUD-20.09, AUD-20.10, AUD-20.12 |
| 20.6 | AUD-20.11 |
| 21.1 | AUD-21.01 |
| 21.2 | AUD-21.02, AUD-21.03, AUD-21.04, AUD-10.07, AUD-09.11, AUD-21.05, AUD-21.06, AUD-21.07, AUD-21.08 |
| 21.3 | AUD-21.02 |
| 21.4 | AUD-21.03, AUD-21.04, AUD-10.07, AUD-09.11 |
| 21.5 | AUD-21.05 |
| 21.6 | AUD-21.06 |
| 21.7 | AUD-10.07 |
| 21.8 | AUD-21.07 |
| 21.9 | AUD-21.08 |

| Other audit statement | Rows |
|---|---|
| Scope: GitHub issues not read | AUD-00.01 |
| Gate item: U-28 | AUD-22.01 |
| Highest-risk #2: nine whose-turn derivations | AUD-23.01 |
| Closing: roadmap / canonical / Part F order | AUD-00.02 |
| Phase-4 list: 47 animation and audio PLAYTEST items | VF/C-1, VF/C-3, VF/C-4, VF/C-5, VF/C-9, VF/D-1, … (47 rows; see JSON) |
| Phase-4 list: retests U-1, U-2, U-9, U-12, U-13, U-14 | AUD-24.01, AUD-04.05, AUD-24.02, AUD-04.06, AUD-04.07, AUD-08.02 |
| Phase-4 list: H-05, DH-2, S-4, tile-ring facing, K-12's stall | AUD-11.05, AUD-06.06, AUD-03.12, AUD-05.04, AUD-24.03 |
| Phase-4 list: recovery R1–R12 and the Rules Reference checkpoints | AUD-19.03, AUD-24.04 |
| Phase-4 list: real-device, mobile, Firefox/Safari, touch, screen reader | AUD-16.06, AUD-16.07, AUD-16.08, AUD-16.09, AUD-13.08, AUD-17.04 |
| Phase-4 list: Delayed Auction 5-train cancellation reachability | AUD-24.05 |

## Re-checking this matrix

```bash
python3 docs/phase3/check_phase3_accounting.py            # accounting: exactly-once, bullet coverage, ID coverage
python3 docs/phase3/check_phase3_accounting.py --drift <pinned-base-sha>   # P0: which cited files changed since 8e897f9
```
