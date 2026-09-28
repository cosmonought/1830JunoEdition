# claude.ai Project "18Cosmos_Juno" — document manifest (2026-09-27)

Before the prune the Project held **146** docs (`claude/…`, 1,790,534 B of a 2,000,000 B knowledge cap). This manifest sorts them into four classes:

- **CURRENT**: canonical, current truth (also listed in `PROJECT_CANONICAL_CONTEXT.md` §C.2).
- **REFERENCE**: still valid in part. Open one only when a current doc points to it.
- **HISTORICAL**: a completed pass whose conclusions have been carried into current records. It stays in the Project until it is migrated. Do not load it for current work.
- **REMOVED**: deleted from the Project on 2026-09-27 because git already holds its content (location given).

**Migration plan for HISTORICAL docs (later pass):**
1. Take a claude.ai data export.
2. Copy each HISTORICAL doc byte-for-byte into `archive/claude-history/project/`.
3. Commit.
4. Only then delete it from the Project.

No Project-only doc was transcribed or deleted in this pass.

## CURRENT (15)

| Doc | Role |
|---|---|
| `ESCROW3A_MONEY_GAME_PREREQUISITES_2026-09-27.md` | Phase 3A: v11 settlement certified [10, 11]; the money-game lifecycle, seam, continuation, tickets, identity hardening, operator path; ESCROW-3B inputs (§19) |
| `DA8_RULES_V11_CLOSURE_2026-09-27.md` | Phase 2 closure; v11; certified-only settlement ruling; the ESCROW-3A entry gate |
| `LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md` | Phase 1 hosted-authority certification (`0ae252d`); the 11 ESCROW-3 prerequisites |
| `live3c-restore-reconciliation-lifecycle-2026-09-27.md` | Restore/reconcile, lifecycle and seal, the settlement seam |
| `live2e-mandatory-profiles-2026-09-26.md` | Profile/principal identity; no seat rebind |
| `INTEGRATION1_CERTIFIED_PATCH_COLLAPSE_2026-09-26.md` | What landed; commit ↔ patch map; frozen hashes |
| `SET0A_NET_WORTH_VALUATION_AUDIT_2026-09-25.md` | Settlement valuation spec (rev 2, v10); to be rerun for v11 |
| `SET0A_golden_vectors_2026-09-25.json` | SET-0A recipes. The canonical board texts exist only here (git holds the derived fixture) |
| `SET0B_SETTLEMENT_PRIMITIVES_2026-09-25.md` | Settlement primitives and golden rebuild |
| `SET0C_CROSS_LANGUAGE_CONFORMANCE_2026-09-26.md` | Builder rules, vector pins, ESCROW-3 obligations |
| `ESCROW_B2_CANONICAL_ARTIFACT_GATE_2026-09-26.md` | The canonical wasm `b263277a…` and optimizer pins |
| `ESCROW_B2.1_OPTIMIZER_RUST181_COMPAT_2026-09-26.md` | The Rust 1.81 / lock pins |
| `GNOLAND1_CHAIN_NEUTRAL_ESCROW_INTERFACE_2026-09-26.md` | The interface ESCROW-3 implements (§19–23, O-1…O-10) |
| `GNOLAND1.1_CANONICAL_ESCROW_0006_REGRESSION_2026-09-26.md` | GNOLAND baseline; `code_checksums` pin; oracle requirement |
| `RUST_RETIREMENT_AUDIT_2026-09-26.md` | The Rust-retirement plan (partly stale; see the canonical context §B) |

## REFERENCE (11)

| Doc | When to open |
|---|---|
| `ESCROW_LIVE_RECONCILIATION_2026-09-25.md` | The ESCROW-1.5 spec baseline (amended A1–A3); payload/domain/state-machine rationale |
| `ESCROW2.1_CORRECTIVE_PASS_2026-09-25.md` | trusted_seq ANNUL, SETTLEABLE liveness |
| `ESCROW2.2_COMPROMISED_SETTLEMENT_CLOSURE_2026-09-26.md` | `CompromisedSettlement` |
| `ESCROW_B2_canonical_gas_table_b263277a.md` | B2 gas evidence. Not in git by design (INTEGRATION-1 §12B) |
| `ESCROW_B2_run-b2.ps1` | The B2 reproduction kit. Not in git by design |
| `LIVE2_IDENTITY_ROOM_AUTHORITY_DESIGN_2026-09-25.md` | Authz matrix §6, RV rules, limits. Its §10 is superseded by LIVE-2E |
| `LIVE3_COMMIT_PERSISTENCE_RECOVERY_DESIGN_2026-09-25.md` | §15 DynamoDB, §19 escrow seam, §20.3, FI-1…29 (LIVE-5), §24.2 vocabulary |
| `LIVE_MULTIPLAYER_AWS_ARCHITECTURE_AUDIT_2026-09-25.md` | **§25 only**: the only definition of LIVE-4/5/6 |
| `live2d-client-cutover-2026-09-26.md` | Cited by `start-playtest.ps1` |
| `GNOLAND0_ESCROW_FEASIBILITY_2026-09-26.md` | Only when the Gno track resumes (OD-GNO-1…5) |
| `rules-reference-layout.md` | UX backlog/polish phase (Rules Reference layout) |

## HISTORICAL (96)

These are Project-only and not yet in git. Migrate them from an export.

**ESCROW / SET / RUST**
- `escrow1-attestation-settlement-architecture-audit-2026-09-25.md`
- `ESCROW2_CONTRACT_IMPLEMENTATION_2026-09-25.md`
- `ESCROW2_PREDEPLOYMENT_WASM_GAS_GATE_2026-09-26.md`
- `ESCROW2.3_STORAGE_WASM_COMPATIBILITY_2026-09-26.md`
- `rust-retire-2a-harvest-2026-09-26.md`
- `rust-cash-neutrality-audit-2026-09-22.md`

**LIVE**
- `live0-hosted-playtest-hygiene-2026-09-25.md`
- `live2a-ingress-hardening-2026-09-26.md`
- `live2b-identity-sessions-2026-09-26.md`
- `live2c-server-room-authority-2026-09-26.md`
- `live3a-actor-commit-pipeline-2026-09-25.md`
- `live3b-hardened-local-store-2026-09-25.md`

**Delayed Auction**
- `da3-authority-gates-2026-09-25.md`
- `da4-seating-priority-deal-2026-09-25.md`
- `da5-private-consequences-2026-09-25.md`
- `DA6_RR2A_F1_AUTHORITY_UI_CLOSURE_2026-09-27.md`
- `DA7_DELAYED_AUCTION_CERTIFICATION_2026-09-27.md`

**Unpredictable Revenue**
- `variant-cert-1b-unpredictable-revenue-audit-2026-09-24.md`
- `ur3-yellow-sign-authority-2026-09-24.md`
- `od-ur-10-rounding-ties-10c-2026-09-24.md`
- `od-ur-5-6-rulings-ur3-complete-2026-09-24.md`
- `ur4-blood-price-2026-09-25.md`
- `ur4-independent-review-2026-09-25.md`
- `ur5-statistics-2026-09-25.md`
- `ur6-ui-copy-parity-2026-09-25.md`
- `ur7-certification-2026-09-25.md`
- `ur8-v10-closure-2026-09-25.md`

**Gentle Rust**
- `variant-cert-1a-gentle-rust-audit-2026-09-23.md`
- `gentle-rust-gr1-grace-turn-2026-09-23.md`
- `gentle-rust-gr2-transaction-locks-2026-09-23.md`
- `gentle-rust-gr3-ui-parity-2026-09-24.md`
- `gentle-rust-gr4-certification-2026-09-24.md`
- `gentle-rust-gr5-closure-v9-2026-09-24.md`
- `dt1-diesel-exchange-autoskip-2026-09-23.md`

**Stage 10**
- `stage10-orientation-plan-2026-09-22.md`
- `stage10.1-laytile-authority-2026-09-22.md`
- `stage10.2-refusal-transport-2026-09-22.md`
- `stage10.3-composition-coupling-2026-09-22.md`
- `stage10.3b-chart-core-atomicity-2026-09-22.md`
- `stage10.4-harness-hardening-2026-09-23.md`
- `stage10.5-type-wire-2026-09-23.md`
- `stage10.6-laytile-closure-STOPPED-2026-09-23.md`
- `stage10.6-laytile-closure-2026-09-23.md`
- `stage10-closure-v8-2026-09-23.md`

**Stage 9**
- `stage9.2-board-topology-authority-2026-09-18.md`
- `stage9.2-vf5-i15-legality-audit-2026-09-18.md`
- `stage9.3-separation-supply-identity-2026-09-18.md`
- `stage9.3-s921-production-use-check-2026-09-18.md`
- `stage9.3-commit-2026-09-18.md`

**Stage 8**
- `stage8.1-operating-queue-authority-2026-09-16.md`
- `stage8.2-home-station-authority-2026-09-16.md`
- `stage8.5-closure-2026-09-17.md`

**Batch summaries (Project-only condensed versions; the full write-ups are in `archive/claude-history/`)**
- `batch3-operating-authority-2026-09-14.md`
- `batch4-train-lifecycle-2026-09-14.md`
- `batch4.5-rules-version-2026-09-14.md`
- `batch4.6-train-discard-2026-09-14.md`
- `batch5-emergency-funding-2026-09-14.md`
- `batch7.4-opus-matrix-review-2026-09-15.md`
- `batch7.4-r74b-o1-repair-2026-09-15.md`
- `batch7.4-opus-final-verification-2026-09-16.md`

**Modal / dialog work**
- `modal-audit-2026-09-18.md`
- `modal-batch0-dialog-dismissal-2026-09-18.md`
- `modal-batch1-lobby-cards-2026-09-18.md`
- `modal-batch2-settings-dialogs-2026-09-18.md`
- `modal-batch3-game-modals-2026-09-18.md`
- `modal-batch4a-notice-modals-2026-09-18.md`
- `modal-batch4b-stopped-2026-09-18.md`
- `modal-batch6a-wallet-dialog-2026-09-18.md`
- `modal-batch6bi-tutorial-notice-2026-09-18.md`
- `modal-batch7a-portal-foundation-2026-09-18.md`
- `modal-native-dialog-2026-09-18.md`
- `modal-native-dialog-step3-2026-09-18.md`
- `modal-project-closure-2026-09-18.md`
- `modal-closure-correction-2026-09-18.md`
- `host-dialog-escape-2026-09-18.md`
- `host-dialog-focus-2026-09-18.md`

**Visual polish / flourish**
- `visual-polish-batch1-share-transfer-2026-09-15.md`
- `visual-polish-vf5-tile-transition-2026-09-15.md`
- `vf4-phase-badge-flip-2026-09-21.md`
- `vf5-railroad-work-sequencing-2026-09-18.md`
- `vf6-bank-break-ticket-2026-09-21.md`
- `vf7-rust-flourish-2026-09-21.md`
- `vf8-train-discard-flourish-2026-09-21.md`
- `warning-mark-pass-2026-09-21.md`
- `flourish-audio-wiring-2026-09-22.md`
- `intro-variant-editorial-timing-2026-09-22.md`

**UI shell**
- `lobby-public-rooms-2026-09-16.md`
- `waiting-room-layout-2026-09-16.md`
- `host-game-selection-logos-2026-09-16.md`
- `host-radio-groups-2026-09-16.md`
- `border-shorthand-longhand-audit-2026-09-16.md`
- `app-scaling-audit-2026-09-17.md`
- `app-scaling-neutral-default-2026-09-17.md`
- `tab-utility-accent-2026-09-17.md`
- `railmap-wheel-zoom-2026-09-17.md`
- `pinch-zoom-restriction-2026-09-17.md`

## REMOVED from the Project on 2026-09-27 (25): content already in git

Evidence for each removal was checked read-only against git. For reports, at least 10 distinctive lines sampled from start to end, plus the full ordered `##` heading list, were all found in one git revision. For patches, the patch SHA-256 equals the commit's `Integrated-patch-sha256` trailer, and the post-image blobs equal the patch `index` hashes.

| Project doc | In git at |
|---|---|
| `batch1-engine-relocation-2026-09-14.md` | `BATCH1_ENGINE_RELOCATION_2026-09-14.md` @ `6e600f7` (= its last blob; now `archive/claude-history/`) |
| `batch6-route-authority-2026-09-15.md` | `BATCH6_ROUTE_AUTHORITY_2026-09-15.md` @ `215eb29` (now `archive/claude-history/`) |
| `batch7-transaction-authority-design-2026-09-15.md` | `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` @ `50c735c` (now `archive/claude-history/`) |
| `batch7.1-money-ledger-2026-09-15.md` | `BATCH7.1_MONEY_LEDGER_2026-09-15.md` @ `08a59ec` (now `archive/claude-history/`) |
| `batch7.2-stock-authority-2026-09-15.md` | `BATCH7.2_STOCK_AUTHORITY_2026-09-15.md` @ `a927e5f` (now `archive/claude-history/`) |
| `batch7.3-auction-authority-2026-09-15.md` | `BATCH7.3_AUCTION_AUTHORITY_2026-09-15.md` @ `d0a0792` (now `archive/claude-history/`) |
| `batch7.4-pending-offers-2026-09-15.md` | `BATCH7.4_PENDING_OFFERS_2026-09-15.md` @ `6ecdfb1` (now `archive/claude-history/`) |
| `batch7.5-replay-version-closure-2026-09-16.md` | `BATCH7.5_REPLAY_VERSION_CLOSURE_2026-09-16.md` @ `47d1b7a` (now `archive/claude-history/`) |
| `stage8-authority-design-2026-09-16.md` | `STAGE8_AUTHORITY_DESIGN_2026-09-16.md` @ `05b5dfc` (an older revision; now `archive/design-history/`) |
| `rules-hardening-backlog.md` | `RULES_HARDENING_BACKLOG.md` @ `05b5dfc` (the 2026-09-16 snapshot; the live ledger is at the root) |
| `visual-flourish-backlog.md` | `VISUAL_FLOURISH_BACKLOG.md` @ `824a9b4`. Every line matches except the Project copy's one-line "Mirror of …" banner |
| `variant-cert-1c-delayed-auction-audit-2026-09-25.md` | `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` @ `387ade9` (an older revision; current at the root) |
| `ESCROW2_0001-Implement-settlement-escrow-contract.patch` | commit `e70fa82` |
| `ESCROW2_0002-Close-escrow-liveness-and-compromise-recovery-gaps.patch` | commit `f1ceef3` |
| `ESCROW2_0003-Prevent-payout-from-compromised-settlements.patch` | commit `7fdc5ea` |
| `ESCROW2_0004-Add-escrow-predeployment-gas-harness-and-gate-notes.patch` | commit `0aa8614` (the README row differs as expected, INTEGRATION-1 §7) |
| `ESCROW2_0005-Reduce-escrow-wasm-deserializer-complexity.patch` | commit `38700e6` (same expected README difference) |
| `ESCROW2_0006-Make-escrow-build-with-the-optimizer-s-Rust-1.81.patch` | commit `6796123` (same expected README difference) |
| `SET0B_0001-Add-canonical-settlement-appraisal-primitives.patch` | commit `910661a` |
| `SET0C_0001-Add-cross-language-settlement-conformance.patch` | commit `036fc64` |
| `SET0C_0002-Pin-Rust-settlement-conformance-vectors.patch` | commit `f137355` |
| `RUST_RETIRE_2A_0001-Harvest-legacy-Rust-certification-coverage.patch` | commit `1f5b964` |
| `RUST_RETIRE_2A_0002-Harvest-legacy-Rust-escrow-join-coverage.patch` | commit `43e723f` |
| `GNOLAND1.1_0001-Add-chain-neutral-escrow-backend-interface-and-Juno-oracle.patch` | commit `b804150` |
| `GNOLAND1_0001-Add-chain-neutral-escrow-backend-interface-and-Juno-oracle.patch` | Superseded by GNOLAND1.1_0001: an identical diff except for the `From` line, content at `b804150`. Its sha `52f38539…` is recorded in INTEGRATION-1 §12B |

**Kept although a repo counterpart exists:**
- `SET0A_golden_vectors_2026-09-25.json`: git holds only the derived fixture, not the canonical board texts.
- The five batch3–5 Project summaries: condensed versions whose text is not in git.
- `variant-cert-1a` / `1b`, `gentle-rust-gr4`, `ur7`, `stage9.2` ×2: separate session reports, not copies.
