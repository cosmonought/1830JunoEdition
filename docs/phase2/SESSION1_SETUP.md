# Phase 2 · Session 1 — setup (operator sheet)

**Status:** a PROCEDURE, not executed. **The step-by-step setup is `JX1_SINGLE_HOST_SETUP.md`** (S0, GO-1…GO-4, §7
acceptance, §8 rollback), unchanged. This sheet adds what that document leaves to the session: the entry conditions, two
read-only checks the single host needs (gap G-2), the funding, and the session's evidence, PASS / STOP and JUNOX
accounting. Conventions, actors and read commands: `PHASE2_LIVE_RUN_PACK.md` §3–§5.

**Duration:** ≈ 1.5–2 h (setup ≈ 60–75 min, of which ≈ 5–10 min downtime at GO-3; funding and checks ≈ 30 min).
**No money table is opened in Session 1. No ECS step exists anywhere in it** (no pool drain, no service redeploy, no ALB,
no task role, no `capture-evidence`, no `stage-cert`): the host is stopped with `gs-host stop -UntilDeploy` and
restarted with `gs-host deploy` of the same release.

## 1. Prerequisites (all recorded before S0)

| # | Prerequisite | Proof |
|---|---|---|
| S1-P1 | **Phase 1 closed**: migration steps A–J, step 24 `verify --topology single-host` VERIFIED, COST-2C owner gate PASS, ARM64 live smoke PASS | the Phase-1 closure record |
| S1-P2 | Phase-1 items handed to Phase 2 are recorded: the Step-16 edge probe hotfix or ruling (gap G-14); the F5/F6 KMS ruling (gap G-8); Step 18 money smoke = deferred to Session 2 | the Phase-1 closure record |
| S1-P3 | **OD-P2-1 confirmed** (operator = the configured relayer; `JX1_SINGLE_HOST_SETUP.md` §0.3) | owner note |
| S1-P4 | `JX1_SINGLE_HOST_SETUP.md` §1 P-1…P-10 all hold (no drift, no money in flight, JX-1K in the tree, admin custody + `junod` path, funding, addresses, frontend publish mechanism, tools hashed, clean checkout) | that table |
| S1-P5 | The owner holds, for later sessions: the resolver key with a `junod` signing path (Session 3), and six test Keplr accounts (`KA`, `KB`, `K1`–`K4`), each in its own browser profile, with each hosted profile's recovery key | owner note (addresses recorded, no secrets) |
| S1-P6 | Owner decisions recorded or defaulted: OD-JX7-1 / 2 / 3, JX-3A B-6 (`PHASE2_LIVE_RUN_PACK.md` §8) | owner note |

## 2. Read-only additions to S0 (before GO-1) — gap G-2

The single host renders `ESCROW_MONEY_TABLES` and `GS_ALLOWED_ORIGINS` into its user data, and the instance is replaced
when the user data changes (`infra/aws/modules/single-host/host.tf`: `user_data_replace_on_change = true`). Phase 2 must
therefore find both **already right**:

| # | Check (APP-ADMIN, read) | Expected | If not |
|---|---|---|---|
| S0.6 | `stacks/single-host` tfvars: `money_tables_nonmainnet` | `true` (the example tfvars' value) | **STOP.** Enabling it is a host replacement: a separate, reviewed Phase-1-style change, not part of this session |
| S0.7 | `stacks/single-host` tfvars: `allowed_origins` | contains exactly `https://play.<domain>` (the page origin players use; JX-3A B-5 — the wallet-link text's `Site:` line must equal `window.location.origin`) | **STOP**, as S0.6 |
| S0.8 | `stacks/app` tfvars: `escrow.network_class` | not `mainnet` (testnet) | STOP |
| S0.9 | `stacks/single-host` tfvars: `escrow_enabled` | `true` (the host role reads `/gs/staging/juno-backend`; the migration runbook step 9 sets it "as staging", and Phase 1's F3 needed it) | STOP: Phase 1 is not in the state this procedure assumes |

Keep these values with the S0.2 copies in `<D>\p2-s1\before\`.

## 3. The session, in order

| Step | Procedure | Authority that acts | GO | Duration |
|---|---|---|---|---|
| S1-F0 | **relayer top-up first**: a plain bank send bringing `<RELAYER>` to ≈ 15 JUNOX (at least to the 8.2125 reserve; r1 last read 5.0). S0.2's and 5.4g's `set-operator-plan` must print READY, and P-6 requires the reserve before GO-3 | the owner's funding wallet | **GO-FUND-R** | 5 min |
| S0 | `JX1_SINGLE_HOST_SETUP.md` §2 + §2 above (read-only) | OPER, BOOT, APP-ADMIN, LEDGER-ADMIN, host-deploy (reads) | none | 15 min |
| GO-1 | create `settlement-jx1` / `admission-jx1` (ledger saved plan, guard ALLOWED) | LEDGER-ADMIN | **GO-1** | 10 min |
| GO-2 | instantiate JX-1 from code 121, `--no-admin`, no funds | `ADMIN` (owner's `junod`) | **GO-2** | 10 min |
| GO-3 | host stop → app + single-host saved-plan applies → `gs-host deploy` same digest | host-deploy, APP-ADMIN | **GO-3** | 25 min (5–10 min down) |
| GO-4 | rebuild and publish the pinned frontend | owner's publish mechanism (gap G-1) | **GO-4** | 15 min |
| §7 | acceptance A-1…A-16 | OPER, BOOT (reads) | none | 10 min |
| S1-F | the rest of the funding (§4 below) | the owner's funding wallet (plain bank sends) | **GO-FUND** | 15 min |
| S1-W | optional zero-JUNOX wallet smoke (§5 below) | KA, KB in the browser | none (no chain tx) | 30 min |

## 4. Funding (S1-F)

Plain bank sends from the owner's funding wallet. Not escrow deposits: no subsidy, no escrow fee; only the sender's
network fee.

| To | Amount | Proof after |
|---|---|---|
| `<RELAYER>` | **≈ 15 JUNOX — already done at S1-F0, before S0** (≈ 10 if it still held 5.0) | `set-operator-plan … --to-relayer <RELAYER> …` READY; balance recorded |
| `<JX1_RESOLVER>` | **0.5 JUNOX** (may wait until before Session 3; the send creates the account) | `jx1b_verify account` shows 500,000 ujunox |
| `KA`, `KB` | **5.5 JUNOX each** | balances recorded |
| `K1` / `K2` / `K3` / `K4` | **4.3 / 4.3 / 4.5 / 2.5** (6.6 / 4.4 for K3 / K4 if OD-JX7-1 = run E); may wait until before Session 4 | balances recorded |
| `<JX1_TREASURY>`, `ADMIN` | nothing (the admin holds ≈ 9.67) | treasury balance recorded (the baseline for every later subsidy check) |

## 5. Optional zero-JUNOX wallet smoke (S1-W)

JX-3A §L on a throwaway, **unbound** 2-player money table, as amended by JX-3B (§L.7 M1: a same-wallet proof from a
second standing family now **re-homes** the grant — a new epoch re-adopting the same ticket — instead of answering
`unchanged`). It exercises Keplr's suggest / enable, the link message, wrong account (`wrong-account` blocker),
`wallet-in-use`, Replace, the duplicate-request answers and the recovery / sign-out cases, with **no** transaction.
Session 2 repeats the essential link, rejection and reproof on its own table, so S1-W is optional.

- **Expected:** no Keplr transaction prompt at any point; no JUNOX moves; `gamesDoctor aws wallet-grants <g>` shows
  exactly the linked / replaced / revoked events of the run; `jx3VerifyLink` PASS on each captured link (Session 2 §2B
  gives the command).
- **Cleanup:** leave the table unbound and close it (a host cancel of an unbound table may be refused for 10 minutes
  after a link: expected, W-2).

## 6. Expected state at the end of Session 1

| Layer | Expected |
|---|---|
| Chain | JX-1 at `<JX1>`: code 121, checksum `5ecc3022…09e8`, wasm admin none, `Config.admin` = `ADMIN`, operator `<RELAYER>`, resolver `<JX1_RESOLVER>`, treasury `<JX1_TREASURY>`, signer registry = exactly key 1 (settlement-jx1), `admission_pubkey` = admission-jx1, params JX-1B §F.1, `paused` false, `next_chain_game_id` 1, **balance empty**. The previous contract unchanged (`same` → SAME) |
| Host / server | one host, same digest; `readyz` 200, hold none; `escrow: Juno backend VERIFIED … (contract <JX1>; relayer <RELAYER>; kms keys)`; escrow active, relayer usable; `HostHealthProblems` 0; trust minimums 900 / 3600 / 7200 |
| AWS | ledger keys = the S0 keys + exactly the jx1 pair; all three stacks plan **0**; no ECS resource |
| Frontend | the bundle names `<JX1>` and the checksum, not the old contract; `POST /gs/api/money/config` → `deployment.contract = <JX1>`; the host's real-money stake section is offered |
| Money | `gamesDoctor aws games --money` empty; `RELAYQ#<RELAYER>` Count 0 |

## 7. Balance changes in Session 1

| Account | Δ | Class |
|---|---|---|
| `ADMIN` | − f(instantiate) ≈ 0.0275 JUNOX | burned |
| owner's funding wallet | − the sends − their network fees | moved to owner-held accounts (+ burned fees) |
| `<RELAYER>`, `<JX1_RESOLVER>`, test wallets | + the sends | working capital (owner-held) |
| `<JX1>` | 0 | — |

KMS: two new keys bill $1 per key-month each from GO-1 (`prevent_destroy`; no other key is created in Phase 2:
OD-P2-KR).

## 8. Evidence to save (`<D>\p2-s1\`)

- S0 outputs, including S0.6–S0.9, and the `before\` tfvars copies.
- GO-1: `plan-evidence` + guard ALLOWED + the apply output + `financial_key_arns.json` + `signer-keys.json`.
- GO-2: `init.json`, `jx1-expect.json`, the instantiate tx hash / height / `<JX1>`, `jx1b_verify verify` PASS.
- GO-3: both plans, the app guard ALLOWED, the single-host allowlist review, both applies, the `gs-host` stop / deploy
  outputs, the 5.4a–h results.
- GO-4: the build input (`REACT_APP_ESCROW_DEPLOYMENT`), a grep of the bundle for `<JX1>` and the old contract, the
  `/money/config` response.
- §7: the filled A-1…A-16 table; `current-before.json` / `current-after.json` and `same` → SAME.
- S1-F: every send's tx hash; every balance after.

Record: Project `claude/PHASE2_SESSION1_<date>.md` (the filled tables and the evidence paths).

## 9. PASS / STOP

**PASS** = A-1…A-16 all PASS (`JX1_SINGLE_HOST_SETUP.md` §7) **and** S0.6–S0.9 as expected **and** the relayer READY
at ≈ 15 JUNOX **and** the test wallets funded for Session 2.

**STOP** = any S0 FAIL / NOT EVALUATED / unexpected value; S0.6–S0.9 not as expected; a guard not ALLOWED; a plan with
any change outside its allowlist (an instance replacement in particular); `jx1b_verify verify` FAIL; 5.4a showing
`backend-refused`; any 5.4 row failing (→ `JX1_SINGLE_HOST_SETUP.md` §8 rollback, GO-3 row); GO-4's bundle naming the
old contract.

## 10. Cleanup / end state

Nothing to clean: the JX-1 contract is served, empty and unpaused; the jx1 keys stay (`prevent_destroy`); the old
contract is untouched and unserved, its keys kept. JUNOX: only the instantiate fee and the funding sends' fees are
burned; everything sent stays in owner-held accounts.
