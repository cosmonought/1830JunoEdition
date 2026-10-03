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
| `42ad473` | this record; the canonical context (the head of the FIRST owner run, §11) |
| (this) | the owner-gate correction (§8, §11): dependency bootstrap, Linux host scripts, image smoke |

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
**Superseded in one point by the RECON-1 7A HOTFIX (§13):** on the accepted pre-COST-1 state 7a's targets must also
carry Terraform's required COST-1 move closure; the two policies stay the only mutations.

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

Gates, in order: Windows LF checkout; **Dependencies** (`npm ci --ignore-scripts --no-audit --no-fund` in `frontend`
then `server`, from their lock files; FAIL on an npm failure, a changed lock file, or any tracked / unignored file changed;
every later gate needing dependencies is then BLOCKED -- never run over stale `node_modules`); Build; RECON-1 authorization
gates (its PowerShell test must run on Windows); COST-2B migration guards; COST-2C targeted (Windows, Git Bash; no skip
allowed); **COST-2C targeted (Linux)** (the same suite in the pinned `node:22-bookworm-slim` image, repository read-only,
`--network none`; no skip allowed); COST-2A verifier / snapshot; JX-4C / P5 cross-slice; ownership / fencing; awsDeploy /
stage-cert (incl. rotationProof / 04138ea); COST-1 + portability; Terraform (fmt, module tests app 69 / ledger 34 /
single-host 20, stack validate); **Single-host scripts** (the COMPLETE `host-scripts.test.sh` in a pinned, ephemeral
`amazonlinux:2023` container, repository read-only, no credential; dnf adds only `util-linux-core` / `findutils`; >= 40
passed and 0 failed required; a container that cannot be prepared is NOT RUN); **Image smoke** (`docker buildx build
--load` of `game-server.Dockerfile` to a LOCAL disposable tag per platform -- no `--push`, no ECR login, not
`build-image.{sh,ps1}` -- then the unchanged `image-smoke.sh` from a pinned `docker:27-cli` runner; the gate's own images
and containers are removed). **Since OWNER-GATE FIX 1 (§12):** linux/amd64 is built, architecture-proven and runtime-smoked
(>= 7 passed, 0 failed: REQUIRED); linux/arm64 is built and architecture-proven WITHOUT execution (image metadata + the
image's node an AArch64 ELF), and its runtime smoke is a separate gate -- PASS only where the machine executes arm64,
otherwise DEFERRED TO REQUIRED LIVE GRAVITON GATE (never PASS); DynamoDB Local (JX-4B, hostCertLock); the full server
`npm test` LAST. One log + JSON (with the pinned image digests, the lock-file hashes and the per-suite totals) under
`evidence\owner-gates\`. The summary is OWNER SOURCE GATE PASS / FAIL and LIVE HOST CERTIFICATION PENDING; exit 1 unless
the source gate passed. Prerequisites: Node/npm, Git for Windows, Terraform >= 1.10, Docker Desktop (Linux engine, buildx;
no arm64 emulation needed) with network access to `public.ecr.aws`, the npm registry and the Amazon Linux repositories.

**COST-2C's bash disposition.** The targeted suite's bash templates ask only for `bash -n`, `base64`, `sha256sum`,
`timeout`, `nohup`, `mktemp`, `sed` / `grep` against stub `docker` / `systemctl` / `curl` / `journalctl` -- no `flock`, no
Python -- so Git Bash suffices and the Windows run (with its PowerShell checks) is kept unchanged; the Linux run is
ADDED so the host semantics also run in Linux. A skip in either FAILS.

## 9. Validation run here (targeted only)

`tsc` build clean. `node --test`: hostCert 90, recon1AuthorizationGates 53, cost2bMigrationGuards 155, cost1SingleHost 27,
cost2aHostVerifier 52 (pwsh 7 present), cost2aHostSnapshot 4, jx4cOperatorEvidenceIam 6, p5IntCrossSlice 2,
rotationProof 32, awsClients 11, l6_6StagingCert 135 -- all pass. `terraform test`: app 69, ledger 34, single-host 20.
`host-scripts.test.sh` 43. A `core.autocrlf=true` clone ran cost1SingleHost, hostCert, recon1 and cost2b (only the
POSIX-only bash suites differ, as Windows skips them). The owner gate script parsed (0 errors) and its LF gate was run alone,
positive and negative.

**Owner-gate correction, checked here (mechanics only):** pwsh 7 parse 0 errors; `-ListOnly`; Dependencies on a fresh
clone PASS (then Build PASS), a package.json dependency missing from the lock -> npm ci FAIL and Build / the next gates
BLOCKED, a fake npm that touches tracked files -> FAIL naming them; COST-2C targeted (Linux) PASS (90 pass, 0 skipped);
Single-host scripts NOT RUN (exit 97, no repository access for dnf from this sandbox's container) and, with this sandbox's
proxy CA / network added to a throw-away copy of the runner only, PASS 43 / 0; Image smoke via a throw-away copy (same
sandbox additions): linux/amd64 7 / 0, linux/arm64 NOT RUN (no emulation here) -> the gate NOT RUN, and a broken Dockerfile
path -> FAIL (a FAIL outranks a NOT RUN); a CRLF copy of the Dockerfile parses (`buildx build --check`). No container or
image left behind; the repository unchanged by every run. `recon1AuthorizationGates` pins the order and the new gates.

**Deferred to the owner gate (not run here, by policy):** the full server `npm test`, the DynamoDB Local corpus (incl.
`hostCertLock` and JX-4B), the full owner sweep, Windows PowerShell 5.1, Git Bash runs on Windows, Docker smokes.

## 10. Final adversarial review

One fresh review: no High / Medium. Lows fixed in `0c56438` (credential fall-through variables, `-ExecutionPolicy Bypass`,
a stale comment, the gs-health Run Command principal in F0 / README). Reported, unchanged: no test executes
`capture-nat-evidence.ps1` (pre-existing; COST-2B's bash suite is POSIX-only); the transport records the profile name, not
a resolved identity (no STS call by design).

## 11. The first owner run (at `42ad473`) -- recorded, NOT a certification

Windows PowerShell 5.1.26100.9168, branch `recon/recon-1-pre-cost2c`, HEAD `42ad473c083721c66eb289a6b4afbf216cb732db`,
clean tree; OVERALL FAIL. It does **not** certify the candidate. It **does** establish: the exact head and a clean tree;
that real Windows PowerShell 5.1 launches and executes the runner; W-04 LF checkout PASS under `core.autocrlf=true`;
Terraform PASS on the owner's machine (fmt; modules single-host 20/20, app 69/69, ledger 34/34; the three stacks validate).
It does **not** establish a host-script source failure: `host-scripts.test.sh` ran under Git Bash (32 pass / 11 fail on
`flock: command not found` and a missing Python) -- a userspace the production AL2023 scripts do not target. It establishes
**no result** for any build-dependent suite: Build was NOT RUN (no `node_modules` in the clean clone), so every such gate
was BLOCKED; none of them is a PASS, then or now. The image smoke was not in that runner's manifest at all. The harness
defects (no dependency bootstrap, the wrong userspace for the host scripts, the missing image-smoke gate) are corrected in
this branch's next commit (§8); runtime / IaC source is byte-identical to `42ad473`. **Comprehensive validation: PENDING
OWNER GATE** (the whole runner, rerun once at the new head).

## 12. The first COMPREHENSIVE owner run (at `254cfe7`) -- FAIL, recorded as history -- and OWNER-GATE FIX 1

Windows PowerShell 5.1.26100.9168, branch `recon/recon-1-pre-cost2c`, HEAD `254cfe748f8332ca782a12921eb5556f281139f5`,
clean tree, 2026-10-03T04:05:55Z-04:17:03Z (`evidence\owner-gates\recon1-owner-gate-20261003-040555.{log,json}`, ignored):
**OVERALL FAIL. HEAD `254cfe7` FAILED comprehensive owner certification.** Every other gate passed (dependencies, build,
RECON-1, COST-2B, COST-2C Linux 90/90, COST-2A, JX-4C / P5, ownership / fencing, awsDeploy / stage-cert, COST-1,
Terraform, single-host scripts in AL2023 43/0, DynamoDB Local), but three findings stand:

1. **Windows COST-2C harness: 1 failure** (89 pass / 1 fail / 0 skipped) -- "observe: the real template's output parses
   into a state": instance id `unknown`, expected `i-0123456789abcdef0`. Cause (reproduced, harness-only): Git for
   Windows' `bin\bash.exe` launcher PREPENDS `/mingw64/bin` and `/usr/bin` to the PATH it is given, so Git's real curl
   shadowed the test's stub curl; the stub was never called. Linux keeps the PATH order (90/90 there).
2. **Full server suite: 1 stale source-guard failure** (2236 tests: 1972 pass / 1 fail / 263 skipped) -- L6-5A's
   "nothing in the server reads a TASK# item" flagged `aws/deploy/hostcert/controlPlane.ts`, which only NAMES the writer's
   heartbeat in a check's evidence text (it judges the value the one bounded staging reader supplies; it reads nothing).
3. **Local ARM64 runtime: unavailable** -- the arm64 run failed `exec /usr/local/bin/node: exec format error` (no
   emulation); the gate was NOT RUN (amd64 7/0).

**OWNER-GATE FIX 1 (ordinary commits on top; `254cfe7` is not rewritten):**
1. `hostCert.test.ts`: the stub host re-asserts its stub directory first INSIDE the bash it starts (`cygpath` on Git Bash)
   and proves every stub (systemctl / docker / curl / journalctl) resolves before a template runs. The production
   templates are untouched. Windows 90/90, Linux 90/90.
2. `l6_5aObservability.test.ts`: the guard is semantic -- every file naming TASK# is still an offender, except the
   deployment-only `controlPlane.ts`, and only on lines that are a certification check's evidence text (never a key, a
   table read or a command); and everything under `aws/deploy/` is reachable only from the operator CLI
   `tools/awsDeploy.ts` (any `from` / `import()` / bare `import` / `require`). Mutation-checked: a TASK# key in
   controlPlane, a runtime import of host-cert code, and a TASK# name in the game table are each caught.
3. ARM64 split: the owner SOURCE gate requires the arm64 BUILD and an ARCHITECTURE PROOF without execution (metadata +
   the image's node an AArch64 ELF) beside the REQUIRED amd64 runtime smoke; the arm64 runtime smoke is PASS only when
   executed, otherwise DEFERRED TO REQUIRED LIVE GRAVITON GATE (never PASS) -- refused unless the runbook / guard carry the
   live gate. The live gate: runbook §E **12b** (`gs-host arm64-smoke`: the unchanged image-smoke.sh on the real host,
   before deploy), judged by `arm64LiveSmoke.ts`; `migration-guard edge-cutover` (step 14) refuses the cutover without its
   complete PASS for the release digest on THIS host (`--instance-id`; FAIL / NOT EVALUATED block). The summary
   distinguishes OWNER SOURCE GATE PASS from LIVE HOST CERTIFICATION PENDING (the ARM64 smoke and the AL2023 / systemd
   drills).

**The focused review of these fixes** (one pass, three lenses) found one High -- `--direction rollback` was taken on the
operator's word, so a FORWARD plan labelled "rollback" passed without the smoke -- now closed: a rollback needs the forward
step's PASS record (`--cutover-record`; it keeps the ALB origin it moved from) and the plan must be its exact reverse, or the
guard FAILS. Fixed besides: Windows PowerShell 5.1's Tee-Object capture (UTF-16LE) is decoded by its BOM; the host wrapper
frames every exit (a gs-lib refusal or a failing smoke is a framed FAIL, not a truncated NOT EVALUATED) and checks the
running server under the deploy lock; the capture is bound to the single host's instance id; the TASK# exemption accepts
exactly the one evidence shape (no assignment) and import specifiers are normalised (`.js`, `/index`, backticks); "no
emulation" is concluded only from an exec format error (any other probe failure is NOT RUN, failing the source gate).

**Comprehensive validation: PENDING OWNER GATE** (the whole runner, rerun once at the new head).

## 13. RECON-1 7A HOTFIX (`recon/recon-1-7a-target-moves`, from `ad135a0`) -- step 7a's Terraform target closure

**Found by the real pre-apply gate:** the live starting-state verification passed and step 7b / host-create produced
guarded PASS plans, but step 7a could not be planned: Terraform refused the two-target plan with "Moved resource
instances excluded by targeting". The accepted state was written before COST-1, so `modules/app/moved.tf`'s thirteen
moves are pending; the operator stopped rather than widen the targets. RECON-1A's contract ("exactly the two targets")
was impossible there: its Terraform-made 7a fixture had been planned on a state that already carried COST-1's addresses.

**Reproduced offline** (Terraform 1.16.5, hashicorp/aws 6.66.0, moto 5.2.3; no AWS account): the app stack applied to
the mock, then turned into the pre-COST-1 shape (`terraform-real/reproduce-7a/pre_cost1_state.py`). Terraform's refusal
names SIXTEEN addresses: the thirteen moved resources and three data sources COST-1 also gave `count`
(`data.aws_iam_policy_document.{ecs_tasks_assume,execution,task}`, moved implicitly). Each is necessary (drop one:
refused again, naming it); an indexed spelling is refused. With the eighteen targets the plan is 22 entries: the two
policy updates, thirteen no-op moves, the two roles, ECR, both log groups and both target groups (no-ops); no ECS service.
Applied to the mock, then re-planned: the two policies alone give "No changes", a step-14-shaped targeted plan has no
move error, and the services stay desired 0 (the drift untouched).

**The fix** (`planGuards.ts`, `migrationCommands.ts`): the move contract `COST1_SINGLETON_MOVES` is moved.tf block for
block (pinned both ways: every `count = local.ecs_one` resource is moved; the data closure is exactly the data sources
so gated). `judgeTargets` judges run.json's targets against the plan: COST-1's thirteen moves pending -> EXACTLY the two
policies + the sixteen; none pending -> EXACTLY the two (the eighteen would be broader than Terraform requires); a
duplicate, alias, missing or extra target, or an invalid move state, FAILS. The 7a gate also requires all thirteen moves
or none, each its exact transition and a pure no-op (raw before == after, a prior object, no replace_paths / action_reason
/ sensitivity / identity change); every entry inside Terraform's closure (dependencies no-op only; an ECS service, even as
a no-op, FAILS); no data source deferred to apply. The allowlist is unchanged: the two policies stay the only mutations,
each gaining exactly its pinned statements. Runbook step 7a carries the eighteen targets and the safety property;
`recon1SevenATargets.test.ts` (38 tests, in `npm test` and the owner gate's RECON-1 authorization gate).

**Focused review** (one pass): no High / Medium. Fixed: L1 (a "no-op" move judged only on normalised before / after;
now on the raw entry, as above); L3 (runbook wording "never `module.app`" -> never the whole module). L2 recorded, not a
risk: the plan cannot show whether the three data moves are pending; the closure requires them with the managed moves
(COST-1 introduced them together) -- on a hand-split state they would be locally rendered, plan-time reads only.

Validation here: build (typecheck); `recon1SevenATargets` 38/38, `recon1AuthorizationGates` + `cost2bMigrationGuards`
214/214. Nothing applied or deployed; no AWS contact. **Comprehensive validation: PENDING OWNER GATE.**

## 14. STEP 9 ACME HOTFIX (`recon/step9-acme-completion`, from `f1f3cac`) -- completing an interrupted step 9

**The incident (live):** step 9 was authorised and its guarded saved plan (`migration-guard host-create` PASS) began
applying. 17 of the 18 reviewed resources were created: the t4g.small host, ENI, EIP + association, security group, the
HTTPS-from-CloudFront ingress, the HTTPS egress, the host role / profile / policy, the log group, the five alarms and the
budget. EC2 refused the 18th, `module.host.aws_vpc_security_group_ingress_rule.acme_http01`: its description
(`Let's Encrypt HTTP-01 only ...`) contained an apostrophe, which EC2 does not accept in a security-group rule
description. The host runs; nothing serves; port 80 is closed. Nothing was repaired in AWS.

**The fix (source only):** the description is now `ACME HTTP-01 only - Caddy challenge or 404 on port 80` -- port,
protocol, CIDR, identity and count unchanged; `cost1SingleHost.test.ts` pins every security-group / rule description of
the single-host module to EC2's character set (`EC2_SG_DESCRIPTION`).

**The recovery gate** `migration-guard host-create-complete` (runbook §D 9r; `--commit`, `--region`,
`--ledger-table-arn`, `--signing-keys` required) PASSes only when: the prior state is exactly the reviewed step-9 surface
minus `acme_http01` (written as Terraform writes it: no repeated or misfiled address, no foreign mode or data source);
those objects are the reviewed host, cross-referenced (one SG in `network.vpc_id` that the ENI, the 443 and egress rules
name, its live rule listing only the reviewed rules; the EIP on that ENI, at most this instance; the instance on the ENI
with the `gs-staging-host-app` profile, IMDSv2, no key, termination protection; role / trust / profile / policy the
reviewed ones -- the policy exactly the module's rendering for the operator-given ledger and keys, reaching only g1; the
alarms on this instance; the budget <= $30); every one of them a NO-OP in the plan; and the ONE mutation is the create of
`acme_http01` -- tcp 80-80 from `0.0.0.0/0` on that existing group, with an EC2-valid description, nothing unknown but
its ids. `generation = 1`, `game_generations = [1]`, no emergency SSH, no ECR lifecycle, no second host, nothing
foreign, every data source read at plan time. The evidence binding (clean committed checkout, the saved binary plan) is
the other gates'.

**`host-create` tightened, not weakened:** at `f1f3cac` its surface check accepted no-ops, so it PASSED the completion
plan (and any partial re-plan whose remaining creates were allowed). It now requires every surface resource to be a
CREATE and the prior state to hold no host object.

**Reproduced with real Terraform** (1.16.5, hashicorp/aws 6.66.0; EC2 / IAM / Logs / STS on moto 5.2.3, CloudWatch and
Budgets on a local echo stand-in): the pre-fix module applied `-target`ed at the other 17, then the fixed module planned
untargeted -> 17 no-ops + the one create, the group's id known at plan time
(`infra/aws/fixtures/migration-plans/terraform-real/host-create-complete.json`, `reproduce-step9/`).

**Focused review** (one pass): no realistic false acceptance on a Terraform-written plan. Fixed: F1 (High, false refusal
of the live plan: AWS reports the attached instance on the EIP association -- now accepted when it is this instance);
F2 (an out-of-band rule on the host group, e.g. 22 opened by hand, was invisible -- the group's live rule listing is now
judged); F3 / F4 (a hand-edited prior state could hide a second object behind a repeated address or a foreign mode --
the prior state's entries are now checked as Terraform writes them, in both host gates); F5 partly: `--commit` is now
required for this gate. Recorded, by design: the egress ports follow `network.juno_egress_ports` (egress only, as
host-create); a `-refresh=false` plan cannot be detected (applying it still only creates the rule).

Validation here: build (typecheck); `step9AcmeCompletion` 62/62, `cost2bMigrationGuards` 181/181,
`recon1AuthorizationGates` 53/53, `recon1SevenATargets` 38/38, `cost1SingleHost` 28/28. Nothing applied or deployed; no
AWS contact. **Comprehensive validation: PENDING OWNER GATE.**
