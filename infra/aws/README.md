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
  scripts/               capture-evidence.{sh,ps1} (read-only), drain-pool.{sh,ps1} (the no-overlap rollout)
infra/docker/game-server.Dockerfile   the task's image (built from the repository root)
server/src/aws/deploy/ + tools/awsDeploy.ts   `npm run awsDeploy -- bootstrap | verify | signer-keys`
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
| `gs-<env>-game-g<N>` | No TTL. `SYSTEM/ROUTING` comes from the bootstrap. `POOL#`, `ROLE#` and games come from the tasks. |
| `gs-<env>-identity` | TTL on the attribute **`ttl`**. |
| `gs-<env>-ledger` | No TTL. `APPGEN` comes from the bootstrap. Resource policy for the task role: GetItem, Query, ConditionCheckItem, and PutItem on any key except `APPGEN`. It gets no Update, Delete or Scan. |
| **Ledger backup** | AWS Backup daily into `gs-<env>-ledger` (vault lock, governance by default; compliance mode is an owner decision). The vault policy denies DeleteRecoveryPoint and UpdateRecoveryPointLifecycle. The selection is the ledger only, and the backup role cannot restore. Optional copy to another vault. |
| **KMS** (relayer, settlement, admission) | `ECC_SECG_P256K1` / `SIGN_VERIFY`, single-region, no rotation (a new key is a new chain identity), `prevent_destroy`. The key policy lets the task role GetPublicKey, and Sign only with `ECDSA_SHA_256` over a `DIGEST`. The bootstrap role may DescribeKey, GetPublicKey and ListGrants. The key's own account administers it but gets neither `kms:Sign` nor `kms:CreateGrant`. |
| **SSM** | `/gs/<env>/runtime/<pool>` (`18COSMOS/AWS-RUNTIME/v1`) and `/gs/<env>/juno-backend` (`18COSMOS/JUNO-BACKEND/v3`: `journal` is the same ledger ARN, the signers are the three key ARNs). Both are `String`, never `SecureString`, hold no secret, and are written with `insecure_value` so every change shows in the plan. |
| **Secrets Manager** | **Nothing.** No secret has a consumer yet, so no secret is created and no role has `secretsmanager:*`. See "Secrets" below. |
| **ECS** | One Fargate service per pool (desired count 0 or 1) in awsvpc private subnets with no public IP. Stop-first (0 / 100), AZ rebalancing off, circuit breaker with rollback, no ECS Exec. `stopTimeout` 120. Container health: `node -e` GET `/gs/healthz`, `startPeriod` 300. awslogs to `/gs/<env>/<pool>`. Read-only root filesystem; the image runs as the `node` user. |
| **Task environment** | Exactly `GS_MODE=production`, `GS_STORAGE=aws`, `GS_AWS_CONFIG_PARAMETER=<this pool's runtime ARN>`, `BUILD_ID=<image tag>`, `PORT`, `GS_ALLOWED_ORIGINS`, `GS_TRUSTED_PROXY_HOPS=2`, and `ESCROW_MONEY_TABLES=nonmainnet` only if `money_tables_nonmainnet` is set (non-mainnet only). Never `DATA_DIR`, `ESCROW_JUNO_CONFIG`, static AWS keys, `secrets` or `environmentFiles`. |
| **ALB** | Internet-facing, HTTPS 443 only (TLS 1.3/1.2 policy), `drop_invalid_header_fields`. Idle timeout 300 s (validated >= 120). Listener rule `/gs*` goes to target group `gs-<env>-primary`, whose health is `/gs/readyz` with matcher `200` and deregistration delay 15 s. Every other path returns 404. |
| **CloudFront** | Origin request policy for `/gs*`: query strings `all`, cookies `all`, headers `Origin` plus `Sec-WebSocket-Key`, `-Version`, `-Protocol`, `-Accept` and `-Extensions`. Cache policy Managed-CachingDisabled; all seven methods; https-only both ways. The distribution itself is optional (`edge.create_distribution`); otherwise attach the output policy id to your own distribution's `/gs*` behaviour. |
| **Network** | Task SG: the container port from the ALB SG only; egress TCP 443 (plus any `juno_egress_ports`). ALB SG: 443 from CloudFront's origin-facing prefix list only. Gateway endpoints for DynamoDB and S3, and interface endpoints for KMS, SSM, Logs, ECR API and ECR DKR. |
| **ECR** | `gs-<env>-server`, immutable tags (a `BUILD_ID` names exactly one image), scan on push. |

**Remaining public egress:** the Juno REST endpoints (through the existing VPC's NAT), plus any AWS API in another region
(for example a ledger or KMS keys outside the app region), because a VPC endpoint serves only its own region. With
`create_interface_endpoints = false`, AWS APIs also leave through the NAT to the regions' public endpoints. The SDK clients
pin those endpoints (`awsClients.ts`).

## IAM: three roles, three authorities

| Role | Authority |
|---|---|
| `gs-<env>-app-execution` | Used by ECS: `ecr:GetAuthorizationToken` (AWS cannot scope it), pulls from this repository only, and writes this service's log streams only. |
| `gs-<env>-app-task` | Used by the application, and the only credential source a task has. Game table: GetItem, Query, Scan, ConditionCheckItem; Put, Update and Delete on any partition except `SYSTEM`. Identity table: GetItem, Scan, ConditionCheckItem, Put, Update, Delete. Ledger: GetItem, Query, ConditionCheckItem, and PutItem except `APPGEN`. KMS GetPublicKey, plus Sign with ECDSA_SHA_256 over a DIGEST. `ssm:GetParameter` on the two documents. No `*` resource. |
| `gs-<env>-bootstrap` | Used by the pipeline or an operator. PutItem and GetItem **only** on `SYSTEM/*` of the game table and `APPGEN` of the ledger (`dynamodb:LeadingKeys`). Describe on the three tables, GetParameter on the documents, and KMS DescribeKey, GetPublicKey and ListGrants. Read-only describes for the verifier: `ecs:DescribeTaskDefinition`, `elasticloadbalancing:Describe*` and `ec2:DescribeSecurityGroups*` (all `*`, because AWS cannot scope them), `ecs:DescribeServices` on this cluster, and CloudFront GetDistributionConfig and GetOriginRequestPolicy. It has no Sign, no Update, no Delete and no Scan. |

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

## The bootstrap (APPGEN + SYSTEM/ROUTING): `npm run awsDeploy -- bootstrap`

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

## Verification: `npm run awsDeploy -- verify` (read-only)

- **`--part app`** (the default; app-account credentials, e.g. the bootstrap role) checks:
  - both documents, through the task's own `loadAwsStartup`, and every pool's document, against the naming contract;
  - the game and identity tables in full: keys, billing, indexes, replicas, deletion protection, PITR, and TTL (`ttl` on
    identity only);
  - the ledger's DescribeTable (cross-account);
  - that APPGEN holds the generation and SYSTEM/ROUTING names the primary;
  - the KMS keys: Enabled, customer-managed, single-region, ECC_SECG_P256K1 / SIGN_VERIFY / ECDSA_SHA_256, **no grants**,
    and public keys equal to the configuration's (the backend's own `checkSignerIdentities`);
  - with `--evidence <dir>`, the control plane:
    - each task definition is **the revision the service runs**, with references only, stopTimeout 120, `/gs/healthz`,
      awslogs and awsvpc;
    - services are stop-first, one task each, AZ rebalancing off, circuit breaker on, no ECS Exec, no public IP, and
      only the primary behind the ALB;
    - the target group checks `/gs/readyz` for 200 and is the primary service's;
    - the listener rule sends `/gs*` to that target group, and the ALB idle timeout is at least 120 s;
    - CloudFront's `/gs*` behaviour is the **first** to match `/gs` paths, uncached, with **all** query strings, cookies,
      Origin and WebSocket headers;
    - the task SG admits the ALB SG only, and the ALB SG admits a prefix list only.
- **`--part ledger`** (ledger-account credentials) checks the ledger's PITR and TTL (which are not readable across
  accounts) and APPGEN.
- **`--part all`** runs both halves, for the single-account form.
- A missing evidence file fails the run. Omitting evidence must be explicit (`--no-evidence`) and is reported as SKIP.

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

**Replacement scenario:** `drain-pool.sh <env> <region> <pool> <dir> R`, then `terraform apply`, then steps 1-7 with
`--scenario replacement --replaced-pools <pool>` (the drain precedes the prerequisite, which examines the new deployment).
**Restore drill** (L6-4): stop every pool, `capture-restore-stop.sh <env> <region> R <restore id> <dir> <pools...>` (every
pool's service at zero; every task the cluster lists, desired RUNNING and desired STOPPED, STOPPED), prepare and adopt
(`npm run recovery -- ... --restore-id <the same restore id>`, within 6 h of the capture), switch the runtime document,
start, then steps 1-7 with `--scenario restore-drill`; the fencing probe's record (`probe-restore-fencing.json`, bound to
the adoption, one structured result per case -- `recovery.ts`) is a later real-staging slice's.

**The gates** (a gate passes only with at least one check and every check passed; missing evidence and verifier SKIPs are
failures): prerequisite (settled, the examined revision running, nothing beside the services, target health, unchanged since
step 2), drain (replacement), IAM / LeadingKeys inside transactions as the task role, real transaction semantics
(conditions, TransactionConflict, same-token resend), proxy hops (exactly two appended X-Forwarded-For entries), ALL query
strings (`cp`, `cr`, `cb` and unrelated ones, through the diagnostic `/gs/diag/edge`, mounted only by
`edge_diagnostic_staging` / `GS_EDGE_DIAGNOSTIC=staging`, refused on mainnet and in `prod*`), the WebSocket announcement and
idle path (longer than every idle bound plus two server pings), KMS Sign latency below 3 s with the configured keys (a
disposable digest; no chain, no ledger), both Terraform plans (nothing destroyed, replaced or de-protected except
skip_destroy task-definition revisions; services gated on the routing read), and the evidence package (no secret; the commit
is the checkout's HEAD). **L6-4 contract:** `SYSTEM/GENERATION` strict and bound by APPGEN's adoption (never the number
alone), the identity table serving-safe with its `TABLE#identity` binding, no open `REVIEW#`, L6-4 in the image of EVERY pool's automatic rollback target -- the circuit breaker's
target is the service's most recent COMPLETED deployment (in a settled service, the running one), never "any ACTIVE
revision" -- attested by image (the task definition's reference and the digest ECS ran), from this run's certifier task or an
earlier PASSing certification of the same environment copied into `prior-certifications/` (L6-6R) -- so EVERY pool runs
at least one task during a certification (a pool at desired 0 shows ECS no digest, and its task definition names a tag,
which is not evidence of content: its rollback target FAILS unless pinned `@sha256:`) -- and for a restore drill the stop
before `adopted_at` and the fencing slot. Until the integration binds L6-4's readers, those gates
FAIL "not integrated".

The first line of `CERTIFICATION.txt` (and of the command's output) is `LIVE-6 AWS STAGING CERTIFICATION: PASS` or `FAIL`,
then every failed gate. `certification.json` and `MANIFEST.json` (SHA-256 of every file) sit beside it.

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
cd infra/aws/modules/app    && terraform init -backend=false && terraform test        # 20 runs
cd infra/aws/stacks/app     && terraform init -backend=false && terraform validate    # (and stacks/ledger)
cd server && npm run build && node --test dist/server/src/aws/deploy/l5_8Deploy.test.js dist/server/src/aws/awsClients.test.js
GS_DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 node --test dist/server/src/persistence/conformance/awsBootstrap.dynamoLocal.test.js
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
