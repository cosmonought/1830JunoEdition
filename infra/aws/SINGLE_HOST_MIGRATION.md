# Migrating staging from the drained ECS topology to the single host (COST-1, reconciled by COST-2B, COST-2A and RECON-1A)

**Status:** a PLAN. Nothing here has been executed.

**Prerequisites:**
- the COST-1 / COST-2B branches reviewed and their owner gates green;
- staging is in the **accepted post-abandonment state** of §0, proven by the read-only checks of step 1-3. The migration
  starts from that state and from no other.

**Do not run any step without the owner's GO for that step.**

**Accounts and roles used:**

| Label | Who |
|---|---|
| `APP-ADMIN` | Terraform in the app account |
| `LEDGER-ADMIN` | Terraform in the ledger account |
| `BOOT` | the `gs-<env>-bootstrap` role |
| `OPER` | `gs-<env>-operator` |
| `OWNER-DNS` | the owner's DNS provider |

**Running Windows commands:** run `node dist/...` directly; PowerShell's `npm.ps1` swallows `--`.

**A Windows checkout made before RECON-1A** (`.gitattributes` now pins the single host's files `eol=lf`) keeps CRLF
copies of them that git still reports clean; Terraform would embed those bytes into the host's user data. Before any
capture, re-clone -- or, in the existing clone, `git rm -r -q --cached infra/aws/modules/single-host` then
`git reset -q --hard`. `plan-evidence` refuses the checkout as not clean while any of those files carries a CR
(`run.json` `host_inputs_with_cr`), so every guard FAILs until it is fixed.

## 0. The accepted starting state

### 0.1 Staging today (after the GO-B abandonment)

The LIVE-6 restore drill was abandoned after GO-B. Its recovery-access unwind is **COMPLETE**. The state below is the
accepted, final result of that abandonment; this migration starts from it and changes none of it except what its own
steps name.

| # | Fact | Read-only proof (step 1-3) |
|---|---|---|
| S1 | **APPGEN = 1**, never adopted; **no generation-2 history** (`APPGEN#HISTORY/GEN#2` absent) | `recovery appgen-status --ledger <ARN>`; `gamesDoctor aws status` |
| S2 | **g1 (`gs-staging-game-g1`) is authoritative**: the p1 runtime document names generation 1 and g1; g1's `SYSTEM/GENERATION` says generation 1, origin `bootstrap` | `awsDeploy verify ... --generation 1 --no-evidence` |
| S3 | **g2 (`gs-staging-game-g2`) is prepared as generation 2 but UNADOPTED.** It was restored outside Terraform and is not in any Terraform state; it serves nothing (every task configured for it is refused before its pool) | `aws dynamodb describe-table --table-name gs-staging-game-g2` (exists); not in `terraform state list` |
| S4 | **Both ECS pools intentionally drained 0/0/0** (desired / running / pending), p1 and p2 | `aws ecs describe-services --cluster gs-staging --services gs-staging-p1 gs-staging-p2` |
| S5 | **The temporary recovery role and its policy are removed** | `aws iam get-role --role-name gs-staging-recovery` answers `NoSuchEntity` |
| S6 | **Break-glass is OFF** (`recovery_break_glass = false`, `recovery_trusted_principal_arns = []` in the app tfvars) | the tfvars; S5 |
| S7 | **0 money games** | `gamesDoctor aws games --money` |
| S8 | **`RELAYQ#<relayer>` is empty** | `aws dynamodb query --table-name gs-staging-game-g1 --key-condition-expression "pk = :p" --expression-attribute-values '{":p":{"S":"RELAYQ#<relayer address>"}}' --consistent-read --select COUNT` answers `Count: 0` |
| S9 | **The legacy app stack is frozen from normal apply** (§0.2) | -- |

**GO-C (`appgen-adopt`) was NOT run, and it is not part of this migration.** APPGEN never moves here. g2 is not part of
the migration either: it is never imported into Terraform (`game_generations` stays `[]` or `[1]`), never granted to the
host role (the host's `game_generations` is `[1]`), never served and never deleted by these steps. Its removal is a
separate reviewed change, after its evidence is kept. Every guard below refuses a plan that names a game table of any
generation but 1.

**The recovery unwind is not repeated.** The former first step of this runbook -- a full apply of the generation-1 app
configuration to turn break-glass off and remove the recovery access -- is DONE. It must not be run again: today that
apply would also restart p1 and p2 (§0.2), and it is refused by every guard.

If any of S1-S8 does not hold: **STOP.** Diagnose; do not "repair" it with an app-stack apply.

### 0.2 The legacy desired-count drift: why the app stack is frozen

The app stack's Terraform state and configuration still expect running services: the state remembers `desired_count = 1`
for both pools, and the configuration cannot say otherwise for the primary (`pools.<primary>.desired_count` must be 1, a
variable validation). Live staging is deliberately **0/0/0** (S4). So an ordinary app-stack plan either

- **restarts the pools** -- with `start_services = true` it updates `aws_ecs_service.pool["p1"]` (and p2 if configured at 1)
  from desired 0 to 1; the new task takes `POOL#p1` and the roles (once the host serves, it fences the host); or
- **destroys the services** -- with `start_services = false`.

Both are wrong before step 20. Therefore, until step 20:
- **no ordinary `terraform apply` of `stacks/app`;** a `terraform plan` is harmless (read-only) and is EXPECTED to show the
  drift -- the drift is not a change to make;
- the only app-stack applies are (a) the **targeted** read-grant step (step 7a, `-target=module.app.aws_iam_role_policy.bootstrap
  -target=module.app.aws_iam_role_policy.operator[0]` plus Terraform's required COST-1 move closure -- state-address moves
  only, see step 7a), (b) the **targeted** cutover (step 14,
  `-target=module.app.aws_cloudfront_distribution.site[0]`) and (c) the explicit **ECS rollback** (§F), each through its
  guard -- then step 20's compute-none teardown;
- **there is no ordinary app-stack apply before compute-none, for any reason** -- not even to give the host verifier
  (COST-2A) or the operator's evidence reads (JX-4C) their permissions: those grants are installed ONLY by step 7a's
  targeted, guarded plan (RECON-1A; it replaces COST-2A's former "D0", an ordinary apply that would have restarted p1);
- every guard refuses an ECS change other than its own: the cutover guard names the drift ("this plan would RESTART
  ..."), and only the `ecs-rollback` guard accepts a service going from 0 to 1 (p1 only; p2 stays 0).

### 0.3 Another environment

This runbook is for staging as it is today. An environment that still serves from ECS must first be brought to the same
facts by its own reviewed procedures (resolve every money game, drain both pools with `infra/aws/scripts/drain-pool`, turn
any break-glass off, empty `RELAYQ#`), then prove S1-S8 the same way. A NEW environment with no ECS history skips the
ECS-era steps altogether: `stacks/ledger`, `stacks/app` with `compute = "none"` (first apply `start_services = false`;
`awsDeploy bootstrap ... --apply`; then `start_services = true`), then `stacks/single-host` and steps 10-18.

## The guards: how every Terraform step is run (COST-2B)

Every Terraform step below is applied **only** from a saved plan that passed its guard. Per step:

1. **Capture the plan, keeping the binary plan**, from a **clean checkout of the reviewed commit** (`APP-ADMIN` /
   `LEDGER-ADMIN`, the stack initialised; no modified, untracked or `override.tf` file under `infra/aws` -- the plan
   cannot show the module code behind it, such as the host's cloud-init, so the guard requires the checkout to be the
   committed one):
   ```
   infra\aws\scripts\plan-evidence.ps1 -Stack <ledger|app|single-host> -Out <D> -Run <run id> -KeepPlan -PlanArgs @("-var-file=<env>.tfvars", ...)
   infra/aws/scripts/plan-evidence.sh <ledger|app|single-host> <D> <run id> --keep-plan -var-file=<env>.tfvars ...
   ```
   It writes `<D>\terraform\<stack>\`: `plan.json`, `plan-exitcode.txt`, `version.json`, `run.json` (with the commit,
   whether `infra/aws` was clean, and the plan's `-target` options), and the binary `stack.tfplan` with `stack.tfplan.sha256` (binding it to that
   `plan.json`). Nothing is applied.
2. **Judge it** (offline; no AWS, no Terraform):
   ```
   node dist/server/src/tools/awsDeploy.js migration-guard <gate> --plan-evidence <D>\terraform\<stack> --environment staging --app-account <app account> --commit <reviewed sha> [--origin-domain <name>] [--region <r> --ledger-table-arn <ARN> --signing-keys <relayer,settlement,admission>] --record <D>\guards\<step>.json
   ```
   Exit 0 `PASS`; exit 1 `FAIL -- DO NOT APPLY`. The record is create-once. `host-create` needs the app region, the ledger
   table ARN and the three signing-key ARNs **from the ledger stack's outputs / the Juno document** -- the host policy must
   name exactly those, never whatever the plan's own variables say.
3. **Apply exactly the judged plan**, with the owner's GO: `terraform -chdir=infra/aws/stacks/<stack> apply <D>\terraform\<stack>\stack.tfplan`.
   Never apply a fresh plan instead: Terraform refuses the saved one if the state moved since ("Saved plan is stale"),
   which means: capture and judge again.

A guard is an **allowlist**: every create, update, replace, delete or forget that its step does not name FAILS, of any
resource type; a value the plan cannot show yet, where the guard must judge it, FAILS; a deferred action, an import or an
unknown move FAILS. Beyond the changes it also refuses: a provisioner anywhere in the configuration, a module call other
than the stack's own `../../modules/<module>`, a provider other than hashicorp/aws (in the plan or in `version.json`), a
data source the stacks do not read or one read at apply time, an ephemeral resource, and any top-level plan section it
does not know (a newer Terraform feature such as action invocations). The owner still reads the plan: the guard is the
floor, not the ceiling.

| Step | Stack | Gate | Passes only if |
|---|---|---|---|
| 7a | app (targeted) | `migration-guard app-read-authorize --region <r> --ledger-table-arn <ARN>` | a plan targeted at exactly `aws_iam_role_policy.bootstrap` and `aws_iam_role_policy.operator[0]` plus -- exactly while COST-1's moves are pending -- Terraform's required closure (the thirteen `moved.tf` resources, the three implicitly moved policy documents; run.json's recorded `-target`s, nothing else); every move exactly its `moved.tf` transition and a no-op, the data sources read at plan time, the dependencies Terraform pulls in no-ops; the bootstrap policy = before + exactly COST-2A's `HostVerifierDescribeUnscopable`, `HostVerifierEcsEra`, `HostVerifierHostRole`, `HostVerifierBudgets`; the operator policy = before + exactly JX-4C's `IdentityEvidenceRead` (GetItem, identity table, `PRIN#*` / `PROF#*` / `FAM#*` + key presence) and `LedgerJournalQuery` (Query, the ledger, `ATTI#*` + key presence) -- each pinned to `modules/app/iam.tf`; every other statement byte-equal; no ECS (the drift), table, document, key, edge or other IAM change; still `compute = "ecs"` |
| 7b | ledger | `migration-guard ledger-operator-journal --ledger-table-arn <ARN>` | the ledger's resource policy updated in place, gaining exactly JX-4C's `OperatorJournalQuery` (Query, the ledger, the app root with `aws:PrincipalArn` = the operator role, `ATTI#*` + key presence); every other statement -- the runtime principals included -- byte-equal; no key policy, table, APPGEN item or AWS Backup change |
| 8 | ledger | `migration-guard ledger-host-authorize` | the ledger's resource policy and EVERY signing key's policy update in place, each runtime statement gaining exactly `gs-staging-host-app` beside the task role (kept: coexistence); every other statement byte-equal; no table, KMS create / delete / replace, APPGEN item or AWS Backup change |
| 9 | single-host | `migration-guard host-create` | only creates, exactly the single-host surface (one instance, ENI, EIP + association, SG + rules, role `gs-staging-host-app`, profile, inline policy, log group, the five alarms, the budget); IMDSv2; the host policy reaches only g1, identity and the ledger, never APPGEN / SYSTEM writes, digest-only Sign, no administrative action; no table, key, ALB, ECS, NAT, endpoint, distribution, ECR repository or lifecycle |
| 9 (recovery) | single-host | `migration-guard host-create-complete --commit <sha> --region <r> --ledger-table-arn <ARN> --signing-keys <a,b,c>` | ONLY when step 9 was interrupted with exactly `acme_http01` not created (§D 9r): the prior state is exactly the reviewed step-9 surface minus that rule, each object the reviewed one and wired to the others (one SG / ENI / EIP / instance, role `gs-staging-host-app`, the host policy reaching only g1 for the operator-given ledger and keys; the group's live rules only the reviewed ones -- no out-of-band rule such as a hand-opened 22); every one of them a NO-OP; the ONLY change the create of `acme_http01` -- tcp 80-80 from `0.0.0.0/0` on that existing security group, with a description EC2 accepts; `generation = 1`, `game_generations = [1]`, no emergency SSH, no ECR lifecycle, no second host, nothing foreign |
| 14 | app (targeted) | `migration-guard edge-cutover --origin-domain <origin_hostname> --arm64-live-smoke <D>\arm64-live-smoke.txt --release-digest <sha256> --instance-id <i-...>` | only the existing distribution, updated in place, only the `gs-alb` origin's `domain_name` -> the named host origin; default origin, behaviours (cache / origin-request policies), aliases, certificate, WAF unchanged; no ECS change (the drift), no table / key / IAM / document change; `compute = "ecs"`; AND (OWNER-GATE FIX 1) step 12b's live ARM64 smoke a complete PASS for that release on a Graviton host -- FAIL or NOT EVALUATED refuses the cutover (`--direction rollback`, the edge back to the ALB, needs no smoke but `--cutover-record`: the forward PASS record, and the plan its exact reverse) |
| F rollback | app | `migration-guard ecs-rollback` | only `aws_ecs_service.pool["p1"]`, desired 0 -> 1 and nothing else; p2 stays 0; SYSTEM/ROUTING read at plan time names p1 |
| 20 | app | `migration-guard compute-none` | EVERY ECS-era object in the prior state destroyed (services, task definitions, cluster; ALB, listener, rules, target groups; ECS / ALB / endpoint SGs and rules; gateway and interface endpoints; the per-pool log groups; the L6-5B alarms, composites and flip suppressors; the task / execution roles; p2's runtime document) and nothing else destroyed; the p1 document only loses p2's route; the bootstrap / operator policies only lose p2's document; NEVER g1, identity, a key, the p1 or Juno document, ECR, the distribution, the bootstrap / operator authority; nothing created; the plan-time gates read |
| 22 | ledger | `migration-guard ledger-task-deauthorize` | the mirror of step 8: the task role leaves exactly the runtime statements, the host role stays |
| 22b | single-host | `migration-guard ecr-lifecycle` | only the lifecycle policy on `gs-staging-server`, keeping >= 20 images |
| 23 | (outside Terraform) | `migration-guard nat` | the NAT evidence gate (step 23) |

## The sequence

### A. Confirm the starting state (read-only)

1. `BOOT`/`OPER`: prove S1-S8 (§0.1) and keep the outputs in `<D>\start-state\`:
   - `gamesDoctor aws status`: APPGEN = 1, routing names p1, no role holder alive;
   - the S8 query: `RELAYQ#<relayer address>` holds nothing (`Count: 0`);
   - `recovery appgen-status`: no adoption, no generation-2 history;
   - `awsDeploy verify ... --generation 1 --no-evidence` (and `--part ledger` with ledger credentials);
   - `gamesDoctor aws games --money`: **no open money game**;
   - `aws ecs describe-services`: both pools desired 0, running 0, pending 0;
   - `aws iam get-role --role-name gs-staging-recovery`: `NoSuchEntity`.
2. `APP-ADMIN`: `terraform plan` of `stacks/app` with the current tfvars (`recovery_break_glass = false`,
   `recovery_trusted_principal_arns = []`), **read-only, never applied**: it is expected to show the desired-count drift
   (§0.2) plus -- until step 7a -- the bootstrap and operator policies gaining their read statements (COST-2A, JX-4C) and
   COST-1's thirteen `moved.tf` address moves ("has moved to", no change). Anything else in it (a recovery role, a
   document, a table) is a STOP. This plan is never applied: the read grants are
   step 7a's, targeted.
3. Leave `gs-staging-game-g2` exactly as it is (S3).

### B. Traffic is off; ECS-era resources stay for now

4. Both pools are drained 0/0/0 (S4) and stay so. CloudFront `/gs*` answers 503 from the empty target groups: staging is
   offline until step 14 (accepted).
5. **Do not delete anything yet.** The ALB and the services are the rollback path until step G is proven -- a rollback
   is the guarded ECS restart of §F, never an ordinary app apply.

### C. Preserve DynamoDB, KMS, SSM, the ledger, and the evidence

6. **Untouched throughout:**
   - the game table g1, the identity table, the ledger table and its locked vault;
   - every KMS key;
   - both SSM documents (the p1 document's route table loses p2 at step 20, nothing else);
   - the ECR repository;
   - the CloudFront distribution (its `/gs*` origin domain moves at step 14, nothing else);
   - g2 (S3).

   Optionally take an **on-demand DynamoDB backup** of g1 and identity ($0.10/GB-month, cents).
7. **Export the evidence** step I would delete:
   - CloudWatch log groups `/gs/staging/p1`, `/gs/staging/p2`: `aws logs create-export-task` to an S3 bucket, or `aws logs filter-log-events > file`;
   - the alarm history;
   - every gate and evidence directory (the drill's included);
   - `terraform state pull` of both stacks;
   - the running image digests.

### C2. Install the pending read grants (RECON-1A) -- before step 8

The reviewed code carries read grants the accepted staging state does not have yet: COST-2A's host-verifier statements on
the bootstrap role, JX-4C's evidence reads on the operator role (app stack) and JX-4C's `OperatorJournalQuery` on the
ledger's resource policy (ledger stack). Left pending, every later untargeted plan would carry them, and the later guards
refuse a foreign IAM delta: step 8's `ledger-host-authorize` and step 22's `ledger-task-deauthorize` ("statements added"),
the `ecs-rollback` (so the ROLLBACK PATH would be blocked) and step 20's `compute-none`. So both go in here, each from
its own judged saved plan, before any host exists. **Never by an ordinary app-stack apply** (§0.2).

7a. `APP-ADMIN`: `stacks/app` with the current tfvars (still `compute = "ecs"`, break-glass off), planned **TARGETED** at
    the two policies **and Terraform's required COST-1 move closure** (RECON-1 7A HOTFIX). The accepted state was written
    before COST-1, so `modules/app/moved.tf`'s thirteen address moves are still pending, and Terraform refuses a plan
    targeted at the two policies alone ("Moved resource instances excluded by targeting"). The closure is exactly the
    sixteen addresses that refusal names -- the thirteen moved resources and the three ECS-era policy documents COST-1
    also gave `count` (`data.aws_iam_policy_document.ecs_tasks_assume` / `execution` / `task`, moved implicitly) -- each
    one proven necessary (`infra/aws/fixtures/migration-plans/terraform-real/app-read-authorize-pre-cost1.refusal.txt`).
    Give them **exactly as written** (the full `module.app.<type>.<name>` resource address, never an indexed `[0]`
    spelling, never the whole module):
    ```
    infra\aws\scripts\plan-evidence.ps1 -Stack app -Out <D> -Run <run id> -KeepPlan -PlanArgs @("-var-file=staging.tfvars", "-target=module.app.aws_iam_role_policy.bootstrap", "-target=module.app.aws_iam_role_policy.operator[0]", "-target=module.app.aws_lb.this", "-target=module.app.aws_lb_listener.https", "-target=module.app.aws_lb_listener_rule.gs", "-target=module.app.aws_ecs_cluster.this", "-target=module.app.aws_iam_role.execution", "-target=module.app.aws_iam_role_policy.execution", "-target=module.app.aws_iam_role.task", "-target=module.app.aws_iam_role_policy.task", "-target=module.app.aws_security_group.alb", "-target=module.app.aws_vpc_security_group_ingress_rule.alb_from_cloudfront", "-target=module.app.aws_vpc_security_group_egress_rule.alb_to_tasks", "-target=module.app.aws_security_group.task", "-target=module.app.aws_vpc_security_group_ingress_rule.task_from_alb", "-target=module.app.data.aws_iam_policy_document.ecs_tasks_assume", "-target=module.app.data.aws_iam_policy_document.execution", "-target=module.app.data.aws_iam_policy_document.task")
    infra/aws/scripts/plan-evidence.sh app <D> <run id> --keep-plan -var-file=staging.tfvars '-target=module.app.aws_iam_role_policy.bootstrap' '-target=module.app.aws_iam_role_policy.operator[0]' '-target=module.app.aws_lb.this' '-target=module.app.aws_lb_listener.https' '-target=module.app.aws_lb_listener_rule.gs' '-target=module.app.aws_ecs_cluster.this' '-target=module.app.aws_iam_role.execution' '-target=module.app.aws_iam_role_policy.execution' '-target=module.app.aws_iam_role.task' '-target=module.app.aws_iam_role_policy.task' '-target=module.app.aws_security_group.alb' '-target=module.app.aws_vpc_security_group_ingress_rule.alb_from_cloudfront' '-target=module.app.aws_vpc_security_group_egress_rule.alb_to_tasks' '-target=module.app.aws_security_group.task' '-target=module.app.aws_vpc_security_group_ingress_rule.task_from_alb' '-target=module.app.data.aws_iam_policy_document.ecs_tasks_assume' '-target=module.app.data.aws_iam_policy_document.execution' '-target=module.app.data.aws_iam_policy_document.task'
    node dist/server/src/tools/awsDeploy.js migration-guard app-read-authorize --plan-evidence <D>\terraform\app --environment staging --app-account <app> --region <r> --ledger-table-arn <the ledger stack's ledger_table_arn> --commit <reviewed sha> --record <D>\guards\7a.json
    ```
    - **The two IAM policies are the ONLY semantic mutations.** The bootstrap policy gains exactly COST-2A's four
      `HostVerifier*` statements and the operator policy exactly JX-4C's `IdentityEvidenceRead` and `LedgerJournalQuery`,
      statement for statement as `modules/app/iam.tf` renders them.
    - **The COST-1 moved addresses accompany them solely as no-op state-address moves**: the plan shows each of the
      thirteen as "has moved to" with no change. The guard requires all thirteen, each EXACTLY its `moved.tf`
      `from -> to`, each a no-op with its values unchanged; a partial set, an unknown pair, the game-table move or any
      move that also changes its object FAILS.
    - **The data-source closure is read-only, at plan time**: the three documents are `aws_iam_policy_document`
      (rendered locally); any data source deferred to apply FAILS. Terraform also pulls in, as dependencies, the two
      roles, the ECR repository, the per-pool log groups and target groups -- each must be a no-op; any other entry
      (an ECS service, a task definition, a table, a document, a key, the distribution) FAILS.
    - **The migration guard proves all of this** from run.json and the plan: run.json must record EXACTLY those eighteen
      `-target`s while the moves are pending, and EXACTLY the two policies once they are not (the eighteen would then be
      broader than Terraform requires); a duplicate, an alias, a missing or an extra target, or no target list FAILS.
    - **Ordinary app-stack apply remains forbidden**, and **the ECS desired-count drift stays untouched**: no ECS service
      is in this plan (it is not in Terraform's closure), so the drift is neither refreshed nor corrected; a plan that
      would change any ECS object FAILS.
    - Apply that `stack.tfplan` (Terraform warns the plan is incomplete: `-target`, expected). The apply also records
      COST-1's moves in the state, so later targeted plans (step 14) need no closure. A plan with no changes (exit 0)
      means 7a is already applied: keep the evidence and go on.
    - Optional now (COST-2A): `verify --topology coexist --instance-id none` (§F's F0 command, no host yet) proves the ECS
      era drained before any host exists.
7b. `LEDGER-ADMIN`: `stacks/ledger` with the current tfvars (no `app_runtime_role_arns` change yet: that is step 8).
    Capture with `--keep-plan`; **`migration-guard ledger-operator-journal --ledger-table-arn <ARN>`** must PASS (only the
    resource policy, gaining exactly `OperatorJournalQuery`; no key policy moves); apply that `stack.tfplan`. Exit 0 means
    7b is already applied.

After 7a and 7b, a plain `terraform plan` of `stacks/app` shows the desired-count drift ONLY, and one of `stacks/ledger`
shows nothing: every later guard then judges its own change alone.

### D. Authorise the host's role and create the host

8. `LEDGER-ADMIN`: `stacks/ledger` with `app_runtime_role_arns = ["arn:aws:iam::<app>:role/gs-staging-host-app"]`
   (`ecs_task_role_authorized` stays `true`).
   - Capture with `--keep-plan`; **`migration-guard ledger-host-authorize`** must PASS; apply that `stack.tfplan`.
   - The role need not exist yet: the grant is an `aws:PrincipalArn` condition.
9. `APP-ADMIN`: `stacks/single-host` (`example.tfvars.example`):
   - `t4g.small`, a pinned AL2023 **arm64** AMI, the public subnet;
   - `generation = 1`, `game_generations = [1]` (never 2: S3);
   - `origin_hostname` = a **new** name (e.g. `gs-origin-host.<domain>`), so the ALB origin keeps working;
   - `signing_keys` = the three keys the Juno document names;
   - `escrow_enabled`, `money_tables_nonmainnet` as staging;
   - `edge_diagnostic_staging = true` for the edge probes;
   - `manage_ecr_lifecycle = false` (step 22b);
   - **the budget, ENABLED, with an owner-named subscriber** (required). AWS Budgets in a member account sees only that account's costs:
     - if the ledger is a separate account and the two accounts are not under one Organizations payer, create the same budget in the ledger account too;
     - if they are under one payer, create it in the management account, where it covers both.

   Capture with `--keep-plan`; **`migration-guard host-create --region <r> --ledger-table-arn <the ledger stack's
   ledger_table_arn> --signing-keys <the three key ARNs the Juno document names>`** must PASS (the host role's policy,
   trust policy, profile and every host resource's attributes exactly the module's rendering for those facts); apply
   that `stack.tfplan`. The plan
   **creates only**: the instance, ENI, EIP, security group, role, profile, log group, five alarms and the budget. There is
   no ECR lifecycle policy yet: ECS is still the rollback path and its circuit-breaker images must not expire.
9r. **Recovery: an interrupted step 9 (STEP 9 ACME HOTFIX).** The normal path is step 9 above (`migration-guard
   host-create`, which judges ONLY the original full create: every resource a create, nothing of the host in the state).
   The live step-9 apply created 17 of its 18 reviewed resources and EC2 refused the 18th,
   `aws_vpc_security_group_ingress_rule.acme_http01`, for its description (`Let's Encrypt ...`: EC2 accepts no apostrophe
   in a security-group rule description). The host runs and serves nothing; with port 80 closed, Caddy cannot obtain
   its certificate (step 11) until step 9 is completed. The module now carries an EC2-valid description (`ACME HTTP-01 only - Caddy challenge or 404 on port
   80`), and that state is completed -- never re-run as host-create, never repaired by hand in AWS:
   - capture `stacks/single-host` again, **untargeted**, with `--keep-plan`, from a clean checkout of the **reviewed
     hotfix commit** and the **same tfvars** as step 9 (`generation = 1`, `game_generations = [1]`,
     `emergency_ssh_cidrs = []`, `manage_ecr_lifecycle = false`, the budget enabled). The single-host module must differ
     from step 9's commit only by that description: a changed template replaces the instance, and the guard refuses it;
   - **`migration-guard host-create-complete --commit <the reviewed hotfix commit> --region <r> --ledger-table-arn <the
     ledger stack's ledger_table_arn> --signing-keys <the three key ARNs>`** must PASS (`--commit` is REQUIRED here): the 17 existing objects each a no-op (and proven the reviewed,
     wired-together host), the ONE change the create of `acme_http01` (tcp 80 from `0.0.0.0/0` on the existing host
     security group). Anything else -- another missing object, an update / replace / delete, a second host, port 22, a
     different port, protocol or source, a different group, ECR, a foreign resource, a deferred read, generation 2 --
     FAILS;
   - apply **ONLY that saved PASS plan** (`terraform -chdir=infra/aws/stacks/single-host apply <D>\terraform\single-host\stack.tfplan`),
     with the owner's GO. Step 9 is then complete; continue at step 10.
   - An ordinary single-host apply remains forbidden: never a fresh `terraform apply`, never `-target`, never a
     console or CLI edit of the security group. If the guard FAILs, capture and judge again; a different interrupted
     shape is its own reviewed change, not this gate's.
10. `OWNER-DNS`: the A record `origin_hostname` → the `public_ip` output. It is a **new** record; `play.<domain>` is not touched.
11. Wait until Caddy has its certificate: `gs-host.ps1 -Command status` shows `origin_tls_readyz` ≠ `000`. The server is not running yet, so 503 is expected.
    - Expected noise: the `cpu-credits` alarm fires about 15 minutes after launch and clears after about 75 minutes (T4g/T3 standard mode earns no launch credits). The same happens after every host replacement.

### E. Install and start the same AWS-mode server against the existing authorities

12. Build the release image from the reviewed commit, `linux/arm64`, and push it to the existing ECR repository: `infra/aws/single-host/build-image.ps1`.
12b. **REQUIRED -- the live ARM64 runtime smoke on the real Graviton host (OWNER-GATE FIX 1), BEFORE deploy and before any
    edge cutover.** The owner SOURCE gate proves only the arm64 BUILD and its architecture (a workstation without
    emulation cannot execute arm64: its arm64 runtime smoke is reported DEFERRED, never PASS); the EXECUTION proof is made
    here, on the target architecture -- never inferred from the amd64 smoke:
    ```
    gs-host.ps1 -Command arm64-smoke -InstanceId <id> -Digest <sha256 of the release pushed at step 12> | Tee-Object <D>\arm64-live-smoke.txt
    ```
    It sends the two reviewed files (`infra/aws/single-host/arm64-live-smoke.sh` and the UNCHANGED
    `modules/single-host/tests/image-smoke.sh`); the host pulls the release BY DIGEST (refusing an image that is not
    linux/arm64), refuses while the game server runs, and runs the smoke: image metadata linux/arm64, Node arm64 as `node`,
    PROCESS-mode healthz 200 on a loopback port, SIGTERM exit 0, and AWS mode OFFLINE (`--network none`: no AWS call, no
    authority touched). It must end `[linux/arm64] 7 passed, 0 failed` and `GS-ARM64-LIVE-SMOKE END exit=0`.
    **FAIL is a STOP** (do not deploy; nothing has started). **NOT EVALUATED** (a truncated capture, an unread instance
    type, an SSM failure) **blocks the cutover** exactly like a FAIL: re-run it. A host-side refusal (another deploy holds
    the lock, the server is running, the pull failed) is reported `refused=` and is a FAIL. Step 14's guard judges this
    saved output (`--arm64-live-smoke`; UTF-16 from PowerShell 5.1's Tee-Object or UTF-8 -- decoded by its BOM) against
    the release digest and the single host's instance id (`--instance-id`) and refuses the cutover unless it is a complete
    PASS.
13. Deploy with the memory measurement on:
    ```
    gs-host.ps1 -Command deploy -InstanceId <id> -Digest <sha256> -BuildId <id> -Measure
    ```
    The server reads `/gs/staging/runtime/p1` (unchanged v2, routes p1/p2) and runs the certified startup:
    1. APPGEN = 1 and the g1 marker;
    2. **takes POOL#p1** (a new epoch);
    3. takes the identity-writer role and loads identity;
    4. the ledger, then the relayer role (a new ledger fence epoch);
    5. the stores, discovery, the first money sweep;
    6. ready.

### F. Prove it

**F0 (COST-2A): the host verifier, coexistence, before the edge moves.** Read-only; README "The single host".
```
infra/aws/scripts/capture-host-evidence.sh staging <region> <i-...> <distribution id> ev-F --terraform-dir stacks/single-host      # BOOT
infra/aws/scripts/capture-host-evidence.sh --host-status-only staging <region> <i-...> ev-F      # the host-deploy principal (RECON-1: SSM Run Command of the FIXED gs-health; never the operator role)
npm run gamesDoctor -- aws host-snapshot --aws-config <runtime p1 ARN> --out ev-F/runtime-snapshot.json      # OPER
npm run awsDeploy -- verify --topology coexist --runtime-parameter <runtime p1 ARN> --environment staging \
  --primary-pool p1 --pools p1,p2 --generation 1 --evidence ev-F --instance-id <i-...> --origin-hostname <origin_hostname> \
  --gs-origin <the ALB's origin name: step G has not run> --site-origin <site origin> \
  --expect-digest <the release> --expect-build <its build> --alarm-actions <the module's alarm_action_arns, or none> \
  --record ev-F/verify.json --report ev-F      # BOOT
```
It must say VERIFIED (exit 0). FAIL (1) or NOT EVALUATED (3) is a STOP: NOT EVALUATED means a read failed, never that a
property holds. It covers, besides the table below: the ECS era drained (no service task, no running task, no target --
a second serving writer otherwise), the host's EC2 / network / IAM / KMS allow-list / alarms / budget, and the identity
writer and relayer held by the host pool's current task.

| # | Property | How (read-only unless noted) |
|---|---|---|
| F1 | Generation gate | Startup passed. `gamesDoctor aws status`: APPGEN 1 = the document's generation; the g1 marker `bootstrap`. No `StartupRefused` in the log group. |
| F2 | Identity writer | `gamesDoctor aws status`: the identity-writer holder is the host's task (its `t-…` id is in the startup banner) and it is current. |
| F3 | Relayer | `gamesDoctor aws status`: the relayer mirror epoch = the ledger fence epoch, held by the host's task. The task-status line shows `relayer_state: usable`. `awsDeploy set-operator-plan` READY. |
| F4 | Money sweep | `money-sweep` records every 60 s; `MoneySweepSecondsSinceSuccess` < 180; `HostHealthProblems` = 0. |
| F5 | KMS | The startup's signer identities verified. Then the L6-6 `kms` probe, run as a one-off `docker run --rm` of the same image on the host (the instance role), < 3 s per Sign. |
| F6 | DynamoDB | The L6-6 `transactions` probe, the same way (disposable `L6CERT#R` partition, read back empty). |
| F7 | SIGTERM (MUTATING, staging) | **`awsDeploy host-cert graceful-stop`** (COST-2C, below): gs-stop -> readiness 503 first -> exit 0 -> no HOLD, no restart; the same digest redeployed serves; generation / pool unchanged. |
| F8 | Restart safety (MUTATING, staging) | **`awsDeploy host-cert crash-restart`**: `docker kill --signal KILL gs-server` -> a non-fence exit, no HOLD, exactly one automatic restart, a **strictly newer POOL#p1 epoch**, identity writer and relayer moved consistently. **`awsDeploy host-cert reboot-restart`**: the host reboots and the service returns by itself, newer epochs, no HOLD. |
| F9 | No duplicate writer | **(a)** non-disruptive: **`awsDeploy host-cert duplicate-preflight`** (`/opt/gs/bin/gs-preflight` while the server runs refuses "already running"; nothing moves). **(b)** disruptive, staging only: **`awsDeploy host-cert duplicate-fence`** -- a second container of the same image and env under another name (no port, not under systemd); the **older** process exits 3 and stays down (`RestartPreventExitStatus`), ExecStopPost got `EXIT_CODE=exited EXIT_STATUS=3`, the HOLD is written, survives a reboot, refuses preflight and start, survives a refused deploy; the rival is removed and `gs-deploy` of the same release clears it: one writer at a newer fence. |
| F10 | Stale host / replacement | Offline: Terraform (destroy-before-create on the ENI) and the preflight's EIP check (`tests/host-scripts.test.sh`). Live (when a replacement is certified): **`awsDeploy host-cert replacement-before`**, the guarded replacement, then **`replacement-after --before <record> [--stale-instance-id <old>]`** (COST-2C, below). |

Any failure: STOP. **Rollback before G** (the ONE plan that may start an ECS task again):
1. `gs-host -Command stop -UntilDeploy` (the host must be down before ECS takes the pool).
2. `APP-ADMIN`: `stacks/app` with `pools = { p1 = { primary = true, desired_count = 1 }, p2 = { primary = false, desired_count = 0 } }`,
   `start_services = true`, everything else unchanged. Capture with `--keep-plan`; **`migration-guard ecs-rollback`** must
   PASS (only p1's service, desired 0 → 1; p2 stays drained); apply that `stack.tfplan`. p1's task takes the pool; the host
   stays down.

### G. Point CloudFront `/gs*` at the host

14. `APP-ADMIN`: `stacks/app` with `edge.alb_origin_domain_name = <origin_hostname>`, still `compute = "ecs"`, planned
    **TARGETED** -- an untargeted plan carries the desired-count drift (§0.2):
    ```
    infra\aws\scripts\plan-evidence.ps1 -Stack app -Out <D> -Run <run id> -KeepPlan -PlanArgs @("-var-file=staging.tfvars", "-target=module.app.aws_cloudfront_distribution.site[0]")
    node dist/server/src/tools/awsDeploy.js migration-guard edge-cutover --plan-evidence <D>\terraform\app --environment staging --app-account <app> --origin-domain <origin_hostname> --arm64-live-smoke <D>\arm64-live-smoke.txt --release-digest <sha256 of the release the host serves> --instance-id <the single host's id> --record <D>\guards\14.json
    ```
    - The plan changes **only** the distribution's `gs-alb` origin domain; the guard refuses anything else (the default
      origin, the `/gs*` behaviour and its cache / origin-request policies, the aliases, the certificate, any ECS change).
    - **The ARM64 live gate (12b) is part of this guard:** without `--arm64-live-smoke` / `--release-digest` /
      `--instance-id` it refuses (usage); a smoke capture that is not a complete PASS for that digest on THIS Graviton
      host (FAIL or NOT EVALUATED) FAILS the guard -- DO NOT APPLY. The edge never moves onto an image that has not
      executed on the real host. Keep `<D>\guards\14.json`: a rollback needs it.
    - Apply that `stack.tfplan` (`-target` is in it: Terraform warns that the plan is incomplete; expected).
15. Wait for the distribution to deploy.
15b. (COST-2A) Once the distribution shows `Deployed` (its configuration names the new origin before the edge serves it),
     re-run F0 into a fresh directory with `--gs-origin <origin_hostname>` (the /gs* origin of THIS state is now the
     host's): VERIFIED.

**Rollback:** the same targeted capture with the ALB's origin name in the tfvars, judged with
`migration-guard edge-cutover --origin-domain <the ALB origin name> --direction rollback --cutover-record <D>\guards\14.json`
(a rollback needs no ARM64 smoke -- the forward gate never blocks the way back -- but it is PROVEN, not labelled: the
forward step's PASS record, and a plan that moves the /gs* origin from that record's host origin back to the ALB origin it
recorded; a forward plan called a rollback FAILS); then the ECS rollback of §F (the host stopped `--until-deploy` first).

### H. Smoke test through the edge

16. Run `awsDeploy stage-probe edge` through the distribution, with the `/gs/diag/edge` mirror on (`edge_diagnostic_staging`). It covers:
    - `proxy-hops` (exactly 2);
    - `query-strings` (`cp` / `cr` / `cb` unchanged; an allow-list fails);
    - `websocket` (idle survival; ping gaps ≤ 60 s).
17. A browser on `https://play.<domain>`:
    - sign-in;
    - the cookie (`__Host-gs_session`);
    - a lobby, a no-money game, reconnect.
18. **Money-game smoke** (testnet, when the JX phase calls for it): a funding → Start → play → settlement path on the testnet contract. The existing JX procedures are unchanged.

### I. Delete the remaining ECS-era resources

19. `OPER`: `gamesDoctor aws retire-check p2` (R1–R6) must pass.
20. `APP-ADMIN`: `stacks/app` with `compute = "none"`, `start_services = true`, `pools = { p1 = { primary = true } }`,
    `recovery_break_glass = false`, `generation = 1`, `game_generations` without 2. Capture (untargeted) with
    `--keep-plan`; **`migration-guard compute-none`** must PASS; apply that `stack.tfplan`.
    - `start_services = true` is REQUIRED here: under `compute = "none"` it is what turns on the plan-time gates (routing names p1, SYSTEM/GENERATION names the serving table, adoption). With `false` the gates are off (that is only for the very first bootstrap apply of a new environment, before any host serves). The guard checks both reads were made at plan time.
    - This is the step that ENDS the desired-count drift: the services are destroyed, never restarted.

    **The plan destroys, and only destroys** (the guard requires every one of these that the state holds):
    - the ALB, listener, rules and target groups;
    - the ECS services, task definitions and cluster (Container Insights with it);
    - the pool log groups (exported in step 7);
    - the task and ALB security groups and their rules;
    - the VPC endpoints (gateway and interface) and their security group;
    - the ECS task and execution roles and their policies;
    - the L6-5B alarms, composites and flip suppressors.

    **It also removes p2's own objects:** `aws_ssm_parameter.runtime["p2"]`, the p2 target group, rule and service, and the p2 log group (exported in step 7). It narrows the p1 runtime document's route table and the bootstrap / operator policies' document lists to p1. These are expected.

    **It keeps:** both tables, the p1 runtime document, the Juno document, ECR, the bootstrap / operator roles, the distribution, and the single-host stack (another state).

    The guard FAILS (STOP) if a table, the p1 or Juno document, a key, the repository, the distribution or the bootstrap / operator authority is destroyed or replaced, if anything is created, or if an ECS-era object would survive.
21. Restart the host so it reads the p1-only route table: `gs-host -Command stop`, then `deploy` with the same release.
22. `LEDGER-ADMIN`: `stacks/ledger` with `ecs_task_role_authorized = false`. Capture with `--keep-plan`;
    **`migration-guard ledger-task-deauthorize`** must PASS (only the task role ARN removed from the ledger and key
    policies; the host role stays); apply that `stack.tfplan`.
22b. `APP-ADMIN`: `stacks/single-host` with `manage_ecr_lifecycle = true`. Capture with `--keep-plan`;
    **`migration-guard ecr-lifecycle`** must PASS (only the lifecycle policy, keeping >= 20 images); apply that
    `stack.tfplan`. ECS is gone, so the lifecycle policy may now expire old images, keeping the newest 20 images. The
    current and previous releases are protected only while they ARE among the newest 20 (a running host keeps its pulled
    image locally, but a host replacement pulls from ECR): before pushing a 20th newer image, re-deploy or re-tag what
    must survive.
23. **Outside Terraform -- never automatically safe:**
    - **the NAT gateway** (and its Elastic IP). No Terraform plan shows who else routes through it. Deleting a NAT another
      workload uses cuts that workload off. The evidence gate, **at least 24 hours after step 20's apply**:
      1. `APP-ADMIN` (read-only): `infra\aws\scripts\capture-nat-evidence.ps1 -Environment staging -Region <r> -NatGatewayId <nat-…> -VpcId <vpc-…> -TeardownAppliedAt <step 20's apply time, UTC> -Out <D>\nat`
         (`capture-nat-evidence.sh` on Linux): the NAT, every route table and subnet of the VPC, every network interface
         of the VPC, and the NAT's own hourly CloudWatch metrics since the teardown.
      2. `node dist/server/src/tools/awsDeploy.js migration-guard nat --evidence <D>\nat --record <D>\guards\23-nat.json`
         must say `COST-2B NAT DELETION EVIDENCE: PASS`: the NAT identified; **no network interface of any kind** in a
         subnet routed through it (the MAIN route table covers every unassociated subnet); no Transit Gateway, peering,
         Cloud WAN or VPN route beside it; >= 24 whole hours with zero connections and zero bytes either way, no gap.
      3. The checklist the evidence cannot prove, confirmed by the owner in the record's notes: the VPC is not shared
         (RAM) with another account; no planned workload is waiting for it; the J inventory (step 24) is otherwise clean.
      4. Only then, with the owner's GO: delete the NAT gateway by hand, then release its Elastic IP.
      A FAIL is a STOP: keep the NAT and find its user.
    - delete the ALB's ACM certificate if it is no longer used (free; optional);
    - remove the now-unused DNS name of the ALB origin.

### J. Verify the bill and the inventory

24. **Inventory**, read-only. **Any surplus is a HARD FAIL to fix before closing the migration.** A forgotten NAT gateway alone is about $33/month.

    (COST-2A) The final state, judged: F0's capture and snapshot again, then
    `npm run awsDeploy -- verify --topology single-host ... --pools p1 --evidence ev-J --instance-id <i-...> --origin-hostname <origin_hostname> ...`
    (no `--gs-origin`: in the final state it IS the host's; `--pools` exactly p1; `--alarm-actions` as in F0;
    `--legacy-vpc <the ECS era's VPC>` when it is not the host's). Its `absent:` checks are this list -- no ECS cluster,
    no `gs-staging-alb` / `gs-staging-p1|p2` target group, no NAT in those VPCs (`--allow-nat` names another workload's),
    no interface endpoint (`--allow-vpc-endpoint`), only the five host alarms, only the host log group, no Container
    Insights log group, no ECS-era security group, exactly one host and one host EIP and no unassociated EIP
    (`--allow-eip`) -- each a FAIL when present and NOT EVALUATED (never a pass) when its listing could not be read. The
    CLI answers below remain the manual cross-check. The expected answers:
    - `aws elbv2 describe-load-balancers` → none;
    - `aws ecs list-clusters` → none for this environment;
    - `aws ec2 describe-nat-gateways` → none (or only other workloads', as step 23's evidence showed);
    - `aws ec2 describe-vpc-endpoints` → none;
    - `aws ec2 describe-addresses` → exactly the host's EIP;
    - `aws ec2 describe-instances` (tag `gs:component=single-host`) → exactly 1;
    - `aws cloudwatch describe-alarms --alarm-name-prefix gs-staging` → the host's 5.
25. **Billing:**
    - Cost Explorer daily for 5–7 days, grouped by service, with the `gs:cost` tag activated;
    - the budget's $15 / $20 / $25 / $30 alerts active.

    Expect about **$0.75/day** while the host is on-demand. That is about $23 a month; about $18.61 with the 1-year Savings Plan, which is bought only after the memory plan (`docs/hosting-budget.md`).

## COST-2C: the single-host certification drills (`awsDeploy host-cert`)

**Status: tooling implemented and offline-tested (COST-2C). NOTHING HERE HAS RUN ON A REAL HOST.** The AL2023 / systemd
contract (COST-1's open item) stays **OPEN -- NOT EVALUATED -- until the live drill's evidence exists.** An offline run can
never PASS: every scenario's `real AL2023 host` check is PASS only through the production SSM transport from an Amazon
Linux 2023 host (`aws/deploy/hostcert/`).

Run by the ONE authorized Claude Code session (or the owner), from the reviewed commit. AWS CLI v2 on PATH. On Windows
run `node dist/...` directly.

**The credential authority (RECON-1): two existing principals, no new IAM.**

| Half | Calls (exactly) | Principal | Why this one |
|---|---|---|---|
| Host transport (AWS CLI) | `ssm send-command` (document `AWS-RunShellScript`, one `--instance-ids`), `ssm get-command-invocation`, `ec2 describe-instances`, `ec2 describe-addresses`, `ecs list-tasks` | **the host-deploy principal** -- the identity that already runs `gs-host deploy` at step 13 (SSM `AWS-RunShellScript` on the host is its reviewed authority since COST-1), named by `--host-transport-profile <AWS CLI profile>` | SSM Run Command on the host IS root on the host, i.e. the host role's KMS Sign and money writes. Granting it to the operator role, or to a new persistent role, would create a SECOND principal with that power (plus new app- and ledger-stack IAM deltas on the frozen stacks). The deploy principal already holds it. |
| Control plane (SDK) | the runtime / Juno documents' `ssm:GetParameter`; g1 `GetItem` / `Query` (SYSTEM, POOL#, ROLE#relayer, TASK#, FINKEYS / FINIDX#, RELAYQ#, the lock); identity `GetItem` ROLE#identity-writer; ledger `GetItem` APPGEN / FENCE#relayer#; **the one write:** `PutItem` of `OPRUN#host-cert` / `LOCK` | **`gs-staging-operator`** (the default chain), UNCHANGED | its existing grants cover exactly these (`GameTableRead`, `RoutingAndEvidence` with the lock's attributes, `IdentityWriterRoleRead`, `LedgerRead` + the ledger's `OperatorLedgerReadOnly`, `ReadConfiguration`); it gains no SSM / EC2 / ECS authority, no KMS Sign, no money write |

The transport's child process inherits **no** credential variable (`AWS_ACCESS_KEY_ID` / `SECRET` / `SESSION_TOKEN` /
`AWS_PROFILE`, the container-credential and web-identity variables) and runs with `AWS_EC2_METADATA_DISABLED=true`, so a
profile without credentials fails rather than falling through to another principal: the named profile is its only source
(the profile NAME is recorded, not a resolved identity -- the transport's surface has no STS call); the evidence's transport label records the profile name. In the
single-account form both halves may be one principal; the flag is still required (an explicit choice). Optional owner
hardening (outside Terraform, owner-managed, never applied here): scope the host-deploy principal's SSM statement to
`ssm:SendCommand` on `arn:aws:ssm:<region>::document/AWS-RunShellScript` and `arn:aws:ec2:<region>:<app>:instance/*` with
`ssm:resourceTag/gs:component = single-host` and `ssm:resourceTag/gs:environment = staging`, `ssm:GetCommandInvocation` on
`*`, `ec2:DescribeInstances` / `ec2:DescribeAddresses` on `*`, `ecs:ListTasks` with `ecs:cluster` = the retired cluster;
`gs-host` needs the same SSM statement.

```
node dist/server/src/tools/awsDeploy.js host-cert <scenario> --run-id <run> --acknowledge-mutating-drill <scenario>
  --environment staging --runtime-parameter <p1 SSM ARN> --generation 1 --pool p1 --game-table gs-staging-game-g1
  --instance-id <i-...> --digest <sha256:... the serving release> --build <its build id> --source-commit <40 hex>
  --operator <who> --evidence <D>\host-cert --host-transport-profile <the host-deploy principal's AWS CLI profile>
  [--reclaim-stale-lock <run>] [--before <file> --stale-instance-id <i-...>]
```

| Property | Scenario | Disruptive? | Needs 0 money games + RELAYQ empty | Owner GO required |
|---|---|---|---|---|
| F7 graceful SIGTERM | `graceful-stop` | yes (downtime: stop, redeploy) | no (recorded) | "GO COST-2C F7 graceful-stop on <instance>, run <run>" |
| F8 crash restart | `crash-restart` | yes (an ungraceful kill) | **yes** | "GO COST-2C F8 crash-restart ..." |
| F8 host reboot | `reboot-restart` | yes (reboot) | **yes** | "GO COST-2C F8 reboot-restart ..." |
| F9a local duplicate | `duplicate-preflight` | **no** (runs gs-preflight beside the server) | no | "GO COST-2C F9a duplicate-preflight ..." |
| F9b fencing / HOLD | `duplicate-fence` | **yes** (a rival takes the pool; the host is fenced, rebooted on HOLD, redeployed) | **yes** | "GO COST-2C F9b duplicate-fence ..." -- staging only |
| Replacement | `replacement-before`, then the guarded replacement, then `replacement-after` | yes | **yes** | one GO for the whole replacement, naming the old and new instance |

Every scenario runs **PRECHECK -> MUTATION -> OBSERVATION -> CLEANUP / RECOVERY -> POSTCHECK**, writes
`<D>\host-cert\host-cert-<scenario>-<run>.json` (create-once; `18COSMOS/COST-2C-HOST-CERT/v1`: run, scenario, source
commit, instance, release, before / after task, POOL / identity-writer / relayer epochs, APPGEN, HOLD before / after, the
systemd properties and unit, every SSM CommandId, mutation timestamps, cleanup, final health; no credential, no SSM value,
no server.env) and prints **PASS / FAIL / NOT EVALUATED** (exit 0 / 1 / 3; 4 = REFUSED, nothing mutated). A read that
failed is never PASS; a failed cleanup is always FAIL.

**The precheck refuses** unless: the runtime document is `staging[-*]`, its escrow not mainnet, generation / table / pool
as named; APPGEN and SYSTEM/GENERATION agree (LIVE-6's `judgeGeneration`); exactly one single-host instance, it holds the
serving Elastic IP, no ECS task; the host serves the named release, no HOLD, one gs-server, no other drill's recorder or
rival, the unit and scripts the reviewed bytes; ONE consistent writer -- the host's own process (its banner's task); for
the disruptive F8 / F9b / replacement drills 0 open money games and RELAYQ empty; the drill lock; the run id; the
scenario-named acknowledgement. There is no `--force`.

**The drill lock** (`OPRUN#host-cert` / `LOCK` in g1, the operator's own evidence partition): one drill at a time, a
bounded lease, renewed at every mutation; released at the end (`replacement-before` keeps it for `replacement-after`). An
expired lock is never taken silently: `--reclaim-stale-lock <its run id>` only after the lease ended (plus 2 minutes of
clock skew), and only after checking the host carries no `90-gs-cert-*` drop-in and no `gs-cert-rival-*` container. No
server code reads it; it is never money or serving authority.

**What the systemd proof captures** (F9b; F7 / F8 likewise): the systemd version and the unit (verbatim), a drill-only
drop-in that appends ONE ExecStopPost recorder AFTER gs-exit-hold (removed at cleanup; it never writes the HOLD and changes
no Restart= setting), the recorder's `EXIT_CODE` / `EXIT_STATUS` / `SERVICE_RESULT`, systemd's own journal line, the
`ExecMainCode` / `ExecMainStatus` / `NRestarts` / `Result`, the HOLD file's contents, and the service state after a
40-second settle. All of them must agree.

**Replacement:** `replacement-after` proves one serving host owning the EIP, newer epochs and roles on the new host, and
-- only when the owner kept the old instance reachable and names it `--stale-instance-id` -- that its preflight refuses
("not the serving Elastic IP"), it serves nothing and POOL#p1 does not move. Without a reachable stale host that check is
NOT EVALUATED (offline proof only).

**The stale-host live sub-proof: CLASSIFIED NOT EVALUATED (RECON-1).** The module replaces the host destroy-before-create
(the one ENI): an ordinary replacement leaves no old instance, so it proves nothing about a stale one, and it is never
called proof of it. Keeping an old instance alive would mean a second instance carrying the host role -- authorised for
the tables, the ledger and the signing keys -- beside the serving one, i.e. exactly the simultaneously authorised second
host this migration forbids; no such exercise is run. `replacement-after` therefore ends NOT EVALUATED on that one check
(every other check must PASS; the record lists them); that outcome is the expected, final classification for this
topology, never a PASS. What stays certified instead:
- **offline:** `gs-preflight`'s Elastic-IP refusal ("not the serving Elastic IP") and its duplicate-process refusal
  (`modules/single-host/tests/host-scripts.test.sh`), the destroy-before-create ENI / one-host shape
  (`single-host.tftest.hcl`), `migration-guard host-create` (one instance, one EIP);
- **live, other drills:** POOL# fencing on the real host -- a later writer fences the earlier one, which exits 3 and is
  held (`host-cert duplicate-fence`, F9b): the consequence of any stale writer is the proven fence;
- **live, every replacement:** `replacement-after`'s one-host / EIP-owner / newer-epoch checks (a RUNNING undeclared old
  host FAILs) and §J 24's judged inventory (`verify --topology single-host`: exactly one host, one host EIP, no
  unassociated EIP).

**Known limits (the COST-2C review's Low findings, NOT fixed; none can produce a false PASS):** "no server process after
the reboot" is sampled every 5 s (a process that lived between samples is caught only if it took the pool); the F9b fence
poll may end before ExecStopPost ran (NOT EVALUATED, never PASS); the reboot is `nohup ... systemctl reboot` and may be
killed with the SSM command (then F8 FAILs / F9b is NOT EVALUATED); only `/etc/systemd/system/gs-server.service.d` is
listed for foreign drop-ins (the effective `Restart=` / `RestartPreventExitStatus=` / gs-exit-hold are checked); the
rival uses the server's memory limit on a 2 GB host (an OOM kill shows as a FAIL); a lost renew answer reads as a lost
lock (the drill stops, the lock expires); the operator role in Terraform has no SSM / EC2 grants (RECON-1: by design --
the host transport runs under the host-deploy principal's `--host-transport-profile`, above); host command output is printed before the evidence's secret refusal; and
`replacement-after` stays NOT EVALUATED unless a stale host is reachable over SSM (the destroy-before-create
replacement normally leaves none).

**Owner validation:** `powershell -ExecutionPolicy Bypass -File .\infra\aws\single-host\run-cost2c-owner-gate.ps1`
(RECON-1: the ONE owner gate for the whole reconciled candidate -- RECON-1A's gates, COST-1 / 2A / 2B / 2C, JX-4C, P5, the
Windows LF checks, Terraform, DynamoDB Local and the full server suite last; one log under `evidence\owner-gates\`). Run it
from a CLEAN clone: it installs the locked dependencies itself (`npm ci` in `frontend` and `server`, failing if that changes
a tracked file), runs `host-scripts.test.sh` in a pinned Amazon Linux 2023 container (never Git Bash: the host scripts need
`flock` and `python3`), re-runs COST-2C's targeted suite in a pinned Linux Node container, and builds the image locally
for linux/amd64 and linux/arm64 (`--load` only: no push, no ECR login) -- amd64 built, architecture-proven and
runtime-smoked (REQUIRED); arm64 built and architecture-proven without executing anything (image metadata + the image's
node an AArch64 ELF). Its summary is **OWNER SOURCE GATE PASS / FAIL** and **LIVE HOST CERTIFICATION PENDING**: the
arm64 runtime smoke is run locally only where the machine can execute arm64; otherwise it is **DEFERRED TO REQUIRED LIVE
GRAVITON GATE** (step 12b; never PASS, never inferred from amd64), allowed only beside a passing arm64 build /
architecture proof and amd64 runtime smoke. The live AL2023 / systemd drills (F7-F9) join that pre-cutover live
certification. Prerequisites: Node/npm, Git for Windows, Terraform >= 1.10, and Docker Desktop (Linux engine, buildx; no
arm64 emulation needed) with network access to `public.ecr.aws`, the npm registry and the Amazon Linux repositories.

## Certification: what remains valid, what reruns, what retires

| Status | Item | Why |
|---|---|---|
| **KEEP VALID** | Contract semantics (escrow 2.0.0, settlement certification `[10, 11, 12]`, ESCROW-JOIN admission) | No contract, codec or settlement byte moved |
| KEEP VALID | JX-2B (relayer submission hardening), JX-3B (wallet binding), JX-4B (money evidence reader), JX-5B (settle sweep retry), JX-6B (dispute hardening) | Application logic, independent of where the process runs |
| KEEP VALID | Persistence conformance (L5-1… on DynamoDB Local), the signing ledger / journal cases, wallet binding | Same adapters, same tables. The COST-1 change is metrics-only. |
| KEEP VALID | Fencing semantics (L5-3 pool writer, L5-4 identity writer, L5-6 relayer), APPGEN / generation (L6-4) | Same code and data model, one pool |
| **RERUN** | Deployment health | §F1–F4, `gs-health` |
| RERUN | Origin routing | §H 16, plus `tests/edge-smoke.sh` offline |
| RERUN | WebSocket | the `stage-probe edge` websocket gate through CloudFront → Caddy |
| RERUN | Restart | §F7–F8 (`host-cert graceful-stop`, `crash-restart`, `reboot-restart`) |
| RERUN | Fencing / duplicate process | §F9 (`host-cert duplicate-preflight`, `duplicate-fence`), plus the replacement certification (`host-cert replacement-before` / `replacement-after`; LIVE-6's `stage-cert` replacement scenario is ECS-only and unchanged) |
| **NOT EVALUATED (classified)** | The stale-host live sub-proof of a replacement (a kept old host's preflight refusal) | destroy-before-create leaves no old host; keeping one would be a second authorised host. Certified offline (gs-preflight EIP / duplicate refusal, the one-host shape, host-create) plus live F9b fencing and the J 24 inventory (above) |
| **REQUIRED LIVE (pre-cutover)** | **The ARM64 runtime smoke** (the release image EXECUTED on the real Graviton host) | The owner source gate proves the linux/arm64 build and architecture only; a workstation without emulation reports the runtime smoke DEFERRED, never PASS. §E 12b runs it on the host before deploy; step 14's `migration-guard edge-cutover` refuses the cutover unless it is a complete PASS (FAIL / NOT EVALUATED block). |
| **OPEN** | **The AL2023 / systemd exit-status contract** (gs-exit-hold receives `EXIT_CODE=exited` / `EXIT_STATUS=3` or `5` from ExecStopPost; `RestartPreventExitStatus=3 5` holds) | Proven offline only as far as offline can go (COST-2C). **NOT EVALUATED until `host-cert duplicate-fence` (and the F7 / F8 drills) PASS on the real host.** Not certified. |
| RERUN | KMS access | §F5 (the instance role is a new principal type) |
| RERUN | DynamoDB access | §F6, plus the `iam` gate's classification for the host role |
| RERUN | CloudFront edge | §H 16 (proxy hops, query strings) |
| RERUN | Money-game smoke | §H 18 |
| RERUN | Observability | `HostHealthProblems` / `HostCriticalEvents` appear and the five alarms evaluate. **Drills:** `gs-stop` for 4 minutes fires the health alarm (missing data = breaching). `aws cloudwatch set-alarm-state` on each alarm proves the notification wiring. A misspelt `GS_METRICS_PROFILE` is refused BEFORE the metric sink exists, so it fires only the health alarm, not the critical-event alarm. |
| **RETIRE** | p1/p2 flip (`flip`, `flip-alarms`, `flip-drill`) | One pool |
| RETIRE | ALB target-group / listener-rule checks (`checkPoolListenerRules`, target health) | No ALB |
| RETIRE | ECS drain-specific assertions (stop-first 0/100, AZ rebalancing, circuit breaker, `drain-pool`) | No ECS. Drain-first survives as `gs-stop`. |
| RETIRE | Multi-pool alarm checks (the L6-5B per-pool / primary matrix, suppressors, composites) | The five host alarms replace them |

**The host's control plane is verified (COST-2A):** `awsDeploy verify --topology coexist | single-host` judges the
host's evidence (`capture-host-evidence.{sh,ps1}`, read-only; the host's `gs-health` line by the operator's opt-in Run
Command; the operator's `gamesDoctor aws host-snapshot`) with three answers -- PASS, FAIL, NOT EVALUATED -- beside the
unchanged data-plane checks (and the COST-2B guard records); `--topology ecs` (the default) is L5-8 / L6-2's verifier,
untouched, for the ECS era until step I. See infra/aws/README.md "The single host". Still procedural: the DNS record of
`origin_hostname` (the owner's provider), the edge probes (§H), the money-game smoke, and the billing review (§J 25).
