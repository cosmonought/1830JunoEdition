# infra/aws — the AWS infrastructure and deployment of the hosted game server (LIVE-5 L5-8)

This directory turns the L5-7 runtime contract (`claude/LIVE5_L5_7_AWS_RUNTIME_CONVERGENCE_2026-09-30.md` §14, and
`server/src/aws/README.md` §8) into reproducible infrastructure. **It changes no application semantics**: every rule here
restates what the runtime already requires.

**What exists is DEFINED and TESTED, not DEPLOYED.** No AWS resource was created by L5-8. The first real deployment
belongs to the LIVE-6 staging gate.

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
  fixtures/              the exact documents the app module renders for its test inputs, which the server's parsers also check
  scripts/               capture-evidence.{sh,ps1} (read-only; per pool: target group health, stopped/running tasks, ACTIVE
                         revisions, and a manifest), drain-pool.{sh,ps1} (the no-overlap rollout)
infra/docker/game-server.Dockerfile   the task's image (built from the repository root)
server/src/aws/deploy/ + tools/awsDeploy.ts   `npm run awsDeploy -- bootstrap | verify | generation-gate | signer-keys`
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
| `gs-<env>-game-g<N>` | No TTL. `SYSTEM/ROUTING` and the first table's `SYSTEM/GENERATION` come from the bootstrap (a restored table's marker from L6-4's preparation). `POOL#`, `ROLE#` and games come from the tasks. One resource per managed generation (`game_generations`, side by side; the L5-8 table is `moved` to key `"1"`, never replaced). |
| `gs-<env>-identity` | TTL on the attribute **`ttl`**. |
| `gs-<env>-ledger` | No TTL. `APPGEN` comes from the bootstrap. Resource policy for the task role: GetItem, Query, ConditionCheckItem, and PutItem on any key except `APPGEN`. It gets no Update, Delete or Scan. |
| **Ledger backup** | AWS Backup daily into `gs-<env>-ledger` (vault lock, governance by default; compliance mode is an owner decision). The vault policy denies DeleteRecoveryPoint and UpdateRecoveryPointLifecycle. The selection is the ledger only, and the backup role cannot restore. Optional copy to another vault. |
| **KMS** (relayer, settlement, admission) | `ECC_SECG_P256K1` / `SIGN_VERIFY`, single-region, no rotation (a new key is a new chain identity), `prevent_destroy`. The key policy lets the task role GetPublicKey, and Sign only with `ECDSA_SHA_256` over a `DIGEST`. The bootstrap role may DescribeKey, GetPublicKey and ListGrants. The key's own account administers it but gets neither `kms:Sign` nor `kms:CreateGrant`. |
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
| `gs-<env>-operator` (L6-2; only with `operator_trusted_principal_arns`) | `gamesDoctor aws`: game table GetItem/Query/Scan; PutItem on `SYSTEM/*` and `OPRUN#*` (the routing CAS, the run's evidence) and UpdateItem on `GAME#*` / `POOL#op:*` (an operator run's claim / take / release) -- never another `POOL#`; identity-writer role GetItem; ledger GetItem + Scan (read-only); GetParameter on the documents. No KMS, no identity write, no APPGEN. |
| `gs-<env>-recovery` (L6-2 for L6-4; only with `recovery_trusted_principal_arns`) | `npm run recovery`: APPGEN adoption and its `APPGEN#HISTORY` append (ledger), the restored table's `SYSTEM/GENERATION`, the identity replay's tables. `RestoreTableToPointInTime` only with `recovery_break_glass`. Serving tasks never hold any of it. |
| `gs-<env>-bootstrap` | Used by the pipeline or an operator. PutItem and GetItem **only** on `SYSTEM/*` of the game table and `APPGEN` of the ledger (`dynamodb:LeadingKeys`). Describe on the three tables, GetParameter on the documents, and KMS DescribeKey, GetPublicKey and ListGrants. Read-only describes for the verifier: `ecs:DescribeTaskDefinition`, `elasticloadbalancing:Describe*` and `ec2:DescribeSecurityGroups*` (all `*`, because AWS cannot scope them), `ecs:DescribeServices` on this cluster, and CloudFront GetDistributionConfig and GetOriginRequestPolicy; since L6-2 also GetItem on `SYSTEM/GENERATION` and `APPGEN#HISTORY`, ListTasks/DescribeTasks on this cluster, ListTaskDefinitions and DescribeTargetHealth. It has no Sign, no Update, no Delete and no Scan. |

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
  bound) **before** the CAS.
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
- The Terraform `primary` flag changes **only** the `/gs*` rule's target group; the plan refuses it until the routing names
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

## Relayer-address rotation (deployment invariant; L6-7's `RELAYQ#`)

`RELAYQ#<relayer-address>` in the game table is the relayer's **authoritative work discovery** (L6-7). A relayer under a
new address never reads the old partition, and there is **no automatic queue migration** (owner decision, this LIVE
cycle). So **a configuration change that changes the relayer address is refused while the old address's queue holds any
entry.** The only supported procedure:

1. Keep the old relayer configuration active; watch it drain its queue to zero (`relayer.status()`, the AUDIT lines).
2. `drain-pool` every pool (desired = running = pending = 0): no task can add to the old queue any more.
3. `capture-evidence`, then `npm run awsDeploy -- relayer-rotation-gate --runtime-parameter <ARN> --environment <env>
   --from-relayer <old> --to-relayer <new> --evidence <dir>` (read-only; bootstrap role). **GATE OPEN** only when the
   active configuration still names the old address, every pool is drained (fresh evidence), and `RELAYQ#<old>` read
   **completely** (strongly consistent, every page) holds **no entry of any shape**. An unreadable or unknown queue
   refuses; the new address's queue is never consulted.
4. Only then change the relayer address/configuration (`escrow` in `stacks/app`) and start the pools (drain-first); the
   primary's task takes the new address's relayer role at its start.

If the gate is closed with entries, restart the pools on the **old** configuration and go back to step 1.

## Generation switch after a restore (L6-4 §12.1, wired by L6-2)

Strictly in this order; Terraform/SSM never race ahead of the adoption:

1. Stop every pool (drain-first). Restore `gs-<env>-game-g<N+1>` with `RestoreTableToPointInTime` (the recovery role with
   `recovery_break_glass = true`), outside Terraform.
2. `npm run recovery -- table-prepare ...` then `appgen-adopt ... --apply` → `committed` / `already-adopted` for exactly
   (N+1, that table, that restore id).
3. `npm run awsDeploy -- generation-gate --runtime-parameter <ARN> --environment <env> --generation N+1 --restore-id <id>`
   (read-only) → `GATE OPEN` and the `generation_adoption = {...}` line.
4. In `stacks/app`: add N+1 to `game_generations` (keep N), an `import` block for the new table, `generation = N+1`,
   `generation_adoption = {...}`. The plan refuses services unless the new table's marker equals that attestation; the
   module re-enables PITR and deletion protection on the import.
5. Start the services; the tasks re-check APPGEN, the marker and the adoption binding themselves. Money games of a restored
   table are **read-only** until each one's history (F1) and chain facts are verified in that process (never stored:
   every restart verifies again). `gamesDoctor aws orphans` lists ledger reservations/attempts the restored table does not
   account for (read-only; chain games are reported NOT COVERED).

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
    identity only);
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
    - the task SG admits the ALB SG only, and the ALB SG admits a prefix list only.
- **`--part ledger`** (ledger-account credentials) checks the ledger's PITR and TTL (which are not readable across
  accounts) and APPGEN.
- **`--part all`** runs both halves, for the single-account form.
- A missing evidence file fails the run. Omitting evidence must be explicit (`--no-evidence`) and is reported as SKIP.

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
cd infra/aws/modules/ledger && terraform init -backend=false && terraform test        # 6 runs
cd infra/aws/modules/app    && terraform init -backend=false && terraform test        # 32 runs
cd infra/aws/stacks/app     && terraform init -backend=false && terraform validate    # (and stacks/ledger)
cd server && npm run build && node --test dist/server/src/aws/deploy/l5_8Deploy.test.js dist/server/src/aws/awsClients.test.js
node --test dist/server/src/aws/operator/l6_2Flip.test.js
GS_DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 node --test dist/server/src/persistence/conformance/awsBootstrap.dynamoLocal.test.js dist/server/src/persistence/conformance/l6_2Flip.dynamoLocal.test.js
```

## Owner prerequisites and staging-gate items (not verifiable without AWS)

- **AWS Backup "advanced DynamoDB features"** must be enabled in the ledger account and region. They are on by default
  for accounts that began using AWS Backup after November 2021. Without them, `copy_action` and vault-key encryption do
  not apply to DynamoDB. This stack does not manage the account-wide `aws_backup_region_settings`.
- An **ACM certificate for the ALB** covering `edge.alb_origin_domain_name`, and one in us-east-1 for the distribution's
  aliases. There must also be a DNS name for the ALB origin.
- The existing VPC's **NAT** on the task subnets (the Juno REST endpoints).
- **Staging observations:**
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
