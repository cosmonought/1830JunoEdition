# Phase 2 · Session 2 — the core money game (operator sheet)

**Status:** a PROCEDURE, not executed. Do not run any GO step without the owner's GO for it.
**Covers:** two real Keplr players; wallet proof and reproof; CreateGame; Join with the server's admission; a rejected
Keplr attempt and its retry; the roster freeze; the relayer's Start; the `jx2VerifyTx` signer proof; the JX-4B evidence;
a short ($4,500 bank) game; checkpoints; Settle; **exactly one** consent; Finalize at the 900 s window; the payout
compared with an independent computation; the gas record. It also closes Phase 1's deferred Step-18 money smoke.

**Sources:** ESCROW-4 (the path), JX-3A §L + JX-3B (wallet), JX-4B §O (evidence), JX-2B §H (signer proof, abort rule 6),
JX-5A §M / §N (checkpoint → Finalize; OD-JX5-1 short bank; OD-JX5-2 one consent), JX-5B (Settle retry), the annul
procedure §4 steps 1–3 (the deposit / Start shape). The original JX-4A procedure is not in the Project (gap G-9).
Conventions and read commands: `PHASE2_LIVE_RUN_PACK.md` §3–§5.

**Table G2:** 2 seats, **live** pace (challenge window 900 s, funding period 3600 s), **minimum ante 2 JUNOX**
(2,000,000 ujunox), **Bank Size: short ($4,500)**. `KA` hosts (chain seat 0), `KB` joins (chain seat 1).
**Duration:** ≈ 3–4.5 h: setup ≈ 45 min, play (unmeasured, gap G-10), settlement ≈ 25 min, evidence ≈ 20 min.

## 1. Prerequisites

| # | Prerequisite | Proof |
|---|---|---|
| S2-P1 | Session 1 PASS | the Session-1 record |
| S2-P2 | `set-operator-plan … --to-relayer <RELAYER> …` **READY**; relayer ≈ 15 JUNOX | the command's output |
| S2-P3 | `gamesDoctor aws games --money` empty; `RELAYQ#<RELAYER>` Count 0; `gs-host status` readyz 200, hold none; no ALARM | the reads |
| S2-P4 | `KA`, `KB` each ≥ **3.2 JUNOX free** (2.0 ante + fees + a 1.0 bond in reserve, in case the owner rules a Challenge at 2G.6); each in its **own browser profile** with the **desktop Keplr extension**, on the account recorded for it | `jx1b_verify account` |
| S2-P5 | Both players signed in on `https://play.<domain>` with profiled hosted accounts; each has its recovery key at hand ("Confirm it's you") | the lobby |
| S2-P6 | Both browsers record the network (DevTools → Network, "Preserve log") to capture `/gs/api/money/*` bodies | — |
| S2-P7 | Testers briefed: **every round under one hour**; nobody presses "Release payout" or "Close and pay from the last recorded round"; **seat 0 (KA) never approves the payout** | briefing |
| S2-P8 | No host stop / deploy / restart until §2L | owner hold on `gs-host` |
| S2-P9 | Read before the first deposit (one height): balances of `KA`, `KB`, `<JX1_TREASURY>`, `<JX1>`, `<RELAYER>`; the relayer's `account_number` / `sequence` (`GET /cosmos/auth/v1beta1/accounts/<RELAYER>`, JX-2B evidence #1) | `<D>\p2-s2\balances-before.json` |

## 2. Steps

### 2A — the table and the seats (no JUNOX)

| # | Actor | Action | Expected |
|---|---|---|---|
| 2A.1 | KA | Host setup: **Bank Size = short ($4,500)**; exactly **2** players; real-money stake **2 JUNOX**; play mode **live** (not async: the escrow's pace is the table's mode, so live = challenge window 900 s, funding 3600 s). Create | server: a money table, `record_schema 2`, `host_undo: "none"`; record `game_id` = `<g>` |
| 2A.2 | KB | Take the seat (join code) | KB seated; both money panels show "Connect wallet" |

### 2B — wallet proof and reproof (no JUNOX; no Keplr *transaction* prompt may appear)

| # | Actor | Action | Expected |
|---|---|---|---|
| 2B.1 | KA | Connect (Keplr's uni-7 suggest / enable) → "Confirm it's you" (recovery key) → Link → **read the message**: 10 lines, `Site` = this origin, `Network: uni-7`, `Escrow contract: <JX1>`, `Game: <g>`, `Seat: p-…`, `Wallet:` KA → approve | "Wallet linked"; audit `money.wallet-linked {epoch 1, relink false}`; host panel offers "Open the table on Juno" (do not press yet) |
| 2B.2 | KB | Connect → Confirm → Link → **Reject** in Keplr | "You declined the link message. Your wallet isn't linked."; no grant written |
| 2B.3 | KB | Link again → approve | KB linked, epoch 1 |
| 2B.4 | KB | **Reproof:** "Change wallet" → the **same** Keplr account → Confirm (if > 5 min) → Link → approve | the link answers mode `unchanged`: the **same epoch and ticket**, a new proof (`verified_at`, `proof_hash`) |
| 2B.5 | OPER | `gamesDoctor aws wallet-grants <g> … --json` (after 2B.1, after 2B.3, after 2B.4) | both grants STANDING, `proof.kind adr036`, `proof.wallet` = the seat's wallet; KB's epoch unchanged by 2B.4, its `proof_hash` changed |
| 2B.6 | OPER (offline) | for each captured link (KA, KB first, KB reproof): `node dist/server/src/tools/jx3VerifyLink.js --challenge <wallet-challenge response> --link <wallet-link request> --grant <wallet-grants json> --expect-site https://play.<domain> --expect-network uni-7 --expect-contract <JX1> --expect-game <g> --expect-seat <p-…> --expect-wallet <juno1…>` | **PASS** ×3 |

The same-wallet proof from **another** browser profile of the same player (a new session family) would re-home the grant
(JX-3B, OD-JX3-1). It is source-tested and **not** part of this session: the deposit's consent key must live on the
device that will sign, so the reproof stays on the seat's own device.

### 2C — CreateGame (KA, the first JUNOX)

| # | Actor | Action | Expected |
|---|---|---|---|
| 2C.1 | owner | **GO-S2-1** | — |
| 2C.2 | KA | "Open the table on Juno — deposit 2 JUNOX" → review → "Approve in Keplr" → Keplr: *Execute Wasm Contract*, contract `<JX1>`, message `create_game` (max players 2, live, rules 12, the variants digest, this seat's consent key and join ticket), **funds exactly 2000000ujunox**, fee ≈ 0.03 JUNOX → approve | chain: game N **FUNDING**, seat 0 = KA, `net_deposit` 1,950,000, pool 1,950,000; **50,000 to `<JX1_TREASURY>` in the same tx** |
| 2C.3 | OPER | `gamesDoctor aws money <g> --chain` | FIN `funding`, `chain_game_id` N bound; check 2 PASS (not frozen); **CHAIN BINDING MATCH**; ROSTER N/A; contract balance ≥ pool |

### 2D — Join with admission; a rejected attempt; the retry (KB)

| # | Actor | Action | Expected |
|---|---|---|---|
| 2D.1 | owner | **GO-S2-2** | — |
| 2D.2 | KB | "Deposit 2 JUNOX" → review → "Approve in Keplr" (the browser first obtains the server's admission) → Keplr shows `join` (chain game N, consent key, join ticket, `admission {expires_at, signature}`), **funds 2000000ujunox** → **Reject** | "You declined in Keplr. No JUNO was sent."; **no transaction**; KB's balance unchanged; chain still FUNDING with 1 seat |
| 2D.3 | KB | "Deposit 2 JUNOX" again → check the prompt again → approve | chain **FUNDED**, seat 1 = KB, pool **3,900,000**; another 50,000 to the treasury |
| 2D.4 | OPER | `wallet-grants` + `money --chain` | KB's grant carries `admitted_until`; each chain seat's (wallet, ticket) is a standing grant; CHAIN BINDING MATCH |

### 2E — freeze, relayer Start, the signer proof

| # | Actor | Action | Expected |
|---|---|---|---|
| 2E.1 | OPER | `set-operator-plan` READY again; record the relayer's `sequence` S0 (as S2-P9) | READY |
| 2E.2 | owner | **GO-S2-3** | — |
| 2E.3 | KA | "Start game" | server: the reversible freeze. `gamesDoctor aws money <g>`: **FROZEN + Start PENDING (provisional)**; checks 2–6 PASS; the Start intent queued (`RELAYQ` ok); record the full `roster_hash` and `expected_domain` |
| 2E.4 | relayer | (automatic) Start | chain **IN_PROGRESS**; FIN `in-progress`; `money`: **Start CONFIRMED at height H (permanent)**; the Start intent `confirmed` and out of the queue; **JOURNAL MATCH**; `--chain`: **ROSTER MATCH** + **CHAIN BINDING MATCH** (exit 0) |
| 2E.5 | OPER (offline) | from the **repository root** in Git Bash or PowerShell 7 (Windows PowerShell 5.1's `>` writes UTF-16 and the verifier then fails falsely; there use `… \| Set-Content -Encoding ascii <file>`): `node server/dist/server/src/tools/gamesDoctor.js aws money <g> --aws-config <P1ARN> --tx-bytes <start intent id> > <D>/p2-s2/start.b64`, then run the `node frontend/scripts/jx2VerifyTx.js …` line it prints on stderr, with `--pubkey` from `awsDeploy signer-keys` (`relayer`), `--sequence` S0 and the attempt's fee and gas limit | **PASS** (CosmJS + OpenSSL: hash, one `MsgExecuteContract {start}` to `<JX1>`, no funds, signer = the relayer key, low-s signature over uni-7) |
| 2E.6 | OPER | JX-2B §H evidence rows 1–11 around this one transaction | the account sequence is now S0 + 1; the relayer's balance fell by exactly the fee; `gas = max(80000, ⌈sim·13/10⌉) ≤ 1,500,000`, `fee = ⌈gas·75/1000⌉ ≤ 112,500` |
| 2E.7 | relayer | (automatic) the **deal checkpoint** | `q checkpoints`: key 1, `seq = 2·log_len` at the deal; FIN `checkpoint_confirmed` — the first live settlement-jx1 signature the contract accepted |

### 2F — the game and its checkpoints

| # | Actor | Action | Expected |
|---|---|---|---|
| 2F.1 | KA, KB | Play the short game. Every round under one hour | a checkpoint at every round boundary (auction → SR1, SR → OR, OR → OR, …) |
| 2F.2 | OPER | Spot-check one or two boundaries (JX-5A §M steps 4–5): the audits `checkpoint.intent` (seq, log_len, round key) → `chain.signed` → `chain.intent-confirmed`; `q checkpoints` (`payload_digest` = the intent's settle digest); `q game` (`trusted_seq` = that seq, `last_activity` = that block's time); `junod q tx` (code 0, `action=checkpoint`, `gas_used`) | as described |
| 2F.3 | owner | **GO-J5-1** before the move that ends the game: from here the Settle is automatic and Finalize follows 900 s later unless a seat challenges | — |

### 2G — Settle, and the payout check

| # | Actor | Action | Expected |
|---|---|---|---|
| 2G.1 | server, relayer | (automatic) seal → terminal checkpoint (seq 2L) → Settle (seq 2L+1) | audits `settlement.sealed` → `settlement.intent-prepared` (L, log hash, appraisal hash, rules 12) → `settlement.intent-submitted`; FIN `intent-prepared` → `settleable`. A transient KMS / store failure is retried by the next 5-minute sweep (JX-5B): wait, do not restart |
| 2G.2 | OPER | `q game` | `settleable`; `settlement.source terminal_payload`; `payload.seq` 2L+1; `payload_digest` = the intent's settle digest; `deadlines.challenge_window_end` = the Settle block time + 900 s; `consent_bitmap` 0 |
| 2G.3 | OPER | `q settlement_preview`; read `settlement.payload.settlement_weights` w₀, w₁ and `pool` P (3,900,000) | preview payouts and dust |
| 2G.4 | OPER | **Independent computation**, integers only: `amountᵢ = floor(P·wᵢ / (w₀+w₁))`, `dust = P − Σ amountᵢ` | equal to the preview, field for field |
| 2G.5 | KA, KB | reload the settlement band on each device (the device re-derives the recorded settlement by itself; there is no button) | both bands say "Checked on this device: Juno's recorded result covers exactly this game's moves."; KB is offered "Approve payout now" |
| 2G.6 | owner | **GO-J5-2**: 2G.2–2G.5 PASS → continue. **Any difference → do not consent, and rule before `window_end`** (the band shows the release time): Finalize is automatic, so "act no further" lets the relayer pay the suspect result. Either a seat **Challenges** (Session 3 B.2–B.6 shape, 1 JUNOX bond: S2-P4 keeps it free) or the owner lets it Finalize and records why. Capture everything either way | — |

### 2H — exactly one consent

| # | Actor | Action | Expected |
|---|---|---|---|
| 2H.1 | KB | "Approve payout now" (**no Keplr prompt**: the browser's consent key signs) | answer `queued` / `relayed` / `on-chain`; audit `money.consent-relayed`; the consent intent `confirmed` |
| 2H.2 | OPER | `q game`; `q seats` | `consent_bitmap` = 2 (bit 1); seat 1 `consented` true; state still `settleable` |
| 2H.3 | KA | **nothing** (never approves) | — |

### 2I — Finalize at the 900 s window

| # | Actor | Action | Expected |
|---|---|---|---|
| 2I.1 | OPER | at `window_end` − ≈ 60 s: `q game`; `gamesDoctor aws money <g>` | still `settleable`; the finalize intent waiting ("the challenge window is open until …"), 0 attempts |
| 2I.2 | relayer | (automatic) Finalize ≈ `window_end` + 6–20 s | `junod q tx`: code 0, `action=finalize`, one bank send per non-zero amount (+ dust to the treasury) |
| 2I.3 | OPER | `q game` | `settled`; `outcome.route finalized`; `amounts` = 2G.4; `dust` = 2G.4; `distributed` 3,900,000; pool 0 |
| 2I.4 | KA, KB | reload | the band says "Paid: …" on both devices |

### 2J — balances and the three-way payout comparison

Read at one height after 2I: `KA`, `KB`, `<JX1_TREASURY>`, `<JX1>`, `<RELAYER>`.

| Account | Δ over the whole session (ujunox; `f(x)` = the actual fee from `junod q tx`) | Class |
|---|---|---|
| `KA` | −2,000,000 − f(create_game) + amount₀ | ante locked then paid out by result; fee burned |
| `KB` | −2,000,000 − f(join) + amount₁ (the rejected attempt cost nothing) | as KA |
| `<JX1_TREASURY>` | **+100,000 + dust** | subsidy (owner-held) |
| `<JX1>` | **0** (peak +3,900,000) | temporarily deposited |
| `<RELAYER>` | −[f(start) + Σ f(checkpoints) + f(settle) + f(consent) + f(finalize)] | burned |

**Payout PASS** = `outcome.amounts` = the 2G.3 preview = the 2G.4 independent computation = the wallets' deltas
(+ fees); and 4,000,000 deposited = 100,000 subsidy + amount₀ + amount₁ + dust.

### 2K — the gas record

One row per transaction of G2, from its `junod q tx` answer: tx, signer, hash, height, `gas_wanted`, `gas_used`, fee,
the estimate it replaces (`PHASE2_LIVE_RUN_PACK.md` §6.2). For the relayer's rows also the `chain.signed` audit's
`gas_limit` / `fee` and the `decideGas` check (2E.6). For the Keplr rows, the fee Keplr showed (simulate × 1.4). Save as
`<D>\p2-s2\gas.csv` (or `.md`). Also record, for gap G-8, each relayer intent's `created` time against its first
attempt's signed time (`gamesDoctor aws money <g> --json`).

### 2L — close

| Check | Expected |
|---|---|
| `gamesDoctor aws money <g> --chain` | FIN `closed`, `chain_outcome {SETTLED, finalized}`; every intent `confirmed` or `superseded` (none `held` / `pending`); JOURNAL MATCH; exit 0 |
| `RELAYQ#<RELAYER>` | Count 0 |
| `gamesDoctor aws games --money` | empty |
| host | `gs-host status` hold none; `HostHealthProblems` 0; no ALARM |
| relayer | `set-operator-plan` READY (≥ reserve) |

## 3. Evidence to save (`<D>\p2-s2\`)

`balances-before.json` / `balances-after.json`; the `/gs/api/money/*` request and response bodies (wallet-challenge,
wallet-link ×3, join-admission, consent, escrow-details); the `wallet-grants` reads; the `jx3VerifyLink` outputs;
`gamesDoctor aws money` (`--chain` text and `--json`) after 2C, 2D, 2E.3, 2E.4, 2G, 2I, 2L; `start.b64` and the
`jx2VerifyTx` output; every `junod q tx` answer (create, the join, Start, each checkpoint spot-checked, the terminal
checkpoint, Settle, consent, Finalize); `q game` / `q checkpoints` / `q settlement_preview` / `q seats` at 2E.7, 2G,
2H, 2I; screenshots of every Keplr prompt (no seed or key material) and of the settlement band at 2G.5 / 2H / 2I; the
gas record. Record: Project `claude/PHASE2_SESSION2_<date>.md`.

## 4. PASS / STOP

**PASS** = every "Expected" above holds; `jx3VerifyLink` PASS ×3; `jx2VerifyTx` PASS; JOURNAL / ROSTER / CHAIN BINDING
MATCH; one consent only (`consent_bitmap` 2 at Finalize); route `finalized` at ≥ `window_end`; the three-way payout
equality; contract Δ 0; queue empty; the gas record complete.

**STOP** (capture, act no further, ask the owner) — the universal list (`PHASE2_LIVE_RUN_PACK.md` §5.7), and:
- a Keplr *transaction* prompt during 2B (link) or 2H (consent);
- a deposit prompt whose funds are not exactly 2000000ujunox, or whose contract is not `<JX1>`;
- a relayer CheckTx refusal: `sdk/5` / `sdk/13` → JX-2B abort rule 6 (the relayer signs once, pages and stops by
  itself — on the single host the page shows as `HostHealthProblems`, the host health alarm; the ECS-era A15 alarm no
  longer exists; fund or re-tune, then the owner decides on a restart — the table is open, so this is an owner GO); any
  other code → capture and STOP;
- a DeliverTx failure on Start, Settle or Finalize;
- a verification mismatch at 2G (a device band not "Checked on this device", a preview ≠ the independent computation):
  the owner's ruling of 2G.6 is due **before `window_end`**;
- a round running past one hour (LivenessSettle becomes available): do not press it; record it; the owner decides
  whether G2 still counts.

If the session stops with G2 open, the money is safe in escrow and every exit is the contract's (liveness 3600 s after
the last checkpoint, then the 900 s window; JX-7A).

## 5. Cleanup / end state

G2 is SETTLED and terminal (every later game message is refused). The room may be closed. The consent keys stay in each
profile's IndexedDB, powerless. `KA` / `KB` keep their payouts for Session 3: **re-read both balances and rebalance**
before Session 3 (§6.4 of the index: 5.5 each for two concurrent disputes). JUNOX: the deposits came back as payouts
(split by the result); 100,000 subsidy + dust went to the owner-held treasury; only fees were burned (≈ 1.0 JUNOX).
