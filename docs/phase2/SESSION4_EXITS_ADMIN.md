# Phase 2 · Session 4 — exits and admin (operator sheet)

**Status:** a PROCEDURE, not executed. Do not run any GO step without the owner's GO for it.
**Covers:** the fast-path settlement (both seats consent); the deadline refund; Withdraw with an index shift;
IN_PROGRESS LivenessSettle followed by Finalize; cancel by agreement (consent annul, with the device consent key); an
admin **Pause**, the money actions refused while paused, an exit that still works while paused, **Unpause**; and the
final relay-queue / intent / hold checks that close Phase 2.
**Sources:** JX-5A §G–§H (consent completes the payout at once), JX-6B (a Finalize intent is superseded, not confirmed,
when another route settles), JX-7A §B–§P (exit paths, scenarios B, C, D, E, timing, gas), `CONSENT_ANNUL_LIVE_PROCEDURE.md`,
the contract's pause rules (`helpers.rs require_not_paused`: CreateGame, Join, Start, Settle, Consent and Finalize are
refused while paused; Withdraw, Cancel, Checkpoint, Challenge, AnnulByConsent, LivenessSettle, Resolve and
SetConsentKey still work). Conventions and read commands: `PHASE2_LIVE_RUN_PACK.md` §3–§5.

**Shape:** Part 1 runs five tables in parallel (≈ 3–3.5 h, set by S4-F's play). Part 2 is the pause window (≈ 30–40
min) and starts only when every Part-1 table is terminal. Part 3 is the closing checks (≈ 20 min). **Duration ≈ 4–5 h**
(≈ 7 h if OD-JX7-1 = run E, which needs its own window).

| Table | Purpose | Wallets | Deposits | Locked at peak | Ends |
|---|---|---|---|---|---|
| S4-F | fast path: both seats consent | KA (host), KB | 2 | 3,900,000 | SETTLED `consent_completed` |
| S4-AN | cancel by agreement | KA, KB | 2 | 3,900,000 | ANNULLED `annul_by_consent` |
| S4-B | deadline refund by a non-creator | K2 (host), K3 | 2 | 3,900,000 | CANCELLED `deadline_cancel` |
| S4-C | Withdraw with an index shift, re-Join, creator Cancel | K1 (host), K3, K4 | 4 | 5,850,000 | CANCELLED `creator_cancel` |
| S4-D | IN_PROGRESS LivenessSettle → promotion → relayer Finalize | K1 (host), K2 | 2 | 3,900,000 | SETTLED `finalized` |
| S4-PZ | pause window: refusals and an exit while paused | KA (host), KB (no deposit) | 1 | 1,950,000 | CANCELLED `creator_cancel` (while paused) |
| S4-E (optional, OD-JX7-1) | SETTLEABLE liveness under the pause | K3 (host), K4 | 2 | 3,900,000 | SETTLED `settleable_timeout_payout` |

## 0. Session prerequisites

| # | Prerequisite | Proof |
|---|---|---|
| S4-P1 | Session 3 PASS; `games --money` empty; `RELAYQ#<RELAYER>` Count 0; `q config` paused false; contract balance 0 | the reads |
| S4-P2 | `set-operator-plan` READY before **each** table (the relayer stays above the 8.2125 reserve) | the command |
| S4-P3 | Free balances: KA, KB ≥ 4.3 (S4-F + S4-AN at once); K1 4.3, K2 4.3, K3 4.5, K4 2.5 (K3 6.6, K4 4.4 with E) | `jx1b_verify account` |
| S4-P4 | Six browser profiles with Keplr (KA, KB, K1–K4), each signed in and profiled; recovery keys at hand | the lobby |
| S4-P5 | The owner can sign as `ADMIN` through `junod` (the GO-2 path; gap G-4) | owner note |
| S4-P6 | No host stop / deploy / restart during the session (S4-AN's collected signatures are memory-only) | owner hold |
| S4-P7 | Testers briefed: one wallet transaction at a time per wallet; every round under one hour in S4-F; S4-D and S4-AN stay inside the private auction; nobody presses "Release payout" or "Close and pay from the last recorded round" unless told | briefing |
| S4-P8 | Balances at one height: KA, KB, K1–K4, `<JX1_TREASURY>`, `<JX1>`, `<RELAYER>`, `ADMIN` | `<D>\p2-s4\balances-before.json` |

## 1. Part 1 schedule (T in minutes; JX-7A §M without E, plus S4-F and S4-AN)

| T | Step |
|---|---|
| 0 | S4-F: create, join, Start; then play (deal checkpoint ≈ T+12) |
| 2 | S4-D: create, join, Start, deal checkpoint (≈ T+14); then **idle** |
| 5 | S4-B: create and one join (funding deadline ≈ T+65) |
| 15 | S4-C (done ≈ T+40) |
| 20 | S4-AN (done ≈ T+45) |
| 65–120 | S4-B: the deadline refund, **within the hour after the deadline** (JX-7D, gap G-12) |
| ≈ 74 | S4-D: LivenessSettle at its `livenessAvailableAt`; `window_end` ≈ T+90; relayer Finalize ≈ T+91 |
| play | S4-F: GameEnd → Settle → both consents |

## 2. S4-F — fast-path settlement, both seats consenting

**Actors:** KA (seat 0), KB (seat 1); the relayer relays both consents. **Prereqs:** S4-P*; both devices hold their
seat's consent key (the device that deposited).

| # | Actor | Action | Expected |
|---|---|---|---|
| F.1 | — | Session 2 §2A–§2G on a fresh table (links, deposits, Start, the short game, the automatic Settle, both devices **match**, preview = independent computation) — without the deliberate rejections and the reproof | SETTLEABLE, `consent_bitmap` 0; `window_end` = Settle + 900 s |
| F.2 | KB | "Approve payout now" promptly (both approvals must land well before `window_end`) | consent relayed; `consent_bitmap` 2; still `settleable` |
| F.3 | owner | **GO-J5-3** — the second approval pays at once | — |
| F.4 | KA | "Approve payout now" | the completing consent: `junod q tx` code 0, `action=consent`, bank sends to both seats (+ dust to the treasury); `q game`: **`settled`, route `consent_completed`**, at a block time **before** `window_end`; amounts = the preview |
| F.5 | OPER | `gamesDoctor aws money <g> --chain` | FIN `closed` (`consent_completed`); both consent intents `confirmed`; **the finalize intent superseded** ("settled by consent_completed … not by this Finalize"), never signed; JOURNAL MATCH |

**Balances:** KA −2,000,000 − f(create) + amount₀; KB −2,000,000 − f(join) + amount₁; treasury +100,000 + dust;
contract 0; relayer −[f(start) + Σ f(checkpoints) + f(settle) + f(consent) + f(completing consent)] (no Finalize).
**JUNOX:** antes temporarily deposited, paid out by result; subsidy to the owner-held treasury; fees burned.
**Evidence:** as Session 2 §3, plus both consent txs and the superseded finalize intent.
**PASS:** route `consent_completed` before `window_end`; no Finalize transaction; payouts = preview = independent.
**STOP:** the universal list; a Keplr transaction prompt at either approval; `window_end` passes before KA's approval
(then the relayer Finalizes: record a deviation — the fast path is not proven on this table).
**Cleanup:** none (terminal).

## 3. S4-AN — cancel by agreement (consent annul)

Run **`CONSENT_ANNUL_LIVE_PROCEDURE.md`** exactly (its GO "GO P2-ANNUL"), with `KA` as host and `KB` as joiner. It
defines the authority split (the seats' **device consent keys** are the only authority; no Keplr prompt; no
re-authentication to relay — OD-4-2), the steps (deposits, Start, deal checkpoint, KB signs "1 of 2", KA completes, the
relayer submits one `annul_by_consent`), the expected `annulled` state with 1,950,000 back to each seat, treasury
+100,000, contract Δ 0, the evidence E-1…E-8, the refusal table and the cleanup. Two Session-4 constraints:
- it must be **terminal before Part 2** (an annul works while paused, but keeps its evidence out of the pause window);
- KA and KB are also in S4-F: the S4-AN room stays in the private auction, and each wallet signs one transaction at a
  time.

**JUNOX:** both antes temporarily deposited and returned (net 1,950,000 each); 100,000 subsidy to the owner-held
treasury; fees burned (players pay none for the annul).

## 4. S4-B — deadline refund by a non-creator (JX-7A §L B)

| # | Actor | Action | Expected |
|---|---|---|---|
| B.1 | K2 | Create a **3-max** live money table (min ante), link, "Open the table on Juno" (`create_game`, 2000000ujunox) | chain FUNDING, seat 0 = K2; record `deadlines.funding_deadline` (= CreateGame block time + 3600 s) |
| B.2 | K3 | take a seat, link, "Deposit 2 JUNOX" → "Approve in Keplr" (`join`, 2000000ujunox, the admission) | FUNDING, 2 of 3 seats, pool 3,900,000 |
| B.3 | — | wait for the deadline (≈ 60 min). Before it, K3 is **not offered** "Refund everyone" (a non-creator Cancel before the deadline is `Unauthorized` at simulation: nothing signed) | — |
| B.4 | owner | **GO-B (refund)** — within the hour after the deadline | — |
| B.5 | K3 | "Refund everyone (minus the fee)" → Keplr `{"cancel":{"chain_game_id":N}}`, **no funds** → approve | `junod q tx`: block time ≥ `funding_deadline`; code 0; `q game`: **`cancelled`, route `deadline_cancel`, amounts [1,950,000, 1,950,000]**; FIN `cancelled`; the room cancelled |

**Balances:** K2 −50,000 − f(create); K3 −50,000 − f(join) − f(cancel); treasury +100,000; contract 0.
**JUNOX:** both net antes temporarily deposited and refunded; the canceller earns nothing for cancelling; subsidy to the
owner-held treasury (never clawed back); fees burned.
**Evidence:** the three txs; `q game` before (deadline) and after; `money --chain` after; balances.
**PASS:** as Expected; refund tx block time ≥ the deadline. **STOP:** the universal list; FIN still `funding` after
the chain shows `cancelled` (JX-7D: record; no funds at risk). **Cleanup:** none.

## 5. S4-C — Withdraw with an index shift (JX-7A §L C)

| # | Actor | Action | Expected |
|---|---|---|---|
| C.1 | K1 | Create a **3-max** live money table, link, open it on Juno | FUNDING, seat 0 = K1 |
| C.2 | K3, then K4 | take seats, link, deposit (one at a time) | FUNDED: seats **[K1, K3, K4]**, pool 5,850,000 |
| C.3 | owner | **GO-C1** | — |
| C.4 | K3 | "Withdraw deposit" → Keplr `{"withdraw":{"chain_game_id":N}}`, **no funds** → approve | tx: `action=withdraw`, refund 1,950,000 to K3; `q game`: **FUNDING**, seats **[K1, K4]** (K4 moved 2 → 1), pool 3,900,000; the treasury unchanged (no clawback) |
| C.5 | OPER | `money --chain`; `wallet-grants` | the claims follow the chain: K4 at chain index 1; K3's grant still **standing** (not burned), its claim back to `linked`, "deposit" offered again; ROSTER N/A (never frozen) |
| C.6 | K3 | "Deposit 2 JUNOX" → "Approve in Keplr" again (a **fresh admission**) | FUNDED: seats **[K1, K4, K3]** (K3 takes the last index); a second 50,000 from K3 to the treasury |
| C.7 | owner | **GO-C2** | — |
| C.8 | K1 | "Cancel table on Juno" → Keplr `{"cancel":{"chain_game_id":N}}`, no funds → approve | `cancelled`, route `creator_cancel`, amounts [1,950,000 ×3]; FIN `cancelled`; the room cancelled |

**Balances:** K1 −50,000 − f(create) − f(cancel); K3 −100,000 − f(join) − f(withdraw) − f(join 2); K4 −50,000 −
f(join); treasury +200,000; contract 0.
**JUNOX:** every net ante temporarily deposited and returned (K3's twice); four subsidies to the owner-held treasury;
fees burned.
**Evidence:** every tx; `q game` after C.2, C.4, C.6, C.8; `money --chain` after C.4 and C.8; `wallet-grants` after
C.4 and C.6; balances.
**PASS:** the index shift and the re-Join order exactly as Expected; the server's claims match the chain at every read.
**STOP:** the universal list; a claim that names the wrong chain index (`money --chain` not MATCH). **Cleanup:** none.

## 6. S4-D — IN_PROGRESS LivenessSettle, promotion, relayer Finalize (JX-7A §L D)

| # | Actor | Action | Expected |
|---|---|---|---|
| D.1 | K1, K2 | 2-max live table: create, join, K1 "Start game"; the relayer's Start and **deal checkpoint** | IN_PROGRESS; `q checkpoints`: the deal checkpoint (equal weights); note its `accepted_at` |
| D.2 | K1, K2 | **make no move that crosses a round boundary** (stay in the private auction) and leave the table idle | the room shows when the inactivity exit opens (`livenessAvailableAt` = the reference + 3600 s, reference = max(Start, last checkpoint)) |
| D.3 | owner | **GO-D** at `livenessAvailableAt` | — |
| D.4 | K2 | "Close and pay from the last recorded round" → Keplr `{"liveness_settle":{"chain_game_id":N,"checkpoint":null}}`, **no funds** → approve (if simulated a few seconds early it is refused and nothing is signed: retry) | `q game`: **`settleable`**, `settlement.source liveness_checkpoint`, `window_end` = that block time + 900 s, consents reset; `q settlement_preview` = [1,950,000, 1,950,000], dust 0; **no money moved yet** |
| D.5 | relayer | (automatic) Finalize at `window_end` (nobody approves; nobody presses "Release payout") | `settled`, route **`finalized`**, amounts [1,950,000, 1,950,000]; FIN `closed`; **no settle intent ever existed** for this table; the finalize intent `confirmed` |
| D.6 | fallback | only if no relayer Finalize ≈ 5 min after `window_end`: K1 or K2 "Release payout" (permissionless Finalize; the wallet pays the fee) — record a deviation | as D.5 |

**Balances:** K1 −50,000 − f(create); K2 −50,000 − f(join) − f(liveness_settle); treasury +100,000; contract 0;
relayer −[f(start) + f(deal checkpoint) + f(finalize)].
**JUNOX:** antes temporarily deposited and paid back by the equal deal-checkpoint weights; subsidy to the owner-held
treasury; fees burned.
**Evidence:** the LivenessSettle tx (block time vs the queried `liveness_available_at`); `q game` / `q checkpoints` /
`q settlement_preview` at D.1, D.4, D.5; the Finalize tx; `money --chain`.
**PASS:** promotion without any payout; the relayer's Finalize at ≥ `window_end` paying the checkpoint weights.
**STOP:** the universal list; a round boundary crossed in D.2 (a new checkpoint resets the clock: record, keep waiting);
the outcome `cancelled` (a liveness refund: it means no trusted checkpoint — STOP and investigate). **Cleanup:** none.

## 7. Part 2 — the pause window (S4-PZ)

**Start only when every Part-1 table is terminal:** `games --money` empty; `RELAYQ` 0; contract balance 0. While
paused, Settle, Consent and Finalize **wait**; a game left IN_PROGRESS still runs its liveness clock.
**Authority:** `ADMIN` only (Pause / Unpause; it can never move funds). **Gap G-11:** no documented zero-fee command
shows a chain-level refusal; the refusals below are the server's and the browser's, and the chain side is proven by an
exit that works while paused.

| # | Actor | Action | Expected |
|---|---|---|---|
| PZ.1 | KA, KB | KA creates a 2-max live money table (min ante), KB takes the seat; both link; KA "Open the table on Juno" (`create_game`, 2000000ujunox). **KB does not deposit** | chain FUNDING, 1 seat (KA), pool 1,950,000; 50,000 to the treasury |
| PZ.2 | OPER | `q config` on `<JX1>` (print it first: the admin command must name this contract — JX-1B §E) | `paused` false; `admin` = `ADMIN` |
| PZ.3 | owner | **GO-PAUSE**, then as `ADMIN`: `junod tx wasm execute <JX1> '{"pause":{}}' --from <ADMIN_KEY> --chain-id uni-7 --node <RPC> --gas auto --gas-adjustment 1.3 --gas-prices 0.075ujunox -o json -y` (**no `--amount`**) | `junod q tx`: code 0, `action=pause`, `paused=true`; `q config`: `paused` true |
| PZ.4 | OPER | host log `/gs/staging/host`; `gs-host status`; `gamesDoctor aws status` | **no `escrow.backend-refused`** (deployment verification does not judge `paused`); escrow active; readyz 200 |
| PZ.5 | KB | "Deposit 2 JUNOX" → "Approve in Keplr" | **refused before Keplr**: "Deposits are paused on Juno right now, so nothing was sent. Try again later." No Keplr prompt; KB's balance unchanged; chain unchanged (1 seat) |
| PZ.6 | K1 | host setup with a real-money stake → Create | **refused** (`money-games-disabled`): "Juno's escrow is paused right now; new tables can't open on it." No table is created |
| PZ.7 | KA | look at the room's money view (DevTools: the room's money response) | `escrow.paused: true` |
| PZ.8 | owner | **GO-PZ-CANCEL** | — |
| PZ.9 | KA | "Cancel table on Juno" → Keplr `{"cancel":{"chain_game_id":N}}`, **no funds** → approve | **works while paused**: code 0; `cancelled`, route `creator_cancel`, amounts [1,950,000]; FIN `cancelled` — a pause never traps funds |
| PZ.10 | owner | **GO-UNPAUSE**, then as `ADMIN`: the PZ.3 command with `'{"unpause":{}}'` | code 0, `action=unpause`, `paused=false`; `q config`: `paused` **false** |
| PZ.11 | K1 | host setup with a real-money stake → Create, **without linking a wallet** (no chain transaction) → then close the unbound table (host cancel) | the create is accepted again (money tables reopen); the unbound table closes locally (`cancel-before-deal`); no JUNOX moves |

**Unpause is mandatory.** Until PZ.10 lands, no money table can open, deposit, start, settle or finalize on JX-1.

**Balances:** KA −50,000 − f(create) − f(cancel); KB 0; K1 0; treasury +50,000; contract 0; `ADMIN` −f(pause) −
f(unpause) (≈ 24,000 each).
**JUNOX:** KA's net ante temporarily deposited and refunded while paused; one subsidy to the owner-held treasury; fees
burned.
**Evidence:** both admin txs; `q config` before / during / after; the PZ.5 and PZ.6 refusals (screenshots + the server
response body); the PZ.7 view; the cancel tx; the host log lines around PZ.3–PZ.10.
**PASS:** paused true between PZ.3 and PZ.10; the two refusals with no Keplr prompt and no balance change; the Cancel
landed while paused; paused false at the end; no `backend-refused`.
**STOP:** the universal list; the pause tx names any contract other than `<JX1>` (check the printed command before
signing); a Keplr prompt at PZ.5; a table created at PZ.6; PZ.9 refused (impossible by the contract: STOP and keep the
contract paused only as long as the owner rules); PZ.10 not landed (repeat it before anything else).
**Cleanup:** paused false; KA keeps the refund.

### 7.1 Optional S4-E — SETTLEABLE liveness under the pause (OD-JX7-1 = run)

JX-7A §L E unchanged (K3 host, K4; LivenessSettle #1 → SETTLEABLE; **ADMIN Pause before `window_end`**; the relayer's
Finalize **waits with 0 attempts**; at `window_end` + 3600 s K3's LivenessSettle #2 → `settleable_timeout_payout`;
**ADMIN Unpause**). It needs a window in which **no other JX-1 table is live** (S4-F closed first), so it runs after
Part 1 in its **own** ≈ 170-minute window with its **own** Pause / Unpause pair, either before S4-PZ starts or after
S4-PZ's Unpause — never overlapping it (S4-PZ's entry condition is an empty contract). It adds the chain-level evidence
G-11 lacks (a Finalize waiting under the pause). Balances: JX-7A §L E (K3 −50,000 − f(create) − f(liveness #2); K4
−50,000 − f(join) − f(liveness #1); treasury +100,000; contract 0; `ADMIN` a second Pause + Unpause ≈ 0.05 JUNOX).

## 8. Part 3 — closing checks (Phase 2 exit)

| # | Check | Expected |
|---|---|---|
| X.1 | `gamesDoctor aws games --money` | **empty** |
| X.2 | `RELAYQ#<RELAYER>` (strong, every page) | **Count 0** |
| X.3 | `gamesDoctor aws money <g> --chain` for every Session-4 table (and a re-read of G2, S3-A, S3-B) | FIN `closed` or `cancelled`; **every intent `confirmed` or `superseded`; none `held`, none `pending`**; JOURNAL MATCH; exit 0 |
| X.4 | holds | `gs-host status` hold none; no FIN hold in any read above |
| X.5 | `q config` | `paused` **false** |
| X.6 | contract balance | **0** = Σ open pools (0) + Σ disputed bonds (0) |
| X.7 | `set-operator-plan … --to-relayer <RELAYER> …` | READY (the relayer above its reserve) |
| X.8 | host health | `HostHealthProblems` 0; no ALARM; readyz 200; digest unchanged since Session 1 |
| X.9 | `terraform plan -detailed-exitcode` for `stacks/ledger`, `stacks/app`, `stacks/single-host` (read-only) | **0, 0, 0** |
| X.10 | treasury | its Session-1 baseline + 950,000 (1,050,000 with E) + Σ the dust recorded in every payout |
| X.11 | the old contract | `jx1b_verify snapshot` + `same` against Session 1's `current-before.json` → SAME |
| X.12 | the gas record | every Phase-2 transaction listed (Session 2 §2K format) |

**Phase 2 PASS** = every session's PASS + X.1–X.12. Record: Project `claude/PHASE2_SESSION4_<date>.md` and the
Phase-2 closure record (`PHASE2_MASTER_CHECKLIST.md` filled).

## 9. Session-4 balance summary (without E; ujunox)

| Account | Δ (fees as f) |
|---|---|
| KA | S4-F (−2,000,000 + amount₀) − 50,000 (AN) − 50,000 (PZ) − its fees |
| KB | S4-F (−2,000,000 + amount₁) − 50,000 (AN) − its fees |
| K1 | −50,000 (C) − 50,000 (D) − its fees |
| K2 | −50,000 (B) − 50,000 (D) − its fees |
| K3 | −50,000 (B) − 100,000 (C) − its fees |
| K4 | −50,000 (C) − its fees |
| `<JX1_TREASURY>` | +650,000 + dust (F 100,000; AN 100,000; B 100,000; C 200,000; D 100,000; PZ 50,000) |
| `<JX1>` | 0 |
| `<RELAYER>` | −[S4-F, S4-D, S4-AN relayer fees] ≈ 1.12 JUNOX |
| `ADMIN` | ≈ −0.05 JUNOX (Pause + Unpause) |
