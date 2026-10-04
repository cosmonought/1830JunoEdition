# P1-R3 — Legacy hosting teardown (LIVE procedure)

**Status:** a PLAN, written by PHASE 1 CLEAN-BUILD RESET (2026-10-04). Nothing here has been executed.

**Governing plan:** `infra/aws/PHASE1_CLEAN_BUILD.md` (P1-R0 … P1-R6). **Classification:** `infra/aws/PHASE1_INVENTORY.json`.

**Who runs it:** the dedicated LIVE Claude Code session (or the owner), from a clean, full clone of the reviewed commit,
`server/dist` built. **Never from Cowork.** Every step's output is saved under one evidence directory `<D>\teardown\`
(`Tee-Object`; never `-Append` onto an earlier capture).

**What it does:** removes the ECS-era hosting plane of this workload -- and only that -- from staging, then proves it is
gone.
- **It never destroys or replaces a durable authority:** the game, identity and ledger tables; the backup vault; the KMS
  keys; the SSM documents; ECR; the CloudFront distribution; the bootstrap / operator roles; the host
  (`stacks/single-host`); the VPC.
- **Its only in-place edits of them are guarded:**
  - T1 moves the distribution's `/gs*` origin domain (`edge-cutover`);
  - T3 narrows the p1 document's route table and the bootstrap / operator policies' document lists to p1
    (`compute-none`);
  - T5 removes the ECS task role's name from the ledger's resource policy and every signing-key policy
    (`ledger-task-deauthorize`).

**What it is not:** a migration. There is no coexistence proof, no rollback to ECS, no traffic choreography and no
zero-downtime requirement (`/gs*` has been offline since the pools were drained; downtime is accepted).

**Labels:** `APP-ADMIN` (Terraform / CLI in the app account), `LEDGER-ADMIN` (the ledger account), `BOOT`
(`gs-staging-bootstrap`), `OPER` (`gs-staging-operator`), `HOST-DEPLOY` (the host-deploy principal: `gs-host`),
`OWNER-DNS`. On Windows run `node dist/...` directly (PowerShell's `npm.ps1` swallows `--`).

## STOP rules (every step)

- **The first unexpected dependency, resource or state drift is a STOP.** Record what was seen; do not repair it with an
  ordinary `terraform apply`, a console edit or a retry with different flags.
- A guard that does not say **PASS** (exit 0) is a STOP: do not apply. A saved plan Terraform calls stale is captured and
  judged again, never replaced by a fresh unjudged plan.
- An apply that errors part-way is a STOP: save `terraform state list` and the error; a partially applied teardown is
  completed only by a separately reviewed path (the `compute-none` guard refuses a state it no longer recognises).
- Anything a step names "read-only" that would need a write is a STOP.
- A money game opening, a `RELAYQ#` entry appearing, an ECS task starting, a HOLD on the host or a second writer at any
  point is a STOP.
- **External Terraform stacks are never touched.** A plan, command or console action that would change a resource of a
  stack whose configuration is not in this repository is a STOP. The known stacks are rpc-proxy and network
  (`PHASE1_INVENTORY.json` `terraform_states`). The one exception is T7's separately reviewed change against the
  owning network stack.
  - The rpc-proxy distribution `E271XZAA1MQR4H` (the uni-7 RPC CORS proxy the published frontend and the Keplr money
    path use) and its two policies are only ever READ.
- A Terraform state that `PHASE1_INVENTORY.json` `terraform_states` does not list is a STOP (P1-R1's rule).

## The OWNER-GO boundary

T0 is read-only and needs no GO. **Every mutation needs its own explicit owner GO, consumed immediately before that
mutation.**
- **Batchable (reversible):** GO-T1, GO-T2, GO-T4 and GO-T5 may be sent together after T0 PASSES. Each is still
  conditional on its own guard PASS. The session executes them in order and stops at the first result that is not a PASS.
- **Never batched (irreversible):** GO-T3, GO-T6, GO-T7 and each GO-T8a–d come in their OWN owner message, sent only
  AFTER the session has posted what that GO authorises:
  - for T3: the judged compute-none plan and its destroy list (pool log data and alarm history go with it);
  - for T6: the listed log-group names;
  - for T7: the NAT evidence PASS, plus the owner's RAM / no-planned-workload confirmation;
  - for T8: that item's evidence.

Each GO names its object:

| GO | Exact text | Mutation |
|---|---|---|
| GO-T1 | `GO P1-R3 T1 edge repoint: apply <D>\teardown\t1\terraform\app\stack.tfplan (guard t1-edge.json PASS)` | the distribution's `/gs*` origin domain → the host |
| GO-T2 | `GO P1-R3 T2 unprotect ALB <ALB ARN>` (only if T0.6 read `true`) | ALB deletion protection off (outside Terraform) |
| GO-T3 | `GO P1-R3 T3 compute-none: apply <D>\teardown\t3\terraform\app\stack.tfplan (guard t3-compute-none.json PASS)` | the ECS-era destroy |
| GO-T4 | `GO P1-R3 T4 restart <instance id> on <digest> -Measure` | host stop + deploy (minutes of downtime) |
| GO-T5 | `GO P1-R3 T5 ledger-task-deauthorize: apply <D>\teardown\t5\terraform\ledger\stack.tfplan (guard PASS)` | the task role leaves the ledger and key policies |
| GO-T6 | `GO P1-R3 T6 delete log groups <each full name>` | Container Insights groups |
| GO-T7 | `GO P1-R3 T7 delete NAT <nat-...> and release <eipalloc-...> (nat guard PASS; R1: not Terraform-owned)` -- ONLY on T7's "proven NOT Terraform-owned" path | the NAT gateway and its EIP |
| GO-T8a / T8b / T8c / T8d | `GO P1-R3 T8a delete DNS <name>` / `T8b delete certificate <ARN>` / `T8c delete table gs-staging-game-g2` / `T8d deregister task definitions <the listed revision ARNs>` | legacy leftovers |

A GO for an object other than the one T0 / the guard recorded is not a GO.

## T0 — Read-only preconditions (no GO)

Save everything under `<D>\teardown\t0\`.

0.1 **Checkout.** A clean, full clone of the reviewed commit (`git rev-parse HEAD`, `git status --porcelain` empty;
    `git cat-file -e 5b4756dbd98e8d9abe5ed4bbdf4314466ef8045d^{commit}` succeeds), `server` built. Record the sha: it is the
    `--commit` of T1, T3 and T5.
0.2 **R1 is done.** The P1-R1 read-only inventory record exists and placed every live resource in
    `PHASE1_INVENTORY.json`. Anything it left unplaced: STOP.
0.3 **Money and relay quiescence** (`OPER`):
    - `node dist/server/src/tools/gamesDoctor.js aws games --money --aws-config <runtime p1 ARN>`: no open money game;
    - `aws dynamodb query --table-name gs-staging-game-g1 --key-condition-expression "pk = :p" --expression-attribute-values '{":p":{"S":"RELAYQ#<relayer address>"}}' --consistent-read --select COUNT`: `Count: 0`;
    - `node dist/server/src/tools/gamesDoctor.js aws status --aws-config <runtime p1 ARN>`: APPGEN 1, the routing names
      p1, POOL#p1 / the identity writer / the relayer held by the host's current task, no HOLD.
0.4 **The ECS era is drained** (`APP-ADMIN`, read-only):
    - `aws ecs describe-services --cluster gs-staging --services gs-staging-p1 gs-staging-p2 --query "services[].[serviceName,desiredCount,runningCount,pendingCount]" --output text`: both `0 0 0`;
    - `aws ecs list-tasks --cluster gs-staging`: empty;
    - `aws elbv2 describe-target-health --target-group-arn <each of gs-staging-p1 / gs-staging-p2>`: no target.
0.5 **p2 is retired, with evidence** (so R3 / R4 / R6 are judged: no game names p2, no unclaimed money game):
    ```
    infra/aws/scripts/capture-evidence.sh staging <region> p1 <distribution id> <D>/teardown/t0/retire-p2 p2      # BOOT
    cd server
    node dist/server/src/tools/gamesDoctor.js aws retire-check p2 --evidence <D>/teardown/t0/retire-p2 --aws-config <runtime p1 ARN>      # OPER
    ```
    (Windows: `capture-evidence.ps1`, same arguments.) It must print `retire-check p2 (READ-ONLY) -- RETIRED`.
    `READY-TO-DRAIN` or `BLOCKED`: STOP.
0.6 **The ALB's LIVE deletion protection** (never inferred from the module default `true` or the tfvars):
    ```
    aws elbv2 describe-load-balancers --names gs-staging-alb --query "LoadBalancers[0].LoadBalancerArn" --output text
    aws elbv2 describe-load-balancer-attributes --load-balancer-arn <that ARN> --query "Attributes[?Key=='deletion_protection.enabled'].Value" --output text
    ```
    `false`: T2 is skipped. `true`: T2 is required. No answer, an error, or not exactly one load balancer: STOP.
0.7 **The ARM64 execution proof of the serving release.** Step 12b's saved capture (`arm64-live-smoke.txt`), unedited,
    for the digest the host serves. T1.3's guard judges it (`--arm64-live-smoke`): anything but PASS stops T1. A different
    serving digest needs a new 12b run first (`gs-host -Command arm64-smoke`, its own GO).
0.8 **Evidence that T3 and T5 destroy** -- REQUIRED, unless the owner records a decision to discard an item. All of it
    is read-only to AWS and saved under `<D>\teardown\t0\export\`:
    - the pool log groups: `aws logs filter-log-events --log-group-name /gs/staging/p1 --output json > logs-p1.json`
      (and p2);
    - the alarms' history (CloudWatch keeps 30 days; the CLI pages it itself):
      `aws cloudwatch describe-alarm-history --alarm-types MetricAlarm CompositeAlarm --output json > alarm-history.json`
      (the `-notify` composites included);
    - the state, now and again immediately before T3's and T5's captures (T3.0, T5.0):
      - `terraform -chdir=infra/aws/stacks/app state pull > app.tfstate.json`;
      - `terraform -chdir=infra/aws/stacks/ledger state pull > ledger.tfstate.json` (`LEDGER-ADMIN`).

      These are evidence files: under Windows PowerShell 5.1, `>` writes UTF-16, which is acceptable here.
    T3 deletes the log groups and alarms; their data is not recoverable afterwards.
0.9 **Terraform reads** (each `terraform plan` is read-only and is NEVER applied):
    - `terraform -chdir=infra/aws/stacks/app state list` → saved. It must hold the ECS-era addresses of the inventory's
      `DELETE-LEGACY` Terraform entries and the authorities -- nothing else foreign;
    - `stacks/app` planned with the CURRENT tfvars plus `compute = "ecs"` (now required: state it): expected to show ONLY
      the desired-count drift (§0.2 of `SINGLE_HOST_MIGRATION.md`: a service 0 → 1, or its destroy with
      `start_services = false`). Anything else -- a policy, a document, a table, a role, the distribution -- is drift: STOP;
    - `stacks/ledger` planned with the current tfvars plus `ecs_task_role_authorized = true` (now required): no changes;
    - `stacks/single-host` planned from a clean checkout of **5b4756d** with its live tfvars: no changes. (From any later
      commit the plan REPLACES the instance -- the 13r scripts -- which is not a teardown action.)
0.10 **The NAT** (`APP-ADMIN`, read-only):
    - its id, VPC, subnet and allocation id;
    - every route table routing to it (`aws ec2 describe-route-tables --filters Name=route.nat-gateway-id,Values=<nat-...>`);
    - which of those tables also carry the gateway endpoints (network.private_route_table_ids);
    - **T_drain**, the end of this workload's last NAT use. It is proven only by BOTH:
      - the ECS service events of both services
        (`aws ecs describe-services --cluster gs-staging --services gs-staging-p1 gs-staging-p2 --query "services[].events[0:20]"`)
        showing the last service task stopped, with 0.4's empty task list;
      - no standalone task since then (the run-*-probe scripts' `RunTask`s): `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunTask --start-time <T_drain>`
        and the same for `StartTask` names no `gs-staging` cluster.
    - T_drain is **unproven** if the events no longer reach back to it, if T_drain is more than 60 days old (CloudWatch's
      1,440 hourly points), or if CloudTrail's 90-day history does not cover it. T7 then anchors at T3.
    - **its ownership, as P1-R1 proved it from the states' contents:** whether the NAT gateway and its EIP are members of
      `network.tfstate` (or of any other listed state), or proven outside Terraform, or unproven. T7's path follows from
      this answer.
0.11 **The external stacks, unchanged and accounted for** (read-only):
    - R1's record lists EVERY staging state object, each mapped in `PHASE1_INVENTORY.json` `terraform_states`; any other
      state is a STOP;
    - `aws cloudfront get-distribution --id E271XZAA1MQR4H --query "[ETag, Distribution.Status, Distribution.DistributionConfig.Origins.Items[0].DomainName]"`
      → its ETag, `Deployed`, `juno.rpc.t.stavr.tech` (T9 compares the same answer);
    - each external state object's metadata, `aws s3api head-object --bucket gs-staging-tfstate-992163310414 --key gs/staging/rpc-proxy.tfstate --query "[ETag, LastModified]"`
      (and `.../network.tfstate`). This is metadata only; the state's contents are never saved.

**T0 PASSES** only when 0.1–0.11 all hold. Then the owner's GO lines.

## T1 — Repoint CloudFront `/gs*` at the host (GO-T1)

The existing guard is reused unchanged, forward only. It requires `compute = "ecs"` and the `compute-none` guard forbids
any distribution change, so **this is the first mutation and precedes T3** (and the ALB must stop being an origin before
it is destroyed).

1. App tfvars: `edge.alb_origin_domain_name = "<origin_hostname>"` (the host's, e.g. `gs-origin-host.netadao.org`),
   `compute = "ecs"`, break-glass off; nothing else changed.
2. Capture, targeted:
   ```
   infra\aws\scripts\plan-evidence.ps1 -Stack app -Out <D>\teardown\t1 -Run <run id> -KeepPlan -PlanArgs @("-var-file=staging.tfvars", "-target=module.app.aws_cloudfront_distribution.site[0]")
   ```
3. Judge:
   ```
   node dist/server/src/tools/awsDeploy.js migration-guard edge-cutover --plan-evidence <D>\teardown\t1\terraform\app --environment staging --app-account <app> --origin-domain <origin_hostname> --arm64-live-smoke <the 12b capture> --release-digest <the serving sha256> --instance-id i-01fe56536bf591382 --commit <T0.1 sha> --record <D>\teardown\guards\t1-edge.json
   ```
   PASS: only the `gs-alb` origin's `domain_name` moves to the host; nothing else of the distribution, no ECS, table, key,
   IAM or document change. The plan is the app stack's, targeted at `module.app.aws_cloudfront_distribution.site[0]`;
   the rpc-proxy distribution `E271XZAA1MQR4H` lives in another state, so it can never appear in it. A plan naming any
   other distribution is a STOP.
4. **GO-T1**, then `terraform -chdir=infra/aws/stacks/app apply <D>\teardown\t1\terraform\app\stack.tfplan` (Terraform
   warns that `-target` makes the plan incomplete: expected).
5. `aws cloudfront wait distribution-deployed --id <distribution id>` (re-run on a timeout; never continue on a timeout),
   then `aws cloudfront get-distribution --id <distribution id> --query "Distribution.Status" --output text` → `Deployed`.
6. Sanity (read-only): `https://play.<domain>/gs/readyz` answers 200 through the edge. The judged edge proof is R5-F.

There is no rollback to the ALB: a `/gs*` failure after T1 is diagnosed forward (host, Caddy, DNS, the distribution),
never by restarting ECS.

## T2 — The ALB's deletion protection (GO-T2; only if T0.6 read `true`)

AWS would refuse the ALB's delete part-way through T3, after the rest of the ECS era is gone, leaving a state the
`compute-none` guard no longer accepts. Turn it off outside Terraform (reversible; an ordinary app-stack apply stays
forbidden while the desired-count drift exists):
```
aws elbv2 modify-load-balancer-attributes --load-balancer-arn <the T0.6 ARN> --attributes Key=deletion_protection.enabled,Value=false
aws elbv2 describe-load-balancer-attributes --load-balancer-arn <the T0.6 ARN> --query "Attributes[?Key=='deletion_protection.enabled'].Value" --output text      # false
```
Terraform's state still remembers `true`; T3's plan destroys the ALB regardless (the guard judges the delete). Any other
answer: STOP.

## T3 — Destroy the ECS era: `compute-none` (GO-T3)

0. `terraform -chdir=infra/aws/stacks/app state pull > <D>\teardown\t3\app.tfstate.before.json` (the state T3 changes).
1. App tfvars (the inventory's `final_state."stacks/app"`): `compute = "none"`, `start_services = true`,
   `pools = { p1 = { primary = true } }`, `generation = 1`, `game_generations` without 2, `recovery_break_glass = false`,
   `recovery_trusted_principal_arns = []`, `edge.alb_origin_domain_name` = the host's origin (as T1 left it).
   `start_services = true` is REQUIRED: under `compute = "none"` it turns on the plan-time gates (SYSTEM/ROUTING names
   p1; g1's SYSTEM/GENERATION marker).
2. Capture, **untargeted**:
   ```
   infra\aws\scripts\plan-evidence.ps1 -Stack app -Out <D>\teardown\t3 -Run <run id> -KeepPlan -PlanArgs @("-var-file=staging.tfvars")
   ```
3. Judge:
   ```
   node dist/server/src/tools/awsDeploy.js migration-guard compute-none --plan-evidence <D>\teardown\t3\terraform\app --environment staging --app-account <app> --commit <T0.1 sha> --record <D>\teardown\guards\t3-compute-none.json
   ```
   PASS: every ECS-era object in the state destroyed and nothing else (the ECS services, task definitions and cluster;
   the ALB, listener, rules and target groups; the ALB / task / endpoint security groups and rules; the gateway and
   interface endpoints; the pool log groups; the L6-5B alarms, composites and flip suppressors; the task and execution
   roles; p2's runtime document); the p1 document only loses p2's route; the bootstrap / operator policies only lose
   p2's document; never a table, a key, the p1 or Juno document, ECR, the distribution or the bootstrap / operator
   authority; nothing created; both plan-time gates read.
4. The session posts the guard record and the plan's destroy list. The owner reads it against the inventory's
   `DELETE-LEGACY` Terraform entries.
5. **GO-T3** -- its own owner message, after step 4 -- then `terraform -chdir=infra/aws/stacks/app apply <D>\teardown\t3\terraform\app\stack.tfplan`. **Record
   the apply-complete UTC time** in `<D>\teardown\guards\t3-applied-at.txt` at the moment it finishes.
6. `terraform -chdir=infra/aws/stacks/app state list` → saved: no ECS-era address remains.

## T4 — Restart the host onto the p1-only runtime document (GO-T4)

The server reads its runtime document at startup only; T3 removed p2's route from it.
```
.\infra\aws\single-host\gs-host.ps1 -Command stop -InstanceId i-01fe56536bf591382 -Region <r> 6>&1 | Tee-Object <D>\teardown\t4\stop.txt
.\infra\aws\single-host\gs-host.ps1 -Command deploy -InstanceId i-01fe56536bf591382 -Region <r> -Digest <the serving sha256> -BuildId <its build> -Measure 6>&1 | Tee-Object <D>\teardown\t4\deploy.txt
.\infra\aws\single-host\gs-host.ps1 -Command status -InstanceId i-01fe56536bf591382 -Region <r> 6>&1 | Tee-Object <D>\teardown\t4\status.txt
```
PASS: `…is READY`; `server` and `caddy` active; healthz / readyz / `origin_tls_readyz` 200; digest = running digest; the
build; `hold none`; `static_credentials none`; the log stream shows `PRIMARY`, `pool p1 TAKEN`, `identity-writer role
TAKEN`, `relayer role TAKEN`, `Juno backend OPENED`, the sweep and `ready`. `-Measure` is required (a deploy without it
writes `GS_MEASURE=0` and stops the memory measurement). Any STOP signal of runbook step 13 (a HOLD, `Refusing to start`,
`NON-PRIMARY`, a restart loop): STOP.

## T5 — The task role leaves the ledger and every key policy (GO-T5)

Deleting `gs-staging-app-task` (T3) invalidated nothing -- every cross-account grant names the app account root with an
`aws:PrincipalArn` condition -- but until this step a NEW role of that name would inherit ledger appends and KMS Sign.
0. `LEDGER-ADMIN`: `terraform -chdir=infra/aws/stacks/ledger state pull > <D>\teardown\t5\ledger.tfstate.before.json`.
1. Ledger tfvars: `app_runtime_role_arns = ["arn:aws:iam::<app>:role/gs-staging-host-app"]`,
   `ecs_task_role_authorized = false` (the stack now requires the line).
2. `LEDGER-ADMIN`: `infra\aws\scripts\plan-evidence.ps1 -Stack ledger -Out <D>\teardown\t5 -Run <run id> -KeepPlan -PlanArgs @("-var-file=staging.tfvars")`
3. `node dist/server/src/tools/awsDeploy.js migration-guard ledger-task-deauthorize --plan-evidence <D>\teardown\t5\terraform\ledger --environment staging --app-account <app> --commit <T0.1 sha> --record <D>\teardown\guards\t5-ledger.json`
   PASS: the task role leaves exactly the runtime statements of the ledger's resource policy and of every signing key's
   policy; the host role stays; nothing else moves.
4. **GO-T5**, then `terraform -chdir=infra/aws/stacks/ledger apply <D>\teardown\t5\terraform\ledger\stack.tfplan`.

R5-D re-runs the host's KMS and DynamoDB probes after this step (every key policy changed).

## T6 — The Container Insights log groups (GO-T6, naming each group)

CloudWatch created them itself; no Terraform state holds them; T3 stopped their ingestion but did not delete them, and
`verify --topology single-host` FAILS while one exists.
1. `aws logs describe-log-groups --log-group-name-prefix /aws/ecs/containerinsights/gs-staging/ --query "logGroups[].[logGroupName,storedBytes,retentionInDays]" --output text`
   → `<D>\teardown\t6\before.txt`. A group outside that prefix is never in scope.
2. Optional export of what must be kept (deletion is irreversible).
3. **GO-T6** -- its own owner message, naming each group step 1 listed -- then `aws logs delete-log-group --log-group-name <full name>` for each -- never a
   wildcard -- and list the prefix again: empty (`<D>\teardown\t6\after.txt`).

## T7 — The NAT gateway: ownership first, then evidence (fail closed)

The NAT is not this repository's Terraform (inventory `outside.nat-gateway`, **REVIEW**). It may be a member of the
external network stack's state, `s3://gs-staging-tfstate-992163310414/gs/staging/network.tfstate`. It is deleted only
when BOTH hold:
- its ownership path allows a deletion;
- the evidence gate proves no other workload uses it.

This wait is evidence about OTHER users, not migration continuity. R4 and R5 proceed meanwhile (R5's A1 names the
pending NAT as PROVISIONAL); it delays only R5's closure record Z and R6.

**Ownership first (T0.10, from P1-R1's enumeration of every state):**
- **Terraform-owned** -- the NAT or its EIP is in `network.tfstate`, or in any other listed state:
  - **no direct AWS deletion**: no `delete-nat-gateway`, no `release-address` and no console action, because each would
    leave the owning state stale;
  - the deletion is a separately reviewed change against the OWNING stack, outside this repository. Its exact plan must
    show only the NAT / NAT-EIP removals plus the expected route-table consequences (the private tables' default route
    to the NAT);
  - the >= 24 h post-T3 evidence below must PASS first, and the owner's GO comes after both;
  - this repository defines no such change. T7 records its plan, its review and its result.
- **Proven NOT Terraform-owned** (in no listed state, and R1 proved it): the evidence path below, then step 4's direct
  deletion.
- **Ownership unproven** -- a state could not be read or enumerated, or the answer is ambiguous: **T7 is BLOCKED.**
  - The NAT stays, provisionally.
  - R5 continues, with A1 naming it PROVISIONAL.
  - R6's final closure waits until the ownership is resolved, or until the owner explicitly amends the closure policy.
- On every path, the VPC, its subnets, route tables and IGW are never deleted (`outside.vpc`, KEEP).

**The window.**
- `capture-nat-evidence`'s `TeardownAppliedAt` argument is the start of the quiet window. The guard needs >= 24 whole
  hours, all zero, from it to the capture.
- Give it **T_anchor = T_drain** when T0.10 proved it, otherwise T3's recorded apply time. Since the drain, this
  workload has sent nothing through the NAT: the host sits in a public subnet behind the internet gateway, and the
  endpoints and the ALB never route through a NAT. So traffic anywhere in the window is another user's, and the gate FAILS.
- **The capture runs no earlier than 24 whole hours after T3's recorded apply time, whatever T_anchor is.** T3 removes the
  gateway endpoints from the shared private route tables. A workload there that only talks to S3 or DynamoDB used the
  endpoints until T3 and would use the NAT after it, so the window must include >= 24 h of the post-T3 routing.
- **Checked by hand, not by the guard.** No tool compares the window with T3, and `capture-nat-evidence` floors the
  window's end to the hour. Before step 2, check that `capture.json`'s `metrics_end` ≥ T3's apply time
  (`t3-applied-at.txt`) rounded UP to the hour, plus 24 h. Record both values in the guard record's notes. A capture
  earlier than that is discarded and taken again later.
- An earlier start adds evidence. It never shortens the post-T3 observation. N1–N6 and the 24-hour minimum are unchanged
  (the CLI refuses a quiet minimum below 24 hours).

1. At or after ceil_hour(T3) + 24 h (T3's apply time rounded up to the hour, plus 24 h: the floored `metrics_end` then
   covers >= 24 whole post-T3 hours):
   `infra\aws\scripts\capture-nat-evidence.ps1 -Environment staging -Region <r> -NatGatewayId <nat-...> -VpcId <vpc-...> -TeardownAppliedAt <T_anchor, UTC> -Out <D>\teardown\t7\nat`
   (`.sh` on Linux).
2. `node dist/server/src/tools/awsDeploy.js migration-guard nat --evidence <D>\teardown\t7\nat --record <D>\teardown\guards\t7-nat.json`
   must say `COST-2B NAT DELETION EVIDENCE: PASS`.
3. The owner confirms in the record's notes what evidence cannot prove: the VPC is not RAM-shared with another account,
   and no planned workload is waiting for this NAT.
4. The session posts 1–3 and the ownership answer.
   - **ONLY on the "proven NOT Terraform-owned" path**, then on **GO-T7** (its own owner message):
     - `aws ec2 delete-nat-gateway --nat-gateway-id <nat-...>`;
     - `aws ec2 wait nat-gateway-deleted --nat-gateway-ids <nat-...>`;
     - `aws ec2 release-address --allocation-id <its eipalloc-...>`.

     The private route tables keep a blackhole default route: harmless, and Phase 1 deletes no route table
     (`outside.vpc` is KEEP).
   - **Terraform-owned:** STOP here. The separately reviewed change against the owning stack, with its own GO, replaces
     this step.
   - **Unproven:** T7 is BLOCKED (above).

**A FAIL keeps the NAT.** It is then another workload's (or not yet proven quiet): record it, and the owner decides
whether it is excluded from this workload's cost (R6 item 6) or investigated. Never delete it on a FAIL.

## T8 — Legacy leftovers outside Terraform's state (one GO each, its own message)

- **T8a** (`OWNER-DNS`): delete the ALB's origin DNS name (the `gs-alb` origin domain T1 replaced, recorded by R1).
  Required for R6 (inventory `DELETE-LEGACY`); costs nothing either way.
- **T8b** (`APP-ADMIN`): the ALB listener's ACM certificate (the app tfvars' `alb.certificate_arn`):
  `aws acm describe-certificate --certificate-arn <ARN> --query "Certificate.InUseBy"` must be `[]`; then
  `aws acm delete-certificate --certificate-arn <ARN>`. Required for R6. The `alb` block stays in the tfvars as an inert
  input (no resource reads it under `compute = "none"`).
- **T8c** (`APP-ADMIN`, optional, owner decision; inventory `outside.g2-table`, `DELETE-MIGRATION`): delete
  `gs-staging-game-g2` only after every precondition the inventory lists is re-proven in this session and its evidence
  (`aws dynamodb describe-table --table-name gs-staging-game-g2`, the item count, an on-demand backup only if the owner
  wants one) is saved. `DeletionProtectionEnabled = true` is a STOP. Then
  `aws dynamodb delete-table --table-name gs-staging-game-g2`. Irreversible without a backup. Not an R6 blocker.
- **T8d** (`APP-ADMIN`): the ECS task-definition revisions. The module sets `skip_destroy = true` (the circuit breaker
  rolled back to earlier revisions), so T3 only removed them from Terraform's state and every `gs-staging-p1` /
  `gs-staging-p2` revision is still ACTIVE: inert without a cluster, but each still names the deleted task / execution
  roles.
  1. List them: `aws ecs list-task-definitions --family-prefix gs-staging-p --status ACTIVE --output text`. Save the
     list; only the `gs-staging-p1` / `gs-staging-p2` families are in scope (R1 placed anything else).
  2. On **GO-T8d** naming the listed ARNs: `aws ecs deregister-task-definition --task-definition <each ARN>`.
  3. List again: empty.

  Deregistration cannot be undone, but Terraform re-registers a revision if one is ever needed. Required for R6
  (inventory `DELETE-LEGACY`); costs nothing either way.

## T9 — Prove the legacy plane is gone (read-only)

Each answer saved under `<D>\teardown\t9\`:

| Check | Command | Expected |
|---|---|---|
| ALB | `aws elbv2 describe-load-balancers --names gs-staging-alb` | `LoadBalancerNotFound` |
| target groups | `aws elbv2 describe-target-groups --names gs-staging-p1 gs-staging-p2` | `TargetGroupNotFound` |
| ECS | `aws ecs describe-clusters --clusters gs-staging --query "clusters[].status"` | `INACTIVE` or nothing |
| task definitions | `aws ecs list-task-definitions --family-prefix gs-staging-p --status ACTIVE` | none (T8d) |
| endpoints | `aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=<vpc-...>` | none (or only those R1 placed as another workload's) |
| ECS-era SGs | `aws ec2 describe-security-groups --filters Name=group-name,Values=gs-staging-alb,gs-staging-task,gs-staging-endpoints` | none |
| roles | `aws iam get-role --role-name gs-staging-app-task` / `gs-staging-app-execution` | `NoSuchEntity` |
| p2 document | `aws ssm get-parameter --name /gs/staging/runtime/p2` | `ParameterNotFound` |
| log groups | `aws logs describe-log-groups --log-group-name-prefix /gs/staging/` | only `/gs/staging/host` |
| Container Insights | `aws logs describe-log-groups --log-group-name-prefix /aws/ecs/containerinsights/gs-staging/` | none |
| alarms | `aws cloudwatch describe-alarms --alarm-name-prefix gs-staging --alarm-types MetricAlarm CompositeAlarm` | exactly the five `gs-staging-host-*` metric alarms, no composite |
| NAT | `aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=<vpc-...> Name=state,Values=pending,available` | none, or the one T7 kept / BLOCKED / left to the owning stack's reviewed change (recorded) |
| EIPs | `aws ec2 describe-addresses` | the host's EIP, plus only the NAT's EIP while T7 keeps or blocks it, and the addresses R1 placed as other workloads'; no unassociated address |
| rpc-proxy | `aws cloudfront get-distribution --id E271XZAA1MQR4H --query "[ETag, Distribution.Status, Distribution.DistributionConfig.Origins.Items[0].DomainName]"` | T0.11's answer, unchanged (same ETag, `Deployed`, `juno.rpc.t.stavr.tech`) |
| external states | `aws s3api head-object --bucket gs-staging-tfstate-992163310414 --key gs/staging/rpc-proxy.tfstate --query "[ETag, LastModified]"` (and `network.tfstate`) | T0.11's answer, unchanged -- `network.tfstate` changes only through T7's separately reviewed change, if one ran |
| ledger | `LEDGER-ADMIN`: `aws dynamodb get-resource-policy --resource-arn <ledger ARN>`; `aws kms get-key-policy --key-id <each signing key> --policy-name default` | no `gs-staging-app-task`; `gs-staging-host-app` present |
| state | `terraform -chdir=infra/aws/stacks/app state list` | no ECS-era address |

Then P1-R4 and P1-R5 (`PHASE1_CLEAN_BUILD.md`): R5-A's `verify --topology single-host` is the judged form of this table.
