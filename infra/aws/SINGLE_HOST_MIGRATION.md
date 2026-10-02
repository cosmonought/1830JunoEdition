# Migrating staging from the ECS topology to the single host (COST-1)

**Status:** a PLAN. Nothing here has been executed.

**Prerequisites:**
- this branch (`cost/cost-1-single-ec2`) reviewed and its owner gate green;
- the live LIVE-6 operator session has stopped **before GO-C** (`appgen-adopt`), so APPGEN is still 1.

**Do not run any step without the owner's GO for that step.**

**Accounts and roles used:**

| Label | Who |
|---|---|
| `APP-ADMIN` | Terraform in the app account |
| `LEDGER-ADMIN` | Terraform in the ledger account |
| `BOOT` | the `gs-<env>-bootstrap` role |
| `OPER` | `gs-<env>-operator` |
| `OWNER-DNS` | the owner's DNS provider |

Every Terraform step goes through `infra/aws/scripts/plan-evidence` first. **Nothing may be destroyed, replaced or de-protected** except what the step names.

**Running Windows commands:** run `node dist/...` directly; PowerShell's `npm.ps1` swallows `--`.

## The sequence

### A. Return staging to a safe known state (generation 1)

GO-B left the following behind:
- break-glass **ON**;
- both pools **drained**;
- the restored `gs-staging-game-g2` **created and prepared but not adopted**.

Steps, all within the drill's own reversible rollback (`LIVE6_RESTORE_DRILL_PREP` §A.4):
1. `APP-ADMIN`: `terraform apply` the **unchanged generation-1** configuration with `recovery_break_glass = false`.
   - The pools may stay at desired 0. Serving resumes later from the host.
   - Expected plan: only the recovery role policy, plus `desired_count` if anything else moved. STOP otherwise.
2. `BOOT`/`OPER` checks, all read-only:
   - `gamesDoctor aws status`: APPGEN = 1, routing names p1, no role holder alive.
   - `awsDeploy verify`.
   - `gamesDoctor aws games --money`: **no open money game**.
   - `RELAYQ#<relayer>` empty.
3. Leave `gs-staging-game-g2` alone. It was never adopted, carries no PITR and costs cents. Its removal is a separate reviewed change, after its evidence is kept.

### B. Traffic off; ECS-era resources stay for now

4. Both pools stay drained (`infra/aws/scripts/drain-pool` p2, then p1, if anything restarted). CloudFront `/gs*` then answers 503 from the empty target group.
5. **Do not delete anything yet.** The ALB is the rollback path until step G is proven.

### C. Preserve DynamoDB, KMS, SSM, the ledger, and the evidence

6. **Untouched throughout:**
   - the game table g1, the identity table, the ledger table and its locked vault;
   - every KMS key;
   - both SSM documents;
   - the ECR repository;
   - the CloudFront distribution.

   Optionally take an **on-demand DynamoDB backup** of g1 and identity ($0.10/GB-month, cents).
7. **Export the evidence** step I would delete:
   - CloudWatch log groups `/gs/staging/p1`, `/gs/staging/p2`: `aws logs create-export-task` to an S3 bucket, or `aws logs filter-log-events > file`;
   - the alarm history;
   - every gate and evidence directory;
   - `terraform state pull` of both stacks;
   - the running image digests.

### D. Authorise the host's role and create the host

8. `LEDGER-ADMIN`: `stacks/ledger` with `app_runtime_role_arns = ["arn:aws:iam::<app>:role/gs-staging-host-app"]`.
   - The plan shows **only** the ledger resource policy and the key policies gaining that ARN beside the task role.
   - The role need not exist yet: the grant is an `aws:PrincipalArn` condition.
9. `APP-ADMIN`: `stacks/single-host` (`example.tfvars.example`):
   - `t4g.small`, a pinned AL2023 **arm64** AMI, the public subnet;
   - `origin_hostname` = a **new** name (e.g. `gs-origin-host.<domain>`), so the ALB origin keeps working;
   - `signing_keys` = the three keys the Juno document names;
   - `escrow_enabled`, `money_tables_nonmainnet` as staging;
   - `edge_diagnostic_staging = true` for the edge probes;
   - **the budget, ENABLED, with an owner-named subscriber** (required). AWS Budgets in a member account sees only that account's costs:
     - if the ledger is a separate account and the two accounts are not under one Organizations payer, create the same budget in the ledger account too;
     - if they are under one payer, create it in the management account, where it covers both.

   The plan **creates only**: the instance, ENI, EIP, security group, role, profile, log group, five alarms and the budget. There is no ECR lifecycle policy yet: ECS is still the rollback path and its circuit-breaker images must not expire.
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
| F7 | SIGTERM | `gs-host -Command stop` reports "the last run exited with status 0". Then deploy the same release again: nothing else changes. |
| F8 | Restart safety (MUTATING, staging) | `docker kill gs-server` on the host: systemd restarts it, and the new process takes **a newer POOL#p1 epoch** and the roles. Then reboot the host: it comes back by itself. |
| F9 | No duplicate writer | **(a)** non-disruptive: `/opt/gs/bin/gs-preflight` while the server runs refuses "already running". **(b)** disruptive, optional, staging only: start a second container of the same image and env under another name. The **older** process exits 3 within seconds and stays down (`RestartPreventExitStatus`). Remove the extra container, then `gs-deploy` the same release: the host process takes the pool back. |
| F10 | Stale host | Covered by Terraform (destroy-before-create on the ENI) and the preflight's EIP check (`tests/host-scripts.test.sh`). Nothing to do live. |

Any failure: STOP. **Rollback before G:**
1. `gs-host -Command stop -UntilDeploy`.
2. Restart the ECS pools with `terraform apply` at `desired_count` 1. Their task takes the pool and the host process stays down.

### G. Point CloudFront `/gs*` at the host

14. `APP-ADMIN`: `stacks/app` with `edge.alb_origin_domain_name = <origin_hostname>`, still `compute = "ecs"` and the pools drained.
    - The plan changes **only** the distribution's `gs-alb` origin domain.
    - The `/gs*` behaviour, its origin request policy, the default behaviour and the aliases are unchanged.
15. Wait for the distribution to deploy.

**Rollback:** the same apply with the ALB name. The pools come back first, and the host is stopped `--until-deploy`.

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
20. `APP-ADMIN`: `stacks/app` with `compute = "none"`, `start_services = true` and `pools = { p1 = { primary = true } }`.
    - `start_services = true` is REQUIRED here: under `compute = "none"` it is what turns on the plan-time gates (routing names p1, SYSTEM/GENERATION names the serving table, adoption). With `false` the gates are off (that is only for the very first bootstrap apply of a new environment, before any host serves).

    **The plan destroys, and only destroys:**
    - the ALB, listener, rules and target groups;
    - the ECS services, task definitions and cluster (Container Insights with it);
    - the pool log groups (exported in step 7);
    - the task and ALB security groups;
    - the VPC endpoints (gateway and interface) and their security group;
    - the ECS task and execution roles;
    - the L6-5B alarms, composites and flip suppressors.

    **It also removes p2's own objects:** `aws_ssm_parameter.runtime["p2"]`, the p2 target group, rule and service, and the p2 log group (exported in step 7). These are expected.

    **It keeps:** both tables, the p1 runtime document (its route table becomes p1 only), the Juno document, ECR, the bootstrap / operator / recovery roles, and the distribution.

    STOP if a table, the p1 or Juno document, a key, the repository or the distribution is in the plan.
21. Restart the host so it reads the p1-only route table: `gs-host -Command stop`, then `deploy` with the same release.
22. `LEDGER-ADMIN`: `stacks/ledger` with `ecs_task_role_authorized = false`. The plan shows only the task role ARN removed from the ledger and key policies.
22b. `APP-ADMIN`: `stacks/single-host` with `manage_ecr_lifecycle = true`. ECS is gone, so the lifecycle policy may now expire old images, keeping the newest 20 images. The current and previous releases are protected only while they ARE among the newest 20 (a running host keeps its pulled image locally, but a host replacement pulls from ECR): before pushing a 20th newer image, re-deploy or re-tag what must survive.
23. **Outside Terraform:**
    - delete the **NAT gateway** (and release its Elastic IP) **if** the VPC has no other user;
    - delete the ALB's ACM certificate if it is no longer used (free; optional);
    - remove the now-unused DNS name of the ALB origin.

### J. Verify the bill and the inventory

24. **Inventory**, read-only. **Any surplus is a HARD FAIL to fix before closing the migration.** A forgotten NAT gateway alone is about $33/month. The expected answers:
    - `aws elbv2 describe-load-balancers` → none;
    - `aws ecs list-clusters` → none for this environment;
    - `aws ec2 describe-nat-gateways` → none (or only other workloads');
    - `aws ec2 describe-vpc-endpoints` → none;
    - `aws ec2 describe-addresses` → exactly the host's EIP;
    - `aws ec2 describe-instances` (tag `gs:component=single-host`) → exactly 1;
    - `aws cloudwatch describe-alarms --alarm-name-prefix gs-staging` → the host's 4.
25. **Billing:**
    - Cost Explorer daily for 5–7 days, grouped by service, with the `gs:cost` tag activated;
    - the budget's $15 / $20 / $25 / $30 alerts active.

    Expect about **$0.75/day** while the host is on-demand. That is about $23 a month; about $18.61 with the 1-year Savings Plan, which is bought only after the memory plan (`docs/hosting-budget.md`).

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
| RERUN | Restart | §F7–F8 |
| RERUN | Fencing / duplicate process | §F9, plus a replacement certification (`stage-cert` replacement scenario adapted to the host evidence) |
| RERUN | KMS access | §F5 (the instance role is a new principal type) |
| RERUN | DynamoDB access | §F6, plus the `iam` gate's classification for the host role |
| RERUN | CloudFront edge | §H 16 (proxy hops, query strings) |
| RERUN | Money-game smoke | §H 18 |
| RERUN | Observability | `HostHealthProblems` / `HostCriticalEvents` appear and the five alarms evaluate. **Drills:** `gs-stop` for 4 minutes fires the health alarm (missing data = breaching). `aws cloudwatch set-alarm-state` on each alarm proves the notification wiring. A misspelt `GS_METRICS_PROFILE` is refused BEFORE the metric sink exists, so it fires only the health alarm, not the critical-event alarm. |
| **RETIRE** | p1/p2 flip (`flip`, `flip-alarms`, `flip-drill`) | One pool |
| RETIRE | ALB target-group / listener-rule checks (`checkPoolListenerRules`, target health) | No ALB |
| RETIRE | ECS drain-specific assertions (stop-first 0/100, AZ rebalancing, circuit breaker, `drain-pool`) | No ECS. Drain-first survives as `gs-stop`. |
| RETIRE | Multi-pool alarm checks (the L6-5B per-pool / primary matrix, suppressors, composites) | The four host alarms replace them |

**Not yet automated on the host** (follow-up): the control-plane half of `awsDeploy verify` and `capture-evidence` describe ECS and the ALB. For the host, the evidence is:
- the Terraform plan and state;
- `aws ec2 describe-instances` / `describe-security-groups`;
- `gs-health`.

A host variant of the verifier is a small follow-up slice; the data-plane checks (`gamesDoctor aws`, `generation-gate`, probes) apply unchanged.
