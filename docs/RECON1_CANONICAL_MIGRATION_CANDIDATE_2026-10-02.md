# RECON-1 — The canonical single-host migration candidate (2026-10-02)

**Branch:** `recon/recon-1-pre-cost2c` (kept: no extra reconciliation branch). **Status:** every completed LIVE-6, COST and
Phase-5 source line semantically converged into ONE candidate. Source / IaC / test / docs only: nothing deployed,
applied, or moved on AWS, DNS, CloudFront, Juno, JUNOX or Keplr; `main` not merged; nothing saved to the Claude Project.
**Live AL2023 / systemd certification: NOT EVALUATED** (until the real-host drill). **Comprehensive validation: PENDING
OWNER GATE.** Supersedes the interim `docs/RECON1A_PRE_COST2C_CONVERGENCE_2026-10-02.md` (kept for its record);
RECON-0's audit (`docs/RECON0_SOURCE_LINEAGE_2026-10-02.{md,json}`) is preserved unmodified.

## 1. Lineage (first parent = this branch; every merge `--no-ff`)

| Commit | What |
|---|---|
| `ee14050` | base: JX-4C (contains P5-INT-1, every JX slice, COST-1) |
| `d3e09c5` | merge `04138ea` (L6-14W1) |
| `2993fb8` | merge `161c737` (COST-2B) |
| `dfb2254` | merge `ce77f47` (COST-2A) |
| `76db200`, `ca1b00c`, `7ce1f7b` | RECON-1A: the 7a / 7b gates; W-02 / W-03 / W-04; COST-2B tests CRLF-neutral |
| `e0f24a3` | merge `ee88bd3` (RECON-0 audit docs) |
| `c03298f`, `2943dad` | RECON-1A review fixes; interim record |
| `9c8e696` | merge `3ab30db` (COST-2C: `30c367a` + review fixes `3ab30db`) |
| `0f14ef5` | COST-2C live prerequisites: credential authority, stale-host classification, host-cert LF test |
| `874431d` | the ONE owner gate (COST-2C's runner extended) |
| `0c56438` | final-review fixes |
| (this) | this record; the canonical context |

`ee14050`, `04138ea`, `161c737`, `ce77f47` and `3ab30db` are all ancestors of the head (`git merge-base --is-ancestor`).

## 2. Manual conflict resolutions

- RECON-1A (see its record): `server/package.json`, `operatorMain.ts`, the runbook (COST-2B frame + COST-2A F0 / 15b / J24,
  D0 removed), `infra/aws/README.md`, `infra/aws/fixtures/README.md`, the canonical context.
- COST-2C merge: `server/package.json` (token union: `hostcert/hostCert.test.js` and
  `conformance/hostCertLock.dynamoLocal.test.js` once each; COST-2C's `_comment_test` inserted after COST-2B's);
  `deploy/commands.ts` USAGE (the `host-cert` line AND the `migration-guard` line with the two RECON gates);
  `PROJECT_CANONICAL_CONTEXT.md`. `SINGLE_HOST_MIGRATION.md` auto-merged and was checked: the reconciled frame intact,
  COST-2C's F7 / F8 / F9 / F10 rows, drill section and OPEN AL2023 row added. `awsClients.test.ts`,
  `l6_6StagingCert.test.ts`, `tools/awsDeploy.ts`, `.gitignore` auto-merged (identical to COST-2C's patch).

## 3. The authorization gates (RECON-1A, runbook §C2, after §A, before step 8)

`migration-guard app-read-authorize` (7a; a TARGETED app plan -- `run.json` records exactly the two `-target`s; bootstrap +
exactly COST-2A's four `HostVerifier*`, operator + exactly JX-4C's `IdentityEvidenceRead` / `LedgerJournalQuery`, pinned
to `iam.tf`; nothing else) and `migration-guard ledger-operator-journal` (7b; exactly `OperatorJournalQuery`). No ordinary
app-stack apply before compute-none, for any reason. Proven against Terraform-made plans (moto). Details: RECON-1A record §3.

## 4. COST-2C integration

All of `3ab30db` is in; `controlPlane`, `drillLock`, `hostCertTestSupport`, `hostOps`, `hostState`, `scenarios`,
`transport`, `verdict` and the DynamoDB Local lock test are byte-identical to it. Its safety properties are unchanged:
every certification `gs-deploy` passes `deployGate`; a HOLD the drill did not cause / prove is never cleared; a failed
Docker read is UNKNOWN; no mutation after the lock is lost; no `gs-deploy` while the rival might exist; the live brand is
private to the production transport; test support cannot forge production evidence. The AL2023 / systemd contract stays
**OPEN -- NOT EVALUATED**; no offline test can PASS it. The only COST-2C code RECON-1 changed is the transport's credential
binding (§5): `awsCliTransport.ts`, `commands.ts`, `tools/awsDeploy.ts`.

## 5. Host-cert credential authority — disposition

**Two existing principals; no new IAM.** The host transport (AWS CLI: `ssm send-command` `AWS-RunShellScript` on one
instance, `ssm get-command-invocation`, `ec2 describe-instances` / `describe-addresses`, `ecs list-tasks`) runs ONLY under
the required `--host-transport-profile`: the host-deploy principal that already runs `gs-host deploy` (its SSM authority
since COST-1). The child process inherits no credential variable (static, profile, container, web-identity) and runs with
`AWS_EC2_METADATA_DISABLED=true`: a profile without credentials fails, never borrows another principal. The control plane
(SDK reads, the `OPRUN#host-cert` lock) stays on the operator role, unchanged -- no SSM / EC2 / ECS / KMS / IAM authority
added to it; no module role holds SSM Run Command. Why: SSM Run Command on the host is root on the host (the host role's
KMS Sign and money writes); an operator grant or a new role would create a second principal with that power plus new
app / ledger IAM deltas on the frozen stacks. Optional owner hardening (outside Terraform, never applied here) is in the
runbook. Pinned by `hostCert.test.ts` and `recon1AuthorizationGates.test.ts`.

## 6. Stale-host proof — disposition

**Classified NOT EVALUATED** for the final topology: destroy-before-create on the one ENI leaves no old host, and keeping
one would be a second instance carrying the host role. COST-2C's check is unchanged (NOT EVALUATED without a reachable
stale host; FAIL for a running undeclared old host); ordinary replacement is never called proof of it. Still certified:
offline -- `gs-preflight`'s EIP and duplicate refusals (`host-scripts.test.sh`), the one-ENI shape, `host-create`; live --
F9b fencing (`duplicate-fence`), `replacement-after`'s one-host / EIP / epoch checks, J 24's inventory. Owner decision
recorded, not taken: a replacement certification therefore ends NOT EVALUATED on exactly that one check.

## 7. Windows portability

W-02 / W-03 / W-04 in force (RECON-1A); 04138ea kept. COST-2C adds no Linux-executed file outside the pinned globs; its
host scripts are TypeScript `String.raw` templates -- a `core.autocrlf=true` clone (hostOps.ts CRLF on disk) still sends
LF scripts (cost1SingleHost.test). plan-evidence refuses a checkout whose host files carry CR; the owner gate's first gate
checks the working tree.

## 8. The owner gate (ONE runner)

`infra/aws/single-host/run-cost2c-owner-gate.ps1`, run ONCE by the owner from a clean clone of this branch:

```
powershell -ExecutionPolicy Bypass -File .\infra\aws\single-host\run-cost2c-owner-gate.ps1
```

Gates, in order: Windows LF checkout; Build; RECON-1 authorization gates (its PowerShell test must run on Windows);
COST-2B migration guards; COST-2C targeted (no skip allowed); COST-2A verifier / snapshot; JX-4C / P5 cross-slice;
ownership / fencing; awsDeploy / stage-cert (incl. rotationProof / 04138ea); COST-1 + portability; Terraform (fmt, module
tests app 69 / ledger 34 / single-host 20, stack validate); host scripts; DynamoDB Local (JX-4B, hostCertLock); the full
server `npm test` LAST. One log + JSON under `evidence\owner-gates\`; exit 1 on any non-PASS.

## 9. Validation run here (targeted only)

`tsc` build clean. `node --test`: hostCert 90, recon1AuthorizationGates 53, cost2bMigrationGuards 155, cost1SingleHost 27,
cost2aHostVerifier 52 (pwsh 7 present), cost2aHostSnapshot 4, jx4cOperatorEvidenceIam 6, p5IntCrossSlice 2,
rotationProof 32, awsClients 11, l6_6StagingCert 135 -- all pass. `terraform test`: app 69, ledger 34, single-host 20.
`host-scripts.test.sh` 43. A `core.autocrlf=true` clone ran cost1SingleHost, hostCert, recon1 and cost2b (only the
POSIX-only bash suites differ, as Windows skips them). The owner gate script parsed (0 errors) and its LF gate was run alone,
positive and negative.

**Deferred to the owner gate (not run here, by policy):** the full server `npm test`, the DynamoDB Local corpus (incl.
`hostCertLock` and JX-4B), the full owner sweep, Windows PowerShell 5.1, Git Bash runs on Windows, Docker smokes.

## 10. Final adversarial review

One fresh review: no High / Medium. Lows fixed in `0c56438` (credential fall-through variables, `-ExecutionPolicy Bypass`,
a stale comment, the gs-health Run Command principal in F0 / README). Reported, unchanged: no test executes
`capture-nat-evidence.ps1` (pre-existing; COST-2B's bash suite is POSIX-only); the transport records the profile name, not
a resolved identity (no STS call by design).
