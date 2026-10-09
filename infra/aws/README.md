# infra/aws — the AWS infrastructure and deployment of the hosted game server (LIVE-5 L5-8)

This directory turns the L5-7 runtime contract (`claude/LIVE5_L5_7_AWS_RUNTIME_CONVERGENCE_2026-09-30.md` §14, and
`server/src/aws/README.md` §8) into reproducible infrastructure. **It changes no application semantics**: every rule here
restates what the runtime already requires.

**What exists is DEFINED and TESTED, not DEPLOYED.** No AWS resource was created by L5-8. The first real deployment
belongs to the LIVE-6 staging gate.

> **COST-1 (2026-10-02): the low-cost single-host topology.** The owner's hard ceiling is **$30/month** for the whole
> recurring infrastructure (target <= $20): `docs/hosting-budget.md`, `infra/aws/COST_BUDGET.json` (pinned by
> `server/src/aws/deploy/cost1SingleHost.test.ts`). The ECS/ALB topology below stays the default of `stacks/app`
> (`compute = "ecs"`, unchanged); the replacement is ONE EC2 host running the same AWS-mode image against the same tables,
> keys and documents -- `modules/single-host` + `stacks/single-host` (its README: runtime, Caddy origin, IAM, fencing,
> deploy / rollback, observability, memory plan) -- and `stacks/app` with `compute = "none"` keeping only the tables, SSM
> documents, ECR, the operator roles and CloudFront. The ledger authorises the host's role through `app_runtime_role_arns`.
> The migration runbook and the certification matrix: `infra/aws/SINGLE_HOST_MIGRATION.md`. Nothing is deployed.
>
> **COST-2B (2026-10-02): the migration's plan guards.** The runbook starts from the accepted post-abandonment staging
> state (APPGEN 1, g2 unadopted, pools drained 0/0/0, the recovery access removed) and applies every dangerous Terraform
> step ONLY from a saved plan that passed its guard: `infra/aws/scripts/plan-evidence ... --keep-plan`, then
> `npm run awsDeploy -- migration-guard <gate> --plan-evidence <dir>` (offline, fail closed; `server/src/aws/deploy/migration/`),
> then `terraform apply` of exactly that saved plan. The NAT gateway (outside Terraform) is deleted only after
> `scripts/capture-nat-evidence` + `migration-guard nat` PASS. The legacy app stack is frozen from ordinary applies until
> its teardown: its state expects running services while staging is drained (the desired-count drift).
>
> **RECON-1A (2026-10-02): the pending read grants, before step 8.** COST-2A's host-verifier statements (bootstrap role) and
> JX-4C's evidence reads (operator role; the ledger's `OperatorJournalQuery`) are installed by two more guarded steps --
> `migration-guard app-read-authorize` (7a, a TARGETED app plan: exactly the two policies, exactly those statements) and
> `migration-guard ledger-operator-journal` (7b) -- never by an ordinary app-stack apply; afterwards every later guard
> sees no foreign IAM delta (`server/src/aws/deploy/migration/recon1AuthorizationGates.test.ts`).
> **RECON-1 7A HOTFIX:** on a state written before COST-1, Terraform requires 7a's targets to cover `modules/app/moved.tf`'s
> thirteen pending moves and the three ECS-era policy documents COST-1 also gave `count`; step 7a carries exactly that
> closure, the guard accepting the moves only as no-op state-address moves and the data sources only read at plan time --
> the two policies stay the only mutations (`server/src/aws/deploy/migration/recon1SevenATargets.test.ts`).

## Tooling

**Terraform** (>= 1.9, provider `hashicorp/aws` 6.66.0, locked for linux/windows/darwin), because the repository had no
IaC convention and this infrastructure has to be reviewable and plannable without being applied. There is one IaC system:
no CDK, CloudFormation or serverless.

```
infra/aws/
  modules/ledger/        the LEDGER account: ledger table + resource policy, AWS Backup (locked vault), 3 KMS signing keys
  modules/app/           the APP account: game + identity tables, IAM (execution / task / bootstrap), network, SSM documents,
                         ECS cluster + one service per pool, ALB, CloudFront policies (+ optional distribution), ECR
  modules/*/tests/       `terraform test` over a MOCKED provider (no account, no credentials)
  stacks/ledger, app/    thin roots: provider (allowed_account_ids), S3 backend (partial config), example tfvars
  modules/single-host/   COST-1: ONE EC2 host (IAM instance profile, ENI + EIP, CloudFront-only security group), its
                         cloud-init / systemd / Caddy / deploy scripts, five alarms, the account budget; stacks/single-host
  single-host/           COST-1 operator side: gs-host.{ps1,sh} (SSM Run Command), build-image.{ps1,sh} (multi-arch)
  COST_BUDGET.json       COST-1: the machine-readable budget decision (docs/hosting-budget.md)
  fixtures/              the exact documents the app module renders for its test inputs, which the server's parsers also check
  scripts/               capture-evidence.{sh,ps1} (read-only; per pool: target group health, stopped/running tasks, ACTIVE
                         revisions, and a manifest), drain-pool.{sh,ps1} (the no-overlap rollout)
infra/docker/game-server.Dockerfile   the task's image (built from the repository root)
server/src/aws/deploy/ + tools/awsDeploy.ts   `npm run awsDeploy -- bootstrap | verify | generation-gate | signer-keys |
                                             relayer-rotation-gate | set-operator-plan | stage-cert | stage-probe`
server/src/aws/operator/                     `npm run gamesDoctor -- aws ...` (flip, recover, retire-check, orphans: L6-2)
```

## Accounts

| Account | Holds | Stack |
|---|---|---|
| **app** | ECS, ALB, CloudFront policies, ECR, `gs-<env>-game-g<N>`, `gs-<env>-identity`, both SSM documents, CloudWatch Logs | `stacks/app` |
| **ledger** | `gs-<env>-ledger`, its backup vault and plan, the three KMS keys | `stacks/ledger` |

The two accounts may be the same account (the single-account form). The ledger stack grants the app account's root, with an
`aws:PrincipalArn` condition naming exactly `gs-<env>-app-task` and `gs-<env>-bootstrap`. That is why it can be applied
before those roles exist, and why a recreated role is not locked out. Cross-account access needs both halves: that
resource or key policy, and the role's own IAM policy from the app stack. The ledger keeps DynamoDB's default encryption
(an AWS-owned key), because a table encrypted with an AWS-managed key cannot be shared across accounts.

## Resources (the contract, as built)

| | Settings |
|---|---|
| **DynamoDB** (all three) | String `pk` HASH and `sk` RANGE. On-demand. PITR (35 days). Deletion protection. `prevent_destroy`. No GSI, LSI, replica or stream. |
| `gs-<env>-game-g<N>` | TTL on the attribute **`ttl`** (LIVE-6 L6-5B) on **every** managed generation: only L6-5A's diagnostic `TASK#<task>/TASK` items carry it (last seen + 1 day); no authoritative item does. `SYSTEM/ROUTING` and the first table's `SYSTEM/GENERATION` come from the bootstrap (a restored table's marker from L6-4's preparation). `POOL#`, `ROLE#` and games come from the tasks. One resource per managed generation (`game_generations`, side by side; the L5-8 table is `moved` to key `"1"`, never replaced). |
| `gs-<env>-identity` | TTL on the attribute **`ttl`**. |
| `gs-<env>-ledger` | No TTL. `APPGEN` comes from the bootstrap. Resource policy for the task role: GetItem, Query, ConditionCheckItem, and PutItem on any key except `APPGEN`. It gets no Update, Delete or Scan. The operator role (L6-2): GetItem and Scan; JX-4C: Query of `ATTI#*` partitions only. Never a write. |
| **Ledger backup** | AWS Backup daily into `gs-<env>-ledger` (vault lock, governance by default; compliance mode is an owner decision). The vault policy denies DeleteRecoveryPoint and UpdateRecoveryPointLifecycle. The selection is the ledger only, and the backup role cannot restore. Optional copy to another vault. |
| **KMS** (relayer, settlement, admission) | `ECC_SECG_P256K1` / `SIGN_VERIFY`, single-region, no rotation (a new key is a new chain identity), `prevent_destroy`. The key policy lets the task role GetPublicKey, and Sign only with `ECDSA_SHA_256` over a `DIGEST`. The bootstrap role may DescribeKey, GetPublicKey and ListGrants. The key's own account administers it but gets neither `kms:Sign` nor `kms:CreateGrant`. LIVE-6: `relayer_key_count` (append-only, default 1) adds relayer keys `relayer-r2`, `relayer-r3`, ... beside the original (`r1`, unchanged), each with the same spec and policy; which one is configured is the app stack's `signing_keys.relayer` ("Relayer rotation"). Phase 5: `financial_key_sets` (append-only, default `[]`) adds dedicated `settlement-<label>` / `admission-<label>` pairs ("Financial key sets"). |
| **SSM** | `/gs/<env>/runtime/<pool>` (`18COSMOS/AWS-RUNTIME/v2` since L6-2: the v1 fields plus `routes`, one entry per pool, `ws_path` `/gs/p/<pool>`; v1 is still read) and `/gs/<env>/juno-backend` (`18COSMOS/JUNO-BACKEND/v3`: `journal` is the same ledger ARN, the signers are the three key ARNs). Both are `String`, never `SecureString`, hold no secret, and are written with `insecure_value` so every change shows in the plan. |
| **Secrets Manager** | **Nothing.** No secret has a consumer yet, so no secret is created and no role has `secretsmanager:*`. See "Secrets" below. |
| **ECS** | One Fargate service per pool (desired count 0 or 1), each behind its own target group in awsvpc private subnets with no public IP. Stop-first (0 / 100), AZ rebalancing off, circuit breaker with rollback, no ECS Exec. `stopTimeout` 120. Container health: `node -e` GET `/gs/healthz`, `startPeriod` 300. awslogs to `/gs/<env>/<pool>`. Read-only root filesystem; the image runs as the `node` user. |
| **Task environment** | Exactly `GS_MODE=production`, `GS_STORAGE=aws`, `GS_AWS_CONFIG_PARAMETER=<this pool's runtime ARN>`, `BUILD_ID=<image tag>`, `PORT`, `GS_ALLOWED_ORIGINS`, `GS_TRUSTED_PROXY_HOPS=2`, and `ESCROW_MONEY_TABLES=nonmainnet` only if `money_tables_nonmainnet` is set (non-mainnet only). Never `DATA_DIR`, `ESCROW_JUNO_CONFIG`, static AWS keys, `secrets` or `environmentFiles`. |
| **ALB** | Internet-facing, HTTPS 443 only (TLS 1.3/1.2 policy), `drop_invalid_header_fields`. Idle timeout 300 s (validated >= 120). **One target group per pool** (`gs-<env>-<pool>`), health `/gs/readyz` matcher `200` (a non-primary router answers 200 too), deregistration delay 15 s. Listener rules (L6-2): each pool's **exact** `ws_path` (`/gs/p/<pool>`, priority 100 + its sorted index) to its own group, then `/gs*` (priority 1000) to the primary's group. Every other path returns 404. |
| **CloudFront** | Origin request policy for `/gs*`: query strings `all`, cookies `all`, headers `Origin` plus `Sec-WebSocket-Key`, `-Version`, `-Protocol`, `-Accept` and `-Extensions`. Cache policy Managed-CachingDisabled; all seven methods; https-only both ways. The distribution itself is optional (`edge.create_distribution`); otherwise attach the output policy id to your own distribution's `/gs*` behaviour. |
| **Network** | Task SG: the container port from the ALB SG only; egress TCP 443 (plus any `juno_egress_ports`). ALB SG: 443 from CloudFront's origin-facing prefix list only. Gateway endpoints for DynamoDB and S3, and interface endpoints for KMS, SSM, Logs, ECR API and ECR DKR. |
| **ECR** | `gs-<env>-server`, immutable tags (a `BUILD_ID` names exactly one image), scan on push. |

**Remaining public egress:** the Juno REST endpoints (through the existing VPC's NAT), plus any AWS API in another region
(for example a ledger or KMS keys outside the app region), because a VPC endpoint serves only its own region. With
`create_interface_endpoints = false`, AWS APIs also leave through the NAT to the regions' public endpoints. The SDK clients
pin those endpoints (`awsClients.ts`).

## IAM: the roles and their authorities

| Role | Authority |
|---|---|
| `gs-<env>-app-execution` | Used by ECS: `ecr:GetAuthorizationToken` (AWS cannot scope it), pulls from this repository only, and writes this service's log streams only. |
| `gs-<env>-app-task` | Used by the application, and the only credential source a task has. Game table: GetItem, Query, Scan, ConditionCheckItem; Put, Update and Delete on any partition except `SYSTEM`. Identity table: GetItem, Scan, ConditionCheckItem, Put, Update, Delete. Ledger: GetItem, Query, ConditionCheckItem, and PutItem except `APPGEN`. KMS GetPublicKey, plus Sign with ECDSA_SHA_256 over a DIGEST. `ssm:GetParameter` on the two documents. No `*` resource. |
| `gs-<env>-operator` (L6-2; only with `operator_trusted_principal_arns`) | `gamesDoctor aws`: game table GetItem/Query/Scan; PutItem on `SYSTEM/*` and `OPRUN#*` (the routing CAS, the run's evidence) and UpdateItem on `GAME#*` / `POOL#op:*` (an operator run's claim / take / release) -- never another `POOL#`; identity-writer role GetItem; ledger GetItem + Scan (read-only); GetParameter on the documents. JX-4C (the JX-3B / JX-4B evidence, `aws wallet-grants` / `aws money`): identity GetItem of `PRIN#*` / `PROF#*` / `FAM#*` only (never `SESS#`, `LINK#`, `SEL#`, `GRANT#`, `TXN#`, `RESTORE#`, `REVIEW#`, `TABLE#`; no identity Query or Scan), and ledger Query of `ATTI#*` partitions only -- granted on BOTH sides (this policy and the ledger's resource policy, `OperatorJournalQuery`, exact operator ARN). No KMS, no identity write, no APPGEN, no ledger write. |
| `gs-<env>-recovery` (L6-2 for L6-4; only with `recovery_trusted_principal_arns`) | `npm run recovery`: APPGEN adoption and its `APPGEN#HISTORY` append (ledger), the restored table's `SYSTEM/GENERATION`, the identity replay's tables. `RestoreTableToPointInTime` only with `recovery_break_glass`. Serving tasks never hold any of it. |
| `gs-<env>-bootstrap` | Used by the pipeline or an operator. PutItem and GetItem **only** on `SYSTEM/*` of the game table and `APPGEN` of the ledger (`dynamodb:LeadingKeys`). Describe on the three tables, GetParameter on the documents, and KMS DescribeKey, GetPublicKey and ListGrants. Read-only describes for the verifier: `ecs:DescribeTaskDefinition`, `elasticloadbalancing:Describe*` and `ec2:DescribeSecurityGroups*` (all `*`, because AWS cannot scope them), `ecs:DescribeServices` on this cluster, and CloudFront GetDistributionConfig and GetOriginRequestPolicy; since L6-2 also GetItem on `SYSTEM/GENERATION` and `APPGEN#HISTORY`, ListTasks/DescribeTasks on this cluster, ListTaskDefinitions and DescribeTargetHealth; since L6-6 CloudFront GetDistribution. It has no Sign, no Update, no Delete, and no Scan except (LIVE-6 final convergence) `RestoreQuietOldGenerationHeartbeats`: Scan on the NON-serving managed generations' game tables only (a restore drill's old-generation TASK# heartbeats), never the serving table, identity or the ledger. LIVE-6 relayer rotation, only while `relayer_rotation_key_arns` is non-empty: the same KMS reads on those keys (never the task's), and GetItem on the serving game table's `ROLE#relayer#*` / `POOL#*` / `TASK#*` and the ledger's `FENCE#relayer#*` (the post-rotation proof; the ledger stack grants its half once `relayer_key_count` > 1). |

**L6-5B additions:** `gs-<env>-operator` may `cloudwatch:PutMetricData` **only** into `18Cosmos/Operator` (the planned-flip
window's suppressor datapoints) -- never a game-server metric, and no role may disable, set, rewrite or delete an alarm
from the application side; `gs-<env>-bootstrap` may `cloudwatch:DescribeAlarms` (the verifier's evidence). The task role
gains nothing: its metrics are EMF lines on stdout through its log group.

**LIVE-6 final convergence -- the certifier / verifier role is the union of READ authority only** (`gs-<env>-bootstrap`):
ECS service / task / deployment inspection, ELB target health, the CloudFront configuration, `DescribeAlarms`, the
`SYSTEM/GENERATION` / routing / APPGEN / `APPGEN#HISTORY` reads, `RELAYQ#<old>` by Query, the ledger's verification, and the
old generation's TASK# Scan. It can start, stop or change no task or service, sign nothing, and make no gameplay, recovery,
flip, alarm or deployment mutation (pinned by `app.tftest.hcl`); its only writes remain L5-8's first-start bootstrap (the
create-if-absent `SYSTEM/*` and `APPGEN`). The identity recovery state is read by the certifier task (the task role).

**COST-2A additions (the single host's verifier, `gs-<env>-bootstrap`, describe / get / list only):** the EC2 describes
the host capture needs (instances, the one attribute `disableApiTermination`, credit specifications, volumes, images,
network interfaces, addresses, NAT gateways, VPC endpoints, managed prefix lists), `ssm:DescribeInstanceInformation`,
`logs:DescribeLogGroups`, `ecs:DescribeClusters` / `ListServices`, IAM Get/List on the `gs-<env>-host-app` role and
instance profile only, and `budgets:ViewBudget` (the budgets, never their subscribers). No Run Command: the host's
`gs-health` line is the operator's opt-in (`ssm:SendCommand`, as `gs-host status`). Pinned by `app.tftest.hcl`. **Never by an ordinary app-stack apply**
on an environment whose app stack is frozen (staging: SINGLE_HOST_MIGRATION.md §0.2 -- such an apply would also correct
the legacy desired-count drift and restart p1): there these statements, together with JX-4C's operator reads, are
installed only by the TARGETED, guarded step 7a (`migration-guard app-read-authorize`), before the host verification is
first needed. A new environment receives them with its first apply.

The DynamoDB transactions are authorised per underlying action (Put, Update, Delete, ConditionCheckItem, GetItem), so
these lists are complete. The `LeadingKeys` exclusions on `SYSTEM` and `APPGEN` are **defence in depth**, not the safety
mechanism: the routing's compare-and-swap and the conditions inside every takeover are the safety. The staging gate should
confirm the exclusions are enforced inside `TransactWriteItems`, for example with a non-mutating probe run as the task
role: a conditional Put on `SYSTEM/ROUTING` whose condition can never hold must answer AccessDenied, not
ConditionalCheckFailed. The Terraform identity itself (whoever runs `apply`) is the owner's administrative identity. It is
not modelled here.

## Deploy order (deterministic)

| Step | What | Brief step |
|---|---|---|
| 1 | `stacks/ledger` apply (ledger credentials): the ledger table (PITR, protection, resource policy), backup and vault, and the three KMS keys. It grants the app roles by principal ARN condition, so they need not exist yet. | 2, 3 |
| 2 | `npm run awsDeploy -- signer-keys --relayer … --settlement … --admission …` (read-only): the public keys and relayer address for `escrow`. Skip it when escrow is null. | 3 |
| 3 | `stacks/app` apply with `start_services = false`. Terraform's graph orders it roles and network and logs, then tables, then SSM documents (which `depends_on` the tables), then task definitions (which `depends_on` the documents and the task policy). The ALB, target group and edge come after that. | 1, 2, 4, 7 |
| 4 | Build and push the image: `docker build -f infra/docker/game-server.Dockerfile -t <ecr url>:<build_id> .` then `docker push`. | 6 |
| 5 | **Bootstrap:** `npm run awsDeploy -- bootstrap --runtime-parameter <primary's ARN> --environment <env> --primary-pool <p> --generation <N> --by <run id>` for a dry run, then again with `--apply`, then with `--check`. | 5 |
| 6 | **Verify before start:** `awsDeploy verify … --no-evidence`. The documents, tables, APPGEN, routing and keys must all pass. | 5 |
| 7 | `stacks/app` apply with `start_services = true`. The plan reads `SYSTEM/ROUTING` and refuses to create any service unless it names the primary pool. | 6 |
| 8 | The service becomes healthy **only** through `/gs/readyz` (the ALB target health; ECS ignores it for `health_check_grace_period_seconds`, 300 s by default). | 8 |
| 9 | **Verify deployed:** `capture-evidence.{sh,ps1}`, then `awsDeploy verify --evidence <dir>` (app account), then `awsDeploy verify --part ledger …` (ledger account). | 8 |

A task never repairs a missing APPGEN or routing. A missing APPGEN refuses the start (exit 2) before the pool is taken. A
missing routing makes the primary a standby, whose `/gs/readyz` stays 503. Terraform refuses step 7 in that state, so it
cannot arise from this procedure.

## The bootstrap (APPGEN + SYSTEM/GENERATION + SYSTEM/ROUTING): `npm run awsDeploy -- bootstrap`

(L6-2 for L6-4: the bootstrap also creates-if-absent the first table's `SYSTEM/GENERATION` with L6-4's own
`bootstrapGenerationMarker`; all three records are inspected before any write, and a conflict or an unreadable one refuses
the whole run.)

These are mutable control-plane records: L6-2 flips the routing and L6-4 adopts a generation. They are therefore **not**
Terraform items, because a later apply would "correct" a legitimate change back. The bootstrap uses the repository's own
code: L5-3's `setPrimaryPool` (create-if-absent) and `readRouting`, and L5-5's `readAdoptedGeneration` and APPGEN key.

- **Explicit:** `--environment`, `--primary-pool` and `--generation` must equal the runtime document named. The task's
  own `loadAwsStartup` parses that document, and its table names must follow the convention.
- **Idempotent** for the same desired state: an equal record is left as it is, and nothing is re-stamped.
- **Refuses rather than overwrites.** A routing that names another pool, an APPGEN at another generation, or an item this
  build cannot read refuses the **whole** bootstrap, and nothing at all is written. It never resets a routing version or
  a generation, because its only writes are create-if-absent.
- **A lost answer is settled by reading the record back.** An unsettled write exits 3; run the same command again, and
  it can never write twice.
- The default is a dry run. `--check` exits 0 only when both records are in place. Output shows identifiers and states
  only; neither record holds a secret.
- It is proven on DynamoDB Local (`server/src/persistence/conformance/awsBootstrap.dynamoLocal.test.ts`).

Richer inspection, repair and operator mutation are L6-3's (`gamesDoctor` over DynamoDB).

## Rollout: pool fencing and ECS

The newest task of a pool fences every older one, and the fenced task exits 3 at once, with no drain. ECS's generic rolling
default (100 / 200) therefore makes every deploy fence the serving task. It buys no availability, and it can ping-pong
(`modules/app/ecs.tf` header). Every service is **stop-first (0 / 100)** with **AZ rebalancing disabled**, and each pool
has one task.

**Stop-first does not strictly guarantee zero overlap** (review M1): ECS counts only RUNNING and PENDING tasks against
`maximumPercent`, so it may start the new task while the old one is still draining. That is still safe, because the fences
hold, but the old task's drain is cut short and it logs a false `aws.task-lost`. **The production procedure for any change
that replaces a pool's task** (a new `build_id`, a changed SSM document, a task-definition change) is:

```
infra/aws/scripts/drain-pool.sh <env> <region> <pool>     # desired 0; waits until the task has STOPPED (graceful exit 0)
terraform apply ...                                          # desired_count 1: the new task starts from nothing
```

Also note:

- A changed document reaches a running pool only through a new deployment, because the task reads the latest SSM
  version at startup. The service's `triggers` start that deployment.
- `force_new_deployment` makes any in-place service update a redeploy, with the same gap.
- A circuit-breaker rollback runs the previous revision, but it **reads the same (latest) document**. A bad document is
  undone by reverting it in Terraform, not by the rollback.
- Never `aws ecs run-task` a pool's task definition beside its service: the two would fence each other in turn.
- **No arbitrary mixed-version coexistence is claimed.** L6-7's readers of `RELAYQ#`, `FINKEYS` and `FINIDX#` require
  **exact attribute sets**: a future change that adds an attribute to any of those item classes is a persistence-format
  change that needs its own coexistence/rollout plan (old and new tasks never serve side by side on it). No such change
  exists today. A flip, which runs the same revision in both pools, is unaffected.

## The flip: primary A → B (LIVE-6 L6-2)

A flip moves the **routing**, never an image. It runs beside no deployment. Operator credentials: the `gs-<env>-operator`
role through a profile or SSO (static AWS keys stay refused).

```
capture-evidence.{sh,ps1} <env> <region> <dir>                             # fresh (<= 15 min), both pools
npm run gamesDoctor -- aws status                                            # note SYSTEM/ROUTING's version N
npm run gamesDoctor -- aws flip A B --expect-version N --note "..." --evidence <dir>              # DRY RUN: writes nothing
npm run gamesDoctor -- aws flip A B --expect-version N --note "..." --evidence <dir> --flip-record flip.json --apply
   # as soon as it prints "routing: B is the primary" -- IN PARALLEL with its observation:
terraform apply   (pools.B.primary = true, A false)                          # only the /gs* rule's target moves
capture-evidence ... ; npm run awsDeploy -- verify ... --evidence <dir> --flip-record flip.json
npm run gamesDoctor -- aws recover A --note "..."                            # DRY RUN
npm run gamesDoctor -- aws recover A --note "..." --flip-record flip.json --apply
```

- **F0 preflight** (always): the routing is at exactly N and names A; `POOL#A` and `POOL#B` readable, B taken; A's current
  task holds the identity-writer (and relayer) role; APPGEN and `SYSTEM/GENERATION` pass the tasks' own startup rules; both
  runtime documents are v2 (read by the task's parser) with the same route table naming A and B. With `--apply`, the
  evidence must show both services settled behind their own groups, B desired 1, **both targets healthy** (B is L6-1's
  router), `/gs*` → A and each exact path → its own group with nothing shadowed, and every rollback target declaring the
  identity layout. A dry run stops here.
- **F1** the planned-flip observability window opens (`AUDIT operator.flip-window {phase:"open", expires_at}`, 45 min
  bound) **before** the CAS. **L6-5B:** right after it, the flip publishes the window's alarm-action suppression for
  **exactly A and B** (`AUDIT operator.flip-suppression {phase:"open", outcome}`): one `FlipWindowOpen = +1` datapoint per
  minute up to `expires_at` into `18Cosmos/Operator` (the operator role may write only that namespace). It ends **by
  itself** at `expires_at` even if the operator's process dies; a settled `recover --flip-record` (or a refused CAS)
  closes it early with -1 over the same minutes (additive: an overlapping re-run or flip back keeps its own suppression). A
  failed publication never changes the flip (the alarms simply page). See "Alarms" below.
- **F2** L6-3's `set-primary` CAS (evidence first; a lost answer settled by its claim; `unknown` stops -- re-run the same
  flip, it can never move twice).
- **F3** observe (strong reads): both pools re-taken at a newer epoch (each task exited 5 and ECS started its replacement),
  the identity-writer (and relayer) role held by B's **current** task at a newer epoch, A holding none. Nothing in the tool
  can fake it. The bound passing first is `timeout`: stop; `flip-observe --flip-record` resumes.
- **The identity-API gap (review M2).** From the CAS until `/gs*` forwards to B, HTTP identity calls (`/gs/api/*`: sign-in,
  session creation) reach A, which is now a router and answers them 503 (sockets are fine: they get a route frame). Keep
  it short: apply the Terraform move as soon as the CAS lands (above), not after the observation. B's own restart is a
  short gap of its own either way; clients retry.
- **Interrupted or uncertain** (`unknown`, a killed process, a conflict while the routing names B): `flip-observe
  --flip-record` settles the CAS from `SYSTEM/ROUTING` itself and continues. A new `flip` never writes over a record whose
  window opened -- a re-run takes a new file.
- **Rollback** (B cannot start as primary): `flip B A --expect-version N+1 --rollback ...` -- the same preflight, window,
  CAS and observation, accepting that the roles never left A and that B is unhealthy; A must be running and healthy.
  **Never** the raw `set-primary` in production (it checks none of the evidence: it could name a drained pool).
- The Terraform `primary` flag changes **only** the `/gs*` rule's target group and (L6-5B) the Pool dimension of the three
  primary-only alarms (A6, A7, A13, in place); the plan refuses it until the routing names
  the new primary, and refuses to make a drained pool primary. Clients never depend on it: an old `/gs` connection reaching
  A is answered by A's router with LIVE-4's route frame to `/gs/p/B`, which the ALB sends to B's group.

**Flip ≠ drain-before-deploy.** A flip replaces no image and changes no task definition: each task ends itself with
**exit 5** (planned role change) after a graceful drain, and its **service** starts the replacement -- the same revision,
now in the other role. The drain-first rule (below: `drain-pool`, running = pending = 0, then `apply`) is for every change
that **replaces** a task's revision or document, and is unchanged. Never combine the two: finish one, verify, then the
other.

## Recovery of games on the old epoch: `gamesDoctor aws recover <A>`

A's clean demotion releases its resident no-money games; money games, loads in flight and games of a task fenced (exit 3)
stay named by A. Once A's task restarted, they are **superseded**. The pass enumerates the directory and the open money
games and, for each HEAD naming A at a superseded epoch, runs L6-3's `take` then `release` (the recovery marker in the
note); the new primary's load -- or, for a money game, its money claim sweep (awaited, bounded) -- claims it. It never takes
a **current** owner (A not restarted), another operator's hold, or anything malformed/unreadable: those are `unresolved`.
Bounded (`--limit`), idempotent and resumable (an interrupted pass's own holds are released on the re-run). A settled pass
with `--flip-record` closes the observability window.

## Retirement of a pool (distinct from a flip)

A flip only demotes: the old pool stays a non-primary router. `gamesDoctor aws retire-check <pool> [--evidence <dir>]`
(read-only) proves R1 not primary, R2 no singleton role, R3 no HEAD names it at any epoch and no unresolved recovery hold,
R4 no open money game released-and-unclaimed, R5 no route can name it, R6 (with evidence) drained: desired = running =
pending = 0, settled, no target. Procedure: `recover` → `retire-check` (ready-to-drain) → `drain-pool` → capture →
`retire-check --evidence` (retired) → Terraform `desired_count = 0` for the pool. **The durable record is Terraform's
state**: no `POOL#.status` attribute exists (no authoritative schema; the owner decision is recorded in the L6-2 report),
so a pool is never "retired" in the table. Its image, task definitions, target group and log group are kept.

## Relayer rotation: a new relayer key, address and contract operator (LIVE-6)

**What a relayer is.** The relayer is ONE KMS key (`ECC_SECG_P256K1`), the Juno account that key controls (its address is
derived from the public key: `awsDeploy signer-keys`), and the escrow contract's **operator** (`Config.operator`: the only
account that may `Start` a game; Checkpoint / Settle / Finalize are open to anyone). An asymmetric KMS key cannot rotate,
so a rotation is a NEW key, a NEW address and a NEW operator -- three things that must move together, in the drained
window, or the money path is off: a configuration naming an address the contract does not accept as its operator is
refused by `verifyJunoDeployment` for the life of the process (financial mode off), and an old relayer whose address is
no longer the operator can Start nothing.

**Queues are per address and never migrate.** `RELAYQ#<relayer-address>` in the game table is the relayer's
**authoritative work discovery** (L6-7). A relayer under a new address never reads the old partition, and there is **no
automatic queue migration** (owner decision, this LIVE cycle). So **a configuration change of the relayer address is
refused while the old address's queue holds any entry** (`relayer-rotation-gate`). A `held` intent keeps its entry and
never drains by itself: it blocks the rotation (it is never stranded).

### Owner prerequisites (nothing in this repository holds or invents them)

- **The contract admin.** `set_operator` is admin-only: the sender must be the escrow contract's `Config.admin`
  (`contracts/escrow/src/execute/admin.rs` `admin_guard`: the admin, and no funds) -- **not** the relayer, and not the
  wasm admin (`wasm_admin` is the `migrate` admin; staging's is null). The staging escrow contract and its public
  `Config.admin` address are **known** from the earlier staging deployment: the contract is the app stack's
  `escrow.contract_address` (the owner's untracked staging tfvars; its Juno document carries it), and `Config.admin` is
  public chain state that `awsDeploy set-operator-plan` READS from that contract and prints, with the exact message. What
  remains an **owner prerequisite** is (1) custody of / access to the admin's **signing credential**, and (2) a supported
  way for the owner to sign and send the `set_operator` transaction with it (for example `junod tx wasm execute` from the
  admin's own wallet). This repository holds no admin key, mnemonic or signing tool and never asks for one; nothing here
  signs for the admin, and the runbook does not assume who holds that credential.
- **JUNOX for the new account** (a plain bank send from any funded wallet; this repository sends nothing). The amount
  is the **one-game operational planning reserve** `relayerFunding` (LIVE-6 L6-12D; derived from the configuration's own
  gas policy, integers only, and printed in full by `set-operator-plan`):

  ```
  per-tx cap       = min(max_fee 500000, ceil(max_gas 1500000 x 75/1000) = 112500) = 112500 ujunox
  planning reserve = 73 x 112500 = 8212500 ujunox = 8.2125 JUNOX
  73               = Start 1 + Checkpoint 64 + Settle 1 + Consent up to 6 + Finalize 1
  ```

  The per-transaction cap is the largest fee the relayer's own `decideGas` can ever accept (the gas limit is refused
  above `max_gas`, the fee above `max_fee`; with the defaults the gas-derived 112,500 binds, not `max_fee`). **64
  checkpoints is an operational planning allowance, not a contract cap** (the contract does not limit how many
  Checkpoint transactions a game sends). Retries are not in the reserve: repeated failures are bounded by the relayer's
  hold-and-page machinery and operator replenishment. So the reserve is a **readiness policy, not an absolute maximum
  possible game cost**, and not a contract, runtime or certification requirement of the chain -- `set-operator-plan`
  and the post-rotation proof enforce it. **Recommended staging funding: 10 JUNOX** (above the reserve, so one drill does
  not run the account to the floor; a typical relayer transaction costs a fraction of the cap). The ACTIVE relayer must
  hold the reserve before it can receive new money work. A never-funded account does not exist on chain and cannot sign.
  *(Corrected 2026-10-02, L6-12D: this paragraph previously stated a 33.5 JUNOX floor -- 67 transactions x `max_fee` --
  which over-derived the cap and omitted the Consent transactions; L6-12C.)*
- **The OLD relayer is not pre-funded for the forward rotation.** It signs no transaction during the rotation or during
  a rollback itself. Only if a rollback is actually required, top it up just in time (below).
- **`RELAYQ#<old>` drainable** (no `held` intent) and **the funding-phase money game resolved** (below).
- Do it after the flip drill is certified (the recommended order of the forward audit).

### The sequence: prepare -> gate -> set_operator -> apply -> certify

Credentials: the ledger account's for the ledger stack; the app account's (Terraform identity) for the app stack; the
bootstrap role for every `awsDeploy` read. `<old>` / `<new>` are relayer ADDRESSES; `r<N>` is the new key's label.

**Windows / PowerShell:** the `npm run awsDeploy -- ...` lines below are the POSIX form. In PowerShell run them as
`node dist/server/src/tools/awsDeploy.js <command> ...` from `server/` (the same rule as the restore drill's, under
"Generation switch after a restore"): `npm.ps1` can swallow the `--`, so flags such as G3's `--record` can reach npm
instead of the gate (no `gate-relayer-rotation.json` is written, and certification FAILS for the missing record).

```
# P -- PREPARE (nothing switches; the pools keep running on the old relayer)
P1  stacks/ledger:  relayer_key_count = N   (one more than today; APPEND-ONLY)      plan, then apply
      -> exactly one new key, relayer-r<N> (same spec, same key policy, prevent_destroy); output relayer_key_arns.r<N>
P2  stacks/app:     relayer_rotation_key_arns = ["<relayer_key_arns.r<N>>"]          plan, then apply
      -> the bootstrap / verifier role may READ the new key (and the post-rotation proof's GetItems exist); the task role
         still signs with exactly the three configured keys; no document changes, so no pool restarts
P3  npm run awsDeploy -- signer-keys --relayer <r<N> ARN> --settlement <current> --admission <current>
      -> relayer.address = <new>; settlement / admission public keys MUST equal today's escrow values
P4  fund <new> (>= the planning reserve, 8.2125 JUNOX by default; 10 JUNOX recommended for staging), then:
    npm run awsDeploy -- set-operator-plan --runtime-parameter <primary ARN> --environment <env> --to-relayer <new> \
        --to-relayer-key <r<N> ARN>      # READY: <new> is the key's address, exists on chain, >= reserve; prints Config.admin
P5  prepare, do NOT apply, the app change:  signing_keys.relayer = <r<N> ARN>; escrow.relayer_address = <new>;
    escrow.trust.operators = [<new>]; relayer_rotation_key_arns = [<the OLD relayer key ARN>]    (plan only)

# G -- THE GATE (the change is SAFE)
G1  let the old relayer drain RELAYQ#<old> (run the gate WITHOUT --record as a read-only precheck)
G2  drain-pool every pool; capture-evidence <dir>
G3  npm run awsDeploy -- relayer-rotation-gate --runtime-parameter <ARN> --environment <env> --from-relayer <old> \
        --to-relayer <new> --evidence <dir> --record <dir>/gate-relayer-rotation.json      -> GATE OPEN

# S -- THE OPERATOR (inside the drained window: after G3, before A1)
S1  the contract admin sends   {"set_operator":{"operator":"<new>"}}   to the escrow contract, no funds
S2  set-operator-plan ... --to-relayer <new>   -> "the contract's operator is ALREADY <new>"
      S2 doubles as the ACTIVE relayer's readiness check: the reserve is still evaluated. ALREADY + funded -> exit 0
      (READY); ALREADY + under the reserve -> exit 1 with the shortfall. Do not start the pools (A1) on NOT READY.

# A -- APPLY (drain-first is satisfied: every pool is at zero)
A1  terraform apply the P5 change -> the task role signs with the new key; the Juno document names <new>; the pools
    start from zero; the primary's task mints FENCE#relayer#<new>, mirrors ROLE#relayer#<new>, verifies the deployment

# C -- CERTIFY (the change WORKED)
C1  once the primary is serving (its escrow verifies within a minute of its start): the staging run, steps 1-7 of
    "Staging certification", with --scenario relayer-rotation-drill --from-relayer <old> --to-relayer <new>
```

`relayer-rotation-gate` (v2) also reads the contract's operator (it must be `<old>` -- or already `<new>`) and records,
from the configuration it judged, the deployment the rotation must leave untouched: the chain, the contract and its
certified checksums, the settlement key (registry id, public key, KMS key) and the admission key (public key, KMS key),
and the old relayer key (`18COSMOS/RELAYER-ROTATION-GATE/v2`, created once). Certification refuses a v1 record.

In A1 Terraform updates the task role's policy and the documents before the services' new deployment (the task
definitions depend on both); the task opens its KMS keys late in its start. If IAM had not yet propagated, the start is
refused (A4 pages) and ECS starts it again.

**Afterwards.** The old key stays (`prevent_destroy`; never lower `relayer_key_count`) and stays readable in
`relayer_rotation_key_arns` while a rollback is possible; emptying that list is a later, separate change. The old account
keeps its leftover JUNOX (there is no sweep tool). `FENCE#relayer#<old>` and `ROLE#relayer#<old>` stay behind, inert.
Retiring a relayer key is a separate, reviewed change (a `removed` block with `destroy = false`, then a scheduled deletion).

### Rollback (the new relayer cannot start, or cannot be made usable)

Every rollback is the same rotation backwards, through the same gate: drain-first, the queue of the address being left
proven empty, the operator moved by the admin inside the drained window, the old key (retained) configured again.

| Where it stopped | Rollback |
|---|---|
| after G3, before S1 and A1 (nothing switched) | nothing to undo: start the pools again on the unchanged configuration (`terraform apply` restores the desired counts); the gate record is only evidence. |
| after S1, before A1 (operator `<new>`, configuration `<old>`) | the admin sends `set_operator(<old>)` (`set-operator-plan --to-relayer <old> --to-relayer-key <old key ARN>` first; if `<old>` is under the planning reserve, top it up just in time -- BEFORE the pools restart and it can receive new money work), then start the pools on the unchanged configuration (until then the old configuration's backend refuses the deployment: financial mode off). |
| after A1 (configuration `<new>`) | 1. `drain-pool` every pool; `capture-evidence <dir2>` (a NEW run and evidence directory). 2. `relayer-rotation-gate --from-relayer <new> --to-relayer <old> --evidence <dir2> --record <dir2>/gate-relayer-rotation.json` -> OPEN (the configuration names `<new>`, `RELAYQ#<new>` empty, every pool drained, the operator `<new>` or `<old>`). 3. If the operator is `<new>`: the admin sends `set_operator(<old>)` (`set-operator-plan --to-relayer <old> --to-relayer-key <old key ARN>`). Before step 4, `<old>` must hold the planning reserve (a just-in-time top-up if it does not; `set-operator-plan` reports the shortfall) -- the old relayer signs nothing during the rollback itself, but the restarted pools give it new money work. 4. `stacks/app`: `signing_keys.relayer` = the old key, `escrow.relayer_address` = `<old>`, `escrow.trust.operators` = `[<old>]`, `relayer_rotation_key_arns` = `[<r<N> ARN>]`; apply (the pools start from zero). The ledger stack does not change (r<N> stays). 5. Certify the rollback: `--scenario relayer-rotation-drill --from-relayer <new> --to-relayer <old>` -- the same proof, now for the old relayer. |

**No safe rollback is defined (stop; owner decision) when:**
- **`RELAYQ#<new>` holds entries** (the new relayer accepted work it cannot finish -- e.g. it is unfunded or not yet the
  operator, so a Start fails and its intent is held). The rollback gate stays CLOSED and nothing migrates the entries.
  The only defined path is FORWARD: make the new relayer usable (fund it; `set_operator(<new>)`) so it drains its own
  queue, then roll back if still wanted. A `held` intent never drains by itself, and there is no supported tool that
  resolves one in the AWS mode.
- **the admin cannot sign** once `set_operator(<new>)` landed: the operator cannot move back (forward only).
- **the old key is disabled or scheduled for deletion**: the old address cannot sign until it is re-enabled
  (`CancelKeyDeletion` within the 30-day window).
- **the contract is paused, its operator is a third account, or the chain cannot be read**: the gate is closed and
  nothing is proven -- investigate, do not force.

### The funding-phase real-money game

Resolve an open funding-phase money game (settle it, or let its players cancel it deliberately) BEFORE G2. This task does
not touch it. Why:
- the pools are drained for the whole window: no admission is issued, no `Join` is admitted, nobody can press Start;
- the operator changes inside the window: until S1 and A1 have both happened, NO relayer can Start it (the old one is no
  longer the operator, or the new one is not yet configured), and a `Start` intent still queued under `<old>` keeps the
  gate CLOSED;
- its funding deadline keeps running: if it passes, anyone may `Cancel` on chain, which refunds each NET ante -- the
  escrow's basis-point fee on every deposit is not refunded -- and the server must reconcile what the chain shows;
- a roster frozen for Start (reversible until Start lands) would sit across the window.

## Financial key sets: dedicated settlement + admission keys (Phase 5, JX-1K)

A separate financial deployment (e.g. JX-1, its own escrow contract) signs with its OWN settlement and admission keys,
never the original ones. The ledger stack creates them by label:

```
stacks/ledger:  financial_key_sets = ["jx1"]                                   plan, then apply
  -> exactly two new keys, settlement-jx1 and admission-jx1 (aws_kms_key.signing["settlement-jx1"] / ["admission-jx1"]),
     beside every existing key: same ECC_SECG_P256K1 / SIGN_VERIFY spec, single-region, same key policy (task role:
     GetPublicKey + Sign ECDSA_SHA_256 over a DIGEST; bootstrap: DescribeKey / GetPublicKey / ListGrants), prevent_destroy.
     Tags: gs:signing-purpose = settlement | admission, gs:key-set = jx1.
  output financial_key_arns = { jx1 = { settlement = <key ARN>, admission = <key ARN> } }
stacks/app:     signing_keys.settlement = financial_key_arns["jx1"].settlement
                signing_keys.admission  = financial_key_arns["jx1"].admission   (only when that deployment is repointed)
stacks/single-host (COST-1): the same signing_keys pair; the host role signs with exactly the three configured keys
```

- **Single host (COST-1).** A financial key's policy is the original keys' policy, so it authorises exactly the ledger's
  app runtime roles: the ECS task role while `ecs_task_role_authorized`, and `app_runtime_role_arns` (only
  `gs-<env>-host-app`) -- both during the migration, the host role alone after it. The host role's own IAM policy names
  the three `signing_keys` ARNs and nothing else, digest-only. Neither side is widened by a key set; adding the host role
  changes only the key policies -- every key keeps its ARN (`modules/ledger` test `p5int_*`, mocked provider: it pins the
  policy statements and the ARNs; the in-place policy update itself is the provider's `aws_kms_key.policy` semantics).
- **Budget.** `COST_BUDGET.json` `max_kms_keys` = 6 is the LIVE-6 -> JX-1 transition (the three + `relayer-r2` + one
  financial pair); the budget's expected configuration is 3. Keys are `prevent_destroy`: after JX-1 the extra keys stay
  (and bill, $1/key-month) until a reviewed retirement brings the count back. A further label or rotation key during the
  transition is an owner budget decision (`cost1SingleHost.test.ts`, "P5-INT-1").

- **Append-only.** Never remove a label from a live environment: removing it would destroy its keys, and
  `prevent_destroy` refuses that plan. Add a new label for a new pair; never reuse one.
- **Financial keys, not relayer keys.** No relayer key is created; `relayer_key_count` / `relayer_key_arns` and
  `relayer_rotation_key_arns` are unaffected. `signing_key_arns` stays exactly the original three.
- **Labels:** `^[a-z][a-z0-9]{1,15}$` (no hyphen), unique, never `r<N>`; requires `signing_keys_enabled`. Default `[]`
  leaves an existing deployment's plan unchanged.

## The dedicated REMEDY key (Phase 3 escrow 2.1; owner decision 2026-10-08)

Escrow 2.1.0's REMEDY attestations (the clock's timed outcomes: timeout annulment, foreclosure, third-strike foreclosure)
are signed by a key of their OWN purpose -- never the relayer, settlement or admission key. The server already refuses to
run timed money without it (fail closed); this is how the infrastructure provides it. Nothing here creates a key until an
owner-authorized `terraform apply`.

```
stacks/ledger:      remedy_key_count = 1                                       plan, then apply (BEFORE the 2.1 instantiate)
  -> exactly one new key, remedy-r1 (aws_kms_key.signing["remedy-r1"]): same ECC_SECG_P256K1 / SIGN_VERIFY spec,
     single-region, the same least-privilege key policy as every signing key (the app runtime roles GetPublicKey + Sign
     ECDSA_SHA_256 over a DIGEST; bootstrap DescribeKey / GetPublicKey / ListGrants; the account administers, never signs;
     nobody CreateGrant), prevent_destroy. Tags: gs:signing-purpose = remedy, gs:remedy-key = r1.
  output remedy_key_arns = { r1 = <key ARN> }            (never part of signing_key_arns / financial_key_arns)
awsDeploy signer-keys --relayer <arn> --settlement <arn> --admission <arn> --remedy <remedy_key_arns.r1>
  -> remedy.public_key_hex: the instantiate message's remedy_keys = [it] (remedy key id 1)
stacks/app:         remedy_signing_key = remedy_key_arns.r1
                    escrow.remedy_key  = { remedy_key_id = 1, public_key_hex = <remedy.public_key_hex> }   (both or neither)
  -> the Juno document's remedy_key { remedy_key_id, public_key_hex, signer { kind kms, key_ref } };
     task role: RemedyKeyPublicKey + RemedyKeySignDigestOnly on exactly that key (its OWN statements; the three-key
     statements are unchanged); bootstrap role: RemedyKeyReadOnly (DescribeKey / GetPublicKey / ListGrants)
stacks/single-host: remedy_signing_key = the same ARN -> the host role's own RemedyKeyPublicKey / RemedyKeySignDigestOnly
migration guard:    host-create(-complete) ... --remedy-key <the same ARN>   (an operator fact: a plan alone never adds one)
```

- **Validation.** A key ARN (never an alias), in the signing keys' one region, never one of the three configured keys nor a
  relayer rotation key; `remedy_signing_key` and `escrow.remedy_key` together or not at all; the on-chain id 1..64 and a
  33-byte compressed public key that is neither the settlement nor the admission key.
- **Verification.** `awsDeploy verify` reads the remedy key like the others (metadata, no grants, its public key = the
  configured one); the server's startup identity check and `verifyJunoDeployment` (the contract's REMEDY registry holds
  exactly this key, active; any other active remedy key refuses the deployment); after instantiate,
  `contracts/escrow/scripts/verify_escrow21_deployment.py verify` (read-only).
- **Rotation.** Append-only like the relayer keys: `remedy_key_count = 2` PREPARES `remedy-r2` beside `r1` (nothing signs with
  it until the app stack names it AND the contract registers it by `AddRemedyKey`); retiring a key is on chain
  (`RetireRemedyKey`) then a reviewed `removed` block, never a lower count (`prevent_destroy` refuses).
- **Budget.** The 2.1 release is 4 keys (the three + remedy-r1), within `max_kms_keys` = 6. **Live staging (read-only
  inventory, 2026-10-08): 3 project keys** -- relayer r1, settlement, admission, all Enabled and referenced by the live Juno
  document; relayer-r2, settlement-jx1 and admission-jx1 do NOT exist (the JX-1K `financial_key_sets` apply never happened).
  So adding remedy-r1 gives **4 total**, no key retirement is needed for the 2.1 release. FUTURE capacity scenario only: if
  relayer-r2 and the jx1 financial pair are ever created beside the remedy key it would be 7 > 6 -- sequence or retire then,
  an owner budget decision (`cost1SingleHost.test.ts`). Record: Project `claude/PHASE3_KMS_PRERELEASE_INVENTORY_2026-10-08.md`.
- **Default `remedy_key_count = 0` / `remedy_signing_key = null`:** every existing plan, policy and document is unchanged.
- **The 2.1 cutover changes the image and the Juno document TOGETHER, and rolls them back together.** The Juno document is
  ONE SSM parameter per environment (`/gs/<env>/juno-backend`, read at every task / host start), and each build refuses a
  document naming another escrow checksum at startup: a pre-2.1 image refuses a `c3bd0618…` document and a 2.1 image refuses
  a `5ecc3022…` one. So (review, release MEDIUM): one owner-authorized apply moves `escrow.code_checksum` /
  `contract_address` / the remedy values AND the image (`build_id` / task definition; on the single host the release digest)
  in the same window, with the pools drained and no open 2.0 money game; ECS automatic rollback to the previous task
  definition must be OFF for that deploy (it would start the old image against the new document and refuse to start); a
  rollback is the Terraform revert of BOTH, never of one. Money stays safe either way -- a mismatch never verifies -- this is
  about availability.

## Generation switch after a restore (L6-4 §12.1, wired by L6-2)

Strictly in this order; Terraform/SSM never race ahead of the adoption (the staging drill's full workflow, with its
evidence, is "The restore drill" under "Staging certification" below):

0. **Before any mutation:** the recovery role `gs-<env>-recovery` must already EXIST (`recovery_trusted_principal_arns`
   names the operator principals, applied), and `recovery_break_glass = true` is applied. Fix the run id, the evidence
   directory and the restore id NOW: `capture-restore-stop`, the PITR restore's target, `table-prepare`, `appgen-adopt`, the
   generation gate and the certification all name the same ones (the drill's gates refuse anything else).
1. Stop every pool (drain-first) and capture the stopped state (`capture-restore-stop`: its `captured_at` is the STOP TIME).
   **The restore point:** wait until DynamoDB's `LatestRestorableDateTime` of `gs-<env>-game-g<N>` is at or after the stop
   time (`aws dynamodb describe-continuous-backups --table-name gs-<env>-game-g<N> --query
   ContinuousBackupsDescription.PointInTimeRecoveryDescription.LatestRestorableDateTime`), then restore TO THE STOP TIME --
   or the earliest point at or after it that DynamoDB accepts -- never to a point before the stopped-state capture (an
   earlier point resurrects stale routing / game state, e.g. a routing version from before a flip, and loses the last
   writes; after the stop nothing writes, so the stop time loses nothing):
   `aws dynamodb restore-table-to-point-in-time --source-table-name gs-<env>-game-g<N> --target-table-name
   gs-<env>-game-g<N+1> --restore-date-time <the stop time>` as the recovery role, outside Terraform; wait for ACTIVE.
2. `table-prepare ... --restore-point <the same time, ms> --restore-id <id> --apply`, then `appgen-adopt ... --apply
   --stopped` → `committed` / `already-adopted` for exactly (N+1, that table, that restore id), within 6 h of the stop
   capture. **APPGEN = N+1 and `APPGEN#HISTORY / GEN#<N+1>` are IRREVERSIBLE**: the ledger is never restored and APPGEN never
   moves backwards. A "rollback" is a LATER generation (another restore into `g<N+2>`, prepared and adopted N+1 → N+2),
   never APPGEN moved back.
3. `npm run awsDeploy -- generation-gate --runtime-parameter <ARN> --environment <env> --generation N+1 --restore-id <id>
   --record <file>` (read-only) → `GATE OPEN` and the `generation_adoption = {...}` line. L6-5B: `--record` writes the
   gate's own attestation (`18COSMOS/GENERATION-GATE/v1`, created once); certification binds the plan's
   `generation_adoption` to that record field for field (owner decision: the gate's machine value, never a hand-entered
   replacement).
4. In `stacks/app`: add N+1 to `game_generations` (keep N), an `import` block for the new table, `generation = N+1`,
   `generation_adoption = {...}`. The plan refuses services unless the new table's marker equals that attestation; the
   module re-enables PITR and deletion protection on the import. **`gs-<env>-game-g<N+1>` is PERMANENT from here** (it is the
   serving generation, `prevent_destroy`); **`g<N>` is RETAINED and protected** (still in `game_generations`).
5. Start the services; the tasks re-check APPGEN, the marker and the adoption binding themselves. Money games of a restored
   table are **read-only** until each one's history (F1) and chain facts are verified in that process (never stored:
   every restart verifies again). `gamesDoctor aws orphans` lists ledger reservations/attempts the restored table does not
   account for (read-only; chain games are reported NOT COVERED).
6. **Break-glass OFF immediately** -- `recovery_break_glass = false`, applied -- as soon as step 4's apply has imported and
   protected `g<N+1>` and the switch is established (the tasks serve N+1). Not earlier: until `g<N+1>` is in
   `game_generations` it is outside `local.game_table_arns`, so `table-prepare`'s writes and `appgen-adopt`'s marker read on
   it work ONLY through the break-glass statement (keep it on through `RestoreTableToPointInTime`, `table-prepare`,
   `appgen-adopt` and the import). Not later: that statement also grants Put/Update/Delete/Scan on EVERY `game-g*` table,
   the serving one included.

**Windows / PowerShell:** run the mutating commands as `node dist/...` (as `recoveryCli.js` and `awsDeploy.js` are written
in the drill below), not through `npm run ... -- ...`: in PowerShell `npm` is `npm.ps1`, which can swallow the `--`
separator, so `--apply` / `--stopped` / `--record` reach npm instead of the command and it silently runs as a DRY RUN or
writes no record. If `npm` is used anyway, quote the separator (`npm run recovery '--' appgen-adopt ...`) and check the
answer (`"dry_run": false`, APPLIED, the record file exists). AWS CLI v2 (`aws.exe`) only.

**Generation retirement is separate from pool retirement.** The old table is not removed by the adoption or the switch:
it stays in `game_generations` with `prevent_destroy` and deletion protection until a separate, reviewed change removes it
after the new generation is verified.

**One-way identity layout.** Every task definition carries `gs:identity-layout` (`identity_layout_version`, >= 2); the
first AWS deployment is already L6-4-aware, and `awsDeploy verify` / the flip preflight fail if any ACTIVE revision -- any
circuit-breaker rollback target -- lacks it. There is no pre-L6-4 rollback target.

## Verification: `npm run awsDeploy -- verify` (read-only)

- **`--part app`** (the default; app-account credentials, e.g. the bootstrap role) checks:
  - both documents, through the task's own `loadAwsStartup`, and every pool's document, against the naming contract;
  - the game and identity tables in full: keys, billing, indexes, replicas, deletion protection, PITR, and TTL (`ttl` on
    identity and, L6-5B, on the game table -- every other managed generation too with `--game-generations 1,2`; never on
    the ledger);
  - the ledger's DescribeTable (cross-account);
  - that APPGEN holds the generation, SYSTEM/ROUTING names the primary, and `SYSTEM/GENERATION` satisfies the tasks'
    startup rule (and, for a restored table, APPGEN's adoption binds it);
  - (L6-2) every runtime document is v2, its route table names exactly the deployed pools, and the pools' documents agree;
  - the KMS keys: Enabled, customer-managed, single-region, ECC_SECG_P256K1 / SIGN_VERIFY / ECDSA_SHA_256, **no grants**,
    and public keys equal to the configuration's (the backend's own `checkSignerIdentities`);
  - with `--evidence <dir>`, the control plane:
    - each task definition is **the revision the service runs**, with references only, stopTimeout 120, `/gs/healthz`,
      awslogs and awsvpc;
    - services are stop-first, one task each, AZ rebalancing off, circuit breaker on, no ECS Exec, no public IP, and
      **each behind its own target group**, none with a deployment in progress;
    - each pool's target group checks `/gs/readyz` for 200; each running pool's target is healthy (a non-primary router
      included), a drained pool's group is empty;
    - each exact `ws_path` goes to its own group before `/gs*`, `/gs*` goes to the primary's group, nothing shadows a
      pool, and the ALB idle timeout is at least 120 s;
    - every ACTIVE task-definition revision declares the identity layout;
    - with `--flip-record`, after the flip's CAS: an exit 5 of each pool, no exit 3/4, and a replacement running;
    - CloudFront's `/gs*` behaviour is the **first** to match `/gs` paths, uncached, with **all** query strings, cookies,
      Origin and WebSocket headers;
    - the task SG admits the ALB SG only, and the ALB SG admits a prefix list only;
    - (L6-5B) the CloudWatch alarms (`alarms.json`) against `modules/app/alarm-contract.json`: every alarm, its metrics,
      math, dimensions, thresholds, evaluation and missing data; the primary-only alarms on `--primary-pool`; the page /
      ticket wiring class (exactly `--page-actions` / `--ticket-actions` when given -- `none` is valid in staging); each
      suppressible alarm notifying only through its composite suppressed by its OWN pool's window; nothing else wrapped;
      no alarm's actions disabled; no suppressor in ALARM outside an open, unexpired window of its pool (`--flip-record`);
      nothing in the game-server namespace outside the contract.
- **`--part ledger`** (ledger-account credentials) checks the ledger's PITR and TTL (which are not readable across
  accounts) and APPGEN.
- **`--part all`** runs both halves, for the single-account form.
- A missing evidence file fails the run. Omitting evidence must be explicit (`--no-evidence`) and is reported as SKIP.

### The single host: `verify --topology coexist | single-host` (COST-2A)

The data plane above runs unchanged for every topology. `--topology` (default `ecs`: everything above, byte for byte)
selects the control plane:

| `--topology` | When (SINGLE_HOST_MIGRATION.md) | The ECS era | The host |
|---|---|---|---|
| `ecs` | before the host (A-C) | judged as above | -- |
| `coexist` | D-I: the host exists, the ECS era is the rollback path | MAY exist, but **drained**: no service task desired / running / pending, no task running in the cluster, no target registered (else FAIL: a second serving writer); NAT, endpoints, the L6-5B alarms and pool log groups tolerated and reported (`SKIP`) | fully verified (or `--instance-id none` before step D: no host may exist) |
| `single-host` | after step I; `--pools` is exactly the primary | **absent**: no ECS cluster other than INACTIVE, no `gs-<env>-alb` / `gs-<env>-<pool>` (exact names, for the route table's pools, p1, p2 and `--legacy-pools`), no NAT in the host's VPC or `--legacy-vpc` (unless `--allow-nat`), no interface endpoint there and no endpoint tagged for the environment (unless `--allow-vpc-endpoint`), no L6-5B alarm / composite / suppressor (the contract's names, or an `Environment` dimension), no pool log group, no Container Insights log group, no ECS-era security group, no other environment EIP and no unassociated EIP (unless `--allow-eip`) | fully verified |

The host's checks (`server/src/aws/deploy/hostVerify.ts`): **EC2** exactly one non-terminated instance that is tagged
as this environment's single host OR holds the host role's instance profile (an untagged holder of the role is a second
host) -- the one named -- running, an allowed type (COST_BUDGET.json) whose architecture the instance, the AMI and the `gs:arch` tag
share, CPU credits `standard`, IMDSv2 required with hop limit 2, every volume encrypted, termination protection, no key
pair, basic monitoring, the `gs-<env>-host-app` profile; **network** one ENI carrying only the host SG, exactly one host
EIP on that ENI that IS the host's public address, ingress 443 from CloudFront's origin-facing list only, 80 for ACME
only, nothing reaching 8917, SSH only with `--emergency-ssh` (at most two /32), egress tcp 443 (+ `--juno-egress-ports`);
**IAM** the profile holds the host role, assumable by EC2 of this account only, no managed policy, one inline policy whose
every action and resource is the runtime documents' (tables, this pool's documents, the escrow configuration's KMS keys
-- exactly those -- the one repository and log group); **host** SSM online and the `gs-health` line: ready, origin TLS
ready, no HOLD, gs-server and gs-caddy active, release digest = running digest = `--expect-digest`, build =
`--expect-build`, no static credential, and it serves `--origin-hostname` (its own `origin_hostname`: the chain
CloudFront -> this host); **edge** `/gs*` reaches `--gs-origin` (the host's `--origin-hostname` in the final
state), L5-8's edge judgement, the `gs-<env>-gs-all-query-cookies-origin` policy, the default behaviour on `site` =
`--site-origin`; **observability** the one host log group (<= 90 days), exactly the five host alarms on THIS instance
(muted, mis-thresholded or stale ones fail; their destinations must be stated, `--alarm-actions <arn,...>` or `none`,
else NOT EVALUATED), the monthly budget (<= $30; `--budget not-required` when it lives in the
payer account); **roles** (the operator's snapshot) the routing's primary is the host's pool, APPGEN, and the identity
writer and relayer held by that pool's CURRENT task (anything else is a second serving writer); open money games settled;
RELAYQ read live.

**Three answers.** `PASS`, `FAIL`, and `NOT EVALUATED`: a missing evidence file, one the capture wrote as
`<name>.error.json`, an answer without its list, or a file the capture's manifest never wrote (an earlier capture's: the
capture also empties the directory first) is NOT EVALUATED -- never a pass; an absence ("no ALB") passes only on a listing
read completely. Terraform outputs asked for but unreadable are NOT EVALUATED (not asked for: a named SKIP). Before step D
(`--instance-id none`) the host's log group, alarms and budget are named SKIPs (they are created with the host). Exit 0 VERIFIED, 1 FAIL, **3 NOT EVALUATED**. `--record` carries the same verdict and the
topology; `--report <dir>` writes `host-evidence.json` (`18COSMOS/HOST-VERIFY-REPORT/v1`: the facts -- source commit,
Terraform outputs, EC2, IAM, network, EIP, CloudFront, host release, health / HOLD, generation / APPGEN, roles, alarms,
money / RELAYQ -- and every check) and `host-evidence.md`.

```
# 1. control plane (describe / get / list; the bootstrap role's HostVerifier* statements):
infra/aws/scripts/capture-host-evidence.sh <env> <region> <i-...> <distribution id> <dir> [--terraform-dir infra/aws/stacks/single-host]   # from the repository root
#    the host's status line (RECON-1: the HOST-DEPLOY principal's credentials -- the one that runs gs-host --
#    ssm:SendCommand of the FIXED /opt/gs/bin/gs-health; the operator role holds no SSM Run Command):
infra/aws/scripts/capture-host-evidence.sh --host-status-only <env> <region> <i-...> <dir>    # or --host-status above
# 2. the runtime snapshot (the operator role; read-only) -- AFTER step 1 (the capture empties the directory first):
npm run gamesDoctor -- aws host-snapshot --aws-config <runtime SSM ARN> --out <dir>/runtime-snapshot.json
# 3. judge (the bootstrap role):
npm run awsDeploy -- verify --topology single-host --runtime-parameter <ARN> --environment <env> --primary-pool p1 \
  --generation <N> --evidence <dir> --instance-id <i-...> --origin-hostname <origin> --site-origin <site origin> \
  --expect-digest sha256:<release> --expect-build <build> --alarm-actions <arn,...|none> --record <dir>/verify.json --report <dir>
#    coexistence: --topology coexist --pools p1,p2 --gs-origin <the /gs* origin of this step: the ALB's before G, the host's after>
```

Windows: `capture-host-evidence.ps1 -Environment ... -InstanceId ... -Distribution ... -Out ... [-HostStatus | -HostStatusOnly]`
and `node dist/...` for the Node steps (PowerShell's `npm.ps1` swallows `--`).

## Alarms (LIVE-6 L6-5B): `modules/app/alarms.tf`, `alarm-contract.json`

Every alarm is one entry of `alarm-contract.json` over L6-5A's EMF metrics (namespace `18Cosmos/GameServer`, dimensions
`[Environment]` or `[Environment, Pool]` only -- never a task, build, generation, epoch, game, principal, wallet, key or
condition code; no Logs metric filter exists). Names are stable: `gs-<env>-<id>`, `gs-<env>-<pool>-<id>`,
`gs-<env>-primary-<id>`. Actions: `page_alarm_action_arns` / `ticket_alarm_action_arns` (created elsewhere; empty is valid
in staging; one ARN is never in both). The full table and thresholds: the L6-5B report.

- **Scope.** Environment alarms once (the forced-exit and failure counters). Pool alarms on every pool (a drained pool has
  no data and never pages; the relayer page A15 and unverified restored games R3 are on every pool because only the role
  holder / primary emits them). Primary alarms (A6 relayer usable, A7 escrow active, A13 heartbeat) watch the pool marked
  `primary`: **a flip moves them in place** in the same plan as the `/gs*` rule, and the plan refuses that until
  SYSTEM/ROUTING names the new primary.
- **Planned-flip suppression.** Only A6, A11, A12, A12b and A13 (the flip's expected effects: the two pools' exit-5
  restarts, the non-primary transition, readiness / target-health flap) are suppressible: each is a metric alarm without
  actions plus a composite `<name>-notify` whose `actions_suppressor` is its pool's `gs-<env>-<pool>-flip-window`. That
  suppressor is ALARM only while its pool's published `FlipWindowOpen` minutes sum to at least 1 (+1 per open window, -1
  per close); with no data it is OK. **Never
  suppressed:** exit 3 / 4 (A1, A3), refused starts and generation / adoption / identity-restore refusals (A4, A4g, A4i),
  generation loss (R1), journal-ahead (R2), unverified restored games (R3), the money sweep (A5*), escrow (A7), KMS
  (A8-A10), the relayer page (A15), a timed money table frozen at minute 30 (C1). A restore/adoption is not a flip: no restore alarm is suppressible, so an overlapping
  flip window never masks one.
- **C1 (Phase 3 escrow 2.1): a frozen timed money table.** `ClockFinalityHeldTables` -- the primary's count of Live money
  tables at a minute 30 that is due but undecided because the approvers' consent keys cannot be read on chain -- `Minimum`
  >= 1 for 3 minutes pages, on every pool (only the primary emits it). Every move and vote at such a table is refused until
  a read succeeds (fail closed). Which games: the `clock.finality-keys-unread` audit lines. The single host counts it in
  `HostHealthProblems` (its existing health alarm pages after 3 minutes).
- **A13 and a skipped flag move.** A13 counts the `Primary` gauge, which only the identity-writer's task reports: if the
  Terraform `primary` flag is not moved after a flip, A13 still watches the demoted pool, finds no sample and PAGES once
  the window ends -- a stale attachment is loud, never silent.
- **A drained primary pages (by design).** A13's missing data breaches: draining the PRIMARY pool (a drain-first deploy of
  it, a relayer rotation, a restore) is an outage of the game and pages after 3 minutes. A bounded planned-maintenance
  window (the same additive mechanism under its own metric) is an owner decision (the L6-5B report).
- **Never mute by hand.** Do not use `disable-alarm-actions`: `verify` fails any alarm whose actions are disabled. To
  end a window early, `recover --flip-record` (settled) closes it; otherwise it ends at `expires_at`.

## Staging certification (LIVE-6 L6-6): `npm run awsDeploy -- stage-cert | stage-probe`

The real-AWS staging gate as ONE run (`--run-id`, lower-case) and ONE evidence directory. **Certifying deploys and
mutates nothing**: `stage-cert` only reads (the verifier's reads, plus `SYSTEM/GENERATION` and APPGEN when L6-4's readers
are bound) and writes the evidence directory. The only mutations are explicit opt-ins: the certifier task
(`run-task-probe`, one standalone task whose command is the probe and whose `GS_STORAGE` is a value `start.ts` refuses) and,
only with `--disposable-writes L6CERT#<run>`, writes to that one disposable game-table partition (deleted and read back
empty). There is no `--force`. The code is `server/src/aws/deploy/staging/`; the report: Project
`claude/LIVE6_L6_6_STAGING_CERT_HARNESS_2026-09-30.md`.

**Read-only order** (the default scenario):

```
1  infra/aws/scripts/capture-evidence.sh <env> <region> <primary> <distribution> <dir>
2  npm run awsDeploy -- stage-cert prerequisite --run-id R --evidence <dir> --runtime-parameter <ARN> --environment <env> \
       --primary-pool <p> --generation <N> [--part all]      # two accounts: verify --part ledger --record <dir>/verify-ledger.json --run-id R
3  infra/aws/scripts/run-task-probe.sh <env> <region> <p> <N> R <dir> --disposable-writes     # IAM, KMS, transactions, identity state
4  GS_CERT_SESSION_COOKIE=<staging session> npm run awsDeploy -- stage-probe edge --run-id R --evidence <dir> \
       --base-url https://<distribution name or alias> --origin https://<allowed origin> --environment <env> --generation <N> \
       --pool <p> [--expected-client-ip <your public IP>]
5  infra/aws/scripts/plan-evidence.sh ledger <dir> R ...;  infra/aws/scripts/plan-evidence.sh app <dir> R ...
6  infra/aws/scripts/capture-evidence.sh ... <dir>      # again: the captures must post-date the probes
7  npm run awsDeploy -- stage-cert certify --run-id R --evidence <dir> <the step-2 flags> --scenario read-only --commit <HEAD>
```

**The single host (PHASE 1 REMAINDER).** This certification is the ECS era's. On the single host, step 4's probe runs
as `stage-probe edge --topology single-host --host-evidence <the verified host capture> --instance-id <i-...>
--origin-hostname <origin>` (it stands on the host's `verify --topology coexist|single-host` record and report instead of
steps 1-3, and judges its own record: `edge-single-host-verdict.json`), and step 3's task-role probe runs ON the host under
the instance role as `gs-host role-probe` (infra/aws/single-host/host-role-probe.sh), judged offline by
`stage-probe host-role`. SINGLE_HOST_MIGRATION.md F5 / F6 and step 16 give the exact commands.

**The cluster listing** (L6-6P, `cluster-tasks.json`, `18COSMOS/L6-6P-CLUSTER-TASKS/v1`): `capture-evidence` lists every
task of desired status RUNNING **and** STOPPED (a task draining under SIGTERM has desired STOPPED), following every
`list-tasks` page (100 each) to the end, and describes every distinct ARN in batches of 50 (LIVE-6 W1; the prerequisite
judges 1-100 per batch, DescribeTasks' own bound, so a pre-W1 capture of 100s still judges), each answer kept whole:
`{format, cluster, listed_at, listings: [{desired_status, pages: [{page, task_arns, more}]}], task_count, batches}`. The
prerequisite re-derives completeness from the file (the page chain ends, every ARN described exactly once, no failure,
taken with this capture and after the probes) and FAILS anything less -- and FAILS on any task not STOPPED that is not a
pool service's settled task (a stray, a draining or starting task, an old revision). A failed call stops the script and
leaves no `capture.json`, so a partial capture is never certified. If certify reports a draining task (the certifier task
still stopping, say), wait until it is STOPPED and run step 6 again.

**Replacement scenario:** `drain-pool.sh <env> <region> <pool> <dir> R`, then `terraform apply`, then steps 1-7 with
`--scenario replacement --replaced-pools <pool>` (the drain precedes the prerequisite, which examines the new deployment).
**Restore drill** (L6-4): the whole ordered workflow, with every producer, is "The restore drill" below; certify with
`--scenario restore-drill --game-generations N,N+1`.

**The gates** (a gate passes only with at least one check and every check passed; missing evidence and verifier SKIPs are
failures): prerequisite (settled, the examined revision running, nothing beside the services, target health, unchanged since
step 2), drain (replacement), IAM / LeadingKeys inside transactions as the task role, real transaction semantics
(conditions, TransactionConflict, same-token resend), proxy hops (exactly two appended X-Forwarded-For entries), ALL query
strings (`cp`, `cr`, `cb` and unrelated ones, through the diagnostic `/gs/diag/edge`, mounted only by
`edge_diagnostic_staging` / `GS_EDGE_DIAGNOSTIC=staging`, refused on mainnet and in `prod*`), the WebSocket announcement and
idle path (longer than every idle bound plus two server pings), KMS Sign latency below 3 s with the configured keys (the
relayer, settlement and admission keys, plus the dedicated REMEDY key whenever the configuration names one; a disposable
digest; no chain, no ledger), both Terraform plans (nothing destroyed, replaced or de-protected except
skip_destroy task-definition revisions; services gated on the routing read), and the evidence package (no secret; the commit
is the checkout's HEAD). **L6-4 contract:** `SYSTEM/GENERATION` strict and bound by APPGEN's adoption (never the number
alone), the identity table serving-safe with its `TABLE#identity` binding, no open `REVIEW#`, L6-4 in the image of EVERY pool's automatic rollback target -- the circuit breaker's
target is the service's most recent COMPLETED deployment (in a settled service, the running one), never "any ACTIVE
revision" -- attested by image (the task definition's reference and the digest ECS ran), from this run's certifier task or an
earlier PASSing certification of the same environment copied into `prior-certifications/` (L6-6R) -- so EVERY pool runs
at least one task during a certification (a pool at desired 0 shows ECS no digest, and its task definition names a tag,
which is not evidence of content: its rollback target FAILS unless pinned `@sha256:`) -- and for a restore drill the stop
before `adopted_at` and the fencing slot. **Bound (LIVE-6 final convergence):** `tools/awsDeploy.ts` binds L6-4's own
readers and startup rule (`readGenerationMarker`, `readAppGeneration`, `generationMarkerProblem` then
`adoptionBindingProblem` in the runtime's order, `readIdentityRestore` + `readIdentityTableSelf` + `identityServingProblem`,
`inspectIdentityRestore`'s REVIEW# mapped to `{restore_id, reason, open}` only, `readAdoptionRecord`), so these gates are
live; an unbound build would still FAIL them "not integrated".

The first line of `CERTIFICATION.txt` (and of the command's output) is `LIVE-6 AWS STAGING CERTIFICATION: PASS` or `FAIL`,
then every failed gate. `certification.json` and `certification-manifest.json` (SHA-256 of every file) sit beside it.
(LIVE-6 W1: the certification's manifest was `MANIFEST.json` before; on a case-insensitive filesystem -- Windows/NTFS --
that is the SAME file as capture-evidence's `manifest.json`, which it overwrote. No two names in an evidence package fold
to the same lower-case path; a `MANIFEST.json` left by an older certification is not read, and not deleted -- on Windows it
would be the captured `manifest.json`.)

### The converged gates and drills (LIVE-6 final convergence, `aws/deploy/staging/drills.ts`)

Every gate judges with the owning slice's own code; nothing restates a contract. `stage-cert` also takes the verifier's
L6-5B flags (`--game-generations`, `--page-actions <arns>|none`, `--ticket-actions <arns>|none`; staging may use `none`).

| Gate | Scenario | Evidence (in the run's directory) | What it proves |
|---|---|---|---|
| `alarms` | every | `alarms.json`, `manifest.json`, `capture.json` | L6-5B's `checkAlarmsEvidence` (every contract alarm, its metrics / math, namespace, `Environment` / `Pool` dimensions only, primary scope, class wiring, suppression wiring, `ActionsEnabled`, no suppressor stuck in ALARM outside an active window, nothing unknown in the game-server namespace), judged at the capture's time; the capture is this environment's and these pools'; every contract alarm's ARN is this account's, this region's, by its stable name. Never a BUILD_ID. |
| `generation-gate` | restore-drill | `gate-generation.json` (`awsDeploy generation-gate ... --record <dir>/gate-generation.json`), `terraform/app/plan.json` | L6-5B's `generationAttestationProblem` against the plan's own `generation_adoption`, AND the record's `adoption_claim` = the ledger's `APPGEN#HISTORY / GEN#<new>` claim = APPGEN's, read live (read-only) through L6-4's `readAdoptionRecord`. Terraform itself still reads nothing cross-account. |
| `restore-alarms` | restore-drill | `probe-restore-alarms.json` (`18COSMOS/L6-6-RESTORE-ALARM-DRILL/v1`) + `restore-alarms/` (the captures) | R1, A4g, A4i, R2 and R3 each fired after an ALARM-PIPELINE INJECTION, actions never suppressed -- every case RE-DERIVED from its AWS captures (the probe task, its log's EMF line, describe-alarms before and after, describe-alarm-history), not ALARM before the injection, firing no earlier than the contract's periods allow (R3: 59 min) and within the binding; at least one inside a staging flip-suppression overlap test PROVEN active (both suppressors ALARM at the injection, from CloudWatch) whose SYSTEM/ROUTING was unchanged. A self-reported window is never evidence. No restore suppression window exists. |
| `restore-fence` (L6-6R) | restore-drill | `probe-restore-fencing.json` (`18COSMOS/L6-6-RESTORE-FENCING/v1`) + `restore-fence/` | the judge is unchanged: bound to THE adoption; the old generation's ledger write refused by the generation fence; an old-generation task never ready (reason generation, exit 2/3); KMS Sign withheld with 0 calls; the adopted generation serving ready on the adopted table. Produced by `stage-probe restore-fencing record` (below). |
| `restore-quiet` (L6-6R) | restore-drill | `restore-stop/` + the live TASK# read | as before, plus L6-5A's `TASK#` items of the PREVIOUS generation's table (strongly consistent, paginated Scan, decoded strictly): a heartbeat of generation N written after the stop's `captured_at` FAILS; none proves nothing (ECS's listing is the stop proof); an unreadable table FAILS. TASK# is never a lease. |
| `flip` | flip-drill | `flip-record.json` (L6-2's record: `gamesDoctor aws flip ... --flip-record <dir>/flip-record.json`, then `flip-observe` / `recover --flip-record` with the same file), the per-pool captures, `cluster-tasks.json`, `listener-rules.json` | the window opened BEFORE the routing CAS; the CAS applied (version N+1) and the roles settled; both pools restarted into their roles (L6-2's `checkRoleChange`: exit 5, a replacement) and the singleton roles are on the new primary; no service task of either pool stopped with exit 3 or 4 since the window opened (the COMPLETE cluster listing); `/gs*` on the new primary and every pool's exact route (L6-2's `checkPoolListenerRules`); the recovery of the old epoch settled (it closed the window); the suppression published, at most 45 minutes, ended before the capture (+5 min tail). |
| `flip-alarms` | flip-drill | `probe-flip-alarms.json` (`18COSMOS/L6-6-FLIP-ALARM-DRILL/v1`) | an exit 3 inside the window still tripped A1 (actions not suppressed); a suppressible alarm still failing after the window became actionable (`ActionsSuppressedBy` `Alarm` during, `None` after); only the flip's two pools' suppressors were ALARM during it. |
| `relayer-rotation` | relayer-rotation-drill (`--from-relayer <old> --to-relayer <new>`) | `gate-relayer-rotation.json` (`awsDeploy relayer-rotation-gate ... --record <dir>/gate-relayer-rotation.json`, BEFORE the change; v2 since LIVE-6 relayer rotation) | L6-5B's `rotationGateRecordProblem` (v2: plus the deployment to keep, and the contract's operator at the gate = the old or the new relayer); every pool of this deployment drained at the gate; `RELAYQ#<old>` read completely and empty; `RELAYQ#<new>` never consulted; the configuration changed only afterwards (the gate saw the old address, the live document names the new one, every running task started after the gate). Unknown / unreadable = FAIL; no automatic queue migration. |
| `relayer-rotation-proof` | relayer-rotation-drill | the live reading `stage-cert certify` makes itself (read-only; kept as `rotation-proof.json`, judged in memory) + the gate's own record as the baseline | the change WORKED (`staging/rotationProof.ts`): the runtime configuration names the new relayer (a trusted operator, not the old key); the contract's operator on chain IS the new relayer (still the old one, or a third: FAIL); the configured chain, contract and checksums are the gate's and this build's certified ones; the deployment verifies (the server's own `verifyJunoDeployment`); the routing's primary pool's CURRENT task holds `ROLE#relayer#<new>` at the ledger's `FENCE#relayer#<new>` epoch; that task's own fresh `TASK#` heartbeat says relayer `usable` (primary, serving, ready); escrow active (its backend `active`, the deployment verified, the contract not paused); the settlement and admission keys exactly the gate's; `RELAYQ#<old>` still empty; **(proof v2, L6-12D)** the configured relayer KMS key's public key (GetPublicKey only) derives exactly the configured new relayer address, that account exists on chain and holds at least the one-game planning reserve, and its on-chain pub_key -- if the chain shows one -- is the same key (absent is accepted: a funded account that has never signed has none; control is proven by the KMS derivation). Unbound readers, an unread chain, table, key or balance, a v1 gate record, a v1 proof reading: FAIL. |

**A planned primary DRAIN is not a flip** (owner decision): no suppression covers it, and A13 may page. No maintenance
window exists. **Never suppressed, and certified so** (`alarms`): A1, the store alarms, the money sweep, generation /
adoption and identity-restore refusals, the relayer page (A15) and R1-R3.

**Four procedures that must not be confused** (LIVE-6 post-flip drills integration):

| Procedure | Writes SYSTEM/ROUTING? | Publishes FlipWindowOpen? | Changes KMS / escrow config? | Scenario |
|---|---|---|---|---|
| **Actual routing flip** (`gamesDoctor aws flip A B`, "The flip" above) | yes (the CAS) | yes, its own window (the flip suppression) | no | `flip-drill` |
| **Flip suppression** (L6-5B, published BY a flip; never run on its own in production) | no | yes | no | (part of `flip-drill`) |
| **Restore suppression-overlap test** (`gamesDoctor aws suppression-overlap open/close`, staging only) | **no** (read at open and close) | yes, for two pools, to prove R1-R3 / A4 are NOT suppressed | no | (part of `restore-drill`) |
| **Relayer rotation** ("Relayer rotation" above) | no | no (pools are drained, not flipped) | yes: a new relayer key, address and contract operator | `relayer-rotation-drill` |

**Flip drill order:** capture, `gamesDoctor aws flip A B --expect-version N --evidence <dir> --flip-record <dir>/flip-record.json
--apply`; `terraform apply` with `pools.B.primary = true`; during the window inject one exit 3 (a standalone task, not a flip
pool's service task) and keep one suppressible condition of a flip pool failing past the window's end, recording both into
`probe-flip-alarms.json`; `gamesDoctor aws recover A --apply --flip-record <dir>/flip-record.json` until RECOVERY SETTLED;
after the window's end + 5 min, steps 1-7 with `--scenario flip-drill --primary-pool B`.

**The flip alarm drill (`probe-flip-alarms.json`): `infra/aws/scripts/run-flip-alarm-probe.{sh,ps1}`** with
`server/src/aws/deploy/staging/flipAlarmDrill.ts` (the program and every phase's judge; `drills.ts`'s judge unchanged). Two
STANDALONE tasks (the run-task-probe model: the pool's running task definition, the command overridden to the drill's
`node -e` program over the image's own compiled `runtimeMetrics` EMF encoder, GS_STORAGE = a value start.ts refuses): they
take no pool, role, routing, generation or game and never touch the escrow; `inject` and `hold-start` refuse unless the
flip record's window is open. With the flip applied (window open, `<dir>/flip-record.json`):

```
run-flip-alarm-probe hold-start ... <dir> <pool A or B> [<hold seconds>]   # PoolWriterConfirmed=0 for that pool: A12b
run-flip-alarm-probe inject     ... <dir> <pool>                          # TaskLost=1 / TaskSuperseded=0, exit 3: A1
run-flip-alarm-probe observe    ... <dir> a1 A,B                          # polls: the exit 3 in the window, A1 ALARM, actionable
run-flip-alarm-probe observe    ... <dir> during A,B                      # polls: A12b-notify ALARM suppressed by Alarm; only A, B suppressors ALARM
gamesDoctor aws recover A --apply --flip-record <dir>/flip-record.json    # until RECOVERY SETTLED (closes the window)
run-flip-alarm-probe observe    ... <dir> after A,B                       # polls: after the window's end, still ALARM, suppressed by None
run-flip-alarm-probe hold-stop  ... <dir>
node dist/server/src/tools/awsDeploy.js stage-probe flip-alarms record --run-id R --evidence <dir> --environment <env> --pools A,B
```

Each `observe` captures `describe-alarms` (and, for a1, `describe-alarm-history`) with machine timestamps into
`<dir>/flip-alarms/` and stages `observe-<phase>.json` only when that phase is true (NOT YET polls; a phase that can no longer
be true is REFUSED). `record` binds the three to the flip record's window, judges the candidate with `judgeFlipAlarmDrill` and
only then writes `probe-flip-alarms.json`. The hold is bounded (`--hold-seconds` 600..5400, default 4500) and stopped by
`hold-stop`; both tasks must be STOPPED before the final capture.

**Relayer rotation drill order:** "Relayer rotation" above -- prepare (a second relayer key, its address, funding, the
admin's `set-operator-plan`), drain the old relayer's queue, drain every pool, capture, `awsDeploy relayer-rotation-gate
... --evidence <dir> --record <dir>/gate-relayer-rotation.json` (GATE OPEN), the admin's `set_operator(<new>)`, only then
the Terraform switch (`signing_keys.relayer`, `escrow`) that starts the pools, then steps 1-7 with `--scenario
relayer-rotation-drill --from-relayer <old> --to-relayer <new>` (both `relayer-rotation` and `relayer-rotation-proof`).

### The restore drill (LIVE-6 restore-drill tooling)

Every step's evidence lands in ONE evidence directory `<dir>` under ONE run id `R` and ONE restore id `X`, fixed before the
first mutation. Generation N = 1 → N+1 = 2 below. The image the pools run must be built from a commit that carries this
tooling (the probes run the image's own `runtimeMetrics` decision builders and `restoreFenceProbe.js`; an older image's
probe refuses itself: `image-predates-the-decision-metric-sets` / no entry).

```
# --- 0. prerequisites (Terraform, applied BEFORE the drill) -------------------------------------------------------------
#   recovery_trusted_principal_arns = [<operator principals>]   (gs-staging-recovery must exist)
#   recovery_break_glass            = true
# --- 1. stop, capture the stop (fixes R and X) -------------------------------------------------------------------------
infra/aws/scripts/drain-pool.sh staging us-east-1 <pool> <dir> R                     # every pool
infra/aws/scripts/capture-restore-stop.sh staging us-east-1 R X <dir> p1 p2            # its captured_at = the STOP TIME S
# --- 2. restore at/after S, prepare, adopt (APPGEN 1 -> 2 is IRREVERSIBLE) -------------------------------------------
aws dynamodb describe-continuous-backups --table-name gs-staging-game-g1 \
    --query ContinuousBackupsDescription.PointInTimeRecoveryDescription.LatestRestorableDateTime   # wait until >= S
aws dynamodb restore-table-to-point-in-time --source-table-name gs-staging-game-g1 \
    --target-table-name gs-staging-game-g2 --restore-date-time <S>                  # never before S; as the recovery role
node dist/server/src/aws/recovery/recoveryCli.js table-prepare --game-table gs-staging-game-g2 --generation 2 \
    --from-generation 1 --from-table gs-staging-game-g1 --restore-point <S in ms> --restore-id X --by R --region us-east-1 --apply
node dist/server/src/aws/recovery/recoveryCli.js appgen-adopt --ledger <ledger table ARN> --expected 1 --generation 2 \
    --game-table gs-staging-game-g2 --restore-id X --by R --region us-east-1 --apply --stopped           # within 6 h of S
node dist/server/src/tools/awsDeploy.js generation-gate ... --generation 2 --restore-id X --record <dir>/gate-generation.json
# --- 3. the switch: stacks/app game_generations = [1, 2], import g2, generation = 2, generation_adoption = <printed>;
#        terraform apply (g2 imported + protected: permanent; g1 retained); the pools start on generation 2.
#        THEN at once: recovery_break_glass = false; terraform apply.
# --- 4. the old generation, fenced (standalone probe tasks of a pool's running definition; nothing written or signed) ----
infra/aws/scripts/run-restore-fence-probe.sh ledger-kms staging us-east-1 R <dir> <pool> 1 2 X
infra/aws/scripts/run-restore-fence-probe.sh old-task   staging us-east-1 R <dir> <pool> 1 2 X
# --- 5. the restore alarms (alarm-pipeline injections) ----------------------------------------------------------------
infra/aws/scripts/run-restore-alarm-probe.sh hold-start staging us-east-1 R <dir> r3 <NON-primary pool> p1,p2 4500  # first: >= 1 h
node dist/server/src/tools/gamesDoctor.js aws suppression-overlap open p1 p2 --minutes 30 --note "restore drill R" \
    --record <dir>/restore-alarms/suppression-window.json --apply        # operator role; NOT a routing flip
infra/aws/scripts/run-restore-alarm-probe.sh inject  staging us-east-1 R <dir> r1 p1 p1,p2 overlap   # waits for both suppressors ALARM
infra/aws/scripts/run-restore-alarm-probe.sh observe staging us-east-1 R <dir> r1
infra/aws/scripts/run-restore-alarm-probe.sh inject  staging us-east-1 R <dir> a4g p1 p1,p2 ; ... observe ... a4g
infra/aws/scripts/run-restore-alarm-probe.sh inject  staging us-east-1 R <dir> a4i p1 p1,p2 ; ... observe ... a4i
infra/aws/scripts/run-restore-alarm-probe.sh inject  staging us-east-1 R <dir> r2  p1 p1,p2 ; ... observe ... r2
node dist/server/src/tools/gamesDoctor.js aws suppression-overlap close --record <dir>/restore-alarms/suppression-window.json --apply
infra/aws/scripts/run-restore-alarm-probe.sh observe staging us-east-1 R <dir> r3 5400      # R3 fires after its 60 periods
infra/aws/scripts/run-restore-alarm-probe.sh hold-stop staging us-east-1 R <dir>
node dist/server/src/tools/awsDeploy.js stage-probe restore-alarms record --run-id R --evidence <dir> --environment staging --pools p1,p2
# --- 6. certify (every probe task STOPPED; the overlap window + 5 min tail over) ---------------------------------------
#   steps 1-6 of the read-only order (capture, prerequisite, run-task-probe, edge, plans, capture again), then:
node dist/server/src/tools/awsDeploy.js stage-probe restore-fencing record --run-id R --evidence <dir> \
    --runtime-parameter <primary's ARN> --environment staging --primary-pool <primary> --generation 2
node dist/server/src/tools/awsDeploy.js stage-cert certify --run-id R --evidence <dir> ... --scenario restore-drill --game-generations 1,2 --commit <HEAD>
```

**The restore alarms are ALARM-PIPELINE INJECTIONS, never a reproduction of a destructive fault** (owner decision). Each is
one standalone `run-task` of a pool's running definition whose command is the drill's `node -e` program over the image's own
`runtimeMetrics`: it writes, through the production `createEmfSink`, exactly the metric set the runtime's own decision
writes (`taskLostMetrics("generation-moved")`, `startupRefusedMetrics("generation" | "identity-restore")`,
`moneyHeldJournalAheadMetrics()`, `restoreUnverifiedMetrics(1)` -- the same functions `awsRuntime.ts` emits through), with
GS_STORAGE a value start.ts refuses; no APPGEN, identity restore state, journal, game or escrow is touched. Their companion
alarms fire too, exactly as with the real decision: R1's record carries `TaskLost` (A1), A4g's / A4i's `StartupRefused`
(A4). R3 is held for a real hour and more (the contract's sixty periods are never shortened; back-dating datapoints is not
used -- CloudWatch documents no re-evaluation of past periods that could prove it) on a NON-primary pool (only a restored
table's primary emits `RestoreUnverifiedGames`; an injection never competes with a serving task's value). Every task is
bounded by itself (counters: one record, exit 0; R3: its hold, 3900-5400 s, or `hold-stop`): an interrupted operator
leaves nothing running indefinitely. `precheck` starts nothing unless the alarm is not ALARM (and, for `overlap`, the
overlap test's window is open with 5 minutes left and both suppressors are ALARM); `observe` polls (NOT YET) and refuses
what can no longer become true; `record` re-derives every case and judges the candidate before writing.

**The staging flip-suppression overlap test is NOT a routing flip** (owner decision: no second real flip). `gamesDoctor aws
suppression-overlap open <A> <B>` publishes, through L6-5B's `applySuppression` and the operator's `cloudWatchSuppression`,
exactly the `FlipWindowOpen` datapoints a real flip's window publishes for its two pools (at most 45 minutes, ahead, ending by
itself); SYSTEM/ROUTING is READ strongly at the open and the close and never written; `close` cancels the remaining minutes.
While it is open the two pools' suppressible alarms (A6/A11/A12/A12b/A13) act only through their suppressed composites --
that is the mechanism under test. The drill's overlap is proven only from CloudWatch: both suppressors ALARM in the
describe-alarms taken just before the injection, and each one's last state change at or before the injection (its
describe-alarm-history, read after it) to ALARM inside this test's window.

**The old-generation fencing probe** (`aws/runtime/restoreFenceProbe.ts`; no temporary serving pool, no old-generation
document: owner decision). Two standalone tasks of a pool's running (new-generation) definition, the command overridden to
the probe, GS_STORAGE refused; each refuses to run unless APPGEN shows exactly this adoption. `ledger-kms`: the ledger's own
generation term for generation 1 (`generationConditionCheck`, the one builder every ledger write uses) in a transaction whose
second item can never hold (nothing is ever written), against a control with generation 2's term; and the KMS gate
(`gatedKmsClient`) with the pool writer's generation probe, over a port that only counts (KMS is never reached). `old-task`:
the production `startAwsRuntime` configured for generation 1 behind a substrate that serves only the generation reads --
refused for the generation before the pool, exit 2, never ready. `stage-probe restore-fencing record` binds both answers to
ECS's record of each task, to APPGEN's adoption (read live through L6-4's readers) and to the restore-stop capture, takes
the new generation from the deployment's own evidence (the document serves the adopted table, L6-4's startup rule accepts
it, the primary's one task -- started after the adoption, on the definition that names the document -- is the target
group's healthy target), and judges with the unchanged `judgeRestoreFencing` before writing.

**Windows real-AWS staging requires AWS CLI v2 (`aws.exe`).** Use CLI v2 (`aws --version` must print `aws-cli/2.`).
LIVE-6 W1: no capture call is built to exceed `cmd.exe`'s 8191-character command line any more (the Windows test stub is an
`aws.cmd`, and so is a pip-installed CLI v1): the cluster listing (`capture-evidence`) and `capture-restore-stop` describe
at most 50 task ARNs per `describe-tasks` call (~4.2k characters; 100 were ~8.4k), and L6-2's per-pool view (its first 100
tasks, one whole answer) asks by task ID (~3.3k). Completeness is unchanged: every page, every ARN described exactly once,
any failed call fails the capture closed (no `capture.json`). The stub enforces the same line limit on every platform.

## Secrets

No secret exists today. The Juno REST endpoints are public URLs; **do not** put a provider API key in a URL, because it
would appear in the plan, the state and SSM. The first secret consumer (an RPC provider key) follows the L5-7 seam:

- a Secrets Manager secret, named by its **complete ARN** (with the 6-character suffix), is referenced from the runtime
  configuration as `secret_ref`;
- the application reads it itself with `secretsManagerSource` into a `SecretValue`, which never prints;
- **never** through ECS `secrets` (which injects values into the environment) and never in SSM;
- that slice adds `secretsmanager:GetSecretValue` on exactly that ARN (plus `kms:Decrypt` if it uses a customer-managed
  key), and a `secret_ref` field to the runtime document's parser. Both are application changes this slice does not make.

Terraform state holds only non-secret values: the documents, ARNs and names. KMS private keys never leave KMS.

## Tests (no AWS)

```
cd infra/aws/modules/ledger && terraform init -backend=false && terraform test        # 42 runs (ledger 41 + operator_evidence_policy 1; LIVE-6 relayer rotation: +6; COST-1 host role: +7; JX-1K financial key sets: +11; P5-INT-1: +2; JX-4C operator journal: +2; Phase 3 escrow 2.1 remedy key: +8)
cd infra/aws/modules/app    && terraform init -backend=false && terraform test        # 84 runs (app 59 + alarms 17 + compute_none 7 + operator_evidence_policy 1; Phase 3 escrow 2.1: remedy key +12, C1 +1; Terraform >= 1.11 for the test state keys)
cd infra/aws/stacks/app     && terraform init -backend=false && terraform validate    # (and stacks/ledger)
cd server && npm run build && node --test dist/server/src/aws/deploy/l5_8Deploy.test.js dist/server/src/aws/awsClients.test.js
node --test dist/server/src/aws/operator/l6_2Flip.test.js dist/server/src/persistence/conformance/l6_5bAlarms.test.js dist/server/src/aws/runtime/l6_5aObservability.test.js
GS_DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 node --test dist/server/src/persistence/conformance/awsBootstrap.dynamoLocal.test.js dist/server/src/persistence/conformance/l6_2Flip.dynamoLocal.test.js
# LIVE-6 relayer rotation: the proof, the v2 gate, set-operator-plan (offline); the bound readers over real items
node --test dist/server/src/aws/deploy/staging/rotationProof.test.js dist/server/src/aws/deploy/staging/l6_6StagingCert.test.js
GS_DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 node --test dist/server/src/persistence/conformance/l6FinalConvergence.dynamoLocal.test.js
# LIVE-6 restore-drill tooling: the restore alarms, the suppression-overlap test, the old-generation fencing probe, the flip
# alarm drill (offline; the scripts against a stub AWS CLI where bash / PowerShell exist)
node --test dist/server/src/aws/deploy/staging/restoreAlarmDrill.test.js dist/server/src/aws/deploy/staging/restoreFencing.test.js dist/server/src/aws/runtime/restoreFenceProbe.test.js dist/server/src/aws/operator/suppressionOverlap.test.js dist/server/src/persistence/conformance/l6RestoreDrill.test.js dist/server/src/aws/deploy/staging/flipAlarmDrill.test.js
# COST-1 / COST-2A: the single host -- the module (28 runs; Phase 3 escrow 2.1 remedy key +5), its scripts, the host verifier (and its capture scripts
# against a stub AWS CLI where bash / PowerShell exist). The host scripts need a Linux userspace (flock, python3): on
# Windows the owner gate (run-cost2c-owner-gate.ps1) runs them in a pinned Amazon Linux 2023 container, never Git Bash.
cd infra/aws/modules/single-host && terraform init -backend=false && terraform test && bash tests/host-scripts.test.sh
node --test dist/server/src/aws/deploy/cost1SingleHost.test.js dist/server/src/aws/deploy/cost2aHostVerifier.test.js
```

## Owner prerequisites and staging-gate items (not verifiable without AWS)

- **AWS Backup "advanced DynamoDB features"** must be enabled in the ledger account and region. They are on by default
  for accounts that began using AWS Backup after November 2021. Without them, `copy_action` and vault-key encryption do
  not apply to DynamoDB. This stack does not manage the account-wide `aws_backup_region_settings`.
- An **ACM certificate for the ALB** covering `edge.alb_origin_domain_name`, and one in us-east-1 for the distribution's
  aliases. There must also be a DNS name for the ALB origin.
- The existing VPC's **NAT** on the task subnets (the Juno REST endpoints).
- **Staging observations** (LIVE-6 L6-6 turns each into a certification gate: "Staging certification" above):
  - drain, then apply, puts the new task's pool takeover after the old task's exit 0;
  - the `LeadingKeys` exclusions hold inside transactions;
  - `GS_TRUSTED_PROXY_HOPS=2` matches a header capture;
  - `cp`, `cr` and `cb` arrive unchanged through CloudFront;
  - the ALB, CloudFront (`origin_read_timeout` 60 s) and the server keep idle WebSockets open;
  - KMS latency stays under the 3 s bound.
- **Low / Info (accepted):**
  - the bootstrap role also serves the verifier. IAM cannot limit PutItem to create-if-absent, so restrict who may
    assume it (a separate read-only verify role is a small follow-up);
  - the CloudFront origin-facing prefix list admits every AWS customer's distribution. The server's own authentication
    does not depend on the edge, and the right-anchored proxy hops stay correct;
  - a missing routing item may make the plan fail on the data source before the friendlier precondition message is
    shown. Either way nothing starts.
