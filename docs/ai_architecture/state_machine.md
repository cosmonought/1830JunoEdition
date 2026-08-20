# State Machine — Rounds, Turn Cursor, Sub-Phases

Round types, the Operating Round sub-phase cursor, turn gating, automatic actions, float
events, home station prompts, and undo/revert semantics.

Anchors are `<source file> #<N>`. Search the number.

---

## Operating Round sub-phase cursor

### App.tsx #10 — Step-by-step action sub-phases
An OR turn walks the legal 1830 chronological order: **Track → Tokens → Dividends → Hardware**
(later extended with `BuyPrivate` and `Routes`). Client-side UI sequencing only. Reset to the
first step by a `useEffect` keyed on `active_corporation_index` / `current_round_type`, so a new
corporation's turn — or leaving the OR — restarts the sequence.

Per-step controls: Track offers "Skip Track Lay" (an actual lay is the canvas-click flow);
Tokens offers the station-token mode toggle plus "Skip Tokens"; Dividends offers Run Trains plus
explicit **Pay Dividends** / **Withhold Revenue** (the same `DeclareDividends` message differing
only in `distribute`); Hardware offers the depot tray, "Buy Train" and "End Turn" (`PassTurn`,
which `msg.rs` documents as also advancing an OR to the next corporation).

### App.tsx #144 — Skipping is a dispatch, not a local setState
Three client-only skip handlers used to call `setOrSubPhase` directly, moving the UI while the
contract's cursor stayed put. Under G-14 enforcement that desyncs the bar from what the chain
will accept, and the player's next action is rejected with `WrongOperatingSubPhase` for reasons
the UI has just made invisible. One real `AdvanceOperatingSubPhase` dispatch replaces all three.
No optimistic local advance: the bar moves when the chain says it did.

### App.tsx #179 — Advance has to move something
Dispatching `AdvanceOperatingSubPhase` and stopping is correct online (the contract owns the
cursor, the next poll reports it) and does nothing in sandbox, where the sub-phase is
client-side state deliberately absent from `GameStateResponse`. The cursor's owner moves it.
`OPERATING_SUB_PHASE_ORDER` is the sequence the stepper renders and `visibleSubPhases` drops
`BuyPrivate` before Phase 3, so advancing walks steps the player can actually see.

### App.tsx #142 — Routes → Dividends advances on run
Optimistic, matching the file's convention of not gating local UI sequencing on a chain
round-trip. Necessary rather than cosmetic: running trains produces the figure the Dividends
step decides about.

### App.tsx #656 — The cursor is read, not held
**Reported:** the game stayed in OR 1.1 and returned to C&O's turn starting at step 3; it should
not have looped at all.

The cursor was `useState`, seeded by `initialOrSubPhase` and re-seeded by an effect whose
dependency array named `current_global_era`, `currentPhase.known`, `currentPhase.tier` and
`private_companies`. Buying a 3-train changes the era **during** the Buy Trains step, so the
effect fired with the corporation unchanged and reset the cursor to the first visible step —
`Track` when Buy Private is hidden, `BuyPrivate` when it is not, which is why the reported step
differed between games. **A `useEffect` watches conditions; opening a turn is an event.**

The sandbox reducer raises that event now (`settleOperatingCursor`), so
`gameState.operating_sub_phase` is the answer. The local state survives because a **live** room's
cursor belongs to the contract: `or_phase` persists it, `WrongOperatingSubPhase` rejects a client
that disagrees, and `GetGameState` does not currently report it — so until it does, a live room
has nothing to read and this is what the bar follows.

The guard reads the **field**, not a `sandbox` flag: a mode flag is a claim about which code path
is live; the field's presence is that code path having run. (Same lesson as `#601`.)

### App.tsx #175 — The sandbox opens on Track  *[superseded by #574, resolved by #578]*
Not an address mismatch: `initialOrSubPhase` returns `BuyPrivate` from Phase 3 on (mirroring
`or_phase::initial_sub_phase`), the fixture runs in the Green era, and confirming a tile lay
requires `Track`. Correct for a live room, wrong for a testbed whose purpose is reaching the
board quickly. Only the default changed — the stepper could still walk back.

### App.tsx #385 — Never open on a step that is not there
`initialOrSubPhase` returns `BuyPrivate` from Phase 3, but the strip drops that step once nothing
is buyable — so seeding the cursor there puts the turn on a hidden step, which reads as an empty
action panel with no way forward but Skip. `visibleSubPhases` is asked rather than re-deriving the
condition, so cursor and strip cannot disagree about which steps exist.

### App.tsx #574 — The testing shortcut outlived the testing  *[resolved by #578]*
`sandbox ? "Track" : initialOrSubPhase(...)` was right for a solo testing session. Once the
sandbox became the multiplayer mode, skipping the opening step stopped being a convenience and
became a rule not applied: `BuyPrivate` is where a corporation may buy a private from a player,
and a step the game silently walks past is a trade nobody gets to make.

---

## Automatic actions

### App.tsx #249 — A step with nothing in it should not be a click
**Reported:** a corporation with no trains has to skip Run Routes and Dividends by hand.

Every OR turn walks the same six steps and for many corporations three are foregone conclusions.
**Not hidden, skipped:** the contract's cursor still walks them (`or_phase::OR_PHASE_ORDER` is
fixed) and a client that jumped its display past a step the chain sits on would desync (`#144`).
So the skip still happens — it happens without asking.

Firing once is the whole difficulty. Online, `handleSkipSubPhase` does not move `orSubPhase`
locally (poll-driven), so a naive effect re-fires every render and broadcasts a transaction each
time. A ref records which `(corporation, step)` pairs have been auto-skipped. **Keyed on the
corporation too**, not just the step — the next company reaches the same step needing its own
decision.

### App.tsx #653 — A once-per-game guard on a once-per-turn event
**Reported:** "C&O has no legal routes despite owning trains, but this Run Routes action has no
Skip button, so the game is now bricked."

`autoSkippedRef` keyed on `${actingProtocolId}:${orSubPhase}` and `forcedWithholdRef` on
`${actingProtocolId}:withhold`. **Neither key says WHEN.** Both Sets are cleared only by a full
sandbox rebuild, so the first time C&O auto-skips Routes the pair `3:Routes` is remembered for the
rest of the game — and every later turn with no route hits a step that will not skip itself and
offers no button that would.

What the guard is actually for is a re-entrancy window a few milliseconds wide: `autoSkipReason`
is derived, so it stays truthy for the render between dispatching the skip and the cursor moving
off the step. That is a **within-turn** problem and the key was scoped to the whole game.

The key gains the turn: `macro_round_number`, `sub_round_index` and `active_corporation_index`
together name one corporation's one turn. Read off game state rather than counted locally, so a
replay rebuilds the same key (the lesson of `#642`). Construction lives in `utils/turnGuardKey.ts`
with tests.

This unbricks the turn; it does not stop a corporation revisiting a step it already left, which is
the separate `orSubPhase`-outside-the-reducer defect.

### App.tsx #439 — Two entry points, one implementation
The skip is dispatched both by the player (Skip button) and by the game (auto-skip effect), and
Undo must tell them apart. A single function taking `automatic = false` would be wrong in the
dangerous direction: `onClick={onSkipSubPhase}` hands React's `MouseEvent` in as the first
argument, and a truthy event marks every **manual** skip as automatic — so Undo would walk past
the player's own choices. Two named callbacks make the caller state which it is.

### App.tsx #475 — An automatic action leaves no trace
**Reported:** Undo reverts entire turns, and can revert the previous player's.

`#439` pushed a snapshot for every dispatch and taught Undo to walk past automatic ones. The walk
is what crossed turn boundaries: a corporation whose turn opens with three auto-skips has three
automatic entries stacked on the previous player's `PassTurn`, and one press walked down to it.

**Not pushing is the simpler and stricter answer.** The stack then holds only decisions the player
made. An automatic action is the sub-phase auto-skip and the forced $0 withhold, and nothing else
— both are the game acting on a rule with no decision in it, and both **re-derive** when the state
they followed from is restored, so nothing is lost by not recording them.

### App.tsx #292 — A trainless dividend is decided, not skipped
Dividends used to share the Routes reason and take the same exit (`AdvanceOperatingSubPhase`,
which moves the cursor and settles nothing). 1830 has no third option: revenue of $0 is still
revenue declared, and withholding it is what a trainless corporation does — which is the decision
that steps the marker **left**. `#44` says why that matters: "every corporation moves left on its
first turn, because it has no train yet and so cannot pay out." Skipping meant it did not move at
all, so the tutorial explained a market lesson the board had not taught.

Guarded the same once-per-`(corporation, step)` way as the auto-skip, for the same poll-driven
reason.

### App.tsx #414 — A train is not the same thing as a route
**Reported:** a corporation holding a train with no legal route — or with routes totalling $0 —
is still walked through Run Routes and offered "Pay Dividends" on $0.

`#292` gated everything on `ownsAnyTrain`, the cheap half of the question. A corporation whose
token sits on a city no track reaches owns a train and can earn nothing with it. It passed every
guard, arrived at Dividends with a live Pay button quoting "$0 per share", and could pay a
dividend of nothing — not a legal 1830 declaration, and it left the share price standing still
where the rules move it left.

**The probe is the drafter, not a second opinion.** `assignRouteSet` is the same search Auto Route
runs (`#280`), asked for the same thing and read for its total. A cheaper "can this corporation
reach anything" check would be a second pathfinder to keep in step.

Scoped to Routes and Dividends during an OR, and only for a corporation that owns a train at all.
Everywhere else `null` — "not asked" — which readers distinguish from a real `0`. **`null` also
means "could not tell"**: no tokens on the board, or a board that has not loaded. The consequence
of a wrong zero here is an automatic, irreversible withhold on a corporation that could have paid.

Refinement: a corporation the chain **has** reported whose token list is an empty array has
nowhere for a route to start — that is the answer, not ignorance. A corporation *absent* from the
response stays `null`.

### App.tsx #484 — "It skipped Routes" is a fact three places need
**Reported:** a corporation that cannot run is still walked through Run Routes and Dividends, and
Dividends still offers Skip at $0.

`routesRunThisTurn` existed with exactly one reader. Everything else re-asked a *different*
question (`noEarnableRevenue`, which probes the pathfinder) and the two disagree in the gap that
produced the symptom: `maxRouteRevenue` returns `null` for a corporation with a train and no token
on the board, `null` is not `0`, so the forced-withhold effect declined to fire. Hoisted so the
three consumers share one answer.

### App.tsx #484b — Skipping Routes settles Dividends
`noEarnableRevenue` is a **prediction** (it asks the pathfinder). Having skipped Routes is an
**observation** — the step is behind this corporation and it ran nothing. The observation has to
be enough on its own, because the prediction declines to answer in exactly the reported case.
Manual skips count too: a player who declines a route they could have run has still run nothing,
and the market move is not theirs to waive.

### App.tsx #484c — A skipped turn declares zero, not last turn's
The forced withhold read `last_route_revenue` unconditionally. That field is the corporation's
**last** run, which for a corporation that skipped Routes is a previous turn's figure — so the
forced $0 withhold could dispatch `DeclareDividends` for a stale positive amount and move real
money into the treasury for a run that did not happen. `#278` had already identified the field as
unreliable and used the observation to hide the **Pay** button; it never reached the amount.

### App.tsx #278 — Did this corporation actually run this turn?
`last_route_revenue` reads as "what it earned last time" — written on every run, zeroed only by a
run that found no route. A corporation that banked $180 in OR1 and skips Routes in OR2 still
reports $180. So the turn's own history is observed: `true` once routes are declared, `false` once
Routes is skipped, discarded when the acting corporation changes.

**`null` means unknown, and unknown enforces.** A page reload mid-turn leaves no observation, and
the two mistakes are not equal — wrongly hiding Skip strands a player on a step; wrongly showing
it destroys money already earned.

### App.tsx #438 — Why this corporation cannot place a station
`null` when it can. The three blocking conditions are checked in the order a player would discover
them — do I have a token, can I pay for it, is there anywhere to put it — so the reason reported
is the first that actually stops them.

The topological check reuses `placeableStationHexes`, the same set the targeting veil lights
(`#240`). A cheaper "does the network touch any city" would disagree with the veil about
reservations, occupied slots and OO tiles. Scoped to the Tokens step of an OR because it walks
every board hex. Rule itself lives in `utils/stationTokens.ts`, beside `placeableStationHexes` and
`evaluateStationPlacement` — a station-legality predicate in the shell would be the fourth opinion
on that question across three files.

Three reasons are reported **separately**, because they call for different responses: running out
of tokens is permanent, being short of cash is fixable next turn, and having no reachable slot is
a fact about the map a tile lay might change.

---

## Turn identity and gating

### App.tsx #169 — Act as the corporation whose turn it is
Every OR action targeted `MOCK_LAY_TILE_PROTOCOL_ID` — a hardcoded `4` (B&O) chosen before there
was a turn queue. The fixture opens its OR on `active_operating_order[0]`, protocol 1 (PRR). So
the UI acted as B&O while the turn belonged to PRR: on chain that is `NotYourOperatingTurn`; in
sandbox it charged B&O's treasury, which is `0` because B&O is unfloated. The Buy Private sheet
read the same empty treasury.

The presidencies were never missing — the wrong identity was the **corporation's**, not the
player's. Now derived from the queue, with the old constant as the fallback for a room whose OR
has not started (empty `active_operating_order`).

### App.tsx #228 — The acting corporation, resolved once
**Stations left** is `station_token_limit` minus tokens already on the board — the limit alone
answers a question nobody asks. Floored at zero: a chain reporting more placed tokens than the
limit is a contract bug, and rendering "-1 stations" would report it as a UI one.

### App.tsx #544 — `actingAddress`, not `actingSeatIndex`
A mini-auction suspends the main rotation, and this is the gate `runGameplayAction` reads — so
resolving it from the stale waterfall pointer is what let the wrong player act and locked out the
one actually on turn.

### App.tsx (F-5) — Turn notification must be round-type aware
`wallet.address === activePlayerAddress` is right for a Stock Round and wrong for every Operating
Round. `activePlayerAddress` is `player_addresses[active_player_index]` — the **SR** turn pointer.
During an OR the acting entity is not a player: it is the corporation at
`active_operating_order[active_corporation_index]`, and the authorised human is its `president`.
The backend gates `LayTile` / `BuyHardwareFromPool` / `DeclareDividends` / `EndOperatingRoundTurn`
on exactly that. The consequence was an **inverted** alert for roughly half of game time. Every
field needed is already on the polled `GameStateResponse`.

The phase-dependent logic lives in `actingSeatIndex` (`utils/gameState.ts`) because the sandbox
needs the same answer to a slightly different question — "which seat may act" rather than "may I
act". `null` means no seat may act at all (an OR with an empty queue, or a floated but
presidentless corporation) — nobody's turn rather than everybody's, which is why there is
deliberately no fallback to the SR pointer.

### App.tsx #625 — The turn arriving is an event, not a notification
**Reported:** when the turn passes between corporations, a player already using the tile selector
has to click around several times to reach the correct Lay Track display.

`#213`'s tab effect fires on a `current_round_type` transition, and a corporation handover inside
an OR is not one. The sub-phase reset fires on `active_corporation_index`, so the **step** was
right; nothing touched the **screen** or the open picker. The worst combination: every control
correct and none on screen.

The browsing state is the part that has to go — an open ring belongs to whatever the player was
studying, very likely an unreachable hex, and since `#620` a ring whose candidate list is about to
narrow under them. **Only for the player whose turn it now is**; everyone else is browsing on
purpose. **Once per handover**, tracked against the previous acting corporation rather than keyed
on it, so a player who deliberately clicks to the Ledger mid-turn can stay there. No sub-phase
write here — the effect above owns `orSubPhase` and already reseats it on this exact change.

### App.tsx #536 — A room is not a hotseat
**Reported:** the local browser can act on anybody's turn.

The gate is at the **dispatch**, matching `#23`'s argument for read-only mode: a dozen surfaces can
dispatch, and gating each one is a dozen chances to miss one.

- **`automatic` is exempt, deliberately.** The auto-skip and forced $0 withhold are the game
  acting on a rule with no decision in it (`#475`) and fire on whoever's turn it is, including the
  moment a turn passes. Blocking them would strand a room on a step nobody can leave.
- **Replay is exempt** for the obvious reason: a replayed action already happened, on its own
  author's turn. Re-checking would mean every client refusing every action but its own.

*(Simplified by `#578`: every sandbox session is a room, so the room check is gone and the gate
simply applies.)*

---

## Tabs and phase navigation

### App.tsx #213 — Auto-navigation fires on transitions only
Fires **only** on a genuine `current_round_type` transition (compared against `prevRoundTypeRef`,
not merely keyed on the value) so it never re-fires — and never overrides a manual tab click — on
every unchanged poll re-render. `WaterfallAuction` and `StockRound` switch to the consolidated
"Stock & Auction" tab; `OperatingRound` switches back to "Rail Map". `MainTabBar`'s own click
handling is untouched.

The redirect asks `surfaceTabFor` for **the round's own surface** rather than a hardcoded `"map"`.
This effect and the transition effect both run in the commit where the round type changes, and
this one still sees the tab the player was on — so a constant here silently overrode that choice.

### App.tsx #28 — The tab set changes shape by phase
The active tab can cease to exist under the player: sitting on "Auction" when the auction ends
leaves `activeMainTab` pointing at a tab no longer in the bar, which renders nothing. Deliberately
separate from the auto-navigation effect, which fires only on transitions and never overrides a
manual click — this is a correctness guard that must run whenever the pairing is invalid.

---

## Float and home stations

### App.tsx #400 — A float is an event, not just a flag
**Reported:** when a company like ERIE floats, the UI skips home token placement with no feedback.

It did happen — `applyFloatThreshold` sets `is_floated`, credits ten times par, and pushes the
home hex onto `station_token_hexes` (`#363`). All of it silently. The one placement in the game
the player does not perform read as a placement that did not occur.

**The rules fix the destination**, so this is not made into a choice; what was missing is the
report. **Diffed in the shell rather than reported by the reducer** (`#337`'s reason: the reducer
holds the game document, the shell owns the log; threading an event list out of `applySandboxAction`
would put a logging concern into a pure function's return type). Naming the **hex** is the point:
"ERIE floated and placed its home token on E11" is the same state change plus the thing the player
would otherwise go looking for.

### App.tsx #416 — Who still owes a home station
Derived from the board every render rather than latched when the float happens. `pendingHomeTokens`
asks "is this floated corporation's printed home hex empty", which stays true until answered — so
a reload, a late poll, or two corporations floating on one dispatch all resolve correctly, and a
prompt cannot be lost.

**Only the head of the queue** is prompted; several can float at once (a waterfall cascade, or a
multi-buy crossing two thresholds) and they are returned in operating order.

**Naturally inert against a live chain**, worth stating because it looks like a gap: the contract's
`grant_home_station_token` places the token as part of floating, so the hex is already occupied by
the time any state reaches this line. This prompt governs the sandbox — the only place the frontend
owns the placement.

The answer is **free**: it deliberately does not dispatch `PlaceStationToken`, which charges the
escalating token price (`#239`). A home station costs nothing, and routing it through the paid
message would bill a corporation for the one token 1830 gives it.

### App.tsx #440 — The president's prompt, not everyone's
**Reported:** the home station prompt fires for all players.

`pendingHomeTokens` answers "which corporation owes a token" — a fact about the **board**, true for
every viewer at once. A blocking modal with no dismissal appeared on four screens, three belonging
to players with no right to answer, locking them out of the game. The presidency is already carried
on the pending entry, so the gate is a comparison rather than new plumbing.

A corporation with **no president on record** prompts nobody — reachable through the B&O private
before its par is set, and a modal nobody can answer is the same lockout in a different costume.

`#440` also made the placement happen **on the map**: the prompt records where the player was,
sends them to the Rail Map with the board veiled to one hex and the station cursor live, and waits
for the click. The **return tab is captured rather than assumed** — a float can happen during a
Stock Round (a purchase crosses 60%) or in the auction (the B&O private), so "back" is not a
constant.

### App.tsx #455 — The float does not wait for a turn  *[hotseat mechanics removed by #578]*
**Reported:** the prompt waits until it is the president's active turn.

`#440`'s gate was not the cause — comparing against `viewerAddress` is correct online, where that
value is the connected wallet and does not move. In hotseat it moved: `viewerAddress` derived from
`sandboxSeatIndex`, and Auto-Follow walked that pointer to whoever was acting. A float is **not a
turn action** — it is a threshold crossing caused by whoever bought the 60th percent, frequently
not the president, and 1830 resolves it immediately.

### App.tsx #460 — The seat sync has to land first
**Reported:** the modal pops up for the player who bought the floating share rather than the
president.

`#455` over-corrected. Its `hotseatSeat` escape hatch rendered the modal for whoever was seated the
moment a corporation floated — true of a turn, false of this instant. Both notes wanted the same
thing: fire **immediately** and fire **for the president**, which are compatible. The test is strict
identity in every mode; one render's delay while the seat syncs is the entire cost.

---

## Undo and revert

### App.tsx #178 — Undo is a snapshot stack, and only in sandbox  *[deleted by #591f]*
`sandboxSession.ts` refused to model undo, correctly for where it was written: undo is a full
replay of the contract's event log and a reducer cannot undo itself — it sees one message and the
state it produces, never the state it replaced. But the **owner** of the state can: pushing the
outgoing state onto a stack before replacing it gives exact, unlimited, single-step undo with no
inverse operation per message type. Sandbox only, because on chain the contract owns history and
restoring a local snapshot would desync. The map grid rides along, since a tile lay changes both.

### App.tsx #310 — The snapshot has to cover every atom an action moves
**Reported:** undo during the Auction breaks the turn cursor — the bottom panel says it is one
player's turn while the hotseat gate thinks it is another's.

The snapshot held `state`, `mapGrid` and `subPhase`; the sandbox keeps its game state in **four**
atoms. `sandboxWaterfall` owns `current_turn`, `mini_auction.current_turn` and
`mini_auction.bidders`; `sandboxMarket` owns token positions; `settledPrivatePrices` owns what each
private sold for. None were captured, so undo restored `active_player_index` and left
`waterfall.current_turn` where the undone action had put it — the two pointers are supposed to be
the same fact.

**The fix is the shape, not a patch:** the snapshot carries every piece of state the dispatch path
writes. **Rule to keep: if `runGameplayAction` can change it, this record holds it.** (That per-atom
restore list survives inside `rebuildSandbox`, where the replay needs exactly the same list.)

### App.tsx #591f — The snapshot stack is deleted
`#178` built it and `#310`/`#439`/`#475`/`#479` refined it over five passes, every refinement
correct for a single client. None survives contact with a room: the stack holds only what **this**
browser dispatched, so it can neither undo somebody else's action nor be trusted to agree with
anybody about what happened. Deleted, not left switchable — a second undo mechanism that works in a
mode that no longer exists is a trap.

### App.tsx #591d — Undo appends, it does not pop
**Reported:** Undo in the stock round prints "Nothing to undo", so an accidental share purchase
cannot be taken back.

Every client held a different stack, which is why the button reported an empty one. Undo now
appends `RevertTo` to the log, every client drops the reverted range and replays from the fixture,
and the table undoes together. History arithmetic is in `utils/logRevert.ts`; `#592` decides who
may reach how far.

**Not `automatic`, and not turn-gated:** undoing is not a move in the round, and the player who
needs it most is the one whose turn has just passed. `undoReachFor` gates on **authorship**.

### App.tsx #591e — The undo button names the kind, not the sentence
Re-running `describeGameplayAction` to quote the log's own sentence reads beautifully and cannot be
built at this moment: the describer needs the map, the era and the board **as they were**, and by
the time Undo is pressed the board has moved on. So it names the kind — "the last share purchase" —
which is short, always true, and enough. A table maps message keys to English because
`RunManualRoute` and `AdvanceOperatingSubPhase` are message names; an unmapped message falls back to
the key, ugly and unmistakably a fallback.

### App.tsx #592 / App.tsx #592d — The button and the dispatch ask one function
`#592` is the umbrella rule for **who may reach how far**: undo is gated on authorship, and the
host alone may reach back past a round boundary.

`undoReachFor` decides both whether the button is live and what happens when it is pressed. A
separate `canUndo` boolean beside it would be a second opinion about the same question — this
codebase's recurring bug (`#559`, `#576`, `#580`, `#587`). Read-only is folded in here rather than
left as a second condition, so the control has one reason to be disabled and it is always the true
one.

### App.tsx #592a — Where the round started
The log index of the last action that **opened** a round (`SetupGame` or `OpenStockRound`), so the
host's deeper undo knows how far "the start of the round" is. Derived from the log rather than
counted as rounds pass, for `#565`'s reason: a derived value cannot be stale, cannot drift after a
refresh, and cannot survive an undo that took the round boundary itself back.

### App.tsx #592c — `handleUndoToRoundStart` is gone
One Undo, pressed as many times as needed. `undoToRoundStart` stays exported and tested because
"how far back is the round boundary" is a real question, but nothing calls it today — and a handler
wired to no control is a control somebody will assume exists.

### App.tsx #591 — A revert is an instruction about the log
`effectiveActions` strips it before the drain sees it. If one arrives anyway the honest response is
to do nothing: it has already been honoured by the history arithmetic, and applying it a second
time as if it were a move would be inventing a rule.

---

## Round transitions and logging

### App.tsx #642 — The shell reports, it does not decide
Two blocks used to sit here: one saw `stock_round_just_ended` and built the OR, the other saw
`operating_round_just_ended` and closed the cycle, incrementing `macro_round_number`. Both did the
reducer's job in the shell and both were skipped by every replay. `settleRoundTransitions` performs
the transition now; what is left here is what a transition should **cause** — a line in the log.

**Detected by comparing state, not by reading a flag.** The flags are consumed inside the reducer;
more importantly a before/after comparison is a fact about the game, so it means the same thing on
a replay as on a live dispatch. A flag is a message to whoever reads it first.

**Silent on a replay**, or a rebuilding client re-announces every round change the game ever had.
**No tab navigation either** — `#213`'s effect already watches `current_round_type`, and doing it
here as well would yank the tab once per replayed round.

### App.tsx #343 — The round, as a short tag
Formats: `Auction`, `SR1`, `OR 1.1`. The auction case is shortened from "Waterfall Auction" because
this is a prefix in a gutter, not a heading. Read through a ref by the log writers so the stamp is
taken at **write** time rather than closed over at callback-construction time — an entry written
during the auction must keep `[Auction]` even though the callback was built rounds earlier.

### App.tsx #643 — The round label is a function of a state
Lifted out of the memo (into `utils/roundLabel.ts`, `#659`) so a log writer can ask it about the
state an action **resolved to** rather than the state the browser is currently rendering. Those are
the same during live play and completely different during a replay — which is why an auction entry
came back stamped "OR 1.1" after an undo. Module scope rather than a `useCallback`: it closes over
nothing.

`#643` also fixed replay timestamps: a rebuilding client re-dispatches the whole log and each
dispatch stamped `Date.now()`, so the log recorded when the **rebuild** ran, which for a whole
history is one instant. `options.at` carries the entry's own `createdAt`.

### App.tsx #659 — An action belongs to the round it was taken in
**Reported:** it labels the last action of OR 1.1 as the first action of SR2 — "[SR2] PRR passed
Buy Trains."

`#643` read `roundLabelFor(after)` and took the wrong end of the action. `after` is the state the
action **resolved to**, and for the one action that closes a round that is the next round.
`before` is the round the action was taken **in**, which is what a log entry is for — and it
satisfies `#643`'s actual requirement identically.

The round-transition announcement takes the opposite treatment: it is tagged with the round being
**announced**, explicitly, because `logInfo`'s default is a ref fed by an effect off `gameState`
and no effect has run at that point in the dispatch. `round` is therefore an optional override, and
the default stays the ref — most callers report something about the round the game is already in.

### App.tsx #262 — The log describes the event, not the message
Every call site used to hand in its own label, and they were contract variant names —
"RunManualRoute", "BuyHardwareFromPool (mock)", "DeclareDividends: Pay (mock)". None said **who**
acted, several leaked internals, and the "(mock)" suffixes outlived the mocks. Deriving the label
in one place means a new dispatch cannot forget to write one and an old one cannot drift from what
it sends. `describeGameplayAction` reads the state **before** the action applies. The passed label
survives as the fallback for messages with nothing better to say.

`#262` also adds **one summary for a multi-train purchase**: each message is its own transaction
and gets its own line, but "bought a 3-train" three times buries what the player did. Only when
there is an aggregate to state.

### App.tsx #265 — The log reports what happened, not what was asked
**Reported:** the log reads the state before the action resolves — "2/5 remaining" logged when a
purchase is clicked rather than the 1/5 that is true once it lands.

`actionLog.ts #1` argued for the **before** state on the grounds it is the only state available at
dispatch time. True on a chain and never true here: the sandbox reducer is synchronous, so the
resolved state is one function call away. It now **resolves first and logs second**, which also
fixes two bugs the functional-updater style was hiding:

- **The charge crossed the atoms in the wrong order.** The waterfall's charge was captured inside
  `setSandboxWaterfall`'s updater and read inside `setSandboxState`'s. React invokes each hook's
  queue as that hook is evaluated during render, and `sandboxState` is declared **first** — so the
  charge was read before it was written and an auction purchase never debited the buyer.
- **A loop of dispatches collapsed.** `handleBuyTrainsFromBank` awaits N purchases and
  `sandboxState` in the closure does not refresh between iterations, so every purchase applied to
  the same base state.

A **ref** fixes both: written synchronously, so each dispatch sees the previous one's result, and
the ordering is explicit rather than dependent on hook declaration order. The state remains the
**rendering** source of truth; both are written together, always.

### App.tsx #265 (mirror seeding) / #537a — The ref is seeded, not left null
The dispatch path reads the mirror ref and the replay drain is async, so a setup event arriving
before the sync effect had fired found it `null`. Giving it the same initial value the state gets
closes the window at source — better than a fallback chain in the reader, because there is now no
moment at which the ref has no state.

---

## Sandbox scenario and fixture control

### App.tsx #25 — Sandbox phase toggle is a debug control, not a mechanic
Both phase-scoped panels mount on `gameState.current_round_type`, and with no chain `gameState` is
`null` — so the Waterfall Auction and the Stock Round were unreachable. On a real chain the round
type is contract state advanced by `PassTurn` and the OR engine; nothing in the UI may set it. This
exists solely because the sandbox has no contract to advance it, is rendered only when `sandbox`,
and feeds only `sandboxGameState`.

### App.tsx #177 — The testbed is chosen by scenario
Round type, era and train tier together, because the three have to agree — picking only the round
type left the era pinned to Green, making the yellow and brown tile catalogs unreachable.
`sandboxPhase` is derived from it so every existing reader is unchanged. **App.tsx #246** adds train
distribution as a **second axis** rather than a sixth scenario: which era you are testing and who
owns trains are independent questions.

### App.tsx #578 (setter removal) — The scenario setter is gone with the toolbar
The value stays — a room still has to boot from some board. What is gone is a control that let one
player re-seed the fixture mid-session, which in a room would silently hand one client a different
board from everyone else.

### App.tsx #301 — A new game forgets that you have played before
The zero-state scenario exists to be met the way a new player meets the game, and the tutorials are
part of that — but their "seen" flags live in `localStorage` and outlive every reset. Cleared on
**entering** the zero state, including a page load that starts there. Mid-game fixtures leave the
flags alone, so a tester hopping between `or-green` and `stock` is not interrupted.
`replayTutorials` rather than `resetTutorials`: a player who has said "stop showing me these" has
said it about the app, not about this game (`TutorialModal.tsx #159`).

### App.tsx #330 — A new board gets a new log
**Reported:** switching to the Zero State scenario leaves residual activity log entries.

The log is a ledger **of one board**, and every scenario switch replaces the board. An entry saying
"PRR bought a 4-train for $300" is not merely stale after the switch, it is false. Three
session-residue atoms go with it: `settledPrivatePrices` (a fresh auction showing "Sold to Carol
for $145" on a private nobody bid on), `usedPrivateAbilities` ("Used" on a power whose owner does
not own it yet), and `actionLog`.

**Guarded on `sandbox`, and the guard is load-bearing.** This effect also depends on `gameId`,
which changes on a live chain when the player opens a different room — an unguarded purge would
wipe a log of blocks that really happened. Sandbox logs describe a fixture; chain logs describe
history.

### App.tsx #578 — One sandbox, not two
**Instructed:** "I no longer need the solo sandboxes, the middleware one is sufficient."

The early return that requires `sandboxRoomCode` is the whole refactor. Everything below it can
assume a room, which collapses 21 solo-vs-room branches — and those branches were the shape of most
of the bugs this project reported:

| Note | Bug |
|---|---|
| `#538` | a room must not load the fixture's four mock players |
| `#542` | …and neither must the auction's separate atom |
| `#534` | who "you" are differs between a hotseat and a room |
| `#536` | a room is not a hotseat, so the turn gate applies |
| `#574` | an OR shortcut written for solo, skipping a step in a real game |

Every one is "the two paths disagree about something". One path cannot.

**Subtractive on purpose**, which is why it was safe without a test over this file: deleting a
branch cannot invent a new arrangement, and `tsc` finds every reference left behind. What is lost:
you can no longer poke at the board without Firestore. Two browser tabs are the replacement, and a
better check anyway — they exercise the log, the replay and the identity gating.

`#578` also removed the **hotseat seat switcher** (it let one browser act for four mock players,
the whole idea a room replaces, and was the source of `#534`'s confusion about who "you" are), the
**auto-follow effect**, and `#455`'s seat fix. `actingSeatIndex`'s phase-dependent reasoning
survives in `utils/gameState.ts`, where `isMyTurn` and the action bar still ask it.

### App.tsx #601 — Two conditions in two files, each true exactly when the other is
`isSidelinedByMiniAuction` is no longer imported here; its one caller was `playerRoster`'s
`sidelined` field, which existed for the deleted roster pills. The function stays exported and
tested in `utils/gameState.ts` — `WaterfallAuctionDashboard` is the surface that still cares who is
shut out of a contest.

---

## Endgame and tutorials

### App.tsx #359 — The two endings
1830 stops when the bank breaks or when a president cannot fund a mandatory train. Both are derived
rather than stored, and neither is a message the contract sends — `GetGameState` reports
`is_active`, but the sandbox has no path that flips it.

**Bankruptcy is read off the emergency plan**, not computed a second time: `endgame.ts` already
decides it and the modal already renders it, and a parallel derivation could disagree about whether
the game had ended. **Order matters: bankruptcy wins** — if a president is bankrupt and the bank
empties in the same tick, the bankruptcy is the more specific story and the one with a named player
in it.

### App.tsx #44 — The forced market lesson
A first-time president finishes their first OR and their share price moves **left**. Nothing
explains it, and the natural reading is "I played that badly" — when every corporation moves left
on its first turn, having no train and so unable to pay out. This is the one tutorial that
**interrupts**: it navigates to the market chart and opens on top of it, because the lesson is
about a specific number they can see.

**Triggered from the action, not from polled state.** "Did this player just finish their first OR
turn" is hard to infer from `GameStateResponse` — indices advance, and a poll landing late or twice
would fire at the wrong moment or not at all. Ending the turn is an explicit click by a known
viewer.

Guarded three ways: president only, first Operating Round only, and `TutorialModal`'s per-topic
seen flag and global off switch both still apply.

### App.tsx #412 — And a fourth guard, on the navigation only
**Reported:** End Turn in an OR forces a redirect to the Stock Market page; it should do that only
in tutorial mode.

`#44`'s three guards are all about the **situation** and none about the **player**, so every
experienced player met this once per game and had the board pulled out from under them.
`tutorialMode` defaults to false. **The tab switch is gated; arming the modal is not** — the
explainer costs one click to dismiss, whereas the navigation moves them somewhere they did not ask
to go and happens *before* the modal renders.

### App.tsx #591c — The rebuild resets every atom, through both doors
Undo replays from the fixture, so every piece of state the dispatch path writes has to go back to its
boot value first — and `#310` already learned this list the hard way: restoring some atoms and not
others leaves two pointers one seat apart and every later action widens the gap.

**Refs and state together, always.** The very next thing that happens is a replay, and the replay
reads the refs synchronously (`#265`) — so writing only the React state would have the reducer
rebuild the game on top of the state it was supposed to have discarded.

**The automatic guards go too**, for `#475`'s reason: they exist to stop repeat firing within a turn,
not to record history, and a replay has to be free to re-derive the consequences it derived the first
time.
