# docs/phase3 — Phase 3 (player-facing UI / UX) planning record

**Roadmap (owner, authoritative):** Phase 1 server / infrastructure migration → 2 JUNO testnet live proof → **3 player-facing UI / UX
and pre-playtest closure** → 4 human playtesting and stabilization → 5 major frontend / App.tsx refactor → 6 final polish / release
testing → 7 mainnet readiness / launch. **Current Phase-3 baseline:** `phase3/consolidated-pre-playtest-integration` @ `b8d5246c579d32ad4f9a2fccd7c293d1655ff81a` (provisional; not merged
to main; no broad owner gate). Status: the table "Status after the consolidated integration and AUD-00.02" below.

Start here. These documents plus the repository are all a Phase-3 session needs. It does not need any chat, Project memory
or attachment.

| File | What it is |
|---|---|
| [`PHASE3_EXECUTION_PLAN.md`](PHASE3_EXECUTION_PLAN.md) | **The authoritative execution plan:** the roadmap boundary, the base-pin rule, waves, slices, lanes, the collision map, owner decisions, Phase-4 deferrals, the pre-refactor stabilization list, estimates and the closure contract |
| [`PHASE3_AUDIT_RECONCILIATION.md`](PHASE3_AUDIT_RECONCILIATION.md) | One row per audit item, with its current-source status, slice, disposition, owner decision and Phase-4 observation; plus the NEW-SOURCE-FINDINGS (`P3-N###`) |
| [`PHASE3_UIUX_AUDIT_2026-10-03.md`](PHASE3_UIUX_AUDIT_2026-10-03.md) | The authoritative Phase-3 UI/UX audit, preserved (one chat-preamble line dropped and a final newline added; see its header) |
| [`phase3_accounting.json`](phase3_accounting.json) | The matrix in machine-checkable form (rows and the audit-bullet → row map) |
| [`check_phase3_accounting.py`](check_phase3_accounting.py) | The accounting check, plus `--drift <sha>` for the kickoff drift check |
| [`V13_SETTLEMENT_CERTIFICATION_VECTORS.md`](V13_SETTLEMENT_CERTIFICATION_VECTORS.md) | What the separate rules-v13 settlement certification pass must prove (bankruptcy vectors; the tests red by design until then) |
| [`archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md`](archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md) | The superseded parallel draft, kept for provenance only |

## Pins

| | |
|---|---|
| Planning snapshot (source facts) | `8e897f9c5196f825a69c492dfb7c29088123cf67` (`recon/phase1-remainder-hardening`) |
| Audit's own base | `7b1a956b1eeef31ad17ec6b08b475c4649747f6a` (`live6/live-closure-candidate-w1`); production `frontend/src` identical to the snapshot's |
| **Phase-3 implementation base** | **RULED BY THE CURRENT INTEGRATION LINEAGE (OD-0, owner, 2026-10-05):** the Phase-3 source line is the phase3/... integration chain (Wave 1 on `8f33f0f` → … → `9ebca03` → `phase3/consolidated-pre-playtest-integration`). No retroactive base pin, rebase or history rewrite. |
| Wave 1 (provisional) | Built on `8f33f0fb72d462c381a572015de7860a93fbd198` by the owner's brief; integrated on `phase3/wave1-integration` (2026-10-03), not merged. Status per slice: the matrix's "Wave-1 integration status" section / `slice_status` in the JSON |
| Safe Wave 2 (provisional) | `phase3/wave2-safe-integration` on `4e51cff` (2026-10-03): W2-H, W2-E, W2-L, W3-E, W2-K integrated (Keplr logo ASSET PENDING); W2-G held for the OD-4 v13 work; not merged. See the matrix's "Safe Wave-2 integration status" |
| Wave 2A (provisional; superseded as baseline) | `phase3/wave2a-integration` on `bfb7635` (2026-10-04): W2-A accepted and integrated (its commits `e5fcfcc`, `2d0fd0a` carried linearly) plus one tracking commit; W2-C / W2-D / W2-F unlocked; W2-B blocked on W3-K v13; W2-G held; no broad owner gate run; not merged. See the matrix's "Wave-2A integration status" |
| Wave 2A + v13 (provisional; superseded as baseline) | `phase3/wave2a-v13-integration` on `96ccb22` (2026-10-04): the accepted W3-K rules v13 (`be1fd10`) merged `--no-ff` (`ed5e69a`), one W2-E test reconciliation (`447e28d`) and one tracking commit. Rules 13, live `[13]`, settlement `[10, 11, 12]` unchanged, v13 settlement certification pending; W2-B unlocked; W2-G unlocked for v13 UI reconciliation; no owner gate; not merged. See the matrix's "Wave-2A v13 integration status" section / `wave2a_v13_integration` in the JSON |
| Wave 2 B+C+G + v13 cert (provisional; superseded as baseline) | `phase3/wave2-bcg-v13cert-integration` @ `9b19d9d` (2026-10-04, from `16b79b2`): W2-B, W2-C, W2-G and the v13 settlement certification integrated (merges `181e51e`, `904598a`, `b84247f`, `69c7496`); rules 13, live `[13]`, settlement `[10, 11, 12, 13]`. See the matrix's "Wave-2 B+C+G + v13 certification integration status" |
| Wave 2 B+C+G+D + v13 cert (provisional; superseded as baseline) | `phase3/wave2-bcgd-v13cert-integration` @ `7d8f73e` (2026-10-04, from `9b19d9d`): the accepted W2-D (`f0abdd7`) merged `--no-ff` (`4072fd0`) plus tracking commits; no owner gate; not merged. See the matrix's "Wave-2 B+C+G+D integration status" / `wave2_bcgd_v13cert_integration` in the JSON |
| Wave 2 B+C+G+D+F + v13 cert (provisional; superseded as baseline) | `phase3/wave2-bcgdf-v13cert-integration` @ `c3f43b7` (2026-10-04, from `7d8f73e`): the accepted W2-F (`f19a22b`) merged `--no-ff` (`dfe6d13`) plus one tracking commit; no owner gate; not merged. See the matrix's "Wave-2 B+C+G+D+F integration status" / `wave2_bcgdf_v13cert_integration` in the JSON |
| Wave 2 B+C+G+D+F + W3-I + v13 cert (provisional; superseded as baseline) | `phase3/wave3-i-v13cert-integration` @ `7a9b16b` (2026-10-04, from `c3f43b7`): the accepted W3-I (`92cdb5d`) merged `--no-ff` (`5a22e38`) plus one tracking commit; no owner gate; not merged. See the matrix's "W3-I integration status" / `wave3_i_v13cert_integration` in the JSON |
| Wave 2 B+C+G+D+F + W3-I + W2-I + v13 cert (provisional; superseded as baseline) | `phase3/wave3-i-w2i-v13cert-integration` @ `c774530` (2026-10-04, from `7a9b16b`): the accepted W2-I (`60146da`) merged `--no-ff` (`78f9164`) plus one tracking commit; OD-6 RULED (Option A); no owner gate; not merged. See the matrix's "W2-I integration status" / `wave3_i_w2i_v13cert_integration` in the JSON |
| Wave 2 B+C+G+D+F + W3-I + W2-I + W2-J + v13 cert (provisional; superseded as baseline) | `phase3/wave3-i-w2i-w2j-v13cert-integration` @ `18d4762` (2026-10-04, from `c774530`): the accepted W2-J (`0b33f69`) merged `--no-ff` (`32ead52`) plus one tracking commit; OD-8 RULED (Option A); no owner gate; not merged. See the matrix's "W2-J integration status" / `wave3_i_w2i_w2j_v13cert_integration` in the JSON |
| Wave 2 B+C+G+D+F + W3-I + W2-I + W2-J + W3-C + v13 cert (provisional; superseded as baseline) | `phase3/wave3-i-w2i-w2j-w3c-v13cert-integration` @ `c0a44d7` (2026-10-04, from `18d4762`): the accepted W3-C (`3454daa`) merged `--no-ff` (`b32ef6e`) plus one tracking commit; OD-12 RED R1 / R5 commits audited; no owner gate; not merged. See the matrix's "W3-C integration status" / `wave3_i_w2i_w2j_w3c_v13cert_integration` in the JSON |
| Wave 2 B+C+G+D+F + W3-I + W2-I + W2-J + W3-C + W3-G audit + v13 cert (provisional; superseded as baseline) | `phase3/wave3-i-w2i-w2j-w3c-w3g-v13cert-integration` @ `d29bb2f` (2026-10-04, from `c0a44d7`): the accepted W3-G audit (`e86a933` + owner review `967e4e7`, docs/tracking only) merged `--no-ff` (`72ccd00`) plus one tracking commit; no product code; no owner gate; not merged. See the matrix's "W3-G integration status" / `wave3_i_w2i_w2j_w3c_w3g_v13cert_integration` in the JSON |
| Wave 2 B+C+G+D+F + W3-I + W2-I + W2-J + W3-C + W3-G audit + W3-B (AUD-25.01) + v13 cert (provisional; superseded as baseline; the consolidated integration's base) | `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration` (2026-10-04, from `d29bb2f`): the accepted W3-B AUD-25.01 slice (`7efda71`) merged `--no-ff` (`00b2b3c`) plus one tracking commit; W3-B stays PARTIAL (AUD-14.06, P3-N021 open); no RED edit; no owner gate; not merged. See the matrix's "W3-B AUD-25.01 integration status" / `wave3_i_w2i_w2j_w3c_w3g_w3b_v13cert_integration` in the JSON |
| **Consolidated pre-playtest integration (provisional, current baseline)** | `phase3/consolidated-pre-playtest-integration` @ `b8d5246c579d32ad4f9a2fccd7c293d1655ff81a` (2026-10-05, from `9ebca03` exactly): the owner-decision reconciliation (`26bca3b`), W1-I (`5ffdfa5`), W2-M (`d68602d`), W3-A (`bb20225`), W3-D (`746aa6f`), W3-J (`789a3d0`, carrying the Watch triage `3be965d`) and W3-H (`aa3896a`) merged `--no-ff` in that order, then the integration corrections (W3-A tutorial chain, AUD-25.02 copy, stale source pins) and this tracking normalisation. Not merged to main; no broad owner gate. See the matrix's "Consolidated pre-playtest integration status" / `consolidated_pre_playtest_integration` in the JSON |
| Phase-4 playtest baseline | TBD — recorded at Phase-3 closure (W3-F) |

## Owner rulings recorded

OD-1, OD-2, OD-7 and OD-12 were ruled on 2026-10-03, during wave 1; OD-9(a) and OD-11 at the safe Wave-2 integration — verbatim in the
plan's §7.3 and `owner_rulings` in the JSON. OD-4, OD-10(a) and OD-17 were ruled by the owner's W3-K rules-v13 brief (2026-10-03),
restated in the same places. OD-6 and OD-8 were ruled 2026-10-04 (W2-I, W2-J); OD-3, OD-13, OD-14(d) and OD-14(i) were transcribed at
the W3-G owner review (2026-10-04); OD-19 was ruled 2026-10-04 (the Watch triage). The owner-decision reconciliation (2026-10-04)
transcribed OD-5 (ordering), OD-9(b), OD-14(b), (c), (e)–(h), OD-15, OD-16 and OD-18 from earlier owner conversations.

**The owner's consolidated-integration brief (2026-10-05) was the current word until the AUD-00.02 brief (below)** and is in the plan's §7.3 ("The rulings below are from
the owner's Phase-3 consolidated-integration brief"): OD-0 SUPERSEDED / RULED BY CURRENT INTEGRATION LINEAGE; OD-5 canonical (A
tutorial design last; B per-user / per-game acknowledgement, no backlog; C focus returns once to the game-screen heading; D the
five-notice chain Emergency > Fleet Loss > Private Revenue > Phase Three > Herald -- Tutorial NOT in it); OD-9(b) ASSET PENDING;
OD-10(b) Phase 5; OD-14(a)–(i) restated -- (a) preserves the CURRENT placement, INSIDE the sticky action bar (any record of "outside the
bar" was wrong and is corrected); OD-15 canonical (cinematic takeovers, native modals, no second inert system); OD-16 not an owner
blocker (lane D); OD-18 superseded in part (BUILD the clock in Phase 3, not its automatic consequences); OD-19 confirmed (no
re-confirmation of W3-J's RED edits); D-17 a Phase-4 observation; D-35 required Phase-3 implementation; AUD-25.02 copy-only
correction; the third-seat emergency offer a required Phase-3 bugfix; W3-H `4c89333` approved.

**The owner's AUD-00.02 brief (2026-10-05) is the latest word** (plan §7.3, after the consolidated rulings; `aud00_roadmap_reconciliation`
in the JSON): the Phase 1–7 roadmap order; AUD-04.04 + AUD-08.01 placed in a pre-Phase-4 derivation residue lane; the final gameplay
tutorial pass LAST; the Account / Profile / Wallet lane (onboarding redesign, homepage overlap fix, trust indicators) with W1-K and
AUD-20.08 folded in; the profile policy recorded as direction (below). **No owner decision is open.**

**Owner-decision rule.** Owner decisions require explicit owner approval. Assistant / Cowork recommendations, planning
defaults, inferred choices and implementation decisions are NOT owner rulings. A ruling given in conversation is transcribed
in the same pass; the list below is the single maintained status list.

## Status after the consolidated integration and AUD-00.02 (2026-10-05)

| Status | Items |
|---|---|
| **OWNER DECISION OPEN** | **None.** The two left open by the consolidated integration are RULED by the AUD-00.02 brief: AUD-04.04 / AUD-08.01 → the derivation residue lane (tracking disposition C → B); the final gameplay tutorial pass → the LAST pre-Phase-4 implementation lane. |
| **IMPLEMENTATION OPEN — required before Phase 4** (plan §6, "Pre-Phase-4 work after the AUD-00.02 brief"); **none implemented yet** -- a lane whose branch is starting is not implemented | **ACCOUNT** Account / Profile / Wallet onboarding redesign · homepage overlap fix · trust indicators · W1-K cross-tab Keplr single flight (AUD-19.02) folded in · AUD-20.08 Terms route / page shell + Terms / deposit link infrastructure folded in (was lane D; no invented prose) · **A** Live / Async clocks, AUD-11.04 (no automatic forfeit, trade decline or host succession) · **B** D-35 OO reservation marker, VF/D-35 · **C** emergency `train-offer` third-seat duplicate prompt, P3-N027 · **E** W3-B latch residue, AUD-14.06 + P3-N021 · **DERIV** AUD-04.04 + AUD-08.01 derivation residue · **F (LAST)** the final gameplay tutorial pass, AUD-13.04 and the tutorial system (OD-5(A)) |
| **CLOSURE — after the implementation lanes** | **W3-F** final Phase-3 closure: AUD-25.14 bookkeeping, `PHASE4_PLAYTEST_CHECKLIST.md`, the Phase-4 baseline (full SHA), the broad owner gate |
| **PROFILE POLICY (owner direction for ACCOUNT; target UX, NOT implemented)** | A public homepage before login; Create Account / Log In visible; username / password as the normal account UX; no mandatory recovery-key ritual for new accounts; signed-in players do not re-enter credentials per game; a verified wallet persists to the profile; one application-level Ante X JUNO initiation; factual trust indicators rather than a numeric composite score. No "established profile" threshold is defined. Today's `ProfileGate` / recovery-key flow is the current code, not the desired final UX; no frozen invariant or financial protocol moves by this record. |
| **ASSET PENDING** | The official Keplr logo (AUD-18.05, OD-9(b)); `KeplrMark` stays empty, nothing fabricated |
| **PHASE-4 PLAYTEST** | Every D row (including VF/D-17) and the plan's §8 table, with the consolidated observation items: the float ceremony now actually visible (`4c89333`); D-17 tile-lay smoothness / whole-board repaint; cinematic intro and outro at several UI scales; keyboard blocking under a takeover; Firefox / Safari modal / takeover behaviour; tile-ring first facing; recovery R1–R12; Live / Async clock behaviour once lane A lands; the VF PLAYTEST entries; recorded integration residuals -- a forced notice presenting over a cinematic film, the stale-board notice holding a film's Skip, and where focus lands when the chain ends under an interim tutorial or a takeover (the focus move is dropped, AUD-13.02 / AUD-13.04) |
| **PHASE-5 DEFERRED** | Phone-width gameplay layout and map accessibility: keyboard map access, the responsive map architecture and a keyboard map controller (OD-10(b)); the major App.tsx refactor |
| **DEFERRED PENDING PHASE-4 VALIDATION** | Automatic forfeit on clock expiry, automatic trade decline, host succession (AUD-19.04, OD-18); any Forfeit / Clemency settlement payload |
| **PHASE-7 / MAINNET GATE** | The substantive owner-authored Terms copy (OD-16); deployment (drained v12 rooms, the final owner gate) |
| **PARTIAL slices** | W2-M (AUD-20.08 → ACCOUNT), W3-B (AUD-14.06, P3-N021), W3-D (AUD-13.04 → final tutorial pass), W3-H (VF/D-35), W2-K (Keplr asset) |
| **NOT STARTED slices** | W1-K (folded into ACCOUNT), W3-F |
| **IMPLEMENTED and INTEGRATED** | Every other Phase-3 slice: Wave 1 (but W1-K), Wave 2 (but W2-K's asset and W2-M's AUD-20.08), W3-A, W3-C, W3-E, W3-G (audit gate), W3-I, W3-J, W3-K, the v13 settlement certification; P0 COMPLETE with AUD-00.02 (docs, on `phase3/preplaytest-aud00-roadmap-docs`; pending owner review / integration) |

*The status at the consolidated integration itself (two owner decisions open; lanes A–E plus F, W1-K, AUD-00.02 and W3-F) is the
`consolidated_pre_playtest_integration` record in the JSON and the matrix's "Consolidated pre-playtest integration status" section.*

## Rules v13 (W3-K)

`phase3/w3-k-rules-v13` (accepted; integrated on `phase3/wave2a-v13-integration`, 2026-10-04, not merged to main): `RULES_ENGINE_VERSION` 13, live list `[13]`, rules revision 2 —
OD-2, SBS-3, SBS-4 and OD-4. The owner's 2026-10-04 rulings 1-5 (only enough, Brown continuation and intervening actions, M&H
accounting, duplicate legs, exact private-funding relevance) are implemented there. **v13 settlement certification: PASS / CERTIFIED
and INTEGRATED** with W2-B, W2-C and the v13 W2-G on `phase3/wave2-bcg-v13cert-integration` (2026-10-04; carried into the current provisional baseline
`phase3/consolidated-pre-playtest-integration` (2026-10-05) with W2-D, W2-F, W3-I, W2-I, W2-J, W3-C, the W3-G audit, W3-B's AUD-25.01, W1-I, W2-M, W3-A, W3-D, W3-J and W3-H, not merged to main): rules engine `13`, supported live gameplay `[13]`, settlement-certified `[10, 11, 12, 13]` -- gameplay-engine
support and settlement certification stay separate axes ([`V13_SETTLEMENT_CERTIFICATION_VECTORS.md`](V13_SETTLEMENT_CERTIFICATION_VECTORS.md)).
Still required before deployment: drained v12 rooms and the final owner gate.

## Check

```bash
python3 docs/phase3/check_phase3_accounting.py
```

It also checks progress since the Wave-1 integration: slice and row statuses agree with each other and with the
dispositions, the matrix's totals equal the JSON's, and every recorded ruling is marked in the plan.
