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

**The critical path is T3** (owner, 2026-10-04): "The T3 fast path" below. Nothing that does not bear on T3's own
safety waits in front of it, and nothing is relaxed for it.

**Labels:** `APP-ADMIN` (Terraform / CLI in the app account), `LEDGER-ADMIN` (the ledger account), `BOOT`
(`gs-staging-bootstrap`), `OPER` (`gs-staging-operator`), `HOST-DEPLOY` (the host-deploy principal: `gs-host`),
`OWNER-DNS`. On Windows run `node dist/...` directly (PowerShell's `npm.ps1` swallows `--`). Run the AWS CLI from
PowerShell; under Git Bash set `MSYS_NO_PATHCONV=1` first (MSYS rewrites arguments such as `/gs/staging/p1` into
Windows paths).

## STOP rules (every step)

- **The first unexpected dependency, resource or state drift is a STOP.** Record what was seen; do not repair it with an
  ordinary `terraform apply`, a console edit or a retry with different flags.
- A guard that does not say **PASS** (exit 0) is a STOP: do not apply. A saved plan Terraform calls stale is captured and
  judged again, never replaced by a fresh unjudged plan.
- An apply that errors part-way is a STOP: save `terraform state list` and the error; a partially applied teardown is
  completed only by a separately reviewed path (the `compute-none` guard refuses a state it no longer recognises).
- Anything a step names "read-only" that would need a write is a STOP.
- A read that errors is a STOP, never an empty answer ("none", "no match", `[]`).
- A money game opening, a `RELAYQ#` entry appearing, an ECS task starting, a HOLD on the host or a second writer at any
  point is a STOP.
- **External Terraform stacks are never touched.** A plan, command or console action that would change a resource of a
  stack whose configuration is not in this repository is a STOP. The known stacks are rpc-proxy and network
  (`PHASE1_INVENTORY.json` `terraform_states`). The one exception is T7's separately reviewed change against the
  owning network stack.
  - The rpc-proxy distribution `E271XZAA1MQR4H` (the uni-7 RPC CORS proxy the published frontend and the Keplr money
    path use) and its two policies are only ever READ.
  - T3's removal of this repository's own gateway endpoints, and with them their routes in the private route tables, is
    not a change to the network stack (T3 step 3).
  - Another stack's state is read only by T0.11's streaming form. Never `terraform init` in `infra/aws/stacks/*`
    against another stack's key, never `-migrate-state` or `-force-copy`, never a plan or apply of an external stack.
- A Terraform state that `PHASE1_INVENTORY.json` `terraform_states` does not list is a STOP (P1-R1's rule).

## The OWNER-GO boundary

T0 is read-only and needs no GO. **Every mutation needs its own explicit owner GO, consumed immediately before that
mutation.**
- **Batchable (reversible):** GO-T1, GO-T2, GO-T4 and GO-T5 may be sent together after T0 part A PASSES. Each is
  still conditional on its own guard PASS, and GO-T4 / GO-T5 also on T0 part B's items for their step. The session
  executes them in order and stops at the first result that is not a PASS.
- **Never batched (irreversible):** GO-T3, GO-T6, GO-T7 and each GO-T8a–d come in their OWN owner message, sent only
  AFTER the session has posted what that GO authorises:
  - for T3: `READY FOR GO-T3` (T3 step 4): the judged compute-none plan and its destroy list (pool log data and alarm
    history go with it);
  - for T6: the listed log-group names;
  - for T7: R1's ownership answer, the NAT evidence PASS, and the owner's RAM / no-planned-workload confirmation. GO-T7
    exists only on T7's "proven NOT Terraform-owned" path. A Terraform-owned NAT's removal has its own GO, which names
    the reviewed external plan and never uses GO-T7's text;
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

## The T3 fast path (owner priority, 2026-10-04)

T3 (`compute = "none"`) is the critical path: it runs as soon as it is proven safe. Nothing that does not bear on T3's
own safety waits in front of it, and nothing here relaxes a guard, a STOP rule or a GO.

**The sequence, from a fresh R1:**
1. P1-R1 part A (`PHASE1_CLEAN_BUILD.md` §3) and every `[PRE-T3]` item of T0, read-only, with T0's
   `[CAPTURE BEFORE T3]` reads. The session posts `T0-A: PASS` with the evidence.
2. The owner sends GO-T1, plus GO-T2 if T0.6 read `true` (both reversible: one message may carry both).
3. T1: the targeted plan, its guard PASS, the apply, `Deployed`, `/gs/readyz` 200 through the edge.
4. T2, only if T0.6 read `true`.
5. T3 steps 0–3: the state pull, the final tfvars, the untargeted capture, the guard PASS and the casualty re-check.
6. T3 step 4: the session posts `READY FOR GO-T3`, then waits.
7. GO-T3, in its own owner message; then T3 steps 5–6.

**T1 is a prerequisite of T3, forced by the guards.** The `edge-cutover` guard requires `compute = "ecs"`; the
`compute-none` guard refuses any distribution change; and T3 destroys the ALB that `/gs*` names until T1 moves it.
**T2 is a prerequisite only if T0.6 read `true`:** otherwise AWS would refuse the ALB's delete part-way through T3.

**`READY FOR GO-T3`** is posted only when all of these hold, each with its saved evidence:
- every `[PRE-T3]` item of T0;
- T1 applied; the distribution `Deployed`; `/gs/readyz` 200 through the edge;
- T2 applied and read back `false` -- or skipped because T0.6 read `false`;
- T3.0's state pull; T3.2's untargeted plan; T3.3's guard record PASS and its casualty re-check clean;
- T0.3's money, relay and HOLD reads, repeated just before the post: unchanged;
- the plan's destroy list, each line matched to an inventory `DELETE-LEGACY` Terraform entry.

The post names the plan file, its sha256 (`stack.tfplan.sha256`) and the exact GO-T3 line. It is the earliest point the
owner can issue GO-T3, and GO-T3 may follow it at once.

**Not a T3 blocker.** Each of these may stay provisionally unresolved until after T3. Each must hold before the step it
names:
- the network stack's contents beyond T0.12's overlap check: what it owns, and which stack holds the VPC, subnets, route
  tables and IGW (T7, R6);
- the NAT and the NAT EIP: their ownership, tags and CloudTrail record, T_drain, and the >= 24 h window (T7, which
  follows T3 in any case);
- the ledger state pull and the ledger plan (T5);
- the single-host plan from `5b4756d`, the host's rendered configuration and its script hashes (R4);
- the rpc-proxy's cost facts, the backup vault's key and any on-demand backups (R6 item 6);
- T4–T9, R4, R5 and R6; g2 (T8c); Phase-3 / v13 work.

## T0 — Read-only preconditions (no GO)

Save everything under `<D>\teardown\t0\`. Each item is tagged:
- **`[PRE-T3]`:** T1, T2 or T3 depends on it. It MUST hold before T1, and `READY FOR GO-T3` restates it. A failure is
  a STOP.
- **`[CAPTURE BEFORE T3]`:** a cheap read of something T3 destroys or changes. It is taken in the same pass and judged
  later. A missed capture never blocks T3; it weakens only the later evidence it names.
- **`[AFTER T3 OK]`:** a later step needs it, so it may stay provisionally unresolved until after T3. It never blocks
  T1, T2 or T3, and it must hold before the step it names.

| Item | Tag | Needed by |
|---|---|---|
| 0.1 the checkout | `[PRE-T3]` | T1, T3, T5 (`--commit`) |
| 0.2 R1 part A | `[PRE-T3]` | every step |
| 0.3 money / relay quiescence; the host serving | `[PRE-T3]` | T1, T3 |
| 0.4 the ECS era drained | `[PRE-T3]` | T3 |
| 0.5 p2 retired | `[PRE-T3]` | T3 (it deletes p2's document) |
| 0.6 the ALB's deletion protection | `[PRE-T3]` | T2, T3 |
| 0.7 the ARM64 execution proof | `[PRE-T3]` | T1's guard |
| 0.8 the pool logs, the alarm history, the app state | `[PRE-T3]` | T3 destroys them |
| 0.8 the ledger state | `[AFTER T3 OK]` | T5 |
| 0.9 the app state list and its plan | `[PRE-T3]` | T1, T3 |
| 0.9 the ledger plan | `[AFTER T3 OK]` | T5 |
| 0.9 the single-host plan | `[AFTER T3 OK]` | R4 item 2 |
| 0.10 the services' events; the VPC's route tables | `[CAPTURE BEFORE T3]` | T7 (T_drain; the routes T3 removes) |
| 0.10 the NAT's facts, T_drain and ownership | `[AFTER T3 OK]` | T7 |
| 0.11 every state mapped and read; the rpc-proxy | `[PRE-T3]` | T1, T3, T9 |
| 0.12 the T3 casualty check | `[PRE-T3]` | T3 |

0.1 **Checkout.** `[PRE-T3]` A clean, full clone of the reviewed commit (`git rev-parse HEAD`, `git status --porcelain`
    empty; `git cat-file -e 5b4756dbd98e8d9abe5ed4bbdf4314466ef8045d^{commit}` succeeds), `server` built. Record the sha:
    it is the `--commit` of T1, T3 and T5.
0.2 **R1 part A is done.** `[PRE-T3]` The P1-R1 record (`PHASE1_CLEAN_BUILD.md` §3, part A) maps every Terraform state
    object and places every live resource of the app account in `PHASE1_INVENTORY.json`. Anything it left unplaced:
    STOP, unless §3's provisional placement covers it (an owner ruling: REVIEW, never a DELETE class). R1 part B may
    still be open; each of its items names the later step it gates.
0.3 **Money and relay quiescence; the host serving.** `[PRE-T3]`
    - `node dist/server/src/tools/gamesDoctor.js aws games --money --aws-config <runtime p1 ARN>` (`OPER`): no open
      money game;
    - `aws dynamodb query --table-name gs-staging-game-g1 --key-condition-expression "pk = :p" --expression-attribute-values '{":p":{"S":"RELAYQ#<relayer address>"}}' --consistent-read --select COUNT`: `Count: 0`;
    - `node dist/server/src/tools/gamesDoctor.js aws status --aws-config <runtime p1 ARN>`: APPGEN 1, the routing names
      p1, POOL#p1 / the identity writer / the relayer held by the host's current task, no HOLD;
    - `.\infra\aws\single-host\gs-host.ps1 -Command status -InstanceId i-01fe56536bf591382 -Region <r>`
      (`HOST-DEPLOY`): `…is READY`, `hold none`, and the digest it serves (0.7's).
0.4 **The ECS era is drained** (`APP-ADMIN`, read-only). `[PRE-T3]`
    - `aws ecs describe-services --cluster gs-staging --services gs-staging-p1 gs-staging-p2 --query "services[].[serviceName,desiredCount,runningCount,pendingCount]" --output text`: both `0 0 0`;
    - `aws ecs list-tasks --cluster gs-staging`: empty;
    - `aws elbv2 describe-target-health --target-group-arn <each of gs-staging-p1 / gs-staging-p2>`: no target.
0.5 **p2 is retired, with evidence** (so R3 / R4 / R6 are judged: no game names p2, no unclaimed money game).
    `[PRE-T3]`
    ```
    infra/aws/scripts/capture-evidence.sh staging <region> p1 <distribution id> <D>/teardown/t0/retire-p2 p2      # BOOT
    cd server
    node dist/server/src/tools/gamesDoctor.js aws retire-check p2 --evidence <D>/teardown/t0/retire-p2 --aws-config <runtime p1 ARN>      # OPER
    ```
    (Windows: `capture-evidence.ps1`, same arguments.) It must print `retire-check p2 (READ-ONLY) -- RETIRED`.
    `READY-TO-DRAIN` or `BLOCKED`: STOP.
0.6 **The ALB's LIVE deletion protection** (never inferred from the module default `true` or the tfvars). `[PRE-T3]`
    ```
    aws elbv2 describe-load-balancers --names gs-staging-alb --query "LoadBalancers[0].LoadBalancerArn" --output text
    aws elbv2 describe-load-balancer-attributes --load-balancer-arn <that ARN> --query "Attributes[?Key=='deletion_protection.enabled'].Value" --output text
    ```
    `false`: T2 is skipped. `true`: T2 is required. No answer, an error, or not exactly one load balancer: STOP.
0.7 **The ARM64 execution proof of the serving release.** `[PRE-T3]` Step 12b's saved capture
    (`arm64-live-smoke.txt`), unedited, for the digest the host serves. T1.3's guard judges it (`--arm64-live-smoke`):
    anything but PASS stops T1. A different serving digest needs a new 12b run first (`gs-host -Command arm64-smoke`,
    its own GO).
0.8 **Evidence that T3 and T5 destroy** -- REQUIRED, unless the owner records a decision to discard an item. All of it
    is read-only to AWS and saved under `<D>\teardown\t0\export\`:
    - `[PRE-T3]` the pool log groups:
      `aws logs filter-log-events --log-group-name /gs/staging/p1 --output json > logs-p1.json` (and p2);
    - `[PRE-T3]` the alarms' history (CloudWatch keeps 30 days; the CLI pages it itself):
      `aws cloudwatch describe-alarm-history --alarm-types MetricAlarm CompositeAlarm --output json > alarm-history.json`
      (the `-notify` composites included);
    - `[PRE-T3]` the app state, now and again at T3.0:
      `terraform -chdir=infra/aws/stacks/app state pull > app.tfstate.json`;
    - `[AFTER T3 OK]` the ledger state, at T5.0 at the latest (T3 does not change it, so T5.0's pull is its before-image):
      `terraform -chdir=infra/aws/stacks/ledger state pull > ledger.tfstate.json` (`LEDGER-ADMIN`).

      These are evidence files: under Windows PowerShell 5.1, `>` writes UTF-16, which is acceptable here.
    T3 deletes the log groups and alarms; their data is not recoverable afterwards. The pool logs' export is the slowest
    read on the T3 path; only a recorded owner discard shortens it.
0.9 **Terraform reads** (each `terraform plan` is read-only and is NEVER applied):
    - `[PRE-T3]` `terraform -chdir=infra/aws/stacks/app state list` → saved. It must hold the ECS-era addresses of the
      inventory's `DELETE-LEGACY` Terraform entries and the authorities -- nothing else foreign;
    - `[PRE-T3]` `stacks/app` planned with the CURRENT tfvars plus `compute = "ecs"` (now required: state it): expected
      to show ONLY the desired-count drift (§0.2 of `SINGLE_HOST_MIGRATION.md`: a service 0 → 1, or its destroy with
      `start_services = false`). Anything else -- a policy, a document, a table, a role, the distribution -- is drift: STOP;
    - `[AFTER T3 OK]` (before T5) `stacks/ledger` planned with the current tfvars plus `ecs_task_role_authorized = true`
      (now required): no changes. It is cheap (`LEDGER-ADMIN`): the owner may have it run before T3 to see ledger drift
      early, but it never blocks T3;
    - `[AFTER T3 OK]` (before R4 item 2) `stacks/single-host` planned from a clean checkout of **5b4756d** with its live
      tfvars: no changes. (From any later commit the plan REPLACES the instance -- the 13r scripts -- which is not a
      teardown action.)
0.10 **The NAT** (`APP-ADMIN`, read-only). T3 never touches it: it is in no state T3 changes, and T7 comes after T3.
    - `[CAPTURE BEFORE T3]` (T3 destroys the services and the gateway endpoints' routes):
      - the ECS service events of both services:
        `aws ecs describe-services --cluster gs-staging --services gs-staging-p1 gs-staging-p2 --query "services[].events[0:20]"`;
      - the VPC's route tables, whole:
        `aws ec2 describe-route-tables --filters Name=vpc-id,Values=<vpc-...> --output json > route-tables.before-t3.json`
        (the routes to the NAT, and the gateway endpoints' prefix-list routes that T3 removes).

      A missed capture leaves T_drain unproven (T7 then anchors at T3) and the pre-T3 routes unrecorded. It never
      blocks T3.
    - `[AFTER T3 OK]` (before T7):
      - its id, VPC, subnet and allocation id;
      - every route table routing to it (`aws ec2 describe-route-tables --filters Name=route.nat-gateway-id,Values=<nat-...>`);
      - which of those tables carried the gateway endpoints (the capture above; network.private_route_table_ids);
      - **T_drain**, the end of this workload's last NAT use. It is proven only by BOTH:
        - the captured service events showing the last service task stopped, with 0.4's empty task list;
        - no standalone task since then (the run-*-probe scripts' `RunTask`s): `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunTask --start-time <T_drain>`
          and the same for `StartTask` names no `gs-staging` cluster.
      - T_drain is **unproven** if the events no longer reach back to it, if T_drain is more than 60 days old
        (CloudWatch's 1,440 hourly points), or if CloudTrail's 90-day history does not cover it. T7 then anchors at T3.
      - **its ownership, as P1-R1 proved it from the states' contents:** whether the NAT gateway and its EIP are
        members of `network.tfstate` (or of any other listed state), or proven outside Terraform, or unproven. T7's path
        follows from this answer. The evidence, all of it recorded:
        - membership: the NAT's id and its allocation id, searched in every state's `.tsv` (0.11);
        - the tags: `aws ec2 describe-nat-gateways --nat-gateway-ids <nat-...> --query "NatGateways[].Tags"` and
          `aws ec2 describe-addresses --allocation-ids <eipalloc-...> --query "Addresses[].Tags"`;
        - where CloudTrail's 90 days still reach their creation: the `userAgent` of the `CreateNatGateway` event that
          returned `<nat-...>` and of the `AllocateAddress` event that returned `<eipalloc-...>`
          (`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=CreateNatGateway`,
          and the same for `AllocateAddress`).

        **Proven NOT Terraform-owned** needs both: neither is in a listed state, and neither carries a Terraform
        marker (a `gs:managed-by=terraform` or `gs:stack` tag, or a Terraform user agent). A marker that no listed
        state's membership explains points at a state R1 has not found, so the ownership is **unproven**.
0.11 **Every Terraform state, and the external stacks** (`APP-ADMIN`, read-only). `[PRE-T3]`
    - the state objects, listed again now (not only from R1's record), in each app-account state bucket R1 recorded --
      EVERY key, because the S3 backend accepts any key name, not only `*.tfstate`:
      `aws s3api list-objects-v2 --bucket gs-staging-tfstate-992163310414 --query "Contents[].[Key,ETag,LastModified]" --output text`.
      Each key must be a `PHASE1_INVENTORY.json` `terraform_states` entry, carry R1's recorded provisional placement,
      or be a listed state's lock object (`<its key>.tflock`). Any other key is a STOP;
    - every app-account state's managed addresses and ids (app, single-host, rpc-proxy, network, and any other R1
      placed), by the ONE allowed read form for a state that this step does not plan. It streams the object and keeps
      only these columns, never the attributes (which can hold secrets):
      `aws s3 cp s3://gs-staging-tfstate-992163310414/<key> - | jq -r '.resources[] | . as $r | .instances[] | [$r.mode, $r.module, $r.type, $r.name, .index_key, .attributes.id] | @tsv'`
      → `<D>\teardown\t0\states\<stack>.tsv` (jq, or the same columns from any JSON tool), written as ASCII, never
      UTF-16: in PowerShell append `| Set-Content -Encoding ascii <that file>` (Windows PowerShell 5.1's `>` writes
      UTF-16, which `grep` / `findstr` cannot search); in bash, `>`. This repository's states are read the same way, so
      that 0.12 compares one format; 0.8's pull and 0.9's state list stay as they are. An external state's contents are
      never saved beyond these columns;
    - the ledger stack's state is not needed before T3 when R1 recorded a separate ledger account (the design): the
      stack's only provider is pinned to that account (`allowed_account_ids`), so it cannot hold an app-account
      resource. Its listing and `.tsv` are R1 part B (`LEDGER-ADMIN`, before T5). If R1 found the ledger in the app
      account, it is read here like the others;
    - `aws cloudfront get-distribution --id E271XZAA1MQR4H --query "[ETag, Distribution.Status, Distribution.DistributionConfig.Origins.Items[0].DomainName]"`
      → its ETag, `Deployed`, `juno.rpc.t.stavr.tech` (T9 compares the same answer);
    - each external state object's metadata, `aws s3api head-object --bucket gs-staging-tfstate-992163310414 --key gs/staging/rpc-proxy.tfstate --query "[ETag, LastModified]"`
      (and `.../network.tfstate`).
0.12 **The T3 casualty check** (`APP-ADMIN`, read-only). `[PRE-T3]` T3 may destroy only what the app state holds, and
     nothing outside it may hang on what it destroys:
    1. **No other stack manages what T3 destroys or changes.** Take the ids of the app state's managed resources of the
       inventory's `DELETE-LEGACY` Terraform entries, plus those it updates in place (the p1 runtime document, the
       bootstrap and operator policies), from 0.11's app `.tsv`. None of them may appear in another state's `.tsv`
       (0.11), even inside a longer id (an endpoint's route-table association, a rule on one of its security groups).
       - Search with a tool that reads the files as written (`grep -F`, or `Select-String -SimpleMatch`). **Positive
         control first:** the same search must find every one of these ids in the app's own `.tsv`. A search that
         cannot find them there proves nothing (a wrong encoding, a wrong file): STOP.
       - Any match in another state is a STOP: T3 would remove or change something another stack also manages.
       - An app-account state that cannot be read is a STOP too: read access is the fix.
       - T3 step 3 repeats this with the plan's own changed ids.
    2. **Nothing else depends on it.** First take the three ECS-era security groups' ids:
       `aws ec2 describe-security-groups --filters Name=group-name,Values=gs-staging-alb,gs-staging-task,gs-staging-endpoints --query "SecurityGroups[].GroupId" --output text`.
       - `aws ec2 describe-network-interfaces --filters Name=group-id,Values=<the three> --query "NetworkInterfaces[].[NetworkInterfaceId,InterfaceType,Description]" --output text`
         lists only the ALB's ENIs (`ELB app/gs-staging-alb/…`) and the app state's interface endpoints'
         (`VPC Endpoint Interface vpce-…`). The host's ENI, or any other: STOP.
       - `aws ec2 describe-security-groups --filters Name=ip-permission.group-id,Values=<the three> --query "SecurityGroups[].GroupId" --output text`,
         and the same with `Name=egress.ip-permission.group-id`, name only the three themselves. A group outside them
         that references them would fail their deletion part-way through T3: STOP.
       - `aws ec2 describe-security-group-rules --filters Name=group-id,Values=<the three> --query "SecurityGroupRules[].SecurityGroupRuleId" --output text`
         lists only the app state's rule ids.
       - The cluster: `aws ecs list-services --cluster gs-staging` lists exactly the app state's two service ARNs, and
         `aws ecs list-container-instances --cluster gs-staging` is empty. Anything else fails the cluster's delete
         late in T3: STOP.
       - The ALB's children: `aws elbv2 describe-target-groups --names gs-staging-p1 gs-staging-p2 --query "TargetGroups[].LoadBalancerArns"`
         names only the T0.6 ALB; `aws elbv2 describe-listeners --load-balancer-arn <the T0.6 ARN> --query "Listeners[].ListenerArn"`
         and, for each listener, `aws elbv2 describe-rules --listener-arn <it> --query "Rules[?!IsDefault].RuleArn"` list
         only the app state's ids. A foreign listener or rule would be deleted with the ALB without a trace in the plan:
         STOP.
       - The pool log groups: `aws logs describe-subscription-filters --log-group-name /gs/staging/p1` (and p2) lists
         none. A filter would be deleted with its group: STOP.
       - The alarms: `aws cloudwatch describe-alarms --alarm-types CompositeAlarm --query "CompositeAlarms[].[AlarmName,AlarmRule]" --output text`.
         Every composite whose rule names a `gs-staging` alarm that T3 deletes must be in the app `.tsv`: STOP
         otherwise.
       - `aws iam list-instance-profiles-for-role --role-name gs-staging-app-task` (and `gs-staging-app-execution`)
         answers `[]`. T3 deletes both roles.
       - `aws iam get-role --role-name gs-staging-app-task --query "Role.RoleLastUsed"` (and the execution role) shows
         no use after this workload's last task stopped (0.4 and 0.10's captured events; a standalone probe task that
         CloudTrail's `RunTask` shows is this workload's own). A later use is another user: STOP.
         - If 0.10's capture was missed, the reference is the later of CloudTrail's last `UpdateService` and last
           `RunTask` for `gs-staging`. Tasks stop minutes after `UpdateService`, so a use inside that drain is this
           workload's own; the owner rules on a borderline one.
         - With no reference at all, the owner rules on it (recorded), or it is a STOP.
    3. **The host does not use it.** By item 2's rules only the tasks could reach the interface endpoints, so the host,
       which is serving (0.3), does not use them, and T3 cannot cut a path it uses. If the host's subnet's route table
       is one of the gateway endpoints' tables (0.10's capture), its DynamoDB and S3 traffic moves to the internet
       gateway at T3. That is expected, not a STOP.

**T0 part A PASSES** when every `[PRE-T3]` item of 0.1–0.12 holds and the `[CAPTURE BEFORE T3]` reads are saved (or
recorded as missed). The session posts `T0-A: PASS`; then come the owner's GO-T1, and GO-T2 if T0.6 read `true`.
**T0 part B** (every `[AFTER T3 OK]` item) must PASS before the step each names. It never delays T1, T2 or T3.

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
   other distribution is a STOP. The id it changes (`plan.json`, the change's `before.id`) must be the one in the app
   state's `.tsv` (T0.11) and in no other state's.
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

   **The casualty re-check** (read-only), after the PASS: the ids this plan destroys or changes,
   `jq -r '.resource_changes[] | select(.change.before != .change.after) | .change.before.id // empty' <D>\teardown\t3\terraform\app\plan.json`,
   appear in no other state's `.tsv` (T0.11), even inside a longer id. Use T0.12's search and its positive control.
   Re-read a state first if its object's ETag has moved since T0.11. Any match: STOP.

   **The private route tables.** T3 destroys this repository's own gateway endpoints (`aws_vpc_endpoint.gateway`, whose
   `route_table_ids` are the private route tables), so their prefix-list routes leave those tables. That is expected,
   and it is NOT a change to the network stack even if that stack holds the tables. The endpoints are the app state's
   own, and the AWS provider's `aws_route_table` skips `vpce-` routes, so a state holding the tables does not drift.
   T0.12 has proven that no other state manages the endpoints or an association of them. Whether the tables are
   network-owned is recorded by R1 part B; it does not block T3.
4. The session posts **`READY FOR GO-T3`** (what it carries: "The T3 fast path"). It includes the guard record, the
   casualty re-check, the plan's sha256 and its destroy list. The owner reads the list against the inventory's
   `DELETE-LEGACY` Terraform entries. The session mutates nothing further until GO-T3.
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
- **Proven NOT Terraform-owned** -- T0.10's standard: in no listed state, AND no Terraform marker on the NAT or its EIP
  (no `gs:managed-by=terraform` or `gs:stack` tag, no Terraform user agent in CloudTrail): the evidence path below,
  then step 4's direct deletion.
- **Ownership unproven** -- a state could not be read or enumerated, or any other ambiguity: **T7 is BLOCKED.**
  A Terraform marker that no listed state explains counts as unproven.
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
| state objects | `aws s3api list-objects-v2 --bucket gs-staging-tfstate-992163310414 --query "Contents[].[Key,ETag,LastModified]" --output text` | T0.11's keys, no new one; the external keys' ETags as in the row above |
| ledger | `LEDGER-ADMIN`: `aws dynamodb get-resource-policy --resource-arn <ledger ARN>`; `aws kms get-key-policy --key-id <each signing key> --policy-name default` | no `gs-staging-app-task`; `gs-staging-host-app` present |
| state | `terraform -chdir=infra/aws/stacks/app state list` | no ECS-era address |

Then P1-R4 and P1-R5 (`PHASE1_CLEAN_BUILD.md`): R5-A's `verify --topology single-host` is the judged form of this table.
