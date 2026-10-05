# docs/phase3 — Phase 3 (player-facing UI / UX) planning record

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
| **Phase-3 implementation base** | **TBD — pin the final canonical integrated head after Phase 2 closes (OD-0 / P0). Record the full SHA here.** |
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
| **Wave 2 B+C+G+D+F + W3-I + W2-I + W2-J + W3-C + W3-G audit + W3-B (AUD-25.01) + v13 cert (provisional, current baseline)** | `phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration` (2026-10-04, from `d29bb2f`): the accepted W3-B AUD-25.01 slice (`7efda71`) merged `--no-ff` (`00b2b3c`) plus one tracking commit; W3-B stays PARTIAL (AUD-14.06, P3-N021 open); no RED edit; no owner gate; not merged. See the matrix's "W3-B AUD-25.01 integration status" / `wave3_i_w2i_w2j_w3c_w3g_w3b_v13cert_integration` in the JSON |
| Phase-4 playtest baseline | TBD — recorded at Phase-3 closure (W3-F) |

## Owner rulings recorded

OD-1, OD-2, OD-7 and OD-12 were ruled on 2026-10-03, during wave 1; OD-9(a) and OD-11 at the safe Wave-2 integration — verbatim in the
plan's §7.3 and `owner_rulings` in the JSON. OD-4, OD-10(a) and OD-17 were ruled by the owner's W3-K rules-v13 brief (2026-10-03),
restated in the same places. OD-6 and OD-8 were ruled 2026-10-04 (W2-I, W2-J); OD-3, OD-13, OD-14(d) and OD-14(i) were transcribed at the W3-G owner review (2026-10-04).

**Owner-decision reconciliation (2026-10-04, `phase3/owner-decision-reconciliation`).** Rulings the owner had given in earlier
conversations but that were never written down are now transcribed from the owner's reconciliation brief, in its words:
OD-5 (tutorial ORDERING only — tutorial work waits for the final tutorial/UI pass), OD-9(b) (the official Keplr asset only,
never fabricated), OD-14(b), (c), (e)–(h), OD-15 (the owner's later cinematic-video clarification supersedes the older modal
reading), OD-16 and OD-18. OD-14(a) was re-approved by the owner on 2026-10-04 (also transcribed on the unintegrated W1-I
branch). *Cross-branch note, not on this line:* OD-19 is recorded on `phase3/w3-g-watch-defect-triage` (`3be965d`), not yet integrated.

**Owner-decision rule.** Owner decisions require explicit owner approval. Assistant / Cowork recommendations, planning
defaults, inferred choices and implementation decisions are NOT owner rulings. A ruling given in conversation is transcribed
in the same pass; this list is the single maintained "still open" list.

**Still open** (genuinely awaiting the owner):
- **OD-0** — the Phase-3 base pin (historical evidence ambiguous; the implementation base above is still TBD).
- **OD-5** — the three policy questions: persist one-shot notices per game or derive them from state; the focus target and
  chaining / yield order for forced notices; the tutorial re-arm policy. (Only the tutorial ordering is ruled.)
- **OD-10(b)** — phone-width game layout, zoom-aware breakpoints and keyboard map access: Phase-3 target, Phase-4
  observation or Phase-5 work. (The historical OD-10 approval is (a); no equivalence is shown.)

**Needs only a confirmation:** OD-18 — U-10's "pause cap" is not named by the ruling (clock, forfeit, trade decline and host
succession are placed after Phase-4); the owner may confirm it falls under the same later placement.

**Waiting on an input, not a decision:** OD-9(b) — the official Keplr logo file (ASSET PENDING); OD-16 — the owner-authored
substantive Terms copy (a Phase-7 / mainnet gate; Phase 3 builds only the shell and links).

## Rules v13 (W3-K)

`phase3/w3-k-rules-v13` (accepted; integrated on `phase3/wave2a-v13-integration`, 2026-10-04, not merged to main): `RULES_ENGINE_VERSION` 13, live list `[13]`, rules revision 2 —
OD-2, SBS-3, SBS-4 and OD-4. The owner's 2026-10-04 rulings 1-5 (only enough, Brown continuation and intervening actions, M&H
accounting, duplicate legs, exact private-funding relevance) are implemented there. **v13 settlement certification: PASS / CERTIFIED
and INTEGRATED** with W2-B, W2-C and the v13 W2-G on `phase3/wave2-bcg-v13cert-integration` (2026-10-04; carried into the current provisional baseline
`phase3/wave3-i-w2i-w2j-w3c-w3g-w3b-v13cert-integration` with W2-D, W2-F, W3-I, W2-I, W2-J, W3-C, the W3-G audit and W3-B's AUD-25.01, not merged to main): rules engine `13`, supported live gameplay `[13]`, settlement-certified `[10, 11, 12, 13]` -- gameplay-engine
support and settlement certification stay separate axes ([`V13_SETTLEMENT_CERTIFICATION_VECTORS.md`](V13_SETTLEMENT_CERTIFICATION_VECTORS.md)).
Still required before deployment: drained v12 rooms and the final owner gate.

## Check

```bash
python3 docs/phase3/check_phase3_accounting.py
```

It also checks progress since the Wave-1 integration: slice and row statuses agree with each other and with the
dispositions, the matrix's totals equal the JSON's, and every recorded ruling is marked in the plan.
