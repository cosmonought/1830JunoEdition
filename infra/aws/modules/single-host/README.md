# The single-host deployment (COST-1)

**The decision and the budget:** `docs/hosting-budget.md` and `infra/aws/COST_BUDGET.json`.

**The migration from ECS:** `infra/aws/SINGLE_HOST_MIGRATION.md`.

**What it is:** one EC2 host runs the **same AWS-mode game server** the ECS task ran. It serves the **existing** authorities: the DynamoDB game, identity and ledger tables, the KMS keys, the SSM documents, ECR and the CloudFront distribution. Nothing here creates or duplicates them.

Contents:
1. [Runtime](#1-runtime-one-host-systemd-managed-docker)
2. [Origin, TLS, CloudFront](#2-origin-tls-and-cloudfront)
3. [Network](#3-network)
4. [IAM](#4-iam-the-hosts-one-role)
5. [DynamoDB and generation semantics](#5-dynamodb-and-generation-semantics-what-stays)
6. [Fencing on one host](#6-fencing-and-ownership-on-one-host)
7. [Deploy and rollback](#7-deploy-rollback-stop-health)
8. [Image storage](#8-image-storage-ecr-kept)
9. [Observability](#9-observability-the-reduced-tier)
10. [Memory measurement plan](#10-memory-measurement-plan)
11. [ARM64](#11-arm64--graviton)
12. [Tests](#12-tests)

---

## 1. Runtime: one host, systemd-managed Docker

**The choice:** systemd runs **one Docker container per service**: `gs-server` (the game server) and `gs-caddy` (the TLS origin).
- **Not Docker Compose:** it would be one more daemon-less layer between systemd and the exit codes the fences rely on.
- **Not direct Node under systemd:** that would give up the certified, digest-pinned image, the read-only root and the ECS parity.

This is the simplest shape that keeps:
- a deterministic artifact (an image by **digest**);
- restart on failure;
- clean SIGTERM;
- log capture;
- one-command rollback.

| Unit | What it does |
|---|---|
| `gs-imds-guard.service` (oneshot) | iptables rejects Caddy's uid (2001) traffic to IMDS. |
| `gs-caddy.service` | `caddy run` with host networking, uid 2001, only `NET_BIND_SERVICE` (the binary's file capability), read-only root. **Requires** the IMDS guard. |
| `gs-server.service` | `ExecStartPre=gs-preflight`, `ExecStart=gs-run`, `ExecStop=docker stop --time 120`. |
| `gs-host-sample.timer` | Every 60 s: one host sample, plus a HostPressure datapoint only under pressure. |

**Boot order:**
1. `network-online` → `docker` → `gs-imds-guard` → `gs-caddy`.
2. In parallel, `gs-server`. It starts **only** if `/etc/gs/release.env` exists (written by the first deploy) **and** `gs-preflight` passes.

**gs-preflight refuses (fail closed) unless:**
- the release image is pinned by digest, present, and of this host's architecture;
- `/etc/gs/*` holds no AWS credential, `DATA_DIR` or `ESCROW_JUNO_CONFIG`, and the server env says `GS_STORAGE=aws` and `GS_MODE=production`;
- **this host holds the serving Elastic IP** (IMDSv2 `public-ipv4` = the expected address), so a stale or stray host never starts and never takes the pool back;
- no other `gs-server` container is running.

**gs-run** runs the image:
- `--read-only --user node --cap-drop ALL --security-opt no-new-privileges --init --pids-limit 512 --memory <limit>`;
- published on **127.0.0.1:8917 only**;
- `--env-file /etc/gs/server.env`, which holds references only: `GS_MODE=production`, `GS_STORAGE=aws`, the runtime document's SSM ARN, origins, `GS_TRUSTED_PROXY_HOPS=2`, `GS_METRICS_PROFILE=single-host`;
- logs to the host log group with the awslogs driver in **non-blocking** mode. A logging outage never stalls money processing; money truth is in DynamoDB and on chain.

**Restart policy:**
- `Restart=on-failure`, at most 5 starts in 15 min.
- **Never after exit 3** (a proven loss: another process or host took the pool or a role, or APPGEN moved) **or exit 5** (a routing role change). Restarting would take the pool back from the newer owner.
- **The HOLD:** `ExecStopPost=gs-exit-hold` writes `/var/lib/gs/hold`, and `gs-preflight` refuses while it exists, so the hold survives a **reboot** too. Only an explicit `gs-deploy` or `gs-rollback` clears it. The health alarm pages meanwhile.
- Exit 2 (refused configuration) and exit 4 (a store restart request) are retried within the limit.

**Graceful shutdown:** `docker stop --time 120` sends SIGTERM. The runtime's ordered shutdown (readiness 503 first, bounded drains, the identity writer and the pool writer last) exits 0. SIGKILL comes only after 120 s, which is ECS's `stopTimeout`, kept.

**Configuration reload:** there is none at runtime, by design.
- The runtime and Juno documents are read **at startup** (L5-7).
- A changed document takes effect on the next deploy or restart: `gs-deploy` with the same digest after `gs-stop`, or `systemctl restart gs-server`.
- Changes to host files (cloud-init) replace the host (`user_data_replace_on_change`).

**Logs:**

| What | Where |
|---|---|
| Server stdout (the AUDIT and metric lines) | CloudWatch `/gs/<env>/host`, stream `gs-server/<build>`, 90 days. Docker keeps a local dual-logging cache: `docker logs gs-server`. |
| Caddy | `docker logs gs-caddy` (json-file, 3 × 10 MB) |
| Units | `journalctl -u gs-server -u gs-caddy` |
| Host samples | `/var/log/gs-measure/host-YYYYMMDD.jsonl` (30 days) |

## 2. Origin, TLS and CloudFront

```
CloudFront (existing; /gs* behaviour unchanged) --https--> <origin hostname>:443 Caddy --http--> 127.0.0.1:8917 game server
```

**Origin TLS.** ACM cannot terminate on EC2, and CloudFront verifies the origin certificate against the origin hostname. So Caddy obtains a **Let's Encrypt** certificate for `origin_hostname`:
- The A record must point at the Elastic IP. That is an owner DNS action at migration.
- **HTTP-01 on port 80 only.** Port 443 admits CloudFront's origin-facing servers only, so TLS-ALPN-01 could never be reached and is disabled.
- Port 80 serves the ACME challenge and `404`. It never redirects or proxies.
- No ACME e-mail is sent unless `acme_email` is set; none is ever invented.

**Proxy behaviour** (proved by `tests/edge-smoke.sh` with the real Caddy image):
- `/gs` and `/gs/*` only; everything else is `404`.
- No path rewriting.
- Query strings (`cp`, `cr`, `cb`, encoded, repeated), cookies, `Origin` and the WebSocket upgrade pass through unchanged.
- **X-Forwarded-For is appended:** `client, cloudfront`. That is the same two hops the ALB produced, so `GS_TRUSTED_PROXY_HOPS=2` is unchanged. Caddy trusts the incoming header because the security group admits only CloudFront on 443. Caddy's default would *replace* it.
- **Health:** `health_uri /gs/readyz` (the ALB target group's check). While the server is not ready, Caddy answers 503: during deploys, startups and losses.

**CloudFront:** the existing distribution and its `/gs*` origin request policy (`modules/app/edge.tf`) are reused. Only the `/gs*` origin's domain name changes, to `origin_hostname` (`stacks/app` `edge.alb_origin_domain_name`). `play.<domain>` and the default (site) behaviour are unchanged.

## 3. Network

- One public subnet of the existing VPC, **one ENI**, **one Elastic IP** on that ENI.
- The instance is launched on the ENI, so it has its public address from the first boot. A replacement gets the same address only after the old instance is destroyed: an ENI is one instance's primary interface at a time.
- No NAT and no VPC endpoints: AWS APIs are reached over their public regional HTTPS endpoints.

**Security group:**

| Direction | Port | From / to | Why |
|---|---|---|---|
| in | 443 | CloudFront origin-facing prefix list | the origin |
| in | 80 | 0.0.0.0/0 | Let's Encrypt HTTP-01 only |
| in | 22 | only `emergency_ssh_cidrs` (≤ 2 × /32; default none) | emergency EC2 Instance Connect |
| out | 443 (+ Juno REST ports) | 0.0.0.0/0 | AWS APIs, Juno, ACME, packages |

- **8917 is never exposed:** it is published on 127.0.0.1 only, and no rule exists for it.
- **Operator access** is SSM Session Manager / Run Command over the public SSM endpoints. They are free on EC2 and need no interface endpoint. There is no SSH key at all.

**Emergency SSH:** set `emergency_ssh_cidrs = ["<your ip>/32"]`, apply, connect with EC2 Instance Connect (`aws ec2-instance-connect ssh --instance-id ...`), then remove it and apply again.

## 4. IAM: the host's one role

`gs-<env>-host-app` is assumed **only by EC2 in this account** (`aws:SourceAccount`) through the instance profile. Credentials come from **IMDSv2** (`http_tokens = required`, hop limit 2 so the container can reach them). They are short-lived and rotated by AWS. **No static key, no credential in user data or any env file.** The tests and the preflight check this.

The policy is the ECS task role's, statement for statement, narrowed to **one pool's** runtime document:

| Statement | Grant |
|---|---|
| Game table | read and condition-check; write everything **but SYSTEM/** |
| Identity table | the identity writer's reads and writes |
| Ledger (cross-account) | read and condition-check; append **but APPGEN, APPGEN#HISTORY** |
| SSM | `GetParameter` on this pool's runtime document (+ the Juno document) |
| KMS | `GetPublicKey`; `Sign` with `ECDSA_SHA_256` over a `DIGEST` only, on exactly the configured keys |

Plus what ECS's execution role or the platform did:
- ECR pull from the one repository (`GetAuthorizationToken` is unscopable);
- Logs into the one host log group;
- `PutMetricData` only in `18Cosmos/Host`;
- the SSM agent's minimum (`UpdateInstanceInformation` on this account's instances, plus the unscopable message channels). This is **not** `AmazonSSMManagedInstanceCore`, which grants `ssm:GetParameter(s)` on every parameter.

**Never granted:**
- deploy, bootstrap, operator or recovery powers (`SYSTEM/*`, APPGEN, `RestoreTableToPointInTime`);
- table, key or policy administration;
- `kms:CreateGrant`, `iam:*`, `sts:AssumeRole`, Secrets Manager.

**The other half:** the ledger table's resource policy and the KMS key policies live in the ledger account. They authorise this role through `stacks/ledger` `app_runtime_role_arns` (exactly the task role's grants). Without that, every ledger read and every Sign is refused: fail closed.

**Residual exposure vs Fargate:** any root process on the host can read the role's credentials, as any process in the task could. Mitigations:
- Caddy is blocked from IMDS by uid;
- there is no SSH;
- KMS still signs only digests with the configured algorithm.

**Other exposures, accepted and documented:**
- **SSM Run Command is root on the host.** An operator principal allowed `ssm:SendCommand` with `AWS-RunShellScript` on this instance holds the role's authority, including Sign. Grant that permission only to the owner's operator principal. A follow-up may add a custom SSM document allowing only the fixed `gs-*` commands, with IAM bound to it.
- **The container also holds the host's SSM-agent and log grants.** It reaches IMDS (hop limit 2), so it holds the agent's message channels and `PutLogEvents` on the host group; through EMF, `PutLogEvents` could create metrics in any namespace. This is accepted because the container already holds Sign, which is the larger authority.

## 5. DynamoDB and generation semantics: what stays

The first migration uses the **existing data model unchanged**.

| Mechanism | Single host | Note |
|---|---|---|
| APPGEN (ledger) | **KEEP AS-IS** | Checked at every startup and inside every journal write. The app role can never write it. |
| SYSTEM/GENERATION (game table marker) | **KEEP AS-IS** | Startup refuses a table not prepared as this generation. |
| Generation adoption (`appgen-adopt`, recovery role) | **KEEP AS-IS** | The "stopped" precondition is `gs-stop --until-deploy` instead of `drain-pool`. |
| PITR-restored g<N+1> tables | **KEEP; procedure SIMPLIFIED** | `stacks/app` still imports, protects and documents the table. `stacks/single-host` adds the generation to `game_generations` (the role reaches it) before the host restarts onto it. |
| Generation gate (`awsDeploy generation-gate`) | **KEEP AS-IS** | `stacks/app` still consumes the attestation. |
| Recovery role (break-glass) | **KEEP AS-IS** | Never the host's role. |
| Restore fence (`restoreFenceProbe`, post-restore safe mode) | **KEEP; SIMPLIFIED** | The probe runs as a one-off `docker run` of the same image on the host instead of a standalone ECS task. Its task-ARN field is null off ECS, which is harmless. |
| Pool fencing (`POOL#p1`) | **KEEP AS-IS** | See §6. |
| Identity-writer fencing (`ROLE#identity-writer`) | **KEEP AS-IS** | |
| Relayer fencing (ledger `FENCE#relayer#…` + the `ROLE#relayer#…` mirror) | **KEEP AS-IS** | |
| Task heartbeat (`TASK#`, TTL) | **KEEP AS-IS** | Diagnostic, about $0.05 a month. |
| Routing record (`SYSTEM/ROUTING`) | **KEEP AS-IS** | Must name p1. Every role takeover ConditionChecks it. |
| p1/p2 routes, flip, non-primary router | **RETIRE** (operationally) | Code dormant. p2 retires through `retire-check`; the route table shrinks to p1 at migration step I. |

## 6. Fencing and ownership on one host

**No source change.** The single host is pool `p1`, exactly as an ECS task of p1 was. Every process has a fresh task id (`awsMain.ts` `newTaskId`, not ECS metadata) and **takes `POOL#p1` with a new epoch**. Every write carries its fence inside the write.

| Threat | What stops it |
|---|---|
| A stale process after a restart or takeover | The new process's epoch makes the table refuse the old one's writes (fence-in-write). The old one sees the loss within its 2 s self-check and exits 3. Its KMS gate withholds every Sign. |
| A duplicate process on the same instance | Docker container-name uniqueness (`gs-server`) and `gs-preflight` refuse it. If one were still started by hand, the newest takes the pool, the older is fenced and exits 3, and systemd does **not** restart it (`RestartPreventExitStatus=3 5`). The HOLD then keeps it down across reboots too, so there is no ping-pong. |
| The old instance after a replacement | Terraform destroys it before the new one exists (the ENI). If an old instance were ever started again, `gs-preflight` refuses: it does not hold the serving Elastic IP. If even that were bypassed, the fences refuse its writes. |

Do **not** remove fencing because only one server is desired: the fences are what make the three rows above safe.

## 7. Deploy, rollback, stop, health

All scripts are idempotent and fail closed. They print digests, build ids, states and HTTP codes, never a secret (none exists on the host). From Windows, use `infra/aws/single-host/gs-host.ps1`; from bash, `gs-host.sh`. Both use SSM Run Command, with arguments validated locally and fixed remote templates.

| Command (on the host, root) | Steps |
|---|---|
| `gs-deploy <sha256:digest> <build-id> [--measure]` | 1. Pull **by digest** and prove the architecture; nothing is stopped if this fails. 2. Same release, running and ready → nothing to do. 3. Drain: `systemctl stop` → SIGTERM → graceful exit 0; prove no container is left. 4. `release.env` becomes the new release; the old one becomes `release.previous.env`. 5. Start: preflight, then the new process takes the pool, the identity writer and the relayer, loads, and runs its first money sweep. 6. Readiness 200 within 300 s; Caddy reopens traffic by itself. A release that never becomes ready is **left running for diagnosis** and the command fails; rolling back is a deliberate `gs-rollback`. |
| `gs-rollback` | Swaps current and previous with the same steps. Running it twice rolls forward again. Per LIVE-4, an older build *holds or refuses* newer-format records and never reinterprets them, so a rollback is safe but may leave newer-format games unserved. |
| `gs-stop [--until-deploy]` | Drain and stop. It always sends `systemctl stop`, which also cancels a start in progress or a pending auto-restart. `--until-deploy` also keeps it stopped across reboots: a drained window for a relayer rotation, a restore or a migration step. |
| `gs-health [--wait N]` | One JSON line: units, build, HOLD, `healthz`, `readyz`, and readyz through Caddy's TLS. Exit 0 only when ready. COST-2A adds `digest` (the release file's), `running_digest` (the running container's image, in this repository) and `static_credentials` (the NAMES of any static AWS credential source on the host, or `none`; never a value) -- the host verifier's evidence (`awsDeploy verify --topology single-host`, infra/aws/README.md "The single host"). |

**Releasing an image:**
1. Build the image from a clean checkout: `infra/aws/single-host/build-image.ps1` (or `.sh`). It defaults to `linux/arm64`.
2. Push it to the existing ECR repository, then deploy the printed digest: `gs-host.ps1 -Command deploy -InstanceId i-... -Digest sha256:... -BuildId <id>`.

## 8. Image storage: ECR kept

The host pulls with its **instance role** through `amazon-ecr-credential-helper`, so no registry password or token is ever stored.

- An arm64 release is about 85 MB compressed, and releases share their base layers.
- The lifecycle policy keeps the newest 20 images and expires untagged ones after 7 days: at most about 1.7 GB, so **≤ $0.17/month**. It is **off until the ECS services are gone** (migration step I): while ECS is the rollback path, its circuit-breaker images must not expire.
- Releases are pushed single-platform (`--provenance=false`), so the tag names the manifest itself and no untagged child manifest exists.
- Same-region pulls are free.

GHCR or another registry would need a long-lived pull secret on the host, so it is rejected.

## 9. Observability: the reduced tier

| Signal | Source | Cost |
|---|---|---|
| `HostHealthProblems` (gauge) | The server's `single-host` metric profile: the count of standing problems at each 30 s tick (not ready, pool writer unconfirmed, not primary or not the identity writer, money sweep ≥ 180 s stale, relayer unusable, escrow inactive, relayer paging, restored money games unverified, signer unavailable on that tick). | $0.30 |
| `HostCriticalEvents` (counter, only when > 0) | Task loss (any cause), uncertain store, refused start, sweep pass or game failure, relayer takeover not taken, KMS refused / invalid / other failure, money game held journal-ahead | about $0 |
| `HostPressure` | `gs-host-sample`: memory available < 10 %, swap > 50 %, disk > 85 %, or a new OOM kill | about $0 |
| EC2 `StatusCheckFailed`, `CPUCreditBalance` | basic EC2 metrics | free |
| Log group (90 days) | every AUDIT and metric line, all values kept | ≈ $0.59 |

**The alarms:**

| Alarm | Fires when |
|---|---|
| `gs-<env>-host-health` | ≥ 1 for 3 minutes, **missing = breaching**, so it is also the heartbeat. A planned deploy can page it. |
| `gs-<env>-host-critical-event` | any event |
| `gs-<env>-host-status-check` | the EC2 status check fails |
| `gs-<env>-host-pressure` | the host sampler saw pressure |
| `gs-<env>-host-cpu-credits` | the CPU-credit balance stays under 30 for 15 minutes (standard credits: the host would be held at its baseline). **Expected once after every launch or host replacement:** T4g/T3 in standard mode earn no launch credits, so the balance starts near 0; it clears after about 75 minutes of light load (t4g.small earns 24 credits/hour). |

Five alarms at $0.50 bring the whole tier to **about $1.40/month**, against roughly $45 for the L6-5B matrix with Container Insights.

**Not paged on the single host** (still in every log line): L6-5B A11 (readiness flapping faster than a tick) and A14 (TASK# write failures). Both were ticket-class.

**Which problem was it:** use Logs Insights on the host log group.
```
fields @timestamp, event, ready, reasons, relayer_state, escrow_state, HostHealthProblems, HostCriticalEvents
| filter HostHealthProblems > 0 or HostCriticalEvents > 0 | sort @timestamp desc | limit 50
```
```
fields @timestamp, @message | filter @message like /^AUDIT / | sort @timestamp desc | limit 100
```

The full L6-5A/L6-5B catalog is still **written** in every line; only its *extraction* is off. `GS_METRICS_PROFILE` unset or `full` keeps the ECS behaviour byte for byte.

**No observability path changes a money decision:** the runtime never reads a metric.

## 10. Memory measurement plan

The **default and target stays t4g.small (2 GB).** There is **no automatic downsizing**; a smaller host is an owner decision after the measurement.

1. Deploy the release with **`--measure`**: `gs-host.ps1 -Command deploy ... -Measure`. Once a minute, the read-only preload `gs-measure.cjs` writes a `GSMEASURE {...}` line with:
   - `rss`, `peak_rss`;
   - `heap_used`, `heap_total`, `heap_limit`;
   - `external`, `array_buffers`;
   - **event-loop lag** p50 / p99 / max;
   - event-loop utilisation;
   - CPU user and system ms.

   The prefix makes it non-JSON, so no metric is extracted and it costs log bytes only.
2. **`gs-host-sample`** (always on) records, every minute:
   - host memory available and total, swap used, disk, load;
   - the container's cgroup **memory.current / memory.peak**, **OOM-kill count** and CPU;
   - kernel OOM lines.
3. Run **at least 2 weeks of representative testnet use.** That means real games, including route-heavy turns: the exact route search runs on the server's event loop, with ceilings of 10M expansions and 20M packing states.
4. Gather the results:
   - `gs-host.ps1 -Command measure-report -Days 14` gives the peak container memory, minimum available memory, maximum swap, OOM evidence and maximum load.
   - The Node figures come from this Logs Insights query:
     ```
     fields @timestamp, @message | filter @message like /^GSMEASURE /
     | parse @message 'GSMEASURE {"t":*,"rss":*,"peak_rss":*,"heap_used":*,"heap_total":*,"heap_limit":*,' as t, rss, peak, hu, ht, hl
     | stats max(peak)/1048576 as peak_rss_mb, max(hu)/1048576 as heap_used_mb, max(ht)/1048576 as heap_total_mb by bin(1d)
     ```
     Event-loop lag p99 and max come from the same lines.
5. Downsizing to **t4g.micro (1 GB)** may be *considered* only if, over that window:
   - the container's peak stays under about 550 MB;
   - the host never swapped meaningfully;
   - there were no OOM kills;
   - event-loop p99 stayed low on route-heavy turns.

   It would be a reviewed change: `instance.type`, a smaller `server_memory`, and a host replacement.
6. Redeploy without `--measure` when done.

## 11. ARM64 / Graviton

- **Node:** 22, from the multi-arch **index** digest `node:22-bookworm-slim@sha256:43ac6c…` (amd64, arm64, …). Each platform resolves its own manifest. The same index is mirrored on `public.ecr.aws/docker/library/node`.
- **Native dependencies:** none. The server's production dependencies are `ws` and the AWS SDK; secp256k1 is in-house TypeScript. `infra/docker/check-arch-neutral.cjs` fails the build on any `*.node`, `binding.gyp`, install script or os/cpu-pinned lockfile entry.
- **The build stage runs on the builder's platform** (`FROM --platform=$BUILDPLATFORM`): tsc emits architecture-neutral JavaScript. The runtime stage only copies files, so an arm64 image needs no QEMU to build. An amd64 build on amd64 is exactly the build it always was.
- **Behind a TLS-inspecting proxy:** `--secret id=build_ca,src=<ca>`. It is never baked into a layer, and verification is never disabled.
- **Host side:** AL2023 arm64 AMI; Docker, the ECR credential helper and iptables from AL2023's repositories; Caddy's pinned index digest has arm64. Everything else is shell, Node and Terraform: architecture-neutral.
- **Test-only dependencies** (DynamoDB Local, the frontend build) never run on the host.
- **x86 stays available:** `t3.small` / `t3.micro` set `GS_ARCH=amd64`, and the preflight refuses an image of the wrong architecture.

## 12. Tests

| Test | Proves |
|---|---|
| `tests/single-host.tftest.hcl` (`terraform test`) | The hardened host, IAM least privilege (statement by statement), network, user-data size and absence of credentials, the five alarms, budget, ECR lifecycle |
| `tests/host-scripts.test.sh` | preflight / run / deploy / rollback / stop / HOLD / health / sampler against stubs |
| `tests/edge-smoke.sh` (Docker) | The real Caddy image and the rendered Caddyfile with the unit's flags: TLS, /gs routing, query / cookie / Origin, XFF append, WebSocket, readiness 503, port-80 404 |
| `tests/image-smoke.sh <image> <platform>` (Docker; arm64 under QEMU on x86) | Image metadata, Node arch / user, the server starting with `/gs/healthz` 200, SIGTERM exit 0, AWS-mode refusals offline, AWS mode reaching the runtime-document read |
| `server/src/aws/deploy/cost1SingleHost.test.ts` (`npm test`) | The budget manifest and the cost / exposure / credential guards |
| `server/src/aws/runtime/singleHostMetrics.test.ts` (`npm test`) | The metric profile |
