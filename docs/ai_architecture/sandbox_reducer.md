# Sandbox Reducer — Local State Machine and Fixtures

`utils/sandboxSession.ts` (the local reducer) and `utils/sandboxState.ts` (its fixtures). This
is the offline/room-local state machine that stands in for the chain, and the boundary it is
forbidden to cross.

Anchors are `<source file> #<N>`. Search the number.

---

## The charter

### sandboxSession.ts #0 — What this is NOT, and why that is the point
**This is not a rules engine.** The Rust CosmWasm contract is the single source of truth for every
rule in 1830, and nothing in this file may become a second opinion about any of them.

The temptation is obvious and is resisted explicitly: it would not be hard to check the 60% float
threshold, move a stock price, or refuse a purchase that breaks the certificate limit. Every one
would be a rule reimplemented in TypeScript beside an authoritative Rust implementation, and the two
**would** drift — not "might". The contract has changed substantially across five batches of rules
work; a TypeScript mirror would have silently rotted at every one, and the sandbox would then teach
a developer behaviour the chain does not have. **That failure is worse than no sandbox at all,
because it looks like it works.**

So the reducer moves only what it can move *without knowing any rules*:

- whose turn it is (a pointer into a fixed seat list)
- the consecutive-pass streak (a counter, and when it wraps)
- the Operating Round corporation cursor (a pointer into a fixed queue)
- cash and share counts, **by the amount the caller states**

That last one is the boundary. Processing a `BuyStock`, it does not decide what the share costs — it
cannot, because price depends on par values, market position and the President's Certificate rule,
all of which live in Rust. It applies a nominal debit so the number on screen visibly changes.
`SANDBOX_NOMINAL_*` is named to make that unmistakable at the call site.

*(Successive notes have moved specific things across this line deliberately — floats `#363`, phase
changes `#284b`, the all-pass markdown `#271`. Each argues that a counter reaching a number with a
bookkeeping consequence is on the "moving pieces" side, not the "deciding rules" side.)*

### sandboxSession.ts #1 — Why a reducer and not mutation in place
Every function returns a **new** `GameStateResponse` rather than editing the one it was given.
React's rendering depends on identity comparison — a mutated object is the same object, and half the
dashboard would keep showing stale values while the other half updated, which is a far more
confusing bug than a control that does nothing. Fresh objects cost nothing at four players.

### sandboxSession.ts #2 — Why it takes the real `GameplayExecuteMsg`
Driven by the exact message union the live dispatch path sends to the chain, not by a parallel
"sandbox action" type. A new `ExecuteMsg` variant therefore cannot be wired into the app while
silently bypassing the sandbox: it shows up as a non-exhaustive match, and the default arm treats it
as a no-op turn-advancing action rather than pretending to understand it.

### sandboxSession.ts (module boundary) — `actingSeatIndex` deliberately lives elsewhere
"Which seat may act right now" is a question about the **contract's** state and the live dashboard
asks it too (`App.tsx`'s `isMyTurn`). Defining it in a sandbox-only module and importing it into the
production path would point the dependency the wrong way round. It lives in `gameState.ts`.

Likewise `utils/` must not import `components/`: `projectShareSaleMove`, `projectDividendCellMove`,
`marketCellForPrice`, `parBoxCellFor` and `homeHexToAxial` are all **injected** by the caller rather
than imported.

---

## The Operating Round machine

Four separate bugs, four passes, one lesson each time: **a value that has to be correct, read from a
field that nothing writes.** `#411`, `#431`, `#621` and `#642` are the same defect in four places.

### sandboxSession.ts #411 — The operating queue has to be built by somebody
**Reported:** ending a corporation's turn in an OR advances nothing, so the round runs forever.

**One root cause, and it is not in the advance at all.** Nothing ever filled
`active_operating_order`. Two paths enter an OR and both set the round type without building the
queue. The fixtures ship a hand-written queue, so every scenario that *opens* in an OR worked and hid
this completely. A game *played* into one from the zero state arrives with `[]`:

- `advanceCorporation` read `queue === 0` and returned the state untouched — the infinite round.
- `actingSeatIndex` read `active_operating_order[0]` as `undefined` and returned `null`, meaning "no
  seat may act". That locked the president out of Lay Tile while leaving every unconditioned button
  live for everyone. **The authorisation predicate was not wrong; it was handed an empty queue and
  correctly concluded nobody was on turn.**

So the queue is built where the round begins, and the two entry paths share one function.

**Order is by market price, descending** — 1830's actual rule. The price lives in the separate market
atom (`#272`), which this reducer must not reach into, so the caller injects a lookup. Without one
the par value stands in: it is the price every corporation starts at, so a queue built from it is
right until the chart first moves and never absurd.

**Only floated corporations with a president.** An unfloated company cannot operate; a floated one
with no president has nobody entitled to act for it, and `actingSeatIndex` would return `null` on its
turn and strand the round exactly as an empty queue does. Both excluded here rather than skipped
later, so the queue cannot contain an entry that stops it.

An **empty queue is recovered, not tolerated**: `advanceCorporation` rebuilds the missing queue rather
than refusing to move, and if nothing can float the round is genuinely over.

### sandboxSession.ts #468 — The price fallback is load-bearing
**Reported (critical):** a corporation with no matrix coordinate breaks the queue and soft-locks the
OR transition.

The `??` chain is what stops that. A corporation floats the moment 60% sells, and its market **mark**
is written by a separate atom on a separate code path (`#272`) — so there is a real window (and in
the B&O's case a persistent state) where a company is legitimately floated with no price yet.

**Falling back to PAR rather than zero** is the difference between a queue that is merely approximate
for one render and one that is wrong: par is what the corporation is worth until the chart says
otherwise. Zero would sort every unmarked corporation to the back regardless of value.

**`Number(...) || 0` catches the rest** — a par that is `null`, an empty string, or anything `Number`
turns into `NaN`. That matters more than it looks: **`NaN` propagates through `sort`'s comparator and
produces a comparison that is neither less, greater nor equal, which yields an order that is not
total.** A queue that is not totally ordered can put the cursor back on a corporation that has
already operated — the infinite Operating Round, arriving by a different route than `#411`'s empty
queue.

### sandboxSession.ts #646 — Price first, then who got there first
**Instructed:** "corporations act in descending market value" and "corporations on the same cell act
in the order in which they reached the cell".

The first was already right. The second was a placeholder — ties fell through to `company_id`
ascending, which made turn order a function of the contract's roster numbering, so PRR (id 1) beat
B&O (id 4) at equal price forever, whichever had parred first.

**Ascending arrival, so earlier goes first.** `company_id` survives as the last resort and still earns
its place: two corporations can share an arrival ordinal only if neither has one recorded, and the
sort must still be **total** — an incomparable pair makes `sort` produce an order that is not an
order, which is how the cursor lands on a corporation that has already operated.

`Infinity` for a corporation whose arrival is not recorded sorts it **after** every corporation whose
is. A fixture board seeded straight onto the chart has no history to read, and guessing one would
invent a turn order.

### sandboxSession.ts #647 — And rightmost before either of them
**Instructed:** "if two corporations have the same share value but are on different cells, the
corporation whose token is furthest right on the matrix goes first."

**The three rules are disjoint, which is why this is a clean third level** rather than a special
case. Equal price and *different* cells is rule (iii); equal price and the *same* cell is rule (ii).
A shared cell shares a column, so comparing columns first is a no-op for rule (ii) and decisive for
rule (iii) — neither rule can reach the other's ground.

**Column, not cell identity.** Two cells in one column can share a price on this chart, and "furthest
right" cannot separate them: they are equally right. Those fall through to arrival, which is not the
stated rule but is the nearest thing to it and keeps the order total. The rules do not legislate that
case and this is the honest place to say so.

**Descending, unlike every other level here** — `b.column - a.column` is the one comparison that reads
backwards, because rightmost is first. `-Infinity` sorts a positionless corporation to the left of
every real column, which puts it last, matching `#646`'s direction for a missing arrival.

`#647` also replaced `arrivalFor` with a **whole-mark** lookup: rule (iii) needs the column as well,
and a second scalar lookup beside the first would be two ways of asking one question — and a third
the moment a rule needs the row. `priceFor` stays separate deliberately, because `#468`'s fallback
chain reaches past the chart to `par_value` and folding that into the mark would either lose the
fallback or invent a cell the token is not standing on.

### sandboxSession.ts #431 — 1830's Operating Round counts
| Phase | ORs between Stock Rounds |
|---|---|
| Yellow (2-trains) | 1 |
| Green (3- and 4-trains) | 2 |
| Brown (5-, 6-, Diesel) | 3 |

**Reported:** after every corporation operates in Yellow, the game opens another OR instead of
returning to the Stock Round. The check read `operating_round_sequence_length` off the state; the
field exists and **nothing maintained it** — `sandboxState.ts` hardcoded `2` into every fixture. So
in Yellow the check was `sub_round_index (1) < 2`, true, and the queue rebuilt. The Stock Round was
reachable only by accident of the fixture's number happening to match the phase.

**The phase is derived from the trains in play, not from `current_global_era`.** Both are on the
state and they answer subtly different questions: `current_global_era` is the contract's **tile
colour**, while the OR count is set by the highest train tier anyone owns. `derivePhase` is already
this app's single answer to "what phase is it", so the OR count cannot disagree with the phase the
player can see.

**`null` phase yields 1**, the Yellow count — the safe direction: one round too few returns the player
to a Stock Round they can act in, while one too many is the bug being fixed.

"Gray" in the requirement is 1830's Diesel phase. `PhaseTint` has three values and folds 5/6/D into
`brown`, and all run 3 ORs, so a fourth would be a distinction with no consequence.

The field is now **written** on every round open rather than read, so `ContextualSubPanel`'s "OR n of
N" starts telling the truth instead of always saying 2.

### sandboxSession.ts #511 — The sequence locks at the start of the cycle
**Reported:** buying a 3-train during Yellow shifts the game to Green mid-round, and it then expects
a **second** OR before returning to the Stock Round.

`#431` was right about where the rule lives and wrong about **when to ask**: it derived live, at the
moment the last corporation finished, by which point a train bought three turns earlier may have
moved the phase.

**1830 fixes the number of Operating Rounds when the cycle opens.** A phase change during the cycle
takes effect for the *next* one. So the count is stamped once and every later reader takes the stored
value.

`continuingSequence` distinguishes the two callers: opening a cycle re-derives; opening the **second**
OR of an existing cycle carries the locked number forward. Without the flag the function cannot tell
them apart — it rebuilds the queue identically either way — and re-deriving on the continuation is
exactly how the lock would leak.

The reader falls back to the phase's own count when the field is absent or nonsensical, and
`Math.max(1, ...)` guarantees at least one OR, so **a bad stored zero can never end a cycle before it
has run.**

### sandboxSession.ts #621 — The counter was the one field nobody stamped
**Reported:** three corporations floated, all three took their turn in OR 1, "the Operating Round then
looped back to B&O" — in Phase 2, which runs exactly one OR.

`advanceCorporation` decides with `sub_round_index < sequenceLength`, and `#431`/`#511` got the
**right-hand** side exactly right. **Nobody ever set the left-hand side.** The Stock Round's close
zeroes `sub_round_index`, this function did not touch it, so a cycle opened at 0 and the first
completed queue asked `0 < 1` — true — and ran the whole thing again.

**Every phase got exactly one extra round**, which is what made it hard to spot: Yellow ran 2, Green
3, Brown 4. The rule looked implemented and was off by one everywhere at once, and the fixtures hid it
by shipping `sub_round_index: 1` on any scenario that *opens* in an OR — the only states anybody had
tested from.

**This is the third field in this function with the same story.** The round now opens with all three
bookkeeping values written together, so a reader can see the whole opening position in one object
rather than inferring which parts survive from the last round.

**A continuation does not touch it.** `advanceCorporation` owns the increment for the second and third
rounds of a cycle — it is the caller that knows a round just finished — and writing it here as well
would be two hands on one counter.

### sandboxSession.ts #642 — The round machine belongs to the reducer
**Reported, over four separate passes:** the OR counter does not increment, a one-round Yellow cycle
runs twice, and an undo removes a train without returning the turn to the corporation that bought it.

`#431`, `#511` and `#621` each fixed a real defect in `advanceCorporation` and **none of them fixed
the reported bug, because `advanceCorporation` was never where it lived.** Applying a message was
split across two places: this reducer changed the game, and then `App.tsx`'s `runGameplayAction`
noticed the round-boundary flags and performed the transition itself.

**That split is invisible until something replays, and two ordinary things do.** A sandbox room
reconstructs its board by re-applying the log from index zero; an undo (`RevertTo`) shortens the
history and forces exactly that rebuild. Both run the reducer and neither runs the shell. So
corporate state came back precisely and round state did not — **a rebuilt board whose corporations
were correct and whose round was wherever the last live dispatch had left it.** That is the reported
undo exactly: PRR's train came off because the reducer owns trains, and PRR's turn did not come back
because the shell owned turns.

**The project's own rule says this:** actions are appended to a log and read sequentially by a single
reducer path. A second path that also changes the game is not a shortcut, it is a second source of
truth — and the failure mode is not a wrong number, it is a board that cannot be rebuilt from its own
history.

So `applySandboxAction` is now two steps: `applyOneAction` (the whole of the old function, unchanged)
then `settleRoundTransitions`. **What stays in the shell is everything that is not the game** — the
log line announcing the round change, and the tab the player is looking at. Those are *reactions* to a
transition rather than part of it, they must not repeat on every replayed action, and `App.tsx`
detects them by comparing round type before and after, which replays correctly by construction.

### sandboxSession.ts #642a — The flags are consumed where they are raised
`recordPass` raises `stock_round_just_ended`; `advanceCorporation` raises
`operating_round_just_ended`. Both are still one-shot, and now **nobody outside this file reads
them**: each is consumed in the same dispatch that raised it, and cleared. A flag that survives its
own transition fires it again on the next action — the other half of how a replay could run a Stock
Round close once per remaining message.

**One transition per action, deliberately, rather than a loop.** A Stock Round closing opens an OR,
and that OR cannot also end in the same dispatch. If some future rule makes a double transition
possible, it should be written down and tested rather than absorbed silently by a `while`.

### sandboxSession.ts #656 — The turn cursor moves here, not in an effect
**Reported:** "the game stayed in OR 1.1 and returned to C&O's turn, starting at step 3."

`orSubPhase` was React state in `App.tsx`, re-seeded by an effect keyed on `current_global_era` and
`currentPhase.tier`. Buying a 3-train changes the era **during** the Buy Trains step, so the effect
re-ran with the corporation unchanged and reset the cursor.

**This is `#642` one layer down**, and is placed deliberately beside `settleRoundTransitions` for that
reason: same shape of defect, same shape of fix. That note moved **round** transitions out of the
shell; this moves **turn** transitions out of an effect. After this one the answer to "what does a
client rebuild when it replays the log" is *the whole game* rather than *the whole game except which
step anyone is on*.

**One place rather than twelve message arms.** The alternative was an `operating_sub_phase` write
inside each of `LayTile`, `PlaceStationToken`, `RunManualRoute`, `DeclareDividends` and the rest. That
spreads a single rule across arms otherwise about money and trains, and every arm added later is a
chance to forget it. Here the **default is stated** (`settleSubPhase`: hold where you are), so a new
message that says nothing about the cursor leaves it alone.

**A turn change beats every step rule.** Whatever a message did to the cursor, if the acting
corporation or the round changed underneath it then a new turn has begun and it opens where the era
says it opens. Checked first, so no arm can hand a fresh turn a stale step.

The four explicit step arms **mirror what the contract does with its own cursor** rather than
inventing a sandbox sequencing rule — `hexmap::execute_lay_tile` advances off `Track` on success, and
the rest follow. They were previously four `setOrSubPhase` calls scattered through `App.tsx`, which is
why a replay never performed them.

**Outside an OR there is no cursor**, cleared rather than frozen: a Stock Round keeping `Hardware` on
the state would hand it to the first corporation of the next OR if any later read forgot to check the
round type.

**The default is to stay put, and it is the important arm.** Buying a train is the reported bug: it
changes the phase, and *the phase is not a turn event*. Neither is a private company being bought, or
a share price moving.

### sandboxSession.ts #657 — The era has to move when the phase does
**Instructed:** "tiles should become available immediately based on the era ... though the SR>OR
pattern does not change at this point."

`current_global_era` was **never written by this reducer** — not one assignment anywhere. Stamped once
at seed time, so every sandbox room reported "Yellow" in a Phase 6 game.

**How bad it actually was, stated honestly because the first report overstated it.** Tile availability
and route revenue were never affected: `radialCandidates` and `sandboxRouteBreakdown` are both handed
`ERA_FOR_PHASE_TINT[currentPhase.tint]`, derived live from the trains in play. What read the frozen
field was the **map's own readout** — `HexGridRenderer`'s `currentEra`, which prices off-board
terminals in hover text and bolds a row in the era legend. So a Green game showed Yellow off-board
values on hover while paying Green ones on the route.

**Settled, not written per-arm.** The era is a **function** of the trains in play, so it is recomputed
after every action rather than assigned in the one arm that buys trains. There is no message anybody
could add that changes the fleet and forgets the era.

**The OR count is deliberately not touched.** "The SR>OR pattern does not change at this point" is the
rule and `#511` already implements it. **Tiles are immediate; the round pattern is locked. Two
different answers to "when does a phase change take effect", and 1830 genuinely gives both.**

### sandboxSession.ts (phase table) — Train tier to tile colour
Written out rather than derived from `TIER_PRESENTATION[tier].era`, because that table exists to pick
a **badge colour** — and a rule should not be read out of a presentation table. The day someone
re-themes the badge is the day the tile colours move with it.

### sandboxSession.ts #352 — Who traded last
The Priority Deal after a Stock Round goes to the player **sitting to the left** of whoever last
bought or sold. That is a fact about the round's history and nothing in `GameStateResponse` records
it — the contract derives it inside `conclude_stock_round` and reports only the result.

Kept **on the state object** rather than in a module-level variable, for `#310`'s hard-won reason:
anything the dispatch path writes has to be in the undo snapshot, and the snapshot copies the state. A
module variable would survive an undo and hand the deal to somebody who no longer traded.

`null` when nobody traded all round — an entire Stock Round of passes, which is legal and which 1830
answers by leaving the Priority Deal where it was.

### sandboxSession.ts #353 — The round now actually ends
**Reported:** the Stock Round never ends, and the Priority Deal starts on the wrong player.

The previous note was candid about the first half — "the sandbox marks the boundary by resetting the
streak so the loop keeps moving, and leaves the consequences to the contract" — which was right when
the sandbox had no round transitions at all. It has them now, and **a round that can be entered but
never left is a dead end of exactly the kind `#271` fixed for the auction.**

**What it does:** ends the round, moves the Priority Deal to the seat left of the last trader, and
seats that player to act first in the OR that follows. **What it still does not:** the sold-out price
rise and the lockout clearing, which are `market.rs`'s and `trading.rs`'s. Those are rules about
**value**; this is pacing about **whose turn**.

"Left" is the next seat in turn order, the same direction `advanceSeat` moves.

### sandboxSession.ts (pass semantics) — Passing means two different things
In a seat-driven round it is a player declining their turn, and a full round of them ends the round.
In an Operating Round the same message is what "End Operating Turn" sends — **the corporation is
done**, and the queue moves to the next company. Treating both as a seat advance would strand the OR
on its first corporation forever.

### sandboxSession.ts (seat pointer during an OR)
The seat pointer is not meaningful during an OR — the queue names companies — but it is still the
field every seat-driven consumer reads, and leaving it parked on whoever last acted in the Stock Round
is what made "the active player never changes" a second, separate symptom of `#411`. **Left untouched
when the presidency cannot be resolved:** moving it to zero would hand the controls to an arbitrary
seat.

---

## Determinism under replay

### sandboxSession.ts #549 — The log says who did it, so the reducer must ask
**Reported:** Player 2 bought a president's certificate and it never appeared on Player 1's screen.

`applySandboxAction` resolved the acting player as
`state.player_addresses[state.active_player_index]` — **the turn cursor on the machine doing the
applying.** In a hotseat that is exactly right. In an event-sourced room it is **a determinism bug of
the worst kind**: the whole design (`App.tsx #522`) is that every client replays the same ordered log
and therefore reaches the same state, but a reducer that reads identity out of local state **is not a
function of the log alone.** Let two clients disagree about the cursor by one seat and from then on
every replayed purchase is credited to a different player on each. Nothing errors — the two games
simply stop being the same game, and the first visible symptom arrives several actions later,
somewhere unrelated.

**So the author travels with the action.** The reducer becomes a pure function of
`(state, message, author)` and the local cursor stops being an input. Omitted falls back to the
cursor, deliberately: solo sandbox has no log and no author.

### sandboxSession.ts #549b — An unknown author is nobody, not whoever is handy
The first cut was `ctx?.actor ?? cursor`, and a test failed for a reason worth keeping: **`??` makes
an author the reducer cannot place fall through to the local cursor** — precisely the nondeterminism
`#549` exists to remove, quietly reinstated as a fallback.

It matters concretely. Log entries written before `#549a` recorded the author's **nickname** rather
than their id, so any room already in Firestore replays with authors that match no seat at all.
Falling back to the cursor would make those entries resolve differently on every client — the original
bug, from data.

Three cases, each saying one thing:

| Value | Meaning |
|---|---|
| `undefined` | no author offered. Solo sandbox, where the cursor **is** the actor. |
| seated | the author, used. |
| anything else | `null`. The action applies to nobody and visibly does nothing, **identically on every client.** A no-op is a bad outcome; an outcome that differs per browser is a worse one, and only one of the two can be noticed and reported. |

### sandboxSession.ts #579 — The price is in the message
**Reported:** a corporation parred at $67 charged $67 to its founder and $100 to everybody, in the log
and in the wallet — and the same game showed the two players different cash totals for each other.

`ctx.parValue` and `ctx.sharePrice` are both assembled by the **caller**, in `App.tsx`, from that
browser's own par ladder and market atom. On the acting client the ladder holds the rung the player
just picked; on every replaying client it is empty and falls through to `MOCK_BUY_STOCK_PAR_VALUE` —
the string `"100"`. So the founding buy wrote `par_value: "67"` on one machine and `"100"` on the
other, and every later price, cash total and eventually the float capitalisation ($820 against $1000)
followed.

**The tell was in the report:** the NNH "tracks correctly for both players". The NNH was parred at
$100 — the fallback. It was not working; **it was agreeing with the wrong answer by coincidence.**

**This is the third time** (`#549` the actor, `#553` the ladder, now the price). Same shape every
time: a shared fact derived from a per-browser value. The rule that follows, and it is now a rule
rather than three fixes:

> **If the reducer needs it to decide, it travels in the message.** `ctx` is for things that are the
> same on every client by construction — the map, the era — and for nothing else.

`par_value` had been in the message all along; the reducer simply was not reading it.

---

## Money and bookkeeping

### sandboxSession.ts (cash arithmetic) — Strings, and a zero floor
Cash is a decimal **string** on the wire (`Uint128` does not survive a JS number), so `adjustCash`
parses, adjusts and re-serialises. Flooring at zero rather than allowing a negative keeps the sandbox
from rendering an impossible balance — the real contract would simply have refused the action.
`adjustTreasury` is the same, and without it a tile lay or train purchase would leave no visible trace
and the OR panels would look inert.

Pool moves **clamp at zero rather than validating**: if a caller asks for more than the pool holds,
the sandbox takes what is there instead of throwing, because refusing would be enforcing a rule. The
clamp exists so mock state cannot go negative and start rendering nonsense.

### sandboxSession.ts #432 — The terrain is what costs money
**Reported:** laying track on the $80 water hex J14 deducted $20.

It deducted `SANDBOX_NOMINAL_TILE_COST` — a flat $20 for every tile on every hex. **The $20 was never
a rule**; it was a placeholder from before the board had terrain, and it survived because a fixed fee
looks like a fee.

**1830 charges nothing for the tile itself. What it charges for is the ground:** $80 to bridge a
river, $120 to cross a mountain, $0 on clear land. `terrainBuildFeeAt` mirrors
`hexmap::terrain_build_fee` and has carried those figures all along — **the renderer has been drawing
$80 on J14 while the reducer charged $20 for it**, this codebase's recurring failure shape: a UI
quoting a transaction the state does not perform.

**By coordinate, not by tile.** The fee is a property of the hex. **Zero is a real answer** — most of
the board is clear ground and lays free.

`SANDBOX_NOMINAL_TILE_COST` was **deleted** rather than left exported-and-unused: a plausible-looking
constant that nothing imports is a standing invitation to reintroduce the behaviour just removed, and
"nominal tile cost" reads like something a tile lay ought to consult.

### sandboxSession.ts #239 — The token price escalates here too
A flat $40 for every placement is 1830's price for exactly the **second** token. The home token is
free and the third onward cost $100, so a corporation placing its fourth was charged less than half
what it owed. `stationTokenPrice` is the same schedule the UI quotes (`utils/stationTokens.ts`), read
off the count the company **already** holds — so the figure charged and the figure on the button
cannot disagree.

### sandboxSession.ts #194 — A bank purchase has to consume depot stock
`BuyHardwareFromPool` charged a flat $80 (the 2-train's price) and added nothing to the roster:

- **Every train cost $80.** Buying a 5-train took $80 out of a treasury that should have lost $450.
- **The depot never emptied.** `depotInventory` derives each tier's remaining stock from what
  corporations **own**, so a purchase that added no train left the supply frozen — the quantity cap
  had nothing to count down, the phase-shift warning could never fire, and the cheapest-first queue
  could never advance a tier.

The tier is **not chosen here** — `depotInventory` already applies the cheapest-first queue rule, so
"the train the depot will sell" is the first row with stock left.

### sandboxSession.ts #284 — A phase change is an event, not a label
**Reported:** phase changes do not purge rusted trains or trim fleets when limits decrease.

The gap was invisible because everything **around** it worked. `derivePhase` reads the phase off the
highest train in play, `depotInventory` marks a tier `rusted`, and the chips render correctly. So the
UI said "2-trains have rusted" while every roster still held them. **A rust is a state change, and
nothing was performing it. The displays were describing a transition the model had never made.**

Three things fire, and **the order is load-bearing**:

1. **Rust.** The first 4-train destroys every 2-train; the first 6 destroys every 3 **and** every 4.
   `RUSTED_BY` in `gamePhase.ts` is the one table, read rather than restated.
2. **Trim.** 1830's limit falls to 3 in Phase 4 and 2 from Phase 5; a corporation over the new limit
   discards down to it, cheapest first, because the rules make the president choose and the cheapest
   is the choice a player would defend.
3. **Rust before trim, always.** Rusting usually does the trimming for free, and trimming first would
   discard a train the rust was about to take anyway.

**Scrapped trains go nowhere.** 1830 returns a discarded train to the bank pool for resale, but this
build's depot is *derived from what is owned* — so removing a train from a roster already puts it back
in the depot's arithmetic. Writing it somewhere else as well would double it.

### sandboxSession.ts #284b — Only on the purchase that changes the phase
The first cut applied the consequences to **every** depot purchase, and it deadlocked the sandbox in a
way peculiar to this build.

The depot's remaining stock is **derived** from what corporations own, so trimming a fleet does not
merely discard a train — **it puts that train back into the depot's arithmetic.** A corporation buying
its fifth 2-train against a limit of four was trimmed straight back to four, the depot read one more
2-train available, and the next purchase repeated it. Forty purchases later the phase had not moved
off 2. Caught by an end-to-end loop that expected a 4-train and watched it never arrive.

The rule was always about a phase **change**, so it fires on one — which is also the literal reading
of 1830 ("the *first* 4-train"). Applied **after** delivery, because the arriving train is what
defines the new phase; the buyer's own new train is never at risk.

### sandboxSession.ts #333 — The president's money actually moves
This arm was `buyDepotTrain` verbatim — the same call as the ordinary purchase, which charges the
**treasury** and nothing else. The emergency case is precisely the one where the treasury cannot pay,
and `adjustTreasury` floors at zero, so the corporation paid what it had, **the shortfall evaporated**,
and the president's wallet was untouched.

`EmergencyTrainPurchaseModal` tells the president they are about to pay $220 of their own money; if
the reducer does not take it, **the modal is lying to them**.

So the payment splits the way 1830 splits it: the treasury pays everything it has, the president
covers the remainder, and `buyDepotTrain` then runs with a treasury topped up to exactly the train's
price so its own arithmetic is unchanged and there is no second copy of it.

**What this still does not do is sell shares.** If the president's cash is short too, the zero floor
means they pay what they have and the purchase completes underfunded. The modal will not enable its
confirm in that state, and the real rule needs the forced-sale message the modal's `#1` records as
missing from `ExecuteMsg`.

### sandboxSession.ts #192 — Running a route records; declaring pays
The treasury credit **moved** from `RunManualRoute` to `DeclareDividends`, and the move is a
correctness fix rather than a tidy-up.

`App.handleRunTrains` always sends `payout_strategy: "Withhold"` — the payout choice belongs to the
Dividends step — so this arm credited the treasury, and then the player hit "Withhold to Corporate
Treasury" and credited it a **second time**. Paying out was worse: the revenue had already been banked
into the treasury, so a "Pay Dividends" click handed shareholders money the corporation had
simultaneously kept.

Running a route now only **records** what it earned. Exactly one of the two dividend choices then moves
that money, once. `payout_strategy` is deliberately not read.

### sandboxSession.ts #492a — A turn's routes are a sum, not the last one
This **assigned** `String(earned)`, and `RunManualRoute` declares one train (`#275`) — so a corporation
running three trains sent three messages and each overwrote the one before it. The field ended the
turn holding the third train's revenue, and the OR table's "Last Route Payout" column under-reported
every multi-train run it has ever shown.

It **adds** now, and `ctx.resetRouteRevenue` marks the first message of a batch. `App.handleRunTrains`
is the only sender and dispatches its whole batch in one loop, so it is the one caller that knows which
message is first — **the reducer cannot tell, and guessing from the state would be a heuristic where a
fact is available.**

**Why not reset on a turn boundary instead:** there is no message for one.
`AdvanceOperatingSubPhase` fires on a **skip**, inside a turn, and the Routes-to-Dividends step change
is App-local state the reducer never sees. A reset keyed to any of those would fire at the wrong
moments and zero a total mid-run.

**The dividend money does not depend on this.** `DeclareDividends` prefers the message's own
`revenue_amount`. This field is what the **ledger** shows, and it was wrong on its own account.

### sandboxSession.ts #193 — The dividend buttons were a no-op
"Pay Dividends" and "Withhold to Corporate Treasury" dispatched, logged a success line, advanced the
stepper — and returned the state unchanged. **The log says it worked and the board says it did not.**

**Withhold** credits the corporation. **Pay** splits the revenue ten ways — one certificate is 10% —
and sends each slice where 1830 sends it:

| Holder | Destination |
|---|---|
| player holdings | that player's cash |
| the IPO pool | the corporation's own treasury (unsold shares pay the company, they are not skipped) |
| the bank pool | the bank, so the bank's net outlay is the revenue minus that slice |

**What this is still not:** it does not move the share price — that is `market.rs`'s ladder with its
ledges and cliffs — and it does not enforce that a route was run first or that this corporation may
act.

### sandboxSession.ts #191 — The reducer settles; the UI decides when to ask
A corporate train trade used to move neither the train nor the money, so the panel reported a sale
that had not happened. Settling it is bookkeeping of exactly the same class as `BuyPrivateCompany`.

**What this deliberately does not decide is whether the counterparty agreed** — that is
`train_trade.rs`'s two-party offer flow on chain and `TrainPurchasePanel`'s consent modal in the
sandbox. Both hold the message back until the answer is yes, which is why there is no president check
here.

**One train, deliberately.** `msg.rs` carries a single `model_type` and no count. A seller who does not
hold the model is a **no-op rather than a throw** — reaching it means the roster changed under an open
offer, in which case doing nothing is the honest outcome.

### sandboxSession.ts (private purchase) — The private has to actually change hands
This charged a flat $40 (the station token price, reached for as a stand-in) and did nothing else. The
seller was not paid, the treasury moved by the wrong amount, and the private stayed listed as the
player's. Settling it is bookkeeping; whether the trade was **permitted** — the phase gate, the
sub-phase cursor, the president check, the 50–200% band — stays entirely with
`trading.rs::execute_buy_private_company`.

### sandboxSession.ts #660 — The B&O is not for sale to a corporation
**Reported:** "the rules prohibit B&O (private company) being sold to a corporation."

`privateCatalog.ts` has said "It can never be sold to a corporation" since the powers panel was
written, and nothing checked it. The offer list is filtered too, so this arm should be unreachable —
**and it is enforced anyway, because a rule guarded only by a UI filter is one replayed log entry away
from being no rule at all. A remote client replays messages, not button states.**

**A no-op rather than a thrown error**, matching `buyDepotTrain`'s empty depot: throwing would take
down a replay over a message that should never have been written.

### sandboxSession.ts #560 — Recording a choice is not inventing a rule
This used to leave `station_tokens` alone on purpose: "which city slot a token occupies is resolved by
`hexmap::execute_place_station_token` against real slot counts, and guessing it here would be exactly
the kind of rule-shaped invention `#0` rules out."

**That is right about guessing and it was applied to a case where nothing had to be guessed.**
`city_index` is already in the message — the player clicked a specific city and `#453` resolved which
one. Declining to write it down is not restraint; it discards information the app was given and falls
back to a heuristic that picks the first slot on every multi-city tile.

So the slot is recorded **only when the message carries one**. Absent, the old behaviour stands
exactly as before — the case `#0` was actually protecting. The two arrays are written **in the same
order and in the same breath**: two arrays describing one set of tokens have to move together or the
second becomes a partial, stale index of the first, and a partial index is worse than none because the
renderer trusts it.

---

## Floats, home stations and privates

### sandboxSession.ts #363 — Floating puts a token on the board
**Reported:** when ERIE floats, the UI neither places nor prompts for its home station marker.

**Nothing in the sandbox ever floated anything.** `is_floated` was seeded by the fixtures and never
written again — so a corporation could cross 60% sold and stay unfloated forever, with an empty
`station_token_hexes` and a treasury that never received its capitalisation.

**Floating is a threshold, which is why it belongs here.** `#0` draws the line at rules the contract
owns, and the float check is on the same side as the phase change (`#284b`) and the all-pass markdown:
a counter reaching a number, with a consequence that is bookkeeping. **What** floats a company (60%
sold) is the contract's rule and is read from `FLOAT_THRESHOLD_PERCENT`; what happens when it does is
moving pieces.

The float check rides on **buying**, since that is the only action that can cross the threshold, rather
than running on every dispatch.

### sandboxSession.ts #376 — The treasury, now that the mode is settled
**Reported:** a corporation that floats keeps a $0 treasury.

This note previously declined to fix it: "full capitalisation pays the company 10x its par price, and
`par_value` is set but the **capitalisation mode** is `market.rs`'s — 1830 has full, incremental and
part variants and this build has not established which the contract implements."

The mode is now established as **full**: exactly ten times par, credited the moment the company floats.

**The bank pays it.** Capitalisation is the corporation selling its shares to the players, and the
money the players spent has already gone to the bank — so this is that money coming back out, not new
money appearing. Skipping the debit would inflate the game's total supply and push back the bank-break
ending, which is a real 1830 end condition.

**No par, no credit.** `par_value` is null for a company that somehow floated without one — which the
B&O private can produce (`#354`). Ten times nothing is nothing, and inventing a default would put a
figure in a treasury that every later comparison trusts.

### sandboxSession.ts #416 — The token is prompted, not placed
**Reported:** stop auto-placing the home station; make the president place it explicitly, even though
the destination hex is fixed by the rules.

`#363` placed it automatically and argued: "there is no decision for a player to make, so a prompt
would be asking a question with one answer."

**That reasoning is about the rules and the requirement is about the player, and on this one they come
apart.** The float is the most consequential thing that happens to a corporation, and placing the token
silently meant the most visible half of it happened while the player was looking at a stock card on
another tab. A first token appearing on a board nobody was watching teaches nothing about where that
corporation now operates from.

**The prompt is not asking WHICH hex. It is making the player witness the placement**, and it names the
hex while doing so — which is why it can be a confirmation rather than a map interaction and still
satisfy the requirement.

`applyFloatThreshold` now floats and capitalises and stops. `homeHexToAxial` is still taken — unused
for placement, still what decides whether a home hex **resolves**, because a company whose label maps
to nothing must not raise a prompt that can never be satisfied.

`pendingHomeStationTokens` is **derived from state rather than reported by the reducer**: the condition
is a fact about the board that stays true until answered, so a poll landing late, twice, or after a
reload finds it just the same. A one-shot flag would lose the prompt on refresh. **Ordered by
`active_operating_order`** where one exists, so two corporations floating on one dispatch are prompted
in the order they will act. A company with no `home_hex_label`, or one whose label does not resolve, is
**absent rather than pending** — NNH has no home hex on this board.

`placeHomeStationToken` is **idempotent**: it returns the same object when the token is already down,
so a double-click, a replayed dispatch, or a poll arriving between the click and the state write cannot
stack two tokens on one hex.

### sandboxSession.ts #400 — The float announcement, named so it can be tested
The announcement was written inline in `App.tsx`'s dispatch closure, and mutation testing said what
`#354` already learned the hard way about `grantBOPresidency`: an inline version "passed a whole suite
of assertions that only ever read the source text, and survived being switched off entirely."
Switching the hex branch off produced the same result — every source regex still matched, because the
strings were still in the file.

**So the decision that has branches is a function with a return value.** `null` for a company that did
not just float, which also makes "did this float?" answerable without re-deriving the comparison.

### sandboxSession.ts #467 — The float line described a world that ended
**Reported:** the activity log says "It has no home hex on this board" when the PRR floats. The PRR has
a home hex.

Two branches, and the wrong one had become **unreachable-in-reverse**. It reported the token placement
when a token had just appeared (`gained`) and fell through to "no home hex" otherwise — correct while
`applyFloatThreshold` placed the token as part of floating. `#416` stopped it doing that, so `gained`
is always false and **every corporation got the sentence written for the one that has none.**

The branches are the same two, **re-aimed**: the question is no longer "did a token appear" but "does
this corporation have a home to place one on".

### sandboxSession.ts #327 — The privates never paid
**Reported:** private companies do not pay their per-OR revenue to their owners.

`revenue_per_or` has been on `PrivateCompanyState` since the schema was written and every private card
has printed it — **as a property of the company, like its name.** No code path ever turned it into
money. So a player who paid $220 for the B&O watched a "$30 / OR" label sit on their card while their
cash never moved, **which quietly inverts the auction's whole economics: the expensive privates are
expensive precisely because they pay.**

### sandboxSession.ts #328 — Once per round, not once per corporation
**The subtle way to get this wrong is to pay on every Operating Round TURN.** An OR runs one turn per
floated corporation, so on a board with six floated companies the privates would pay six times a round
— **and the bug would look like generosity rather than an error**, which is the kind that survives
playtesting.

This function is therefore a pure "what does one round of private income look like", and the **caller**
owns the trigger. `App.tsx` fires it on the `current_round_type` transition **into** `OperatingRound`,
which happens exactly once per round by construction.

### sandboxSession.ts #329 — Who pays, and who is skipped
**The bank pays.** Private revenue is income from outside the game, not a transfer between players —
which matters because 1830 ends when the bank breaks, and privates paying out of nowhere would
postpone the end of the game indefinitely.

| Skipped | Why |
|---|---|
| **Unowned** | still in the auction. Nobody holds it; the money is not earned yet. |
| **Closed** | out of the game at Phase 5. Checked **before** `owner`, because a closed private can still carry its last owner's address and paying on it would be paying for a certificate that no longer exists. |
| **Corporate** | `owner_protocol_id` rather than `owner` — a private bought by a corporation pays that **corporation's** treasury. A real 1830 rule, modelled rather than skipped, because the phase-gated corporate purchase is already implemented and a private that stopped paying the moment it was sold to a company would make that feature look broken. |

### sandboxSession.ts #354 — The B&O private carries a presidency
**Reported:** the winner should immediately be credited the 20% B&O President's Certificate and
prompted to set its par value — without paying for the certificate — and the B&O should still not
float until 60% is sold.

Every surface has **described** this since the catalog was written and nothing performed it. So the
auction's most expensive private, the one a player pays $220 for precisely because it comes with a
company, delivered a revenue stream and nothing else.

| | |
|---|---|
| **Moves** | 20% out of the B&O's IPO into the winner's holding, and `president` to the winner. |
| **Does not** | any cash. The certificate is **granted**, not bought — charging par would bill the player twice for one private. |
| **Stays put** | `is_floated`. 1830 floats on 60% **sold**, and 20% is not 60%. No corporation floats during the Auction Round at all. |
| **Set now** | `par_value`, from the winner's own choice (`#399`). |

`#445`: this used to cite `StockRoundPanel`'s "Auto-floated by the B&O private" badge as evidence the
UI was ready for this position. **The badge named a rule 1830 does not have and has been removed**; the
reducer's behaviour here was always correct.

**A named function rather than sixty lines inline**, and that was not the first shape: the inline
version passed a whole suite of assertions that only ever read the source text, and **survived being
switched off entirely.** Anything worth this much comment is worth being callable on its own.

### sandboxSession.ts #399 — The prompt has to be a prompt
This used to read "par stays unset — the panel's ladder shows while par is null, which **is** the
prompt". Playtest says otherwise, and the reasoning was wrong in two ways that only show up in play:

- **Nobody is looking at the panel.** The B&O is won during the **auction**. The Stock Round panel with
  its ladder is a different round on a different tab, so "the ladder is the prompt" meant the prompt
  appeared minutes later, on a screen the player had to navigate to.
- **And the ladder stopped being visible.** `#396` hid every card's actions behind an active-card
  click, so the implicit prompt is now two clicks deep.

An unparred company with a president is also a **genuinely broken state** — `#387` withholds its market
token and its price, so the B&O would sit presided-over, priced at "--", and absent from the chart.
Taking the par **with** the grant means that state never exists. `parValue` is therefore required by
the function.

---

## Stock round reducer

### sandboxSession.ts #273 — It prices the trade, which is the point
Buy and sell used a flat `SANDBOX_NOMINAL_SHARE_PRICE` of $67 for every corporation regardless of where
its token sat — so PRR at $112 and NNH at $67 cost the same, **and the market chart was decoration next
to a price that ignored it.** The price now comes from the chart, which makes the chart load-bearing.

The market half of `#272`: `applySandboxAction` moves the shares and the cash, the market reducer moves
the token, **and the two are driven from the same dispatch so they cannot disagree about what a trade
cost.**

**What it does not decide:** certificate limits, the presidency, the 50%-of-a-company cap, which zone
permits what, and the end-of-round sold-out rise. It moves a marker down one row per block sold, **the
one market effect a single message fully determines.**

`#273` also fixed selling: the arm read only `protocol_id` and always moved one 10% block at the flat
nominal price, so a player selling 30% watched 10% leave their holding and banked a third of what they
asked for. **The message says how much, so honour it.**

### sandboxSession.ts (share movement) — The share has to actually move
Buying from the Bank Pool used to adjust cash and nothing else: the money left the wallet, the pool
percentage did not change, the holding never appeared, and the source button went on reporting the same
10% available. **Nothing errored — the buy simply had no visible effect, which reads as a dead button.**

Moving a percentage from a pool into a holding is **bookkeeping, not a rule**. **One certificate per
message, deliberately:** `ExecuteMsg::BuyStock` gained an optional `quantity` for the Brown zone's
atomic multi-buy, but this frontend's `GameplayExecuteMsg` never mirrored it and `StockRoundPanel` sends
N sequential single-share messages instead. Reading a field the UI does not send would model a purchase
shape that cannot occur here.

Sold shares go to the **bank pool**, never back to the IPO — that is what makes the Bank Pool source
reachable at all. Selling deliberately does **not** advance the seat: the real rule
(`trading.rs` module doc comment `#9`) is that a player may sell any number of blocks before the one
buy-or-pass that ends their turn. **This is turn pacing, not a game rule, so it is safe to model.**

### sandboxSession.ts #351 — The first IPO share is two shares
**Reported:** when floating an IPO the first purchaser picks a par value, but the UI records a 10%
share, does not mark them President, and leaves the par selector open for the next player.

**All three are one omission.** In 1830 the first certificate out of an IPO is the **President's
Certificate**: 20% of the company for twice the par price, and with it the presidency and the par price
itself, set once and never again. This arm moved a flat percentage and charged a flat price, so the
founding buy was indistinguishable from the fifth one.

The consequences compounded: with `president` never set the card kept offering the par ladder (it gates
on `par_value === null`), the ledger's certificate count was wrong by one, and `soldToPlayersPercent`
under-reported by 10% so **the 60% float threshold arrived a purchase late.**

`StockRoundPanel` has **priced** this correctly all along — its `#35` quotes "@ $134" for a $67 par — so
the panel was already telling the player something the reducer then did not do.

The presidency and the par price are written **together**: they are set by the same act, and writing one
without the other would leave the selector open on a company that already has a president.

### sandboxSession.ts #587 — Shares without a president is now a legal state
**Reported:** a player holding the PRR share the Camden & Amboy grants tried to buy the PRR's
president's certificate. They were asked to set a par and charged twice it — and received a 10% share,
no presidency and no recorded par.

The old test was `president === null && !anyHeld`, and `#36` defended the second clause: "a malformed
fixture with holders but no president degrades to an ordinary 10% share rather than handing out a second
President's Certificate."

**That was sound when the only way to hold shares was to buy them.** The C&A's purchase bonus (`#576`)
makes holders-without-a-president a **normal opening position**, and the conservative guard then refuses
the founding purchase to the one player most likely to make it.

**So the test is "has this corporation been started"**, which is what the rule is actually about — and
`par_value` is the field that answers it. Two fields that move together at the moment of founding, so
requiring both is a genuine safety net rather than a second opinion about stray holdings. **The UI
agreed with the old test**, which is why the prompt appeared and the charge was doubled while the grant
was not; both now ask the same question.

### sandboxSession.ts #596 — A sale moves the crown too
This direction is the one players forget: selling down below another holder hands **them** the
presidency whether or not that was the intention. Settled by the same function as the buy, so the two
cannot disagree about who leads. Selling also counts as trading for the Priority Deal (`#352`).

---

## The waterfall auction reducer

### sandboxSession.ts #261 — The auction had no reducer at all
**Reported:** none of the Auction phase buttons work.

They dispatched correctly and the game-state reducer even advanced the seat pointer. **What nothing
touched was the `WaterfallStateResponse`** — the shape the auction dashboard actually renders from. In
sandbox that came from a frozen hand-authored fixture recomputed only when the phase or game id
changed.

This is the missing half: a reducer over the auction's own response shape, with exactly the charter the
rest of the file has. It moves **pointers, counters and lists** and decides no rules. Specifically it
does **not** validate `auction::MIN_BID_INCREMENT`, decide when a mini-auction should *start*, enforce
that a player can afford a bid, or end the auction on N consecutive passes.

**The cash side is returned, not applied.** Player wallets live on `GameStateResponse` and the auction
lives on `WaterfallStateResponse` — two separate atoms. Rather than reach across (or have the caller
re-derive a price this function already knows), it returns the charge it implies. **One state change per
atom, both driven by one call.**

### sandboxSession.ts #271 — The auction has to reach its own screens
**Reported:** the Waterfall UI cannot be tested because the sandbox does not simulate bids or passes.

It simulated more than that suggests — buy, bid, pass and mini-auction raise/drop-out all had arms.
What it could not do was **reach a state where the interesting ones matter**, because three transitions
were missing and each was a dead end:

- **A mini-auction could be resolved but never opened.** Both mini-auction arms read
  `waterfall.mini_auction` and returned `unchanged` when it was null — which it always was, because
  nothing ever assigned one. **The most intricate screen in the auction was unreachable by
  construction.**
- **Passes counted up forever.** `consecutive_waterfall_passes` incremented and nothing read it.
- **The auction never ended.** `waterfall_auction_active` was seeded `true` and never written again.

**All three are pacing, not rules.** A sandbox that cannot reach a screen is not a conservative sandbox,
it is a broken one.

**A full round of passes marks the cheapest down $5** each time the table declines it, and a private
marked all the way down to $0 is taken by the next player rather than sitting at zero forever — which is
also the only thing that guarantees the loop terminates.

The auction closes in **one separate function** rather than in each arm that empties the list, so every
one of them gets the same ending: the last private can leave by outright purchase, by a resolved
mini-auction, or by an all-pass markdown to free.

### sandboxSession.ts #336 — The cascade, which was documented but never run
**Reported:** a player holds the only bid on the B&O at $225. Another player buys the private directly
below it. The waterfall then offers the B&O to the **next** player at its $220 face value.

**Which is worse than a missing feature — it offers the company to somebody else for $5 less than the
standing bid, so the bidder is punished for having bid.** Anyone who noticed would simply stop bidding.

**The rule was already written down**, in `WaterfallAuctionDashboard.tsx`'s own status-badge comment:
"0 bids leaves a private simply open, exactly 1 bid is what the next cascade run auto-resolves to that
sole bidder, 2+ bids is what starts a mini-auction." The UI has rendered an `isAutoAwardPending` badge
for that state since `#14`. **Nothing ever performed the resolution the badge promised.**

**It cascades**, hence the loop. Awarding the lone-bid private promotes the next one, which may itself
carry a single bid — a table that has been bidding for several rounds can settle three companies off one
purchase. A single `if` would have fixed the reported case and left the two-deep case wrong, **the
harder bug to find because it needs a longer game to reach.**

**Termination:** every iteration removes exactly one private from a finite list, and the loop stops on 0
bids (buyable) or 2+ (contested). The `privates.length` bound is belt-and-braces against a malformed
fixture whose `is_lowest_offered` never advances.

### sandboxSession.ts #334 — One action can sell several privates
A single `won` object was true while the only way to win a private was to buy it or outlast a contest.
`#336`'s cascade breaks that. **A list, in resolution order.** The alternative — report only the first
and let the others move silently — is the shape that produced `#303`'s vanishing cards.

### sandboxSession.ts #334a — Charges are a list, and not always the actor's
This was one optional `{ player, amount }`. `#336`'s cascade breaks both halves: one purchase can settle
several privates, and the auto-awarded ones are charged to the **lone bidder**, who is not the player
who acted. **The first attempt reused the payout array with a negative amount and a sentinel id, which
typechecked and would have been read as revenue by the first caller that summed it.**

### sandboxSession.ts #337 — The all-pass payout, reported not performed
When every player passes in succession, the cheapest private is marked down $5 **and** every private
already owned pays its revenue to its owner. The markdown was implemented (`#271`); the payout half was
not — **which removes the main reason a player is ever willing to sit and pass.**

**This file does not pay it.** The waterfall atom does not carry `private_companies` at all; the owner
roster, the revenue figures and the bank all live on the game state. Reporting the flag rather than the
payouts also means the credit runs through `applyPrivateRevenue` — the same function the OR uses
(`#327`) — so the two paths cannot drift on who counts as an owner or who funds it.

### sandboxSession.ts #544 — The contest has its own queue, and its own order
**Instructed:** "make sure the Mini-Auction turn order rotates only through eligible players in order of
lowest bid."

`openMiniAuction` used to build `bidders` in **seat** order and defended it: "a queue sorted by bid size
would rotate through the table in an order the room does not sit in." **That is true and it is not the
point.** A mini-auction is not a lap of the table — it is a contest among the two or three people who
bid, and the question it asks each of them is "you are behind, will you go higher?". **Asking the person
who is furthest behind first is what makes that question meaningful.**

**Fixed at opening, not re-sorted on every raise.** Re-sorting would move every player's position each
time anyone raised, so "next" would depend on an ordering that had just changed underneath it — a player
could be asked twice in a row, or skipped entirely, **with no bad line of code anywhere.**

**`nextSeat` could not do this job, and the way it failed is worth keeping.** On a drop-out the caller
passed the **shrunken** list plus the player who had just left it, so `indexOf` returned `-1`,
`(-1 + 1) % n` returned `0`, and the cursor silently jumped to the front of the queue every time. With an
ascending queue that lands on the lowest remaining bidder, **which is very nearly right — an accident
agreeing with the rule is the kind of thing that survives review and then breaks when the ordering
changes.**

Nobody is invited to outbid themselves: the next bidder skips `highBidder`, mirroring
`waterfall::skip_leader_turns`.

### sandboxSession.ts #302 — A raise is a bid, so it goes in the bid list
**Reported:** the mini-auction card shows the original bids rather than updating, and the player with the
**lowest** bid is marked as leader.

**Both symptoms, one cause.** A raise wrote only to `mini_auction.high_bid`/`high_bidder` and left
`priv.bids` holding the **opening** bids. The card renders `priv.bids`, so the amounts froze.

The leader badge then looked wrong for a reason worth separating out, **because the badge logic was
correct all along**: it marks whoever `high_bidder` names, and that **is** the leader. What was wrong was
the **number printed beside them** — their stale opening bid, which in a contest the other player opened
higher on is the smaller of the two. **A correct badge on a stale figure reads exactly like a badge on
the wrong player.**

One standing bid per player, so a raise **replaces** rather than stacking.

### sandboxSession.ts #313 — Dropping out refunds the bid, so the bid goes
**Reported:** a player who drops out of a mini-auction does not get their escrowed money back.

The card's tooltip has promised "your escrowed bid is refunded in full" since `#27`, and the contest
correctly removed them from `mini_auction.bidders` — **but their bid stayed in `privates[].bids`.** With
the escrow derived from that list (`auctionEscrow.ts #1`), the money stayed locked for the rest of the
auction: a player could drop out of every contest and end up unable to bid on anything, **with a full
balance on screen and no available cash behind it.**

Removing the bid is also what makes the **bid list honest**. It is the roster of who is still committed
to this company, and a name in it who has publicly walked away is telling the table something false —
`mini_auction.bidders` and `priv.bids` are two views of one contest and they have to shrink together.

### sandboxSession.ts #338 — A mini-auction does not consume a main turn
**Reported:** mini-auctions break the seating-order turn cursor — after one ends, the action bar and the
seating list highlight the wrong player.

The resolution line advanced the **main** rotation a second time. The main cursor has already moved by
the time a contest opens: whichever action exposed it advanced the seat as part of its own arm, because
that player used their turn. Everything inside the contest then moves `mini_auction.current_turn` and
only that.

So advancing again on resolution **skipped exactly one seat, every time**:

```
A bids on the cheapest      -> cursor B
B bids on it, contest opens -> cursor C
A drops out, B wins         -> cursor D   (C never acted)
```

The seating rail and the hotseat gate both read this field, **so they agreed with each other and both
pointed at the wrong seat** — which is why the report describes it as a display bug.

**Preserved, not recomputed.** `waterfall.current_turn` is already the seat that was next when the
contest began; the contest did not touch it, so resuming is simply leaving it alone.

---

## Route revenue

### sandboxSession.ts (route revenue) — A sum, not a pathfinder
This **totals** the printed value of the stops the player selected. It is arithmetic over data already on
screen, and it is deliberately not the beginning of a routing engine.

**What it does not do, and must not grow to do** — every one is `pathfinding.rs`'s:

- **Connectivity.** It never asks whether consecutive stops share track, or any track at all. Click two
  opposite corners of the board and it will happily add them up.
- The two-revenue-centre minimum, or train distance limits.
- Whether the corporation has a token on the route, or may pass through a blocked city.
- Which of a two-city hex's stations a `city_node` actually reaches.

So the figure answers "what are these stops worth", not "is this a legal route worth this much" — which
is why the result feeds `last_route_revenue`, a **display** field, rather than anything that gates an
action.

### sandboxSession.ts #190 — Every route was worth $0
This function used to price a hex from three tables it consulted itself. **That is a third
implementation of "what is this hex worth"** — `hexGeometry.hexRouteValue` is the one the board's own
value badges and hover tooltips already use — and it disagreed with the board in the two cases a player
is most likely to click:

1. **Preprinted gray hexes.** Lansing, Rochester, Richmond, Kingston, Atlantic City and Mansfield all
   carry printed track and a real city/town marker, and **none** is in `HEX_START_VALUE_OVERRIDE`. They
   fell through every branch and scored zero. Since preprinted track is the only track on a fresh board,
   almost every early route was a chain of $0 stops.
2. **Laid tiles with `revenue: "0"`.** `Number.isFinite(0)` is true, so a plain connector tile
   **returned** zero and short-circuited the printed value underneath it — upgrading a $30 city to a
   yellow tile made the city stop paying.

**Zero is now a fall-through at every tier instead of an answer**, because no revenue centre in 1830 is
worth nothing — a genuine zero means "this is plain track". Precedence mirrors `drawTileOverlays`': the
chain's `MapTileEntry` revenue, then the catalog mirror, then the per-hex printed override, then the
off-board terminal's era-scaled box.

### sandboxSession.ts #156 — A train counts revenue centres, not hexes
**This is the single most commonly misunderstood rule in 18xx, and this frontend had it wrong:** it
compared a train's number against `routePoints.length - 1`, the count of **hops**. So a 2-train appeared
to be limited to travelling two hexes.

The real rule — the one `pathfinding.rs` already implements — is that an N-train may visit up to N
**revenue centres**, and may cross any amount of plain track in between. A 2-train can legally run clear
across the board provided it stops at exactly two paying places.

The contract's own version, for comparison: it carries `max_revenue_centres`, increments
`route.revenue_centres` only when entering a hex whose `is_revenue_centre` is set, and marks that flag as
`!value.is_zero()`. The sandbox uses the same predicate over the same per-stop values, **which is why the
count and the revenue come out of one walk rather than two.**

### sandboxSession.ts #289 — A stop is what a hex *is*, not what it pays
**Reported:** a 2-train is allowed to run E23 → F24 → F22.

The report blamed F24 — Fall River, a preprinted gray town — on the theory that gray towns were not being
recognised. **Measured, F24 is fine:** it prices at $10 and counts. The hex that does not count is
**F22, a printed city that prices at $0**, so the route reported two stops for three revenue centres.

The cause was counting a centre when `value > 0`, which conflates two questions:

| | |
|---|---|
| **Is this a stop?** | A property of the hex — city, town, or red off-board terminal. Fixed by the board. |
| **What does it pay?** | A number, which varies by era, by tile laid, and which this build does not always know. |

**Fourteen of the board's printed cities and seven of its towns carry no value until a tile is laid on
them.** Every one was invisible to the capacity check while being perfectly visible as a route terminus
— `isRouteTerminusHex` has always asked the **archetype**. The two tests disagreed about the same hex,
and the capacity one was the lenient half. **A $0 city still costs the train a stop.**

### sandboxSession.ts #264 — A town is not a terminus
A route runs between two **cities** — or off-board red areas, which count as cities for this purpose.
Towns are passed **through**. The earlier check asked "does this hex pay anything", the right question
for **revenue** and the wrong one for **termination**, and towns are exactly where the two answers
differ.

`archetypeForHex` already draws the distinction the board draws — a white station circle versus a small
dark dit — across all four sources of track. **Off-board hexes are termini and are handled first**,
because `archetypeForHex` reports no city for them: a red area is a destination rather than a station.

### sandboxSession.ts #274 — Which stops paid, and how much each
**A total cannot be read back.** A player looking at "$90" over a nine-hex route has no way to tell
whether that is three cities at $30 or one city and a long walk — and the readout was printing every hex
it crossed, most of which contribute nothing, **so the one thing worth reading was buried in the one
thing that is not.**

The stops carry their own figures now, in route order, so the panel can render
`D6 ($30) → F8 ($20) → H10 ($40)` and the arithmetic is on screen rather than asserted. Deduplicated
exactly as `revenue` is — a hex pays once per pass — **so the list always sums to `revenue`.**

---

## Tile lay

### sandboxSession.ts #213 (map grid) — Two documents, two reducers
**Why this is not part of `applySandboxAction`.** The tile grid is not on `GameStateResponse` at all —
it is a separate query (`GetMapGrid`) with its own response shape, polled independently. Folding a
second, differently-shaped document into the game-state reducer would mean either widening that
reducer's type to something neither query returns, or returning a tuple every caller has to destructure.

**Why the whole `tiles` array is rebuilt.** `HexGridRenderer`'s draw effect lists `mapGrid` in its
dependency array. Pushing onto the existing array mutates it in place, the reference never changes, and
the canvas simply never repaints — the exact "I laid a tile and nothing happened" symptom.

**The entry is a real one, not a stub.** `paths` and `revenue` are read from the local `TILE_CATALOG`
mirror, the same data the contract serves from `hexmap::TILE_CATALOG`, so the drawn track splines and the
hex's printed value are genuinely right. **What is not checked is whether the placement is legal** —
upgrade topology, colour era, connectivity. A sandbox user can lay a tile the real game would refuse; the
picker labels its offering "Catalog tiles" rather than "Legal tiles" for exactly that reason.

### sandboxSession.ts (offer messages) — Unmodellable, not merely unmodelled
`AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer` address an offer by `offer_id`, and the
offer **register is not on `GameStateResponse` at all** — it is its own query (`GetTrainOffers`). A
reducer over the game state has no id to resolve, exactly as `applySandboxLayTile` cannot live in here
for the tile grid. So the sandbox keeps pending offers in `App`, and an accepted one settles by
dispatching `BuyTrainFromCorporation`.

### sandboxSession.ts (default arm) — Advancing the turn is the least surprising fallback
Reached by any `ExecuteMsg` variant added to the app without being considered here. It keeps the hotseat
loop alive, and **a turn that moves when it should not is far easier to notice than a control that
silently does nothing.**

---

## Fixtures — `sandboxState.ts`

### sandboxState.ts #0 — Why this exists, and what it is not
The sandbox passes `queryClient: undefined`, which makes every poll report "no chain" and return `null`.
Correct for the rail map — `HexGridRenderer` has its own local tile catalog — but it left the
phase-scoped panels with **literally nothing to render**: the auction only mounts when
`current_round_type === "WaterfallAuction"`, and with `gameState === null` that comparison is never true.

**This is not a simulation.** Nothing here advances, validates, or reacts. It is a set of frozen,
hand-authored snapshots chosen to exercise the interesting rendering branches — a president who is not
the viewer, a company that has floated and one that has not, a private with competing bids, a
mini-auction in progress. **Every value is a literal and there is not a single reducer in this file.**

### sandboxState.ts #1 — The rosters are mirrored, not invented
The six privates and eight corporations are taken from the contract's own canonical tables
(`auction.rs::CORE_PRIVATE_COMPANIES`, `public_company.rs::CORE_PUBLIC_COMPANIES`) including ids, names,
face values and revenues. **Inventing a plausible-looking roster would have been quicker and would have
made the sandbox actively misleading:** the whole point of these screens is to judge how *real* data lays
out.

Two places the contract differs from how the pieces are usually written, and the contract wins because it
is what the UI will actually receive:

- The New York, New Haven & Hartford is **`NNH`** on chain, not `NYNH`.
- Mohawk & Hudson's reserved hex is **F16** on chain.

⚠ **That second one is now a known divergence, not a naming note.** F16 is Scranton and Scranton is
**Delaware & Hudson's** reserved hex; M&H has no hex reservation in 1830 at all, only the NYC share
exchange. The frontend's display catalog was corrected in `WaterfallAuctionDashboard.tsx #312`. **The
contract still says F16 belongs to M&H, so this belongs on the `auction.rs` audit list**; nothing in the
frontend reads the reserved hex to make a decision, so the divergence is cosmetic until the contract
starts enforcing it.

The privates are listed in ascending face value — 20, 40, 70, 110, 160, 220 — which is both the physical
game's order and the strict waterfall order. `WaterfallStateResponse.privates` is documented as already
arriving sorted that way; **this mock preserves that guarantee rather than relying on it accidentally.**

### sandboxState.ts #5 — Holdings chosen to show every branch
Hand-authored per corporation to put every rendering branch on screen at once rather than to depict a
plausible mid-game position:

| Co. | State exercised |
|---|---|
| PRR | floated, Alice president on 60% — a clear controlling stake |
| NYC | floated, Bob president on 40% with Alice close behind on 30% |
| CPR | floated the **ordinary** way, at exactly the 60% threshold |
| B&O | **parred, president set, not floated** — Dave won the B&O private (`#8`) |
| C&O | **parred but unfloated**, no president yet — the case the Par/IPO track exists for |
| ERIE | floated on an **OO dual-city** home (`#4`) |
| NNH | floated, president tie broken by first-to-30%. Home G19 (New York) |
| B&M | floated, four-way split with a bare-majority president. Home E23 (Boston) |

Pool splits are **explicit, not derived**. They used to be computed as
`ipo = 100 - sold - (floated ? 10 : 0)` with `bank = floated ? 10 : 0`, which invented a 10% bank pool for
every floated company whether or not anyone had sold into it. **A formula that fabricates
plausible-looking numbers is worse than hand-authored ones here: it looks systematic, so nobody checks
it.**

`owned_trains` puts the room in **Phase 3 with one 3-train left in the depot** — chosen because that is
the state in which every branch is visible at once: the phase badge reads Green, depot stock of 1 makes
"Phase Shift Imminent" render, Phase 4's arrival rusts 2-trains so those chips render amber, and PRR
holds four trains against a Phase 3 limit of four so its capacity pill shows MAX. **It was briefly Phase
4. That looked reasonable and silently hid the chip colouring entirely**, because Phase 5's arrival
closes privates but rusts nothing, so `rustingTier` is correctly `null` there.

### sandboxState.ts #6 — Home hexes are the real ones, and an illegal state corrected
B&M was mocked onto G19 and NNH given no home at all. **G19 is New York, which is NNH's home and reserved
for it** — so the mock had one company squatting another's reserved hex while the rightful owner had
nowhere to put a token. Both labels are verified present in `STATIC_BOARD_HEXES`; `axialForLabel` would
return `null` and silently drop the token otherwise, **which is how the original error stayed invisible.**

`#6` also corrected an **illegal state**: the fixture had two players holding 10% each with
`president: null` — a position 1830 cannot reach. The President's Certificate is the **first** thing sold
out of an IPO; ordinary 10% shares only become buyable after it is gone. **So "shares held, no president"
is not a rare edge case, it is unreachable**, and the card correctly offered a President's Share that two
people had already bought around.

### sandboxState.ts #607 — The home hex is not the fixture's to invent
**Reported:** "C&O's home station/hex is on the Cleveland hex (F6) ... but when C&O floats the 'Place Home
Station' prompt takes you to the Richmond hex (K15) and then places the station there."

**The two facts came from two different tables.** The board draws its preprinted reservation markers from
`STATION_HOME_HEXES`, the mirror of `hexmap::CORPORATION_HOME_HEX`, and correctly says F6. This fixture
typed its own copy by hand, and C&O's copy said `"K15"` — Richmond, a dead-end stub that is nobody's home.
Everything downstream read the fixture, **so all three agreed with each other and all three were wrong.**

**Audited, as asked:** the other seven matched (PRR/H12, NYC/E19, CPR/A19, B&O/I15, ERIE/E11, NNH/G19,
B&M/E23). C&O was the only drift, **which is exactly what makes it the dangerous kind — a single wrong
entry in a column of seven right ones reads as verified.**

**So it is derived now, not corrected.** Fixing the string would have left two hand-maintained lists of the
same eight facts and a 1-in-8 chance the next edit reintroduced this. `homeHexFor` reads the same constant
the board draws from, and `sandboxHomeHex.test.ts` fails loudly if anyone types a literal back in.

### sandboxState.ts #8 — The B&O private does not auto-float the B&O
Winning the B&O private grants its owner the B&O's 20% President's Certificate and prompts them to choose
a par price. **That is all it does.** The corporation then floats on the ordinary 60%-sold condition.

This mock previously showed B&O as floated on 20% sold, and the UI grew an "auto-floated by the B&O
private" note to explain it. **Both were built on `auction.rs` setting `company.is_floated = true`
outright when the private is won — which is a contract bug, now on the audit list, not a rule.** The
frontend models the correct rule; the contract will be brought into line separately.

### sandboxState.ts #4 — Station tokens for floated companies
The sandbox previously sent `station_token_hexes: []` for everybody, which produced the reported symptom
exactly: the preprinted reservation markers correctly disappeared (the renderer hides those once a company
exists) and nothing replaced them, so home cities rendered bare. Coordinates are looked up from
`STATIC_BOARD_HEXES` rather than typed in, **so a mock token can never sit on a coordinate the board does
not have.**

⚠ **Erie and the dual-city choice.** Erie's home is an **OO hex** — two separate city circles on one tile
— so floating Erie really requires the president to choose **which** of the two slots the token goes in.
Nothing in this UI offers that choice, and `station_token_hexes` is a list of `(q, r)` pairs with no slot
index, **so the shape cannot express the answer even if the UI asked.** The mock places the token on the
hex and lets the renderer's slot allocator pick a circle. Implementing the real choice needs both a UI
affordance and a slot index in the contract's response — **an audit item, not something to fake here.**

Note: this board puts Erie's home at **E11** (Dunkirk & Buffalo), not E20 — there is no E20 in
`STATIC_BOARD_HEXES` at all.

### sandboxState.ts #7 — During the auction nothing is owned yet
That is what the auction is for, and an auction screen showing pre-owned privates would be nonsense.
Schuylkill Valley is already **sold** and the rest are still open, so the grid shows the greyed sold-out
card alongside live ones — **the only way to see that state before the round ends.** Afterwards they are
distributed round-robin so the ledger and the private-purchase tray have something to show.

### sandboxState.ts #176 — Five scenarios, one fixture
The sandbox was one board: a Phase 3, Green-era Operating Round. **A reasonable default and a poor
testbed**, because most of what there is to test is not reachable from it — the yellow and brown tile
catalogs, a Stock Round's controls and the auction's whole dashboard were each one hardcoded constant away.

**A scenario is deliberately not a separate hand-written board.** It is the one fixture plus a small
declared delta — which round type, which era, which train tier. Writing five independent fixtures would
mean five sets of presidencies, holdings and treasuries to keep internally consistent, **and the sandbox
has already been bitten twice by a fixture describing a board 1830 cannot reach** (an unfloated company in
the operating queue; two players holding shares with no president).

**The train tier is the era's real driver.** `derivePhase` reads the highest tier any corporation **owns**
— `current_global_era` is a separate field the contract also tracks, and the two must agree or the phase
badge and the tile filter will disagree. Each scenario therefore sets **both**, from one declaration.

### sandboxState.ts #9 — A fixture that shows every branch cannot show turn 1
**Reported:** the sandbox opens mid-game, so the rules that only apply at the **start** of a game cannot be
tested at all.

**That is a fair description of a deliberate choice**, and `#5` says so in as many words. A fixture built
to make every UI state visible is necessarily one in which nothing is still at zero. **The two purposes are
genuinely incompatible**, so `start` is a separate scenario rather than a rewrite of the others — and **it
is the default**, because opening on turn 1 is what a player expects from "sandbox".

Applied by **stripping** the rich fixture rather than authoring a second one:

- The **identities** stay right — tickers, home hexes, par ladder, private list, seating order. Those are
  1830 facts, not fixture choices, and a hand-written second copy would be a second place to drift.
- What is stripped is exactly what a **game** produces: ownership, float, cash, trains, tokens. **Turn 1 is
  defined by the absence of those, so removing them *is* the zero state** rather than an approximation.

**Player cash is the one thing set rather than cleared.** $0 would not be turn 1 — it would be a table that
cannot bid.

### sandboxState.ts #10 — The bank is what it started with, minus what it dealt
**Reported:** the zero state opens with the bank holding $8,460 when it should hold $9,600.

`virtual_bank_vgp: "8420"` is a **mid-game** figure, hand-authored to balance against the rich fixture.
`#9`'s zero state reset the players and treasuries and left the bank alone, **so the one number that is a
function of the other two kept its old value.** The result was a table where the money did not add up.

Both figures are now derived from one total: cash dealt is `TOTAL_DISTRIBUTED` split evenly across the
seats; the bank keeps the rest. Change the seat count and both move together, **and the sum stays $12,000
by construction rather than by somebody re-checking the arithmetic.**

**Note on the figure:** $2,400 split four ways is $600 each. Canonical 1830 deals by headcount — $400 each
at four players — **so this is this implementation's own flat distribution rather than the printed rule.**
Recorded because a future reader comparing against a rulebook will otherwise think it is a bug.

### sandboxState.ts (fleet cap) — At least two left in the depot
The first cut retiered every owned train to the scenario's tier, preserving the count. The fixture's
corporations own ten trains between them, and 1830's depot holds only six 2-trains, five 3s and three 5s —
**so every scenario opened with its own tier already sold out.** A "Phase 3" testbed whose first purchase
immediately triggers Phase 4 is not testing Phase 3.

### sandboxState.ts #246 — A fixture for the trade screen
**Reported:** the "Buy from Corporation" UI cannot be tested, because the sandbox starts with no
corporation owning a train.

**True, and it is the fleet cap doing it.** The cap hands trains out in queue order until the depot would
be emptied, which for a Green scenario is three trains — and the fixture's first corporation alone wants
four, so PRR takes all three and every other company opens with none. `TrainPurchasePanel`'s roster then
correctly lists nobody, so the accordion is empty.

**The cap is right and should stay.** What was missing is a way to ask for a **different** distribution.
`trainFixture: "spread"` gives the first two **floated** corporations a 2-train and a 3-train each — a
mixed fleet, so the trade panel's badges have more than one model. Unfloated companies are skipped: one
cannot operate, so a train in its roster would describe a board 1830 cannot reach.

**The fixture's trains count against the cap**, and this is the correction that makes the whole thing safe.
A first cut handed the spread fleets out and then ran the ordinary cap loop from zero for everybody else.
`depotInventory` derives remaining stock from what corporations **own**, so the two allocations stacked and
the five-train 3-depot came out at **zero** — precisely the state the cap exists to prevent. **Fixing one
panel by breaking the one beside it.** Seeding `handedOut` with the current-tier trains the fixture already
issued keeps **one budget** across both allocations.

### sandboxState.ts #169 — Only floated corporations operate
The operating order read `[1, 2, 8, 7, 3, 4]`, and 4 is B&O — `floated: false`, treasury `0`. An unfloated
company cannot take an OR turn, so its presence described a board 1830 cannot reach, and any consumer
walking the queue to its end would eventually hand the turn to a company with no money and no right to it.

The remaining six are exactly the `floated: true` entries in market-price order (PRR 112, B&M 90, NYC 82,
CPR 76, ERIE 76, NNH 67), **with ERIE and NNH placed by the fixture's own choice rather than derived, since
`calculate_operating_order`'s tie-break is the contract's.**

### sandboxState.ts #237 — The station allowance is per corporation
This was a flat `4` for all eight, which made the token row draw the same four circles for everybody —
including B&M and NNH, which get two. **A fixture that hands every company the largest allowance in the
game cannot exercise the case the row exists for** (a corporation running out), and it contradicts
`RulesReference.tsx`, which has carried the real table all along: PRR/NYC/CPR 4, B&O/C&O/ERIE 3, NNH/B&M 2
— home token included.

The depot totals are duplicated as a small literal rather than imported, to keep this fixture module free of
a dependency on the phase-derivation code it feeds — **and the harness asserts the resulting scenarios leave
real stock, which is the property that actually matters.** Same reasoning for the station allowance table
and the seat names: the seats are readable names rather than `juno1…` addresses because **a column of
truncated bech32 tells you nothing about whether the layout works.**

### sandboxState.ts (waterfall fixture) — Three card states at once
Composed to show the auction's three distinct card states simultaneously: Schuylkill Valley is
`is_lowest_offered` (the only one buyable at face value and the only one that can never be bid on),
Delaware & Hudson carries two competing bids, and Mohawk & Hudson is in an active **mini-auction**, which
replaces the normal action rail entirely. Returns `null` for any phase other than the auction, mirroring
`useWaterfallStatePolling`.

---

## The market atom

### sandboxState.ts #272 — The market is its own atom, because it is on chain
**Reported:** no action can be performed in the Stock Phase in the sandbox.

Buying and selling did work — cash moved, shares moved. **What did not move was the stock market, and on
the screen that is mostly stock market that reads as nothing happening at all.** `App.tsx` built its
`MarketGridResponse` from a `useMemo` over the static table, so the chart was frozen from first render by
construction.

**Why a separate atom rather than a field on `GameStateResponse`.** The obvious fix is to hang a price off
`PublicCompanyState` and let the one reducer move it. **That type is a mirror of `msg.rs`, and the contract
deliberately keeps the market in a different query (`GetMarketGrid`)** — so adding the field would make the
sandbox's state shape diverge from the one the live path receives, and every component reading it would be
reading something a real chain never sends. **The split is inconvenient here for exactly the reason it is
correct there.**

Three mocks, three shapes, matching the three queries.

### sandboxState.ts #2 — One price, two renderers
The corporation cards and the 2D chart are different components fed by different props, and in the sandbox
they were fed by different **tables**: the cards read `SANDBOX_MARKET_PRICES` while the chart read a
hand-written `MOCK_MARKET_GRID` literal in `App.tsx`. They disagreed immediately and in every way they
could — PRR read 112 on its card and sat on the chart's 100 cell, ERIE had no market price on its card
(correctly, being unfloated) while a token sat on the chart for it, and four of the eight were simply absent
from the chart.

**A mock whose two halves contradict each other is worse than no mock:** the screen it produces is one
nobody can learn anything from, and the first instinct on spotting it is to go hunting for a rendering bug
that does not exist.

`sandboxMarketPositions` derives the chart from the **same** `SANDBOX_CORPORATIONS` table the cards read.
`App.tsx` supplies the price→cell lookup rather than this module importing it, because `utils/` must not
depend on `components/`.

**Unfloated corporations are omitted, not placed at a default cell.** A company that has not floated has no
market position at all — its card shows a dash for exactly that reason — so putting a token on the chart for
it would contradict the card a second time, in the opposite direction. Same for a price the chart has no
cell for: skipped rather than parked at the origin.

### sandboxState.ts (mark shape) — The cell is carried, not re-derived
`marketCellForPrice` returns the **first** cell with a given price, and this chart repeats prices across
rows — so a token walked from $112 at (7,10) down to $90 at (7,8) would be re-rendered at (5,10), the first
$90 on the board. **The price would be right and the marker would have jumped two columns sideways, which
reads as a rendering bug and is the kind of thing that gets reported as one.**

The contract has the same property and solves it the same way: `GetMarketGrid` returns `(x, y)` because it
tracks the cell a marker has **actually walked to**.

### sandboxState.ts #646 — When this marker reached this cell
**Instructed:** "corporations on the same cell act in the order in which they reached the cell."

That rule is about **history**, and a price alone cannot answer it — two corporations sharing a cell are
indistinguishable by anything the chart currently records. On a physical board the answer is visible because
the tokens are a stack; here it has to be written down.

**A sequence, not a clock.** Wall time would work and would be wrong under replay: a rebuilt room re-applies
the whole log in one burst, so every arrival would share a timestamp. This is an **ordinal derived from the
marks already on the chart**, so it is a pure function of state and lands identically however many times the
log is replayed — **the same property `#642` had to restore for the round machine.**

**Stamped only when the cell changes.** A marker that lands where it already stood has not re-entered
anything, and re-stamping would send a corporation to the back of its own tie for standing still.

### sandboxState.ts #401 — The mark is the position
**Reported:** when a company is parred its token appears only on the IPO/Par tray, not on the matrix.

`corp.floated` used to gate this, **read from the static fixture table** — so a corporation parred during
play could never gain a position no matter what the live state said. The tray reads `par_value` off the game
document and showed the company; the chart read a constant from a mid-game fixture and did not.

**The mark alone is the right test, because a mark IS a position:** it carries the cell the token stands on.
A company with no mark has no position, which is exactly `#387`'s rule. **Consulting a second, older source
for the same fact was the bug.**

### sandboxState.ts #415 — The resolver is the par box, not the price grid
**Reported:** parred corporations land on incorrect market cells.

This took `marketCellForPrice`, which returns the **first** cell carrying a given price. **Every par value
also appears in the chart's top row, and that row is searched first** — so parring at $67 put the token at
(1, 10) instead of the par box at (6, 5), and only $100 happened to agree.

The parameter is now `parCellFor` and the caller injects `StockMarketRenderer.parBoxCellFor`. **Renamed
rather than merely repointed:** the old name described a lookup whose semantics were exactly the bug, and a
future caller handed "a function from price to cell" would reasonably supply the wrong one again.

At seed time both resolvers are supplied and a comparison picks: **still at par → the par box; moved → the
price grid.** The par box is tried **first and only when the two prices agree**, so a corporation that has
walked to a price that merely happens to equal some other company's par is not yanked into a box it never
stood in. CPR is the case that exposed this (`par: 76, market: 76`), opening two rows and three columns away
from its own box.

### sandboxState.ts #387 — The Zero State has no market at all
**Reported:** unparred corporations show market values and render tokens in the Zero State.

The seed function read `SANDBOX_CORPORATIONS`, the mid-game fixture, **with no idea which scenario was being
loaded** — so "Game Start" reset the companies and then handed the chart a full set of mid-game prices
anyway. **The two halves of one scenario disagreed because only one of them was told which scenario it was.**

**A corporation has a market price when it has a PAR**, because parring is what puts the token on the board.
Passing the flag rather than reading a module-level scenario keeps this a pure function of its arguments,
which is what the harness needs to test both branches.

`placeParMark` **returns the same object when there is nothing to do** — an unknown price, an unmappable
cell, or a company that already has a mark. Already having one matters: **a token that has walked up the
chart must not be dragged back to par because something re-read the par value.**
