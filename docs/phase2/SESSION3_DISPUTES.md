# Phase 2 · Session 3 — disputes (operator sheet)

**Status:** a PROCEDURE, not executed. Do not run any GO step without the owner's GO for it.
**Covers:** a Challenge with the 1 JUNOX bond and the owner-held resolver's **Uphold** (S3-A); a separate game whose
Challenge is closed by a seat's **LivenessSettle at the 7200 s resolver timeout** (S3-B), with the bond returned; the
evidence and balance checks of both.
**Sources:** JX-6A §B–§P (+ `JX6A_jx6_resolver_msg.py`), JX-6B §O (how the server now records a dispute), JX-5A §M
(reaching SETTLEABLE). Conventions and read commands: `PHASE2_LIVE_RUN_PACK.md` §3–§5.

**Tables:** S3-A and S3-B, each exactly like G2 (2 seats, live mode, minimum ante 2 JUNOX, Bank Size short),
`KA` = seat 0, `KB` = seat 1. **Bond** (frozen at Start): max(1,000,000, ⌊1,950,000·5000/10000⌋ = 975,000) =
**1,000,000 ujunox**.
**Order:** play **S3-B first** to its Settle and challenge it (its 7200 s clock then runs), then play S3-A while it
waits. **Duration:** ≈ 3.5–5 h (two games' play, unmeasured; S3-B's 2 h runs during S3-A's play).

## 1. Prerequisites

| # | Prerequisite | Proof |
|---|---|---|
| S3-P1 | Session 2 PASS | the Session-2 record |
| S3-P2 | `set-operator-plan` READY before each table; `RELAYQ#<RELAYER>` Count 0 at the start; `games --money` empty | the reads |
| S3-P3 | `<JX1_RESOLVER>` exists on chain with ≥ 0.5 JUNOX; `q config` → `resolver` = `<JX1_RESOLVER>` (snapshotted into each game at Start) | `jx1b_verify account`; `q config` |
| S3-P4 | The owner can sign as the resolver through `junod` (gap G-4); `JX6A_jx6_resolver_msg.py` SHA-256 recorded; a **second person** is available to check the Resolve JSON (S3-A GO-R) | owner note |
| S3-P5 | `KA`, `KB` each ≥ **5.2 JUNOX free** (two antes + one bond + fees), rebalanced after Session 2 | `jx1b_verify account` |
| S3-P6 | Testers briefed: **nobody approves the payout** on either table (no consent: a Challenge disputes whatever is stored, and a completed consent would pay at once); every round under one hour; the challenger acts with **≥ 60 s of window left** | briefing |
| S3-P7 | No host stop / deploy / restart until §4 | owner hold |
| S3-P8 | Balances at one height before the first deposit: `KA`, `KB`, `<JX1_TREASURY>`, `<JX1>`, `<RELAYER>`, `<JX1_RESOLVER>` | `<D>\p2-s3\balances-before.json` |

## 2. Reaching SETTLEABLE (each table)

Session 2 §2A–§2G exactly (fresh links for the new table, the deposits, Start, play, the automatic Settle, both bands
"Checked on this device: …", the preview = the independent computation), **without** the deliberate rejections and the
reproof, and **without any consent**. Capture the **PRE-CHALLENGE** evidence (JX-6A §P): the Settle tx; the stored
payload (all fields) and `payload_digest` = the settle intent's `settle_digest`; `window_end`; `settlement_preview`;
the balances.

## 3. S3-B — Challenge, then the resolver timeout (run first)

| # | Actor | Action | Expected |
|---|---|---|---|
| B.1 | — | §2 on S3-B (chain game Nᴮ) | SETTLEABLE, `consent_bitmap` 0 |
| B.2 | OPER | immediately before the Challenge: `q game` → `game.bond` = "1000000"; `settlement.payload.seq` / `payload_digest` = the PRE-CHALLENGE values (manual JX-6C check, gap G-13); `window_end` − now ≥ 60 s | as stated; else **do not challenge** (if the window is missed the relayer Finalizes: record the deviation and use a fresh table) |
| B.3 | owner | **GO-B1 (the bond moves)** | — |
| B.4 | **KA** (seat 0) | band → "Dispute" → confirm → Keplr: *Execute Wasm Contract*, contract `<JX1>`, `{"challenge":{"chain_game_id":Nᴮ,"evidence_hash":"<64 hex>"}}`, **funds exactly 1000000ujunox** → approve | `q game`: `disputed`; `dispute.challenger` = KA; `dispute.bond` "1000000"; `disputed_at` = the tx block time; `deadlines.resolver_timeout_at` = `disputed_at` + 7200 s; contract balance = Σ open pools + 1,000,000 |
| B.5 | OPER | `gamesDoctor aws money <gᴮ>` | FIN **`disputed`** (from `settleable` or from `intent-prepared` — JX-6B); `settle_confirmed` may be null; no hold |
| B.6 | OPER | after `window_end`: `q game`; `money` | still `disputed`; **no Finalize landed**; the finalize intent **superseded** ("the escrow is DISPUTED…"), 0 attempts; the band "A player disputed the payout. The resolver decides by HH:MM." |
| B.7 | owner | **The resolver does nothing.** The resolver key is not loaded on any machine for this table | — |
| B.8 | KB (observe only) | before `resolver_timeout_at`: look at the disputed band | "Close through the inactivity exit" is **not offered** (the server offers it from `resolver_timeout_at` by its own clock). It may appear a few seconds before the chain's block time reaches the deadline; then Keplr's simulation refuses (`ResolverTimeoutNotReached`) and **nothing is signed** |
| B.9 | owner | **GO-B2 (the timeout moves funds)** once the wall clock is ≥ `resolver_timeout_at` + ≈ 60 s | — |
| B.10 | **KB** (the other seat) | "Close through the inactivity exit" → confirm → Keplr: `{"liveness_settle":{"chain_game_id":Nᴮ,"checkpoint":null}}`, **no funds** → approve. If the simulation still refuses, nothing was signed: wait a minute and retry | `junod q tx`: code 0; the sender is KB (a seat) |
| B.11 | OPER | `q game`; `money --chain` | `settled`; `outcome.route` **`resolver_timeout_payout`**; `dispute.resolution` `resolver_timeout`; **`bond_returned` 1,000,000** (to KA); `amounts` = `floor(3,900,000·wᵢ/Σw)` over the **stored** weights (= the PRE-CHALLENGE preview); dust to the treasury; pool 0; FIN `closed` with that route; the finalize intent superseded (not confirmed); JOURNAL MATCH |

**S3-B balances** (ujunox, the whole table):

| Account | Δ | Class |
|---|---|---|
| `KA` | −2,000,000 − f(create) − 1,000,000 − f(challenge) **+ 1,000,000** + amount₀ | ante paid out by result; **bond temporarily deposited and returned in full**; fees burned |
| `KB` | −2,000,000 − f(join) − f(liveness_settle) + amount₁ | ante paid out by result; fees burned |
| `<JX1_TREASURY>` | +100,000 + dust | subsidy (owner-held) |
| `<JX1>` | 0 (peak +4,900,000) | temporarily deposited |
| `<JX1_RESOLVER>` | 0 | — |
| `<RELAYER>` | −[f(start) + Σ f(checkpoints) + f(settle)] (no Finalize: superseded unsigned) | burned |

## 4. S3-A — Challenge, then the resolver Upholds

| # | Actor | Action | Expected |
|---|---|---|---|
| A.1 | — | §2 on S3-A (chain game Nᴬ), played while S3-B waits | SETTLEABLE; device check **match** |
| A.2 | OPER | the B.2 checks on Nᴬ | as B.2 |
| A.3 | owner | **GO-A1 (the bond moves)** | — |
| A.4 | **KB** (seat 1) | band → "Dispute" → confirm → the same Keplr prompt shape as B.4 (chain game Nᴬ, funds 1000000ujunox) → approve | `disputed`; challenger KB; bond 1,000,000; `resolver_timeout_at` recorded; contract balance = Σ open pools + Σ disputed bonds |
| A.5 | OPER | as B.5, B.6 | FIN `disputed`; no Finalize; the finalize intent superseded |
| A.6 | OPER | `q game … -o json > <D>\p2-s3\a-game.json`; then `python3 JX6A_jx6_resolver_msg.py --game a-game.json --chain-game-id Nᴬ --contract <JX1> --resolver <JX1_RESOLVER> --outcome uphold --block-time <now, unix seconds> --node <RPC>` | exit 0; the JSON on stdout = `{"resolve":{"chain_game_id":Nᴬ,"outcome":{"uphold":{}}}}`; the report (stderr) shows `evidence_equals_appraisal_state_hash: true` and the remaining seconds to the timeout |
| A.7 | second person | checks the JSON and the printed `junod` line against the report: contract `<JX1>`, chain game Nᴬ, outcome **uphold**, `--from` = the resolver key, no `--amount` | agreed |
| A.8 | owner | **GO-R** — then, as `<JX1_RESOLVER>`, run the printed line: `junod tx wasm execute <JX1> '<the JSON>' --from <RESOLVER_KEY> --chain-id uni-7 --node <RPC> --gas auto --gas-adjustment 1.3 --gas-prices 0.075ujunox -y` | code 0. **If the answer is lost: do not send again** — read `q game` (`dispute.resolution`, `outcome.route`) |
| A.9 | OPER | `q game`; `money --chain` | `settled`; route **`resolver_uphold`**; **`bond_to_pool` 1,000,000**; `distributed` 4,900,000; `amountᵢ = floor(4,900,000·wᵢ/Σw)` (independent computation, integers only); dust to the treasury; pool 0; FIN `closed` with `resolver_uphold`; the finalize intent superseded, not confirmed |

**Resolve is final and cannot be undone.** A wrong outcome is prevented only by A.6–A.8 (the builder's checks, the
second person, GO-R). The resolver never needs AWS or KMS.

**S3-A balances** (ujunox, the whole table):

| Account | Δ | Class |
|---|---|---|
| `KA` | −2,000,000 − f(create) + floor(4,900,000·w₀/Σw) | ante + a share of KB's bond, by the stored weights |
| `KB` | −2,000,000 − f(join) − 1,000,000 − f(challenge) + floor(4,900,000·w₁/Σw) | the **bond is not returned under Uphold**: it joins the pool and comes back only as KB's share (`w₁/Σw`) — redistributed to KA, **not burned** |
| `<JX1_TREASURY>` | +100,000 + dust of 4,900,000 | subsidy (owner-held) |
| `<JX1>` | 0 (peak +4,900,000) | temporarily deposited |
| `<JX1_RESOLVER>` | − f(resolve) (≈ 0.035 JUNOX) | burned |
| `<RELAYER>` | −[f(start) + Σ f(checkpoints) + f(settle)] | burned |

**Optional A2** (not a closure requirement): the same flow with `--outcome replace-canonical` on another table —
route `resolver_replace`, `bond_returned` 1,000,000, payouts = the uncontested preview, `settlement.source`
`resolver_replacement` (JX-6A §O A2). Not planned; it costs a further full game.

## 5. Close

| Check | Expected |
|---|---|
| `gamesDoctor aws money <gᴬ>` / `<gᴮ>` `--chain` | FIN `closed` with `resolver_uphold` / `resolver_timeout_payout`; every intent `confirmed` or `superseded`; none `held` / `pending`; JOURNAL MATCH; exit 0 |
| `RELAYQ#<RELAYER>` | Count 0 |
| `gamesDoctor aws games --money` | empty |
| contract | `<JX1>` balance 0 (no open table) |
| host / relayer | hold none; `HostHealthProblems` 0; no ALARM; `set-operator-plan` READY |

## 6. Evidence to save (`<D>\p2-s3\`)

Per table (JX-6A §P): **PRE-CHALLENGE** (above); **CHALLENGE** — challenger address, `game.bond`, the Keplr prompt
screenshot, the tx hash / height / block time, the `dispute` record, `resolver_timeout_at`, the contract balance;
**RESOLVE** (S3-A) — `game.resolver` = the signing address, the builder report and the exact JSON, the tx hash / height,
`outcome {route, amounts, dust, distributed, bond_returned, bond_to_pool}`; **TIMEOUT** (S3-B) — `disputed_at`,
`resolver_timeout_at`, the triggering tx (sender a seat, its block time ≥ the deadline), `dispute.resolution`;
**FINAL** — every balance delta reconciled to the arithmetic above, FIN `closed` + route, the finalize intent
superseded, `RELAYQ` 0; every `junod q tx` answer added to the gas record (Challenge, LivenessSettle, Resolve rows are
new). Record: Project `claude/PHASE2_SESSION3_<date>.md`.

## 7. PASS / STOP

**PASS** = S3-A SETTLED `resolver_uphold` with `bond_to_pool` 1,000,000 and the payouts of `floor(4,900,000·wᵢ/Σw)`;
S3-B SETTLED `resolver_timeout_payout` with `bond_returned` 1,000,000 to the challenger and the stored-weight payouts;
neither Finalized; FIN `disputed` observed on both before closing; contract 0; queue empty.

**STOP** — the universal list, and:
- a Challenge prompt whose funds ≠ `game.bond`, or whose contract ≠ `<JX1>`;
- the stored settlement changed between PRE-CHALLENGE and the Challenge (G-13);
- the builder refuses (exit 2), or the second person disagrees;
- in S3-B, any Resolve lands (the resolver key was used): record a deviation; the table no longer proves the timeout;
- in S3-B, a LivenessSettle lands before `resolver_timeout_at` (impossible by the contract: if seen, STOP);
- a Finalize lands on a disputed table (impossible by the contract: STOP).

The money in a disputed table is never stuck: any seat can exit at `disputed_at` + 7200 s.

## 8. Cleanup / end state

Both tables terminal; the rooms may be closed; the resolver's key put away. `KA` / `KB`: rebalance before Session 4
(S4-F + S4-AN at once need ≈ 4.3 each). JUNOX: the antes came back as payouts by result; the S3-B bond came back in
full; the S3-A bond was redistributed between the two test wallets by the stored weights; 200,000 subsidy + dust went
to the owner-held treasury; only fees were burned (≈ 1.95 JUNOX).
