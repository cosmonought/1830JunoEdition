# Batch 4 — Train lifecycle, availability, mandatory purchase, train-limit handling

Date: 2026-09-14. Baseline: `c9d5974` (Batch 3), 349 suites / 5365 tests. Authority: the 2018 rulebook as
transcribed in `AUDIT_RULES_TO_MACHINE_2026-09-13.md` (§6.6, 6.6.1, 6.6.2, 6.6.3) and
`RulesReference.tsx` (the in-app rules text, sourced from the same book). **Not committed.**

## 1. The three live findings — root causes

Every reconstruction below was run on the engine the game was played on (`dca00bb`, exported from git into a
scratch tree) with the server's own providers, over the stored log `server/data/JUNO-FCJ.log.jsonl` with
reverts resolved. The Batch 3 engine cannot replay this log faithfully past index 95 (the B&M/NNH refusal
diverges it), which is why the pre-fix engine was used.

### A. "B&M skipped a mandatory purchase" — not reproduced in the log; the authoritative gate was missing

Every trainless corporation that ended a Buy Trains step in JUNO-FCJ, with the facts immediately before the
`PassTurn`:

| idx | corp | OR | trains | legal route (2-stop hypothetical from its tokens) | phase / limit | depot head | derived? |
|---|---|---|---|---|---|---|---|
| 74 | B&M | 1.1 | none | **no** — "network does not reach two paying stops" | 2 / 4 | 2-train, 5 left | no |
| 98 | B&M | 2.1 | none | **no** | 2 / 4 | 2-train, 3 left | no |
| 559 | ERIE | 8.1 | none | **no** | 5 / 2 | 5-train, 1 left | no |

Rulebook 6.6.2: "If the corporation has no legal train route, it does not have to own or purchase a train."
All three were legal. B&M's only other trainless turns were OR 9.1 (index 712–717: forced $0 withhold, an
emergency purchase at 714 that the player undid at 715, then the emergency purchase again at 716, then
`PassTurn`) and OR 9.2 (782–784: it bought B&O's Diesel for $4). Neither is a skip. JUNO-CW7, Z6C and 8E8
(same period) show no trainless-with-route exit either. Server refusals are not logged, so an attempt the
server *refused* would not appear — but the reducer had no such refusal to make.

**The defect is real regardless:** the obligation lived only in the shell (`utils/trainObligation.ts`, the
disabled End Turn button, #751). `PassTurn` in the reducer always advanced (audit C4). A hand-crafted
`PassTurn` from an obliged corporation would have been applied. Closed in Part 4 below. My best reading of
the report is OR 9.1: the player undid the emergency purchase, the turn could not be ended (the button was
disabled), and they redid the purchase — which is the obligation working, not failing. If the recollection is
of a different turn, the log does not contain it.

### B. "Emergency purchase selected a sold-out 6" — the 6 was not sold out; the selection was correct, the code was right by coincidence

Index 716, OR 9.1, phase D, Level Playing Field (roster 2/3/4/5/6/7/D; open shelf 6·7·D once a 6 is owned):

| tier | printed | owned before 716 | depot remaining | pool |
|---|---|---|---|---|
| 5 | 3 | NYC, CPR, C&O | 0 (sold out) | — |
| 6 | 2 | ERIE (index 608) | **1** | — |
| 7 | 2 | none | 2 | — |
| D | ∞ | PRR, B&O | ∞ | — |

Only one 6-train had ever been bought (ERIE, 608); nobody else bought one; nothing was traded in or
discarded. The second printed 6 was in the depot. `EmergencyBuyHardware` took the first depot row with
stock — the 6 at $630 — and charged B&M's $270 plus $360 from the president (cash 2255 → 1895; treasury 270
→ 0). Rulebook 6.6.2: "it must purchase the cheapest available train — if 5-trains, 6-trains and diesels are
all on offer, that is a 5-train." 6 ($630) < 7 ($710) < D ($900 LPF). The selection was the rule. After the
purchase the 6s *were* sold out (6: 0/2), which is probably what was seen. B&M then sold that 6 to CPR for
$10 at 768.

What was wrong in the code, and is fixed here: the selection was "the depot's first row with stock", which is
the cheapest only because the queue is priced in ascending order and only while the Bank Pool is empty
(audit M9: a returned $300 4-train would have been passed over); and the depot derived stock as
`TOTAL − owned`, so a train that left a fleet without rusting (traded in, or discarded) came back as printed
stock *as well as* sitting in the pool — one physical train purchasable twice, and on the open shelf a
phantom 6. Neither latent fault fired in this game.

### C. "C&O lost a train to the limit after a sale" — a real discard, at 413, shown at C&O's next turn

| idx | OR | event | C&O trains before → after | phase / limit | note |
|---|---|---|---|---|---|
| 413 | 7.1 (NYC's turn) | NYC buys the first **5** | [3, 3, 4] → [3, 4] | 4→5 / 3→**2** | C&O genuinely one over; `trimToTrainLimit` discarded the cheapest (a 3). The train vanished (C6). |
| 468 | 7.2 (NYC's turn) | NYC buys C&O's 4 for $1 | [3, 4] → [3] | 5 / 2 | `describeFleetLosses(before, after, msg)` = `[]` — a sale, not a loss (#1245). No obligation. |
| 474 | 7.2 (C&O's turn) | C&O buys a 5 | [3] → [3, 5] | 5 / 2 | |

No phase change at 468; no outstanding excess obligation at 468 (C&O held 2 ≤ 2 before the sale, 1 after).
The Train Limit modal is queued when the loss happens and shown **at the top of the president's own next
turn** (#896, `pendingFleetNotices` / `dueFleetNotice` in `App.tsx`). C&O's 7.1 turn was already over when
413 fired, so the modal came due at C&O's 7.2 turn — which followed NYC's turn, where the sale was. The
player saw the 413 discard's notice a round later and read it as a consequence of the sale. **Playtest record
corrected:** the modal reflected a real discard (413), deferred by design; the sale (468) caused nothing.

What *is* wrong with 413, per the rulebook and audit C6: the president did not choose the train, and the
discarded 3 went nowhere instead of to the Bank Pool. The destination is fixed here (§4); the choice is
designed, not built (§5).

## 2. The authoritative train path (Part 1)

| Concern | Where | Authoritative / client / UI |
|---|---|---|
| Ownership | `PublicCompanyState.owned_trains` (+ `pending_rust_trains` marks #979, `ghost_trains` #1046) | state |
| Depot inventory | `gamePhase.ts` `derivePhase` / `depotInventory`: phase = highest tier owned; printed stock = `TOTAL − owned` (queue rule #4; open shelf #1326/#1439) — **now also `− pooled`** | derived from state |
| Bank Pool | `state.returned_trains` — Diesel trade-ins (#1314) **and now discards** | state |
| Phase change | `buyDepotTrain` / `ExchangeTrainForDiesel` compare `derivePhase` before/after → `applyPhaseChange` (rust, then trim, privates close, pooled trains of a rusted tier scrapped) | reducer |
| Train limit by phase | `TIER_PRESENTATION[tier].trainLimit` (4/4/3/2/2/2), read through `depotInventory(...).isCurrent` | table |
| Depot purchase | `BuyHardwareFromPool` → `trainPurchaseRefusal` (OR, operating corp, Hardware step, limit on the countable fleet, funds) → `buyDepotTrain` (`openDepotTiers`, optional `model_type` on the shelf) | reducer; `model_type` is a client choice among open rows, refused if not open |
| Pool purchase | `BuyHardwareFromPool{returned_model_type}` → `returnedTrainRefusal` → `buyReturnedTrain` | reducer; model is a client choice, must be in the pool |
| Corporation-to-corporation | `ProposeTrainPurchase` (buyer's president, socket) → `AnswerTrainPurchase` (seller's president) → derived `BuyTrainFromCorporation` → `settleTrainSale`; a same-president trade is sent directly | price is the parties' choice; **buyer limit now checked**; buyer-is-operating and ≥$1 are not (M14, tied to the excluded pending-offer finding) |
| Emergency purchase | `EmergencyBuyHardware` → **`cheapestPurchasableTrain`** → treasury first, president's cash for the shortfall → `buyDepotTrain(requireFunds=false)` (depot or pool) | reducer chooses the train; the message carries none |
| "Must buy" determination | was `App.tsx` `mustBuyTrain` = trainless ∧ 2-stop hypothetical route (UI only, #433/#751); **now `trainObligationFor` in the engine** | authoritative |
| Excess detection | `applyPhaseChange` only — on a depot purchase or Diesel exchange that turns the phase. A trade never ran it (buyer limit unchecked) | reducer |
| Excess disposal | `trimToTrainLimit`: automatic, cheapest-first, reprieved trains set aside (#1034); all corporations at once | reducer (audit C6: not the rule) |
| Discarded train | was dropped; **now `returned_trains`** | reducer |
| UI modal | `describeFleetLosses` diff → `fleetLossNotices` queued → `dueFleetNotice` shown to the president at the top of that corporation's next turn (#896/#981), silenceable per room | UI narration of a reducer fact |
| Who chooses train type | Ordinary purchase: the client, from the open shelf. Forced purchase: the reducer. Trade: the parties. Discard: the reducer (should be the president — §5) | |

## 3. Authoritative train availability (Part 3) — `gameEngine/trainAvailability.ts` (#1512)

- `purchasableTrains(state)`: the depot's open rows with stock (`openDepotTiers`) plus one row per Bank
  Pool model (`returned_trains`), each at printed face value (`depotCostFor`).
- `cheapestPurchasableTrain(state)`: minimum face value across both; **tie between a pool train and printed
  stock of the same model → the pool copy** (identical train and price; keeps the depot countdown honest).
  Documented as a tie-break, not a rule — the rulebook does not distinguish the two.
- The rule implemented, verbatim from the reference: "If the corporation has enough money to buy a train
  itself, it must purchase the cheapest available train — if 5-trains, 6-trains and diesels are all on offer,
  that is a 5-train." Other corporations' trains are never ranked: "A cash-strapped corporation is not
  required to buy another corporation's train merely because it is cheaper."
- `depotInventory` / `derivePhase.depotRemaining` subtract the pooled trains of a tier from its printed
  remainder (`pooledTrainsByTier`), so a traded-in or discarded train is in exactly one place.
- Consumers: the reducer's emergency arm, `buyReturnedTrain` (which no longer refuses the forced purchase —
  M9), the shell's emergency plan (`App.tsx`), and the obligation gate. The Buy Trains panel already read
  `openDepotTiers` + `returned_trains`, which are the query's two inputs.

**Before:** three readings of one shelf (`openDepotTiers`; `depotInventory.find(remaining > 0)` in the
emergency arm; `depotInventory` with a `!rusted` filter in the shell), none of them seeing the pool, and a
depot count that resurrected pooled trains. **After:** one query, pool included, depot count exclusive.

## 4. Mandatory purchase (Part 4) — `trainObligationFor` / `trainObligationRefusal` (#1513)

- Arises: Operating Round, the operating corporation, at the Buy Trains step (the rulebook's "at the end of
  its Operating Turn").
- Prerequisites, each from the engine's own readers: `owned_trains` reported and empty (a reprieved or
  ghost train is still a train); `hasLegalRouteFor` — a 2-stop hypothetical route from the corporation's
  tokens over the same walk and wall `maxRouteRevenueFor` and the auto-skip use (`derivedActions.ts`,
  refactored to share `routeSearchFor`); `cheapestPurchasableTrain` non-null (a printed game always has a
  Diesel).
- Blocks: `PassTurn` and `AdvanceOperatingSubPhase` at Hardware, refused by identity in
  `applySandboxActionCore`. Passes: every purchase message, the offer/answer pair, the Diesel exchange,
  `RevertTo`. A hand-crafted `PassTurn` meets the same gate as the button.
- No opinion without a grid (`ctx.mapGrid` absent — fixtures only; the server and the shell always supply
  it) or with an unreported fleet (#232).
- **Batch 5 boundary, and one decision to confirm.** The state left behind is exactly "this corporation
  must buy a train and cannot end its turn until it has". To keep that honest I also made
  `EmergencyBuyHardware` **refuse when the president's cash is short of the shortfall** (audit C4c): before,
  `adjustCash`'s zero floor took what the president had and handed over the train anyway — money minted by
  a clamp, which would have let any obligation be "resolved". Nothing decides how the shortfall is raised;
  that is Batch 5's cascade. Consequence until then: a corporation whose president cannot cover the cheapest
  train cannot end its turn except by a trade at ≥$1 with another corporation (still allowed) or a host
  `RevertTo`. If you would rather keep the old minting behaviour until Batch 5 lands, it is one gate in
  `applySandboxActionCore` (`#1513`, `EmergencyBuyHardware`) plus one test.

## 5. Train-limit handling (Part 5) — traced; the president's choice is designed, not built

Rulebook (6.6.1, per the audit and the reference): the limit changes immediately after the purchase that
begins the new phase; a corporation left over it must discard down to it; **the president chooses** the
train; the discarded train **goes to the Bank Pool** with no payment; where several corporations are over at
once, **the highest-valued railroad decides first**; a corporation may not discard merely to make room.

| Question | Machine before | Machine after this batch |
|---|---|---|
| When over-limit arises | `applyPhaseChange` after a depot purchase / Diesel exchange that turns the phase | same; a **trade** can no longer create it (buyer-limit gate) |
| Who chooses | `trimToTrainLimit`, cheapest-first, immediately | unchanged (see design below) |
| Ordering across corporations | all at once, in roster order | unchanged |
| Where the discard goes | dropped; re-emerged as phantom depot stock a tier below the head | **`returned_trains` (Bank Pool), purchasable at face value** |
| Subsequent purchasability | none (queue rule hid it) | any corporation with room, at face value; the forced purchase takes it if cheapest |
| Trades and the limit | unchecked | buyer at its limit is refused (offer retired, train stays) |

The 413 discard was this mechanism; the automatic choice took C&O's 3, which may or may not be what its
president wanted.

**Proposed state-machine design for the president's choice (not implemented — needs your go-ahead):**

1. `applyPhaseChange` stops trimming. For each corporation whose countable fleet exceeds the new limit it
   writes `pending_train_discards: n` on the company (n = excess), and the state carries
   `train_discard_queue: number[]` — the over-limit corporations ordered by share price descending (the
   rulebook's "highest-valued railroad decides first"; tie-break by operating order).
2. A new message `DiscardTrain { protocol_id, model_type }`, room-family (owner: that corporation's president,
   checked in `roomMessageRefusal` like `PlaceHomeStation`), refused unless `protocol_id` is the queue's
   head, the model is in its fleet, and it is not reprieved (#1034). The arm moves the model to
   `returned_trains`, decrements `pending_train_discards`, and pops the queue when it reaches zero.
3. A **gate in `applySandboxActionCore`**, in the style of `homeTokenBlock` (#763): while the queue is
   non-empty, every message other than `DiscardTrain` and `RevertTo` is refused. The physical game stops
   here too — the discard happens "immediately".
4. The shell replaces the deferred Train Limit modal with a blocking chooser for the queue head's president
   (the other players see "waiting for C&O's president"); `describeFleetLosses` narrates from the
   `DiscardTrain` message instead of the fleet diff.
5. Replay: logs written before the message contain no `DiscardTrain`, so a rebuild would stall at the first
   over-limit phase change. The rebuild path would need the automatic trim as a fallback for entries dealt
   before the change — which is the rules-version pin this project does not yet have (Batch 3 §6). That is
   the reason to wait for your decision rather than ship it: the interactive choice is the first change that
   cannot be applied retroactively to a stored log at all.

## 6. Files changed

| File | Change |
|---|---|
| `frontend/src/gameEngine/trainAvailability.ts` | **new** — #1512 `purchasableTrains`, `bankPoolTrains`, `cheapestPurchasableTrain`; #1513 `trainObligationFor`, `trainObligationRefusal`. |
| `frontend/src/gameEngine/gamePhase.ts` | `pooledTrainsByTier`; `derivePhase.depotRemaining` and `depotInventory.remaining` subtract the pool. |
| `frontend/src/gameEngine/derivedActions.ts` | `routeSearchFor` extracted (one walk); `hasLegalRouteFor` (2-stop hypothetical). |
| `frontend/src/gameEngine/sandboxSession.ts` | Core gates: obligation (`PassTurn`/`AdvanceOperatingSubPhase` at Hardware), emergency purchase (cheapest, limit, president's cash), trade buyer limit. Emergency arm buys `cheapestPurchasableTrain` (depot or pool). `returnedTrainRefusal`/`buyReturnedTrain` take `requireFunds`. `applyPhaseChange` sends discards to `returned_trains`. Arm comments updated. |
| `frontend/src/App.tsx` | The emergency plan asks `cheapestPurchasableTrain`. |
| `frontend/src/utils/trainLifecycle.test.ts` | **new** — 21 tests. |

Untouched, pre-existing: `frontend/src/utils/audio.ts`. Scratch: `_to_delete/__diag_b4.test.ts`; the
pre-fix engine exports at `$HOME/scratch/live` and `$HOME/scratch/b3` are outside the repo.

## 7. Tests (Part 7)

`trainLifecycle.test.ts`, 21/21: (1) obliged corporation cannot `PassTurn`; (2) hand-crafted
`AdvanceOperatingSubPhase` refused, and an unattributed `PassTurn`; (3) no route / owns a train / reprieved
train / other step → completes; purchase discharges; no opinion without a grid; negative control (unreported
fleet reaches the arm and ends the turn, the pre-#1513 path); (4) both 6s out → the forced purchase buys a
Diesel; (5) 5s exhausted → 6; (6) pool 4 is cheapest and is bought, pool emptied, president charged the
shortfall, with the old "first depot row" expression asserted to name the 6; pooled 6 counted once, with
`TOTAL − owned` asserted to give the phantom 1; pool-first tie; (7) depot purchase decrements printed stock
and leaves the pool, pool purchase the reverse; president short → refused by identity and the obligation
stands; (8) trade moves one train and the price, bank inventory untouched, sale is not a loss; buyer at
limit refused by identity; (9) at/below limit no discard, pool untouched; (10) above limit → discard to
pool, narrated, purchasable, not double-counted; (11) C&O: over by one at the first 5, trimmed to [3, 4],
the 3 in the pool; the later $1 sale of the 4 → [3], `describeFleetLosses` empty, no obligation.

Existing, all green after the change (targeted): fleetDiscard, emergencyTrainFlow, dieselExchange,
trainOffer, trainPurchaseGate, trainLimit, depotSurface, gentleRustLimit, gentleRustExemption,
derivedActions, buyTrainsPanel, operatingRoundPhaseLoop, refusedAction, batch28/36/37/38/45/48/51/52/53/60/64,
actionReceipt, autoBuy, autoSkipExit, bankBreakEnding, firstOperatingRound, homeTokenGate, multiTrainRun,
operatingCursorReplay, operatingOrderFloatGate, operatingQueuePricing, operatingRoundCycleCount,
operatingRoundTurn, passAndUndoStrings, polishWave7, privateClosure, privateOffer, privateRevenue,
replayAttribution, replayEquivalence, roomSession, roundLabel, sandboxRoom, sellBuySell, messageSchema,
sellIsNotAPass, sellThenBuyLock, serverLink, serverProtocol, shellMessageArms, soldOutRise, turnAuthority,
undoTarget, variantRules, bonusLayStep, gridProvenance, logCondense, logExport, logHash, routeRevenueReset,
stationLegality, operatingIdentity, replayGolden, replayJunoCV4, replayJuno3XD. Both typechecks clean.

**Expected full-suite totals: 350 suites / 5386 tests** (+1 suite, +21 tests).
Full suite: `cd frontend && npm test -- --watchAll=false` (or `frontend\test-summary.ps1`), plus
`npm run typecheck` in `frontend/` and `npm run build` in `server/`.

## 8. Replay compatibility

Every stored log was swept entry by entry with this batch and with Batch 3 alone (`c9d5974`, exported),
comparing the set of train-related entries that come back digest-unchanged and every change to
`returned_trains`:

- **No new refusals anywhere.** Every refused train entry in JUNO-3XD (228, 229, 248) and JUNO-FCJ (413
  onward) is identical under Batch 3 alone — they are the #1196 divergence and the Batch 3 divergence from
  index 95 respectively, not this batch. JUNO-CV4, Z6C, CW7, G6J, 7NZ: none.
- **One state difference: JUNO-3XD index 255.** A phase change trimmed a 3-train; it now enters the Bank
  Pool (`returned_trains: undefined → ["3"]`). Nothing later buys it, the depot's 3 row was already 0 by the
  queue rule, and `replayJuno3XD.test.ts` does not pin the field, so no expectation moved. Recorded so it is
  not silent. The golden fixtures (CV4/7NZ/G6J) contain no trim and are byte-identical.
- JUNO-FCJ index 413 would show the same difference (C&O's 3 into the pool) on an engine that could replay
  it faithfully; on this engine the log has already diverged at 95.
- No golden or replay expectation was updated.
