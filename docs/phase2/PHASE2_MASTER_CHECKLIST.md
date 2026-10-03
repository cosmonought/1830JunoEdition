# Phase 2 — master checklist

One line per closure requirement, in execution order. Tick a line only when its evidence is saved under
`<D>\p2-…` and named in the session's Project record. A line marked *(optional)* is not a closure requirement.
Procedures: `PHASE2_LIVE_RUN_PACK.md` (index), `SESSION1_SETUP.md` … `SESSION4_EXITS_ADMIN.md`,
`JX1_SINGLE_HOST_SETUP.md`, `CONSENT_ANNUL_LIVE_PROCEDURE.md`.

## 0. Entry (before Session 1)

- [ ] Phase 1 closed: migration A–J complete; step 24 `verify --topology single-host` VERIFIED
- [ ] COST-2C owner gate PASS; ARM64 live smoke PASS (step 12b)
- [ ] Phase-1 Step-16 edge probe: hotfix PASS or owner ruling recorded (gap G-14)
- [ ] Phase-1 F5/F6 (KMS / transactions probe) ruling recorded; KMS Sign latency deferral noted (gap G-8)
- [ ] Phase-1 Step-18 money smoke recorded as deferred to Session 2
- [ ] OD-P2-1 confirmed (JX-1 operator = the configured relayer)
- [ ] OD-P2-KR recorded: live key rotation deferred to Phase 7 (`PHASE2_DECISIONS.md`)
- [ ] OD-JX7-1 (run E or not), OD-JX7-2 (wallet count), OD-JX7-3 (no live D′) recorded or defaulted
- [ ] JX-3A B-6 recorded: Ledger-backed Keplr and Keplr Mobile verified, or declared unsupported for Phase 2
- [ ] `<JX1_RESOLVER>` and `<JX1_TREASURY>` addresses decided (owner-held); KA, KB, K1–K4 addresses recorded
- [ ] Admin key `junod` signing path ready (P-5); resolver key `junod` signing path ready (gap G-4)
- [ ] Tool SHA-256s recorded: `JX1B_jx1b_verify.py`, `JX1B_jx1b_plan_guard.py`, `JX6A_jx6_resolver_msg.py`
- [ ] Frontend publish mechanism for the staging site origin identified (gap G-1, P-8)
- [ ] *(optional)* zero-JUNOX rehearsal: a no-money short-bank 2-player game played to GameEnd; duration and round-boundary count recorded (gap G-10)

## 1. Session 1 — setup

- [ ] S1-F0 relayer topped up to ≈ 15 JUNOX **before S0** (at least the 8.2125 reserve); `set-operator-plan` READY
- [ ] S0 read-only preflight PASS (`JX1_SINGLE_HOST_SETUP.md` §2: S0.1–S0.5)
- [ ] S0.6 single-host `money_tables_nonmainnet = true` (else STOP: instance replacement, gap G-2)
- [ ] S0.7 single-host `allowed_origins` contains exactly `https://play.<domain>` (else STOP)
- [ ] S0.8 app `escrow.network_class` is not mainnet
- [ ] S0.9 single-host `escrow_enabled = true`
- [ ] GO-1: ledger plan guard ALLOWED; exactly two creates (`settlement-jx1`, `admission-jx1`); applied from the saved plan
- [ ] `signer-keys`: relayer address = `<RELAYER>`; both jx1 public keys recorded
- [ ] GO-2: instantiate from code 121, `--no-admin`, no funds; tx hash, height and `<JX1>` recorded
- [ ] `jx1b_verify verify --expect jx1-expect.json` PASS
- [ ] GO-3: app plan guard ALLOWED (`--pools=`); single-host plan = one in-place policy change, allowlist reviewed, no instance replacement
- [ ] GO-3: host stopped `-UntilDeploy`; both saved plans applied; `gs-host deploy` of the same digest READY
- [ ] 5.4a backend VERIFIED on `<JX1>`; no `escrow.backend-refused`
- [ ] 5.4b–5.4d readyz 200, hold none, escrow active, relayer usable, `HostHealthProblems` 0
- [ ] 5.4e–5.4g `verify --topology single-host` and `--part ledger` VERIFIED; `set-operator-plan` ALREADY + READY
- [ ] 5.4h `terraform plan -detailed-exitcode` 0 / 0 / 0
- [ ] GO-4: bundle names `<JX1>` and the checksum, not the old contract; published
- [ ] Browser: `/gs/api/money/config` → `deployment.contract = <JX1>`; the stake section offered
- [ ] A-1 … A-16 all PASS (`JX1_SINGLE_HOST_SETUP.md` §7)
- [ ] Old contract unchanged (`same` → SAME)
- [ ] Ledger holds the S0 keys plus exactly the jx1 pair (5, or 6 with a pre-existing `relayer-r2`)
- [ ] Funding: KA, KB 5.5 each; treasury baseline recorded
- [ ] Funding before Session 3: resolver 0.5 JUNOX, account exists
- [ ] Funding before Session 4: K1 4.3, K2 4.3, K3 4.5, K4 2.5 (K3 6.6, K4 4.4 with E)
- [ ] *(optional)* S1-W zero-JUNOX wallet smoke (JX-3A §L as amended by JX-3B)
- [ ] Session-1 record written to the Project

## 2. Session 2 — core game (G2)

- [ ] Prerequisites S2-P1…P9 recorded (READY, empty queue, funded wallets, briefing, balances before)
- [ ] G2 created: 2 seats, live mode, 2 JUNOX, Bank Size short ($4,500)
- [ ] KA wallet link: message lines exactly as expected; linked, epoch 1
- [ ] KB link message rejected in Keplr: declined, no grant
- [ ] KB linked after the retry
- [ ] KB reproof (same wallet): mode `unchanged`, same epoch and ticket, new proof
- [ ] `wallet-grants` reads saved; both grants STANDING with ADR-036 proofs
- [ ] `jx3VerifyLink` PASS on all three captured links
- [ ] CreateGame (KA): FUNDING, seat 0, pool 1,950,000, treasury +50,000; CHAIN BINDING MATCH
- [ ] KB Join prompt rejected in Keplr: no tx, no balance change
- [ ] KB Join retried with the server's admission: FUNDED, pool 3,900,000, treasury +50,000
- [ ] Start pressed: FROZEN + Start PENDING; Start intent queued
- [ ] Relayer Start confirmed: IN_PROGRESS; Start CONFIRMED; JOURNAL MATCH; ROSTER MATCH; CHAIN BINDING MATCH
- [ ] `--tx-bytes` export + `jx2VerifyTx` PASS on the Start transaction
- [ ] JX-2B evidence rows 1–11 (sequence S0 → S0+1; fee = balance drop; gas / fee within the policy)
- [ ] Deal checkpoint accepted on chain (first live settlement-jx1 signature)
- [ ] One or two round-boundary checkpoints spot-checked (audit → tx → `checkpoints` / `trusted_seq`)
- [ ] Every round under one hour (no LivenessSettle became available)
- [ ] GO-J5-1 before the game-ending move
- [ ] Settle: SETTLEABLE, seq 2L+1, digest = the intent's, `window_end` = Settle + 900 s, `consent_bitmap` 0
- [ ] `settlement_preview` = the independent `floor(pool·wᵢ/Σw)` computation
- [ ] Both devices show "Checked on this device: …" (the automatic re-derivation matches); GO-J5-2
- [ ] Exactly one consent (KB): `consent_bitmap` 2; KA never approved
- [ ] No Finalize before `window_end`; relayer Finalize after it: route `finalized`
- [ ] Payout three-way equality (chain outcome = preview = independent) and the wallet deltas reconciled
- [ ] Contract Δ 0; treasury +100,000 + dust
- [ ] Gas record for every G2 transaction; G-8 timing extract saved
- [ ] Close: FIN `closed`; every intent terminal; RELAYQ 0; `games --money` empty; no hold; READY
- [ ] Phase-1 Step-18 money smoke marked satisfied by G2
- [ ] Session-2 record written to the Project

## 3. Session 3 — disputes (S3-A, S3-B)

- [ ] Prerequisites S3-P1…P8 (resolver funded and on chain, `q config` resolver, builder hashed, second person, KA/KB ≥ 5.2)
- [ ] S3-B reached SETTLEABLE with no consent; PRE-CHALLENGE evidence saved
- [ ] S3-B pre-Keplr check: `game.bond` 1,000,000; stored digest unchanged; ≥ 60 s of window left
- [ ] S3-B Challenge by KA with exactly 1,000,000 ujunox: `disputed`; contract balance = pools + bond
- [ ] S3-B FIN recorded `disputed`; no Finalize; finalize intent superseded
- [ ] S3-B resolver did nothing (key not loaded)
- [ ] S3-B LivenessSettle by KB at ≥ `disputed_at` + 7200 s: route `resolver_timeout_payout`
- [ ] S3-B bond returned 1,000,000 to KA; payouts = stored weights; contract 0; FIN `closed`
- [ ] S3-A reached SETTLEABLE with no consent; PRE-CHALLENGE evidence saved
- [ ] S3-A Challenge by KB with exactly 1,000,000 ujunox: `disputed`; FIN `disputed`; finalize superseded
- [ ] S3-A builder exit 0 (`uphold`); `evidence_equals_appraisal_state_hash` true; second person agreed; GO-R
- [ ] S3-A Resolve Uphold by the resolver: route `resolver_uphold`; `bond_to_pool` 1,000,000; `distributed` 4,900,000
- [ ] S3-A payouts = `floor(4,900,000·wᵢ/Σw)`; dust to the treasury; contract 0; FIN `closed`
- [ ] Balance reconciliation for both tables (incl. resolver fee only)
- [ ] Close: RELAYQ 0; `games --money` empty; every intent terminal; no hold; READY
- [ ] Gas record extended (Challenge, LivenessSettle, Resolve rows)
- [ ] *(optional)* A2 Replace-canonical
- [ ] Session-3 record written to the Project

## 4. Session 4 — exits and admin

- [ ] Prerequisites S4-P1…P8 (empty start, READY, wallets funded, admin `junod` path, briefing, balances before)
- [ ] S4-F: SETTLEABLE; KB approved; GO-J5-3; KA approved → `consent_completed` before `window_end`
- [ ] S4-F: no Finalize tx; finalize intent superseded; payouts = preview = independent
- [ ] S4-AN: `CONSENT_ANNUL_LIVE_PROCEDURE.md` PASS (ANNULLED `annul_by_consent`; 1,950,000 to each; treasury +100,000; contract 0; E-1…E-8 saved)
- [ ] S4-AN: the annul was signed by the device consent keys only (no Keplr prompt)
- [ ] S4-B: refund by K3 at block time ≥ `funding_deadline` and within the following hour: `deadline_cancel`, [1,950,000, 1,950,000]
- [ ] S4-C: K3 Withdraw: seats [K1, K4]; K4 shifted 2 → 1; server claims match the chain
- [ ] S4-C: K3's grant still standing; re-Join with a fresh admission at the last index: seats [K1, K4, K3]
- [ ] S4-C: K1 creator Cancel: `creator_cancel`, [1,950,000 ×3]
- [ ] S4-D: idle past the window; K2 LivenessSettle → SETTLEABLE (`liveness_checkpoint`), no money moved
- [ ] S4-D: relayer Finalize at `window_end`: `finalized`, [1,950,000, 1,950,000]; no settle intent ever existed
- [ ] Part 1 all terminal before the pause (`games --money` empty; RELAYQ 0; contract 0)
- [ ] S4-PZ: one-seat FUNDING table opened by KA
- [ ] GO-PAUSE: `pause` tx code 0; `paused` true; no `backend-refused`
- [ ] Paused: KB's deposit refused before Keplr (no prompt, no balance change)
- [ ] Paused: a new money table refused (`money-games-disabled`, paused reason); none created
- [ ] Paused: the room view shows `escrow.paused` true
- [ ] Paused: KA's Cancel landed (`creator_cancel`) — an exit works while paused
- [ ] GO-UNPAUSE: `unpause` tx code 0; `paused` false
- [ ] After unpause: a money table can be created again (unbound, then closed)
- [ ] *(optional)* S4-E per JX-7A §L E (OD-JX7-1)
- [ ] Session-4 balance summary reconciled
- [ ] Session-4 record written to the Project

## 5. Phase-2 exit

- [ ] X.1 `gamesDoctor aws games --money` empty
- [ ] X.2 `RELAYQ#<RELAYER>` Count 0 (strong, every page)
- [ ] X.3 every Phase-2 table: FIN `closed` / `cancelled`; every intent `confirmed` / `superseded`; none `held` / `pending`; JOURNAL MATCH
- [ ] X.4 no hold anywhere (host and FIN)
- [ ] X.5 `paused` false
- [ ] X.6 contract balance 0 (= Σ open pools + Σ disputed bonds)
- [ ] X.7 relayer READY (above the 8.2125 reserve)
- [ ] X.8 `HostHealthProblems` 0; no ALARM; release digest unchanged since Session 1
- [ ] X.9 `terraform plan` 0 / 0 / 0 (ledger, app, single-host)
- [ ] X.10 treasury = baseline + 950,000 (1,050,000 with E) + Σ dust
- [ ] X.11 the old contract unchanged (`same` → SAME)
- [ ] X.12 complete gas record for the phase; burn reconciled against `PHASE2_LIVE_RUN_PACK.md` §6.3
- [ ] Every route proven live: `finalized`, `consent_completed`, `resolver_uphold`, `resolver_timeout_payout`, `annul_by_consent`, `deadline_cancel`, `creator_cancel` (unpaused and paused), Withdraw, `liveness_checkpoint` promotion
- [ ] Phase-2 closure record written to the Project

## 6. Carried to Phase 7 (not Phase-2 closure items; listed so they are not lost)

- [ ] Live settlement / admission key rotation on testnet with a money game settled under the new key (OD-P2-KR) — **required before any real-value mainnet launch**
- [ ] The KMS budget decision for the extra financial key pair (or a reviewed retirement of the jx1 pair first)
- [ ] Live relayer rotation (L6-13 never ran in this lineage)
- [ ] The gaps G-1 … G-14 that remain open after Phase 2, re-classified for mainnet readiness
