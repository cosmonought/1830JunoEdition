# Batch 7.1 — the authoritative money ledger and the permanent bank-break latch

Date: 2026-09-15. Baseline: Batch 6 committed (`215eb29c7bf9f35f42b96f58d5363bc6b2d7ecbd`), `RULES_ENGINE_VERSION`
**4 — deliberately not bumped** (the bump belongs to Batch 7.5 after all Stage-7 semantics land).
Design: `BATCH7_TRANSACTION_AUTHORITY_DESIGN_2026-09-15.md` §7.1 / §7.1a, owner rulings D-15 (Q1a/Q1b).
**Revision 2 (2026-09-15, after review).** Two narrow review points resolved: §9 now *proves* that the one field
a refused purchase used to touch is pre-existing normalisation and not a mutation of the transaction (and the
primary cases now assert literal whole-state equality); §5a closes a real defect the review found — a **credit
could un-break a legacy board** whose break lived only in its balance. The corpus is byte-identical to
revision 1's sweep; nothing else changed.
**Nothing is committed. The full Jest suite was not run. No golden fixture or pinned expectation was re-pinned.**

> **Bottom line.** The three floored adjusters are gone. Every debit and credit in the engine goes through one
> ledger, and after it the **whole corpus conserves money after every replayed entry** — eighteen log files,
> twelve rooms, with exactly two by-design exceptions (`SetupGame`'s deal, and JUNO-Z6C 203's Yellow Sign award,
> which is S9-1 and stays Stage 9's). Auction proceeds and terrain fees now reach the Bank; the Bank is a signed
> integer; a bank debit that leaves the balance at or below zero writes a permanent `bank_broken` latch that no
> credit clears. Four new suites, 81 tests, all passing. Three corpus logs diverge in gameplay because 26
> unaffordable purchases now refuse instead of minting — reported below with exact indices, **not** absorbed.

---

## 1. Files changed

| File | What |
|---|---|
| **`frontend/src/gameEngine/cashLedger.ts`** (new, 342 lines) | The ledger: accounts, primitives, `transfer`, the bank-break latch, `moneyTotal` / `moneyConservationBreach` / `assertMoneyConserved`. Design notes #1560 / #1561 / #1562. |
| `frontend/src/gameEngine/sandboxSession.ts` | `adjustCash` / `adjustBank` / `adjustTreasury` **deleted**; 21 money movements migrated; `transferPrivateToCorporation` hardened (#1563); the auction's inline charge loop replaced; four stale design-note sentences corrected to the past tense. |
| `frontend/src/gameEngine/endgame.ts` | `bankIsBroken` reads the latch first and keeps the balance test as the legacy fallback (#1561). |
| `frontend/src/gameEngine/gameState.ts` | `bank_broken?: true` on `GameStateResponse`, with its note. |
| `frontend/src/gameEngine/index.ts` | The ledger exported on the engine's surface. |
| **`frontend/src/utils/cashLedger.test.ts`** (new) | 28 tests — the primitives, the refusals, the signed bank, the latch, the harness. |
| **`frontend/src/utils/bankBreakLatch.test.ts`** (new) | 14 tests — S7-20's regression matrix through `applySandboxAction` and `replayLog`. |
| **`frontend/src/utils/moneyConservation.test.ts`** (new) | 33 tests — the corpus sweep, the auction and terrain bank credits, the private-transfer rules. |
| **`frontend/src/utils/refusalAtomicity.test.ts`** (new) | 6 tests — a refused purchase mutates nothing (added at the owner's request, §9). |
| `frontend/src/utils/trainPurchaseGate.test.ts`, `batch33.test.ts`, `batch40.test.ts` | One fixture field renamed in each — see §10 (a). |
| `RULES_HARDENING_BACKLOG.md` | S7-1, S7-10, S7-12, S7-20 updated; U-20 / U-21 / U-25 / U-27 annotated; **U-29 filed**. |
| **`BATCH7.1_MONEY_LEDGER_2026-09-15.md`** (new) | This report. |

**Untouched, and not read:** `frontend/src/components/RulesReference.tsx`, `frontend/src/utils/audio.ts` and the
`rules*.test.tsx` files. The working tree grew further owner work *during* this batch —
`frontend/src/App.tsx`, `components/StockRoundPanel.tsx`, `utils/privateCatalog.ts`,
`utils/privateOfferRow.test.ts`, `utils/privateCardText.test.ts`, `utils/powerRefusalAndChips.test.ts`, and new
`components/FlightGhostLayer.tsx`, `utils/flightAnchor.ts`, `utils/shareMovement.ts`,
`components/rulesAuction.test.tsx`, `components/rulesTables.test.tsx`. **None of it was read or modified by this
batch**, and the focused validation in §8 was run against the tree as it stood at the time each suite ran.

---

## 2. The ledger API

`frontend/src/gameEngine/cashLedger.ts`. Every function is pure and returns a value; **nothing throws except
`assertMoneyConserved`, which is a test instrument.** The reducer appends before it applies (#1250), so a throw
inside a money movement would leave a durable log entry that crashes every rebuild after it.

```ts
type MoneyAccount = { player: string } | { corporation: number } | "bank";
const BANK = "bank";

type LedgerResult =
  | { ok: true;  state: GameStateResponse }
  | { ok: false; reason: string };            // a whole sentence, for an ingress refusal

// Readers. `null` means "this board has no such account", which is NOT zero.
playerCashOf(state, player): number | null
treasuryOf(state, companyId): number | null
bankFundsOf(state): number | null            // may be negative after the break

// Primitives. `amount` must be a finite, whole, non-negative number of VGP.
debitPlayer(state, player, amount): LedgerResult      // refuses when cash < amount
creditPlayer(state, player, amount): LedgerResult     // refuses an unknown payee
debitTreasury(state, companyId, amount): LedgerResult // refuses when treasury < amount
creditTreasury(state, companyId, amount): LedgerResult
debitBank(state, amount): LedgerResult                // never refuses for insufficiency; LATCHES
creditBank(state, amount): LedgerResult                // never un-latches

// One debit and its matching credit, or nothing at all.
transfer(state, from: MoneyAccount, to: MoneyAccount, amount): LedgerResult

// The conservation harness.
moneyTotal(state): number                                  // bank + every cash + every treasury
moneyConservationBreach(before, after): string | null       // never throws
assertMoneyConserved(before, after, label?): void           // test-only; throws
isPlayerAccount(a) / isCorporationAccount(a)
```

Rules the API enforces, each replacing a specific failure of `Math.max(0, current + delta)`:

1. **Whole, non-negative amounts.** Direction is carried by which function is called, never by the sign — a
   negative "debit" is a credit in disguise, which is exactly how `BuyPrivateCompany` with `price: "-500"` paid
   the buyer $500 out of the seller's pocket. A fraction refuses too: `Uint128` is whole.
2. **A player or corporation debit the balance cannot cover refuses.** No overdraft: §6.1's "Purchases must be
   made with available money. Credit is not allowed."
3. **The Bank is signed** (D-15/Q1b). It has no affordability rule; when it runs out it keeps paying and the
   balance goes negative, which is the only representation in which the total on the table is conserved and
   therefore testable. m11's "paper tracking" is withdrawn.
4. **A credit needs a payee that exists.** An unknown player or corporation refuses rather than absorbing the
   money — the "seller missing, money disappears" path (S7-12).
5. **`transfer` is atomic.** The debited board is a local value, so a refused credit is a refused transfer and
   the caller still holds the board it handed in. The refusal names the payer it took nothing from.
6. **A movement between one account and itself is a no-op**, not a refusal — it netted to zero under the old
   adjusters too, and whether the two ends *may* be the same is a rule (7.4 / 7.5), not arithmetic.
7. **A credit never un-breaks the bank, including a legacy board.** Both writes of the balance go through one
   private `withBankBalance`, which materialises `bank_broken` on either of two conditions: the debit that
   exhausts the bank, **or** a write to a board that `bankIsBroken` already answered `true` for. See §5a.
8. **One lenient case, deliberately:** an *unreadable* `virtual_bank_vgp` is read as $0 for the bank's own
   arithmetic (as `adjustBank` read it), because the Bank is never asked "can you cover this". The latch is
   **not** written in that case — #232: a board that never said what the bank held cannot be said to have run
   out of it. Money still conserves, because `moneyTotal` skips a non-finite bank and "skipped" and "zero" are
   the same number on both sides. A *player* or *treasury* with no readable balance still refuses, because that
   is an affordability question and an unreadable balance cannot answer yes.

**The ledger is the boundary, not the rule.** Affordability remains an explicit predicate in front of the
transaction. Where one already exists (`trainPurchaseRefusal` #1019/#1512, `stationPlacementGate` #1511, the
terrain gate #891, `kanawhaLicenseRefusal` #1323, `dieselExchangeRefusal`, the Batch-5 emergency gates), the
ledger's refusal is unreachable and nothing about the game changes. Where one does not exist yet — the stock
purchase, the ordinary private purchase, the intercorporate train sale — the ledger refuses instead of minting,
and Batches 7.2 / 7.3 / 7.4 put the rule in front of it. A later batch that adds the predicate must not remove
the boundary.

---

## 3. Every migrated money mutation site

21 movements, all in `sandboxSession.ts`. "Gate in front" names the predicate that makes the ledger's refusal
unreachable in play; "ledger only" marks the three transactions whose rule is a later batch's.

| # | Line | Movement | From → To | Gate in front | Change |
|---|---|---|---|---|---|
| 1 | 1632 | `buyDepotTrain` | treasury → Bank | `trainPurchaseRefusal(requireFunds)` | floor removed; all-or-nothing |
| 2 | 1687 | `buyReturnedTrain` | treasury → Bank | `returnedTrainRefusal` | floor removed; the returned list is not spliced on a refusal |
| 3 | 1714 | `settleTrainSale` | buyer treasury → seller treasury | **ledger only** (S7-5 is 7.4) | **money moves first**, so the train cannot be delivered against a floored payment |
| 4 | 2460 | auction charges (`applyAuctionStep`) | player → **Bank** | **ledger only** (escrow rules are 7.3) | **bank now credited**; inline `Math.max(0, …)` gone; all-or-nothing for the step |
| 5 | 3669 | `transferPrivateToCorporation` | treasury → **player** seller | `fundingPrivateSaleRefusal` for D-5; **ledger only** for the ordinary purchase (S7-6 is 7.4) | player seller required; no corp→corp; no negative/fractional price |
| 6 | 3990 | `BuyKanawhaLicense` | treasury → Bank | `kanawhaLicenseRefusal` | floor removed |
| 7 | 4284 | `BuyStock` | player → Bank | **ledger only** (S7-13 / D-17 are 7.2) | floor removed; **no actor → no money moves at all** |
| 8 | 4434 | `SellStock` | Bank → player | `shareSaleBlock`, forced-sale rules | bank may go negative and **latches**; no actor → no movement |
| 9 | 4668 | `LayTile` terrain fee | treasury → **Bank** | #891 (`treasury ≥ fee`), unchanged | **bank now credited**; a refused transfer refuses the whole lay |
| 10 | 4699 | `ExchangeTrainForDiesel` | treasury → Bank | `dieselExchangeRefusal` → `trainPurchaseRefusal` | floor removed |
| 11 | 4835 | `EmergencyBuyHardware` president contribution | president → treasury | #1513 cash check | floor removed |
| 12 | 4871 | funded intercorporate trade (D-6) | president → buyer treasury | `fundedTradeRefusal` | floor removed; a refusal leaves the offer retired and the money alone |
| 13 | 4936 | `PlaceStationToken` | treasury → Bank | `stationPlacementGate` (#1511) | floor removed; a refusal places no token |
| 14 | 5413 | `DeclareDividends` withhold | Bank → treasury | `dividendRefusal`, `dividendAmountRefusal` | bank may go negative and **latches** |
| 15–17 | 5433 / 5437 / 5442 | `DeclareDividends` distribute | Bank → players, Bank → treasury (pool slice) | as above | one bank debit for the whole payout (#329/#376's shape, kept), then the credits; **latches** |
| 18 | 5536 | `applyFloatThreshold` capitalisation | Bank → treasuries | float rule | one debit for the pass; **latches**; a refusal floats nobody |
| 19–21 | 5723 / 5728 / 5729 | `applyPrivateRevenue` | Bank → players / treasuries | — | debit first, then the credits, so the pass conserves exactly; **latches**; a refusal pays nobody *and reports nothing owed* |

Sites **not** touched, recorded so the omission is deliberate: the Yellow Sign cash award
(`sandboxSession.ts` "stage === mark") still writes a treasury directly with no payer. It is the last minting
rule in the engine and it is **S9-1, Stage 9's**, explicitly out of this batch's scope.

---

## 4. Proof that auction proceeds and terrain costs now reach the Bank

Asserted on the **frozen** `__fixtures__/replayGolden/logs/JUNO-CV4.log.jsonl`, so the assertions name indices
(`moneyConservation.test.ts`):

**Auction** — seven charges, $755 credited to the Bank, nothing destroyed:

| idx | message | bank delta | money on the table |
|---|---|---|---|
| 1 | `WaterfallBuyLowest` | **+$20** | unchanged |
| 2 | `WaterfallBuyLowest` | +$40 | unchanged |
| 3 | `WaterfallBuyLowest` | +$70 | unchanged |
| 6 | `WaterfallBuyLowest` | +$110 | unchanged |
| 8 | `WaterfallMiniAuctionPass` (the win) | **+$135** | unchanged |
| 9 | `WaterfallBuyLowest` | +$160 | unchanged |
| 10 | `WaterfallBuyLowest` | +$220 | unchanged |

A **$0** acquisition — the Schuylkill Valley marked to nothing and taken by the next seat (#271) — transfers $0
and is unchanged, which is the point of routing it through the same call (`cashLedger.test.ts`, "allows exactly
zero, which moves nothing").

**Terrain** — three lays, each $80 out of the treasury and $80 into the Bank, the fee still charged once per hex
(#723) and the #891 affordability gate untouched:

| idx | message | treasury delta | bank delta | money |
|---|---|---|---|---|
| 27 | `LayTile` | −$80 | **+$80** | unchanged |
| 78 | `LayTile` | −$80 | **+$80** | unchanged |
| 163 | `LayTile` | −$80 | **+$80** | unchanged |

Across the corpus: auction credits of $830 (8E8), $755 (CV4), $745 (CW7), $740 (FCJ), $750 (G6J), $140 (JJD),
$620 (QVC), $645 (3XD's first contested cascade), $745 (Z6C); terrain credits in CV4 (3), CW7 (2), FCJ (1),
Z6C (8: idx 41/102/123/233 at $80, 239/246 at $120, 269 at $60, 281 at $80), 3XD (2), QVC (2).

---

## 5. The bank-break latch (S7-20)

**Implementation.** `cashLedger.debitBank` writes `bank_broken: true` the first time a debit leaves the balance
at or below zero. Nothing else in the engine writes the field, and nothing clears it — no credit, no arm, no
settlement, no revert-specific code. `bankIsBroken(state)` is now
`state.bank_broken === true || Number(state.virtual_bank_vgp) <= 0`; `settleRoundTransitions` keeps its single
ask in the `operating_round_just_ended` branch and #898's timing is unchanged in shape.

Three details worth stating because they are easy to get wrong:

- **"Leaves ≤ 0" is about the debit's result.** A credit that lifts the bank from −$20 to $80 latches nothing
  (credits do not latch at all); a debit from −$20 to −$50 "leaves ≤ 0" and latches, which costs nothing because
  the latch is already set.
- **A zero debit never latches.** The bank is exhausted *by a payout*, not by a message that pays nobody —
  otherwise the field would be a restatement of the balance rather than a record of an event.
- **Absent means "never broken"; `false` is never written.** #232's rule, so the field joins the digest only
  where the fact exists and every pre-7.1 board keeps the digest it had. The balance half of `bankIsBroken` is
  kept for exactly that population — fixtures, legacy logs, hand-built boards.

### 5a. A credit may not un-break a legacy board (review point 2 — a real defect, now fixed)

**The defect.** `creditBank` added to the balance and wrote nothing else. On a board dealt after 7.1 that is
harmless: the latch is already set and the credit carries it. On a **legacy** board the only record of the
break *is* the balance — and a credit overwrites exactly that. Verified against revision 1:

```
legacy bank = "-20", no `bank_broken` field   -> bankIsBroken TRUE
  creditBank(+100)                            -> bank "80", bank_broken undefined, bankIsBroken FALSE   ✗
legacy bank = "0",  no `bank_broken` field    -> bankIsBroken TRUE
  creditBank(+100)                            -> bank "100", bank_broken undefined, bankIsBroken FALSE  ✗
```

So D-15's "bank credits never un-latch it" held for boards dealt after this batch and failed quietly for every
stored one — the receipt that ended the bank's trouble also erased the record of it.

**The fix.** Both balance writes now go through one private `withBankBalance(state, next, brokenByThisWrite)`,
which sets the field when *either* the write is the debit that exhausts the bank *or*
`bankIsBroken(state)` was already true before it. `bankIsBroken` is **imported from `endgame.ts`** rather than
re-spelled, so there remains exactly one definition of "broken" (`endgame.ts` imports only the state type, so
there is no cycle). After the fix both rows above end `bank "80"/"100", bank_broken true, bankIsBroken true`.

This is **not a reinterpretation of a stored board**: `bankIsBroken` answered `true` before the receipt and
answers `true` after it. What changed is that the answer survives the next receipt. And it is **not a replay
change beyond S7-20**: no bank in the corpus ever reaches zero (the lowest is $8,592), so the re-run sweep is
**byte-identical, step for step, to revision 1's** — no log materialises a latch.

Two boundaries preserved deliberately: a **solvent** legacy board acquires no field (the carry-forward must not
invent a break), and an **unreadable** balance acquires none either — `bankIsBroken` requires a finite number,
so the lenient case of §2 rule 8 is untouched. One consequence worth naming: a **zero** debit against an
already-broken legacy board now materialises the latch, where revision 1 left it absent. That is the correct
answer (the board was already broken) and it is unreachable in play — every zero-amount payout path returns
before it reaches the ledger — so the "a zero debit never breaks the bank" rule is now stated where it belongs,
of a *solvent* bank.

**Regressions** — 5 in `cashLedger.test.ts` (credit onto −$20; credit onto exactly $0; the same through
`transfer(player → BANK)`, which is how every real receipt arrives; no field on a solvent legacy board; no field
on an unreadable balance) and 4 in `bankBreakLatch.test.ts` through the reducer: `bank -$20, no latch → a $100
share purchase → bank $80, bank_broken true, bankIsBroken true, and the OR set still reaches GameEnd`; the same
from exactly zero; a control with the materialisation stripped that plays on into a Stock Round (so the two
cases above cannot be read as pinning something already true); and a solvent legacy board that acquires nothing.

**Tests** — `bankBreakLatch.test.ts`, 18 cases, every one through `applySandboxAction` or `replayLog` (a test
that wrote the field by hand would pin the field and not the mechanism):

| Case | Asserted |
|---|---|
| **The required regression** | bank $10 → `DeclareDividends` $30 → `virtual_bank_vgp` `-20` and `bank_broken: true` → `BuyStock` $100 → `virtual_bank_vgp` `80` and **still** `bank_broken: true` → `PassTurn` at the set boundary → `GameEnd` |
| The control | the same board with the field stripped plays on into a Stock Round — so the regression cannot be read as pinning a coincidence |
| Conservation | `moneyTotal` identical across the whole break-and-recovery sequence |
| Exact zero | a $30 payout from a $30 bank latches, and ends the set in `GameEnd` |
| Solvent payout | $30 from $31 leaves `bank_broken` **undefined** and opens a Stock Round |
| Deeper payout | a second $30 dividend → `-50`, still latched |
| Later receipts | one and then two share purchases lift the bank above zero; still latched, `bankIsBroken` still true |
| Legacy board (no field) | non-positive balance → broken and `GameEnd`; positive → solvent and Stock Round; and a solvent board does **not** acquire the field merely by being played on |
| `RevertTo` | through `replayLog`: with the payout in the effective log the rebuild latches; with a `RevertTo` dropping it the rebuild has **no field at all** and the bank is back at $10; and the game the reverted payout would have ended is un-ended |
| **Legacy board, already broken, then a receipt** | bank −$20 and bank $0, neither carrying the field: a $100 share purchase leaves the bank solvent, **`bank_broken: true`**, and the set still ends in `GameEnd`; plus a stripped-latch control that plays on, and a solvent legacy board that acquires nothing (§5a) |
| Badge vs reducer (U-27) | `App.tsx` imports `bankIsBroken` from `gameEngine/endgame`, draws the badge from `bankIsBroken(gameState)`, and **contains no `bank_broken` of its own**; the reducer likewise names only `bankIsBroken(state)`; the field is written in exactly one place in `cashLedger.ts`. Plus the behavioural half: the one board where a duplicate rule would disagree — a latched bank with a solvent balance — answers the badge and the reducer identically |

**Corpus:** **no stored log latches.** The lowest bank balance across all eighteen files rises from **$7,239**
(old engine, Z6C) to **$8,592** — the auction and terrain money the Bank never used to receive. No stored game's
ending moves.

---

## 6. Conservation harness result

`moneyTotal(state)` = Bank + every player's cash + every corporate treasury. Nothing else holds VGP: auction bids
are escrowed rather than spent (the bid list *is* the escrow, #334a), and shares, trains and privates are not
money.

`moneyConservation.test.ts` replays **every log file in the repository** and compares `moneyTotal` across every
applied entry. Eighteen files, twelve rooms, named in the suite so a log that stops being swept fails the test
rather than quietly shrinking it:

| Source | Files |
|---|---|
| `__fixtures__/replayGolden/logs/` | `golden/JUNO-7NZ`, `golden/JUNO-CV4`, `golden/JUNO-G6J` |
| `server/data/` | `server/JUNO-7NZ`, `JUNO-8E8`, `JUNO-CV4`, `JUNO-CW7`, `JUNO-FCJ`, `JUNO-G6J`, `JUNO-TQQ`, `JUNO-Z6C` |
| `frontend/sandbox-log-*.json` | `export/JUNO-3XD`, `JUNO-CV4`, `JUNO-JJD`, `JUNO-QVC`, `JUNO-Y8V` |
| test fixtures | `prefix/JUNO-FCJ-96` (FCJ's first 96 entries), `fixture/JUNO-Z6C-494` (Z6C through index 494) |

**Reconciling the counts.** Twelve *rooms*: 3XD, 7NZ, 8E8, CV4, CW7, FCJ, G6J, JJD, QVC, TQQ, Y8V, Z6C.
Eighteen *files*, because four are second copies or prefixes: the three `replayGolden` logs are frozen copies of
`server/data` logs (byte-identical today), `sandbox-log-JUNO-CV4.json` is a **shorter client-side capture** of
the same room (120 applied entries against the store's 141 — not a duplicate), and the two fixtures above are
prefixes. All four are swept separately and named by path, because a prefix reaches different boards from the
full log and a stale copy is exactly what a sweep should notice. The design report's "17 logs" counts the same
files minus `__fixtures__z6cLog.json`, which it did not have in view; the §9 table there names the same twelve
rooms. **My own earlier status message said "13 logs" and named twelve — that was the node-side probe's count
(8 server + 5 exports, with the two CV4 copies counted separately and the frozen and fixture copies not swept
at all). The suite's eighteen is the correct figure and the list above is the correct enumeration.**

**Result: every one of the eighteen conserves money after every replayed entry, with two exceptions and no
others.**

| Exception | Where | Why it is allowed |
|---|---|---|
| `SetupGame` | every log, idx 0 | the deal puts the money on the table |
| `YellowSignEvent` | **JUNO-Z6C idx 203, +$90** | the Mark's cash award has no payer. Stage 9 / **S9-1**, deliberately not fixed here |

The Yellow Sign is asserted **positively** rather than exempted silently: one case pins that JUNO-Z6C's complete
list of non-`SetupGame` minting entries is exactly `["203 YellowSignEvent +90"]`, so if S9-1 is ever closed this
test fails and the exemption comes out with it.

**Nothing else was found.** Under the Batch-6 engine, over the thirteen files the old-versus-new comparison
of §7 covered, the same invariant failed, excluding `SetupGame`: **22** non-conserving
entries in `server/JUNO-FCJ`, **27** in `server/JUNO-Z6C` (one of which is the Yellow Sign, which stays),
**16** in `export/JUNO-3XD`, **10** in `server/JUNO-CV4`, **9** in `export/JUNO-CV4`, **8** in `server/JUNO-CW7`,
**8** in `export/JUNO-QVC`, **7** in `server/JUNO-8E8`, **4** in `server/JUNO-G6J`, **3** in `export/JUNO-JJD`,
and none in 7NZ, TQQ or Y8V (which hold no completed auction) — every one an auction purchase the Bank was never
credited for, a terrain fee paid to nobody, or a share bought with money the buyer did not have. **114 in
total across those thirteen; one remains in each of the two JUNO-Z6C copies, and it is the Yellow Sign.**

---

## 7. Corpus first-difference table for 7.1 — filed for the Batch 7.5 sweep, **not** absorbed

Method: the Batch-6 tree at `215eb29` and the 7.1 tree were each compiled (`server/tsconfig.json`, which emits
the whole engine) and every log replayed through both, capturing `stateDigest` and `moneyTotal` before every
applied entry and at the end. The "first difference" is the first entry whose *result* differs.

### 7a. The four categories, and which logs each touches

| Category | Effect | Logs |
|---|---|---|
| **Auction proceeds credited** | the Bank gains the whole auction, from the first purchase onward | every log with an auction purchase: 8E8, CV4 (all three copies), CW7, FCJ, G6J, JJD, QVC, Z6C, 3XD |
| **Terrain fees credited** | the Bank gains each fee at the lay | CV4 (27, 78, 163), CW7 (58, 65), FCJ (70), Z6C (41, 102, 123, 233, 239, 246, 269, 281), 3XD (36, 59), QVC (28, 50) |
| **Signed bank** | no balance in the corpus goes below zero, so this changes no stored board; the lowest point rises from $7,239 to $8,592 | none |
| **`bank_broken` first latched** | **never, in any log** | none |
| *(fifth, reported because it is a difference)* **unaffordable purchases refused** | 26 entries that used to mint | FCJ, Z6C, 3XD only |

### 7b. Per log

| Log | First difference | Cause | Final bank | Fields differing at the end |
|---|---|---|---|---|
| `server/JUNO-7NZ` | **none — identical at every step** | — | $9,600 → $9,600 | 0 |
| `server/JUNO-TQQ` | **none — identical** | — | $9,600 → $9,600 | 0 |
| `export/JUNO-Y8V` | **none — identical** (0 entries applied) | — | $9,600 → $9,600 | 0 |
| `server/JUNO-8E8` | after **idx 1** `WaterfallBuyLowest` | auction proceeds | $18,100 → $18,930 (+$830) | **1: `virtual_bank_vgp`** |
| `server/JUNO-CV4` | after **idx 1** `WaterfallBuyLowest` | auction proceeds | $8,516 → $9,511 (+$995 = $755 auction + $240 terrain) | **1: `virtual_bank_vgp`** |
| `server/JUNO-CW7` | after **idx 1** `WaterfallBuyLowest` | auction proceeds | $17,269 → $18,174 (+$905) | **1: `virtual_bank_vgp`** |
| `server/JUNO-G6J` | after **idx 1** `WaterfallBuyLowest` | auction proceeds | $8,050 → $8,800 (+$750) | **1: `virtual_bank_vgp`** |
| `export/JUNO-CV4` | after **idx 1** `WaterfallBuyLowest` | auction proceeds | $8,572 → $9,487 (+$915) | **1: `virtual_bank_vgp`** |
| `export/JUNO-JJD` | after **idx 1** `WaterfallBuyLowest` | auction proceeds | $9,600 → $9,740 (+$140) | **1: `virtual_bank_vgp`** |
| `export/JUNO-QVC` | after **idx 1** `WaterfallBuyLowest` | auction proceeds | $8,742 → $9,522 (+$780) | **1: `virtual_bank_vgp`** |
| `server/JUNO-FCJ` | after **idx 1** `WaterfallBuyLowest` (bank); **gameplay from idx 106** | auction proceeds, then a refused unaffordable `BuyStock` | $15,688 → $16,474 | 10 |
| `server/JUNO-Z6C` | after **idx 2** `WaterfallBuyLowest` (bank); **gameplay from idx 193** | auction proceeds, then a refused unaffordable `BuyStock` | $7,643 → $9,554 | 19 |
| `export/JUNO-3XD` | after **idx 7** `WaterfallBuyLowest` (bank); **gameplay from idx 28** | auction proceeds, then a refused unaffordable `BuyStock` | $8,466 → $9,140 | 18 |

Nine of the twelve rooms differ **in the bank field and nothing else** — no gameplay change whatsoever, which is
the positive result: trains, tokens, dividends, revenue, float, the emergency paths and every Batch-6 route
decision replay identically.

### 7c. The 26 entries the ledger now refuses, with the reason

Every one is a debit the account could not cover, taken from a ledger-refusal trace of the whole corpus. Each is
followed by the cascade its refusal causes on an already-diverged board — those cascades are *consequences*, not
separate findings, and Batch 7.5 will re-pin them together.

| Log | Message | Indices | Example reason |
|---|---|---|---|
| `export/JUNO-3XD` | `BuyStock` ×20 | 28, 31, 204, 205, 208, 209, 211, 212, 216, 285, 289, 290, 291, 292, 293, 294, 295, 297, 299, 300 | `p-h96t6pld holds $60 and cannot pay $100.` |
| `export/JUNO-3XD` | `BuyPrivateCompany` ×1 | 112 | `NNH's treasury holds $0 and cannot pay $70.` |
| `server/JUNO-FCJ` | `BuyStock` ×3 | 106, 109, 181 | `p-raylt1ra holds $85 and cannot pay $180.` |
| `server/JUNO-Z6C` | `BuyStock` ×2 | 193, 264 | `p-lzjh2r6u holds $111 and cannot pay $200.` |

**This fifth category is a difference the design's §9 attributes to Batch 7.2's `stockPurchaseRefusal`, and it
arrives in 7.1 instead.** It is not a scope change: the batch's own acceptance criterion is the conservation
invariant over the corpus, and that invariant cannot hold while an unaffordable purchase mints the difference.
7.2 will put the *rule* — with its ingress sentence — in front of the boundary that already refuses.
**No expectation, fixture or golden has been re-pinned; §8 lists the five that now fail and why.**

---

## 8. Validation

**Only focused suites were run. The full Jest suite was not run.**

### 8a. New suites — 95 tests, 95 passed, 0 failed, 0 skipped, 0 snapshots

| Suite | Tests | Revision 1 |
|---|---|---|
| `utils/cashLedger.test.ts` | **33** passed | 28 (+5 for §5a) |
| `utils/bankBreakLatch.test.ts` | **18** passed | 14 (+4 for §5a) |
| `utils/moneyConservation.test.ts` | **33** passed | 33 |
| `utils/refusalAtomicity.test.ts` | **11** passed | 6 (+5 for §9a) |
| **total** | **95 passed / 95 total** | 81 |

*(An earlier status message of mine said "68" and then "28 + 14 + 27 = 69". Both were wrong: 27 was a stale count
for `moneyConservation.test.ts`, which became 33 when the corpus sweep was widened to all eighteen files, and
`refusalAtomicity.test.ts` did not exist yet. The figures above are the executed counts.)*

### 8b. Existing suites — 56 run, 52 pass, 4 fail (6 cases) for a known and reported reason

Passing (every suite that exercises a migrated money path): `bankBreak`, `bankBreakEnding`, `moneyVocabulary`,
`cashDelta`, `closeRoomPayout`, `atomicReducer`, `emergencyFunding`, `emergencyTrainFlow`, `trainLifecycle`,
`trainOffer`, `trainPurchaseGate`, `trainDiscard`, `batch33`, `batch40`, `auctionCashMovement`, `auctionSeating`,
`miniAuctionTurn`, `privateExchange`, `privateRevenue`, `privateOffer`, `baltimorePrivate`, `privateClosure`,
`floatThreshold`, `forcedDivestment`, `operatingOrderFloatGate`, `soldOutRise`, `sharePurchase`, `shareSale`,
`sellBuySell`, `sellIsNotAPass`, `presidentCertificateSale`, `playerFinance`, `playerNetWorth`, `playerLiquidity`,
`certLimitAgreement`, `batch60`, `terrainAffordability`, `terrainFeeOnce`, `stationLegality`,
`components/buyPrivateWindow`, `dividendPools`, `dividendLedge`, `dividendReceipt`, `dividendStep`,
`dividendProjection`, `multiTrainDividend`, `phantomDividend`, `payoutAndSignpost`, `replayEquivalence`,
`replayAttribution`, `operatingCursorReplay`, `replayJunoCV4`.

**Re-run after the review fixes** (every suite that could see a bank credit on a non-positive balance, plus the
money paths): `bankBreak`, `bankBreakEnding`, `closeRoomPayout`, `cashDelta`, `atomicReducer`,
`emergencyFunding`, `emergencyTrainFlow`, `batch60`, `playerLiquidity`, `dividendPools`, `dividendStep`,
`privateRevenue`, `floatThreshold`, `auctionCashMovement`, `trainPurchaseGate`, `sharePurchase`, `shareSale`,
`terrainFeeOnce`, `stationLegality`, `replayJunoCV4`, `replayEquivalence` — **21 suites, 340 tests, all pass**.

**Failing — expected, caused by §7's corpus divergence, and deliberately NOT re-pinned:**

| Suite | Case | Why |
|---|---|---|
| `utils/replayGolden.test.ts` | `JUNO-CV4.log.jsonl` | frozen board differs in **`virtual_bank_vgp` only** (+$995: $755 auction + $240 terrain) |
| `utils/replayGolden.test.ts` | `JUNO-G6J.log.jsonl` | frozen board differs in **`virtual_bank_vgp` only** (+$750 auction) |
| `utils/replayJuno3XD.test.ts` | "agrees with the live game about which turn each run belonged to" | 3XD diverges from idx 28; 242 cursor mismatches follow |
| `utils/replayJuno3XD.test.ts` | "prints filed run against declared amount" | same divergence: PRR `260 → (undefined)`, B&O `350 → 50` |
| `utils/gameHistory.test.ts` | "samples once per round boundary…" | Z6C diverges from idx 193; the timeline reaches 10 Operating Rounds where the assertion wants more than 10 |
| `utils/roundReplay.test.ts` | "replays to a board still labelled with that round…" | same Z6C divergence: the final grid holds 28 tiles, equal to the OR-7.2 snapshot rather than greater |

That is **6 failing cases across 4 suites**. Every one is a pinned expectation about a *corpus board*, and every
one is explained by a row of §7b. Re-pinning them, with the reason in each test header, is Batch 7.5's job.

### 8c. Typecheck, build and lint

| Check | Result |
|---|---|
| `npx tsc --noEmit -p frontend/tsconfig.json` | **clean** |
| `node …/tsc -p server/tsconfig.json --noEmit` | **clean** |
| `node …/tsc -p server/tsconfig.json` (emits the whole engine + server to CommonJS) | **clean** — this is the build the corpus sweep in §7 actually ran on |
| `react-app-rewired build` (production webpack, `GENERATE_SOURCEMAP=false`, ESLint plugin off for time) | **succeeds** — `1.11 MB` gzipped `main.*.js` |
| `CI=true react-app-rewired build` | **fails** — `Critical dependency: the request of a dependency is an expression`, treated as an error because `CI=true`. **Pre-existing:** the identical failure reproduces on an untouched build of `215eb29`, so it is not this batch's and is not in scope |
| `npx eslint` on every file this batch touched | **identical to the baseline**: 1 error + 3 warnings, all in `sandboxSession.ts` and all pre-existing (`import/first` at the #1530 mid-file re-export, and three unused-symbol warnings — the same four appear on `215eb29`). **Zero new findings**, and the four new files are clean |

Two environment notes rather than findings: this session's shell caps a single command at 180 s and kills
detached processes, which is why the full CRA build had to be run with source maps off; and my **first** build
attempt tried to empty the repository's `frontend/build/` and was stopped part-way by a permission error, so
that directory (gitignored, not a tracked file) now holds the public assets without `static/` — **a fresh
`npm run build` will restore it.**

---

## 9. Refusal atomicity — and why one derived field used to appear (review point 1)

`utils/refusalAtomicity.test.ts` (11 cases). The method is deliberately not "check the three fields I thought
of": it compares **`fieldDigests` across the whole state** and asserts the exact list of top-level fields that
differ, so an arm that later writes something new before its charge fails this file rather than passing it.

### 9a. The finding: pre-existing normalisation, not a mutation of the transaction

Revision 1 reported that a refused `BuyStock` differs in `["current_global_era"]`. **It is the settle chain
normalising a stale board, and it is independent of the message.** `settleEra` runs after *every* message in
`applySandboxActionCore`'s chain; it derives the era from `derivePhase(state)` — the trains in play — and the
variants in force, and writes it only when the derived value differs from the stored one. It never reads the
message. The reducer already documents this at design note **#1303**: *"the settle chain below the arm stamps
`current_global_era` on a state that never carried one, and a refused exchange came back as a new object."*
`operating_sub_phase` is the same story through `settleOperatingCursor` (#656). Both are why Stage 7 tests
refusals by digest and never by object identity (S7-17 / S10-1).

Proved four ways rather than asserted:

| # | Board | Message | Fields that differ |
|---|---|---|---|
| A | stale (no `current_global_era`) | **refused** `BuyStock` | `["current_global_era"]` |
| B | the same stale board | **`UndoLastAction`** — an arm whose entire body is `return state` | **`["current_global_era"]`, same field, same value (`"Yellow"`)** |
| C | the same stale board | **affordable** `BuyStock` | era normalised to the same `"Yellow"` — so it is not refusal-specific either |
| D | the board **already carrying** the derived field | **refused** `BuyStock` | **`[]` — literally nothing** |

**B is the control the review asked for.** A mutation caused by the rejected transaction cannot be produced by
an arm that returns its input; C rules out "refusals specifically"; D shows that once the stale field is
supplied, the refusal is whole-state identical. A fifth case pins the claim about the pipeline itself: a bare
board through the neutral message acquires exactly `["current_global_era", "operating_sub_phase"]` and nothing
else.

**No fix was needed and none was made.** The suite is restructured instead: the primary cases now start from a
board that carries the derived fields and assert `[]`, and a nested `describe` keeps the stale-board case with
its two controls as documentation. The file's own header now says all of this, so `"whole state"` is not
overstated anywhere. **The invariant that matters — a refused purchase makes no transaction or gameplay
mutation — holds in both framings**, and the stale-board case asserts it field by field as well.

### 9b. The cases

| Case | Fields that differ | What is pinned |
|---|---|---|
| The two derived fields, named and pinned | `current_global_era`, `operating_sub_phase` | a bare board through `UndoLastAction` acquires exactly these two — the header's claim about the pipeline, checked rather than trusted |
| Unaffordable ordinary `BuyStock` ($100 share, $60 in hand) | **`[]`** | cash `60` unchanged, bank `9000` unchanged, `ipo_pool_percentage` 80 unchanged, `player_holdings` unchanged, `bought_this_turn` / `turn_action_taken` / `last_trader_index` / `stock_turn_stage` all still undefined, `active_player_index` still 0, `market_positions` still undefined, money conserved |
| The same purchase by a buyer who can pay (**control**) | `active_player_index`, `bought_this_turn`, `last_trader_index`, `player_cash`, `public_companies`, `stock_turn_stage`, `turn_action_taken`, `virtual_bank_vgp` | without this the case above would be satisfied by an arm that refused everything |
| Unaffordable **president's certificate** purchase | **`[]`** | `president` still `null`, `par_value` still `null`, `is_floated` still `false`, treasury still `"0"` (**no 10×par capitalisation**), IPO still 100 %, cash and bank unchanged, money conserved |
| The stale-board trio (A / B / C above) | `["current_global_era"]` each | the normalisation is the pipeline's, not the transaction's |
| …and on the stale board too | — | cash, bank, `public_companies`, `bought_this_turn`, `turn_action_taken` all unchanged, money conserved |
| Unaffordable `BuyPrivateCompany` (treasury $0, price $70) | **`[]`** | treasury `"0"`, seller's cash `"0"`, `owner` still `"p2"`, `owner_protocol_id` still `null`, `jk_license_granted` still undefined, money conserved |
| …the same, **settling an accepted offer** | **`["private_purchase_offer"]`** | see below |
| The same purchase from a funded treasury (**control**) | — | treasury `300 → 230`, seller `0 → 70`, private transferred, money conserved |

**The one deliberate partial effect in this batch, and it is required rather than tolerated.** The
`BuyPrivateCompany` arm clears a matching offer *before* it attempts the transfer, because `nextDerivedAction`
owes the derived purchase for as long as an `accepted` offer stands: a refused settlement that left the offer in
place would be re-owed on the next look, and again, and `settleOwed` would spin for ever (#1247). The design says
the same in so many words — "a refused settlement retires the offer (the #1247 pattern) and transfers nothing".
The test asserts both halves: the offer is retired, and the field list shows that nothing else moved.

**Why there is nothing else to find.** Both arms were restructured so the money movement is the first thing that
happens and every later step is chained off the transfer's result — in `BuyStock`, `moveShares`, the presidency
and par write, `applyFloatThreshold`, `settlePresidencies`, `bought_this_turn`, `turn_action_taken`, `markTrader`
and the seat all read the *banked* board, so an early `return state` skips all of them; the market atom that runs
before the core returns `{ moved: null }` for `BuyStock`, so no price token moves either. `settleTrainSale` was
reordered for the same reason (the train used to move before the payment). `transferPrivateToCorporation` does
its four guards, then the transfer, then the ownership rewrite and the JK licence grant.

## 10. UI-parity classification (the standing rule) — tracking only, nothing implemented

Every 7.1 change classified `NONE / LEGALITY SYNC / NEW ACTION / STATE VISIBILITY / RULES REFERENCE`. Every
non-`NONE` result is written into **Part C of `RULES_HARDENING_BACKLOG.md`**, linked to its S7 item. No frontend
code was changed.

| 7.1 change | S-item | Classification | Part C |
|---|---|---|---|
| `cashLedger.ts`; the three adjusters retired; every gated site migrated behind its existing gate | S7-1 | **NONE** — no action becomes legal or illegal, no control changes | — |
| Auction proceeds credited to the Bank | S7-10 | **NONE** — the dashboard reads player cash and the Bank from state; both are now right. (Side benefit: #1410's "Bank Break: $N remaining" countdown finally counts down from a correct figure.) | — |
| Terrain fee credited to the Bank | S7-10 | **NONE** — same reasoning; the fee, its gate and its narration are unchanged | — |
| **Bank-break badge** under the latch | S7-20 / D-15 | **NONE — confirmed, and no separate implementation is needed.** `App.tsx` 12548 draws the badge from the shared `bankIsBroken(gameState)` imported from `gameEngine/endgame`, the same function `settleRoundTransitions` asks, so teaching that one function about the latch made the badge correct at the same instant. Now pinned by test (both the source claim and the one board where a duplicate rule would disagree). **Recorded so a later batch does not "fix" the badge with a second, divergent rule.** | U-27 (annotated) |
| **Signed bank** — the balance can now be negative | S7-10 / D-15 | **STATE VISIBILITY (narrow)** — two exact call sites verified: `utils/bankBreak.ts` `bankBreakWarning` clamps with `Math.max(0, …)`, so a bank at −$20 renders "Bank Break: $0 remaining" in the countdown's wording instead of saying the bank has broken; `components/FinancialLedger.tsx` 184 prints `$-20` and its "Paid Out So Far" percentage (line 160) exceeds 100 %. Both should read "Bank broken — owes $N" | U-27 (sharpened) |
| Unaffordable `BuyStock` refused | S7-1 / S7-13 | **LEGALITY SYNC** (unchanged in scope — the panel's own `cannotAfford` (#357) already stops the ordinary player; `purchaseBlockFor` reading `stockPurchaseRefusal` stays 7.2's) | U-25 (annotated) |
| Corporate private purchase: treasury, player seller, no corp→corp, no negative/fractional price | S7-6 / S7-12 | **LEGALITY SYNC** (the panel still offers all four; `privatePurchaseRefusal` stays 7.4's) | U-20 (annotated) |
| Intercorporate train sale: money before the train | S7-5 / S7-12 | **LEGALITY SYNC** (`trainSaleRefusal` stays 7.4's) | U-21 (annotated) |
| **A ledger refusal is invisible** | S7-1 / S7-10 / S7-12 | **STATE VISIBILITY — new item.** All four new refusals happen inside the reducer, by identity, with no ingress counterpart: 7.1 adds no rule predicate, so there is no sentence for the room banner (S10-1) and the no-op is indistinguishable on screen from a dropped message. Closed for ordinary play by 7.2 / 7.4's ingress predicates | **U-29 (new)** |
| `moneyTotal` / `assertMoneyConserved` | — | **NONE** (test-only) | — |
| Rules Reference | — | **NONE for 7.1.** The bank-break *timing* text remains U-27's open item; nothing 7.1 changed adds a new player-facing rule | U-27 |

---

## 11. Rule and replay ambiguities found

**(a) Three test fixtures declared a bank field that does not exist — and the old engine invented one.**
`trainPurchaseGate.test.ts`, `batch33.test.ts` and `batch40.test.ts` set `bank_cash_vgp`, which is not a member
of `GameStateResponse`; the real field is `virtual_bank_vgp`. Those boards therefore carried **no bank at all**,
and `adjustBank`'s `Math.max(0, NaN + delta)` wrote `"0"` — so a train "charged" to the Bank on those boards was
charged to a bank that was not there, and the board read as *broken* immediately afterwards. Renamed in place to
the field the fixtures plainly meant, with a comment saying why. **No engine behaviour depends on this**; it is
reported because it is a latent error in the test corpus that the ledger surfaced, and because it is the reason
three suites had to be touched at all.

**(b) `BuyStock` with no `actor` used to make the Bank richer.** The arm read
`const spent = actor ? adjustCash(...) : state; const banked = adjustBank(spent, charged);` — so on a bare
harness board with no author, the certificate was paid for by nobody and the Bank was credited anyway. 7.1 moves
no money at all in that case. Every corpus entry carries an actor, so this is harness-only; flagged because it
is a *deliberate* behaviour change and not a migration artefact.

**(c) The auction step is all-or-nothing, and 7.1 has no escrow rule to stand in front of it.** A charge the
buyer cannot afford now refuses the whole auction message rather than handing over a private for less than its
price. No corpus entry reaches it (every stored auction purchase is affordable), but the *rule* — escrow-aware
affordability asked before the atom moves — is Batch 7.3's S7-4, and until it lands the refusal is silent (U-29).

**(d) `settleTrainSale` still normalises a price of $0 or less to a free transfer.** Preserved exactly: it moves
no money and destroys none, and rulebook §6.6's "$1 minimum" is S7-5, which belongs to Batch 7.4. A **fractional**
price, by contrast, now refuses the sale outright (the ledger takes whole VGP only). No corpus trade is
fractional — FCJ's are $1–$10 — but the difference is stated because it is a behaviour change nobody asked for
explicitly.

**(e) Found and fixed in review: a credit could un-break a legacy board.** Full account in §5a. Listed here
because it is the one *defect* this batch's own review turned up rather than a scope decision: D-15's "bank
credits never un-latch it" was true for boards dealt after 7.1 and silently false for every stored one. No
corpus board is affected, and the sweep after the fix is step-for-step identical to the one before it.

**(f) No replay ambiguity was found.** Every stored entry that 7.1 treats differently is treated differently for
one of the five reasons in §7a, each of which is a *rule* decision the owner has already made (D-15) or a mint
this batch exists to end. Nothing required a judgement call about what a stored message meant.

---

## 12. What was deliberately not done

`RULES_ENGINE_VERSION` is **not** bumped (7.5's). No golden fixture, filed table or pinned expectation was
re-pinned (7.5's). No rule predicate was added for the stock purchase (7.2), the auction (7.3), or the ordinary
private purchase, the intercorporate train sale and the pending-offer machinery (7.4). `m9`'s "charged for
nothing" empty-source purchase is **not** closed — the ledger stops the mint, but refusing an undeliverable
purchase outright is D-25 and belongs to 7.2. The Yellow Sign cash award still mints (S9-1, Stage 9). Stage 8 is
untouched. No frontend code was changed. **Nothing is committed.**
