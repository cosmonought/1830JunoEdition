# archive/ — historical documents

These files were moved out of the repository root by the 2026-09-27 context prune.

- Every move was an ordinary `git mv` with the filename unchanged, so `git log --follow archive/<dir>/<file>` shows each file's full history.
- Nothing here is current project state. Start from `PROJECT_CANONICAL_CONTEXT.md` at the repository root.
- Read a file here only when a current document points to it or a provenance question needs it.
- Code comments and `RULES_HARDENING_BACKLOG.md` still cite some of these files by bare filename. The tables below show where each one is now.

## claude-history/ — Claude phase reports (the rules-hardening Batch series)

| File | Was at | Superseded by |
|---|---|---|
| `BATCH1_ENGINE_RELOCATION_2026-09-14.md` | root | Backlog Part A (Stage 1) |
| `BATCH3_OPERATING_AUTHORITY_2026-09-14.md` | root | Backlog Part A (Stage 3) |
| `BATCH4_TRAIN_LIFECYCLE_2026-09-14.md` | root | Backlog Part A (Stage 4) |
| `BATCH4.5_RULES_VERSION_2026-09-14.md` | root | Backlog Part A / E |
| `BATCH4.6_TRAIN_DISCARD_2026-09-14.md` | root | Backlog Part A / E |
| `BATCH5_EMERGENCY_FUNDING_2026-09-14.md` | root | Backlog Part A, D-5 / D-6 |
| `BATCH6_ROUTE_AUTHORITY_2026-09-15.md` | root | Backlog Part A (Stage 6) |
| `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` | root | Backlog Stage 7 (all RESOLVED) |
| `BATCH7.1_MONEY_LEDGER_2026-09-15.md` … `BATCH7.5_REPLAY_VERSION_CLOSURE_2026-09-16.md` (5 files) | root | Backlog Stage 7 / Part E |
| `visual-prototypes/` (14 images, GIFs and an HTML page) | `Claude outputs/` | The VF-2 prototype comparisons cited by `VISUAL_FLOURISH_BACKLOG.md` and `routeSignalGeometry.test.ts` |
| `PROJECT_DOCS_MANIFEST.md` | new | Classifies every claude.ai Project doc and records which ones were removed because git already holds them |

## certification-history/ — audits and completed certifications

| File | Superseded by |
|---|---|
| `AUDIT_PART1_BACKEND.md`, `AUDIT_PART2_FRONTEND.md` (Aug 2026) | Backlog S10-19. The legacy contract was replaced by `contracts/escrow` |
| `AUDIT_RULES_TO_MACHINE_2026-09-13.md` | Backlog Parts A–D (every finding id is carried there) |
| `AUDIT_SETTLEMENT_2026-09-06.md` | The SET-0A/0B/0C and ESCROW-1.5 records (Project) |
| `STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md` | Stage 9 CLOSED (v7), backlog Part B |
| `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md`, `VARIANT_CERT_GENTLE_RUST_CERTIFICATION_2026-09-24.md` | Gentle Rust closed at v9 (Project `gentle-rust-gr5-closure-v9`) |
| `VARIANT_CERT_UNPREDICTABLE_REVENUE_AUDIT_2026-09-24.md`, `VARIANT_CERT_UNPREDICTABLE_REVENUE_CERTIFICATION_2026-09-25.md` | Unpredictable Revenue closed at v10 (Project `ur8-v10-closure`) |

The Delayed Auction audit (`VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md`) is **current** and stays at the root.

## design-history/ — superseded designs, decisions and seed specs

| File | Superseded by |
|---|---|
| `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` | Stage 8 slices landed; backlog Part B / D-29…D-32 |
| `DECISIONS_2026-09-06.md` | Backlog D-12, then the ESCROW-1.5 settlement design (Project) |
| `frontend_blueprint.md` | The session-key gameplay design is superseded (backlog S10-8) |
| `rules.md`, `juno_developer_spec.md`, `cosmwasm_core_reference.md` | The original seed specs, written for the retired on-chain-gameplay design. **`juno_developer_spec.md`'s deploy command (`rust-optimizer:0.15.0`) cannot build today's tree.** Use ESCROW-B2's pins (`PROJECT_CANONICAL_CONTEXT.md` §D) |
| `TECH_DEBT.md` | Its remainder was migrated to backlog Part C, U-7 |

## migration-history/

| File | Superseded by |
|---|---|
| `MIGRATION_PLAN.md` | The client-replay → Node-authority → escrow plan. It was replaced by the LIVE-2/3 and ESCROW-1.5/2/B2/GNOLAND-1 records (Project). Its lowercase "3a/3b/3c" are **not** ESCROW-3A/3B |
