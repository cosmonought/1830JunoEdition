# Phase 2 — live session map (testnet, single host)

Four owner-attended sessions on uni-7 against the JX-1 contract, served by the single host. Each session starts only
when the previous one's exit criteria hold. Every on-chain or AWS step needs the owner's GO; every session ends with
`RELAYQ#<RELAYER>` empty, no open money game it did not intend to leave open, and a Project record.

Decisions: `PHASE2_DECISIONS.md`. Phase numbering: the owner's plan (Phase 1 = migration, Phase 7 = mainnet readiness).

## Before Session 1

Phase 1 closed (`infra/aws/SINGLE_HOST_MIGRATION.md` A–J; COST-2C owner gate PASS; ARM64 live smoke PASS). Owner
confirms **OD-P2-1** (operator = the configured relayer). Wallets and addresses ready: admin key custody, the JX-1
resolver and treasury addresses, the test wallets.

## Session 1 — setup (≈ 1.5–2 h)

| Step | Procedure | Exit |
|---|---|---|
| JX-1: keys (GO-1), instantiate (GO-2), host repoint (GO-3), frontend pin (GO-4) | `docs/phase2/JX1_SINGLE_HOST_SETUP.md` | acceptance A-1…A-16 PASS |
| Funding | relayer to ≈ 15 JUNOX; resolver ≈ 0.5 JUNOX; test wallets per JX-7A §P and the annul procedure §3 (plain bank sends) | `set-operator-plan` READY; balances recorded |
| Wallet link smoke (no deposit) | JX-3A §L as amended by JX-3B (OD-JX3-1 re-home) | each test wallet proves control; grants visible in `gamesDoctor aws wallet-grants` |

## Session 2 — core game (≈ 3–4 h, dominated by play)

| Step | Procedure | Exit |
|---|---|---|
| JX-4: a 2-seat money table, `short` ($4,500) variant — link, deposit, Start, deal checkpoint, round-boundary checkpoints | JX-5A (checkpoints), JX-3A (Keplr), evidence `gamesDoctor aws money <id> --chain` (JX-4B) | FIN `in-progress`; every checkpoint confirmed; JOURNAL / ROSTER / CHAIN BINDING MATCH |
| JX-5: play to GameEnd → terminal seal (2L) → Settle (2L+1) → **exactly one** seat consents → relayer Finalizes at the 900 s window | JX-5A / JX-5B (OD-JX5-2) | SETTLED `finalized`; payouts = the certified appraisal; FIN `closed`; RELAYQ# empty |

Rule for every session from here: keep each round under an hour (3600 s liveness window).

## Session 3 — disputes (≈ 3–3.5 h, dominated by the 7200 s timeout)

| Step | Procedure | Exit |
|---|---|---|
| JX-6 Scenario A: Settle → a seat Challenges (1 JUNOX bond) inside the window → the owner-held resolver **Upholds** | JX-6A (+ `JX6A_jx6_resolver_msg.py`), JX-6B in the image | SETTLED via the resolver; bond to pool; FIN `closed` |
| JX-6 Scenario B: Challenge → no resolution → at `disputed_at` + 7200 s a seat's LivenessSettle (resolver timeout) | JX-6A | SETTLED `resolver_timeout_payout`; bond returned; FIN `closed` |

The two scenarios run on separate fresh tables and may overlap in time.

## Session 4 — exits / admin (≈ 2–3 h with JX-7 E, ≈ 1.75 h without)

| Step | Procedure | Exit |
|---|---|---|
| JX-7 A–D: creator Cancel; deadline Cancel by a non-creator; Withdraw with an index shift; IN_PROGRESS liveness → promotion → Finalize | JX-7A §L (parallel plan §M) | each table's chain route and Δs as JX-7A §L |
| **Cancel by agreement (consent annul)**: a fresh 2-seat table annulled from IN_PROGRESS | `docs/phase2/CONSENT_ANNUL_LIVE_PROCEDURE.md` | ANNULLED `annul_by_consent`, 1,950,000 back to each seat, treasury +100,000, contract Δ 0; finished before E's pause |
| JX-7 E (if OD-JX7-1 = run): SETTLEABLE liveness under an **admin Pause / Unpause** — the Phase-2 admin action | JX-7A §L E | `settleable_timeout_payout`; **Unpause done, `paused` false** |
| ~~Key rotation~~ | **DEFERRED to Phase 7** (OD-P2-KR) | — |

## Phase 2 exit

All four sessions recorded; the JX-1 contract's balance = Σ open pools (expected 0); `paused` false; the relayer above
its reserve; no `held` intent; `terraform plan` 0 on all three stacks. Open for Phase 7: the live key-rotation proof
(OD-P2-KR) and the relayer-rotation item beside it.
