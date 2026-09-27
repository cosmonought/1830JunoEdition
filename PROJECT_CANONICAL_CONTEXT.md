# PROJECT_CANONICAL_CONTEXT — 1830: Juno Edition (18Cosmos)

**Read this file first.** It is the small, current map of the project. It states where things stand, which documents
are the current truth, what must not change, and how work is done here.

**Last updated:** 2026-09-27, by the repository/context prune (Phase 2.5, `68f6baf`) and the follow-up that recorded the roadmap. It builds on DA-8 (`81fd037`).

**Where the documents live.** They are in two places:

- **the repository** — this file, the living ledgers and the archive;
- **the claude.ai Project "18Cosmos_Juno"** — the per-pass Claude reports, under `claude/`.

When this file names a Project document, it writes `Project: claude/<name>`.

> **For future implementation sessions:**
> 1. Read this file first, then the roadmap in `ROADMAP_3_2_REMAINING_WORK.md`.
> 2. Then read only the canonical documents listed in §C for the current phase. For ESCROW-3A, use the reading order in §C.3.
> 3. Do not read the whole of `RULES_HARDENING_BACKLOG.md`: it is 600 KB. Read the Part or item you need.
> 4. Do not recursively read `archive/`, `docs/ai_architecture/` or the Project's historical reports unless the current task requires historical provenance, or a current document points you there.

---

## A. Current project state

**Gameplay authority**
- The TypeScript reducer (`frontend/src/gameEngine/`), run by the Node server (`server/`), is the **only** gameplay authority.
- Rust/CosmWasm is **escrow, notary and settlement only** (`contracts/escrow`).
- The legacy on-chain-gameplay crate (`src/`, `tests/e2e.rs`) is awaiting retirement. See §B.

**Rules engine = v11**
- `RULES_ENGINE_VERSION = 11` (`frontend/src/gameEngine/rulesVersion.ts:65`). The supported versions are derived, so they are `[11]`.
- A v10 game is held `incompatible`. It is never reinterpreted.
- `server/data` was scanned clean with `npm run gamesDoctor -- scan-v10`.

**Phase 1 — hosted authority: CLOSED**
- LIVE-2A…2F and LIVE-3A…3D were certified **GREEN** ("ready for ESCROW-3").
- The certified tree is `0ae252d`. Record: Project `claude/LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md`.

**Phase 2 — Delayed Auction / rules closure: CLOSED**
- DA-8 is `81fd037`, pushed, and equals `origin/main` at the start of this prune.
- Owner gate results:
  - 513 / 513 frontend suites, 9,868 / 9,868 tests;
  - server green, smoke green;
  - production build and security scan green;
  - the v10 historical scan is clean.

**Settlement certification**
- Settlement is certified for **v10 only**: `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS = Object.freeze([10])` (`frontend/src/gameEngine/settlementAppraisal.ts:339`).
- `checkPin` accepts certified pins only. A v11 board is refused with `UNSUPPORTED_RULES_ENGINE_VERSION … (supported: 10)`.
- **v11 settlement is refused until ESCROW-3A explicitly recertifies it.** The procedure is in §B.

**GNOLAND-1 / 1.1: complete; further Gno work parked**
- The chain-neutral escrow backend interface and the Juno regression oracle landed as `b804150`.
- Juno is the only production backend. The Gno codec is a draft whose byte methods throw `NOT_IMPLEMENTED`.
- GNOLAND-2 and later have not started.

**Money games: DISABLED**
- `record.money` is `null` (`record_schema` 1).
- A `create` with a non-zero stake is refused with `money-games-disabled`.
- `NoMoneyRosterSource` refuses money. `EscrowRosterSource.plan` is a stub that refuses ("Money tables are not enabled on this server.").
- Money rooms would get `host_undo: "none"`.

---

## B. Current roadmap

**The canonical roadmap is [`ROADMAP_3_2_REMAINING_WORK.md`](ROADMAP_3_2_REMAINING_WORK.md)** (the owner's ROADMAP 3.2). It holds the phases, their status, their estimates and where each phase's scope is defined.
The owner's brief for each pass sets that pass's exact scope.

```text
Phases 1, 2 and 2.5: COMPLETE
→ 3: ESCROW-3A → ESCROW-3B → ESCROW-4
→ 4: LIVE-4/5/6
→ 5: Junox E2E
→ 6: Rust retirement
→ 7: frontend cleanup
→ 8: production repo extraction
→ 9: UI/UX backlog consolidation
→ 10: UI/UX polish
→ 11: near-production playtest
→ 12: release hardening
```

Gno is parked.

**Next pass: ESCROW-3A.** Its first gate (Project `claude/DA8_RULES_V11_CLOSURE_2026-09-27.md` §10, §17), in order:
1. Rerun the SET-0A audit against the v11 reducer.
2. Build v11 goldens **beside** the v10 ones.
3. Add `11` to `SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS` in its own reviewed change. `da8RulesV11Closure.test.ts` owns that literal.
4. Rerun SET-0B and SET-0C.

DA-8 expects this to be mechanical, because the SYN boards rebuild byte-for-byte under v11 and only the pin differs.

**ESCROW-3 — overall scope.** The roadmap names the split: 3A covers the money-game hosted prerequisites; 3B covers the Juno backend, signing and durable intents. The sources are:
- Project `claude/GNOLAND1_CHAIN_NEUTRAL_ESCROW_INTERFACE_2026-09-26.md` §23:
  - items 1–9: `record_schema: 2` / `EscrowMoney`, deployment and trust policies, the Juno transport, the KMS signer, `SigningJournal`, `EscrowService`, `variantsDigestV1`, `SetupGame.escrow`, and tests;
  - obligations O-1…O-10.
- The 11 ESCROW-3 prerequisites in LIVE-2F/3D §14.
- RUST-RETIRE 2B.4, the config/env rename (`REACT_APP_CONTRACT_ADDRESS`) and the cw2 contract-name check (Project `claude/RUST_RETIREMENT_AUDIT_2026-09-26.md` §10).
- Do not confuse ESCROW-3A/3B with `MIGRATION_PLAN.md`'s lowercase "3a/3b/3c" (legacy, archived), or with "ESCROW-3c" (forfeit/clemency weights, still `REASON_NOT_SUPPORTED`).

**Also note.** "Junox E2E" is called "ESCROW-5" in older docs. The Rust-retirement plan (`claude/RUST_RETIREMENT_AUDIT_2026-09-26.md`) is partly stale:
- the optimizer pin is now settled by ESCROW-B2;
- 2A is done;
- 2B.3 was done in LIVE-2D.

---

## C. Canonical documents — READ THESE

### C.1 In the repository

| Document | What it is |
|---|---|
| `PROJECT_CANONICAL_CONTEXT.md` | This file |
| `ROADMAP_3_2_REMAINING_WORK.md` | **The canonical roadmap:** phases, status, estimates and scope sources |
| `RULES_HARDENING_BACKLOG.md` | The living ledger. Read it by section, never whole. Part B: open rules items. **Part C: the one UI/UX backlog (U-items).** Part D: owner decisions (D-n). Part E: the replay/version ledger |
| `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` | The current Delayed Auction audit, at revision 11 (the DA closure record in the repo) |
| `VISUAL_FLOURISH_BACKLOG.md` | The visual-polish backlog. Only for the UX backlog/polish phase |
| `contracts/escrow/README.md`, `contracts/escrow/gasbench/README.md` | The escrow contract and its gas harness |
| `PLAYTEST_TRANSPORT.md`, `PLAYTEST_NGROK.md`, `start-playtest.ps1` | Runbooks for hosted playtests |
| `archive/claude-history/PROJECT_DOCS_MANIFEST.md` | Classifies every Project doc as current, reference or historical |
| `1830 FULL RULES with variants.pdf` | The rulebook. Rulebook authority is described in the backlog header |

### C.2 In the Project (`claude/…`): current truth

| Topic | Document |
|---|---|
| DA-8 / v11 closure | `claude/DA8_RULES_V11_CLOSURE_2026-09-27.md` |
| Hosted-authority certification (LIVE-2F / 3D) | `claude/LIVE2F_LIVE3D_HOSTED_AUTHORITY_CERTIFICATION_2026-09-27.md` |
| Restore / reconciliation / lifecycle (LIVE-3C) | `claude/live3c-restore-reconciliation-lifecycle-2026-09-27.md` |
| Profiles and identity (LIVE-2E) | `claude/live2e-mandatory-profiles-2026-09-26.md` |
| What landed, with the commit↔patch map (INTEGRATION-1) | `claude/INTEGRATION1_CERTIFIED_PATCH_COLLAPSE_2026-09-26.md` |
| Settlement spec — valuation (SET-0A rev 2, v10) | `claude/SET0A_NET_WORTH_VALUATION_AUDIT_2026-09-25.md` + `claude/SET0A_golden_vectors_2026-09-25.json` |
| Settlement spec — primitives (SET-0B) | `claude/SET0B_SETTLEMENT_PRIMITIVES_2026-09-25.md` |
| Settlement spec — cross-language conformance (SET-0C) | `claude/SET0C_CROSS_LANGUAGE_CONFORMANCE_2026-09-26.md` (§20 supersedes its earlier sections; §17's pin policy is amended by DA-8) |
| Escrow canonical record (artifact gate) | `claude/ESCROW_B2_CANONICAL_ARTIFACT_GATE_2026-09-26.md` + `claude/ESCROW_B2.1_OPTIMIZER_RUST181_COMPAT_2026-09-26.md` |
| Chain-neutral interface (GNOLAND-1) | `claude/GNOLAND1_CHAIN_NEUTRAL_ESCROW_INTERFACE_2026-09-26.md` (§§3, 10–15, 19–23, 26) |
| GNOLAND-1.1 baseline and regression | `claude/GNOLAND1.1_CANONICAL_ESCROW_0006_REGRESSION_2026-09-26.md` |
| Rust-retirement plan and evidence | `claude/RUST_RETIREMENT_AUDIT_2026-09-26.md` (partly stale; see §B) |

**Reference only.** Open these only when a current document points to them:
- `ESCROW_LIVE_RECONCILIATION_2026-09-25.md` (ESCROW-1.5, amended A1–A3: the spec baseline);
- `ESCROW2.1_CORRECTIVE_PASS_2026-09-25.md` and `ESCROW2.2_COMPROMISED_SETTLEMENT_CLOSURE_2026-09-26.md` (trusted_seq, `CompromisedSettlement`);
- `ESCROW_B2_canonical_gas_table_b263277a.md` and `ESCROW_B2_run-b2.ps1` (B2 evidence kit; not in git by design);
- `LIVE2_IDENTITY_ROOM_AUTHORITY_DESIGN_2026-09-25.md` (authz matrix §6, RV rules);
- `LIVE3_COMMIT_PERSISTENCE_RECOVERY_DESIGN_2026-09-25.md` (§15 DynamoDB, §19 escrow seam, §20.3, FI-1…29, §24.2 vocabulary);
- `LIVE_MULTIPLAYER_AWS_ARCHITECTURE_AUDIT_2026-09-25.md` (§25 only);
- `live2d-client-cutover-2026-09-26.md` (cited by `start-playtest.ps1`);
- `GNOLAND0_ESCROW_FEASIBILITY_2026-09-26.md` (only when Gno resumes);
- `rules-reference-layout.md` (UX phase).

Every other Project report is **historical**; see the manifest.

### C.3 ESCROW-3A reading order

1. This file.
2. `DA8_RULES_V11_CLOSURE`: the entry gate and the certified-only ruling.
3. `SET0A_…AUDIT` + `SET0A_golden_vectors…json`: the audit to rerun under v11.
4. `SET0B_…PRIMITIVES`: how the 13 goldens are rebuilt (`settlementGoldenBoards.ts`).
5. `SET0C_…CONFORMANCE` §17, §18, §20.
6. `GNOLAND1_…INTERFACE` §§3, 10–15, 19–23, 26.
7. `LIVE2F_LIVE3D_…` §§4, 9, 14, 16.
8. `INTEGRATION1_…` §§2, 5, 7, 13.
9. `GNOLAND1.1_…` §§6–7, 10.
10. `ESCROW_B2_…` + B2.1 §4–5.
11. `live3c-…` §§7, 8, 10.
12. `live2e-…` §§2–3, 15.

---

## D. Frozen invariants (do not change without the owner's explicit, separately reviewed pass)

**1. Gameplay rules are v11**
- Any change to what a stored log replays to must bump `RULES_ENGINE_VERSION` and add a changelog row.
- Logs are never repinned or rewritten. A game runs only under its deal's pin.

**2. Settlement is certified for v10 only** (`[10]`, see §A). Adding 11 is ESCROW-3A's own reviewed change.

**3. The canonical Juno escrow wasm** is `eighteen_cosmos_escrow.wasm`:
- **SHA-256 `b263277aa5d1d63c33e8e238f27ad2b9ee4749c9a66abe82ef3146d51d119296`**, 526,033 B.
- It is not in git. The owner's copy is at `C:\escrow-b2-r2\out\canonical\`.
- Built from `86b735674de7958830602bb785ae6cecab64b376`, which landed in this checkout as `6796123`.
- Built with `cosmwasm/optimizer:0.16.1@sha256:b9c92b2900b7ebaab3499203615c1b8589592bc557355ed3432e48851ffde69e` and rustc/cargo 1.81.0.
- Rust pins:
  - `contracts/escrow/Cargo.toml` has `rust-version = "1.81"`;
  - `Cargo.lock` pins `base64ct 1.7.3` and `zeroize 1.8.2`. **Never `cargo update` these.**
  - `cosmwasm-std` is 1.5.11.

**4. Settlement bytes are frozen.** They are never regenerated or repinned, and v11 goldens go *beside* them. A change is a certified-byte change and needs its own certification pass.

| File | SHA-256 |
|---|---|
| `contracts/escrow/testdata/payload_vectors_v1.json` | `635024311cb76a2b808a46f31285721c865effbed4ff0eed172a85487d1958ac` |
| `frontend/src/utils/__fixtures__/settlement/settlementPayloadVectorsV1.json` | `b58651de13de2c4f91d355c15cca92689001ba4bcbdb2a9fbaa348cbe6a7906c` |
| `contracts/escrow/testdata/set0a_payout_vectors_rev2.json` | `dfe9fbdfa8f88c21bd5cc8eeecbd06f0ef7db4ce6ba8bf72aa4633b7a39d4994` |
| `frontend/src/utils/__fixtures__/settlement/SET0A_golden_vectors_rev2.derived.json` | `c16fb8170d38a6b6870d0e39091337d82d89fc2a54bb29f41b98cc98a5c7721a` |
| `frontend/src/utils/__fixtures__/settlement/settlementCrossLanguageVectors.json` | `50bf34e1374767df4e3273198cfe6537ba7f73fefd51d9a437b0f113c3015d74` |

- Also frozen: the `contracts/escrow/schema/` tree, and `.gitattributes` `eol=lf` on these paths.
- Guarded by the oracle `frontend/src/utils/escrowJunoRegressionOracle.test.ts`, which must stay green.

**5. TypeScript is the gameplay authority.** No chain response can rewrite gameplay state. `SetupGame.escrow` is declared and ignored by the reducer, so it needs no rules bump.

**6. The blockchain is escrow only:** a vault, a notary and a settlement calculator.

**7. Authority chain:** authenticated profile → principal → durable GameRecord seat → `player_id` → serialized GameActor → append-only committed log → pinned TypeScript rules engine.
- A frame never names an actor. `seatOf(record, principal)` runs inside the actor task.
- `game_id` is the server's `g_…`. `chain_game_id` is the contract's u64. `player_id` (`p-…`) is the same in money and no-money games.
- `pr_`/`pf_`/`se_`/`rk_` ids never go on the wire or on chain.

**8. No seat rebind.** There is no seat copy, transfer or reassignment primitive. `binding_epoch` is carried and never moved. Recovery restores the same principal.

**9. One-step undo.** Only the most recent action can be undone (`revertRefusal`, `logRevert.ts`). Money rooms use `host_undo: "none"`.

**10. Settlement arithmetic and seam**
- Payout = `floor(pool·w_i/Σw)` with a Uint256 intermediate; dust goes to the treasury.
- Weights are whole-VGP u128 in `chain_seat_index` order. No principal or player id appears in any payload byte.
- `SettlementLifecycle.onGameplayClosed` is at-least-once. ESCROW-3 must be idempotent by `(gameId, seal.log_len)` and settle only the prefix up to `seal.log_len`.

**11. Owner-local broad validation.** Claude runs narrow targeted tests only. The owner runs the broad suites and builds locally (§E).

> **Project-instruction drift (known, owner to update).** The claude.ai Project instructions still say two things that ESCROW-1.5 superseded:
> - "fixed-point … scaled to 6 decimal places": settlement weights are **whole-VGP** (ESCROW-1.5 §5.1);
> - the fee comes "from game lobby creation deposits": the contract takes its bps cut on **every** deposit (§14 row 14).
>
> Follow the current records.

---

## E. Standing workflow

- **The owner leads.** The owner rules, sets scope and advances `origin/main`. Claude implements and investigates.
- **One writer in the real checkout** (`C:\Users\Bradshaw\Documents\GitHub\1830Juno`). Concurrent work happens only in isolated clones or branches.
- **Do not push** unless the owner says so.
- **Stop at the phase hard-stop** named in the brief.
- **Claude runs only narrow, targeted tests** (single files or small batches, never in parallel). **Claude never runs full Jest.** The owner runs the broad suites, builds, server tests and smoke locally.
- **End each pass with exact PowerShell owner-validation commands.** Template:

```powershell
cd C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend
$env:CI = "true"
npx react-app-rewired test --watchAll=false <changed test files>   # targeted
npm run typecheck
npm run build
powershell -ExecutionPolicy Bypass -File .\test-summary.ps1         # broad gate (owner only)
cd ..\server
npm run build; npm test; npm run smoke
npm run gamesDoctor -- scan-v10
```

**Device notes (a Linux VM over the Windows checkout)**
- Use `GIT_OPTIONAL_LOCKS=0` / `--no-optional-locks` for read-only git.
- A stale `.git/index.lock` is removed only after delete permission has been granted.
- Each call has a 180 s limit, so the production build is an owner gate.
- The untracked `.claude/` directory is expected.
- About 265 `.git/objects/tmp_obj_*` files are left for owner-run git maintenance. Do not delete them by hand.

**Reports**
- Each pass writes one concise report to the Project as `claude/<PASS>_<DATE>.md`.
- Update `RULES_HARDENING_BACKLOG.md` when rules items change.
- Update this file when the current state, the canonical set or the invariants change.
- Update `ROADMAP_3_2_REMAINING_WORK.md` when a phase closes, is re-scoped or is re-estimated.

---

## F. Where historical material lives

> Older design/certification history is archived and should be consulted only when a current canonical document points
> to it or a historical/provenance question requires it.

- **`archive/`** (repository): superseded root documents, filenames unchanged. `archive/README.md` maps each one.
  - `claude-history/`: the Batch 1–7.5 reports and the VF-2 visual prototypes;
  - `certification-history/`: the `AUDIT_*` files, the Stage 9 audit, and the Gentle Rust / Unpredictable Revenue certifications;
  - `design-history/`: the Stage 8 design, `DECISIONS_2026-09-06`, the original seed specs, `TECH_DEBT`;
  - `migration-history/`: `MIGRATION_PLAN.md`.

  Code comments that name these files by bare filename still resolve there.
- **`docs/ai_architecture/`**: the numbered design-note archive (`<file> #N`). Source comments cite it by path, so it stays in place. Consult an entry only when a code comment points to it.
- **Project historical reports**: every Project doc not listed in §C.2 (see the manifest). They will move into `archive/claude-history/` from a claude.ai data export in a later pass.
- **Git history**: the patch series and every earlier revision. `git log --follow <file>` works across the archive moves.
