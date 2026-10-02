# Hosting budget — architecture decision record (COST-0 / COST-1)

**Status:** decided by the owner (COST-0, 2026-10-02). Implemented as source and IaC by COST-1 on `cost/cost-1-single-ec2`. Nothing is deployed.

**Machine-readable form:** [`infra/aws/COST_BUDGET.json`](../infra/aws/COST_BUDGET.json). It is pinned by `server/src/aws/deploy/cost1SingleHost.test.ts`. Change this record, the manifest and the test together, and only by an owner decision.

## 1. The decision

| | |
|---|---|
| **Hard ceiling** | **$30 / month**: the whole recurring infrastructure, all AWS services plus the static-site host. |
| **Target** | **≤ $20 / month** expected steady state. |
| **Pricing basis** | AWS us-east-1 **list** prices: the Price List API offer files of 2026-09, 730 h per month. |
| **Not counted** | Free Tier, sign-up credits and promotions are **never** counted toward either number. |

The LIVE-5/LIVE-6 topology (ECS/Fargate p1+p2, ALB, NAT, interface endpoints, Container Insights, the L6-5B alarm matrix) cost **≈ $185–$260 / month idle**, and **≈ $150** even with both pools drained (COST-0 §B). It is retired as the deployment topology. Its *application safety logic* is kept.

## 2. The approved topology

```
browser ──https──► CloudFront (existing distribution; play.<domain> unchanged)
                     ├─ default ─────► the static site (Vercel while non-commercial; S3 behind the same distribution before real money)
                     └─ /gs*  ───────► https://<origin hostname>  (existing /gs* policy: ALL query strings, cookies, Origin, WebSocket headers)
                                         │  one Elastic IP on one ENI; security group: 443 from CloudFront's origin-facing prefix list,
                                         │  80 for Let's Encrypt HTTP-01 only; no SSH; no NAT; no endpoints
                                         ▼
                        ONE EC2 host (t4g.small, Graviton, 2 GB; IMDSv2; CPU credits standard; IAM instance profile)
                          ├─ Caddy (container, unprivileged, host network): TLS for the origin, reverse proxy to 127.0.0.1:8917,
                          │     health check /gs/readyz (the ALB's target health, kept)
                          └─ the game server (container, systemd-managed): the SAME AWS-mode image (GS_STORAGE=aws), ONE pool (p1)
                               ├─ DynamoDB game-g<N> / identity  (existing, on-demand, PITR)        [app account]
                               ├─ DynamoDB ledger + locked AWS Backup vault (existing)               [ledger account]
                               ├─ KMS secp256k1 signing keys (existing; Sign ECDSA_SHA_256 over a DIGEST only)
                               ├─ SSM runtime + Juno documents (existing)
                               ├─ CloudWatch: one log group (90 days), five alarms, ~one continuous metric
                               └─ Juno REST endpoints over public HTTPS
```

- **Module and stack:** `infra/aws/modules/single-host`, `infra/aws/stacks/single-host`.
- **Runtime design:** `infra/aws/modules/single-host/README.md`.
- **Migration:** `infra/aws/SINGLE_HOST_MIGRATION.md`.

## 3. Prohibited fixed-cost resources (unless the owner changes this decision)

In the active low-cost architecture, none of the following may appear:

- an ALB / ELB, target group or listener;
- ECS (cluster, service, task definition) or Fargate;
- a NAT gateway;
- any VPC endpoint;
- a second application instance or pool, autoscaling or a launch template;
- duplicated DynamoDB tables or KMS keys;
- a new CloudFront distribution;
- provisioned DynamoDB capacity;
- RDS, ElastiCache, EKS, App Runner, Lightsail, Global Accelerator, Transit Gateway, Network Firewall, Shield Advanced or Private CA;
- CloudWatch dashboards or composite alarms;
- Secrets Manager;
- pay-as-you-go WAF;
- detailed EC2 monitoring;
- CPU credits *unlimited*;
- log retention above 90 days.

The guard test fails on any of these in `COST_BUDGET.json`'s `scan_roots`.

The ECS-era resources still exist in `stacks/app` behind `compute = "ecs"` (the default, unchanged). The migration switches that to `compute = "none"`, which removes every one of them. The test pins that gate too.

## 4. The money-safety authorities that are retained (unchanged)

| Authority | Where | Why it stays |
|---|---|---|
| Game / identity / ledger stores | the existing DynamoDB tables | Fence-in-write, the token-settled unknown outcomes, the certified L5-2 / L5-4 / L5-5 adapters. Together they cost ≈ $1.2–1.7 / month. |
| The signing ledger in its **own account and restore domain** + the locked backup vault | stacks/ledger | Anti-equivocation. A restore of app data can never roll it back (COST-0 §G). |
| APPGEN, SYSTEM/GENERATION, the generation gate, post-restore safe mode | ledger + game table | A restore is detected and fenced. |
| Pool-writer, identity-writer and relayer fences | game table + ledger | A second process (same host or another) is fenced at its next write; the old one exits 3. |
| The SEC# security journal, durable grants | ledger, identity | Identity restore safety. |
| KMS signing keys | stacks/ledger | Non-exportable keys. Sign is digest-only. |
| Chain truth | Juno | `aheadOfLog`, `recordBehind`, the contract's state machine: no double settlement. |

The **single host keeps every one of them**. It runs the certified AWS-mode runtime, not file storage. File (PROCESS) mode is *not* a money mode in production: it refuses development keys and KMS there (COST-0 §D.3).

## 5. The accepted availability trade-off

**Accepted:**
- one application host;
- maintenance downtime;
- restart or reboot downtime;
- deploy downtime (stop, then start);
- replacing a lost host from Terraform with minutes of outage (the host holds no data).

**Not accepted:**
- silent financial corruption;
- double settlement;
- an unfenced second writer;
- long-lived AWS credentials on the host.

## 6. The itemized nominal cost model (us-east-1)

| Item | $/month | Basis |
|---|---:|---|
| EC2 t4g.small, 1-year EC2 Instance Savings Plan | 7.67 | $0.0105/h. On-demand is $0.0168/h = $12.26. |
| EBS gp3 12 GB | 0.96 | $0.08/GB-month |
| Public IPv4 (one Elastic IP) | 3.65 | $0.005/h |
| DynamoDB requests | 1.00 | ≈ 6M RRU × $0.125/M + ≈ 0.4M WRU × $0.625/M |
| DynamoDB storage + PITR | 0.23 | ≈ 0.5 GB × ($0.25 + $0.20) |
| AWS Backup (ledger) | 0.18 | 35 recovery points × ≈ 0.05 GB × $0.10 |
| KMS: 3 keys + Sign | 3.03 | $1/key-month. Asymmetric requests are $0.15/10k and get no free tier. |
| CloudWatch Logs | 0.59 | ≈ 1 GB × $0.50 ingest + ≈ 3 GB × $0.03 stored (90 days) |
| CloudWatch metrics | 0.30 | One continuous series (`HostHealthProblems`). The others publish only on incidents. |
| CloudWatch alarms (5) | 0.50 | $0.10 each |
| ECR (newest 20 images) | 0.15 | ≈ 1.5 GB × $0.10. The arm64 image is ≈ 85 MB compressed and shares base layers across releases. |
| CloudFront (pay-as-you-go) | 0.30 | testnet scale |
| S3 (Terraform state) | 0.05 | |
| **Expected total** | **18.61** | **≤ $20 target, ≤ $30 ceiling** |

**Other configurations:**

| Configuration | $/month |
|---|---:|
| t4g.small on-demand, before the Savings Plan | **23.20** |
| t4g.small, 1-year Compute Savings Plan ($0.0121/h) | 19.77 |
| t4g.micro on-demand (only after the measurement plan) | 17.07 |
| t3.small on-demand (x86 fallback) | 26.12 |
| The LIVE-6 → JX-1 transition, up to 6 KMS keys | +3.00 |
| Route 53 hosted zone, if the DNS lives there | +0.50 |

**The $20 target needs the Savings Plan.** It is an owner billing action, taken only after the ≥ 2-week memory measurement confirms t4g.small. Until then the host is on-demand, at ≈ $23.20, within the ceiling.

## 7. Guards

1. **Source guard.** `server/src/aws/deploy/cost1SingleHost.test.ts`, in `npm test`, checks:
   - the manifest's sums and ceilings;
   - the prohibited types and settings;
   - one host, one EIP and one pool;
   - credits standard;
   - the allowed instance types;
   - the log-retention cap;
   - five alarms;
   - loopback-only publishing and the security-group surface;
   - no credential literal;
   - the `stacks/app` compute gate.
2. **IaC tests.**
   - `infra/aws/modules/single-host/tests/single-host.tftest.hcl`: the host's hardening, IAM least privilege, network, budget and alarms.
   - `infra/aws/modules/app/tests/compute_none.tftest.hcl`: `compute = "none"` removes every ECS-era resource and keeps the tables, documents, ECR and the distribution.
3. **AWS Budget.** `budget.tf`, off until a subscriber is named:
   - notifications at $15 actual, $20 actual, $25 forecast, $25 actual and $30 actual;
   - notify only.
   Stopping the host automatically would be money-safe but takes the game offline, so it stays an owner decision.
4. **Cost allocation.** Every single-host resource is tagged `gs:cost = single-host`.

## 8. Changing this decision

An owner decision that changes the ceiling, the target, the topology or an allow-list updates, in one reviewed change:
- this record;
- `infra/aws/COST_BUDGET.json`;
- the guard test.

The guard is meant to make an accidental return of the ECS-era cost structure impossible to miss. A deliberate return stays possible.
