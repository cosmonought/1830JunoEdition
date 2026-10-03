# RECON-1A — Pre-COST-2C convergence candidate (2026-10-02)

> **Superseded (same day) by `docs/RECON1_CANONICAL_MIGRATION_CANDIDATE_2026-10-02.md`:** COST-2C `3ab30db` is now merged
> and RECON-1 is complete. This interim record is kept unchanged below for its lineage.

> ## CONVERGENCE MARKER: **COST-2C PENDING INTEGRATION**
>
> This branch (`recon/recon-1-pre-cost2c`) converges every source line RECON-0 had adjudicated **except COST-2C**, which
> had no pushed branch when RECON-1A ran (`git ls-remote origin 'refs/heads/cost/*'`: cost-1, cost-2a, cost-2b only).
> It is NOT the final RECON-1 convergence. Full certification is **PENDING OWNER GATE**.

**Type:** source / IaC / test / docs only. Nothing applied, deployed, or moved on AWS, DNS, Juno, JUNOX or Keplr. `main`
not merged. Nothing saved to the Claude Project. Authoritative manifest: `docs/RECON0_SOURCE_LINEAGE_2026-10-02.md`
(merged here unmodified).

## 1. Lineage

Base `phase5/jx-4c-operator-evidence-iam` `ee14050` (remote head verified unchanged before and after the work). All
merges `git merge --no-ff`; no rebase, squash, cherry-pick or rewrite; `main` not merged.

| Commit | What |
|---|---|
| `d3e09c5` | merge `live6/l6-14w-crlf-test-fix` `04138ea` (L6-14W1; no conflict) |
| `2993fb8` | merge `cost/cost-2b-migration-guards` `161c737` |
| `dfb2254` | merge `cost/cost-2a-host-verifier` `ce77f47` |
| `76db200` | RECON-1A: the frozen-stack authorization gates (C-04), NOT EVALUATED (C-05), X-09 fixtures |
| `ca1b00c` | RECON-1A: W-02 / W-03 / W-04 |
| `7ce1f7b` | RECON-1A: COST-2B guard tests CRLF-neutral (found by a `core.autocrlf=true` clone) |
| `e0f24a3` | merge `recon/recon-0-lineage-audit` `ee88bd3` (adds only its two docs; no source effect) |
| `c03298f` | RECON-1A: independent-review fixes |
| (this) | this record; canonical header (interim) |

## 2. Manual conflict resolutions

- `server/package.json` (2B, 2A): RECON-0 §H token union, each test once; `_comment_test` texts of all lines kept.
- `PROJECT_CANONICAL_CONTEXT.md` (2B, 2A): P5-INT-1's header kept; COST-2B's and COST-2A's headers kept as "Before
  that" entries; both §A bullets kept (COST-2A's "D0" reference corrected).
- `infra/aws/SINGLE_HOST_MIGRATION.md` (2A): COST-2B's post-abandonment runbook is the frame; COST-2A's F0 (coexist
  verify), 15b (post-cutover verify), J24 (judged single-host inventory) and its closing "control plane is verified"
  paragraph re-inserted; **COST-2A's D0 (an ordinary `stacks/app` apply) NOT restored**.
- `infra/aws/README.md` (2A): Terraform test counts unioned (ledger 34, app 69); COST-2A's "apply it before ... step D0"
  rewritten (never an ordinary app apply on the frozen stack).
- `infra/aws/fixtures/README.md` (2A): both paragraphs.
- `server/src/aws/operator/operatorMain.ts` (2A): `known` / `noSubject` / read-only refusal gain `host-snapshot` beside
  `wallet-grants` / `money`; `VALUE_FLAGS` keep `--tx-bytes --attempt --tx-hash` and add `--out`; `--chain` kept.
- Auto-merged and verified: `modules/app/iam.tf` (all six new SIDs), `app.tftest.hcl`, `commands.ts` (`verify
  --topology` + `migration-guard`).

## 3. New gate behaviour (runbook §C2, after §A, before step 8)

- **`migration-guard app-read-authorize`** (7a, `stacks/app`): `run.json` must record exactly
  `-target=module.app.aws_iam_role_policy.bootstrap` and `-target=module.app.aws_iam_role_policy.operator[0]`
  (`plan-evidence.{sh,ps1}` now record `targets`). The bootstrap policy = before + exactly `HostVerifierDescribeUnscopable`,
  `HostVerifierEcsEra`, `HostVerifierHostRole`, `HostVerifierBudgets`; the operator policy = before + exactly
  `IdentityEvidenceRead` and `LedgerJournalQuery`; each statement's effect / actions / resources / conditions pinned and
  proven equal to `modules/app/iam.tf` by a source-parity test. Refused: any other statement change, removal or addition,
  wildcard widening, a partial earlier state, unknown values, any ECS service / task-definition / cluster change (the
  drift, named), table / document / key / edge / other IAM change, `compute != ecs`, break-glass on, an untargeted or
  otherwise-targeted plan. Needs `--region` and `--ledger-table-arn` (cross-checked with the plan's variables). A re-run
  after a partial apply (one policy already final, unchanged) passes; nothing to add fails.
- **`migration-guard ledger-operator-journal`** (7b, `stacks/ledger`): the resource policy gains exactly
  `OperatorJournalQuery` (Query; the ledger; app root principal with `ArnEquals aws:PrincipalArn` = operator role;
  `ATTI#*` + `Null false`), pinned to `modules/ledger/main.tf`; every other statement (runtime / host principals included)
  byte-equal; no KMS key or key-policy change; no table, APPGEN item or Backup change. Needs `--ledger-table-arn`.
- Later gates still refuse a pending grant and now name the step: `ledger-host-authorize` / `ledger-task-deauthorize`
  ("run step 7b first"), `ecs-rollback` / `edge-cutover` / `compute-none` ("run step 7a first; never an ordinary app-stack
  apply"). Every later step's fixture starts from the final post-7a/7b state and passes.
- `migration-guard` output prints `NOT EVALUATED` for COST-2A's third check state (never `SKIP`); verdicts stay
  every-check-PASS.
- `plan-evidence` marks a checkout NOT clean when a single-host embedded file carries a CR (`host_inputs_with_cr`).

**Proven against Terraform itself** (1.16.5, hashicorp/aws 6.66.0, moto 5.2.3; `fixtures/migration-plans/terraform-real/`):
the targeted 7a plan is exactly the two policies and their roles and PASSes; 7b over six keys (relayer-r2 + JX-1K `v2`)
PASSes; a step-8 plan captured before 7b is refused naming 7b; steps 8 and 22 then PASS with all six keys moved; each
judged `stack.tfplan` applied to the mock; a targeted 7a re-plan answered no changes.

## 4. Windows portability (owner-approved W-02 / W-03 / W-04)

- **W-04:** `.gitattributes` pins `eol=lf` for `infra/aws/modules/single-host/files/**`, `.../templates/**`,
  `.../tests/*.sh`, `infra/aws/single-host/*.sh` (blobs were LF already). Tests: inventory, raw-byte no-CR (non-vacuous),
  `.gitattributes` coverage, `git check-attr`. A `core.autocrlf=true` clone was checked: host files LF, other text CRLF.
  Existing clones: `plan-evidence` refuses them until re-cloned / renormalised (runbook prerequisite).
- **W-02:** `cost2aHostVerifier.test.ts` §5 reads via `readCheckoutText`; block / function slices fail closed when their
  delimiter is missing and must be one resource.
- **W-03:** `cost1SingleHost.test.ts` reads every source through `readCheckoutText`.
- `04138ea` is the imported merge, not recreated.
- Also: `cost2bMigrationGuards.test.ts` read fixtures raw (9 false failures on a CRLF clone) — now `readCheckoutText`; its
  bash suite is POSIX-only like every other.

## 5. Targeted validation run here (no full suite)

`server` `tsc` build clean. `node --test`: recon1AuthorizationGates 48/48, cost2bMigrationGuards 155/155, cost1SingleHost
26/26, cost2aHostVerifier 52/52 (PowerShell 7 present), cost2aHostSnapshot 4/4, jx4cOperatorEvidenceIam 6/6,
p5IntCrossSlice 2/2, rotationProof 32/32, awsClients 11/11. `terraform test`: ledger 34, app 69, single-host 20 passed;
`bash tests/host-scripts.test.sh` 43 passed. A `core.autocrlf=true` clone ran the reconciled suites (only POSIX-only bash
suites differ, as Windows skips them).

Not run (owner-run by policy): the full `server` `npm test`, the repository matrix, the DynamoDB Local corpus, any
certification sweep, Windows PowerShell 5.1 (only pwsh 7 on Linux here), `edge-smoke.sh` / `image-smoke.sh` (need Docker).

## 6. Exact remaining COST-2C integration surfaces

When COST-2C pushes its final head, merge it `--no-ff` into this branch and re-check (RECON-0 §F.3):
1. its merge base (expected `7d140b4`, `ce77f47` or `161c737`);
2. `infra/aws/SINGLE_HOST_MIGRATION.md` — keep §0, §C2 (7a / 7b before 8), F0 / 15b / J24, no ordinary app apply before
   compute-none;
3. `server/src/aws/deploy/migration/planGuards.ts` `GATES` / `GATE_TARGETS` / `GATE_NAMES`, `migrationCommands.ts`
   (flags, usage, `STATUS_WORD`), `planFixtures.ts` (`validPlans`, `x09Plans`) and the committed fixtures
   (`migration-plans/*.json`, `x09/`, `terraform-real/`);
4. `infra/aws/modules/app/iam.tf` bootstrap / operator documents (the 7a pins and parity test must still hold) and
   `modules/ledger/main.tf` resource policy (7b);
5. `infra/aws/scripts/plan-evidence.{sh,ps1}` (`targets`, `host_inputs_with_cr`);
6. `server/package.json` `test` / `_comment_test` union (`recon1AuthorizationGates.test.js` once);
7. `infra/aws/README.md`, `infra/aws/fixtures/README.md`, `server/src/aws/deploy/commands.ts` USAGE;
8. `.gitattributes` (if COST-2C adds host files outside the pinned globs);
9. whether COST-2C already resolves RECON-0 F.1 (do not duplicate the 7a / 7b gates);
10. `PROJECT_CANONICAL_CONTEXT.md` — the final RECON-1 header, written last.

## 7. Owner-gate additions for COST-2C's PowerShell owner-gate runner

Not a second runner: add these to COST-2C's canonical script once it is merged.

- Build: `cd server; npm run build`.
- Targeted (fast, run first): `node --test --test-concurrency=1` on
  `dist/server/src/aws/deploy/migration/recon1AuthorizationGates.test.js`,
  `.../migration/cost2bMigrationGuards.test.js`, `dist/server/src/aws/deploy/cost1SingleHost.test.js`,
  `.../cost2aHostVerifier.test.js`, `dist/server/src/aws/operator/cost2aHostSnapshot.test.js`,
  `.../operator/jx4cOperatorEvidenceIam.test.js`, `dist/server/src/aws/runtime/p5IntCrossSlice.test.js`,
  `dist/server/src/aws/deploy/staging/rotationProof.test.js`, `dist/server/src/aws/awsClients.test.js`.
  On Windows the PowerShell twins are exercised (`plan-evidence.ps1` targets / CR record; COST-2A's capture scripts) —
  confirm under Windows PowerShell 5.1, which RECON-1A could not run.
- Terraform: `terraform test` in `infra/aws/modules/ledger` (34), `modules/app` (69), `modules/single-host` (20).
- Checkout hygiene (Windows): `git ls-files --eol infra/aws/modules/single-host infra/aws/single-host` must show `w/lf`
  for every `eol=lf` path; otherwise re-clone or `git rm -r -q --cached infra/aws/modules/single-host; git reset -q --hard`.
- Full: the complete `server` `npm test` (now including `recon1AuthorizationGates.test.js`), `npm run test:dynamodb-local`
  (with the JX-4B entry), and the frontend / contract matrix as the owner gate already defines.

## 8. Independent review

A fresh reviewer inspected the tree for lost functionality, any ordinary app apply before compute-none, blocking IAM
deltas, guard breadth, JX-4C / HostVerifier grants, KMS key sets, package / CLI registration, CRLF hazards, CRLF
false-passes and GO-C / g2 resurrection: none found except one Medium (existing Windows clones keep CRLF host files
while git reports clean) and Lows — all fixed in `c03298f` with regression tests, except two reported-not-changed items:
`infra/aws/scripts/*.sh` stay `text=auto` (operator-side; `.ps1` is the Windows path) and `edge-cutover`'s targets are not
pinned (COST-2B behaviour unchanged; its allowlist refuses the drift).

## 9. Version axes

Unchanged: rules 12, settlement-certified `[10, 11, 12]`, hosted 1, financial 3, client 1, escrow 2.0.0. No `contracts/`,
`frontend/src/gameEngine/` or runtime gameplay change.
