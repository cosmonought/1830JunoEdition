# Phase 2 · Session 1 — JX-1 live setup on the single host

**Status:** a PROCEDURE. Nothing here has been executed. No AWS, Juno or JUNOX action was taken to write it.
**Written:** 2026-10-03, Phase-2 procedure preparation, on `phase2/single-host-live-procedures` (from the single-host
migration candidate `recon/step9-acme-completion` `5b4756d`).
**Do not run any step without the owner's GO for that step.**

> **Phase numbering.** "Phase 2" here is the owner's live-execution plan (Phase 1 = the single-host migration, Phase 2 =
> the testnet live sessions, ..., Phase 7 = mainnet readiness). It is not ROADMAP 3.2's numbering, where "Phase 2" is
> the closed Delayed-Auction pass and "Phase 5" is Junox E2E (the JX-n slices).

## 0. What this replaces, and what it keeps

JX-1B (Project `claude/JX1B_PHASE5_TOPOLOGY_AWS_STAGING_PREP_2026-10-02.md`) wrote the JX-1 setup for the ECS staging
topology (pools p1/p2, `drain-pool`, ECS service redeploys, ALB, `capture-evidence`, the L6-5B alarm matrix, operator r2
after L6-13). Staging is now the COST-1 single host (`infra/aws/SINGLE_HOST_MIGRATION.md`). This document replaces, for
the single host, JX-1B **§B** (the repoint surface), **§C.4-§C.5** (the apply sequence and the operator), the
pre-flight part of **§D**, **§H** (the repoint sequence), **§I** (the acceptance gate) and **§J** (the timed handoff).

**JX-1B stays authoritative, unchanged, for:** §A.3 (cross-contract replay is impossible), §E (admin / migrate admin /
resolver / treasury roles), §F (the accelerated parameter set and its proofs), §G (the `init.json`, the instantiate
command, the expected initial state and `JX1B_jx1b_verify.py`). Everything below that cites "JX-1B §x" means that
section verbatim.

### 0.1 Preserved invariants (not changed by the topology)

| Invariant | Value |
|---|---|
| Code | **uni-7 code 121**, canonical wasm checksum `5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8` (escrow 2.0.0). **No StoreCode.** JX-1 is a fresh instantiate of code 121. |
| Migrate admin | **`--no-admin`** (`wasm_admin: null`; `verifyJunoDeployment` requires the exact match) |
| `Config.admin` | `juno17me9g07q9kaxqs9dgk4l89klxasxm78r0qlrxj` (single-key BaseAccount, owner custody; immutable for life) |
| Params | JX-1B §F.1 exactly: `subsidy_bps` 250, `min_ante` "2000000", `bond_bps` 5000, `bond_floor` "1000000", challenge 900 / 1800, funding 3600 / 7200, liveness 3600, resolver timeout 7200 |
| Server trust minimums | **`min_challenge_window_secs` "900", `min_liveness_window_secs` "3600", `min_resolver_timeout_secs` "7200"** (mandatory: the fixture 3600 challenge minimum refuses every live JX-1 game, JX-1B §F.3) |
| Resolver | an **owner-held** JX-1 resolver wallet, in `trust.resolvers`; funded with about 0.5 JUNOX before Session 3 (not needed to instantiate) |
| Treasury | a **dedicated owner-held** JX-1 address (clean subsidy accounting; 0 JUNOX to create) |
| Settlement / admission keys | **fresh, dedicated** KMS keys from JX-1K `financial_key_sets = ["jx1"]` (`settlement-jx1`, `admission-jx1`); **reusing the current settlement or admission key is forbidden**; settlement key = signer key id **1** |
| Ledger / KMS safety | `ECC_SECG_P256K1` / `SIGN_VERIFY`, single-region, `prevent_destroy`, digest-only `Sign` (`ECDSA_SHA_256`, `DIGEST`), no `CreateGrant`; labels **append-only** (never remove `jx1`); **no hand-made key** (`aws kms create-key` is refused as a workaround, JX-1B §C.1); every Terraform apply is the **saved plan that passed its review**, never a fresh plan |
| Old contract | the contract the Juno document names today stays **untouched and unserved**, its keys kept (`prevent_destroy`) |

### 0.2 What the single host changes (ECS mechanics removed)

| JX-1B (ECS) | Single host (this procedure) |
|---|---|
| `drain-pool` p2 then p1 | **`gs-host stop -UntilDeploy`** on the one host (graceful SIGTERM, stays stopped across reboots until the next deploy) |
| every pool's ECS service redeploys (`triggers.juno_document`) | **`gs-host deploy` of the SAME release digest** after the applies: the server reads the LATEST Juno document at startup (`awsMain.ts`), exactly as migration step 21 does |
| app plan: SSM document + task policy + bootstrap policy + ECS services | app plan (`compute = "none"`): **SSM document + bootstrap policy only** (no task role, no service exists) |
| — | **new: a `stacks/single-host` plan** — the host role's inline policy swaps its settlement / admission key ARNs |
| ledger key policies name the ECS task role | they name **`gs-staging-host-app` only** (migration steps 8 and 22) |
| `capture-evidence` + `awsDeploy verify` (ECS) | **`capture-host-evidence` + `awsDeploy verify --topology single-host`** (COST-2A) |
| A6 / A7 / A13 alarms (L6-5B) | the five host alarms; `HostHealthProblems` = 0 (relayer unusable, escrow inactive and signer unavailable are all in it) |
| optional `stage-cert ... --scenario replacement` | retired (ECS-only); not part of JX-1 |
| operator = r2 (assumed post-L6-13) | operator = **`<RELAYER>`, the relayer the single host's Juno document names today** (see §0.3) |
| KMS keys: 3 + `relayer-r2` + the jx1 pair = 6 | **3 + the jx1 pair = 5** (6 only if a `relayer-r2` key already exists; ≤ `COST_BUDGET.json` `max_kms_keys` 6; +$2/month). **No other key is created** (Phase-2 key rotation is deferred: `PHASE2_DECISIONS.md` OD-P2-KR) |
| `JX1B_jx1b_plan_guard.py app ... --pools p1,p2` | `JX1B_jx1b_plan_guard.py app ... --pools=` (no pool: it then requires no service and refuses any) |

### 0.3 The operator / relayer (owner confirmation OD-P2-1)

JX-1B instantiated with `operator = r2` because it assumed LIVE-6 L6-13 (the relayer rotation r1 → r2) had run. In the
single-host lineage LIVE-6 was abandoned at GO-B: L6-11 and L6-13 never ran, so no `relayer-r2` key is expected to exist,
and creating one would be a new KMS key, which this phase does not add. The decision JX-1B was protecting is kept:
**instantiate with `operator` = the relayer the server is already configured with, so no `SetOperator` is ever needed.**

- `<RELAYER>` = the app tfvars' `escrow.relayer_address` (= `trust.operators[0]`), whose key is `signing_keys.relayer`.
  S0.2 records it and proves it from KMS. Expected: r1 (`juno1wev2…tu6`).
- If S0.2 shows a different configured relayer (e.g. r2 does exist and is configured), use that one; nothing else in
  this procedure changes.
- **The relayer must hold at least the derived planning reserve** (`set-operator-plan` prints it; 8.2125 JUNOX at the
  default gas policy, L6-12D) before GO-3, and about **15 JUNOX before Session 2** (JX-1B §D: reserve + matrix + margin).
  r1 last read 5.0 JUNOX (JX-1B §D), so it needs a plain bank send from the owner's funder (not an escrow deposit: no
  escrow fee applies). This is listed under §1 P-6.

---

## 1. Preconditions (all must hold before S0)

| # | Precondition | Proof |
|---|---|---|
| P-1 | **Phase 1 closed:** the single-host migration is complete, steps A–J (in particular step 20 `compute = "none"`, step 22 the task role deauthorised from the ledger, and step 24's inventory judged `verify --topology single-host` VERIFIED); the COST-2C owner gate PASS; the step-12b ARM64 live smoke PASS | the migration's evidence directories and guard records |
| P-2 | **No drift:** `terraform plan -detailed-exitcode` = **0** for `stacks/ledger`, `stacks/app` and `stacks/single-host` with today's tfvars | three plan outputs (read-only) — so every plan below shows JX-1's change alone |
| P-3 | **No money in flight:** `gamesDoctor aws games --money` empty; `RELAYQ#<RELAYER>` Count 0 (strong, every page); no ALARM | S0.3 |
| P-4 | **The candidate carries JX-1K**: `stacks/ledger` has the `financial_key_sets` variable and the `financial_key_arns` output | `infra/aws/README.md` "Financial key sets" |
| P-5 | **Owner custody:** the admin key `juno17me9…r0qlrxj` and a `junod` signing path (Git Bash / WSL / PowerShell 7.3+; PowerShell 5.1 mangles inline JSON) | JX-1B §G.2 |
| P-6 | **Funding:** the admin ≥ 0.1 JUNOX (instantiate ≈ 0.0275 JUNOX); `<RELAYER>` ≥ the derived reserve (§0.3) | `JX1B_jx1b_verify.py account` |
| P-7 | **Addresses decided:** `<JX1_RESOLVER>` (owner-held key) and `<JX1_TREASURY>` (owner-held, dedicated) | the owner's record |
| P-8 | **Frontend publish mechanism** for the staging site origin (outside this repository), and the current pin's `rpc`, `rest`, `explorerTx` values to reuse | the owner's record |
| P-9 | **Tools** from the Project, SHA-256 recorded: `JX1B_jx1b_verify.py`, `JX1B_jx1b_plan_guard.py` | `sha256sum` |
| P-10 | **A clean checkout of the reviewed commit** for every Terraform capture (the single host's files LF; `plan-evidence` refuses otherwise) | `infra/aws/SINGLE_HOST_MIGRATION.md` header |

**Names used below.** `<D>` an evidence directory; `<P1ARN>` the p1 runtime SSM parameter ARN (`/gs/staging/runtime/p1`);
`<i-…>` the host's instance id; `<DIGEST>` / `<BUILD>` the release the host serves now (`gs-host status`);
`<LEDGERARN>` the ledger table ARN; `<CURRENT>` the contract the Juno document names today (expected the LIVE-6 staging
contract `juno185qumjr5dquzusluh32pe88v9l5fgx7a74ch7wtqlc4387x78j9q9kwkpu`). Roles as in the migration runbook:
`APP-ADMIN`, `LEDGER-ADMIN`, `BOOT` (`gs-staging-bootstrap`), `OPER` (`gs-staging-operator`), and the **host-deploy
principal** that runs `gs-host` (SSM Run Command). On Windows run `node dist/server/src/tools/<tool>.js` directly
(PowerShell's `npm.ps1` swallows `--`) and the `.ps1` scripts; AWS CLI v2.

---

## 2. S0 — read-only preflight (no GO needed)

```
S0.1  python3 JX1B_jx1b_verify.py snapshot --contract <CURRENT> --out <D>\current-before.json
      python3 JX1B_jx1b_verify.py account --address juno17me9g07q9kaxqs9dgk4l89klxasxm78r0qlrxj      # >= 0.1 JUNOX
      junod q wasm code-info 121 --node <RPC> -o json        # data_hash 5ECC3022…09E8, instantiate_permission Everybody
S0.2  (APP-ADMIN, read) record from the app tfvars: escrow.relayer_address = <RELAYER>, escrow.trust (operators, resolvers,
      min_*), signing_keys (relayer, settlement, admission); keep a COPY of the app and single-host tfvars in <D>\before\
      (LEDGER-ADMIN) terraform -chdir=infra/aws/stacks/ledger output -json relayer_key_arns     # expected {"r1": ...} only
      (BOOT) awsDeploy set-operator-plan --runtime-parameter <P1ARN> --environment staging \
               --to-relayer <RELAYER> --to-relayer-key <signing_keys.relayer>
             # PASS key <-> <RELAYER>; "operator <RELAYER>" (ALREADY); no "; PAUSED"; READY (balance >= reserve).
             # Record the printed "per-tx cap" and "planning reserve". NOT READY on the reserve = top up first (P-6).
S0.3  (OPER) gamesDoctor aws games --money --aws-config <P1ARN>          # empty
      (OPER) aws dynamodb query --table-name gs-staging-game-g1 --key-condition-expression "pk = :p" \
               --expression-attribute-values '{":p":{"S":"RELAYQ#<RELAYER>"}}' --consistent-read --select COUNT   # Count 0
      (BOOT) aws cloudwatch describe-alarms --alarm-name-prefix gs-staging- --state-value ALARM              # empty
S0.4  (host-deploy) gs-host.ps1 -Command status -InstanceId <i-…>     # readyz 200, hold none; record <DIGEST>, <BUILD>
      the F0-style single-host verification into <D>\s0 (capture-host-evidence, host-snapshot,
      verify --topology single-host ... --expect-digest <DIGEST> --expect-build <BUILD>)      # VERIFIED
S0.5  P-2: the three plans exit 0 (read-only)
```

Any FAIL, NOT EVALUATED or unexpected value: **STOP.** Nothing has changed.

---

## 3. GO-1 — create the JX-1 financial KMS keys (ledger stack)

1. `LEDGER-ADMIN`: ledger tfvars `financial_key_sets = ["jx1"]` (nothing else changes; `app_runtime_role_arns` stays
   `["arn:aws:iam::<app>:role/gs-staging-host-app"]`, `ecs_task_role_authorized` stays `false`).
2. Capture, keeping the binary plan:
   ```
   infra\aws\scripts\plan-evidence.ps1 -Stack ledger -Out <D> -Run jx1-go1 -KeepPlan -PlanArgs @("-var-file=staging.tfvars")
   python3 JX1B_jx1b_plan_guard.py ledger <D>\terraform\ledger\plan.json --label jx1        # ALLOWED, else STOP
   ```
   **Expected, exactly:** two creates — `module.ledger.aws_kms_key.signing["settlement-jx1"]` and
   `["admission-jx1"]`, each `ECC_SECG_P256K1` / `SIGN_VERIFY` / single-region / enabled, tagged
   `gs:signing-purpose = settlement | admission`, `gs:key-set = jx1`. Their key policy is the existing keys' policy, so
   it names the host role only. No update, replace or delete; the ledger resource policy unchanged.
3. **Owner GO-1**, then apply exactly that saved plan:
   `terraform -chdir=infra/aws/stacks/ledger apply <D>\terraform\ledger\stack.tfplan`
4. `terraform -chdir=infra/aws/stacks/ledger output -json financial_key_arns > <D>\financial_key_arns.json`
5. Derive the public keys with **ledger-account credentials** (the key policy's administration statement grants that
   account `kms:Get*` / `kms:Describe*`; the bootstrap role cannot read the new keys until GO-3):
   ```
   awsDeploy signer-keys --relayer <signing_keys.relayer> --settlement <settlement-jx1 ARN> --admission <admission-jx1 ARN> > <D>\signer-keys.json
   ```
   `relayer.address` must equal `<RELAYER>`; record both 33-byte compressed public keys
   (`<JX1_SETTLEMENT_PUBKEY_HEX>`, `<JX1_ADMISSION_PUBKEY_HEX>`).

**Rollback:** none needed. The keys are inert until referenced; they stay (`prevent_destroy`) and bill $1/key-month.

---

## 4. GO-2 — instantiate the JX-1 contract (chain)

Exactly JX-1B §G, with one substitution: **`"operator": "<RELAYER>"`** (§0.3) in `init.json` and `jx1-expect.json`.

- `init.json`: JX-1B §G.1 (`admin` `juno17me9…r0qlrxj`; `operator` `<RELAYER>`; `resolver` `<JX1_RESOLVER>`; `treasury`
  `<JX1_TREASURY>`; `denom` `ujunox`; the §F.1 params; `signer_keys: ["<JX1_SETTLEMENT_PUBKEY_HEX>"]` → key id 1;
  `admission_pubkey: "<JX1_ADMISSION_PUBKEY_HEX>"`).
- Label: `gs-staging-jx1-escrow-<sha7 of the serving release's source commit>` (informational; nothing reads it).
- **Owner GO-2**, then from the admin wallet, **no funds attached**:
  ```sh
  junod tx wasm instantiate 121 "$(cat init.json)" --label "<label>" --no-admin \
    --from <admin key name> --chain-id uni-7 --node <RPC> \
    --gas auto --gas-adjustment 1.3 --gas-prices 0.075ujunox -o json -y        # NO --amount
  junod q tx <txhash> --node <RPC> -o json    # code 0; _contract_address; contract_version 2.0.0; signer_key_ids 1
  ```
- Record the tx hash, height and `<JX1>`; then
  `python3 JX1B_jx1b_verify.py verify --contract <JX1> --expect jx1-expect.json` → **PASS** (exit 0), else STOP (an
  unserved contract is inert; nothing to undo).

---

## 5. GO-3 — repoint the single host (the only window with downtime)

### 5.1 Edit the tfvars (keep the §S0.2 copies)

| Stack | Variable | New value |
|---|---|---|
| `stacks/app` | `signing_keys.settlement` / `.admission` | `financial_key_arns.jx1.settlement` / `.admission` (`.relayer` UNCHANGED) |
| `stacks/app` | `escrow.contract_address` | `<JX1>` |
| `stacks/app` | `escrow.settlement_key` | `{ signer_key_id = 1, public_key_hex = <JX1_SETTLEMENT_PUBKEY_HEX> }` |
| `stacks/app` | `escrow.admission_key.public_key_hex` | `<JX1_ADMISSION_PUBKEY_HEX>` (TTL unchanged) |
| `stacks/app` | `escrow.trust` | `min_challenge_window_secs "900"`, `min_liveness_window_secs "3600"`, `min_resolver_timeout_secs "7200"`; `resolvers` = `[<JX1_RESOLVER>]` (plus any kept entry); `operators` UNCHANGED `[<RELAYER>]` |
| `stacks/single-host` | `signing_keys.settlement` / `.admission` | the same two ARNs (`.relayer` UNCHANGED) — the host role signs with exactly the three configured keys |

Everything else stays: relayer, `code_checksum`, `wasm_admin` null, denom, chain id, endpoints, gas, journal,
`money_tables_nonmainnet`, `compute = "none"`, `start_services = true`, pools `{ p1 }`, generation 1, the runtime
document, the host's instance, user data, release and alarms.

### 5.2 Capture and review both plans (read-only; the host keeps serving the old contract)

```
infra\aws\scripts\plan-evidence.ps1 -Stack app -Out <D> -Run jx1-go3 -KeepPlan -PlanArgs @("-var-file=staging.tfvars")
python3 JX1B_jx1b_plan_guard.py app <D>\terraform\app\plan.json --pools=               # ALLOWED, else STOP
infra\aws\scripts\plan-evidence.ps1 -Stack single-host -Out <D> -Run jx1-go3 -KeepPlan -PlanArgs @("-var-file=staging.tfvars")
terraform -chdir=infra/aws/stacks/single-host show <D>\terraform\single-host\stack.tfplan > <D>\single-host-plan.txt
```

(`--pools=` with the `=`: PowerShell 5.1 drops an empty `""` argument to a native command. Omitting `--pools` falls
back to the guard's ECS default `p1,p2` and STOPs with "MISSING update … pool" — checked on synthetic single-host plans:
the expected plan ALLOWED, the same plan plus any ECS service update STOP.)

**App plan — expected, exactly** (the guard enforces it; with no pool it refuses any ECS change):
- `module.app.aws_ssm_parameter.juno_backend[0]` — in-place; the decoded Juno document moves ONLY at
  `contract_address`, `settlement_key.{public_key_hex,signer.key_ref}`, `admission_key.{public_key_hex,signer.key_ref}`,
  `trust.min_*_secs`, `trust.resolvers`;
- `module.app.aws_iam_role_policy.bootstrap` — in-place; only the `SigningKeysReadOnly` statement's resources.
- Nothing else. (There is no task policy and no ECS service under `compute = "none"`.)

**Single-host plan — expected, exactly** (owner review; the JX-1B guard has no `single-host` mode, so this is a manual
allowlist — anything else is a STOP):
- `Plan: 0 to add, 1 to change, 0 to destroy`;
- the ONE change: `module.host.aws_iam_role_policy.host`, attribute `policy` only;
- inside it, ONLY the `SigningKeysPublicKey` and `SigningKeysSignDigestOnly` statements' `Resource` lists change: the
  previous settlement and admission ARNs replaced by the jx1 ARNs, the relayer ARN kept; the digest-only `Condition`
  unchanged; every other statement byte-equal;
- no instance, user data, ENI, EIP, security-group, alarm, log-group or budget change (the instance's user data does not
  carry the signing keys — a plan that replaces the instance is a STOP).

### 5.3 Owner GO-3: stop, apply, start

```
(host-deploy) gs-host.ps1 -Command stop -InstanceId <i-…> -UntilDeploy        # graceful; readiness 503 first
(OPER)        RELAYQ#<RELAYER> Count 0 (again, stopped); gamesDoctor aws games --money empty
(APP-ADMIN)   terraform -chdir=infra/aws/stacks/app apply <D>\terraform\app\stack.tfplan
(APP-ADMIN)   terraform -chdir=infra/aws/stacks/single-host apply <D>\terraform\single-host\stack.tfplan
(host-deploy) gs-host.ps1 -Command deploy -InstanceId <i-…> -Digest <DIGEST> -BuildId <BUILD>
```

The host must be stopped BEFORE the single-host apply: from that apply on, the host role can no longer sign with the
previous settlement / admission keys. A "Saved plan is stale" refusal means the state moved: capture and review again.
The deploy is the same release (pulled by digest, already on the host); it re-enables the unit and runs the certified startup —
APPGEN 1, a new `POOL#p1` epoch, the identity writer, the ledger, the relayer role (a new ledger fence epoch for
`<RELAYER>`), the stores, the first money sweep — then reads the new Juno document and verifies the deployment.

### 5.4 Prove the repoint

| # | Check | Expected |
|---|---|---|
| 5.4a | the host log group `/gs/staging/host` | `escrow: Juno backend VERIFIED on uni-7 at height … (contract <JX1>; relayer <RELAYER>; kms keys)` and `AUDIT escrow.backend-verified` naming `<JX1>`, signer key id 1; **no** `escrow.backend-refused` |
| 5.4b | `gs-host status` | `readyz` 200, `hold` none, `digest` = `running_digest` = `<DIGEST>` |
| 5.4c | the `TASK#` heartbeat of the host's task / `gamesDoctor aws status` | escrow `active`, relayer `usable`; relayer mirror epoch = ledger fence epoch, held by the host's task |
| 5.4d | `HostHealthProblems` | 0; the five host alarms not in ALARM |
| 5.4e | fresh `capture-host-evidence` + `host-snapshot` + `awsDeploy verify --topology single-host ... --expect-digest <DIGEST>` | VERIFIED (it includes the KMS keys' metadata, no grants, public keys = the configuration's, now settlement-jx1 / admission-jx1) |
| 5.4f | `awsDeploy verify --part ledger --ledger-table-arn <LEDGERARN> --environment staging --generation 1` | VERIFIED |
| 5.4g | `set-operator-plan … --to-relayer <RELAYER> --to-relayer-key <signing_keys.relayer>` | now reads `<JX1>`: ALREADY `<RELAYER>`, not paused, READY |
| 5.4h | `terraform plan -detailed-exitcode` for ledger, app, single-host | **0, 0, 0** |

**If 5.4a shows `backend-refused`, or any row fails: rollback (§8, GO-3 row).**

---

## 6. GO-4 — publish the pinned frontend

1. Rebuild the unchanged frontend tree with
   ```
   REACT_APP_ESCROW_DEPLOYMENT={"backend":"juno-cosmwasm","chainId":"uni-7","networkClass":"testnet","contract":"<JX1>","codeChecksum":"5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8","denom":"ujunox","symbol":"JUNOX","exponent":6,"rpc":"<same https RPC as today>","rest":"<same https REST>","chainName":"Juno testnet","gasPrice":"0.075","explorerTx":<same or null>}
   ```
2. The bundle contains `<JX1>` and the checksum, and **not** `<CURRENT>`. Publish it to the staging site origin by the
   owner's mechanism (`edge.site_origin_domain_name` is external to this repository; CloudFront is unchanged).
3. Browser, signed in on `https://play.<domain>`: DevTools → `POST /gs/api/money/config` → `deployment.contract = <JX1>`;
   the host's real-money stake section is offered (it appears only when the server is enabled AND the build pin equals the
   server's deployment field for field).

---

## 7. Close and acceptance

```
python3 JX1B_jx1b_verify.py snapshot --contract <CURRENT> --out <D>\current-after.json
python3 JX1B_jx1b_verify.py same <D>\current-before.json <D>\current-after.json          # SAME
```

| # | Criterion | Evidence |
|---|---|---|
| A-1 | New contract recorded | instantiate tx hash, height, `<JX1>` |
| A-2 | Code 121, canonical checksum | `jx1b_verify` |
| A-3 | wasm admin null | `jx1b_verify` |
| A-4 | `Config.admin` = `juno17me9…r0qlrxj`; creator = admin | `jx1b_verify` |
| A-5 | Operator = `<RELAYER>` = the KMS-derived address of `signing_keys.relayer` | `jx1b_verify` + `signer-keys` + 5.4g |
| A-6 | Signer registry = exactly key id 1 = settlement-jx1, active; `next_signer_key_id` 2 | `jx1b_verify` + `signer-keys` |
| A-7 | `admission_pubkey` = admission-jx1 | `jx1b_verify` + `signer-keys` |
| A-8 | Resolver and treasury as decided (owner-held; dedicated treasury); resolver ∈ `trust.resolvers` | `jx1b_verify` + the SSM document |
| A-9 | Params = JX-1B §F.1; trust 900 / 3600 / 7200 | `jx1b_verify` + the SSM document |
| A-10 | `paused` false; `next_chain_game_id` 1; history 1 entry; **balance empty** | `jx1b_verify` |
| A-11 | `verifyJunoDeployment` verified on `<JX1>`; no `backend-refused` | 5.4a |
| A-12 | Escrow active, relayer usable, `HostHealthProblems` 0, no host alarm in ALARM | 5.4c, 5.4d |
| A-13 | `verify --topology single-host` and `--part ledger` VERIFIED; `set-operator-plan` ALREADY + READY | 5.4e-g |
| A-14 | Frontend pin exact; bundle names `<JX1>`, not `<CURRENT>`; browser config + stake section | §6 |
| A-15 | The old contract unchanged | `same` → SAME |
| A-16 | No unexpected AWS change: GO-1 guard ALLOWED; GO-3 app guard ALLOWED and single-host allowlist reviewed; all three stacks plan **0** afterwards; one host, same digest; the ledger holds the S0 signing keys **plus exactly the jx1 pair** (5, or 6 with a pre-existing `relayer-r2`) | guard records, 5.4h, `terraform output` |

Record: Project `claude/JX1_LIVE_<date>.md` (the filled table and the evidence paths).

**Duration:** about 60–75 min (S0 15, GO-1 10, GO-2 10, GO-3 25 of which ≈ 5–10 min downtime, GO-4 15).

---

## 8. Rollback

| When | What |
|---|---|
| Before GO-3 | Nothing is served from JX-1; nothing to undo. The jx1 keys stay (`prevent_destroy`); the new contract is inert. |
| GO-3: a review STOP before the stop | Nothing changed: discard the plans, fix the tfvars, capture again. |
| GO-3: after the stop, before or after the applies (refused backend, failed 5.4) | Keep the host stopped. Restore the §S0.2 tfvars copies of `stacks/app` and `stacks/single-host`; capture both again; review them as the **exact reverse** of §5.2 (the app guard rejects that plan because `contract_address` must change *to* JX-1 — review the reverse by hand against §5.2's list); apply; `gs-host deploy` the same `<DIGEST>`. The server verifies `<CURRENT>` again; its keys were never removed and the old contract was never touched. |
| GO-4 fails | Republish the previous bundle. Money stays fail-closed regardless: a pin mismatch shows no stake section and signs nothing. |

---

## 9. Hand-off to Session 2

- The relayer at ≥ ~15 JUNOX (§0.3) and `set-operator-plan` READY **before each money table opens**.
- The resolver funded (~0.5 JUNOX) before Session 3.
- Test wallets funded per JX-7A §P (and the annul procedure's §3) before the sessions that use them.
- Every tester keeps every round under an hour (the 3600 s liveness window; JX-7H).

**Residual (not blocking):** the JX-1B plan guard has no `single-host` mode; §5.2 reviews that one-resource plan by a
written allowlist. A ~30-line `single-host` mode beside `ledger` / `app` would make it fail-closed by tool; it is an
optional follow-up, not a precondition.
