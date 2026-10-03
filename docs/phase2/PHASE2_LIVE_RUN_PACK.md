# Phase 2 — live-run procedure pack (operator index)

**Status:** PREPARATION ONLY. Nothing in this pack has been executed. No AWS, Juno, JUNOX, Keplr or KMS action was taken
to write it.
**Written:** 2026-10-03 on `phase2/live-run-procedure-pack`, on top of `phase2/single-host-live-procedures` (`88e3091`,
itself on the single-host migration candidate `5b4756d`).
**Rule for every step:** do nothing on chain or on AWS without the owner's GO for that step.

> "Phase 2" is the owner's live-execution plan (Phase 1 = the single-host migration, Phase 2 = the testnet live
> sessions, Phase 7 = mainnet readiness). It is not ROADMAP 3.2's numbering.

## 1. The pack

| Document | What it is |
|---|---|
| **this file** | how the sessions fit together; actors and authority; the shared read commands; JUNOX capital and burn; the gap register |
| `SESSION1_SETUP.md` | Session 1: fresh JX-1 escrow, host repoint, frontend pin, funding. Wraps `JX1_SINGLE_HOST_SETUP.md` (the step-by-step setup, unchanged) |
| `SESSION2_CORE_GAME.md` | Session 2: two Keplr players, wallet proof and reproof, CreateGame, Join with admission, a rejected Keplr attempt and retry, freeze, relayer Start, the signer proof, a short game, checkpoints, Settle, one consent, Finalize at 900 s |
| `SESSION3_DISPUTES.md` | Session 3: Challenge with the 1 JUNOX bond, resolver Uphold; a separate resolver-timeout game closed by LivenessSettle at 7200 s |
| `SESSION4_EXITS_ADMIN.md` | Session 4: two-consent fast path, deadline refund, Withdraw with an index shift, IN_PROGRESS liveness + Finalize, cancel by agreement, Pause / refusals / Unpause, final checks |
| `CONSENT_ANNUL_LIVE_PROCEDURE.md` | the cancel-by-agreement test Session 4 runs (unchanged) |
| `PHASE2_MASTER_CHECKLIST.md` | one checkbox per closure requirement, in order |
| `PHASE2_DECISIONS.md`, `PHASE2_LIVE_SESSION_MAP.md` | the decision ledger (key rotation deferred: OD-P2-KR) and the one-page map |

**Source documents this pack cites** (claude.ai Project `claude/…` unless a path is given): JX-1B (topology, params,
`init.json`, `JX1B_jx1b_verify.py`, `JX1B_jx1b_plan_guard.py`), JX-2B (relayer refusals, the signer-proof evidence
list), JX-3A §L (wallet procedure; its M1 is superseded by JX-3B's re-home), JX-4B §O (the evidence reader), JX-5A §M
(checkpoint → Settle → Finalize), JX-5B, JX-6A §O–§P (+ `JX6A_jx6_resolver_msg.py`), JX-6B §O, JX-7A §L–§P, and the
Phase-1 remainder prep (`claude/PHASE1_REMAINDER_PREP_STEPS13_25_5b4756d_2026-10-03.md`, its Phase-2 deferrals).

**What the image already contains** (P5-INT-1 + RECON-1 lineage, verified in the tree at `88e3091`): JX-1K financial key
sets, JX-2A/2B (`frontend/scripts/jx2VerifyTx.js`), JX-3B (`gamesDoctor aws wallet-grants`, `jx3VerifyLink`), JX-4B
(`gamesDoctor aws money`), JX-4C (the operator's evidence reads), JX-5B (Settle retried by the 5-minute sweep), JX-6B
(DISPUTED recorded from `intent-prepared`; a Finalize is "done" only for route `finalized`). Rules **12**; settlement
certified `[10, 11, 12]`; escrow 2.0.0.

## 2. The four sessions at a glance

| Session | Purpose | Tables | Wall clock (estimate) | Peak JUNOX locked in escrow | JUNOX burned (fees, estimate) |
|---|---|---|---|---|---|
| 1 Setup | JX-1 contract, host repoint, frontend pin, funding | none | 1.5–2 h | 0 | ≈ 0.03 (instantiate) |
| 2 Core game | the ordinary money path end to end | G2 | 3–4.5 h (dominated by play) | 3.9 | ≈ 1.0 |
| 3 Disputes | Challenge → resolver Uphold; Challenge → resolver timeout | S3-A, S3-B | 3.5–5 h (two games + the 2 h timeout) | 9.8 (two pools + two bonds) | ≈ 1.95 |
| 4 Exits / admin | fast path, cancels, withdraw, liveness, annul, pause | S4-F, S4-B, S4-C, S4-D, S4-AN, S4-PZ (+ S4-E optional) | 4–5 h (≈ 7 h with E) | ≈ 21.5 | ≈ 1.72 (≈ 1.96 with E) |

**Play duration is not measured.** No short-bank ($4,500) 2-player game has been timed (gap G-10). The optional
zero-JUNOX rehearsal (`PHASE2_MASTER_CHECKLIST.md` §0) measures it and the number of round boundaries (checkpoints).

## 3. Actors, keys and authority

| Name used here | Who / what | Signs with | Acts in |
|---|---|---|---|
| `ADMIN` | `Config.admin` `juno17me9g07q9kaxqs9dgk4l89klxasxm78r0qlrxj`, owner custody, immutable for life | the owner's admin key through the owner's `junod` signing path (JX-1B §G.2; precondition P-5) | instantiate (S1), Pause / Unpause (S4) |
| `<RELAYER>` | the contract's `operator` = the host's configured relayer (OD-P2-1; expected r1) | KMS `signing_keys.relayer` (digest-only Sign) | Start, Checkpoint, Settle, Consent relay, Finalize, AnnulByConsent relay — automatic |
| settlement-jx1 | signer key id 1 on JX-1 | KMS, `ECDSA_SHA_256` / `DIGEST` | every checkpoint and settlement payload — automatic |
| admission-jx1 | `Config.admission_pubkey` | KMS | every Join admission — automatic, per request |
| `<JX1_RESOLVER>` | owner-held resolver wallet (snapshotted per game at Start) | the owner's resolver key, `junod tx wasm execute` (the command `JX6A_jx6_resolver_msg.py` prints) | Resolve (S3-A only) |
| `<JX1_TREASURY>` | owner-held dedicated treasury | never signs | receives subsidies and dust |
| `KA`, `KB` | the two core players, each a hosted profile in **its own browser profile** with **its own Keplr account** | Keplr (deposits, Challenge, LivenessSettle, Cancel) and the browser consent key (IndexedDB; consents and annul) | S2, S3, S4-F, S4-AN, S4-PZ |
| `K1`–`K4` | the JX-7 exit-path wallets (JX-7A §L), each in its own browser profile | Keplr | S4-B, S4-C, S4-D (and S4-E) |
| `OPER`, `BOOT`, `APP-ADMIN`, `LEDGER-ADMIN`, host-deploy | the AWS principals of the migration runbook | AWS CLI v2 | reads in every session; applies and host stop/deploy only in S1 GO-1 / GO-3 |

The server signs **no** player message. The browser signs only messages it builds from its own pinned deployment
(canonical context §D 5a). The resolver and the admin never sign through the app.

## 4. Shared read-only commands (all already defined in the cited documents)

Run `junod` lines in Git Bash, WSL or PowerShell 7.3+ (Windows PowerShell 5.1 mangles inline JSON). Run the server
tools from `server\` after `npm run build`, as `node dist/server/src/tools/<tool>.js …` (PowerShell's `npm.ps1` swallows
`--`).

```
# chain (JX-5A §M conventions)
q() { junod q wasm contract-state smart "$JX1" "$1" --node "$RPC" -o json; }
q '{"config":{}}'                                   # paused, operator, resolver, treasury, params
q '{"game":{"chain_game_id":N}}'                    # state, seats, pool, bond, settlement, dispute, outcome, deadlines
q '{"checkpoints":{"chain_game_id":N}}'             # stored checkpoints, liveness_candidate_seq
q '{"settlement_preview":{"chain_game_id":N}}'      # exact per-seat payouts and dust
q '{"seats":{"chain_game_id":N}}'                   # consent keys, consented flags
junod q tx <HASH> --node "$RPC" -o json             # code, height, timestamp, gas_wanted, gas_used, fee, wasm + bank events
python3 JX1B_jx1b_verify.py account --address <ADDR>            # one balance (or: junod q bank balances <ADDR> --node "$RPC")

# server evidence (OPER; read-only; JX-4B / JX-3B)
node dist/server/src/tools/gamesDoctor.js aws status --aws-config <P1ARN>
node dist/server/src/tools/gamesDoctor.js aws games --money --aws-config <P1ARN>
node dist/server/src/tools/gamesDoctor.js aws wallet-grants <g_…> --aws-config <P1ARN> --json
node dist/server/src/tools/gamesDoctor.js aws money <g_…> --aws-config <P1ARN> --chain          # exit 0 = every check PASS / N/A
node dist/server/src/tools/gamesDoctor.js aws money <g_…> --aws-config <P1ARN> --json
node dist/server/src/tools/gamesDoctor.js aws money <g_…> --aws-config <P1ARN> --tx-bytes <intent_id>   # stdout = the exact TxRaw

# relay queue, strong, every page (JX1_SINGLE_HOST_SETUP.md S0.3)
aws dynamodb query --table-name gs-staging-game-g1 --key-condition-expression "pk = :p" \
  --expression-attribute-values '{":p":{"S":"RELAYQ#<RELAYER>"}}' --consistent-read --select COUNT

# host and relayer (host-deploy; BOOT)
.\infra\aws\single-host\gs-host.ps1 -Command status -InstanceId <i-…>          # readyz 200, hold none
node dist/server/src/tools/awsDeploy.js set-operator-plan --runtime-parameter <P1ARN> --environment staging \
  --to-relayer <RELAYER> --to-relayer-key <signing_keys.relayer>             # READY before every money table
```

Every `junod q tx` answer is saved; the **gas record** of the phase is built from these answers (§6.3).

## 5. Rules for every session

1. **One GO per mutating step.** A GO covers one named step only.
2. **One wallet transaction at a time per wallet** (the account sequence). Two tables may share a wallet; two pending
   transactions from it may not.
3. **Every round under one hour** while a JX-1 money table is IN_PROGRESS (liveness window 3600 s; JX-7H). Nobody
   presses "Close and pay from the last recorded round" unless the procedure says so.
4. **No host stop, deploy or restart** while a money table is open, except Session 1 GO-3 (no table exists) — an open
   consent / annul collection is memory-only, and a restart changes which checks have run.
5. **Before every new money table:** `set-operator-plan` READY; `RELAYQ#<RELAYER>` holds only the entries of tables
   still open on purpose; `gamesDoctor aws games --money` lists only those tables; `gs-host status` hold none.
6. **Evidence is captured, never edited.** Each session writes `<D>\p2-s<n>\…`; a re-run gets a new file name.
7. **Universal STOP** (capture everything, take no further mutating step, ask the owner): any HOLD (FIN `held`,
   `settlement.held`, host `hold`); `chain-inconsistent`; `escrow.backend-refused`; `HostHealthProblems` > 0; a Keplr
   prompt whose chain, contract, message or funds is not exactly the expected one; a wallet-link text whose `Site`,
   `Network` or `Escrow contract` line is not exactly the expected one; a contract balance that is not Σ open pools + Σ
   disputed bonds; any outcome amount that differs from the independent computation; a relayer CheckTx refusal other
   than `sdk/5` / `sdk/13` (those two follow JX-2B abort rule 6: fund or re-tune, then restart the host — only between
   tables).

## 6. JUNOX: working capital, locking and burn

### 6.1 What happens to JUNOX

| Class | Meaning | Where it shows up |
|---|---|---|
| **Burned** | network fees. Spent for good. | every transaction's fee (players, relayer, admin, resolver) |
| **Subsidy** | 2.5 % (`subsidy_bps` 250) of every deposit: 50,000 ujunox per 2 JUNOX deposit. Never refunded to the player, but it lands in the **owner-held** `<JX1_TREASURY>`, so it is not destroyed. Payout dust goes there too. | treasury balance |
| **Temporarily deposited** | the net ante (1,950,000 per deposit) locked in the contract and returned by a refund, an annul or a payout | contract balance, then the players' wallets |
| **Redistributed** | a payout splits the pool by the game's result: one test wallet gains what the other loses (both owner-held). Under Uphold the challenger's 1 JUNOX bond joins the pool and is split the same way. | player balances |
| **Bond, returned** | the 1 JUNOX challenge bond comes back in full on resolver timeout (and on Replace / Annul) | challenger balance |

### 6.2 Fee basis (estimates; the live gas record replaces them)

From JX-7A §P, JX-5A §L, JX-6A §N and the canonical gas table (+160,541 measured real-tx overhead, ×1.3 / ×1.4 at
0.075 ujunox): CreateGame ≈ 29,600; Join ≈ 30,900; Cancel 29,700–35,000; Withdraw ≈ 30,700; LivenessSettle
32,000–38,000; Challenge ≈ 25,000; relayer Start ≈ 28,100, Checkpoint ≈ 36,100, Settle ≈ 30,000, Consent ≈ 36,000
(completing ≈ 45,200), Finalize ≈ 45,100 (≈ 32,900 after a liveness promotion), annul ≈ 30,000; Resolve ≈ 35,000
(≤ 57,000); instantiate ≈ 27,500; Pause / Unpause ≈ 24,000 each (gas-table rows 85.6k + overhead). A full short game is
assumed to post ≈ 21 checkpoints (JX-5A: "about 20 boundary checkpoints after the deal"); 30 would add ≈ 0.36 JUNOX per
full game. A Keplr rejection or a simulation refusal costs nothing.

### 6.3 Burn estimate (network fees)

| Session | Relayer | Players | Admin / resolver | Total |
|---|---|---|---|---|
| 1 | — | — | 0.028 | **≈ 0.03** |
| 2 (G2, one consent + Finalize) | 0.93 | 0.06 | — | **≈ 1.0** |
| 3 (S3-A Uphold, S3-B timeout) | 1.70 | 0.21 | 0.035 | **≈ 1.95** |
| 4 (F, B, C, D, AN, PZ) | 1.12 | 0.55 | 0.048 | **≈ 1.72** |
| 4, optional E (own Pause / Unpause pair) | +0.06 | +0.13 | +0.048 | +0.24 |
| **Phase 2** | **≈ 3.76** | **≈ 0.82** | **≈ 0.11** | **≈ 4.7 JUNOX** (≈ 5.4 with a 15 % retry margin; ≈ 4.9 / 5.7 with E) |

**Subsidy to the owner-held treasury:** 19 deposits × 50,000 = **0.95 JUNOX** (21 deposits, 1.05 JUNOX, with E), plus
dust (a few ujunox).

### 6.4 Working capital (what must be on hand; almost all of it comes back)

| Account | Fund to | When | Why |
|---|---|---|---|
| `<RELAYER>` | **≈ 15 JUNOX** (r1 last read 5.0: a plain bank send of ≈ 10) | Session 1, **before S0** (S1-F0: S0's `set-operator-plan` must already print READY) | the derived reserve 8.2125 (READY before every table) + ≈ 3.8 phase spend + margin; it ends ≈ 11 |
| `ADMIN` | ≥ 0.2 (holds ≈ 9.67: no top-up) | before Session 1 | instantiate + Pause + Unpause |
| `<JX1_RESOLVER>` | **0.5 JUNOX** (the bank send creates the account) | before Session 3 | ≤ 2 Resolve transactions; ≈ 6× headroom (JX-6A §D) |
| `<JX1_TREASURY>` | 0 | — | only receives |
| `KA`, `KB` | **5.5 JUNOX each** | before Session 2 (rebalance before each table) | S3 runs two disputes at once: 2 × 2.0 antes + 1.0 bond + fees ≈ 5.2; covers S4-F + S4-AN at once (4.3) |
| `K1` / `K2` / `K3` / `K4` | **4.3 / 4.3 / 4.5 / 2.5** (with E: K3 6.6, K4 4.4) | before Session 4 | JX-7A §P, including peak locked antes |
| **Total** | **≈ 42.1 JUNOX** (≈ 46.1 with E), of which **≈ 37.1 is new money** (relayer +10, resolver +0.5, test wallets 26.6) | | |

Every funding move is a **plain bank send** between owner-held accounts (no escrow deposit, so no escrow fee). **Game
results move value between KA and KB** (and Uphold moves part of the bond): read each wallet's free balance before every
table and rebalance by a plain send if it is below the table's need (ante + fees, + 1.0 for a challenger). Peak value
locked in the contract at once is ≈ 21.5 JUNOX (Session 4 part 1: F, AN, B, C, D).

## 7. Gap register (procedure gaps; none blocks a session as written)

| # | Gap | Where it bites | What this pack does |
|---|---|---|---|
| **G-1** | The frontend publish mechanism for the staging site origin is outside the repository (JX-1 setup P-8, GO-4) | S1 GO-4 | names the build input and the checks; the publish step itself is the owner's own mechanism |
| **G-2** | The single host's `money_tables_nonmainnet` and `allowed_origins` are rendered into the instance's user data with `user_data_replace_on_change = true` (`modules/single-host/host.tf`, `locals.tf`). If the live tfvars have money tables off, or the play origin missing, fixing it **replaces the instance** — out of Phase-2 scope | S1 S0, before GO-1 | a read-only check at S0 (`SESSION1_SETUP.md` §2): both must already be right, else STOP and hand back to the owner |
| **G-3** | `JX1B_jx1b_plan_guard.py` has no `single-host` mode | S1 GO-3 | the written allowlist of `JX1_SINGLE_HOST_SETUP.md` §5.2 (unchanged) |
| **G-4** | No repository tool signs admin Pause / Unpause or the resolver's Resolve. `l613-admin.cjs` (Project) signs `set_operator` only. The documented route is `junod tx wasm execute <JX1> '<json>' --from <KEY> --chain-id uni-7 --node <RPC> --gas auto --gas-adjustment 1.3 --gas-prices 0.075ujunox -y` (JX-6A's builder prints it; JX-1B §G.2's instantiate uses the same signing path) | S4 Pause / Unpause; S3-A Resolve | uses that route and makes the owner's `junod` custody of the admin and resolver keys a precondition (P-5 for the admin is already exercised by GO-2) |
| **G-5** | No committed offline verifier for a checkpoint / settlement signature (JX-5C; JX-5A's `jx5_verify_evidence.js` was scratch only) | S2 checkpoint and Settle evidence | substitutes, all existing: the contract itself verifies the KMS signature on acceptance; each device's automatic re-derivation (the band's "Checked on this device: …" line); `settlement_preview` against the independent `floor(pool·wᵢ/Σw)` |
| **G-6** | No JX-7B snapshot / diff helper (game + seats + checkpoints + preview + balances at one height; the contract-balance invariant) | every balance check | the manual `junod` reads of §4; balances read back-to-back and labelled with the height of the next `junod q tx` |
| **G-7** | No committed reader for the ledger's `SETTLE#` reservations, and no named role for CloudTrail `kms:Sign` reads | S2 KMS-signature evidence (JX-5A step 3) | marked OPTIONAL evidence; the required proof is the chain's acceptance plus `JOURNAL MATCH` for the relayer's own transactions |
| **G-8** | Phase 1 deferred "KMS Sign latency" (F5/F6, if the owner so ruled); no tool measures it | S2 | records what exists: the relayer's `chain.signed` audit times against the intent's `created` time in `gamesDoctor aws money`; anything finer is NOT EVALUATED |
| **G-9** | The JX-4A report (the original JX-4 live procedure) is not in the Project | S2 CreateGame / Join / Start | S2 is assembled from ESCROW-4, JX-3A §L, JX-4B §O, JX-2B §H, the annul procedure §4 and the source's own UI texts |
| **G-10** | A short-bank 2-player game's duration and boundary count are unmeasured | S2, S3, S4-F time boxes and relayer fees | optional zero-JUNOX rehearsal (checklist §0) |
| **G-11** | No documented zero-fee command proves a **chain-level** refusal while paused (the server and the browser refuse first) | S4-PZ | the refusals are proven at the server and browser layers; the chain-level side is proven positively (an exit still works while paused) and, only if E is run, by the relayer's Finalize waiting with 0 attempts |
| **G-12** | JX-7D: a bound, unfrozen table whose room has expired does not observe a later chain Cancel (FIN stays `funding`; no funds at risk) | S4-B | the deadline Cancel is made within the hour after the deadline (JX-7A rule) |
| **G-13** | JX-6C: the browser does not bind a Challenge to the reviewed settlement digest | S3 | the manual pre-Keplr check of JX-6A §B (read `game.bond`, `settlement.payload.payload_digest` / `seq`, window ≥ 60 s) |
| **G-14** | Phase-1 defect 1: the edge probe (`stage-probe edge`) cannot run on the single host | every browser session | a Phase-1 closure item (hotfix or owner ruling); Session 1 requires it recorded |

## 8. Owner decisions still open

| # | Decision | Default in this pack |
|---|---|---|
| OD-P2-1 | JX-1 operator = the configured relayer (expected r1) — confirm before GO-2 | assumed confirmed |
| OD-JX7-1 | Run E (SETTLEABLE liveness under the admin pause; +≈ 75–170 min, needs a window with no other live table) | **not run**; Session 4's Pause window (S4-PZ) proves pause / refusal / unpause without it |
| OD-JX7-2 | Four exit wallets K1–K4 (reused across concurrent tables) or six | four, plus KA / KB |
| OD-JX7-3 | No live D′ (liveness refund with no checkpoint) | not run |
| JX-3A B-6 | Ledger-backed Keplr and Keplr Mobile: verify, or declare unsupported for Phase 2 | declared unsupported for Phase 2 (desktop Keplr extension only) |
| Phase-1 F5/F6 | KMS Sign latency ruling | G-8 |
| S4-PZ deposit | S4-PZ funds a table before the pause so an exit can be proven while paused (costs 0.05 subsidy + ≈ 0.06 fees) | run |

## 9. Deferred to Phase 7 (recorded, not run here)

- **Live key rotation (OD-P2-KR):** settlement / admission rotation on a live contract (`AddSignerKey` → key id 2,
  `RetireSignerKey`, `SetAdmissionKey`, each in a stopped-host window) with a money game settled under the new key, and
  the KMS budget decision that allows the extra pair. **It must be proven live before any real-value mainnet launch.**
- **Relayer rotation** (L6-13 never ran in this lineage): the same Phase-7 readiness list.
