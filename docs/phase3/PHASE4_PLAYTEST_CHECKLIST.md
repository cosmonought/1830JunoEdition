# Phase 4 — playtest checklist (written at Phase-3 closure, W3-F)

**Purpose.** This is the Phase-3 closure deliverable for plan §11 item 7: *"Every Phase-4 row (§8 and every D row) has a
reproducible observation procedure in the Phase-4 checklist."* It holds one procedure for each of the 70 rows that
`docs/phase3/phase3_accounting.json` dispositions **D** (Phase-4 playtest), for each row of the plan's §8 tables, for
Appendix A (recovery R1–R12, the Rules Reference checkpoints), for the 6.5 functional-playtest rows the draft named
(A-3, A-5, S-3, S-4, S-11, O-1, O-8, O-9, O-12), for the Phase-4 items in `docs/phase3/README.md`, and for the owner's
Phase-4 money items (2026-10-10).

**Baseline.** Run everything against **the Phase-4 baseline head recorded in `docs/phase3/README.md`** ("Pins" →
"Phase-4 playtest baseline"). An observation on any other build does not count. If the baseline moves, re-run the
affected rows and record the new head.

**What Phase 3 did and did not prove.** No row here is closed because a jsdom or node test passes. Phase 3 verified the
money flows only against a **fake chain and a stand-in Keplr in test worlds**. Nothing in "Early Phase-4 tasks" or
"Money and wallets" was verified live with real Keplr, real JUNOX or the deployed Escrow 2.1 contract on uni-7.

**Scope.** Phase 4 observes and reports. It does not implement fixes. The one exception is P4-E1, the Any-count escrow
correction, which the owner made an early Phase-4 implementation task. Phone-width gameplay layout and keyboard map
access are Phase 5 (OD-10(b)): Phase 4 only observes them.

---

## How to record results

Record each run as one line in the Phase-4 results log, which the Phase-4 lead chooses: a sheet, an issue per run, or a
results file next to this one. One run is one row ID tested once in one environment.

| Field | What to write |
|---|---|
| Row | The ID used here (`AUD-…`, `VF/…`, `P4-…`, `CK-…`, `R…`, `RR-…`, `6.5/…`, `X-…`, `RES-…`) |
| Date | ISO date and local start time |
| Build | The full baseline SHA shown by the app / deployment, and the server build if it differs |
| Environment | Site URL; free or money table; for money, the chain ID (`uni-7`), the escrow code ID and contract address from the deployment pin |
| Browser / device | Browser name and version, OS, device; UI scale; reduced motion on or off; zoom level |
| Tester | Name; the seat(s) and wallet(s) used (an address prefix is enough) |
| Result | **PASS**, **FAIL**, **RE-TUNE** (VF only: works, numbers want changing), **NOT REACHED** (the moment never came up; say why) or **BLOCKED** (a prerequisite is missing) |
| Evidence | A link to screenshots, a screen recording, the log export (AUD-01.09, "Export log"), console output, and for money the transaction hashes / explorer links |
| Notes | What was seen, in a sentence or two; for a FAIL, the steps to reproduce |

**General rules for every procedure.**

- **Log export.** Wherever a step says "export the log", use the in-game log export. Keep the file with the evidence.
  A log hash before and after a step is the board identity used by R1 and R6.
- **Console.** Keep DevTools open on at least one seat for every session. Save the console on any FAIL. Any
  `[mirror]` line (AUD-24.02) or divergence banner (R12) is evidence on its own.
- **Seats.** Use at least three human seats unless a row says otherwise. Use separate browser profiles or devices so
  that two seats never share a tab.
- **Scales.** "100% and 63%" means the in-app UI scale setting. Ctrl+wheel browser zoom is the separate test AUD-16.08.
- **Reduced motion.** Use the OS setting (Windows: Settings → Accessibility → Visual effects → Animation effects off;
  macOS / iOS: Reduce Motion). Reload the page afterwards.
- **Reaching a moment.** Reach the moment by ordinary play, or by replaying a saved log that stops just before it.
  Record which one you used. A sandbox or fixture board counts only where the row says so.
- **A FAIL is not fixed in Phase 4.** File it with its evidence and its row ID.

---

## 1. Early Phase-4 tasks

### P4-E1 — The mandatory Any-count escrow correction (implementation task, not a playtest)

**Phase 3 did NOT verify this live. There was nothing live to verify: the correction does not exist yet.**

**Background.** The deployed Escrow 2.1 requires every seat chosen at `CreateGame` to fund before Start. An Any-count
money table therefore cannot exist on it, so Play **gates** it:

- `frontend/src/utils/tablePolicy.ts`: `ANY_COUNT_MONEY_TABLES = false`.
- The host sees the gate under Players and next to Create table. The sentence is `ANY_COUNT_BLOCKED_SENTENCE`: "Any-count
  tables with an ante open once Juno's corrected escrow is certified. For now, choose an exact number of players to
  create this table."
- The server refuses a money create that has no exact count (`moneyTables.prepareCreate`).
- No-ante development tables (`FREE_TABLES_OFFERED`) still take Any.

**The task.** The owner ruled that Phase 4 corrects the escrow early, as a **new certified escrow version**. Escrow 2.1
stays unchanged. The flag turns on only together with that certified, deployed version.

**Procedure. Part A: observe the gate now, on the baseline.**
1. Host Game. Choose a money table (an ante). Leave Players on "Any (up to N)".
2. Record: Any is visible, listed first and selected by default. It is not hidden and not silently turned into a count.
   The blocked sentence appears under Players and next to Create table, and Create table is disabled.
3. Choose an exact count. Record: Create table is now enabled.
4. With DevTools, or a scripted request against the staging server, send a money create without a count. Record the
   server's refusal.
5. Make a no-ante table with Any. Record: it is created.
6. **PASS** if every step behaves as written. **FAIL** if a money table is ever created with Any, or if Any is hidden
   or rewritten.

**Procedure. Part B: lifting the gate (only after the corrected escrow is certified AND deployed).**
1. Record the new escrow version's certification record: its checksum, and the build that proves reproducibility.
   Record its deployment (code ID, contract address) on uni-7.
2. Confirm that the build under test sets `ANY_COUNT_MONEY_TABLES = true` and pins the new contract. Confirm that
   Escrow 2.1 tables in flight are untouched.
3. Create an Any-count money table with real Keplr (as in P4-M1). Seat fewer players than the maximum, fund them, and
   Start. Then create a second one and let it reach its maximum.
4. Record each Start transaction, and confirm that every funded seat is the seat set the chain started with.
5. **PASS** if the gate lifts only on the certified, deployed version and Any-count tables fund and start. **FAIL** if
   the gate lifts before certification or deployment, or if Escrow 2.1 changed.

---

## 2. Money and wallets (real Keplr / Juno)

**Phase 3 did NOT verify any item in this section live.** Phase-3 verification of these flows used ONLY a fake chain
and a stand-in Keplr in test worlds. Real Keplr prompts, real JUNOX balances, real uni-7 blocks, the real relayer and
the deployed Escrow 2.1 contract were never exercised by Phase 3.

**Common setup.**
- Network: uni-7 testnet. Currency: JUNOX from the faucet. Record each wallet's starting balance.
- The Keplr browser extension (record its version). Use one real wallet per seat, plus a separate Authorization Wallet
  where a row needs one.
- Testers: a host plus at least two guests, each on their own device or browser profile. One more tester has played a
  money table before, as the "returning player" in P4-M4.
- Record the escrow code ID and contract address from the deployment pin. Every tx hash goes in Evidence, with an
  explorer link.

### P4-M1 — Real-wallet funded games: create, join, confirm, withdraw, cancel, refund, start

1. **Host-first CreateGame through the one-button Ante.** Host Game; a money table; an exact count of 3; a small ante;
   choose a deadline (do one table each with Live, Async and No deadline across the session). Press **Ante** once.
   Answer every Keplr prompt. Record each prompt in order, the status line, the CreateGame tx hash, and the panel
   moving from **pending** to **confirmed**. For No deadline, record that the host acknowledged the disclosure before
   the create.
2. **Stamps.** Record the tear and **Boarded** stamps on the host seat when the deposit confirms, with a screenshot or
   recording.
3. **Guests' Join deposits.** Each guest joins and presses Ante. Record the prompts, the Join tx, pending → confirmed,
   and the Boarded stamp. On No deadline, record that each joiner acknowledged the disclosure before their deposit, and
   that a deposit is refused without it.
4. **Withdraw.** Before Start, one guest presses Withdraw. Record the tx, the refunded amount (minus gas) and the seat
   becoming free. That guest re-joins and re-deposits.
5. **Exact-count Start (relayer).** With every chosen seat funded, the host starts. Record the Start tx (sent by the
   relayer, not a player's Keplr), the time from the press to on-chain confirmation, and the table opening on every
   seat.
6. **Cancel table on Juno.** On a second table (the host has funded, no guest has), the host presses **Cancel table on
   Juno**. Record the tx, the host's refund and the table state on every viewer.
7. **Refund after the funding deadline.** On a third table, fund some seats and let the funding deadline pass without
   Start. Each funded player presses Refund. Record each tx and amount, and that Start is no longer offered.
8. **Single flight.** While any deposit is pending, press Ante again (and from a second tab, AUD-19.02). Record the
   refusal sentence: "A transaction for this is already on its way to Juno…".
9. **PASS** if every money movement on chain matches what the panel said, no step needs a manual retry, and no
   balance is wrong. **FAIL** on any mismatch, any stuck pending state, or any transaction sent that the panel did not
   ask for.

### P4-M2 — Real-wallet settlement, REMEDY attestations and disputes on the deployed Escrow 2.1

**Prerequisites.** The dedicated REMEDY signer is deployed for the environment. Without it, timed money tables must
**fail closed**: record that a timed money table is then neither funded nor started. That observation is itself a
check. Each table in this procedure is a funded, started table from P4-M1.

1. **Settlement (consent / payout / release).** Play a money table to GameEnd. Use a short real game if possible and
   record how GameEnd was reached. Each seat gives its consent in the settlement band. Record each Keplr / seat-key
   prompt, the payout figures shown, the release tx, and every wallet's balance afterwards. **PASS** if the paid
   amounts equal the shown payout (minus gas) and no browser or server computed a different payout.
2. **Live REMEDY: N-1 foreclosure at minute 30.** On a Live money table, let one seat run its 20:00 action clock out
   (strike 1). The other seats propose foreclosure and every one of them says YES (each YES is signed on the device
   with the seat key after a confirmation that names the defaulting player and the outcome). Do not cure. At minute 30,
   record the outcome, the sealed remedy, the REMEDY attestation tx and the balances.
3. **Live REMEDY: neutral timeout annulment.** Repeat with one NO, or with incomplete votes. Record the neutral
   annulment and that every ante comes back.
4. **Live third strike.** One seat collects three expiries in one game (it cures the first two). Record that gameplay
   ends at once by foreclosure, with no cure window and no vote, and record the attestation.
5. **Async N-1.** On a Timed Async (12 h) money table, let one seat go OVERDUE. The other seats unanimously propose
   annulment on one table and foreclosure on another. Record that completion is final at once, and record the tx.
6. **Minute 30 waiting for the chain (only if it happens).** If minute 30 ever shows "The 30-minute decision is
   waiting for Juno to confirm the approvals …", record how long it lasted and whether `finalityKeysUnread` alarmed.
7. **Disputes.** Challenge the third-strike foreclosure from step 4 on chain. Record the challenge tx and the DISPUTED
   state, the resolver's decision and its tx, and the bond's return. Ask for an exceptional review from a seated
   wallet: record that it can be asked once only, and that the resolver may only annul neutrally, and no sooner than 7
   days later. That check takes calendar time, so plan it.
8. **PASS** if every remedy that lands on chain equals the sealed decision the table showed, and approvals are judged
   at the sealed `final_at`. **FAIL** on a different on-chain outcome, a remedy that never lands, or a payout shown in
   the browser that differs from the chain's.

### P4-M3 — The host ante race on real Keplr

1. The host has the money table open on device 1 and device 2 (the same account). No CreateGame has been sent.
2. On device 1, press Ante. Stop when Keplr shows the **CreateGame** approval. Do not approve yet.
3. On device 2, change the table's ante. Record that the change is accepted.
4. On device 1, approve in Keplr.
5. Record that the signed CreateGame was **dropped unsent**: no tx hash, nothing on the explorer, the wallet balance
   unchanged. Record that the host was told why, in this sentence: "The table's ante changed to X while Keplr was
   open, so the transaction you signed (Y) wasn't sent -- nothing moved. Press Ante again to open the table at the new
   ante." (`approveDeposit`'s `stillValid` in `frontend/src/money/moneyActions.ts`).
6. Variant: open the table on Juno from device 2 while device 1's Keplr is open. Record the sentence "This table was
   opened on Juno while Keplr was open …".
7. Press Ante again on device 1. Record a clean create at the new ante.
8. **PASS** if nothing is ever broadcast at the stale ante. **FAIL** if a CreateGame at the old ante reaches the chain.

### P4-M4 — The one-button Ante's approval count against real Keplr prompts

1. **New player (expect 3 approvals).** Use a fresh browser profile with Keplr installed, not connected to the site,
   and with no seat link. Join a money table and press Ante once. For each Keplr prompt, record the status line and
   the prompt Keplr actually shows:
   - "Check Keplr: connect your wallet (1 of 3)."
   - "Check Keplr: sign a free message proving the wallet is yours (2 of 3)."
   - "Check Keplr: approve the deposit (3 of 3)."
2. **Returning player (expect 1 approval).** Use a player already connected and linked (a previous table in the same
   browser). Press Ante. Record "Check Keplr: approve the deposit (1 of 1)." and that Keplr shows exactly one prompt.
3. **Host.** Repeat steps 1 and 2 as a host (CreateGame).
4. **Off-plan.** If Keplr asks for an approval the plan did not list (for example the server refuses an old proof),
   record that the count is **dropped**, not shown wrong (`approvalStatus` in `frontend/src/utils/roomDesign.ts`).
5. **PASS** if every shown "(n of m)" matches the prompt Keplr is showing and the real number of prompts. **FAIL** if
   any count is wrong, or a prompt appears with no status line.

---

## 3. Clocks (Live / Async / No deadline)

**Source:** `docs/phase3/PHASE3_FINAL_CLOCKS_REMEDIES.md`, sections 2–4 and 7. These are the README's "Live / Async
clock behaviour at real tables". Phase 3 tested them on controlled time in node and jsdom only, never at real tables
with real people.

Run them on **free tables** unless a row says money. The money outcomes (REMEDY) are in P4-M2. In every CK row, check
the chip's countdown against a stopwatch, and reload one seat mid-countdown to confirm the value continues (it never
resets).

| ID | Setup | Actions | Record | Pass |
|---|---|---|---|---|
| CK-1 Chip and mode | One table each: Live, Async · 24 hours, No deadline | Look at the room strip on every seat, including a spectator | Mode text, who acts, the countdown; a background tab shows no countdown | One chip; the mode is right; the countdown matches the stopwatch within 1 s per 10 min |
| CK-2 Live 20:00 per required action | Live, 3 seats | Seat A finishes a required action that leaves A owing again; A hands off to B; C makes a move that does not change who owes | Each clock reset | A gets a fresh 20:00 each time; B gets a fresh 20:00 on handoff; C's move changes nothing |
| CK-3 Live offer and the 10:00 response timer | Live; A owes a decision and offers B a train | Let B wait about 4:00, then answer | "Train offer — m:ss to respond"; A's clock shown paused with "offer pause left this action" | B's 10:00 runs; A's clock does not move; afterwards A resumes the same remainder |
| CK-4 Freeze budget (owner example) | Live; one A episode | Offer 1 waits 4:00 (reject). Offer 2 waits 6:00 (reject). Offer 3 is made | Budget after each offer; A's clock during offer 3 | Budget goes 6:00, then 0:00; offer 3 is **legal**; A's clock runs while it waits ("… running while the offer waits … (this action's 10:00 of offer pause is used up)") |
| CK-5 Budget reset rules | Continue CK-4 | Reload; then complete A's action so A owes a new one | Budget after the reload; budget after completing | A reload renews nothing; a genuinely new required action renews 10:00 |
| CK-6 Proposer runs out during an offer | Live; A has about 2:00 left and no budget | A offers; B does not answer | The moment A's clock hits 0 | The server closes the offer at that moment (no decline is recorded); A is OVERDUE (strike); B is never struck |
| CK-7 Unanswered expiry | Live; budget left | B lets the 10:00 response run out | Offer state; decline count | The offer closes as A's rescission at exactly 10:00, and counts as one decline A → B |
| CK-8 Two declines per round instance | Live; in OR x.1, B declines two of A's offers | A tries a third offer to B; then B → A, and A → C; then OR x.2 | Refusal text | Third refused: "B has declined two train offers from you this operating round."; B → A and A → C stay open; OR x.2 starts from zero |
| CK-9 Overdue, cure, strike count | Live | Let A's 20:00 run out; try another seat's move; then A takes its owed action before 30:00 | The OVERDUE display with the time to 30:00, the vote state, the automatic outcome | Only A's owed action is accepted, and it cures; "1 of 2 overdue cures used" and the second-strike warning appear afterwards; A's own offer is refused while overdue |
| CK-10 Minute 30 (free table) | Live; A overdue, not curing | (a) Every other seat votes YES; (b) one seat votes NO; (c) votes incomplete | The outcome at 30:00 | A complete N-1 is applied at minute 30, not earlier; a NO vetoes; incomplete votes give the neutral outcome |
| CK-11 Voluntary pause | Live | One seat asks to pause; everyone says YES; wait 2 min; everyone says YES to resume | Every timer (action, response, cure window) before and after | Starting needs every seat's YES, and so does resuming; the timers are frozen exactly |
| CK-12 System pause | Live; staging where a game-server restart is allowed (R6 mechanics) | Restart the server mid-turn | The banner: "Game paused because server continuity was interrupted." / "All players must agree to resume." | No move is possible until every seat resumes; the timers resume from the last proven instant; no restart pause appears after a terminal seal |
| CK-13 Undo never refunds time | Live | A acts, waits 1:00, then undoes its own action; also a host undo | A's clock before and after | No clock and no budget goes up |
| CK-14 Timed Async | Async · 12 hours | Make offers (no response timer); let the deadline pass | "Your deadline keeps running while the offer is answered: … left (the offer is withdrawn when it runs out)"; OVERDUE with no countdown | Offers never stop or refresh the proposer's deadline; at the deadline the server closes the offer; overdue only (nothing moves, no interruption); no decline limit |
| CK-15 No deadline | No deadline (free) | Play several turns | The chip | "No deadline"; no countdown, no overdue, ever |
| CK-16 Unanimous annulment (free) | Any live state | Every seat votes to annul (`clock-annul`) | The table outcome | Annulled only with every seat's YES |

**Overall clock FAIL:** a timer that jumps after a reload, a fresh allowance appearing from an offer, an undo or a
reload, a strike on an answerer, or any expiry on a free table that moves money or forfeits a seat.

---

## 4. Recovery scenarios R1–R12

### AUD-19.03 — Recovery scenarios: refresh, network loss, two tabs, second device, stale modal, divergence banner

**Source:** plan Appendix A.1, which adapts the 6.5 preflight §8. Adapt the restart and build-guard mechanics to the
hosting in use at the baseline, and record how you did it. **For every R-row, record:** the banner text exactly, the
recovery path (the clicks or steps), a log export **before and after**, and the console.

| ID | Checkpoints | How | Pass condition |
|---|---|---|---|
| R1 Refresh the acting seat | (a) tile picker open; (b) between Run and Dividends; (c) mid-contest; (d) the B&O winner before par; (e) emergency modal open; (f) discard prompt open | F5 on the acting seat | Same seat; same board (log hash before = after); the required control visible with no extra steps |
| R2 Refresh a non-acting seat | While another seat acts | F5 | Catches up with no toasts; controls correctly disabled |
| R3 Close and reopen | Mid-SR; mid-OR | Close the tab → lobby → Your tables → the table | Back in the same seat |
| R4 Network loss | Acting seat mid-turn | DevTools offline (or Wi-Fi off) for 10–30 s; click during the gap | Banner "Connection to the room was lost — reconnecting…"; the queued move lands if nobody else moved, otherwise "The room had moved on — this tab has caught up. Try that again."; never a false "Could not reach the room" once reconnected |
| R5 Reconnect after others moved | One seat offline across 3+ moves by others | As R4 | Only the missed entries are applied; the controls are right |
| R6 Server restart | (a) after an SR's last pass; (b) mid-OR between corporations; (c) Delayed Auction with the par owed; (d) at GameEnd | Restart the game server on the same build | Restored with the same log hash; clients reconnect by themselves; the par is still owed only by the winner. On a Live table, also check CK-12 |
| R7 Stale modal | The host undoes the acting player's last action while that player has the picker, a route draft, the emergency modal or an armed home placement open; an offer answered while the other seat's prompt is open | Host Undo | Every open surface closes or re-derives; no stale control dispatches |
| R8 Two tabs, same profile | Mid-OR | Act in tab 1 while tab 2 shows the same panel; click both at almost the same moment | Tab 2 updates; one click lands, the other gets the moved-on answer; no divergence banner |
| R9 Second device | Any | Profile → Link another device (single-use code, 10 minutes) | The device holds every seat and can move |
| R10 Undo semantics | Own last action; host undoing another's; a deep jump (refused); after GameEnd (refused); across a phase change; across the B&O par | Undo | One step each; the exact prior board; the refusal sentences right |
| R11 Build guard (optional) | Between rounds | Restart on a different build, then the right one | Refused with "…dealt on build X…", then resumes |
| R12 Divergence banner | Throughout every session | — | "This tab has drifted from the room…" never appears; any appearance is P0 evidence (keep the export and the console) |

**Row result:** PASS when R1–R12 all pass (R11 may be NOT REACHED if it is skipped as optional). A FAIL on any R-row
fails AUD-19.03; list the failing R-rows.

---

## 5. Rules Reference checkpoints

### AUD-24.04 — The 12 Rules Reference checkpoints (preflight §10)

**Source:** plan Appendix A.2. **At each moment:** open the Rules Reference, press **"Go to current →"**, and record:
(1) whether it showed the right page and step; (2) whether the rule shown matches what the game just did; (3) whether it
was useful (yes/no plus a sentence); (4) a screenshot. A mismatch in substance counts as misleading copy and goes to the
owner, who confirms the intended rule. Wording that is merely not ideal does not count.

| ID | Moment | Check |
|---|---|---|
| RR-1 | Opening auction; the Delayed Auction | Auction page; the Delayed Auction notes; SV-only markdown; re-entry; escrow |
| RR-2 | SR1 | The first-Stock-Round reminder; the sale ban stated as the rule |
| RR-3 | Must-sell / certificate limit | "Only what a legal sale can fix" at every site |
| RR-4 | First OR turn, home token owed | The home-station step is marked current |
| RR-5 | Each OR step | CURRENT follows `operating_sub_phase`; Buy Private is never marked current (by design) |
| RR-6 | A route below the maximum refused | The RR-1 wording |
| RR-7 | G19 first green upgrade | The terrain exception (G19, D10 and E5 pay their printed terrain cost once) |
| RR-8 | A forced purchase, treasury only; and with the president's contribution | RR-4 (per OD-7); RR-7 |
| RR-9 | M&H exchange (own turn, queued) | RR-6 / the U-35 gotcha |
| RR-10 | Phase changes | The Tables page's live phase row; the Phase 5 private closure; the Delayed Auction phase cells |
| RR-11 | Bank broken | The bank-break timing text |
| RR-12 | GameEnd | A game-over state, not "No live round" |

**Row result:** PASS when all 12 show the right page and step and no rule mismatches in substance. Record any
checkpoint that never came up as NOT REACHED for that checkpoint.

---

## 6. Functional playtest (the 6.5 rows)

These are the 6.5 functional-playtest rows that the draft execution map named, restated from the plan.

**Source limitation.** The 6.5 preflight checklist itself (`claude/PHASE6_5_FUNCTIONAL_PLAYTEST_PREFLIGHT_2026-09-28.md`,
a Project document) is **not in this repository**, and neither the plan nor the audit restates the text of S-3, S-11,
O-1, O-8, O-9 or O-12. A-3, A-5 and S-4 are restated in full from the plan and the audit. For the other six rows,
step 1 copies the row's wording from that Project document. The rest of the procedure is fixed here.

### AUD-04.05 — (6.5 A-3 / U-2) Retest: the bar sticking on the previous step

1. Setup: a hosted (server) game, 3 seats, DevTools open on the acting seat.
2. In every operating-round hold (a discard hold, the emergency modal, a pending offer, the B&O par), reload the acting
   seat (the R1 / H-01 probes).
3. After each reload, record the bar's displayed step next to the server's `operating_sub_phase`. Read it from the log
   export or the room frame in DevTools.
4. Export the log.
5. **PASS** if the displayed step always equals `operating_sub_phase` on the server path (SI-H01). **FAIL** if the bar
   shows an earlier step: screenshot it with the matching log index.

### 6.5/A-5 — The D&H free station after a reload (AUD-06.05; a fixed B row, W1-M; regression observation)

1. The D&H owner's corporation lays the D&H tile and has not placed the free station yet.
2. Reload the acting seat. Also open the table on a second device.
3. Record whether the free station is still offered (it is now read from the board's `dh_station_pending`).
4. Place it. Export the log.
5. **PASS** if the station is offered after the reload on both surfaces and the placement lands. **FAIL** if it is
   unreachable.

### AUD-03.12 — (6.5 S-4) The UI may be stricter than the engine about turn stages

1. In SR2 or later, on one seat's turn: sell a share, then buy one, then sell again within the same turn. Then try a
   Bank Pool buy after the sale.
2. At each stage, record every control that is greyed out. Then attempt the same action with a direct submission (the
   server's answer, for example from a second tab where the control is enabled, or the console). Record the server's
   answer.
3. **PASS** if no control is greyed out when the server would accept the action. **FAIL** with a list of each greyed
   control the server accepted.

### 6.5/S-3 and 6.5/S-11 — Stock-round rows from the 6.5 checklist

1. Copy the row's wording, setup and pass condition from the 6.5 preflight into the result record.
2. Run it on the baseline at a 3-seat hosted table, as that text says.
3. Also re-observe the Phase-3 stock-round changes that the row touches: the one-click **Pass Turn** that ends a Stock
   Round turn (OD-2, AUD-03.04); the first-Stock-Round sale ban; selling an unparred granted share (K-08 / U-24); the
   Brown Bank Pool continuation, which closes on any sale (SBS-3, rules v13).
4. Record what each seat saw, the server's answer to each attempt, and a log export.
5. **PASS** if the 6.5 pass condition holds and no control disagrees with the server. Otherwise **FAIL**, with the
   divergence.

### 6.5/O-1, 6.5/O-8, 6.5/O-9 and 6.5/O-12 — Operating-round rows from the 6.5 checklist

1. Copy the row's wording, setup and pass condition from the 6.5 preflight into the result record. (These are the
   6.5 checklist's IDs. They are not the v13 emergency-funding sub-rulings O-1 to O-6.)
2. Run it on the baseline at a 3-seat hosted table, as that text says.
3. Also re-observe the Phase-3 operating-round changes that the row touches: the home-station step marked current
   (W1-I); automatic emergency funding (v13, OD-4); the train-purchase and discard flows; the bar's step against the
   server's `operating_sub_phase` on every derived skip (P3-N022).
4. Record what each seat saw, the server's answer to each attempt, and a log export.
5. **PASS** if the 6.5 pass condition holds and no control disagrees with the server. Otherwise **FAIL**, with the
   divergence.

---

## 7. Every remaining D row, by key (grouped by area)

Recovery (AUD-19.03), the Rules Reference (AUD-24.04), A-3 (AUD-04.05) and S-4 (AUD-03.12) are in sections 4–6.
Cross-browser, scale and the tile ring are in section 9. The VF rows are in section 8.

### 7.1 Auction and stock round

#### AUD-11.05 — The Delayed Auction arming line on every seat
1. Start a game with the Delayed Auction variant and 4 seats, each on its own device or profile.
2. Play to the moment the Delayed Auction arms.
3. Screenshot **every** seat, spectator included, at that moment.
4. **PASS** if every seat shows the arming line, with the same content. **FAIL** if any seat lacks it or differs.

#### AUD-24.05 — Whether the Delayed Auction's 5-train cancellation can be reached by legal play
1. In a Delayed Auction game, try to build a legal line of play (written down move by move) in which the first 5-train
   is bought before the auction resolves.
2. Record whether it was reached. If it was, record the cancellation (D-55 / DA-F9), the W2-I indicator and a log
   export. If not, record the rule that blocked the line.
3. Result: **PASS** (reached, behaving as the rule says), **NOT REACHABLE** (with the reasoning), or **FAIL** (reached,
   wrong behaviour).

#### AUD-24.03 — (K-12 stall) Whether Auto-Buy without cash stalls
1. In a Stock Round, arm Auto-Buy on a seat for a share it cannot afford.
2. Let the turn come round.
3. **PASS** if Auto-Buy disarms and gives a reason, and the turn moves on. **FAIL** on a stall or a silent disarm.

#### AUD-11.06 — (U-34) Dynamic operating order
1. Play across two ORs in which share prices change, so the operating order should re-sort.
2. Before each OR, screenshot the displayed order (including the note wording, P3-N016). Then record the order the
   corporations actually operated in, from the log export.
3. **PASS** if displayed and played order agree in both ORs. **FAIL** if they differ.

### 7.2 Operating round, map and dividends

#### AUD-04.06 — (U-12) Retest: a purchase tagged with the wrong step
1. Throughout a game, export the log (AUD-01.09) after **every** train purchase.
2. Check the step tag on each purchase entry.
3. **PASS** if every purchase carries the Buy Trains step. **FAIL** with the log index.

#### AUD-04.07 — (U-13) Retest: a laid tile appears, then vanishes
1. Screen-record two seats (the laying seat and one other) for a whole OR or more of tile lays.
2. Note any tile that appears and then vanishes, with its time and its log index.
3. **PASS** if nothing vanishes across at least 20 lays. **FAIL** with the recordings and the log index.

#### AUD-06.06 — (DH-2) Whether the D&H modal re-offers the free station later
1. Play a game in which the D&H station is placed or forfeited on its lay turn. Keep playing at least two more ORs.
2. Record any D&H station re-offer on a later turn, with its log index.
3. **PASS** if there is no later re-offer. **FAIL** with screenshots and the log index.

#### AUD-08.02 — (U-14) Retest: wrong dividend figure after undo
1. After a dividend, in Buy Trains, press Undo back past the dividend.
2. Export the log. Compare the dividend figure shown with the log's figure.
3. **PASS** if they match. **FAIL** with both figures.

#### AUD-08.03 — Dividend animation timing
1. Watch three dividend payouts at 100% UI scale and three at 63%.
2. Note the timing feel of each: too fast, right or too slow, with a sentence. The route-pulse half is VF/F-1, VF/F-2
   and VF/F-8.
3. Result: **PASS**, or **RE-TUNE** with the note.

### 7.3 Server and transport retests

#### AUD-24.01 — (U-1) Retest #1237 / #1238 on a freshly rebuilt server
1. Start a fresh server on the baseline build.
2. Scrub the history between the live frame and a past frame. Return to live. Buy a train.
3. Record the purchase toast, and whether it belongs to the live frame.
4. **PASS** if the toast is correct and on the live frame. **FAIL** otherwise.

#### AUD-24.02 — (U-9) Mirror instrumentation
1. Open two tabs for each seat for one Stock Round, and set different subpanel prices in the two tabs.
2. Capture the console of every tab and look for any `[mirror]` line.
3. **PASS** if there is no `[mirror]` line. **FAIL**, or evidence, if one appears: save it with the log export.

### 7.4 Accessibility

#### AUD-17.04 — Screen readers
1. Use NVDA on Windows (Firefox or Chrome), and VoiceOver on macOS Safari and on iOS Safari.
2. Walk: lobby → Host Game → one SR turn → one OR turn.
3. Log every control that is unlabelled or announced wrongly, and every focus trap.
4. **PASS** if no control in the walk is unlabelled. **FAIL** with the list.

---

## 8. VF playtest entries (`VISUAL_FLOURISH_BACKLOG.md`)

**One procedure for every VF row** (plan §8: "per entry: watch the named variables on the baseline at 100% and 63%
scale; pass or a re-tune note").

1. Read the entry's own section in `VISUAL_FLOURISH_BACKLOG.md` (its heading is `### <ID> · PLAYTEST`). The variables
   named there are the ones to judge.
2. Trigger the moment named in the table below, on a desktop Chromium browser, at **100%** and again at **63%** UI scale.
   Where the entry names other scales (0.63 / 1.5) or reduced motion, do those too.
3. Screen-record each trigger at 60 fps. Watch at full speed first, then frame by frame.
4. Record the result: **PASS** (reads as intended), or **RE-TUNE** with the variable and the direction ("longer",
   "darker", "drop"). A re-tune is a note for the ledger, not a code change in Phase 4.
5. Have at least one tester who did not build the flourish judge it. Where the entry asks "can a player say
   afterwards…", ask that question without prompting.

| Key | Entry | How to trigger | What to judge (the entry's named variables) |
|---|---|---|---|
| VF/C-1 | Card focus border weight | A Stock Round with ERIE active | The 2px livery border is visible as a state change, especially ERIE `#f5cd3a` on the `#f2f0eb` paper |
| VF/C-3 | Takeover length | A share purchase; then a presidency-changing purchase | Transfer 350 ms and takeover 730 ms do not drag in a click-heavy SR |
| VF/C-4 | The 200 ms resolve point | A purchase that overtakes a rival in the roster | The row glide starting at 200 ms reads as one settling motion, not two |
| VF/C-5 | The landing row's ink | A player's first purchase in a corporation | The temporary `--` row (~200 ms) reads as a destination; does it want quieter ink? |
| VF/C-9 | Reduced motion | C-3/C-4 with reduced motion on | Without the proxies and the glide, still reads as a transaction |
| VF/D-1 | Length and beats | Full tile lays (rail plus a mutation), several in one OR | The 1328 ms sequence: drags, or worth watching (judge with D-24's audio on) |
| VF/D-4 | Tension before a city changes | A lay where a city gains capacity or merges | The 0.014-hex, 136 ms shake: tension or jitter (zero it if jitter) |
| VF/D-5 | The ring pinch | A 1 → 2 split or a gathering | The union outline reads as division, not a glitch, at board scale |
| VF/D-6 | Busy merges | The New York merge (#54 → #883) and a double town into one | Reads as one city forming, not a blob, at small hex sizes |
| VF/D-7 | Tokens in a reorganising city | Reorganising a full two-slot city that holds two tokens | About 400 ms of overlap reads as the pieces gathering, not a token disappearing |
| VF/D-11 | The room round trip | A confirmed lay on a hosted table (watch the grid's return) | Nothing shifts when the flourish ends or when the server grid lands |
| VF/D-14 | Reservation markers ride with their city | A lay on a hex with a home reservation marker | A marker missing from the proposal reads as "moves", not "gone" |
| VF/D-23 | The construction wave | New rail of different lengths; forks and overpasses | The swell is visible at hex size 40; the tip reads as eruption, not a fault; rests on short rails read as building, not stutter |
| VF/D-24 | Tile-transition audio | Full lays with sound on, with the radio playing | `track` / `mutation` / commit cues read as their beats; the balance against the radio and each other |
| VF/D-25 | How long each kind of lay takes | Rail-only, a commit-only, and a mutation lay | The 128 ms hold reads as a beat, not lag; is there a quiet stretch before the reveal? |
| VF/D-26 | The proposal's wash | Choose a tile (green and brown) before confirming | Reads as provisional; rail, slots and the value can still be checked; no tier confusion beside the radial candidates |
| VF/D-27 | Planned shapes under moving parts | Splits, Baltimore / Boston / NY stubs / OO spurs migrating | Reads as one city dividing or migrating; the receded centre is not a veil |
| VF/D-28 | The commit reveal | Confirm any lay, including a green-to-brown upgrade | The 240 ms slanted front: speed, lean, the hairline reads as a commit; the value badge commits cleanly |
| VF/D-32 | Tokens are pieces seated in their stations | Lays that move tokened cities | The confirm reads as a planned place becoming a piece on its way |
| VF/D-34 | A token's planned place | Choose a tile that moves a token | 40% reads as subordinate; reads as a target, not a second token |
| VF/D-40 | The reconfiguration's head start | Baltimore (small) and OO (large) migrations; a town fusion | A quarter is enough for small, not too much for large; the track cue reads as one act |
| VF/D-39 | Three cues against a three-clip cap | A busy OR with sound on | Any commit cue missing (record the count) |
| VF/E-1 | The float ceremony's translate/scale/flip | A corporation floats in an SR (also see X-5) | The card measures a non-zero rect; the translate, `FLOAT_SCALE` and width clamp read right |
| VF/E-2 | Four float playtest variables | Floats of several liveries at typical window widths | `FLOAT_SCALE` 1.5; saturation 0.5 reads dormant on all ten liveries; stamp rotation -18°; the offset nudge |
| VF/F-1 | Signal speed and pulse duration | Run Routes: a 1–2 hex route and an 8+ hex route | A short route is a pulse, not a blink; a long one is not glacial (3.2 units/s; 0.35 s) |
| VF/F-2 | Traveling band geometry | Run Routes at typical zoom | The band is one pulse, not a smear or a dot; the glow does not bleed |
| VF/F-8 | Pop scale, timing and undershoot | Run Routes, including two routes hitting one badge together | 111% / 117% pops; 260 ms connected to the signal; the undershoot reads as settling |
| VF/G-2 | Phase badge timings | Each phase change (first 3, 4, 5, 6, D train) | The 200 / 260 ms fold reads as turning over, not text changing |
| VF/G-3 | The perspective figure | A phase change at UI scale 0.63 and at 1.5 | The `perspective(200px)` fold reads the same at both scales |
| VF/G-4 | The tint channel carries no pixels | Any phase change | Confirm that yellow / green / brown badges are the same neutral style. Nothing to tune unless the tints return; record PASS if neutral |
| VF/G-6 | The Phase 2 → 3 sequencing | Buy the first 3-train; watch the buying client and another | The badge turns before `PhaseThreeNoticeModal`; the hold feels like a beat, not a stall |
| VF/H-3 | The ticket silhouette at Action Bar scale | Show the ticket badge at 0.63 and 1.0 | Reads as a ticket, not a square badge; the chamfers and dashed rule survive 0.63 |
| VF/H-4 | The stamp's 960 ms | The bank breaks (watch a player who is looking at the board) | BANK BROKEN is noticed at all; the ~340 ms legible hold is long enough |
| VF/H-5 | The rainbow ring at badge scale | The private-power ticket beside a contested mini-auction | Eight stops in ~90 px read as the special-event language, not a muddy stripe |
| VF/H-7 | Two tickets on screen at once | An OR where both rails show the ticket | Two stamps in lockstep read as emphasis, not duplication |
| VF/I-5 | Rust timings | A rust event across several corporations (the first 4-train) | A player can say afterwards WHICH trains they lost |
| VF/I-6 | The crack at actual chip size | A rust at 0.63, 1.0 and 1.5 | Reads as broken, not dirty |
| VF/I-7 | The oxide against eight liveries | A rust on every corporation's card, especially NNH `#ee7c22` | The oxide stays visible on every livery |
| VF/I-9 | Rust outranks both warning animations | A Gentle Rust expiry (a chip that was fading) | The jump from a deep fade to oxide reads as rusting, not a glitch |
| VF/J-2 | Discard timings | A train discard over the limit | A player can say the train went somewhere, not that it was destroyed |
| VF/J-3 | The cut at actual chip size | A discard with reduced motion on, and at 0.63 | A reduced-motion reader can tell a discard from a rust |
| VF/J-8 | Two over the limit discards twice | A Phase 5 arrival leaving a fleet two over | Two cuts 500 ms apart read as two decisions; whether the Tutorial queues twice |
| VF/K-2 | The crack at uiScale 0.63 | The rust and limit badges at 0.63 | A player can tell rust from limit without reading either |
| VF/K-3 | Train chip or box | The rust-warning mark | Does anyone read it as a train without being told? |
| VF/K-5 | `4→3` beside the label | The "Train Limit Drops in 2 Buys" badge | `4→3` reads as part of the sentence, not as a mark |
| VF/K-7 | The chip in pieces | A chip breaking at 24px, at speed | A player can say the train broke, not vanished; it does not compete with the discard's cut |
| VF/K-8 | Perceptual loudness across three cues | The bank-broken, rust and train-discard cues in one session | Perceived loudness is balanced (none jumps out) at one `SFX_VOLUME` |

### VF/D-17 — Whole-board repaint while a flourish runs (performance observation)

Owner direction, 2026-10-05: this is not an implementation requirement. Only visible jank justifies a later fix, and
nothing is optimised speculatively.

1. Use realistic hardware: one ordinary desktop or laptop (record CPU and GPU) and one low-end device (an older laptop
   or a budget phone). Use Chrome, then Firefox.
2. Record a DevTools Performance trace across five full tile lays on a busy mid-game board (many laid tiles), at 100%.
3. Record the frame rate during each lay (the FPS meter, or frame times from the trace) and any visible whole-board
   hitch or repaint. Compare with W3-H's numbers: 60 fps unthrottled; 14.6 fps at 4x throttling and 10.7 fps at 6x
   (`docs/phase3/evidence/w3h/`).
4. **PASS** if the lays look smooth to the eye on ordinary hardware. **FAIL** if there is visible jank, with the trace
   and the device attached.

---

## 9. Cross-browser, scale and takeover observations

### AUD-13.08 — Firefox and Safari dialog and takeover behaviour
1. Use current desktop Firefox and macOS Safari (record the versions).
2. Open every NativeModal reachable in a game, and both takeovers (the cinematic intro and outro, X-1 / X-2).
3. For each one, check: Escape closes it (or is correctly ignored where the surface is not dismissible); Tab stays
   inside (focus trap); focus returns to the opener on close; the page behind is inert.
4. **PASS** if every surface behaves the same on both browsers as on Chrome. **FAIL** with a list per surface and
   browser.

### AUD-16.06 — Real devices: iOS, Android, desktop Firefox
1. Use an iPhone with Safari, an Android phone with Chrome, and desktop Firefox.
2. Play one full SR and one full OR on each.
3. Screenshot each screen. Note anything you could not do.
4. **PASS** if both rounds complete on each device. **FAIL** with what blocked it (phone-width layout itself is Phase 5:
   report it, don't fail on layout alone).

### AUD-16.07 — 44 px touch targets at reduced scale
1. On a phone at 63% and at 80% UI scale, measure the hit areas of the Action Bar, the tile ring and the dashboard
   controls. Use remote DevTools (element box size × device pixel ratio) or a tap test.
2. **PASS** if every target is at least 44 px. Otherwise **FAIL**, with a list of each control and its size.

### AUD-16.08 — Ctrl+wheel zoom
1. On Chrome, Firefox and Edge, step Ctrl+wheel through 50% to 200% on the lobby, an SR and an OR.
2. Record any overflow, horizontal scroll or misplaced overlay (modals, the tile ring, toasts, takeovers).
3. **PASS** if there are none. **FAIL** with screenshots at each failing zoom level.

### AUD-16.09 — The in-game SR and OR screens at phone width (observe only; OD-10(b): Phase 5)
1. At 360, 390 and 430 px wide (a real phone or DevTools device mode), play one SR turn and one OR turn.
2. Record every control that cannot be reached.
3. Result: **OBSERVED**, with the list. This is input for Phase 5, not a Phase-4 pass/fail gate.

### AUD-05.04 — The tile ring's first facing on a tokened upgrade
1. Upgrade Erie (E11) or New York, where the hex holds a token. Press Confirm **without rotating**.
2. Record the facing shown first, whether it is a legal station facing (W1-E seeds the legal facing and guards Confirm,
   P3-N010), and any refusal.
3. **PASS** if the first facing is legal and Confirm lands. **FAIL** if the ring opens on an illegal facing or Confirm
   is refused.

### X-1 — The cinematic intro at several UI scales (AUD-13.05)
1. Start a game at 63%, then 100%, then 150% UI scale.
2. Record that the intro fills the viewport with no frame or chrome showing, and that Skip and Escape work.
3. **PASS** if all three scales are clean.

### X-2 — The cinematic outro at several UI scales (AUD-13.05)
1. Reach GameEnd at 63%, 100% and 150%.
2. Record that the outro fills the viewport, and that Game Over rises over it after its cue.
3. **PASS** if all three scales are clean.

### X-3 — Keyboard blocking under a takeover (AUD-13.05)
1. During the intro and the outro, press Tab, Enter and Space repeatedly.
2. Record whether anything beneath the takeover receives focus or activates (the shell root should be `inert`).
3. **PASS** if nothing beneath reacts. Repeat on Firefox and Safari as part of AUD-13.08.

### X-4 — The corporation float ceremony now actually plays (W3-H `4c89333`)
1. Float a corporation with full motion; then repeat with reduced motion on.
2. Record: the card rises under the sticky dock, the cue sounds on its beat, and reduced motion shows the stamp.
3. **PASS** if it plays every time, on more than one seat.

### X-5 — The D-35 OO reservation marker in a real browser (VF/D-35; README "PHASE-4 PLAYTEST")
1. Lay a tile on an OO home hex that has a home reservation.
2. Record that the laid OO home shows as reserved in **both** of its cities, before and after the lay flourish, on two
   seats.
3. **PASS** if both cities show the reservation. **FAIL** with a screenshot.

---

## 10. Integration residuals

These are residuals recorded at the consolidated integration (2026-10-05) and in W3-H. Each is observed and reported,
not fixed in Phase 4.

### RES-1 — A forced notice presenting over a cinematic film
1. Arrange a forced notice to fall due while the intro or outro is playing (for example the outro at GameEnd while a
   notice is owed).
2. Record whether the notice draws over the film, and what keyboard focus does.
3. Result: **OBSERVED**, with a recording.

### RES-2 — The stale-board notice during a film holds the film's Skip
1. During the intro, make the board go stale. Drop the network as in R4, or let another seat move while this tab is
   behind.
2. Record whether the stale-board notice appears and whether Skip still works.
3. Result: **OBSERVED**, with a recording.

### RES-3 — Focus after the chain ends under an interim tutorial or a takeover (AUD-13.02 / AUD-13.04)
1. End a notice chain while a tutorial coach mark or a takeover is showing.
2. Record where keyboard focus lands. The planned focus move is dropped in this case.
3. Result: **OBSERVED**, with the focused element.

### RES-4 — Bar step against the server step on derived skips (P3-N022; plan §8 observation column)
1. Through one whole game, each time the bar skips a step on its own (a derived skip), compare the bar's step with the
   server's `operating_sub_phase`.
2. Record every mismatch with its log index. Also record the frame rate during a lay, as the §8 column asks.
3. Result: **OBSERVED**, with any mismatches listed.

### RES-5 — A silent fog replacing an audible haunting holds the radio duck (W3-H recorded residual)
1. Play with the radio and SFX on until a fog replaces a haunting.
2. Time how long the radio stays ducked with nothing audible.
3. Result: **OBSERVED**. The recorded expectation is at most ~6 s.

---

## Index

**D rows (70).** Each D key appears once above with its procedure.

| Key | Section |
|---|---|
| AUD-03.12 | §6 Functional playtest (6.5 S-4) |
| AUD-04.05 | §6 Functional playtest (6.5 A-3) |
| AUD-04.06 | §7.2 Operating round, map and dividends |
| AUD-04.07 | §7.2 Operating round, map and dividends |
| AUD-05.04 | §9 Cross-browser, scale and takeover |
| AUD-06.06 | §7.2 Operating round, map and dividends |
| AUD-08.02 | §7.2 Operating round, map and dividends |
| AUD-08.03 | §7.2 Operating round, map and dividends |
| AUD-11.05 | §7.1 Auction and stock round |
| AUD-11.06 | §7.1 Auction and stock round |
| AUD-13.08 | §9 Cross-browser, scale and takeover |
| AUD-16.06 | §9 Cross-browser, scale and takeover |
| AUD-16.07 | §9 Cross-browser, scale and takeover |
| AUD-16.08 | §9 Cross-browser, scale and takeover |
| AUD-16.09 | §9 Cross-browser, scale and takeover |
| AUD-17.04 | §7.4 Accessibility |
| AUD-19.03 | §4 Recovery R1–R12 |
| AUD-24.01 | §7.3 Server and transport retests |
| AUD-24.02 | §7.3 Server and transport retests |
| AUD-24.03 | §7.1 Auction and stock round |
| AUD-24.04 | §5 Rules Reference checkpoints |
| AUD-24.05 | §7.1 Auction and stock round |
| VF/C-1, VF/C-3, VF/C-4, VF/C-5, VF/C-9 | §8 VF playtest entries (table) |
| VF/D-1, VF/D-4, VF/D-5, VF/D-6, VF/D-7, VF/D-11, VF/D-14 | §8 VF playtest entries (table) |
| VF/D-23, VF/D-24, VF/D-25, VF/D-26, VF/D-27, VF/D-28 | §8 VF playtest entries (table) |
| VF/D-32, VF/D-34, VF/D-39, VF/D-40 | §8 VF playtest entries (table) |
| VF/D-17 | §8 VF playtest entries (own heading: performance) |
| VF/E-1, VF/E-2 | §8 VF playtest entries (table) |
| VF/F-1, VF/F-2, VF/F-8 | §8 VF playtest entries (table) |
| VF/G-2, VF/G-3, VF/G-4, VF/G-6 | §8 VF playtest entries (table) |
| VF/H-3, VF/H-4, VF/H-5, VF/H-7 | §8 VF playtest entries (table) |
| VF/I-5, VF/I-6, VF/I-7, VF/I-9 | §8 VF playtest entries (table) |
| VF/J-2, VF/J-3, VF/J-8 | §8 VF playtest entries (table) |
| VF/K-2, VF/K-3, VF/K-5, VF/K-7, VF/K-8 | §8 VF playtest entries (table) |

**Other Phase-4 items.**

| ID | Section |
|---|---|
| P4-E1 Any-count escrow correction (early implementation task) | §1 |
| P4-M1 Real-wallet funded games | §2 |
| P4-M2 Settlement, REMEDY, disputes on Escrow 2.1 | §2 |
| P4-M3 Host ante race | §2 |
| P4-M4 Ante approval count | §2 |
| CK-1 … CK-16 Live / Async / No-deadline clocks | §3 |
| R1 … R12 (under AUD-19.03) | §4 |
| RR-1 … RR-12 (under AUD-24.04) | §5 |
| 6.5/A-5 (AUD-06.05 regression), 6.5/S-3, 6.5/S-11, 6.5/O-1, 6.5/O-8, 6.5/O-9, 6.5/O-12 | §6 |
| X-1 Intro, X-2 Outro, X-3 Keyboard blocking, X-4 Float ceremony, X-5 D-35 marker | §9 |
| RES-1 … RES-5 Integration residuals | §10 |
