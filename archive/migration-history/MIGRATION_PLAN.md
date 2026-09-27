# Migration plan — client-side replay → Node authority, Juno as escrow

Written 2026-09-05, after a green suite run (~4,650 tests) against the five outstanding files.

This plan assumes three decisions already made:

1. **Yellow Sign (#22b)** — the Mark removes only the taken train's earnings; remaining trains pay normally.
2. **Emission (#6)** — the log stays granular; the server emits at *settle points*, not per action.
3. **Settlement** — on-chain appraisal from a submitted final state, plus a log-hash commitment and a
   passive challenge window. No player signatures in the happy path.

---

## 1. What this migration is, and what it is not

**It is not** "rewrite the game in TypeScript." The game is *already* in TypeScript —
`frontend/src/utils/sandboxSession.ts`, 4,343 lines, playtested for weeks and covered by the suite. That
file is the reducer, and it is the artifact worth keeping.

**It is** three separate things that happen to travel together:

- Making the reducer runnable **outside React**, so something other than a browser can execute it.
- Making the reducer's inputs **entirely log-derived**, which closes the divergence class at the source.
- Putting the result behind **one process** instead of N browsers, and settling it on chain.

The Rust game logic (~16k lines across `src/*.rs`, plus 17.5k lines of `tests.rs`) is retired at the end,
**after harvesting**. The escrow is not retired — it barely changes.

---

## 2. The seam already exists, and it is well-marked

`SandboxActionContext` (`sandboxSession.ts:572`) is the extraction boundary, and it was built deliberately —
every injection carries a comment explaining why the reducer may not reach for that value itself:

| Injected | Comes from | Note |
|---|---|---|
| `actor` | the log entry | #549 — already log-derived. No work. |
| `mapGrid` | shell state | Static per room. Easy. |
| `era` | derived phase | Derivable from state. Easy. |
| `marketPriceFor` | **the market chart atom** | #411 — "the chart is a separate atom this reducer must not reach into" |
| `marketMarkFor` | **the market chart atom** | #646 — position + arrival, for the operating-order tie-break |
| `projectRise` | **the market chart** | #746a — `utils/` may not import the chart |
| tile legality | `components/` | #757 — the legality engine lives in a component |

**Three of those seven come from the market chart, and that is the whole of §5a.** `buildOperatingOrder`
sorts on price, column and arrival — all three read through these injections, from an atom the *shell*
owns and each client maintains separately. Two clients whose charts differ produce different turn orders.
That is the root cause the handoff left open, and it is proven in
`frontend/sandbox-log-JUNO-3XD.json` at indices 310/311.

**Folding the chart into authoritative state is therefore not a refactor — it is the fix.** Once the chart
is part of the state the reducer owns and the log produces, the operating order becomes a function of the
log by construction, and §5b's "stamp a seat on the log entry" question stops needing an answer.

The tile-legality injection has the same shape (a rule living in a component) and wants the same treatment,
but it is not a divergence source in the same way — it refuses rather than reorders.

---

## 3. Phases

### Phase 0 — headless reducer, and item 24

**Goal:** `applySandboxAction` executes in Node against a log file, with no React in the process.

**Deliverable:** a CLI that takes an exported log and prints final state — plus a golden-master harness that
replays a log and diffs against a recorded expectation.

**First test is item 24.** Replay `sandbox-log-JUNO-3XD.json` and compare each corporation's
`last_completed_run_revenue` against the `revenue_amount` its own `DeclareDividends` carried. That answers
an open playtest question and proves the harness in the same motion.

This phase writes no game logic. It builds a market-chart module that is a plain function of state rather
than a React atom, and wires the `ctx` providers to it.

**Value even if the migration stopped here:** every future divergence report becomes reproducible from a
log instead of from a description.

#### Phase 0 status — started 2026-09-05

Landed: `frontend/src/utils/replayLog.ts` and `frontend/src/utils/replayJuno3XD.test.ts`. `tsc` clean;
the test file passes on its own (~62s). It replays all 322 entries of `JUNO-3XD` outside React, resolves
the `RevertTo` at index 20, and parses every payload.

Three findings, in order of how much they matter:

1. **`SetupGame` is a log action the reducer does not implement (#1189).** Index 0 of every room's log
   deals the game — roster, variants, unowned board — and `applySandboxAction` has no arm for it. The
   dealing lives in `App.tsx` behind its own `isSetupGameMsg` guard, and `GameplayExecuteMsg` does not even
   describe the message. **The reducer has therefore never been able to replay a room by itself.** A server
   has no shell, so this must become a reducer arm before Phase 2. It is currently a documented shim in
   `replayLog.ts`, written as a near-copy of the shell's block so the two diff cleanly.

2. **The debug export and the stored log disagree about one field (#1188).** `SandboxAction.payload` is
   JSON text; Ctrl+Shift+L emits `msg` as a nested object. Every consumer of an export — this replay,
   `revertTargetOf`, `seedAlreadyRolled` — reads `undefined` and silently does nothing.
   **This bears directly on settlement.** The hash is taken over `payload` strings precisely because those
   bytes are never re-serialized; an export that drops them means a player cannot recompute the hash from
   what they were given, which is the whole point of letting them export. The exporter should carry
   `payload` verbatim before anything depends on the hash.

3. **The accumulating revenue was the harness starving the reducer, not a reducer bug — and finding 1 is
   bigger than it first looked.** Instrumented the cursor at the end of the replay:

   ```
   round: "WaterfallAuction"   order: []   floated: []   macro: 1
   ```

   After all 322 entries the game had **never left the opening auction**. Nothing floated, no Operating
   Round ever began, so `turnChanged` never fired, so #777's clear never ran and the revenue figures piled
   up. The reducer behaved correctly on the game it was given; it was given a game that never started.

   **`SetupGame` is not one missing arm. It is a category.** `isSandboxOnlyMsg` in `gameSetup.ts` (#546,
   deliberately the single place the list is maintained) enumerates every message the chain never knew about
   and the shell therefore handles itself:

   | Message | In `JUNO-3XD` | Note |
   |---|---|---|
   | `SetupGame` | index 0 | deals roster, variants, unowned board |
   | `OpenStockRound` | index 13 | **the round transition** — without it nothing ever operates |
   | `SetBoPar` | index 12 | |
   | `PlaceHomeStation` | ×7 | |
   | `ExchangePrivate` | index 288 | |
   | `ProposePrivatePurchase` / `Answer…` | — | #662 |
   | `ProposeTrainPurchase` / `Answer…` | — | #701 |
   | `CloseRoom` | — | #899 |
   | `RevertTo` | index 20 | correctly NOT a reducer concern (#1026) — resolved by `effectiveActions` |

   Every one of these except `RevertTo` must move into the reducer before a server can be authoritative,
   because **a server has no shell**. That is the true scope of the extraction, and it was invisible until
   something tried to replay a room without a browser.

   **Item 24 remains unreproduced.** The verdict from the triage still stands as untested: nothing here
   supports or refutes it, and no conclusion about `last_route_revenue` should be drawn until the reducer
   can carry a game into an Operating Round on its own.

#### The divergence is located (#1191)

`replayLog` now takes an optional observer, and the harness uses it to check something the log carries for
free: every `RunMultipleRoutes` records `revenue_turn` — `macro.sub.company`, minted by the dispatching
client from **its** cursor at the moment the run went out (#1051). That is a recorded claim about the live
game's state, so the replay either reproduces it or does not, and the failure names an index instead of a
final figure.

**24 of 29 runs disagree, with one signature:**

```
index  71   logged 2.1.1   replayed 3.0.1
index 117   logged 4.1.7   replayed 5.0.7
index 123   logged 4.2.4   replayed 5.0.4
index 131   logged 4.2.1   replayed 5.0.1
index 137   logged 4.2.7   replayed 5.1.7
index 154   logged 5.1.4   replayed 6.0.4
```

Macro consistently **+1**, sub consistently **−1**. Both fields move together in one place — the OR→SR
transition in `settleRoundTransitions` does `macro_round_number + 1` with `sub_round_index: 0`, and #621
notes that "the next `beginOperatingRound` stamps it back to 1". So the replay is **ending Operating Round
sets one round early**: it takes an extra macro transition, and then runs routes with the sub-round still at
`0` because the stamp back to `1` never happened.

**Attributed.** Not a missing arm — `openOperatingRound` and `beginOperatingRound` are called only from
inside `sandboxSession.ts`, never from the shell. The seed is innocent too (`DEFAULT_SANDBOX_SCENARIO` is
the zero-state auction at macro 1 / sub 0, matching the live game; App.tsx's `macro_round_number: 1` write
sits inside the `delayedAuction` branch, false for this room).

The observer was extended to carry the phase and the locked set length beside each turn key, and every
single mismatching run reports the same three values:

```
phase: "2"    setLength: 1    trains: 4
```

**The replay is frozen in phase 2 with four trains on the board, for the entire game.** The live game
plainly went much further — index 117 runs a `3`, index 195 runs two `4`s, index 281 runs a `5`. So:

1. Train purchases stop after four.
2. The phase never leaves 2, so `operatingRoundsForPhase` locks every set at **one** Operating Round
   (#511 stamps the length once per cycle).
3. One-round sets mean a macro transition where the live game had a second OR — hence **macro +1**.
4. `era` is derived from the phase, so route revenue keeps being priced at Yellow values, dividends stay
   small, treasuries stay thin, and the corporations can afford even fewer trains.

That last step closes the loop: it is self-reinforcing, which is why the divergence widens rather than
correcting. The cursor discrepancy is a *symptom* — the disease is that trains stop being bought.

#### Resolved — and it was not the money (#1193)

Instrumented the treasury at every `BuyHardwareFromPool`. **The funds hypothesis was wrong.** Corporations
were floating fully capitalised — 920, 1000, 1000 — and being refused anyway:

```
index 40   B&O   treasury 920   trainsHeld 0   subPhase "Dividends"   actingCorp 1
```

`trainPurchaseRefusal` tests the cursor before it looks at money, and two of its guards were firing at once:
the sub-phase was `Dividends` rather than the Buy Trains step, and `operatingCorporationId` answered **1**
(PRR) while the message was B&O's.

**The cause was a missing composition step, `reconcileParMarks`.** `applySandboxMarketAction`'s `BuyStock`
arm returns the chart untouched, correctly — buying does not move a token in 1830. What it leaves unsaid is
that a corporation being parred for the first time needs a token *placed*, which is not a move.
`App.tsx` runs `reconcileParMarks` after each action; the harness never did.

With no marks, `marketMarkFor` answered `null` for every corporation, so `buildOperatingOrder` lost **both**
tie-breaks at once — column to `-Infinity`, arrival to `Infinity` — and the queue collapsed onto its last
resort, `company_id` ascending. The live game ordered 4, 7, 1; the replay put 1 first. From there: wrong
acting corporation → every train purchase refused → no phase advance → one-round sets → drifting cursor.

**This is §5a in miniature, and it is independent confirmation of it.** The operating order was decided by
chart state the reducer does not own, and two parties holding different chart state produced different
queues. Here the two parties were a browser and a test harness; at indices 310/311 of `JUNO-3XD` they were
two browsers. Same fault, same shape, found twice by different means.

| | before | after |
|---|---|---|
| Phase reached | 2 | **3** |
| Trains on the board | 4 | **8** |
| Turn-key mismatches | 24 / 29 | **17 / 29** |

The auction charges (#1192) and closing the auction atom (#1192a) were real fixes and stay — they were not
the phase lock, but the harness was wrong without them.

#### The replay is faithful (#1194)

**29 of 29 runs now agree with the cursor the live game recorded.** The turn-key assertion is green.

The last 17 mismatches were one fault. The harness's `marketContext` provider had been written from the
shape of the types rather than transcribed from `App.tsx`'s call site, and it was wrong three ways: it
walked `projectDividendCellMove` in a loop instead of passing the step count it already accepts (#908); it
converted `choice` from a boolean when the parameter is already `"pay" | "withhold"`; and it **omitted both
refusal predicates**.

The omission is what cost the replay. #748a and #774 exist because the chart atom runs *before* the reducer,
so it has to ask the same refusals the reducer is about to ask — otherwise a refused sale still walks the
token "and the chart and the board parted company for the rest of the game". #774's own report is *"two
cells rather than one"*. Without them the macro-3 queue came out `[4,7,1]` against the live game's
`[4,1,7]`, `buildOperatingOrder` sorted on prices that should never have moved, and NNH's entire turn was
applied to PRR.

**The standing rule this produces:** where the harness and `App.tsx` differ, the harness is wrong until
proven otherwise. A provider written from first principles is a second implementation of a rule — #1184's
mistake wearing a different hat, and this is the third time that shape has cost this project real time.

#### Item 24 — answered

With the replay faithful, every corporation's filed run reproduces its own final declaration exactly:

| | filed | last declared |
|---|---|---|
| PRR | 210 | 210 |
| NYC | 140 | 140 |
| B&O | 240 | 240 |
| C&O | 290 | 290 |
| NNH | 540 | 540 |

**The reducer does not produce wrong Last Run figures.** A faithful replay of this log lands on exactly the
numbers the live clients declared, die and all. So item 24 is not a reducer bug, and the triage's caution
was right to hold the verdict open rather than patch toward it.

Two candidates remain, and they are testable separately:

- **The display path.** `StockRoundPanel` renders `liveRun > 0 ? liveRun : filedRun`, and `last_route_revenue`
  is turn-scoped and accumulates *within* a turn (#968). A corporation mid-turn can therefore legitimately
  show a figure larger than any single run — NNH's **540** is exactly that, and it is fully explained by the
  #1183 duplicate. If that is what was seen, item 24 and #1183 are one report.
- **Cross-client divergence.** A single-process replay cannot reproduce two browsers disagreeing, which is
  #1182's whole lesson. Phase 1 closes this class at the source rather than testing for it.

#### Phase 0 is complete, and the golden master is captured (#1195)

The five filed-run figures and the run-to-turn-key correspondence are now **assertions**, not printouts. The
file that began as an instrument is a guard.

**The timing was the point.** Phase 1 folds the market chart into authoritative state, which rewrites the
path this replay takes to reach these numbers. Pinned now, the table proves Phase 1 changed the
*architecture* and not the *game*. Pinned afterwards it would only certify whatever Phase 1 produced — the
difference between a regression test and a rubber stamp, and the reason the harness was built before the
refactor rather than during it.

NNH's **540** is pinned as 540 on purpose. It is the #1183 duplicate — 270 twice — and it is what the live
game recorded. A golden master that quietly corrected it would assert a game nobody played. When #1183's
refusal is applied to a rebuild the figure will change, and that line is where the change should announce
itself.

#### Extraction progress — 5 of 10, and the replay is faithful without the other five

`ExchangePrivate` landed with the four before it. The remaining five — the two negotiation pairs and
`CloseRoom` — do not appear in `JUNO-3XD`, so this replay does not exercise them. Faithful on this log is
not the same as complete.

This check stays in the suite and stays red until the replay is faithful. That is deliberate — it is the
one assertion that catches a silent divergence, and a silent divergence is the entire bug class this
migration exists to end.

#### Extraction progress — 5 of 10

`SetupGame`, `OpenStockRound`, `SetBoPar` and `PlaceHomeStation` are reducer arms as of #1189. Full suite
green before the last two; 197 tests across the eleven most exposed suites green after, `replayAttribution`
among them.

The replay now carries `JUNO-3XD` **into Operating Round 7** — corporations float, the operating order
fills, and #777's turn-scoped clear fires as designed (`last_route_revenue` and `printed_route_revenue` end
at `0`, `last_completed_run_revenue` populated). The earlier accumulation was entirely harness starvation.

**Still not a faithful replay, and the remaining gaps are now named:**

- Six messages left: `ExchangePrivate` (index 288 of this log), the two negotiation pairs, `CloseRoom`.
- The waterfall's cash charges are still unapplied (`replayLog.ts` header), so player cash is not usable.
- The round cursor ends at macro 7 / sub 2 where the log's own `revenue_turn` keys imply sub 1. Since
  `rollTurnRevenue` takes the macro and sub round as inputs, a cursor one sub-round off produces a
  different die result — so the filed figures below are close but not yet comparable.

| | filed | last declared |
|---|---|---|
| PRR | 150 | 210 |
| B&O | 140 | 240 |
| C&O | 160 | 290 |
| NNH | **230** | **540** |

**NNH is the interesting row.** 540 was the #1183 duplicate — the same run twice, 270 doubled. The replay
refuses the duplicate and lands on 230, which is 270 under an 85% roll and inside the die's 80–120% band.
That is the first evidence that #1183 does on the real log what it claims to. The other rows do not line up
as cleanly, which is consistent with the cursor divergence above and is not yet evidence of anything else.

### Phase 1 — fold the chart into state

#### The distinction that drives the whole phase

**Static tables may be injected. Mutable positions may not.**

The chart is two different things wearing one name. Its *geometry* — the price ladder, `cellAt`, the four
projections — is a static board definition, identical in every browser and no more dangerous to inject than
`hexTileCatalog`, which `sandboxSession.ts` already imports from `components/` without incident. Its
*positions* — which cell each corporation's token occupies — are mutable state that the shell has been
maintaining separately in every client. That is the half that made two browsers disagree.

So Phase 1 is not "stop importing from `components/`". It is: **the positions move into
`GameStateResponse`, and the reducer writes them.** The geometry can stay exactly where it is.

#### What the survey found

- `SandboxMarketPrices` is already plain serializable data — `Record<number, {price, x, y, enteredAt?}>`.
  It can go into the state response unchanged.
- `enteredAt` is **already a derived ordinal rather than a clock** (#646: "derived, so a replay reaches the
  same numbers"). The tie-break the operating order depends on is therefore already log-derivable; nothing
  about it needs redesigning.
- Only **27 lines** of `App.tsx` touch `sandboxMarketRef` / `setSandboxMarket`. The shell-side change is far
  smaller than the 12k-line file suggests.

#### Increments, each verifiable against the golden master

1. **Additive fold.** `market_positions` joins `GameStateResponse`; `applySandboxAction` calls
   `applySandboxMarketAction` itself when the field is present; `buildOperatingOrder` prefers the field over
   its injected resolvers, falling back when absent. Backwards compatible — the shell, which does not set
   the field, keeps its current path untouched — while `replayLog` switches to the new one and #1195's
   pinned table proves the two produce the same game.
2. **Retire the shell's atom.** `App.tsx` reads `gameState.market_positions`; the ref and its setter go.
3. **Remove the fallback**, and with it the market group of `ReplayProviders`. Phase 1 is done when that
   interface is `initialGrid` and `layRefused`.

The strangler order matters: at no point between increments is the game running on two chart
implementations that could disagree, because increment 1's fallback is only reached when the new field is
absent entirely.

#### Increment 1 — done, and the golden master held (#1196)

- `market_positions?: Readonly<Record<number, MarketPositionMark | null>>` is on `GameStateResponse`.
  Optional, with #232's reading: `undefined` is "this caller carries no positions", never "the chart is
  empty" — an empty chart is `{}`.
- `MarketPositionMark` is declared in `gameState.ts`; `SandboxMarketMark` is now an **alias** of it rather
  than a second declaration, so its ~40 call sites survive with one definition behind them. Two copies of one
  shape is #1184's failure and this project has now paid for it three times.
- `buildOperatingOrder` resolves price, column and arrival from `state.market_positions` when present and
  falls back to the injected resolvers when not. **This is the §5a line.** The queue now sorts on a field of
  the state rather than on a closure over a per-client React ref.
- `replayLog` publishes the chart onto the state before handing it to the reducer, so the harness takes the
  new path while `App.tsx` still takes the old one.

**Verification:** #1195's pinned table and the 29/29 turn-key correspondence both still hold with the queue
sorting on the new field — two code paths, one log, identical answers. 320 tests across the 18 suites that
touch the operating order, the chart or replay attribution are green, `replayAttribution` and
`reducerReadsOneChart` among them.

That is exactly what capturing the master before the phase was for.

#### Increment 2 — the reducer owns the chart step (#1197)

`applySandboxAction` now performs the whole two-atom sequence itself when `market_positions` is present:
advance the chart, price the trade, settle the board, reconcile par marks. Gated the same way as increment
1, so `App.tsx` — which does not yet set the field — keeps its existing path untouched.

**The reason this is worth doing, stated plainly:** every consumer of the reducer previously had to perform
the same dance in the same order, and *"every consumer must remember"* is the property this migration
exists to delete. Two consumers got it wrong inside one afternoon — the harness omitted `reconcileParMarks`
(#1193), then wrote its own `marketContext` from the shape of the types instead of transcribing the shell's
(#1194). Each silently rearranged the operating order. There is now no ordering left for a caller to get
wrong.

Two injections disappeared rather than moved. `dividendRefused` and `saleRefused` existed (#748a, #774) so
that a chart running *outside* the reducer could be told what the board would refuse. Inside, the reducer
holds that state and asks for itself — and `SandboxActionContext` deliberately does not accept them, because
a caller that could still supply them could still supply the wrong ones. That is the exact gap #1194 opened,
now closed by construction. `sharePrice` went the same way: the reducer prices the trade, so the wallet and
the chart cannot be handed two different figures.

What remains injectable is **geometry only** — the ladder's shape, the projections, the par-box resolver,
the board's label table. Static tables, identical in every browser, exactly like `hexTileCatalog`.

**Verification:** golden master and 29/29 turn keys still hold; 366 tests across 21 suites green.

#### Increment 3 — deferred, deliberately

`App.tsx` keeps its chart for now. The survey said 27 lines; reading the dispatch properly found **three
separate chart writers**: the `applySandboxMarketAction` block, the `placeParMark` calls for the B&O par and
the reconcile, and a sold-out rise loop at ~5842 that walks the chart by hand *after* the reducer returns —
while the reducer performs its own rise through `projectRise` (#746a) before sorting the queue. That
behaviour currently straddles the boundary.

Three things made deferring the better call: the golden master **cannot** verify it, since the replay never
executes `App.tsx`; the surgery spans ~40 sites across those three writers; and it edits the dispatch path
Phase 2 replaces outright. The reducer is already correct and proven, so the server inherits the right
behaviour from day one and never inherits the shell's three writers.

**The cost of deferring, stated honestly:** §5a's fix does not reach live players yet. Today's clients still
sort the operating queue on a per-client chart. That is the behaviour the playtests have been running on,
and its worst symptom (#1182) is already reverted, but divergence remains possible in a live room until
Phase 2 lands.

#### Extraction complete — 10 of 10 (#1198)

Both negotiation pairs and `CloseRoom` are now reducer arms. **None of them appears in `JUNO-3XD`**, so they
are covered by `shellMessageArms.test.ts` case by case rather than by the replay — "faithful on one log" and
"correct" are different claims, and the second needed cases the first never produced.

**The boundary these arms draw, and the test that pins it:** an accepted offer causes a *new log action* to
be sent — an ordinary `BuyPrivateCompany` or `BuyTrainFromCorporation`, so consent and legality run through
the same code as every other purchase (#662, #701). That dispatch stays in the shell, because #576 is
explicit: *"a consequence is DERIVED by every client, not appended by each of them — appending inside a
replay is how one win issued two certificates."* A reducer that appended would append once per client and
again on every rebuild.

So: the reducer settles what the offer **did** to the board; the shell decides what to **send** next. The
final case in `shellMessageArms.test.ts` asserts exactly that — an accepted offer leaves private ownership,
holdings and cash untouched — so if the arm ever starts doing the buying itself, something notices.

`isSandboxOnlyMsg` lists eleven messages. Ten are now reducer arms. `RevertTo` is the eleventh and never
moves: #1026 — a revert is an instruction *about* the log, resolved by `effectiveActions` before the reducer
sees any history at all.

The market chart stops being injected and becomes part of `GameStateResponse`, written by the reducer.

- Closes §5a.
- **Changes how every existing log replays** — same category as #1184, wants the same knowing approval.
- Reducer change: suite run before and after.
- The three chart injections come out of `SandboxActionContext`; `mapGrid` and `era` can follow.

This is the highest-risk phase and the one that pays for the whole migration.

### Phase 2 — Node as authority

#### Step 0 — the reducer runs in a bare Node process (#1200)

**The tempting first move was to write a server. That would have been the wrong order**, because everything
after it rests on a question nobody had asked: can the reducer be *loaded* into Node at all?

It was not idle. `applySandboxAction` imports `utils/gameState.ts`, which holds the state types alongside a
React hook — so **the reducer's own import graph reaches `react`**. The chart geometry the providers need
lives in `StockMarketRenderer.tsx`, a component file. Neither is fatal in Node, and neither was known until
something outside a browser and outside jest tried to run.

So the first artifact is the smallest thing that answers it: `server/src/replayCli.ts`, which reads an
exported log, replays it, and prints what the game came to. No network, no framework, no persistence.

**It works.** Against `sandbox-log-JUNO-3XD.json`, in `node` with no browser and no test runner:

```
room JUNO-3XD | entries 322 | applied 320 | dropped 2
cursor OperatingRound 7 . 1 | phase 5
lastRun: PRR 210  NYC 140  B&O 240  C&O 290  NNH 540
```

Macro 7 / sub 1 is the live game's own `7.1.x` keys; phase 5 is the phase it reached; the five figures are
the golden master. **The reducer reconstructs the game from the log alone, on a server.** Everything Phase 2
needs after this is ordinary wiring.

It is also useful in its own right, and it completes a sentence #1160 started. The exporter was built
because a reported Undo fault could not be found by reading, and the reasoning was "the log is the game, so
a bug report should be the log". This is the other half: a log any holder can replay, without a browser,
without the room, and without the reporter present.

**The providers moved first (#1199).** They lived in `replayJuno3XD.test.ts`, which was right while the
harness was the only headless consumer. The server is the second — and a server assembling its own would be
one rule implemented twice, which is #1184, #1193 and #1194, three separate occasions this project has paid
for that shape. `replayProviders.ts` is now the single set; the test and the CLI both import it.

**Build:** `server/tsconfig.json` compiles the CLI plus its slice of `frontend/src`, borrowing the
frontend's `@types` rather than standing up a second dependency tree.

```
cd server && ../frontend/node_modules/.bin/tsc -p tsconfig.json
node dist/server/src/replayCli.js ../frontend/sandbox-log-JUNO-3XD.json
```

**Known debt, recorded rather than fixed:** the server drags React in for a set of pure lookup functions,
because `gameState.ts` mixes types with a hook and the ladder's geometry sits in a `.tsx`. Splitting both is
the obvious cleanup; both are shell-side edits, and Phase 2 has no business editing the shell while standing
up its replacement.

#### Step 1 — `RoomEngine`, and why batch equals incremental by construction (#1201)

A server receives **one action**, appends it and answers. It never holds the whole history the way a replay
does. That is a genuinely different shape from `replayLog`, and the obvious way to get it — write a second
loop performing the same steps — is the mistake this project has made and paid for three times (#1184,
#1193, #1194).

**So `replayLog` is now a loop over `RoomEngine`.** Batch and incremental are not two implementations tested
against one another; they are one implementation. The golden master runs through the engine, so it covers
both, and "replayed on load" versus "applied live" — precisely the divergence class this migration exists to
end — has no room left to differ.

The order inside `apply` is the one `App.tsx` established and #272/#273 fixed: tile grid first (a lay must be
visible to the legality check of the lay after it, #757), then the auction atom (#261), then the board, which
now performs the chart step itself (#1197). Every one of those orderings was learned from a reported bug.

`replayLog` stays a function rather than becoming a method, and the reason is `RevertTo`: resolving reverts
needs the **whole** log (#1026), which a server appending one action at a time does not have. A room rebuilds
through `replayLog`; a room in play advances through `RoomEngine.apply`.

**What the engine deliberately does not do is decide when to emit.** A settle point is the end of a burst — a
player action plus the derived consequences that follow it — and the server cannot know a burst has ended
until it *generates* those consequences itself.

#### Step 2 — derived actions, and a real settle point (#1202, #1203)

**The survey was the good news.** Every piece of judgement behind `autoSkipReason` was already in a pure
module — `earnableRevenueVerdict` / `skipReasonFor`, `assignRouteSet`, `stationPlacementBlockReason`,
`isTrainLocked`, `autoSkipExit`, `stepsFor`. **None imports React**, and their `components/` imports are all
`.ts` data and geometry (`TileGraphics.ts` included, despite the name). What lived in `App.tsx` was argument
assembly and memoisation. `derivedActions.ts` is therefore mostly a switch and a few `find`s.

**Three things changed in the move:**

- **The spectator guard is dropped.** It was a statement about how somebody is *watching*, not about the
  board. A server computes the board's answer; nobody is watching it.
- **#774's ownership check is dropped, and its problem with it.** The shell needed `isMyTurn` because every
  seated browser reached the same conclusion from shared state and each appended its own copy — *"a share
  price that moved two cells left rather than one"*. One writer cannot race itself.
- **#774's idempotency half survives, for a different failure.** `emitted` keys guard a server restarted
  mid-turn, or rebuilding from a log, against re-sending what the log already holds. `turnGuardKey` is built
  from the round, sub-round and corporation index, so a rebuild reproduces the same keys for free (#1145) —
  the guard survives a restart without persisting anything.

**And the settle point is now definable rather than guessed.** `RoomEngine.submit` applies a player's action,
then loops `nextDerivedAction` until it returns `null`, appending each. **The burst is over when the game
stops owing actions** — not a debounce, not a heuristic: the same question the shell asks, answered until it
stops saying yes. `apply` remains for replay, where the log already carries its derived entries and
generating would double every automatic action in the game.

**One input is not log-derived, and it is not this step's to fix.** `stationPlacementBlockReason` asks whether
the D&H's free station is still available, and `App.tsx` answers from `usedPrivateAbilities` — a
`useState<Set<string>>` in the shell. That is exactly what #1044 forbids in as many words: *"anything not
derivable from that log is a fact one browser knows and the others do not."* A player who reloads loses it; a
player who joins late never had it. It arrives as a parameter defaulting to "still available", because
guessing "spent" would auto-skip the Tokens step for a corporation whose only legal placement is the D&H's,
and #414 settled which of those two mistakes is worse. **Putting the ability's spent-ness on the board is a
real fix and belongs with the audit.**

#### Step 2b — the route search wired, and one ordering worth flagging

`maxRouteRevenueFor` now runs `assignRouteSet` for real, assembling the fleet, the token set and the
tokened-out-city blocker from the board. Everything it needed was already pure; the only thing `App.tsx` had
that this does not is a React ref (`blocksThroughCityRef`), which exists because a callback closes over a
stale render — and there are no renders here.

**One deliberate difference from the memo it was lifted from.** `App.tsx` calls `stationTokensOf` and *then*
asks whether `station_token_hexes` was present; `stationTokensOf` maps over that field without guarding it,
so an absent list throws before the question is reached. Unreachable in practice in a browser; on a server it
would take a room down for one malformed snapshot. Asked in the safe order here. **The shell's ordering is
worth a look during the audit.**

#### Step 2c — the private powers come off the shell (#1204)

`usedPrivateAbilities` was a `useState<ReadonlySet<string>>` in `App.tsx` — the same fault as the market
chart, one private power over, and #1044 names the rule it breaks: *"anything not derivable from that log is
a fact one browser knows and the others do not."* Not cosmetic either: `dhPowerState` computes
`forfeited = hexBuilt && !layUsed`, so two clients disagreeing about `layUsed` disagree about whether a power
still **exists** — and that answer feeds the Tokens auto-skip, which takes a player's turn away.

`used_private_abilities` is now on `GameStateResponse`, written by the reducer. The two halves are not
symmetric, and the asymmetry is the interesting part:

- **`dh-token` was already in the log and nobody was reading it.** `PlaceHomeStation` carries `kind: "dh"`
  and has since #560 — index 115 of `JUNO-3XD` is one. The reducer records it now; no format change needed.
- **`dh-tile` and `csl-tile` had to be told.** The same hex can be laid *using* the power or *in spite of* it,
  with opposite consequences, and the hex cannot distinguish them. #817 is the report from inferring it:
  *"I placed a tile that was not the F16 one, and it seems the DH power was consumed."* Intent is a choice,
  and #550 puts choices in the log — so `LayTile` gains an optional `ability_key`, the twin of
  `PlaceHomeStation`'s `kind`.

**What remains, and it belongs with the deferred increment 3:** the reducer can record `ability_key`, but
`App.tsx` does not send it yet, and the power-state readers still consult the shell's `Set`. Both are shell
edits, so they join the same pile as retiring the chart ref. Old logs carry no `ability_key` and #232's rule
applies — absent means "this build did not say", not "no power was used". Such a log cannot answer whether the
D&H's lay was its own, and no heuristic should pretend otherwise; guessing is what produced #817.

188 tests green across the twelve suites touching derived actions, private powers and the replay.

#### Step 3 — turn authority (#1205)

**The thing that defeated the reducer twice, and the reason it no longer does.**

#1174 put `offTurnRefusal` inside the reducer and broke ten tests across four suites, `replayAttribution`
among them. #1182 compared a message's `protocol_id` against `active_corporation_index`, passed every test
it had, and reached players. Both notes conclude the same thing: a refusal may only compare values identical
on every client **by construction**, and no cursor was.

**That objection was never about the rule. It was about there being two judges.** One writer cannot disagree
with itself, so the check #1174 could not perform inside a replay is exactly what an authority is for.

**And it is not a reimplementation.** `actingAddress` in `gameState.ts` already answers all four cases — the
mini-auction's own cursor (#544), the waterfall rotation, the Stock Round seat, and the Operating Round's
**president** rather than any seat index (#411). What the reducer lacked was never the rule; it was the
auction atom, which `actingAddress` needs and `applyOneAction` was never passed. `RoomEngine` holds both. So
`turnAuthority.ts` resolves the actor, asks that function, and spends its length on the exemptions — which is
where the complexity always was.

**The exemptions are three, not four,** and correcting that is worth recording. #1174's note lists four
"legitimately off-turn" flows, and the fourth — *"a `SellStock` that does not advance the seat at all"* — is
an observation about the **cursor**, not about authority: a sale that leaves the seat where it is still
happens on the seller's turn. The shell's own gate has exactly three exemptions (`isRemoteReplay`,
`automatic`, `offTurn`) and no arm for `SellStock`, which settles it.

| Exemption | Why refusing it would break real play |
|---|---|
| The game's own actions (`derived`) | The authority does not audit its own output. A `PassTurn` that ends a turn is by definition not on anybody's turn. |
| A null actor (#549b) | A positive state, not a missing field — `applyOneAction` resolves it to the cursor for solo play. Refusing makes a one-player game unplayable. |
| Consent answers (#701) | A corporation on its turn **offers**; the private's owner or the selling president **answers**, and that player is never the one operating. Refusing makes every negotiation unanswerable. |

The consent check reads the **board**, not a flag the sender sets about itself — #1198 put both offers on the
state, which matters now that the sender is a network client rather than the shell's own code. And an
unresolvable cursor allows the action through, the same line `dividendGate` and `trainPurchaseGate` both
take: a board that cannot say whose turn it is has said nothing about this player.

12 cases green, each naming the flow it protects.

**Audit item found in passing:** `private_purchase_offer.price` is a `number` while `train_purchase_offer.price`
is a `string`. Harmless today because nothing does arithmetic on either, but two fields meaning one thing in
two types is how they come to disagree.

#### Step 4 — the wire, and a correction to the settlement reasoning (#1206)

**The protocol ships log entries, not state.** The server appends, then returns what it appended — the
player's action with its allocated index, plus whatever derived actions the burst generated. Clients apply
those through the same `RoomEngine`. State stays derived on both sides: smaller on the wire, already
canonically serialized as `payload` text, and it composes directly with settlement.

**And that exposes something the settlement reasoning got half right.** The claim was that the log commitment
avoids canonicalisation entirely, because `payload` is text nobody re-serializes (#1188). True — and useless
for divergence detection. **Every client holds the same log by construction; that is what an append-only log
is.** The failure being hunted since §5a is two clients deriving *different state* from *identical entries*,
so a log hash agrees in exactly the case worth catching.

Detecting it means hashing **state**, which means canonicalising state — so the trap flagged for settlement is
real here instead. `stateDigest.ts` handles it explicitly, and the rules are tested rather than assumed:

- **Keys sorted, recursively.** Insertion order is a property of how an object was built, not what it
  contains — and two clients build one board by different routes constantly, one replaying, one draining.
  A digest over `JSON.stringify` reports a desync every second message.
- **Arrays keep their order,** because here order *is* content: `active_operating_order` is the whole of §5a.
- **`undefined` omitted, `null` kept.** #232 encoded: absent means "this build does not say" and matches a key
  nobody wrote; `null` is a positive answer somebody recorded.
- **Non-finite numbers are named, not smoothed.** `JSON.stringify` writes `null` for `NaN`, so a corrupted
  board would digest as a clean one.

FNV-1a over two lanes, 64 bits. **#1051's lesson is observed rather than repeated:** that note found the die
firing 29% at one face because `carcosaRollHits` read `spun % 10`, and FNV's low bits are dominated by the
characters processed last. The fault was the modulus, not the hash — nothing here takes a remainder, and a
case pins that inputs differing only at the end still separate.

**Explicitly not cryptographic.** This catches accidental divergence between cooperating clients. Settlement
has an adversary in it and hashes the log with a real digest; anything that starts trusting this value
against a motivated party is a bug.

**One consequence to build into the transport:** the digest covers the whole state, so a client on an older
build disagrees with the server about a field that is not a divergence at all. The wire must carry a build
identifier and say so plainly — otherwise version skew surfaces as a phantom desync, which is the exact thing
this migration exists to stop chasing.

12 cases green.

#### Step 5 — the protocol (#1207)

**Log entries on the wire, not boards.** Smaller; already the source of truth settlement commits to; and — the
reason that decided it — a client handed a finished board would have nothing to apply, so its local reducer
would become decorative and the divergence check with it. Handed entries, both sides do the same work and can
be compared. That check has found most of this migration's bugs.

**The actor is deliberately not on the wire.** A submission says *what* the player wants to do and never *who
they are*; the server knows that from the authenticated connection. A field saying so would be a field a
client could lie in. Same lesson `turnAuthority` learned one layer down (#1205) — the consent exemption asks
the **board** whether this actor is the counterparty rather than trusting an `offTurn` flag the sender sets
about itself. That was safe while the shell called its own code, and stops being safe the moment the sender is
a network client.

**The server mints the payload bytes, which is a change and an improvement.** #1188 called client-side minting
a happy accident — it is what makes the log hashable with no canonicalisation scheme. With one writer the
accident becomes a guarantee: the server serialises through `canonicalJson`, so log bytes are canonical **by
construction** rather than by nobody having touched them. It also closes a subtlety nobody had noticed — two
clients sending the same logical move could previously mint different text for it, same state, different
bytes. Harmless for replay, quietly awkward for a commitment. One serialiser ends it.

`baseIndex` gives the server the "you are behind" answer instead of a guess: a client that has missed entries
would otherwise apply the next burst onto a board that never saw the previous one and derive a board nobody
has — **a divergence manufactured by the transport rather than found by it.**

`build-skew` is its own response case rather than an error string, because #1206's digest covers the whole
state and an added field is not a divergence. A client that learns this should stop reporting desyncs rather
than filing reports nobody can act on.

And `DivergenceReport` is a report, not a request — there is nothing to ask for, the server is the authority.
What it buys is the thing the old architecture could never get: **a divergence that announces itself, at the
index where it began**, instead of surfacing three rounds later as a station token somebody else cannot see.

5 cases green, pinning the two things the compiler cannot check: that one serialiser makes the bytes
canonical, and that a payload round-trips to the move the sender meant.

#### Step 6 — the server loop, and the dropped socket (#1208, #1209)

`RoomSession` is the loop: **build skew → replay-safety → staleness → authority → apply → append → answer.**
Each step answers a question the next would otherwise answer wrongly, and each is cheaper than the one after.
It **does not authenticate** — a session is constructed with an identity the transport established, and never
told one by a request (#1207). That is what makes it testable without a socket.

**Asking about the dropped socket found a real bug in already-shipped code.**

`RoomEngine.submit` recorded each derived action's turn key in `emitted`. **`apply` did not.** So a server that
crashed and rebuilt from its log came back with an empty set, looked at a turn whose auto-skip was already in
the history, and owed it again — one crash, one duplicate forced withhold, and #774's *two cells rather than
one* arriving from a completely new direction. Fixed in #1208: `apply` now recomputes the key from the board
each derived entry was about to be applied to. **The log already carried the answer**, because `turnGuardKey`
is built from the round, the sub-round and the corporation index. #1145 keyed it that way for a different
reason; this is the first thing to need it.

**The answer to the question itself, in two halves:**

*Dropped before the response.* The append is the commit point; the response is news. Anything else means a
game whose history depends on whether a packet arrived. So a retry must be safe, and three mechanisms catch
it: a **submission nonce recorded on the log entry** (so "have I applied this?" survives a restart with
nothing persisted beside it), **`baseIndex`** (a client that reconnects before retrying gets a catch-up and
never needs the nonce), and the **turn gate** as a backstop — though that one is silent about *why* and fails
exactly where a duplicate is most plausible, an action that does not end a turn.

*Dropped mid-burst — the harder case.* If the server dies between appending a move and appending the auto-skip
it owed, the log holds a move whose consequences never landed. **That repairs itself**, because derived
actions are re-derived rather than remembered: on restart `nextDerivedAction` looks at the rebuilt board and
says the game still owes one, while #1208's guard stops it re-owing what already landed. `settleOwed` runs
before anything else touches the board, since **a board mid-burst is a board no rule was written against.**

10 cases green here, 83 across the nine suites this touches — `replayAttribution` and `reducerReadsOneChart`
included.

#### `sandboxRoom.ts` — not yet, and the reason matters

The index-allocation cleanup was queued for this step and **should not land here.** `#1026`'s Firestore
transaction is what stops two *browsers* colliding on an index, and browsers are still the only writers —
nothing routes through `RoomSession` yet. Removing it now would leave live rooms with no allocator at all.

It becomes dead weight the moment clients submit instead of appending, and not one commit before. That is the
client cutover, which is the same pile as increment 3 and the `ability_key` sender.

#### Step 7 — the server process, and the smoke test (#1210)

**The cutover was asked for before the thing to cut over to existed.** `RoomSession` is the loop, but nothing
hosted it — a browser client written against it would have had no target and could not have been verified in
the one file this project cannot debug cheaply. So the server process came first.

`server/src/gameServer.ts` is deliberately thin: sockets, a room registry, fan-out. **If a rule ever appears
in that file it is in the wrong place** — a rule the transport knows is one the replay harness cannot
execute, the CLI cannot check and the golden master cannot cover, which is precisely what made `App.tsx` the
authority for so long.

**Identity has no default.** `resolveIdentity` is required, because everything Phase 2 built rests on the
server knowing who is speaking: #1207 keeps the actor off the wire so a client cannot claim a seat, and
`turnAuthority` then refuses actions on that basis. A transport with a trusting fallback would undo both
while every test still passed. `trustClaimedIdentity` exists for local play, is named to be embarrassing in a
diff, and shouts on every connection.

**`smokeTest.ts` proves the loop over real sockets** — the thing no unit test can say. Two clients, one room,
thirteen checks, all green:

```
ok  a joining client is caught up          ok  the other client is told
ok  the deal is applied                    ok  a repeated submission id → catch-up
ok  and carries the entry it appended      ok  and the room did not grow
ok  with a digest                          ok  an out-of-turn move is refused over the wire
ok  a mismatched build is named rather than applied
```

The retry and out-of-turn cases matter most: they are #1209's and #1205's reasoning arriving intact at the
far end of a socket rather than in a test harness.

Two notes on the build. The server now has its own `package.json` — borrowing `ws` from webpack-dev-server's
transitive copy got an API three majors old. And it still needs `NODE_PATH` pointed at the frontend's modules
because `gameState.ts` imports React (#1200's recorded debt); that is now a runtime requirement rather than
an untidiness, and worth clearing when the shell is next opened.

#### The cutover: sequence, not a single commit

The four deferred items interlock — the transport replaces the append path, retiring the chart writers
rewrites the same dispatch block, `ability_key` rides on that dispatch, and the index cleanup is only safe
once the transport is the sole writer. All four in one pass, in a 12,665-line file the golden master cannot
reach, is the shape every bug this migration found came from.

They are not equally coupled, though:

| | Depends on | Verifiable by |
|---|---|---|
| **Increment 3** — retire the chart writers | nothing | the suite's source-scan tests; the reducer path is already proven |
| **`ability_key` sender** | nothing | `shellMessageArms` + a source scan |
| **Transport** | the server (now exists) | the smoke test, then a real playtest |
| **`sandboxRoom.ts` cleanup** | the transport | nothing until the transport lands |

So: **increment 3 and `ability_key` first**, independently and with a suite run each. Both shrink the dispatch
block the transport then has to rewrite. Transport third, cleanup last.

#### Increment 3 — done (#1211)

**The reducer half came first, because it is the half the golden master can check.** #746b's own sentence was
the reason the sold-out rise was committed in `App.tsx`: *"the reducer has already USED these rises… but the
market atom is not part of `GameStateResponse`, so the tokens themselves still have to be moved here."*
**That premise stopped being true at #1196.** `applySandboxActionInner` now commits the rise beside the par
reconcile — the two halves of one rule, together, unable to disagree about a price. Golden master held.

**Then the shell.** Three writers retired:

- **The dispatch's chart write.** `after` now carries `market_positions` into the reducer and takes them back
  out. The ref below it is a **render mirror**, not an authority — the ~30 components reading `sandboxMarket`
  are untouched. That single line was §5a: a private copy of the chart that `buildOperatingOrder` sorted the
  turn order on.
- **The sold-out rise loop.** Commit gone, log line kept — narration is the shell's job (#704) and always was.
- **`SetBoPar`'s `placeParMark`.** The reducer reconciles after every action (#1193), so the second place this
  could be forgotten is gone. `placeParMark` and `withArrival` are no longer imported by `App.tsx` at all.

`sharePrice` also left the context: the reducer prices the trade itself (#1197), so the wallet and the chart
can no longer be handed two different figures — which was #273's point, previously guaranteed only by this
file passing one number to both.

**One thing kept on purpose, and named rather than hidden.** `applySandboxMarketAction` is still called in the
dispatch — for its **report**, not its result. `marketResult.moved` is what the Activity Log's sentence is
built from, and a position diff cannot say *why* a token moved. It is the same pure function on the same
input the reducer then uses, so the two cannot disagree; the cost is one extra evaluation per action, and the
benefit is that the narration is untouched by an unverifiable change. Folding the reason onto the state is the
tidier end state and was deliberately not attempted in the same commit as the authority move.

113 tests green across the nine suites touching the chart, the queue and replay attribution.

#### Increment 2 — `ability_key` sent, and #1044's hole closed

**The ordering was the fix, not the field.** `errandClaimsLay` has always been asked — #817 is the report from
asking it the wrong way. What changed is that it is now asked **before** the dispatch, so the answer can
travel. Resolved afterwards it could only ever reach a local `Set`, which is where it has been living.

Both lay paths carry it — the sandbox dispatch and the chain one. A field added to one of them is a rule that
holds in a room and not on chain, which is the shape of every mirror bug in this codebase (#436's note records
why there are two sites at all). Omitted when absent rather than sent as `null`: #776's rule, so an ordinary
lay's entry is byte-identical to the ones written before the field existed, and #232's, because `null` would
be a build asserting "no power was used" — a different and unearned claim.

**The readers moved too, with a fallback that is not laziness.** `dhPowerState` and `cslPowerState` now read
`used_private_abilities` off the board, union'd with the local `Set`. Reading only the `Set` is what made a
reload lose a power. Reading only the board would **resurrect** powers in a room whose log predates
`ability_key` — absent means "this build did not say", not "unspent". The union is the honest reading during
the changeover, and the fallback comes out when no live room predates the field.

Pinned by source scan, because whether `App.tsx` puts a field on a message is not something any headless
replay can execute. The cases assert the **ordering** rather than the presence, since a version that resolved
the ability after the dispatch would still compile, still set the `Set`, and still lose the fact on reload.

168 tests green across the eleven suites touching private powers and the replay.

#### Transport, part 1 — the client link (#1212)

**Shaped like what it replaces.** The shell calls `appendSandboxAction(...)`, which resolves to an allocated
index, and `subscribeSandboxLog(...)`, which hands back entries. `serverLink` offers exactly those two
shapes — `submit` resolves to an index or `null`; entries arrive through a callback. The `App.tsx` cutover is
then a **swap rather than a rewrite**, which matters more than elegance in the one file this project cannot
verify cheaply: every line of diff there is a line nobody can test.

`null` rather than a throw, for the same reason — the shell already has a branch for "the append did not
happen", and a rejection would need a new one.

**Matching a reply to a submission.** A burst puts several in flight (#941 records why the shell loops), so a
reply must find its caller. **FIFO is the mechanism**: one socket delivers in order, the server handles in
order and answers each before reading the next, so the oldest unanswered submission owns the reply — and a
refusal carries no entry, so nothing else could match it. **The nonce is the check**: an `applied` frame
carries the entry, and the entry carries the `submission_id` this client minted (#1209). Where present it is
asserted against the queue's head, and a mismatch is *reported* rather than resolved, because handing one
dispatch's index to another produces a board disagreeing with its own log — the hardest thing to trace back.

**Three orderings the smoke test cannot reach cheaply**, and each is a real case rather than a hypothetical:

- **A dispatch made before the socket opens.** Nothing stops a player clicking during connection; a
  submission dropped there is a button that did nothing. Queued, sent after `hello`.
- **A watcher's frame.** Another player's move arrives as the *same* `applied` frame (#1210 — the fan-out
  carries what was appended, because it is the same news). The pending queue is what tells them apart, and a
  client with nothing outstanding must not consume a promise that does not exist.
- **A socket that closes with work outstanding.** Everything settles `null`. A promise that never settles is
  a game that looks crashed — and `null` is the honest claim: #1209 makes the append the commit point, so
  *"this client did not see it applied"* is a different statement from *"it did not happen"*, and only the
  first is being made.

No reconnection and no backoff, per the owner's call — the resilience worth writing is the resilience whose
failure modes have been seen. `baseIndex` is carried anyway, because the server needs it to answer a
catch-up, and a client that reconnects one day will find the protocol already knows how to say "here is what
you missed".

11 cases green.

#### Transport, part 2 — the swap (#1213)

**The cutover is a setting.** `GAME_SERVER_URL` unset is today's Firestore path, byte for byte. Set, and the
room routes through the server. With no live rooms to protect, the switch earns its place as a **diagnostic**
rather than a safety net: being able to flip transports on one build is how the next playtest tells a
transport bug from a game bug.

Two call sites changed, and the link was shaped to make them small (#1212):

- **The append** becomes `link.submit(msg)`, which resolves to an allocated index or `null` — the same
  contract `appendSandboxAction` had, so the shell's existing failure branch is untouched.
- **The subscription** accumulates entries and hands `drain` the whole log, because that is the shape `drain`
  was written against (#522: a refresh and a single append are one code path). Teaching the function every
  client's board depends on to accept a second shape would have thrown away the point of the mirroring.

**The trap, caught before it shipped.** On Firestore, *this client* generates the game's own actions — the
auto-skip, the forced withhold — and #774's `isMyTurn` guard is what stops four browsers appending four
copies. On the server, **the server** generates them (#1203). A client that also sent one would have it
applied as a *player* action and the server would then generate its own on top: two forced withholds, which
is #774's two-cells-rather-than-one wearing the new architecture's clothes. So on the server path the shell
does not send derived actions at all — the effects still run and decide, harmlessly, and will be deleted with
the rest of the shell's authority.

**Audit item found in passing:** the log carries more than `GameplayExecuteMsg` describes — `SetupGame`,
`OpenStockRound` and the rest of `isSandboxOnlyMsg` (#530). The reducer casts, the smoke test casts, and now
the dispatch does. The honest fix is a `LoggedMsg` union spanning both, which is a type change of its own
rather than something to smuggle into a transport commit.

#### Running it

```
# once
cd server
npm install

# server: refuses to start without an identity resolver, by design (#1210)
cd server
npm run build
node dist/server/src/start.js --insecure-local-identity --build dev

# client, in another terminal
cd frontend
npm start        # reads frontend/.env.local
```

The build id given to the server **must match** the client's `REACT_APP_BUILD_ID` — they are compared
exactly (#1206), and a mismatch is answered with `build-skew` rather than a phantom desync. Comment out
`REACT_APP_GAME_SERVER_URL` in `frontend/.env.local` and the app is on Firestore exactly as before.

`npm run smoke` in `server/` proves the server end with two scripted clients and no browser at all — worth
running first, because it isolates "the server works" from "the browser talks to it". It binds **port 0**,
so it can also be run alongside a live server, which is when it is most wanted.

#### The waiting room comes off Firestore (#1215)

**Found by an outage, not by a plan.** Mid-playtest, `firestore.googleapis.com` began timing out on both A
and AAAA while the rest of the internet answered. "Host game" did nothing at all — not an error:
`hostSandboxRoom` awaits a write that never lands, `sandboxRoomBusy` stays true, and the button sits there
looking broken.

**The diagnosis is the interesting part.** Phase 2 had already moved the *log* off Firestore, and that
half worked. The *room document* had not moved, and #856 established that the roster is load-bearing:
`SandboxWaitingRoom` counts it, the Start button is gated on it, `toSetupPlayers` reads it to build the
deal. So the game could run without Firestore but the table could not be seated — which is no better.

**The roster is NOT in the action log, deliberately.** The obvious move is a `PlayerJoined` entry, and it is
wrong: #522 says the log is the game and #549 says the reducer is a pure function of it. A lobby entry
changes no board and carries no rule, and every replay, golden master and digest would have to learn to step
over it. The lobby is what happens *before* there is a game to have a log of. So:

| | the log | the room doc |
|---|---|---|
| written | appended, ordered | last-write-wins |
| read | replayed by every client | rendered, never replayed |
| settled | hashed, goes on chain | thrown away at the deal |

**No rule may be decided from the second one.** `turnAuthority` reads the board. A check that reached for
the roster to answer "may this player act" would be taking the answer from a record any client can
overwrite.

**The branch is inside `sandboxRoom.ts`, not at the call sites.** Six functions —
`hostSandboxRoom`, `subscribeSandboxRoom`, `upsertSandboxPlayer`, `setSandboxRoomVariants`,
`setSandboxForcedSign`, `markSandboxRoomPlaying` — plus `readSandboxLog`, which the join path *awaits* and
which therefore hung the same way. Routing at the call sites would have meant a dozen edits to `App.tsx`,
the file this migration exists to stop editing. **Zero diff in `App.tsx` and `Lobby.tsx`.** Same choice
#1213 made for the log, and the same reason.

Eight new smoke checks cover it, including the two rules that had to survive the move: a write to an
unhosted room does not invent one (or the Start button goes to whoever wrote first), and a rename updates
**in place** (#541 — `toSetupPlayers` reads that order).

**Still on Firestore:** chat (#644), and nothing else in the sandbox path. It degrades quietly.

#### The handler that yielded (#1216)

**Reported one playtest later:** "Clicking Host Game completely bypassed the waiting room and went straight
to a game… there are no Players listed."

**The room was never created.** The client opens its socket, sends `room-hello`, and immediately sends the
queued `room-write` that hosts the room — back to back, because nothing tells it to wait. `ws` delivered
them in that order and the handler ran them in that order, but the first one **awaits** `resolveIdentity`.
An `async` function that awaits yields, so the second frame's handler started while the first was suspended,
found the socket not yet registered, and answered *"say room-hello first."* The write was dropped. The
client then heard `{doc: null}`, `sandboxRoom?.status` was not `"waiting"`, and the render fell straight
through the waiting room into the game.

**Frames from one socket are now applied in the order they were sent**, by chaining each onto the last, per
socket. The chain is caught so a thrown handler cannot poison it — otherwise one bad frame silently kills
every later frame on that socket, which is the hardest kind of fault to find. **The log path had the same
latent race**: `hello` also awaits `resolveIdentity`, and a client that submitted before its catch-up
arrived would have been told "say hello first". Nothing did that yet. The fix sits above the frame kinds,
so it covers both.

**The lesson is about the harness, not the server.** The smoke check awaited the reply to `room-hello`
before writing — **polite in a way no real client is**. It tested a sequence the app never performs, passed,
and let a broken build reach a browser. It now sends the pair back to back, exactly as `roomDocLink.ts`
does. Verified against a deliberately slow (50 ms) identity resolver, a race window a thousand times wider
than the real one: the write still lands.

**A frame that never arrives now fails rather than hangs.** Every `next()` in the smoke test is a claim that
a frame is owed; a five-second timeout is what makes a wrong claim say so instead of stalling for minutes.

#### The deal never learned about the server (#1217)

**Reported:** "I went through the waiting room this time, but in the game room there still aren't any
players and I can't take any actions."

**Every action in the game goes through one dispatch, and #1213 taught that dispatch to prefer the link.
`handleStartSandboxGame` does not go through it** — and could not: the main dispatch is gated on
`isMyTurnRef`, and at the deal there is no turn to be on because there is no game yet. So it called
`appendSandboxAction` directly, and went on calling it after the transport moved.

**This is not a Firestore-outage bug.** The outage only changed the symptom. With Firestore up, the deal
would have been written to Firestore while every other action went to the server — and since the client's
listener is now the link rather than `subscribeSandboxLog`, that entry would never have been read back by
anyone. Same empty board, no error either way. **The first server playtest was always going to fail here.**

**The shape is worth naming.** #1184 is *one rule implemented twice*. This is its sibling: **one rule
implemented once and bypassed once.** The bypass is invisible to every test that checks the rule, because
the rule is fine. What finds it is a search for the old function's name — `appendSandboxAction` had exactly
two call sites, and the cutover only converted one.

**Audit taken:** `appendSandboxAction` now has one Firestore-path caller and one link-aware caller, and
both are in `App.tsx`. Any third would be a bug by construction.

#### The server now says why, and the shell stops talking over it (#1218)

Three bugs in a row were diagnosed by reading source rather than evidence, because the app's only report was
*"Could not reach the room — that action was not sent."* Two changes end that:

- **The server logs every non-applied answer** — refusal, build skew, or catch-up, with the reason and the
  indices — to the window the playtester already has open. Applied moves stay silent, or one line per
  action would bury the interesting ones. DevTools is a different skill from playing a game.
- **The shell stops overwriting the specific message with the generic one.** `link.submit` resolves `null`
  four ways, and three of them already wrote a precise sentence into that error bar before the dispatch
  replaced it. One flag, cleared before each submit, settled inside the socket's own message handler.
- **The fourth way was silent:** a catch-up that does not contain the client's own entry means the move was
  answered with a resync. Not an error and not a refusal — it now has its own callback and its own sentence.

#### `c1` was every client's first move (#1219)

**The one that actually broke the auction**, found in one round trip once the server started talking:

```
catch-up: p-6l5brnvm sent WaterfallBuyLowest — client was at 0, room is at 0
```

Not stale — `baseIndex < nextIndex - 1` is `0 < 0`, false. It was the **duplicate-submission guard**.
`serverLink` minted `c1`, `c2`, `c3`… per link, and the registry was keyed on that string alone. The host's
deal took `c1`; the next player's *first move of the game* was also `c1` and came back as a move already
made. Their second collided with the host's second. **A two-player room is a machine for producing this.**

**Fixed on both sides, and only one of them is the real fix.** The server keys the registry by
**(actor, nonce)**, with the actor half coming from the connection (#1207) — so a client that mints ids
carelessly can only ever suppress its own moves. The client also mints a random per-link prefix, which
matters for a different case: the actor is stable across a reload but the counter is not, so a refreshed
player's `c1` would otherwise collide with their own `c1` from before the refresh.

**Why the tests missed it — the third time this shape has cost a playtest.** The smoke test wrote its ids by
hand: `setup-1`, `open-1`, `bob-1`. Every one distinct, because a person naming them makes them distinct
without thinking about it. **Hand-picked inputs that are more distinct than the real ones test a world the
product does not live in** — the same family as #1216's harness that waited where no client waits. The new
check has Bob submit with the exact id Alice already used, and it must be applied.

#### The alarm that was built and never connected (#1223)

**#1207 argued for keeping the client's reducer alive** in as many words — *"it is not a thin renderer, it is
a second opinion"* — and the payoff named was free divergence detection. `stateDigest` was written for it.
The server puts a digest on every `applied` and `catch-up` frame. **Nothing compared them.**

The cost was paid and the payoff was not collected, and a playtest showed what that is worth: a client's
board drifted during ten rapid undo/re-buy cycles, and the first anyone knew was a Buy Stock button that did
nothing **a full round later**. The evidence to catch it at the moment it opened was already on the wire.

**Compared at the settle point and nowhere else** — the same instant #1173c releases the double-click latch,
and for the same reason: it is the only point at which the client's board is a finished thought. The
server's digest is of the board after *its* burst (#1209's settle point), so the two hashes describe the
same log applied to the end. Like-for-like only because both sides stop in the same place.

**It reports; it does not refuse and does not rebuild.** Refusing would turn a false positive into a bricked
game, and a diverged client is already prevented from doing damage — `turnAuthority` is server-side, so its
bad moves are refused there. The harm of divergence is that the *screen lies*, and a screen that lies while
saying so is strictly better than one that lies silently. Automatic resync is the right eventual answer and
is reachable (the drain already replays from index 0), but a rebuild triggered by a comparison that has
never run in anger is a way to turn a cosmetic drift into a loop. Report first, automate second.

**Two suppression rules, and both are about the false-positive rate:**

- **One alarm per episode.** A diverged client stays diverged until it reloads, so comparing every settle
  would repeat the sentence after every action — which trains the player to ignore it. Agreement re-arms.
- **Nothing is said to the player until the two sides have agreed once.** The alarm reports *drift*, and
  drift presupposes a starting agreement. Two hashes that have never matched indicate something systemic — a
  seed, a field one side carries — which is a fault in this mechanism, not in the room. That case goes to
  the console instead. **An alarm that cries wolf from action one gets turned off, and the once it was right
  nobody is listening.**

**A watcher's digest is now computed rather than borrowed.** The fan-out read
`(result as {digest?: string}).digest ?? ""`, and the fallback is reachable — a refusal that still carried
repairs appends entries and answers `refused`, which has no digest. Every watcher then received `""`, which
is "no verdict" (#232), so the check was silently unavailable to exactly the clients that are not driving.

**Unverified until a browser runs it:** whether the two halves agree at all. The harness was built to match
`App.tsx` (#1195's golden master), so they should — but "should" is what the `everAgreed` rule exists to
survive. The console says `not agreed on the board at any point` if they never match, which is the first
thing to look for on the next playtest.

#### The auction nobody was sitting in (#1227)

The alarm named `player_cash, private_companies`; #1226 printed the client's values; the server's came from
replaying the same two-action log. **Client: Host pays $20, owns Schuylkill Valley. Server: nothing.**

`waterfallForRoster` did not appear in `replayLog.ts`. The engine was constructed with an empty roster —
correct before a deal — and never re-seated the auction on `SetupGame`. The shell's handler always had. So
`current_turn` stayed `""` and **every auction action the server ever judged was judged against an auction
with no players in it.** Earlier playtests got through the auction only because the client was doing the
real work locally; the server's copy was nonsense from index 1.

Fixed in the engine, reading the roster from the **dealt board** rather than the message's player list (the
reducer shuffles; the two orders are usually the same and are not the same rule). The arming for a delayed
auction reads the variant off the message. Verified against the user's log: exact match.

#### The delayed auction opened on Stock Round 1 — in the shell only (#1228)

Found by #1227's test on its first draft. The shell's `SetupGame` handler applies #905's switch
(`current_round_type: "StockRound"`, `private_auction_complete: false`, `macro_round_number: 1`); the reducer
did not. A `delayedAuction` game diverged at **index 0** on every server and every replay.

Moved into the reducer's `SetupGame` arm. The shell's copy is left standing and is now redundant — on the
client the shell's branch returns before the arm runs, so each side runs exactly one and they agree. Removing
the shell's is §3.1's work; this change is what makes that removal a no-op.

**Pattern worth naming:** #1221, #1227 and #1228 are the same fault three times. Ten shell-owned messages,
each applied by `App.tsx` on the client and by the reducer on the server, and the two copies were never
compared. The alarm is what turned "never compared" into three fixes in one evening.

#### §2.4 is not downstream, and now explains itself (#1229)

Replaying JUNO-QVC through the corrected engine changed the whole game's money and still ended with Host on
turn and allowed to buy. The client's own gate refused anyway. It now prints its three inputs at the moment
of refusal (`acting(ref)`, `acting(rendered)`, `viewer`, plus seat and round), because a refusal that returns
before the server is reached is invisible to every other instrument built this week.

#### The first of the ten comes off the shell: `SetupGame` (#1230)

`App.tsx`'s `SetupGame` branch computed the whole dealt board and **returned**, so the reducer's arm never ran
on a client; the server has no shell, so it ran only the arm. #1221, #1227 and #1228 are the three times
those two copies were caught disagreeing. The branch now keeps what the reducer cannot do — name the players,
paint their colours, narrate — and **falls through** to the same path every other message takes. The
reducer deals; the auction is re-seated from the dealt board afterwards, in the engine's order (#1227).

Two consequences worth recording. **`msg` reaches the general path un-narrowed**, so the shell now takes the
one cast the engine already takes (#1189's IOU, one alias rather than eight casts). And the general path
would have printed a generic success line beside "Game dealt for N players"; `SetupGame` now satisfies the
`silentInLog` contract from inside, and the refusal line for an undealable roster is untouched.

Nine remain. Each retirement is the same shape: keep narration, drop state writes, drop the `return`, pin it.

#### `RevertTo` had nothing to migrate — and the real fault was the gate (#1231)

The request was to move `RevertTo` onto the reducer so undo cycles could not part the rendered state from the
ref. **The shell's `RevertTo` branch is already a no-op** and always was: "a revert is an instruction about
the log; effectiveActions has already honoured it." Both the shell's drain and the engine call the same
`effectiveActions`. There is one implementation of undo and there never was a second.

What undo *does* expose is the gate. `runGameplayAction` refused against `isMyTurnRef` — a boolean mirrored
by an effect from React's **committed** state — while the dispatch acts on `sandboxStateRef`, written
**synchronously**. Two boards, one commit apart, and the gate asked the older one. An undo rebuilds the refs
and replays; every replayed action writes the ref at once and the state in a batch. That is #767's shape ("a
ref reset is half a reset") sitting under the one check that can lock a game with no line anywhere.

**The gate now computes from the refs at the moment of the click**, with the same `actingAddress` the memo
uses. It cannot lag the dispatch because it reads what the dispatch reads. The bias is deliberate: on the
server path the client gate is not the authority, so a gate that is occasionally too permissive costs a
readable server refusal, while one that is too restrictive locks the game silently — which is what happened.

#1229's line still prints both answers, so if they ever disagree again the console says which the gate
believed. **§2.4 is expected to be closed by this**; the playtest confirms it.

#### A mini-auction suspends the rotation — on both atoms (#1232)

**The first live run of the seated auction got through six actions with the alarm silent**, including a
contested mini-auction — and then locked when the contest resolved: "It says it's one person's turn but
nothing they click does anything." Replaying the log:

```
after #4 WaterfallBuyLowest        seat=0  wf.current_turn=sandbox  mini={turn: Host}  acting=Host
after #5 WaterfallMiniAuctionPass  seat=1  wf.current_turn=sandbox  mini=null          acting=Host
```

The auction atom did the right thing — #544: the rotation is suspended and `current_turn` is preserved across
a contest "so it can be resumed untouched." The **state's seat** did not: the reducer advanced it on every
waterfall message alike, contest actions included. `actingAddress` reads the seat when no contest is live, so
the gate and the authority said Host while the auction waited for sandbox. Host passed the gate and died in
the auction; sandbox died at the gate.

**Three readers of one wrong cursor, fixed in three places that now share one answer:**

- The reducer no longer advances the seat on `WaterfallMiniAuctionRaise` / `Pass` — a move inside a
  sub-sequence is not a step of the rotation.
- `actingAddress` reads the **auction's own cursor** during the auction, falling back to the seat when the
  cursor is empty (pre-deal, #542) or names nobody on the roster -- a stale or foreign atom is not an opinion. `applySandboxWaterfallAction` already applies actions under that
  cursor, so the gate was judging by a different cursor than the one the action would run under — #1174's
  two-judge problem inside one process.
- The Activity Log named the passer from the seat too ("sandbox passed" about Host's pass). `actingPlayer`
  asks `actingAddress` during the auction, with the atom in hand.

Verified against the player's log: after the pass, seat and cursor agree, sandbox is on turn, Host is refused,
sandbox's next buy lands and hands the turn over. Six cases pin it, including one that drifts the seat on
purpose and asserts `actingAddress` still names the right player.

**Not a migration regression.** Every line of this predates the server; the Firestore path had the same lock
available and nobody had hit a contested mini-auction with the seat one step out. The alarm did not find this
one — both halves agreed, because both ran the same wrong reducer. What found it was a player unable to move,
which is the case the alarm cannot see and the reducer's own tests must.

#### A live revert is a rebuild, not a step (#1233)

**Reported:** undo from PRR back to B&O; B&O's re-purchase flashed, was narrated, delivered nothing, and the
game locked. **The log ends at the revert** — every purchase after it was refused by the server with "It is
not your turn", because on the server's board PRR was still operating.

`replayLog` resolves reverts over the whole log and `RoomEngine.apply` cannot; the file said so: *"resolving
reverts needs the WHOLE log, which a server appending one action at a time does not have. A room rebuilds
through here; a room in play advances through `RoomEngine.apply`."* Both halves true; the second was the gap.
Nothing ever made a room in play rebuild. A `RevertTo` passed the gate (#1220), was appended, and was handed
to a reducer with no arm for it — the board stood, the log said otherwise. **The alarm could not catch it:**
the client rebuilt correctly, so the two sides disagreed in exactly the direction the server was wrong.

**`RoomSession` now rebuilds the engine from the effective log on a `RevertTo`**, and `restore` goes through
the same path so a stored log with reverts in it does not replay them as if they stood. One implementation of
undo on both sides of the wire — #1184's property, for the message the audit flagged as most in need of it.
Cost is a full replay per undo; checkpoints (the audit's) are the answer if it ever matters, not a partial
rewind. Four cases pin it, including the inverted lock: after a revert the previous actor is refused and the
rewound player's next move lands.

#### `SetBoPar` off the shell (#1234), and the Stock Round opens to the left (#1235, #1236)

**The alarm caught #1234 in the act** — `fields: market_positions`, client chart all `null` at index 11. The
reducer's arm writes the par mark onto state through its post-action reconcile; the shell's copy wrote it into
the ref and returned. #1221's shell reconcile is gone with the branch; the reducer's does the work, at the
right moment, on both sides.

**#1235 is not a rule change. It is a rule that was never implemented and passed by coincidence.** The
rule — *"play passes to the last active player's left"* — was always the intended one. `priority_deal_index`
is written in three places in the codebase and none of them is in the auction, so Stock Round 1 always opened
to seat 0; #909 had recorded that constant as though it were a ruling. The two answers agree whenever the
last auction actor sits in the last seat — which is what happened in the golden master (seat 2 of 3 set the
B&O par) and in the previous two-player game (seat 1 of 2). In this game seat 0 set it, and for the first time
the constant and the rule gave different answers. **The golden master could not have caught it**; on that log
they coincide.

The seat cursor at the moment the auction closes already *is* the player after the last actor — #1232 keeps
it honest through a contest, and `SetBoPar` does not advance it — so the priority deal is set from it, once,
in the reducer's `OpenStockRound` arm. Applied to the delayed variant too: one rule for "who opens after an
auction" rather than two. **Pinned with a case where the last actor is seat 0**, which is the case the
constant gets wrong and every prior game happened to avoid.

**#1236 retires `OpenStockRound` from the shell** in the same change, because a rule moved into the reducer's
arm while the shell's copy still returned early would have diverged on its first game. Three of ten off.
Seven remain: `CloseRoom`, `PlaceHomeStation`, `ExchangePrivate`, and the two negotiation pairs.

#### The Tokens step that was never skipped (#1237) — and a retraction

**Reported four times under four descriptions**, most recently "C&O laid track and its Lay Track subphase did
not advance." The log of the fourth game settled it: the lay moved the step to Tokens, the engine owed
nothing, and forty-eight seconds later the player clicked Skip. B&O in the same game laid, then *placed a
token* — so the wait was right for B&O and wrong for C&O, and nothing on screen distinguished them.

**The cause was a default.** `nextDerivedAction` takes `extraStationAvailable` and assumed `true` when the
caller did not say; `stationPlacementBlockReason` reads that as "a placement exists" and stops before checking
whether the network reaches a free slot. The server never passes the flag. **So on the server the Tokens step
was never auto-skipped, for any corporation, ever.** A cautious default for one edge case — the D&H's free,
unconnected station, whose "spent" flag lived in shell state the engine could not see — became a rule holding
every corporation at a step it could not act on.

**The answer is on the board now** (#1204 put `used_private_abilities` on the state), so the default is
computed from it by the shell's own rule — `dhFreeStationAvailableFor`, one function shared by both — scoped
to the corporation whose president owns the D&H. Verified on the reported game: B&O waits (it had a slot and
used it), PRR waits (it built a city beside its home and had a slot), **C&O auto-advances through Tokens and
Routes to Buy Trains.** Seven cases pin the rule and its scoping.

**Retraction.** §2.3 as first written said "the button label is wrong too: it says 'Skip Track Lay' while the
game is standing on Tokens." That was inferred, not observed, and it was false — #164 removed the per-step
skip buttons; advancing lives on the stepper, which reads the state and highlighted Tokens correctly. The
screen was telling the truth; the *game* was waiting for a placement that did not exist. The earlier
diagnosis "the client's subphase display lags" was wrong in the same way: nothing lagged. Recorded because a
confident wrong sentence in a triage document costs the next reader the same evening it cost this one.

#### "Ordinary play" is live or history, not one or many (#1238)

**Reported:** one player got the private-payout modal at the SR→OR transition and the other did not. The
drain decided "is this live play?" with `pending === 1` — Firestore's proxy, where a snapshot usually carried
one new action. **The server path breaks the proxy**: a settle-point frame carries a whole burst (#1203) and
the drain coalesces frames that land together, so the acting player's entry came back alone and announced
itself while the other player received it beside its neighbour and the pass was treated as history —
`replayingHistory` set, every toast, badge and modal silenced for events seconds old.

This is also the likeliest mechanism behind the UI note that the train-purchase toast "is not registering":
a purchase that ends a turn arrives with its `PassTurn`, and two is not one.

**The link now says which frame kind carried a batch** — `applied` is live, `catch-up` is history — and on
the server path the drain reads that instead of counting. Firestore keeps its proxy, having no frame kind to
read. Three link cases pin it, including the case the old proxy got backwards: a reconnect that missed
exactly one action would have announced a minutes-old event as news.

**And the server prints its compile stamp on startup.** The previous playtest's "fix didn't work" was a
server never restarted, diagnosed from the first entry's id being `s58` — the mint counter proving the same
process had served the previous room. Evidence, but archaeology; the window says it now.

#### Two playtest conveniences (#1239, #1240)

**Asked for**, with permission to refuse; neither was refused, because both cut the cost of every remaining
playtest and neither touches the log.

**Skip the opening titles (#1239)** — a checkbox in the waiting room, per browser via `localStorage`, shown to
every seat. Not a room field: the titles are presentation, not a term of the game, and a viewing choice does
not belong beside the variants the table agreed to. In a two-tab playtest both tabs share one browser, so one
tick covers the table. `introPreference.ts`; the `waiting → playing` edge in `App.tsx` returns early when set,
which leaves `introPlayingRef` false so the whistle (#1116/#1143) sounds at once.

**Auto-Buy (#1240)** — an Auto-Pass-shaped standing instruction: arm per Stock Round from a modal (tick
corporations in order of preference, pick a cap in 10% steps), and on each of this player's turns it buys one
share of the first ticked corporation under the cap with a share on offer (IPO before pool), or passes when
none qualifies. Same #816 one-dispatch-per-turn guard, same #1036 silent clear when the round ends, same
off-switch-always-reachable rule (#728). Legality is asked of `purchaseBlockFor` — the panel's own
`sharePurchaseBlock` call — not re-implemented (#1184). It skips unparred corporations rather than parring
them, and stops when a forced sale is owed (#759) since it may then neither buy nor pass. **A debug tool, and
labelled one in the modal**: no presidency guard, no sale wakes. When it graduates, those belong in
`autoBuy.ts` in the shape `autoPassDecision` gives them. Eight cases in `autoBuy.test.ts`.

#### A thrown submit is answered, not swallowed (#1241)

**Reported:** with Auto-Buy armed on both seats, every turn opened with "Sending your last action — one
moment" and the controls stayed grey until the six-second backstop (#1173) released them; nothing was bought.
That string is the in-flight latch, and the backstop is the only thing that clears it when **no answer
arrives** — a refusal, skew or catch-up would have released it at once and printed in the server window
(#1218). The only silent path is an exception inside `session.submit`: the per-socket chain guard (#1216)
catches it so one bad frame cannot poison the socket, and in doing so discarded the fault.

**Now:** the server catches around `submit`, logs `threw: <actor> sent <Msg> — <error>` with the payload, and
answers `refused` with the error's sentence, so the client releases the latch and shows why. The client prints
`[auto-buy] <decision> at log index N` and `settled after N ms` per dispatch. The rerun's console found the
cause, and it was not the reducer — see #1242.

#### The socket lived one action at a time (#1242)

**Found through Auto-Buy.** The console showed two dispatches with two fates: one "settled after 284 ms" with
nothing applied, one never settled at all, no server line, latch held to the backstop. Neither was the
transport failing; both were the transport being **rebuilt**.

The effect that owns the room subscription listed `runGameplayAction` as a dependency, and that callback is a
`useCallback` over `gameState` and `marketGrid.positions` — new identity after every action. So after every
action the effect tore the transport down and rebuilt it: a re-subscribe on Firestore, but on the server a
closed socket, a new one, a hello and a full catch-up, per move, for the whole game. Nobody noticed because
nothing dispatches in the gap — except an effect. React runs every cleanup before any body, so in the commit
after an opponent's move the cleanup had nulled `serverLinkRef` and Auto-Buy's body (declared earlier in the
file) ran before the subscription's body made a new link. `runGameplayAction` found no link and fell through
to `appendSandboxAction` — Firestore, unreachable, a promise that never resolves. The 284 ms case was the
same window from the other side: sent on the old socket just before `close()`, settled `null` by `onclose`.

**Now:** the drain calls through `runGameplayActionRef` (#546) and the effect depends on `sandbox` and
`sandboxRoomCode` only; the socket's lifetime is the room's. And a server-path build with no link refuses
("The room link is reconnecting") instead of writing to Firestore — that branch should be unreachable, and if
it is ever reached the console says so. Three source scans in `linkLifetime.test.ts`.

Worth re-checking after this: #1238's live-or-history reading was made against a socket that reconnected
every move, so every second frame was a catch-up. The classification stands; the volume of catch-ups should
fall to zero in normal play.

#### Auto-Buy waits for the home station (#1243)

**Reported:** with Auto-Buy on, the buy that floated C&O left Place Home Station in a loop — place, confirm,
back to the Stock tab with the modal up again.

The floating buy holds the seat on the buyer (#769) and moves the log, so the acting effect fired again on the
same turn. Every buy was blocked (bought this turn), so the tool's answer was **pass**. #763's reducer gate
returns the board unchanged for anything but the placement while a token is owed — but the server appends
before the reducer runs (the append is the commit point), so the pass landed as a no-op *entry*, the log
index moved past the #816 one-dispatch guard, and the effect passed again. A flood of no-op passes at
round-trip speed, each one a new log entry that re-rendered the shell around the president's placement.

**Now:** the effect returns before deciding while `homeTokenOwed` — waits, does not disarm. The placement is
the president's to make and the tool must not stand in for it; once it lands, the seat advances and the plan
is still good for the next turn. The check is on *anyone's* token, because a rival's float can hold the seat
on another player while the token is owed elsewhere. Not written into `autoBuyDecision` since the hex lookup
lives in `components/` (#7). Source scan in `autoBuy.test.ts`.

Two related things this exposed, left open: (a) `autoBuyDecision` has no notion of "already acted this
turn" — it passes whenever nothing qualifies, which is right on a fresh turn and wrong on a held seat; the
home-token case was the only held-seat case, so the guard covers it, but any future seat-hold needs the same
thought. (b) A no-op message still becomes a log entry; that is by design (#1233 header) but means a client
that spins can fill the log. The #816 guard is the client's brake; nothing on the server rate-limits a seat.

#### `PlaceHomeStation` off the shell — the fourth of the ten (#1244)

The shell's branch called `placeHomeStationToken` with the same five arguments as the reducer's arm, so the
token itself never diverged. What diverged was what the reducer does *around* the arm: `abilitySpentBy`
writes `dh-token` into `used_private_abilities` before the arm (#1204), and the shell's early `return` meant
no client ever ran it. A D&H free placement on the server path would have left the server's board knowing the
power was spent and every client's not — and `dhPowerState` computes forfeiture from that field, so the two
sides would then disagree about whether a power *exists*, which feeds the Tokens auto-skip (#1237). Latent
only because nobody has placed a D&H token on the server path yet.

**Nothing to keep.** The dispatch label in `commitFreeStationPlacement` is the same sentence the branch
printed, so the general path's entry is the one line. The branch is gone, both imports with it, and #778
gains a case: a placement the reducer declines used to vanish silently (`placed === base` → `return`) and now
prints REFUSED. `floatHoldsSeat.test.ts` pins the wiring the other way round — the `ctx` field present, the
second caller absent.

Six remain: `CloseRoom`, `ExchangePrivate`, and the two negotiation pairs.

#### One consequence, one line — the category prefix comes off, and three sentences grow up (#1245)

**Ruled:** "condense and remove any Activity Logs that start with `[thing] —` as these were supposed to have
been removed." They had been — one call site at a time (#batch20's Run Routes, #1079's variant flavour, #1053's
treasury suffix), and every other `logInfo` caller still passed a category as the label and the sentence as
the detail, which `feedItemText` renders as `Treasury — C&O spent $70 …`. Now done once, in `logInfo`: the
sentence is the entry's label, the detail is empty, the category stays in the source for the reader and for
any future filter. Fifty-odd lines change shape without fifty-odd edits.

Three sentences beside it. `BuyPrivateCompany` carries its treasury transition like a tile, a token and a
depot train do, and joins `sentenceStatesTreasury` so #750's diagnostic goes quiet for it.
`BuyTrainFromCorporation` is the *executed* trade (#662 routes an accepted offer through it), so "offered" was
the wrong verb — it reads `PRR bought a 2-train from B&O for $80. PRR treasury $920 → $840; B&O treasury $640 →
$720.`, both movements in one line. And the fifth line of §2.3 — "B&O: its 2-train was discarded to meet the
new limit" — was `describeFleetLosses` reading a *sale* as a trim, #1099's shape for the one other message that
takes a train off a chip; it takes the message now and removes the sold model from `lost` first. §2.3 closes.
The `Train Offer` line for the proposal stays (without its prefix): the offer and the trade are two events.

**And `PlaceHomeStation` got its sentence back.** #1244 removed the shell branch that printed it; the general
path had no arm in `describeGameplayAction` and printed the drain's fallback, `Sandbox room`, as the whole line
— reported within the hour. The arm lives where every other message's does now, so the local dispatch and the
replayed entry read the same. That fallback printing at all is the signal: any message with no arm there will
show the same two words, which is a better tell than a silent blank.

#### `ExchangePrivate` off the shell — the fifth of the ten — and the retired sentences find their home (#1246)

The `ExchangePrivate` branch was #1244's shape again: the same `applyPrivateExchange` call the reducer's arm
makes, written into the ref, narrated, returned. Nothing around the arm differs for this message, so no
divergence was waiting. Gone, with the same #778 gain (a declined exchange prints REFUSED instead of
vanishing).

**What was waiting was a second line.** Each retirement so far kept the shell's sentence as a `logInfo` and
let the message fall through — and the general path then wrote *its* entry for the same message, labelled
with the drain's fallback. On the server path every entry arrives through the drain, so `SetBoPar` and
`OpenStockRound` had been printing "Sandbox room" under their narration since #1234/#1236; #1245 caught it
only for the home station because that one had no narration left to hide behind. The sentences for all three
now live in `describeGameplayAction`, where every other message's does, and the shell's `logInfo` calls are
gone: one line, from one place, identical on the local dispatch and the replayed entry (#794). `SetBoPar`'s
refusal wording survives through `refusalReasonFor`, which asks `boPresidencyRefusal` on the same before-state
the reducer asked (#784). `SetupGame` stays the exception (#1230) — its sentence needs the roster the shell
names — and the negotiation pairs and `CloseRoom` still `return` before the general path, so they owe no arm
yet; they will when they come off.

**The rule for the remaining five, then:** retire the branch, put the sentence in `describeGameplayAction`,
pin both. A `Sandbox room` line in the log is the tell that a message reached the general path without one.

Five remain: `CloseRoom` and the two negotiation pairs.

#### The negotiation pairs off the shell — and the purchase they owe becomes a derived action (#1247)

Four branches: propose wrote the offer, answer cleared it, and an accepted answer **dispatched** the purchase
(`BuyPrivateCompany` / `BuyTrainFromCorporation`) from inside the drain. #1198 kept that dispatch in the
shell on #576's authority — "a consequence is derived by every client, not appended by each of them" — and it
was #576's own fault: the drain runs on every client for every entry, so every seated browser dispatched the
purchase. The buyer's went through; the seller's died at the client's turn gate, which put "It is not your
turn" on the *seller's* screen after they had just said yes; and a reload of the buyer's client re-dispatched
it from history. Nobody had reported it because nobody had traded on the server path yet.

**Now the answer arm records the yes** (`accepted: true` on the offer, nothing else moves) **and the board
owes the purchase.** `nextDerivedAction` asks about accepted offers before it asks about the round or the
step, and returns the purchase as an `accepted-offer` derived action; on the server path `RoomSession.submit`
generates and appends it once in the same burst as the answer (#1203), and every client applies it from the
log. The purchase arms clear the offer they settle — *before* the sale, so a train that has gone between offer
and answer still retires the debt rather than owing it again on every look. The `BuyPrivateCompany` arm is
also idempotent on the owner, for a straggler's copy. On the Firestore path, where nobody else can owe it, an
effect beside the auto-skip sends the derived purchase from the on-turn client with the same three guards
(#774, #1213). The consent prompts hide an accepted offer, the sentences live in `describeGameplayAction`
(#1246's rule), and a second answer prints REFUSED with "That offer had already been answered."

**Old logs replay unchanged.** A replay applies and never generates (#1203), so a log carrying the shell's
own `BuyPrivateCompany` after an accepted answer buys exactly once, and the answer's `accepted` flag is
cleared by that entry. `shellMessageArms.test.ts` is rewritten around the new boundary; its old "the reducer
must not buy on an accept" case survives with the mechanism named.

Nine of ten. `CloseRoom` remains, and it has the same shape: the branch fires the settlement payout on the
transition — an effect the board should owe, not the shell send.

#### `CloseRoom` off the shell — ten of ten (#1248)

The branch did three things. The **state** (`room_closed: true`, behind the same three guards the reducer's
arm applies) moves below, like everything else. The **silence** for a close that lost the race — #899:
"logging it would put four identical scare lines in the Activity Log of a finished game" — was the branch's
`return` before the log; with the branch gone it is a rule, `silentWhenUnchanged`, that the general path asks
before writing an entry, and `CloseRoom` joins `NO_OP_MESSAGE_KEYS` so the duplicate is not a refusal either.
Deliberately a separate, one-member list rather than a widening of the no-op one: an unchanged undo or chat
still earns its line. The **payout** fires on the transition the reducer produced, read the way a float is
read (before open, after closed), and never from a rebuild — `replayingHistory` is #899's third double-fire
answered by the drain's own word for it, with the per-session Set kept behind it as the courtesy it always
was. The stub is still a stub; Phase 3b replaces it, and now has one call site to replace.

**Phase 2's first exit criterion is met.** Every message `isSandboxOnlyMsg` names is applied by the reducer
alone, on both sides of the wire; the shell keeps roster names and colours (#1230), the B&O prompt (#1234),
and narration through `describeGameplayAction`. What remains of Phase 2 is the measurement: full free games
with the alarm silent — and the untested server-path flows in the triage doc (#1247's negotiations, this
closure) are the first things to play.

#### Each room message has an owner, even though none has a seat (#1249)

#1220's exemption stands — none of these is refused with "It is not your turn" — and each message now gets
its own owner instead of nobody. The rules are the questions the shell already asks before it shows the
button, asked again on the server against the same board: `SetupGame` is the host's, on an undealt board;
`OpenStockRound` needs the auction to be over (`auctionHandoffPending`'s own predicate: round is the auction,
atom has no private left), and anybody may then press it; `SetBoPar` is the B&O private's owner's, and the
message must name them; `PlaceHomeStation` is the corporation's president's, and a D&H token additionally the
D&H owner's; `ExchangePrivate` is the private's owner's; `RevertTo` is `undoReachFor`'s rule on the server's
own log — the host reverts anything, anybody else only their own last non-derived action and only when it is
the last one standing; `CloseRoom` needs `GameEnd`, and the closes that lose the race are still let through
so #899's silence holds. **Ownership only, never legality** — whether the B&O *can* be parred or a token *is*
owed stays the reducer's, or the gate would be #1184's shape.

Two new inputs, both from the server: the host from the room document it already keeps (#1215), the log from
the session itself. `undefined` for either skips that check rather than refusing everyone — the replay
harness and the CLI have no room document, and a gate judging on a field nobody gave it is #232's mistake.

The smoke test had been opening the Stock Round mid-auction "so there is a turn to be out of"; the server
let it because nothing checked. It now pins the refusal instead, and takes its out-of-turn move from the
auction's own rotation. Four `roomSession.test.ts` cases that used `OpenStockRound` as "any second move" use
the first seat's purchase instead.

#### The append reaches a disk (#1250) — Phase 2.5a

`start.ts` said "a restart starts an empty room", and the audit called that what it was: with the log in
memory, "the append is the commit point" was a claim about memory. Now `server/src/fileLogStore.ts` keeps
one append-only JSON Lines file per room and a sidecar for the room document, and `gameServer` **awaits the
synced append between `session.submit` and the answer** — so the `applied` frame and the fan-out describe
entries the disk holds, never entries it might. A store that rejects rolls the session back
(`RoomSession.discardAfter`, the one place the log ever shrinks, and only to a length the disk acknowledged)
and the submitter is refused: a move the disk does not hold did not happen, and memory, disk and every client
agree that it did not. The room document is saved after every write and loaded with the log, so a restored
game still has a host and nicknames.

Two things this forced. **Minted ids carry a process tag** (`s<tag>-<n>`): `effectiveActions` kills reverted
entries by id, and a counter restarting at 1 would have minted an id the stored log already held — a revert
aimed at the wrong move. The tag keeps #1238's evidence the other way round (a new tag says "restarted").
And **not Firestore**, though the plan had it as the log's home: the playtests have run with Firestore
unreachable, and a store that cannot be reached is not a store. The seam is three functions; a Firestore one
implements them when there is a reason to.

The smoke test now runs a second server on a temp directory, deals, closes it, opens a third on the same
directory, and checks the joining client's catch-up carries the stored entries with their original ids, the
room document still names the host, and a move after the restart mints ids the log does not already hold.
Rooms live in `server/data/` (git-ignored; `--data <dir>` or `DATA_DIR` to move them).

Not done here, and listed so it is not mistaken for done: the file is not tamper-evident (2.5f), nothing is
signed (2.5b), and a disk on one machine is durability against a process dying — which is the failure that
has actually happened — not against the machine.

#### The log hash covers every field a rule reads (#1251) — Phase 2.5f

The plan's commitment was "ordered concatenation of `payload` strings"; the audit named what that left out:
"the clock reads `at`; the forfeit reads `actor`; the reducer reads `derived`. An operator could alter
timestamps without changing the hash." `logHash.ts` hashes one line per entry — `(index, actor, at, derived)`
as a JSON array, a tab, the payload verbatim, a newline — with SHA-256 over UTF-8. `at` absent hashes as
`null` and `derived` absent as `false` (#232, made a bit); `id` and `submission_id` are *not* hashed, because no
rule reads them and two logs that play identically must commit identically. Sorted by index, and a duplicate
index is a `throw`: the server allocates every index, so a duplicate is corruption, and the Firestore-era
`(index, id)` tie-break is dead. A prefix hashes on its own, which is what a checkpoint is.

**SHA-256 is implemented in `sha256.ts`, in plain TypeScript, synchronous.** Not the platform's: Node's is
`crypto.createHash`, a browser's is the asynchronous `crypto.subtle`, and two implementations behind the one
function whose two answers must agree to the bit is #1184's shape exactly where it costs the most. Eighty
lines, checked against the FIPS 180-4 vectors and node:crypto on the padding boundaries and on multi-byte
UTF-8 (nicknames travel in `SetupGame`). `stateDigest`'s FNV stays what it is — accidental-divergence
detection — and its header's "settlement hashes the log with a real digest" now points at something.

The constants are pinned in `logHash.test.ts`: the line format, a three-entry log's hash, a two-entry prefix,
the empty log. If that file goes red, every checkpoint ever signed is void — the test's header says to write
the design note before fixing the test. The hash rides on the debug export (`logHash`, `null` where the export
already flags a duplicate index), the replay CLI prints it, and the server prints its first sixteen characters
on every restore.

#### A room is pinned to the reducer that dealt it (#1252) — Phase 2.5e

`build-skew` keeps a client and a server on different builds from talking; it does nothing about a server
that restarted on a new build with a stored log dealt on the old one — which #1250 made possible for the
first time. Client and server would agree with each other and both apply new rules to a game in progress:
the audit's "a deploy mid-game changes the outcome", and a client on the old build then "challenging" a
correct settlement. The deal now names its build (`SetupGame.build`, sent by the client whose build the
server has already matched), and `RoomSession.submit` refuses every move on a room whose deal names another
build, with a sentence that says what to do: run that build, or start a new game. Read from the *log*, not
the state — the reducer does not need to know, so no field joins the board and no digest moves; the effective
log, so a reverted deal pins nothing. A deal that names a build other than the server's own is refused too. A
log written before the field is unpinned, not pinned to nothing (#232). The server says which rooms it cannot
continue at restore time, once, and then in every refusal.

#### The link outlives its socket (#1253) — Phase 2.5c

#1212 left reconnection out on purpose and kept `baseIndex` for the day it was wanted; the audit made the
case that with clocks coming, "a dropped socket means a reload" is a reserve tax on bad connections. The link
now reconnects with a backoff (500 ms doubling to 8 s) and says hello with the last index it applied; the
server answers with exactly what was missed, and play resumes. **A move that was in the air when the socket
dropped is settled by that catch-up, never re-sent**: found in it, it landed and resolves with its index; not
found, it did not (or its answer was lost) and resolves `null` as stale — the shell already words that as "the
board is current, try that again". Re-sending blindly would double a landed move; re-sending an older move
after a newer one had landed would apply it out of order. The one case that costs a click is the case where a
click is the right answer. Moves queued while the wire was down are sent behind the hello with the
`baseIndex` of that moment, so one made against a board that moved meanwhile is answered as stale — which is
what it is. `close()` still settles everything `null` and stops reconnecting. The shell shows a banner between
sockets (`onStatus`). Five cases in `serverLink.test.ts` drive the backoff by hand; the one existing case that
delivered a submission's catch-up without the hello's first now delivers the hello's, because the real wire
always does.

#### The owner's decisions, and the order they produce (#1254)

Answered in `DECISIONS_2026-09-06.md`. Two of them change premises this plan was written on:

**There are no free games.** Every game has an on-chain ante — testnet JUNO while playtesting — and the
chain deposit is the roster, always. So: no two-path seating (the audit's 2.5d "roster from chain" applies
to every deal); the waiting-room document becomes display-only (names, colours, readiness, variants) and
the deal seats `player_addresses` read from the contract's `GameSession`, refusing if the room's list
differs; clock data comes from sandbox and testnet playtests rather than from a free tier; and a "player" is a
chain address from the first hello (which is what A2's session key signs as).

**The whole table cannot go bankrupt.** In 1830 a bankruptcy is the *conclusion of the bankrupt player's own
turn as a corporation president* — the president who cannot fund a mandatory train, after the treasury,
their cash and every forced sale (`endgame.ts` #0/#1). The game ends there, and every other player is then
scored; `endgame.ts` ranks the bankrupt player last and passes the title to the first solvent one. So there
is never a second bankruptcy in the same game, and the audit's `total_vgp == 0` fallback is withdrawn; there
is no branch. (Corrected by the owner from a first draft that described it as "the first bankruptcy ends the
game" without saying whose turn it belongs to — the ordering matters for the settlement snapshot: the
appraisal is taken *after* that turn concludes, not at the moment the shortfall appears.)

The rest, as decided: operator-settled (A1); session keys sign every move and retire `trustClaimedIdentity`
(A2); after the deal no unilateral exit, unanimous scrap only, checkpoints at round boundaries and a 14-day
liveness switch (A3); consent fast path once the alarm has stayed quiet across full games (A4); bonded
challenge resolved by the operator, 24 h Live / 48 h Async (A5); forfeit pays zero, clemency caps at refund,
appraisal at the last round boundary (A8); Live/Async is a room setting fixed at the deal (B2); the
multi-train selector goes (B3); the Firestore room path goes after the next playtest (B4); clients keep
replaying (B5).

**Order of work, revised:**

```
2.5   (done: a durable log, c reconnection, e build pin, f log hash)
      B3  delete the multi-train buy selector                              small, now
      B2  mode: Live | Async on the room, fixed at the deal                small, now
      B4  retire the Firestore room path                                   after the next playtest
      b   session keys: sign hello and every entry; server verifies;       the big one; blocks 3a
          signature stored on the entry; trustClaimedIdentity retired
      d   roster from chain: the deal reads GameSession.player_addresses   needs the chain lobby live on
          and refuses a room that disagrees                                testnet; blocks 3a
      g   clocks: measure in every game now, forfeit later (A8)            after b, d
3a    contract lifecycle: Lobby → Started → Settling → Settled; Start,     testnet first
      Checkpoint, Settle, AnnulByConsent, bonded Challenge, liveness settle
3b    server posts checkpoints and the settlement; clients auto-sign       needs 2.5b
3c    forfeit + clemency with A8's arithmetic                              after real games on 3a/3b
```

#### The multi-train selector is gone (#1255) — B3

Triage §2.1: three chosen, two bought, two charged, three printed, then an auto-skip. The panel's selector
dispatched N `BuyHardwareFromPool` messages in a loop and #1077's summary counted the presses, not the
purchases. Ruled: delete it. One press buys one train through the reducer with the reducer's own line;
`quantityOptionCount`, the clamp effect, the segmented row and the shell's loop-and-summary all come out.
`silentInLog` stays on the option type as a seam with no caller. Four suites re-anchored;
`quantityOptions.test.ts` now pins the absence.

#### Live or Async is a term the table agrees (#1256) — B2

`GameVariants.mode: "live" | "async"`, chosen in the waiting room beside the house rules, fixed at the deal
because it travels in `SetupGame`, defaulting to `live` and reading as `live` from any older log. Not a house
rule — `hasAnyVariant` ignores it — but every timer to come reads it: the clock (2.5g), the challenge window
(A5: 24 h / 48 h), the pause cap. Declared now so the contract and the clock are written against a field that
already exists.

#### The messages that are not a seat's to send (#1220)

**Reported after four one-button fixes:** *"It seems like we are iteratively needing to fix every single
button and transition."* Correct, and the right call — it was one bug the whole time.

```
refused: p-qnvjx852 sent OpenStockRound — It is not your turn.
```

**`turnAuthority`'s exemption 1 claimed to cover "#1203, and the shell's `automatic`".** That conflation is
the fault. `derived` is only what the *server* generates. The shell's `automatic` flag covers a much larger
family — **every message in `isSandboxOnlyMsg` is dispatched with it, at every call site** — and not one of
them is derived. So the client let them through and the server refused them, one at a time, in whatever
order the playtest happened to reach them.

**They are not moves.** `OpenStockRound` and `SetBoPar` close a phase; `PlaceHomeStation` places a token the
rules place for you; `ExchangePrivate` is the M&H's own right, explicitly exercisable between other players'
turns; `RevertTo` and `CloseRoom` belong to the room. Asking "is it your turn" of a phase transition is a
category error — the cursor at that moment usually points at whoever just finished.

**Decided from the message, never from a flag.** A client asserting `automatic: true` on the wire would be
granting itself an exemption, which is what #1207 keeps off the wire entirely. `isSandboxOnlyMsg` is a
property of the message the server can see for itself, and it is the *same predicate the shell dispatches
by* (#546) rather than a second list — #1184's shape, avoided by construction.

**Order is load-bearing.** The four negotiation messages are in that family too, and exemption 3 runs first
so their real owner checks stand. Moving the new block above it would make every trade answer in the game
answerable by anybody, and **no test would fail** — each one would simply pass. There is now a case pinning
that ordering.

**`SetupGame` is the one member cheap to guard**, and worth it: a second deal would erase a game in
progress. #538 read from the other side — a roster is "nothing until the log says otherwise", so a non-empty
roster *is* the record that the deal has happened.

##### Recorded gap, not an accident — closed by #1249

Any player in a room could send `OpenStockRound`, `SetBoPar`, `PlaceHomeStation`, `ExchangePrivate`,
`RevertTo` or `CloseRoom` at any time. **That was parity with Firestore**, where every client appends whatever
it likes and always could — so it was not a regression. It was still a real gap. The answers are per-message
and mostly need either the room document (who is the host) or the reducer's own legality checks, neither of
which belongs in a turn gate. **Closed as #1249, below**, before anything with money in it;
`trustClaimedIdentity` (#1210) remains the larger hole in the same wall.

**The test enumerates the family and counts it against the predicate's source**, so an eleventh shell message
cannot be added without classifying it. Four playtests were spent discovering this class one member at a
time; that is what the count is there to prevent.

##### The three things that were only ever tested on Linux

All three were the same fault — an instruction that works for the person who wrote it — and all three were
found by the user pasting the documented commands into PowerShell and getting nothing.

1. **`FOO=1 npm start`.** Not syntax PowerShell or cmd has. Fixed with flags in `start.ts`, environment
   still winning where set, because a deployment will use it.
2. **`NODE_PATH=../frontend/node_modules`.** Same problem, and unnecessary: `react` is now a real dependency
   of `server/` and resolves without help.
3. **`"build": "../frontend/node_modules/.bin/tsc"`.** The `.bin` entry is a shell script; cmd.exe reads the
   leading `..` as a command and answers `'..' is not recognized`. Invoked through `node` now — the same
   compiler, reached in a way every shell agrees about.

The pattern worth keeping: **a setup instruction is not verified until somebody on the target shell has run
it.** These are not covered by any test, and passing 4,750 of them said nothing about any of the three.

**Still to do:** `sandboxRoom.ts`'s index allocation is now dead weight *on the server path only*, so it
comes out once the transport is proven rather than alongside it. And `loadLog` is unwired, so a server
restart starts an empty room — Firestore stays the log's home per this plan, and connecting it is its own
step.

**Server owns:** appending to the log, applying the reducer, emitting state at settle points.

**Clients:** send intents, receive settled states. Whether clients keep replaying locally is a real choice —
keeping it gives you free divergence detection (client hash vs server hash on every state), which is
worth more than the code it costs.

**Keep Firestore as the log store, at least initially.** The log-is-truth architecture already works and was
proven under failure during this playtest: every client refreshed, rebuilt from the log, and reconverged.
Replacing the authority and the storage in one step throws away that evidence. Lightsail is a single box;
the log is what makes that survivable, so log durability matters more than server uptime.

**Item 6 lands here.** Server applies the derived auto-skip actions to the log — all of them, one per
subphase, preserving the record of what was skipped and why — and emits one state at the settle point. The
flicker disappears without the log losing anything.

### Phase 3 — settlement

> **SUPERSEDED IN PART BY `AUDIT_SETTLEMENT_2026-09-06.md`.** The audit found that the challenge window, the
> `AnnulGame` valve and the forfeit rule below are **one hole with three doors**: the chain cannot verify a
> game, so every path that ends in "annul" is a free refund for whoever is behind, and appraising at the
> instant of breach lets a leader disconnect profitably. Its fix is a **session lifecycle on the contract** —
> after `Start`, the only exits are an appraised settlement or unanimous signed consent — plus three forfeit
> rules (forfeit pays zero; clemency caps at refund; appraise at the last completed round boundary, not the
> breach instant). The audit also adds a **Phase 2.5, "money-ready"**, that must land before the first deposit.
>
> The text below is kept as the record of what was designed and why; where it conflicts with the audit, the
> audit wins, and §9 of the audit is the roadmap. Two decisions the audit surfaces are owner's calls and are
> flagged in `TRIAGE_2026-09-06.md` §0.


**Server submits:** the final appraisal state + a hash of the complete action log.

**The appraisal state is small.** `appraise_player_net_worth_breakdown` (`contract.rs:1045`) reads exactly:

- `PLAYER_CASH_VGP` per player
- `PLAYER_SHARES` per (player, company) — a percentage
- `market::current_cell` per company — for the price
- `PRIVATE_COMPANIES` per private — owner and `closed`

For three players and the core catalogs that is on the order of forty values. It stays a submitted
structure the contract appraises itself, so the payout arithmetic remains public, on chain, and queryable
per player.

**The hash is canonical for free.** `SandboxAction.payload` is *already stored as JSON text* rather than a
nested map — Firestore rejects nested arrays and `RunManualRoute.path` is one, so the payload is
`JSON.stringify`'d once by the dispatching client and distributed verbatim. Every client stores and applies
the identical bytes. So the settlement hash is taken over the ordered concatenation of `payload` strings,
ordered by `(index, id)` with the Firestore document id as the deterministic tie-break that
`sandboxRoom.ts` already specifies.

That removes the failure mode I was most worried about — no re-serialization, no key-ordering drift.
**Pin it with a test anyway**, before anything depends on it: hash a known log, assert the constant.

**Challenge window:** payout is not immediate. Every client recomputes the hash from the log it already
replayed and compares. Silence for the window → payout proceeds. A mismatch → the session becomes
annullable and `AnnulGame` refunds `ante − subsidy`, which the escrow already computes correctly.

The player is never asked to approve anything. Their client either objects or does not.

#### The clock, the forfeit, and clemency

**One mechanism, two parameter sets.** Live and Async are not two systems — they are two pairs of numbers
fed to the same chess clock. Each player has:

- a **per-turn allowance** — *thinking time*. **Live: 15 minutes.** Async ≈ 3 days.
- a **reserve** — *disconnect insurance*, drawn down only by overage. Live ≈ 15–20 minutes; Async longer.

Keep the two named separately and sized independently. Blurring them is how a reserve gets set to "how long
a hard turn takes" and a three-player Live game quietly acquires three extra hours, breaking the
single-sitting promise the mode exists to make.

**The reserve is not consumed by thinking.** It depletes only by `max(0, gap − allowance)`, so a player who
deliberates for fourteen minutes under a fifteen-minute allowance burns nothing. This is the property that
makes the pair work, and it is the one most easily lost by renaming or by merging them.

**The 15 minutes is measured, not guessed.** From `sandbox-log-JUNO-3XD.json` — 322 actions, 117 turns,
1.9 hours of wall clock, reaching macro round 7:

| | |
|---|---|
| Median turn | 40 s |
| p95 turn | 2.5 min |
| Longest turn in the session | 6.9 min |

Reserve consumed by the worst-affected player across that entire session: **10.7 min at a 2-minute
allowance, 1.9 min at 5, and zero at 10 or above.** Fifteen leaves better than double the headroom over the
longest turn actually recorded, which is the margin new players and late-game number-crunching want.

Two things that table also shows, worth keeping in mind when the number is revisited: the longest turns are
**single-action** turns — someone deliberating before committing — while a 15-action turn took 2.9 minutes.
Thinking concentrates in individual decisions, not in long sequences. That is the argument against a
per-action clock, which would meter exactly the case it needs to protect, and would additionally have to
special-case the auto-skip's derived entries landing 270 ms apart.

**Revisit it with data, not opinion.** This is one game, three experienced players, stopping at macro round
7; a full game runs further and late Operating Rounds are heavier, so the tail will grow. `turnClock.ts`
computes this distribution from any log, so every future playtest re-answers the question for free.

**It is log-derived, which is why it works here.** Every entry already carries `at`. The allowance and the
reserve are recorded in `SetupGame` beside the other variants. Remaining reserve is then
`reserve − Σ max(0, gap − allowance)` charged to whoever was on the clock — pure arithmetic over the log,
recomputable by any client, and therefore checkable in the same challenge window as everything else. A flat
deadline would have been a claim about a single moment that only the server witnessed; a running total is
strictly better.

`at` must be the Firestore server stamp rather than a client clock, or a dishonest client can backdate.

The reserve should drain visibly for everyone. A forfeit nobody saw coming reads as an ambush; one the table
watched approach reads as a rule. A mutual-pause action (all clocks stop) is worth having early — a table
that agrees to break for dinner should not burn reserves.

**Depends on Phase 1.** The forfeit must name the player who failed to act, which is "whose turn is it" —
the question §5b says has four answers and that #1174 and #1182 both crashed into. It is not safely
answerable until the chart folds into state and the server is authoritative. **The Timeout Forfeit cannot
ship before Phase 1.**

**On breach:** the game halts and the reducer appraises everyone at the current state, exactly as a
bankruptcy would end it. No liquidation, no receivership, no leaderless corporations — 1830 already ends a
game on bankruptcy and inventing a new mid-game ownership regime would be enormous scope creep for a case
that should be rare.

**Then the clemency window opens**, before anything is slashed. Three outcomes, and the threshold tracks
what each one actually costs the people voting:

| Outcome | Threshold | Why that threshold |
|---|---|---|
| **Execute Penalty** | default | Happens on silence. Offender's ante is slashed and divided among the remaining players. |
| **Grant Clemency** | simple majority | Waives only the punitive bonus. Everyone still receives their appraised net worth, the offender included. Nobody gives up anything they earned, so unanimity would only empower a sore winner to loot a disconnected player against the majority's will. |
| **Scrap Game** | unanimous | Mutual Annulment — everyone's ante returned, the game erased. This *does* take away earned positions, so every player must agree. |

Clemency waives the **penalty**, never the **game**. That distinction is what keeps the incentives sane: if
clemency meant annulment, a winning player would always block it and a table of losing players would always
grant it, so it would fire exactly when it should not and never when it should.

**Three implementation constraints:**

- **Votes are log entries.** Appended actions like any other, so the clemency outcome stays a function of
  the log and the challenge window keeps working. Server-side vote state would be a second unverifiable
  claim sitting beside the forfeit.
- **Majority means majority of the remaining roster, not of votes cast**, with silence counting as Execute.
  Otherwise one clemency vote and two abstentions passes it. A tie fails to the default.
- **Secret ballot.** Announce the outcome, never the ballots. Nobody should learn who voted to slash whom —
  this is the one adversarial moment in a settlement design built to avoid them, and it costs nothing to
  keep it private.
- **The window length is another Live/Async parameter.** 24 hours suits Async and is brutal in Live, where
  everyone is by definition already present. An hour is plenty there.

### Phase 4 — retire the Rust game logic

Only after Phase 3 is live and a real game has settled through it.

---

## 4. Harvest before retiring

`src/*.rs` holds rules the TypeScript has been mirroring **by hand**, and that has already shipped a bug to
real players: #1184's `MIN_BID_INCREMENT` lived in `WaterfallAuctionDashboard` under a comment calling
itself "a hand-kept mirror of `auction::MIN_BID_INCREMENT`", and it drifted.

Collapsing to one language kills that entire class. But not before the mirrors are reconciled:

- `auction::MIN_BID_INCREMENT` — already reconciled by #1184.
- `market.rs` price ladder — `sandboxSession.ts` says in a comment that the ladder "stays market.rs's".
- `trading::PERCENT_PER_SHARE` — the appraiser divides by it; the TS assumes 10% blocks.
- `CORE_PUBLIC_COMPANIES` / `CORE_PRIVATE_COMPANIES` — the appraiser iterates these catalogs, so they
  **stay on chain** and the TS must agree with them exactly.
- Depot costs and `TRAIN_LIMIT_BY_PHASE`.

**`src/tests.rs` is 17,565 lines of encoded rules.** Mine it for cases the TS suite does not cover before it
goes quiet. That is the largest single body of rule knowledge in the project and deleting it unexamined
would be the most expensive mistake available here.

---

## 5. What stays on chain

- **`escrow.rs`, entirely.** Deposit intake, the ante floor, the subsidy cut to the developer treasury,
  payout, annulment. Already audited to G-11. Effectively unchanged.
- **`appraise_player_net_worth_breakdown`** and the storage it reads — but written by a settle message
  rather than by gameplay.
- **The company catalogs**, since the appraiser iterates them.
- **New:** the settle entrypoint (state + log hash), the challenge window, the challenge entrypoint.

Everything else in `src/` goes quiet after harvest.

---

## 6. Open items this plan does not resolve

- **`AnnulGame` refunds everyone their ante, so a losing player can convert a loss into a refund by
  abandoning for 48 hours.** The escrow's own note guards the opposite direction — it refuses to hand the
  pool to whoever was ahead when a room stalled, calling that a rage-quit exploit — but the reverse hole is
  open, and the challenge window gives it a second door. Wants a decision, and it is a question about
  custody of real funds rather than an engineering one.
- **Ctrl+Shift+L is host-only** (§6). Under settlement the log is the evidence trail, so every player needs
  to export their own view. Less critical than it looks, since the client checks the hash automatically —
  but a player who wants to *see* why their client objected needs this.
- **Item 10** stays deferred until Phase 1 lands. It is a stale-origin animation, and folding the chart into
  state is exactly what would change it.
- **Whether clients keep replaying** after Phase 2. Recommended yes, for free divergence detection.

---

## 7. Order of work

```
0. Headless reducer + golden-master harness      → answers item 24                      DONE
1. Fold the market chart into state              → closes §5a                           DONE
2. Node authority; Firestore stays the log       → item 6 resolves here                 IN PROGRESS
   exit criterion: the nine remaining shell-message retirements landed (DONE, #1248),
   AND N full free games with the divergence alarm silent. Agreement is measured, not assumed.
2.5 "Money-ready" (AUDIT §9)                     → durable log, signed entries, reconnection,
   consent-gated undo, roster from chain, pinned reducer build, full-field log hash,
   clocks in free games. Every item verifiable in the existing harness.
3a. Contract lifecycle + Start/Checkpoint/Settle/consent/bonded challenge   (AUDIT §2–§3)
3b. Server + client halves of settlement                                    (AUDIT §9)
3c. Forfeit + clemency with §4's arithmetic, after 3a/3b have settled real games
4. Triage src/tests.rs by module → harvest → retire                          (AUDIT §8)
```

**2.5 before 3a, and Phase 2's exit criterion before 2.5b.** The consent fast path (every client auto-signs
the final state) is only safe when clients and server agree — and this week found four divergences in one
day. A client that has drifted will refuse to sign, or sign a wrong board. The alarm is what makes "agree" a
measurement; the retirements are what make it true.

Cosmetic playtest items (2, 9, 9a, 22a, 22c, 22d, and the false Train Limit modal) run in parallel
throughout — they touch components this plan does not. Land them as their own commits.

22b's reducer change can go in with Phase 1, since both change how existing logs replay and both want the
same suite run.
