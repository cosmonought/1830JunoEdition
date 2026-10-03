# Phase 2 — live session map (testnet, single host)

Four owner-attended sessions on uni-7 against the JX-1 contract, served by the single host. Each session starts only
when the previous one's exit criteria hold. Every on-chain or AWS step needs the owner's GO; every session ends with
`RELAYQ#<RELAYER>` empty, no open money game it did not intend to leave open, and a Project record.

**The operator-ready procedures are the live-run pack** (2026-10-03): `PHASE2_LIVE_RUN_PACK.md` (index: actors,
read commands, rules, JUNOX capital and burn, the gap register), one sheet per session (`SESSION1_SETUP.md`,
`SESSION2_CORE_GAME.md`, `SESSION3_DISPUTES.md`, `SESSION4_EXITS_ADMIN.md`) and `PHASE2_MASTER_CHECKLIST.md`. This map
is the one-page summary of them.

Decisions: `PHASE2_DECISIONS.md`. Phase numbering: the owner's plan (Phase 1 = migration, Phase 7 = mainnet readiness).

## Before Session 1

Phase 1 closed (`infra/aws/SINGLE_HOST_MIGRATION.md` A–J; COST-2C owner gate PASS; ARM64 live smoke PASS; the Step-16
edge probe and the F5/F6 rulings recorded). Owner confirms **OD-P2-1** (operator = the configured relayer). Wallets and
addresses ready: admin key custody, the JX-1 resolver and treasury addresses, six test wallets (KA, KB, K1–K4).

## Session 1 — setup (≈ 1.5–2 h) — `SESSION1_SETUP.md`

| Step | Procedure | Exit |
|---|---|---|
| S0 + the single-host checks (`money_tables_nonmainnet`, `allowed_origins`; gap G-2) | `SESSION1_SETUP.md` §2 | all as expected, else STOP |
| JX-1: keys (GO-1), instantiate (GO-2), host repoint (GO-3), frontend pin (GO-4) | `docs/phase2/JX1_SINGLE_HOST_SETUP.md` | acceptance A-1…A-16 PASS |
| Funding | relayer to ≈ 15 JUNOX; resolver 0.5 JUNOX; KA / KB 5.5 each; K1–K4 per JX-7A §P (plain bank sends) | `set-operator-plan` READY; balances recorded |
| Wallet link smoke (no deposit) — *optional* | JX-3A §L as amended by JX-3B (OD-JX3-1 re-home) | each test wallet proves control; grants visible in `gamesDoctor aws wallet-grants` |

## Session 2 — core game (≈ 3–4.5 h, dominated by play) — `SESSION2_CORE_GAME.md`

| Step | Procedure | Exit |
|---|---|---|
| Wallet proof (one rejected link, one reproof), CreateGame, a rejected Join prompt and its retry with the admission, freeze, relayer Start + `jx2VerifyTx`, deal checkpoint, round-boundary checkpoints on a `short` ($4,500) table | JX-3A / JX-3B, JX-4B, JX-2B §H, JX-5A | FIN `in-progress`; every checkpoint confirmed; JOURNAL / ROSTER / CHAIN BINDING MATCH; `jx3VerifyLink` and `jx2VerifyTx` PASS |
| Play to GameEnd → terminal seal (2L) → Settle (2L+1) → **exactly one** seat consents → relayer Finalizes at the 900 s window | JX-5A / JX-5B (OD-JX5-2) | SETTLED `finalized`; payouts = preview = the independent computation; FIN `closed`; RELAYQ# empty; gas record |

Rule for every session from here: keep each round under an hour (3600 s liveness window).

## Session 3 — disputes (≈ 3.5–5 h) — `SESSION3_DISPUTES.md`

| Step | Procedure | Exit |
|---|---|---|
| Scenario B (first): Challenge (1 JUNOX bond) → no resolution → at `disputed_at` + 7200 s the other seat's LivenessSettle (resolver timeout) | JX-6A, JX-6B in the image | SETTLED `resolver_timeout_payout`; bond returned; FIN `closed` |
| Scenario A (during B's wait): Settle → a seat Challenges inside the window → the owner-held resolver **Upholds** | JX-6A (+ `JX6A_jx6_resolver_msg.py`) | SETTLED `resolver_uphold`; bond to pool; FIN `closed` |

The two scenarios run on separate fresh tables and overlap in time.

## Session 4 — exits / admin (≈ 4–5 h; ≈ 7 h with JX-7 E) — `SESSION4_EXITS_ADMIN.md`

| Step | Procedure | Exit |
|---|---|---|
| Part 1, in parallel: **fast path** (both seats consent); deadline Cancel by a non-creator; Withdraw with an index shift (+ re-Join, creator Cancel); IN_PROGRESS liveness → promotion → Finalize | `SESSION4_EXITS_ADMIN.md` §2–§6 (JX-5A §H, JX-7A §L B–D) | `consent_completed`; `deadline_cancel`; seats [K1, K4, K3] then `creator_cancel`; `finalized` |
| **Cancel by agreement (consent annul)**: a fresh 2-seat table annulled from IN_PROGRESS by the device consent keys | `docs/phase2/CONSENT_ANNUL_LIVE_PROCEDURE.md` | ANNULLED `annul_by_consent`, 1,950,000 back to each seat, treasury +100,000, contract Δ 0; finished before the pause |
| Part 2: **admin Pause** → deposit and new-table refusals → a creator Cancel that still works → **admin Unpause** | `SESSION4_EXITS_ADMIN.md` §7 (S4-PZ) | the refusals with no prompt and no fee; `creator_cancel` while paused; **`paused` false** |
| JX-7 E (only if OD-JX7-1 = run): SETTLEABLE liveness under the pause | JX-7A §L E | `settleable_timeout_payout`; Unpause done |
| ~~Key rotation~~ | **DEFERRED to Phase 7** (OD-P2-KR) | — |

## Phase 2 exit

`SESSION4_EXITS_ADMIN.md` §8 (X.1–X.12): all four sessions recorded; the JX-1 contract's balance = Σ open pools
(expected 0); `paused` false; the relayer above its reserve; no `held` or `pending` intent; RELAYQ# empty; `terraform
plan` 0 on all three stacks; the gas record complete. Open for Phase 7: the live key-rotation proof (OD-P2-KR) and the
relayer-rotation item beside it.
