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
| Wave 2A + v13 (provisional, current baseline) | `phase3/wave2a-v13-integration` on `96ccb22` (2026-10-04): the accepted W3-K rules v13 (`be1fd10`) merged `--no-ff` (`ed5e69a`), one W2-E test reconciliation (`447e28d`) and one tracking commit. Rules 13, live `[13]`, settlement `[10, 11, 12]` unchanged, v13 settlement certification pending; W2-B unlocked; W2-G unlocked for v13 UI reconciliation; no owner gate; not merged. See the matrix's "Wave-2A v13 integration status" section / `wave2a_v13_integration` in the JSON |
| Phase-4 playtest baseline | TBD — recorded at Phase-3 closure (W3-F) |

## Owner rulings recorded

OD-1, OD-2, OD-7 and OD-12 were ruled on 2026-10-03, during wave 1; OD-9(a) and OD-11 at the safe Wave-2 integration — verbatim in the
plan's §7.3 and `owner_rulings` in the JSON. OD-4, OD-10(a) and OD-17 were ruled by the owner's W3-K rules-v13 brief (2026-10-03),
restated in the same places. Still open: OD-14(a), OD-10(b).

## Rules v13 (W3-K)

`phase3/w3-k-rules-v13` (accepted; integrated on `phase3/wave2a-v13-integration`, 2026-10-04, not merged to main): `RULES_ENGINE_VERSION` 13, live list `[13]`, rules revision 2 —
OD-2, SBS-3, SBS-4 and OD-4. Settlement stays certified for `[10, 11, 12]`; the v13 certification pass is pending
([`V13_SETTLEMENT_CERTIFICATION_VECTORS.md`](V13_SETTLEMENT_CERTIFICATION_VECTORS.md)). The owner's 2026-10-04 rulings 1-5 (only
enough, Brown continuation and intervening actions, M&H accounting, duplicate legs, exact private-funding relevance) are
implemented there. Not deployable alone: W2-A, W2-B with the Auto-Buy correction, a v13-reconciled W2-G, the safe
integration reconciliation, the dedicated settlement certification, drained v12 rooms and the final owner gate.

## Check

```bash
python3 docs/phase3/check_phase3_accounting.py
```

It also checks progress since the Wave-1 integration: slice and row statuses agree with each other and with the
dispositions, the matrix's totals equal the JSON's, and every recorded ruling is marked in the plan.
