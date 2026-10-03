# Migrating staging from the drained ECS topology to the single host (COST-1, reconciled by COST-2B)

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
- the only app-stack applies are (a) the **targeted** cutover (step 14, `-target=module.app.aws_cloudfront_distribution.site[0]`)
  and (b) the explicit **ECS rollback** (§F), each through its guard;
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
   It writes `<D>\terraform\<stack>\`: `plan.json`, `plan-exitcode.txt`, `version.json`, `run.json` (with the commit and
   whether `infra/aws` was clean), and the binary `stack.tfplan` with `stack.tfplan.sha256` (binding it to that
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
| 8 | ledger | `migration-guard ledger-host-authorize` | the ledger's resource policy and EVERY signing key's policy update in place, each runtime statement gaining exactly `gs-staging-host-app` beside the task role (kept: coexistence); every other statement byte-equal; no table, KMS create / delete / replace, APPGEN item or AWS Backup change |
| 9 | single-host | `migration-guard host-create` | only creates, exactly the single-host surface (one instance, ENI, EIP + association, SG + rules, role `gs-staging-host-app`, profile, inline policy, log group, the five alarms, the budget); IMDSv2; the host policy reaches only g1, identity and the ledger, never APPGEN / SYSTEM writes, digest-only Sign, no administrative action; no table, key, ALB, ECS, NAT, endpoint, distribution, ECR repository or lifecycle |
| 14 | app (targeted) | `migration-guard edge-cutover --origin-domain <origin_hostname>` | only the existing distribution, updated in place, only the `gs-alb` origin's `domain_name` -> the named host origin; default origin, behaviours (cache / origin-request policies), aliases, certificate, WAF unchanged; no ECS change (the drift), no table / key / IAM / document change; `compute = "ecs"` |
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
   `recovery_trusted_principal_arns = []`), **read-only, never applied**: it is expected to show only the
   desired-count drift (§0.2). Anything else in it (a recovery role, a document, a table) is a STOP.
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
10. `OWNER-DNS`: the A record `origin_hostname` → the `public_ip` output. It is a **new** record; `play.<domain>` is not touched.
11. Wait until Caddy has its certificate: `gs-host.ps1 -Command status` shows `origin_tls_readyz` ≠ `000`. The server is not running yet, so 503 is expected.
    - Expected noise: the `cpu-credits` alarm fires about 15 minutes after launch and clears after about 75 minutes (T4g/T3 standard mode earns no launch credits). The same happens after every host replacement.

### E. Install and start the same AWS-mode server against the existing authorities

12. Build the release image from the reviewed commit, `linux/arm64`, and push it to the existing ECR repository: `infra/aws/single-host/build-image.ps1`.
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
    node dist/server/src/tools/awsDeploy.js migration-guard edge-cutover --plan-evidence <D>\terraform\app --environment staging --app-account <app> --origin-domain <origin_hostname> --record <D>\guards\14.json
    ```
    - The plan changes **only** the distribution's `gs-alb` origin domain; the guard refuses anything else (the default
      origin, the `/gs*` behaviour and its cache / origin-request policies, the aliases, the certificate, any ECS change).
    - Apply that `stack.tfplan` (`-target` is in it: Terraform warns that the plan is incomplete; expected).
15. Wait for the distribution to deploy.

**Rollback:** the same targeted capture with the ALB's origin name in the tfvars, judged with
`migration-guard edge-cutover --origin-domain <the ALB origin name>`; then the ECS rollback of §F (the host stopped
`--until-deploy` first).

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

24. **Inventory**, read-only. **Any surplus is a HARD FAIL to fix before closing the migration.** A forgotten NAT gateway alone is about $33/month. The expected answers:
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

Run by the ONE authorized Claude Code session (or the owner), from the reviewed commit, with operator credentials allowed
`ssm:SendCommand` (AWS-RunShellScript on the host) / `ssm:GetCommandInvocation`, `ec2:DescribeInstances` /
`DescribeAddresses`, `ecs:ListTasks`, the operator role's DynamoDB reads, and its `PutItem` on `OPRUN#*` (the drill lock).
AWS CLI v2 on PATH. On Windows run `node dist/...` directly.

```
node dist/server/src/tools/awsDeploy.js host-cert <scenario> --run-id <run> --acknowledge-mutating-drill <scenario>
  --environment staging --runtime-parameter <p1 SSM ARN> --generation 1 --pool p1 --game-table gs-staging-game-g1
  --instance-id <i-...> --digest <sha256:... the serving release> --build <its build id> --source-commit <40 hex>
  --operator <who> --evidence <D>\host-cert [--reclaim-stale-lock <run>] [--before <file> --stale-instance-id <i-...>]
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

**Known limits (the COST-2C review's Low findings, NOT fixed; none can produce a false PASS):** "no server process after
the reboot" is sampled every 5 s (a process that lived between samples is caught only if it took the pool); the F9b fence
poll may end before ExecStopPost ran (NOT EVALUATED, never PASS); the reboot is `nohup ... systemctl reboot` and may be
killed with the SSM command (then F8 FAILs / F9b is NOT EVALUATED); only `/etc/systemd/system/gs-server.service.d` is
listed for foreign drop-ins (the effective `Restart=` / `RestartPreventExitStatus=` / gs-exit-hold are checked); the
rival uses the server's memory limit on a 2 GB host (an OOM kill shows as a FAIL); a lost renew answer reads as a lost
lock (the drill stops, the lock expires); the operator role in Terraform has no SSM / EC2 grants (the drill needs
credentials that have them); host command output is printed before the evidence's secret refusal; and
`replacement-after` stays NOT EVALUATED unless a stale host is reachable over SSM (the destroy-before-create
replacement normally leaves none).

**Owner validation:** `powershell -ExecutionPolicy Bypass -File .\infra\aws\single-host\run-cost2c-owner-gate.ps1`
(the complete COST-2C sweep; one log under `evidence\owner-gates\`).

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

**Not yet automated on the host** (follow-up): the control-plane half of `awsDeploy verify` and `capture-evidence` describe ECS and the ALB. For the host, the evidence is:
- the Terraform plan and state (and the COST-2B guard records);
- `aws ec2 describe-instances` / `describe-security-groups`;
- `gs-health`.

A host variant of the verifier is a small follow-up slice; the data-plane checks (`gamesDoctor aws`, `generation-gate`, probes) apply unchanged.
