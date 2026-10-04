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
| [`archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md`](archive/PHASE3_EXECUTION_MAP_DRAFT_2026-10-03.md) | The superseded parallel draft, kept for provenance only |

## Pins

| | |
|---|---|
| Planning snapshot (source facts) | `8e897f9c5196f825a69c492dfb7c29088123cf67` (`recon/phase1-remainder-hardening`) |
| Audit's own base | `7b1a956b1eeef31ad17ec6b08b475c4649747f6a` (`live6/live-closure-candidate-w1`); production `frontend/src` identical to the snapshot's |
| **Phase-3 implementation base** | **TBD — pin the final canonical integrated head after Phase 2 closes (OD-0 / P0). Record the full SHA here.** |
| Phase-4 playtest baseline | TBD — recorded at Phase-3 closure (W3-F) |

## Check

```bash
python3 docs/phase3/check_phase3_accounting.py
```
