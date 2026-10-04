# Phase 1 — clean final AWS build and direct certification (P1-R0 … P1-R6)

**Status:** the GOVERNING Phase-1 plan, written by PHASE 1 CLEAN-BUILD RESET (2026-10-04). Source / planning only:
nothing here has been executed, and nothing in it is run from Cowork.

**Owner decision (2026-10-04).** The staging AWS service has no production users and no live workload that needs
continuity. The ECS → single-host **migration procedure is RETIRED as the governing Phase-1 plan**; the **final
single-host architecture is NOT abandoned**. Phase 1 is now: the final state → its direct certification. It is no longer:
the old ECS → coexistence → cutover → retirement.

**Supersedes, as the governing plan:** `infra/aws/SINGLE_HOST_MIGRATION.md` (kept, unchanged below its banner, as the
historical / audit record and as the reference for commands this plan reuses).

**Companion documents:**
- `infra/aws/PHASE1_INVENTORY.json` -- the retain / delete / review classification (machine-readable; pinned by
  `server/src/aws/deploy/migration/phase1CleanBuild.test.ts`);
- `infra/aws/PHASE1_LEGACY_TEARDOWN.md` -- P1-R3, the explicit LIVE teardown procedure.

**Unchanged by this reset** (the durable decisions it builds on):
- the final topology of `docs/hosting-budget.md` and `infra/aws/COST_BUDGET.json`:
  - one Graviton host (t4g.small) on one ENI / EIP, Caddy + gs-server, pool p1;
  - no ALB, ECS / Fargate, NAT or VPC endpoints;
  - the existing CloudFront distribution, DynamoDB game + identity tables, the separate ledger / backup domain, KMS
    keys, ECR and SSM documents;
  - five host alarms;
- the money: **≤ $20 / month target, $30 hard ceiling**, ≈ $23.20 on-demand accepted;
- every money-safety and fencing semantic: the pool writer, identity writer and relayer fences, APPGEN /
  SYSTEM/GENERATION, the ledger's own account, KMS digest-only Sign, `RestartPreventExitStatus=3 5`, the HOLD;
- ARM64; IAM least privilege; the KMS / ledger separation;
- the gameplay and settlement version axes (rules 12; settlement `[10, 11, 12]`; hosted 1, financial 3, client 1).

## 0. The live starting state

These facts are as recorded by the Phase-1 passes and the owner's P1-M5 report. **P1-R1 re-proves every one, read-only,
before anything else.**

- **Runbook steps 1–13 are done**, including 7a, 7b, 8, 9 / 9r, 10, 11, 12 / 12b and 13 / 13r. In particular:
  - the ledger and key policies authorise `gs-staging-host-app` beside the ECS task role;
  - the host `i-01fe56536bf591382` serves `sh1-5b4756d-arm64-r1` (`sha256:df981e83…`) on EIP `34.234.48.65`, origin
    `gs-origin-host.netadao.org`, with the three 13r scripts installed.
- **F0–F6 have passed**; P1-M5 passed F3–F6.
  - P1-M5's **F7 ended NOT EVALUATED** on two availability observations only: a 0.2 s readiness sampler saw 200 → 000
    without catching a transient 503, and the captured journal held no "Main process exited" line for the clean exit 0.
    That line is not expected for exit 0: systemd's `unit_log_process_exit` (v252, Amazon Linux 2023's) logs a
    successful exit at DEBUG and a failed one at NOTICE / WARNING. So the crash (137) and fence (3) exits R5 drills do
    reach the journal.
  - In the same run the host itself recovered correctly: same release, newer authority epochs, one writer, no HOLD, no
    restart defect, `gamesDoctor` clean.
- **CloudFront `/gs*` still names the ALB.** The ALB, ECS cluster and services (p1, p2 drained 0/0/0), VPC endpoints,
  L6-5B alarm matrix, task / execution roles, pool log groups, p2's runtime document and the NAT all still exist.
- **The data:**
  - APPGEN 1, g1 authoritative;
  - g2 prepared but UNADOPTED, outside Terraform;
  - 0 money games, RELAYQ empty;
  - the recovery role absent, break-glass off.
- **External Terraform stacks.** The first P1-R1 run (2026-10-04) stopped correctly on the distribution; `network.tfstate`
  was a second discovery. Both state objects sit in `s3://gs-staging-tfstate-992163310414/gs/staging/` (R1 confirms
  where this repository's own states sit), and neither stack's configuration is in this repository:
  - **rpc-proxy** (`rpc-proxy.tfstate`, from the ops-local checkout `1830-staging-ops\rpc-proxy`):
    - CloudFront distribution `E271XZAA1MQR4H`, the CORS proxy for the uni-7 RPC `juno.rpc.t.stavr.tech`;
    - its origin-request and response-headers policies.
    - The published frontend's `pin-final.json` and the Keplr money path use it. Owner classification: **KEEP-DURABLE**.
  - **network** (`network.tfstate`, created 2026-10-01): **REVIEW**. Its contents are not yet enumerated; it may own the
    VPC, subnets, route tables, IGW, NAT and NAT EIP.

## 1. The milestones

| Milestone | What | Runs where | Mutates AWS / Juno? |
|---|---|---|---|
| **P1-R0** | Freeze: the migration campaign is retired; its evidence is kept | source (this reset) | no |
| **P1-R1** | Authoritative retain / delete / review inventory: source classification + live read-only confirmation | source (done) + the LIVE session, read-only | no |
| **P1-R2** | Source / IaC reconciliation to "final state → direct certification" | source (this branch) | no |
| **P1-R3** | Legacy hosting teardown (`PHASE1_LEGACY_TEARDOWN.md`) | the LIVE session; an owner GO before every mutation | yes (AWS) |
| **P1-R4** | Clean final host build: the final configuration converged on the host | the LIVE session; owner GO | yes (AWS) |
| **P1-R5** | Direct final-system certification (A–F) | the LIVE session + owner (browser); owner GO for the drills and the money smoke | yes (staging drills; testnet JUNOX) |
| **P1-R6** | Closure | record | no |

## 2. P1-R0 — Freeze / retire the migration campaign

**Retired** (never run again as Phase-1 gates; their records stay as historical / audit evidence):
- **P1-M5** -- historical evidence, not a gate to continue;
- **the F7 / F8 / F9 campaign as PRE-CUTOVER migration gates.** F8 / F9 return in R5 as final-system tests, after the
  teardown, not before a cutover;
- **step 14 as a choreographed cutover with a rollback path.** The one CloudFront origin change is kept as R3's T1,
  forward only;
- **the ECS rollback** (`ecs-rollback`) and the edge rollback (`edge-cutover --direction rollback`);
- **coexistence:** F0 / 15b `verify --topology coexist`, the "ECS era stays as the rollback path" rule, and the
  "F0–F9 PASS before step 14" rule;
- **migration authority hand-off, migration-specific graceful cutover, old / new pool choreography;**
- **the quiet period as a sequence gate.** The NAT's ≥ 24 whole quiet hours after the teardown are kept, because they
  are evidence about OTHER users of a NAT this repository never created, not migration continuity. R4 / R5 proceed
  meanwhile (A1 names the pending NAT PROVISIONAL); the wait delays only Z and R6. The window may start earlier, at this
  workload's last NAT use (T7);
- **step 25 (Cost Explorer 5–7 days) as a gate.** It is trailing confirmation and never blocks Phase 2.

**Kept as operational tooling, not as Phase-1 gates:** `host-cert graceful-stop` (F7), `host-cert replacement-before /
replacement-after` (F10), `verify --topology coexist`, and every guard and script (`PHASE1_INVENTORY.json` `tooling`).
No source file is deleted by this reset.

## 3. P1-R1 — The authoritative retain / delete / review inventory

**Source classification (done):** `infra/aws/PHASE1_INVENTORY.json`. Every Terraform declaration of `modules/app`,
`modules/ledger` and `modules/single-host` is classified exactly once, and every relevant resource outside Terraform is
listed. The test fails if a module gains an unclassified resource.

Each entry records:
- its Terraform stack or outside owner;
- its dependencies and teardown step (destroy order);
- whether its removal is reversible;
- its IAM / KMS principal effect;
- any state reconciliation it needs.

| Class | Resources (staging names) |
|---|---|
| **KEEP-DURABLE** | the external **rpc-proxy** stack (`external-terraform:rpc-proxy`, `gs/staging/rpc-proxy.tfstate`): distribution `E271XZAA1MQR4H` and policies `gs-staging-uni7-rpc-origin-request` / `gs-staging-uni7-rpc-cors` -- never touched by Phase 1; game table `gs-staging-game-g1`; identity table; the p1 runtime document and the Juno document; ECR `gs-staging-server`; the CloudFront distribution + its `/gs*` origin-request policy; the bootstrap and operator roles (+ the absent recovery role's capability); the ledger table + resource policy; the locked backup vault, plan, selection and role (+ its customer-managed key / copy vault, if configured); the KMS signing keys; the Terraform state backends; `play.<domain>` and its viewer certificate |
| **KEEP-HOST** | the instance `i-01fe56536bf591382`; its ENI, EIP + association, security group + rules; `gs-staging-host-app` (role, profile, inline policy); the log group `/gs/staging/host` and the five host alarms; the monthly budget; the ECR lifecycle policy (created in R4); the origin A record; the VPC, subnets, route tables and IGW (KEEP / NEVER DELETE, whichever stack owns them: ownership `unresolved` until R1) |
| **DELETE-LEGACY** | ECS cluster `gs-staging`, services p1 / p2 and their task-definition revisions (T8d: `skip_destroy` leaves them ACTIVE); ALB `gs-staging-alb`, listener, rules, target groups; ALB / task / endpoint security groups and rules; the gateway and interface VPC endpoints; task and execution roles (+ policies); pool log groups `/gs/staging/p1`, `/gs/staging/p2`; the L6-5B alarms, composites and flip suppressors; `/gs/staging/runtime/p2`; the Container Insights log groups; the ALB's origin DNS name and ACM certificate |
| **DELETE-MIGRATION** | `gs-staging-game-g2` (the unadopted restore), only after its preconditions are proven -- owner decision, not a closure blocker |
| **REVIEW** | the external **network** stack (`external-terraform:network`, `gs/staging/network.tfstate`; contents UNKNOWN until R1); the NAT gateway and its EIP (ownership `unresolved`: deleted only on T7's ownership rule AND its evidence); the host-deploy principal; the alarm destinations; the service-linked roles; the evidence exports and any on-demand backups |

**Principal effects (the IAM / KMS question):**
- Every cross-account grant in `modules/ledger` names the app account root with an `aws:PrincipalArn` condition. So
  **deleting `gs-staging-app-task` invalidates no ledger or key policy**.
- The hazard runs the other way: until R3's T5, a new role of that name would inherit ledger appends and KMS Sign. T5
  removes the name, and `stacks/ledger` now requires `ecs_task_role_authorized` explicitly.
- The bootstrap / operator trust policies name the owner's principals directly. Never delete a principal named in
  `*_trusted_principal_arns`.

**State reconciliation needed:** none to import. g2 was never imported, and stays out. The desired-count drift ends in
T3: the services are destroyed, never restarted.

**External Terraform ownership.** The inventory distinguishes four ownership forms (`ownership_forms`):
- `terraform:<app|ledger|single-host>`: this repository's stacks;
- `external-terraform:<stack>`: a staging stack whose configuration is elsewhere, with its `state_key`;
- `outside-terraform:<who>`: no Terraform known;
- `unresolved:<candidates>`: not yet proven, and never mutated.

`terraform_states` lists every known state object.

**Live confirmation (the LIVE session, read-only; the prompt in §11 A).** R1 runs in two parts, because T3 is the
critical path (`PHASE1_LEGACY_TEARDOWN.md` "The T3 fast path"):
- **Part A -- before T3: what T1, T2 and T3 depend on.**
  - **Every Terraform state object.** R1 enumerates every state object in the staging state bucket(s) -- every
    `.tfstate` key, not only the staging prefix, and not only the states this repository expects. Each is named and
    mapped to a `terraform_states` entry. For each state, R1 records:
    - the S3 key, and whether it can be read;
    - its resource addresses and ids, by T0.11's streaming read form, which keeps nothing else of the state. Never a
      `terraform init` against another stack's key, never `-migrate-state` or `-force-copy`, never a plan or apply of
      an external stack.
  - **An unknown state is a STOP**, exactly like an unknown resource. The known list is not a closed count: five are
    known today (app, ledger, single-host, rpc-proxy, network).
  - **Every live resource of the app account** that carries the environment's names or tags, or that any state lists,
    is matched to an inventory entry.
  - the rpc-proxy distribution's ETag and status (T0.11), and every other `[PRE-T3]` fact of T0, including T0.12's
    casualty check: no other state manages what T3 destroys, and nothing else hangs on it.
- **Part B -- may follow T3.** Each item gates the later step it names:
  - for each EXTERNAL state, beyond its addresses (T7, R6):
    - the live resources behind them, and their inventory classification;
    - the owning checkout or stack, if known;
    - whether any Phase-1 teardown step proposes to mutate one of them;
  - the NAT facts (T0.10), including whether the NAT and NAT EIP are members of `network.tfstate`, their tags and
    CloudTrail's user agent (T7);
  - which state, if any, holds the VPC, subnets, route tables and IGW, and whether the private route tables are
    network-owned (recorded; T7, R6);
  - every live resource of the ledger account, its state's listing, and the ledger plan of T0.9 (T5);
  - the host's rendered configuration (§6) and the single-host plan of T0.9 (R4);
  - the backup vault's key and any on-demand backups, and the rpc-proxy's cost facts: expected pay-as-you-go, with R1
    confirming no WAF, real-time logs or flat-rate plan (R6 item 6).
- **A live resource or state the inventory cannot place, or any state drift, is a STOP.** It is an owner decision, and
  the source inventory is amended in a reviewed change.
  - **T3 fast path only.** An owner ruling recorded in the R1 record may place a newly found state or resource
    provisionally, as REVIEW and never in a DELETE class, when all three hold:
    - it can be read;
    - T0.12 finds that it shares nothing with T3's destroy set and hangs on nothing in it;
    - no step T1–T3 touches it.

    Its reviewed source amendment then follows before any later step touches it, and before R6. Anything else stays a
    STOP.

## 4. P1-R2 — Source / IaC reconciliation (this branch)

The smallest change that makes the active Phase-1 procedure "final state → direct certification":
- **Docs:** this plan, the teardown procedure and the inventory. `SINGLE_HOST_MIGRATION.md` gains a RETIRED banner and
  is otherwise unchanged. Pointers are updated in `PROJECT_CANONICAL_CONTEXT.md`, `docs/hosting-budget.md`,
  `infra/aws/README.md` and `modules/single-host/README.md`.
- **IaC -- two root variables made explicit, no resource touched:**
  - `stacks/app` `compute` has no default. Every plan must state `"ecs"` or `"none"`, so the expensive topology can no
    longer come back by an omitted line.
  - `stacks/ledger` `ecs_task_role_authorized` has no default. The deleted task role's name cannot be re-granted by an
    omitted line.
  - Their examples state the final values.
  - The modules' own defaults, every resource, the guards and the host's files are unchanged.
- **Tests:** `phase1CleanBuild.test.ts` pins:
  - the inventory against the modules and the teardown guard's classes;
  - the explicit variables;
  - the final-state values;
  - the teardown order the guards force;
  - the R5 suite;
  - the governing pointers.
- **Not changed:** application runtime, image, gameplay, settlement, contracts, money / fencing semantics, the guards'
  code, `modules/*`, `stacks/single-host`, the host scripts.

## 5. P1-R3 — Legacy hosting teardown

`infra/aws/PHASE1_LEGACY_TEARDOWN.md`, executed only by the dedicated LIVE session:
- **T0** read-only preconditions;
- **T1** the CloudFront `/gs*` origin → the host (`edge-cutover`, forward);
- **T2** ALB deletion protection off, if on;
- **T3** `compute-none`;
- **T4** host restart onto the p1-only document (`-Measure`);
- **T5** `ledger-task-deauthorize`;
- **T6** Container Insights log groups;
- **T7** the NAT: ownership first, then evidence. A Terraform-owned NAT is never deleted directly; an unproven
  ownership BLOCKS T7;
- **T8** the ALB's DNS name and certificate, the ECS task-definition revisions, and optionally g2;
- **T9** read-only proof that the legacy plane is gone.

**The critical path is T3** (owner, 2026-10-04). The teardown's "T3 fast path" runs, in order:
1. R1 part A and T0's `[PRE-T3]` items;
2. T1, which the guards make a prerequisite;
3. T2, only if the ALB is deletion-protected;
4. the judged `compute-none` plan;
5. `READY FOR GO-T3`.

The network stack's contents beyond T0.12's overlap check, the NAT's ownership and window, the ledger and single-host
plans, R4 / R5, T4–T9 and Phase-3 work all come after T3 and never delay it.

**External stacks.** No teardown step touches the rpc-proxy stack: T1's plan is the app stack's, targeted at its own
distribution, and T0 / T9 only read `E271XZAA1MQR4H`. No teardown step touches the network stack either, except through
T7's separately reviewed change (if the NAT belongs to it). T3 removes this repository's own gateway endpoints and so
their routes in the private route tables; that is not a change to the network stack (the teardown's T3 step 3).

**Why this order.** The existing guards fix T1 before T3:
- `edge-cutover` refuses `compute = "none"`;
- `compute-none` refuses any distribution change. T3's tfvars name the host origin, so a T3 run before T1 FAILS its guard.

T3 must also come before T5, T6 and T7. T7's capture must come ≥ 24 whole hours after T3: the gateway / interface
endpoints are gone by then, so another workload's traffic would now cross the NAT.

**OWNER-GO boundary:** §11 B.

## 6. P1-R4 — Clean final host build

**The default: KEEP the existing host.** The host is stateless and already the final topology's host, built by the
reviewed `host-create` guard from `5b4756d`. Its three changed scripts came by the reviewed 13r install. No coexistence
proof and no zero-downtime property is required, and the result must stand with the legacy plane absent (R5 proves that
after R3).

1. **The host's configuration is the final one** (read-only, recorded by R1; the facts the Phase-2 pack's S0.6–S0.9 also
   check):
   - the rendered `server.env` / `host.env` say `ESCROW_MONEY_TABLES=nonmainnet`;
   - the play origin is in `GS_ALLOWED_ORIGINS`;
   - escrow is enabled and `GS_EDGE_DIAGNOSTIC=staging`;
   - pool p1, generation 1, `game_generations = [1]`;
   - the signing keys are exactly the Juno document's;
   - termination protection is on, `emergency_ssh_cidrs` is empty, and the budget is enabled with a subscriber;
   - the on-host scripts are the reviewed bytes (this branch's `modules/single-host/files`: `5b4756d` + the three 13r
     files).
2. **The ECR lifecycle policy** (runbook 22b, unchanged), now that no ECS rollback needs old images:
   - `stacks/single-host` with `manage_ecr_lifecycle = true`, captured with `--keep-plan` from a clean checkout of
     **`5b4756d`** (its module is byte-identical at `61f6c82`; a later commit replaces the instance);
   - `migration-guard ecr-lifecycle --commit 5b4756dbd98e8d9abe5ed4bbdf4314466ef8045d` PASS;
   - owner GO (`GO P1-R4 ecr-lifecycle: apply <plan> (guard PASS)`);
   - apply exactly that plan.
3. **The release.**
   - The serving release `sh1-5b4756d-arm64-r1` is the final release; its step-12b capture is the ARM64 execution
     proof.
   - A newer release needs, in order: step 12 (build, push), 12b (`gs-host arm64-smoke`, PASS), then
     `gs-host deploy -Measure`.
   - The runtime image needs no rebuild for this reset (no runtime change).
4. **The runtime document and the measurement.** R3's T4 already restarted the host onto the final p1-only document
   with `-Measure`.

**The contingency: REBUILD the instance -- not part of this branch.** Trigger:
- item 1 finds the rendered configuration wrong (the Phase-2 pack's G-2: `money_tables_nonmainnet`, `allowed_origins`
  or `escrow_enabled`); or
- the host cannot be made healthy by a redeploy; or
- the owner chooses to converge Terraform's user data with the on-host scripts.

In each case **STOP**. User data is replace-on-change, and no existing guard accepts an instance replacement (`host-create`
accepts only creates; `ecr-lifecycle` only the lifecycle). The rebuild needs its own reviewed source change first: a
`host-rebuild` guard that:
- accepts the instance's destroy-before-create on the kept ENI / EIP;
- handles termination protection;
- accepts the instance-id-dependent alarm dimension updates;
- refuses everything else.

After it: 12b on the new host, deploy, and the R5 suite in full, plus `host-cert replacement-before / replacement-after`.

## 7. P1-R5 — Direct final-system certification

**Preconditions:**
- R3 complete except T7, which may still be in its ≥ 24 h wait or BLOCKED on the NAT's ownership, and T9 recorded except
  its NAT row.
  - A1 then names that NAT with `--allow-nat <nat-...>`, marked **PROVISIONAL** in the record.
  - Z, the closure record, is taken only after T7 and T9's NAT row, and never with a provisional `--allow-nat`.
  - If the NAT stays because its ownership is unproven, or because it belongs to an external stack whose reviewed change
    has not run, Z waits. The exception is the owner's recorded amendment of the closure policy, under which Z names that
    NAT as an owner-ruled exception, not a provisional one;
- R4 complete;
- every drill and probe run from the reviewed checkout, with a NEW run id per run;
- the evidence under `<D>\r5\`.

**REQUIRED before Phase 2:**

| # | Property | How (existing tooling) | PASS |
|---|---|---|---|
| A1 | Topology: exactly one application host; no retired ECS workload; no workload ALB; no workload NAT / endpoints unless REVIEW-placed as another workload's; the correct EIP / ENI; the correct CloudFront origin; the five host alarms | `capture-host-evidence` (BOOT; `--terraform-dir infra/aws/stacks/single-host` only if BOOT can read the state, else omitted = an explicit SKIP) + `--host-status-only` (HOST-DEPLOY) + `gamesDoctor aws host-snapshot` (OPER), then `awsDeploy verify --topology single-host --runtime-parameter <p1 ARN> --environment staging --primary-pool p1 --pools p1 --generation 1 --evidence <D>\r5\a --instance-id i-01fe56536bf591382 --origin-hostname <origin_hostname> --site-origin <site origin> --expect-digest <serving> --expect-build <build> --alarm-actions <ARNs or none> --record <D>\r5\a\verify.json --report <D>\r5\a` (`--allow-nat <id>` only for the NAT T7 has not yet judged -- recorded PROVISIONAL -- or one T7 kept as another workload's) + T9's CLI table | `VERIFIED` (exit 0) |
| B1 | ARM64 image executes on real Graviton | step 12b's capture for the serving digest (re-run for any new release) | `[linux/arm64] 7 passed, 0 failed`, `END exit=0` |
| B2 | Server healthy; Caddy → server | A1's `gs-health` line: ready, `origin_tls_readyz` 200, `server` / `caddy` active, digest = running digest, `hold none` | inside A1 |
| B3 | WebSocket; CloudFront `/gs*` route; query / cookie / header behaviour | `awsDeploy stage-probe edge --topology single-host --run-id <run> --evidence <D>\r5\f --host-evidence <D>\r5\a --instance-id i-01fe56536bf591382 --origin-hostname <origin_hostname> --base-url https://play.<domain> --origin https://play.<domain> --environment staging --generation 1 --pool p1 --expected-client-ip <ip>` (one line; `GS_CERT_SESSION_COOKIE` set) | `SINGLE-HOST EDGE PROBE: PASS` |
| B4 | Ordinary crash restarts | `awsDeploy host-cert crash-restart` (F8a) | accepted (below) |
| B5 | Reboot returns healthy | `awsDeploy host-cert reboot-restart` (F8b) | accepted (below) |
| C1 | Exactly one pool writer; identity writer correct; relayer fence / mirror correct; generation correct | `gamesDoctor aws status` (APPGEN 1 = the document's generation, the g1 marker `bootstrap`; POOL#p1, the identity writer and the relayer mirror at the ledger fence's epoch, all the host's CURRENT task; `relayer_state: usable`) + A1's roles checks | all hold |
| C2 | A second local process is refused | `awsDeploy host-cert duplicate-preflight` (F9a) | accepted |
| C3 | A rival writer is fenced; the fence exit / HOLD stops an unsafe duplicate | `awsDeploy host-cert duplicate-fence` (F9b): the incumbent exits 3, is not restarted, the HOLD survives a reboot and refuses preflight / start / a refused deploy; `gs-deploy` clears it; one writer at a newer fence | accepted |
| C4 | No static AWS credentials | A1's `static_credentials none` | inside A1 |
| D1 | KMS public-key / Sign path (after T5 changed every key policy) | `gs-host role-probe -Probe kms` judged by `stage-probe host-role --probe kms` | `HOST-ROLE PROBE F5 KMS: PASS` |
| D2 | Game-table / identity / ledger paths (after T5 changed the ledger policy) | `gs-host role-probe -Probe transactions` judged by `stage-probe host-role --probe transactions`; C1's role reads | `HOST-ROLE PROBE F6 DYNAMODB: PASS` |
| D3 | Restart does not lose application state | a no-money game created in F1 before B4; after B4, B5 and C3: `gamesDoctor aws game <id>` shows the same game (owner the host's current epoch) and the browser reconnects to it at the same position | same game, same log position |
| E1 | Relayer usable; contract operator correct; testnet reserve sufficient | C1's `relayer_state: usable`; `awsDeploy set-operator-plan --runtime-parameter <p1 ARN> --environment staging --to-relayer <the Juno document's relayer>` | `ALREADY <relayer>` and `READY` (the one-game planning reserve met) |
| E2 | A controlled one-game JUNO money smoke | ONE 2-seat money game on the escrow the host is configured for TODAY (the Juno document's chain, contract and keys) -- no KMS key, contract, document, frontend or stack change ("E2" below) | settled on chain and finalized; payouts = the independent integer computation; `money <game> --chain` all green |
| E3 | Money sweep healthy; `gamesDoctor` clean | `money-sweep` every 60 s, `MoneySweepSecondsSinceSuccess` < 180, `HostHealthProblems` 0; `gamesDoctor aws status`, `games --money` (none open after E2), `orphans` (none), `money <game> --chain` (every verdict green) | all hold |
| F1 | Browser join / play smoke | `https://play.<domain>`: sign-in, `__Host-gs_session`, lobby, a no-money game (kept for D3), reconnect | the owner records it |
| Z | The closure record | A1 again, after E2, every drill and T7 (fresh capture and run id; `--allow-nat` only for a NAT T7 kept as another workload's, or one named by the owner's recorded closure-policy amendment, never a provisional one) | `VERIFIED` |

**Order:**
1. A1, B1, B2, C1, C4, then D1, D2;
2. F1 (create D3's game), then B3;
3. the drills in this order -- C2 → B4 → B5 → C3 -- stopping at the first result not accepted; then
   `gs-host deploy -Measure` (same release; the drills' redeploys drop the measurement) and `gs-host status`;
4. D3; E1, E2, E3; Z.

The disruptive drills require 0 open money games and RELAYQ empty (their precheck refuses otherwise), so they run before
E2's game opens or after it finalizes.

**E2 -- the controlled money smoke** (the former step 18). It is Phase 1's own smoke on the deployment the final system
already serves. It is NOT the Phase-2 pack's Session 1 (which creates new KMS keys, a new JX-1 contract, a host key swap
and a frontend republish) and does not replace it.
- **Preconditions** (read-only; any one unmet is a STOP for the owner):
  - R5 A–D accepted and E1 `READY`;
  - the host renders `ESCROW_MONEY_TABLES=nonmainnet`, and the play origin is in `GS_ALLOWED_ORIGINS` (R4 item 1;
    fixing either is the R4 rebuild contingency);
  - the Juno document says `network_class` testnet (chain `uni-7`), and the host's startup log shows both:
    - `escrow: Juno backend VERIFIED on uni-7 at height …` (the deployment verified against the chain);
    - `money: real-money tables are ENABLED on uni-7 (testnet) …`;
  - the published frontend's pinned deployment (`REACT_APP_ESCROW_DEPLOYMENT` of the live build: the owner's build record
    or the string in the served bundle) names the same chain, contract and code checksum (a republish is a separate
    owner action);
  - the contract's own config is read and recorded (`min_ante` and the funding / challenge windows: the game's pace).
    Use `junod q wasm contract-state smart <contract> '{"config":{}}' --node <rpc>`, or the REST
    `GET <rest>/cosmwasm/wasm/v1/contract/<contract>/smart/eyJjb25maWciOnt9fQ==` (base64 of `{"config":{}}`);
  - 0 open money games and RELAYQ empty;
  - two owner test Keplr accounts `KA`, `KB` (each in its own browser profile) hold at least the ante plus fees plus one
    bond in reserve.
- **The game:**
  - KA hosts a 2-seat money table at the contract's minimum ante, short bank where available; KB joins;
  - both link their wallets (ADR-036);
  - KA CreateGame, KB Join (with the server's admission), funding confirmed from the chain;
  - KA Start, the relayer's Start confirmed, the deal checkpoint;
  - play to the end;
  - Settle (automatic);
  - the payout is checked: the settlement preview equals an independent integer computation
    `amountᵢ = floor(P·wᵢ / Σw)`, and both devices' bands say "Checked on this device";
  - at most one consent (KB);
  - Finalize at the window's end (automatic).
- **Step reference:** Session 2's sheet 2A–2L, read with `git show c6d7e76:docs/phase2/SESSION2_CORE_GAME.md`
  (branch `phase2/live-run-procedure-pack`, not in this tree). Substitute:
  - `<JX1>` / `<JX1_TREASURY>` → the current contract and its treasury;
  - the 900 s / 3600 s windows and the 2 JUNOX ante → the current contract's `config`;
  - the signer proof (`jx2VerifyTx`) → against the current relayer key.
  - Its prerequisite S2-P1 ("Session 1 PASS") is replaced by the preconditions above.
- **Evidence:** `gamesDoctor aws money <g> --chain` after CreateGame, Join, Start, Settle and Finalize (FIN, ROSTER MATCH,
  CHAIN BINDING MATCH, JOURNAL MATCH, no stuck intent); the balances before / after; the independent computation; RELAYQ
  empty at the end.
- **Owner GO, one per step** (each spends testnet JUNOX or moves money on chain; never batched with the drills):
  - `GO P1-R5 E2 fund KA / KB` (plain bank sends, only if needed);
  - `GO P1-R5 E2 CreateGame`;
  - `GO P1-R5 E2 Join`;
  - `GO P1-R5 E2 Start`;
  - `GO P1-R5 E2 final move` (from here Settle and Finalize are automatic);
  - `GO P1-R5 E2 consent` (after the payout check; a mismatch is ruled before the window ends: a Challenge or a recorded
    let-it-finalize).

**Owner GO for the drills and probes.** These are staging-only and recoverable, so one message may carry them all. Each is
consumed immediately before its mutation, and the session stops at the first non-PASS:
- `GO P1-R5 host-cert duplicate-preflight / crash-restart / reboot-restart / duplicate-fence on i-01fe56536bf591382, run <run>`;
- `GO P1-R5 role-probe kms / transactions`;
- `GO P1-R5 deploy -Measure`.

**Accepting a host-cert record.** A drill is **accepted** when its record says PASS (exit 0). It is also accepted -- and
the record kept with a note -- when it says NOT EVALUATED and its ONLY not-evaluated checks are availability
observations from this list:
- `F7: readiness goes unavailable first` (the readiness-503 sampler);
- `<label>: systemd's journal agrees with ExecStopPost` (systemd's journal wording), and only when that same record's
  `<label>: systemd passes EXIT_CODE / EXIT_STATUS to ExecStopPost` check PASSED.

Every other check of that record must PASS: the exit status, `ExecMainCode / ExecMainStatus` for a fence, the HOLD law,
`NRestarts`, the newer epochs and the one writer.

Any FAIL is a STOP. Any other NOT EVALUATED is re-run with a new run id. A REFUSED precheck (exit 4) mutated nothing:
fix its cause and re-run.

**Reclassified to Phase 6 / 7 launch readiness (availability only; never a Phase-1 blocker):**
- catching a transient readiness 503 in a 200 ms sampling interval (F7);
- the systemd journal's wording for a clean exit 0;
- zero-downtime deploy or handoff;
- migration rollback;
- old / new pool coexistence;
- the host-replacement drill (F10, with a rebuild);
- alarm-notification wiring drills (`set-alarm-state`);
- the ≥ 2-week memory measurement behind the Savings Plan. The plan is an owner billing action; until then the host is
  on-demand at ≈ $23.20, within the ceiling.

## 8. P1-R6 — Closure

Phase 1 closes when all six hold, each with its record:
1. **The final topology is directly verified:** R5's Z record is `VERIFIED` (no provisional `--allow-nat`), and T9 is
   recorded in full.
2. **The durable safety authorities are green:** C1–C4, D1, D2 and D3 accepted.
3. **The direct money smoke is green:** E1–E3.
4. **This workload's obsolete hosting resources are gone:** every `DELETE-LEGACY` inventory entry absent (T9).
   - the NAT is gone, or recorded by T7 as another workload's;
   - if T7 is BLOCKED (ownership unproven), or the NAT belongs to an external stack whose reviewed change has not run,
     R6 waits -- unless the owner explicitly amends the closure policy (recorded);
   - g2 is the owner's separate decision;
   - the external rpc-proxy stack is KEEP-DURABLE: never part of this item.
5. **The source budget guard passes:** `cost1SingleHost` and `phase1CleanBuild` (the owner's gate).
6. **The projected steady state is ≤ $30 / month:** the `COST_BUDGET.json` items priced on-demand (≈ $23.20) and
   nothing else billed for this workload.
   - A customer-managed key on the ledger's backup vault, if R1 found one, adds $1 / month. It is recorded and counted
     here.
   - A NAT another workload owns is excluded only by a recorded owner decision.
   - The rpc-proxy distribution is kept by the owner's KEEP-DURABLE ruling. It is expected to be pay-as-you-go, and R1
     part B confirms it has no WAF, real-time logs or flat-rate plan. Whether `COST_BUDGET.json` names it is the
     owner's decision.

**Trailing confirmation, never a gate:** Cost Explorer daily for 5–7 days (the `gs:cost` tag activated) and the
budget's alerts. Any later billing evidence above $30 / month reopens the cost issue.

## 9. Phase 2 and Phase 3

- **Phase 2** begins as soon as P1-R6 closes, with the existing Phase-2 pack (`phase2/live-run-procedure-pack` @
  `c6d7e76`, written for the migration). No retired migration gate is required. Read its prerequisites this way:
  - **S1-P1 "Phase 1 closed (migration steps A–J, step 24 …)"** → the P1-R6 closure record:
    - R5's Z replaces step 24;
    - R3's T0–T9 replace A–J;
    - the owner gate and 12b PASS are unchanged;
  - **S1-P2:**
    - G-14 (the step-16 edge probe) → R5-B3;
    - G-8 (KMS) → R5-D1;
    - "step 18 deferred to Session 2" → done in R5-E2. Session 2 still runs its own JX-1 game;
  - **P-2 (no drift) and GO-3** (the host signing-key swap): any `stacks/single-host` plan is captured from `5b4756d`'s
    module (R4: from a later commit it replaces the instance), unless the host was deliberately rebuilt first (the R4
    contingency).
  - Session 1's GO-1 adds two KMS keys (the documented transition, within `max_kms_keys`).
- **Phase 3** source work is independent and continues in parallel.

## 10. Migration gates retired vs final-system gates retained

| Former item (`SINGLE_HOST_MIGRATION.md`) | Now |
|---|---|
| §A 1–3 start-state proof | DONE; superseded by R1 / T0 |
| §B "ECS-era resources stay as the rollback path" | RETIRED |
| §C 6–7 preserve / export | RETAINED as T0.8 (required: the pool logs, the alarm history and the state pulls, unless the owner records a discard) |
| 7a, 7b, 8, 9, 9r, 10, 11, 12, 12b, 13, 13r | DONE (historical); 12 / 12b / 13 remain the release procedure |
| F0 `verify --topology coexist` | RETIRED (no coexistence) |
| F1–F4 | RETAINED as R5-C1 / E1 / E3 on the final system |
| F5 / F6 | RETAINED as R5-D1 / D2, re-run after T5 |
| F7 graceful-stop | RETIRED from Phase 1 → Phase 6 / 7 (P1-M5's record kept) |
| F8 crash / reboot | RETAINED as R5-B4 / B5 (post-teardown, not pre-cutover) |
| F9a / F9b | RETAINED as R5-C2 / C3 |
| F10 replacement | NOT REQUIRED (only with a rebuild) |
| "F0–F9 PASS before step 14" | RETIRED |
| §F ECS rollback (`ecs-rollback`) | RETIRED |
| 14 edge cutover + its rollback | RETAINED forward only as T1; the rollback RETIRED |
| 15 distribution deployed | RETAINED inside T1 |
| 15b F0 after the cutover | RETIRED (A1 judges the final state) |
| 16 edge probe | RETAINED as R5-B3 (standing on A1's evidence) |
| 17 browser smoke | RETAINED as R5-F1 |
| 18 money smoke (formerly deferred to Phase 2) | RETAINED as R5-E2 (required before Phase 2) |
| 19 retire-check p2 | RETAINED as T0.5 |
| 20-pre ALB deletion protection | RETAINED as T0.6 + T2 (the unprotect is now written) |
| 20 compute-none | RETAINED as T3 |
| 21 restart, `-Measure` | RETAINED as T4 |
| 22 ledger-task-deauthorize | RETAINED as T5 |
| 22b ECR lifecycle | RETAINED as R4 item 2 |
| 22c Container Insights | RETAINED as T6 |
| 23 NAT gate (≥ 24 h after step 20) | RETAINED as T7: the same gate; the capture ≥ 24 whole hours after T3, the window allowed to start at this workload's last NAT use; R4 / R5 proceed meanwhile (A1 PROVISIONAL), it delays only Z and R6 |
| 24 inventory | RETAINED as T9 + R5-A1 / Z |
| 25 billing | trailing confirmation (R6), never a gate |

## 11. For the LIVE session

**A. P1-R1 read-only inventory** -- two parts (§3). **Part A, before T3** (the T3 fast path):
- EVERY Terraform state object in the staging state bucket(s): each named and mapped to `terraform_states`, its
  addresses and ids read by T0.11's streaming form (nothing else of it kept; never a `terraform init` against another
  stack's key). At least app, ledger, single-host, `gs/staging/rpc-proxy.tfstate`
  and `gs/staging/network.tfstate`; an unknown state is a STOP;
- every app-account resource in the inventory's `live_names` (present / absent), and any app-account `gs-staging*` /
  `gs:environment=staging` resource NOT in the inventory (a STOP, or §3's provisional placement);
- the rpc-proxy distribution's ETag and status, and the external state objects' metadata (T0.11);
- every other `[PRE-T3]` item of T0:
  - the money / relay / HOLD reads and `gs-host status` (T0.3);
  - the ALB deletion-protection value (T0.6);
  - the app state list and plan (T0.9);
  - the T3 casualty check (T0.12);
- T0.10's `[CAPTURE BEFORE T3]` reads.

**Part B, after T3 if need be** (each before the step it gates):
- the external states' resources classified (T7, R6);
- the NAT facts: T_drain, and the NAT's / NAT EIP's state membership, tags and CloudTrail user agent (T0.10; T7);
- which state holds the VPC, subnets, route tables and IGW (T7, R6);
- the ledger account's resources, its state's listing and the ledger plan (T5);
- the host's rendered configuration and script hashes (§6 item 1; R4): `gs-host -Command status`, plus ONE read-only
  Run Command under the host-deploy principal printing `sha256sum /opt/gs/bin/* /etc/systemd/system/gs-*.service` and
  the lines of `/etc/gs/server.env` and `/etc/gs/host.env`. Both files hold references only, never a secret: any line
  that looks like a credential is a STOP;
- the single-host plan (R4);
- `orphans`; the backup vault's key and on-demand backups; the rpc-proxy's cost facts (R6).

Output: one record, `<D>\r1\`:
- part A's PASS: everything T1–T3 depend on placed, and nothing drifted;
- part B's open items, each with the step it gates.

**B. The OWNER-GO boundary for P1-R3** (`PHASE1_LEGACY_TEARDOWN.md`, "The OWNER-GO boundary"). After R1 part A and T0
part A PASS:
- **The reversible steps may be batched.** The owner may send GO-T1, T2, T4 and T5 together. Each is still conditional
  on its own guard PASS and on T0 part B's items for that step, and is consumed immediately before its mutation.
- **The irreversible steps never are.** Each comes in its own owner message, sent AFTER the session has posted what it
  authorises:
  - GO-T3 follows `READY FOR GO-T3`: the judged compute-none plan, whose destroy list the owner reads (it deletes the
    pool logs and alarm history);
  - GO-T6 follows the listed log-group names;
  - GO-T7 follows R1's ownership answer, the NAT evidence PASS and the owner's own RAM / no-planned-workload
    confirmation (it releases the NAT's public IP). GO-T7 exists only on T7's "proven NOT Terraform-owned" path. A
    Terraform-owned NAT's removal has its own GO, which names the reviewed external plan and never uses GO-T7's text;
  - each GO-T8a–d follows that item's evidence (T8c deletes g2 without a backup).
- Nothing destructive happens on a GO given before its evidence exists.

**C. P1-R4 / P1-R5:**
- R4: item 1 read (R1), item 2 (the ECR lifecycle, one GO);
- then R5 in §7's order, with its GO lines;
- then the R6 record.
