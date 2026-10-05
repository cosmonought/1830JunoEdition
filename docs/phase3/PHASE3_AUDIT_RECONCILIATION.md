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
| Audit items (`AUD-*`) | 185 | A 61 · B 65 · C 11 · D 22 · E 3 · F 23 · G 0 |
| Flourish-ledger items the audit counts (`VF/*`: 47 PLAYTEST, 21 recorded owner decisions, 23 OPEN) | 91 | A 0 · B 16 · C 6 · D 48 · E 0 · F 21 · G 0 |
| **Substantive audit items, total** | **276** | A 61 · B 81 · C 17 · D 70 · E 3 · F 44 · G 0 |
| Execution-map-only NEW-SOURCE-FINDINGS (`P3-N*`) | 27 | A 23 · B 1 · C 0 · D 0 · E 1 · F 2 · G 0 |

- **G = 0 among the audit's own items.** Where the audit and source disagree, the source evidence was unambiguous and the
  row is **F**, re-confirmed at the final integrated head in W3-F. P3-N024 (SBS-4) was G after the owner's OD-2 ruling
  (needs a precise reproduction); the v13 scope verification reproduced it precisely and W3-K implemented it (G → A).
- **Totals after the Wave-1 integration (2026-10-03):** AUD-09.10 (RR-4) moved C → B when OD-7 was ruled and implemented as
  copy; P3-N024 moved C → G under OD-2. The planning-snapshot totals were A 61 · B 59 · C 23 (audit) and C 2 · G 0 (P3-N).
- **Totals after W3-D (2026-10-04, `phase3/w3-d`, not integrated):** AUD-13.05 and AUD-13.06 moved C → B when OD-15(a) and OD-15(b) were ruled and W3-D implemented them. AUD-13.04 stays A, BLOCKED ONLY ON W3-A INTEGRATION (superseded 2026-10-05: deferred to the final tutorial pass).
- **What C means now (2026-10-05):** of the 17 C rows, 14 carry an owner ruling (status RULED), AUD-18.05 is ASSET PENDING (the Keplr logo), and AUD-04.04 / AUD-08.01 await the owner's slice placement (an owner decision open).
- **Totals after the consolidated pre-playtest integration (2026-10-05):** owner placements moved AUD-11.04 C → B (the clock, lane A), AUD-20.08 C → B (the Terms shell, lane D), AUD-19.04 C → E (deferred pending Phase-4 validation) and VF/D-17 B → D (a Phase-4 observation); P3-N027 added (B, lane C).
- **Totals after the safe Wave-2 integration (2026-10-03):** AUD-07.03 (K-06 / U-17) moved C → B when OD-11 was ruled (build) and W3-E landed; AUD-20.01 (U-44) moved C → B when OD-9(a) was ruled and W2-K landed. AUD-18.05 (the Keplr logo) stays C, ASSET PENDING.
- **Totals after W3-K (rules v13, 2026-10-03):** P3-N023 (SBS-3) C → A and P3-N024 (SBS-4) G → A, both IMPLEMENTED on
  `phase3/w3-k-rules-v13`. The audit rows keep their dispositions (DH-1, GR-1, VF D-18 and D-22 stay C with updated
  status; OD-10(a) ruled them out of v13).
- **Totals after the W2-M follow-up triage (2026-10-04, on `phase3/w2-m-wallet-dispute-ux`):** two §20 rows added, both
  B and LOW, both server residues of W2-M's browser-only rows and both OPEN pending the owner's authorization of a server
  change: AUD-20.13 (the proof's own time is stored but not projected, so a re-proven link over a day old reads "Re-prove"
  after a reload) and AUD-20.14 (a `replace-required` answer spends the signed link request, so the stale-view replacement
  costs a second signature). The waiting-room roster's "Wallet linked" for the viewer's own aged seat is recorded on
  AUD-20.02 (it describes linkage; no new row).
- **W2-M follow-ups implemented (2026-10-04, owner-approved, on `phase3/w2-m-wallet-dispute-ux` `a97b1d1` + `9637ca7`):**
  AUD-20.13 and AUD-20.14 IMPLEMENTED (dispositions unchanged, B); the roster wording is accepted temporarily (AUD-20.02).
  Owner design direction: the Profile + Keplr flow is provisional and slated for a later redesign; these are minimal,
  removable compatibility changes, not an endorsement of the current flow.
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
| W1-I | PARTIAL — the unconditional portion is complete (L5 `9dcad19`, `b9fd1bf`, `82b93ca`, `beac07a`, `3904533`, `fee2f66`); OD-14(a) remains (the fit-probe removal, AUD-01.01, waits on it, and W1-I-b exists only if it is ruled in). **2026-10-04: COMPLETE on `phase3/w1-i-completion` @ `195755a`, NOT integrated** — OD-14(a) RULED; see "W1-I completion status" |
| W1-J | COMPLETE — L5 `5a56987` |
| W1-K | NOT STARTED — not one of the seven Wave-1 lane branches |
| W1-L | COMPLETE — unconditional portion, L6 `de22084` + review fix `8d6f1e9`; RR-4 copy per OD-7 at the integration (`ca73834`). AUD-18.07 stays owner-gated (OD-14(e)) |
| W1-M | COMPLETE — L2 `6f42dca` |
| W1-N | COMPLETE — L7 `9d9376b` + review fixes `06c3a91`; the OD-12 RED R2 call-site deletion `87d63c4` (+ comment follow-up `819a204`); tie-aware game-over strip at the integration (`8dc79e0`) |
| W1-O | COMPLETE — L7 `2c3134f` + review fix `b19dff5`; the RulesReference breakpoint hunk at the integration (`8dc79e0`) |
| W3-K | COMPLETE — ACCEPTED (owner, 2026-10-04) and INTEGRATED on `phase3/wave2a-v13-integration` (2026-10-04): `phase3/w3-k-rules-v13` @ `be1fd10` merged `--no-ff` onto `phase3/wave2a-integration` @ `96ccb22`, its 9 commits carried unchanged (same SHAs). OD-2, SBS-3, SBS-4, OD-4 with the owner's 2026-10-04 rulings 1-5 and the four review findings. The ledger's PARTIAL (held only for the shared row AUD-03.04) lifted with W2-B's one-click "Pass Turn" control, integrated on `phase3/wave2-bcg-v13cert-integration` (merge `181e51e`). v13 settlement certification PASS / CERTIFIED and INTEGRATED there (merge `69c7496` of `phase3/v13-settlement-certification` @ `7916763`). RULES_ENGINE_VERSION 13; supported live [13]; settlement-certified [10, 11, 12, 13]. Not deployable until drained v12 rooms and the final integrated owner gate (W2-D since integrated on `phase3/wave2-bcgd-v13cert-integration`, merge `4072fd0`; W2-F since integrated on `phase3/wave2-bcgdf-v13cert-integration`, merge `dfe6d13`; W3-I since integrated on `phase3/wave3-i-v13cert-integration`, merge `5a22e38`; W2-I since integrated on `phase3/wave3-i-w2i-v13cert-integration`, merge `78f9164`; W2-J since integrated on `phase3/wave3-i-w2i-w2j-v13cert-integration`, merge `32ead52`; W3-C since integrated on `phase3/wave3-i-w2i-w2j-w3c-v13cert-integration`, merge `b32ef6e`; other open slices are tracked separately) |

*(At the Wave-1 integration: W2-A, W2-B and W2-F were not started and W3-K had not landed.)* Since then W2-A is COMPLETE and integrated ("Wave-2A integration status"), and W3-K is ACCEPTED and INTEGRATED, its ledger PARTIAL lifted with W2-B; W2-B, W2-C, W2-G and the v13 settlement certification are COMPLETE and integrated ("Wave-2 B+C+G + v13 certification integration status"); W2-D is COMPLETE and integrated ("Wave-2 B+C+G+D integration status"); W2-F is COMPLETE and integrated ("Wave-2 B+C+G+D+F integration status"); W3-I is COMPLETE and integrated ("W3-I integration status"); W2-I is COMPLETE and integrated ("W2-I integration status"); W2-J is COMPLETE and integrated ("W2-J integration status"); W3-C is COMPLETE and integrated ("W3-C integration status"). Every W1 row's own status (`IMPLEMENTED`, `PRE-WORK DONE`,
`OPEN`, `NOT STARTED`, `RULED`, `NEEDS PRECISE REPRODUCTION / CLARIFICATION`) is the `status` field of its JSON row; the
checker verifies that a COMPLETE slice has no unimplemented A/B row and that each status agrees with its disposition.

**Owner rulings recorded (2026-10-03)** — full text in the plan, §7.3:

- **OD-1 — AUTHORITATIVE HOLD PRESENTATION.** Recorded only. Not implemented in the Wave-1 integration: W2-A and W2-F implement it (W2-G and W2-H take its viewer scope). The Routes/Dividends spectator visibility is unchanged by Wave 1.
- **OD-2 — STOCK ROUND PASS.** Recorded as RESOLVED; NOT implemented in the Wave-1 integration (no rules or version change). SBS-2 goes to the v13 rules slice (W3-K is its vehicle) with its own settlement certification; W2-B presents the one-click "Pass Turn". P3-N024 (SBS-4) becomes G: needs precise reproduction / clarification. The rules version stays v12.
- **OD-7 — FORCED TRAIN PURCHASE.** Implemented as copy at the Wave-1 integration (`ca73834`): every RR-4 site in `components/RulesReference.tsx` corrected; the engine (which already allowed any legal treasury-funded purchase) is unchanged. AUD-09.10 C → B, IMPLEMENTED. W2-J and W3-K no longer carry RR-4.
- **OD-12 — RED REGIONS.** W1-N's R2 call site deleted as its own commit (`87d63c4`, independently reviewed: APPROVE WITH NITS, comment nits fixed outside RED in `819a204`). The remaining OD-12 candidates (W2-J K-18; W3-C, W3-B, W3-I, W3-A, W3-H) each still land as one separately reviewed RED commit under §5.1's serialization rule.
- **OD-4 — EMERGENCY FUNDING (AUTOMATIC BANKRUPTCY).** Implemented in W3-K on `phase3/w3-k-rules-v13` (rules v13, gated on rules revision 2). W2-G (AUD-09.05/06/07, P3-N017/018) reconciled to the v13 authority and integrated on `phase3/wave2-bcg-v13cert-integration` (merge `b84247f`). Settlement certification for 13: PASS / CERTIFIED on `phase3/v13-settlement-certification` (bankruptcy vectors included), integrated on `phase3/wave2-bcg-v13cert-integration` (merge `69c7496`). The 2026-10-04 rulings 1, 4 and 5 and the four review findings are implemented on the same branch.
- **OD-10 — V13 RULES BATCH IN PHASE 3.** W3-K implemented on `phase3/w3-k-rules-v13`; integrated on `phase3/wave2a-v13-integration` (merge `ed5e69a`). AUD-04.04 and AUD-08.01 leave W3-K (owner placement open; no version bump needed). P3-N023 and P3-N024 C/G → A, IMPLEMENTED. OD-10(b) stays open (RULED 2026-10-05: Phase 5). The 2026-10-04 rulings 2 and 3 are implemented on the same branch. v13 settlement certification: PASS / CERTIFIED on `phase3/v13-settlement-certification`, integrated on `phase3/wave2-bcg-v13cert-integration` (merge `69c7496`).
- **OD-17 — TILE-UPGRADE CROSS-REFERENCES.** VF/D-18 and VF/D-22 stay C (the ledger still lists them OPEN) with status RULED — no change; the ledger and comment cleanup is a docs task (closure contract item 12).

Remaining Wave-1 owner blocker: **OD-14(a)** (W1-I's fit-probe removal and the optional W1-I-b) — **RULED 2026-10-04** (keep; probe removed by W1-I `1b76512`; W1-I-b not opened). W1-K was not in Wave 1.

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

**Branch** `phase3/wave2-bcg-v13cert-integration` from `phase3/wave2a-v13-integration` @ `16b79b2` — *(superseded as baseline by
`phase3/wave2-bcgd-v13cert-integration`, below)* **the provisional Phase-3
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

## W2-D slice status (2026-10-04)

**Branch** `phase3/w2-d-mh-offturn-jk` @ `a7488ff` (code `db50c38`, independent-review fixes `a7488ff`) from
`phase3/wave2-bcg-v13cert-integration` @ `9b19d9d`. **COMPLETE on its slice branch; NOT integrated** (integration and owner broad
gate pending). *(Written as branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave2-bcgd-v13cert-integration`, merge `4072fd0` — see "Wave-2 B+C+G+D integration status" below.)* Presentation only -- the engine already owned every rule (`mohawkExchange.ts`: the SR + OR window, own-SR-turn
executes / everything else queues, holds refuse rather than queue, one pending request). `stockRoundExchangeOffers` admits the
Operating Round and marks the M&H offer `offTurn` (auction / finished game / non-owner / corporation-owned / closed / non-sandbox
still offer nothing). The bar lets an `offTurn` offer past `mayActThisTurn` and readies it on the new required `offTurnPowerReady`
(`controlsEnabled && !actionInFlight && !scrubbing`); ordinary corporate chips keep `mayActThisTurn` and `sessionReady`, which is
unchanged; the bar names no power. The chip's hold is the authority's refusal of `ExchangePrivate`, a new `dockHold.exchangePrivate`
field asked through W2-A's one call site (the memo now sits after `dockHold` and W2-C's offer authorities), replacing 6.5-B's
`privateTradeHoldReason` for the chip; W2-E's pending > hold > live precedence kept. The JK chip is extracted to `jkPowerOfferFor`
(Operating Round + Track only) and its arm's disarm is keyed on `jkArmScope` (round type, macro round, sub-round, acting
corporation, step), so it never survives an OR. AUD-04.03, AUD-10.05 and P3-N003 IMPLEMENTED; W2-E's "Stock-Round-only chip"
residue and W2-A's M&H-chip residue resolved (the Stock Round share controls' residue stays W2-F's). Tests: `phase3W2DMhOffTurnJk`
(new); moved pins `activePrivatePower`, `powerRefusalAndChips`, `privatePowerOffer`, `phase65bShellWiring`,
`phase3W2EMhQueuedVisibility`; the two rendered-bar harnesses gain the required prop. Known, not taken (pre-existing, out of
scope): an `automatic: true` dispatch bypasses the reload "catching up" guard. Rules version unchanged (v13); settlement unchanged.

## Wave-2 B+C+G+D integration status (2026-10-04)

**Branch** `phase3/wave2-bcgd-v13cert-integration` from `phase3/wave2-bcg-v13cert-integration` @ `9b19d9d` — *(superseded as baseline by `phase3/wave2-bcgdf-v13cert-integration`,
below)* **the provisional Phase-3 integration
baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W2-D slice
(`phase3/w2-d-mh-offturn-jk` @ `f0abdd7`) merged `--no-ff` (merge `4072fd0`), its three commits carried unchanged (`db50c38` code,
`a7488ff` review fixes, `f0abdd7` slice tracking), then this tracking commit.

- **No conflict.** W2-D was 3 ahead / 0 behind `9b19d9d`, so the merged tree equals `f0abdd7`'s exactly. No `server/`, `gameEngine/`,
  `rulesVersion.ts` or settlement file differs from `9b19d9d`.
- **Rows:** AUD-04.03, AUD-10.05, P3-N003 IMPLEMENTED and INTEGRATED. W2-E's "Stock-Round-only chip" residue and W2-A's M&H-chip
  residue are closed; the Stock Round share controls' `privateTradeHoldReason` residue stays W2-F's *(since closed by W2-F and
  integrated, merge `dfe6d13`)*.
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; compatibility keys and
  settlement fixtures unchanged.
- **Lanes:** W2-B, W2-C, W2-G, the v13 settlement certification and W2-D **COMPLETE and INTEGRATED**. W2-F remains **NOT STARTED,
  UNLOCKED** *(as written; since COMPLETE and INTEGRATED, merge `dfe6d13`)*. Not deployable until drained v12 rooms and the final integrated owner gate.

## W2-F slice status (2026-10-04)

**Branch** `phase3/w2-f-waiting-surface` @ `8d4e9f5` (code `5a0bf37`, independent-review fixes `8d4e9f5`) from `phase3/wave2-bcgd-v13cert-integration` @ `7d8f73e` (the
provisional baseline at the time). **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending).
*(Written as branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave2-bcgdf-v13cert-integration`, merge `dfe6d13` — see "Wave-2 B+C+G+D+F integration status"
below.)*
Presentation only, over W2-A's one hold answer (`dockHoldView`); nothing restates a rule or chooses between holds.

- **AUD-09.09 (U-6) / AUD-09.08 (U-5):** the five prompts in the consent slot (private purchase offer, train offer, emergency funding
  offer, player <-> player trade pointer, excess-train discard) print one waiting line (`components/WaitingOnLine.tsx`): who decides
  ("This is X's decision." / "Waiting on X.", the seat named by the existing seat authorities) and the authority's own sentence, the
  same on every seat. The three ordinary-offer prompts read `dockHold.standingOffer` (`pendingOfferBlock`, i.e. `describeStandingOffer`)
  so a higher hold standing beside an offer (a train offer under the v12 funding obligation) never makes the offer prompt describe
  another decision; the funding-offer and discard prompts read `dockHold.turnHoldReason` (each is the top hold while it stands). A
  scrubbed board reports no hold and prints the who-line alone. The proposer's withdrawal stays the Rescind button.
- **AUD-03.10 (I-3):** the player-trade pointer stands aside (`standAside`) while the Private Companies section is on screen (the
  Stocks tab with a Stock Round model) -- that section carries the offer with the same answer / withdrawal, and the panel states the
  hold -- so the fixed pointer never covers a card; elsewhere it is unchanged. The other prompts are Operating-Round-only.
- **Residue closed (W2-A / W2-C / W2-D notes):** the Stock Round share controls read `dockHold.buyStock` / `.sellStock` (the
  authority's refusal of exactly `BuyStock` / `SellStock`, asked first via `heldFirst`) and the panel flag `.shareControls` (only
  when both are refused, so the v12 funding hold, which passes `SellStock`, never greys Sell), not 6.5-B's `privateTradeHoldReason`.
  Auto-Buy keeps its own `purchaseBlockFor`.
- **Deferred (LOW):** on the Stocks tab nothing scrolls the recipient to the offer's card. Rules version and settlement unchanged.

## Wave-2 B+C+G+D+F integration status (2026-10-04)

**Branch** `phase3/wave2-bcgdf-v13cert-integration` from `phase3/wave2-bcgd-v13cert-integration` @ `7d8f73e` — *(superseded as baseline by
`phase3/wave3-i-v13cert-integration`, below)* **the provisional Phase-3 integration
baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W2-F slice
(`phase3/w2-f-waiting-surface` @ `f19a22b`) merged `--no-ff` (merge `dfe6d13`, parents `7d8f73e`, `f19a22b`), its three commits carried
unchanged (`5a0bf37` code, `8d4e9f5` review fixes, `f19a22b` slice tracking), then this tracking commit.

- **No conflict.** W2-F was 3 ahead / 0 behind `7d8f73e`, so the merged tree equals `f19a22b`'s exactly. No `server/`, `gameEngine/`,
  `contracts/`, `rulesVersion.ts`, settlement or fixture file differs from `7d8f73e`.
- **Owner ruling:** the I-3 implementation is ACCEPTED -- the redundant player-trade pointer stands aside on the Stocks tab, where the
  Private Companies card carries the same offer and controls.
- **Rows:** AUD-03.10, AUD-09.08, AUD-09.09 IMPLEMENTED and INTEGRATED. The Stock Round share controls' `privateTradeHoldReason`
  residue stays CLOSED.
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; compatibility keys and
  settlement fixtures unchanged.
- **Lanes:** W2-B, W2-C, W2-G, the v13 settlement certification, W2-D and W2-F **COMPLETE and INTEGRATED**; no accepted slice awaits
  integration. Not deployable until drained v12 rooms and the final integrated owner gate.
- **Follow-ups (not implemented here):** LOW (deferred, W2-F) -- on the Stocks tab nothing scrolls the trade recipient to the offer's
  card. LOW (predates W2-F, integration review) -- while an emergency funding private offer stands, a non-president seat sees both
  W2-G's emergency waiting card and the funding prompt's waiting line. NIT -- the `waitingSentence` prop comments on the three
  ordinary-offer prompts and `WaitingOnLine` name `dockHold.turnHoldReason`; those prompts are passed `dockHold.standingOffer`.

## W3-I slice status (2026-10-04)

**Branch** `phase3/w3-i-offers` @ `d663b1c` (code `5c6d7f8`, independent-review fixes `d663b1c`) from `phase3/wave2-bcgdf-v13cert-integration` @ `c3f43b7` (the provisional
baseline at the time). **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending). *(Written as
branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave3-i-v13cert-integration`, merge `5a22e38` — see "W3-I integration status" below.)* Its
dependencies W2-F and W2-H are integrated in the base. Presentation only; the drain and `runGameplayAction` are untouched (no OD-12
edit).

- **AUD-19.01 (I-1 / R4):** a read-only queue accessor on the room link (`serverLink.ts` `LinkQueueState`: `unsent`, `unsettled`,
  `settled`, `lastOutcome`; `link.queue` and the active-link store, idle again when the link ends) read once through
  `utils/useLinkQueue.ts`, outside the drain. The queue itself is unchanged. The B&O par prompt and the three offer forms (Private
  Companies trade form, Buy Private Company, Buy Trains from a Corporation) show "Queued — will send on reconnect." and take no second
  press while the link holds the last submission.
- **AUD-02.05 (I-1):** the par prompt never releases while the link holds its press (the 4 s hold re-arms).
- **AUD-02.06 (I-2):** "not reached the table yet" only after the link reports the press NOT applied (or nothing was sent); a press
  reported applied stays held until the board stops owing the par (one extra hold, then a silent release). No room link: unchanged.
- **AUD-03.11 (R4):** the Private Companies offer form is kept until the proposal lands (the standing offer closes it); a dropped or
  refused send leaves it live with what was typed. Reading recorded: kept open after a refusal rather than closed *(since ACCEPTED by
  the owner at integration)*.
- **Not taken:** the W2-F follow-ups (the duplicate-waiting LOW, the two NITs) stay recorded where they are. Rules version and
  settlement unchanged.

## W3-I integration status (2026-10-04)

**Branch** `phase3/wave3-i-v13cert-integration` from `phase3/wave2-bcgdf-v13cert-integration` @ `c3f43b7` — *(superseded as baseline by
`phase3/wave3-i-w2i-v13cert-integration`, below)* **the provisional Phase-3 integration
baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W3-I slice (`phase3/w3-i-offers` @
`92cdb5d`) merged `--no-ff` (merge `5a22e38`, parents `c3f43b7`, `92cdb5d`), its three commits carried unchanged (`5c6d7f8` code,
`d663b1c` review fixes, `92cdb5d` slice tracking), then this tracking commit.

- **No conflict.** W3-I was 3 ahead / 0 behind `c3f43b7`, so the merged tree equals `92cdb5d`'s exactly. No `server/`, `gameEngine/`,
  `contracts/`, `rulesVersion.ts`, settlement or fixture file differs from `c3f43b7`; `App.tsx` gains only the one hook read and four
  prop hand-offs (no drain, link-callback or `runGameplayAction` change).
- **Owner ruling:** for AUD-03.11 / R4 a refused proposal may leave the form open with its typed values preserved so the player can
  correct and resend.
- **Rows:** AUD-02.05, AUD-02.06, AUD-03.11, AUD-19.01 IMPLEMENTED and INTEGRATED.
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; compatibility keys and
  settlement fixtures unchanged.
- **Lanes:** W2-B, W2-C, W2-G, the v13 settlement certification, W2-D, W2-F and W3-I **COMPLETE and INTEGRATED**; lane L3 is complete;
  no accepted slice awaits integration. Not deployable until drained v12 rooms and the final integrated owner gate.
- **Follow-ups (not implemented here):** LOW (integration review) -- the Buy Trains from a Corporation offer form still closes on Send;
  a second press is prevented, but its queued line shows only if the form is reopened while the link holds the offer, and a dropped
  train offer must be retyped. Carried unchanged from the W2-F integration: the duplicate emergency-waiting LOW, the two NITs, and the
  deferred scroll-to-card LOW.

## W2-I slice status (2026-10-04)

**Branch** `phase3/w2-i-status-visibility` @ `a18bac4` (code `c17e844`, independent-review fix `a18bac4`) from `phase3/wave3-i-v13cert-integration` @ `7a9b16b` (the current provisional
baseline at the time). **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending). *(Written as
branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave3-i-w2i-v13cert-integration`, merge `78f9164` — see "W2-I integration status" below.)* OD-6 RESOLVED
(owner Option A, 2026-10-04). Presentation only; App regions R-ROOMSTRIP and R-RRMOUNT.

- **AUD-01.07 (OD-6, C → B):** DECIDED — the opaque `game_id` is intentionally not displayed (LIVE-2 §7.2). The visible identity is
  unchanged (room code / "Private game" / the legacy on-chain game number). The Rules Reference's existing build line reads
  "Build <id> · Rules v13": the build from `CLIENT_BUILD_ID`, the version from the live board's own `rules_engine_version`
  (`boardRulesVersion`; "Rules unpinned (legacy)" on an unpinned board; the build alone with no board). Nothing added to the top bar.
- **AUD-02.08:** `DelayedAuctionStatusChip` in the room strip (hosted, sandbox and legacy tables): "Delayed auction owed" while
  `private_auction_complete === false`; "Delayed auction cancelled" once the first 5-train's D-55 transition leaves every private
  closed and ownerless (`utils/delayedAuctionStatus.ts`; board fields only, no log text). Silent outside the variant, during the
  auction round (its dashboard says so) and at GameEnd. Review HIGH fixed in `a18bac4`: the B&O's first-train closure and the M&H
  exchange also release their owner, so the test is EVERY private ownerless, not ANY.
- **AUD-11.03:** at GameEnd the Rules Reference says "Game over" / "This game has ended" (context strip, Overview heading, kicker and
  lead) instead of "No live round"; copy only, from the board's GameEnd; a live round type wins.
- **Not taken:** W2-J, W2-M; the W2-F / W3-I follow-ups and the "Buy Trains from a Corporation form closes after Send" LOW stay
  recorded where they are. Rules version and settlement unchanged.

## W2-I integration status (2026-10-04)

**Branch** `phase3/wave3-i-w2i-v13cert-integration` from `phase3/wave3-i-v13cert-integration` @ `7a9b16b` — *(superseded as baseline by
`phase3/wave3-i-w2i-w2j-v13cert-integration`, below)* **the provisional Phase-3 integration
baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W2-I slice
(`phase3/w2-i-status-visibility` @ `60146da`) merged `--no-ff` (merge `78f9164`, parents `7a9b16b`, `60146da`), its three commits carried
unchanged (`c17e844` code, `a18bac4` review fix, `60146da` slice tracking), then this tracking commit.

- **No conflict.** W2-I was 3 ahead / 0 behind `7a9b16b`, so the merged tree equals `60146da`'s exactly. No `server/`, `gameEngine/`,
  `contracts/`, `rulesVersion.ts`, settlement or fixture file differs from `7a9b16b`; `App.tsx` gains only the room-strip chip
  (R-ROOMSTRIP) and two `RulesReference` props (R-RRMOUNT).
- **Owner ruling (OD-6 Option A, accepted):** the opaque `game_id` stays off screen; the room code / "Private game" remains the visible
  identity; the Rules Reference shows "Build <id> · Rules v13" from authoritative sources.
- **Rows:** AUD-01.07 (DECIDED), AUD-02.08, AUD-11.03 IMPLEMENTED and INTEGRATED.
- **Pre-existing meta-test failures, compared on `7a9b16b` and on the merge:** `sourceGuards` G1/G2 (older W2-F, W3-I and W2-D tests),
  `boardInEffect` (`settlementV13Vectors.ts` and two `aws/deploy/migration` files), `liveHygiene` (two LIVE-0 bind tests) -- the same
  4 failed tests with identical output on both. PRE-EXISTING / NON-BLOCKING for this integration; not fixed here.
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; compatibility keys and
  settlement fixtures unchanged.
- **Lanes:** W2-B, W2-C, W2-G, the v13 settlement certification, W2-D, W2-F, W3-I and W2-I **COMPLETE and INTEGRATED**; no accepted
  slice awaits integration. Not deployable until drained v12 rooms and the final integrated owner gate.
- **Follow-ups (not implemented here):** carried unchanged from the W3-I integration -- the Buy Trains from a Corporation form LOW, the
  W2-F duplicate-waiting LOW, the two NITs and the deferred scroll-to-card LOW.

## W2-J slice status (2026-10-04)

**Branch** `phase3/w2-j-narration` @ `99b5651` from `phase3/wave3-i-w2i-v13cert-integration` @ `c774530` (the current provisional baseline,
unchanged). **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending). OD-8 RULED 2026-10-04 (Option A). *(Written as
branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave3-i-w2i-w2j-v13cert-integration`, merge `32ead52` — see "W2-J integration status" below.)*

- **AUD-03.08 (K-18 / U-36), OD-12 RED R2 — its own commit `b328e53`:** the sold-out rise's Activity Log line read its marks from the
  shell's market mirror, which the dispatch had already advanced to the risen board, so it described a further, hypothetical rise. The
  one resolver line now reads `handedBoard.market_positions` (the marks the reducer was handed and rose from). Nothing else in RED R2
  changed.
- **AUD-10.01 (K-20 / U-33) — `464dfbe` + review fix `5f5ddd2`:** `describeGameplayAction` appends "X becomes president of T with N%,
  taking the President's Certificate from Y, who now holds M%." when the settled board crowns a different president than the before
  board (read off the two boards, not re-decided; a first president is not a change), and, when another holder ends level with the new
  president, "… each hold N%; the tie goes to the player seated closest to Y going clockwise, which is X." (§5.4), the level holders
  listed clockwise from Y.
- **AUD-03.09 (K-22 / U-37), OD-8 Option A — `8a448d2` + review fixes `99b5651`:** since #1616 the home station is placed at the start
  of the corporation's first operating turn, and #1343's combined float line rode that placement. Now `describeFloat` says "<CORP> has
  floated. It received $<AMOUNT>." on the purchase that floats the corporation (the `is_floated` false -> true transition, with the
  capital on the settled board), and the placement says only "<CORP> placed its home station on <HEX>."; the combined line is gone.
  Copy only. Recorded LOW (pre-existing #750 behaviour): on a float through an M&H exchange or a C&A grant the treasury diagnostic
  still prints beside the float line on the same entry.
- **OD-7:** ruled copy-only and already landed in W1-L (`ca73834`); nothing here. **Not taken:** W3-C, the W2-F / W3-I / W2-I
  follow-ups. Rules version and settlement unchanged. The four pre-existing meta-test failures are identical on `c774530` and on this
  branch.

## W2-J integration status (2026-10-04)

**Branch** `phase3/wave3-i-w2i-w2j-v13cert-integration` from `phase3/wave3-i-w2i-v13cert-integration` @ `c774530` — *(superseded as baseline by
`phase3/wave3-i-w2i-w2j-w3c-v13cert-integration`, below)* **the provisional Phase-3
integration baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W2-J slice
(`phase3/w2-j-narration` @ `0b33f69`) merged `--no-ff` (merge `32ead52`, parents `c774530`, `0b33f69`), its seven commits carried unchanged
(`b328e53` K-18 RED R2, `464dfbe` K-20, `5f5ddd2` review fix, `9927fd7` interim tracking, `8a448d2` K-22, `99b5651` review fixes,
`0b33f69` slice tracking), then this tracking commit.

- **No conflict.** W2-J was 7 ahead / 0 behind `c774530`, so the merged tree equals `0b33f69`'s exactly. No `server/`, `contracts/`,
  `rulesVersion.ts`, settlement or fixture file differs from `c774530`; `App.tsx` differs only by the accepted K-18 RED R2 resolver line.
- **gameEngine audit:** the only change is the `describeFloat` narration helper (`sandboxSession.ts`, called only by the shell's float
  loop); no reducer transition, float threshold, capitalisation, home-placement timing or board mutation changed.
- **Owner ruling OD-8 (Option A) intact:** "<CORP> has floated. It received $<AMOUNT>." at the purchase that floats it; "<CORP> placed its
  home station on <HEX>." at the placement; the combined line absent.
- **Rows:** AUD-03.08, AUD-10.01, AUD-03.09 IMPLEMENTED and INTEGRATED.
- **Pre-existing meta-test failures, compared on `c774530` and on the merge:** `sourceGuards` (1), `boardInEffect` (1), `liveHygiene` (2)
  -- identical output on both. PRE-EXISTING / NON-BLOCKING; not fixed here.
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; keys and fixtures unchanged.
- **Lanes:** W2-B, W2-C, W2-G, the v13 settlement certification, W2-D, W2-F, W3-I, W2-I and W2-J **COMPLETE and INTEGRATED**; no accepted
  slice awaits integration. Not deployable until drained v12 rooms and the final integrated owner gate.
- **Follow-ups (not implemented here):** the W2-J LOW (treasury diagnostic beside the float line on an M&H / C&A float); carried unchanged:
  the Buy Trains from a Corporation form LOW, the W2-F duplicate-waiting LOW, the two NITs and the deferred scroll-to-card LOW.

## W1-I completion status (2026-10-04)

**Branch** `phase3/w1-i-completion` @ `195755a` (code `1b76512`, review fix `195755a`) from `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f` (the current provisional baseline, unchanged). **COMPLETE on its slice branch; NOT integrated**
(integration and owner broad gate pending). The unconditional portion was integrated at Wave 1; this branch closes the owner-gated rest.

- **OD-14(a) — RULED (owner, 2026-10-04):** keep the step panels where they are; remove the temporary sticky-fit probe rather than
  moving the panels; do not open W1-I-b (plan §7.3). Transcription note (W1-I, from source at `d29bb2f`): since design note #828 the step-panel wrapper (`stepPanelRef`, a full-width row of its own) renders inside the sticky action bar's element, and `1b76512` leaves it there; the ruling's operative effect is no relocation -- the panels stay exactly where they are and W1-I-b is not opened.
- **AUD-01.01 (U-16) — IMPLEMENTED, `1b76512` + review fix `195755a`:** `useStickyFitProbe`, its call, its player-visible readout and the `fitProbe` style are removed,
  with the now-unused `canPinWithoutTrapping` import (#720's predicate and constant stay in `utils/stickyCollapse.ts` with their own tests).
  Tests: `stickyFitProbe.test.ts` deleted; its probe block went with the probe, and its three non-probe blocks (#812 -> #859/#860 and
  #889 bank line, #811 offer counterparty, #814 / #490a private intro) are carried verbatim into `utils/stepPanelCopy.test.ts` (review
  fix); `stickyTrap` re-scopes the hook to end at the component and pins the probe's absence; `stepJumpButton` and `stickyBarSplit`
  re-anchor the slice end that was the probe onto the session hint.
- **AUD-01.02 (U-16) — RULED, resolved by OD-14(a):** no relocation; W1-I-b not opened (no work).
- **Evidence:** focused suites (`stepPanelCopy`, `phase3W1I*`, `phase3W1IntegrationReconciliation`, `appNaming`, `rulesOverview`, `stickyTrap`,
  `stickyBarSplit`, `stepJumpButton`, `stickyRemeasure`, `stickyCollapse`) pass; frontend typecheck and production build exit 0 (no warning
  in a touched file); meta-tests identical to `d29bb2f` (the pre-existing `sourceGuards` 1, `boardInEffect` 1, `liveHygiene` 2, same
  failure detail). Rules engine 13, live `[13]`, settlement-certified `[10, 11, 12, 13]` unchanged; no server, rules or settlement file touched.

## W3-C slice status (2026-10-04)

**Branch** `phase3/w3-c-refusal-display` @ `6c28662` from `phase3/wave3-i-w2i-w2j-v13cert-integration` @ `18d4762` (the current provisional
baseline at the time). **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending). *(Written as
branch-only; since 2026-10-04 ACCEPTED and INTEGRATED on `phase3/wave3-i-w2i-w2j-w3c-v13cert-integration`, merge `b32ef6e` — see
"W3-C integration status" below.)* Dependencies W2-J and W1-H are integrated in the base. OD-12: two RED commits, each its own and independently reviewed.

- **AUD-14.01 — support `3c75394` (+ `bfec83c`), RED R5 `21d6b15`, `6cb86e4`:** the room strip's one error slot (~28 writers,
  exact-text clears) is two slots (`utils/roomNotices.ts`): the link's notice with its KIND (reconnecting, catching-up, resync,
  room-status, build-skew, incompatible, divergence, transport) and the last refusal of this tab's own action. Every clear names a
  kind or the landed-move event, never a sentence. RED R5: the server-link callbacks name their slot and kind (`onRoomStatus('live')`
  and `onStatus('open')` retire their kind), the drain's end retires `catching-up` by kind and the divergence verdict is a connection
  notice (both in R5, outside the plan's line range, named by this row's own source). `RoomNoticeSlots` draws both slots and defers
  to the standing hold notice; the one-line surfaces read the refusal first.
- **P3-N004 — RED R1 `08d857b`:** a landed move retires the refusal slot whatever it said (it cleared only `TURN_REFUSAL`), and the
  catching-up / resync notices a landed move contradicts; the link's other notices stand.
- **P3-N020 — RED R1 `08d857b` + `6cb86e4`:** the room branch of `runGameplayAction` answers `allocated !== null` -- the per-action
  signal -- and the handlers take back what they set: a refused run marks nothing (no "has run", no step advance); a refused lay
  removes the power key it added to the shell's fallback set and re-arms the JK (`utils/submissionAnswer.ts`: only `false` rolls back).
- **Recorded follow-ups (LOW, not implemented here):** the client's own pre-send gates (turn, catching-up, link-down) answer
  `undefined` and roll nothing back (further R1 lines); a resync can settle a landed move null and roll back its shell state (the
  board stays authoritative); an `error` frame answering a submission shows as a `transport` notice not retired by a landed move
  (as before); the App wiring of the rollbacks is source-pinned. NITs: one connection slot (a later kind replaces an earlier one, as
  before); the one-line reading puts the refusal before a terminal notice.
- **Not taken:** W3-G, W3-J, W3-F; the W2-F / W3-I / W2-I / W2-J follow-ups. Rules version and settlement unchanged. The four
  pre-existing meta-test failures are identical on `18d4762` and on this branch.

## W3-C integration status (2026-10-04)

**Branch** `phase3/wave3-i-w2i-w2j-w3c-v13cert-integration` from `phase3/wave3-i-w2i-w2j-v13cert-integration` @ `18d4762` — *(superseded as baseline at `c0a44d7` by
`phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration`, below)* **the provisional
Phase-3 integration baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W3-C slice
(`phase3/w3-c-refusal-display` @ `3454daa`) merged `--no-ff` (merge `b32ef6e`, parents `18d4762`, `3454daa`), its seven commits carried
unchanged (`3c75394`, `bfec83c` support, `08d857b` RED R1, `21d6b15` RED R5, `6cb86e4` implementation, `6c28662` review fix, `3454daa`
slice tracking), then this tracking commit.

- **No conflict.** W3-C was 7 ahead / 0 behind `18d4762`, so the merged tree equals `3454daa`'s exactly. No `server/`, `gameEngine/`,
  `contracts/`, `rulesVersion.ts`, settlement or fixture file differs from `18d4762`; W2-J's RED R2 edit is untouched.
- **RED audit (OD-12).** R1 `08d857b`: the two accepted lines inside `runGameplayAction`'s room branch -- a landed move dispatches
  `submission-landed`; the branch returns `allocated !== null`. R5 `21d6b15`: confined to the link-drain effect -- the server-link
  callbacks write their slot and kind; the drain's `finally` retires `catching-up` by kind; the divergence verdict is a connection
  notice. **The two R5 edits outside the plan's narrower listed lines are kept:** AUD-14.01's own source cites the `finally`
  exact-text clear; without the divergence edit the verdict would be routed as a refusal and cleared by the next landed move; both
  sit inside R5 and add no unrelated behaviour.
- **Rows:** AUD-14.01, P3-N004, P3-N020 IMPLEMENTED and INTEGRATED. OD-12 remains RULED.
- **Pre-existing meta-test failures, compared on `18d4762` and on the merge:** `sourceGuards` (1), `boardInEffect` (1), `liveHygiene` (2)
  -- identical output. PRE-EXISTING / NON-BLOCKING; not fixed here.
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; keys and fixtures unchanged.
- **Lanes:** W2-B, W2-C, W2-G, the v13 settlement certification, W2-D, W2-F, W3-I, W2-I, W2-J and W3-C **COMPLETE and INTEGRATED**; no
  accepted slice awaits integration. Not deployable until drained v12 rooms and the final integrated owner gate.
- **Follow-ups (not implemented here):** the accepted W3-C LOWs (pre-send gates roll nothing back; a resync can roll back a landed
  move's shell state; an `error` frame answering a submission stays a connection notice; the rollback wiring is source-pinned); the
  integration review's LOWs (the no-server path's subscribe error is routed as a refusal; a refused lay does not reopen the errand
  flow); carried unchanged from earlier integrations.

## W3-G integration status (2026-10-04)

**Branch** `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` from `phase3/wave3-i-w2i-w2j-w3c-v13cert-integration` @ `c0a44d7` — *(superseded as baseline at `d29bb2f` by
`phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration`, below)* **the provisional
Phase-3 integration baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W3-G audit
(`phase3/w3-g-ui-parity-audit` @ `967e4e7`: audit `e86a933` + owner review `967e4e7`) merged `--no-ff` (merge `72ccd00`, parents `c0a44d7`,
`967e4e7`), both commits carried unchanged, then this tracking commit.

- **No conflict; docs/tracking only.** W3-G was 2 ahead / 0 behind `c0a44d7`. The merge touches only `PROJECT_CANONICAL_CONTEXT.md`,
  `RULES_HARDENING_BACKLOG.md` and `docs/phase3/`; no product-code, `server/`, `gameEngine/`, `contracts/`, `rulesVersion.ts`, settlement
  or fixture file differs from `c0a44d7`. No product test suite was run (docs-only; accounting PASS, `git diff --check` clean).
- **W3-G: COMPLETE — OWNER REVIEW ACCEPTED** (an accepted audit gate, not a product slice). All fifteen findings stand. AUD-25.11 CLOSED —
  OBSOLETE / UNREACHABLE ARCHITECTURE; AUD-25.13 ruled item by item (above); AUD-25.15 resolved (OD-3, OD-13, OD-14(d), OD-14(i)); AUD-12.07 RULED.
- **Owner-observed follow-up (2026-10-04, after the review): AUD-25.16 (HIGH)** -- Watch opens a seated principal's own seat, on a board resting one turn behind with live controls; a tip-stamped click reaches the server and can land. W3-J. **OD-19 RULED (2026-10-04):** (A) Watch identity RESOLVED -- Watch is a read-only spectator view, always, even for a seated principal; re-entering a seat is "Your tables" / Open / Rejoin. (B) stale board silently behind -- OPEN / W3-J. (C) stale board presents and submits live actions -- OPEN / W3-J, HIGH safety defect; W3-J fixes both layers (non-actionable controls while unresolved; a submission bound to the APPLIED log position, rejected by the server on mismatch).
- *(Superseded 2026-10-05: all fixed and integrated on `phase3/consolidated-pre-playtest-integration`; only AUD-25.14 -> W3-F remains.)* **Still OPEN:** AUD-25.16 (HIGH) -> W3-J; AUD-25.01 (MEDIUM) -> W3-B; AUD-25.02 (MEDIUM) -> W3-J; AUD-25.03 … 25.10, 25.12 and AUD-25.13's FIX items -> W3-J;
  AUD-25.14 -> W3-F. No slice changed implementation state. **W3-J is unblocked from this baseline.**
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; keys and fixtures unchanged.
- **Pre-existing meta-test failures** (`sourceGuards` 1, `boardInEffect` 1, `liveHygiene` 2) unchanged.

## W3-B slice status (2026-10-04) — AUD-25.01 only

*(Since 2026-10-04 INTEGRATED on `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration`, merge `00b2b3c`; see "W3-B AUD-25.01 integration status" below.)*

**Branch** `phase3/w3-b-action-latch-linkqueue` @ `5fd3a7b` from `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f` (the current provisional baseline, unchanged). **AUD-25.01 IMPLEMENTED on the slice branch; NOT
integrated** (integration and owner broad gate pending). W3-B is PARTIAL: AUD-14.06 and P3-N021 are NOT STARTED. No RED region edited
(OD-12 not used); W3-G stays COMPLETE — OWNER REVIEW ACCEPTED.

- **AUD-25.01 (U-46) — `26f5982` + review fix `5fd3a7b`:** `utils/actionLatch.ts` `useActionLatch` bounds the shell's #1173 latch by the room link.
  `actionInFlight` is busy while a press is latched OR the active link still holds a submission of this tab's (W3-I's one view,
  `linkQueueView(...).blocked`; no new queue model); the 6 s backstop does not run while the link holds, so the drain (landed), the
  submit half's `null` (refused / dropped) and only then the clock release the latch. App.tsx: the latch declaration block only (at
  `8e897f9` 4218–4233, no owned or RED region) plus W3-I's 6-line hook block moved above it; the `useState`, every setter call, RED R1 and
  RED R5 byte-identical. Every control the row names already read `actionInFlight` (OR / SR bar and Pass, the Stocks tab's Buy / Sell, the
  five consent prompts, the W2-G emergency modal, whose own 4 s press latch now cannot re-arm it while the link holds), so no mount changed.
  The Firestore / hotseat path is unchanged (idle queue). Only this tab's game-log submissions count: watchers, other seats' moves and an
  ended link leave the controls live; browsing (card openers) is never gated.
- **Tests:** `components/phase3W3BActionLatchLinkQueue.test.tsx` (23) over the real link, hooks and controls -- normal submission; the 6 s
  expiry while queued; the second click; accepted / refused / dropped / abandoned resolution; W3-G's second Stock Round sale; OR Skip;
  consent Accept / Reject; the emergency portfolio sale; an `automatic` press; another seat's entry mid-hold; unrelated traffic; the no-link
  path; the Private Companies form keeps W3-I's "Queued" note; source pins. `doubleActionWindow`'s backstop pin follows the backstop into the
  hook. Mutations: removing either guard, or both, fails the suite (4 / 3 / 13 tests).
- **Validation:** typecheck clean; production build green with the ESLint warning set identical to `d29bb2f` (line numbers aside); 37
  adjacent suites green but the pre-existing `sourceGuards` sweep, whose 7 violations are identical on `d29bb2f`; the four pre-existing
  meta-test failures (sourceGuards 1, boardInEffect 1, liveHygiene 2) identical. Pins 13 / [13] / [10, 11, 12, 13].
- **Recorded residual (LOW, review):** the drain releases by index, so another seat's entry passing the press's index mid-hold leaves only the
  link holding; after the press's own `applied` answer the controls re-arm for the drain's few milliseconds before it applies that entry
  (narrowing it needs RED R5; the baseline re-armed for the whole hold). Also noted, not W3-B's: a resync settles held submissions `null`
  before the fresh catch-up (RED R1 / the link).
- **Handed to W3-J (AUD-25.10, unchanged copy):** the Stocks tab, the consent prompts and the emergency modal now say "Sending your last action —
  one moment." for a whole outage while the offer forms say "Queued — will send on reconnect."
- **Not taken:** AUD-14.06, P3-N021 (an `automatic` press now greys the controls while the link holds it on the server path, which narrows
  but does not implement P3-N021), W3-J, W3-F. Rules version, settlement, server, protocol and RoomEngine unchanged.

## W3-B AUD-25.01 integration status (2026-10-04)

**Branch** `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration` from `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f` — *(SUPERSEDED AS BASELINE 2026-10-05 by `phase3/consolidated-pre-playtest-integration`)* **then the current provisional
Phase-3 integration baseline. PROVISIONAL: no broad Phase-3 owner gate has been run; not merged to main.** The accepted W3-B slice
(`phase3/w3-b-action-latch-linkqueue` @ `7efda710552ebffa6efa5abd220d140144c23407`) merged `--no-ff` (merge `00b2b3c37e0c1a38ef55c72c47102d5432b81e60`, parents `d29bb2f`,
`7efda71`), its three commits carried unchanged (`26f5982` implementation, `5fd3a7b` review fix, `7efda71` slice tracking), then this tracking commit.
`main` did not move.

- **No conflict; merge tree = slice tree.** W3-B was 3 ahead / 0 behind `d29bb2f`. Product change: `App.tsx` (the latch declaration block,
  above `runGameplayAction`) and `utils/actionLatch.ts`; no `server/`, `gameEngine/`, `contracts/`, `serverLink.ts`, `useLinkQueue.ts`,
  `rulesVersion.ts`, settlement or fixture file differs. RED untouched: `App.tsx` from `runGameplayAction` to EOF is byte-identical to `d29bb2f`.
- **Behaviour audit:** the local latch covers the immediate press window; W3-I's `LinkQueueState` is authoritative while this tab's submission
  is held (busy = latched press OR the link holds one; the 6 s backstop does not run while it holds). The OR bar, the Stock Round Buy / Sell /
  Pass, the consent prompts and the W2-G emergency modal stay unavailable through a held submission and re-arm after the link's resolution
  plus ordinary authority; the par prompt and offer forms keep W3-I's behaviour; the duplicate Stock Round sale cannot return (the test
  fails without the link guard). No new queue model; no legality mirror; no copy change; no W3-H or W3-J work.
- **AUD-25.01 IMPLEMENTED — INTEGRATED; U-46 RESOLVED. W3-B stays PARTIAL** (integrated through AUD-25.01): AUD-14.06 (waits on W3-H) and P3-N021
  (OD-12 RED R1 `press:true` latch) remain open.
- **Accepted LOW — future owned residue (RED R5), not fixed, not PASS:** if another seat's move lands while this tab's press remains held, the
  controls may briefly re-arm once this tab's own move lands; closing it requires RED R5 work.
- **Handed to W3-J (AUD-25.10, unchanged copy):** some surfaces say "Sending your last action — one moment." during an outage while the offer
  forms say "Queued — will send on reconnect."
- **Validation:** 36 focused suites, 1153 passed / 1 skipped; typecheck and production build green (ESLint warnings identical to `d29bb2f`);
  accounting PASS; `git diff --check` clean. Independent integration review: APPROVE (no integration-introduced finding; no review-fix commit).
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; keys and fixtures unchanged.
- **Pre-existing meta-test failures** (`sourceGuards` 1, `boardInEffect` 1, `liveHygiene` 2) identical on `d29bb2f` and the merge — PRE-EXISTING / NON-BLOCKING.
## W3-A slice status (2026-10-05)

**Branch** `phase3/w3-a` from `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f` (the provisional baseline named by the
owner's W3-A brief). **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending). OD-5 RULED 2026-10-04
(plan §7.3). Dependencies W2-G and W2-H are integrated in the base. OD-12: one RED commit, its own and independently audited.

- **OD-5 transcription — `9962745`** (tracking only).
- **AUD-11.02, P3-N019 — `b70f087` (+ review fixes `ac78dc9`, `ce705b2`, `ce6afe8`):** `NoticeLedger` (`utils/noticeAcknowledgements.ts`)
  replaces #1107's per-room `sessionStorage` set. It holds this player's acknowledgements and their own witnessed-but-unanswered notices
  for Fleet Loss, Private Revenue, Phase Three and Herald, per game and per seat, in `localStorage` (`1830juno.notice_ack.v1.<game>.<seatN|watcher>`;
  the seat's public table position, never its player id -- LIVE-2D; a stored payout's id-shaped labels are replaced by the nickname or
  "Seat N"). An answer holds across reload, reconnect, new tab and remount, and another tab's answer closes the notice here; an unanswered
  notice comes back. NO BACKLOG: during the mount's first history load every event counts as already shown except the player's own pending
  ones, and stays so through a later Undo replay; the Phase 3 edge is armed only after that load. The fleet-loss raiser (RED R2) is
  unchanged: `dismissedFleetNoticesRef.has` now asks the ledger. Bounded to 40 games; storage failure degrades to memory.
- **AUD-13.07 — `b70f087`, RED R4 `e8b9504`, `ac78dc9`:** *(Superseded 2026-10-05 (OD-5, `15fd1d0`): Tutorial is not in the chain -- five entries; and no once-per-profile policy was ruled.)* the forced notices present one at a time in the ruled order (`utils/noticeChain.ts`:
  Emergency, Fleet Loss, Private Revenue, Phase Three, Herald, Tutorial); each waits while a non-notice native dialog is open
  (`utils/nativeModalRegistry.ts`, registered by `NativeModal`); an armed tutorial is held, not consumed. Game Over, the B&O par prompt and
  a private power's flow open themselves and wait for the screen (`components/NativeModalTurn.tsx`). RED R4: #1049a's payout-first hold in
  `dueFleetNotice` removed (the ruled order reverses it; the chain now sequences the two).
- **AUD-01.03, AUD-13.02 — `b70f087`:** a stable, visually hidden game-screen `<h1>` (`components/GameScreenHeading.tsx`); when the chain is
  exhausted focus moves there once (`utils/useNoticeChain.ts`), never during ordinary play, never into another open dialog.
- **AUD-01.06 — `b70f087`:** the zero-state effect that cleared every tutorial's seen flag on each shell mount is removed; tutorials arm
  once per profile.
- **Tests:** `utils/noticeAcknowledgements.test.ts` and `components/noticeChain.test.tsx` (the real notice components and `GameOverModal`
  driven by the real chain; shell wiring source-pinned), mutation-checked. Superseded pins rewritten with the supersession noted at the
  site: `batch49` (#1049a), `batch64` (#1107), `phaseThreeNotice`, `activeGame` (storage-write allowlist), `trainRustFlourish`.
- **Review:** RED R4 audit APPROVE WITH NITS (nit folded into `e8b9504`); slice review REQUEST CHANGES (2 MEDIUM, 4 LOW, 1 NIT) -> fixed
  in `ac78dc9`; re-review one new MEDIUM -> fixed in `ce705b2`; final APPROVE WITH NITS -> both nits fixed in `ce6afe8`.
- **Not taken:** W3-B, W3-J, W2-M, W3-F, W3-D (HomeStationPrompt's `aria-modal` div and tutorials as native dialogs stay W3-D's). The
  README's stale "Still open" prose stays AUD-25.14 / W3-F. Rules version and settlement unchanged. The four pre-existing meta-test
  failures are identical on `d29bb2f` and on this branch.
## W3-J slice status (2026-10-05) — U-28 findings remediation

**Branch** `phase3/w3-j-u28-remediation` from `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f` (the provisional baseline,
unchanged). **W3-J COMPLETE on the slice branch; NOT integrated** (integration and the owner broad gate pending). Every W3-J row is
IMPLEMENTED: AUD-25.02 … AUD-25.10, AUD-25.12, AUD-25.16, and every AUD-25.13 FIX IN W3-J item. AUD-25.01 is W3-B's and is not on this
branch. No engine, server, contract, rules-version or settlement change; pins 13 / [13] / [10, 11, 12, 13]. Full record:
`w3j_u28_remediation` and the row statuses in `phase3_accounting.json`.

- **OD-12 RED commits** (each one minimal logical edit, its own commit, exact diff audited against its parent, independently reviewed):
  R1 `6378dea` (AUD-25.03: `submission-landed` on `derived !== true`), `77b0b38` (AUD-25.13 #9: the catching-up guard on the same rule),
  `b9afbdf` (AUD-25.05: the client's own gates answer `false`), `b4c1714` (AUD-25.16: the send gate refuses a board that is not current);
  R5 `e769e51` (AUD-25.06: the drain retires the resync notice), `7c4624f` (AUD-25.16: a throwing drain pass latches not current), `8c5ff63`
  (AUD-25.16: submissions bound to the applied position). No R2 / R3 / R4 edit: AUD-25.13 #5 needed none (the statistics derive from the
  authoritative replay), so OD-12's R2 grant went unused. The three AUD-25.16 lines carry OD-19's stale-board requirement through OD-12's
  procedure -- recorded for the owner / integrator to confirm (they are not yet in the plan's RED table). *Resolved 2026-10-05: OD-19 covers them; the owner does not re-ask confirmation; the RED table records them (R1 / R5).*
- **AUD-25.16 / U-56 (HIGH, OD-19):** (A) Watch is a read-only spectator view for everyone, a seated principal included -- its own door,
  persisted; no seat acted for, no Take a seat, no room op; a Watch tab's Leave returns to the Lobby. (B) A board that is not the room's
  (a drain pass threw, or the settle point's digest stands disagreeing) is not current: isMyTurn false and a forced notice (Reload / Back to
  the lobby). (C) It sends nothing (the send gate), and every submission is stamped with the position the board APPLIED, so the server's
  existing anchored staleness guard answers a behind board with a catch-up -- proven end to end in memory (the real link and RoomSession);
  no live game touched. Severity HIGH confirmed: before the fix a stale view could submit, and a legal click landed on a board the player
  never saw.
- **Tests:** new `utils/phase3W3JRed`, `utils/phase3W3JLink`, `utils/phase3W3JRollbacks`, `utils/phase3W3JStatistics`,
  `utils/phase3W3JFloatTreasuryLine`, `routeOracle/phase3W3JRouteDraftParity`, `components/phase3W3JWatchStaleBoard`,
  `components/phase3W3JNotices`, `components/phase3W3JComponents`, `components/phase3W3JCopy`,
  `components/phase3W3JRulesReferenceReservation`, `panels/phase3W3JPaidStation`, plus cases in `phase65bPrivateCompaniesSection` and
  `emergencyPurchaseW2G`; the triage's `phase3W3GWatchDefect` DEFECT cases flipped. Each fix mutation-checked.
- **Independent reviews:** two reviewers over every commit, then a third over the fixes. No HIGH. MEDIUM (fixed, `a03034f`): the corporate
  train offer form still closed on Send in the real shell. LOWs fixed: a hello answered without a catch-up left the link resyncing
  (`d312706`); a Watch tab's Leave could seat the user inside a Watch tab (`45272e6`); the end-to-end test now closes the loop (`45272e6`);
  stale comments (`45272e6`, `130363c`). NITs fixed (`f583c95`, `1495c42`, `130363c`); pins that had not followed AUD-25.08 / 25.04 moved (`6f26a79`).
- **Validation (code at `400bbc7`):** 121 suites -- the 118 adjacent (W2-B, W2-D, W2-F, W2-G, W2-H, W2-I, W2-J, W3-C, W3-I, W3-J, the
  Rules Reference, server link / room, station placement, routes, statistics, tutorial / copy, shell wiring, v13 pins / settlement
  certification, and every suite pinning a touched site) all green, plus the three meta-tests: 2,623 passed, 3 skipped, 4 failed -- the 4
  pre-existing meta failures (sourceGuards 1, boardInEffect 1, liveHygiene 2), identical to `d29bb2f` violation for violation. The
  comparison first found W3-J's own source pins adding sourceGuards (G2) violations and one new ESLint warning; both fixed (`a4e1c02`,
  `400bbc7`). Typecheck clean; production build green (`scanDevIdentity` clean), ESLint warnings identical to `d29bb2f` (line numbers
  aside); accounting PASS; `git diff --check` clean; pins 13 / [13] / [10, 11, 12, 13].
- **Recorded residuals:** AUD-25.02's quoted sentence, read literally, also covers F16 under a player-owned D&H (owner wording decision);
  a not-current latch whose cause recurs on every load keeps that table blocked (OD-19 fail-safe); the shell's appliedPosition wiring is
  source-pinned; the remaining NITs in `w3j_u28_remediation.residuals`.
- **For an owner ruling (observed, not ruled) -- owner-ruled 2026-10-05: a REQUIRED Phase-3 bugfix, P3-N027 (lane C):** the emergency `train-offer` stage has AUD-25.13 #2's shape for a third seat
  (TrainTradePrompt with dead buttons beside the waiting card).
- **Untouched:** AUD-25.01 / W3-B, W2-M, AUD-25.14, AUD-25.13's RECORDED RESIDUAL and OBSOLETE items, every other open OD and slice.

## Scope and closing remark

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-00.01** · — · Scope<br>The audit did not read GitHub issues (the session could not reach the API). | scope gap | NOT CODE — process gap. | W3-G | **B** | — | — | W3-G (U-28 closure) triages open GitHub issues for player-facing defects not in this matrix; each finding is added here as a new row before closure. |
| **AUD-00.02** · — · Closing remark<br>ROADMAP_3_2_REMAINING_WORK.md, PROJECT_CANONICAL_CONTEXT.md §B and backlog Part F still place UI/UX after the frontend refactor. | doc order | CONFIRMED — `PROJECT_CANONICAL_CONTEXT.md` §B lists 7: frontend cleanup before 9/10 UI/UX. | P0 | **B** | — | — | This pass adds only a pointer to PROJECT_CANONICAL_CONTEXT.md. P0 updates the roadmap file and Part F to the fixed Phase 1–7 order. |

## §1 Game shell / overall layout

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-01.01** · U-16 · §1<br>Temporary fit probe `useStickyFitProbe` in the action bar must be removed. | [UX] | CONFIRMED — `panels/ContextualActionBar.tsx`:713, 715-806, 1465, 4566-4570 ("TEMPORARY … this comes out"); renders with no dev gate. | W1-I | **A** | OD-14(a) (probe readout may inform it first) | — | Part C U-16: "Decide, then remove it either way." The removal happens whatever OD-14(a) decides, but only after it is recorded, because the probe is the instrument for that decision (AUD-01.02). **OD-14(a) RULED 2026-10-04 (owner): the probe is removed without moving the panels. Implemented on the unintegrated W1-I branch (`1b76512`); OPEN on this line until W1-I is integrated.** |
| **AUD-01.02** · U-16 · §1<br>Decide whether the step panels move back into the action bar. | [UX] decision | NOT CODE — layout decision; the probe is its instrument. | W1-I (conditional sub-scope W1-I-b) | **C** | OD-14(a) | — | If OD-14(a) = move into the bar, lane 5 adds W1-I-b in wave 2 (3–5 h). If it = keep, no work. **Consolidated integration (owner, 2026-10-05):** RULED -- preserve the CURRENT placement: the step panels sit INSIDE the sticky action bar; do not move them; probe removed; no W1-I-b move. The earlier note "keep the step panels outside the bar" was WRONG and is corrected. W1-I integrated on `phase3/consolidated-pre-playtest-integration`. |
| **AUD-01.03** · Batch 4B · §1, §13<br>The game screen has no heading (focus target) or game-status region. | [UX] ★ | PARTIAL — tab-level `<h2>`s and `role="status"`/`aria-live` regions exist (e.g. `components/ActionToast.tsx`:368); no game-screen heading/`<h1>` focus target in the shell. | W3-A | **A** | OD-5 | — | The heading is the forced-notice focus target that AUD-13.02 needs. |
| **AUD-01.04** · A-14 · §1<br>Status-dock height fixed at 96 px because the dock's ResizeObserver never attaches. | [D] | CONFIRMED — `frontend/src/App.tsx`:3104-3123 (`useState(96)`, `useEffect(…, [])` returns while the ref is null; rooms render a gate first). | W1-I | **B** | — | — | Not in the draft map. Fix in the effect only (attach when the ref appears); no layout change. |
| **AUD-01.05** · A-21 · §1<br>Hex click indicators are misplaced at any uiScale other than 1. | [D] | CONFIRMED — `frontend/src/App.tsx`:14949-14989; `styles/appStyles.ts`:2432-2443 (`position: fixed`, `left: clientX + 16` inside the zoomed root; no uiScale correction). | W1-F | **B** | — | — | — |
| **AUD-01.06** · A-13 · §1<br>Tutorials reset on every AppShell mount. | [D] | CONFIRMED — `frontend/src/App.tsx`:1080-1083 (`replayTutorials` whenever the sandbox is in zero state; the default scenario is zero state). | W3-A | **A** | OD-5 (re-arm policy) | — | **Consolidated integration (owner, 2026-10-05):** IMPLEMENTED -- DEFECT ONLY (INTERIM): W3-A `b70f087` removed the zero-state effect that reset every tutorial's seen flag; kept as a known bad auto-reset removed. NOT the tutorial redesign: the contextual whitebox / spotlight tutorial system and its re-arm policy are the FINAL tutorial pass's (OD-5(A)). W3-A's "once per profile" ruling wording is withdrawn. |
| **AUD-01.07** · — · §1<br>The game id is not shown anywhere. | [UX] | PARTIAL — hosted tables show the room code only (`frontend/src/App.tsx`:13748, 13776); `StockMarketRenderer.tsx`:844 shows "Game #…" on the legacy path. | W2-I | **B** | OD-6 (RULED 2026-10-04, Option A) | — | LIVE-2 §7.2 says the game id is never displayed, so showing it was a product decision. OD-6 RULED (Option A): DECIDED — the opaque game_id is intentionally not displayed; the Rules Reference build line shows the build id + the board's rules version. C → B. |
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
| **AUD-03.09** · K-22 / U-37 · §3<br>A float is not logged until the corporation's first OR turn. | [D] | CONFIRMED — `utils/actionLog.ts`:470-486; `gameEngine/sandboxSession.ts`:7522. | W2-J | **A** | OD-8 (RULED 2026-10-04, Option A) | — | — |
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
| **AUD-11.04** · U-10 · §11<br>Clock / live-vs-async UX. | [UX] (deferred) | NOT CODE — Part C U-10 `DEFERRED` (the UI half of S10-10's 2.5g). | — (pre-Phase-4 lane A) | **B** | OD-18 (superseded in part 2026-10-05) | — | The audit says U-10 "stays deferred", but no owner ruling placing it later is on record, and Part F says deferral alone does not count. OD-18 asks the owner to confirm a later placement (then E) or scope it into Phase 3. **RULED (transcribed 2026-10-04; OD-18 transcribed): no move clock, automatic forfeit or automatic trade decline at this stage; reconsider after Phase-4 human playtesting. "Pause cap" not named by the ruling (owner may confirm); C → E left to W3-F.** **Consolidated integration (owner, 2026-10-05):** SUPERSEDED IN PART -- the Live / Async clock is BUILT IN PHASE 3 (lane A: infrastructure, visible state, pause / resume, persistence, reconnect, server-authoritative timing, Phase-4 instrumentation); NO automatic forfeiture, automatic trade decline or host succession; no Forfeit / Clemency settlement payload until validated and authorised. C → B. OPEN. |
| **AUD-11.05** · H-05 · §11, Phase-4 list<br>The Delayed Auction arming line on every seat. | [PT] | NOT CODE. | — | **D** | — | In a Delayed Auction game, screenshot every seat at the arming moment. | — |
| **AUD-11.06** · U-34 · §11, Phase-4 list<br>Dynamic operating order. | [PT] | NOT CODE (note wording is P3-N016). | W1-I (pre-work) | **D** | — | Across two ORs with price changes, record the displayed order vs the order played. | — |

## §12 Player / company information / ledger

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-12.01** · K-23 / U-27 · §12<br>After a bank break the ledger shows "$0 remaining", "$-20" and >100% paid out. | [D] | CONFIRMED — `components/FinancialLedger.tsx`:161-189 (no clamp); `gameEngine/cashLedger.ts`:249. | W1-I | **A** | — | — | — |
| **AUD-12.02** · U-41 · §12<br>Post-game statistics do not record a train-limit discard. | [D] | CONFIRMED (Part C) — `utils/gameHistory.ts` `describeFleetLosses` splices the discard out. | W2-L | **B** | OD-13 | — | The draft map sent this to "its own pass" without an owner placement; the audit budgets it in Phase 3. |
| **AUD-12.03** · U-43 · §12<br>Four post-game statistics residuals (Salvager pool purchase; refused RunMultipleRoutes booked; RunManualRoute not booked; Cowboy legacy seed). | [D] | CONFIRMED (Part C) — `utils/gameHistory.ts`. | W2-L | **B** | OD-13 | — | — |
| **AUD-12.04** · H-06 · §12<br>On a tie, only the first player gets the WINNER badge. | [D] | CONFIRMED — `gameEngine/endgame.ts`:401-416 (`champion = sorted[0]`); `components/GameOverModal.tsx`:316. | W1-N | **B** | — | — | Not in the draft map. Fix in the display (badge every rank-1 row); do not change ranking. |
| **AUD-12.05** · U-7 · §12<br>Palette / player-card wash not reaching the cash slide-out and payout modal. | [UX] owner call | NOT CODE — Part C U-7 `DEFERRED`, "owner to say". | W3-H (if ruled in) | **C** | OD-14(b) | — | **RULED (transcribed 2026-10-04; OD-14(b) transcribed): use the cash/payout player-color wash — ruled in, W3-H.** |
| **AUD-12.06** · U-8 · §12<br>Seven-seat LPF wraps the six-colour palette. | [UX] owner call | NOT CODE — Part C U-8 `DEFERRED`. | W3-H (if ruled in) | **C** | OD-14(c) | — | The draft map assumed "U-8 closed"; that is an owner call and is not defaulted. **RULED (transcribed 2026-10-04; OD-14(c) transcribed): give the seventh LPF player a distinct color — ruled in, W3-H.** |
| **AUD-12.07** · GR-3 label · §12<br>"traded" vs "rusted" label for a first-Diesel trade-in in the fleet ledger. | [UX] owner call | CONFIRMED — `utils/gameHistory.ts`:152, 661-667 implements "traded" (#1702); the GR-3 report asked the owner to flag if the old label should stay. | W2-L (only if OD-14(d) restores "rusted") | **C** | OD-14(d) | — | **RULED 2026-10-04 (OD-14(d) transcribed): keep "traded"; earlier 4-trains rusted by the phase event remain rusted. No change.** |

## §13 Modals / dialogs

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-13.01** · — · §13<br>Native dialog surfaces with focus traps and Escape policies. | [R] | RESOLVED — 14 `<NativeModal` call sites at 8e897f9 (the audit said 15). | — | **F** | — | — | — |
| **AUD-13.02** · Batch 4B · §13<br>After acknowledging Private Revenue or Fleet Loss, focus lands on the page body; needs a notice-chaining policy and a heading. | [UX] ★ | CONFIRMED — `PrivateRevenueModal.tsx`:214, `FleetLossModal.tsx`:81 `restoreOpener={false}`. | W3-A | **A** | OD-5 | — | — |
| **AUD-13.03** · — · §13<br>The seat PIN dialog is not a native dialog. | [UX] | RESOLVED (audit text stale) — seat PINs removed in LIVE-2D (`SandboxWaitingRoom.tsx`:497, `SandboxRoomBar.tsx`:205, `App.tsx`:13721). | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-13.04** · — · §13<br>Tutorials are not native dialogs. | [UX] | CONFIRMED — `components/TutorialModal.tsx`:593-597 `<div role="dialog">`. | W3-D | **A** | — | — | **Consolidated integration (owner, 2026-10-05):** NOT STARTED -- DEFERRED TO THE FINAL TUTORIAL PASS (OD-5(A): built last, after the gameplay shell/UI is stable); not forced complete; by the closure contract the LAST Phase-3 lane (F) before the Phase-4 baseline unless the owner places it after Phase 4 (an owner decision open). W3-D stays PARTIAL on this row alone. |
| **AUD-13.05** · — · §13<br>The intro overlay's scale contract is unsettled. | [UX] | CONFIRMED — `components/GameIntroOverlay.tsx`:346 `zoom: 1 / uiScale` on an `aria-modal` div. | W3-D (OD-15(a) ruled: viewport takeovers -- the intro and the end-game film; implemented on `phase3/w3-d`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)) | **B** | OD-15(a) (RULED 2026-10-04) | — | IMPLEMENTED on `phase3/w3-d` — both cinematics render outside every scaled root (`CinematicTakeover`), no `zoom: 1 / uiScale`, no dialog role / `aria-modal` / NativeModal; the shell root is `inert` while one covers the game. |
| **AUD-13.06** · — · §13<br>Whether the portal / inert layer is still needed is undecided. | [UX] | CONFIRMED — `components/ModalPortal.tsx`:6-11, 43-45 disowns inert and any open-modal registry. | W3-D (OD-15(b) ruled: native dialogs, `ModalPortal` retired with its last consumer; implemented on `phase3/w3-d`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)) | **B** | OD-15(b) (RULED 2026-10-04) | — | IMPLEMENTED on `phase3/w3-d` — no manual inert; the Lobby's standalone `ModalPortal` removed, so `NativeModal` is its only consumer (as its scaled destination; the deletion path is recorded in `ModalPortal.tsx`); `PrivateTradePanel`'s unreachable `role="dialog"` / `aria-modal` shape deleted (a panel, not a modal). |
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
| **AUD-14.06** · — · §14<br>The in-flight latch covers only the action bar and the SR panel; dashboard, token and tile confirms, private-power modal, route edits and consent answers can double-send. | [UX] ★ | CONFIRMED — `actionInFlight` reaches the bar, `StockRoundPanel` and `PlayerPrivateTradePrompt` only (`frontend/src/App.tsx`:4219, 13960, 14555, 15241). | W3-B | **A** | — | — | Latching is distributed: W1-B (dashboard), W1-D (consent prompts), W1-E (ring confirm), W2-C (embedded proposal), W2-G (emergency); W3-B closes the residue and owns the coverage test. **Consolidated integration (owner, 2026-10-05):** NOT STARTED -- re-evaluated on the combined tree: BuyLicenseModal and PrivatePowerFlowModal read no latch; token confirm and route edits uncovered. W3-B residue, pre-Phase-4 lane E. **W3-B latch residue (2026-10-05): IMPLEMENTED** on `phase3/preplaytest-w3b-latch-residue` (`2cea8c4` + review fixes `f855b8b`; no RED region; NOT integrated): BuyLicenseModal, PrivatePowerFlowModal, the auction prompt (par + Proceed), the token confirm, Undo and the map's route edits read the one integrated flag; coverage registry `phase3W3BLatchResidue.test.tsx` -- all 53 `runGameplayAction` call sites LATCHED (with evidence for every door) or EXEMPT (with a reason). |

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
| **AUD-16.09** · — · §16, Phase-4 list<br>The in-game SR and OR screens at phone width are untested. | [PT] | NOT CODE. | — | **D** | OD-10(b) (RULED 2026-10-05: Phase 5) | At 360/390/430 px, play one SR turn and one OR turn; record every unreachable control. | **Consolidated integration (owner, 2026-10-05):** OD-10(b) RULED -- phone-width gameplay layout and keyboard map access are Phase 5; Phase 4 may observe and report. |

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
| **AUD-18.05** · U-15 · §18<br>The Keplr logo. | [UX] | CONFIRMED — no Keplr logo asset in `public/` or `src/`. | W2-K | **C** | OD-9(b) | — | **OD-9(b) policy RULED (official Keplr asset only; never fabricated; transcribed 2026-10-04): ASSET PENDING, not an owner decision awaiting the owner.** |
| **AUD-18.06** · DA6-n · §18<br>Name-case drift. | [UX] | NOT RE-VERIFIED — per audit. | W1-L | **B** | — | — | — |
| **AUD-18.07** · — · §18<br>The waiting room's extra description line awaits an owner decision. | [UX] owner call | CONFIRMED — `components/SandboxWaitingRoom.tsx`:590. | W1-L (if changed) | **C** | OD-14(e) | — | **RULED (transcribed 2026-10-04; OD-14(e) transcribed): keep/tighten the established waiting-room persistence presentation (the cited line is the seat-persistence sentence); no replacement model.** |
| **AUD-18.08** · — · §18<br>Public rooms with Join and Watch, waiting-room layout, Host Game Escape and focus. | [R] | RESOLVED per audit. | — | **F** | — | — | — |

## §19 Spectating / reconnect / recovery

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-19.01** · I-1 / R4 · §19<br>Forms don't show that a submission is still queued on the link. | [UX] ★ | CONFIRMED by reading — no form reads the link's queue state. | W3-I | **B** | OD-12 (only if the submit half or link drain must change) | — | The draft map deferred this to Phase 4; it stays in Phase 3. |
| **AUD-19.02** · U-45 · §19<br>Two tabs can both reach Keplr, creating a duplicate escrow. | [D] | CONFIRMED — `money/pendingTx.ts`:7-22, 157 (record written only after signing); no `navigator.locks` / lease. | W1-K | **A** | — | — | — |
| **AUD-19.03** · R1–R12 · §19, Phase-4 list<br>Recovery scenarios: refresh, network loss, two tabs, second device, stale modal, divergence banner. | [PT] | NOT CODE. | — | **D** | — | Run each R-scenario from the 6.5 preflight on the Phase-4 baseline; record banner text, recovery path and log export. | — |
| **AUD-19.04** · — · §19<br>No host succession and no clock for an absent seat. | recorded limit | NOT CODE — the audit records these as limits (also the 6.5 preflight's "Known limits"). | — | **E** | OD-18 (consequences deferred pending Phase-4 validation) | — | Recorded product limits. OD-18 asks the owner to confirm their later placement (then E). **RULED (transcribed 2026-10-04; OD-18 transcribed): no host succession and no clock / automatic forfeit for an absent seat at this stage; reconsider after Phase-4 human playtesting. C → E left to W3-F.** **Consolidated integration (owner, 2026-10-05):** host succession and an absent seat's automatic consequences (forfeit, trade decline) stay DEFERRED pending Phase-4 validation of the clock (which AUD-11.04 builds). C → E. |

## §20 Money / escrow UI

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-20.01** · U-44 · §20<br>The server writes "HH:MM UTC" while the client shows unlabelled local times. | [UX] | CONFIRMED — three `hhmm` copies (`money/moneyFlow.ts`:106-109, `components/money/MoneyPanel.tsx`:41-44, `SettlementBand.tsx`:42-45); `server/src/escrow/moneyTables.ts`:1027, 1150. | W2-K (OD-9(a) ruled; landed at the safe Wave-2 integration) | **B** | OD-9(a) (RULED 2026-10-03: persistent player UI — local absolute time + explicit time zone; server refusal copy — relative duration; machine evidence stays UTC) | — | One formatter `money/moneyTime.ts` (`formatMoneyTime`) replaces the three `hhmm` copies; the two server refusal sentences in `server/src/escrow/moneyTables.ts` give the time remaining; instants, codes, wire and logs unchanged. |
| **AUD-20.02** · JX-3A E-1 · §20<br>A stale wallet proof still shows "Wallet linked". | [UX] | CONFIRMED — `money/moneyFlow.ts`:121-122 reads server `funding === "linked"` without freshness. | W2-M | **B** | — | — | Roster wording (owner, 2026-10-04): the waiting-room roster's "Wallet linked" (`fundingTag`, the audit's cited `money/moneyFlow.ts`:121-122 at `8e897f9`, rendered by `components/SandboxWaitingRoom.tsx`:491) is ACCEPTED TEMPORARILY as a description of linkage rather than proof freshness -- no separate remediation; the roster tag is not to become a wallet/proof authority. The panel is the row's fix; AUD-20.13 makes its freshness exact after a reload. OWNER DESIGN DIRECTION (2026-10-04): the Profile + Keplr flow is PROVISIONAL and slated for a later redesign/rebuild; this row is a minimal, removable compatibility change, not an endorsement of the current flow (no new UI surface, no new authority). |
| **AUD-20.03** · JX-3A E-2 · §20<br>Replacing a wallet takes two Keplr prompts. | [UX] | CONFIRMED — `money/moneyActions.ts`:167-197 (`replace-required` then `linkWallet({replace:true})`). | W2-M | **B** | — | — | The remaining stale-view case (a second signature after the server's own `replace-required`) is a server residue: AUD-20.14. |
| **AUD-20.04** · JX-3A E-3 · §20<br>Expiry messages are generic. | [UX] | CONFIRMED by reading — `money/useMoneyTable.ts`:240-241, 294. | W2-M | **B** | — | — | — |
| **AUD-20.05** · JX-3A B-3 · §20<br>A Keplr rejection can read as "unknown". | [UX] | CONFIRMED — `money/keplrWallet.ts`:167, 174-185 `classifyChainError` has no rejection arm. | W2-M | **B** | — | — | — |
| **AUD-20.06** · JX-6C · §20<br>The browser should re-read the chain before a Challenge. | [UX] | CONFIRMED — `money/moneyActions.ts`:591-627 builds from `ctx.view`. | W2-M | **B** | — | — | — |
| **AUD-20.07** · JX-6E · §20<br>The dispute confirm gives no deadline time; the band shows no dispute record. | [UX] | PARTIAL — `SettlementBand.tsx`:70 shows `hhmm(resolverTimeoutAt) \|\| 'its deadline'`; the record is one generic line (`money/moneyFlow.ts`:468). | W2-M | **B** | — | — | — |
| **AUD-20.08** · S10-12 · §20<br>An owner-authored Terms page is needed before the first real deposit. | [UX] | CONFIRMED — no Terms page, route or string in `frontend/src` or `frontend/public`. | W2-M (hosting only) | **B** | OD-16 (RULED: shell + links in Phase 3) | — | **RULED (transcribed 2026-10-04; OD-16 transcribed): W2-M builds the Terms route/page shell and the Terms/deposit link infrastructure; copy owner-authored, never invented; final Terms a Phase-7/mainnet gate.** **Consolidated integration (owner, 2026-10-05):** READY / OPEN IMPLEMENTATION under the settled ruling -- NOT owner-gated: pre-Phase-4 lane D builds the shell and the link infrastructure with no invented prose; nothing is built yet (no Terms route, page or link in the tree). The substantive Terms are a Phase-7 / mainnet gate. C → B. |
| **AUD-20.09** · K-24 · §20<br>No-money table: placeholder payout computed (floating point) and fired as a console stub. | [D] | CONFIRMED — `gameEngine/endgame.ts`:329 `PLACEHOLDER_TOTAL_ANTE = 100`, 417-418; `utils/closeRoomPayout.ts`:5-10; the call is at `App.tsx`:7828-7834 (RED apply half). | W1-N | **B** | OD-12 (RULED 2026-10-03; the call site is deleted, `87d63c4`) | — | The draft map defaulted this to Phase 5; no owner placement exists, so it stays in Phase 3. Neutralise in `endgame.ts` / `closeRoomPayout.ts`; deleting the call site needs OD-12. |
| **AUD-20.10** · K-24 · §20<br>No-money table: Close Room tooltip. | [D] | RESOLVED (audit text stale) — `panels/ContextualActionBar.tsx`:2112-2114 "Close the room. Any player may do this; it closes on its own if nobody does." (no payout claim). | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-20.12** · K-24 · §20<br>No-money table: the "settled on-chain" copy appears to be fixed. | [R] (in a [D] bullet) | RESOLVED — `components/GameOverModal.tsx`:338 records the removed "settled on-chain when the room closes" copy; no such string remains on the no-money path. | W3-F (confirm at the final head) | **F** | — | — | — |
| **AUD-20.11** · I-4 · §20<br>A dispute's evidence reads the live board. | [R] | RESOLVED — integrated closure (`SettlementBand` mounts receive `liveState`). | — | **F** | — | — | — |
| **AUD-20.13** · JX-3A E-1 (W2-M follow-up A) · §20<br>After a reload (or in another tab) a joiner whose link is older than 24 h but whose wallet proof was renewed since still reads "Re-prove <wallet> to deposit" (Deposit offered beside it): the RoomView shows only when the link was made, not when its proof was last verified. | [UX] W2-M follow-up · LOW | CONFIRMED (source, `19c021c`) — the proof time is stored and omitted: every proven grant carries `proof.verified_at` (`server/src/escrow/walletTickets.ts`:127; `renewProof` writes the new proof, keeps `issued_at`; persisted whole by `walletTicketFileStore.ts`:74-83 and `aws/game/dynamoTicketStore.ts`); the admission judges it (`escrowPorts.ts`:395 `WALLET_PROOF_MAX_AGE_MS`, 416); the projection sends `linkedAt: link.issued_at` only (`moneyTables.ts`:935; `standingLinkOf` :377-380 guarantees `proof !== null`); the browser infers from `linkedAt` plus this page's own record (`money/useMoneyTable.ts` `proof`, `money/moneySession.ts` `proofRenewedAt`, never persisted). | W2-M (server addition owner-authorized 2026-10-04 for exactly this row; the browser-only boundary otherwise stands) | **B** | — | — | Implemented as the smallest additive change: `you.link.proofVerifiedAt` = the standing grant's stored `proof.verified_at` (`moneyTables.ts` projection); no migration, contract, codec, ledger-format, FINANCIAL_PROTOCOL_VERSION or hosted-protocol change (an additive server-to-client field). The browser takes the newest of it and this page's own accepted re-proof: past 24 h by that time it is the server's word (Re-prove, no Deposit beside it); inside the 5-minute margin, or with the field absent or malformed (an older server), the page's inference (Re-prove with Deposit beside it). Residual (LOW, accepted): the age is judged on this device's clock; a clock hours ahead still reads a fresh proof as stale -- one free re-proof, never a deposit taken. OWNER DESIGN DIRECTION (2026-10-04): the Profile + Keplr flow is PROVISIONAL and slated for a later redesign/rebuild; this row is a minimal, removable compatibility change, not an endorsement of the current flow (no new UI surface, no new authority). |
| **AUD-20.14** · JX-3A E-2 (W2-M follow-up B) · §20<br>When the page does not yet show the seat's standing link (a stale view: another tab or device linked a wallet moments before), Link / Re-prove is answered `replace-required` after Keplr signed, and confirming the replacement needs a second Keplr signature. | [UX] W2-M follow-up · LOW | CONFIRMED (source, `19c021c`) — `moneyTables.ts` `walletLink`: `challenges.take` -> ADR-036 verify -> actor `linkDecision` (`replace-required` 409 when the newest standing proven grant is another wallet and `replace` is absent, :1288-1291) -> `finish()` spends the nonce on every non-503 answer with that answer cached (:1319-1322); `walletProof.ts` `ChallengeBook.spend` / `take` (a retry of the same signature returns the cached 409; a new signature on a spent nonce is `challenge-used`). The challenge text binds site, network, contract, game, seat, wallet, nonce and expiry -- not the replace intent -- so only a new mint + signature can carry `replace: true`. W2-M (AUD-20.03) already asks first whenever the VIEW shows the link; only the stale-view race is left. | W2-M (server addition owner-authorized 2026-10-04 for exactly this row; the browser-only boundary otherwise stands) | **B** | — | — | Implemented as approved (the safer design): `wallet-challenge` also answers `replaces` -- the seat's standing linked wallet when it is another wallet (null: nothing replaced; omitted if the ledger can't be read). The browser asks before Keplr signs (the unspent challenge is superseded by the next mint), then signs once with `replace: true`; a confirmed replacement refuses before signing if the wallet the fresh challenge names is not the one shown (or, from an older server, the view's), and a question raised by the server's own post-signature `replace-required` asks again about the wallet the fresh challenge names. Unchanged: the challenge's single use, the cached answer for a retry, `challenge-used`, `challenge-expired`, the link's own decision and refusal order; the alternative (reusing a consumed challenge / retrying the same signed request) is NOT implemented. Residual (LOW, owner's call, not approved scope): the check is before signing only -- a link made by another device of the same principal while Keplr's prompt is open is still replaced by the plain `replace: true` (as before W2-M); closing it would need an additive `replaceWallet` on wallet-link. OWNER DESIGN DIRECTION (2026-10-04): the Profile + Keplr flow is PROVISIONAL and slated for a later redesign/rebuild; this row is a minimal, removable compatibility change, not an endorsement of the current flow (no new UI surface, no new authority). |

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

## W3-G retrospective UI-parity findings (U-28 / AUD-22.01; AUD-00.01) — 2026-10-04

Filed by the W3-G audit at `c0a44d7` (then the current provisional baseline; since superseded by `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration`). The CURRENT-SOURCE column for these rows is `c0a44d7`, not
`8e897f9`. Each finding is fixed in W3-J (or the named slice), proven obsolete, or ruled by the owner before W3-F closes Phase 3
(Part F: deferral to polish is not a disposition).

| AUDIT ITEM | AUDIT CLASSIFICATION | CURRENT-SOURCE STATUS (8e897f9) | EXECUTION SLICE | FINAL DISPOSITION | OWNER DECISION | PHASE-4 OBSERVATION | NOTES |
|---|---|---|---|---|---|---|---|
| **AUD-25.01** · U-46 · W3-G (U-28)<br>The shell's action latch releases after 6 s while the room link still holds the submission; only the par prompt and the three offer forms read the link queue, so the OR bar, the Stock Round buy/sell/pass, the consent prompts and the W2-G emergency modal re-arm and a second press can queue a duplicate (a second sale can legally land). | [UX] W3-G finding · MEDIUM | CONFIRMED — `App.tsx`:900 `ACTION_LATCH_BACKSTOP_MS`, 4426 `actionInFlight = pendingAppendIndex !== null`, 4436-4440 backstop; `await link.submit` does not settle while the link is down; W3-I wired `linkQueue` only into `AuctionPromptModal` and the offer forms; `EmergencyTrainPurchaseModal.tsx`:196-229 own 4 s latch. | W3-B | **B** | — | — | Cross-slice (W3-I x #1173 latch x W2-G). Remedy: one derived busy reason, e.g. `actionInFlight = pendingAppendIndex !== null \|\| linkQueue.unsettled > 0`, read by every control including the emergency modal; also resolves the two disagreeing busy lines (AUD-25.10). **Owner review 2026-10-04: OPEN — W3-B remediation obligation (MEDIUM).** **W3-B 2026-10-04: IMPLEMENTED on `phase3/w3-b-action-latch-linkqueue` (`26f5982` + review fix `5fd3a7b`); INTEGRATED** on `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration` (merge `00b2b3c`; see "W3-B AUD-25.01 integration status"); the RED-R5 LOW stays an accepted residue. |
| **AUD-25.02** · U-47 · W3-G (U-28)<br>The Rules Reference says "The CSL and DH exception hexes are not reserved: any corporation may tile them"; the authority bars the C&SL's B20 while a player owns it (only the D&H's F16 is excepted, #1694a). | [UX] W3-G finding · MEDIUM | CONFIRMED — `RulesReference.tsx`:1847 (and the Track watch line at :2214 that reuses it) vs `privateReservations.ts`:82-83 and `layTileAuthority.ts` `privateHexRefusal`; the correct sentence is already at `RulesReference.tsx`:453. | W3-J | **B** | — | — | S6-7 parity: the board path is correct (glow, click refusal, hex markers); only the copy contradicts it. Copy-only fix. **Owner review 2026-10-04: OPEN — W3-J remediation obligation (MEDIUM); not implemented.** **IMPLEMENTED (W3-J `a560721`; not integrated).** Recorded for the owner: the quoted sentence, read literally, also covers F16 under a player-owned D&H. **Consolidated integration (owner, 2026-10-05):** copy-only correction `f29d992`: the gotcha now tells B-20 (barred while a player owns the CSL; the owning corporation's extra lay) from F-16 (the one exception: any corporation may tile it under the ordinary rules, which ends the DH's special ability). No engine change. |
| **AUD-25.03** · U-48 · W3-G (U-28)<br>A refusal is not retired when a later AUTOMATIC-flagged player decision lands (B&O par, home station, M&H exchange, Undo): `submission-landed` fires only for `automatic !== true`, so the P3-N004 symptom survives on those paths. | [UX] W3-G finding · LOW | CONFIRMED — `App.tsx`:6692 (RED R1) gate `options?.automatic !== true`; the par (9809), `PlaceHomeStation` (9769), `ExchangePrivate` (6115) and `RevertTo` (9347) are sent `automatic: true`. | W3-J | **B** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | One-line RED R1 change (gate on `derived !== true`), its own reviewed commit. **IMPLEMENTED (W3-J RED R1 `6378dea`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.04** · U-49 · W3-G (U-28)<br>The free station placement (home / D&H) neither awaits nor rolls back: a refused D&H station leaves `dh-token` in the shell's fallback set (the power reads used), and the President's home-station prompt re-pops for the whole round trip (and any outage), inviting a second `PlaceHomeStation`. | [UX] W3-G finding · LOW | CONFIRMED by reading — `commitFreeStationPlacement` (`App.tsx`:9747-9790); `HomeStationPrompt` mount `pending={homeStationPlacement ? null : pendingHomeToken}` (`App.tsx`:14001); the path is `automatic`, so it never arms the latch. | W3-J | **B** | — | — | Extends P3-N020's rollbacks (W3-C covered lay and run only); the latch half is W3-B's P3-N021. **IMPLEMENTED (W3-J `19539b2`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.05** · U-50 · W3-G (U-28)<br>Other optimistic shell state a refused move leaves behind: the committed lay ghost and the station picture (held until their 4 s clocks), the token handler's step/target writes, End Turn's tutorial navigation; and the client's own pre-send gates (turn, catching-up, link-down) answer `undefined`, so a lay or run pressed during the reload replay keeps its disarmed JK / spent key or its `ran:true` mark. | [UX] W3-G finding · LOW | CONFIRMED by reading — `App.tsx`:12040-12043, 12202, 12279-12288 (ghost), 11066-11099 (token), 11968-11980 (End Turn); pre-send gates 6524-6530, 6576-6577, 6637-6639 return `undefined` (W3-C accepted LOW (a), still reachable via the catching-up gate). | W3-J | **B** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | The pre-send half needs RED R1 lines (return `false`); the rest is outside RED. **IMPLEMENTED (W3-J RED R1 `b9afbdf` + `19539b2`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.06** · U-51 · W3-G (U-28)<br>A resync puts two contradictory sentences on the strip -- the stale refusal ("... this tab has caught up. Try that again.") beside the resync notice ("... reloading the room's history.") -- and the resync notice is retired only by this tab's own landed move, so a seat not on turn keeps it. | [UX] W3-G finding · LOW | CONFIRMED — `serverLink.ts`:478-479 calls `onStale` then `onResync`; `roomNotices.ts` retires `resync` only on `submission-landed`; the drain's `finally` retires only `catching-up`. Combines with W3-C accepted LOW (b) (a resync can roll back a landed move's shell state). | W3-J | **B** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | Retire `resync` when the rebuild's drain settles (RED R5) and skip `onStale` when `onResync` fires (`serverLink.ts`). **IMPLEMENTED (W3-J `a1ef9e5` + RED R5 `e769e51` + `11db86f`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.07** · U-52 · W3-G (U-28)<br>A server `internal` error during a submit carries no `inReplyTo`, so the submission stays pending until the next reconnect: the queue-aware forms and the par prompt stay held ("Sending your last action") and the strip shows a `transport` notice no landed move retires. | [UX] W3-G finding · LOW | CONFIRMED by reading — `server/src/routerServer.ts`:460 `error` without `inReplyTo`; `serverLink.ts`:940-941 settles only `answers`. Supersedes W3-C accepted LOW (c) (an answering `error` frame is never sent; downgraded to NIT). | W3-J | **B** | — | — | Server frame field only (no rule, no settlement): attach `inReplyTo` to a submit's internal error. **IMPLEMENTED (W3-J `a1ef9e5` + `11db86f` + `d312706`; client-side, no server change; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.08** · U-53 · W3-G (U-28)<br>While the D&H's free station keeps Tokens open, the paid "Place Station Token for $X" control skips the treasury check, so a poor treasury can stage a paid token the server refuses. | [UX] W3-G finding · LOW | CONFIRMED by reading — `stationTokens.ts`:707-713 returns before the treasury check; `ContextualActionBar.tsx`:1955-1967 has no `disabled`; the click asks only `evaluateStationPlacement` (no treasury arm). | W3-J | **B** | — | — | Batch-3 station gate parity. Ask `stationPlacementRefusal` (or its treasury and allowance arms) for the paid control and the click. **IMPLEMENTED (W3-J `b74ffef`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.09** · U-54 · W3-G (U-28)<br>S6-13 remainder: the shell's `runnableDrafts` filter and `editRouteDraft`'s click rules still judge route drafts locally; nothing proves they accept every route the v12 authority accepts (if an Auto Route draft were wrongly dropped while Skip is withdrawn, the turn would stick). | [UX] W3-G finding · LOW | CONFIRMED by reading — `App.tsx`:4900-4985, 10355; `routeDraftEdit.ts`:145-250. W1-G (AUD-07.04) retired only the `RoutePlannerPanel` duplicate. | W3-J | **B** | — | — | Phase-3 part: a property test over the route-oracle corpus (every exact Auto Route draft survives the filter) or judge drafts with `evaluateRouteSet`. The structural cleanup stays Phase 7 (GitHub issue #1, S6-13). **IMPLEMENTED (W3-J `28fbd85`: the Phase-3 parity property test; no defect found; structural cleanup stays Phase 7 / issue #1; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.10** · U-55 · W3-G (U-28)<br>UI-parity NITs found by the retrospective: the depot purchase panel copies the purchase rule instead of asking `trainPurchaseRefusal`; the off-turn funding-offer Accept does not ask `fundingPrivateAnswerRefusal`; two busy lines disagree for one held submission (`PrivateCompaniesSection` "Queued" vs `StockRoundPanel` "Sending"); "queued" means two things (M&H toast vs W3-I note); the Rules Reference ticks the delayed auction done when it was cancelled; the link-down pre-send line can repeat the reconnecting banner; stale `RunManualRoute` comments. | [UX] W3-G finding · NIT | CONFIRMED by reading — `TrainPurchasePanel.tsx`:557-590, 1814-1870; `PrivateCompaniesSection.tsx`:121-129 vs `StockRoundPanel.tsx`:3282; `mhQueuedExchange.ts`:167-170; `RulesReference.tsx`:2871; `App.tsx`:6637, 4555, 4717, 10348. | W3-J | **B** | — | — | Each a small, local fix; none blocks play. **IMPLEMENTED (W3-J (a) `3889482`, (b) `cfb3e69`, (c) `49501c7`, (d) `dbe43a2`, (e) `01dc5ca`, (f) `00e91a2`, (g) `a61a7c2`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.11** · GR-1b · W3-G (U-28)<br>The shell's no-server forced withhold sends the run's revenue as a withhold (GR-1b) -- named in AUD-08.01's notes and the OD-4 / OD-10 exclusions but never given a row or a slice. | [UX] W3-G finding · LOW | NOT RE-VERIFIED — the no-server room path is unreachable in the hosted build (`config/backend.ts`:21-35; `sandboxRoom.ts` `subscribeSandboxLog` is a stub), so this may be obsolete. | — | **C** | — | — | Owner review of the W3-G findings: confirm obsolete (no-server path retired) or place it. **RULED — CLOSED — OBSOLETE / UNREACHABLE ARCHITECTURE** (owner, 2026-10-04): the no-server forced-withhold path is no longer reachable; rooms require the game server. No remediation slice. |
| **AUD-25.12** · — · W3-G (U-28)<br>W2-E's residue -- `privateCatalog.ts`'s M&H ability text, assigned to "W1-L / W2-J copy" -- was taken by neither (both COMPLETE). | [UX] W3-G finding · LOW | NOT RE-VERIFIED — recorded only in W2-E's slice status. | W3-J | **B** | — | — | Verify the text against OD-3 / W2-D's M&H behaviour and correct it if stale. **IMPLEMENTED (W3-J `b6ab759`; INTEGRATED on `phase3/consolidated-pre-playtest-integration` (2026-10-05)).** |
| **AUD-25.13** · — · W3-G (U-28)<br>Accepted Phase-3 LOW / NIT follow-ups that hold no matrix row: scroll-to-card on the Stocks tab (W2-F); duplicate waiting presentation during an emergency-funding private offer (W2-F); the Buy Trains from a Corporation form closes on Send (W3-I); the #750 treasury diagnostic beside the float line on an M&H / C&A float (W2-J); W2-G's unpassed `onEmergencyPurchase` / `emergencyAvailable` props; `executeEmergencyLegs` fail-loud hardening; post-game statistics miss the emergency portfolio legs (R2); a weak `escrow3bAdversarial` assertion; W2-B review nit 3; W3-C's one-slot / one-line NITs, its source-pinned rollback wiring (LOW d) and the refused lay that does not reopen the errand flow. | [UX] W3-G finding · LOW | NOT CODE — collected from the slice statuses, the integration records' `follow_ups` and the reconciliation sections. | W3-J | **C** | — | — | Part F: deferral to polish is not a disposition. Owner review of the W3-G findings rules each: fix in W3-J, or accept as a recorded residual. W3-C's Firestore-path LOW is unreachable (no row). **RULED** (owner, 2026-10-04): each carried LOW / NIT assigned to exactly one of FIX IN W3-J / RECORDED RESIDUAL / OBSOLETE -- table below. **W3-J: every FIX IN W3-J item IMPLEMENTED (not integrated)** -- #1 `a6aa059`, #2 `8673b4e`, #3 `572ca8f` + `a03034f`, #4 `95e0b94`, #5 `f058c1f` (no R2 edit needed), #6 / #7 `00e91a2`, #8 `19539b2` + `f583c95`, #9 RED R1 `77b0b38`, #22 `b6ab759`. **Consolidated integration (owner, 2026-10-05):** the third-seat emergency `train-offer` duplicate prompt W3-J found is P3-N027 (REQUIRED PHASE-3 BUGFIX, pre-Phase-4 lane C). |
| **AUD-25.14** · — · W3-G (U-28)<br>Tracking reconciliation debt: Part C statuses not reconciled with IMPLEMENTED rows (U-4, U-5, U-6, U-17, U-44 DEFERRED; U-23 ... U-37 OPEN; U-20/21/22/38/39/40 untagged; S6-13 DEFERRED); Part D records no Phase-3 OD; README's rulings list and baseline row stale; superseded branches still called "current" (wave2a records, canonical context :357); stale plan prose (W2-B, W2-G, W2-I status lines, header, §7 intro, §7.3 heading). | [UX] W3-G finding · LOW | CONFIRMED — the W3-G tracking audit (report `claude/PHASE3_W3G_UI_PARITY_AUDIT_*`). | W3-F | **B** | — | — | Closure bookkeeping (closure items 3 and 12); W3-G records it rather than rewriting history. |
| **AUD-25.15** · — · W3-G (U-28)<br>Owner rulings applied by COMPLETE slices but never transcribed: OD-3 (W2-E: AUD-10.03, AUD-10.06), OD-13 (W2-L: AUD-12.02, AUD-12.03), OD-14(d) (W2-L keeps "traded": AUD-12.07) and OD-14(i) (W2-K). | [UX] W3-G finding · LOW | CONFIRMED — absent from `owner_rulings` and the plan's OD table / §7.3; the backlog (4682, 4730) cites them as ruled. | W3-F | **C** | OD-3, OD-13, OD-14 | — | The owner supplies or confirms the ruling text; then AUD-12.07 can close. **RULED — resolved** (owner, 2026-10-04): OD-3, OD-13, OD-14(d), OD-14(i) transcribed (plan §7.3, `owner_rulings`); AUD-12.07 RULED. |
| **AUD-25.16** · U-56 · W3-G (U-28) — owner-observed<br>Owner-observed (2026-10-04): a seated principal pressed the Lobby's public-list "Watch" on their own game; the table opened in their SEAT, ONE TURN BEHIND the game, and offered them their turn from that stale board. Three separate facts: (a) WATCH IDENTITY -- Watch and "Your tables" are one door (`onEnterSandbox(gameId)`); no watch intent reaches the shell or the wire, and the seat is the server's principal -> seat answer, so a participant who presses Watch is seated, against the button's "You will not have a seat."; (b) STALE AT REST -- the drain counts an entry applied before dispatching it, with no catch and no retry, and on a fresh entry the first board comparison is muted (console only), so the board can rest behind the room with no notice; (c) ACTIONABLE WHILE STALE -- the only currentness gate is a drain in progress; the turn gate reads the shell's own board, and the link stamps a click with the index it RECEIVED, so the server's staleness guard does not fire and the click is judged on the real board (refused, or APPLIED when legal there). | [UX] W3-G finding · HIGH | CONFIRMED (source + in-memory tests, `phase3W3GWatchDefect.test.tsx`) — (a) `Lobby.tsx` `onWatch` / `onOpen` -> `onEnterSandbox`; `App.tsx` `handleEnterSandbox` (no intent, `mode: "sandbox"`); `server/src/rooms/gameRecord.ts` `roomViewFor` role by `seatOf(record, principalId)`; `LobbyRoomList.tsx` Watch title. (b) `App.tsx` drain `appliedCountRef.current = at + 1` before `await runGameplayActionRef.current?.(...)`, try/finally only; `divergenceWatch.ts` `everAgreed` false -> `message: null`. The exact trigger of the owner's stale entry (a client reducer no-op / refusal vs a thrown replay) is NOT PROVEN -- the owner's console (`[divergence] … have not agreed` vs an unhandled rejection) distinguishes them. (c) `App.tsx` turn gate (`replayingRef` only; `actingAddress(boardNow, …)`); `serverLink.ts` `flushUnsent` `baseIndex: appliedIndex` advanced in `applyEntries`; `roomSession.ts` staleness `baseIndex < nextIndex - 1` -- a tip-stamped click from a stale board is refused by authority, or applied (test: index 3 lands). | W3-J | **B** | OD-19 | — | HIGH (owner-accepted 2026-10-04): a stale view can submit, the click reaches the server and can land (proven in memory; no live game touched). (A) OD-19 RULED: Watch always opens a READ-ONLY spectator view, even for a principal who holds a seat; it never silently reinterprets the viewer as their seated player; re-entering an owned seat is the participant path ("Your tables" / Open / Rejoin); the control keeps "Watch this game. You will not have a seat." (B), (C) OPEN / W3-J under the stale-board safety requirement (status). Characterization tests `components/phase3W3GWatchDefect.test.tsx` stay as triage evidence: DEFECT tests flip in W3-J, KEEP tests (the Play / Rejoin seat path) stay. **OPEN — HIGH; owner W3-J** (at triage; IMPLEMENTED by W3-J, at the end of this cell). Sub-problems: (A) Watch identity semantics -- RESOLVED BY OD-19 (Watch = read-only spectator, always; the read-only Watch itself is implemented in W3-J); (B) stale board can remain silently behind -- OPEN / W3-J; (C) stale board can present and submit live gameplay actions -- OPEN / W3-J, HIGH safety defect. STALE-BOARD SAFETY REQUIREMENT (owner, 2026-10-04; independent of spectator policy): a client whose locally APPLIED board state is behind the authoritative game state must never be allowed to submit a gameplay action as though its board were current. W3-J must address BOTH layers. CLIENT: while replay / catch-up / divergence remains unresolved, gameplay controls are non-actionable; stale local turn authority must not enable a move. SUBMISSION / SERVER: do not rely only on the browser hiding or disabling controls; the submission must carry / bind to the revision / log position actually APPLIED to the client's board, not merely the newest log position received; the server must reject a gameplay action whose client-applied position does not match the authoritative pre-action position. The exact protocol is W3-J's to investigate and review. **IMPLEMENTED (W3-J, OD-19: `fd3bbda` + RED R1 `b4c1714` + RED R5 `7c4624f`, `8c5ff63` + review fixes `e538039`, `45272e6`; not integrated).** **Consolidated integration (owner, 2026-10-05):** INTEGRATED; OD-19 -- the owner does not re-ask confirmation of W3-J's RED edits; the fail-closed behaviour when a board cannot converge is an intentional safety property, preserved. |

### W3-G owner review (2026-10-04) — ACCEPTED

The owner accepted the W3-G findings; all fifteen rows stand. Rulings:

- **AUD-25.11 / GR-1b = CLOSED — OBSOLETE / UNREACHABLE ARCHITECTURE.** The no-server forced-withhold path is no longer part of the reachable product architecture; rooms require the game server. No remediation slice.
- **AUD-25.13:** no "polish later". Reachable and player-visible -> FIX IN W3-J; solely a test-coverage limitation with no known runtime defect -> RECORDED RESIDUAL; unreachable / obsolete -> CLOSED OBSOLETE. Every carried LOW / NIT, one disposition each (also `aud_25_13_dispositions` in the JSON):

| # | Carried follow-up | Disposition | Reason |
|---|---|---|---|
| 1 | scroll-to-card on the Stocks tab (W2-F, deferred LOW) | **FIX IN W3-J** | reachable, player-visible |
| 2 | duplicate waiting presentation during an emergency-funding private offer (W2-F) | **FIX IN W3-J** | named by the owner |
| 3 | the Buy Trains from a Corporation form closes on Send -- queued-submission form retention / retype after a drop (W3-I) | **FIX IN W3-J** | named by the owner |
| 4 | the #750 treasury diagnostic beside the float line on an M&H / C&A float (W2-J) | **FIX IN W3-J** | named by the owner (where the duplication is player-visible) |
| 5 | post-game statistics miss the EmergencySellPortfolio legs and the automatic liquidation (`gameHistory.ts`; R2) | **FIX IN W3-J** | reachable, player-visible (post-game statistics); OD-12 RED R2 edit |
| 6 | W3-C one-slot NIT: one connection slot, so a later connection notice (e.g. reconnecting) replaces a room-status pause notice | **FIX IN W3-J** | reachable, player-visible |
| 7 | W3-C one-line NIT: the one-slot surfaces (waiting room, gate pages) show the refusal before, and so hide, a standing connection notice | **FIX IN W3-J** | reachable, player-visible |
| 8 | W3-C: a refused lay restores the power / JK arm but does not reopen the errand flow | **FIX IN W3-J** | named by the owner |
| 9 | W2-D deferred: an `automatic: true` dispatch bypasses the reload "catching up" guard | **FIX IN W3-J** | reachable; player-visible as a refusal on a historical board; coordinate with AUD-25.03 (OD-12 RED R1) |
| 10 | W3-C LOW (d): the App.tsx rollback wiring is source-scanned rather than handler-executed | **RECORDED RESIDUAL** | named by the owner; the runtime behaviour is covered by the reducer / helper tests, and the product defects it left uncovered are their own rows (AUD-25.03, AUD-25.04) |
| 11 | a weak `escrow3bAdversarial` uncertified-board assertion | **RECORDED RESIDUAL** | test coverage only; no known runtime defect |
| 12 | `executeEmergencyLegs` fail-loud hardening | **RECORDED RESIDUAL** | defensive hardening only; no known runtime defect, not player-visible |
| 13 | W2-J K-22 harness repeats the shell's float loop instead of running App.tsx (call site source-pinned) | **RECORDED RESIDUAL** | test coverage only |
| 14 | W2-D: the composition test mirrors App's memo (ordering source-pinned) | **RECORDED RESIDUAL** | test coverage only |
| 15 | W2-F NIT: the waitingSentence prop docs name `dockHold.turnHoldReason` | **RECORDED RESIDUAL** | comment only; no runtime or player-visible effect |
| 16 | W3-I NIT: variable placement in `TrainPurchasePanel` | **RECORDED RESIDUAL** | code style only; no runtime or player-visible effect |
| 17 | W2-I NIT: the legacy on-chain strip's "On-chain game #<id>" label | **RECORDED RESIDUAL** | the behaviour OD-6 keeps; no defect |
| 18 | W2-G's now-unpassed `onEmergencyPurchase` / `emergencyAvailable` props on the bar and `TrainPurchasePanel` | **OBSOLETE** | dead props: nothing passes them, so no reachable behaviour |
| 19 | W2-B review nit 3 / accepted limitation: on a legacy revision-1 board the first Pass Turn press walks that board's Sell -> Buy stage | **OBSOLETE** | reachable only as a development-corpus replay on a local server; live rules are [13] |
| 20 | W3-C: the no-server (Firestore) path's subscribe error is routed as a refusal | **OBSOLETE** | established unreachable no-server path (rooms require the game server) |
| 21 | W2-B out-of-scope notes: Auto-Buy does not ask `dockHold.pass`; AutoBuyModal "never passes for you" | **OBSOLETE** | superseded by the #1274 fix: Auto-Buy sends no Pass, so the hold question and the copy are moot (the copy is now accurate) |
| 22 | W2-B out-of-scope note: the tutorial's "Instead of buying shares, players can Sell..." copy | **FIX IN W3-J** | reachable, player-visible copy; must match the v13 sell / buy turn |

  Not in AUD-25.13 because each has its own row: W3-C LOW (a) pre-send gates -> AUD-25.05; (b) resync rollback -> AUD-25.06; (c) the `error` frame (NIT; the residual is AUD-25.07); stale tracking prose -> AUD-25.14.
- **AUD-25.15:** OD-3, OD-13, OD-14(d) and OD-14(i) transcribed (plan §7.3 and `owner_rulings`); resolved for these rulings.
- *(Superseded 2026-10-05: every item below is fixed and integrated on `phase3/consolidated-pre-playtest-integration`; only AUD-25.14 -> W3-F remains.)* **Still OPEN:** AUD-25.01 (MEDIUM) -> W3-B; AUD-25.02 (MEDIUM) -> W3-J; AUD-25.03 … 25.10, 25.12 and AUD-25.13's FIX items -> W3-J; AUD-25.14 -> W3-F. W3-J is unblocked.

### Owner-decision reconciliation (2026-10-04) — chat-only rulings transcribed

Branch `phase3/owner-decision-reconciliation`, from `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration` @ `9ebca03`; docs / tracking only.
A read-only history pass (2026-10-04: every remote branch, the local clone / worktree reflogs, every Phase-3 Project report) found that
several owner rulings existed only in prior owner conversation and had never been transcribed. They are transcribed here, in the owner's
words, from the owner's reconciliation brief; no owner decision is made by this pass (plan §7, owner-decision rule).

| OD | Transcribed | Rows |
|---|---|---|
| OD-5 | Tutorial ORDERING only: tutorial work deferred to the final tutorial/UI pass. The three policy questions stay OPEN (superseded 2026-10-05: OD-5 canonical, plan §7.3) | AUD-01.06, AUD-13.04 (sequenced); AUD-01.03, AUD-11.02, AUD-13.02, AUD-13.07, P3-N019 unchanged |
| OD-9(b) | Policy: the official Keplr asset only, never fabricated. ASSET PENDING, not a decision | AUD-18.05 |
| OD-14(a) | Re-approved by the owner 2026-10-04: remove the probe (the removal is `1b76512` on the then-unintegrated W1-I branch). **Corrected 2026-10-05:** this line said "panels stay outside the bar" -- WRONG; the ruling preserves the current placement, INSIDE the sticky action bar | AUD-01.02 RULED; AUD-01.01 IMPLEMENTED (W1-I integrated 2026-10-05) |
| OD-14(b), (c), (e)–(h) | Wash yes; seventh colour yes; keep / tighten the persistence line; no phase-change sound; no stale replay; static rust / discard icons | AUD-12.05, AUD-12.06, AUD-18.07, VF/G-1, VF/G-7, VF/I-10, VF/J-6 |
| OD-15 | The owner's later clarification supersedes: intro and end-game videos are full-viewport cinematic takeovers, not modals, true viewport geometry; genuine modals stay native dialog / top layer, no second inert architecture | AUD-13.05, AUD-13.06 |
| OD-16 | Phase 3 builds the Terms route / page shell and link infrastructure; copy owner-authored; final Terms a Phase-7 / mainnet gate | AUD-20.08 |
| OD-18 | No move clock, automatic forfeit, automatic trade decline or host succession now; reconsider after Phase-4 playtesting ("pause cap" not named) | AUD-11.04, AUD-19.04 |

Not ruled: **OD-0** (historical evidence ambiguous); **OD-5**'s policy questions; **OD-10(b)** (the historical OD-10 approval is (a); no
equivalence shown). OD-18's "pause cap" is not named by the ruling (the owner may confirm it falls under the later placement). No disposition letter changed (the C → E moves OD-18 describes are W3-F's).
## W3-H slice status (2026-10-04)

**Branch** `phase3/w3-h` from `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f` (the provisional baseline this slice was
cut from; unchanged). **COMPLETE on its slice branch; NOT integrated** (integration and owner broad gate pending). Dependencies W1-I and
W1-B integrated in the base; W3-G's findings add no W3-H dependency. OD-12: one RED R2 commit, isolated and reviewed.

- **AUD-15.01 (A-19) — `b3ed9c1`, RED R2 `9f88178`, pins `3913f9c`:** a named duck slot in `utils/audio.ts` (a new hold in the slot
  supersedes the old; titles/outro holds unslotted and unchanged); the shell frees the slot when the clip is gone and on unmount (outside
  RED); one argument at the haunting's duck (RED R2). Residual LOW: a silent fog replacing an audible haunting holds the duck until the
  fog ends (~6 s), bounded where it used to be permanent.
- **VF C-7 / E-6 / F-5 — `223c105` (+ `31580c1`):** off-screen work is not started (`utils/surfaceVisibility.ts`): VF-1 transfers and
  VF-3 floats declined at launch when their card or page cannot be seen; VF-2's route-signal clock pauses and resumes. A declined
  takeover still sounds its presidency cue on its beat (review fix).
- **VF D-12 `58a67df`, D-30 `41fe7f3`, D-13 `5f0ffd2`, D-21 `b09c4d6`:** printed terrain/name/cost fade on an unproposed lay; the value
  badge laid per side from a scratch layer; route overlays held on a hex mid-flourish; rail-less centre ties broken by a stated rule
  (every accepted pairing unchanged). **D-35 `422a361`:** analysis, no presentation lever; header OPEN for W3-F (→ D).
- **Real-browser evidence (`docs/phase3/evidence/w3h/`, harness `frontend/scripts/w3hEvidence/`):** K-4 `ce1d0dc`, C-10 `d8c7cbd`,
  D-16 `cef8cb1`, D-17 `4007462` (throttled trace: 14.6 fps at 4×, 10.7 at 6×; full-board raster dominates -- design follow-up, stays
  OPEN for the Phase-4 device), E-5 `be06aa9` → defect → `4c89333` → re-run `614172d` (the lifted card settles behind the dock).
- **Found and fixed under E-5 — `4c89333`:** the full-motion float ceremony could never play (its card's ref waited on the measurement
  the ref provides). Now live: E-1's playtest can watch it.
- **VF H-6 `e10dc13`, I-8 / J-5 `887c4e5`, K-6 `ce99b0d`:** the mini-auction ring reads the shared palette; the Ledger's corporation
  rows receive the rust and discard events; a badge-size raster guard on the rust mark.
- **Owner-gated rows (OD-14, transcribed on `phase3/owner-decision-reconciliation` @ `26bca3b`, not on this base):** (b) AUD-12.05 and
  (c) AUD-12.06 found already implemented and pinned (`a2aaa31`); (h) VF/I-10 already implemented (`RustMark`), VF/J-6 implemented
  (`DiscardMark`, `ce99b0d`); (f) VF/G-1 and (g) VF/G-7 ruled out -- no work. Disposition letters (C → B / F) left for W3-F.
- **Accounting:** `check_phase3_accounting.py` learns that a Phase-3 slice can RESOLVE a ledger entry: a RESOLVED entry that keeps its
  row must be IMPLEMENTED (or a ruled-in C row). **Not taken:** W3-B, W3-J, W2-M, W3-A, W3-F; rules version (13 / [13]) and
  settlement ([10, 11, 12, 13]) unchanged. The four pre-existing meta-test failures are identical on `d29bb2f` and on this branch.

## Consolidated pre-playtest integration status (2026-10-05)

**Branch** `phase3/consolidated-pre-playtest-integration` from `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration` @ `9ebca03`
exactly — **the current provisional Phase-3 integration baseline** (its successor under OD-0). PROVISIONAL: no broad Phase-3 owner gate;
not merged to main (`e1f1280` unmoved). Record: `consolidated_pre_playtest_integration` in the JSON.

- **Merged `--no-ff`, in order:** the owner-decision reconciliation `26bca3b` (merge `b7a98f3`), W1-I `5ffdfa5` (`4cf853b`), W2-M `d68602d`
  (`dc6020a`), W3-A `bb20225` (`ead4034`), W3-D `746aa6f` (`a57b01a`), W3-J `789a3d0` (`e62bd74`; it carries the Watch triage / OD-19 branch
  `3be965d`, so that branch was not merged again -- nothing of it was missing) and W3-H `aa3896a` (`e931310`). Every input commit unchanged.
- **Conflicts:** one code conflict (App.tsx, the AppShell signature: W3-A's tutorial-order constant and W3-J's `watchOnly` prop -- both
  kept); the rest tracking-only, resolved per row and field and normalised against the final tree.
- **Integration commits:** `d4f7c53` and `9b77f18` (five stale source pins in five suites that failed on the W1-I / W3-J heads themselves
  follow those slices' deliberate changes); `f29d992` (correction F, AUD-25.02 copy only: B-20 vs F-16); `15fd1d0` (correction B: Tutorial
  leaves the forced-notice chain; AUD-01.06 = the interim auto-reset removal); the tracking normalisation (corrections A, C, D, E, G).
- **Owner rulings applied** (plan §7.3, the consolidated section): OD-0, OD-5 (canonical), OD-9(b), OD-10(b), OD-14(a) corrected to
  INSIDE the bar, OD-15 (canonical), OD-16 (not a blocker), OD-18 (superseded in part), OD-19 (no re-confirmation), D-17, D-35,
  AUD-25.02, the third-seat emergency offer (P3-N027), W3-H `4c89333` approved. **Owner decisions still open (neither created here):** the placement of AUD-04.04 / AUD-08.01; the final tutorial pass's timing (by the closure contract the last Phase-3 lane, F).
- **Disposition moves (owner placements):** AUD-11.04 C → B (lane A); AUD-19.04 C → E; AUD-20.08 C → B (lane D); VF/D-17 B → D; new
  row P3-N027 (B, lane C).
- **Slices:** W1-I, W3-A, W3-J COMPLETE and INTEGRATED; W2-M PARTIAL (AUD-20.08); W3-D PARTIAL (AUD-13.04 → final tutorial pass);
  W3-H PARTIAL (VF/D-35); W3-B PARTIAL (AUD-14.06, P3-N021).
- **Before Phase 4 (plan §6, "Pre-Phase-4 implementation lanes"):** A clocks (AUD-11.04) · B D-35 (VF/D-35) · C third-seat emergency
  offer (P3-N027) · D Terms shell / links (AUD-20.08) · E W3-B latch residue (AUD-14.06, P3-N021). **Asset pending:** the Keplr logo.
- **Versions:** `RULES_ENGINE_VERSION` 13; supported live `[13]`; settlement-certified `[10, 11, 12, 13]`; keys and fixtures unchanged.
- **Validation:** typecheck clean; production build green, ESLint warnings identical to 9ebca03 (54 = 54); 412 adjacent suites -- 7494 passed, the 11 failure entries identical to 9ebca03 (4 meta, 6 corpus-file-dependent); W2-M server suites 255 / 255; accounting PASS; `git diff --check` clean; meta identical (sourceGuards 1, boardInEffect 1, liveHygiene 2, same offenders); pins 13 / [13] / [10, 11, 12, 13].
- **Independent review:** round 1 -- safety / RED APPROVE WITH NITS, notices / modals APPROVE WITH NITS (two LOW composition findings, fixed `3044129`), tracking REQUEST CHANGES (1 HIGH, 5 MEDIUM, fixed `4db09fc`); round 2 re-review APPROVE WITH NITS, its LOWs / NITs applied (comments / docs). No open HIGH or MEDIUM. Recorded residuals: in the JSON record.

## W3-B latch residue slice status (2026-10-05)

- **Branch:** `phase3/preplaytest-w3b-latch-residue` @ `f855b8b` + this tracking commit, from `phase3/consolidated-pre-playtest-integration`
  @ `b8d5246` exactly. **NOT integrated**; no broad owner gate; `main` untouched; nothing deployed. No rules / protocol / version change
  (13 / [13] / [10, 11, 12, 13]).
- **Commits:** `0b2f360` OD-12 RED R1 (P3-N021, its own commit: two lines in the submit half + the pins that quote them) · `2cea8c4`
  AUD-14.06 + P3-N021 non-RED · `f855b8b` independent-review fixes.
- **P3-N021 -- IMPLEMENTED.** RED R1: `if (options?.derived !== true) setPendingAppendIndex(appendAt);` -- the `automatic`-flagged
  player decisions (OpenStockRound, SetBoPar, ExchangePrivate, PlaceHomeStation, RevertTo, CloseRoom) take the latch with every other
  press (#668: `automatic` = skip the turn gate; `derived` = the game's own action); the server-path `derived` early return no longer
  sets the latch to null (it took none, so it could only release a player's held press). The W3-J catching-up gate, the board-currency
  gate (AUD-25.16) and the turn gate still precede the latch (order pinned). Non-RED: the Auto-Pass / Auto-Buy effects return while a
  press is in flight and re-run when it lets go.
- **AUD-14.06 -- IMPLEMENTED.** Re-audited on the `b8d5246` dispatch sites (53 calls, AST-enumerated). Newly latched: BuyLicenseModal's
  Buy; PrivatePowerFlowModal's act buttons (declines send nothing and are unchanged); the auction prompt's par confirm (W3-I hold kept)
  and Proceed; the token confirm (`canConfirm` + guarded press: PlaceStationToken and the free PlaceHomeStation); Undo
  (`undoBlockedReason`); the map's route clicks (consumed while in flight; the chip's edits and Run already read `sessionReady`).
  One flag, no second busy state: `actionInFlight` (W3-B AUD-25.01, link-bounded) and its one sentence `actionInFlightReason`
  (`actionLatchReason`: the link's words first, then the latch's).
- **Coverage registry** (`frontend/src/components/phase3W3BLatchResidue.test.tsx`): 53 call sites / 51 keys -- 46 LATCHED, each with
  source evidence for every door; 5 EXEMPT with a precise reason (CloseRoom: post-game and idempotent, #899; YellowSignEvent x3: a
  follow-on inside RED R2 on unpinned boards only; `endTurnAutomatically` and the no-server derived purchase: `derived`; the drain:
  `isRemoteReplay`). A new or renamed call site, a `!`/parenthesised call, an aliased reference to the dispatch, or a new reference to a
  latched handler (a new door) fails the registry until classified.
- **Behaviour** (real link, hand-driven socket, real hooks and surfaces): double click; held > 6 s; network loss and reconnect (one
  message); the same player's submission landing (held until the drain applies it); another seat's move (nothing greys; mid-hold the link
  keeps controls busy); refusal re-arms at once; token confirm; route edit; private power modal; licence modal; Proceed / par / Undo;
  automatic presses in the landed-not-drained window; a derived dispatch never releases a held press. Every case asserts one message on
  the wire.
- **Mutation checks:** reverting the RED R1 latch rule in App.tsx (4 fail across the W3-B suites) or in the suite's shell stand-in (7
  fail); restoring the derived null (pins fail; stand-in: 1 behaviour fails); removing the latch from BuyLicenseModal, Proceed, the par
  confirm, the power modal, the token ring or Undo, or the Auto-Pass / Auto-Buy waits (each fails); adding an unclassified site, a `!`
  call, an alias, or a new door (each fails).
- **Validation:** `tsc --noEmit` clean; production build green, ESLint warnings identical to `b8d5246` (54 = 54); 93 affected suites
  together (W3-B, W3-I, W3-J queue / resync / RED / Watch, W3-C, the modal / route / token / auction / undo / auto-buy / auto-pass /
  home-station suites, meta): 2053 passed, 4 failed -- the same 4 meta failures as `b8d5246` on the same list (sourceGuards sweep with the
  same 7 entries, boardInEffect 1, liveHygiene 2); accounting PASS; `git diff --check` clean.
- **Independent review:** RED R1 APPROVE (the one NIT -- the commit's causal wording -- corrected in the RED commit before push);
  composition APPROVE WITH NITS, every LOW / NIT fixed in `f855b8b` except as recorded below.
- **W3-B = COMPLETE** (AUD-25.01 integrated earlier; AUD-14.06, P3-N021 implemented here). Pre-Phase-4 lane E is done on its branch,
  pending integration.
- **Residuals:** (LOW, accepted at AUD-25.01, unchanged) RED R5 -- another seat's entry passing the press's index mid-hold leaves only the
  link holding, so the controls can re-arm for the drain's few milliseconds after the press's own `applied` answer. (LOW, owner ruling
  only if the no-server / Firestore path stays supported) the RED R4 derived effects do not wait for the latch there -- outside this
  slice's OD-12 grant; on the server path they are never sent. (Coverage) the Auto-Pass / Auto-Buy waits are source-pinned only (the
  effects live in the shell). (Pre-existing, not W3-B's) on a legacy unpinned room the Yellow Sign follow-on dispatch runs inside the
  drain and is refused by W3-J's catching-up gate.

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
| **VF/D-17** · VF D-17 · §15, §5<br>Whole-board repaint while a flourish runs. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1172) | W3-H | **D** | — | Tile-lay smoothness and any visible whole-board hitch on realistic desktop / browser hardware. | Measure with a throttled-CPU trace in W3-H; Phase 4 adds a low-end device. W3-H measured it (`4007462`: 14.6 fps at 4×, 10.7 at 6×). **Consolidated integration (owner, 2026-10-05):** PHASE-4 PLAYTEST / OPEN PERFORMANCE OBSERVATION, not an owner-policy question and not a pre-Phase-4 implementation; no speculative optimisation -- only visible jank in real playtesting justifies a later repaint-scope / cached-board fix. B → D (ledger OPEN → PLAYTEST). |
| **VF/D-18** · VF D-18 · §15<br>Rules cross-reference: New York's four-slot city (#54→#883 vs #62→#883). | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1177) | — (no change: out of W3-K) | **C** | OD-17 (RULED 2026-10-03: no change) | — | Tile-upgrade legality is the printed rule; nothing to build. **Status:** RULED — no change: V13_SCOPE_VERIFICATION §6.1 found it INVALID (the printed T-09 upgrade path); the ledger's OPEN entry and comment cleanup are owed to a docs pass. |
| **VF/D-21** · VF D-21 · §15<br>Rail-less printed centres pair by position; some facings tie. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1252) | W3-H | **B** | — | — | — |
| **VF/D-22** · VF D-22 · §15<br>Rules cross-reference: #59 → brown OO facings that break fixed OO (256 accepted transitions). | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1271) | — (no change: out of W3-K) | **C** | OD-17 (RULED 2026-10-03: no change) | — | Placement-filter legality already enforced; the 256 count reproduces only with rule 5b removed. **Status:** RULED — no change: V13_SCOPE_VERIFICATION §6.2 found it ALREADY CORRECT (Stage 9.3 rule 5b, rules v7; 0 accepted transitions today); the ledger's OPEN entry and the D-15 / D-21 / D-24 wording are owed to a docs pass. |
| **VF/D-30** · VF D-30 · §15, §5<br>Clip antialiasing while the front crosses. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1370) | W3-H | **B** | — | — | — |
| **VF/D-35** · VF D-35 · §15, §5<br>An OO home's reservation has no city to ride. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1432) | W3-H | **B** | — | — | **Consolidated integration (owner, 2026-10-05):** NOT an owner-design question -- REQUIRED PHASE-3 FLOURISH IMPLEMENTATION (pre-Phase-4 lane B): the reservation marker moves with its city's geometry and resolves to the correct final city at commit; on an OO tile the transition must keep which of the two city identities the marker belongs to. Presentation only; no gameplay, state or rules change. W3-H's analysis `422a361` is the starting point. OPEN; W3-H PARTIAL on it. |
| **VF/E-5** · VF E-5 · §15<br>The stacking-context claim is reasoned, not screenshotted. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1521) | W3-H | **B** | — | — | W3-H takes the screenshot. |
| **VF/E-6** · VF E-6 · §15<br>Off-screen / inactive-tab cost (same shape as C-7). | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1528) | W3-H | **B** | — | — | — |
| **VF/F-5** · VF F-5 · §15<br>Traveling signal and per-hex badge lookup run whenever any route overlay exists. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1591) | W3-H | **B** | — | — | — |
| **VF/G-1** · VF G-1 · §15<br>Audio is unanswered; the phase flip is silent. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1602) | W3-H (if ruled in) | **C** | OD-14(f) | — | Needs an owner-approved cue. **RULED (transcribed 2026-10-04; OD-14(f) transcribed): no phase-change sound effect in this phase.** |
| **VF/G-7** · VF G-7 · §15<br>A phase change while the bar is unmounted is missed. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1652) | W3-H (if ruled in) | **C** | OD-14(g) | — | The ledger records it as acceptable; the owner either closes it as designed or asks for a replay. **RULED (transcribed 2026-10-04; OD-14(g) transcribed): do not replay stale flourish/celebration effects (replay declined).** |
| **VF/H-6** · VF H-6 · §15<br>The mini-auction card writes the palette out by hand. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1732) | W3-H | **B** | — | — | Import `PRIVATE_POWER_GLOW_STOPS`. |
| **VF/I-8** · VF I-8 · §15<br>Ledger tables do not receive the rust event. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1848) | W3-H | **B** | — | — | — |
| **VF/I-10** · VF I-10 · §15<br>Rust's static badge icon is not implemented. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1865) | W3-H (if ruled in) | **C** | OD-14(h) | — | **RULED (transcribed 2026-10-04; OD-14(h) transcribed): static rust icon treatment — ruled in, W3-H.** |
| **VF/J-5** · VF J-5 · §15<br>Ledger tables do not receive the discard event. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1925) | W3-H | **B** | — | — | — |
| **VF/J-6** · VF J-6 · §15<br>The discard's static badge icon is not implemented. | [UX] OPEN | OPEN in `VISUAL_FLOURISH_BACKLOG.md` (line 1932) | W3-H (if ruled in) | **C** | OD-14(h) | — | **RULED (transcribed 2026-10-04; OD-14(h) transcribed): static discard icon treatment — ruled in, W3-H.** |
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
| **P3-N021** · draft §9 press latch · draft execution map<br>The `press:true` latch does not cover the automatic presses (OpenStockRound, M&H exchange, Undo, PlaceHomeStation, SetBoPar). | NEW-SOURCE-FINDING | CONFIRMED by reading — `utils/doubleActionWindow.test.ts` pins the submit-half text. | W3-B | **A** | OD-12 (RULED 2026-10-03: narrowly controlled RED fixes; one reviewed commit each) | — | **Consolidated integration (owner, 2026-10-05):** NOT STARTED -- the automatic presses still bypass the press latch; W3-B's AUD-25.01 and W3-J's `derived` rule narrow it but do not latch them. W3-B residue, pre-Phase-4 lane E (OD-12 RED R1). **W3-B latch residue (2026-10-05): IMPLEMENTED** -- OD-12 RED R1 commit `0b2f360` (own commit, two lines, independently reviewed APPROVE): every press but a `derived` one takes the latch, and the server-path `derived` return no longer releases a held press; the Auto-Pass / Auto-Buy effects wait for the press in flight (`2cea8c4`). NOT integrated. |
| **P3-N022** · SI ledger / DH-3 / draft §9 · draft execution map<br>Shell-local OR facts: `routesRunThisTurn`, `mustBuyTrain`, the D&H optimistic ability set and `dhStationForfeited` (DH-3), client auto-skip verdicts vs `nextDerivedAction`. | NEW-SOURCE-FINDING | CONFIRMED (App decomposition audit, 6.5-A §5.5). | Phase 5 (Pass E) | **E** | — | On every derived skip, compare the bar's step with the server's `operating_sub_phase` (export the log). | These are the refactor's behaviour passes (App decomposition plan "Pass E"); the owner's fixed roadmap (plan §1) places the major App.tsx refactor in Phase 5. |
| **P3-N023** · SBS-3 (6.5-A) · draft execution map<br>Brown Pool Buy → Sell → Buy is accepted (authority too loose). | NEW-SOURCE-FINDING | CONFIRMED — V13_SCOPE_VERIFICATION §4.3 (APPROVED DEFECT, reproduced at 6455b6e). | W3-K (rules v13) | **A** | OD-10(a) (RULED 2026-10-03: in the v13 batch, the official Brown rule) | — | Official Brown rule only; V-6.3 "Buy All" is NOT implemented. **Status:** IMPLEMENTED — W3-K, `phase3/w3-k-rules-v13` (integrated on `phase3/wave2a-v13-integration`, merge `ed5e69a`): the turn-scoped Brown Bank Pool continuation closes on any sale; Pool → Sell → Pool refused (`rulesV13StockRound.test.ts`). |
| **P3-N024** · SBS-4 / OD-A-4 · draft execution map<br>A Brown IPO first purchase opens the Pool continuation. | NEW-SOURCE-FINDING | CONFIRMED — V13_SCOPE_VERIFICATION §5 precise reproduction: the first purchase of the turn from a STARTED Brown-zone corporation's IPO opened the Pool continuation (the owner's par-space objection applies only to a corporation's first-ever purchase). | W3-K (rules v13) | **A** | OD-2 (SBS-4 part) resolved by the precise reproduction + OD-10(a) (RULED 2026-10-03) | — | Formerly G (needs a precise reproduction); reproduced in V13_SCOPE_VERIFICATION §5, then implemented. **Status:** IMPLEMENTED — W3-K, `phase3/w3-k-rules-v13` (integrated on `phase3/wave2a-v13-integration`, merge `ed5e69a`): only a Brown-zone Bank Pool purchase opens the continuation; IPO → Pool and Pool → IPO refused (`rulesV13StockRound.test.ts`). |
| **P3-N025** · ING-1 · draft execution map<br>City-less token on a two-city hex can strand Routes (draft listed it for a v13 batch). | NEW-SOURCE-FINDING | RESOLVED — v12 refuses creating such a state (`gameEngine/rulesVersion.ts`:396; R12-2 §3). | — | **F** | — | — | — |
| **P3-N026** · OD-A-3 · draft execution map<br>D10 / E5 follow G19's first-upgrade terrain charge (draft listed it for a v13 batch). | NEW-SOURCE-FINDING | RESOLVED — owner ruling recorded in 6.5-B ("D10 and E5 follow G19"); engine already charges; copy updated (`RULES_HARDENING_BACKLOG.md`:4757). | — | **F** | — | — | — |
| **P3-N027** · W3-J residual (AUD-25.13 #2 shape) · W3-J (2026-10-05)<br>During an emergency funding `train-offer` stage a THIRD seat gets the duplicate prompt shape AUD-25.13 #2 fixed for the private-offer stage: more than one presentation of one offer. | [UX] defect | FOUND by W3-J beside `8673b4e` (AUD-25.13 #2: the prompt stands aside while the emergency waiting card shows, except for the buyer president); the train-offer stage was outside that item. | — (pre-Phase-4 lane C) | **B** | — | — | **REQUIRED PHASE-3 BUGFIX (owner, 2026-10-05).** Narrow: prove exactly one intended offer presentation; only the legitimate answering seat has live answer controls; the third seat gets status only; the proposer gets the correct status / rescind behaviour; server authority unchanged. OPEN. |

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
| W2-M slice follow-up (2026-10-04): server residues of AUD-20.02 and AUD-20.03 | AUD-20.13, AUD-20.14 |

## Re-checking this matrix

```bash
python3 docs/phase3/check_phase3_accounting.py            # accounting: exactly-once, bullet coverage, ID coverage
python3 docs/phase3/check_phase3_accounting.py --drift <pinned-base-sha>   # P0: which cited files changed since 8e897f9
```
