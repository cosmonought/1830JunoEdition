# Phase 3 — pre-Phase-4 lane A: Live / Async gameplay clocks (AUD-11.04 / U-10)

**Branch:** `phase3/preplaytest-live-async-clocks`, from `phase3/consolidated-pre-playtest-integration` @ `b8d5246`. Not integrated; no deployment.
**Ruling:** OD-18 is superseded in part (owner, 2026-10-05). The clock **infrastructure** is built in Phase 3 so the normal Phase-4 playtest can exercise it. Its **consequences** are NOT built and stay deferred pending Phase-4 validation (AUD-19.04):
- no automatic forfeiture;
- no automatic trade decline;
- no host succession;
- no Forfeit / Clemency settlement payload.

**Unchanged:** rules version (13), settlement certification ([10, 11, 12, 13]), hosted protocol (1), financial protocol (3), the compatibility keys, the GameRecord schema, the log format, the escrow contract and every settlement / escrow file.

## 1. What a clock is

- **One seat at a time.** The clock times the seat the engine says is acting, `actingAddress` from `gameEngine/gameState.ts`. This is the answer `turnAuthority` uses to judge every move:
  - the mini-auction's bidder;
  - the Stock Round seat;
  - the operating corporation's president.
- **A turn** is a run of committed boards with the same turn key. The key is round type, `operatingTurnKey` and the acting seat. When the key changes, a new turn starts at zero.
- **Same key, other seat in between.** A stored turn with the same key counts as the same turn only if no other seat's standing move has landed since it began. One exception: an off-turn move this server saw leave the turn alone (for example, an answer to an offer) is vouched for in the record (`turn.continued_to`).
- **Time counts** while a turn runs and the clock is not paused. It stops for good at GameEnd or CloseRoom.
- **Undo never resets a clock.** If a `RevertTo` reaches back into a turn that has already ended, that turn resumes with the active time it had used. The record keeps the last 16 ended turns for this purpose. The resumed turn is neither handed a fresh allowance nor charged the time of the undone turn.
- **Allowance.** How long a turn may run before it reads "Time expired" is a per-mode policy slot (§4). A table freezes its mode's allowance when its clock first starts.

## 2. Storage model (server-authoritative, control-plane only)

| Where | What |
|---|---|
| `games/clocks/<game_id>.json` (file stores, `createFileClockStore`) | the clock record, replaced whole and durably (`durableReplace`), writer-checked under the data-directory lock |
| `GAME#<g>/CLOCK` (DynamoDB, `aws/game/dynamoClockStore.ts`) | the same document in `body`, `revision` beside it; every write is fenced by the game's HEAD and is a CAS on the revision |
| memory (`createMemoryClockStore`) | tests, and a server built without a durable store |

**Record format:** `gs-game-clock` v1. It holds:
- `mode`, `allowance_ms` (frozen);
- `turn` — key, seat, `started_at`, `from_index`, `paused_ms`, `expired_at`, `continued_to`;
- `history` (ended turns, for undo);
- `pause` — `since`, `asked_at`, `by` (a player id);
- `stopped_at`, `revision`;
- `tally` — turns, pauses, expiries.

All times are integer milliseconds.

**Unreadable or newer records.** A damaged or newer-build clock is never overwritten. That table's clock reads "Clock unavailable"; the game itself is unaffected.

**Why a separate record:**
- **Not the log.** A timer entry would be gameplay bytes, hashed into the settlement commitment.
- **Not the GameRecord.** Its schema is exact-keyed for LIVE-4 cross-build continuation. A new key would make the record unreadable to an older build, and an unreadable record is a durable HOLD.

**Data flow:**
1. Every committed view carries the board's clock facts (`CommittedView.clock`, from `clockFactsOf`).
2. The actor hands each new set of facts to the room host after its publish. This is contained and cannot fail the publish.
3. The **clock keeper** (`rooms/clockKeeper.ts`) runs one promise chain per table. It is the only writer of the clock record, and it never queues gameplay.

## 3. Mode model

- The mode is the existing `variants.mode` (design note #1256). It is chosen at creation, fixed at the deal, and travels in `SetupGame`.
- A record or log that names no mode reads as **Live** (`resolveVariants`, #232). No new metadata was added.
- On a money table, `variants.mode` is also the escrow's pace. The clock reads it and changes nothing about the escrow.

## 4. Durations: NO owner-approved value

| Slot | Configuration | Shipped default |
|---|---|---|
| Live | `GS_CLOCK_LIVE_TURN_SECONDS` (whole seconds, 1 to 31 622 400) | **unset**: the clock counts the turn up and never expires |
| Async | `GS_CLOCK_ASYNC_TURN_SECONDS` | **unset**: the same |

- `start.ts` reads the policy for both storage modes. An unreadable value is exit 2, never a guess.
- The startup banner says which slots are set.
- Tests use test-only durations only.

## 5. Pause / resume

- Pause stops the **clock only**. Gameplay is never paused by it: the timer does not change legal gameplay.
- **Who may pause:** the host only (room ops `clock-pause` / `clock-resume`, authorization table row A:H). This is the conservative default, because the host already holds undo, kick and transfer.
- **No pause cap.** None is approved.
- A pause is written durably before it is acknowledged or shown.
- A pause or resume is bound to the clock `revision` the tab saw. A stale tab gets `clock-stale` and nothing moves.
- A turn that starts while paused starts paused and is charged none of the earlier pause.
- On resume, the paused time is added to the turn's paused total, and the clock counts on from what remained.
- Rate-limited per principal, like membership ops.

## 6. Reload, reconnect, restart

- **Reload, reconnect, a second tab, a vanished tab:** these only read the projection. Nothing a browser does moves the clock.
- **Restart, or eviction followed by reload:** the clock record is read back at every actor load. The same turn keeps its start, its pause and its paused total.
- **A turn the record does not know** (its write did not land) starts at the hand-over's server stamp: the other seat's move that began it, which is durable in the log.
- **Visible before durable, for a turn change only.** A failed write is retried with backoff and reread before the next decision.
- **Server downtime and server holds:** wall-clock time keeps running. With a duration set, a long outage can read "Time expired". This is a recorded Phase-4 observation item (§9).

## 7. UI (`components/GameClockChip.tsx`, `utils/gameClockView.ts`)

**Placement and content.** A chip in the room strip, next to the strip's other standing facts. It shows:
- Live / Async;
- whose turn is timed ("Your turn" / "Bob's turn");
- the server's figure — "1:23 left", or "4:12 on this turn" when no duration is set;
- "· paused", or **"Time expired"**. It never says "forfeited". The tooltip adds: "Play continues; nothing happens automatically."

**What it avoids.** No modal, no sound, no flashing, and no live-region chatter. The figure is a `timer`.

**Counting.** The chip counts on from the server's view using the **monotonic** time since the room frame arrived (`roomViewReceivedAt`). It never compares this device's date with the server's.

**When the tab is not current, the chip shows no figure at all.** That is the case when:
- the room link is down (`watchRoomLink`);
- any W3-C connection notice is standing (reconnecting, catching-up, resync, …);
- W3-J's board currency says the board is not the room's;
- the table is held;
- the clock names a seat other than the one acting on this tab's applied board.

**Host controls.** The host gets "Pause clock" / "Resume clock". A refusal is shown inside the chip and changes nothing.

## 8. Expiry — and the proof there is no automatic consequence

When a running turn reaches its allowance, the keeper's timer:
- notes `expired_at` once in the clock record;
- writes one `clock.expired` audit line;
- re-sends the room view.

That is all. The keeper:
- never queues an actor task, submits or appends;
- never writes a GameRecord, hold, financial record or intent;
- never calls the escrow or settlement seams.

The expired seat keeps the turn and can still play.

Proven by tests:
- **`phase3Clock.test.ts` "EXPIRY", end to end on the file stores.** After expiry:
  - the log on disk is byte-identical;
  - no `applied` / `catch-up` frame is fanned out;
  - the GameRecord is unchanged and `active`;
  - the board digest is the same;
  - the settlement spy and the escrow spy are never called;
  - the audit has exactly one `clock.expired` and no forfeit / clemency / decline / succession / seal / settle line;
  - the expired seat's late move is accepted and hands the turn on.
- **`phase3ClockModel.test.ts` STRUCTURAL PROOF.** `gameClock.ts`, `clockKeeper.ts` and `dynamoClockStore.ts`:
  - import nothing of escrow, settlement, money, juno, the actor, the room host, the record or hold stores, or the lifecycle;
  - name no `submit`, `commitBatch`, `commitRecord`, `appendBatch`, `onGameplayClosed`, `onGameplayCommitted`, Forfeit, Clemency, offer decline, `PassTurn`, `transferHost` or `persistHold` in code.

## 9. Owner decisions and Phase-4 observation items

**Required before the clock can count down in Phase 4** (the brief's exact decisions):
1. **Live default duration** — seconds per turn for `GS_CLOCK_LIVE_TURN_SECONDS`, or confirm none (count-up only).
2. **Async default duration** — seconds per turn for `GS_CLOCK_ASYNC_TURN_SECONDS`, or confirm none.

**Defaults built conservatively, for the owner to confirm (not blocking):**

3. **Who may pause / resume** — host only (built), or any seated player.
4. **Whose clock runs during an off-turn decision** — for example, an offer's answer, an emergency-funding answer, or a discard. Built: the turn holder's (`actingAddress`). U-10 also named "the offer answerer on the clock".
5. **Whether server downtime and server holds credit time.** Built: wall time keeps running.

**Phase-4 observation items:**
- turn lengths from the `clock.turn` audit lines (`active_ms` per seat and mode), to calibrate decisions 1 and 2;
- pause use;
- the count-up display;
- multi-tab / reconnect continuity;
- the chip's "not current" state during reconnects.

**Recorded residuals (LOW):**
- **A lost turn-start or vouch write plus a restart before the retry.** The turn restarts at the hand-over stamp. It can show less time than before, never more.
- **Bounded undo history.** An undo reaching back more than 16 turns starts that turn afresh.
- **A single batch containing a whole other seat's turn** (none exists today) would be merged.
- **A host can pause indefinitely.** No cap is approved.
- **Evicted tables.** For a table evicted while no one watches, `expired_at` is noted when it is next loaded. The displayed state is always arithmetic.

## 10. Tests

| Suite | What |
|---|---|
| `server/src/rooms/phase3ClockModel.test.ts` | facts off real boards; policy slots and env parsing; every transition; undo-resume; same-key new turn; vouch; undone moves ignored; stores; the keeper on controlled time (load / commit / restart, expiry, durable pause, revision binding, a failing store, an unreadable clock, an unserved game, the vouch race); the structural proof |
| `server/src/rooms/phase3Clock.test.ts` | through the server on file stores and controlled time: starting seat; no other seat's clock; hand-over; pause / resume; reload; reconnect; second tab; stale tab and non-host refused; invented fields refused; undo plus restart; restart; Live vs Async slots; expiry (no dispatch / forfeit / settlement); GameEnd; legacy no-clock / no-mode record |
| `server/src/persistence/conformance/clockStore.conformance*.ts` | the clock-store port (CAS, fence, fence-in-write, lost / unevaluated answers, cas-in-write, unreadable never overwritten): memory and file in `npm test`; DynamoDB in `npm run test:dynamodb-local` (`dynamoGame.conformance.test.ts`) |
| `frontend/src/utils/gameClockView.test.ts`, `components/gameClockChip.test.tsx` | the presentation: count-up, warning, "Time expired" never forfeited, frozen when paused, no figure when not current, replayed views counted from arrival; the host's revision-bound pause and its refusal |
