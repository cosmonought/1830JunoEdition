# Batch 4.6 — Interactive excess-train discard (`DiscardTrain`)

Date: 2026-09-14. Design note **#1530**. Baseline (post-Batch-4.5, user-validated, `2aefe13`): 351 suites / 5401 tests.
Not committed: awaiting the full-suite result.

> **`RULES_ENGINE_VERSION` is bumped 1 → 2.** Version 2 = version 1 with the automatic cheapest-first excess-train
> trim at a phase change replaced by the president's explicit `DiscardTrain` entries. A version-1 log carries no
> such choices — its excess trains were removed by the reducer, not by an entry — so it is not replay-compatible
> with version 2 and a server carrying version 2 refuses it before replay (`SUPPORTED_RULES_ENGINE_VERSIONS = [2]`).
> No historical reducer bundle was introduced.

## 1. The rule, from the 2018 rulebook (1830-RE, Lookout; `en_1830re.html_Rules_1830-RE_EN.pdf`)

The Downloads folder holding your PDF was not granted this session, so the same file was read from Lookout's
site (`lookout-spiele.de/upload/en_1830re.html_Rules_1830-RE_EN.pdf` — identical filename). Quoted:

1. **When the obligation is created** — §2.0: *"A phase change occurs immediately following the purchase of the first
   train of a new type. So, any new limit on how many trains a railroad can own goes into effect after that train is
   purchased. This may result in the forced discard of a train by the railroad that just purchased a train."*
2. **Who chooses** — §6.6.1: *"If a railroad finds itself with an excess train, the president must choose a train to
   discard."*
3. **Order for several corporations** — §6.6.1: *"If multiple railroads must discard at the same time, the trains are
   discarded in order of the companies' share values — with the highest valued railroad deciding first."*
4. **Tie-break at equal share value** — §6.6.1 states none. The rulebook's only rule for ordering equal share values
   is the operating-order rule, §6.0: *"Sometimes the share value tokens of 2 or more floated railroads are in the
   same grid block of the stock market. In this case, the railroad whose token is on top takes a turn first ... If 2
   or more floated railroads have the same share value but their share value tokens are in different columns, the
   railroad whose token is furthest to the right takes a turn first. If ... in the same column, the railroad whose
   token is furthest up takes a turn first."* The implementation uses that rule (via the engine's existing
   `buildOperatingOrder`, #646/#647/#1196) and no other; it is not inferred from generic 18xx practice.
5. **Where the train goes** — §6.6.1: *"A discarded train goes to the Bank Pool and its railroad receives no payment
   for it."* §6.6: *"The bank pool may hold trains discarded by railroads. These trains may be purchased for face value
   (on the train card). The payment goes to the bank."*
6. **Repeated discards** — §6.6.1 speaks of *"an excess train"* (singular) and does not address a corporation two
   over; a corporation still over after one discard is still *"a railroad with an excess train"*, so the machine
   keeps the obligation on it until it is at the limit. Two-over is unreachable through the printed schedule
   (4 → 3 → 2 drops one at a time and no fleet may exceed the limit in between); it is handled and tested anyway.
7. **Anything else first?** — §2.0 says the limit is in force *immediately*; §6.6.1 says the discard is what
   happens when a railroad *"finds itself"* with an excess train. Nothing in either section admits another action
   between the purchase and the discards, and the machine admits none.

## 2. State-machine design (exact)

**Nothing new is persisted.** The obligation is *derived* from authoritative state on every read
(`gameEngine/trainDiscard.ts`):

- `excessTrainCount(company, limit)` = `countableTrainCount(owned, pending_rust_trains, ghost_trains) − limit`, i.e.
  the same count every limit check uses (#1034: Gentle-Rust reprieved trains and Yellow-Sign ghosts are exempt).
- `pendingTrainDiscards(state)` → `null`, or `{ limit, queue, required }` where `limit` is the phase in force
  (`derivePhase(state).trainLimit`), `queue` lists every over-limit corporation as
  `{ companyId, ticker, president, limit, choices, excess }` in **`buildOperatingOrder(state)` order** (share value
  desc, then §6.0's tie-break), and `required = queue[0]`. `choices` are the countable trains (a reprieved or ghost
  train may not be discarded: it would spend a train and leave the obligation standing).
- Why derived is safe: a corporation is over its limit *only* between a phase change and its discards — every other
  way a train arrives is refused at the limit (`trainPurchaseRefusal`, the trade gate, the emergency gate).
- **Ordering is recomputed on demand, not snapshotted, and the two are provably equal**: while a discard is pending
  the reducer accepts only `DiscardTrain`, and a discard moves no share price, so the order cannot change between the
  phase change and the last discard (test 8b asserts `market_positions` unchanged across the resolution).
- **Resuming the interrupted flow**: nothing was paused. The purchase that turned the phase left the cursor where it
  was (the buyer's Buy Trains step); the gate simply stops refusing once nothing is over the limit. The tests assert
  the cursor is exactly where it stood and that the next `PassTurn` applies.

`applyPhaseChange` no longer trims. It still rusts, still marks reprieves, still closes privates, and still rusts
pooled trains; the `discardsThisPhase` → `returned_trains` write from Batch 4 is gone. The Yellow-Sign ghost expiry
(`expireGhostTrains`, #1046) keeps its own round-boundary trim — a variant ruling, out of scope (Part 7).

**`DiscardTrain { game_id, protocol_id, model_type }`** (reducer arm in `sandboxSession.ts`): removes exactly one copy
of `model_type` from the corporation's `owned_trains`, appends it to `returned_trains` (the Batch-4 Bank Pool, the one
returned-train structure), pays nobody. Validation happens *before any arm* in `applySandboxActionCore`
(`discardTrainRefusal`): an obligation exists; `protocol_id` is `required.companyId` (a corporation further down the
queue is told who decides first); the entry's `actor` (#549, when the log names one) is that corporation's president;
the model is among `choices`. Refusals return the state by identity (#778).

**The gate (Part 5)** — one line, first in `applySandboxActionCore`, ahead of the Batch-3 identity gate and the
Batch-4 obligation gate: `pendingDiscardBlock(state, msg)` refuses **every message except `DiscardTrain` and
`CloseRoom`** while any corporation is over its limit. `RevertTo` never reaches the reducer (log-level, #1026) and
keeps its owner rule. The same predicate is asked at the ingress (`turnRefusal`, "the hold", after the derived and
solo exemptions, before the consent exemption) so the server answers `refused` with the reason instead of appending
a no-op entry; and `nextDerivedAction` returns `null` while a discard is pending, so the server's settle loop and the
client drain never walk the turn past the decision.

**A necessary correction found on the way**: the reducer's depot-purchase gate judged the buyer against the *arriving
tier's* limit (`tier.trainLimit`), i.e. #296's mistake that #703 had fixed only in the panel. A corporation holding
2 at phase 4 could not buy the first 5-train. Both reducer sites now judge against the limit *in force*
(`limitInForce(state)`), per §2.0 ("may result in the forced discard ... by the railroad that just purchased").
Consequence for legacy logs below.

**Phase derivation**: a president may now discard the very 5-train whose purchase turned the phase; `derivePhase`
therefore counts Bank-Pool tiers toward `highest` (and only toward `highest` — they were never printed stock, #1512).
Test 12 proves the phase stays 5 with limit 2 after that discard.

## 2b. The ordering primitive, verified (pre-commit check, design note #1531)

`pendingTrainDiscards` orders by `buildOperatingOrder`, so that helper was checked against the exact §6.0
semantics the discard depends on, from `state.market_positions` (the chart's `y` grows upward:
`StockMarketRenderer` draws `gridRow: maxY + 1 − y`; `x` grows rightward):

| §6.0 case | Was | Now | Test |
|---|---|---|---|
| higher share value first | price desc ✓ | unchanged | `operatingOrderTieBreak` "still yields to price"; `trainDiscard` 8 (NYC $112 before the $100s) |
| equal value, different columns → rightmost first | column desc ✓ (#647) | unchanged | `operatingOrderTieBreak` "further-right token first"; `trainDiscard` 8 (ERIE col 8 before col 7) |
| equal value, same column → furthest up first | **missing** — fell through to arrival, and the harness had recorded it as "the rules do not legislate this case" | **row desc added** as the third key | `operatingOrderTieBreak` "puts the higher token first", "height outranks arrival", "the $67 column"; `trainDiscard` 8 (B&O above C&O) |
| same cell → token on top first | arrival asc ✓ (#646); §4.5 places a new arrival *at the bottom*, so the earliest arrival is on top | unchanged | `operatingOrderTieBreak` "orders by arrival"; `trainDiscard` 8 one-cell case |

**It failed one of the four.** The rulebook does legislate same-column/same-value ("the railroad whose token is
furthest up takes a turn first"), and the standard chart reaches it: column 6 holds $67 at rows 3, 4 and 5.
**Choice: fix the shared primitive** (`gameEngine/operatingOrder.ts`, one added sort key between column and
arrival) rather than give the discard subsystem its own helper — the Operating Round and the discard queue must
not disagree about §6.0, and the fix is a strict refinement: it changes an outcome only when two floated
corporations sit at one price in one column on different rows, which on the standard chart is only the $67
column. **Replay effect: none observed** — the 17-log corpus sweep against `2aefe13` is unchanged by it
(16/17 identical; FCJ's divergence is the limit-in-force fix, identical digest before and after the row key).
Existing OR behaviour changes only in that unreachable-so-far case, now rule-correct. The `operatingOrderTieBreak`
pin "falls through to arrival for two cells in one column" was rewritten deliberately (same expected order, now
for the stated reason) and two cases added.

**Recorded for Stage 8 — the live OR-order anomaly, mechanism confirmed, not repaired here.** The "$112 B&M
operated ahead of $126 B&O" case is not this primitive (price outranks every other key) but what
`active_operating_order` is built *from*. The hypothesis that the queue is snapshotted before the end-of-Stock-Round
sold-out rise is correct, and it is trivially confirmable in code: #746a overlays the rises through the
`priceFor`/`markFor` resolvers so the queue orders on post-rise prices, but #1196 made `buildOperatingOrder` read
`state.market_positions` first and use the resolvers only when positions are absent — on every server board they
are present, so the overlay is ignored, the queue locks on pre-rise positions, and the rise is committed to
`market_positions` only afterwards (`applySandboxActionInner`, after the core settles). Confirmed on the stored
corpus by a scan comparing each locked queue with `buildOperatingOrder` asked of the same state one settle later:
JUNO-3XD idx 303 locks B&M@90 ahead of NYC@100; JUNO-FCJ idx 699 locks NYC@112 behind ERIE/CPR@100; JUNO-FCJ
idx 398 locks B&M@90 ahead of NYC@90 (a column tie decided on the pre-rise cell). No other opening in the 17 logs
disagrees. The repair (build the queue on the risen positions, or commit the rise before opening) is Stage-8
OR-ordering work and a replay-semantic change; Batch 4.6 does not make it. The discard queue is unaffected — it
asks the function of the state as it stands mid-Operating-Round, with positions already risen.

## 3. Schema and authorization classification for `DiscardTrain` (Part 4)

- **Schema** (`messageSchema.ts`): `DiscardTrain: { game_id: "int?", protocol_id: "int", model_type: "string" }`;
  `GAMEPLAY_MESSAGE_KINDS` 39 → 40 (`messageSchema.test.ts` pin updated deliberately).
- **Allow-list / type**: `GAMEPLAY_MESSAGE_KEYS` and `GameplayExecuteMsg` gain `DiscardTrain` (pure VGP state, no
  money moves; session-key eligible like every other gameplay message).
- **Authorization** (`turnAuthority.ts`, exemption 5): `DiscardTrain` is **not** a seat action and the seat cursor is
  not widened. Its owner is the president of `pendingTrainDiscards(state).required`; any other actor, any other
  corporation (including one further down the queue), or no obligation at all → refused with a specific sentence.
  It is not added to `isSandboxOnlyMsg` (the room-message family).
- **Actor binding**: the server binds `actor` from the connection (#1207); the reducer arm re-checks the entry's
  `actor` against the president (#549), so a hand-built message meets the answer twice (tests 3, 4, 13).

## 4. Multiple corporations (Part 6)

Test 8: C&O (share value 100) and B&O (67) both over after NYC buys the first 5. C&O's president decides first;
B&O's president is refused ("C&O decides first — it has the higher share value"); C&O's president cannot discard
B&O's train; after C&O discards, B&O becomes `required`, C&O can no longer discard, NYC still cannot move; after B&O
discards, `pendingTrainDiscards` is `null`, the cursor is still NYC's Buy Trains step, and `PassTurn` applies.
Test 8b: equal share values, different columns → rightmost first (§6.0), proven on a charted board by digest.
Share-price changes during resolution are impossible (only `DiscardTrain` is accepted; it moves no price).

## 5. Bank Pool integration (Part 7)

Test 11: the discarded 4 appears as `{ source: "pool", tier: "4", cost: 300, remaining: 1 }` in `bankPoolTrains`,
`purchasableTrains` and `cheapestPurchasableTrain`; NYC buys it via `BuyHardwareFromPool.returned_model_type` at
face value, the bank is paid $300, the pool empties, the discarder is not paid. Test 12: the depot's 4-row stays
at 0 (three owned + one pooled = four printed); a discarded phase-changing 5 keeps the phase at 5 and the 5-row at
2 (three printed, one loose). Same-model pool/depot tie still goes to the pool (Batch 4's documented tie-break).
No second returned-train representation exists.

## 6. Minimal UI (Part 8)

`TrainDiscardPrompt` (in `components/TrainPurchasePanel.tsx`, same fixed slot and styles as the trade prompt):
the required corporation's president sees "C&O holds one train more than the limit of 2 ..." and one
**Discard N-train** button per model they hold (two 3-trains are one button, the message names a model); everyone
else sees "Waiting on <president> to discard — nothing else can happen until C&O is at the limit." `App.tsx`
derives `pendingDiscard` from `pendingTrainDiscards(gameState)` (no UI-only queue) and dispatches
`DiscardTrain` off-turn (#701), like a consent answer. Other controls are blocked by the reducer gate and the
server hold; a press produces the refusal line with the reason (`refusedAction.ts`). The Activity Log narrates
the discard (`actionLog.ts`) and says who must discard next. No modal/animation/styling work.

## 7. Files changed

New: `gameEngine/trainDiscard.ts` (#1530), `gameEngine/operatingOrder.ts` (`buildOperatingOrder` lifted verbatim
out of `sandboxSession.ts`, re-exported from it, so the discard module can order without an import cycle),
`utils/trainDiscard.test.ts` (21 tests), this file.
Engine: `operatingOrder.ts` (#1531 row key), `operatingOrderTieBreak.test.ts` (one pin rewritten, two cases
added), `sandboxSession.ts` (trim removed from `applyPhaseChange`; `DiscardTrain` arm; core gate; limit-in-force at
both depot-purchase gates; `describeFleetLosses` excludes the president's own discard), `derivedActions.ts` (owes
nothing while pending), `turnAuthority.ts` (the hold + exemption 5), `gamePhase.ts` (pooled tiers count toward the
phase), `messageSchema.ts`, `rulesVersion.ts` (version 2, changelog, `legacyExcessTrains` policy field),
`replayLog.ts` (legacy-corpus adapter, `legacyDiscards` in the result), `gameEngine/index.ts` (exports).
Shell: `utils/sessionKey.ts`, `utils/actionLog.ts`, `utils/refusedAction.ts`, `components/TrainPurchasePanel.tsx`
(`TrainDiscardPrompt`), `App.tsx` (prompt wiring, off-turn dispatch). Server: `replayCli.ts` (prints supplied
legacy discards).
Tests updated deliberately (each change annotated `#1530`): `fleetDiscard.test.ts` (the cases that pinned *which*
train the trim took now pin that it takes none and owes the right amount; the sentence cases build their
before/after by hand), `trainLifecycle.test.ts` ((10) and the JUNO-FCJ reconstruction: the discard is owed, then
made by `DiscardTrain`), `batch64.test.ts`, `variantRules.test.ts` (Gentle-Rust over-limit: owed, marked train not a
choice), `messageSchema.test.ts` (40 kinds), `trainOffer.test.ts` (5 off-turn dispatch sites), and three fixtures
that were over the limit by construction — `trainPurchaseGate.test.ts` (B&O's nine trains spread over bystanders),
`dieselExchange.test.ts` (B&O two trains), `atomicRunRoutes.test.ts` (four 3s at phase 3), `eraTracksPhase.test.ts`
(bystanders one 2 each) — because an over-limit fleet is now a standing obligation that refuses every other move.
`audio.ts` untouched.

## 8. Focused results

- `trainDiscard.test.ts` 21/21: tests 1–14 of the brief (1 obligation-not-trim; 2 president chooses the 4 the trim
  never would; 3 non-president refused; 4 queue-jump refused; 5 unowned model refused; 6 no obligation → refused;
  7 two-over stays required; 8 order + 8b §6.0 tie-break; 9 twelve ordinary messages refused by one gate, derived
  action `null`, negative control after resolution; 10 `RevertTo` past the discard restores the obligation, past the
  purchase removes it; 11 pool; 12 not double-counted + phase kept; 8 also proves all four §6.0 keys on the
  discard queue and the one-cell (§4.5) case; 13 same-version rebuild identical through
  `replayLog` and through `RoomSession` (server hold answers `refused` with the reason, nothing appended); 14 version
  2, changelog, a version-1 room held with `RoomEngine.apply` spied and never entered), plus the schema/allow-list
  case, `RevertTo` through the room while pending, and the legacy-corpus adapter's contract.
- Green: `trainLifecycle` 21, `fleetDiscard`, `batch64`, `variantRules`, `messageSchema`, `turnAuthority`,
  `derivedActions`, `actionReceipt`, `activePrivatePower`, `powerRefusalAndChips`, `trainPurchaseGate`, `trainLimit`,
  `trainOffer`, `dieselExchange`, `atomicRunRoutes`, `eraTracksPhase`, `emergencyTrainFlow`, `buyTrainsPanel`,
  `multiTrain*`, `operatingRoundPhaseLoop`, `runTrainsRules`, `gentleRust*`, `accolades`, `batch28/36/37/48/59/60`,
  `firstOperatingRound`, `fleetLossNotice`, `logCondense`, `privateClosure`, `rulesVersion` 15, `roomSession`,
  `refusedAction`, `actionLog`, `gameHistory`, `treasuryProvenance`, `appNaming`, `hostJoinFlow`, `replayAttribution`,
  `divergenceWatch`, `replayGolden`, `replayJunoCV4`, `replayJuno3XD`.
- Both typechecks clean (`frontend` `tsc --noEmit`; `server` `tsc -p`).

## 9. Replay / version effects (Part 9)

- New deals are stamped `rules_engine_version: 2` (test 14; `rulesVersion.test.ts` 1–2 hold symbolically).
- A room pinned to 1 is `incompatible {version: 1, supported: [2]}` before replay; hello and submit answer
  `incompatible`; the log is untouched (test 14).
- Same-version logs holding `DiscardTrain` rebuild identically through `replayLog` and `RoomSession`; `RevertTo`
  rebuilds under the same engine and keeps the pin (tests 10, 13, RevertTo-through-room).
- **Legacy corpus (17 stored logs: 0 versioned, 16 legacy, 1 undealt).** All 16 legacy logs are still refused by
  the server policy. Under `DEVELOPMENT_CORPUS_POLICY` they replay with an explicit, documented adapter:
  `legacyExcessTrains: "engine-chose-cheapest"` has `replayLog` supply the `DiscardTrain` entries the old engine
  never wrote (cheapest model first, §6.6.1 order, authored by the president, applied through today's arm, appended
  nowhere, reported in `result.legacyDiscards` and by the CLI). **This is best-effort development-corpus
  compatibility, not historical-fidelity replay, and it is development-only**: it supplies the one missing
  *choice* so golden/replay fixtures can be read end to end (JUNO-3XD, index 255); every other version-2 rule still
  applies, so a legacy log can diverge from its own play (FCJ below). Under `legacyExcessTrains: "refuse"` the
  obligation stands at 255 and every later entry is refused — the concrete meaning of "not replay-compatible"
  (both asserted). The server's policy never carries it, and `start.ts --legacy-logs` does not reach it: a legacy
  room admitted on a local server holds at its first past-trim discard until a president resolves it.
- **Sweep vs the Batch-4.5 engine (`2aefe13`), corpus policy on both**: 16 of 17 replay to the same digest and
  applied count (3XD's supplied discard `255: C&O, 3` reproduces Batch 4's trim exactly). **One differs:
  `server/data/JUNO-FCJ.log.jsonl` at index 474** — C&O, holding [3, 3] at phase 4, bought the first 5-train. The
  version-1 engine refused it (the arriving-tier limit bug above); version 2 allows it per §2.0, C&O is then
  [3, 3, 5] over the limit of 2, and the adapter supplies the cheapest discard. The live game was played on the
  refusing engine, so the rest of that log assumes the purchase did not happen: this is a rule fix that makes a
  legacy log diverge, not a missing choice, and no adapter can bridge it. No test replays FCJ past its prefix-96
  fixture, so **no golden or replay expectation changed**; the divergence is reported here rather than absorbed.
- `describeFleetLosses` no longer reports a phase-change discard (none happens); the #896 deferred "train limit"
  notice therefore no longer fires for discards — the president's own action is narrated instead. Rust notices are
  unchanged.

## 10. Scope notes

Not touched: president cash contribution, forced sales, presidency changes, bankruptcy, the Batch-4 emergency gate
(insufficient president cash still refuses by identity), routes/revenue, intercorporate redesign, Stock Round UX,
LPF, OR order, Yellow Sign authority (its ghost-expiry trim stands), UI polish. The C&O playtest diagnosis is
unchanged; this machine makes the 413 event the president's explicit choice.

## Expected totals and command

352 suites / 5424 tests (baseline 351 / 5401 + `trainDiscard.test.ts` 21 + `operatingOrderTieBreak.test.ts` +2; every other suite keeps its count).

    cd frontend && npm test -- --watchAll=false
    cd frontend && npm run typecheck
    cd server && npm run build
